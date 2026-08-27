#!/usr/bin/env node
/**
 * How the app behaves when the business has been running for a while.
 *
 * Every other gate in this repository runs against a handful of rows. That is right for asking
 * "is the answer correct", and useless for asking "will this still open in a year". Those are
 * different questions and only one of them had ever been asked.
 *
 * The moment somebody opens ZEMAN, nine queries go out together. Five read a table WHOLE, a
 * thousand rows at a time — deliberately, because a balance computed from part of a ledger is
 * wrong rather than merely smaller. The other four take the newest few hundred of something.
 *
 * All nine ask for rows in an order. This gate seeds a real volume, then reads the plan
 * PostgreSQL chooses for each one, and fails any that sorts the whole table to answer.
 *
 * A full sort is not slow because of one query; it is slow because it does not scale. Sorting
 * 60,000 rows to return 1,000 of them costs the same on page 1 and page 60, so paging a table
 * whole costs the square of its size. Twice the history is four times the wait — which is the
 * shape of a system that is fine in testing and unusable in its second year.
 */
import { postgresAvailable, PG_HINT, startDatabase } from "./lib/zeman-db.mjs";

if (!postgresAvailable()) {
  console.log(PG_HINT);
  process.exit(0);
}

// Enough history that a sort of the whole table is unmistakable in the plan, and few enough that
// CI seeds it in seconds. The shape of the plan is what is being asserted, not the clock.
const LEDGER_ROWS = Number(process.env.ZEMAN_SCALE_ROWS || 20000);
const TX_ROWS = Math.round(LEDGER_ROWS / 3);
const ACCT_ROWS = Math.round(LEDGER_ROWS / 2);
const PAGE = 1000;
// Enough that a full sort is unmistakable, and more than the largest LIMIT any of them takes.
const AUDIT_ROWS = Math.max(4000, PAGE * 4);

let passed = 0;
const failures = [];
const record = (ok, what, detail) => {
  if (ok) { passed += 1; console.log(`PASS  ${what}`); return; }
  failures.push(what);
  console.log(`FAIL  ${what}`);
  if (detail) console.log(`        ${String(detail).split("\n").join("\n        ")}`);
};

const db = startDatabase();
const { psql } = db;

try {
  console.log(`\nseeding ${LEDGER_ROWS.toLocaleString()} ledger rows, ${TX_ROWS.toLocaleString()} transactions, ${ACCT_ROWS.toLocaleString()} account entries …\n`);
  psql(`
    insert into public.txs(id, code, type, cur_id, against_id, amount, rate, total, date, deleted, tenant_id)
    select 'scale-tx-'||g, 900000 + g, 'buy', 'usd', 'iqd',
           100 + (g % 900), 1, 100 + (g % 900),
           now() - (g || ' minutes')::interval, false, 't-sarkhel'
    from generate_series(1, ${TX_ROWS}) g
    on conflict do nothing;

    insert into public.ledger(id, type, cur_id, amount, date, tenant_id)
    select 'scale-lg-'||g, 'capital', 'usd', 1 + (g % 900),
           now() - (g || ' minutes')::interval, 't-sarkhel'
    from generate_series(1, ${LEDGER_ROWS}) g
    on conflict do nothing;

    insert into public.account_ledger(id, user_id, kind, cur_id, amount, type, created_at, tenant_id)
    select 'scale-al-'||g, 'u-a', 'safe', 'usd', 1 + (g % 500), 'in',
           now() - (g || ' minutes')::interval, 't-sarkhel'
    from generate_series(1, ${ACCT_ROWS}) g
    on conflict do nothing;
  `);

  // The four the browser takes only the newest few hundred of. They are seeded too, because a
  // check that passes on an empty table has proved nothing — and `audit` is the fastest-growing
  // table in the system, so it is the last one that should be measured empty.
  psql(`
    insert into public.audit(id, date, action, detail, tenant_id)
    select 'scale-au-'||g, now() - (g || ' minutes')::interval, 'scale', '{}'::jsonb, 't-sarkhel'
    from generate_series(1, ${AUDIT_ROWS}) g
    on conflict do nothing;

    insert into public.approval_requests(
      id, request_key, operation, payload, status, maker_auth_id, maker_app_id,
      created_at, expires_at, tenant_id)
    select 'scale-ar-'||g, 'scale-key-'||g, 'scale', '{}'::jsonb, 'pending',
           '11111111-1111-1111-1111-111111111111', 'u-a',
           now() - (g || ' minutes')::interval, now() + interval '1 day', 't-sarkhel'
    from generate_series(1, ${AUDIT_ROWS}) g
    on conflict do nothing;

    insert into public.approval_events(approval_id, event, created_at, tenant_id)
    select 'scale-ar-'||g, 'created',
           now() - (g || ' minutes')::interval, 't-sarkhel'
    from generate_series(1, ${AUDIT_ROWS}) g
    on conflict do nothing;

    insert into public.tx_versions(tx_id, version_no, action, created_at, tenant_id)
    select 'scale-tx-'||g, 1, 'create',
           now() - (g || ' minutes')::interval, 't-sarkhel'
    from generate_series(1, ${Math.min(AUDIT_ROWS, TX_ROWS)}) g
    on conflict do nothing;
  `);
  psql(`analyze public.audit; analyze public.approval_requests;
        analyze public.approval_events; analyze public.tx_versions;`);
  psql(`analyze public.ledger; analyze public.txs; analyze public.account_ledger;`);

  /**
   * Read the plan, not the clock. A timing threshold on shared CI hardware is a flake generator;
   * "did PostgreSQL have to sort the whole table" is the same answer on every machine.
   *
   * A `Sort` node is only damning when what it sorts is the table. A small sort over rows already
   * narrowed by an index is fine, so the row count on the Sort node is what decides it.
   */
  const planOf = (sql) => psql(`explain (analyze, format text) ${sql}`);

  /**
   * Read the ACTUAL rows, never the estimate.
   *
   * An earlier version of this gate judged by the estimated row count on the Sort node, and
   * reported PASS on a query the check above reported FAIL on — because row-level security
   * deflates the estimate (`rows=2222`) while the machine still walks every row (`rows=20000`).
   * The estimate is what PostgreSQL expected; only the actual count says what it did.
   */
  const wholeTableWork = (plan, rows) => {
    for (const line of plan.split("\n")) {
      if (!/Seq Scan|\bSort\b/.test(line)) continue;
      const actual = Number(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/.exec(line)?.[1] || 0);
      if (actual >= rows * 0.5) return line.trim();
    }
    return null;
  };
  const sortsWholeTable = wholeTableWork;
  const millis = (plan) => Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] || 0);

  // Exactly the nine the browser issues on open — see loadAll in App.jsx.
  const opening = [
    ["the ledger, page one", `select * from public.ledger order by date asc, id asc limit ${PAGE} offset 0`, LEDGER_ROWS],
    ["the ledger, its last page", `select * from public.ledger order by date asc, id asc limit ${PAGE} offset ${Math.max(0, LEDGER_ROWS - PAGE)}`, LEDGER_ROWS],
    ["the transactions", `select * from public.txs order by date asc, id asc limit ${PAGE} offset 0`, TX_ROWS],
    ["the account entries", `select * from public.account_ledger order by created_at asc, id asc limit ${PAGE} offset 0`, ACCT_ROWS],
    ["the rate history", `select * from public.rate_history order by created_at asc, id asc limit ${PAGE} offset 0`, 0],
    ["the people", `select * from public.app_users order by created_at asc, id asc limit ${PAGE} offset 0`, 0],
    ["the newest audit entries", `select * from public.audit order by date desc limit 500`, AUDIT_ROWS],
    ["the newest approval requests", `select * from public.approval_requests order by created_at desc limit 500`, AUDIT_ROWS],
    ["the newest approval events", `select * from public.approval_events order by created_at desc limit 1500`, AUDIT_ROWS],
    ["the newest transaction versions", `select * from public.tx_versions order by created_at desc limit 3000`, Math.min(AUDIT_ROWS, TX_ROWS)],
  ];

  console.log("the queries the app fires the moment somebody opens it\n");
  let total = 0;
  for (const [what, sql, rows] of opening) {
    const plan = planOf(sql);
    total += millis(plan);
    // A table with nothing in it can be answered any way at all; there is nothing to sort.
    const offender = rows >= PAGE ? sortsWholeTable(plan, rows) : null;
    record(!offender, `${what} is answered without sorting the whole table`, offender);
  }

  const pages = Math.ceil(LEDGER_ROWS / PAGE);
  const ledgerPlan = planOf(opening[0][1]);
  const ledgerDeep = planOf(opening[1][1]);
  const perPage = (millis(ledgerPlan) + millis(ledgerDeep)) / 2;
  console.log(`\n  the browser pages the ledger ${pages} times to open the app.`);
  console.log(`  at ${perPage.toFixed(1)} ms a page that is ${((perPage * pages) / 1000).toFixed(2)}s of database time for the ledger alone,`);
  console.log(`  before the network and before React.\n`);

  /**
   * The indexes are only half the answer. The other half is that the plan must still be an index
   * scan once row-level security is in the way — the tenant predicate here is a function call,
   * not an equality, and a filter that PostgreSQL cannot push into the index would send it back
   * to sorting everything.
   */
  // `set local` outside a transaction silently does nothing — which is exactly how an earlier
  // version of this check reported PASS on the same query the check above reported FAIL on. A
  // gate that passes for the wrong reason is worse than no gate, so the block is explicit.
  const asTenant = psql(`
    begin;
      set local role authenticated;
      select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
      explain (analyze, format text)
        select * from public.ledger order by date asc, id asc limit ${PAGE} offset 0;
    commit;
  `);
  if (process.env.ZEMAN_SCALE_DUMP) console.log("\n--- as authenticated ---\n" + asTenant + "\n---");
  record(!wholeTableWork(asTenant, LEDGER_ROWS),
    "and still without sorting it once row-level security is in the way",
    wholeTableWork(asTenant, LEDGER_ROWS));

  // Said the other way round, because "no sort" can also be true of a plan that is bad for some
  // other reason. The tenant predicate is a function of the row, so PostgreSQL cannot push it
  // into the index; what it CAN do is walk the index in order and stop once the page is full.
  // That is the difference between reading a thousand rows and reading the table.
  record(/Index Scan using ledger_open_order_idx/.test(asTenant),
    "the ledger is walked in order and abandoned once the page is full",
    asTenant.split("\n").find((l) => /Scan/.test(l))?.trim());

  // ── and the tenant question is asked once, not once per row ────────────────
  //
  // `sarraf_tenant_visible(tenant_id)` takes a column, so PostgreSQL must invoke it for every row
  // it looks at — and being `security definer` it is never inlined, so each invocation runs two
  // more definer functions that each query app_users. Written as `(select f())` instead, the
  // lookup becomes an InitPlan: one evaluation for the whole statement.
  //
  // An InitPlan in the plan, and no per-row call left in the filter, is what says so.
  record(/InitPlan/.test(asTenant) && !/sarraf_tenant_visible/.test(asTenant),
    "the tenant question is asked once for the query, not once for every row",
    asTenant.split("\n").filter((l) => /Filter|InitPlan/.test(l)).join("\n").slice(0, 300));

  // The counts the loader takes BEFORE it fetches anything, to find out how many pages there are.
  // This was the slowest read in the application and nothing measured it.
  const countPlan = psql(`
    begin;
      set local role authenticated;
      select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
      explain (analyze, format text) select count(*) from public.ledger;
    commit;
  `);
  record(/InitPlan/.test(countPlan) && !/sarraf_tenant_visible/.test(countPlan),
    "and once for the count the loader takes before it fetches a single row",
    countPlan.split("\n").filter((l) => /Filter|InitPlan/.test(l)).join("\n").slice(0, 300));

  // Every table, not just the one measured. A tenant policy still written the per-row way is a
  // table that will slow down exactly as the ledger did, and nothing else would notice.
  const perRow = psql(`
    select coalesce(string_agg(tablename || '.' || policyname, ', '), '')
      from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') like '%sarraf_tenant_visible%'
         or coalesce(with_check, '') like '%sarraf_tenant_visible%')
  `).trim();
  record(perRow === "", "no table is left asking the tenant question once per row", perRow.slice(0, 300));

  console.log(`\n${failures.length ? `${failures.length} of ${passed + failures.length}` : `All ${passed}`} opening queries ${failures.length ? "sort a whole table." : `scale, at ${LEDGER_ROWS.toLocaleString()} rows of history.`}`);
} finally {
  db.stop();
}

process.exit(failures.length ? 1 : 0);
