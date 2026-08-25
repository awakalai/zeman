-- Which account is which, and which sign-in belongs to it.
--
-- Read-only. The workflow opens the transaction with `set transaction read only`, so the server
-- refuses any write here rather than trusting that none was written.
--
-- The owner cannot tell which of the logins is the manager's. That is a fair thing not to know:
-- app_users holds the person and their rank, auth.users holds the address they sign in with, and
-- nothing in the interface puts the two side by side. So this does.
--
-- No password appears here and none could. Supabase stores a bcrypt hash, which is not the
-- password and cannot be turned back into it — that is the point of storing it that way. What
-- can be answered is which address to use, and whether that address has ever signed in.

\pset format aligned
\pset border 2
\pset null '—'
\pset pager off

\echo ''
\echo '════════ Every account, its rank, its business, and the address it signs in with ════════'
\echo ''

select
  coalesce(u.admin_level, u.role)                as rank,
  u.name,
  coalesce(u.tenant_id, '— (manager: no business)') as business,
  coalesce(a.email, '⚠ NO SIGN-IN LINKED')       as sign_in_email,
  case when u.deleted then 'deactivated' else 'active' end as state,
  case
    when a.id is null then 'cannot sign in — app account has no auth user'
    when a.last_sign_in_at is null then 'never signed in'
    else 'last signed in ' || to_char(a.last_sign_in_at, 'YYYY-MM-DD HH24:MI')
  end as sign_in_history
from public.app_users u
left join auth.users a on a.id = u.auth_id
order by case coalesce(u.admin_level, u.role)
           when 'manager' then 1 when 'owner' then 2 when 'operator' then 3 else 4 end,
         u.name;

\echo ''
\echo '════════ Sign-ins with no account behind them ════════'
\echo ''
\echo 'A login here can authenticate but the application will refuse it: there is no app_users row,'
\echo 'so it has no rank and belongs to no business.'
\echo ''

select a.email,
       to_char(a.created_at, 'YYYY-MM-DD') as created,
       case when a.last_sign_in_at is null then 'never signed in'
            else to_char(a.last_sign_in_at, 'YYYY-MM-DD HH24:MI') end as last_sign_in
  from auth.users a
 where not exists (select 1 from public.app_users u where u.auth_id = a.id)
 order by a.created_at;

\echo ''
\echo '════════ The manager, specifically ════════'
\echo ''

do $mgr$
declare r record; n integer := 0;
begin
  for r in
    select u.id, u.name, coalesce(a.email, '<none>') as email, u.auth_id,
           u.deleted, a.id is null as no_auth
      from public.app_users u
      left join auth.users a on a.id = u.auth_id
     where u.role = 'admin' and u.admin_level = 'manager'
  loop
    n := n + 1;
    raise notice 'manager: % (%) — sign in with: %', r.name, r.id, r.email;
    if r.no_auth then
      raise notice '  ⚠ this account has no sign-in attached, so nobody can log in as it';
    end if;
    if r.deleted then
      raise notice '  ⚠ this account is deactivated';
    end if;
  end loop;
  if n = 0 then
    raise notice 'there is no manager account at all';
  elsif n > 1 then
    raise notice '⚠ % manager accounts exist; there should be one', n;
  end if;
end
$mgr$;
