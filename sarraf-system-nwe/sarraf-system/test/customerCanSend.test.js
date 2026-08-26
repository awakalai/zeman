import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A customer-seller comes here to send receipts. That is the whole of their business with us.
 *
 * The screen used to open with an inbox — "receipts sent to you" — above an empty state and a
 * permission error, with no way to send anything at all. The send button existed, and appeared
 * only when the customer already had a purchase transaction.
 *
 * That is backwards, and it is a closed circle. The receipt is what becomes the transaction: the
 * owner's own description is that the customer uploads, the details arrive, and the owner makes
 * a transaction from them. So a new customer had no transaction, therefore no button, therefore
 * no way to ever get a transaction. The button that starts the process was waiting for the
 * process to have started.
 */

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

const portal = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} is gone`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end > start ? end : undefined);
};

const customer = portal("CustomerPortal");

test("sending a receipt is never gated on already having a transaction", () => {
  const gated = [...customer.matchAll(/uploadTransactions\.length > 0/g)];
  assert.equal(gated.length, 0,
    "the send button is hidden until the customer has a transaction, which they cannot get "
    + "without sending a receipt first");
});

test("the customer's receipt screen offers the way to send", () => {
  assert.ok(customer.includes('label={tr("ناردنی فیش")}'),
    "there is no send-a-receipt action on the customer's portal at all");
});

// Their own receipts come before anything sent back to them. An inbox at the top of a screen
// whose purpose is posting tells somebody they are in the wrong place.
test("what the customer sent comes before what was sent to them", () => {
  const archive = customer.indexOf("<ReceiptArchive");
  const forwarded = customer.indexOf("<ForwardedReceipts");
  assert.ok(archive > 0 && forwarded > 0, "one of the two receipt lists is missing");
  assert.ok(archive < forwarded,
    "receipts forwarded to the customer are shown above the receipts they sent");
});

// Being new is not an error. The summary is refused for somebody who has sent nothing, and drawn
// as a red failure that reads as "the system is broken" on the first screen they ever open.
test("an empty receipt summary is not drawn as a failure", () => {
  assert.ok(!source.includes('type="error" title={tr("پوختەی فیشەکان بار نەبوو")}'),
    "a customer with nothing to summarise is still shown an error panel");
});
