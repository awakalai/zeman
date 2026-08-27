-- Which rule refused them, and did the browser send the field at all?
--
-- Every one of the four was refused with rule_code 'server_rejected' and the reason
-- "فیشەکە یاساکانی ناردنی نەبڕیوە", which is the command's DEFAULT — the text it uses when the
-- browser named no reason of its own. So this was not the duplicate test: nothing has ever been
-- accepted for them to duplicate, and all four images and all four references are distinct.
--
-- v_accept is a single conjunction of six things, and the command records which row it refused
-- without recording WHICH of the six failed:
--
--   intake_status = 'accepted'
--   status = 'ok'
--   counted in (true,t,1)
--   amount > 0 and amount <= 1000000000000
--   fee >= 0 and fee <= amount
--   currency ~ '^[A-Z]{3,8}$' and currency = the batch's currency
--
-- The audit event keeps the raw row the browser sent. That answers it outright.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. Exactly what the browser sent for each refused receipt ════════'
\echo ''
\echo 'intake_status is the field added this morning. If it is ⟨absent⟩ the phone was still'
\echo 'running the previous bundle when it sent — a service worker serves the cached app until'
\echo 'it updates, so a deploy five minutes earlier does not mean the phone had it.'
\echo ''

select e.receipt_id,
       coalesce(e.metadata->>'intake_status','⟨absent⟩') as intake_status,
       coalesce(e.metadata->>'status','⟨absent⟩')        as status,
       coalesce(e.metadata->>'counted','⟨absent⟩')       as counted,
       coalesce(e.metadata->>'amount','⟨absent⟩')        as amount,
       coalesce(e.metadata->>'fee','⟨absent⟩')           as fee,
       coalesce(e.metadata->>'currency','⟨absent⟩')      as currency
  from public.receipt_audit_events e
 where e.event_type = 'rejected'
 order by e.created_at desc limit 8;

\echo ''
\echo '════════ 2. The batch''s own currency, which every row must match ════════'
\echo ''
\echo 'v_row_currency = v_currency is the one test that compares a row against the batch. A batch'
\echo 'that fell back to UNKNOWN refuses every CNY receipt in it.'
\echo ''

select b.id, b.currency as batch_currency, b.n, b.rejected_n, b.status, b.receipt_stage,
       to_char(b.created_at,'HH24:MI:SS') as at
  from public.receipt_batches b order by b.created_at desc limit 5;

select i.batch_id, i.id, i.intake_status, i.counted, i.rule_code,
       i.amount, i.currency, i.fee
  from public.receipt_intake_items i order by i.created_at desc limit 8;

\echo ''
\echo '════════ 3. Everything the browser put in the metadata, once, in full ════════'
\echo ''

select jsonb_pretty(e.metadata) as sent
  from public.receipt_audit_events e
 where e.event_type = 'rejected' order by e.created_at desc limit 1;
