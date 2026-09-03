import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

// «ئینباکسی کارەکان» is deliberately not here any more. It was a second screen answering the
// same question «کاری ئەمڕۆ» answers — what is waiting — from the server while the hub answered
// from the browser. Its content did not go anywhere; it renders inside the hub now, which the
// test below asserts. A destination that no longer exists must not be required to have a door.
const adminPages = [
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
  // The inbox merged rather than vanished: the hub renders the server's own list of what is
  // waiting. Without this, deleting the entry would look identical to deleting the feature.
  // Matched on the render itself, not on the page test. The first version of this assertion
  // looked for `page === "admin-center" || page === "action-inbox"` and was satisfied by
  // isNavActive, which contains the same words for an unrelated reason — so it passed with the
  // inbox's render deleted. The condition and the component have to appear together.
  assert.match(app, /page === "admin-center" \|\| page === "action-inbox"\)[^]{0,200}<ActionInbox/,
    "the action inbox no longer renders on «کاری ئەمڕۆ»");
  // And it is not offered as a separate door, which is what made it two answers to one question.
  assert.ok(!/\["action-inbox"/.test(app), "the inbox is a separate destination again");
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


// ── the way back belongs to the route, not to the page ──────────────────────
//
// «گەڕانەوە بۆ ناوەندی بەڕێوەبردن» was rendered for every page in ADMIN_CENTER_PAGE_IDS.
// That was right when those pages had no entry of their own. Twenty of the twenty-one are in
// the six sections now, so somebody opening «پشکنین» from the sidebar was offered a way back
// to a place they had never been.
//
// The admin centre still leads to seven of them, and for a person who arrived that way the
// link is exactly right — so it depends on the route, and the route has to be remembered.
// The browser gate walks the sidebar half; this pins the mechanism, which that gate cannot
// reach because the hub shows a line only when something is waiting.
test("the way back is offered only to somebody who came that way", () => {
  assert.match(app, /cameFromHub && ADMIN_CENTER_PAGE_IDS\.has\(page\)/,
    "the admin-centre link is still shown by page identity rather than by route");
  assert.match(app, /onNavigate=\{\(id\) => \{ setCameFromHub\(true\); setPage\(id\); \}\}/,
    "the admin centre does not record that it was the way in");
});

// One door, because a fourth call site is easy to add and easy to forget.
test("every navigation entry opens a page through one helper", () => {
  assert.match(app, /const openPage = \(id\) => \{ setCameFromHub\(false\);/,
    "there is no single place that decides what opening a page means");
  const direct = [...app.matchAll(/onClick=\{\(\) => \{ setPage\(id\)/g)].length;
  assert.equal(direct, 0,
    "a navigation entry still calls setPage directly, so it cannot clear the way-back link");
});
