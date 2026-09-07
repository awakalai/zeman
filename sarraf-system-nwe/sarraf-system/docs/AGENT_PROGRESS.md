# ZEMAN enhancement batches

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

## Next batch

The next implementation batch is the receipt Command Center: one clear ready/attention/archive
workflow, batch-safe selection, and direct actions without exposing OCR internals on daily cards.

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
