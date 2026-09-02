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

// ── a command with no button is not a feature ────────────────────────────────────────────────
//
// Three times in one week I finished a server command — the commission and its accounts, the
// office advance, the Explain Balance view — wrote its migration, applied it live, covered it
// with unit tests and an isolation check, and reported the requirement done. And no screen called
// any of them. Every gate passed, because every gate was asking about the half that existed.
//
// From the owner's side that is not a finished feature; it is a function in a database they
// cannot reach. So the reachability is asked here: a service function that performs an RPC is a
// command somebody is meant to press, and if no component ever names it, either the screen is
// missing or the function is dead. Both are worth being stopped for.
//
// Helpers that only shape or validate data are not commands and are not asked about — the rule
// looks only at functions whose own body calls client.rpc or client.storage.
const SERVICE_DIR = "src/services";
const componentText = tracked
  .filter((f) => f.endsWith(".jsx"))
  .map((f) => text(f))
  .join("\n");

// Is this service file itself imported by something the owner can open? One level, which is what
// this codebase actually does — a component imports a service, and a service may lean on a
// sibling. A chain longer than that would be worth flagging on its own.
const componentReaches = (serviceFile) => {
  const base = serviceFile.split("/").pop().replace(/\.js$/, "");
  return componentText.includes(`/${base}`);
};

for (const file of tracked.filter((f) => f.startsWith(SERVICE_DIR) && f.endsWith(".js"))) {
  const source = text(file);
  const exports = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)];
  for (let i = 0; i < exports.length; i += 1) {
    const name = exports[i][1];
    const from = exports[i].index;
    const to = i + 1 < exports.length ? exports[i + 1].index : source.length;
    const body = source.slice(from, to);
    if (!/client\.rpc\(|client\.storage\b/.test(body)) continue;
    // Reached directly by a component, by another service, or by a sibling in its own file.
    //
    // That last case is not a technicality and the first version of this rule got it wrong:
    // noteReceiptUploadFailure is called only by intakeReceipt, three functions below it in the
    // same file, and intakeReceipt is what the upload screen calls. Flagging it would have
    // invited deleting the one line that records why an upload failed. A function reached
    // through another function is reached.
    const withinOwnFile = (source.slice(0, from) + source.slice(to)).includes(name);
    // A TEST IS NOT A SCREEN, and this rule passed while measuring nothing until it said so.
    //
    // The first version counted any tracked .js file as "reached". Every one of the three
    // unreachable commands had unit tests — that is how they got as far as being reported done —
    // so the test file satisfied the rule and the gate agreed with me. Proved by deleting the
    // commission screen: the rule stayed green. Only a component, or a service a component
    // reaches, counts as somewhere the owner can get to.
    const elsewhere = tracked
      .filter((f) => f !== file && f.startsWith(SERVICE_DIR) && f.endsWith(".js"))
      .some((f) => text(f).includes(name) && componentReaches(f));
    // A narrow, visible escape, and the reason it is narrow.
    //
    // sarraf_receipt_submit is real, live behaviour — the accounting gate and the business-flows
    // gate both drive it — but the app submits receipts one at a time through the review path, so
    // its client wrapper has no screen. That is neither a missing feature nor dead code, and
    // deleting a tested mapping to a working command would be a loss.
    //
    // So a wrapper may say so, in one line, directly above its export. It has to be written by a
    // person and it shows up in the diff, which is the difference between an exemption and a hole:
    // every one of these had to be looked at to get here, and the four that turned out to be
    // missing screens were built rather than annotated.
    const exempt = /\/\/\s*unreached-by-design:\s*\S/.test(source.slice(Math.max(0, from - 400), from));
    if (!exempt && !componentText.includes(name) && !elsewhere && !withinOwnFile) {
      fail(`${file}: ${name}() calls the server and no screen ever reaches it. `
        + `Either the screen it belongs to was never built, or the function is dead. `
        + `A command the owner cannot press is not a finished feature.`);
    }
  }
}

// ── one palette, and only one ────────────────────────────────────────────────────────────────
//
// zeman.css carried TWO :root blocks. The first defined the colours; the second, added later
// under the heading "PROFESSIONAL UI FOUNDATION — PHASE 1", redefined twenty-three of them with
// different values — a different green, a different paper, a different radius scale, different
// shadows. Everything the first block decided for those twenty-three was dead, and anybody
// reading it to learn what the application looks like was reading the wrong half of the answer.
//
// Nothing catches that. The build succeeds, the app renders, and the only symptom is a product
// that feels unconsidered because two people's colours are fighting inside one file. So it is
// asked here: the light palette is declared once, the dark palette is declared once.
{
  const css = text("src/styles/zeman.css");
  const roots = [...css.matchAll(/^:root/gm)].length;
  const darks = [...css.matchAll(/^\[data-theme="dark"\]\s*\{/gm)].length;
  if (roots !== 1) {
    fail(`src/styles/zeman.css declares :root ${roots} times. A second palette silently `
      + `overrides the first, and every colour the first one chose is dead. Merge them.`);
  }
  if (darks !== 1) {
    fail(`src/styles/zeman.css declares a dark palette ${darks} times, for the same reason.`);
  }
  // The retired accent — the whole family, and everywhere, not one hex in one file.
  //
  // The first version of this rule looked for #00D978 in zeman.css alone, and passed while
  // the application was still painted in the old palette in eight places: the SECOND
  // .nav-active rule (which overrode the first), .sarraf-primary-action, the profit chart's
  // gradient, stroke and dots, the expense bars, and the phone's floating action button —
  // the largest button in the mobile app. A gate scoped to one file and one hex is a gate
  // that reports on the file, not on what a person sees.
  const RETIRED = /#(?:00D978|2BDE8D|18C877|1ACB7A|1BCB7A|BFEFD9)\b/gi;
  const stillPainted = [];
  for (const file of tracked.filter((f) => /^src\/.*\.(?:css|js|jsx)$/.test(f))) {
    for (const [index, line] of text(file).split("\n").entries()) {
      // Prose naming the colour it replaced is the explanation, not the paint.
      if (/^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line)) continue;
      const hit = line.match(RETIRED);
      if (hit) stillPainted.push(`${file}:${index + 1}  ${hit.join(", ")}`);
    }
  }
  if (stillPainted.length) {
    fail(`${stillPainted.length} place(s) still hard-code a retired accent colour instead of `
      + `asking for var(--ac), so two greens sit side by side on one screen:\n  `
      + stillPainted.slice(0, 12).join("\n  "));
  }
}

// ── a rule nothing can match is not a style, it is a leftover ────────────────────────────
//
//   «شتی زیادە لابدە»
//
// zeman.css carried fifty-eight lines of rules for classes that appear nowhere in the markup:
// a whole audit-table style, a report toolbar, a search toolbar, a filter row, a detail grid —
// three blocks still labelled "Phase 9", "Phase 8", "Phase 7" — plus mobile overrides for
// .max-w-7xl through .max-w-4xl, .gap-6 and .py-6, which nothing has used in a long time.
//
// Dead CSS is worse than merely wasteful. It is read as if it were true: somebody deciding how
// this application looks reads .sarraf-brand-mark hard-coding the retired green and concludes
// that is the brand mark, when in fact no element has ever carried that class.
//
// Alive means: the class name appears literally in the markup, OR a component builds a class
// name from a prefix at runtime (`tone-${tone}`, `is-${state}`) that this class could be the
// end of. The second half matters — without it the rule would demand the deletion of exactly
// the styles that are working.
{
  const markup = tracked
    .filter((file) => /^(?:src\/.*\.(?:js|jsx)|index\.html)$/.test(file))
    .map(text).join("\n");
  // Prefixes a component completes at runtime. A class starting with one of these cannot be
  // proved dead by searching for its full name, so it is left alone.
  const built = [...markup.matchAll(/`?([a-z][a-z0-9-]*-)\$\{/g)].map((m) => m[1]);
  const dead = [];
  for (const file of tracked.filter((f) => /^src\/.*\.css$/.test(f) && !f.endsWith("tailwind.css"))) {
    const names = new Set([...text(file).matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
    for (const name of names) {
      if (markup.includes(name)) continue;
      if (built.some((prefix) => name.startsWith(prefix))) continue;
      dead.push(`${file}  .${name}`);
    }
  }
  if (dead.length) {
    fail(`${dead.length} CSS class(es) are styled and worn by nothing. A rule nothing can match `
      + `is read as if it described the application, and it does not — delete it:\n  `
      + dead.slice(0, 15).join("\n  "));
  }
}

// ── one ellipsis, not two spellings of it ────────────────────────────────────────────────
//
//   «تەنانەت نووسینەکانی ڕووکاریش ڕێک بکەوەو شتی زیادە لابدە»
//
// The same label, on the same screen, was spelled two ways: the Kurdish said «بارکردن...» with
// three full stops and the English and Arabic beside it said "Loading…" with the character. A
// hundred and thirty-nine strings did that. Nobody would file it as a bug, and it is exactly
// what makes an interface feel like it was assembled rather than designed — three dots are
// wider, they break across a line, and they sit at a different height from the neighbour that
// means the same thing.
//
// So: one character, U+2026, everywhere an interface string trails off.
{
  const offenders = [];
  for (const file of tracked.filter((f) => /^src\/.*\.(?:js|jsx)$/.test(f))) {
    const source = text(file);
    for (const [index, line] of source.split("\n").entries()) {
      // Prose about the code is not the code. A comment may write "..." freely.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      for (const [, body] of line.matchAll(/"([^"\\\n]*?)\.\.\."/g)) {
        // An interface string is one carrying Arabic-script letters, or the bare three dots
        // once used as a button's whole label while it was working.
        if (/[؀-ۿ]/.test(body) || body === "") {
          offenders.push(`${file}:${index + 1}  "${body}..."`);
        }
      }
    }
  }
  if (offenders.length) {
    fail(`${offenders.length} interface string(s) trail off with three full stops instead of the `
      + `ellipsis character …, so the same label is spelled two ways in two languages:\n  `
      + offenders.slice(0, 12).join("\n  "));
  }
}

const workflow = text("../../.github/workflows/verify.yml");
for (const required of ["npm ci", "npm test", "npm run build", "npm run verify:accounting", "npm run verify:roles", "npm audit --audit-level=high"]) {
  if (!workflow.includes(required)) fail(`CI is missing required gate: ${required}`);
}

console.log(`Source contracts passed across ${tracked.length} tracked files, ${migrations.length} migrations`
  + ` and ${serviceKeyRoutes.length} service-key route(s).`);
