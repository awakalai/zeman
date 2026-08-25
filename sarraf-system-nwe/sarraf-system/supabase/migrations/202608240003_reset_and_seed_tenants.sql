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
begin;

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

commit;
