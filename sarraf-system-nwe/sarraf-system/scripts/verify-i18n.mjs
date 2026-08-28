#!/usr/bin/env node
/**
 * How much of this interface can be read by somebody who does not read Kurdish.
 *
 * The mechanism is already here: a dictionary of 473 keys in English and Arabic, `tr()` for a
 * Kurdish key, `l10n(ku, en, ar)` for a phrase written in place, `lang` and `dir` set on the
 * document for each language. What is not here is coverage — well over a thousand sentences are
 * written straight into the markup in Kurdish and cannot be translated at all.
 *
 * Translating them by hand in one week is not a week's work and it is a week's worth of chances
 * to mistranslate a money term. So this does the thing that is actually useful now: it measures,
 * and it RATCHETS. The count as it stands is written down in i18n-baseline.json, and this gate
 * fails if any file's count goes up. The number can only come down.
 *
 * That is what "ready for internationalization" means for a product shipping on a deadline: the
 * hole is measured, it cannot grow, and closing it is ordinary work rather than an archaeology
 * project.
 *
 *   npm run verify:i18n            check against the baseline
 *   npm run verify:i18n -- --write rewrite the baseline (only ever downwards, on purpose)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DICT } from "../src/i18n/dictionary.js";

const ROOT = "src";
const BASELINE = "scripts/i18n-baseline.json";

// Arabic-script text of two characters or more: Kurdish, Arabic and Persian all live here.
const SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]{2,}/;

// A literal already reachable by a translator, or one that IS a translation.
const LOCALISED = /\b(tr|l10n|label|navSectionLabel|lifecycleLabel|systemStatusLabel|kindLabel)\s*\(|(^|[^A-Za-z])(ku|en|ar)\s*:/;

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.jsx?$/.test(entry)) files.push(full);
  }
})(ROOT);

/* ─────────────────────────────────────────────────────────────────────────────
 * Part one, and it does not ratchet: every key the interface asks for by name
 * must exist in both dictionaries.
 *
 * tr("…") falls back to the Kurdish key when the dictionary has no entry, which is the right
 * behaviour at runtime and a silent one in review: the screen renders, and an English reader
 * simply gets Kurdish. There is nothing to notice. So this counts them instead.
 *
 * Three call sites pass a computed key — a lifecycle stage, an outcome, a role — read out of a
 * table. Those tables are registered below and their Kurdish values are required in the
 * dictionary exactly like a literal. A computed key from anywhere else fails the gate, because
 * a table this file does not know about is a hole that reopens without anybody seeing it.
 * ────────────────────────────────────────────────────────────────────────── */
const KURDISH = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LITERAL_KEY = /\btr\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
const COMPUTED_KEY = /\btr\(\s*([^"\s)][^)\n]{0,30})/g;

// file → the expression each computed key starts with, and the table it is read from.
const COMPUTED = {
  "src/components/portal/PortalReceiptSummary.jsx": [["STAGE_LABEL[", "STAGE_LABEL"]],
  "src/components/portal/MyReceipts.jsx": [["outcome.label", "OUTCOME"]],
  "src/App.jsx": [["ROLE_KU[", "ROLE_KU"], ["category", "XCATS"]],
};

// The Kurdish string values of `const NAME = { … }` or `const NAME = [ … ]`, however deep it goes.
const tableValues = (text, name) => {
  const at = text.indexOf(`const ${name} = `);
  if (at < 0) return null;
  const open = text[at + `const ${name} = `.length];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0, end = at;
  for (let i = text.indexOf(open, at); i < text.length; i++) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close && (depth -= 1) === 0) { end = i; break; }
  }
  // In an object the keys are English identifiers and only the values are read; in an array
  // every string is a value.
  const strings = open === "{" ? /:\s*"((?:[^"\\]|\\.)*)"/g : /"((?:[^"\\]|\\.)*)"/g;
  return [...text.slice(at, end).matchAll(strings)].map((m) => m[1]).filter((v) => KURDISH.test(v));
};

const asked = new Map();       // key → the files that ask for it
const unregistered = [];       // computed keys from a table this gate does not know
for (const file of files.sort()) {
  const text = readFileSync(file, "utf8");
  const note = (key) => { if (!asked.has(key)) asked.set(key, new Set()); asked.get(key).add(file); };

  for (const m of text.matchAll(LITERAL_KEY)) note(m[1].replace(/\\"/g, '"'));

  const registered = COMPUTED[file] || [];
  for (const m of text.matchAll(COMPUTED_KEY)) {
    const expression = m[1].trim();
    const known = registered.find(([starts]) => expression.startsWith(starts));
    if (!known) { unregistered.push(`${file}: tr(${expression.slice(0, 40)}…`); continue; }
    const values = tableValues(text, known[1]);
    if (values === null) { unregistered.push(`${file}: ${known[1]} is registered but not declared here`); continue; }
    for (const value of values) note(value);
  }
}

const untranslated = [...asked.keys()]
  .filter((k) => KURDISH.test(k))
  .filter((k) => !DICT.en[k] || !DICT.ar[k])
  .sort();

if (untranslated.length || unregistered.length) {
  for (const key of untranslated) {
    const where = [...asked.get(key)].join(", ");
    const gap = !DICT.en[key] && !DICT.ar[key] ? "no English, no Arabic"
      : !DICT.en[key] ? "no English" : "no Arabic";
    console.log(`FAIL  ${gap.padEnd(21)} ${key}   (${where})`);
  }
  for (const line of unregistered) console.log(`FAIL  computed key from an unregistered table — ${line}`);
  if (untranslated.length) {
    console.log(`\n${untranslated.length} key(s) the interface asks for are missing from src/i18n/dictionary.js.`);
    console.log("tr() falls back to the Kurdish key, so these render as Kurdish to an English or Arabic reader.");
  }
  if (unregistered.length) {
    console.log(`\n${unregistered.length} computed key(s) come from a table this gate cannot read.`);
    console.log("Register the file and its table in COMPUTED above, so its Kurdish values are required too.");
  }
  process.exit(1);
}

const spare = Object.keys(DICT.en).filter((k) => !Object.hasOwn(DICT.ar, k))
  .concat(Object.keys(DICT.ar).filter((k) => !Object.hasOwn(DICT.en, k)));
if (spare.length) {
  for (const key of spare) console.log(`FAIL  in one dictionary only: ${key}`);
  process.exit(1);
}

console.log(
  `Dictionary: ${asked.size} key(s) asked for by the interface, every one of them in English and `
  + `Arabic (${Object.keys(DICT.en).length} entries each).`
);

// A translation table — `COPY = { ku: { … }, en: { … }, ar: { … } }` — is localised text by
// construction, but only its opening line carries the language key, so every line inside it was
// counted as unreachable. Several components are written that way and each was reported as dozens
// of lines of untranslatable interface while being translated three times over.
//
// Only when all three arms are really there. `COPY.en = COPY.ku; COPY.ar = COPY.ku` is an alias,
// not a translation — a component written that way shows Kurdish to an English reader, which is
// the exact thing being counted, and skipping it would have hidden a whole file.
const TABLE_OPENS = /^\s*(?:ku|en|ar)\s*:\s*\{/;
const ARM = (lang) => new RegExp(`^\\s*${lang}\\s*:\\s*\\{`, "m");
const depthOf = (line) => (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

const counts = {};
for (const file of files.sort()) {
  const text = readFileSync(file, "utf8");
  const translated = ARM("ku").test(text) && ARM("en").test(text) && ARM("ar").test(text);
  let n = 0, inTable = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inTable > 0) {
      inTable += depthOf(raw);
      continue;
    }
    if (translated && TABLE_OPENS.test(raw)) {
      inTable = depthOf(raw);
      continue;
    }
    if (!SCRIPT.test(line)) continue;
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    if (LOCALISED.test(line)) continue;
    n += 1;
  }
  if (n) counts[file] = n;
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes("--write")) {
  writeFileSync(BASELINE, `${JSON.stringify({ total, counts }, null, 2)}\n`);
  console.log(`Wrote ${BASELINE}: ${total} lines across ${Object.keys(counts).length} files.`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  console.error(`No ${BASELINE}. Run: npm run verify:i18n -- --write`);
  process.exit(1);
}

const worse = [];
for (const [file, n] of Object.entries(counts)) {
  const was = baseline.counts[file] ?? 0;
  if (n > was) worse.push(`${file}: ${was} → ${n}`);
}

for (const line of worse) console.log(`FAIL  ${line}`);

if (worse.length) {
  console.log(`\n${worse.length} file(s) added text that cannot be translated.`);
  console.log("Reach it with tr(\"…\") for a dictionary key, or l10n(ku, en, ar) for a phrase written in place.");
  process.exit(1);
}

const improved = baseline.total - total;
console.log(
  `Translatable interface: ${total} line(s) still written in one language only, `
  + `across ${Object.keys(counts).length} file(s).`
);
if (improved > 0) {
  console.log(`${improved} fewer than the baseline. Run: npm run verify:i18n -- --write`);
}
