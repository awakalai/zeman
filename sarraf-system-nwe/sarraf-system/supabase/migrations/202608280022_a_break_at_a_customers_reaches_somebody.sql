-- What happens today when ZEMAN breaks in front of a customer.
--
--   componentDidCatch(error, info) {
--     console.error("ZEMAN render recovery", error, info);
--   }
--
-- It is written to the console of that person's phone, which nobody will ever open. The screen
-- says «پەڕەکە پێویستی بە نوێکردنەوە هەیە» and the fault is gone. The first anybody hears is a
-- phone call, days later, with no code, no screen name and no way to reproduce it.
--
-- Every real defect this month was found the same way: somebody hit it, took a photograph, and
-- sent it. That works while the only user is the person who built it. It does not survive being
-- sold to a business three cities away.
--
-- ── what is recorded, and what is deliberately not ───────────────────────────
--
-- A fault report is not a copy of what went wrong. It is the least that lets somebody find it:
--
--   kind          render | command | load — which of the three ways it broke
--   code          the reference the reader was already shown: ZE-23514, ZE-NET, TypeError
--   screen        which page they were on, from a fixed list, never a URL
--   fingerprint   a hash naming the fault, so the same one twice is the same row twice counted
--   detail        the first line of the message — ONLY for internal faults, never a refusal
--
-- What is never written: amounts, names, currencies, receipt or transaction ids, tokens, the
-- text a person typed, the full stack. A deliberate refusal — one of the eight SQLSTATEs this
-- system raises on purpose — is normal operation and is not a fault at all; recording those
-- would bury the real ones under thousands of "the reason is too short".
--
-- ── and why it cannot become a flood ─────────────────────────────────────────
--
-- The failure mode of any error reporter is the crash loop: a component throws on every render,
-- and the reporter writes a row each time until the table is the largest thing in the database.
--
-- So a fault is identified by its fingerprint and counted, not appended. The same fault, on the
-- same day, in the same business, is one row with `seen` going up. A hundred thousand crashes
-- are one row saying 100000, which is also the more useful thing to read. On top of that the
-- command refuses more than 20 DISTINCT faults from one person per hour: a browser that has
-- found twenty different ways to break in an hour has already said everything useful.

begin;

create table if not exists public.zeman_faults (
  id text primary key default ('zf-' || replace(gen_random_uuid()::text, '-', '')),
  tenant_id text references public.tenants(id) default public.sarraf_tenant(),
  actor_id text references public.app_users(id),
  day date not null default current_date,
  kind text not null check (kind in ('render', 'command', 'load')),
  code text not null check (char_length(code) between 1 and 40),
  screen text not null check (char_length(screen) between 1 and 40),
  fingerprint text not null check (char_length(fingerprint) between 8 and 64),
  detail text check (detail is null or char_length(detail) <= 200),
  agent text check (agent is null or char_length(agent) <= 120),
  seen integer not null default 1 check (seen > 0),
  first_at timestamptz not null default statement_timestamp(),
  last_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz,
  resolved_by text references public.app_users(id)
);

-- One row per fault per business per day. This is the whole defence against a crash loop, and
-- it is a constraint rather than a convention so that no future caller can undo it.
create unique index if not exists zeman_faults_one_per_day
  on public.zeman_faults(coalesce(tenant_id, '⟨none⟩'), day, fingerprint);

-- The manager's console reads the newest first, across every business.
create index if not exists zeman_faults_recent_idx on public.zeman_faults(last_at desc);

alter table public.zeman_faults enable row level security;
alter table public.zeman_faults force row level security;

-- Reading a fault means reading nothing about anybody's money, but it is still this business's
-- business. An owner sees their own; the manager, who is the one who can actually fix it, sees
-- all of them.
drop policy if exists zeman_faults_read on public.zeman_faults;
create policy zeman_faults_read on public.zeman_faults for select to authenticated
  using (
    (select public.sarraf_sees_all_tenants())
    or ((select public.is_admin()) and tenant_id = (select public.sarraf_tenant()))
  );

drop policy if exists zeman_faults_tenant on public.zeman_faults;
create policy zeman_faults_tenant on public.zeman_faults as restrictive for all to authenticated
  using (
    (select public.sarraf_sees_all_tenants())
    or (tenant_id is not null and tenant_id = (select public.sarraf_tenant()))
  )
  with check (
    (select public.sarraf_sees_all_tenants())
    or (tenant_id is not null and tenant_id = (select public.sarraf_tenant()))
  );

drop policy if exists zeman_faults_definer on public.zeman_faults;
create policy zeman_faults_definer on public.zeman_faults for all to sarraf_definer
  using (true) with check (true);

grant select on public.zeman_faults to authenticated;

-- ── the command ─────────────────────────────────────────────────────────────
--
-- Nothing writes to this table directly. Every field is bounded and stripped here, so that what
-- a browser sends cannot become what the table holds.
create or replace function public.sarraf_record_fault(
  p_kind text, p_code text, p_screen text, p_fingerprint text,
  p_detail text default null, p_agent text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users;
  v_distinct integer;
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_code text := left(btrim(coalesce(p_code, 'unknown')), 40);
  v_screen text := left(btrim(coalesce(p_screen, 'unknown')), 40);
  v_print text := left(btrim(coalesce(p_fingerprint, '')), 64);
  v_detail text := nullif(left(btrim(coalesce(p_detail, '')), 200), '');
  v_agent text := nullif(left(btrim(coalesce(p_agent, '')), 120), '');
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    -- Not an error worth raising. A fault reported by somebody who is not signed in is a fault
    -- nobody can act on, and refusing loudly would turn a bad moment into two.
    return jsonb_build_object('recorded', false, 'why', 'no actor');
  end if;

  if v_kind not in ('render', 'command', 'load') then v_kind := 'render'; end if;
  if char_length(v_print) < 8 then
    v_print := left(md5(v_kind || ':' || v_code || ':' || v_screen), 32);
  end if;

  -- Twenty different faults in an hour from one person is not diagnosis any more.
  select count(distinct fingerprint) into v_distinct
    from public.zeman_faults
   where actor_id = v_actor.id and last_at > statement_timestamp() - interval '1 hour';
  if v_distinct >= 20 then
    return jsonb_build_object('recorded', false, 'why', 'too many');
  end if;

  insert into public.zeman_faults(tenant_id, actor_id, kind, code, screen, fingerprint, detail, agent)
  values (v_actor.tenant_id, v_actor.id, v_kind, v_code, v_screen, v_print, v_detail, v_agent)
  on conflict (coalesce(tenant_id, '⟨none⟩'), day, fingerprint) do update
    set seen = public.zeman_faults.seen + 1,
        last_at = statement_timestamp(),
        detail = coalesce(public.zeman_faults.detail, excluded.detail);

  return jsonb_build_object('recorded', true, 'fingerprint', v_print);
end;
$$;

revoke all on function public.sarraf_record_fault(text, text, text, text, text, text) from public, anon;
grant execute on function public.sarraf_record_fault(text, text, text, text, text, text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_record_fault(text, text, text, text, text, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

-- ── and the way to read them ────────────────────────────────────────────────
create or replace function public.sarraf_faults(p_days integer default 14)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(row_to_json(f) order by f.last_at desc), '[]'::jsonb)
    from (
      select id, tenant_id, kind, code, screen, fingerprint, detail, agent,
             seen, first_at, last_at, resolved_at
        from public.zeman_faults
       where last_at > statement_timestamp() - make_interval(days => greatest(1, least(90, p_days)))
       order by last_at desc
       limit 200
    ) f;
$$;

revoke all on function public.sarraf_faults(integer) from public, anon;
grant execute on function public.sarraf_faults(integer) to authenticated;
grant create on schema public to sarraf_definer;
alter function public.sarraf_faults(integer) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

-- sarraf_schema_tables compares the database against a written list, and anything not on it is
-- reported to the manager as an unmanaged table. A new table nobody adds turns the health report
-- into noise, which is the one thing that report exists to avoid.
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
    ('journal_entries'), ('journal_lines'), ('ledger'), ('notes'), ('ocr_attestations'),
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
