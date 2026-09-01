-- پارەی لای نووسینگە، پارەی قاسەی خاوەن نییە (§5.2, §6.1).
--
-- Additive only. It gives the operational ledger a way to say an office is holding money, and a
-- way to read what each office holds. It changes no posting and no existing balance.
--
-- ── What the owner asked for, and what the books already do ──────────────────────────────────
--
--   «کاتێک هەر مامەڵەیەک دەکەم، ئەگەر پارەکەی نوسینگە بیدات، ئەوە لای من لە قاسە دەڕوات و
--    دەچێتە ناو حسابی نوسینگە. هەر کاتێک نوسینگە پارەدانی کرد ئەوکات حسابی نێوان من و
--    نوسینگە سفر دەبێت و حسابی کەسەکەش سفر دەبێت.»
--
-- Two events: the owner funds the office, then the office pays and both balances go to zero.
--
-- What sarraf_office_payment_confirm does today is a different, and also coherent, model. The
-- office pays out of its OWN money, and confirmation posts:
--
--     Dr acc-2300 (customer payable)  /  Cr acc-2200 (قەرزی ZEMAN بۆ نووسینگە)
--
-- The customer is settled and ZEMAN now owes the office. The owner's safe does not move, which
-- is the half of §5.2 that already holds: office activity does not touch the cashbox.
--
-- ── Why this migration does not change that ──────────────────────────────────────────────────
--
-- A first draft of this file re-declared the confirmation command to credit acc-1300 instead,
-- funding the office at assignment time. It was wrong twice over.
--
-- It was rewritten from the 202608210003 text, which is not the current behaviour: a later
-- migration had already corrected this exact posting away from acc-1000, and the accounting
-- contract that guards it carries the note "this check pinned acc-1000 for weeks: the books said
-- the safe had paid, the safe had not". Re-declaring from the older source would have undone a
-- correction somebody had already reasoned their way to. The gate refused it, which is the gate
-- doing its job.
--
-- And the choice between the two models is the owner's, not a detail to change quietly. They
-- differ in what the books say between the two events — whether the office is holding the
-- owner's money, or owed by the owner for money it advanced — and both are defensible. §1 of the
-- brief forbids guessing at accounting behaviour. So this migration builds the part that is
-- needed under either model and asks nothing of the posting.
--
-- ── What is added ────────────────────────────────────────────────────────────────────────────
--
-- public.ledger has partner_id and no way to say an office is holding money, so office-held cash
-- has never been distinguishable in the operational ledger at all. office_id mirrors partner_id:
-- null means the owner's own safe, which is what every row written before this means.

begin;

-- ── who is holding this money ────────────────────────────────────────────────────────────────
alter table public.ledger
  add column if not exists office_id text references public.app_users(id);
create index if not exists ledger_by_office on public.ledger (office_id, cur_id)
  where office_id is not null;

comment on column public.ledger.office_id is
  'The office physically holding this money. Null means the owner''s own safe, which is what '
  'every row written before 202609010012 means. Mirrors partner_id.';

-- ── what each office is holding ──────────────────────────────────────────────────────────────
--
-- Read-only, and empty until something writes an office row. It exists now so the screen that
-- answers "where is my money" has one place to ask, whichever settlement model the owner picks.
create or replace function public.sarraf_office_holdings(p_office_id text default null)
returns table(office_id text, office_name text, cur_id text, holding numeric)
language sql
security definer
stable
set search_path = pg_catalog, public
as $fn$
  select l.office_id, u.name, l.cur_id, round(sum(l.amount), 10)
    from public.ledger l
    join public.app_users u on u.id = l.office_id
   where l.office_id is not null
     and (p_office_id is null or l.office_id = p_office_id)
   group by l.office_id, u.name, l.cur_id
  having round(sum(l.amount), 10) <> 0
   order by u.name, l.cur_id;
$fn$;

revoke all on function public.sarraf_office_holdings(text) from public, anon;
grant execute on function public.sarraf_office_holdings(text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_office_holdings(text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
