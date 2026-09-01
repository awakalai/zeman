/**
 * Has the money moved yet? Asked once, in one vocabulary.
 *
 *   «کاتێک فرۆشتن دەکەم، پارە لە کاتی چاوەڕوانیدا هەیە و وەرمگرت هەیە.
 *    وەرگرتنی ڕاستەوخۆ و چاوەڕوانییەکە بکە بە یەک شت.»
 *
 * ── Why the owner could not tell these apart ──────────────────────────────────────────────────
 *
 * There is one fact about a trade beyond the amounts: whether the money has changed hands. It
 * was being put to the owner in eight different sets of words, depending only on which screen
 * they happened to be looking at:
 *
 *   at creation, buying     پارەم داوە            /  چاوەڕوانی پارە
 *   at creation, selling    پارەم وەرگرتووە       /  چاوەڕوانی وەرگرتن
 *   on the card             پارە نەدراوە          /  پارە وەرنەگیراوە
 *   on the card, as them    چاوەڕوانی وەرگرتنی پارە /  چاوەڕوانی پارەدان
 *   the button              پارەکەم دا            /  پارەکەم وەرگرت
 *   the flash after it      پارەدان تۆمار کرا      /  وەرگرتن تۆمار کرا
 *
 * Nothing was wrong with any one of them. What was wrong is that «پارەم وەرگرتووە» chosen on
 * Monday and «پارەکەم وەرگرت» pressed on Tuesday are the same event, and a person reading two
 * different sentences reasonably concludes they are two different things — which is exactly what
 * the owner reported. Unifying them is not a matter of picking nicer words; it is making the
 * screen say once what the books have always recorded once.
 *
 * So the words are the owner's own — «پارەکە خەرجکرا» and «وەرمگرت» — and the pending state is
 * written as the plain negative of the same sentence rather than as a separate idea with a
 * vocabulary of its own. Choosing it at creation and pressing it a day later now read alike,
 * because they are alike.
 *
 * ── What this file is not ────────────────────────────────────────────────────────────────────
 *
 * It is wording, and only wording. Not one posting changes: sarraf_settle_transaction posts
 * Dr acc-2300 / Cr acc-1000 for a buy and Dr acc-1000 / Cr acc-1200 for a sell exactly as it did
 * before, and the audit label and journal memo the server writes are left alone — those are the
 * record's own vocabulary, they already agree with each other, and rewriting them would make two
 * audit rows describing the same event read differently depending on when they were written.
 */

const LANGS = ["ku", "en", "ar"];
const langKey = (lang) => (LANGS.includes(lang) ? lang : "ku");

/**
 * A buy takes money out of the safe; a sell brings it in. Everything below is that one
 * distinction, said from whichever side is reading.
 */
const WORDS = {
  buy: {
    // The owner's side. They are the one who pays.
    ku: { settled: "پارەکە خەرجکرا", unsettled: "پارەکە هێشتا خەرج نەکراوە",
          done: "خەرجکردنی پارە تۆمار کرا ✓", waiting: "چاوەڕوانی وەرگرتنی پارە",
          notice: "پارەکەت درا" },
    en: { settled: "The money was paid", unsettled: "The money has not been paid yet",
          done: "Payment recorded ✓", waiting: "Awaiting payment",
          notice: "Your money has been paid" },
    ar: { settled: "تم دفع المبلغ", unsettled: "لم يُدفع المبلغ بعد",
          done: "سُجّل الدفع ✓", waiting: "بانتظار استلام المبلغ",
          notice: "تم دفع مبلغك" },
  },
  sell: {
    ku: { settled: "وەرمگرت", unsettled: "هێشتا وەرمنەگرتووە",
          done: "وەرگرتنی پارە تۆمار کرا ✓", waiting: "چاوەڕوانی پارەدان",
          notice: "پارەکەت وەرگیرا" },
    en: { settled: "I received it", unsettled: "I have not received it yet",
          done: "Receipt of payment recorded ✓", waiting: "Awaiting their payment",
          notice: "Your money has been received" },
    ar: { settled: "استلمته", unsettled: "لم أستلمه بعد",
          done: "سُجّل الاستلام ✓", waiting: "بانتظار دفعهم",
          notice: "تم استلام مبلغك" },
  },
};

/**
 * The words for one transaction's settlement, from one side of it.
 *
 * `flip` is the counterparty reading their own copy. From there the owner's «وەرمگرت» is not a
 * thing they can say or do — they are the one who has to pay — so that side gets only a state,
 * and `action` is null. A caller that renders a button on `action` therefore cannot accidentally
 * offer a customer a button that settles the house's books.
 */
export function settlementWords({ type, flip = false, lang = "ku" } = {}) {
  const side = type === "buy" ? "buy" : "sell";
  const w = WORDS[side][langKey(lang)];
  if (flip) return { settled: w.settled, unsettled: w.waiting, action: null, done: null, notice: w.notice };
  return { settled: w.settled, unsettled: w.unsettled, action: w.settled, done: w.done, notice: w.notice };
}

/**
 * The two choices at creation, in the same words as the button that appears afterwards.
 *
 * Returned in the shape the form already maps over, so the status a person picks and the status
 * they later press are visibly the same decision.
 */
export function settlementChoices(type, lang = "ku") {
  const w = settlementWords({ type, lang });
  return [["completed", w.settled], ["pending", w.unsettled]];
}

export default settlementWords;
