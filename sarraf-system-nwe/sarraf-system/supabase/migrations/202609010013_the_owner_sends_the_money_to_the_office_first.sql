-- پارە لە قاسەی خاوەنەوە دەچێتە لای نووسینگە، پاشان نووسینگە پارە دەدات (§5.2, §6.1).
--
-- The owner was asked which of two models the books should follow, and chose:
--
--   «بەڵێ، پارە لە قاسەی من دەچێتە لای نووسینگە»
--
-- So: the owner sends money to an office, the office holds it, and when the office pays a
-- customer both balances go to zero. Two events, in that order.
--
-- ── What ran before, and why it was not wrong ────────────────────────────────────────────────
--
-- 202608280025 implements the other order, and implements it properly: the office pays a
-- customer from its OWN money (dr acc-2300 / cr acc-2200 — the office is now owed), and
-- sarraf_office_settle later reimburses it (dr acc-2200 / cr acc-1000). The owner's safe moves
-- only at reimbursement. Both models keep office activity out of the cashbox, which is the rule
-- that matters; they differ in which way round the money goes first. The owner has now said.
--
-- ── What changes, and what deliberately does not ─────────────────────────────────────────────
--
-- sarraf_office_advance is new: it is the first event, and the only place the owner's safe is
-- debited for an office.
--
-- sarraf_office_payment_post is 202608280025's function taken verbatim, with one question added
-- — is this office already holding enough of the owner's money for this payment? If it is, the
-- payment consumes the holding (cr acc-1300) and the office holds that much less. If it is not,
-- every line runs exactly as it did: the office is owed, acc-2200 is credited, and account_ledger
-- records the debt.
--
-- That fallback is what makes this safe against history. No assignment made before this has an
-- advance, so every one of them takes the original path, and no posted entry is reinterpreted.
--
-- Verbatim on purpose. An earlier attempt at this work re-typed the command from an older
-- migration and silently reverted a correction that had already been made — the accounting gate
-- caught it. A long financial command is not something to rewrite when one question needs asking.

begin;

-- ── event one: the owner sends money to an office ────────────────────────────────────────────
create or replace function public.sarraf_office_advance(
  p_office_id text, p_currency_code text, p_amount numeric,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $fn$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_cur text; v_code text;
  v_entry text; v_safe numeric; v_result jsonb;
begin
  v_actor := public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('office_advance');
  if nullif(btrim(coalesce(p_command_key, '')), '') is null then
    raise exception using errcode = '22023', message = 'a command key is required';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception using errcode = '22023', message = 'a reason is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'the amount must be greater than zero';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  if not exists (select 1 from public.app_users
                  where id = p_office_id and role = 'office' and not deleted) then
    raise exception using errcode = '22023', message = 'invalid office';
  end if;
  select id, code into v_cur, v_code from public.currencies
   where upper(code) = upper(btrim(p_currency_code));
  if v_cur is null then
    raise exception using errcode = '22023', message = 'unknown currency';
  end if;

  -- The owner cannot send money the safe does not hold. The safe is every ledger row naming
  -- neither a partner nor an office, which is what the cashbox screen means by «قاسەی گشتی».
  select coalesce(sum(l.amount), 0) into v_safe
    from public.ledger l
   where l.cur_id = v_cur and l.partner_id is null and l.office_id is null;
  if p_amount > v_safe + 0.0000000001 then
    raise exception using errcode = '23514', message = 'the safe does not hold enough',
      detail = format('the safe holds %s %s, the advance needs %s', v_safe, v_code, p_amount);
  end if;

  v_entry := 'je-office-advance-' || md5(v_actor.id || ':' || p_command_key);
  perform public.sarraf_post_simple_entry(
    v_entry, current_date, 'office_advance', v_actor.id,
    'acc-1300', 'acc-1000', v_code, p_amount,
    public.sarraf_required_ratio(v_code),
    format('پارە چووە لای نووسینگە — %s %s', p_amount, v_code),
    p_command_key, 'office', p_office_id, null, current_date);

  -- Out of the safe, into the office. Two rows, equal and opposite, so the business holds the
  -- same money in total — it is simply somewhere else now, and the cashbox says so.
  insert into public.ledger(id, type, cur_id, amount, office_id, note, date,
                            command_key, created_by, tenant_id)
  values ('led-oadv-' || md5(v_actor.id || ':' || p_command_key || ':safe'), 'transfer_out',
          v_cur, -p_amount, null, left(btrim(p_reason), 1000), statement_timestamp(),
          p_command_key, v_actor.id, v_actor.tenant_id),
         ('led-oadv-' || md5(v_actor.id || ':' || p_command_key || ':office'), 'transfer_in',
          v_cur, p_amount, p_office_id, left(btrim(p_reason), 1000), statement_timestamp(),
          p_command_key, v_actor.id, v_actor.tenant_id);

  perform public.sarraf_write_audit(v_actor.id, 'office_advance',
    format('%s %s to office %s', p_amount, v_code, p_office_id));

  v_result := jsonb_build_object('office_id', p_office_id, 'currency', v_code,
    'amount', p_amount, 'journal_entry_id', v_entry, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'office_advance', v_result);
  return v_result;
end;
$fn$;

revoke all on function public.sarraf_office_advance(text, text, numeric, text, text) from public, anon;
grant execute on function public.sarraf_office_advance(text, text, numeric, text, text) to authenticated;

-- ── event two: the office pays, out of what it is holding ────────────────────────────────────

create or replace function public.sarraf_office_payment_post(
  p_assignment public.office_payment_assignments, p_actor_id text,
  p_amount numeric, p_reason text, p_command_key text
) returns text
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_entry text; v_a public.office_payment_assignments := p_assignment;
  v_holding numeric; v_cur text; v_tenant text; v_from_advance boolean;
begin
  v_entry := 'je-office-paid-' || md5(p_actor_id || ':' || coalesce(p_command_key,'') || ':' || v_a.id);

  -- 202609010013: the owner chose model A — money goes to the office first, and the office then
  -- pays out of it. So before posting, ask what this office is actually holding in this currency.
  -- An office with no advance is every assignment made before that migration, and takes the path
  -- below exactly as it always did.
  select id into v_cur from public.currencies where upper(code) = upper(v_a.currency);
  select coalesce(sum(l.amount), 0) into v_holding
    from public.ledger l
   where l.office_id = v_a.office_id and l.cur_id = v_cur;
  v_from_advance := v_holding >= p_amount - 0.0000000001;

  if v_a.transaction_id is not null then
    -- The completion guard on public.txs looks for a posted entry naming the transaction and
    -- carrying source_type 'transaction_settlement'. Without it the purchase stays pending and
    -- the office's payment settles nothing.
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'transaction_settlement', p_actor_id,
      -- Paid out of what the office was already holding, so the holding is consumed and the
      -- owner's safe does not move — it moved when the advance was made. With no advance the
      -- office paid from its own money and is owed, which is the original posting untouched.
      'acc-2300', case when v_from_advance then 'acc-1300' else 'acc-2200' end, v_a.currency, p_amount,
      public.sarraf_required_ratio(v_a.currency),
      format('نووسینگە پارەی دا — %s %s', p_amount, v_a.currency),
      coalesce(p_command_key,'') || ':paid', 'office', v_a.office_id,
      v_a.transaction_id, current_date);
  else
    -- An assignment with no transaction behind it is money the office advanced for something
    -- else. The obligation is the same; there is simply no purchase to complete.
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'office_payment_confirmed', p_actor_id,
      'acc-1300', 'acc-2200', v_a.currency, p_amount,
      public.sarraf_required_ratio(v_a.currency),
      format('نووسینگە پارەی دا — %s %s', p_amount, v_a.currency),
      coalesce(p_command_key,'') || ':paid', 'office', v_a.office_id);
  end if;

  -- What the owner actually reads. The journal is the formal record; this is the office's running
  -- account, the one the «قاسەی نووسینگە» screen shows and the one that goes back to zero when the
  -- owner pays the office. There is deliberately no public.ledger row against it: no cash has
  -- moved in ZEMAN's safe, and writing one would take money out of a safe that is still full.
  if not v_from_advance then
  insert into public.account_ledger(id, user_id, kind, cur_id, amount, type, ref_id, note,
                                    command_key, created_by)
  select 'acl-office-' || md5(coalesce(p_command_key,'') || ':' || v_a.id),
         v_a.office_id, 'cash', c.id, p_amount, 'deposit', v_a.transaction_id,
         left(format('نووسینگە پارەی دا — %s', coalesce(nullif(btrim(p_reason),''), v_a.id)), 1000),
         p_command_key, p_actor_id
    from public.currencies c
   where c.code = v_a.currency
   on conflict (id) do nothing;
  else
    -- The office handed over money it was holding for the owner, so it holds that much less.
    -- This is the ledger row the original deliberately did not write, and the reason it did not
    -- is that under the old model no cash had left the owner. Under an advance it already had.
    select tenant_id into v_tenant from public.app_users where id = p_actor_id;
    insert into public.ledger(id, type, cur_id, amount, office_id, tx_id, note, date,
                              command_key, created_by, tenant_id)
    values ('led-opaid-' || md5(coalesce(p_command_key,'') || ':' || v_a.id), 'transfer_out',
            v_cur, -p_amount, v_a.office_id, v_a.transaction_id,
            'نووسینگە پارەی دا لەو پارەیەی لای بوو', statement_timestamp(),
            coalesce(p_command_key,'') || ':paid', p_actor_id, v_tenant)
    on conflict (id) do nothing;
  end if;

  perform public.sarraf_issue_voucher(
    'office_payment', 'office'::public.party_kind, v_a.office_id,
    'zeman'::public.party_kind, null, v_a.currency, p_amount,
    left(coalesce(nullif(btrim(p_reason),''), 'نووسینگە پارەی دا'), 700),
    p_actor_id, null, v_entry, null, v_a.transaction_id, p_command_key,
    jsonb_build_object('assignment_id', v_a.id, 'paid', p_amount, 'assigned', v_a.amount));

  update public.office_payment_assignments
     set status = 'confirmed', amount_paid = p_amount,
         reported_at = coalesce(reported_at, statement_timestamp()),
         confirmed_by = p_actor_id, confirmed_at = statement_timestamp(),
         payment_note = coalesce(nullif(left(btrim(p_reason), 700), ''), payment_note),
         version = version + 1
   where id = v_a.id;

  if v_a.transaction_id is not null then
    update public.txs set status = 'completed', paid_at = coalesce(paid_at, statement_timestamp())
     where id = v_a.transaction_id and not deleted and status = 'pending';
  end if;

  return v_entry;
end;
$$;

revoke all on function public.sarraf_office_payment_post(
  public.office_payment_assignments, text, numeric, text, text) from public, anon, authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_office_advance(text, text, numeric, text, text) owner to sarraf_definer;
alter function public.sarraf_office_payment_post(
  public.office_payment_assignments, text, numeric, text, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
