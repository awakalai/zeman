-- قاسەی تایبەتی خۆم — ژمارەیەک کە سێرڤەرەکەش دەیزانێت
--
--   «قاسەی تایبەتی خۆم ئەو قاسەیە کە تەنها پارەی خۆمی تیایە، قاسەی گشتیش هەم پارەکانی خۆم و
--    هەم پارەی وەبەرهێنەرەکانی شەریکمە.»
--   «تەنها مامەڵەی ئاسایی پارەکەی لە قاسەی گشتییەوەیە، ئەوانی دیکە هی خۆمە تەنها.»
--
-- One physical safe, two claims on it. An ordinary trade is funded by the general safe, which
-- is everybody's. A direct trade and a commission trade are the owner's own — and their whole
-- earning is the owner's own too, which is exactly why the money behind them has to be.
--
-- Until now nothing stopped one. The sufficiency check asks whether the money is physically in
-- the safe, and it always is: a direct pair buys and sells in the same command, so its net
-- effect on the safe is the profit, never a withdrawal. An owner with 200 of their own dollars
-- could put 10,000 of their investors' dollars through a trade and keep every unit of what it
-- made.
--
-- ── The figure, and why it must exist twice ──────────────────────────────────────────────────
--
-- «قاسەی تایبەتی خۆم» has only ever been a subtraction done in the browser:
--
--     mySafe[c] = selfCap[c] + (sharedProfit[c] − investors[c]) + ownProfit[c]
--                 − expenses[c] − fees[c]                                        src/App.jsx
--
-- A rule the server enforces cannot read a number the browser computed, so the same figure has
-- to exist here. Two implementations of one number is a real hazard, and it is answered the
-- only honest way: verify:accounting runs a scenario through both and refuses to pass unless
-- they agree to the last unit.
--
-- The investors' share is the hard half, and it is not a percentage of a total — it is summed
-- event by event, each one weighted by the capital standing on ITS OWN day, so somebody who
-- was not there for a sale takes none of it. src/services/investorShare.js is the definition;
-- this mirrors it, including the two things that are easy to get wrong:
--
--   · a negative capital balance weighs zero, never negative, or the others would share more
--     than the whole event;
--   · an expense paid out of the general safe is a NEGATIVE event in the same pool, shared by
--     the same rule — «خەرجی لە قاسەی گشتی — بەڵێ، بەپێی ڕێژەکەیان».

begin;

create or replace function public.sarraf_investors_share(p_cur_id text)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  -- Every event the shared pool is made of: what the sales earned, and what the general safe
  -- paid out. One list, because a share computed from only the good half is not a share.
  with pool as (
    select t.date, t.profit amount
      from public.txs t
     where not t.deleted and not t.direct and t.type = 'sell'
       and t.profit is not null and t.profit_cur_id = p_cur_id
    union all
    select l.date, l.amount
      from public.ledger l
     where l.type = 'expense' and l.paid_from = 'general' and l.cur_id = p_cur_id
  ),
  -- Capital as it stood on the day of each event. A row that is not an investor's is the
  -- owner's, which is what capitalEventsFrom() does with anything not marked 'investor'.
  weighted as (
    select p.amount,
           greatest(0, coalesce((
             select sum(l.amount) from public.ledger l
              where l.cur_id = p_cur_id and l.type in ('deposit','withdraw')
                and l.owner is distinct from 'investor' and l.date <= p.date), 0)) own_weight,
           (select coalesce(jsonb_object_agg(w.id, w.weight), '{}'::jsonb) from (
              select u.id, greatest(0, coalesce((
                       select sum(l.amount) from public.ledger l
                        where l.cur_id = p_cur_id and l.type in ('deposit','withdraw')
                          and l.owner = 'investor' and l.investor_id = u.id
                          and l.date <= p.date), 0)) weight
                from public.app_users u
               where u.role = 'investor' and not u.deleted
                 and (u.scope_curs = '{}'::text[] or p_cur_id = any(u.scope_curs))) w) weights,
           p.date
      from pool p
  )
  select coalesce(sum(
    case when w.own_weight + coalesce((select sum((value)::numeric)
                                        from jsonb_each_text(w.weights)), 0) <= 0 then 0
    else coalesce((
      select sum(w.amount * ((e.value)::numeric
              / (w.own_weight + (select sum((v.value)::numeric) from jsonb_each_text(w.weights) v)))
              * coalesce(u.rate, 0) / 100)
        from jsonb_each_text(w.weights) e
        join public.app_users u on u.id = e.key
       where (e.value)::numeric > 0), 0)
    end), 0)
  from weighted w;
$$;

comment on function public.sarraf_investors_share(text) is
  'بەشی هەموو وەبەرهێنەرەکان لە خێری هاوبەشی ئەم دراوە، هەر ڕووداوێک بەپێی سەرمایەی هەمان ڕۆژ.';

-- «قاسەی تایبەتی خۆم»، بە هەمان پێناسەی شاشەکە.
create or replace function public.sarraf_owner_own_money(p_cur_id text)
returns numeric
language sql stable
set search_path = pg_catalog, public
as $$
  select round(
      coalesce((select sum(amount) from public.ledger
                 where cur_id = p_cur_id and owner = 'self'
                   and type in ('deposit','withdraw')), 0)
    + coalesce((select sum(profit) from public.txs
                 where not deleted and not direct and type = 'sell'
                   and profit is not null and profit_cur_id = p_cur_id), 0)
    - public.sarraf_investors_share(p_cur_id)
    + coalesce((select sum(profit) from public.txs
                 where not deleted and direct and profit is not null
                   and profit_cur_id = p_cur_id), 0)
    -- The whole expense, both safes' worth. The investors' portion of a general-safe one has
    -- already come back through sarraf_investors_share above, exactly as it does on screen.
    - coalesce((select sum(abs(amount)) from public.ledger
                 where type = 'expense' and cur_id = p_cur_id), 0)
    - coalesce((select sum(abs(amount)) from public.ledger
                 where type = 'partner_fee' and cur_id = p_cur_id), 0)
  , 10);
$$;

comment on function public.sarraf_owner_own_money(text) is
  'قاسەی تایبەتی خۆم بەم دراوە — سەرمایەی خۆم + بەشی خۆم لە خێری هاوبەش + خێری ڕاستەوخۆ − خەرجی − عمولە.';

-- The screens ask for the snapshot once and read every balance out of it, so this belongs in
-- the same answer rather than behind a call of its own per currency.
do $migrate$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sarraf_read_model_snapshot'
    and pg_get_function_identity_arguments(p.oid) = 'p_days integer';
  if v_src is null then
    raise exception 'sarraf_read_model_snapshot(integer) was not found';
  end if;
  if position('own_money_by_currency' in v_src) > 0 then
    raise notice 'the snapshot already carries the owner''s own money';
    return;
  end if;

  v_new := replace(v_src,
    $old$  v_owner_safe jsonb;v_office jsonb;v_cash_accounts jsonb;v_expenses_by_safe jsonb;$old$,
    $new$  v_owner_safe jsonb;v_office jsonb;v_cash_accounts jsonb;v_expenses_by_safe jsonb;
  v_own_money jsonb;$new$);
  if v_new = v_src then raise exception 'the snapshot declarations were not where expected'; end if;
  v_src := v_new;

  -- Every currency, including the ones it comes to zero in: a currency missing from the map
  -- and a currency the owner has nothing in would otherwise read the same on screen.
  v_new := replace(v_src,
    $old$  select coalesce(jsonb_agg(to_jsonb(s) order by paid_from,cur_id),'[]'::jsonb)$old$,
    $new$  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_own_money from (
    select c.id cur_id, public.sarraf_owner_own_money(c.id) amount
      from public.currencies c) s;
  select coalesce(jsonb_agg(to_jsonb(s) order by paid_from,cur_id),'[]'::jsonb)$new$);
  if v_new = v_src then raise exception 'the expense split was not where expected'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$'self_capital',v_self,'expenses',v_expenses,'expenses_by_safe',v_expenses_by_safe,$old$,
    $new$'self_capital',v_self,'own_money_by_currency',v_own_money,
    'expenses',v_expenses,'expenses_by_safe',v_expenses_by_safe,$new$);
  if v_new = v_src then raise exception 'the snapshot result was not where expected'; end if;

  execute v_new;
end;
$migrate$;

revoke all on function public.sarraf_investors_share(text) from public, anon;
revoke all on function public.sarraf_owner_own_money(text) from public, anon;
grant execute on function public.sarraf_investors_share(text) to authenticated;
grant execute on function public.sarraf_owner_own_money(text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_investors_share(text) owner to sarraf_definer;
alter function public.sarraf_owner_own_money(text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
