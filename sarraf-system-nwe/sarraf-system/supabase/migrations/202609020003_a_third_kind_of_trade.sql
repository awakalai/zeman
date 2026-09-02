-- مامەڵەی عمولە — سێیەم جۆری مامەڵە
--
--   «مامەڵەی عموولە ... من دراوێک دەکڕم یان دەفرۆشم بۆ نموونە ، دەڵێم ٥٠هەزارم بە ئێف ئایبی
--    فرۆشتووە بە ٥١ هەزار ... واتا ٥٠ هەزار لە قاسە دەڕوات ، ٥١ هەزاری کاش دێتە ناوی»
--
--   «١٠٠ هەزار دینار ئێف ئایبی دەفرۆشم بە ١٠١ هەزار دیناری کاش ، لە بەشی کاش زیاد دەبێت و لە
--    بەشی ئێف ئایبی کەم دەکات»
--
-- ── What was built before this, and why it was wrong ────────────────────────────────────────
--
-- 202609010011 read the owner's earlier description as: money passes between an account and the
-- safe, and a SEPARATE fee is charged for moving it. So sarraf_service_transaction takes a
-- principal and a commission as two figures, and posts them to two accounts.
--
-- That is not this business. There is no separate fee. There is a price you give money at and a
-- price you receive it at, and the difference between them is the earning — exactly like a buy
-- and a sell, except that both sides can be the SAME currency held in two different places.
--
-- 100,000 IQD in FIB is not the same money as 100,000 IQD in cash, and the whole trade exists
-- because it is not. The old model could not express that at all.
--
-- ── Why the existing command could not do this ──────────────────────────────────────────────
--
-- sarraf_commit_transactions refuses cur_id = against_id outright, and it is right to: an
-- ordinary trade of dinars for dinars is a typo. It stays exactly as it is. This is a different
-- command with a different rule, because the thing that makes the trade legitimate is that the
-- two sides are held in different PLACES, and the ordinary command has no notion of place.
--
-- ── Where the money is, versus what the books call it ───────────────────────────────────────
--
--   «قاسەی گشتی وەک ئێستا بێت هەر بەس بەشێکی تری بۆ زیادببێت ( پارەی کاش )(پارەی ناو حسابەکانت)»
--
-- An account is part of the safe, not a place outside it. So the journal keeps posting to
-- acc-1000 for both, and public.ledger.cash_account_id is what says which part — the same column
-- the four-holder reconciliation already reads. The books do not gain a new asset account; the
-- safe gains a second drawer.
--
-- The earning is posted to acc-4100 and never acc-4000, so «چەندم لەم ئیشە خێر کردووە» can be
-- answered separately from the trading spread. That separation is the whole point of the report
-- the owner asked for.

begin;

-- ── the fourth shape ───────────────────────────────────────────────────────────────────────
--
-- A widening. Every row that satisfied the old constraint satisfies this one, so no existing
-- transaction can be invalidated by applying it.
alter table public.txs
  add column if not exists from_account_id text references public.cash_accounts(id),
  add column if not exists to_account_id   text references public.cash_accounts(id);

comment on column public.txs.from_account_id is
  'مامەڵەی عمولە: ئەو حسابەی پارەکەی لێ دەرچووە. null واتا کاش.';
comment on column public.txs.to_account_id is
  'مامەڵەی عمولە: ئەو حسابەی پارەکەی بۆ چووە. null واتا کاش.';

-- The table has carried an unnamed `check (cur_id <> against_id)` since the legacy baseline,
-- which PostgreSQL named txs_check. It is right for an ordinary trade — dinars for dinars is a
-- typo — and it is exactly what makes a commission trade impossible, because there the two
-- sides being the same currency is the normal case. Replaced by the same rule with one
-- exception, so nothing else loses the protection.
alter table public.txs drop constraint if exists txs_check;
alter table public.txs drop constraint if exists txs_currencies_differ_ck;
alter table public.txs add constraint txs_currencies_differ_ck check (
  cur_id <> against_id or business_flow = 'commission'
);

alter table public.txs drop constraint if exists txs_business_flow_ck;
alter table public.txs add constraint txs_business_flow_ck check (
  (business_flow='partner_custody' and not direct and not own_money and partner_id is not null)
  or (business_flow='owner_cashbox' and direct and own_money and partner_id is null)
  or (business_flow='standard' and not direct and not own_money and partner_id is null)
  or (business_flow='commission' and not direct and not own_money and partner_id is null)
);

-- A commission trade is the only shape where the two sides may name the same currency, and it
-- is only legitimate because they name different places. Both facts in one constraint.
alter table public.txs drop constraint if exists txs_commission_holdings_ck;
alter table public.txs add constraint txs_commission_holdings_ck check (
  business_flow <> 'commission'
  or (cur_id <> against_id
      or from_account_id is distinct from to_account_id)
);

alter table public.txs drop constraint if exists txs_holdings_only_for_commission_ck;
alter table public.txs add constraint txs_holdings_only_for_commission_ck check (
  business_flow = 'commission'
  or (from_account_id is null and to_account_id is null)
);

-- ── the guard learns the fourth shape ──────────────────────────────────────────────────────
--
-- The label is still derived rather than trusted, exactly as before. A commission trade is
-- recognised by carrying a holding on at least one side — which is the thing that makes it one.
create or replace function public.enforce_transaction_business_flow()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_derived text;
begin
  new.direct := coalesce(new.direct,false);
  new.own_money := coalesce(new.own_money,false);
  v_derived := case
    when new.direct then 'owner_cashbox'
    when new.partner_id is not null then 'partner_custody'
    when new.business_flow = 'commission' then 'commission'
    else 'standard'
  end;

  if new.business_flow is not null and new.business_flow <> v_derived then
    raise exception using errcode='23514',
      message='transaction business flow contradicts its custody fields';
  end if;
  new.business_flow := v_derived;

  if v_derived='partner_custody' then
    if new.own_money or new.pair_id is not null or new.direct_role is not null then
      raise exception using errcode='23514',
        message='a partner-custody transaction cannot carry direct-trade fields';
    end if;
    if not exists(select 1 from public.app_users
                  where id=new.partner_id and role='partner' and not deleted) then
      raise exception using errcode='22023', message='transaction custody partner is invalid';
    end if;
  elsif v_derived='owner_cashbox' then
    if not new.own_money or new.partner_id is not null
       or nullif(btrim(coalesce(new.pair_id,'')),'') is null
       or new.direct_role not in ('buy','sell')
       or new.direct_role is distinct from new.type then
      raise exception using errcode='23514',
        message='an owner-cashbox transaction requires one valid paired buy/sell role and no partner';
    end if;
  elsif v_derived='commission' then
    if new.own_money or new.pair_id is not null or new.direct_role is not null
       or new.partner_id is not null then
      raise exception using errcode='23514',
        message='a commission transaction cannot carry direct-trade or custody fields';
    end if;
    -- Same money in the same place on both sides is not a trade, it is a typo.
    if new.cur_id = new.against_id and new.from_account_id is not distinct from new.to_account_id then
      raise exception using errcode='23514',
        message='a commission trade must move money between two different places';
    end if;
  elsif new.own_money or new.pair_id is not null or new.direct_role is not null then
    raise exception using errcode='23514',
      message='a standard transaction cannot carry direct-trade fields';
  end if;
  return new;
end;
$$;

-- ── the earning has its own account ────────────────────────────────────────────────────────
--
--   «دەبێت لە ڕاپۆرتدا هەموو خێرێک هەبێت کە لەم ئیشە یان هەر ئیشێکی تر چەندم خێر کردووە»
--
-- One number for "profit" cannot answer that. A commission trade's difference goes to acc-4100
-- (داهاتی فی) and a trading spread goes to acc-4000 (قازانجی ئاڵوگۆڕ), so the report can say
-- which work produced which money instead of adding them together and losing the question.
--
-- Everything else about the posting is unchanged: the same two legs, the same valuation, the
-- same rate source. Only the account the difference lands in depends on the kind of trade.
create or replace function public.sarraf_write_transaction_entry_lines(
  p_entry text, p_tx public.txs, p_rate_source text default 'currency_mid'
) returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_cur_code text; v_against_code text;
  v_amount numeric; v_total numeric;
  v_amount_usd numeric; v_total_usd numeric;
  v_rate_cur numeric; v_rate_against numeric;
  v_spread numeric;
  v_inventory constant text := 'acc-1400';
  v_cash text; v_settled boolean;
  v_line int := 0;
  -- The two homes a difference can have, chosen by what kind of work earned it.
  v_gain text; v_loss text;
begin
  select code into v_cur_code from public.currencies where id = p_tx.cur_id;
  select code into v_against_code from public.currencies where id = p_tx.against_id;
  if v_cur_code is null or v_against_code is null then return 0; end if;

  v_amount := abs(p_tx.amount);
  v_total  := abs(p_tx.total);
  if not (v_amount > 0 and v_total > 0) then return 0; end if;

  v_amount_usd := public.sarraf_usd_value(v_amount, p_tx.cur_id);
  v_total_usd  := public.sarraf_usd_value(v_total, p_tx.against_id);
  if v_amount_usd is null or v_total_usd is null then return 0; end if;

  v_settled := p_tx.status = 'completed';
  v_cash := case
    when v_settled then 'acc-1000'
    when p_tx.type = 'buy' then 'acc-2300'
    else 'acc-1200'
  end;

  v_gain := case when p_tx.business_flow = 'commission' then 'acc-4100' else 'acc-4000' end;
  v_loss := 'acc-5900';

  v_spread := v_total_usd - v_amount_usd;

  v_rate_cur := case when lower(p_tx.cur_id) = 'usd' then 1 else v_amount / nullif(v_amount_usd, 0) end;
  v_rate_against := case when lower(p_tx.against_id) = 'usd' then 1 else v_total / nullif(v_total_usd, 0) end;

  if p_tx.type = 'buy' then
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (p_entry, v_line, v_inventory, 'debit', v_cur_code, v_amount, v_amount_usd, v_rate_cur,
            p_rate_source, case when p_tx.partner_id is not null then 'partner' end, p_tx.partner_id,
            'دراوی کڕدراو هاتە ژوورەوە');
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (p_entry, v_line, v_cash, 'credit', v_against_code, v_total, v_total_usd, v_rate_against,
            p_rate_source, case when p_tx.cp_id is not null then 'customer' end, p_tx.cp_id,
            case when v_settled then 'پارە درا' else 'پارە هێشتا نەدراوە' end);
    if abs(v_spread) > 0.0000000001 then
      v_line := v_line + 1;
      insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,memo)
      values (p_entry, v_line,
              case when v_spread > 0 then v_loss else v_gain end,
              (case when v_spread > 0 then 'debit' else 'credit' end)::public.entry_side,
              'USD', abs(v_spread), abs(v_spread), 1, p_rate_source,
              'جیاوازی نرخ لە کڕیندا');
    end if;
  else
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (p_entry, v_line, v_cash, 'debit', v_against_code, v_total, v_total_usd, v_rate_against,
            p_rate_source, case when p_tx.cp_id is not null then 'customer' end, p_tx.cp_id,
            case when v_settled then 'پارە وەرگیرا' else 'پارە هێشتا وەرنەگیراوە' end);
    v_line := v_line + 1;
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,party_type,party_id,memo)
    values (p_entry, v_line, v_inventory, 'credit', v_cur_code, v_amount, v_amount_usd, v_rate_cur,
            p_rate_source, case when p_tx.partner_id is not null then 'partner' end, p_tx.partner_id,
            'دراوی فرۆشراو چووە دەرەوە');
    if abs(v_spread) > 0.0000000001 then
      v_line := v_line + 1;
      insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,memo)
      values (p_entry, v_line,
              case when v_spread > 0 then v_gain else v_loss end,
              (case when v_spread > 0 then 'credit' else 'debit' end)::public.entry_side,
              'USD', abs(v_spread), abs(v_spread), 1, p_rate_source,
              case when p_tx.business_flow = 'commission'
                   then 'خێری مامەڵەی عمولە' else 'جیاوازی نرخ لە فرۆشتندا' end);
    end if;
  end if;
  return v_line;
end;
$$;

-- ── the command ────────────────────────────────────────────────────────────────────────────
--
-- One press: money leaves one place, arrives in another, and the difference is recorded as the
-- earning. The four shapes the owner named are all one command, because they are one trade with
-- different endpoints:
--
--   حساب → کاش      ١٠٠٬٠٠٠ دینار لە ئێف ئایبی → ١٠١٬٠٠٠ دیناری کاش
--   کاش → حساب      بەپێچەوانەوە
--   حساب → حساب     ئێف ئایبی → کی کارد
--   دراوی جیاواز    ٥٠٬٠٠٠ دینار لە ئێف ئایبی → ٣٥ دۆلاری کاش
--
-- What it will not do is let money leave a place that does not have it. The balance is read
-- under a lock taken on the holding, so two presses at once cannot both spend the same money.
create or replace function public.sarraf_commission_trade(
  p_from_account_id text,
  p_from_cur_id     text,
  p_from_amount     numeric,
  p_to_account_id   text,
  p_to_cur_id       text,
  p_to_amount       numeric,
  p_note            text,
  p_command_key     text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_previous jsonb;
  v_tx_id text;
  v_code integer;
  v_from_balance numeric;
  v_from_name text; v_to_name text;
  v_date constant timestamptz := statement_timestamp();
begin
  v_actor := public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('commission_trade');

  if p_command_key !~ '^commission:[A-Za-z0-9:_-]{8,200}$' then
    raise exception using errcode='22023', message='invalid commission command';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key,0));
  v_previous := public.sarraf_command_replay(v_actor.auth_id, p_command_key, 'commission_trade');
  if v_previous is not null then return v_previous; end if;

  if p_from_amount is null or p_from_amount <= 0 or p_to_amount is null or p_to_amount <= 0 then
    raise exception using errcode='22023', message='بڕێکی دروست بنووسە';
  end if;
  if not exists (select 1 from public.currencies where id = p_from_cur_id)
     or not exists (select 1 from public.currencies where id = p_to_cur_id) then
    raise exception using errcode='22023', message='دراوێکی دروست هەڵبژێرە';
  end if;

  -- A holding named must be one of this business's own, and still open.
  if p_from_account_id is not null then
    select name into v_from_name from public.cash_accounts
     where id = p_from_account_id and active and tenant_id = public.sarraf_tenant();
    if v_from_name is null then
      raise exception using errcode='22023', message='ئەو حسابەی پارەکەی لێ دەردەچێت نەدۆزرایەوە';
    end if;
  end if;
  if p_to_account_id is not null then
    select name into v_to_name from public.cash_accounts
     where id = p_to_account_id and active and tenant_id = public.sarraf_tenant();
    if v_to_name is null then
      raise exception using errcode='22023', message='ئەو حسابەی پارەکەی بۆ دەچێت نەدۆزرایەوە';
    end if;
  end if;

  if p_from_cur_id = p_to_cur_id and p_from_account_id is not distinct from p_to_account_id then
    raise exception using errcode='22023',
      message='پارەکە دەبێت لە شوێنێکەوە بۆ شوێنێکی تر بجوڵێت';
  end if;

  -- Under a lock on the source, so two presses cannot both spend it.
  perform pg_advisory_xact_lock(
    hashtextextended('zeman:holding:'||coalesce(p_from_account_id,'cash')||':'||p_from_cur_id, 0));
  select coalesce(sum(amount), 0) into v_from_balance
    from public.ledger
   where cur_id = p_from_cur_id
     and partner_id is null and office_id is null
     and cash_account_id is not distinct from p_from_account_id;
  if v_from_balance < p_from_amount then
    raise exception using errcode='22023',
      message=format('ئەم شوێنە تەنها %s ی تێدایە', trim(to_char(v_from_balance,'FM999999999990.00')));
  end if;

  v_tx_id := 'cmx' || substr(md5(p_command_key || clock_timestamp()::text), 1, 12);
  select coalesce(max(code),0) + 1 into v_code from public.txs;

  insert into public.txs(
    id, code, type, cur_id, amount, rate, against_id, total,
    business_flow, from_account_id, to_account_id,
    status, note, date, edited, deleted, direct, own_money)
  values (
    v_tx_id, v_code, 'sell', p_from_cur_id, p_from_amount,
    p_to_amount / p_from_amount, p_to_cur_id, p_to_amount,
    'commission', p_from_account_id, p_to_account_id,
    'completed', left(nullif(btrim(coalesce(p_note,'')),''), 1000), v_date,
    false, false, false, false);

  -- Two ledger rows: the money leaves one place and arrives in another. Nothing is netted,
  -- because «لە بەشی کاش زیاد دەبێت و لە بەشی ئێف ئایبی کەم دەکات» is two facts, not one.
  insert into public.ledger(id, type, cur_id, amount, cash_account_id, tx_id, note, date,
                            command_key, created_by)
  values ('led-'||md5(v_tx_id||':from'), 'commission_out', p_from_cur_id, -p_from_amount,
          p_from_account_id, v_tx_id, coalesce(v_from_name, 'کاش'), v_date, p_command_key, v_actor.id);
  insert into public.ledger(id, type, cur_id, amount, cash_account_id, tx_id, note, date,
                            command_key, created_by)
  values ('led-'||md5(v_tx_id||':to'), 'commission_in', p_to_cur_id, p_to_amount,
          p_to_account_id, v_tx_id, coalesce(v_to_name, 'کاش'), v_date, p_command_key, v_actor.id);

  insert into public.audit(id, date, user_id, action, detail)
  values ('cmx-'||md5(v_tx_id), v_date, v_actor.id, 'مامەڵەی عمولە',
    left(format('%s %s لە %s → %s %s بۆ %s',
      trim(to_char(p_from_amount,'FM999999999990.00')), upper(p_from_cur_id), coalesce(v_from_name,'کاش'),
      trim(to_char(p_to_amount,'FM999999999990.00')), upper(p_to_cur_id), coalesce(v_to_name,'کاش')), 700));

  return public.sarraf_store_command(v_actor.auth_id, p_command_key, 'commission_trade',
    jsonb_build_object('transaction_id', v_tx_id, 'code', v_code,
      'from', jsonb_build_object('account', p_from_account_id, 'name', coalesce(v_from_name,'کاش'),
                                 'currency', p_from_cur_id, 'amount', p_from_amount),
      'to',   jsonb_build_object('account', p_to_account_id, 'name', coalesce(v_to_name,'کاش'),
                                 'currency', p_to_cur_id, 'amount', p_to_amount)));
end;
$$;

comment on function public.sarraf_commission_trade(text,text,numeric,text,text,numeric,text,text) is
  'مامەڵەی عمولە: پارە لە شوێنێکەوە بۆ شوێنێکی تر دەجوڵێت و جیاوازییەکە خێرەکەیە. حساب→کاش، کاش→حساب، حساب→حساب، و دراوی جیاواز.';

revoke all on function public.sarraf_commission_trade(text,text,numeric,text,text,numeric,text,text) from public, anon;
grant execute on function public.sarraf_commission_trade(text,text,numeric,text,text,numeric,text,text) to authenticated;

commit;
