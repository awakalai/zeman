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

const workflow = text("../../.github/workflows/verify.yml");
for (const required of ["npm ci", "npm test", "npm run build", "npm run verify:accounting", "npm run verify:roles", "npm audit --audit-level=high"]) {
  if (!workflow.includes(required)) fail(`CI is missing required gate: ${required}`);
}

console.log(`Source contracts passed across ${tracked.length} tracked files and ${migrations.length} migrations.`);
