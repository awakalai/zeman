-- Four permissive read policies on `txs` where the migration files describe three.
--
-- The live database carries `txs_authorized_read`, which no file in this repository produces —
-- it was written by hand during the fortnight before there was a workflow. 202608280021 then
-- created the three the files DO describe, because its `drop policy if exists` found nothing of
-- those names to drop. So the live table ended up with all four:
--
--   txs_authorized_read   is_admin OR cp_id=me OR partner_id=me OR (office AND EXISTS …)
--   txs_tenant_read       is_admin OR cp_id=me OR partner_id=me
--   tx_partner_read_b     my_role='partner' AND partner_id=me
--   tx_office_r           my_role='office'  AND EXISTS …
--
-- Permissive policies are ORed, so the union of the last three is exactly the first: nobody can
-- see a row they could not see before, and nobody was locked out. That was checked before this
-- was written, not assumed. But four policies where three suffice is four things to read and
-- agree about the next time somebody asks who may see a transaction — on the table holding
-- every trade in the system.
--
-- ── which one goes, and why that way round ──────────────────────────────────
--
-- The obvious move is to drop the three and keep the one, since the one is what the live
-- database has had all along. That is the wrong way round.
--
-- The migration files are what every gate in this repository builds its database from. A policy
-- that exists only in production is a policy no gate has ever tested, and keeping it means
-- `verify:isolation` is proving something about a table that production does not have. Dropping
-- it instead makes the live database match the files — so the 53 isolation checks are finally
-- checking the thing that actually runs.
--
-- Guarded rather than assumed: the three replacements must all be present, and in the
-- once-per-query form, before anything is dropped. A database in some other state gets a person
-- looking at it, not a policy removed on faith.

begin;

do $tidy$
declare
  v_present integer;
  v_perrow integer;
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'txs'
                    and policyname = 'txs_authorized_read') then
    raise notice 'txs_authorized_read is not on this database — nothing to tidy';
    return;
  end if;

  select count(*) into v_present
    from pg_policies
   where schemaname = 'public' and tablename = 'txs'
     and policyname in ('txs_tenant_read', 'tx_partner_read_b', 'tx_office_r');

  if v_present <> 3 then
    raise exception
      'only % of the three replacement policies are present — dropping txs_authorized_read would take away access',
      v_present;
  end if;

  -- All three must already ask who you are once per query. One left in the per-row form would
  -- mean 202608280021 did not finish here, and this is not the migration to discover that in.
  select count(*) into v_perrow
    from pg_policies
   where schemaname = 'public' and tablename = 'txs'
     and policyname in ('txs_tenant_read', 'tx_partner_read_b', 'tx_office_r')
     and coalesce(qual, '') ~ '(^|[^.[:alnum:]_])(is_admin|my_app_id|my_role)\(\)'
     and coalesce(qual, '') !~ 'SELECT (is_admin|my_app_id|my_role)';

  if v_perrow > 0 then
    raise exception
      '% of the replacement policies still ask per row — 202608280021 has not finished on this database',
      v_perrow;
  end if;

  drop policy txs_authorized_read on public.txs;
  raise notice 'txs now carries the three read policies the migration files describe';
end
$tidy$;

commit;
