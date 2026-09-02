-- ناردنی بە کۆمەڵی فیشەکان — سێرڤەر بڕیار دەدات کام فیش دەردەچێت (§11).
--
--   «ئەو فیشانەی لە ئەکاونتی مشتەرییەکاندا هەیە... پێویستە بتوانرێت بە کۆمەڵ بۆ نمونە تا ١٠٠
--    دانە بەیەکەوە فۆرۆرد بکرێت و بنێررێت بۆ واتس ئەپ.»
--
-- ── The part a browser must not be trusted with ──────────────────────────────────────────────
--
-- src/services/receiptBundle.js already knows how to make the package: a store-only ZIP, a
-- manifest, safe file names, a size ceiling. What it does not do — deliberately, and it says so
-- in its own opening lines — is decide WHICH receipts go in. That decision arrives as a list of
-- document ids from a browser, and a list from a browser is a request, not an authorization.
--
-- A hundred ids is also exactly the shape of request where a per-row check quietly stops
-- happening: it is tempting to check the first one, or to check the customer once and then trust
-- the rest of the list. So the check is written the only way that cannot drift — as a WHERE
-- clause the rows have to satisfy to be returned at all. An id the subject may not have is not
-- refused with an error; it is simply not in the answer, and the count of what came back tells
-- the caller how many were dropped.
--
-- ── Who the receipts belong to ───────────────────────────────────────────────────────────────
--
-- Through sarraf_portal_subject, the same door every portal read has used since 202609010008: a
-- person asks for themselves, an admin may ask on behalf of a customer or partner, and nobody
-- may ask about anybody else. The owner's sentence is about receipts sitting «لە ئەکاونتی
-- مشتەرییەکاندا» — in the customers' accounts — so an admin bundling a customer's receipts and
-- that customer bundling their own are the same operation with a different subject, which is
-- precisely what that function was built to express.
--
-- ── Why a release is written down ────────────────────────────────────────────────────────────
--
-- Handing somebody a hundred receipt images is the largest single disclosure this system
-- performs. It leaves through a share sheet, and after that the system has no idea where it
-- went. That is a legitimate thing for the owner to do and an unreasonable thing to do silently,
-- so every release writes one audit row naming who released how many, for whom. The row is
-- written in the same transaction as the rows are returned, so a caller cannot receive paths
-- from a committed call that left no record. The tenant on that row is stamped by the trigger
-- 202608310002 installed, from the actor — this function does not set it by hand, because a
-- second place that decides which business a row belongs to is a second place to get it wrong.
--
-- Signed access is not minted here. Supabase Storage signs with the caller's own JWT under the
-- bucket's policies, so a URL this function handed out could not outlive or outrank the caller
-- anyway; the client asks for a short-lived signature per path and the storage policy remains
-- the thing that decides. What this function guarantees is narrower and is the part that was
-- missing: the paths it names are paths the subject is entitled to.

begin;

create or replace function public.sarraf_release_receipts_for_bundle(
  p_document_ids text[],
  p_subject_id text default null)
returns table(
  document_id text,
  tracking_code text,
  storage_path text,
  mime_type text,
  state public.receipt_state,
  received_at timestamptz,
  order_no text,
  merchant_order_no text,
  currency text,
  -- Three figures, not one. receipt_extractions carries gross, fee and net separately because a
  -- receipt that charged a fee and one that did not are different receipts, and the manifest has
  -- a column for each — leaving two of them empty would have been a manifest that cannot be
  -- reconciled against the receipts it lists.
  gross_amount numeric,
  fee_amount numeric,
  net_amount numeric,
  payee text,
  tx_date date)
language plpgsql
security definer
volatile
set search_path = pg_catalog, public
as $fn$
declare
  v_subject public.app_users%rowtype;
  v_actor public.app_users%rowtype;
  v_asked integer;
  v_released integer;
begin
  -- One door for both. Asking for nobody in particular answers about the caller, which is
  -- exactly what "who is doing this" means here, so the actor needs no separate lookup.
  v_actor := public.sarraf_portal_subject(null);
  v_subject := public.sarraf_portal_subject(p_subject_id);

  v_asked := coalesce(array_length(p_document_ids, 1), 0);
  if v_asked = 0 then
    raise exception using errcode = '22023', message = 'هیچ فیشێک هەڵنەبژێردراوە',
      hint = 'Select at least one receipt.';
  end if;
  -- §11 names one hundred. Refusing rather than silently truncating: a person who asked for a
  -- hundred and twenty and received a hundred would have no way to know which twenty are absent.
  if v_asked > 100 then
    raise exception using errcode = '22023',
      message = 'زۆرترین ژمارەی فیش لە یەک کۆمەڵدا ١٠٠ ــە',
      hint = 'A bundle may carry at most 100 receipts.';
  end if;

  -- The authorization, written as a WHERE clause rather than as a check somebody has to
  -- remember to repeat per row. An id belonging to anybody else is not refused with an error —
  -- it simply is not here, and the count below tells the caller how many were dropped.
  return query
  select d.id, d.tracking_code, d.storage_path, d.mime_type, d.state, d.received_at,
         e.ref_no, e.merchant_order_no, e.currency,
         e.gross_amount, e.fee_amount, e.net_amount, e.payee, e.tx_date
    from public.receipt_documents d
    left join lateral (
      select x.ref_no, x.merchant_order_no, x.currency,
             x.gross_amount, x.fee_amount, x.net_amount, x.payee, x.tx_date
        from public.receipt_extractions x
       where x.document_id = d.id
       order by x.version desc
       limit 1) e on true
   where d.id = any(p_document_ids)
     and (d.uploader_id = v_subject.id or d.customer_id = v_subject.id)
     and nullif(btrim(coalesce(d.storage_path, '')), '') is not null
   order by d.received_at desc;

  -- RETURN QUERY sets ROW_COUNT, so the number written down is the number actually released
  -- rather than the number that was asked for.
  get diagnostics v_released = row_count;

  insert into public.audit(id, date, user_id, action, detail)
  values (
    'bundle-' || md5(v_actor.id || ':' || txid_current()::text || ':' || clock_timestamp()::text),
    statement_timestamp(),
    v_actor.id,
    'دەرکردنی کۆمەڵی فیش',
    left(v_released || ' لە ' || v_asked || ' فیش · ' ||
      case when v_subject.id = v_actor.id then 'بۆ خۆی'
           else 'بۆ ' || coalesce(v_subject.name, v_subject.id) end, 700));
end;
$fn$;

revoke all on function public.sarraf_release_receipts_for_bundle(text[], text) from public, anon;
grant execute on function public.sarraf_release_receipts_for_bundle(text[], text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_release_receipts_for_bundle(text[], text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
