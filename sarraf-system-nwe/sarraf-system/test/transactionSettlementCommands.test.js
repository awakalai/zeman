import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL(
  "../supabase/migrations/202608140002_transaction_settlement_and_office_commands.sql",
  import.meta.url,
), "utf8");
const debtMigration = readFileSync(new URL(
  "../supabase/migrations/202608140003_transaction_debt_linkage.sql",
  import.meta.url,
), "utf8");
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const officeUi = readFileSync(new URL(
  "../src/components/accounting/OfficePayments.jsx", import.meta.url,
), "utf8");
const evidenceRoute = readFileSync(new URL(
  "../api/office-payment-evidence.js", import.meta.url,
), "utf8");

test("pending completion is a separate balanced settlement command", () => {
  assert.match(migration, /create or replace function public\.sarraf_settle_transaction/);
  assert.match(migration, /'acc-2300' else 'acc-1000'/,
    "a pending buy must clear its payable; a pending sell must debit cash");
  assert.match(migration, /'acc-1000' else 'acc-1200'/,
    "a pending buy must credit cash; a pending sell must clear its receivable");
  assert.match(migration, /insert into public\.transaction_payment_events/);
  assert.match(migration, /update public\.txs set status='completed',paid_at=statement_timestamp\(\)/);
});

test("settlement and office reports are server-idempotent and append-only", () => {
  assert.match(migration, /transaction payment events are append-only/);
  assert.match(migration, /where actor_id=v_actor\.id and command_key=p_command_key/g);
  assert.match(migration, /'office_payment_report',v_result/);
  assert.match(migration, /'settle_transaction',v_result/);
  assert.match(migration, /return v_prev\|\|jsonb_build_object\('replayed',true\)/g);
});

test("unsettling mirrors the settlement instead of deleting or editing its lines", () => {
  assert.match(migration, /create or replace function public\.sarraf_reverse_posted_entry/);
  assert.match(migration, /case when l\.side='debit' then 'credit' else 'debit' end/);
  assert.match(migration, /update public\.txs set status='pending',paid_at=null/);
  assert.doesNotMatch(migration, /delete from public\.journal_(entries|lines)/i);
});

test("a journal draft needs an actual rate before it can post", () => {
  assert.match(migration, /sarraf_resolve_transaction_draft/);
  assert.match(migration, /if v_amount_usd is null or v_total_usd is null then/);
  assert.match(migration, /set status='posted', posted_at=statement_timestamp\(\)/);
});

test("accounting valuation comes from the immutable server daily rate", () => {
  const baseAmount = migration.slice(
    migration.indexOf("create or replace function public.sarraf_base_amount"),
    migration.indexOf("create or replace function public.sarraf_usd_value"),
  );
  assert.match(baseAmount, /from public\.receipt_daily_rates/);
  assert.match(baseAmount, /effective_date<=current_date/);
  assert.doesNotMatch(baseAmount, /p_amount\s*\/\s*p_rate/,
    "a forged browser rate must not affect base valuation");
  assert.match(migration, /order by r\.effective_date desc,r\.version desc limit 1/);
  const writer = migration.slice(
    migration.indexOf("create or replace function public.sarraf_post_simple_entry"),
    migration.indexOf("create table if not exists public.transaction_payment_events"),
  );
  assert.match(writer, /v_rate_source:='manual_daily_snapshot'/);
  assert.match(writer, /v_effective_rate,v_rate_date/);
  assert.doesNotMatch(writer, /base_rate[^;]+p_rate/s,
    "a forged browser rate must not survive as journal metadata");
});

test("a normal pending purchase and its exact office assignment commit atomically", () => {
  assert.match(migration, /sarraf_commit_pending_purchase_with_office/);
  assert.match(migration, /v_result:=public\.sarraf_commit_transactions/);
  assert.match(migration, /v_assignment:=public\.sarraf_create_office_payment_assignment/);
  assert.match(app, /rpcStrict\("sarraf_commit_pending_purchase_with_office"/);
  assert.match(app, /p_tx: TR\(t\)[\s\S]+p_office_id: f\.officeId/);
});

test("maker-checker approvals retain the exact office intent for later reconciliation", () => {
  assert.match(migration, /create table if not exists public\.office_pending_assignments/);
  assert.match(migration, /sarraf_queue_approved_office_assignment/);
  assert.match(migration, /maker_app_id,status,operation from public\.approval_requests/);
  assert.match(migration, /sarraf_reconcile_pending_office_assignments/);
  assert.match(migration, /v_tx_id is distinct from p\.requested_transaction_id/);
  assert.match(migration, /sarraf_convert_pending_receipt_purchase_with_office/);
  assert.match(app, /supabase\.rpc\("sarraf_reconcile_pending_office_assignments"\)/);
  assert.doesNotMatch(app, /f\.batchId && t\.type === "buy"[\s\S]{0,300}sarraf_create_office_payment_assignment/,
    "receipt conversions must not split the transaction and assignment across browser calls");
});

test("office assignment derives financial fields from its locked transaction", () => {
  const fn = migration.slice(
    migration.indexOf("create or replace function public.sarraf_create_office_payment_assignment"),
    migration.indexOf("-- Replace the non-idempotent report command"),
  );
  assert.match(fn, /select \* into v_t from public\.txs[^;]+for update/s);
  assert.match(fn, /v_t\.type<>'buy' or v_t\.status<>'pending'/);
  assert.match(fn, /abs\(v_t\.total\),v_currency/);
  assert.doesNotMatch(fn, /p_amount|p_currency|p_customer_id/,
    "the browser must not choose assignment amount, currency, or customer");
  assert.match(migration, /opa_one_active_transaction_uq/);
});

test("office users report but only an administrator confirms the full amount", () => {
  assert.match(migration, /v_actor\.role<>'office'[\s\S]+only the assigned office may report payment/);
  assert.match(migration, /v_actor\.id<>v_a\.office_id/);
  assert.match(migration, /v_a\.status<>'paid_reported' or v_a\.amount_paid<>v_a\.amount/);
  assert.match(migration, /v_actor\.role<>'admin'[\s\S]+only an administrator may confirm office payment/);
  assert.match(migration, /drop policy if exists tx_office_u/);
  assert.match(migration, /revoke update on public\.txs from authenticated/);
});

test("an office payment needs immutable uploaded evidence, not a typed reference alone", () => {
  assert.match(migration, /create table if not exists public\.office_payment_evidence/);
  assert.match(migration, /sarraf_office_payment_attach_evidence_server/);
  assert.match(migration, /drop function public\.sarraf_office_payment_attach_evidence\(text,text,text,text\)/);
  assert.match(migration, /to service_role/);
  assert.match(migration, /from public,anon,authenticated/);
  assert.match(migration, /to_regclass\('storage\.objects'\)/);
  assert.match(migration, /owner_id=\$2|owner_id=\$1/);
  assert.match(migration, /new immutable evidence is required for each payment report/);
  assert.match(migration, /add column if not exists evidence_id/);
  assert.match(migration, /pe\.evidence_id=e\.id/);
  assert.match(migration, /receipt_storage_assurance_insert/);
  assert.match(migration, /as restrictive for insert to authenticated with check/);
  assert.match(migration, /owner_id=auth\.uid\(\)::text/);
  assert.match(migration, /\(metadata->>'size'\)::bigint between 1 and 10485760/);
  assert.match(migration, /not exists\(select 1 from public\.office_payment_evidence e where e\.storage_path=name\)/);
  // The office screen no longer uploads anything — the owner asked for the file to go — but the
  // server keeps every guard. sarraf_office_payment_report still refuses a report without new
  // immutable evidence, and the route that attests it is still the only way to attach some.
  assert.doesNotMatch(officeUi, /storage\.from\("receipts"\)\.upload/,
    "the office screen is asking for a photograph again");
  assert.match(evidenceRoute, /storage\.from\("receipts"\)\.download\(body\.storagePath\)/);
  assert.match(evidenceRoute, /createHash\("sha256"\)\.update\(bytes\)/);
  assert.match(evidenceRoute, /sniffEvidence\(bytes\)/);
  assert.match(evidenceRoute, /sarraf_office_payment_attach_evidence_server/);
});

test("the UI requires an exact office, and the office pays in one press", () => {
  assert.match(app, /f\.type === "buy" && f\.status === "pending" && !f\.officeId/);
  assert.match(app, /p_office_id: f\.officeId/);
  assert.doesNotMatch(app, /data\.users\.find\(\(u\) => u\.role === "office" && !u\.deleted\)/,
    "a pending purchase must not silently choose the first office");

  // One press. The owner asked for «بینینی ئەوەی مامەڵيکە هی کێێە و بڕەکەی چەندە و پارەم دا» and
  // nothing else, so the four statuses, the typed amount, the reference and the uploaded
  // photograph are gone — each of them was a way for a real payment to go unrecorded.
  assert.match(officeUi, /sarraf_office_payment_paid/);
  assert.doesNotMatch(officeUi, /sarraf_office_payment_report/,
    "the office screen is back to reporting through the four-status state machine");
  assert.doesNotMatch(officeUi, /storage\.from\("receipts"\)\.upload/,
    "the office screen asks for an evidence file again");
  assert.doesNotMatch(officeUi, /p_reference/,
    "the office screen asks for a payment reference again");
  assert.match(officeUi, /sarraf_office_board/,
    "the screen must read its list, its totals and what it is owed from one call");
});

test("the owner settles the office account through the command that moves all three books", () => {
  // Settling through the ordinary account move would take the office's balance to zero and leave
  // acc-2200 credited for ever: the operational account says paid, the journal says owed.
  assert.match(app, /sarraf_office_settle/);
  assert.match(app, /p_office_id: officeId/);
  assert.match(app, /onClick=\{\(\) => officeSettle\(officeId, c\.id, v\)\}/);
});

test("pending transactions create an explicit directional debt from server-owned fields", () => {
  assert.match(debtMigration, /create trigger txs_sync_explicit_debt/);
  assert.match(debtMigration, /new\.status='pending'/);
  assert.match(debtMigration, /a pending transaction requires a registered counterparty/);
  assert.match(debtMigration, /case when new\.type='buy' then 'zeman' else 'customer' end/);
  assert.match(debtMigration, /case when new\.type='buy' then 'customer' else 'zeman' end/);
  assert.match(debtMigration, /abs\(new\.total\)/);
  assert.match(app, /f\.status === "pending" && !f\.cpId/);
  assert.match(debtMigration, /protect_transaction_financial_identity/);
  assert.match(debtMigration, /posted transaction economics are immutable/);
  assert.match(debtMigration, /v_pending_transaction_gaps/);
});

test("a pending transaction cannot complete without both journal settlement and debt closure", () => {
  assert.match(debtMigration, /old\.status='pending' and new\.status='completed'/);
  assert.match(debtMigration, /source_type='transaction_settlement' and status='posted'/);
  assert.match(debtMigration, /transaction cannot complete without a posted settlement entry/);
  assert.match(debtMigration, /insert into public\.debt_settlements/);
  assert.match(debtMigration, /'transaction_payment'/);
  assert.match(debtMigration, /old\.status='completed'[\s\S]+transaction is pending again/);
});
