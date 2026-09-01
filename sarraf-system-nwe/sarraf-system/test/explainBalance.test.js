import test from "node:test";
import assert from "node:assert/strict";
import { explainBalance, firstNegativeMovement } from "../src/services/accounting.js";

const clientReturning = (data) => {
  const calls = [];
  return { calls, rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data, error: null }); } };
};

test("explainBalance asks the server for the holder it was given", async () => {
  const client = clientReturning([]);
  await explainBalance(client, "CNY", { holder: "partner", holderId: "p-1", limit: 50 });
  assert.equal(client.calls[0].fn, "sarraf_explain_balance");
  assert.deepEqual(client.calls[0].args,
    { p_cur_id: "CNY", p_holder: "partner", p_holder_id: "p-1", p_limit: 50 });
});

test("explainBalance defaults to the owner's own cashbox", async () => {
  const client = clientReturning([]);
  await explainBalance(client, "CNY");
  assert.equal(client.calls[0].args.p_holder, "owner");
  assert.equal(client.calls[0].args.p_holder_id, null);
});

test("explainBalance reads the running balance and the crossing as numbers and a flag", async () => {
  const rows = await explainBalance(clientReturning([
    { seq: 1, ledger_id: "l-1", moved_at: "2026-08-01", entry_type: "deposit",
      amount: "100", running_balance: "100.0000000000", went_negative: false,
      partner_id: null, partner_name: null, tx_id: null, note: null },
    { seq: 2, ledger_id: "l-2", moved_at: "2026-08-02", entry_type: "withdraw",
      amount: "-240", running_balance: "-140.0000000000", went_negative: true,
      partner_id: null, partner_name: null, tx_id: "tx-9", note: "sale" },
  ]), "CNY");
  assert.equal(rows[0].runningBalance, 100);
  assert.equal(rows[0].wentNegative, false);
  assert.equal(rows[1].runningBalance, -140);
  assert.equal(rows[1].wentNegative, true);
  assert.equal(rows[1].txId, "tx-9");
});

test("firstNegativeMovement names the movement that crossed zero", async () => {
  const answer = await firstNegativeMovement(clientReturning({
    currency: "CNY", holder: "owner", ever_negative: true, final_balance: "-140",
    first_negative: { seq: 2, ledger_id: "l-2", moved_at: "2026-08-02", entry_type: "withdraw",
      amount: "-240", balance_after: "-140", transaction: "tx-9", partner: null, note: "sale" },
  }), "CNY");
  assert.equal(answer.everNegative, true);
  assert.equal(answer.finalBalance, -140);
  assert.equal(answer.firstNegative.ledgerId, "l-2");
  assert.equal(answer.firstNegative.balanceAfter, -140);
  assert.equal(answer.firstNegative.txId, "tx-9");
});

test("a balance that never went negative reports no movement rather than a zeroth one", async () => {
  const answer = await firstNegativeMovement(clientReturning({
    currency: "CNY", holder: "owner", ever_negative: false, final_balance: "380",
  }), "CNY");
  assert.equal(answer.everNegative, false);
  assert.equal(answer.firstNegative, null);
  assert.equal(answer.finalBalance, 380);
});

test("a refusal from the server is surfaced, not swallowed", async () => {
  const refusing = { rpc: () => Promise.resolve({ data: null, error: new Error("administrator authorization is required") }) };
  await assert.rejects(() => explainBalance(refusing, "CNY"), /administrator authorization/);
  await assert.rejects(() => firstNegativeMovement(refusing, "CNY"), /administrator authorization/);
});
