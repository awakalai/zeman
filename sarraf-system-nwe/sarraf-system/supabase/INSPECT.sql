-- Has an image EVER reached the receipts bucket, and when did that stop?
--
-- The last inspection settled which half fails: four receipts were claimed in the last hour,
-- every one of them sits at `uploading`, and the bucket holds nothing. So the claim works and
-- the storage upload is refused.
--
-- Only one thing can refuse it. The permissive grant `rimg_insert` allows any insert into the
-- bucket; the restrictive `receipt_storage_assurance_insert` then requires ALL of:
--
--     owner_id = auth.uid()::text
--     name like 'ingest/%'
--     coalesce(metadata->>'size','') ~ '^[0-9]+$'
--     (metadata->>'size')::bigint between 1 and 10485760
--     lower(metadata->>'mimetype') in (...)
--
-- The first two are satisfied by construction — the path comes from the claim and the owner is
-- the caller. The other three read `metadata`, and Supabase's storage API creates the row to
-- reserve the name BEFORE it knows the object's size or type. If metadata is empty at that
-- moment, coalesce(...,'') is '', the regex fails, and the upload is refused every time.
--
-- This asks the database to date it. Objects before the policy and none after is the proof.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. Everything the bucket holds, by day ════════'
\echo ''
\echo 'receipt_storage_assurance_insert was created by 202608140002. If uploads stop dead on the'
\echo 'day it was applied, the policy is the cause and nothing else needs arguing.'
\echo ''

select date(created_at) as day, count(*) as objects,
       count(*) filter (where metadata ? 'size')     as with_size,
       count(*) filter (where metadata ? 'mimetype') as with_mimetype,
       min(created_at) as first, max(created_at) as last
  from storage.objects
 where bucket_id = 'receipts'
 group by 1 order by 1 desc limit 30;

\echo ''
\echo '════════ 2. The most recent objects, whenever they were ════════'
\echo ''

select name, owner_id, created_at, metadata
  from storage.objects
 where bucket_id = 'receipts'
 order by created_at desc limit 10;

\echo ''
\echo '════════ 3. Totals, so an empty table is not mistaken for a filtered one ════════'
\echo ''

select (select count(*) from storage.objects)                                as objects_all_buckets,
       (select count(*) from storage.objects where bucket_id='receipts')     as objects_in_receipts,
       (select count(*) from public.receipt_documents)                       as receipt_documents,
       (select count(*) from public.receipt_documents where state='uploading') as stuck_at_uploading,
       (select count(*) from public.receipts)                                as legacy_receipt_rows,
       (select count(*) from public.receipt_batches)                         as legacy_batches;

\echo ''
\echo '════════ 4. When each storage policy was created ════════'
\echo ''
\echo 'A policy has no timestamp of its own, so this dates the migrations instead.'
\echo ''

select version, applied_at
  from public.schema_migrations
 where version >= '202608140002'
 order by version limit 20;

\echo ''
\echo '════════ 5. The bucket''s own limits, which are where size and type belong ════════'
\echo ''
\echo 'storage-api enforces these itself, before any policy runs, and it knows the size at the'
\echo 'moment it matters. Both are unset.'
\echo ''

select id, public, file_size_limit, allowed_mime_types from storage.buckets;
