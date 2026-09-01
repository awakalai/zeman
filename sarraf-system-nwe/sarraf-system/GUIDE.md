# ڕێنمایی دامەزراندن و بڵاوکردنەوەی ZEMAN

ئەمە ڕێڕەوی production ـە. `supabase_schema.sql` سکیمای کۆنی مێژووییە و نابێت لە SQL Editor جێبەجێ بکرێت. سەرچاوەی یەکلاکەرەوەی داتابەیس تەنها فایلە ڕیزبەندکراوەکانی `supabase/migrations/` ـن.

## ئەو فایلانەی لە وێنە/چاتەکەدا هەن

- `App.jsx`، `receiptWorkspace.js`، `ReceiptReviewWorkspace.jsx` و هاوشێوەکانیان کۆدی ئەپن؛ لە شوێنی خۆیان لە `src/` دانراون و نابێت لە SQL Editor جێبەجێ بکرێن.
- فایلە ژمارەدارەکانی `*.sql` migration ـن؛ لە `supabase/migrations/` دەمێنن و تەنها CLI بە ڕیز جێبەجێیان دەکات.
- `verify-accounting-db.mjs` و `verify-roles-e2e.mjs` تاقیکەرەوەن؛ بە `npm run verify:accounting` و `npm run verify:roles` جێبەجێ دەکرێن.
- `supabase_schema.sql` کۆن و retire کراوە؛ ئێستا بە مەبەست هەڵە دەدات تا بە هەڵە سکیمای ناتەواو دروست نەکرێت.
- لەم branch ـەدا ئەم فایلانە پێشتر لە شوێنی دروستی خۆیان دانراون؛ دووبارە copy/paste یان Runیان مەکە.

## پێش هەموو شتێک

- **`SECURITY.md`** — چۆن بازرگانییەکان لە یەکتر جیا دەکرێنەوە، و چی دەبێت
  ڕەچاو بکرێت کاتێک فەرمانێکی نوێ یان ڕێڕەوێکی نوێی API زیاد دەکرێت. هەر
  یاسایەکی تێیدا بە دەروازەیەکەوە بەندە.
- **`BASELINE.md`** — ژمارە زیندووەکانی داتابەیس، بە بەروارەوە. هەر کارێکی
  نوێ بەرامبەر بەمانە پێوانە دەکرێت.

## ١. پێداویستییەکان

- Node.js 22.17 یان نوێتر
- Git
- Docker بۆ stackی localی Supabase؛ Supabase CLI، Playwright و Chromiumی تاقیکردنەوە لە `package-lock.json` ـدا pinned ـن
- پڕۆژەی جیاوازی Supabase بۆ staging؛ production نابێت شوێنی یەکەم تاقیکردنەوە بێت
- پڕۆژەی Vercel یان hostێک کە API route ـەکانی `api/` جێبەجێ بکات

```bash
npm ci
npm test
npm run verify:source
npm run build
ZEMAN_DB_STRICT=1 npm run verify:accounting
ZEMAN_E2E_STRICT=1 npm run verify:roles
```

هەموو فرمانەکان دەبێت سەرکەوتوو بن پێش هەر push/deployێک.

## ٢. داتابەیسی نوێ

`supabase/config.toml` ئامادەیە، PostgreSQL 16 بەکاردەهێنێت، seedی نەبوو ناچالاکە و TOTP/MFAی local چالاکە. لە ڕەگی پڕۆژەکە:

```bash
npx supabase start
npx supabase db reset
ZEMAN_DB_STRICT=1 npm run verify:accounting
ZEMAN_E2E_STRICT=1 npm run verify:roles
```

`supabase db reset` تەنها بۆ local/test ـە؛ هەموو migration ـەکان لە سفرەوە بە ڕیز جێبەجێ دەکات. هەرگیز `supabase db reset --linked` لە production بەکارمەهێنە، چونکە داتا دەسڕێتەوە.

پاش سەرکەوتنی local، پڕۆژەی staging ببەستەوە و سەرەتا preview بکە:

```bash
npx supabase login
npx supabase link --project-ref STAGING_PROJECT_REF
npx supabase migration list
npx supabase db push --dry-run
npx supabase db push
```

لە staging هەموو ڕۆڵەکان و ئەم ڕێڕەوانە تاقی بکەرەوە: مامەڵەی A، B، C؛ پەسەندکردنی maker/checker؛ فیش/OCR؛ forwarding؛ settlement؛ debt؛ day close؛ backup/reconciliation.

## ٣. داتابەیسی کۆن/هەبوو

هیچ فایلێکی SQL بە دەستی و بە تاکی لە وێنە/چاتەکانەوە Run مەکە. ئەو فایلانە دەبێت لە هەمان بوخچەی `supabase/migrations/` بمێنن و CLI بە ڕیز جێبەجێیان بکات.

پێش دەستکاری remote:

1. لە Dashboard ـی Supabase backupی نوێ پشتڕاست بکەرەوە.
2. logical dumpێکی جیاواز هەڵبگرە و Storage object ـەکانیش جیا هەڵبگرە؛ backupی داتابەیس خودی فایلەکانی Storage ناگرێتەوە.
3. production ـەکە clone/restore بکە بۆ staging.
4. دۆخی migration بەراورد بکە:

```bash
npx supabase link --project-ref STAGING_PROJECT_REF
npx supabase migration list
npx supabase db push --include-all --dry-run
```

`202608090001_legacy_core_baseline.sql` بە مەبەستی reproducible fresh install پێش migration ـە کۆنەکان دانراوە. بۆ remoteێک کە migration ـە دواترەکانی پێشتر تۆمار کردووە، `--include-all` دەتوانێت migration ـە نەبووەکانی مێژوو لە dry-run پیشان بدات. تەنها دوای backup و سەرکەوتنی staging ئەمە جێبەجێ بکە:

```bash
npx supabase db push --include-all
```

ئەگەر `migration list` نیشانی schema drift یان history mismatch بدات، وەستا. `supabase migration repair` تەنها history دەگۆڕێت و SQL جێبەجێ ناکات؛ تەنها کاتێک بەکاریبهێنە کە بە پشکنینی schema دڵنیایت migration ـەکە پێشتر بە تەواوی جێبەجێ بووە. هیچ migrationێک بە خەیاڵی خۆت `applied` مەکە.

## ٤. دروستکردنی خاوەنی سیستەم

لە Supabase Authentication بەکارهێنەری خۆت دروست بکە، MFA چالاک بکە، UUID ـەکە هەڵبگرە، پاشان تەنها داتای bootstrap ـی خوارەوە دابنێ:

```sql
insert into public.app_users (id, auth_id, name, role, admin_level)
values ('admin-owner', 'AUTH_UUID', 'ناوی خاوەن', 'admin', 'owner')
on conflict (id) do update
set auth_id=excluded.auth_id,
    name=excluded.name,
    role='admin',
    admin_level='owner',
    deleted=false;
```

بۆ operator، `admin_level='operator'` بەکاربهێنە. بەکارهێنەری maker نابێت داواکاری خۆی پەسەند بکات؛ بۆ checker ئەکاونتێکی adminی جیاواز پێویستە.

## ٥. Environment variables

`.env.example` کۆپی بکە بۆ `.env`ی local. `.env` هەرگیز commit مەکە.

```text
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

`VITE_*` لە browser دەبینرێن. `SUPABASE_SERVICE_ROLE_KEY` و key ـەکانی OCR تەنها لە server/host دابنێ و هەرگیز پێشگری `VITE_` مەدە.

لانیکەم یەک OCR provider دابنێ:

```text
GROQ_API_KEY=
GEMINI_API_KEY=
GOOGLE_CLOUD_VISION_API_KEY=
ANTHROPIC_API_KEY=
OCR_PROVIDER=google-vision
```

فیشی OCR بە خۆی مامەڵە یان تۆماری دارایی دروست ناکات؛ پێویستی بە review/finalizationی ئەدمین هەیە.

## ٦. Production release

ڕیزبەندی release:

1. backupی DB و Storage؛
2. CI: test، source contract، build، accounting DB، role E2E، dependency audit؛
3. migration dry-run لە production؛
4. چالاککردنی maintenance/freeze لە ئەپ؛
5. `supabase db push` (یان `--include-all` تەنها بۆ یەکەم یەکخستنەوەی history کە staging پەسەندی کردووە)؛
6. جێبەجێکردنی `sarraf_runtime_contract()` و `sarraf_system_health()`؛
7. deployی frontend/API؛
8. smoke testی A/B/C، receipt، approval، settlement و day close؛
9. ناچالاککردنی maintenance تەنها دوای PASS.

تەنها یەک کەس migration بۆ remote push بکات. schema/table/function لە production Dashboard بە دەستی مەگۆڕە؛ هەر گۆڕانکارییەک دەبێت migrationی نوێ بێت.

## ٧. Backup و گەڕاندنەوە

- پلانی Free بە backupی ڕۆژانە دڵنیا مەزانە؛ بەردەوام `supabase db dump` و off-site copy هەبێت.
- backupی DB فایلەکانی Storage ناگرێتەوە؛ bucketی `receipts` و بەڵگەکانی office جیا هەڵبگرە.
- restore rehearsal لە staging بکە، نەک یەکسەر لە production.
- CSV backupی داتابەیس نییە؛ تەنها exportی ڕاپۆرتە.

سەرچاوەی فەرمی: [Supabase database migrations](https://supabase.com/docs/guides/deployment/database-migrations)، [local CLI workflow](https://supabase.com/docs/guides/local-development/cli-workflows)، [database backups](https://supabase.com/docs/guides/platform/backups).

## ٨. کارەکانی خاوەن پێش فرۆشتن

- project ref، domain و environment variable ـە ڕاستەقینەکان دابنێ.
- دوو adminی جیاواز بۆ maker/checker دروست بکە و MFAیان چالاک بکە.
- threshold ـەکانی approval، timezone و owner override لە ناوەندی کۆنترۆڵ دیاری بکە.
- rateی دەستی یەکەم بۆ هەر دراوێک تۆمار بکە؛ مامەڵەی بێ historical rate ڕەت دەکرێتەوە.
- backup/restore rehearsal و acceptance testی کڕیار بە داتای نموونە تەواو بکە.
- دوای ئەمانە production write چالاک بکە.
