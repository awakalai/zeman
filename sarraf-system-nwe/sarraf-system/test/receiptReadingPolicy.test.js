import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  RECEIPT_ARCHIVE_STATES, RECEIPT_REVIEW_STATES, restoreArchivedReceipt,
} from "../src/services/receiptWorkspace.js";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20260910101459_resilient_receipt_reading_policy.sql", import.meta.url), "utf8");

test("automatic archive states are separated from the human review queue", () => {
  assert.deepEqual(RECEIPT_ARCHIVE_STATES, ["duplicate", "tamper_suspected"]);
  assert.equal(RECEIPT_REVIEW_STATES.includes("duplicate"), false);
  assert.equal(RECEIPT_REVIEW_STATES.includes("tamper_suspected"), false);
  assert.equal(RECEIPT_REVIEW_STATES.includes("ocr_failed_retryable"), true);
});

test("the database policy requires high critical confidence and the declared platform", () => {
  assert.match(migration, /v_read\.confidence,0\) < 0\.88/);
  assert.match(migration, /v_critical_confidence,0\) < 0\.80/);
  assert.match(migration, /declared_platform_mismatch/);
  assert.match(migration, /visible_tamper_suspected/);
  assert.match(migration, /exact_image_duplicate/);
});

test("only the owner-authorized archive command performs restoration", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: { state: "needs_manual_review" }, error: null }; } };
  const result = await restoreArchivedReceipt(client, { documentId: "doc-1", reason: "هۆکاری دروستی گەڕاندنەوە" });
  assert.equal(result.state, "needs_manual_review");
  assert.equal(calls[0][0], "sarraf_restore_archived_receipt");
  assert.match(migration, /sarraf_require_admin\(true\)/);
  assert.match(migration, /admin_level='owner'/);
  assert.match(migration, /state not in \('duplicate','tamper_suspected'\)/);
});
