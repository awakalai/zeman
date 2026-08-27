-- The reader works. Why does every receipt still need a person?
--
-- Three were read this morning — groq and gemini, 2.4 to 6.6 seconds, confidence 0.95 to 0.98,
-- amounts and fees and reference numbers all extracted. Every one of them landed at
-- needs_manual_review rather than validated.
--
-- sarraf_receipt_record_server_extraction validates on eight things, and any one of them sends
-- the receipt to a person:
--
--   confidence < 0.72                      no: 0.95, 0.98, 0.95
--   grossAmount null                       no: all three have one
--   refNo null                             no: all three have one
--   platform not WeChat or Alipay          no: all three are alipay
--   txDate not YYYY-MM-DD                  ?
--   payee and recipientNote and merchant   ?
--     all empty
--   feeTreatment 'unknown'                 ?
--   transactionStatus not success          ?
--
-- Four candidates left, and the raw reading holds the answer for each. If every honest receipt
-- needs a person, the automation is not doing the job it exists for.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. The four fields that could be sending these to a person ════════'
\echo ''

select e.document_id,
       coalesce(e.raw->>'txDate','⟨missing⟩')            as tx_date,
       coalesce(e.raw->>'payee','⟨missing⟩')             as payee,
       coalesce(e.raw->>'recipientNote','⟨missing⟩')     as recipient_note,
       coalesce(e.raw->>'merchantName','⟨missing⟩')      as merchant_name,
       coalesce(e.raw->>'feeTreatment','⟨missing⟩')      as fee_treatment,
       coalesce(e.raw->>'transactionStatus','⟨missing⟩') as tx_status
  from public.receipt_extractions e
 where e.is_original
 order by e.created_at desc limit 6;

\echo ''
\echo '════════ 2. Which rule each one actually fails ════════'
\echo ''

select e.document_id,
       (coalesce(e.confidence,0) < 0.72)                                          as low_confidence,
       (e.gross_amount is null)                                                   as no_amount,
       (nullif(e.raw->>'refNo','') is null)                                       as no_reference,
       (coalesce(e.raw->>'platform','') !~* '(wechat|weixin|微信|alipay|ali[ -]?pay|支付宝)') as wrong_platform,
       (coalesce(e.raw->>'txDate','') !~ '^\d{4}-\d{2}-\d{2}$')                    as bad_date,
       (nullif(btrim(coalesce(e.raw->>'payee','')),'') is null
        and nullif(btrim(coalesce(e.raw->>'recipientNote', e.raw->>'merchantName','')),'') is null) as no_receiver,
       (coalesce(e.raw->>'feeTreatment','unknown') = 'unknown')                    as fee_unknown,
       (coalesce(e.raw->>'transactionStatus','') !~* '(success|completed|successful)') as not_successful
  from public.receipt_extractions e
 where e.is_original
 order by e.created_at desc limit 6;

\echo ''
\echo '════════ 3. What the owner sees, and what the reason says ════════'
\echo ''

select d.id, d.state, d.rule_code, d.rule_reason, d.expected_currency, d.tenant_id
  from public.receipt_documents d
 where d.ocr_attempts > 0
 order by d.received_at desc limit 6;

\echo ''
\echo '════════ 4. The whole reading of the most recent one ════════'
\echo ''

select jsonb_pretty(e.raw) as raw
  from public.receipt_extractions e
 where e.is_original order by e.created_at desc limit 1;
