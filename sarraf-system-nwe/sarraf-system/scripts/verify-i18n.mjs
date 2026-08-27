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

const counts = {};
for (const file of files.sort()) {
  let n = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
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
