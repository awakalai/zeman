-- Search that finds the thing the person on the phone is describing.
--
-- The search installed on 10 August matches prefixes only:
--
--   lower(coalesce(r.ref_no,'')) like query_prefix || '%'
--
-- To find a receipt you had to type the first characters of a twenty-eight digit Alipay
-- reference. To find a person you had to know how their name begins. Nothing looked receipts up
-- by amount, nothing looked up a batch at all, and every label came back in English — 'Customer',
-- 'Order 1042', 'Receipt' — in an application whose every other word is Kurdish.
--
-- And since this morning there is a far better handle than any of them, which the search does not
-- know exists: the tracking code. The customer reads `ZR-20260827-090243-B06965` down the phone,
-- and that is exactly the string the owner should be able to type.
--
-- What changes:
--
--   contains, not prefix   `like '%' || q || '%'`. A reference is found by its last six digits,
--                          which is what people actually read out.
--   the tracking code      on the receipt and on the intake document, both.
--   the amount             a numeric query matches an amount or a net amount by its leading
--                          digits — 1246 finds 1,246.30.
--   batches                searchable at all for the first time, by id or by whose they are.
--   a key, not a word      `type` comes back as 'customer' / 'receipt' / 'batch', and the screen
--                          says it in whichever language is on. A database is the wrong place to
--                          keep a translation.
--   somewhere to land      `focus` carries the batch a receipt belongs to, so choosing a result
--                          opens the batch holding it rather than the top of the receipts page.
--
-- What does not change: who may see what. This function runs as sarraf_definer, which holds no
-- BYPASSRLS, so the restrictive tenant policies decide which business's rows exist at all — and
-- the role test below decides, within a business, that a customer searches their own receipts and
-- not their neighbour's.
--
-- Cost. A contains-match cannot use a b-tree, so these get trigram indexes where the extension is
-- available. Where it is not, the scan is bounded by the same tenant policies and by twenty
-- results, and it is a person typing rather than a loop.
begin;

do $trgm$
begin
  create extension if not exists pg_trgm;
  raise notice 'trigram search available';
exception when others then
  raise notice 'no trigram extension here; search falls back to a bounded scan';
end
$trgm$;

do $idx$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    execute 'create index if not exists receipts_tracking_trgm on public.receipts using gin (tracking_code gin_trgm_ops)';
    execute 'create index if not exists receipts_ref_trgm on public.receipts using gin (lower(coalesce(ref_no,'''')) gin_trgm_ops)';
    execute 'create index if not exists app_users_name_trgm on public.app_users using gin (lower(name) gin_trgm_ops)';
    execute 'create index if not exists receipt_documents_tracking_trgm on public.receipt_documents using gin (tracking_code gin_trgm_ops)';
  end if;
exception when others then
  raise notice 'trigram indexes not created: %', sqlerrm;
end
$idx$;

-- A returned column cannot be added in place; the shape of the answer is part of the signature.
drop function if exists public.sarraf_operational_search(text, integer, text);

create or replace function public.sarraf_operational_search(
  p_query text,
  p_limit integer default 20,
  p_cursor text default null
) returns table(type text, label text, context text, path text, focus text)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  actor public.app_users%rowtype;
  q text := lower(btrim(coalesce(p_query, '')));
  result_limit integer := least(greatest(coalesce(p_limit, 20), 1), 20);
  numeric_q text;
  staff boolean;
begin
  select * into actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode = '42501', message = 'not authorized'; end if;
  if length(q) < 2 then return; end if;
  staff := actor.role in ('admin', 'office');
  -- Only a query that is entirely a number is treated as one. '2026' inside a date is not an
  -- amount, and matching it as one buries the results a person was actually looking for.
  numeric_q := case when q ~ '^[0-9]+(\.[0-9]+)?$' then q end;

  return query
  with visible as (
    select 'customer'::text as type, u.name as label, coalesce(u.phone, '')::text as context,
           '#/people'::text as path, null::text as focus, '1:' || u.id as sort_key
      from public.app_users u
     where u.role = 'customer' and not u.deleted
       and (staff or u.id = actor.id)
       and position(q in lower(u.name)) > 0

    union all
    select 'partner', u.name, coalesce(u.phone, ''), '#/people', null, '2:' || u.id
      from public.app_users u
     where u.role = 'partner' and not u.deleted
       and (staff or u.id = actor.id)
       and position(q in lower(u.name)) > 0

    union all
    select 'transaction', 'کۆد ' || t.code::text, c.code, '#/txs', null, '3:' || t.id
      from public.txs t join public.currencies c on c.id = t.cur_id
     where not t.deleted
       and (position(q in lower(t.code::text)) > 0
            or (numeric_q is not null and t.amount::text like numeric_q || '%'))
       and (staff or t.cp_id = actor.id or t.partner_id = actor.id)

    -- The receipt, by every handle a person might be holding: its own name, the reference
    -- printed on it, or what it was for.
    union all
    select 'receipt',
           coalesce(r.tracking_code, r.ref_no, 'فیش'),
           trim(both ' · ' from concat_ws(' · ',
             nullif(to_char(r.net_amount, 'FM999999999990.00') || ' ' || r.currency, ' '),
             nullif(r.ref_no, ''),
             to_char(r.created_at, 'YYYY-MM-DD'))),
           '#/receipts', r.batch_id, '4:' || r.id
      from public.receipts r
      join public.receipt_batches b on b.id = r.batch_id
     where (staff or b.customer_id = actor.id or b.partner_id = actor.id)
       and (position(q in lower(coalesce(r.tracking_code, ''))) > 0
            or position(q in lower(coalesce(r.ref_no, ''))) > 0
            or (numeric_q is not null
                and (r.amount::text like numeric_q || '%' or r.net_amount::text like numeric_q || '%')))

    -- An uploaded image that has not become a receipt row yet still has a name, and it is the
    -- one the person who sent it can read out. Before today it could not be looked up at all.
    union all
    select 'intake',
           coalesce(d.tracking_code, d.id),
           trim(both ' · ' from concat_ws(' · ',
             d.state::text, to_char(d.received_at, 'YYYY-MM-DD HH24:MI'))),
           '#/receipt-review', d.batch_id, '5:' || d.id
      from public.receipt_documents d
     where (staff or d.uploader_id = actor.id or d.customer_id = actor.id)
       and not exists (select 1 from public.receipts r where r.id = d.id)
       and position(q in lower(coalesce(d.tracking_code, ''))) > 0

    union all
    select 'batch',
           coalesce(nullif(btrim(b.customer_name), ''), b.id),
           trim(both ' · ' from concat_ws(' · ',
             coalesce(b.n, 0)::text || ' فیش', b.currency,
             to_char(b.created_at, 'YYYY-MM-DD'))),
           '#/receipts', b.id, '6:' || b.id
      from public.receipt_batches b
     where (staff or b.customer_id = actor.id or b.partner_id = actor.id)
       and (position(q in lower(b.id)) > 0
            or position(q in lower(coalesce(b.customer_name, ''))) > 0)

    union all
    select 'currency', c.code, c.name, '#/rates', null, '7:' || c.id
      from public.currencies c
     where position(q in lower(c.code)) > 0 or position(q in lower(c.name)) > 0
  )
  select v.type, v.label, v.context, v.path, v.focus
    from visible v
   order by v.sort_key
   limit result_limit;
end
$$;

revoke all on function public.sarraf_operational_search(text, integer, text) from public, anon;
grant execute on function public.sarraf_operational_search(text, integer, text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_operational_search(text, integer, text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
