-- The refusal nobody was told about.
--
-- A receipt can be refused in two places, and only one of them says so.
--
--   in review        سەرخێڵ opens it and rejects it. receipt_documents.state becomes
--                    'rejected', the reason is written on it, and — since 202608280010 — the
--                    person who sent it is told, and the re-upload button appears.
--
--   at the door      sarraf_ingest_receipt_batch refuses the row as it is being sent: no
--                    verdict from the browser, a currency that is not the batch's, a fee larger
--                    than the amount, an amount it cannot store. It writes a receipt_intake_item
--                    marked rejected with the rule that refused it, and an audit event — and
--                    leaves receipt_documents exactly as it found it.
--
-- The second is by far the more common: the live database has two batches from this morning,
-- three refusals in one and four in the other, seven receipts refused at the door — and every
-- one of those documents still reads `validated`. So the uploader's own screen calls them
-- «چاوەڕوانی پشکنین», nobody is told anything, and «بارکردنەوەی فیشی نوێ» never appears on the
-- receipts that need it most. A refusal the refused person cannot see is not a refusal, it is a
-- disappearance.
--
-- Written as a trigger on the intake item rather than inside the ingestion command, for the same
-- reason the tracking code is a trigger: the command is 260 lines that took a week to get right,
-- and there is more than one way a rejected intake item comes to exist. The item is the record
-- of the refusal; this simply carries it across to the document.
--
-- Two things it will not do. It never moves a document that cannot legally reach `rejected` —
-- one still at `created` or `uploading` was never read, and a refusal notice about an image that
-- never arrived explains nothing. And it never takes a send down with it: the send is the job.
begin;

create or replace function public.sarraf_refusal_reaches_the_document()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_state public.receipt_state;
  v_reason text := left(coalesce(nullif(btrim(new.rule_reason), ''),
                                 'فیشەکە لە کاتی ناردندا ڕەت کرایەوە'), 700);
  v_code text := left(coalesce(nullif(btrim(new.rule_code), ''), 'refused_on_send'), 80);
begin
  if new.intake_status <> 'rejected' then return null; end if;
  begin
    select state into v_state from public.receipt_documents where id = new.id for update;
    if not found or v_state = 'rejected' then return null; end if;

    -- `parsed`, `uploaded` and the retryable failures cannot reach `rejected` in one step; the
    -- state machine sends them through review first, which is what a person doing this by hand
    -- would do too.
    if not public.receipt_transition_allowed(v_state, 'rejected')
       and public.receipt_transition_allowed(v_state, 'needs_manual_review') then
      update public.receipt_documents
         set state = 'needs_manual_review', counted = false
       where id = new.id;
      v_state := 'needs_manual_review';
    end if;

    if public.receipt_transition_allowed(v_state, 'rejected') then
      update public.receipt_documents
         set state = 'rejected', counted = false, rule_code = v_code, rule_reason = v_reason
       where id = new.id;
    end if;
  exception when others then
    -- The receipts are sent either way. This is the telling, not the sending.
    raise warning 'receipt % was refused but its document could not be marked: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists receipt_intake_items_refusal on public.receipt_intake_items;
create trigger receipt_intake_items_refusal
  after insert on public.receipt_intake_items
  for each row execute function public.sarraf_refusal_reaches_the_document();

-- The seven from this morning, and anything else already refused at the door and never told.
-- Two passes, because the state machine will not jump: review first, then refused.
update public.receipt_documents d
   set state = 'needs_manual_review', counted = false
  from public.receipt_intake_items i
 where i.id = d.id
   and i.intake_status = 'rejected'
   and d.state <> 'rejected'
   and not public.receipt_transition_allowed(d.state, 'rejected')
   and public.receipt_transition_allowed(d.state, 'needs_manual_review');

update public.receipt_documents d
   set state = 'rejected', counted = false,
       rule_code = left(coalesce(nullif(btrim(i.rule_code), ''), 'refused_on_send'), 80),
       rule_reason = left(coalesce(nullif(btrim(i.rule_reason), ''),
                                   'فیشەکە لە کاتی ناردندا ڕەت کرایەوە'), 700)
  from public.receipt_intake_items i
 where i.id = d.id
   and i.intake_status = 'rejected'
   and d.state <> 'rejected'
   and public.receipt_transition_allowed(d.state, 'rejected');

commit;
