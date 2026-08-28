-- Did the office-payment rework land, and does the live database now post the entry the gates
-- describe rather than the one it posted for weeks?
--
--   202608280025  one press, and the office is owed
--
-- Every question below has a right answer written next to it. Anything else is worth stopping for.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. مایگرەیشنەکە جێبەجێ کراوە؟ ════════'
\echo ''

select v as "version",
       case when exists (select 1 from public.schema_migrations m where m.version = v)
            then 'جێبەجێ کراوە ✓' else '— چاوەڕوانە' end as "state",
       case v when '202608280022' then 'تۆمارکردنی شکست'
              when '202608280023' then 'یەک کۆمەڵە پۆلیسی لەسەر txs'
              when '202608280024' then 'هاوبەش لە شاشەی کڕین'
              when '202608280025' then 'یەک لێدان — نووسینگە قەرزار دەبێت'
       end as "what"
  from (values ('202608280022'),('202608280023'),('202608280024'),('202608280025')) t(v);

\echo ''
\echo '════════ 2. سێ فەرمانە نوێیەکە لەوێن؟ ════════'
\echo '   پێویستە هەر سێکیان: هەیە ✓  و  sarraf_definer'
\echo ''

select v as "command",
       case when p.oid is null then '— نییە' else 'هەیە ✓' end as "state",
       coalesce(pg_get_userbyid(p.proowner), '—') as "owner",
       case when p.prosecdef then 'security definer' else 'invoker' end as "kind"
  from (values ('sarraf_office_payment_paid'),
               ('sarraf_office_settle'),
               ('sarraf_office_board'),
               ('sarraf_office_payment_post'),
               ('sarraf_office_paid_since')) t(v)
  left join pg_proc p on p.proname = v
   and p.pronamespace = 'public'::regnamespace;

\echo ''
\echo '════════ 3. لێدانی نووسینگە قەرزەکە دەگوێزێتەوە، پارە ناجوڵێت؟ ════════'
\echo '   پێویستە: acc-2200 هەیە ✓   و   acc-1000 نییە ✓'
\echo ''

with body as (
  select pg_get_functiondef(p.oid) as src
    from pg_proc p
   where p.proname = 'sarraf_office_payment_post'
     and p.pronamespace = 'public'::regnamespace
   limit 1
)
select case when src is null then '— فەرمانەکە نییە'
            when src like '%''acc-2300'', ''acc-2200''%' then 'قەرزەکە دەچێتە سەر نووسینگە ✓'
            else '⚠ لقی مامەڵە ئەو دوو حسابە ناناسێت' end as "acc-2200",
       case when src is null then '—'
            when src like '%acc-1000%' then '⚠ هێشتا قاسەی سەرەکی دەبات'
            else 'قاسە دەستی لێ نادرێت ✓' end as "acc-1000",
       case when src is null then '—'
            when src like '%transaction_payment_events%' then '⚠ هێشتا ڕووداوی پارەدان دەنووسێت'
            else 'ڕووداوی پارەدان نانووسرێت ✓' end as "cash trigger",
       case when src is null then '—'
            when src like '%account_ledger%' then 'حسابی نووسینگە دەنووسرێت ✓'
            else '⚠ حسابی نووسینگە نانووسرێت' end as "office account"
  from body;

\echo ''
\echo '════════ 4. حسابدانەوە: acc-2200 دەبڕدرێتەوە و قاسە کەم دەبێت؟ ════════'
\echo '   پێویستە هەر چوارکیان ✓'
\echo ''

with body as (
  select pg_get_functiondef(p.oid) as src
    from pg_proc p
   where p.proname = 'sarraf_office_settle' and p.pronamespace = 'public'::regnamespace
   limit 1
)
select case when src like '%''acc-2200'', ''acc-1000''%' then 'دەفتەر ✓' else '⚠ دەفتەر' end as "journal",
       case when src like '%account_ledger%' then 'حساب ✓' else '⚠ حساب' end as "account",
       case when src like '%public.ledger%' then 'قاسە ✓' else '⚠ قاسە' end as "safe",
       case when src like '%that is more than this office is owed%' then 'سنوور ✓' else '⚠ سنوور' end as "guard"
  from body;

\echo ''
\echo '════════ 5. voucher_kind ناوی نوێی هەیە؟ ════════'
\echo '   پێویستە: office_settlement هەیە ✓'
\echo ''

select case when exists (
         select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'voucher_kind' and e.enumlabel = 'office_settlement')
       then 'office_settlement هەیە ✓' else '— نییە' end as "voucher kind";

\echo ''
\echo '════════ 6. ئەرکەکانی نووسینگە لە ئێستادا ════════'
\echo ''

select status::text as "state", count(*) as "how many",
       coalesce(string_agg(distinct currency, ', '), '—') as "currencies"
  from public.office_payment_assignments
 group by status
 order by 2 desc;

\echo ''
\echo '════════ 7. ئێستا ZEMAN چەندی قەرزارە بۆ نووسینگەکان؟ ════════'
\echo '   ئەمە ئەو ژمارەیەیە کە دوگمەی «حسابی نووسینگە دەدەمەوە» سفری دەکاتەوە'
\echo ''

select u.name as "office", c.code as "currency", sum(a.amount) as "owed"
  from public.account_ledger a
  join public.app_users u on u.id = a.user_id and u.role = 'office'
  join public.currencies c on c.id = a.cur_id
 where a.kind = 'cash'
 group by u.name, c.code
having sum(a.amount) <> 0
 order by 1, 2;

\echo ''
\echo '════════ تەواو ════════'
\echo ''
