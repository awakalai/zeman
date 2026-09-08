# ZEMAN recovery and completion plan

**Started:** 2026-09-08  
**Recovery branch:** `codex/recovery-stabilization`  
**Production baseline:** `393f2b0`

This plan reconciles the deployed `main` line with verified work that remained on other branches.
It does not treat an old document, test, branch, or UI label as proof that a requirement is complete.
A batch is complete only after its relevant code, database, API, browser, role, and build evidence passes.

## Non-negotiable invariants

- Preserve WAC, balanced posted journals, append-only ledgers, maker-checker, and existing financial RPC behavior.
- Correct posted financial work only through a reasoned reversal/void and a linked replacement.
- Keep financial commands atomic, idempotent, concurrency-safe, and server-authoritative.
- Keep raw receipt images and OCR/source values immutable; corrections are versioned and audited.
- A rejected receipt never creates a transaction.
- Enforce tenant and role isolation on the server, not only in navigation or UI.
- Never repair balances with direct SQL updates/deletes and never destroy production data to make a test pass.

## Ordered batches

| Batch | Scope | Completion evidence |
|---|---|---|
| 1 | Stabilize deployed baseline: Smart Inbox authorization, timeline translations, offline bundle copy, recovery record | Targeted tests, full unit suite, source/search/i18n/name checks, production build |
| 2 | Manager onboarding, phone/password sessions, password recovery, clear-account deactivation guard | API + migration + role tests; manager/customer/partner/office login browser proof |
| 3 | Receipt upload contract: maximum 20 images, one declared platform, one immutable upload group | Client, API, DB constraints and upload browser proof |
| 4 | OCR fallback/retry, confidence, duplicate/manipulation routing, review/archive recovery | Provider fault tests, receipt reliability gate, real sample journey |
| 5 | Receipt selection and conversion into transactions, explicit payment route, batch isolation | Atomic DB/API tests and complete receipt-to-ledger browser journey |
| 6 | Customer portal, customer-owned funds, automatic use and remainder debt | Customer role/isolation tests and per-currency accounting proof |
| 7 | Partner portal, custody confirmation, commission rules, balance and debt waterfall | Partner role/API/DB tests and 1,000 CNY at 1% examples |
| 8 | Office portal, assignment, payout, reasoned correction, totals and settlement | Office role/isolation tests and assignment-to-settlement journey |
| 9 | Owner/staff permissions, cashbox controls, reversal workflow and complete audit context | Permission matrix, audit before/after/actor/device/IP/reason tests |
| 10 | Investor portal, reports, branded RTL PDF, download and share | Role redaction, PDF render inspection and share/download tests |
| 11 | In-app, push and manual WhatsApp flows; debt notification only on explicit click | Notification routing, privacy and delivery-failure tests |
| 12 | Professional role-based mobile/desktop UX, navigation, search and error copy | Mobile/desktop browser checks, RTL, accessibility and no-internal-error proof |
| 13 | RLS/security/advisors, tenant isolation, backups and restore rehearsal | Supabase advisors, isolation gate, backup/restore evidence |
| 14 | Full production readiness, all role journeys, migration parity and safe test-data cleanup | All gates, live smoke tests, rollback notes and release record |

Only one batch is implemented at a time. Each batch is committed and recorded before the next one
starts. Unknown or uncommitted work from older branches is preserved until explicitly reconciled.

