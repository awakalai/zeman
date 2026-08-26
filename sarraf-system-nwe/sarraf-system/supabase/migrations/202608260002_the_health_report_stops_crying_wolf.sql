-- The health report named fourteen tables as missing, and all fourteen are there.
--
-- The manager signed in and the health tab said: accounting_commands — not in the database.
-- control_settings — not in the database. Twelve more like it. Every one of those tables exists,
-- and the accounting gate proves it on every run.
--
-- information_schema is filtered by privilege. It shows a table only to somebody who holds some
-- right on it, which is a sensible default for a catalogue meant to describe *your* database, and
-- exactly wrong for a report meant to describe *the* database. The fourteen it hid are the
-- internal ones — the command logs, the counters, the control settings — which no client may read
-- directly and which are reached only through SECURITY DEFINER functions. So the report ran as
-- the manager, could not see them, and concluded they did not exist.
--
-- These three functions are SECURITY INVOKER — no `security definer` on any of them — so they
-- always ran as whoever asked. That was survivable while the only caller was a superuser at a
-- psql prompt. It stopped being survivable the moment a person opened the screen.
--
-- Making them SECURITY DEFINER would fix the symptom and keep the fault: the answer would still
-- depend on who owns them. pg_catalog is not privilege-filtered at all, so a report built from it
-- describes the database for every caller, which is the only thing a health report can be worth.
--
-- A report that cries wolf is worse than no report. It teaches the person reading it that the
-- warnings are noise, and the fifteenth one — the real one — is read the same way.
begin;

-- ── which tables exist ──────────────────────────────────────────────────────
create or replace function public.sarraf_schema_tables()
returns table(table_name text, state text)
language sql
stable
set search_path = pg_catalog, public
as $tables$
  with expected(t) as (values
    ('account_ledger'), ('account_transfers'), ('accounting_commands'), ('app_users'),
    ('approval_events'), ('approval_requests'), ('audit'), ('chart_of_accounts'),
    ('control_settings'), ('currencies'), ('customer_vault_events'), ('customer_vaults'),
    ('day_closes'), ('debt_events'), ('debt_settlements'), ('debts'), ('financial_commands'),
    ('journal_entries'), ('journal_lines'), ('ledger'), ('notes'), ('ocr_attestations'),
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
    ('transaction_payment_events'), ('tx_versions'), ('txs'), ('voucher_counters'), ('vouchers')
  ), live as (
    -- pg_class, not information_schema: this must answer the same for everybody who asks.
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

-- ── which columns are the type they are supposed to be ──────────────────────
--
-- format_type gives 'numeric(20,8)' where information_schema.data_type gave 'numeric', so the
-- comparison keeps only what comes before the bracket. The expectations are about the kind of
-- thing a column holds — text where a date was meant is the fault this catches — and a precision
-- nobody wrote down is not drift.
create or replace function public.sarraf_schema_drift()
returns table(table_name text, column_name text, expected text, found text)
language sql
stable
set search_path = pg_catalog, public
as $drift$
  with expected(t, c, ty) as (values
    ('audit', 'user_id', 'text'),
    ('receipts', 'tx_date', 'date'),
    ('receipts', 'tx_time', 'time without time zone'),
    ('receipts', 'amount', 'numeric'),
    ('receipts', 'counted', 'boolean'),
    ('receipts', 'raw', 'jsonb'),
    ('receipt_batches', 'created_at', 'timestamp with time zone'),
    ('receipt_batches', 'rejected_n', 'integer'),
    ('currencies', 'rate', 'numeric')
  ), live as (
    select c.relname::text as t,
           a.attname::text as c,
           split_part(format_type(a.atttypid, a.atttypmod), '(', 1) as ty
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and a.attnum > 0 and not a.attisdropped
  )
  select e.t, e.c, e.ty, coalesce(l.ty, '<missing>')
    from expected e
    left join live l on l.t = e.t and l.c = e.c
   where coalesce(l.ty, '<missing>') is distinct from e.ty;
$drift$;

grant execute on function public.sarraf_schema_tables() to authenticated;
grant execute on function public.sarraf_schema_drift() to authenticated;
grant execute on function public.sarraf_schema_report() to authenticated;

-- ── the same fault, in the tenancy reports ──────────────────────────────────
--
-- Not yet visible, because these are SECURITY DEFINER and sarraf_definer was granted the whole
-- schema. But pending_accounts was created after that grant and is revoked from authenticated,
-- so the coverage report was already one table blind and nothing had noticed. Built from
-- pg_catalog, the question stops depending on who is asking.
create or replace function public.sarraf_tenant_coverage()
returns table (table_name text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $coverage$
  with shared(t) as (values
    ('tenants'), ('app_users'), ('currencies'), ('chart_of_accounts'),
    ('schema_migrations'), ('pending_accounts')
  ), live as (
    select c.oid, c.relname::text as t, c.relrowsecurity as rls,
           exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id'
                      and a.attnum > 0 and not a.attisdropped) as tenanted,
           (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid) as policies
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  )
  select l.t, 'holds no tenant_id'
    from live l where not l.tenanted and not exists (select 1 from shared s where s.t = l.t)
  union all
  select l.t, 'has tenant_id but no row-level security'
    from live l where l.tenanted and not l.rls
  union all
  select l.t, 'has row-level security but no policy'
    from live l where l.tenanted and l.rls and l.policies = 0
   order by 1;
$coverage$;

create or replace function public.sarraf_tenant_orphans()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $orphans$
declare t record; n bigint; out jsonb := '{}'::jsonb;
begin
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may audit tenancy';
  end if;
  for t in
    select c.relname::text as table_name
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id'
                      and a.attnum > 0 and not a.attisdropped)
       and c.relname not in ('app_users', 'tenant_rates', 'pending_accounts')
     order by c.relname
  loop
    execute format('select count(*) from public.%I where tenant_id is null', t.table_name) into n;
    if n > 0 then out := out || jsonb_build_object(t.table_name, n); end if;
  end loop;
  return out;
end;
$orphans$;

do $own$
begin
  if exists (select 1 from pg_roles where rolname = 'sarraf_definer') then
    execute 'grant create on schema public to sarraf_definer';
    execute 'alter function public.sarraf_tenant_coverage() owner to sarraf_definer';
    execute 'alter function public.sarraf_tenant_orphans() owner to sarraf_definer';
    execute 'revoke create on schema public from sarraf_definer';
  end if;
end
$own$;

commit;
