import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Handshake, Loader2, RefreshCw } from "lucide-react";
import {
  creditPartnerFunds, disbursePartnerFunds, loadDailyAccountingRates,
  loadDebts, loadPartnerAccounts,
} from "../../services/accounting";
import "./debt-center.css";
import { errorText } from "../../services/userFacingError";

const COPY = {
  ku: {
    title: "حسابی هاوبەشان", subtitle: "باڵانس هەرگیز سالب نابێت؛ زیادەی دابەشکردن بە قەرزی ڕوون تۆمار دەکرێت",
    partner: "هاوبەش", currency: "دراو", amount: "بڕ", reason: "هۆکار",
    transaction: "ژمارەی مامەڵە (ئارەزوومەندانە)", credit: "کریدیت/پارە هات",
    disburse: "دابەشکردن/پارە چوو", available: "بەردەست", debt: "قەرزی کراوە",
    rate: "نرخی canonical", noRate: "نرخی manual ـی ئەم دراوە دانەنراوە",
    pick: "هاوبەشێک هەڵبژێرە", refresh: "نوێکردنەوە", working: "جێبەجێکردن...",
    empty: "هیچ حسابێکی هاوبەش نییە", failed: "زانیاریی حسابی هاوبەشان بار نەبوو",
  },
  en: {
    title: "Partner accounts", subtitle: "Balances never go negative; excess disbursement becomes explicit debt",
    partner: "Partner", currency: "Currency", amount: "Amount", reason: "Reason",
    transaction: "Transaction ID (optional)", credit: "Credit received", disburse: "Disburse",
    available: "Available", debt: "Open debt", rate: "Canonical rate",
    noRate: "No manual daily rate for this currency", pick: "Choose a partner",
    refresh: "Refresh", working: "Working…", empty: "No partner accounts", failed: "Could not load partner accounts",
  },
  ar: {
    title: "حسابات الشركاء", subtitle: "الأرصدة لا تصبح سالبة أبدًا؛ الصرف الزائد يصير دينًا صريحًا",
    partner: "الشريك", currency: "العملة", amount: "المبلغ", reason: "السبب",
    transaction: "رقم المعاملة (اختياري)", credit: "مبلغ مستلم", disburse: "صرف",
    available: "المتاح", debt: "دين مفتوح", rate: "السعر المعتمد",
    noRate: "لا يوجد سعر يومي يدوي لهذه العملة", pick: "اختر شريكًا",
    refresh: "تحديث", working: "جارٍ التنفيذ…", empty: "لا توجد حسابات شركاء",
    failed: "تعذّر تحميل حسابات الشركاء",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function PartnerAccounts({ client, partners = [], lang = "ku", flash = () => {} }) {
  const copy = COPY[localeKey(lang)];
  const [accounts, setAccounts] = useState([]);
  const [debts, setDebts] = useState([]);
  const [rates, setRates] = useState({ USD: { value: 1 } });
  const [state, setState] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ partnerId: "", currency: "CNY", amount: "", reason: "", transactionId: "" });
  const intentKeys = useRef(new Map());

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [accountRows, debtRows, dailyRates] = await Promise.all([
        loadPartnerAccounts(client), loadDebts(client), loadDailyAccountingRates(client),
      ]);
      setAccounts(accountRows); setDebts(debtRows); setRates(dailyRates); setState("ready");
    } catch (error) {
      console.error("partner accounts", error);
      setState("error");
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  const selectedAccounts = useMemo(
    () => accounts.filter((row) => !form.partnerId || row.partnerId === form.partnerId),
    [accounts, form.partnerId],
  );
  const selectedDebts = useMemo(() => debts.filter((row) =>
    row.debtorType === "partner" && row.debtorId === form.partnerId && row.creditorType === "zeman"
      && row.currency === form.currency), [debts, form.partnerId, form.currency]);
  const openDebt = selectedDebts.reduce((sum, row) => sum + row.outstanding, 0);
  const rate = rates[form.currency]?.value ?? null;
  const canAct = form.partnerId && Number(form.amount) > 0 && form.reason.trim().length >= 3
    && (form.currency === "USD" || Number(rate) > 0) && !busy;

  const execute = async (kind) => {
    if (!canAct) return;
    const intent = [kind, form.partnerId, form.currency, form.amount, form.reason, form.transactionId].join(":");
    if (!intentKeys.current.has(intent)) {
      intentKeys.current.set(intent, `acct-partner-${kind}:${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`);
    }
    setBusy(true);
    try {
      const args = {
        partnerId: form.partnerId, currency: form.currency, amount: Number(form.amount),
        rate, reason: form.reason, transactionId: form.transactionId || null,
        commandKey: intentKeys.current.get(intent),
      };
      const { result } = kind === "credit"
        ? await creditPartnerFunds(client, args)
        : await disbursePartnerFunds(client, args);
      const detail = kind === "credit"
        ? `${copy.credit} ✓ — ${money(result?.debt_applied)} ${form.currency} ${copy.debt}`
        : `${copy.disburse} ✓ — ${money(result?.from_balance)} ${form.currency} ${copy.available}`;
      flash(detail);
      intentKeys.current.delete(intent);
      setForm((current) => ({ ...current, amount: "", reason: "", transactionId: "" }));
      await load();
    } catch (error) {
      console.error("partner command", error);
      flash(errorText(error));
    } finally { setBusy(false); }
  };

  if (state === "loading") return <section className="debt-panel"><div className="debt-loading">{copy.working}</div></section>;
  if (state === "error") return (
    <section className="debt-panel"><div className="debt-error" role="alert">
      <AlertTriangle aria-hidden="true" /> {copy.failed}
      <button type="button" onClick={load}><RefreshCw aria-hidden="true" /> {copy.refresh}</button>
    </div></section>
  );

  return (
    <section className="debt-panel" aria-labelledby="partner-accounts-title">
      <header className="debt-header">
        <span className="debt-icon"><Handshake aria-hidden="true" /></span>
        <div><h2 id="partner-accounts-title">{copy.title}</h2><p>{copy.subtitle}</p></div>
        <button type="button" className="debt-refresh" onClick={load}><RefreshCw aria-hidden="true" /> {copy.refresh}</button>
      </header>

      <div className="cashbox-form">
        <label>{copy.partner}
          <select value={form.partnerId} onChange={(event) => setForm({ ...form, partnerId: event.target.value })}>
            <option value="">{copy.pick}</option>
            {partners.map((partner) => <option key={partner.id} value={partner.id}>{partner.name}</option>)}
          </select>
        </label>
        <label>{copy.currency}
          <input value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} />
        </label>
        <label>{copy.amount}
          <input type="number" inputMode="decimal" min="0" value={form.amount}
                 onChange={(event) => setForm({ ...form, amount: event.target.value })} />
        </label>
        <label>{copy.transaction}
          <input value={form.transactionId} onChange={(event) => setForm({ ...form, transactionId: event.target.value })} />
        </label>
        <label className="cashbox-wide">{copy.reason}
          <input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </label>
      </div>

      <div className={`debt-ledger ${rate ? "is-ok" : "is-bad"}`} role="status">
        {rate ? `${copy.rate}: 1 USD = ${rate} ${form.currency} · v${rates[form.currency]?.version || 1}` : copy.noRate}
      </div>
      {form.partnerId && <div className="debt-cards">
        <article className="debt-card"><h3>{copy.available}</h3>
          <strong>{money(selectedAccounts.find((row) => row.currency === form.currency)?.available)} {form.currency}</strong>
        </article>
        <article className={`debt-card ${openDebt > 0 ? "is-negative" : ""}`}><h3>{copy.debt}</h3>
          <strong>{money(openDebt)} {form.currency}</strong>
        </article>
      </div>}

      <div className="cashbox-actions">
        <button type="button" className="cashbox-btn is-pos" disabled={!canAct} onClick={() => execute("credit")}>
          {busy ? <Loader2 className="spin" aria-hidden="true" /> : <ArrowDownLeft aria-hidden="true" />} {copy.credit}
        </button>
        <button type="button" className="cashbox-btn is-neg" disabled={!canAct} onClick={() => execute("disburse")}>
          {busy ? <Loader2 className="spin" aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />} {copy.disburse}
        </button>
      </div>

      {!selectedAccounts.length && <p className="debt-muted debt-empty">{copy.empty}</p>}
    </section>
  );
}
