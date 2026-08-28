-- Did the last three migrations land, and is the live database now the one the gates describe?
--
--   202608280022  faults reach somebody who can fix them
--   202608280023  one read policy set on txs, matching the migration files
--   202608280024  one press: name the holder where the purchase is made
--
-- Every question below has a right answer written next to it. Anything else is worth stopping for.

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
       case v when '202608280019' then 'ئیندێکسەکان'
              when '202608280020' then 'تینانت یەک جار'
              when '202608280021' then 'پۆلیسییەکانی خوێندنەوە'
              when '202608280022' then 'تۆمارکردنی شکست'
              when '202608280023' then 'یەک کۆمەڵە پۆلیسی لەسەر txs'
              when '202608280024' then 'یەک لێدان — هاوبەش لە شاشەی کڕین'
       end as "what"
  from (values ('202608280019'),('202608280020'),('202608280021'),
               ('202608280022'),('202608280023'),('202608280024')) t(v);

\echo ''
\echo '════════ 2. یەک لێدان — ئایا فەرمانەکە هاوبەشی فۆرمەکە دەناسێتەوە؟ ════════'
\echo ''
\echo 'هەردووکیان دەبێت «هەیە ✓» بن. ئەگەر custody بانگ نەکرێت، بەڵگەکە هەمان بەڵگە نییە.'
\echo ''

select 'هاوبەشی فۆرمەکە وەردەگیرێت' as "what",
       case when pg_get_functiondef(p.oid) like '%v_named:=nullif(btrim(p_tx->>''partner_id'')%'
            then 'هەیە ✓' else 'نییە — هەڵبژاردنەکە هێشتا دەسڕدرێتەوە' end as "state"
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'sarraf_convert_receipt_batch_to_transaction'
union all
select 'custody بە فەرمانی خۆی تۆمار دەکرێت',
       case when pg_get_functiondef(p.oid) like '%sarraf_assign_receipt_custody%'
            then 'هەیە ✓' else 'نییە — بەسەر فەرمانی custodyدا تێدەپەڕێت' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'sarraf_convert_receipt_batch_to_transaction';

\echo ''
\echo '════════ 3. پۆلیسییەکانی خوێندنەوەی txs — دەبێت سێ بن ════════'
\echo ''

select policyname as "policy",
       case when coalesce(qual,'') ~ '(^|[^.[:alnum:]_])(is_admin|my_app_id|my_role)\(\)'
             and coalesce(qual,'') !~ 'SELECT (is_admin|my_app_id|my_role)'
            then 'بۆ هەر ڕیزێک' else 'یەک جار ✓' end as "asked"
  from pg_policies
 where schemaname = 'public' and tablename = 'txs' and permissive = 'PERMISSIVE'
   and coalesce(qual,'') <> 'true'
 order by policyname;

\echo ''
\echo '  ── txs_authorized_read دەبێت نەمابێت ──'
\echo ''

select case when exists (select 1 from pg_policies
                          where schemaname='public' and tablename='txs'
                            and policyname='txs_authorized_read')
            then 'هێشتا لەوێیە — 202608280023 جێبەجێ نەکراوە'
            else 'لابراوە ✓ — ژیان لەگەڵ فایلەکاندا یەک دەگرێتەوە' end as "state";

\echo ''
\echo '════════ 4. تۆمارکردنی شکست — ئایا خشتەکە پارێزراوە؟ ════════'
\echo ''

select 'خشتەکە هەیە' as "what",
       case when to_regclass('public.zeman_faults') is null then 'نییە' else 'هەیە ✓' end as "state"
union all
select 'RLS زۆرکراوە (force)',
       coalesce((select case when relforcerowsecurity then 'بەڵێ ✓' else 'نەخێر — فەنکشنێکی دیفاینەر هەموو بزنسێک دەبینێت' end
                   from pg_class where oid = to_regclass('public.zeman_faults')), '⟨خشتەکە نییە⟩')
union all
select 'ئیندێکسی تایبەت (لووپی تێکشکان)',
       case when exists (select 1 from pg_indexes where schemaname='public'
                          and indexname='zeman_faults_one_per_day')
            then 'هەیە ✓' else 'نییە — تێکشکان دەتوانێت خشتەکە پڕ بکات' end
union all
select 'پۆلیسی سنووردارکەری تینانت',
       case when exists (select 1 from pg_policies where schemaname='public'
                          and tablename='zeman_faults' and permissive='RESTRICTIVE')
            then 'هەیە ✓' else 'نییە' end;

\echo ''
\echo '  ── و ئایا شتێک تۆمار کراوە؟ ──'
\echo ''

select coalesce(kind,'⟨هیچ⟩') as "kind", coalesce(code,'') as "code",
       coalesce(screen,'') as "screen", sum(seen) as "seen", max(last_at) as "last"
  from public.zeman_faults
 group by kind, code, screen
 order by max(last_at) desc
 limit 10;

\echo ''
\echo '════════ 5. فیشەکان و مامەڵەکان ════════'
\echo ''

select 'فیشی گەیشتوو' as "what", count(*)::text as "n" from public.receipt_intake_items
union all
select 'لەوانەی گۆڕدراون بۆ مامەڵە',
       count(*) filter (where transaction_id is not null)::text from public.receipt_intake_items
union all
select 'فیش کە لای هاوبەشێک دانراون',
       count(*) filter (where partner_id is not null)::text from public.receipt_intake_items
union all
select 'ڕیزی custody', count(*)::text from public.receipt_custody
union all
select 'مامەڵە', count(*)::text from public.txs where not deleted;
