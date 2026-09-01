-- The vendor acts on a customer's business, and the customer can see it (§ stage 3).
--
-- The manager is the person who sells and maintains ZEMAN. They belong to no business —
-- app_users.tenant_id is null for them — and sarraf_sees_all_tenants() is true, so every policy
-- in the system lets them through. The manager console is careful about this: it shows counts,
-- never a figure from anybody's books.
--
-- But api/admin-user.js lets a manager create an account inside a business, deactivate one,
-- change a partner's commission, and reset anybody's password. Those are real acts on somebody
-- else's business, and nothing recorded that they happened, when, or why. A business owner who
-- buys this system has no way to know whether the vendor has been in their accounts.
--
-- For a system that is going to be sold, that is not a small thing. It is the question a
-- customer asks before they trust their ledger to somebody else's software.
--
-- ── What this adds ───────────────────────────────────────────────────────────────────────────
--
-- A support context: the manager names one business and a reason, the context lasts a bounded
-- time, and every act they perform on that business is inside it. Without one, an act on a
-- business is refused. The context is a row, the row is visible to the owner of that business,
-- and neither the manager nor anybody else can delete it.
--
-- Two businesses at once is not a support context, it is unrestricted access with a note
-- attached, so opening one closes any other.
--
-- What it deliberately does NOT do: sarraf_sees_all_tenants() is untouched. It is consulted by
-- every policy on every statement, and making a read depend on a context would leave a manager
-- with no context unable to see the list of businesses they must choose from — the same closed
-- circle as needing an owner in order to create the first owner. Reads stay as they were; what
-- is now bounded and recorded is what the manager *does*.

begin;

create table if not exists public.manager_support_sessions (
  id            text primary key default 'sup-' || replace(gen_random_uuid()::text, '-', ''),
  manager_id    text not null references public.app_users(id),
  tenant_id     text not null references public.tenants(id),
  reason        text not null,
  opened_at     timestamptz not null default statement_timestamp(),
  expires_at    timestamptz not null,
  closed_at     timestamptz,
  closed_reason text,
  check (char_length(btrim(reason)) >= 8),
  check (expires_at > opened_at),
  -- The bound, in the schema. The command clamps to eight hours; without this line a manager
  -- writing the row directly could set an expiry a year out and call it a support context.
  check (expires_at <= opened_at + interval '8 hours'),
  check (closed_at is null or closed_at >= opened_at)
);

comment on table public.manager_support_sessions is
  'Every time the vendor opened one business to act on it, why, and for how long. Written by command, never deleted, and readable by the owner of that business.';

create index if not exists mss_open_idx
  on public.manager_support_sessions(manager_id, tenant_id) where closed_at is null;
create index if not exists mss_tenant_idx
  on public.manager_support_sessions(tenant_id, opened_at desc);

-- Append-only. A record of who looked at your books is worth nothing if the person who looked
-- can tidy it away afterwards.
drop trigger if exists manager_support_sessions_append_only on public.manager_support_sessions;
create trigger manager_support_sessions_append_only before delete on public.manager_support_sessions
  for each row execute function public.sarraf_protect_append_only();

alter table public.manager_support_sessions enable row level security;
alter table public.manager_support_sessions force row level security;
revoke all on public.manager_support_sessions from public, anon;
grant select on public.manager_support_sessions to authenticated;

-- The owner of the business sees every context opened against them. The manager sees their own.
-- Nobody writes through the table; the commands below are the only way a row appears.
drop policy if exists manager_support_visible on public.manager_support_sessions;
create policy manager_support_visible on public.manager_support_sessions
  for select to authenticated
  using (public.sarraf_tenant_visible(tenant_id));

-- The commands below run as sarraf_definer, which is a member of authenticated and has no
-- BYPASSRLS — that is the point of it. So the table's own policies have to permit what those
-- commands do, and nothing else: a row about yourself, never about another manager.
--
-- A manager reaching the table directly can therefore write their own record and choose their
-- own words. That is not what this protects against. What it protects against is a record that
-- does not exist, one about somebody else, one that outlives its bound, and one that can be
-- deleted afterwards — and the CHECK above and the append-only trigger below cover the last two.
grant insert, update on public.manager_support_sessions to authenticated;

drop policy if exists manager_support_own_insert on public.manager_support_sessions;
create policy manager_support_own_insert on public.manager_support_sessions
  for insert to authenticated
  with check (manager_id = public.my_app_id() and public.sarraf_sees_all_tenants());

drop policy if exists manager_support_own_close on public.manager_support_sessions;
create policy manager_support_own_close on public.manager_support_sessions
  for update to authenticated
  using (manager_id = public.my_app_id())
  with check (manager_id = public.my_app_id());

-- ── opening one ──────────────────────────────────────────────────────────────────────────────
create or replace function public.sarraf_manager_open_support(
  p_tenant_id text, p_reason text, p_minutes integer default 120
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_reason text; v_minutes integer; v_id text;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' or coalesce(v_actor.admin_level, '') <> 'manager' then
    raise exception using errcode='42501', message='only the manager opens a support context';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 then
    raise exception using errcode='22023',
      message='say why in at least eight characters; a support context with no reason is not one';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception using errcode='P0002', message='no such business';
  end if;

  -- Bounded, and bounded at both ends: long enough to do the work, short enough that leaving it
  -- open is not the same as having permanent access.
  v_minutes := least(greatest(coalesce(p_minutes, 120), 15), 480);

  -- One business at a time. Two at once is not a support context, it is unrestricted access
  -- with a note attached.
  update public.manager_support_sessions
     set closed_at = statement_timestamp(),
         closed_reason = 'بازرگانییەکی تر کرایەوە'
   where manager_id = v_actor.id and closed_at is null;

  insert into public.manager_support_sessions(manager_id, tenant_id, reason, expires_at)
  values (v_actor.id, p_tenant_id, left(v_reason, 500),
          statement_timestamp() + make_interval(mins => v_minutes))
  returning id into v_id;

  perform public.sarraf_write_audit(v_actor.id, 'کردنەوەی پشتگیری',
    format('%s — %s', p_tenant_id, left(v_reason, 200)));

  return jsonb_build_object('id', v_id, 'tenant_id', p_tenant_id, 'minutes', v_minutes,
                            'expires_at', statement_timestamp() + make_interval(mins => v_minutes));
end;
$$;

-- ── closing one ──────────────────────────────────────────────────────────────────────────────
create or replace function public.sarraf_manager_close_support(p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor public.app_users%rowtype; v_closed integer;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or coalesce(v_actor.admin_level, '') <> 'manager' then
    raise exception using errcode='42501', message='only the manager closes a support context';
  end if;

  update public.manager_support_sessions
     set closed_at = statement_timestamp(),
         closed_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 500)
   where manager_id = v_actor.id and closed_at is null;
  get diagnostics v_closed = row_count;

  return jsonb_build_object('closed', v_closed);
end;
$$;

-- ── which business is open, if any ───────────────────────────────────────────────────────────
--
-- STABLE and cheap: this is asked once per command, not once per row. An expired context is not
-- an open one — the expiry is what makes the bound real rather than decorative.
create or replace function public.sarraf_manager_support_tenant()
returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select s.tenant_id
    from public.manager_support_sessions s
    join public.app_users u on u.id = s.manager_id
   where u.auth_id = auth.uid()
     and s.closed_at is null
     and s.expires_at > statement_timestamp()
   order by s.opened_at desc
   limit 1;
$$;

-- The same answer, for the server.
--
-- api/admin-user.js holds the service key, so its requests carry no auth.uid() at all and the
-- function above — which asks who the caller is — would answer null for every manager, every
-- time. That is a refusal, not a hole, but it would make the whole context unusable from the one
-- route that most needs it. So the manager is named explicitly, and the function is closed to
-- every role a browser can hold: only the service key reaches it.
create or replace function public.sarraf_manager_support_tenant_for(p_manager_id text)
returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select s.tenant_id
    from public.manager_support_sessions s
   where s.manager_id = p_manager_id
     and s.closed_at is null
     and s.expires_at > statement_timestamp()
   order by s.opened_at desc
   limit 1;
$$;

-- ── what the business owner sees ─────────────────────────────────────────────────────────────
--
-- The point of the whole thing. A business that buys this system can ask when the vendor was
-- last in their accounts and get an answer, rather than being told to trust.
create or replace function public.sarraf_support_history(p_days integer default 90)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_days integer; v_rows jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  v_days := least(greatest(coalesce(p_days, 90), 1), 730);

  select coalesce(jsonb_agg(to_jsonb(x) order by x.opened_at desc), '[]'::jsonb) into v_rows
    from (
      select s.id, s.tenant_id, t.name as tenant_name, s.reason,
             s.opened_at, s.expires_at, s.closed_at, s.closed_reason,
             m.name as manager_name,
             (s.closed_at is null and s.expires_at > statement_timestamp()) as still_open
        from public.manager_support_sessions s
        join public.tenants t on t.id = s.tenant_id
        left join public.app_users m on m.id = s.manager_id
       where s.opened_at >= statement_timestamp() - make_interval(days => v_days)
       limit 500
    ) x;

  return jsonb_build_object('days', v_days, 'sessions', v_rows);
end;
$$;

grant create on schema public to sarraf_definer;
alter function public.sarraf_manager_open_support(text, text, integer) owner to sarraf_definer;
alter function public.sarraf_manager_close_support(text) owner to sarraf_definer;
alter function public.sarraf_support_history(integer) owner to sarraf_definer;
alter function public.sarraf_manager_support_tenant() owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

-- sarraf_manager_support_tenant_for stays owned by the migrating role on purpose, and is the
-- only one here that does. api/admin-user.js asks it through the service key, where there is no
-- session at all — a definer bound by the tenant policies would answer null for every manager on
-- every request. It returns one text value and is closed to every role a browser can hold, which
-- is the condition the isolation gate's allowlist depends on.

revoke execute on function public.sarraf_manager_open_support(text, text, integer) from public, anon;
revoke execute on function public.sarraf_manager_close_support(text) from public, anon;
revoke execute on function public.sarraf_manager_support_tenant() from public, anon;
revoke execute on function public.sarraf_manager_support_tenant_for(text) from public, anon, authenticated;
do $grant$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sarraf_manager_support_tenant_for(text) to service_role';
  end if;
end $grant$;
revoke execute on function public.sarraf_support_history(integer) from public, anon;
grant execute on function public.sarraf_manager_open_support(text, text, integer) to authenticated;
grant execute on function public.sarraf_manager_close_support(text) to authenticated;
grant execute on function public.sarraf_manager_support_tenant() to authenticated;
grant execute on function public.sarraf_support_history(integer) to authenticated;

-- The health report compares the database against a written list, and anything not on it is
-- reported to the manager as an unmanaged table. A new table nobody adds turns that report into
-- noise, which is the one thing it exists to avoid. One name, in its alphabetical place.
create or replace function public.sarraf_schema_tables()
returns table(table_name text, state text)
language sql
stable
set search_path = pg_catalog, public
as $tables$
  with expected(t) as (values
    ('account_ledger'), ('account_transfers'), ('accounting_commands'), ('app_users'),
    ('approval_events'), ('approval_requests'), ('audit'), ('chart_of_accounts'),
    ('control_settings'), ('currencies'), ('customer_vault_events'), ('customer_vaults'),
    ('day_closes'), ('debt_events'), ('debt_settlements'), ('debts'), ('financial_commands'),
    ('journal_entries'), ('journal_lines'), ('ledger'), ('manager_support_sessions'), ('notes'), ('ocr_attestations'),
    ('office_payment_assignments'), ('office_payment_events'), ('office_payment_evidence'),
    ('office_pending_assignments'), ('partner_account_events'), ('partner_accounts'),
    ('pending_accounts'),
    ('rate_history'), ('rate_limit_counters'), ('receipt_assignment_events'),
    ('receipt_audit_events'), ('receipt_batch_transactions'), ('receipt_batches'),
    ('receipt_command_log'), ('receipt_control_policy'), ('receipt_custody'),
    ('receipt_custody_events'), ('receipt_custody_ledger'), ('receipt_daily_rates'),
    ('receipt_documents'), ('receipt_extractions'), ('receipt_forwardings'),
    ('receipt_ingestion_authorizations'), ('receipt_ingestion_commands'),
    ('receipt_intake_items'), ('receipt_match_commands'), ('receipt_notifications'),
    ('receipt_ocr_attempts'), ('receipt_operation_commands'), ('receipt_pending_conversions'),
    ('receipt_review_commands'), ('receipt_state_transitions'),
    ('receipt_transaction_assignments'), ('receipts'), ('schema_migrations'),
    ('system_event_log'),
    ('tenant_rates'), ('tenants'),
    ('transaction_payment_events'), ('tx_versions'), ('txs'), ('voucher_counters'), ('vouchers'),
    ('zeman_faults'), ('zeman_notifications')
  ), live as (
    select c.relname::text as t
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  )
  select e.t, 'missing from the database'
  from expected e where not exists (select 1 from live l where l.t = e.t)
  union all
  select l.t, 'in the database, unmanaged by any migration'
  from live l where not exists (select 1 from expected e where e.t = l.t)
  order by 1;
$tables$;

commit;
