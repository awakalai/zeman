export const SHARE_HANDOFF = Object.freeze({
  database: "zeman-receipt-share-v1",
  store: "handoffs",
  expiryMs: 15 * 60 * 1000,
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  source: "share",
});

function openDatabase(indexedDb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDb) return reject(new Error("unavailable"));
    const request = indexedDb.open(SHARE_HANDOFF.database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SHARE_HANDOFF.store, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function safeSharedFilename(value, index = 0) {
  return String(value || "").normalize("NFKC").replace(/[\\/\0-\x1f\x7f]+/g, "_").slice(0, 120) || `shared-receipt-${index + 1}`;
}

export async function validateClaimedSharedFiles(files) {
  const signatures = {
    "image/jpeg": [0xff, 0xd8, 0xff],
    "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "image/webp": [0x52, 0x49, 0x46, 0x46],
  };
  const accepted = [], rejected = [], seen = new Set();
  for (const [index, file] of Array.from(files || []).entries()) {
    let code = null;
    if (index >= SHARE_HANDOFF.maxFiles) code = "count";
    else if (!SHARE_HANDOFF.allowedTypes.includes(file.type)) code = "type";
    else if (!(file.size > 0)) code = "empty";
    else if (file.size > SHARE_HANDOFF.maxFileBytes) code = "oversize";
    const bytes = code ? null : new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!code && !signatures[file.type].every((b, i) => bytes[i] === b)) code = "signature";
    if (!code && file.type === "image/webp" && ![0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[i + 8] === b)) code = "signature";
    if (code) { rejected.push({ code, name: safeSharedFilename(file.name, index) }); continue; }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("");
    if (seen.has(digest)) { rejected.push({ code: "duplicate", name: safeSharedFilename(file.name, index) }); continue; }
    seen.add(digest); accepted.push(file);
  }
  return { accepted, rejected };
}

export async function claimSharedReceiptHandoff(id, owner, { now = Date.now(), indexedDb } = {}) {
  if (!/^[a-f0-9]{48}$/.test(String(id || "")) || !owner) return { status: "invalid" };
  const db = await openDatabase(indexedDb);
  const tx = db.transaction(SHARE_HANDOFF.store, "readwrite");
  const store = tx.objectStore(SHARE_HANDOFF.store);
  const record = await requestResult(store.get(id));
  if (!record) { db.close(); return { status: "missing" }; }
  if (record.expiresAt <= now) { store.delete(id); db.close(); return { status: "expired" }; }
  if (record.owner && record.owner !== owner) { db.close(); return { status: "forbidden" }; }
  if (record.lease) { db.close(); return { status: "consumed" }; }
  const lease = crypto.randomUUID();
  record.owner = owner;
  record.lease = lease;
  store.put(record);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
  const files = record.files.map((item, index) => new File([item.blob], safeSharedFilename(item.name, index), { type: item.type, lastModified: record.createdAt }));
  return { status: "ready", id, lease, files, rejected: record.rejected || [] };
}

export async function finishSharedReceiptHandoff(id, lease, { indexedDb } = {}) {
  const db = await openDatabase(indexedDb);
  const tx = db.transaction(SHARE_HANDOFF.store, "readwrite");
  const store = tx.objectStore(SHARE_HANDOFF.store);
  const record = await requestResult(store.get(id));
  if (record && record.lease === lease) store.delete(id);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
  return !!record && record.lease === lease;
}

export async function releaseSharedReceiptHandoff(id, lease, { indexedDb } = {}) {
  const db = await openDatabase(indexedDb);
  const tx = db.transaction(SHARE_HANDOFF.store, "readwrite");
  const store = tx.objectStore(SHARE_HANDOFF.store);
  const record = await requestResult(store.get(id));
  if (record && record.lease === lease) { record.lease = null; store.put(record); }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
}

export function sharedReceiptMessage(status, rejected = 0) {
  if (status === "loading") return "وێنە هاوبەشکراوەکان ئامادە دەکرێن…";
  if (status === "ready") return rejected ? `وێنەکان هاتن؛ ${rejected} فایل ڕەتکرایەوە. پێداچوونەوە و پشتڕاستکردنەوە پێویستە.` : "وێنەکان هاتن. پێداچوونەوە و پشتڕاستکردنەوە پێویستە.";
  if (status === "expired") return "ماوەی وێنە هاوبەشکراوەکان تەواو بوو؛ تکایە دووبارە هاوبەشیان بکە.";
  if (status === "forbidden") return "ئەم وێنانە بۆ ئەکاونتێکی تر ئامادە کرابوون.";
  return "وێنە هاوبەشکراوەکان دروست نەبوون یان پێشتر وەرگیراون.";
}

// Deterministic contract model used to verify lease/expiry semantics without a browser.
export function createHandoffContractModel() {
  const records = new Map();
  return {
    stage(id, expiresAt) { records.set(id, { expiresAt, owner: null, lease: null }); },
    claim(id, owner, now) {
      const item = records.get(id);
      if (!item) return "missing";
      if (item.expiresAt <= now) { records.delete(id); return "expired"; }
      if (item.owner && item.owner !== owner) return "forbidden";
      if (item.lease) return "consumed";
      item.owner = owner; item.lease = `${id}:${owner}`; return item.lease;
    },
    finish(id, lease) { const item = records.get(id); if (!item || item.lease !== lease) return false; records.delete(id); return true; },
    cleanup(now) { for (const [id, item] of records) if (item.expiresAt <= now) records.delete(id); },
    has(id) { return records.has(id); },
  };
}
