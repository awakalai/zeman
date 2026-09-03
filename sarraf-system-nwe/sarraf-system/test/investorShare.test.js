import test from "node:test";
import assert from "node:assert/strict";
import {
  capitalAsOf, capitalEventsFrom, inScopeFor, investorShare,
  investorSharesForCurrency, investorsTotalByCurrency, profitEventsFrom, sharedCostEventsFrom,
  sharesForEvent,
} from "../src/services/investorShare.js";

const round = (n) => Math.round(n * 100) / 100;

// The owner puts in 50,000 in January. Ahmed puts in 50,000 on 5 August at a 50% rate.
const capital = [
  { date: "2026-01-01T00:00:00Z", curId: "usd", investorId: null, amount: 50000 },
  { date: "2026-08-05T00:00:00Z", curId: "usd", investorId: "ahmed", amount: 50000 },
];
const investors = [{ id: "ahmed", rate: 50, scope: [] }];

test("capital is read as it stood on the day, not as it stands now", () => {
  const before = capitalAsOf(capital, "usd", new Date("2026-07-01").getTime());
  assert.equal(before.self, 50000);
  assert.equal(before.byInvestor.ahmed ?? 0, 0);

  const after = capitalAsOf(capital, "usd", new Date("2026-08-10").getTime());
  assert.equal(after.byInvestor.ahmed, 50000);
});

// The defect this replaces, stated as a test.
test("an investor takes nothing from profit earned before they arrived", () => {
  const profitEvents = [{ date: "2026-03-01T00:00:00Z", curId: "usd", amount: 100000 }];
  const shares = investorSharesForCurrency({ profitEvents, capitalEvents: capital, investors, curId: "usd" });
  assert.equal(shares.ahmed ?? 0, 0);
});

test("an investor takes their share of profit earned after they arrived", () => {
  const profitEvents = [{ date: "2026-08-20T00:00:00Z", curId: "usd", amount: 10000 }];
  const shares = investorSharesForCurrency({ profitEvents, capitalEvents: capital, investors, curId: "usd" });
  // 10,000 × (50,000 / 100,000) × 50% = 2,500
  assert.equal(round(shares.ahmed), 2500);
});

// The worked example from the decision: 100,000 before, 10,000 after.
test("a mixed history pays only for the part they were present for", () => {
  const profitEvents = [
    { date: "2026-03-01T00:00:00Z", curId: "usd", amount: 100000 },
    { date: "2026-08-20T00:00:00Z", curId: "usd", amount: 10000 },
  ];
  const shares = investorSharesForCurrency({ profitEvents, capitalEvents: capital, investors, curId: "usd" });
  assert.equal(round(shares.ahmed), 2500, "only the August profit is shared");
});

test("profit earned on the very day capital arrives counts", () => {
  const profitEvents = [{ date: "2026-08-05T12:00:00Z", curId: "usd", amount: 10000 }];
  const shares = investorSharesForCurrency({ profitEvents, capitalEvents: capital, investors, curId: "usd" });
  assert.equal(round(shares.ahmed), 2500);
});

// The reverse unfairness the old rule also caused.
test("withdrawing later does not erase the share already earned", () => {
  const events = [...capital, { date: "2026-09-01T00:00:00Z", curId: "usd", investorId: "ahmed", amount: -50000 }];
  const profitEvents = [{ date: "2026-08-20T00:00:00Z", curId: "usd", amount: 10000 }];
  const shares = investorSharesForCurrency({ profitEvents, capitalEvents: events, investors, curId: "usd" });
  assert.equal(round(shares.ahmed), 2500);
});

test("profit after a withdrawal is no longer shared", () => {
  const events = [...capital, { date: "2026-09-01T00:00:00Z", curId: "usd", investorId: "ahmed", amount: -50000 }];
  const profitEvents = [{ date: "2026-09-10T00:00:00Z", curId: "usd", amount: 10000 }];
  const shares = investorSharesForCurrency({ profitEvents, capitalEvents: events, investors, curId: "usd" });
  assert.equal(shares.ahmed ?? 0, 0);
});

test("capital added in stages is weighted by what was in at each point", () => {
  const events = [
    { date: "2026-01-01", curId: "usd", investorId: null, amount: 100000 },
    { date: "2026-05-01", curId: "usd", investorId: "ahmed", amount: 100000 },
  ];
  const profitEvents = [
    { date: "2026-03-01", curId: "usd", amount: 1000 },   // ahmed absent
    { date: "2026-06-01", curId: "usd", amount: 1000 },   // ahmed at half
  ];
  const shares = investorSharesForCurrency({ profitEvents, capitalEvents: events, investors, curId: "usd" });
  assert.equal(round(shares.ahmed), 250);                  // 1000 × 0.5 × 50%
});

// ── fairness across several investors ────────────────────────────────────────

test("two investors split by the capital each had at the time", () => {
  const events = [
    { date: "2026-01-01", curId: "usd", investorId: null, amount: 50000 },
    { date: "2026-01-01", curId: "usd", investorId: "a", amount: 25000 },
    { date: "2026-06-01", curId: "usd", investorId: "b", amount: 25000 },
  ];
  const people = [{ id: "a", rate: 100, scope: [] }, { id: "b", rate: 100, scope: [] }];
  const profitEvents = [
    { date: "2026-03-01", curId: "usd", amount: 750 },   // a only: 25/75
    { date: "2026-07-01", curId: "usd", amount: 1000 },  // a and b: 25/100 each
  ];
  const shares = investorSharesForCurrency({ profitEvents, capitalEvents: events, investors: people, curId: "usd" });
  assert.equal(round(shares.a), round(250 + 250));
  assert.equal(round(shares.b), 250);
});

// Nobody can be paid more than the profit itself.
test("the shares never exceed the profit they come from", () => {
  const events = [
    { date: "2026-01-01", curId: "usd", investorId: "a", amount: 50000 },
    { date: "2026-01-01", curId: "usd", investorId: "b", amount: 50000 },
  ];
  const people = [{ id: "a", rate: 100, scope: [] }, { id: "b", rate: 100, scope: [] }];
  const shares = investorSharesForCurrency({
    profitEvents: [{ date: "2026-02-01", curId: "usd", amount: 1000 }],
    capitalEvents: events, investors: people, curId: "usd",
  });
  const total = Object.values(shares).reduce((s, v) => s + v, 0);
  assert.ok(total <= 1000 + 1e-9, `shares totalled ${total}`);
});

// An account withdrawn past zero must not hand the others more than the whole profit.
test("a negative balance is treated as none rather than inverting the weights", () => {
  const events = [
    { date: "2026-01-01", curId: "usd", investorId: null, amount: 10000 },
    { date: "2026-01-01", curId: "usd", investorId: "a", amount: 10000 },
    { date: "2026-01-01", curId: "usd", investorId: "b", amount: -5000 },
  ];
  const people = [{ id: "a", rate: 100, scope: [] }, { id: "b", rate: 100, scope: [] }];
  const shares = investorSharesForCurrency({
    profitEvents: [{ date: "2026-02-01", curId: "usd", amount: 1000 }],
    capitalEvents: events, investors: people, curId: "usd",
  });
  assert.equal(shares.b ?? 0, 0);
  assert.equal(round(shares.a), 500);   // 10,000 of 20,000
});

test("a loss is shared on the same weighting rather than silently ignored", () => {
  const shares = investorSharesForCurrency({
    profitEvents: [{ date: "2026-08-20", curId: "usd", amount: -10000 }],
    capitalEvents: capital, investors, curId: "usd",
  });
  assert.equal(round(shares.ahmed), -2500);
});

test("profit earned when nobody had capital is nobody's to share", () => {
  const shares = investorSharesForCurrency({
    profitEvents: [{ date: "2026-01-01", curId: "usd", amount: 1000 }],
    capitalEvents: [], investors, curId: "usd",
  });
  assert.deepEqual(shares, {});
});

// ── scope ────────────────────────────────────────────────────────────────────

test("an empty scope means every currency", () => {
  assert.equal(inScopeFor({ scope: [] }, "usd"), true);
  assert.equal(inScopeFor({}, "iqd"), true);
});

test("a declared scope excludes the currencies it leaves out", () => {
  assert.equal(inScopeFor({ scope: ["cny"] }, "cny"), true);
  assert.equal(inScopeFor({ scope: ["cny"] }, "usd"), false);
});

test("an out-of-scope investor takes nothing and does not dilute the others", () => {
  const events = [
    { date: "2026-01-01", curId: "usd", investorId: null, amount: 50000 },
    { date: "2026-01-01", curId: "usd", investorId: "a", amount: 50000 },
    { date: "2026-01-01", curId: "usd", investorId: "b", amount: 100000 },
  ];
  const people = [{ id: "a", rate: 100, scope: [] }, { id: "b", rate: 100, scope: ["cny"] }];
  const shares = investorSharesForCurrency({
    profitEvents: [{ date: "2026-02-01", curId: "usd", amount: 1000 }],
    capitalEvents: events, investors: people, curId: "usd",
  });
  assert.equal(shares.b ?? 0, 0);
  assert.equal(round(shares.a), 500, "the out-of-scope capital must not change a's weight");
});

// ── reading the events out of the app's own data ─────────────────────────────

test("only shared sale profit becomes a profit event", () => {
  const events = profitEventsFrom([
    { type: "sell", profit: 100, profitCurId: "usd", date: "2026-08-01T00:00:00Z" },
    { type: "buy", profit: 50, profitCurId: "usd", date: "2026-08-01T00:00:00Z" },
    { type: "sell", profit: 70, profitCurId: "usd", date: "2026-08-01T00:00:00Z", direct: true },
    { type: "sell", profit: 60, profitCurId: "usd", date: "2026-08-01T00:00:00Z", deleted: true },
    { type: "sell", profit: null, profitCurId: "usd", date: "2026-08-01T00:00:00Z" },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].amount, 100);
});

test("a date range bounds the events, inclusively", () => {
  const txs = [
    { type: "sell", profit: 1, profitCurId: "usd", date: "2026-07-31T23:00:00Z" },
    { type: "sell", profit: 2, profitCurId: "usd", date: "2026-08-01T10:00:00Z" },
    { type: "sell", profit: 3, profitCurId: "usd", date: "2026-08-31T23:00:00Z" },
    { type: "sell", profit: 4, profitCurId: "usd", date: "2026-09-01T00:00:00Z" },
  ];
  const events = profitEventsFrom(txs, { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(events.map((e) => e.amount), [2, 3]);
});

test("capital events keep the owner's own capital separate from an investor's", () => {
  const events = capitalEventsFrom([
    { type: "deposit", owner: "investor", investorId: "a", curId: "usd", amount: 100, date: "2026-01-01" },
    { type: "deposit", owner: "self", curId: "usd", amount: 200, date: "2026-01-01" },
    { type: "withdraw", owner: "investor", investorId: "a", curId: "usd", amount: -50, date: "2026-02-01" },
    { type: "expense", curId: "usd", amount: -10, date: "2026-02-01" },
  ]);
  assert.equal(events.length, 3, "only deposits and withdrawals are capital");
  const at = capitalAsOf(events, "usd", new Date("2026-03-01").getTime());
  assert.equal(at.self, 200);
  assert.equal(at.byInvestor.a, 50);
});

// ── the totals the report subtracts ──────────────────────────────────────────

test("totals are reported per currency and never combined", () => {
  const events = [
    { date: "2026-01-01", curId: "usd", investorId: null, amount: 50000 },
    { date: "2026-01-01", curId: "usd", investorId: "ahmed", amount: 50000 },
    { date: "2026-01-01", curId: "iqd", investorId: null, amount: 1000 },
    { date: "2026-01-01", curId: "iqd", investorId: "ahmed", amount: 1000 },
  ];
  const totals = investorsTotalByCurrency({
    profitEvents: [
      { date: "2026-02-01", curId: "usd", amount: 1000 },
      { date: "2026-02-01", curId: "iqd", amount: 400 },
    ],
    capitalEvents: events, investors, currencies: [{ id: "usd" }, { id: "iqd" }],
  });
  assert.equal(round(totals.usd), 250);
  assert.equal(round(totals.iqd), 100);
});

test("a currency with no shareable profit is left out rather than reported as zero", () => {
  const totals = investorsTotalByCurrency({
    profitEvents: [{ date: "2026-02-01", curId: "usd", amount: 1000 }],
    capitalEvents: capital, investors, currencies: [{ id: "usd" }, { id: "iqd" }],
  });
  assert.equal("iqd" in totals, false);
});

test("one investor's own figure matches their entry in the totals", () => {
  const args = {
    profitEvents: [{ date: "2026-08-20", curId: "usd", amount: 10000 }],
    capitalEvents: capital, investors,
  };
  const one = investorShare({ ...args, investorId: "ahmed", curId: "usd" });
  const all = investorsTotalByCurrency({ ...args, currencies: [{ id: "usd" }] });
  assert.equal(round(one), round(all.usd));
});

test("nothing at all is handled without error", () => {
  assert.deepEqual(investorSharesForCurrency({ curId: "usd" }), {});
  assert.deepEqual(capitalEventsFrom(null), []);
  assert.deepEqual(profitEventsFrom(null), []);
  assert.deepEqual(sharesForEvent({ profit: 0, curId: "usd", capital: { self: 0, byInvestor: {} }, investors: [] }), {});
});

// ── «خەرجی لە قاسەی گشتی — بەڵێ، بەپێی ڕێژەکەیان» ─────────────────────────────────────────────
//
// An expense paid out of the general safe is a cost of the shared business, so it comes off the
// pool before the pool is divided. The owner confirmed this is what should happen; an expense
// paid out of their own safe stays theirs alone.

test("only an expense from the general safe becomes a shared cost", () => {
  const ledger = [
    { type: "expense", paidFrom: "general", curId: "usd", amount: -400, date: "2026-09-01T00:00:00Z" },
    { type: "expense", paidFrom: "own", curId: "usd", amount: -900, date: "2026-09-01T00:00:00Z" },
    // Recorded before the question was ever asked: the owner's alone, as every screen has
    // always treated it.
    { type: "expense", paidFrom: null, curId: "usd", amount: -700, date: "2026-09-01T00:00:00Z" },
    { type: "deposit", owner: "self", curId: "usd", amount: 5000, date: "2026-09-01T00:00:00Z" },
    { type: "partner_fee", curId: "usd", amount: -50, date: "2026-09-01T00:00:00Z" },
  ];
  assert.deepEqual(sharedCostEventsFrom(ledger), [
    { date: "2026-09-01T00:00:00Z", curId: "usd", amount: -400 },
  ]);
});

test("a shared cost keeps the ledger's own sign rather than being negated twice", () => {
  const [only] = sharedCostEventsFrom([
    { type: "expense", paidFrom: "general", curId: "usd", amount: -400, date: "2026-09-01T00:00:00Z" },
  ]);
  assert.equal(only.amount < 0, true);
});

test("an expense from the general safe takes the investor's share down with it", () => {
  // 1,000 earned and 400 spent on 20 August, when the owner and Ahmed each hold 50,000. Ahmed's
  // rate is 50%, so his share of the pool is 25% of it: 250 of the profit, less 100 of the cost.
  const shares = investorSharesForCurrency({
    profitEvents: [
      { date: "2026-08-20T00:00:00Z", curId: "usd", amount: 1000 },
      ...sharedCostEventsFrom([
        { type: "expense", paidFrom: "general", curId: "usd", amount: -400,
          date: "2026-08-20T00:00:00Z" },
      ]),
    ],
    capitalEvents: capital, investors, curId: "usd",
  });
  assert.equal(round(shares.ahmed), 150);
});

test("an expense from the owner's own safe leaves the investor's share alone", () => {
  const shares = investorSharesForCurrency({
    profitEvents: [
      { date: "2026-08-20T00:00:00Z", curId: "usd", amount: 1000 },
      ...sharedCostEventsFrom([
        { type: "expense", paidFrom: "own", curId: "usd", amount: -400,
          date: "2026-08-20T00:00:00Z" },
      ]),
    ],
    capitalEvents: capital, investors, curId: "usd",
  });
  assert.equal(round(shares.ahmed), 250);
});

test("a cost carried before an investor arrived is not theirs to carry", () => {
  // The same fairness that keeps them out of profit earned before they came.
  const shares = investorSharesForCurrency({
    profitEvents: sharedCostEventsFrom([
      { type: "expense", paidFrom: "general", curId: "usd", amount: -400,
        date: "2026-03-01T00:00:00Z" },
    ]),
    capitalEvents: capital, investors, curId: "usd",
  });
  assert.equal(shares.ahmed ?? 0, 0);
});

test("a shared cost outside the reported range is not counted in it", () => {
  const ledger = [
    { type: "expense", paidFrom: "general", curId: "usd", amount: -400, date: "2026-08-20T00:00:00Z" },
    { type: "expense", paidFrom: "general", curId: "usd", amount: -900, date: "2026-09-20T00:00:00Z" },
  ];
  const inAugust = sharedCostEventsFrom(ledger, { from: "2026-08-01", to: "2026-08-31" });
  assert.equal(inAugust.length, 1);
  assert.equal(inAugust[0].amount, -400);
});

test("the whole cost is carried between the owner and the investors, and no more", () => {
  // What makes the books balance: the money that left the safe is borne exactly once. Ahmed
  // carries his quarter of it and the owner carries the rest — never more than 400 between them.
  const costOnly = sharedCostEventsFrom([
    { type: "expense", paidFrom: "general", curId: "usd", amount: -400,
      date: "2026-08-20T00:00:00Z" },
  ]);
  const totals = investorsTotalByCurrency({
    profitEvents: costOnly, capitalEvents: capital, investors, currencies: [{ id: "usd" }],
  });
  assert.equal(round(totals.usd), -100);
  assert.equal(round(-400 - totals.usd), -300);
});

test("nothing at all is a shared cost of nothing", () => {
  assert.deepEqual(sharedCostEventsFrom(null), []);
  assert.deepEqual(sharedCostEventsFrom([{ type: "expense", paidFrom: "general", curId: "usd",
                                           amount: 0, date: "2026-09-01T00:00:00Z" }]), []);
});
