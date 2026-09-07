-- لە چەند کەسێک کڕدراوە، بە یەک کەس فرۆشراوە
--
--   «جۆرێکی دیکەی مامەڵەی ڕاستەوخۆ هەیە کە لە جیاتی ئەوەی لە یەک کەسی بکڕم، لە چەند
--    کەسێکی دەکڕم و بەڵام بە یەک کەسی دەفرۆشم.»
--
-- A direct trade has always been exactly two rows: one buy from one person and one sell to
-- another, of the same amount, in one command, out of the owner's own money. That refusal is
-- written in four separate places and every one of them had to learn the new shape, or the
-- command refused with "owner-cashbox trade requires both matching sides" and the owner would
-- have had to record three separate trades that were really one.
--
-- ── The shape ───────────────────────────────────────────────────────────────────────────────
--
-- Three rows or more: one sale, and every other row a purchase. One pair_id joins them, one
-- currency traded against one other, every row the owner's own money and no partner's custody.
-- Each purchase names its own seller and carries its own rate, because buying from four people
-- at four prices is the reason for doing this at all.
--
-- AND THE SALE MUST BE EXACTLY WHAT WAS BOUGHT. Not more, which would be selling something the
-- trade never acquired, and not less, which would leave a remainder with no cost and no home.
-- The two-row rule said this by requiring one distinct amount across both rows; with several
-- purchases it becomes a sum, and the two-row case is the same rule with one term.
--
-- ── What this does NOT change ───────────────────────────────────────────────────────────────
--
-- Weighted-average cost is untouched, and cannot be reached from here: sarraf_inventory_snapshot_at
-- walks `not coalesce(t.direct,false)`, so a direct trade has never entered inventory and still
-- does not. The earning is what it always was for a direct trade — what the sale brought in less
-- what the purchases cost — and the only difference is that "what the purchases cost" is now a
-- sum over the pair instead of the one row there used to be. That same `sum` is correct for a
-- two-row pair, where it is a sum of one.
--
-- Atomicity and idempotency are unchanged because nothing about the command's shape changed:
-- it was always one call carrying an array, always under one command key, always all-or-nothing.
--
-- ── Method ──────────────────────────────────────────────────────────────────────────────────
--
-- Both functions are read live with pg_get_functiondef and patched by substitution rather than
-- restated, so nothing else in bodies of this size is silently reverted to an older text. Every
-- substitution asserts it found something, and each guard keys on a marker the change itself
-- introduces — a lesson from 202609020013, whose first guard matched a string that already
-- existed, so the migration skipped itself while every check that depended on it failed.

begin;

do $migrate$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='sarraf_commit_transactions';
  if v_src is null then raise exception 'sarraf_commit_transactions is not here to patch'; end if;
  if position('sold exactly what it bought' in v_src) > 0 then
    raise notice 'already patched'; return;
  end if;

  -- ── 0. the row count stops being one or two ──────────────────────────────────────────────
  --
  -- The outermost gate, before anything is looked at. It is widened only for a command whose
  -- every row is direct: an ordinary trade is still one row and an ordinary direct pair is
  -- still two, so nothing that was refused before is accepted now except the new shape.
  --
  -- THE CAP OF TWENTY IS A DECISION THE OWNER DID NOT MAKE, and it is here rather than absent
  -- because an unbounded array in a financial command is a way to hang the database by
  -- accident. Twenty is the number this system already uses for a receipt upload. If the owner
  -- ever buys from more than twenty people in one trade, this is the line to raise.
  v_new := replace(v_src,
    $old$  if v_count not between 1 and 2 then raise exception using errcode='22023',message='one transaction or one direct pair is required'; end if;$old$,
    $new$  if v_count < 1 or v_count > 20
     or (v_count > 2 and exists(select 1 from jsonb_array_elements(p_txs) e
                                 where not coalesce((e->>'direct')::boolean,false))) then
    raise exception using errcode='22023',message='one transaction or one direct pair is required'; end if;$new$);
  if v_new = v_src then raise exception 'the row-count gate was not found'; end if;
  v_src := v_new;

  -- ── 1. the batch gate learns the third shape ─────────────────────────────────────────────
  v_new := replace(v_src,
    $old$  elsif v_direct_count<>0 then
    raise exception using errcode='23514',message='owner-cashbox trade requires both matching sides';
  end if;$old$,
    $new$  elsif v_direct_count<>0 then
    -- «لە چەند کەسێکی دەکڕم و بەڵام بە یەک کەسی دەفرۆشم.» One sale, every other row a purchase,
    -- all of them direct, all of them the owner's own, none of them a partner's custody.
    if v_count<3 or v_direct_count<>v_count or v_sell_count<>1 or v_buy_count<>v_count-1
       or v_pair_count<>1 or v_cur_count<>1 or v_against_count<>1
       or v_own_count<>v_count or v_partner_count<>0 or v_role_count<>v_count then
      raise exception using errcode='23514',message='owner-cashbox trade requires both matching sides';
    end if;
    -- Sold exactly what it bought: more would be selling what was never acquired, less would
    -- leave a remainder with no cost and nowhere to sit.
    if (select abs(coalesce(sum(case when e->>'type'='sell' then (e->>'amount')::numeric
                                     else -(e->>'amount')::numeric end),0))
          from jsonb_array_elements(p_txs) e) > 0.0000000001 then
      raise exception using errcode='23514',
        message='owner-cashbox trade must sell exactly what it bought',
        detail=(select format('bought %s, sold %s',
                  coalesce(sum((e->>'amount')::numeric) filter(where e->>'type'='buy'),0),
                  coalesce(sum((e->>'amount')::numeric) filter(where e->>'type'='sell'),0))
                  from jsonb_array_elements(p_txs) e);
    end if;
  end if;$new$);
  if v_new = v_src then raise exception 'the batch gate this migration expected was not found'; end if;
  v_src := v_new;

  -- ── 2. the per-row gate stops insisting on exactly two ───────────────────────────────────
  -- The batch gate above has already decided the shape is legal; this one only has to refuse a
  -- direct row that is alone, unfunded, in somebody's custody, unpaired or mislabelled.
  v_new := replace(v_src,
    'if v_direct and (v_count<>2 or not v_own',
    'if v_direct and (v_count<2 or not v_own');
  if v_new = v_src then raise exception 'the per-row direct gate was not found'; end if;
  v_src := v_new;

  -- ── 3. the earning counts every purchase, not the first one it finds ─────────────────────
  -- The alias here is pair_leg, not b. 202608210002 renamed it because the command declares a
  -- record variable called b as well, PostgreSQL resolves plpgsql variables before query
  -- aliases, and the statement was refused as ambiguous — which meant no direct trade could be
  -- recorded at all until that was found. Patching against the text in 202608180002 rather
  -- than against what is actually installed is how this migration failed its first run, and it
  -- failed loudly, which is the whole reason every substitution here asserts it found something.
  v_new := replace(v_src,
    $old$      select (pair_leg->>'total')::numeric into v_buy_total
      from jsonb_array_elements(p_txs) pair_leg where pair_leg->>'type'='buy' and pair_leg->>'pair_id'=v_pair limit 1;$old$,
    $new$      -- Every purchase in the pair. `limit 1` was right while a pair had one buy and is
      -- silently wrong now: it would price the sale against whichever seller happened to come
      -- first and call the rest of the cost profit.
      select sum((pair_leg->>'total')::numeric) into v_buy_total
      from jsonb_array_elements(p_txs) pair_leg where pair_leg->>'type'='buy' and pair_leg->>'pair_id'=v_pair;$new$);
  if v_new = v_src then raise exception 'the direct-pair earning was not found'; end if;

  execute v_new;
end $migrate$;

do $pair$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='assert_owner_cashbox_pair';
  if v_src is null then raise exception 'assert_owner_cashbox_pair is not here to patch'; end if;
  if position('v_bought numeric' in v_src) > 0 then raise notice 'already patched'; return; end if;

  -- The trigger that stops half a direct trade being left alive. It has to learn the same shape,
  -- or a perfectly legal three-row trade would be refused the moment it was written.
  v_new := replace(v_src, 'v_pair text; v_pairs text[];',
                          'v_pair text; v_pairs text[]; v_bought numeric; v_sold numeric;');
  if v_new = v_src then raise exception 'the pair trigger declarations were not found'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$           min(cur_id),max(cur_id),min(against_id),max(against_id),min(amount),max(amount)
      into v_count,v_buy,v_sell,v_valid,
           v_cur_min,v_cur_max,v_against_min,v_against_max,v_amount_min,v_amount_max$old$,
    $new$           min(cur_id),max(cur_id),min(against_id),max(against_id),min(amount),max(amount),
           coalesce(sum(amount) filter(where type='buy'),0),
           coalesce(sum(amount) filter(where type='sell'),0)
      into v_count,v_buy,v_sell,v_valid,
           v_cur_min,v_cur_max,v_against_min,v_against_max,v_amount_min,v_amount_max,
           v_bought,v_sold$new$);
  if v_new = v_src then raise exception 'the pair trigger measurement was not found'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$    if v_count<>0 and (v_count<>2 or v_buy<>1 or v_sell<>1 or not v_valid
       or v_cur_min is distinct from v_cur_max
       or v_against_min is distinct from v_against_max
       or v_amount_min is distinct from v_amount_max) then$old$,
    $new$    -- One sale and at least one purchase, and what was sold is exactly what was bought.
    -- For the two-row pair this is the rule it always was, with a sum of one term.
    if v_count<>0 and (v_count<2 or v_sell<>1 or v_buy<>v_count-1 or not v_valid
       or v_cur_min is distinct from v_cur_max
       or v_against_min is distinct from v_against_max
       or abs(v_sold - v_bought) > 0.0000000001) then$new$);
  if v_new = v_src then raise exception 'the pair trigger rule was not found'; end if;
  v_src := v_new;

  execute v_new;
end $pair$;

commit;
