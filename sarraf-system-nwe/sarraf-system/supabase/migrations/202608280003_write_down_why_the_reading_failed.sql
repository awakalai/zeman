-- Why the reading failed is knowable, and nobody was writing it down.
--
-- The receipt is claimed, the image is stored, and then /api/receipt-ocr refuses. If the refusal
-- happens inside the reader, the route records it: an attempt row, a rule code, a state. If it
-- happens BEFORE the reader — no configuration, no session, the object could not be downloaded —
-- the route returns a code to the browser and writes nothing anywhere.
--
-- So the database says `uploading`, `ocr_attempts = 0`, `last_error_code` null, for every one of
-- them, whatever went wrong. Every failure looks identical from the only place anyone can look,
-- and the difference between "the server has no API key" and "your session expired" survives
-- only in a Vercel log and in a sentence on a phone screen.
--
-- The browser knows the code. It is told it, in the response body, every time. This lets it say
-- so, on its own document, in the one field that exists for exactly this.
--
-- It cannot be abused into a verdict: the caller may write only to a receipt they uploaded
-- themselves, only while it is still waiting to be read, and only into last_error_code. No
-- state changes, no amount, no currency, no extraction. Truncated, and stamped with who said it.
begin;

create or replace function public.sarraf_receipt_note_read_failure(
  p_document_id text, p_code text, p_status integer default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor public.app_users%rowtype;
  v_doc public.receipt_documents%rowtype;
  v_note text;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then raise exception using errcode='42501', message='not authorized'; end if;

  select * into v_doc from public.receipt_documents where id = p_document_id;
  if not found then raise exception using errcode='P0002', message='receipt not found'; end if;

  -- Your own receipt, or one belonging to the business you administer.
  if v_doc.uploader_id <> v_actor.id and v_actor.role <> 'admin' then
    raise exception using errcode='42501', message='this receipt is not yours';
  end if;

  -- Only while it is still waiting to be read. Once the server has recorded a real outcome, the
  -- browser has nothing to add and must not be able to overwrite it.
  if v_doc.state not in ('created','uploading','upload_failed_retryable','uploaded',
                         'ocr_pending','ocr_failed_retryable') then
    return jsonb_build_object('document_id', p_document_id, 'state', v_doc.state, 'noted', false);
  end if;

  v_note := left(regexp_replace(coalesce(p_code, 'unknown'), '[^A-Za-z0-9_.:-]', '', 'g'), 60);
  if v_note = '' then v_note := 'unknown'; end if;
  if p_status is not null and p_status between 100 and 599 then
    v_note := v_note || ':' || p_status::text;
  end if;

  update public.receipt_documents
     set last_error_code = left('client:' || v_note, 80)
   where id = p_document_id;

  return jsonb_build_object('document_id', p_document_id, 'noted', true, 'code', v_note);
end;
$$;

revoke all on function public.sarraf_receipt_note_read_failure(text,text,integer) from public, anon;
grant execute on function public.sarraf_receipt_note_read_failure(text,text,integer) to authenticated;

-- A new SECURITY DEFINER function is owned by whoever ran the migration, and that role bypasses
-- row-level security. 202608280001 explains this at length; every migration that adds one needs
-- the same three lines.
grant create on schema public to sarraf_definer;
do $move$
declare f record; moved integer := 0;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      join pg_roles o on o.oid = p.proowner
     where p.prosecdef
       and p.prorettype <> 'pg_catalog.trigger'::regtype
       and p.proname not in ('sarraf_tenant','sarraf_tenant_visible','sarraf_sees_all_tenants',
                             'sarraf_reset_installation','is_admin','my_app_id','my_role')
       and o.rolname <> 'sarraf_definer'
  loop
    execute format('alter function %s owner to sarraf_definer', f.sig);
    moved := moved + 1;
  end loop;
  raise notice '% definer function(s) can no longer bypass row-level security', moved;
end
$move$;
revoke create on schema public from sarraf_definer;

commit;
