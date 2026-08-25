-- Can one business read another's rows?
--
-- Read-only. The workflow that runs this opens the transaction with `set transaction read only`,
-- so the server refuses any write here rather than trusting that none was written.
--
-- Row-level security is what keeps two businesses apart, and SECURITY DEFINER functions do not
-- obey it. That is the whole point of them — they read tables the caller has no rights on — and
-- it is also the one hole through which one buyer's data can reach another's screen. A function
-- that takes an id and returns what it finds, without asking whose business that id belongs to,
-- is a leak whatever the policies say.
--
-- So this asks the installed functions themselves, not the repository: which of them are
-- SECURITY DEFINER, which read a table that belongs to a business, and which of those never
-- mention a tenant at all.

\pset format aligned
\pset border 2
\pset null '—'
\pset pager off

\echo ''
\echo '════════ 1. SECURITY DEFINER functions that read business data without checking whose ════════'
\echo ''

with tenanted as (
  select table_name from information_schema.columns
   where table_schema = 'public' and column_name = 'tenant_id'
),
fns as (
  select p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef,
         pg_get_functiondef(p.oid) as body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'sarraf%'
     and p.prokind = 'f'
)
select f.proname,
       (select count(*) from tenanted t
         where f.body ~ ('\m' || t.table_name || '\M')) as business_tables_read,
       case
         when f.body ~* 'sarraf_tenant_visible|sarraf_sees_all_tenants' then 'checks tenant'
         when f.body ~* 'tenant_id' then 'mentions tenant_id'
         else 'NO TENANT CHECK'
       end as verdict
  from fns f
 where f.prosecdef
   and exists (select 1 from tenanted t where f.body ~ ('\m' || t.table_name || '\M'))
 order by verdict desc, f.proname;

\echo ''
\echo '════════ 2. Business tables missing row-level security, or missing the tenant policy ════════'
\echo ''

select c.relname as table_name,
       case when c.relrowsecurity then 'on' else 'RLS IS OFF' end as rls,
       coalesce((select string_agg(pol.polname, ', ' order by pol.polname)
                   from pg_policy pol
                  where pol.polrelid = c.oid and pol.polpermissive = false), 'NO RESTRICTIVE POLICY')
         as restrictive_policies
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
 where c.relkind = 'r'
   and exists (select 1 from information_schema.columns col
                where col.table_schema = 'public' and col.table_name = c.relname
                  and col.column_name = 'tenant_id')
   and (not c.relrowsecurity
        or not exists (select 1 from pg_policy pol
                        where pol.polrelid = c.oid and pol.polpermissive = false))
 order by c.relname;

\echo ''
\echo '════════ 3. Rows that belong to no business ════════'
\echo ''

do $orphans$
declare t record; n bigint; total bigint := 0;
begin
  for t in select table_name from information_schema.columns
            where table_schema = 'public' and column_name = 'tenant_id'
              and table_name <> 'app_users'
            order by table_name
  loop
    execute format('select count(*) from public.%I where tenant_id is null', t.table_name) into n;
    if n > 0 then
      raise notice 'orphaned: % — % row(s) belong to no business', t.table_name, n;
      total := total + n;
    end if;
  end loop;
  if total = 0 then
    raise notice 'no orphaned rows: every row of business data belongs to a business';
  end if;
end
$orphans$;

\echo ''
\echo '════════ 4. Accounts, businesses, and how much data is in there ════════'
\echo ''

do $report$
declare
  t text; n bigint; r record; has_level boolean;
begin
  if to_regclass('public.app_users') is null then
    raise notice 'app_users — table does not exist';
  else
    select exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'app_users'
                      and column_name = 'admin_level') into has_level;
    for r in execute format(
      'select %s as rank, coalesce(tenant_id, ''<no business>'') as biz,
              count(*) as n, count(*) filter (where deleted) as gone
         from public.app_users group by 1, 2 order by 1, 2',
      case when has_level then 'coalesce(admin_level, role)' else 'role' end)
    loop
      raise notice 'account: % — % — % (% deactivated)', r.rank, r.biz, r.n, r.gone;
    end loop;
  end if;

  if to_regclass('public.tenants') is null then
    raise notice 'tenants — table does not exist, so multi-tenancy has not been applied';
  else
    n := 0;
    for r in select id, name, active from public.tenants order by id loop
      raise notice 'business: % — % — %', r.id, r.name,
        case when r.active then 'active' else 'suspended' end;
      n := n + 1;
    end loop;
    if n = 0 then raise notice 'businesses: none — the reset and seed has not run'; end if;
  end if;

  foreach t in array array['receipts','receipt_batches','txs','ledger','system_event_log',
                           'journal_entries','debts','vouchers','partners','currencies'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'rows in % — table does not exist', t;
    else
      execute format('select count(*) from public.%I', t) into n;
      raise notice 'rows in %: %', t, n;
    end if;
  end loop;
end
$report$;
