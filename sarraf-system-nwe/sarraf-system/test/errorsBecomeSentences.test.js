import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeError, errorText, errorTextOr, userFacingServiceError, zemanRule } from "../src/services/userFacingError.js";
import { activeLanguage, setActiveLanguage, SUPPORTED_LANGUAGES } from "../src/services/activeLanguage.js";

/**
 * Twenty-eight screens answered a failure with `String(e?.message || e)`, so an owner pressing
 * «پەسەندکردن» read a Postgres sentence in English with nothing to do about it — and an internal
 * fault put the database's own words on a customer's phone.
 *
 * The answer is not "something went wrong". This system's refusals are written to be read; the
 * rule is to say which KIND of thing happened, in the reader's language, and pass on the detail
 * only when the detail was written for a reader.
 */

// ── the eight kinds ──────────────────────────────────────────────────────────

const CODES = ["22023", "42501", "23514", "23505", "23503", "P0002", "55000", "40001"];

test("every code a deliberate refusal uses has a sentence in all three languages", () => {
  for (const code of CODES) {
    for (const lang of SUPPORTED_LANGUAGES) {
      const out = describeError({ code, message: "" }, lang);
      assert.equal(out.deliberate, true, `${code} is not recognised as one of ours`);
      assert.ok(out.text.length > 8, `${code} has no sentence in ${lang}`);
      assert.equal(out.code, `ZE-${code}`);
    }
  }
});

test("a refusal written for a reader is passed on, translated where we have the words", () => {
  const out = describeError(
    { code: "23514", message: "receipt gross, fee, order and net amounts do not reconcile" }, "ku");
  assert.match(out.text, /یاسایەکی سیستەم/, "the kind of failure is not named");
  assert.match(out.text, /یەک ناگرنەوە/, "the reason was dropped, which is the part to act on");
});

test("a refusal we have not translated is still shown, because it was written to be read", () => {
  const out = describeError({ code: "22023", message: "two different receipts are required" }, "ku");
  assert.match(out.text, /two different receipts are required/);
});

// ── what must never reach a screen ───────────────────────────────────────────

test("the database's own internals never reach the reader", () => {
  const internals = [
    { code: "23502", message: 'null value in column "payee" violates not-null constraint' },
    { code: "42P01", message: 'relation "public.secret_table" does not exist' },
    { code: "42601", message: "syntax error at or near \"select\"" },
    { code: "23514", message: 'new row violates check constraint "txs_business_flow_ck"' },
  ];
  for (const cause of internals) {
    const text = errorText(cause, "ku");
    assert.ok(!/relation |constraint|null value|syntax error/i.test(text),
      `an internal detail reached the screen: ${text}`);
    assert.match(text, /ZE-/, "there is no code for the person to quote");
  }
});

test("transport failures are named as themselves, not as rules", () => {
  assert.match(errorText({ message: "Failed to fetch" }, "ku"), /ZE-NET/);
  assert.match(errorText({ code: "PGRST202", message: "could not find the function" }, "ku"), /ZE-SETUP/);
  assert.match(errorText({ status: 401, message: "JWT expired" }, "ku"), /ZE-SESSION/);
});

test("every answer carries a code worth quoting", () => {
  for (const cause of [{ code: "23514" }, { message: "boom" }, {}, null]) {
    assert.match(errorText(cause, "ku"), /\(ZE-[A-Z0-9]+\)$/);
  }
});

test("a caller's own fallback is used only for a failure nobody recognises", () => {
  const unknown = userFacingServiceError({ code: "99999", message: "?" }, "ku", "فیشەکان بار نەبوون");
  assert.match(unknown, /فیشەکان بار نەبوون/);
  const known = userFacingServiceError({ code: "42501", message: "not authorized" }, "ku", "فیشەکان بار نەبوون");
  assert.ok(!/فیشەکان بار نەبوون/.test(known), "a real refusal was replaced by a generic fallback");
});

// ── the language ─────────────────────────────────────────────────────────────

test("the language is one place, and refuses anything it does not have", () => {
  const before = activeLanguage();
  assert.equal(setActiveLanguage("ar"), "ar");
  assert.match(errorText({ code: "42501" }), /صلاحية/, "the default language is not the chosen one");
  assert.equal(setActiveLanguage("klingon"), "ar", "an unsupported language was accepted");
  setActiveLanguage(before);
});

// ── and nothing goes round it ────────────────────────────────────────────────

test("no screen prints a raw error object any more", () => {
  const offenders = [];
  for (const file of [
    "../src/App.jsx",
    "../src/components/receipts/ReceiptReviewWorkspace.jsx",
    "../src/components/receipts/ForwardedReceipts.jsx",
    "../src/components/receipts/ReceiptForwardingCenter.jsx",
    "../src/components/accounting/OfficePayments.jsx",
    "../src/components/accounting/DebtCenter.jsx",
    "../src/components/accounting/CashboxPanel.jsx",
    "../src/components/accounting/ManagerConsole.jsx",
    "../src/components/accounting/PartnerAccounts.jsx",
    "../src/components/accounting/PartnerHoldings.jsx",
    "../src/components/accounting/BooksReconciliation.jsx",
    "../src/components/accounting/ManagerCenter.jsx",
  ]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    if (/String\((e|error)\?\.message \|\| \1\)/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "these screens still show the database's own words");
});

// ── the rules this system states on its own side of the line ──────────────────
//
// Fifteen of the clearest sentences in this system are raised in the browser, before the server
// is asked at all: the reason that is too short, the correction with nothing in it, the receipt
// that was never selected. They carry no SQLSTATE, so to a catch block they look exactly like a
// TypeError from a bug — and answering them with "something went wrong" replaces the one sentence
// the person could act on with the one they cannot.

test("a rule this system states itself reaches the reader in the words it was written in", () => {
  const said = "بڕیارەکە پێویستی بە هۆکارێکی لانیکەم ٨ پیتی هەیە";
  const shown = errorTextOr(zemanRule(said), "بڕیاری فیش جێبەجێ نەکرا");
  assert.ok(shown.includes(said), `the rule's own words were lost: ${shown}`);
  assert.ok(!shown.includes("بڕیاری فیش جێبەجێ نەکرا"), "the fallback replaced a sentence that was not missing");
  assert.ok(/\(ZE-RULE\)/.test(shown), "there is nothing to quote");
});

test("a refusal from the server is still translated, not passed through", () => {
  const shown = errorTextOr(
    { code: "23514", message: "receipt gross, fee, order and net amounts do not reconcile" },
    "بڕیاری فیش جێبەجێ نەکرا");
  assert.ok(!/reconcile/i.test(shown), `the database's own English reached the reader: ${shown}`);
  assert.ok(/\(ZE-23514\)/.test(shown), "there is nothing to quote");
});

test("a failure nobody recognises uses the screen's own sentence, never the raw one", () => {
  const shown = errorTextOr(new TypeError("t.forEach is not a function"), "بڕیاری فیش جێبەجێ نەکرا");
  assert.ok(!/forEach/.test(shown), `an internal fault was shown verbatim: ${shown}`);
  assert.ok(shown.startsWith("بڕیاری فیش جێبەجێ نەکرا"), shown);
});

test("every Kurdish rule in the receipt services is marked as one", () => {
  const offenders = [];
  for (const file of ["../src/services/receiptWorkspace.js", "../src/services/receiptIntake.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      if (/throw new Error\("[^"]*[؀-ۿ]/.test(line)) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "these rules would be shown as 'something went wrong'");
});

test("no screen puts a raw message in front of the reader any more", () => {
  const offenders = [];
  for (const file of ["../src/App.jsx", "../src/components/receipts/ReceiptPolicyPanel.jsx"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      // `err.message` on a ReceiptIngestionError is that class's own bilingual sentence, which is
      // written for a reader and deliberately kept; anything reached through `?.` is not.
      if (/(flash|setErr|toast)\((?:`[^`]*)?\$?\{?\s*\w+\?\.message/.test(line)) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "these screens still show whatever the failure happened to say");
});
