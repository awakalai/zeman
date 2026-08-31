# بنەڕەتی زیندوو — ٣١ی ئابی ٢٠٢٦

ئەم پەڕەیە دەرئەنجامی `supabase/INSPECT.sql`ـە بەسەر داتابەیسە زیندووەکەدا
(`inspect.yml`، خوێندنەوەی ڕەق، تراکنزاکشنێکی `read only`). هیچ گۆڕانکارییەک
پێش ئەم پشکنینە نەکرا. هەموو کارێکی دواتر بەرامبەر بەم ژمارانە پێوانە دەکرێت.

Run: https://github.com/awakalai/zeman/actions/runs/33449848902 · commit `93679b8`

## ١. دوو دەفتەری مایگرەیشن

| zeman ledger | supabase ledger | latest applied |
|---:|---:|---|
| 90 | 46 | `202608280026` |

`public.schema_migrations` (٩٠) لەگەڵ ژمارەی فایلەکانی `supabase/migrations` یەک دەگرێتەوە —
هەموویان جێبەجێ کراون. بەڵام دەفتەرەکەی خودی Supabase (`supabase_migrations.schema_migrations`)
تەنها ٤٦ی تێدایە، لە سەردەمی CLIـەوە ماوەتەوە. **مەترسی:** هەر کەسێک `supabase db push`
بکات، Supabase وا دەزانێت ٤٤ مایگرەیشن جێبەجێ نەکراون و هەوڵی دووبارە جێبەجێکردنیان دەدات.
→ هەنگاوی ٩ (سەلامەتی مایگرەیشن).

## ٢. تەندروستی سیستەم

| پشکنین | ژمارە | چۆنیەتی |
|---|---:|---|
| بەستنی دەفتەر و ژورناڵ (`v_ledger_journal_gaps`) | **2** | FAIL |
| دەفتەر بۆ مامەڵەیەکی نەمان | 0 | FAIL |
| یاساکانی A/B/C (`v_transaction_business_flow_integrity`) | 0 | FAIL |
| مامەڵەی بێ دەفتەر | 0 | FAIL |
| سەرچاوەی ژورناڵ (`v_journal_orphans`) | 0 | FAIL |
| ژورناڵی ڕەشنووس، چاوەڕوانی نرخ (`v_journal_drafts`) | **2** | WARN |
| مامەڵەی چاوەڕوانی بێ بەستن | 0 | WARN |

## ٢.b باڵانسی تاقیکردنەوە (ژورناڵی پۆستکراو)

| debit | credit | difference |
|---:|---:|---:|
| 157,683.052754 | 157,683.052754 | **0.000000** |

دووجاری تەواو باڵانسە. ئەمە کۆکردنەوەیەکی `numeric(38,10)`ی داتابەیسەیە، نەک JavaScript.

## ٣. ڕیزەکانی بێ بازرگانی (`tenant_id is null`)

| خشتە | ژمارە |
|---|---:|
| `receipt_state_transitions` | 487 |
| `receipt_ocr_attempts` | 101 |
| `receipt_extractions` | 79 |
| `system_event_log` | 21 |
| `notes` | 19 |
| `audit` | 11 |
| `journal_entries`, `ledger`, `receipt_batches`, `receipts`, `txs`, `zeman_notifications` | 0 |

هەموو خشتە داراییەکان و خشتەی فیشەکان پاکن. ئەوانەی ماون تۆماری ڕووداو و شوێنپێن.

## ٤. تازەترین ڕیزی بێ بازرگانی

| خشتە | تازەترین |
|---|---|
| `receipt_state_transitions` | 2026-08-29 22:47:15.831684+00 |
| `receipt_extractions` | 2026-08-29 22:47:15.831684+00 |
| `receipt_ocr_attempts` | 2026-08-29 22:47:15.831684+00 |
| `audit` | 2026-08-28 21:20:13.25+00 |
| `system_event_log` | 2026-08-28 21:20:13.124878+00 |

هەرسێ خشتەی فیش هەمان ستەمپی وردیان هەیە — واتە لە مایگرەیشنێکەوە هاتوون
(کاتێک ستوونی `tenant_id` زیادکرا)، نەک لە کارکردنی ڕۆژانەوە.

## ٥. یەکپارچەیی ستۆرەج

| objects | document rows | unreferenced | missing file | bucket public |
|---:|---:|---:|---:|---|
| 188 | 108 | **85** | **5** | false |

**٨٥ فایل هیچ تۆمارێک ناوی نابات، و ٥ تۆمار فایلێکی نەماو ناودەبەن.** → هەنگاوی ٨.
بەکەتەکە گشتی نییە — ئەمە دروستە.

## ٦. فەرمانەکان

| definer total | anon may call | authenticated may call | not owned by `sarraf_definer` | no `search_path` |
|---:|---:|---:|---:|---:|
| 163 | **19** | 124 | 20 | 0 |

هیچ فەرمانێک بێ `search_path` نییە. بەڵام ١٩ فەرمانی SECURITY DEFINER هێشتا
بۆ `anon` کراوەن.

## ٧. RLS

| خشتە | هۆکار |
|---|---|
| `pending_accounts` | `FORCE` نییە |
| `zeman_notifications` | `FORCE` نییە |

## ٨. ئەکاونتەکان

| پلە | بازرگانی | چەند | چوونەژوورەوەی هەیە |
|---|---|---:|---:|
| customer | `t-sarkhel` | 5 | 5 |
| investor | `t-sarkhel` | 2 | 2 |
| manager | ⟨null⟩ | 1 | 1 |
| office | `t-sarkhel` | 1 | 1 |
| owner | `t-sarkhel` | 1 | 1 |
| owner | `t-watan` | 1 | 1 |
| partner | `t-sarkhel` | 2 | 2 |

ماناجەر بێ `tenant_id`ـە — ئەمە دروستە: خاوەنی پلاتفۆرمە، نەک ئەندامی بازرگانییەک.

## ٩. ژمارەکانی کار

| بازرگانی | مامەڵە | ڕیزی دەفتەر | ژورناڵ | نەپۆستکراو | فیش | کۆمەڵە |
|---:|---:|---:|---:|---:|---:|---:|
| 2 | 10 | 27 | 12 | 2 | 15 | 8 |
