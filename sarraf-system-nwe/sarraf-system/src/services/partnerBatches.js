/**
 * The details of an indirect trade, as the partner holding the money reads them.
 *
 * Task A. A seller transfers yuan by WeChat or Alipay straight to a partner rather than to the
 * house, and uploads the receipt as proof. The admin reviews the batch and makes a transaction
 * from it, naming the partner the money was placed with — and from that moment the details of
 * those receipts belong to that partner as much as to the house.
 *
 * Every figure here is read from the server. There is no arithmetic in this file, deliberately:
 * the totals a partner is shown and the totals the house acts on have to be the same numbers,
 * and the only way to guarantee that is for there to be one place that computes them.
 */

const clean = (v) => String(v ?? "").normalize("NFKC").trim();

/** The wallets, named as a person names them rather than as a receipt spells them. */
export const PLATFORM_KU = Object.freeze({
  wechat: "ویچات",
  alipay: "ئەلیپەی",
  bank: "بانک",
  other: "ڕێگەی تر",
  unknown: "دیارینەکراو",
});

export const PLATFORM_EN = Object.freeze({
  wechat: "WeChat",
  alipay: "Alipay",
  bank: "Bank",
  other: "Other",
  unknown: "Unknown",
});

export const platformName = (key, lang = "ku") =>
  (lang === "ku" ? PLATFORM_KU : PLATFORM_EN)[key] || key || "—";

/** The details of one batch: every receipt, and the totals grouped as the owner asked for them. */
export async function loadBatchDetail(client, batchId) {
  if (!clean(batchId)) throw new Error("کۆمەڵەیەک پێویستە");
  const { data, error } = await client.rpc("sarraf_partner_batch_detail", { p_batch_id: batchId });
  if (error) throw error;
  return data || null;
}

/**
 * What has been placed with a partner, across every batch.
 *
 * partnerId is honoured for staff and ignored for a partner, which is the server's rule and not
 * this file's — repeating the check here would only mean two places to keep in step.
 */
export async function loadHoldings(client, partnerId = null) {
  const { data, error } = await client.rpc("sarraf_partner_holdings", {
    p_partner_id: partnerId || null,
  });
  if (error) throw error;
  return data || { batches: [], by_currency: [], batch_count: 0 };
}

/** Whether a receipt carried a fee, in the reader's own words rather than a number to compare. */
const FEE_STATUS = Object.freeze({
  ku: { with: "بە فی", without: "بێ فی" },
  en: { with: "With fee", without: "Without fee" },
  ar: { with: "مع الرسوم", without: "بدون الرسوم" },
});

/** Whether the house counted this receipt. A rejected row carries the server's own reason. */
const COUNT_STATUS = Object.freeze({
  ku: { counted: "ژمێردراوە", not: "ژمێرنەکراوە" },
  en: { counted: "Counted", not: "Not counted" },
  ar: { counted: "محسوب", not: "غير محسوب" },
});

const langKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");

/**
 * The rows as a table a person can read.
 *
 * Keyed by stable identifiers rather than by a column heading. A heading is something a reader
 * sees and therefore something that has to change with their language; a key is something the
 * code looks the value up by and therefore must not. Keying the rows by their Kurdish headings
 * conflated the two, and the cells that spelled out a status carried Kurdish into English and
 * Arabic where the headings around them had already been translated. The component renders the
 * headings from its own COPY; this file returns values, and translates the two that are words.
 *
 * A caller turning these into CSV should pass them through csvSafe.toCsv, which is what keeps a
 * recipient's name beginning with `=` from becoming a formula in someone's spreadsheet.
 */
export function detailRows(detail, { lang = "ku" } = {}) {
  const fee = FEE_STATUS[langKey(lang)];
  const count = COUNT_STATUS[langKey(lang)];
  return (detail?.rows || []).map((r) => ({
    receiver: r.receiver || "—",
    date: (r.tx_date || "").toString().slice(0, 10) || "—",
    platform: platformName(r.platform, lang),
    currency: r.currency,
    withFee: r.amount,
    fee: r.fee,
    withoutFee: r.net_amount,
    // The distinction the owner asked to see on every row, in words rather than as a number a
    // reader has to compare against zero themselves.
    feeStatus: r.has_fee ? fee.with : fee.without,
    // §10. The owner asked for the Order No. to be readable here, and it is now the identifier a
    // receipt cannot reach 'accepted' without. It gets its own column, and never falls back to
    // the merchant's number: they are two different identifiers printed on the same receipt —
    // api/read-receipt.js reads refNo from "Order No." and merchantOrderNo from "Merchant order
    // No." and says "Never swap these two IDs". A column that shows either one under a single
    // heading tells a reader something untrue about which number they are looking at.
    orderNo: r.ref_no || "—",
    merchantOrderNo: r.merchant_order_no || "—",
    // A rejected row carries the server's own sentence, which is already in the reader's
    // language and says more than the word "no" would.
    state: r.counted ? count.counted : (r.reject_reason || count.not),
  }));
}

/** Is this batch an indirect trade, and whose is the money? Null partner means it is not. */
export function holder(detail) {
  if (!detail?.is_indirect) return null;
  return { id: detail.partner_id, name: detail.partner_name || detail.partner_id };
}
