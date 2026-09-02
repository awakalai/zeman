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
  // The whole component, markup included: what the screen shows and in what order is the thing
  // being checked, and that lives after the return.
  const end = source.indexOf("\nconst Pill = ", start);
  assert.ok(end > start, "the hub is no longer followed by Pill");
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

// It was fifteen cards under five headings that said the same thing every morning. The owner's
// answer to "what is your day made of" was «بە گشتی فیشەکان», so the screen is the day: receipts
// first, then the rates without which nothing can be valued, then whatever is waiting.
test("the screen opens on the receipts, because that is most of the day", () => {
  const receipts = hub.indexOf('id="today-receipts"');
  const rates = hub.indexOf('id="today-rates"');
  assert.ok(receipts > 0, "the receipts section is gone");
  assert.ok(rates > receipts, "the rates are shown above the receipts");
  // The tools section that used to sit below these is gone: sixteen buttons at the foot of one
  // page is a drawer, not a section, and each of those screens now has a named place in the
  // navigation. This screen is what its title says — the work waiting today.
  assert.ok(!hub.includes('id="today-tools"'), "the tools drawer is back");
});

// A screen that prints four zeroes every morning is a screen that teaches you not to read it.
test("a line with nothing waiting behind it is not drawn", () => {
  assert.match(hub, /\{approvals > 0 && \(/, "approvals are drawn even when there are none");
  assert.match(hub, /\{unpaid > 0 && \(/, "unpaid transactions are drawn even when there are none");
  assert.match(hub, /\{waiting\.length > 0 && \(/, "the batch call to action is drawn on an empty day");
  assert.match(hub, /officesOwed\.map/, "an office owed nothing still gets a line");
});

// Every count comes from the same data the screen it links to reads, so a summary saying four
// cannot lead to a list showing three.
test("the counts are read, not stored", () => {
  assert.match(hub, /const stageOf = \(b\) =>/, "the screen no longer derives the batch stage itself");
  assert.match(hub, /unpricedCurrencies\(data\?\.currencies \|\| \[\]\)/, "the rates check is not the one the rest of the app uses");
});

// The guarantee this has always protected is that none of these screens becomes unreachable. It
// used to be satisfied by the tools drawer listing them; now it is satisfied by the six sections
// naming them. So it reads the whole file rather than the hub — and it earned its keep the moment
// the drawer was deleted, when action-inbox was left reachable from nowhere at all.
test("every screen the admin centre used to offer is still one press away", () => {
  for (const id of ["action-inbox", "approvals", "close", "receipt-review", "receipt-forwarding",
                    "partner-holdings", "debt-center", "cashbox", "partner-accounts",
                    "office-payments", "insights", "integrity", "audit", "export-audit", "backup"]) {
    const listed = new RegExp(`\\["${id}"`).test(source);
    const pressed = new RegExp(`go\\("${id}"\\)`).test(source);
    assert.ok(listed || pressed, `${id} is reachable from nowhere`);
  }
});

// Two screens called "پشکنینی فیش" meant opening the wrong one and concluding the right one was
// broken. Names inside one navigation must be distinct.
test("no two entries share a name", () => {
  // The entries themselves, wherever they are declared — the navigation now, the tools drawer
  // before. A name repeated in the prose of a tile that points at the same screen is the screen
  // being called what it is called twice, which is the opposite of the problem: two different
  // destinations wearing one name.
  const entries = [...source.matchAll(/\["([a-z-]+)", (?:label|navSectionLabel)\("[^"]+", "([^"]+)"/g)];
  assert.ok(entries.length >= 10, `expected the navigation to be listed, found ${entries.length}`);
  const seen = new Map();
  for (const [, id, name] of entries) {
    assert.ok(!seen.has(name) || seen.get(name) === id,
      `"${name}" names both ${seen.get(name)} and ${id}`);
    seen.set(name, id);
  }
});
