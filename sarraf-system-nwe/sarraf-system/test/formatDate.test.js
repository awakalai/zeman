import test from "node:test";
import assert from "node:assert/strict";
import { DATE_LOCALE, formatDate, formatDateTime, formatTime, isoDate } from "../src/services/formatDate.js";

/**
 * Seventy-three calls wrote dates directly, in two different locales. They agreed by luck. This
 * module does not change how a date looks — it gives the decision one home, so selling into a
 * market that writes dates differently is one function rather than seventy-three edits.
 */

test("dates keep the form this interface has always shown", () => {
  assert.equal(DATE_LOCALE, "en-GB", "changing this reformats every date on every screen");
  assert.equal(formatDate("2026-08-27T15:04:33Z"), "27/08/2026");
  assert.equal(formatDate(new Date("2026-01-05T00:00:00Z")), "05/01/2026");
});

test("a missing or unreadable date is a dash, never today and never Invalid Date", () => {
  for (const value of [null, undefined, "", "not a date", NaN]) {
    assert.equal(formatDate(value), "—", `${String(value)} was not handled`);
    assert.equal(formatDateTime(value), "—");
    assert.equal(formatTime(value), "—");
    assert.equal(isoDate(value), "");
  }
});

test("a caller may say what to show instead of a dash", () => {
  assert.equal(formatDate(null, { fallback: "هێشتا نا" }), "هێشتا نا");
});

test("the machine-readable form is never localised", () => {
  assert.equal(isoDate("2026-08-27T22:30:00Z"), "2026-08-27");
  assert.equal(isoDate(new Date(Date.UTC(2026, 0, 1))), "2026-01-01");
});

test("a time and a date-time are both available, in the same locale", () => {
  assert.match(formatTime("2026-08-27T15:04:33Z"), /^\d{2}:\d{2}:\d{2}$/);
  assert.match(formatDateTime("2026-08-27T15:04:33Z"), /^27\/08\/2026/);
});
