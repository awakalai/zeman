-- Nineteen commands a signed-out browser could call (§ baseline section 6.b).
--
-- The live inspection found 19 of the 163 SECURITY DEFINER functions callable by `anon` — the
-- role a browser holds before anybody signs in. Among them sarraf_request_approval, which raises
-- an approval request; sarraf_claim_pending_account, which turns a login into an account; and
-- sarraf_tenant, sarraf_is_owner, sarraf_is_manager, sarraf_sees_all_tenants, which are what the
-- tenant policies themselves consult.
--
-- Nobody granted anon anything. PostgreSQL grants EXECUTE on every new function to PUBLIC by
-- default, and PUBLIC includes anon. The 144 other definer functions are closed only because
-- their migrations wrote `revoke all ... from public, anon` after creating them; these nineteen
-- were written with `grant execute ... to authenticated` and nothing else, which adds a grant
-- without removing the one that was already there.
--
-- What it is worth in practice today: anon holds EXECUTE and no table privileges at all — not
-- one SELECT on one table in public — so a function it can call still cannot read or write
-- anything, and every one of these begins by looking up the caller in app_users and refusing.
-- That is defence in depth working, not a reason to leave the outer door open. A single future
-- function that trusts its arguments before it checks its caller is all it would take.
--
-- ── The three groups, treated differently, because they are different ─────────────────────────
--
--   · A trigger function is never called by anybody. PostgreSQL checks EXECUTE when the trigger
--     is created, not when it fires, so these need no grant at all and get none.
--   · A function the browser calls keeps exactly the access it has: authenticated.
--   · A function the server calls with its own key, or that is evaluated as a column default
--     when the service role writes — sarraf_tenant() is the reason this matters — keeps
--     service_role. Its EXECUTE came through PUBLIC, so revoking PUBLIC without this would
--     break every write the server makes.
--
-- Nothing here changes what any function does, or who it lets through once called.

begin;

do $$
declare
  r record;
  v_has_service boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  v_triggers int := 0; v_callable int := 0;
begin
  for r in
    select p.oid, p.oid::regprocedure::text as signature,
           p.prorettype = 'pg_catalog.trigger'::regtype as is_trigger
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname like 'sarraf%'
       -- Two overlapping sets, on purpose. Every definer function a signed-out browser can
       -- call, and every trigger function anybody can call at all — the second is not limited
       -- to SECURITY DEFINER, because four of them (sarraf_protect_append_only among them) are
       -- plain invoker functions that carry the same PUBLIC grant for the same reason.
       and (
         (p.prosecdef and has_function_privilege('anon', p.oid, 'execute'))
         or (p.prorettype = 'pg_catalog.trigger'::regtype
             and (has_function_privilege('anon', p.oid, 'execute')
                  or has_function_privilege('authenticated', p.oid, 'execute')))
       )
  loop
    -- PUBLIC is where anon's EXECUTE actually comes from; revoking it from anon alone would
    -- change nothing at all, which is the trap this whole migration exists because of.
    execute format('revoke execute on function %s from public, anon', r.signature);
    if r.is_trigger then
      execute format('revoke execute on function %s from authenticated', r.signature);
      v_triggers := v_triggers + 1;
    else
      execute format('grant execute on function %s to authenticated', r.signature);
      if v_has_service then
        execute format('grant execute on function %s to service_role', r.signature);
      end if;
      v_callable := v_callable + 1;
    end if;
  end loop;
  raise notice 'closed % trigger function(s) to everybody and % callable function(s) to anon', v_triggers, v_callable;
end $$;

-- Said once, so that a function added tomorrow does not quietly inherit the same PUBLIC grant.
-- This changes the default for functions created from here on by the migrating role; it does not
-- touch anything already created.
alter default privileges in schema public revoke execute on functions from public;

commit;
