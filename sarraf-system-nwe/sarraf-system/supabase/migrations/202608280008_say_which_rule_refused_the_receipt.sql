-- Which rule refused it, in the receipt's own words.
--
-- Four receipts were refused this morning. Every one of them was written down as
--
--   rule_code   'server_rejected'
--   rule_reason 'فیشەکە یاساکانی ناردنی نەبڕیوە'
--
-- which is the command's default — the text it falls back to when the browser named no reason.
-- The uploader was told, in a sentence I wrote and which assumes its own answer, that the server
-- had refused them "as duplicates". They were not duplicates: nothing has ever been accepted in
-- this installation for them to duplicate, and all four images and all four references are
-- distinct.
--
-- The real decision is a conjunction of eight rules wearing a single boolean:
--
--   v_accept := coalesce(r->>'intake_status','')='accepted'
--     and coalesce(r->>'status','')='ok' and coalesce(r->>'counted','') in ('true','t','1')
--     and v_amount > 0 and v_amount <= 1000000000000 and v_fee >= 0 and v_fee <= v_amount
--     and v_row_currency ~ '^[A-Z]{3,8}$' and v_row_currency = v_currency;
--
-- The command knows which of the eight failed, at the moment it fails, and throws that away.
-- Settling it cost two readings of the live database and a guess that turned out wrong — for the
-- fourth time tonight a failure was silent, and this is the last of them.
--
-- Each refusal now names its own rule. The first is the one that matters most today: a receipt
-- that never claimed acceptance is almost always a browser running yesterday's code, and the
-- reason says so and says what to do about it.
--
-- A receipt the uploader themselves marked rejected keeps the uploader's reason. Theirs is the
-- more useful one, and overwriting it would lose why a person refused a receipt.
begin;

create or replace function public.sarraf_ingest_receipt_batch(p_batch jsonb, p_receipts jsonb, p_command_key text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, storage
as $$
declare
  v_actor public.app_users%rowtype;
  v_batch_id text := btrim(p_batch->>'id');
  v_customer_id text := nullif(btrim(p_batch->>'customer_id'), '');
  v_partner_id text := nullif(btrim(p_batch->>'partner_id'), '');
  v_currency text := upper(coalesce(nullif(btrim(p_batch->>'currency'),''),'UNKNOWN'));
  v_count int;
  v_accepted int := 0;
  v_rejected int := 0;
  v_duplicates int := 0;
  v_total_gross numeric := 0;
  v_total_fee numeric := 0;
  v_total_net numeric := 0;
  v_authorized_actor text;
  v_authorization_token text := p_batch->>'_authorization_token';
  r jsonb;
  v_path text;
  v_amount numeric;
  v_fee numeric;
  v_net numeric;
  v_row_currency text;
  v_ref text;
  v_hash text;
  v_rule_code text;
  v_rule_reason text;
  v_accept boolean;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;
  if p_batch is null or jsonb_typeof(p_batch) <> 'object' or jsonb_typeof(p_receipts) <> 'array' then
    raise exception using errcode='22023', message='invalid receipt command';
  end if;
  if octet_length(p_receipts::text) > 1572864 then raise exception using errcode='22023', message='receipt metadata too large'; end if;
  if p_command_key !~ '^receipt-ingest:[A-Za-z0-9-]{16,128}$' or v_batch_id !~ '^[A-Za-z0-9-]{16,128}$' then
    raise exception using errcode='22023', message='invalid command identity';
  end if;
  if (p_batch->>'direction') not in ('in','out','buy','sell') or v_currency !~ '^[A-Z]{3,8}$' then
    raise exception using errcode='22023', message='invalid batch metadata';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));

  delete from public.receipt_ingestion_authorizations
  where command_key = p_command_key and actor_id = v_actor.id
    and authorization_token = v_authorization_token
    and expires_at > statement_timestamp()
  returning actor_id into v_authorized_actor;
  if v_authorized_actor is null then
    raise exception using errcode='42501', message='receipt command was not authorized by the ingestion service';
  end if;

  if exists (select 1 from public.receipt_ingestion_commands where actor_id=v_actor.id and command_key=p_command_key) then
    return (select jsonb_build_object('batch_id',batch_id,'replayed',true) from public.receipt_ingestion_commands where actor_id=v_actor.id and command_key=p_command_key);
  end if;
  if v_actor.role not in ('admin','office')
    and not (v_actor.role='customer' and v_customer_id=v_actor.id)
    and not (v_actor.role='partner' and v_partner_id=v_actor.id) then
    raise exception using errcode='42501', message='context not authorized';
  end if;
  if v_customer_id is not null and not exists(select 1 from public.app_users where id=v_customer_id and role='customer' and not deleted) then
    raise exception using errcode='22023', message='invalid customer';
  end if;
  if v_partner_id is not null and not exists(select 1 from public.app_users where id=v_partner_id and role='partner' and not deleted) then
    raise exception using errcode='22023', message='invalid partner';
  end if;
  v_count := jsonb_array_length(p_receipts);
  if v_count < 1 or v_count > 25 then raise exception using errcode='22023', message='invalid receipt count'; end if;

  -- Validate every staged object before writing any relational row.
  for r in select value from jsonb_array_elements(p_receipts) loop
    if jsonb_typeof(r) <> 'object' or jsonb_typeof(coalesce(r->'raw','{}'::jsonb)) <> 'object' then
      raise exception using errcode='22023', message='invalid receipt metadata';
    end if;
    if (r->>'id') !~ '^[A-Za-z0-9-]{6,128}$' or r->>'batch_id' <> v_batch_id then
      raise exception using errcode='22023', message='invalid receipt identity';
    end if;
    v_path := r->>'image_path';
    if v_path <> format('ingest/%s/%s.jpg',v_batch_id,r->>'id') then raise exception using errcode='22023', message='invalid object path'; end if;
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id='receipts' and o.name=v_path and o.owner_id=auth.uid()::text
        and coalesce((o.metadata->>'size')::bigint,0) between 1 and 10485760
        and lower(coalesce(o.metadata->>'mimetype',o.metadata->>'contentType','')) in ('image/jpeg','image/png','image/webp','image/heic','image/heif')
    ) then raise exception using errcode='22023', message='invalid staged object'; end if;
  end loop;

  insert into public.receipt_batches(
    id,customer_id,customer_name,partner_id,direction,status,currency,total_gross,total_fee,total_net,n,dup_n,rejected_n,uploaded_by,source,receipt_stage
  ) values (
    v_batch_id,v_customer_id,
    case when v_customer_id is null then left(nullif(p_batch->>'customer_name',''),120) else (select name from public.app_users where id=v_customer_id) end,
    v_partner_id,p_batch->>'direction','new',v_currency,0,0,0,v_count,0,0,v_actor.id,left(coalesce(p_batch->>'source','app'),30),'reading'
  );

  for r in select value from jsonb_array_elements(p_receipts) loop
    v_amount := case when coalesce(r->>'amount','') ~ '^\d+(\.\d+)?$' then (r->>'amount')::numeric else null end;
    v_fee := case when coalesce(r->>'fee','') ~ '^\d+(\.\d+)?$' then (r->>'fee')::numeric else 0 end;
    v_net := case when coalesce(r->>'net_amount','') ~ '^\d+(\.\d+)?$' then (r->>'net_amount')::numeric
      when v_amount is not null then v_amount-v_fee else null end;
    v_row_currency := upper(nullif(btrim(r->>'currency'),''));
    v_ref := left(nullif(btrim(r->>'ref_no'),''),160);
    v_hash := case when coalesce(r->>'image_hash','') ~ '^[a-f0-9]{64}$' then r->>'image_hash' else null end;
    v_rule_code := left(coalesce(nullif(r->>'rule_code',''),nullif(r->>'reject_code',''),'server_rejected'),80);
    v_rule_reason := left(coalesce(nullif(r->>'rule_reason',''),nullif(r->>'reject_reason',''),'فیشەکە یاساکانی ناردنی نەبڕیوە'),700);
    v_accept := coalesce(r->>'intake_status','')='accepted'
      and coalesce(r->>'status','')='ok' and coalesce(r->>'counted','') in ('true','t','1')
      and v_amount > 0 and v_amount <= 1000000000000 and v_fee >= 0 and v_fee <= v_amount
      and v_row_currency ~ '^[A-Z]{3,8}$' and v_row_currency = v_currency;

    -- Say WHICH of them refused it.
    --
    -- This conjunction is eight separate rules wearing one boolean, and a refusal was written
    -- down as 'server_rejected' with "فیشەکە یاساکانی ناردنی نەبڕیوە" — a sentence that names
    -- nothing. Four receipts were refused that way this morning and settling why cost two
    -- readings of the live database and a guess that turned out wrong. The command knows
    -- exactly which test failed at the moment it fails; it simply was not writing it down.
    --
    -- Only when the browser named no reason of its own: a receipt the uploader already marked
    -- rejected keeps the uploader's reason, which is the more useful one.
    if not v_accept and coalesce(nullif(r->>'rule_code',''),nullif(r->>'reject_code','')) is null then
      if coalesce(r->>'intake_status','') <> 'accepted' then
        v_rule_code := 'not_submitted_for_acceptance';
        v_rule_reason := format('فیشەکە بۆ وەرگرتن نەنێردراوە (intake_status=%s) — لەوانەیە بەرنامەکە کۆن بێت؛ دایخە و بیکەرەوە',
          coalesce(nullif(r->>'intake_status',''),'⟨نەنێردراوە⟩'));
      elsif coalesce(r->>'status','') <> 'ok' then
        v_rule_code := 'not_confirmed';
        v_rule_reason := format('فیشەکە لە بەرنامەکەدا پشتڕاست نەکراوەتەوە (status=%s)', coalesce(nullif(r->>'status',''),'⟨بەتاڵ⟩'));
      elsif coalesce(r->>'counted','') not in ('true','t','1') then
        v_rule_code := 'not_counted';
        v_rule_reason := 'فیشەکە وەک ژمێردراو نەنێردراوە';
      elsif v_amount is null or v_amount <= 0 then
        v_rule_code := 'invalid_amount';
        v_rule_reason := 'بڕی فیشەکە نەخوێندراوەتەوە یان سفرە';
      elsif v_amount > 1000000000000 then
        v_rule_code := 'amount_too_large';
        v_rule_reason := 'بڕەکە لە سنووری ڕێپێدراو زیاترە';
      elsif v_fee < 0 or v_fee > v_amount then
        v_rule_code := 'invalid_fee';
        v_rule_reason := format('فی (%s) لەگەڵ بڕەکە (%s) ناگونجێت', v_fee, v_amount);
      elsif v_row_currency is null or v_row_currency !~ '^[A-Z]{3,8}$' then
        v_rule_code := 'invalid_currency';
        v_rule_reason := format('دراوی فیشەکە نەناسراوە (%s)', coalesce(v_row_currency,'⟨بەتاڵ⟩'));
      else
        v_rule_code := 'currency_not_the_batch';
        v_rule_reason := format('دراوی فیشەکە %s ە بەڵام کۆمەڵەکە بە %s نێردراوە', v_row_currency, v_currency);
      end if;
    end if;

    if v_accept and exists (
      select 1 from public.receipt_intake_items i
      where i.intake_status='accepted'
        and ((v_hash is not null and i.image_hash=v_hash)
          or (nullif(regexp_replace(v_ref,'[^0-9A-Za-z]','','g'),'') is not null
            and upper(regexp_replace(i.ref_no,'[^0-9A-Za-z]','','g'))=upper(regexp_replace(v_ref,'[^0-9A-Za-z]','','g'))))
    ) then
      v_accept := false; v_rule_code := 'duplicate'; v_rule_reason := 'هەمان وێنە یان ژمارەی مامەڵە پێشتر تۆمار کراوە';
    end if;

    if v_accept then
      v_accepted := v_accepted + 1;
      v_total_gross := v_total_gross + v_amount;
      v_total_fee := v_total_fee + v_fee;
      v_total_net := v_total_net + v_net;
      insert into public.receipt_intake_items(
        id,batch_id,submitted_by,customer_id,partner_id,direction,image_path,image_hash,amount,fee,net_amount,currency,ref_no,
        source_status,intake_status,counted,rule_code,rule_reason,raw
      ) values (
        r->>'id',v_batch_id,v_actor.id,v_customer_id,v_partner_id,p_batch->>'direction',r->>'image_path',v_hash,v_amount,v_fee,v_net,v_row_currency,v_ref,
        left(coalesce(r->>'source_status',r->>'status','ok'),24),'accepted',true,
        nullif(left(r->>'rule_code',80),''),nullif(left(r->>'rule_reason',700),''),coalesce(r->'raw','{}'::jsonb)
      );
      insert into public.receipts(
        id,batch_id,customer_id,customer_name,direction,amount,fee,fee_original,fee_discount,platform,net_amount,currency,
        sender,receiver,ref_no,tx_time,tx_date,bank,note,image_hash,image_path,status,counted,reject_code,reject_reason,
        dup_of,dup_of_date,dup_of_who,uploaded_by,partner_id,raw
      ) values (
        r->>'id',v_batch_id,v_customer_id,
        case when v_customer_id is null then left(nullif(r->>'customer_name',''),120) else (select name from public.app_users where id=v_customer_id) end,
        p_batch->>'direction',v_amount,v_fee,
        case when coalesce(r->>'fee_original','') ~ '^\d+(\.\d+)?$' then (r->>'fee_original')::numeric else null end,
        case when coalesce(r->>'fee_discount','') ~ '^\d+(\.\d+)?$' then (r->>'fee_discount')::numeric else 0 end,
        left(r->>'platform',60),v_net,v_row_currency,left(r->>'sender',160),left(r->>'receiver',160),v_ref,
        case when coalesce(r->>'tx_time','') ~ '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then (r->>'tx_time')::time else null end,
        case when coalesce(r->>'tx_date','') ~ '^\d{4}-\d{2}-\d{2}$' then (r->>'tx_date')::date else null end,
        left(r->>'bank',80),left(r->>'note',1000),v_hash,r->>'image_path','ok',true,null,null,
        nullif(r->>'dup_of',''),nullif(r->>'dup_of_date','')::timestamptz,left(r->>'dup_of_who',160),v_actor.id,v_partner_id,coalesce(r->'raw','{}'::jsonb)
      );
      insert into public.receipt_audit_events(event_type,batch_id,receipt_id,actor_id,command_key,metadata)
      values('receipt_created',v_batch_id,r->>'id',v_actor.id,p_command_key,
        jsonb_build_object('intake_status','accepted','currency',v_row_currency,'amount',v_amount,'image_hash',v_hash,'ref_no',v_ref));
    else
      v_rejected := v_rejected + 1;
      if v_rule_code in ('duplicate','same_batch','same_ref','same_image') then v_duplicates := v_duplicates + 1; end if;
      insert into public.receipt_intake_items(
        id,batch_id,submitted_by,customer_id,partner_id,direction,image_path,image_hash,amount,fee,net_amount,currency,ref_no,
        source_status,intake_status,counted,rule_code,rule_reason,raw
      ) values (
        r->>'id',v_batch_id,v_actor.id,v_customer_id,v_partner_id,p_batch->>'direction',r->>'image_path',v_hash,v_amount,v_fee,v_net,v_row_currency,v_ref,
        left(coalesce(r->>'source_status',r->>'status','rejected'),24),'rejected',false,v_rule_code,v_rule_reason,coalesce(r->'raw','{}'::jsonb)
      );
      insert into public.receipt_audit_events(event_type,batch_id,receipt_id,actor_id,command_key,metadata)
      values('rejected',v_batch_id,r->>'id',v_actor.id,p_command_key,
        jsonb_build_object('intake_status','rejected','rule_code',v_rule_code,'rule_reason',v_rule_reason,'image_hash',v_hash,'ref_no',v_ref));
    end if;
  end loop;

  update public.receipt_batches set
    total_gross=v_total_gross,total_fee=v_total_fee,total_net=v_total_net,n=v_count,
    dup_n=v_duplicates,rejected_n=v_rejected,
    status=case when v_accepted>0 then 'new' else 'done' end,
    receipt_stage=case when v_accepted>0 then 'verified' else 'rejected' end
  where id=v_batch_id;
  insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
  values('batch_created',v_batch_id,v_actor.id,p_command_key,
    jsonb_build_object('receipt_count',v_count,'accepted_count',v_accepted,'rejected_count',v_rejected,
      'customer_id',v_customer_id,'partner_id',v_partner_id,'source',left(coalesce(p_batch->>'source','app'),30)));
  insert into public.receipt_ingestion_commands(actor_id,command_key,batch_id) values(v_actor.id,p_command_key,v_batch_id);
  return jsonb_build_object('batch_id',v_batch_id,'receipt_count',v_count,'accepted_count',v_accepted,'rejected_count',v_rejected,'replayed',false);
end;
$$;

commit;
