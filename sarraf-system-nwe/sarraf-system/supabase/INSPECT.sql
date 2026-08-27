-- The send reaches the server now, and the server keeps nothing.
--
--   0 فیش نێردرا — 1 وێنە نەخوێندرایەوە و بڕ و دراوی نییە؛ وەک بەڵگە پارێزراوە بەڵام نەنێردرا
--   ⚠️ 3 لەوانەی وا دەرکەوت پشتڕاستکراوبن لەلایەن سێرڤەرەوە وەک دووبارە ڕەتکرانەوە
--
-- That sentence is mine, and it assumes the reason is duplication. The command writes the real
-- reason on every row it refuses — rule_code and rule_reason — and it refuses for several
-- different reasons:
--
--   the row did not claim acceptance          intake_status <> 'accepted'
--   the browser did not count it              status <> 'ok', or counted false
--   the amount or fee is out of range         amount <= 0, fee > amount
--   the currency is not the batch's           v_row_currency <> v_currency
--   the image or reference is already kept    duplicate
--
-- The last one is the only one my sentence describes. This asks which it actually was, and
-- whether anything was ever accepted before that these could be duplicates OF.
--
-- The owner sees "هیچ کۆمەڵەیەکی نوێ نییە" because the command closes a batch that accepted
-- nothing: status 'done', receipt_stage 'rejected'. The batch exists; it is simply not new.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. Every batch ever committed, and how it closed ════════'
\echo ''

select b.id, b.customer_id, b.currency, b.n, b.rejected_n, b.status, b.receipt_stage,
       b.total_gross, to_char(b.created_at,'HH24:MI:SS') as at, b.tenant_id
  from public.receipt_batches b order by b.created_at desc limit 10;

\echo ''
\echo '════════ 2. Every receipt the command kept, and the reason for each refusal ════════'
\echo ''

select i.batch_id, i.id, i.intake_status, i.counted, i.rule_code,
       left(i.rule_reason, 60) as reason,
       i.amount, i.currency, left(i.ref_no, 28) as ref_no,
       to_char(i.created_at,'HH24:MI:SS') as at
  from public.receipt_intake_items i
 order by i.created_at desc limit 20;

\echo ''
\echo '════════ 3. Was there anything to be a duplicate OF? ════════'
\echo ''
\echo 'The duplicate test only looks at rows already accepted. If none was ever accepted, no'
\echo 'receipt can be a duplicate and the refusal is something else wearing that name.'
\echo ''

select coalesce(intake_status,'⟨none⟩') as intake_status, count(*) as rows,
       count(distinct image_hash) as distinct_images,
       count(distinct upper(regexp_replace(coalesce(ref_no,''),'[^0-9A-Za-z]','','g'))) as distinct_refs
  from public.receipt_intake_items group by 1 order by 1;

\echo ''
\echo '════════ 4. What the browser actually sent, as the audit recorded it ════════'
\echo ''

select e.event_type, e.batch_id, e.receipt_id,
       left(e.metadata::text, 220) as metadata, to_char(e.created_at,'HH24:MI:SS') as at
  from public.receipt_audit_events e
 order by e.created_at desc limit 10;

\echo ''
\echo '════════ 5. The documents behind them, and whether the owner can reach any of it ════════'
\echo ''

select d.id, d.state, d.rule_code, to_char(d.received_at,'HH24:MI:SS') as at, d.tenant_id
  from public.receipt_documents d
 where d.received_at > now() - interval '3 hours'
 order by d.received_at desc limit 10;
