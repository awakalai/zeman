/**
 * Backup integrity and restore rehearsal (§12).
 *
 * A button that downloads a file is not a backup. What makes it one is being able to answer
 * two questions later: is this file intact, and does it still contain what the database has?
 *
 * So an export carries a checksum over a canonical serialisation of its own contents, and a
 * rehearsal reads a saved file back, recomputes that checksum, and compares its counts against
 * the live database. A rehearsal that cannot be run is a backup nobody has tested.
 */

/** Bumped when the shape of `tables`/`counts` changes in a way a reader must notice. */
export const BACKUP_FORMAT = "sarraf-offsite-export";
export const BACKUP_VERSION = 5;

/**
 * Canonical JSON: object keys sorted at every depth, so two exports of identical data produce
 * an identical string — and therefore an identical checksum — regardless of column order.
 */
export function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

const bytesToHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 over the canonical form. Returns null where WebCrypto is unavailable. */
export async function checksumOf(value) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return bytesToHex(digest);
}

export const rowCounts = (tables) =>
  Object.fromEntries(Object.entries(tables || {}).map(([t, rows]) => [t, (rows || []).length]));

/**
 * Seals an export: counts, then a checksum over the tables only. The checksum deliberately
 * excludes the timestamp and the integrity block, so the same data exported twice verifies as
 * the same data.
 */
export async function sealBackup({ tables, takenAt, takenBy = null, warning = null }) {
  const counts = rowCounts(tables);
  const checksum = await checksumOf(tables);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    takenAt,
    takenBy,
    warning,
    counts,
    integrity: {
      algorithm: checksum ? "SHA-256" : "unavailable",
      scope: "tables",
      canonical: "sorted-keys",
      checksum,
    },
    tables,
  };
}

export const VERDICT = Object.freeze({
  ok: "ok",
  unreadable: "unreadable",
  wrongFormat: "wrong_format",
  noChecksum: "no_checksum",
  corrupt: "corrupt",
  drifted: "drifted",
});

export const VERDICT_TEXT = Object.freeze({
  ok: "فایلەکە تەواوە و لەگەڵ داتابەیس دەگونجێت ✓",
  unreadable: "فایلەکە ناخوێندرێتەوە — JSON دروست نییە",
  wrong_format: "ئەم فایلە هەناردەی ZEMAN نییە",
  no_checksum: "فایلەکە checksum ـی نییە — ناتوانرێت پشتڕاست بکرێتەوە",
  corrupt: "فایلەکە دەستکاری کراوە یان تێکچووە — checksum یەک ناگرێتەوە",
  drifted: "فایلەکە تەواوە بەڵام کۆن بووە — داتابەیس گۆڕاوە",
});

export const verdictText = (code) => VERDICT_TEXT[code] || code;

/**
 * Reads a saved export back and says whether it is still trustworthy.
 *
 * `liveCounts` is optional: without it this proves only that the file is intact; with it, the
 * rehearsal also reports which tables have moved since the export was taken. A drifted backup
 * is not corrupt — it is old, and the difference matters.
 *
 * @returns {Promise<{verdict: string, checksum: string|null, expected: string|null,
 *                    counts: object, drift: Array, takenAt: string|null}>}
 */
export async function rehearseRestore(fileText, liveCounts = null) {
  let parsed;
  try { parsed = JSON.parse(fileText); }
  catch { return { verdict: VERDICT.unreadable, checksum: null, expected: null, counts: {}, drift: [], takenAt: null }; }

  if (!parsed || parsed.format !== BACKUP_FORMAT || !parsed.tables || typeof parsed.tables !== "object") {
    return { verdict: VERDICT.wrongFormat, checksum: null, expected: null, counts: {}, drift: [], takenAt: parsed?.takenAt || null };
  }

  const counts = rowCounts(parsed.tables);
  const expected = parsed.integrity?.checksum || null;
  const base = { counts, takenAt: parsed.takenAt || null, expected };

  if (!expected) return { ...base, verdict: VERDICT.noChecksum, checksum: null, drift: [] };

  const actual = await checksumOf(parsed.tables);
  if (!actual) return { ...base, verdict: VERDICT.noChecksum, checksum: null, drift: [] };
  if (actual !== expected) return { ...base, verdict: VERDICT.corrupt, checksum: actual, drift: [] };

  if (!liveCounts) return { ...base, verdict: VERDICT.ok, checksum: actual, drift: [] };

  // Only tables the export covers are compared; a table added since is not this file's fault.
  const drift = Object.keys(counts)
    .map((table) => ({ table, inFile: counts[table], inDatabase: Number(liveCounts[table] ?? NaN) }))
    .filter((d) => Number.isFinite(d.inDatabase) && d.inDatabase !== d.inFile);

  return { ...base, verdict: drift.length ? VERDICT.drifted : VERDICT.ok, checksum: actual, drift };
}
