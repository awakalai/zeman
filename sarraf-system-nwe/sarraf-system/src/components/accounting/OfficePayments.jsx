import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Building2, CheckCircle2, Clock, RefreshCw, Send } from "lucide-react";
import "./debt-center.css";
import { errorText } from "../../services/userFacingError";

/**
 * «هەر کە درووستکردنی کڕین لەم فیشەوەم کرد ... نووسینگەش کە پارەی ئەو کەسانەی دا ، بڵێ پارەم داوە
 *  و ببێت بە قەرز لای من ، و هەر کاتێک ویستم حسابی نووسینگەکە بدەم و تەواو.»
 *
 * What this screen used to ask for, to record one act: بینیم, then دەستم پێکرد, then پارەم دا with
 * an amount, a reference, a note and a photograph — and then an administrator to confirm it with a
 * reason of at least eight characters. Seven things, four of them typed, for a press.
 *
 * It asks for one now. The office sees whose payment it is and how much, and says it paid. The
 * amount is the transaction's and is not editable here, which is why there is no field for it.
 *
 * The three totals and what ZEMAN owes come from the same call as the list, because an office
 * cannot read app_users under row-level security — it sees exactly one person there, itself — and
 * the name of the customer is the first thing this screen has to show.
 */

const COPY = {
  ku: {
    title: "پارەدانی نووسینگە", subtitle: "پارەی ئەم کەسانە بدە، دواتر «پارەم دا» لێبدە",
    empty: "هیچ پارەدانێکی چاوەڕوان نییە ✓", refresh: "نوێکردنەوە", loading: "بارکردن…",
    waiting: "چاوەڕوانی پارەدان", paidList: "دراوەکان", pay: "پارەم دا", working: "دەنێردرێت…",
    owed: "قەرزی ZEMAN بۆ من", owedNone: "هیچ قەرزێک نەماوە ✓",
    day: "ئەمڕۆ", week: "ئەم هەفتەیە", month: "ئەم مانگە",
    failed: "زانیاریی ئەرکەکانی نووسینگە بار نەبوو",
    paid: "دراوە", done: "پارەکە درا ✓",
    watching: "تۆ وەک ئەم نووسینگەیە سەیر دەکەیت — تەنها خۆیان دەتوانن بڵێن پارەیان داوە",
  },
  en: {
    title: "Office payments", subtitle: "Pay these people, then press “I paid”",
    empty: "No payment waiting ✓", refresh: "Refresh", loading: "Loading…",
    waiting: "Waiting to be paid", paidList: "Paid", pay: "I paid", working: "Sending…",
    owed: "ZEMAN owes me", owedNone: "Nothing outstanding ✓",
    day: "Today", week: "This week", month: "This month",
    failed: "Could not load the office assignments",
    paid: "Paid", done: "Recorded ✓",
    watching: "You are viewing as this office — only they can say they paid",
  },
  ar: {
    title: "مدفوعات المكتب", subtitle: "ادفع لهؤلاء، ثم اضغط «دفعتُ»",
    empty: "لا توجد مدفوعات معلّقة ✓", refresh: "تحديث", loading: "جارٍ التحميل…",
    waiting: "بانتظار الدفع", paidList: "المدفوع", pay: "دفعتُ", working: "جارٍ الإرسال…",
    owed: "زيمان مدين لي", owedNone: "لا يوجد رصيد مستحق ✓",
    day: "اليوم", week: "هذا الأسبوع", month: "هذا الشهر",
    failed: "تعذّر تحميل مهام المكتب",
    paid: "مدفوع", done: "تم التسجيل ✓",
    watching: "أنت تشاهد بصفة هذا المكتب — وحدهم من يمكنه تأكيد الدفع",
  },
};
const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB");
};

const commandKey = () =>
  `office-paid:${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;

/** A row of per-currency figures, or a dash. Used for all three totals and for what is owed. */
const Figures = ({ rows, label, tone }) => (
  <div className="debt-currency-row">
    <span className="debt-currency-code">{label}</span>
    <span className={`debt-currency-amount ${tone || ""}`}>
      {rows?.length
        ? rows.map((r) => `${money(r.amount)} ${r.currency}`).join(" · ")
        : "—"}
    </span>
  </div>
);

export function OfficePayments({ client, lang = "ku", flash = () => {}, officeId = null }) {
  const copy = COPY[localeKey(lang)];
  const [board, setBoard] = useState(null);
  const [state, setState] = useState("loading");
  const [busy, setBusy] = useState("");
  // One key per assignment, kept across retries: pressing again after a dropped connection is the
  // same payment, and the server treats a repeat of the same key as the press it already has.
  const keys = useRef(new Map());
  const keyFor = (id) => {
    if (!keys.current.has(id)) keys.current.set(id, commandKey());
    return keys.current.get(id);
  };

  const load = useCallback(async () => {
    setState((s) => (s === "ready" ? "ready" : "loading"));
    try {
      // The owner reaches this screen through «بینین وەک», where the database still sees them
      // and not the office. The board is told whose it is; the server decides whether they may
      // read it, and answers `may_pay` for whether they may act on it.
      const { data, error } = await client.rpc("sarraf_office_board", { p_days: 60, p_office_id: officeId });
      if (error) throw error;
      setBoard(data || { waiting: [], paid: [], owed: [], totals: {} });
      setState("ready");
    } catch (e) {
      console.error("office board", e);
      flash(errorText(e));
      setState("error");
    }
  }, [client, flash, officeId]);

  useEffect(() => { load(); }, [load]);

  const pay = async (row) => {
    if (busy) return;
    setBusy(row.id);
    try {
      const { error } = await client.rpc("sarraf_office_payment_paid", {
        p_assignment_id: row.id,
        p_note: null,
        p_command_key: keyFor(row.id),
      });
      if (error) throw error;
      keys.current.delete(row.id);
      flash(copy.done);
      await load();
    } catch (e) {
      console.error("office paid", e);
      flash(errorText(e), "error");
    } finally { setBusy(""); }
  };

  if (state === "loading") return <div className="debt-panel"><div className="debt-loading">{copy.loading}</div></div>;
  if (state === "error") return (
    <section className="debt-panel">
      <div className="debt-error" role="alert"><AlertTriangle aria-hidden="true" /> {copy.failed}
        <button type="button" onClick={load}><RefreshCw aria-hidden="true" /> {copy.refresh}</button>
      </div>
    </section>
  );

  const waiting = board?.waiting || [];
  const paid = board?.paid || [];
  const owed = board?.owed || [];
  const totals = board?.totals || {};

  return (
    <section className="debt-panel" aria-labelledby="office-pay-title">
      <header className="debt-header">
        <span className="debt-icon"><Building2 aria-hidden="true" /></span>
        <div>
          <h2 id="office-pay-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      {/* What ZEMAN owes, and what has been paid over three windows. The first goes to zero the
          moment the owner settles the account; the other three are a record and do not. */}
      <article className="debt-card">
        <div className="debt-currency-list">
          <Figures label={copy.owed} rows={owed} tone={owed.length ? "neg" : ""} />
          {!owed.length && <p className="debt-muted">{copy.owedNone}</p>}
        </div>
        <div className="debt-currency-list">
          <Figures label={copy.day} rows={totals.day} tone="pos" />
          <Figures label={copy.week} rows={totals.week} tone="pos" />
          <Figures label={copy.month} rows={totals.month} tone="pos" />
        </div>
      </article>

      <h3 className="debt-subhead">{copy.waiting}</h3>
      {waiting.length === 0 ? <p className="debt-muted debt-empty">{copy.empty}</p> : waiting.map((row) => (
        <article key={row.id} className="debt-card">
          <div className="debt-currency-row">
            <span className="debt-card-title">
              <strong>{row.customer}</strong>
              <span className="debt-reason">{when(row.assigned_at)}</span>
            </span>
            <span className="debt-currency-amount">
              {money(row.amount)} <span className="debt-currency-code">{row.currency}</span>
            </span>
          </div>
          {board?.may_pay === false
            ? <p className="debt-muted" style={{ marginTop: 10 }}>{copy.watching}</p>
            : (
              <button type="button" className="debt-primary debt-press"
                      disabled={busy === row.id} onClick={() => pay(row)}>
                <Send aria-hidden="true" /> {busy === row.id ? copy.working : copy.pay}
              </button>
            )}
        </article>
      ))}

      {paid.length > 0 && (
        <>
          <h3 className="debt-subhead">{copy.paidList}</h3>
          {paid.map((row) => (
            <article key={row.id} className="debt-card">
              <div className="debt-currency-row">
                <span className="debt-card-title">
                  <strong>{row.customer}</strong>
                  <span className="debt-reason">{when(row.paid_at)}</span>
                </span>
                <span className="debt-currency-amount pos">
                  {money(row.amount)} <span className="debt-currency-code">{row.currency}</span>
                </span>
              </div>
              <span className="debt-badge is-ok" style={{ background: "var(--pos-bg)", color: "var(--pos)" }}>
                <CheckCircle2 aria-hidden="true" style={{ width: 11, height: 11, verticalAlign: "-1px" }} />
                {" "}{copy.paid}
              </span>
            </article>
          ))}
        </>
      )}
    </section>
  );
}

export default OfficePayments;
