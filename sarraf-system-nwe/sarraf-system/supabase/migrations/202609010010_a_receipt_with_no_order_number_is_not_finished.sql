-- فیشێک کە ژمارەی داواکاری نییە، تەواو نەبووە (§10.1).
--
-- The owner's rule: Order No. is the principal operational reference, and a receipt that truly
-- has no Order No. must not become accepted, matched, converted to a transaction, forwarded as
-- valid, or counted in any total. The image and its metadata are kept for audit; what is refused
-- is calling it finished.
--
-- ── Which column is the Order No., because the names mislead ─────────────────────────────────
--
-- api/read-receipt.js is explicit, and it is the reverse of what the column names suggest:
--
--   23. refNo MUST come from "Order No." when visible.
--   24. merchantOrderNo MUST come from "Merchant order No." when visible. Never swap these two.
--
-- So receipt_extractions.ref_no IS the Order No. merchant_order_no is a separate, secondary
-- merchant identifier. An earlier draft of this work had them the wrong way round and would have
-- required the wrong field.
--
-- ── The gap this closes ──────────────────────────────────────────────────────────────────────
--
-- The accept path in 202608140001 refuses only when BOTH identifiers are absent:
--
--     or coalesce(v_current.ref_no, v_current.merchant_order_no) is null
--
-- so a receipt carrying a merchant order number and no Order No. is accepted today.
--
-- ── Why a trigger and not an edit to that function ───────────────────────────────────────────
--
-- sarraf_receipt_review is a long financial command. Re-declaring it to add one condition means
-- copying two hundred lines that are already correct, and every line copied is a line that can
-- be copied wrong. A trigger on the state column is additive, and it is also stronger: it holds
-- for every path that moves a receipt forward, including any added later, not only the one
-- command that exists today.
--
-- ── Safe against history ─────────────────────────────────────────────────────────────────────
--
-- It fires only when the state actually changes, so receipts already accepted are untouched and
-- no existing row is re-judged. Nothing is deleted, nothing is rewritten. What it refuses is a
-- new transition into a finished state without an Order No.

begin;

-- The states that mean "this receipt counts". Anything here is a receipt the business is
-- treating as real, and §10.1 names each of them.
create or replace function public.sarraf_receipt_needs_order_no()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $fn$
declare v_order_no text;
begin
  if new.state not in ('matched', 'accepted', 'finalized', 'forwarded', 'delivered') then
    return new;
  end if;
  -- Only a real move forward is judged. An update that rewrites other columns, or re-states the
  -- state it already had, leaves an already-accepted receipt alone.
  if tg_op = 'UPDATE' and old.state is not distinct from new.state then
    return new;
  end if;

  -- The newest correction wins, which is what makes the Needs Review path work: an administrator
  -- enters the Order No. a machine could not read, and the receipt may then go forward.
  select nullif(btrim(coalesce(e.ref_no, '')), '')
    into v_order_no
    from public.receipt_extractions e
   where e.document_id = new.id
   order by e.version desc
   limit 1;

  if v_order_no is null then
    raise exception using errcode = '23514', message = 'Order No. is required.',
      detail = format('receipt %s has no Order No. on its newest reading', new.id),
      hint = 'Send it to review and enter the Order No. from the image.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists sarraf_receipt_order_no_required on public.receipt_documents;
create trigger sarraf_receipt_order_no_required
  before insert or update of state on public.receipt_documents
  for each row execute function public.sarraf_receipt_needs_order_no();

-- A trigger function is run by the trigger mechanism, which checks EXECUTE when the trigger is
-- created and never when it fires. A grant on one is surface with nothing behind it.
revoke all on function public.sarraf_receipt_needs_order_no() from public, anon, authenticated;

comment on function public.sarraf_receipt_needs_order_no() is
  'Refuses a receipt into a finished state without an Order No. (receipt_extractions.ref_no, '
  'which is "Order No." on the source image — merchant_order_no is a different identifier).';

commit;
