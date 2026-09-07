-- هیچ بیرخستنەوەیەک خۆی نانێردرێت
--
--   «هیچ debt reminder ـی خۆکار مەبنێرە. تەنها کاتێک خاوەن یان کارمەند دوگمەی ناردن دەگرێت،
--    ئاگاداری بنێردرێت.»
--
-- ── This reverses something the owner asked for, and that is the point ───────────────────────
--
-- Earlier in this project the owner said: «گەر دوای هەفتەیەک جواب نەبوو، ئۆتۆماتیکی بیکات» —
-- if there is no answer after a week, do it automatically. 202609020012 built exactly that, it
-- was merged, and it is applied to the live database.
--
-- The product brief now says the opposite, in one line and without qualification, and states
-- that where it conflicts with existing code the brief wins. So the automatic sender goes.
--
-- Nothing about the manual reminder changes. sarraf_remind_debtor stays exactly as it is: the
-- owner or an employee presses a button, one person is told, and the reminder is recorded in
-- history. That was never the part in question.
--
-- ── What is dropped, and what is deliberately kept ───────────────────────────────────────────
--
-- sarraf_send_due_debt_reminders is dropped: it is the thing that sends without being asked.
--
-- sarraf_debts_due_a_reminder is KEPT. It only answers a question — which debts have gone a
-- week without an answer — and answering a question is not sending anything. It is what a
-- screen would read to show «٣ قەرز هەفتەیەکە بێ‌جوابن» beside a button the owner presses. If
-- that turns out not to be wanted either it can go later; dropping a read-only reader today
-- would remove the one thing that makes the manual button findable.
--
-- Nothing that was already sent is touched. The reminders that went out under the old rule are
-- real notifications that real people received, and deleting them would be rewriting history to
-- match a decision made afterwards.

begin;

drop function if exists public.sarraf_send_due_debt_reminders(integer);

comment on function public.sarraf_debts_due_a_reminder(integer) is
  'ئەو قەرزانەی هەفتەیەکە بێ‌جوابن — تەنها بۆ نیشاندان. هیچ شتێک ناێرێت؛ ناردن تەنها بە دوگمەی خاوەن یان کارمەندە.';

commit;
