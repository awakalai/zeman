-- ════════════════════════════════════════════════════════════════════════════
--  زیمان — هەموو مایگرەیشنەکان بە یەک فایل
--
--  هەمووی کۆپی بکە → Supabase → SQL Editor → Run
--  تەنها یەک جار. دووبارە ڕەنکردنی زیانی نییە.
--
--  ⚠️ ئەمە هەموو داتاکان دەسڕێتەوە جگە لە ئەکاونتی ماناجەرەکەت.
-- ════════════════════════════════════════════════════════════════════════════

begin;


-- ══════════ 202608240001_tenants.sql ══════════

-- One application, several businesses, and no way for either to see the other.
--
-- The owner maintains this system and sells it. Today one exchange runs on it; tomorrow another
-- buyer runs their own on the same installation, with their own staff and their own customers.
-- Neither may see a single row of the other's, and neither should ever have to trust that they
-- cannot — the database must make it impossible rather than the screens make it unlikely.
--
-- A tenant is a business. Every row that belongs to a business carries its tenant, and row-level
-- security compares that to the tenant of whoever is asking. The manager belongs to no tenant
-- and sees all of them, because the manager is the person the businesses bought the software
-- from rather than a party to any of their trades.
--
-- This file introduces the tenant and attaches it to people. The business tables follow in
-- 202608240002, separately, because a column added to sixty tables and a policy written for each
-- are two different kinds of change and reviewing them together hides both.

create table if not exists public.tenants (
  id text primary key,
  name text not null,
  -- The business's own reference for itself: a licence number, a shop name, whatever they use.
  reference text,
  active boolean not null default true,
  created_at timestamptz not null default statement_timestamp(),
  created_by text references public.app_users(id),
  note text
);

comment on table public.tenants is
  'One business running on this installation. Every row of business data belongs to exactly one.';

-- ── which business a person belongs to ──────────────────────────────────────
--
-- Null means the manager: somebody who belongs to no business and can see every one. Every other
-- account must name a tenant, and the guard below refuses one that does not.
alter table public.app_users add column if not exists tenant_id text references public.tenants(id);

create index if not exists idx_app_users_tenant on public.app_users(tenant_id);

comment on column public.app_users.tenant_id is
  'The business this account belongs to. Null only for a manager, who belongs to none and sees all.';

-- ── the caller's tenant ─────────────────────────────────────────────────────
--
-- SECURITY DEFINER and STABLE: every policy in the next migration calls it once per statement,
-- and it must read app_users without the caller needing rights on that table.
create or replace function public.sarraf_tenant()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select tenant_id from public.app_users where auth_id = auth.uid() and not deleted;
$$;

-- A manager sees across businesses. Nobody else ever does, whatever their rank inside one:
-- an owner is the top of their own business and no part of anybody else's.
create or replace function public.sarraf_sees_all_tenants()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select u.role = 'admin' and u.admin_level = 'manager'
    from public.app_users u where u.auth_id = auth.uid() and not deleted), false);
$$;

-- The one expression every policy uses. Written once so that a policy cannot get it subtly
-- wrong — the usual mistake being to forget that a null tenant on the row must not match a null
-- tenant on the caller, because two unknowns are not the same business.
create or replace function public.sarraf_tenant_visible(p_tenant text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.sarraf_sees_all_tenants()
      or (p_tenant is not null and p_tenant = public.sarraf_tenant());
$$;

grant execute on function public.sarraf_tenant() to authenticated;
grant execute on function public.sarraf_sees_all_tenants() to authenticated;
grant execute on function public.sarraf_tenant_visible(text) to authenticated;

-- ── every account except a manager belongs to a business ────────────────────
create or replace function public.sarraf_guard_tenant_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_level text := new.admin_level;
begin
  if v_level = 'manager' then
    if new.tenant_id is not null then
      raise exception using errcode = '23514',
        message = 'a manager belongs to no single business';
    end if;
    return new;
  end if;

  if new.tenant_id is null then
    raise exception using errcode = '23502',
      message = 'every account except a manager must belong to a business';
  end if;

  -- Nobody moves an account between businesses. Its transactions, receipts and debts stay where
  -- they were made, and an account that walked away from them would be a person with a history
  -- that is no longer theirs.
  if tg_op = 'UPDATE' and old.tenant_id is not null
     and new.tenant_id is distinct from old.tenant_id then
    raise exception using errcode = '42501',
      message = 'an account cannot be moved to another business';
  end if;

  return new;
end;
$$;

-- Deliberately not installed yet. The existing rows have no tenant, and a guard that refuses
-- them would lock everyone out before 202608240003 has given them one. The trigger is created
-- there, once the data satisfies it.

-- ── the tenants table protects itself ───────────────────────────────────────
alter table public.tenants enable row level security;
revoke all on public.tenants from public, anon, authenticated;
grant select on public.tenants to authenticated;

drop policy if exists tenants_manager_all on public.tenants;
create policy tenants_manager_all on public.tenants for all to authenticated
  using (public.sarraf_sees_all_tenants())
  with check (public.sarraf_sees_all_tenants());

-- A business may read its own row and no other. It cannot change it: the name a business trades
-- under is part of what it bought, not something it edits.
drop policy if exists tenants_own_read on public.tenants;
create policy tenants_own_read on public.tenants for select to authenticated
  using (id = public.sarraf_tenant());


-- ══════════ 202608240002_tenant_columns.sql ══════════

-- The tenant column, on every table that holds a business's own data.
--
-- Fifty-eight tables, one column each, one policy each. Generated from the list of tables the
-- migrations create rather than typed, because a table missed here is a table two businesses
-- share without knowing it — the single worst outcome this change exists to prevent.
-- 202608240004 asserts that none was missed.
--
-- The column defaults to the caller's own business, so an insert made by a signed-in person
-- stamps itself and a hundred call sites do not have to remember. A migration or service write
-- has no caller and leaves it null, which is visible to the manager alone — the safe direction to
-- fail in, and countable afterwards by sarraf_tenant_orphans.
--
-- **The tenant policy is RESTRICTIVE, and that is the whole of why this works.** PostgreSQL
-- combines permissive policies with OR: a permissive tenant policy would not narrow what a
-- customer may see, it would *widen* it to everything in their business, quietly undoing every
-- role rule this schema has. A restrictive policy is ANDed with the rest — you must be entitled
-- to the row by role, *and* it must belong to your business.
--
-- A restrictive policy alone grants nothing, so any table that had no permissive policy before
-- is given one that keeps its previous behaviour. Those tables were reachable by anyone with the
-- table grant; they still are, now within one business.
--
-- Deliberately absent: currencies and chart_of_accounts, which are definitions every business
-- shares, and app_users and tenants, which carry their tenancy already. Rates are a business's
-- own and are dealt with in 202608240005 — a rate is not a definition, it is a price, and two
-- businesses do not quote the same one.

alter table public.account_ledger add column if not exists tenant_id text references public.tenants(id);
alter table public.account_ledger alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_account_ledger_tenant on public.account_ledger(tenant_id);
alter table public.account_ledger enable row level security;

drop policy if exists account_ledger_tenant on public.account_ledger;
create policy account_ledger_tenant on public.account_ledger as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'account_ledger' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy account_ledger_open on public.account_ledger for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.account_transfers add column if not exists tenant_id text references public.tenants(id);
alter table public.account_transfers alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_account_transfers_tenant on public.account_transfers(tenant_id);
alter table public.account_transfers enable row level security;

drop policy if exists account_transfers_tenant on public.account_transfers;
create policy account_transfers_tenant on public.account_transfers as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'account_transfers' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy account_transfers_open on public.account_transfers for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.accounting_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.accounting_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_accounting_commands_tenant on public.accounting_commands(tenant_id);
alter table public.accounting_commands enable row level security;

drop policy if exists accounting_commands_tenant on public.accounting_commands;
create policy accounting_commands_tenant on public.accounting_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'accounting_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy accounting_commands_open on public.accounting_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.approval_events add column if not exists tenant_id text references public.tenants(id);
alter table public.approval_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_approval_events_tenant on public.approval_events(tenant_id);
alter table public.approval_events enable row level security;

drop policy if exists approval_events_tenant on public.approval_events;
create policy approval_events_tenant on public.approval_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'approval_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy approval_events_open on public.approval_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.approval_requests add column if not exists tenant_id text references public.tenants(id);
alter table public.approval_requests alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_approval_requests_tenant on public.approval_requests(tenant_id);
alter table public.approval_requests enable row level security;

drop policy if exists approval_requests_tenant on public.approval_requests;
create policy approval_requests_tenant on public.approval_requests as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'approval_requests' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy approval_requests_open on public.approval_requests for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.audit add column if not exists tenant_id text references public.tenants(id);
alter table public.audit alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_audit_tenant on public.audit(tenant_id);
alter table public.audit enable row level security;

drop policy if exists audit_tenant on public.audit;
create policy audit_tenant on public.audit as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'audit' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy audit_open on public.audit for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.control_settings add column if not exists tenant_id text references public.tenants(id);
alter table public.control_settings alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_control_settings_tenant on public.control_settings(tenant_id);
alter table public.control_settings enable row level security;

drop policy if exists control_settings_tenant on public.control_settings;
create policy control_settings_tenant on public.control_settings as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'control_settings' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy control_settings_open on public.control_settings for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.customer_vault_events add column if not exists tenant_id text references public.tenants(id);
alter table public.customer_vault_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_customer_vault_events_tenant on public.customer_vault_events(tenant_id);
alter table public.customer_vault_events enable row level security;

drop policy if exists customer_vault_events_tenant on public.customer_vault_events;
create policy customer_vault_events_tenant on public.customer_vault_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'customer_vault_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy customer_vault_events_open on public.customer_vault_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.customer_vaults add column if not exists tenant_id text references public.tenants(id);
alter table public.customer_vaults alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_customer_vaults_tenant on public.customer_vaults(tenant_id);
alter table public.customer_vaults enable row level security;

drop policy if exists customer_vaults_tenant on public.customer_vaults;
create policy customer_vaults_tenant on public.customer_vaults as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'customer_vaults' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy customer_vaults_open on public.customer_vaults for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.day_closes add column if not exists tenant_id text references public.tenants(id);
alter table public.day_closes alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_day_closes_tenant on public.day_closes(tenant_id);
alter table public.day_closes enable row level security;

drop policy if exists day_closes_tenant on public.day_closes;
create policy day_closes_tenant on public.day_closes as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'day_closes' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy day_closes_open on public.day_closes for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.debt_events add column if not exists tenant_id text references public.tenants(id);
alter table public.debt_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_debt_events_tenant on public.debt_events(tenant_id);
alter table public.debt_events enable row level security;

drop policy if exists debt_events_tenant on public.debt_events;
create policy debt_events_tenant on public.debt_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'debt_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy debt_events_open on public.debt_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.debt_settlements add column if not exists tenant_id text references public.tenants(id);
alter table public.debt_settlements alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_debt_settlements_tenant on public.debt_settlements(tenant_id);
alter table public.debt_settlements enable row level security;

drop policy if exists debt_settlements_tenant on public.debt_settlements;
create policy debt_settlements_tenant on public.debt_settlements as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'debt_settlements' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy debt_settlements_open on public.debt_settlements for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.debts add column if not exists tenant_id text references public.tenants(id);
alter table public.debts alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_debts_tenant on public.debts(tenant_id);
alter table public.debts enable row level security;

drop policy if exists debts_tenant on public.debts;
create policy debts_tenant on public.debts as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'debts' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy debts_open on public.debts for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.financial_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.financial_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_financial_commands_tenant on public.financial_commands(tenant_id);
alter table public.financial_commands enable row level security;

drop policy if exists financial_commands_tenant on public.financial_commands;
create policy financial_commands_tenant on public.financial_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'financial_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy financial_commands_open on public.financial_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.journal_entries add column if not exists tenant_id text references public.tenants(id);
alter table public.journal_entries alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_journal_entries_tenant on public.journal_entries(tenant_id);
alter table public.journal_entries enable row level security;

drop policy if exists journal_entries_tenant on public.journal_entries;
create policy journal_entries_tenant on public.journal_entries as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'journal_entries' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy journal_entries_open on public.journal_entries for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.journal_lines add column if not exists tenant_id text references public.tenants(id);
alter table public.journal_lines alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_journal_lines_tenant on public.journal_lines(tenant_id);
alter table public.journal_lines enable row level security;

drop policy if exists journal_lines_tenant on public.journal_lines;
create policy journal_lines_tenant on public.journal_lines as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'journal_lines' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy journal_lines_open on public.journal_lines for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.ledger add column if not exists tenant_id text references public.tenants(id);
alter table public.ledger alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_ledger_tenant on public.ledger(tenant_id);
alter table public.ledger enable row level security;

drop policy if exists ledger_tenant on public.ledger;
create policy ledger_tenant on public.ledger as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'ledger' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy ledger_open on public.ledger for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.notes add column if not exists tenant_id text references public.tenants(id);
alter table public.notes alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_notes_tenant on public.notes(tenant_id);
alter table public.notes enable row level security;

drop policy if exists notes_tenant on public.notes;
create policy notes_tenant on public.notes as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'notes' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy notes_open on public.notes for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.ocr_attestations add column if not exists tenant_id text references public.tenants(id);
alter table public.ocr_attestations alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_ocr_attestations_tenant on public.ocr_attestations(tenant_id);
alter table public.ocr_attestations enable row level security;

drop policy if exists ocr_attestations_tenant on public.ocr_attestations;
create policy ocr_attestations_tenant on public.ocr_attestations as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'ocr_attestations' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy ocr_attestations_open on public.ocr_attestations for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.office_payment_assignments add column if not exists tenant_id text references public.tenants(id);
alter table public.office_payment_assignments alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_office_payment_assignments_tenant on public.office_payment_assignments(tenant_id);
alter table public.office_payment_assignments enable row level security;

drop policy if exists office_payment_assignments_tenant on public.office_payment_assignments;
create policy office_payment_assignments_tenant on public.office_payment_assignments as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'office_payment_assignments' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy office_payment_assignments_open on public.office_payment_assignments for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.office_payment_events add column if not exists tenant_id text references public.tenants(id);
alter table public.office_payment_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_office_payment_events_tenant on public.office_payment_events(tenant_id);
alter table public.office_payment_events enable row level security;

drop policy if exists office_payment_events_tenant on public.office_payment_events;
create policy office_payment_events_tenant on public.office_payment_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'office_payment_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy office_payment_events_open on public.office_payment_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.office_payment_evidence add column if not exists tenant_id text references public.tenants(id);
alter table public.office_payment_evidence alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_office_payment_evidence_tenant on public.office_payment_evidence(tenant_id);
alter table public.office_payment_evidence enable row level security;

drop policy if exists office_payment_evidence_tenant on public.office_payment_evidence;
create policy office_payment_evidence_tenant on public.office_payment_evidence as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'office_payment_evidence' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy office_payment_evidence_open on public.office_payment_evidence for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.office_pending_assignments add column if not exists tenant_id text references public.tenants(id);
alter table public.office_pending_assignments alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_office_pending_assignments_tenant on public.office_pending_assignments(tenant_id);
alter table public.office_pending_assignments enable row level security;

drop policy if exists office_pending_assignments_tenant on public.office_pending_assignments;
create policy office_pending_assignments_tenant on public.office_pending_assignments as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'office_pending_assignments' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy office_pending_assignments_open on public.office_pending_assignments for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.partner_account_events add column if not exists tenant_id text references public.tenants(id);
alter table public.partner_account_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_partner_account_events_tenant on public.partner_account_events(tenant_id);
alter table public.partner_account_events enable row level security;

drop policy if exists partner_account_events_tenant on public.partner_account_events;
create policy partner_account_events_tenant on public.partner_account_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'partner_account_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy partner_account_events_open on public.partner_account_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.partner_accounts add column if not exists tenant_id text references public.tenants(id);
alter table public.partner_accounts alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_partner_accounts_tenant on public.partner_accounts(tenant_id);
alter table public.partner_accounts enable row level security;

drop policy if exists partner_accounts_tenant on public.partner_accounts;
create policy partner_accounts_tenant on public.partner_accounts as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'partner_accounts' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy partner_accounts_open on public.partner_accounts for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.rate_history add column if not exists tenant_id text references public.tenants(id);
alter table public.rate_history alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_rate_history_tenant on public.rate_history(tenant_id);
alter table public.rate_history enable row level security;

drop policy if exists rate_history_tenant on public.rate_history;
create policy rate_history_tenant on public.rate_history as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'rate_history' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy rate_history_open on public.rate_history for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.rate_limit_counters add column if not exists tenant_id text references public.tenants(id);
alter table public.rate_limit_counters alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_rate_limit_counters_tenant on public.rate_limit_counters(tenant_id);
alter table public.rate_limit_counters enable row level security;

drop policy if exists rate_limit_counters_tenant on public.rate_limit_counters;
create policy rate_limit_counters_tenant on public.rate_limit_counters as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'rate_limit_counters' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy rate_limit_counters_open on public.rate_limit_counters for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_assignment_events add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_assignment_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_assignment_events_tenant on public.receipt_assignment_events(tenant_id);
alter table public.receipt_assignment_events enable row level security;

drop policy if exists receipt_assignment_events_tenant on public.receipt_assignment_events;
create policy receipt_assignment_events_tenant on public.receipt_assignment_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_assignment_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_assignment_events_open on public.receipt_assignment_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_audit_events add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_audit_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_audit_events_tenant on public.receipt_audit_events(tenant_id);
alter table public.receipt_audit_events enable row level security;

drop policy if exists receipt_audit_events_tenant on public.receipt_audit_events;
create policy receipt_audit_events_tenant on public.receipt_audit_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_audit_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_audit_events_open on public.receipt_audit_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_batch_transactions add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_batch_transactions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_batch_transactions_tenant on public.receipt_batch_transactions(tenant_id);
alter table public.receipt_batch_transactions enable row level security;

drop policy if exists receipt_batch_transactions_tenant on public.receipt_batch_transactions;
create policy receipt_batch_transactions_tenant on public.receipt_batch_transactions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_batch_transactions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_batch_transactions_open on public.receipt_batch_transactions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_batches add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_batches alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_batches_tenant on public.receipt_batches(tenant_id);
alter table public.receipt_batches enable row level security;

drop policy if exists receipt_batches_tenant on public.receipt_batches;
create policy receipt_batches_tenant on public.receipt_batches as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_batches' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_batches_open on public.receipt_batches for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_command_log add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_command_log alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_command_log_tenant on public.receipt_command_log(tenant_id);
alter table public.receipt_command_log enable row level security;

drop policy if exists receipt_command_log_tenant on public.receipt_command_log;
create policy receipt_command_log_tenant on public.receipt_command_log as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_command_log' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_command_log_open on public.receipt_command_log for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_control_policy add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_control_policy alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_control_policy_tenant on public.receipt_control_policy(tenant_id);
alter table public.receipt_control_policy enable row level security;

drop policy if exists receipt_control_policy_tenant on public.receipt_control_policy;
create policy receipt_control_policy_tenant on public.receipt_control_policy as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_control_policy' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_control_policy_open on public.receipt_control_policy for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_custody add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_custody alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_custody_tenant on public.receipt_custody(tenant_id);
alter table public.receipt_custody enable row level security;

drop policy if exists receipt_custody_tenant on public.receipt_custody;
create policy receipt_custody_tenant on public.receipt_custody as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_custody' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_custody_open on public.receipt_custody for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_custody_events add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_custody_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_custody_events_tenant on public.receipt_custody_events(tenant_id);
alter table public.receipt_custody_events enable row level security;

drop policy if exists receipt_custody_events_tenant on public.receipt_custody_events;
create policy receipt_custody_events_tenant on public.receipt_custody_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_custody_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_custody_events_open on public.receipt_custody_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_custody_ledger add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_custody_ledger alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_custody_ledger_tenant on public.receipt_custody_ledger(tenant_id);
alter table public.receipt_custody_ledger enable row level security;

drop policy if exists receipt_custody_ledger_tenant on public.receipt_custody_ledger;
create policy receipt_custody_ledger_tenant on public.receipt_custody_ledger as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_custody_ledger' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_custody_ledger_open on public.receipt_custody_ledger for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_daily_rates add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_daily_rates alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_daily_rates_tenant on public.receipt_daily_rates(tenant_id);
alter table public.receipt_daily_rates enable row level security;

drop policy if exists receipt_daily_rates_tenant on public.receipt_daily_rates;
create policy receipt_daily_rates_tenant on public.receipt_daily_rates as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_daily_rates' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_daily_rates_open on public.receipt_daily_rates for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_documents add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_documents alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_documents_tenant on public.receipt_documents(tenant_id);
alter table public.receipt_documents enable row level security;

drop policy if exists receipt_documents_tenant on public.receipt_documents;
create policy receipt_documents_tenant on public.receipt_documents as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_documents' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_documents_open on public.receipt_documents for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_extractions add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_extractions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_extractions_tenant on public.receipt_extractions(tenant_id);
alter table public.receipt_extractions enable row level security;

drop policy if exists receipt_extractions_tenant on public.receipt_extractions;
create policy receipt_extractions_tenant on public.receipt_extractions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_extractions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_extractions_open on public.receipt_extractions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_forwardings add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_forwardings alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_forwardings_tenant on public.receipt_forwardings(tenant_id);
alter table public.receipt_forwardings enable row level security;

drop policy if exists receipt_forwardings_tenant on public.receipt_forwardings;
create policy receipt_forwardings_tenant on public.receipt_forwardings as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_forwardings' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_forwardings_open on public.receipt_forwardings for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_ingestion_authorizations add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_ingestion_authorizations alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_ingestion_authorizations_tenant on public.receipt_ingestion_authorizations(tenant_id);
alter table public.receipt_ingestion_authorizations enable row level security;

drop policy if exists receipt_ingestion_authorizations_tenant on public.receipt_ingestion_authorizations;
create policy receipt_ingestion_authorizations_tenant on public.receipt_ingestion_authorizations as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_ingestion_authorizations' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_ingestion_authorizations_open on public.receipt_ingestion_authorizations for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_ingestion_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_ingestion_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_ingestion_commands_tenant on public.receipt_ingestion_commands(tenant_id);
alter table public.receipt_ingestion_commands enable row level security;

drop policy if exists receipt_ingestion_commands_tenant on public.receipt_ingestion_commands;
create policy receipt_ingestion_commands_tenant on public.receipt_ingestion_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_ingestion_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_ingestion_commands_open on public.receipt_ingestion_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_intake_items add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_intake_items alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_intake_items_tenant on public.receipt_intake_items(tenant_id);
alter table public.receipt_intake_items enable row level security;

drop policy if exists receipt_intake_items_tenant on public.receipt_intake_items;
create policy receipt_intake_items_tenant on public.receipt_intake_items as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_intake_items' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_intake_items_open on public.receipt_intake_items for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_match_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_match_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_match_commands_tenant on public.receipt_match_commands(tenant_id);
alter table public.receipt_match_commands enable row level security;

drop policy if exists receipt_match_commands_tenant on public.receipt_match_commands;
create policy receipt_match_commands_tenant on public.receipt_match_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_match_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_match_commands_open on public.receipt_match_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_notifications add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_notifications alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_notifications_tenant on public.receipt_notifications(tenant_id);
alter table public.receipt_notifications enable row level security;

drop policy if exists receipt_notifications_tenant on public.receipt_notifications;
create policy receipt_notifications_tenant on public.receipt_notifications as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_notifications' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_notifications_open on public.receipt_notifications for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_ocr_attempts add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_ocr_attempts alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_ocr_attempts_tenant on public.receipt_ocr_attempts(tenant_id);
alter table public.receipt_ocr_attempts enable row level security;

drop policy if exists receipt_ocr_attempts_tenant on public.receipt_ocr_attempts;
create policy receipt_ocr_attempts_tenant on public.receipt_ocr_attempts as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_ocr_attempts' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_ocr_attempts_open on public.receipt_ocr_attempts for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_operation_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_operation_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_operation_commands_tenant on public.receipt_operation_commands(tenant_id);
alter table public.receipt_operation_commands enable row level security;

drop policy if exists receipt_operation_commands_tenant on public.receipt_operation_commands;
create policy receipt_operation_commands_tenant on public.receipt_operation_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_operation_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_operation_commands_open on public.receipt_operation_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_pending_conversions add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_pending_conversions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_pending_conversions_tenant on public.receipt_pending_conversions(tenant_id);
alter table public.receipt_pending_conversions enable row level security;

drop policy if exists receipt_pending_conversions_tenant on public.receipt_pending_conversions;
create policy receipt_pending_conversions_tenant on public.receipt_pending_conversions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_pending_conversions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_pending_conversions_open on public.receipt_pending_conversions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_review_commands add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_review_commands alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_review_commands_tenant on public.receipt_review_commands(tenant_id);
alter table public.receipt_review_commands enable row level security;

drop policy if exists receipt_review_commands_tenant on public.receipt_review_commands;
create policy receipt_review_commands_tenant on public.receipt_review_commands as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_review_commands' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_review_commands_open on public.receipt_review_commands for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_state_transitions add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_state_transitions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_state_transitions_tenant on public.receipt_state_transitions(tenant_id);
alter table public.receipt_state_transitions enable row level security;

drop policy if exists receipt_state_transitions_tenant on public.receipt_state_transitions;
create policy receipt_state_transitions_tenant on public.receipt_state_transitions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_state_transitions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_state_transitions_open on public.receipt_state_transitions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipt_transaction_assignments add column if not exists tenant_id text references public.tenants(id);
alter table public.receipt_transaction_assignments alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipt_transaction_assignments_tenant on public.receipt_transaction_assignments(tenant_id);
alter table public.receipt_transaction_assignments enable row level security;

drop policy if exists receipt_transaction_assignments_tenant on public.receipt_transaction_assignments;
create policy receipt_transaction_assignments_tenant on public.receipt_transaction_assignments as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipt_transaction_assignments' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipt_transaction_assignments_open on public.receipt_transaction_assignments for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.receipts add column if not exists tenant_id text references public.tenants(id);
alter table public.receipts alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_receipts_tenant on public.receipts(tenant_id);
alter table public.receipts enable row level security;

drop policy if exists receipts_tenant on public.receipts;
create policy receipts_tenant on public.receipts as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'receipts' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy receipts_open on public.receipts for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.system_event_log add column if not exists tenant_id text references public.tenants(id);
alter table public.system_event_log alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_system_event_log_tenant on public.system_event_log(tenant_id);
alter table public.system_event_log enable row level security;

drop policy if exists system_event_log_tenant on public.system_event_log;
create policy system_event_log_tenant on public.system_event_log as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'system_event_log' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy system_event_log_open on public.system_event_log for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.transaction_payment_events add column if not exists tenant_id text references public.tenants(id);
alter table public.transaction_payment_events alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_transaction_payment_events_tenant on public.transaction_payment_events(tenant_id);
alter table public.transaction_payment_events enable row level security;

drop policy if exists transaction_payment_events_tenant on public.transaction_payment_events;
create policy transaction_payment_events_tenant on public.transaction_payment_events as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'transaction_payment_events' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy transaction_payment_events_open on public.transaction_payment_events for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.tx_versions add column if not exists tenant_id text references public.tenants(id);
alter table public.tx_versions alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_tx_versions_tenant on public.tx_versions(tenant_id);
alter table public.tx_versions enable row level security;

drop policy if exists tx_versions_tenant on public.tx_versions;
create policy tx_versions_tenant on public.tx_versions as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'tx_versions' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy tx_versions_open on public.tx_versions for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.txs add column if not exists tenant_id text references public.tenants(id);
alter table public.txs alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_txs_tenant on public.txs(tenant_id);
alter table public.txs enable row level security;

drop policy if exists txs_tenant on public.txs;
create policy txs_tenant on public.txs as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'txs' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy txs_open on public.txs for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.voucher_counters add column if not exists tenant_id text references public.tenants(id);
alter table public.voucher_counters alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_voucher_counters_tenant on public.voucher_counters(tenant_id);
alter table public.voucher_counters enable row level security;

drop policy if exists voucher_counters_tenant on public.voucher_counters;
create policy voucher_counters_tenant on public.voucher_counters as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'voucher_counters' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy voucher_counters_open on public.voucher_counters for all to authenticated using (true) with check (true)';
  end if;
end $keep$;

alter table public.vouchers add column if not exists tenant_id text references public.tenants(id);
alter table public.vouchers alter column tenant_id set default public.sarraf_tenant();
create index if not exists idx_vouchers_tenant on public.vouchers(tenant_id);
alter table public.vouchers enable row level security;

drop policy if exists vouchers_tenant on public.vouchers;
create policy vouchers_tenant on public.vouchers as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

do $keep$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'vouchers' and permissive = 'PERMISSIVE'
  ) then
    execute 'create policy vouchers_open on public.vouchers for all to authenticated using (true) with check (true)';
  end if;
end $keep$;


-- ══════════ 202608240003_reset_and_seed_tenants.sql ══════════

-- Starting from nothing: the manager, two businesses, and no other data at all.
--
-- The owner asked for this in as many words — every account and every row cleared except their
-- own, so the system begins its real life clean rather than carrying whatever a fortnight of
-- testing left behind.
--
-- This migration deletes production data. That is exactly what it is for, and it is the only
-- file in this repository of which that is true. It is written to run once, on a database whose
-- contents nobody wants, and it will do nothing on a database that already has businesses in it
-- — a second run cannot empty a system that has since gone live.
--
-- Two businesses are created. The first is the buyer who has the system today. The second,
-- کوردستان, is empty and ready: the owner asked for a spare so that the next buyer can be given
-- a working business rather than waiting for one to be built.

create or replace function public.sarraf_reset_installation()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $reset$
declare
  v_tenants integer;
  v_manager text;
begin
  select count(*) into v_tenants from public.tenants;
  if v_tenants > 0 then
    raise notice 'businesses already exist; this reset does nothing';
    return jsonb_build_object('done', false, 'reason', 'businesses already exist');
  end if;

  select id into v_manager from public.app_users
   where role = 'admin' and admin_level = 'manager' and not deleted
   order by created_at limit 1;

  -- A database with nobody in it is a fresh install, not a system being reset: there is nothing
  -- to clear, and the businesses are simply created. This is the case every test run is in.
  if v_manager is null and not exists (select 1 from public.app_users) then
    insert into public.tenants(id, name, active, note) values
      ('t-sarkhel', 'سەرخێڵ', true, 'یەکەم کڕیاری سیستەمەکە'),
      ('t-kurdistan', 'کوردستان', true, 'ئامادە بۆ کڕیاری داهاتوو — بەتاڵە');
    raise notice 'fresh installation: two businesses created, nothing to clear';
    return jsonb_build_object('done', true, 'cleared', false);
  end if;

  -- Accounts exist but none of them is a manager. Clearing now would leave a database nobody can
  -- sign into. Refusing is recoverable; an empty system with no way in is not.
  if v_manager is null then
    raise exception using errcode = '23514',
      message = 'no manager exists; create one before resetting, or there would be no way back in';
  end if;

  -- Twenty-four of these tables carry an append-only guard: a ledger, a change log, a voucher
  -- register, the history of a debt. Every one of those guards is right, and every one of them
  -- refuses this delete — which is how the first version of this migration failed partway
  -- through on a real database, having already emptied the tables it reached first.
  --
  -- Clearing an installation is the one act that is allowed to remove them, and it is allowed
  -- precisely because nothing of the sort is being kept: this is a system that has not started.
  -- The guards are lifted for the length of one transaction and put back by the same statement
  -- list, so a failure anywhere rolls the whole thing back with them still in place.
  --
  -- session_replication_role = replica disables every non-system trigger at once, rather than
  -- naming twenty-four of them and discovering the twenty-fifth the way this was discovered.
  set local session_replication_role = replica;

  -- Every table that holds a business's data, emptied without a list to keep in step. A hand
  -- written list is a list that goes stale: the table added next month is the row that survives
  -- a reset nobody notices until two businesses are reading it.
  --
  -- `truncate ... cascade` follows the foreign keys itself, so nothing here has to know which
  -- child comes before which parent — the ordering that a hand-written list also gets wrong.
  declare
    v_tables text;
  begin
    select string_agg(format('public.%I', c.table_name), ', ')
      into v_tables
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
       and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public'
       and c.column_name = 'tenant_id'
       and c.table_name not in ('app_users', 'tenant_rates');

    if v_tables is not null then
      execute format('truncate table %s cascade', v_tables);
    end if;
    truncate table public.tenant_rates cascade;
  end;

  -- Every account except the manager. Their auth logins are left alone: removing those is the
  -- owner's to do from the dashboard, and a migration that deletes sign-ins is a migration that
  -- can lock somebody out of an account it was not asked about.
  delete from public.app_users where id <> v_manager;

  -- Back to normal before anything is created: the new businesses and their settings must be
  -- written with every guard, default and trigger in force.
  set local session_replication_role = origin;

  insert into public.tenants(id, name, reference, active, created_by, note) values
    ('t-sarkhel', 'سەرخێڵ', null, true, v_manager,
     'یەکەم کڕیاری سیستەمەکە'),
    ('t-kurdistan', 'کوردستان', null, true, v_manager,
     'ئامادە بۆ کڕیاری داهاتوو — بەتاڵە');

  raise notice 'reset complete: manager % kept, two businesses created', v_manager;
  return jsonb_build_object('done', true, 'cleared', true, 'manager', v_manager);
end;
$reset$;

-- Nobody but a manager, and never from the interface: this is the one thing here that destroys
-- data, and it should take a deliberate act at the database to reach it.
revoke all on function public.sarraf_reset_installation() from public, anon, authenticated;

select public.sarraf_reset_installation();

-- ── the settings each business keeps for itself ─────────────────────────────
--
-- control_settings and receipt_control_policy were built as one row for the whole installation:
-- `singleton boolean primary key`, from a time when there was only ever one business. Two
-- businesses sharing one approval threshold or one receipt policy is a leak of configuration —
-- one changes it, the other's rules move under them, and nothing anywhere reports it. They are
-- read through SECURITY DEFINER functions, which bypass row-level security entirely, so the
-- policies added above would not have caught it either.
--
-- The key becomes the business. The singleton column stays so that nothing reading it breaks;
-- it is simply no longer what identifies the row.
alter table public.control_settings drop constraint if exists control_settings_pkey;
alter table public.receipt_control_policy drop constraint if exists receipt_control_policy_pkey;

do $settings$
declare t record;
begin
  for t in select id from public.tenants loop
    -- jsonb_populate_record, not a text cast: a record literal is not JSON, and casting one
    -- through the other is how the copy silently becomes a different row.
    insert into public.control_settings
    select (jsonb_populate_record(null::public.control_settings,
              to_jsonb(c) || jsonb_build_object('tenant_id', t.id))).*
      from public.control_settings c where c.tenant_id is null limit 1;

    insert into public.receipt_control_policy
    select (jsonb_populate_record(null::public.receipt_control_policy,
              to_jsonb(r) || jsonb_build_object('tenant_id', t.id))).*
      from public.receipt_control_policy r where r.tenant_id is null limit 1;
  end loop;

  delete from public.control_settings where tenant_id is null;
  delete from public.receipt_control_policy where tenant_id is null;
end;
$settings$;

-- One row per business, now that the business is what identifies it.
create unique index if not exists control_settings_tenant_key
  on public.control_settings(tenant_id);
create unique index if not exists receipt_control_policy_tenant_key
  on public.receipt_control_policy(tenant_id);

-- Notifications a trigger wrote while there was no caller. They belong to no business and
-- nobody is waiting to read them.
delete from public.notes where tenant_id is null;

-- system_event_log is cleared with everything else. It is append-only by design and refuses an
-- ordinary delete — correctly, because a change log that can be tidied is not a change log — and
-- the only reason it goes here is that this is a system that has not started. What it recorded
-- was a fortnight of testing, and keeping that as the founding history of a real business would
-- be worse than losing it.

-- ── now that every account has a tenant or is the manager, the guard can stand ───
drop trigger if exists app_users_tenant_guard on public.app_users;
create trigger app_users_tenant_guard
  before insert or update on public.app_users
  for each row execute function public.sarraf_guard_tenant_membership();


-- ══════════ 202608240004_tenant_coverage.sql ══════════

-- Proving no table was left shared.
--
-- A table missed by 202608240002 is a table two businesses read from each other without either
-- knowing. It is the single worst outcome of this whole change, and it is silent — nothing
-- fails, nothing is logged, the wrong rows simply appear on somebody's screen one day.
--
-- So the coverage is a thing that can be asked rather than assumed. The function below names
-- every table in public that holds no tenant, or holds one and does not enforce it, and the
-- short list of tables for which that is correct is written down here with the reason.

create or replace function public.sarraf_tenant_coverage()
returns table(table_name text, problem text)
language sql
stable
set search_path = pg_catalog, public
as $$
  with shared(t, why) as (values
    -- The list of businesses itself. Its own policies decide who sees which row.
    ('tenants', 'the register of businesses'),
    -- Carries tenant_id as a membership rather than as data, and is filtered by it.
    ('app_users', 'people, filtered by their own tenant_id'),
    -- Definitions, not data: what USD and CNY are. Rates are per business and live elsewhere.
    ('currencies', 'currency definitions shared by every business'),
    -- The account codes every set of books is kept in. Shared so a report means the same thing
    -- whoever runs it.
    ('chart_of_accounts', 'the shared chart of accounts')
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
  select h.t, 'has a tenant_id but row-level security is off'
  from has_column h
  where h.tenanted and not coalesce(h.rls, false)
  union all
  select h.t, 'has a tenant_id and row-level security but no policy'
  from has_column h
  where h.tenanted and coalesce(h.rls, false) and h.policies = 0
  order by 2, 1;
$$;

grant execute on function public.sarraf_tenant_coverage() to authenticated;

-- ── rows that belong to nobody ──────────────────────────────────────────────
--
-- A tenant_id left null is invisible to every business and visible to the manager alone. That is
-- the safe direction to fail in, but it is still a row nobody can act on, so it is counted
-- rather than left to be discovered.
create or replace function public.sarraf_tenant_orphans()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
  v_out jsonb := '{}'::jsonb;
  v_count bigint;
begin
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may audit tenancy';
  end if;

  for r in
    select k.table_name::text as t
    from information_schema.columns k
    where k.table_schema = 'public' and k.column_name = 'tenant_id'
      and k.table_name <> 'app_users'
    order by 1
  loop
    execute format('select count(*) from public.%I where tenant_id is null', r.t) into v_count;
    if v_count > 0 then
      v_out := v_out || jsonb_build_object(r.t, v_count);
    end if;
  end loop;

  return jsonb_build_object('orphans', v_out, 'checked_at', statement_timestamp());
end;
$$;

revoke all on function public.sarraf_tenant_orphans() from public, anon;
grant execute on function public.sarraf_tenant_orphans() to authenticated;


-- ══════════ 202608240005_tenant_rates.sql ══════════

-- A rate is a price, not a definition. Two businesses do not quote the same one.
--
-- currencies.rate is one number per currency for the whole installation. What USD and CNY *are*
-- is shared and should be; what a yuan is worth today is each exchange's own judgement, and
-- letting one business set the number the other values its inventory by is the plainest possible
-- leak between them — not of a row somebody could notice, but of the figure every total on their
-- screen is computed from.
--
-- tenant_rates holds a rate per business per currency. currencies.rate stays where it is and
-- becomes the fallback: a business that has not set its own yet reads the installation's, which
-- is what keeps today's single business working unchanged from the moment this runs.
--
-- Every reader goes through sarraf_usd_value, so that is the only function that has to know. It
-- keeps its signature, so the twenty-five call sites are untouched and none of them can be the
-- one that was forgotten.

create table if not exists public.tenant_rates (
  tenant_id text not null references public.tenants(id) on delete cascade,
  cur_id text not null references public.currencies(id),
  -- One ratio, as Phase 2 established: 1 USD = rate × currency.
  rate numeric(20,8) not null check (rate > 0),
  updated_at timestamptz not null default statement_timestamp(),
  updated_by text references public.app_users(id),
  primary key (tenant_id, cur_id)
);

comment on table public.tenant_rates is
  'What one business says a currency is worth. Falls back to currencies.rate where unset.';

alter table public.tenant_rates enable row level security;
revoke all on public.tenant_rates from public, anon, authenticated;
grant select on public.tenant_rates to authenticated;

drop policy if exists tenant_rates_tenant on public.tenant_rates;
create policy tenant_rates_tenant on public.tenant_rates for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

-- ── the one reader ──────────────────────────────────────────────────────────
--
-- Same name, same arguments, same contract: null when the currency cannot be valued, because a
-- caller must be told that rather than handed a number nobody entered.
create or replace function public.sarraf_usd_value(p_amount numeric, p_cur_id text)
returns numeric
language plpgsql stable
security definer
set search_path = pg_catalog, public
as $$
declare v_rate numeric; v_tenant text;
begin
  if p_amount is null then return null; end if;
  if lower(p_cur_id) = 'usd' then return round(p_amount, 10); end if;

  v_tenant := public.sarraf_tenant();
  if v_tenant is not null then
    select r.rate into v_rate from public.tenant_rates r
     where r.tenant_id = v_tenant and r.cur_id = p_cur_id;
  end if;

  -- The installation's rate, for a business that has not set its own and for the manager, who
  -- belongs to no business and so has no rate of their own to read.
  if v_rate is null then
    select c.rate into v_rate from public.currencies c where c.id = p_cur_id;
  end if;

  if v_rate is null or v_rate <= 0 then return null; end if;
  return round(p_amount / v_rate, 10);
end;
$$;

grant execute on function public.sarraf_usd_value(numeric, text) to authenticated;

-- ── setting a business's own rate ───────────────────────────────────────────
--
-- Ordinary administrators of a business set that business's rates. Nobody sets another's, and
-- the policy above would refuse it even if a caller tried, so this command only has to check
-- that the caller is entitled to set a rate at all.
create or replace function public.sarraf_set_tenant_rate(
  p_cur_id text, p_rate numeric, p_command_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_tenant text;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'only an administrator may set a rate';
  end if;

  v_tenant := v_actor.tenant_id;
  if v_tenant is null then
    raise exception using errcode = '22023',
      message = 'a manager has no business of their own to set a rate for';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception using errcode = '22023', message = 'a ratio must be greater than zero';
  end if;
  if not exists (select 1 from public.currencies where id = p_cur_id) then
    raise exception using errcode = '22023', message = 'unknown currency';
  end if;

  insert into public.tenant_rates(tenant_id, cur_id, rate, updated_by)
  values (v_tenant, p_cur_id, p_rate, v_actor.id)
  on conflict (tenant_id, cur_id) do update
    set rate = excluded.rate, updated_at = statement_timestamp(), updated_by = excluded.updated_by;

  return jsonb_build_object('tenant_id', v_tenant, 'cur_id', p_cur_id, 'rate', p_rate);
end;
$$;

revoke all on function public.sarraf_set_tenant_rate(text, numeric, text) from public, anon;
grant execute on function public.sarraf_set_tenant_rate(text, numeric, text) to authenticated;

-- ── a notification belongs to the person it is for ──────────────────────────
--
-- notes rows are written by triggers, and a trigger firing inside a SECURITY DEFINER command has
-- no caller of its own to read a tenant from. The default therefore leaves them ownerless, and
-- an ownerless notification is one nobody can ever see.
--
-- The recipient is right there in the row. Taking the tenant from them is both correct and the
-- only answer that does not depend on who happened to be signed in when the trigger ran.
create or replace function public.sarraf_note_tenant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.tenant_id is null and new.user_id is not null then
    select u.tenant_id into new.tenant_id from public.app_users u where u.id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists notes_tenant on public.notes;
create trigger notes_tenant before insert on public.notes
  for each row execute function public.sarraf_note_tenant();


-- ══════════ 202608240006_manager_console.sql ══════════

-- What the manager's console reads and does.
--
-- The manager maintains the installation and sells it. They are not a party to any business's
-- trades, so this is the one place that looks across businesses — and everything in it is about
-- businesses, accounts and the health of the system rather than transactions, receipts or rates.
--
-- Every function refuses anybody who is not a manager, in the database, so a screen is not what
-- stands between a business owner and the list of their competitors.

-- ── the businesses ──────────────────────────────────────────────────────────
create or replace function public.sarraf_manager_tenants()
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare v_result jsonb;
begin
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may list the businesses';
  end if;

  select jsonb_build_object(
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'active', t.active, 'note', t.note,
        'created_at', t.created_at,
        'accounts', (select count(*) from public.app_users u
                      where u.tenant_id = t.id and not u.deleted),
        'admins', (select count(*) from public.app_users u
                    where u.tenant_id = t.id and not u.deleted and u.role = 'admin'),
        -- What the business has actually done. Counts only: the manager has no business seeing
        -- another party's figures, and a count is enough to know whether a tenant is in use.
        'transactions', (select count(*) from public.txs x
                          where x.tenant_id = t.id and not x.deleted),
        'receipts', (select count(*) from public.receipts r where r.tenant_id = t.id),
        'last_activity', greatest(
          (select max(x.date) from public.txs x where x.tenant_id = t.id),
          (select max(r.created_at) from public.receipts r where r.tenant_id = t.id)))
        order by t.created_at)
      from public.tenants t), '[]'::jsonb),
    'total_accounts', (select count(*) from public.app_users where not deleted),
    'managers', (select count(*) from public.app_users
                  where role = 'admin' and admin_level = 'manager' and not deleted)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.sarraf_manager_tenants() from public, anon;
grant execute on function public.sarraf_manager_tenants() to authenticated;

-- ── creating one ────────────────────────────────────────────────────────────
--
-- The id is typed once and lives forever in every row the business owns, so it is checked here
-- rather than trusted: lower case, digits and dashes, nothing that would need quoting or read
-- differently in one place than another.
create or replace function public.sarraf_manager_create_tenant(
  p_id text, p_name text, p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_id text := btrim(coalesce(p_id, ''));
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may create a business';
  end if;
  -- Not lower-cased for the caller: an id that silently changes is a surprise every time
  -- somebody types it, and this one appears in every row the business will ever own.
  if v_id !~ '^[a-z0-9][a-z0-9-]{2,}$' then
    raise exception using errcode = '22023',
      message = 'a business id is lower-case letters, digits and dashes, at least three characters';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception using errcode = '22023', message = 'a business needs a name';
  end if;
  if exists (select 1 from public.tenants where id = v_id) then
    raise exception using errcode = '23505', message = 'a business with that id already exists';
  end if;

  insert into public.tenants(id, name, note, created_by)
  values (v_id, btrim(p_name), nullif(btrim(coalesce(p_note, '')), ''), v_actor.id);

  -- The settings a business keeps for itself, copied from any existing business so a new one
  -- starts with the thresholds in use rather than with nothing.
  insert into public.control_settings
  select (jsonb_populate_record(null::public.control_settings,
            to_jsonb(c) || jsonb_build_object('tenant_id', v_id))).*
    from public.control_settings c limit 1;

  insert into public.receipt_control_policy
  select (jsonb_populate_record(null::public.receipt_control_policy,
            to_jsonb(r) || jsonb_build_object('tenant_id', v_id))).*
    from public.receipt_control_policy r limit 1;

  insert into public.audit(id, date, user_id, action, detail)
  values (gen_random_uuid()::text, statement_timestamp(), v_actor.id,
          'دروستکردنی سەرخێڵ', v_id || ' — ' || btrim(p_name));

  return jsonb_build_object('id', v_id, 'name', btrim(p_name), 'active', true);
end;
$$;

revoke all on function public.sarraf_manager_create_tenant(text, text, text) from public, anon;
grant execute on function public.sarraf_manager_create_tenant(text, text, text) to authenticated;

-- ── suspending one ──────────────────────────────────────────────────────────
--
-- Suspended, never deleted. A business that has stopped paying or stopped trading is not a
-- business whose books should be destroyed, and reversing a suspension is a switch where
-- reversing a deletion is a restore from backup.
create or replace function public.sarraf_manager_set_tenant_active(
  p_id text, p_active boolean, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_actor public.app_users%rowtype; v_tenant public.tenants%rowtype;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may suspend a business';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 4 then
    raise exception using errcode = '22023', message = 'a reason is required';
  end if;

  select * into v_tenant from public.tenants where id = p_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'no such business';
  end if;

  update public.tenants set active = coalesce(p_active, false) where id = p_id;

  insert into public.audit(id, date, user_id, action, detail)
  values (gen_random_uuid()::text, statement_timestamp(), v_actor.id,
          case when coalesce(p_active, false) then 'چالاککردنەوەی سەرخێڵ' else 'ڕاگرتنی سەرخێڵ' end,
          p_id || ' — ' || left(btrim(p_reason), 500));

  return jsonb_build_object('id', p_id, 'active', coalesce(p_active, false));
end;
$$;

revoke all on function public.sarraf_manager_set_tenant_active(text, boolean, text) from public, anon;
grant execute on function public.sarraf_manager_set_tenant_active(text, boolean, text) to authenticated;

-- ── every account, across every business ────────────────────────────────────
--
-- The one screen entitled to look across. The sign-in address is included because the manager is
-- the person who has to answer "which login is this?" when somebody cannot get in — and it is
-- the only thing here that is not already on a business's own screens.
create or replace function public.sarraf_manager_accounts()
returns table(
  id text, name text, role text, admin_level text,
  tenant_id text, tenant_name text, phone text, email text,
  deleted boolean, created_at timestamptz)
language plpgsql
security definer
stable
set search_path = pg_catalog, public, auth
as $$
begin
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may list every account';
  end if;

  return query
  select u.id, u.name, u.role, u.admin_level,
         u.tenant_id, t.name,
         u.phone,
         (select a.email::text from auth.users a where a.id = u.auth_id),
         u.deleted, u.created_at
  from public.app_users u
  left join public.tenants t on t.id = u.tenant_id
  order by
    case when u.admin_level = 'manager' then 0 else 1 end,
    t.name nulls first,
    case u.role when 'admin' then 0 when 'office' then 1 when 'partner' then 2
                when 'investor' then 3 else 4 end,
    u.name;
end;
$$;

revoke all on function public.sarraf_manager_accounts() from public, anon;
grant execute on function public.sarraf_manager_accounts() to authenticated;


commit;

-- ── پشکنین ──────────────────────────────────────────────────────────────────
-- دەبێت دوو سەرخێڵ و تەنها یەک ئەکاونت ببینیت.

select id, name, active from public.tenants order by id;

select id, name, admin_level, coalesce(tenant_id, '—') as tenant
from public.app_users where not deleted;
