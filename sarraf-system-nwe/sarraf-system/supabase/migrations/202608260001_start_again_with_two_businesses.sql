-- Clearing the accounts and starting again, with two businesses and a way in that needs no
-- password to travel through a chat window.
--
-- What is here now: three real accounts, and ten logins left over from a fortnight of testing
-- that can authenticate but have no account behind them — each one a door with a known password
-- and nobody watching it. Every data table is empty. The owner asked to clear all of it and
-- rebuild: themselves as manager, سەرخێڵ as one business, وەتەن as another.
--
-- The awkward part is the passwords. Creating a login from SQL means choosing its password here,
-- which puts it in the repository and in whatever conversation asked for it. Supabase's dashboard
-- already does this properly — the owner types a password nobody else ever sees.
--
-- So the work is split at the right seam. This migration does everything that is not a secret:
-- clears the accounts, makes the businesses, and records who each future login is meant to be.
-- The owner adds three users in the dashboard. A trigger on auth.users notices each one arriving,
-- matches it by address, and creates the account with the rank and business already decided —
-- so there is no second step to remember and no window in which a login exists with no rank.
begin;

-- ── clear ───────────────────────────────────────────────────────────────────
--
-- Safe because there is nothing to lose: receipts, transactions, the ledger, the journal, debts
-- and vouchers all hold zero rows. This is still an installation that has not started.
alter table public.tenants drop constraint if exists tenants_created_by_fkey;
alter table public.tenants add constraint tenants_created_by_fkey
  foreign key (created_by) references public.app_users(id) on delete set null;

do $clear$
declare v_users integer; v_logins integer;
begin
  -- Refuse rather than destroy, if this ever meets a database that has started. A count is a
  -- cheap thing to check and an installation with a fortnight of real trades in it is not.
  if exists (select 1 from public.txs limit 1)
     or exists (select 1 from public.receipts limit 1)
     or exists (select 1 from public.ledger limit 1) then
    raise exception using errcode = '23514',
      message = 'this installation has trading data; clearing the accounts here would strand it';
  end if;

  update public.tenants set created_by = null;

  select count(*) into v_users from public.app_users;
  delete from public.app_users;

  -- The logins themselves. Supabase cascades sessions, identities and refresh tokens from here,
  -- so signing out happens as a consequence rather than as a separate thing to remember.
  select count(*) into v_logins from auth.users;
  delete from auth.users;

  raise notice 'cleared % account(s) and % login(s)', v_users, v_logins;
end
$clear$;

-- ── two businesses ──────────────────────────────────────────────────────────
--
-- کوردستان was a placeholder, made when the second buyer was hypothetical and empty ever since.
-- It has a name now. The row goes rather than being renamed, because an id is what every future
-- row of that business will carry and t-kurdistan would be a name nobody recognises.
delete from public.control_settings       where tenant_id = 't-kurdistan';
delete from public.receipt_control_policy where tenant_id = 't-kurdistan';
delete from public.tenant_rates           where tenant_id = 't-kurdistan';
delete from public.tenants                where id = 't-kurdistan';

insert into public.tenants(id, name, active, note) values
  ('t-sarkhel', 'سەرخێڵ', true, 'یەکەم کڕیاری سیستەمەکە'),
  ('t-watan',   'وەتەن',  true, 'دووەم کڕیاری سیستەمەکە')
on conflict (id) do update set name = excluded.name, active = true;

-- Each business keeps its own settings. Copied from whatever the installation already had, so a
-- new business starts from the same rules rather than from nothing.
do $settings$
declare t record;
begin
  for t in select id from public.tenants loop
    insert into public.control_settings
    select (jsonb_populate_record(null::public.control_settings,
              to_jsonb(c) || jsonb_build_object('tenant_id', t.id))).*
      from public.control_settings c where c.tenant_id <> t.id limit 1
    on conflict do nothing;

    insert into public.receipt_control_policy
    select (jsonb_populate_record(null::public.receipt_control_policy,
              to_jsonb(r) || jsonb_build_object('tenant_id', t.id))).*
      from public.receipt_control_policy r where r.tenant_id <> t.id limit 1
    on conflict do nothing;
  end loop;
end
$settings$;

-- ── who each login is meant to be, decided before it exists ─────────────────
create table if not exists public.pending_accounts (
  email       text primary key,
  app_id      text not null,
  name        text not null,
  role        text not null default 'admin',
  admin_level text,
  tenant_id   text references public.tenants(id) on delete cascade,
  note        text,
  created_at  timestamptz not null default statement_timestamp(),
  claimed_at  timestamptz
);

comment on table public.pending_accounts is
  'Who a login will be when it is created. The trigger on auth.users reads this and builds the account, so a password is only ever typed into Supabase''s own dashboard.';

alter table public.pending_accounts enable row level security;
revoke all on public.pending_accounts from public, anon, authenticated;
-- Only a manager, and only to look: the rows are written by migration and claimed by the trigger.
create policy pending_accounts_manager on public.pending_accounts
  for select to authenticated using (public.sarraf_sees_all_tenants());
grant select on public.pending_accounts to authenticated;

insert into public.pending_accounts(email, app_id, name, role, admin_level, tenant_id, note) values
  ('manager@sarraf.local', 'mgr-zeman', 'Manager',  'admin', 'manager', null,
   'خاوەنی سیستەمەکە — هەموو سەرخێڵەکان دەبینێت'),
  ('sarkhel@sarraf.local', 'own-sarkhel', 'سەرخێڵ', 'admin', 'owner',   't-sarkhel',
   'خاوەنی کاری یەکەم'),
  ('watan@sarraf.local',   'own-watan',   'وەتەن',  'admin', 'owner',   't-watan',
   'خاوەنی کاری دووەم')
on conflict (email) do update
  set app_id = excluded.app_id, name = excluded.name, role = excluded.role,
      admin_level = excluded.admin_level, tenant_id = excluded.tenant_id,
      note = excluded.note, claimed_at = null;

-- ── the trigger that joins the two halves ───────────────────────────────────
--
-- SECURITY DEFINER because it runs inside Supabase's own insert, where there is no signed-in
-- caller at all: auth.uid() is null, which is also why the rank guard lets this through — the
-- first administrator of any system is necessarily created by nobody.
--
-- Exception-swallowing on purpose. If this fails, Supabase's "Add user" fails with it and the
-- owner is left unable to create a login at all, which is a worse place to be than a login that
-- needs its account attaching by hand. The notice says what happened.
create or replace function public.sarraf_claim_pending_account()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare p public.pending_accounts%rowtype;
begin
  select * into p from public.pending_accounts
   where lower(email) = lower(new.email) and claimed_at is null;
  if not found then return new; end if;

  begin
    insert into public.app_users(id, name, role, admin_level, auth_id, tenant_id)
    values (p.app_id, p.name, p.role, p.admin_level, new.id, p.tenant_id)
    on conflict (id) do update
      set auth_id = excluded.auth_id, deleted = false;

    update public.pending_accounts set claimed_at = statement_timestamp() where email = p.email;
    raise notice 'account % created for %', p.app_id, new.email;
  exception when others then
    raise warning 'could not create the account for %: %', new.email, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists sarraf_claim_pending_account on auth.users;
create trigger sarraf_claim_pending_account
  after insert on auth.users
  for each row execute function public.sarraf_claim_pending_account();

-- ── and what to do about it ─────────────────────────────────────────────────
create or replace function public.sarraf_pending_accounts()
returns table (email text, name text, rank text, business text, waiting boolean)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.email, p.name,
         coalesce(p.admin_level, p.role) as rank,
         coalesce(t.name, '—')           as business,
         p.claimed_at is null            as waiting
    from public.pending_accounts p
    left join public.tenants t on t.id = p.tenant_id
   order by case coalesce(p.admin_level, p.role)
              when 'manager' then 1 when 'owner' then 2 else 3 end, p.email;
$$;

revoke all on function public.sarraf_pending_accounts() from public, anon;
grant execute on function public.sarraf_pending_accounts() to authenticated;

do $own$
begin
  if exists (select 1 from pg_roles where rolname = 'sarraf_definer') then
    execute 'grant create on schema public to sarraf_definer';
    execute 'alter function public.sarraf_pending_accounts() owner to sarraf_definer';
    execute 'revoke create on schema public from sarraf_definer';
  end if;
end
$own$;

do $say$
begin
  raise notice '───────────────────────────────────────────────────────────────';
  raise notice 'Now add three users in Supabase → Authentication → Add user,';
  raise notice 'with these addresses and passwords of your own choosing:';
  raise notice '  manager@sarraf.local  → ماناجەر (sees every business)';
  raise notice '  sarkhel@sarraf.local  → خاوەنی سەرخێڵ';
  raise notice '  watan@sarraf.local    → خاوەنی وەتەن';
  raise notice 'Each account is created automatically as the login appears.';
  raise notice '───────────────────────────────────────────────────────────────';
end
$say$;

-- ── the migration ledger, made part of the system it records ────────────────
--
-- schema_migrations is created by the workflow that applies migrations, on first use. That works
-- and it means the one table recording what has been applied is itself applied by nothing — so
-- the schema report calls it drift, correctly, and the report is noisier for being right.
--
-- Created here instead, with the same shape the workflow uses. The workflow's `create table if
-- not exists` then finds it already there.
create table if not exists public.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default statement_timestamp(),
  checksum text
);

comment on table public.schema_migrations is
  'Which migrations this database has had. Written by the apply-migrations workflow.';

-- ── two lists that would otherwise go quietly stale ─────────────────────────
--
-- Both of these exist because a list nobody maintains is a list that lies. A schema report that
-- has not heard of pending_accounts calls it drift; an orphan check that does not know a row may
-- legitimately belong to no business calls the manager's row orphaned. Each would be right to
-- complain, and each complaint would be noise that trains somebody to ignore the next one.
--
-- The whole expected set is restated rather than appended to, because there is no way to add one
-- name to a values list from outside it, and a second function that adds names would be a second
-- place to keep in step.
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
    select c.table_name::text as t
    from information_schema.tables c
    where c.table_schema = 'public' and c.table_type = 'BASE TABLE'
  )
  select e.t, 'missing from the database'
  from expected e where not exists (select 1 from live l where l.t = e.t)
  union all
  select l.t, 'in the database, unmanaged by any migration'
  from live l where not exists (select 1 from expected e where e.t = l.t)
  order by 1;
$tables$;

-- pending_accounts joins app_users and tenant_rates as a table where a null business is an
-- answer rather than an omission: the manager belongs to none, on purpose.
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
  for t in select c.table_name
             from information_schema.columns c
             join information_schema.tables x
               on x.table_schema = c.table_schema and x.table_name = c.table_name
              and x.table_type = 'BASE TABLE'
            where c.table_schema = 'public' and c.column_name = 'tenant_id'
              and c.table_name not in ('app_users', 'tenant_rates', 'pending_accounts')
            order by c.table_name
  loop
    execute format('select count(*) from public.%I where tenant_id is null', t.table_name) into n;
    if n > 0 then out := out || jsonb_build_object(t.table_name, n); end if;
  end loop;
  return out;
end;
$orphans$;

do $own_orphans$
begin
  if exists (select 1 from pg_roles where rolname = 'sarraf_definer') then
    execute 'grant create on schema public to sarraf_definer';
    execute 'alter function public.sarraf_tenant_orphans() owner to sarraf_definer';
    execute 'alter function public.sarraf_schema_tables() owner to sarraf_definer';
    execute 'revoke create on schema public from sarraf_definer';
  end if;
end
$own_orphans$;

-- ── the reset seeds the businesses that exist, not the placeholder ──────────
--
-- sarraf_reset_installation still creates کوردستان on a fresh database, which is now a name for
-- nothing. Only the two literals change; everything the function does stays as it is.
do $reseed$
declare v_src text; v_fixed text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sarraf_reset_installation';
  if v_src is null then return; end if;

  v_fixed := replace(v_src, '''t-kurdistan''', '''t-watan''');
  v_fixed := replace(v_fixed, 'کوردستان', 'وەتەن');
  v_fixed := replace(v_fixed, 'ئامادە بۆ کڕیاری داهاتوو — بەتاڵە', 'دووەم کڕیاری سیستەمەکە');
  if v_fixed <> v_src then execute v_fixed; end if;
end
$reseed$;

-- ── two more tables that belong to the installation, not to a business ──────
--
-- The coverage check requires a tenant_id on everything, and is right to: a table of business
-- data without one is a table two businesses share without meaning to. But four tables are the
-- installation's own and were already named as exceptions. Two more join them.
--
-- schema_migrations records what has been applied to this database. There is one database.
-- pending_accounts says who a login will become, and the manager's row belongs to no business by
-- design — the whole point of that rank.
create or replace function public.sarraf_tenant_coverage()
returns table (table_name text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $coverage$
  with shared(t, why) as (values
    ('tenants', 'the register of businesses'),
    ('app_users', 'people, filtered by their own tenant_id'),
    ('currencies', 'currency definitions shared by every business'),
    ('chart_of_accounts', 'the shared chart of accounts'),
    ('schema_migrations', 'what has been applied to this database, of which there is one'),
    ('pending_accounts', 'who a login will become; the manager''s row belongs to no business')
  ), live as (
    select c.table_name::text as t
    from information_schema.tables c
    where c.table_schema = 'public' and c.table_type = 'BASE TABLE'
  ), has_column as (
    select l.t, exists (
      select 1 from information_schema.columns k
       where k.table_schema = 'public' and k.table_name = l.t and k.column_name = 'tenant_id'
    ) as tenanted,
    (select relrowsecurity from pg_class where oid = ('public.' || quote_ident(l.t))::regclass) as rls,
    (select count(*) from pg_policies p
      where p.schemaname = 'public' and p.tablename = l.t) as policies
    from live l
  )
  select h.t, 'holds no tenant_id'
    from has_column h
   where not h.tenanted and not exists (select 1 from shared s where s.t = h.t)
  union all
  select h.t, 'has tenant_id but no row-level security'
    from has_column h
   where h.tenanted and not h.rls
  union all
  select h.t, 'has row-level security but no policy'
    from has_column h
   where h.tenanted and h.rls and h.policies = 0
   order by 1;
$coverage$;

do $own_coverage$
begin
  if exists (select 1 from pg_roles where rolname = 'sarraf_definer') then
    execute 'grant create on schema public to sarraf_definer';
    execute 'alter function public.sarraf_tenant_coverage() owner to sarraf_definer';
    execute 'revoke create on schema public from sarraf_definer';
  end if;
end
$own_coverage$;

commit;
