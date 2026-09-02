import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Search } from "lucide-react";
import { explainBalance, firstNegativeMovement } from "../../services/accounting.js";
import { errorText } from "../../services/userFacingError";
import "./debt-center.css";

/**
 * Why is this balance what it is? (§8)
 *
 *   «لە قاسەی خۆم یوان ناقس دەبێت نازانم ئەوە چییە؟»
 *
 * The owner reported a currency balance going negative and had no way to find out why. That is
 * the whole complaint: not that a number was wrong, but that it could not be questioned. A figure
 * nobody can take apart is a figure nobody can trust, and this system is about to hold real money.
 *
 * So this shows every movement, in order, with the running balance after each — and says plainly
 * whether the balance ever went below zero and which movement took it there. Nothing is hidden
 * and nothing is clamped: §8 is explicit that a negative balance must be explained rather than
 * made to disappear, because clamping it to zero would destroy the evidence of whatever caused it.
 *
 * Both figures come from the server (202609010009). Nothing is added up here, because the owner
 * comparing this screen against the cashbox and finding two different answers is precisely the
 * situation it exists to end.
 */

const COPY = {
  ku: {
    title: "ئەم باڵانسە بۆچی ئەوەندەیە؟",
    subtitle: "هەموو جوڵەیەک، بە ڕیز، لەگەڵ باڵانسی دوای هەریەکەیان",
    currency: "دراو", pick: "دراو هەڵبژێرە", show: "پیشانی بدە",
    loading: "بارکردن…", failed: "زانیارییەکان بار نەبوون", refresh: "نوێکردنەوە",
    empty: "هیچ جوڵەیەک بۆ ئەم دراوە نییە",
    never: "ئەم باڵانسە هەرگیز نەرێنی نەبووە ✓",
    wasNegative: "ئەم باڵانسە نەرێنی بووە — یەکەم جار لێرەدا",
    finalBalance: "باڵانسی ئێستا",
    when: "کات", type: "جۆر", amount: "بڕ", after: "باڵانسی دوایی",
    who: "لای", note: "تێبینی", tx: "مامەڵە",
  },
  en: {
    title: "Why is this balance what it is?",
    subtitle: "Every movement, in order, with the running balance after each",
    currency: "Currency", pick: "Choose a currency", show: "Show",
    loading: "Loading…", failed: "Could not load", refresh: "Refresh",
    empty: "There are no movements for this currency",
    never: "This balance has never gone negative ✓",
    wasNegative: "This balance went negative — first here",
    finalBalance: "Balance now",
    when: "When", type: "Type", amount: "Amount", after: "Balance after",
    who: "Held by", note: "Note", tx: "Transaction",
  },
  ar: {
    title: "لماذا هذا الرصيد بهذا المقدار؟",
    subtitle: "كل حركة، بالترتيب، مع الرصيد الجاري بعد كل منها",
    currency: "العملة", pick: "اختر عملة", show: "اعرض",
    loading: "جارٍ التحميل…", failed: "تعذّر التحميل", refresh: "تحديث",
    empty: "لا توجد حركات لهذه العملة",
    never: "لم يصبح هذا الرصيد سالبًا قط ✓",
    wasNegative: "أصبح هذا الرصيد سالبًا — أول مرة هنا",
    finalBalance: "الرصيد الآن",
    when: "الوقت", type: "النوع", amount: "المبلغ", after: "الرصيد بعدها",
    who: "لدى", note: "ملاحظة", tx: "المعاملة",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—");

export function ExplainBalance({ client, lang = "ku", currencies = [] }) {
  const copy = COPY[localeKey(lang)];
  const [curId, setCurId] = useState("");
  const [state, setState] = useState("idle");
  const [rows, setRows] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const [failure, setFailure] = useState("");

  const load = useCallback(async () => {
    if (!curId) return;
    setState("loading"); setFailure("");
    try {
      // Both, together: the list is the evidence and the verdict is the answer. Showing one
      // without the other would leave the owner to scan five hundred rows for a minus sign.
      const [movements, summary] = await Promise.all([
        explainBalance(client, curId),
        firstNegativeMovement(client, curId),
      ]);
      setRows(movements);
      setVerdict(summary);
      setState("ready");
    } catch (error) {
      setFailure(errorText(error).slice(0, 200));
      setState("error");
    }
  }, [client, curId]);

  useEffect(() => { if (curId) load(); }, [curId, load]);

  return (
    <section className="debt-panel" aria-labelledby="explain-balance-title">
      <header className="debt-header">
        <span className="debt-icon"><Search aria-hidden="true" /></span>
        <div>
          <h2 id="explain-balance-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        {curId && (
          <button type="button" className="debt-refresh" onClick={load}>
            <RefreshCw aria-hidden="true" /> {copy.refresh}
          </button>
        )}
      </header>

      <div className="cashbox-form">
        <label>{copy.currency}
          <select value={curId} onChange={(e) => setCurId(e.target.value)} aria-label={copy.pick}>
            <option value="">{copy.pick}</option>
            {currencies.map((c) => <option key={c.id} value={c.id}>{c.name || c.code}</option>)}
          </select>
        </label>
      </div>

      {failure && <div className="debt-error" role="alert">
        <AlertTriangle aria-hidden="true" /> {copy.failed} — {failure}
      </div>}

      {state === "loading" && <p className="debt-empty">
        <Loader2 aria-hidden="true" /> {copy.loading}
      </p>}

      {state === "ready" && verdict && (
        <div className="debt-cards" role="status">
          <div className="debt-card">
            <span className="debt-card-label">{copy.finalBalance}</span>
            <strong>{money(verdict.finalBalance)}</strong>
            <span className="debt-card-note">{verdict.currency}</span>
          </div>
          {/* The answer to the owner's question, in words rather than as a row to go looking for. */}
          <div className="debt-card">
            <span className="debt-card-label">
              {verdict.everNegative ? copy.wasNegative : copy.never}
            </span>
            {verdict.firstNegative && (
              <>
                <strong>{money(verdict.firstNegative.balanceAfter)}</strong>
                <span className="debt-card-note">
                  {when(verdict.firstNegative.movedAt)} · {verdict.firstNegative.entryType}
                  {verdict.firstNegative.partnerName ? ` · ${verdict.firstNegative.partnerName}` : ""}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {state === "ready" && (rows.length === 0
        ? <p className="debt-empty">{copy.empty}</p>
        : (
          <div className="debt-table-wrap">
            <table className="debt-table">
              <thead><tr>
                <th>{copy.when}</th><th>{copy.type}</th><th>{copy.amount}</th>
                <th>{copy.after}</th><th>{copy.who}</th><th>{copy.note}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  // The row that took it under zero is marked where it happened, not summarised
                  // away — §8 asks for the negative to be explained, never hidden.
                  <tr key={r.ledgerId || r.seq}
                      style={r.wentNegative ? { background: "var(--neg-bg)" } : undefined}>
                    <td>{when(r.movedAt)}</td>
                    <td>{r.entryType}</td>
                    <td>{money(r.amount)}</td>
                    <td style={r.runningBalance < 0 ? { color: "var(--neg)", fontWeight: 700 } : undefined}>
                      {money(r.runningBalance)}
                    </td>
                    <td>{r.partnerName || "—"}</td>
                    <td>{r.note || (r.txId ? `${copy.tx} ${r.txId}` : "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

export default ExplainBalance;
