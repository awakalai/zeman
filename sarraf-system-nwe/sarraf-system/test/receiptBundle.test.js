import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  MAX_BUNDLE_RECEIPTS, BundleError, safeFileName, uniqueFileNames,
  planSelection, buildManifestCsv, crc32, buildZip, buildReceiptPackage,
} from "../src/services/receiptBundle.js";

const bytes = (text) => new TextEncoder().encode(text);

// ── the selection ────────────────────────────────────────────────────────────

test("a selection is de-duplicated and ordered, so a retry makes the same package", () => {
  assert.deepEqual(planSelection(["b", "a", "b", " c "]), ["a", "b", "c"]);
});

test("an empty selection is refused rather than producing an empty archive", () => {
  assert.throws(() => planSelection([]), (e) => e instanceof BundleError && e.code === "empty");
  assert.throws(() => planSelection(["", "  "]), (e) => e.code === "empty");
});

test("a selection over the hundred-receipt limit is refused", () => {
  const many = Array.from({ length: MAX_BUNDLE_RECEIPTS + 1 }, (_, i) => `r-${i}`);
  assert.throws(() => planSelection(many), (e) => e.code === "too_many");
});

test("exactly one hundred is allowed, because that is the stated limit", () => {
  const hundred = Array.from({ length: MAX_BUNDLE_RECEIPTS }, (_, i) => `r-${i}`);
  assert.equal(planSelection(hundred).length, MAX_BUNDLE_RECEIPTS);
});

// ── file names ───────────────────────────────────────────────────────────────

test("a file name loses the characters Windows refuses", () => {
  assert.equal(safeFileName('a<b>c:d"e/f\\g|h?i*j.jpg'), "a_b_c_d_e_f_g_h_i_j.jpg");
});

test("a reserved device name is prefixed rather than rejected", () => {
  assert.equal(safeFileName("NUL.jpg"), "_NUL.jpg");
  assert.equal(safeFileName("com1.png"), "_com1.png");
});

test("a trailing dot or space is removed, which Windows would refuse", () => {
  assert.equal(safeFileName("receipt. "), "receipt");
});

test("an empty or unnameable receipt still gets a name", () => {
  assert.equal(safeFileName(""), "receipt");
  assert.equal(safeFileName(null), "receipt");
});

test("Kurdish and Chinese names survive intact", () => {
  assert.equal(safeFileName("فیش-٢٠٢٦.jpg"), "فیش-٢٠٢٦.jpg");
  assert.equal(safeFileName("收据-123.jpg"), "收据-123.jpg");
});

test("two receipts with the same name are numbered, so neither is lost", () => {
  assert.deepEqual(
    uniqueFileNames(["a.jpg", "a.jpg", "a.jpg"]),
    ["a.jpg", "a (2).jpg", "a (3).jpg"],
  );
});

test("names that differ only by case still collide on Windows and macOS", () => {
  assert.deepEqual(uniqueFileNames(["A.jpg", "a.jpg"]), ["A.jpg", "a (2).jpg"]);
});

// ── the manifest ─────────────────────────────────────────────────────────────

test("the manifest carries the Order No. as a column", () => {
  const csv = buildManifestCsv([{ fileName: "a.jpg", orderNo: "OD-991", currency: "CNY" }]);
  assert.match(csv.split("\r\n")[0], /Order No\./);
  assert.match(csv, /OD-991/);
});

test("a cell containing a comma or a quote is escaped rather than breaking the row", () => {
  const csv = buildManifestCsv([{ party: 'Ali, "Abu"' }]);
  assert.match(csv, /"Ali, ""Abu"""/);
});

test("a cell that would run as a spreadsheet formula is neutralised", () => {
  // A receipt's own text must never execute in somebody's accounts.
  const csv = buildManifestCsv([{ orderNo: "=cmd|'/c calc'!A1" }]);
  assert.match(csv, /'=cmd/);
});

test("the manifest opens as UTF-8 in Excel", () => {
  const csv = buildManifestCsv([]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes("\r\n"));
});

// ── the archive ──────────────────────────────────────────────────────────────

test("crc32 matches the known value for a standard input", () => {
  // The check value every CRC-32 implementation agrees on.
  assert.equal(crc32(bytes("123456789")), 0xcbf43926);
});

test("an empty input has a zero checksum", () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("the archive begins with the ZIP signature and ends with the directory record", () => {
  const zip = buildZip([{ name: "a.txt", bytes: bytes("hello") }]);
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const eocd = zip.slice(zip.length - 22, zip.length - 18);
  assert.deepEqual([...eocd], [0x50, 0x4b, 0x05, 0x06]);
});

test("an archive larger than the limit is refused rather than crashing a phone", () => {
  const entry = { name: "big.bin", bytes: new Uint8Array(4096) };
  assert.throws(
    () => buildZip([entry], { maxBytes: 1024 }),
    (e) => e instanceof BundleError && e.code === "too_large",
  );
  // And the same archive is produced happily when it fits.
  assert.ok(buildZip([entry], { maxBytes: 8192 }).length > 4096);
});

// ── the whole package, unzipped by a real unzip ──────────────────────────────

test("a real unzip opens the package, and every file arrives byte-for-byte", () => {
  let unzipAvailable = true;
  try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); } catch { unzipAvailable = false; }

  const files = [
    { receiptId: "r-1", fileName: "OD-991.jpg", bytes: bytes("first receipt bytes") },
    { receiptId: "r-2", fileName: "OD-992.jpg", bytes: bytes("second receipt bytes") },
    // Same name twice: the archive must keep both.
    { receiptId: "r-3", fileName: "OD-991.jpg", bytes: bytes("third receipt bytes") },
  ];
  const rows = [
    { orderNo: "OD-991", currency: "CNY", net: "100", receiptId: "r-1" },
    { orderNo: "OD-992", currency: "CNY", net: "200", receiptId: "r-2" },
    { orderNo: "OD-991", currency: "CNY", net: "300", receiptId: "r-3" },
  ];

  const { zip, fileNames, manifest } = buildReceiptPackage(files, rows,
    { modifiedAt: new Date("2026-09-01T12:00:00Z") });

  assert.deepEqual(fileNames, ["OD-991.jpg", "OD-992.jpg", "OD-991 (2).jpg"]);
  // The manifest names the files as the archive stores them, so a reader can follow a row to a
  // file without guessing which of the two OD-991s it means.
  assert.match(manifest, /OD-991 \(2\)\.jpg/);

  if (!unzipAvailable) return;   // the assertions above still ran

  const dir = mkdtempSync(path.join(tmpdir(), "zeman-zip-"));
  try {
    const archive = path.join(dir, "package.zip");
    writeFileSync(archive, zip);
    execFileSync("unzip", ["-qq", archive, "-d", path.join(dir, "out")]);
    const out = path.join(dir, "out");
    const found = readdirSync(out).sort();
    assert.deepEqual(found, ["OD-991 (2).jpg", "OD-991.jpg", "OD-992.jpg", "manifest.csv"].sort());

    const digest = (b) => createHash("sha256").update(b).digest("hex");
    assert.equal(digest(readFileSync(path.join(out, "OD-991.jpg"))), digest(files[0].bytes));
    assert.equal(digest(readFileSync(path.join(out, "OD-992.jpg"))), digest(files[1].bytes));
    assert.equal(digest(readFileSync(path.join(out, "OD-991 (2).jpg"))), digest(files[2].bytes));
    assert.match(readFileSync(path.join(out, "manifest.csv"), "utf8"), /OD-992/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unzip reports the archive as structurally sound", () => {
  let unzipAvailable = true;
  try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); } catch { unzipAvailable = false; }
  if (!unzipAvailable) return;

  const { zip } = buildReceiptPackage(
    [{ receiptId: "r-1", fileName: "فیش-٩٩١.jpg", bytes: bytes("kurdish named receipt") }],
    [{ orderNo: "OD-991", receiptId: "r-1" }],
  );
  const dir = mkdtempSync(path.join(tmpdir(), "zeman-zip-"));
  try {
    const archive = path.join(dir, "package.zip");
    writeFileSync(archive, zip);
    // -t tests every entry's CRC. A wrong checksum or a wrong offset fails here.
    const out = execFileSync("unzip", ["-t", archive], { encoding: "utf8" });
    assert.match(out, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a package with no files is refused", () => {
  assert.throws(() => buildReceiptPackage([], []), (e) => e.code === "empty");
});
