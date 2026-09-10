import test from "node:test";
import assert from "node:assert/strict";
import {
  RECEIPT_UPLOAD_LIMIT,
  normalizeReceiptUploadPlatform,
  validateReceiptUploadCommand,
  validateReceiptUploadSelection,
} from "../src/services/receiptUploadContract.js";
import { validateCommand as validateServerCommand } from "../api/receipt-ingestion.js";

const image = (n) => ({ name: `${n}.jpg`, type: "image/jpeg" });
const batchId = "12345678-1234-1234-1234-123456789abc";
const receipt = (n, platform = "alipay") => ({
  id: `receipt-${String(n).padStart(4, "0")}`,
  batch_id: batchId,
  image_path: `ingest/${batchId}/receipt-${String(n).padStart(4, "0")}.jpg`,
  amount: 10,
  fee: 0,
  currency: "CNY",
  platform,
  status: "ok",
});
const body = (count, platform = "alipay") => ({
  p_batch: { id: batchId, direction: "in", currency: "CNY", platform },
  p_receipts: Array.from({ length: count }, (_, index) => receipt(index + 1, platform)),
  p_command_key: `receipt-ingest:${batchId}`,
});

test("the uploader accepts exactly twenty images in one declared-platform group", () => {
  const result = validateReceiptUploadSelection({
    files: Array.from({ length: RECEIPT_UPLOAD_LIMIT }, (_, index) => image(index)),
    platform: "Ali Pay",
  });
  assert.equal(result.files.length, 20);
  assert.equal(result.platform, "alipay");
});

test("a twenty-first image is refused before the group starts", () => {
  assert.throws(
    () => validateReceiptUploadSelection({ files: Array.from({ length: 21 }, (_, index) => image(index)), platform: "wechat" }),
    (error) => error.code === "receipt_limit",
  );
});

test("a platform must be declared before images are accepted", () => {
  assert.throws(
    () => validateReceiptUploadSelection({ files: [image(1)], platform: "" }),
    (error) => error.code === "platform_required",
  );
});

test("a second file selection cannot be mixed into an active upload group", () => {
  assert.throws(
    () => validateReceiptUploadSelection({ files: [image(1)], platform: "alipay", hasActiveGroup: true }),
    (error) => error.code === "upload_group_locked",
  );
});

test("platform aliases normalize to the two phase-one platform keys", () => {
  assert.equal(normalizeReceiptUploadPlatform("支付宝"), "alipay");
  assert.equal(normalizeReceiptUploadPlatform("Weixin"), "wechat");
  assert.equal(normalizeReceiptUploadPlatform("bank"), null);
});

test("the shared command contract refuses a receipt from another group", () => {
  assert.throws(
    () => validateReceiptUploadCommand({
      batch: body(1).p_batch,
      receipts: [{ ...receipt(1), batch_id: "another-batch" }],
      expectedBatchId: batchId,
    }),
    (error) => error.code === "batch_conflict",
  );
});

test("the shared command contract refuses mixed platforms", () => {
  assert.throws(
    () => validateReceiptUploadCommand({
      batch: body(1).p_batch,
      receipts: [receipt(1, "wechat")],
      expectedBatchId: batchId,
    }),
    (error) => error.code === "mixed_platform",
  );
});

test("the server independently enforces count and declared platform", () => {
  assert.equal(validateServerCommand(body(20)).receipts.length, 20);
  assert.throws(() => validateServerCommand(body(21)), (error) => error.code === "invalid_count");
  assert.throws(() => validateServerCommand(body(1, "bank")), (error) => error.code === "platform_required");
  const mixed = body(2);
  mixed.p_receipts[1].platform = "wechat";
  assert.throws(() => validateServerCommand(mixed), (error) => error.code === "mixed_platform");
});
