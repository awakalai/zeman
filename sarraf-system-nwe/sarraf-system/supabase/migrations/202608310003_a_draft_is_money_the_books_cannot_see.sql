-- The two entries the books have never contained (§ stage 6).
--
-- The live database says, and has said since 27 August:
--
--   v_ledger_journal_gaps = 2 (FAIL)   v_journal_drafts = 2 (WARN)
--
--   mtcr13cvgpfdg9  28 Aug  completed  draft  entry_unvalued
--   mtc4exnjokonia  27 Aug  completed  draft  entry_unvalued
--
--   je-tx-mtcr13cvgpfdg9  «نرخی USD بۆ CNY دانەنراوە — ناتوانرێت بە دۆلار هەڵبسەنگێندرێت»
--   je-tx-mtc4exnjokonia  «نرخی USD بۆ CNY دانەنراوە — ناتوانرێت بە دۆلار هەڵبسەنگێندرێت»
--
-- Two completed trades. The money is in the ledger; the double-entry books do not contain it.
-- The trial balance of 157,683.052754 balances only because those entries have no lines at all —
-- they are not unbalanced, they are absent.
--
-- Why it happened: post_transaction_journal values both legs with sarraf_usd_value(), which reads
-- currencies.buy_rate/sell_rate. On those two days CNY had neither, so the entry was written as a
-- draft with the reason on it and no lines — which is right. What was missing is the other half:
--
--   · the trigger fires `after insert or update of status on txs`, and
--   · it refuses to act at all if an entry for the transaction already exists.
--
-- So once an entry is drafted it stays drafted for ever. There is no command anywhere in the
-- system that finishes one. A rate set an hour later changes nothing; the hole simply stays.
--
-- ── What this migration does, and what it does not ───────────────────────────────────────────
--
-- It does NOT change how anything is valued or posted. Not one account, side, spread rule or
-- rounding is altered. The exact body of post_transaction_journal that writes the lines is moved
-- into one function, sarraf_write_transaction_entry_lines, and both the trigger and the new
-- command call it. That way a resolved draft cannot post different books from a live trade: they
-- are literally the same statements. The 297 accounting contracts and the 23 business flows are
-- what prove the results did not move.
--
-- It adds sarraf_resolve_journal_draft(entry_id, command_key): an administrator's command that
-- finishes a draft once the rate exists. It refuses if the entry is not a draft, refuses if the
-- valuation is still impossible, and is idempotent on the command key like every other command.
--
-- ── One thing stated plainly, because it is a judgement and not a rule ────────────────────────
--
-- The valuation uses sarraf_usd_value() unchanged, which reads the rate that is on the currency
-- now — not the rate that was in force on the trade date, which nobody recorded, because that is
-- exactly what was missing. So a trade from 27 August is valued at the rate that finally existed.
-- Rather than hide that, the lines carry rate_source 'currency_mid_at_resolution' instead of
-- 'currency_mid', and the entry's description says when it was resolved. An auditor reading these
-- two entries can see what they are. Introducing a dated valuation would be a new accounting
-- rule, and this is not the place for one.

begin;

-- The body of post_transaction_journal, moved out whole. Called by the trigger for a live trade
-- and by the command below for a draft that can finally be valued. Same statements, same order,
-- same numbers — which is the only way a resolved draft and a live trade can be guaranteed to
-- produce the same books.
-- SECURITY INVOKER, deliberately. It runs in whatever context called it: inside the posting
-- trigger, which fires with no session at all on a seeded row, and inside the administrator's
-- command, where the session is theirs and the tenant policies resolve normally. A definer here
-- would pin one of those two contexts and break the other — which it did, on the first attempt:
-- handed to sarraf_definer it could no longer write journal_lines from the trigger.
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
  -- Where the other leg sits: settled money moves through the safe; an unsettled leg is a
  -- receivable when we are owed, a payable when we owe.
  v_cash := case
    when v_settled then 'acc-1000'
    when p_tx.type = 'buy' then 'acc-2300'   -- we owe the counterparty
    else 'acc-1200'                          -- the counterparty owes us
  end;

  -- The spread is whatever the two valuations differ by, and it is stated, never absorbed.
  v_spread := case when p_tx.type = 'buy'
                   then v_total_usd - v_amount_usd    -- paid more than received = loss
                   else v_total_usd - v_amount_usd    -- received more than given = gain
              end;

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
    -- Paying more than the goods are worth is a loss; paying less is a gain.
    if abs(v_spread) > 0.0000000001 then
      v_line := v_line + 1;
      insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,memo)
      values (p_entry, v_line,
              case when v_spread > 0 then 'acc-5900' else 'acc-4000' end,
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
    -- Receiving more than the goods were worth is the gain.
    if abs(v_spread) > 0.0000000001 then
      v_line := v_line + 1;
      insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate,rate_source,memo)
      values (p_entry, v_line,
              case when v_spread > 0 then 'acc-4000' else 'acc-5900' end,
              (case when v_spread > 0 then 'credit' else 'debit' end)::public.entry_side,
              'USD', abs(v_spread), abs(v_spread), 1, p_rate_source,
              'جیاوازی نرخ لە فرۆشتندا');
    end if;
  end if;

  return v_line;
end;
$$;

comment on function public.sarraf_write_transaction_entry_lines(text, public.txs, text) is
  'The lines of a transaction entry. One copy, called by the posting trigger and by the command that finishes a draft, so the two can never post different books for the same trade.';

-- The trigger, now doing only what a trigger should: decide whether this can be valued, write the
-- entry header, and hand the lines to the function above.
create or replace function public.post_transaction_journal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entry text;
  v_cur_code text; v_against_code text;
  v_amount_usd numeric; v_total_usd numeric;
  v_draft boolean := false;
  v_note text;
begin
  -- A voided transaction is corrected by reversal, which is a separate command.
  if new.deleted then return null; end if;
  -- Only post once per transaction; a later edit does not silently rewrite history.
  if exists (select 1 from public.journal_entries
              where source_type = 'transaction' and source_id = new.id) then
    return null;
  end if;

  select code into v_cur_code from public.currencies where id = new.cur_id;
  select code into v_against_code from public.currencies where id = new.against_id;
  if v_cur_code is null or v_against_code is null then return null; end if;
  if not (abs(new.amount) > 0 and abs(new.total) > 0) then return null; end if;

  v_amount_usd := public.sarraf_usd_value(abs(new.amount), new.cur_id);
  v_total_usd  := public.sarraf_usd_value(abs(new.total), new.against_id);

  if v_amount_usd is null or v_total_usd is null then
    v_draft := true;
    v_note := format('نرخی USD بۆ %s دانەنراوە — ناتوانرێت بە دۆلار هەڵبسەنگێندرێت',
                     coalesce(case when v_amount_usd is null then v_cur_code else v_against_code end, '?'));
  end if;

  v_entry := 'je-tx-' || new.id;

  insert into public.journal_entries(
    id, status, business_date, posted_at, source_type, source_id,
    transaction_id, actor_id, description)
  values (
    v_entry,
    (case when v_draft then 'draft' else 'posted' end)::public.journal_status,
    coalesce(new.date::date, current_date),
    case when v_draft then null else statement_timestamp() end,
    'transaction', new.id, new.id, null,
    left(coalesce(v_note, format('%s %s %s @ %s %s',
      case when new.type = 'buy' then 'کڕین' else 'فرۆشتن' end,
      abs(new.amount), v_cur_code, new.rate, v_against_code)), 500));

  if v_draft then
    -- Record what is known so the entry can be completed once a rate exists, but post nothing.
    return null;
  end if;

  perform public.sarraf_write_transaction_entry_lines(v_entry, new, 'currency_mid');
  return null;
end;
$$;

-- ── Finishing a draft ────────────────────────────────────────────────────────────────────────
--
-- What was missing entirely. An administrator's command, idempotent on its key like every other,
-- that values a stuck entry now that the rate exists and posts it with the same lines a live
-- trade would have produced.
create or replace function public.sarraf_resolve_journal_draft(
  p_entry_id text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_prev jsonb;
  v_entry public.journal_entries%rowtype; v_tx public.txs%rowtype;
  v_lines integer; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may finish a draft entry';
  end if;
  if nullif(btrim(coalesce(p_command_key,'')),'') is null then
    raise exception using errcode='22023', message='a command key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.accounting_commands
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_entry from public.journal_entries where id = p_entry_id for update;
  if not found then
    raise exception using errcode='P0002', message='journal entry not found';
  end if;
  if v_entry.status <> 'draft' then
    -- Not an error worth raising: a second administrator pressing the same button finds it done.
    return jsonb_build_object('entry_id', v_entry.id, 'status', v_entry.status::text,
                              'lines', 0, 'replayed', true);
  end if;
  if v_entry.source_type <> 'transaction' or v_entry.source_id is null then
    raise exception using errcode='22023',
      message='only a transaction entry can be finished this way';
  end if;

  select * into v_tx from public.txs where id = v_entry.source_id and not deleted;
  if not found then
    raise exception using errcode='22023',
      message='the transaction this entry was written for no longer exists';
  end if;

  -- Still unvaluable? Then nothing has changed and the honest answer is to say so, not to post
  -- an entry with lines that do not add up.
  if public.sarraf_usd_value(abs(v_tx.amount), v_tx.cur_id) is null
     or public.sarraf_usd_value(abs(v_tx.total), v_tx.against_id) is null then
    raise exception using errcode='22023',
      message='no USD rate for this currency yet; set the rate first';
  end if;

  -- A draft has no lines. If one somehow does, it is not a draft in the sense this command
  -- understands, and doubling it would be worse than refusing.
  if exists (select 1 from public.journal_lines where entry_id = v_entry.id) then
    raise exception using errcode='22023',
      message='this draft already carries lines; it must be examined by hand';
  end if;

  v_lines := public.sarraf_write_transaction_entry_lines(v_entry.id, v_tx, 'currency_mid_at_resolution');
  if coalesce(v_lines, 0) = 0 then
    raise exception using errcode='22023', message='the entry could not be valued';
  end if;

  update public.journal_entries
     set status = 'posted',
         posted_at = statement_timestamp(),
         description = left(coalesce(description, '') ||
           format(' · بە نرخی %s تەواو کرا', to_char(statement_timestamp(), 'YYYY-MM-DD')), 500)
   where id = v_entry.id;

  perform public.sarraf_write_audit(v_actor.id, 'تەواوکردنی ژورناڵی ڕەشنووس',
    format('%s — %s ھێڵ', v_entry.id, v_lines));

  v_result := jsonb_build_object(
    'entry_id', v_entry.id, 'transaction_id', v_tx.id, 'status', 'posted',
    'lines', v_lines, 'replayed', false);
  insert into public.accounting_commands(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'resolve_journal_draft', v_result);
  return v_result;
end;
$$;

comment on function public.sarraf_resolve_journal_draft(text, text) is
  'Finishes a transaction entry that could not be valued when the trade happened, once the rate exists. Same lines a live trade would have produced; refuses if the rate is still missing.';

grant create on schema public to sarraf_definer;
alter function public.sarraf_resolve_journal_draft(text, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

revoke all on function public.sarraf_write_transaction_entry_lines(text, public.txs, text) from public, anon, authenticated;
revoke all on function public.sarraf_resolve_journal_draft(text, text) from public, anon;
grant execute on function public.sarraf_resolve_journal_draft(text, text) to authenticated;

commit;
