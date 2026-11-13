# ZEMAN enhancement batches

> **Recovery status — 2026-09-08**
>
> The deployed `main` line and earlier verified work had diverged. Recovery proceeds in a fresh
> branch from the latest verified production commit for every batch. The ordered source of truth is
> [RECOVERY_BATCH_PLAN.md](./RECOVERY_BATCH_PLAN.md). Entries below are retained as historical
> evidence and must not be read as proof that the entire product is complete.

## Recovery Batch 1 — deployed baseline stabilization

**Status:** Completed, merged, installed on the live database, and deployed to production.

### Completed

- Restored the missing owner assignment for `sarraf_action_inbox_v3(integer)` so the deployed
  Smart Inbox function uses the established restricted definer role rather than an accidental
  migration owner.
- Removed the unsafe office path from the general Smart Inbox. An office must use its dedicated,
  assignment-scoped portal; the shared receipt/transaction inbox is business-admin only.
- Scoped Party 360 and cash reconciliation to the authenticated actor's tenant on every source
  table, fixed multi-currency account aggregation, and assigned both functions to
  `sarraf_definer`.
- Added the five missing English/Arabic timeline labels that made the production unit suite fail.
- Kept the offline receipt-bundle refusal as a stable service error code and localized it at the
  UI boundary instead of embedding one-language user copy in a service.
- Applied and verified the live read-model migrations as
  `20260908013139_restrict_action_inbox_to_business_admins` and
  `20260908013215_tenant_scope_operational_read_models`. No ledger, journal, WAC, balance, or
  transaction row was mutated.

### Evidence

- Focused authorization, tenant, receipt-bundle, and i18n tests: **39/39 passed**.
- `npm test`: **940/940 passed**.
- `npm run verify:source`: passed across 400 tracked files, 132 migrations, and 4 service-key routes.
- `npm run verify:search`: passed.
- `npm run verify:i18n`: 633 requested keys have English and Arabic entries; the one-language
  interface ratchet no longer regressed.
- `npm run verify:names`: passed across 116 files.
- `npm run verify:brand`, `npm run verify:share`, and `npm run verify:production`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Live SQL inspection confirms all three functions are security-definer functions owned by
  `sarraf_definer`, are not executable by `public` or `anon`, and retain explicit body-level
  role/tenant authorization.
- Supabase advisors were recorded. The three new authenticated security-definer warnings are
  intentional RPC exposure with body authorization; the older project-wide advisor backlog is
  reserved for Recovery Batch 13 rather than mixed into this stabilization batch.
- GitHub PR #150 passed every required workflow job and was squash-merged to `main` as
  `f878889`.
- Vercel production deployment `dpl_4hM1mSUYfcAThtZdiqQa3TGYCU6C` reached `READY`; the
  deployed `version.json` returned HTTP 200 and no error/fatal runtime logs were reported for
  that deployment at release time.

### Preserved work

- The original dirty worktree and its partial office-payment reversal files were not changed.
- The earlier `codex/zeman-rebuild` commits remain reachable and will be reconciled in later
  batches instead of being overwritten or blindly merged.

## Recovery Batch 2 — account access and safe onboarding

**Status:** Completed, merged to production `main` as `da85610`, installed on the live database,
and deployed.

### Completed

- Replaced the manager's internal tenant-id/email/invitation workflow with one server request that
  creates the business, a working owner login, the owner profile, operational default settings,
  and the audit record together. A database failure removes the newly-created Auth user rather
  than leaving a login without a business.
- Standardized the user-facing login on normalized Iraqi phone number plus password while retaining
  the old short internal alias only as a compatibility path for existing accounts.
- Removed the second-factor gate in accordance with the chosen ZEMAN login policy. Authentication
  remains in Supabase Auth and authorization still comes from the active `app_users` role and
  tenant row on every protected route/command.
- Added owner/staff password recovery for ordinary customer, partner, investor, and office accounts;
  administrator resets remain rank-controlled and the password itself is never audited or returned.
- Replaced direct account deactivation with one server-only database command. It refuses the change
  while any per-currency account balance, customer available/reserved/pending funds, partner funds,
  open debt, office holding, partner/customer holding, or investor capital remains. A reason is
  mandatory and a successful deactivation and its audit row commit atomically.
- Preserved the deployed Party 360 route while resolving the account-screen changes; no WAC,
  journal, ledger, maker-checker, transaction, or posted financial behavior was changed.
- Installed the account migrations as `20260908201710_manager_creates_business_with_phone`,
  `20260908201717_password_sessions_are_the_chosen_login`, and
  `20260908201722_account_must_be_clear_before_deactivation`. CI then identified that the two new
  server-only commands still had PostgreSQL's row-level-security-bypassing owner; the corrective
  migration `20260909094834_server_only_account_functions_use_restricted_owner` moved both to the
  established restricted `sarraf_definer` role before merge.

### Evidence

- Focused account/onboarding/deactivation tests: **49/49 passed**.
- `npm test`: **941/941 passed**.
- `npm run build`: passed.
- Source, i18n, search, free-name, brand, share, and production-readiness gates: passed.
- Real-browser role verification: **80/80 passed** across administrator, customer, partner, office,
  investor, and administrator-mobile views; every tested role entered without an MFA screen.
- All three migrations passed live-schema transaction/rollback validation before installation.
- Live ACL inspection confirms business onboarding and clear-account deactivation are owned by
  `sarraf_definer` and are not executable by `public`, `anon`, or `authenticated`; only the
  server-side `service_role` can execute them.
- Supabase security advisors reported the existing project-wide warnings; neither new server-only
  function appeared as an authenticated executable security-definer finding.
- The local PostgreSQL accounting, tenant-isolation, and business-flow harnesses were unavailable in
  this runner; equivalent migration parsing/unit tests, live-schema dry runs, and the real-browser
  role gate passed. Those harnesses remain mandatory in CI.

## Recovery Batch 3 — receipt upload contract

**Status:** Completed, merged, installed on the live database, and deployed to production.

### Completed

- Limited one upload to 20 image receipts at the interface, shared client contract, server API,
  and atomic database command.
- Required the uploader to declare Alipay or WeChat before choosing files. One platform is then
  canonical for every receipt in that upload and cannot be changed after the group begins.
- Prevented a second file selection from being appended to an active group. The group identity and
  every receipt membership are validated before storage, at the server route, and in PostgreSQL.
- Added live constraints and triggers that preserve historical readable rows while preventing a
  receipt from moving between groups, a group from exceeding 20 intake items, or a receipt platform
  from differing from its batch.
- Preserved receipt accounting and transaction conversion behavior; no ledger, journal, WAC,
  maker-checker, balance, debt, or posted transaction logic was changed.

### Evidence

- Receipt upload contract and migration tests: **12/12 passed** within the focused suite.
- `npm test`: **953/953 passed**.
- Real-browser role verification: **80/80 passed** across administrator, customer, partner, office,
  investor, and administrator-mobile views; every tested view rendered without an uncaught error.
- `npm run verify:i18n`: passed; the interface translation ratchet improved by one line.
- `npm run verify:names`: passed across 117 files.
- `npm run verify:source`: passed across 411 tracked files, 137 migrations, and 4 service-key routes.
- `npm run build`: passed.
- The migration passed a live-schema transaction/rollback dry run, then was installed as
  `20260910005622_enforce_receipt_upload_contract`.
- Live inspection confirms the platform column, both validated constraints, the patched atomic
  ingestion command, all five contract triggers, and no direct execution privilege on the new
  trigger helpers for `public`, `anon`, or `authenticated`.
- Supabase security and performance advisors were recorded. They contain the established
  project-wide backlog; the new trigger helpers are not exposed as authenticated RPCs.
- GitHub PR #153 passed all 17 workflow jobs, including the strict PostgreSQL receipt journey,
  receipt-loss, accounting, tenant-isolation, business-flow, role-browser, and shipped-bundle
  gates; it was squash-merged to `main` as `7a6b373`.
- Vercel production deployment `dpl_6A4QXjWFSNPEUmndRKVfhStze9UF` reached `READY`, serves
  `https://zeman.vercel.app` and `version.json` with HTTP 200, and reported no runtime error/fatal
  logs at release time.

### Known limitation

- The local PostgreSQL receipt and journey harnesses were unavailable because PostgreSQL 16 is not
  installed in this runner; both strict harnesses passed in CI before merge.

## Recovery Batch 4 — resilient receipt reading

**Status:** Completed, merged, installed on the live database, and deployed to production.

### Implemented

- Centralized OCR provider failure policy and orchestration. Billing, permission, key, quota,
  unavailable-model, rate-limit, timeout, and upstream failures fall through to the next configured
  reader; invalid image input remains terminal. The last transient reader receives one bounded
  retry, never an unbounded serverless wait.
- Preserved sanitized provider-attempt evidence on successful fallback and final failure.
- Added explicit manipulation evidence to the structured reader contract. Blur, crop, compression,
  and an ordinary screenshot are expressly not manipulation signals.
- Bound the stored extraction to the upload group's declared Alipay/WeChat platform.
- Added a server-side automatic-ready policy: overall confidence must be at least 0.88 and critical
  amount/currency/reference/date/platform confidence at least 0.80. Arithmetic or platform
  disagreement goes to review; visible manipulation and hard same-image duplicates go to the
  separate automatic archive and count as nothing.
- Separated the review and automatic-archive screens. Only a business owner can restore an
  automatically archived duplicate/manipulation item, with a mandatory reason and idempotent audit
  command.
- Extended the strict PostgreSQL receipt reliability journey with high/low confidence, platform
  mismatch, manipulation archive, and owner-only restore cases.

### Local evidence

- Focused OCR/intake/review tests: **50/50 passed**.
- `npm test`: **960/960 passed**.
- `npm run verify:source`, `npm run verify:i18n`, `npm run verify:names`, and
  `npm run verify:production`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- The local PostgreSQL 16 harness is unavailable in this runner; the strict receipt database
  journey therefore ran in GitHub CI.

### Release evidence

- GitHub PR #155 passed all **17/17** required workflow jobs, including the strict PostgreSQL
  receipt-loss/reliability journey, accounting contracts, business flows, tenant isolation,
  receipt journey, per-role browser boundaries, shipped bundle, and dependency/source security.
- PR #155 was squash-merged to `main` as `8a706b6`.
- The live migration was installed as
  `20260910104103_resilient_receipt_reading_policy`.
- Live inspection confirms the policy trigger is enabled; the trigger helper is owned by the
  restricted `sarraf_definer` role and is not executable by browser roles. The restore command is
  browser-reachable only through its body-authorized RPC and requires `admin_level='owner'`.
- The established Supabase advisor backlog remains. The new authenticated security-definer notice
  is the intentional restore RPC; it performs tenant and owner authorization in its body.
- Vercel production deployment `dpl_Djcx8QpXNCFcwyb4mAgDbEsP6wiL` is `READY`, serves the merged
  commit through `https://zeman.vercel.app`, and returned HTTP 200 for the app and `version.json`.
  No runtime error clusters were reported after release.

### Preserved boundary

- No accounting, journal, ledger, WAC, maker-checker, balance, debt, posted transaction, or receipt
  conversion behavior was changed.

### Next batch

Recovery Batch 5: receipt selection and conversion into transactions, explicit one-route payment,
and strict upload-group isolation. Do not begin it in the same agent session.

This file records work against the professional product and UX enhancement mandate. A batch is
not called complete because its code exists; the status below names the evidence that was run.

## Batch 1 — Today's Work and primary navigation

**Status:** Implemented and verified in the merged PR #141.

### Acceptance criteria

- Owner and staff have a prioritized Today section rather than a wall of totals.
- Receipt work, approvals, pending payments, missing rates, and office balances are counted by
  one shared derivation.
- Primary navigation is grouped around Today, Trading, Receipts, Money, People, Reports, and
  System.
- Manager navigation is isolated from business financial navigation.
- Mobile navigation exposes the daily actions directly and keeps the remaining entries in named
  sections.
- Active navigation state has one source of truth, with a direct door to every registered page.

### Evidence

- `src/services/todaysWork.js` is the shared derivation and
  `test/todaysWork.test.js` covers empty, pending, deleted, office, and count semantics.
- `src/App.jsx` consumes `todaysWork()` and derives desktop and mobile navigation from
  `NAV_GROUPS`.
- GitHub CI for merged PR #141 passed the accounting, business-flow, receipt, tenant-isolation,
  role-browser, journey, build, source, i18n, and shipped-bundle gates.

### Limits still recorded

- This batch does not claim that every later mandate section is complete.
- Live production changes remain subject to the authorization rules in the main mandate.
- Browser proof for every external portal and the missing PDF-dependent requirements remains
  separate work.

## Batch 2 — Transaction money timeline

**Status:** Implemented on the transaction-money-timeline branch; pending PR review.

### Acceptance criteria

- Transaction details show a readable chronological sequence for creation, pending/settled payment,
  and authorized operational money movements.
- Customer and partner views use only the transaction milestones already visible to that portal;
  they do not receive ledger rows, profit, commissions, unrelated parties, or raw payloads.
- No accounting, ledger, tenant-isolation, role-boundary, or RPC behavior was changed.

### Evidence

- `src/services/transactionTimeline.js` derives a minimal timeline from the already-authorized
  transaction and (owner-only) ledger rows.
- `test/transactionTimeline.test.js` covers chronology, transaction scoping, and portal redaction.
- `npm run verify:source` passed: 391 tracked files, 128 migrations, and 4 service-key routes.
- The focused timeline tests passed when the full Node test command reached them: 3 passing tests.
- `git diff --check` passed.

### Limitations

- The package installation/build could not be completed in this environment because declared npm
  dependencies were absent and `npm install` did not finish within the available run.
- The broader test command also has pre-existing environment failures in API tests that import
  `@supabase/supabase-js`, plus one Windows absolute-path assumption in an existing i18n test.

## Batch 3 — Smart Work Inbox and Universal Search

The next implementation batch is the receipt Command Center: one clear ready/attention/archive
workflow, batch-safe selection, and direct actions without exposing OCR internals on daily cards.

**Status:** Implemented in the merged PR #147; local source verification passed. Database/browser
proof remains pending production credentials.

### Acceptance criteria

- Owner and operational staff receive one bounded, role-gated action inbox through
  `sarraf_action_inbox_v3`; returned actions are navigation-only and preserve the selected batch
  focus without exposing identifiers in ordinary card copy.
- Inbox cards validate their action before rendering a direct action, so a malformed or
  mutation-shaped server response cannot become a browser-side financial command.
- Universal search keeps the existing server-side tenant/role filtering and bounded RPC, while
  presenting navigation, people, transactions, receipts, uploads, batches, and currencies in
  stable user-facing groups.
- Existing multilingual labels, direct receipt focus, and query-string-safe navigation remain
  intact.
### Evidence

- `src/services/operationalControl.js` contains bounded inbox/search derivation and
  `test/globalSearch.test.js` and `test/operationalCenters.test.js` cover the behavior.
- `supabase/migrations/202609070001_smart_work_inbox.sql` adds the authenticated read RPC.
- `npm run verify:source` passed.

### Limits

- Live RPC and browser proof require the project's Supabase credentials.

## Batch 3 — Party 360 profiles and cash reconciliation

**Status:** Implemented on the enhancement branch; verification and publication are in progress.

### Acceptance criteria

- Staff can open a scoped Party 360 read model for customers, partners, offices, and investors.
- The profile combines identity, per-currency balances, open debts, transactions, receipts, and
  office payment assignments where the existing data model has them.
- The server-side profile contract excludes profit and applies staff role and tenant isolation.
- Cash reconciliation reports physical, system, held, and debt amounts per currency.
- Discrepancies remain visible and are never silently corrected by the UI.

### Evidence

- `supabase/migrations/202609070001_party_profiles_and_reconciliation.sql` adds the two
  read-only RPCs with explicit authorization and no mutation path.
- `src/services/partyProfiles.js` normalizes server-owned values without recomputing financial
  totals; `test/partyProfiles.test.js` covers scope forwarding, currency separation,
  discrepancy preservation, and refusal propagation.
- `src/components/accounting/Party360.jsx` and `CashReconciliation.jsx` are reachable from the
  People and Money navigation groups.

## Batch 4 — Document, health, and offline safety

**Status:** Implemented in this branch; database and PDF-dependent work remains blocked.

### Implemented

- Document bundle export now refuses while offline before calling the server release RPC. This
  prevents an offline document action from being mistaken for a completed authorization or
  release, and leaves authoritative server state unchanged.
- Manager overview and server reconciliation failures use the shared user-facing error mapping
  rather than exposing raw database or transport details.
- Added focused coverage proving the offline bundle guard makes no server call.

### Evidence

- `test/receiptBundleTransfer.test.js` covers the offline refusal and zero RPC calls.
- `src/services/receiptBundleTransfer.js` performs the online check before
  `sarraf_release_receipts_for_bundle`.
- `src/components/accounting/ManagerOverview.jsx` and the Backup health panel use
  `userFacingServiceError`.

### Blocked / not claimed

- Branded RTL PDF generation remains blocked because the authoritative ZEMAN logic PDF and a
  supported PDF business/export contract are absent from this repository.
- No live migration, backup/PITR change, or offline financial command queue was added. Financial
  commands remain server-authoritative and offline-blocked.

## Recovery Batch 5 — screenshot correction checkpoint

Status: partial implementation; not deployed and not the completion of Batch 5.

- Ready contains verified groups; matched/finalized/rejected groups are archived. Rejected evidence does not hide a verified group with remaining work.
- Receipt cards isolate date, time, and count for RTL. Mobile main content includes bottom safe-area clearance.
- Verification: 15 focused queue/Today tests passed; production build, free-name check, and git diff check passed.
- Remaining: browser verification, production release, default receipt selection, explicit payment routes, and full conversion journey.
