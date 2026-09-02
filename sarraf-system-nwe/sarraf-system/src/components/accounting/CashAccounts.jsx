import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Banknote, Loader2, Plus, RefreshCw } from "lucide-react";
import { loadCashAccounts, openCashAccount } from "../../services/accounting.js";
import { errorText } from "../../services/userFacingError";
import "./debt-center.css";

/**
 * The places this business holds money that are not the cash in the drawer.
 *
 *   «لە قاسەدا دەبێت پارەی جیاوازیش هەبێت نەک تەنها کاش. دەبێت ئەو پارانەش بوونیان هەبێت کە لە
 *    حساب بانکییەکانمە. واتا قاسەی گشتی وەک ئێستا بێت هەر بەس بەشێکی تری بۆ زیادببێت
 *    (پارەی کاش)(پارەی ناو حسابەکانت).»
 *
 *   «حسابەکان خۆم داخڵی بکەم وەک چۆنە پارەی تر داخڵ ئەکەم. بۆ نموونە (داخڵکردنی حساب) ناوێکی بۆ
 *    دادەنێم (کی کارد ، ئێف ئایبی ، هتد).»
 *
 * So this panel lives inside قاسە, not beside it. It does one thing: name the places and show
 * what each holds. Money arrives in them the same way money arrives anywhere — through the
 * entry form in قاسە, which now asks which place — and it moves between them through مامەڵەی
 * عمولە, which is a trade and belongs with the other trades.
 *
 * ── What used to be here, and why it is gone ─────────────────────────────────────────────────
 *
 * A "service transaction": a principal that passed through plus a separate fee that was earned.
 * That was a misreading of the business, and the owner said so plainly:
 *
 *   «بابەتی حسابات و عموولە هەڵە تێگەشتووی. ئەو لۆجیکە هەر بسڕەوە و دووبارە درووستی بکەرەوە.»
 *
 * There is no separate fee. There is a price you part with money at and a price you receive it
 * at, and the difference is the earning — which is مامەڵەی عمولە, one trade, not two figures.
 */

const COPY = {
  ku: {
    title: "حسابەکان", subtitle: "ئەو شوێنانەی پارەت تێدایە جگە لە کاش",
    none: "هێشتا هیچ حسابێک نەکراوەتەوە — ناوێک دابنێ بۆ ئێف ئایبی، کی کارد، یان هەر شوێنێکی تر",
    name: "ناوی حساب", currency: "دراو", kind: "جۆر",
    kinds: { bank: "بانک", wallet: "جزدان", safe: "قاسە", other: "شتی تر" },
    create: "بیکەرەوە", refresh: "نوێکردنەوە", loading: "بارکردن…",
    failed: "زانیارییەکان بار نەبوون", closed: "داخراوە",
  },
  en: {
    title: "Accounts", subtitle: "Where you hold money other than cash",
    none: "No account opened yet — give a name to FIB, a Key Card, or anywhere else you hold money",
    name: "Account name", currency: "Currency", kind: "Kind",
    kinds: { bank: "Bank", wallet: "Wallet", safe: "Safe", other: "Other" },
    create: "Open", refresh: "Refresh", loading: "Loading…",
    failed: "Could not load", closed: "closed",
  },
  ar: {
    title: "الحسابات", subtitle: "أين تحتفظ بالمال غير النقد",
    none: "لم يُفتح أي حساب بعد — سمِّ حسابك في البنك أو محفظتك أو أي مكان آخر",
    name: "اسم الحساب", currency: "العملة", kind: "النوع",
    kinds: { bank: "بنك", wallet: "محفظة", safe: "خزنة", other: "أخرى" },
    create: "افتح", refresh: "تحديث", loading: "جارٍ التحميل…",
    failed: "تعذّر التحميل", closed: "مغلق",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const newId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * @param onAccounts — called with the loaded accounts whenever they change, so قاسە can offer
 *   them in the money-entry form without asking the server a second time.
 */
export function CashAccounts({ client, lang = "ku", currencies = [], onAccounts }) {
  const copy = COPY[localeKey(lang)];
  const [state, setState] = useState("loading");
  const [accounts, setAccounts] = useState([]);
  const [failure, setFailure] = useState("");

  const [name, setName] = useState("");
  const [curId, setCurId] = useState("");
  const [kind, setKind] = useState("bank");
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const rows = await loadCashAccounts(client);
      setAccounts(rows);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);
  // The parent needs the same list for its entry form; handing it over here keeps one fetch.
  useEffect(() => { if (typeof onAccounts === "function") onAccounts(accounts); }, [accounts, onAccounts]);

  const byCurrency = useMemo(() => {
    const out = new Map();
    for (const a of accounts) {
      if (!out.has(a.currencyId)) out.set(a.currencyId, []);
      out.get(a.currencyId).push(a);
    }
    return out;
  }, [accounts]);

  const currencyName = useCallback(
    (id) => currencies.find((c) => c.id === id)?.name || currencies.find((c) => c.id === id)?.code || id,
    [currencies]);

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
        // Grouped by currency, because «چەندم هەیە» is a question about one currency at a time
        // and a flat list of mixed currencies invites adding dinars to dollars by eye.
        [...byCurrency.entries()].map(([cid, rows]) => (
          <div key={cid}>
            <p className="debt-empty" style={{ textAlign: "start", padding: "0.5rem 0 0" }}>
              {currencyName(cid)}
            </p>
            <div className="debt-cards" role="status">
              {rows.map((a) => (
                <div className="debt-card" key={a.id}>
                  <span className="debt-card-label">{a.name}</span>
                  <strong>{money(a.balance)}</strong>
                  <span className="debt-card-note">
                    {copy.kinds[a.kind] || a.kind}{a.active ? "" : ` · ${copy.closed}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

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
        <button type="button" disabled={opening || !name.trim() || !curId}
                onClick={async () => {
                  if (!name.trim() || !curId) return;
                  setOpening(true); setFailure("");
                  try {
                    await openCashAccount(client,
                      { id: newId("acct"), name: name.trim(), currencyId: curId, kind });
                    setName(""); setCurId("");
                    await load();
                  } catch (error) {
                    setFailure(errorText(error).slice(0, 200));
                  } finally {
                    setOpening(false);
                  }
                }}>
          <Plus aria-hidden="true" /> {copy.create}
        </button>
      </div>
    </section>
  );
}

export default CashAccounts;
