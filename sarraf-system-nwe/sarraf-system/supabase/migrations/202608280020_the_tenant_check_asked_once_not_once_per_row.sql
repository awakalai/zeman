-- The tenant check, asked once per query instead of once per row.
--
-- 202608280019 gave the opening queries the indexes they ask for, and the ledger's first page
-- went from 1230 ms to 65 ms because PostgreSQL could stop once the page was full instead of
-- reading the table. The rest of that 65 ms is this:
--
--     Filter: (sarraf_tenant_visible(tenant_id) AND (is_admin() OR ...))
--
-- `sarraf_tenant_visible` takes a column of the row, so it cannot be hoisted out of the loop —
-- it is invoked for every row PostgreSQL looks at. It is `security definer`, and a security
-- definer SQL function is never inlined by the planner, so each invocation is a real function
-- call that runs two more security definer functions, each of which queries app_users.
--
-- On 20,000 rows, read as `authenticated`:
--
--                     as written    asked once    
--     page 1            58.3 ms       4.1 ms      14.1× 
--     last page       1231.1 ms      66.7 ms      18.5× 
--     count(*)        1161.2 ms      73.4 ms      15.8× 
--
-- `count(*)` matters more than it looks: the loader asks for the count FIRST, to find out how
-- many pages there are. Every whole-table read in this application paid that second and a half
-- before it fetched a single row.
--
-- ── what changes, and why it is the same rule ────────────────────────────────
--
-- `sarraf_tenant_visible(p_tenant)` is defined as, in full:
--
--     select public.sarraf_sees_all_tenants()
--         or (p_tenant is not null and p_tenant = public.sarraf_tenant());
--
-- The policies below are given that body directly, with each argument-free call wrapped in a
-- scalar subquery:
--
--     (select public.sarraf_sees_all_tenants())
--       or (tenant_id is not null and tenant_id = (select public.sarraf_tenant()))
--
-- `(select f())` is how you tell PostgreSQL that f() does not depend on the row: it becomes an
-- InitPlan, evaluated once for the whole statement. The predicate is the same predicate — same
-- functions, same operators, same order — and the rows it admits are the same rows. Only the
-- number of times the question is asked changes.
--
-- The function itself is left in place and unchanged. It is called from many places that are not
-- policies, and there is nothing wrong with it; the cost is in asking it per row.
--
-- ── on rewriting policies in a loop ──────────────────────────────────────────
--
-- There are 62 of these and they are identical, which is exactly the situation where hand-editing
-- 62 blocks of SQL introduces the one typo that opens one business's books to another. So the
-- rewrite is done by reading pg_policies — and it REFUSES anything that is not precisely the
-- shape described above rather than reshaping it. A policy with a different predicate is a policy
-- a person needs to look at, not one a loop should touch.
--
-- The whole loop is one statement, so it is one transaction: either every policy is rewritten or
-- none is. There is no moment where a table sits without its tenant restriction.

do $rewrite$
declare
  r record;
  v_predicate constant text :=
    '(select public.sarraf_sees_all_tenants()) '
    'or (tenant_id is not null and tenant_id = (select public.sarraf_tenant()))';
  v_shapes constant text[] :=
    array['sarraf_tenant_visible(tenant_id)', '(sarraf_tenant_visible(tenant_id))'];
  v_using text;
  v_check text;
  v_count integer := 0;
begin
  for r in
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') like '%sarraf_tenant_visible%'
         or coalesce(with_check, '') like '%sarraf_tenant_visible%')
     order by tablename, policyname
  loop
    -- pg_policies renders the expression through the deparser, so `public.` may or may not be
    -- present depending on search_path, and the whole thing may or may not be parenthesised.
    -- Both are normalised away; anything else is a shape this migration was not written for.
    v_using := regexp_replace(coalesce(r.qual, ''), '(public\.)|\s', '', 'g');
    v_check := regexp_replace(coalesce(r.with_check, ''), '(public\.)|\s', '', 'g');

    if not (v_using = any (v_shapes))
       or not (v_check = any (v_shapes))
       or r.cmd <> 'ALL'
       or r.roles::text <> '{authenticated}'
    then
      raise exception
        'policy %.% (%) is not the shape this migration rewrites — using=%, check=%, cmd=%, roles=%; look at it by hand',
        r.schemaname, r.tablename, r.policyname, r.qual, r.with_check, r.cmd, r.roles;
    end if;

    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    execute format(
      'create policy %I on %I.%I as %s for all to authenticated using (%s) with check (%s)',
      r.policyname, r.schemaname, r.tablename,
      case when r.permissive = 'RESTRICTIVE' then 'restrictive' else 'permissive' end,
      v_predicate, v_predicate);
    v_count := v_count + 1;
  end loop;

  -- A migration that quietly rewrote nothing looks exactly like one that worked.
  if v_count = 0 then
    raise exception 'no tenant policies were found to rewrite — this migration did nothing';
  end if;
  raise notice 'tenant predicate asked once per query on % policies', v_count;
end
$rewrite$;
