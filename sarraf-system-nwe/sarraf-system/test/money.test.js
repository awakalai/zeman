import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currencyDecimals, formatMoney, formatNumber, roundToCurrency } from "../src/services/money.js";

/**
 * There were three currency rounders in App.jsx and they did not agree with one another. One of
 * the two that disagreed computed the total a transaction is stored with, so the disagreement
 * decided, on some receipts, which cent the customer was charged.
 */

const data = { currencies: [
  { id: "usd", code: "USD", dec: 2 },
  { id: "cny", code: "CNY", dec: 2 },
  { id: "iqd", code: "IQD", dec: 0 },
  { id: "btc", code: "BTC", dec: 6 },
] };

// The old implementation, kept here so the defect it had is stated rather than remembered.
const withoutEpsilon = (value, dec) => Math.round(Number(value) * 10 ** dec) / 10 ** dec;

test("a half is rounded away from zero, the way money is rounded on paper", () => {
  assert.equal(roundToCurrency(data, 1.005, "usd"), 1.01);
  assert.equal(withoutEpsilon(1.005, 2), 1, "the old rounder is not being compared honestly");
  assert.equal(roundToCurrency(data, 2.675, "usd"), 2.68);
  assert.equal(roundToCurrency(data, 100.005, "usd"), 100.01);
});

test("a negative half goes away from zero too, not towards it", () => {
  assert.equal(roundToCurrency(data, -2.675, "usd"), -2.68);
  assert.equal(withoutEpsilon(-2.675, 2), -2.67, "the old rounder is not being compared honestly");
  assert.equal(roundToCurrency(data, -1.005, "usd"), -1.01);
});

test("each currency is rounded to its own precision", () => {
  assert.equal(roundToCurrency(data, 1234.567, "iqd"), 1235);
  assert.equal(roundToCurrency(data, 1234.5, "iqd"), 1235);
  assert.equal(roundToCurrency(data, 0.1234567, "btc"), 0.123457);
});

// These three were named on purpose long before this module existed.
test("the currencies with a fixed precision keep it, whatever the row says", () => {
  assert.equal(currencyDecimals({ currencies: [{ code: "CNY", dec: 0 }] }, "CNY"), 2,
    "a yuan receipt is printed in fen whatever the currencies table says");
  assert.equal(currencyDecimals({ currencies: [{ code: "IQD", dec: 3 }] }, "IQD"), 0);
  assert.equal(currencyDecimals(data, "JPY"), 0);
});

test("a currency is found by its id as well as its code", () => {
  assert.equal(currencyDecimals(data, "btc"), 6);
  assert.equal(currencyDecimals(data, "BTC"), 6);
});

test("an unknown currency is written to two decimals rather than guessed at", () => {
  assert.equal(currencyDecimals(data, "ZZZ"), 2);
  assert.equal(currencyDecimals(null, undefined), 2);
});

// Written down as it is, not as it might ideally be: `Number(null)` is 0 and finite, so a null
// amount has always been printed as 0.00 rather than as a dash. Hundreds of call sites read
// that way today and changing it is a change to what the screens say, which is not what this
// module is for.
test("what is not a number at all reads as a dash; null keeps the behaviour it has always had", () => {
  assert.equal(formatNumber(undefined), "—");
  assert.equal(formatNumber(NaN), "—");
  assert.equal(formatMoney(data, "abc", "usd"), "—");
  assert.equal(formatMoney(data, null, "usd"), "0.00");
  // A rounder must return a number whatever it is handed, because arithmetic follows it.
  assert.equal(roundToCurrency(data, "not a number", "usd"), 0);
  assert.equal(roundToCurrency(data, null, "usd"), 0);
});

test("money is written the way this application has always written it", () => {
  assert.equal(formatMoney(data, 1246.3, "cny"), "1,246.30");
  assert.equal(formatMoney(data, 1246.3, "iqd"), "1,246");
  assert.equal(formatNumber(1246.3, 0), "1,246");
});

// The whole point of the module: one implementation, three call sites.
test("App.jsx no longer carries a currency rounder of its own", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.ok(!/const dec = Math\.max\(0, Math\.min\(6, Number\(cur\(curId\)\.dec\)/.test(app),
    "a second rounding rule is back in App.jsx, and it disagrees with this one");
  assert.match(app, /const roundCur = \(value, curId\) => roundToCurrency\(data, value, curId\);/);
  assert.match(app, /const roundByCurrency = \(value, curId\) => roundToCurrency\(data, value, curId\);/);
});
