-- خەرجی — لە کام قاسەوە درا
--
-- «خەرجی (کە خەرجییەکەم دا ئاماژە بەوە بکات لە قاسەی گشتی دیدەی یان قاسەی تایبەتی خۆت).»
--
-- An expense already says how much, in what currency, under what heading, and out of which
-- cash or account it was paid. What it has never said is whose money it was:
--
--   قاسەی گشتی — the general safe, which holds the owner's money and the investors' together
--   قاسەی تایبەتی خۆم — the owner's own safe, which holds only theirs
--
-- Two different pockets, and until now every expense was silently the second one: the browser
-- subtracts every expense from the owner's equity and from nobody else's.
--
-- ── What this migration does, and what it deliberately does not ──────────────────────────────
--
-- It records the answer. `paid_from` is a new column, not a new meaning for an old one:
-- ledger.owner already means 'self' or 'investor' on a capital movement, and overloading it
-- would make one column answer two unrelated questions.
--
--   'general'  the general safe        قاسەی گشتی
--   'own'      the owner's own safe    قاسەی تایبەتی خۆم
--   null       an expense recorded before this column existed
--
-- Every existing row stays null, and null keeps meaning exactly what the screens already do
-- with it, so no figure anybody is looking at today moves by a single unit.
--
-- What it does NOT do is change how an expense is shared out. Whether an expense from the
-- general safe should reduce the investors' share of profit as well as the owner's is a
-- decision about their money, and it is the owner's to make, not this migration's. The mark is
-- recorded and shown first; the arithmetic follows the answer.

begin;

alter table public.ledger add column if not exists paid_from text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ledger_paid_from_known') then
    alter table public.ledger add constraint ledger_paid_from_known
      check (paid_from is null or paid_from in ('general','own'));
  end if;
end;
$$;

comment on column public.ledger.paid_from is
  'خەرجی لە کام قاسەوە درا: general = قاسەی گشتی، own = قاسەی تایبەتی خۆم. بەتاڵ = پێش ئەم ستوونە.';

-- An expense may now name its safe. Everything else about this command is untouched, including
-- the rule that an expense carries no owner and no investor: those describe capital, and a safe
-- is not capital.
--
-- Read from the live definition rather than restated: 202609020004 rewrote this function to
-- honour cash_account_id, and copying an older body would take that back out.
do $migrate$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sarraf_post_ledger_command'
    and pg_get_function_identity_arguments(p.oid) =
        'p_ledger jsonb, p_command_key text, p_action text, p_detail text';
  if v_src is null then
    raise exception 'sarraf_post_ledger_command(jsonb,text,text,text) was not found';
  end if;
  if position('paid_from' in v_src) > 0 then
    raise notice 'sarraf_post_ledger_command already records which safe an expense came from';
    return;
  end if;

  -- A word the safe has never heard of is refused by ledger_paid_from_known above, which is
  -- the constraint on the column itself. A second copy of that rule inside this function would
  -- be a guard nothing can reach and nothing can measure, so there is not one.
  --
  -- The write carries the answer. Only an expense may: a capital movement or a payout
  -- naming a safe would be a second, contradictory answer to the question ledger.owner asks.
  v_new := replace(v_src,
    $old$    insert into public.ledger(id,type,owner,investor_id,cur_id,amount,partner_id,cash_account_id,tx_id,note,date,
      command_key,created_by,commission_rate_snapshot,commission_amount_snapshot)
    values(v_id,v_type,v_owner,v_investor,v_cur,v_amount,v_partner,v_account,nullif(x->>'tx_id',''),
      left(x->>'note',1000),v_date,p_command_key,v_actor.id,null,null);$old$,
    $new$    insert into public.ledger(id,type,owner,investor_id,cur_id,amount,partner_id,cash_account_id,tx_id,note,date,
      command_key,created_by,commission_rate_snapshot,commission_amount_snapshot,paid_from)
    values(v_id,v_type,v_owner,v_investor,v_cur,v_amount,v_partner,v_account,nullif(x->>'tx_id',''),
      left(x->>'note',1000),v_date,p_command_key,v_actor.id,null,null,
      case when v_type='expense' then coalesce(nullif(btrim(x->>'paid_from'),''),'own') end);$new$);
  if v_new = v_src then
    raise exception 'the ledger insert this migration expected was not found';
  end if;

  execute v_new;
end;
$migrate$;

commit;

-- The screens read totals from the snapshot, not from the ledger. An expense that names its
-- safe and is then reported in one undivided total has answered a question nobody can see the
-- answer to, so the snapshot carries the split as well as the total it already carried.
--
-- `expenses` itself is untouched — every reader of it keeps the number it has always had.
begin;

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
  if position('expenses_by_safe' in v_src) > 0 then
    raise notice 'the snapshot already splits expenses by safe';
    return;
  end if;

  v_new := replace(v_src,
    $old$  v_owner_safe jsonb;v_office jsonb;v_cash_accounts jsonb;$old$,
    $new$  v_owner_safe jsonb;v_office jsonb;v_cash_accounts jsonb;v_expenses_by_safe jsonb;$new$);
  if v_new = v_src then raise exception 'the snapshot declarations were not where expected'; end if;
  v_src := v_new;

  -- Rows recorded before the column existed answer 'own', which is what every screen has done
  -- with them since the day they were written.
  v_new := replace(v_src,
    $old$  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_fees from ($old$,
    $new$  select coalesce(jsonb_agg(to_jsonb(s) order by paid_from,cur_id),'[]'::jsonb)
    into v_expenses_by_safe from (
    select coalesce(paid_from,'own') paid_from,cur_id,round(sum(abs(amount)),10) amount
      from public.ledger where type='expense' group by coalesce(paid_from,'own'),cur_id) s;
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_fees from ($new$);
  if v_new = v_src then raise exception 'the expense totals were not where expected'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$'self_capital',v_self,'expenses',v_expenses,'partner_fees',v_fees,$old$,
    $new$'self_capital',v_self,'expenses',v_expenses,'expenses_by_safe',v_expenses_by_safe,
    'partner_fees',v_fees,$new$);
  if v_new = v_src then raise exception 'the snapshot result was not where expected'; end if;

  execute v_new;
end;
$migrate$;

commit;
