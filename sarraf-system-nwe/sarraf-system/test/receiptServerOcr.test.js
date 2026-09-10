import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { extractionPayload, sniffImage } from "../api/receipt-ocr.js";

test("stored-image attestation recognizes supported signatures and rejects labels without bytes", () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "image/png");
  assert.equal(sniffImage(Buffer.from("RIFF0000WEBP", "ascii")), "image/webp");
  assert.equal(sniffImage(Buffer.from("this is not an image", "utf8")), null);
});

test("fee treatment is declared only when the visible equation proves it", () => {
  const exact = extractionPayload({ amount: 2520.41, orderAmount: 2447, fee: 73.41, netAmount: 2447 });
  const unknown = extractionPayload({ amount: 1258.66, fee: 36.66, netAmount: 1222 });
  assert.equal(exact.feeTreatment, "added_on_top");
  assert.equal(unknown.feeTreatment, "unknown");
  assert.equal(exact.grossAmount, "2520.41");
  assert.equal(exact.netAmount, "2447");
});

test("the canonical OCR route accepts only a document id and reads the protected original", () => {
  const source = fs.readFileSync(new URL("../api/receipt-ocr.js", import.meta.url), "utf8");
  assert.match(source, /key !== "documentId"/);
  assert.match(source, /storage\.from\("receipts"\)\.download\(document\.storage_path\)/);
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /sniffImage\(bytes\)/);
  assert.match(source, /sarraf_receipt_record_server_extraction/);
  assert.match(source, /finalState\.data\.state/);
  assert.doesNotMatch(source, /p_flow|p_customer_id|p_partner_id|p_expected_currency/);
});

test("the browser cannot execute the server extraction command", () => {
  const sql = fs.readFileSync(
    new URL("../supabase/migrations/202608140001_canonical_receipt_lifecycle.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /revoke all on function public\.sarraf_receipt_record_server_extraction[\s\S]*from public,anon,authenticated/i);
  assert.match(sql, /grant execute on function public\.sarraf_receipt_record_server_extraction[\s\S]*to service_role/i);
});
