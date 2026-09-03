# Release readiness — ZEMAN

Records what was proved, how it was proved, and — with equal weight — what is still open and
who can close it.

The claim this document supports is narrow and deliberate: **the software is ready; the
installation is not, until the items in "Only the owner can do these" are done.** Nothing here
rests on a successful build or on unit tests alone.

**Last brought up to date: 2 September 2026**, against `main` at `1a1dfef` with every migration
through `202609020002` applied. Live evidence comes from three GitHub Actions runs against the
production database that day: migrate run **58**, and inspect runs **`33593609457`** and
**`33619163513`** — the second taken after section 13 was added.

---

## 1. The evidence chain

Each link is a gate that runs in CI and fails the `verified` check if it breaks.

| Layer | Gate | What it runs against | Scope |
|---|---|---|---|
| Source contracts | `verify:source` | the repository | route/tenant rules, credential shapes |
| Brand, share, search, readiness | `verify:brand` `verify:share` `verify:search` `verify:production` | the repository | — |
| Free variables | `verify:names` | the repository | every handler |
| Three languages | `verify:i18n` | the repository | no untranslated string, no alias |
| Unit and service tests | `npm test` | pure modules | **890 tests** |
| Accounting contracts | `verify:accounting` | real migrations, real PostgreSQL | **344 checks** |
| Business flows | `verify:flows` | real migrations, real PostgreSQL | **25 flows, 152 steps** |
| Receipt reliability | `verify:receipts` | real migrations, real PostgreSQL | **35 checks** |
| Tenant isolation | `verify:isolation` | real migrations, real PostgreSQL | **123 checks** |
| Query plans at volume | `verify:scale` | seeded volume, 20,000 rows | **16 opening queries** |
| The inspection itself | `verify:inspect` | real migrations, `auth.uid()` unset | **29 sections** |
| Per-role interface | `verify:roles` | Chromium, dev server, 1280×900 **and 390×844** | **82 checks** |
| The receipt's journey | `verify:journey` | Chromium + real PostgreSQL | **22 checks** |
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
- **The direct trade** — «مامەڵەی ڕاستەوخۆ ( خێر ٪١٠٠ بۆخۆم و لای کەس هەڵناگیرێ )». The owner
  named three flows they do every day; two of them were executed end to end here and the third
  was not. The accounting gate checked that a direct pair is *labelled* `owner_cashbox`, but it
  did that by inserting two rows into `public.txs` by hand — proving the label and nothing about
  the money. Business flow 25 runs the owner's own command and then asks both halves of the
  sentence: the profit is the whole spread with no partner rate taken out of it, and no ledger
  row the trade wrote names a partner, an office or an account.

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

## 2d. The manager's own screen

`sarraf_manager_overview` — the administrators, the counts by role, and the last fifty changes
across the whole installation — has answered **since 202608230001, and nothing had ever read
it.** A command that exists on the server and cannot be reached from any screen is a feature
that was paid for and never built; the reachability rule added to `verify:source` is what turned
it up.

It is now «سیستەم بە گشتی», the first entry under **دامەزراندن**, and it shows **no figure of
money at all**. A manager sells and maintains the installation and belongs to no business, so
every amount on that screen would be an amount out of somebody else's books. Two checks in
`verify:isolation` hold it there — it may not report an amount, a total, a balance, a profit, a
rate, a cashbox or a debt, and a business owner may not open it at all — and a test pins the
component's service imports so the screen cannot quietly start reading more than it should.

A view nobody opened is a view nobody audited. Both facts were true of this one until today.

## 2e. Every command on the server, accounted for

216 functions are declared across the 112 migrations. Each one was traced to something that
runs it — the browser, an API route, another function's body, a trigger, or a gate — and the
inventory comes out as follows.

**Four are called by nothing anywhere.** They are named in `verify:source` with the reason, so
the list is reviewed rather than assumed, and a fifth fails the gate:

| command | why it is still there |
|---|---|
| `sarraf_confirm_receipt_match` | superseded by `sarraf_convert_receipt_batch_to_transaction` (202608280024) |
| `sarraf_current_role` | a helper from the legacy baseline; role checks go through `sarraf_self_profile` |
| `sarraf_rate_limit_sweep` | a maintenance sweep with **no scheduler behind it** — see below |
| `sarraf_set_tenant_rate` | superseded by `sarraf_set_receipt_daily_rate`, which is what the rates screen calls |

**None of them has been dropped.** Removing a function from a live database is a destructive
change, and this is not the kind of finding that justifies one unasked. Three are simply dead
weight. The fourth is a decision for the owner: `sarraf_rate_limit_sweep` exists to clear old
rate-limit rows and nothing calls it, so **that table grows without bound**. It is small and
slow-growing, and the choice is between scheduling the sweep and deleting the function — not
between doing nothing and doing nothing.

## 2f. Not "does it name a business?" but "does it name the right one?"

Section 3 of `INSPECT.sql` counts rows whose `tenant_id` is null, and section 4 says whether any
are still being made. Neither can see the more dangerous shape: a row carrying the **wrong**
tenant. It satisfies every not-null constraint, passes both existing sections, and puts one
business's money inside another's books.

Section 13 asks that question of seven parent-child relationships — ledger against its
transaction, journal entries against their transaction and their batch, receipts against their
batch, and transactions and batches against the people they name.

**All seven read zero on the live database** (inspect run `33619163513`, 2 September 10:23 UTC):

```
| child → parent                    | disagree |
| journal_entries → receipt_batches |        0 |
| journal_entries → txs             |        0 |
| ledger → txs                      |        0 |
| receipt_batches → its customer    |        0 |
| receipts → receipt_batches        |        0 |
| txs → its counterparty            |        0 |
| txs → its partner                 |        0 |
```

It is asserted in `verify:inspect` as well as printed, because a number a person has to notice
is a number nobody notices on the morning it first stops being zero. Proved by planting one
ledger row whose transaction belongs to another business: `1 row(s) sit in a different business
than their parent`.

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
no table, no constraint and no column. The 344 accounting contracts and 25 business flows are
what prove the results did not move.

### 5b. What the owner's correction did change, on purpose

The owner read the finished system and said several things had been misunderstood. Those are
changes to what the system does, not refactors, and they are listed here rather than left to be
inferred from a diff.

- **`202609020003` — مامەڵەی عمولە.** A fourth `business_flow`, two new nullable columns on
  `txs` (`from_account_id`, `to_account_id`), and one new command. The unnamed
  `check (cur_id <> against_id)` the table has carried since the legacy baseline is replaced by a
  named constraint carrying the same rule plus the commission exception. Ordinary trades are
  unaffected: every one of the 25 business flows still produces the same result.
- **`202609020004` — money enters a named place.** `sarraf_post_ledger_command` now honours
  `cash_account_id`, a column `ledger` has carried since `202609010011`. A row that names no
  place is the cash, which is what every row written before this meant, so nothing existing
  changes meaning. It also **corrects a defect**: the sufficiency check summed every row of a
  currency, which was the cashbox exactly while nothing had ever named an account, and would
  have let a cash withdrawal be funded by money sitting in a bank the moment one did. On the
  live data both readings return the same number for every currency.
- **`202609020005` — `sarraf_service_transaction` dropped.** It modelled a principal plus a
  separate fee, which the owner said was a misreading. Only the command is dropped. Every ledger
  row, journal entry and audit line any past service wrote stays where it is and keeps
  reconciling.
- **`202609020006` — a debt can be paid.** The register could offset and forgive; it could not
  record money actually moving. Settlement goes through `debt_settlements`, which already owns
  the debt's balance and status, so there is one path for a payment and not two.
- **`202609020007` — a debtor can be told.** One new notification kind, and a narrow insert
  policy so the command that writes it — which runs as `sarraf_definer`, not as the superuser
  every notification trigger before it used — may write inside its own tenant and nowhere else.
- **`202609020008` — a refused receipt can be put away.** Two transitions added to
  `receipt_transition_allowed` (`rejected`→`cancelled`, and the three other refused states →
  `cancelled`), and one command that only the person who sent a receipt may run, only on one
  that was refused. Nothing is deleted: the row, the reason and every state it passed through
  stay, so the owner can still count how many a person has had refused.
- **`202609020009` — the commission is a number the owner chooses.** `app_users.rate` becomes a
  default rather than a rule: a purchase may carry `partner_fee`, and when it does that is what
  the partner is paid, in the balance check, the transaction snapshot and the ledger row alike.
  `partner_rate_snapshot` becomes the percentage actually charged rather than the one on file,
  so `amount × rate ÷ 100` always lands on the fee that was taken. A purchase that names no
  commission behaves exactly as before.
- **`202609020010` — an expense says which safe it came out of.** A new `ledger.paid_from`
  column (`general` / `own`), written by expenses only, and the snapshot reports the split
  beside the total it already reported. Every existing row stays null, and null keeps meaning
  what every screen already does with it — the owner's own — so no figure moves. **What this
  deliberately does not do** is change how an expense is shared out: whether an expense from
  the general safe should reduce the investors' share of profit as well as the owner's is a
  decision about their money and is the owner's to make. The mark is recorded and shown; the
  arithmetic waits on the answer. **The owner has since answered: yes, in proportion to what
  each of them has in.** So a general-safe expense is now a negative event in the same pool the
  sales earn into, shared by the capital standing on the day it was paid — the same rule, and
  the same module, that shares a sale. An expense from the owner's own safe, and any expense
  recorded before the column existed, stay the owner's alone.
- **`202609020011` — «قاسەی تایبەتی خۆم» becomes a number the server knows.** It had only ever
  been a subtraction done in the browser, which is fine for a figure on a screen and impossible
  for a rule. `sarraf_owner_own_money` is the same definition in SQL, and `sarraf_investors_share`
  is the capital-weighted half of it. Two implementations of one number is a real hazard and is
  answered the only honest way: `verify:accounting` runs the database's own accumulated state
  through both — the SQL, and the browser's `investorShare.js` imported into the gate — and
  fails unless they agree to the last unit. The snapshot carries the figure so the screens read
  the server's answer rather than their own.

  It also **corrects a defect**. `readModelProfitMap` read `x.direct` and `x.amount` from the
  snapshot's profit rows, which carry `cur_id`, `profit` and `direct_profit` and never had
  either field. Every shared total came back zero and every direct one was thrown away, and
  because an empty object is truthy the fallback to the transaction walk never ran. «قاسەی
  تایبەتی خۆم» was therefore short by every unit of profit the owner had ever earned, and went
  negative as soon as the investors' share passed the capital — the ownership panel and the
  dashboard's «ماڵی خۆم» are the same figure and were wrong with it. The reader is deleted
  rather than repaired: it is a 30-day window and these are all-time figures, so fixing the
  field names would have traded a visible bug for a quiet one.
- **The owner's own money in a currency can be negative, and that is right.** The live report
  shows CNY at −493.29: the partners' commissions are paid in yuan while the capital and the
  profit are counted in dollars, so per currency the yuan side carries a cost and no income.
  It looks like a defect and is not, and the answer is measured rather than argued.
  `verify:accounting` builds the exact shape — 14,000 dollars in, 100,000 yuan bought, 500 yuan
  of commission taken out — and asks whether what everybody owns still equals what the business
  holds. It does, to the unit. Take that cost out of the owner's yuan, which is the change the
  question was asking for, and the books credit the owner with 14,000 while the business holds
  13,930: seventy dollars that do not exist. So the arithmetic stands unchanged and only the
  presentation was fixed — the safes screen now says in one sentence what a minus sign there
  means, because a right number with no explanation beside it gets reported as a bug.
- **A direct trade and a commission trade say when they exceed the owner's own money.** «تەنها
  مامەڵەی ئاسایی پارەکەی لە قاسەی گشتییەوەیە، ئەوانی دیکە هی خۆمە تەنها.» The sufficiency check
  can never catch this: a direct pair buys and sells in one command, so its net effect on the
  safe is the profit and never a withdrawal. Both screens now show «قاسەی تایبەتی خۆم» for the
  currency being spent and say plainly when the trade goes past it. **It is a warning, not a
  refusal**, and deliberately: the figure it is said from was wrong on every screen until the
  defect above was fixed, so nobody has yet seen a true one to plan against, and refusing a
  trade on a number the owner has never been shown would be the worse mistake. Whether it
  should become a refusal is theirs to decide once they have watched it on real data.

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
- **It is not a claim that the interface has been used in anger.** The owner's corrections were
  built and gated, and `verify:roles` and `verify:journey` drive them in a real browser. Nobody
  has yet run a day's real trading through the rebuilt قاسە, receipts and debt screens.
- **Two trades are still outside the books.** `mtc4exnjokonia` and `mtcr13cvgpfdg9` remain draft
  journal entries awaiting a USD→CNY rate. The trial balance in §2 balances without them, which
  is exactly why they must be finished rather than forgotten: the books are consistent and
  incomplete at the same time.
