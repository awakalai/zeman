import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGNED_URL_SECONDS, buildBundleForReceipts, bundleArchiveName, bundleFileName,
  bundleManifestRow, releaseForBundle, shareOrSaveBundle, signReleasedPaths,
} from "../src/services/receiptBundleTransfer.js";

const doc = (id, extra = {}) => ({
  document_id: id, tracking_code: `TR-${id}`, storage_path: `ingest/b/${id}.jpg`,
  mime_type: "image/jpeg", state: "accepted", received_at: "2026-09-01T10:00:00Z",
  order_no: `ORD-${id}`, merchant_order_no: `M-${id}`, currency: "CNY",
  gross_amount: "500", fee_amount: "5", net_amount: "495",
  payee: "ئەحمەد", tx_date: "2026-08-30",
  ...extra,
});

const clientWith = (released, { signed = null, storageError = null } = {}) => {
  const calls = [];
  return {
    calls,
    rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve({ data: released, error: null }); },
    storage: {
      from: () => ({
        createSignedUrls: (paths, expiresIn) => {
          calls.push({ fn: "createSignedUrls", paths, expiresIn });
          if (storageError) return Promise.resolve({ data: null, error: storageError });
          return Promise.resolve({
            data: signed || paths.map((p) => ({ signedUrl: `https://signed/${p}`, error: null })),
            error: null,
          });
        },
      }),
    },
  };
};

const okFetch = (bytes = 4) => () =>
  Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer) });

// ── the release ──────────────────────────────────────────────────────────────

test("the ids go to the server and the server's answer is what is used", async () => {
  const client = clientWith([doc("r1")]);
  const out = await releaseForBundle(client, ["r2", "r1"], "cust-1");
  assert.equal(client.calls[0].fn, "sarraf_release_receipts_for_bundle");
  assert.deepEqual(client.calls[0].args.p_document_ids, ["r1", "r2"]);
  assert.equal(client.calls[0].args.p_subject_id, "cust-1");
  assert.equal(out.released.length, 1);
});

// The whole point of the server call: an id the caller was not entitled to comes back absent.
// Reporting the gap rather than assuming the answer matches the question.
test("a receipt the server declined to release is counted, not assumed", async () => {
  const out = await releaseForBundle(clientWith([doc("r1")]), ["r1", "r2", "r3"]);
  assert.equal(out.asked.length, 3);
  assert.equal(out.released.length, 1);
  assert.equal(out.skipped, 2);
});

test("asking for more than a hundred is refused before any server call", async () => {
  const client = clientWith([]);
  const many = Array.from({ length: 101 }, (_, i) => `r${i}`);
  await assert.rejects(() => releaseForBundle(client, many), /at most 100/);
  assert.equal(client.calls.length, 0);
});

test("duplicates in the selection are asked for once", async () => {
  const client = clientWith([doc("r1")]);
  await releaseForBundle(client, ["r1", "r1", "r1"]);
  assert.deepEqual(client.calls[0].args.p_document_ids, ["r1"]);
});

test("the two receipt identifiers stay apart on the way back", async () => {
  const [row] = (await releaseForBundle(clientWith([doc("r1")]), ["r1"])).released;
  assert.equal(row.orderNo, "ORD-r1");
  assert.equal(row.merchantOrderNo, "M-r1");
});

test("the three figures come back as numbers and stay apart", async () => {
  const [row] = (await releaseForBundle(clientWith([doc("r1")]), ["r1"])).released;
  assert.equal(row.gross, 500);
  assert.equal(row.fee, 5);
  assert.equal(row.net, 495);
});

// ── file names ───────────────────────────────────────────────────────────────

test("a receipt's file is named by its Order No.", () => {
  assert.equal(bundleFileName({ orderNo: "ORD-9", mimeType: "image/jpeg" }), "ORD-9.jpg");
});

// api/read-receipt.js: "Never swap these two IDs." A merchant's number under a filename that
// reads like an order number is the same conflation, and worse here — nothing says which it is.
test("a merchant order number is never used as the file name", () => {
  const name = bundleFileName({ orderNo: null, trackingCode: "TR-7", merchantOrderNo: "M-9" });
  assert.equal(name, "TR-7.jpg");
  assert.ok(!name.includes("M-9"));
});

test("a name that would break on Windows is made safe", () => {
  assert.ok(!bundleFileName({ orderNo: 'a/b:c*d?', mimeType: "image/jpeg" }).match(/[/:*?]/));
});

test("the archive is named by the day and the count", () => {
  assert.equal(bundleArchiveName(42, new Date("2026-09-01T12:00:00Z")),
               "zeman-receipts-2026-09-01-42.zip");
});

test("the manifest row carries the file name the archive actually used", () => {
  const row = bundleManifestRow({ orderNo: "ORD-1", receiptId: "r1" }, "ORD-1.jpg");
  assert.equal(row.fileName, "ORD-1.jpg");
  assert.equal(row.orderNo, "ORD-1");
  assert.equal(row.receiptId, "r1");
});

// A manifest with the fee and net columns left blank is a manifest that cannot be reconciled
// against the receipts it lists — and receipt_extractions records all three separately for
// exactly that reason.
test("the manifest carries gross, fee and net rather than one figure", () => {
  const row = bundleManifestRow({ gross: 500, fee: 5, net: 495, currency: "CNY" }, "a.jpg");
  assert.equal(row.gross, 500);
  assert.equal(row.fee, 5);
  assert.equal(row.net, 495);
  assert.equal(row.amount, 500, "the headline figure is what the sender sent");
});

// A person matches a receipt against a bank statement by the date printed on the receipt, not
// by the day it happened to reach us.
test("the manifest dates a receipt by its own date, not by when it arrived", () => {
  assert.equal(bundleManifestRow({ txDate: "2026-08-30", receivedAt: "2026-09-01T10:00:00Z" }).date,
               "2026-08-30");
  assert.equal(bundleManifestRow({ txDate: null, receivedAt: "2026-09-01T10:00:00Z" }).date,
               "2026-09-01");
});

// ── signing ──────────────────────────────────────────────────────────────────

test("signatures are asked for by the minute, not the hour", async () => {
  const client = clientWith([doc("r1")]);
  const { released } = await releaseForBundle(client, ["r1"]);
  await signReleasedPaths(client, released);
  const signing = client.calls.find((c) => c.fn === "createSignedUrls");
  assert.equal(signing.expiresIn, SIGNED_URL_SECONDS);
  assert.ok(SIGNED_URL_SECONDS <= 600, "a signed URL is a bearer token; keep it short");
});

test("one path that cannot be signed does not take the others with it", async () => {
  const client = clientWith([doc("r1"), doc("r2")], {
    signed: [{ signedUrl: null, error: "not found" }, { signedUrl: "https://signed/ok", error: null }],
  });
  const { released } = await releaseForBundle(client, ["r1", "r2"]);
  const { signed, missing } = await signReleasedPaths(client, released);
  assert.equal(signed.length, 1);
  assert.deepEqual(missing, ["r1"]);
});

// ── the whole thing ──────────────────────────────────────────────────────────

test("a package is built from what the server released, and says what is missing", async () => {
  const client = clientWith([doc("r1"), doc("r2")]);
  const out = await buildBundleForReceipts(client, ["r1", "r2", "r3"], { fetchImpl: okFetch() });
  assert.equal(out.included, 2);
  assert.equal(out.askedFor, 3);
  assert.equal(out.skipped, 1);
  assert.ok(out.zip instanceof Uint8Array);
  assert.ok(out.fileNames.includes("ORD-r1.jpg"));
  // A header and one line per receipt that made it in — not one per receipt asked for.
  const lines = out.manifest.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("Order No."));
  assert.ok(lines[1].includes("ORD-r1"));
});

test("the package really is a zip, with the manifest beside the images", async () => {
  const client = clientWith([doc("r1")]);
  const { zip, fileNames } = await buildBundleForReceipts(client, ["r1"], { fetchImpl: okFetch() });
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const text = new TextDecoder().decode(zip);
  assert.ok(text.includes("manifest.csv"));
  assert.ok(text.includes(fileNames[0]));
});

test("one image that will not download does not lose the other ninety-nine", async () => {
  const client = clientWith([doc("r1"), doc("r2")]);
  let n = 0;
  const flaky = () => {
    n += 1;
    if (n === 1) return Promise.resolve({ ok: false, status: 500 });
    return okFetch()();
  };
  const out = await buildBundleForReceipts(client, ["r1", "r2"], { fetchImpl: flaky });
  assert.equal(out.included, 1);
  assert.deepEqual(out.unreadable, ["r1"]);
});

test("progress is reported for every receipt, readable or not", async () => {
  const client = clientWith([doc("r1"), doc("r2")]);
  const seen = [];
  await buildBundleForReceipts(client, ["r1", "r2"], {
    fetchImpl: okFetch(), onProgress: (p) => seen.push(p.done),
  });
  assert.deepEqual(seen, [1, 2]);
});

test("the size ceiling stops the download rather than filling memory first", async () => {
  const client = clientWith([doc("r1"), doc("r2"), doc("r3")]);
  await assert.rejects(
    () => buildBundleForReceipts(client, ["r1", "r2", "r3"], { fetchImpl: okFetch(100), maxBytes: 150 }),
    /passed 150 bytes at receipt 2/,
  );
});

test("releasing nothing is an honest refusal rather than an empty zip", async () => {
  await assert.rejects(
    () => buildBundleForReceipts(clientWith([]), ["r1"], { fetchImpl: okFetch() }),
    /released none/,
  );
});

test("a storage failure is surfaced, not swallowed", async () => {
  const client = clientWith([doc("r1")], { storageError: new Error("bucket unavailable") });
  await assert.rejects(() => buildBundleForReceipts(client, ["r1"], { fetchImpl: okFetch() }),
    /bucket unavailable/);
});

// ── getting it out of the app ────────────────────────────────────────────────

test("the share sheet is used when the phone will take the file", async () => {
  const shared = [];
  const result = await shareOrSaveBundle(new Uint8Array([1, 2]), "a.zip", {
    navigatorImpl: { canShare: () => true, share: (p) => { shared.push(p); return Promise.resolve(); } },
  });
  assert.equal(result, "shared");
  assert.equal(shared[0].files[0].name, "a.zip");
});

// canShare is asked about the actual file, not only about the API: a browser may have
// navigator.share and still refuse a ZIP, and a throw there would lose the built package.
test("a browser that has share but refuses a zip falls back to saving", async () => {
  const clicked = [];
  const result = await shareOrSaveBundle(new Uint8Array([1]), "a.zip", {
    navigatorImpl: { canShare: () => false, share: () => Promise.reject(new Error("nope")) },
    documentImpl: {
      createElement: () => ({ click: () => clicked.push(1), remove: () => {}, style: {} }),
      body: { appendChild: () => {} },
    },
    urlImpl: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  });
  assert.equal(result, "saved");
  assert.equal(clicked.length, 1);
});

// Closing the share sheet is not an error and must not be reported as one.
test("a person who closes the share sheet is not shown a failure", async () => {
  const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
  const result = await shareOrSaveBundle(new Uint8Array([1]), "a.zip", {
    navigatorImpl: { canShare: () => true, share: () => Promise.reject(abort) },
  });
  assert.equal(result, "cancelled");
});
