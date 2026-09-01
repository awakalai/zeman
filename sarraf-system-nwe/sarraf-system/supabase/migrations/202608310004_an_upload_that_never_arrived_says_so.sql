-- Five receipts that have been uploading since August (§ stage 8).
--
-- The live inspection on 31 August found five receipt_documents rows in state `uploading` whose
-- storage object does not exist:
--
--   mtbao0cano25zj  27 Aug 09:03    mtap9a0gqiag0f  26 Aug 23:03
--   mtap66jvq7rhhh  26 Aug 23:00    mtap66jvb9xd4k  26 Aug 23:00
--   mtap55tdp1mf5o  26 Aug 22:59
--
-- Why they are stuck. src/services/receiptIntake.js claims a document, gets a storage path, and
-- uploads to it. When the upload fails it calls onStage(uploadFailed, …) — a callback inside the
-- browser — and throws. Nothing tells the database. The row stays `uploading` for ever, its batch
-- keeps waiting for it, and the person who sent it is never told it did not arrive.
--
-- And the browser cannot be the whole answer even once it does report. A phone that loses signal
-- mid-upload, a tab closed, a battery that dies: those are exactly the cases where nothing is
-- left to report anything. So there are two halves here, and both are needed.
--
--   1. sarraf_receipt_upload_failed — the uploader says the image did not arrive, and the
--      document moves `uploading → upload_failed_retryable`, which is the state the machine
--      already has for this and from which `uploading` is reachable again. The receipt is not
--      lost; it is retryable, and it says so.
--
--   2. sarraf_receipt_close_abandoned_uploads — for the ones nothing reported. An administrator
--      sweeps their own business's documents that have been `uploading` longer than a grace
--      period, and the same transition is applied. It returns exactly what it moved.
--
-- Nothing is deleted. No storage object is touched. `upload_failed_retryable` is a forward step
-- in the existing state machine, the transition is logged by the existing trigger, and the
-- receipt can still be sent again.
--
-- ── What this migration does NOT do ──────────────────────────────────────────────────────────
--
-- The same inspection found 85 storage objects (15 MB) that no document row references — staged
-- images from batches that were never committed. Those are not touched by anything here.
-- Removing bytes from Storage cannot be done from SQL at all: deleting a storage.objects row
-- leaves the object itself behind in the bucket. It needs the Storage API, and it needs a
-- verified backup first. It is left for a deliberate, separately authorised act; INSPECT section
-- 5.c reports the count and size every time it runs.

begin;

-- The uploader's own report. Only about their own receipt, only while it is still waiting for
-- its image, and idempotent: saying it twice is saying it once.
create or replace function public.sarraf_receipt_upload_failed(
  p_document_id text, p_code text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype; v_note text;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;

  select * into v_doc from public.receipt_documents where id = p_document_id;
  if not found then raise exception using errcode='P0002', message='receipt not found'; end if;
  if v_doc.uploader_id <> v_actor.id and v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='this receipt is not yours';
  end if;

  -- Already said, or already past it. Either way there is nothing to do and nothing is wrong.
  if v_doc.state <> 'uploading' then
    return jsonb_build_object('document_id', v_doc.id, 'state', v_doc.state::text, 'moved', false);
  end if;

  v_note := left(regexp_replace(coalesce(p_code, 'upload_failed'), '[^A-Za-z0-9_.:-]', '', 'g'), 60);
  if v_note = '' then v_note := 'upload_failed'; end if;

  update public.receipt_documents
     set state = 'upload_failed_retryable',
         last_error_code = left('upload:' || v_note, 80),
         last_attempt_at = statement_timestamp()
   where id = v_doc.id;

  return jsonb_build_object('document_id', v_doc.id, 'state', 'upload_failed_retryable',
                            'moved', true, 'code', v_note);
end;
$$;

comment on function public.sarraf_receipt_upload_failed(text, text) is
  'The uploader says the image never arrived. Moves the document to upload_failed_retryable so the batch stops waiting and the receipt can be sent again.';

-- For the ones nothing was left to report. Administrator only, their own business only, and it
-- names every document it moved rather than returning a count.
create or replace function public.sarraf_receipt_close_abandoned_uploads(
  p_older_than_minutes integer default 120
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype; v_cutoff timestamptz; v_moved text[];
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found or v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='only an administrator may close abandoned uploads';
  end if;
  if coalesce(p_older_than_minutes, 0) < 15 then
    raise exception using errcode='22023',
      message='an upload must be given at least fifteen minutes before it is called abandoned';
  end if;

  v_cutoff := statement_timestamp() - make_interval(mins => p_older_than_minutes);

  -- RLS already limits this to the actor's own business; the tenant is named as well so the
  -- statement is right on its own terms and not only because of the policy above it.
  with stuck as (
    select d.id from public.receipt_documents d
     where d.state = 'uploading'
       and d.received_at < v_cutoff
       and d.tenant_id is not distinct from v_actor.tenant_id
     for update
  ), moved as (
    update public.receipt_documents d
       set state = 'upload_failed_retryable',
           last_error_code = 'upload:abandoned',
           last_attempt_at = statement_timestamp()
      from stuck where d.id = stuck.id
      returning d.id
  )
  select coalesce(array_agg(id), array[]::text[]) into v_moved from moved;

  return jsonb_build_object('cutoff', v_cutoff, 'moved', coalesce(array_length(v_moved, 1), 0),
                            'documents', to_jsonb(v_moved));
end;
$$;

comment on function public.sarraf_receipt_close_abandoned_uploads(integer) is
  'Documents left uploading past a grace period, moved to upload_failed_retryable. Deletes nothing; the receipt can be sent again.';

grant create on schema public to sarraf_definer;
alter function public.sarraf_receipt_upload_failed(text, text) owner to sarraf_definer;
alter function public.sarraf_receipt_close_abandoned_uploads(integer) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

revoke all on function public.sarraf_receipt_upload_failed(text, text) from public, anon;
revoke all on function public.sarraf_receipt_close_abandoned_uploads(integer) from public, anon;
grant execute on function public.sarraf_receipt_upload_failed(text, text) to authenticated;
grant execute on function public.sarraf_receipt_close_abandoned_uploads(integer) to authenticated;

-- ── The five that have been waiting since August ─────────────────────────────────────────────
--
-- Named by the inspection before this was written, so nothing here is a surprise. Same
-- transition, no session to run the command with, so it is done directly. A document younger
-- than a day is left alone: it may still be uploading right now.
do $$
declare v_moved bigint;
begin
  update public.receipt_documents
     set state = 'upload_failed_retryable',
         last_error_code = 'upload:abandoned',
         last_attempt_at = statement_timestamp()
   where state = 'uploading'
     and received_at < statement_timestamp() - interval '1 day';
  get diagnostics v_moved = row_count;
  raise notice 'closed % abandoned upload(s)', v_moved;
end $$;

commit;
