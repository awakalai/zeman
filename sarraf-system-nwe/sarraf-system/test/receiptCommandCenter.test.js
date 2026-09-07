import test from "node:test";
import assert from "node:assert/strict";
import { receiptWorkBucket, receiptWorkBuckets } from "../src/services/receiptCommandCenter.js";

test("receipt command center puts actionable batches in attention", () => {
  assert.equal(receiptWorkBucket({ receipt_stage: "needs_review" }), "attention");
  assert.equal(receiptWorkBucket({ receipt_stage: "reading" }), "attention");
  assert.equal(receiptWorkBucket({ receipt_stage: "verified", rejected_n: 1 }), "attention");
});

test("receipt command center keeps ready and archived work distinct", () => {
  assert.equal(receiptWorkBucket({ receipt_stage: "matched" }), "ready");
  assert.equal(receiptWorkBucket({ receipt_stage: "finalized" }), "ready");
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
