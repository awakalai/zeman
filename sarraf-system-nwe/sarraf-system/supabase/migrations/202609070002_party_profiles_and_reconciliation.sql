-- Scoped Party 360 read model and currency reconciliation center.
--
-- These are read-only explanations over the existing append-only/accounting tables. They do not
-- replace commands, expose profit, or resolve discrepancies. Tenant and role policies still apply
-- because the functions are owned by the protected definer role.
begin;

create or replace function public.sarraf_party_profile(
  p_party_id text,
  p_party_kind text
) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_party public.app_users%rowtype;
  v_kind text := lower(btrim(coalesce(p_party_kind, '')));
  v_balances jsonb := '[]'::jsonb;
  v_debts jsonb := '[]'::jsonb;
  v_transactions jsonb := '[]'::jsonb;
  v_receipts jsonb := '[]'::jsonb;
  v_payments jsonb := '[]'::jsonb;
begin
  v_actor := public.sarraf_actor();
  if v_actor.role not in ('admin', 'office') then
    raise exception using errcode = '42501', message = 'party profiles are staff-only';
  end if;
  if v_kind not in ('customer', 'partner', 'office', 'investor') or nullif(btrim(p_party_id), '') is null then
    raise exception using errcode = '22023', message = 'a valid party and party kind are required';
  end if;
  if v_actor.role = 'office' and p_party_id <> v_actor.id then
    raise exception using errcode = '42501', message = 'an office may only view its own profile';
  end if;

  select * into v_party from public.app_users
   where id = p_party_id and role = v_kind and not deleted;
  if not found then
    raise exception using errcode = 'P0002', message = 'party not found in this business';
  end if;

  if v_kind = 'customer' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'currency', currency, 'available', available, 'reserved', reserved,
      'total', available + reserved, 'last_event_at', last_event_at
    ) order by currency), '[]'::jsonb)
      into v_balances from public.customer_vaults where customer_id = p_party_id;
  elsif v_kind = 'partner' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'currency', currency, 'available', available, 'reserved', reserved,
      'total', available + reserved, 'last_event_at', last_event_at
    ) order by currency), '[]'::jsonb)
      into v_balances from public.partner_accounts where partner_id = p_party_id and active;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'currency', cur_id, 'amount', amount
    ) order by cur_id), '[]'::jsonb)
      into v_balances from public.account_ledger
     where user_id = p_party_id
     group by cur_id
     having sum(amount) <> 0;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'direction', case when debtor_type = v_kind and debtor_id = p_party_id
      then 'party_owes' else 'zeman_owes' end,
    'currency', currency, 'original', original_principal,
    'outstanding', outstanding_principal, 'status', status,
    'reason', reason, 'opened_at', opened_at, 'due_at', due_at
  ) order by opened_at desc), '[]'::jsonb)
    into v_debts from public.debts
   where status in ('open', 'partially_settled')
     and ((debtor_type = v_kind and debtor_id = p_party_id)
       or (creditor_type = v_kind and creditor_id = p_party_id));

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'code', code, 'type', type, 'currency', cur_id,
    'amount', amount, 'against_currency', against_id, 'total', total,
    'status', status, 'date', date, 'note', note
  ) order by date desc), '[]'::jsonb)
    into v_transactions from public.txs
   where not deleted and ((cp_id = p_party_id) or (partner_id = p_party_id));

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'batch_id', r.batch_id, 'currency', r.currency,
    'amount', r.amount, 'fee', r.fee, 'net_amount', r.net_amount,
    'status', r.status, 'direction', r.direction, 'reference', r.ref_no,
    'date', coalesce(r.tx_date::text, r.created_at::date::text)
  ) order by r.created_at desc), '[]'::jsonb)
    into v_receipts from public.receipts r
   where (r.customer_id = p_party_id or r.partner_id = p_party_id);

  if v_kind in ('office', 'customer') then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'currency', currency, 'amount', amount,
      'amount_paid', amount_paid, 'outstanding', amount - amount_paid,
      'status', status, 'transaction_id', transaction_id,
      'reference', payment_reference, 'due_at', due_at
    ) order by assigned_at desc), '[]'::jsonb)
      into v_payments from public.office_payment_assignments
     where office_id = p_party_id or customer_id = p_party_id;
  end if;

  return jsonb_build_object(
    'party', jsonb_build_object('id', v_party.id, 'name', v_party.name,
      'role', v_party.role, 'phone', v_party.phone, 'address', v_party.address,
      'note', v_party.note, 'created_at', v_party.created_at),
    'balances', v_balances, 'debts', v_debts, 'transactions', v_transactions,
    'receipts', v_receipts, 'payments', v_payments,
    'generated_at', statement_timestamp()
  );
end;
$$;

create or replace function public.sarraf_cash_reconciliation()
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_rows jsonb;
begin
  v_actor := public.sarraf_require_admin(false);
  select coalesce(jsonb_agg(jsonb_build_object(
    'currency', currency,
    'physical', physical,
    'system', system,
    'held', held,
    'debt', debt,
    'difference', round(physical - system, 10),
    'status', case when round(physical - system, 10) = 0 then 'matched' else 'discrepancy' end
  ) order by currency), '[]'::jsonb)
    into v_rows
  from (
    select currency,
      coalesce((select sum(l.amount) from public.ledger l where l.cur_id = c.currency), 0) physical,
      coalesce((select sum(a.amount) from public.account_ledger a where a.cur_id = c.currency), 0) system,
      coalesce((select sum(v.available + v.reserved) from public.customer_vaults v where v.currency = c.currency), 0) held,
      coalesce((select sum(d.outstanding_principal) from public.debts d
        where d.currency = c.currency and d.status in ('open', 'partially_settled')), 0) debt
    from (
      select cur_id currency from public.ledger
      union select cur_id from public.account_ledger
      union select currency from public.customer_vaults
      union select currency from public.debts where status in ('open', 'partially_settled')
    ) c
  ) totals;
  return jsonb_build_object('currencies', v_rows, 'generated_at', statement_timestamp());
end;
$$;

revoke all on function public.sarraf_party_profile(text, text) from public, anon;
grant execute on function public.sarraf_party_profile(text, text) to authenticated;
revoke all on function public.sarraf_cash_reconciliation() from public, anon;
grant execute on function public.sarraf_cash_reconciliation() to authenticated;

commit;
