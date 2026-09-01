-- قاسەی خاوەن دەبێتە باڵانسێکی ڕاستەقینە، نەک کۆکراوەیەکی لێدەرکراو (§8).
--
--   «لە قاسەی خۆم یوان ناقس دەبێت نازانم ئەوە چییە؟»
--
-- ── Why a number nobody can explain ──────────────────────────────────────────────────────────
--
-- The owner's cashbox has never been an account. It is a subtraction, done in the browser:
--
--     atMe[c] = phys[c] − Σ partner[c]                                    src/App.jsx
--
-- fed by this snapshot, where phys is every ledger row for the currency and partner is every row
-- naming a partner. So "the owner's cashbox" has meant, precisely, *the sum of every ledger row
-- that names no partner*. A residual. Nothing constrains a residual to stay positive, and
-- anything the ledger could not describe fell into it.
--
-- Until this week the ledger could not describe much: it had partner_id and nothing else. Money
-- an office was holding, and money sitting in a bank account, were both counted as cash in the
-- owner's own safe, because there was no column that could say otherwise.
--
--   202609010011  ledger.cash_account_id   money at a bank or wallet
--   202609010012  ledger.office_id         money an office is holding
--
-- With those two, the question finally has a direct answer, and it does not need subtracting
-- anything from anything: the owner's safe is the rows that name no partner, no office and no
-- account. owner_safe_by_currency is that sum.
--
-- ── What changes on screen today, and it is nothing ──────────────────────────────────────────
--
-- No row in the live database carries an office_id or a cash_account_id yet — both columns were
-- added days ago and nothing has written to them. So owner_safe_by_currency equals the old
-- residual exactly, for every currency, right now. The figure the owner sees does not move.
--
-- What changes is the future: from here, money sent to an office or held at a bank leaves the
-- cashbox when it leaves, instead of sitting in it until somebody notices. The old
-- physical_by_currency and partner_balances stay in the snapshot untouched, so any reader that
-- still wants the total holding of a currency across every location keeps getting it.

begin;

create or replace function public.sarraf_read_model_snapshot(p_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_actor public.app_users%rowtype;v_days integer;v_inventory jsonb;v_physical jsonb;
  v_partner jsonb;v_investor jsonb;v_paid jsonb;v_self jsonb;v_expenses jsonb;v_fees jsonb;
  v_accounts jsonb;v_pending jsonb;v_profit jsonb;v_counts jsonb;
  v_owner_safe jsonb;v_office jsonb;v_cash_accounts jsonb;
begin
  v_actor:=public.sarraf_require_admin(false);v_days:=least(greatest(coalesce(p_days,30),1),366);
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_physical from (
    select cur_id,round(sum(amount),10) amount from public.ledger group by cur_id) s;

  -- The owner's own safe, asked directly. Not the total minus the partners: the rows that name
  -- nobody else. A balance, which can be reasoned about, rather than a residual, which cannot.
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_owner_safe from (
    select cur_id,round(sum(amount),10) amount from public.ledger
     where partner_id is null and office_id is null and cash_account_id is null
     group by cur_id) s;

  select coalesce(jsonb_agg(to_jsonb(s) order by partner_id,cur_id),'[]'::jsonb) into v_partner from (
    select partner_id,cur_id,round(sum(amount),10) amount from public.ledger
     where partner_id is not null group by partner_id,cur_id) s;

  -- What each office is holding on the owner's behalf, and what is at each bank or wallet.
  select coalesce(jsonb_agg(to_jsonb(s) order by office_id,cur_id),'[]'::jsonb) into v_office from (
    select office_id,cur_id,round(sum(amount),10) amount from public.ledger
     where office_id is not null group by office_id,cur_id
    having round(sum(amount),10) <> 0) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by cash_account_id,cur_id),'[]'::jsonb)
    into v_cash_accounts from (
    select cash_account_id,cur_id,round(sum(amount),10) amount from public.ledger
     where cash_account_id is not null group by cash_account_id,cur_id
    having round(sum(amount),10) <> 0) s;

  select coalesce(jsonb_agg(to_jsonb(s) order by investor_id,cur_id),'[]'::jsonb) into v_investor from (
    select investor_id,cur_id,round(sum(amount),10) amount from public.ledger
     where investor_id is not null and owner='investor' and type in ('deposit','withdraw')
     group by investor_id,cur_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by investor_id,cur_id),'[]'::jsonb) into v_paid from (
    select investor_id,cur_id,round(sum(abs(amount)),10) amount from public.ledger
     where investor_id is not null and type='investor_payout' group by investor_id,cur_id) s;
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_self from (
    select cur_id,round(sum(amount),10) amount from public.ledger
     where owner='self' and type in ('deposit','withdraw') group by cur_id) s;
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_expenses from (
    select cur_id,round(sum(abs(amount)),10) amount from public.ledger
     where type='expense' group by cur_id) s;
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_fees from (
    select cur_id,round(sum(abs(amount)),10) amount from public.ledger
     where type='partner_fee' group by cur_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by user_id,kind,cur_id),'[]'::jsonb) into v_accounts from (
    select user_id,kind,cur_id,round(sum(amount),10) amount from public.account_ledger
     group by user_id,kind,cur_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by cp_id,against_id),'[]'::jsonb) into v_pending from (
    select cp_id,cp_name,against_id,type,round(sum(abs(total)),10) total,count(*) tx_count
      from public.txs where not deleted and status='pending'
     group by cp_id,cp_name,against_id,type) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by cur_id),'[]'::jsonb) into v_profit from (
    select profit_cur_id cur_id,round(sum(profit),10) profit,
           round(sum(profit) filter (where direct),10) direct_profit
      from public.txs where not deleted and profit is not null and profit_cur_id is not null
       and date >= statement_timestamp() - make_interval(days=>v_days)
     group by profit_cur_id) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by cur_id),'[]'::jsonb) into v_inventory from (
    select c.id cur_id, public.sarraf_inventory_snapshot(c.id) snapshot
      from public.currencies c where c.external) s;
  select jsonb_build_object(
    'pending_txs',(select count(*) from public.txs where not deleted and status='pending'),
    'open_approvals',(select count(*) from public.approval_requests where status='pending'),
    'period_days',v_days) into v_counts;
  return jsonb_build_object('generated_at',statement_timestamp(),'physical_by_currency',v_physical,
    'owner_safe_by_currency',v_owner_safe,
    'partner_balances',v_partner,'office_balances',v_office,'cash_account_balances',v_cash_accounts,
    'investor_capital',v_investor,'investor_paid',v_paid,
    'self_capital',v_self,'expenses',v_expenses,'partner_fees',v_fees,
    'account_balances',v_accounts,'pending_customer_balances',v_pending,
    'profit_totals',v_profit,'inventory',v_inventory,'counts',v_counts);
end;
$$;

grant create on schema public to sarraf_definer;
alter function public.sarraf_read_model_snapshot(integer) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
