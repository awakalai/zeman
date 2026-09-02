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

  const CUS_UID = "dddddddd-0000-0000-0000-000000000001";

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

  // ── the server's own key ────────────────────────────────────────────────────
  //
  // service_role is what /api/admin-user uses to create an account. It bypasses row-level
  // security, which is the thing everybody remembers about it, and bypassing a policy is not the
  // same as being allowed to read a table. It held no grant on app_users at all, so the route
  // came back `permission denied` and reported it to a signed-in owner as "this login has no
  // account in the system" — an accusation, about the one thing that was not wrong.
  //
  // Every gate here connects as a superuser or as authenticated. Nothing had ever asked what the
  // server's own key can do, which is why a route nobody could use looked healthy.
  check("the server's key can read and write the accounts it creates", () => {
    for (const priv of ["select", "insert", "update"]) {
      const ok = psql(
        `select has_table_privilege('service_role', 'public.app_users', '${priv}')::text`).trim();
      if (ok !== "true") {
        throw new Error(`service_role cannot ${priv} app_users, so account creation is refused`);
      }
    }
  });

  check("the route's own lookup succeeds as the role the route uses", () => {
    const uid = psql(`select auth_id::text from public.app_users where id = 'iso-a'`).trim();
    const seen = psql(
      `begin;
       set local role service_role;
       select count(*) from public.app_users where auth_id = '${uid}' and deleted = false;
       commit;`);
    const n = String(seen).split("\n").map((l) => l.trim()).filter(Boolean).pop();
    if (n !== "1") throw new Error(`the route would find ${n} accounts for its own caller`);
  });

  // A table added later is a table the grant was not written for. Two migrations already patched
  // two tables by hand after hitting this, which is what meeting a problem one table at a time
  // looks like.
  check("no table in the schema is closed to the server's key", () => {
    const missing = psql(`
      select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       where c.relkind = 'r'
         and not has_table_privilege('service_role', c.oid, 'select')`).trim();
    if (missing) throw new Error(`service_role cannot read: ${missing}`);
  });

  // ── the upload itself, which no gate has ever performed ─────────────────────
  //
  // A browser storing an image is two statements as `authenticated`: an INSERT into
  // storage.objects to reserve the name, and an UPDATE once the bytes are stored and their size
  // and type are known. Supabase Storage does it in that order — the row exists before the
  // object does — so at INSERT time the metadata is empty.
  //
  // Nothing here had ever run either statement. The fixture created storage.objects and left it
  // ungranted and policy-free, so every restrictive policy this repository writes over that
  // table was dead code in every gate, while being very much alive in production.
  //
  // Four receipts were claimed on the live system tonight. All four sit at `uploading` and the
  // bucket holds nothing.
  const asUpload = (uid, sql) => asUser(uid, sql);
  const claimPath = "ingest/iso-batch-1/iso-doc-000001.jpg";

  check("an uploader may reserve the object their claim named", () => {
    psql(`delete from storage.objects where bucket_id='receipts' and name like 'ingest/iso-%'`);
    // Exactly what Supabase Storage writes first: no size and no type, because the bytes have
    // not been stored yet.
    asUpload(A_UID, `insert into storage.objects(bucket_id,name,owner_id,metadata)
                     values ('receipts','${claimPath}','${A_UID}','{}'::jsonb)`);
    const stored = psql(`select count(*) from storage.objects
                          where bucket_id='receipts' and name='${claimPath}'`).trim();
    if (stored !== "1") throw new Error("the object row was refused, so no image can ever be stored");
  });

  check("the storage service may then record what it stored", () => {
    // Made by the storage service on its own connection, not by the browser. The live project
    // has no permissive UPDATE policy for authenticated at all, and the objects in the bucket
    // nevertheless carry their size and type — so running this as the user would be the fixture
    // inventing a permission production does not grant.
    psql(`update storage.objects
             set metadata='{"size":240641,"mimetype":"image/jpeg"}'::jsonb
           where bucket_id='receipts' and name='${claimPath}'`);
    const size = psql(`select coalesce(metadata->>'size','⟨none⟩') from storage.objects
                        where bucket_id='receipts' and name='${claimPath}'`).trim();
    if (size !== "240641") throw new Error(`the size was never recorded (${size})`);
  });

  check("an uploader cannot write outside the ingest namespace", () => {
    refused(A_UID, `insert into storage.objects(bucket_id,name,owner_id,metadata)
                    values ('receipts','elsewhere/iso-doc-2.jpg','${A_UID}','{}'::jsonb)`,
      "an object outside ingest/");
  });

  check("an uploader cannot put somebody else's name on an object", () => {
    refused(A_UID, `insert into storage.objects(bucket_id,name,owner_id,metadata)
                    values ('receipts','ingest/iso-batch-1/iso-doc-3.jpg','${B_UID}','{}'::jsonb)`,
      "an object owned by another person");
  });

  // The rule the update policy exists for. Once the bytes are stored and a claim points at them,
  // the evidence is fixed: swapping the object under a claimed receipt must be impossible.
  check("stored evidence a claim points at cannot be swapped", () => {
    psql(`insert into public.receipt_documents(
            id,flow,state,uploader_id,customer_id,storage_path,mime_type,tenant_id)
          values ('iso-doc-000001','customer_sells_to_zeman','created','iso-a','iso-a',
                  '${claimPath}','image/jpeg','t-sarkhel')
          on conflict (id) do update set storage_path=excluded.storage_path`);
    // A refused UPDATE does not raise. Row-level security filters the row out of the statement,
    // so the update simply touches nothing and returns quietly — which is why this asks what the
    // row says afterwards instead of waiting for an error that never comes. Reading that silence
    // as success is the whole reason this repository shipped a bucket that accepted nothing.
    try {
      asUpload(A_UID, `update storage.objects
                          set metadata='{"size":11,"mimetype":"image/jpeg"}'::jsonb
                        where bucket_id='receipts' and name='${claimPath}'`);
    } catch { /* refused outright is also correct */ }
    const size = psql(`select coalesce(metadata->>'size','⟨none⟩') from storage.objects
                        where bucket_id='receipts' and name='${claimPath}'`).trim();
    if (size !== "240641") throw new Error(`claimed evidence was swapped; the size is now ${size}`);
  });

  // ── the send, which reads back the object it is about to account for ────────
  //
  // sarraf_ingest_receipt_batch refuses a receipt whose staged object it cannot find:
  //
  //   if not exists (select 1 from storage.objects o where o.bucket_id='receipts'
  //     and o.name=v_path and o.owner_id=auth.uid()::text and ... ) then
  //     raise exception 'invalid staged object';
  //
  // That is a SELECT on storage.objects, made from a SECURITY DEFINER function owned by
  // sarraf_definer. Every policy this repository writes over that table is RESTRICTIVE, and a
  // restrictive policy can only take rows away — a role with no PERMISSIVE policy for SELECT
  // sees nothing at all, however true the restrictive ones are.
  //
  // The live database has exactly one permissive policy on storage.objects, rimg_insert, and it
  // is for INSERT. Nothing grants a read. Which would mean the send has never once been able to
  // confirm the image it was about to write a receipt for.
  check("the send can find the image it is about to account for", () => {
    const path = "ingest/iso-send-1/iso-send-000001.jpg";
    psql(`delete from storage.objects where bucket_id='receipts' and name='${path}'`);
    asUser(A_UID, `insert into storage.objects(bucket_id,name,owner_id,metadata)
                   values ('receipts','${path}','${A_UID}','{}'::jsonb)`);
    psql(`update storage.objects
             set metadata='{"size":147262,"mimetype":"image/jpeg"}'::jsonb
           where bucket_id='receipts' and name='${path}'`);
    // Exactly the existence test the ingestion command makes, as the role it makes it as.
    const seen = asDefiner(A_UID, `select count(*) from storage.objects o
      where o.bucket_id='receipts' and o.name='${path}'
        and o.owner_id=auth.uid()::text
        and coalesce((o.metadata->>'size')::bigint,0) between 1 and 10485760
        and lower(coalesce(o.metadata->>'mimetype','')) in
            ('image/jpeg','image/png','image/webp','image/heic','image/heif')`).trim();
    if (seen !== "1") {
      throw new Error(`the staged object is invisible to the command that must verify it (saw ${seen})`);
    }
  });

  // ── the send, end to end, exactly as the browser makes it ───────────────────
  //
  // Reading works now and the send still refuses, with a message that says nothing:
  //
  //   وێنەکان گەیشتن، بەڵام داتابەیس تۆماری نەکردن — فیشەکان نەگەیشتن
  //
  // ReceiptIngestionError replaces whatever the database said with that sentence, so the reason
  // exists and nobody can see it. This makes the same call the browser makes — same command key
  // shape, same batch, same receipt fields, same staged object — and lets the database speak.
  check("a customer can send the receipts they uploaded", () => {
    const batchId = "416e99b0-589f-4493-8a37-12d0bd414b56";
    const docId = "isosend0001aa";
    const path = `ingest/${batchId}/${docId}.jpg`;
    psql(`delete from public.receipts where batch_id='${batchId}'`);
    psql(`delete from public.receipt_batches where id='${batchId}'`);
    psql(`delete from public.receipt_ingestion_commands where batch_id='${batchId}'`);
    psql(`delete from storage.objects where bucket_id='receipts' and name='${path}'`);

    // A customer of this business, as the portal has one. Seeded with the triggers off and the
    // auth_id cleared first, the way the cast at the top of this file is: creating an account is
    // itself guarded, and `on conflict (id)` does not catch a collision on auth_id, which is its
    // own unique key.
    psql(`
      begin;
      set local session_replication_role = replica;
      delete from public.app_users where auth_id = '${CUS_UID}' and id <> 'iso-cus';
      insert into public.app_users(id,name,role,auth_id,tenant_id)
      values ('iso-cus','کڕیار','customer','${CUS_UID}','t-sarkhel')
      on conflict (id) do update set auth_id = excluded.auth_id, tenant_id = excluded.tenant_id;
      commit;`);

    // The image, stored by the browser and completed by the storage service.
    asUser(CUS_UID, `insert into storage.objects(bucket_id,name,owner_id,metadata)
                 values ('receipts','${path}','${CUS_UID}','{}'::jsonb)`);
    psql(`update storage.objects
             set metadata='{"size":264888,"mimetype":"image/jpeg"}'::jsonb
           where bucket_id='receipts' and name='${path}'`);
    // The claim the upload made, which is what the read policy recognises.
    psql(`insert into public.receipt_documents(
            id,flow,state,uploader_id,customer_id,batch_id,storage_path,mime_type,tenant_id)
          values ('${docId}','customer_sells_to_zeman','created','iso-cus','iso-cus',
                  '${batchId}','${path}','image/jpeg','t-sarkhel')
          on conflict (id) do nothing`);

    const batch = JSON.stringify({
      id: batchId, customer_id: "iso-cus", customer_name: "کڕیار", partner_id: null,
      // The route puts the minted token on the batch; the RPC redeems it and deletes the row.
      _authorization_token: "isoTokenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      direction: "in", currency: "CNY", total_gross: 1246.30, total_fee: 36.30,
      total_net: 1210.00, dup_n: 0, rejected_n: 0, source: "app",
    }).replace(/'/g, "''");
    const receipts = JSON.stringify([{
      id: docId, batch_id: batchId, customer_id: "iso-cus", customer_name: "کڕیار",
      direction: "in", amount: 1246.30, fee: 36.30, fee_original: 36.30, fee_discount: 0,
      platform: "Alipay", net_amount: 1210.00, currency: "CNY", sender: null,
      receiver: "**雷(个人)", ref_no: "2026082523001493341404720693",
      tx_time: "01:52:18", tx_date: "2026-08-25", bank: null, note: null,
      image_hash: "a".repeat(64), image_path: path, status: "ok", counted: true,
      intake_status: "accepted",
      reject_code: null, reject_reason: null, dup_of: null, dup_of_date: null, dup_of_who: null,
      raw: { ocr_v: 6, confidence: 0.95, attestation: null },
    }]).replace(/'/g, "''");

    // The real two steps. The browser's own RPC call is REFUSED by design — "not authorized by
    // the ingestion service" — and the client falls back to /api/receipt-ingestion, which mints
    // an authorization with the service key and then runs the same RPC under the caller's token.
    // Testing only the first step would be testing the refusal.
    const commandKey = `receipt-ingest:${batchId}`;
    psql(`
      begin;
      select set_config('request.jwt.claim.role','service_role',true);
      select set_config('request.jwt.claim.sub','',true);
      set local role service_role;
      insert into public.receipt_ingestion_authorizations(
        command_key, actor_id, authorization_token, expires_at)
      values ('${commandKey}','iso-cus','isoTokenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now() + interval '5 minutes')
      on conflict (command_key) do update set
        actor_id = excluded.actor_id,
        authorization_token = excluded.authorization_token,
        expires_at = excluded.expires_at;
      commit;`);

    const out = asUser(CUS_UID, `select public.sarraf_ingest_receipt_batch(
      '${batch}'::jsonb, '${receipts}'::jsonb, '${commandKey}')::text`);
    if (!out.includes("batch_id")) throw new Error(`the send returned: ${out.slice(0, 200)}`);
    // Accepted, not merely stored. The command records a rejected receipt too — with its image
    // and its reason — so counting rows would pass on a batch in which nothing was taken.
    if (!out.includes('"accepted_count": 1')) {
      throw new Error(`the send accepted nothing: ${out.slice(0, 200)}`);
    }
    const kept = psql(`select intake_status || ' ' || coalesce(rule_reason,'—')
                         from public.receipt_intake_items where batch_id='${batchId}'`).trim();
    if (!kept.startsWith("accepted")) throw new Error(`the receipt was recorded as: ${kept}`);
    const stage = psql(`select receipt_stage from public.receipt_batches where id='${batchId}'`).trim();
    if (stage !== "verified") throw new Error(`the batch reached the owner as '${stage}'`);
  });

  // ── and does the owner actually see it ──────────────────────────────────────
  //
  // Everything up to here proves the command committed. It does not prove the one thing the
  // owner cares about: that the batch turns up on their screen. Their receipts page reads
  //
  //   supabase.from("receipt_batches").select("*").order("created_at", ...).limit(200)
  //
  // as `authenticated`, under the tenant policy, and lists `status = 'new'` under فیشی نوێ. So
  // the batch must carry the customer's business — it is written by a command running as
  // sarraf_definer on the customer's behalf, so sarraf_tenant() must have resolved to theirs —
  // and it must have closed as new, which it only does when something was accepted.
  //
  // This is the last link that was never tested, and the whole question the owner has been
  // asking all morning: does a receipt reach سەرخێڵ.
  check("the owner sees the batch their customer sent", () => {
    const seen = asUser(A_UID, `select coalesce(string_agg(id || ':' || status || ':' || receipt_stage, ', '), '<none>')
                                  from public.receipt_batches
                                 where id = '416e99b0-589f-4493-8a37-12d0bd414b56'`).trim();
    if (!seen.includes("416e99b0")) {
      throw new Error(`the owner cannot see the batch at all: ${seen}`);
    }
    if (!seen.includes(":new:")) {
      throw new Error(`the batch is not waiting for the owner: ${seen}`);
    }
    if (!seen.includes("verified")) {
      throw new Error(`the batch did not reach the owner verified: ${seen}`);
    }
  });

  check("the owner can open it and read what was sent", () => {
    // sarraf_batch_summary is what the batch screen calls; it is the owner's whole view of it.
    const summary = asUser(A_UID,
      `select public.sarraf_batch_summary('416e99b0-589f-4493-8a37-12d0bd414b56')::text`);
    if (!summary.includes("accepted_count")) {
      throw new Error(`the owner cannot open the batch: ${summary.slice(0, 200)}`);
    }
    if (/"accepted_count"\s*:\s*0/.test(summary)) {
      throw new Error(`the owner opens it and finds nothing accepted: ${summary.slice(0, 240)}`);
    }
  });

  check("the other business never sees it", () => {
    const seen = asUser(B_UID, `select coalesce(string_agg(id, ', '), '<none>')
                                  from public.receipt_batches
                                 where id = '416e99b0-589f-4493-8a37-12d0bd414b56'`).trim();
    if (seen !== "<none>") throw new Error(`the other business can see it: ${seen}`);
  });

  // ── the three things the specification asked for and the schema did not have ─
  //
  //   ٥. کۆدی تایبەت (Unique Tracking ID)
  //   ٤. دووبارە بارکردنەوە: بەستەر بە فیشە ڕەتکراوەکەی پێشوو
  //   ٥. سیستەمی ئاگادارکردنەوە بۆ هەردولا
  //
  // All three are about two people agreeing on one receipt, so all three are tested from both
  // sides: what the customer who sent it sees, and what the business that received it sees.
  const SEND_BATCH = "416e99b0-589f-4493-8a37-12d0bd414b56";
  const SEND_DOC = "isosend0001aa";

  // A document may only be born at `created` and may only move one legal step at a time. A
  // fixture that needs a refused receipt therefore has to walk one there, the way a real one
  // walks: turning the guard off would turn off the emitters this section exists to test.
  const REFUSAL_PATH = ["uploading", "uploaded", "ocr_pending", "ocr_processing",
                        "parsed", "needs_manual_review"];
  const walkToRejected = (id, why) => {
    for (const state of REFUSAL_PATH) {
      psql(`update public.receipt_documents set state = '${state}' where id = '${id}'`);
    }
    psql(`update public.receipt_documents
             set state = 'rejected', counted = false,
                 rule_code = 'manual_reject', rule_reason = '${why}'
           where id = '${id}'`);
  };

  // A code nobody can quote is not an identifier. It must exist, it must read the way it was
  // specified — the date and the time to the second — and, above all, the document the customer
  // is looking at and the receipt row the owner is looking at must carry the SAME one. Two
  // tables minting their own codes for one piece of paper would be worse than no code at all.
  check("a receipt has one name, and both sides quote the same one", () => {
    const doc = psql(`select coalesce(tracking_code,'<none>') from public.receipt_documents
                       where id = '${SEND_DOC}'`).trim();
    if (!/^ZR-\d{8}-\d{6}-[A-Z0-9]{6,}$/.test(doc)) {
      throw new Error(`the intake document's name is '${doc}'`);
    }
    const row = psql(`select coalesce(tracking_code,'<none>') || ' ' || coalesce(document_id,'<unlinked>')
                        from public.receipts where id = '${SEND_DOC}'`).trim();
    if (row !== `${doc} ${SEND_DOC}`) {
      throw new Error(`the owner's row says '${row}', the customer's document says '${doc}'`);
    }
  });

  check("no two receipts can be given the same name", () => {
    let raised = false;
    try {
      psql(`update public.receipts set tracking_code =
              (select tracking_code from public.receipt_documents where id = '${SEND_DOC}')
             where id <> '${SEND_DOC}' limit 1`);
    } catch { raised = true; }
    const clashes = psql(`select count(*) from (
        select tracking_code from public.receipts where tracking_code is not null
         group by tracking_code having count(*) > 1) t`).trim();
    if (!raised && clashes !== "0") throw new Error(`${clashes} names are shared by more than one receipt`);
  });

  // The arrival. This is the notification the owner actually needs: somebody sent you receipts.
  // It must reach the business's staff, it must not be sent to the customer who caused it, and
  // it must never cross into the other business.
  check("the business is told when a batch arrives", () => {
    const mine = asUser(A_UID, `select coalesce(string_agg(kind || ':' || subject_id, ', '), '<none>')
                                  from public.zeman_notifications
                                 where subject_id = '${SEND_BATCH}'`).trim();
    if (!mine.includes("batch_arrived")) {
      throw new Error(`the owner was never told a batch arrived: ${mine}`);
    }
    const sender = asUser(CUS_UID, `select coalesce(string_agg(kind, ', '), '<none>')
                                      from public.zeman_notifications
                                     where subject_id = '${SEND_BATCH}'`).trim();
    if (sender !== "<none>") {
      throw new Error(`the customer was told about their own send: ${sender}`);
    }
  });

  check("the other business is never told", () => {
    const theirs = asUser(B_UID, `select coalesce(string_agg(kind, ', '), '<none>')
                                    from public.zeman_notifications
                                   where subject_id = '${SEND_BATCH}'`).trim();
    if (theirs !== "<none>") throw new Error(`the other business was told: ${theirs}`);
  });

  // The refusal, and the way back out of it. A rejected receipt tells the person who sent it
  // why, and the replacement they send is linked to it — in both directions, once, and only
  // inside their own business.
  check("a rejected receipt tells the person who sent it, and says why", () => {
    walkToRejected(SEND_DOC, "وێنەکە ڕوون نییە");
    const told = asUser(CUS_UID, `select coalesce(string_agg(kind || ' | ' || body, ' ;; '), '<none>')
                                    from public.zeman_notifications
                                   where subject_id = '${SEND_DOC}'`).trim();
    if (!told.includes("receipt_rejected")) throw new Error(`the uploader was never told: ${told}`);
    if (!told.includes("وێنەکە ڕوون نییە")) throw new Error(`the reason was not passed on: ${told}`);
  });

  check("an accepted receipt tells the person who sent it too", () => {
    psql(`delete from public.receipt_documents where id = 'isoacc00001dd'`);
    psql(`insert into public.receipt_documents(
            id,flow,state,uploader_id,customer_id,storage_path,mime_type,tenant_id)
          values ('isoacc00001dd','customer_sells_to_zeman','created','iso-cus','iso-cus',
                  'ingest/${SEND_BATCH}/isoacc00001dd.jpg','image/jpeg','t-sarkhel')`);
    // `validated` is refused unless a reading exists that names the recipient, the date, the
    // platform and whether there was a fee. That guard is not what is under test here, so the
    // fixture supplies what it asks for rather than working around it.
    psql(`insert into public.receipt_extractions(
            document_id,version,is_original,provider,model,raw,
            gross_amount,fee_amount,net_amount,currency,ref_no,payee,tx_date,tx_time,
            platform,has_fee,tenant_id)
          values ('isoacc00001dd',1,true,'verify','iso','{}'::jsonb,
                  1246.30,36.30,1210.00,'CNY','ISOACC1','**لەیلا','2026-08-25','01:52',
                  'alipay',true,'t-sarkhel')
          on conflict do nothing`);
    for (const state of ["uploading", "uploaded", "ocr_pending", "ocr_processing",
                         "parsed", "validated", "submitted", "accepted"]) {
      psql(`update public.receipt_documents set state = '${state}' where id = 'isoacc00001dd'`);
    }
    const told = asUser(CUS_UID, `select coalesce(string_agg(kind, ', '), '<none>')
                                    from public.zeman_notifications
                                   where subject_id = 'isoacc00001dd'`).trim();
    if (!told.includes("receipt_accepted")) throw new Error(`the uploader was never told: ${told}`);
  });

  const REPLACEMENT = "isosend0002bb";
  check("the uploader may send a replacement, and it is linked to the rejection", () => {
    psql(`delete from public.receipt_documents where id = '${REPLACEMENT}'`);
    psql(`insert into public.receipt_documents(
            id,flow,state,uploader_id,customer_id,storage_path,mime_type,tenant_id)
          values ('${REPLACEMENT}','customer_sells_to_zeman','created','iso-cus','iso-cus',
                  'ingest/${SEND_BATCH}/${REPLACEMENT}.jpg','image/jpeg','t-sarkhel')`);
    const out = asUser(CUS_UID,
      `select public.sarraf_receipt_replace('${SEND_DOC}','${REPLACEMENT}')::text`);
    if (!out.includes('"replayed": false')) throw new Error(`the replacement was refused: ${out.slice(0, 200)}`);
    const links = psql(`select coalesce((select replaced_by_document_id from public.receipt_documents where id='${SEND_DOC}'),'<none>')
                        || ' / ' ||
                        coalesce((select replaces_document_id from public.receipt_documents where id='${REPLACEMENT}'),'<none>')`).trim();
    if (links !== `${REPLACEMENT} / ${SEND_DOC}`) throw new Error(`the chain reads: ${links}`);
  });

  check("pressing it twice changes nothing", () => {
    const again = asUser(CUS_UID,
      `select public.sarraf_receipt_replace('${SEND_DOC}','${REPLACEMENT}')::text`);
    if (!again.includes('"replayed": true')) throw new Error(`a second press was not a replay: ${again.slice(0, 200)}`);
  });

  check("a receipt may be replaced only once", () => {
    psql(`delete from public.receipt_documents where id = 'isosend0003cc'`);
    psql(`insert into public.receipt_documents(
            id,flow,state,uploader_id,customer_id,storage_path,mime_type,tenant_id)
          values ('isosend0003cc','customer_sells_to_zeman','created','iso-cus','iso-cus',
                  'ingest/${SEND_BATCH}/isosend0003cc.jpg','image/jpeg','t-sarkhel')`);
    refused(CUS_UID, `select public.sarraf_receipt_replace('${SEND_DOC}','isosend0003cc')`,
      "replacing a receipt that already has a replacement");
  });

  check("a receipt still under review cannot be quietly replaced", () => {
    // isosend0003cc is where every new upload starts: nobody has refused it, so nothing about
    // it may be replaced away.
    refused(CUS_UID, `select public.sarraf_receipt_replace('isosend0003cc','${REPLACEMENT}')`,
      "replacing a receipt nobody has refused");
  });

  check("a replacement cannot cross into another business", () => {
    psql(`delete from public.receipt_documents where id = 'isootherbiz1'`);
    psql(`insert into public.receipt_documents(
            id,flow,state,uploader_id,customer_id,storage_path,mime_type,tenant_id)
          values ('isootherbiz1','customer_sells_to_zeman','created','iso-b','iso-b',
                  'ingest/other/isootherbiz1.jpg','image/jpeg','t-watan')`);
    walkToRejected("isootherbiz1", "هی بزنسێکی تر");
    refused(CUS_UID, `select public.sarraf_receipt_replace('isootherbiz1','isosend0003cc')`,
      "replacing another business's receipt");
  });

  // ── and when it refuses, it says which rule ─────────────────────────────────
  //
  // Every refusal was written down as 'server_rejected' / "فیشەکە یاساکانی ناردنی نەبڕیوە",
  // which names nothing, and the uploader was told they were duplicates whatever the cause. The
  // most common cause is the first rule: a browser that never claimed acceptance, which almost
  // always means it is running an older bundle.
  check("a refused receipt says which rule refused it", () => {
    const send = (suffix, overrides) => {
      const bid = `refuse${suffix}-4753-ab10-4237115159b8`;
      const rid = `isoref${suffix}0001`;
      const p = `ingest/${bid}/${rid}.jpg`;
      psql(`delete from public.receipt_intake_items where batch_id='${bid}'`);
      psql(`delete from public.receipt_batches where id='${bid}'`);
      psql(`delete from storage.objects where bucket_id='receipts' and name='${p}'`);
      asUser(CUS_UID, `insert into storage.objects(bucket_id,name,owner_id,metadata)
                       values ('receipts','${p}','${CUS_UID}','{}'::jsonb)`);
      psql(`update storage.objects set metadata='{"size":264888,"mimetype":"image/jpeg"}'::jsonb
             where bucket_id='receipts' and name='${p}'`);
      const key = `receipt-ingest:${bid}`;
      const tok = "isoTokenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      psql(`
        begin;
        select set_config('request.jwt.claim.role','service_role',true);
        set local role service_role;
        insert into public.receipt_ingestion_authorizations(command_key,actor_id,authorization_token,expires_at)
        values ('${key}','iso-cus','${tok}', now() + interval '5 minutes')
        on conflict (command_key) do update set expires_at = excluded.expires_at;
        commit;`);
      const b = JSON.stringify({ id: bid, customer_id: "iso-cus", customer_name: "کڕیار",
        partner_id: null, direction: "in", currency: "CNY", _authorization_token: tok,
        source: "app" }).replace(/'/g, "''");
      const rows = JSON.stringify([{ id: rid, batch_id: bid, customer_id: "iso-cus",
        direction: "in", amount: 1246.30, fee: 36.30, net_amount: 1210.00, currency: "CNY",
        ref_no: `ISOREF${suffix}`, image_hash: suffix.padEnd(64, "b").slice(0, 64),
        image_path: p, status: "ok", counted: true, intake_status: "accepted",
        raw: {}, ...overrides }]).replace(/'/g, "''");
      asUser(CUS_UID, `select public.sarraf_ingest_receipt_batch('${b}'::jsonb,'${rows}'::jsonb,'${key}')`);
      return psql(`select rule_code from public.receipt_intake_items where batch_id='${bid}'`).trim();
    };

    // The one that has been happening: an older browser, sending no verdict at all.
    const noVerdict = send("aaaa", { intake_status: undefined });
    if (noVerdict !== "not_submitted_for_acceptance") {
      throw new Error(`a receipt with no verdict was refused as '${noVerdict}'`);
    }
    const wrongCurrency = send("bbbb", { currency: "USD" });
    if (wrongCurrency !== "currency_not_the_batch") {
      throw new Error(`a receipt in another currency was refused as '${wrongCurrency}'`);
    }
    const badFee = send("cccc", { fee: 9999 });
    if (badFee !== "invalid_fee") throw new Error(`a fee larger than the amount was refused as '${badFee}'`);
    // The uploader's own reason is not overwritten by the command's.
    const mine = send("dddd", { status: "error", counted: false, intake_status: "rejected",
      reject_code: "unreadable", reject_reason: "وێنەکە نەخوێندرایەوە" });
    if (mine !== "unreadable") throw new Error(`the uploader's own reason became '${mine}'`);
  });

  // A refusal at the door is the common one — seven of this morning's nine — and until now it
  // was written on the intake item and nowhere the uploader can see. Their own screen called
  // those receipts «چاوەڕوانی پشکنین», nobody was told, and the re-upload button never appeared
  // on the receipts that needed it most.
  check("a receipt refused as it is sent is refused on the uploader's screen too", () => {
    const bid = "doorref-4753-ab10-4237115159b8";
    const rid = "isodoor00001";
    const p = `ingest/${bid}/${rid}.jpg`;
    psql(`delete from public.receipt_intake_items where batch_id='${bid}'`);
    psql(`delete from public.receipt_batches where id='${bid}'`);
    psql(`delete from public.receipt_documents where id='${rid}'`);
    psql(`delete from storage.objects where bucket_id='receipts' and name='${p}'`);
    asUser(CUS_UID, `insert into storage.objects(bucket_id,name,owner_id,metadata)
                     values ('receipts','${p}','${CUS_UID}','{}'::jsonb)`);
    psql(`update storage.objects set metadata='{"size":264888,"mimetype":"image/jpeg"}'::jsonb
           where bucket_id='receipts' and name='${p}'`);
    // The document as the upload leaves it: read, waiting to be sent.
    psql(`insert into public.receipt_documents(
            id,flow,state,uploader_id,customer_id,storage_path,mime_type,tenant_id)
          values ('${rid}','customer_sells_to_zeman','created','iso-cus','iso-cus',
                  '${p}','image/jpeg','t-sarkhel')`);
    for (const state of ["uploading", "uploaded", "ocr_pending", "ocr_processing", "parsed"]) {
      psql(`update public.receipt_documents set state='${state}' where id='${rid}'`);
    }

    const key = `receipt-ingest:${bid}`;
    const tok = "isoTokenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    psql(`
      begin;
      select set_config('request.jwt.claim.role','service_role',true);
      set local role service_role;
      insert into public.receipt_ingestion_authorizations(command_key,actor_id,authorization_token,expires_at)
      values ('${key}','iso-cus','${tok}', now() + interval '5 minutes')
      on conflict (command_key) do update set expires_at = excluded.expires_at;
      commit;`);
    const b = JSON.stringify({ id: bid, customer_id: "iso-cus", customer_name: "کڕیار",
      partner_id: null, direction: "in", currency: "CNY", _authorization_token: tok,
      source: "app" }).replace(/'/g, "''");
    // A currency that is not the batch's: refused at the door, by name.
    const rows = JSON.stringify([{ id: rid, batch_id: bid, customer_id: "iso-cus",
      direction: "in", amount: 1246.30, fee: 36.30, net_amount: 1210.00, currency: "USD",
      ref_no: "ISODOOR1", image_hash: "d".repeat(64), image_path: p, status: "ok",
      counted: true, intake_status: "accepted", raw: {} }]).replace(/'/g, "''");
    asUser(CUS_UID, `select public.sarraf_ingest_receipt_batch('${b}'::jsonb,'${rows}'::jsonb,'${key}')`);

    const doc = psql(`select state || ' / ' || coalesce(rule_code,'⟨none⟩')
                        from public.receipt_documents where id='${rid}'`).trim();
    if (!doc.startsWith("rejected")) {
      throw new Error(`the uploader's own screen still shows this receipt as '${doc}'`);
    }
    if (!doc.includes("currency_not_the_batch")) {
      throw new Error(`the rule that refused it was not carried across: ${doc}`);
    }
    const told = asUser(CUS_UID, `select coalesce(string_agg(kind, ', '), '<none>')
                                    from public.zeman_notifications where subject_id='${rid}'`).trim();
    if (!told.includes("receipt_rejected")) {
      throw new Error(`the person who sent it was never told: ${told}`);
    }
  });

  // ── and can the owner find it again ─────────────────────────────────────────
  //
  // A code exists so it can be quoted down a phone and typed in at the other end. Until today
  // the search matched prefixes only, so a receipt could be found only by typing the first
  // characters of its reference — and it did not know tracking codes existed at all.
  check("the owner finds a receipt by the code its sender read out", () => {
    const code = psql(`select tracking_code from public.receipts where id = '${SEND_DOC}'`).trim();
    if (!code.startsWith("ZR-")) throw new Error(`the receipt has no code to search for: ${code}`);
    const hit = asUser(A_UID,
      `select coalesce(string_agg(type || '|' || label || '|' || coalesce(focus,'—'), ', '), '<none>')
         from public.sarraf_operational_search('${code}', 20, null)`).trim();
    if (!hit.includes(`receipt|${code}`)) throw new Error(`searching the code found: ${hit}`);
    if (!hit.includes("416e99b0")) throw new Error(`the result does not say which batch to open: ${hit}`);
  });

  // The half of the code a person actually reads out is the end of it. Prefix matching made
  // that useless.
  check("the tail of a code finds it, not only the head", () => {
    const code = psql(`select tracking_code from public.receipts where id = '${SEND_DOC}'`).trim();
    const tail = code.slice(-6);
    const hit = asUser(A_UID, `select coalesce(string_agg(label, ', '), '<none>')
                                 from public.sarraf_operational_search('${tail}', 20, null)`).trim();
    if (!hit.includes(code)) throw new Error(`searching '${tail}' found: ${hit}`);
  });

  check("a receipt is found by its amount", () => {
    const hit = asUser(A_UID, `select coalesce(string_agg(type || '|' || label, ', '), '<none>')
                                 from public.sarraf_operational_search('1246', 20, null)`).trim();
    if (!hit.includes("receipt|ZR-")) throw new Error(`searching an amount found: ${hit}`);
  });

  check("the other business cannot search its way to it", () => {
    const code = psql(`select tracking_code from public.receipts where id = '${SEND_DOC}'`).trim();
    const hit = asUser(B_UID, `select coalesce(string_agg(label, ', '), '<none>')
                                 from public.sarraf_operational_search('${code}', 20, null)`).trim();
    if (hit !== "<none>") throw new Error(`the other business found it: ${hit}`);
  });

  // A customer of the same business must not be able to type a code and read a receipt that is
  // not theirs. The tenant policy does not separate them — they are in the same business.
  check("a customer searches their own receipts and nobody else's", () => {
    psql(`update public.receipt_batches set customer_id = 'iso-a', partner_id = null
           where id = '416e99b0-589f-4493-8a37-12d0bd414b56'`);
    const code = psql(`select tracking_code from public.receipts where id = '${SEND_DOC}'`).trim();
    const hit = asUser(CUS_UID, `select coalesce(string_agg(label, ', '), '<none>')
                                   from public.sarraf_operational_search('${code}', 20, null)`).trim();
    psql(`update public.receipt_batches set customer_id = 'iso-cus'
           where id = '416e99b0-589f-4493-8a37-12d0bd414b56'`);
    if (hit !== "<none>") {
      throw new Error(`a customer read another customer's receipt out of the search: ${hit}`);
    }
  });

  // ── the server's own key, calling a definer function ────────────────────────
  //
  // /api/receipt-ocr downloads the stored original and records what the reader saw through
  // sarraf_receipt_record_server_extraction, which is granted to service_role and to nobody
  // else. service_role holds BYPASSRLS, so on its own it sees every row in the database.
  //
  // The function does not run as service_role. 202608250001 gave it to sarraf_definer so that a
  // definer function could not bypass tenancy — and sarraf_definer IS subject to the tenant
  // policy, which asks sarraf_tenant_visible(tenant_id), which asks who auth.uid() is. On a
  // service-key request there is no user: auth.uid() is null, sarraf_tenant() is null,
  // sees_all_tenants is false, and the row is invisible. The function then raises "receipt
  // intake not found", the route turns that into ocr_record_failed, and nothing is written
  // anywhere — no attempt row, no state change, no error code on the document.
  //
  // Which is exactly what the live system shows for every receipt uploaded since that migration
  // was applied on 25 August. The last image it ever read was on the 17th.
  const asService = (sql) => {
    const out = psql(
      `begin;
       select set_config('request.jwt.claim.role','service_role',true);
       select set_config('request.jwt.claim.sub','',true);
       set local role service_role;
       ${sql};
       commit;`);
    const lines = String(out).split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? "";
  };

  check("the server's key can record what the reader saw", () => {
    psql(`insert into public.receipt_documents(
            id,flow,state,uploader_id,customer_id,storage_path,mime_type,tenant_id)
          values ('iso-ocr-000001','customer_sells_to_zeman','created','iso-a','iso-a',
                  'ingest/iso-batch-1/iso-ocr-000001.jpg','image/jpeg','t-sarkhel')
          on conflict (id) do nothing`);
    psql(`update public.receipt_documents set state='uploading' where id='iso-ocr-000001'`);
    const out = asService(`select public.sarraf_receipt_record_server_extraction(
      'iso-ocr-000001','${"b".repeat(64)}',24680,'image/jpeg',true,
      '{"grossAmount":"1260.20","feeAmount":"36.70","netAmount":"1223.50","currency":"CNY",
        "refNo":"ISOR1","payee":"ئەحمەد","txDate":"2026-08-01","txTime":"11:04",
        "platform":"wechat","feeTreatment":"deducted_from_principal",
        "transactionStatus":"success","confidence":0.93}'::jsonb,
      'verify','iso',120,'iso-request-1')::text`);
    if (!out.includes("document_id")) throw new Error(`the server got: ${out.slice(0, 200)}`);
    const state = psql("select state from public.receipt_documents where id='iso-ocr-000001'").trim();
    if (state === "uploading") throw new Error("the reading was never recorded; the receipt never moves");
  });

  // ── the hole that reopens every time somebody adds a function ───────────────
  //
  // 202608250001 moved 131 SECURITY DEFINER functions to sarraf_definer, a role with no
  // BYPASSRLS, so that a command reaches only the rows the caller's own business may see. It
  // moved the functions that existed that day, and nothing has watched since. A definer
  // function added by a later migration is owned by whoever ran it — postgres, which bypasses
  // row-level security — so one new function is a way straight through the tenancy, and every
  // check above would still pass.
  //
  // This asks the question the ownership move answered once: is there any of them, today, whose
  // owner can ignore a policy?
  // PostgreSQL grants EXECUTE on every new function to PUBLIC, and PUBLIC includes anon — the
  // role a browser holds before anybody signs in. 202608310005 closed the nineteen that had it;
  // this is what stops the twentieth from arriving. A migration that writes
  // `grant execute ... to authenticated` and nothing else adds a grant without removing the one
  // that was already there, which is exactly how all nineteen happened.
  check("nothing a signed-out browser holds can call a command", () => {
    const open = psql(`
      select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by p.proname), '')
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.prosecdef
         and has_function_privilege('anon', p.oid, 'execute')`).trim();
    if (open) throw new Error(`a signed-out browser may call: ${open}`);
  });

  // A trigger function is run by the trigger mechanism, which checks EXECUTE when the trigger is
  // created and not when it fires. A grant on one is surface with nothing behind it.
  check("no trigger function is callable by anybody", () => {
    const open = psql(`
      select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by p.proname), '')
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname like 'sarraf%'
         and p.prorettype = 'pg_catalog.trigger'::regtype
         and (has_function_privilege('authenticated', p.oid, 'execute')
              or has_function_privilege('anon', p.oid, 'execute'))`).trim();
    if (open) throw new Error(`a browser may call these trigger functions: ${open}`);
  });

  // FORCE is the other half of moving the definer functions to a nobypassrls role. Without it
  // the table's owner is exempt from its own policies, so every function owned by that role
  // reads and writes as though no policy existed.
  // Three questions, not two.
  //
  // The first version of this check asked whether RLS was on and whether FORCE was set, and
  // stopped there. INSPECT asks a third — is there a RESTRICTIVE policy — and the difference
  // showed up on the live database rather than here: FORCE went on, and two tables were then
  // reported as having no restrictive policy at all, one of them a table added in the same
  // change as this check. A gate that asks two thirds of the question passes work the report
  // then refuses.
  //
  // The third question is the one that lasts. RLS and FORCE say the policies are consulted;
  // a RESTRICTIVE policy is what stops a permissive policy added next year from widening what
  // they allow, because restrictive policies are ANDed and permissive ones are ORed.
  check("every table that names a business obeys its own policies", () => {
    const loose = psql(`
      select coalesce(string_agg(c.relname || ' (' ||
               case when not c.relrowsecurity then 'RLS off'
                    when not c.relforcerowsecurity then 'no FORCE'
                    else 'no restrictive policy' end || ')',
               ', ' order by c.relname), '')
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       where c.relkind = 'r'
         and exists (select 1 from information_schema.columns col
                      where col.table_schema = 'public' and col.table_name = c.relname
                        and col.column_name = 'tenant_id')
         and (not c.relrowsecurity
              or not c.relforcerowsecurity
              or not exists (select 1 from pg_policies pp
                              where pp.schemaname = 'public' and pp.tablename = c.relname
                                and pp.permissive = 'RESTRICTIVE'))`).trim();
    if (loose) throw new Error(`these can be written past their own policies: ${loose}`);
  });

  check("no SECURITY DEFINER function can bypass row-level security", () => {
    const loose = psql(`
      select coalesce(string_agg(p.oid::regprocedure::text || ' (owned by ' || o.rolname || ')',
                                 ', ' order by p.proname), '')
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
        join pg_roles o on o.oid = p.proowner
       where p.prosecdef
         and p.prorettype <> 'pg_catalog.trigger'::regtype
         -- Consulted from inside policies. A policy helper that is itself subject to policies
         -- recurses into the table it is being consulted about, so these must keep bypassing.
         -- Each reads the caller's own row and returns nothing else.
         and p.proname not in ('sarraf_tenant','sarraf_tenant_visible','sarraf_sees_all_tenants',
                               'sarraf_reset_installation','is_admin','my_app_id','my_role',
         -- And the two the server calls with its own key and no user attached. A policy that
         -- asks who auth.uid() is answers "nobody" on those requests and hides every row, which
         -- is how the receipt reader was silently dead for nine days. The check below is what
         -- makes this exception safe: neither may be callable from a browser.
                               'sarraf_receipt_record_server_extraction',
                               'sarraf_office_payment_attach_evidence_server',
         -- And the third, for the same reason: api/admin-user.js asks it, holding the service
         -- key and no session, which business the manager currently has open. A definer bound
         -- by the tenant policies would answer null for every manager on every request.
                               'sarraf_manager_support_tenant_for')
         and (o.rolbypassrls or o.rolsuper)`).trim();
    if (loose) throw new Error(`these run as a role that ignores every policy: ${loose}`);
  });

  check("the functions allowed to bypass tenancy are closed to every browser", () => {
    const open = psql(`
      select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
       where p.proname in ('sarraf_receipt_record_server_extraction',
                           'sarraf_office_payment_attach_evidence_server',
                           'sarraf_manager_support_tenant_for')
         and (has_function_privilege('authenticated', p.oid, 'execute')
              or has_function_privilege('anon', p.oid, 'execute'))`).trim();
    if (open) throw new Error(`a browser can call these, and they bypass tenancy: ${open}`);
  });

  // ── the fault report is a write path a user can trigger at will ─────────────
  //
  // An error reporter is the one table an ordinary browser fills on purpose, in a system that
  // holds other people's money. Three things have to stay true of it, and none of them is
  // enforced by the caller — a future caller could forget every one.
  check("one business cannot read another's faults", () => {
    asUser(A_UID, `select public.sarraf_record_fault(
      'render','TypeError','receipts','isolationprint0001','r.map is not a function','Safari · iOS')`);
    const mine = asUser(A_UID, "select count(*) from public.zeman_faults").trim();
    const theirs = asUser(B_UID, "select count(*) from public.zeman_faults").trim();
    if (Number(mine) < 1) throw new Error(`the business that hit the fault saw ${mine} of it`);
    if (Number(theirs) !== 0) throw new Error(`the other business saw ${theirs} faults that are not theirs`);
  });

  check("a crash loop is counted, not appended", () => {
    for (let i = 0; i < 40; i += 1) {
      asUser(A_UID, `select public.sarraf_record_fault(
        'render','TypeError','receipts','loopprint00000001','same fault again','Safari · iOS')`);
    }
    const rows = psql(`select count(*) from public.zeman_faults
                        where fingerprint = 'loopprint00000001'`).trim();
    const seen = psql(`select seen from public.zeman_faults
                        where fingerprint = 'loopprint00000001'`).trim();
    if (rows !== "1") throw new Error(`forty crashes wrote ${rows} rows — the table can be filled`);
    if (Number(seen) < 40) throw new Error(`forty crashes counted as ${seen}`);
  });

  check("one browser cannot report an unbounded number of different faults", () => {
    let refused = 0;
    for (let i = 0; i < 30; i += 1) {
      const out = asUser(A_UID, `select public.sarraf_record_fault(
        'render','TypeError','receipts','flood' || lpad(${i}::text, 11, '0'))::text`);
      if (out.includes("too many")) refused += 1;
    }
    if (refused === 0) throw new Error("a browser may report any number of distinct faults");
  });

  check("nothing a browser sends can grow past its bound", () => {
    asUser(A_UID, `select public.sarraf_record_fault(
      'render','${"c".repeat(200)}','${"s".repeat(200)}','boundprint0000001',
      '${"d".repeat(900)}','${"a".repeat(400)}')`);
    const worst = psql(`select coalesce(max(char_length(detail)),0) || '/' ||
                               coalesce(max(char_length(code)),0) || '/' ||
                               coalesce(max(char_length(agent)),0)
                          from public.zeman_faults`).trim();
    const [detail, code, agent] = worst.split("/").map(Number);
    if (detail > 200 || code > 40 || agent > 120) {
      throw new Error(`a field grew past its bound — detail/code/agent = ${worst}`);
    }
  });

  // ── money that belongs to no business ───────────────────────────────────────
  //
  // tenant_id defaults to sarraf_tenant(), which reads auth.uid(). A route holding the service
  // key has no auth.uid(); nor does a trigger inside a SECURITY DEFINER command, nor a
  // maintenance connection. The default then yields null, and because every tenant policy on
  // these tables is RESTRICTIVE the row becomes invisible to everybody — including the business
  // that created it. Money nobody can see is worse than money in the wrong place.
  check("a batch written with no session is still given its business", () => {
    psql(`insert into public.receipt_batches(id,customer_id,customer_name,direction,status,currency,uploaded_by)
          values ('bat-nosession','iso-a','A','sell','pending','CNY','iso-a')`);
    const owner = psql(`select coalesce(tenant_id,'<none>') from public.receipt_batches where id='bat-nosession'`).trim();
    if (owner !== "t-sarkhel") throw new Error(`the batch went to ${owner}, not to the uploader's business`);
  });

  check("a receipt takes the business of the batch it arrived in", () => {
    psql(`insert into public.receipts(id,batch_id,direction,amount,fee,currency,status)
          values ('rec-nosession','bat-b','sell',100,1,'CNY','ok')`);
    const owner = psql(`select coalesce(tenant_id,'<none>') from public.receipts where id='rec-nosession'`).trim();
    if (owner !== "t-watan") throw new Error(`the receipt went to ${owner}, not to its batch's business`);
  });

  check("a ledger line takes the business of the transaction it accounts for", () => {
    // A pending transaction needs a registered customer, and this fixture has none in t-watan.
    psql(`insert into public.app_users(id,name,role,tenant_id) values ('iso-cust-b','Customer B','customer','t-watan')
          on conflict (id) do nothing`);
    psql(`insert into public.txs(id,code,type,cp_id,cur_id,amount,rate,against_id,total,status,date,tenant_id)
          values ('tx-nosession',990001,'buy','iso-cust-b','cny',100,1,'usd',100,'pending',current_date,'t-watan')`);
    psql(`insert into public.ledger(id,type,owner,cur_id,amount,tx_id,date)
          values ('led-nosession','settlement','main','cny',100,'tx-nosession',current_date)`);
    const owner = psql(`select coalesce(tenant_id,'<none>') from public.ledger where id='led-nosession'`).trim();
    if (owner !== "t-watan") throw new Error(`the ledger line went to ${owner}, not to its transaction's business`);
  });

  check("a row that names no business at all is refused, not silently hidden", () => {
    let refused = "";
    try {
      psql(`insert into public.receipt_batches(id,customer_id,customer_name,direction,status,currency)
            values ('bat-orphan','nobody-at-all','X','sell','pending','CNY')`);
    } catch (error) { refused = String(error.message || error); }
    if (!refused) throw new Error("a batch belonging to no business was accepted");
    if (!/belongs to no business/.test(refused)) {
      throw new Error(`refused, but for the wrong reason: ${refused.slice(0, 200)}`);
    }
    const landed = psql(`select count(*) from public.receipt_batches where id='bat-orphan'`).trim();
    if (landed !== "0") throw new Error("the refused batch was written anyway");
  });

  check("a row that says its business is believed", () => {
    psql(`insert into public.receipt_batches(id,customer_id,customer_name,direction,status,currency,uploaded_by,tenant_id)
          values ('bat-explicit','iso-a','A','sell','pending','CNY','iso-a','t-watan')`);
    const owner = psql(`select tenant_id from public.receipt_batches where id='bat-explicit'`).trim();
    if (owner !== "t-watan") throw new Error(`the row said t-watan and landed in ${owner}`);
  });

  // ── the record-keeping tables, where the rule is softer on purpose ──────────
  //
  // On a transaction or a ledger line a row with no business is refused: writing money nobody
  // can see is worse than failing. On a log it is not. A trigger that could veto a payment
  // because it failed to label the audit entry would turn a record-keeping problem into an
  // outage — so here the business is worked out, and a row that names nothing at all is still
  // written. INSPECT is what reports those.
  check("a receipt's own history takes the business of the receipt", () => {
    psql(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,storage_path,tenant_id)
          values ('doc-story','customer_sells_to_zeman','created','bat-b','iso-b','ingest/bat-b/doc-story.jpg','t-watan')`);
    psql(`insert into public.receipt_state_transitions(document_id,from_state,to_state,actor_id)
          values ('doc-story','created','uploaded','iso-b')`);
    // The document insert fires its own transition as well as the one written here, so ask for
    // the distinct answer rather than a row: what matters is that no step landed unlabelled.
    const owner = psql(`select string_agg(distinct coalesce(tenant_id,'<none>'), ',')
                          from public.receipt_state_transitions where document_id='doc-story'`).trim();
    if (owner !== "t-watan") throw new Error(`the steps went to ${owner}, not all to its receipt's business`);
  });

  check("an audit line takes the business of the person who acted", () => {
    psql(`insert into public.audit(id,date,user_id,action,detail)
          values ('aud-nosession',now(),'iso-a','ڕاهێنان','test')`);
    const owner = psql(`select coalesce(tenant_id,'<none>') from public.audit where id='aud-nosession'`).trim();
    if (owner !== "t-sarkhel") throw new Error(`the audit line went to ${owner}, not to the actor's business`);
  });

  check("a note addressed to nobody takes the business of what it points at", () => {
    psql(`insert into public.notes(id,user_id,kind,title,body,ref_id)
          values ('note-nosession',null,'receipt','t','b','bat-a')`);
    const owner = psql(`select coalesce(tenant_id,'<none>') from public.notes where id='note-nosession'`).trim();
    if (owner !== "t-sarkhel") throw new Error(`the note went to ${owner}, not to its batch's business`);
  });

  check("a log entry that names nothing is still written, not allowed to fail the operation", () => {
    psql(`insert into public.audit(id,date,user_id,action,detail)
          values ('aud-orphan',now(),null,'ڕاهێنان','no actor at all')`);
    const landed = psql(`select count(*) from public.audit where id='aud-orphan'`).trim();
    if (landed !== "1") throw new Error("an unlabelled audit line was refused, which would take the operation down with it");
  });

  // ── an upload that never arrived ────────────────────────────────────────────
  //
  // Five of these were sitting in the live database from 26 and 27 August, still `uploading` on
  // the 31st, each one holding its batch open for an image that was never coming.
  check("the uploader can say the image never arrived", () => {
    // The machine starts every document at `created`; `uploading` is the step after it.
    psql(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,storage_path,tenant_id,received_at)
          values ('doc-lost','customer_sells_to_zeman','created','bat-a','iso-a','ingest/bat-a/doc-lost.jpg','t-sarkhel', now() - interval '3 hours')`);
    psql(`update public.receipt_documents set state='uploading' where id='doc-lost'`);
    const out = JSON.parse(asDefiner(A_UID,
      `select public.sarraf_receipt_upload_failed('doc-lost','network')::text`));
    if (out.moved !== true) throw new Error(`the document did not move: ${JSON.stringify(out)}`);
    const state = psql(`select state from public.receipt_documents where id='doc-lost'`).trim();
    if (state !== "upload_failed_retryable") throw new Error(`the document is ${state}`);
  });

  check("saying it twice is saying it once", () => {
    const out = JSON.parse(asDefiner(A_UID,
      `select public.sarraf_receipt_upload_failed('doc-lost','network')::text`));
    if (out.moved !== false) throw new Error("a second report was treated as a new one");
  });

  check("one business cannot close another's abandoned upload", () => {
    // The machine starts every document at `created`; `uploading` is the step after it.
    psql(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,storage_path,tenant_id,received_at)
          values ('doc-lost-b','customer_sells_to_zeman','created','bat-b','iso-b','ingest/bat-b/doc-lost-b.jpg','t-watan', now() - interval '3 hours')`);
    psql(`update public.receipt_documents set state='uploading' where id='doc-lost-b'`);
    const out = JSON.parse(asDefiner(A_UID,
      `select public.sarraf_receipt_close_abandoned_uploads(60)::text`));
    if (String(out.documents || "").includes("doc-lost-b")) {
      throw new Error("an administrator closed another business's upload");
    }
    const state = psql(`select state from public.receipt_documents where id='doc-lost-b'`).trim();
    if (state !== "uploading") throw new Error(`the other business's document became ${state}`);
  });

  check("an upload still in flight is left alone", () => {
    // The machine starts every document at `created`; `uploading` is the step after it.
    psql(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,storage_path,tenant_id,received_at)
          values ('doc-now','customer_sells_to_zeman','created','bat-a','iso-a','ingest/bat-a/doc-now.jpg','t-sarkhel', now())`);
    psql(`update public.receipt_documents set state='uploading' where id='doc-now'`);
    asDefiner(A_UID, `select public.sarraf_receipt_close_abandoned_uploads(60)::text`);
    const state = psql(`select state from public.receipt_documents where id='doc-now'`).trim();
    if (state !== "uploading") throw new Error(`an upload started a moment ago was called abandoned (${state})`);
  });

  check("an upload cannot be called abandoned after a few seconds", () => {
    let refused = false;
    try { asDefiner(A_UID, `select public.sarraf_receipt_close_abandoned_uploads(1)::text`); }
    catch { refused = true; }
    if (!refused) throw new Error("a one-minute grace period was accepted");
  });

  // ── the vendor opens a business, and the owner can see it ───────────────────
  //
  // The manager belongs to no business and every policy lets them through. Without a record, a
  // business that buys this system has no way to know whether the person who sold it has been in
  // their accounts — which is the question a customer asks before trusting their ledger to
  // somebody else's software.
  const MGR = "cccccccc-0000-0000-0000-000000000001";

  check("only the manager opens a support context", () => {
    let refused = false;
    try { asDefiner(A_UID, `select public.sarraf_manager_open_support('t-watan','ھۆکارێکی دووری')::text`); }
    catch { refused = true; }
    if (!refused) throw new Error("a business owner opened a support context");
  });

  check("a support context with no reason is not one", () => {
    let refused = false;
    try { asDefiner(MGR, `select public.sarraf_manager_open_support('t-watan','کورت')::text`); }
    catch { refused = true; }
    if (!refused) throw new Error("a four-character reason was accepted");
  });

  check("the manager opens one business and says why", () => {
    const out = JSON.parse(asDefiner(MGR,
      `select public.sarraf_manager_open_support('t-watan','پشکنینی داواکاری خاوەنەکە')::text`));
    if (out.tenant_id !== "t-watan") throw new Error(JSON.stringify(out));
    const open = asDefiner(MGR, `select coalesce(public.sarraf_manager_support_tenant(),'<none>')`).trim();
    if (open !== "t-watan") throw new Error(`the open business is ${open}`);
  });

  check("opening a second business closes the first — two at once is not a context", () => {
    asDefiner(MGR, `select public.sarraf_manager_open_support('t-sarkhel','کێشەیەکی چوونەژوورەوە')::text`);
    const openRows = psql(`select count(*) from public.manager_support_sessions
                            where manager_id='iso-mgr' and closed_at is null`).trim();
    if (openRows !== "1") throw new Error(`${openRows} contexts are open at once`);
    const open = asDefiner(MGR, `select coalesce(public.sarraf_manager_support_tenant(),'<none>')`).trim();
    if (open !== "t-sarkhel") throw new Error(`the open business is ${open}`);
  });

  check("the owner of a business sees the context opened against theirs", () => {
    const seen = asUser(A_UID, `select coalesce(string_agg(tenant_id, ','), '<none>')
                                  from public.manager_support_sessions`).trim();
    if (!seen.includes("t-sarkhel")) throw new Error(`the owner saw ${seen}`);
  });

  check("and does not see one opened against somebody else's", () => {
    const seen = asUser(A_UID, `select coalesce(string_agg(distinct tenant_id, ','), '<none>')
                                  from public.manager_support_sessions`).trim();
    if (seen.includes("t-watan")) throw new Error(`the owner of t-sarkhel saw ${seen}`);
  });

  check("a record of who looked at your books cannot be tidied away", () => {
    let refused = false;
    try { psql(`delete from public.manager_support_sessions`); } catch { refused = true; }
    if (!refused) throw new Error("the support record can be deleted");
  });

  check("an expired context is not an open one", () => {
    // Both ends move: the row still has to satisfy its own constraints — an expiry before the
    // opening is not an expired context, it is a nonsense one.
    psql(`update public.manager_support_sessions
             set opened_at = statement_timestamp() - interval '9 hours',
                 expires_at = statement_timestamp() - interval '1 hour'
           where closed_at is null`);
    const open = asDefiner(MGR, `select coalesce(public.sarraf_manager_support_tenant(),'<none>')`).trim();
    if (open !== "<none>") throw new Error(`an expired context still reads as ${open}`);
  });

  check("closing says how many it closed, and leaves none open", () => {
    asDefiner(MGR, `select public.sarraf_manager_open_support('t-watan','دوایین پشکنین')::text`);
    const out = JSON.parse(asDefiner(MGR, `select public.sarraf_manager_close_support('تەواو')::text`));
    if (Number(out.closed) < 1) throw new Error(JSON.stringify(out));
    const open = asDefiner(MGR, `select coalesce(public.sarraf_manager_support_tenant(),'<none>')`).trim();
    if (open !== "<none>") throw new Error(`a context is still open: ${open}`);
  });

  check("the server can ask which business is open without a session", () => {
    asDefiner(MGR, `select public.sarraf_manager_open_support('t-watan','پرسیاری سێرڤەر')::text`);
    // No session at all — this is how api/admin-user.js reaches it, holding the service key.
    const open = psql(`select coalesce(public.sarraf_manager_support_tenant_for('iso-mgr'),'<none>')`).trim();
    if (open !== "t-watan") throw new Error(`the server was told ${open}`);
  });

  check("no browser can ask about another manager by name", () => {
    const mayCall = psql(`select has_function_privilege('authenticated',
      'public.sarraf_manager_support_tenant_for(text)', 'execute')`).trim();
    if (mayCall !== "f") throw new Error("a browser may name any manager and read their context");
  });

  // ── a business that stops paying stops trading ──────────────────────────────
  //
  // sarraf_manager_set_tenant_active wrote tenants.active and nothing read it. A business
  // suspended for not paying went on trading exactly as before — which, for a system that is
  // sold, made the one commercial control the vendor has into a label.
  //
  // Read-only, not locked out: their ledger is the record of their own money, and this system
  // does not take that away over an unpaid invoice.
  check("a suspended business cannot open a new transaction", () => {
    psql(`update public.tenants set active = false where id = 't-watan'`);
    let refused = "";
    try {
      psql(`insert into public.txs(id,code,type,cp_id,cur_id,amount,rate,against_id,total,status,date,tenant_id)
            values ('tx-suspended',990101,'buy','iso-cust-b','cny',100,1,'usd',100,'pending',current_date,'t-watan')`);
    } catch (error) { refused = String(error.message || error); }
    if (!refused) throw new Error("a suspended business opened a transaction");
    if (!/ڕاگیراوە/.test(refused)) throw new Error(`refused, but for another reason: ${refused.slice(0, 200)}`);
  });

  check("nor take in a receipt", () => {
    let refused = false;
    try {
      psql(`insert into public.receipt_batches(id,customer_id,customer_name,direction,status,currency,uploaded_by,tenant_id)
            values ('bat-suspended','iso-b','B','sell','pending','CNY','iso-b','t-watan')`);
    } catch { refused = true; }
    if (!refused) throw new Error("a suspended business took in a receipt batch");
  });

  check("but still reads every one of its own rows", () => {
    // The whole point of read-only rather than locked out. Their books are theirs.
    const seen = asUser(B_UID, `select count(*) from public.receipt_batches`).trim();
    if (Number(seen) < 1) throw new Error("a suspended business could no longer read its own books");
  });

  check("and a business that is not suspended is untouched", () => {
    psql(`insert into public.receipt_batches(id,customer_id,customer_name,direction,status,currency,uploaded_by,tenant_id)
          values ('bat-still-trading','iso-a','A','sell','pending','CNY','iso-a','t-sarkhel')`);
    const landed = psql(`select count(*) from public.receipt_batches where id='bat-still-trading'`).trim();
    if (landed !== "1") throw new Error("an active business was stopped as well");
  });

  check("resuming it lets it trade again", () => {
    psql(`update public.tenants set active = true where id = 't-watan'`);
    psql(`insert into public.receipt_batches(id,customer_id,customer_name,direction,status,currency,uploaded_by,tenant_id)
          values ('bat-resumed','iso-b','B','sell','pending','CNY','iso-b','t-watan')`);
    const landed = psql(`select count(*) from public.receipt_batches where id='bat-resumed'`).trim();
    if (landed !== "1") throw new Error("a resumed business still could not trade");
  });

  // ── a new business has somebody who can open it ─────────────────────────────
  check("opening a business leaves an owner waiting to sign in", () => {
    const out = JSON.parse(asDefiner(MGR,
      `select public.sarraf_manager_open_business('t-new','بازرگانیی نوێ','owner@example.com','خاوەنی نوێ')::text`));
    if (out.id !== "t-new") throw new Error(JSON.stringify(out));
    const waiting = psql(`select admin_level || ' ' || tenant_id from public.pending_accounts
                           where email='owner@example.com'`).trim();
    if (waiting !== "owner t-new") throw new Error(`the pending owner reads ${waiting}`);
  });

  check("and a business opened after the first inherits the settings in use", () => {
    // The copy is from whatever business already exists. The first business ever created has
    // nothing to copy and gets none — which is right, and is why this seeds one first rather
    // than asserting a copy the fixture could never have made.
    psql(`insert into public.control_settings(singleton, tenant_id) values (true, 't-sarkhel')
          on conflict do nothing`);
    const seeded = psql(`select count(*) from public.control_settings`).trim();
    if (seeded === "0") { psql("select 1"); throw new Error("no settings row to copy from"); }
    asDefiner(MGR, `select public.sarraf_manager_open_business('t-third','سێیەم','third@example.com','خاوەنی سێیەم')::text`);
    const settings = psql(`select count(*) from public.control_settings where tenant_id='t-third'`).trim();
    if (settings !== "1") throw new Error(`the new business has ${settings} settings row(s)`);
  });

  check("the same email cannot be promised two businesses", () => {
    let refused = false;
    try {
      asDefiner(MGR, `select public.sarraf_manager_open_business('t-new-2','دووەم','owner@example.com','خاوەن')::text`);
    } catch { refused = true; }
    if (!refused) throw new Error("one email was promised two businesses");
    // And nothing half-made: the second business must not exist either.
    const made = psql(`select count(*) from public.tenants where id='t-new-2'`).trim();
    if (made !== "0") throw new Error("a business was created and then left without an owner");
  });

  check("only the manager opens a business", () => {
    let refused = false;
    try {
      asDefiner(A_UID, `select public.sarraf_manager_open_business('t-nope','نا','x@example.com','ناو')::text`);
    } catch { refused = true; }
    if (!refused) throw new Error("a business owner opened a new business");
  });

  // ── which business needs the vendor today ───────────────────────────────────
  //
  // The live database had a business nobody had ever been inside — the owner had a login and
  // had never passed the MFA gate — and the console said nothing. It took a database inspection
  // to find, and the vendor would have found out when the customer rang.
  check("the manager is told which business has never been opened", () => {
    const out = JSON.parse(asDefiner(MGR, `select public.sarraf_manager_attention(30)::text`));
    const rows = out.businesses || [];
    if (!rows.length) throw new Error("no business was reported at all");
    // The fixture's owners have no MFA factor, so every business reads as never opened — which
    // is the honest answer for a database where nobody has signed in.
    const named = rows.filter((r) => r.never_opened).map((r) => r.id);
    if (!named.includes("t-watan")) throw new Error(`never-opened businesses: ${named.join(", ")}`);
  });

  check("a business nobody has opened outranks a business that is merely quiet", () => {
    const out = JSON.parse(asDefiner(MGR, `select public.sarraf_manager_attention(1)::text`));
    const rows = out.businesses || [];
    const opened = rows.find((r) => !r.never_opened);
    const never = rows.find((r) => r.never_opened);
    if (never && opened && never.weight <= opened.weight) {
      throw new Error("a business nobody has been inside did not come first");
    }
  });

  check("and never an amount from anybody's books", () => {
    const out = asDefiner(MGR, `select public.sarraf_manager_attention(30)::text`);
    for (const forbidden of ["amount", "total", "balance", "profit", "rate"]) {
      if (out.includes(`"${forbidden}"`)) {
        throw new Error(`the manager's console reported ${forbidden} from a business's books`);
      }
    }
  });

  // ── the manager's opening screen ────────────────────────────────────────────
  //
  // sarraf_manager_overview has answered since 202608230001 and nothing had ever read it. It is
  // now the first screen a manager meets, which means it must be held to the same rule as
  // sarraf_manager_attention above: it may count people and name administrators, and it may not
  // report one riyal of anybody's money.
  //
  // It was written before that rule existed and had no check of its own — a view nobody opened
  // is a view nobody audited. Both facts arrived on the same day.
  check("the manager's opening screen reports no amount from anybody's books", () => {
    const out = asDefiner(MGR, `select public.sarraf_manager_overview()::text`);
    for (const forbidden of ["amount", "total", "balance", "profit", "rate", "cashbox", "debt"]) {
      if (out.includes(`"${forbidden}"`)) {
        throw new Error(`the manager's opening screen reported ${forbidden} from a business's books`);
      }
    }
    // It must still be answering: a function that returned an empty object would pass the loop
    // above for the wrong reason.
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed.administrators) || typeof parsed.manager_count !== "number") {
      throw new Error(`the overview answered ${out.slice(0, 160)}`);
    }
  });

  check("a business owner cannot read the manager's opening screen", () => {
    let refused = false;
    try { asDefiner(A_UID, `select public.sarraf_manager_overview()::text`); }
    catch { refused = true; }
    if (!refused) throw new Error("a business owner read the whole installation's overview");
  });

  check("a business owner cannot read the vendor's console", () => {
    let refused = false;
    try { asDefiner(A_UID, `select public.sarraf_manager_attention(30)::text`); }
    catch { refused = true; }
    if (!refused) throw new Error("a business owner read which businesses need the vendor");
  });

  check("a suspended business is reported as needing attention", () => {
    psql(`update public.tenants set active = false where id = 't-watan'`);
    const out = JSON.parse(asDefiner(MGR, `select public.sarraf_manager_attention(30)::text`));
    const watan = (out.businesses || []).find((r) => r.id === "t-watan");
    if (!watan) throw new Error("the suspended business was not reported");
    if (watan.active !== false) throw new Error("the suspended business reads as active");
    psql(`update public.tenants set active = true where id = 't-watan'`);
  });

  // ── whose portal is this? ───────────────────────────────────────────────────
  //
  // The owner reported that a View As session showed receipts belonging to people it had nothing
  // to do with. None of the checks above would have caught it, because nothing here was wrong at
  // the table: every policy is correctly scoped and every _definer policy is restricted to
  // sarraf_definer.
  //
  // View As was a browser costume. `viewAs` lived in useState, the session identity never
  // changed, and the portal went on asking the three loaders "what is MINE" — so an
  // administrator previewing a customer's screen was shown their own receipts, listed as that
  // customer's. 202609010008 made the three loaders take a subject and made the server decide
  // who may name one.
  const PORTAL_ADMIN = "aaaaaaaa-0000-0000-0000-000000000001";   // iso-a, owner of t-sarkhel
  const PORTAL_C1_UID = "eeeeeeee-0000-0000-0000-000000000001";
  const PORTAL_C2_UID = "eeeeeeee-0000-0000-0000-000000000002";

  psql(`
    begin;
    set local session_replication_role = replica;
    insert into public.app_users(id,name,role,auth_id,tenant_id) values
      ('vas-c1','کڕیاری یەک','customer','${PORTAL_C1_UID}','t-sarkhel'),
      ('vas-c2','کڕیاری دوو','customer','${PORTAL_C2_UID}','t-sarkhel')
    on conflict (id) do update set auth_id = excluded.auth_id, tenant_id = excluded.tenant_id;
    insert into public.receipt_documents(
      id,flow,state,uploader_id,customer_id,batch_id,storage_path,mime_type,tenant_id)
    values
      ('vas-doc1','customer_sells_to_zeman','created','vas-c1','vas-c1','vasb1',
       'ingest/vasb1/vas-doc1.jpg','image/jpeg','t-sarkhel'),
      ('vas-doc2','customer_sells_to_zeman','created','vas-c2','vas-c2','vasb2',
       'ingest/vasb2/vas-doc2.jpg','image/jpeg','t-sarkhel'),
      ('vas-doca','customer_sells_to_zeman','created','iso-a','iso-a','vasba',
       'ingest/vasba/vas-doca.jpg','image/jpeg','t-sarkhel')
    on conflict (id) do nothing;
    commit;`);

  const intakes = (uid, subject) => asUser(uid,
    `select coalesce(string_agg(id, ',' order by id), '<none>')
       from public.sarraf_my_receipt_intakes_v2(50, ${subject === null ? "null" : `'${subject}'`})`).trim();

  check("an administrator viewing a customer's portal is shown that customer's receipts", () => {
    const seen = intakes(PORTAL_ADMIN, "vas-c1");
    if (seen !== "vas-doc1") throw new Error(`saw ${seen}, expected only vas-doc1`);
  });

  // The defect itself, stated as a check: asking without naming anybody answers about the
  // caller. That is correct behaviour for the function — and it is exactly why the portal must
  // never call it that way. If this ever returns the customer's document, the subject argument
  // has stopped being honoured.
  // Earlier checks in this file give iso-a documents of their own, so the assertion is not a
  // fixed list — it is that neither customer's receipt is in the answer.
  check("asking without naming a subject still answers about the caller alone", () => {
    const seen = intakes(PORTAL_ADMIN, null);
    if (!seen.includes("vas-doca")) throw new Error(`saw ${seen}, missing the caller's own`);
    if (seen.includes("vas-doc1") || seen.includes("vas-doc2")) {
      throw new Error(`saw ${seen}, which includes a customer's receipt`);
    }
  });

  check("a customer naming another customer is refused", () => {
    refused(PORTAL_C1_UID, "select * from public.sarraf_my_receipt_intakes_v2(50, 'vas-c2')",
      "one customer reading another customer's receipts");
  });

  check("a customer reading their own portal still works", () => {
    const seen = intakes(PORTAL_C1_UID, "vas-c1");
    if (seen !== "vas-doc1") throw new Error(`saw ${seen}, expected only their own`);
  });

  check("the other business's owner cannot name a customer of this one", () => {
    refused(B_UID, "select * from public.sarraf_my_receipt_intakes_v2(50, 'vas-c1')",
      "an owner of another business reading this one's customer");
  });

  check("an administrator cannot view another administrator's portal", () => {
    refused(PORTAL_ADMIN, "select * from public.sarraf_my_receipt_intakes_v2(50, 'iso-b')",
      "an administrator reading a colleague's portal");
  });

  check("the forwarded list obeys the same rule", () => {
    refused(PORTAL_C1_UID, "select * from public.sarraf_my_forwarded_receipts_v2(100, 'vas-c2')",
      "one customer reading another's forwarded receipts");
  });

  // The summary used to raise 42501 for anybody who was not a customer or partner, which is why
  // View As showed a failure rather than a screen. The rule belongs to the subject.
  check("the portal summary answers an administrator about a named customer", () => {
    const out = asUser(PORTAL_ADMIN,
      "select (public.sarraf_portal_receipt_summary_v2(365, 'vas-c1') ? 'totals')::text").trim();
    if (out !== "true") throw new Error(`the summary did not answer: ${out}`);
  });

  check("the portal summary refuses a customer naming somebody else", () => {
    refused(PORTAL_C1_UID, "select public.sarraf_portal_receipt_summary_v2(365, 'vas-c2')",
      "one customer reading another's receipt summary");
  });

  // ── where a customer's money actually is ────────────────────────────────────
  //
  //   «کاتێک مامەڵەیەکی کڕین دەکەم و پارەکەی لای نوسینگەیە نابێت من قەرزاری مشتەری بم،
  //    دەبێت لای ئەو بنووسرێت پارەکەت لە فڵان نوسینگەیە.»
  //
  // The balance on a customer's home screen has always said how much and never where.
  // 202609010015 lets it name the office, and it reads office_payment_assignments — a table one
  // customer must never see another's rows in. So the same six questions View As was made to
  // answer are asked of it here, against a real database, before it is believed.
  psql(`
    begin;
    set local session_replication_role = replica;
    insert into public.app_users(id,name,role,auth_id,tenant_id)
    values ('iso-off','نووسینگەی هەولێر','office','ffffffff-0000-0000-0000-000000000001','t-sarkhel')
    on conflict (id) do update set auth_id = excluded.auth_id, tenant_id = excluded.tenant_id;
    insert into public.office_payment_assignments(
      id,office_id,transaction_id,customer_id,amount,currency,status,assigned_by,tenant_id)
    values
      ('vas-asg1','iso-off',null,'vas-c1', 5000,'CNY','assigned','iso-a','t-sarkhel'),
      ('vas-asg2','iso-off',null,'vas-c2', 7000,'CNY','assigned','iso-a','t-sarkhel'),
      ('vas-asg3','iso-off',null,'vas-c1', 900,'CNY','confirmed','iso-a','t-sarkhel')
    on conflict (id) do nothing;
    commit;`);

  const atOffices = (uid, subject) => asUser(uid,
    `select coalesce(string_agg(assignment_id, ',' order by assignment_id), '<none>')
       from public.sarraf_my_money_at_offices(${subject === null ? "null" : `'${subject}'`})`).trim();

  check("a customer is told which office holds their money", () => {
    const seen = atOffices(PORTAL_C1_UID, "vas-c1");
    if (seen !== "vas-asg1") throw new Error(`saw ${seen}, expected only vas-asg1`);
  });

  // An assignment the office has already paid and had confirmed is money that is no longer
  // there. Saying otherwise would be worse than saying nothing, so vas-asg3 must not appear.
  check("an assignment already confirmed is not still reported as money at the office", () => {
    const seen = atOffices(PORTAL_C1_UID, "vas-c1");
    if (seen.includes("vas-asg3")) throw new Error(`saw ${seen}, which includes a settled assignment`);
  });

  check("one customer cannot read where another customer's money is", () => {
    refused(PORTAL_C1_UID, "select * from public.sarraf_my_money_at_offices('vas-c2')",
      "one customer reading another customer's office assignments");
  });

  check("an administrator viewing a customer's portal sees that customer's offices", () => {
    const seen = atOffices(PORTAL_ADMIN, "vas-c2");
    if (seen !== "vas-asg2") throw new Error(`saw ${seen}, expected only vas-asg2`);
  });

  check("the other business's owner cannot name a customer of this one", () => {
    refused(B_UID, "select * from public.sarraf_my_money_at_offices('vas-c1')",
      "an owner of another business reading this one's customer");
  });

  // The office is only "holding" the money once sarraf_office_advance has actually moved it out
  // of the safe. Until then the honest sentence is that the office will pay, not that it has the
  // money — and a screen that cannot tell those apart is the screen that made the owner ask.
  check("an office nobody advanced money to is not reported as holding it", () => {
    const held = asUser(PORTAL_C1_UID,
      `select coalesce(bool_or(advance_held), false)::text
         from public.sarraf_my_money_at_offices('vas-c1')`).trim();
    if (held !== "false") throw new Error(`the office reads as holding money it was never sent: ${held}`);
  });

  // ── a hundred receipts leaving at once ──────────────────────────────────────
  //
  //   «ئەو فیشانەی لە ئەکاونتی مشتەرییەکاندا هەیە... پێویستە بتوانرێت بە کۆمەڵ بۆ نمونە تا
  //    ١٠٠ دانە بەیەکەوە فۆرۆرد بکرێت و بنێررێت بۆ واتس ئەپ.»
  //
  // A hundred document ids arriving from a checkbox column is the shape of request where a
  // per-row authorization check quietly stops happening — it is tempting to check the first one,
  // or to check the customer once and trust the rest of the list. 202609020001 writes it as a
  // WHERE clause instead, and this is where that claim gets tested rather than asserted: a list
  // that mixes one customer's receipts with another's, put to the server, and the answer counted.
  const bundled = (uid, ids, subject) => asUser(uid,
    `select coalesce(string_agg(document_id, ',' order by document_id), '<none>')
       from public.sarraf_release_receipts_for_bundle(
         array[${ids.map((i) => `'${i}'`).join(",")}]::text[],
         ${subject === null ? "null" : `'${subject}'`})`).trim();

  check("a customer bundling their own receipts gets their own", () => {
    const seen = bundled(PORTAL_C1_UID, ["vas-doc1"], "vas-c1");
    if (seen !== "vas-doc1") throw new Error(`saw ${seen}, expected vas-doc1`);
  });

  // The check that matters. A list containing somebody else's receipt does not fail loudly and
  // does not release it: the id is simply absent from the answer.
  check("a receipt belonging to somebody else is dropped from the list, not released", () => {
    const seen = bundled(PORTAL_C1_UID, ["vas-doc1", "vas-doc2", "vas-doca"], "vas-c1");
    if (seen !== "vas-doc1") throw new Error(`saw ${seen}, which released a receipt not theirs`);
  });

  check("a customer cannot bundle another customer's receipts by naming them", () => {
    refused(PORTAL_C1_UID,
      "select * from public.sarraf_release_receipts_for_bundle(array['vas-doc2']::text[], 'vas-c2')",
      "one customer bundling another customer's receipts");
  });

  check("an administrator bundling for a customer gets that customer's receipts", () => {
    const seen = bundled(PORTAL_ADMIN, ["vas-doc1", "vas-doc2", "vas-doca"], "vas-c2");
    if (seen !== "vas-doc2") throw new Error(`saw ${seen}, expected only vas-doc2`);
  });

  check("the other business's owner cannot bundle a customer of this one", () => {
    refused(B_UID,
      "select * from public.sarraf_release_receipts_for_bundle(array['vas-doc1']::text[], 'vas-c1')",
      "an owner of another business bundling this one's customer");
  });

  // §11 names one hundred. Truncating silently would hand somebody ninety-nine of the hundred
  // and twenty they asked for with no way to know which twenty-one are absent.
  check("more than a hundred receipts is refused rather than quietly truncated", () => {
    const many = Array.from({ length: 101 }, (_, i) => `'vas-doc1'`).join(",");
    refused(PORTAL_C1_UID,
      `select * from public.sarraf_release_receipts_for_bundle(array[${many}]::text[], 'vas-c1')`,
      "a bundle of more than one hundred receipts");
  });

  // Handing out a hundred receipt images is the largest disclosure this system makes, and it
  // leaves through a share sheet the system cannot follow. A release that left no trace would be
  // a hole in the audit trail exactly where it matters most.
  //
  // Clearing the old rows first is not an option, and finding that out is itself the point: the
  // audit table refuses a delete with "audit is append-only". So the check takes a mark before
  // the release and reads only what appeared after it.
  check("every release writes down who released how many, for whom", () => {
    const before = psql(`select count(*) from public.audit
                          where action = 'دەرکردنی کۆمەڵی فیش'`).trim();
    bundled(PORTAL_ADMIN, ["vas-doc1", "vas-doc2", "vas-doca"], "vas-c2");
    const after = psql(`select count(*) from public.audit
                         where action = 'دەرکردنی کۆمەڵی فیش'`).trim();
    if (Number(after) !== Number(before) + 1) {
      throw new Error(`a release of three receipts wrote ${Number(after) - Number(before)} audit rows`);
    }
    const row = psql(`select coalesce(user_id || ' | ' || detail, '<none>') from public.audit
                       where action = 'دەرکردنی کۆمەڵی فیش'
                       order by date desc, id desc limit 1`).trim();
    if (!row.startsWith("iso-a")) throw new Error(`the audit row does not name the actor: ${row}`);
    // One of three released — the row must say what actually left, not what was asked for.
    if (!/\b1 .*\b3 /.test(row)) {
      throw new Error(`the audit row does not say how many of how many: ${row}`);
    }
    if (!row.includes("vas-c2") && !row.includes("بۆ ")) {
      throw new Error(`the audit row does not name who it was for: ${row}`);
    }
  });

  // ── the balance nobody could explain ────────────────────────────────────────
  //
  // The owner reported a CNY cashbox that goes negative for no visible reason. It is not one bad
  // transaction: the cashbox figure is a residual — every ledger row that names no partner —
  // and nothing constrains a residual to stay positive. 202609010009 does not change the number,
  // it makes the number explainable, which is what §8 asks for first.
  //
  // A reporting function that has never seen a negative balance proves nothing, so this
  // manufactures one and checks that it is found and named.
  check("the explain view names the movement that took a balance below zero", () => {
    psql(`
      begin;
      set local session_replication_role = replica;
      delete from public.ledger where id like 'neg-%';
      insert into public.ledger(id,type,owner,cur_id,amount,date,tenant_id) values
        ('neg-1','deposit','self','CNY', 100, now() - interval '3 days','t-sarkhel'),
        ('neg-2','withdraw','self','CNY', -40, now() - interval '2 days','t-sarkhel'),
        ('neg-3','withdraw','self','CNY',-200, now() - interval '1 days','t-sarkhel');
      commit;`);
    const out = asUser(A_UID,
      `select public.sarraf_balance_first_negative('CNY','owner')::text`).trim();
    if (!out.includes('"ever_negative" : true') && !out.includes('"ever_negative": true')) {
      throw new Error(`it did not report a negative balance: ${out.slice(0, 300)}`);
    }
    // neg-3 is the one that crosses: 100, then 60, then -140.
    if (!out.includes("neg-3")) throw new Error(`it blamed the wrong movement: ${out.slice(0, 300)}`);
    if (!out.includes("-140")) throw new Error(`the balance after is wrong: ${out.slice(0, 300)}`);
  });

  check("the running balance is reported after every movement, in order", () => {
    const seen = asUser(A_UID,
      `select coalesce(string_agg(ledger_id || '=' || running_balance::text, ',' order by seq),'<none>')
         from public.sarraf_explain_balance('CNY','owner')
        where ledger_id like 'neg-%'`).trim();
    if (seen !== "neg-1=100.0000000000,neg-2=60.0000000000,neg-3=-140.0000000000") {
      throw new Error(`running balance reads: ${seen}`);
    }
  });

  // Its own currency rather than a delete: the ledger is append-only and refuses one, which is
  // the protection working. The first version of this check tried to tidy up and was told so.
  check("a balance that never went negative says so plainly", () => {
    psql(`
      begin;
      set local session_replication_role = replica;
      insert into public.ledger(id,type,owner,cur_id,amount,date,tenant_id) values
        ('pos-1','deposit','self','XTS', 500, now() - interval '2 days','t-sarkhel'),
        ('pos-2','withdraw','self','XTS',-120, now() - interval '1 days','t-sarkhel')
      on conflict (id) do nothing;
      commit;`);
    const out = asUser(A_UID,
      `select public.sarraf_balance_first_negative('XTS','owner')::text`).trim();
    if (!out.includes("false")) throw new Error(`it invented a negative: ${out.slice(0, 300)}`);
    if (!out.includes("380")) throw new Error(`the final balance is wrong: ${out.slice(0, 300)}`);
  });

  check("a customer cannot read the owner's balance explanation", () => {
    refused(CUS_UID, "select * from public.sarraf_explain_balance('CNY','owner')",
      "a customer reading the owner's cashbox movements");
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
