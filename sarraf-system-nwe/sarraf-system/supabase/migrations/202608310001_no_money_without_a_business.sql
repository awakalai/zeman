-- Money that belongs to no business (§ stage 4).
--
-- Every tenanted table takes its tenant_id from a default of public.sarraf_tenant(), which reads
-- auth.uid(). That is right for a signed-in person and wrong for everything else:
--
--   · a route holding the service key has no auth.uid(), so the default yields null;
--   · a trigger firing inside a SECURITY DEFINER command has no caller of its own;
--   · a maintenance connection as `postgres` has none either.
--
-- A row that lands with tenant_id null is not merely mislabelled. Every tenant policy on these
-- tables is RESTRICTIVE, so the row is invisible to the business that created it, invisible to
-- its own administrator, and invisible to the manager. It is money nobody can see: it will not
-- appear in a balance, will not appear in a report, and will not appear in the day's close —
-- but it is in the table, and a trial balance summed without a tenant filter still counts it.
--
-- The live baseline on 31 August recorded zero such rows across txs, ledger, journal_entries,
-- receipts, receipt_batches and zeman_notifications. Nothing here repairs anything; it makes
-- the zero permanent.
--
-- Two steps, in this order, because the second is only safe after the first:
--
--   1. a BEFORE INSERT trigger works the business out from the row itself — from the parent it
--      names, or from the person it is about — so a legitimate write that simply had no
--      auth.uid() to read succeeds with the right answer instead of failing;
--   2. only if that still finds nothing does it refuse, naming the table and the row, so the
--      cause is in the error rather than discovered months later in an inspection.
--
-- Nothing about the accounting changes. No amount, rate, account, side or posting rule is
-- touched, and no existing row is read or written.

begin;

-- The business behind a row, worked out from the row itself.
--
-- Each arm follows the one link that cannot be absent: a ledger line names its transaction, a
-- receipt names its batch, an entry names the transaction it accounts for. Where a row names a
-- person instead, that person's business is the row's business — the same rule sarraf_note_tenant
-- already applies to notes.
--
-- This is one trigger function and no helper. A plain SECURITY DEFINER function owned by the
-- migrating role would be a way straight through the tenancy, and the isolation gate refuses
-- one — correctly. A trigger function cannot be called by a browser at all: it is reachable only
-- by inserting into one of these six tables, where every policy still applies.
create or replace function public.sarraf_require_tenant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tenant text := new.tenant_id;
  v_people text[] := array[]::text[];
  v_person text;
begin
  if v_tenant is not null then
    return new;
  end if;

  -- The caller, when there is one. This is what the column default would have found.
  v_tenant := public.sarraf_tenant();

  if v_tenant is null then
    case tg_table_name
      when 'txs' then
        v_people := array[new.cp_id, new.partner_id];
      when 'ledger' then
        if new.tx_id is not null then
          select t.tenant_id into v_tenant from public.txs t where t.id = new.tx_id;
        end if;
        v_people := array[new.created_by, new.investor_id, new.partner_id];
      when 'journal_entries' then
        if new.transaction_id is not null then
          select t.tenant_id into v_tenant from public.txs t where t.id = new.transaction_id;
        end if;
        if v_tenant is null and new.source_type = 'transaction' and new.source_id is not null then
          select t.tenant_id into v_tenant from public.txs t where t.id = new.source_id;
        end if;
        if v_tenant is null and new.receipt_batch_id is not null then
          select b.tenant_id into v_tenant from public.receipt_batches b where b.id = new.receipt_batch_id;
        end if;
        v_people := array[new.actor_id];
      when 'receipts' then
        if new.batch_id is not null then
          select b.tenant_id into v_tenant from public.receipt_batches b where b.id = new.batch_id;
        end if;
        v_people := array[new.uploaded_by, new.customer_id];
      when 'receipt_batches' then
        v_people := array[new.uploaded_by, new.customer_id, new.partner_id];
      when 'zeman_notifications' then
        v_people := array[new.recipient_id, new.actor_id];
      else
        null;
    end case;

    if v_tenant is null then
      foreach v_person in array v_people loop
        if v_person is not null then
          select u.tenant_id into v_tenant from public.app_users u where u.id = v_person;
          exit when v_tenant is not null;
        end if;
      end loop;
    end if;
  end if;

  if v_tenant is null then
    raise exception using
      errcode = '23502',
      message = format('%s row %s belongs to no business', tg_table_name, coalesce(new.id::text, '?')),
      hint = 'A row on this table must name the business it belongs to. Nothing on the row said which.';
  end if;

  new.tenant_id := v_tenant;
  return new;
end;
$$;

comment on function public.sarraf_require_tenant() is
  'BEFORE INSERT: works the business out from the row when the writer had no auth.uid() to read, and refuses the write rather than creating money nobody can see.';

do $$
declare t text;
begin
  foreach t in array array[
    'txs', 'ledger', 'journal_entries', 'receipts', 'receipt_batches', 'zeman_notifications'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_require_tenant', t);
    execute format(
      'create trigger %I before insert on public.%I for each row execute function public.sarraf_require_tenant()',
      t || '_require_tenant', t);
  end loop;
end $$;

-- Deliberately NOT handed to sarraf_definer.
--
-- sarraf_definer is nobypassrls, which is the whole point of it: the restrictive tenant policies
-- bind it, so a command run on somebody's behalf reaches only the rows their business may see.
-- That is exactly wrong here. This trigger runs when there is no session at all, and it has to
-- read app_users to find out whose row this is — a read the restrictive policy would return
-- nothing for, leaving the trigger to refuse a write that was perfectly legitimate.
--
-- So it stays owned by the role the migration runs as, which bypasses row level security and can
-- answer "which business does this person belong to" with no session to read. The same
-- arrangement sarraf_note_tenant already uses for the same lookup. It is safe for the reason the
-- isolation gate relies on: a trigger function is not callable by anybody. There is no grant that
-- reaches it, and the only way to run it is to insert into one of these six tables — where every
-- policy still applies.

revoke all on function public.sarraf_require_tenant() from public, anon, authenticated;

commit;
