-- دوو فاکتەر لەم قۆناغەدا پێویست نییە
--
--   «2FA بۆ خاوەن و کارمەند لەم قۆناغەدا پێویست نییە.»  — بەشی ٦
--   «بەڵێ، ٢فا پێویست نییە، لایبە.»                     — خاوەن، بە ڕاشکاوی
--
-- ── What was refusing what ──────────────────────────────────────────────────────────────────
--
-- Four commands raised 42501 «multi-factor authentication is required» unless the caller's
-- token carried aal2. Between them they cover assigning receipt work, both intake commands,
-- and entering a reading by hand — which is to say an administrator who had not enrolled a
-- second factor could sign in and then be refused by the four things the job is made of.
--
-- ── What still protects them, after this ────────────────────────────────────────────────────
--
-- Not nothing, and this is the part worth reading before deciding this was a bad idea:
--
--   · every one of them already refuses anybody whose role is not admin, by a separate check
--     that is untouched here;
--   · every one of them already demands a written reason of at least eight characters, and
--     that reason is stored;
--   · every one of them goes through receipt_command_log, so the same command cannot be
--     replayed and every attempt is recorded against the person who made it;
--   · tenancy is unaffected — an administrator still reaches only their own business.
--
-- So what is removed is a second FACTOR, not a second CHECK.
--
-- ── How to put it back ──────────────────────────────────────────────────────────────────────
--
-- public.receipt_request_aal() is deliberately left in place, working, and reading the same
-- claim it always did. Restoring the requirement is one migration that puts this three-line
-- guard back at the top of the same four functions:
--
--   if public.receipt_request_aal() <> 'aal2' then
--     raise exception using errcode='42501', message='multi-factor authentication is required';
--   end if;
--
-- The enrolment screen in the application is kept too, for the same reason: «لەم قۆناغەدا»
-- is a sentence about now, and a business holding other people's money will probably want it
-- back before it holds very much.

begin;

do $mfa$
declare
  v_target text;
  v_src text;
  v_new text;
  v_removed int := 0;
begin
  foreach v_target in array array[
    'sarraf_set_receipt_assignment',
    'sarraf_receipt_intake_begin_v2',
    'sarraf_receipt_intake_begin_v3',
    'sarraf_receipt_enter_reading'
  ] loop
    select pg_get_functiondef(p.oid) into v_src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname=v_target
     order by p.oid limit 1;
    if v_src is null then
      raise exception 'public.% is not here to patch', v_target;
    end if;
    if position('receipt_request_aal' in v_src) = 0 then
      raise notice 'public.% did not refuse on the assurance level; nothing to remove', v_target;
      continue;
    end if;

    -- Matched by shape rather than by literal text. The guard appears at three different
    -- indentations across these four functions, and one of them writes `errcode = ` with
    -- spaces around the equals sign; a literal replace found three of the four and said so,
    -- which is the guard on this migration doing its job.
    v_new := regexp_replace(v_src,
      '\s*if public\.receipt_request_aal\(\)\s*<>\s*''aal2''\s*then\s*raise exception[^;]*;\s*end if;',
      '', 'g');
    if v_new = v_src then
      raise exception 'public.% carries the assurance check in a shape this migration does not recognise', v_target;
    end if;
    if position('receipt_request_aal' in v_new) > 0 then
      raise exception 'public.% still refuses on the assurance level after the patch', v_target;
    end if;
    execute v_new;
    v_removed := v_removed + 1;
  end loop;

  if v_removed = 0 then
    raise exception 'no command was cleared, so this migration changed nothing';
  end if;
  raise notice 'the second factor no longer refuses % command(s)', v_removed;
end $mfa$;

comment on function public.receipt_request_aal() is
  'ئاستی دڵنیایی داواکارییەکە دەگەڕێنێتەوە. لەم قۆناغەدا هیچ فەرمانێک ڕەتی ناکاتەوە — بەشی ٦ دەڵێت ٢فا پێویست نییە — بەڵام فەنکشنەکە ماوەتەوە تاکو گەڕاندنەوەی یاساکە یەک کۆچ بێت.';

commit;
