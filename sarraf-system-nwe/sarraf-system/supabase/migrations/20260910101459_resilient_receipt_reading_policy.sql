-- Recovery Batch 4: the reader may fail over, but only server-side evidence policy decides
-- whether a reading is ready, needs a person, or must be kept in the archive.
begin;

create or replace function public.sarraf_enforce_receipt_reading_policy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_read public.receipt_extractions%rowtype;
  v_declared text;
  v_integrity boolean;
  v_duplicate text;
  v_critical_confidence numeric;
begin
  -- The extraction command first writes PARSED and then writes its verdict. Intercept only that
  -- final verdict, so the installed state machine still sees every legal intermediate step.
  if old.state <> 'parsed' or new.state not in
     ('validated','needs_manual_review','currency_mismatch') then
    return new;
  end if;

  select * into v_read from public.receipt_extractions
   where document_id = new.id and is_original order by version limit 1;
  if not found then return new; end if;
  -- Manual fixtures and historical human readings keep their established review semantics.
  -- This automatic policy is for the canonical server-attested OCR path only.
  if not v_read.server_recorded or v_read.request_id is null then return new; end if;

  v_declared := lower(nullif(btrim(v_read.raw->>'declaredPlatform'),''));
  v_integrity := coalesce((v_read.raw #>> '{integrity,tamperSuspected}')::boolean, false);

  if v_read.raw->>'ok' = 'false' then
    new.state := 'rejected'; new.counted := false;
    new.rule_code := 'not_a_payment_receipt';
    new.rule_reason := 'The image is not a supported payment receipt';
    return new;
  end if;

  if v_integrity then
    new.state := 'tamper_suspected'; new.counted := false;
    new.rule_code := 'visible_tamper_suspected';
    new.rule_reason := left(coalesce(nullif(array_to_string(array(
      select jsonb_array_elements_text(coalesce(v_read.raw #> '{integrity,reasons}','[]'::jsonb))
    ), '; '), ''), 'Visible signs of image manipulation'), 700);
    return new;
  end if;

  -- An identical stored image is a hard duplicate even while the older receipt is still being
  -- reviewed. The older evidence wins; terminal refusals never poison a later honest upload.
  select d.id into v_duplicate
    from public.receipt_documents d
   where d.id <> new.id
     and d.tenant_id is not distinct from new.tenant_id
     and d.image_sha256 = new.image_sha256
     and d.received_at <= new.received_at
     and d.state not in ('rejected','cancelled','failed_terminal','duplicate','tamper_suspected')
   order by d.received_at, d.id limit 1;
  if v_duplicate is not null then
    new.state := 'duplicate'; new.counted := false;
    new.rule_code := 'exact_image_duplicate';
    new.rule_reason := 'Exact image already belongs to receipt ' || v_duplicate;
    return new;
  end if;

  if v_declared in ('alipay','wechat') and v_read.platform is distinct from v_declared then
    new.state := 'needs_manual_review'; new.counted := false;
    new.rule_code := 'declared_platform_mismatch';
    new.rule_reason := format('Upload declared %s but OCR evidence read %s',
      v_declared, coalesce(v_read.platform,'unknown'));
    return new;
  end if;

  select min(value::numeric) into v_critical_confidence
    from jsonb_each_text(v_read.field_confidence)
   where key in ('amount','currency','txDate','platform')
     and value ~ '^[0-9]+([.][0-9]+)?$';

  if new.state = 'validated' and (
       coalesce(v_read.confidence,0) < 0.88
       or coalesce(v_critical_confidence,0) < 0.80
       or greatest(coalesce((v_read.field_confidence->>'refNo')::numeric,0),
                   coalesce((v_read.field_confidence->>'merchantOrderNo')::numeric,0)) < 0.80
       or (v_read.raw->'validation'->>'grossMatches') = 'false'
     ) then
    new.state := 'needs_manual_review'; new.counted := false;
    new.rule_code := 'confidence_below_auto_ready';
    new.rule_reason := 'Critical OCR evidence is below the automatic-ready threshold';
  end if;
  return new;
end;
$$;

drop trigger if exists receipt_reading_policy_guard on public.receipt_documents;
create trigger receipt_reading_policy_guard
before update of state on public.receipt_documents
for each row execute function public.sarraf_enforce_receipt_reading_policy();

revoke all on function public.sarraf_enforce_receipt_reading_policy() from public, anon, authenticated;
grant create on schema public to sarraf_definer;
alter function public.sarraf_enforce_receipt_reading_policy() owner to sarraf_definer;

create or replace function public.sarraf_can_restore_archived_receipts()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select exists(
    select 1 from public.app_users
     where auth_id=auth.uid() and not deleted and role='admin' and admin_level='owner'
  );
$$;
revoke all on function public.sarraf_can_restore_archived_receipts() from public, anon;
grant execute on function public.sarraf_can_restore_archived_receipts() to authenticated;

create or replace function public.sarraf_restore_archived_receipt(
  p_document_id text, p_reason text, p_command_key text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_doc public.receipt_documents%rowtype;
  v_previous jsonb;
  v_result jsonb;
begin
  v_actor := public.sarraf_require_admin(true);
  if char_length(btrim(coalesce(p_reason,''))) < 8
     or char_length(btrim(coalesce(p_command_key,''))) < 8 then
    raise exception using errcode='22023', message='an 8-character reason and command key are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_previous from public.receipt_command_log
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_previous || jsonb_build_object('replayed',true); end if;

  select * into v_doc from public.receipt_documents where id=p_document_id for update;
  if not found or v_doc.tenant_id is distinct from v_actor.tenant_id then
    raise exception using errcode='P0002', message='archived receipt not found';
  end if;
  if v_doc.state not in ('duplicate','tamper_suspected') then
    raise exception using errcode='23514', message='only an automatically archived receipt can be restored';
  end if;

  perform set_config('app.receipt_actor_id',v_actor.id,true);
  perform set_config('app.receipt_reason',left(btrim(p_reason),700),true);
  perform set_config('app.receipt_command_key',p_command_key,true);
  update public.receipt_documents set state='needs_manual_review', counted=false,
    rule_code='owner_restored', rule_reason=left(btrim(p_reason),700)
   where id=p_document_id;
  v_result := jsonb_build_object('document_id',p_document_id,'state','needs_manual_review','replayed',false);
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'restore_archive',v_result);
  return v_result;
end;
$$;

revoke all on function public.sarraf_restore_archived_receipt(text,text,text) from public, anon, authenticated;
grant execute on function public.sarraf_restore_archived_receipt(text,text,text) to authenticated;
alter function public.sarraf_restore_archived_receipt(text,text,text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
