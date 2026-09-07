-- ڕێگای پارەدان هەڵدەبژێردرێت، مەخمێنرێت
--
--   «شێوازی پارەدانی مامەڵە بە تەواوی لەلایەن خاوەن/کارمەند دیاری بکرێت.»
--   «هەر مامەڵە تەنها یەک شێوازی پارەدانی هەبێت؛ split payment مەکە.»    — بەشی ١٢
--
-- ── The thing that happened without being chosen ────────────────────────────────────────────
--
-- 202609020014 made a sale draw on the customer's own balance whenever they had one. That was
-- right for section 11 and wrong for section 12, which says the route is the operator's
-- decision and lists «پارە لە customer balance بەکاردەهێنرێت» as one of five they choose
-- between. Between those two sections, money moved out of a customer's balance on every sale
-- to them, whatever the person recording it had in mind — and it was the only one of the five
-- routes that nobody could decline.
--
-- ── What changes ────────────────────────────────────────────────────────────────────────────
--
-- A transaction may now carry `payment_route`. When it does, the balance is drawn on only for
-- 'customer_balance'. When it does not, nothing changes at all: the old behaviour stands, so
-- every caller that has not been taught about routes yet — and every command already recorded —
-- means exactly what it meant before.
--
-- That default is deliberate and is the whole reason this is safe to apply to a live database:
-- silence keeps its old meaning, and only an explicit route changes anything.
--
-- The route is not stored on the transaction row. It is a decision about how one command
-- behaves, and its consequences are already written where they belong — a pending status, an
-- office assignment, a vault event, a debt. A column repeating it could disagree with them.

begin;

do $migrate$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='sarraf_commit_transactions';
  if v_src is null then raise exception 'sarraf_commit_transactions is not here to patch'; end if;
  if position('payment_route' in v_src) > 0 then
    raise notice 'the route is already honoured'; return;
  end if;

  -- The vault draw learns to ask. `x` is the transaction being written in this iteration of the
  -- loop, so the route travels with the row it belongs to rather than with the command — one
  -- transaction, one route, which is what section 12 asks for.
  v_new := replace(v_src,
    $old$      if v_type='sell' and not v_direct and v_cp is not null then$old$,
    $new$      -- «شێوازی پارەدانی مامەڵە بە تەواوی لەلایەن خاوەن/کارمەند دیاری بکرێت.» A row that
      -- names no route means what it always meant, so nothing already recorded changes; a row
      -- that names one is only drawn on when the route chosen is the customer's own balance.
      if v_type='sell' and not v_direct and v_cp is not null
         and coalesce(nullif(btrim(x->>'payment_route'),''),'customer_balance') = 'customer_balance' then$new$);
  if v_new = v_src then raise exception 'the vault settlement call was not found'; end if;
  v_src := v_new;

  -- And a route nobody recognises is refused rather than quietly treated as one of the others.
  -- Section 12 names five; four can be carried out from a transaction, and settling against a
  -- mutual debt is done in the debt centre where both sides are in front of the person doing it.
  v_new := replace(v_src,
    $old$    if v_id is null or v_type not in ('buy','sell') or v_status not in ('completed','pending') then
      raise exception using errcode='22023',message='invalid transaction identity or state'; end if;$old$,
    $new$    if v_id is null or v_type not in ('buy','sell') or v_status not in ('completed','pending') then
      raise exception using errcode='22023',message='invalid transaction identity or state'; end if;
    if nullif(btrim(x->>'payment_route'),'') is not null
       and x->>'payment_route' not in ('owner_direct','office','customer_balance','becomes_debt') then
      raise exception using errcode='22023',message='unknown payment route'; end if;$new$);
  if v_new = v_src then raise exception 'the row validation was not found'; end if;

  execute v_new;
end $migrate$;

commit;
