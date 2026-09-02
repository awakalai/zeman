# Release readiness — ZEMAN

Records what was proved, how it was proved, and — with equal weight — what is still open and
who can close it.

The claim this document supports is narrow and deliberate: **the software is ready; the
installation is not, until the items in "Only the owner can do these" are done.** Nothing here
rests on a successful build or on unit tests alone.

**Last brought up to date: 2 September 2026**, against `main` at `912b0be` with every migration
through `202609020002` applied. Live evidence comes from two GitHub Actions runs against the
production database that day: migrate run **58** and inspect run **`33593609457`**.

---

## 1. The evidence chain

Each link is a gate that runs in CI and fails the `verified` check if it breaks.

| Layer | Gate | What it runs against | Scope |
|---|---|---|---|
| Source contracts | `verify:source` | the repository | route/tenant rules, credential shapes |
| Brand, share, search, readiness | `verify:brand` `verify:share` `verify:search` `verify:production` | the repository | — |
| Free variables | `verify:names` | the repository | every handler |
| Three languages | `verify:i18n` | the repository | no untranslated string, no alias |
| Unit and service tests | `npm test` | pure modules | **886 tests** |
| Accounting contracts | `verify:accounting` | real migrations, real PostgreSQL | **317 checks** |
| Business flows | `verify:flows` | real migrations, real PostgreSQL | **24 flows, 147 steps** |
| Receipt reliability | `verify:receipts` | real migrations, real PostgreSQL | **35 checks** |
| Tenant isolation | `verify:isolation` | real migrations, real PostgreSQL | **121 checks** |
| Query plans at volume | `verify:scale` | seeded volume, 20,000 rows | **16 opening queries** |
| The inspection itself | `verify:inspect` | real migrations, `auth.uid()` unset | **28 sections** |
| Per-role interface | `verify:roles` | Chromium, dev server, 1280×900 **and 390×844** | **82 checks** |
| The receipt's journey | `verify:journey` | Chromium + real PostgreSQL | end to end |
| The bundle that ships | `verify:bundle` | Chromium, `dist/` under vercel.json headers | **8 checks** |

`verify:bundle` was added last and closes a gap the others left open. Every other browser gate
boots the Vite dev server, which serves unbundled modules and none of the deployment headers;
`npm run build` proves only that Rollup did not throw. The artifact customers load had never
been opened in a browser, and the Content-Security-Policy in `vercel.json` had never been
applied to it. The gate was verified by breaking it on purpose — setting `script-src 'none'`
made 5 of its 8 checks fail, including the boot check — and then restoring the file.

## 2. What the live database says

From inspect run `33593609457`, 2 September 2026 at 05:10 UTC, after `202609020002` was applied:

| Question | Answer | Required |
|---|---|---|
| Trial balance | 157,683.052754 debit = 157,683.052754 credit, difference **0.000000** | 0 |
| Where the money is — cashbox + partners + offices + accounts vs. the total | CNY 6,556.71 · USD 145,696.04 · difference **0.0000 for both** | 0 |
| A ledger row naming two holders at once | **0 rows** | 0 |
| A currency balance that has ever gone below zero | **none**, in any currency | none |
| Financial tables with a row belonging to no business | **0** across txs, ledger, journal_entries, receipts, receipt_batches, receipt_state_transitions, zeman_notifications | 0 |
| SECURITY DEFINER functions a signed-out browser may call | **0** of 185 (was 19) | 0 |
| Definer functions with no `search_path`, and unexplained ownership | **0** and **0** | 0 |
| Tables that can be written past their own policies | **0** | 0 |
| Applied migrations missing from the Supabase ledger | **0** (was 44) | 0 |
| Storage bucket public | **false** | false |
| Accepted receipts with no Order No. | **0** of 83 extractions | 0 |
| Commission posted to the spread account instead of fee income | **0** | 0 |
| Receipts stuck mid-upload | **0** (5 were, now recorded `upload_failed_retryable`) | 0 |

**The five documents whose image is gone are all `upload_failed_retryable`.** That is the owner's
own requirement holding in production, not in a test: «فیشێک لە کاتی ئەپڵۆدکردن ئیرۆر بدات،
پێویست ناکات بچێتە سیستەمەوە». An upload that errored has no file and never entered the books;
the receipt can simply be sent again.

**On the 23 definer functions not owned by `sarraf_definer`.** This number looks alarming and is
not. Sixteen are trigger functions: PostgreSQL checks EXECUTE when a trigger is created and
never when it fires, so nobody can call one and ownership decides nothing. Seven are named
exceptions in `verify:isolation` — four consulted from inside policies (a policy helper that is
itself bound by policies recurses into the table it is being asked about) and three the server
calls with its own key and no user attached. The count that matters is **unexplained = 0**, and
`INSPECT.sql` now reports the three columns separately rather than one bare total.

## 2b. The owner rounds, and what closed them

Every item below was closed by executing the owner's own sentence against a real database, not
by reading the code. Several were found only that way.

- **Receipt visibility in View As** — fixed and verified. `202609010008`; 9 checks in
  `verify:isolation`, 6 unit tests.
- **Negative CNY cashbox** — root cause established and made explainable (`202609010009`), and
  `public.ledger` now carries the holder dimension. The live reconciliation in §2 is the proof
  that it holds: cashbox + partners + offices + accounts equals the total, to the cent, in both
  currencies, with no row naming two holders.
- **Commission** — its own account (`acc-4100` fee income), never the spread account
  (`acc-4000`). Live: **0** rows posted to the wrong one.
- **Owner/office settlement** — money leaves the owner's cashbox and becomes the office's
  liability; «پارەکەت لای ئەم نووسینگەیەیە» reads it back.
- **Mandatory Order No.** — live: **0** accepted receipts without one.
- **Bulk release of up to 100 receipts** — the server decides which of a requested list the
  subject may actually have, as a WHERE clause rather than a check somebody must remember to
  repeat per row; every release writes one audit row.
- **A batch split between two partners** — «٣ دانەیان دەکەم بە مامەڵەیەک ... ٢ دانەکەی تریش لای
  هاوبەشێکی تر». Business flow 24 performs exactly that. It found a real defect: the second
  partner, holding 900 of 1,500, was told the batch was not theirs.
- **An upload that errored must not enter the system** — four checks in `verify:receipts`, and
  the live database shows the five affected documents sitting in `upload_failed_retryable` with
  no ledger effect.

**`OWNER-DISCOVERY-001` is open** — a transaction workflow awaiting verbal clarification. Nothing
has been assumed or built for it. **While it is open, the system as a whole is not ready for real
money, regardless of what the gates say.** See `ACCOUNTING_MATRIX.md`.

## 2c. The interface

The application had four navigation groups holding seven entries, with sixteen more screens in a
grid at the foot of one of them — two thirds of it reachable only through a drawer. It is now six
sections named for questions a person in this business actually has: **ئەمڕۆ · مامەڵە · فیش ·
پارە · خەڵک · ڕاپۆرت**. Nothing was removed; a screen is found by asking what it is for.

Six defects were found afterwards by **booting the application and measuring it** at 390×844 and
1440×950 — none of which any gate could have seen, because every browser check ran at 1280×900:

1. The six sections existed on the desktop only. The phone still flattened them into one
   unlabelled scroll of twenty entries behind «زیاتر» — the same drawer, on the device this
   business runs on.
2. `ZEMAN` rendered as «…AN» on every phone: five header buttons left the brand block 39 pixels
   for a word needing 55.
3. The «زیاتر» sheet grew past the height of the phone and pushed its own close button off screen.
4. The retired accent was still hard-coded in eight places, including the **second**
   `.nav-active` rule — the entry you are standing on — and the phone's floating action button.
5. That button, the largest control in the mobile application, had no accessible name at all.
6. The market ticker ran underneath the sidebar: `margin-inline-start` in a right-to-left
   interface is the *right* edge, and the sidebar is `fixed left-0`.

`verify:roles` now runs at 390×844 as well, and checks page-level geometry on the desktop:
**57 → 82 checks.** Each was proved by reintroducing its fault and watching the gate name it.

## 3. Only the owner can do these

None of these can be done from the repository. Each is a real blocker for selling the system.
**They have been open since 1 September and none has been closed.**

1. **Rotate the two database passwords.** Two live passwords were exposed in a working
   conversation during this project. Rotate in Supabase → Settings → Database, then update
   `SUPABASE_DB_URL` in GitHub → Settings → Secrets. Until this is done, treat the database as
   having a known credential. The source tree and CI logs are clean; the exposure was in chat.
2. **Protect `main`.** GitHub → Settings → Branches → add a rule for `main` requiring the
   `verified` status check and a pull request before merge. Every gate above exists to block a
   bad merge, and without this rule nothing enforces them.
3. **Enrol the second owner in MFA.** `own-watan` (وەتەن) has a login and no second factor,
   while their rank requires one. Only that person can enrol it, on their own phone.
4. **Finish the two draft journal entries — two steps, in order.** Transactions
   `mtc4exnjokonia` (27 Aug) and `mtcr13cvgpfdg9` (28 Aug) are completed trades whose
   double-entry records were never written, because CNY had no USD rate on those days.
   **First set the USD→CNY rate**, then press «تەواوی بکە». Pressing the button first refuses
   with *"no USD rate for this currency yet; set the rate first"* — by design, because posting
   an entry that cannot be valued would be worse than leaving the hole visible. The resolved
   lines are marked `rate_source = 'currency_mid_at_resolution'` so an auditor can see they were
   valued at a rate that arrived later than the trade.
5. **Decide about 85 unreferenced storage files (15 MB).** Leftovers from interrupted uploads,
   in a private bucket, referenced by nothing. Deleting them needs the Storage API and a
   verified, restorable backup first. They cost 15 MB and harm nothing; this is a tidiness
   decision, not a safety one.

## 4. Deliberately left alone

- **212 append-only rows that name no business** — in `receipt_ocr_attempts` (101),
  `receipt_extractions` (79), `system_event_log` (21) and `audit` (11). Their tenant cannot be
  derived from the row, and these are append-only records of what happened. Writing a guessed
  tenant into an audit trail is worse than a null. The trigger that stamps new rows is in place;
  the newest tenantless row in any of them predates it, which is the check that matters.
- **19 notes with no derivable parent** — same reasoning, no parent to derive from.
- **64 receipt documents naming a batch that does not exist** — `receipt_documents.batch_id` is
  a browser-supplied intake grouping, validated only as a string; it is not a
  `receipt_batches.id` and never was. A foreign key here would have refused every upload from
  the moment it was applied. Both columns now carry a `comment on column` in the database
  saying so, so the next person to read the schema does not add one.

## 5. What was not changed

No business logic, mathematical algorithm or workflow was altered, per the standing directive.
Buy/sell formulas, weighted-average cost, P&L, ledger maths, maker/checker, currency precision,
posted-entry immutability and the existing financial RPC contracts are untouched. The one
extraction — `sarraf_write_transaction_entry_lines` — moved the body of `post_transaction_journal`
into a function that both the trigger and the new resolution command call, so a resolved draft
posts literally the same statements as a live trade.

No history was deleted, no posted row modified, no migration rewritten, no RLS disabled.

The later rounds kept the same rule. `sarraf_partner_batch_detail` was re-declared so a batch
split between two partners shows each of them what they actually hold — a visibility change, not
an accounting one; the sums it reports come from the same columns as before. `202609020002` adds
no table, no constraint and no column. The 317 accounting contracts and 24 business flows are
what prove the results did not move.

## 6. What this document does NOT claim

Stated plainly, because a reader in a hurry will take silence for a guarantee.

- **It is not a claim that the system is ready for real money.** `OWNER-DISCOVERY-001` is open,
  and **all five** owner items in §3 are undone — most importantly the database passwords, which
  are still the ones that were exposed.
- **It is not a security audit.** No third party has reviewed this code, and no penetration test
  has been run against the deployment. What §1 proves is that the boundaries this system claims
  are the boundaries it has; it does not prove there is no boundary nobody thought of.
- **It is not a load test.** `verify:scale` checks that the opening queries keep their indexes at
  20,000 rows of history. Nobody has run this system under concurrent real traffic.
- **It is not a legal or compliance review.** Whether this installation satisfies the obligations
  of a money-services business in its jurisdiction is not a question any gate here answers.
- **Two trades are still outside the books.** `mtc4exnjokonia` and `mtcr13cvgpfdg9` remain draft
  journal entries awaiting a USD→CNY rate. The trial balance in §2 balances without them, which
  is exactly why they must be finished rather than forgotten: the books are consistent and
  incomplete at the same time.
