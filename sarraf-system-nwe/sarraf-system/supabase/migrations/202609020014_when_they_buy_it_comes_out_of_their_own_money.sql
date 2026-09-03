-- کاتێک شتی لە من کڕی، پارەکە لەو بەشەی خۆی دەبردرێت
--
--   «دواتر دەتوانێت پارەی مامەڵەیەک بەوە بدات ... بەڵام کاتێک شتی لە من کڕی ئۆتۆماتیکی پارەکە
--    لەو بەشەی خۆی ببات.»
--
-- 202609020013 put the customer's money in the safe, named it as theirs and kept the owner
-- from trading with it. This is the other half: when that customer buys, they pay from it
-- without anybody pressing anything.
--
-- ── Why it happens inside the commit ─────────────────────────────────────────────────────────
--
-- «ئۆتۆماتیکی» has to mean atomic, not "and then the browser makes a second call". A second
-- call can fail, and what it leaves behind is a sale recorded as paid in cash that the customer
-- actually paid from their balance — their money still showing as theirs and the owner's safe
-- overstated by the same amount. So it is one transaction: either the sale and the payment are
-- both recorded, or neither is.
--
-- ── The cash does not move, and the books have to say so ─────────────────────────────────────
--
-- This is the part that is easy to get wrong. A completed sale already debits acc-1000 for the
-- whole total, because ordinarily the money arrives. Here it does not arrive — it has been in
-- the drawer since the day they deposited it. What changes is whose it is.
--
--   the sale's own entry      debit acc-1000   +total
--   this one                  credit acc-1000  −taken      cash nets to zero, correctly
--                             debit  acc-2000  −taken      we owe them that much less
--
-- And in public.ledger the same truth: the sale writes its settlement row into the owner's
-- money, and this writes a customer_out row against theirs. The drawer's total is unchanged,
-- because nothing was carried in or out of it.
--
-- ── What it will not do ──────────────────────────────────────────────────────────────────────
--
-- It takes what they have and no more. A customer with 40 in their balance buying something for
-- 100 pays 40 from it, and the remaining 60 follows the path it always did. It never overdraws
-- a vault into a debt nobody agreed to, and it never touches a purchase — «کاتێک شتی لە من
-- کڕی» is a sale, and money the owner pays out is a different question with a different answer.

begin;

create or replace function public.sarraf_take_sale_from_vault(
  p_tx_id text, p_customer_id text, p_currency text, p_amount numeric,
  p_command_key text, p_actor_id text, p_date timestamptz
) returns numeric
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_cur text := upper(btrim(p_currency));
  v_vault text; v_available numeric; v_take numeric;
begin
  if p_customer_id is null or p_amount is null or p_amount <= 0 then return 0; end if;

  select id, available into v_vault, v_available from public.customer_vaults
   where customer_id = p_customer_id and currency = v_cur for update;
  if v_vault is null or coalesce(v_available,0) <= 0 then return 0; end if;

  -- What they have, or what is owed, whichever is smaller. Never more.
  v_take := least(v_available, p_amount);
  if v_take <= 0 then return 0; end if;

  update public.customer_vaults set available = available - v_take where id = v_vault;

  insert into public.customer_vault_events(
    vault_id, customer_id, currency, kind, available_delta,
    reason, actor_id, command_key)
  values (v_vault, p_customer_id, v_cur, 'transaction_settlement'::public.vault_event_kind,
          -v_take,
          left(format('پارەدانی مامەڵە لە قاسەی خۆیەوە — %s', p_tx_id), 700),
          p_actor_id, p_command_key);

  -- Their money leaves their part of the safe. The sale's own settlement row put the same
  -- amount into the owner's part, so the drawer is unchanged — which is the truth: nothing
  -- was carried in or out of it.
  insert into public.ledger(id,type,cur_id,amount,customer_id,tx_id,note,date,command_key,created_by)
  values ('led-'||md5(p_tx_id||':vault-settlement'), 'customer_out', lower(v_cur), -v_take,
          p_customer_id, p_tx_id, 'پارەدان لە قاسەی کڕیارەوە', coalesce(p_date, statement_timestamp()),
          p_command_key, p_actor_id);

  -- And the offset that keeps acc-1000 honest: the sale debited cash for money that did not
  -- arrive, because it was already here.
  perform public.sarraf_post_simple_entry(
    'je-vaultpay-' || p_tx_id, coalesce(p_date, statement_timestamp())::date,
    'customer_vault_settlement', p_actor_id,
    'acc-2000', 'acc-1000', v_cur, v_take, null,
    left(format('کڕیارەکە لە قاسەی خۆیەوە پارەی دا — %s', p_tx_id), 500),
    p_command_key, 'customer', p_customer_id, p_tx_id);

  return v_take;
end;
$$;

comment on function public.sarraf_take_sale_from_vault(text,text,text,numeric,text,text,timestamptz) is
  'کاتێک کڕیارێک شتێک دەکڕێت، ئەوەندەی لە قاسەی خۆیدا هەیە لێی دەبردرێت — نە زیاتر.';

revoke all on function public.sarraf_take_sale_from_vault(text,text,text,numeric,text,text,timestamptz)
  from public, anon, authenticated;

-- Called from inside the commit, immediately after the settlement row it offsets, so the two
-- cannot be separated by a later edit without somebody noticing they belong together.
--
-- Read from the live definition rather than restated: sarraf_commit_transactions has been
-- patched in place several times and copying an older body would take that work back out.
do $migrate$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sarraf_commit_transactions'
    and pg_get_function_identity_arguments(p.oid) =
        'p_txs jsonb, p_ledger jsonb, p_batch_id text, p_command_key text, p_action text, p_detail text';
  if v_src is null then
    raise exception 'sarraf_commit_transactions(jsonb,jsonb,text,text,text,text) was not found';
  end if;
  if position('sarraf_take_sale_from_vault' in v_src) > 0 then
    raise notice 'a sale already draws on the customer''s own money';
    return;
  end if;

  v_new := replace(v_src,
    $old$    if v_status='completed' then
      insert into public.ledger(id,type,cur_id,amount,tx_id,note,date,command_key,created_by)
      values('led-'||md5(v_id||':settlement'),case when v_direct then 'direct_'||v_type else v_type end,
        v_against,case when v_type='buy' then -v_total else v_total end,v_id,
        case when v_direct then 'owner cashbox' end,v_date,p_command_key,v_actor.id);
    end if;$old$,
    $new$    if v_status='completed' then
      insert into public.ledger(id,type,cur_id,amount,tx_id,note,date,command_key,created_by)
      values('led-'||md5(v_id||':settlement'),case when v_direct then 'direct_'||v_type else v_type end,
        v_against,case when v_type='buy' then -v_total else v_total end,v_id,
        case when v_direct then 'owner cashbox' end,v_date,p_command_key,v_actor.id);
      -- «کاتێک شتی لە من کڕی ئۆتۆماتیکی پارەکە لەو بەشەی خۆی ببات.» Only a sale, only to a
      -- registered customer, and only their own money — never a direct trade, which is the
      -- owner's own and has no counterparty balance to draw on.
      if v_type='sell' and not v_direct and v_cp is not null then
        perform public.sarraf_take_sale_from_vault(
          v_id, v_cp, (select code from public.currencies where id=v_against),
          v_total, p_command_key, v_actor.id, v_date);
      end if;
    end if;$new$);
  if v_new = v_src then
    raise exception 'the settlement row this migration expected was not found';
  end if;

  execute v_new;
end;
$migrate$;

commit;
