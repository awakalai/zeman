/**
 * Where a fault goes when nobody is watching.
 *
 * Until now: `console.error`, into the console of a phone belonging to somebody who will never
 * open it. Every defect found this month was found because a person hit it, photographed the
 * screen, and sent the picture. That works while the only user is the person who built it. It
 * does not survive being sold to a business three cities away.
 *
 * Three rules, and they are the whole design:
 *
 *   1. It never makes a bad moment worse. Every call is fire-and-forget, wrapped, and swallows
 *      its own failure. A screen that has already broken must not then fail to report.
 *   2. It records the least that lets somebody find the fault. No amounts, no names, no ids,
 *      no tokens, no typed text, no full stack.
 *   3. A deliberate refusal is not a fault. The eight SQLSTATEs this system raises on purpose
 *      are normal operation; recording them would bury the real faults under thousands of
 *      "the reason is too short".
 */
import { describeError } from "./userFacingError.js";

/** Which screen, from a fixed list. Never a URL — a URL can carry an id, and an id is data. */
const SCREENS = new Set([
  "dash", "newtx", "txs", "receipts", "people", "report", "safes", "rates",
  "profit", "approvals", "admin", "portal", "signin", "unknown",
]);

export const faultScreen = (page) => (SCREENS.has(String(page)) ? String(page) : "unknown");

/**
 * A name for the fault, stable across occurrences and carrying nothing readable.
 *
 * The first frame of a stack identifies a fault; the rest of the stack identifies the person's
 * session. So only the first frame is used, and it is hashed rather than sent — the fingerprint
 * groups two crashes without ever telling anyone what the file was called.
 */
export function faultFingerprint(kind, code, screen, stack = "") {
  const frame = String(stack).split("\n").slice(0, 2).join(" ").replace(/\d+/g, "");
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const seed = `${kind}|${code}|${screen}|${frame}`;
  for (let i = 0; i < seed.length; i += 1) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 32);
}

/** The browser, coarsely. Enough to say "only on iPhone", not enough to name a device. */
const agent = () => {
  const ua = String(globalThis.navigator?.userAgent || "");
  const engine = /Firefox/.test(ua) ? "Firefox"
    : /Edg\//.test(ua) ? "Edge"
    : /Chrome/.test(ua) ? "Chrome"
    : /Safari/.test(ua) ? "Safari" : "other";
  const os = /iPhone|iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS/.test(ua) ? "macOS" : "other";
  return `${engine} · ${os}`;
};

/**
 * Report a fault. Returns nothing and throws nothing, ever.
 *
 * @param kind   "render" — a component threw; "command" — a command failed; "load" — data would
 *               not load. Anything else is treated as "render" by the server.
 * @param cause  the error itself
 * @param page   which screen the person was on
 * @param stack  optional; the first frame is used to name the fault and is never sent
 */
export function reportFault(kind, cause, page, stack = "") {
  try {
    const described = describeError(cause);
    // A refusal the system wrote on purpose is the system working. Not a fault.
    if (described.deliberate) return;

    const screen = faultScreen(page);
    const code = String(described.code || "ZE-UNKNOWN").slice(0, 40);
    const print = faultFingerprint(kind, code, screen, stack || cause?.stack || "");

    // Only for faults nobody wrote for a reader — and only the first line, capped hard. A
    // deliberate refusal never reaches here, so this can never carry a sentence about money.
    const detail = String(cause?.name || "").slice(0, 40)
      + (cause?.message ? `: ${String(cause.message).split("\n")[0].slice(0, 150)}` : "");

    // The client is imported here rather than at the top of the file on purpose. This module
    // is otherwise pure — a fingerprint, a screen name, a decision — and pulling the transport
    // in at load time would make all of that impossible to test without a browser's
    // environment. It also means a missing client cannot break the module that exists to cope
    // with things being broken.
    import("../lib/supabase.js").then(({ supabase }) => {
      const call = supabase.rpc("sarraf_record_fault", {
        p_kind: kind, p_code: code, p_screen: screen,
        p_fingerprint: print, p_detail: detail.slice(0, 200), p_agent: agent(),
      });
      // Fire and forget. A reporter that can fail loudly is a second fault on top of the first.
      call?.then?.(() => {}, () => {});
    }, () => {});
  } catch {
    // Deliberately empty. There is nothing useful to do when the thing that records failures
    // is itself the thing that failed.
  }
}

/** How the manager reads them. */
export async function loadFaults(client, days = 14) {
  const { data, error } = await client.rpc("sarraf_faults", { p_days: days });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}
