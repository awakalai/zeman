/**
 * WhatsApp — پەیامێکی ئامادە، و کلیکێکی مرۆڤ
 *
 *   «WhatsApp API ئێستا ئامادە نییە؛ بۆیە دوگمەی WhatsApp پەیامێکی ئامادە دروست بکات و
 *    WhatsApp بکاتەوە تا بەکارهێنەر خۆی بینێرێت.»
 *   «بەبێ کلیکی خاوەن/کارمەند هیچ WhatsApp ـێک خۆکار مەبنێرە.»          — بەشی ٢٠
 *
 * So this module sends nothing and can send nothing. It builds a link and a sentence; opening
 * either is something a person does. There is no client here, no fetch, no timer — the whole
 * file is text and arithmetic, which is also what makes it testable.
 *
 * ── Why the number is normalised here and not at the call site ──────────────────────────────
 *
 * A number stored as 0750…, +964 750…, ٠٧٥٠… or 00964750… is the same person, and wa.me accepts
 * exactly one of those shapes: digits only, with the country code, no plus and no leading zero.
 * Getting it wrong does not fail loudly — WhatsApp opens on a "phone number not on WhatsApp"
 * screen, which reads to the owner as the customer's fault. One place, one rule.
 */

// Arabic-Indic and Extended Arabic-Indic digits, so a number typed on a Kurdish keyboard is
// still a number. Written as code points rather than as the characters themselves: a line of
// literal Kurdish digits is indistinguishable, to any tool reading this file, from a line of
// Kurdish text that should have been translatable, and verify:i18n counted it as exactly that.
const ARABIC_INDIC = 0x0660;   // ٠ through ٩
const EXTENDED_ARABIC_INDIC = 0x06F0; // ۰ through ۹, used by Kurdish and Persian keyboards
const EASTERN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
const westernise = (value) => String(value ?? "").replace(EASTERN_DIGITS, (d) => {
  const code = d.codePointAt(0);
  return String(code >= EXTENDED_ARABIC_INDIC ? code - EXTENDED_ARABIC_INDIC : code - ARABIC_INDIC);
});

/** The default country. Iraq, because that is where this business is. */
export const DEFAULT_DIALLING_CODE = "964";

/**
 * A phone number in the shape wa.me wants, or null when there is nothing usable.
 *
 * Returning null rather than a broken link matters: the screen must hide the button, not offer
 * one that lands on an error the owner will read as the customer's fault.
 */
export function whatsappNumber(phone, { diallingCode = DEFAULT_DIALLING_CODE } = {}) {
  const raw = westernise(phone);
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  // 00964… and +964… both arrive here as 00964… / 964…
  if (digits.startsWith("00")) digits = digits.slice(2);
  // A local number: 0750… becomes 964750…
  if (digits.startsWith("0")) digits = diallingCode + digits.replace(/^0+/, "");
  else if (!digits.startsWith(diallingCode)) digits = diallingCode + digits;

  // Shorter than a country code plus something is not a phone number, and 15 is the most E.164
  // allows. Both ends refused, because a half-typed number is worse than an absent one.
  if (digits.length < diallingCode.length + 6 || digits.length > 15) return null;
  return digits;
}

/** The link that opens WhatsApp with the message already written. Null when there is no number. */
export function whatsappLink(phone, message, options = {}) {
  const number = whatsappNumber(phone, options);
  if (!number) return null;
  const text = String(message ?? "").trim();
  return text
    ? `https://wa.me/${number}?text=${encodeURIComponent(text)}`
    : `https://wa.me/${number}`;
}

const MONEY = (amount, currency) => {
  const n = Number(amount) || 0;
  // Dinars are not written with fractions and dollars are; letting the browser decide per
  // currency is how the message reads like something a person wrote.
  const decimals = String(currency).toUpperCase() === "IQD" ? 0 : 2;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${String(currency).toUpperCase()}`;
};

const DATE = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const COPY = {
  ku: {
    greeting: (name) => (name ? `سڵاو ${name} خان/بەڕێز،` : "سڵاو،"),
    owes: "ئەم بڕەی خوارەوە لەلای ئێمە بە قەرز ماوەتەوە:",
    amount: "بڕی ماوە",
    opened: "بەرواری دەستپێک",
    due: "بەرواری دانەوە",
    reason: "هۆکار",
    closing: "سوپاس بۆ هاوکاریت. ئەگەر پرسیارت هەیە، هەر لێرەوە بنووسە.",
    from: (business) => (business ? `— ${business}` : "— ZEMAN"),
  },
  en: {
    greeting: (name) => (name ? `Hello ${name},` : "Hello,"),
    owes: "This amount is still outstanding with us:",
    amount: "Outstanding",
    opened: "Opened",
    due: "Due",
    reason: "Reason",
    closing: "Thank you. If you have any question, just reply here.",
    from: (business) => (business ? `— ${business}` : "— ZEMAN"),
  },
  ar: {
    greeting: (name) => (name ? `مرحبًا ${name}،` : "مرحبًا،"),
    owes: "هذا المبلغ ما زال مستحقًا لدينا:",
    amount: "المتبقي",
    opened: "تاريخ الفتح",
    due: "تاريخ الاستحقاق",
    reason: "السبب",
    closing: "شكرًا لتعاونك. إن كان لديك أي سؤال، اكتب هنا.",
    from: (business) => (business ? `— ${business}` : "— ZEMAN"),
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");

/**
 * «پەیامی WhatsApp تێر و تەسەل، جوان و بە وردەکاریی داراییی پەیوەندیدار بێت.»
 *
 * What it carries: who they are, what is outstanding, when it opened, when it is due if a date
 * was set, and why. What it never carries: ZEMAN's profit, any commission, any other party, or
 * anything internal — sections 10 and 16 forbid all of it, and a message is the easiest place
 * in the whole system to leak by accident, because it leaves through the person's own phone.
 */
export function debtReminderMessage(debt, { lang = "ku", debtorName = null, businessName = null } = {}) {
  const copy = COPY[localeKey(lang)];
  const lines = [
    copy.greeting(debtorName),
    "",
    copy.owes,
    `${copy.amount}: ${MONEY(debt?.outstanding, debt?.currency)}`,
  ];
  const opened = DATE(debt?.openedAt);
  if (opened) lines.push(`${copy.opened}: ${opened}`);
  const due = DATE(debt?.dueAt);
  if (due) lines.push(`${copy.due}: ${due}`);
  const reason = String(debt?.reason ?? "").trim();
  if (reason) lines.push(`${copy.reason}: ${reason}`);
  lines.push("", copy.closing, copy.from(businessName));
  return lines.join("\n");
}

/**
 * Everything the button needs, or null when there is no number to write to.
 *
 * Deliberately one call: a screen that could build the message without the link, or the link
 * without the message, is a screen that can open WhatsApp empty.
 */
export function debtReminderWhatsapp(debt, { phone, lang = "ku", debtorName = null, businessName = null } = {}) {
  const number = whatsappNumber(phone);
  if (!number) return null;
  const message = debtReminderMessage(debt, { lang, debtorName, businessName });
  return { number, message, href: whatsappLink(phone, message) };
}
