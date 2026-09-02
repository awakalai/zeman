#!/usr/bin/env node
/**
 * The inspection is a program, and nothing had ever run it.
 *
 * supabase/INSPECT.sql is how the owner sees the live system: five hundred lines of SQL, run by
 * hand against production through the inspect workflow. Every other program in this repository
 * has a gate. This one had none — it was executed for the first time each time, against the only
 * database that matters.
 *
 * That is not a hypothetical risk. It has already happened once, in this project:
 *
 *   Section 8.d called an admin-guarded function. The inspect workflow connects as postgres with
 *   nobody signed in, so the guard raised "not authorized" — and psql runs top to bottom under
 *   ON_ERROR_STOP, so EVERY SECTION AFTER IT WAS LOST. The owner got half an inspection and no
 *   indication that the other half existed.
 *
 * A rule was added to verify:source afterwards, forbidding INSPECT from reaching an actor-guarded
 * function. That rule is worth having and it is not enough: it catches one specific way to break
 * the file. A misspelled column, a table that does not exist, a type that will not cast — none of
 * those are caught by reading the text, and each of them truncates the inspection at exactly the
 * same place and in exactly the same silence.
 *
 * So this runs the whole thing, against a real PostgreSQL with every migration applied, as the
 * same unprivileged-of-application-identity connection the workflow uses: no signed-in user, no
 * JWT claim, nothing set. If a section cannot run there, it cannot run in production either.
 *
 * ── What it checks ───────────────────────────────────────────────────────────────────────────
 *
 *   1. the file runs to completion under ON_ERROR_STOP
 *   2. it reaches its own final marker — proof it was not truncated part-way
 *   3. every section header it declares actually printed
 *
 * Check 2 and 3 exist because check 1 alone would pass on a file that had lost its last half to
 * an \if block that silently skipped it. Counting the headers is what makes truncation visible.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PG_HINT, postgresAvailable, startDatabase } from "./lib/zeman-db.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const INSPECT = path.join(ROOT, "supabase", "INSPECT.sql");

let failures = 0;
const check = (what, run) => {
  try {
    run();
    console.log(`PASS  ${what}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${what}`);
    console.log(`        ${String(error.message || error).split("\n").slice(0, 6).join("\n        ")}`);
  }
};

if (!postgresAvailable()) {
  console.error(PG_HINT);
  process.exit(1);
}

const source = readFileSync(INSPECT, "utf8");

// Every '\echo' line that draws a section banner. These are what the owner scrolls through, and
// the count is the thing that makes a truncated run obvious rather than merely shorter.
const declared = [...source.matchAll(/\\echo\s+'════════ ([^']+) ════════'/g)].map((m) => m[1]);

const db = startDatabase();
let output = "";

try {
  // ── the condition that actually broke production ─────────────────────────────────────────
  //
  // The first version of this gate passed with the original fault reintroduced, which is to say
  // it measured nothing. The fixture pins auth.uid() to a real administrator so the other gates
  // can exercise admin commands — and under that identity sarraf_require_admin SUCCEEDS, so an
  // admin-guarded call in INSPECT runs happily here and dies in production.
  //
  // inspect.yml connects as postgres with nobody signed in. That is the condition, and a gate
  // that does not reproduce it cannot see the bug it exists to catch. So auth.uid() goes back to
  // reading an unset claim — null, exactly as the workflow leaves it — for the duration of the
  // run. The database is disposable; nothing after this needs the admin identity.
  db.psql(`
    create or replace function auth.uid() returns uuid language sql stable
      as $fn$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;`);

  check("the inspection runs to the end with nobody signed in, as production runs it", () => {
    // Exactly how inspect.yml invokes it: a plain connection, no signed-in user, ON_ERROR_STOP
    // on. psqlFile already sets ON_ERROR_STOP=1, which is the whole point — a section that raises
    // takes the rest of the file with it, here as in production.
    output = db.psqlFile(INSPECT);
  });

  check("it reaches its own final marker rather than stopping part-way", () => {
    if (!output.includes("تەواو")) {
      const tail = output.trim().split("\n").slice(-4).join("\n");
      throw new Error(`the inspection did not reach «تەواو». It ended at:\n${tail}`);
    }
  });

  check("every section it declares actually printed", () => {
    const missing = declared.filter((title) => !output.includes(title));
    if (missing.length) {
      throw new Error(`${missing.length} section(s) declared but never printed:\n  ${missing.join("\n  ")}`);
    }
  });

  // The reconciliation in section 10 is the one number in the whole file that must be zero on any
  // database, empty or not: the four holders partition the ledger, and a partition either sums to
  // the whole or it does not. Asserting it here means an empty fixture still proves the arithmetic.
  check("the four holders of money add up to the total, with nothing left over", () => {
    const out = db.psql(`
      select coalesce(max(abs(diff)), 0)::text from (
        select sum(l.amount)
             - (coalesce(sum(l.amount) filter (
                 where l.partner_id is null and l.office_id is null and l.cash_account_id is null), 0)
              + coalesce(sum(l.amount) filter (where l.partner_id is not null), 0)
              + coalesce(sum(l.amount) filter (where l.office_id is not null), 0)
              + coalesce(sum(l.amount) filter (where l.cash_account_id is not null), 0)) as diff
          from public.ledger l group by l.cur_id) s`).trim();
    if (Number(out) !== 0) throw new Error(`the buckets do not partition the ledger: ${out}`);
  });

  check("no ledger row names two holders at once", () => {
    const out = db.psql(`
      select count(*)::text from public.ledger l
       where (case when l.partner_id      is not null then 1 else 0 end)
           + (case when l.office_id       is not null then 1 else 0 end)
           + (case when l.cash_account_id is not null then 1 else 0 end) > 1`).trim();
    if (out !== "0") throw new Error(`${out} row(s) claim two holders`);
  });
} finally {
  db.stop();
}

console.log("");
if (failures) {
  console.log(`${failures} check(s) failed. The inspection would break in production the same way.`);
  process.exit(1);
}
console.log(`The inspection runs end to end, across ${declared.length} sections.`);
