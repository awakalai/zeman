import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

const adminPages = [
  "action-inbox",
  "approvals",
  "close",
  "insights",
  "integrity",
  "audit",
  "export-audit",
  "backup",
];

// The entry is named for the work, not for a cabinet. «ناوەندی بەڕێوەبردن» described where the
// tools were filed; «کاری ئەمڕۆ» describes what the screen answers.
test("the sidebar exposes one admin center instead of hiding admin features", () => {
  assert.match(app, /\["admin-center", navSectionLabel\("کاری ئەمڕۆ"/);
  assert.match(app, /function AdminCenterHub/);
  // Reachable, and now by name rather than out of a drawer: each is either an entry in one of
  // the six sections or a line on a screen with a press of its own.
  for (const page of adminPages) {
    const listed = new RegExp(`\\["${page}"`).test(app);
    const pressed = new RegExp(`go\\("${page}"\\)`).test(app);
    assert.ok(listed || pressed, `${page} cannot be reached from anywhere`);
  }
});

// The sixteen-tool drawer at the foot of «کاری ئەمڕۆ» is gone: every one of those screens now
// has a named place in one of the six sections. So what this test protects is no longer "the
// drawer lists them" but the thing the drawer was standing in for — none of them became
// unreachable. It caught a real one the moment the drawer was deleted: action-inbox had nav:0
// and press:0, reachable from nowhere at all.
test("every admin center destination remains mounted and reachable", () => {
  // Exactly one navigation entry lights up. It used to be that «کاری ئەمڕۆ» claimed every page
  // in ADMIN_CENTER_PAGE_IDS, which was right while those pages had no entry of their own and
  // is wrong now that they do.
  assert.match(app, /const isNavActive = \(id\) => id === "admin-center"/);
  assert.doesNotMatch(app, /id === "admin-center" \? ADMIN_CENTER_PAGE_IDS\.has\(page\)/,
    "one page must not light up two navigation entries");
  for (const page of adminPages) {
    assert.match(app, new RegExp(`page === "${page}"`), `${page} route is no longer mounted`);
  }
});

// The drawer must stay gone. A grid of sixteen buttons at the foot of one page is what the owner
// meant by «جەنجاڵ», and it is the easiest thing in the world to put back one entry at a time.
test("the tools drawer does not come back", () => {
  assert.doesNotMatch(app, /today-tools/);
  assert.doesNotMatch(app, /\{tools\.map\(/);
});
