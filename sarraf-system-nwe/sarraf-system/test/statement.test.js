import test from "node:test";
import assert from "node:assert/strict";
import { partyStatement, formatMoney } from "../src/services/statement.js";

// «هیچ قازانج، عمولە یان data leakage بۆ کڕیار/هاوبەش/نووسینگە ڕوونەدات.» — section 21
//
// A statement is the one thing in this system that LEAVES it. A screen is read by somebody
// already signed in; a printed page is handed over, photographed and forwarded.

const party = { id: "cust-1", name: "ئاسۆ", phone: "07501234567" };

// Rows exactly as the app holds them — profit, cost basis, commission and tenant included.
const txs = [
  { id: "t1", code: 41, type: "sell", cpId: "cust-1", curId: "cny", amount: 1000,
    againstId: "usd", total: 140, date: "2026-08-10T09:00:00Z",
    profit: 12.5, profitCurId: "usd", buyRate: 0.1275, buyTotal: 127.5,
    costBasisUsd: 127.5, partnerFeeSnapshot: 7, tenantId: "t-sarkhel", businessFlow: "standard" },
  { id: "t2", code: 42, type: "buy", cpId: "cust-1", curId: "iqd", amount: 500000,
    againstId: "usd", total: 380, date: "2026-08-12T09:00:00Z", profit: 3.25 },
  { id: "t3", code: 43, type: "sell", cpId: "cust-2", curId: "cny", amount: 50,
    againstId: "usd", total: 7, date: "2026-08-13T09:00:00Z", profit: 99 },
  { id: "t4", code: 44, type: "sell", cpId: "cust-1", curId: "cny", amount: 10,
    againstId: "usd", total: 2, date: "2026-08-14T09:00:00Z", deleted: true },
];

const debts = [
  { id: "d1", debtorType: "customer", debtorId: "cust-1", creditorType: "zeman",
    currency: "USD", outstanding: 60, openedAt: "2026-08-11T09:00:00Z", reason: "مامەڵەی نەدراوە" },
  { id: "d2", debtorType: "customer", debtorId: "cust-2", creditorType: "zeman",
    currency: "USD", outstanding: 400, openedAt: "2026-08-11T09:00:00Z", reason: "کەسێکی تر" },
];

test("the statement carries only this person's lines", () => {
  const doc = partyStatement({ party, transactions: txs, debts });
  const printed = JSON.stringify(doc);
  assert.ok(!printed.includes("cust-2"), "somebody else's id reached the page");
  assert.ok(!printed.includes("کەسێکی تر"), "somebody else's debt reached the page");
  assert.equal(doc.sections[0].lines.length, 2, "a deleted transaction is not a line");
  assert.equal(doc.sections[1].lines.length, 1);
});

test("nothing the reader may not see appears anywhere on it", () => {
  // Not "the profit column is hidden" — the whole document is searched for every number and
  // name that must never leave the business.
  const printed = JSON.stringify(partyStatement({ party, transactions: txs, debts }));
  for (const secret of ["12.5", "3.25", "127.5", "0.1275", "t-sarkhel", "standard", "profit",
                        "buyTotal", "costBasis", "partnerFee", "99"]) {
    assert.ok(!printed.includes(secret), `the statement leaked ${secret}`);
  }
});

test("a line is built field by field, so a new column cannot arrive on it", () => {
  const doc = partyStatement({
    party,
    transactions: [{ ...txs[0], someColumnAddedNextYear: "SHOULD-NOT-APPEAR" }],
  });
  const line = doc.sections[0].lines[0];
  assert.deepEqual(Object.keys(line).sort(), ["amount", "date", "kind", "reference", "total"]);
  assert.ok(!JSON.stringify(doc).includes("SHOULD-NOT-APPEAR"));
});

test("what they traded, what they owe and what is held are totalled per currency", () => {
  const doc = partyStatement({ party, transactions: txs, debts,
    held: [{ currency: "USD", available: 25 }] });
  const usd = doc.totals.find((t) => t.currency === "USD");
  assert.equal(usd.traded, "520.00 USD", "140 + 380");
  assert.equal(usd.owed, "60.00 USD");
  assert.equal(usd.held, "25.00 USD");
});

test("a debt the business owes is labelled as ours, not theirs", () => {
  const doc = partyStatement({ party, transactions: [], debts: [
    { debtorType: "zeman", creditorType: "customer", creditorId: "cust-1",
      currency: "USD", outstanding: 90, openedAt: "2026-08-11T09:00:00Z" }] });
  const usd = doc.totals.find((t) => t.currency === "USD");
  assert.equal(usd.owed, "90.00 USD");
  assert.equal(usd.owedLabel, "ئێمە قەرزارین");
});

test("a period leaves out what falls outside it", () => {
  const doc = partyStatement({ party, transactions: txs, debts,
    from: "2026-08-12", to: "2026-08-13" });
  assert.equal(doc.sections[0].lines.length, 1);
  assert.equal(doc.sections[0].lines[0].reference, "#42");
  assert.equal(doc.sections[1].lines.length, 0, "a debt opened before the period is not in it");
});

test("no period means the whole history, and says so", () => {
  const doc = partyStatement({ party, transactions: txs, debts, lang: "en" });
  assert.equal(doc.period, null);
  assert.equal(doc.periodLabel, "The whole history");
});

test("dinars print without fractions and dollars with them", () => {
  assert.equal(formatMoney(250000, "IQD"), "250,000 IQD");
  assert.equal(formatMoney(250, "usd"), "250.00 USD");
});

test("all three languages produce a document in their own", () => {
  assert.equal(partyStatement({ party, lang: "ku" }).title, "کەشفی حساب");
  assert.equal(partyStatement({ party, lang: "en" }).title, "Statement of account");
  assert.equal(partyStatement({ party, lang: "ar" }).title, "كشف حساب");
});

test("an empty statement is a document, not a crash", () => {
  // Somebody with no history still asks for a statement, and handing them an error is worse
  // than handing them a page that says nothing was recorded.
  const doc = partyStatement({});
  assert.equal(doc.sections[0].lines.length, 0);
  assert.ok(doc.sections[0].empty);
  assert.deepEqual(doc.totals, []);
});
