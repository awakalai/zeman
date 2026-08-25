-- One buyer's staff must not reach another buyer's rows, and until now they could.
--
-- Row-level security kept the tables apart correctly — a gate that connects as `authenticated`
-- and tries confirms it. What it does not cover is SECURITY DEFINER, and there are 128 of those.
-- Such a function runs as its owner rather than its caller, which is the whole point: it reads
-- tables the caller has no rights on. It also means row-level security does not apply, so a
-- function that takes an id from the caller and returns what it finds hands over whatever that
-- id points at, in whosever business it happens to be.
--
--   select public.sarraf_partner_batch_detail('a batch id from the other business')
--
-- returned the other business's batch. So did sarraf_batch_summary. Both were caught by the new
-- isolation gate, which is the first thing in this repository ever to connect as the role the
-- application actually uses; every other database check runs as the superuser, and a superuser
-- ignores policies entirely. The tenant policies written a fortnight ago had never once been
-- executed.
--
-- Editing 128 function bodies is not the fix. It is 128 chances to get one wrong, and it leaves
-- the 129th — written next month by somebody who did not read this — wrong by default.
--
-- The fix is that the functions stop being able to bypass row-level security at all.
--
-- `force row level security` makes policies apply to a table's owner as well. That alone does
-- nothing here, because the role owning these functions is `postgres`, and `postgres` carries
-- BYPASSRLS: it ignores policies whatever FORCE says. So the functions move to a role that
-- cannot. `sarraf_definer` owns them, holds exactly the table privileges they need, and has no
-- way around a policy. Nothing about any function body changes; what changes is who it is.
begin;

-- ── the role that runs them ─────────────────────────────────────────────────
do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'sarraf_definer') then
    -- NOLOGIN: nobody connects as this, it is only ever reached through a function.
    -- NOBYPASSRLS is the entire point and is spelled out rather than left to the default.
    create role sarraf_definer nologin nobypassrls;
  end if;
end
$role$;

-- Every policy on every business table is written `to authenticated`, and a policy names the
-- roles it applies to. A role that is not one of them has no policy applying to it at all —
-- which PostgreSQL reads not as "unrestricted" but as "no rows", the safe reading and the one
-- that breaks everything. The first version of this migration missed that and the guard that
-- decides who may create an administrator started refusing everybody, because the function it
-- asks could no longer see even the asker's own row.
--
-- Membership, and INHERIT with it: policy applicability is decided by whether the current role
-- has the privileges of the named one, so a NOINHERIT member would still see nothing.
alter role sarraf_definer inherit;
do $member_auth$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and not pg_has_role('sarraf_definer', 'authenticated', 'member') then
    grant authenticated to sarraf_definer;
  end if;
end
$member_auth$;

-- Ownership can only be given to a role the current user can SET ROLE to, and that is not the
-- same as being able to administer it. PostgreSQL 16 separated the two: creating a role grants
-- the creator ADMIN OPTION but not SET, and pg_has_role(..., 'member') answers true on the
-- strength of the admin option alone. So the guarded version of this skipped the grant it needed
-- and the first ALTER FUNCTION stopped with `must be able to SET ROLE "sarraf_definer"` — on the
-- live database only, because the postgres role in this container is a superuser and a superuser
-- can SET ROLE to anything without being granted it.
--
-- Granted unconditionally, therefore, and with SET spelled out. The clause is PostgreSQL 16 and
-- later; on an older server the statement is a syntax error rather than a wrong outcome, and the
-- plain grant it falls back to carries SET on those versions anyway.
do $member$
begin
  begin
    execute format('grant sarraf_definer to %I with set true', current_user);
  exception when syntax_error or feature_not_supported then
    execute format('grant sarraf_definer to %I', current_user);
  end;
end
$member$;

-- What the functions need in order to do their work. Read and write on the business tables —
-- filtered by policy now, which is the change — and the schemas Supabase puts auth and storage in.
grant usage on schema public to sarraf_definer;
grant select, insert, update, delete on all tables in schema public to sarraf_definer;
grant usage, select on all sequences in schema public to sarraf_definer;
grant execute on all functions in schema public to sarraf_definer;

do $supabase$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    execute 'grant usage on schema auth to sarraf_definer';
    execute 'grant select on all tables in schema auth to sarraf_definer';
    execute 'grant execute on all functions in schema auth to sarraf_definer';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute 'grant usage on schema storage to sarraf_definer';
    execute 'grant select, insert, update, delete on all tables in schema storage to sarraf_definer';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    execute 'grant usage on schema extensions to sarraf_definer';
    execute 'grant execute on all functions in schema extensions to sarraf_definer';
  end if;
end
$supabase$;

-- Anything added later belongs to it too, without anybody remembering.
alter default privileges in schema public
  grant select, insert, update, delete on tables to sarraf_definer;
alter default privileges in schema public
  grant usage, select on sequences to sarraf_definer;
alter default privileges in schema public
  grant execute on functions to sarraf_definer;

-- ── which functions move, and which must not ────────────────────────────────
--
-- Three kinds stay owned by postgres, and each for a reason that breaks the system if ignored.
--
-- The policy helpers. sarraf_tenant, sarraf_tenant_visible and sarraf_sees_all_tenants are called
-- from inside the policies themselves, and they read app_users. If they were subject to the
-- policy on app_users, evaluating that policy would call them again — a policy that recurses
-- into itself, which PostgreSQL stops with an error rather than a wrong answer, so every query
-- against every business table would fail.
--
-- The trigger functions. A guard fires during somebody else's statement and must see the whole
-- table to do its job: an append-only guard that could not see the row it is protecting would
-- protect nothing.
--
-- And sarraf_reset_installation, which sets session_replication_role to lift those guards while
-- it clears an installation. That setting needs privileges this role deliberately does not have.
do $move$
declare
  f record;
  moved integer := 0;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and p.proname like 'sarraf%'
       and p.prorettype <> 'pg_catalog.trigger'::regtype
       and p.proname not in (
             'sarraf_tenant', 'sarraf_tenant_visible', 'sarraf_sees_all_tenants',
             'sarraf_reset_installation')
  loop
    execute format('alter function %s owner to sarraf_definer', f.sig);
    moved := moved + 1;
  end loop;
  raise notice '% function(s) can no longer bypass row-level security', moved;
end
$move$;

-- ── and now the policies actually bind ──────────────────────────────────────
--
-- Without FORCE, a policy is skipped for the table's owner. sarraf_definer now owns the
-- functions but not the tables, so strictly this is belt and braces — except that it is the
-- part that keeps being true if ownership ever changes again.
-- And a policy of its own, which is the part that took a broken run to see.
--
-- Subjecting these functions to row-level security subjects them to *every* policy, not only the
-- tenant one — including the per-role policies written for a browser talking to the database
-- directly. Those say things like "a customer sees their own cashbox". A function acting on a
-- customer's behalf is not that customer, so the deposit command started failing with `new row
-- violates row-level security policy for table customer_vaults`: it was being judged as though
-- it were the person it was serving.
--
-- The two kinds of policy do different jobs and this is where that pays off. Permissive policies
-- are ORed, so one saying `true` for sarraf_definer lets a function reach any row. Restrictive
-- policies are ANDed and cannot be widened by any permissive policy at all, so the tenant rule
-- still binds. Together they say exactly what was meant: these functions may act on any row —
-- within the business of whoever called them.
-- The permissive policy goes on every table with row-level security, not only the ones carrying
-- a tenant. Some tables deliberately have none: currencies and chart_of_accounts are definitions
-- every business shares, and 202608240002 left them out on purpose. They still have policies of
-- their own, though, and a role with no policy at all on a table sees no rows in it — so the
-- first version of this left the rate command updating zero rows while reporting success. That
-- is the third time this project has produced a silent no-op, and the reason the accounting gate
-- said "currency not updated".
--
-- FORCE only concerns tables carrying a tenant, since it exists to make the tenant rule bind.
do $force$
declare t record;
begin
  for t in
    select c.relname,
           exists (select 1 from information_schema.columns col
                    where col.table_schema = 'public' and col.table_name = c.relname
                      and col.column_name = 'tenant_id') as has_tenant
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     where c.relkind = 'r' and c.relrowsecurity
  loop
    if t.has_tenant then
      execute format('alter table public.%I force row level security', t.relname);
    end if;
    execute format('drop policy if exists %I on public.%I', t.relname || '_definer', t.relname);
    execute format(
      'create policy %I on public.%I as permissive for all to sarraf_definer
         using (true) with check (true)', t.relname || '_definer', t.relname);
  end loop;
end
$force$;

-- ── the two tables the tenant policy never reached ──────────────────────────
--
-- app_users was left out when the tenant policies were written, deliberately and wrongly: its
-- existing policy is `is_admin() OR auth_id = auth.uid()`, and that is permissive, so for an
-- administrator it evaluates to every account on the installation — including the other
-- business's staff, and the manager. An owner of one business could list the other's people.
--
-- tenant_rates was created two migrations after the policies were generated, so nothing had
-- covered it at all.
--
-- Restrictive, not permissive: a permissive policy is ORed with the others and can only widen
-- what is visible. Restrictive is ANDed, which is the only kind that can take something away.
drop policy if exists app_users_tenant on public.app_users;
create policy app_users_tenant on public.app_users
  as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

drop policy if exists tenant_rates_tenant_restrictive on public.tenant_rates;
create policy tenant_rates_tenant_restrictive on public.tenant_rates
  as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

comment on role sarraf_definer is
  'Owns the SECURITY DEFINER functions so that they cannot bypass row-level security. Never log in as this role, and never grant it BYPASSRLS.';

commit;
