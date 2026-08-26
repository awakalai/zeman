import test from "node:test";
import assert from "node:assert/strict";
import {
  intakeReceipt, requestStoredReceiptOcr, submitReceiptDocuments,
  intakeStatusText, INTAKE_STAGE, ReceiptIntakeError, receiptReadFailureText,
} from "../src/services/receiptIntake.js";

const jsonResponse = (body, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const stubClient = ({ rpc = {}, uploadError = null, token = "session-token" } = {}) => {
  const calls = { rpc: [], uploads: [], sessions: 0 };
  return {
    calls,
    auth: {
      async getSession() {
        calls.sessions += 1;
        return { data: { session: token ? { access_token: token } : null }, error: null };
      },
    },
    rpc(fn, args) {
      calls.rpc.push({ fn, args });
      if (rpc[fn]) return Promise.resolve(rpc[fn]);
      if (fn === "sarraf_receipt_intake_begin_v3") {
        return Promise.resolve({
          data: {
            document_id: args.p_document_id,
            storage_path: `ingest/${args.p_batch_id || args.p_transaction_id}/${args.p_document_id}.jpg`,
            state: "uploading",
          },
          error: null,
        });
      }
      if (fn === "sarraf_receipt_submit") {
        return Promise.resolve({ data: { submitted: 1, manual_review: 0, replayed: false }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "receipts");
        return {
          upload(path, value, options) {
            calls.uploads.push({ path, blob: value, options });
            return Promise.resolve({ error: uploadError });
          },
        };
      },
    },
  };
};

const blob = { size: 1234 };

test("the stored original exists before server OCR is requested", async () => {
  const client = stubClient();
  const order = [];
  const result = await intakeReceipt({
    client,
    blob,
    transactionId: "tx-1",
    documentId: "doc-001",
    onStage: (stage) => order.push(stage),
    fetchImpl: async (url, options) => {
      order.push("server-ocr");
      assert.equal(url, "/api/receipt-ocr");
      assert.deepEqual(JSON.parse(options.body), { documentId: "doc-001" });
      assert.equal(options.headers.Authorization, "Bearer session-token");
      return jsonResponse({ documentId: "doc-001", state: "validated", extraction: { grossAmount: "100" } });
    },
  });
  assert.ok(order.indexOf(INTAKE_STAGE.stored) < order.indexOf("server-ocr"));
  assert.equal(result.state, "validated");
  assert.equal(result.extraction.amount, 100);
});

test("the browser supplies identity only, never flow, parties, currency, or OCR JSON", async () => {
  const client = stubClient();
  await intakeReceipt({
    client,
    blob,
    transactionId: "tx-1",
    documentId: "doc-001",
    batchId: "batch-1",
    fetchImpl: async () => jsonResponse({ documentId: "doc-001", state: "needs_manual_review" }),
  });
  const claim = client.calls.rpc[0];
  assert.equal(claim.fn, "sarraf_receipt_intake_begin_v3");
  assert.deepEqual(Object.keys(claim.args).sort(), [
    "p_batch_id", "p_command_key", "p_customer_id", "p_document_id", "p_mime_type",
    "p_override_reason", "p_transaction_id",
  ]);
  assert.equal(JSON.stringify(claim.args).includes("customer_sells_to_zeman"), false);
  assert.equal(client.calls.rpc.some((call) => /extracted|stored$/.test(call.fn)), false);
});

// The receipt comes first and the transaction is made from it. Requiring a transaction to
// claim the document made a new customer's first upload impossible: they had no transaction,
// and could not get one without uploading.
test("a customer-seller claims a receipt with no transaction at all", async () => {
  const client = stubClient();
  const result = await intakeReceipt({
    client,
    blob,
    documentId: "doc-777",
    batchId: "batch-9",
    fetchImpl: async () => jsonResponse({
      documentId: "doc-777", state: "validated", extraction: { grossAmount: "250", currency: "CNY" },
    }),
  });
  const claim = client.calls.rpc[0];
  assert.equal(claim.args.p_transaction_id, null);
  assert.equal(claim.args.p_customer_id, null);
  // The command key is still bound to the document, so a retry replays one intent.
  assert.match(claim.args.p_command_key, /^receipt-intake:receipt:doc-777$/);
  assert.equal(client.calls.uploads[0].path, "ingest/batch-9/doc-777.jpg");
  assert.equal(result.state, "validated");
  assert.equal(result.extraction.amount, 250);
});

test("a staff upload names the customer it is for", async () => {
  const client = stubClient();
  await intakeReceipt({
    client,
    blob,
    documentId: "doc-778",
    batchId: "batch-9",
    customerId: "u-cust-3",
    adminOverrideReason: "counter upload for a walk-in seller",
    fetchImpl: async () => jsonResponse({ documentId: "doc-778", state: "needs_manual_review" }),
  });
  const claim = client.calls.rpc[0];
  assert.equal(claim.args.p_customer_id, "u-cust-3");
  assert.equal(claim.args.p_transaction_id, null);
});

test("the upload is immutable and never uses upsert", async () => {
  const client = stubClient();
  await intakeReceipt({
    client,
    blob,
    transactionId: "tx-1",
    documentId: "doc-001",
    fetchImpl: async () => jsonResponse({ documentId: "doc-001", state: "validated" }),
  });
  assert.equal(client.calls.uploads[0].options.upsert, false);
});

test("an OCR transport failure preserves the receipt and reports an unknown retryable outcome", async () => {
  const client = stubClient();
  const result = await intakeReceipt({
    client,
    blob,
    transactionId: "tx-1",
    documentId: "doc-001",
    fetchImpl: async () => { throw new Error("network lost"); },
  });
  assert.equal(client.calls.uploads.length, 1);
  assert.equal(result.state, "stored_retryable");
  assert.equal(result.evidenceKept, true);
  assert.ok(result.readError instanceof ReceiptIntakeError);
  assert.equal(result.readError.evidenceKept, true);
  assert.equal(result.readError.outcomeKnown, false);
});

test("a server OCR refusal cannot be mistaken for success", async () => {
  const client = stubClient();
  await assert.rejects(
    () => requestStoredReceiptOcr(client, "doc-001", {
      fetchImpl: async () => jsonResponse({ code: "receipt_not_owned", message: "no", outcomeKnown: true }, { status: 403 }),
    }),
    (error) => error.code === "receipt_not_owned" && error.status === 403 && error.outcomeKnown === true
  );
});

test("an upload failure is reported as evidence not kept", async () => {
  const client = stubClient({ uploadError: { message: "network down" } });
  await assert.rejects(
    () => intakeReceipt({ client, blob, transactionId: "tx-1", documentId: "doc-001" }),
    (error) => error instanceof ReceiptIntakeError && error.evidenceKept === false && error.stage === "upload"
  );
});

test("a refused assignment claim never uploads anything", async () => {
  const client = stubClient({
    rpc: { sarraf_receipt_intake_begin_v3: { data: null, error: { code: "42501", message: "outside assignment" } } },
  });
  await assert.rejects(
    () => intakeReceipt({ client, blob, transactionId: "tx-1", documentId: "doc-001" }),
    (error) => error.stage === "claim" && error.evidenceKept === false
  );
  assert.equal(client.calls.uploads.length, 0);
});

test("the same document has the same intake command key on every retry", async () => {
  const client = stubClient();
  const args = {
    client,
    blob,
    transactionId: "tx-1",
    documentId: "doc-fixed",
    fetchImpl: async () => jsonResponse({ documentId: "doc-fixed", state: "validated" }),
  };
  await intakeReceipt(args);
  await intakeReceipt(args);
  const claims = client.calls.rpc.filter((call) => call.fn === "sarraf_receipt_intake_begin_v3");
  assert.equal(claims[0].args.p_command_key, claims[1].args.p_command_key);
  assert.equal(client.calls.uploads[0].path, client.calls.uploads[1].path);
});

test("submitting sends only unique durable document identities through one command", async () => {
  const client = stubClient();
  const result = await submitReceiptDocuments(client, ["doc-1", "doc-1", null, "doc-2"], "receipt-submit:fixed-key");
  const call = client.calls.rpc[0];
  assert.equal(call.fn, "sarraf_receipt_submit");
  assert.deepEqual(call.args.p_document_ids, ["doc-1", "doc-2"]);
  assert.equal(call.args.p_command_key, "receipt-submit:fixed-key");
  assert.equal(result.submitted, 1);
});

test("a missing session is refused before the OCR route", async () => {
  const client = stubClient({ token: null });
  let fetched = false;
  await assert.rejects(() => requestStoredReceiptOcr(client, "doc-001", {
    fetchImpl: async () => { fetched = true; return jsonResponse({}); },
  }), /session required/);
  assert.equal(fetched, false);
});

test("uploader statuses never describe durable evidence as lost", () => {
  assert.match(intakeStatusText("stored_retryable"), /پارێزراوە/);
  assert.match(intakeStatusText("ocr_failed_retryable"), /گەیشت/);
  assert.match(intakeStatusText("upload_failed_retryable"), /نەگەیشت/);
  for (const state of ["created", "uploaded", "validated", "accepted", "rejected", "delivered", "seen"]) {
    assert.notEqual(intakeStatusText(state), state, `state ${state} has no human text`);
  }
});

test("the canonical intake has no migration-missing fallback to client OCR", async () => {
  const fs = await import("node:fs");
  const service = fs.readFileSync(new URL("../src/services/receiptIntake.js", import.meta.url), "utf8");
  assert.doesNotMatch(service, /sarraf_receipt_intake_extracted|readImage|p_flow|p_expected_currency/);
  assert.match(service, /sarraf_receipt_intake_begin_v3/);
  assert.match(service, /\/api\/receipt-ocr/);
});

// Every read failure reached the uploader as one sentence — "the image is safe, it will be
// retried" — whatever the server had actually said. An unset OCR API key and an expired session
// looked identical, on screen and in a screenshot, and neither the person uploading nor anyone
// reading over their shoulder could tell which had happened.
test("a read failure carries the server's own status, code and reason", async () => {
  const client = stubClient();
  const result = await intakeReceipt({
    client,
    blob,
    documentId: "doc-503",
    batchId: "batch-9",
    fetchImpl: async () => jsonResponse(
      { code: "server_not_configured", message: "receipt OCR service is not configured", retryable: true },
      { status: 503 }),
  });
  const failure = result.readError;
  assert.equal(failure.stage, "ocr");
  assert.equal(failure.code, "server_not_configured");
  // Dropped before, so isTemporaryOcrError could never see it and a 503 was judged permanent.
  assert.equal(failure.status, 503);
  assert.equal(failure.evidenceKept, true);
  assert.equal(result.state, "stored_retryable");
});

test("a named failure says what to do about it, and an unnamed one still says which", () => {
  assert.match(receiptReadFailureText({ code: "server_not_configured" }), /کلیلی API/);
  assert.match(receiptReadFailureText({ code: "session_required" }), /چوونەژوورەوە/);
  // Never invented, never swallowed.
  assert.match(receiptReadFailureText({ code: "something_new" }), /something_new/);
  assert.equal(receiptReadFailureText({}), null);
});

// Where the reading failed was knowable and nobody wrote it down. A failure inside the reader
// leaves an attempt row; a failure before it — no configuration, no session, the object could
// not be downloaded — left the database saying `uploading` with a null error, identically, for
// every cause. The browser is told the code every time and kept it to itself.
test("a read failure is written down on the receipt it failed for", async () => {
  const client = stubClient();
  await intakeReceipt({
    client,
    blob,
    documentId: "doc-note",
    batchId: "batch-9",
    fetchImpl: async () => jsonResponse(
      { code: "server_not_configured", message: "not configured", retryable: true }, { status: 503 }),
  });
  const note = client.calls.rpc.find((c) => c.fn === "sarraf_receipt_note_read_failure");
  assert.ok(note, "the reason was never recorded, so the database still says nothing happened");
  assert.equal(note.args.p_document_id, "doc-note");
  assert.equal(note.args.p_code, "server_not_configured");
  assert.equal(note.args.p_status, 503);
});

test("recording the reason can fail without losing the receipt", async () => {
  const client = stubClient({
    rpc: { sarraf_receipt_note_read_failure: Promise.reject(new Error("write refused")) },
  });
  const result = await intakeReceipt({
    client,
    blob,
    documentId: "doc-note-2",
    batchId: "batch-9",
    fetchImpl: async () => { throw new Error("network lost"); },
  });
  assert.equal(result.state, "stored_retryable");
  assert.equal(result.evidenceKept, true);
});
