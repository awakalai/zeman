-- Is the storage fix live, and has an image landed since?
--
-- 202608280002 rewrote the two policies that refused every upload: the insert one demanded a
-- size and a type that Supabase Storage does not know yet when it reserves the name, and the
-- update one forbade completing an object that a claim points at — which every claimed object
-- is, by construction. It also gave the bucket the size and type limits it never had.
--
-- Two questions, and the second one answers itself as soon as anybody uploads.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. Is the correction applied? ════════'
\echo ''

select version, applied_at from public.schema_migrations
 where version >= '202608280001' order by version;

\echo ''
\echo 'The bucket''s own limits, which storage-api enforces while holding the bytes.'
\echo 'Both were null until this migration.'
\echo ''

select id, file_size_limit, allowed_mime_types from storage.buckets where id = 'receipts';

\echo ''
\echo 'And the insert policy as it now stands. A size that is not stated is no longer a refusal.'
\echo ''

select pol.polname,
       case pol.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE' else pol.polcmd::text end as command,
       pg_get_expr(pol.polwithcheck, pol.polrelid) like '%coalesce((metadata ->> ''size''::text), ''''::text) = ''''%'
         as allows_an_object_still_being_written
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'storage'
 where c.relname = 'objects' and pol.polname in
       ('receipt_storage_assurance_insert','receipt_storage_assurance_update')
 order by pol.polname;

\echo ''
\echo '════════ 2. Has an image landed since? ════════'
\echo ''
\echo 'Nothing has reached this bucket since 17 August. An object dated today is the proof that'
\echo 'the whole path works: claim, store, and read.'
\echo ''

select o.name, o.created_at, (o.metadata->>'size')::bigint as bytes, o.metadata->>'mimetype' as mime
  from storage.objects o
 where o.bucket_id = 'receipts'
 order by o.created_at desc limit 8;

\echo ''
\echo 'And where each claimed receipt has got to. `uploading` means the image never arrived;'
\echo 'anything past it means it did.'
\echo ''

select d.id, d.state, d.received_at,
       exists(select 1 from storage.objects o
               where o.bucket_id='receipts' and o.name = d.storage_path) as image_is_stored,
       (select e.currency || ' ' || e.gross_amount from public.receipt_extractions e
         where e.document_id = d.id and e.is_original) as what_was_read
  from public.receipt_documents d
 order by d.received_at desc limit 12;
