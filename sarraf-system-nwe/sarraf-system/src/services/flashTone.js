/**
 * Is this banner good news?
 *
 * It used to be decided by looking for words in the message: ✓, «کرا», «تۆمار», «نێردرا»,
 * «وەرگ». That held only while the system's refusals arrived in Postgres English, which could
 * never match a Kurdish pattern. Once every refusal was translated, an ordinary one —
 *
 *     «یاسایەکی سیستەم ئەم کارەی ڕەت کردەوە — دراوی دەرەکی پێویستی بە هاوبەشێکی
 *      دیاریکراوە کە پارەکەی لایە (ZE-23514)»
 *
 * — contains «دیاری‌کراوە». Which contains «کرا». So the owner pressed «تۆمارکردنی کڕین», the
 * transaction was refused, and the screen showed them a green tick.
 *
 * Kurdish has no word boundary a regular expression can lean on here, and the fix is not a
 * cleverer pattern. Reading a sentence's meaning off its spelling is the mistake. So:
 *
 *   1. If the caller said what it is, that is what it is.
 *   2. A message carrying a ZE- reference is a refusal. Every translated failure in this system
 *      ends with one, and nothing else in the interface writes that shape — it is a marker this
 *      code emits on purpose, not a word that might turn up inside another word.
 *   3. Only then, the old reading, for the many older calls that say «... ✓» and mean it.
 */

/** The reference every translated failure carries — `(ZE-23514)`, `(ZE-RULE)`, `(ZE-NET)`. */
const CARRIES_A_REFERENCE = /\(ZE-[A-Z0-9-]+\)/;

/** What older calls write when they mean it went well. Consulted last, and never over a refusal. */
const READS_AS_DONE = /✓|کرا|تۆمار|نێردرا|وەرگ/;

export function flashIsGood(message, tone = null) {
  if (tone === "error") return false;
  if (tone === "ok") return true;
  const text = String(message ?? "");
  if (CARRIES_A_REFERENCE.test(text)) return false;
  return READS_AS_DONE.test(text);
}
