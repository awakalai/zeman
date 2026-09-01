import test from "node:test";
import assert from "node:assert/strict";
import { loadMyReceipts } from "../src/services/receiptIntake.js";
import { loadPortalReceiptSummary } from "../src/services/receiptOperations.js";
import { loadForwardedToMe } from "../src/services/receiptForwarding.js";

/**
 * The portal must ask the server about a person, not about "me".
 *
 * "Me" is whoever holds the session, which is the right answer only when the person signed in is
 * the person whose screen is on the glass. In a View As preview it is not: the administrator was
 * shown their own receipts inside a customer's portal. The fix is a subject argument the server
 * validates, and these tests hold the client to sending it.
 */
const recordingClient = (result = { data: [], error: null }) => {
  const calls = [];
  return { calls, rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve(result); } };
};

test("loadMyReceipts names the subject it was asked about", async () => {
  const client = recordingClient();
  await loadMyReceipts(client, 50, "cus-7");
  assert.equal(client.calls[0].fn, "sarraf_my_receipt_intakes_v2");
  assert.equal(client.calls[0].args.p_subject_id, "cus-7");
});

test("loadMyReceipts sends null when nobody is named, so the server answers about the caller", async () => {
  const client = recordingClient();
  await loadMyReceipts(client);
  assert.equal(client.calls[0].args.p_subject_id, null);
});

test("loadPortalReceiptSummary names the subject it was asked about", async () => {
  const client = recordingClient({ data: { totals: [], batches: [] }, error: null });
  await loadPortalReceiptSummary(client, 365, "cus-7");
  assert.equal(client.calls[0].fn, "sarraf_portal_receipt_summary_v2");
  assert.equal(client.calls[0].args.p_subject_id, "cus-7");
  assert.equal(client.calls[0].args.p_days, 365);
});

test("loadForwardedToMe names the subject it was asked about", async () => {
  const client = recordingClient();
  await loadForwardedToMe(client, 100, "cus-7");
  assert.equal(client.calls[0].fn, "sarraf_my_forwarded_receipts_v2");
  assert.equal(client.calls[0].args.p_subject_id, "cus-7");
});

test("a subject of null is sent explicitly rather than omitted", async () => {
  // Omitting the key would leave the server's default in charge, which is the same answer today.
  // Sending it explicitly is what makes a future change of default visible here rather than in
  // somebody's portal.
  const client = recordingClient();
  await loadForwardedToMe(client);
  assert.ok("p_subject_id" in client.calls[0].args);
  assert.equal(client.calls[0].args.p_subject_id, null);
});

test("the loaders still surface a server refusal instead of swallowing it", async () => {
  const refusing = { rpc: () => Promise.resolve({ data: null, error: new Error("not authorized") }) };
  await assert.rejects(() => loadMyReceipts(refusing, 50, "someone-else"), /not authorized/);
  await assert.rejects(() => loadForwardedToMe(refusing, 100, "someone-else"), /not authorized/);
  await assert.rejects(() => loadPortalReceiptSummary(refusing, 365, "someone-else"), /not authorized/);
});
