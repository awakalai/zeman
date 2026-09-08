# ZEMAN enhancement batches

> **Recovery status — 2026-09-08**
>
> The deployed `main` line and earlier verified work had diverged. Recovery now proceeds on
> `codex/recovery-stabilization` from production commit `393f2b0`. The ordered source of truth is
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

### Next batch

Recovery Batch 2: reconcile manager onboarding, phone/password login and recovery, and the
clear-account guard before deactivation.

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
