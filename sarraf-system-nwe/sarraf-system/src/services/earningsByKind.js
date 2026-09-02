/**
 * «چەندم لەم ئیشە خێر کردووە»
 *
 *   «دەبێت لە ڕاپۆرتا هەموو خێرێک هەبێت کە لەم ئیشە یان هەر ئیشیکی تر چەندم خیر کردووە.»
 *
 * The report had one profit figure: every sale's spread added together. It answered "how much
 * did I make" and could not answer "from what", which is the question an owner deciding where
 * to put their time is actually asking. Worse, a commission trade was not in it at all —
 * sarraf_commission_trade writes no `profit`, so the money earned moving dinars between places
 * appeared in the report nowhere.
 *
 * ── Why dollars ──────────────────────────────────────────────────────────────────────────────
 *
 * The three kinds do not share a currency: a spread is earned in whatever was sold, a
 * commission in whatever arrived. Adding dinars to yuan to say "commission earned more than
 * trading" would be meaningless. USD is the unit the books already keep, so it is the unit here.
 *
 * ── Why these three ──────────────────────────────────────────────────────────────────────────
 *
 * They are the three kinds of work, not three shapes of row. Buying and selling for a customer,
 * a direct trade where the whole spread is the owner's, and a commission trade that moves money
 * between two places. A partner-custody sale is buying and selling — the custody is where the
 * goods sat, not a different way of earning.
 */

/** The kinds, in the order a report should read them. */
export const EARNING_KINDS = Object.freeze(["trade", "direct", "commission"]);

/**
 * @param txs            transactions already narrowed to the reported range, undeleted
 * @param usdValueAt     (amount, currencyId, mode, date) → USD, or null when that day had no rate
 * @returns {{ [kind: string]: { usd: number, n: number, unvalued: number } }}
 *
 * `unvalued` is not decoration. A trade whose currency had no rate on its own day cannot be
 * valued, and counting it as zero would quietly report less earning than there was. It is
 * counted apart so the screen can say how many are missing rather than pretending to a total
 * that is short.
 */
export function earningsByKind({ txs = [], usdValueAt }) {
  const out = {};
  for (const kind of EARNING_KINDS) out[kind] = { usd: 0, n: 0, unvalued: 0 };
  if (typeof usdValueAt !== "function") return out;

  for (const t of txs) {
    if (!t || t.deleted) continue;

    if (t.businessFlow === "commission") {
      // The difference between what left and what arrived, valued exactly the way
      // sarraf_write_transaction_entry_lines values it: total − amount, both in USD, on the
      // trade's own date. Anything else would drift away from acc-4100.
      const gave = usdValueAt(Math.abs(Number(t.amount) || 0), t.curId, "mid", t.date);
      const got = usdValueAt(Math.abs(Number(t.total) || 0), t.againstId, "mid", t.date);
      if (gave == null || got == null || !Number.isFinite(gave) || !Number.isFinite(got)) {
        out.commission.unvalued += 1;
        continue;
      }
      out.commission.usd += got - gave;
      out.commission.n += 1;
      continue;
    }

    if (t.type !== "sell" || t.profit == null) continue;
    const bucket = t.direct ? out.direct : out.trade;
    const usd = usdValueAt(Number(t.profit), t.profitCurId, "mid", t.date);
    if (usd == null || !Number.isFinite(usd)) {
      bucket.unvalued += 1;
      continue;
    }
    bucket.usd += usd;
    bucket.n += 1;
  }
  return out;
}

export default earningsByKind;
