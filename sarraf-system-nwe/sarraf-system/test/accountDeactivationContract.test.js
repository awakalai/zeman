import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("deactivation is one database command that refuses every outstanding money position", () => {
  const sql = read("supabase/migrations/20260908201722_account_must_be_clear_before_deactivation.sql");
  assert.match(sql, /select \* into v_target[\s\S]*for update/);
  for (const source of [
    "public.account_ledger",
    "public.customer_vaults",
    "public.partner_accounts",
    "public.debts",
    "public.ledger",
  ]) assert.match(sql, new RegExp(source.replace(".", "\\.")));
  assert.match(sql, /outstanding_financial_position/);
  assert.match(sql, /available \+ reserved \+ pending/);
  assert.match(sql, /update public\.app_users[\s\S]*set deleted = true/);
  assert.match(sql, /insert into public\.audit/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
  assert.match(sql, /alter function public\.sarraf_deactivate_user_if_clear[\s\S]*owner to sarraf_definer/);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to authenticated/);
});

test("the server cannot bypass the clear-account command", () => {
  const api = read("api/admin-user.js");
  const branch = api.slice(api.indexOf('if (action === "deactivate")'), api.indexOf('if (action === "update_rate")'));
  assert.match(branch, /reason_required/);
  assert.match(branch, /sarraf_deactivate_user_if_clear/);
  assert.match(branch, /outstanding_financial_position/);
  assert.doesNotMatch(branch, /from\("app_users"\)\.update/);
});

test("the people screen asks for a reason and explains why money blocks deactivation", () => {
  const app = read("src/App.jsx");
  assert.match(app, /deleteUser\(u, deactivateReason\)/);
  assert.match(app, /هۆکاری ناچالاککردن حەتمییە/);
  assert.match(app, /تەنها ئەگەر هەموو باڵانس و قەرزەکانی سفر بن/);
  assert.doesNotMatch(app, /window\.confirm\(`ناچالاککردنی ئەکاونتی/);
});
