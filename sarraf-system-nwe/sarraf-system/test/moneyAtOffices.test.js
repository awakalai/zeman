import test from "node:test";
import assert from "node:assert/strict";
import { loadMoneyAtOffices, moneyAtOfficeText } from "../src/services/accounting.js";

const clientReturning = (data) => {
  const calls = [];
  return { calls, rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data, error: null }); } };
};

const ROW = {
  assignment_id: "asg-1", transaction_id: "tx-1", transaction_code: "T-9",
  office_id: "off-1", office_name: "نووسینگەی هەولێر", currency: "CNY",
  amount: "5000", amount_paid: "0", outstanding: "5000",
  status: "assigned", assigned_at: "2026-09-01T10:00:00Z", due_at: null,
  advance_held: false,
};

test("the subject travels to the server rather than being applied here", async () => {
  const client = clientReturning([ROW]);
  await loadMoneyAtOffices(client, "cust-7");
  assert.equal(client.calls[0].fn, "sarraf_my_money_at_offices");
  assert.deepEqual(client.calls[0].args, { p_subject_id: "cust-7" });
});

test("asking for nobody in particular asks for oneself", async () => {
  const client = clientReturning([]);
  await loadMoneyAtOffices(client);
  assert.equal(client.calls[0].args.p_subject_id, null);
});

test("the amounts come back as numbers, not as strings to concatenate", async () => {
  const [row] = await loadMoneyAtOffices(clientReturning([ROW]));
  assert.equal(row.amount, 5000);
  assert.equal(row.outstanding, 5000);
  assert.equal(row.amountPaid, 0);
  assert.equal(row.officeName, "نووسینگەی هەولێر");
});

// The two sentences say different things and the difference is the customer's to know.
test("an office that has been told to pay is not said to be holding the money", () => {
  const said = moneyAtOfficeText({ officeName: "هەولێر", advanceHeld: false }, "ku");
  assert.equal(said, "هەولێر پارەکەت دەداتێ");
  assert.ok(!said.includes("لای"));
});

test("an office the owner has actually funded is said to be holding it", () => {
  assert.equal(moneyAtOfficeText({ officeName: "هەولێر", advanceHeld: true }, "ku"),
               "پارەکەت لای هەولێر ــە");
});

test("the sentence exists in all three languages", () => {
  const seen = new Set();
  for (const lang of ["ku", "en", "ar"]) {
    const said = moneyAtOfficeText({ officeName: "Erbil", advanceHeld: true }, lang);
    assert.ok(said.includes("Erbil"));
    seen.add(said);
  }
  assert.equal(seen.size, 3);
});

test("a missing office name reads as a dash rather than as the word undefined", () => {
  assert.ok(moneyAtOfficeText({ advanceHeld: true }, "ku").includes("—"));
});

test("a refusal from the server is surfaced, not turned into an empty list", async () => {
  const refusing = { rpc: () => Promise.resolve({ data: null, error: new Error("not authorized") }) };
  await assert.rejects(() => loadMoneyAtOffices(refusing, "someone-else"), /not authorized/);
});
