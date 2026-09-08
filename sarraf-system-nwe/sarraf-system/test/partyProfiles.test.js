import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCashReconciliation, loadPartyProfile, summarizePartyCurrencies } from "../src/services/partyProfiles.js";

const migrationUrl = new URL("../supabase/migrations/202609070002_party_profiles_and_reconciliation.sql", import.meta.url);

test("party profile sends the explicit party scope to the server", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push([name, args]);
    return { data: { party: { id: "c-1" }, balances: [], debts: [], transactions: [], receipts: [], payments: [] }, error: null };
  } };
  const profile = await loadPartyProfile(client, "c-1", "customer");
  assert.deepEqual(calls, [["sarraf_party_profile", { p_party_id: "c-1", p_party_kind: "customer" }]]);
  assert.equal(profile.party.id, "c-1");
});

test("party profile keeps currencies separate and exposes no profit projection", async () => {
  const client = { rpc: async () => ({ data: {
    balances: [{ currency: "CNY", total: "10" }, { currency: "USD", total: "2" }],
    transactions: [{ id: "t-1", total: "100" }],
  }, error: null }) };
  const profile = await loadPartyProfile(client, "p-1", "partner");
  assert.deepEqual(summarizePartyCurrencies(profile.balances), { CNY: 10, USD: 2 });
  assert.equal("profit" in profile.transactions[0], false);
});

test("cash reconciliation preserves discrepancy state instead of fixing it", async () => {
  const client = { rpc: async (name) => {
    assert.equal(name, "sarraf_cash_reconciliation");
    return { data: { currencies: [{ currency: "IQD", physical: "100", system: "90", held: "4", debt: "2", difference: "10", status: "discrepancy" }] }, error: null };
  } };
  const result = await loadCashReconciliation(client);
  assert.equal(result.currencies[0].difference, 10);
  assert.equal(result.currencies[0].status, "discrepancy");
});

test("database refusals are surfaced", async () => {
  const client = { rpc: async () => ({ data: null, error: new Error("not authorized") }) };
  await assert.rejects(() => loadPartyProfile(client, "other-tenant", "customer"), /not authorized/);
  await assert.rejects(() => loadCashReconciliation(client), /not authorized/);
});

test("party profiles and cash reconciliation stay inside the actor's tenant", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const scopes = sql.match(/tenant_id\s*=\s*v_actor\.tenant_id/g) || [];
  assert.ok(scopes.length >= 12, `expected tenant predicates throughout both read models, found ${scopes.length}`);
  assert.match(sql, /id = p_party_id[\s\S]{0,160}tenant_id = v_actor\.tenant_id[\s\S]{0,80}not deleted/i);
  assert.match(sql, /from public\.ledger where tenant_id = v_actor\.tenant_id/i);
  assert.match(sql, /from public\.account_ledger where tenant_id = v_actor\.tenant_id/i);
  assert.match(sql, /alter function public\.sarraf_party_profile\(text, text\) owner to sarraf_definer/i);
  assert.match(sql, /alter function public\.sarraf_cash_reconciliation\(\) owner to sarraf_definer/i);
});

test("multi-currency account balances are aggregated before JSON collection", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /from \(\s*select cur_id currency, sum\(amount\) amount[\s\S]*group by cur_id[\s\S]*\) balances/i);
  assert.doesNotMatch(sql, /into v_balances from public\.account_ledger[\s\S]{0,100}group by cur_id/i);
});
