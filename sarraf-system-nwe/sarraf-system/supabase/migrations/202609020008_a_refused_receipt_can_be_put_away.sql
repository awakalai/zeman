-- فیشی ڕەتکراو — کلاینتەکە دەیسڕێتەوە
--
-- «سیستەمەکە ڕاستەوخۆ دەبێت پێی بڵێت ڕەتکرایەوە و هۆکارەکەشی پێ بڵێ. فیشی ڕەتکراوە پێویست
--  ناکات بۆ من بنێردرێت، هەر لە تەنیشت خۆیا دیلێتکردنی ئەو فیشە هەبێت.»
--
-- The uploader already sees the refusal and its reason. What they could not do is put it away:
-- a receipt the machine refused sat in their list for good, so the next real one arrived under
-- a pile of dead ones.
--
-- ── Put away, not destroyed ──────────────────────────────────────────────────────────────────
--
-- «بێگوومان دەبێت ئەو هیستۆرییە هەبێت بۆ ئەوەی بزانم کێ فیشی دووبارە و خراپ دەنێرێت.»
--
-- So this deletes nothing. The row stays, its reason stays, and every state it passed through
-- stays in receipt_state_transitions. It moves to 'cancelled', which the state machine has
-- always had and treats as terminal, and it leaves the uploader's list. The owner can still
-- count how many a person has had refused — which is the whole point of keeping it.
--
-- Only the person who sent it may put it away, and only one that was actually refused.

begin;

-- 'rejected' could only be reopened for review. It can now also be closed by the person who
-- sent it. Both are one-way: 'cancelled' accepts nothing further, so this cannot be used to
-- walk a receipt back into the accepted pile.
-- Copied from 202608140001, which is the definition that is actually live — the first version
-- of this migration was written from 202608120005 instead, and silently took away four
-- transitions that a later migration had added. verify:accounting named the one it hit.
-- Two lines differ from the live table, both marked below.
create or replace function public.receipt_transition_allowed(
  p_from public.receipt_state, p_to public.receipt_state
) returns boolean language sql immutable set search_path = pg_catalog as $$
  select case
    when p_from in ('seen','failed_terminal','cancelled') then false
    when p_from is null then p_to='created'
    when p_from='created' then p_to in ('uploading','cancelled')
    when p_from='uploading' then p_to in ('uploaded','upload_failed_retryable','cancelled')
    when p_from='upload_failed_retryable' then p_to in ('uploading','failed_terminal','cancelled')
    when p_from='uploaded' then p_to in ('ocr_pending','needs_manual_review','cancelled')
    when p_from='ocr_pending' then p_to in ('ocr_processing','ocr_failed_retryable','needs_manual_review')
    when p_from='ocr_processing' then p_to in
      ('parsed','ocr_failed_retryable','needs_manual_review','duplicate','currency_mismatch','tamper_suspected')
    when p_from='ocr_failed_retryable' then p_to in ('ocr_pending','needs_manual_review','failed_terminal')
    when p_from='parsed' then p_to in
      ('validated','needs_manual_review','duplicate','currency_mismatch','tamper_suspected')
    when p_from='needs_manual_review' then p_to in
      ('validated','rejected','duplicate','currency_mismatch','tamper_suspected')
    -- CHANGED: a refusal the machine made for a named reason can be put away by its sender.
    when p_from in ('duplicate','currency_mismatch','tamper_suspected') then p_to in ('needs_manual_review','rejected','cancelled')
    when p_from='validated' then p_to in
      ('submitted','needs_manual_review','rejected','duplicate','currency_mismatch','tamper_suspected')
    when p_from='submitted' then p_to in
      ('matched','accepted','rejected','needs_manual_review','duplicate','currency_mismatch','tamper_suspected')
    when p_from='matched' then p_to in ('accepted','rejected','duplicate','currency_mismatch','tamper_suspected')
    when p_from='accepted' then p_to in ('finalized','rejected')
    when p_from='finalized' then p_to='forwarded'
    when p_from='forwarded' then p_to in ('delivered','seen')
    when p_from='delivered' then p_to='seen'
    -- CHANGED: reopened for review by an administrator, or put away by the person who sent it.
    -- Both are one-way; 'cancelled' accepts nothing further, so this cannot walk a receipt
    -- back into the accepted pile.
    when p_from='rejected' then p_to in ('needs_manual_review','cancelled')
    else false
  end;
$$;

create or replace function public.sarraf_dismiss_rejected_receipt(
  p_document_id text, p_command_key text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype; v_doc public.receipt_documents%rowtype;
  v_prev jsonb; v_result jsonb;
begin
  select * into v_actor from public.app_users where auth_id = auth.uid() and not deleted;
  if not found then
    raise exception using errcode='42501', message='کێیت؟ سەرەتا بچۆ ژوورەوە';
  end if;

  if p_command_key !~ '^receipt-dismiss:[A-Za-z0-9:_-]{8,200}$' then
    raise exception using errcode='22023', message='invalid dismissal command';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor.auth_id::text||':'||p_command_key, 0));
  v_prev := public.sarraf_command_replay(v_actor.auth_id, p_command_key, 'dismiss_receipt');
  if v_prev is not null then return v_prev; end if;

  select * into v_doc from public.receipt_documents where id = p_document_id for update;
  if not found then raise exception using errcode='P0002', message='ئەو فیشە نەدۆزرایەوە'; end if;

  -- Only the person who sent it. An administrator putting somebody else's refusal away would
  -- hide, from the person who needs to act on it, that anything was wrong.
  if v_doc.uploader_id is distinct from v_actor.id then
    raise exception using errcode='42501',
      message='تەنها ئەو کەسەی ناردوویەتی دەتوانێت لایبەرێت';
  end if;

  if v_doc.state not in ('rejected','duplicate','currency_mismatch','tamper_suspected') then
    raise exception using errcode='23514',
      message='تەنها فیشێکی ڕەتکراو دەتوانرێت لابردرێت';
  end if;

  update public.receipt_documents set state = 'cancelled' where id = v_doc.id;

  v_result := jsonb_build_object('document_id', v_doc.id, 'was', v_doc.state::text,
                                 'reason', v_doc.rule_reason, 'replayed', false);
  return public.sarraf_store_command(v_actor.auth_id, p_command_key, 'dismiss_receipt', v_result);
end;
$$;

comment on function public.sarraf_dismiss_rejected_receipt(text,text) is
  'ئەو کەسەی فیشێکی ناردووە و ڕەت کراوەتەوە، دەتوانێت لای بەرێت. ڕیزەکە و هۆکارەکەی و مێژووەکەی دەمێننەوە.';

revoke all on function public.sarraf_dismiss_rejected_receipt(text,text) from public, anon;
grant execute on function public.sarraf_dismiss_rejected_receipt(text,text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_dismiss_rejected_receipt(text,text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
