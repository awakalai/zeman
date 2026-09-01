-- عمولە: مامەڵەیەک کە نە کڕینە نە فرۆشتن (§3).
--
-- The owner's words, and the whole requirement is in them:
--
--   «تۆ دێیت دەڵێیت یەک ملیۆن ئێف ئای بیم بۆ داخڵ بکە، یەک ملیۆن لە حسابی ئێف ئای بی دەڕوات و
--    یەک ملیۆن بۆ قاسە زیاد دەبێت، بەڵام ٣٠٠٠ دینار عمولەت لێ وەردەگرم حەقی ئەو کارە.
--    ئەمە نمونەیە ئەگینا دەیان شتیبتر عمولەی هەیە.»
--
-- FIB is an example, not the feature. So this builds the general thing: money moves between a
-- place it is held and the owner's safe, and the business earns a fee for doing it. No currency
-- is bought or sold, so nothing here touches inventory, weighted-average cost, FX spread or
-- purchase/sale profit — and the tests say so rather than the comment alone.
--
-- ── Why a table of cash accounts, and not a name typed into a note ───────────────────────────
--
-- "One million leaves the FIB account" only means something if the FIB account has a balance.
-- public.chart_of_accounts is a shared chart with no tenant column, so a business's own bank
-- account does not belong in it. public.cash_accounts is that: the places a tenant's money
-- physically sits which are not the main safe.
--
-- ── The dimension the ledger has been missing ────────────────────────────────────────────────
--
-- public.ledger has owner, investor_id and partner_id, and no way at all to say where money is.
-- The owner's cashbox figure is computed as "every ledger row that names no partner" — a
-- residual, not a balance, which is why it can go somewhere nobody can explain. ledger.cash_account_id
-- is the first honest answer to "where is this money": null still means the main safe, exactly as
-- before, and a named account means it is there instead. Additive, nullable, and no existing row
-- or figure changes.
--
-- ── Commission is the tenant's income, never the platform's ──────────────────────────────────
--
-- acc-4100 (داهاتی فی — Fee income) already exists and is the right home. It is deliberately not
-- acc-4000 (exchange spread), so a commission report can never be confused with FX profit.

begin;

-- ── where a tenant's money sits when it is not in the safe ───────────────────────────────────
create table if not exists public.cash_accounts (
  id text primary key,
  tenant_id text not null references public.tenants(id),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  kind text not null default 'bank' check (kind in ('bank', 'wallet', 'safe', 'other')),
  cur_id text not null references public.currencies(id),
  active boolean not null default true,
  note text,
  created_by text references public.app_users(id),
  created_at timestamptz not null default statement_timestamp()
);

create unique index if not exists cash_accounts_name_per_tenant
  on public.cash_accounts (tenant_id, cur_id, lower(btrim(name)));
create index if not exists cash_accounts_by_tenant on public.cash_accounts (tenant_id, active);

alter table public.cash_accounts enable row level security;
alter table public.cash_accounts force row level security;

drop policy if exists cash_accounts_tenant on public.cash_accounts;
create policy cash_accounts_tenant on public.cash_accounts as restrictive to authenticated
  using ((select public.sarraf_sees_all_tenants())
         or (tenant_id is not null and tenant_id = (select public.sarraf_tenant())))
  with check ((select public.sarraf_sees_all_tenants())
              or (tenant_id is not null and tenant_id = (select public.sarraf_tenant())));

drop policy if exists cash_accounts_read on public.cash_accounts;
create policy cash_accounts_read on public.cash_accounts for select to authenticated
  using ((select public.is_admin()));

drop policy if exists cash_accounts_definer on public.cash_accounts;
create policy cash_accounts_definer on public.cash_accounts as permissive to sarraf_definer
  using (true) with check (true);

revoke all on public.cash_accounts from public, anon;
grant select on public.cash_accounts to authenticated;

-- ── where a ledger row's money is ────────────────────────────────────────────────────────────
-- Null means the main safe, which is what every existing row means today. Nothing is backfilled
-- and no balance moves.
alter table public.ledger
  add column if not exists cash_account_id text references public.cash_accounts(id);
create index if not exists ledger_by_cash_account on public.ledger (cash_account_id, cur_id)
  where cash_account_id is not null;

comment on column public.ledger.cash_account_id is
  'Where this money is. Null means the owner main safe, which is what every row before '
  '202609010011 means. A named account means the money is there instead.';

-- ── opening and listing an account ───────────────────────────────────────────────────────────
create or replace function public.sarraf_open_cash_account(
  p_id text, p_name text, p_cur_id text, p_kind text default 'bank', p_note text default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $fn$
declare v_actor public.app_users%rowtype;
begin
  v_actor := public.sarraf_require_admin(false);
  if v_actor.tenant_id is null then
    raise exception using errcode = '42501', message = 'only a business may open an account';
  end if;
  if nullif(btrim(coalesce(p_id, '')), '') is null then
    raise exception using errcode = '22023', message = 'an account id is required';
  end if;
  if not exists (select 1 from public.currencies where id = p_cur_id) then
    raise exception using errcode = '22023', message = 'unknown currency';
  end if;
  insert into public.cash_accounts(id, tenant_id, name, kind, cur_id, note, created_by)
  values (btrim(p_id), v_actor.tenant_id, btrim(p_name), coalesce(nullif(btrim(p_kind), ''), 'bank'),
          p_cur_id, nullif(btrim(coalesce(p_note, '')), ''), v_actor.id)
  on conflict (id) do nothing;
  return jsonb_build_object('id', btrim(p_id), 'name', btrim(p_name), 'currency', p_cur_id);
end;
$fn$;

create or replace function public.sarraf_cash_account_balances()
returns table(id text, name text, kind text, cur_id text, active boolean, balance numeric)
language sql security definer stable set search_path = pg_catalog, public
as $fn$
  select a.id, a.name, a.kind, a.cur_id, a.active,
         coalesce((select round(sum(l.amount), 10) from public.ledger l
                    where l.cash_account_id = a.id), 0)
    from public.cash_accounts a
   order by a.name;
$fn$;

-- ── the service itself ───────────────────────────────────────────────────────────────────────
--
-- p_direction: 'into_safe'  — money leaves the account and arrives in the safe (the FIB example)
--              'from_safe'  — money leaves the safe and arrives in the account
--
-- The commission is charged on top of the principal and is never added to it. The owner's words
-- keep them apart — one million moves, three thousand is earned — and §3.3 says the screen must
-- not merge them either, so nothing here ever returns a single combined figure.
create or replace function public.sarraf_service_transaction(
  p_id text,
  p_cash_account_id text,
  p_direction text,
  p_amount numeric,
  p_commission numeric,
  p_commission_collected boolean,
  p_customer_id text,
  p_description text,
  p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $fn$
declare
  v_actor public.app_users%rowtype;
  v_prev jsonb; v_account public.cash_accounts%rowtype;
  v_code text; v_sign integer; v_entry text; v_fee_entry text := null;
  v_balance numeric; v_result jsonb;
begin
  v_actor := public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('service_transaction');
  if nullif(btrim(coalesce(p_command_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'a command key is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  if p_direction not in ('into_safe', 'from_safe') then
    raise exception using errcode = '22023', message = 'direction must be into_safe or from_safe';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'the amount must be greater than zero';
  end if;
  if p_commission is null or p_commission < 0 then
    raise exception using errcode = '22023', message = 'the commission cannot be negative';
  end if;

  select * into v_account from public.cash_accounts where id = p_cash_account_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'no such account in this business';
  end if;
  if not v_account.active then
    raise exception using errcode = '22023', message = 'that account is closed';
  end if;
  select code into v_code from public.currencies where id = v_account.cur_id;

  -- Money cannot leave a place that does not hold it. This is the rule the owner's cashbox has
  -- never had, and an account gets it from the first day rather than after somebody notices.
  select coalesce(sum(l.amount), 0) into v_balance
    from public.ledger l where l.cash_account_id = v_account.id;
  if p_direction = 'into_safe' and p_amount > v_balance + 0.0000000001 then
    raise exception using errcode = '23514', message = 'that account does not hold enough',
      detail = format('%s holds %s, the service needs %s', v_account.name, v_balance, p_amount);
  end if;

  v_sign := case when p_direction = 'into_safe' then -1 else 1 end;

  -- Two ledger rows: the account, and the safe. They are equal and opposite, so the business's
  -- total holding of this currency is unchanged — the money only moved.
  insert into public.ledger(id, type, cur_id, amount, cash_account_id, note, date,
                            command_key, created_by, tenant_id)
  values ('led-svc-' || md5(p_id || ':account'), 'transfer_out', v_account.cur_id,
          v_sign * p_amount, v_account.id,
          left(coalesce(p_description, 'service'), 1000), statement_timestamp(),
          p_command_key, v_actor.id, v_actor.tenant_id);
  insert into public.ledger(id, type, cur_id, amount, note, date,
                            command_key, created_by, tenant_id)
  values ('led-svc-' || md5(p_id || ':safe'), 'transfer_in', v_account.cur_id,
          -v_sign * p_amount,
          left(coalesce(p_description, 'service'), 1000), statement_timestamp(),
          p_command_key, v_actor.id, v_actor.tenant_id);

  -- The principal, in the books. acc-1000 is the main safe; the account is the other side.
  v_entry := 'je-svc-' || md5(v_actor.id || ':' || p_command_key);
  perform public.sarraf_post_simple_entry(
    v_entry, current_date, 'service', v_actor.id,
    case when p_direction = 'into_safe' then 'acc-1000' else 'acc-1400' end,
    case when p_direction = 'into_safe' then 'acc-1400' else 'acc-1000' end,
    v_code, p_amount, null,
    left(coalesce(p_description, 'service'), 500), p_command_key,
    case when p_customer_id is not null then 'customer' end, p_customer_id, null, current_date);

  -- The commission, in its own entry, to its own account. Never acc-4000: a fee earned for
  -- moving money is not an exchange spread, and a report that mixed them would be useless.
  if p_commission > 0 then
    v_fee_entry := 'je-svc-fee-' || md5(v_actor.id || ':' || p_command_key);
    perform public.sarraf_post_simple_entry(
      v_fee_entry, current_date, 'service_commission', v_actor.id,
      case when coalesce(p_commission_collected, false) then 'acc-1000' else 'acc-1200' end,
      'acc-4100',
      v_code, p_commission, null,
      -- Its own key. journal_entries carries a unique constraint on the command key, and the fee
      -- is a second entry: one voucher for the money that moved, one for the fee that was earned,
      -- so a commission report can be read on its own. Replay is still guarded on the real key by
      -- accounting_commands above, which returns before either entry is written.
      left('commission — ' || coalesce(p_description, 'service'), 500), p_command_key || ':fee',
      case when p_customer_id is not null then 'customer' end, p_customer_id, null, current_date);

    -- Collected now means it is really in the safe, so the safe says so.
    if coalesce(p_commission_collected, false) then
      insert into public.ledger(id, type, cur_id, amount, note, date,
                                command_key, created_by, tenant_id)
      values ('led-svc-' || md5(p_id || ':fee'), 'commission', v_account.cur_id, p_commission,
              left('commission — ' || coalesce(p_description, 'service'), 1000),
              statement_timestamp(), p_command_key, v_actor.id, v_actor.tenant_id);
    end if;
  end if;

  perform public.sarraf_write_audit(v_actor.id, 'service_transaction',
    format('%s %s %s, commission %s', p_direction, p_amount, v_code, coalesce(p_commission, 0)));

  -- Principal and commission are returned apart, and there is deliberately no combined total.
  v_result := jsonb_build_object(
    'id', p_id, 'account', v_account.id, 'account_name', v_account.name,
    'direction', p_direction, 'currency', v_code,
    'principal', p_amount, 'commission', coalesce(p_commission, 0),
    'commission_collected', coalesce(p_commission_collected, false),
    'commission_receivable', case when coalesce(p_commission_collected, false)
                                  then 0 else coalesce(p_commission, 0) end,
    'entry_id', v_entry, 'commission_entry_id', v_fee_entry, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'service_transaction', v_result);
  return v_result;
end;
$fn$;

revoke all on function public.sarraf_open_cash_account(text, text, text, text, text) from public, anon;
grant execute on function public.sarraf_open_cash_account(text, text, text, text, text) to authenticated;
revoke all on function public.sarraf_cash_account_balances() from public, anon;
grant execute on function public.sarraf_cash_account_balances() to authenticated;
revoke all on function public.sarraf_service_transaction(text, text, text, numeric, numeric, boolean, text, text, text) from public, anon;
grant execute on function public.sarraf_service_transaction(text, text, text, numeric, numeric, boolean, text, text, text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_open_cash_account(text, text, text, text, text) owner to sarraf_definer;
alter function public.sarraf_cash_account_balances() owner to sarraf_definer;
alter function public.sarraf_service_transaction(text, text, text, numeric, numeric, boolean, text, text, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

-- sarraf_schema_tables holds a written list of every table, and anything not on it is reported as
-- unmanaged. Re-declared here with cash_accounts on it, which is what keeps the list honest.
create or replace function public.sarraf_schema_tables()
returns table(table_name text, state text)
language sql
stable
set search_path = pg_catalog, public
as $tables$
  with expected(t) as (values
    ('account_ledger'), ('account_transfers'), ('accounting_commands'), ('app_users'),
    ('approval_events'), ('approval_requests'), ('audit'), ('cash_accounts'),
    ('chart_of_accounts'),
    ('control_settings'), ('currencies'), ('customer_vault_events'), ('customer_vaults'),
    ('day_closes'), ('debt_events'), ('debt_settlements'), ('debts'), ('financial_commands'),
    ('journal_entries'), ('journal_lines'), ('ledger'), ('manager_support_sessions'), ('notes'), ('ocr_attestations'),
    ('office_payment_assignments'), ('office_payment_events'), ('office_payment_evidence'),
    ('office_pending_assignments'), ('partner_account_events'), ('partner_accounts'),
    ('pending_accounts'),
    ('rate_history'), ('rate_limit_counters'), ('receipt_assignment_events'),
    ('receipt_audit_events'), ('receipt_batch_transactions'), ('receipt_batches'),
    ('receipt_command_log'), ('receipt_control_policy'), ('receipt_custody'),
    ('receipt_custody_events'), ('receipt_custody_ledger'), ('receipt_daily_rates'),
    ('receipt_documents'), ('receipt_extractions'), ('receipt_forwardings'),
    ('receipt_ingestion_authorizations'), ('receipt_ingestion_commands'),
    ('receipt_intake_items'), ('receipt_match_commands'), ('receipt_notifications'),
    ('receipt_ocr_attempts'), ('receipt_operation_commands'), ('receipt_pending_conversions'),
    ('receipt_review_commands'), ('receipt_state_transitions'),
    ('receipt_transaction_assignments'), ('receipts'), ('schema_migrations'),
    ('system_event_log'),
    ('tenant_rates'), ('tenants'),
    ('transaction_payment_events'), ('tx_versions'), ('txs'), ('voucher_counters'), ('vouchers'),
    ('zeman_faults'), ('zeman_notifications')
  ), live as (
    select c.relname::text as t
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  )
  select e.t, 'missing from the database'
  from expected e where not exists (select 1 from live l where l.t = e.t)
  union all
  select l.t, 'in the database, unmanaged by any migration'
  from live l where not exists (select 1 from expected e where e.t = l.t)
  order by 1;
$tables$;

-- sarraf_schema_tables holds a written list of every table, and anything not on it is reported as
-- unmanaged. Re-declared here with cash_accounts on it, which is what keeps the list honest.
create or replace function public.sarraf_schema_tables()
returns table(table_name text, state text)
language sql
stable
set search_path = pg_catalog, public
as $tables$
  with expected(t) as (values
    ('account_ledger'), ('account_transfers'), ('accounting_commands'), ('app_users'),
    ('approval_events'), ('approval_requests'), ('audit'), ('cash_accounts'),
    ('chart_of_accounts'),
    ('control_settings'), ('currencies'), ('customer_vault_events'), ('customer_vaults'),
    ('day_closes'), ('debt_events'), ('debt_settlements'), ('debts'), ('financial_commands'),
    ('journal_entries'), ('journal_lines'), ('ledger'), ('manager_support_sessions'), ('notes'), ('ocr_attestations'),
    ('office_payment_assignments'), ('office_payment_events'), ('office_payment_evidence'),
    ('office_pending_assignments'), ('partner_account_events'), ('partner_accounts'),
    ('pending_accounts'),
    ('rate_history'), ('rate_limit_counters'), ('receipt_assignment_events'),
    ('receipt_audit_events'), ('receipt_batch_transactions'), ('receipt_batches'),
    ('receipt_command_log'), ('receipt_control_policy'), ('receipt_custody'),
    ('receipt_custody_events'), ('receipt_custody_ledger'), ('receipt_daily_rates'),
    ('receipt_documents'), ('receipt_extractions'), ('receipt_forwardings'),
    ('receipt_ingestion_authorizations'), ('receipt_ingestion_commands'),
    ('receipt_intake_items'), ('receipt_match_commands'), ('receipt_notifications'),
    ('receipt_ocr_attempts'), ('receipt_operation_commands'), ('receipt_pending_conversions'),
    ('receipt_review_commands'), ('receipt_state_transitions'),
    ('receipt_transaction_assignments'), ('receipts'), ('schema_migrations'),
    ('system_event_log'),
    ('tenant_rates'), ('tenants'),
    ('transaction_payment_events'), ('tx_versions'), ('txs'), ('voucher_counters'), ('vouchers'),
    ('zeman_faults'), ('zeman_notifications')
  ), live as (
    select c.relname::text as t
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  )
  select e.t, 'missing from the database'
  from expected e where not exists (select 1 from live l where l.t = e.t)
  union all
  select l.t, 'in the database, unmanaged by any migration'
  from live l where not exists (select 1 from expected e where e.t = l.t)
  order by 1;
$tables$;

commit;
