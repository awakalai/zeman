-- The third question (§ baseline section 7, after 202609010001).
--
-- 202609010001 put FORCE on the last two tables that lacked it, and the live inspection
-- afterwards reported something the local gate had not:
--
--     manager_support_sessions — بێ پۆلیسی سنووردارکەر
--     pending_accounts         — بێ پۆلیسی سنووردارکەر
--
-- Both have row level security, both have FORCE, and neither has a RESTRICTIVE policy. The gate
-- asked two of the three questions INSPECT asks, so it passed work the report then refused. The
-- gate has been widened; this is the other half.
--
-- Why the third question is the one that lasts. RLS says the policies are consulted. FORCE says
-- the table's owner is not exempt from them. Neither says anything about what a policy added
-- next year will allow — and permissive policies are ORed, so every new one can only widen. A
-- RESTRICTIVE policy is ANDed with all of them, which makes the tenant boundary something no
-- future policy can loosen by accident. Every other tenanted table in this system has one.
--
-- Neither table changes what it currently allows. Both restrictive policies are written to be
-- true wherever the existing permissive policies are already true, so nothing that works today
-- stops working; what changes is that nothing added tomorrow can reach past them.

begin;

-- ── manager_support_sessions ─────────────────────────────────────────────────────────────────
--
-- Read by the manager (who sees across businesses) and by the owner of the business the context
-- was opened against. Written only by the two commands, about the manager themselves. The
-- restrictive policy states both halves as one condition that every other policy is ANDed with.
drop policy if exists manager_support_tenant on public.manager_support_sessions;
create policy manager_support_tenant on public.manager_support_sessions
  as restrictive for all to authenticated
  using (
    (select public.sarraf_sees_all_tenants())
    or (tenant_id is not null and tenant_id = (select public.sarraf_tenant()))
  )
  with check (
    (select public.sarraf_sees_all_tenants())
    or (tenant_id is not null and tenant_id = (select public.sarraf_tenant()))
  );

-- ── pending_accounts ─────────────────────────────────────────────────────────────────────────
--
-- Who a login will be when it is created. Only a manager may look, and the rows are written by
-- migration and claimed by the trigger on auth.users — which runs as a role that bypasses row
-- security outright, so this does not stand between a new account and its creation.
--
-- The permissive policy already says "manager only". The restrictive one says it again in a form
-- that cannot be widened: a manager sees all, and anybody else may see only a row for their own
-- business — which, since nobody else is granted SELECT at all, is currently nobody.
drop policy if exists pending_accounts_tenant on public.pending_accounts;
create policy pending_accounts_tenant on public.pending_accounts
  as restrictive for all to authenticated
  using (
    (select public.sarraf_sees_all_tenants())
    or (tenant_id is not null and tenant_id = (select public.sarraf_tenant()))
  )
  with check (
    (select public.sarraf_sees_all_tenants())
    or (tenant_id is not null and tenant_id = (select public.sarraf_tenant()))
  );

commit;
