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
