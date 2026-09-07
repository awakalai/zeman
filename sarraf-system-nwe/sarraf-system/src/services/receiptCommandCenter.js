/**
 * The receipt command center has three questions, not a list of database states:
 * what can move forward, what needs a person, and what is already out of the way.
 *
 * Keep this projection separate from the server lifecycle. The server remains the source of
 * truth for state transitions; this only decides where a batch belongs in the work queue.
 */
const ATTENTION_STAGES = new Set(["received", "reading", "needs_review", "rejected"]);
const READY_STAGES = new Set(["verified", "matched", "finalized"]);
const ARCHIVE_STAGES = new Set(["archived"]);

export const RECEIPT_WORK_BUCKETS = Object.freeze(["ready", "attention", "archive"]);

export function receiptWorkBucket(batch) {
  const stage = String(batch?.receipt_stage || (batch?.tx_id ? "matched" : batch?.status === "new" ? "needs_review" : "verified"));
  if (ARCHIVE_STAGES.has(stage)) return "archive";
  if (ATTENTION_STAGES.has(stage) || Number(batch?.rejected_n) > 0 || Number(batch?.dup_n) > 0) return "attention";
  if (READY_STAGES.has(stage)) return "ready";
  return "attention";
}

export function receiptWorkBuckets(batches = []) {
  return RECEIPT_WORK_BUCKETS.reduce((out, bucket) => {
    out[bucket] = (batches || []).filter((batch) => receiptWorkBucket(batch) === bucket);
    return out;
  }, { ready: [], attention: [], archive: [] });
}
