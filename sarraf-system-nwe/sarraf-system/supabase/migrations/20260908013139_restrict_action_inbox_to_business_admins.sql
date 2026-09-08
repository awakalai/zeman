-- Offices have their own assignment-scoped portal. The general action inbox contains receipt
-- review and transaction work and therefore belongs only to business administrators.
begin;

create or replace function public.sarraf_action_inbox_v3(p_limit integer default 80)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 80), 1), 100);
begin
  select * into v_actor
    from public.app_users
   where auth_id = auth.uid()
     and not deleted;

  if not found or v_actor.role <> 'admin' then
    raise exception using errcode = '42501', message = 'operations are not authorized';
  end if;

  return public.sarraf_action_inbox_v2(v_limit);
end;
$$;

revoke all on function public.sarraf_action_inbox_v3(integer) from public, anon;
grant execute on function public.sarraf_action_inbox_v3(integer) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_action_inbox_v3(integer) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

comment on function public.sarraf_action_inbox_v3(integer) is
  'Bounded business-admin read queue. Offices use their dedicated, assignment-scoped portal.';

commit;
