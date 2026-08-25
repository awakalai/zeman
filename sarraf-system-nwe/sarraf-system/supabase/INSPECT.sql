-- Did the isolation fix actually land, and does it hold on the live database?
--
-- Read-only. The workflow opens the transaction with `set transaction read only`, so the server
-- refuses any write here rather than trusting that none was written.
--
-- The gate that proves one business cannot reach another runs against a disposable PostgreSQL
-- built from the migration history. That is the right place to prove behaviour, and it is not
-- the same as this database — twice already a migration passed every local gate and failed here,
-- because the postgres role in the test container is a superuser and the one on Supabase is not.
--
-- So the same questions, asked of the real thing.

\pset format aligned
\pset border 2
\pset null '—'
\pset pager off

\echo ''
\echo '════════ 1. Can the functions still bypass row-level security? ════════'
\echo ''

select r.rolname as owner,
       r.rolsuper as is_superuser,
       r.rolbypassrls as bypasses_rls,
       count(p.oid) as security_definer_functions,
       case when r.rolsuper or r.rolbypassrls
            then 'CAN STILL BYPASS — the fix has not taken'
            else 'bound by policy' end as verdict
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  join pg_roles r on r.oid = p.proowner
 where p.proname like 'sarraf%' and p.prosecdef
 group by r.rolname, r.rolsuper, r.rolbypassrls
 order by 4 desc;

\echo ''
\echo '════════ 2. The role itself ════════'
\echo ''

select r.rolname, r.rolcanlogin as can_log_in, r.rolbypassrls as bypasses_rls,
       r.rolinherit as inherits,
       has_schema_privilege(r.oid, 'public', 'CREATE') as can_create_in_public,
       coalesce((select string_agg(m.rolname, ', ')
                   from pg_auth_members am join pg_roles m on m.oid = am.roleid
                  where am.member = r.oid), '—') as member_of
  from pg_roles r
 where r.rolname = 'sarraf_definer';

\echo ''
\echo '════════ 3. Business tables: forced, and carrying both kinds of policy ════════'
\echo ''

select count(*) as business_tables,
       count(*) filter (where c.relrowsecurity) as rls_on,
       count(*) filter (where c.relforcerowsecurity) as forced,
       count(*) filter (where exists (
         select 1 from pg_policy p where p.polrelid = c.oid and not p.polpermissive)) as has_restrictive,
       count(*) filter (where exists (
         select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_definer')) as has_definer_policy
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
 where c.relkind = 'r'
   and exists (select 1 from information_schema.columns col
                where col.table_schema = 'public' and col.table_name = c.relname
                  and col.column_name = 'tenant_id');

\echo ''
\echo '════════ 4. Anything left behind ════════'
\echo ''

select c.relname as table_name,
       case when not c.relforcerowsecurity then 'not forced' else '' end ||
       case when not exists (select 1 from pg_policy p
                              where p.polrelid = c.oid and not p.polpermissive)
            then ' no restrictive policy' else '' end ||
       case when not exists (select 1 from pg_policy p
                              where p.polrelid = c.oid and p.polname = c.relname || '_definer')
            then ' no definer policy' else '' end as missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
 where c.relkind = 'r'
   and exists (select 1 from information_schema.columns col
                where col.table_schema = 'public' and col.table_name = c.relname
                  and col.column_name = 'tenant_id')
   and (not c.relforcerowsecurity
        or not exists (select 1 from pg_policy p where p.polrelid = c.oid and not p.polpermissive)
        or not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = c.relname || '_definer'))
 order by c.relname;

\echo ''
\echo '════════ 5. Businesses, accounts, and what is in there ════════'
\echo ''

do $report$
declare r record; n bigint; t text;
begin
  for r in select coalesce(admin_level, role) as rank,
                  coalesce(tenant_id, '<no business>') as biz, count(*) as n
             from public.app_users where not deleted group by 1,2 order by 1,2
  loop
    raise notice 'account: % — % — %', r.rank, r.biz, r.n;
  end loop;

  for r in select id, name, active from public.tenants order by id loop
    raise notice 'business: % — % — %', r.id, r.name,
      case when r.active then 'active' else 'suspended' end;
  end loop;

  foreach t in array array['receipts','receipt_batches','txs','ledger','currencies'] loop
    execute format('select count(*) from public.%I', t) into n;
    raise notice 'rows in %: %', t, n;
  end loop;
end
$report$;
