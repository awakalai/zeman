-- The uploader's own list, with the three things it never had.
--
-- sarraf_my_receipt_intakes answers "what did I send and where did it get to". It is the only
-- read a customer has over their own uploads, and nothing in the application has ever called it
-- — so a customer whose receipt was refused is told nothing, sees nothing, and has nowhere to
-- send a replacement from.
--
-- The list needs three more facts before a screen can be built on it: the name of the receipt,
-- whether a replacement has already been sent, and what this one itself replaced. A returned
-- column cannot be added in place — `create or replace` refuses to change a function's output —
-- so this is a v2 and the original stays exactly as it is for anything still calling it.
begin;

create or replace function public.sarraf_my_receipt_intakes_v2(p_limit integer default 50)
returns table(
  id text, tracking_code text, state public.receipt_state, flow public.receipt_flow,
  received_at timestamptz, ocr_attempts integer, rule_reason text,
  replaced_by_document_id text, replaces_document_id text, replaced_by_tracking_code text)
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select d.id, d.tracking_code, d.state, d.flow, d.received_at, d.ocr_attempts,
    coalesce(nullif(btrim(d.rule_reason), ''), case
      when d.state = 'duplicate' then 'وێنەکە پێشتر تۆمارکراوە'
      when d.state = 'currency_mismatch' then 'دراوی فیشەکە لەگەڵ مامەڵەکە یەک ناگرێتەوە'
      when d.state = 'tamper_suspected' then 'فیشەکە پشکنینی زیاتر پێویستە'
      when d.state = 'rejected' then 'فیشەکە لەلایەن ئەدمینەوە ڕەتکراوەتەوە'
      when d.state = 'needs_manual_review' then 'فیشەکە لە پشکنینی ئەدمیندایە'
      else null
    end),
    d.replaced_by_document_id, d.replaces_document_id,
    (select n.tracking_code from public.receipt_documents n where n.id = d.replaced_by_document_id)
  from public.receipt_documents d
  where d.uploader_id = public.my_app_id()
     or d.customer_id = public.my_app_id()
  order by d.received_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

revoke all on function public.sarraf_my_receipt_intakes_v2(integer) from public, anon;
grant execute on function public.sarraf_my_receipt_intakes_v2(integer) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_my_receipt_intakes_v2(integer) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
