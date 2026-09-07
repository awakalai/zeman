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

## Batch 2 — Document, health, and offline safety

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
