/**
 * Packaging a selection of receipts for saving or sharing (§11).
 *
 * Store-only ZIP, written by hand rather than pulled from a library. Two reasons, and the second
 * is the real one: receipt images are already JPEG, so deflating them buys nothing and costs
 * time on a phone; and a bundle that has to stay inside a strict Content-Security-Policy is
 * better off with fifty lines it owns than a dependency it has to audit.
 *
 * Nothing here talks to a server. Authorization is the server's job and is re-checked there —
 * this module only decides what a package looks like once the server has said yes.
 */

/** The most receipts one package may carry (§11). */
export const MAX_BUNDLE_RECEIPTS = 100;

/** Refuse a package larger than this rather than run a phone out of memory. */
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

export class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}

// ── file names ───────────────────────────────────────────────────────────────

/**
 * A file name that survives every operating system a phone or desktop might unzip this on.
 *
 * Windows refuses the characters below, refuses a trailing dot or space, and reserves CON, PRN,
 * AUX, NUL, COM1-9 and LPT1-9 — including as a stem, so "NUL.jpg" is still refused. A receipt
 * whose order number happens to spell one of those should not be the reason an export fails to
 * open, so the reserved stems are prefixed rather than rejected.
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const FORBIDDEN = /[\u0000-\u001f<>:"/\\|?*]/g;

export function safeFileName(name, fallback = "receipt") {
  const raw = String(name ?? "").normalize("NFC");
  let clean = raw.replace(FORBIDDEN, "_").replace(/\s+/g, " ").trim();
  clean = clean.replace(/[. ]+$/, "");
  if (!clean) clean = fallback;
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  if (RESERVED.test(stem)) clean = `_${clean}`;
  // 120 leaves room for a de-duplicating suffix inside the 255-byte limit every filesystem has.
  if (clean.length > 120) clean = stem.slice(0, 120 - ext.length) + ext;
  return clean;
}

/**
 * Two receipts may legitimately produce the same file name — the same order number photographed
 * twice, or a missing order number falling back to the same default. Silently letting one
 * overwrite the other in the archive would lose a receipt, so they are numbered instead.
 */
export function uniqueFileNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const safe = safeFileName(name);
    const key = safe.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count === 0) return safe;
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    return `${stem} (${count + 1})${ext}`;
  });
}

// ── the selection ────────────────────────────────────────────────────────────

/**
 * What the browser is allowed to ask for. The server re-checks every id regardless; this stops a
 * mis-click from asking for six thousand receipts, and stops the same receipt being counted
 * twice in the progress bar.
 */
export function planSelection(receiptIds) {
  const ids = Array.isArray(receiptIds) ? receiptIds : [];
  const cleaned = ids.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (cleaned.length === 0) throw new BundleError("empty", "no receipts were selected");
  const unique = [...new Set(cleaned)];
  if (unique.length > MAX_BUNDLE_RECEIPTS) {
    throw new BundleError("too_many",
      `a package may carry at most ${MAX_BUNDLE_RECEIPTS} receipts; ${unique.length} were selected`);
  }
  // Stable order, so the manifest and the archive agree and a retry produces the same package.
  return unique.sort();
}

// ── the manifest ─────────────────────────────────────────────────────────────

const MANIFEST_COLUMNS = [
  ["fileName", "File"],
  ["orderNo", "Order No."],
  ["trackingCode", "Tracking"],
  ["amount", "Amount"],
  ["currency", "Currency"],
  ["gross", "Gross"],
  ["fee", "Fee"],
  ["net", "Net"],
  ["date", "Date"],
  ["party", "Customer / Partner"],
  ["transactionId", "Transaction"],
  ["state", "Status"],
  ["receiptId", "Reference"],
];

/**
 * A spreadsheet cell that begins =, +, - or @ is executed as a formula by Excel and Sheets. A
 * receipt's own text must never become a formula in somebody's accounts, so those are prefixed
 * with an apostrophe — the conventional escape, which the spreadsheet strips on display.
 */
const csvCell = (value) => {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function buildManifestCsv(rows) {
  const lines = [MANIFEST_COLUMNS.map(([, label]) => csvCell(label)).join(",")];
  for (const row of rows) {
    lines.push(MANIFEST_COLUMNS.map(([key]) => csvCell(row?.[key])).join(","));
  }
  // CRLF and a byte-order mark: Excel opens a UTF-8 CSV as mojibake without them, and these
  // receipts carry Kurdish and Chinese text.
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ── the archive ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS packed date and time, which is what a ZIP entry carries.
const dosDateTime = (date) => {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
};

/**
 * Entries are {name, bytes}. Stored, not deflated.
 *
 * Bit 11 of the general-purpose flags declares the name as UTF-8; without it an unzipper is
 * entitled to read a Kurdish or Chinese file name as CP437 and produce nonsense.
 */
export function buildZip(entries, { modifiedAt = new Date(), maxBytes = MAX_BUNDLE_BYTES } = {}) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modifiedAt);
  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const bytes = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
    return { nameBytes, bytes, crc: crc32(bytes) };
  });

  // maxBytes is an argument rather than only a constant so the guard can be driven in a test
  // without allocating two hundred megabytes to prove it fires.
  const total = prepared.reduce((sum, e) => sum + e.bytes.length, 0);
  if (total > maxBytes) {
    throw new BundleError("too_large",
      `the package would be ${Math.round(total / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit`);
  }

  const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.bytes.length, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v) => { view.setUint32(at, v >>> 0, true); at += 4; };
  const raw = (b) => { out.set(b, at); at += b.length; };

  const offsets = [];
  for (const e of prepared) {
    offsets.push(at);
    u32(0x04034b50); u16(20); u16(0x0800); u16(0);
    u16(time); u16(date);
    u32(e.crc); u32(e.bytes.length); u32(e.bytes.length);
    u16(e.nameBytes.length); u16(0);
    raw(e.nameBytes); raw(e.bytes);
  }

  const centralStart = at;
  prepared.forEach((e, i) => {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0);
    u16(time); u16(date);
    u32(e.crc); u32(e.bytes.length); u32(e.bytes.length);
    u16(e.nameBytes.length); u16(0); u16(0);
    u16(0); u16(0); u32(0);
    u32(offsets[i]);
    raw(e.nameBytes);
  });

  // Captured before the record is written. `at` is advanced by every field, so evaluating
  // `at - centralStart` inline reports the directory twelve bytes longer than it is — which is
  // exactly what a real unzip said when this was first written, and what an assertion over my
  // own bytes would never have caught.
  const centralEnd = at;
  u32(0x06054b50); u16(0); u16(0);
  u16(prepared.length); u16(prepared.length);
  u32(centralEnd - centralStart); u32(centralStart); u16(0);
  return out;
}

/**
 * The whole package: the images under their receipt names, plus the manifest beside them.
 *
 * `files` are {receiptId, fileName, bytes} and `rows` are manifest rows. The file names in the
 * archive are the ones the manifest names, so a reader can go from a spreadsheet line to a file
 * without guessing.
 */
export function buildReceiptPackage(files, rows, { modifiedAt = new Date() } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new BundleError("empty", "there are no files to package");
  }
  const names = uniqueFileNames(files.map((f) => f.fileName));
  const entries = files.map((f, i) => ({ name: names[i], bytes: f.bytes }));
  const manifestRows = rows.map((row, i) => ({ ...row, fileName: names[i] ?? row.fileName }));
  const manifest = buildManifestCsv(manifestRows);
  entries.push({ name: "manifest.csv", bytes: new TextEncoder().encode(manifest) });
  return { zip: buildZip(entries, { modifiedAt }), manifest, fileNames: names };
}
