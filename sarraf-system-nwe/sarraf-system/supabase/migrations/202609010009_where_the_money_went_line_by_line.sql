-- ڕوونکردنەوەی باڵانس — هەموو جوڵەیەک، هێڵ بە هێڵ (§8).
--
-- The owner reported that the CNY balance in their own cashbox goes negative for no visible
-- reason. This migration does not change the number and does not clamp it. It builds the thing
-- §8 asks for — a view that shows every movement and a running balance — because the honest
-- first move against a balance nobody can explain is to make it explainable.
--
-- ── What the investigation found, recorded here so the next reader does not repeat it ────────
--
-- The owner cashbox is not an account. It is a subtraction, computed in the browser:
--
--     atMe[c] = phys[c] - sum(partner balances for c)              (src/App.jsx)
--
-- fed by the server read model:
--
--     physical_by_currency := sum(amount) from ledger group by cur_id
--     partner_balances     := sum(amount) from ledger where partner_id is not null
--
-- so "the owner's cashbox" means, precisely, the sum of every ledger row that names no partner.
-- Two consequences follow, and both are defects:
--
--   1. There is no office term at all. public.ledger has owner, investor_id and partner_id, and
--      no office or location column of any kind. Money an office is holding on the owner's
--      behalf is therefore counted as money in the owner's cashbox — which is exactly what §5.2
--      forbids, and it is a schema gap, not a arithmetic one.
--
--   2. Nothing ties a withdrawal to the place that holds the money. If CNY arrives under a
--      partner's name and a later sale takes it out with no partner named, the owner's residual
--      goes negative while the partner's balance stays positive. No single transaction is
--      wrong; the balance is negative because it is a residual, and nothing constrains a
--      residual to stay positive.
--
-- ── What this migration deliberately does NOT do ─────────────────────────────────────────────
--
-- It does not add a refusal, and it does not add an office column. §1 forbids guessing
-- accounting behaviour and requires the Owner Acceptance Accounting Matrix before a financial
-- command changes. A constraint that refuses a write is a change to what the business is allowed
-- to do, and the matrix has to say so first. Until then the right deliverable is evidence.
--
-- Read-only, admin-only, tenant-scoped. Nothing here writes.

begin;

-- Every movement behind one currency's balance, with the running total after each.
--
-- p_holder: 'owner'   → rows naming no partner, which is what the cashbox figure means today
--           'partner' → one partner's holdings, with p_holder_id
--           'all'     → every row for the currency
create or replace function public.sarraf_explain_balance(
  p_cur_id text,
  p_holder text default 'owner',
  p_holder_id text default null,
  p_limit integer default 500)
returns table(
  seq bigint, ledger_id text, moved_at timestamptz, entry_type text,
  amount numeric, running_balance numeric, went_negative boolean,
  partner_id text, partner_name text, tx_id text, note text)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $fn$
declare v_holder text := lower(coalesce(p_holder, 'owner'));
begin
  perform public.sarraf_require_admin(false);
  if v_holder not in ('owner', 'partner', 'all') then
    raise exception using errcode = '22023',
      message = 'holder must be owner, partner or all';
  end if;
  if v_holder = 'partner' and p_holder_id is null then
    raise exception using errcode = '22023', message = 'name the partner';
  end if;

  return query
  with movements as (
    select l.id, l.created_at, l.date, l.type::text as entry_type, l.amount,
           l.partner_id, l.tx_id, l.note,
           sum(l.amount) over (order by l.date, l.created_at, l.id
                               rows between unbounded preceding and current row) as running
      from public.ledger l
     where l.cur_id = p_cur_id
       and case v_holder
             when 'owner' then l.partner_id is null
             when 'partner' then l.partner_id = p_holder_id
             else true
           end
  )
  select row_number() over (order by m.date, m.created_at, m.id),
         m.id, coalesce(m.date, m.created_at), m.entry_type, m.amount,
         round(m.running, 10), m.running < 0,
         m.partner_id,
         (select u.name from public.app_users u where u.id = m.partner_id),
         m.tx_id, m.note
    from movements m
   order by m.date, m.created_at, m.id
   limit least(greatest(coalesce(p_limit, 500), 1), 5000);
end;
$fn$;

-- The one question §8 actually asks: which movement took it below zero first?
create or replace function public.sarraf_balance_first_negative(
  p_cur_id text, p_holder text default 'owner', p_holder_id text default null)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $fn$
declare v_row record; v_final numeric;
begin
  perform public.sarraf_require_admin(false);
  select * into v_row
    from public.sarraf_explain_balance(p_cur_id, p_holder, p_holder_id, 5000)
   where went_negative
   order by seq
   limit 1;
  select running_balance into v_final
    from public.sarraf_explain_balance(p_cur_id, p_holder, p_holder_id, 5000)
   order by seq desc limit 1;

  if v_row is null then
    return jsonb_build_object('currency', p_cur_id, 'holder', p_holder,
      'ever_negative', false, 'final_balance', coalesce(v_final, 0));
  end if;
  return jsonb_build_object(
    'currency', p_cur_id, 'holder', p_holder, 'ever_negative', true,
    'final_balance', coalesce(v_final, 0),
    'first_negative', jsonb_build_object(
      'seq', v_row.seq, 'ledger_id', v_row.ledger_id, 'moved_at', v_row.moved_at,
      'entry_type', v_row.entry_type, 'amount', v_row.amount,
      'balance_after', v_row.running_balance, 'transaction', v_row.tx_id,
      'partner', v_row.partner_name, 'note', v_row.note));
end;
$fn$;

revoke all on function public.sarraf_explain_balance(text, text, text, integer) from public, anon;
grant execute on function public.sarraf_explain_balance(text, text, text, integer) to authenticated;
revoke all on function public.sarraf_balance_first_negative(text, text, text) from public, anon;
grant execute on function public.sarraf_balance_first_negative(text, text, text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_explain_balance(text, text, text, integer) owner to sarraf_definer;
alter function public.sarraf_balance_first_negative(text, text, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
