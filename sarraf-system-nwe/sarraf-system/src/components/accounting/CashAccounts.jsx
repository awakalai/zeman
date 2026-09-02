import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Banknote, Loader2, Plus, RefreshCw } from "lucide-react";
import { accountingCommandKey, loadCashAccounts, openCashAccount, recordService }
  from "../../services/accounting.js";
import { errorText } from "../../services/userFacingError";
import "./debt-center.css";

/**
 * The places this business holds money that are not the main safe, and the commission it earns
 * for moving money through them (§3).
 *
 *   «تۆ دێیت دەڵێیت یەک ملیۆن ئێف ئای بیم بۆ داخڵ بکە، یەک ملیۆن لە حسابی ئێف ئای بی دەڕوات و
 *    یەک ملیۆن بۆ قاسە زیاد دەبێت، بەڵام ٣٠٠٠ دینار عمولەت لێ وەردەگرم حەقی ئەو کارە.
 *    ئەمە نمونەیە ئەگینا دەیان شتیبتر عمولەی هەیە.»
 *
 * FIB is the example, not the feature. What the owner described is a kind of transaction the
 * system did not have: money moves between an account and the safe, and a separate fee is earned
 * for doing it. So this screen has no idea what FIB is — it knows about accounts, in any
 * currency, of any kind, and about a commission.
 *
 * ── One million and three thousand are different kinds of money ───────────────────────────────
 *
 * The principal passes through; the commission is earned. They land in different accounts —
 * acc-4100 داهاتی فی, never acc-4000 قازانجی ئاڵوگۆڕ, because a fee is not a trading spread and
 * mixing them makes the profit figure meaningless. This screen never offers a single figure that
 * adds them together, and the confirmation after a service says both separately for the same
 * reason.
 *
 * A commission can also be earned without being collected yet. That is a receivable, not cash,
 * and saying so is the difference between knowing what you have and knowing what you are owed.
 */

const COPY = {
  ku: {
    title: "حسابەکان و عمولە",
    subtitle: "ئەو شوێنانەی پارەت تێدایە جگە لە قاسەی گشتی — و ئەو عمولەیەی لێی وەردەگریت",
    accounts: "حسابەکان", none: "هێشتا هیچ حسابێک نەکراوەتەوە",
    open: "کردنەوەی حسابێکی نوێ", name: "ناوی حساب", currency: "دراو", kind: "جۆر",
    kinds: { bank: "بانک", wallet: "جزدان", safe: "قاسە", other: "شتی تر" },
    create: "بکەرەوە", balance: "باڵانس", refresh: "نوێکردنەوە", loading: "بارکردن…",
    failed: "زانیارییەکان بار نەبوون",
    service: "مامەڵەی خزمەتگوزاری", pick: "حساب هەڵبژێرە",
    intoSafe: "لە حسابەوە بۆ قاسە", fromSafe: "لە قاسەوە بۆ حساب",
    amount: "بڕی سەرەکی", commission: "عمولە",
    collected: "عمولەکە وەرگیراوە", owed: "عمولەکە قەرزە",
    note: "تێبینی", record: "تۆمارکردن", recording: "تۆمار دەکرێت…",
    done: "تۆمار کرا ✓", principalWas: "بڕی سەرەکی", commissionWas: "عمولە",
    receivable: "عمولەی قەرز",
    hint: "بڕی سەرەکی و عمولە دوو شتی جیاوازن — عمولە دەچێتە داهاتی فی، نەک قازانجی ئاڵوگۆڕ",
  },
  en: {
    title: "Accounts & commission",
    subtitle: "Where you hold money other than the main safe — and the fee you earn on it",
    accounts: "Accounts", none: "No account has been opened yet",
    open: "Open a new account", name: "Account name", currency: "Currency", kind: "Kind",
    kinds: { bank: "Bank", wallet: "Wallet", safe: "Safe", other: "Other" },
    create: "Open", balance: "Balance", refresh: "Refresh", loading: "Loading…",
    failed: "Could not load",
    service: "Service transaction", pick: "Choose an account",
    intoSafe: "From the account into the safe", fromSafe: "From the safe into the account",
    amount: "Principal", commission: "Commission",
    collected: "The commission was collected", owed: "The commission is owed",
    note: "Note", record: "Record", recording: "Recording…",
    done: "Recorded ✓", principalWas: "Principal", commissionWas: "Commission",
    receivable: "Commission owed",
    hint: "Principal and commission are different money — the fee goes to fee income, never to the trading spread",
  },
  ar: {
    title: "الحسابات والعمولة",
    subtitle: "أين تحتفظ بالمال غير الخزنة الرئيسية — والعمولة التي تكسبها عليه",
    accounts: "الحسابات", none: "لم يُفتح أي حساب بعد",
    open: "فتح حساب جديد", name: "اسم الحساب", currency: "العملة", kind: "النوع",
    kinds: { bank: "بنك", wallet: "محفظة", safe: "خزنة", other: "أخرى" },
    create: "افتح", balance: "الرصيد", refresh: "تحديث", loading: "جارٍ التحميل…",
    failed: "تعذّر التحميل",
    service: "معاملة خدمة", pick: "اختر حسابًا",
    intoSafe: "من الحساب إلى الخزنة", fromSafe: "من الخزنة إلى الحساب",
    amount: "المبلغ الأساسي", commission: "العمولة",
    collected: "تم تحصيل العمولة", owed: "العمولة مستحقة",
    note: "ملاحظة", record: "تسجيل", recording: "جارٍ التسجيل…",
    done: "تم التسجيل ✓", principalWas: "المبلغ الأساسي", commissionWas: "العمولة",
    receivable: "عمولة مستحقة",
    hint: "المبلغ الأساسي والعمولة مالان مختلفان — تذهب العمولة إلى إيراد الرسوم، لا إلى فرق السعر",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const newId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function CashAccounts({ client, lang = "ku", currencies = [] }) {
  const copy = COPY[localeKey(lang)];
  const [state, setState] = useState("loading");
  const [accounts, setAccounts] = useState([]);
  const [failure, setFailure] = useState("");

  // Opening an account
  const [name, setName] = useState("");
  const [curId, setCurId] = useState("");
  const [kind, setKind] = useState("bank");
  const [opening, setOpening] = useState(false);

  // Recording a service
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState("into_safe");
  const [amount, setAmount] = useState("");
  const [commission, setCommission] = useState("");
  const [collected, setCollected] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setAccounts(await loadCashAccounts(client));
      setState("ready");
    } catch {
      setState("error");
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  const active = useMemo(() => accounts.filter((a) => a.active), [accounts]);

  const create = async () => {
    if (!name.trim() || !curId) return;
    setOpening(true); setFailure("");
    try {
      await openCashAccount(client, { id: newId("acct"), name: name.trim(), currencyId: curId, kind });
      setName(""); setCurId("");
      await load();
    } catch (error) {
      setFailure(errorText(error).slice(0, 200));
    } finally {
      setOpening(false);
    }
  };

  const record = async () => {
    if (!accountId || !(Number(amount) > 0)) return;
    setBusy(true); setFailure(""); setDone(null);
    try {
      // The server refuses a movement the account cannot cover, and that refusal reaches the
      // owner as written. Nothing is decided here about whether the money is there.
      const answer = await recordService(client, {
        id: newId("svc"),
        accountId,
        direction,
        amount: Number(amount),
        commission: Number(commission) || 0,
        commissionCollected: collected,
        description: note.trim(),
        commandKey: accountingCommandKey("service", accountId),
      });
      setDone(answer);
      setAmount(""); setCommission(""); setNote("");
      await load();
    } catch (error) {
      setFailure(errorText(error).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return (
    <section className="debt-panel"><p className="debt-empty">
      <Loader2 aria-hidden="true" /> {copy.loading}
    </p></section>
  );

  if (state === "error") return (
    <section className="debt-panel"><div className="debt-error" role="alert">
      <AlertTriangle aria-hidden="true" /> {copy.failed}
      <button type="button" onClick={load}><RefreshCw aria-hidden="true" /> {copy.refresh}</button>
    </div></section>
  );

  return (
    <section className="debt-panel" aria-labelledby="cash-accounts-title">
      <header className="debt-header">
        <span className="debt-icon"><Banknote aria-hidden="true" /></span>
        <div>
          <h2 id="cash-accounts-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      {failure && <div className="debt-error" role="alert">
        <AlertTriangle aria-hidden="true" /> {failure}
      </div>}

      {accounts.length === 0 ? <p className="debt-empty">{copy.none}</p> : (
        <div className="debt-cards" role="status">
          {accounts.map((a) => (
            <div className="debt-card" key={a.id}>
              <span className="debt-card-label">{a.name}</span>
              <strong>{money(a.balance)}</strong>
              <span className="debt-card-note">
                {copy.kinds[a.kind] || a.kind}
                {a.active ? "" : ` · ${copy.kinds.other}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── open an account ── */}
      <div className="cashbox-form">
        <label>{copy.name}
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={copy.name} />
        </label>
        <label>{copy.currency}
          <select value={curId} onChange={(e) => setCurId(e.target.value)} aria-label={copy.currency}>
            <option value="">{copy.currency}</option>
            {currencies.map((c) => <option key={c.id} value={c.id}>{c.name || c.code}</option>)}
          </select>
        </label>
        <label>{copy.kind}
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={copy.kind}>
            {["bank", "wallet", "safe", "other"].map((k) =>
              <option key={k} value={k}>{copy.kinds[k]}</option>)}
          </select>
        </label>
        <button type="button" disabled={opening || !name.trim() || !curId} onClick={create}>
          <Plus aria-hidden="true" /> {copy.create}
        </button>
      </div>

      {/* ── record a service ── */}
      {active.length > 0 && (
        <>
          <header className="debt-header">
            <div><h2>{copy.service}</h2><p>{copy.hint}</p></div>
          </header>

          <div className="cashbox-form">
            <label>{copy.pick}
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
                      aria-label={copy.pick}>
                <option value="">{copy.pick}</option>
                {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label>{copy.kind}
              <select value={direction} onChange={(e) => setDirection(e.target.value)}
                      aria-label={copy.service}>
                <option value="into_safe">{copy.intoSafe}</option>
                <option value="from_safe">{copy.fromSafe}</option>
              </select>
            </label>
            <label>{copy.amount}
              <input type="number" inputMode="decimal" value={amount} aria-label={copy.amount}
                     onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label>{copy.commission}
              <input type="number" inputMode="decimal" value={commission} aria-label={copy.commission}
                     onChange={(e) => setCommission(e.target.value)} />
            </label>
            <label>
              <input type="checkbox" checked={collected}
                     onChange={(e) => setCollected(e.target.checked)} />
              {collected ? copy.collected : copy.owed}
            </label>
            <label>{copy.note}
              <input value={note} onChange={(e) => setNote(e.target.value)} aria-label={copy.note} />
            </label>
            <button type="button" disabled={busy || !accountId || !(Number(amount) > 0)}
                    onClick={record}>
              {busy ? copy.recording : copy.record}
            </button>
          </div>

          {/* Two figures, never one. §3.3: one million and three thousand are different kinds of
              money, and a single total would hide which is which. */}
          {done && (
            <div className="debt-cards" role="status">
              <div className="debt-card">
                <span className="debt-card-label">{copy.principalWas}</span>
                <strong>{money(done.principal)}</strong>
                <span className="debt-card-note">{done.currency} · {copy.done}</span>
              </div>
              <div className="debt-card">
                <span className="debt-card-label">{copy.commissionWas}</span>
                <strong>{money(done.commission)}</strong>
                <span className="debt-card-note">
                  {done.commissionCollected ? copy.collected
                    : `${copy.receivable}: ${money(done.commissionReceivable)}`}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default CashAccounts;
