/**
 * How much a number of money is, and how it is written down.
 *
 * There were three of these in App.jsx and they did not agree.
 *
 *   roundMoney(data, n, code)     currencyDecimals(), + Number.EPSILON, sign preserved
 *   roundCur(value, curId)        cur(curId).dec clamped 0..6, no epsilon, no sign handling
 *   roundByCurrency(value, curId) the same again, with `|| 0` on the value
 *
 * Two of them round ordinary money differently from the first:
 *
 *      1.005  →  roundMoney 1.01   roundCur 1.00     a whole cent
 *     -2.675  →  roundMoney -2.68  roundCur -2.67
 *
 * `Math.round(1.005 * 100)` is 100, not 101, because 1.005 is not 1.005 in binary — it is
 * 1.00499999999999989... So the version without the epsilon rounds a half-cent DOWN, and the
 * version with it rounds away from zero the way money is rounded on paper. And `Math.round` on a
 * negative half goes toward positive infinity, so -2.675 became -2.67 rather than -2.68.
 *
 * `roundCur` is the one that computed the total a transaction is stored with. So the two
 * disagreeing implementations were not decorative: they decided, on some receipts, which cent
 * the customer was charged.
 *
 * This is one implementation, and it is the careful one. The rule itself is unchanged — round to
 * the currency's own precision — and nothing here decides anything about money that the server
 * does not verify afterwards in exact decimal arithmetic.
 */

/**
 * How many decimals this currency is written to.
 *
 * The three named cases are deliberate and predate this file: a CNY receipt is printed in fen
 * whatever the currencies row says, and IQD/JPY/KRW have no minor unit at all.
 */
export function currencyDecimals(data, code) {
  const key = String(code || "").trim().toUpperCase();
  const found = (data?.currencies || []).find((c) =>
    String(c?.code || "").trim().toUpperCase() === key ||
    String(c?.id || "").trim().toUpperCase() === key
  );
  if (key === "CNY") return 2;
  if (["IQD", "JPY", "KRW"].includes(key)) return 0;
  const explicit = Number(found?.dec);
  if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 6) return explicit;
  return 2;
}

/** A plain number, grouped, to a fixed number of decimals. Never a currency decision. */
export function formatNumber(n, d = 0) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** The amount as this currency writes it. */
export function formatMoney(data, n, code) {
  return formatNumber(n, currencyDecimals(data, code));
}

/**
 * The amount rounded to this currency's precision — away from zero on a half, as money is
 * rounded on paper, and in both directions for a negative.
 */
export function roundToCurrency(data, value, code) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** currencyDecimals(data, code);
  const rounded = Math.round((Math.abs(n) + Number.EPSILON) * m) / m;
  return n < 0 ? -rounded : rounded;
}
