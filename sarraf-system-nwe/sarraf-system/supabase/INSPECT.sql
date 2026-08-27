-- Are the three things actually there, on the live database?
--
-- The gates run against a database built from these same migration files, so they prove the SQL
-- is right. They cannot prove it was applied HERE. This asks the live database directly, and
-- asks it the way the owner would: is there a name on a receipt, can a rejection be followed to
-- what replaced it, and is anything being told to anybody.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. کۆدی تایبەت — every receipt has a name, on both tables ════════'
\echo ''

select 'receipt_documents' as "table",
       count(*)                                   as "rows",
       count(tracking_code)                       as "named",
       count(*) - count(tracking_code)            as "unnamed",
       count(distinct tracking_code)              as "distinct names"
  from public.receipt_documents
union all
select 'receipts',
       count(*), count(tracking_code), count(*) - count(tracking_code), count(distinct tracking_code)
  from public.receipts;

\echo ''
\echo 'The four most recent, and whether the two sides agree on the name:'
\echo ''

select d.tracking_code                                  as "document name",
       coalesce(r.tracking_code, '⟨no receipt row⟩')    as "receipt name",
       case when r.id is null then '—'
            when r.tracking_code is not distinct from d.tracking_code then 'یەک دەگرنەوە ✓'
            else 'ناکۆکن ✗' end                          as "agree",
       d.state::text                                     as "state",
       d.received_at
  from public.receipt_documents d
  left join public.receipts r on r.id = d.id
 order by d.received_at desc
 limit 4;

\echo ''
\echo '════════ 2. دووبارە بارکردنەوە — can a rejection be followed? ════════'
\echo ''

select count(*) filter (where replaced_by_document_id is not null) as "replaced",
       count(*) filter (where replaces_document_id is not null)    as "replacements",
       count(*) filter (where state = 'rejected'
                          and replaced_by_document_id is null)     as "refused, awaiting a new one"
  from public.receipt_documents;

\echo ''
\echo 'And the command that is the only thing allowed to write those links:'
\echo ''

select p.proname                    as "function",
       o.rolname                    as "runs as",
       case when has_function_privilege('authenticated', p.oid, 'execute')
            then 'کڕیار دەیبینێت ✓' else 'داخراوە' end as "reachable"
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  join pg_roles o on o.oid = p.proowner
 where p.proname in ('sarraf_receipt_replace', 'sarraf_my_receipt_intakes_v2')
 order by p.proname;

\echo ''
\echo '════════ 3. ئاگادارکردنەوە — is anything being said, to anybody? ════════'
\echo ''

select kind                                  as "kind",
       count(*)                              as "sent",
       count(*) filter (where read_at is null) as "unread",
       max(created_at)                       as "most recent"
  from public.zeman_notifications
 group by kind
 order by 2 desc;

\echo ''
\echo 'The emitters, and whether realtime carries them:'
\echo ''

select t.tgname                                as "trigger",
       c.relname                               as "on table",
       case when t.tgenabled = 'D' then 'کوژاوەتەوە ✗' else 'کارا ✓' end as "state"
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal
   and t.tgname in ('receipt_documents_speaks', 'receipt_batches_arrives',
                    'receipt_documents_tracking_code', 'receipts_tracking_code')
 order by 1;

select case when exists (
         select 1 from pg_publication_tables
          where pubname = 'supabase_realtime' and schemaname = 'public'
            and tablename = 'zeman_notifications')
       then 'realtime کارا ✓ — ئاگادارکردنەوە خێرا دەگات'
       else 'realtime نییە — ئینباکس بە خۆی نوێ دەبێتەوە' end as "realtime";

\echo ''
\echo '════════ and the receipts that arrived today ════════'
\echo ''

select b.id, b.receipt_stage, b.status, b.n, b.rejected_n, b.created_at
  from public.receipt_batches b
 order by b.created_at desc
 limit 5;
