// Server-side attestation for immutable office-payment evidence.
//
// The browser supplies only the already-uploaded object identity. This route authenticates the
// assigned office, downloads the protected bytes, detects the real media type, hashes the exact
// bytes, and records that attestation through a service-role-only database command.

import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { ACTOR_COLUMNS, sameTenant } from "./_tenant.js";

const MAX_BYTES = 10 * 1024 * 1024;
const windows = new Map();

const config = () => ({
  url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
  publicKey: process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "",
  serviceKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
});

const client = (url, key) => createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

function failure(status, code, message, retryable = false, outcomeKnown = true) {
  const error = new Error(message);
  Object.assign(error, { status, code, retryable, outcomeKnown });
  return error;
}

function bearer(req) {
  const header = String(req?.headers?.authorization || req?.headers?.Authorization || "");
  if (!header.startsWith("Bearer ")) throw failure(401, "session_required", "session required");
  return header.slice(7).trim();
}

function decodeClaims(token) {
  try {
    const value = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch { return {}; }
}

export function sniffEvidence(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function rateLimit(actorId, ip) {
  const key = `${actorId}:${ip}`;
  const now = Date.now();
  const current = windows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    windows.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (++current.count > 30) throw failure(429, "evidence_rate_limited", "evidence rate limit reached", true);
  if (windows.size > 2_000) {
    for (const [entry, value] of windows) if (now - value.startedAt >= 60_000) windows.delete(entry);
  }
}

export default async function handler(req, res) {
  const requestId = randomUUID();
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ code: "method_not_allowed", message: "POST only", requestId });
  }
  try {
    const settings = config();
    if (!settings.url || !settings.publicKey || !settings.serviceKey) {
      throw failure(503, "server_not_configured", "evidence service is not configured", true);
    }
    let body;
    try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
    catch { throw failure(400, "invalid_json", "request body is not valid JSON"); }
    const keys = Object.keys(body);
    if (keys.some((key) => !["assignmentId", "storagePath", "commandKey"].includes(key))
      || !/^[A-Za-z0-9-]{6,128}$/.test(String(body.assignmentId || ""))
      || !/^ingest\/office-payments\/[A-Za-z0-9-]{6,128}\/[A-Za-z0-9-]+\.(?:jpg|jpeg|png|webp|pdf)$/.test(String(body.storagePath || ""))
      || !/^[A-Za-z0-9:_-]{12,240}$/.test(String(body.commandKey || ""))) {
      throw failure(400, "invalid_request", "evidence object identity is invalid");
    }
    if (!body.storagePath.startsWith(`ingest/office-payments/${body.assignmentId}/`)) {
      throw failure(400, "path_mismatch", "evidence path does not belong to this assignment");
    }

    const token = bearer(req);
    const auth = client(settings.url, settings.publicKey);
    const service = client(settings.url, settings.serviceKey);
    const authResult = await auth.auth.getUser(token);
    const authId = authResult.data?.user?.id;
    if (authResult.error || !authId) throw failure(401, "session_expired", "session expired");
    const actorResult = await service.from("app_users").select(ACTOR_COLUMNS)
      .eq("auth_id", authId).eq("deleted", false).maybeSingle();
    const actor = actorResult.data;
    if (actorResult.error) throw failure(503, "actor_lookup_failed", "account lookup is unavailable", true);
    if (!actor?.id || actor.role !== "office") throw failure(403, "office_required", "office account required");
    if (String(decodeClaims(token).aal || "aal1") !== "aal2") {
      throw failure(403, "mfa_required", "multi-factor authentication is required");
    }
    const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
    rateLimit(actor.id, ip);

    const assignmentResult = await service.from("office_payment_assignments")
      .select("id,office_id,status,tenant_id").eq("id", body.assignmentId).maybeSingle();
    if (assignmentResult.error) throw failure(503, "assignment_lookup_failed", "assignment lookup is unavailable", true);
    // Two conditions, not one. office_id already binds the assignment to this account; the
    // business is checked as well so that a row which somehow carries the wrong tenant cannot
    // be reached through the service key, which has no row level security to fall back on.
    if (!assignmentResult.data?.id
      || assignmentResult.data.office_id !== actor.id
      || !sameTenant(actor, assignmentResult.data)) {
      throw failure(403, "assignment_not_owned", "assignment is outside this office");
    }
    if (["confirmed", "cancelled", "rejected"].includes(assignmentResult.data.status)) {
      throw failure(409, "assignment_closed", "assignment no longer accepts evidence");
    }

    const download = await service.storage.from("receipts").download(body.storagePath);
    if (download.error || !download.data) throw failure(503, "stored_evidence_unavailable", "stored evidence is unavailable", true);
    const bytes = Buffer.from(await download.data.arrayBuffer());
    if (bytes.length < 1 || bytes.length > MAX_BYTES) throw failure(400, "invalid_stored_size", "stored evidence size is invalid");
    const mediaType = sniffEvidence(bytes);
    if (!mediaType) throw failure(400, "invalid_evidence_signature", "stored object is not a supported image or PDF");
    const extension = body.storagePath.split(".").pop().toLowerCase();
    const expected = extension === "pdf" ? "application/pdf" : extension === "png" ? "image/png"
      : extension === "webp" ? "image/webp" : "image/jpeg";
    if (mediaType !== expected) throw failure(400, "evidence_type_mismatch", "stored evidence does not match its extension");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const record = await service.rpc("sarraf_office_payment_attach_evidence_server", {
      p_assignment_id: body.assignmentId,
      p_storage_path: body.storagePath,
      p_image_sha256: sha256,
      p_file_size: bytes.length,
      p_media_type: mediaType,
      p_actor_id: actor.id,
      p_command_key: body.commandKey,
    });
    if (record.error) throw failure(503, "evidence_record_failed", "evidence attestation could not be recorded", true, false);
    return res.status(200).json({ ...record.data, requestId, outcomeKnown: true });
  } catch (error) {
    const status = Number(error?.status) || 500;
    console.error("[office-payment-evidence] request failed", {
      requestId, status, code: error?.code || "evidence_attestation_failed",
    });
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      code: error?.code || "evidence_attestation_failed",
      message: status === 401 ? "کاتی چوونەژوورەوە بەسەرچووە"
        : status === 403 ? "دەسەڵاتی ئەم ئەرکەت نییە"
          : status === 429 ? "سنووری ناردن پڕبووە؛ کەمێک دواتر هەوڵ بدەوە"
            : status < 500 ? "فایلی بەڵگەکە دروست نییە"
              : "بەڵگەکە بارکراوە؛ پشکنینی server کاتێک بەردەست نییە",
      retryable: Boolean(error?.retryable || status >= 500 || status === 429),
      outcomeKnown: error?.outcomeKnown !== false,
      requestId,
    });
  }
}
