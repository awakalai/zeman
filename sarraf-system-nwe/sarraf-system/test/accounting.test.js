import test from "node:test";
import assert from "node:assert/strict";
import {
  moveCustomerVault, applyVaultToDebt, creditDebtToVault, previewDebtWaterfall,
  requireRateFor, summarizeDebts, agingBucketOf, loadDebts, loadTrialBalance,
  creditPartnerFunds, disbursePartnerFunds, loadDailyAccountingRates, commissionTrade,
} from "../src/services/accounting.js";

const clientWith = (impl = {}) => ({
  calls: [],
  rpc(fn, args) { this.calls.push({ fn, args }); return Promise.resolve(impl.rpc ?? { data: { ok: true }, error: null }); },
  from(table) {
    const chain = {
      _table: table,
      select() { return chain; }, eq() { return chain; }, in() { return chain; }, lte() { return chain; },
      order() { return chain; }, limit() { return chain; },
      then(resolve) { return Promise.resolve(impl.rows ?? { data: [], error: null }).then(resolve); },
    };
    return chain;
  },
});

test("a non-USD amount cannot be valued without a rate", () => {
  assert.throws(() => requireRateFor("CNY", null), /نرخی ئەمڕۆ/);
  assert.throws(() => requireRateFor("CNY", 0), /نرخی ئەمڕۆ/);
  assert.throws(() => requireRateFor("IQD", NaN), /نرخی ئەمڕۆ/);
  assert.equal(requireRateFor("CNY", 7.2), 7.2);
  // USD needs no rate: it is already the base currency.
  assert.equal(requireRateFor("USD", null), 1);
});

test("a deposit sends an idempotent command with its rate and reason", async () => {
  const c = clientWith();
  const { result, commandKey } = await moveCustomerVault(c, {
    customerId: "cust-1", currency: "cny", amount: 7200, direction: "in",
    rate: 7.2, reason: "کڕیار پارەی دانا",
  });
  assert.deepEqual(result, { ok: true });
  assert.match(commandKey, /^acct-vault:cust-1:/);
  const call = c.calls[0];
  assert.equal(call.fn, "sarraf_customer_vault_move");
  assert.equal(call.args.p_currency, "CNY", "currency must be normalized");
  assert.equal(call.args.p_amount, 7200);
  assert.equal(call.args.p_rate, 7.2);
  assert.equal(call.args.p_command_key, commandKey);
});

test("the same command key can be replayed deliberately", async () => {
  const c = clientWith();
  const key = "acct-vault:cust-1:fixed";
  await moveCustomerVault(c, { customerId: "cust-1", currency: "USD", amount: 10, direction: "in", reason: "دانان", commandKey: key });
  await moveCustomerVault(c, { customerId: "cust-1", currency: "USD", amount: 10, direction: "in", reason: "دانان", commandKey: key });
  assert.equal(c.calls[0].args.p_command_key, c.calls[1].args.p_command_key,
    "a retry must carry the same key so the server can recognise the replay");
});

test("invalid cashbox movements are refused before reaching the server", async () => {
  const c = clientWith();
  const bad = [
    { customerId: "", currency: "CNY", amount: 1, direction: "in", rate: 7.2, reason: "ok" },
    { customerId: "c", currency: "CNY", amount: 0, direction: "in", rate: 7.2, reason: "ok" },
    { customerId: "c", currency: "CNY", amount: -5, direction: "in", rate: 7.2, reason: "ok" },
    { customerId: "c", currency: "CNY", amount: 1, direction: "sideways", rate: 7.2, reason: "ok" },
    { customerId: "c", currency: "CNY", amount: 1, direction: "in", rate: 7.2, reason: "" },
    { customerId: "c", currency: "CNY", amount: 1, direction: "in", rate: null, reason: "ok" },
  ];
  for (const args of bad) await assert.rejects(() => moveCustomerVault(c, args));
  assert.equal(c.calls.length, 0, "no invalid command should have been sent");
});

test("settling from the cashbox and crediting a debt both require a reason", async () => {
  const c = clientWith();
  await assert.rejects(() => applyVaultToDebt(c, { customerId: "c", currency: "CNY", amount: 10, rate: 7.2, reason: "" }));
  await assert.rejects(() => creditDebtToVault(c, { debtId: "d", currency: "CNY", rate: 7.2, reason: "" }));
  assert.equal(c.calls.length, 0);
});

test("the waterfall preview is returned in allocation order", async () => {
  const c = clientWith({ rpc: { data: [
    { debt_id: "d-old", outstanding: "300", allocated: "300", remaining_after: "200" },
    { debt_id: "d-new", outstanding: "500", allocated: "200", remaining_after: "0" },
  ], error: null } });
  const plan = await previewDebtWaterfall(c, {
    debtorType: "partner", debtorId: "p-1", creditorType: "zeman", currency: "CNY", amount: 500,
  });
  assert.deepEqual(plan.map((x) => [x.debtId, x.allocated]), [["d-old", 300], ["d-new", 200]]);
  assert.equal(plan[1].remainingAfter, 0);
});

test("aging buckets follow the documented boundaries", () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  assert.equal(agingBucketOf(null), "current");
  assert.equal(agingBucketOf(new Date(Date.now() + 86400000).toISOString()), "current");
  assert.equal(agingBucketOf(daysAgo(3)), "1-7");
  assert.equal(agingBucketOf(daysAgo(20)), "8-30");
  assert.equal(agingBucketOf(daysAgo(45)), "31-60");
  assert.equal(agingBucketOf(daysAgo(120)), "60+");
});

test("debt totals are kept per currency and per direction, never netted", () => {
  const debts = [
    { debtorType: "zeman", currency: "CNY", outstanding: 300, dueAt: null },
    { debtorType: "customer", currency: "CNY", outstanding: 500, dueAt: null },
    { debtorType: "customer", currency: "USD", outstanding: 100, dueAt: null },
  ];
  const s = summarizeDebts(debts);
  assert.deepEqual(s.weOwe, { CNY: 300 });
  assert.deepEqual(s.owedToUs, { CNY: 500, USD: 100 });
  assert.deepEqual(s.currencies, ["CNY", "USD"]);
  // The two CNY figures must remain separate; 500 - 300 must never appear as a single 200.
  assert.equal(s.weOwe.CNY + s.owedToUs.CNY, 800);
});

test("debts are read as open only, and can be narrowed to one party", async () => {
  const rows = { data: [
    { id: "d1", debtor_type: "customer", debtor_id: "c1", creditor_type: "zeman", creditor_id: null,
      currency: "CNY", original_principal: "1000", outstanding_principal: "600",
      status: "partially_settled", reason: "r", opened_at: "2026-08-01", due_at: "2026-08-05" },
    { id: "d2", debtor_type: "zeman", debtor_id: null, creditor_type: "customer", creditor_id: "c9",
      currency: "USD", original_principal: "50", outstanding_principal: "50",
      status: "open", reason: "r", opened_at: "2026-08-02", due_at: null },
  ], error: null };
  const all = await loadDebts(clientWith({ rows }));
  assert.equal(all.length, 2);
  assert.equal(all[0].outstanding, 600);
  assert.equal(all[0].overdue, true, "a past due date must be reported as overdue");
  const mine = await loadDebts(clientWith({ rows }), { partyId: "c9" });
  assert.deepEqual(mine.map((d) => d.id), ["d2"]);
});

test("the trial balance is surfaced with its difference and balanced flag", async () => {
  const c = clientWith({ rpc: { data: {
    base_debit: "1000", base_credit: "1000", difference: "0", balanced: true, entry_count: 4,
  }, error: null } });
  const tb = await loadTrialBalance(c);
  assert.equal(tb.balanced, true);
  assert.equal(tb.difference, 0);
  assert.equal(tb.entryCount, 4);
});

test("an RPC error is surfaced, never swallowed into a false success", async () => {
  const c = clientWith({ rpc: { data: null, error: { code: "42501", message: "not authorized" } } });
  await assert.rejects(
    () => moveCustomerVault(c, { customerId: "c", currency: "USD", amount: 1, direction: "in", reason: "دانان" }),
    (e) => e.code === "42501"
  );
});

test("partner disbursement and credit use explicit idempotent commands", async () => {
  const c = clientWith();
  const disbursement = await disbursePartnerFunds(c, {
    partnerId: "p-1", currency: "cny", amount: 1300, rate: 7.2,
    transactionId: "tx-1", reason: "assigned sale",
  });
  const credit = await creditPartnerFunds(c, {
    partnerId: "p-1", currency: "cny", amount: 500, rate: 7.2, reason: "bank receipt",
  });
  assert.match(disbursement.commandKey, /^acct-partner-disburse:p-1:/);
  assert.match(credit.commandKey, /^acct-partner-credit:p-1:/);
  assert.equal(c.calls[0].fn, "sarraf_partner_disburse");
  assert.equal(c.calls[0].args.p_transaction_id, "tx-1");
  assert.equal(c.calls[1].fn, "sarraf_partner_credit");
  assert.equal(c.calls[1].args.p_currency, "CNY");
  assert.notEqual(c.calls[0].args.p_command_key, c.calls[1].args.p_command_key);
});

test("invalid partner movements never reach the database", async () => {
  const c = clientWith();
  await assert.rejects(() => disbursePartnerFunds(c, {
    partnerId: "", currency: "CNY", amount: 1, rate: 7.2, reason: "valid",
  }));
  await assert.rejects(() => creditPartnerFunds(c, {
    partnerId: "p", currency: "CNY", amount: -1, rate: 7.2, reason: "valid",
  }));
  await assert.rejects(() => creditPartnerFunds(c, {
    partnerId: "p", currency: "CNY", amount: 1, rate: null, reason: "valid",
  }));
  assert.equal(c.calls.length, 0);
});

test("daily accounting rates take the newest immutable snapshot per currency", async () => {
  const rows = { data: [
    { currency: "CNY", effective_date: "2026-08-12", rate_value: "7.25", version: 2 },
    { currency: "CNY", effective_date: "2026-08-12", rate_value: "7.20", version: 1 },
    { currency: "IQD", effective_date: "2026-08-11", rate_value: "1410", version: 1 },
  ], error: null };
  const rates = await loadDailyAccountingRates(clientWith({ rows }), "2026-08-12");
  assert.deepEqual(rates.CNY, { value: 7.25, effectiveDate: "2026-08-12", version: 2 });
  assert.equal(rates.IQD.value, 1410);
  assert.equal(rates.USD.value, 1);
});


// ── «هەقی ئەم ئیشە... وە بۆ چ کەسێکی دەکەم» ───────────────────────────────────────────────────
//
// The contract between the screen and the command. 202609020005 had written "There is no fee on
// the side" into the migration history and 202609020017 withdrew it; these hold the withdrawal
// in place from the browser's side.

test("a commission trade carries the fee and the person it was for", async () => {
  const c = clientWith({ rpc: { data: { transaction_id: "cmx1", code: 9 }, error: null } });
  await commissionTrade(c, {
    fromAccountId: "acc-fib", fromCurrencyId: "iqd", fromAmount: 40000,
    toAccountId: null, toCurrencyId: "iqd", toAmount: 40000,
    commandKey: "commission:with-a-fee-of-700",
    feeAmount: 700, feeAccountId: null, forPartyId: "cust-1",
  });
  const { args } = c.calls[0];
  assert.equal(args.p_fee_amount, 700);
  assert.equal(args.p_fee_account_id, null);
  assert.equal(args.p_for_party_id, "cust-1");
  // The movement itself is untouched by the fee: equal on both sides is the shape the owner
  // described, and it must reach the server as they typed it.
  assert.equal(args.p_from_amount, 40000);
  assert.equal(args.p_to_amount, 40000);
});

test("a commission trade with no fee and nobody named sends neither", async () => {
  const c = clientWith();
  await commissionTrade(c, {
    fromCurrencyId: "iqd", fromAmount: 100, toCurrencyId: "iqd", toAmount: 110,
    commandKey: "commission:no-fee-nobody-named",
  });
  const { args } = c.calls[0];
  assert.equal(args.p_fee_amount, 0);
  assert.equal(args.p_fee_account_id, null);
  assert.equal(args.p_for_party_id, null);
});

test("the fee is sent as typed, not rounded or capped by the screen", async () => {
  // «هیچ money amount یان calculated total ـێک لە client بەبێ server verification
  // باوەڕپێنەکرێت.» The reverse of that rule also holds: a screen that quietly tidies a number
  // before sending it has decided something the books never agreed to.
  const c = clientWith();
  await commissionTrade(c, {
    fromCurrencyId: "iqd", fromAmount: 100, toCurrencyId: "iqd", toAmount: 100,
    commandKey: "commission:an-awkward-fee", feeAmount: 0.123456789,
  });
  assert.equal(c.calls[0].args.p_fee_amount, 0.123456789);
});

test("what the command answers about the fee reaches the caller", async () => {
  const c = clientWith({ rpc: { data: {
    transaction_id: "cmx2", code: 10,
    from: { name: "FIB", amount: 40000 }, to: { name: "کاش", amount: 40000 },
    fee: { amount: 700, currency: "iqd", account: null, name: null },
    for: { id: "cust-1", name: "کڕیاری یەکەم" },
  }, error: null } });
  const answer = await commissionTrade(c, {
    fromCurrencyId: "iqd", fromAmount: 40000, toCurrencyId: "iqd", toAmount: 40000,
    commandKey: "commission:answer-carries-the-fee",
  });
  assert.equal(answer.fee.amount, 700);
  assert.equal(answer.for.name, "کڕیاری یەکەم");
});
