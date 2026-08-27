-- The server's own key could not see the receipt it had just been handed.
--
--   ERROR:  receipt intake not found
--
-- /api/receipt-ocr downloads the stored original and records what the reader saw through
-- sarraf_receipt_record_server_extraction. That function is granted to service_role and to
-- nobody else, and service_role holds BYPASSRLS: on its own it sees every row in this database.
--
-- The function does not run as service_role. 202608250001 moved it to sarraf_definer so that a
-- SECURITY DEFINER function could not step around tenancy — and sarraf_definer is a member of
-- authenticated, so the restrictive tenant policy binds it. That policy asks
-- sarraf_tenant_visible(tenant_id), which asks who auth.uid() is:
--
--   select public.sarraf_sees_all_tenants()
--       or (p_tenant is not null and p_tenant = public.sarraf_tenant());
--
-- On a service-key request there is no user. auth.uid() is null, sarraf_tenant() is null,
-- sees_all_tenants is false, and every row is invisible. `select ... into v_doc` finds nothing,
-- the function raises 'receipt intake not found', and the route turns that into
-- ocr_record_failed. Because the thing that just failed IS the route's failure recorder, nothing
-- is written at all: no attempt row, no state change, no error code on the document.
--
-- Which is exactly what the live system shows. Every receipt uploaded since 25 August, when that
-- migration was applied, sits at `uploading` with ocr_attempts 0 and a null error. The last
-- image this system ever read was on the 17th. The tenancy fix broke the reader, and broke it in
-- the one way that leaves nothing behind to follow.
--
-- ── which functions, and why only these ───────────────────────────────────────
--
-- Two, and they are named here rather than matched by a rule, because the first rule tried —
-- "service_role may execute it and authenticated may not" — swept in every internal helper in
-- the schema. 202608270001 granted EXECUTE on all functions to service_role, so that test is
-- true of almost everything, including helpers that run *inside* a user's command and must stay
-- bound to that user's business.
--
--   sarraf_receipt_record_server_extraction   /api/receipt-ocr, service key, no user
--   sarraf_office_payment_attach_evidence_server  /api/office-payment-evidence, likewise
--
-- Both are entry points a browser cannot reach, called only by a server that has already
-- authenticated the caller and checked the row belongs to them, addressed by primary key.
-- Subjecting them to a policy that reads a user who is not there protects nobody; it only stops
-- the work. Every other definer function is reached with the caller's own token — including
-- sarraf_ingest_receipt_batch, which the recovery route deliberately calls on a client carrying
-- the user's Authorization header — and stays exactly as it was.
begin;

grant create on schema public to sarraf_definer;
do $restore$
declare f record; moved integer := 0; v_owner text := current_user;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      join pg_roles o on o.oid = p.proowner
     where p.prosecdef
       and o.rolname = 'sarraf_definer'
       and p.proname in ('sarraf_receipt_record_server_extraction',
                         'sarraf_office_payment_attach_evidence_server')
  loop
    execute format('alter function %s owner to %I', f.sig, v_owner);
    raise notice 'the server may act on its own again: %', f.proname;
    moved := moved + 1;
  end loop;
  if moved = 0 then
    raise notice 'neither server-only function was being held behind a user tenancy check';
  end if;
end
$restore$;
revoke create on schema public from sarraf_definer;

-- Neither may be reachable from a browser. That is the whole basis for letting them see rows
-- without a user attached, so it is asserted rather than assumed.
do $check$
declare v_open text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_open
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where p.proname in ('sarraf_receipt_record_server_extraction',
                       'sarraf_office_payment_attach_evidence_server')
     and (has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute'));
  if v_open is not null then
    raise exception 'a browser can call these, so they must not bypass tenancy: %', v_open;
  end if;
  raise notice 'both server-only functions remain closed to every browser';
end
$check$;

commit;
