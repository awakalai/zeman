-- قاسەی کڕیار — لە قاسەی گشتیدایە، بەڵام هی تۆ نییە
--
--   «کەسێک دێت دەڵێت پارە بخە سەر حسابەکەم ... دەبێت پارەکە بۆ قاسەی گشتیش زیاد ببێت و بۆ
--    قاسەی ئەویش، بەڵام لە وردەکاری قاسەی گشتیدا ئاماژەی پێبدات کە لای ئەوە و پارەی ئەوە و من
--    نەتوانم مامەڵەی پێوە بکەم.»
--   «ئاگاداربە، نەک دەبێت هەر لە قاسەی گشتی بێت، دەبێت لە قاسەی خۆشی بێت.»
--
-- ── What was actually happening, measured before this was written ────────────────────────────
--
-- A customer's deposit updated their vault and posted a journal entry, and wrote NO row in
-- public.ledger. public.ledger is what every screen sums to show قاسەی گشتی. So:
--
--   their own safe            +250   ✓
--   the books' cash (acc-1000) +250   ✓
--   قاسەی گشتی, on screen         0   ✗
--
-- The money was physically in the drawer, the double entry knew it, and the figure the owner
-- reads every day did not. At بەستنی ڕۆژ the counted cash would exceed the system by exactly
-- the customers' deposits, with nothing to explain the difference.
--
-- verify:accounting now measures this directly, and failed with "the general safe moved by 0,
-- expected 250" before this migration existed.
--
-- ── In the safe, and still not yours ─────────────────────────────────────────────────────────
--
-- The row carries `customer_id`, and that one column answers all three halves of the request:
--
--   · counted in قاسەی گشتی, because the cash is there;
--   · named in its breakdown as theirs, so the owner can see what is not his;
--   · excluded from every sufficiency check, so «من نەتوانم مامەڵەی پێوە بکەم» is enforced
--     rather than remembered. A trade cannot be funded with it.
--
-- The row's type is `customer_in`/`customer_out` and deliberately NOT `deposit`/`withdraw`:
-- capitalEventsFrom() in the browser reads every deposit that is not an investor's as the
-- OWNER's capital, so calling it a deposit would have quietly turned a customer's money into
-- the owner's own and into the base the investors' profit share is weighted by.

begin;

alter table public.ledger add column if not exists customer_id text references public.app_users(id);

comment on column public.ledger.customer_id is
  'پارەی ئەم کڕیارە کە لە قاسەدایە بەڵام هی خاوەنەکە نییە — لە قاسەی گشتیدا دەژمێردرێت، بەڵام ناکرێت مامەڵەی پێوە بکرێت.';

create index if not exists ledger_customer_idx on public.ledger(customer_id, cur_id)
  where customer_id is not null;

-- Money somebody else owns cannot fund the owner's trade. Both balance readers gain the same
-- exclusion, because a rule enforced in one of two places is a rule that holds until somebody
-- uses the other door.
create or replace function public.sarraf_locked_cash_balance(p_cur_id text,p_partner_id text default null)
returns numeric
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_balance numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'zeman:cash-location:'||p_cur_id||':'||coalesce(p_partner_id,'main'),0));
  select coalesce(sum(amount),0) into v_balance from public.ledger
   where cur_id=p_cur_id and partner_id is not distinct from p_partner_id
     and customer_id is null;
  return v_balance;
end;
$$;

create or replace function public.sarraf_locked_holding_balance(
  p_cur_id text, p_cash_account_id text default null
) returns numeric
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_balance numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'zeman:holding:'||coalesce(p_cash_account_id,'cash')||':'||p_cur_id, 0));
  select coalesce(sum(amount),0) into v_balance from public.ledger
   where cur_id = p_cur_id
     and partner_id is null and office_id is null
     and customer_id is null
     and cash_account_id is not distinct from p_cash_account_id;
  return v_balance;
end;
$$;

comment on function public.sarraf_locked_holding_balance(text,text) is
  'باڵانسی یەک شوێن بە دیاریکراوی — کاش، یان حسابێکی ناودار — لەژێر قوفڵ. پارەی کڕیاران تێیدا نییە.';

-- The vault movement now leaves a trace in the safe as well as in the books.
--
-- Read from the live definition rather than restated: this function has been through several
-- migrations and copying an older body would take their work back out.
do $migrate$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sarraf_customer_vault_move';
  if v_src is null then
    raise exception 'sarraf_customer_vault_move was not found';
  end if;
  -- Not 'customer_id': this function already carries p_customer_id as a parameter and writes a
  -- customer_id column into customer_vault_events, so that guard was true from the start and
  -- the migration skipped itself in silence. The marker has to be something only this change
  -- introduces.
  if position('customer_in' in v_src) > 0 then
    raise notice 'the vault movement already reaches the safe';
    return;
  end if;

  -- Written beside the event that records the movement, so the two cannot be separated by a
  -- later edit without somebody noticing they belong together.
  v_new := replace(v_src,
    $old$  insert into public.customer_vault_events($old$,
    $new$  insert into public.ledger(id,type,cur_id,amount,customer_id,note,date,command_key,created_by)
  values ('led-cv-'||md5(p_command_key||':'||v_vault),
          case when p_direction='in' then 'customer_in' else 'customer_out' end,
          lower(v_cur),
          case when p_direction='in' then p_amount else -p_amount end,
          p_customer_id, left(p_reason,1000), statement_timestamp(), p_command_key, v_actor.id);

  insert into public.customer_vault_events($new$);
  if v_new = v_src then
    raise exception 'the vault event insert this migration expected was not found';
  end if;

  execute v_new;
end;
$migrate$;

-- ── The two figures that must not be one figure ──────────────────────────────────────────────
--
-- قاسەی گشتی is every row: the cash really is in the drawer, customers' included, which is what
-- the day's count has to agree with. «قاسەی خاوەن» is what is the owner's to move, and a
-- customer's money is not. The snapshot has carried owner_safe_by_currency as "rows naming no
-- partner, office or account" since 202609010014; a customer row names none of those either, so
-- without this line their deposit would have walked straight into the owner's own safe.
do $migrate$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sarraf_read_model_snapshot'
    and pg_get_function_identity_arguments(p.oid) = 'p_days integer';
  if v_src is null then raise exception 'sarraf_read_model_snapshot(integer) was not found'; end if;
  if position('customer_held_by_currency' in v_src) > 0 then
    raise notice 'the snapshot already separates the customers'' money';
    return;
  end if;

  v_new := replace(v_src,
    $old$  v_own_money jsonb;$old$,
    $new$  v_own_money jsonb;v_customer_held jsonb;$new$);
  if v_new = v_src then raise exception 'the snapshot declarations were not where expected'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$     where partner_id is null and office_id is null and cash_account_id is null
     group by cur_id) s;$old$,
    $new$     where partner_id is null and office_id is null and cash_account_id is null
       and customer_id is null
     group by cur_id) s;

  -- What is in the safe and belongs to somebody who walked in with it.
  select coalesce(jsonb_object_agg(cur_id,amount),'{}'::jsonb) into v_customer_held from (
    select cur_id,round(sum(amount),10) amount from public.ledger
     where customer_id is not null group by cur_id
    having round(sum(amount),10) <> 0) s;$new$);
  if v_new = v_src then raise exception 'the owner safe query was not where expected'; end if;
  v_src := v_new;

  v_new := replace(v_src,
    $old$    'owner_safe_by_currency',v_owner_safe,$old$,
    $new$    'owner_safe_by_currency',v_owner_safe,'customer_held_by_currency',v_customer_held,$new$);
  if v_new = v_src then raise exception 'the snapshot result was not where expected'; end if;

  execute v_new;
end;
$migrate$;

commit;
