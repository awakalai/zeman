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

## Batch 2 — Smart Work Inbox and Universal Search

**Status:** Implemented in this branch; local source verification passed. Database/browser proof is
still pending production credentials and dependency restoration.

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

- `src/services/operationalControl.js` contains `safeInboxAction` and deterministic search
  grouping; `test/globalSearch.test.js` and `test/operationalCenters.test.js` cover bounds,
  grouping, authorization-shaped actions, and rejection of data-bearing paths.
- `supabase/migrations/202609070001_smart_work_inbox.sql` adds the bounded owner/staff read RPC
  with authenticated execution only and no mutation statements.
- `npm run verify:source` passed. The focused tests for global search and operational centers
  passed; the broader test command also exposed pre-existing missing dependency/path failures.

### Limits

- Live RPC and browser proof require the project's Supabase credentials.
- `npm run build` is blocked in this checkout because dependencies (`vite`, `@supabase/supabase-js`)
  are not installed; no dependency manifest was changed.
