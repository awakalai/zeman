-- An account with money or debt is still part of the books. It cannot disappear from the
-- working screens until every currency is clear. The service route calls this command after
-- checking the administrator's rank; the command repeats tenant and active-account checks and
-- makes the financial check and deactivation one database transaction.
begin;

create or replace function public.sarraf_deactivate_user_if_clear(
  p_actor_id text,
  p_user_id text,
  p_tenant_id text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_target public.app_users%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_positions jsonb;
begin
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'a deactivation reason of 3 to 500 characters is required';
  end if;

  select * into v_actor from public.app_users where id = p_actor_id for update;
  if not found or v_actor.deleted or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'an active administrator is required';
  end if;

  select * into v_target from public.app_users where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'account not found';
  end if;
  if v_target.tenant_id is distinct from p_tenant_id then
    raise exception using errcode = '42501', message = 'account is outside the selected business';
  end if;
  if coalesce(v_actor.admin_level, 'operator') <> 'manager'
     and v_actor.tenant_id is distinct from v_target.tenant_id then
    raise exception using errcode = '42501', message = 'account is outside the administrator business';
  end if;
  if v_target.deleted then
    return jsonb_build_object('ok', true, 'already_inactive', true, 'positions', '[]'::jsonb);
  end if;

  -- Every amount is kept in its original currency. No exchange rate can make an open position
  -- look like zero, and opposite currencies are never netted together.
  with positions as (
    select 'account_balance'::text kind, cur_id::text currency, sum(amount)::numeric amount
      from public.account_ledger
     where user_id = p_user_id and tenant_id is not distinct from p_tenant_id
     group by cur_id
    union all
    select 'customer_vault', currency, (available + reserved + pending)::numeric
      from public.customer_vaults
     where customer_id = p_user_id and tenant_id is not distinct from p_tenant_id
    union all
    select 'partner_account', currency, (available + reserved)::numeric
      from public.partner_accounts
     where partner_id = p_user_id and tenant_id is not distinct from p_tenant_id
    union all
    select 'debt', currency, sum(outstanding_principal)::numeric
      from public.debts
     where (debtor_id = p_user_id or creditor_id = p_user_id)
       and tenant_id is not distinct from p_tenant_id
       and status in ('open', 'partially_settled')
       and outstanding_principal <> 0
     group by currency
    union all
    select 'customer_holding', cur_id::text, sum(amount)::numeric
      from public.ledger
     where customer_id = p_user_id and tenant_id is not distinct from p_tenant_id
     group by cur_id
    union all
    select 'partner_holding', cur_id::text, sum(amount)::numeric
      from public.ledger
     where partner_id = p_user_id and tenant_id is not distinct from p_tenant_id
     group by cur_id
    union all
    select 'office_holding', cur_id::text, sum(amount)::numeric
      from public.ledger
     where office_id = p_user_id and tenant_id is not distinct from p_tenant_id
     group by cur_id
    union all
    select 'investor_capital', cur_id::text, sum(amount)::numeric
      from public.ledger
     where investor_id = p_user_id and tenant_id is not distinct from p_tenant_id
       and owner = 'investor'
     group by cur_id
  ), nonzero as (
    select kind, currency, amount
      from positions
     where abs(coalesce(amount, 0)) > 0.0000000001
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', kind, 'currency', currency, 'amount', amount
  ) order by kind, currency), '[]'::jsonb)
    into v_positions
    from nonzero;

  if jsonb_array_length(v_positions) > 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'outstanding_financial_position',
      'positions', v_positions
    );
  end if;

  update public.app_users
     set deleted = true
   where id = v_target.id
     and tenant_id is not distinct from p_tenant_id
     and deleted = false;
  if not found then
    raise exception using errcode = '40001', message = 'account changed while it was being deactivated';
  end if;

  insert into public.audit(id, date, user_id, action, detail, tenant_id)
  values (
    'deactivate-' || md5(clock_timestamp()::text || random()::text || p_user_id),
    statement_timestamp(),
    v_actor.id,
    'ناچالاککردنی ئەکاونت',
    format('%s (%s) — %s', v_target.name, v_target.role, v_reason),
    p_tenant_id
  );

  return jsonb_build_object('ok', true, 'positions', '[]'::jsonb);
end;
$$;

revoke all on function public.sarraf_deactivate_user_if_clear(text,text,text,text) from public, anon, authenticated;
grant execute on function public.sarraf_deactivate_user_if_clear(text,text,text,text) to service_role;

comment on function public.sarraf_deactivate_user_if_clear(text,text,text,text) is
  'Atomically refuses deactivation while any per-currency balance, holding, capital, or debt remains.';

commit;
