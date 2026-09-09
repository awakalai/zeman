-- ZEMAN deliberately uses phone number + password without a second-factor gate.
--
-- Authentication still comes from Supabase Auth, authorization still comes from the active
-- app_users row, every privileged command still checks the actor's role, and the command/audit
-- layer is unchanged. This migration removes only the historical AAL2 requirement that could
-- leave an otherwise valid owner, employee or office locked outside the system.
--
-- A number of already-installed receipt commands call receipt_request_aal() directly. Its name
-- is retained as a compatibility seam so those functions do not have to be copied wholesale:
-- an authenticated password session satisfies the product's chosen assurance policy; an
-- anonymous database call does not.

begin;

create or replace function public.receipt_request_aal()
returns text
language sql
stable
set search_path = pg_catalog, public, auth
as $$
  select case
    when auth.uid() is not null then 'aal2'
    else coalesce(nullif(current_setting('request.jwt.claim.aal', true), ''), 'aal1')
  end;
$$;

comment on function public.receipt_request_aal() is
  'Compatibility helper: authenticated password sessions satisfy ZEMAN receipt command assurance; anonymous calls do not.';

create or replace function public.sarraf_request_aal()
returns text
language sql
stable
set search_path = pg_catalog, public, auth
as $$
  select public.receipt_request_aal();
$$;

comment on function public.sarraf_request_aal() is
  'Compatibility helper for installed command functions after ZEMAN selected password-only authentication.';

create or replace function public.sarraf_require_admin(p_owner boolean default false)
returns public.app_users
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
begin
  v_actor := public.sarraf_actor();
  if v_actor.role <> 'admin'
     or (p_owner and coalesce(v_actor.admin_level, '') <> 'owner') then
    raise exception using
      errcode = '42501',
      message = case when p_owner
        then 'only the system owner may perform this command'
        else 'administrator authorization is required'
      end;
  end if;
  return v_actor;
end;
$$;

comment on function public.sarraf_require_admin(boolean) is
  'Requires an active administrator (and optionally the business owner); no second factor is part of the ZEMAN login policy.';

commit;
