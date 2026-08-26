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
  // The fixture already made t-sarkhel and t-watan. What it did not make is somebody in the
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
      ('iso-b','Owner B','admin','owner','${B_UID}','t-watan')
    on conflict (id) do update set auth_id = excluded.auth_id, tenant_id = excluded.tenant_id;

    insert into public.receipt_batches(id,customer_id,customer_name,direction,status,currency,uploaded_by,tenant_id)
    values ('bat-a','iso-a','A','sell','pending','CNY','iso-a','t-sarkhel'),
           ('bat-b','iso-b','B','sell','pending','CNY','iso-b','t-watan')
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

  // Some functions are internal: authenticated holds no EXECUTE on them, and control_settings is
  // revoked from it outright. That is correct — the browser never calls them — and it means a
  // check that calls them as `authenticated` proves nothing except that the grant is tight.
  //
  // A command reaches them as sarraf_definer, with the caller's JWT still in the session, so
  // auth.uid() is the person and current_user is the role. That is what this reproduces. It is
  // the only honest way to ask what a command sees on somebody's behalf.
  const asDefiner = (uid, sql) => {
    const out = psql(
      `begin;
       select set_config('request.jwt.claim.sub','${uid}',true);
       set local role sarraf_definer;
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
       values ('bat-x','iso-a','X','sell','pending','CNY','iso-a','t-watan')`,
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

  // ── the health report, asked by a person rather than by a superuser ─────────
  //
  // The manager opened the health tab and it named fourteen tables as missing from the database.
  // All fourteen were there. information_schema shows a table only to somebody holding a
  // privilege on it, and these reports are SECURITY INVOKER, so they ran as the person asking and
  // could not see the internal tables — the command logs, the counters, the control settings —
  // which no client may read directly.
  //
  // Every gate ran them as the superuser, who sees everything, so every gate agreed the report
  // was fine. This is the same shape as the tenancy policies: a check that never ran as the role
  // that actually asks.
  check("the health report says the same thing to a manager as to the superuser", () => {
    const mgr = psql(`select coalesce(auth_id::text,'') from public.app_users
                      where admin_level='manager' and not deleted limit 1`).trim();
    const asSuper = psql("select count(*) from public.sarraf_schema_tables()").trim();
    const asManager = asUser(mgr, "select count(*) from public.sarraf_schema_tables()").trim();
    if (asSuper !== asManager) {
      const named = asUser(mgr,
        `select coalesce(string_agg(table_name, ', ' order by table_name), '')
           from public.sarraf_schema_tables()`);
      throw new Error(`the superuser sees ${asSuper} problems and the manager ${asManager}: ${named.slice(0, 240)}`);
    }
  });

  check("a business owner is told the same about the schema as anyone else", () => {
    const asSuper = psql("select count(*) from public.sarraf_schema_drift()").trim();
    const asOwner = asUser(A_UID, "select count(*) from public.sarraf_schema_drift()").trim();
    if (asSuper !== asOwner) {
      throw new Error(`drift is ${asSuper} for the superuser and ${asOwner} for a business owner`);
    }
  });

  // ── the admin is refused, not queued ───────────────────────────────────────
  //
  // The owner's rule: an administrator does everything the owner can except the sensitive
  // things, and cannot do those — rather than doing them and waiting for the owner to accept.
  //
  // What was built decided approval by amount alone, so it did neither. An administrator's large
  // transaction was accepted and parked; the owner's own was parked too, waiting for a second
  // administrator — who, in a business with one owner and one member of staff, is the member of
  // staff. The control ran backwards.
  check("an administrator is refused a sensitive operation, and told whose it is", () => {
    psql(`begin;
          set local session_replication_role = replica;
          insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id)
          values ('iso-op','Staff','admin','operator','dddddddd-0000-0000-0000-000000000001','t-sarkhel')
          on conflict (id) do update set auth_id = excluded.auth_id;
          update public.control_settings set transaction_approval_usd = 100;
          commit;`);
    const needs = asDefiner("dddddddd-0000-0000-0000-000000000001",
      "select public.sarraf_requires_approval('commit_transactions', 5000)::text");
    if (needs !== "true") throw new Error(`an administrator was not stopped at all: ${needs}`);

    let message = "";
    try {
      asDefiner("dddddddd-0000-0000-0000-000000000001",
        `select public.sarraf_request_approval('commit_transactions','k-iso-1',null,'{}'::jsonb,5000,'x')`);
    } catch (e) { message = String(e.message || e); }
    if (!message) throw new Error("the operation was queued instead of refused");
    if (!message.includes("خاوەن کار")) {
      throw new Error(`refused, but without saying whose it is: ${message.slice(0, 200)}`);
    }
  });

  check("the owner is not made to wait for their own staff to approve them", () => {
    const needs = asDefiner(A_UID,
      "select public.sarraf_requires_approval('commit_transactions', 5000)::text");
    if (needs !== "false") throw new Error(`the owner was sent for approval by somebody below them`);
  });

  // control_settings and receipt_control_policy are still read `where singleton` in twenty
  // places, a pattern from when one row served the whole installation. There is a row per
  // business now and both carry singleton = true, so what stops one business reading the other's
  // approval threshold is row-level security and nothing else. That is worth a check rather than
  // an argument.
  check("one business's approval threshold is not the other's", () => {
    psql(`update public.control_settings set transaction_approval_usd = 100 where tenant_id = 't-sarkhel';
          update public.control_settings set transaction_approval_usd = 900000 where tenant_id = 't-watan';`);
    const a = asDefiner(A_UID, "select transaction_approval_usd::text from public.control_settings");
    const b = asDefiner(B_UID, "select transaction_approval_usd::text from public.control_settings");
    if (Number(a) !== 100 || Number(b) !== 900000) {
      throw new Error(`سەرخێڵ reads ${a} and وەتەن reads ${b}; each should read only its own`);
    }
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
