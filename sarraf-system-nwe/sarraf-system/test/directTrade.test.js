import test from "node:test";
import assert from "node:assert/strict";
import { directTradeLegs, filledSellers, firstIncompleteSeller } from "../src/services/directTrade.js";

// «لە جیاتی ئەوەی لە یەک کەسی بکڕم، لە چەند کەسێکی دەکڕم و بەڵام بە یەک کەسی دەفرۆشم.»
//
// The arithmetic the browser sends. sarraf_commit_transactions recomputes all of it and refuses
// the command if the two disagree, so these tests are what stop the owner meeting that refusal.

const round2 = (v) => Math.round(v * 100) / 100;

test("one seller is the trade it always was", () => {
  const out = directTradeLegs({ amount: 1000, buyRate: 0.14, sellRate: 0.15, rounder: round2 });
  assert.equal(out.legs.length, 1);
  assert.equal(out.soldAmount, 1000);
  assert.equal(out.boughtTotal, 140);
  assert.equal(out.sellTotal, 150);
  assert.equal(out.profit, 10);
});

test("what it sells is the sum of what it bought", () => {
  const out = directTradeLegs({
    amount: 400, buyRate: 0.14, sellRate: 0.15,
    extras: [{ amount: 300, rate: 0.145 }, { amount: 300, rate: 0.138 }],
    rounder: round2,
  });
  assert.equal(out.soldAmount, 1000);
  assert.equal(out.sellTotal, 150);
});

test("the earning counts every purchase, not the first one", () => {
  // 400 at 0.14 is 56, 300 at 0.145 is 43.50, 300 at 0.138 is 41.40 — 140.90 against a sale of
  // 150. Pricing against the first leg alone would call 94 of the cost profit, which is the
  // mistake 202609020018 removed from the server.
  const out = directTradeLegs({
    amount: 400, buyRate: 0.14, sellRate: 0.15,
    extras: [{ amount: 300, rate: 0.145 }, { amount: 300, rate: 0.138 }],
    rounder: round2,
  });
  assert.equal(out.boughtTotal, 140.9);
  assert.equal(out.profit, 9.1);
});

test("each leg keeps its own seller's price", () => {
  const out = directTradeLegs({
    amount: 400, buyRate: 0.14, sellRate: 0.15,
    extras: [{ amount: 300, rate: 0.145 }, { amount: 300, rate: 0.138 }],
    rounder: round2,
  });
  assert.deepEqual(out.legs.map((l) => l.rate), [0.14, 0.145, 0.138]);
  assert.deepEqual(out.legs.map((l) => l.total), [56, 43.5, 41.4]);
});

test("a trade can lose money and says so", () => {
  // Bought at more than it sold for. The screen must not hide it behind a zero.
  const out = directTradeLegs({
    amount: 500, buyRate: 0.16, sellRate: 0.15,
    extras: [{ amount: 500, rate: 0.16 }], rounder: round2,
  });
  assert.equal(out.boughtTotal, 160);
  assert.equal(out.sellTotal, 150);
  assert.equal(out.profit, -10);
});

test("a seller row nobody touched is not a seller", () => {
  const rows = [{ cpId: "", cpName: "", amount: "", quote: "" }];
  assert.equal(filledSellers(rows).length, 0);
  assert.equal(firstIncompleteSeller(rows), null);
});

test("a half-filled seller row is named, and by its position on the screen", () => {
  // The owner sees "فرۆشیاری ٣", not "row index 1".
  assert.deepEqual(
    firstIncompleteSeller([{ cpId: "c1", amount: 10, quote: 0.1 }, { cpId: "c2", amount: "", quote: "" }]),
    { position: 3, missing: "amount" });
  assert.deepEqual(
    firstIncompleteSeller([{ cpId: "", cpName: "", amount: 10, quote: 0.1 }]),
    { position: 2, missing: "person" });
  assert.deepEqual(
    firstIncompleteSeller([{ cpId: "c1", amount: 10, quote: "" }]),
    { position: 2, missing: "rate" });
});

test("a free-typed name is a seller, the same as a chosen one", () => {
  const rows = [{ cpId: "", cpName: "Somebody", amount: 10, quote: 0.1 }];
  assert.equal(filledSellers(rows).length, 1);
  assert.equal(firstIncompleteSeller(rows), null);
});

test("rounding happens per currency, at every step", () => {
  // Dinars take no decimals. A leg that rounds only at the end would send the server a sale
  // amount it disagrees with, and the command would be refused for a difference of one dinar.
  const whole = (v) => Math.round(v);
  const out = directTradeLegs({
    amount: 333.4, buyRate: 1, sellRate: 1,
    extras: [{ amount: 333.4, rate: 1 }, { amount: 333.4, rate: 1 }],
    rounder: whole,
  });
  assert.deepEqual(out.legs.map((l) => l.amount), [333, 333, 333]);
  assert.equal(out.soldAmount, 999);
});
