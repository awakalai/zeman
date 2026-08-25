import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Migrations run in file order, and nothing in the test suite ever ran them that way.
 *
 * The reset migration truncated public.tenant_rates by name. That table is created two files
 * later. On the live database it failed the moment it was reached; in every test it passed,
 * because a test database is empty, an empty database takes the early return, and the code below
 * the return had never executed at all.
 *
 * These checks are static — they read the SQL rather than run it — because the condition that
 * broke is a property of the file order itself, which is exactly what a database that already
 * has every migration applied can no longer tell you.
 */

const dir = new URL("../supabase/migrations/", import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const source = new Map(files.map((f) => [f, fs.readFileSync(new URL(f, dir), "utf8")]));

// Where each table is first created. `create table if not exists public.x` and `create table
// public.x` both count; the schema qualifier is optional in some of the older files.
const createdIn = new Map();
for (const f of files) {
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const m of source.get(f).matchAll(re)) {
    const name = m[1].toLowerCase();
    if (!createdIn.has(name)) createdIn.set(name, f);
  }
}

test("no migration truncates a table that a later migration creates", () => {
  const offences = [];
  for (const f of files) {
    const re = /truncate\s+table\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
    for (const m of source.get(f).matchAll(re)) {
      const table = m[1].toLowerCase();
      const born = createdIn.get(table);
      // A table created nowhere in the migrations pre-dates them; that is not this bug.
      if (born && born > f) offences.push(`${f} truncates ${table}, created later in ${born}`);
    }
  }
  assert.deepEqual(offences, [], offences.join("; "));
});

// The lesson itself. Clearing an installation must find its tables rather than list them: a list
// goes stale, and it goes stale silently — the table added next month is the one row that
// survives a reset nobody notices until two businesses are reading it.
test("the reset finds the tables it clears instead of naming them", () => {
  const reset = source.get("202608240003_reset_and_seed_tenants.sql");
  assert.ok(reset, "the reset migration is missing");

  assert.match(reset, /information_schema\.columns/,
    "the reset no longer discovers the tables it clears");
  assert.match(reset, /column_name\s*=\s*'tenant_id'/,
    "the reset no longer selects tables by the column that makes them a business's data");

  // One truncate, and its argument is built at run time — `%s` from the discovered list, never a
  // table spelled out in the file.
  const truncates = [...reset.matchAll(/truncate\s+table\s+([^\s;]+)/gi)].map((m) => m[1]);
  assert.deepEqual(truncates, ["%s"],
    `the reset truncates a named table: ${truncates.filter((t) => t !== "%s").join(", ")}`);
});

// app_users is the one table deliberately left out of the discovery, and it has to stay out: the
// accounts are what the cleared installation is for, and they are updated rather than emptied.
test("the reset excludes app_users from what it clears, and keeps the accounts", () => {
  const reset = source.get("202608240003_reset_and_seed_tenants.sql");
  assert.match(reset, /table_name\s*<>\s*'app_users'/,
    "app_users is no longer excluded from the tables the reset empties");
  assert.doesNotMatch(reset, /delete\s+from\s+public\.app_users/i,
    "the reset deletes accounts again");
  assert.match(reset, /update\s+public\.app_users\s+set\s+tenant_id/i,
    "the reset no longer puts the surviving accounts into a business");
});
