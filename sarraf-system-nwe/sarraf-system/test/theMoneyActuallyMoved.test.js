import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { convertReceiptBatchToTransaction } from "../src/services/receiptOperations.js";

/**
 * Converting a batch into a transaction is two calls, not one.
 *
 *   sarraf_convert_receipt_batch_to_transaction   creates the transaction
 *   sarraf_convert_receipt_batch_finish           confirms the money moved in the ledger
 *
 * The second one's failure was caught, turned into `ledger_confirmed: false`, returned — and
 * never read by anything. The screen said «مامەڵە تۆمار کرا ✓» either way. A transaction whose
 * money has not moved, reported with a tick, is the worst shape a failure can take in a system
 * whose whole job is knowing where the money is.
 */

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

const conversion = (finishResult) => ({
  rpc: async (fn) => {
    if (fn === "sarraf_convert_receipt_batch_to_transaction") {
      return { data: { transactions: [{ id: "tx-1", code: 41 }] }, error: null };
    }
    if (fn === "sarraf_convert_receipt_batch_finish") return finishResult;
    throw new Error(`unexpected call: ${fn}`);
  },
});

const args = {
  batchId: "b1", receiptIds: ["r1"],
  transaction: { type: "buy", status: "completed", cur_id: "cny" },
  reason: "فیشە پەسەندکراوەکان کرانە مامەڵە",
};

test("a confirmed ledger movement is reported as confirmed", async () => {
  const out = await convertReceiptBatchToTransaction(
    conversion({ data: { ledger_rows: 2 }, error: null }), args);
  assert.equal(out.ledger_confirmed, true);
  assert.equal(out.ledger_rows, 2);
});

test("a movement that could not be confirmed says so, and does not throw the conversion away", async () => {
  const out = await convertReceiptBatchToTransaction(
    conversion({ data: null, error: { message: "ledger locked" } }), args);
  assert.equal(out.ledger_confirmed, false, "an unconfirmed movement is reported as confirmed");
  assert.equal(out.ledger_error, "ledger locked");
  // The transaction committed before the second call. Losing it would be worse than not
  // confirming it, so the conversion is still returned in full.
  assert.equal(out.transactions[0].id, "tx-1");
});

test("the screen no longer ticks a transaction whose money did not move", () => {
  // The tick that follows a batch conversion must sit on the branch where the money moved.
  assert.match(app, /\} else \{\s*flash\(`مامەڵە تۆمار کرا ✓/,
    "the tick after a conversion is still printed whatever the ledger did");
  assert.match(app, /result\?\.ledger_confirmed === false/,
    "nothing reads whether the money moved");
  assert.match(app, /جووڵەی پارە لە دەفتەردا پشتڕاست نەکرایەوە/,
    "the owner is not told what actually happened");
});

// A message that disappears is not a record of a money failure.
test("a failed confirmation is written down, not only flashed", () => {
  assert.match(app, /notify\(profile\.id, "system", tr\("پشتڕاستکردنەوەی دەفتەر سەرکەوتوو نەبوو"\)/,
    "the warning vanishes with the toast and leaves no trace anybody can act on later");
});
