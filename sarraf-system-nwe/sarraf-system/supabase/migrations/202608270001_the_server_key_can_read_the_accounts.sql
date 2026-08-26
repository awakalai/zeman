-- The account-creation route could not read app_users at all.
--
-- A business owner signs in, opens the people screen, tries to add one of their own staff, and is
-- told their login has no account in the system. The account is there. What is not there is the
-- server's right to look at it:
--
--   permission denied for table app_users
--
--   privilege | service_role | authenticated
--   select    |      f       |       t
--   insert    |      f       |       f
--   update    |      f       |       f
--
-- service_role — the key /api/admin-user uses, which never leaves the server — holds nothing on
-- app_users. It bypasses row-level security, which is what everybody remembers about it, and
-- bypassing a policy is not the same as being allowed to read a table. No policy was ever
-- reached; the grant was missing underneath.
--
-- Nothing revoked it. No `revoke` in this repository names service_role, and none of the
-- thirty-five of them touches app_users. The grant was simply never made, and two earlier
-- migrations patched two tables by hand when somebody hit the same wall — which is the shape of a
-- problem being met one table at a time instead of once.
--
-- So it is made once, for the whole schema, and for tables added later as well. That is the
-- posture Supabase ships with: service_role is the trusted server-side identity, its key is never
-- in a browser, and it already ignores row-level security — so a grant withheld from it buys
-- nothing and costs an owner the ability to hire anybody.
begin;

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- The table added next month, without anybody remembering. The two hand-patched tables in
-- 202608110001 are what forgetting looks like.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;

do $check$
declare v_missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relkind = 'r'
     and not has_table_privilege('service_role', c.oid, 'select');
  if v_missing is not null then
    raise exception 'service_role still cannot read: %', v_missing;
  end if;
  raise notice 'service_role can read every table in public';
end
$check$;

commit;
