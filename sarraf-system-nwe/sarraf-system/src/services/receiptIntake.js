/**
 * Canonical, upload-first receipt intake.
 *
 * The browser is deliberately limited to a transaction id and image bytes. The database derives
 * the flow, customer, partner and expected currency from the transaction assignment, while the
 * server OCR route downloads and attests the stored original before recording any extraction.
 */

import { zemanRule } from "./userFacingError.js";

const newId = () =>
  (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
    .replace(/[^A-Za-z0-9-]/g, "").slice(0, 60);

const cleanSubject = (value) => String(value || "receipt").replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 70);

export const receiptIntakeCommandKey = (transactionId = "receipt", documentId = newId()) =>
  `receipt-intake:${cleanSubject(transactionId)}:${cleanSubject(documentId)}`;

export const receiptSubmitCommandKey = () => `receipt-submit:${newId()}`;

/** Progress values are client facts. None of them is an OCR or accounting verdict. */
export const INTAKE_STAGE = Object.freeze({
  claiming: "claiming",
  uploading: "uploading",
  stored: "stored",
  reading: "reading",
  done: "done",
  readFailed: "read_failed",
  uploadFailed: "upload_failed",
});

export class ReceiptIntakeError extends Error {
  constructor(stage, cause, evidenceKept) {
    super(
      evidenceKept
        ? "وێنەکە بە سەلامەتی پارێزراوە؛ خوێندنەوەکە دواتر دووبارە دەکرێتەوە"
        : "وێنەکە نەگەیشت؛ تکایە دووبارە هەوڵ بدەوە"
    );
    this.name = "ReceiptIntakeError";
    this.stage = stage;
    this.cause = cause;
    this.evidenceKept = evidenceKept;
    this.code = cause?.code || null;
    // Carried, not dropped. The uploader's screen decides whether a failure is temporary by
    // reading `status`, and this class kept only `code` — so a 503 from a reader that was
    // briefly unavailable arrived with no status at all, was judged permanent, and the receipt
    // was marked rejected instead of waiting. `reason` is what the server actually said, which
    // is the difference between "no API key is configured" and "your session expired": both
    // used to reach the screen as the same sentence.
    this.status = Number(cause?.status) || null;
    this.requestId = cause?.requestId || null;
    this.reason = cause?.message || null;
    this.retryable = Boolean(cause?.retryable || stage === "ocr");
    this.outcomeKnown = cause?.outcomeKnown !== false;
  }
}

/** What an uploader can act on, for the failures the OCR route actually names. */
export function receiptReadFailureText(error) {
  const code = String(error?.code || "");
  const named = {
    server_not_configured: "خزمەتگوزاری خوێندنەوە لەسەر سێرڤەر ڕێک نەخراوە — کلیلی API دانەنراوە",
    session_required: "چوونەژوورەوەکەت بەسەرچووە — دەرچۆ و دووبارە بچۆرە ژوورەوە",
    receipt_not_owned: "ئەم فیشە هی تۆ نییە",
    receipt_not_found: "فیشەکە نەدۆزرایەوە",
    stored_image_unavailable: "وێنە پارێزراوەکە بەردەست نییە",
    invalid_image_signature: "ئەم فایلە وێنەیەکی پشتگیریکراو نییە",
    stored_image_changed: "بایتەکانی وێنەکە گۆڕاون دوای پاراستن",
    receipt_ocr_rate_limited: "سنووری خوێندنەوە پڕبووە — کەمێک دواتر",
    ocr_record_failed: "ئەنجامی خوێندنەوە تۆمار نەکرا",
  }[code];
  if (named) return named;
  if (!code) return null;
  // Never invent a translation for a code nobody has seen. Showing it verbatim is what lets
  // somebody act on it — an unnamed failure that reads the same as every other unnamed failure
  // is how an unset API key looked identical to an expired session for a whole evening.
  return `خوێندنەوە سەرکەوتوو نەبوو (${code})`;
}

/**
 * Write down why a reading failed, on the receipt it failed for.
 *
 * When the reading fails inside the reader the server records an attempt row and a rule code.
 * When it fails BEFORE the reader — no configuration, no session, the object could not be
 * downloaded — it records nothing at all, and the database shows `uploading` with a null error
 * for every one of them. The browser is told the code in the response body every single time,
 * and kept it to itself.
 *
 * Best effort, always. A diagnosis that cannot be written down must not also lose the receipt.
 */
/**
 * The image never arrived.
 *
 * Best effort, like noteReceiptReadFailure: an upload that failed must not also fail because the
 * report about it failed. What it buys is that the document leaves `uploading` — the state its
 * batch waits on — and enters `upload_failed_retryable`, from which it can be sent again.
 */
export async function noteReceiptUploadFailure(client, documentId, cause) {
  try {
    await client.rpc("sarraf_receipt_upload_failed", {
      p_document_id: documentId,
      p_code: cause?.code || cause?.statusCode || "upload_failed",
    });
  } catch { /* the sweep closes whatever this could not */ }
}

export async function noteReceiptReadFailure(client, documentId, cause) {
  try {
    await client.rpc("sarraf_receipt_note_read_failure", {
      p_document_id: documentId,
      p_code: cause?.code || "unknown",
      p_status: Number(cause?.status) || null,
    });
  } catch { /* the receipt is safe either way; this is only the reason */ }
}

async function accessToken(client) {
  const result = await client.auth.getSession();
  const token = result?.data?.session?.access_token;
  if (result?.error || !token) {
    const error = result?.error || new Error("session required");
    error.code ||= "session_required";
    throw error;
  }
  return token;
}

/** Ask the server to read one already-stored original. No image or OCR JSON crosses this API. */
export async function requestStoredReceiptOcr(client, documentId, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("receipt OCR transport is unavailable");
  const token = await accessToken(client);
  let response;
  try {
    response = await fetchImpl("/api/receipt-ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documentId }),
    });
  } catch (cause) {
    cause.retryable = true;
    cause.outcomeKnown = false;
    throw cause;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || "receipt OCR request failed");
    Object.assign(error, {
      code: body?.code || `receipt_ocr_http_${response.status}`,
      retryable: body?.retryable === true || response.status >= 500 || response.status === 429,
      outcomeKnown: body?.outcomeKnown !== false,
      status: response.status,
      requestId: body?.requestId || null,
    });
    throw error;
  }
  return { ...body, extraction: extractionPreview(body.extraction) };
}

const extractionPreview = (value) => value && typeof value === "object" ? {
  ok: true,
  amount: value.grossAmount == null ? null : Number(value.grossAmount),
  orderAmount: value.orderAmount == null ? null : Number(value.orderAmount),
  fee: value.feeAmount == null ? null : Number(value.feeAmount),
  netAmount: value.netAmount == null ? null : Number(value.netAmount),
  currency: value.currency || null,
  refNo: value.refNo || null,
  merchantOrderNo: value.merchantOrderNo || null,
  receiver: value.payee || null,
  txDate: value.txDate || null,
  txTime: value.txTime || null,
  confidence: value.confidence == null ? null : Number(value.confidence),
  fieldConfidence: value.fieldConfidence || {},
  transactionStatus: value.transactionStatus || null,
  paymentMethod: value.paymentMethod || null,
  cardLast4: value.cardLast4 || null,
  sender: value.sender || null,
  recipientNote: value.recipientNote || null,
  merchantName: value.merchantName || null,
  platform: value.platform || null,
  platformEvidence: value.platformEvidence || null,
  validation: value.validation || null,
  ocrVersion: value.ocrVersion || null,
} : null;

/**
 * Claim, store, then request server-owned OCR for one image.
 *
 * `transactionId` is optional, and for the ordinary case it is absent. A customer-seller uploads
 * the screenshot of a transfer they have just made; the transaction is what the owner creates
 * *from* it afterwards. Requiring one first inverted the whole flow and made a new customer's
 * first upload impossible — they had no transaction, and could not get one without uploading.
 *
 * A partner uploading against a purchase assigned to them by name does pass one, and that is a
 * different case wearing the same function.
 *
 * Flow and currency are still not accepted: the server decides those. `customerId` is a staff
 * upload naming whose receipt this is, and the server checks it is a real, live customer —
 * a customer-seller's own upload ignores it entirely and is recorded against themselves.
 */
export async function intakeReceipt({
  client, blob, mediaType = "image/jpeg", transactionId, batchId = null,
  documentId = null, commandKey = null, adminOverrideReason = null, customerId = null,
  onStage = () => {}, fetchImpl = globalThis.fetch,
}) {
  const id = documentId || newId();
  // The document identity is already random. Binding the command key to it makes an upload
  // retry a replay of the same intent instead of a second command for the same evidence.
  const intentKey = commandKey || receiptIntakeCommandKey(transactionId, id);

  onStage(INTAKE_STAGE.claiming, { documentId: id });
  // v3, because v2's signature has no room to name the customer a staff upload is for. v2 still
  // exists and still answers; it simply forwards here now, so there is one set of rules rather
  // than two that can drift.
  const claim = await client.rpc("sarraf_receipt_intake_begin_v3", {
    p_document_id: id,
    p_transaction_id: transactionId || null,
    p_batch_id: batchId,
    p_mime_type: mediaType,
    p_command_key: intentKey,
    p_override_reason: adminOverrideReason,
    p_customer_id: customerId || null,
  });
  if (claim.error) throw new ReceiptIntakeError("claim", claim.error, false);
  const path = claim.data?.storage_path;
  if (!path) throw new ReceiptIntakeError("claim", new Error("no storage path returned"), false);

  onStage(INTAKE_STAGE.uploading, { documentId: id, storagePath: path });
  const upload = await client.storage.from("receipts").upload(path, blob, {
    contentType: mediaType,
    upsert: false,
  });
  // A replay of the exact command may find its immutable object already present.
  if (upload.error && !/already exists|duplicate|resource exists/i.test(String(upload.error.message || ""))) {
    // Say so where it can be read back. onStage is a callback inside this browser: it tells the
    // screen and nothing else. Until this line the database was never told, so the document sat
    // at `uploading` for ever, its batch kept waiting for an image that was never coming, and
    // the person who sent it was never told it had not arrived. The live database was carrying
    // five of these from August when it was first inspected.
    await noteReceiptUploadFailure(client, id, upload.error);
    onStage(INTAKE_STAGE.uploadFailed, { documentId: id, storagePath: path });
    throw new ReceiptIntakeError("upload", upload.error, false);
  }

  onStage(INTAKE_STAGE.stored, { documentId: id, storagePath: path });
  onStage(INTAKE_STAGE.reading, { documentId: id, storagePath: path });
  try {
    const result = await requestStoredReceiptOcr(client, id, { fetchImpl });
    onStage(INTAKE_STAGE.done, { documentId: id, state: result.state });
    return {
      documentId: id,
      transactionId,
      state: result.state,
      storagePath: path,
      extraction: result.extraction || null,
      replayed: result.replayed === true || claim.data?.replayed === true,
      commandKey: intentKey,
      evidenceKept: true,
    };
  } catch (cause) {
    // Say so where it can be read back. When the reading fails inside the reader the server
    // records an attempt row and a rule code; when it fails BEFORE the reader — no
    // configuration, no session, the object could not be downloaded — it records nothing at all,
    // and the database shows `uploading` with a null error for every one of them. The browser is
    // told the code in the response body every single time, and until now it kept it to itself.
    // Best effort: a diagnosis that cannot be written down must not also lose the receipt.
    await noteReceiptReadFailure(client, id, cause);
    onStage(INTAKE_STAGE.readFailed, { documentId: id, state: "stored_retryable" });
    return {
      documentId: id,
      transactionId,
      state: "stored_retryable",
      storagePath: path,
      extraction: null,
      readError: new ReceiptIntakeError("ocr", cause, true),
      commandKey: intentKey,
      evidenceKept: true,
    };
  }
}

/** Submit only durable document identities; the server decides each legal next state. */
// unreached-by-design: sarraf_receipt_submit is live — the accounting and business-flows gates
// both drive it — but the app submits receipts one at a time through the review path. This
// wrapper is the tested mapping to the batch form, kept for the screen that would use it.
export async function submitReceiptDocuments(client, documentIds, commandKey = null) {
  const ids = [...new Set((documentIds || []).filter(Boolean))];
  if (!ids.length) throw zemanRule("هیچ فیشێکی پارێزراو نییە بۆ ناردن");
  const { data, error } = await client.rpc("sarraf_receipt_submit", {
    p_document_ids: ids,
    p_command_key: commandKey || receiptSubmitCommandKey(),
  });
  if (error) throw error;
  return {
    submitted: Number(data?.submitted) || 0,
    manualReview: Number(data?.manual_review) || 0,
    replayed: data?.replayed === true,
  };
}

/**
 * Send a receipt in place of one that was refused.
 *
 * «لە بەرامبەر فیشە ڕەتکراوەکەدا دوگمەی «بارکردنەوەی فیشی نوێ» چالاک دەبێت ... بارکردنەوەی نوێ
 *   بەستەر (Link) دەکرێتەوە بە فیشە ڕەتکراوەکەی پێشوو»
 *
 * The upload itself is the ordinary one — same claim, same storage, same reading — and the link
 * is made afterwards, so a replacement that fails to link is still a receipt that arrived rather
 * than an image that was lost. The database refuses the link if the old one was never refused,
 * if it already has a replacement, or if the two belong to different businesses.
 */
export async function replaceReceipt(client, rejectedDocumentId, newDocumentId) {
  const { data, error } = await client.rpc("sarraf_receipt_replace", {
    p_rejected_document_id: rejectedDocumentId,
    p_new_document_id: newDocumentId,
  });
  if (error) throw error;
  return {
    replaced: data?.replaced || rejectedDocumentId,
    by: data?.by || newDocumentId,
    trackingCode: data?.tracking_code || null,
    replayed: data?.replayed === true,
  };
}

/**
 * An uploader's own receipts, their names, and what replaced what.
 *
 * `subjectId` names whose portal is being read. Left out, the server answers about the caller,
 * which is what a customer or partner signing in normally gets. An administrator previewing a
 * portal must pass the id of the person whose screen they are on — otherwise the server answers
 * about the administrator, and their own receipts appear inside somebody else's portal. The
 * server decides whether the caller may name that subject; this argument is a request, not a
 * grant.
 */
export async function loadMyReceipts(client, limit = 50, subjectId = null) {
  const { data, error } = await client.rpc("sarraf_my_receipt_intakes_v2",
    { p_limit: limit, p_subject_id: subjectId });
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id,
    trackingCode: r.tracking_code || null,
    state: r.state,
    flow: r.flow,
    receivedAt: r.received_at,
    ocrAttempts: r.ocr_attempts ?? 0,
    reason: r.rule_reason,
    replacedBy: r.replaced_by_document_id || null,
    replacedByTrackingCode: r.replaced_by_tracking_code || null,
    replaces: r.replaces_document_id || null,
  }));
}

/**
 * What a receipt's state means for the person who sent it, once the replacement chain is taken
 * into account. The specification names four: PENDING, APPROVED, REJECTED, REPLACED. REPLACED is
 * not stored — a stored copy of it could disagree with the link — it is what a refused receipt
 * becomes once something has been sent in its place.
 */
export function receiptOutcome(receipt) {
  if (receipt?.replacedBy) return "replaced";
  const state = receipt?.state;
  if (["accepted", "finalized", "forwarded", "delivered", "seen"].includes(state)) return "approved";
  if (["rejected", "duplicate", "currency_mismatch", "tamper_suspected", "failed_terminal"].includes(state)) {
    return "rejected";
  }
  return "pending";
}

/** Whether the uploader may send something in place of this one. */
export function mayBeReplaced(receipt) {
  return receiptOutcome(receipt) === "rejected" && !receipt?.replacedBy;
}

// loadMyIntakes was here, and it is gone on purpose.
//
// It called sarraf_my_receipt_intakes — the one-argument version that answers "what is MINE",
// based on whoever is signed in. That question is the View As defect itself: an administrator
// previewing a customer's portal was shown their own receipts, listed as that customer's.
// 202609010008 replaced it with sarraf_my_receipt_intakes_v2, which takes a SUBJECT and lets the
// server decide who may name one, and loadMyReceipts above is what every caller uses now.
//
// Nothing had called this since. Leaving a function in the codebase that asks the superseded
// question is an invitation to call it again, so the reachability rule in verify:source found it
// and it is deleted rather than kept "just in case".

/** Plain-language status for an uploader; never internal OCR detail or a false loss. */
export function intakeStatusText(state) {
  return {
    created: "ئامادەکردن…",
    uploading: "ناردنی وێنە…",
    stored_retryable: "وێنە پارێزراوە؛ خوێندنەوە دواتر دووبارە دەکرێتەوە",
    uploaded: "وێنە گەیشت ✓",
    ocr_pending: "وێنە گەیشت؛ خوێندنەوە چاوەڕوانە",
    ocr_processing: "دەخوێندرێتەوە…",
    ocr_failed_retryable: "وێنە گەیشت؛ خوێندنەوە دووبارە هەوڵ دەدرێتەوە",
    parsed: "خوێندرایەوە",
    needs_manual_review: "لە پشکنینی ئەدمین",
    currency_mismatch: "دراوەکە یەک ناگرێتەوە؛ لە پشکنیندایە",
    duplicate: "دووبارەیە",
    tamper_suspected: "گومانی دەستکاری؛ لە پشکنیندایە",
    validated: "پشتڕاستکرا",
    submitted: "نێردرا",
    matched: "بەستراوە",
    accepted: "پەسەندکرا ✓",
    rejected: "ڕەتکرایەوە",
    finalized: "تەواوکرا ✓",
    forwarded: "بۆ وەرگری دیاریکراو نێردرا",
    delivered: "گەیشت ✓",
    seen: "بینرا ✓",
    upload_failed_retryable: "وێنە نەگەیشت؛ دووبارە هەوڵ بدە",
    failed_terminal: "سەرکەوتوو نەبوو",
    cancelled: "هەڵوەشێنرایەوە",
  }[state] || state;
}
