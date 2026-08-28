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
  // Matched loosely on purpose: more guards will be added to this button over time, and a test
  // that pins the whole expression fails for the wrong reason every time one is.
  // There is more than one `onClick={submit}` in this file, so the one that records a trade is
  // picked out by the kind it renders with, not by being the first one found.
  const guards = [...app.matchAll(/onClick=\{submit\} disabled=\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(guards.length > 0, "the submit button no longer has a disabled expression at all");
  assert.ok(guards.some((g) => /\bneedsCustodian\b/.test(g)),
    `no submit button refuses what the server will refuse: ${guards.join(" / ")}`);
});

test("and the server's rule is still the server's", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/202608180002_core_command_contracts.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("external currency requires an explicit custody partner"),
    "the database no longer enforces custody — the form is not a substitute for the rule");
});

/**
 * Two more rules the database refuses at the same late moment, and one rule about who is
 * allowed to be sure.
 *
 *   raise 23514 'sale would create negative inventory'   -- v_amount > v_qty
 *   raise 23514 'inventory cost basis is incomplete'     -- v_avg is null
 *
 * The form has computed exactly this all along — `enoughCostBasis` — and used it only to decide
 * whether to show an estimated profit. Selling more than the office held went to the server and
 * came back refused.
 *
 * The subtle part is not the guard. It is that the guard must only fire on a number the SERVER
 * produced. `inventoryPosition` prefers the server's own snapshot and falls back to arithmetic
 * over whatever transactions this browser happens to have loaded. Blocking a sale on the second
 * kind of number would stop an owner making a sale that was perfectly legitimate — a worse
 * failure than the late refusal this replaces.
 */
test("the sale is stopped only on a figure the server itself produced", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.ok(/fromServer: true,/.test(app), "the server snapshot no longer says it is the server's");
  assert.ok(/fromServer: false,/.test(app), "the browser's own arithmetic no longer says so");
  assert.ok(/const inventoryRefuses = \(shortOfStock \|\| costBasisMissing\) && pos\?\.fromServer === true;/.test(app),
    "the guard no longer requires the server's own number");
  assert.ok(/const inventoryDoubts = \(shortOfStock \|\| costBasisMissing\) && pos\?\.fromServer !== true;/.test(app),
    "a figure worked out here no longer merely warns");
  const guards = [...app.matchAll(/onClick=\{submit\} disabled=\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(guards.some((g) => /\binventoryRefuses\b/.test(g)),
    `no submit button stops a sale the server would refuse: ${guards.join(" / ")}`);
  assert.ok(!guards.some((g) => /\binventoryDoubts\b/.test(g)),
    "a figure this browser worked out for itself is stopping a sale");
});

test("the database still owns both inventory rules", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/202608180002_core_command_contracts.sql", import.meta.url), "utf8");
  for (const rule of ["sale would create negative inventory", "inventory cost basis is incomplete"]) {
    assert.ok(sql.includes(rule), `the database no longer enforces: ${rule}`);
  }
});

test("pressing the button always says something, even when it refuses to act", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const submit = app.slice(app.indexOf("const submit = async () => {"));
  const body = submit.slice(0, submit.indexOf("setSending(true);"));
  // Every early exit before the command is attempted must leave a message behind. A `return`
  // with nothing said is a button that does nothing when pressed, which is how this one behaved
  // when either currency box was empty.
  const lines = body.split("\n");
  const silent = lines.filter((l, i) => {
    if (!/^\s*(if \([^)]*\) )?return;\s*$/.test(l)) return false;
    if (/sending \|\| busy/.test(l)) return false;              // the re-entry guard says nothing on purpose
    const said = lines.slice(Math.max(0, i - 3), i).join(" ");   // …but every other exit must
    return !/flash\??\.?\(/.test(said);
  }).map((l) => l.trim());
  assert.deepEqual(silent, [], "these leave the owner pressing a button that does nothing");
  assert.ok(/flash\?\.\(tr\("هەردوو دراوەکە هەڵبژێرە"\), "error"\)/.test(body),
    "the empty-currency case no longer says which box is the problem");
});

/**
 * Reported from a real screen, and the sharpest of the three.
 *
 * The owner opened a batch of a customer's receipts in yuan, pressed «درووستکردنی کڕین لەم
 * فیشانەوە», chose «Bryar» under «لە کوێ دای دەنێیت؟», and was told:
 *
 *   دراوی دەرەکی پێویستی بە هاوبەشێکی دیاریکراوە کە پارەکەی لایە (ZE-23514)
 *
 * They had named somebody. The system said they had named nobody. Both were right:
 *
 *   v_tx := p_tx || jsonb_build_object(…, 'partner_id', v_partner, …)
 *
 * `v_partner` is read from the RECEIPTS. Whatever the form sent was overwritten before a single
 * rule saw it — and a customer-seller's receipts carry no partner at all.
 *
 * That overwrite is the system's design, and a sound one: custody is evidence about particular
 * receipts, recorded on the batch screen by its own command with its own reason and audit trail.
 * The defect was never the rule. It was a screen offering a choice it would throw away, and then
 * blaming the owner for the emptiness it had created.
 */
test("the custody box does not offer a choice the conversion will discard", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.ok(/const custodyFromReceipts = !!batch;/.test(app),
    "the form no longer knows that a batch conversion takes its custody from the receipts");
  assert.ok(/<Sel value=\{f\.partnerId\} disabled=\{custodyFromReceipts\}/.test(app),
    "the custody box is editable again during a batch conversion");
  assert.ok(/فیشەکان لای کەس دانەنراون/.test(app),
    "an unplaced batch no longer says so in the box itself");
  assert.ok(/دابەشکردن بەسەر هاوبەشەکان/.test(app),
    "the owner is no longer told which screen sets custody");
});

test("and it will not send a conversion the receipts cannot support", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.ok(/const custodyMustBeSetFirst = receiptsNameNobody && !f\.direct && !!cur\(f\.curId\)\.external;/.test(app),
    "the condition no longer matches the server's own");
  const guards = [...app.matchAll(/onClick=\{submit\} disabled=\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(guards.some((g) => /\bcustodyMustBeSetFirst\b/.test(g)),
    `no submit button stops an unplaced batch: ${guards.join(" / ")}`);
});

test("the conversion still takes custody from the receipts, not from the form", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/202608110001_receipt_assurance.sql", import.meta.url), "utf8");
  assert.ok(/'partner_id',\s*v_partner/.test(sql),
    "the conversion now takes the form's word for who holds the money");
  assert.ok(/if v_partner is null then v_partner:=v_batch\.partner_id; end if;/.test(sql),
    "the batch is no longer the fallback for custody");
});
