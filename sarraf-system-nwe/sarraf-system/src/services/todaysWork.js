/**
 * «کاری ئەمڕۆ» — what is waiting, counted once.
 *
 * These are decision-driving numbers: the owner opens the app, reads them, and decides what to
 * do with their morning. They were arithmetic written inline in a twelve-thousand-line
 * component, which meant nothing could test them and nothing else could reuse them — the same
 * reason the money maths was moved out into its own module.
 *
 * Nothing here reads the network or the clock. Given the rows, the answer is the same every
 * time, which is what makes it testable at all.
 *
 * ── One name for a batch's stage ─────────────────────────────────────────────────────────────
 *
 * A batch's stage is stored, except on rows written before the column existed, where it has to
 * be inferred from what else the row says. Reading it two different ways in two places is how a
 * summary comes to say four while the list under it shows three, so it is read here and only
 * here.
 */

const count = (rows, of) => (rows || []).reduce((sum, r) => sum + (Number(of(r)) || 0), 0);

/** The stage a batch is at, whether or not the row is old enough to say so itself. */
export function batchStage(batch) {
  if (!batch) return "received";
  return batch.receipt_stage
    || (batch.tx_id ? "matched" : batch.status === "new" ? "needs_review" : "verified");
}

/** The stages that mean somebody still has to do something with the batch. */
export const OPEN_STAGES = Object.freeze(["received", "reading", "needs_review", "verified"]);

/**
 * What is waiting today.
 *
 * @param {object} args
 * @param {Array}  args.batches     receipt batches, as the receipts screen loads them
 * @param {Array}  args.txs         transactions
 * @param {Array}  args.users       people
 * @param {Array}  args.approvals   approval requests
 * @param {Array}  args.unpricedCurrencies  currency ids with no usable rate
 * @param {object} args.officeCash  {officeId: {curId: amount}} — what each office is owed
 */
export function todaysWork({
  batches = [], txs = [], users = [], approvals = [],
  unpricedCurrencies = [], officeCash = {},
} = {}) {
  const rows = batches || [];
  const waiting = rows.filter((b) => OPEN_STAGES.includes(batchStage(b)));

  // An office is owed only where the balance is positive. A zero is not a debt, and a negative
  // one is the office holding the owner's money — which is a different screen's question.
  const officesOwed = (users || [])
    .filter((u) => u && u.role === "office" && !u.deleted)
    .map((u) => ({
      id: u.id,
      name: u.name,
      owed: Object.entries(officeCash?.[u.id] || {})
        .filter(([, amount]) => Number(amount) > 0)
        .map(([curId, amount]) => ({ curId, amount: Number(amount) })),
    }))
    .filter((x) => x.owed.length > 0);

  const open = {
    waitingBatches: waiting.length,
    waitingReceipts: count(waiting, (b) => b.n),
    needsPerson: rows.filter((b) => batchStage(b) === "needs_review").length,
    refused: count(rows, (b) => b.rejected_n),
    duplicates: count(rows, (b) => b.dup_n),
    unpriced: [...(unpricedCurrencies || [])],
    approvals: (approvals || []).filter((r) => r && r.status === "pending").length,
    unpaid: (txs || []).filter((t) => t && !t.deleted && t.status === "pending").length,
    officesOwed,
  };

  // The headline: how many separate things are waiting. Receipts count once per batch rather
  // than once per receipt — a batch is the thing a person opens, and counting the receipts
  // inside it would make one afternoon's work read as ninety jobs.
  //
  // Refused and duplicate receipts are deliberately NOT in it. They are already dealt with:
  // the system stopped them and said why, and the person who sent one can send another. Adding
  // them would leave a number that never reaches zero, and a number that never reaches zero
  // stops being read.
  open.total = open.waitingBatches + open.unpriced.length + open.approvals + open.unpaid
    + open.officesOwed.length;
  return open;
}
