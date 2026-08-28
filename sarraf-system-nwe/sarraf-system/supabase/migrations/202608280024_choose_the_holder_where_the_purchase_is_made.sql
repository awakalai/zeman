-- One press: choose who holds the money, and the receipts are placed with them.
--
-- 202608280021 and #97 got this the wrong way round. The conversion reads custody from the
-- RECEIPTS, so the partner the owner chose on the purchase screen was overwritten before any
-- rule saw it — and the rule then refused the trade for naming nobody. My fix was to lock the
-- box and send the owner to a different screen to set custody first.
--
-- The owner's answer to that, and they are right:
--
--   «هەر کە درووستکردنی کڕین لەم فیشەوەم کرد، هەر لەوێوە هاوبەش هەڵبژێرم و کە کردم، هەم پارەکە
--    بچێتە لای ئەو هەمیش پەسەند بکرێت و فیشەکانیشی بۆ بڕوات — بەڵام با هێندە شپرز نەبێت»
--
-- Two screens and three commands to do one thing is the defect. The rule was never the problem.
--
-- So the choice made on the purchase screen is honoured, and honoured properly: the conversion
-- CALLS sarraf_assign_receipt_custody rather than writing around it. Every row that command
-- writes — receipt_custody, receipt_intake_items, receipts, receipt_custody_events,
-- receipt_audit_events, and the batch's own partner — is written by that command, in this same
-- transaction. The evidence is identical to the batch screen's because it IS the batch screen's,
-- and it cannot drift.
--
-- Only when the receipts name nobody. Receipts already placed with a partner keep that partner;
-- moving them is a custody decision of its own and keeps its own screen.

begin;

create or replace function public.sarraf_convert_receipt_batch_to_transaction(
  p_batch_id text,p_receipt_ids jsonb,p_tx jsonb,p_reason text,p_command_key text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_actor public.app_users%rowtype; v_batch public.receipt_batches%rowtype; v_result jsonb; v_previous jsonb;
  v_total numeric; v_currency text; v_currency_id text; v_count int; v_currency_count int; v_partner_count int;
  v_expected_type text; v_cp text; v_partner text; v_remaining int; v_primary_tx text;
  v_named text;
  v_tx jsonb; v_tx_id text; v_tx_command text; v_approval_id text;
begin
  select * into v_actor from public.app_users where auth_id=auth.uid() and not deleted;
  if not found or v_actor.role<>'admin' then raise exception using errcode='42501',message='receipt conversion is not authorized'; end if;
  if p_command_key !~ '^receipt-convert:[A-Za-z0-9:_-]{16,220}$' or char_length(btrim(coalesce(p_reason,'')))<8
    or jsonb_typeof(p_tx)<>'object' or jsonb_typeof(p_receipt_ids)<>'array'
    or jsonb_array_length(p_receipt_ids)<1 or jsonb_array_length(p_receipt_ids)>25 then
    raise exception using errcode='22023',message='invalid receipt conversion command';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.id||':'||p_command_key,0));
  select result into v_previous from public.receipt_operation_commands where actor_id=v_actor.id and command_key=p_command_key;
  if found then return v_previous||jsonb_build_object('replayed',true); end if;
  select * into v_batch from public.receipt_batches where id=p_batch_id for update;
  if not found then raise exception using errcode='P0002',message='receipt batch not found'; end if;
  if v_batch.receipt_stage<>'verified' then raise exception using errcode='22023',message='receipt batch is not verified for conversion'; end if;

  with requested as (select distinct jsonb_array_elements_text(p_receipt_ids) id)
  select count(*),sum(i.net_amount),min(i.currency),count(distinct i.currency),count(distinct i.partner_id),max(i.partner_id)
  into v_count,v_total,v_currency,v_currency_count,v_partner_count,v_partner
  from public.receipt_intake_items i join requested q on q.id=i.id
  where i.batch_id=p_batch_id and i.intake_status='accepted' and i.counted and i.transaction_id is null;
  if v_count<>jsonb_array_length(p_receipt_ids) or v_count<1 or v_total<=0 or v_currency_count<>1 or v_partner_count>1 then
    raise exception using errcode='22023',message='selected receipts are ineligible, reused, mixed-currency, or split across partners';
  end if;
  select id into v_currency_id from public.currencies where upper(code)=upper(v_currency) limit 1;
  if v_currency_id is null or p_tx->>'cur_id' is distinct from v_currency_id then raise exception using errcode='22023',message='transaction currency does not match accepted receipts'; end if;

  v_expected_type:=case when v_batch.direction in ('out','sell') then 'sell' else 'buy' end;
  if p_tx->>'type' is distinct from v_expected_type then raise exception using errcode='22023',message='transaction direction does not match receipts'; end if;
  v_cp:=nullif(btrim(p_tx->>'cp_id'),'');
  if v_batch.customer_id is not null then
    if v_cp is distinct from v_batch.customer_id then raise exception using errcode='22023',message='transaction customer does not match receipts'; end if;
  elsif v_cp is null or not exists(select 1 from public.app_users where id=v_cp and role='customer' and not deleted) then
    raise exception using errcode='22023',message='partner receipt conversion requires a valid customer';
  end if;
  if v_partner is null then v_partner:=v_batch.partner_id; end if;

  -- The owner names the custodian here, on the purchase screen, and it is recorded here.
  --
  -- Custody used to be a separate command on a separate screen. That was not wrong — money in a
  -- currency the office does not hold has to be somewhere, and where it is, is evidence. But it
  -- meant the owner pressed «درووستکردنی کڕین لەم فیشانەوە», chose a partner in the form in front
  -- of them, and was refused for naming nobody: the conversion overwrote their choice with what
  -- the receipts said, and a customer's receipts say nothing.
  --
  -- So the choice is honoured, and honoured properly. This does not skip the custody command or
  -- write around it — it CALLS it, so the receipt rows, the custody row, the custody event and
  -- the audit event are written exactly as the batch screen writes them, by the same code, and
  -- can never drift from it. One press, one transaction, the same evidence.
  --
  -- Only when the receipts name nobody. A partner already holding these receipts cannot be
  -- reassigned from a purchase form: that is a custody decision of its own and keeps its own
  -- screen.
  if v_partner is null then
    v_named:=nullif(btrim(p_tx->>'partner_id'),'');
    if v_named is not null then
      if not exists(select 1 from public.app_users
                     where id=v_named and role='partner' and not deleted) then
        raise exception using errcode='22023',message='transaction partner is invalid';
      end if;
      perform public.sarraf_assign_receipt_custody(
        p_batch_id,
        (select jsonb_agg(jsonb_build_object('receipt_id', value, 'partner_id', v_named))
           from jsonb_array_elements_text(p_receipt_ids)),
        left(btrim(coalesce(p_reason,'')), 700),
        'receipt-custody:' || left(md5(p_command_key || ':custody'), 32));
      v_partner:=v_named;
    end if;
  end if;
  v_tx:=p_tx||jsonb_build_object('amount',v_total,'cur_id',v_currency_id,'cp_id',v_cp,'partner_id',v_partner,'edited',false,'deleted',false);
  v_tx_command:=format('tx:%s:%s',v_actor.id,md5(p_command_key));
  v_result:=public.sarraf_commit_transactions(
    jsonb_build_array(v_tx),'[]'::jsonb,p_batch_id,v_tx_command,
    case when v_expected_type='buy' then 'کڕین لە فیشە پەسەندکراوەکان' else 'فرۆشتن لە فیشە پەسەندکراوەکان' end,
    left(btrim(p_reason),700)
  );
  v_tx_id:=coalesce(v_result->'transactions'->0->>'id',v_result->'transaction'->>'id');
  if v_tx_id is not null then
    insert into public.receipt_batch_transactions(batch_id,transaction_id,partner_id,item_count,amount,currency,created_by)
    values(p_batch_id,v_tx_id,v_partner,v_count,v_total,v_currency,v_actor.id) on conflict do nothing;
    update public.receipt_intake_items set transaction_id=v_tx_id,converted_at=statement_timestamp()
    where batch_id=p_batch_id and id in (select jsonb_array_elements_text(p_receipt_ids)) and transaction_id is null;
    select count(*) into v_remaining from public.receipt_intake_items
      where batch_id=p_batch_id and intake_status='accepted' and counted and transaction_id is null;
    select transaction_id into v_primary_tx from public.receipt_batch_transactions where batch_id=p_batch_id order by created_at,transaction_id limit 1;
    update public.receipt_batches set
      tx_id=case when v_remaining=0 then v_primary_tx else null end,
      status=case when v_remaining=0 then 'done' else 'new' end,
      receipt_stage=case when v_remaining=0 then 'matched' else 'verified' end,
      decision_status=case when v_remaining=0 then 'accepted' else null end,
      decision_reason=case when v_remaining=0 then left(btrim(p_reason),700) else null end,
      decision_by=case when v_remaining=0 then v_actor.id else null end,
      decided_at=case when v_remaining=0 then statement_timestamp() else null end,
      matched_at=case when v_remaining=0 then statement_timestamp() else null end,
      matched_by=case when v_remaining=0 then v_actor.id else null end,
      match_reason=case when v_remaining=0 then left(btrim(p_reason),700) else null end
    where id=p_batch_id;
    insert into public.receipt_audit_events(event_type,batch_id,actor_id,command_key,metadata)
    values('matched',p_batch_id,v_actor.id,p_command_key,
      jsonb_build_object('operation','converted_to_transaction','tx_id',v_tx_id,'receipt_ids',p_receipt_ids,
        'accepted_count',v_count,'remaining_count',v_remaining,'total_net',v_total,'currency',v_currency,'reason',left(btrim(p_reason),700)));
  elsif coalesce((v_result->>'approval_required')::boolean,false) and nullif(v_result->>'approval_id','') is not null then
    v_approval_id:=v_result->>'approval_id';
    insert into public.receipt_pending_conversions(
      approval_id,batch_id,item_ids,partner_id,item_count,amount,currency,requested_by,command_key
    ) values(v_approval_id,p_batch_id,p_receipt_ids,v_partner,v_count,v_total,v_currency,v_actor.id,p_command_key)
    on conflict(approval_id) do nothing;
  end if;
  v_result:=coalesce(v_result,'{}'::jsonb)||jsonb_build_object('receipt_batch_id',p_batch_id,'receipt_ids',p_receipt_ids,
    'accepted_count',v_count,'accepted_total',v_total,'accepted_currency',v_currency);
  insert into public.receipt_operation_commands(actor_id,command_key,operation,batch_id,result)
  values(v_actor.id,p_command_key,'convert',p_batch_id,v_result);
  return v_result;
end;
$$;

commit;
