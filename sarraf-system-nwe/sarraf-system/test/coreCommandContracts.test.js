import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const baseline = read("../supabase/migrations/202608090001_legacy_core_baseline.sql");
const commands = read("../supabase/migrations/202608180002_core_command_contracts.sql");
const runtime = read("../supabase/migrations/202608180003_runtime_read_models_and_security.sql");

const functionBody = (source, name, nextName) => {
  const start = source.indexOf(`create or replace function public.${name}`);
  const end = nextName ? source.indexOf(`create or replace function public.${nextName}`, start + 1) : source.length;
  assert.ok(start >= 0 && end > start, `${name} function body was not found`);
  return source.slice(start, end);
};

test("a clean database and an older live schema receive the full additive baseline", () => {
  for (const table of [
    "currencies", "app_users", "txs", "ledger", "account_ledger", "account_transfers",
    "day_closes", "rate_history", "receipt_batches", "receipts", "approval_requests",
    "approval_events", "tx_versions", "notes", "financial_commands", "control_settings",
  ]) assert.match(baseline, new RegExp(`create table if not exists public\\.${table}\\b`));

  for (const compatibility of [
    "account_ledger add column if not exists reversal_of",
    "account_transfers add column if not exists from_id",
    "day_closes add column if not exists command_key",
    "rate_history add column if not exists command_key",
    "receipt_batches add column if not exists uploaded_by",
    "receipts add column if not exists raw",
    "approval_requests add column if not exists owner_override",
    "approval_events add column if not exists actor_auth_id",
  ]) assert.match(baseline, new RegExp(compatibility.replaceAll(" ", "\\s+")));

  assert.doesNotMatch(baseline, /^\s*(?:delete\s+from|truncate|drop\s+table)\b/im);
});

test("financial browser commands are guarded, idempotent security-definer functions", () => {
  for (const name of [
    "sarraf_post_ledger_command", "sarraf_commit_transactions", "sarraf_edit_transaction",
    "sarraf_void_transaction", "sarraf_save_rates", "sarraf_add_currency", "sarraf_account_move",
    "sarraf_account_transfer", "sarraf_close_day", "sarraf_approve_request",
    "sarraf_reject_request", "sarraf_cancel_approval_request", "sarraf_owner_override_approval",
    "sarraf_update_control_settings",
  ]) {
    const body = functionBody(commands, name, null).slice(0, 600);
    assert.match(body, /security definer/i, `${name} is not SECURITY DEFINER`);
  }
  assert.match(commands, /sarraf_assert_writes_open/);
  assert.match(commands, /sarraf_command_replay/);
  assert.match(commands, /pg_advisory_xact_lock/);
  assert.match(commands, /administrator authorization is required/);
});

test("transaction accounting is derived by the server and posted economics are immutable", () => {
  const commit = functionBody(commands, "sarraf_commit_transactions", "sarraf_edit_transaction");
  const manual = functionBody(commands, "sarraf_post_ledger_command", "sarraf_commit_transactions");
  const edit = functionBody(commands, "sarraf_edit_transaction", "sarraf_void_transaction");
  assert.match(commit, /browser's p_ledger is intentionally ignored/);
  assert.doesNotMatch(commit, /jsonb_array_elements\(p_ledger\)/);
  assert.match(commit, /sarraf_inventory_snapshot_at/);
  assert.match(commit, /sarraf_usd_value_at/);
  assert.match(commit, /business_flow='owner_cashbox'|v_flow:=case when v_direct/);
  assert.match(commit, /two-row transaction command must be one exact owner-cashbox buy\/sell pair/);
  assert.match(commit, /zeman:inventory:/);
  assert.match(commit, /sarraf_locked_cash_balance/);
  assert.match(manual, /not a generic browser escape hatch into ledger/);
  assert.match(manual, /partner transfer must be one exact balanced pair/);
  assert.match(manual, /investor capital cannot become negative/);
  assert.match(edit, /cp_name[^\n]+is distinct from v_old\.cp_name/);
  assert.match(edit, /posted economics cannot be edited/);
  assert.doesNotMatch(edit, /set cp_name=/);
});

test("pending settlement mirrors journal events into append-only physical cash", () => {
  const payment = functionBody(commands, "sarraf_post_payment_ledger", "sarraf_post_ledger_command");
  assert.match(payment, /after insert on public\.transaction_payment_events/i);
  assert.match(payment, /event_kind='settled'/);
  assert.match(payment, /event_kind='settlement_reversed'/);
  assert.match(payment, /main cashbox has insufficient balance for settlement/);
  assert.match(payment, /reversal_of/);
  assert.match(payment, /sarraf_require_admin\(false\)/);
});

test("cash and account balances are serialized before they are checked", () => {
  const locked = functionBody(commands, "sarraf_locked_cash_balance", "sarraf_post_payment_ledger");
  const move = functionBody(commands, "sarraf_account_move", "sarraf_account_transfer");
  const transfer = functionBody(commands, "sarraf_account_transfer", "sarraf_close_day");
  assert.match(locked, /zeman:cash-location:/);
  assert.match(move, /zeman:account:/);
  assert.match(move, /main cashbox has insufficient balance/);
  assert.match(transfer, /least\(v_from\.id,v_to\.id\)/);
  assert.match(transfer, /greatest\(v_from\.id,v_to\.id\)/);
});

test("historical valuation never borrows a future rate", () => {
  const rate = functionBody(commands, "sarraf_rate_snapshot_at", "sarraf_usd_value_at");
  assert.match(rate, /h\.created_at<=coalesce\(p_at,statement_timestamp\(\)\)/);
  assert.match(rate, /then 'current' else 'missing'/);
  assert.doesNotMatch(rate, /earliest|order by h\.created_at,h\.id limit 1/);
});

test("day close recomputes balances, valuation, and period locks inside PostgreSQL", () => {
  const close = functionBody(commands, "sarraf_close_day", "sarraf_execute_approval");
  assert.match(close, /pg_advisory_xact_lock\(hashtextextended\('zeman:accounting-period'/);
  assert.match(close, /lock table public\.ledger in share mode/);
  assert.match(close, /sum\(amount\)[\s\S]+partner_id is null and date<v_cutoff/);
  assert.match(close, /v_diff:=round\(v_counted-v_expected/);
  assert.match(close, /sarraf_usd_value_at\(v_diff,v_cur,'mid'/);
  assert.match(close, /'lines',v_normalized/);
  assert.doesNotMatch(close, /p_close->>'(?:total_diff|has_diff)'/);
  assert.match(commands, /create trigger (?:txs|ledger|account_ledger|journal_entries)_period_guard/g);
});

test("maker-checker expiry and replay ownership remain auditable", () => {
  assert.match(commands, /values\(a\.id,'expired'/);
  assert.match(commands, /'status','expired','error','approval request expired'/);
  assert.match(commands, /update public\.financial_commands set actor_id=a\.maker_auth_id/);
  assert.match(commands, /values\(a\.id,'override_failed'/);
});

test("bounded runtime reads expose health without granting sensitive aggregate views", () => {
  for (const name of [
    "sarraf_control_snapshot", "sarraf_read_model_snapshot", "sarraf_tx_history_page",
    "sarraf_report_range", "sarraf_reconciliation_report", "sarraf_runtime_contract",
    "sarraf_system_health",
  ]) assert.match(runtime, new RegExp(`create or replace function public\\.${name}\\b`));
  assert.match(runtime, /contract_version','13f-v1'/);
  assert.match(runtime, /alter view public\.%I set \(security_invoker=true\)/);
  assert.match(runtime, /revoke all on public\.%I from public,anon,authenticated/);
});

test("office access is assignment-scoped rather than generic staff access", () => {
  assert.match(runtime, /drop policy if exists txs_tenant_read/);
  assert.match(runtime, /drop policy if exists ledger_tenant_read/);
  assert.match(runtime, /drop policy if exists receipt_batches_portal_read_b/);
  assert.match(runtime, /create policy (?:rd_staff_read|re_staff_read|je_staff_read|pa_staff_read)[\s\S]*?using \(public\.is_admin\(\)\)/g);
  assert.match(runtime, /receipt_storage_assurance_read[\s\S]*?or public\.is_admin\(\)[\s\S]*?public\.receipt_custody/);
  const txPolicy = runtime.slice(runtime.indexOf("create policy txs_tenant_read"), runtime.indexOf("drop policy if exists ledger_tenant_read"));
  assert.doesNotMatch(txPolicy, /my_role\(\).*office/);
});

test("editing a posted transaction cannot fall through to direct-pair creation", () => {
  const app = read("../src/App.jsx");
  const start = app.indexOf("const saveTx = async (f, existing) =>");
  const direct = app.indexOf("if (f.direct)", start);
  const protectedEdit = app.indexOf("if (existing) {", start);
  assert.ok(start >= 0 && protectedEdit > start && protectedEdit < direct);
  assert.match(app.slice(protectedEdit, direct), /sarraf_edit_transaction/);
  assert.match(app, /تەنها تێبینی دەگۆڕدرێت/);
  assert.doesNotMatch(app, /const buildEntries =/);
});
