import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RECEIPT_REVIEW_STATES, enterReadingByHand } from "../src/services/receiptWorkspace.js";

/**
 * A receipt the machine could not read.
 *
 * The reader is good and it is not infallible, and when it failed for good the receipt was in a
 * room with no doors: `correct` refused because there was nothing to correct, `accept` refused
 * because there was nothing to accept, and the queue never showed it in the first place. The
 * only move was to reject a receipt for real money.
 */

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../src/components/receipts/ReceiptReviewWorkspace.jsx", import.meta.url), "utf8");

test("a reading that failed for good is one a reviewer is shown", () => {
  assert.ok(RECEIPT_REVIEW_STATES.includes("ocr_failed_retryable"),
    "the images that most need a person are the ones a person never sees");
});

test("a hand-written reading needs a reason a person can be held to", async () => {
  const refuse = { rpc: () => { throw new Error("the command was called without a reason"); } };
  await assert.rejects(
    () => enterReadingByHand(refuse, { documentId: "d1", reading: { grossAmount: 1 }, reason: "کورت" }),
    /٨ پیت/);
  await assert.rejects(
    () => enterReadingByHand(refuse, { documentId: "d1", reading: null, reason: "هۆکارێکی دروست" }),
    /خوێندنەوە/);
});

test("the reading and the reason both reach the command", async () => {
  let sent = null;
  const client = { rpc: async (fn, args) => { sent = { fn, args }; return { data: { ok: true }, error: null }; } };
  await enterReadingByHand(client, {
    documentId: "d1", reading: { grossAmount: 836.3 }, reason: "خوێنەرەکە نەیتوانی",
  });
  assert.equal(sent.fn, "sarraf_receipt_enter_reading");
  assert.deepEqual(sent.args.p_reading, { grossAmount: 836.3 });
  assert.equal(sent.args.p_document_id, "d1");
  assert.match(sent.args.p_command_key, /^receipt-hand:d1:/);
  assert.ok(sent.args.p_command_key.length >= 12,
    "the command log refuses a key shorter than twelve characters, so a replay would be lost");
});

test("the workspace offers the form exactly where the road used to end", () => {
  assert.match(workspace, /\) : !detail\.current \? \(/,
    "a receipt with no reading still shows the accept and correct buttons, both of which refuse");
  assert.match(workspace, /enterReadingByHand\(client, \{/, "nothing calls the command");
  assert.match(workspace, /copy\.unread/, "the reviewer is not told why there is nothing to look at");
});

// The correction path corrects; the hand-entry path writes a first reading. Confusing them
// would let somebody replace what the machine actually read, which is the one thing the audit
// trail exists to prevent.
test("writing a first reading and correcting one are kept apart", () => {
  assert.match(workspace, /handEntry \? \(/, "the two forms share one state");
  assert.match(workspace, /setHandEntry\(null\)/, "the hand-entry form cannot be cancelled");
  assert.ok(!/setEditing\(\{ \.\.\.handEntry/.test(workspace),
    "a hand-written reading is being fed into the correction command");
});

// A rule that could not run is not a rule that passed.
test("a duplicate check that failed stops the receipt for a person", () => {
  assert.ok(!/if \(hit\?\.length\) old = hit\[0\];\s*\} catch \{\}/.test(app),
    "a failed duplicate check is still swallowed, so the receipt looks as though it passed");
  assert.match(app, /dupeCheckFailed = cause\?\.message/, "the failure is not recorded at all");
  assert.match(app, /پشکنینی دووبارەبوونەوە نەکرا/,
    "nobody is told that the duplicate rule did not run");
});
