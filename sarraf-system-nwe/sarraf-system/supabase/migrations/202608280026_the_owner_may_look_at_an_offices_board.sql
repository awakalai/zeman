-- «دەسەڵاتی ئەم کارتەم نییە — this board belongs to an office (ZE-42501)»
--
-- Reported from a real screen. The owner used «بینین وەک» to look at one of their offices, and
-- the office's own screen refused to load for them.
--
-- «بینین وەک» is impersonation in the interface only: the browser renders somebody else's portal
-- while the database session stays the owner's. The screen this replaced read
-- office_payment_assignments with a plain select, and row-level security lets an administrator
-- read their own business's assignments — so it worked. sarraf_office_board asks a stricter
-- question than the policy it replaced:
--
--     if not found or v_actor.role <> 'office' then raise …
--
-- and the owner is not an office. A command that refuses what the policy allows is a regression,
-- and this one took away the owner's ability to see what their staff see.
--
-- So the board now says whose board it is:
--
--   an office        their own, and only their own
--   an administrator any office — the same rows row-level security already lets them read,
--                    and no more: the function is owned by sarraf_definer, so the tenant
--                    policy binds it and another business's office is not found at all
--
-- Pressing «پارەم دا» is untouched and stays the office's alone. Looking is not acting: the
-- owner may see the work, and the office is still the only one who can say it paid.
begin;

create or replace function public.sarraf_office_board(
  p_days integer default 60, p_office_id text default null
) returns jsonb
language plpgsql security definer stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_office public.app_users%rowtype;
  v_days integer := least(greatest(coalesce(p_days, 60), 1), 400);
  v_since timestamptz; v_wanted text := nullif(btrim(coalesce(p_office_id, '')), '');
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode='42501', message='this board belongs to an office';
  end if;

  if v_actor.role = 'office' then
    -- An office's own board. Naming somebody else's is refused rather than quietly ignored:
    -- a screen that asks for one office and is shown another is worse than an error.
    if v_wanted is not null and v_wanted <> v_actor.id then
      raise exception using errcode='42501', message='this office payment board is not yours';
    end if;
    v_office := v_actor;
  elsif v_actor.role = 'admin' then
    if v_wanted is null then
      raise exception using errcode='22023', message='name the office whose board this is';
    end if;
    -- Read through the same policies as everything else. An office in another business is not
    -- found here, which is the tenant rule doing its job rather than a check written by hand.
    select * into v_office from public.app_users
     where id = v_wanted and role = 'office' and not deleted;
    if not found then
      raise exception using errcode='P0002', message='that office was not found';
    end if;
  else
    raise exception using errcode='42501', message='this board belongs to an office';
  end if;

  v_since := date_trunc('day', statement_timestamp()) - make_interval(days => v_days);

  return jsonb_build_object(
    'office_id', v_office.id,
    'office_name', v_office.name,
    -- True only when the person reading it is the office itself. The screen uses it to decide
    -- whether to offer the press, so that the owner is never shown a button that would refuse.
    'may_pay', v_actor.id = v_office.id,
    'waiting', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'customer', coalesce(u.name, a.customer_id, '—'),
               'amount', a.amount, 'currency', a.currency, 'assigned_at', a.assigned_at)
             order by a.assigned_at desc)
        from public.office_payment_assignments a
        left join public.app_users u on u.id = a.customer_id
       where a.office_id = v_office.id
         and a.status not in ('confirmed','cancelled','rejected')), '[]'::jsonb),
    'paid', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'customer', coalesce(u.name, a.customer_id, '—'),
               'amount', a.amount_paid, 'currency', a.currency, 'paid_at', a.confirmed_at)
             order by a.confirmed_at desc)
        from public.office_payment_assignments a
        left join public.app_users u on u.id = a.customer_id
       where a.office_id = v_office.id and a.status = 'confirmed'
         and a.confirmed_at >= v_since), '[]'::jsonb),
    'owed', coalesce((
      select jsonb_agg(jsonb_build_object('currency', c.code, 'amount', t.owed) order by c.code)
        from (select cur_id, sum(amount) as owed from public.account_ledger
               where user_id = v_office.id and kind = 'cash'
               group by cur_id having sum(amount) <> 0) t
        join public.currencies c on c.id = t.cur_id), '[]'::jsonb),
    'totals', jsonb_build_object(
      'day',   public.sarraf_office_paid_since(v_office.id, date_trunc('day', statement_timestamp())),
      'week',  public.sarraf_office_paid_since(v_office.id, date_trunc('week', statement_timestamp())),
      'month', public.sarraf_office_paid_since(v_office.id, date_trunc('month', statement_timestamp()))));
end;
$$;
revoke all on function public.sarraf_office_board(integer, text) from public, anon;
grant execute on function public.sarraf_office_board(integer, text) to authenticated;

-- The one-argument form would still be there, still refusing the owner, and still the one a
-- cached browser calls. There is only one board.
drop function if exists public.sarraf_office_board(integer);

grant create on schema public to sarraf_definer;
alter function public.sarraf_office_board(integer, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
