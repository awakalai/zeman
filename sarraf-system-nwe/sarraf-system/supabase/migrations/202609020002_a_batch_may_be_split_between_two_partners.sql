-- هەر هاوبەشێک ئەو فیشانە دەبینێت کە لای ئەو دانراون — نەک فیشی هاوبەشێکی تر.
--
--   «٣ دانەیان دەکەم بە مامەڵەیەک ... و لای هاوبەشێک دایبنێم و وردەکارییەکانیش بچێت بۆ
--    هاوبەشەکە، ٢ دانەکەی تریش بە هەمان شێوە بەڵام لای هاوبەشێکی تر.»
--
-- ── What was wrong, and it was found by executing the sentence above ─────────────────────────
--
-- Splitting a batch across two partners works: sarraf_convert_receipt_batch_to_transaction takes
-- a list of receipt ids, counts what is left, and keeps the batch open until nothing is. All of
-- that was already right and the new business-flow 24 proves it — 100+200+300 to one partner,
-- 400+500 to another, and a receipt already converted refused a second time.
--
-- What was wrong is who may then LOOK at it. sarraf_partner_batch_detail decided the holder with
--
--     order by rbt.created_at limit 1
--
-- which is correct for a batch that went to one partner and wrong for one that was split. The
-- first partner could open it. The second — holding 900 of the 1500 — was told "this receipt
-- batch is not yours". Half the owner's sentence could not happen.
--
-- ── And the other half, which nothing had asked ──────────────────────────────────────────────
--
-- Fixing the refusal alone would have swung it the other way: both partners able to open the
-- batch and both shown ALL of it, so each would see the receipts the owner had placed with the
-- other. Two partners in one batch are two of the owner's counterparties; they are not partners
-- of each other. So a partner is now shown the receipts under the transactions THEY hold, and
-- the totals are computed from those rows — which means the figure a partner reads is the figure
-- they are actually holding.
--
-- Staff, the uploader and the customer still see the batch whole, because for them it is one
-- batch. That distinction is what v_only_mine carries.

begin;

create or replace function public.sarraf_partner_batch_detail(p_batch_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_batch public.receipt_batches%rowtype;
  v_holder text;
  v_is_holder boolean;
  v_only_mine boolean;
  v_holder_count integer;
  v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode = '42501', message = 'batch detail is not authorized';
  end if;

  select * into v_batch from public.receipt_batches where id = p_batch_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'receipt batch not found';
  end if;

  -- Whoever the money ended up with. The conversion's record wins over the batch's own field,
  -- because that is the one written when the transaction was actually made.
  --
  -- A batch may be split. «٣ دانەیان دەکەم بە مامەڵەیەک ... لای هاوبەشێک، ٢ دانەکەی تریش ... لای
  -- هاوبەشێکی تر» — and until now this took `order by created_at limit 1` and called that THE
  -- holder. The first partner could open the batch. The second, holding the larger share of it,
  -- was told 'this receipt batch is not yours'. The business-flow gate reproduces exactly that.
  select rbt.partner_id into v_holder
    from public.receipt_batch_transactions rbt
   where rbt.batch_id = p_batch_id and rbt.partner_id is not null
   order by rbt.created_at limit 1;
  v_holder := coalesce(v_holder, v_batch.partner_id);

  -- Is the caller holding money in this batch at all? Every partner named on any of its
  -- conversions is, and that is the question authorization has to ask.
  v_is_holder := v_actor.id = v_holder or exists (
    select 1 from public.receipt_batch_transactions rbt
     where rbt.batch_id = p_batch_id and rbt.partner_id = v_actor.id);

  if v_actor.role not in ('admin', 'office')
     and not v_is_holder
     and v_actor.id is distinct from v_batch.uploaded_by
     and v_actor.id is distinct from v_batch.customer_id then
    raise exception using errcode = '42501', message = 'this receipt batch is not yours';
  end if;

  -- A partner sees the receipts they are holding, and not the ones the owner placed with
  -- somebody else. Two partners in one batch are two of the owner's counterparties, not
  -- partners of each other, and «هیچ تێکەڵ نابێت» is the owner's own requirement. Staff, the
  -- uploader and the customer see the batch whole, because for them it is one batch.
  select count(distinct rbt.partner_id) into v_holder_count
    from public.receipt_batch_transactions rbt
   where rbt.batch_id = p_batch_id and rbt.partner_id is not null;

  v_only_mine := v_actor.role not in ('admin', 'office')
                 and v_is_holder
                 and v_actor.id is distinct from v_batch.uploaded_by
                 and v_actor.id is distinct from v_batch.customer_id;

  with rows_of as (
    select r.id,
           public.sarraf_payee_name(r.receiver, r.raw, r.sender) as receiver,
           r.tx_date,
           r.tx_time,
           public.sarraf_platform_key(r.platform, r.raw) as platform,
           r.platform as platform_said,
           r.currency,
           coalesce(r.amount, 0) as amount,
           coalesce(r.fee, 0) as fee,
           coalesce(r.net_amount, coalesce(r.amount, 0) - coalesce(r.fee, 0)) as net_amount,
           -- §A: "fee status (with fee / without fee)". A receipt carries a fee or it does not,
           -- and the distinction decides which of the two totals below it belongs to.
           coalesce(r.fee, 0) > 0 as has_fee,
           r.ref_no,
           r.merchant_order_no,
           r.status,
           coalesce(r.counted, true) as counted,
           r.reject_code,
           r.reject_reason,
           r.image_path,
           r.created_at
    from public.receipts r
    where r.batch_id = p_batch_id
      -- When a partner is looking, only the receipts placed with them.
      --
      -- receipts.partner_id is the right field and the only one that is per-receipt: custody
      -- assignment writes it (`update public.receipts set partner_id=v_partner where id=v_item.id`
      -- — the intake item and the receipt share an id), so it says which hand each receipt went
      -- into rather than which hand the batch did.
      --
      -- The `v_holder_count < 2` clause is not a loophole, it is the honest case: a batch that
      -- went to ONE partner has nothing to separate, and its receipts may predate per-receipt
      -- stamping entirely. Filtering those to a null partner_id would show the partner an empty
      -- batch they are demonstrably holding — which is how the first version of this broke
      -- business-flow 14.
      and (not v_only_mine
           or v_holder_count < 2
           or r.partner_id = v_actor.id)
  ), counted_rows as (
    select * from rows_of where counted and status not in ('dup', 'error')
  ), by_platform as (
    select platform, currency,
           count(*) as n,
           sum(amount) as with_fee,
           sum(net_amount) as without_fee,
           sum(fee) as fee
    from counted_rows group by platform, currency
  ), by_receiver as (
    select receiver, currency,
           count(*) as n,
           sum(amount) as with_fee,
           sum(net_amount) as without_fee,
           sum(fee) as fee
    from counted_rows group by receiver, currency
  ), totals as (
    select currency,
           count(*) as n,
           sum(amount) as with_fee,
           sum(net_amount) as without_fee,
           sum(fee) as fee,
           count(*) filter (where has_fee) as with_fee_count,
           count(*) filter (where not has_fee) as without_fee_count
    from counted_rows group by currency
  )
  select jsonb_build_object(
    'batch_id', p_batch_id,
    'direction', v_batch.direction,
    'receipt_stage', v_batch.receipt_stage,
    -- Who is holding the money, and the transaction it was placed under. Null on both means the
    -- batch has not been converted yet, which is a state and not an error.
    -- Reported as the caller sees it: a partner opening their own share is the holder of it.
    'partner_id', case when v_only_mine then v_actor.id else v_holder end,
    'partner_name', (select u.name from public.app_users u
                      where u.id = case when v_only_mine then v_actor.id else v_holder end),
    'transaction_id', (select rbt.transaction_id from public.receipt_batch_transactions rbt
                        where rbt.batch_id = p_batch_id
                          and (not v_only_mine or rbt.partner_id = v_actor.id)
                        order by rbt.created_at limit 1),
    -- How many partners this batch was split across. One is the ordinary case; more than one is
    -- the owner placing different receipts in different hands, and a screen that cannot tell
    -- would show a total that belongs to nobody in particular.
    'holder_count', v_holder_count,
    'is_indirect', v_holder is not null,
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.tx_date desc nulls last, x.created_at desc)
                      from rows_of x), '[]'::jsonb),
    'by_platform', coalesce((select jsonb_agg(to_jsonb(p) order by p.n desc, p.platform)
                             from by_platform p), '[]'::jsonb),
    'by_receiver', coalesce((select jsonb_agg(to_jsonb(b) order by b.n desc, b.receiver)
                             from by_receiver b), '[]'::jsonb),
    'totals', coalesce((select jsonb_agg(to_jsonb(t) order by t.currency) from totals t), '[]'::jsonb),
    'rejected_count', (select count(*) from rows_of where not counted or status in ('dup', 'error'))
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.sarraf_partner_batch_detail(text) from public, anon;
grant execute on function public.sarraf_partner_batch_detail(text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_partner_batch_detail(text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
