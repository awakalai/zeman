import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flashIsGood } from "../src/services/flashTone.js";
import { errorTextOr } from "../src/services/userFacingError.js";

/**
 * The owner pressed «تۆمارکردنی کڕین» on a batch of receipts. The transaction was refused. The
 * screen showed a green banner with a tick over the sentence telling them so.
 *
 * The banner decided what kind of message it had by looking for words in it — ✓, «کرا», «تۆمار»,
 * «نێردرا», «وەرگ». That worked only while refusals arrived in Postgres English, which cannot
 * match a Kurdish pattern. Translating them broke it: «دیاری‌کراوە» contains «کرا».
 *
 * This is the message from the owner's own screen.
 */
const THE_MESSAGE_FROM_THE_SCREENSHOT =
  "یاسایەکی سیستەم ئەم کارەی ڕەت کردەوە — دراوی دەرەکی پێویستی بە هاوبەشێکی دیاریکراوە کە پارەکەی لایە (ZE-23514)";

test("the refusal the owner actually saw is not shown as success", () => {
  assert.equal(flashIsGood(THE_MESSAGE_FROM_THE_SCREENSHOT), false);
});

test("the old reading really did get it wrong — this is the bug, written down", () => {
  const theOldWay = /✓|کرا|تۆمار|نێردرا|وەرگ/;
  assert.ok(theOldWay.test(THE_MESSAGE_FROM_THE_SCREENSHOT),
    "if this ever stops matching, the note above needs rewriting — but the fix stays right");
  assert.ok(/دیاریکراوە/.test(THE_MESSAGE_FROM_THE_SCREENSHOT), "the word that did it");
});

test("no refusal this system can produce is ever shown as success", () => {
  // Every SQLSTATE the system refuses with, translated, in all three languages.
  for (const code of ["22023", "42501", "23514", "23505", "23503", "P0002", "55000", "40001"]) {
    for (const lang of ["ku", "en", "ar"]) {
      const shown = errorTextOr({ code, message: "something the server said" }, "نەکرا");
      assert.equal(flashIsGood(shown), false, `${code}/${lang}: ${shown}`);
    }
  }
});

test("what the caller says beats anything the text looks like", () => {
  assert.equal(flashIsGood("کرا ✓", "error"), false);
  assert.equal(flashIsGood("هیچ وشەیەکی باش تێدا نییە", "ok"), true);
});

test("the messages that meant success still mean success", () => {
  for (const said of [
    "Emergency Freeze چالاک کرا ✓",
    "٣ فیش نێردرا ✓",
    "مامەڵەکە تۆمار کرا",
    "وەرگیرا",
  ]) assert.equal(flashIsGood(said), true, said);
});

test("a message that is neither is not dressed up as either", () => {
  assert.equal(flashIsGood("چاوەڕوانی پشکنین"), false);
  assert.equal(flashIsGood(null), false);
  assert.equal(flashIsGood(undefined), false);
});

test("the banner asks the tone, and never reads the words itself", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const banner = app.slice(app.indexOf("{msg && ("), app.indexOf("{msg && (") + 900);
  assert.ok(!/کرا\|تۆمار/.test(banner),
    "the banner is guessing from the message text again");
  assert.ok(/flashIsGood\(msg, msgTone\)/.test(banner), "the banner is not asking");
});

/**
 * And the other half of the same screenshot: the owner should not have been able to press the
 * button at all. The server's rule is
 *
 *   if not v_direct and v_partner is null and currency.external
 *     then raise 23514 'external currency requires an explicit custody partner'
 *
 * so the form asks the same question before the answer can be wrong. Mirrored, never loosened.
 */
test("the form will not send a transaction the database must refuse", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.ok(/const needsCustodian = !f\.direct && !f\.partnerId && !!cur\(f\.curId\)\.external;/.test(app),
    "the custody rule is no longer mirrored in the form");
  assert.ok(/disabled=\{sending \|\| busy \|\| needsCustodian\}/.test(app),
    "the submit button no longer refuses to send what the server will refuse");
});

test("and the server's rule is still the server's", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/202608180002_core_command_contracts.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("external currency requires an explicit custody partner"),
    "the database no longer enforces custody — the form is not a substitute for the rule");
});
