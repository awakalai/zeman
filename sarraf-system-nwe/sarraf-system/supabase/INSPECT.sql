-- Three more receipts, 10:22. Two complain the numbers do not add up; one asks for a person.
--
-- The complaint on screen is the browser's own:
--
--   ژمارەکان یەک ناگرنەوە: 1,246.30 − 36.30 = 0.00، بەڵام 1,210.00 نووسراوە
--
-- 1246.30 − 36.30 is 1210.00, not 0.00, so that arithmetic is the browser's and it is wrong.
-- validateReceiptArithmetic reads `expectedNet = order ?? (gross - fee)`, and ?? only falls
-- through on null — an orderAmount of 0 is kept as a real order of nothing. The reader returns
-- "orderAmount": "0" when a receipt states no separate order amount, so every such receipt is
-- told its net should be zero. That one is settled; this asks about the third.
--
-- The third says needs_manual_review, which is the server's verdict, and seven of the eight
-- rules are visible in the reading itself.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. This morning''s receipts and where each stopped ════════'
\echo ''

select d.id, d.state, d.rule_code, to_char(d.received_at,'HH24:MI:SS') as at,
       d.ocr_attempts, d.last_error_code
  from public.receipt_documents d
 where d.received_at > now() - interval '4 hours'
 order by d.received_at desc limit 10;

\echo ''
\echo '════════ 2. Every rule, per receipt, so the failing one names itself ════════'
\echo ''

select e.document_id,
       round(e.confidence,2) as conf,
       (coalesce(e.confidence,0) < 0.72)                             as f_confidence,
       (e.gross_amount is null)                                      as f_amount,
       (nullif(e.raw->>'refNo','') is null)                          as f_reference,
       (coalesce(e.raw->>'platform','') !~* '(wechat|weixin|微信|alipay|ali[ -]?pay|支付宝)') as f_platform,
       (coalesce(e.raw->>'txDate','') !~ '^\d{4}-\d{2}-\d{2}$')       as f_date,
       (nullif(btrim(coalesce(e.raw->>'payee','')),'') is null
        and nullif(btrim(coalesce(e.raw->>'recipientNote', e.raw->>'merchantName','')),'') is null) as f_receiver,
       (coalesce(e.raw->>'transactionStatus','') !~* '(success|completed|successful)') as f_status,
       -- the rule as it now stands: accounted for, not labelled
       (coalesce(e.raw->>'feeTreatment','unknown')='unknown'
        and coalesce(abs(public.receipt_json_numeric(e.raw,'grossAmount')),-1)
            - coalesce(abs(public.receipt_json_numeric(e.raw,'feeAmount')),0)
            is distinct from coalesce(abs(public.receipt_json_numeric(e.raw,'netAmount')),-2)) as f_fee
  from public.receipt_extractions e
 where e.is_original and e.created_at > now() - interval '4 hours'
 order by e.created_at desc limit 10;

\echo ''
\echo '════════ 3. The figures the reader gave, including the order amount ════════'
\echo ''
\echo 'orderAmount of "0" is the reader saying the receipt states none. Anything that treats'
\echo 'that as a real order of zero will conclude the net should be zero too.'
\echo ''

select e.document_id,
       e.raw->>'grossAmount' as gross, e.raw->>'feeAmount' as fee,
       e.raw->>'netAmount'   as net,   e.raw->>'orderAmount' as order_amount,
       e.raw->>'feeTreatment' as fee_treatment,
       left(coalesce(e.raw->>'payee','⟨none⟩'), 24) as payee,
       e.raw->>'transactionStatus' as tx_status
  from public.receipt_extractions e
 where e.is_original and e.created_at > now() - interval '4 hours'
 order by e.created_at desc limit 10;

\echo ''
\echo '════════ 4. Anything that reached a batch, and what the send did ════════'
\echo ''

select b.id, b.customer_id, b.currency, b.n, b.total_gross, b.status, b.created_at
  from public.receipt_batches b order by b.created_at desc limit 5;

select (select count(*) from public.receipts)                          as receipt_rows,
       (select count(*) from public.receipt_batches)                   as batches,
       (select count(*) from public.receipt_ingestion_commands)        as ingestion_commands;
