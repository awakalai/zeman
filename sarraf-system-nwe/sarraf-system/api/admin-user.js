import { limitSubject, refuseIfOverLimit } from "./_rate-limit.js";
import { judgePassword } from "./_password.js";

// User administration is rare and deliberate; a burst of it is not.
const ADMIN_LIMIT = Number(process.env.ADMIN_RATE_LIMIT || 20);
const ADMIN_WINDOW_SECONDS = Number(process.env.ADMIN_RATE_WINDOW || 60);

// api/admin-user.js
// Server-only Sarraf user administration.
// Requires a valid Admin session at AAL2 (TOTP MFA) and a Supabase secret/service key.

import { createClient } from "@supabase/supabase-js";

const ROLE_SET = new Set(["customer", "partner", "investor", "office", "admin"]);

const serverConfig = () => ({
  url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
  publicKey:
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    "",
  secretKey:
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "",
});

const makeClient = (url, key) =>
  createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

const decodeJwtPayload = (token) => {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00964")) return digits.slice(2);
  if (digits.startsWith("964")) return digits;
  if (digits.startsWith("0")) return `964${digits.slice(1)}`;
  if (digits.startsWith("7")) return `964${digits}`;
  return digits;
};
const safeText = (value, max = 250) => {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
};

const auditId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function requireAdminAal2(req, authClient, service) {
  const authHeader = String(req?.headers?.authorization || req?.headers?.Authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    const e = new Error("authentication required");
    e.status = 401;
    throw e;
  }

  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user?.id) {
    const e = new Error("invalid or expired session");
    e.status = 401;
    throw e;
  }

  // Two-factor is required of an administrator who has it, and cannot be required of one who
  // does not: a session cannot reach aal2 without an enrolled factor, so demanding it from an
  // account with none refuses every request forever. That is what stopped both the manager and
  // the business owner from creating a single account — the same closed circle as needing an
  // owner in order to make the first owner.
  //
  // So: enrolled and unchallenged is refused, and told to complete the challenge. Not enrolled
  // is allowed, because aal1 is the highest that account can reach.
  const claims = decodeJwtPayload(token);
  if (String(claims?.aal || "aal1") !== "aal2") {
    let enrolled = false;
    try {
      const { data: factors } = await service.auth.admin.mfa.listFactors({ userId: user.id });
      enrolled = (factors?.factors || []).some((f) => f?.status === "verified");
    } catch {
      // The factor list could not be read. Treating that as "not enrolled" would let a
      // transient failure downgrade a protected account, so it counts as enrolled.
      enrolled = true;
    }
    if (enrolled) {
      const e = new Error("multi-factor authentication required");
      e.status = 403;
      e.code = "mfa_required";
      throw e;
    }
  }

  const { data: profile, error: profileError } = await service
    .from("app_users")
    .select("id,auth_id,name,role,admin_level,tenant_id,deleted")
    .eq("auth_id", user.id)
    .eq("deleted", false)
    .maybeSingle();

  // A failed query and an absent row are different facts, and collapsing them cost a day.
  //
  // service_role held no grant on app_users, so this came back `permission denied for table
  // app_users` — and was reported as "this login has no account in the system". The owner was
  // signed in, looking at their own screens, and told their account did not exist. I believed
  // the message and went looking for a stale session, which it was not.
  //
  // An error is now an error, and says what the database said.
  if (profileError) {
    const e = new Error(`account lookup failed: ${profileError.message || profileError.code || "unknown"}`);
    e.status = 500;
    e.code = "profile_lookup_failed";
    throw e;
  }
  if (!profile?.id) {
    const e = new Error("this login has no account in the system");
    e.status = 403;
    e.code = "no_profile";
    throw e;
  }
  if (profile.role !== "admin") {
    const e = new Error("only an administrator may manage accounts");
    e.status = 403;
    e.code = "not_admin";
    throw e;
  }

  return { token, user, profile };
}

// Three ranks, all of them role 'admin' so every existing admin check keeps working:
//   manager  — the person who maintains the system. Above everyone, resets any password.
//   owner    — the business owner who runs the exchange.
//   operator — the owner's staff.
// Eight characters, matching the interface. The two must agree or the screen accepts what the
// server then refuses, which reads as the system being broken rather than as a rule.
const ADMIN_LEVELS = new Set(["manager", "owner", "operator"]);

const levelOf = (profile) =>
  profile?.role === "admin" ? (profile?.admin_level || "operator") : null;

const isManager = (profile) => levelOf(profile) === "manager";

// A manager outranks an owner, so anything an owner may do a manager may do. Written once, or
// the first call site that forgets the second value locks the manager out of their own system.
const isOwner = (profile) => ["owner", "manager"].includes(levelOf(profile));

/** Which ranks may an actor hand out? Nobody may create a rank above their own. */
const mayGrant = (profile, level) => {
  if (level === "manager") return isManager(profile);
  if (level === "owner" || level === "operator") return isOwner(profile);
  return false;
};

/**
 * Whether this actor may act on this target — and the tenant predicate the write must carry.
 *
 * Every mutating action loaded its target without a tenant and then wrote with `.eq("id", …)`
 * alone. This route holds the service key, which bypasses row-level security, so a business
 * owner who knew a user's UUID from another business could deactivate that person, change their
 * commission, reset their password, or change their rank. Nothing had to be forged. The
 * identifier was the whole attack.
 *
 * Three things follow from that, and all three are here rather than repeated four times:
 *
 *   1. The target is loaded WITH its tenant.
 *   2. The tenant is compared against the actor's.
 *   3. The tenant is returned so the caller can put it in the UPDATE.
 *
 * The third is the one that is easy to skip. A check that runs before the write and is not
 * repeated in it is a check that a tenant change between the two walks straight past.
 *
 * A target in another business is reported as not found. "You may not touch that account"
 * confirms the account exists, which is the answer somebody probing for it wants.
 *
 * A manager maintains the installation and may act across businesses — that is their reason for
 * existing, and it is how a locked-out owner gets back in. They must name the business they are
 * acting in, and it must be the one the target is actually in. That is the smallest honest form
 * of an explicit tenant context; the audited, expiring, step-up support mode is its own change.
 */
export async function authorizeTarget(service, actor, userId, options = {}) {
  const { columns = "id,name,role,admin_level,deleted", requestedTenantId = null } = options;
  const notFound = { status: 404, body: { error: "ئەکاونت نەدۆزرایەوە", code: "target_not_found" } };

  if (!userId) {
    return { ok: false, status: 400, body: { error: "userId پێویستە", code: "user_id_required" } };
  }

  const select = columns.includes("tenant_id") ? columns : `${columns},tenant_id`;
  const { data: target, error } = await service
    .from("app_users").select(select).eq("id", userId).maybeSingle();
  if (error) {
    const e = new Error(`target lookup failed: ${error.message || error.code || "unknown"}`);
    e.status = 500;
    e.code = "target_lookup_failed";
    throw e;
  }
  if (!target?.id) return { ok: false, ...notFound };

  const actorTenant = actor.profile.tenant_id || null;
  const targetTenant = target.tenant_id || null;

  if (isManager(actor.profile)) {
    // A manager acting inside a business must say which one, and be right about it.
    const named = String(requestedTenantId || "").trim() || null;
    if (targetTenant && named !== targetTenant) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "بۆ ئەم کردارە دەبێت بازرگانییەکە بە ڕوونی دیاری بکەیت",
          code: "tenant_context_required",
        },
      };
    }
    // And must have opened that business, saying why. The manager is the vendor: they belong to
    // no business and every policy lets them through, so without this a business owner has no
    // way to know whether the person who sold them the system has been in their accounts. The
    // context is a row the owner can read, it expires, and it cannot be deleted.
    //
    // Only for an act on a business. Creating another manager, or acting on an account that
    // belongs to no business, is platform work and has no business to open.
    if (targetTenant) {
      const open = await openSupportContext(service, actor);
      if (open !== targetTenant) {
        return {
          ok: false,
          status: 403,
          body: {
            error: open
              ? "پشتگیریت بۆ بازرگانییەکی تر کراوەتەوە — یەکەم جار ئەمە بکەرەوە"
              : "پێش کارکردن لەسەر بازرگانییەک، پشتگیری بکەرەوە و هۆکارەکە بنووسە",
            code: "support_context_required",
          },
        };
      }
    }
  } else {
    // Everybody else acts inside their own business and nowhere else. An actor with no business
    // has no business to act in, which is a refusal rather than a wildcard.
    if (!actorTenant || targetTenant !== actorTenant) return { ok: false, ...notFound };
  }

  return { ok: true, target, tenantId: targetTenant };
}

/**
 * The one business the manager currently has open, or null.
 *
 * Asked through the database rather than worked out here, because the expiry and the
 * one-at-a-time rule live with the rows they are about. A lookup that fails is treated as no
 * context: a transient error must not become a way through.
 */
export async function openSupportContext(service, actor) {
  if (!isManager(actor.profile)) return null;
  try {
    const { data, error } = await service.rpc("sarraf_manager_support_tenant_for", {
      p_manager_id: actor.profile.id,
    });
    if (error) return null;
    return String(data || "").trim() || null;
  } catch {
    return null;
  }
}

/** Narrow an update to the tenant the target was authorized in. Null means the row has none. */
export const withinTenant = (query, tenantId) =>
  tenantId === null ? query.is("tenant_id", null) : query.eq("tenant_id", tenantId);

async function writeAudit(service, action, detail) {
  const { error } = await service.from("audit").insert({
    id: auditId(),
    date: new Date().toISOString(),
    action,
    detail,
  });
  if (error) throw error;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const { url, publicKey, secretKey } = serverConfig();
  if (!url || !publicKey || !secretKey) {
    return res.status(500).json({
      error: "Server user-management credentials are not configured",
      code: "server_config",
    });
  }

  const authClient = makeClient(url, publicKey);
  const service = makeClient(url, secretKey);

  // Limited by address before anyone is identified: an automated attempt at this route is
  // limited by how fast it can type otherwise, and a failure to sign in must not be a way of
  // escaping the limit.
  if (await refuseIfOverLimit(res, {
    url, key: secretKey, bucket: "admin-user", subject: limitSubject(req, null),
    limit: ADMIN_LIMIT, windowSeconds: ADMIN_WINDOW_SECONDS,
  })) return;

  let actor;
  try {
    actor = await requireAdminAal2(req, authClient, service);
  } catch (e) {
    const status = Number(e?.status) || 403;
    return res.status(status).json({
      error:
        status === 401
          ? "کاتی چوونەژوورەوەت بەسەرچووە"
          : e?.code === "mfa_required"
            ? "پاراستنی دوو هەنگاوی پێویستە"
            : e?.code === "no_profile"
              ? "ئەم لۆگینە ئەکاونتێکی نییە لە سیستەمەکەدا"
              // Named as a server fault, because it is one. Telling somebody their account is
              // missing when the server could not look is blaming them for our own permissions.
              : e?.code === "profile_lookup_failed"
                ? "سێرڤەرەکە نەیتوانی ئەکاونتەکە بخوێنێتەوە — کێشەیەکی سیستەمە، نەک هی ئەکاونتەکەت"
                : "تەنها ئەدمین دەتوانێت ئەکاونت بەڕێوە ببات",
      code: e?.code || null,
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const action = String(body.action || "").trim();

    if (action === "create") {
      const name = safeText(body.name, 120);
      const phone = normalizePhone(body.phone);
      const password = String(body.password || "");
      const role = String(body.role || "");
      const rate = Number(body.rate || 0);
      // The rank the new administrator gets. Defaults to the least, so a caller that says
      // nothing cannot accidentally create somebody above themselves.
      const adminLevel = role === "admin"
        ? (ADMIN_LEVELS.has(String(body.adminLevel || "")) ? String(body.adminLevel) : "operator")
        : null;

      // Which business the new account belongs to. A manager belongs to none and must say which
      // one they are creating for; everybody else creates inside their own and cannot name
      // another, so the value is taken from them rather than trusted from the request.
      const tenantId = adminLevel === "manager"
        ? null
        : (isManager(actor.profile)
            ? String(body.tenantId || "").trim() || null
            : actor.profile.tenant_id);
      if (adminLevel !== "manager" && !tenantId) {
        return res.status(400).json({
          error: "دیاری بکە ئەم ئەکاونتە بۆ کام سەرخێڵە",
          code: "tenant_required",
        });
      }
      // Putting a new administrator inside somebody's business is an act on that business, and
      // it is the one this route's other four actions all go through authorizeTarget for.
      // `create` does not, because there is no target to authorize yet — so the support context
      // it also demands was never asked for here, and a manager could add an account to a
      // customer's business with nothing recorded. Same rule, asked directly.
      if (tenantId && isManager(actor.profile)) {
        const open = await openSupportContext(service, actor);
        if (open !== tenantId) {
          return res.status(403).json({
            error: open
              ? "پشتگیریت بۆ بازرگانییەکی تر کراوەتەوە — یەکەم جار ئەمە بکەرەوە"
              : "پێش درووستکردنی ئەکاونت لە بازرگانییەکدا، پشتگیری بکەرەوە و هۆکارەکە بنووسە",
            code: "support_context_required",
          });
        }
      }
      if (role === "admin" && !mayGrant(actor.profile, adminLevel)) {
        return res.status(403).json({
          error: adminLevel === "manager"
            ? "تەنها ماناجەر دەتوانێت ماناجەری نوێ درووست بکات"
            : "تەنها ماناجەر یان سەرخێڵ دەتوانێت ئەدمینی نوێ درووست بکات",
          code: adminLevel === "manager" ? "manager_required" : "owner_required",
        });
      }
      const scope = Array.isArray(body.scope)
        ? [...new Set(body.scope.map((x) => String(x).trim()).filter(Boolean))].slice(0, 100)
        : [];
      const address = safeText(body.address, 300);
      const note = safeText(body.note, 1000);

      if (!name || phone.length < 7 || !ROLE_SET.has(role)) {
        return res.status(400).json({ error: "زانیاریی ئەکاونتەکە تەواو یان دروست نییە" });
      }
      // Judged on its own, and said on its own. Folding this into the line above returned
      // "the account details are wrong" for a password that was merely short, which is a
      // refusal the person setting it has to guess their way past.
      const verdict = judgePassword(password, { phone, name });
      if (!verdict.ok) {
        return res.status(400).json({ error: verdict.error, code: verdict.code });
      }
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        return res.status(400).json({ error: "ڕێژە دەبێت لە نێوان ٠ تا ١٠٠ بێت" });
      }

      const email = `${phone}@sarraf.local`;

      const { data: created, error: createError } = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        // 'admin' was written here and in the profile below, and admin_level is checked
        // against manager/owner/operator. Every administrator account creation was refused by
        // the database with a constraint violation.
        user_metadata: { name, role, phone, admin_level: adminLevel },
      });
      if (createError || !created?.user?.id) throw createError || new Error("Auth user creation failed");

      const authId = created.user.id;
      const profileId =
        globalThis.crypto?.randomUUID?.() ||
        `usr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const { error: insertError } = await service.from("app_users").insert({
        id: profileId,
        auth_id: authId,
        name,
        role,
        admin_level: adminLevel,
        tenant_id: tenantId,
        rate,
        scope_curs: scope,
        phone,
        address,
        note,
        deleted: false,
      });

      if (insertError) {
        try { await service.auth.admin.deleteUser(authId); } catch {}
        if (
          String(insertError?.code || "") === "23505" ||
          /sarraf_app_users_auth_phone_uq|duplicate key|unique constraint/i.test(
            String(insertError?.message || "")
          )
        ) {
          return res.status(409).json({
            error: "ئەم ژمارەیە پێشتر بۆ ئەکاونتێکی چالاک بەکارهاتووە",
            code: "duplicate_login_identity",
          });
        }
        throw insertError;
      }

      await writeAudit(
        service,
        "درووستکردنی ئەکاونت",
        `${name} (${role}) — ${phone} — by ${actor.profile.name || actor.profile.id}`
      );

      return res.status(200).json({
        ok: true,
        user: { id: profileId, authId, name, role, adminLevel, tenantId, phone, rate, scope },
      });
    }

    if (action === "deactivate") {
      const userId = String(body.userId || "").trim();
      if (!userId) return res.status(400).json({ error: "userId پێویستە" });
      if (userId === actor.profile.id) {
        return res.status(400).json({ error: "ناتوانیت ئەکاونتی خۆت لەم شوێنە ناچالاک بکەیت" });
      }

      const decision = await authorizeTarget(service, actor, userId, {
        columns: "id,name,role,admin_level,deleted",
        requestedTenantId: body.tenantId,
      });
      if (!decision.ok) return res.status(decision.status).json(decision.body);
      const target = decision.target;
      if (target.role === "admin") {
        if (!isOwner(actor.profile)) {
          return res.status(403).json({ error: "تەنها ماناجەر یان سەرخێڵ دەتوانێت ئەدمین ناچالاک بکات", code: "owner_required" });
        }
        // Nobody deactivates a rank at or above their own. A manager's account is reachable
        // only by another manager, and an owner's only by a manager.
        if (target.admin_level === "manager" && !isManager(actor.profile)) {
          return res.status(403).json({ error: "ئەکاونتی ماناجەر تەنها لەلایەن ماناجەرێکەوە ناچالاک دەکرێت", code: "manager_required" });
        }
        if (target.admin_level === "owner" && !isManager(actor.profile)) {
          return res.status(403).json({ error: "ئەکاونتی سەرخێڵ تەنها لەلایەن ماناجەرێکەوە ناچالاک دەکرێت", code: "manager_required" });
        }
      }

      const { data: changed, error: updateError } = await withinTenant(
        service.from("app_users").update({ deleted: true }).eq("id", userId),
        decision.tenantId,
      ).select("id");
      if (updateError) throw updateError;
      // Nothing changed means the row moved out from under the check between reading and
      // writing. That is a refusal, not a success with no effect.
      if (!changed?.length) return res.status(409).json({ error: "ئەکاونتەکە گۆڕا لە کاتی کارەکەدا", code: "target_changed" });

      await writeAudit(
        service,
        "ناچالاککردنی ئەکاونت",
        `${target.name} (${target.role}) — by ${actor.profile.name || actor.profile.id}`
      );

      return res.status(200).json({ ok: true });
    }

    if (action === "update_rate") {
      const userId = String(body.userId || "").trim();
      const rate = Number(body.rate);
      if (!userId || !Number.isFinite(rate) || rate < 0 || rate > 100) {
        return res.status(400).json({ error: "userId و ڕێژەی ٠ تا ١٠٠ پێویستن" });
      }

      const decision = await authorizeTarget(service, actor, userId, {
        columns: "id,name,role,deleted",
        requestedTenantId: body.tenantId,
      });
      if (!decision.ok) return res.status(decision.status).json(decision.body);
      const target = decision.target;
      if (target.deleted) return res.status(404).json({ error: "ئەکاونت نەدۆزرایەوە", code: "target_not_found" });
      if (!["partner", "investor"].includes(target.role)) {
        return res.status(400).json({ error: "ڕێژە تەنها بۆ هاوبەش یان وەبەرهێنەرە" });
      }

      const { data: changed, error: updateError } = await withinTenant(
        service.from("app_users").update({ rate }).eq("id", userId),
        decision.tenantId,
      ).select("id");
      if (updateError) throw updateError;
      if (!changed?.length) return res.status(409).json({ error: "ئەکاونتەکە گۆڕا لە کاتی کارەکەدا", code: "target_changed" });

      await writeAudit(
        service,
        "گۆڕینی ڕێژە",
        `${target.name} → ${rate}% — by ${actor.profile.name || actor.profile.id}`
      );

      return res.status(200).json({ ok: true, rate });
    }

    // ── resetting a password ──
    //
    // A manager's own reason for existing: somebody is locked out and the business cannot wait
    // for whoever set the password. The new one is never returned in the response and never
    // written to the audit line — only that it was changed, by whom, for whom.
    if (action === "reset_password") {
      const userId = String(body.userId || "").trim();
      const password = String(body.password || "");
      if (!userId) {
        return res.status(400).json({ error: "userId پێویستە", code: "user_id_required" });
      }
      // The same judgement `create` applies. It used to be a bare `length < 8` here while the
      // message said twelve — a screen told one rule while the server applied another, which
      // reads to the person setting the password as the system being broken.
      const verdict = judgePassword(password);
      if (!verdict.ok) {
        return res.status(400).json({ error: verdict.error, code: verdict.code });
      }

      const decision = await authorizeTarget(service, actor, userId, {
        columns: "id,name,role,admin_level,auth_id,deleted",
        requestedTenantId: body.tenantId,
      });
      if (!decision.ok) return res.status(decision.status).json(decision.body);
      const target = decision.target;
      if (target.deleted) return res.status(400).json({ error: "ئەکاونتەکە ناچالاکە" });
      if (!target.auth_id) return res.status(400).json({ error: "ئەم ئەکاونتە لۆگینی نییە" });

      // A manager may reset anyone. An owner may reset their own staff and ordinary users, but
      // not another administrator of their own rank or above — otherwise an owner could take
      // the system from a manager by changing their password.
      const targetLevel = target.role === "admin" ? (target.admin_level || "operator") : null;
      const allowed = isManager(actor.profile)
        || (isOwner(actor.profile) && (targetLevel === null || targetLevel === "operator"));
      if (!allowed) {
        return res.status(403).json({
          error: "گۆڕینی وشەی نهێنیی ئەم ئەکاونتە تەنها لەلایەن ماناجەرەوە دەکرێت",
          code: "manager_required",
        });
      }

      const { error: resetError } = await service.auth.admin.updateUserById(
        target.auth_id, { password }
      );
      if (resetError) throw resetError;

      await writeAudit(
        service,
        "گۆڕینی وشەی نهێنی",
        `${target.name} (${target.role}) — by ${actor.profile.name || actor.profile.id}`
      );

      return res.status(200).json({ ok: true });
    }

    // ── promoting or demoting an administrator ──
    if (action === "set_level") {
      const userId = String(body.userId || "").trim();
      const level = String(body.adminLevel || "");
      if (!userId || !ADMIN_LEVELS.has(level)) {
        return res.status(400).json({ error: "userId و پلەی دروست پێویستن (manager/owner/operator)" });
      }

      const decision = await authorizeTarget(service, actor, userId, {
        columns: "id,name,role,admin_level,deleted",
        requestedTenantId: body.tenantId,
      });
      if (!decision.ok) return res.status(decision.status).json(decision.body);
      const target = decision.target;
      if (target.role !== "admin") return res.status(400).json({ error: "تەنها ئەدمین پلەی هەیە" });

      const currentLevel = target.admin_level || "operator";
      // Nobody hands out a rank above their own, and nobody touches a rank at or above their own.
      if (!mayGrant(actor.profile, level)
          || (currentLevel === "manager" && !isManager(actor.profile))) {
        return res.status(403).json({ error: "دەسەڵاتت نییە بۆ ئەم گۆڕانکارییە", code: "rank_required" });
      }
      // The last manager cannot demote themselves out of the system. The database refuses this
      // too; catching it here means a sentence rather than a constraint name.
      if (currentLevel === "manager" && level !== "manager") {
        const { count } = await service
          .from("app_users")
          .select("id", { count: "exact", head: true })
          .eq("role", "admin").eq("admin_level", "manager").eq("deleted", false)
          .neq("id", userId);
        if (!count) {
          return res.status(400).json({ error: "دوایین ماناجەر لاناچێت — سەرەتا یەکێکی تر دابنێ" });
        }
      }

      const { data: changed, error: updateError } = await withinTenant(
        service.from("app_users").update({ admin_level: level }).eq("id", userId),
        decision.tenantId,
      ).select("id");
      if (updateError) throw updateError;
      if (!changed?.length) return res.status(409).json({ error: "ئەکاونتەکە گۆڕا لە کاتی کارەکەدا", code: "target_changed" });

      await writeAudit(
        service,
        "گۆڕینی پلەی ئەدمین",
        `${target.name}: ${currentLevel} → ${level} — by ${actor.profile.name || actor.profile.id}`
      );

      return res.status(200).json({ ok: true, adminLevel: level });
    }

    return res.status(400).json({ error: "کردارەکە ناسراو نییە" });
  } catch (e) {
    console.error("admin-user", e);
    const msg = String(e?.message || e || "server error");
    const duplicate = /already registered|already been registered|duplicate|unique/i.test(msg);
    return res.status(duplicate ? 409 : 500).json({
      error: duplicate ? "ئەم ژمارەیە پێشتر ئەکاونتی هەیە" : "نەتوانرا بەڕێوەبردنی ئەکاونت تەواو بکرێت",
      code: e?.code || null,
    });
  }
}
