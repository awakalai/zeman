-- Suspending a business did nothing at all (§ stage 11).
--
-- sarraf_manager_set_tenant_active writes `tenants.active`, records an audit line, and returns.
-- Nothing anywhere reads that column except the console that displays it. A business suspended
-- for not paying went on trading exactly as before: new transactions, new ledger rows, new
-- receipts, all accepted.
--
-- For a system that is going to be sold, that is the one commercial control the vendor has, and
-- it was a label.
--
-- ── What suspension means here ───────────────────────────────────────────────────────────────
--
-- Read-only, not locked out. A business's ledger is the record of their own money, and taking
-- it away over an unpaid invoice is not a thing this system will do. So a suspended business:
--
--   · signs in as before;
--   · reads everything it could read before, and can export it;
--   · cannot open a new transaction, write a ledger line, post a journal entry, take in a
--     receipt, or open a batch.
--
-- That is "cannot trade" without being "cannot see your own books".
--
-- ── Where it is enforced ─────────────────────────────────────────────────────────────────────
--
-- On the tables, not in the commands. A check in the command layer is a check every future
-- command has to remember; a trigger on the six tables money actually lands in is one that
-- cannot be forgotten, and it holds for the service key as well — which matters, because two of
-- the API routes write through it with row level security switched off.
--
-- INSERT only, deliberately. Blocking updates too would stop a suspended business from closing
-- out what it already has open, and there is no reason to trap them mid-transaction. New money
-- is what stops.

begin;

-- One trigger function and no helper, for the reason 202608310001 gives at length: a plain
-- SECURITY DEFINER function owned by the migrating role is a way straight through the tenancy,
-- and the isolation gate refuses one. A helper owned by sarraf_definer instead would be worse
-- here than useless — it is nobypassrls, so on a service-key write with no session it would read
-- no tenants row at all, find nothing, and let every suspended business trade.
--
-- A trigger function is reachable only by inserting into one of these six tables, where every
-- policy still applies.
create or replace function public.sarraf_refuse_when_suspended()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_active boolean;
begin
  -- sarraf_require_tenant runs first and has already worked the business out, so by here
  -- new.tenant_id is whatever this row is going to belong to.
  if new.tenant_id is null then
    return new;
  end if;
  -- A business that is not there is not a suspended business; it is refused by
  -- sarraf_require_tenant for its own reasons, and answering false here would only confuse
  -- the message.
  select t.active into v_active from public.tenants t where t.id = new.tenant_id;
  if not coalesce(v_active, true) then
    raise exception using
      errcode = '42501',
      message = 'ئەم بازرگانییە ڕاگیراوە — دەتوانرێت بخوێندرێتەوە، بەڵام مامەڵەی نوێ ناکرێت',
      hint = 'A suspended business keeps every right to read and export its own books. Resume it from the manager console to trade again.';
  end if;
  return new;
end;
$$;

comment on function public.sarraf_refuse_when_suspended() is
  'BEFORE INSERT on the tables money lands in: a suspended business may read everything and start nothing.';

-- The name matters: triggers fire in alphabetical order, and this one must run after
-- <table>_require_tenant has resolved the business it is about to judge.
do $$
declare t text;
begin
  foreach t in array array[
    'txs', 'ledger', 'journal_entries', 'receipts', 'receipt_batches', 'receipt_documents'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_suspended', t);
    execute format(
      'create trigger %I before insert on public.%I for each row execute function public.sarraf_refuse_when_suspended()',
      t || '_suspended', t);
  end loop;
end $$;

revoke all on function public.sarraf_refuse_when_suspended() from public, anon, authenticated;

commit;
