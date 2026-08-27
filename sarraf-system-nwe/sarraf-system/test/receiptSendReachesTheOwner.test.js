import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * "هیچ وردەکاری پیشان نادات ، هیچیش ناچێت بۆ خاوەن کار."
 *
 * Two separate faults, one on each half of the journey, and neither of them was about receipts.
 *
 * 1. The claim. sarraf_receipt_intake_begin refused a receipt that named no transaction, so a
 *    customer-seller — who by definition has none yet — never got past the first call. The
 *    screen reported that as an unreadable image: no details, nothing to send.
 *
 * 2. The send. Choosing images built the batch command by hand, with a batch id and no
 *    idempotency key. `send()` fills one in only when the ref is still empty, and it never was.
 *    So `p_command_key` was undefined, JSON.stringify dropped it, PostgREST could not find a
 *    three-argument function with two arguments, and the ingestion RPC was reported missing.
 *    The fallback route received the same nothing. Nothing has reached an owner since.
 *
 * 3. And one that only bites a real batch: public.receipts declares `amount not null check
 *    (amount > 0)`, and the ingestion command checks every row including the rejected ones. One
 *    image that was not a receipt at all refused the whole send with `invalid amount`.
 */

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const intake = readFileSync(new URL("../src/services/receiptIntake.js", import.meta.url), "utf8");

test("the batch command is minted whole, with the idempotency key the RPC demands", () => {
  assert.ok(!/receiptCommandRef\.current \|\|= \{/.test(source),
    "the batch command is still built by hand, so it carries no idempotency key and the "
    + "ingestion RPC is called with p_command_key missing");
  const uses = [...source.matchAll(/receiptCommandRef\.current \|\|= ([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(uses.length >= 1, "nothing creates the batch command any more");
  for (const use of uses) {
    assert.equal(use, "createReceiptIngestionCommand()",
      `the batch command comes from ${use}, which is not the one place that mints both halves`);
  }
});

test("the durable claim asks for no transaction the customer-seller cannot have", () => {
  assert.match(intake, /p_transaction_id: transactionId \|\| null/,
    "the claim no longer passes a null transaction through");
  assert.ok(!/if \(!transactionId\)/.test(intake),
    "the intake still refuses a receipt that names no transaction");
});

test("a receipt with no figures is left out of the batch rather than refusing it", () => {
  assert.match(source, /const storable = \(row\) => Number\(row\?\.amount\) > 0/,
    "every rejected row still travels, including ones with no amount, which the database "
    + "refuses for the whole batch");
  assert.match(source, /const sendRows = \[\.\.\.counted, \.\.\.evidence\.filter\(storable\)\]/,
    "the send still includes evidence rows the receipts table cannot store");
});

// A send that reported success and recorded every receipt as rejected.
//
// sarraf_ingest_receipt_batch decides what it keeps with
//
//   v_accept := coalesce(r->>'intake_status','')='accepted' and ...
//
// and makeReceipt has never sent that field. So v_accept was false for every row on every send
// this installation has ever made: the batch committed, the browser said "n فیش نێردرا ✓", and
// each receipt was written as rejected with "فیشەکە یاساکانی ناردنی نەبڕیوە" — a batch closed
// with nothing in it.
test("the send states the verdict the command asks for", () => {
  assert.match(source, /intake_status: r\.status === "ok" && r\.counted !== false \? "accepted" : "rejected"/,
    "makeReceipt does not send intake_status, so the command accepts nothing");
});

test("the verdict is the browser's claim, not a way past the command's own checks", () => {
  // Only a row this browser counted may claim acceptance; everything else travels as evidence.
  assert.ok(!/intake_status:\s*"accepted"\s*,/.test(source),
    "a row is hard-coded as accepted rather than stating what was actually decided");
});
