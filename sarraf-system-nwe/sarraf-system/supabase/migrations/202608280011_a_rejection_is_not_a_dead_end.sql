-- «لە بەرامبەر فیشە ڕەتکراوەکەدا دوگمەی «بارکردنەوەی فیشی نوێ» چالاک دەبێت ...
--   بارکردنەوەی نوێ بەستەر (Link) دەکرێتەوە بە فیشە ڕەتکراوەکەی پێشوو»
--
-- Today a rejected receipt is the end of the road. The person who sent it can upload another
-- image, and that image is a stranger: nothing says it was sent because of the rejection, so
-- the owner sees an unexplained second receipt and the audit trail has a hole exactly where
-- somebody would later ask "what happened to the one you refused?".
--
-- 202608280009 added the two columns. This is the one command that may write them.
--
-- What it refuses, and why each refusal exists:
--
--   the receipt is not finished with        a receipt still under review has not been refused;
--                                           replacing it would hide a decision nobody made
--   it already has a replacement            a chain that forks is not a chain
--   the new one already replaces something  the same, walking the other way
--   they belong to different businesses     a replacement that crosses a business is a leak
--   the caller sent neither of them          and is not staff of the business that holds them
--
-- The status the specification calls REPLACED is not stored. It is `replaced_by_document_id is
-- not null`, which cannot disagree with the link the way a copy of it could. A rejected receipt
-- with a successor reads as REPLACED everywhere it is read.
begin;

-- Who linked the replacement, and when. receipt_audit_events cannot hold this: every row there
-- belongs to a batch and to one of seven fixed event types, and a replacement is neither — the
-- new receipt has not been sent yet, so it has no batch at all. The two columns say the same
-- thing in the place the question is asked from.
alter table public.receipt_documents
  add column if not exists replacement_linked_by text references public.app_users(id);
alter table public.receipt_documents
  add column if not exists replacement_linked_at timestamptz;

create or replace function public.sarraf_receipt_replace(
  p_rejected_document_id text,
  p_new_document_id text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_old public.receipt_documents%rowtype;
  v_new public.receipt_documents%rowtype;
  v_staff boolean;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode = '42501', message = 'sign in before replacing a receipt';
  end if;
  v_staff := v_actor.role in ('admin', 'office');

  if coalesce(btrim(p_rejected_document_id), '') = ''
     or coalesce(btrim(p_new_document_id), '') = ''
     or p_rejected_document_id = p_new_document_id then
    raise exception using errcode = '22023', message = 'two different receipts are required';
  end if;

  -- Ordered locks, so two people pressing the button at the same moment cannot both win.
  perform pg_advisory_xact_lock(hashtextextended('receipt-replace:' || k, 0))
     from unnest(array[p_rejected_document_id, p_new_document_id]) as t(k)
    order by k;

  select * into v_old from public.receipt_documents where id = p_rejected_document_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'the refused receipt was not found'; end if;
  select * into v_new from public.receipt_documents where id = p_new_document_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'the new receipt was not found'; end if;

  if v_old.tenant_id is distinct from v_new.tenant_id then
    raise exception using errcode = '42501', message = 'a receipt may only be replaced inside its own business';
  end if;
  if not v_staff and (v_actor.id not in (v_old.uploader_id, coalesce(v_old.customer_id, v_old.uploader_id))
                      or v_new.uploader_id is distinct from v_actor.id) then
    raise exception using errcode = '42501', message = 'only the person who sent the receipt may replace it';
  end if;

  -- Already done, exactly as asked. Pressing the button twice is not an error.
  if v_old.replaced_by_document_id = p_new_document_id
     and v_new.replaces_document_id = p_rejected_document_id then
    return jsonb_build_object('replaced', p_rejected_document_id, 'by', p_new_document_id,
                              'tracking_code', v_new.tracking_code, 'replayed', true);
  end if;

  if v_old.counted or v_old.state not in
     ('rejected', 'duplicate', 'currency_mismatch', 'tamper_suspected',
      'failed_terminal', 'ocr_failed_retryable', 'upload_failed_retryable') then
    raise exception using errcode = '23514',
      message = 'only a refused receipt may be replaced; this one is still under review';
  end if;
  if v_old.replaced_by_document_id is not null then
    raise exception using errcode = '23505', message = 'this receipt has already been replaced';
  end if;
  if v_new.replaces_document_id is not null then
    raise exception using errcode = '23505', message = 'the new receipt already replaces another';
  end if;
  if v_new.counted then
    raise exception using errcode = '23514', message = 'the new receipt has already been counted';
  end if;

  update public.receipt_documents
     set replaces_document_id = p_rejected_document_id
   where id = p_new_document_id;
  -- Written last, because this is the update the notification trigger listens for.
  update public.receipt_documents
     set replaced_by_document_id = p_new_document_id,
         replacement_linked_by = v_actor.id,
         replacement_linked_at = statement_timestamp()
   where id = p_rejected_document_id;

  return jsonb_build_object('replaced', p_rejected_document_id, 'by', p_new_document_id,
                            'tracking_code', v_new.tracking_code, 'replayed', false);
end;
$$;

revoke all on function public.sarraf_receipt_replace(text, text) from public, anon;
grant execute on function public.sarraf_receipt_replace(text, text) to authenticated;

-- A SECURITY DEFINER function owned by the migration runner would ignore every tenancy policy.
-- 202608250001 moved the other 131 to a role that cannot; this one joins them.
grant create on schema public to sarraf_definer;
alter function public.sarraf_receipt_replace(text, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
