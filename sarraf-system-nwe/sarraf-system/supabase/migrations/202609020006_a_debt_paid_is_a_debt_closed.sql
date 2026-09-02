-- قەرزەکە دەدەمەوە
--
-- «دەمەوێت زۆر ورد و پڕۆفیشناڵ بێت. وە هەر لەوێوە بتوانم قەرزەکان سفر بکەمەوە، واتا قەرزەکە
--  بدەمەوە، یان نۆتفیکەیشن بۆ ئەوان بنێرم کە ئەوەنە قەرزارن.»
--
-- The debt centre could offset two debts against each other and it could give one up
-- (sarraf_write_off_debt). What it could not do is the ordinary thing: pay it, or be paid.
-- «سفر کردنەوە» by writing a debt off is not the same event — giving up money you are owed is
-- a loss, receiving it is not — and a system that offers only the first invites the owner to
-- record a loss every time somebody actually pays.
--
-- ── Both directions, because a debt has two ─────────────────────────────────────────────────
--
-- A debt owed TO ZEMAN is settled by money arriving: the receivable clears and a holding rises.
-- A debt ZEMAN OWES is settled by money leaving: the payable clears and a holding falls, and
-- the holding must be able to cover it.
--
-- ── The money lands somewhere in particular ─────────────────────────────────────────────────
--
-- Same as every other movement since 202609020004: cash, or a named account. The ledger row
-- carries the holding so قاسە can say where the money went, and the journal carries acc-1000
-- because the chart of accounts has one line for the business's cash, not one per bank.

begin;

create or replace function public.sarraf_settle_debt(
  p_debt_id text, p_amount numeric, p_cash_account_id text, p_note text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_debt public.debts%rowtype;
  v_amount numeric; v_after numeric; v_entry text; v_voucher public.vouchers%rowtype;
  v_accounts record; v_result jsonb; v_we_owe boolean;
  v_cur_id text; v_balance numeric; v_place text; v_place_name text; v_ledger_id text;
begin
  v_actor := public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('settle_debt');

  if p_command_key !~ '^settle-debt:[A-Za-z0-9:_-]{8,200}$' then
    raise exception using errcode='22023', message='invalid settlement command';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key, 0));
  v_prev := public.sarraf_command_replay(v_actor.auth_id, p_command_key, 'settle_debt');
  if v_prev is not null then return v_prev; end if;

  select * into v_debt from public.debts where id = p_debt_id for update;
  if not found then raise exception using errcode='P0002', message='ئەو قەرزە نەدۆزرایەوە'; end if;
  if v_debt.status in ('settled','written_off','void') then
    raise exception using errcode='23514',
      message=format('ئەم قەرزە پێشتر %s بووە', v_debt.status);
  end if;

  -- Paying part of it is ordinary; paying more than is left is not, and silently capping it
  -- would move money the debt does not account for.
  v_amount := coalesce(nullif(p_amount, 0), v_debt.outstanding_principal);
  if v_amount is null or v_amount <= 0 then
    raise exception using errcode='22023', message='بڕێکی دروست بنووسە';
  end if;
  if v_amount > v_debt.outstanding_principal then
    raise exception using errcode='22023',
      message=format('تەنها %s ی ماوە', trim(to_char(v_debt.outstanding_principal,'FM999999999990.00')));
  end if;
  v_after := v_debt.outstanding_principal - v_amount;

  -- ZEMAN is one side of the debt or this command has nothing to say about it.
  if v_debt.creditor_type = 'zeman' then
    v_we_owe := false;
  elsif v_debt.debtor_type = 'zeman' then
    v_we_owe := true;
  else
    raise exception using errcode='22023',
      message='ئەم قەرزە لەنێوان دوو لای دەرەوەیە — ئەم فەرمانە بۆ قەرزی خۆمانە';
  end if;

  select * into v_accounts from public.sarraf_debt_accounts(
    case when v_we_owe then v_debt.creditor_type else v_debt.debtor_type end);
  if not found then
    raise exception using errcode='22023', message='هیچ هەژمارێکی قەرز بۆ ئەم جۆرە لایەنە نییە';
  end if;

  -- The debt names a currency code; the ledger names a currency row.
  select id into v_cur_id from public.currencies where upper(code) = upper(v_debt.currency);
  if v_cur_id is null then
    raise exception using errcode='22023',
      message=format('دراوی %s لەم سیستەمەدا نییە', v_debt.currency);
  end if;

  v_place := nullif(btrim(coalesce(p_cash_account_id,'')), '');
  if v_place is not null then
    select name into v_place_name from public.cash_accounts
     where id = v_place and active and tenant_id = public.sarraf_tenant() and cur_id = v_cur_id;
    if v_place_name is null then
      raise exception using errcode='22023', message='ئەو حسابەی ناوت بردووە نەدۆزرایەوە';
    end if;
  end if;

  -- Money the business does not have cannot leave it, whichever place it was to leave from.
  if v_we_owe then
    v_balance := public.sarraf_locked_holding_balance(v_cur_id, v_place);
    if v_balance < v_amount then
      raise exception using errcode='23514',
        message=format('ئەم شوێنە تەنها %s ی تێدایە', trim(to_char(v_balance,'FM999999999990.00')));
    end if;
  end if;

  v_entry := 'je-settle-' || md5(v_actor.id || ':' || p_command_key || ':' || v_debt.id);
  perform public.sarraf_post_simple_entry(
    v_entry, current_date, 'debt_settlement', v_actor.id,
    case when v_we_owe then v_accounts.payable else 'acc-1000' end,
    case when v_we_owe then 'acc-1000' else v_accounts.receivable end,
    v_debt.currency, v_amount, public.sarraf_required_ratio(v_debt.currency),
    format('%s قەرز — %s %s',
           case when v_we_owe then 'دانەوەی' else 'وەرگرتنەوەی' end, v_amount, v_debt.currency),
    p_command_key || ':settle',
    case when v_we_owe then v_debt.creditor_type::text else v_debt.debtor_type::text end,
    case when v_we_owe then v_debt.creditor_id else v_debt.debtor_id end);

  -- And the money itself, in the place the owner named, so قاسە agrees with the books.
  v_ledger_id := 'led-settle-' || md5(p_command_key || ':' || v_debt.id);
  insert into public.ledger(id, type, cur_id, amount, cash_account_id, note, date,
                            command_key, created_by)
  values (v_ledger_id, case when v_we_owe then 'withdraw' else 'deposit' end,
          v_cur_id, case when v_we_owe then -v_amount else v_amount end, v_place,
          left(coalesce(nullif(btrim(coalesce(p_note,'')),''),
                        format('قەرز %s', v_debt.id)), 1000),
          statement_timestamp(), p_command_key, v_actor.id);

  v_voucher := public.sarraf_issue_voucher(
    'debt_settlement', v_debt.debtor_type, v_debt.debtor_id,
    v_debt.creditor_type, v_debt.creditor_id, v_debt.currency, v_amount,
    left(coalesce(nullif(btrim(coalesce(p_note,'')),''), 'دانەوەی قەرز'), 700),
    v_actor.id, v_debt.id, v_entry, null, null, p_command_key,
    jsonb_build_object('outstanding_before', v_debt.outstanding_principal,
                       'outstanding_after', v_after,
                       'we_owed', v_we_owe, 'place', v_place));

  -- The debt itself is NOT updated here. apply_debt_settlement() owns outstanding_principal,
  -- status and closed_at, and it checks outstanding_before against what it finds — so an update
  -- from this command would have moved the balance out from under the trigger and every
  -- settlement would have failed on its own first press. Through debt_settlements, not straight into debt_events: that table already carries the
  -- trigger that writes the history line, and a second hand-written event would let the two
  -- disagree about the same payment.
  insert into public.debt_settlements(debt_id, amount_applied, outstanding_before,
    outstanding_after, source_kind, journal_entry_id, actor_id, command_key, reason)
  values (v_debt.id, v_amount, v_debt.outstanding_principal, v_after,
          case when v_we_owe then 'cash_paid' else 'cash_received' end,
          v_entry, v_actor.id, p_command_key,
          left(coalesce(nullif(btrim(coalesce(p_note,'')),''), 'دانەوەی قەرز'), 700));

  v_result := jsonb_build_object(
    'debt_id', v_debt.id, 'currency', v_debt.currency, 'settled', v_amount,
    'outstanding_after', v_after, 'we_owed', v_we_owe,
    'status', case when v_after = 0 then 'settled' else 'partially_settled' end,
    'voucher', v_voucher.reference, 'journal_entry_id', v_entry, 'replayed', false);
  return public.sarraf_store_command(v_actor.auth_id, p_command_key, 'settle_debt', v_result);
end;
$$;

comment on function public.sarraf_settle_debt(text,numeric,text,text,text) is
  'دانەوە یان وەرگرتنەوەی قەرزێک بە پارە — پارەکە لە شوێنێکی ناودار دەجوڵێت و قەرزەکە کەم دەبێتەوە یان سفر.';

revoke all on function public.sarraf_settle_debt(text,numeric,text,text,text) from public, anon;
grant execute on function public.sarraf_settle_debt(text,numeric,text,text,text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_settle_debt(text,numeric,text,text,text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
