-- The reader works. Every receipt it reads still needs a person.
--
-- Three receipts were read this morning, the first this system has read since 17 August: groq
-- and gemini, two to seven seconds, confidence 0.95 to 0.98, amounts and fees and reference
-- numbers and payees and dates all extracted correctly. All three landed at
-- needs_manual_review.
--
-- Seven of the eight validation rules passed. The eighth is this:
--
--   or coalesce(p_extraction->>'feeTreatment','unknown')='unknown'
--
-- and the reading says:
--
--   "grossAmount": "1246.3",  "feeAmount": "36.3",  "netAmount": "1210",
--   "feeTreatment": "unknown",  "transactionStatus": "Transaction successful"
--
-- 1246.30 - 36.30 = 1210.00. The money adds up to the cent. What is missing is a WORD for it,
-- and with no orderAmount on this receipt that word is genuinely ambiguous: an order of 1210
-- with 36.30 added on top, and a principal of 1246.30 with 36.30 deducted, are the same three
-- numbers seen from two sides. Choosing one would be inventing a fact about somebody's money,
-- so this does not choose.
--
-- It asks instead what the rule is actually for: is the fee accounted for? gross - fee = net
-- accounts for it under either name. A fee that cannot be reconciled still stops for a person,
-- and so does every other rule — confidence, amount, reference, platform, date, payee, and a
-- transaction that did not succeed. Duplicate and tamper checks are untouched.
--
-- One label is derived, because one is not ambiguous: a fee of zero is 'no_fee'. That costs a
-- review per receipt that never had a fee at all.
--
-- Without this an owner hand-checks every honest receipt that reaches them, which is the work
-- the reader exists to remove.
begin;

create or replace function public.sarraf_receipt_record_server_extraction(
  p_document_id text, p_image_sha256 text, p_byte_size bigint, p_mime_type text,
  p_ok boolean, p_extraction jsonb, p_provider text, p_model text,
  p_latency_ms integer, p_request_id text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_doc public.receipt_documents%rowtype; v_attempt integer; v_currency text;
  v_conf numeric; v_next public.receipt_state; v_duplicate text; v_fee_treatment text;
begin
  if p_image_sha256 !~ '^[a-f0-9]{64}$' or p_byte_size is null
     or p_byte_size<1 or p_byte_size>20971520
     or p_mime_type !~ '^image/(jpeg|png|webp|heic|heif)$'
     or char_length(coalesce(p_request_id,''))<8 then
    raise exception using errcode='22023', message='invalid stored receipt attestation';
  end if;
  select * into v_doc from public.receipt_documents where id=p_document_id for update;
  if not found then raise exception using errcode='P0002', message='receipt intake not found'; end if;
  if exists(select 1 from public.receipt_extractions where document_id=p_document_id and is_original) then
    return jsonb_build_object('document_id',p_document_id,'state',v_doc.state,'replayed',true);
  end if;
  if v_doc.state not in ('uploading','upload_failed_retryable','uploaded','ocr_pending','ocr_failed_retryable') then
    raise exception using errcode='23514', message='receipt is not waiting for server OCR';
  end if;
  if v_doc.image_sha256 is not null and v_doc.image_sha256<>p_image_sha256 then
    raise exception using errcode='42501', message='stored receipt bytes changed after attestation';
  end if;
  perform set_config('app.receipt_request_id',p_request_id,true);
  perform set_config('app.receipt_command_key','server-ocr:'||p_request_id,true);
  perform set_config('app.receipt_reason','Server verified the stored original and recorded OCR',true);

  if v_doc.state='upload_failed_retryable' then
    update public.receipt_documents set state='uploading' where id=p_document_id;
  end if;
  if (select state from public.receipt_documents where id=p_document_id)='uploading' then
    update public.receipt_documents set image_sha256=p_image_sha256,byte_size=p_byte_size,
      mime_type=p_mime_type,server_attested_at=statement_timestamp(),last_request_id=p_request_id,
      state='uploaded' where id=p_document_id;
  end if;
  if (select state from public.receipt_documents where id=p_document_id)='uploaded' then
    update public.receipt_documents set state='ocr_pending' where id=p_document_id;
  end if;
  if (select state from public.receipt_documents where id=p_document_id)='ocr_failed_retryable' then
    update public.receipt_documents set state='ocr_pending' where id=p_document_id;
  end if;
  update public.receipt_documents set state='ocr_processing',ocr_attempts=ocr_attempts+1,
    last_attempt_at=statement_timestamp(),last_request_id=p_request_id where id=p_document_id;
  select ocr_attempts into v_attempt from public.receipt_documents where id=p_document_id;

  if not coalesce(p_ok,false) then
    insert into public.receipt_ocr_attempts(
      document_id,attempt_no,provider,model,status,latency_ms,error_code,image_sha256,request_id)
    values (p_document_id,v_attempt,left(p_provider,60),left(p_model,80),'retryable_failure',
      p_latency_ms,left(coalesce(p_extraction->>'error','ocr_failed'),80),p_image_sha256,p_request_id);
    update public.receipt_documents set state='ocr_failed_retryable',
      last_error_code=left(coalesce(p_extraction->>'error','ocr_failed'),80) where id=p_document_id;
    return jsonb_build_object('document_id',p_document_id,'state','ocr_failed_retryable','replayed',false);
  end if;

  v_currency := nullif(upper(regexp_replace(coalesce(p_extraction->>'currency',''),'[^A-Z]','','g')),'');
  v_conf := public.receipt_json_numeric(p_extraction,'confidence');
  v_fee_treatment := case when p_extraction->>'feeTreatment' in
    ('added_on_top','deducted_from_principal','included_in_total','no_fee','unknown')
    then p_extraction->>'feeTreatment' else 'unknown' end;
  -- A fee of nothing is not an unknown treatment. That one the numbers settle outright, and
  -- saying so costs a person one review per receipt that never had a fee to begin with.
  if v_fee_treatment = 'unknown'
     and coalesce(abs(public.receipt_json_numeric(p_extraction,'feeAmount')),0) = 0 then
    v_fee_treatment := 'no_fee';
  end if;
  insert into public.receipt_extractions(
    document_id,version,is_original,provider,model,ocr_version,raw,
    gross_amount,order_amount,fee_amount,fee_treatment,net_amount,currency,
    ref_no,merchant_order_no,payee,tx_date,tx_time,confidence,field_confidence,
    platform,platform_evidence,has_fee,transaction_status,
    image_sha256,request_id,server_recorded,attestation_version)
  values (p_document_id,1,true,left(p_provider,60),left(p_model,80),
    left(coalesce(p_extraction->>'ocrVersion','server-v1'),40),coalesce(p_extraction,'{}'::jsonb),
    abs(public.receipt_json_numeric(p_extraction,'grossAmount')),
    abs(public.receipt_json_numeric(p_extraction,'orderAmount')),
    abs(public.receipt_json_numeric(p_extraction,'feeAmount')),v_fee_treatment,
    abs(public.receipt_json_numeric(p_extraction,'netAmount')),v_currency,
    left(nullif(p_extraction->>'refNo',''),160),left(nullif(p_extraction->>'merchantOrderNo',''),160),
    left(nullif(p_extraction->>'payee',''),160),
    case when p_extraction->>'txDate' ~ '^\d{4}-\d{2}-\d{2}$' then (p_extraction->>'txDate')::date end,
    case when p_extraction->>'txTime' ~ '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then (p_extraction->>'txTime')::time end,
    v_conf,case when jsonb_typeof(p_extraction->'fieldConfidence')='object'
                then p_extraction->'fieldConfidence' else '{}'::jsonb end,
    case
      when coalesce(p_extraction->>'platform','') ~* '(wechat|weixin|微信)' then 'wechat'
      when coalesce(p_extraction->>'platform','') ~* '(alipay|ali[ -]?pay|支付宝)' then 'alipay'
      when nullif(btrim(coalesce(p_extraction->>'platform','')),'') is null then 'unknown'
      else 'other' end,
    left(nullif(p_extraction->>'platformEvidence',''),300),
    case
      when coalesce(public.receipt_json_numeric(p_extraction,'feeAmount'),0)>0 then true
      when v_fee_treatment='no_fee' then false
      when v_fee_treatment in ('added_on_top','deducted_from_principal','included_in_total') then true
      else null end,
    left(nullif(p_extraction->>'transactionStatus',''),80),
    p_image_sha256,p_request_id,true,1);
  insert into public.receipt_ocr_attempts(
    document_id,attempt_no,provider,model,status,latency_ms,image_sha256,request_id)
  values (p_document_id,v_attempt,left(p_provider,60),left(p_model,80),'succeeded',
          p_latency_ms,p_image_sha256,p_request_id);
  update public.receipt_documents set state='parsed',last_error_code=null where id=p_document_id;

  select id into v_duplicate from public.receipt_documents
   where id<>p_document_id and image_sha256=p_image_sha256
     and state in ('accepted','finalized','forwarded','delivered','seen')
   order by received_at limit 1;
  if v_duplicate is not null then
    update public.receipt_documents set state='duplicate',counted=false,
      rule_code='exact_image_duplicate',rule_reason='Exact image already belongs to receipt '||v_duplicate
      where id=p_document_id;
    return jsonb_build_object('document_id',p_document_id,'state','duplicate','duplicate_of',v_duplicate);
  end if;
  if v_currency is null then
    v_next:='needs_manual_review';
    update public.receipt_documents set rule_code='currency_unconfirmed',
      rule_reason='OCR did not provide reliable currency evidence' where id=p_document_id;
  elsif v_currency<>v_doc.expected_currency then
    v_next:='currency_mismatch';
    update public.receipt_documents set rule_code='currency_mismatch',
      rule_reason=format('OCR read %s but the assigned transaction requires %s',v_currency,v_doc.expected_currency)
      where id=p_document_id;
  elsif coalesce(v_conf,0)<0.72
     or public.receipt_json_numeric(p_extraction,'grossAmount') is null
     or nullif(p_extraction->>'refNo','') is null
     or coalesce(p_extraction->>'platform','') !~* '(wechat|weixin|微信|alipay|ali[ -]?pay|支付宝)'
     or coalesce(p_extraction->>'txDate','') !~ '^\d{4}-\d{2}-\d{2}$'
     or (nullif(btrim(coalesce(p_extraction->>'payee','')),'') is null
         and nullif(btrim(coalesce(p_extraction->>'recipientNote',p_extraction->>'merchantName','')),'') is null)
     -- The fee must be ACCOUNTED FOR, which is not the same as labelled.
     --
     -- Every receipt read this morning arrived with feeTreatment 'unknown' and went to a person
     -- for it, while stating gross 1246.30, fee 36.30 and net 1210.00 — money that adds up
     -- exactly. The label was the only thing missing, and with no orderAmount on the receipt it
     -- is genuinely ambiguous: 1210 + 36.30 added on top, and 1246.30 with 36.30 deducted, are
     -- the same three numbers. Picking one would be inventing a fact about somebody's money.
     --
     -- So the rule asks what it actually cares about: is the fee explained? gross - fee = net
     -- explains it whichever name it goes by. A fee that cannot be reconciled still stops.
     or (coalesce(p_extraction->>'feeTreatment','unknown')='unknown'
         and coalesce(abs(public.receipt_json_numeric(p_extraction,'grossAmount')),-1)
             - coalesce(abs(public.receipt_json_numeric(p_extraction,'feeAmount')),0)
             is distinct from coalesce(abs(public.receipt_json_numeric(p_extraction,'netAmount')),-2))
     or coalesce(p_extraction->>'transactionStatus','') !~* '(success|completed|successful)' then
    v_next:='needs_manual_review';
    update public.receipt_documents set rule_code='manual_review_required',
      rule_reason='Critical OCR fields need staff verification' where id=p_document_id;
  else
    v_next:='validated';
    update public.receipt_documents set rule_code=null,rule_reason=null where id=p_document_id;
  end if;
  update public.receipt_documents set state=v_next where id=p_document_id;
  return jsonb_build_object('document_id',p_document_id,'state',v_next,'replayed',false);
end;
$$;

commit;
