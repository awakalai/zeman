-- ئەوەی نەیتوانی بیدات، ئێستا قەرزارە پێی
--
--   «ئەگەر باڵانس لە بڕی مامەڵە کەمتر بوو، هەموو باڵانسەکە بەکاربهێنرێت و ماوەکە ببێتە قەرز.»
--
-- 202609020014 built the first half of that sentence and stopped at the comma. A customer
-- holding 350 who bought something for 900 paid their 350 and the other 550 went nowhere at
-- all: the sale's own settlement row had already debited cash for the full 900, so the books
-- were carrying 550 of money that never arrived and nobody was recorded as owing it.
--
-- ── What is added ───────────────────────────────────────────────────────────────────────────
--
-- When the vault covers only part of a sale, the shortfall opens an ordinary debt — the same
-- table, the same status machine, the same register the owner already reads, the same button
-- that reminds somebody. It is not a new kind of thing; a customer who has not paid all of it
-- is a customer who owes the rest, and this project already knows what that means.
--
-- The entry that goes with it is the mirror of the one 202609020014 already posts. That one
-- says "this much was already here": acc-2000 down, acc-1000 down, because the cash the sale
-- recorded was money the business was already holding for them. This one says "this much has
-- not arrived": acc-1200 up, acc-1000 down — a receivable instead of cash. Between them the
-- full total of the sale is accounted for, and acc-1000 is left holding only what physically
-- moved, which is nothing.
--
-- ── A decision that is deliberately narrow, and why ─────────────────────────────────────────
--
-- The shortfall becomes a debt ONLY when some of their own money was actually used. A
-- customer with no vault at all is left exactly as they were.
--
-- Read at its most literal, section 11 could be taken to mean that a customer with a balance
-- of zero has a balance "less than the transaction" and should therefore owe the whole thing.
-- That reading would turn every ordinary sale to every customer into a debt, which section 12
-- contradicts: it says the payment route is chosen by the owner or an employee, and lists
-- "the transaction becomes a debt" and "money is taken from the customer balance" as two
-- different routes among five. That chooser does not exist yet. Until it does, drawing on a
-- vault happens automatically wherever there is money in one, and extending that to customers
-- who never had a vault would silently rewrite what a completed sale means.
--
-- Section 11 and section 12 also disagree on their face — section 12 says a transaction has
-- exactly one payment method and forbids split payments, and a sale paid partly from a
-- balance and partly on credit is a split. This migration reads them together as: the route
-- is "customer balance", and a shortfall on that route is its automatic consequence rather
-- than a second route the operator picked. THE OWNER SHOULD CONFIRM THAT READING, and the
-- logic PDF that section 1 makes the source of truth is not on this system to settle it.

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
  v_vault text; v_available numeric; v_take numeric; v_short numeric;
  v_debt text; v_entry text;
begin
  if p_customer_id is null or p_amount is null or p_amount <= 0 then return 0; end if;

  select id, available into v_vault, v_available from public.customer_vaults
   where customer_id = p_customer_id and currency = v_cur for update;
  if v_vault is null or coalesce(v_available,0) <= 0 then return 0; end if;

  -- What they have, or what is owed, whichever is smaller. Never more.
  v_take := least(v_available, p_amount);
  if v_take <= 0 then return 0; end if;

  -- The vault is NOT written to here, and that is the whole point. customer_vault_events
  -- carries an after-insert trigger, apply_customer_vault_event, which applies
  -- available_delta to the vault itself. An explicit update as well took the money twice:
  -- a customer with 550 who bought something for 200 was left holding 150, and the next two
  -- sales were refused outright by customer_vaults_available_check for trying to go below
  -- zero. Writing only the event keeps the balance and its own history in agreement by
  -- construction — the balance cannot drift from the events that explain it, because the
  -- events are the only thing that moves it.
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

  -- «ماوەکە ببێتە قەرز.» What their own money could not cover, they owe.
  v_short := round(p_amount - v_take, 10);
  if v_short > 0 then
    v_entry := public.sarraf_post_simple_entry(
      'je-vaultshort-' || p_tx_id, coalesce(p_date, statement_timestamp())::date,
      'customer_vault_shortfall', p_actor_id,
      'acc-1200', 'acc-1000', v_cur, v_short, null,
      left(format('قاسەی کڕیار بەشی نەکرد؛ ماوەکە قەرزە — %s', p_tx_id), 500),
      -- Its own key. je_command_uq is unique on the command key, and the settlement entry
      -- above already claimed the bare one; two entries out of one command need two keys.
      p_command_key || ':vault-shortfall', 'customer', p_customer_id, p_tx_id);

    insert into public.debts(
      id, debtor_type, debtor_id, creditor_type, creditor_id, currency,
      original_principal, outstanding_principal, source_type, source_transaction_id,
      reason, created_by, journal_entry_id, command_key)
    values ('debt-vaultshort-'||md5(p_tx_id||':'||p_customer_id),
            'customer'::public.party_kind, p_customer_id,
            'zeman'::public.party_kind, null,
            v_cur, v_short, v_short, 'unpaid_transaction', p_tx_id,
            left(format('قاسەی خۆی %s بوو، مامەڵەکە %s — ماوەکە قەرز', v_take, p_amount), 700),
            p_actor_id, v_entry, p_command_key || ':vault-shortfall')
    on conflict (id) do nothing;
  end if;

  return v_take;
end;
$$;

comment on function public.sarraf_take_sale_from_vault(text,text,text,numeric,text,text,timestamptz) is
  'کاتێک کڕیارێک شتێک دەکڕێت، ئەوەندەی لە قاسەی خۆیدا هەیە لێی دەبردرێت — نە زیاتر — و ماوەکە دەبێتە قەرز.';

-- ── The owner of the function, which 202609020014 forgot ────────────────────────────────────
--
-- It is SECURITY DEFINER, so it runs as whoever owns it, and nothing said who that was — which
-- left it owned by postgres, a role that ignores every row-level security policy there is. A
-- function that writes to vaults, the ledger, the journal and now the debt register, running as
-- a role no policy applies to, is exactly what verify:isolation exists to refuse, and it
-- refused it: "these run as a role that ignores every policy".
--
-- sarraf_definer is a role policies still apply to. Every other definer function in this system
-- is owned by it, and this one should have been from the start.
revoke all on function public.sarraf_take_sale_from_vault(text,text,text,numeric,text,text,timestamptz)
  from public, anon, authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_take_sale_from_vault(text,text,text,numeric,text,text,timestamptz)
  owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
