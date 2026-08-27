-- Is the live database ready for the three performance migrations, and did they land?
--
-- 202608280019 adds nine indexes. 202608280020 rewrites 62 tenant policies. 202608280021
-- rewrites the eight read policies on the tables the app reads whole.
--
-- 202608280020 does its work by reading pg_policies, and it REFUSES any policy that is not
-- exactly the shape it was written for rather than reshaping it. That is the right behaviour —
-- but it means the migration can stop with an error on a database whose policies do not match
-- the migration files. This one was migrated by hand for a fortnight before there was a
-- workflow, so that is worth knowing BEFORE running migrate.yml rather than from its log.
--
-- Run this, read section 3, then run migrate.yml with confirm: APPLY.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. کام مایگرەیشن جێبەجێ کراوە؟ ════════'
\echo ''

select v as "version",
       case when exists (select 1 from public.schema_migrations m where m.version = v)
            then 'جێبەجێ کراوە ✓' else '— چاوەڕوانە' end as "state",
       case v when '202608280019' then 'ئیندێکسەکانی کردنەوەی بەرنامە'
              when '202608280020' then 'پرسیاری تینانت یەک جار'
              when '202608280021' then 'پۆلیسییەکانی خوێندنەوە'
       end as "what"
  from (values ('202608280019'),('202608280020'),('202608280021')) t(v);

\echo ''
\echo '════════ 2. ئایا ئیندێکسەکان لەوێن؟ ════════'
\echo ''

select n as "index",
       case when exists (select 1 from pg_indexes i
                          where i.schemaname = 'public' and i.indexname = n)
            then 'هەیە ✓' else 'نییە — بەرنامەکە هێشتا هەموو خشتەکە ڕیز دەکات' end as "state"
  from (values
    ('ledger_open_order_idx'), ('txs_open_order_idx'),
    ('account_ledger_open_order_idx'), ('rate_history_open_order_idx'),
    ('app_users_open_order_idx'), ('audit_recent_idx'),
    ('approval_requests_recent_idx'), ('approval_events_recent_idx'),
    ('tx_versions_recent_idx')) t(n);

\echo ''
\echo '════════ 3. پێش جێبەجێکردن — ئایا پۆلیسییەکان ئەو شێوەیەن؟ ════════'
\echo ''
\echo 'هەر ڕیزێک لێرەدا کە «REFUSES» بێت، 202608280020 لەسەری دەوەستێت.'
\echo 'ئەگەر هیچ ڕیزێک نەبوو، مایگرەیشنەکە بەبێ کێشە جێبەجێ دەبێت.'
\echo ''

select tablename as "table", policyname as "policy",
       permissive as "kind", cmd, roles::text as "roles",
       coalesce(qual, '⟨none⟩') as "using"
  from pg_policies
 where schemaname = 'public'
   and (coalesce(qual, '') like '%sarraf_tenant_visible%'
     or coalesce(with_check, '') like '%sarraf_tenant_visible%')
   and not (
        regexp_replace(coalesce(qual, ''), '(public\.)|\s', '', 'g')
          in ('sarraf_tenant_visible(tenant_id)', '(sarraf_tenant_visible(tenant_id))')
    and regexp_replace(coalesce(with_check, ''), '(public\.)|\s', '', 'g')
          in ('sarraf_tenant_visible(tenant_id)', '(sarraf_tenant_visible(tenant_id))')
    and cmd = 'ALL'
    and roles::text = '{authenticated}')
 order by tablename, policyname;

\echo ''
\echo '  ── و ئەوانەی ئامادەن بۆ نووسینەوە ──'
\echo ''

select count(*) filter (where coalesce(qual,'') like '%sarraf_tenant_visible%')
         as "هێشتا بۆ هەر ڕیزێک دەپرسن",
       count(*) filter (where coalesce(qual,'') like '%SELECT sarraf_tenant%')
         as "یەک جار دەپرسن ✓"
  from pg_policies
 where schemaname = 'public'
   and (coalesce(qual,'') like '%sarraf_tenant%' or coalesce(qual,'') like '%sarraf_sees_all%');

\echo ''
\echo '════════ 4. پۆلیسییەکانی خوێندنەوە لەسەر ئەو خشتانەی بە تەواوی دەخوێندرێنەوە ════════'
\echo ''

select tablename as "table", policyname as "policy",
       case when coalesce(qual,'') ~ '(^|[^.[:alnum:]_])(is_admin|my_app_id|my_role)\(\)'
             and coalesce(qual,'') !~ 'SELECT (is_admin|my_app_id|my_role)'
            then 'بۆ هەر ڕیزێک دەپرسێت'
            else 'یەک جار ✓' end as "asked",
       coalesce(qual, '⟨none⟩') as "using"
  from pg_policies
 where schemaname = 'public' and permissive = 'PERMISSIVE'
   and tablename in ('ledger','txs','account_ledger','rate_history','app_users','audit')
   and coalesce(qual, '') <> 'true'
 order by tablename, policyname;

\echo ''
\echo '════════ 5. ئەم بزنسە چەندە گەورەیە؟ ════════'
\echo ''
\echo 'ئەمە دەڵێت چەند خێرا CREATE INDEX تەواو دەبێت، و چەند قازانج دەکرێت.'
\echo ''

select c.relname as "table",
       to_char(c.reltuples::bigint, 'FM999,999,999') as "rows (estimated)",
       pg_size_pretty(pg_total_relation_size(c.oid)) as "size",
       to_char(ceil(greatest(c.reltuples, 0) / 1000.0), 'FM999,999') as "pages the app fetches"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('ledger','txs','account_ledger','rate_history','app_users',
                     'audit','approval_events','tx_versions','receipts','receipt_documents')
   and c.relkind = 'r'
 order by c.reltuples desc;

\echo ''
\echo '════════ 6. و ئایا فیشەکان هێشتا ناویان هەیە ════════'
\echo ''

select 'receipt_documents' as "table", count(*) as "rows",
       count(tracking_code) as "named", count(*) - count(tracking_code) as "unnamed"
  from public.receipt_documents
union all
select 'receipts', count(*), count(tracking_code), count(*) - count(tracking_code)
  from public.receipts;
