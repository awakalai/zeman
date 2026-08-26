-- Did the three logins become the three accounts they were meant to be?
--
-- Read-only. The workflow opens the transaction with `set transaction read only`, so the server
-- refuses any write here rather than trusting that none was written.
--
-- The trigger on auth.users was supposed to notice each login as it was created and build the
-- account with the rank and business already decided. It swallows its own errors on purpose — a
-- failure there must not stop Supabase creating the login — which means a failure is silent, and
-- the only way to know is to look.

\pset format aligned
\pset border 2
\pset null '—'
\pset pager off

\echo ''
\echo '════════ 1. The three accounts ════════'
\echo ''

select
  coalesce(u.admin_level, u.role)                   as rank,
  u.name,
  coalesce(t.name, '— (manager: no business)')      as business,
  a.email                                           as sign_in,
  case when u.deleted then 'deactivated' else 'active' end as state
from public.app_users u
left join auth.users a on a.id = u.auth_id
left join public.tenants t on t.id = u.tenant_id
order by case coalesce(u.admin_level, u.role)
           when 'manager' then 1 when 'owner' then 2 else 3 end, u.name;

\echo ''
\echo '════════ 2. Was anything left unclaimed, or claimed twice? ════════'
\echo ''

select p.email,
       p.name,
       coalesce(p.admin_level, p.role) as intended_rank,
       coalesce(t.name, '—')           as intended_business,
       case
         when p.claimed_at is null and a.id is null then 'waiting — no login created yet'
         when p.claimed_at is null and a.id is not null then '⚠ LOGIN EXISTS BUT NO ACCOUNT WAS BUILT'
         when u.id is null then '⚠ marked claimed but the account is gone'
         else 'built'
       end as outcome
  from public.pending_accounts p
  left join public.tenants t on t.id = p.tenant_id
  left join auth.users a on lower(a.email) = lower(p.email)
  left join public.app_users u on u.id = p.app_id
 order by case coalesce(p.admin_level, p.role)
            when 'manager' then 1 when 'owner' then 2 else 3 end, p.email;

\echo ''
\echo '════════ 3. Logins with no account, and accounts with no login ════════'
\echo ''

select 'login with no account' as problem, a.email as who
  from auth.users a
 where not exists (select 1 from public.app_users u where u.auth_id = a.id)
union all
select 'account with no login', u.name
  from public.app_users u
 where u.auth_id is null or not exists (select 1 from auth.users a where a.id = u.auth_id)
 order by 1, 2;

\echo ''
\echo '════════ 4. The businesses, and whether each can be signed into ════════'
\echo ''

select t.id, t.name,
       case when t.active then 'active' else 'suspended' end as state,
       count(u.id) filter (where not u.deleted) as accounts,
       count(u.id) filter (where not u.deleted and u.admin_level = 'owner') as owners
  from public.tenants t
  left join public.app_users u on u.tenant_id = t.id
 group by t.id, t.name, t.active
 order by t.id;

\echo ''
\echo '════════ 5. Is the installation ready to be signed into? ════════'
\echo ''

do $ready$
declare
  v_managers int; v_owners int; v_tenants int; v_orphan_logins int; v_unbuilt int;
begin
  select count(*) into v_managers from public.app_users
   where admin_level = 'manager' and not deleted and auth_id is not null;
  select count(*) into v_owners from public.app_users
   where admin_level = 'owner' and not deleted and auth_id is not null;
  select count(*) into v_tenants from public.tenants where active;
  select count(*) into v_orphan_logins from auth.users a
   where not exists (select 1 from public.app_users u where u.auth_id = a.id);
  select count(*) into v_unbuilt from public.pending_accounts p
    join auth.users a on lower(a.email) = lower(p.email)
   where p.claimed_at is null;

  raise notice 'managers who can sign in: %', v_managers;
  raise notice 'business owners who can sign in: %', v_owners;
  raise notice 'active businesses: %', v_tenants;
  raise notice 'logins with no account behind them: %', v_orphan_logins;

  if v_managers = 1 and v_owners = 2 and v_tenants = 2
     and v_orphan_logins = 0 and v_unbuilt = 0 then
    raise notice '';
    raise notice '✓ ready: one manager, two businesses with an owner each, and nothing left over';
  else
    raise notice '';
    if v_managers <> 1 then raise notice '⚠ expected exactly one manager, found %', v_managers; end if;
    if v_owners <> 2 then raise notice '⚠ expected two business owners, found %', v_owners; end if;
    if v_tenants <> 2 then raise notice '⚠ expected two active businesses, found %', v_tenants; end if;
    if v_orphan_logins > 0 then raise notice '⚠ % login(s) can authenticate with no account', v_orphan_logins; end if;
    if v_unbuilt > 0 then raise notice '⚠ % login(s) exist that the trigger did not build', v_unbuilt; end if;
  end if;
end
$ready$;
