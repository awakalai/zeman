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
 * Two places and two amounts. The difference between them may be the earning, and so may a
 * figure the owner types in:
 *
 *   «لە کوێوە دەردەچیت و بۆ کوێ دەچێت یەکسانە بڕەکەی، بەڵام دەبێت چوارگۆشەیەکی تر هەبێت،
 *    کە بڕێکی تێدا دابنێم، هەقی ئەم ئیشە... وە ئاماژە بەوەش بکەم کە بۆ چ کەسێکی دەکەم.»
 *
 * So the screen offers both and neither is required. A trade may earn on the spread, on a
 * stated fee, on both, or on nothing at all. 202609020005 once wrote "There is no fee on the
 * side" into the migration history; 202609020017 withdrew it.
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
    ownMoney: "قاسەی تایبەتی خۆم",
    overOwn: "ئەم مامەڵەیە لە پارەی خۆت زیاترە — خێرەکەی هەمووی هی تۆیە بەڵام پارەکەی هی هەمووانە",
    fee: "هەقی ئەم ئیشە", feeWhere: "هەقی کار بۆ کوێ چوو", feeFor: "ئیشەکە بۆ کێ کرا",
    nobody: "بۆ کەسێکی دیاریکراو نییە",
    feeHint: "بەتاڵ بهێڵەرەوە ئەگەر هەقی کارت نەگرتووە",
    feePrivate: "ئەو کەسەی ناوی دەنووسیت مامەڵەکە دەبینێت، بەڵام هەقی کارەکە نا",
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
    ownMoney: "My own safe",
    overOwn: "This is more than your own money — the earning is all yours but the money is everyone's",
    fee: "The fee for this work", feeWhere: "Where the fee went", feeFor: "Who the work was for",
    nobody: "Nobody in particular",
    feeHint: "Leave it empty if you charged nothing",
    feePrivate: "The person you name sees the trade, but never the fee",
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
    ownMoney: "خزنتي الخاصة",
    overOwn: "هذه المعاملة تتجاوز مالك الخاص — الربح كله لك لكن المال للجميع",
    fee: "أجر هذا العمل", feeWhere: "أين ذهب الأجر", feeFor: "لمن أُنجز العمل",
    nobody: "لا أحد بعينه",
    feeHint: "اتركه فارغًا إن لم تأخذ أجرًا",
    feePrivate: "الشخص الذي تسميه يرى المعاملة، لكن لا يرى الأجر",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US",
  { maximumFractionDigits: 4 });

export function CommissionTrade({ client, lang = "ku", currencies = [], ownMoney = null,
                                  people = [], onRecorded }) {
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
  // «هەقی ئەم ئیشە» and «بۆ چ کەسێکی دەکەم». Both optional, both judged on the server.
  const [feeAmount, setFeeAmount] = useState("");
  const [feePlace, setFeePlace] = useState("");
  const [forParty, setForParty] = useState("");

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

  // «ئەوانی دیکە هی خۆمە تەنها.» The earning of a commission trade is the owner's alone, so the
  // money it is made with should be theirs alone too. The server checks the place has the money;
  // it cannot check whose money it is, because in one safe holding everybody's that is a claim
  // and not a balance. Said here, not refused — see the note in TxForm for why.
  const ownHere = ownMoney ? Number(ownMoney[fromCur] || 0) : null;
  const overOwn = ownHere !== null && Number(fromAmount) > ownHere + 1e-9;

  const placeName = (id) => accounts.find((a) => a.id === id)?.name || copy.cash;

  // The fee is earned in the currency that arrived, because that is the side the business is
  // left holding — the same rule the command applies, said here so the label is not a guess.
  const feeValid = feePlace === "" || placesFor(toCur).some((a) => a.id === feePlace);
  const feeWhere = feeValid ? feePlace : "";
  const fee = Number(feeAmount);
  const feeNamed = feeAmount.trim() !== "" && Number.isFinite(fee) && fee > 0;
  const feeCurrencyName = currencies.find((c) => c.id === toCur)?.code
    || currencies.find((c) => c.id === toCur)?.name || "";
  // A person who is not somebody this business knows would be refused by the server; the list
  // only offers people it does know, so the refusal never has to happen.
  const namedPerson = people.find((u) => u.id === forParty) || null;

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

      {overOwn && <div className="debt-error" role="status">
        <AlertTriangle aria-hidden="true" /> {copy.overOwn}
        {" — "}{copy.ownMoney}: {money(ownHere)}
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

      {/* «دەبێت چوارگۆشەیەکی تر هەبێت، کە بڕێکی تێدا دابنێم، هەقی ئەم ئیشە.» The box the owner
          asked for. Nothing here is required: a trade the owner did for free is a trade. */}
      <div className="cashbox-form">
        <label>{copy.fee}{feeCurrencyName ? ` — ${feeCurrencyName}` : ""}
          <input type="number" inputMode="decimal" min="0" value={feeAmount}
                 aria-label={copy.fee} placeholder={copy.feeHint}
                 onChange={(e) => setFeeAmount(e.target.value)} />
        </label>
        <label>{copy.feeWhere}
          <select value={feeWhere} onChange={(e) => setFeePlace(e.target.value)}
                  aria-label={copy.feeWhere} disabled={!feeNamed}>
            <option value="">{copy.cash}</option>
            {placesFor(toCur).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>{copy.feeFor}
          <select value={forParty} onChange={(e) => setForParty(e.target.value)}
                  aria-label={copy.feeFor}>
            <option value="">{copy.nobody}</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
      </div>

      {/* Said once, where the decision is made: sections 10 and 16 forbid showing a customer
          what ZEMAN earned, and the fee is deliberately not stored on the transaction row. */}
      {namedPerson && <p className="debt-empty">{copy.feePrivate}</p>}

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
              // Sent as typed. A blank box is no fee, not a zero the screen invented, and the
              // amount is not rounded here — the books decide what a number means.
              feeAmount: feeNamed ? fee : 0,
              feeAccountId: feeNamed ? (feeWhere || null) : null,
              forPartyId: forParty || null,
            });
            setDone(answer);
            setFromAmount(""); setToAmount(""); setNote("");
            setFeeAmount(""); setFeePlace(""); setForParty("");
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
              {Number(done.fee?.amount) > 0 && <>
                {" — "}{copy.fee}: {money(done.fee.amount)}
              </>}
              {done.for?.name && <>{" — "}{copy.feeFor}: {done.for.name}</>}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

export default CommissionTrade;
