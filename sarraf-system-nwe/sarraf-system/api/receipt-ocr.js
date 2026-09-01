// Canonical stored-object receipt OCR.
//
// The browser sends only a document id.  This route authenticates the caller, downloads the
// original from protected storage with the service role, verifies its signature/hash, runs OCR,
// and records the extraction through a service-role-only RPC.  Client JSON is never accepted as
// a financial or receipt verdict.

import { createHash, randomUUID } from "node:crypto";
import { ACTOR_COLUMNS, sameTenant, notFound } from "./_tenant.js";
import { createClient } from "@supabase/supabase-js";
import { readReceiptImage } from "./read-receipt.js";

const MAX_BYTES = 20 * 1024 * 1024;
const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 10;
const windows = new Map();

const config = () => ({
  url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
  publicKey: process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_ANON_KEY
    || process.env.VITE_SUPABASE_ANON_KEY
    || "",
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
  } catch {
    return {};
  }
}

export function sniffImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  return null;
}

function checkRateLimit(key) {
  const now = Date.now();
  const current = windows.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    windows.set(key, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > REQUESTS_PER_WINDOW) {
    throw failure(429, "receipt_ocr_rate_limited", "receipt OCR rate limit reached", true);
  }
  // Bound module memory in warm serverless instances.
  if (windows.size > 2_000) {
    for (const [entry, value] of windows) {
      if (now - value.startedAt >= WINDOW_MS) windows.delete(entry);
    }
  }
}

export function extractionPayload(result) {
  const number = (value) => Number.isFinite(Number(value)) ? String(Math.abs(Number(value))) : null;
  const gross = Number(result?.amount);
  const order = Number(result?.orderAmount);
  const fee = Number(result?.fee);
  const exactAddedOnTop = Number.isFinite(gross) && Number.isFinite(order) && Number.isFinite(fee)
    && Math.abs(Math.round(gross * 100) - Math.round((order + fee) * 100)) <= 1;
  return {
    grossAmount: number(result?.amount),
    orderAmount: number(result?.orderAmount),
    feeAmount: number(result?.fee),
    feeTreatment: exactAddedOnTop ? "added_on_top"
      : Number(result?.fee) === 0 ? "no_fee" : "unknown",
    netAmount: number(result?.netAmount ?? result?.orderAmount),
    currency: result?.currency || null,
    refNo: result?.refNo || null,
    merchantOrderNo: result?.merchantOrderNo || null,
    payee: result?.receiver || result?.merchantName || null,
    txDate: result?.txDate || null,
    txTime: result?.txTime || null,
    confidence: number(result?.confidence),
    fieldConfidence: result?.fieldConfidence && typeof result.fieldConfidence === "object"
      ? result.fieldConfidence : {},
    transactionStatus: result?.transactionStatus || null,
    paymentMethod: result?.paymentMethod || null,
    cardLast4: result?.cardLast4 || null,
    sender: result?.sender || null,
    recipientNote: result?.recipientNote || null,
    merchantName: result?.merchantName || null,
    platform: result?.platform || null,
    platformEvidence: result?.platformEvidence || null,
    validation: result?.validation || null,
    ocrVersion: String(result?.ocrVersion || 6),
  };
}

async function requireActor(req, auth, service) {
  const token = bearer(req);
  const authResult = await auth.auth.getUser(token);
  const authId = authResult.data?.user?.id;
  if (authResult.error || !authId) throw failure(401, "session_expired", "session expired");
  const actorResult = await service.from("app_users")
    .select(ACTOR_COLUMNS)
    .eq("auth_id", authId)
    .eq("deleted", false)
    .maybeSingle();
  if (actorResult.error || !actorResult.data?.id) {
    throw failure(403, "account_not_linked", "account is not linked");
  }
  const claims = decodeClaims(token);
  if (actorResult.data.role === "admin" && String(claims.aal || "aal1") !== "aal2") {
    throw failure(403, "mfa_required", "multi-factor authentication is required");
  }
  return { actor: actorResult.data, token };
}

export default async function handler(req, res) {
  const requestId = randomUUID();
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ code: "method_not_allowed", message: "POST only", retryable: false, outcomeKnown: true, requestId });
  }

  try {
    const settings = config();
    if (!settings.url || !settings.publicKey || !settings.serviceKey) {
      throw failure(503, "server_not_configured", "receipt OCR service is not configured", true);
    }
    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    } catch {
      throw failure(400, "invalid_json", "request body is not valid JSON");
    }
    const keys = Object.keys(body);
    if (keys.some((key) => key !== "documentId") || !/^[A-Za-z0-9-]{6,128}$/.test(String(body.documentId || ""))) {
      throw failure(400, "invalid_request", "only a valid documentId is accepted");
    }
    const auth = client(settings.url, settings.publicKey);
    const service = client(settings.url, settings.serviceKey);
    const { actor } = await requireActor(req, auth, service);
    const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
    checkRateLimit(`${actor.id}:${ip}`);

    const documentResult = await service.from("receipt_documents")
      .select("id,uploader_id,state,storage_path,mime_type,image_sha256,tenant_id")
      .eq("id", body.documentId)
      .maybeSingle();
    const document = documentResult.data;
    if (documentResult.error) throw failure(503, "receipt_lookup_failed", "receipt lookup is unavailable", true);
    if (!document?.id) throw notFound("receipt");
    // This route holds the service key, so nothing below it is filtered by row level security.
    // An administrator is an administrator of one business; without this line any administrator
    // could read the image bytes of any receipt on the platform.
    if (!sameTenant(actor, document)) throw notFound("receipt");
    if (document.uploader_id !== actor.id && actor.role !== "admin") {
      throw failure(403, "receipt_not_owned", "receipt is outside this assignment");
    }
    if (!["uploading", "upload_failed_retryable", "uploaded", "ocr_pending", "ocr_failed_retryable"].includes(document.state)) {
      // Status probe after a lost response is safe and never runs OCR twice.
      return res.status(200).json({ documentId: document.id, state: document.state, replayed: true, requestId });
    }

    const download = await service.storage.from("receipts").download(document.storage_path);
    if (download.error || !download.data) throw failure(503, "stored_image_unavailable", "stored receipt image is unavailable", true);
    const bytes = Buffer.from(await download.data.arrayBuffer());
    if (bytes.length < 1 || bytes.length > MAX_BYTES) throw failure(400, "invalid_stored_size", "stored receipt size is invalid");
    const mediaType = sniffImage(bytes);
    if (!mediaType) throw failure(400, "invalid_image_signature", "stored object is not a supported image");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (document.image_sha256 && document.image_sha256 !== sha256) {
      throw failure(409, "stored_image_changed", "stored receipt bytes changed after attestation");
    }

    const started = Date.now();
    let result;
    try {
      result = await readReceiptImage(bytes.toString("base64"), mediaType, {
        maxBase64Chars: Math.ceil(MAX_BYTES * 4 / 3) + 4,
      });
    } catch (ocrError) {
      const provider = Array.isArray(ocrError?.attempts) ? ocrError.attempts.at(-1)?.provider : null;
      const record = await service.rpc("sarraf_receipt_record_server_extraction", {
        p_document_id: document.id,
        p_image_sha256: sha256,
        p_byte_size: bytes.length,
        p_mime_type: mediaType,
        p_ok: false,
        p_extraction: { error: String(ocrError?.code || ocrError?.message || "ocr_failed").slice(0, 80) },
        p_provider: provider,
        p_model: null,
        p_latency_ms: Date.now() - started,
        p_request_id: requestId,
      });
      if (record.error) throw failure(503, "ocr_record_failed", "receipt OCR outcome could not be recorded", true, false);
      return res.status(202).json({
        documentId: document.id,
        state: record.data?.state || "ocr_failed_retryable",
        retryable: true,
        outcomeKnown: true,
        requestId,
      });
    }

    const payload = extractionPayload(result);
    const record = await service.rpc("sarraf_receipt_record_server_extraction", {
      p_document_id: document.id,
      p_image_sha256: sha256,
      p_byte_size: bytes.length,
      p_mime_type: mediaType,
      p_ok: true,
      p_extraction: payload,
      p_provider: result?._meta?.provider || null,
      p_model: result?._meta?.model || null,
      p_latency_ms: Date.now() - started,
      p_request_id: requestId,
    });
    if (record.error) throw failure(503, "ocr_record_failed", "receipt OCR outcome could not be recorded", true, false);
    return res.status(200).json({
      documentId: document.id,
      state: record.data?.state,
      extraction: payload,
      retryable: false,
      outcomeKnown: true,
      requestId,
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    // Never log OCR text, object bytes, tokens, card data, or provider payloads.
    console.error("[receipt-ocr] request failed", { requestId, status, code: error?.code || "receipt_ocr_failed" });
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      code: error?.code || "receipt_ocr_failed",
      message: status === 401 ? "کاتی چوونەژوورەوە بەسەرچووە"
        : status === 403 ? "دەسەڵاتی ئەم فیشەت نییە"
          : status === 429 ? "سنووری خوێندنەوە پڕبووە؛ کەمێک دواتر دووبارە هەوڵ بدەوە"
            : status < 500 ? "وێنە یان ناسنامەی فیشەکە دروست نییە"
              : "وێنەکە پارێزراوە؛ خوێندنەوەکە کاتێک بەردەست نییە",
      retryable: Boolean(error?.retryable || status >= 500 || status === 429),
      outcomeKnown: error?.outcomeKnown !== false,
      requestId,
    });
  }
}
