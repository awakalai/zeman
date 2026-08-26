/**
 * Canonical, upload-first receipt intake.
 *
 * The browser is deliberately limited to a transaction id and image bytes. The database derives
 * the flow, customer, partner and expected currency from the transaction assignment, while the
 * server OCR route downloads and attests the stored original before recording any extraction.
 */

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
    this.retryable = Boolean(cause?.retryable || stage === "ocr");
    this.outcomeKnown = cause?.outcomeKnown !== false;
  }
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
 * Flow, parties and currency are still not accepted: the server decides those.
 */
export async function intakeReceipt({
  client, blob, mediaType = "image/jpeg", transactionId, batchId = null,
  documentId = null, commandKey = null, adminOverrideReason = null,
  onStage = () => {}, fetchImpl = globalThis.fetch,
}) {
  const id = documentId || newId();
  // The document identity is already random. Binding the command key to it makes an upload
  // retry a replay of the same intent instead of a second command for the same evidence.
  const intentKey = commandKey || receiptIntakeCommandKey(transactionId, id);

  onStage(INTAKE_STAGE.claiming, { documentId: id });
  const claim = await client.rpc("sarraf_receipt_intake_begin_v2", {
    p_document_id: id,
    p_transaction_id: transactionId || null,
    p_batch_id: batchId,
    p_mime_type: mediaType,
    p_command_key: intentKey,
    p_override_reason: adminOverrideReason,
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
export async function submitReceiptDocuments(client, documentIds, commandKey = null) {
  const ids = [...new Set((documentIds || []).filter(Boolean))];
  if (!ids.length) throw new Error("هیچ فیشێکی پارێزراو نییە بۆ ناردن");
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

/** An uploader's own receipts and where each one has got to. */
export async function loadMyIntakes(client, limit = 50) {
  const { data, error } = await client.rpc("sarraf_my_receipt_intakes", { p_limit: limit });
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id,
    state: r.state,
    flow: r.flow,
    receivedAt: r.received_at,
    ocrAttempts: r.ocr_attempts ?? 0,
    reason: r.rule_reason,
  }));
}

/** Plain-language status for an uploader; never internal OCR detail or a false loss. */
export function intakeStatusText(state) {
  return {
    created: "ئامادەکردن...",
    uploading: "ناردنی وێنە...",
    stored_retryable: "وێنە پارێزراوە؛ خوێندنەوە دواتر دووبارە دەکرێتەوە",
    uploaded: "وێنە گەیشت ✓",
    ocr_pending: "وێنە گەیشت؛ خوێندنەوە چاوەڕوانە",
    ocr_processing: "دەخوێندرێتەوە...",
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
