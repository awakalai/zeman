# Release readiness — ZEMAN

Written at the end of the 24-section production-readiness pass (§17–20). It records what was
proved, how it was proved, and — with equal weight — what is still open and who can close it.

The claim this document supports is narrow and deliberate: **the software is ready; the
installation is not, until the five items in "Only the owner can do these" are done.** Nothing
here rests on a successful build or on unit tests alone.

Live evidence in this record comes from two GitHub Actions runs against the production database
on 1 September 2026: migrate run `33498339879` and inspect run `33498691720`.

---

## 1. The evidence chain

Each link is a gate that runs in CI and fails the `verified` check if it breaks.

| Layer | Gate | What it runs against | Scope |
|---|---|---|---|
| Source contracts | `verify:source` | the repository | route/tenant rules, credential shapes |
| Brand, share, search, readiness | `verify:brand` `verify:share` `verify:search` `verify:production` | the repository | — |
| Free variables | `verify:names` | the repository | every handler |
| Three languages | `verify:i18n` | the repository | no untranslated string, no alias |
| Unit and service tests | `npm test` | pure modules | **792 tests** |
| Accounting contracts | `verify:accounting` | real migrations, real PostgreSQL | **303 checks** |
| Business flows | `verify:flows` | real migrations, real PostgreSQL | **23 flows, 138 steps** |
| Receipt reliability | `verify:receipts` | real migrations, real PostgreSQL | **23 checks** |
| Tenant isolation | `verify:isolation` | real migrations, real PostgreSQL | **95 checks** |
| Query plans at volume | `verify:scale` | seeded volume | index and policy shape |
| Per-role interface | `verify:roles` | Chromium, dev server | **57 checks** |
| The receipt's journey | `verify:journey` | Chromium + real PostgreSQL | **22 checks** |
| The bundle that ships | `verify:bundle` | Chromium, `dist/` under vercel.json headers | **8 checks** |

`verify:bundle` was added last and closes a gap the others left open. Every other browser gate
boots the Vite dev server, which serves unbundled modules and none of the deployment headers;
`npm run build` proves only that Rollup did not throw. The artifact customers load had never
been opened in a browser, and the Content-Security-Policy in `vercel.json` had never been
applied to it. The gate was verified by breaking it on purpose — setting `script-src 'none'`
made 5 of its 8 checks fail, including the boot check — and then restoring the file.

## 2. What the live database says

From inspect run `33498691720`, after all migrations applied:

| Question | Answer | Required |
|---|---|---|
| Trial balance | 157,683.052754 debit = 157,683.052754 credit, difference **0.000000** | 0 |
| Financial tables with a row belonging to no business | **0** across txs, ledger, journal_entries, receipts, receipt_batches, receipt_state_transitions, zeman_notifications | 0 |
| SECURITY DEFINER functions a signed-out browser may call | **0** (was 19) | 0 |
| Tables that can be written past their own policies | **0** | 0 |
| Applied migrations missing from the Supabase ledger | **0** (was 44) | 0 |
| Storage bucket public | **false** | false |
| Receipts stuck mid-upload | **0** (5 were, now recorded `upload_failed_retryable`) | 0 |

**On the 23 definer functions not owned by `sarraf_definer`.** This number looks alarming and is
not. Sixteen are trigger functions: PostgreSQL checks EXECUTE when a trigger is created and
never when it fires, so nobody can call one and ownership decides nothing. Seven are named
exceptions in `verify:isolation` — four consulted from inside policies (a policy helper that is
itself bound by policies recurses into the table it is being asked about) and three the server
calls with its own key and no user attached. The count that matters is **unexplained = 0**, and
`INSPECT.sql` now reports the three columns separately rather than one bare total.

## 3. Only the owner can do these

None of these can be done from the repository. Each is a real blocker for selling the system.

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
posts literally the same statements as a live trade. The 303 accounting contracts and 23
business flows are what prove the results did not move.

No history was deleted, no posted row modified, no migration rewritten, no RLS disabled.
