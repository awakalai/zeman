import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ingestReceiptBatch,
  isMissingReceiptIngestionRpc,
  requiresIngestionServiceAuthorization,
} from "../src/services/receiptIngestion.js";

const authorizationError = () => ({
  code: "42501",
  message: "receipt command was not authorized by the ingestion service",
});

const supabaseStub = ({ rpcError }) => ({
  storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
  rpc: async () => ({ data: null, error: rpcError }),
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
});

const command = { batchId: "b".repeat(20), idempotencyKey: `receipt-ingest:${"b".repeat(20)}` };
const rows = [{ id: "receipt-0001", blob: new Uint8Array([1]) }];
const makeBatch = () => ({ id: command.batchId, direction: "in", currency: "CNY", platform: "wechat" });
const makeReceipt = (row, path) => ({ id: row.id, batch_id: command.batchId, image_path: path, amount: 10, fee: 0, net_amount: 10, currency: "CNY", platform: "wechat", status: "ok" });

test("the ingestion-service authorization refusal is recognised, and not confused with a missing RPC", () => {
  assert.equal(requiresIngestionServiceAuthorization(authorizationError()), true);
  assert.equal(isMissingReceiptIngestionRpc(authorizationError()), false);
  assert.equal(requiresIngestionServiceAuthorization({ code: "42501", message: "context not authorized" }), false);
  assert.equal(requiresIngestionServiceAuthorization({ code: "PGRST202", message: "not found" }), false);
});

// Regression: only a missing function triggered the server route, so once the receipt-assurance
// migration was applied the RPC refused every browser command and submission failed outright.
test("a command the database will not authorize is replayed through the server route", async () => {
  let routed = null;
  const result = await ingestReceiptBatch({
    supabase: supabaseStub({ rpcError: authorizationError() }),
    command, rows, makeBatch, makeReceipt,
    recoveryCommit: async (args) => { routed = args; return { batch_id: command.batchId, accepted_count: 1 }; },
  });
  assert.ok(routed, "the server route was never reached");
  assert.equal(routed.commandKey, command.idempotencyKey);
  assert.equal(result.committed, true);
  assert.equal(result.data.accepted_count, 1);
});

test("a genuine authorization failure is still surfaced, never silently rerouted", async () => {
  await assert.rejects(
    ingestReceiptBatch({
      supabase: supabaseStub({ rpcError: { code: "42501", message: "context not authorized" } }),
      command, rows, makeBatch, makeReceipt,
      recoveryCommit: async () => { throw new Error("must not reroute"); },
    }),
    (error) => error.name === "ReceiptIngestionError" && error.stage === "finalize"
  );
});

test("the server mints an authorization immediately before running the RPC", () => {
  const api = fs.readFileSync(new URL("../api/receipt-ingestion.js", import.meta.url), "utf8");
  // Only the service-role client may write the authorization table.
  assert.match(api, /authorizeIngestionCommand\(service, actor\.id, commandKey\)/);
  assert.match(api, /_authorization_token: authorizationToken/);
  // The token must reach the RPC, otherwise the RPC refuses the command.
  assert.match(api, /rpc\("sarraf_ingest_receipt_batch", \{ p_batch: authorizedBatch/);
  // Databases without the assurance migration have no table and need no token.
  assert.match(api, /missingTable/);
  assert.match(api, /randomBytes\(32\)\.toString\("base64url"\)/);
});

test("the minted token satisfies the column's format constraint", () => {
  const sql = fs.readFileSync(
    new URL("../supabase/migrations/202608110001_receipt_assurance.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /authorization_token ~ '\^\[A-Za-z0-9_-\]\{43\}\$'/);
  // 32 random bytes encode to exactly 43 unpadded base64url characters.
  const sample = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url");
  assert.equal(sample.length, 43);
  assert.match(sample, /^[A-Za-z0-9_-]{43}$/);
});
