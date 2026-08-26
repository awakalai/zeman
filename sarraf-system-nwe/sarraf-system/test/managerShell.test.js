import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The manager gets a different application, not the same one with two extra menu entries.
 *
 * A manager belongs to no business. "New transaction", "Transactions", "Reports" and the
 * dashboard totals all mean one business's, and there is no such business for the person who
 * sold the software — so offering those is offering an action with no correct answer. What they
 * do have is the installation: which businesses run on it, who is in them, and whether it is
 * sound.
 *
 * These read the source rather than render it, because what is being checked is a decision about
 * which navigation exists for whom, and that decision is a literal in the file. The role gate
 * boots a browser and covers the screens; this covers the branch it depends on being there.
 */

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

const managerNav = (() => {
  const start = source.indexOf("const MANAGER_NAV_GROUPS");
  assert.ok(start > 0, "the manager has no navigation of their own");
  const end = source.indexOf("const NAV_GROUPS", start);
  assert.ok(end > start, "MANAGER_NAV_GROUPS is not followed by NAV_GROUPS");
  return source.slice(start, end);
})();

test("the manager's navigation is chosen by rank, not merged into everyone's", () => {
  assert.match(source, /const NAV_GROUPS = isSystemManager \? MANAGER_NAV_GROUPS :/,
    "the manager's navigation is not selected by rank");
});

test("no screen belonging to one business appears in the manager's navigation", () => {
  for (const id of ["\"dash\"", "\"newtx\"", "\"txs\"", "\"receipts\"", "\"people\"", "\"report\""]) {
    assert.ok(!managerNav.includes(`[${id}`),
      `${id} is one business's screen and must not be in the manager's navigation`);
  }
});

test("the manager's navigation carries the installation and its health", () => {
  for (const id of ["manager-console", "manager-center", "integrity", "audit", "backup"]) {
    assert.ok(managerNav.includes(`"${id}"`), `${id} is missing from the manager's navigation`);
  }
});

test("the manager lands on the businesses, not on an exchange's dashboard", () => {
  assert.match(source, /adminLevel === "manager" && page === "dash"[\s\S]{0,120}setPage\("manager-console"\)/,
    "the manager still lands on the trading dashboard");
});

// A manager who has navigated somewhere must stay there. Redirecting on every render would make
// the rest of the application unreachable to them, which is a different bug wearing this fix.
test("the landing redirect happens once, not on every render", () => {
  assert.match(source, /managerLandingDone\.current = true/,
    "nothing stops the manager being sent back to the console repeatedly");
  assert.match(source, /if \(managerLandingDone\.current\) return;/,
    "the redirect does not check whether it has already run");
});

// ── the admin centre belongs to a business, and the manager is not in one ────

const hub = (() => {
  const start = source.indexOf("function AdminCenterHub(");
  assert.ok(start > 0, "the admin centre hub is gone");
  const end = source.indexOf("\n  return (", start);
  return source.slice(start, end);
})();

test("the manager cannot open the admin centre at all", () => {
  assert.match(source, /page === "admin-center" && !isSystemManager && <AdminCenterHub/,
    "the manager can still open one business's admin centre");
});

// This is the door they actually fell through. Integrity, the change log and data protection are
// on the manager's own navigation and are also filed under the admin centre, so the "back"
// link appeared for them and led into the exchange's hub.
test("the way back sends each rank where they came from", () => {
  assert.match(source, /setPage\(isSystemManager \? "manager-console" : "admin-center"\)/,
    "the back link still sends the manager into a business's admin centre");
});

test("the manager's own screens are not listed inside a business's admin centre", () => {
  for (const id of ["manager-console", "manager-center"]) {
    assert.ok(!hub.includes(`"${id}"`),
      `${id} belongs to the manager's navigation, not to an owner's admin centre`);
  }
  assert.ok(!hub.includes("isManager"),
    "the hub still filters rows by rank, which means it still holds rows for another rank");
});

// Eleven entries under one heading is not a list, it is a wall: nobody scans it, they hunt
// through it. Nothing was removed — every screen that was reachable still is.
test("no section of the admin centre is a wall of entries", () => {
  const sections = hub.split(/title: label\(/).slice(1);
  assert.ok(sections.length >= 4, `expected the hub to be grouped, found ${sections.length} sections`);
  for (const section of sections) {
    const count = (section.match(/^\s{8}\["/gm) || []).length;
    assert.ok(count <= 4, `a section holds ${count} entries; four is the most that reads as a group`);
  }
});

test("every screen the admin centre used to offer is still offered", () => {
  for (const id of ["action-inbox", "approvals", "close", "receipt-review", "receipt-forwarding",
                    "partner-holdings", "debt-center", "cashbox", "partner-accounts",
                    "office-payments", "insights", "integrity", "audit", "export-audit", "backup"]) {
    assert.ok(hub.includes(`"${id}"`), `${id} disappeared from the admin centre`);
  }
});

// Two screens called "پشکنینی فیش" meant opening the wrong one and concluding the right one was
// broken. Names inside one navigation must be distinct.
test("no two entries share a name", () => {
  const names = [...hub.matchAll(/label\("([^"]+)", "([^"]+)"/g)]
    .map((m) => m[2])
    .filter((n) => n !== "Daily operations");
  const seen = new Set();
  for (const n of names) {
    assert.ok(!seen.has(n), `"${n}" names two different screens`);
    seen.add(n);
  }
});
