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

/**
 * «سیستەمی پێشگرتن لە دووبارەبوونەوە (Hash)»
 *
 * The duplicate check has always accepted an image hash and the browser has always sent null, so
 * the rule that catches the same photograph twice has never once run. The database half is gated
 * by flow 17; what is here is that the browser sends the hash at all, and that it says which
 * receipt the image repeats.
 */
import { readFileSync as read } from "node:fs";
const appSource = read(new URL("../src/App.jsx", import.meta.url), "utf8");

test("the image hash is sent to the duplicate check", () => {
  assert.ok(!/p_hash: null/.test(appSource),
    "the browser still passes a null hash, so the same photograph twice is never caught");
  assert.match(appSource, /p_hash: img\.hash \|\| null/, "no hash reaches the duplicate check");
});

test("the check runs even when the reading found no reference", () => {
  assert.match(appSource, /if \(img\.hash \|\| rn \|\| merchantRn \|\|/,
    "an unreadable receipt is never checked for being a duplicate at all");
});

test("a receipt is not compared against itself", () => {
  assert.match(appSource, /p_exclude_id: id/,
    "the document is written before the image is read, so every first upload would match itself");
});

test("the refusal names the earlier receipt and what actually matched", () => {
  assert.match(appSource, /old\?\.tracking_code/, "the earlier receipt is named by nothing quotable");
  assert.match(appSource, /"هەمان وێنە پێشتر نێردراوە"/,
    "a repeated image is still reported as a repeated reference number");
  assert.match(appSource, /sameImage \? "same_image"/, "a repeated image is recorded under the wrong rule");
});

test("a repeat inside the same batch is caught by its image too", () => {
  assert.match(appSource, /\(img\.hash && r\.hash === img\.hash\) \|\|/,
    "the same photograph chosen twice in one batch is only caught if the reading found a reference");
});
