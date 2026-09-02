import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { settlementWords, settlementChoices } from "../src/services/settlement.js";

// «وەرگرتنی ڕاستەوخۆ و چاوەڕوانییەکە بکە بە یەک شت.» The whole point: what a person chooses when
// they make the trade and what they press when the money arrives are the same sentence.
test("what is chosen at creation and what is pressed later are the same words", () => {
  for (const type of ["buy", "sell"]) {
    const [[, chosen]] = settlementChoices(type);
    assert.equal(chosen, settlementWords({ type }).action);
  }
});

test("the pending state is the negative of the same sentence, not a different idea", () => {
  const [, [status, pending]] = settlementChoices("sell");
  assert.equal(status, "pending");
  assert.equal(pending, settlementWords({ type: "sell" }).unsettled);
});

test("the owner's own words are the ones on the button", () => {
  assert.equal(settlementWords({ type: "buy" }).action, "پارەکە خەرجکرا");
  assert.equal(settlementWords({ type: "sell" }).action, "وەرمگرت");
});

// A customer looking at their own copy is the one who has to pay; offering them the house's
// button would be offering them a control that settles somebody else's books.
test("the counterparty is given a state and no action", () => {
  const theirs = settlementWords({ type: "sell", flip: true });
  assert.equal(theirs.action, null);
  assert.equal(theirs.done, null);
  assert.equal(theirs.unsettled, "چاوەڕوانی پارەدان");
});

test("from the counterparty's side a buy means they are waiting to be paid", () => {
  assert.equal(settlementWords({ type: "buy", flip: true }).unsettled, "چاوەڕوانی وەرگرتنی پارە");
});

test("every string exists in all three languages", () => {
  for (const type of ["buy", "sell"]) {
    for (const flip of [false, true]) {
      const seen = new Set();
      for (const lang of ["ku", "en", "ar"]) {
        const w = settlementWords({ type, flip, lang });
        for (const key of ["settled", "unsettled", "notice"]) {
          assert.equal(typeof w[key], "string", `${type}/${flip}/${lang}/${key}`);
          assert.ok(w[key].length > 0);
        }
        seen.add(w.unsettled);
      }
      // Three languages, three different sentences: a missing translation would collapse them.
      assert.equal(seen.size, 3);
    }
  }
});

test("an unknown language falls back to Kurdish rather than to undefined", () => {
  assert.equal(settlementWords({ type: "buy", lang: "fr" }).action, "پارەکە خەرجکرا");
});

test("an unknown type is read as a sell rather than crashing", () => {
  assert.equal(typeof settlementWords({ type: null }).action, "string");
});

// The brief's line, kept as a test rather than as a promise: purely wording.
test("this module knows no account numbers and calls no server", () => {
  const source = readFileSync(new URL("../src/services/settlement.js", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of ["acc-", "rpc(", "supabase", "await "]) {
    assert.ok(!code.includes(forbidden), `settlement.js must not contain ${forbidden}`);
  }
});
