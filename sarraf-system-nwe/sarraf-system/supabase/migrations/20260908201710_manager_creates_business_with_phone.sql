-- A manager opens a business and gives its first owner a working phone/password login in one act.
--
-- The old onboarding form asked for an internal tenant id and an email address, then instructed
-- the manager to leave ZEMAN and invite that email from the Supabase dashboard. Those are
-- implementation details, not business decisions. It also meant that a business could exist
-- without anybody able to open it.
--
-- Auth user creation remains in the server-only route. This command finishes the database half
-- atomically: tenant, defaults, owner profile and audit are either all written or none are.

begin;

create or replace function public.sarraf_manager_create_business_owner(
  p_actor_id text,
  p_business_name text,
  p_owner_name text,
  p_owner_phone text,
  p_owner_auth_id uuid,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_actor public.app_users%rowtype;
  v_business_name text := btrim(coalesce(p_business_name, ''));
  v_owner_name text := btrim(coalesce(p_owner_name, ''));
  v_owner_phone text := regexp_replace(coalesce(p_owner_phone, ''), '[^0-9]', '', 'g');
  v_tenant_id text;
  v_owner_id text;
begin
  select * into v_actor
    from public.app_users
   where id = p_actor_id
     and role = 'admin'
     and admin_level = 'manager'
     and not deleted;
  if not found then
    raise exception using errcode = '42501', message = 'only a manager may create a business';
  end if;

  if char_length(v_business_name) < 2 then
    raise exception using errcode = '22023', message = 'a business needs a name';
  end if;
  if char_length(v_owner_name) < 2 then
    raise exception using errcode = '22023', message = 'the owner needs a name';
  end if;
  if char_length(v_owner_phone) < 10 or char_length(v_owner_phone) > 15 then
    raise exception using errcode = '22023', message = 'the owner needs a valid phone number';
  end if;
  if p_owner_auth_id is null
     or not exists (select 1 from auth.users where id = p_owner_auth_id) then
    raise exception using errcode = '22023', message = 'the owner login does not exist';
  end if;
  if exists (select 1 from public.app_users where auth_id = p_owner_auth_id) then
    raise exception using errcode = '23505', message = 'that login already belongs to an account';
  end if;
  if exists (
    select 1 from public.app_users
     where regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = v_owner_phone
       and not deleted
  ) then
    raise exception using errcode = '23505', message = 'that phone already has an account';
  end if;

  loop
    v_tenant_id := 'biz-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
    exit when not exists (select 1 from public.tenants where id = v_tenant_id);
  end loop;

  loop
    v_owner_id := 'own-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
    exit when not exists (select 1 from public.app_users where id = v_owner_id);
  end loop;

  insert into public.tenants(id, name, note, created_by)
  values (v_tenant_id, v_business_name,
          nullif(left(btrim(coalesce(p_note, '')), 1000), ''), v_actor.id);

  -- A production installation may legitimately have no settings row yet. Relying on a row to
  -- copy would then create a business with no operational defaults at all. Insert the declared
  -- table defaults directly so onboarding is complete on both a fresh and an existing system.
  insert into public.control_settings(singleton, tenant_id, updated_by)
  values (true, v_tenant_id, v_actor.id);

  insert into public.receipt_control_policy(singleton, tenant_id, updated_by)
  values (true, v_tenant_id, v_actor.id);

  insert into public.app_users(
    id, auth_id, name, role, admin_level, tenant_id, phone, deleted
  ) values (
    v_owner_id, p_owner_auth_id, v_owner_name, 'admin', 'owner',
    v_tenant_id, v_owner_phone, false
  );

  perform public.sarraf_write_audit(
    v_actor.id,
    'دروستکردنی بازرگانی و خاوەن',
    format('%s — خاوەن: %s — مۆبایل: %s', v_business_name, v_owner_name, v_owner_phone)
  );

  return jsonb_build_object(
    'id', v_tenant_id,
    'name', v_business_name,
    'owner_id', v_owner_id,
    'owner_name', v_owner_name,
    'owner_phone', v_owner_phone,
    'active', true
  );
end;
$$;

comment on function public.sarraf_manager_create_business_owner(text, text, text, text, uuid, text) is
  'Server-only atomic database half of manager onboarding: business, defaults, owner profile and audit.';

revoke all on function public.sarraf_manager_create_business_owner(text, text, text, text, uuid, text)
  from public, anon, authenticated;
do $grant$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.sarraf_manager_create_business_owner(text, text, text, text, uuid, text) to service_role';
  end if;
end
$grant$;

commit;
