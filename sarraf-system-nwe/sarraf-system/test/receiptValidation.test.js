import test from "node:test";
import assert from "node:assert/strict";
import { arithmeticObjection, classifyReceiptSet, receiptIdentity, validateReceiptArithmetic } from "../src/services/receiptValidation.js";
import { verifiedFishReceipts } from "./fixtures/verified-fish-receipts.js";

test("all supplied receipt calculations reconcile to the visible gross, fee, and net values", () => {
  const classified = classifyReceiptSet(verifiedFishReceipts);
  assert.deepEqual(classified.filter((item) => !item.validation.valid), []);
  assert.equal(classified.reduce((sum, item) => sum + (item.duplicate ? 0 : item.validation.gross), 0), 13622.65);
  assert.equal(classified.reduce((sum, item) => sum + (item.duplicate ? 0 : item.validation.fee), 0), 367.65);
  assert.equal(classified.reduce((sum, item) => sum + (item.duplicate ? 0 : item.validation.netAmount), 0), 13255.00);
});

test("the ten supplied images resolve to nine unique transactions", () => {
  const classified = classifyReceiptSet(verifiedFishReceipts);
  assert.equal(classified.filter((item) => !item.duplicate).length, 9);
  assert.deepEqual(classified.filter((item) => item.duplicate).map((item) => [item.id, item.duplicateOf]), [["r10", "r5"]]);
});

test("same amount does not create a false duplicate when order numbers differ", () => {
  const sameAmount = verifiedFishReceipts.filter((item) => item.amount === 1261.75);
  assert.equal(new Set(sameAmount.map(receiptIdentity)).size, 3);
  assert.equal(classifyReceiptSet(sameAmount).filter((item) => item.duplicate).length, 0);
});

test("mismatched arithmetic is held for review", () => {
  const result = validateReceiptArithmetic({ amount: 100, fee: 3, orderAmount: 90, netAmount: 90 });
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues, ["gross_order_fee_mismatch"]);
});

// The receipt on the owner's phone, 27 August, and the sentence it was given:
//
//   ژمارەکان یەک ناگرنەوە: 1,246.30 − 36.30 = 0.00، بەڵام 1,210.00 نووسراوە
//
// 1246.30 − 36.30 is 1210.00. The reader returns "orderAmount": "0" when a receipt states no
// separate order amount, and `expectedNet = order ?? (gross - fee)` kept that zero, because ??
// falls through on null and not on 0. Every honest Alipay receipt was accused of arithmetic it
// had got right, and refused at the send gate for it.
test("an order amount of zero means the receipt states none", () => {
  const receipt = { amount: 1246.30, fee: 36.30, orderAmount: 0, netAmount: 1210.00 };
  assert.equal(arithmeticObjection(receipt), null);
  const checked = validateReceiptArithmetic(receipt);
  assert.equal(checked.valid, true);
  assert.equal(checked.orderAmount, null);
  assert.equal(checked.netAmount, 1210);
});

test("a real order amount is still checked against the gross", () => {
  // 1210 + 36.30 = 1246.30, so this one reconciles.
  assert.equal(arithmeticObjection(
    { amount: 1246.30, fee: 36.30, orderAmount: 1210, netAmount: 1210 }), null);
  // And this one does not, and must still say so.
  const wrong = arithmeticObjection(
    { amount: 1246.30, fee: 36.30, orderAmount: 900, netAmount: 900 });
  assert.ok(wrong, "a genuine mismatch stopped being reported");
  assert.ok(wrong.issues.includes("gross_order_fee_mismatch"));
});

test("a net that cannot be reached from the other two is still refused", () => {
  const wrong = arithmeticObjection(
    { amount: 1246.30, fee: 36.30, orderAmount: 0, netAmount: 999 });
  assert.ok(wrong, "a wrong net was accepted");
  assert.ok(wrong.issues.includes("net_amount_mismatch"));
  assert.match(wrong.reason, /1,210\.00/);
});
