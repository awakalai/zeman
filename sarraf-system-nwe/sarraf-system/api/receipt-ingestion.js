import { limitSubject, refuseIfOverLimit } from "./_rate-limit.js";

// Twenty batches a minute is far more than a person uploading from a phone.
const INGEST_LIMIT = Number(process.env.INGEST_RATE_LIMIT || 20);
const INGEST_WINDOW_SECONDS = Number(process.env.INGEST_RATE_WINDOW || 60);

// Authenticated receipt-ingestion recovery path.
// The SQL RPC remains the preferred atomic path. This endpoint keeps receipt
// delivery working while an older production database is missing that RPC.

import { randomBytes } from "node:crypto";
import { ACTOR_COLUMNS, isTenantless, sameTenant } from "./_tenant.js";
import { createClient } from "@supabase/supabase-js";

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

const makeClient = (url, key, options = {}) => createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  ...options,
});

const text = (value, max = 500) => {
  const out = String(value ?? "").trim();
  return out ? out.slice(0, max) : null;
};
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const missingRpc = (error) => String(error?.code || "").toUpperCase() === "PGRST202"
  || /schema cache|could not find the function|sarraf_ingest_receipt_batch/i.test(String(error?.message || ""));
const requestId = () => globalThis.crypto?.randomUUID?.() || `receipt-${Date.now().toString(36)}`;

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseBearer(req) {
  const header = String(req?.headers?.authorization || req?.headers?.Authorization || "");
  if (!header.startsWith("Bearer ")) throw httpError(401, "session_required", "session required");
  return header.slice(7).trim();
}

function validateCommand(body) {
  const batch = body?.p_batch;
  const receipts = body?.p_receipts;
  const commandKey = text(body?.p_command_key, 180);
  const batchId = text(batch?.id, 140);
  if (!batch || typeof batch !== "object" || !Array.isArray(receipts)) throw httpError(400, "invalid_command", "invalid receipt command");
  if (!/^receipt-ingest:[A-Za-z0-9-]{16,128}$/.test(commandKey || "") || !/^[A-Za-z0-9-]{16,128}$/.test(batchId || "")) {
    throw httpError(400, "invalid_identity", "invalid receipt identity");
  }
  if (receipts.length < 1 || receipts.length > 25) throw httpError(400, "invalid_count", "invalid receipt count");
  if (!["in", "out", "buy", "sell"].includes(batch.direction) || !/^[A-Z]{3,8}$/.test(String(batch.currency || ""))) {
    throw httpError(400, "invalid_batch", "invalid receipt batch");
  }

  const seen = new Set();
  const normalized = receipts.map((receipt) => {
    const id = text(receipt?.id, 140);
    const amount = finite(receipt?.amount);
    const fee = finite(receipt?.fee) ?? 0;
    const currency = String(receipt?.currency || "").trim().toUpperCase();
    const imagePath = text(receipt?.image_path, 360);
    if (!/^[A-Za-z0-9-]{6,128}$/.test(id || "") || seen.has(id)) throw httpError(400, "invalid_receipt", "invalid receipt row");
    seen.add(id);
    if (receipt?.batch_id !== batchId || imagePath !== `ingest/${batchId}/${id}.jpg`) throw httpError(400, "invalid_path", "invalid receipt image path");
    if (!(amount > 0 && amount <= 1_000_000_000_000) || fee < 0 || fee > amount) throw httpError(400, "invalid_amount", "invalid receipt amount");
    if (!/^[A-Z]{3,8}$/.test(currency) || currency !== batch.currency) throw httpError(400, "mixed_currency", "send each currency as a separate receipt batch");
    if (!["ok", "suspect", "error", "rejected"].includes(String(receipt?.status || ""))) throw httpError(400, "invalid_status", "invalid receipt status");
    return { ...receipt, id, amount, fee, net_amount: amount - fee, currency, image_path: imagePath };
  });

  return { batch: { ...batch, id: batchId }, receipts: normalized, commandKey };
}

async function requireActor(req, authClient, service) {
  const token = parseBearer(req);
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData?.user?.id) throw httpError(401, "session_expired", "session expired");
  const { data: actor, error } = await service.from("app_users")
    .select(`${ACTOR_COLUMNS},auth_id,name`)
    .eq("auth_id", userData.user.id)
    .eq("deleted", false)
    .maybeSingle();
  if (error || !actor?.id) throw httpError(403, "account_not_linked", "account is not linked");
  return { actor, token };
}

// Who this batch is about, and whether this caller is allowed to say so.
//
// This route holds the service key, so none of the lookups below are filtered by row level
// security: an id names a row anywhere on the platform. Being an administrator therefore
// authorises nothing on its own — an administrator is an administrator of one business, and
// the customer and partner named on a batch must belong to that same business. Without the
// tenant conditions an administrator could open a batch against another business's customer,
// and the portal read policy — which matches on customer_id — would then show that customer a
// batch from a business they have never dealt with.
async function validateContext(service, actor, batch) {
  const customerId = text(batch.customer_id, 140);
  const partnerId = text(batch.partner_id, 140);
  // A manager has no business of their own. They do not send receipts; they sell the system.
  if (isTenantless(actor)) throw httpError(403, "context_denied", "receipt context denied");
  const staff = actor.role === "admin" || actor.role === "office";
  if (!staff && !(actor.role === "customer" && customerId === actor.id) && !(actor.role === "partner" && partnerId === actor.id)) {
    throw httpError(403, "context_denied", "receipt context denied");
  }
  let customer = null;
  if (customerId) {
    const result = await service.from("app_users").select("id,name,role,deleted,tenant_id").eq("id", customerId).eq("role", "customer").eq("deleted", false).maybeSingle();
    if (result.error || !result.data || !sameTenant(actor, result.data)) throw httpError(400, "invalid_customer", "invalid customer");
    customer = result.data;
  }
  if (partnerId) {
    const result = await service.from("app_users").select("id,role,deleted,tenant_id").eq("id", partnerId).eq("role", "partner").eq("deleted", false).maybeSingle();
    if (result.error || !result.data || !sameTenant(actor, result.data)) throw httpError(400, "invalid_partner", "invalid partner");
  }
  return { customerId, customerName: customer?.name || text(batch.customer_name, 120), partnerId, tenantId: actor.tenant_id };
}

async function validateStagedObjects(scoped, service, batchId, receipts) {
  const paths = receipts.map((receipt) => receipt.image_path);
  const signed = await scoped.storage.from("receipts").createSignedUrls(paths, 60);
  if (signed.error || (signed.data || []).some((item) => item.error || !item.signedUrl)) {
    throw httpError(400, "staged_object_denied", "receipt image is missing or unavailable");
  }
  const listed = await service.storage.from("receipts").list(`ingest/${batchId}`, { limit: 100 });
  if (listed.error) throw httpError(503, "storage_unavailable", "receipt storage unavailable");
  const files = new Map((listed.data || []).map((item) => [item.name, item]));
  for (const receipt of receipts) {
    const item = files.get(`${receipt.id}.jpg`);
    const size = finite(item?.metadata?.size);
    const mime = String(item?.metadata?.mimetype || item?.metadata?.contentType || "").toLowerCase();
    if (!item || !(size > 0 && size <= 10 * 1024 * 1024) || (mime && !["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mime))) {
      throw httpError(400, "invalid_staged_object", "invalid staged receipt image");
    }
  }
}

function missingCompatibilityColumn(error, allowed) {
  if (String(error?.code || "").toUpperCase() !== "PGRST204") return null;
  const message = String(error?.message || "");
  const match = message.match(/Could not find the ['"]([^'"]+)['"] column/i)
    || message.match(/column ['"]?([^'"\s]+)['"]?.*schema cache/i);
  const column = match?.[1] || null;
  return column && allowed.has(column) ? column : null;
}

async function insertCompat(service, table, payload, optionalColumns) {
  const allowed = new Set(optionalColumns);
  let current = Array.isArray(payload) ? payload.map((row) => ({ ...row })) : { ...payload };
  while (true) {
    const result = await service.from(table).insert(current);
    if (!result.error) return;
    const column = missingCompatibilityColumn(result.error, allowed);
    if (!column) throw result.error;
    allowed.delete(column);
    if (Array.isArray(current)) current = current.map(({ [column]: _omitted, ...row }) => row);
    else {
      const { [column]: _omitted, ...row } = current;
      current = row;
    }
  }
}

async function legacyCommit(service, actor, batch, receipts, context) {
  const existing = await service.from("receipt_batches").select("id,uploaded_by").eq("id", batch.id).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.id) {
    if (existing.data.uploaded_by !== actor.id) throw httpError(409, "batch_conflict", "receipt batch conflict");
  }

  const totalGross = receipts.reduce((sum, row) => sum + row.amount, 0);
  const totalFee = receipts.reduce((sum, row) => sum + row.fee, 0);
  const totalNet = receipts.reduce((sum, row) => sum + (finite(row.net_amount) ?? row.amount - row.fee), 0);
  const rejected = receipts.filter((row) => row.status === "error" || row.status === "rejected").length;
  const batchRow = {
    id: batch.id,
    customer_id: context.customerId,
    customer_name: context.customerName,
    partner_id: context.partnerId,
    direction: batch.direction,
    status: "new",
    currency: batch.currency,
    total_gross: totalGross,
    total_fee: totalFee,
    total_net: totalNet,
    n: receipts.length,
    dup_n: Math.max(0, finite(batch.dup_n) ?? 0),
    rejected_n: rejected,
    uploaded_by: actor.id,
    source: text(batch.source, 30) || "app",
    // The column defaults to sarraf_tenant(), which reads auth.uid(). This path writes with the
    // service key, where there is no auth.uid() — so the default yields null and the row would
    // belong to no business at all: invisible to its own owner and hidden by every restrictive
    // policy. The business is named explicitly instead.
    tenant_id: context.tenantId,
  };
  const receiptRows = receipts.map((row) => ({
    id: row.id,
    batch_id: batch.id,
    customer_id: context.customerId,
    customer_name: context.customerName,
    direction: batch.direction,
    amount: row.amount,
    fee: row.fee,
    fee_original: finite(row.fee_original),
    fee_discount: Math.max(0, finite(row.fee_discount) ?? 0),
    platform: text(row.platform, 60),
    net_amount: finite(row.net_amount),
    currency: row.currency,
    sender: text(row.sender, 160),
    receiver: text(row.receiver, 160),
    ref_no: text(row.ref_no, 160),
    tx_time: text(row.tx_time, 32),
    tx_date: text(row.tx_date, 16),
    bank: text(row.bank, 80),
    note: text(row.note, 1000),
    image_hash: text(row.image_hash, 256),
    image_path: row.image_path,
    status: row.status,
    counted: row.counted !== false,
    reject_code: text(row.reject_code, 60),
    reject_reason: text(row.reject_reason, 500),
    dup_of: text(row.dup_of, 140),
    dup_of_date: text(row.dup_of_date, 80),
    dup_of_who: text(row.dup_of_who, 160),
    uploaded_by: actor.id,
    raw: row.raw && typeof row.raw === "object" ? row.raw : {},
    tenant_id: context.tenantId,
  }));

  if (!existing.data?.id) {
    await insertCompat(service, "receipt_batches", batchRow, ["source", "rejected_n", "dup_n", "uploaded_by", "partner_id", "customer_name", "tenant_id"]);
  }

  // The compatibility path is intentionally resumable rather than compensating with DELETE.
  // A bulk receipt insert is one PostgREST transaction. If it fails after the batch row was
  // created, the same command reads what exists and fills only the missing immutable rows.
  const stored = await service.from("receipts").select("id,batch_id").eq("batch_id", batch.id);
  if (stored.error) throw stored.error;
  const expectedIds = new Set(receiptRows.map((row) => row.id));
  const storedIds = new Set((stored.data || []).map((row) => row.id));
  if ([...storedIds].some((id) => !expectedIds.has(id))) {
    throw httpError(409, "batch_receipt_conflict", "receipt batch contains an unexpected immutable row");
  }
  const missingRows = receiptRows.filter((row) => !storedIds.has(row.id));
  if (missingRows.length) {
    await insertCompat(service, "receipts", missingRows, [
      "fee_original", "fee_discount", "platform", "net_amount", "counted", "reject_code", "reject_reason",
      "dup_of", "dup_of_date", "dup_of_who", "raw", "uploaded_by", "image_path", "bank", "note",
      "tenant_id",
    ]);
  }

  const verified = await service.from("receipts").select("id,batch_id").eq("batch_id", batch.id);
  if (verified.error) throw verified.error;
  const verifiedIds = new Set((verified.data || []).map((row) => row.id));
  if (verifiedIds.size !== expectedIds.size || [...expectedIds].some((id) => !verifiedIds.has(id))) {
    throw httpError(503, "receipt_recovery_incomplete", "receipt recovery is incomplete; retry the same command");
  }

  // Databases that already have the assurance tables but temporarily lack the RPC also receive
  // the canonical durable-intake mirror. A genuinely older database simply has no such table.
  const intakeExisting = await service.from("receipt_intake_items").select("id").eq("batch_id", batch.id);
  const intakeMissingTable = intakeExisting.error && (
    ["42P01", "PGRST205"].includes(String(intakeExisting.error.code || "").toUpperCase())
      || /receipt_intake_items.*(?:not find|does not exist|schema cache)/i.test(String(intakeExisting.error.message || ""))
  );
  if (intakeExisting.error && !intakeMissingTable) throw intakeExisting.error;
  if (!intakeMissingTable) {
    const intakeIds = new Set((intakeExisting.data || []).map((row) => row.id));
    const intakeRows = receipts.filter((row) => !intakeIds.has(row.id)).map((row) => {
      const accepted = row.status === "ok" && row.counted !== false;
      return {
        id: row.id,
        batch_id: batch.id,
        submitted_by: actor.id,
        customer_id: context.customerId,
        partner_id: context.partnerId,
        direction: batch.direction,
        image_path: row.image_path,
        image_hash: text(row.image_hash, 256),
        amount: row.amount,
        fee: row.fee,
        net_amount: row.amount - row.fee,
        currency: row.currency,
        ref_no: text(row.ref_no, 160),
        source_status: row.status,
        intake_status: accepted ? "accepted" : "rejected",
        counted: accepted,
        rule_code: accepted ? null : text(row.reject_code, 80) || "legacy_recovery_rejected",
        rule_reason: accepted ? null : text(row.reject_reason, 700) || "receipt held by recovery validation",
        raw: row.raw && typeof row.raw === "object" ? row.raw : {},
        tenant_id: context.tenantId,
      };
    });
    if (intakeRows.length) {
      const intakeInsert = await service.from("receipt_intake_items").insert(intakeRows);
      if (intakeInsert.error) throw intakeInsert.error;
    }
  }

  // Best-effort admin notification. Receipt visibility never depends on it.
  const notice = await service.from("notes").insert({
    id: `note-receipt-${batch.id}`,
    user_id: null,
    kind: "receipt",
    title: "کۆمەڵەی فیشی نوێ",
    body: `${receipts.length} فیش بۆ پشکنین گەیشت`,
    link: "receipts",
    ref_id: batch.id,
    // notes normally takes its tenant from the recipient; this one is addressed to the whole
    // administration of one business, so it has to say which.
    tenant_id: context.tenantId,
  });
  if (notice.error && String(notice.error.code || "") !== "23505") {
    console.warn("[receipt-ingestion] admin notification skipped", { code: notice.error.code });
  }

  return {
    batch_id: batch.id,
    receipt_count: receipts.length,
    replayed: !!existing.data?.id && missingRows.length === 0,
    resumed: !!existing.data?.id && missingRows.length > 0,
    recovery: true,
  };
}

// sarraf_ingest_receipt_batch only executes a command this service has blessed: it deletes a
// matching receipt_ingestion_authorizations row and refuses the command when none is found.
// Nothing else can create that row — the table is granted to service_role alone — so the
// authorization is minted here, immediately before the RPC runs under the caller's token.
//
// The RPC checks authorization before its replay check, so each attempt needs its own token;
// a retry after a failed attempt upserts over the stale row rather than colliding with it.
//
// Databases predating the receipt-assurance migration have no such table. That is not an
// error: the older RPC does not demand a token, so a missing table means there is nothing to
// authorize and ingestion proceeds unchanged.
async function authorizeIngestionCommand(service, actorId, commandKey) {
  const token = randomBytes(32).toString("base64url");
  const { error } = await service.from("receipt_ingestion_authorizations").upsert({
    command_key: commandKey,
    actor_id: actorId,
    authorization_token: token,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  }, { onConflict: "command_key" });
  if (!error) return token;
  const code = String(error.code || "").toUpperCase();
  const missingTable = code === "42P01" || code === "PGRST205"
    || /receipt_ingestion_authorizations/i.test(String(error.message || ""));
  if (missingTable) return null;
  throw error;
}

export { validateCommand, authorizeIngestionCommand, validateContext };

export default async function handler(req, res) {
  const trace = requestId();
  if (req.method !== "POST") return res.status(405).json({ code: "method_not_allowed", message: "method not allowed", requestId: trace });
  try {
    const config = serverConfig();
    if (!config.url || !config.publicKey || !config.secretKey) throw httpError(503, "server_not_configured", "receipt service is not configured");
    const authClient = makeClient(config.url, config.publicKey);
    const service = makeClient(config.url, config.secretKey);
    const { batch, receipts, commandKey } = validateCommand(req.body || {});
    const { actor, token } = await requireActor(req, authClient, service);

    // A batch is expensive: it stores images and writes rows. Counted per person, in the
    // database, because this route is serverless and a per-process counter would not count.
    if (await refuseIfOverLimit(res, {
      url: config.url, key: config.secretKey, bucket: "receipt-ingestion",
      subject: limitSubject(req, actor.id), limit: INGEST_LIMIT, windowSeconds: INGEST_WINDOW_SECONDS,
    })) return;
    const context = await validateContext(service, actor, batch);
    const scoped = makeClient(config.url, config.publicKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    await validateStagedObjects(scoped, service, batch.id, receipts);

    console.info("[receipt-ingestion] commit started", { requestId: trace, batchId: batch.id, actorId: actor.id, count: receipts.length });
    const authorizationToken = await authorizeIngestionCommand(service, actor.id, commandKey);
    const authorizedBatch = authorizationToken ? { ...batch, _authorization_token: authorizationToken } : batch;
    const rpc = await scoped.rpc("sarraf_ingest_receipt_batch", { p_batch: authorizedBatch, p_receipts: receipts, p_command_key: commandKey });
    const data = rpc.error && missingRpc(rpc.error)
      ? await legacyCommit(service, actor, batch, receipts, context)
      : rpc.error
        ? (() => { throw rpc.error; })()
        : rpc.data;
    console.info("[receipt-ingestion] commit completed", { requestId: trace, batchId: batch.id, recovery: !!data?.recovery });
    return res.status(200).json({ data, requestId: trace });
  } catch (error) {
    const status = Number(error?.status) || (String(error?.code || "") === "42501" ? 403 : 500);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    console.error("[receipt-ingestion] commit failed", { requestId: trace, status: safeStatus, code: error?.code || "unknown", message: String(error?.message || error).slice(0, 300) });
    return res.status(safeStatus).json({
      code: error?.code || "receipt_commit_failed",
      message: safeStatus === 401 ? "کاتی چوونەژوورەوە بەسەرچووە" : safeStatus === 403 ? "دەسەڵاتی ناردنی ئەم فیشەت نییە" : safeStatus < 500 ? "زانیارییەکانی فیشەکە دروست نین" : "فیشەکە تۆمار نەکرا؛ تکایە دووبارە هەوڵ بدەوە",
      requestId: trace,
    });
  }
}
