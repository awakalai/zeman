-- Can one buyer's staff reach another buyer's rows, and what would close it?
--
-- Read-only. The workflow opens the transaction with `set transaction read only`, so the server
-- refuses any write here rather than trusting that none was written.
--
-- The last run found 128 SECURITY DEFINER functions that read business tables without mentioning
-- a tenant. sarraf_partner_batch_detail is typical: it looks a batch up by id and returns it, and
-- the id is supplied by the caller. Row-level security would have stopped that, and SECURITY
-- DEFINER is precisely what steps around row-level security.
--
-- Editing 128 function bodies by hand is not a fix, it is 128 chances to get one wrong. There is
-- a single switch that would close all of them at once — `alter table ... force row level
-- security` makes policies apply to the table's owner too, and therefore inside a SECURITY
-- DEFINER function owned by that role.
--
-- It works only if the owning role cannot bypass row-level security outright. A superuser, or any
-- role with BYPASSRLS, ignores policies no matter what FORCE says. So that is the question this
-- asks, and the answer decides whether the fix is one line per table or a change of ownership
-- first.

\pset format aligned
\pset border 2
\pset null '—'
\pset pager off

\echo ''
\echo '════════ 1. Who owns the functions, and can that role ignore row-level security? ════════'
\echo ''

select r.rolname,
       r.rolsuper   as is_superuser,
       r.rolbypassrls as bypasses_rls,
       count(p.oid) as sarraf_functions_owned
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  join pg_roles r on r.oid = p.proowner
 where p.proname like 'sarraf%' and p.prosecdef
 group by r.rolname, r.rolsuper, r.rolbypassrls
 order by 4 desc;

\echo ''
\echo '════════ 2. The role the application actually connects as ════════'
\echo ''

select rolname, rolsuper as is_superuser, rolbypassrls as bypasses_rls
  from pg_roles
 where rolname in ('authenticated', 'anon', 'service_role', 'postgres', 'supabase_admin',
                   'authenticator', current_user)
 order by rolname;

\echo ''
\echo '════════ 3. Which business tables already force RLS on their owner ════════'
\echo ''

select count(*) filter (where c.relrowsecurity) as rls_enabled,
       count(*) filter (where c.relforcerowsecurity) as rls_forced,
       count(*) as business_tables
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
 where c.relkind = 'r'
   and exists (select 1 from information_schema.columns col
                where col.table_schema = 'public' and col.table_name = c.relname
                  and col.column_name = 'tenant_id');

\echo ''
\echo '════════ 4. The two tables with no restrictive policy — what do they have instead? ════════'
\echo ''

select c.relname as table_name,
       pol.polname,
       case pol.polpermissive when true then 'permissive (ORed — widens)' else 'restrictive (ANDed)' end as kind,
       pg_get_expr(pol.polqual, pol.polrelid) as using_expression
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  left join pg_policy pol on pol.polrelid = c.oid
 where c.relname in ('app_users', 'tenant_rates')
 order by c.relname, pol.polname;

\echo ''
\echo '════════ 5. A sample of what a SECURITY DEFINER function does with a caller-supplied id ════════'
\echo ''

select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
 where p.prosecdef
   and p.proname in ('sarraf_partner_batch_detail', 'sarraf_void_transaction',
                     'sarraf_batch_summary', 'sarraf_receipt_both_sides',
                     'sarraf_settle_debt', 'sarraf_write_off_debt')
 order by p.proname;
