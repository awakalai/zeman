-- «هەر کە درووستکردنی کڕین لەم فیشەوەم کرد ... نووسینگەش کە پارەی ئەو کەسانەی دا ، بڵێ پارەم داوە
--  و ببێت بە قەرز لای من ، و هەر کاتێک ویستم حسابی نووسینگەکە بدەم و تەواو.»
--
-- Two things were wrong, and the second is the serious one.
--
-- The screen asked an office for four presses — بینیم, دەستم پێکرد, پارەم دا, then an amount, a
-- reference, a note and a photograph — and then made an administrator confirm it with a reason of
-- at least eight characters. For one act: the office paid the person, and says so.
--
-- The accounting underneath was worse. Confirming a payment against a transaction posted
--
--     dr acc-2300  قەرزی ZEMAN بۆ کڕیاران
--     cr acc-1000  قاسەی سەرەکی
--
-- and inserted a transaction_payment_events row, whose trigger takes the same money out of the
-- operational ledger as well. Both say ZEMAN's own safe paid. The office paid, from the office's
-- own money. acc-2200 — قەرزی ZEMAN بۆ نووسینگە — sits in the chart of accounts and this path
-- never once credited it, so the debt the owner asks to settle at the end of the week did not
-- exist anywhere: not in the journal, not on the office's account, nowhere. The main safe was
-- reported lower than it was by exactly the amount the office had covered.
--
-- It was not that nobody looked. The accounting gate ran this exact branch and asserted
-- `acc-2300:debit,acc-1000:credit` — it pinned the wrong answer in place, which is worse than no
-- check at all, because it made the mistake look deliberate. The business-flow gate builds a
-- standalone assignment with no transaction behind it and never reaches the branch.
--
-- So: one command, one press, and the debt lands where it belongs.
--
--     dr acc-2300  قەرزی ZEMAN بۆ کڕیاران     the customer is paid
--     cr acc-2200  قەرزی ZEMAN بۆ نووسینگە    and now the office is owed
--
-- No cash moves. Nothing leaves the safe until the owner settles the office's account, and when
-- they do, that account goes to zero — which is the whole of what was asked for.
--
-- The office's word is enough, by the owner's decision: an office is their own staff, and the
-- thing the press creates is a debt against ZEMAN, not a payment out of it. The evidence file,
-- the reference and the administrator's confirmation are gone with it.
-- Paying the office back is its own kind of voucher, not another office payment: one is money
-- the office put out, the other is money coming back to it. The label is added in a transaction
-- of its own, because a new enum value cannot be used in the one that created it.
do $$ begin
  alter type public.voucher_kind add value if not exists 'office_settlement';
exception when others then null; end $$;

begin;

-- ── the settlement, in one place ─────────────────────────────────────────────
--
-- Called by the office's own press below and by the administrator's confirmation, so the two can
-- never post different books for the same event. It is not reachable from a browser: execute is
-- revoked from everybody, and only the definer-owned commands that call it can run it.
create or replace function public.sarraf_office_payment_post(
  p_assignment public.office_payment_assignments, p_actor_id text,
  p_amount numeric, p_reason text, p_command_key text
) returns text
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_entry text; v_a public.office_payment_assignments := p_assignment;
begin
  v_entry := 'je-office-paid-' || md5(p_actor_id || ':' || coalesce(p_command_key,'') || ':' || v_a.id);

  if v_a.transaction_id is not null then
    -- The completion guard on public.txs looks for a posted entry naming the transaction and
    -- carrying source_type 'transaction_settlement'. Without it the purchase stays pending and
    -- the office's payment settles nothing.
    perform public.sarraf_post_simple_entry(
      v_entry, current_date, 'transaction_settlement', p_actor_id,
      'acc-2300', 'acc-2200', v_a.currency, p_amount,
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
  insert into public.account_ledger(id, user_id, kind, cur_id, amount, type, ref_id, note,
                                    command_key, created_by)
  select 'acl-office-' || md5(coalesce(p_command_key,'') || ':' || v_a.id),
         v_a.office_id, 'cash', c.id, p_amount, 'deposit', v_a.transaction_id,
         left(format('نووسینگە پارەی دا — %s', coalesce(nullif(btrim(p_reason),''), v_a.id)), 1000),
         p_command_key, p_actor_id
    from public.currencies c
   where c.code = v_a.currency
   on conflict (id) do nothing;

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

-- ── the press ────────────────────────────────────────────────────────────────
create or replace function public.sarraf_office_payment_paid(
  p_assignment_id text, p_note text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_a public.office_payment_assignments%rowtype;
  v_entry text; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'office' then
    raise exception using errcode='42501', message='only the assigned office may report this payment';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_a from public.office_payment_assignments where id = p_assignment_id for update;
  if not found then raise exception using errcode='P0002', message='assignment not found'; end if;
  if v_actor.id <> v_a.office_id then
    raise exception using errcode='42501', message='this office payment assignment is not yours';
  end if;
  -- Pressing twice is the same payment, not two. The command key already makes a retry safe;
  -- this answers a second press from a second device, where the key is a different one.
  if v_a.status = 'confirmed' then
    return jsonb_build_object('assignment_id', v_a.id, 'status', 'confirmed',
                              'paid', v_a.amount_paid, 'replayed', true);
  end if;
  if v_a.status in ('cancelled','rejected') then
    raise exception using errcode='22023', message='this assignment no longer accepts a payment';
  end if;

  v_entry := public.sarraf_office_payment_post(
    v_a, v_actor.id, v_a.amount, coalesce(nullif(btrim(p_note),''), 'نووسینگە پارەی دا'), p_command_key);

  insert into public.office_payment_events(assignment_id, from_status, to_status, amount_applied,
    reference, note, actor_id, command_key)
  values (v_a.id, v_a.status, 'confirmed', v_a.amount, null,
          left(btrim(p_note), 700), v_actor.id, p_command_key);

  v_result := jsonb_build_object(
    'assignment_id', v_a.id, 'office_id', v_a.office_id, 'currency', v_a.currency,
    'paid', v_a.amount, 'status', 'confirmed', 'journal_entry_id', v_entry,
    'transaction_id', v_a.transaction_id, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'office_payment_paid', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_office_payment_paid(text,text,text) from public, anon;
grant execute on function public.sarraf_office_payment_paid(text,text,text) to authenticated;

-- ── and the administrator's confirmation posts the same books ────────────────
--
-- It is no longer on any screen, but it is still a command, and a command that posts different
-- books for the same event is a second truth waiting to be found. It settles through the same
-- function now, which is where the acc-1000 credit and the cash-draining payment event go.
create or replace function public.sarraf_office_payment_confirm(
  p_assignment_id text, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb; v_a public.office_payment_assignments%rowtype;
  v_entry text; v_result jsonb; v_amount numeric;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may confirm an office payment';
  end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception using errcode='22023', message='a reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || coalesce(p_command_key,''), 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_a from public.office_payment_assignments where id = p_assignment_id for update;
  if not found then raise exception using errcode='P0002', message='assignment not found'; end if;
  if v_a.status = 'confirmed' then
    return jsonb_build_object('assignment_id', v_a.id, 'status', 'confirmed', 'replayed', true);
  end if;
  if v_a.status <> 'paid_reported' then
    raise exception using errcode='22023',
      message=format('the office has not reported a payment yet (the assignment is %s)', v_a.status);
  end if;
  v_amount := coalesce(nullif(v_a.amount_paid, 0), v_a.amount);
  if v_amount is null or v_amount <= 0 then
    raise exception using errcode='22023', message='there is no reported amount to confirm';
  end if;
  if v_actor.id = v_a.office_id then
    raise exception using errcode='42501', message='an office cannot confirm its own payment';
  end if;

  v_entry := public.sarraf_office_payment_post(v_a, v_actor.id, v_amount, btrim(p_reason), p_command_key);

  v_result := jsonb_build_object(
    'assignment_id', v_a.id, 'office_id', v_a.office_id, 'currency', v_a.currency,
    'confirmed_amount', v_amount, 'status', 'confirmed',
    'journal_entry_id', v_entry, 'transaction_id', v_a.transaction_id, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'office_payment_confirm', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_office_payment_confirm(text,text,text) from public, anon;
grant execute on function public.sarraf_office_payment_confirm(text,text,text) to authenticated;

-- One sum, asked three times over three windows. Written once so the day, the week and the month
-- cannot disagree about what counts as paid.
create or replace function public.sarraf_office_paid_since(p_office_id text, p_since timestamptz)
returns jsonb
language sql security definer stable
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amount', total)
                            order by currency), '[]'::jsonb)
    from (select a.currency, sum(a.amount_paid) as total
            from public.office_payment_assignments a
           where a.office_id = p_office_id and a.status = 'confirmed'
             and a.confirmed_at >= p_since
           group by a.currency) s;
$$;
revoke all on function public.sarraf_office_paid_since(text, timestamptz) from public, anon, authenticated;
alter function public.sarraf_office_paid_since(text, timestamptz) owner to sarraf_definer;

-- ── everything the office's screen shows, in one call ───────────────────────
--
-- «بینینی ئەوەی مامەڵيکە هی کێێە و بڕەکەی چەندە و پارەم دا ، لەگەڵ کۆی پارەدانی ڕۆژانە و
--   مانگانە و هەفتانە.»
--
-- An office can read its own assignments and its own account, but not app_users: under row-level
-- security it sees exactly one person there, itself. So the name of the customer whose payment it
-- is has to come from a command, not from a select — and while it is here, it brings the totals
-- and what it is owed, so the screen is one round trip instead of four.
create or replace function public.sarraf_office_board(p_days integer default 60)
returns jsonb
language plpgsql security definer stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_days integer := least(greatest(coalesce(p_days, 60), 1), 400);
  v_since timestamptz;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'office' then
    raise exception using errcode='42501', message='this board belongs to an office';
  end if;
  v_since := date_trunc('day', statement_timestamp()) - make_interval(days => v_days);

  return jsonb_build_object(
    'waiting', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'customer', coalesce(u.name, a.customer_id, '—'),
               'amount', a.amount, 'currency', a.currency, 'assigned_at', a.assigned_at)
             order by a.assigned_at desc)
        from public.office_payment_assignments a
        left join public.app_users u on u.id = a.customer_id
       where a.office_id = v_actor.id
         and a.status not in ('confirmed','cancelled','rejected')), '[]'::jsonb),
    'paid', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'customer', coalesce(u.name, a.customer_id, '—'),
               'amount', a.amount_paid, 'currency', a.currency, 'paid_at', a.confirmed_at)
             order by a.confirmed_at desc)
        from public.office_payment_assignments a
        left join public.app_users u on u.id = a.customer_id
       where a.office_id = v_actor.id and a.status = 'confirmed'
         and a.confirmed_at >= v_since), '[]'::jsonb),
    -- What ZEMAN owes this office right now. It rises with every press and falls to zero when
    -- the owner settles the account; nothing else writes to it.
    'owed', coalesce((
      select jsonb_agg(jsonb_build_object('currency', c.code, 'amount', t.owed) order by c.code)
        from (select cur_id, sum(amount) as owed from public.account_ledger
               where user_id = v_actor.id and kind = 'cash'
               group by cur_id having sum(amount) <> 0) t
        join public.currencies c on c.id = t.cur_id), '[]'::jsonb),
    'totals', jsonb_build_object(
      'day',   public.sarraf_office_paid_since(v_actor.id, date_trunc('day', statement_timestamp())),
      'week',  public.sarraf_office_paid_since(v_actor.id, date_trunc('week', statement_timestamp())),
      'month', public.sarraf_office_paid_since(v_actor.id, date_trunc('month', statement_timestamp()))));
end;
$$;
revoke all on function public.sarraf_office_board(integer) from public, anon;
grant execute on function public.sarraf_office_board(integer) to authenticated;
alter function public.sarraf_office_board(integer) owner to sarraf_definer;

-- ── «هەر کاتێک ویستم حسابی نووسینگەکە بدەم و تەواو» ──────────────────────────
--
-- The other half of the sentence. What the office covered stands as a debt until this runs, and
-- this is the only place cash actually leaves: the safe falls, the office's account falls to
-- meet it, and the liability in the journal is discharged with them. Three books, one command,
-- so none of them can be right while the others are wrong.
create or replace function public.sarraf_office_settle(
  p_office_id text, p_cur_id text, p_amount numeric, p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_office public.app_users%rowtype; v_prev jsonb;
  v_code text; v_owed numeric; v_amount numeric; v_entry text; v_result jsonb;
  v_safe numeric; v_date timestamptz := statement_timestamp();
begin
  v_actor := public.sarraf_require_admin(false);
  perform public.sarraf_assert_writes_open('office_settle');
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_office from public.app_users where id = p_office_id and not deleted;
  if not found or v_office.role <> 'office' then
    raise exception using errcode='22023', message='that is not an office';
  end if;
  select code into v_code from public.currencies where id = p_cur_id;
  if v_code is null then
    raise exception using errcode='22023', message='unknown currency';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zeman:account:' || v_office.id || ':' || p_cur_id, 0));
  select coalesce(sum(amount), 0) into v_owed from public.account_ledger
   where user_id = v_office.id and cur_id = p_cur_id and kind = 'cash';
  if v_owed <= 0 then
    raise exception using errcode='22023', message='this office is owed nothing in that currency';
  end if;
  -- Null means all of it: the button says «حسابی نووسینگە دەدەمەوە», not «pay some of it».
  v_amount := coalesce(nullif(p_amount, 0), v_owed);
  if v_amount <= 0 then
    raise exception using errcode='22023', message='the amount must be more than zero';
  end if;
  if v_amount > v_owed then
    raise exception using errcode='23514', message='that is more than this office is owed';
  end if;

  v_safe := public.sarraf_locked_cash_balance(p_cur_id, null);
  if v_safe - v_amount < -0.0000000001 then
    raise exception using errcode='23514', message='main cashbox has insufficient balance';
  end if;
  perform public.sarraf_assert_period_open(v_date);

  v_entry := 'je-office-settle-' || md5(v_actor.id || ':' || p_command_key || ':' || v_office.id);
  perform public.sarraf_post_simple_entry(
    v_entry, current_date, 'office_settlement', v_actor.id,
    'acc-2200', 'acc-1000', v_code, v_amount,
    public.sarraf_required_ratio(v_code),
    format('حسابی نووسینگە درایەوە — %s %s', v_amount, v_code),
    p_command_key || ':settle', 'office', v_office.id);

  insert into public.account_ledger(id, user_id, kind, cur_id, amount, type, note,
                                    command_key, created_by)
  values ('acl-office-settle-' || md5(p_command_key || ':' || v_office.id),
          v_office.id, 'cash', p_cur_id, -v_amount, 'withdraw',
          left(coalesce(nullif(btrim(p_reason),''), 'حسابی نووسینگە درایەوە'), 1000),
          p_command_key, v_actor.id);
  -- And here the money really does leave the safe, which is the one thing the office's own press
  -- deliberately does not do.
  insert into public.ledger(id, type, cur_id, amount, note, date, command_key, created_by)
  values ('led-office-settle-' || md5(p_command_key || ':' || v_office.id), 'acc_out',
          p_cur_id, -v_amount,
          left(coalesce(nullif(btrim(p_reason),''), 'حسابی نووسینگە درایەوە'), 1000),
          v_date, p_command_key, v_actor.id);

  perform public.sarraf_issue_voucher(
    'office_settlement', 'zeman'::public.party_kind, null,
    'office'::public.party_kind, v_office.id, v_code, v_amount,
    left(coalesce(nullif(btrim(p_reason),''), 'حسابی نووسینگە درایەوە'), 700),
    v_actor.id, null, v_entry, null, null, p_command_key,
    jsonb_build_object('owed_before', v_owed, 'paid', v_amount));
  perform public.sarraf_write_audit(v_actor.id, 'حسابی نووسینگە',
    format('%s %s — %s', v_amount, v_code, v_office.name));

  v_result := jsonb_build_object('office_id', v_office.id, 'currency', v_code,
    'paid', v_amount, 'outstanding', v_owed - v_amount,
    'journal_entry_id', v_entry, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'office_settle', v_result);
  return v_result;
end;
$$;
revoke all on function public.sarraf_office_settle(text,text,numeric,text,text) from public, anon;
grant execute on function public.sarraf_office_settle(text,text,numeric,text,text) to authenticated;
alter function public.sarraf_office_settle(text,text,numeric,text,text) owner to sarraf_definer;

alter function public.sarraf_office_payment_post(
  public.office_payment_assignments, text, numeric, text, text) owner to sarraf_definer;
alter function public.sarraf_office_payment_paid(text,text,text) owner to sarraf_definer;
alter function public.sarraf_office_payment_confirm(text,text,text) owner to sarraf_definer;

commit;
