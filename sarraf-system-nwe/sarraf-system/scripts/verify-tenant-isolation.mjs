#!/usr/bin/env node
/**
 * Can one buyer's staff reach another buyer's rows?
 *
 * Nothing in this repository has ever asked. Every database gate connects as the superuser, and a
 * superuser ignores row-level security entirely — so the tenant policies written in
 * 202608240002 have never once been executed, and 297 passing checks say nothing about whether
 * they work. The role gate runs in a browser against a stubbed Supabase, which tests the screens
 * and not the database.
 *
 * This gate connects as `authenticated`, the role the application actually uses, with a JWT
 * subject belonging to one business, and then tries to reach the other business every way the
 * application offers: straight at the tables, and through the SECURITY DEFINER functions that
 * take an id from the caller.
 *
 * SECURITY DEFINER is the interesting half. Those functions run as their owner and step around
 * row-level security by design — that is what they are for. If the owner can bypass RLS, then
 * every one of them is a way through, whatever the policies say.
 *
 *   npm run verify:isolation
 */
import { postgresAvailable, PG_HINT, startDatabase } from "./lib/zeman-db.mjs";

if (!postgresAvailable()) {
  console.error(PG_HINT);
  process.exit(1);
}

const A_UID = "aaaaaaaa-0000-0000-0000-000000000001";
const B_UID = "bbbbbbbb-0000-0000-0000-000000000001";

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([true, name]); }
  catch (e) { checks.push([false, `${name}\n        ${String(e.message || e).split("\n")[0].slice(0, 300)}`]); }
};

const db = startDatabase();
const { psql } = db;

try {
  // ── two businesses, each with a person and a receipt batch ──────────────────
  //
  // The fixture already made t-sarkhel and t-kurdistan. What it did not make is somebody in the
  // second one, or anything for either of them to own.
  // Seeded with the triggers off. Creating an administrator is itself guarded — only a manager
  // or a business owner may do it — and a fixture is not trying to test that guard, it is trying
  // to get two businesses into existence so the guards that matter here can be tested.
  psql(`
    begin;
    set local session_replication_role = replica;
    insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id) values
      ('iso-mgr','Manager','admin','manager','cccccccc-0000-0000-0000-000000000001',null),
      ('iso-a','Owner A','admin','owner','${A_UID}','t-sarkhel'),
      ('iso-b','Owner B','admin','owner','${B_UID}','t-kurdistan')
    on conflict (id) do update set auth_id = excluded.auth_id, tenant_id = excluded.tenant_id;

    insert into public.receipt_batches(id,customer_id,customer_name,direction,status,currency,uploaded_by,tenant_id)
    values ('bat-a','iso-a','A','sell','pending','CNY','iso-a','t-sarkhel'),
           ('bat-b','iso-b','B','sell','pending','CNY','iso-b','t-kurdistan')
    on conflict (id) do update set tenant_id = excluded.tenant_id;
    commit;
  `);

  // The fixture pinned auth.uid() to a constant so the accounting gate could act as one admin.
  // This gate needs it to follow whoever is being impersonated, which is what it reads in
  // production anyway.
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $fn$;`);

  // Runs sql as the role the browser actually connects as, for the person named by uid.
  // `set local role` is what makes this real: row-level security tests current_user, and the
  // superuser this script connects as would otherwise sail past every policy.
  //
  // Only the last line is the answer: set_config prints what it set, and mistaking that for the
  // result is how the first version of this gate reported the caller's own user id as the list
  // of batches they could see.
  const asUser = (uid, sql) => {
    const out = psql(
      `begin;
       select set_config('request.jwt.claim.sub','${uid}',true);
       set local role authenticated;
       ${sql};
       commit;`);
    const lines = String(out).split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? "";
  };

  const refused = (uid, sql, what) => {
    let out = null;
    try { out = asUser(uid, sql); }
    catch { return; }                       // refused outright — which is the point
    throw new Error(`${what} was allowed, and returned: ${String(out).trim().slice(0, 200)}`);
  };

  // ── straight at the tables ──────────────────────────────────────────────────
  check("a business owner reads only their own receipt batches", () => {
    const seen = asUser(A_UID, "select coalesce(string_agg(id, ','order by id),'<none>') from public.receipt_batches").trim();
    if (seen !== "bat-a") throw new Error(`saw ${seen}, expected only bat-a`);
  });

  check("the other business reads only its own", () => {
    const seen = asUser(B_UID, "select coalesce(string_agg(id, ','order by id),'<none>') from public.receipt_batches").trim();
    if (seen !== "bat-b") throw new Error(`saw ${seen}, expected only bat-b`);
  });

  check("a business owner cannot see the other business's staff", () => {
    const seen = asUser(A_UID, "select coalesce(string_agg(id, ','order by id),'<none>') from public.app_users where id like 'iso-%'").trim();
    if (seen.includes("iso-b")) throw new Error(`saw ${seen}, which includes the other business`);
  });

  check("a business owner cannot write a row into the other business", () => {
    refused(A_UID,
      `insert into public.receipt_batches(id,customer_id,customer_name,direction,status,currency,uploaded_by,tenant_id)
       values ('bat-x','iso-a','X','sell','pending','CNY','iso-a','t-kurdistan')`,
      "writing a batch into the other business");
  });

  // ── through the functions that take an id ───────────────────────────────────
  //
  // This is the half that row-level security does not cover. Each of these runs as its owner,
  // and each takes the id it works on from whoever called it.
  check("the batch detail of another business is refused", () => {
    refused(A_UID, "select public.sarraf_partner_batch_detail('bat-b')",
      "reading the other business's batch detail");
  });

  check("the batch summary of another business is refused", () => {
    refused(A_UID, "select public.sarraf_batch_summary('bat-b')",
      "reading the other business's batch summary");
  });

  // ── the rate, which is not a row anybody would notice going wrong ───────────
  //
  // Every total on a screen is computed from it. One business setting the number the other
  // values its inventory by is not a leak of data, it is a leak into every figure they read.
  check("one business setting its rate does not move the other's", () => {
    const before = asUser(B_UID,
      "select rate::text from public.sarraf_currencies() where id = 'cny'");

    asUser(A_UID, `select public.sarraf_save_rates(
      '[{"id":"cny","rate":"9.99","buy_rate":"9.90","sell_rate":"10.10"}]'::jsonb,
      '[]'::jsonb, 'iso-rate-1', 'save_rates', 'isolation check')`);

    const mine = asUser(A_UID,
      "select rate::text from public.sarraf_currencies() where id = 'cny'");
    if (Number(mine) !== 9.99) throw new Error(`the business that saved sees ${mine}, not 9.99`);

    const after = asUser(B_UID,
      "select rate::text from public.sarraf_currencies() where id = 'cny'");
    if (after !== before) {
      throw new Error(`the other business's rate moved from ${before} to ${after}`);
    }
  });

  check("a business that has set no rate of its own still gets one", () => {
    const own = asUser(B_UID,
      "select own_rate::text from public.sarraf_currencies() where id = 'cny'");
    if (own !== "false") throw new Error(`expected the fallback to be flagged, got own_rate=${own}`);
    const rate = asUser(B_UID,
      "select coalesce(rate::text,'<none>') from public.sarraf_currencies() where id = 'cny'");
    if (rate === "<none>") throw new Error("a business with no rate of its own was left without one");
  });

  check("the spread is the business's own, and a save that omits it leaves it alone", () => {
    asUser(A_UID, `select public.sarraf_save_rates(
      '[{"id":"cny","rate":"8.50"}]'::jsonb,
      '[]'::jsonb, 'iso-rate-2', 'save_rates', 'isolation check')`);
    const buy = asUser(A_UID,
      "select buy_rate::text from public.sarraf_currencies() where id = 'cny'");
    if (Number(buy) !== 9.90) throw new Error(`the spread was overwritten: buy_rate is ${buy}, not 9.90`);
  });

  // ── and the manager, who is meant to see everything ─────────────────────────
  check("the manager still sees both businesses", () => {
    const mgr = psql(`select coalesce(auth_id::text,'') from public.app_users
                      where admin_level='manager' and not deleted limit 1`).trim();
    if (!mgr) { psql("select 1"); throw new Error("no manager exists in the fixture"); }
    const seen = asUser(mgr, "select count(*) from public.receipt_batches").trim();
    if (Number(seen) < 2) throw new Error(`the manager saw ${seen} batches, expected both`);
  });
} catch (setupFailure) {
  // A gate that reports "0 checks" and exits green is worse than one that fails: it says the
  // question was answered when it was never asked.
  checks.push([false, `the fixture could not be built\n        ${String(setupFailure.message || setupFailure).slice(0, 600)}`]);
} finally {
  if (checks.length === 0) checks.push([false, "no check ran at all"]);
  let failed = 0;
  for (const [ok, name] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; }
  console.log(failed
    ? `\n${failed} of ${checks.length} tenant isolation checks failed.`
    : `\nOne business cannot reach another, across ${checks.length} checks.`);
  db.stop();
  process.exit(failed ? 1 : 0);
}
