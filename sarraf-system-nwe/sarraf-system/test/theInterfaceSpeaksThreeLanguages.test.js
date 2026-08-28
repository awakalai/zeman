import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DICT } from "../src/i18n/dictionary.js";

/**
 * tr("…") returns the Kurdish key when the dictionary has no entry for it.
 *
 * That is the right thing to do at runtime — a screen with a Kurdish word on it is better than a
 * screen that throws — and it is the reason a missing translation is invisible in review. The
 * page renders, nothing goes red, and an English reader is simply shown Kurdish. 114 keys had
 * been sitting there like that, among them the receipt totals, the refusals, and every
 * instruction on the portal a customer-seller uses.
 *
 * So the keys are read back out of the source here and required to exist, in both languages.
 */

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.jsx?$/.test(entry)) files.push(full);
  }
})(new URL("../src", import.meta.url).pathname);

const KURDISH = /[؀-ۿ]/;
const keysAskedFor = () => {
  const keys = new Set();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
      keys.add(m[1].replace(/\\"/g, '"'));
    }
  }
  return [...keys].filter((k) => KURDISH.test(k));
};

test("every key the interface asks for has an English and an Arabic entry", () => {
  const missing = keysAskedFor().filter((k) => !DICT.en[k] || !DICT.ar[k]);
  assert.deepEqual(missing, [], `${missing.length} key(s) would render as Kurdish to everybody`);
});

test("the two dictionaries carry the same keys", () => {
  const enOnly = Object.keys(DICT.en).filter((k) => !Object.hasOwn(DICT.ar, k));
  const arOnly = Object.keys(DICT.ar).filter((k) => !Object.hasOwn(DICT.en, k));
  assert.deepEqual(enOnly, [], "keys with an English entry and no Arabic one");
  assert.deepEqual(arOnly, [], "keys with an Arabic entry and no English one");
});

test("no entry is blank", () => {
  for (const lang of ["en", "ar"]) {
    for (const [key, value] of Object.entries(DICT[lang])) {
      assert.ok(typeof value === "string" && value.trim() !== "", `${lang} entry for ${key} is empty`);
    }
  }
});

test("an English entry is not the Kurdish key copied across", () => {
  // A key that is a numeral, a percent sign or already written in English reads the same in every
  // language. Anything else that comes back identical is a placeholder nobody finished.
  const sameInEveryLanguage = (k) => !KURDISH.test(k);
  const copied = Object.entries(DICT.en)
    .filter(([k, v]) => v === k && !sameInEveryLanguage(k))
    .map(([k]) => k);
  assert.deepEqual(copied, [], "English entries that are still the Kurdish text");
});

test("the money words are the ones an accountant would use", () => {
  // Not a style check: these six carry a number next to them on the screen, and a reader who
  // takes "unrealised profit" for "profit" reads the business wrongly.
  const expected = {
    "خێر": ["Profit", "الربح"],
    "زەرەر": ["Loss", "الخسارة"],
    "کۆی خێری نەکراو": ["Total unrealised profit", "إجمالي الربح غير المحقق"],
    "کۆی گشتی (بەبێ فی)": ["Total (excluding fee)", "الإجمالي (بدون الرسوم)"],
    "گەیشتوو (بەبێ فی)": ["Received (excluding fee)", "المستلم (بدون الرسوم)"],
    "فی": ["Fee", "الرسوم"],
  };
  for (const [key, [en, ar]] of Object.entries(expected)) {
    assert.equal(DICT.en[key], en, `English for ${key}`);
    assert.equal(DICT.ar[key], ar, `Arabic for ${key}`);
  }
});

test("a translated label never becomes the value written to the ledger", () => {
  // The expense categories were a list of translated strings used as both the label and the
  // option's value, so «خێری وەبەرهێنەر» became "Investor profit" the moment somebody switched
  // to English — and the payout branch, which compares against the Kurdish word, stopped firing.
  // One category would also have been stored under three spellings, one per language.
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const declaration = app.match(/const XCATS = \[(.*?)\]/s);
  assert.ok(declaration, "XCATS is no longer declared as a list");
  assert.ok(!/tr\("/.test(declaration[1]),
    "an expense category is translated where it is declared — the stored value must stay Kurdish");
  assert.ok(/<option key=\{category\} value=\{category\}>\{label\}<\/option>/.test(app),
    "the option no longer separates the stored category from the label the reader sees");
  assert.ok(app.includes('const isPayout = xf.category === "خێری وەبەرهێنەر";'),
    "the payout branch compares against something other than the stored Kurdish category");
});
