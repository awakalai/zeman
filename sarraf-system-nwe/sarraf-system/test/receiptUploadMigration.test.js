import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL(
  "../supabase/migrations/20260910005622_enforce_receipt_upload_contract.sql",
  import.meta.url,
), "utf8");

test("the database command caps a receipt upload at twenty", () => {
  assert.match(sql, /v_count < 1 or v_count > 20/);
  assert.match(sql, /receipt_batches_upload_count_g1[\s\S]*n between 0 and 20/);
  assert.match(sql, /cannot exceed twenty images/);
});

test("the database stores and enforces one declared platform", () => {
  assert.match(sql, /add column if not exists platform text/);
  assert.match(sql, /v_platform not in \('alipay','wechat'\)/);
  assert.match(sql, /receipt platform differs from its upload group/);
  assert.match(sql, /receipt_batch_platform_immutable_g1/);
});

test("a receipt cannot be moved into a different upload group", () => {
  assert.match(sql, /old\.batch_id is distinct from new\.batch_id/);
  assert.match(sql, /receipt_intake_group_immutable_g1/);
  assert.match(sql, /receipt_group_immutable_g1/);
});

test("the migration is additive and preserves historical evidence", () => {
  assert.doesNotMatch(sql, /delete\s+from\s+public\.(receipts|receipt_batches|receipt_intake_items)/i);
  assert.doesNotMatch(sql, /drop\s+table/i);
  assert.match(sql, /where b\.id = p\.batch_id and b\.platform is null/);
});
