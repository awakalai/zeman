-- The two tables a definer function could still write past (§ baseline section 7).
--
-- Every tenanted table in this system has row level security enabled, a restrictive tenant
-- policy, and FORCE. Two did not have FORCE: pending_accounts and zeman_notifications.
--
-- What FORCE changes. Without it, the table's owner is exempt from its own policies. Every
-- SECURITY DEFINER function owned by that role therefore reads and writes the table as though
-- no policy existed — which is exactly the hole 202608250001 closed for 131 functions by moving
-- them to sarraf_definer, a role with no BYPASSRLS. FORCE is the other half of that: it stops
-- the owner itself from being the way through.
--
-- Why it is safe to add now, and was not obviously safe before. The live inspection on 1
-- September answered the question this depended on:
--
--     role            superuser   bypasses RLS
--     postgres        f           t
--     service_role    f           t
--     sarraf_definer  f           f
--     authenticated   f           f
--     anon            f           f
--
-- BYPASSRLS beats FORCE. The trigger on auth.users that claims a pending account, and the
-- postgres-owned triggers that write notifications, all keep working — they run as a role that
-- bypasses row security outright. What loses its exemption is any sarraf_definer function, and
-- that is the whole point: sarraf_definer is nobypassrls precisely so a command run on
-- somebody's behalf reaches only what that person's business may see.
--
-- Guessing at this rather than asking would have been the same mistake as before: the local
-- fixture connects as a superuser, where every role bypasses everything, and it cannot tell the
-- difference between a policy that holds and one that is never consulted.

begin;

alter table public.pending_accounts force row level security;
alter table public.zeman_notifications force row level security;

commit;
