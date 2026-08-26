-- The upload claims, the row appears, and every one says the image never arrived.
--
-- «نەتوانرا بخوێندرێتەوە: وێنەکە نەگەیشت؛ تکایە دووبارە هەوڵ بدەوە» is the message
-- ReceiptIntakeError produces with evidenceKept = false, and there are exactly two places that
-- raise it: the claim (sarraf_receipt_intake_begin_v3) and the storage upload. The OCR path
-- produces a different message and keeps the evidence, so it is neither.
--
-- Guessing between those two has already cost this project one wrong answer. So this asks the
-- database which of them happened, and the answer is unambiguous: if receipt_documents has rows
-- from the attempt, the claim worked and storage refused; if it has none, the claim never ran.
--
-- Read-only. The workflow opens the transaction with `set transaction read only`.

\pset format aligned
\pset border 2
\pset null '⟨null⟩'
\pset pager off

\echo ''
\echo '════════ 1. Does the new claim function exist, and may a browser call it? ════════'
\echo ''
\echo 'Created by 202608280001 and handed to sarraf_definer so it cannot bypass tenancy.'
\echo 'If authenticated holds no EXECUTE, every claim fails with 42501 and the screen says'
\echo 'the image never arrived.'
\echo ''

select p.oid::regprocedure                                   as signature,
       o.rolname                                             as owner,
       o.rolbypassrls                                        as owner_bypasses_rls,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_may_call,
       has_function_privilege('service_role',  p.oid, 'execute') as service_role_may_call
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  join pg_roles o on o.oid = p.proowner
 where p.proname in ('sarraf_receipt_intake_begin_v2','sarraf_receipt_intake_begin_v3')
 order by p.proname;

\echo ''
\echo '════════ 2. Did any receipt actually get claimed? ════════'
\echo ''
\echo 'A row here means the claim SUCCEEDED and the failure is later — the storage upload.'
\echo 'No rows at all means the claim itself was refused, and nothing reached the database.'
\echo ''

select d.id, d.state, d.flow, d.uploader_id, d.customer_id,
       d.transaction_id, d.batch_id, d.storage_path,
       d.expected_currency, d.tenant_id, d.received_at
  from public.receipt_documents d
 where d.received_at > now() - interval '6 hours'
 order by d.received_at desc
 limit 20;

\echo ''
\echo '════════ 3. Every claim the command log recorded ════════'
\echo ''

select l.actor_id, l.operation, l.command_key, l.created_at, l.result
  from public.receipt_command_log l
 where l.created_at > now() - interval '6 hours'
 order by l.created_at desc
 limit 20;

\echo ''
\echo '════════ 4. Did any image reach the bucket? ════════'
\echo ''
\echo 'The claim returns a storage path and the browser then uploads to it. An object here whose'
\echo 'name matches a path above means both halves worked and the fault is the OCR route.'
\echo ''

select o.name, o.owner_id, o.created_at,
       (o.metadata->>'size')::bigint as bytes,
       o.metadata->>'mimetype'       as mime
  from storage.objects o
 where o.bucket_id = 'receipts'
   and o.created_at > now() - interval '6 hours'
 order by o.created_at desc
 limit 20;

\echo ''
\echo '════════ 5. What may write into that bucket at all ════════'
\echo ''
\echo 'The lifecycle migration writes RESTRICTIVE policies for select, delete and update, and'
\echo 'none for insert — so an insert is allowed only by some permissive policy defined'
\echo 'elsewhere. If there is no permissive INSERT policy for authenticated, no uploader can'
\echo 'ever store an image, and that is exactly what the screen is reporting.'
\echo ''

select pol.polname,
       case pol.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                       when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as command,
       case pol.polpermissive when true then 'permissive' else 'RESTRICTIVE' end     as kind,
       coalesce((select string_agg(r.rolname, ', ') from pg_roles r
                  where r.oid = any(pol.polroles)), 'everyone')                      as applies_to,
       coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),
                pg_get_expr(pol.polqual, pol.polrelid))                              as expression
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'storage'
 where c.relname = 'objects'
 order by pol.polcmd, pol.polpermissive desc, pol.polname;

\echo ''
\echo '════════ 6. The bucket itself ════════'
\echo ''

select id, name, public, file_size_limit, allowed_mime_types, created_at
  from storage.buckets order by id;
