-- عمولەی هاوبەش — بڕەکە خۆم دایدەنێم
--
-- «بڕەکە خۆم دایدەنێم، ئیتر جاری وایە دەیگۆڕم، واتا ڕێکەوتن نییە.»
--
-- The commission a partner is paid for holding money in their account has, until now, been one
-- number stored on the partner's record and applied to every purchase as amount × rate ÷ 100.
-- That is not what the arrangement is. There is no agreed rate; the owner decides an amount
-- each time, and changes it when they want to.
--
-- So the stored rate becomes a default, not a rule. A transaction may carry `partner_fee` — an
-- exact amount in the currency being bought — and when it does, that is the commission: the
-- ledger row, the snapshot on the transaction, and the balance check that runs before anything
-- is written all use the same number.
--
-- ── The three places, and why they must agree ────────────────────────────────────────────────
--
-- sarraf_commit_transactions computes the commission three separate times:
--
--   1. in the pre-flight balance check, to know how much of the partner's custody the purchase
--      actually consumes,
--   2. as partner_fee_snapshot on the transaction row,
--   3. as the `partner_fee` ledger row that moves the money.
--
-- An override honoured in two of the three is worse than an override honoured in none: the
-- check would clear a purchase the ledger then refuses, or clear one it should not have. All
-- three now call the same function, so they cannot drift apart.
--
-- ── Why this is a text substitution and not a rewrite ────────────────────────────────────────
--
-- sarraf_commit_transactions is five hundred lines, and 202608210002 already patched it in
-- place — restating it from 202608180002 would silently undo that fix. The same class of
-- mistake was made once already in this project, rewriting receipt_transition_allowed from a
-- superseded definition and quietly dropping four transitions. So the live definition is read,
-- three exact expressions are replaced, and each replacement must actually change something or
-- the migration refuses to finish.

begin;

-- The commission for one transaction, in the currency being bought.
--
-- Zero unless this is a purchase held by a partner: a sale takes money out of the partner's
-- account rather than putting it in, and there is nothing to pay a commission on.
--
-- `partner_fee` on the transaction is the owner's number for this one purchase. It is refused
-- if it is not a number, if it is negative, or if it is larger than the money itself — a
-- commission bigger than the amount would leave the partner holding less than nothing, and a
-- typed extra digit is exactly how that would happen.
create or replace function public.sarraf_partner_commission(p_tx jsonb)
returns numeric
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  v_partner text; v_amount numeric; v_raw text; v_override numeric; v_rate numeric;
begin
  v_partner := nullif(btrim(p_tx->>'partner_id'), '');
  if v_partner is null or coalesce(p_tx->>'type','') <> 'buy'
     or coalesce((p_tx->>'direct')::boolean, false) then
    return 0;
  end if;
  v_amount := nullif(p_tx->>'amount','')::numeric;
  if v_amount is null or v_amount <= 0 then
    raise exception using errcode='22023', message='commission needs the amount it is taken from';
  end if;

  v_raw := nullif(btrim(p_tx->>'partner_fee'), '');
  if v_raw is not null then
    begin
      v_override := v_raw::numeric;
    exception when others then
      raise exception using errcode='22023', message='عمولەکە ژمارەیەکی دروست نییە';
    end;
    if v_override < 0 then
      raise exception using errcode='23514', message='عمولە ناتوانێت کەمتر لە سفر بێت';
    end if;
    if v_override > v_amount then
      raise exception using errcode='23514',
        message='عمولە ناتوانێت لە بڕی مامەڵەکە زیاتر بێت';
    end if;
    return round(v_override, 10);
  end if;

  select rate into v_rate from public.app_users where id = v_partner;
  return round(v_amount * coalesce(v_rate, 0) / 100, 10);
end;
$$;

-- The percentage that was actually charged, which is what belongs in a snapshot.
--
-- A snapshot naming a rate nobody applied is a trap: a report multiplying amount by it would
-- produce a figure that never happened. On a purchase this is derived from the commission
-- above, so amount × rate ÷ 100 = the fee, override or not. On a sale there is no commission,
-- so the partner's standing rate is recorded exactly as before.
create or replace function public.sarraf_partner_commission_rate(p_tx jsonb)
returns numeric
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_amount numeric; v_fee numeric; v_rate numeric;
begin
  if nullif(btrim(p_tx->>'partner_id'), '') is null then return null; end if;
  if coalesce(p_tx->>'type','') <> 'buy' or coalesce((p_tx->>'direct')::boolean, false) then
    select rate into v_rate from public.app_users where id = nullif(btrim(p_tx->>'partner_id'), '');
    return v_rate;
  end if;
  v_amount := nullif(p_tx->>'amount','')::numeric;
  v_fee := public.sarraf_partner_commission(p_tx);
  return case when v_amount > 0 then round(v_fee / v_amount * 100, 8) else 0 end;
end;
$$;

comment on function public.sarraf_partner_commission(jsonb) is
  'عمولەی هاوبەش بۆ ئەم مامەڵەیە — بڕی دیاریکراو ئەگەر هەبێت، ئەگەرنا ڕێژەی تۆمارکراوی هاوبەشەکە.';
comment on function public.sarraf_partner_commission_rate(jsonb) is
  'ئەو ڕێژە سەدییەی بەڕاستی وەرگیرا، بۆ ئەوەی سنابشۆتەکە درۆ نەکات.';

do $migrate$
declare
  v_src text; v_new text; v_step text;
  v_swaps text[][] := array[
    -- 1. the pre-flight balance check
    array[
      'coalesce((select u.rate from public.app_users u where u.id=e->>''partner_id''),0) partner_rate',
      'public.sarraf_partner_commission(e) partner_fee'],
    array[
      'then amount-case when partner_id is not null then amount*partner_rate/100 else 0 end',
      'then amount-case when partner_id is not null then partner_fee else 0 end'],
    -- 2. the snapshots on the transaction row
    array[
      'case when v_partner is not null then (select rate from public.app_users where id=v_partner) end,',
      'case when v_partner is not null then public.sarraf_partner_commission_rate(x) end,'],
    array[
      'then round(v_amount*(select rate from public.app_users where id=v_partner)/100,10) end,',
      'then public.sarraf_partner_commission(x) end,'],
    -- 3. the ledger row that moves the money
    array[
      'select rate into v_partner_rate from public.app_users where id=v_partner;',
      'v_partner_rate:=public.sarraf_partner_commission_rate(x);'],
    array[
      'v_partner_fee:=round(v_amount*coalesce(v_partner_rate,0)/100,10);',
      'v_partner_fee:=public.sarraf_partner_commission(x);']
  ];
  i integer;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sarraf_commit_transactions'
    and pg_get_function_identity_arguments(p.oid) =
        'p_txs jsonb, p_ledger jsonb, p_batch_id text, p_command_key text, p_action text, p_detail text';
  if v_src is null then
    raise exception 'sarraf_commit_transactions(jsonb,jsonb,text,text,text,text) was not found';
  end if;

  if position('sarraf_partner_commission(' in v_src) > 0 then
    raise notice 'sarraf_commit_transactions already reads the commission from one place';
    return;
  end if;

  v_new := v_src;
  for i in 1 .. array_length(v_swaps, 1) loop
    v_step := replace(v_new, v_swaps[i][1], v_swaps[i][2]);
    if v_step = v_new then
      -- Never leave the function half-changed. Two of the three sites honouring an override and
      -- one not is the failure this whole migration exists to prevent.
      raise exception 'commission substitution % found nothing to replace: %',
        i, left(v_swaps[i][1], 80);
    end if;
    v_new := v_step;
  end loop;

  execute v_new;
end;
$migrate$;

commit;
