-- The image is stored now. How far does the reading get?
--
-- The screen changed its message: it no longer says the image never arrived, it says the image
-- is safe and the reading will be retried. That is the OCR stage, and it means storage works.
--
-- Where it stopped is written down. /api/receipt-ocr downloads the object, runs the reader, and
-- records the outcome through sarraf_receipt_record_server_extraction, which moves the document
-- and writes a row into receipt_ocr_attempts either way. So:
--
--   state uploading        the route never got as far as recording anything — it failed at
--                          authentication, at the download, or before the provider was called.
--   state ocr_failed_...   the route ran and the provider refused; last_error_code names it.
--   an attempt row         says which provider was tried and what it said.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. Every receipt, and how far it got ════════'
\echo ''

select d.id, d.state, d.received_at,
       exists(select 1 from storage.objects o
               where o.bucket_id='receipts' and o.name=d.storage_path) as image_is_stored,
       d.ocr_attempts,
       -- A `client:` prefix is the browser reporting what /api/receipt-ocr answered it, which is
       -- the only record of a failure that happened before the reader was ever called.
       d.last_error_code,
       d.image_sha256 is not null as server_attested
  from public.receipt_documents d
 order by d.received_at desc limit 12;

\echo ''
\echo '════════ 2. What the reader was asked, and what it answered ════════'
\echo ''

select a.document_id, a.attempt_no, a.provider, a.model, a.status,
       a.error_code, a.latency_ms, a.created_at
  from public.receipt_ocr_attempts a
 order by a.created_at desc limit 20;

\echo ''
\echo '════════ 3. Anything the reader managed to extract ════════'
\echo ''

select e.document_id, e.provider, e.currency, e.gross_amount, e.fee_amount,
       e.ref_no, e.platform, e.confidence, e.created_at
  from public.receipt_extractions e
 order by e.created_at desc limit 10;

\echo ''
\echo '════════ 4. Images stored today ════════'
\echo ''

select o.name, o.created_at, (o.metadata->>'size')::bigint as bytes, o.metadata->>'mimetype' as mime
  from storage.objects o
 where o.bucket_id='receipts' and o.created_at > now() - interval '6 hours'
 order by o.created_at desc limit 12;
