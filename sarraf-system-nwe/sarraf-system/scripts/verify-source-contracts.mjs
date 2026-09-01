#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fail = (message) => { throw new Error(message); };
const text = (file) => readFileSync(path.join(root, file), "utf8");

// Include staged/tracked and not-yet-added source so a local gate cannot miss the exact new API
// or migration that is about to enter the commit.
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
  .toString("utf8").split("\0").filter(Boolean)
  .filter((file) => !file.startsWith("dist/") && !file.includes("package-lock.json"));

for (const file of tracked) {
  const source = text(file);
  if (/^(<{7}|={7}|>{7})(?: |$)/m.test(source)) fail(`merge-conflict marker in ${file}`);
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) fail(`runtime code generation in ${file}`);
}

// Protected financial and receipt state is command-only.  Reads may name these tables, but
// browser services may not call insert/update/delete/upsert on them directly.
const protectedTables = [
  "txs", "ledger", "account_ledger", "account_transfers", "day_closes", "rate_history", "audit",
  "approval_requests", "approval_events", "tx_versions",
  "journal_entries", "journal_lines", "debts", "debt_settlements",
  "customer_vaults", "customer_vault_events", "partner_accounts", "partner_account_events",
  "office_payment_assignments", "office_payment_events", "office_payment_evidence",
  "office_pending_assignments", "transaction_payment_events",
  "receipt_documents", "receipt_extractions", "receipt_forwardings",
];
const serviceFiles = tracked.filter((file) => file.startsWith("src/") && /\.(?:js|jsx)$/.test(file));
for (const file of serviceFiles) {
  const source = text(file);
  for (const table of protectedTables) {
    const mutation = new RegExp(`from\\(["']${table}["']\\)[\\s\\S]{0,160}?\\.(?:insert|update|delete|upsert)\\s*\\(`, "m");
    if (mutation.test(source)) fail(`direct browser mutation of protected table ${table} in ${file}`);
  }
}

const migrations = readdirSync(path.join(root, "supabase/migrations"))
  .filter((file) => file.endsWith(".sql")).sort();
for (let index = 1; index < migrations.length; index++) {
  if (migrations[index] <= migrations[index - 1]) fail("migration filenames are not strictly ordered");
}

const accountingVerifier = text("scripts/lib/zeman-db.mjs");
for (const required of ["readdirSync", "\"supabase\", \"migrations\"", ".filter((name) => name.endsWith(\".sql\"))", ".sort()"] ) {
  if (!accountingVerifier.includes(required)) fail(`accounting clean-database gate does not discover every migration: ${required}`);
}

const migrationSource = migrations.map((file) => text(`supabase/migrations/${file}`)).join("\n");
const baselineTables = [
  "currencies", "app_users", "txs", "ledger", "account_ledger", "account_transfers",
  "day_closes", "rate_history", "receipts", "receipt_batches", "approval_requests",
  "approval_events", "tx_versions", "audit", "notes", "financial_commands", "control_settings",
];
for (const table of baselineTables) {
  const definition = new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`, "i");
  if (!definition.test(migrationSource)) fail(`migration history does not create baseline table ${table}`);
}

// Every literal application RPC must have a source-controlled database definition. This catches
// the old production-only function drift before a frontend change can merge.
const rpcNames = new Set();
for (const file of tracked.filter((file) => /^(?:src|api)\/.+\.(?:js|jsx)$/.test(file))) {
  for (const match of text(file).matchAll(/(?:\.rpc|rpcStrict)\s*\(\s*["'](sarraf_[a-z0-9_]+)["']/g)) rpcNames.add(match[1]);
}
for (const name of [
  "sarraf_commit_transactions", "sarraf_edit_transaction", "sarraf_void_transaction",
  "sarraf_post_ledger_command", "sarraf_account_move", "sarraf_account_transfer",
  "sarraf_close_day", "sarraf_save_rates", "sarraf_add_currency",
  "sarraf_approve_request", "sarraf_reject_request", "sarraf_cancel_approval_request",
  "sarraf_owner_override_approval", "sarraf_update_control_settings",
  "sarraf_control_snapshot", "sarraf_read_model_snapshot", "sarraf_runtime_contract",
  "sarraf_self_profile", "sarraf_reconciliation_report", "sarraf_system_health",
  "sarraf_set_maintenance_mode", "sarraf_tx_history_page", "sarraf_report_range",
  "sarraf_inventory_snapshot", "sarraf_action_inbox_v2", "sarraf_integrity_center_v2",
]) rpcNames.add(name);
for (const name of [...rpcNames].sort()) {
  const definition = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "i");
  if (!definition.test(migrationSource)) fail(`application RPC has no migration definition: ${name}`);
}

for (const file of migrations) {
  const sql = text(`supabase/migrations/${file}`).replace(/--.*$/gm, "");
  if (/^\s*(?:truncate|drop\s+table)\b/im.test(sql)) {
    fail(`forward-only migration contains destructive data/schema SQL: ${file}`);
  }
}
for (const file of [
  "202608090001_legacy_core_baseline.sql",
  "202608180002_core_command_contracts.sql",
  "202608180003_runtime_read_models_and_security.sql",
]) {
  const sql = text(`supabase/migrations/${file}`).replace(/--.*$/gm, "");
  if (/^\s*delete\s+from\b/im.test(sql)) {
    fail(`new repair migration contains a destructive row operation: ${file}`);
  }
}

// Handing a SECURITY DEFINER function to sarraf_definer is judged as though that role were
// creating it in the schema, so it needs CREATE on public for the length of the statement. The
// disposable fixture connects as a superuser that owns the schema and grants it that by
// accident, so a migration missing the grant passes every gate here and then fails on the live
// database with `permission denied for schema public`. It has now done so once.
//
// The three events are read in the order they appear: every handover must fall inside a grant
// that has not yet been taken back, and nothing may be left holding it at the end of the file.
for (const file of migrations) {
  const sql = text(`supabase/migrations/${file}`).replace(/--.*$/gm, "");
  const events = [...sql.matchAll(
    /(grant\s+create\s+on\s+schema\s+public\s+to\s+sarraf_definer)|(revoke\s+create\s+on\s+schema\s+public\s+from\s+sarraf_definer)|(owner\s+to\s+sarraf_definer)/gi)];
  let holding = false;
  for (const [, granted, revoked] of events) {
    if (granted) holding = true;
    else if (revoked) holding = false;
    else if (!holding) {
      fail(`migration hands a function to sarraf_definer without CREATE on public: ${file}`);
    }
  }
  if (holding) fail(`migration leaves sarraf_definer able to create objects in public: ${file}`);
}

// A route that holds the service key has had row level security switched off for everything it
// reads and writes; every tenant boundary the database would have enforced has to be enforced
// there, in JavaScript. Three of the four such routes decided authorization by role alone, and
// an administrator is an administrator of one business — so "is an admin" authorised reading
// another business's receipt images and opening a batch against another business's customer.
//
// The rule cannot check that the comparison is correct, but it can check that the route asked
// the question at all: it must load the actor's business and compare it against something.
const serviceKeyRoutes = tracked.filter((file) =>
  /^api\/[^/]+\.js$/.test(file)
  && /SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY/.test(text(file)));
if (serviceKeyRoutes.length === 0) fail("no service-key route found; the tenant rule below is checking nothing");
for (const file of serviceKeyRoutes) {
  const source = text(file);
  const asksForTheBusiness = /ACTOR_COLUMNS|select\((?:["'`][^"'`]*tenant_id)/.test(source);
  const comparesIt = /sameTenant\(|withinTenant\(|authorizeTarget\(/.test(source);
  if (!asksForTheBusiness || !comparesIt) {
    fail(`service-key route decides authorization without the business: ${file}`
      + ` (loads it: ${asksForTheBusiness}, compares it: ${comparesIt})`);
  }
}

// Nothing that looks like a credential may enter the source.
//
// Two live database passwords reached this project through a chat window earlier in its life.
// They never entered a file, but nothing would have stopped them: no gate here looked, and a
// password committed once is a password in the history for ever, however quickly it is deleted.
//
// What is looked for is the shape of a secret, not a wordlist:
//
//   · a connection string carrying a password — postgres://user:something@host
//   · a JWT, which is what every Supabase anon and service key is
//   · a PEM private key block
//   · an assignment of a variable whose name says secret, to a literal long enough to be one
//
// The publishable/anon key is a JWT too and is meant to be in the browser, so it reaches the
// client through an environment variable like every other deployment value; a literal one in
// the source is still refused, because the file cannot tell you which key it is.
//
// The password part of a connection string is compared against the words people write when they
// are describing the shape rather than carrying one. Documentation has to be able to say what a
// connection string looks like — SECURITY.md and GUIDE.md both do — and a gate that refuses the
// sentence explaining the rule is a gate somebody switches off.
const A_PLACEHOLDER = /^(?:<[^>]*>|\{[^}]*\}|\$\{?[A-Z_]+\}?|x{3,}|\*{3,}|\.{3,}|password|PASSWORD|pass|your[-_]?password|yourpassword|secret|SECRET|changeme|例|…)$/;
const CREDENTIAL_SHAPES = [
  [/\bpostgres(?:ql)?:\/\/[^\s:@/]+:([^\s:@/]{3,})@/, "a connection string with a password in it"],
  // Five characters is a short payload but a real one; the first version asked for ten and
  // sailed past a token a test had written by hand.
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/, "a JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(?:SUPABASE_(?:SERVICE_ROLE_KEY|SECRET_KEY|DB_PASSWORD)|SERVICE_ROLE_KEY|DB_PASSWORD)\s*[:=]\s*["'`][^"'`\n$]{12,}["'`]/,
   "a secret assigned to a literal"],
];
// The rule needs to be able to describe itself without tripping over its own description, and
// tests need to be able to name the shapes they check for.
const DESCRIBES_ITSELF = new Set([
  "scripts/verify-source-contracts.mjs",
  "test/sourceContracts.test.js",
  "SECURITY.md",
]);
for (const file of tracked) {
  if (DESCRIBES_ITSELF.has(file)) continue;
  if (file.startsWith("node_modules/")) continue;
  const source = text(file);
  for (const [shape, what] of CREDENTIAL_SHAPES) {
    const found = shape.exec(source);
    if (!found) continue;
    // A captured group means the shape wanted the secret itself looked at, not just matched.
    if (found[1] && A_PLACEHOLDER.test(found[1])) continue;
    // Named, never printed: the whole point is that it does not reach a log.
    const line = source.slice(0, found.index).split("\n").length;
    fail(`${what} in ${file}:${line} — a credential must never enter the source. `
       + `Move it to an environment variable, and rotate it: it is compromised from the moment `
       + `it is written down.`);
  }
}

// ── a report must not need a session to run ─────────────────────────────────
//
// INSPECT.sql is executed by the inspect workflow over a plain postgres connection with no
// signed-in user. A section that calls a command guarded by sarraf_require_admin therefore stops
// with "not authorized" — and because psql runs the file top to bottom, everything after that
// section is lost too. That happened: a section added to explain the owner's cashbox took the
// whole report down with it, and the local fixture did not catch it because the fixture
// overrides auth.uid() to name a real administrator.
//
// So: whichever sarraf_* functions INSPECT calls, none of them may ask who the caller is.
{
  const inspect = text("supabase/INSPECT.sql");
  const allMigrations = migrations.map((file) => text(`supabase/migrations/${file}`)).join("\n");
  // Every function this report calls, by name.
  const called = new Set(
    [...inspect.matchAll(/\bpublic\.(sarraf_[a-z0-9_]+)\s*\(/g)].map((m) => m[1]));
  const guarded = [];
  for (const name of called) {
    // The function's own body: from its CREATE to the next CREATE, so a later function's guard
    // is not read as this one's.
    //
    // "create or replace function", not just "function": the first version of this searched for
    // the latter and found `alter function public.<name>(...) owner to sarraf_definer` at the
    // end of the migration instead. It then read a 150-character body, found no guard, and
    // passed — a check that measured nothing. Proved by reintroducing the mistake it exists for.
    const at = allMigrations.lastIndexOf(`create or replace function public.${name}(`);
    if (at === -1) continue;
    const next = allMigrations.indexOf("create or replace function", at + 1);
    const body = allMigrations.slice(at, next === -1 ? allMigrations.length : next);
    if (/sarraf_require_admin|sarraf_actor\s*\(/.test(body)) guarded.push(name);
  }
  if (guarded.length) {
    fail(`INSPECT.sql calls ${guarded.join(", ")}, which ask who the caller is. `
       + `The inspect workflow connects with no signed-in user, so the report would stop at `
       + `"not authorized" and lose every section after it. Write the query in plain SQL instead.`);
  }
}

const workflow = text("../../.github/workflows/verify.yml");
for (const required of ["npm ci", "npm test", "npm run build", "npm run verify:accounting", "npm run verify:roles", "npm audit --audit-level=high"]) {
  if (!workflow.includes(required)) fail(`CI is missing required gate: ${required}`);
}

console.log(`Source contracts passed across ${tracked.length} tracked files, ${migrations.length} migrations`
  + ` and ${serviceKeyRoutes.length} service-key route(s).`);
