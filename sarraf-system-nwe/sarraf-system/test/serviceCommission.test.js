import test from "node:test";
import assert from "node:assert/strict";
import { recordService, loadCashAccounts, openCashAccount } from "../src/services/accounting.js";

const clientReturning = (data) => {
  const calls = [];
  return { calls, rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data, error: null }); } };
};

// The owner's own example, as the server would answer it.
const FIB_ANSWER = {
  id: "svc-1", account: "fib-1", account_name: "FIB", direction: "into_safe", currency: "IQD",
  principal: "1000000", commission: "3000", commission_collected: true,
  commission_receivable: "0", entry_id: "je-svc-1", commission_entry_id: "je-svc-fee-1",
  replayed: false,
};

test("a service sends every field the server needs, and nothing it does not", async () => {
  const client = clientReturning(FIB_ANSWER);
  await recordService(client, {
    id: "svc-1", accountId: "fib-1", amount: 1000000, commission: 3000,
    commissionCollected: true, description: "FIB deposit", commandKey: "cmd-svc-1",
  });
  assert.equal(client.calls[0].fn, "sarraf_service_transaction");
  assert.deepEqual(client.calls[0].args, {
    p_id: "svc-1", p_cash_account_id: "fib-1", p_direction: "into_safe",
    p_amount: 1000000, p_commission: 3000, p_commission_collected: true,
    p_customer_id: null, p_description: "FIB deposit", p_command_key: "cmd-svc-1",
  });
});

test("principal and commission come back apart, and are never added together", async () => {
  const answer = await recordService(clientReturning(FIB_ANSWER), {
    id: "svc-1", accountId: "fib-1", amount: 1000000, commission: 3000, commandKey: "k",
  });
  assert.equal(answer.principal, 1000000);
  assert.equal(answer.commission, 3000);
  // §3.3: one million and three thousand are different kinds of money. Nothing here offers a
  // single figure that hides which is which.
  assert.equal("total" in answer, false);
});

test("an uncollected commission is reported as owed, not as cash", async () => {
  const answer = await recordService(clientReturning({
    ...FIB_ANSWER, commission_collected: false, commission_receivable: "3000",
  }), { id: "svc-2", accountId: "fib-1", amount: 1000000, commission: 3000,
        commissionCollected: false, commandKey: "k2" });
  assert.equal(answer.commissionCollected, false);
  assert.equal(answer.commissionReceivable, 3000);
});

test("a zero commission is still a valid service", async () => {
  const client = clientReturning({ ...FIB_ANSWER, commission: "0", commission_receivable: "0" });
  const answer = await recordService(client, {
    id: "svc-3", accountId: "fib-1", amount: 50000, commandKey: "k3",
  });
  assert.equal(client.calls[0].args.p_commission, 0);
  assert.equal(answer.commission, 0);
});

test("money can be sent the other way, from the safe into an account", async () => {
  const client = clientReturning({ ...FIB_ANSWER, direction: "from_safe" });
  await recordService(client, {
    id: "svc-4", accountId: "fib-1", direction: "from_safe", amount: 200000, commandKey: "k4",
  });
  assert.equal(client.calls[0].args.p_direction, "from_safe");
});

test("a replay is reported as a replay rather than as a second service", async () => {
  const answer = await recordService(clientReturning({ ...FIB_ANSWER, replayed: true }), {
    id: "svc-1", accountId: "fib-1", amount: 1000000, commission: 3000, commandKey: "cmd-svc-1",
  });
  assert.equal(answer.replayed, true);
});

test("a refusal from the server is surfaced, not swallowed", async () => {
  const refusing = {
    rpc: () => Promise.resolve({ data: null, error: new Error("that account does not hold enough") }),
  };
  await assert.rejects(
    () => recordService(refusing, { id: "x", accountId: "fib-1", amount: 1, commandKey: "k" }),
    /does not hold enough/,
  );
});

test("cash account balances are read as numbers", async () => {
  const accounts = await loadCashAccounts(clientReturning([
    { id: "fib-1", name: "FIB", kind: "bank", cur_id: "iqd", active: true, balance: "1500000" },
  ]));
  assert.equal(accounts[0].balance, 1500000);
  assert.equal(accounts[0].active, true);
  assert.equal(accounts[0].name, "FIB");
});

test("opening an account passes the name and currency through", async () => {
  const client = clientReturning({ id: "fib-1", name: "FIB", currency: "iqd" });
  await openCashAccount(client, { id: "fib-1", name: "FIB", currencyId: "iqd" });
  assert.equal(client.calls[0].fn, "sarraf_open_cash_account");
  assert.equal(client.calls[0].args.p_name, "FIB");
  assert.equal(client.calls[0].args.p_cur_id, "iqd");
  assert.equal(client.calls[0].args.p_kind, "bank");
});
