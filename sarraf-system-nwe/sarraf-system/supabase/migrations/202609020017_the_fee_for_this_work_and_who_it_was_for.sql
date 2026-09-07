-- هەقی ئەم ئیشە، و بۆ کێ کراوە
--
--   «مامەڵەی عمولە، لە کوێوە دەردەچیت و بۆ کوێ دەچێت یەکسانە بڕەکەی، بەڵام دەبێت
--    چوارگۆشەیەکی تر هەبێت، کە بڕێکی تێدا دابنێم، هەقی ئەم ئیشە... وە ئاماژە بەوەش
--    بکەم کە بۆ چ کەسێکی دەکەم.»
--
-- ── A comment in 202609020005 that has to be withdrawn ──────────────────────────────────────
--
-- That migration removed sarraf_service_transaction and said, in as many words, "There is no
-- fee on the side. There is money leaving one place, arriving in another, and the difference
-- is the earning." The first sentence is wrong and the owner has now said so plainly: the two
-- sides are EQUAL and the earning is a separate figure they type in. The second sentence was a
-- fair reading of what they had said at the time, about selling 100,000 dinars of FIB for
-- 101,000 in cash, and that shape still works. Both are true — a commission trade may earn on
-- the spread, or on a stated fee, or on neither, and it is the owner who decides which. What
-- was wrong was declaring one of them impossible.
--
-- 202609020005 itself is untouched. It is applied and it dropped a function that should stay
-- dropped; only its claim is withdrawn, here and in RELEASE.md.
--
-- ── What is added ───────────────────────────────────────────────────────────────────────────
--
-- Three arguments, and nothing else about the trade changes:
--
--   p_fee_amount     «هەقی ئەم ئیشە» — what the business earned for doing it. Optional; a
--                    trade with no fee behaves exactly as it did before.
--   p_fee_account_id where that fee landed. null means cash, and a named holding must be one
--                    of this business's own and still open — the same rule the money movement
--                    already follows, and the same shape as «ئەم خەرجییە لە کام قاسەوە»
--                    in 202609020010.
--   p_for_party_id   «بۆ چ کەسێکی دەکەم» — written to cp_id, which is the column an ordinary
--                    trade already uses for its counterparty.
--
-- ── The fee is deliberately NOT stored on the transaction row ────────────────────────────────
--
-- Naming somebody in cp_id lets them see the transaction: txs carries a read policy of
-- `cp_id = public.my_app_id()`. That is wanted — section 10 says a customer sees the
-- transactions that are theirs — but sections 10 and 16 both say they must never see what
-- ZEMAN earned. Row-level security is row-level; a fee column on txs would travel to them
-- with the rest of the row.
--
-- So the fee lives where it belongs anyway: a ledger row and a journal entry. Neither is
-- readable by a customer, because ledger_tenant_read admits only an administrator, a partner
-- reading their own, an investor reading their own, and an office. Double entry is the record;
-- a duplicate on the transaction row would only be a second copy that could disagree.
--
-- The fee is charged in the currency that ARRIVED. When the two sides name the same currency,
-- which the owner says is the normal case, there is nothing to choose. When they differ, the
-- side the business is left holding is the side the earning is denominated in.

begin;

drop function if exists public.sarraf_commission_trade(
  text, text, numeric, text, text, numeric, text, text);

create or replace function public.sarraf_commission_trade(
  p_from_account_id text,
  p_from_cur_id     text,
  p_from_amount     numeric,
  p_to_account_id   text,
  p_to_cur_id       text,
  p_to_amount       numeric,
  p_note            text,
  p_command_key     text,
  p_fee_amount      numeric default 0,
  p_fee_account_id  text default null,
  p_for_party_id    text default null
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
  v_from_name text; v_to_name text; v_fee_name text; v_for_name text;
  v_fee numeric;
  v_fee_cur text;
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

  -- «هەقی ئەم ئیشە.» Nothing named is nothing earned, which is a trade the owner did for
  -- free and is allowed. What is not allowed is a fee that is not a number, or below zero.
  v_fee := coalesce(p_fee_amount, 0);
  -- NaN is compared by identity here, not by inequality. In IEEE floating point NaN is the one
  -- value not equal to itself, and `v_fee <> v_fee` is the usual way to catch it — but numeric
  -- in PostgreSQL does not follow IEEE: NaN = NaN is TRUE, and NaN sorts above every number, so
  -- that test silently never fires and neither does a `< 0` test. A fault injection removing
  -- the guard below is what showed it: the check that was meant to prove NaN refused had been
  -- passing for another reason entirely.
  if v_fee = 'NaN'::numeric then
    raise exception using errcode='22023', message='هەقی کار دەبێت ژمارە بێت';
  end if;
  if v_fee < 0 then
    raise exception using errcode='22023', message='هەقی کار ناتوانێت لە سفر کەمتر بێت';
  end if;
  v_fee := round(v_fee, 10);
  v_fee_cur := p_to_cur_id;

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
  if p_fee_account_id is not null then
    select name into v_fee_name from public.cash_accounts
     where id = p_fee_account_id and active and tenant_id = public.sarraf_tenant();
    if v_fee_name is null then
      raise exception using errcode='22023', message='ئەو حسابەی هەقی کاری بۆ دەچێت نەدۆزرایەوە';
    end if;
  end if;

  -- «بۆ چ کەسێکی دەکەم.» Somebody this business knows, in this business.
  if p_for_party_id is not null then
    select name into v_for_name from public.app_users
     where id = p_for_party_id and not deleted and tenant_id = public.sarraf_tenant();
    if v_for_name is null then
      raise exception using errcode='22023', message='ئەو کەسەی ئیشەکەی بۆ کراوە نەدۆزرایەوە';
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
    business_flow, from_account_id, to_account_id, cp_id,
    status, note, date, edited, deleted, direct, own_money)
  values (
    v_tx_id, v_code, 'sell', p_from_cur_id, p_from_amount,
    p_to_amount / p_from_amount, p_to_cur_id, p_to_amount,
    'commission', p_from_account_id, p_to_account_id, p_for_party_id,
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

  -- And the third fact, which is the one the owner asked for: what this work was worth.
  if v_fee > 0 then
    insert into public.ledger(id, type, cur_id, amount, cash_account_id, tx_id, note, date,
                              command_key, created_by)
    values ('led-'||md5(v_tx_id||':fee'), 'commission', v_fee_cur, v_fee,
            p_fee_account_id, v_tx_id,
            left(coalesce('هەقی کار — ' || v_for_name, 'هەقی کار'), 500),
            v_date, p_command_key, v_actor.id);

    perform public.sarraf_post_simple_entry(
      'je-cmxfee-' || v_tx_id, v_date::date, 'commission_fee', v_actor.id,
      'acc-1000', 'acc-4100', v_fee_cur, v_fee, null,
      left(coalesce(format('هەقی ئەم ئیشە بۆ %s', v_for_name), 'هەقی ئەم ئیشە'), 500),
      p_command_key || ':fee',
      case when p_for_party_id is null then null else 'customer' end, p_for_party_id, v_tx_id);
  end if;

  insert into public.audit(id, date, user_id, action, detail)
  values ('cmx-'||md5(v_tx_id), v_date, v_actor.id, 'مامەڵەی عمولە',
    left(format('%s %s لە %s → %s %s بۆ %s%s%s',
      trim(to_char(p_from_amount,'FM999999999990.00')), upper(p_from_cur_id), coalesce(v_from_name,'کاش'),
      trim(to_char(p_to_amount,'FM999999999990.00')), upper(p_to_cur_id), coalesce(v_to_name,'کاش'),
      case when v_fee > 0 then format(' — هەقی کار %s %s',
        trim(to_char(v_fee,'FM999999999990.00')), upper(v_fee_cur)) else '' end,
      case when v_for_name is null then '' else format(' — بۆ %s', v_for_name) end), 700));

  return public.sarraf_store_command(v_actor.auth_id, p_command_key, 'commission_trade',
    jsonb_build_object('transaction_id', v_tx_id, 'code', v_code,
      'from', jsonb_build_object('account', p_from_account_id, 'name', coalesce(v_from_name,'کاش'),
                                 'currency', p_from_cur_id, 'amount', p_from_amount),
      'to',   jsonb_build_object('account', p_to_account_id, 'name', coalesce(v_to_name,'کاش'),
                                 'currency', p_to_cur_id, 'amount', p_to_amount),
      'fee',  jsonb_build_object('amount', v_fee, 'currency', v_fee_cur,
                                 'account', p_fee_account_id, 'name', v_fee_name),
      'for',  case when p_for_party_id is null then null
                   else jsonb_build_object('id', p_for_party_id, 'name', v_for_name) end));
end;
$$;

comment on function public.sarraf_commission_trade(text,text,numeric,text,text,numeric,text,text,numeric,text,text) is
  'مامەڵەی عمولە: پارە لە شوێنێکەوە بۆ شوێنێکی تر دەجوڵێت، هەقی کارەکە بە جیا دادەنرێت، و ئەو کەسەی بۆی کراوە ناوی دەنووسرێت.';

revoke all on function public.sarraf_commission_trade(text,text,numeric,text,text,numeric,text,text,numeric,text,text) from public, anon;
grant execute on function public.sarraf_commission_trade(text,text,numeric,text,text,numeric,text,text,numeric,text,text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_commission_trade(text,text,numeric,text,text,numeric,text,text,numeric,text,text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
