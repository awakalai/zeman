/**
 * Investor profit share, weighted by the capital that existed when the profit was earned.
 *
 * The previous rule applied each investor's CURRENT capital weight to ALL-TIME profit. That
 * mixes two different moments, and the consequence is not subtle: an investor who joins today
 * immediately takes a share of profit earned before they arrived. With 100,000 already earned
 * and a new investor putting in half the capital at a 50% rate, their first day was worth
 * 25,000 of somebody else's money. The reverse hurts too — an investor who withdraws loses
 * share of profit they genuinely helped earn.
 *
 * So profit is attributed event by event. Each sale is shared using the capital standing on
 * the day of that sale, and an investor's total is the sum of their share of each one. Somebody
 * who was not there for a sale gets nothing from it, which is the whole point.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const time = (d) => {
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
};

/** An investor with no declared scope shares every currency; a declared scope narrows it. */
export const inScopeFor = (investor, curId) => {
  const scope = investor?.scope;
  return !Array.isArray(scope) || scope.length === 0 || scope.includes(curId);
};

/**
 * Capital standing in one currency at a moment in time.
 *
 * Capital events are the dated deposits and withdrawals: `investorId` names whose they are,
 * and a null investorId is the owner's own capital.
 *
 * @returns {{self: number, byInvestor: Record<string, number>}}
 */
export function capitalAsOf(capitalEvents, curId, atMs) {
  const byInvestor = {};
  let self = 0;
  for (const e of capitalEvents || []) {
    if (!e || e.curId !== curId) continue;
    if (time(e.date) > atMs) continue;
    const amount = num(e.amount);
    if (e.investorId) byInvestor[e.investorId] = (byInvestor[e.investorId] || 0) + amount;
    else self += amount;
  }
  return { self, byInvestor };
}

/**
 * Each investor's share of one profit event.
 *
 * A negative balance — an account withdrawn past zero — is treated as zero for weighting.
 * Letting it stay negative would hand the other investors more than the whole profit.
 */
export function sharesForEvent({ profit, curId, capital, investors }) {
  const amount = num(profit);
  const out = {};
  if (!amount) return out;

  const eligible = (investors || []).filter((inv) => inv && inScopeFor(inv, curId));
  const weight = (id) => Math.max(0, num(capital.byInvestor[id]));

  let total = Math.max(0, num(capital.self));
  for (const inv of eligible) total += weight(inv.id);
  // Nobody had capital that day, so nobody shares that day's profit.
  if (total <= 0) return out;

  for (const inv of eligible) {
    const cap = weight(inv.id);
    if (cap <= 0) continue;
    const share = amount * (cap / total) * (num(inv.rate) / 100);
    if (share) out[inv.id] = (out[inv.id] || 0) + share;
  }
  return out;
}

/**
 * Every investor's total share of a currency's profit across a set of events.
 *
 * @param {object} args
 * @param {Array}  args.profitEvents  [{date, curId, amount}] — one per profit-earning sale
 * @param {Array}  args.capitalEvents [{date, curId, investorId|null, amount}]
 * @param {Array}  args.investors     [{id, rate, scope}]
 * @param {string} args.curId
 * @returns {Record<string, number>} investorId → their share
 */
export function investorSharesForCurrency({ profitEvents, capitalEvents, investors, curId }) {
  const out = {};
  for (const event of profitEvents || []) {
    if (!event || event.curId !== curId) continue;
    const capital = capitalAsOf(capitalEvents, curId, time(event.date));
    const shares = sharesForEvent({ profit: event.amount, curId, capital, investors });
    for (const [id, value] of Object.entries(shares)) out[id] = (out[id] || 0) + value;
  }
  return out;
}

/** One investor's share of one currency — what the interface asks for most often. */
export function investorShare({ investorId, curId, profitEvents, capitalEvents, investors }) {
  return investorSharesForCurrency({ profitEvents, capitalEvents, investors, curId })[investorId] || 0;
}

/** Total owed to all investors, per currency — what the profit-and-loss report subtracts. */
export function investorsTotalByCurrency({ profitEvents, capitalEvents, investors, currencies }) {
  const out = {};
  for (const c of currencies || []) {
    const curId = c?.id ?? c;
    if (!curId) continue;
    const shares = investorSharesForCurrency({ profitEvents, capitalEvents, investors, curId });
    const total = Object.values(shares).reduce((s, v) => s + v, 0);
    if (total) out[curId] = total;
  }
  return out;
}

/**
 * The profit-earning events, from transactions.
 *
 * Only shared profit is distributed: a direct trade is the owner's own, which is the rule the
 * previous implementation already followed and this one keeps.
 */
export function profitEventsFrom(txs, { from = null, to = null } = {}) {
  const events = [];
  for (const t of txs || []) {
    if (!t || t.deleted || t.direct) continue;
    if (t.type !== "sell" || t.profit == null) continue;
    const day = String(t.date || "").slice(0, 10);
    if (from && day < from) continue;
    if (to && day > to) continue;
    events.push({ date: t.date, curId: t.profitCurId, amount: num(t.profit) });
  }
  return events;
}

/**
 * The dated costs the general safe carried, from the ledger.
 *
 *   «کە خەرجییەکەم دا ئاماژە بەوە بکات لە قاسەی گشتی دیدەی یان قاسەی تایبەتی خۆت»
 *   «خەرجی لە قاسەی گشتی — بەڵێ، بەپێی ڕێژەکەیان»
 *
 * An expense paid out of the general safe is a cost of the shared business, so it comes out of
 * the pool before the pool is divided. Fed in as a negative event, it is shared by exactly the
 * same rule a sale is: by the capital standing on the day it was paid. Somebody who was not
 * there that day carries none of it, which is the same fairness that makes a sale's profit
 * theirs only if they were there for it.
 *
 * An expense paid out of the owner's own safe is not here, and neither is one recorded before
 * the question was ever asked — both are the owner's alone, which is what the screens have
 * always done with them.
 */
export function sharedCostEventsFrom(ledger, { from = null, to = null } = {}) {
  const events = [];
  for (const e of ledger || []) {
    if (!e || e.type !== "expense" || e.paidFrom !== "general") continue;
    const day = String(e.date || "").slice(0, 10);
    if (from && day < from) continue;
    if (to && day > to) continue;
    // The ledger stores an expense as a negative movement. Its sign is already the sign this
    // wants, so taking Math.abs and negating it again would be two chances to get it backwards.
    const amount = num(e.amount);
    if (amount) events.push({ date: e.date, curId: e.curId, amount });
  }
  return events;
}

/** The dated capital movements, from the ledger. */
export function capitalEventsFrom(ledger) {
  const events = [];
  for (const e of ledger || []) {
    if (!e || (e.type !== "deposit" && e.type !== "withdraw")) continue;
    events.push({
      date: e.date,
      curId: e.curId,
      investorId: e.owner === "investor" ? e.investorId : null,
      amount: num(e.amount),
    });
  }
  return events;
}
