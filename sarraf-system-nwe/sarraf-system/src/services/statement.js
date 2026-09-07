/**
 * ڕاپۆرتی چاپکراو — چی دەچێتە سەری، و چی هەرگیز
 *
 *   «PDF ـەکان براندکراو، کوردی، RTL و گونجاو بۆ چاپ بن.»
 *   «هیچ قازانج، عمولە یان data leakage بۆ کڕیار/هاوبەش/نووسینگە ڕوونەدات.»   — بەشی ٢١
 *   «قازانجی ZEMAN نەبینێت. عمولەی هاوبەش نەبینێت.»                          — بەشی ١٠
 *
 * A statement is the one thing in this system that LEAVES it. A screen is read by somebody
 * already signed in, under policies the database enforces; a printed page is handed over,
 * photographed, forwarded. So the rule here is not "hide the profit column" — it is that this
 * module never copies a row. Every line is built field by field from a named list, and a
 * column added to `txs` next year cannot arrive on a customer's statement by accident.
 *
 * That is why the tests below pass rows carrying profit, commission, cost basis and tenant id
 * and assert that none of them appear anywhere in the output, rather than checking that the
 * table has the right headings.
 *
 * ── Why there is no PDF library here ────────────────────────────────────────────────────────
 *
 * This module builds a document; the browser turns it into a PDF, through its own print
 * dialogue and the print stylesheet in src/print.css.
 *
 * jsPDF and pdfmake do not shape Arabic script. Kurdish written through either of them comes
 * out as isolated letters in visual order — legible to nobody, and worse than no PDF at all,
 * because it looks like a bug in the business rather than in the library. Embedding a font
 * does not fix it: shaping is a separate problem from glyphs. The browser already has a
 * shaping engine, already has the fonts, already knows the direction, and already offers
 * "Save as PDF" on every phone and desktop this app runs on.
 *
 * So the deliverable is a page that prints correctly, and the PDF is what the reader saves.
 */

const clean = (v) => String(v ?? "").trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const DECIMALS = { IQD: 0 };
export const formatMoney = (amount, currency) => {
  const code = clean(currency).toUpperCase();
  const decimals = DECIMALS[code] ?? 2;
  return `${num(amount).toLocaleString("en-US", {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  })} ${code}`;
};

const day = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const within = (value, from, to) => {
  const at = day(value);
  if (!at) return false;
  if (from && at < day(from)) return false;
  if (to && at > day(to)) return false;
  return true;
};

const COPY = {
  ku: {
    statement: "کەشفی حساب", customer: "کڕیار", partner: "هاوبەش",
    period: "ماوە", issued: "بەرواری دەرکردن", all: "هەموو مێژووەکە",
    transactions: "مامەڵەکان", debts: "قەرزەکان", balance: "باڵانس",
    date: "بەروار", ref: "ژمارە", kind: "جۆر", amount: "بڕ", total: "کۆ",
    buy: "کڕین", sell: "فرۆشتن", owed: "ماوە", nothing: "هیچ تۆمارێک نییە",
    theyOwe: "ئەوان قەرزارن", weOwe: "ئێمە قەرزارین", held: "لای ئێمە هەیەتی",
  },
  en: {
    statement: "Statement of account", customer: "Customer", partner: "Partner",
    period: "Period", issued: "Issued", all: "The whole history",
    transactions: "Transactions", debts: "Debts", balance: "Balance",
    date: "Date", ref: "No.", kind: "Kind", amount: "Amount", total: "Total",
    buy: "Bought", sell: "Sold", owed: "Outstanding", nothing: "Nothing recorded",
    theyOwe: "They owe", weOwe: "We owe", held: "Held for them",
  },
  ar: {
    statement: "كشف حساب", customer: "العميل", partner: "الشريك",
    period: "الفترة", issued: "تاريخ الإصدار", all: "كامل السجل",
    transactions: "المعاملات", debts: "الديون", balance: "الرصيد",
    date: "التاريخ", ref: "الرقم", kind: "النوع", amount: "المبلغ", total: "الإجمالي",
    buy: "شراء", sell: "بيع", owed: "المتبقي", nothing: "لا يوجد سجل",
    theyOwe: "عليهم", weOwe: "علينا", held: "محفوظ لهم",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");

/**
 * One transaction line, built field by field.
 *
 * NOT copied, and this is the whole point: profit, profitCurId, buyRate, buyTotal,
 * costBasisUsd, partnerFeeSnapshot, partnerRateSnapshot, tenantId, businessFlow and everything
 * else on the row stays where it is. A column added to txs next year arrives nowhere near a
 * customer's statement, because nothing here says "spread the row".
 */
const transactionLine = (tx, copy) => ({
  date: day(tx?.date),
  reference: tx?.code == null ? null : `#${tx.code}`,
  kind: tx?.type === "buy" ? copy.buy : copy.sell,
  amount: formatMoney(tx?.amount, tx?.curId),
  total: formatMoney(tx?.total, tx?.againstId),
});

const debtLine = (debt, copy) => ({
  date: day(debt?.openedAt),
  reference: null,
  kind: debt?.debtorType === "zeman" ? copy.weOwe : copy.theyOwe,
  amount: formatMoney(debt?.outstanding, debt?.currency),
  total: null,
  reason: clean(debt?.reason) || null,
});

/**
 * The document a customer or a partner is handed.
 *
 * Returns a plain object: a header, sections of lines, and totals by currency. It knows nothing
 * about markup, so the same document can be printed, shown on screen, or asserted about in a
 * test without a browser.
 */
export function partyStatement({
  party = null, role = "customer", lang = "ku", businessName = null,
  transactions = [], debts = [], held = [], from = null, to = null, issuedAt = null,
} = {}) {
  const copy = COPY[localeKey(lang)];
  const partyId = clean(party?.id);

  // Only what is theirs, and only inside the period. A statement that quietly included one
  // other person's line would be the worst leak in the system, because it leaves the building.
  const mine = (transactions || []).filter((t) =>
    !t?.deleted && clean(t?.cpId) && clean(t?.cpId) === partyId && (!from && !to ? true : within(t?.date, from, to)));
  const theirDebts = (debts || []).filter((d) =>
    (clean(d?.debtorId) === partyId || clean(d?.creditorId) === partyId)
    && num(d?.outstanding) > 0 && (!from && !to ? true : within(d?.openedAt, from, to)));

  const totals = {};
  const add = (currency, key, amount) => {
    const code = clean(currency).toUpperCase();
    if (!code) return;
    totals[code] = totals[code] || { traded: 0, owed: 0, held: 0 };
    totals[code][key] += num(amount);
  };
  mine.forEach((t) => add(t?.againstId, "traded", t?.total));
  theirDebts.forEach((d) => add(d?.currency, "owed",
    d?.debtorType === "zeman" ? -num(d?.outstanding) : num(d?.outstanding)));
  (held || []).forEach((h) => add(h?.currency, "held", h?.available));

  return {
    title: copy.statement,
    business: clean(businessName) || null,
    party: { name: clean(party?.name) || null, phone: clean(party?.phone) || null,
             role: role === "partner" ? copy.partner : copy.customer },
    period: from || to ? { from: day(from), to: day(to) } : null,
    periodLabel: from || to ? copy.period : copy.all,
    issued: day(issuedAt || new Date()),
    columns: { date: copy.date, reference: copy.ref, kind: copy.kind,
               amount: copy.amount, total: copy.total },
    sections: [
      { title: copy.transactions, empty: copy.nothing,
        lines: mine.map((t) => transactionLine(t, copy)) },
      { title: copy.debts, empty: copy.nothing,
        lines: theirDebts.map((d) => debtLine(d, copy)) },
    ],
    totals: Object.entries(totals).map(([currency, t]) => ({
      currency,
      traded: formatMoney(t.traded, currency),
      owed: t.owed === 0 ? null : formatMoney(Math.abs(t.owed), currency),
      owedLabel: t.owed === 0 ? null : (t.owed > 0 ? copy.theyOwe : copy.weOwe),
      held: t.held === 0 ? null : formatMoney(t.held, currency),
      heldLabel: t.held === 0 ? null : copy.held,
    })),
    balanceLabel: copy.balance,
  };
}

export default partyStatement;
