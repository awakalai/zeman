import test from "node:test";
import assert from "node:assert/strict";
import { batchStage, todaysWork } from "../src/services/todaysWork.js";

test("a batch that says its own stage is taken at its word", () => {
  assert.equal(batchStage({ receipt_stage: "verified", tx_id: "tx-1" }), "verified");
});

test("a batch too old to say is read from what else it says", () => {
  // Written before receipt_stage existed. Turned into a transaction, so it is matched;
  // otherwise new means nobody has looked at it, and anything else has been looked at.
  assert.equal(batchStage({ tx_id: "tx-1" }), "matched");
  assert.equal(batchStage({ status: "new" }), "needs_review");
  assert.equal(batchStage({ status: "ok" }), "verified");
  assert.equal(batchStage(null), "received");
});

test("only the stages where somebody still has to do something are waiting", () => {
  const out = todaysWork({
    batches: [
      { receipt_stage: "received", n: 2 },
      { receipt_stage: "needs_review", n: 3 },
      { receipt_stage: "verified", n: 1 },
      { receipt_stage: "matched", n: 40 },     // already money
      { receipt_stage: "finalized", n: 90 },   // and checked
    ],
  });
  assert.equal(out.waitingBatches, 3);
  assert.equal(out.waitingReceipts, 6);
  assert.equal(out.needsPerson, 1);
});

test("the headline counts batches, not the receipts inside them", () => {
  // One afternoon's work reading as ninety separate jobs is how a number stops being read.
  const out = todaysWork({ batches: [{ receipt_stage: "received", n: 90 }] });
  assert.equal(out.waitingReceipts, 90);
  assert.equal(out.total, 1);
});

test("what has already been dealt with is not in the headline", () => {
  // The system stopped a duplicate and said why; the sender can send another. Counting those
  // would leave a number that never reaches zero.
  const out = todaysWork({
    batches: [{ receipt_stage: "matched", rejected_n: 4, dup_n: 2 }],
  });
  assert.equal(out.refused, 4);
  assert.equal(out.duplicates, 2);
  assert.equal(out.total, 0);
});

test("a deleted transaction is not waiting to be paid", () => {
  const out = todaysWork({
    txs: [
      { status: "pending" },
      { status: "pending", deleted: true },
      { status: "completed" },
    ],
  });
  assert.equal(out.unpaid, 1);
});

test("only a pending approval is waiting on a decision", () => {
  const out = todaysWork({
    approvals: [{ status: "pending" }, { status: "approved" }, { status: "rejected" }],
  });
  assert.equal(out.approvals, 1);
});

test("an office is owed only where the balance is above zero", () => {
  const out = todaysWork({
    users: [
      { id: "off-1", name: "One", role: "office" },
      { id: "off-2", name: "Two", role: "office" },
      { id: "off-3", name: "Three", role: "office" },
      { id: "off-x", name: "Gone", role: "office", deleted: true },
      { id: "cus-1", name: "Customer", role: "customer" },
    ],
    officeCash: {
      "off-1": { usd: 500, iqd: 0 },
      // The office holding the owner's money is the other direction, and another screen's
      // question. It is not a debt and must not be listed as one.
      "off-2": { usd: -200 },
      "off-3": {},
      "off-x": { usd: 900 },
      "cus-1": { usd: 700 },
    },
  });
  assert.deepEqual(out.officesOwed, [
    { id: "off-1", name: "One", owed: [{ curId: "usd", amount: 500 }] },
  ]);
});

test("the headline is the sum of the things that are actually waiting", () => {
  const out = todaysWork({
    batches: [{ receipt_stage: "received" }, { receipt_stage: "reading" }],
    txs: [{ status: "pending" }],
    approvals: [{ status: "pending" }, { status: "pending" }],
    unpricedCurrencies: ["cny"],
    users: [{ id: "off-1", name: "One", role: "office" }],
    officeCash: { "off-1": { usd: 5 } },
  });
  assert.equal(out.total, 2 + 1 + 2 + 1 + 1);
});

test("an empty day says nothing is waiting rather than throwing", () => {
  const out = todaysWork();
  assert.equal(out.total, 0);
  assert.deepEqual(out.officesOwed, []);
  assert.deepEqual(out.unpriced, []);
});

test("the unpriced list is copied, so a caller cannot edit the currencies out from under it", () => {
  const given = ["cny"];
  const out = todaysWork({ unpricedCurrencies: given });
  given.push("iqd");
  assert.deepEqual(out.unpriced, ["cny"]);
});
