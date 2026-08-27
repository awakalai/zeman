-- The other half of the filter, on the six tables the app reads whole.
--
-- 202608280020 stopped the tenant question being asked once per row. What it left behind, on
-- exactly the tables that matter most, is the rest of the same filter:
--
--     Filter: (($0 OR ((tenant_id IS NOT NULL) AND (tenant_id = $1)))
--              AND (is_admin() OR (partner_id = my_app_id()) OR (investor_id = my_app_id())))
--
-- The tenant half is `$0` and `$1` now — evaluated once. The permissive half is not: `is_admin()`
-- and `my_app_id()` are still real calls, and `my_app_id()` appears twice, so reading the ledger
-- is up to three security-definer invocations for every row PostgreSQL looks at.
--
-- Being `stable` is not enough. Stable promises the answer will not change during the statement;
-- it does not tell the planner the answer does not depend on the row. Only `(select f())` says
-- that, and only then does it become an InitPlan.
--
-- On 20,000 ledger rows, count(*) as `authenticated`, with the tenant rewrite already in place:
--
--     the permissive policy as written    60.9 ms
--     the same policy asked once           6.3 ms      9.7×
--
-- ── why these eight and not all ninety ───────────────────────────────────────
--
-- About ninety policies still call an argument-free function directly, in fourteen or more
-- different shapes. The tenant rewrite could be done by a loop because all sixty-two were
-- identical; these are not, and a loop that reshapes a security predicate it does not recognise
-- is how one business ends up reading another's books.
--
-- So this migration takes only the read policies on the six tables the application reads WHOLE —
-- where the cost is multiplied by every row of a business's history — and writes each of the
-- eight out by hand, unchanged except for the parentheses that say "ask this once".
--
-- Every one is PERMISSIVE, SELECT, to authenticated, with no WITH CHECK, exactly as it is today.
-- The rows each admits are the same rows: same functions, same operators, same order.

-- ── ledger ───────────────────────────────────────────────────────────────────
drop policy if exists ledger_tenant_read on public.ledger;
create policy ledger_tenant_read on public.ledger for select to authenticated
  using (
    (select public.is_admin())
    or partner_id = (select public.my_app_id())
    or investor_id = (select public.my_app_id())
  );

-- ── txs ──────────────────────────────────────────────────────────────────────
drop policy if exists txs_tenant_read on public.txs;
create policy txs_tenant_read on public.txs for select to authenticated
  using (
    (select public.is_admin())
    or cp_id = (select public.my_app_id())
    or partner_id = (select public.my_app_id())
  );

drop policy if exists tx_partner_read_b on public.txs;
create policy tx_partner_read_b on public.txs for select to authenticated
  using (
    (select public.my_role()) = 'partner'
    and partner_id = (select public.my_app_id())
  );

-- The EXISTS stays correlated — it asks about THIS transaction and must be evaluated per row.
-- `my_app_id()` inside it does not depend on the row, so it is hoisted like the others.
drop policy if exists tx_office_r on public.txs;
create policy tx_office_r on public.txs for select to authenticated
  using (
    (select public.my_role()) = 'office'
    and exists (
      select 1 from public.office_payment_assignments a
       where a.transaction_id = txs.id
         and a.office_id = (select public.my_app_id())
    )
  );

-- ── account_ledger ───────────────────────────────────────────────────────────
drop policy if exists account_ledger_tenant_read on public.account_ledger;
create policy account_ledger_tenant_read on public.account_ledger for select to authenticated
  using (
    (select public.is_admin())
    or user_id = (select public.my_app_id())
  );

-- ── app_users ────────────────────────────────────────────────────────────────
drop policy if exists app_users_admin_or_self_read on public.app_users;
create policy app_users_admin_or_self_read on public.app_users for select to authenticated
  using (
    (select public.is_admin())
    or auth_id = (select auth.uid())
  );

-- ── audit ────────────────────────────────────────────────────────────────────
drop policy if exists audit_admin_read on public.audit;
create policy audit_admin_read on public.audit for select to authenticated
  using ((select public.is_admin()));

-- ── rate_history ─────────────────────────────────────────────────────────────
drop policy if exists rate_history_authenticated_read on public.rate_history;
create policy rate_history_authenticated_read on public.rate_history for select to authenticated
  using ((select auth.uid()) is not null);
