// api/read-receipt.js
// Receipt OCR v5 — structured multimodal extraction for Sarraf.
// Uses Groq Qwen Vision as primary, with Gemini, Google Vision and Claude fallbacks.
// No Supabase writes happen in this endpoint.

import { createHash, randomUUID } from "node:crypto";
import { callGoogleVision } from "./_google-vision-receipt.js";
import { limitSubject, refuseIfOverLimit } from "./_rate-limit.js";

// One image a second, sustained, is far more than a person reading receipts off a phone and far
// less than a script working through a stolen session.
const OCR_LIMIT = Number(process.env.OCR_RATE_LIMIT || 60);
const OCR_WINDOW_SECONDS = Number(process.env.OCR_RATE_WINDOW || 60);

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/**
 * The canonical shape of a reading, matching public.sarraf_extraction_digest exactly.
 *
 * The database recomputes this from the figures actually submitted with the batch. If they were
 * altered between here and there, the two digests differ and the batch is refused — which is
 * what makes "the uploader cannot change what the reader read" a rule rather than a screen.
 *
 * Amounts are normalised the way PostgreSQL's trim_scale does, so 1200, 1200.0 and "1200.00" are
 * one number. Text is trimmed and never case-folded: a payee's name is part of the reading.
 */
function extractionDigest(fields) {
  const amount = (v) => {
    if (v === null || v === undefined || v === "") return "";
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    // Matches numeric::text after trim_scale: no exponent, no trailing zeros, no bare dot.
    let s = n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
    if (s === "-0") s = "0";
    return s;
  };
  const text = (v) => String(v ?? "").trim();
  return sha256Hex([
    amount(fields.amount),
    amount(fields.fee),
    amount(fields.net_amount),
    text(fields.currency).toUpperCase(),
    text(fields.ref_no),
    text(fields.merchant_order_no),
    text(fields.tx_date),
    text(fields.receiver),
    text(fields.sender),
  ].join("|"));
}

/**
 * Record what this reader read, so the ingestion command can tell whether the figures it is
 * given are the ones that came off the image. The browser never sees a secret and cannot write
 * one of these rows; the function is unreachable from a signed-in session.
 */
async function attestReading({ url, key, nonce, profileId, imageSha256, fields, provider, model }) {
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/sarraf_record_ocr_attestation`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_nonce: nonce, p_issued_to: profileId, p_image_sha256: imageSha256,
        p_extraction: fields, p_provider: provider || null, p_model: model || null,
        p_ttl_seconds: 3600,
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // A reading that could not be attested is still a reading. It arrives unattested and the
    // ingestion command treats it according to the receipt policy, rather than the customer
    // losing their upload because a side table was unreachable.
    return null;
  }
}

const MAX_BASE64_CHARS = 3_500_000;
const RETRYABLE = new Set([502, 503, 504]);

const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    amount: { type: ["number", "null"] },
    fee: { type: ["number", "null"] },
    feeOriginal: { type: ["number", "null"] },
    feeDiscount: { type: ["number", "null"] },
    netAmount: { type: ["number", "null"] },
    orderAmount: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    paymentMethod: { type: ["string", "null"] },
    cardLast4: { type: ["string", "null"] },
    transactionStatus: { type: ["string", "null"] },
    recipientNote: { type: ["string", "null"] },
    merchantName: { type: ["string", "null"] },
    platformEvidence: { type: ["string", "null"] },
    sender: { type: ["string", "null"] },
    receiver: { type: ["string", "null"] },
    refNo: { type: ["string", "null"] },
    merchantOrderNo: { type: ["string", "null"] },
    txTime: { type: ["string", "null"] },
    txDate: { type: ["string", "null"] },
    bank: { type: ["string", "null"] },
    platform: { type: ["string", "null"] },
    kind: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    fieldConfidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        amount: { type: "number", minimum: 0, maximum: 1 },
        fee: { type: "number", minimum: 0, maximum: 1 },
        orderAmount: { type: "number", minimum: 0, maximum: 1 },
        currency: { type: "number", minimum: 0, maximum: 1 },
        paymentMethod: { type: "number", minimum: 0, maximum: 1 },
        transactionStatus: { type: "number", minimum: 0, maximum: 1 },
        sender: { type: "number", minimum: 0, maximum: 1 },
        receiver: { type: "number", minimum: 0, maximum: 1 },
        refNo: { type: "number", minimum: 0, maximum: 1 },
        merchantOrderNo: { type: "number", minimum: 0, maximum: 1 },
        txDate: { type: "number", minimum: 0, maximum: 1 },
        txTime: { type: "number", minimum: 0, maximum: 1 },
        platform: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["amount", "fee", "orderAmount", "currency", "paymentMethod", "transactionStatus", "sender", "receiver", "refNo", "merchantOrderNo", "txDate", "txTime", "platform"]
    },
    note: { type: ["string", "null"] }
  },
  required: [
    "ok", "amount", "fee", "feeOriginal", "feeDiscount", "netAmount", "orderAmount",
    "currency", "paymentMethod", "cardLast4", "transactionStatus", "recipientNote", "merchantName", "platformEvidence",
    "sender", "receiver", "refNo", "merchantOrderNo", "txTime", "txDate",
    "bank", "platform", "kind", "confidence", "fieldConfidence", "note"
  ]
};

const SYSTEM = `You extract payment-receipt data for an Iraqi/Kurdish currency-exchange system.

The image may come from FIB, FastPay, ZainCash, NassWallet, Qi Card, a bank app, Alipay, WeChat Pay, or another transfer/payment service.

GENERAL ACCURACY RULES:
1. Never invent a value. If a field is not visible or not reliable, return null and lower that field's confidence.
2. amount = the TOTAL transaction debit/charge shown as the main transaction amount. If the UI shows it with a leading minus sign because it is an outgoing card charge, keep the visible sign in extraction; server normalization will preserve the source sign for audit and convert the accounting magnitude to positive. Do NOT use account balance, wallet balance, available balance, exchange rate, or unrelated numbers.
3. orderAmount = the underlying purchase/transfer amount BEFORE card fee when the receipt explicitly shows such a field. If not explicitly shown, return null.
4. fee = final fee actually charged. feeOriginal = fee before discount. feeDiscount = discount amount.
5. netAmount = the underlying amount received/purchased when explicitly shown. If orderAmount is explicitly shown, netAmount should normally equal orderAmount. Otherwise amount - fee is allowed only when that interpretation is valid.
6. refNo = the primary transaction/order/reference/trace/operation ID. Preserve ALL letters/digits and concatenate a visually wrapped ID without spaces/newlines.
7. merchantOrderNo is ONLY for a separately labelled merchant order ID. Do not copy refNo into merchantOrderNo.
8. Normalize Arabic/Persian/Kurdish digits to Latin digits.
9. Currency should be an uppercase ISO-style code when identifiable (IQD, USD, CNY, EUR, TRY, AED, SAR, etc.).
10. paymentMethod = Visa, Mastercard, card, wallet, cash, etc. cardLast4 = only the visible last 4 card digits.
11. transactionStatus = visible status such as Payment successful / Successful / Completed / Failed. Do not infer success only from color.
12. recipientNote = a field explicitly labelled recipient note / 收款方备注 / similar. It is NOT automatically a receiver name.
13. merchantName = merchant/display name when clearly visible. receiver = actual payee/recipient person/entity only when the receipt clearly identifies it.
14. txDate must be YYYY-MM-DD when recoverable. txTime should preserve HH:MM:SS when visible.
15. platform MUST be canonical when confidently identifiable: Alipay, WeChat, FIB, FastPay, ZainCash, NassWallet, QiCard, Bank. Do not classify by language, amount, or color alone.
16. platformEvidence = a SHORT list of visible labels/brand clues that justify platform classification, max ~120 chars. If evidence is weak, platform must be null and platform confidence low.
17. If the image is not a payment/transfer receipt, set ok=false.
18. If the image may be edited/tampered, mention that in note and reduce confidence.
19. confidence is overall confidence. fieldConfidence is separate confidence for each extracted field.
20. Preserve decimal cents/fen exactly as shown. Example: 1,262.78 must remain 1262.78, never 1263.

ALIPAY RULES — use only when the visible receipt matches Alipay:
21. Strong Alipay clues include the tested layout containing labels such as "Transaction Details", "International Card Fee", "Payment time", "Payment method", "Full name of payee", "Order No.", and "Merchant order No." together.
22. When "Full name of payee" is visible, receiver MUST come from that field. Do not combine it with the top merchant/display name.
23. refNo MUST come from "Order No." when visible.
24. merchantOrderNo MUST come from "Merchant order No." when visible. Never swap these two IDs.
25. paymentMethod/cardLast4 come from values such as Visa(1584) or Mastercard(4166).
26. The large negative top amount is the gross charged amount. "International Card Fee" is fee. If no explicit orderAmount is visible, orderAmount may be null and netAmount may be amount-fee.
27. "Transaction successful" should map to transactionStatus="Payment successful" or equivalent canonical success text.

WECHAT PAY RULES — use only when the visible receipt matches WeChat Pay:
28. Strong WeChat clues in the tested receipt include the transaction-history layout plus labels such as 订单金额 (Order amount), 国际卡手续费 (International card handling fee), Current Status, Recipient Note, Payment Method, Transfer Time, and Transfer Order No.
29. On this WeChat layout:
    - the large negative top number is amount (gross charged),
    - 订单金额 / Order amount is orderAmount,
    - 国际卡手续费 / International card handling fee is fee,
    - netAmount = orderAmount when explicitly shown.
30. Validate when all values are visible: amount should approximately equal orderAmount + fee. If it does not, keep the visible numbers but lower confidence and explain in note.
31. refNo MUST come from "Transfer Order No." / transfer order number. If the ID wraps onto another line, concatenate every visible digit in order with NO spaces/newlines.
32. "Recipient Note" / 收款方备注 such as 二维码收款 is recipientNote, NOT receiver. If no recipient person/entity is shown, receiver must be null.
33. paymentMethod/cardLast4 come from values such as VISA(0233).
34. "Payment successful" is transactionStatus.
35. merchantOrderNo must be null unless a separate merchant-order field is explicitly visible.

Return only data matching the JSON schema.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const retryAfterSecondsFrom = (response, json) => {
  const header = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;
  const details = json?.error?.details || [];
  for (const d of details) {
    const raw = d?.retryDelay || d?.retry_delay;
    const m = String(raw || "").match(/([0-9]+(?:\.[0-9]+)?)s/i);
    if (m) return Math.ceil(Number(m[1]));
  }
  return null;
};

const toLatinDigits = (value) => String(value ?? "")
  .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));

const cleanText = (v) => {
  if (v == null) return null;
  const s = toLatinDigits(v).trim();
  return s && !/^(null|unknown|نەزانراو)$/i.test(s) ? s : null;
};

const numberOrNull = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = toLatinDigits(v)
    .replace(/[,\s٬،]/g, "")
    .replace(/[^\d.+-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const clamp01 = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};

function normalizeResult(parsed) {
  const ok = parsed?.ok !== false;

  // Receipt UIs often render outgoing card charges with a leading minus sign.
  // Financial amount fields in Sarraf are magnitudes; preserve the original sign
  // separately for audit instead of letting "-2442.00" become an invalid amount.
  const sourceSignedAmount = numberOrNull(parsed?.amount);
  const amount = sourceSignedAmount == null ? null : Math.abs(sourceSignedAmount);

  let fee = numberOrNull(parsed?.fee);
  let feeOriginal = numberOrNull(parsed?.feeOriginal);
  let feeDiscount = numberOrNull(parsed?.feeDiscount);
  let netAmount = numberOrNull(parsed?.netAmount);
  let orderAmount = numberOrNull(parsed?.orderAmount);

  if (fee != null) fee = Math.abs(fee);
  if (feeOriginal != null) feeOriginal = Math.abs(feeOriginal);
  if (feeDiscount != null) feeDiscount = Math.abs(feeDiscount);
  if (netAmount != null) netAmount = Math.abs(netAmount);
  if (orderAmount != null) orderAmount = Math.abs(orderAmount);

  if (fee == null) fee = 0;
  if (feeOriginal == null) feeOriginal = fee;
  if (feeDiscount == null) feeDiscount = Math.max(0, feeOriginal - fee);
  if (netAmount == null && orderAmount != null) netAmount = orderAmount;
  if (netAmount == null && amount != null) netAmount = Math.max(0, amount - fee);

  let currency = cleanText(parsed?.currency);
  if (currency) currency = currency.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) || null;

  let txDate = cleanText(parsed?.txDate);
  if (txDate && !/^\d{4}-\d{2}-\d{2}$/.test(txDate)) txDate = null;

  const paymentMethod = cleanText(parsed?.paymentMethod);
  let cardLast4 = cleanText(parsed?.cardLast4);
  if (!cardLast4 && paymentMethod) {
    const m = paymentMethod.match(/(?:\(|\b)(\d{4})(?:\)|\b)/);
    if (m) cardLast4 = m[1];
  }
  if (cardLast4) {
    const digits = cardLast4.replace(/\D/g, "");
    cardLast4 = digits.length >= 4 ? digits.slice(-4) : null;
  }

  const platformRaw = cleanText(parsed?.platform);
  const bankRaw = cleanText(parsed?.bank);
  const evidenceRaw = cleanText(parsed?.platformEvidence);
  const platformHay = `${platformRaw || ""} ${bankRaw || ""} ${evidenceRaw || ""}`.toLowerCase();
  let platform = platformRaw;
  if (/alipay|支付宝/.test(platformHay)) platform = "Alipay";
  else if (/wechat|weixin|微信/.test(platformHay)) platform = "WeChat";
  else if (/\bfib\b/.test(platformHay)) platform = "FIB";
  else if (/fastpay/.test(platformHay)) platform = "FastPay";
  else if (/zain/.test(platformHay)) platform = "ZainCash";
  else if (/nass/.test(platformHay)) platform = "NassWallet";
  else if (/qi\s*card|qicard/.test(platformHay)) platform = "QiCard";
  else if (/bank|بانک|مصرف/.test(platformHay)) platform = "Bank";

  const fcIn = parsed?.fieldConfidence || {};
  const fieldConfidence = {
    amount: clamp01(fcIn.amount, amount != null ? 0.7 : 0),
    fee: clamp01(fcIn.fee, 0.7),
    orderAmount: clamp01(fcIn.orderAmount, orderAmount != null ? 0.7 : 0),
    currency: clamp01(fcIn.currency, currency ? 0.7 : 0),
    paymentMethod: clamp01(fcIn.paymentMethod, paymentMethod ? 0.6 : 0),
    transactionStatus: clamp01(fcIn.transactionStatus, parsed?.transactionStatus ? 0.6 : 0),
    sender: clamp01(fcIn.sender, 0.5),
    receiver: clamp01(fcIn.receiver, 0.5),
    refNo: clamp01(fcIn.refNo, parsed?.refNo ? 0.6 : 0),
    merchantOrderNo: clamp01(fcIn.merchantOrderNo, parsed?.merchantOrderNo ? 0.6 : 0),
    txDate: clamp01(fcIn.txDate, txDate ? 0.6 : 0),
    txTime: clamp01(fcIn.txTime, parsed?.txTime ? 0.6 : 0),
    platform: clamp01(fcIn.platform, platform ? 0.6 : 0),
  };

  let confidence = clamp01(parsed?.confidence, ok ? 0.5 : 0.2);
  let note = cleanText(parsed?.note);
  let validation = null;

  // Deterministic WeChat accounting validation from the tested layout:
  // gross charge ≈ order amount + card fee.
  if (platform === "WeChat" && amount != null && orderAmount != null && fee != null) {
    const expectedGross = orderAmount + fee;
    const delta = Math.abs(amount - expectedGross);
    const tolerance = Math.max(0.02, amount * 0.00005);
    const grossMatches = delta <= tolerance;

    validation = {
      type: "wechat_gross_equation",
      checked: true,
      grossMatches,
      expectedGross,
      delta,
      tolerance,
    };

    if (!grossMatches) {
      confidence = Math.min(confidence, 0.64);
      fieldConfidence.amount = Math.min(fieldConfidence.amount, 0.65);
      fieldConfidence.orderAmount = Math.min(fieldConfidence.orderAmount, 0.65);
      fieldConfidence.fee = Math.min(fieldConfidence.fee, 0.65);
      const msg = `WeChat validation mismatch: gross ${amount} != order ${orderAmount} + fee ${fee}`;
      note = note ? `${note} · ${msg}` : msg;
    }
  }

  return {
    ok,
    amount,
    sourceSignedAmount,
    sourceAmountDirection: sourceSignedAmount == null ? null : (sourceSignedAmount < 0 ? "debit" : sourceSignedAmount > 0 ? "credit" : "zero"),
    fee,
    feeOriginal,
    feeDiscount,
    netAmount,
    orderAmount,
    currency,
    paymentMethod,
    cardLast4,
    transactionStatus: cleanText(parsed?.transactionStatus),
    recipientNote: cleanText(parsed?.recipientNote),
    merchantName: cleanText(parsed?.merchantName),
    platformEvidence: evidenceRaw ? evidenceRaw.slice(0, 160) : null,
    sender: cleanText(parsed?.sender),
    receiver: cleanText(parsed?.receiver),
    refNo: cleanText(parsed?.refNo),
    merchantOrderNo: cleanText(parsed?.merchantOrderNo),
    txTime: cleanText(parsed?.txTime),
    txDate,
    bank: bankRaw,
    platform,
    kind: cleanText(parsed?.kind),
    confidence,
    fieldConfidence,
    validation,
    note,
  };
}

function extractText(json) {
  return (json?.candidates?.[0]?.content?.parts || [])
    .map((p) => p?.text || "")
    .join("")
    .trim();
}


const parseJsonObject = (raw, provider = "OCR") => {
  const text = String(raw || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!text) {
    const e = new Error(`${provider}: empty JSON response`);
    e.status = 502;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error(`${provider}: invalid JSON response`);
    e.status = 502;
    throw e;
  }
};

const receiptShapePrompt = (currentDate) => `Read this payment receipt. Current date: ${currentDate}.
Return ONE JSON object only with exactly these fields:
ok, amount, fee, feeOriginal, feeDiscount, netAmount, orderAmount, currency,
paymentMethod, cardLast4, transactionStatus, recipientNote, merchantName, platformEvidence,
sender, receiver, refNo, merchantOrderNo, txTime, txDate, bank, platform, kind, confidence,
fieldConfidence, note.
fieldConfidence must contain: amount, fee, orderAmount, currency, paymentMethod, transactionStatus,
sender, receiver, refNo, merchantOrderNo, txDate, txTime, platform.
Use null when a value is not visible/reliable. Confidence values must be 0..1.
Follow all system accuracy rules exactly.`;

async function callGroq(key, image, mediaType, currentDate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const started = Date.now();
  const model = process.env.GROQ_MODEL || "qwen/qwen3.6-27b";

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: receiptShapePrompt(currentDate) },
              {
                type: "image_url",
                image_url: { url: `data:${mediaType};base64,${image}` },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "none",
        temperature: 0.2,
        max_completion_tokens: 900,
        stream: false,
      }),
      signal: controller.signal,
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) {
      const e = new Error(`Groq: ${j?.error?.message || `HTTP ${r.status}`}`);
      e.status = r.status || j?.error?.code || 500;
      e.retryAfterSeconds = retryAfterSecondsFrom(r, j);
      throw e;
    }

    const raw = j?.choices?.[0]?.message?.content;
    const parsed = parseJsonObject(raw, "Groq");
    return {
      data: normalizeResult(parsed),
      meta: {
        provider: "groq",
        model,
        latencyMs: Date.now() - started,
        remainingRequests: r.headers.get("x-ratelimit-remaining-requests") || null,
        remainingTokens: r.headers.get("x-ratelimit-remaining-tokens") || null,
        limitTokens: r.headers.get("x-ratelimit-limit-tokens") || null,
        resetTokens: r.headers.get("x-ratelimit-reset-tokens") || null,
        resetRequests: r.headers.get("x-ratelimit-reset-requests") || null,
      },
    };
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error("Groq: request timed out");
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function geminiOnce(model, key, image, mediaType, currentDate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const started = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{
        role: "user",
        parts: [
          { inline_data: { mime_type: mediaType, data: image } },
          { text: `Read this receipt. Current date: ${currentDate}. Extract only visible/reliable transaction data.` }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: RECEIPT_SCHEMA,
        maxOutputTokens: 1100,
        thinkingConfig: { thinkingLevel: "low" }
      }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const j = await r.json().catch(() => ({}));

    if (!r.ok || j?.error) {
      const e = new Error(`${model}: ${j?.error?.message || `HTTP ${r.status}`}`);
      e.status = j?.error?.code || r.status;
      e.retryAfterSeconds = retryAfterSecondsFrom(r, j);
      throw e;
    }
    const raw = extractText(j);
    if (!raw) {
      const e = new Error(`${model}: empty response`);
      e.status = 500;
      throw e;
    }

    const parsed = parseJsonObject(raw, model);

    return {
      data: normalizeResult(parsed),
      meta: { provider: "gemini", model, latencyMs: Date.now() - started }
    };
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error(`${model}: request timed out`);
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(key, image, mediaType, currentDate) {
  const models = [
    process.env.GEMINI_MODEL,
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite"
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let last;
  for (const model of models) {
    try {
      return await geminiOnce(model, key, image, mediaType, currentDate);
    } catch (e) {
      last = e;
      if (e.status === 404 || /not found|not supported|deprecat/i.test(String(e.message))) continue;
      throw e;
    }
  }
  throw last || new Error("No Gemini OCR model is available");
}

async function callClaude(key, image, mediaType, currentDate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const started = Date.now();
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens: 1100,
        temperature: 0,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: `Current date: ${currentDate}. Return only a JSON object matching the requested receipt fields.` }
          ]
        }]
      }),
      signal: controller.signal
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) {
      const e = new Error(j?.error?.message || `Claude HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const raw = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const parsed = parseJsonObject(raw, "Claude");

    return {
      data: normalizeResult(parsed),
      meta: { provider: "claude", model: process.env.CLAUDE_MODEL || "claude-sonnet-5", latencyMs: Date.now() - started }
    };
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error("Claude request timed out");
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}


const supabaseServerConfig = () => ({
  url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
  key: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "",
});


function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

async function requireSarrafUser(req, allowedRoles = null) {
  const authHeader = String(req?.headers?.authorization || req?.headers?.Authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    const e = new Error("authentication required");
    e.status = 401;
    throw e;
  }

  const { url, key } = supabaseServerConfig();
  if (!url || !key) {
    const e = new Error("server authentication is not configured");
    e.status = 500;
    throw e;
  }

  const userRes = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const user = await userRes.json().catch(() => ({}));
  if (!userRes.ok || !user?.id) {
    const e = new Error("invalid or expired session");
    e.status = 401;
    throw e;
  }

  const profileRes = await fetch(
    `${url.replace(/\/$/, "")}/rest/v1/app_users?auth_id=eq.${encodeURIComponent(user.id)}&deleted=eq.false&select=id,role&limit=1`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    }
  );
  const profiles = await profileRes.json().catch(() => []);
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  if (!profileRes.ok || !profile?.id) {
    const e = new Error("active Sarraf account required");
    e.status = 403;
    throw e;
  }

  if (Array.isArray(allowedRoles) && allowedRoles.length && !allowedRoles.includes(profile.role)) {
    const e = new Error("this account is not allowed to use receipt reading");
    e.status = 403;
    throw e;
  }

  const claims = decodeJwtPayload(token);
  const aal = String(claims?.aal || "aal1");
  // «2FA بۆ خاوەن و کارمەند لەم قۆناغەدا پێویست نییە» — section 6. This route used to refuse an
  // administrator or an office at aal1, which after that decision would refuse them always,
  // since a session cannot reach aal2 without an enrolled factor.
  //
  // The other three routes keep the sharper rule from api/_second-factor.js — a factor you
  // enrolled must still be presented — and this one cannot: it talks to PostgREST by fetch with
  // the caller's own token and holds no service key, so it has no way to ask whether a factor
  // exists. Guessing would mean either refusing everyone again or pretending to check.
  //
  // What still stands here: an active account, and an explicit allowedRoles list checked above.
  // `aal` is still returned, so a caller that wants to treat one factor differently can.

  return { user, profile, token, aal };
}

/**
 * Server-side OCR engine shared by the legacy HTTP compatibility route and the canonical
 * stored-object worker.  Callers provide bytes that the server obtained; no database decision is
 * made here.  The canonical worker records the result together with the verified object hash.
 */
export async function readReceiptImage(image, mediaType = "image/jpeg", { maxBase64Chars = MAX_BASE64_CHARS } = {}) {
  if (!image || typeof image !== "string") {
    const error = new Error("receipt image is required");
    error.status = 400;
    throw error;
  }
  const normalizedMediaType = String(mediaType || "image/jpeg").toLowerCase();
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(normalizedMediaType)) {
    const error = new Error("unsupported receipt image type");
    error.status = 400;
    throw error;
  }
  if (image.length > maxBase64Chars) {
    const error = new Error("receipt image is too large");
    error.status = 413;
    throw error;
  }

  const qKey = process.env.GROQ_API_KEY;
  const gKey = process.env.GEMINI_API_KEY;
  const visionKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  const aKey = process.env.ANTHROPIC_API_KEY;
  if (!qKey && !gKey && !visionKey && !aKey) {
    const error = new Error("receipt OCR is not configured");
    error.status = 503;
    throw error;
  }

  const currentDate = new Date().toISOString().slice(0, 10);
  const requestedProvider = String(process.env.OCR_PROVIDER || "").toLowerCase().trim();
  const providers = [];
  const addProvider = (name, key, fn) => {
    if (key && !providers.some((provider) => provider.name === name)) {
      providers.push({ name, key, fn });
    }
  };
  if (requestedProvider === "gemini") addProvider("gemini", gKey, callGemini);
  else if (requestedProvider === "google-vision" || requestedProvider === "vision") {
    addProvider("google-vision", visionKey, callGoogleVision);
  } else if (requestedProvider === "claude") addProvider("claude", aKey, callClaude);
  else addProvider("groq", qKey, callGroq);
  addProvider("groq", qKey, callGroq);
  addProvider("gemini", gKey, callGemini);
  addProvider("google-vision", visionKey, callGoogleVision);
  addProvider("claude", aKey, callClaude);

  const attempts = [];
  let result = null;
  let lastError = null;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      result = await provider.fn(provider.key, image, normalizedMediaType, currentDate);
      result.meta = {
        ...(result.meta || {}),
        fallbackFrom: attempts.map((attempt) => attempt.provider),
      };
      break;
    } catch (error) {
      lastError = error;
      attempts.push({
        provider: provider.name,
        status: Number(error?.status) || null,
        message: String(error?.message || error).slice(0, 220),
      });
      const status = Number(error?.status);
      const fallbackable = status === 429 || status === 404 || status === 422 || status === 500
        || RETRYABLE.has(status)
        || /rate limit|quota|timed out|temporar|service unavailable|model.*not found/i.test(String(error?.message || ""));
      if (!fallbackable) throw error;
      if (index === providers.length - 1 && RETRYABLE.has(status)) {
        await sleep(500);
        result = await provider.fn(provider.key, image, normalizedMediaType, currentDate);
        result.meta = { ...(result.meta || {}), fallbackFrom: attempts.map((attempt) => attempt.provider) };
        break;
      }
    }
  }
  if (!result) {
    if (lastError) {
      lastError.attempts = attempts;
      throw lastError;
    }
    throw new Error("OCR providers failed");
  }
  return { ...result.data, _meta: result.meta, ocrVersion: 6 };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "POST only" });
    return;
  }

  let caller = null;
  try {
    caller = await requireSarrafUser(req, ["admin", "office", "customer", "partner"]);
  } catch (authError) {
    const status = Number(authError?.status) || 401;
    res.status(status).json({
      error: status === 401
        ? "کاتی چوونەژوورەوەت بەسەرچووە — دووبارە بچۆ ژوورەوە"
        : authError?.code === "mfa_required"
          ? "پاراستنی دوو هەنگاوی پێویستە — سەرەتا کۆدی Authenticator پشتڕاست بکەرەوە"
          : "ڕێگەپێدان بۆ خوێندنەوەی فیش نییە",
      code: authError?.code || null,
      retryable: false,
    });
    return;
  }

  // Counted per person, not per process: these routes are serverless and a per-process counter
  // would reset on every cold start.
  const serverConfig = supabaseServerConfig();
  if (await refuseIfOverLimit(res, {
    url: serverConfig.url, key: serverConfig.key, bucket: "ocr",
    subject: limitSubject(req, caller?.profile?.id),
    limit: OCR_LIMIT, windowSeconds: OCR_WINDOW_SECONDS,
  })) return;

  const qKey = process.env.GROQ_API_KEY;
  const gKey = process.env.GEMINI_API_KEY;
  const visionKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  const aKey = process.env.ANTHROPIC_API_KEY;
  if (!qKey && !gKey && !visionKey && !aKey) {
    res.status(500).json({ error: "خزمەتگوزاری خوێندنەوە لە سێرڤەر ڕێک نەخراوە" });
    return;
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const image = body?.image;
    const mediaType = String(body?.mediaType || "image/jpeg").toLowerCase();
    if (!image || typeof image !== "string") {
      res.status(400).json({ error: "وێنە نەنێردراوە" });
      return;
    }
    if (!mediaType.startsWith("image/")) {
      res.status(400).json({ error: "جۆری فایل پشتگیری ناکرێت" });
      return;
    }
    if (image.length > MAX_BASE64_CHARS) {
      res.status(413).json({ error: "قەبارەی وێنە زۆر گەورەیە" });
      return;
    }

    const currentDate = new Date().toISOString().slice(0, 10);
    const requestedProvider = String(process.env.OCR_PROVIDER || "").toLowerCase().trim();

    const providers = [];
    const addProvider = (name, key, fn) => {
      if (key && !providers.some((p) => p.name === name)) providers.push({ name, key, fn });
    };

    // Default order: Groq -> Gemini -> Google Vision -> Claude.
    // OCR_PROVIDER can force the first provider without disabling fallbacks.
    if (requestedProvider === "gemini") addProvider("gemini", gKey, callGemini);
    else if (requestedProvider === "google-vision" || requestedProvider === "vision") addProvider("google-vision", visionKey, callGoogleVision);
    else if (requestedProvider === "claude") addProvider("claude", aKey, callClaude);
    else addProvider("groq", qKey, callGroq);

    addProvider("groq", qKey, callGroq);
    addProvider("gemini", gKey, callGemini);
    addProvider("google-vision", visionKey, callGoogleVision);
    addProvider("claude", aKey, callClaude);

    if (!providers.length) throw new Error("No OCR provider is configured");

    const attempts = [];
    let result = null;
    let lastError = null;

    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      try {
        result = await p.fn(p.key, image, mediaType, currentDate);
        result.meta = {
          ...(result.meta || {}),
          fallbackFrom: attempts.length ? attempts.map((x) => x.provider) : [],
        };
        break;
      } catch (e) {
        lastError = e;
        attempts.push({
          provider: p.name,
          status: Number(e?.status) || null,
          message: String(e?.message || e).slice(0, 220),
        });

        const status = Number(e?.status);
        const fallbackable = status === 429 || status === 404 || status === 422 || status === 500 || RETRYABLE.has(status) ||
          /rate limit|quota|timed out|temporar|service unavailable|model.*not found/i.test(String(e?.message || ""));

        if (!fallbackable) throw e;

        // If there is no second provider configured, retry transient upstream errors once.
        if (i === providers.length - 1 && RETRYABLE.has(status)) {
          await sleep(500);
          result = await p.fn(p.key, image, mediaType, currentDate);
          result.meta = { ...(result.meta || {}), fallbackFrom: attempts.map((x) => x.provider) };
          break;
        }
      }
    }

    if (!result) {
      if (lastError) {
        lastError.attempts = attempts;
        throw lastError;
      }
      throw new Error("OCR providers failed");
    }

    // §2: the figures come from the evidence. What was read here is recorded server-side against
    // the image it was read from, so that anything altered on the way to the ingestion command is
    // caught rather than believed.
    const d = result.data || {};
    const attestedFields = {
      amount: d.amount ?? null,
      fee: d.fee ?? null,
      net_amount: d.netAmount ?? null,
      currency: d.currency ?? null,
      ref_no: d.refNo ?? null,
      merchant_order_no: d.merchantOrderNo ?? null,
      tx_date: d.txDate ?? null,
      receiver: d.receiver ?? null,
      sender: d.sender ?? null,
    };
    const imageSha256 = sha256Hex(Buffer.from(image, "base64"));
    const nonce = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 8);
    const attested = await attestReading({
      url: serverConfig.url, key: serverConfig.key, nonce,
      profileId: caller?.profile?.id, imageSha256, fields: attestedFields,
      provider: result.meta?.provider, model: result.meta?.model,
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ...result.data,
      _meta: result.meta,
      // What the uploader carries to the ingestion command. Neither value is a secret: the
      // nonce is worthless without the figures it was issued for, and the digest is derived
      // from figures the uploader can already see.
      attestation: attested ? {
        nonce,
        imageSha256,
        extractionDigest: attested.extraction_digest || extractionDigest(attestedFields),
      } : null,
      ocrVersion: 5,
    });
  } catch (e) {
    const status = Number(e?.status);
    const message = String(e?.message || e);
    const friendly = status === 429 || /quota|rate limit/i.test(message)
      ? "سنووری API پڕبووە — دووبارە هەوڵ بدە"
      : status === 504 || /timed out/i.test(message)
        ? "خوێندنەوە زۆر درێژەی کێشا — دووبارە هەوڵ بدە"
        : message;
    const httpStatus = status === 429 ? 429 : RETRYABLE.has(status) ? 503 : (status >= 400 && status < 500 ? status : 500);
    res.status(httpStatus).json({
      error: friendly,
      retryable: status === 429 || RETRYABLE.has(status) || status === 504,
      retryAfterSeconds: Number(e?.retryAfterSeconds) || null,
      providersTried: Array.isArray(e?.attempts) ? e.attempts.map((x) => x.provider) : undefined,
    });
  }
}
