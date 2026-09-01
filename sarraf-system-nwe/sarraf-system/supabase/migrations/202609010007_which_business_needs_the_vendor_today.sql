-- Which business needs the vendor today (§ stage 10).
--
-- sarraf_manager_tenants lists every business with what it holds: accounts, administrators,
-- transactions, receipts, last activity. That answers "what exists". It does not answer the
-- question somebody running this platform actually opens the console with, which is "where do I
-- need to go".
--
-- The difference showed up on the live database. `own-watan` — the owner of the second business —
-- has a login and has never passed the MFA gate, so that business has never been opened by
-- anybody. Nothing in the console said so. It took a database inspection to find, and the vendor
-- would have found out when the customer rang.
--
-- ── What is and is not shown ─────────────────────────────────────────────────────────────────
--
-- Counts and states, never amounts. The manager maintains the system and sells it; they are not
-- a party to anybody's trades, and the console has been careful about that from the start. A
-- count of entries waiting to be posted says the books need attention. The figures in them are
-- the business's own.
--
-- Each finding names what to do, not just that something is wrong. "Never opened" and "quiet for
-- 40 days" are different problems with different answers, and a single "unhealthy" flag would
-- have collapsed them into a colour.

begin;

create or replace function public.sarraf_manager_attention(p_quiet_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_days integer := least(greatest(coalesce(p_quiet_days, 30), 1), 365);
  v_rows jsonb;
begin
  if not public.sarraf_sees_all_tenants() then
    raise exception using errcode = '42501', message = 'only a manager may read this';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.weight desc, x.name), '[]'::jsonb) into v_rows
    from (
      select
        t.id, t.name, t.active,
        -- Never opened: an owner is waiting for a login, or has one and has never got past the
        -- MFA gate. Either way nobody has ever been inside this business.
        (not exists (
          select 1 from public.app_users u
           where u.tenant_id = t.id and not u.deleted
             and coalesce(u.admin_level, '') = 'owner'
             and u.auth_id is not null
             and exists (select 1 from auth.mfa_factors f
                          where f.user_id = u.auth_id and f.status = 'verified')
        )) as never_opened,
        -- Waiting to be claimed: the invitation has not been accepted yet.
        (select count(*) from public.pending_accounts p
          where p.tenant_id = t.id and p.claimed_at is null) as waiting_to_claim,
        -- A protected account with no second factor. Not a hole — they cannot sign in without
        -- one — but an account that is not usable, and the person holding it does not know.
        (select count(*) from public.app_users u
          where u.tenant_id = t.id and not u.deleted
            and coalesce(u.admin_level, u.role) in ('owner','operator','admin','office')
            and u.auth_id is not null
            and not exists (select 1 from auth.mfa_factors f
                             where f.user_id = u.auth_id and f.status = 'verified')) as without_mfa,
        -- Quiet. A business that has stopped trading is either finished with the system or in
        -- trouble with it, and both are worth a call.
        (select greatest(
           coalesce(max(x.date)::timestamptz, 'epoch'::timestamptz),
           coalesce((select max(r.created_at) from public.receipts r where r.tenant_id = t.id), 'epoch'::timestamptz))
           from public.txs x where x.tenant_id = t.id and not x.deleted) as last_activity,
        -- Receipts that stopped moving. A count, because which receipt and for how much is the
        -- business's own business.
        (select count(*) from public.receipt_documents d
          where d.tenant_id = t.id
            and d.state in ('uploading','upload_failed_retryable','ocr_failed_retryable',
                            'needs_manual_review')) as receipts_waiting,
        -- Books that do not agree yet. Again a count: it says the books need attention without
        -- saying anything about the money in them.
        (select count(*) from public.journal_entries e
          where e.tenant_id = t.id and e.status = 'draft') as entries_unposted
      from public.tenants t
    ) base,
    lateral (
      select base.id, base.name, base.active, base.never_opened, base.waiting_to_claim,
             base.without_mfa, base.receipts_waiting, base.entries_unposted,
             base.last_activity,
             (base.last_activity < statement_timestamp() - make_interval(days => v_days)) as quiet,
             -- What to do first. Never opened outranks everything: a business nobody has been
             -- inside is not a business with a problem, it is a sale that has not landed.
             (case when base.never_opened then 100 else 0 end
              + case when not base.active then 50 else 0 end
              + case when base.last_activity < statement_timestamp() - make_interval(days => v_days) then 20 else 0 end
              + least(base.receipts_waiting, 10)
              + least(base.entries_unposted, 10)
              + least(base.without_mfa, 5)) as weight
    ) x;

  return jsonb_build_object('quiet_days', v_days, 'businesses', v_rows,
                            'checked_at', statement_timestamp());
end;
$$;

comment on function public.sarraf_manager_attention(integer) is
  'Which business needs the vendor, and why. Counts and states only — never an amount from anybody''s books.';

grant create on schema public to sarraf_definer;
alter function public.sarraf_manager_attention(integer) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

revoke all on function public.sarraf_manager_attention(integer) from public, anon;
grant execute on function public.sarraf_manager_attention(integer) to authenticated;

commit;
