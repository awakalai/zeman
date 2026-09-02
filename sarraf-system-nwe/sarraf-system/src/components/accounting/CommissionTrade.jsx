import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Loader2 } from "lucide-react";
import { commissionTrade, loadCashAccounts } from "../../services/accounting.js";
import { errorText } from "../../services/userFacingError";
import "./debt-center.css";

/**
 * مامەڵەی عمولە — the third kind of trade.
 *
 *   «دەڵێم ٥٠هەزارم بە ئێف ئایبی فرۆشتووە بە ٥١ هەزار — واتا ٥٠ هەزار لە قاسە دەڕوات،
 *    ٥١ هەزاری کاش دێتە ناوی.»
 *
 *   «١٠٠ هەزار دینار ئێف ئایبی دەفرۆشم بە ١٠١ هەزار دیناری کاش، لە بەشی کاش زیاد دەبێت و
 *    لە بەشی ئێف ئایبی کەم دەکات.»
 *
 * Two places and two amounts, and the difference between them is the earning. Not a principal
 * with a fee on the side — that was the misreading this replaces.
 *
 * ── Why the earning is not shown as one number here ──────────────────────────────────────────
 *
 * When both sides are the same currency the difference is plain arithmetic and the screen says
 * it, because hiding it would make the owner do it in their head. When the two sides are
 * different currencies it does NOT say it: 50,000 dinars for 35 dollars has an earning only
 * once you fix a rate between them, the server values it against the day's rate, and a figure
 * this screen invented would disagree with the books. The report answers that question; a form
 * should not guess at it.
 */

const COPY = {
  ku: {
    title: "مامەڵەی عمولە",
    subtitle: "پارە لە شوێنێکەوە بۆ شوێنێکی تر — جیاوازییەکە خێرەکەیە",
    from: "لە کوێوە دەردەچێت", to: "بۆ کوێ دەچێت",
    cash: "کاش", amount: "بڕ", currency: "دراو",
    earning: "خێری ئەم مامەڵەیە", earningAcross: "بە دوو دراوی جیاواز — خێرەکە لە ڕاپۆرتدا بە نرخی ئەمڕۆ دەردەکەوێت",
    record: "تۆمارکردن", recording: "تۆمار دەکرێت…", done: "تۆمار کرا ✓",
    loading: "بارکردن…", failed: "زانیارییەکان بار نەبوون",
    needAccounts: "سەرەتا لە قاسەدا حسابێک بکەرەوە — بێ حساب ئەم مامەڵەیە هیچ شوێنێکی نییە بۆ ناوبردن",
    samePlace: "پارەکە دەبێت لە شوێنێکەوە بۆ شوێنێکی تر بجوڵێت",
    loss: "ئەمە زەرەرە، نەک خێر — دڵنیایت؟",
  },
  en: {
    title: "Commission trade",
    subtitle: "Money from one place to another — the difference is the earning",
    from: "Leaves from", to: "Arrives at",
    cash: "Cash", amount: "Amount", currency: "Currency",
    earning: "Earned on this trade",
    earningAcross: "Two different currencies — the earning appears in the report at today's rate",
    record: "Record", recording: "Recording…", done: "Recorded ✓",
    loading: "Loading…", failed: "Could not load",
    needAccounts: "Open an account in قاسە first — without one this trade has no place to name",
    samePlace: "The money has to move from one place to another",
    loss: "This is a loss, not an earning — is that right?",
  },
  ar: {
    title: "معاملة عمولة",
    subtitle: "المال من مكان إلى آخر — والفرق هو الربح",
    from: "يخرج من", to: "يصل إلى",
    cash: "نقد", amount: "المبلغ", currency: "العملة",
    earning: "الربح من هذه المعاملة",
    earningAcross: "عملتان مختلفتان — يظهر الربح في التقرير بسعر اليوم",
    record: "تسجيل", recording: "جارٍ التسجيل…", done: "تم التسجيل ✓",
    loading: "جارٍ التحميل…", failed: "تعذّر التحميل",
    needAccounts: "افتح حسابًا في الخزنة أولًا — بدونه لا مكان تسميه هذه المعاملة",
    samePlace: "يجب أن ينتقل المال من مكان إلى آخر",
    loss: "هذه خسارة وليست ربحًا — هل هذا صحيح؟",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US",
  { maximumFractionDigits: 4 });

export function CommissionTrade({ client, lang = "ku", currencies = [], onRecorded }) {
  const copy = COPY[localeKey(lang)];
  const [state, setState] = useState("loading");
  const [accounts, setAccounts] = useState([]);
  const [failure, setFailure] = useState("");
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);

  const firstCurrency = currencies[0]?.id || "";
  const [fromPlace, setFromPlace] = useState("");
  const [fromCur, setFromCur] = useState(firstCurrency);
  const [fromAmount, setFromAmount] = useState("");
  const [toPlace, setToPlace] = useState("");
  const [toCur, setToCur] = useState(firstCurrency);
  const [toAmount, setToAmount] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setAccounts((await loadCashAccounts(client)).filter((a) => a.active));
      setState("ready");
    } catch {
      setState("error");
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  const placesFor = useCallback(
    (curId) => accounts.filter((a) => a.currencyId === curId), [accounts]);

  // An account opened for dinars cannot hold dollars, so a currency change clears a place that
  // no longer belongs to it rather than sending the server a pairing it will refuse.
  const fromValid = fromPlace === "" || placesFor(fromCur).some((a) => a.id === fromPlace);
  const toValid = toPlace === "" || placesFor(toCur).some((a) => a.id === toPlace);
  const from = fromValid ? fromPlace : "";
  const to = toValid ? toPlace : "";

  const sameCurrency = fromCur === toCur;
  const samePlace = sameCurrency && from === to;
  const earning = useMemo(() => {
    if (!sameCurrency) return null;
    const out = Number(fromAmount), back = Number(toAmount);
    if (!(out > 0) || !(back > 0)) return null;
    return back - out;
  }, [sameCurrency, fromAmount, toAmount]);

  const ready = Number(fromAmount) > 0 && Number(toAmount) > 0 && !samePlace && !busy;

  const placeName = (id) => accounts.find((a) => a.id === id)?.name || copy.cash;

  if (state === "loading") return (
    <section className="debt-panel"><p className="debt-empty">
      <Loader2 aria-hidden="true" /> {copy.loading}
    </p></section>
  );

  if (state === "error") return (
    <section className="debt-panel"><div className="debt-error" role="alert">
      <AlertTriangle aria-hidden="true" /> {copy.failed}
    </div></section>
  );

  return (
    <section className="debt-panel" aria-labelledby="commission-trade-title">
      <header className="debt-header">
        <span className="debt-icon"><ArrowLeftRight aria-hidden="true" /></span>
        <div>
          <h2 id="commission-trade-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
      </header>

      {accounts.length === 0 && <p className="debt-empty">{copy.needAccounts}</p>}

      {failure && <div className="debt-error" role="alert">
        <AlertTriangle aria-hidden="true" /> {failure}
      </div>}

      <div className="cashbox-form">
        <label>{copy.from}
          <select value={from} onChange={(e) => setFromPlace(e.target.value)} aria-label={copy.from}>
            <option value="">{copy.cash}</option>
            {placesFor(fromCur).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>{copy.currency}
          <select value={fromCur} onChange={(e) => setFromCur(e.target.value)}
                  aria-label={`${copy.from} — ${copy.currency}`}>
            {currencies.map((c) => <option key={c.id} value={c.id}>{c.name || c.code}</option>)}
          </select>
        </label>
        <label>{copy.amount}
          <input type="number" inputMode="decimal" value={fromAmount} aria-label={`${copy.from} — ${copy.amount}`}
                 onChange={(e) => setFromAmount(e.target.value)} />
        </label>
      </div>

      <div className="cashbox-form">
        <label>{copy.to}
          <select value={to} onChange={(e) => setToPlace(e.target.value)} aria-label={copy.to}>
            <option value="">{copy.cash}</option>
            {placesFor(toCur).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>{copy.currency}
          <select value={toCur} onChange={(e) => setToCur(e.target.value)}
                  aria-label={`${copy.to} — ${copy.currency}`}>
            {currencies.map((c) => <option key={c.id} value={c.id}>{c.name || c.code}</option>)}
          </select>
        </label>
        <label>{copy.amount}
          <input type="number" inputMode="decimal" value={toAmount} aria-label={`${copy.to} — ${copy.amount}`}
                 onChange={(e) => setToAmount(e.target.value)} />
        </label>
      </div>

      {samePlace && <div className="debt-error" role="alert">
        <AlertTriangle aria-hidden="true" /> {copy.samePlace}
      </div>}

      {/* Said plainly when it can be said exactly, and not invented when it cannot. */}
      {earning !== null && (
        <div className="debt-cards" role="status">
          <div className="debt-card">
            <span className="debt-card-label">{copy.earning}</span>
            <strong>{money(earning)}</strong>
            <span className="debt-card-note">
              {earning < 0 ? copy.loss : `${placeName(from)} → ${placeName(to)}`}
            </span>
          </div>
        </div>
      )}
      {!sameCurrency && <p className="debt-empty">{copy.earningAcross}</p>}

      <div className="cashbox-form">
        <label>{copy.title}
          <input value={note} onChange={(e) => setNote(e.target.value)} aria-label={copy.title} />
        </label>
        <button type="button" disabled={!ready} onClick={async () => {
          setBusy(true); setFailure(""); setDone(null);
          try {
            // Whether the source can cover this is the server's judgement, under a lock on the
            // holding. Nothing is decided here, so two presses cannot both spend the same money.
            const answer = await commissionTrade(client, {
              fromAccountId: from || null, fromCurrencyId: fromCur, fromAmount: Number(fromAmount),
              toAccountId: to || null, toCurrencyId: toCur, toAmount: Number(toAmount),
              note: note.trim() || null,
            });
            setDone(answer);
            setFromAmount(""); setToAmount(""); setNote("");
            await load();
            if (typeof onRecorded === "function") onRecorded(answer);
          } catch (error) {
            setFailure(errorText(error).slice(0, 200));
          } finally {
            setBusy(false);
          }
        }}>
          {busy ? copy.recording : copy.record}
        </button>
      </div>

      {done && (
        <div className="debt-cards" role="status">
          <div className="debt-card">
            <span className="debt-card-label">{copy.done}</span>
            <strong>#{done.code ?? "—"}</strong>
            <span className="debt-card-note">
              <CheckCircle2 aria-hidden="true" />{" "}
              {done.from?.name} {money(done.from?.amount)} → {done.to?.name} {money(done.to?.amount)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

export default CommissionTrade;
