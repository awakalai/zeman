-- «سیستەمی پێشگرتن لە دووبارەبوونەوە (Hash)»
--
-- The duplicate check has always accepted an image hash. The browser has always sent null:
--
--   const { data: hit } = await supabase.rpc("check_receipt_dupe", {
--     p_hash: null,
--     p_ref: rn,
--     ...
--
-- So the one rule that catches the same photograph sent twice has never run. What has been
-- running is the reference number — which works right up until the reading fails to find one,
-- and then the whole check is skipped: the browser only asks at all when it has a reference, a
-- merchant order number, or all four of currency, amount, date and payee. An unreadable receipt
-- can therefore be uploaded five times and produce five receipts, and the hash that would have
-- caught every one of them was computed, stored, and passed as null.
--
-- The browser is fixed alongside this. What this changes is what the answer can say.
--
-- ── it looks in both places now ──────────────────────────────────────────────
--
-- The old search read public.receipts, which holds only what has been SENT. A customer who
-- uploads the same image twice in one sitting, or who re-uploads something refused at the door,
-- is matched against nothing — the earlier copy is a receipt_documents row and always was. Both
-- are searched now, and the answer says which: 'sent' outranks 'uploaded', because a duplicate
-- of something already counted is the more serious fact.
--
-- ── and it says which receipt ────────────────────────────────────────────────
--
-- «ژمارەی مامەڵەی … پێشتر تۆمار کراوە» names a reference the customer cannot look up. Every
-- receipt has had a quotable name since 202608280009, so the answer carries it: the person is
-- told ZR-20260827-090243-B06965, and so is the owner, and they are talking about the same
-- piece of paper.
--
-- ── one thing it must not do ─────────────────────────────────────────────────
--
-- Match the receipt being uploaded against itself. The document row is written before the image
-- is read — deliberately, so that a failed reading cannot lose the evidence — so by the time
-- this is asked, the receipt in hand is already in the table it is being compared against.
--
-- Tenancy is unchanged and is worth restating, because the old comment claimed the opposite: this
-- runs as sarraf_definer, which holds no BYPASSRLS, so it sees one business only. 202608280001
-- moved it there precisely because a global search told one buyer that another buyer had already
-- recorded a reference, on a date, by a named person.
begin;

drop function if exists public.check_receipt_dupe(text, text, text, text, numeric, date, text);
drop function if exists public.check_receipt_dupe(text, text, text, text, numeric, date, text, text);

create function public.check_receipt_dupe(
  p_hash text,
  p_ref text,
  p_merchant_ref text default null,
  p_currency text default null,
  p_amount numeric default null,
  p_tx_date date default null,
  p_payee text default null,
  p_exclude_id text default null
)
returns table(id text, d timestamptz, who text, ref text, kind text, matched_key text,
              tracking_code text, source text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_staff boolean := false;
  v_hash text := nullif(btrim(p_hash), '');
  v_ref text := public.sarraf_norm_ref(p_ref);
  v_merchant text := public.sarraf_norm_ref(p_merchant_ref);
  v_cur text := nullif(upper(btrim(coalesce(p_currency, ''))), '');
  v_payee text := public.sarraf_norm_name(p_payee);
  v_exclude text := nullif(btrim(coalesce(p_exclude_id, '')), '');
  v_compound boolean := v_cur is not null and p_amount is not null
                        and p_tx_date is not null and v_payee is not null;
begin
  if v_hash is null and v_ref is null and v_merchant is null and not v_compound then
    return;
  end if;

  select coalesce(a.role in ('admin','office'), false) into v_staff
  from public.app_users a
  where a.auth_id = auth.uid() and not a.deleted;

  return query
  with candidates as (
    -- What has been sent and counted. The stronger fact.
    select r.id, r.created_at, r.uploaded_by, r.ref_no, r.tracking_code, 'sent'::text as source,
      case
        when v_hash is not null and r.image_hash = v_hash then 'image'
        when v_ref is not null and public.sarraf_norm_ref(r.ref_no) = v_ref then 'reference'
        when v_merchant is not null and public.sarraf_norm_ref(r.merchant_order_no) = v_merchant then 'merchant_order'
        else 'compound'
      end as matched_key
    from public.receipts r
    where r.status = 'ok'
      and coalesce(r.counted, true)
      and (v_exclude is null or r.id <> v_exclude)
      and (
        (v_hash is not null and r.image_hash = v_hash)
        or (v_ref is not null and public.sarraf_norm_ref(r.ref_no) = v_ref)
        or (v_merchant is not null and public.sarraf_norm_ref(r.merchant_order_no) = v_merchant)
        or (v_compound
            and upper(r.currency) = v_cur
            and r.amount = p_amount
            and r.tx_date = p_tx_date
            and public.sarraf_norm_name(coalesce(r.receiver, r.sender)) = v_payee)
      )

    union all

    -- What has been uploaded and is still alive. A receipt refused, cancelled or replaced is not
    -- a reason to refuse its successor — that is the whole point of a replacement.
    select d.id, d.received_at, d.uploader_id, e.ref_no, d.tracking_code, 'uploaded'::text,
      case
        when v_hash is not null and d.image_sha256 = v_hash then 'image'
        when v_ref is not null and public.sarraf_norm_ref(e.ref_no) = v_ref then 'reference'
        when v_merchant is not null and public.sarraf_norm_ref(e.merchant_order_no) = v_merchant then 'merchant_order'
        else 'compound'
      end
    from public.receipt_documents d
    left join lateral (
      select x.* from public.receipt_extractions x
       where x.document_id = d.id order by x.version desc limit 1
    ) e on true
    where d.state not in ('rejected','cancelled','failed_terminal','duplicate')
      and d.replaced_by_document_id is null
      and (v_exclude is null or d.id <> v_exclude)
      and not exists (select 1 from public.receipts r2 where r2.id = d.id)
      and (
        (v_hash is not null and d.image_sha256 = v_hash)
        or (v_ref is not null and public.sarraf_norm_ref(e.ref_no) = v_ref)
        or (v_merchant is not null and public.sarraf_norm_ref(e.merchant_order_no) = v_merchant)
        or (v_compound
            and upper(coalesce(e.currency,'')) = v_cur
            and e.net_amount = p_amount
            and e.tx_date = p_tx_date
            and public.sarraf_norm_name(e.payee) = v_payee)
      )
  )
  select c.id,
         c.created_at,
         case when v_staff then coalesce(u.name, c.uploaded_by) else null end,
         c.ref_no,
         -- Three identifiers are proof; four coincidences are a question for a person.
         case when c.matched_key = 'compound' then 'suspect' else 'duplicate' end,
         c.matched_key,
         c.tracking_code,
         c.source
  from candidates c
  left join public.app_users u on u.id = c.uploaded_by
  -- A hard duplicate outranks a suspicion, something already counted outranks something merely
  -- uploaded, and the earliest copy is the original. A caller reading only the first row is told
  -- the strongest true thing.
  order by (c.matched_key = 'compound'), (c.source = 'uploaded'), c.created_at
  limit 1;
end;
$$;

revoke all on function public.check_receipt_dupe(text, text, text, text, numeric, date, text, text) from public, anon;
grant execute on function public.check_receipt_dupe(text, text, text, text, numeric, date, text, text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.check_receipt_dupe(text, text, text, text, numeric, date, text, text)
  owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
