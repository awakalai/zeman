-- Records that belong to no business (§ stage 7).
--
-- The live baseline on 31 August found tenant_id null on 487 receipt_state_transitions, 101
-- receipt_ocr_attempts, 79 receipt_extractions, 21 system_event_log, 19 notes and 11 audit rows.
-- Every one of those tables carries a RESTRICTIVE tenant policy, so a row with no tenant is
-- invisible to everybody — including the business whose receipt it describes.
--
-- That matters most on receipt_state_transitions. It is the receipt's own story: who sent it,
-- who looked at it, what they decided and when. 487 of those steps could not be read by anyone,
-- which is why some receipts show an empty history.
--
-- All six rows carry the same stamp, 29 August 22:47:15.831684, to the microsecond — they were
-- not written by anybody working. That is the moment 202608240002 added the tenant column, and
-- these are the rows that existed before it.
--
-- This migration does two separate things, and is careful about which table gets which.
--
-- ── What it repairs ──────────────────────────────────────────────────────────────────────────
--
-- Only two of the six tables can be repaired: receipt_state_transitions and notes. The other
-- four — audit, receipt_extractions, receipt_ocr_attempts, system_event_log — each carry an
-- append-only guard, and those guards are correct. Lifting four immutability guards on a live
-- financial database to relabel historical log rows is a larger risk than the rows themselves
-- pose, and the rule is that history is never rewritten to make a report look tidier. Those 212
-- rows stay as they are, recorded in BASELINE.md as residue from before the column existed.
--
-- The repair derives; it never guesses. A transition takes the business of the document it
-- describes; a note takes the business of the batch or transaction it points at. A row whose
-- parent cannot be found is left exactly as it is rather than assigned to somebody.
--
-- ── What it prevents ─────────────────────────────────────────────────────────────────────────
--
-- The same BEFORE INSERT trigger 202608310001 put on the six financial tables, extended to
-- these six — but in a softer mode, and deliberately. On a transaction or a ledger line a row
-- with no business is refused, because writing money nobody can see is worse than failing. On a
-- log it is not: a trigger that can veto a payment because it could not label the audit entry
-- would turn a record-keeping problem into an outage. So here the trigger works the business out
-- and, if nothing on the row points anywhere at all, lets the row through rather than taking the
-- operation down with it. INSPECT reports any that get through.
--
-- No accounting is touched. No amount, rate, account, side or posting rule is read or changed.

begin;

-- Soft mode: derive, and let the row through if there is genuinely nothing to derive from.
create or replace function public.sarraf_note_tenant()
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

  v_tenant := public.sarraf_tenant();

  if v_tenant is null then
    case tg_table_name
      when 'notes' then
        -- The recipient, when there is one. A note addressed to nobody in particular is
        -- addressed to the administration of one business, and says which through ref_id.
        v_people := array[new.user_id];
        if new.ref_id is not null then
          select b.tenant_id into v_tenant from public.receipt_batches b where b.id = new.ref_id;
          if v_tenant is null then
            select t.tenant_id into v_tenant from public.txs t where t.id = new.ref_id;
          end if;
        end if;
      when 'audit' then
        v_people := array[new.user_id];
      when 'system_event_log' then
        v_people := array[new.actor_id];
        if new.entity_id is not null then
          case new.entity_table
            when 'txs' then select t.tenant_id into v_tenant from public.txs t where t.id = new.entity_id;
            when 'receipt_batches' then select b.tenant_id into v_tenant from public.receipt_batches b where b.id = new.entity_id;
            when 'receipt_documents' then select d.tenant_id into v_tenant from public.receipt_documents d where d.id = new.entity_id;
            when 'app_users' then select u.tenant_id into v_tenant from public.app_users u where u.id = new.entity_id;
            else null;
          end case;
        end if;
      when 'receipt_state_transitions' then
        select d.tenant_id into v_tenant from public.receipt_documents d where d.id = new.document_id;
        v_people := array[new.actor_id];
      when 'receipt_extractions' then
        select d.tenant_id into v_tenant from public.receipt_documents d where d.id = new.document_id;
        v_people := array[new.corrected_by];
      when 'receipt_ocr_attempts' then
        select d.tenant_id into v_tenant from public.receipt_documents d where d.id = new.document_id;
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

  -- Soft: a log that could veto the operation it is logging would be worse than an unlabelled
  -- log. INSPECT reports whatever gets through.
  new.tenant_id := v_tenant;
  return new;
end;
$$;

comment on function public.sarraf_note_tenant() is
  'BEFORE INSERT on the record-keeping tables: works the business out from the row when there was no session to read it from, and lets the row through rather than failing the operation it is recording.';

do $$
declare t text;
begin
  foreach t in array array[
    'notes', 'audit', 'system_event_log',
    'receipt_state_transitions', 'receipt_extractions', 'receipt_ocr_attempts'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_tenant', t);
    execute format(
      'create trigger %I before insert on public.%I for each row execute function public.sarraf_note_tenant()',
      t || '_tenant', t);
  end loop;
end $$;

-- ── The repair, on the two tables that carry no immutability guard ───────────────────────────
--
-- Derivation only. A row whose parent cannot be found keeps its null; nothing is assigned to a
-- business on a guess. Both statements are idempotent: run twice, the second changes nothing.
do $$
declare v_transitions bigint; v_notes bigint;
begin
  update public.receipt_state_transitions s
     set tenant_id = d.tenant_id
    from public.receipt_documents d
   where d.id = s.document_id
     and s.tenant_id is null
     and d.tenant_id is not null;
  get diagnostics v_transitions = row_count;

  update public.notes n
     set tenant_id = coalesce(
       (select u.tenant_id from public.app_users u where u.id = n.user_id),
       (select b.tenant_id from public.receipt_batches b where b.id = n.ref_id),
       (select t.tenant_id from public.txs t where t.id = n.ref_id))
   where n.tenant_id is null
     and coalesce(
       (select u.tenant_id from public.app_users u where u.id = n.user_id),
       (select b.tenant_id from public.receipt_batches b where b.id = n.ref_id),
       (select t.tenant_id from public.txs t where t.id = n.ref_id)) is not null;
  get diagnostics v_notes = row_count;

  raise notice 'gave a business to % receipt state transition(s) and % note(s)', v_transitions, v_notes;
end $$;

commit;
