-- «پارەکەت لای نووسینگەی فڵانەیە» — کڕیار دەبێت بزانێت پارەکەی لەکوێیە (§5.3, §6.2).
--
--   «کاتێک مامەڵەیەکی کڕین دەکەم و پارەکەی لای نوسینگەیە نابێت من قەرزاری مشتەری بم،
--    دەبێت لای ئەو بنووسرێت پارەکەت لە فڵان نوسینگەیە.»
--
-- ── What the customer is told today, and what is missing from it ─────────────────────────────
--
-- A customer's home screen shows one figure under «پارەی من لای ئەوان» — my money is with them.
-- It is correct and it is silent about the only thing the owner says matters here: WHERE. The
-- customer sold yuan, the owner assigned an office to hand over the cash, and from the customer's
-- side nothing distinguishes that from the owner simply not having paid yet.
--
-- ── Why this changes no posting ──────────────────────────────────────────────────────────────
--
-- The owner's sentence can be read two ways, and only one of them is mine to act on.
--
-- Read as accounting, it would mean an unsettled purchase with an office assigned should credit
-- something other than acc-2300, so ZEMAN is not shown owing the customer. That is a change to a
-- financial posting, and §1 forbids guessing at those. It would also be wrong on its own terms
-- for the current model: until the office actually pays, somebody owes that customer, and the
-- books already say who and already move it — sarraf_office_payment_confirm posts
-- Dr acc-2300 / Cr acc-2200, settling the customer and leaving ZEMAN owing the office.
--
-- Read as what the customer sees — which is what the sentence literally says, «دەبێت لای ئەو
-- بنووسرێت», it must be WRITTEN on their side — it is a reporting gap, and closing it is safe,
-- honest and immediate. That is what this does.
--
-- And after 202609010013 the sentence is true in the strongest sense as well: when the owner has
-- advanced the money, sarraf_office_advance has already moved it out of the safe into acc-1300
-- and the office is physically holding it. `advance_held` below says whether that is the case for
-- this office and currency, so the screen can distinguish "the office will pay you" from "the
-- office is holding your money" without either sentence being a guess.
--
-- ── Who may ask ──────────────────────────────────────────────────────────────────────────────
--
-- Through sarraf_portal_subject, exactly as every other portal read has since 202609010008: a
-- person asks for themselves, an admin may ask on behalf of a customer or partner, and nobody
-- may ask about anybody else. The lesson of that migration was that a view-as parameter which
-- only the client honours is not a permission check at all.

begin;

create or replace function public.sarraf_my_money_at_offices(p_subject_id text default null)
returns table(
  assignment_id text,
  transaction_id text,
  transaction_code integer,
  office_id text,
  office_name text,
  currency text,
  amount numeric,
  amount_paid numeric,
  outstanding numeric,
  status public.office_assignment_status,
  assigned_at timestamptz,
  due_at timestamptz,
  advance_held boolean)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $fn$
declare v_subject public.app_users%rowtype;
begin
  v_subject := public.sarraf_portal_subject(p_subject_id);
  return query
  select a.id,
         a.transaction_id,
         -- txs.code is the integer the owner reads as «#12», not a text identifier. Declaring it
         -- as text made PostgreSQL refuse the function outright, which is the gate having asked
         -- a real database rather than trusted a shape written from memory.
         t.code,
         a.office_id,
         u.name,
         a.currency,
         a.amount,
         a.amount_paid,
         round(a.amount - a.amount_paid, 10),
         a.status,
         a.assigned_at,
         a.due_at,
         -- Is the office holding the owner's money for this currency, rather than merely being
         -- due to pay out of its own? Reads the operational ledger's office_id, which only
         -- sarraf_office_advance writes. False is the honest answer when nothing was advanced.
         coalesce((
           select sum(l.amount) > 0
             from public.ledger l
             join public.currencies c on c.id = l.cur_id
            where l.office_id = a.office_id
              and upper(c.code) = upper(a.currency)
         ), false)
    from public.office_payment_assignments a
    join public.app_users u on u.id = a.office_id
    left join public.txs t on t.id = a.transaction_id
   where a.customer_id = v_subject.id
     -- Settled is settled: once the office has paid and it has been confirmed the money is not
     -- "at the office" any more, and an assignment that was rejected or cancelled never put it
     -- there. Telling a customer their money is somewhere it is not would be worse than telling
     -- them nothing, so only an assignment that is still open and still owing is listed.
     and a.status not in ('confirmed', 'rejected', 'cancelled')
     and a.amount_paid < a.amount
   order by a.assigned_at desc;
end;
$fn$;

revoke all on function public.sarraf_my_money_at_offices(text) from public, anon;
grant execute on function public.sarraf_my_money_at_offices(text) to authenticated;

grant create on schema public to sarraf_definer;
alter function public.sarraf_my_money_at_offices(text) owner to sarraf_definer;
revoke create on schema public from sarraf_definer;

commit;
