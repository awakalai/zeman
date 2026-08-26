-- Why does the account-creation route say the signed-in owner has no account?
--
-- Read-only. The workflow opens the transaction with `set transaction read only`, so the server
-- refuses any write here rather than trusting that none was written.
--
-- The owner signs in as سەرخێڵ, opens the people screen, and is told their login has no account.
-- The account is there — three separate reports have said so. So the question is not whether the
-- row exists but why one particular reader cannot see it, and that reader is /api/admin-user,
-- which looks the profile up with the service-role key:
--
--   service.from("app_users").select(...).eq("auth_id", user.id).eq("deleted", false).maybeSingle()
--
-- Guessing at that has already cost one wrong answer — a stale session, which it was not. So this
-- runs the same query under the same role, and prints what it gets.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. The accounts, exactly as stored ════════'
\echo ''
\echo 'deleted is shown as it really is. The route filters on `deleted = false`, and a null there'
\echo 'is not false — it would drop the row and report the login as having no account.'
\echo ''

select u.id, u.name, coalesce(u.admin_level, u.role) as rank,
       u.tenant_id, u.deleted, u.auth_id,
       (a.id is not null) as login_exists
  from public.app_users u
  left join auth.users a on a.id = u.auth_id
 order by u.id;

\echo ''
\echo '════════ 2. The route''s own query, run as the role the route uses ════════'
\echo ''

do $asservice$
declare r record; n integer;
begin
  for r in select u.auth_id, u.name from public.app_users u where u.auth_id is not null loop
    -- SET LOCAL ROLE is what makes this the route''s question rather than a superuser''s: RLS is
    -- decided by current_user, and the superuser this script connects as sees everything.
    set local role service_role;
    select count(*) into n from public.app_users
     where auth_id = r.auth_id and deleted = false;
    reset role;
    raise notice 'service_role looking up % → % row(s)%', r.name, n,
      case when n = 1 then '' else '   ⚠ THE ROUTE WOULD REFUSE THIS LOGIN' end;
  end loop;
exception when others then
  reset role;
  raise notice '⚠ the lookup failed outright as service_role: %', sqlerrm;
end
$asservice$;

\echo ''
\echo '════════ 3. What service_role is allowed to do with app_users ════════'
\echo ''

select 'select' as privilege,
       has_table_privilege('service_role', 'public.app_users', 'select') as service_role,
       has_table_privilege('authenticated', 'public.app_users', 'select') as authenticated
union all
select 'insert',
       has_table_privilege('service_role', 'public.app_users', 'insert'),
       has_table_privilege('authenticated', 'public.app_users', 'insert')
union all
select 'update',
       has_table_privilege('service_role', 'public.app_users', 'update'),
       has_table_privilege('authenticated', 'public.app_users', 'update');

\echo ''
\echo '════════ 4. Row-level security on app_users, and who each policy is for ════════'
\echo ''

select c.relrowsecurity as rls_on,
       c.relforcerowsecurity as forced,
       (select rolbypassrls from pg_roles where rolname = 'service_role') as service_role_bypasses
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
 where c.relname = 'app_users';

select pol.polname,
       case pol.polpermissive when true then 'permissive' else 'RESTRICTIVE' end as kind,
       coalesce((select string_agg(r.rolname, ', ') from pg_roles r
                  where r.oid = any(pol.polroles)), 'everyone') as applies_to,
       pg_get_expr(pol.polqual, pol.polrelid) as using_expression
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
 where c.relname = 'app_users'
 order by pol.polpermissive, pol.polname;
