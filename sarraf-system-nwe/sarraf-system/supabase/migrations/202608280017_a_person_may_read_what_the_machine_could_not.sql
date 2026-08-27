-- An image the reader can never read is money nobody can record.
--
-- The reader is good and it is not infallible: an unusual layout, a photograph of a screen at an
-- angle, a provider outage, an image that arrives as a document rather than a picture. When it
-- fails for good, this is where the receipt ends up:
--
--   sarraf_receipt_review_command('…','correct',…)  →  there is no extraction to correct
--   sarraf_receipt_review_command('…','accept',…)   →  receipt is missing a matched amount
--
-- Both refusals are correct in themselves. Together they are a dead end: there is nothing to
-- correct because nothing was ever read, and nothing to accept for the same reason. The only
-- move left is to reject a receipt for real money, and then either lose it or type it in as a
-- transaction with no evidence attached to it — which is precisely the bookkeeping this system
-- exists to replace.
--
-- So: a person may write down what the machine could not. Not as an edit — there is nothing to
-- edit — but as a first reading, authored by a named administrator, with a reason, through the
-- same audited command path as every other decision.
--
-- It is held to the SAME standard the machine is held to. Every field the OCR path must produce
-- before a receipt can be accepted is required here, and the arithmetic must reconcile the same
-- way 202608280015 settled it. A human reading is not a way around the rules; it is the same
-- rules, applied by somebody who can see the picture.
--
-- Three things it will not do:
--
--   it will not overwrite a reading    if an extraction exists, 'correct' is the command, and it
--                                      keeps the original readable beside the correction
--   it will not accept the receipt     entering a reading and deciding on it are two decisions
--                                      by the same person, and the second one is recorded
--                                      separately with its own reason
--   it will not run for anybody        admin or office, with the same MFA the review commands
--                                      require, because this writes the figures money is made of
begin;

create or replace function public.sarraf_receipt_enter_reading(
  p_document_id text, p_reading jsonb, p_reason text, p_command_key text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_doc public.receipt_documents%rowtype;
  v_prev jsonb;
  v_result jsonb;
  v_currency text;
  v_platform text;
  v_gross numeric; v_order numeric; v_fee numeric; v_net numeric;
  v_treatment text;
  v_reconciles boolean;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role not in ('admin', 'office') then
    raise exception using errcode = '42501', message = 'only staff may enter a receipt reading';
  end if;
  if public.receipt_request_aal() <> 'aal2' then
    raise exception using errcode = '42501', message = 'multi-factor authentication is required';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 8 then
    raise exception using errcode = '22023', message = 'a reason of at least 8 characters is required';
  end if;
  if p_reading is null or jsonb_typeof(p_reading) <> 'object' then
    raise exception using errcode = '22023', message = 'a reading is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor.id || ':' || p_command_key, 0));
  select result into v_prev from public.receipt_command_log
   where actor_id = v_actor.id and command_key = p_command_key;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  select * into v_doc from public.receipt_documents where id = p_document_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'receipt not found'; end if;
  if exists (select 1 from public.receipt_extractions where document_id = p_document_id) then
    raise exception using errcode = '23505',
      message = 'this receipt already has a reading; correct it instead of replacing it';
  end if;
  if v_doc.state not in ('uploaded','ocr_pending','ocr_processing','ocr_failed_retryable',
                         'needs_manual_review','parsed') then
    raise exception using errcode = '23514',
      message = 'this receipt is not waiting for a reading';
  end if;

  v_currency := nullif(upper(regexp_replace(coalesce(p_reading->>'currency',''),'[^A-Z]','','g')),'');
  v_platform := case
    when coalesce(p_reading->>'platform','') ~* '(wechat|weixin|微信)' then 'wechat'
    when coalesce(p_reading->>'platform','') ~* '(alipay|ali[ -]?pay|支付宝)' then 'alipay'
  end;
  v_gross := abs(public.receipt_json_numeric(p_reading, 'grossAmount'));
  v_order := abs(public.receipt_json_numeric(p_reading, 'orderAmount'));
  v_fee   := coalesce(abs(public.receipt_json_numeric(p_reading, 'feeAmount')), 0);
  v_net   := abs(public.receipt_json_numeric(p_reading, 'netAmount'));
  v_treatment := case when p_reading->>'feeTreatment' in
    ('added_on_top','deducted_from_principal','included_in_total','no_fee')
    then p_reading->>'feeTreatment' else 'unknown' end;
  if v_treatment = 'unknown' and v_fee = 0 then v_treatment := 'no_fee'; end if;

  -- Everything the machine would have had to produce.
  if v_gross is null or v_gross <= 0 then
    raise exception using errcode='22023', message='the receipt total is required and must be more than zero';
  end if;
  if v_net is null or v_net <= 0 then
    raise exception using errcode='22023', message='the amount that arrived is required';
  end if;
  if v_fee < 0 then raise exception using errcode='22023', message='a fee cannot be negative'; end if;
  if v_currency is null or v_currency !~ '^[A-Z]{3,8}$' then
    raise exception using errcode='22023', message='a currency is required';
  end if;
  if v_doc.expected_currency is not null and v_currency is distinct from v_doc.expected_currency then
    raise exception using errcode='22023', message='the currency must match the assigned transaction';
  end if;
  if v_platform is null then
    raise exception using errcode='22023', message='the platform must be WeChat or Alipay';
  end if;
  if coalesce(nullif(btrim(p_reading->>'refNo'),''), nullif(btrim(p_reading->>'merchantOrderNo'),'')) is null then
    raise exception using errcode='22023', message='the transaction number printed on the receipt is required';
  end if;
  if coalesce(p_reading->>'txDate','') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode='22023', message='the date on the receipt is required';
  end if;
  if p_reading ? 'txTime' and coalesce(p_reading->>'txTime','') <> ''
     and coalesce(p_reading->>'txTime','') !~ '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$' then
    raise exception using errcode='22023', message='the time on the receipt is not a time';
  end if;
  if nullif(btrim(coalesce(p_reading->>'payee','')),'') is null then
    raise exception using errcode='22023', message='the name of whoever received the money is required';
  end if;

  -- The same arithmetic 202608280015 settled: is the fee accounted for, whatever it is called.
  v_reconciles := case
    when v_order is not null then
      (abs(v_gross - (v_order + v_fee)) <= 0.01 and abs(v_net - v_order) <= 0.01)
      or (abs(v_gross - v_order) <= 0.01 and abs(v_net - (v_order - v_fee)) <= 0.01)
    when v_treatment = 'no_fee' then v_fee = 0 and abs(v_net - v_gross) <= 0.01
    else v_fee <= v_gross and abs(v_gross - v_fee - v_net) <= 0.01
  end;
  if not v_reconciles then
    raise exception using errcode='22023',
      message='the total, the fee and the amount that arrived do not add up to one another';
  end if;

  perform set_config('app.receipt_actor_id', v_actor.id, true);
  perform set_config('app.receipt_reason', left(btrim(p_reason), 700), true);
  perform set_config('app.receipt_command_key', p_command_key, true);

  -- is_original is false, and deliberately: nothing was originally read. The row says who wrote
  -- it and why, and every later correction still stacks on top of it as a new version.
  insert into public.receipt_extractions(
    document_id, version, is_original, provider, model, ocr_version, raw,
    gross_amount, order_amount, fee_amount, fee_treatment, net_amount, currency,
    ref_no, merchant_order_no, payee, tx_date, tx_time, confidence,
    platform, has_fee, transaction_status,
    image_sha256, request_id, server_recorded, corrected_by, correction_reason, corrected_at)
  values (
    p_document_id, 1, false, 'human', left(coalesce(v_actor.name, v_actor.id), 80), 'hand-v1',
    jsonb_build_object('enteredBy', v_actor.id, 'enteredAt', statement_timestamp()) || p_reading,
    v_gross, v_order, v_fee, v_treatment, v_net, v_currency,
    left(nullif(btrim(p_reading->>'refNo'),''), 160),
    left(nullif(btrim(p_reading->>'merchantOrderNo'),''), 160),
    left(btrim(p_reading->>'payee'), 160),
    (p_reading->>'txDate')::date,
    case when coalesce(p_reading->>'txTime','') ~ '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$'
         then (p_reading->>'txTime')::time end,
    1.0, v_platform, v_fee > 0,
    left(nullif(btrim(p_reading->>'transactionStatus'),''), 60),
    v_doc.image_sha256, left('hand:' || p_command_key, 80), true,
    v_actor.id, left(btrim(p_reason), 700), statement_timestamp());

  -- To review, never straight past it. Writing the figures and deciding on them are two
  -- decisions, and the second one is recorded on its own with its own reason.
  if v_doc.state <> 'needs_manual_review' then
    update public.receipt_documents
       set state = 'needs_manual_review', counted = false,
           rule_code = 'read_by_hand',
           rule_reason = left(btrim(p_reason), 700)
     where id = p_document_id;
  end if;

  v_result := jsonb_build_object(
    'document_id', p_document_id, 'state', 'needs_manual_review',
    'entered_by', v_actor.id, 'currency', v_currency, 'net_amount', v_net, 'replayed', false);
  insert into public.receipt_command_log(actor_id, command_key, operation, result)
  values (v_actor.id, p_command_key, 'receipt_enter_reading', v_result);
  return v_result;
end;
$$;

revoke all on function public.sarraf_receipt_enter_reading(text, jsonb, text, text) from public, anon;
grant execute on function public.sarraf_receipt_enter_reading(text, jsonb, text, text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_receipt_enter_reading(text, jsonb, text, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
