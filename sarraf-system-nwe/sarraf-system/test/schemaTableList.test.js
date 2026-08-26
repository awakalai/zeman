import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The drift report's list of expected tables must match the migrations that create them.
 *
 * A list typed by hand falls behind the moment somebody adds a table and forgets, and a drift
 * report that is behind is worse than none: it reports "everything matches" about a schema it
 * has stopped describing. This test is what keeps the two in step, and it fails loudly with the
 * exact names to add or remove.
 */

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "supabase", "migrations");

const migrationText = () =>
  readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(path.join(migrationsDir, name), "utf8"))
    .join("\n");

const created = () => {
  const names = new Set();
  const pattern = /create table (?:if not exists )?public\.(\w+)/gi;
  let match;
  while ((match = pattern.exec(migrationText())) !== null) names.add(match[1]);
  return names;
};

// The last definition wins, as it does in the database. This used to read one named file, which
// was true until sarraf_schema_tables was redefined by a later migration — after which the test
// was checking a list the database no longer had, and passing.
const expectedInReport = () => {
  const files = readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort();
  let block = null;
  for (const name of files) {
    const file = readFileSync(path.join(migrationsDir, name), "utf8");
    let from = file.lastIndexOf("with expected(t) as (values");
    if (from < 0) continue;
    const to = file.indexOf("), live as (", from);
    if (to < 0) continue;
    block = file.slice(from, to);
  }
  assert.ok(block, "no migration defines the drift report's expected table list");
  const names = new Set();
  const pattern = /\('(\w+)'\)/g;
  let match;
  while ((match = pattern.exec(block)) !== null) names.add(match[1]);
  return names;
};

test("the drift report expects every table the migrations create", () => {
  const missing = [...created()].filter((name) => !expectedInReport().has(name)).sort();
  assert.deepEqual(missing, [],
    `these tables are created by a migration but absent from sarraf_schema_tables: ${missing.join(", ")}`);
});

test("the drift report expects no table the migrations do not create", () => {
  const stale = [...expectedInReport()].filter((name) => !created().has(name)).sort();
  assert.deepEqual(stale, [],
    `sarraf_schema_tables expects tables no migration creates: ${stale.join(", ")}`);
});

test("the list is not empty, which would make the report silently vacuous", () => {
  assert.ok(expectedInReport().size > 40, `only ${expectedInReport().size} tables listed`);
});
