-- «ئاگاداربە، ئەکرێت فیشەکە ئەلیپەی بێت ئەکرێت ویچات بێت»
--
-- The owner is right, and the acceptance rule was not.
--
-- Two receipts, both honest, both for 1,246.30 with a 36.30 fee and 1,210.00 arriving:
--
--   WeChat   prints 订单金额 / Order amount. order_amount = 1210, fee added on top.  → accepted
--   Alipay   prints no order amount at all. The reader says so, and leaves the fee's
--            treatment 'unknown', because with no order amount it genuinely is: 1210 with
--            36.30 added on top and 1246.30 with 36.30 taken off are the same three numbers
--            read from two sides.                                                   → refused
--
-- Refused as 'receipt identity, fee treatment and amounts require correction before acceptance'.
-- And when a reviewer did the obvious thing and named the treatment, it was refused a second
-- time as 'receipt gross, fee, order and net amounts do not reconcile', because both branches of
-- that test begin `order_amount is null or …`. Two rules in turn, no third move, and the money
-- adds up to the cent. One platform's layout had become the definition of a receipt.
--
-- 202608280005 settled this at the reading gate: ask whether the fee is ACCOUNTED FOR, not
-- whether somebody has a word for it. gross − fee = net accounts for it under either name.
-- Acceptance was never brought into line, so every Alipay receipt that reached a reviewer
-- reached somebody who could do nothing with it but reject it.
--
-- And one more, which is not about platforms at all: acceptance still required
-- `v_doc.transaction_id is not null`. Since 202608280001 a customer-seller sends their evidence
-- BEFORE any transaction exists — that is the flow the owner described — so every such receipt,
-- and every replacement uploaded for a rejected one, landed in the review queue as something no
-- reviewer could accept.
--
-- Nothing else in the command changes: the duplicate locks, the identity requirements, the
-- transition path, the audit log and the correction rules are exactly as they were.
begin;

create or replace function public.sarraf_receipt_review_command(
  p_document_id text, p_action text, p_changes jsonb,
  p_reason text, p_command_key text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype;
  v_current public.receipt_extractions%rowtype; v_version integer; v_result jsonb; v_prev jsonb;
  v_currency text; v_duplicate text; v_has_extraction boolean;
  v_ref_norm text; v_merchant_norm text; v_lock_key text; v_duplicate_kind text;
  v_reconciles boolean;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then
    raise exception using errcode='42501', message='only an administrator may review receipts';
  end if;
  if public.receipt_request_aal()<>'aal2' then
    raise exception using errcode='42501', message='multi-factor authentication is required';
  end if;
  if p_action not in ('accept','reject','correct','reopen')
     or char_length(btrim(coalesce(p_reason,'')))<8 then
    raise exception using errcode='22023', message='a valid action and 8-character reason are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_prev from public.receipt_command_log
   where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_prev||jsonb_build_object('replayed',true); end if;
  select * into v_doc from public.receipt_documents where id=p_document_id for update;
  if not found then raise exception using errcode='P0002', message='receipt not found'; end if;
  select * into v_current from public.receipt_extractions where document_id=p_document_id
   order by version desc limit 1;
  v_has_extraction := found;
  perform set_config('app.receipt_actor_id',v_actor.id,true);
  perform set_config('app.receipt_reason',left(btrim(p_reason),700),true);
  perform set_config('app.receipt_command_key',p_command_key,true);

  if p_action='correct' then
    if not v_has_extraction then raise exception using errcode='22023', message='there is no extraction to correct'; end if;
    if v_doc.state not in ('parsed','needs_manual_review','validated','submitted',
                           'duplicate','currency_mismatch','tamper_suspected') then
      raise exception using errcode='23514', message='accepted or finalized evidence cannot be corrected; reject and reopen first';
    end if;
    if p_changes is null or jsonb_typeof(p_changes)<>'object' or p_changes='{}'::jsonb
       or exists(select 1 from jsonb_object_keys(p_changes) k
                 where k not in ('grossAmount','orderAmount','feeAmount','feeTreatment','netAmount',
                                 'currency','refNo','merchantOrderNo','payee','platform','txDate','txTime')) then
      raise exception using errcode='22023', message='invalid correction fields';
    end if;
    if exists(
      select 1 from unnest(array['grossAmount','orderAmount','feeAmount','netAmount']) as keys(key)
      where p_changes ? key and (
        public.receipt_json_numeric(p_changes,key) is null
        or public.receipt_json_numeric(p_changes,key)<0)
    ) then raise exception using errcode='22023', message='corrected amounts must be non-negative numbers'; end if;
    if p_changes ? 'feeTreatment' and coalesce(p_changes->>'feeTreatment','') not in
       ('added_on_top','deducted_from_principal','included_in_total','no_fee','unknown') then
      raise exception using errcode='22023', message='invalid corrected fee treatment';
    end if;
    if p_changes ? 'currency' and coalesce(upper(p_changes->>'currency'),'')!~'^[A-Z]{3,8}$' then
      raise exception using errcode='22023', message='invalid corrected currency';
    end if;
    if p_changes ? 'txDate' and coalesce(p_changes->>'txDate','')!~'^\d{4}-\d{2}-\d{2}$' then
      raise exception using errcode='22023', message='invalid corrected receipt date';
    end if;
    if p_changes ? 'txTime' and coalesce(p_changes->>'txTime','')!~'^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then
      raise exception using errcode='22023', message='invalid corrected receipt time';
    end if;
    if exists(
      select 1 from unnest(array['refNo','merchantOrderNo','payee','platform']) as keys(key)
      where p_changes ? key and jsonb_typeof(p_changes->key)<>'string'
    ) then raise exception using errcode='22023', message='corrected receipt text must be a string'; end if;
    if p_changes ? 'platform' and coalesce(p_changes->>'platform','') !~*
       '(wechat|weixin|微信|alipay|ali[ -]?pay|支付宝)' then
      raise exception using errcode='22023', message='corrected platform must be WeChat or Alipay';
    end if;
    v_version:=v_current.version+1;
    v_currency:=coalesce(nullif(upper(p_changes->>'currency'),''),v_current.currency);
    if v_currency is distinct from v_doc.expected_currency then
      raise exception using errcode='22023', message='correction currency must match the assigned transaction';
    end if;
    insert into public.receipt_extractions(
      document_id,version,is_original,provider,model,ocr_version,raw,
      gross_amount,order_amount,fee_amount,fee_treatment,net_amount,currency,
      ref_no,merchant_order_no,payee,tx_date,tx_time,confidence,field_confidence,
      platform,platform_evidence,has_fee,transaction_status,
      image_sha256,request_id,server_recorded,attestation_version,
      corrected_by,correction_reason,corrected_at)
    values (p_document_id,v_version,false,v_current.provider,v_current.model,v_current.ocr_version,v_current.raw,
      coalesce(abs(public.receipt_json_numeric(p_changes,'grossAmount')),v_current.gross_amount),
      coalesce(abs(public.receipt_json_numeric(p_changes,'orderAmount')),v_current.order_amount),
      coalesce(abs(public.receipt_json_numeric(p_changes,'feeAmount')),v_current.fee_amount),
      coalesce(case when p_changes->>'feeTreatment' in
        ('added_on_top','deducted_from_principal','included_in_total','no_fee','unknown')
        then p_changes->>'feeTreatment' end,v_current.fee_treatment),
      coalesce(abs(public.receipt_json_numeric(p_changes,'netAmount')),v_current.net_amount),v_currency,
      coalesce(left(nullif(p_changes->>'refNo',''),160),v_current.ref_no),
      coalesce(left(nullif(p_changes->>'merchantOrderNo',''),160),v_current.merchant_order_no),
      coalesce(left(nullif(p_changes->>'payee',''),160),v_current.payee),
      coalesce(case when p_changes->>'txDate'~'^\d{4}-\d{2}-\d{2}$' then (p_changes->>'txDate')::date end,v_current.tx_date),
      coalesce(case when p_changes->>'txTime'~'^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then (p_changes->>'txTime')::time end,v_current.tx_time),
      v_current.confidence,v_current.field_confidence,
      coalesce(case
        when coalesce(p_changes->>'platform','')~*'(wechat|weixin|微信)' then 'wechat'
        when coalesce(p_changes->>'platform','')~*'(alipay|ali[ -]?pay|支付宝)' then 'alipay'
        end,v_current.platform),
      v_current.platform_evidence,
      case
        when coalesce(abs(public.receipt_json_numeric(p_changes,'feeAmount')),v_current.fee_amount,0)>0 then true
        when coalesce(p_changes->>'feeTreatment',v_current.fee_treatment)='no_fee' then false
        when coalesce(p_changes->>'feeTreatment',v_current.fee_treatment) in
          ('added_on_top','deducted_from_principal','included_in_total') then true
        else null end,
      v_current.transaction_status,
      v_current.image_sha256,
      v_current.request_id,true,v_current.attestation_version,v_actor.id,left(btrim(p_reason),700),statement_timestamp());
    if not exists(
      select 1 from public.receipt_extractions e
      where e.document_id=p_document_id and e.version=v_version and (
        e.gross_amount is distinct from v_current.gross_amount
        or e.order_amount is distinct from v_current.order_amount
        or e.fee_amount is distinct from v_current.fee_amount
        or e.fee_treatment is distinct from v_current.fee_treatment
        or e.net_amount is distinct from v_current.net_amount
        or e.currency is distinct from v_current.currency
        or e.ref_no is distinct from v_current.ref_no
        or e.merchant_order_no is distinct from v_current.merchant_order_no
        or e.payee is distinct from v_current.payee
        or e.platform is distinct from v_current.platform
        or e.tx_date is distinct from v_current.tx_date
        or e.tx_time is distinct from v_current.tx_time)
    ) then raise exception using errcode='22023', message='correction does not change any receipt field'; end if;
    if v_doc.state in ('parsed','validated','submitted','duplicate','currency_mismatch','tamper_suspected') then
      update public.receipt_documents set state='needs_manual_review',counted=false,
        rule_code='staff_correction',rule_reason=left(btrim(p_reason),700) where id=p_document_id;
    end if;
    v_result:=jsonb_build_object('document_id',p_document_id,'action','correct','version',v_version,
                                 'state','needs_manual_review','replayed',false);
  elsif p_action='accept' then
    -- A receipt no longer has to name a transaction. Since 202608280001 a customer-seller sends
    -- their evidence before any transaction exists — that is the whole flow — and requiring one
    -- here meant every such receipt reached a reviewer who could do nothing but reject it. The
    -- currency is compared only where something expected one; a receipt that arrived on its own
    -- has nothing to disagree with.
    if not v_has_extraction or coalesce(v_current.net_amount,v_current.order_amount,v_current.gross_amount)<=0
       or (v_doc.expected_currency is not null
           and v_current.currency is distinct from v_doc.expected_currency) then
      raise exception using errcode='23514', message='receipt is missing a matched amount or currency';
    end if;
    if v_current.gross_amount is null or v_current.gross_amount<=0
       or v_current.fee_amount is null or v_current.fee_amount<0
       or v_current.net_amount is null or v_current.net_amount<=0
       or coalesce(v_current.ref_no,v_current.merchant_order_no) is null
       or v_current.tx_date is null
       or v_current.platform not in ('wechat','alipay')
       or v_current.has_fee is null
       or (nullif(btrim(coalesce(v_current.payee,'')),'') is null
           and nullif(btrim(coalesce(v_current.raw->>'recipientNote',v_current.raw->>'merchantName','')),'') is null) then
      raise exception using errcode='23514', message='receipt identity and amounts require correction before acceptance';
    end if;
    -- Does the fee account for itself?
    --
    -- The old test asked a different question — does the fee's LABEL agree with the numbers —
    -- and for that it needed an order amount that not every receipt states. A WeChat receipt
    -- prints 订单金额 and passed. An Alipay receipt often prints no order amount at all, so it
    -- failed as 'unknown' and then, when a reviewer named the treatment to fix it, failed again
    -- as 'does not reconcile'. The same honest receipt was refused by two rules in turn and there
    -- was no third move. One platform's layout was being treated as the definition of a receipt.
    --
    -- Where an order amount is stated, every check it used to make is still made. Where it is
    -- not, the receipt makes exactly one arithmetic claim — gross − fee = net — and that is the
    -- claim this checks. It is the same standard 202608280005 settled on at the reading gate;
    -- acceptance was simply never brought into line with it.
    v_reconciles := case
      when v_current.order_amount is not null then
        case coalesce(v_current.fee_treatment,'unknown')
          when 'added_on_top' then
            abs(v_current.gross_amount-(v_current.order_amount+v_current.fee_amount))<=0.01
            and abs(v_current.net_amount-v_current.order_amount)<=0.01
          when 'included_in_total' then
            v_current.fee_amount<=v_current.order_amount
            and abs(v_current.gross_amount-v_current.order_amount)<=0.01
            and abs(v_current.net_amount-(v_current.order_amount-v_current.fee_amount))<=0.01
          when 'deducted_from_principal' then
            v_current.fee_amount<=v_current.order_amount
            and abs(v_current.gross_amount-v_current.order_amount)<=0.01
            and abs(v_current.net_amount-(v_current.order_amount-v_current.fee_amount))<=0.01
          when 'no_fee' then
            v_current.fee_amount=0
            and abs(v_current.net_amount-v_current.order_amount)<=0.01
            and abs(v_current.gross_amount-v_current.order_amount)<=0.01
          else
            -- An order amount, and no word for the fee. Either reading is a real receipt; both
            -- are checkable, and one of them must hold.
            (abs(v_current.gross_amount-(v_current.order_amount+v_current.fee_amount))<=0.01
             and abs(v_current.net_amount-v_current.order_amount)<=0.01)
            or (abs(v_current.gross_amount-v_current.order_amount)<=0.01
                and abs(v_current.net_amount-(v_current.order_amount-v_current.fee_amount))<=0.01)
        end
      when coalesce(v_current.fee_treatment,'unknown')='no_fee' then
        v_current.fee_amount=0 and abs(v_current.net_amount-v_current.gross_amount)<=0.01
      else
        v_current.fee_amount<=v_current.gross_amount
        and abs(v_current.gross_amount-v_current.fee_amount-v_current.net_amount)<=0.01
    end;
    if not v_reconciles then
      raise exception using errcode='23514', message='receipt gross, fee, order and net amounts do not reconcile';
    end if;
    v_ref_norm:=nullif(upper(regexp_replace(coalesce(v_current.ref_no,''),'[^[:alnum:]]','','g')),'');
    v_merchant_norm:=nullif(upper(regexp_replace(coalesce(v_current.merchant_order_no,''),'[^[:alnum:]]','','g')),'');
    -- Independent, ordered locks make same-image, same-reference and same-merchant-reference
    -- acceptance races serialize even when they involve different document rows.
    for v_lock_key in
      select distinct key from unnest(array[
        case when v_doc.image_sha256 is not null then 'hash:'||v_doc.image_sha256 end,
        case when char_length(coalesce(v_ref_norm,''))>=4 then 'ref:'||v_ref_norm end,
        case when char_length(coalesce(v_merchant_norm,''))>=4 then 'merchant:'||v_merchant_norm end
      ]) keys(key) where key is not null order by key
    loop
      perform pg_advisory_xact_lock(hashtextextended('receipt-duplicate:'||v_lock_key,0));
    end loop;
    select d.id,
      case when d.image_sha256=v_doc.image_sha256 then 'exact_image_duplicate'
           when v_ref_norm is not null and upper(regexp_replace(coalesce(e.ref_no,''),'[^[:alnum:]]','','g'))=v_ref_norm
             then 'exact_reference_duplicate'
           else 'exact_merchant_reference_duplicate' end
      into v_duplicate,v_duplicate_kind
    from public.receipt_documents d
    join lateral (
      select x.* from public.receipt_extractions x where x.document_id=d.id order by x.version desc limit 1
    ) e on true
    where d.id<>p_document_id and d.counted and (
      (v_doc.image_sha256 is not null and d.image_sha256=v_doc.image_sha256)
      or (char_length(coalesce(v_ref_norm,''))>=4
          and upper(regexp_replace(coalesce(e.ref_no,''),'[^[:alnum:]]','','g'))=v_ref_norm)
      or (char_length(coalesce(v_merchant_norm,''))>=4
          and upper(regexp_replace(coalesce(e.merchant_order_no,''),'[^[:alnum:]]','','g'))=v_merchant_norm)
    ) order by d.accepted_at nulls last,d.received_at,d.id limit 1;
    if v_duplicate is not null then
      update public.receipt_documents set state='duplicate',counted=false,
        rule_code=v_duplicate_kind,rule_reason='Receipt identity is already counted by another accepted document'
        where id=p_document_id;
      v_result:=jsonb_build_object('document_id',p_document_id,'action','accept','state','duplicate',
        'counted',false,'rule_code',v_duplicate_kind,'replayed',false);
      insert into public.receipt_command_log(actor_id,command_key,operation,result)
      values(v_actor.id,p_command_key,'receipt_review_accept',v_result);
      return v_result;
    end if;
    if v_doc.state in ('duplicate','currency_mismatch','tamper_suspected') then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    elsif v_doc.state='ocr_failed_retryable' then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    elsif v_doc.state='rejected' then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)='parsed' then
      update public.receipt_documents set state='validated' where id=p_document_id;
    elsif (select state from public.receipt_documents where id=p_document_id)='needs_manual_review' then
      update public.receipt_documents set state='validated' where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)='validated' then
      update public.receipt_documents set state='submitted',submitted_at=coalesce(submitted_at,statement_timestamp()) where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)='submitted' then
      update public.receipt_documents set state='matched' where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)='matched' then
      update public.receipt_documents set state='accepted',counted=true,accepted_at=statement_timestamp(),
        rule_code=null,rule_reason=null where id=p_document_id;
    end if;
    if (select state from public.receipt_documents where id=p_document_id)<>'accepted' then
      raise exception using errcode='23514', message='receipt cannot be accepted from its current state';
    end if;
    v_result:=jsonb_build_object('document_id',p_document_id,'action','accept','state','accepted','counted',true,'replayed',false);
  elsif p_action='reject' then
    if v_doc.state='ocr_failed_retryable' then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    elsif v_doc.state='parsed' then
      update public.receipt_documents set state='needs_manual_review' where id=p_document_id;
    elsif v_doc.state='accepted' then
      null;
    elsif v_doc.state not in ('needs_manual_review','validated','submitted','matched','duplicate','currency_mismatch','tamper_suspected') then
      raise exception using errcode='23514', message='receipt cannot be rejected from its current state';
    end if;
    update public.receipt_documents set state='rejected',counted=false,
      rule_code='manual_reject',rule_reason=left(btrim(p_reason),700) where id=p_document_id;
    v_result:=jsonb_build_object('document_id',p_document_id,'action','reject','state','rejected','counted',false,'replayed',false);
  else
    if v_doc.state<>'rejected' then raise exception using errcode='23514', message='only a rejected receipt can be reopened'; end if;
    update public.receipt_documents set state='needs_manual_review',counted=false,
      rule_code='reopened',rule_reason=left(btrim(p_reason),700) where id=p_document_id;
    v_result:=jsonb_build_object('document_id',p_document_id,'action','reopen','state','needs_manual_review','replayed',false);
  end if;
  insert into public.receipt_command_log(actor_id,command_key,operation,result)
  values(v_actor.id,p_command_key,'receipt_review_'||p_action,v_result);
  return v_result;
end;
$$;

commit;
