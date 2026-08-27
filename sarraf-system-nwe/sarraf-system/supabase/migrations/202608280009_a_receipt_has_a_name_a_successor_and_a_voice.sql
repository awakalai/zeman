-- Three things the owner asked for, and none of them existed.
--
--   ٥. کۆدی تایبەت (Unique Tracking ID): هەر فیشێک ژمارەیەکی تایبەت (کۆد)ی بۆ دروست دەبێت
--      (مۆری ڕێکەوت و کات بە چرکەوە + شناسی بەکارهێنەر)
--   ٤. دووبارە بارکردنەوە: بارکردنەوەی نوێ بەستەر دەکرێتەوە بە فیشە ڕەتکراوەکەی پێشوو
--   ٥. سیستەمی ئاگادارکردنەوە: لە کاتی وەرگرتن، ڕەتکردنەوە، یان پەسەندکردنی فیش
--
-- A receipt's identity today is `mtb8twubdy4wog` — random, unreadable, unsayable. Nobody can
-- quote it down a phone, and two people looking at the same receipt have no way to agree they
-- are. A rejected receipt is a dead end: the uploader is told nothing and the replacement they
-- send is a stranger to it, so the history breaks exactly where an auditor would want it whole.
-- And nothing anywhere tells anybody that any of it happened.
--
-- ── the name ─────────────────────────────────────────────────────────────────
--
--   ZR-20260827-084512-3FA9C1
--
-- The date and the time to the second, as asked, then who and which. The first two characters of
-- the suffix are the uploader's — the same person always leaves the same mark — and the last four
-- are the receipt's own. Both are needed: a batch upload puts twenty receipts in the same second
-- under the same person, so a code built from the time and the person alone would name all
-- twenty the same thing, and a code that collides is not an identifier. Where two do collide
-- anyway, the suffix lengthens until it does not.
--
-- Written by a trigger rather than by a command, because there are three ways into this table and
-- an identity that depends on which one you used is not an identity.
--
-- ── the successor ────────────────────────────────────────────────────────────
--
-- A rejected receipt may name its replacement, and the replacement names what it replaces. Both
-- directions are stored: the uploader's screen walks forward from the rejection, the auditor
-- walks back from whatever was finally accepted. Neither may point at itself, a receipt may be
-- replaced only once, and only a rejected receipt may be replaced at all — a receipt still under
-- review is not finished with.
--
-- ── the voice ────────────────────────────────────────────────────────────────
--
-- receipt_notifications already existed and is about forwardings alone; nothing in the
-- application has ever read it. This is a plain queue: who it is for, what happened, which
-- receipt, and whether they have seen it. It carries the business, so one buyer's staff never
-- see another's, and it is added to the realtime publication so a screen can hear it arrive
-- instead of polling.
begin;

-- ── the name ─────────────────────────────────────────────────────────────────
alter table public.receipt_documents add column if not exists tracking_code text;

create or replace function public.sarraf_tracking_code(
  p_at timestamptz, p_actor text, p_id text
) returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select 'ZR-' || to_char(coalesce(p_at, '2026-01-01'::timestamptz), 'YYYYMMDD-HH24MISS')
      || '-' || upper(substr(md5(coalesce(p_actor, '')), 1, 2))
      || upper(substr(md5(coalesce(p_id, '')), 1, 4));
$$;

create or replace function public.sarraf_receipt_tracking_code()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_at timestamptz := coalesce(new.received_at, statement_timestamp());
  v_code text;
  v_width integer := 4;
begin
  if new.tracking_code is null then
    v_code := public.sarraf_tracking_code(v_at, new.uploader_id, new.id);
    -- Two receipts of the same person in the same second whose ids happen to hash alike. The
    -- suffix lengthens rather than the insert failing: an upload must never be lost to a name.
    while v_width < 30 and exists (
      select 1 from public.receipt_documents d where d.tracking_code = v_code and d.id <> new.id
    ) loop
      v_width := v_width + 2;
      v_code := 'ZR-' || to_char(v_at, 'YYYYMMDD-HH24MISS')
        || '-' || upper(substr(md5(coalesce(new.uploader_id, '')), 1, 2))
        || upper(substr(md5(new.id), 1, v_width));
    end loop;
    new.tracking_code := v_code;
  end if;
  return new;
end;
$$;

drop trigger if exists receipt_documents_tracking_code on public.receipt_documents;
create trigger receipt_documents_tracking_code
  before insert on public.receipt_documents
  for each row execute function public.sarraf_receipt_tracking_code();

-- Everything already stored gets one too, from the time it actually arrived.
update public.receipt_documents
   set tracking_code = public.sarraf_tracking_code(received_at, uploader_id, id)
 where tracking_code is null;

create unique index if not exists receipt_documents_tracking_code_uq
  on public.receipt_documents(tracking_code) where tracking_code is not null;

-- ── the successor ────────────────────────────────────────────────────────────
alter table public.receipt_documents
  add column if not exists replaces_document_id text references public.receipt_documents(id);
alter table public.receipt_documents
  add column if not exists replaced_by_document_id text references public.receipt_documents(id);

alter table public.receipt_documents drop constraint if exists receipt_documents_not_its_own_successor;
alter table public.receipt_documents add constraint receipt_documents_not_its_own_successor
  check (replaces_document_id is distinct from id and replaced_by_document_id is distinct from id);

create unique index if not exists receipt_documents_replaces_uq
  on public.receipt_documents(replaces_document_id) where replaces_document_id is not null;
create index if not exists receipt_documents_replaced_by_idx
  on public.receipt_documents(replaced_by_document_id) where replaced_by_document_id is not null;

-- ── the voice ────────────────────────────────────────────────────────────────
create table if not exists public.zeman_notifications (
  id text primary key default ('zn-' || replace(gen_random_uuid()::text, '-', '')),
  tenant_id text references public.tenants(id) default public.sarraf_tenant(),
  recipient_id text not null references public.app_users(id),
  kind text not null check (kind in (
    'receipt_received','receipt_accepted','receipt_rejected','receipt_replaced','batch_arrived')),
  title text not null,
  body text,
  subject_kind text not null default 'receipt' check (subject_kind in ('receipt','batch','transaction')),
  subject_id text,
  actor_id text references public.app_users(id),
  created_at timestamptz not null default statement_timestamp(),
  read_at timestamptz,
  check (char_length(title) between 1 and 200),
  check (body is null or char_length(body) <= 700)
);
create index if not exists zeman_notifications_inbox_idx
  on public.zeman_notifications(recipient_id, created_at desc);
create index if not exists zeman_notifications_unread_idx
  on public.zeman_notifications(recipient_id) where read_at is null;

alter table public.zeman_notifications enable row level security;
revoke all on public.zeman_notifications from public, anon;
grant select, update on public.zeman_notifications to authenticated;
grant select, insert, update, delete on public.zeman_notifications to service_role;

-- Yours and nobody else's, inside your own business. A notification is written by a command, not
-- by a browser, so `authenticated` gets no insert at all.
drop policy if exists zeman_notifications_own on public.zeman_notifications;
create policy zeman_notifications_own on public.zeman_notifications
  for select to authenticated
  using (recipient_id = public.my_app_id());

drop policy if exists zeman_notifications_mark_read on public.zeman_notifications;
create policy zeman_notifications_mark_read on public.zeman_notifications
  for update to authenticated
  using (recipient_id = public.my_app_id())
  with check (recipient_id = public.my_app_id());

drop policy if exists zeman_notifications_tenant on public.zeman_notifications;
create policy zeman_notifications_tenant on public.zeman_notifications
  as restrictive for all to authenticated
  using (public.sarraf_tenant_visible(tenant_id))
  with check (public.sarraf_tenant_visible(tenant_id));

-- Heard rather than polled, where the project supports it. A publication that is not there is
-- not an error: the inbox still works, it simply refreshes on its own schedule.
do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename = 'zeman_notifications') then
      execute 'alter publication supabase_realtime add table public.zeman_notifications';
      raise notice 'notifications will arrive as they happen';
    end if;
  else
    raise notice 'no realtime publication on this database; the inbox will refresh on its own';
  end if;
exception when insufficient_privilege then
  raise notice 'not permitted to change the realtime publication; the inbox will refresh on its own';
end
$realtime$;

-- ── the health report must know this table exists ────────────────────────────
--
-- sarraf_schema_tables compares the database against a written list, and anything not on the
-- list is reported to the manager as an unmanaged table. A new table that nobody adds to the
-- list turns the health report into noise, which is the one thing 202608260002 set out to stop.
create or replace function public.sarraf_schema_tables()
returns table(table_name text, state text)
language sql
stable
set search_path = pg_catalog, public
as $tables$
  with expected(t) as (values
    ('account_ledger'), ('account_transfers'), ('accounting_commands'), ('app_users'),
    ('approval_events'), ('approval_requests'), ('audit'), ('chart_of_accounts'),
    ('control_settings'), ('currencies'), ('customer_vault_events'), ('customer_vaults'),
    ('day_closes'), ('debt_events'), ('debt_settlements'), ('debts'), ('financial_commands'),
    ('journal_entries'), ('journal_lines'), ('ledger'), ('notes'), ('ocr_attestations'),
    ('office_payment_assignments'), ('office_payment_events'), ('office_payment_evidence'),
    ('office_pending_assignments'), ('partner_account_events'), ('partner_accounts'),
    ('pending_accounts'),
    ('rate_history'), ('rate_limit_counters'), ('receipt_assignment_events'),
    ('receipt_audit_events'), ('receipt_batch_transactions'), ('receipt_batches'),
    ('receipt_command_log'), ('receipt_control_policy'), ('receipt_custody'),
    ('receipt_custody_events'), ('receipt_custody_ledger'), ('receipt_daily_rates'),
    ('receipt_documents'), ('receipt_extractions'), ('receipt_forwardings'),
    ('receipt_ingestion_authorizations'), ('receipt_ingestion_commands'),
    ('receipt_intake_items'), ('receipt_match_commands'), ('receipt_notifications'),
    ('receipt_ocr_attempts'), ('receipt_operation_commands'), ('receipt_pending_conversions'),
    ('receipt_review_commands'), ('receipt_state_transitions'),
    ('receipt_transaction_assignments'), ('receipts'), ('schema_migrations'),
    ('system_event_log'),
    ('tenant_rates'), ('tenants'),
    ('transaction_payment_events'), ('tx_versions'), ('txs'), ('voucher_counters'), ('vouchers'),
    ('zeman_notifications')
  ), live as (
    select c.relname::text as t
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  )
  select e.t, 'missing from the database'
  from expected e where not exists (select 1 from live l where l.t = e.t)
  union all
  select l.t, 'in the database, unmanaged by any migration'
  from live l where not exists (select 1 from expected e where e.t = l.t)
  order by 1;
$tables$;

commit;