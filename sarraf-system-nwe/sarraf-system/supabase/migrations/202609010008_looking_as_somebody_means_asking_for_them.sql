-- «سەیری بکە وەک» دەبێت داوای ئەو کەسە بکات، نەک داوای خۆی (§9).
--
-- The owner reported that a View As session shows receipts belonging to people it has nothing to
-- do with. They were right, and the row-level security was not the reason. Every policy on
-- receipts, receipt_documents, txs and ledger is correctly scoped, and each _definer policy is
-- restricted to sarraf_definer. What is wrong sits above them.
--
-- View As is a browser state and nothing else — App.jsx holds `viewAs` in useState and derives a
-- role from it. The session's identity never changes. So when an administrator opens the portal
-- as customer X, the portal calls the three loaders it always calls:
--
--   sarraf_my_receipt_intakes_v2      → where uploader_id = my_app_id() or customer_id = my_app_id()
--   sarraf_portal_receipt_summary_v2  → where uploader_id = <the actor> or forwarded to them
--   sarraf_my_forwarded_receipts_v2   → where to_actor_id = my_app_id()
--
-- and each answers the question "what is MINE", where "mine" is the administrator. Customer X's
-- portal therefore fills with the administrator's own receipts. That is the report, exactly: rows
-- unrelated to the person whose screen is being shown. The summary is worse than wrong — it
-- raises 42501 for a non-customer, so the screen shows a failure to somebody who has done nothing.
--
-- ── The fix, and why it is here and not in the browser ───────────────────────────────────────
--
-- A client-side filter would be no fix at all: the rows would still have crossed the wire. So the
-- three functions learn to be asked about somebody, and the server decides whether the asker may
-- ask. sarraf_portal_subject() is the one place that decides:
--
--   · no subject named, or the subject is the caller  → themselves, exactly as before
--   · a subject named by an administrator             → allowed, if same business and a portal role
--   · a subject named by anybody else                 → refused
--
-- A customer therefore cannot name another customer, whatever the browser sends. Behaviour for a
-- real customer or partner signing in normally is unchanged, which is what keeps this safe to
-- deploy: the new argument defaults to null and the old call is still the old call.
--
-- The one-argument versions are dropped rather than left beside the new ones. Two overloads that
-- differ only by a defaulted argument make every one-argument call ambiguous in PostgREST; a
-- single function whose second argument defaults to null accepts both shapes.

begin;

-- Who is this caller allowed to look at? Returns the subject's app_users row, or refuses.
create or replace function public.sarraf_portal_subject(p_subject_id text default null)
returns public.app_users
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $fn$
declare
  v_actor public.app_users%rowtype;
  v_subject public.app_users%rowtype;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode = '42501', message = 'not signed in';
  end if;

  -- Asking about yourself is the ordinary case and needs no privilege.
  if p_subject_id is null or p_subject_id = v_actor.id then
    return v_actor;
  end if;

  -- Naming somebody else is a supervisory act. Only an administrator may do it, and only over a
  -- portal account. Note that an administrator naming another administrator is refused too: this
  -- exists to preview a customer's or partner's screen, not to read a colleague's.
  if v_actor.role <> 'admin' then
    raise exception using errcode = '42501',
      message = 'only an administrator may view the portal as somebody else';
  end if;

  select * into v_subject from public.app_users where id = p_subject_id and not deleted;
  -- The restrictive tenant policy on app_users is what makes this safe across businesses: a row
  -- in another tenant is not visible here, so the lookup simply finds nothing.
  if not found then
    raise exception using errcode = '42501', message = 'no such account in this business';
  end if;
  if v_subject.role not in ('customer', 'partner') then
    raise exception using errcode = '42501',
      message = 'only a customer or partner portal can be viewed this way';
  end if;

  return v_subject;
end;
$fn$;

revoke all on function public.sarraf_portal_subject(text) from public, anon;
grant execute on function public.sarraf_portal_subject(text) to authenticated;

-- ── The three loaders, now asked about a person ──────────────────────────────────────────────

drop function if exists public.sarraf_my_receipt_intakes_v2(integer);
create function public.sarraf_my_receipt_intakes_v2(
  p_limit integer default 50, p_subject_id text default null)
returns table(
  id text, tracking_code text, state public.receipt_state, flow public.receipt_flow,
  received_at timestamptz, ocr_attempts integer, rule_reason text,
  replaced_by_document_id text, replaces_document_id text, replaced_by_tracking_code text)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $fn$
declare v_subject public.app_users%rowtype;
begin
  v_subject := public.sarraf_portal_subject(p_subject_id);
  return query
  select d.id, d.tracking_code, d.state, d.flow, d.received_at, d.ocr_attempts,
    coalesce(nullif(btrim(d.rule_reason), ''), case
      when d.state = 'duplicate' then 'وێنەکە پێشتر تۆمارکراوە'
      when d.state = 'currency_mismatch' then 'دراوی فیشەکە لەگەڵ مامەڵەکە یەک ناگرێتەوە'
      when d.state = 'tamper_suspected' then 'فیشەکە پشکنینی زیاتر پێویستە'
      when d.state = 'rejected' then 'فیشەکە لەلایەن ئەدمینەوە ڕەتکراوەتەوە'
      when d.state = 'needs_manual_review' then 'فیشەکە لە پشکنینی ئەدمیندایە'
      else null
    end),
    d.replaced_by_document_id, d.replaces_document_id,
    (select n.tracking_code from public.receipt_documents n where n.id = d.replaced_by_document_id)
  from public.receipt_documents d
  where d.uploader_id = v_subject.id
     or d.customer_id = v_subject.id
  order by d.received_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$fn$;

revoke all on function public.sarraf_my_receipt_intakes_v2(integer, text) from public, anon;
grant execute on function public.sarraf_my_receipt_intakes_v2(integer, text) to authenticated;

drop function if exists public.sarraf_my_forwarded_receipts_v2(integer);
create function public.sarraf_my_forwarded_receipts_v2(
  p_limit integer default 100, p_subject_id text default null)
returns table(
  document_id text, delivery_status public.delivery_status, forwarded_at timestamptz,
  seen_at timestamptz, storage_path text, currency text,
  gross_amount numeric, order_amount numeric, fee_amount numeric, net_amount numeric,
  ref_no text, merchant_order_no text, tx_date date, transaction_id text,
  rate_value numeric, rate_convention text, rate_date date, rate_version bigint,
  gross_usd numeric, fee_usd numeric, net_usd numeric)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $fn$
declare v_subject public.app_users%rowtype;
begin
  v_subject := public.sarraf_portal_subject(p_subject_id);
  return query
  select f.document_id, f.delivery_status, f.forwarded_at, f.seen_at, d.storage_path,
    x.currency, x.gross_amount, x.order_amount, x.fee_amount, x.net_amount,
    x.ref_no, x.merchant_order_no, x.tx_date, f.transaction_id,
    d.rate_value, d.rate_convention, d.rate_date, d.rate_version,
    case when d.rate_value > 0 then round(x.gross_amount / d.rate_value, 2) end,
    case when d.rate_value > 0 then round(x.fee_amount / d.rate_value, 2) end,
    case when d.rate_value > 0 then round(x.net_amount / d.rate_value, 2) end
  from public.receipt_forwardings f
  join public.receipt_documents d on d.id = f.document_id
  left join lateral (
    select e.* from public.receipt_extractions e where e.document_id = d.id order by e.version desc limit 1
  ) x on true
  where f.to_actor_id = v_subject.id
  order by f.forwarded_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 300);
end;
$fn$;

revoke all on function public.sarraf_my_forwarded_receipts_v2(integer, text) from public, anon;
grant execute on function public.sarraf_my_forwarded_receipts_v2(integer, text) to authenticated;

drop function if exists public.sarraf_portal_receipt_summary_v2(integer);
create function public.sarraf_portal_receipt_summary_v2(
  p_days integer default 365, p_subject_id text default null)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $fn$
declare
  v_subject public.app_users%rowtype;
  v_days integer := least(greatest(coalesce(p_days, 365), 1), 3650);
  v_result jsonb;
begin
  -- The old guard raised 42501 for anybody who was not a customer or partner, which is why an
  -- administrator's View As showed a failure rather than a screen. The rule it was reaching for
  -- is about the SUBJECT, not the caller, and sarraf_portal_subject enforces exactly that.
  v_subject := public.sarraf_portal_subject(p_subject_id);
  if v_subject.role not in ('customer', 'partner') then
    raise exception using errcode = '42501', message = 'portal receipt summary is not authorized';
  end if;
  with visible as (
    select d.*,x.currency,x.gross_amount,x.order_amount,x.fee_amount,x.net_amount,x.ref_no,x.tx_date
    from public.receipt_documents d
    left join lateral (
      select e.* from public.receipt_extractions e where e.document_id=d.id order by e.version desc limit 1
    ) x on true
    where d.received_at>=statement_timestamp()-make_interval(days=>v_days)
      and (d.uploader_id=v_subject.id or exists(
        select 1 from public.receipt_forwardings f where f.document_id=d.id and f.to_actor_id=v_subject.id))
  ), totals as (
    select currency,
      coalesce(sum(gross_amount) filter(where counted),0) total_gross,
      coalesce(sum(fee_amount) filter(where counted),0) total_fee,
      coalesce(sum(net_amount) filter(where counted),0) total_net,
      count(*) filter(where counted) accepted_count,
      count(*) filter(where counted and rate_value is null) pending_rate_count,
      case when count(*) filter(where counted and rate_value is null)=0
        then coalesce(sum(round(gross_amount/rate_value,2)) filter(where counted),0) end total_gross_usd,
      case when count(*) filter(where counted and rate_value is null)=0
        then coalesce(sum(round(fee_amount/rate_value,2)) filter(where counted),0) end total_fee_usd,
      case when count(*) filter(where counted and rate_value is null)=0
        then coalesce(sum(round(net_amount/rate_value,2)) filter(where counted),0) end total_net_usd
    from visible where currency is not null
    group by currency
    having count(*) filter(where counted)>0
  ), recent as (
    select id,currency,net_amount total_net,state::text receipt_stage,received_at created_at,
      1::integer n,case when state in ('rejected','duplicate') then 1 else 0 end rejected_n,
      transaction_id,rate_value,
      case when rate_value>0 then round(net_amount/rate_value,2) end total_net_usd
    from visible order by received_at desc limit 50
  )
  select jsonb_build_object(
    'totals',coalesce((select jsonb_agg(to_jsonb(t) order by t.total_net desc) from totals t),'[]'::jsonb),
    'batches',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from recent r),'[]'::jsonb),
    'batch_count',(select count(*) from visible),
    'accepted_count',(select count(*) from visible where counted),
    'rejected_count',(select count(*) from visible where state in ('rejected','duplicate')),
    'pending_count',(select count(*) from visible where not counted and state not in ('rejected','duplicate'))
  ) into v_result;
  return v_result;
end;
$fn$;

revoke all on function public.sarraf_portal_receipt_summary_v2(integer, text) from public, anon;
grant execute on function public.sarraf_portal_receipt_summary_v2(integer, text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_portal_subject(text) owner to sarraf_definer;
alter function public.sarraf_my_receipt_intakes_v2(integer, text) owner to sarraf_definer;
alter function public.sarraf_my_forwarded_receipts_v2(integer, text) owner to sarraf_definer;
alter function public.sarraf_portal_receipt_summary_v2(integer, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
