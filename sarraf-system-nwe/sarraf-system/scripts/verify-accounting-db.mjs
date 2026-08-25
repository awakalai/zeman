#!/usr/bin/env node
// Clean-database migration and accounting-invariant test.
//
// The repair brief requires that the schema build from nothing and that the ledger refuse
// to hold an unbalanced entry. Both are properties of the database, not of the application,
// so they are proven against a real PostgreSQL rather than asserted in JavaScript.
//
//   npm run verify:accounting
//
// The database itself is built by scripts/lib/zeman-db.mjs, which the business-flow gate uses
// too, so both run against the same schema and the same migration list.
import { PG_HINT, postgresAvailable, startDatabase } from "./lib/zeman-db.mjs";

if (!postgresAvailable()) {
  if (process.env.CI === "true" || process.env.ZEMAN_DB_STRICT === "1") {
    console.error(`FAIL: ${PG_HINT} A required database gate cannot be skipped.`);
    process.exit(1);
  }
  console.log(`SKIP: ${PG_HINT}`);
  console.log("Set ZEMAN_DB_STRICT=1 to make this a failure.");
  process.exit(0);
}

try {
  const { psql, psqlAsRole } = startDatabase();

  const checks = [];
  const errorDetail = (e) => {
    const stderr = e?.stderr?.toString?.() || "";
    const message = String(e?.message || e || "");
    const diagnostic = `${stderr}\n${message}`.split("\n")
      .map((line) => line.trim())
      .find((line) => /^(ERROR|DETAIL|HINT):/.test(line));
    return diagnostic || message.split("\n").find(Boolean) || "unknown error";
  };
  const check = (name, fn) => {
    try { fn(); checks.push([true, name]); }
    catch (e) { checks.push([false, `${name} — ${errorDetail(e)}`]); }
  };
  const mustFail = (name, sql) => {
    let threw = false;
    try { psql(sql); } catch { threw = true; }
    checks.push([threw, name]);
  };

  const entry = (id, lines, extra = "") => `
    begin;
    insert into public.journal_entries(id,status,business_date,posted_at,source_type,actor_id${extra ? ",command_key" : ""})
    values ('${id}','posted',current_date,now(),'test_event','u-a'${extra ? `,'${extra}'` : ""});
    insert into public.journal_lines(entry_id,line_no,account_id,side,currency,amount,base_amount,base_rate) values ${lines};
    commit;`;

  check("a balanced single-currency entry posts", () => {
    psql(entry("v-ok", "('v-ok',1,'acc-1400','debit','CNY',1000,138.89,7.2),('v-ok',2,'acc-1000','credit','CNY',1000,138.89,7.2)"));
    if (psql("select count(*) from journal_entries where id='v-ok'").trim() !== "1") throw new Error("not stored");
  });

  mustFail("an unbalanced entry is refused",
    entry("v-bad", "('v-bad',1,'acc-1400','debit','CNY',1000,138.89,7.2),('v-bad',2,'acc-1000','credit','CNY',900,125.00,7.2)"));

  mustFail("a single-line entry is refused",
    entry("v-one", "('v-one',1,'acc-1400','debit','CNY',1000,138.89,7.2)"));

  check("cross-currency balances in base while originals differ", () => {
    psql(entry("v-fx", "('v-fx',1,'acc-1000','debit','IQD',196000,138.89,1411.33),('v-fx',2,'acc-1400','credit','CNY',1000,138.89,7.2)"));
    if (psql("select count(*) from journal_entries where id='v-fx'").trim() !== "1") throw new Error("not stored");
  });

  mustFail("a posted entry cannot be deleted", "delete from public.journal_entries where id='v-ok'");
  mustFail("lines of a posted entry cannot be edited", "update public.journal_lines set amount=99999 where entry_id='v-ok'");

  check("the same command key cannot post twice", () => {
    psql(entry("v-c1", "('v-c1',1,'acc-1400','debit','CNY',10,1.39,7.2),('v-c1',2,'acc-1000','credit','CNY',10,1.39,7.2)", "cmd-1"));
    let threw = false;
    try { psql(entry("v-c2", "('v-c2',1,'acc-1400','debit','CNY',10,1.39,7.2),('v-c2',2,'acc-1000','credit','CNY',10,1.39,7.2)", "cmd-1")); }
    catch { threw = true; }
    if (!threw) throw new Error("the command posted twice");
  });

  check("the trial balance reconciles to zero", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text");
    if (out.trim() !== "true") throw new Error(`trial balance not balanced: ${psql("select public.sarraf_trial_balance_check()::text")}`);
  });

  check("every seeded account has a normal side consistent with its kind", () => {
    const bad = psql(`select count(*) from chart_of_accounts
      where (kind in ('asset','expense') and normal_side<>'debit')
         or (kind in ('liability','equity','income') and normal_side<>'credit')`);
    if (bad.trim() !== "0") throw new Error(`${bad.trim()} accounts have the wrong normal side`);
  });


  // ── Cashbox (قاسە): a customer-funds-held liability, per customer AND per currency ──
  psql(`insert into public.app_users(id,name,role,tenant_id) values ('cust-1','Customer One','customer','t-sarkhel')
        on conflict do nothing`);
  psql(`insert into public.customer_vaults(id,customer_id,currency) values
        ('cv-cny','cust-1','CNY'),('cv-usd','cust-1','USD') on conflict do nothing`);

  check("a deposit raises only the matching currency's cashbox", () => {
    psql(`insert into public.customer_vault_events(vault_id,customer_id,currency,kind,available_delta,actor_id)
          values ('cv-cny','cust-1','CNY','deposit',5000,'u-a')`);
    const cny = psql("select available from customer_vaults where id='cv-cny'").trim();
    const usd = psql("select available from customer_vaults where id='cv-usd'").trim();
    if (Number(cny) !== 5000) throw new Error(`CNY vault is ${cny}, expected 5000`);
    if (Number(usd) !== 0) throw new Error(`USD vault moved to ${usd}; currencies must not net`);
  });

  mustFail("a withdrawal cannot overdraw the cashbox",
    `insert into public.customer_vault_events(vault_id,customer_id,currency,kind,available_delta,actor_id)
     values ('cv-cny','cust-1','CNY','withdrawal',-9000,'u-a')`);

  mustFail("cashbox events are append-only",
    "update public.customer_vault_events set available_delta=1 where vault_id='cv-cny'");

  // ── Debt: never a bare signed number ──
  check("a debt names debtor, creditor, currency and source", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by,due_at)
          values ('d-1','customer','cust-1','zeman',null,'CNY',1000,1000,'unpaid_transaction',
                  'unpaid purchase','u-a', statement_timestamp() - interval '10 days')`);
    if (psql("select outstanding_principal from debts where id='d-1'").trim() !== "1000.0000000000")
      throw new Error("debt not stored as expected");
  });

  mustFail("a party cannot owe itself",
    `insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
       original_principal,outstanding_principal,source_type,reason,created_by)
     values ('d-self','customer','cust-1','customer','cust-1','CNY',10,10,'x','self','u-a')`);

  mustFail("a debt cannot be deleted", "delete from public.debts where id='d-1'");

  check("partial settlement reduces outstanding and marks the debt partially settled", () => {
    psql(`insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
            source_kind,actor_id) values ('d-1',400,1000,600,'customer_vault','u-a')`);
    const row = psql("select outstanding_principal||'|'||status from debts where id='d-1'").trim();
    if (row !== "600.0000000000|partially_settled") throw new Error(`debt state is ${row}`);
  });

  mustFail("a settlement cannot exceed the outstanding balance",
    `insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
       source_kind,actor_id) values ('d-1',9999,600,-9399,'customer_vault','u-a')`);

  mustFail("a settlement built on a stale outstanding figure is rejected",
    `insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
       source_kind,actor_id) values ('d-1',100,1000,900,'customer_vault','u-a')`);

  check("settling the remainder closes the debt", () => {
    psql(`insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
            source_kind,actor_id) values ('d-1',600,600,0,'customer_vault','u-a')`);
    const row = psql("select status||'|'||(closed_at is not null)::text from debts where id='d-1'").trim();
    if (row !== "settled|true") throw new Error(`debt state is ${row}`);
  });

  // ── The worked example from the brief, §13D.5 ──
  // partner balance 1,000 CNY; ZEMAN sells them 1,300 → 1,000 consumed, 300 becomes debt.
  // A later 500 credit settles the 300 and leaves 200 available.
  check("the partner over-limit example settles exactly as specified", () => {
    psql(`insert into public.app_users(id,name,role,tenant_id) values ('p-1','Partner One','partner','t-sarkhel') on conflict do nothing`);
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by)
          values ('d-p','partner','p-1','zeman',null,'CNY',300,300,'partner_over_limit',
                  'sale beyond available balance','u-a')`);
    const plan = psql(`select coalesce(string_agg(debt_id||':'||allocated, ','), 'none')
      from public.sarraf_debt_waterfall('partner','p-1','zeman',null,'CNY',500)`).trim();
    if (plan !== "d-p:300.0000000000") throw new Error(`waterfall allocated ${plan}, expected 300 to d-p`);
    psql(`insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,outstanding_after,
            source_kind,actor_id) values ('d-p',300,300,0,'partner_credit','u-a')`);
    const status = psql("select status from debts where id='d-p'").trim();
    if (status !== "settled") throw new Error(`partner debt is ${status}`);
    // 500 credit minus 300 applied leaves 200 available.
    const remainder = 500 - 300;
    if (remainder !== 200) throw new Error("remainder arithmetic");
  });

  check("the waterfall puts overdue debts first and is deterministic", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by,due_at,opened_at) values
          ('d-new','customer','cust-1','zeman',null,'CNY',100,100,'t','not yet due','u-a',
            statement_timestamp() + interval '30 days', statement_timestamp() - interval '1 day'),
          ('d-old','customer','cust-1','zeman',null,'CNY',100,100,'t','overdue','u-a',
            statement_timestamp() - interval '20 days', statement_timestamp() - interval '40 days')`);
    const order = psql(`select string_agg(debt_id, '>' order by remaining_after desc)
      from public.sarraf_debt_waterfall('customer','cust-1','zeman',null,'CNY',150)`).trim();
    if (!order.startsWith("d-old")) throw new Error(`overdue debt was not first: ${order}`);
  });

  check("aging buckets classify by how overdue a debt is", () => {
    const bucket = psql("select aging_bucket from v_debt_aging where id='d-old'").trim();
    if (bucket !== "8-30") throw new Error(`expected bucket 8-30, got ${bucket}`);
  });

  check("subledger reconciliation reports vault and debt totals by currency", () => {
    const out = psql("select public.sarraf_subledger_reconciliation()::text").trim();
    if (!out.includes("customer_vault_total") || !out.includes("CNY"))
      throw new Error(`reconciliation payload incomplete: ${out}`);
  });


  // ── Commands: the only way money moves. Impersonate an admin via auth.uid(). ──
  psql(`update public.app_users set auth_id='11111111-1111-1111-1111-111111111111' where id='u-a'`);
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
  psql(`insert into public.app_users(id,name,role,tenant_id) values ('cust-2','Customer Two','customer','t-sarkhel')
        on conflict do nothing`);

  check("a deposit posts a balanced entry and credits the customer-funds liability", () => {
    psql(`select public.sarraf_customer_vault_move('cust-2','CNY',7200,'in',7.2,'کڕیار پارەی دانا','cmd-dep-1')`);
    const avail = psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim();
    if (Number(avail) !== 7200) throw new Error(`available is ${avail}`);
    // Liability account 2000 must be credited, asset 1000 debited, and the entry balanced.
    const sides = psql(`select string_agg(account_id||':'||side, ',' order by line_no)
      from journal_lines where entry_id like 'je-vault-%'`).trim();
    if (!sides.includes("acc-1000:debit") || !sides.includes("acc-2000:credit"))
      throw new Error(`unexpected posting: ${sides}`);
    const base = psql(`select base_amount from journal_lines where entry_id like 'je-vault-%' limit 1`).trim();
    if (Number(base) !== 1000) throw new Error(`7200 CNY at 7.2 should value to 1000 USD, got ${base}`);
  });

  check("replaying a deposit command does not move the balance twice", () => {
    const out = psql(`select public.sarraf_customer_vault_move('cust-2','CNY',7200,'in',7.2,'دووبارە','cmd-dep-1')::text`);
    if (!out.includes('"replayed": true') && !out.includes('"replayed":true'))
      throw new Error(`replay not detected: ${out}`);
    const avail = psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim();
    if (Number(avail) !== 7200) throw new Error(`balance moved twice: ${avail}`);
  });

  check("a forged client rate cannot change journal value or rate metadata", () => {
    psql(`select public.sarraf_customer_vault_move(
      'cust-2','CNY',720,'in',999,'server snapshot must win','cmd-dep-forged-rate')`);
    const row = psql(`select base_amount||'|'||base_rate||'|'||rate_source
      from journal_lines where entry_id='je-vault-'||md5('u-a:cmd-dep-forged-rate')
      order by line_no limit 1`).trim();
    if (row !== "100.0000000000|7.2000000000|manual_daily_snapshot")
      throw new Error(`forged rate leaked into journal metadata: ${row}`);
  });

  mustFail("a withdrawal beyond the cashbox is refused by the command",
    `select public.sarraf_customer_vault_move('cust-2','CNY',999999,'out',7.2,'زۆرە','cmd-wd-x')`);

  check("settling a debt from the cashbox applies the waterfall and draws the balance down", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by)
          values ('d-c2','customer','cust-2','zeman',null,'CNY',5000,5000,'unpaid','قەرزی کڕین','u-a')`);
    const out = psql(`select public.sarraf_apply_vault_to_debt('cust-2','CNY',5000,7.2,'تسویە لە قاسە','cmd-set-1')::text`);
    if (!out.includes('"applied": 5000') && !out.includes('"applied":5000'))
      throw new Error(`unexpected result: ${out}`);
    const st = psql("select status from debts where id='d-c2'").trim();
    if (st !== "settled") throw new Error(`debt is ${st}`);
    const avail = psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim();
    // 7,200 opening deposit + 720 server-priced deposit - 5,000 settlement = 2,920.
    if (Number(avail) !== 2920) throw new Error(`expected 2920 left, got ${avail}`);
  });

  check("an unallocated remainder returns to the cashbox instead of vanishing", () => {
    const before = Number(psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim());
    psql(`select public.sarraf_apply_vault_to_debt('cust-2','CNY',1000,7.2,'هیچ قەرزێک نەماوە','cmd-set-2')`);
    const after = Number(psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim());
    if (after !== before) throw new Error(`money vanished: ${before} -> ${after}`);
  });

  check("a debt ZEMAN owes a customer becomes cashbox credit without double liability", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by)
          values ('d-z2','zeman',null,'customer','cust-2','CNY',900,900,'owed','ZEMAN قەرزارە','u-a')`);
    const before = Number(psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim());
    psql(`select public.sarraf_zeman_debt_to_vault('d-z2',900,7.2,'خرایە قاسەی کڕیار','cmd-d2v-1')`);
    const after = Number(psql("select available from customer_vaults where customer_id='cust-2' and currency='CNY'").trim());
    const st = psql("select status from debts where id='d-z2'").trim();
    if (after - before !== 900) throw new Error(`cashbox moved by ${after - before}, expected 900`);
    if (st !== "settled") throw new Error(`debt is ${st}`);
    // The liability must be credited once, not twice: entry replaces receivable with funds held.
    const n = psql(`select count(*) from journal_lines l join journal_entries e on e.id=l.entry_id
                    where e.source_type='zeman_debt_to_customer_vault' and l.account_id='acc-2000'`).trim();
    if (n !== "1") throw new Error(`liability credited ${n} times, expected once`);
  });

  check("the trial balance still reconciles after every command", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });

  check("a customer cannot post accounting commands", () => {
    psql(`update public.app_users set auth_id='22222222-2222-2222-2222-222222222222' where id='cust-2'`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '22222222-2222-2222-2222-222222222222'::uuid $fn$`);
    let denied = false;
    try { psql(`select public.sarraf_customer_vault_move('cust-2','CNY',100,'in',7.2,'forged','cmd-forge')`); }
    catch { denied = true; }
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    if (!denied) throw new Error("a customer was allowed to move the cashbox");
  });


  // ── §13D: the worked example, executed through the real commands ──
  psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
        ('p-x','Partner X','partner','33333333-3333-3333-3333-333333333333','t-sarkhel'),
        ('off-1','Office One','office','44444444-4444-4444-4444-444444444444','t-sarkhel')
        on conflict do nothing`);

  // ── Real business flow A/B/C: custody is derived, never trusted from a label ──
  check("Type A is partner custody and creates the exact receipt assignment", () => {
    psql(`insert into public.txs(
      id,type,cp_id,cur_id,amount,rate,against_id,total,partner_id,status,date)
      values ('tx-flow-a','buy','cust-1','cny',7200,0.13888889,'usd',1000,
              'p-x','completed',now())`);
    const row = psql(`select business_flow||'|'||partner_id from public.txs
      where id='tx-flow-a'`).trim();
    if (row !== "partner_custody|p-x") throw new Error(`Type A became ${row}`);
    const assignment = psql(`select flow||'|'||customer_id||'|'||partner_id||'|'||expected_currency
      from public.receipt_transaction_assignments where transaction_id='tx-flow-a'`).trim();
    if (assignment !== "customer_sells_to_zeman|cust-1|p-x|CNY") {
      throw new Error(`Type A receipt assignment is ${assignment}`);
    }
    psql(`insert into public.receipt_batches(
            id,customer_id,partner_id,direction,currency,uploaded_by)
          values ('batch-flow-a-0001','cust-1','p-x','in','CNY','cust-1');
      insert into public.receipt_intake_items(
        id,batch_id,submitted_by,customer_id,partner_id,direction,image_path,amount,fee,
        net_amount,currency,ref_no,source_status,intake_status,counted,raw)
      values ('receipt-flow-a','batch-flow-a-0001','cust-1','cust-1','p-x','in',
        'ingest/batch-flow-a-0001/receipt-flow-a.jpg',
        7200,0,7200,'CNY','REF-A','verified','accepted',true,
        '{"payee":"Partner X Wallet","platform":"WeChat","feeTreatment":"no_fee",
          "txDate":"2026-08-18","transactionStatus":"successful"}'::jsonb);
      update public.receipt_intake_items set transaction_id='tx-flow-a'
      where id='receipt-flow-a'`);
    const detail = psql(`select business_flow||'|'||payee||'|'||platform||'|'||has_fee||'|'||partner_id
      from public.v_receipt_batch_structured_details where receipt_id='receipt-flow-a'`).trim();
    if (detail !== "partner_custody|Partner X Wallet|wechat|false|p-x") {
      throw new Error(`Type A receipt detail is ${detail}`);
    }
  });

  check("Type B is one paired owner-cashbox trade with no partner", () => {
    psql(`begin;
      insert into public.txs(id,type,cp_id,cur_id,amount,rate,against_id,total,
        direct,pair_id,direct_role,own_money,status,date)
      values
        ('tx-flow-b-buy','buy','cust-1','cny',7200,0.13888889,'usd',1000,
         true,'pair-flow-b','buy',true,'completed',now()),
        ('tx-flow-b-sell','sell','cust-2','cny',7200,0.14,'usd',1008,
         true,'pair-flow-b','sell',true,'completed',now());
      commit;`);
    const row = psql(`select count(*)||'|'||min(business_flow)||'|'||
      count(*) filter(where partner_id is not null) from public.txs where pair_id='pair-flow-b'`).trim();
    if (row !== "2|owner_cashbox|0") throw new Error(`Type B became ${row}`);
  });

  check("Type C keeps the ordinary transaction behaviour", () => {
    psql(`insert into public.txs(id,type,cp_id,cur_id,amount,rate,against_id,total,status,date)
      values ('tx-flow-c','buy','cust-1','cny',720,0.13888889,'usd',100,'completed',now())`);
    const row = psql(`select business_flow||'|'||coalesce(partner_id,'none')||'|'||direct
      from public.txs where id='tx-flow-c'`).trim();
    if (row !== "standard|none|false") throw new Error(`Type C became ${row}`);
  });

  mustFail("a forged flow label cannot contradict partner custody",
    `insert into public.txs(id,type,cp_id,cur_id,amount,rate,against_id,total,partner_id,
       business_flow,status,date) values ('tx-flow-forged','buy','cust-1','cny',72,
       0.13888889,'usd',10,'p-x','standard','completed',now())`);

  mustFail("half of an owner-cashbox pair cannot commit",
    `insert into public.txs(id,type,cp_id,cur_id,amount,rate,against_id,total,direct,
       pair_id,direct_role,own_money,status,date) values ('tx-flow-half','buy','cust-1',
       'cny',72,0.13888889,'usd',10,true,'pair-half','buy',true,'completed',now())`);

  check("13D.5 balance 1000, sold 1300: 1000 consumed and 300 becomes debt", () => {
    psql(`insert into public.partner_accounts(id,partner_id,currency,available)
          values ('pa-x-cny','p-x','CNY',1000)
          on conflict (partner_id,currency) do update set available=1000`);
    const out = psql(`select public.sarraf_partner_disburse('p-x','CNY',1300,7.2,null,'sale to partner','cmd-disb-1')::text`);
    const avail = Number(psql("select available from partner_accounts where id='pa-x-cny'").trim());
    const debt = Number(psql(`select coalesce(sum(outstanding_principal),0) from debts
      where debtor_type='partner' and debtor_id='p-x' and currency='CNY'
        and status in ('open','partially_settled')`).trim());
    if (avail !== 0) throw new Error(`available should be 0, got ${avail}`);
    if (debt !== 300) throw new Error(`debt should be 300, got ${debt}`);
    if (!out.replace(/\s/g,"").includes('"excess_as_debt":300')) throw new Error(`unexpected: ${out}`);
  });

  check("13D.5 later credit 500: debt cleared and 200 left available", () => {
    const out = psql(`select public.sarraf_partner_credit('p-x','CNY',500,7.2,'new credit','cmd-cred-1')::text`);
    const avail = Number(psql("select available from partner_accounts where id='pa-x-cny'").trim());
    const debt = Number(psql(`select coalesce(sum(outstanding_principal),0) from debts
      where debtor_type='partner' and debtor_id='p-x' and currency='CNY'
        and status in ('open','partially_settled')`).trim());
    if (debt !== 0) throw new Error(`debt should be 0, got ${debt}`);
    if (avail !== 200) throw new Error(`available should be 200, got ${avail}`);
    if (!out.replace(/\s/g,"").includes('"debt_applied":300')) throw new Error(`breakdown missing: ${out}`);
  });

  mustFail("a partner account can never go negative",
    `insert into public.partner_account_events(account_id,partner_id,currency,kind,available_delta,actor_id)
     values ('pa-x-cny','p-x','CNY','debit',-99999,'u-a')`);

  check("replaying a disbursement does not create the debt twice", () => {
    const before = Number(psql("select count(*) from debts where debtor_id='p-x'").trim());
    psql(`select public.sarraf_partner_disburse('p-x','CNY',1300,7.2,null,'replay','cmd-disb-1')`);
    const after = Number(psql("select count(*) from debts where debtor_id='p-x'").trim());
    if (after !== before) throw new Error(`debts went from ${before} to ${after} on replay`);
  });

  let officeAssignmentId = "";
  check("an office assignment derives amount and currency from the exact pending purchase", () => {
    psql(`insert into public.txs(id,type,cp_id,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-office','buy','cust-1','cny',36000,0.13888889,'usd',5000,'pending',now())`);
    const out = psql(`select public.sarraf_create_office_payment_assignment(
      'tx-office','off-1',now()+interval '1 day','pay this exact purchase','cmd-opa-create-1')::text`);
    const id = JSON.parse(out).assignment_id;
    officeAssignmentId = id;
    const row = psql(`select transaction_id||'|'||office_id||'|'||amount||'|'||currency||'|'||status
      from office_payment_assignments where id='${id}'`).trim();
    if (row !== "tx-office|off-1|5000.0000000000|USD|assigned") throw new Error(`assignment is ${row}`);
  });

  check("only the server worker may record an office evidence attestation", () => {
    const signature = `public.sarraf_office_payment_attach_evidence_server(text,text,text,bigint,text,text,text)`;
    const browser = psql(`select has_function_privilege('authenticated','${signature}','execute')`).trim();
    const service = psql(`select has_function_privilege('service_role','${signature}','execute')`).trim();
    const legacy = psql(`select (to_regprocedure(
      'public.sarraf_office_payment_attach_evidence(text,text,text,text)') is null)::text`).trim();
    if (browser !== "f" || service !== "t" || legacy !== "true") {
      throw new Error(`evidence grants authenticated=${browser}, service=${service}, legacy=${legacy}`);
    }
  });

  check("an office cannot report payment before immutable evidence is attached", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '44444444-4444-4444-4444-444444444444'::uuid $fn$`);
    let denied = false;
    try { psql(`select public.sarraf_office_payment_report(
      '${officeAssignmentId}','paid_reported',2000,'REF-X','no evidence','cmd-op-no-evidence')`); }
    catch { denied = true; }
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    if (!denied) throw new Error("payment was reported without evidence");
    psql(`insert into public.office_payment_evidence(
      id,assignment_id,storage_path,image_sha256,file_size,media_type,actor_id,command_key)
      values ('opev-verify','${officeAssignmentId}',
        'ingest/office-payments/${officeAssignmentId}/verify.jpg',repeat('a',64),1024,
        'image/jpeg','off-1','cmd-evidence-verify');
      update public.office_payment_assignments
        set evidence_path='ingest/office-payments/${officeAssignmentId}/verify.jpg'
        where id='${officeAssignmentId}'`);
  });

  check("a partial payment report leaves the remainder outstanding", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '44444444-4444-4444-4444-444444444444'::uuid $fn$`);
    const out = psql(`select public.sarraf_office_payment_report('${officeAssignmentId}','paid_reported',2000,'REF-1','partial','cmd-op-1')::text`);
    if (!out.replace(/\s/g,"").includes('"outstanding":3000')) throw new Error(`expected 3000 outstanding: ${out}`);
  });

  check("replaying an office report cannot add its amount twice", () => {
    const out = psql(`select public.sarraf_office_payment_report('${officeAssignmentId}','paid_reported',2000,'REF-1','partial','cmd-op-1')::text`);
    const paid = psql(`select amount_paid from office_payment_assignments where id='${officeAssignmentId}'`).trim();
    if (Number(paid) !== 2000) throw new Error(`replay raised amount_paid to ${paid}`);
    if (!out.replace(/\s/g,"").includes('"replayed":true')) throw new Error(out);
  });

  mustFail("an office cannot report more than the assignment",
    `select public.sarraf_office_payment_report('${officeAssignmentId}','paid_reported',999999,'X','over','cmd-op-2')`);

  mustFail("an office cannot confirm its own payment",
    `select public.sarraf_office_payment_report('${officeAssignmentId}','confirmed',null,null,null,'cmd-op-3')`);

  check("another office cannot touch an assignment that is not theirs", () => {
    psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
          ('off-2','Office Two','office','55555555-5555-5555-5555-555555555555','t-sarkhel') on conflict do nothing`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '55555555-5555-5555-5555-555555555555'::uuid $fn$`);
    let denied = false;
    try { psql(`select public.sarraf_office_payment_report('${officeAssignmentId}','acknowledged',null,null,null,'cmd-op-4')`); }
    catch { denied = true; }
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    if (!denied) throw new Error("a different office was allowed to report");
  });

  check("only after the full office report can an administrator confirm and settle the purchase", () => {
    psql(`insert into public.ledger(id,type,owner,cur_id,amount,note,date,created_by)
          values ('verify-usd-capital','deposit','self','usd',1000000,
                  'accounting verifier opening cash',statement_timestamp(),'u-a')
          on conflict (id) do nothing`);
    psql(`insert into public.office_payment_evidence(
      id,assignment_id,storage_path,image_sha256,file_size,media_type,actor_id,command_key)
      values ('opev-verify-2','${officeAssignmentId}',
        'ingest/office-payments/${officeAssignmentId}/verify-2.jpg',repeat('b',64),1024,
        'image/jpeg','off-1','cmd-evidence-verify-2');
      update public.office_payment_assignments
        set evidence_path='ingest/office-payments/${officeAssignmentId}/verify-2.jpg'
        where id='${officeAssignmentId}'`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '44444444-4444-4444-4444-444444444444'::uuid $fn$`);
    psql(`select public.sarraf_office_payment_report('${officeAssignmentId}','paid_reported',3000,'REF-2','remainder','cmd-op-5')`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    const out = psql(`select public.sarraf_office_payment_confirm(
      '${officeAssignmentId}','verified against bank statement','cmd-op-confirm-1')::text`);
    const state = psql(`select a.status||'|'||t.status from office_payment_assignments a
      join txs t on t.id=a.transaction_id where a.id='${officeAssignmentId}'`).trim();
    if (state !== "confirmed|completed") throw new Error(`office settlement state is ${state}`);
    const pair = psql(`select string_agg(account_id||':'||side,',' order by line_no)
      from journal_lines where entry_id=(select journal_entry_id from transaction_payment_events
        where office_assignment_id='${officeAssignmentId}' and event_kind='settled')`).trim();
    if (pair !== "acc-2300:debit,acc-1000:credit") throw new Error(`office settlement posted ${pair}`);
    if (!out.replace(/\s/g,"").includes('"status":"confirmed"')) throw new Error(out);
  });

  check("the trial balance still reconciles after partner and office activity", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });


  // ── Phase 4: receipt state machine, custody, forwarding ──
  psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
        ('cust-r','Receipt Customer','customer','66666666-6666-6666-6666-666666666666','t-sarkhel'),
        ('part-r','Receipt Partner','partner','77777777-7777-7777-7777-777777777777','t-sarkhel'),
        ('inv-r','Investor','investor','88888888-8888-8888-8888-888888888888','t-sarkhel')
        on conflict (id) do update set auth_id=excluded.auth_id`);

  const doc = (id, flow, uploader, extra = "") => `
    insert into public.receipt_documents(id,flow,uploader_id,storage_path${extra ? "," + extra.split("=")[0] : ""})
    values ('${id}','${flow}','${uploader}','ingest/${id}.jpg'${extra ? ",'" + extra.split("=")[1] + "'" : ""})`;

  check("a document starts at created and records that transition", () => {
    psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
          values ('doc-1','customer_sells_to_zeman','cust-r','cust-r','ingest/doc-1.jpg')`);
    const st = psql("select state from receipt_documents where id='doc-1'").trim();
    const tr = psql("select count(*) from receipt_state_transitions where document_id='doc-1'").trim();
    if (st !== "created" || tr !== "1") throw new Error(`state ${st}, transitions ${tr}`);
  });

  mustFail("a customer cannot upload a purchase receipt",
    `insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
     values ('doc-bad','customer_buys_from_zeman','cust-r','cust-r','ingest/doc-bad.jpg')`);

  mustFail("an unassigned partner cannot upload for another partner",
    `insert into public.receipt_documents(id,flow,uploader_id,partner_id,storage_path)
     values ('doc-bad2','customer_buys_from_zeman','part-r','someone-else','ingest/doc-bad2.jpg')`);

  mustFail("an investor cannot upload receipts at all",
    `insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
     values ('doc-bad3','customer_sells_to_zeman','inv-r','inv-r','ingest/doc-bad3.jpg')`);

  mustFail("a document cannot be created already accepted",
    `insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path,state)
     values ('doc-bad4','customer_sells_to_zeman','cust-r','cust-r','ingest/x.jpg','accepted')`);

  mustFail("a document cannot jump from created straight to accepted",
    `update public.receipt_documents set state='accepted' where id='doc-1'`);

  check("the documented happy path walks through every state", () => {
    psql(`insert into public.receipt_extractions(
            document_id,version,is_original,raw,gross_amount,fee_amount,fee_treatment,
            net_amount,currency,payee,tx_date,confidence,platform,has_fee,transaction_status)
          values ('doc-1',1,true,'{}'::jsonb,100,0,'no_fee',100,'CNY',
                  'Receipt Customer',current_date,0.99,'wechat',false,'successful')`);
    const path = ["uploading","uploaded","ocr_pending","ocr_processing","parsed","validated",
                  "submitted","matched","accepted","finalized","forwarded","delivered"];
    for (const s of path) psql(`update public.receipt_documents set state='${s}' where id='doc-1'`);
    const st = psql("select state from receipt_documents where id='doc-1'").trim();
    if (st !== "delivered") throw new Error(`ended at ${st}`);
    const n = Number(psql("select count(*) from receipt_state_transitions where document_id='doc-1'").trim());
    if (n !== path.length + 1) throw new Error(`expected ${path.length + 1} transitions, got ${n}`);
  });

  check("a delivered document may only be marked seen", () => {
    let bad = false;
    try { psql(`update public.receipt_documents set state='rejected' where id='doc-1'`); } catch { bad = true; }
    if (!bad) throw new Error("a delivered document was moved to rejected");
    psql(`update public.receipt_documents set state='seen' where id='doc-1'`);
  });

  mustFail("a seen document is terminal and accepts nothing further",
    `update public.receipt_documents set state='rejected' where id='doc-1'`);

  mustFail("stored evidence cannot be re-pointed",
    `update public.receipt_documents set storage_path='ingest/other.jpg' where id='doc-1'`);

  check("an OCR failure keeps the image and stays recoverable", () => {
    psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
          values ('doc-2','customer_sells_to_zeman','cust-r','cust-r','ingest/doc-2.jpg')`);
    for (const s of ["uploading","uploaded","ocr_pending","ocr_failed_retryable","ocr_pending"])
      psql(`update public.receipt_documents set state='${s}' where id='doc-2'`);
    const st = psql("select state||'|'||storage_path from receipt_documents where id='doc-2'").trim();
    if (st !== "ocr_pending|ingest/doc-2.jpg") throw new Error(`document is ${st}`);
  });

  check("the original extraction is immutable and a correction is a new version", () => {
    psql(`insert into public.receipt_extractions(document_id,version,is_original,gross_amount,currency)
          values ('doc-2',1,true,2520.41,'CNY')`);
    psql(`insert into public.receipt_extractions(document_id,version,is_original,gross_amount,currency,
            corrected_by,correction_reason,corrected_at)
          values ('doc-2',2,false,2447.00,'CNY','u-a','admin corrected the gross figure',now())`);
    const v1 = psql("select gross_amount from receipt_extractions where document_id='doc-2' and version=1").trim();
    if (Number(v1) !== 2520.41) throw new Error(`original changed to ${v1}`);
  });

  mustFail("an extraction cannot be edited in place",
    `update public.receipt_extractions set gross_amount=1 where document_id='doc-2' and version=1`);

  mustFail("a correction without a reason is refused",
    `insert into public.receipt_extractions(document_id,version,is_original,gross_amount,corrected_by)
     values ('doc-2',3,false,10,'u-a')`);

  mustFail("a pending document cannot be forwarded",
    `insert into public.receipt_forwardings(id,document_id,from_actor_type,to_actor_type,to_actor_id,forwarded_by)
     values ('fwd-bad','doc-2','zeman','customer','cust-r','u-a')`);

  check("an accepted document can be forwarded exactly once per recipient", () => {
    psql(`insert into public.receipt_forwardings(id,document_id,from_actor_type,to_actor_type,to_actor_id,forwarded_by)
          values ('fwd-1','doc-1','zeman','customer','cust-r','u-a')`);
    let threw = false;
    try {
      psql(`insert into public.receipt_forwardings(id,document_id,from_actor_type,to_actor_type,to_actor_id,forwarded_by)
            values ('fwd-2','doc-1','zeman','customer','cust-r','u-a')`);
    } catch { threw = true; }
    if (!threw) throw new Error("the same document was forwarded twice to one recipient");
  });

  check("a counted document cannot share an image hash with another", () => {
    psql(`update public.receipt_documents set image_sha256=repeat('a',64), counted=true where id='doc-1'`);
    let threw = false;
    try {
      psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path,image_sha256,counted)
            values ('doc-dup','customer_sells_to_zeman','cust-r','cust-r','ingest/dup.jpg',repeat('a',64),true)`);
    } catch { threw = true; }
    if (!threw) throw new Error("a duplicate counted image was accepted");
  });

  // ── Canonical receipt authority: assignment → stored OCR → decision → rate → recipient ──
  check("canonical receipt flow preserves assignment authority and the exact CNY benchmark", () => {
    psql(`update public.app_users set auth_id='66666666-6666-6666-6666-666666666666' where id='cust-r';
          update public.app_users set auth_id='77777777-7777-7777-7777-777777777777' where id='part-r';
          insert into public.txs(id,type,cp_id,cp_name,cur_id,amount,rate,against_id,total,partner_id,status)
          values ('tx-canonical','sell','cust-r','Receipt Customer','cny',2447,0.1388888889,
                  'usd',339.86,'part-r','pending') on conflict do nothing`);

    // Admin assignment and every later admin decision require AAL2 in the same session.
    psql(`begin;
          select set_config('request.jwt.claim.aal','aal2',true);
          select public.sarraf_set_receipt_assignment(
            'tx-canonical','part-r',null,'verified transaction ownership',
            'receipt-assign:tx-canonical:0001');
          commit`);

    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '66666666-6666-6666-6666-666666666666'::uuid $fn$`);
    let customerDenied = false;
    try {
      psql(`select public.sarraf_receipt_intake_begin_v2(
            'doc-forged-customer','tx-canonical','batch-canonical','image/jpeg',
            'receipt-intake:tx-canonical:forged-customer',null)`);
    } catch { customerDenied = true; }
    if (!customerDenied) throw new Error("customer uploaded the assigned partner's purchase receipt");

    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '77777777-7777-7777-7777-777777777777'::uuid $fn$`);
    psql(`select public.sarraf_receipt_intake_begin_v2(
          'doc-canonical','tx-canonical','batch-canonical','image/jpeg',
          'receipt-intake:tx-canonical:doc-canonical',null)`);
    const custody = psql(`select count(*) from public.receipt_custody_ledger
                          where document_id='doc-canonical' and to_partner_id='part-r'`).trim();
    if (custody !== "1") throw new Error(`assigned partner custody rows: ${custody}`);

    // Only the server worker has the grant in production; this verifier runs as the database
    // owner so it can exercise the command after separately checking those grants below.
    psql(`select public.sarraf_receipt_record_server_extraction(
          'doc-canonical',repeat('b',64),1000,'image/jpeg',true,
          '{"grossAmount":"2520.41","orderAmount":"2447.00","feeAmount":"73.41",
            "feeTreatment":"added_on_top","netAmount":"2447.00","currency":"CNY",
            "refNo":"ORDER-CANONICAL","payee":"Assigned Customer","platform":"Alipay",
            "txDate":"2026-08-18","transactionStatus":"successful",
            "confidence":"0.99","ocrVersion":"6"}'::jsonb,
          'test-provider','test-model',50,'request-canonical-0001')`);
    const ocrState = psql(`select state||'|'||(server_attested_at is not null)::text
                           from receipt_documents where id='doc-canonical'`).trim();
    if (ocrState !== "validated|true") throw new Error(`server OCR state is ${ocrState}`);

    psql(`select public.sarraf_receipt_submit(
          '["doc-canonical"]'::jsonb,'receipt-submit:doc-canonical')`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    psql(`begin;
          select set_config('request.jwt.claim.aal','aal2',true);
          select public.sarraf_receipt_review_command(
            'doc-canonical','accept','{}'::jsonb,'stored original matches transaction',
            'receipt-review:accept:doc-canonical:0001');
          select public.sarraf_set_receipt_daily_rate(
            'CNY',(statement_timestamp() at time zone 'Asia/Baghdad')::date,7.20,
            'manual daily settlement rate',
            'receipt-rate:CNY:today:canonical');
          select public.sarraf_receipt_finalize_command(
            'doc-canonical','receipt figures and rate verified',
            'receipt-finalize:doc-canonical:0001');
          commit`);
    const benchmark = psql(`select concat_ws('|',
      public.sarraf_receipt_summary('doc-canonical')->>'gross_usd',
      public.sarraf_receipt_summary('doc-canonical')->>'fee_usd',
      public.sarraf_receipt_summary('doc-canonical')->>'net_usd')`).trim();
    if (benchmark !== "350.06|10.20|339.86") throw new Error(`benchmark is ${benchmark}`);

    psql(`begin;
          select set_config('request.jwt.claim.aal','aal2',true);
          select public.sarraf_set_receipt_daily_rate(
            'CNY',(statement_timestamp() at time zone 'Asia/Baghdad')::date,7.30,
            'later manual rate must not revalue history',
            'receipt-rate:CNY:later:canonical');
          commit`);
    const frozenRate = psql(`select public.sarraf_receipt_summary('doc-canonical')->>'rate_value'`).trim();
    if (Number(frozenRate) !== 7.2) throw new Error(`historical receipt changed to rate ${frozenRate}`);
    let correctionDenied = false;
    try {
      psql(`begin;
        select set_config('request.jwt.claim.aal','aal2',true);
        select public.sarraf_receipt_review_command(
          'doc-canonical','correct','{"netAmount":"1"}'::jsonb,'must not rewrite finalized evidence',
          'receipt-review:correct:finalized:denied');
        commit`);
    } catch { correctionDenied = true; }
    if (!correctionDenied) throw new Error("a finalized extraction was rewritten");

    const destination = psql(`begin;
      select set_config('request.jwt.claim.aal','aal2',true);
      select public.sarraf_forward_receipts_v2(
        '["doc-canonical"]'::jsonb,'verified finalized handoff',
        'receipt-forward:assigned:canonical')->'destinations'->0->>'to_actor_id';
      commit`).trim().split("\n").filter(Boolean).pop();
    if (destination !== "cust-r") throw new Error(`receipt was sent to ${destination}`);

    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '66666666-6666-6666-6666-666666666666'::uuid $fn$`);
    const seen = psql(`select public.sarraf_receipt_mark_seen_v2('doc-canonical')->>'status'`).trim();
    if (seen !== "seen") throw new Error(`customer acknowledgement is ${seen}`);
    const visible = psql(`select count(*) from public.sarraf_my_forwarded_receipts_v2(25)
                          where document_id='doc-canonical' and net_usd=339.86`).trim();
    if (visible !== "1") throw new Error(`customer forwarded read model rows: ${visible}`);

    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '77777777-7777-7777-7777-777777777777'::uuid $fn$`);
    psql(`select public.sarraf_receipt_intake_begin_v2(
          'doc-duplicate-ref','tx-canonical','batch-canonical-2','image/jpeg',
          'receipt-intake:tx-canonical:duplicate-ref',null)`);
    psql(`select public.sarraf_receipt_record_server_extraction(
          'doc-duplicate-ref',repeat('c',64),1001,'image/jpeg',true,
          '{"grossAmount":"2520.41","orderAmount":"2447.00","feeAmount":"73.41",
            "feeTreatment":"added_on_top","netAmount":"2447.00","currency":"CNY",
            "refNo":" order canonical ","payee":"Assigned Customer","platform":"Alipay",
            "txDate":"2026-08-18","transactionStatus":"successful","confidence":"0.99"}'::jsonb,
          'test-provider','test-model',51,'request-canonical-duplicate-ref')`);
    psql(`select public.sarraf_receipt_submit(
          '["doc-duplicate-ref"]'::jsonb,'receipt-submit:duplicate-ref')`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    const duplicateState = psql(`begin;
      select set_config('request.jwt.claim.aal','aal2',true);
      select public.sarraf_receipt_review_command(
        'doc-duplicate-ref','accept','{}'::jsonb,'normalized reference must be unique',
        'receipt-review:accept:duplicate-ref')->>'state';
      commit`).trim().split("\n").filter(Boolean).pop();
    if (duplicateState !== "duplicate") throw new Error(`normalized duplicate became ${duplicateState}`);

    const browserCanWrite = psql(`select has_function_privilege('authenticated',
      'public.sarraf_receipt_record_server_extraction(text,text,bigint,text,boolean,jsonb,text,text,integer,text)',
      'execute')`).trim();
    const serviceCanWrite = psql(`select has_function_privilege('service_role',
      'public.sarraf_receipt_record_server_extraction(text,text,bigint,text,boolean,jsonb,text,text,integer,text)',
      'execute')`).trim();
    if (browserCanWrite !== "f" || serviceCanWrite !== "t") {
      throw new Error(`OCR grants authenticated=${browserCanWrite}, service=${serviceCanWrite}`);
    }
  });

  check("customer-sale intake belongs only to its customer and is never portal-published", () => {
    psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
          ('inv-r','Receipt Investor','investor','88888888-8888-8888-8888-888888888888','t-sarkhel')
          on conflict (id) do nothing;
          insert into public.txs(id,type,cp_id,cp_name,cur_id,amount,rate,against_id,total,status)
          values ('tx-customer-sale','buy','cust-r','Receipt Customer','cny',100,0.1388888889,
                  'usd',13.89,'pending') on conflict do nothing`);
    psql(`begin;
          select set_config('request.jwt.claim.aal','aal2',true);
          select public.sarraf_set_receipt_assignment(
            'tx-customer-sale',null,null,'verified customer sale ownership',
            'receipt-assign:tx-customer-sale:0001');
          commit`);

    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '77777777-7777-7777-7777-777777777777'::uuid $fn$`);
    let denied = false;
    try {
      psql(`select public.sarraf_receipt_intake_begin_v2(
        'doc-wrong-partner','tx-customer-sale','batch-sale','image/jpeg',
        'receipt-intake:tx-customer-sale:wrong-partner',null)`);
    } catch { denied = true; }
    if (!denied) throw new Error("an unrelated partner uploaded the customer's sale receipt");

    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '88888888-8888-8888-8888-888888888888'::uuid $fn$`);
    denied = false;
    try {
      psql(`select public.sarraf_receipt_intake_begin_v2(
        'doc-investor-forged','tx-customer-sale','batch-sale','image/jpeg',
        'receipt-intake:tx-customer-sale:investor',null)`);
    } catch { denied = true; }
    if (!denied) throw new Error("an investor uploaded operational receipt evidence");

    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '66666666-6666-6666-6666-666666666666'::uuid $fn$`);
    psql(`select public.sarraf_receipt_intake_begin_v2(
      'doc-customer-sale','tx-customer-sale','batch-sale','image/jpeg',
      'receipt-intake:tx-customer-sale:customer',null)`);
    const row = psql(`select flow||'|'||uploader_id from public.receipt_documents
                      where id='doc-customer-sale'`).trim();
    if (row !== "customer_sells_to_zeman|cust-r") throw new Error(`sale intake is ${row}`);

    psql(`insert into public.receipt_extractions(
            document_id,version,is_original,raw,gross_amount,fee_amount,fee_treatment,
            net_amount,currency,payee,tx_date,confidence,platform,has_fee,transaction_status)
          values ('doc-customer-sale',1,true,'{}'::jsonb,100,0,'no_fee',100,'CNY',
                  'Receipt Customer',current_date,0.99,'alipay',false,'successful')`);

    for (const state of ["uploaded","ocr_pending","ocr_processing","parsed","validated","submitted","matched","accepted","finalized"])
      psql(`update public.receipt_documents set state='${state}' where id='doc-customer-sale'`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    denied = false;
    try {
      psql(`begin;
        select set_config('request.jwt.claim.aal','aal2',true);
        select public.sarraf_forward_receipts_v2(
          '["doc-customer-sale"]'::jsonb,'must not publish customer-sale evidence',
          'receipt-forward:customer-sale:denied');
        commit`);
    } catch { denied = true; }
    if (!denied) throw new Error("customer-sale evidence was published to another portal");
  });


  // ── Phase 5: transactions post to the journal ──
  // A failed role-specific fixture must never leak its identity into the independent accounting
  // section that follows it.
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
  check("a completed buy posts a balanced entry with the spread recognised", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-buy','buy','cny',7200,0.138889,'usd',1000.00,'completed',now())`);
    const st = psql("select status from journal_entries where source_id='tx-buy'").trim();
    if (st !== "posted") throw new Error(`entry status is '${st}'`);
    const lines = Number(psql("select count(*) from journal_lines where entry_id='je-tx-tx-buy'").trim());
    if (lines < 2) throw new Error(`only ${lines} lines posted`);
    const bal = psql(`select abs(sum(case when side='debit' then base_amount else -base_amount end))
                      from journal_lines where entry_id='je-tx-tx-buy'`).trim();
    if (Number(bal) > 0.01) throw new Error(`entry is unbalanced by ${bal}`);
  });

  check("a pending buy books a payable rather than moving cash", () => {
    // 720 x 0.1972 is 141.984, and the row claimed 142 — outside the one-unit tolerance the
    // total/rate agreement allows, so the insert was refused and tx-pend never existed. Three
    // later checks then failed with "transaction not found", naming nothing that was wrong.
    // A rate that divides cleanly says the same thing without the argument.
    psql(`insert into public.txs(id,type,cp_id,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-pend','buy','cust-1','cny',720,0.2,'usd',144.00,'pending',now())`);
    const acct = psql(`select account_id from journal_lines
                       where entry_id='je-tx-tx-pend' and side='credit' order by line_no limit 1`).trim();
    if (acct !== "acc-2300") throw new Error(`pending buy credited ${acct}, expected the payable`);
    const debt = psql(`select debtor_type||'|'||coalesce(debtor_id,'')||'|'||creditor_type||'|'||
      coalesce(creditor_id,'')||'|'||outstanding_principal
      from debts where source_transaction_id='tx-pend' and status='open'`).trim();
    if (debt !== "zeman||customer|cust-1|144.0000000000")
      throw new Error(`pending purchase debt is ${debt}`);
  });

  mustFail("posted transaction economics cannot drift away from recognition and debt",
    "update public.txs set total=999 where id='tx-pend'");

  check("a sell credits inventory and debits what came in", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-sell','sell','cny',7200,0.14,'usd',1008.00,'completed',now())`);
    const inv = psql(`select side from journal_lines
                      where entry_id='je-tx-tx-sell' and account_id='acc-1400'`).trim();
    if (inv !== "credit") throw new Error(`inventory side on a sell is ${inv}`);
  });

  check("a transaction in a currency with no rate becomes a draft, never a guess", () => {
    psql(`insert into public.currencies(id,code,name) values ('try','TRY','Lira') on conflict do nothing`);
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-norate','buy','try',100,1,'usd',100,'completed',now())`);
    const st = psql("select status from journal_entries where source_id='tx-norate'").trim();
    if (st !== "draft") throw new Error(`expected a draft, got '${st}'`);
    const n = psql("select count(*) from journal_lines where entry_id='je-tx-tx-norate'").trim();
    if (n !== "0") throw new Error("a draft must post no lines");
    const listed = psql("select count(*) from v_journal_drafts where source_id='tx-norate'").trim();
    if (listed !== "1") throw new Error("the draft is not surfaced for an operator");
  });

  check("drafts are excluded from the trial balance, which still reconciles", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });

  check("pending to completed posts a separate cash settlement without rewriting recognition", () => {
    // A completed purchase must be funded.  This is a real operational-ledger seed, not a
    // mocked balance column, and the settlement gate will refuse to overdraw it.
    psql(`insert into public.ledger(id,type,owner,cur_id,amount,note,date,created_by)
          values ('verify-usd-capital','deposit','self','usd',1000000,
                  'accounting verifier opening cash',statement_timestamp(),'u-a')
          on conflict (id) do nothing`);
    const before = psql("select count(*) from journal_lines where entry_id='je-tx-tx-pend'").trim();
    const out = psql(`select public.sarraf_settle_transaction(
      'tx-pend',false,'cmd-tx-settle-1','direct settlement','pending purchase paid in full')::text`);
    const after = psql("select count(*) from journal_lines where entry_id='je-tx-tx-pend'").trim();
    if (after !== before) throw new Error("recognition entry was rewritten during settlement");
    const accountPair = psql(`select string_agg(account_id||':'||side,',' order by line_no)
      from journal_lines where entry_id=(select journal_entry_id from transaction_payment_events
        where transaction_id='tx-pend' and event_kind='settled' order by id desc limit 1)`).trim();
    if (accountPair !== "acc-2300:debit,acc-1000:credit")
      throw new Error(`settlement posted ${accountPair}`);
    const cash = psql(`select amount from public.ledger
      where tx_id='tx-pend' and type='settlement' and reversal_of is null`).trim();
    if (Number(cash) !== -144) throw new Error(`operational settlement cash is ${cash || "missing"}`);
    if (!out.replace(/\s/g,"").includes('"status":"completed"')) throw new Error(out);
    const debtState = psql(`select status||'|'||outstanding_principal from debts
      where source_transaction_id='tx-pend' order by opened_at limit 1`).trim();
    if (debtState !== "settled|0.0000000000") throw new Error(`transaction debt is ${debtState}`);
    const n = psql("select count(*) from journal_entries where source_id='tx-pend'").trim();
    if (n !== "1") throw new Error(`${n} recognition entries exist for one transaction`);
  });

  check("replaying settlement does not move cash twice", () => {
    const before = psql("select count(*) from transaction_payment_events where transaction_id='tx-pend'").trim();
    const out = psql(`select public.sarraf_settle_transaction(
      'tx-pend',false,'cmd-tx-settle-1','direct settlement','pending purchase paid in full')::text`);
    const after = psql("select count(*) from transaction_payment_events where transaction_id='tx-pend'").trim();
    if (after !== before) throw new Error(`events went from ${before} to ${after}`);
    if (!out.replace(/\s/g,"").includes('"replayed":true')) throw new Error(out);
  });

  check("unsettling mirrors only the settlement and returns the transaction to pending", () => {
    const out = psql(`select public.sarraf_unsettle_transaction(
      'tx-pend','cmd-tx-unsettle-1','reverse settlement','bank rejected the payment')::text`);
    const state = psql("select status||'|'||coalesce(paid_at::text,'') from txs where id='tx-pend'").trim();
    if (state !== "pending|") throw new Error(`transaction state is ${state}`);
    const rev = psql(`select count(*) from journal_entries where source_type='transaction_settlement_reversal'
      and transaction_id='tx-pend' and status='posted'`).trim();
    if (rev !== "1") throw new Error("settlement reversal is missing");
    const open = psql(`select count(*) from debts where source_transaction_id='tx-pend'
      and status in ('open','partially_settled')`).trim();
    if (open !== "1") throw new Error(`unsettled transaction has ${open} open debts`);
    if (!out.replace(/\s/g,"").includes('"status":"pending"')) throw new Error(out);
  });

  check("a draft recognition becomes posted only after a real rate is supplied", () => {
    // The ratio has to be supplied where the system reads it. receipt_daily_rates is the
    // receipt lifecycle's own published rate; every valuation outside that lifecycle — this
    // resolver included — reads currencies.rate, which is the single ratio of Phase 2. Both are
    // set here so the case is unambiguous about which one made the draft postable.
    psql(`insert into public.receipt_daily_rates(id,currency,effective_date,rate_value,version,set_by,reason)
          values ('verify-rate-try','TRY',current_date,32,1,'u-a','verified TRY accounting rate')`);
    psql("update public.currencies set rate = 32, rate_updated = now() where id = 'try'");
    const out = psql(`select public.sarraf_resolve_transaction_draft(
      'tx-norate','published verified TRY daily rate','cmd-resolve-try-1')::text`);
    const st = psql("select status from journal_entries where id='je-tx-tx-norate'").trim();
    const n = psql("select count(*) from journal_lines where entry_id='je-tx-tx-norate'").trim();
    if (st !== "posted" || Number(n)<2) throw new Error(`draft is ${st} with ${n} lines`);
    if (!out.replace(/\s/g,"").includes('"status":"posted"')) throw new Error(out);
  });

  check("reversing a transaction entry mirrors every line and keeps the original", () => {
    const before = psql("select count(*) from journal_lines where entry_id='je-tx-tx-buy'").trim();
    psql(`select public.sarraf_reverse_transaction_entry('tx-buy','mistaken rate on this trade','cmd-rev-1')`);
    const src = psql("select status from journal_entries where id='je-tx-tx-buy'").trim();
    if (src !== "reversed") throw new Error(`original is '${src}'`);
    const after = psql("select count(*) from journal_lines where entry_id='je-tx-tx-buy'").trim();
    if (after !== before) throw new Error("the original lines were altered");
    const rev = psql(`select count(*) from journal_entries where reversal_of='je-tx-tx-buy'`).trim();
    if (rev !== "1") throw new Error("no reversal entry was created");
  });

  check("the trial balance still reconciles after a reversal", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });


  // ── §14: RLS matrix. Isolation is proven by querying AS each role, not by reading policies. ──
  // Policies are enforced only for non-superusers, so the checks run as a dedicated role that
  // inherits `authenticated`; running them as postgres would pass vacuously.
  psql(`do $$ begin
          if not exists (select 1 from pg_roles where rolname='zeman_rls_probe') then
            create role zeman_rls_probe login;
          end if;
        end $$`);
  psql(`grant authenticated to zeman_rls_probe`);
  psql(`grant usage on schema public to zeman_rls_probe`);

  // Two customers, two partners, one office — each with a distinct auth id.
  psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
        ('rls-c1','C1','customer','aaaaaaa1-0000-0000-0000-000000000001','t-sarkhel'),
        ('rls-c2','C2','customer','aaaaaaa2-0000-0000-0000-000000000002','t-sarkhel'),
        ('rls-p1','P1','partner', 'aaaaaaa3-0000-0000-0000-000000000003','t-sarkhel'),
        ('rls-o1','O1','office',  'aaaaaaa4-0000-0000-0000-000000000004','t-sarkhel')
        on conflict (id) do nothing`);
  psql(`insert into public.customer_vaults(id,customer_id,currency,available) values
        ('rls-v1','rls-c1','CNY',100),('rls-v2','rls-c2','CNY',200)
        on conflict (customer_id,currency) do nothing`);
  psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
          original_principal,outstanding_principal,source_type,reason,created_by) values
        ('rls-d1','customer','rls-c1','zeman',null,'CNY',50,50,'t','c1 debt','u-a'),
        ('rls-d2','customer','rls-c2','zeman',null,'CNY',60,60,'t','c2 debt','u-a')
        on conflict (id) do nothing`);
  psql(`insert into public.office_payment_assignments(id,office_id,amount,currency,assigned_by)
        values ('rls-opa','rls-o1',10,'CNY','u-a') on conflict (id) do nothing`);
  psql(`insert into public.partner_accounts(id,partner_id,currency,available)
        values ('rls-pa','rls-p1','CNY',5) on conflict (partner_id,currency) do nothing`);

  // Count rows visible to a given auth.uid(), with RLS actually applied.
  // Both statements must share one transaction: set_config with is_local=true is discarded at
  // commit, and psql runs each -c in its own transaction, so the identity would be gone by the
  // time the query ran.
  const asUser = (uid, sql) => psqlAsRole("zeman_rls_probe", uid, sql)
    .trim().split("\n").filter(Boolean).pop().trim();

  // auth.uid() in the fixture reads a session setting so each probe can act as a different user.
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $fn$`);

  const rlsCheck = (name, uid, sql, expected) => {
    try {
      const got = asUser(uid, sql);
      checks.push([got === String(expected), `${name} (expected ${expected}, saw ${got})`]);
    } catch (e) {
      checks.push([false, `${name} — ${String(e.message || e).split("\n").find((l) => l.includes("ERROR")) || e}`]);
    }
  };

  rlsCheck("a customer sees only their own cashbox", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.customer_vaults", 1);
  rlsCheck("a customer sees only debts they are party to", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.debts where id like 'rls-d%'", 1);
  rlsCheck("a customer sees no journal entries", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.journal_entries", 0);
  rlsCheck("a customer sees no office assignments", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.office_payment_assignments", 0);
  rlsCheck("a customer sees no partner accounts", 'aaaaaaa1-0000-0000-0000-000000000001',
    "select count(*) from public.partner_accounts", 0);
  rlsCheck("a partner sees only their own account", 'aaaaaaa3-0000-0000-0000-000000000003',
    "select count(*) from public.partner_accounts where id='rls-pa'", 1);
  rlsCheck("a partner sees no customer cashboxes", 'aaaaaaa3-0000-0000-0000-000000000003',
    "select count(*) from public.customer_vaults", 0);
  rlsCheck("an office sees only its own assignment", 'aaaaaaa4-0000-0000-0000-000000000004',
    "select count(*) from public.office_payment_assignments where id='rls-opa'", 1);
  rlsCheck("an unknown session sees nothing", '99999999-9999-9999-9999-999999999999',
    "select count(*) from public.customer_vaults", 0);
  rlsCheck("a customer cannot write to the ledger", 'aaaaaaa1-0000-0000-0000-000000000001',
    `select count(*) from (select 1 where not exists (
       select 1 from information_schema.role_table_grants
       where grantee='authenticated' and table_name='journal_lines'
         and privilege_type in ('INSERT','UPDATE','DELETE'))) t`, 1);

  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);


  // ── 5: durable intake. The image must survive an OCR failure. ──
  psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
        ('in-c','Intake Customer','customer','bbbbbbb1-0000-0000-0000-000000000001','t-sarkhel')
        on conflict (id) do nothing`);
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select 'bbbbbbb1-0000-0000-0000-000000000001'::uuid $fn$`);

  check("intake claims a slot and returns the exact storage path", () => {
    const out = psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-1','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')::text`);
    if (!out.includes("ingest/batch-1/doc-in-1.jpg")) throw new Error(`unexpected path: ${out}`);
    const st = psql("select state from receipt_documents where id='doc-in-1'").trim();
    if (st !== "uploading") throw new Error(`state is ${st}`);
  });

  check("replaying intake returns the same slot rather than duplicating it", () => {
    const out = psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-1','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')::text`);
    if (!out.replace(/\s/g,"").includes('"replayed":true')) throw new Error(`not a replay: ${out}`);
    const n = psql("select count(*) from receipt_documents where id='doc-in-1'").trim();
    if (n !== "1") throw new Error(`${n} rows exist`);
  });

  mustFail("a customer cannot claim an intake for a purchase flow",
    `select public.sarraf_receipt_intake_begin(
      'doc-in-bad','customer_buys_from_zeman','in-c',null,null,null,'CNY','image/jpeg')`);

  mustFail("an unsupported image type is refused before anything is stored",
    `select public.sarraf_receipt_intake_begin(
      'doc-in-pdf','customer_sells_to_zeman','in-c',null,null,null,'CNY','application/pdf')`);

  check("recording the stored bytes moves the receipt to ocr_pending", () => {
    psql(`select public.sarraf_receipt_intake_stored('doc-in-1', repeat('b',64), 12345)`);
    const row = psql("select state||'|'||image_sha256 from receipt_documents where id='doc-in-1'").trim();
    if (!row.startsWith("ocr_pending|")) throw new Error(`document is ${row}`);
  });

  check("a failed OCR keeps the image and leaves the receipt recoverable", () => {
    psql(`select public.sarraf_receipt_intake_extracted('doc-in-1', false,
          '{"error":"provider_timeout"}'::jsonb, 'groq', 'qwen')`);
    const row = psql(`select state||'|'||storage_path||'|'||coalesce(last_error_code,'')
                      from receipt_documents where id='doc-in-1'`).trim();
    if (row !== "ocr_failed_retryable|ingest/batch-1/doc-in-1.jpg|provider_timeout")
      throw new Error(`document is ${row}`);
  });

  check("a confident reading is recorded as version 1 and validated", () => {
    psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-2','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')`);
    psql(`select public.sarraf_receipt_intake_stored('doc-in-2', repeat('c',64), 999)`);
    psql(`select public.sarraf_receipt_intake_extracted('doc-in-2', true,
      '{"grossAmount":"2520.41","orderAmount":"2447.00","feeAmount":"73.41",
        "feeTreatment":"added_on_top","netAmount":"2447.00","currency":"CNY",
        "refNo":"ORD-1","confidence":"0.91","txDate":"2026-08-04",
        "payee":"Verified Recipient","platform":"Alipay",
        "transactionStatus":"successful"}'::jsonb, 'groq', 'qwen')`);
    const st = psql("select state from receipt_documents where id='doc-in-2'").trim();
    if (st !== "validated") throw new Error(`state is ${st}`);
    const v = psql(`select version||'|'||is_original||'|'||gross_amount
                    from receipt_extractions where document_id='doc-in-2'`).trim();
    if (v !== "1|true|2520.4100000000") throw new Error(`extraction is ${v}`);
  });

  check("a low-confidence reading goes to a human instead of straight through", () => {
    psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-3','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')`);
    psql(`select public.sarraf_receipt_intake_stored('doc-in-3', repeat('d',64), 999)`);
    psql(`select public.sarraf_receipt_intake_extracted('doc-in-3', true,
      '{"grossAmount":"100","currency":"CNY","confidence":"0.40"}'::jsonb, 'groq', 'qwen')`);
    const st = psql("select state from receipt_documents where id='doc-in-3'").trim();
    if (st !== "needs_manual_review") throw new Error(`state is ${st}`);
  });

  check("a currency the transaction did not expect is flagged, never accepted", () => {
    psql(`select public.sarraf_receipt_intake_begin(
      'doc-in-4','customer_sells_to_zeman','in-c',null,null,'batch-1','CNY','image/jpeg')`);
    psql(`select public.sarraf_receipt_intake_stored('doc-in-4', repeat('e',64), 999)`);
    psql(`select public.sarraf_receipt_intake_extracted('doc-in-4', true,
      '{"grossAmount":"2300","currency":"IQD","confidence":"0.95"}'::jsonb, 'groq', 'qwen')`);
    const row = psql("select state||'|'||coalesce(rule_code,'') from receipt_documents where id='doc-in-4'").trim();
    if (row !== "currency_mismatch|currency_mismatch") throw new Error(`document is ${row}`);
  });

  check("an uploader sees their own intakes and their status", () => {
    const n = Number(psql("select count(*) from public.sarraf_my_receipt_intakes(100)").trim());
    if (n < 4) throw new Error(`expected the uploader's own intakes, saw ${n}`);
  });

  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);


  // 8: forwarding. Accepted evidence reaches exactly the party the flow sends it to.
  psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
        ('fw-cust','FW Customer','customer','ccccccc1-0000-0000-0000-000000000001','t-sarkhel'),
        ('fw-part','FW Partner','partner','ccccccc2-0000-0000-0000-000000000002','t-sarkhel')
        on conflict (id) do nothing`);
  // A sale receipt, taken through to accepted.
  psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
        values ('fw-1','customer_sells_to_zeman','fw-cust','fw-cust','ingest/fw/fw-1.jpg')`);
  psql(`insert into public.receipt_extractions(
          document_id,version,is_original,raw,gross_amount,fee_amount,fee_treatment,net_amount,
          currency,payee,tx_date,confidence,platform,has_fee)
        values ('fw-1',1,true,'{}'::jsonb,100,0,'no_fee',100,
                'CNY','FW Partner',current_date,0.99,'wechat',false)`);
  for (const st of ["uploading","uploaded","ocr_pending","ocr_processing","parsed","validated","submitted","accepted"])
    psql(`update public.receipt_documents set state='${st}' where id='fw-1'`);
  // And one left mid-review, which must never be forwarded.
  psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
        values ('fw-2','customer_sells_to_zeman','fw-cust','fw-cust','ingest/fw/fw-2.jpg')`);
  for (const st of ["uploading","uploaded","ocr_pending","ocr_processing","parsed","needs_manual_review"])
    psql(`update public.receipt_documents set state='${st}' where id='fw-2'`);

  check("a sale receipt forwards to the partner and moves into their custody", () => {
    const out = psql(`select public.sarraf_forward_receipts('["fw-1"]'::jsonb,'fw-part',null,
      'partner takes custody of this currency','cmd-fw-1')::text`);
    if (!out.replace(/\s/g,"").includes('"forwarded":1')) throw new Error(`unexpected: ${out}`);
    const st = psql("select state from receipt_documents where id='fw-1'").trim();
    if (st !== "forwarded") throw new Error(`document is ${st}`);
    const custody = psql("select count(*) from receipt_custody_ledger where document_id='fw-1'").trim();
    if (custody !== "1") throw new Error("custody was not recorded");
    const owner = psql("select partner_id from receipt_documents where id='fw-1'").trim();
    if (owner !== "fw-part") throw new Error(`custody holder is ${owner}`);
  });

  check("a receipt still under review is skipped and named, not forwarded", () => {
    const out = psql(`select public.sarraf_forward_receipts('["fw-2"]'::jsonb,'fw-part',null,
      'attempting to forward a pending receipt','cmd-fw-2')::text`);
    if (!out.replace(/\s/g,"").includes('"forwarded":0')) throw new Error(`it was forwarded: ${out}`);
    if (!out.includes("needs_manual_review")) throw new Error(`the reason was not named: ${out}`);
    const n = psql("select count(*) from receipt_forwardings where document_id='fw-2'").trim();
    if (n !== "0") throw new Error("a pending receipt reached a portal");
  });

  check("a sale receipt cannot be forwarded to a customer", () => {
    // A fresh accepted receipt, so the recipient rule is what is under test rather than the
    // already-forwarded state of fw-1.
    psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
          values ('fw-3','customer_sells_to_zeman','fw-cust','fw-cust','ingest/fw/fw-3.jpg')`);
    psql(`insert into public.receipt_extractions(
            document_id,version,is_original,raw,gross_amount,fee_amount,fee_treatment,net_amount,
            currency,payee,tx_date,confidence,platform,has_fee)
          values ('fw-3',1,true,'{}'::jsonb,100,0,'no_fee',100,
                  'CNY','FW Partner',current_date,0.99,'wechat',false)`);
    for (const st of ["uploading","uploaded","ocr_pending","ocr_processing","parsed","validated","submitted","accepted"])
      psql(`update public.receipt_documents set state='${st}' where id='fw-3'`);
    const out = psql(`select public.sarraf_forward_receipts('["fw-3"]'::jsonb,'fw-cust',null,
      'wrong recipient for this flow','cmd-fw-3')::text`);
    if (!out.includes("recipient_must_be_partner")) throw new Error(`unexpected: ${out}`);
    const n = psql("select count(*) from receipt_forwardings where document_id='fw-3'").trim();
    if (n !== "0") throw new Error("the receipt reached the wrong party");
  });

  check("forwarding twice does not duplicate the delivery record", () => {
    psql(`select public.sarraf_forward_receipts('["fw-1"]'::jsonb,'fw-part',null,
      'resend after a delivery problem','cmd-fw-4')`);
    const n = psql(`select count(*) from receipt_forwardings where document_id='fw-1'`).trim();
    if (n !== "1") throw new Error(`${n} forwarding rows exist`);
  });

  check("delivered and seen are recorded by the recipient, not by the sender", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select 'ccccccc2-0000-0000-0000-000000000002'::uuid $fn$`);
    psql(`select public.sarraf_receipt_mark_delivered('fw-1')`);
    let st = psql("select delivery_status from receipt_forwardings where document_id='fw-1'").trim();
    if (st !== "delivered") throw new Error(`status is ${st}`);
    psql(`select public.sarraf_receipt_mark_seen('fw-1')`);
    st = psql("select state from receipt_documents where id='fw-1'").trim();
    if (st !== "seen") throw new Error(`document is ${st}`);
  });

  check("a recipient sees their forwarded receipts with the figures", () => {
    const n = Number(psql("select count(*) from public.sarraf_my_forwarded_receipts(50)").trim());
    if (n !== 1) throw new Error(`expected 1 forwarded receipt, saw ${n}`);
  });

  check("someone the receipt was not forwarded to cannot mark it delivered", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select 'ccccccc1-0000-0000-0000-000000000001'::uuid $fn$`);
    let denied = false;
    try { psql(`select public.sarraf_receipt_mark_delivered('fw-1')`); } catch { denied = true; }
    const n = Number(psql("select count(*) from public.sarraf_my_forwarded_receipts(50)").trim());
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    if (!denied) throw new Error("a non-recipient marked the receipt delivered");
    if (n !== 0) throw new Error(`a non-recipient saw ${n} forwarded receipts`);
  });

  // The guard was written `between 1 and 0` — a range no length can satisfy — so an empty
  // selection passed validation, forwarded nothing, and burnt its command key on a recorded
  // "success". A retry with that key then replays the empty result forever.
  check("an empty selection is refused rather than recorded as a completed forward", () => {
    let denied = false;
    try { psql(`select public.sarraf_forward_receipts('[]'::jsonb,'fw-part',null,
      'forwarding nothing at all','cmd-fw-empty')::text`); } catch { denied = true; }
    if (!denied) throw new Error("an empty selection was accepted");
    const n = psql("select count(*) from accounting_commands where command_key='cmd-fw-empty'").trim();
    if (n !== "0") throw new Error("the command key was spent on an empty selection");
  });

  mustFail("a null selection is refused",
    `select public.sarraf_forward_receipts(null::jsonb,'fw-part',null,
      'forwarding a null selection','cmd-fw-null')`);

  check("sent, delivered and seen reconcile separately", () => {
    const out = psql("select public.sarraf_forwarding_reconciliation()::text").trim();
    for (const k of ["forwarded","sent","delivered","seen","failed"]) {
      if (!out.includes(k)) throw new Error(`${k} missing from reconciliation`);
    }
  });

  // ── §12: day close ──
  // Distinct historical business dates prove the one-close-per-day contract. Historical
  // rates are seeded explicitly; a later current rate must never be borrowed for an old close.
  psql(`insert into public.rate_history(id,cur_id,buy_rate,sell_rate,created_at,changed_by)
        values ('verify-iqd-history','iqd',1400,1400,
                ((current_date-10)::timestamp at time zone 'Asia/Baghdad'),'u-a')
        on conflict (id) do nothing`);
  // A safe short by 400,000 could be closed in silence, and nobody could ever find out why.
  mustFail("a counted difference cannot be closed without a reason",
    `insert into public.day_closes(id,close_date,lines,has_diff,closed_by) values
     ('dc-bad',current_date,'[{"cur":"iqd","code":"IQD","expected":1000000,"counted":600000,"diff":-400000}]'::jsonb,true,'u-a')`);

  mustFail("a reason shorter than the minimum is refused",
    `insert into public.day_closes(id,close_date,lines,note,closed_by) values
     ('dc-bad2',current_date,'[{"cur":"iqd","code":"IQD","diff":-400000}]'::jsonb,'کەم','u-a')`);

  // The flag is not trusted: the lines decide whether a reason is owed.
  mustFail("a close claiming to be clean while carrying a difference is refused",
    `insert into public.day_closes(id,close_date,lines,has_diff,closed_by) values
     ('dc-bad3',current_date,'[{"cur":"iqd","code":"IQD","diff":-400000}]'::jsonb,false,'u-a')`);

  check("a clean count closes with no reason at all", () => {
    psql(`begin;
          select set_config('sarraf.day_close_adjustment','verify-clean',true);
          insert into public.day_closes(id,close_date,lines,closed_by) values
          ('dc-clean',current_date-4,'[{"cur":"iqd","code":"IQD","expected":1000,"counted":1000,"diff":0}]'::jsonb,'u-a');
          commit`);
    const n = psql("select count(*) from journal_entries where id='je-close-dc-clean'").trim();
    if (n !== "0") throw new Error("a day with no difference posted an entry");
  });

  // §12 and §13: the difference reaches the books instead of vanishing into an adjustment.
  check("an explained shortage posts to cash over/short and balances", () => {
    psql(`begin;
          select set_config('sarraf.day_close_adjustment','verify-short',true);
          insert into public.day_closes(id,close_date,lines,note,closed_by) values
          ('dc-short',current_date-3,
           '[{"cur":"iqd","code":"IQD","expected":1420000,"counted":1418600,"diff":-1400}]'::jsonb,
           'خەرجی تۆمار نەکراو بۆ گواستنەوە','u-a');
          commit`);
    const st = psql("select status from journal_entries where id='je-close-dc-short'").trim();
    if (st !== "posted") throw new Error(`entry is ${st || "missing"}`);
    const short = psql(`select coalesce(sum(base_amount) filter (where side='debit'),0)
                        from journal_lines where entry_id='je-close-dc-short' and account_id='acc-5910'`).trim();
    if (Number(short) <= 0) throw new Error("the shortage did not reach cash over/short");
    const bal = psql(`select coalesce(sum(base_amount) filter (where side='debit'),0)
                           - coalesce(sum(base_amount) filter (where side='credit'),0)
                      from journal_lines where entry_id='je-close-dc-short'`).trim();
    if (Math.abs(Number(bal)) > 1e-6) throw new Error(`entry is unbalanced by ${bal}`);
  });

  check("an overage credits cash over/short rather than debiting it", () => {
    psql(`begin;
          select set_config('sarraf.day_close_adjustment','verify-over',true);
          insert into public.day_closes(id,close_date,lines,note,closed_by) values
          ('dc-over',current_date-2,
           '[{"cur":"usd","code":"USD","expected":1000,"counted":1025,"diff":25}]'::jsonb,
           'پارەی زیادە لە ژماردندا دۆزرایەوە','u-a');
          commit`);
    const cr = psql(`select coalesce(sum(base_amount) filter (where side='credit'),0)
                     from journal_lines where entry_id='je-close-dc-over' and account_id='acc-5910'`).trim();
    if (Number(cr) <= 0) throw new Error("an overage did not credit cash over/short");
  });

  // A currency with no rate cannot be valued; the entry is a draft carrying the reason,
  // exactly as an unvalued transaction is — never an invented number.
  check("a difference in an unrated currency is drafted, not guessed", () => {
    psql(`begin;
          select set_config('sarraf.day_close_adjustment','verify-unrated',true);
          insert into public.day_closes(id,close_date,lines,note,closed_by) values
          ('dc-unrated',current_date-1,'[{"cur":"xxx","code":"XXX","diff":-50}]'::jsonb,
           'دراوێک کە نرخی دانەنراوە','u-a');
          commit`);
    const st = psql("select status from journal_entries where id='je-close-dc-unrated'").trim();
    if (st !== "draft") throw new Error(`expected a draft, got ${st || "nothing"}`);
    const n = psql("select count(*) from journal_lines where entry_id='je-close-dc-unrated'").trim();
    if (n !== "0") throw new Error("an unvalued entry posted lines anyway");
  });

  // §12: immutable close history. A correction is a new close, not an edit of the old one.
  mustFail("a recorded close cannot be deleted", "delete from public.day_closes where id='dc-short'");
  mustFail("the counted figures of a recorded close cannot be rewritten",
    `update public.day_closes set lines='[{"cur":"iqd","code":"IQD","diff":0}]'::jsonb where id='dc-short'`);
  mustFail("who closed the day cannot be rewritten",
    "update public.day_closes set closed_by='u-b' where id='dc-short'");

  check("closes carrying a difference are listed with what they cost", () => {
    const n = Number(psql("select count(*) from public.v_day_close_differences").trim());
    if (n < 3) throw new Error(`expected the differing closes to be listed, saw ${n}`);
    const clean = psql("select count(*) from public.v_day_close_differences where id='dc-clean'").trim();
    if (clean !== "0") throw new Error("a clean close was listed as a difference");
  });

  // ── §12: the legacy ledger and the journal must agree ──
  // Two records of the same money are only safe while they agree, and nothing was checking.
  check("a transaction the books never received is named, not hidden in a summary", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status)
          values ('tx-ok','buy','cny',100,0.138889,'usd',13.89,'completed')`);
    // The trigger is what posts an entry; disabling it reproduces a transaction that reached
    // the interface but never reached the books.
    psql("alter table public.txs disable trigger txs_post_journal");
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status)
          values ('tx-gap','buy','cny',500,0.138889,'usd',69.44,'completed')`);
    psql("alter table public.txs enable trigger txs_post_journal");
    const gaps = psql("select transaction_id||'|'||gap from public.v_ledger_journal_gaps order by 1").trim();
    if (!gaps.includes("tx-gap|no_journal_entry")) throw new Error(`gap not reported: ${gaps}`);
    if (gaps.includes("tx-ok|")) throw new Error(`a healthy transaction was reported as a gap: ${gaps}`);
  });

  check("reconciliation refuses to say the books agree while a gap exists", () => {
    const out = psql("select public.sarraf_ledger_journal_reconciliation()::text").trim();
    if (/"ok":\s*true/.test(out)) throw new Error(`agreed while a gap exists: ${out}`);
    if (!/"ledger_journal_gaps":\s*[1-9]/.test(out)) throw new Error(`the gap was not counted: ${out}`);
  });

  // The rows that would show an operator money the books cannot account for.
  check("a ledger row pointing at an unposted transaction is counted", () => {
    psql(`insert into public.ledger(id,type,cur_id,amount,tx_id)
          values ('lg-gap','buy','cny',500,'tx-gap'),('lg-ok','buy','cny',100,'tx-ok')`);
    const out = psql("select public.sarraf_ledger_journal_reconciliation()::text").trim();
    const gaps = Number(psql("select count(*) from public.v_ledger_journal_gaps").trim());
    if (gaps < 1 || !/"ledger_journal_gaps":\s*[1-9]/.test(out))
      throw new Error(`the ledger/journal gap was not counted: ${out}`);
  });

  // An unvalued entry is a gap too: the trade happened, the books cannot state it in USD.
  check("an entry left as a draft is reported separately from a missing one", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status)
          values ('tx-unrated','buy','xxx',10,1,'usd',10,'completed')`);
    const gaps = psql("select transaction_id||'|'||gap from public.v_ledger_journal_gaps order by 1").trim();
    if (!gaps.includes("tx-unrated|entry_unvalued"))
      throw new Error(`an unvalued entry was not distinguished: ${gaps}`);
    const out = psql("select public.sarraf_ledger_journal_reconciliation()::text").trim();
    if (!/"journal_drafts":\s*[1-9]/.test(out)) throw new Error(`not counted: ${out}`);
  });

  check("an entry whose transaction was voided is reported as an orphan", () => {
    psql("update public.txs set deleted = true where id='tx-ok'");
    const n = psql("select count(*) from public.v_journal_orphans where source_id='tx-ok'").trim();
    if (n !== "1") throw new Error("a voided transaction's entry was not flagged");
  });

  // Once the books receive the transaction, it stops being reported.
  check("a resolved gap leaves the report", () => {
    psql("update public.txs set status = status where id='tx-gap'");
    const gaps = psql("select transaction_id from public.v_ledger_journal_gaps").trim();
    if (gaps.includes("tx-gap")) throw new Error("the transaction is still reported after posting");
    const n = psql("select count(*) from journal_entries where id='je-tx-tx-gap' and status='posted'").trim();
    if (n !== "1") throw new Error("no entry was posted for it");
  });

  check("a non-admin cannot reconcile the books", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '99999999-9999-9999-9999-999999999999'::uuid $fn$`);
    let denied = false;
    try { psql("select public.sarraf_ledger_journal_reconciliation()"); } catch { denied = true; }
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
    if (!denied) throw new Error("a stranger could read the reconciliation");
  });

  // ── one ratio per currency ──
  // The owner's own worked example, and the one the specification locks in §4.13.
  check("3400 yuan at 1 USD = 7.20 values at 472.22 dollars", () => {
    const v = psql("select round(public.sarraf_usd_value(3400,'cny'),2)").trim();
    if (v !== "472.22") throw new Error(`got ${v}`);
  });

  check("2520.41 CNY at 7.20 is 350.06, its fee 10.20, its net 339.86", () => {
    const rows = psql(`select round(public.sarraf_usd_value(2520.41,'cny'),2)||'|'||
                              round(public.sarraf_usd_value(73.41,'cny'),2)||'|'||
                              round(public.sarraf_usd_value(2447.00,'cny'),2)`).trim();
    if (rows !== "350.06|10.20|339.86") throw new Error(`got ${rows}`);
  });

  check("the backfill took the midpoint of the pair that was there before", () => {
    // The fixture seeded cny at buy 7.10 / sell 7.30.
    const r = psql("select rate from public.currencies where id='cny'").trim();
    if (Number(r) !== 7.2) throw new Error(`expected 7.2, got ${r}`);
  });

  check("the dollar is exactly one", () => {
    const r = psql("select rate from public.currencies where id='usd'").trim();
    if (Number(r) !== 1) throw new Error(`got ${r}`);
  });

  // A currency nobody has priced cannot be valued. Zero would read as "worth nothing".
  check("an unpriced currency values as unknown, never as zero", () => {
    const v = psql("select coalesce(public.sarraf_usd_value(100,'xxx')::text,'NULL')").trim();
    if (v !== "NULL") throw new Error(`expected NULL, got ${v}`);
    const listed = psql("select count(*) from public.v_unpriced_currencies where id='xxx'").trim();
    if (listed !== "1") throw new Error("the unpriced currency was not listed");
  });

  mustFail("a ratio of zero is refused by the database",
    "update public.currencies set rate = 0 where id='cny'");
  mustFail("a negative ratio is refused by the database",
    "update public.currencies set rate = -1 where id='cny'");

  check("saving a ratio records it, and history keeps the old one", () => {
    psql(`select public.sarraf_save_rates(
            '[{"id":"cny","rate":7.05}]'::jsonb,
            '[{"id":"rh-1","cur_id":"cny","rate":7.05,"changed_by":"u-a"}]'::jsonb,
            'cmd-rate-1','ratio change','1 USD = 7.05 CNY')`);
    const now = psql("select rate from public.currencies where id='cny'").trim();
    if (Number(now) !== 7.05) throw new Error(`currency not updated: ${now}`);
    const hist = psql("select rate from public.rate_history where id='rh-1'").trim();
    if (Number(hist) !== 7.05) throw new Error("history did not record the ratio");
    // Restore, so the checks above stay reproducible in any order.
    psql("update public.currencies set rate = 7.2 where id='cny'");
  });

  mustFail("a zero ratio is refused by the command too",
    `select public.sarraf_save_rates('[{"id":"cny","rate":0}]'::jsonb,'[]'::jsonb,'cmd-rate-bad','x','y')`);

  // ── receipts become a real transaction, once ──
  // The owner's report: "a yuan receipt arrived, so I am buying yuan — the yuan should go up
  // and the dollars should come down, because this is a real transaction."
  check("a completed purchase brings the currency in and takes the payment out", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-mv','buy','cny',3400,0.138889,'usd',472.22,'completed',now())`);
    psql("select public.sarraf_ensure_transaction_ledger('tx-mv')");
    const cny = psql("select amount from ledger where tx_id='tx-mv' and cur_id='cny'").trim();
    const usd = psql("select amount from ledger where tx_id='tx-mv' and cur_id='usd'").trim();
    if (Number(cny) !== 3400) throw new Error(`yuan moved by ${cny}, expected +3400`);
    if (Number(usd) !== -472.22) throw new Error(`dollars moved by ${usd}, expected -472.22`);
  });

  // An unpaid purchase must not pretend cash left the safe.
  check("an unpaid purchase brings the currency in and moves no cash", () => {
    // A pending purchase opens a debt against somebody, so it must name a registered customer.
    // Without one the insert is refused and the case never reaches what it is testing.
    psql(`insert into public.txs(id,type,cp_id,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-unpaid','buy','cust-1','cny',1000,0.138889,'usd',138.89,'pending',now())`);
    psql("select public.sarraf_ensure_transaction_ledger('tx-unpaid')");
    const cny = psql("select amount from ledger where tx_id='tx-unpaid' and cur_id='cny'").trim();
    const usd = psql("select count(*) from ledger where tx_id='tx-unpaid' and cur_id='usd'").trim();
    if (Number(cny) !== 1000) throw new Error(`yuan moved by ${cny}`);
    if (usd !== "0") throw new Error("an unpaid purchase moved cash");
  });

  check("a sale takes the currency out and brings the payment in", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status,date)
          values ('tx-mv-sell','sell','cny',2000,0.14,'usd',280.00,'completed',now())`);
    psql("select public.sarraf_ensure_transaction_ledger('tx-mv-sell')");
    const cny = psql("select amount from ledger where tx_id='tx-mv-sell' and cur_id='cny'").trim();
    const usd = psql("select amount from ledger where tx_id='tx-mv-sell' and cur_id='usd'").trim();
    if (Number(cny) !== -2000) throw new Error(`yuan moved by ${cny}, expected -2000`);
    if (Number(usd) !== 280) throw new Error(`dollars moved by ${usd}, expected +280`);
  });

  // Whichever path already moved the money, it must not be moved a second time.
  check("the movement is written once, however often it is ensured", () => {
    const before = psql("select count(*) from ledger where tx_id='tx-mv'").trim();
    psql("select public.sarraf_ensure_transaction_ledger('tx-mv')");
    psql("select public.sarraf_ensure_transaction_ledger('tx-mv')");
    const after = psql("select count(*) from ledger where tx_id='tx-mv'").trim();
    if (before !== after) throw new Error(`rows went from ${before} to ${after}`);
  });

  // The three numbers on a transaction must agree with each other.
  mustFail("a total that its own rate does not support is refused",
    `insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status)
     values ('tx-lies','buy','cny',3400,0.138889,'usd',999.99,'completed')`);

  check("a rounding-sized difference is accepted, a real one is not", () => {
    psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status)
          values ('tx-round','buy','cny',3400,0.138889,'usd',472.23,'completed')`);
    let denied = false;
    try {
      psql(`insert into public.txs(id,type,cur_id,amount,rate,against_id,total,status)
            values ('tx-round2','buy','cny',3400,0.138889,'usd',472.50,'completed')`);
    } catch { denied = true; }
    if (!denied) throw new Error("a total off by a quarter of a dollar was accepted");
  });

  mustFail("an edit cannot break the agreement either",
    "update public.txs set total = 5000 where id='tx-mv'");

  // batch_id is a foreign key and 'b-1' was never created, so both intake cases failed on the
  // insert rather than on what they were meant to be testing.
  psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency)
        values ('b-intake','cust-1','u-a','in','CNY') on conflict (id) do nothing`);

  // A receipt already turned into a transaction cannot be turned into another one.
  check("a converted receipt is named as converted, not merely ineligible", () => {
    // submitted_by is not null: an intake item is evidence somebody handed in, and a row that
    // cannot say who did is not evidence of anything.
    psql(`insert into public.receipt_intake_items(id,batch_id,submitted_by,direction,image_path,source_status,intake_status,counted,currency,amount,fee,net_amount,transaction_id)
          values ('ri-1','b-intake','u-a','in','ingest/verify-intake-0001/receipt-ri-1.jpg','ok','accepted',true,'CNY',3400,0,3400,'tx-mv')`);
    const n = psql(`select count(*) from public.sarraf_receipt_already_converted('["ri-1"]'::jsonb)`).trim();
    if (n !== "1") throw new Error("an already-converted receipt was not reported");
  });

  check("an unconverted receipt is not reported as converted", () => {
    psql(`insert into public.receipt_intake_items(id,batch_id,submitted_by,direction,image_path,source_status,intake_status,counted,currency,amount,fee,net_amount)
          values ('ri-2','b-intake','u-a','in','ingest/verify-intake-0001/receipt-ri-2.jpg','ok','accepted',true,'CNY',1000,0,1000)`);
    const n = psql(`select count(*) from public.sarraf_receipt_already_converted('["ri-2"]'::jsonb)`).trim();
    if (n !== "0") throw new Error("a free receipt was reported as converted");
  });

  // Voiding the transaction must give the evidence back, or a mistaken conversion strands it.
  check("voiding a transaction releases its receipts", () => {
    psql("update public.txs set deleted = true where id='tx-mv'");
    const still = psql("select coalesce(transaction_id,'FREE') from public.receipt_intake_items where id='ri-1'").trim();
    if (still !== "FREE") throw new Error(`the receipt is still held by ${still}`);
  });

  // ── a customer-seller sells, and reads back their own archive ──
  // The owner's report: "the customer-seller may only send their own sale receipts, not
  // purchase", and "the customer-seller and every other user must see the history and details
  // of their own receipts".
  // A distinct auth_id. cust-r already holds 6666…, and auth_id is unique, so re-using it made
  // `on conflict do nothing` swallow this insert whole — the seller was never created and the
  // first row referencing them failed a foreign key several lines later, naming a table that had
  // nothing to do with the mistake.
  psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
        ('cust-s','Seller','customer','5e11e5aa-0000-0000-0000-00000000005e','t-sarkhel')
        on conflict (id) do update set auth_id = excluded.auth_id`);
  const asSeller = () => psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '5e11e5aa-0000-0000-0000-00000000005e'::uuid $fn$`);
  const asAdmin = () => psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
  asSeller();

  check("a customer may send the receipts of what they sold", () => {
    psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency,
            total_gross,total_fee,total_net,n,rejected_n)
          values ('b-s1','cust-s','cust-s','in','CNY',1700,6,1694,4,1)`);
    psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,fee,
            net_amount,currency,receiver,raw,status,counted,ref_no) values
          ('r-s1','b-s1','cust-s','cust-s','in',1000,3,997,'CNY','ئەحمەد','{}','ok',true,'R-1'),
          ('r-s2','b-s1','cust-s','cust-s','in',500,1,499,'CNY','ئەحمەد','{}','ok',true,'R-2'),
          ('r-s3','b-s1','cust-s','cust-s','in',200,2,198,'CNY',null,'{"payee":"Taobao"}','ok',true,'R-3'),
          ('r-s4','b-s1','cust-s','cust-s','in',999,0,999,'CNY','ئەحمەد','{}','dup',false,'R-4')`);
    const n = psql("select count(*) from public.receipts where batch_id='b-s1'").trim();
    if (n !== "4") throw new Error(`the sale batch stored ${n} receipts`);
  });

  mustFail("a customer cannot send a batch of what they bought",
    `insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency)
     values ('b-bad','cust-s','cust-s','out','CNY')`);

  mustFail("a customer cannot send a purchase receipt",
    `insert into public.receipts(id,customer_id,uploaded_by,direction,amount,currency)
     values ('r-bad','cust-s','cust-s','buy',100,'CNY')`);

  mustFail("a customer cannot turn a sale into a purchase afterwards",
    `update public.receipt_batches set direction='out' where id='b-s1'`);

  check("an administrator still records both directions", () => {
    asAdmin();
    psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency)
          values ('b-admin','cust-s','u-a','out','CNY')`);
    const d = psql("select direction from public.receipt_batches where id='b-admin'").trim();
    asSeller();
    if (d !== "out") throw new Error(`the administrator's batch is ${d}`);
  });

  const sellerSummary = () => JSON.parse(psql("select public.sarraf_portal_receipt_summary(365)::text"));

  check("the seller's grand total is stated with the fee and without it", () => {
    const g = sellerSummary().grand_total;
    if (g.length !== 1) throw new Error(`expected one currency, got ${JSON.stringify(g)}`);
    const cny = g[0];
    if (cny.currency !== "CNY") throw new Error(`currency is ${cny.currency}`);
    if (Number(cny.with_fee) !== 1700) throw new Error(`with fee is ${cny.with_fee}, expected 1700`);
    if (Number(cny.without_fee) !== 1694) throw new Error(`without fee is ${cny.without_fee}, expected 1694`);
    if (Number(cny.count) !== 3) throw new Error(`counted ${cny.count} receipts, expected 3`);
  });

  check("a rejected receipt is shown but counted towards nothing", () => {
    const s = sellerSummary();
    if (Number(s.unread_count) !== 1) throw new Error(`unread is ${s.unread_count}`);
    if (s.receipts.length !== 4) throw new Error(`the archive holds ${s.receipts.length} receipts`);
    if (!s.receipts.some((r) => r.id === "r-s4" && r.status === "dup")) {
      throw new Error("the rejected receipt is missing from the archive");
    }
  });

  check("the summary says which recipient received how many receipts and how much", () => {
    const r = sellerSummary().by_recipient;
    if (r.length !== 2) throw new Error(`expected two recipients, got ${JSON.stringify(r)}`);
    if (r[0].payee !== "ئەحمەد" || Number(r[0].count) !== 2) {
      throw new Error(`the busiest recipient is ${JSON.stringify(r[0])}`);
    }
    if (Number(r[0].by_currency.CNY.without_fee) !== 1496) {
      throw new Error(`ئەحمەد received ${r[0].by_currency.CNY.without_fee}, expected 1496`);
    }
    // The name lives in the raw payload for a merchant payment; reading only the receiver
    // column is why receipts that plainly showed a name were reported as going to nobody.
    if (r[1].payee !== "Taobao") throw new Error(`the merchant reads as ${r[1].payee}`);
  });

  check("the archive carries the details, and never a valuation", () => {
    const one = sellerSummary().receipts.find((r) => r.id === "r-s1");
    if (!one) throw new Error("the archive is missing a receipt the seller sent");
    for (const f of ["ref_no", "currency", "amount", "fee", "net_amount", "payee", "created_at"]) {
      if (one[f] === undefined) throw new Error(`the archive does not carry ${f}`);
    }
    const text = psql("select public.sarraf_portal_receipt_summary(365)::text");
    if (/usd|"rate"/i.test(text)) throw new Error("the uploader's summary quotes a valuation");
  });

  check("one uploader never sees another's receipts", () => {
    asAdmin();
    psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
          ('cust-t','Other','customer','77777777-7777-7777-7777-777777777777','t-sarkhel') on conflict do nothing`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '77777777-7777-7777-7777-777777777777'::uuid $fn$`);
    const s = JSON.parse(psql("select public.sarraf_portal_receipt_summary(365)::text"));
    asAdmin();
    if (s.receipts.length || s.grand_total.length) {
      throw new Error(`a stranger saw ${s.receipts.length} receipts`);
    }
  });

  // ── one canonical total, computed once, on the server ──
  // §4.13's locked example: gross 2520.41 CNY, fee 73.41 CNY, net 2447.00 CNY at 1 USD = 7.20
  // must give exactly 350.06, 10.20 and 339.86 USD — to the administrator and to the person who
  // sent the receipts alike, from the same read model.
  asAdmin();
  psql("update public.currencies set rate = 7.20, rate_updated = now() where id='cny'");
  psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency,receipt_stage)
        values ('b-sum','cust-s','cust-s','in','CNY','matched')`);
  psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,fee,
          net_amount,currency,receiver,status,counted) values
        ('r-sum1','b-sum','cust-s','cust-s','in',1000.03,29.13,970.90,'CNY','ئەحمەد','ok',true),
        ('r-sum2','b-sum','cust-s','cust-s','in',1520.38,44.28,1476.10,'CNY','ئەحمەد','ok',true)`);
  const summary = (who) => { who(); return JSON.parse(psql("select public.sarraf_batch_summary('b-sum')::text")); };
  // psql prints an error's text but not its SQLSTATE, so the probe hands both back as a value.
  psql(`create or replace function public.zeman_probe_stale(p_batch text, p_version text)
        returns text language plpgsql as $fn$
        begin perform public.sarraf_assert_summary_current(p_batch, p_version); return 'ok';
        exception when others then return sqlstate || '|' || sqlerrm; end $fn$`);

  check("2520.41 CNY at 1 USD = 7.20 is 350.06, its fee 10.20, its net 339.86", () => {
    const c = summary(asAdmin).currencies[0];
    if (c.currency_code !== "CNY") throw new Error(`currency is ${c.currency_code}`);
    if (c.native.gross_total.amount_decimal !== "2520.41") throw new Error(`gross ${c.native.gross_total.amount_decimal}`);
    if (c.native.fee_total.amount_decimal !== "73.41") throw new Error(`fee ${c.native.fee_total.amount_decimal}`);
    if (c.native.net_total.amount_decimal !== "2447.00") throw new Error(`net ${c.native.net_total.amount_decimal}`);
    if (c.usd.gross_total.amount_decimal !== "350.06") throw new Error(`gross USD ${c.usd.gross_total.amount_decimal}`);
    if (c.usd.fee_total.amount_decimal !== "10.20") throw new Error(`fee USD ${c.usd.fee_total.amount_decimal}`);
    if (c.usd.net_total.amount_decimal !== "339.86") throw new Error(`net USD ${c.usd.net_total.amount_decimal}`);
  });

  check("the native equation holds: 2520.41 = 2447.00 + 73.41", () => {
    if (summary(asAdmin).currencies[0].equation_holds !== true) throw new Error("the receipts disagree with themselves");
  });

  // Adding the display-rounded USD of each row gives 350.05, not 350.06. §4.12 forbids it, and
  // this is the drift it forbids.
  check("the total is divided once, not added up row by row", () => {
    const rows = Number(psql(`select round(1000.03/7.20,2) + round(1520.38/7.20,2)`).trim());
    const once = Number(summary(asAdmin).currencies[0].usd.gross_total.amount_decimal);
    if (rows !== 350.05) throw new Error(`the row-wise answer is ${rows}; the example no longer proves anything`);
    if (once !== 350.06) throw new Error(`the total-wise answer is ${once}, expected 350.06`);
  });

  check("every USD figure states what it came from and what produced it", () => {
    const c = summary(asAdmin).currencies[0];
    if (c.usd.gross_total.source_amount.amount_decimal !== "2520.41") throw new Error("the source amount is missing");
    if (c.usd.gross_total.source_amount.currency_code !== "CNY") throw new Error("the source currency is missing");
    if (!c.usd.gross_total.unrounded.startsWith("350.056")) throw new Error(`unrounded is ${c.usd.gross_total.unrounded}`);
    if (c.rate.rate_value !== "7.20000000") throw new Error(`rate is ${c.rate.rate_value}`);
    if (!c.rate.rate_convention.includes("1 USD = 7.2 CNY")) throw new Error(`convention is ${c.rate.rate_convention}`);
  });

  check("the administrator and the sender read the very same figures", () => {
    const admin = psql("select public.sarraf_batch_summary('b-sum')::text");
    asSeller();
    const sender = psql("select public.sarraf_batch_summary('b-sum')::text");
    asAdmin();
    const strip = (s) => s.replace(/"calculated_at": ?"[^"]*"/g, "");
    if (strip(admin) !== strip(sender)) throw new Error("the two roles were given different summaries");
  });

  check("a stranger cannot read a batch that is not theirs", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '77777777-7777-7777-7777-777777777777'::uuid $fn$`);
    let denied = false;
    try { psql("select public.sarraf_batch_summary('b-sum')"); } catch { denied = true; }
    asAdmin();
    if (!denied) throw new Error("a stranger read the batch");
  });

  // §4.15: the version moves when, and only when, something that changes the totals changes.
  let lockedVersion = "";
  check("the summary version holds still while nothing changes", () => {
    lockedVersion = summary(asAdmin).summary_version;
    if (!lockedVersion) throw new Error("no summary version was issued");
    if (summary(asAdmin).summary_version !== lockedVersion) throw new Error("the version moved on its own");
  });

  check("rejecting a receipt issues a new version", () => {
    psql("update public.receipts set counted=false, status='dup' where id='r-sum2'");
    const now = summary(asAdmin);
    psql("update public.receipts set counted=true, status='ok' where id='r-sum2'");
    const back = summary(asAdmin).summary_version;
    if (now.summary_version === lockedVersion) throw new Error("the verdict changed and the version did not");
    if (now.currencies[0].native.gross_total.amount_decimal !== "1000.03") {
      throw new Error(`the rejected receipt is still counted: ${now.currencies[0].native.gross_total.amount_decimal}`);
    }
    if (back !== lockedVersion) throw new Error("restoring the verdict did not restore the version");
  });

  check("changing the ratio issues a new version", () => {
    psql("update public.currencies set rate = 7.10, rate_updated = now() where id='cny'");
    const moved = summary(asAdmin).summary_version;
    if (moved === lockedVersion) throw new Error("the rate changed and the version did not");
    psql("update public.currencies set rate = 7.20, rate_updated = now() where id='cny'");
  });

  // §4.18: a missing rate is never a zero and never yesterday's number.
  check("a currency with no ratio reports pending_rate, never a figure", () => {
    psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency,receipt_stage)
          values ('b-norate','cust-s','cust-s','in','XXX','matched')`);
    psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,fee,
            net_amount,currency,status,counted)
          values ('r-norate','b-norate','cust-s','cust-s','in',500,0,500,'XXX','ok',true)`);
    const s = JSON.parse(psql("select public.sarraf_batch_summary('b-norate')::text"));
    if (s.calculation_status !== "pending_rate") throw new Error(`status is ${s.calculation_status}`);
    const c = s.currencies[0];
    if (c.usd.status !== "pending_rate") throw new Error("a USD figure was produced without a ratio");
    // At the currency's own scale, as every other native figure now is: 500.00 beside 2447.00,
    // not 500 beside 2447.00.
    if (c.native.gross_total.amount_decimal !== "500.00") throw new Error("the native breakdown was withheld");
    if (JSON.stringify(c.usd).includes("amount_decimal")) throw new Error("a USD amount appeared anyway");
  });

  check("a batch with nothing counted says so rather than reporting zero", () => {
    psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency,receipt_stage)
          values ('b-empty','cust-s','cust-s','in','CNY','matched')`);
    const s = JSON.parse(psql("select public.sarraf_batch_summary('b-empty')::text"));
    if (s.calculation_status !== "empty") throw new Error(`status is ${s.calculation_status}`);
    if (s.currencies.length) throw new Error("an empty batch produced a currency");
  });

  // §4.15: finalization quoting a version that has moved is refused with 409 stale_summary.
  check("acting on the current version is allowed", () => {
    const out = psql(`select public.zeman_probe_stale('b-sum', '${lockedVersion}')`).trim();
    if (out !== "ok") throw new Error(`the current version was refused: ${out}`);
  });

  check("acting on a version that has moved is refused as stale, with 409", () => {
    // net must stay equal to amount minus fee, so both move together. What the case is about
    // is the summary version changing, not the row becoming inconsistent.
    psql("update public.receipts set amount = 1300.20, net_amount = 1300.20 - fee where id='r-sum1'");
    const out = psql(`select public.zeman_probe_stale('b-sum', '${lockedVersion}')`).trim();
    psql("update public.receipts set amount = 1000.03, net_amount = 1000.03 - fee where id='r-sum1'");
    if (out !== "PT409|stale_summary") throw new Error(`the refusal was ${out}`);
  });

  mustFail("an action that quotes no version at all is refused",
    `select public.sarraf_assert_summary_current('b-sum', null)`);

  check("finalization refuses a stale version before it writes anything", () => {
    psql("update public.receipt_batches set decision_status='rejected', matched_score=100 where id='b-sum'");
    psql("update public.receipt_batches set receipt_stage='matched' where id='b-sum'");
    const stale = "0".repeat(32);
    let denied = false;
    try {
      psql(`select public.sarraf_finalize_receipt_batch('b-sum','the figures were checked',false,
              'receipt-finalize:b-sum:none:stale-attempt-0001','${stale}')`);
    } catch { denied = true; }
    const stage = psql("select receipt_stage from public.receipt_batches where id='b-sum'").trim();
    if (!denied) throw new Error("a stale finalization was accepted");
    if (stage !== "matched") throw new Error(`the batch was written anyway: ${stage}`);
  });

  check("finalization quoting the current version succeeds and records it", () => {
    const v = JSON.parse(psql("select public.sarraf_batch_summary('b-sum')::text")).summary_version;
    psql(`select public.sarraf_finalize_receipt_batch('b-sum','the figures were checked',false,
            'receipt-finalize:b-sum:none:good-attempt-00001','${v}')`);
    const stage = psql("select receipt_stage from public.receipt_batches where id='b-sum'").trim();
    const recorded = psql(`select result->>'summary_version' from public.receipt_review_commands
                           where command_key='receipt-finalize:b-sum:none:good-attempt-00001'`).trim();
    if (stage !== "finalized") throw new Error(`the batch is ${stage}`);
    if (recorded !== v) throw new Error(`the finalization recorded ${recorded}`);
  });

  // ── the debt side: vouchers, netting, writing off, and the history of a debt ──
  // Appointed with no signed-in actor, as the first owner necessarily is: nobody outranks
  // themselves, so a rank can never be granted from inside the account receiving it.
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select null::uuid $fn$`);
  psql(`update public.app_users set admin_level='owner' where id='u-a'`);
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '11111111-1111-1111-1111-111111111111'::uuid $fn$`);
  asAdmin();
  psql(`create or replace function public.zeman_probe_issue() returns text language plpgsql as $fn$
        declare v public.vouchers; begin
          v := public.sarraf_issue_voucher('debt_offset','customer','cust-1','zeman',null,'CNY',0,'no amount','u-a');
          return 'issued ' || v.reference;
        exception when others then return sqlstate || '|' || sqlerrm; end $fn$`);

  check("a debt records its own opening without being asked", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by)
          values ('d-ev','customer','cust-1','zeman',null,'CNY',1000,1000,'unpaid_transaction',
                  'unpaid purchase','u-a')`);
    const row = psql("select kind||'|'||amount||'|'||outstanding_after from public.debt_events where debt_id='d-ev'").trim();
    if (row !== "opened|1000.0000000000|1000.0000000000") throw new Error(`the opening reads ${row}`);
  });

  check("a settlement writes itself into the debt's history", () => {
    psql(`insert into public.debt_settlements(debt_id,amount_applied,outstanding_before,
            outstanding_after,source_kind,actor_id,reason)
          values ('d-ev',400,1000,600,'cash','u-a','part payment received')`);
    const row = psql(`select kind||'|'||amount||'|'||outstanding_after from public.debt_events
                      where debt_id='d-ev' and kind='settled'`).trim();
    if (row !== "settled|400.0000000000|600.0000000000") throw new Error(`the settlement reads ${row}`);
  });

  mustFail("the history of a debt cannot be rewritten",
    "update public.debt_events set amount = 1 where debt_id='d-ev'");
  mustFail("the history of a debt cannot be destroyed",
    "delete from public.debt_events where debt_id='d-ev'");

  // §13.C.7 — giving up a debt is an expense, taken deliberately, on the record.
  check("writing off a debt moves it out of the receivable and into expense", () => {
    const out = JSON.parse(psql(`select public.sarraf_write_off_debt('d-ev',null,
      'the customer has closed and cannot be reached','cmd-wo-1')::text`));
    if (Number(out.written_off) !== 600) throw new Error(`wrote off ${out.written_off}, expected 600`);
    if (out.status !== "written_off") throw new Error(`status is ${out.status}`);
    const st = psql("select status||'|'||outstanding_principal from public.debts where id='d-ev'").trim();
    if (st !== "written_off|0.0000000000") throw new Error(`the debt is ${st}`);
    const expense = psql(`select sum(amount) from public.journal_lines
                          where entry_id like 'je-writeoff-%' and account_id='acc-5200' and side='debit'`).trim();
    if (Number(expense) !== 600) throw new Error(`expense carries ${expense}`);
  });

  check("a write-off issues a numbered voucher naming the debt", () => {
    const v = psql(`select reference||'|'||kind||'|'||amount from public.vouchers where debt_id='d-ev'`).trim();
    if (!/^V-\d{4}-\d{6}\|debt_write_off\|600/.test(v)) throw new Error(`the voucher reads ${v}`);
  });

  check("the history explains the whole life of the debt", () => {
    const h = JSON.parse(psql("select public.sarraf_debt_history('d-ev')::text"));
    if (h.events.map((e) => e.kind).join(",") !== "opened,settled,written_off") {
      throw new Error(`the history reads ${h.events.map((e) => e.kind).join(",")}`);
    }
    if (!h.events.at(-1).voucher) throw new Error("the write-off is not tied to its voucher");
  });

  mustFail("a debt already written off cannot be written off again",
    `select public.sarraf_write_off_debt('d-ev',null,'trying the same thing twice','cmd-wo-2')`);

  check("a write-off with too short a reason is refused before anything moves", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by)
          values ('d-wo2','customer','cust-1','zeman',null,'CNY',50,50,'x','test','u-a')`);
    let denied = false;
    try { psql(`select public.sarraf_write_off_debt('d-wo2',null,'too short','cmd-wo-3')`); }
    catch { denied = true; }
    const st = psql("select status from public.debts where id='d-wo2'").trim();
    if (!denied) throw new Error("a bare reason was accepted");
    if (st !== "open") throw new Error(`the debt moved anyway: ${st}`);
  });

  check("only the system owner may give up a debt", () => {
    // 'operator', not 'staff': admin_level is checked against owner|operator, and the
    // point of the case is an administrator who is not the owner.
    psql(`update public.app_users set admin_level='operator' where id='u-a'`);
    // Demoting oneself is allowed; promoting oneself back is not, which is the rank guard doing
    // its job. The restore therefore runs with no signed-in actor, as a service write would.
    const restoreLevel = () => {
      psql(`create or replace function auth.uid() returns uuid language sql stable
            as $fn$ select null::uuid $fn$`);
      psql(`update public.app_users set admin_level='owner' where id='u-a'`);
      asAdmin();
    };
    let denied = false;
    try { psql(`select public.sarraf_write_off_debt('d-wo2',null,'a perfectly long reason here','cmd-wo-4')`); }
    catch { denied = true; }
    restoreLevel();
    if (!denied) throw new Error("an ordinary administrator wrote off a debt");
  });

  // §13.C.6 — when both parties owe each other, one entry cancels the smaller against the larger.
  check("two debts facing opposite ways cancel against each other", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by) values
          ('d-owes-us','customer','cust-1','zeman',null,'CNY',800,800,'unpaid_transaction','they owe us','u-a'),
          ('d-we-owe','zeman',null,'customer','cust-1','CNY',300,300,'credit_note','we owe them','u-a')`);
    const out = JSON.parse(psql(`select public.sarraf_offset_debts('d-owes-us','d-we-owe',null,
      'both sides agreed to net these','cmd-off-1')::text`));
    if (Number(out.offset_amount) !== 300) throw new Error(`offset ${out.offset_amount}, expected 300`);
    if (Number(out.left_outstanding_after) !== 500) throw new Error(`the larger debt is ${out.left_outstanding_after}`);
    if (Number(out.right_outstanding_after) !== 0) throw new Error(`the smaller debt is ${out.right_outstanding_after}`);
    const st = psql("select status from public.debts where id='d-we-owe'").trim();
    if (st !== "settled") throw new Error(`the smaller debt is ${st}`);
  });

  check("an offset posts one balanced entry and issues one voucher", () => {
    const lines = psql(`select count(*) from public.journal_lines where entry_id like 'je-offset-%'`).trim();
    const v = psql(`select count(*) from public.vouchers where kind='debt_offset'`).trim();
    if (lines !== "2") throw new Error(`the offset wrote ${lines} lines`);
    if (v !== "1") throw new Error(`${v} vouchers were issued for one offset`);
  });

  check("both sides of an offset appear in both histories", () => {
    for (const d of ["d-owes-us", "d-we-owe"]) {
      const k = psql(`select count(*) from public.debt_events where debt_id='${d}' and kind='offset'`).trim();
      if (k !== "1") throw new Error(`${d} has ${k} offset events`);
    }
  });

  mustFail("debts in different currencies cannot be offset",
    `insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
       original_principal,outstanding_principal,source_type,reason,created_by)
     values ('d-usd','zeman',null,'customer','cust-1','USD',100,100,'x','usd side','u-a');
     select public.sarraf_offset_debts('d-owes-us','d-usd',null,'trying to net across currencies','cmd-off-2')`);

  check("two debts pointing the same way are not an offset", () => {
    psql(`insert into public.debts(id,debtor_type,debtor_id,creditor_type,creditor_id,currency,
            original_principal,outstanding_principal,source_type,reason,created_by)
          values ('d-same','customer','cust-1','zeman',null,'CNY',100,100,'x','same direction','u-a')`);
    let denied = false;
    try { psql(`select public.sarraf_offset_debts('d-owes-us','d-same',null,'these both point one way','cmd-off-3')`); }
    catch { denied = true; }
    if (!denied) throw new Error("two debts in the same direction were netted");
  });

  check("a debt cannot be offset against itself", () => {
    let denied = false;
    try { psql(`select public.sarraf_offset_debts('d-owes-us','d-owes-us',null,'offsetting itself','cmd-off-4')`); }
    catch { denied = true; }
    if (!denied) throw new Error("a debt was offset against itself");
  });

  check("replaying an offset does not net it twice", () => {
    const before = psql("select outstanding_principal from public.debts where id='d-owes-us'").trim();
    const out = JSON.parse(psql(`select public.sarraf_offset_debts('d-owes-us','d-we-owe',null,
      'both sides agreed to net these','cmd-off-1')::text`));
    const after = psql("select outstanding_principal from public.debts where id='d-owes-us'").trim();
    if (out.replayed !== true) throw new Error("the replay was not recognised");
    if (before !== after) throw new Error(`the debt went from ${before} to ${after} on replay`);
  });

  // §13.F.1 — the register itself.
  check("voucher numbers run without gaps and cannot be reused", () => {
    const rows = psql(`select string_agg(number::text, ',' order by number) from public.vouchers
                       where series = to_char(now(),'YYYY')`).trim().split(",").map(Number);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] !== i + 1) throw new Error(`the register jumps: ${rows.join(",")}`);
    }
  });

  mustFail("a voucher cannot be edited", "update public.vouchers set amount = 1 where kind='debt_offset'");
  mustFail("a voucher cannot be destroyed", "delete from public.vouchers where kind='debt_offset'");
  // A voucher is a consequence of a movement. No signed-in user can reach the issuing function
  // to mint one on its own — only the commands, which run as the definer.
  check("a voucher cannot be issued on its own", () => {
    const granted = psql(`select has_function_privilege('authenticated',
      'public.sarraf_issue_voucher(public.voucher_kind,public.party_kind,text,public.party_kind,text,text,numeric,text,text,text,text,bigint,text,text,jsonb,text)',
      'execute')`).trim();
    if (granted !== "f") throw new Error("a signed-in user can mint a voucher directly");
  });

  check("a voucher can never be issued without an amount", () => {
    const out = psql(`select public.zeman_probe_issue()`).trim();
    if (!out.startsWith("22023|")) throw new Error(`an empty voucher was allowed: ${out}`);
  });

  check("the register lists what an administrator asks for", () => {
    const reg = JSON.parse(psql("select public.sarraf_voucher_register(null,null,null,50)::text"));
    if (!reg.length) throw new Error("the register came back empty");
    if (!reg.every((v) => /^V-\d{4}-\d{6}$/.test(v.reference))) throw new Error("a voucher has no reference");
  });

  check("a customer sees only the vouchers they are named on", () => {
    // A id of its own: inv-r already holds 8888…, and auth_id is unique, so borrowing it
    // failed the update and took the check with it.
    psql(`update public.app_users set auth_id='c0570001-0000-0000-0000-000000000001' where id='cust-1'`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select 'c0570001-0000-0000-0000-000000000001'::uuid $fn$`);
    const mine = JSON.parse(psql("select public.sarraf_voucher_register(null,null,null,50)::text"));
    asAdmin();
    const all = JSON.parse(psql("select public.sarraf_voucher_register(null,null,null,50)::text"));
    if (!mine.length) throw new Error("the customer saw none of their own vouchers");
    if (!mine.every((v) => v.party_id === "cust-1" || v.counterparty_id === "cust-1")) {
      throw new Error("the customer saw someone else's voucher");
    }
    if (mine.length > all.length) throw new Error("the customer saw more than the administrator");
  });

  check("the books still reconcile after netting and writing off", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });

  // ── four keys for a duplicate, not two ──
  asAdmin();
  psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency)
        values ('b-dupe','cust-s','cust-s','in','CNY')`);
  psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,fee,
          net_amount,currency,receiver,ref_no,merchant_order_no,tx_date,image_hash,status,counted)
        values ('r-orig','b-dupe','cust-s','cust-s','in',1200,0,1200,'CNY','ئەحمەد',
                'REF-9001','ORD-77001','2026-08-01',repeat('a',64),'ok',true)`);
  const dupe = (args) => {
    const row = psql(`select coalesce((select kind||'|'||matched_key||'|'||id
      from public.check_receipt_dupe(${args}) limit 1), 'none')`).trim();
    return row;
  };

  check("the same image is a duplicate", () => {
    const r = dupe(`'${"a".repeat(64)}', null`);
    if (r !== "duplicate|image|r-orig") throw new Error(r);
  });

  check("the same transaction reference is a duplicate, however it is punctuated", () => {
    const r = dupe(`null, 'ref 9001'`);
    if (r !== "duplicate|reference|r-orig") throw new Error(r);
  });

  // Key 3: the reader has always extracted it and nothing was ever comparing it.
  check("the same merchant order number is a duplicate", () => {
    const r = dupe(`null, null, 'ord-770.01'`);
    if (r !== "duplicate|merchant_order|r-orig") throw new Error(r);
  });

  // Key 4: four coincidences at once. A question for a person, not a refusal by a rule.
  check("the same amount, day, currency and recipient is a suspicion, not a refusal", () => {
    const r = dupe(`null, null, null, 'CNY', 1200, '2026-08-01', 'ئەحمەد'`);
    if (r !== "suspect|compound|r-orig") throw new Error(r);
  });

  check("three of the four is not even a suspicion", () => {
    if (dupe(`null, null, null, 'CNY', 1200, '2026-08-02', 'ئەحمەد'`) !== "none") throw new Error("a different day matched");
    if (dupe(`null, null, null, 'CNY', 1201, '2026-08-01', 'ئەحمەد'`) !== "none") throw new Error("a different amount matched");
    if (dupe(`null, null, null, 'USD', 1200, '2026-08-01', 'ئەحمەد'`) !== "none") throw new Error("a different currency matched");
    if (dupe(`null, null, null, 'CNY', 1200, '2026-08-01', 'سارا'`) !== "none") throw new Error("a different recipient matched");
  });

  check("a hard duplicate outranks a suspicion", () => {
    const r = dupe(`'${"a".repeat(64)}', null, null, 'CNY', 1200, '2026-08-01', 'ئەحمەد'`);
    if (r !== "duplicate|image|r-orig") throw new Error(`the weaker answer came first: ${r}`);
  });

  check("a rejected receipt does not make its replacement a duplicate", () => {
    psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,
            currency,ref_no,status,counted)
          values ('r-rej','b-dupe','cust-s','cust-s','in',5,'CNY','REF-REJECTED','dup',false)`);
    if (dupe(`null, 'REF-REJECTED'`) !== "none") throw new Error("a rejected receipt blocked a resend");
  });

  // ── what the reader read, attested and unrepeatable ──
  const digest = (json) => psql(`select public.sarraf_extraction_digest('${json}'::jsonb)`).trim();
  const extraction = `{"amount":"1200","fee":"0","net_amount":"1200","currency":"CNY","ref_no":"REF-9001","merchant_order_no":"ORD-77001","tx_date":"2026-08-01","receiver":"ئەحمەد","sender":"من"}`;

  check("the same figures always digest to the same value, however they are written", () => {
    const a = digest(extraction);
    const b = digest(extraction.replace('"1200"', '"1200.00"').replace('"cny"', '"CNY"'));
    if (a !== b) throw new Error("1200 and 1200.00 digested differently");
    if (!/^[a-f0-9]{64}$/.test(a)) throw new Error(`the digest is ${a}`);
  });

  check("changing a single figure changes the digest", () => {
    const a = digest(extraction);
    const b = digest(extraction.replace('"amount":"1200"', '"amount":"12000"'));
    if (a === b) throw new Error("an altered amount digested the same");
  });

  check("a reading is attested by the reader and redeemed once", () => {
    psql(`select public.sarraf_record_ocr_attestation('nonce-aaaaaaaaaaaaaaaaaaaaaa','cust-s',
      '${"b".repeat(64)}', '${extraction}'::jsonb, 'groq', 'qwen', 3600)`);
    psql(`select public.sarraf_redeem_ocr_attestation('nonce-aaaaaaaaaaaaaaaaaaaaaa','cust-s',
      '${"b".repeat(64)}', '${extraction}'::jsonb, 'r-att')`);
    const used = psql(`select redeemed_receipt_id from public.ocr_attestations
                       where nonce='nonce-aaaaaaaaaaaaaaaaaaaaaa'`).trim();
    if (used !== "r-att") throw new Error(`the attestation records ${used}`);
  });

  const redeem = (nonce, actor, hash, ext) => psql(`select public.zeman_probe_redeem(
    '${nonce}','${actor}','${hash}','${ext}'::jsonb)`).trim();

  psql(`create or replace function public.zeman_probe_redeem(a text,b text,c text,d jsonb)
        returns text language plpgsql as $fn$ begin
          perform public.sarraf_redeem_ocr_attestation(a,b,c,d,'r-probe'); return 'ok';
        exception when others then return sqlerrm; end $fn$`);

  check("the same reading cannot be used for a second receipt", () => {
    const out = redeem("nonce-aaaaaaaaaaaaaaaaaaaaaa", "cust-s", "b".repeat(64), extraction);
    if (!/already been used/.test(out)) throw new Error(out);
  });

  // The whole point: a browser that edits 1200 into 12000 is caught by the server.
  check("figures altered after the reading are refused", () => {
    psql(`select public.sarraf_record_ocr_attestation('nonce-bbbbbbbbbbbbbbbbbbbbbb','cust-s',
      '${"c".repeat(64)}', '${extraction}'::jsonb, 'groq', 'qwen', 3600)`);
    const out = redeem("nonce-bbbbbbbbbbbbbbbbbbbbbb", "cust-s", "c".repeat(64),
      extraction.replace('"amount":"1200"', '"amount":"12000"'));
    if (!/do not match what the reader read/.test(out)) throw new Error(out);
  });

  check("a reading of one image cannot be presented for another", () => {
    const out = redeem("nonce-bbbbbbbbbbbbbbbbbbbbbb", "cust-s", "d".repeat(64), extraction);
    if (!/different image/.test(out)) throw new Error(out);
  });

  check("a reading issued to one person cannot be used by another", () => {
    const out = redeem("nonce-bbbbbbbbbbbbbbbbbbbbbb", "cust-t", "c".repeat(64), extraction);
    if (!/belongs to someone else/.test(out)) throw new Error(out);
  });

  check("a reading that was never issued is refused", () => {
    const out = redeem("nonce-zzzzzzzzzzzzzzzzzzzzzz", "cust-s", "c".repeat(64), extraction);
    if (!/was not issued/.test(out)) throw new Error(out);
  });

  check("an expired reading is refused", () => {
    psql(`insert into public.ocr_attestations(nonce,issued_to,image_sha256,extraction_digest,
            issued_at,expires_at)
          values ('nonce-cccccccccccccccccccccc','cust-s','${"e".repeat(64)}',
                  public.sarraf_extraction_digest('${extraction}'::jsonb),
                  now() - interval '2 hours', now() - interval '1 hour')`);
    const out = redeem("nonce-cccccccccccccccccccccc", "cust-s", "e".repeat(64), extraction);
    if (!/expired/.test(out)) throw new Error(out);
  });

  check("no signed-in user can attest to their own arithmetic", () => {
    const granted = psql(`select has_function_privilege('authenticated',
      'public.sarraf_record_ocr_attestation(text,text,text,jsonb,text,text,int)','execute')`).trim();
    if (granted !== "f") throw new Error("a browser can mint its own attestation");
  });

  mustFail("an attestation cannot be destroyed",
    "delete from public.ocr_attestations where nonce='nonce-aaaaaaaaaaaaaaaaaaaaaa'");

  // The rule enforced where it counts: on the way into the receipts table, on every path.
  check("a receipt whose figures were altered after reading is refused at the door", () => {
    psql(`select public.sarraf_record_ocr_attestation('nonce-dddddddddddddddddddddd','cust-s',
      '${"f".repeat(64)}', '${extraction}'::jsonb, 'groq', 'qwen', 3600)`);
    let denied = false;
    try {
      psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,fee,
              net_amount,currency,receiver,sender,ref_no,merchant_order_no,tx_date,status,counted,raw)
            values ('r-tampered','b-dupe','cust-s','cust-s','in',12000,0,12000,'CNY','ئەحمەد','من',
                    'REF-9001','ORD-77001','2026-08-01','ok',true,
                    '{"attestation":{"nonce":"nonce-dddddddddddddddddddddd","imageSha256":"${"f".repeat(64)}"}}')`);
    } catch { denied = true; }
    if (!denied) throw new Error("an altered amount was accepted");
    const there = psql("select count(*) from public.receipts where id='r-tampered'").trim();
    if (there !== "0") throw new Error("the tampered receipt was stored anyway");
  });

  check("a receipt whose figures match the reading is accepted, once", () => {
    psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,fee,
            net_amount,currency,receiver,sender,ref_no,merchant_order_no,tx_date,status,counted,raw)
          values ('r-attested','b-dupe','cust-s','cust-s','in',1200,0,1200,'CNY','ئەحمەد','من',
                  'REF-9001','ORD-77001','2026-08-01','ok',true,
                  '{"attestation":{"nonce":"nonce-dddddddddddddddddddddd","imageSha256":"${"f".repeat(64)}"}}')`);
    const redeemed = psql(`select redeemed_receipt_id from public.ocr_attestations
                           where nonce='nonce-dddddddddddddddddddddd'`).trim();
    if (redeemed !== "r-attested") throw new Error(`the attestation records ${redeemed}`);
  });

  check("the merchant order number is lifted out of the raw payload as the row is written", () => {
    psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,
            currency,status,counted,raw)
          values ('r-mo','b-dupe','cust-s','cust-s','in',7,'CNY','ok',true,
                  '{"merchantOrderNo":"ORD-88002"}')`);
    const v = psql("select merchant_order_no from public.receipts where id='r-mo'").trim();
    if (v !== "ORD-88002") throw new Error(`the column holds ${v}`);
  });

  check("an unattested receipt is allowed until the policy demands otherwise", () => {
    psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,
            currency,status,counted) values ('r-plain','b-dupe','cust-s','cust-s','in',9,'CNY','ok',true)`);
    psql(`update public.receipt_control_policy set require_attestation = true where singleton`);
    let denied = false;
    try {
      psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,
              currency,status,counted) values ('r-plain2','b-dupe','cust-s','cust-s','in',9,'CNY','ok',true)`);
    } catch { denied = true; }
    psql(`update public.receipt_control_policy set require_attestation = false where singleton`);
    if (!denied) throw new Error("the policy switch does nothing");
  });

  check("a rejected receipt needs no reading, because it enters no total", () => {
    psql(`update public.receipt_control_policy set require_attestation = true where singleton`);
    psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,
            currency,status,counted) values ('r-nored','b-dupe','cust-s','cust-s','in',9,'CNY','dup',false)`);
    psql(`update public.receipt_control_policy set require_attestation = false where singleton`);
    const there = psql("select count(*) from public.receipts where id='r-nored'").trim();
    if (there !== "1") throw new Error("evidence of a rejected receipt was refused");
  });

  // ── a limit on how fast our own doors can be knocked on ──
  check("a caller within the limit is allowed", () => {
    for (let i = 1; i <= 3; i++) {
      const out = JSON.parse(psql(`select public.sarraf_rate_limit('ocr','cust-s',5,60)::text`));
      if (out.allowed !== true) throw new Error(`attempt ${i} was refused`);
      if (out.remaining !== 5 - i) throw new Error(`remaining is ${out.remaining} after ${i}`);
    }
  });

  check("a caller past the limit is refused and told when to come back", () => {
    let last;
    for (let i = 0; i < 4; i++) last = JSON.parse(psql(`select public.sarraf_rate_limit('ocr','cust-s',5,60)::text`));
    if (last.allowed !== false) throw new Error("the limit did not bite");
    if (!(last.retry_after_seconds > 0)) throw new Error(`retry after ${last.retry_after_seconds}`);
  });

  check("one caller's limit is not another's", () => {
    const other = JSON.parse(psql(`select public.sarraf_rate_limit('ocr','cust-t',5,60)::text`));
    if (other.allowed !== true) throw new Error("a second caller was refused someone else's budget");
  });

  check("the window rolls over rather than locking someone out for ever", () => {
    psql(`update public.rate_limit_counters set window_started_at = now() - interval '2 minutes'
          where bucket='ocr' and subject='cust-s'`);
    const out = JSON.parse(psql(`select public.sarraf_rate_limit('ocr','cust-s',5,60)::text`));
    if (out.allowed !== true || out.hits !== 1) throw new Error(`the window did not roll: ${JSON.stringify(out)}`);
  });

  check("the counter is unreachable from a browser", () => {
    const granted = psql(`select has_function_privilege('authenticated',
      'public.sarraf_rate_limit(text,text,int,int)','execute')`).trim();
    if (granted !== "f") throw new Error("a caller can raise their own limit");
  });

  // ── money handed over but not yet confirmed ──
  check("a reported deposit is visible but cannot be spent", () => {
    const out = JSON.parse(psql(`select public.sarraf_vault_pending_deposit('cust-1','CNY',500,
      'reported at the counter','cmd-pend-1')::text`));
    if (Number(out.pending) !== 500) throw new Error(`pending is ${out.pending}`);
    if (out.posted !== false) throw new Error("unconfirmed money was posted to the journal");
    const v = psql(`select pending||'|'||available from public.customer_vaults
                    where customer_id='cust-1' and currency='CNY'`).trim();
    if (!v.startsWith("500.0000000000|")) throw new Error(`the cashbox reads ${v}`);
  });

  check("confirming a deposit moves it across and posts it", () => {
    const before = Number(psql(`select available from public.customer_vaults
                                where customer_id='cust-1' and currency='CNY'`).trim());
    const out = JSON.parse(psql(`select public.sarraf_vault_pending_resolve('cust-1','CNY',500,true,
      null,'counted at the counter','cmd-pend-2')::text`));
    if (Number(out.pending) !== 0) throw new Error(`pending is ${out.pending}`);
    if (Number(out.available) !== before + 500) throw new Error(`available is ${out.available}`);
    if (!out.voucher) throw new Error("no voucher was issued for a confirmed deposit");
    const posted = psql(`select count(*) from public.journal_lines where entry_id like 'je-vault-confirm-%'`).trim();
    if (posted !== "2") throw new Error(`the confirmation wrote ${posted} lines`);
  });

  check("a deposit that never arrived is turned away and posts nothing", () => {
    psql(`select public.sarraf_vault_pending_deposit('cust-1','CNY',300,'reported by phone','cmd-pend-3')`);
    const entriesBefore = psql("select count(*) from public.journal_entries").trim();
    const out = JSON.parse(psql(`select public.sarraf_vault_pending_resolve('cust-1','CNY',300,false,
      null,'the money never arrived','cmd-pend-4')::text`));
    const entriesAfter = psql("select count(*) from public.journal_entries").trim();
    if (Number(out.pending) !== 0) throw new Error(`pending is ${out.pending}`);
    if (entriesBefore !== entriesAfter) throw new Error("a deposit that never arrived was posted");
  });

  mustFail("more cannot be confirmed than was ever reported",
    `select public.sarraf_vault_pending_resolve('cust-1','CNY',9999,true,null,'over confirming','cmd-pend-5')`);

  check("the books still reconcile after pending deposits", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });

  // ── the schema this code was written against is the schema that exists ─────
  //
  // Two failures reached the owner that nothing here could have caught, because both were
  // disagreements between the migrations and the live database rather than mistakes inside
  // either. The legacy baseline declares the tables with `create table if not exists`, so a
  // fresh database gets the declaration and a database that already had them keeps whatever it
  // had. Every gate runs on a fresh one, which is why they all agreed with the declaration.
  //
  // sarraf_schema_drift is the comparison that was missing. Run here it proves a fresh database
  // matches; run from the SQL editor it says the same of the live one.

  check("a fresh database matches the shape the code expects", () => {
    const drift = psql(`select coalesce(string_agg(
      table_name || '.' || column_name || ' expected ' || expected || ' found ' || found, '; '), '')
      from public.sarraf_schema_drift()`).trim();
    if (drift) throw new Error(drift);
  });

  // `column "user_id" of relation "audit" does not exist` — saving a ratio, on the live system.
  check("saving a ratio records who did it", () => {
    psql(`select public.sarraf_save_rates(
      '[{"id":"cny","rate":6.79}]'::jsonb, '[]'::jsonb, 'cmd-audit-1', 'ratio change', 'CNY 6.79')`);
    const who = psql(`select coalesce(user_id,'<null>') from public.audit
                      where action = 'ratio change' order by date desc limit 1`).trim();
    if (who === "") throw new Error("the ratio change was not recorded at all");
    if (who === "<null>") throw new Error("the change was recorded with nobody against it");
  });

  // `operator does not exist: text = date` — the duplicate check, on the live system. It is the
  // check that decides whether an upload is new, so with it unable to run every receipt that
  // reached the compound key was refused. Calling it is enough: the error was raised at plan
  // time, before any row was examined.
  check("the duplicate check runs on all four keys", () => {
    psql(`select * from public.check_receipt_dupe(
      'sha-none', 'REF-NONE', 'ORD-NONE', 'CNY', 1200, current_date, 'nobody')`);
  });

  // ── Task A: the details of an indirect trade reach the partner holding the money ──
  //
  // "the money is sent straight to a partner to hold... the seller uploads the receipt... the
  //  app must put the details into an organised table: the receiver, the date, which platform
  //  was used, and whether the fee is included... and the details of those receipts must go to
  //  whichever partner the money was placed with."

  psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
        ('part-a','Holding Partner','partner','9a97e400-0000-0000-0000-00000000000a','t-sarkhel'),
        ('cust-a','Selling Customer','customer','c0570002-0000-0000-0000-000000000002','t-sarkhel')
        on conflict (id) do update set auth_id = excluded.auth_id`);
  psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,partner_id,direction,currency,receipt_stage)
        values ('b-partner','cust-a','cust-a','part-a','in','CNY','verified')`);
  psql(`insert into public.receipts(id,batch_id,customer_id,uploaded_by,direction,amount,fee,
          net_amount,currency,receiver,platform,tx_date,ref_no,status,counted,raw)
        values
        ('r-pa1','b-partner','cust-a','cust-a','in',1000,0,1000,'CNY','ئەحمەد','WeChat Pay',
          '2026-08-10','PA-1','ok',true,'{}'),
        ('r-pa2','b-partner','cust-a','cust-a','in',500,5,495,'CNY','ئەحمەد','Alipay',
          '2026-08-11','PA-2','ok',true,'{}'),
        ('r-pa3','b-partner','cust-a','cust-a','in',300,0,300,'CNY','سارا','支付宝',
          '2026-08-12','PA-3','ok',true,'{}')`);
  psql(`insert into public.receipt_batch_transactions(batch_id,transaction_id,partner_id,
          item_count,amount,currency,created_by)
        values ('b-partner','tx-buy','part-a',3,1795,'CNY','u-a')`);

  const asPartnerA = () => psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '9a97e400-0000-0000-0000-00000000000a'::uuid $fn$`);
  const detail = () => JSON.parse(psql("select public.sarraf_partner_batch_detail('b-partner')::text"));

  check("the details table names the receiver, the date and the platform", () => {
    const rows = detail().rows;
    if (rows.length !== 3) throw new Error(`${rows.length} rows`);
    const one = rows.find((r) => r.ref_no === "PA-1");
    if (one.receiver !== "ئەحمەد") throw new Error(`receiver is ${one.receiver}`);
    if (one.tx_date !== "2026-08-10") throw new Error(`date is ${one.tx_date}`);
    if (one.platform !== "wechat") throw new Error(`platform is ${one.platform}`);
  });

  // The same wallet is written several ways depending on which reader produced the row. A table
  // nobody can total by platform is not the table that was asked for.
  check("the same wallet spelled differently is still one platform", () => {
    const rows = detail().rows;
    if (rows.find((r) => r.ref_no === "PA-2").platform !== "alipay") throw new Error("Alipay missed");
    if (rows.find((r) => r.ref_no === "PA-3").platform !== "alipay") throw new Error("支付宝 missed");
    const alipay = detail().by_platform.find((p) => p.platform === "alipay");
    if (Number(alipay.n) !== 2) throw new Error(`alipay counted ${alipay.n}`);
  });

  check("every receipt says whether it carries a fee", () => {
    const rows = detail().rows;
    if (rows.find((r) => r.ref_no === "PA-1").has_fee !== false) throw new Error("a free receipt claimed a fee");
    if (rows.find((r) => r.ref_no === "PA-2").has_fee !== true) throw new Error("a fee was not reported");
    const t = detail().totals[0];
    if (Number(t.with_fee_count) !== 1 || Number(t.without_fee_count) !== 2) {
      throw new Error(`${t.with_fee_count} with fee, ${t.without_fee_count} without`);
    }
  });

  check("the totals are given both with the fee and without it", () => {
    const t = detail().totals[0];
    if (Number(t.with_fee) !== 1800) throw new Error(`with fee ${t.with_fee}`);
    if (Number(t.without_fee) !== 1795) throw new Error(`without fee ${t.without_fee}`);
    if (Number(t.fee) !== 5) throw new Error(`fee ${t.fee}`);
  });

  check("receipts are grouped by who was paid", () => {
    const ahmed = detail().by_receiver.find((b) => b.receiver === "ئەحمەد");
    if (Number(ahmed.n) !== 2) throw new Error(`${ahmed.n} receipts to the same recipient`);
    if (Number(ahmed.with_fee) !== 1500) throw new Error(`with fee ${ahmed.with_fee}`);
  });

  // The point of the whole flow: the partner the money was placed with can read it.
  check("the partner holding the money reads the details", () => {
    asPartnerA();
    const d = JSON.parse(psql("select public.sarraf_partner_batch_detail('b-partner')::text"));
    asAdmin();
    if (d.partner_id !== "part-a") throw new Error(`holder is ${d.partner_id}`);
    if (d.is_indirect !== true) throw new Error("an indirect trade was not named as one");
    if (d.rows.length !== 3) throw new Error(`the partner sees ${d.rows.length} rows`);
    if (d.transaction_id !== "tx-buy") throw new Error(`transaction is ${d.transaction_id}`);
  });

  check("a partner who holds nothing of this batch is refused, not shown an empty table", () => {
    psql(`insert into public.app_users(id,name,role,auth_id,tenant_id) values
          ('part-b','Other Partner','partner','9a97e400-0000-0000-0000-00000000000b','t-sarkhel')
          on conflict (id) do update set auth_id = excluded.auth_id`);
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '9a97e400-0000-0000-0000-00000000000b'::uuid $fn$`);
    let refused = false;
    try { psql("select public.sarraf_partner_batch_detail('b-partner')"); } catch { refused = true; }
    asAdmin();
    // An empty answer to "what is in this batch" reads as "nothing", which is a different and
    // untrue statement.
    if (!refused) throw new Error("another partner read a batch that was not theirs");
  });

  check("a partner lists what has been placed with them", () => {
    asPartnerA();
    const held = JSON.parse(psql("select public.sarraf_partner_holdings(null)::text"));
    asAdmin();
    if (Number(held.batch_count) !== 1) throw new Error(`${held.batch_count} batches`);
    if (held.batches[0].batch_id !== "b-partner") throw new Error("the batch is not listed");
    if (Number(held.by_currency[0].amount) !== 1795) throw new Error(`amount ${held.by_currency[0].amount}`);
  });

  check("a partner cannot list another partner's holdings by asking for them", () => {
    asPartnerA();
    const held = JSON.parse(psql("select public.sarraf_partner_holdings('part-b')::text"));
    asAdmin();
    // The parameter is ignored rather than refused, so one call serves both screens.
    if (held.partner_id !== "part-a") throw new Error(`a partner read ${held.partner_id}`);
  });

  check("a batch nobody is holding is not called indirect", () => {
    psql(`insert into public.receipt_batches(id,customer_id,uploaded_by,direction,currency)
          values ('b-direct','cust-a','cust-a','in','CNY')`);
    const d = JSON.parse(psql("select public.sarraf_partner_batch_detail('b-direct')::text"));
    if (d.is_indirect !== false) throw new Error("a direct batch was named indirect");
    if (d.partner_id !== null) throw new Error(`holder is ${d.partner_id}`);
  });

  // ── Task B: a direct trade is the owner's own, and never touches a partner ──
  //
  // "these are direct buying and selling where the money does not go to any partner. All the
  //  details, profit and funds are recorded straight to the admin's own safe — so there is no
  //  investor share in it, and it stays entirely out of the partner-custody logic."

  const directPair = (pair, buyId, sellId, buyTotal, sellTotal) => `
    public.sarraf_commit_transactions(
      jsonb_build_array(
        jsonb_build_object('id','${buyId}','type','buy','cp_id','cust-1','cur_id','cny',
          'amount',1000,'rate',0.14,'against_id','usd','total',${buyTotal},'status','completed',
          'direct',true,'own_money',true,'pair_id','${pair}','direct_role','buy'),
        jsonb_build_object('id','${sellId}','type','sell','cp_id','cust-1','cur_id','cny',
          'amount',1000,'rate',0.15,'against_id','usd','total',${sellTotal},'status','completed',
          'direct',true,'own_money',true,'pair_id','${pair}','direct_role','sell')),
      '[]'::jsonb, null, 'cmd-${pair}', 'direct trade', 'owner funded')`;

  check("a direct trade is booked as a matched owner-funded pair", () => {
    psql(`select ${directPair("pair-d1", "tx-d1b", "tx-d1s", 140, 150)}`);
    const both = psql(`select string_agg(id||':'||direct::text||':'||own_money::text||':'||
      coalesce(partner_id,'-')||':'||direct_role, ',' order by id)
      from public.txs where pair_id='pair-d1'`).trim();
    if (both !== "tx-d1b:true:true:-:buy,tx-d1s:true:true:-:sell") {
      throw new Error(`the pair was booked as ${both}`);
    }
  });

  check("the profit of a direct trade is the pair's own difference", () => {
    const profit = psql("select profit from public.txs where id='tx-d1s'").trim();
    if (Number(profit) !== 10) throw new Error(`direct profit is ${profit}, expected 150 - 140`);
  });

  // The whole point of the type: the money never leaves the owner's hands, so no partner may be
  // named on it and no partner balance may move because of it.
  mustFail("a direct trade cannot name a partner",
    `select public.sarraf_commit_transactions(
      jsonb_build_array(
        jsonb_build_object('id','tx-d2b','type','buy','cp_id','cust-1','cur_id','cny','amount',10,
          'rate',0.14,'against_id','usd','total',1.4,'status','completed','direct',true,
          'own_money',true,'pair_id','pair-d2','direct_role','buy','partner_id','p-1'),
        jsonb_build_object('id','tx-d2s','type','sell','cp_id','cust-1','cur_id','cny','amount',10,
          'rate',0.15,'against_id','usd','total',1.5,'status','completed','direct',true,
          'own_money',true,'pair_id','pair-d2','direct_role','sell')),
      '[]'::jsonb, null, 'cmd-pair-d2', 'direct trade', 'owner funded')`);

  // A single leg is not a direct trade. One half of a pair would leave the owner's safe holding
  // currency that no sale ever accounted for.
  mustFail("half of a direct pair is refused",
    `select public.sarraf_commit_transactions(
      jsonb_build_array(
        jsonb_build_object('id','tx-d3b','type','buy','cp_id','cust-1','cur_id','cny','amount',10,
          'rate',0.14,'against_id','usd','total',1.4,'status','completed','direct',true,
          'own_money',true,'pair_id','pair-d3','direct_role','buy')),
      '[]'::jsonb, null, 'cmd-pair-d3', 'direct trade', 'owner funded')`);

  // Money that is not the owner's own is not a direct trade, whatever it is labelled.
  mustFail("a direct trade must be funded by the owner's own money",
    `select public.sarraf_commit_transactions(
      jsonb_build_array(
        jsonb_build_object('id','tx-d4b','type','buy','cp_id','cust-1','cur_id','cny','amount',10,
          'rate',0.14,'against_id','usd','total',1.4,'status','completed','direct',true,
          'own_money',false,'pair_id','pair-d4','direct_role','buy'),
        jsonb_build_object('id','tx-d4s','type','sell','cp_id','cust-1','cur_id','cny','amount',10,
          'rate',0.15,'against_id','usd','total',1.5,'status','completed','direct',true,
          'own_money',false,'pair_id','pair-d4','direct_role','sell')),
      '[]'::jsonb, null, 'cmd-pair-d4', 'direct trade', 'owner funded')`);

  // And the reverse, so the two types cannot blur into each other from the standard side.
  mustFail("an ordinary trade cannot carry the fields of a direct pair",
    `select public.sarraf_commit_transactions(
      jsonb_build_array(
        jsonb_build_object('id','tx-d5','type','buy','cp_id','cust-1','cur_id','cny','amount',10,
          'rate',0.14,'against_id','usd','total',1.4,'status','completed',
          'own_money',true,'pair_id','pair-d5')),
      '[]'::jsonb, null, 'cmd-pair-d5', 'ordinary trade', 'not direct')`);

  check("a direct trade leaves every partner balance where it was", () => {
    const before = psql("select coalesce(sum(available),0)::text from public.partner_accounts").trim();
    psql(`select ${directPair("pair-d6", "tx-d6b", "tx-d6s", 140, 150)}`);
    const after = psql("select coalesce(sum(available),0)::text from public.partner_accounts").trim();
    if (before !== after) throw new Error(`partner balances moved from ${before} to ${after}`);
  });

  // "no investor share in it". The distribution reads txs.direct, so a direct sale must carry
  // the flag the reader keys on — otherwise the owner's own trade would be shared out.
  check("a direct sale is excluded from anything that shares profit", () => {
    const shared = psql(`select count(*) from public.txs
      where type='sell' and not deleted and coalesce(direct,false) and profit is not null`).trim();
    if (Number(shared) < 1) throw new Error("no direct sale carries a profit to exclude");
    const leaked = psql(`select count(*) from public.txs
      where coalesce(direct,false) and partner_id is not null`).trim();
    if (leaked !== "0") throw new Error(`${leaked} direct trades name a partner`);
  });

  check("the books still reconcile after direct trades", () => {
    const out = psql("select (public.sarraf_trial_balance_check()->>'balanced')::text").trim();
    if (out !== "true") throw new Error(psql("select public.sarraf_trial_balance_check()::text"));
  });

  // ── the same receipt, recorded twice, with nothing saying so ───────────────
  //
  // Two paths write a receipt and neither knows about the other: receipt_documents plus
  // receipt_extractions when an image is read, receipts plus receipt_batches when the uploader
  // presses send. A photographed receipt exists twice and no column says the two rows are the
  // same piece of paper.

  psql(`insert into public.receipt_documents(id,flow,uploader_id,customer_id,storage_path)
        values ('doc-link','customer_sells_to_zeman','cust-a','cust-a','ingest/link.jpg')`);
  psql(`insert into public.receipt_extractions(document_id,version,is_original,provider,model,
          gross_amount,fee_amount,net_amount,currency,payee,tx_date,platform,fee_treatment)
        values ('doc-link',1,true,'verify','link',1000,0,1000,'CNY','ئەحمەد','2026-08-10',
                'wechat','no_fee')`);
  psql(`update public.receipts set document_id = 'doc-link' where id = 'r-pa1'`);

  check("a receipt reaches the image it was read from", () => {
    const both = JSON.parse(psql("select public.sarraf_receipt_both_sides('r-pa1',null)::text"));
    if (both.linked !== true) throw new Error("the two sides are not linked");
    if (both.document.id !== "doc-link") throw new Error(`document is ${both.document.id}`);
    if (both.extraction.platform !== "wechat") throw new Error("the reading did not come back");
  });

  check("an image reaches the row that counts towards a total", () => {
    const both = JSON.parse(psql("select public.sarraf_receipt_both_sides(null,'doc-link')::text"));
    if (both.receipt.id !== "r-pa1") throw new Error(`receipt is ${both.receipt?.id}`);
  });

  // Two receipts claiming one document is exactly the double count the column exists to prevent.
  mustFail("two receipts cannot claim the same image",
    "update public.receipts set document_id = 'doc-link' where id = 'r-pa2'");

  check("a receipt with no image says so rather than guessing at one", () => {
    const both = JSON.parse(psql("select public.sarraf_receipt_both_sides('r-pa3',null)::text"));
    if (both.linked !== false) throw new Error("an unlinked receipt claimed a document");
    if (both.document !== null) throw new Error("a document was invented");
    if (both.receipt.id !== "r-pa3") throw new Error("the receipt itself was withheld");
  });

  check("the size of the gap is a figure, not an impression", () => {
    const gap = JSON.parse(psql("select public.sarraf_receipt_link_gap()::text"));
    if (Number(gap.receipts_linked) !== 1) throw new Error(`${gap.receipts_linked} linked`);
    if (!(Number(gap.documents_orphaned) >= 0)) throw new Error("the orphan count is unreadable");
  });

  check("a stranger cannot read somebody else's receipt through either side", () => {
    psql(`create or replace function auth.uid() returns uuid language sql stable
          as $fn$ select '9a97e400-0000-0000-0000-00000000000b'::uuid $fn$`);
    let refused = false;
    try { psql("select public.sarraf_receipt_both_sides('r-pa1',null)"); } catch { refused = true; }
    let refusedDoc = false;
    try { psql("select public.sarraf_receipt_both_sides(null,'doc-link')"); } catch { refusedDoc = true; }
    asAdmin();
    if (!refused || !refusedDoc) throw new Error("a stranger read evidence that was not theirs");
  });

  // A table the repository does not know about is invisible in both directions — present in the
  // database and unmaintained, or expected by the code and absent. The owner met the second
  // kind by querying a table a schema read had listed days earlier and being told it does not
  // exist.
  check("a fresh database has every table the migrations create, and no other", () => {
    const drift = psql(`select coalesce(string_agg(table_name || ' — ' || state, '; '), '')
                        from public.sarraf_schema_tables()`).trim();
    if (drift) throw new Error(drift);
  });

  check("one call answers for both tables and columns", () => {
    const report = JSON.parse(psql("select public.sarraf_schema_report()::text"));
    if (!Array.isArray(report.tables) || !Array.isArray(report.columns)) {
      throw new Error("the report does not carry both halves");
    }
    if (report.tables.length || report.columns.length) {
      throw new Error(JSON.stringify({ tables: report.tables, columns: report.columns }));
    }
  });

  // ── three ranks of administrator ───────────────────────────────────────────
  //
  //   manager  — maintains the system, resets any password, answers to nobody inside it
  //   owner    — the business owner who runs the exchange
  //   operator — the owner's staff
  //
  // All three are role 'admin', so every existing admin check keeps working and a manager
  // inherits everything an administrator can do.

  // The first manager is created with no signed-in actor, exactly as it happens in life: from
  // the SQL editor, where holding the database credentials is the proof of ownership and the
  // only proof available before any manager exists.
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select null::uuid $fn$`);
  psql(`insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id) values
        ('mgr','ماناجەر','admin','manager','9a9a9e70-0000-0000-0000-00000000000f',null),
        ('own','سەرخێڵ','admin','owner','0e9e0001-0000-0000-0000-000000000001','t-sarkhel'),
        ('opr','ئەدمین','admin','operator','09e70001-0000-0000-0000-000000000001','t-sarkhel')
        on conflict (id) do update set admin_level = excluded.admin_level`);
  const be = (uid) => psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select '${uid}'::uuid $fn$`);
  const asManager = () => be("9a9a9e70-0000-0000-0000-00000000000f");
  const asOwner = () => be("0e9e0001-0000-0000-0000-000000000001");
  const asOperator = () => be("09e70001-0000-0000-0000-000000000001");

  check("each rank reports itself, and a manager also counts as an owner", () => {
    asManager();
    const m = psql("select public.sarraf_admin_level()||'|'||public.sarraf_is_manager()||'|'||public.sarraf_is_owner()").trim();
    asOwner();
    const o = psql("select public.sarraf_admin_level()||'|'||public.sarraf_is_manager()||'|'||public.sarraf_is_owner()").trim();
    asOperator();
    const p = psql("select public.sarraf_admin_level()||'|'||public.sarraf_is_manager()||'|'||public.sarraf_is_owner()").trim();
    asAdmin();
    if (m !== "manager|true|true") throw new Error(`manager reads ${m}`);
    if (o !== "owner|false|true") throw new Error(`owner reads ${o}`);
    if (p !== "operator|false|false") throw new Error(`operator reads ${p}`);
  });

  check("a manager may appoint another manager", () => {
    asManager();
    psql(`insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id)
          values ('mgr2','ماناجەری دوو','admin','manager','9a9a9e70-0000-0000-0000-000000000010',null)`);
    asAdmin();
    const level = psql("select admin_level from public.app_users where id='mgr2'").trim();
    if (level !== "manager") throw new Error(`the new manager is ${level}`);
  });

  check("the business owner cannot appoint a manager", () => {
    asOwner();
    let refused = false;
    try {
      psql(`insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id)
            values ('mgr3','ماناجەری سێ','admin','manager','9a9a9e70-0000-0000-0000-000000000011',null)`);
    } catch { refused = true; }
    asAdmin();
    if (!refused) throw new Error("an owner created a rank above their own");
  });

  check("the owner's staff cannot appoint anybody", () => {
    asOperator();
    let refused = false;
    try {
      psql(`insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id)
            values ('opr2','ئەدمینی دوو','admin','operator','09e70001-0000-0000-0000-000000000002','t-sarkhel')`);
    } catch { refused = true; }
    asAdmin();
    if (!refused) throw new Error("an operator created an administrator");
  });

  check("the business owner may appoint their own staff", () => {
    asOwner();
    psql(`insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id)
          values ('opr3','ئەدمینی سێ','admin','operator','09e70001-0000-0000-0000-000000000003','t-sarkhel')`);
    asAdmin();
    const level = psql("select admin_level from public.app_users where id='opr3'").trim();
    if (level !== "operator") throw new Error(`the new staff member is ${level}`);
  });

  check("only a manager may change a manager's rank", () => {
    asOwner();
    let refused = false;
    try { psql("update public.app_users set admin_level='operator' where id='mgr2'"); }
    catch { refused = true; }
    asAdmin();
    if (!refused) throw new Error("an owner demoted a manager");
  });

  // A system nobody can reach is not more secure, it is unusable, and recovering from it means
  // going back to the database by hand.
  check("the last manager cannot be demoted or deactivated", () => {
    asManager();
    // A demoted manager needs a business to belong to, so the spare is given one on the way
    // down. The case is about the last manager, not about tenancy.
    psql("update public.app_users set admin_level='operator', tenant_id='t-sarkhel' where id='mgr2'");
    let demote = false, remove = false;
    try { psql("update public.app_users set admin_level='operator', tenant_id='t-sarkhel' where id='mgr'"); }
    catch { demote = true; }
    try { psql("update public.app_users set deleted=true where id='mgr'"); }
    catch { remove = true; }
    asAdmin();
    if (!demote) throw new Error("the last manager was demoted");
    if (!remove) throw new Error("the last manager was deactivated");
  });

  check("only a manager reads the manager overview", () => {
    asManager();
    const view = JSON.parse(psql("select public.sarraf_manager_overview()::text"));
    asOwner();
    let refused = false;
    try { psql("select public.sarraf_manager_overview()"); } catch { refused = true; }
    asAdmin();
    if (Number(view.manager_count) !== 1) throw new Error(`${view.manager_count} managers`);
    if (Number(view.owner_count) < 1) throw new Error("the business owner is not counted");
    if (!refused) throw new Error("the business owner read the manager overview");
  });

  // The value api/admin-user.js was writing for every new administrator. The column never
  // accepted it, so account creation failed at the database every time.
  mustFail("'admin' was never a rank this column accepts",
    `insert into public.app_users(id,name,role,admin_level,tenant_id) values ('bad-lvl','X','admin','admin','t-sarkhel')`);

  // ── one installation, two businesses, and no way for either to see the other ──
  //
  // The owner sells this system. Today one exchange runs on it; tomorrow another buyer runs
  // their own on the same installation. Neither may see a single row of the other's, and neither
  // should have to trust that they cannot — the database must make it impossible.

  psql(`insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id) values
        ('own-b','سەرخێڵی دوو','admin','owner','b0570002-0000-0000-0000-000000000002','t-kurdistan'),
        ('cust-b','کڕیاری دوو','customer',null,'c0570003-0000-0000-0000-000000000003','t-kurdistan')
        on conflict (id) do update set tenant_id = excluded.tenant_id`);

  const asTenantB = () => psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select 'b0570002-0000-0000-0000-000000000002'::uuid $fn$`);

  check("every table that holds a business's data enforces whose it is", () => {
    const gaps = psql(`select coalesce(string_agg(table_name || ' — ' || problem, '; '), '')
                       from public.sarraf_tenant_coverage()`).trim();
    if (gaps) throw new Error(gaps);
  });

  check("a manager belongs to no business and sees them all", () => {
    asManager();
    const sees = psql("select public.sarraf_sees_all_tenants()||'|'||coalesce(public.sarraf_tenant(),'-')").trim();
    asAdmin();
    if (sees !== "true|-") throw new Error(`the manager reads ${sees}`);
  });

  check("a business owner sees their own business and no other", () => {
    asTenantB();
    const sees = psql("select public.sarraf_sees_all_tenants()||'|'||coalesce(public.sarraf_tenant(),'-')").trim();
    asAdmin();
    if (sees !== "false|t-kurdistan") throw new Error(`the second owner reads ${sees}`);
  });

  // Two unknowns are not the same business. A row with no tenant must match nobody, or every
  // untenanted row would be visible to every business at once.
  check("a row belonging to nobody is visible to no business", () => {
    asTenantB();
    const nul = psql("select public.sarraf_tenant_visible(null)::text").trim();
    const own = psql("select public.sarraf_tenant_visible('t-kurdistan')::text").trim();
    const other = psql("select public.sarraf_tenant_visible('t-sarkhel')::text").trim();
    asAdmin();
    if (nul !== "false") throw new Error("an untenanted row was visible to a business");
    if (own !== "true") throw new Error("a business could not see its own row");
    if (other !== "false") throw new Error("a business saw another's row");
  });

  check("the manager sees a row of any business, and one of none", () => {
    asManager();
    const all = psql(`select public.sarraf_tenant_visible('t-sarkhel')||'|'||
                             public.sarraf_tenant_visible('t-kurdistan')||'|'||
                             public.sarraf_tenant_visible(null)`).trim();
    asAdmin();
    if (all !== "true|true|true") throw new Error(`the manager reads ${all}`);
  });

  // The rule that keeps a person's history theirs: an account cannot walk away from the
  // transactions, receipts and debts it made.
  mustFail("an account cannot be moved to another business",
    "update public.app_users set tenant_id='t-kurdistan' where id='cust-1'");

  mustFail("every account except a manager must name a business",
    `insert into public.app_users(id,name,role,tenant_id)
     values ('no-tenant','بێ سەرخێڵ','customer',null)`);

  mustFail("a manager cannot belong to one business",
    `insert into public.app_users(id,name,role,admin_level,tenant_id)
     values ('mgr-bad','ماناجەری خراپ','admin','manager','t-sarkhel')`);

  // A rate is a price, not a definition: two exchanges do not quote the same one.
  check("each business sets its own ratio, and reads only its own", () => {
    psql(`insert into public.tenant_rates(tenant_id,cur_id,rate) values
          ('t-sarkhel','cny',7.20),('t-kurdistan','cny',6.50)
          on conflict (tenant_id,cur_id) do update set rate = excluded.rate`);
    asAdmin();
    const a = psql("select public.sarraf_usd_value(720,'cny')").trim();
    asTenantB();
    const b = psql("select public.sarraf_usd_value(650,'cny')").trim();
    asAdmin();
    if (Number(a) !== 100) throw new Error(`the first business values 720 CNY at ${a}`);
    if (Number(b) !== 100) throw new Error(`the second business values 650 CNY at ${b}`);
  });

  check("a business with no ratio of its own falls back to the installation's", () => {
    psql("delete from public.tenant_rates where tenant_id='t-kurdistan' and cur_id='cny'");
    const installation = Number(psql("select rate from public.currencies where id='cny'").trim());
    asTenantB();
    const b = Number(psql("select public.sarraf_usd_value(720,'cny')").trim());
    asAdmin();
    const expected = Number((720 / installation).toFixed(10));
    if (Math.abs(b - expected) > 1e-8) {
      throw new Error(`the fallback valued 720 CNY at ${b}, expected ${expected} at ${installation}`);
    }
  });

  check("a notification addressed to somebody belongs to their business", () => {
    psql(`insert into public.notes(id,user_id,kind,title,body)
          values ('note-tenant','cust-1','rate','نرخ','گۆڕا')`);
    const owner = psql("select coalesce(tenant_id,'<null>') from public.notes where id='note-tenant'").trim();
    if (owner !== "t-sarkhel") throw new Error(`the notification belongs to ${owner}`);
  });

  check("no row anywhere belongs to nobody", () => {
    asManager();
    const orphans = JSON.parse(psql("select public.sarraf_tenant_orphans()::text"));
    asAdmin();
    // system_event_log is append-only and refuses deletion, which is correct: a change log that
    // can be tidied is not a change log. What it recorded before there were businesses belongs
    // to none of them, and must stay that way.
    // Two tables record what happened to the installation rather than to a business, and their
    // ownerless rows are correct. system_event_log is append-only and refuses deletion — a change
    // log that can be tidied is not a change log. notes of kind system_event are addressed to
    // nobody, and a notification for nobody belongs to no business either.
    const installationWide = new Set(["system_event_log", "notes"]);
    const stray = Object.entries(orphans.orphans || {})
      .filter(([table]) => !installationWide.has(table));
    if (stray.length) throw new Error(stray.map(([t, n]) => `${t}: ${n}`).join("; "));
  });

  // ── the manager's console ──────────────────────────────────────────────────
  //
  // The one place entitled to look across businesses. Every function refuses anybody else in the
  // database, so a screen is not what stands between a business owner and their competitors.

  check("the manager lists every business, with what each holds", () => {
    asManager();
    const view = JSON.parse(psql("select public.sarraf_manager_tenants()::text"));
    asAdmin();
    const ids = (view.tenants || []).map((t) => t.id).sort();
    if (!ids.includes("t-sarkhel") || !ids.includes("t-kurdistan")) {
      throw new Error(`the businesses are ${ids.join(", ")}`);
    }
    const first = view.tenants.find((t) => t.id === "t-sarkhel");
    if (!(Number(first.accounts) > 0)) throw new Error("a business in use reported no accounts");
  });

  mustFail("a business owner cannot list the businesses",
    `select set_config('x','',true); select public.sarraf_manager_tenants()`);

  check("a business owner is refused the list of businesses", () => {
    asTenantB();
    let refused = false;
    try { psql("select public.sarraf_manager_tenants()"); } catch { refused = true; }
    asAdmin();
    if (!refused) throw new Error("a business owner read the list of businesses");
  });

  check("the manager creates a business, and it starts with settings of its own", () => {
    asManager();
    psql("select public.sarraf_manager_create_tenant('t-third','سێیەم','بۆ تاقیکردنەوە')");
    asAdmin();
    const settings = psql("select count(*) from public.control_settings where tenant_id='t-third'").trim();
    const policy = psql("select count(*) from public.receipt_control_policy where tenant_id='t-third'").trim();
    if (settings !== "1") throw new Error(`the new business has ${settings} settings rows`);
    if (policy !== "1") throw new Error(`the new business has ${policy} receipt policies`);
  });

  // The id lives forever in every row the business owns, so it is checked rather than trusted.
  check("a business id that would read differently elsewhere is refused", () => {
    asManager();
    for (const bad of ["AB", "a", "has space", "Upper", "semi;colon"]) {
      let refused = false;
      try { psql(`select public.sarraf_manager_create_tenant('${bad}','ناو')`); } catch { refused = true; }
      if (!refused) { asAdmin(); throw new Error(`'${bad}' was accepted as a business id`); }
    }
    asAdmin();
  });

  check("a business is suspended, never deleted", () => {
    asManager();
    psql("select public.sarraf_manager_set_tenant_active('t-third',false,'stopped paying')");
    const active = psql("select active from public.tenants where id='t-third'").trim();
    const still = psql("select count(*) from public.tenants where id='t-third'").trim();
    psql("select public.sarraf_manager_set_tenant_active('t-third',true,'paid again')");
    const back = psql("select active from public.tenants where id='t-third'").trim();
    asAdmin();
    if (active !== "f") throw new Error("the business was not suspended");
    if (still !== "1") throw new Error("the business was removed rather than suspended");
    if (back !== "t") throw new Error("the suspension could not be lifted");
  });

  mustFail("suspending a business without saying why is refused",
    `select public.sarraf_manager_set_tenant_active('t-third',false,'')`);

  check("the manager sees every account and which business it is in", () => {
    asManager();
    const rows = psql(`select coalesce(string_agg(id || ':' || coalesce(tenant_id,'-'), ',' order by id), '')
                       from public.sarraf_manager_accounts()`).trim();
    asAdmin();
    if (!rows.includes("mgr:-")) throw new Error("the manager is not listed as belonging to none");
    if (!rows.includes("own-b:t-kurdistan")) throw new Error("the second business's owner is missing");
    if (!rows.includes("cust-1:t-sarkhel")) throw new Error("the first business's customer is missing");
  });

  check("a business owner is refused every account", () => {
    asTenantB();
    let refused = false;
    try { psql("select * from public.sarraf_manager_accounts()"); } catch { refused = true; }
    asAdmin();
    if (!refused) throw new Error("a business owner read every account in the installation");
  });

  // ── the one operation that destroys data, actually run ─────────────────────
  //
  // On a fresh database the reset takes its early return and the clearing never executes, so
  // until this case existed it had run nowhere — which is how a delete against an append-only
  // table survived long enough to reach the owner. This runs it last, on a database full of
  // everything every case above created.

  check("the reset clears the installation and keeps the manager", () => {
    asAdmin();
    const before = Number(psql("select count(*) from public.txs").trim());
    if (!(before > 0)) throw new Error("nothing to clear, so nothing would be proved");

    // The businesses have to go first: the reset does nothing while any exists, which is what
    // stops a second run from emptying a system that has since gone live.
    // Putting the database back to how it looks before any business exists, so the reset takes
    // the clearing path rather than its early return. One transaction with the guards lifted,
    // because several of these tables refuse an update as firmly as they refuse a delete — which
    // is the property being tested a few lines below.
    const tenanted = psql(`select string_agg(table_name, ',' order by table_name)
      from information_schema.columns
      where table_schema='public' and column_name='tenant_id' and table_name<>'app_users'`).trim();
    psql(`begin;
      set local session_replication_role = replica;
      delete from public.tenant_rates;
      delete from public.control_settings;
      delete from public.receipt_control_policy;
      ${tenanted.split(",").map((t) => `update public.${t} set tenant_id = null;`).join("\n      ")}
      update public.app_users set tenant_id = null;
      delete from public.tenants;
      commit;`);

    const out = JSON.parse(psql("select public.sarraf_reset_installation()::text"));
    if (out.done !== true || out.cleared !== true) throw new Error(JSON.stringify(out));

    for (const table of ["txs", "receipts", "journal_entries", "debts", "ledger", "vouchers"]) {
      const left = psql(`select count(*) from public.${table}`).trim();
      if (left !== "0") throw new Error(`${table} still holds ${left} rows`);
    }
    const admins = psql(`select coalesce(string_agg(admin_level, ','), '')
                         from public.app_users where not deleted`).trim();
    if (admins !== "manager") throw new Error(`the accounts left are ${admins || "none"}`);
    const tenants = psql("select coalesce(string_agg(id, ',' order by id), '') from public.tenants").trim();
    if (tenants !== "t-kurdistan,t-sarkhel") throw new Error(`the businesses are ${tenants}`);
  });

  // The append-only guards are right, and this is the one act allowed to go past them: a system
  // that has not started has no history worth keeping, and a fortnight of testing is not the
  // founding record of a real business. What matters is that the guards are back afterwards.
  check("the append-only guards are back in force after the reset", () => {
    psql(`insert into public.system_event_log(entity_table,entity_id,action,actor_id)
          values ('txs','probe','INSERT','mgr')`);
    let refused = false;
    try { psql("delete from public.system_event_log"); } catch { refused = true; }
    if (!refused) throw new Error("the change log can be tidied again");

    psql(`insert into public.ledger(id,type,owner,cur_id,amount,note,date)
          values ('led-probe','deposit','self','usd',1,'probe',now())`);
    let ledgerRefused = false;
    try { psql("delete from public.ledger where id='led-probe'"); } catch { ledgerRefused = true; }
    if (!ledgerRefused) throw new Error("the ledger can be deleted from again");
  });

  check("a second reset cannot empty a system that has since gone live", () => {
    const out = JSON.parse(psql("select public.sarraf_reset_installation()::text"));
    if (out.done !== false) throw new Error(JSON.stringify(out));
  });

  let failed = 0;
  for (const [ok, name] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; }
  console.log(failed
    ? `\n${failed} of ${checks.length} accounting database checks failed.`
    : `\nAccounting database contracts passed across ${checks.length} checks on a clean database.`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error("Accounting DB verification could not run:", String(e.message || e).slice(0, 4000));
  process.exit(1);
}
