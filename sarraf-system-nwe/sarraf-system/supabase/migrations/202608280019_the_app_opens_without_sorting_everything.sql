-- What the app does the moment somebody opens it.
--
-- Nine queries go out together. Five of them read a table WHOLE, a thousand rows at a time,
-- because a balance computed from part of a ledger is not a smaller answer — it is a wrong one,
-- and this system refuses to show one. That decision is correct and is not being revisited here.
--
-- What was never checked is what PostgreSQL has to DO to answer them. Every one of those nine
-- asks for rows in an order:
--
--     ledger           order by date asc,       id asc
--     txs              order by date asc,       id asc
--     account_ledger   order by created_at asc, id asc
--     rate_history     order by created_at asc, id asc
--     app_users        order by created_at asc, id asc
--     audit            order by date desc        limit 500
--     approval_requests order by created_at desc limit 500
--     approval_events   order by created_at desc limit 1500
--     tx_versions       order by created_at desc limit 3000
--
-- and not one of those orders had an index behind it. The indexes on these tables lead with
-- something else — `ledger(partner_id, date desc)`, `account_ledger(user_id, cur_id, created_at)`,
-- `tx_versions(tx_id, version_no desc)` — and an index cannot be used for ordering unless the
-- order starts where the index starts. `txs` came closest and still missed: its index is
-- `(date desc, id) where not deleted`, and the browser reads deleted rows too, so the partial
-- index does not cover the query.
--
-- So every single one of those nine did a full sort of the entire table. Measured on this
-- repository's own fixture at 60,000 ledger rows:
--
--     ledger page 1     18.6 ms   ->  Sort (rows=60000)
--     ledger page 60    30.2 ms   ->  Sort (rows=60000)
--
-- The browser fetches sixty of those pages in sequence, so the ledger alone costs about a second
-- and a half of database time before the network carries a byte — and because each page sorts the
-- whole table, that cost grows with the SQUARE of the table. Twice the history is four times the
-- wait. With an index matching the order, the same two pages are 0.3 ms and 10.4 ms, and the cost
-- grows with how deep the page is instead of how big the table is.
--
-- An index cannot change what a query returns; it changes only how the answer is reached. No
-- business rule, no total, no workflow moves here.
--
-- On the tenant predicate: RLS on these tables is `sarraf_tenant_visible(tenant_id)`, a function
-- call rather than an equality, so the planner cannot drive an index from it and a composite
-- leading with tenant_id would buy nothing. The index is the ordering, exactly as asked for; the
-- tenant filter is applied to rows as they come off it, and the function is `stable`, so it is
-- evaluated once per statement rather than once per row.
--
-- These are written as plain CREATE INDEX rather than CONCURRENTLY. Concurrently is the right
-- choice against a table already large enough that a write lock would be felt; these tables are
-- not there yet, and a concurrent build that fails leaves an INVALID index behind, which is the
-- worse thing to inherit. If an index is ever added to one of these once it is large, use
-- CONCURRENTLY — this migration runner autocommits each statement, so it is available.

-- ── the five the browser reads whole ─────────────────────────────────────────
create index if not exists ledger_open_order_idx
  on public.ledger(date, id);

create index if not exists txs_open_order_idx
  on public.txs(date, id);

create index if not exists account_ledger_open_order_idx
  on public.account_ledger(created_at, id);

create index if not exists rate_history_open_order_idx
  on public.rate_history(created_at, id);

create index if not exists app_users_open_order_idx
  on public.app_users(created_at, id);

-- ── the four the browser takes the newest of ─────────────────────────────────
-- A LIMIT does not save a sort: without an index PostgreSQL still orders every row to find out
-- which five hundred are the newest. `audit` is the fastest-growing table in the system and had
-- no index on its date at all.
create index if not exists audit_recent_idx
  on public.audit(date desc);

create index if not exists approval_requests_recent_idx
  on public.approval_requests(created_at desc);

create index if not exists approval_events_recent_idx
  on public.approval_events(created_at desc);

create index if not exists tx_versions_recent_idx
  on public.tx_versions(created_at desc);

analyze public.ledger;
analyze public.txs;
analyze public.account_ledger;
analyze public.rate_history;
analyze public.app_users;
analyze public.audit;
analyze public.approval_requests;
analyze public.approval_events;
analyze public.tx_versions;
