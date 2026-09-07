/**
 * شێوازی پارەدانی مامەڵە — یەک ڕێگا، بە ناوی خۆی
 *
 *   «شێوازی پارەدانی مامەڵە بە تەواوی لەلایەن خاوەن/کارمەند دیاری بکرێت.»
 *   «هەر مامەڵە تەنها یەک شێوازی پارەدانی هەبێت؛ split payment مەکە.»
 *   «payment route دەبێت بە ڕوونی دیاری بکات: خاوەن/ZEMAN ڕاستەوخۆ پارە دەدات · نووسینگە پارە
 *    دەدات · پارە لە customer balance بەکاردەهێنرێت · مامەڵە دەبێتە قەرز · بە mutual
 *    balance/debt ساف دەکرێتەوە.»                                            — بەشی ١٢
 *
 * ── What this replaces ──────────────────────────────────────────────────────────────────────
 *
 * Two buttons: «درا» and «نەدرا». Everything else was inferred. Choosing "not paid" on a
 * purchase silently meant an office had to be named; choosing it on a sale silently meant a
 * debt; and money was taken from a customer's balance automatically whenever they happened to
 * have some, whatever the operator had in mind. Three different outcomes wearing one word, and
 * the one that moved a customer's money was the one nobody chose.
 *
 * A route is now named, and naming it is what makes it happen.
 *
 * ── The fifth route ─────────────────────────────────────────────────────────────────────────
 *
 * Section 12 lists five. Four are here. Settling against a mutual debt already exists and is
 * done from the debt centre, where both sides and their currencies are in front of the person
 * doing it; offering it as a fifth button on a form that knows about one transaction would be
 * offering something this screen cannot honestly carry out. It is named in the list below as
 * unavailable rather than left out, so nobody has to wonder whether it was forgotten.
 */

/**
 * The routes, in the order a person meets them: the ordinary one first, then the ones that
 * hand the money to somebody else, then the ones that leave it owed.
 */
export const PAYMENT_ROUTES = Object.freeze([
  "owner_direct",
  "office",
  "customer_balance",
  "becomes_debt",
]);

/** Named, and refused by every caller, so a fifth button never quietly appears. */
export const UNAVAILABLE_ROUTES = Object.freeze(["mutual_offset"]);

const COPY = {
  ku: {
    owner_direct: "خۆم ڕاستەوخۆ دەیدەم",
    office: "نووسینگە دەیدات",
    customer_balance: "لە باڵانسی خۆیەوە",
    becomes_debt: "دەبێتە قەرز",
    mutual_offset: "بە قەرزی دوولایەنە ساف دەکرێتەوە — لە ناوەندی قەرزەوە",
    label: "پارەکە کێ دەیدات؟",
    needOffice: "کام نووسینگە پارەکە دەدات؟",
    needCustomer: "بۆ ئەم ڕێگایە دەبێت کڕیارێکی تۆمارکراو دیاری بکرێت",
    unavailable: "ئەم ڕێگایە لێرەوە ناکرێت",
  },
  en: {
    owner_direct: "I pay it directly",
    office: "An office pays it",
    customer_balance: "From their own balance",
    becomes_debt: "It becomes a debt",
    mutual_offset: "Settled against a mutual debt — from the debt centre",
    label: "Who pays it?",
    needOffice: "Which office pays it?",
    needCustomer: "This route needs a registered customer",
    unavailable: "That route cannot be taken from here",
  },
  ar: {
    owner_direct: "أدفعها مباشرة",
    office: "يدفعها المكتب",
    customer_balance: "من رصيده الخاص",
    becomes_debt: "تتحوّل إلى دين",
    mutual_offset: "تُسوّى مقابل دين متبادل — من مركز الديون",
    label: "من يدفعها؟",
    needOffice: "أي مكتب يدفعها؟",
    needCustomer: "هذا المسار يتطلب عميلًا مسجلًا",
    unavailable: "لا يمكن سلوك هذا المسار من هنا",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");

/** The routes to offer, as [value, label] pairs, for a transaction of this kind. */
export function paymentRouteChoices(type, lang = "ku") {
  const copy = COPY[localeKey(lang)];
  return PAYMENT_ROUTES
    // A purchase is money going out of this business, so there is no balance of the seller's
    // to take it from. Offering it would be offering a route the server has to refuse.
    .filter((route) => !(route === "customer_balance" && type === "buy"))
    .map((route) => [route, copy[route]]);
}

/** The words for one route, so a screen and a report can name it the same way. */
export function paymentRouteLabel(route, lang = "ku") {
  return COPY[localeKey(lang)][route] || route;
}

/**
 * What the route means for the transaction being written.
 *
 * `status` is what the server is told; `officeId` and `customerId` say what the route cannot do
 * without. `drawsOnBalance` is the one that used to happen by itself.
 */
export function paymentRouteEffect(route) {
  switch (route) {
    case "owner_direct":
      return { status: "completed", needsOffice: false, needsCustomer: false, drawsOnBalance: false };
    case "office":
      return { status: "pending", needsOffice: true, needsCustomer: true, drawsOnBalance: false };
    case "customer_balance":
      return { status: "completed", needsOffice: false, needsCustomer: true, drawsOnBalance: true };
    case "becomes_debt":
      return { status: "pending", needsOffice: false, needsCustomer: true, drawsOnBalance: false };
    default:
      return null;
  }
}

/**
 * Why this transaction cannot be written with this route, or null when it can.
 *
 * Returns a code rather than a sentence: the screen picks the language, and a caller that
 * matched on English text would break the day somebody switched to Kurdish.
 */
export function paymentRouteObjection(route, { officeId = null, customerId = null } = {}) {
  if (UNAVAILABLE_ROUTES.includes(route)) return "unavailable";
  const effect = paymentRouteEffect(route);
  if (!effect) return "unavailable";
  if (effect.needsOffice && !officeId) return "needOffice";
  // «مامەڵەی چاوەڕوان دەبێت بە کڕیارێکی تۆمارکراو ببەسترێتەوە» — a debt, a balance and an office
  // payment all have to name somebody the books can find again. A free-typed name cannot be
  // sent a reminder, cannot hold a balance and cannot be settled.
  if (effect.needsCustomer && !customerId) return "needCustomer";
  return null;
}

/** The message for an objection, in the reader's own language. */
export function paymentRouteObjectionText(code, lang = "ku") {
  return COPY[localeKey(lang)][code] || code;
}

export default paymentRouteChoices;
