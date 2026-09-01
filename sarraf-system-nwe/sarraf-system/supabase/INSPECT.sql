-- ── BASELINE ────────────────────────────────────────────────────────────────
--
-- Read-only. Everything the production-readiness brief asks to be recorded before any change:
-- migration ledgers, system health, tenantless rows, storage integrity, function privileges,
-- and the state of the accounts that operate the business.
--
-- Every question has the answer it should give written beside it. Anything else is worth
-- stopping for. Nothing here writes; the workflow opens the transaction read-only.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. دوو دەفتەری مایگرەیشن ════════'
\echo '   پێویستە: «نییە لە سوپابەیس» = 0'
\echo ''

-- Yekseni du jimare ne pîvana rast e.
--
-- ئەم بەشە پێشتر داوای دەکرد هەردوو دەفتەرەکە هەمان ژمارەیان هەبێت، و ئەوە هەڵە بوو.
-- ٢٠٢٦-٠٩-٠١ دوای هاوتەریبکردن ژمارەکان بوونە ٩٧ و ١١٢: دەفتەرەکەی Supabase ١٥ وەشانی
-- تێدایە کە هیچ فایلێکیان لەم ڕیپۆزیتۆرییەدا نییە — بەجێماوی سەردەمی CLI، بە شێوەی
-- ژمارەی جیاوازەوە.
--
-- ئەو ١٥ـە مەترسی نین. مەترسییەکە ئەوە بوو کە وەشانێکی **جێبەجێکراو** لە دەفتەری
-- Supabaseدا نەبێت، چوونکە `supabase db push` ئەو کاتە هەوڵی دووبارە جێبەجێکردنی دەدات
-- بەسەر داتابەیسێکدا کە پێشتر هەیەتی. پێچەوانەکەی — تۆمارێک بێ فایل — تەنها نادیدە
-- دەگیردرێت.
--
-- بۆیە پرسیارەکە ئەمەیە، نەک یەکسانیی دوو ژمارە.
select
  (select count(*) from public.schema_migrations) as "zeman ledger",
  (select count(*) from supabase_migrations.schema_migrations) as "supabase ledger",
  (select count(*) from public.schema_migrations m
     where not exists (select 1 from supabase_migrations.schema_migrations s
                        where s.version = m.version)) as "نییە لە سوپابەیس",
  (select count(*) from supabase_migrations.schema_migrations s
     where not exists (select 1 from public.schema_migrations m
                        where m.version = s.version)) as "بێ فایل، بێ زیان",
  (select max(version) from public.schema_migrations) as "latest applied";

\echo ''
\echo '   ئەو وەشانانەی لە دەفتەری Supabaseدان و هیچ فایلێکیان نییە:'
\echo ''

select s.version as "version with no file"
  from supabase_migrations.schema_migrations s
 where not exists (select 1 from public.schema_migrations m where m.version = s.version)
 order by 1
 limit 40;

\echo ''
\echo '════════ 2. تەندروستی سیستەم ════════'
\echo '   پێویستە: هەموو FAILـەکان سفر'
\echo ''

-- sarraf_system_health() داوای ئەکتەرێکی ئەدمین دەکات، و ئەم پەیوەندییە وەک postgresـە بێ
-- هیچ auth.uid()ـێک — بۆیە «not authorized» دەداتەوە. هەمان ڕاستییەکان لە هەمان ڤیوەکانەوە
-- دەخوێندرێنەوە کە خۆی دەیانخوێنێتەوە.
select 'مامەڵەی بێ دەفتەر' as "check",
       (select count(*) from public.txs t where not t.deleted
          and not exists (select 1 from public.ledger l where l.tx_id = t.id)) as "count", 'FAIL' as "severity"
union all
select 'دەفتەر بۆ مامەڵەیەکی نەمان',
       (select count(*) from public.ledger l where l.tx_id is not null
          and not exists (select 1 from public.txs t where t.id = l.tx_id)), 'FAIL'
union all
select 'یاساکانی A/B/C',
       (select count(*) from public.v_transaction_business_flow_integrity where issue is not null), 'FAIL'
union all
select 'بەستنی دەفتەر و ژورناڵ',
       (select count(*) from public.v_ledger_journal_gaps), 'FAIL'
union all
select 'سەرچاوەی ژورناڵ',
       (select count(*) from public.v_journal_orphans), 'FAIL'
union all
select 'ژورناڵی ڕەشنووس، چاوەڕوانی نرخ',
       (select count(*) from public.v_journal_drafts), 'WARN'
union all
select 'مامەڵەی چاوەڕوانی بێ بەستن',
       (select count(*) from public.v_pending_transaction_gaps), 'WARN'
order by 3, 2 desc;

\echo ''
\echo '════════ 2.b باڵانسی تاقیکردنەوە ════════'
\echo '   پێویستە: جیاوازی = 0'
\echo ''

select round(sum(case when l.side = 'debit' then l.base_amount else 0 end), 6) as "debit",
       round(sum(case when l.side = 'credit' then l.base_amount else 0 end), 6) as "credit",
       round(sum(case when l.side = 'debit' then l.base_amount else -l.base_amount end), 6) as "difference"
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
 where e.status = 'posted';

\echo ''
\echo '════════ 2.c ئەو مامەڵانەی ژورناڵ حسابیان ناکات — بە ناو ════════'
\echo '   پێویستە: بەتاڵ. گەر نا، ئەمانە بە ناو دیارن و دەکرێت چارەسەر بکرێن'
\echo ''

select transaction_id as "transaction", code, date, transaction_status as "tx status",
       journal_status as "journal", gap as "why"
  from public.v_ledger_journal_gaps
 order by date desc, 1
 limit 50;

\echo ''
\echo '════════ 2.d ژورناڵی ڕەشنووس — چاوەڕوانی چین؟ ════════'
\echo '   ڕەشنووس ناچێتە باڵانسەوە. هەر ڕەشنووسێک پارەیەکە کە کتێبەکان نایبینن'
\echo ''

select e.id as "entry", e.source_type as "source", e.transaction_id as "transaction",
       e.business_date as "date", e.reason as "why",
       (select string_agg(distinct l.currency, ', ')
          from public.journal_lines l where l.entry_id = e.id) as "currencies"
  from public.v_journal_drafts e
 order by e.business_date desc
 limit 50;

\echo ''
\echo '════════ 3. ڕیزەکانی بێ بازرگانی (tenant_id = null) ════════'
\echo '   پێویستە: هەموویان سفر — یان بە ڕوونی خاوەنی پلاتفۆرم بن'
\echo ''

select t as "table", n as "tenantless"
  from (
    select 'audit' as t, count(*) as n from public.audit where tenant_id is null
    union all select 'notes', count(*) from public.notes where tenant_id is null
    union all select 'system_event_log', count(*) from public.system_event_log where tenant_id is null
    union all select 'receipt_extractions', count(*) from public.receipt_extractions where tenant_id is null
    union all select 'receipt_ocr_attempts', count(*) from public.receipt_ocr_attempts where tenant_id is null
    union all select 'receipt_state_transitions', count(*) from public.receipt_state_transitions where tenant_id is null
    union all select 'txs', count(*) from public.txs where tenant_id is null
    union all select 'ledger', count(*) from public.ledger where tenant_id is null
    union all select 'journal_entries', count(*) from public.journal_entries where tenant_id is null
    union all select 'receipts', count(*) from public.receipts where tenant_id is null
    union all select 'receipt_batches', count(*) from public.receipt_batches where tenant_id is null
    union all select 'zeman_notifications', count(*) from public.zeman_notifications where tenant_id is null
  ) x
 order by n desc, t;

\echo ''
\echo '════════ 4. تازەترین ڕیزی بێ بازرگانی — هێشتا درووست دەبن؟ ════════'
\echo '   پێویستە: هیچ شتێکی ئەمڕۆ'
\echo ''

select t as "table", latest as "newest tenantless"
  from (
    select 'audit' as t, max(date) as latest from public.audit where tenant_id is null
    union all select 'system_event_log', max(created_at) from public.system_event_log where tenant_id is null
    union all select 'receipt_state_transitions', max(created_at) from public.receipt_state_transitions where tenant_id is null
    union all select 'receipt_extractions', max(created_at) from public.receipt_extractions where tenant_id is null
    union all select 'receipt_ocr_attempts', max(created_at) from public.receipt_ocr_attempts where tenant_id is null
  ) x where latest is not null order by latest desc;

\echo ''
\echo '════════ ٤.b چاکسازی پێش ئەنجامدان — چی دەگۆڕێت ════════'
\echo '   ئەمە هیچ ناگۆڕێت. تەنها دەڵێت 202608310002 چەند ڕیزی دەگۆڕی'
\echo ''

select 'receipt_state_transitions' as "table",
       count(*) filter (where s.tenant_id is null) as "no business",
       count(*) filter (where s.tenant_id is null and d.tenant_id is not null) as "would be repaired",
       count(*) filter (where s.tenant_id is null and d.tenant_id is null) as "would stay",
       'دەگۆڕدرێت' as "what happens"
  from public.receipt_state_transitions s
  left join public.receipt_documents d on d.id = s.document_id
union all
select 'notes',
       count(*) filter (where n.tenant_id is null),
       count(*) filter (where n.tenant_id is null and coalesce(
         (select u.tenant_id from public.app_users u where u.id = n.user_id),
         (select b.tenant_id from public.receipt_batches b where b.id = n.ref_id),
         (select t.tenant_id from public.txs t where t.id = n.ref_id)) is not null),
       count(*) filter (where n.tenant_id is null and coalesce(
         (select u.tenant_id from public.app_users u where u.id = n.user_id),
         (select b.tenant_id from public.receipt_batches b where b.id = n.ref_id),
         (select t.tenant_id from public.txs t where t.id = n.ref_id)) is null),
       'دەگۆڕدرێت'
  from public.notes n
union all
select 'audit', count(*) filter (where tenant_id is null), 0, count(*) filter (where tenant_id is null),
       'دەست لێ نادرێت — append-only' from public.audit
union all
select 'receipt_extractions', count(*) filter (where tenant_id is null), 0, count(*) filter (where tenant_id is null),
       'دەست لێ نادرێت — append-only' from public.receipt_extractions
union all
select 'receipt_ocr_attempts', count(*) filter (where tenant_id is null), 0, count(*) filter (where tenant_id is null),
       'دەست لێ نادرێت — append-only' from public.receipt_ocr_attempts
union all
select 'system_event_log', count(*) filter (where tenant_id is null), 0, count(*) filter (where tenant_id is null),
       'دەست لێ نادرێت — append-only' from public.system_event_log
 order by 2 desc, 1;

\echo ''
\echo '════════ 5. یەکپارچەیی ستۆرەج ════════'
\echo '   پێویستە: هیچ فایلێکی بێ تۆمار، هیچ تۆمارێکی بێ فایل'
\echo ''

select
  (select count(*) from storage.objects where bucket_id = 'receipts') as "objects",
  (select count(*) from public.receipt_documents) as "document rows",
  (select count(*) from storage.objects o where o.bucket_id = 'receipts'
     and not exists (select 1 from public.receipt_documents d where d.storage_path = o.name)) as "unreferenced",
  (select count(*) from public.receipt_documents d
     where d.storage_path is not null
       and not exists (select 1 from storage.objects o where o.bucket_id='receipts' and o.name = d.storage_path)) as "missing file",
  (select (b.public)::text from storage.buckets b where b.id = 'receipts') as "bucket public";

\echo ''
\echo '════════ 5.b تۆمارێک کە فایلەکەی نەماوە ════════'
\echo '   پێویستە: بەتاڵ. هەر ڕیزێک لێرە فیشێکە کە وێنەکەی لەدەست چووە'
\echo ''

select d.id as "document", d.batch_id as "batch", d.state as "state", d.storage_path as "path", d.received_at as "when"
  from public.receipt_documents d
 where d.storage_path is not null
   and not exists (select 1 from storage.objects o where o.bucket_id = 'receipts' and o.name = d.storage_path)
 order by d.received_at desc
 limit 50;

\echo ''
\echo '════════ 5.c فایلی بێ تۆمار — بەپێی مانگ ════════'
\echo '   ئەمانە جێماوی بارکردنی ناتەواون. پێش سڕینەوە پێویستە پاڵپشتێکی سەلمێندراو هەبێت'
\echo ''

select to_char(o.created_at, 'YYYY-MM') as "month", count(*) as "unreferenced files",
       pg_size_pretty(coalesce(sum((o.metadata->>'size')::bigint), 0)) as "size"
  from storage.objects o
 where o.bucket_id = 'receipts'
   and not exists (select 1 from public.receipt_documents d where d.storage_path = o.name)
 group by 1 order by 1 desc;

\echo ''
\echo '════════ ٥.d فیشەکان: ئایا زیادکردنی ئەم دوو مەرجە سەلامەتە؟ ════════'
\echo '   پێویستە: هەردووکیان سفر. گەر نا، مایگرەیشنەکە دەشکێت'
\echo ''

select 'دۆکیومێنتی کۆمەڵەیەکی نەمان' as "what",
       (select count(*) from public.receipt_documents d
         where d.batch_id is not null
           and not exists (select 1 from public.receipt_batches b where b.id = d.batch_id)) as "how many",
       'foreign key بۆ batch_id' as "the constraint that would be added"
union all
select 'دوو دۆکیومێنت، یەک فایل',
       (select coalesce(sum(n - 1), 0) from (
          select count(*) as n from public.receipt_documents
           where storage_path is not null group by storage_path having count(*) > 1) x),
       'unique index بۆ storage_path'
union all
select 'یەک وێنە، دوو جار ژماردراو',
       (select coalesce(sum(n - 1), 0) from (
          select count(*) as n from public.receipt_documents
           where image_sha256 is not null and counted group by image_sha256 having count(*) > 1) x),
       'rd_hash_uq — پێشتر هەیە'
 order by 2 desc, 1;

\echo ''
\echo '════════ 6. فەرمانەکان: کێ بانگیان دەکات ════════'
\echo '   پێویستە: anon = 0 لە هەموو فەرمانێکی SECURITY DEFINERدا'
\echo ''

select
  count(*) filter (where p.prosecdef) as "definer total",
  count(*) filter (where p.prosecdef and has_function_privilege('anon', p.oid, 'execute')) as "anon may call",
  count(*) filter (where p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')) as "authenticated may call",
  count(*) filter (where p.prosecdef and pg_get_userbyid(p.proowner) <> 'sarraf_definer') as "not owned by definer",
  count(*) filter (where p.prosecdef and p.proconfig is null) as "no search_path"
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.proname like 'sarraf%';

\echo ''
\echo '════════ 6.b ئەوانەی anon بانگیان دەکات — بە ناو ════════'
\echo '   پێویستە: بەتاڵ، یان لیستێکی کورتی مەبەستدار'
\echo ''

select p.proname as "function", pg_get_userbyid(p.proowner) as "owner"
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.prosecdef
   and has_function_privilege('anon', p.oid, 'execute')
 order by 1;

\echo ''
\echo '════════ ٦.c ڕۆڵەکان: کێ لە RLS تێدەپەڕێت ════════'
\echo '   ئەمە بڕیار دەدات ئایا FORCE زیادکردن بۆ ئەو دوو خشتەیە سەلامەتە'
\echo ''

select r.rolname as "role", r.rolsuper as "superuser", r.rolbypassrls as "bypasses RLS",
       r.rolcanlogin as "can sign in"
  from pg_roles r
 where r.rolname in ('postgres', 'authenticated', 'anon', 'service_role',
                     'sarraf_definer', 'supabase_admin', current_user)
 order by 1;

\echo ''
\echo '════════ 7. RLS: کام خشتە پارێزراو نییە ════════'
\echo '   پێویستە: بەتاڵ'
\echo ''

select c.relname as "table",
       case when not c.relrowsecurity then 'RLS ناکارایە'
            when not c.relforcerowsecurity then 'FORCE نییە'
            else 'بێ پۆلیسی سنووردارکەر' end as "why"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and exists (select 1 from information_schema.columns col
                where col.table_schema='public' and col.table_name=c.relname and col.column_name='tenant_id')
   and (not c.relrowsecurity or not c.relforcerowsecurity
        or not exists (select 1 from pg_policies pp where pp.tablename=c.relname and pp.permissive='RESTRICTIVE'))
 order by 1;

\echo ''
\echo '════════ 8. ئەکاونتەکان و MFA ════════'
\echo ''

-- auth.mfa_factors is Supabase's own table. A database that does not have it — a disposable
-- fixture, a plain PostgreSQL — is not a database with no MFA; it is one where the question
-- cannot be asked. Those are different answers and this says which one it is giving.
select (to_regclass('auth.mfa_factors') is not null) as mfa_known \gset

\if :mfa_known
-- The app sends every admin and every office through MfaGate, which enrols a factor if there is
-- none and challenges it if there is — so for those two ranks a verified factor is not optional.
-- This is where that claim is either true on the live database or is not.
select coalesce(u.admin_level, u.role) as "rank", u.tenant_id as "business",
       count(*) as "how many",
       count(*) filter (where exists (
         select 1 from auth.users a where a.id = u.auth_id)) as "has a login",
       count(*) filter (where exists (
         select 1 from auth.mfa_factors f
          where f.user_id = u.auth_id and f.status = 'verified')) as "has MFA",
       case when coalesce(u.admin_level, u.role) in ('manager','owner','operator','admin','office')
            then 'MFA پێویستە' else 'ئارەزوومەندانە' end as "is MFA required"
  from public.app_users u where not u.deleted
 group by 1, 2 order by 1, 2;

\echo ''
\echo '════════ ٨.b ئەکاونتێکی پارێزراو بێ MFA ════════'
\echo '   پێویستە: بەتاڵ — ئەدمین و نووسینگە ناتوانن بێ فاکتەرێک بچنە ژوورەوە'
\echo ''

select u.id as "account", u.name, coalesce(u.admin_level, u.role) as "rank",
       u.tenant_id as "business"
  from public.app_users u
 where not u.deleted
   and coalesce(u.admin_level, u.role) in ('manager','owner','operator','admin','office')
   and u.auth_id is not null
   and not exists (select 1 from auth.mfa_factors f
                    where f.user_id = u.auth_id and f.status = 'verified')
 order by 3, 1;
\else
\echo '   auth.mfa_factors لەم داتابەیسەدا نییە — ئەم پرسیارە نەکرا (ئەمە وەڵامی «هیچ» نییە)'
select coalesce(u.admin_level, u.role) as "rank", u.tenant_id as "business",
       count(*) as "how many",
       count(*) filter (where u.auth_id is not null) as "has a login"
  from public.app_users u where not u.deleted
 group by 1, 2 order by 1, 2;
\endif

\echo ''
\echo '════════ 9. ژمارەکانی کار ════════'
\echo ''

select
  (select count(*) from public.tenants) as "businesses",
  (select count(*) from public.txs where not deleted) as "transactions",
  (select count(*) from public.ledger) as "ledger rows",
  (select count(*) from public.journal_entries) as "journal entries",
  (select count(*) from public.journal_entries where status <> 'posted') as "not posted",
  (select count(*) from public.receipts) as "receipts",
  (select count(*) from public.receipt_batches) as "batches";

\echo ''
\echo '════════ تەواو ════════'
\echo ''
