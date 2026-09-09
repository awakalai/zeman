import test from "node:test";
import assert from "node:assert/strict";

/**
 * Which business needs the vendor, and why.
 *
 * The list of businesses answers "what exists". The live database had one nobody had ever been
 * inside and the console said nothing. It took a database inspection to find, and the vendor
 * would have found out when the customer rang.
 *
 * A single "unhealthy" flag would collapse "nobody has ever signed in" and "quiet for forty
 * days" into one colour. They are different problems with different answers.
 */
const { attentionReasons } = await import("../src/services/managerConsole.js");

test("a business nobody has opened says so, first", () => {
  const reasons = attentionReasons({ never_opened: true, active: true }, "en");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /Nobody has ever signed in/);
});

test("a business with nothing wrong says nothing", () => {
  assert.deepEqual(attentionReasons({ never_opened: false, active: true, quiet: false }, "en"), []);
  assert.deepEqual(attentionReasons({}, "ku"), []);
});

test("each reason is its own sentence, not one flag", () => {
  const reasons = attentionReasons(
    { never_opened: true, active: false, quiet: true, receipts_waiting: 3 }, "en");
  assert.equal(reasons.length, 4, `expected four distinct reasons, got: ${reasons.join(" | ")}`);
  assert.equal(new Set(reasons).size, 4, "two reasons read the same");
});

test("a count is shown where a count is what is meant", () => {
  const reasons = attentionReasons({ receipts_waiting: 7, active: true }, "en");
  assert.match(reasons[0], /\(7\)/);
});

test("zero is not a reason", () => {
  const reasons = attentionReasons(
    { active: true, receipts_waiting: 0, entries_unposted: 0, waiting_to_claim: 0 }, "en");
  assert.deepEqual(reasons, []);
});

test("every reason reads in the language it was asked for", () => {
  const business = { never_opened: true, active: false, quiet: true };
  const ku = attentionReasons(business, "ku");
  const en = attentionReasons(business, "en");
  const ar = attentionReasons(business, "ar");
  assert.equal(ku.length, en.length);
  assert.equal(en.length, ar.length);
  for (let i = 0; i < en.length; i += 1) {
    assert.match(en[i], /[A-Za-z]/, `the English reason ${i} is not in English`);
    assert.notEqual(ku[i], en[i], `reason ${i} is the same in Kurdish and English`);
    assert.notEqual(en[i], ar[i], `reason ${i} is the same in English and Arabic`);
  }
});

test("the suspended reason says it still reads, which is the whole point", () => {
  const reasons = attentionReasons({ active: false }, "en");
  assert.match(reasons[0], /reads/i,
    "a suspended business keeps every right to read its own books, and the console should say so");
});
