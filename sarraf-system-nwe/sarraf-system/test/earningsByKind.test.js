import test from "node:test";
import assert from "node:assert/strict";
import { EARNING_KINDS, earningsByKind } from "../src/services/earningsByKind.js";

// One dollar is 1,400 dinars and 7 yuan, on every date. Enough to check the arithmetic
// without making the test about rate history.
const RATE = { iqd: 1400, cny: 7, usd: 1 };
const usdValueAt = (amount, curId) =>
  RATE[curId] == null ? null : Number(amount) / RATE[curId];

const sale = (over) => ({ type: "sell", profit: 0, profitCurId: "usd", date: "2026-09-01", ...over });

test("an empty range earns nothing, in every kind", () => {
  const out = earningsByKind({ txs: [], usdValueAt });
  for (const kind of EARNING_KINDS) {
    assert.equal(out[kind].usd, 0);
    assert.equal(out[kind].n, 0);
    assert.equal(out[kind].unvalued, 0);
  }
});

test("a commission trade's earning is what arrived minus what left", () => {
  // «١٠٠ هەزار دینار ئێف ئایبی دەفرۆشم بە ١٠١ هەزار دیناری کاش» — 1,000 dinars, in dollars.
  const out = earningsByKind({
    txs: [{ businessFlow: "commission", curId: "iqd", amount: 100000,
            againstId: "iqd", total: 101000, date: "2026-09-01" }],
    usdValueAt,
  });
  assert.equal(out.commission.n, 1);
  assert.ok(Math.abs(out.commission.usd - 1000 / 1400) < 1e-12);
  // And it is nowhere else: the whole point is that the kinds do not bleed into each other.
  assert.equal(out.trade.usd, 0);
  assert.equal(out.direct.usd, 0);
});

test("a commission trade across two currencies is valued on both sides", () => {
  // 70,000 dinars (=50 USD) out, 357 yuan (=51 USD) in. The earning is a dollar.
  const out = earningsByKind({
    txs: [{ businessFlow: "commission", curId: "iqd", amount: 70000,
            againstId: "cny", total: 357, date: "2026-09-01" }],
    usdValueAt,
  });
  assert.ok(Math.abs(out.commission.usd - 1) < 1e-9, `earned ${out.commission.usd}`);
});

test("a commission trade at a loss is reported as a loss, not hidden", () => {
  const out = earningsByKind({
    txs: [{ businessFlow: "commission", curId: "iqd", amount: 100000,
            againstId: "iqd", total: 99000, date: "2026-09-01" }],
    usdValueAt,
  });
  assert.ok(out.commission.usd < 0, `it reads ${out.commission.usd}`);
});

test("an ordinary sale's spread is trading, and a direct one is its own kind", () => {
  const out = earningsByKind({
    txs: [sale({ profit: 10 }), sale({ profit: 4, direct: true })],
    usdValueAt,
  });
  assert.equal(out.trade.usd, 10);
  assert.equal(out.trade.n, 1);
  assert.equal(out.direct.usd, 4);
  assert.equal(out.direct.n, 1);
});

test("a partner-custody sale is buying and selling, not a fourth kind", () => {
  // Custody is where the goods sat. It is not a different way of earning, and splitting it out
  // would answer a question about storage with a number about profit.
  const out = earningsByKind({
    txs: [sale({ profit: 6, partnerId: "p-1", businessFlow: "partner_custody" })],
    usdValueAt,
  });
  assert.equal(out.trade.usd, 6);
  assert.equal(out.commission.n, 0);
});

test("a purchase earns nothing until it is sold", () => {
  const out = earningsByKind({ txs: [{ type: "buy", profit: 99, profitCurId: "usd" }], usdValueAt });
  assert.equal(out.trade.usd, 0);
  assert.equal(out.trade.n, 0);
});

test("a deleted transaction is not counted", () => {
  const out = earningsByKind({ txs: [sale({ profit: 50, deleted: true })], usdValueAt });
  assert.equal(out.trade.usd, 0);
});

test("a trade with no rate that day is set aside, never counted as zero", () => {
  // Counting it as zero would report less earning than there was, silently. It is counted
  // apart so the screen can say how many are missing.
  const out = earningsByKind({
    txs: [sale({ profit: 20, profitCurId: "xxx" }), sale({ profit: 5 })],
    usdValueAt,
  });
  assert.equal(out.trade.unvalued, 1);
  assert.equal(out.trade.n, 1);
  assert.equal(out.trade.usd, 5);
});

test("a commission trade with one unpriced side is set aside whole", () => {
  const out = earningsByKind({
    txs: [{ businessFlow: "commission", curId: "iqd", amount: 100,
            againstId: "xxx", total: 1, date: "2026-09-01" }],
    usdValueAt,
  });
  assert.equal(out.commission.unvalued, 1);
  assert.equal(out.commission.n, 0);
  assert.equal(out.commission.usd, 0);
});

test("without a way to value anything, nothing is invented", () => {
  const out = earningsByKind({ txs: [sale({ profit: 10 })], usdValueAt: null });
  for (const kind of EARNING_KINDS) assert.equal(out[kind].usd, 0);
});
