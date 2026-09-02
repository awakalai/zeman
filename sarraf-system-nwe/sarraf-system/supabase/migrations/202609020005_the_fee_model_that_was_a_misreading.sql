-- سڕینەوەی مامەڵەی خزمەتگوزاری
--
-- «بابەتی حسابات و عموولە هەڵە تێگەشتووی. ئەو لۆجیکە هەر بسڕەوە و دووبارە درووستی بکەرەوە.»
--
-- sarraf_service_transaction modelled a principal that passed through an account plus a separate
-- fee earned for moving it. That is not this business. What the owner described, and repeated,
-- is one trade at two prices:
--
--   «١٠٠ هەزار دینار ئێف ئایبی دەفرۆشم بە ١٠١ هەزار دیناری کاش»
--
-- There is no fee on the side. There is money leaving one place, arriving in another, and the
-- difference is the earning. sarraf_commission_trade (202609020003) is that, and it is the only
-- way this business now records it.
--
-- ── What this does and does not touch ────────────────────────────────────────────────────────
--
-- It drops the command, and only the command. Every row any past service wrote — its ledger
-- movements, its journal entries, its audit lines — stays exactly where it is and keeps
-- reconciling, because a wrong model is corrected by no longer using it, never by deleting the
-- history it produced. sarraf_cash_account_balances and sarraf_open_cash_account stay: accounts
-- were the right idea, and قاسە now shows them.
--
-- Leaving the function in place with no screen behind it would be worse than removing it: it is
-- SECURITY DEFINER, granted to every authenticated administrator, and it writes money.

begin;

drop function if exists public.sarraf_service_transaction(
  text, text, text, numeric, numeric, boolean, text, text, text);

commit;
