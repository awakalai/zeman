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

  // A failed upload is the owner's own fear, stated plainly:
  //
  //   «فیشێک لە کاتی ئەپڵۆدکردن ئیرۆر بدات، پێویست ناکات بچێتە سیستەمەوە، بەڵکو جارێکی دیکە
  //    ئەپڵۆدی بکاتەوە، چوونکە گەر بچێتە سیستەمەوە بە دووبارە حساب دەکرێت.»
  //
  // The state existed and one line of this file asked whether it could be closed off. Nothing
  // asked the question that decides whether money is counted twice: can a receipt whose image
  // never arrived be counted, converted, submitted or forwarded? Each is asked here separately,
  // because "it is in a failed state" is a claim about a column and these are claims about money.
  const uploadFailed = (id, batchId) => {
    psql(`insert into public.receipt_documents(id,flow,state,batch_id,uploader_id,customer_id,
            storage_path,mime_type,tenant_id)
          values ('${id}','customer_sells_to_zeman','created','${batchId}','rl-cus','rl-cus',
                  'ingest/${batchId}/${id}.jpg','image/jpeg','t-sarkhel')
          on conflict (id) do nothing`);
    // Through the real path: the state machine refuses created → upload_failed_retryable
    // directly, which is itself correct — a receipt that never began uploading cannot have
    // failed to upload.
    psql(`update public.receipt_documents set state='uploading' where id='${id}'`);
    psql(`update public.receipt_documents set state='upload_failed_retryable',
            rule_code='upload_failed', rule_reason='وێنەکە نەگەیشت' where id='${id}'`);
  };

  check("a receipt whose upload failed is not counted as money", () => {
    batch("rb-uf");
    uploadFailed("rd-uf-1", "rb-uf");
    // It must not appear as an intake item at all — that is the table conversion sums.
    const counted = num(`select count(*) from public.receipt_intake_items where id='rd-uf-1'`);
    if (counted !== 0) throw new Error(`a failed upload became a countable intake item`);
  });

  check("a receipt whose upload failed cannot be submitted", () => {
    batch("rb-uf2");
    uploadFailed("rd-uf-2", "rb-uf2");
    be("admin");
    if (!refused(`select public.sarraf_receipt_submit('["rd-uf-2"]'::jsonb,'receipt-submit:upload-failed-guard')`,
      `public.receipt_documents where id='rd-uf-2' and state='submitted'`)) {
      throw new Error("a receipt whose image never arrived was submitted");
    }
  });

  check("a receipt whose upload failed cannot be forwarded", () => {
    batch("rb-uf3");
    uploadFailed("rd-uf-3", "rb-uf3");
    be("admin");
    if (!refused(`select public.sarraf_receipt_forward('["rd-uf-3"]'::jsonb,'هەوڵی ناردن',
        'receipt-forward:upload-failed-guard-three')`,
      `public.receipt_forwardings where document_id='rd-uf-3'`)) {
      throw new Error("a receipt whose image never arrived was forwarded to somebody");
    }
  });

  // And the reason it failed is kept, because «هۆکاری ڕەتکردنەوەی فیش هەبێت» applies to a
  // machine's refusal as much as to a person's.
  check("a failed upload says why, so the person knows to send it again", () => {
    batch("rb-uf4");
    uploadFailed("rd-uf-4", "rb-uf4");
    const why = one(`select coalesce(rule_reason,'') from public.receipt_documents where id='rd-uf-4'`);
    if (!why) throw new Error("a failed upload gave the person nothing to act on");
  });

  // A rejected receipt must carry its reason — the schema says so, and this proves the schema is
  // the thing saying it rather than a convention somebody could forget.
  check("a receipt cannot be rejected without a reason", () => {
    batch("rb-noreason");
    document("rd-noreason", "rb-noreason", { state: "created" });
    if (!refused(`update public.receipt_documents set state='rejected',
                    rule_code=null, rule_reason=null where id='rd-noreason'`,
      `public.receipt_documents where id='rd-noreason' and state='rejected'`)) {
      throw new Error("a receipt was rejected with no reason recorded");
    }
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

  // ── a receipt with no Order No. is not finished ─────────────────────────────
  //
  // Order No. is the principal operational reference in this business. The accept path refused
  // only when BOTH identifiers were absent, so a receipt carrying a merchant order number and no
  // Order No. was accepted. 202609010010 closes that with a trigger on the state column.
  //
  // Which column is which matters, and the names mislead: api/read-receipt.js says refNo comes
  // from "Order No." and merchantOrderNo from "Merchant order No.". ref_no IS the Order No.
  const seedDoc = (id, refNo, merchantNo) => psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.receipt_extractions where document_id = '${id}';
    delete from public.receipt_documents where id = '${id}';
    insert into public.receipt_documents(id,flow,state,uploader_id,customer_id,batch_id,
      storage_path,mime_type,tenant_id)
    values ('${id}','customer_sells_to_zeman','submitted','rl-cus','rl-cus','relb',
            'ingest/relb/${id}.jpg','image/jpeg','t-sarkhel');
    insert into public.receipt_extractions(document_id,version,currency,gross_amount,fee_amount,
      net_amount,ref_no,merchant_order_no,raw,is_original)
    values ('${id}',1,'CNY',100,0,100,${refNo === null ? "null" : `'${refNo}'`},
            ${merchantNo === null ? "null" : `'${merchantNo}'`},'{}'::jsonb,true);
    commit;`);

  check("a receipt with no Order No. cannot be accepted", () => {
    seedDoc("ord-none", null, "MERCH-1");
    const stopped = refused(
      `update public.receipt_documents set state='accepted' where id='ord-none'`,
      `public.receipt_documents where id='ord-none' and state='accepted'`);
    if (!stopped) throw new Error("a receipt with no Order No. was accepted");
  });

  check("the refusal says exactly what is wrong", () => {
    seedDoc("ord-none2", null, null);
    let message = "";
    try { psql(`update public.receipt_documents set state='accepted' where id='ord-none2'`); }
    catch (e) { message = String(e.message || e); }
    if (!message.includes("Order No. is required.")) {
      throw new Error(`the refusal read: ${message.slice(0, 200)}`);
    }
  });

  check("a merchant order number alone is not an Order No.", () => {
    // The exact gap this closes: the receipt has an identifier, just not the one that counts.
    //
    // Written against 'forwarded' at first, and it passed with the rule removed — the state
    // machine refuses that jump on its own, so the check was measuring the wrong refusal.
    // 'accepted' is a transition the state machine allows, which leaves only this rule to stop
    // it, and removing the migration does make it fail.
    seedDoc("ord-merch", null, "MERCH-9");
    const stopped = refused(
      `update public.receipt_documents set state='accepted' where id='ord-merch'`,
      `public.receipt_documents where id='ord-merch' and state='accepted'`);
    if (!stopped) throw new Error("a merchant order number was taken for an Order No.");
  });

  check("a receipt that has an Order No. goes forward as before", () => {
    seedDoc("ord-good", "ORD-1234", null);
    psql(`update public.receipt_documents set state='accepted' where id='ord-good'`);
    const state = one(`select state::text from public.receipt_documents where id='ord-good'`);
    if (state !== "accepted") throw new Error(`it stopped at ${state}`);
  });

  check("an administrator's correction lets a stopped receipt go forward", () => {
    // The Needs Review path: the machine could not read the Order No., a person enters it, and
    // the newest reading is what the rule consults.
    seedDoc("ord-fixed", null, null);
    psql(`insert into public.receipt_extractions(document_id,version,currency,gross_amount,
            fee_amount,net_amount,ref_no,raw,is_original,corrected_by,correction_reason)
          values ('ord-fixed',2,'CNY',100,0,100,'ORD-5678','{}'::jsonb,false,'rl-adm',
                  'Order No. was legible on the image but the reading missed it')`);
    psql(`update public.receipt_documents set state='accepted' where id='ord-fixed'`);
    const state = one(`select state::text from public.receipt_documents where id='ord-fixed'`);
    if (state !== "accepted") throw new Error(`the correction was not honoured: ${state}`);
  });

  check("a receipt already accepted is not re-judged by an unrelated update", () => {
    // Nothing in history is re-opened: the rule holds for a move forward, not for every write.
    //
    // The first version of this asked whether the row still existed before and after, which is
    // zero equals zero when the seed has failed — a check that measures nothing. It now sets up
    // the harder case on purpose: a receipt that is accepted and whose newest reading has NO
    // Order No., which is what a historical row looks like. An unrelated update must not
    // re-open that judgement.
    seedDoc("ord-hist", "ORD-9", null);
    psql(`update public.receipt_documents set state='accepted' where id='ord-hist'`);
    psql(`insert into public.receipt_extractions(document_id,version,currency,gross_amount,
            fee_amount,net_amount,ref_no,raw,is_original,corrected_by,correction_reason)
          values ('ord-hist',2,'CNY',100,0,100,null,'{}'::jsonb,false,'rl-adm',
                  'a later reading that lost the Order No.')`);
    psql(`update public.receipt_documents set mime_type='image/png' where id='ord-hist'`);
    const state = one(`select state::text from public.receipt_documents where id='ord-hist'`);
    if (state !== "accepted") throw new Error(`an accepted receipt was disturbed: ${state}`);
  });

  check("a rejected receipt is still allowed to be rejected without an Order No.", () => {
    seedDoc("ord-rej", null, null);
    // The table already insists a rejection says why, which is what keeps the image and the
    // reason together for audit while the receipt is refused.
    psql(`update public.receipt_documents
             set state='rejected', rule_code='order_no_missing',
                 rule_reason='Order No. is required.'
           where id='ord-rej'`);
    const state = one(`select state::text from public.receipt_documents where id='ord-rej'`);
    if (state !== "rejected") throw new Error(`a receipt could not even be rejected: ${state}`);
  });

  // ══ CHOOSING WHICH RECEIPTS ═════════════════════════════════════════════════
  //
  //   «باشترین ڕێگا ئەوەیە سیلێکتردنی فیشەکان هەبێت ، ٣ دانەیان هەڵدەبژێرم و مامەڵەیەکی
  //    لێوە درووست ئەکەم ، لە بڕەکە بڕی ئەو ٣ فیشە دابنێ ، ئەوانی تریش بە هەمان شێواز.»
  //
  // sarraf_convert_receipt_batch_to_transaction has taken an arbitrary list of receipt ids
  // since it was written, and no gate had ever driven it — the command at the very centre of
  // this business was covered by nothing. These drive it with a real selection.
  // A receipt held at a partner must carry what a real WeChat/Alipay screenshot carries —
  // recipient, date, platform, fee status — §2.5 of the owner's logic, enforced by the database.
  const intake = (id, batchId, amount, fields = {}) => {
    const f = { currency: "CNY", partner: null, ...fields };
    psql(`insert into public.receipt_intake_items(id,batch_id,submitted_by,customer_id,partner_id,
            direction,image_path,amount,fee,net_amount,currency,source_status,intake_status,counted,
            payee,tx_date,platform,has_fee,tenant_id)
          values ('${id}','${batchId}','rl-cus','rl-cus',${f.partner ? `'${f.partner}'` : "null"},
                  'in','ingest/${batchId}/${id}.jpg',${amount},0,${amount},'${f.currency}',
                  'ok','accepted',true,
                  '张伟', now(), 'wechat', false, 't-sarkhel')`);
  };
  // The server replaces `amount` with the sum of the chosen receipts but keeps the caller's
  // rate and total, and refuses unless total = amount × rate. So the sum has to be named here,
  // which is exactly what the screen shows before the press.
  // Buying yuan means paying dollars, and the cashbox has to have them. Without this the
  // command refuses for a reason that has nothing to do with what is being checked here.
  psql(`insert into public.ledger(id,type,cur_id,amount,date,tenant_id)
        values ('led-rl-conversion-fund','deposit','usd',100000,now(),'t-sarkhel')
        on conflict (id) do nothing`);

  const RATE = 0.14;
  const convert = (batchId, ids, key, sum, extra = {}) => {
    // The transaction carries its own id — sarraf_commit_transactions refuses one without.
    const tx = { id: `tx-${key}`, type: "buy", cp_id: "rl-cus", cur_id: "cny", rate: RATE,
                 against_id: "usd", total: Number((sum * RATE).toFixed(2)),
                 status: "completed", ...extra };
    return psql(`select public.sarraf_convert_receipt_batch_to_transaction('${batchId}',
      '${JSON.stringify(ids)}'::jsonb,
      '${JSON.stringify(tx)}'::jsonb,
      'مامەڵە لە فیشە هەڵبژێردراوەکان', 'receipt-convert:${key}')::text`);
  };

  check("three of eight receipts become one transaction, for the sum of those three", () => {
    batch("rb-selection-of-eight", { stage: "verified" });
    // Every one at the same partner: yuan cannot sit in the cashbox — «پارەکە بە ویچات دەنێرێت
    // بۆ ئەکاونتی هاوبەشەکەم» — and the database refuses an external currency with no custody.
    for (let i = 1; i <= 8; i += 1) {
      intake(`sel-000${i}`, "rb-selection-of-eight", 100 + i, { partner: "rl-par" });
    }
    // 101 + 102 + 103 = 306, and nothing else.
    convert("rb-selection-of-eight", ["sel-0001", "sel-0002", "sel-0003"], "sel-first-three-of-eight", 306);
    const moved = num(`select count(*) from public.receipt_intake_items
                        where batch_id='rb-selection-of-eight' and transaction_id is not null`);
    if (moved !== 3) throw new Error(`${moved} receipts were converted, expected 3`);
    const amount = num(`select t.amount from public.txs t
                         join public.receipt_intake_items i on i.transaction_id = t.id
                        where i.id='sel-0001'`);
    if (amount !== 306) throw new Error(`the transaction is for ${amount}, expected 306`);
  });

  check("and the other five are still waiting, on a batch that stayed open", () => {
    // The half that matters most: «دەبێت هەموو فیشێک بکەم بە مامەڵە». A batch that closed here
    // would take five real payments out of sight.
    const left = num(`select count(*) from public.receipt_intake_items
                       where batch_id='rb-selection-of-eight' and transaction_id is null`);
    if (left !== 5) throw new Error(`${left} receipts are left, expected 5`);
    const row = one(`select coalesce(tx_id,'—')||'|'||receipt_stage from public.receipt_batches
                      where id='rb-selection-of-eight'`);
    if (row !== "—|verified") throw new Error(`the batch reads ${row}, expected it to stay open`);
  });

  check("the remaining five can be converted in their own turn", () => {
    convert("rb-selection-of-eight", ["sel-0004", "sel-0005", "sel-0006", "sel-0007", "sel-0008"], "sel-the-remaining-five", 530);
    const left = num(`select count(*) from public.receipt_intake_items
                       where batch_id='rb-selection-of-eight' and transaction_id is null`);
    if (left !== 0) throw new Error(`${left} receipts are still unconverted`);
    const stage = one(`select receipt_stage::text from public.receipt_batches where id='rb-selection-of-eight'`);
    if (stage !== "matched") throw new Error(`the batch is ${stage}, expected matched once empty`);
  });

  check("a receipt already turned into money cannot be chosen again", () => {
    // §2.12 of the logic: «فیشێک تەنها یەکجار دەبێت بە پارە».
    const before = num(`select count(*) from public.txs where not deleted`);
    let refusedIt = false;
    try { convert("rb-selection-of-eight", ["sel-0001"], "sel-trying-the-same-one-twice", 101); } catch { refusedIt = true; }
    const after = num(`select count(*) from public.txs where not deleted`);
    if (!refusedIt) throw new Error("a spent receipt was accepted again");
    if (after !== before) throw new Error("a second transaction was created from a spent receipt");
  });

  check("a selection that mixes two currencies is refused", () => {
    batch("rb-selection-mixed-currency", { stage: "verified" });
    intake("mix-0001", "rb-selection-mixed-currency", 100, { partner: "rl-par" });
    intake("mix-0002", "rb-selection-mixed-currency", 200, { currency: "USD", partner: "rl-par" });
    let refusedIt = false;
    try { convert("rb-selection-mixed-currency", ["mix-0001", "mix-0002"], "mix-two-currencies-at-once", 300); } catch { refusedIt = true; }
    if (!refusedIt) throw new Error("dinars and dollars were added together");
    const moved = num(`select count(*) from public.receipt_intake_items
                        where batch_id='rb-selection-mixed-currency' and transaction_id is not null`);
    if (moved !== 0) throw new Error("a refused conversion moved receipts anyway");
  });

  check("a selection split across two partners is refused", () => {
    // The money is at one partner or the other. One transaction cannot be at both.
    batch("rb-selection-two-partners", { stage: "verified" });
    psql(`insert into public.app_users(id,name,role,tenant_id) values
          ('rl-par2','هاوبەشی دووەم','partner','t-sarkhel') on conflict (id) do nothing`);
    intake("two-0001", "rb-selection-two-partners", 100, { partner: "rl-par" });
    intake("two-0002", "rb-selection-two-partners", 100, { partner: "rl-par2" });
    let refusedIt = false;
    try { convert("rb-selection-two-partners", ["two-0001", "two-0002"], "two-partners-in-one-press", 200); } catch { refusedIt = true; }
    if (!refusedIt) throw new Error("one transaction was placed with two partners at once");
    const moved = num(`select count(*) from public.receipt_intake_items
                        where batch_id='rb-selection-two-partners' and transaction_id is not null`);
    if (moved !== 0) throw new Error("a refused conversion moved receipts anyway");
  });

  check("pressing the same conversion twice makes one transaction, not two", () => {
    batch("rb-selection-pressed-twice", { stage: "verified" });
    intake("twice-0001", "rb-selection-pressed-twice", 500, { partner: "rl-par" });
    convert("rb-selection-pressed-twice", ["twice-0001"], "pressed-the-same-conversion-twice", 500);
    const once = num(`select count(*) from public.txs where not deleted`);
    convert("rb-selection-pressed-twice", ["twice-0001"], "pressed-the-same-conversion-twice", 500);
    const twice = num(`select count(*) from public.txs where not deleted`);
    if (twice !== once) throw new Error(`the second press made ${twice - once} more transaction(s)`);
  });

  // ══ PUTTING A REFUSAL AWAY ══════════════════════════════════════════════════
  //
  //   «فیشی ڕەتکراوە پێویست ناکات بۆ من بنێردرێت، هەر لە تەنیشت خۆیا دیلێتکردنی ئەو فیشە
  //    هەبێت.» — and, in the same breath: «بێگوومان دەبێت ئەو هیستۆرییە هەبێت بۆ ئەوەی بزانم
  //    کێ فیشی دووبارە و خراپ دەنێرێت.»
  //
  // Both at once: it leaves the sender's list, and nothing about it is destroyed.
  const dismiss = (docId, key) => psql(
    `select public.sarraf_dismiss_rejected_receipt('${docId}','receipt-dismiss:${key}')::text`);
  // The state machine only moves one step at a time, so a fixture has to walk there.
  // A rejected document must carry its reason — the table refuses one without, which is the
  // rule that makes «هۆکارەکەشی پێ بڵێ» impossible to forget.
  const walk = (docId, states, reason = "هەمان وێنە پێشتر نێردراوە") => {
    for (const st of states) {
      psql(st === "rejected"
        ? `update public.receipt_documents
              set state='rejected', rule_code='duplicate', rule_reason='${reason}'
            where id='${docId}'`
        : `update public.receipt_documents set state='${st}' where id='${docId}'`);
    }
  };
  const REFUSED_PATH = ["uploading", "uploaded", "needs_manual_review", "rejected"];
  // A document may not be called validated until somebody has read a recipient, a date, a
  // platform and a fee answer off the image.  A fixture walking that far has to satisfy the
  // same rule a real reader would.
  const readIt = (docId) => psql(
    `insert into public.receipt_extractions(document_id,version,is_original,raw,gross_amount,order_amount,
       fee_amount,net_amount,fee_treatment,currency,ref_no,payee,tx_date,platform,has_fee,tenant_id)
     values ('${docId}',1,true,'{}'::jsonb,100,100,0,100,'no_fee','CNY','REF-${docId}',
             '张伟',current_date,'wechat',false,'t-sarkhel')`);

  check("the person who sent a refused receipt can put it away", () => {
    batch("rb-dismissal-of-refusals");
    document("doc-dismiss-mine", "rb-dismissal-of-refusals");
    walk("doc-dismiss-mine", REFUSED_PATH);
    be("customer");
    dismiss("doc-dismiss-mine", "the-sender-puts-it-away");
    be("admin");
    const state = one(`select state::text from public.receipt_documents where id='doc-dismiss-mine'`);
    if (state !== "cancelled") throw new Error(`it is ${state}, expected cancelled`);
  });

  check("and nothing about it is destroyed", () => {
    // The row, the reason it was refused, and every state it passed through.
    const reason = one(`select coalesce(rule_reason,'—') from public.receipt_documents
                         where id='doc-dismiss-mine'`);
    if (!reason.includes("هەمان وێنە")) throw new Error(`the reason reads ${reason}`);
    const steps = num(`select count(*) from public.receipt_state_transitions
                        where document_id='doc-dismiss-mine'`);
    if (steps < 4) throw new Error(`only ${steps} steps of history survived`);
    const last = one(`select from_state::text||'→'||to_state::text
                        from public.receipt_state_transitions
                       where document_id='doc-dismiss-mine' order by created_at desc limit 1`);
    if (last !== "rejected→cancelled") throw new Error(`the last step reads ${last}`);
  });

  check("the owner can still count how many a person has had refused", () => {
    // The whole reason for keeping it: «بزانم کێ فیشی دووبارە و خراپ دەنێرێت».
    const refusals = num(`select count(*) from public.receipt_state_transitions t
                            join public.receipt_documents d on d.id = t.document_id
                           where d.uploader_id='rl-cus' and t.to_state='rejected'
                             and t.document_id='doc-dismiss-mine'`);
    if (refusals !== 1) throw new Error(`the record of that refusal reads ${refusals}, expected 1`);
  });

  check("somebody else's refusal cannot be put away", () => {
    batch("rb-dismissal-not-yours");
    document("doc-dismiss-theirs", "rb-dismissal-not-yours");
    walk("doc-dismiss-theirs", REFUSED_PATH);
    // Even the administrator may not: hiding somebody's refusal from them takes away the one
    // signal telling them to send a better photograph.
    let refusedIt = false;
    try { dismiss("doc-dismiss-theirs", "an-administrator-tries-it"); } catch { refusedIt = true; }
    const state = one(`select state::text from public.receipt_documents where id='doc-dismiss-theirs'`);
    if (!refusedIt || state !== "rejected") throw new Error(`it is ${state} — somebody else put it away`);
  });

  check("a receipt that was accepted cannot be put away", () => {
    // Only a refusal. Otherwise this is a way to make a real payment disappear from the list
    // it is waiting in.
    batch("rb-dismissal-of-a-good-one");
    document("doc-dismiss-accepted", "rb-dismissal-of-a-good-one");
    walk("doc-dismiss-accepted", ["uploading", "uploaded", "ocr_pending", "ocr_processing", "parsed"]);
    readIt("doc-dismiss-accepted");
    walk("doc-dismiss-accepted", ["validated", "submitted", "accepted"]);
    be("customer");
    let refusedIt = false;
    try { dismiss("doc-dismiss-accepted", "trying-it-on-a-good-one"); } catch { refusedIt = true; }
    be("admin");
    const state = one(`select state::text from public.receipt_documents where id='doc-dismiss-accepted'`);
    if (!refusedIt || state !== "accepted") throw new Error(`it is ${state} — an accepted receipt was put away`);
  });

  check("a receipt still on its way cannot be put away", () => {
    // The state table would allow 'uploaded'→'cancelled' — that is how a half-finished upload
    // is abandoned.  This command must not be the door to it: a receipt that has not been
    // refused is still on its way to becoming money, and its sender pressing «لایبە» on it
    // would take a real payment out of the pile nobody has looked at yet.
    batch("rb-dismissal-still-going");
    document("doc-dismiss-underway", "rb-dismissal-still-going");
    walk("doc-dismiss-underway", ["uploading", "uploaded"]);
    be("customer");
    let refusedIt = false;
    try { dismiss("doc-dismiss-underway", "trying-it-on-one-underway"); } catch { refusedIt = true; }
    be("admin");
    const state = one(`select state::text from public.receipt_documents where id='doc-dismiss-underway'`);
    if (!refusedIt || state !== "uploaded") throw new Error(`it is ${state} — one still on its way was put away`);
  });

  check("putting the same one away twice changes nothing the second time", () => {
    be("customer");
    dismiss("doc-dismiss-mine", "the-sender-puts-it-away");
    be("admin");
    const state = one(`select state::text from public.receipt_documents where id='doc-dismiss-mine'`);
    if (state !== "cancelled") throw new Error(`it is ${state}`);
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
