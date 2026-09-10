import test from "node:test";
import assert from "node:assert/strict";
import { ingestReceiptBatch, receiptObjectPath, ReceiptIngestionError } from "../src/services/receiptIngestion.js";

const command = { batchId: "12345678-1234-1234-1234-123456789abc", idempotencyKey: "receipt-ingest:12345678-1234-1234-1234-123456789abc" };
const row = { id: "receipt-1", blob: new Blob(["image"]), amount: 10, currency: "USD" };
const args = (supabase) => ({
  supabase,
  command,
  rows: [row],
  makeBatch: () => ({ id: command.batchId, platform: "alipay" }),
  makeReceipt: (r, path) => ({ id: r.id, batch_id: command.batchId, image_path: path, platform: "alipay" }),
});

function mock({ uploadError = null, rpcError = null, probe = null, removeError = null } = {}) {
  const calls = { uploads: [], removes: [], rpc: 0 };
  const supabase = {
    storage: { from: () => ({
      upload: async (path) => (calls.uploads.push(path), { error: uploadError }),
      remove: async (paths) => (calls.removes.push(paths), { error: removeError }),
    }) },
    rpc: async () => (calls.rpc++, { data: { replayed: false }, error: rpcError }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => probe || { data: null, error: null } }) }) }),
  };
  return { supabase, calls };
}

test("successful multi-receipt ingestion stages exact paths and makes one atomic RPC", async () => {
  const { supabase, calls } = mock();
  const result = await ingestReceiptBatch({ ...args(supabase), rows: [row, { ...row, id: "receipt-2" }] });
  assert.equal(result.committed, true);
  assert.equal(calls.rpc, 1);
  assert.deepEqual(calls.uploads, [receiptObjectPath(command.batchId, "receipt-1"), receiptObjectPath(command.batchId, "receipt-2")]);
  assert.deepEqual(calls.removes, []);
});

test("known database failure compensates only objects created by the command", async () => {
  const { supabase, calls } = mock({ rpcError: new Error("audit insert failed") });
  await assert.rejects(ingestReceiptBatch(args(supabase)), ReceiptIngestionError);
  assert.deepEqual(calls.removes, [[receiptObjectPath(command.batchId, row.id)]]);
});

test("storage failure cleans earlier exact objects and never calls the database", async () => {
  const { supabase, calls } = mock({ uploadError: new Error("unsupported mime") });
  await assert.rejects(ingestReceiptBatch(args(supabase)), /Image upload failed/);
  assert.equal(calls.rpc, 0);
  assert.deepEqual(calls.removes, []);
});

test("lost RPC response probes idempotent batch and does not delete committed storage", async () => {
  const { supabase, calls } = mock({ rpcError: new Error("timeout"), probe: { data: { id: command.batchId }, error: null } });
  const result = await ingestReceiptBatch(args(supabase));
  assert.equal(result.committed, true);
  assert.deepEqual(calls.removes, []);
});

test("unknown outcome preserves storage for a safe same-key retry", async () => {
  const { supabase, calls } = mock({ rpcError: new Error("timeout"), probe: { data: null, error: new Error("offline") } });
  await assert.rejects(ingestReceiptBatch(args(supabase)), (e) => e.stage === "verify" && e.outcomeUnknown);
  assert.deepEqual(calls.removes, []);
});

test("missing production RPC uses the authenticated recovery commit", async () => {
  const { supabase, calls } = mock({ rpcError: { code: "PGRST202", message: "Could not find the function sarraf_ingest_receipt_batch" } });
  let recoveryArgs = null;
  const result = await ingestReceiptBatch({
    ...args(supabase),
    recoveryCommit: async (input) => {
      recoveryArgs = input;
      return { batch_id: command.batchId, recovery: true };
    },
  });
  assert.equal(result.committed, true);
  assert.equal(result.data.recovery, true);
  assert.equal(recoveryArgs.commandKey, command.idempotencyKey);
  assert.deepEqual(calls.removes, []);
});
