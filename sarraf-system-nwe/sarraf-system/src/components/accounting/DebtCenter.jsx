import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, RefreshCw, Scale, Wallet } from "lucide-react";
import {
  AGING_BUCKETS, agingBucketOf, loadCustomerVaults, loadDebts,
  loadSubledgerReconciliation, loadTrialBalance, summarizeDebts,
} from "../../services/accounting";
import {
  DEBT_EVENT_KU, OFFSET_REASON_MIN, VOUCHER_KIND_KU, WRITE_OFF_REASON_MIN,
  loadDebtHistory, loadVoucherRegister, offsetAmount, offsetDebts, offsetObjection, writeOffDebt,
} from "../../services/debtRegister";
import "./debt-center.css";
import { errorText } from "../../services/userFacingError";

const COPY = {
  ku: {
    title: "ناوەندی قەرز و قاسە", subtitle: "قەرزەکان بە ئاڕاستە و دراوی ڕوون — بەبێ کۆکردنەوەی دراوەکان",
    weOwe: "قەرزاری ئەوانین", owedToUs: "قەرزاری منن", vaults: "قاسەی کڕیاران",
    aging: "تەمەنی قەرزەکان", ledger: "دۆخی دەفتەر", refresh: "نوێکردنەوە",
    empty: "هیچ قەرزێکی کراوە نییە", emptyVaults: "هیچ قاسەیەک نییە",
    overdue: "بەسەرچووە", due: "بەروار", outstanding: "ماوە", available: "بەردەست", reserved: "تەرخانکراو",
    balanced: "دەفتەر هاوسەنگە", unbalanced: "دەفتەر هاوسەنگ نییە", entries: "تۆمار",
    loading: "بارکردن...", failed: "زانیاری بار نەبوو", owes: "قەرزارە بە",
    zeman: "زیمان", buckets: { current: "ئێستا", "1-7": "١–٧ ڕۆژ", "8-30": "٨–٣٠ ڕۆژ", "31-60": "٣١–٦٠ ڕۆژ", "60+": "٦٠+ ڕۆژ" },
    select: "هەڵبژاردن", offset: "دانانەوەی دوولایەنە", writeOff: "بەخشینی قەرز",
    history: "مێژوو", vouchers: "پسووڵەکان", noVouchers: "هێشتا هیچ پسووڵەیەک دەرنەکراوە",
    reason: "هۆکار", cancel: "پاشگەزبوونەوە", confirm: "جێبەجێکردن", working: "جێبەجێکردن...",
    willCancel: "ئەمەندە دەبڕدرێتەوە", offsetDone: "دانانەوە کرا", writeOffDone: "قەرزەکە بەخشرا",
    voucher: "پسووڵە", pickTwo: "دوو قەرز هەڵبژێرە بۆ دانانەوە",
    reasonHint: (n) => `لانیکەم ${n} پیت`,
  },
  en: {
    title: "Debt & Cashbox Centre", subtitle: "Debts by explicit direction and currency — never netted",
    weOwe: "We owe", owedToUs: "Owed to us", vaults: "Customer cashboxes",
    aging: "Debt aging", ledger: "Ledger status", refresh: "Refresh",
    empty: "No open debts", emptyVaults: "No cashboxes",
    overdue: "Overdue", due: "Due", outstanding: "Outstanding", available: "Available", reserved: "Reserved",
    balanced: "Ledger balanced", unbalanced: "Ledger NOT balanced", entries: "entries",
    loading: "Loading…", failed: "Could not load", owes: "owes",
    zeman: "ZEMAN",
    buckets: { current: "Current", "1-7": "1–7 days", "8-30": "8–30 days", "31-60": "31–60 days", "60+": "60+ days" },
    select: "Select", offset: "Offset", writeOff: "Write off",
    history: "History", vouchers: "Vouchers", noVouchers: "No vouchers issued yet",
    reason: "Reason", cancel: "Cancel", confirm: "Confirm", working: "Working…",
    willCancel: "This much cancels", offsetDone: "Offset recorded", writeOffDone: "Debt written off",
    voucher: "Voucher", pickTwo: "Select two debts to offset",
    reasonHint: (n) => `at least ${n} characters`,
  },
  ar: {
    title: "مركز الديون والخزنة", subtitle: "الديون باتجاه وعملة واضحين — دون دمج العملات",
    weOwe: "علينا", owedToUs: "لنا", vaults: "خزائن الزبائن",
    aging: "أعمار الديون", ledger: "حالة الدفتر", refresh: "تحديث",
    empty: "لا ديون مفتوحة", emptyVaults: "لا خزائن",
    overdue: "متأخر", due: "الاستحقاق", outstanding: "المتبقي", available: "المتاح", reserved: "محجوز",
    balanced: "الدفتر متوازن", unbalanced: "الدفتر غير متوازن", entries: "قيد",
    loading: "جارٍ التحميل…", failed: "تعذر التحميل", owes: "مدين لـ",
    zeman: "زيمان",
    buckets: { current: "حالي", "1-7": "١–٧ أيام", "8-30": "٨–٣٠ يوم", "31-60": "٣١–٦٠ يوم", "60+": "٦٠+ يوم" },
    select: "اختيار", offset: "مقاصّة", writeOff: "إعدام الدين",
    history: "السجل", vouchers: "السندات", noVouchers: "لم تصدر سندات بعد",
    reason: "السبب", cancel: "إلغاء", confirm: "تنفيذ", working: "جارٍ التنفيذ…",
    willCancel: "المبلغ المقاصّ", offsetDone: "تمت المقاصّة", writeOffDone: "أُعدم الدين",
    voucher: "سند", pickTwo: "اختر دينين للمقاصّة",
    reasonHint: (n) => `${n} حرفاً على الأقل`,
  },
};
const localeKey = (lang) => (lang === "en" || lang === "ar" ? lang : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Totals are rendered one row per currency. Summing across currencies is never correct. */
function CurrencyTotals({ totals, tone }) {
  const entries = Object.entries(totals || {});
  if (!entries.length) return <span className="debt-muted">—</span>;
  return (
    <div className="debt-currency-list">
      {entries.map(([currency, amount]) => (
        <div key={currency} className="debt-currency-row">
          <span className="debt-currency-code">{currency}</span>
          <span className={`debt-currency-amount ${tone}`}>{money(amount)}</span>
        </div>
      ))}
    </div>
  );
}

export function DebtCenter({ client, lang = "ku", partyId = null, nameOf = (id) => id, canAct = false, flash }) {
  const copy = COPY[localeKey(lang)];
  const [state, setState] = useState("loading");
  const [debts, setDebts] = useState([]);
  const [vaults, setVaults] = useState([]);
  const [ledger, setLedger] = useState(null);
  const [error, setError] = useState("");
  // §13.C.6/7: the two commands, and §13.F.1's register beside them.
  const [picked, setPicked] = useState([]);
  const [action, setAction] = useState(null);   // { kind: "offset" | "write_off", debtId? }
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [vouchers, setVouchers] = useState([]);
  const [history, setHistory] = useState(null);

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const [d, v] = await Promise.all([
        loadDebts(client, partyId ? { partyId } : {}),
        loadCustomerVaults(client, partyId),
      ]);
      setDebts(d);
      setVaults(v);
      // The ledger check is staff-only; a party seeing their own debts must not fail on it.
      try {
        const [tb, sub] = await Promise.all([loadTrialBalance(client), loadSubledgerReconciliation(client)]);
        setLedger({ ...tb, subledger: sub });
      } catch { setLedger(null); }
      try { setVouchers(await loadVoucherRegister(client, { partyId, limit: 50 })); }
      catch { setVouchers([]); }
      setState("ready");
    } catch (e) {
      console.error("debt centre", e);
      setError(errorText(e));
      setState("error");
    }
  }, [client, partyId]);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => summarizeDebts(debts), [debts]);
  const partyLabel = (type, id) => (type === "zeman" ? copy.zeman : nameOf(id) || id || "—");

  const chosen = picked.map((id) => debts.find((d) => d.id === id)).filter(Boolean);
  // The same check the database makes, shown beside the button rather than arriving afterwards.
  const objection = chosen.length === 2 ? offsetObjection(chosen[0], chosen[1]) : copy.pickTwo;
  const cancels = chosen.length === 2 ? offsetAmount(chosen[0], chosen[1]) : null;
  const reasonMin = action?.kind === "write_off" ? WRITE_OFF_REASON_MIN : OFFSET_REASON_MIN;

  const togglePick = (debtId) => setPicked((prev) => (
    prev.includes(debtId) ? prev.filter((x) => x !== debtId) : [...prev.slice(-1), debtId]));

  const say = (message) => (flash ? flash(message) : console.info(message));

  const runAction = async () => {
    if (busy || !action) return;
    setBusy(true);
    try {
      if (action.kind === "offset") {
        const { result } = await offsetDebts(client, {
          leftDebtId: chosen[0].id, rightDebtId: chosen[1].id, reason,
        });
        say(`${copy.offsetDone} · ${copy.voucher} ${result?.voucher || ""}`);
        setPicked([]);
      } else {
        const { result } = await writeOffDebt(client, { debtId: action.debtId, reason });
        say(`${copy.writeOffDone} · ${copy.voucher} ${result?.voucher || ""}`);
      }
      setAction(null);
      setReason("");
      await load();
    } catch (e) {
      console.error("debt command", e);
      say(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async (debtId) => {
    if (history?.debt_id === debtId) return setHistory(null);
    try { setHistory(await loadDebtHistory(client, debtId)); }
    catch (e) { say(errorText(e)); }
  };

  if (state === "loading") return <div className="debt-panel"><div className="debt-loading">{copy.loading}</div></div>;
  if (state === "error") {
    return (
      <div className="debt-panel">
        <div className="debt-error" role="alert">
          <AlertTriangle aria-hidden="true" /> {copy.failed}
          <button type="button" onClick={load}><RefreshCw aria-hidden="true" /> {copy.refresh}</button>
        </div>
        <p className="debt-muted debt-error-detail">{error}</p>
      </div>
    );
  }

  return (
    <section className="debt-panel" aria-labelledby="debt-centre-title">
      <header className="debt-header">
        <span className="debt-icon"><Scale aria-hidden="true" /></span>
        <div>
          <h2 id="debt-centre-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      <div className="debt-cards">
        <article className="debt-card is-negative">
          <h3><ArrowUpRight aria-hidden="true" /> {copy.weOwe}</h3>
          <CurrencyTotals totals={summary.weOwe} tone="neg" />
        </article>
        <article className="debt-card is-positive">
          <h3><ArrowDownLeft aria-hidden="true" /> {copy.owedToUs}</h3>
          <CurrencyTotals totals={summary.owedToUs} tone="pos" />
        </article>
        <article className="debt-card">
          <h3><Wallet aria-hidden="true" /> {copy.vaults}</h3>
          {vaults.length === 0 ? <span className="debt-muted">{copy.emptyVaults}</span> : (
            <div className="debt-currency-list">
              {vaults.map((v) => (
                <div key={v.id} className="debt-currency-row">
                  <span className="debt-currency-code">{v.currency}</span>
                  <span className="debt-currency-amount">{money(v.available)}</span>
                </div>
              ))}
            </div>
          )}
        </article>
      </div>

      {ledger && (
        <div className={`debt-ledger ${ledger.balanced ? "is-ok" : "is-bad"}`} role="status">
          {ledger.balanced ? copy.balanced : copy.unbalanced}
          {" · "}{ledger.entryCount} {copy.entries}
          {!ledger.balanced && <strong> · {money(ledger.difference)}</strong>}
        </div>
      )}

      <div className="debt-aging">
        <h3>{copy.aging}</h3>
        <div className="debt-aging-grid">
          {AGING_BUCKETS.map((bucket) => (
            <div key={bucket} className={`debt-aging-cell ${bucket === "60+" ? "is-severe" : ""}`}>
              <span className="debt-aging-label">{copy.buckets[bucket]}</span>
              <CurrencyTotals totals={summary.byBucket[bucket]} tone="" />
            </div>
          ))}
        </div>
      </div>

      {debts.length === 0 ? (
        <p className="debt-muted debt-empty">{copy.empty}</p>
      ) : (
        <div className="debt-table-wrap">
          <table className="debt-table">
            <thead>
              <tr>
                {canAct && <th scope="col">{copy.select}</th>}
                <th scope="col">{copy.owes}</th>
                <th scope="col">{copy.outstanding}</th>
                <th scope="col">{copy.due}</th>
              </tr>
            </thead>
            <tbody>
              {debts.map((d) => {
                const bucket = agingBucketOf(d.dueAt);
                return (
                  <tr key={d.id} className={d.overdue ? "is-overdue" : ""}>
                    {canAct && (
                      <td>
                        <input type="checkbox" checked={picked.includes(d.id)}
                          onChange={() => togglePick(d.id)}
                          aria-label={`${copy.select} ${d.id}`} />
                      </td>
                    )}
                    <td>
                      {/* Stated in words: who owes whom, in which currency. */}
                      <strong>{partyLabel(d.debtorType, d.debtorId)}</strong>
                      {" "}{copy.owes}{" "}
                      <strong>{partyLabel(d.creditorType, d.creditorId)}</strong>
                      <span className="debt-reason">{d.reason}</span>
                    </td>
                    <td className="debt-amount">
                      {money(d.outstanding)} <span className="debt-currency-code">{d.currency}</span>
                    </td>
                    <td>
                      {d.dueAt ? new Date(d.dueAt).toLocaleDateString("en-GB") : "—"}
                      {d.overdue && <span className="debt-badge">{copy.overdue} · {copy.buckets[bucket]}</span>}
                      <span className="debt-row-actions">
                        <button type="button" onClick={() => openHistory(d.id)}>{copy.history}</button>
                        {canAct && (
                          <button type="button" onClick={() => { setAction({ kind: "write_off", debtId: d.id }); setReason(""); }}>
                            {copy.writeOff}
                          </button>
                        )}
                      </span>
                      {history?.debt_id === d.id && (
                        <ul className="debt-history">
                          {(history.events || []).map((e) => (
                            <li key={e.id}>
                              <strong>{DEBT_EVENT_KU[e.kind] || e.kind}</strong>
                              {" "}{money(e.amount)} {e.currency}
                              {e.voucher ? ` · ${e.voucher}` : ""}
                              <span className="debt-muted"> {new Date(e.created_at).toLocaleDateString("en-GB")}</span>
                              {e.reason ? <span className="debt-reason">{e.reason}</span> : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* §13.C.6 — netting. The objection, if there is one, is stated before the button. */}
      {canAct && debts.length > 0 && (
        <div className="debt-offset-bar" role="group" aria-label={copy.offset}>
          <span className={objection ? "debt-muted" : ""}>
            {objection || `${copy.willCancel}: ${money(cancels)} ${chosen[0]?.currency || ""}`}
          </span>
          <button type="button" disabled={!!objection}
            onClick={() => { setAction({ kind: "offset" }); setReason(""); }}>
            {copy.offset}
          </button>
        </div>
      )}

      {action && (
        <div className="debt-action" role="dialog" aria-label={action.kind === "offset" ? copy.offset : copy.writeOff}>
          <label htmlFor="debt-action-reason">
            {copy.reason} <span className="debt-muted">({copy.reasonHint(reasonMin)})</span>
          </label>
          <textarea id="debt-action-reason" value={reason} rows={2}
            onChange={(e) => setReason(e.target.value)} />
          <div className="debt-action-buttons">
            <button type="button" onClick={() => { setAction(null); setReason(""); }} disabled={busy}>
              {copy.cancel}
            </button>
            <button type="button" onClick={runAction} disabled={busy || reason.trim().length < reasonMin}>
              {busy ? copy.working : copy.confirm}
            </button>
          </div>
        </div>
      )}

      {/* §13.F.1 — the numbered register. */}
      <div className="debt-vouchers">
        <h3>{copy.vouchers}</h3>
        {vouchers.length === 0 ? <p className="debt-muted">{copy.noVouchers}</p> : (
          <ul>
            {vouchers.map((v) => (
              <li key={v.id}>
                <strong>{v.reference}</strong>
                {" · "}{VOUCHER_KIND_KU[v.kind] || v.kind}
                {" · "}{money(v.amount)} <span className="debt-currency-code">{v.currency}</span>
                <span className="debt-muted"> {new Date(v.issued_at).toLocaleDateString("en-GB")}</span>
                <span className="debt-reason">{v.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
