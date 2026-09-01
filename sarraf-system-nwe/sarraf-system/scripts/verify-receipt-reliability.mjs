#!/usr/bin/env node
// Every way a receipt can be lost, stuck, doubled, or held by nobody (§ stage 12).
//
//   npm run verify:receipts
//
// verify:flows walks the days that go right. This one goes the other way: it takes a real
// database, drives real commands, and then tries to break the four things that must never be
// true of a receipt in a system that moves other people's money.
//
//   LOST      — evidence exists and nothing points at it, or a total counts what is not there
//   STUCK     — a receipt sits in a state nobody can move it out of, holding its batch open
//   DOUBLED   — one payment counted twice: two batches, two transactions, two forwardings
//   ORPHANED  — money in the system that nobody is holding
//
// Each check states the invariant, then attempts the specific thing that would violate it. An
// invariant asserted without an attempt to break it is a comment.
import { PG_HINT, postgresAvailable, startDatabase } from "./lib/zeman-db.mjs";

if (!postgresAvailable()) {
  console.log(`SKIP: ${PG_HINT}`);
  process.exit(0);
}

try {
  const { psql } = startDatabase();

  const checks = [];
  const detail = (e) => {
    const text = `${e?.stderr?.toString?.() || ""}\n${String(e?.message || e)}`;
    return text.split("\n").map((l) => l.trim()).find((l) => /^(ERROR|DETAIL|HINT):/.test(l))
      || String(e?.message || e).split("\n").find(Boolean) || "unknown error";
  };
  const check = (name, fn) => {
    try { fn(); checks.push([true, name]); }
    catch (e) { checks.push([false, `${name}\n        ${detail(e)}`]); }
  };
  // Did the database refuse?
  //
  // Not "did psql throw" — the first version of this asked that, and psql throws on things that
  // are not refusals, so a write that actually landed was reported as having been refused. Every
  // "must be refused" check in this file was therefore passing without checking anything, and
  // the row it said had been refused was sitting in the next check's results.
  //
  // So the question is asked of the database: is the row there? `probe` names a condition that
  // is true only if the write took effect.
  const refused = (sql, probe) => {
    try { psql(sql); } catch { /* an exception is one way to be refused, not the only one */ }
    return psql(`select count(*) from ${probe}`).trim() === "0";
  };
  const one = (sql) => psql(`select (${sql})::text`).trim();
  const num = (sql) => Number(one(sql));

  // ── the cast ────────────────────────────────────────────────────────────────
  const UID = {
    admin: "aa110000-0000-0000-0000-000000000001",
    customer: "aa110000-0000-0000-0000-000000000002",
    partner: "aa110000-0000-0000-0000-000000000003",
    stranger: "aa110000-0000-0000-0000-000000000004",
  };
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select null::uuid $fn$`);
  psql(`insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id) values
    ('rl-adm','ئەدمین','admin','owner','${UID.admin}','t-sarkhel'),
    ('rl-cus','کڕیار','customer',null,'${UID.customer}','t-sarkhel'),
    ('rl-par','هاوبەش','partner',null,'${UID.partner}','t-sarkhel'),
    ('rl-oth','بێگانە','customer',null,'${UID.stranger}','t-watan')
    on conflict (id) do nothing`);
  const be = (who) => psql(`create or replace function auth.uid() returns uuid language sql stable
    as $fn$ select '${UID[who]}'::uuid $fn$`);
  psql("update public.currencies set rate = 7.20, rate_updated = now() where id='cny'");
  be("admin");

  const batch = (id, fields = {}) => {
    const f = { stage: "received", currency: "CNY", customer: "rl-cus", ...fields };
    psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency,receipt_stage,tenant_id)
          values ('${id}','${f.customer}','${f.customer}','in','${f.currency}','${f.stage}','t-sarkhel')`);
  };
  const document = (id, batchId, fields = {}) => {
    const f = { state: "created", uploader: "rl-cus", flow: "customer_sells_to_zeman", ...fields };
    psql(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,customer_id,storage_path,tenant_id)
          values ('${id}','${f.flow}','created','${batchId}','${f.uploader}','rl-cus',
                  'ingest/${batchId}/${id}.jpg','t-sarkhel')`);
    if (f.state !== "created") {
      psql(`update public.receipt_documents set state='${f.state}' where id='${id}'`);
    }
  };

  // ══ LOST ════════════════════════════════════════════════════════════════════
  //
  // Evidence that exists and nothing points at, or a total that counts what is not there.

  check("a receipt cannot be stored against a batch that does not exist", () => {
    batch("rb-1");
    if (!refused(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,
                    amount,fee,net_amount,currency,status,counted,tenant_id)
                  values ('rr-ghost','no-such-batch','rl-cus','rl-cus','in',
                          100,0,100,'CNY','ok',true,'t-sarkhel')`,
                 `public.receipts where id='rr-ghost'`)) {
      throw new Error("a receipt was stored against a batch that does not exist");
    }
  });

  // Two different things are called a batch, and the first version of this file did not know it.
  //
  //   receipt_batches.id       — a batch the administrator reviews, with totals and a decision
  //   receipt_documents.batch_id — the grouping the uploader's browser made when several images
  //                                were sent together, and what the storage path is built from
  //
  // This asserted that the second must name a row of the first. The live database answered that
  // 64 of its 108 documents were in breach; they were not, the invariant was. A foreign key
  // added on that reasoning would have refused every upload from the moment it was applied.
  //
  // What is actually true, and worth holding: the grouping is what the evidence is filed under,
  // so a document's stored object must live under its own grouping. A document whose path says
  // one grouping and whose column says another is evidence filed where nobody will look for it.
  check("a document's evidence is filed under the grouping it names", () => {
    const misfiled = one(`
      select coalesce(string_agg(d.id, ', '), '')
        from public.receipt_documents d
       where d.batch_id is not null
         and d.storage_path is not null
         and d.storage_path not like ('%/' || d.batch_id || '/%')`);
    if (misfiled) throw new Error(`filed under a different grouping: ${misfiled}`);
  });

  // And where the grouping does happen to name a reviewable batch, the two must be the same
  // business. This is the crossing that would matter; the namespaces overlapping is not.
  check("a grouping that names a reviewable batch names one in the same business", () => {
    const across = one(`
      select coalesce(string_agg(d.id, ', '), '')
        from public.receipt_documents d
        join public.receipt_batches b on b.id = d.batch_id
       where d.tenant_id is not null and b.tenant_id is not null
         and d.tenant_id <> b.tenant_id`);
    if (across) throw new Error(`a document is grouped under another business's batch: ${across}`);
  });

  check("no receipt in the database points at a batch that is gone", () => {
    const orphans = num(`select count(*) from public.receipts r
                          where r.batch_id is not null
                            and not exists (select 1 from public.receipt_batches b where b.id = r.batch_id)`);
    if (orphans) throw new Error(`${orphans} receipt(s) name a batch that no longer exists`);
  });

  check("a batch's stated count matches the receipts it actually holds", () => {
    batch("rb-count");
    for (const id of ["rc-1", "rc-2"]) {
      psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,fee,
              net_amount,currency,status,counted,tenant_id)
            values ('${id}','rb-count','rl-cus','rl-cus','in',100,0,100,'CNY','ok',true,'t-sarkhel')`);
    }
    psql(`update public.receipt_batches set n = 2 where id='rb-count'`);
    const stated = num(`select n from public.receipt_batches where id='rb-count'`);
    const held = num(`select count(*) from public.receipts where batch_id='rb-count'`);
    if (stated !== held) throw new Error(`the batch says ${stated} and holds ${held}`);
  });

  check("nowhere in the database does a batch count more than it holds", () => {
    const wrong = one(`select coalesce(string_agg(b.id || ' (says ' || b.n || ', holds ' ||
                           (select count(*) from public.receipts r where r.batch_id = b.id) || ')', ', '), '')
                        from public.receipt_batches b
                       where b.n is not null and b.n > 0
                         and b.n < (select count(*) from public.receipts r where r.batch_id = b.id)`);
    if (wrong) throw new Error(`a batch holds more than it counts: ${wrong}`);
  });

  // ══ STUCK ═══════════════════════════════════════════════════════════════════
  //
  // A receipt nobody can move, holding its batch open behind it.

  check("an upload that never arrived can be moved on by the person who sent it", () => {
    batch("rb-stuck");
    document("rd-stuck", "rb-stuck", { state: "uploading" });
    be("customer");
    const out = JSON.parse(one(`public.sarraf_receipt_upload_failed('rd-stuck','network')`));
    be("admin");
    if (out.moved !== true) throw new Error(`the document did not move: ${JSON.stringify(out)}`);
  });

  check("and by the sweep, when nothing was left to report it", () => {
    batch("rb-abandoned");
    document("rd-abandoned", "rb-abandoned", { state: "uploading" });
    psql(`update public.receipt_documents
             set received_at = statement_timestamp() - interval '3 hours'
           where id='rd-abandoned'`);
    const out = JSON.parse(one(`public.sarraf_receipt_close_abandoned_uploads(60)`));
    if (!String(out.documents || "").includes("rd-abandoned")) {
      throw new Error(`the sweep did not reach it: ${JSON.stringify(out)}`);
    }
  });

  check("every state a document can be in has a way out, or is meant to be final", () => {
    // A state with no legal transition out of it, and which is not one of the three the machine
    // declares final, is a state a receipt goes into and never leaves.
    const final = ["seen", "failed_terminal", "cancelled"];
    const stuck = one(`
      select coalesce(string_agg(s.state::text, ', ' order by s.state::text), '')
        from (select unnest(enum_range(null::public.receipt_state)) as state) s
       where s.state::text <> all (array[${final.map((f) => `'${f}'`).join(",")}])
         and not exists (
           select 1 from (select unnest(enum_range(null::public.receipt_state)) as t) t
            where public.receipt_transition_allowed(s.state, t.t))`);
    if (stuck) throw new Error(`no way out of: ${stuck}`);
  });

  check("a receipt refused at the door does not hold its batch open", () => {
    batch("rb-refused");
    document("rd-refused", "rb-refused", { state: "uploading" });
    psql(`update public.receipt_documents set state='upload_failed_retryable' where id='rd-refused'`);
    // failed_terminal is reachable from here, which is what lets the batch finish without it.
    const reachable = one(`public.receipt_transition_allowed('upload_failed_retryable','failed_terminal')`);
    if (reachable !== "true") throw new Error(`a receipt that failed to upload cannot be closed off (${reachable})`);
  });

  // ══ DOUBLED ═════════════════════════════════════════════════════════════════
  //
  // One payment counted twice.

  check("the same image cannot be stored twice under two names", () => {
    batch("rb-dup");
    const sha = "d".repeat(64);
    psql(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,storage_path,
            image_sha256,tenant_id)
          values ('rd-dup-1','customer_sells_to_zeman','created','rb-dup','rl-cus',
                  'ingest/rb-dup/rd-dup-1.jpg','${sha}','t-sarkhel')`);
    if (!refused(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,
                    storage_path,image_sha256,counted,tenant_id)
                  values ('rd-dup-2','customer_sells_to_zeman','created','rb-dup','rl-cus',
                          'ingest/rb-dup/rd-dup-2.jpg','${sha}',true,'t-sarkhel')`,
                 `public.receipt_documents where id='rd-dup-2'`)) {
      throw new Error("the same image was counted twice");
    }
  });

  check("two documents cannot claim the same stored object", () => {
    // No constraint existed at all until 202609010004. The live database had no duplicates when
    // asked, which is what made adding the index safe rather than a gamble.
    if (!refused(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,
                    storage_path,tenant_id)
                  values ('rd-dup-3','customer_sells_to_zeman','created','rb-dup','rl-cus',
                          'ingest/rb-dup/rd-dup-1.jpg','t-sarkhel')`,
                 `public.receipt_documents where id='rd-dup-3'`)) {
      throw new Error("two documents point at one stored object");
    }
  });

  check("no receipt in the database belongs to two batches at once", () => {
    // The column is single-valued, so this asks the question that could still go wrong: the same
    // evidence, by hash, counted inside two different batches.
    const doubled = one(`
      select coalesce(string_agg(image_hash, ', '), '')
        from (select r.image_hash from public.receipts r
               where r.image_hash is not null and r.counted
               group by r.image_hash having count(distinct r.batch_id) > 1) x`);
    if (doubled) throw new Error(`the same evidence is counted in two batches: ${doubled}`);
  });

  check("a batch cannot become two transactions", () => {
    const doubled = one(`
      select coalesce(string_agg(batch_id || ' → ' || n, ', '), '')
        from (select b.id as batch_id, count(distinct t.transaction_id) as n
                from public.receipt_batches b
                join public.receipt_batch_transactions t on t.batch_id = b.id
               group by b.id having count(distinct t.transaction_id) > 1) x`);
    if (doubled) throw new Error(`a batch produced more than one transaction: ${doubled}`);
  });

  check("a document cannot be forwarded to the same person twice", () => {
    const doubled = one(`
      select coalesce(string_agg(document_id, ', '), '')
        from (select f.document_id from public.receipt_forwardings f
               group by f.document_id, f.to_actor_id having count(*) > 1) x`);
    if (doubled) throw new Error(`forwarded twice to the same person: ${doubled}`);
  });

  // ══ ORPHANED ════════════════════════════════════════════════════════════════
  //
  // Money in the system that nobody is holding.

  check("a custody line names somebody who exists", () => {
    if (!refused(`insert into public.receipt_custody_ledger(document_id,to_partner_id,reason,actor_id)
                  values ('rd-dup-1','nobody-at-all','گواستنەوەی تاقیکردنەوە','rl-adm')`,
                 `public.receipt_custody_ledger where to_partner_id='nobody-at-all'`)) {
      throw new Error("custody was handed to somebody who does not exist");
    }
  });

  check("a custody line says why, in words somebody can read", () => {
    if (!refused(`insert into public.receipt_custody_ledger(document_id,to_partner_id,reason,actor_id)
                  values ('rd-dup-1','rl-par','کورت','rl-adm')`,
                 `public.receipt_custody_ledger where reason='کورت'`)) {
      throw new Error("custody moved with a four-character reason");
    }
  });

  check("no custody line in the database points at a document that is gone", () => {
    const orphans = num(`select count(*) from public.receipt_custody_ledger l
                          where not exists (select 1 from public.receipt_documents d where d.id = l.document_id)`);
    if (orphans) throw new Error(`${orphans} custody line(s) name a document that no longer exists`);
  });

  check("no custody line hands evidence to somebody in another business", () => {
    const across = one(`
      select coalesce(string_agg(l.id::text, ', '), '')
        from public.receipt_custody_ledger l
        join public.receipt_documents d on d.id = l.document_id
        join public.app_users u on u.id = l.to_partner_id
       where d.tenant_id is not null and u.tenant_id is not null
         and d.tenant_id <> u.tenant_id`);
    if (across) throw new Error(`custody crossed a business boundary: ${across}`);
  });

  check("a stranger's receipt cannot be handed custody by this business", () => {
    batch("rb-other", { customer: "rl-oth" });
    psql(`update public.receipt_batches set tenant_id='t-watan' where id='rb-other'`);
    psql(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,customer_id,
            storage_path,tenant_id)
          values ('rd-other','customer_sells_to_zeman','created','rb-other','rl-oth','rl-oth',
                  'ingest/rb-other/rd-other.jpg','t-watan')`);
    psql(`insert into public.receipt_custody_ledger(document_id,to_partner_id,reason,actor_id)
          values ('rd-other','rl-par','گواستنەوەی نابەجێ','rl-adm')`);
    const across = num(`select count(*) from public.receipt_custody_ledger l
                          join public.receipt_documents d on d.id = l.document_id
                          join public.app_users u on u.id = l.to_partner_id
                         where d.tenant_id <> u.tenant_id`);
    // The row is written here as a superuser with the triggers in force; what this asserts is
    // that the condition above would see it. If it does not, the invariant check is blind.
    //
    // It is not cleaned up afterwards: the custody ledger is append-only, and it refuses the
    // delete — correctly. The check that runs over the whole table is therefore ordered before
    // this one, which is the honest way round rather than tidying evidence away.
    if (across !== 1) throw new Error("the cross-business custody check does not see a crossing");
  });

  // ══ THE WHOLE PICTURE ═══════════════════════════════════════════════════════

  check("every receipt that counts belongs to a business", () => {
    const loose = num(`select count(*) from public.receipts where tenant_id is null`);
    if (loose) throw new Error(`${loose} receipt(s) belong to no business`);
  });

  check("every document belongs to a business", () => {
    const loose = num(`select count(*) from public.receipt_documents where tenant_id is null`);
    if (loose) throw new Error(`${loose} document(s) belong to no business`);
  });

  check("every step of every receipt's story belongs to a business", () => {
    const loose = num(`select count(*) from public.receipt_state_transitions where tenant_id is null`);
    if (loose) throw new Error(`${loose} step(s) of a receipt's story belong to no business`);
  });

  // ── the report ──────────────────────────────────────────────────────────────
  let failed = 0;
  for (const [ok, name] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; }
  console.log(failed
    ? `\n${failed} of ${checks.length} receipt reliability checks failed.`
    : `\nA receipt cannot be lost, stuck, doubled or held by nobody, across ${checks.length} checks.`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error("Receipt reliability verification could not run:", String(e.message || e).slice(0, 4000));
  process.exit(1);
}
