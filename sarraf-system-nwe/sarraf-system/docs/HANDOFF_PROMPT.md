# ZEMAN — پرۆمپتی تەواوی کار / COMPLETE WORK MANDATE

> **بۆ ئەجێنتێکی نوێ.** ئەمە هەموو ئەو شتەیە کە دەبێت بیزانیت. هیچ شتێکی تر مەپرسە
> تا ئەم دۆکیومێنتەت بە تەواوی نەخوێندووەتەوە.
>
> **To the agent receiving this.** This is the entire mandate. Read all of it before
> touching a single file. It contains the owner's product brief verbatim, the true
> state of the repository (which differs from what the brief says), the five open work
> items with their exact technical state, the standard of proof this project uses, and
> the things only the owner can do.

---

## 0. کێیت و چی دەکەیت / WHO YOU ARE

You are solely responsible for building, verifying and preparing **ZEMAN** — a Kurdish
currency-exchange / core-banking system (`sarraf-system`) that its owner is preparing to
sell commercially. The owner writes no code, runs no terminal, touches no GitHub, no
Supabase, no migration, no test, no deployment. **You do all of it, end to end.**

The owner is travelling. **Do not stop and wait.** If a usage limit is reached, resume
automatically when it returns. Do not end a session with work half-done and unreported.

### زمان / Language
- **ڕاپۆرت و قسەکردن لەگەڵ خاوەن: بە کوردیی سۆرانی.** Progress reports, explanations and
  questions to the owner are written in Sorani Kurdish.
- **کۆد، ناوی فایل، ناوی فەنکشن، commit message، PR: بە ئینگلیزی.** Code, identifiers,
  commit messages and pull-request text are English.

### سێ پلەکە / THE THREE RANKS
The product has exactly three ranks of human, and **absolute tenant data separation**
between businesses:
1. **ماناجەر** — the vendor (platform operator). Sees the platform, onboards businesses.
2. **سەرخێڵ / وەتەن** — the business owners. Each owns one tenant and sees only it.
3. **ئەدمین** — staff inside a business.

Beneath these sit the counterparties the brief names: کڕیار (customer), هاوبەش (partner),
نووسینگە (office), وەبەرهێنەر (investor). Every one of them has their own portal, their own
navigation, their own data access and their own notifications, and **none of them may ever
see another tenant's data, ZEMAN's profit, or a partner's commission.**

---

## 1. ⚠️ دۆخی ڕاستەقینەی repo — بەشی ٢٦ـی پرۆمپتەکە هەڵەیە / GROUND TRUTH

**READ THIS BEFORE §26 OF THE BRIEF BELOW.** Section 26 of the owner's brief describes a
repository state that **does not exist here**. It was verified item by item and every
single claim in it is false for this repository:

| §26 claims | Reality, verified |
|---|---|
| path `/workspace/scratch/521cdd22271e/...` | does not exist |
| branch `codex/zeman-rebuild` | **no such branch**, in any remote |
| commits `e2a1dfa`, `0a4039c`, `3088d58`, `544920c`, `5d1df88` | **none of these commits exist** |
| `docs/ZEMAN_PRODUCT_SPEC_CKB.md` | **does not exist in any branch** |
| migration `20260903190000_twenty_receipts_one_declared_platform.sql` | **does not exist** |
| "uncommitted receipt changes — read the diff, don't delete it" | the tree had **no such changes** |
| "919 tests pass" | this repository has **910 tests** |

**Do not go looking for that work. Do not invent it. Do not report it as done.**
Section 26 and 27 of the brief must be treated as describing a *different* checkout that
was never merged here. Everything §26 lists as "already finished" you must treat as
**unbuilt and unverified** — which §25 and §28 of the brief require of you anyway.

### The repository you actually have

```
path      /home/user/zeman/sarraf-system-nwe/sarraf-system   (app root)
git root  /home/user/zeman
repo      awakalai/zeman
branch    claude/check-fish-sections-i68xu7    ← develop and push HERE, nowhere else
HEAD      2a31df0  "WIP: a sale draws on the customer's own money —
                    command written, checks not yet proving it"
tests     910 (node --test)
migrations 125 files in supabase/migrations/
stack     React 18 · Vite 7 · PWA · Supabase (Auth/Storage/PostgREST/Postgres/Realtime)
          · Vercel serverless routes under api/
```

### ⚠️ The most recent commit is §13, and its fault-injection proof was NOT run

The tip of the branch is **§13 of the brief — removal of the automatic debt reminder**.
It is committed, not merged, and it is deliberately **not** marked proven:

```
supabase/migrations/202609020015_no_reminder_sends_itself.sql   (new)
src/App.jsx                      (the loadAll() auto-send call removed)
src/services/debtRegister.js     (sendDueDebtReminders deleted, comment explains why)
scripts/verify-accounting-db.mjs (8 auto-reminder checks → 4 manual-only checks)
RELEASE.md                       (records the reversal)
docs/HANDOFF_PROMPT.md           (this document)
```

State of it: **`npm test` 910/910 pass, `npm run build` passes, `npm run verify:source`
passes, and the four new reminder checks pass** inside `verify:accounting`.

**What is missing is the fault-injection proof** — the four checks have only ever been seen
green. By the standard in §5 of this document that is not yet proof. Doing it is your first
task; the exact steps are in ‹کاری ١› below. **Finish this first, it is the cheapest complete
thing on the board.**

### ⚠️ Five checks in `verify:accounting` are RED, and they were red before you arrived

`ZEMAN_DB_STRICT=1 npm run verify:accounting` currently reports **`5 of 383 accounting
database checks failed`**. They come from HEAD (`2a31df0`), not from the uncommitted work:

```
FAIL  a customer buying pays from their own money without being asked
        — ERROR: sale would create negative inventory
FAIL  and the books do not count cash that never arrived
        — ERROR: sale would create negative inventory
FAIL  it takes what they have and never more
        — ERROR: sale would create negative inventory
FAIL  a customer with no money of theirs is settled the way they always were
        — ERROR: sale would create negative inventory
FAIL  buying FROM a customer does not reach into their money
        — ERROR: cash location has insufficient balance
```

These are **fixture problems, not necessarily logic problems** — the test has to stand up
sellable inventory and a funded safe the way the system really does, and it does not yet.
Details and everything already tried are in work item **#87** below. Until they are green
you may not call the customer-vault feature finished.

---

## 2. یاسا ڕەهاکان / ABSOLUTE RULES

### هەرگیز مەیکە / NEVER
- Never reset, wipe or re-seed the production database.
- Never delete database history, receipts, or Storage objects.
- Never rewrite an already-applied migration. Write a **new** additive one.
- Never expose a service-role key, provider key or any credential in client code, in
  source, or in a log.
- Never disable or weaken RLS, and never weaken an authorization check to make a test pass.
- Never mark a migration as applied without executing it.
- Never claim a feature works without having verified it.
- Never merge a stale branch wholesale.
- Never infer success or failure by pattern-matching localized message text.
- **Never use JavaScript floating-point arithmetic for authoritative financial values.**
- Never fix a discrepancy by deleting history or editing a posted row. **Reverse by a new
  entry.** Ledger and audit are append-only.
- Never say "production ready", "secure", "bug-free" or "ready for real money" because a
  build succeeded or unit tests passed.
- Never deceive the owner. **«من مەخەڵەتێنە بەو ردی بیکە.»** If something is unproven, the
  report says it is unproven.

### سنووری ژمێریاریی پارێزراو / PROTECTED ACCOUNTING BOUNDARIES
Do **not** redesign, "improve" or refactor any of the following unless a **confirmed,
reproduced defect** requires the smallest possible compatible fix:
- buy/sell price formulas · weighted-average cost · profit & loss · ledger mathematics
- maker/checker approval · currency precision · immutability of posted entries
- the contracts of existing financial RPCs

### ڕەزامەندیی خاوەن / OWNER CONSENT REQUIRED
Get explicit owner consent, in words, before:
- applying any migration to the **live** database,
- any test-data cleanup or live deletion,
- any production deployment.
Preview and test databases need no such consent — use them freely.

### Facts about this codebase you must not rediscover the hard way
- **Multi-tenancy** is `tenant_id` + `sarraf_tenant()` + the `sarraf_definer` role + FORCE
  RLS on every financial table.
- **`txs.business_flow`** takes exactly: `partner_custody`, `owner_cashbox`, `standard`,
  `commission`.
- **Command idempotency** goes through `sarraf_command_replay(uuid, text, text)` and
  `sarraf_store_command(uuid, text, text, jsonb)`. Every financial command must be atomic
  **and** idempotent under a replayed command key.
- **Chart of accounts:** `acc-1000` قاسە · `acc-1200` receivable · `acc-2000` customer funds
  payable · `acc-2300` payable · `acc-4000` spread · `acc-4100` fee income ·
  `acc-5200` write-off · `acc-5900` loss.
- **Income accounts are credit-normal.** `accountOf` computes debit − credit, so an
  *earning reads negative*. A "negative" income figure is usually correct; check before
  "fixing" it.
- The owner's own money in a currency **can legitimately be negative** (commissions paid in
  CNY against capital counted in USD). This has been measured and is not a defect.

---

## 3. پرۆمپتی خاوەن — بە تەواوی / THE OWNER'S BRIEF, VERBATIM

> ئەمە قسەی خاوەنە. یەک وشەی مەگۆڕە و بە کورتکراوە مەیخوێنەوە.
> This is the owner's own text. It is the requirement. Where it conflicts with existing
> code, **the brief wins.**

تۆ بەرپرسی تەواوی نوێکردنەوە و ئامادەکردنی سیستەمی دارایی ZEMAN ـیت. من هیچ کۆد، Terminal، GitHub، Supabase، migration، test یان deployment ـێک ناکەم؛ تۆ دەبێت هەموو کارەکە لە سەرەتا تا کۆتایی بە شێوەی پڕۆفیشناڵ بەڕێوە ببەیت.

ئەمە تەنها داواکاریی جوانکردنی UI یان چاککردنی چەند bug ـێک نییە. ئامانج ڕێکخستنەوەی بنەڕەتیی سیستەمەکەیە تا ببێتە بەرنامەیەکی دارایی متمانەپێکراو، سادە، خێرا، سەردەمیانە و گونجاو بۆ کاری ڕۆژانە.

### ١. سەرچاوەی ڕاستی کار

1. PDF ـی لۆجیکی ZEMAN سەرچاوەی فەرمی کاروبارە.
2. پێش گۆڕینی کۆد، PDF ـەکە بە تەواوی و بە وردی بخوێنەوە.
3. کۆدی ئێستا، database و live system پشکنین بکە و لەگەڵ PDF و ئەم prompt ـە بەراوردیان بکە.
4. ئەگەر کۆدی ئێستا لەگەڵ PDF یان بڕیارەکانی ئەم prompt ـە ناکۆک بوو، PDF و ئەم بڕیارانە پێشینەیان هەیە.
5. ئەگەر بابەتێک لێرە باس نەکرابوو، سەرەتا بگەڕێوە بۆ PDF؛ تەنها ئەگەر بڕیارێکی گرنگ بەڕاستی دیاری نەکراوە و کاری پێوە دەوەستێت پرسیار بکە.
6. شتی نوێ بە گومان زیاد مەکە و لۆجیکی دارایی لە خۆتەوە مەگۆڕە.
7. فیچەرە باش و کۆدە دروستەکانی ئێستا بپارێزە، بەڵام پابەندی ڕووکار و پڕۆسە خراپەکانی ئێستا مەبە.

> **🚨 ئاگاداری گرنگ / BLOCKING NOTE ON §1:** **ئەو PDF ـە لەم سیستەمەدا نییە.** The whole
> filesystem was searched: there is no PDF anywhere, and no `docs/ZEMAN_PRODUCT_SPEC_CKB.md`
> in any branch. §1 makes it the source of truth, so **ask the owner to send it and say
> plainly that it is missing.** Meanwhile: proceed on the text of this brief and the
> recorded conversation, build everything the brief states clearly, and **where only the PDF
> could decide a question, do not guess — write the question down in the matrix (§28) as
> blocked on the PDF and move on to the next item.**

### ٢. ئاستی کوالیتی داواکراو
کۆتایی کار نابێت تەنها "کار بکات". دەبێت:

* بێ bug و error ـی ئاشکرا بێت.
* workflow ـەکان لە سەرەتا تا کۆتایی تەواو بن.
* هەر پەڕەیەک ئامانج و هەنگاوی داهاتووی ڕوونی هەبێت.
* هیچ UUID، ناوی table، RPC، stack trace، error code یان زمانی developer بەکارهێنەر نەبینێت.
* mobile-first بێت، بەڵام لە کۆمپیوتەریش پڕۆفیشناڵ کار بکات.
* RTL، کوردی، ژمارە، دراو و دەقی ئینگلیزی بە دروستی ڕیز بکرێن.
* لە پەڕەکانی ڕۆژانەدا نووسین و badge و card ـی بێسوود لاببرێن.
* ڕەنگ، براند و ناسنامە جوانەکانی ZEMAN بپارێزرێن.
* bottom navigation هیچ ناوەڕۆکێک دانەپۆشێت.
* هەر ڕۆڵێک تەنها زانیاری و notification ـی پەیوەندیدار بە خۆی ببینێت.
* بەکارهێنەر بەبێ فێرکاری بزانێت: چی ڕوویداوە، چی پێویستی بە سەرنجی هەیە، چی ئامادەیە و هەنگاوی داهاتوو چییە.

### ٣. ڕۆڵەکانی سیستەم
سیستەم بۆ ئەم ڕۆڵانەیە:

* خاوەن ZEMAN
* کارمەند
* کڕیار
* هاوبەش، بەپێی جۆرەکانی ناو PDF
* نووسینگە
* وەبەرهێنەر
* Manager/platform administrator ئەگەر لە architecture ـی ئێستا هەیە

هەر ڕۆڵێک dashboard، navigation، data access و notification ـی تایبەتی خۆی هەبێت.

### ٤. دەسەڵاتی خاوەن و کارمەند
خاوەن و کارمەند بتوانن نزیکەی هەموو کاروبارەکان ئەنجام بدەن و کارمەند بۆ کاری ڕۆژانە پێویستی بە پرسی خاوەن نەبێت.

کارمەند بتوانێت:

* فیش، مامەڵە، کڕیار، هاوبەش، نووسینگە، قەرز و ڕاپۆرت بەڕێوە ببات.
* بەکارهێنەر دروست یان ناچالاک بکات.
* وشەی نهێنی کڕیار و هاوبەش بگۆڕێت.
* نرخ و ڕێکخستنەکانی کاروبار بگۆڕێت.
* backup و export دابەزێنێت و restore بکات.
* مامەڵەی تەواوکراو بە هۆکاری حەتمی هەڵبوەشێنێتەوە.
* پارەی نەقدی کڕیار بۆ باڵانس یان دانەوەی قەرز تۆمار بکات.
* باڵانس و کارەکانی قاسە ببینێت و ئەنجام بدات.

تەنها ئەم کارانە تایبەت بن بە خاوەن:

* یەکلاییکردنەوەی جیاوازیی ژماردنی قاسە.
* گەڕاندنەوەی فیشی خۆکار ئەرشیفکراوی فێڵ/دەستکاری/دووبارە، ئەگەر گەڕاندنەوەیان ڕێگەپێدراو بوو.

هیچ بەکارهێنەرێک کە باڵانس، قەرز یان پەیوەندیی دارایی ماوەی هەیە ناچالاک نەکرێت تا حسابەکەی پاک بێت.

### ٥. مێژوو و Audit
هەر کردارێکی خاوەن، کارمەند، هاوبەش، نووسینگە یان سیستەم بە تەواوی تۆمار بکرێت:

* ناوی ئەنجامدەر
* ڕۆڵ
* کاروبار/tenant
* بەروار و کاتی ورد
* زانیاریی پێش و دوای گۆڕانکاری
* هۆکاری گۆڕانکاری، هەڵوەشاندنەوە یان سڕینەوە
* IP و شوێنی نزیکەیی
* زانیاریی ئامێر و browser
* جۆری کردار
* transaction/reference ـی پەیوەندیدار

خاوەن و کارمەند هەردووکیان بتوانن هەموو مێژووی چاودێری ببینن و بگەڕێن.

هیچ مامەڵەی دارایییەک بە سڕینەوە یان edit ـی خام ڕاست مەکەوە. مامەڵەی هەڵە هەڵبوەشێنرێتەوە و مامەڵەی ڕاستی نوێ دروست بکرێت. هەموو زنجیرەکە لە audit ـدا بمێنێتەوە.

### ٦. چوونەژوورەوە و هەژمار

* کڕیار، هاوبەش، نووسینگە و ڕۆڵە پەیوەندیدارەکان بە ژمارەی مۆبایل و وشەی نهێنی بچنە ژوورەوە.
* 2FA بۆ خاوەن و کارمەند لەم قۆناغەدا پێویست نییە.
* خاوەن و کارمەند بتوانن وشەی نهێنی کڕیار/هاوبەش/بەکارهێنەری ئاسایی reset بکەن.
* hierarchy ـی admin بپارێزرێت؛ کارمەند نەتوانێت هەژماری admin ـی سەرووخۆ دەستکاری بکات.
* سێ شێوازی دروستکردنی هەژماری کڕیار و هاوبەش کە لە PDF یان سیستەمی ئێستا دیاریکراون بپارێزرێن و ڕێک بخرێنەوە.
* ناو و ژمارەی مۆبایل تەنها بە پەسەندکردن بگۆڕدرێن.
* بەکارهێنەر بتوانێت وشەی نهێنی، زمان و وێنەی پڕۆفایل بگۆڕێت.
* پۆرتاڵی کڕیار و هاوبەش لەم قۆناغەدا تەنها کوردی بێت.

### ٧. فۆڕم و بەشی Manager
فۆڕمی Manager و business onboarding بە تەواوی پشکنین و چاک بکرێت:

* business و owner بە شێوەی atomic و server-side دروست بن.
* phone/password login بە دروستی کار بکات.
* tenant isolation و role hierarchy نەشکێت.
* هەڵەکان بە زمانی سادە پیشان بدرێن.
* double submission و business نیمچەدروست ڕوونەدات.
* هەژماری Manager بتوانێت business ـی دیاریکراو بکاتەوە و تەنها لەو context ـەدا کار بکات.
* هەموو workflow ـەکە بە browser و role tests تاقی بکرێتەوە.

### ٨. سیستەمی فیش و OCR/AI
ئەم بەشە یەکێکە لە گرنگترین بەشەکان. ئامانج ئەوەیە زۆربەی فیشە ڕوونەکان بەبێ پشکنینی دەستی ئامادە بن.

**یاسای upload**

* کڕیار تەنها فیشی فرۆشتن دەنێرێت؛ واتە کاتێک شتێک/پارەیەک بە ZEMAN دەفرۆشێت.
* پێش upload تەنها پلاتفۆڕم دیاری بکات.
* لەم قۆناغەدا Alipay و WeChat چالاک بن، بەڵام architecture بۆ پلاتفۆڕمی داهاتوو ئامادە بێت.
* لە هەر upload ـێکدا تەنها یەک پلاتفۆڕم بۆ هەموو وێنەکان.
* زۆرترین ژمارە 20 فیش لە یەک upload.
* هەر upload یەک batch/group ـی سەربەخۆیە.
* فیشی دوو upload ـی جیاواز هیچ‌کات تێکەڵ نەکرێن.
* لە ناو هەمان group خاوەن/کارمەند بتوانێت هەموو فیشەکان یان تەنها هەندێکیان select بکات و مامەڵەیان لێ دروست بکات.
* فیشە select نەکراوەکان لە هەمان group بمێنن بۆ مامەڵەی داهاتوو.
* default selection تەنها فیشە ئامادە و نەگۆڕدراوەکان بێت.

**Pipeline ـی خوێندنەوە** — pipeline ـەکە بە شێوەیەکی بەهێز دروست بکە:

1. image validation و normalization
2. image hash
3. OCR/vision provider ـی سەرەکی
4. structured extraction
5. provider fallback و retry
6. template/rule verification بۆ Alipay/WeChat
7. duplicate detection
8. tamper/fraud signals
9. deterministic reconciliation
10. confidence grading
11. auto-ready یان review/archive

**دەرکردنی زانیارییەکان:** gross amount · fee · net/order amount · currency ·
order/reference number · date/time · platform · sender/receiver ·
receipt/account identifiers · هەر زانیارییەکی پێویستی کاروبار

AI تەنها بۆ خوێندنەوە و تێگەیشتن بەکاربهێنە. ژماردنی gross/fee/net، نرخ، باڵانس، قەرز، قازانج و ledger بە کۆدی deterministic و database ـی باوەڕپێکراو بکرێت؛ نەک بە بڕیاری AI.

**دۆخی فیش**

* confidence ـی بەرز و reconciliation ـی دروست: خۆکار ببێتە «ئامادە بۆ مامەڵە».
* فیشی گوماناوی: providerێکی تر و retry ـی زیرەکانە تاقی بکرێتەوە.
* ئەگەر دوای retry هێشتا ناڕوون بوو: بچێتە پشکنینی خاوەن/کارمەند.
* خاوەن/کارمەند کە قبووڵی کرد، بچێتە کۆمەڵەی ئامادە بۆ مامەڵە.
* duplicate یان فێڵ/دەستکاریی وێنە: خۆکار ئەرشیف بکرێت، لە ژمارەی ئامادەکاندا نەبێت و هۆکاری وردی تۆمار بکرێت.
* rejected/duplicate/fraud بۆ کڕیار بە زمانی سادە ڕوون بکرێتەوە و دوگمەی لابردن لە لیستی خۆی هەبێت؛ بەڵام بەڵگەی server-side و audit مەسڕەوە.
* فیشی ناڕوون بتوانرێت دووبارە upload بکرێت؛ ئەگەر دووبارەش ناڕوون بوو، وەک review group بگاتە خاوەن.
* هەموو هەوڵێک بدرێت ژمارەی manual review زۆر کەم بێت.

Duplicate detection تەنها بە یەک خانە مەکە؛ image hash، order/reference، amount، date، platform و پەیوەندییەکان بە یاسای ڕوون بەکاربهێنە.

Google Vision یان هەر providerێک ئەگەر billing/rate-limit/error ـی هەبوو نابێت pipeline بوەستێنێت. fallback ـی ڕاستەقینە و observable دروست بکە، بەڵام هیچ secret ـێک لە client یان source code دەرنەکەوێت.

### ٩. گۆڕینی فیش بۆ مامەڵە
کاتێک batch ئامادەیە:

* خاوەن/کارمەند فیشەکان select بکات.
* بتوانێت دانەدانە یان بە کۆمەڵ مامەڵە دروست بکات.
* هەر transaction تەنها بە فیشە select کراوەکانی هەمان batch پەیوەست بێت.
* فیشە ماوەکان لە هەمان batch بمێنن.
* کڕیار پێویست ناکات notification ـی «فیشەکەت گۆڕا بۆ مامەڵە» وەربگرێت.
* بەڵام لە پۆرتاڵدا بتوانێت دۆخی پەیوەندیدار، بڕ، کۆ، فیشەکان و ئەنجامی مامەڵەکە ببینێت.
* هیچ فیشی archived/rejected/duplicate/tampered نەبێتە ژمارەی transaction.

### ١٠. پۆرتاڵی کڕیار
پۆرتاڵەکە mobile-first، کوردی، پاک و پڕۆفیشناڵ بێت. کڕیار بتوانێت:

* فیش بنێرێت.
* فیشەکان، وردەکاری، کۆی بڕ و دۆخیان ببینێت.
* مامەڵە و مێژووی خۆی ببینێت.
* باڵانس و قەرزی خۆی ببینێت.
* ڕاپۆرت و بەڵگەنامە دابگرێت.
* search و filter ـی سادە و بەسوود بەکاربهێنێت.
* PDF ـی براندکراو دابگرێت.
* بەڵگە و ڕاپۆرت بە Share/WhatsApp بنێرێت.

لە وردەکاریی مامەڵەدا هەموو زانیاریی پەیوەندیدار بە خۆی ببینێت، بەڵام:

* قازانجی ZEMAN نەبینێت.
* عمولەی هاوبەش نەبینێت.
* notification، audit یان زانیاریی ناوخۆی ZEMAN نەبینێت.

ڕوونی بکەوە:

* مامەڵەکە دروست بووە.
* پارەکە کێ دەیدات.
* خاوەن ڕاستەوخۆ دەیدات، نووسینگە دەیدات، دەبێتە قەرز، لە باڵانس کەم دەکرێتەوە یان بە mutual balance ساف دەبێتەوە.
* ئەگەر پارە لای نووسینگەیە، ناو و وردەکاری پەیوەندیدارەکە پیشان بدرێت.

### ١١. باڵانسی کڕیار و قاسەی گشتی
پارەی کڕیار قاسەی فیزیکی سەربەخۆ نییە. پارەکە لە قاسەی گشتیی ZEMAN ـدایە، بەڵام customer subledger نیشان دەدات چەند بڕ بۆ کڕیارەکە دانراوە.

* کڕیار تەنها باڵانس و مێژووی خۆی ببینێت.
* کڕیار نەتوانێت خۆی cash movement دروست بکات.
* ئەگەر مامەڵەیەک پێویستی بە پارەی باڵانسی کڕیار هەبوو، سیستەم خۆکار بەکاری بهێنێت.
* **ئەگەر باڵانس لە بڕی مامەڵە کەمتر بوو، هەموو باڵانسەکە بەکاربهێنرێت و ماوەکە ببێتە قەرز.**
* کاتێک earmarked balance بەکاردهێنرێت، customer claim کەم بکرێتەوە و بڕەکە بەپێی ledger ـی دروست بگەڕێتە بەردەستیی گشتی.
* ئەگەر ZEMAN و کڕیار لە هەمان دراودا قەرزی یەکتریان هەبوو، خۆکار ساف بکرێتەوە و مێژووی تەواوی allocation تۆمار بکرێت.

### ١٢. مامەڵە و شێوازی پارەدان

* شێوازی پارەدانی مامەڵە بە تەواوی لەلایەن خاوەن/کارمەند دیاری بکرێت.
* هەر مامەڵە تەنها یەک شێوازی پارەدانی هەبێت؛ split payment مەکە.
* payment route دەبێت بە ڕوونی دیاری بکات:
   * خاوەن/ZEMAN ڕاستەوخۆ پارە دەدات.
   * نووسینگە پارە دەدات.
   * پارە لە customer balance بەکاردهێنرێت.
   * مامەڵە دەبێتە قەرز.
   * بە mutual balance/debt ساف دەکرێتەوە.
* هەر transition ـێک atomic، idempotent و audit کراو بێت.
* هیچ money amount یان calculated total ـێک لە client بەبێ server verification باوەڕپێنەکرێت.

### ١٣. قەرز

* قەرز بەپێی دراو و ئاراستەی قەرز جیا بپارێزرێت؛ جیاوازەکان بە شێوەی نادروست net مەکرێن.
* ئەگەر قەرزی دوولایەنە لە هەمان دراو هەبوو، بە یاسای دیاریکراو خۆکار ساف بکرێتەوە.
* قەرزی کۆنتر سەرەتا ساف بکرێتەوە.
* بەرواری دانەوە حەتمی نییە.
* **هیچ debt reminder ـی خۆکار مەبنێرە.**
* **تەنها کاتێک خاوەن یان کارمەند دوگمەی ناردن دەگرێت، ئاگاداری بنێردرێت.**
* دوگمەی ئاگاداری قەرز بە یەک کلیک:
   * in-app notification دروست بکات.
   * Push بنێرێت.
   * WhatsApp بە پەیامی پڕ و ئامادە بکاتەوە.
* هەموو reminder ـەکان لە مێژوودا تۆمار بکرێن.

### ١٤. نووسینگە
هەر نووسینگە:

* هەژمار و چوونەژوورەوەی تایبەتی هەبێت.
* تەنها پارەدانە سپێردراوەکانی خۆی ببینێت.
* ناو و ژمارەی کڕیاری پەیوەندیدار ببینێت.
* کۆی پارەی سپێردراو بەپێی دراو ببینێت.
* مێژووی پارەدان و بەڵگەکان ببینێت.
* تەنها بتوانێت بڵێت «پارە درایە کڕیار».
* پشتڕاستکردنەوەی نووسینگە بۆ پارەدان کافییە؛ upload ـی بەڵگە حەتمی نییە.
* ئەگەر بە هەڵە پارەدان پشتڕاست کرد، خۆی بە هۆکاری حەتمی هەڵیوەشێنێتەوە و هەموو audit بمێنێتەوە.

کاتێک مامەڵەیەک بۆ پارەدانی نووسینگە دیاری دەکرێت:

* بڕی پێویست خۆکار بچێتە حسابی سپاردەکانی نووسینگە.
* نووسینگە کاتێک پارەی دا، بڕەکە لە سپاردەیەکە کەم بکرێتەوە.
* ئەگەر نووسینگە لە پارەی خۆی زیاتر دابین کرد، جیاوازییەکە دەبێتە قەرزی ZEMAN بۆ نووسینگە.
* سیستەم مێژووی ئەوە پیشان بدات چەند پارە، بۆ کێ، بۆ کام transaction و لە چ کاتێک دراوە.
* کۆی ڕۆژانە، هەفتانە و مانگانە هەبێت.
* cash prefunding یان دانەوەی پارە لەلایەن ZEMAN بە ڕوونی تۆمار بکرێت.
* کاتێک پارەی نوێ دێت و قەرزی کۆن هەیە، سیستەم پێشنیاری سافکردنەوە بکات؛ خاوەن/کارمەند پشتڕاستی بکەن.
* حسابی نووسینگە بە شێوەی قورس و ناڕوون پیشان مەدە؛ زۆربەی کات position سفرە و تەنها سپاردە و قەرزی ڕاستەقینە نیشان بدرێت.

notification بۆ کڕیار لە هەر سێ قۆناغی پارەدانی نووسینگە بە پەیامی جیاواز بنێرە:

1. پارەدان بۆ نووسینگە سپێردرا.
2. پارە لە نووسینگە ئامادەی وەرگرتنە.
3. نووسینگە پشتڕاستی کرد پارە دراوە.

### ١٥. هاوبەش و ئەکاونتی Alipay/WeChat
جۆرەکانی هاوبەش و لۆجیکی هەر جۆرێک لە PDF وەربگرە.

* خاوەن لە کاتی دروستکردنی هەژماری هاوبەش عمولەکەی دابنێت.
* خاوەن و کارمەند بتوانن دواتر عمولە بگۆڕن.
* لە مامەڵەی تایبەتدا عمولە بتوانرێت override بکرێت.
* نرخی پێشوو و نوێ و ئەنجامدەر تۆمار بکرێت.
* کاتێک پارە دەچێتە ئەکاونتی Alipay/WeChat ـی هاوبەش، عمولە هەیە.
* نموونە: 1,000 CNY دێتە ئەکاونت و عمولە 1% ـە؛ 990 CNY وەک باڵانسی بەردەست تۆمار بکرێت و 10 CNY وەک عمولەی هاوبەش بە شێوەی ڕوون تۆمار بکرێت.
* کاتێک هاوبەش پارە دەنێرێت، عمولەی دووەم لێ مەبڕە.
* هاوبەش خۆی بتوانێت جوڵەی هاتن/چوونی پارە پشتڕاست بکات؛ خاوەن/کارمەندیش بتوانن.
* ئەگەر هاوبەش بە هەڵە پشتڕاستی کرد، بە هۆکاری حەتمی هەڵیوەشێنێتەوە.
* ئەگەر باڵانس کافی نەبوو، هەموو باڵانسەکە بەکاربهێنرێت و ماوەکە ببێتە قەرزی هاوبەش.
* ئەگەر هاوبەش قەرزدار بوو و پارەی نوێ هات، خۆکار قەرزی کۆنتر سەرەتا ساف بکرێتەوە و ماوەکە ببێتە باڵانس.
* هاوبەش لە سپاردەی خۆیدا ناو، ژمارەی مۆبایل، بڕ و وردەکاریی پارەدانی کڕیار ببینێت؛ زانیاریی ناوخۆی زیاتر نەبینێت.

### ١٦. پۆرتاڵی هاوبەش
هاوبەش بەپێی ڕۆڵ و جۆری خۆی بتوانێت:

* فیش و مامەڵە پەیوەندیدارەکان ببینێت.
* باڵانس و حسابەکانی خۆی ببینێت.
* قەرز و پارەدانەکانی خۆی ببینێت.
* ڕاپۆرت و بەڵگەنامە دابگرێت.
* search/filter بەکاربهێنێت.
* PDF ـی براندکراو و Share/WhatsApp بەکاربهێنێت.

هیچ قازانج، عمولە، notification یان داتای پەیوەندینەدار بە خۆی نەبینێت.

### ١٧. وەبەرهێنەر
وەبەرهێنەر لە پۆرتاڵی خۆیدا تەنها ببینێت:

* سەرمایەی خۆی
* قازانج/زیانی بەشی خۆی
* مێژووی زیادکردن و کەمکردنی سەرمایە
* ڕاپۆرت و بەڵگەنامەی پەیوەندیدار

وەبەرهێنەر نەتوانێت خۆی سەرمایە کەم بکات یان داوای وەرگرتن دروست بکات. خاوەن/کارمەند جوڵەکە تۆمار بکەن.

### ١٨. قاسە

* CNY، USD و IQD بە جیا نیشان بدرێن.
* کۆی گشتی بۆ ڕاپۆرت بە USD نیشان بدرێت.
* خاوەن و کارمەند هەموو کورتە و کارەکانی قاسە ببینن و بتوانن ئەنجامی بدەن.
* ژماردن و داخستنی قاسە ڕۆژانە reminder ـی هەبێت، بەڵام حەتمی نەبێت.
* ئەگەر ژمارەی فیزیکی و سیستەم یەک نەبوون:
   * جیاوازییەکە تۆمار بکرێت.
   * هۆکار حەتمی بێت.
   * بچێتە مێژووی پشکنین.
   * تا یەکلایی نەکراوەتەوە ئاگاداریی سووری هەمیشەیی پیشان بدرێت.
   * کارەکانی تر بتوانن بەردەوام بن.
   * تەنها خاوەن بتوانێت جیاوازییەکە یەکلا بکاتەوە.

### ١٩. دراو و نرخ
لە قۆناغی یەکەم: **CNY · USD · IQD**

یاساکان:

* کۆی قازانج و ڕاپۆرتی گشتی بە USD.
* شێوازی پیشاندانی نرخ: `1 USD = 7.20 CNY`.
* نرخی کڕین و فرۆشتن جیا بن.
* هەردوو شێوازی نرخ/ڕێکخستن کە لە PDF باسکراون پشتیوانی بکرێن.
* نرخی بازاڕی ئۆنلاین تەنها reference/جوانییە؛ هیچ ژماردنێکی دارایی بەخۆکار لەسەری مەکە.
* خاوەن/کارمەند بتوانن نرخی مامەڵەی تایبەت بگۆڕن.
* نرخی پێشوو، نرخی نوێ، ئەنجامدەر، کات و هۆکار تۆمار بکرێت.
* هیچ مامەڵەی non-USD بەبێ نرخی دروست valuation مەکە.

### ٢٠. Notification
سێ channel: **In-app · Push · WhatsApp**

* هەر بەکارهێنەر تەنها notification ـی خۆی ببینێت.
* internal/admin notifications بۆ کڕیار و هاوبەش دەرنەکەون.
* **هیچ notification ـی خۆکار بۆ debt reminder مەبنێرە.**
* فیشی کڕیار کە تەنها گۆڕدرا بۆ مامەڵە notification ـی تایبەتی پێویست نییە.
* گۆڕانی باڵانس، بەکارهێنانی پارەی قاسە، دروستبوون/دانەوەی قەرز و قۆناغەکانی پارەدانی نووسینگە notification ـیان هەبێت.
* پەیامی WhatsApp تێر و تەسەل، جوان و بە وردەکاریی داراییی پەیوەندیدار بێت.
* WhatsApp API ئێستا ئامادە نییە؛ بۆیە دوگمەی WhatsApp پەیامێکی ئامادە دروست بکات و WhatsApp بکاتەوە تا بەکارهێنەر خۆی بینێرێت.
* بەبێ کلیکی خاوەن/کارمەند هیچ WhatsApp ـێک خۆکار مەبنێرە.

### ٢١. ڕاپۆرت و بەڵگەنامە

* هەموو ڕۆڵێک تەنها ڕاپۆرتی پەیوەندیدار بە خۆی ببینێت.
* PDF ـەکان براندکراو، کوردی، RTL و گونجاو بۆ چاپ بن.
* Search، date range، currency، status و party filters هەبن.
* Share و WhatsApp بە شێوەی ئاسان هەبێت.
* هیچ قازانج، عمولە یان data leakage بۆ کڕیار/هاوبەش/نووسینگە ڕوونەدات.
* کۆی ڕۆژانە، هەفتانە و مانگانە لە شوێنی پێویست هەبێت.

### ٢٢. Database و ئاسایش

* tenant isolation لە database/RLS و server-side enforcement بێت، نەک تەنها UI.
* service-role secret، provider key و credential هیچ‌کات نەچێتە client یان source.
* هەموو financial commands atomic و idempotent بن.
* ledger و audit append-only بن.
* reverse/reversal بە entry ـی نوێ بکرێت، نەک سڕینەوەی entry ـی کۆن.
* client amount، fee، total، role، tenant یان permission بەبێ server verification باوەڕپێنەکرێت.
* migration ـەکان additive و safely deployable بن.
* migration ـی نوێ لە test/preview database تاقی بکەوە.
* پێش live migration، پاککردنەوەی داتا یان production deployment ڕەزامەندیی ڕوونی خاوەن وەربگرە.
* restore/backup ـەکان بە audit و confirmation بپارێزە.

### ٢٣. Backup و داتای تێست

* backup ـی خۆکار ڕۆژانە بێت.
* 30 ڕۆژ بپارێزرێت.
* خاوەن و کارمەند بتوانن backup/export دابەزێنن و restore بکەن.
* پێش پاککردنەوەی داتای تێست backup بگرە.
* هەموو داتای تێست لاببرە، بەڵام ئەو سێ هەژمارەی خاوەن دیاریکردووە مەسڕەوە.
* پێش هەر live deletion ـێک identity ـی ئەو سێ هەژمارە بە read-only check پشتڕاست بکە و preview ـی لیستی سڕینەوە پیشان بدە.
* هیچ live data deletion ـێک بە گومان ئەنجام مەدە.

### ٢٤. ڕێکخستنەوەی UX
پەڕەکانی ئێستا وەک نموونەی کۆتایی مەبینە. ئەگەر پێویست بوو لە نوێوە دایانبڕێژە.

* owner dashboard: هەموو بابەتە گرنگەکان، بەڵام بە priority و کورتەی ڕوون.
* employee dashboard: هەمان workflow ـە ڕۆژانەکان بەبێ زانیاریی سەرلێشێوێنەر.
* receipt screen: ئامادە، پشکنین، ئەرشیف بە ڕوونی جیا.
* raw OCR تەنها لە inspector/details.
* customer/partner/office/investor portals: سادە، mobile-first و role-specific.
* navigation بە پێی ڕۆڵ.
* card ـی درێژ و نووسینی دووبارە لاببرە.
* status ـەکان یەک واتا و یەک ڕەنگیان هەبێت.
* `completed` لەگەڵ دوگمەی «پەسەندکردن» تێکەڵ مەکە.
* empty state، loading، retry، offline و error state ـی پڕۆفیشناڵ دروست بکە.
* دوگمەی سەرەکی لە هەر پەڕەیەک ڕوون بێت.
* accessibility، focus، keyboard، contrast و touch target بپارێزە.

### ٢٥. شێوازی کارکردنی تۆ

1. سەرەتا repo، git status، branch، PDF، migrations، tests و architecture بخوێنەوە.
2. **هیچ uncommitted change ـێکی بەکارهێنەر مەسڕەوە.**
3. گۆڕانکارییەکان بە checkpoint ـی مانادار ئەنجام بدە.
4. patch ـی کاتی و سەرپێیی مەکە؛ root cause چارەسەر بکە.
5. دوای هەر بەشی گرنگ targeted tests بنووسە.
6. دوای چەند TSX/React edit ـێک quality review بکە.
7. هەموو workflow ـەکان بە real browser تاقی بکەوە، بە تایبەتی mobile.
8. هەر feature ـێک تا database/API/UI/audit/error state/test تەواو نەبووە، completed مەژمێرە.
9. لە ماوەی کاردا بە کورتی بڵێ چی تەواو بووە و چی دێتە دواتر؛ ادعای نادروست مەکە.
10. ئەگەر toolێک شکست هێنا، ڕێگایەکی safe ـی تر تاقی بکەوە.
11. production deploy مەکە تا preview و تاقیکردنەوە تەواو نەبێت و خاوەن بە ڕوونی ڕەزامەندی نەدات.

### ٢٦ و ٢٧ — ⚠️ ئەم دوو بەشە بۆ ئەم repo ـە دروست نین
The owner's §26 ("current repo state") and §27 ("suggested next steps after committing the
receipt group") describe a checkout that **does not exist here** — see **§1 GROUND TRUTH**
at the top of this document for the item-by-item verification. Read them for the owner's
*intent* about receipts (20 per upload, one declared platform per upload, Alipay/WeChat
selection, API validation for mixed platform, auto-archive on tamper suspicion) — that
intent is real and is repeated in §8 of the brief, which is binding. But **do not go
looking for those commits, that branch, that spec file, or those uncommitted changes.**
Build the receipt requirements from §8 and §9 as unbuilt work, and verify what this
repository actually has.

### ٢٨. پێوەری تەواوبوون
کارەکە تەنها کاتێک تەواوە کە:

* business logic ـی PDF و ئەم prompt ـە جێبەجێ بووبێت.
* هەموو role ـەکان بە permission ـی ڕاست کار بکەن.
* portal ـەکان data leakage ـیان نەبێت.
* فیشە ڕوونەکان بە زۆری خۆکار ئامادە بن.
* fallback و retry بەڕاستی کار بکەن.
* receipt group ـەکان تێکەڵ نەبن.
* financial operations atomic و audit کراو بن.
* reversal، debt، customer balance، office و partner commission بە دروستی کار بکەن.
* mobile و desktop UX پڕۆفیشناڵ بێت.
* هەموو tests، build، source/security checks و browser tests سەرکەوتوو بن.
* هیچ console error، broken route، raw error یان ناوەڕۆکی دادەپۆشراو نەبێت.
* preview ـی کۆتایی ئامادە بێت.
* ڕاپۆرتێکی ڕوون بدەیت: چی گۆڕا، چی تاقیکرایەوە، چی هێشتا پێویستی بە credential/API/ڕەزامەندیی خاوەن هەیە.
* پێش live migration، test-data deletion یان production deployment ڕەزامەندیی خاوەن وەربگیرێت.

ئامانجی کۆتایی ئەوەیە کاتێک خاوەن دەچێتەوە ناو ZEMAN و تاقی دەکاتەوە، سیستەمەکە وەک product ـێکی تەواو، سادە، خێرا، متمانەپێکراو و پڕۆفیشناڵ هەست پێ بکرێت؛ نەک کۆمەڵێک پەڕە و feature ـی تێکەڵ.

### دۆخی سەرەتایی و یاسای جێبەجێکردن
هیچ feature، migration، form، permission، OCR workflow، portal، notification یان لۆجیکێک بە تەواوکراو مەزانە، تەنانەت ئەگەر:

* کۆدی پەیوەندیداری لە repo هەبێت؛
* migration ـێکی بۆ نووسرابێت؛
* test ـێکی بۆ هەبێت؛
* comment یان document بڵێت تەواوە؛
* **ئەجێنتێکی پێشوو ادعای تەواوبوونی کردبێت.**

تۆ دەبێت هەموو داواکارییەکانی PDF و ئەم prompt ـە لە سەرەتاوە وەک کاری نەتەواو مامەڵەیان لەگەڵ بکەیت.

بۆ هەر داواکارییەک:

1. کۆد، database، migration، API، permission و UI ـی ئێستا بپشکنە.
2. بە تەنها بوونی کۆد بەڵگەی کارکردن نییە.
3. workflow ـەکە لە سەرەتا تا کۆتایی تاقی بکەوە.
4. ئەگەر دروست و تەواو بوو، بە تاقیکردنەوە پشتڕاستی بکە.
5. ئەگەر نەتەواو، هەڵەدار یان ناگونجاو بوو، چاکی بکە یان لە نوێوە دروستی بکە.
6. database enforcement، server authorization، UI، audit، error recovery و tests هەمووی تەواو بکە.
7. هیچ خاڵێک تەنها بەهۆی بوونی فایل یان test ـی کۆن skip مەکە.
8. هەموو requirements ـەکان بە checklist تۆمار بکە و تەنها دوای verification نیشانەی تەواوبوونیان بدە.
9. هەر uncommitted change ـێکی ئێستا وەک کاری نەپشکنراو مامەڵەی لەگەڵ بکە؛ مەیسڕەوە، بەڵام پێش پاراستن یان commit کردن بە وردی review و test ـی بکە.
10. هیچ ادعای «تەواوە» مەکە تا بە real browser، API، database و role-specific tests پشتڕاست نەکرابێتەوە.

ئەرکی تۆ تەنها بەردەوامبوون لە کاری ئەجێنتێکی پێشوو نییە؛ ئەرکت ئەوەیە هەموو سیستەمی ZEMAN بە پێی PDF و تەواوی ئەم prompt ـە پشکنین، دروست، نوێ، تاقی و ئامادە بکەیت.

ئەگەر کۆدی باشی ئێستا داواکارییەک بە تەواوی جێبەجێ دەکات، دەتوانیت بیپارێزیت؛ بەڵام دەبێت خۆت بە بەڵگە و تاقیکردنەوە دڵنیابیت. **هیچ ڕاپۆرتی پێشووتر وەک بەڵگەی تەواوبوون قبووڵ مەکە.**

کۆتایی کاردا **requirement matrix** ـێک بدە کە بۆ هەر خاڵ ئەمانە نیشان بدات:

* دۆخی پێشوو
* گۆڕانکاریی ئەنجامدراو
* فایل و migration ـی پەیوەندیدار
* تاقیکردنەوەی ئەنجامدراو
* ئەنجامی browser/API/database verification
* هەر شتێک کە بەهۆی نەبوونی credential یان ڕەزامەندیی production هێشتا جێبەجێ نەکراوە

---

## 4. پێنج کارە کراوەکە / THE FIVE OPEN WORK ITEMS

These are agreed with the owner and are **in addition to** verifying all 28 sections.
Do them in this order. Each one ends in a commit, a pushed branch, a PR, and a merge —
**you create AND merge the PRs yourself; the owner does not.**

---

### کاری ١ — §13: بیرخستنەوەی خۆکاری قەرز لاببرێت *(ALMOST DONE — FINISH IT FIRST)*

**What the owner wants:** «هیچ debt reminder ـی خۆکار مەبنێرە. تەنها کاتێک خاوەن یان کارمەند
دوگمەی ناردن دەگرێت، ئاگاداری بنێردرێت.» (brief §13 and §20)

**Why this is a reversal:** earlier the owner said the opposite — «گەر دوای هەفتەیەک جواب
نەبوو، ئۆتۆماتیکی بیکات» — and migration `202609020012` built exactly that, it was merged,
and **it is applied to the live database**. The brief now overrides it. §1.4 says the brief
wins. So the sender goes.

**Already written and committed (but NOT proven by fault injection):**
- `supabase/migrations/202609020015_no_reminder_sends_itself.sql` —
  `drop function if exists public.sarraf_send_due_debt_reminders(integer);` and a comment on
  the reader explaining it sends nothing.
- `src/App.jsx` — the `remindersAsked` ref, the `sendDueDebtReminders(...)` call inside
  `loadAll`, and the import all removed.
- `src/services/debtRegister.js` — `sendDueDebtReminders` deleted, replaced by a comment
  block explaining the reversal. **`remindDebtor` is untouched** — the button is now the
  only path and must keep working.
- `scripts/verify-accounting-db.mjs` — the 8 `autoReminderChecks` replaced by 4
  `reminderIsManualOnly` checks:
  1. `nothing in the database will send a reminder on its own` — queries `pg_proc` for any
     `public` function whose name matches `%send_due%` and requires the answer to be `none`.
  2. `a debt a week old is still found, so the owner can be shown it` — the read-only
     `sarraf_debts_due_a_reminder(7)` is **kept**, because it is what lets a screen say
     «٣ قەرز هەفتەیەکە بێ‌جوابن» beside the button.
  3. `and being found sends them nothing` — calling the reader twice must send zero
     notifications. A reader that quietly sends is the automatic reminder under a new name.
  4. `the button still works, because that is the only way left` — `sarraf_remind_debtor`
     sends exactly one.
- `RELEASE.md` — records that `202609020012` was built and then reversed by `202609020015`.

**Deliberately NOT done, and correctly so:** reminders already sent are **not deleted**.
They are notifications real people received; deleting them to match a later decision would
be rewriting history.

**What remains for you:**
1. **Fault-injection proof — THIS WAS NOT DONE, and the work is not finished without it.**
   Comment out the `drop function` line in `202609020015`, re-run
   `ZEMAN_DB_STRICT=1 npm run verify:accounting`, and confirm check #1 above **fails**. Then
   restore the line and confirm it passes. A guard that has never been seen to fail is not a
   guard. Do the same for checks #3 and #4. Until you have done this, the four green checks
   are an assumption, not evidence.
2. Confirm the UI still offers the manual button and that nothing in `src/` or `api/` still
   references `sendDueDebtReminders` or `sarraf_send_due_debt_reminders` outside migration
   `202609020012` (which is history and must not be edited) and `202609020015`.
3. `npm test` · `npm run build` · `npm run verify:source` · `verify:accounting` ·
   `verify:roles` · `verify:i18n`.
4. Commit, push, PR, merge.
5. **The live database still has the sender.** Applying `202609020015` to production
   requires the owner's explicit consent (§22). Ask for it; do not apply it silently.

---

### کاری ٢ — #87: قاسەی کڕیار — «لە قاسەی گشتیدا دیارە، بەڵام هی ئەوە» *(BLOCKED ON 5 RED CHECKS)*

**What the owner said, in their own words:**

> «ئەکاونتی کڕیار... دەبێت پارەکە بۆ قاسەی گشتیش زیاد ببێت و بۆ قاسەی ئەویش، بەڵام لە
> وردەکاری قاسەی گشتیدا ئاماژەی پێبدات کە لای ئەوە و پارەی ئەوە و من نەتوانم مامەڵەی پێوە
> بکەم، بەڵام کاتێک شتی لە من کڕی ئۆتۆماتیکی پارەکە لەو بەشەی خۆی ببات.»

and, crucially:

> «ئاگادار بە — نەک دەبێت هەر لە قاسەی گشتی بێت، دەبێت لە قاسەی خۆشی بێت.»

This is brief §11, and it has **two halves**.

**Half one — DONE and green** (`202609020013`, committed as `d32eef4`):
- `ledger.customer_id` column + index.
- Customer money is added to the general safe **and** named as that customer's, and is
  **excluded from both balance readers** so the owner can see it but cannot spend it.
- The snapshot's `owner_safe_by_currency` gains `and customer_id is null`, and a new
  `customer_held_by_currency` is exposed.
- `calc.customerHeld` is plumbed into the UI and rendered in `CurrencyBreakdown`;
  `calc.ownMoney` is preferred by `mySafe`.
- Its checks pass: *"a customer's deposit reaches the general safe the owner actually looks
  at" · "and it is named as theirs, not left as an unexplained rise" · "the owner's own safe
  does not rise by a customer's deposit" · "the snapshot's own owner-safe figure leaves the
  customers' money out too" · "a trade cannot be funded with a customer's money"*.

> ⚠️ **Migration technique used, and you must follow it.** `202609020013` does **not**
> restate a function body. It reads the **live** definition with `pg_get_functiondef` and
> performs surgical text substitutions on it, then re-executes. Precedent: `202608210002`.
> **Every substitution must be asserted to have found something, or the migration raises.**
> A guard must key on a marker only the change introduces — an early version of
> `202609020013` guarded on `position('customer_id' in v_src) > 0`, which was **already
> true** because `customer_id` was a parameter name, so the migration silently skipped
> itself while every check failed. It was corrected to `position('customer_in' in v_src)`.
> Learn from that: **choose a marker that cannot pre-exist.**

**Half two — WRITTEN BUT UNPROVEN** (`202609020014`, committed as `2a31df0` marked WIP):
- Adds `sarraf_take_sale_from_vault(p_tx_id, p_customer_id, p_currency, p_amount,
  p_command_key, p_actor_id, p_date)` returning the amount taken.
- It updates the vault, writes a `customer_vault_events` row of kind
  `transaction_settlement`, writes a `customer_out` ledger row, and posts
  `sarraf_post_simple_entry(... 'acc-2000','acc-1000' ...)` to cancel the cash debit the
  sale creates.
- It is called from inside `sarraf_commit_transactions` immediately after the settlement
  row, guarded by `if v_type='sell' and not v_direct and v_cp is not null then`.

**⚠️ THE PROBLEM YOU MUST SOLVE:**

Five checks in `verify:accounting` fail. **They fail on fixtures, not (as far as anyone has
proven) on the feature.** The exact errors:

```
sale would create negative inventory      ×4
cash location has insufficient balance    ×1
```

What has already been tried and did **not** work:
- A bare `insert into public.ledger(...)` row to stand up inventory. Rejected — a sale is
  priced against **weighted-average cost**, and cost comes from a *recorded purchase*, not
  a ledger row.
- Replacing it with a real `sarraf_commit_transactions` buy of 20,000 IQD for 3,000 USD.
  Still failed.
- A diagnostic probe — but it was run against a **fresh empty database** and returned
  `usd owner-spendable: 0, usd drawer: 0`, which reflects the empty DB, not the state
  during the gate run. **It diagnosed nothing. Do not repeat that mistake.**

**How to actually diagnose it:** instrument the gate itself. Immediately before the failing
`sellTo(...)` call inside `verify-accounting-db.mjs`, print the real USD main-safe balance
and the real IQD inventory *at that point in the run*. Then you will know whether the fixture
never funded the safe, whether an earlier check consumed it, or whether
`sarraf_take_sale_from_vault` is genuinely wrong. Note also: selling **CNY** needs a custody
partner (it is an external currency), and selling **IQD** needs IQD inventory from a
recorded purchase.

**⚠️ AND A REQUIREMENT THAT IS NOT BUILT AT ALL.** Brief §11 says:

> «ئەگەر باڵانس لە بڕی مامەڵە کەمتر بوو، هەموو باڵانسەکە بەکاربهێنرێت و **ماوەکە ببێتە قەرز**.»

`202609020014` takes what the customer has and never more — but **it does not turn the
remainder into a debt.** That is a real gap against the brief and must be built, with its
own checks. The same rule appears again in §15 for partners
(«ئەگەر باڵانس کافی نەبوو... ماوەکە ببێتە قەرزی هاوبەش») — check whether that one is built
either, and do not assume it is.

**Do not mark #87 done until:** the 5 checks are green, the remainder-becomes-debt rule is
built and proven, and each new guard has been shown to fail when removed.

---

### کاری ٣ — #89: مامەڵەی عمولە — خانەی هەقی کار، و بۆ کێ کراوە

**What the owner said:**

> «مامەڵەی عمولە — لە کوێوە دەردەچیت و بۆ کوێ دەچێت یەکسانە بڕەکەی، بەڵام دەبێت
> چوارگۆشەیەکی تر هەبێت، کە بڕێکی تێدا دابنێم، هەقی ئەم ئیشە... وە ئاماژە بەوەش بکەم کە
> بۆ چ کەسێکی دەکەم.»

A commission trade moves the same amount in and out — that part is right. What is missing
is **a separate box for the fee ZEMAN earns for doing the work**, and **naming the person it
was done for**. This is brief §15 and §12.

**⚠️ A comment you must correct.** Migration `202609020005` is named
`the_fee_model_that_was_a_misreading.sql` and contains the assertion **"There is no separate
fee"** — written by a previous agent, and **wrong** against the owner's words above. Do not
edit that already-applied migration's SQL; write a new one, and correct the claim wherever
it is repeated in `RELEASE.md` or code comments.

Existing scaffolding you can build on: `txs.business_flow = 'commission'` already exists, and
`202609020009_the_commission_is_a_number_you_choose.sql` already lets the owner name a
partner commission amount with checks for negative / oversized / non-numeric / refused-writes-
nothing. Read those before adding anything.

Requirements to satisfy, from §15:
- Owner sets the commission when the partner account is created; owner **and staff** can
  change it later; a specific transaction can override it; **old rate, new rate and who
  changed it are recorded.**
- Money arriving in a partner's Alipay/WeChat account carries a commission. Worked example
  from the owner: **1,000 CNY in at 1% → record 990 CNY as available balance and 10 CNY as
  partner commission, visibly and separately.**
- **When the partner sends money out, do NOT take a second commission.**

Also relevant, already learned and not to be re-derived: a commission paid in CNY makes the
owner's own CNY go negative, and **that is arithmetically correct** — there is a check
*"a commission paid in yuan leaves what is owned equal to what is held"* that proves it. Do
not "fix" it. The label on the UI column was corrected once already from «بە دەست دانراو» to
«جیاواز لە ڕێژەی ئێستا», because the first could not actually distinguish a hand-set
commission from a later change to the stored rate — **be that careful with wording.**

---

### کاری ٤ — #88: مامەڵەی ڕاستەوخۆ لە چەند کەسێکەوە بۆ یەک کەس

**What the owner said:**

> «جۆرێکی دیکەی مامەڵەی ڕاستەوخۆ هەیە کە لە جیاتی ئەوەی لە یەک کەسی بکڕم، لە چەند
> کەسێکی دەکڕم و بەڵام بە یەک کەسی دەفرۆشم.»

**The blocker, already located:** `sarraf_commit_transactions` **hard-refuses anything but
exactly 2 rows** for a direct pair. Buying from several sellers and selling to one buyer
needs N+1 rows in one atomic command.

This is the largest of the five and touches the protected accounting boundary
(weighted-average cost across several purchase legs). Therefore:
- Do **not** redesign the cost formula. Compose the existing one across legs.
- The whole thing must stay **atomic and idempotent** under one command key (§12, §22).
- Every leg needs its own counterparty, its own rate, its own audit trail, and the customer
  portal must show «پارەکە کێ دەیدات» correctly for a multi-leg trade (§10).
- Prove it with checks that a partially-committed multi-leg trade is impossible.

---

### کاری ٥ — #91: پشکنینی ٢٨ بەشەکە و ماتریکسی داواکارییەکان

This is brief §28 and the closing "دۆخی سەرەتایی و یاسای جێبەجێکردن" section, and it is a
**deliverable in its own right**, not a summary you write at the end from memory.

Go through all 28 sections. For **every** requirement, produce a row:

| # | داواکاری | دۆخی پێشوو | گۆڕانکاری | فایل/migration | تاقیکردنەوە | ئەنجامی browser/API/DB | بلۆککراو بە |
|---|---|---|---|---|---|---|---|

Rules for filling it in:
- **"Code exists" is not evidence. "A migration exists" is not evidence. "A test exists" is
  not evidence. "A comment says done" is not evidence. "A previous agent claimed it" is not
  evidence.** Only an end-to-end run you performed is evidence.
- A requirement that is genuinely already satisfied by good existing code may be kept — but
  you must have proven it yourself, and the row must name the proof.
- Anything blocked on the missing PDF, on a credential, or on owner consent goes in the last
  column and is **not** marked done.
- Write it to a file in the repository (e.g. `docs/REQUIREMENT_MATRIX.md`) and commit it, so
  the owner can read it after travelling.

---

## 5. پێوەری بەڵگە / THE STANDARD OF PROOF

This project has a specific, hard-won standard. Follow it.

### Fault injection is the standard of proof
**Every guard must be shown to fail when it is removed.** Write the check, watch it pass,
then break the thing it protects and watch it fail, then restore. A check that has only ever
been green proves nothing. This has already caught **three weak tests** in this repository:
- *"every screen is one press away"* accepted **any** button as reachability — which is why
  قاسە, نرخی ڕۆژ and بەستنی ڕۆژ were hidden with the gate green.
- an inbox assertion matched an unrelated `isNavActive` string.
- *"the counts are read, not stored"* asserted **code shape** instead of the actual property.

And an entire migration: `202609020013` silently skipped itself while every dependent check
failed, because its guard matched a string that already existed.

### The seventeen gates
```
npm test                     # 910 unit tests
npm run build                # vite production build
npm run verify:brand         npm run verify:share       npm run verify:search
npm run verify:production    npm run verify:source      npm run verify:accounting
npm run verify:roles         npm run verify:flows       npm run verify:receipts
npm run verify:isolation     npm run verify:names       npm run verify:i18n
npm run verify:journey       npm run verify:scale       npm run verify:bundle
npm run verify:inspect
```
- `verify:accounting` needs a real PostgreSQL. It starts its own via
  `scripts/lib/zeman-db.mjs`. Run it as `ZEMAN_DB_STRICT=1 npm run verify:accounting` so it
  **fails** rather than skips when postgres is unavailable. Currently 383 checks.
- **⚠️ Do not run two browser gates concurrently.** `verify:roles` failed twice for exactly
  this reason and cost real time chasing a defect that did not exist. Run serially; it
  passes 82/82.
- The CI check that gates merges is called **`verified`**.

### Diagnosing against the right database
When a database check fails, instrument **the gate run itself**. Probing a fresh empty
database tells you about an empty database and nothing about your failure. This mistake has
already been made once on work item #87.

### Don't repair a broken reader — ask whether it should exist
`readModelProfitMap` read fields the server never sent (`x.direct`, `x.amount` instead of the
real `cur_id` / `profit` / `direct_profit`). Every shared total came back 0, every direct one
was discarded, and because an empty object is truthy the fallback never ran — so
«قاسەی تایبەتی خۆم» was short by **all** profit. The live figure was 65,103.29 USD where the
browser showed 65,000: the missing 103.29 was the owner's entire profit. It was **deleted
rather than repaired**, because it answered a 30-day window question with all-time figures.
Be willing to delete.

### One derivation, one place
The receipts screen had a **second copy** of the batch-stage derivation while a comment
claimed there was one shared helper. Both now call `batchStage` from
`src/services/todaysWork.js`. When you find a duplicated derivation, collapse it — and check
the comment was not already lying about it.

### Never infer outcome from message text
Do not detect success or failure by searching for localized strings. Assert on structured
results, counts, rows, and status columns.

---

## 6. کاری خاوەن بە تەنها / OWNER-ONLY, STILL OPEN

Report these to the owner. **You cannot do them.** Do not pretend they are done.

1. **🚨 ڕۆتەیتی وشەی نهێنی داتابەیس — پێش فرۆشتن.** Two live database passwords were exposed
   in chat earlier in this project. **They must be rotated in Supabase → Settings → Database,
   and `SUPABASE_DB_URL` in GitHub Secrets updated, before the system is sold.** The source
   tree and CI logs are clean — the exposure was in conversation only. **Do not print the
   passwords anywhere, in any file, commit, PR or log.** Only the owner can rotate them.
2. **Branch protection** on `main`, requiring the `verified` check.
3. **`own-watan` MFA** — though note brief §6 says 2FA is not required this phase; confirm
   with the owner which stands.
4. **Set the USD→CNY rate**, then finish the two draft journal entries `mtc4exnjokonia` and
   `mtcr13cvgpfdg9`.
5. **Decide about 85 unreferenced Storage files** — do not delete them on your own judgement
   (§23: هیچ live data deletion ـێک بە گومان ئەنجام مەدە).
6. **`OWNER-DISCOVERY-001`** remains open.
7. **The ZEMAN logic PDF.** §1 makes it the source of truth and it does not exist on this
   system. Ask for it. Until it arrives, mark PDF-dependent questions as blocked rather than
   guessing.
8. **Consent for the live application of `202609020015`** (and any other migration).

---

## 7. Git، PR و ڕاپۆرت / WORKING AGREEMENT

- **Branch:** `claude/check-fish-sections-i68xu7`. Develop, commit and push **only** here.
  Create it from the default branch if it does not exist. Never push elsewhere without
  explicit permission.
- **Push:** always `git push -u origin claude/check-fish-sections-i68xu7`. On network
  failure retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s).
- **The owner does not merge. You do.** Open the PR, wait for the `verified` check to be
  green, and merge it yourself. This is the owner's standing instruction.
- **If the PR for this branch has already been merged**, do not stack new commits on merged
  history. Restart the branch from the latest default branch under the same name and open a
  **new** PR.
- **Commit messages** are English, describe the behaviour changed and — importantly — record
  anything a future reader would otherwise waste time re-discovering. (Precedent: the fact
  that `verify:roles` fails only when two browser gates run concurrently was written into a
  commit specifically so nobody would hunt a non-existent defect again.)
- **Merge conflicts:** resolve them by merging the base branch in and verifying the resulting
  tree, not by force-pushing over someone else's work. Precedent: PR #137 conflicted because
  #136 had been squash-merged; it was resolved by verifying the merge tree hash matched the
  known-good tree exactly.
- **Progress reports to the owner: Sorani Kurdish**, short, and honest about what is proven
  versus what is merely written. Say «نەپشتڕاست کراوە» when that is the truth.

---

## 8. کورتەی هەنگاوەکان / YOUR FIRST HOUR

1. Read this whole document. Read `git status` and the diff. **Delete nothing.**
2. Read `RELEASE.md`, `ACCOUNTING_MATRIX.md`, `AUDIT_REPORT.md`, `SECURITY.md`,
   `supabase/INSPECT.sql`, and `scripts/verify-accounting-db.mjs` — that last file is the
   real specification of the accounting behaviour.
3. Ask the owner for the PDF (§1) and for consent on the live `202609020015` migration.
   **Then keep working — do not block on the answer.**
4. Finish **کاری ١** (§13 reminder removal): fault-inject, verify, commit, push, PR, merge.
5. Diagnose **کاری ٢** (#87) properly by instrumenting the gate, fix the 5 red checks, then
   build the missing «ماوەکە ببێتە قەرز» rule.
6. Then #89, then #88.
7. Build the requirement matrix (#91) **as you go**, not at the end.
8. Never stop. If the limit is reached, resume when it returns.

**«من مەخەڵەتێنە بەو ردی بیکە.»** — Do not deceive me; do it carefully.
