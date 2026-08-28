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
  // Reachable, not filed. Some are entries in the tools list; the ones that are part of the day
  // — closing it, setting the rates — are a line on the screen with a press of their own, which
  // is the whole point of the rebuild.
  for (const page of adminPages) {
    const listed = new RegExp(`\\["${page}"`).test(app);
    const pressed = new RegExp(`go\\("${page}"\\)`).test(app);
    assert.ok(listed || pressed, `${page} cannot be reached from the admin center`);
  }
});

test("every admin center destination remains mounted and keeps the center navigation active", () => {
  assert.match(app, /id === "admin-center" \? ADMIN_CENTER_PAGE_IDS\.has\(page\)/);
  assert.match(app, /ADMIN_CENTER_PAGE_IDS\.has\(page\) && page !== "admin-center"/);
  for (const page of adminPages) {
    assert.match(app, new RegExp(`page === "${page}"`), `${page} route is no longer mounted`);
  }
});
