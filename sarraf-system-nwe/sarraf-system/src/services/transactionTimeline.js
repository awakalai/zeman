const timeOf = (value) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
};

const nonEmpty = (value) => value !== null && value !== undefined && String(value).trim() !== "";

/**
 * Build the small, human-readable history that a transaction detail may show.
 *
 * The input is deliberately limited to rows the caller already received through RLS. Portal
 * callers should omit ledger rows; this keeps internal movement, parties and accounting labels
 * out of customer/partner/office views without trying to re-authorize browser data.
 */
export function transactionTimeline(transaction, { ledger = [], scope = "owner" } = {}) {
  if (!transaction?.id) return [];

  const events = [{
    id: `transaction:${transaction.id}:created`,
    kind: "created",
    at: transaction.date,
    amount: null,
    currency: null,
  }];

  if (transaction.status === "pending") {
    events.push({
      id: `transaction:${transaction.id}:pending`,
      kind: "pending",
      at: transaction.date,
      amount: null,
      currency: null,
    });
  } else if (nonEmpty(transaction.paidAt)) {
    events.push({
      id: `transaction:${transaction.id}:settled`,
      kind: "settled",
      at: transaction.paidAt,
      amount: Math.abs(Number(transaction.total)) || null,
      currency: transaction.againstId || null,
    });
  }

  if (scope === "owner") {
    for (const row of Array.isArray(ledger) ? ledger : []) {
      if (row?.txId !== transaction.id || !nonEmpty(row.date)) continue;
      events.push({
        id: `ledger:${row.id}`,
        kind: "movement",
        at: row.date,
        amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
        currency: row.curId || null,
      });
    }
  }

  return events
    .sort((left, right) => timeOf(left.at) - timeOf(right.at) || left.id.localeCompare(right.id));
}

export default transactionTimeline;
