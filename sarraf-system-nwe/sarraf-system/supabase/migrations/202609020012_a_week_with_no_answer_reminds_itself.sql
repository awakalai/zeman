-- قەرزێک کە هەفتەیەک بێ‌جواب بێت، خۆی بیر دەخاتەوە
--
--   «ب، جوانترە پێم وابێت، بەڵام گەر دوای هەفتەیەک جواب نەبوو، ئۆتۆماتیکی بیکات.»
--
-- 202609020007 built the half the owner presses: one debt, one button, one reminder. The other
-- half — the one that happens without them — was never built, and was reported as done. This is
-- that half.
--
-- ── Why the rule lives here and not in the browser ───────────────────────────────────────────
--
-- «ئۆتۆماتیکی» means the owner is not deciding each time, so whatever decides has to be the
-- same thing every time, and has to be unable to send twice. A browser deciding it would send a
-- second reminder on a second tab, a third on a refresh, and nothing at all on the day the
-- owner used a different phone.
--
-- So the rule is one function. What calls it is a detail that can change: the app calls it when
-- an administrator opens it, and if pg_cron is ever available on this project the very same
-- function can be scheduled with no rewrite. That choice is deliberate — this project cannot
-- verify from here whether pg_cron exists on the plan, and a schedule that silently never fires
-- is worse than no schedule, because the owner would believe reminders were going out.
--
-- ── What "a week with no answer" means, exactly ──────────────────────────────────────────────
--
-- A debt is due a reminder when all of these are true:
--
--   · somebody else owes it, it is still open, and they have an account to be told at —
--     the same three rules sarraf_remind_debtor already refuses on, so the automatic path
--     can never send something the manual path would have refused;
--   · seven days have passed since the LAST reminder, or since the debt was created if none
--     has been sent. "No answer" is read as "no payment and no reminder since", because a
--     payment moves outstanding_principal and a settled debt leaves the set entirely.
--
-- Sending is idempotent per debt per week: the command key carries the debt and the week it
-- falls in, so running this ten times in one day sends one reminder, and the eleventh next
-- Tuesday sends the next.

begin;

create or replace function public.sarraf_debts_due_a_reminder(p_after_days integer default 7)
returns table (debt_id text, debtor_id text, currency text, outstanding numeric, last_told timestamptz)
language sql stable
set search_path = pg_catalog, public
as $$
  select d.id, d.debtor_id, d.currency, d.outstanding_principal,
         (select max(n.created_at) from public.zeman_notifications n
           where n.subject_kind = 'debt' and n.subject_id = d.id and n.kind = 'debt_reminder')
    from public.debts d
   where d.status not in ('settled','written_off','void')
     and d.debtor_type <> 'zeman'
     and d.debtor_id is not null
     and d.outstanding_principal > 0
     -- They must have an account, or the reminder reaches nobody.
     and exists (select 1 from public.app_users u where u.id = d.debtor_id and not u.deleted)
     and coalesce(
           (select max(n.created_at) from public.zeman_notifications n
             where n.subject_kind = 'debt' and n.subject_id = d.id and n.kind = 'debt_reminder'),
           d.opened_at
         ) <= statement_timestamp() - make_interval(days => greatest(1, least(365, coalesce(p_after_days, 7))))
   order by d.opened_at;
$$;

comment on function public.sarraf_debts_due_a_reminder(integer) is
  'ئەو قەرزانەی هەفتەیەکە بێ‌جوابن — نە پارەدان و نە بیرخستنەوە.';

-- Sends to every one of them, and says how many. Safe to call as often as anything likes.
create or replace function public.sarraf_send_due_debt_reminders(p_after_days integer default 7)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.app_users%rowtype;
  v_row record; v_sent integer := 0; v_skipped integer := 0; v_ids jsonb := '[]'::jsonb;
  v_key text;
begin
  v_actor := public.sarraf_require_admin(false);

  for v_row in select * from public.sarraf_debts_due_a_reminder(p_after_days) loop
    -- The key names the debt and the week it is being reminded in. Two administrators opening
    -- the app on the same Tuesday produce the same key, and the second one replays rather than
    -- sending a second message to somebody who has already been told once this week.
    v_key := 'debt-reminder:auto-' || v_row.debt_id || '-'
             || to_char(statement_timestamp(), 'IYYY"w"IW');
    begin
      perform public.sarraf_remind_debtor(v_row.debt_id, null, v_key);
      v_sent := v_sent + 1;
      v_ids := v_ids || to_jsonb(v_row.debt_id);
    exception when others then
      -- One debt that cannot be reminded must not stop the rest: this runs unattended, and a
      -- raise here would mean every debt after the bad one is silently never chased.
      --
      -- Stated plainly: no path into this handler is currently known. The queue above refuses
      -- exactly what sarraf_remind_debtor refuses — settled, ours, nobody named, no account —
      -- so the two agree by construction, and verify:accounting proves the ordinary way a debt
      -- becomes unsendable (the person's account is closed) drops it from the queue rather
      -- than reaching here. This is the case that has not been thought of, kept because the
      -- cost of being wrong about that is every later reminder going missing in silence.
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object('sent', v_sent, 'skipped', v_skipped, 'debt_ids', v_ids,
                            'after_days', greatest(1, least(365, coalesce(p_after_days, 7))));
end;
$$;

comment on function public.sarraf_send_due_debt_reminders(integer) is
  'بیرخستنەوە دەنێرێت بۆ هەموو قەرزێک کە هەفتەیەکە بێ‌جوابە. دووبارە بانگکردنی لە یەک هەفتەدا هیچ زیاد ناکات.';

revoke all on function public.sarraf_debts_due_a_reminder(integer) from public, anon;
revoke all on function public.sarraf_send_due_debt_reminders(integer) from public, anon;
grant execute on function public.sarraf_debts_due_a_reminder(integer) to authenticated;
grant execute on function public.sarraf_send_due_debt_reminders(integer) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_debts_due_a_reminder(integer) owner to sarraf_definer;
alter function public.sarraf_send_due_debt_reminders(integer) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
