-- The name on both sides of the receipt, the link a re-upload needs, and the voice that says
-- any of it happened.
--
-- 202608280009 gave the intake document a tracking code, two columns for a replacement chain,
-- and an empty inbox. None of it is reachable yet: the owner's screen reads `public.receipts`,
-- which has no code; nothing links a re-upload to what it replaces; and no line of code
-- anywhere writes a notification.
--
-- ── one receipt, one name, on whichever table you are looking at ──────────────
--
-- `public.receipts.id` and `public.receipt_documents.id` are the same string — the browser
-- mints one id and uses it for the document, for the storage object and for the row it sends.
-- Nothing in the schema said so, so `receipts.document_id`, added in 202608220001 for exactly
-- this, has stayed null on every row this installation has ever written. The trigger below
-- states it, and takes the document's tracking code rather than minting a second one, so the
-- customer reading their upload and the owner reading their queue quote the same code.
--
-- A receipt typed by hand has no document. It still gets a name.
--
-- ── the voice ────────────────────────────────────────────────────────────────
--
-- Every notification is written by a trigger, and for one reason: the recipients are other
-- people. When a customer presses send, the people who must hear about it are that business's
-- staff — rows the customer's own request may not read. A command running with the customer's
-- own visibility would resolve an empty list of recipients and write nothing at all, quietly,
-- which is the exact shape of failure this whole week has been spent removing. So the emitters
-- run as the table owner. That is only safe because they are triggers and nothing else: a
-- trigger has no name a request can call, it sees exactly one row, and it derives the business
-- from that row rather than from who asked. Nothing here is a callable function, so nothing
-- here widens what a request can reach — which is why the tenancy gate exempts trigger
-- functions and why these must stay triggers.
--
-- And a notification that cannot be written must never take the receipt down with it. Each
-- emitter swallows its own failure and raises a warning instead. Sending money is the job;
-- telling somebody about it is a courtesy.
begin;

-- ── the name, on the owner's side ────────────────────────────────────────────
alter table public.receipts add column if not exists tracking_code text;

create or replace function public.sarraf_receipts_tracking_code()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_doc public.receipt_documents%rowtype;
  v_at timestamptz := coalesce(new.created_at, statement_timestamp());
  v_code text;
  v_width integer := 4;
begin
  select * into v_doc from public.receipt_documents where id = new.id;
  if found then
    if new.document_id is null then new.document_id := v_doc.id; end if;
    if new.tracking_code is null then new.tracking_code := v_doc.tracking_code; end if;
  end if;
  if new.tracking_code is null then
    v_code := public.sarraf_tracking_code(v_at, new.uploaded_by, new.id);
    while v_width < 30 and exists (
      select 1 from public.receipts r where r.tracking_code = v_code and r.id <> new.id
    ) loop
      v_width := v_width + 2;
      v_code := 'ZR-' || to_char(v_at, 'YYYYMMDD-HH24MISS')
        || '-' || upper(substr(md5(coalesce(new.uploaded_by, '')), 1, 2))
        || upper(substr(md5(new.id), 1, v_width));
    end loop;
    new.tracking_code := v_code;
  end if;
  return new;
end;
$$;

drop trigger if exists receipts_tracking_code on public.receipts;
create trigger receipts_tracking_code
  before insert on public.receipts
  for each row execute function public.sarraf_receipts_tracking_code();

-- What is already stored: the document's own code where there is a document, the receipt's own
-- arrival where there is not. The link is stated at the same time.
update public.receipts r
   set document_id = d.id,
       tracking_code = coalesce(r.tracking_code, d.tracking_code)
  from public.receipt_documents d
 where d.id = r.id and (r.document_id is null or r.tracking_code is null);

update public.receipts
   set tracking_code = public.sarraf_tracking_code(created_at, uploaded_by, id)
 where tracking_code is null;

create unique index if not exists receipts_tracking_code_uq
  on public.receipts(tracking_code) where tracking_code is not null;

comment on column public.receipts.tracking_code is
  'The receipt''s human-quotable name, shared with its intake document. ZR-date-time-suffix.';

-- ── the receipt was accepted, rejected, or replaced ──────────────────────────
create or replace function public.sarraf_receipt_document_speaks()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text := public.my_app_id();
  v_name text := coalesce(new.tracking_code, new.id);
  v_kind text;
  v_title text;
  v_body text;
begin
  begin
    if new.state = 'accepted' and old.state is distinct from 'accepted' then
      v_kind := 'receipt_accepted';
      v_title := 'فیشەکەت پەسەند کرا · ' || v_name;
      v_body := 'فیشی ' || v_name || ' پشکنین کرا و پەسەند کرا.';
    elsif new.state = 'rejected' and old.state is distinct from 'rejected' then
      v_kind := 'receipt_rejected';
      v_title := 'فیشەکەت ڕەت کرایەوە · ' || v_name;
      v_body := coalesce(nullif(btrim(new.rule_reason), ''), 'هۆکارێک تۆمار نەکراوە')
        || ' — دەتوانیت فیشێکی نوێ لە جێگەی بار بکەیت.';
    end if;

    -- The person who sent it, and the customer it was sent for when that is somebody else.
    if v_kind is not null then
      insert into public.zeman_notifications(
        tenant_id, recipient_id, kind, title, body, subject_kind, subject_id, actor_id)
      select new.tenant_id, u.id, v_kind, left(v_title, 200), left(v_body, 700),
             'receipt', new.id, v_actor
        from public.app_users u
       where u.id in (new.uploader_id, new.customer_id)
         and not u.deleted;
    end if;

    -- A replacement was linked to this rejection: the business is the side that must know.
    if new.replaced_by_document_id is not null and old.replaced_by_document_id is null then
      insert into public.zeman_notifications(
        tenant_id, recipient_id, kind, title, body, subject_kind, subject_id, actor_id)
      select new.tenant_id, u.id, 'receipt_replaced',
             left('فیشێکی نوێ لە جێگەی فیشی ڕەتکراو · ' || v_name, 200),
             left('فیشی ' || v_name || ' بە فیشێکی نوێ گۆڕدرا و چاوەڕێی پشکنینە.', 700),
             'receipt', new.replaced_by_document_id, v_actor
        from public.app_users u
       where u.role in ('admin', 'office')
         and not u.deleted
         and u.id is distinct from v_actor
         and (new.tenant_id is null or u.tenant_id = new.tenant_id);
    end if;
  exception when others then
    -- The receipt matters; telling somebody about it does not matter as much as the receipt.
    raise warning 'receipt % changed but nobody could be told: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists receipt_documents_speaks on public.receipt_documents;
create trigger receipt_documents_speaks
  after update on public.receipt_documents
  for each row execute function public.sarraf_receipt_document_speaks();

-- ── a batch of receipts has reached the business ─────────────────────────────
--
-- sarraf_ingest_receipt_batch opens the batch at `reading` and closes it, in the same
-- transaction, at `verified` or `rejected` once every row has been counted. That closing update
-- is the moment the receipts exist for the business, so it is the moment to say so — once for
-- the batch, not once per image.
create or replace function public.sarraf_receipt_batch_arrives()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tenant text;
  v_who text;
begin
  begin
    if old.receipt_stage = 'reading' and new.receipt_stage is distinct from 'reading' then
      v_tenant := coalesce(new.tenant_id,
        (select tenant_id from public.app_users where id = new.uploaded_by));
      v_who := coalesce(nullif(btrim(new.customer_name), ''),
        (select name from public.app_users where id = new.uploaded_by), 'کڕیارێک');
      insert into public.zeman_notifications(
        tenant_id, recipient_id, kind, title, body, subject_kind, subject_id, actor_id)
      select v_tenant, u.id, 'batch_arrived',
             left(v_who || ' ' || coalesce(new.n, 0)::text || ' فیشی نارد', 200),
             left(case when coalesce(new.rejected_n, 0) > 0
                       then coalesce(new.rejected_n, 0)::text || ' لەوانە ڕەت کرانەوە پێش گەیشتن.'
                       else 'هەموویان چاوەڕێی پشکنینن.' end, 700),
             'batch', new.id, new.uploaded_by
        from public.app_users u
       where u.role in ('admin', 'office')
         and not u.deleted
         and u.id is distinct from new.uploaded_by
         and (v_tenant is null or u.tenant_id = v_tenant);
    end if;
  exception when others then
    raise warning 'batch % arrived but nobody could be told: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists receipt_batches_arrives on public.receipt_batches;
create trigger receipt_batches_arrives
  after update on public.receipt_batches
  for each row execute function public.sarraf_receipt_batch_arrives();

commit;
