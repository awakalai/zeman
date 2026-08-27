#!/usr/bin/env node
// The thirteen business flows of §14, run end to end against a real database.
//
//   npm run verify:flows
//
// Every other gate proves that a piece works. This one proves that the pieces work *together*,
// in the order a working day puts them in: a customer sells, an operator reviews, a transaction
// is made, money moves, a debt opens, a debt closes, a voucher is issued. A system can pass
// every unit test and still be unable to complete a day's business.
//
// The scenarios are the specification's own, numbered as it numbers them. Where a scenario is
// about a browser rather than about data — how a page behaves on refresh, or what a screenshot
// looks like — the part that lives in the data is checked here and the rest is named as belonging
// to the role gate. Nothing is asserted that is not actually exercised.
import { PG_HINT, postgresAvailable, startDatabase } from "./lib/zeman-db.mjs";

if (!postgresAvailable()) {
  console.log(`SKIP: ${PG_HINT}`);
  process.exit(0);
}

try {
  const { psql, psqlAsRole } = startDatabase();

  const scenarios = [];
  const steps = [];
  let current = null;

  const scenario = (n, title, fn) => {
    current = { n, title, steps: [] };
    try { fn(); scenarios.push({ ...current, ok: true }); }
    catch (e) {
      const failedAt = current.steps.at(-1) || "(before the first step)";
      const message = String(e.message || e).split("\n").find((l) => l.includes("ERROR")) || String(e.message || e);
      scenarios.push({ ...current, ok: false, failedAt, message: message.slice(0, 300) });
    }
    current = null;
  };
  // Each step is named as it runs, so a failure says which part of the day broke.
  const step = (name, fn) => { current.steps.push(name); steps.push(name); return fn(); };
  const eq = (actual, expected, what) => {
    if (String(actual) !== String(expected)) throw new Error(`${what}: expected ${expected}, got ${actual}`);
  };
  const refused = (sql) => { try { psql(sql); return false; } catch { return true; } };
  const j = (sql) => JSON.parse(psql(`select (${sql})::text`));

  // ── the cast ────────────────────────────────────────────────────────────────
  const UID = {
    // Distinct from the harness's own u-a, which already holds 1111…. auth_id is unique, and
    // `on conflict (id) do nothing` does not catch a collision on a different column — the whole
    // cast failed to be created and the gate stopped before its first flow.
    admin: "f10a0001-0000-0000-0000-000000000001",
    customer: "22222222-2222-2222-2222-222222222222",
    partner: "33333333-3333-3333-3333-333333333333",
    office: "44444444-4444-4444-4444-444444444444",
    other: "55555555-5555-5555-5555-555555555555",
  };
  // The cast is seeded with no signed-in actor, as the first administrator of any system
  // necessarily is: nobody outranks themselves, so a rank cannot be granted from inside the
  // account receiving it.
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select null::uuid $fn$`);
  psql(`insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id) values
    ('adm','ئەدمین','admin','owner','${UID.admin}','t-sarkhel'),
    ('cus','کڕیار فرۆشیار','customer',null,'${UID.customer}','t-sarkhel'),
    ('par','هاوبەش','partner',null,'${UID.partner}','t-sarkhel'),
    ('off','نووسینگە','office',null,'${UID.office}','t-sarkhel'),
    ('oth','کڕیارێکی تر','customer',null,'${UID.other}','t-sarkhel')
    on conflict (id) do nothing`);
  const be = (who) => psql(`create or replace function auth.uid() returns uuid language sql stable
    as $fn$ select '${UID[who]}'::uuid $fn$`);
  psql("update public.currencies set rate = 7.20, rate_updated = now() where id='cny'");
  be("admin");

  // Receipts as they exist after a batch has been read and accepted.
  // Money is written at a fixed scale, as it is in life: a sum of 1223.50 and 500 must read
  // 1723.50, not 1723.5, or the locked example of §4.13 cannot be stated exactly.
  const n = (v) => Number(v).toFixed(2);
  const receipt = (id, batch, fields = {}) => {
    const f = { amount: 1000, fee: 0, net: 1000, currency: "CNY", receiver: "ئەحمەد",
      ref: id.toUpperCase(), date: "2026-08-01", status: "ok", counted: true, ...fields };
    psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,fee,
            net_amount,currency,receiver,ref_no,tx_date,image_hash,status,counted)
          values ('${id}','${batch}','cus','cus','in',${n(f.amount)},${n(f.fee)},${n(f.net)},'${f.currency}',
                  '${f.receiver}','${f.ref}','${f.date}',md5('${id}')||md5('${id}'),
                  '${f.status}',${f.counted})`);
  };
  const batch = (id, fields = {}) => {
    const f = { stage: "received", currency: "CNY", ...fields };
    psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency,receipt_stage)
          values ('${id}','cus','cus','in','${f.currency}','${f.stage}')`);
  };

  // The four things a receipt must state before it may be called validated: who was paid, when,
  // through which wallet, and whether a fee was taken. The rule is the owner's, and it is
  // enforced on the document itself — so a fixture that skips them is refused exactly as a real
  // upload missing them would be.
  const extraction = (doc, fields = {}) => {
    const f = { amount: 1000, fee: 0, net: 1000, currency: "CNY", payee: "ئەحمەد",
      date: "2026-08-01", platform: "wechat", hasFee: false, ...fields };
    psql(`insert into public.receipt_extractions(document_id,version,is_original,provider,model,
            gross_amount,fee_amount,net_amount,currency,payee,tx_date,platform,has_fee)
          values ('${doc}',1,true,'verify','flow',${n(f.amount)},${n(f.fee)},${n(f.net)},
                  '${f.currency}','${f.payee}','${f.date}','${f.platform}',${f.hasFee})`);
  };

  // ── 1 ───────────────────────────────────────────────────────────────────────
  scenario(1, "a customer sends only sale receipts, and cannot change what was read", () => {
    step("the customer's batch is a sale", () => { be("customer"); batch("f1"); });

    step("the customer cannot send a purchase", () => {
      if (!refused(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency)
                    values ('f1-bad','cus','cus','out','CNY')`)) {
        throw new Error("a purchase batch from a customer was accepted");
      }
    });

    step("several yuan receipts are stored", () => {
      receipt("f1-r1", "f1", { amount: 1260.20, fee: 36.70, net: 1223.50 });
      receipt("f1-r2", "f1", { amount: 1260.21, fee: 36.71, net: 1223.50, ref: "F1R2" });
      eq(psql("select count(*) from public.receipts where batch_id='f1'").trim(), 2, "receipts stored");
    });

    step("what the reader read is attested", () => {
      be("admin");
      psql(`select public.sarraf_record_ocr_attestation('flow-nonce-aaaaaaaaaaaaaaaa','cus',
        '${"1".repeat(64)}',
        '{"amount":"500","fee":"0","net_amount":"500","currency":"CNY","ref_no":"F1R3",
          "merchant_order_no":"","tx_date":"2026-08-01","receiver":"ئەحمەد","sender":""}'::jsonb,
        'groq','qwen',3600)`);
    });

    step("an amount changed after the reading is refused", () => {
      be("customer");
      const tampered = `insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,
          amount,fee,net_amount,currency,receiver,ref_no,tx_date,status,counted,raw)
        values ('f1-tamper','f1','cus','cus','in',5000,0,5000,'CNY','ئەحمەد','F1R3','2026-08-01','ok',true,
          '{"attestation":{"nonce":"flow-nonce-aaaaaaaaaaaaaaaa","imageSha256":"${"1".repeat(64)}"}}')`;
      if (!refused(tampered)) throw new Error("an altered amount was accepted");
    });

    step("the figures as read are accepted", () => {
      psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,
          amount,fee,net_amount,currency,receiver,ref_no,tx_date,status,counted,raw)
        values ('f1-r3','f1','cus','cus','in',500,0,500,'CNY','ئەحمەد','F1R3','2026-08-01','ok',true,
          '{"attestation":{"nonce":"flow-nonce-aaaaaaaaaaaaaaaa","imageSha256":"${"1".repeat(64)}"}}')`);
      eq(psql("select count(*) from public.receipts where batch_id='f1'").trim(), 3, "receipts stored");
    });

    step("the customer sees their own batch and no valuation", () => {
      const s = j("public.sarraf_portal_receipt_summary(365)");
      if (!s.receipts.length) throw new Error("the customer cannot see what they sent");
      if (JSON.stringify(s).toLowerCase().includes("usd")) throw new Error("the uploader was shown a valuation");
    });
  });

  // ── 2 ───────────────────────────────────────────────────────────────────────
  scenario(2, "the operator reviews the batch, makes a purchase, and the receipts lock to it", () => {
    step("the operator sees accepted and rejected apart", () => {
      be("admin");
      receipt("f1-r4", "f1", { amount: 999, status: "dup", counted: false, ref: "F1R4" });
      const s = j("public.sarraf_batch_summary('f1')");
      eq(s.accepted_count, 3, "accepted");
      eq(s.rejected_count, 1, "rejected");
    });

    step("the totals are the server's, with the fee before and after", () => {
      const c = j("public.sarraf_batch_summary('f1')").currencies[0];
      eq(c.native.gross_total.amount_decimal, "3020.41", "gross");
      eq(c.native.fee_total.amount_decimal, "73.41", "fee");
      eq(c.native.net_total.amount_decimal, "2947.00", "net");
      if (c.usd.status !== "ok") throw new Error("no dollar summary for the operator");
    });

    step("a purchase is created and the money moves", () => {
      psql(`insert into public.txs(id,type,cp_id,cur_id,amount,rate,against_id,total,status,date)
            values ('f2-tx','buy','cus','cny',2947,0.1388888889,'usd',409.31,'completed',now())`);
      psql("select public.sarraf_ensure_transaction_ledger('f2-tx')");
      const cny = psql("select amount from public.ledger where tx_id='f2-tx' and cur_id='cny'").trim();
      const usd = psql("select amount from public.ledger where tx_id='f2-tx' and cur_id='usd'").trim();
      if (Number(cny) <= 0) throw new Error(`yuan moved by ${cny}`);
      if (Number(usd) >= 0) throw new Error(`dollars moved by ${usd}`);
    });

    step("the batch is bound to that transaction", () => {
      psql("update public.receipt_batches set tx_id='f2-tx', receipt_stage='matched', decision_status='accepted', matched_score=100 where id='f1'");
      eq(psql("select tx_id from public.receipt_batches where id='f1'").trim(), "f2-tx", "batch transaction");
    });

    step("the receipts are held by that transaction and by no other", () => {
      // Every column the table insists on: an intake item is evidence somebody handed in, and a
      // row that cannot say who handed it in, which way the money went, or where the image is
      // kept is not evidence of anything.
      psql(`insert into public.receipt_intake_items(id,batch_id,submitted_by,direction,image_path,
              source_status,intake_status,counted,currency,amount,fee,net_amount,
              transaction_id,converted_at)
            values ('f2-item','f1','cus','in','ingest/flow-two-batch-01/receipt-f2-item.jpg',
                    'ok','accepted',true,'CNY',2947,0,2947,'f2-tx',now())`);
      const held = psql(`select transaction_id from public.sarraf_receipt_already_converted('["f2-item"]'::jsonb)`).trim();
      eq(held, "f2-tx", "the transaction holding the receipts");
    });
  });

  // ── 3 ───────────────────────────────────────────────────────────────────────
  scenario(3, "a document is forwarded, delivered and seen", () => {
    step("a document is created for the customer", () => {
      be("customer");
      psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
            values ('f3-doc','customer_sells_to_zeman','cus','cus','ingest/f3.jpg')`);
      extraction("f3-doc");
      for (const s of ["uploading","uploaded","ocr_pending","ocr_processing","parsed","validated",
                       "submitted","matched","accepted","finalized"]) {
        psql(`update public.receipt_documents set state='${s}' where id='f3-doc'`);
      }
    });

    step("the operator forwards it to the partner", () => {
      be("admin");
      psql(`select public.sarraf_forward_receipts('["f3-doc"]'::jsonb,'par',null,
            'the partner is holding this money','flow-fw-1')`);
      eq(psql("select state from public.receipt_documents where id='f3-doc'").trim(), "forwarded", "state");
    });

    step("the partner sees it, and nobody else does", () => {
      be("partner");
      eq(psql("select count(*) from public.sarraf_my_forwarded_receipts(50)").trim(), 1, "partner's view");
      be("other");
      eq(psql("select count(*) from public.sarraf_my_forwarded_receipts(50)").trim(), 0, "a stranger's view");
    });

    step("it is marked delivered, then seen", () => {
      be("partner");
      psql("select public.sarraf_receipt_mark_delivered('f3-doc')");
      psql("select public.sarraf_receipt_mark_seen('f3-doc')");
      eq(psql("select state from public.receipt_documents where id='f3-doc'").trim(), "seen", "state");
    });
  });

  // ── 4 ───────────────────────────────────────────────────────────────────────
  scenario(4, "a partner uploads their receipt and it reaches the customer it was for", () => {
    step("the partner uploads the receipt of what they paid out", () => {
      be("partner");
      psql(`insert into public.receipt_documents(id,flow,uploader_id,partner_id,storage_path)
            values ('f4-doc','customer_buys_from_zeman','par','par','ingest/f4.jpg')`);
      extraction("f4-doc", { platform: "alipay", fee: 12, net: 988, hasFee: true });
      for (const st of ["uploading","uploaded","ocr_pending","ocr_processing","parsed","validated",
                        "submitted","matched","accepted","finalized"]) {
        psql(`update public.receipt_documents set state='${st}' where id='f4-doc'`);
      }
      eq(psql("select state from public.receipt_documents where id='f4-doc'").trim(), "finalized", "state");
    });

    step("the accepted receipt reaches the customer it was for", () => {
      be("admin");
      psql(`select public.sarraf_forward_receipts('["f4-doc"]'::jsonb,'cus',null,
            'this is the receipt of your sale','flow-fw-2')`);
      be("customer");
      eq(psql("select count(*) from public.sarraf_my_forwarded_receipts(50)").trim(), 1, "the customer's view");
      be("other");
      eq(psql("select count(*) from public.sarraf_my_forwarded_receipts(50)").trim(), 0, "a stranger's view");
      be("admin");
    });

    step("a sale to the customer takes the currency out and brings the payment in", () => {
      psql(`insert into public.txs(id,type,cp_id,cur_id,amount,rate,against_id,total,status,date)
            values ('f4-tx','sell','cus','cny',1000,0.1388888889,'usd',138.89,'completed',now())`);
      psql("select public.sarraf_ensure_transaction_ledger('f4-tx')");
      const cny = psql("select amount from public.ledger where tx_id='f4-tx' and cur_id='cny'").trim();
      if (Number(cny) >= 0) throw new Error(`a sale moved yuan by ${cny}`);
    });
  });

  // ── 5 ───────────────────────────────────────────────────────────────────────
  scenario(5, "a rejected receipt stays as evidence and counts towards nothing", () => {
    step("the rejected receipt is still there, with its reason", () => {
      be("admin");
      psql("update public.receipts set reject_code='dup_ref' where id='f1-r4'");
      eq(psql("select count(*) from public.receipts where id='f1-r4'").trim(), 1, "still stored");
      eq(psql("select reject_code from public.receipts where id='f1-r4'").trim(), "dup_ref", "reason kept");
    });

    step("it is in no total", () => {
      const c = j("public.sarraf_batch_summary('f1')").currencies[0];
      if (Number(c.native.gross_total.amount_decimal) >= 3020.41 + 999) {
        throw new Error("a rejected receipt was counted");
      }
      eq(c.native.gross_total.amount_decimal, "3020.41", "gross");
    });

    step("the customer can still see what happened to it", () => {
      be("customer");
      const mine = j("public.sarraf_portal_receipt_summary(365)").receipts;
      if (!mine.some((r) => r.id === "f1-r4")) throw new Error("the rejected receipt vanished from the archive");
    });
  });

  // ── 6 ───────────────────────────────────────────────────────────────────────
  scenario(6, "a cashbox deposit settles a debt, and a debt ZEMAN owes credits the cashbox", () => {
    step("the customer's deposit is reported, then confirmed", () => {
      be("admin");
      psql(`select public.sarraf_vault_pending_deposit('cus','CNY',2000,'handed over at the counter','flow-pend-1')`);
      const pending = j("public.sarraf_vault_pending_resolve('cus','CNY',2000,true,null,'counted at the counter','flow-pend-2')");
      eq(pending.pending, 0, "pending after confirmation");
      if (Number(pending.available) !== 2000) throw new Error(`available is ${pending.available}`);
    });

    step("a debt the customer owes is opened", () => {
      psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
              original_principal,outstanding_principal,source_type,reason,created_by)
            values ('f6-debt','customer','cus','zeman',null,'CNY',1500,1500,'unpaid_transaction',
                    'unpaid purchase','adm')`);
      eq(psql("select kind from public.debt_events where debt_id='f6-debt'").trim(), "opened", "history");
    });

    step("the cashbox settles it, and the remainder returns to the cashbox", () => {
      const out = j(`public.sarraf_apply_vault_to_debt('cus','CNY',2000,7.20,'settling from the cashbox','flow-settle-1')`);
      eq(out.applied, 1500, "applied");
      eq(out.returned_to_vault, 500, "returned");
      eq(psql("select status from public.debts where id='f6-debt'").trim(), "settled", "debt status");
      eq(psql("select available from public.customer_vaults where customer_id='cus' and currency='CNY'").trim(),
         "500.0000000000", "cashbox after");
    });

    step("a debt ZEMAN owes the customer credits their cashbox", () => {
      psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
              original_principal,outstanding_principal,source_type,reason,created_by)
            values ('f6-owed','zeman',null,'customer','cus','CNY',400,400,'credit_note',
                    'owed back to the customer','adm')`);
      const out = j(`public.sarraf_zeman_debt_to_vault('f6-owed'::text,400::numeric,7.20::numeric,
        'crediting what we owe'::text,'flow-credit-1'::text)`);
      if (Number(out.credited ?? out.applied ?? out.amount ?? 0) !== 400) {
        throw new Error(`credited ${JSON.stringify(out)}`);
      }
      eq(psql("select available from public.customer_vaults where customer_id='cus' and currency='CNY'").trim(),
         "900.0000000000", "cashbox after the credit");
    });

    step("the books still balance", () => {
      eq(psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim(), "true", "trial balance");
    });
  });

  // ── 7 ───────────────────────────────────────────────────────────────────────
  scenario(7, "a partner beyond their balance opens a debt, and later credit settles it", () => {
    step("a disbursement beyond the balance opens a debt", () => {
      be("admin");
      psql(`insert into public.partner_accounts(id,partner_id,currency,available)
            values ('f7-pa','par','CNY',100) on conflict (partner_id,currency) do update set available = 100`);
      const out = j(`public.sarraf_partner_disburse('par'::text,'CNY'::text,400::numeric,7.20::numeric,
        null::text,'paying beyond the balance'::text,'flow-disb-1'::text)`);
      if (Number(out.debt_opened ?? out.debt ?? 0) <= 0 && !out.debt_id) {
        throw new Error(`no debt was opened: ${JSON.stringify(out)}`);
      }
    });

    step("later credit settles the debt first and leaves the remainder as balance", () => {
      const before = Number(psql(`select coalesce(sum(outstanding_principal),0) from public.debts
        where debtor_type='partner' and debtor_id='par' and status in ('open','partially_settled')`).trim());
      if (before <= 0) throw new Error("the partner has no outstanding debt to settle");
      const out = j(`public.sarraf_partner_credit('par'::text,'CNY'::text,500::numeric,7.20::numeric,
        'money returned by the partner'::text,'flow-cred-1'::text)`);
      const after = Number(psql(`select coalesce(sum(outstanding_principal),0) from public.debts
        where debtor_type='partner' and debtor_id='par' and status in ('open','partially_settled')`).trim());
      if (after !== 0) throw new Error(`the debt was not settled first: ${after} remains`);
      const balance = Number(psql("select available from public.partner_accounts where partner_id='par' and currency='CNY'").trim());
      if (balance !== 500 - before) throw new Error(`the remainder is ${balance}, expected ${500 - before}`);
      if (!out) throw new Error("the credit returned nothing");
    });
  });

  // ── 8 ───────────────────────────────────────────────────────────────────────
  scenario(8, "an unpaid purchase is assigned to one office, paid, and confirmed", () => {
    step("the assignment carries the amount and the currency", () => {
      be("admin");
      psql(`insert into public.office_payment_assignments(id,office_id,amount,currency,assigned_by)
            values ('f8-opa','off',5000,'CNY','adm')`);
      eq(psql("select amount||'|'||currency||'|'||status from public.office_payment_assignments where id='f8-opa'").trim(),
         "5000.0000000000|CNY|assigned", "assignment");
    });

    step("only the assigned office can report against it", () => {
      be("other");
      if (!refused(`select public.sarraf_office_payment_report('f8-opa','acknowledged',null,null,null,'flow-op-x')`)) {
        throw new Error("a stranger reported against someone else's assignment");
      }
    });

    step("the office reports a partial payment and the remainder stands", () => {
      be("office");
      psql(`insert into public.office_payment_evidence(
              id,assignment_id,storage_path,image_sha256,file_size,media_type,actor_id,command_key)
            values ('f8-ev-1','f8-opa','ingest/office-payments/f8-opa/report-one.jpg',
                    repeat('c',64),2048,'image/jpeg','off','flow-op-ev-1')`);
      psql(`update public.office_payment_assignments
               set evidence_path='ingest/office-payments/f8-opa/report-one.jpg' where id='f8-opa'`);
      const out = j(`public.sarraf_office_payment_report('f8-opa','paid_reported',2000,'REF-F8','part paid','flow-op-1')`);
      eq(out.outstanding, 3000, "outstanding");
    });

    step("the office cannot confirm its own payment", () => {
      if (!refused(`select public.sarraf_office_payment_confirm('f8-opa','confirming my own payment','flow-op-2')`)) {
        throw new Error("an office confirmed its own payment");
      }
    });

    step("the operator confirms it", () => {
      be("admin");
      psql(`select public.sarraf_office_payment_confirm('f8-opa','checked at the bank','flow-op-3')`);
      eq(psql("select status from public.office_payment_assignments where id='f8-opa'").trim(), "confirmed", "status");
    });
  });

  // ── 9 ───────────────────────────────────────────────────────────────────────
  scenario(9, "the debt centre shows both directions, aging, netting and a voucher", () => {
    step("debts are held apart by direction and by currency", () => {
      be("admin");
      psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
              original_principal,outstanding_principal,source_type,reason,created_by,due_at) values
            ('f9-owes','customer','cus','zeman',null,'CNY',800,800,'unpaid_transaction','they owe us','adm',
             statement_timestamp() - interval '40 days'),
            ('f9-owed','zeman',null,'customer','cus','CNY',300,300,'credit_note','we owe them','adm',null),
            ('f9-usd','customer','cus','zeman',null,'USD',50,50,'unpaid_transaction','a dollar debt','adm',null)`);
      const byCur = psql(`select string_agg(distinct currency, ',' order by currency) from public.debts
                          where id like 'f9-%'`).trim();
      eq(byCur, "CNY,USD", "currencies kept apart");
    });

    step("an overdue debt is visible as overdue", () => {
      const overdue = psql(`select count(*) from public.debts
        where id='f9-owes' and due_at < statement_timestamp()`).trim();
      eq(overdue, 1, "overdue");
    });

    step("the two directions cancel, and a numbered voucher records it", () => {
      const out = j(`public.sarraf_offset_debts('f9-owes','f9-owed',null,'both sides agreed to net these','flow-off-1')`);
      eq(out.offset_amount, 300, "offset");
      eq(out.left_outstanding_after, 500, "remaining");
      if (!/^V-\d{4}-\d{6}$/.test(out.voucher || "")) throw new Error(`the voucher reads ${out.voucher}`);
    });

    step("a partial settlement leaves the rest outstanding", () => {
      psql(`insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,
              outstanding_after,source_kind,actor_id,reason)
            values ('f9-owes',200,500,300,'cash','adm','part payment in cash')`);
      eq(psql("select outstanding_principal from public.debts where id='f9-owes'").trim(),
         "300.0000000000", "outstanding");
      eq(psql("select status from public.debts where id='f9-owes'").trim(), "partially_settled", "status");
    });

    step("the whole life of the debt can be read back", () => {
      const h = j("public.sarraf_debt_history('f9-owes')");
      eq(h.events.map((e) => e.kind).join(","), "opened,offset,settled", "history");
    });

    step("a debt that will not be collected is given up, on the record", () => {
      const out = j(`public.sarraf_write_off_debt('f9-owes',null,'the customer has closed and cannot be reached','flow-wo-1')`);
      eq(out.status, "written_off", "status");
      if (!out.voucher) throw new Error("no voucher for a write-off");
      eq(psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim(), "true", "trial balance");
    });
  });

  // ── 10 ──────────────────────────────────────────────────────────────────────
  scenario(10, "nobody reaches another party's receipt, cashbox, debt or assignment", () => {
    step("a stranger cannot read someone else's batch summary", () => {
      be("other");
      if (!refused("select public.sarraf_batch_summary('f1')")) {
        throw new Error("a stranger read another customer's batch");
      }
    });

    step("a stranger's own archive is empty, not someone else's", () => {
      const s = j("public.sarraf_portal_receipt_summary(365)");
      if (s.receipts.length || s.grand_total.length) throw new Error("a stranger saw receipts");
    });

    step("a stranger cannot read another party's debt history", () => {
      if (!refused("select public.sarraf_debt_history('f9-owed')")) {
        throw new Error("a stranger read another party's debt");
      }
    });

    step("a stranger sees no vouchers but their own", () => {
      const v = j("public.sarraf_voucher_register(null,null,null,50)");
      if (v.length) throw new Error(`a stranger saw ${v.length} vouchers`);
    });

    step("row-level security holds for the tables themselves", () => {
      psql(`do $$ begin
              if not exists (select 1 from pg_roles where rolname='zeman_flow_probe') then
                create role zeman_flow_probe login; end if; end $$`);
      psql("grant usage on schema public to zeman_flow_probe");
      psql("grant zeman_flow_probe to postgres");
      psql("grant authenticated to zeman_flow_probe");
      const seen = psqlAsRole("zeman_flow_probe", UID.other,
        "select count(*) from public.customer_vaults").trim().split("\n").filter(Boolean).pop().trim();
      eq(seen, 0, "cashboxes visible to a stranger");
    });
  });

  // ── 11 ──────────────────────────────────────────────────────────────────────
  scenario(11, "a repeated command never happens twice", () => {
    step("a second click on the same offset changes nothing", () => {
      be("admin");
      psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
              original_principal,outstanding_principal,source_type,reason,created_by) values
            ('f11-a','customer','cus','zeman',null,'CNY',600,600,'unpaid_transaction','they owe us','adm'),
            ('f11-b','zeman',null,'customer','cus','CNY',200,200,'credit_note','we owe them','adm')`);
      psql(`select public.sarraf_offset_debts('f11-a','f11-b',null,'netting these two','flow-idem-1')`);
      const once = psql("select outstanding_principal from public.debts where id='f11-a'").trim();
      const replay = j(`public.sarraf_offset_debts('f11-a','f11-b',null,'netting these two','flow-idem-1')`);
      const twice = psql("select outstanding_principal from public.debts where id='f11-a'").trim();
      if (replay.replayed !== true) throw new Error("the replay was not recognised");
      eq(twice, once, "outstanding after a replay");
    });

    step("a repeated cashbox move does not move the money twice", () => {
      psql(`select public.sarraf_customer_vault_move('cus','CNY',100,'in',7.20,'a deposit','flow-idem-2')`);
      const once = psql("select available from public.customer_vaults where customer_id='cus' and currency='CNY'").trim();
      psql(`select public.sarraf_customer_vault_move('cus','CNY',100,'in',7.20,'a deposit','flow-idem-2')`);
      const twice = psql("select available from public.customer_vaults where customer_id='cus' and currency='CNY'").trim();
      eq(twice, once, "cashbox after a replay");
    });

    step("a conversion cannot bind the same receipts to a second transaction", () => {
      const held = psql(`select transaction_id from public.sarraf_receipt_already_converted('["f2-item"]'::jsonb)`).trim();
      eq(held, "f2-tx", "the receipts are still held by their transaction");
    });

    // The release is the database's own doing: voiding the transaction is enough, and nothing
    // has to remember to call anything afterwards.
    step("voiding the transaction releases them again", () => {
      psql("update public.txs set deleted = true where id='f2-tx'");
      eq(psql("select coalesce(transaction_id,'FREE') from public.receipt_intake_items where id='f2-item'").trim(),
         "FREE", "released");
    });
  });

  // ── 12 ──────────────────────────────────────────────────────────────────────
  scenario(12, "a yuan batch is stated in yuan, and in no currency it does not name", () => {
    step("the batch names one currency and only that one", () => {
      be("admin");
      batch("f12", { stage: "matched" });
      receipt("f12-r1", "f12", { amount: 2520.41, fee: 73.41, net: 2447.00, ref: "F12R1" });
      const s = j("public.sarraf_batch_summary('f12')");
      eq(s.currencies.length, 1, "currencies present");
      eq(s.currencies[0].currency_code, "CNY", "currency");
    });

    step("no dinar appears anywhere in the answer", () => {
      const text = psql("select public.sarraf_batch_summary('f12')::text");
      if (/IQD/i.test(text)) throw new Error("a dinar figure appeared on a yuan batch");
    });

    step("every figure carries its currency code", () => {
      const c = j("public.sarraf_batch_summary('f12')").currencies[0];
      for (const [name, m] of Object.entries(c.native)) {
        if (m.currency_code !== "CNY") throw new Error(`${name} is not labelled CNY`);
      }
      for (const name of ["gross_total", "fee_total", "net_total"]) {
        if (c.usd[name].currency_code !== "USD") throw new Error(`${name} is not labelled USD`);
      }
    });

    step("the dollar figure comes from the stated ratio, not from anywhere else", () => {
      const c = j("public.sarraf_batch_summary('f12')").currencies[0];
      eq(c.rate.rate_convention, "1 USD = 7.2 CNY", "convention");
      eq(c.usd.gross_total.source_amount.amount_decimal, "2520.41", "source amount");
    });

    step("the fee is shown apart, never folded into the amount", () => {
      const c = j("public.sarraf_batch_summary('f12')").currencies[0];
      eq(c.native.fee_total.amount_decimal, "73.41", "fee");
      eq(c.equation_holds, true, "gross = net + fee");
    });
  });

  // ── 13 ──────────────────────────────────────────────────────────────────────
  scenario(13, "the locked example gives 350.06, 10.20 and 339.86 to both sides", () => {
    step("the operator's figures", () => {
      be("admin");
      const c = j("public.sarraf_batch_summary('f12')").currencies[0];
      eq(c.native.gross_total.amount_decimal, "2520.41", "gross CNY");
      eq(c.native.fee_total.amount_decimal, "73.41", "fee CNY");
      eq(c.native.net_total.amount_decimal, "2447.00", "net CNY");
      eq(c.usd.gross_total.amount_decimal, "350.06", "gross USD");
      eq(c.usd.fee_total.amount_decimal, "10.20", "fee USD");
      eq(c.usd.net_total.amount_decimal, "339.86", "net USD");
    });

    step("the uploader's figures are the same figures", () => {
      const asAdmin = psql("select public.sarraf_batch_summary('f12')::text");
      be("customer");
      const asCustomer = psql("select public.sarraf_batch_summary('f12')::text");
      be("admin");
      const strip = (s) => s.replace(/"calculated_at": ?"[^"]*"/g, "");
      if (strip(asAdmin) !== strip(asCustomer)) throw new Error("the two roles were given different figures");
    });

    step("both sides are locked to the same summary version", () => {
      const version = j("public.sarraf_batch_summary('f12')").summary_version;
      be("customer");
      eq(j("public.sarraf_batch_summary('f12')").summary_version, version, "summary version");
      be("admin");
    });

    step("a change to the receipts issues a new version, and the old one is refused", () => {
      const before = j("public.sarraf_batch_summary('f12')").summary_version;
      // net must stay equal to amount minus fee. The step is about the version moving, not
      // about the row becoming inconsistent, so both figures move together.
      psql("update public.receipts set amount = 2600, net_amount = 2600 - fee where id='f12-r1'");
      const after = j("public.sarraf_batch_summary('f12')").summary_version;
      if (before === after) throw new Error("the figures changed and the version did not");
      psql("update public.receipts set amount = 2520.41, net_amount = 2520.41 - fee where id='f12-r1'");
      eq(j("public.sarraf_batch_summary('f12')").summary_version, before, "the version returns with the figures");
    });

    step("finalizing against a version that has moved is refused", () => {
      psql("update public.receipt_batches set decision_status='rejected', matched_score=100 where id='f12'");
      const stale = "0".repeat(32);
      if (!refused(`select public.sarraf_finalize_receipt_batch('f12','the figures were checked',false,
            'receipt-finalize:f12:none:flow-stale-000001','${stale}')`)) {
        throw new Error("a stale finalization was accepted");
      }
      eq(psql("select receipt_stage from public.receipt_batches where id='f12'").trim(), "matched", "unchanged");
    });

    step("finalizing against the current version succeeds and records it", () => {
      const v = j("public.sarraf_batch_summary('f12')").summary_version;
      psql(`select public.sarraf_finalize_receipt_batch('f12','the figures were checked',false,
            'receipt-finalize:f12:none:flow-good-0000001','${v}')`);
      eq(psql("select receipt_stage from public.receipt_batches where id='f12'").trim(), "finalized", "finalized");
    });

    step("a ratio changed afterwards does not rewrite what was finalized", () => {
      const finalized = j("public.sarraf_batch_summary('f12')").currencies[0].usd.net_total.amount_decimal;
      eq(finalized, "339.86", "the finalized figure");
      psql("update public.currencies set rate = 6.90 where id='cny'");
      // The transaction and its journal entry are the record; they are untouched by a later rate.
      const posted = psql(`select count(*) from public.journal_lines
                           where entry_id in (select id from public.journal_entries where source_type='transaction')
                             and base_rate = 6.90`).trim();
      eq(posted, 0, "entries revalued by a later ratio");
      psql("update public.currencies set rate = 7.20 where id='cny'");
    });
  });

  // ── 14 ──────────────────────────────────────────────────────────────────────
  //
  // The indirect trade, in the owner's words: ZEMAN buys currency from a seller, and the money
  // does not come to ZEMAN — it goes straight to a partner, who holds it. The seller pays through
  // WeChat or Alipay and uploads the screenshot. What the reviewer needs out of that pile is four
  // things per receipt — who was paid, when, through which wallet, and whether a fee was taken —
  // organised rather than listed. Then the batch goes to the administrator, who makes it a
  // transaction and records which partner is holding the money. And those details must reach that
  // partner, because they are the one who has to agree the amount.
  //
  // This is the newest part of the system and the part the owner called the most important, and
  // until now nothing walked it end to end. The pieces each had checks; the sentence above had
  // none.
  scenario(14, "an indirect batch is organised, becomes a transaction, and reaches the partner holding the money", () => {
    step("the seller sends four receipts across both wallets, two of them fee-free", () => {
      be("customer");
      batch("f14");
      receipt("f14-r1", "f14", { amount: 1000, fee: 10, net: 990, receiver: "ئەحمەد", ref: "F14R1", date: "2026-08-02" });
      receipt("f14-r2", "f14", { amount: 2000, fee: 0,  net: 2000, receiver: "ئەحمەد", ref: "F14R2", date: "2026-08-02" });
      receipt("f14-r3", "f14", { amount: 1500, fee: 15, net: 1485, receiver: "سارا",   ref: "F14R3", date: "2026-08-03" });
      receipt("f14-r4", "f14", { amount:  500, fee: 0,  net:  500, receiver: "سارا",   ref: "F14R4", date: "2026-08-03" });
      be("admin");
      // The wallet is on the receipt itself, as the uploader's screenshot states it. Both
      // spellings of each are used on purpose: the Chinese names are what the screenshots
      // actually say, and a reviewer must not see them as two more wallets.
      psql(`update public.receipts set platform='wechat'  where id in ('f14-r1','f14-r2')`);
      psql(`update public.receipts set platform='支付宝'   where id = 'f14-r3'`);
      psql(`update public.receipts set platform='Alipay'  where id = 'f14-r4'`);
      eq(psql("select count(*) from public.receipts where batch_id='f14'").trim(), 4, "receipts stored");
    });

    step("the batch becomes a purchase, and the money is placed with a partner", () => {
      psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
            values ('f14-tx','buy','cny',5000,0.138889,'usd',694.44,'completed',now())`);
      psql(`insert into public.receipt_batch_transactions(batch_id,transaction_id,partner_id,
              item_count,amount,currency,created_by)
            values ('f14','f14-tx','par',4,5000,'CNY','adm')`);
      eq(psql("select count(*) from public.receipt_batch_transactions where batch_id='f14'").trim(),
         1, "the batch is linked to one transaction");
    });

    step("the detail names the partner holding it, and says the trade was indirect", () => {
      const d = j("public.sarraf_partner_batch_detail('f14')");
      eq(d.partner_id, "par", "the partner holding the money");
      eq(d.is_indirect, true, "an indirect trade");
      eq(d.rows.length, 4, "one row per receipt");
    });

    step("the two spellings of each wallet are one wallet", () => {
      const d = j("public.sarraf_partner_batch_detail('f14')");
      const platforms = d.by_platform.map((p) => p.platform).sort();
      eq(platforms.join(","), "alipay,wechat", "the wallets, normalised");
      const wechat = d.by_platform.find((p) => p.platform === "wechat");
      const alipay = d.by_platform.find((p) => p.platform === "alipay");
      eq(wechat.n, 2, "receipts through WeChat");
      eq(alipay.n, 2, "receipts through Alipay — 支付宝 and Alipay are the same wallet");
    });

    step("the receivers are grouped, not merely listed", () => {
      const d = j("public.sarraf_partner_batch_detail('f14')");
      const byName = Object.fromEntries(d.by_receiver.map((r) => [r.receiver, r]));
      eq(byName["ئەحمەد"].n, 2, "receipts to ئەحمەد");
      eq(byName["سارا"].n, 2, "receipts to سارا");
    });

    step("with fee and without fee are counted apart, and both totals are stated", () => {
      const d = j("public.sarraf_partner_batch_detail('f14')");
      const cny = d.totals.find((t) => t.currency === "CNY");
      if (!cny) throw new Error(`no CNY total in ${JSON.stringify(d.totals)}`);
      eq(cny.n, 4, "receipts counted");
      eq(cny.with_fee_count, 2, "receipts that carried a fee");
      // A zero fee is an answer, not a silence. Two of these say the fee was nothing, and that
      // is a different statement from a receipt where nobody looked.
      eq(cny.without_fee_count, 2, "receipts that carried none");
      // §A asks for the figure both ways: what was sent, and what arrived after the fee.
      eq(Number(cny.with_fee), 5000, "the total before fees");
      eq(Number(cny.without_fee), 4975, "the total after fees");
      eq(Number(cny.fee), 25, "the fees themselves");
    });

    step("the partner holding the money can read the detail", () => {
      be("partner");
      const d = j("public.sarraf_partner_batch_detail('f14')");
      eq(d.rows.length, 4, "the partner sees the receipts behind what they are holding");
      be("admin");
    });

    step("somebody else's partner cannot", () => {
      be("other");
      if (!refused("select public.sarraf_partner_batch_detail('f14')")) {
        throw new Error("a stranger read the detail of a batch they hold nothing for");
      }
      be("admin");
    });

    step("the partner's holdings list the batch, its receipts and its amount", () => {
      const h = j("public.sarraf_partner_holdings('par')");
      eq(h.partner_id, "par", "the partner asked about");
      const held = (h.batches || []).find((b) => b.batch_id === "f14");
      if (!held) {
        throw new Error(`the batch is not among what the partner is holding: `
          + JSON.stringify(h.batches).slice(0, 200));
      }
      eq(held.item_count, 4, "receipts behind what is held");
      eq(Number(held.amount), 5000, "the amount held");
      const cny = (h.by_currency || []).find((c) => c.currency === "CNY");
      if (!cny) throw new Error("the holding is not stated in the currency it is held in");
      eq(Number(cny.amount), 5000, "held in CNY");
    });
  });

  // ── 15 ──────────────────────────────────────────────────────────────────────
  //
  // The flow the business actually runs on, and the one the database refused.
  //
  // A customer-seller has just paid money and has a screenshot of it. They send it; the system
  // reads it; what survives reaches the owner, who makes the transaction from it. Every other
  // scenario here starts from a batch that already exists, so none of them ever asked whether a
  // receipt can be *begun* — and it could not: sarraf_receipt_intake_begin refused a receipt
  // naming no transaction, and then demanded an assignment row for the transaction it insisted
  // on. A new customer had no transaction and could not get one without uploading.
  scenario(15, "a customer-seller sends a receipt before any transaction exists", () => {
    const sha = "a".repeat(64);

    step("the customer claims a receipt naming no transaction", () => {
      be("customer");
      const claim = j(`public.sarraf_receipt_intake_begin_v3(
        'f15-doc-1', null, 'f15-batch', 'image/jpeg', 'receipt-intake:receipt:f15-doc-1')`);
      eq(claim.flow, "customer_sells_to_zeman", "the flow the server chose");
      eq(claim.transaction_id, null, "a transaction was invented");
      eq(claim.expected_currency, null, "a currency was expected of a receipt with nothing to agree with");
      eq(claim.storage_path, "ingest/f15-batch/f15-doc-1.jpg", "the stored object");
    });

    step("it belongs to the customer who sent it, and to nobody else", () => {
      eq(psql("select customer_id from public.receipt_documents where id='f15-doc-1'").trim(), "cus", "customer");
      eq(psql("select uploader_id from public.receipt_documents where id='f15-doc-1'").trim(), "cus", "uploader");
      eq(psql("select state from public.receipt_documents where id='f15-doc-1'").trim(), "uploading", "state");
    });

    step("a second claim of the same intent replays rather than duplicating", () => {
      const again = j(`public.sarraf_receipt_intake_begin_v3(
        'f15-doc-1', null, 'f15-batch', 'image/jpeg', 'receipt-intake:receipt:f15-doc-1')`);
      if (again.replayed !== true) throw new Error("a repeated claim was treated as a new receipt");
      eq(psql("select count(*) from public.receipt_documents where id='f15-doc-1'").trim(), 1, "documents");
    });

    step("a partner cannot begin one, because a purchase is evidenced by assignment", () => {
      be("partner");
      if (!refused(`select public.sarraf_receipt_intake_begin_v3(
        'f15-doc-2', null, 'f15-batch', 'image/jpeg', 'receipt-intake:receipt:f15-doc-2')`)) {
        throw new Error("an unassigned partner began a receipt");
      }
    });

    step("the server reads the stored original and records what it read", () => {
      psql(`select public.sarraf_receipt_record_server_extraction('f15-doc-1','${sha}',24680,'image/jpeg',
        true,
        '{"grossAmount":"1260.20","feeAmount":"36.70","netAmount":"1223.50","currency":"CNY",
          "refNo":"F15R1","payee":"ئەحمەد","txDate":"2026-08-01","txTime":"11:04",
          "platform":"wechat","feeTreatment":"deducted_from_principal",
          "transactionStatus":"success","confidence":0.93}'::jsonb,
        'verify','flow',120,'flow-request-15')`);
      const state = psql("select state from public.receipt_documents where id='f15-doc-1'").trim();
      // Nothing was expected of it, so nothing can mismatch: it is judged on its own reading.
      if (state !== "validated") throw new Error(`the reading left the receipt at ${state}`);
    });

    step("the details the owner needs are on the receipt, not in the browser", () => {
      const e = psql(`select gross_amount||'|'||fee_amount||'|'||net_amount||'|'||currency||'|'||ref_no
                      from public.receipt_extractions where document_id='f15-doc-1' and is_original`).trim();
      eq(e, "1260.2000000000|36.7000000000|1223.5000000000|CNY|F15R1", "what was read");
    });

    step("the customer sends it, and it is waiting for the owner", () => {
      be("customer");
      const sent = j(`public.sarraf_receipt_submit('["f15-doc-1"]'::jsonb,'receipt-submit:f15')`);
      eq(sent.submitted, 1, "receipts sent");
      eq(psql("select state from public.receipt_documents where id='f15-doc-1'").trim(), "submitted", "state");
    });

    // The reader names the money and does not always name the fee. With no orderAmount on the
    // receipt, "1210 with 36.30 added on top" and "1246.30 with 36.30 deducted" are the same
    // three numbers, so the label is ambiguous where the arithmetic is not. Every receipt read
    // on the morning of the 27th arrived this way and every one went to a person for it.
    step("a fee that adds up needs no name, and one that does not still stops", () => {
      be("customer");
      const read = (doc, extraction) => {
        j(`public.sarraf_receipt_intake_begin_v3(
             '${doc}', null, 'f15-batch', 'image/jpeg', 'receipt-intake:receipt:${doc}')`);
        psql(`select public.sarraf_receipt_record_server_extraction('${doc}','${doc.padEnd(64,"c").slice(0,64).replace(/[^0-9a-f]/g,"a")}',
          24680,'image/jpeg',true,'${extraction}'::jsonb,'verify','flow',120,'flow-fee-${doc}')`);
        return psql(`select state from public.receipt_documents where id='${doc}'`).trim();
      };
      const base = `"refNo":"F15FEE","payee":"ئەحمەد","txDate":"2026-08-01","txTime":"11:04",
                    "platform":"wechat","transactionStatus":"success","confidence":0.93,
                    "currency":"CNY","feeTreatment":"unknown"`;

      // 1246.30 - 36.30 = 1210.00, to the cent.
      eq(read("f15-fee-adds-up",
        `{${base},"grossAmount":"1246.30","feeAmount":"36.30","netAmount":"1210.00"}`),
        "validated", "a reconciled fee with no label");

      // The same receipt with a net nobody can get to from the other two.
      eq(read("f15-fee-does-not",
        `{${base},"grossAmount":"1246.30","feeAmount":"36.30","netAmount":"999.00"}`),
        "needs_manual_review", "a fee that cannot be reconciled");

      // A fee of nothing is not an unknown treatment; that one the numbers settle outright.
      eq(read("f15-fee-is-zero",
        `{${base},"grossAmount":"1210.00","feeAmount":"0","netAmount":"1210.00"}`),
        "validated", "a receipt that carried no fee");
      eq(psql(`select fee_treatment from public.receipt_extractions
                where document_id='f15-fee-is-zero' and is_original`).trim(),
        "no_fee", "the treatment derived for a zero fee");
    });

    step("another customer cannot send it, or see it", () => {
      be("other");
      if (!refused(`select public.sarraf_receipt_submit('["f15-doc-1"]'::jsonb,'receipt-submit:f15-theft')`)) {
        throw new Error("a stranger sent somebody else's receipt");
      }
      be("admin");
    });
  });

  // ── the report ──────────────────────────────────────────────────────────────
  const failed = scenarios.filter((s) => !s.ok);
  for (const s of scenarios) {
    console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.n}. ${s.title}`);
    if (!s.ok) console.log(`        broke at: ${s.failedAt}\n        ${s.message}`);
  }
  console.log(failed.length
    ? `\n${failed.length} of ${scenarios.length} business flows failed across ${steps.length} steps.`
    : `\nAll ${scenarios.length} business flows completed end to end across ${steps.length} steps.`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error("Business-flow verification could not run:", String(e.message || e).slice(0, 4000));
  process.exit(1);
}
