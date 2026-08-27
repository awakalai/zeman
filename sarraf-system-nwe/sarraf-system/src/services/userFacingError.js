/**
 * One place where a failure becomes a sentence somebody can act on.
 *
 * Twenty-eight screens used to do this:
 *
 *     catch (e) { flash(String(e?.message || e)); }
 *
 * So an owner pressing «پەسەندکردن» on a receipt that does not reconcile was shown
 *
 *     receipt gross, fee, order and net amounts do not reconcile
 *
 * in English, with no code to quote and nothing saying what to do about it. And when the failure
 * was internal instead — a missing function, a broken policy, a null in a column — the same line
 * put the database's own words on a customer's phone.
 *
 * The temptation is to answer everything with "something went wrong". That is worse. This whole
 * system's refusals are written to be READ: "only a refused receipt may be replaced", "the total,
 * the fee and the amount that arrived do not add up". Hiding those behind a shrug removes the one
 * thing the person needed.
 *
 * So the rule is not "hide errors", it is "say which kind of thing happened, in the reader's
 * language, and pass on the detail only when the detail was written for a reader":
 *
 *   1. Every deliberate refusal in this system is raised with one of eight SQLSTATEs. If the code
 *      is one of those eight, the message was written on purpose by us — it is shown, translated
 *      where we have a translation and verbatim where we do not.
 *   2. Anything else is internal. The category sentence is shown and the message is not.
 *   3. Either way there is a short reference — ZE-23514 — so the person can quote something and
 *      somebody at the other end knows exactly what they hit.
 */

import { activeLanguage } from "./activeLanguage.js";

const localeKey = (lang) => (lang === "en" || lang === "ar" ? lang : "ku");

/**
 * The eight SQLSTATEs every deliberate refusal in this system uses, and what each one means to
 * the person reading it. Counted from the migrations: 312 × 22023, 150 × 42501, 93 × 23514,
 * 44 × P0002, 8 × 23505, 7 × 23503, 5 × 55000, 3 × 40001.
 */
const CATEGORY = {
  22023: {
    ku: "ئەو زانیارییەی نێردرا تەواو یان دروست نییە",
    en: "The information sent is incomplete or not valid",
    ar: "المعلومات المُرسلة ناقصة أو غير صالحة",
  },
  42501: {
    ku: "دەسەڵاتی ئەم کارەت نییە",
    en: "You do not have permission for this action",
    ar: "ليست لديك صلاحية لهذا الإجراء",
  },
  23514: {
    ku: "یاسایەکی سیستەم ئەم کارەی ڕەت کردەوە",
    en: "A system rule refused this",
    ar: "قاعدة في النظام رفضت هذا الإجراء",
  },
  23505: {
    ku: "ئەمە پێشتر تۆمار کراوە",
    en: "This has already been recorded",
    ar: "تم تسجيل هذا من قبل",
  },
  23503: {
    ku: "ئەم کارە پەیوەستە بە تۆمارێکەوە کە بوونی نییە",
    en: "This refers to a record that does not exist",
    ar: "هذا يشير إلى سجل غير موجود",
  },
  P0002: {
    ku: "ئەوەی داوات کرد نەدۆزرایەوە",
    en: "What you asked for was not found",
    ar: "لم يتم العثور على ما طلبته",
  },
  55000: {
    ku: "سیستەمەکە ئێستا ئامادە نییە بۆ ئەم کارە",
    en: "The system is not ready for this yet",
    ar: "النظام غير جاهز لهذا الإجراء بعد",
  },
  40001: {
    ku: "کەسێکی تر لە هەمان کاتدا هەمان شتی گۆڕی — دووبارە هەوڵ بدەرەوە",
    en: "Somebody changed the same thing at the same moment — try again",
    ar: "قام شخص آخر بتغيير الشيء نفسه في اللحظة ذاتها — حاول مرة أخرى",
  },
};

/** Failures that never came from a rule: transport, configuration, session. */
const TRANSPORT = {
  network: {
    ku: "پەیوەندی بە سێرڤەرەوە نەکرا. ئینتەرنێت بپشکنە و دووبارە هەوڵ بدەرەوە.",
    en: "The server could not be reached. Check the connection and try again.",
    ar: "تعذر الاتصال بالخادم. تحقق من الاتصال وحاول مرة أخرى.",
  },
  setup: {
    ku: "ڕێکخستنی داتابەیسی ئەم بەشە تەواو نییە. پەیوەندی بە بەڕێوەبەری سیستەمەوە بکە.",
    en: "The database setup for this area is not complete. Contact the system administrator.",
    ar: "إعداد قاعدة البيانات لهذا القسم غير مكتمل. تواصل مع مسؤول النظام.",
  },
  session: {
    ku: "چوونەژوورەوەکەت بەسەرچووە. دەرچۆ و دووبارە بچۆرە ژوورەوە.",
    en: "Your session has expired. Sign out and sign in again.",
    ar: "انتهت جلستك. سجّل الخروج ثم الدخول مرة أخرى.",
  },
  unknown: {
    ku: "ئەم کارە سەرکەوتوو نەبوو. دووبارە هەوڵ بدەرەوە، و ئەگەر دووبارە بووەوە ئەم کۆدە بڵێ.",
    en: "That did not work. Try again, and quote this code if it happens again.",
    ar: "لم ينجح ذلك. حاول مرة أخرى، واذكر هذا الرمز إذا تكرر.",
  },
};

/**
 * The refusals a person meets on an ordinary day, in their own language.
 *
 * Deliberately not all 434 messages this system can raise. Translating every one by hand is a
 * large chance to mistranslate a money rule, and the untranslated ones are still shown verbatim
 * because they were written to be read. This is the daily path — receipts, review, conversion —
 * and it grows as real people meet real refusals.
 */
const KNOWN = {
  "only a refused receipt may be replaced; this one is still under review": {
    ku: "تەنها فیشێکی ڕەتکراو دەگۆڕدرێت — ئەمە هێشتا لە پشکنیندایە",
    en: "Only a refused receipt may be replaced; this one is still under review",
    ar: "لا يُستبدل إلا إيصال مرفوض؛ هذا لا يزال قيد المراجعة",
  },
  "this receipt has already been replaced": {
    ku: "ئەم فیشە پێشتر گۆڕدراوە",
    en: "This receipt has already been replaced",
    ar: "تم استبدال هذا الإيصال من قبل",
  },
  "a receipt may only be replaced inside its own business": {
    ku: "فیشێک تەنها لەناو بزنسی خۆیدا دەگۆڕدرێت",
    en: "A receipt may only be replaced inside its own business",
    ar: "لا يُستبدل الإيصال إلا داخل نشاطه التجاري",
  },
  "only the person who sent the receipt may replace it": {
    ku: "تەنها ئەو کەسەی فیشەکەی ناردووە دەتوانێت بیگۆڕێت",
    en: "Only the person who sent the receipt may replace it",
    ar: "لا يستطيع استبداله إلا من أرسله",
  },
  "receipt gross, fee, order and net amounts do not reconcile": {
    ku: "کۆی گشتی، فی و ئەو بڕەی گەیشتووە یەک ناگرنەوە",
    en: "The total, the fee and the amount that arrived do not add up",
    ar: "الإجمالي والرسوم والمبلغ الواصل لا تتطابق",
  },
  "the total, the fee and the amount that arrived do not add up to one another": {
    ku: "کۆی گشتی، فی و ئەو بڕەی گەیشتووە یەک ناگرنەوە",
    en: "The total, the fee and the amount that arrived do not add up",
    ar: "الإجمالي والرسوم والمبلغ الواصل لا تتطابق",
  },
  "receipt identity and amounts require correction before acceptance": {
    ku: "ناسنامە و بڕەکانی فیشەکە پێویستیان بە ڕاستکردنەوەیە پێش پەسەندکردن",
    en: "The receipt's identity and amounts need correcting before it can be accepted",
    ar: "يجب تصحيح هوية الإيصال ومبالغه قبل قبوله",
  },
  "there is no extraction to correct": {
    ku: "هیچ خوێندنەوەیەک نییە بۆ ڕاستکردنەوە — بە دەست بینووسە",
    en: "There is no reading to correct — write it down by hand",
    ar: "لا توجد قراءة لتصحيحها — اكتبها يدويًا",
  },
  "this receipt already has a reading; correct it instead of replacing it": {
    ku: "ئەم فیشە خوێندنەوەیەکی هەیە — ڕاستی بکەرەوە لە جیاتی گۆڕینی",
    en: "This receipt already has a reading; correct it instead",
    ar: "لهذا الإيصال قراءة بالفعل؛ صحّحها بدل استبدالها",
  },
  "multi-factor authentication is required": {
    ku: "ئەم هەنگاوە پێویستی بە پشتڕاستکردنەوەی دوو هەنگاوییە",
    en: "This step requires two-factor authentication",
    ar: "تتطلب هذه الخطوة مصادقة ثنائية",
  },
  "only an administrator may review receipts": {
    ku: "تەنها ئەدمین دەتوانێت فیش پشکنین بکات",
    en: "Only an administrator may review receipts",
    ar: "لا يراجع الإيصالات إلا المسؤول",
  },
  "only staff may enter a receipt reading": {
    ku: "تەنها ستاف دەتوانێت خوێندنەوەی فیش بنووسێت",
    en: "Only staff may write down a receipt reading",
    ar: "لا يُدخل قراءة الإيصال إلا الموظفون",
  },
  "receipt batch is not verified for conversion": {
    ku: "ئەم کۆمەڵەیە هێشتا پشتڕاست نەکراوەتەوە بۆ گۆڕین بۆ مامەڵە",
    en: "This batch is not verified yet, so it cannot become a transaction",
    ar: "لم يتم التحقق من هذه الدفعة بعد، فلا يمكن تحويلها",
  },
  "selected receipts are ineligible, reused, mixed-currency, or split across partners": {
    ku: "ئەو فیشانەی هەڵبژێردراون گونجاو نین: یان پێشتر بەکارهاتوون، یان دراوی جیاوازیان هەیە، یان بەسەر چەند هاوبەشێکدا دابەشن",
    en: "The chosen receipts are not eligible: already used, mixed currencies, or split across partners",
    ar: "الإيصالات المختارة غير مؤهلة: مستخدمة، أو بعملات مختلفة، أو موزعة على شركاء",
  },
  "transaction total does not match amount times rate": {
    ku: "کۆی گشتی مامەڵەکە لەگەڵ بڕ × نرخ یەک ناگرێتەوە",
    en: "The transaction total does not match amount × rate",
    ar: "إجمالي المعاملة لا يطابق المبلغ × السعر",
  },
  "cash location has insufficient balance": {
    ku: "قاسەکە بڕی پێویستی تێدا نییە بۆ ئەم کارە",
    en: "The cashbox does not hold enough for this",
    ar: "الصندوق لا يحتوي على رصيد كافٍ",
  },
  "main cashbox has insufficient balance for settlement": {
    ku: "قاسەی سەرەکی بڕی پێویستی تێدا نییە بۆ دانەوەی",
    en: "The main cashbox does not hold enough to settle this",
    ar: "الصندوق الرئيسي لا يحتوي على رصيد كافٍ للتسوية",
  },
  "external currency requires an explicit custody partner": {
    ku: "دراوی دەرەکی پێویستی بە هاوبەشێکی دیاریکراوە کە پارەکەی لایە",
    en: "An external currency needs a named partner holding the money",
    ar: "العملة الخارجية تتطلب شريكًا محددًا يحتفظ بالمال",
  },
};

const INTERNAL = /schema cache|could not find the function|relation ".*" does not exist|column ".*"|syntax error|violates .*constraint|null value in column|JWT|jwt|at [A-Za-z]+ \(|\bstack\b/i;

const normalise = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * A rule this system states on the client, before the server is ever asked.
 *
 * The server's refusals arrive carrying one of the eight SQLSTATEs above, and that code is how
 * this module knows the sentence was written to be read. A refusal raised HERE has no code:
 *
 *     throw new Error("بڕیارەکە پێویستی بە هۆکارێکی لانیکەم ٨ پیتی هەیە");
 *
 * is, to a catch block, indistinguishable from a TypeError thrown by a bug. Fifteen of this
 * system's clearest sentences are raised that way — the reason that is too short, the correction
 * with nothing in it, the receipt that was never selected. Passing those through the translator
 * unmarked would answer every one of them with "something went wrong", which is the exact
 * sentence the person cannot act on, in place of the one they could.
 *
 * So they are marked. `zemanRule` is not an error type with behaviour; it is a promise that the
 * words inside were written for the person who is about to read them.
 */
export class ZemanRule extends Error {
  constructor(message) {
    super(message);
    this.name = "ZemanRule";
    this.code = "ZE_RULE";
  }
}

/** Raise a rule this system states itself. `throw zemanRule("...")`. */
export const zemanRule = (message) => new ZemanRule(message);

/**
 * What happened, in one sentence, plus a code worth quoting.
 *
 * @returns {{ code: string, category: string|null, text: string, deliberate: boolean }}
 */
export function describeError(cause, lang = activeLanguage()) {
  const key = localeKey(lang);
  const rawCode = String(cause?.code || cause?.errcode || "").trim();
  const message = String(cause?.message || cause || "");
  const status = Number(cause?.status) || null;

  // Transport and configuration first: they are not rules and there is nothing to act on in
  // their wording.
  if (/failed to fetch|network ?error|load failed|networkerror|timeout/i.test(message)) {
    return { code: "ZE-NET", category: "network", text: TRANSPORT.network[key], deliberate: false };
  }
  if (rawCode === "PGRST202" || /schema cache|could not find the function/i.test(message)) {
    return { code: "ZE-SETUP", category: "setup", text: TRANSPORT.setup[key], deliberate: false };
  }
  if (rawCode === "PGRST301" || status === 401 || /jwt expired|invalid (jwt|token)|session required/i.test(message)) {
    return { code: "ZE-SESSION", category: "session", text: TRANSPORT.session[key], deliberate: false };
  }

  // Ours, and written for this reader. Shown exactly as written — translating it would be
  // translating a sentence that is already in the language it was meant to be read in.
  if (rawCode === "ZE_RULE") {
    return { code: "ZE-RULE", category: "rule", text: message, deliberate: true };
  }

  const category = CATEGORY[rawCode];
  if (!category) {
    // Not one of ours. Whatever it says, it was not written for this reader.
    return {
      code: rawCode ? `ZE-${rawCode}` : "ZE-UNKNOWN",
      category: null,
      text: TRANSPORT.unknown[key],
      deliberate: false,
    };
  }

  const known = KNOWN[normalise(message)];
  const detail = known
    ? known[key]
    : INTERNAL.test(message) ? null : message.trim();

  return {
    code: `ZE-${rawCode}`,
    category: rawCode,
    text: detail ? `${category[key]} — ${detail}` : category[key],
    deliberate: true,
  };
}

/** The sentence alone, for a toast or an inline message. */
export function errorText(cause, lang = activeLanguage(), fallback) {
  const described = describeError(cause, lang);
  if (!described.deliberate && described.category === null && fallback) {
    return `${fallback} (${described.code})`;
  }
  return `${described.text} (${described.code})`;
}

/**
 * Kept because ten screens call it. It answers the same question in the same words; the only
 * difference is that it prefers a caller's own fallback for a failure nobody recognises.
 */
export function userFacingServiceError(cause, lang = activeLanguage(), fallback) {
  return errorText(cause, lang, fallback);
}

/**
 * `errorText` for the common shape at a call site: a screen that has its own sentence for the
 * case nobody recognises, and no opinion about the language — because the language is whichever
 * one the person is reading in.
 *
 * The fallback is used ONLY where the failure is unrecognised. A refusal the system wrote, on
 * either side of the line, still says what it came to say.
 */
export const errorTextOr = (cause, fallback) => errorText(cause, activeLanguage(), fallback);
