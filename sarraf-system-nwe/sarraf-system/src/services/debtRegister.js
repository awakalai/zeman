/**
 * The two things the debt centre could not do, and the register that records them.
 *
 * §13.C.6 — netting. When ZEMAN and one other party owe each other in the same currency, the
 * settlement is one entry that reduces both, not two payments that in practice never move.
 *
 * §13.C.7 — waiving. A debt that will not be collected has to leave the receivable and become
 * an expense, deliberately and on the record. It is not deleted and it is not marked paid.
 *
 * §13.F.1 — the voucher register. Every movement is handed a number that the person can quote
 * back. Columns named voucher_id have existed since the cashbox was built; nothing ever filled
 * one in.
 *
 * The commands live in the database. What follows checks what can be checked before the call is
 * made, so that a refusal arrives before anything is attempted rather than after.
 */

import { activeLanguage } from "./activeLanguage.js";
import { zemanRule } from "./userFacingError.js";

const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const clean = (v) => String(v ?? "").normalize("NFKC").trim();

export const OFFSET_REASON_MIN = 8;
/** Longer than a settlement's, because unlike a settlement nothing arrived in exchange. */
export const WRITE_OFF_REASON_MIN = 12;

export const offsetCommandKey = (leftId, rightId) =>
  `debt-offset:${clean(leftId).slice(0, 60)}:${clean(rightId).slice(0, 60)}:${id()}`;
export const writeOffCommandKey = (debtId) =>
  `debt-write-off:${clean(debtId).slice(0, 60)}:${id()}`;
// Both servers refuse a key that is not their own prefix followed by 8-200 characters of
// [A-Za-z0-9:_-], so the shape is built here rather than left to each caller to remember.
const safeSubject = (value) => String(value ?? "").replace(/[^A-Za-z0-9:_-]/g, "-").slice(0, 60);

// The refusals below are written in three languages rather than one. The twenty-nine older ones
// in this file are Kurdish-only, which is a debt of its own; new ones do not add to it.
const say3 = (arms) => arms[activeLanguage()] || arms.ku;
export const settleCommandKey = (debtId) =>
  `settle-debt:${safeSubject(debtId)}:${id()}`;
export const remindCommandKey = (debtId) =>
  `debt-reminder:${safeSubject(debtId)}:${id()}`;

/**
 * Can these two debts be netted against each other?
 *
 * The same check the database makes, so the reason is shown next to the button rather than
 * arriving as a refusal after the fact. Returns null when they can, or the reason when they
 * cannot.
 */
// A debt reaches this module in either of the two shapes the application uses: the row as the
// database returns it, or the reading `loadDebts` produces for the screen. Reading both means
// the check next to the button and the check before the call are literally the same function.
const face = (d) => d && ({
  id: d.id,
  currency: clean(d.currency).toUpperCase(),
  status: d.status,
  debtorType: d.debtorType ?? d.debtor_type,
  debtorId: d.debtorId ?? d.debtor_id ?? null,
  creditorType: d.creditorType ?? d.creditor_type,
  creditorId: d.creditorId ?? d.creditor_id ?? null,
  outstanding: Number(d.outstanding ?? d.outstanding_principal),
});

export function offsetObjection(rawLeft, rawRight) {
  const left = face(rawLeft), right = face(rawRight);
  if (!left || !right) return "دوو قەرز هەڵبژێرە";
  if (left.id && left.id === right.id) return "قەرزێک لەگەڵ خۆی دانانرێتەوە";
  if (left.currency !== right.currency) {
    return "هەردوو قەرز دەبێت بە هەمان دراو بن — دانانەوە گۆڕینی دراو نییە";
  }
  const closed = ["settled", "written_off", "void"];
  if (closed.includes(left.status) || closed.includes(right.status)) return "قەرزی داخراو دانانرێتەوە";
  const facing = left.debtorType === right.creditorType
    && left.debtorId === right.creditorId
    && left.creditorType === right.debtorType
    && left.creditorId === right.debtorId;
  if (!facing) return "دانانەوە دوو قەرزی پێچەوانەی نێوان هەمان دوو لا دەخوازێت";
  if (left.debtorType !== "zeman" && left.creditorType !== "zeman") {
    return "دانانەوە دەبێت لەنێوان زیمان و لایەکی تر بێت";
  }
  return null;
}

/** How much would actually cancel: the smaller of the two outstanding balances. */
export function offsetAmount(rawLeft, rawRight) {
  const a = face(rawLeft)?.outstanding;
  const b = face(rawRight)?.outstanding;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const amount = Math.min(a, b);
  return amount > 0 ? amount : null;
}

export async function offsetDebts(client, { leftDebtId, rightDebtId, amount = null, reason, commandKey }) {
  if (!leftDebtId || !rightDebtId) throw new Error("دوو قەرز پێویستە");
  if (leftDebtId === rightDebtId) throw new Error("قەرزێک لەگەڵ خۆی دانانرێتەوە");
  const why = clean(reason);
  if (why.length < OFFSET_REASON_MIN) throw new Error(`هۆکار لانیکەم ${OFFSET_REASON_MIN} پیت بێت`);
  if (amount != null && !(Number(amount) > 0)) throw new Error("بڕەکە دەبێت لە سفر گەورەتر بێت");
  const key = commandKey || offsetCommandKey(leftDebtId, rightDebtId);
  const { data, error } = await client.rpc("sarraf_offset_debts", {
    p_left_debt_id: leftDebtId,
    p_right_debt_id: rightDebtId,
    p_amount: amount == null ? null : Number(amount),
    p_reason: why,
    p_command_key: key,
  });
  if (error) throw error;
  return { result: data, commandKey: key };
}

export async function writeOffDebt(client, { debtId, amount = null, reason, commandKey }) {
  if (!debtId) throw new Error("قەرزێک پێویستە");
  const why = clean(reason);
  if (why.length < WRITE_OFF_REASON_MIN) {
    throw new Error(`بۆ بەخشینی قەرز هۆکار لانیکەم ${WRITE_OFF_REASON_MIN} پیت بێت`);
  }
  if (amount != null && !(Number(amount) > 0)) throw new Error("بڕەکە دەبێت لە سفر گەورەتر بێت");
  const key = commandKey || writeOffCommandKey(debtId);
  const { data, error } = await client.rpc("sarraf_write_off_debt", {
    p_debt_id: debtId,
    p_amount: amount == null ? null : Number(amount),
    p_reason: why,
    p_command_key: key,
  });
  if (error) throw error;
  return { result: data, commandKey: key };
}

/**
 * قەرزەکە بدەمەوە — a debt paid, or received, with the money landing where the owner says.
 *
 *   «هەر لەوێوە بتوانم قەرزەکان سفر بکەمەوە، واتا قەرزەکە بدەمەوە.»
 *
 * Not writing it off: giving up money you are owed is a loss and receiving it is not, and a
 * system offering only the first invites recording a loss every time somebody actually pays.
 * A null place is the cash. The server decides both direction and sufficiency.
 *
 * Mirrors public.sarraf_settle_debt.
 */
export async function settleDebt(client, { debtId, amount = null, cashAccountId = null, note = null, commandKey }) {
  if (!debtId) throw zemanRule(say3({ ku: "قەرزێک پێویستە", en: "A debt is required", ar: "الدين مطلوب" }));
  if (amount != null && !(Number(amount) > 0)) {
    throw zemanRule(say3({ ku: "بڕەکە دەبێت لە سفر گەورەتر بێت",
      en: "The amount has to be greater than zero", ar: "يجب أن يكون المبلغ أكبر من صفر" }));
  }
  const key = commandKey || settleCommandKey(debtId);
  const { data, error } = await client.rpc("sarraf_settle_debt", {
    p_debt_id: debtId,
    p_amount: amount == null ? null : Number(amount),
    p_cash_account_id: cashAccountId || null,
    p_note: clean(note) || null,
    p_command_key: key,
  });
  if (error) throw error;
  return { result: data, commandKey: key };
}

/**
 * «نۆتفیکەیشن بۆ ئەوان بنێرم کە ئەوەنە قەرزارن» — one reminder, to the party that owes it,
 * saying how much is left. The server refuses a debt that is closed, one the business itself
 * owes, and one whose debtor has no account to receive it.
 *
 * Mirrors public.sarraf_remind_debtor.
 */
export async function remindDebtor(client, { debtId, note = null, commandKey }) {
  if (!debtId) throw zemanRule(say3({ ku: "قەرزێک پێویستە", en: "A debt is required", ar: "الدين مطلوب" }));
  const key = commandKey || remindCommandKey(debtId);
  const { data, error } = await client.rpc("sarraf_remind_debtor", {
    p_debt_id: debtId,
    p_note: clean(note) || null,
    p_command_key: key,
  });
  if (error) throw error;
  return { result: data, commandKey: key };
}

export async function loadVoucherRegister(client, { partyId = null, from = null, to = null, limit = 200 } = {}) {
  const { data, error } = await client.rpc("sarraf_voucher_register", {
    p_party_id: partyId || null, p_from: from || null, p_to: to || null, p_limit: limit,
  });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function loadDebtHistory(client, debtId) {
  if (!debtId) throw new Error("قەرزێک پێویستە");
  const { data, error } = await client.rpc("sarraf_debt_history", { p_debt_id: debtId });
  if (error) throw error;
  return data || null;
}

export const VOUCHER_KIND_KU = Object.freeze({
  debt_opened: "کردنەوەی قەرز",
  debt_settlement: "تسویەی قەرز",
  debt_offset: "دانانەوەی دوولایەنە",
  debt_write_off: "بەخشینی قەرز",
  vault_deposit: "دانانی پارە لە قاسە",
  vault_withdrawal: "دەرهێنان لە قاسە",
  office_payment: "پارەدانی نووسینگە",
  partner_settlement: "تسویەی هاوبەش",
  reversal: "هەڵوەشاندنەوە",
});

export const DEBT_EVENT_KU = Object.freeze({
  opened: "کرایەوە",
  settled: "تسویە کرا",
  offset: "دانرایەوە",
  written_off: "بەخشرا",
  voided: "پووچ کرایەوە",
  reinstated: "گەڕێندرایەوە",
});

/**
 * «گەر دوای هەفتەیەک جواب نەبوو، ئۆتۆماتیکی بیکات.»
 *
 * The server decides everything: which debts are a week without an answer, whether each one may
 * be told at all, and whether it has already been told this week. This only asks it to look.
 *
 * That division is the point. A browser deciding would send a second reminder on a second tab,
 * a third on a refresh, and nothing at all on the day the owner used a different phone. The
 * command key the server mints carries the debt and the week, so asking ten times in one day
 * sends one message.
 *
 * It is called when an administrator opens the app rather than on a schedule, because this
 * project cannot verify from here whether pg_cron is available on the Supabase plan — and a
 * schedule that silently never fires is worse than none, since the owner would believe
 * reminders were going out. If cron is added later it calls this same function and nothing
 * here changes.
 *
 * Mirrors public.sarraf_send_due_debt_reminders.
 */
export async function sendDueDebtReminders(client, { afterDays = 7 } = {}) {
  const { data, error } = await client.rpc("sarraf_send_due_debt_reminders", {
    p_after_days: afterDays,
  });
  if (error) throw error;
  return {
    sent: Number(data?.sent) || 0,
    skipped: Number(data?.skipped) || 0,
    debtIds: Array.isArray(data?.debt_ids) ? data.debt_ids : [],
  };
}
