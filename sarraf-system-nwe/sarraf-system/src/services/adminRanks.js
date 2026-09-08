/**
 * The three ranks of administrator, and what each may do to the others.
 *
 *   manager   the person who maintains the system. Sees everything, resets any password.
 *   owner     the business owner who runs the exchange.
 *   operator  the owner's staff.
 *
 * Every rule here is also enforced by the database and by the API. This module exists so that a
 * button a person cannot use is not shown to them in the first place — a refusal is a worse
 * answer than an absence when the answer was never going to change.
 */

export const RANKS = Object.freeze(["manager", "owner", "operator"]);

export const RANK_KU = Object.freeze({
  manager: "ماناجەر",
  owner: "سەرخێڵ",
  operator: "ئەدمین",
});

export const RANK_EN = Object.freeze({
  manager: "Manager",
  owner: "Owner",
  operator: "Admin",
});

export const RANK_NOTE_KU = Object.freeze({
  manager: "هەموو شتێک. گۆڕینی وشەی نهێنیی هەر کەسێک.",
  owner: "کاروبارەکە. دروستکردنی ئەدمین.",
  operator: "کاری ڕۆژانە.",
});

/** Highest first, so a list reads top down. */
const ORDER = Object.freeze({ manager: 0, owner: 1, operator: 2 });

export const rankName = (level, lang = "ku") =>
  (lang === "ku" ? RANK_KU : RANK_EN)[level] || level || "—";

/** An administrator with no rank recorded is the least of them, never the greatest. */
export const rankOf = (user) =>
  user?.role === "admin" ? (user.adminLevel || user.admin_level || "operator") : null;

export const isManager = (user) => rankOf(user) === "manager";

/** A manager outranks an owner, so anything an owner may do a manager may do. */
export const isOwner = (user) => ["manager", "owner"].includes(rankOf(user));

/** Sort administrators by rank, then by name, which is the order a person reads them in. */
export const byRank = (a, b) =>
  (ORDER[rankOf(a)] ?? 9) - (ORDER[rankOf(b)] ?? 9) ||
  String(a?.name || "").localeCompare(String(b?.name || ""));

/**
 * Which ranks may this actor hand out?
 *
 * Nobody grants a rank above their own — that is the whole of the hierarchy in one line.
 */
export function grantableRanks(actor) {
  if (isManager(actor)) return [...RANKS];
  if (isOwner(actor)) return ["owner", "operator"];
  return [];
}

/**
 * May this actor change that user's rank? Returns null when they may, or the reason when not.
 *
 * The reason is returned rather than a bare false because a disabled control that says nothing
 * leaves a person with no idea whether to ask someone else or to stop trying.
 */
export function rankObjection(actor, target, nextRank) {
  if (!target || target.role !== "admin") return "تەنها ئەدمین پلەی هەیە";
  if (!RANKS.includes(nextRank)) return "پلەیەکی دروست هەڵبژێرە";
  if (rankOf(target) === nextRank) return "پلەکەی هەر ئەوەیە";
  if (!grantableRanks(actor).includes(nextRank)) return "ناتوانیت پلەیەک بدەیت کە خۆت نایتە";
  if (rankOf(target) === "manager" && !isManager(actor)) {
    return "تەنها ماناجەر دەست لە پلەی ماناجەر دەدات";
  }
  return null;
}

/**
 * May this actor reset that user's password?
 *
 * A manager may reset anyone. An owner may reset ordinary users and their own staff, but never
 * another administrator of their rank or above — otherwise an owner could take the system from a
 * manager simply by changing their password.
 */
export function passwordObjection(actor, target) {
  if (!target) return "کەسێک هەڵبژێرە";
  if (target.deleted) return "ئەکاونتەکە ناچالاکە";
  if (isManager(actor)) return null;
  const level = rankOf(target);
  // Owner and employee can restore a customer, partner, investor or office login in their own
  // business. Administrator passwords remain hierarchical so an employee cannot take over the
  // owner account and an owner cannot take over the platform manager account.
  if (level === null && actor?.role === "admin") return null;
  if (isOwner(actor) && level === "operator") return null;
  if (!isOwner(actor)) return "دەسەڵاتت نییە";
  return "گۆڕینی وشەی نهێنیی ئەم ئەکاونتە تەنها لەلایەن ماناجەرەوە دەکرێت";
}

/** The same minimum the API and the account form use, stated once. */
export const PASSWORD_MIN = 12;

export const passwordTooShort = (value) =>
  String(value ?? "").length < PASSWORD_MIN
    ? `وشەی نهێنی لانیکەم ${PASSWORD_MIN} پیت بێت`
    : null;

/** The last manager may not be removed: a system nobody can reach is unusable, not secure. */
export function lastManagerObjection(users, target, nextRank = null) {
  if (rankOf(target) !== "manager") return null;
  if (nextRank === "manager") return null;
  const others = (users || []).filter(
    (u) => u && !u.deleted && u.id !== target.id && rankOf(u) === "manager"
  );
  return others.length ? null : "دوایین ماناجەر لاناچێت — سەرەتا یەکێکی تر دابنێ";
}
