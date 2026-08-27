-- The send was refused by the very thing that had just authorized it.
--
--   ERROR:  receipt command was not authorized by the ingestion service
--
-- Sending a batch is two steps on purpose. The browser's own call to sarraf_ingest_receipt_batch
-- is refused — the command must be blessed by a service only the server can speak for — so the
-- client falls back to /api/receipt-ingestion, which mints a row in
-- receipt_ingestion_authorizations with the service key and then runs the same RPC under the
-- caller's own token. The RPC deletes that row and proceeds:
--
--   delete from public.receipt_ingestion_authorizations
--    where command_key = p_command_key and actor_id = v_actor.id
--      and authorization_token = v_authorization_token
--      and expires_at > statement_timestamp()
--   returning actor_id into v_authorized_actor;
--   if v_authorized_actor is null then raise exception '... not authorized ...'; end if;
--
-- 202608240002 gave that table a tenant_id defaulting to sarraf_tenant(), and a restrictive
-- policy that hides any row belonging to another business. The row is written by the service
-- key, on a request with no user attached, so sarraf_tenant() returns null and the row is
-- stored with no business at all. The RPC then looks for it as sarraf_definer on behalf of the
-- customer, where the restrictive policy asks sarraf_tenant_visible(null) — and a null tenant
-- matches nobody, deliberately, because two unknowns are not the same business.
--
-- So the authorization is minted and is invisible to the only command that may redeem it.
-- Every send in this installation's history has ended there: public.receipts is empty,
-- public.receipt_batches is empty, receipt_ingestion_commands has never recorded a command.
--
-- This is the third time tonight the same shape has broken something: a row written by the
-- server with no user attached, read back by something bound to a user's business. The reader
-- was 202608280004; the bucket was 202608280006; this is the send.
--
-- The fix is not to widen the policy. The row already names the person it is for — actor_id is
-- NOT NULL and references app_users — so the business is not unknown, it is simply not being
-- written down. A trigger writes it down, from the actor's own account, and only when the
-- caller did not state it.
begin;

create or replace function public.sarraf_authorization_belongs_to_its_actor()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.tenant_id is null and new.actor_id is not null then
    select u.tenant_id into new.tenant_id
      from public.app_users u
     where u.id = new.actor_id and not u.deleted;
  end if;
  return new;
end;
$$;

drop trigger if exists receipt_ingestion_authorizations_tenant
  on public.receipt_ingestion_authorizations;
create trigger receipt_ingestion_authorizations_tenant
  before insert or update on public.receipt_ingestion_authorizations
  for each row execute function public.sarraf_authorization_belongs_to_its_actor();

-- Anything already sitting there with no business is an authorization nobody can redeem.
update public.receipt_ingestion_authorizations a
   set tenant_id = u.tenant_id
  from public.app_users u
 where u.id = a.actor_id and a.tenant_id is null and u.tenant_id is not null;

do $check$
declare v_orphans integer;
begin
  select count(*) into v_orphans
    from public.receipt_ingestion_authorizations a
    join public.app_users u on u.id = a.actor_id
   where a.tenant_id is null and u.tenant_id is not null;
  if v_orphans > 0 then
    raise exception '% authorization(s) still belong to no business', v_orphans;
  end if;
  raise notice 'every ingestion authorization now names the business it was minted for';
end
$check$;

commit;
