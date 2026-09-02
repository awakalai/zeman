/**
 * Getting a hundred receipts out of the system and into somebody's hands (§11).
 *
 *   «ئەو فیشانەی لە ئەکاونتی مشتەرییەکاندا هەیە... پێویستە بتوانرێت بە کۆمەڵ بۆ نمونە تا ١٠٠
 *    دانە بەیەکەوە فۆرۆرد بکرێت و بنێررێت بۆ واتس ئەپ.»
 *
 * receiptBundle.js knows how to build the package and nothing else — no network, on purpose.
 * This is the part that talks: it asks the server which of the selected receipts may actually
 * leave, asks Storage for short-lived signatures on exactly those, fetches them, and hands back
 * one file.
 *
 * ── The order of operations is the security ──────────────────────────────────────────────────
 *
 *   1. plan          the browser's own sanity check — no duplicates, no more than a hundred
 *   2. release       THE SERVER decides which ids belong to the subject, and writes one audit row
 *   3. sign          Storage mints a short-lived URL per released path, under its own policies
 *   4. fetch         the bytes, one by one, with a progress callback
 *   5. package       the ZIP and the manifest
 *
 * Step 2 is the one that matters and it is the one a client cannot do for itself. The list of
 * ids arriving from a checkbox column is a request; what comes back from
 * sarraf_release_receipts_for_bundle is the answer, and everything downstream works only from
 * the answer. An id the caller was not entitled to is simply absent, so `skipped` below is the
 * honest count of what the server declined to release — reported, never hidden.
 *
 * ── Why the signatures are short ─────────────────────────────────────────────────────────────
 *
 * A signed Storage URL is a bearer token in a query string: anyone holding it can fetch the
 * image until it expires, with no further check. These exist only long enough to be fetched into
 * a ZIP that is then handed to the share sheet, so they are asked for by the minute rather than
 * by the hour, and they are never put on screen or into a message — the package is what travels.
 */

import {
  MAX_BUNDLE_BYTES, BundleError, buildReceiptPackage, planSelection, safeFileName,
} from "./receiptBundle.js";

const BUCKET = "receipts";

/** Long enough to download a hundred images on a slow phone, short enough not to be a key. */
export const SIGNED_URL_SECONDS = 300;

/**
 * Ask the server which of these receipts may leave.
 *
 * Returns only what the server released. The caller is told how many were dropped rather than
 * being allowed to assume the answer matches the question.
 */
export async function releaseForBundle(client, receiptIds, subjectId = null) {
  const asked = planSelection(receiptIds);
  const { data, error } = await client.rpc("sarraf_release_receipts_for_bundle", {
    p_document_ids: asked,
    p_subject_id: subjectId || null,
  });
  if (error) throw error;
  const released = (data || []).map((r) => ({
    receiptId: r.document_id,
    trackingCode: r.tracking_code || null,
    storagePath: r.storage_path,
    mimeType: r.mime_type || "image/jpeg",
    state: r.state,
    receivedAt: r.received_at || null,
    // Two identifiers, kept apart. api/read-receipt.js: "Never swap these two IDs."
    orderNo: r.order_no || null,
    merchantOrderNo: r.merchant_order_no || null,
    currency: r.currency || null,
    // Three figures kept apart, as the extraction records them: a receipt that charged a fee and
    // one that did not are different receipts, and the manifest has a column for each.
    gross: r.gross_amount == null ? null : Number(r.gross_amount),
    fee: r.fee_amount == null ? null : Number(r.fee_amount),
    net: r.net_amount == null ? null : Number(r.net_amount),
    payee: r.payee || null,
    txDate: r.tx_date || null,
  }));
  return { asked, released, skipped: asked.length - released.length };
}

/**
 * The name a receipt's image carries inside the archive.
 *
 * The Order No. first, because that is the number a person searches a folder for and the one the
 * system now refuses a receipt without. The tracking code is the fallback rather than the
 * merchant's number: a merchant order number under a name that reads like an order number is the
 * same conflation the partner table was carrying, and it would be worse in a filename, where
 * nothing says which of the two it is.
 */
export function bundleFileName(row, index = 0) {
  const ext = String(row?.mimeType || "").includes("png") ? ".png" : ".jpg";
  const stem = row?.orderNo || row?.trackingCode || row?.receiptId || `receipt-${index + 1}`;
  return safeFileName(`${stem}${ext}`, `receipt-${index + 1}${ext}`);
}

/** The manifest row for one released receipt, in the columns receiptBundle already names. */
export function bundleManifestRow(row, fileName) {
  return {
    fileName,
    orderNo: row?.orderNo ?? "",
    trackingCode: row?.trackingCode ?? "",
    // The headline figure is the gross: what the sender actually sent.
    amount: row?.gross ?? "",
    currency: row?.currency ?? "",
    gross: row?.gross ?? "",
    fee: row?.fee ?? "",
    net: row?.net ?? "",
    // The date on the receipt, falling back to when it reached us — the receipt's own date is
    // what a person matches against a bank statement.
    date: row?.txDate || (row?.receivedAt ? String(row.receivedAt).slice(0, 10) : ""),
    party: row?.payee ?? "",
    transactionId: "",
    state: row?.state ?? "",
    receiptId: row?.receiptId ?? "",
  };
}

/**
 * Short-lived signatures for exactly the paths the server released.
 *
 * createSignedUrls answers in the order it was asked, and a path it could not sign comes back
 * carrying an error rather than throwing — so a single unreadable image must not take the other
 * ninety-nine with it. Those are reported as missing and the rest of the package is built.
 */
export async function signReleasedPaths(client, released, expiresIn = SIGNED_URL_SECONDS) {
  if (!released.length) return { signed: [], missing: [] };
  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrls(released.map((r) => r.storagePath), expiresIn);
  if (error) throw error;
  const signed = [];
  const missing = [];
  (data || []).forEach((entry, i) => {
    const row = released[i];
    if (!row) return;
    if (entry?.signedUrl && !entry.error) signed.push({ ...row, url: entry.signedUrl });
    else missing.push(row.receiptId);
  });
  return { signed, missing };
}

/**
 * Everything: release, sign, fetch, package.
 *
 * `onProgress({ done, total })` is called after each image so a hundred receipts on a phone show
 * something moving. The size ceiling is enforced while fetching rather than only at the end, so
 * a runaway selection stops at the ceiling instead of after filling memory with all of it.
 */
export async function buildBundleForReceipts(client, receiptIds, {
  subjectId = null,
  onProgress = null,
  fetchImpl = null,
  maxBytes = MAX_BUNDLE_BYTES,
  modifiedAt = new Date(),
} = {}) {
  const { asked, released, skipped } = await releaseForBundle(client, receiptIds, subjectId);
  if (released.length === 0) {
    throw new BundleError("nothing_released",
      "the server released none of the selected receipts");
  }
  const { signed, missing } = await signReleasedPaths(client, released);
  if (signed.length === 0) {
    throw new BundleError("nothing_readable", "none of the released receipts could be read");
  }

  const get = fetchImpl || ((url) => fetch(url));
  const files = [];
  const rows = [];
  const unreadable = [...missing];
  let total = 0;

  for (let i = 0; i < signed.length; i += 1) {
    const row = signed[i];
    let bytes = null;
    try {
      const response = await get(row.url);
      if (!response?.ok) throw new Error(`http ${response?.status ?? "?"}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      // One image that will not come down is not a reason to lose the other ninety-nine. It is
      // named in the result so the person can see exactly which receipt is not in the package.
      unreadable.push(row.receiptId);
      if (onProgress) onProgress({ done: i + 1, total: signed.length });
      continue;
    }
    total += bytes.length;
    if (total > maxBytes) {
      throw new BundleError("too_large",
        `the package passed ${maxBytes} bytes at receipt ${i + 1}`);
    }
    const fileName = bundleFileName(row, i);
    files.push({ receiptId: row.receiptId, fileName, bytes });
    rows.push(bundleManifestRow(row, fileName));
    if (onProgress) onProgress({ done: i + 1, total: signed.length });
  }

  if (files.length === 0) {
    throw new BundleError("nothing_readable", "none of the released receipts could be read");
  }

  const { zip, manifest, fileNames } = buildReceiptPackage(files, rows, { modifiedAt });
  return {
    zip,
    manifest,
    fileNames,
    included: files.length,
    // Everything the person asked for that is not in the package, and why.
    askedFor: asked.length,
    skipped,
    unreadable,
  };
}

/**
 * The file name of the package itself. Dated, because a person saving several of these onto a
 * phone needs to tell them apart without opening them.
 */
export function bundleArchiveName(count, when = new Date()) {
  const day = when.toISOString().slice(0, 10);
  return safeFileName(`zeman-receipts-${day}-${count}.zip`, "zeman-receipts.zip");
}

/**
 * Hand the package to the phone: the share sheet where there is one, a download where there is
 * not.
 *
 * navigator.share with files is what puts «بنێررێت بۆ واتس ئەپ» one press away, and it exists on
 * the phones this is used on and not on most desktops. canShare is asked about the actual file
 * rather than only about the API, because a browser may have navigator.share and still refuse a
 * ZIP — and a share that throws after the package is built would lose the work for no reason.
 */
export async function shareOrSaveBundle(zip, fileName, {
  navigatorImpl = typeof navigator === "undefined" ? null : navigator,
  documentImpl = typeof document === "undefined" ? null : document,
  urlImpl = typeof URL === "undefined" ? null : URL,
  title = "ZEMAN",
} = {}) {
  const file = typeof File === "function"
    ? new File([zip], fileName, { type: "application/zip" })
    : null;

  if (file && navigatorImpl?.share
      && (!navigatorImpl.canShare || navigatorImpl.canShare({ files: [file] }))) {
    try {
      await navigatorImpl.share({ files: [file], title });
      return "shared";
    } catch (error) {
      // A person who closes the share sheet has not hit an error, and must not be shown one.
      if (error?.name === "AbortError") return "cancelled";
      // Anything else: fall through and save the file, so the work is not lost.
    }
  }

  if (!documentImpl || !urlImpl) throw new BundleError("no_target", "nowhere to put the package");
  const blob = new Blob([zip], { type: "application/zip" });
  const href = urlImpl.createObjectURL(blob);
  const link = documentImpl.createElement("a");
  link.href = href;
  link.download = fileName;
  documentImpl.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download on some browsers; a tick is enough.
  setTimeout(() => urlImpl.revokeObjectURL(href), 10_000);
  return "saved";
}
