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
                               'sarraf_office_payment_attach_evidence_server')
         and (o.rolbypassrls or o.rolsuper)`).trim();
    if (loose) throw new Error(`these run as a role that ignores every policy: ${loose}`);
  });

  check("the functions allowed to bypass tenancy are closed to every browser", () => {
    const open = psql(`
      select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
       where p.proname in ('sarraf_receipt_record_server_extraction',
                           'sarraf_office_payment_attach_evidence_server')
         and (has_function_privilege('authenticated', p.oid, 'execute')
              or has_function_privilege('anon', p.oid, 'execute'))`).trim();
    if (open) throw new Error(`a browser can call these, and they bypass tenancy: ${open}`);
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
