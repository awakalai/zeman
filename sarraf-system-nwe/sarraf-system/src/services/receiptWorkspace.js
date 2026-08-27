/**
 * Admin receipt review (§11.12, §11.13).
 *
 * Reads the durable intake introduced in phase 4: the document, every version of its
 * extraction, and its state history. The original reading is never overwritten — a correction
 * is a new version — so the workspace can always show what the OCR actually said alongside
 * what a human decided it meant.
 */

const upper = (v) => String(v ?? "").trim().toUpperCase();
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const commandId = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const reviewCommandKey = (action, documentId) =>
  `receipt-review:${String(action).slice(0, 16)}:${String(documentId).slice(0, 70)}:${commandId()}`;
export const rateCommandKey = (currency, effectiveDate) =>
  `receipt-rate:${upper(currency).slice(0, 8)}:${String(effectiveDate).slice(0, 10)}:${commandId()}`;
export const finalizeCommandKey = (documentId) =>
  `receipt-finalize:${String(documentId).slice(0, 70)}:${commandId()}`;

export const RECEIPT_REVIEW_STATES = [
  "needs_manual_review", "parsed", "validated", "submitted",
  "duplicate", "currency_mismatch", "tamper_suspected", "accepted",
];

export async function loadReviewQueue(client, { states = RECEIPT_REVIEW_STATES, limit = 100 } = {}) {
  const { data, error } = await client
    .from("receipt_documents")
    .select("*")
    .in("state", states)
    .order("received_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(mapDocument);
}

const mapDocument = (d) => ({
  id: d.id,
  flow: d.flow,
  state: d.state,
  batchId: d.batch_id,
  transactionId: d.transaction_id,
  uploaderId: d.uploader_id,
  customerId: d.customer_id,
  partnerId: d.partner_id,
  storagePath: d.storage_path,
  imageHash: d.image_sha256,
  expectedCurrency: d.expected_currency,
  receivedAt: d.received_at,
  ocrAttempts: d.ocr_attempts ?? 0,
  lastErrorCode: d.last_error_code,
  counted: !!d.counted,
  ruleCode: d.rule_code,
  ruleReason: d.rule_reason,
  // The name the person who sent it can read out, and both ends of the replacement chain. A
  // reviewer looking at a replacement with none of this sees an unexplained second receipt for
  // money that was already refused once — which is the exact hole the chain was added to close.
  trackingCode: d.tracking_code || null,
  replacesDocumentId: d.replaces_document_id || null,
  replacedByDocumentId: d.replaced_by_document_id || null,
  replacementLinkedBy: d.replacement_linked_by || null,
  replacementLinkedAt: d.replacement_linked_at || null,
});

/**
 * The receipt this one was sent in place of, and what became of it.
 *
 * Read separately rather than joined, because the reviewer needs the OLD receipt's refusal
 * reason — the reason this replacement exists — and that lives on a row the detail query never
 * fetches. Returns null when there is no chain, which is the ordinary case.
 */
export async function loadReplacementChain(client, doc) {
  const wanted = [doc?.replacesDocumentId, doc?.replacedByDocumentId].filter(Boolean);
  if (!wanted.length) return null;
  const { data, error } = await client
    .from("receipt_documents")
    .select("id,tracking_code,state,rule_code,rule_reason,received_at")
    .in("id", wanted);
  if (error) throw error;
  const by = Object.fromEntries((data || []).map((r) => [r.id, {
    id: r.id,
    trackingCode: r.tracking_code || null,
    state: r.state,
    ruleCode: r.rule_code || null,
    ruleReason: r.rule_reason || null,
    receivedAt: r.received_at,
  }]));
  return {
    replaces: doc.replacesDocumentId ? by[doc.replacesDocumentId] || { id: doc.replacesDocumentId } : null,
    replacedBy: doc.replacedByDocumentId ? by[doc.replacedByDocumentId] || { id: doc.replacedByDocumentId } : null,
  };
}

export async function loadDocumentDetail(client, documentId) {
  const [doc, extractions, transitions, summary] = await Promise.all([
    client.from("receipt_documents").select("*").eq("id", documentId).maybeSingle(),
    client.from("receipt_extractions").select("*").eq("document_id", documentId).order("version"),
    client.from("receipt_state_transitions").select("*").eq("document_id", documentId).order("created_at"),
    client.rpc("sarraf_receipt_summary", { p_document_id: documentId }),
  ]);
  if (doc.error) throw doc.error;
  if (extractions.error) throw extractions.error;
  if (transitions.error) throw transitions.error;
  if (summary.error) throw summary.error;
  if (!doc.data) throw new Error("receipt document not found");

  const versions = (extractions.data || []).map((e) => ({
    version: e.version,
    isOriginal: !!e.is_original,
    provider: e.provider,
    model: e.model,
    grossAmount: num(e.gross_amount),
    orderAmount: num(e.order_amount),
    feeAmount: num(e.fee_amount),
    feeTreatment: e.fee_treatment,
    netAmount: num(e.net_amount),
    currency: e.currency,
    refNo: e.ref_no,
    merchantOrderNo: e.merchant_order_no,
    payee: e.payee,
    platform: e.platform || e.raw?.platform || null,
    hasFee: e.has_fee == null
      ? (e.fee_amount == null ? null : Number(e.fee_amount) > 0)
      : e.has_fee === true,
    txDate: e.tx_date,
    txTime: e.tx_time,
    confidence: num(e.confidence),
    correctedBy: e.corrected_by,
    correctionReason: e.correction_reason,
    correctedAt: e.corrected_at,
    raw: e.raw || {},
  }));

  return {
    document: mapDocument(doc.data),
    original: versions.find((v) => v.isOriginal) || versions[0] || null,
    current: versions[versions.length - 1] || null,
    versions,
    summary: mapSummary(summary.data),
    history: (transitions.data || []).map((t) => ({
      from: t.from_state, to: t.to_state, actorId: t.actor_id,
      reason: t.reason, at: t.created_at,
    })),
  };
}

const mapSummary = (s) => s ? ({
  documentId: s.document_id,
  transactionId: s.transaction_id,
  flow: s.flow,
  state: s.state,
  counted: s.counted === true,
  currency: s.currency,
  businessDate: s.business_date,
  rateValue: num(s.rate_value),
  rateConvention: s.rate_convention,
  rateDate: s.rate_date,
  rateVersion: s.rate_version == null ? null : Number(s.rate_version),
  rateKind: s.rate_kind,
  rateCapturedAt: s.rate_captured_at,
  availableRateValue: num(s.available_rate_value),
  availableRateVersion: s.available_rate_version == null ? null : Number(s.available_rate_version),
  grossUsd: num(s.gross_usd),
  feeUsd: num(s.fee_usd),
  netUsd: num(s.net_usd),
  valuationStatus: s.valuation_status,
  summaryVersion: s.summary_version == null ? null : Number(s.summary_version),
}) : null;

export async function loadReceiptSummary(client, documentId) {
  const { data, error } = await client.rpc("sarraf_receipt_summary", { p_document_id: documentId });
  if (error) throw error;
  return mapSummary(data);
}

/** Create a versioned daily rate. The immutable convention is always 1 USD = X currency. */
export async function setReceiptDailyRate(client, {
  currency, effectiveDate, rate, reason, commandKey,
}) {
  const code = upper(currency);
  const day = String(effectiveDate ?? "").trim();
  const value = Number(rate);
  const why = String(reason ?? "").normalize("NFKC").trim();
  if (!/^[A-Z]{3,8}$/.test(code)) throw new Error("دراوی نرخ دروست نییە");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("بەرواری کاری نرخ دروست نییە");
  if (!Number.isFinite(value) || value <= 0) throw new Error("نرخ دەبێت ژمارەیەکی گەورەتر لە سفر بێت");
  if (why.length < 8) throw new Error("هۆکاری دانانی نرخ دەبێت لانیکەم ٨ پیت بێت");
  const { data, error } = await client.rpc("sarraf_set_receipt_daily_rate", {
    p_currency: code,
    p_effective_date: day,
    p_rate: value,
    p_reason: why.slice(0, 700),
    p_command_key: commandKey || rateCommandKey(code, day),
  });
  if (error) throw error;
  return data;
}

/** Freeze the latest rate for this receipt. The server derives its business date and currency. */
export async function finalizeReceipt(client, { documentId, reason, commandKey }) {
  const why = String(reason ?? "").normalize("NFKC").trim();
  if (!documentId) throw new Error("فیش هەڵنەبژێردراوە");
  if (why.length < 8) throw new Error("هۆکاری کۆتایی‌کردن دەبێت لانیکەم ٨ پیت بێت");
  const { data, error } = await client.rpc("sarraf_receipt_finalize_command", {
    p_document_id: documentId,
    p_reason: why.slice(0, 700),
    p_command_key: commandKey || finalizeCommandKey(documentId),
  });
  if (error) throw error;
  return data;
}

/**
 * What a correction changed, field by field, so a reviewer sees the difference rather than
 * having to compare two blocks of numbers by eye.
 */
export function diffVersions(before, after) {
  if (!before || !after) return [];
  const fields = [
    ["grossAmount", "کۆی گشتی"], ["orderAmount", "بڕی بنەڕەتی"], ["feeAmount", "فی"],
    ["feeTreatment", "شێوازی فی"], ["netAmount", "نەت"], ["currency", "دراو"],
    ["refNo", "ژمارەی مامەڵە"], ["merchantOrderNo", "ژمارەی فرۆشیار"],
    ["payee", "وەرگر"], ["platform", "پلاتفۆرم"], ["hasFee", "دۆخی فی"],
    ["txDate", "بەروار"], ["txTime", "کات"],
  ];
  return fields
    .filter(([k]) => String(before[k] ?? "") !== String(after[k] ?? ""))
    .map(([k, label]) => ({ field: k, label, before: before[k] ?? null, after: after[k] ?? null }));
}

/**
 * The arithmetic a reviewer must be able to see at a glance, computed from the receipt's own
 * fee treatment rather than assumed. Returns null where the receipt does not state enough.
 */
export function reviewEquation(v) {
  if (!v) return null;
  const gross = v.grossAmount, order = v.orderAmount, fee = v.feeAmount ?? 0;
  const treatment = v.feeTreatment || "unknown";
  const minor = (x) => (x == null ? null : Math.round(x * 100));

  let expectedGross = null;
  if (order != null) {
    if (treatment === "added_on_top") expectedGross = order + fee;
    else if (treatment === "included_in_total") expectedGross = order;
    else if (treatment === "deducted_from_principal") expectedGross = order;
    else if (treatment === "no_fee") expectedGross = order;
    else {
      // An order amount, and no word for the fee. Both readings are real receipts; whichever the
      // gross matches is the one the receipt is stating.
      const onTop = minor(order + fee), inside = minor(order), g0 = minor(gross);
      if (g0 != null && onTop != null && Math.abs(g0 - onTop) <= 1) expectedGross = order + fee;
      else if (g0 != null && inside != null && Math.abs(g0 - inside) <= 1) expectedGross = order;
    }
  }

  const g = minor(gross), e = minor(expectedGross);
  const net = v.netAmount, n = minor(net), f = minor(fee);

  // A receipt that prints no order amount — the ordinary Alipay layout — makes exactly one
  // arithmetic claim: gross − fee = net. Reading that as "cannot be decided" told the reviewer
  // the screen could not tell, on a receipt whose money adds up to the cent, and then the
  // database accepted it anyway. The screen and the rule now say the same thing.
  const byNet = order != null || g == null || n == null || f == null
    ? null
    : Math.abs(g - f - n) <= 1;

  return {
    treatment,
    gross, order, fee,
    net,
    expectedGross,
    // Which statement was checked, so the screen can say it in words rather than only in green.
    basis: order != null ? "order" : byNet == null ? null : "net",
    // One minor unit of tolerance; the comparison is in integers, never floats.
    reconciles: order != null
      ? (g == null || e == null ? null : Math.abs(g - e) <= 1)
      : byNet,
    currency: upper(v.currency) || null,
  };
}

/** Run one bounded, MFA-protected review decision; direct table updates are never used. */
export async function transitionDocument(client, { documentId, toState, reason, commandKey }) {
  const action = ({ accepted: "accept", validated: "accept", rejected: "reject", needs_manual_review: "reopen" })[toState];
  if (!action) throw new Error("بڕیاری پشکنین ناسراو نییە");
  const why = String(reason ?? "").normalize("NFKC").trim();
  if (why.length < 8) throw new Error("بڕیارەکە پێویستی بە هۆکارێکی لانیکەم ٨ پیتی هەیە");
  const { data, error } = await client.rpc("sarraf_receipt_review_command", {
    p_document_id: documentId,
    p_action: action,
    p_changes: {},
    p_reason: why.slice(0, 700),
    p_command_key: commandKey || reviewCommandKey(action, documentId),
  });
  if (error) throw error;
  return data;
}

/**
 * Record a correction as a NEW extraction version. The original stays readable; the database
 * refuses an in-place edit and refuses a correction with no author or reason.
 */
export async function correctExtraction(client, { documentId, base, changes, reason, commandKey }) {
  const why = String(reason ?? "").normalize("NFKC").trim();
  if (why.length < 8) throw new Error("هۆکاری ڕاستکردنەوە دەبێت لانیکەم ٨ پیت بێت");
  if (!base) throw new Error("وەشانی بنەڕەتی نەدۆزرایەوە");
  if (!changes || Object.keys(changes).length === 0) throw new Error("هیچ گۆڕانکارییەک نییە");

  const allowed = new Set([
    "grossAmount", "orderAmount", "feeAmount", "feeTreatment", "netAmount", "currency",
    "refNo", "merchantOrderNo", "payee", "platform", "txDate", "txTime",
  ]);
  if (Object.keys(changes).some((key) => !allowed.has(key))) throw new Error("خانەی ڕاستکردنەوە ناسراو نییە");
  const { data, error } = await client.rpc("sarraf_receipt_review_command", {
    p_document_id: documentId,
    p_action: "correct",
    p_changes: changes,
    p_reason: why.slice(0, 700),
    p_command_key: commandKey || reviewCommandKey("correct", documentId),
  });
  if (error) throw error;
  return data;
}

/**
 * How the review queue stands (§11.13): how many are accepted, waiting, rejected, duplicate.
 *
 * Counts of documents — never money. §4.14 puts the totals of a batch in exactly one place, the
 * server's `sarraf_batch_summary`, so that the reviewer and the person who sent the receipts
 * cannot be shown two different answers. This function used to add up amounts per currency as
 * well; that made a second, browser-side set of figures which nothing displayed and which would
 * one day have been displayed. It is gone, and the count of accepted documents per currency
 * stays only so the footer can say what the queue holds.
 */
export function reviewTotals(documents, extractionByDoc = {}) {
  const out = { accepted: 0, pending: 0, rejected: 0, duplicate: 0, byCurrency: {} };
  for (const d of documents || []) {
    if (d.state === "rejected") { out.rejected += 1; continue; }
    if (d.state === "duplicate") { out.duplicate += 1; continue; }
    const counted = d.counted || ["accepted", "finalized", "forwarded", "delivered", "seen"].includes(d.state);
    if (!counted) { out.pending += 1; continue; }
    out.accepted += 1;
    const cur = upper(extractionByDoc[d.id]?.currency);
    if (!cur) continue;
    out.byCurrency[cur] = { count: (out.byCurrency[cur]?.count || 0) + 1 };
  }
  return out;
}
