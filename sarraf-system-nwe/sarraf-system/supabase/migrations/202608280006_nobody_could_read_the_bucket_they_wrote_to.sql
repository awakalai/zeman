-- The send could not find the image it had just stored.
--
--   وێنەکان گەیشتن، بەڵام داتابەیس تۆماری نەکردن — فیشەکان نەگەیشتن
--
-- sarraf_ingest_receipt_batch refuses a receipt whose staged object it cannot confirm:
--
--   if not exists (select 1 from storage.objects o
--                   where o.bucket_id='receipts' and o.name=v_path
--                     and o.owner_id=auth.uid()::text
--                     and coalesce((o.metadata->>'size')::bigint,0) between 1 and 10485760
--                     and lower(coalesce(o.metadata->>'mimetype','')) in ('image/jpeg', ...))
--   then raise exception 'invalid staged object'; end if;
--
-- That is a SELECT on storage.objects. Every policy this repository has ever written over that
-- table is RESTRICTIVE — receipt_storage_assurance_read, _insert, _update, _delete — and a
-- restrictive policy can only take rows away. Rows have to be granted by a PERMISSIVE policy
-- first, and the live project has exactly one: rimg_insert, which is for INSERT.
--
-- So no browser session, and no command acting for one, has ever been able to read a single row
-- of storage.objects. The restrictive read policy — own recent uploads, or an administrator, or
-- the uploader of the document that points at the object, or somebody it was forwarded to —
-- was written to narrow a permission that was never given. It has spent its whole life
-- subtracting from nothing.
--
-- Every send has failed at that line. public.receipts is empty, public.receipt_batches is empty,
-- and receipt_ingestion_commands has never recorded a single command.
--
-- The permissive policy is deliberately as plain as the insert one it mirrors: the bucket, and
-- nothing else. receipt_storage_assurance_read holds the actual rule, it is already correct, and
-- it now has something to narrow.
begin;

do $storage_read$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage.objects is absent; nothing to grant';
    return;
  end if;

  execute 'drop policy if exists receipt_storage_read on storage.objects';
  execute $policy$
    create policy receipt_storage_read on storage.objects
    as permissive for select to authenticated
    using (bucket_id = 'receipts')
  $policy$;
  raise notice 'the receipts bucket can be read again, as far as the restrictive rule allows';
end
$storage_read$;

-- The restrictive rule is what actually decides, so assert it is still there. A permissive
-- policy on its own would open the bucket to every signed-in person on the installation.
do $check$
declare v_restrictive integer;
begin
  select count(*) into v_restrictive
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'storage'
   where c.relname = 'objects'
     and pol.polname = 'receipt_storage_assurance_read'
     and not pol.polpermissive;
  if v_restrictive <> 1 then
    raise exception 'the restrictive read rule is missing; a permissive policy alone would open the whole bucket';
  end if;
  raise notice 'the restrictive read rule is in place and now has something to narrow';
end
$check$;

commit;
