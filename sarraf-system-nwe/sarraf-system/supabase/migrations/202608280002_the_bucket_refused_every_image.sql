-- Storage refused every upload, and the screen called it an unreadable image.
--
-- Four receipts were claimed on the live system tonight. All four sit at `uploading`, and the
-- bucket holds nothing newer than the seventeenth. The claim is not the problem; the object is
-- never stored, and storage says why:
--
--   new row violates row-level security policy "receipt_storage_assurance_insert" for table "objects"
--
-- The policy, written in 202608140002, requires all of this at INSERT:
--
--     owner_id = auth.uid()::text
--     name like 'ingest/%'
--     coalesce(metadata->>'size','') ~ '^[0-9]+$'
--     (metadata->>'size')::bigint between 1 and 10485760
--     lower(metadata->>'mimetype') in ('image/jpeg', ...)
--
-- The first two are right and stay. The last three read metadata that does not exist yet.
-- Supabase Storage reserves the name first — it inserts the row, then stores the bytes, then
-- comes back and records the size and the type — so at the moment this policy runs, metadata is
-- empty, coalesce(...,'') is '', the regex fails, and the upload is refused. Every upload. By
-- every uploader. Since the day the policy was applied.
--
-- And the same mistake a second time, on the way back. The update policy forbids touching an
-- object that a receipt_document points at — evidence, once claimed, must not be swapped. But
-- the claim is what hands the browser the path it uploads to, so the claim ALWAYS exists first.
-- The row storage comes back to fill in is, by construction, always claimed. Even had the insert
-- succeeded, the object would have been left with no size and no type forever.
--
-- Neither of these was ever exercised. The fixture created storage.objects and granted nothing,
-- so no gate could insert a row, so every restrictive policy over that table was dead code in
-- every check while being very much alive in production. verify:isolation now performs the two
-- statements a real upload performs, and this migration is what makes them pass.
--
-- Size and type are not abandoned. They move to where they can actually be known:
--
--   * the bucket's own file_size_limit and allowed_mime_types, which storage-api enforces
--     itself, at the moment it has the bytes in hand — both were unset;
--   * the policy still refuses an illegal size or type WHEN one is stated, so a client that
--     supplies metadata cannot lie about it;
--   * sarraf_ingest_receipt_batch already re-reads storage.objects and refuses a receipt whose
--     object is outside 1..10485760 bytes or not an image, before any money is written;
--   * sarraf_receipt_record_server_extraction pins the sha256 of what the server actually
--     downloaded, and the document's hash is immutable afterwards.
--
-- What the policy is left enforcing at insert is what only it can enforce: you may write into
-- the ingest namespace, and only under your own name.
begin;

do $storage_policies$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage.objects is absent; nothing to correct';
    return;
  end if;

  -- ── reserving the name ──────────────────────────────────────────────────────
  execute 'drop policy if exists receipt_storage_assurance_insert on storage.objects';
  execute $policy$
    create policy receipt_storage_assurance_insert on storage.objects
    as restrictive for insert to authenticated with check (
      bucket_id <> 'receipts' or (
        owner_id = auth.uid()::text
        and name like 'ingest/%'
        -- Stated or not stated; never stated wrongly.
        and (coalesce(metadata->>'size','') = ''
             or (metadata->>'size' ~ '^[0-9]+$'
                 and (metadata->>'size')::bigint between 1 and 10485760))
        and (coalesce(metadata->>'mimetype','') = ''
             or (name like 'ingest/office-payments/%'
                 and lower(metadata->>'mimetype') in
                   ('image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'))
             or (name not like 'ingest/office-payments/%'
                 and lower(metadata->>'mimetype') in
                   ('image/jpeg','image/png','image/webp','image/heic','image/heif')))
      ))
  $policy$;

  -- ── recording what was stored, once, and never again ────────────────────────
  --
  -- USING sees the row as it stands. An object with no size recorded is still being written, and
  -- storage must be allowed to finish. An object that already has one is stored evidence: if a
  -- receipt, a document or an office payment points at it, it is closed for good.
  execute 'drop policy if exists receipt_storage_assurance_update on storage.objects';
  execute $policy$
    create policy receipt_storage_assurance_update on storage.objects
    as restrictive for update to authenticated using (
      bucket_id <> 'receipts' or (
        owner_id = auth.uid()::text
        and name like 'ingest/%'
        and (
          coalesce(metadata->>'size','') = ''
          or (
            not exists(select 1 from public.receipt_intake_items i where i.image_path = name)
            and not exists(select 1 from public.receipts r where r.image_path = name)
            and not exists(select 1 from public.receipt_documents d where d.storage_path = name)
            and not exists(select 1 from public.office_payment_evidence e where e.storage_path = name)
          )
        )
      ))
    with check (
      bucket_id <> 'receipts' or (
        owner_id = auth.uid()::text
        and name like 'ingest/%'
        and (coalesce(metadata->>'size','') = ''
             or (metadata->>'size' ~ '^[0-9]+$'
                 and (metadata->>'size')::bigint between 1 and 10485760))
        and (coalesce(metadata->>'mimetype','') = ''
             or (name like 'ingest/office-payments/%'
                 and lower(metadata->>'mimetype') in
                   ('image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'))
             or (name not like 'ingest/office-payments/%'
                 and lower(metadata->>'mimetype') in
                   ('image/jpeg','image/png','image/webp','image/heic','image/heif')))
      ))
  $policy$;
end
$storage_policies$;

-- ── where a size limit belongs ────────────────────────────────────────────────
--
-- storage-api checks these itself, before a policy is ever consulted, and it knows the real size
-- and the real type because it is holding the bytes. Both were null, so the only size rule on
-- this bucket was the one in a policy that could not see a size.
do $bucket$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  update storage.buckets
     set file_size_limit = 10485760,
         allowed_mime_types = array['image/jpeg','image/png','image/webp',
                                    'image/heic','image/heif','application/pdf']
   where id = 'receipts';
  raise notice 'the receipts bucket now states its own limit: 10 MB, images and PDF';
end
$bucket$;

commit;
