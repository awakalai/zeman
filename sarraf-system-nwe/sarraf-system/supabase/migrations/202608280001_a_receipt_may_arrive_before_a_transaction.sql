-- The receipt comes first. The transaction is made from it.
--
-- The owner has said this three times, and the database said the opposite:
--
--   or coalesce(p_transaction_id,'') !~ '^[A-Za-z0-9._:-]{1,140}$'   -- an absent one is refused
--   ...
--   select * into v_a from public.receipt_transaction_assignments where transaction_id=p_transaction_id;
--   if not found then
--     raise exception using errcode='42501', message='the transaction has no receipt assignment';
--   end if;
--
-- sarraf_receipt_intake_begin_v2 derives the flow, the customer, the partner, the expected
-- currency and even the storage path from an assignment row that an administrator must have
-- written first. That is the PARTNER model — staff create a transaction, name who may supply
-- evidence for it, and the named party uploads against it. It is a real flow and it stays.
--
-- It is not the flow the business runs on. A customer-seller has just paid money and has a
-- screenshot of it; they send it, the system reads it and refuses the fraudulent, the duplicate,
-- the already-sent and the altered, and what survives reaches the owner, who turns it into a
-- transaction. Requiring a transaction before accepting the receipt inverts that completely:
-- the receipt cannot be uploaded until the transaction exists, and the transaction is the thing
-- the receipt was supposed to produce. A new customer's first upload was impossible, and every
-- upload after it failed at the first call with `invalid receipt identity` — which the screen
-- reported as an unreadable image, so nothing appeared and nothing arrived.
--
-- So the transaction becomes optional, and the function says what it does with each case:
--
--   given a transaction   the assignment decides everything, exactly as before.
--   given none            the flow is customer_sells_to_zeman, the customer is the uploader
--                         (or, for a staff upload, the customer they named), there is no
--                         partner and no expected currency, because there is not yet anything
--                         for the reading to be expected to agree with.
--
-- A null expected currency is not a hole. sarraf_receipt_record_server_extraction compares
-- `v_currency <> v_doc.expected_currency`, which is NULL — never true — so a receipt with
-- nothing to disagree with is judged on its own reading alone, and an unreadable currency still
-- goes to manual review by the rule above it. Nothing is waved through.
begin;

create or replace function public.sarraf_receipt_intake_begin_v3(
  p_document_id text, p_transaction_id text, p_batch_id text, p_mime_type text,
  p_command_key text, p_override_reason text default null, p_customer_id text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_a public.receipt_transaction_assignments%rowtype;
  v_existing public.receipt_documents%rowtype;
  v_tx text; v_batch text; v_customer text;
  v_flow public.receipt_flow; v_partner text; v_currency text;
  v_reason text; v_path text; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;

  -- An absent transaction and an empty one are the same statement, and the browser has made
  -- both at different times.
  v_tx    := nullif(btrim(coalesce(p_transaction_id,'')),'');
  v_batch := nullif(btrim(coalesce(p_batch_id,'')),'');

  if p_document_id !~ '^[A-Za-z0-9-]{6,128}$'
     or (v_tx is not null and v_tx !~ '^[A-Za-z0-9._:-]{1,140}$')
     or (v_batch is not null and v_batch !~ '^[A-Za-z0-9._:-]{1,140}$')
     or coalesce(p_command_key,'') !~ '^receipt-intake:[A-Za-z0-9._:-]{8,150}$' then
    raise exception using errcode='22023', message='invalid receipt identity';
  end if;
  if coalesce(p_mime_type,'') !~ '^image/(jpeg|png|webp|heic|heif)$' then
    raise exception using errcode='22023', message='unsupported image type';
  end if;

  if v_tx is not null then
    -- ── The assignment decides. Unchanged. ────────────────────────────────────────────
    select * into v_a from public.receipt_transaction_assignments where transaction_id=v_tx;
    if not found then
      raise exception using errcode='42501', message='the transaction has no receipt assignment';
    end if;
    v_flow := v_a.flow; v_customer := v_a.customer_id;
    v_partner := v_a.partner_id; v_currency := v_a.expected_currency;

    if v_actor.role='customer' then
      if v_flow <> 'customer_sells_to_zeman' or v_customer <> v_actor.id then
        raise exception using errcode='42501', message='customers may upload only their own sale receipt';
      end if;
    elsif v_actor.role='partner' then
      if v_flow <> 'customer_buys_from_zeman' or v_partner <> v_actor.id then
        raise exception using errcode='42501', message='only the assigned partner may upload this receipt';
      end if;
    elsif v_actor.role='admin' then
      if public.receipt_request_aal() <> 'aal2' then
        raise exception using errcode='42501', message='multi-factor authentication is required';
      end if;
      if char_length(btrim(coalesce(p_override_reason,''))) < 8 then
        raise exception using errcode='22023', message='an admin override requires a reason';
      end if;
    else
      raise exception using errcode='42501', message='this role cannot upload receipts';
    end if;
    v_reason := coalesce(p_override_reason,'Receipt intake claimed by assigned uploader');
  else
    -- ── No transaction yet: the receipt is the evidence the transaction will be made from. ──
    --
    -- Only the sale flow can begin this way. A purchase is evidenced by a partner the house
    -- named, and naming them IS the assignment — there is nothing for an unassigned partner to
    -- be uploading against.
    v_flow := 'customer_sells_to_zeman';
    v_partner := null;
    v_currency := null;

    if v_actor.role='customer' then
      v_customer := v_actor.id;
      v_reason := 'Customer-seller supplied their own transfer evidence';
    elsif v_actor.role='admin' then
      if public.receipt_request_aal() <> 'aal2' then
        raise exception using errcode='42501', message='multi-factor authentication is required';
      end if;
      v_customer := nullif(btrim(coalesce(p_customer_id,'')),'');
      if v_customer is not null and not exists(
        select 1 from public.app_users
         where id=v_customer and role='customer' and not deleted) then
        raise exception using errcode='22023', message='the named customer is invalid';
      end if;
      -- Staff uploading a receipt nobody has assigned to them is ordinary counter work, not an
      -- override of somebody else's assignment, so it does not demand a written reason. The
      -- reason is still recorded when one is given.
      v_reason := coalesce(nullif(btrim(coalesce(p_override_reason,'')),''),
                           'Staff recorded receipt evidence at the counter');
    else
      raise exception using errcode='42501',
        message='only a customer-seller or staff may begin a receipt without a transaction';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select * into v_existing from public.receipt_documents where id=p_document_id;
  if found then
    if v_existing.uploader_id<>v_actor.id or v_existing.transaction_id is distinct from v_tx
       or v_existing.intake_command_key is distinct from p_command_key then
      raise exception using errcode='42501', message='receipt identity belongs to another context';
    end if;
    return jsonb_build_object('document_id',v_existing.id,'storage_path',v_existing.storage_path,
      'state',v_existing.state,'transaction_id',v_existing.transaction_id,'flow',v_existing.flow,
      'expected_currency',v_existing.expected_currency,'replayed',true);
  end if;

  -- The batch is what the browser groups an upload by and what the later ingestion command
  -- addresses, so it comes first; the transaction, when there is one, is the older key; the
  -- document's own identity is always there and is unique on its own.
  v_path := format('ingest/%s/%s.%s', coalesce(v_batch, v_tx, p_document_id), p_document_id,
    case p_mime_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png'
      when 'image/webp' then 'webp' when 'image/heic' then 'heic' else 'heif' end);
  perform set_config('app.receipt_actor_id',v_actor.id,true);
  perform set_config('app.receipt_reason',v_reason,true);
  perform set_config('app.receipt_command_key',p_command_key,true);
  insert into public.receipt_documents(
    id,flow,state,batch_id,transaction_id,uploader_id,customer_id,partner_id,
    storage_path,expected_currency,mime_type,intake_command_key)
  values (p_document_id,v_flow,'created',v_batch,v_tx,v_actor.id,
          v_customer,v_partner,v_path,v_currency,p_mime_type,p_command_key);
  update public.receipt_documents set state='uploading' where id=p_document_id;
  if v_flow='customer_buys_from_zeman' then
    insert into public.receipt_custody_ledger(
      document_id,from_partner_id,to_partner_id,transaction_id,reason,actor_id,command_key)
    values(p_document_id,null,v_partner,v_tx,
      'Assigned partner supplied original payment evidence',v_actor.id,p_command_key);
  end if;
  v_result := jsonb_build_object('document_id',p_document_id,'storage_path',v_path,
    'state','uploading','transaction_id',v_tx,'flow',v_flow,
    'expected_currency',v_currency,'replayed',false);
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values (v_actor.id,p_command_key,'receipt_intake_begin',v_result);
  return v_result;
end;
$$;

-- v2 keeps its name and its signature, and stops holding a second copy of the rules. Anything
-- still calling it — an older service worker, a tab open since this morning — behaves exactly
-- as it did, except that it may now leave the transaction out.
create or replace function public.sarraf_receipt_intake_begin_v2(
  p_document_id text, p_transaction_id text, p_batch_id text, p_mime_type text,
  p_command_key text, p_override_reason text default null
) returns jsonb
language sql security invoker set search_path = pg_catalog, public as $$
  select public.sarraf_receipt_intake_begin_v3(
    p_document_id, p_transaction_id, p_batch_id, p_mime_type, p_command_key, p_override_reason, null);
$$;

revoke all on function public.sarraf_receipt_intake_begin_v3(text,text,text,text,text,text,text)
  from public, anon;
grant execute on function public.sarraf_receipt_intake_begin_v3(text,text,text,text,text,text,text)
  to authenticated;
grant execute on function public.sarraf_receipt_intake_begin_v3(text,text,text,text,text,text,text)
  to service_role;

-- ── A new SECURITY DEFINER function is owned by whoever ran the migration ──────────────
--
-- 202608250001 moved 131 of them to sarraf_definer, a role with no BYPASSRLS, so that a
-- definer function reaches only the rows the caller's own business may see. It moved the
-- functions that existed that day, and matched them by name: `proname like 'sarraf%'`.
--
-- Both halves of that have since gone stale.
--
-- The function above did not exist that day. Created by the migration runner it would be owned
-- by postgres, and postgres bypasses row-level security, so one new function is a hole straight
-- through the tenancy the earlier migration installed.
--
-- And the name filter left four behind. Three of them belong there: is_admin, my_app_id and
-- my_role are policy helpers, and a policy helper that is itself subject to policies recurses
-- into the table it is being consulted about. They read the caller's own row and nothing else,
-- which is why the same exception is already made for sarraf_tenant and its two siblings.
--
-- The fourth is check_receipt_dupe, and it is not an exception at all. It takes a reference
-- number from the browser, searches public.receipts as an owner that ignores every policy, and
-- returns the matching receipt's id, its date and — to staff — the name of whoever uploaded it.
-- Two businesses that must share nothing were sharing that: an owner uploading a receipt could
-- be told the reference was already recorded, on a date, by a named person, in a business they
-- have no relationship with. It runs on every image anybody uploads.
grant create on schema public to sarraf_definer;
do $move$
declare f record; moved integer := 0;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_roles o on o.oid = p.proowner
     where n.nspname = 'public'
       and p.prosecdef
       and p.prorettype <> 'pg_catalog.trigger'::regtype
       -- Consulted from inside policies; they must not be subject to them.
       and p.proname not in (
             'sarraf_tenant', 'sarraf_tenant_visible', 'sarraf_sees_all_tenants',
             'sarraf_reset_installation', 'is_admin', 'my_app_id', 'my_role')
       and o.rolname <> 'sarraf_definer'
  loop
    execute format('alter function %s owner to sarraf_definer', f.sig);
    moved := moved + 1;
  end loop;
  raise notice '% definer function(s) can no longer bypass row-level security', moved;
end
$move$;
revoke create on schema public from sarraf_definer;

do $check$
declare v_left text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_left
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles o on o.oid = p.proowner
   where n.nspname='public' and p.prosecdef
     and p.prorettype <> 'pg_catalog.trigger'::regtype
     and p.proname not in ('sarraf_tenant','sarraf_tenant_visible','sarraf_sees_all_tenants',
                           'sarraf_reset_installation','is_admin','my_app_id','my_role')
     and (o.rolbypassrls or o.rolsuper);
  if v_left is not null then
    raise exception 'these definer functions still bypass row-level security: %', v_left;
  end if;
  raise notice 'a receipt may now arrive before its transaction, and no definer function bypasses tenancy';
end
$check$;

commit;
