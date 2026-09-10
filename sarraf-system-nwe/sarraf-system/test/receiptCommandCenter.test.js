import test from "node:test";
import assert from "node:assert/strict";
import { receiptWorkBucket, receiptWorkBuckets } from "../src/services/receiptCommandCenter.js";

test("receipt command center puts actionable batches in attention", () => {
  assert.equal(receiptWorkBucket({ receipt_stage: "needs_review" }), "attention");
  assert.equal(receiptWorkBucket({ receipt_stage: "reading" }), "attention");
  assert.equal(receiptWorkBucket({ receipt_stage: "verified", rejected_n: 1 }), "ready");
});

test("receipt command center keeps ready and archived work distinct", () => {
  assert.equal(receiptWorkBucket({ receipt_stage: "matched" }), "archive");
  assert.equal(receiptWorkBucket({ receipt_stage: "finalized" }), "archive");
  assert.equal(receiptWorkBucket({ receipt_stage: "archived" }), "archive");
});

test("receipt command center preserves every batch exactly once", () => {
  const buckets = receiptWorkBuckets([
    { id: "a", receipt_stage: "needs_review" },
    { id: "b", receipt_stage: "verified" },
    { id: "c", receipt_stage: "archived" },
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(buckets).map(([key, rows]) => [key, rows.map((row) => row.id)])), {
    ready: ["b"], attention: ["a"], archive: ["c"],
  });
});

 test("completed and refused batches stay archived despite rejected evidence", () => {
  assert.equal(receiptWorkBucket({ receipt_stage: "matched", rejected_n: 2 }), "archive");
  assert.equal(receiptWorkBucket({ receipt_stage: "rejected" }), "archive");
  assert.equal(receiptWorkBucket({ tx_id: "tx-old" }), "archive");
  assert.equal(receiptWorkBucket({ receipt_stage: "verified", tx_id: null, dup_n: 1 }), "ready");
});
