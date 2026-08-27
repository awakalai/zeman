/**
 * When something happened, written the same way everywhere.
 *
 * There are seventy-three calls to `toLocaleDateString("en-GB")`, `toLocaleString("en-GB")` and
 * `toLocaleString("en-US")` scattered through the screens. They agree today by luck rather than
 * by design: two different locales are in use, and the next person to write a date will pick a
 * third.
 *
 * This changes nothing about what a date looks like right now — that is deliberate. A product
 * being sold this week should not suddenly start writing 08/27/2026 where it used to write
 * 27/08/2026, and a Kurdish or Arabic locale would reformat every date on every screen. What it
 * changes is that there is now ONE place to decide it, so the day this product is sold into a
 * market that writes dates differently, it is one function and not seventy-three edits.
 *
 * `en-GB` because day-month-year is what the interface has always shown and what the region
 * reads; the digits stay Latin because every number in this system is written in Latin digits so
 * that an amount and a date cannot be misread for one another.
 */

/** The locale dates are written in. One constant, so the decision has one home. */
export const DATE_LOCALE = "en-GB";

const asDate = (value) => {
  if (value instanceof Date) return value;
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 27/08/2026 */
export function formatDate(value, { fallback = "—" } = {}) {
  const d = asDate(value);
  return d ? d.toLocaleDateString(DATE_LOCALE) : fallback;
}

/** 27/08/2026, 15:04:33 */
export function formatDateTime(value, { fallback = "—" } = {}) {
  const d = asDate(value);
  return d ? d.toLocaleString(DATE_LOCALE) : fallback;
}

/** 15:04:33 */
export function formatTime(value, { fallback = "—" } = {}) {
  const d = asDate(value);
  return d ? d.toLocaleTimeString(DATE_LOCALE) : fallback;
}

/** 2026-08-27 — the form a date input and the database both take. Never localised. */
export function isoDate(value) {
  const d = asDate(value);
  return d ? d.toISOString().slice(0, 10) : "";
}
