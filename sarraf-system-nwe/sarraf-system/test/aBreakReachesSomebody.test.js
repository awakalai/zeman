import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { faultFingerprint, faultScreen } from "../src/services/faultReport.js";

/**
 * Until now a fault at a customer's went to `console.error` — the console of a phone belonging
 * to somebody who will never open it. Every defect found this month was found because a person
 * hit it, photographed the screen and sent the picture. That is not a way to run a system
 * somebody has paid for.
 *
 * The danger in fixing it is that an error reporter is a write path a user can trigger at will,
 * in an application that holds other people's money. These are the three things that must stay
 * true of it.
 */

test("a fault is named without saying anything about the person who hit it", () => {
  const stack = "TypeError: r.map is not a function\n  at Receipts (/home/leyla/app.js:4210:19)";
  const print = faultFingerprint("render", "ZE-UNKNOWN", "receipts", stack);
  assert.match(print, /^[0-9a-f]{16,32}$/, "a fingerprint is a hash and nothing else");
  assert.ok(!print.includes("leyla"), "a path from somebody's machine reached the fingerprint");
  assert.ok(!/app\.js|Receipts/.test(print), "readable text reached the fingerprint");
});

test("the same fault twice has the same name, so it can be counted rather than piled up", () => {
  const a = faultFingerprint("render", "ZE-UNKNOWN", "receipts", "at X (file.js:10:5)");
  const b = faultFingerprint("render", "ZE-UNKNOWN", "receipts", "at X (file.js:98:2)");
  assert.equal(a, b, "the same fault at a different line is a different fault");
  const c = faultFingerprint("render", "ZE-UNKNOWN", "newtx", "at X (file.js:10:5)");
  assert.notEqual(a, c, "two different screens share one fingerprint");
});

test("the screen is one of a fixed list, never a URL", () => {
  assert.equal(faultScreen("receipts"), "receipts");
  // A URL can carry a receipt id, and an id is data about somebody's money.
  assert.equal(faultScreen("/receipts/ZR-20260828-101500-a1b2c3"), "unknown");
  assert.equal(faultScreen(undefined), "unknown");
  assert.equal(faultScreen("' or 1=1 --"), "unknown");
});

test("a refusal the system wrote on purpose is not a fault", () => {
  const src = readFileSync(new URL("../src/services/faultReport.js", import.meta.url), "utf8");
  assert.ok(/if \(described\.deliberate\) return;/.test(src),
    "deliberate refusals would be recorded — the real faults would be buried under them");
});

test("reporting can never make a bad moment worse", () => {
  const src = readFileSync(new URL("../src/services/faultReport.js", import.meta.url), "utf8");
  assert.ok(/export function reportFault[\s\S]{0,120}try \{/.test(src),
    "reportFault no longer wraps its whole body");
  assert.ok(/call\?\.then\?\.\(\(\) => \{\}, \(\) => \{\}\)/.test(src),
    "the call is awaited or left to reject — a failed report must not become a second failure");
  assert.ok(/import\("\.\.\/lib\/supabase\.js"\)\.then\(/.test(src),
    "the transport is imported at load time again, which couples the pure logic to a browser");
  // Only reportFault. `loadFaults` below it is the manager reading the list, and that one
  // SHOULD throw — a screen that cannot load its data must say so.
  const start = src.indexOf("export function reportFault");
  const body = src.slice(start, src.indexOf("export async function loadFaults", start));
  assert.ok(!/\bthrow\b/.test(body), "reportFault throws");
});

test("the error boundary tells somebody, not just the console", () => {
  const src = readFileSync(
    new URL("../src/components/system/AppErrorBoundary.jsx", import.meta.url), "utf8");
  assert.ok(/reportFault\("render",/.test(src),
    "a render crash is again written only to a console nobody reads");
});

test("and a failed command does too", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.ok(/reportFault\("command", err, page\)/.test(app),
    "a command that fails for an unknown reason leaves no trace again");
});

/**
 * The crash loop is the failure mode of every error reporter: a component throws on each render
 * and the reporter writes a row each time until the table is the largest thing in the database.
 * The defence is in the schema, not in the caller, so that no future caller can undo it.
 */
test("a crash loop cannot fill the database", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/202608280022_a_break_at_a_customers_reaches_somebody.sql",
      import.meta.url), "utf8");
  assert.ok(/create unique index if not exists zeman_faults_one_per_day/.test(sql),
    "faults are appended rather than counted — a crash loop would fill the table");
  assert.ok(/on conflict \(coalesce\(tenant_id, '⟨none⟩'\), day, fingerprint\) do update/.test(sql),
    "the same fault twice writes a second row instead of counting");
  assert.ok(/if v_distinct >= 20 then/.test(sql),
    "one browser can report unlimited distinct faults");
});

test("and nothing about anybody's money can reach it", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/202608280022_a_break_at_a_customers_reaches_somebody.sql",
      import.meta.url), "utf8");
  for (const bound of [
    /detail is null or char_length\(detail\) <= 200/,
    /char_length\(code\) between 1 and 40/,
    /char_length\(screen\) between 1 and 40/,
  ]) assert.ok(bound.test(sql), `a field is unbounded: ${bound}`);
  assert.ok(/left\(btrim\(coalesce\(p_detail, ''\), \)?/.test(sql) || /left\(btrim\(coalesce\(p_detail/.test(sql),
    "the detail is stored as sent rather than truncated in the command");
});

test("one business's faults stay that business's", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/202608280022_a_break_at_a_customers_reaches_somebody.sql",
      import.meta.url), "utf8");
  assert.ok(/alter table public\.zeman_faults enable row level security/.test(sql));
  assert.ok(/alter table public\.zeman_faults force row level security/.test(sql),
    "a definer function could read every business's faults");
  assert.ok(/create policy zeman_faults_tenant on public\.zeman_faults as restrictive/.test(sql),
    "there is no restrictive tenant policy on the faults table");
});
