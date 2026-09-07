/**
 * مامەڵەی ڕاستەوخۆ — لە چەند کەسێک کڕدراوە، بە یەک کەس فرۆشراوە
 *
 *   «جۆرێکی دیکەی مامەڵەی ڕاستەوخۆ هەیە کە لە جیاتی ئەوەی لە یەک کەسی بکڕم، لە چەند
 *    کەسێکی دەکڕم و بەڵام بە یەک کەسی دەفرۆشم.»
 *
 * The arithmetic of that trade, out of App.jsx and in one place that can be tested. What the
 * screen builds and what the server refuses have to agree, and they can only be shown to agree
 * if the browser's half is something a test can call.
 *
 * The server is still the authority — sarraf_commit_transactions recomputes every one of these
 * numbers and refuses the command if they disagree. This exists so the owner sees the sum while
 * they are typing rather than being refused afterwards, and so that a rounding difference
 * between the two is a test failure here rather than a mystery on a screen.
 */

/**
 * Build the purchases, the sale, and what the trade came to.
 *
 * `rounder` is passed in rather than imported: rounding is per currency and the caller is what
 * knows the currencies. It is called as rounder(value, currencyId).
 *
 * Returns { legs, soldAmount, boughtTotal, sellTotal, profit }, where `legs` is every purchase
 * INCLUDING the first one, in the order they were entered.
 */
export function directTradeLegs({
  amount, buyRate, sellRate, extras = [], curId, againstId, rounder,
}) {
  const round = typeof rounder === "function" ? rounder : (v) => v;
  const first = {
    amount: round(Number(amount) || 0, curId),
    rate: Number(buyRate) || 0,
  };
  const legs = [first, ...extras.map((x) => ({
    amount: round(Number(x.amount) || 0, curId),
    rate: Number(x.rate ?? x.quote) || 0,
  }))].map((leg) => ({ ...leg, total: round(leg.amount * leg.rate, againstId) }));

  // «دەبێت ڕێک ئەوە بفرۆشرێت کە کڕدراوە.» Not typed, summed — the server refuses any other
  // number, so a screen that let the owner type one would only be arranging for a refusal.
  const soldAmount = round(legs.reduce((sum, leg) => sum + leg.amount, 0), curId);
  const boughtTotal = round(legs.reduce((sum, leg) => sum + leg.total, 0), againstId);
  const sellTotal = round(soldAmount * (Number(sellRate) || 0), againstId);

  return {
    legs,
    soldAmount,
    boughtTotal,
    sellTotal,
    // The earning is the sale less every purchase. Pricing it against one leg is the mistake
    // 202609020018 removed from the server, and it would be the same mistake here.
    profit: round(sellTotal - boughtTotal, againstId),
  };
}

/**
 * A seller row the owner has begun but not finished. Returns the 1-based position of the first
 * incomplete row and what is missing, or null when every row is whole.
 *
 * Empty rows are ignored entirely: pressing "add a seller" and changing your mind is not an
 * error, and a row nobody touched should not stop the trade.
 */
export function firstIncompleteSeller(extras = []) {
  for (let i = 0; i < extras.length; i += 1) {
    const x = extras[i];
    const touched = x.cpId || String(x.cpName || "").trim()
      || String(x.amount ?? "").trim() !== "" || String(x.quote ?? "").trim() !== "";
    if (!touched) continue;
    if (!x.cpId && !String(x.cpName || "").trim()) return { position: i + 2, missing: "person" };
    if (!(Number(x.amount) > 0)) return { position: i + 2, missing: "amount" };
    if (!(Number(x.quote) > 0)) return { position: i + 2, missing: "rate" };
  }
  return null;
}

/** The rows the owner actually filled in, in order. */
export function filledSellers(extras = []) {
  return extras.filter((x) => x.cpId || String(x.cpName || "").trim()
    || String(x.amount ?? "").trim() !== "" || String(x.quote ?? "").trim() !== "");
}
