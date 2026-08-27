import test from "node:test";
import assert from "node:assert/strict";
import { reviewEquation } from "../src/services/receiptWorkspace.js";
import { validateReceiptArithmetic, receiptNetFrom } from "../src/services/receiptValidation.js";

/**
 * «ئاگاداربە، ئەکرێت فیشەکە ئەلیپەی بێت ئەکرێت ویچات بێت»
 *
 * The two platforms print the same transfer differently, and every rule that touches a receipt
 * has to survive both. WeChat prints 订单金额 / Order amount; Alipay frequently prints no order
 * amount at all, so the fee's treatment is genuinely ambiguous — 1,210 with 36.30 added on top
 * and 1,246.30 with 36.30 taken off are the same three numbers read from two sides.
 *
 * The database half is gated by flow 16. This is the half a database cannot check: that the
 * screen and the rule say the same thing about the same receipt. They did not — acceptance
 * succeeded while the screen said the figures could not be decided, which reads to a reviewer as
 * "the system does not know what it is doing".
 */

// Same money, both layouts.
const ALIPAY = { grossAmount: 1246.30, orderAmount: null, feeAmount: 36.30, netAmount: 1210.00,
                 feeTreatment: "unknown", currency: "CNY" };
const WECHAT = { grossAmount: 1246.30, orderAmount: 1210.00, feeAmount: 36.30, netAmount: 1210.00,
                 feeTreatment: "added_on_top", currency: "CNY" };

test("a WeChat receipt reconciles on its stated order amount", () => {
  const e = reviewEquation(WECHAT);
  assert.equal(e.reconciles, true);
  assert.equal(e.basis, "order");
  assert.equal(e.expectedGross, 1246.30);
});

test("an Alipay receipt with no order amount reconciles on gross minus fee", () => {
  const e = reviewEquation(ALIPAY);
  assert.equal(e.reconciles, true, "the screen still says a receipt that adds up cannot be decided");
  assert.equal(e.basis, "net", "the wrong statement was checked");
});

test("an order amount with no named treatment is read whichever way the gross matches", () => {
  const onTop = reviewEquation({ ...WECHAT, feeTreatment: "unknown" });
  assert.equal(onTop.reconciles, true);
  assert.equal(onTop.expectedGross, 1246.30);
  const inside = reviewEquation({
    grossAmount: 1210.00, orderAmount: 1210.00, feeAmount: 36.30, netAmount: 1173.70,
    feeTreatment: "unknown", currency: "CNY",
  });
  assert.equal(inside.reconciles, true, "a fee taken out of the principal was not recognised");
  assert.equal(inside.expectedGross, 1210.00);
});

// Relaxed, not removed.
test("numbers that cannot be got to from one another still do not reconcile", () => {
  assert.equal(reviewEquation({ ...ALIPAY, netAmount: 999 }).reconciles, false);
  assert.equal(reviewEquation({ ...WECHAT, grossAmount: 1300 }).reconciles, false);
});

test("a receipt with nothing to check is still undecidable, not falsely green", () => {
  assert.equal(reviewEquation({ grossAmount: 1246.30, feeAmount: null, netAmount: null }).reconciles, null);
  assert.equal(reviewEquation(null), null);
});

// The browser's own arithmetic has to agree with both layouts too, or a receipt is marked wrong
// on the phone that the owner then accepts — or the other way round.
test("the uploader's own check accepts both layouts and refuses neither wrongly", () => {
  const alipay = validateReceiptArithmetic({ amount: 1246.30, fee: 36.30, netAmount: 1210.00 });
  assert.equal(alipay.valid, true, alipay.issues.join(","));
  const wechat = validateReceiptArithmetic({ amount: 1246.30, fee: 36.30, orderAmount: 1210.00, netAmount: 1210.00 });
  assert.equal(wechat.valid, true, wechat.issues.join(","));
  const wrong = validateReceiptArithmetic({ amount: 1246.30, fee: 36.30, netAmount: 999 });
  assert.equal(wrong.valid, false);
});

test("the net a receipt contributes is the same on both layouts", () => {
  assert.equal(receiptNetFrom({ amount: 1246.30, fee: 36.30 }), 1210);
  assert.equal(receiptNetFrom({ amount: 1246.30, fee: 36.30, orderAmount: 1210 }), 1210);
});
