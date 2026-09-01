import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Loader2, RefreshCw, Scale, Wallet } from "lucide-react";
import {
  applyVaultToDebt, loadCustomerVaults, loadDebts, loadVaultStatement,
  moveCustomerVault, previewDebtWaterfall,
} from "../../services/accounting";
import "./debt-center.css";
import { errorText } from "../../services/userFacingError";

const COPY = {
  ku: {
    title: "قاسەی کڕیار", subtitle: "پارەی کڕیار کە لای ZEMAN دانراوە — قەرزی ZEMANە بۆ کڕیار، نەک داهات",
    customer: "کڕیار", currency: "دراو", amount: "بڕ", rate: "نرخی ئەمڕۆ (١ دۆلار = ؟)",
    reason: "هۆکار", deposit: "دانان", withdraw: "دەرهێنان", settle: "تسویەی قەرز لە قاسە",
    available: "بەردەست", statement: "جوڵەکان", empty: "هیچ جوڵەیەک نییە",
    pick: "کڕیارێک هەڵبژێرە", refresh: "نوێکردنەوە", working: "جێبەجێکردن...",
    preview: "پێشبینینی تسویە", noDebt: "هیچ قەرزێکی کراوە نییە بەم دراوە",
    willSettle: "ئەم بڕە دەچێتە سەر ئەم قەرزانە:", loading: "بارکردن...",
    rateNeeded: "نرخی ئەمڕۆ پێویستە بۆ هەڵسەنگاندن بە دۆلار",
    kinds: {
      deposit: "دانان", withdrawal: "دەرهێنان", transaction_reserve: "تەرخانکردن",
      transaction_release: "بەردانەوە", transaction_settlement: "تسویەی مامەڵە",
      apply_to_customer_debt: "بۆ قەرز", credit_from_zeman_debt: "لە قەرزی ZEMAN",
      adjustment: "ڕاستکردنەوە", reversal: "هەڵوەشاندنەوە",
    },
  },
  en: {
    title: "Customer cashbox", subtitle: "Customer money held by ZEMAN — a liability, never income",
    customer: "Customer", currency: "Currency", amount: "Amount", rate: "Today's rate (1 USD = ?)",
    reason: "Reason", deposit: "Deposit", withdraw: "Withdraw", settle: "Settle debt from cashbox",
    available: "Available", statement: "Statement", empty: "No movements",
    pick: "Choose a customer", refresh: "Refresh", working: "Working…",
    preview: "Settlement preview", noDebt: "No open debt in this currency",
    willSettle: "This amount will be applied to:", loading: "Loading…",
    rateNeeded: "Today's rate is required for USD valuation",
    kinds: {
      deposit: "Deposit", withdrawal: "Withdrawal", transaction_reserve: "Reserved",
      transaction_release: "Released", transaction_settlement: "Settled",
      apply_to_customer_debt: "To debt", credit_from_zeman_debt: "From ZEMAN debt",
      adjustment: "Adjustment", reversal: "Reversal",
    },
  },
  ar: {
    title: "صندوق العميل", subtitle: "أموال العملاء المحفوظة لدى زيمان — التزام، وليست إيرادًا أبدًا",
    customer: "العميل", currency: "العملة", amount: "المبلغ", rate: "سعر اليوم (١ دولار = ؟)",
    reason: "السبب", deposit: "إيداع", withdraw: "سحب", settle: "سداد دين من الصندوق",
    available: "المتاح", statement: "كشف الحساب", empty: "لا توجد حركات",
    pick: "اختر عميلًا", refresh: "تحديث", working: "جارٍ التنفيذ…",
    preview: "معاينة السداد", noDebt: "لا يوجد دين مفتوح بهذه العملة",
    willSettle: "سيُطبَّق هذا المبلغ على:", loading: "جارٍ التحميل…",
    rateNeeded: "سعر اليوم مطلوب للتقييم بالدولار",
    kinds: {
      deposit: "إيداع", withdrawal: "سحب", transaction_reserve: "محجوز",
      transaction_release: "مُفرَج عنه", transaction_settlement: "مُسوَّى",
      apply_to_customer_debt: "إلى الدين", credit_from_zeman_debt: "من دين زيمان",
      adjustment: "تسوية", reversal: "عكس",
    },
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CashboxPanel({ client, lang = "ku", customers = [], flash = () => {}, rateFor = () => null }) {
  const copy = COPY[localeKey(lang)];
  const [customerId, setCustomerId] = useState("");
  const [currency, setCurrency] = useState("CNY");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [vaults, setVaults] = useState([]);
  const [statement, setStatement] = useState([]);
  const [debts, setDebts] = useState([]);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState("idle");

  const rate = rateFor(currency);

  const load = useCallback(async () => {
    if (!customerId) { setVaults([]); setStatement([]); setDebts([]); return; }
    setState("loading");
    try {
      const [v, s, d] = await Promise.all([
        loadCustomerVaults(client, customerId),
        loadVaultStatement(client, { customerId, limit: 50 }),
        loadDebts(client, { partyId: customerId }),
      ]);
      setVaults(v); setStatement(s); setDebts(d); setState("ready");
    } catch (e) {
      console.error("cashbox", e);
      flash(errorText(e));
      setState("error");
    }
  }, [client, customerId, flash]);

  useEffect(() => { load(); }, [load]);

  const vault = useMemo(
    () => vaults.find((v) => v.currency === currency) || { available: 0, reserved: 0 },
    [vaults, currency]
  );
  // Only debts this customer owes ZEMAN can be settled from their own cashbox.
  const owedByCustomer = useMemo(
    () => debts.filter((d) => d.debtorId === customerId && d.currency === currency),
    [debts, customerId, currency]
  );

  const run = async (fn, successMessage) => {
    if (busy) return;
    setBusy(true);
    try {
      const { result } = await fn();
      flash(successMessage(result));
      setAmount(""); setReason(""); setPlan(null);
      await load();
    } catch (e) {
      console.error("cashbox command", e);
      flash(errorText(e));
    } finally { setBusy(false); }
  };

  const move = (direction) => run(
    () => moveCustomerVault(client, { customerId, currency, amount: Number(amount), direction, rate, reason }),
    (r) => `${direction === "in" ? copy.deposit : copy.withdraw} ✓ — ${copy.available}: ${money(r?.available)} ${currency}`
  );

  const settle = () => run(
    () => applyVaultToDebt(client, { customerId, currency, amount: Number(amount), rate, reason }),
    (r) => `${copy.settle} ✓ — ${money(r?.applied)} ${currency}`
  );

  const showPreview = async () => {
    if (!(Number(amount) > 0)) return;
    try {
      setPlan(await previewDebtWaterfall(client, {
        debtorType: "customer", debtorId: customerId,
        creditorType: "zeman", currency, amount: Number(amount),
      }));
    } catch (e) { flash(errorText(e)); }
  };

  const canAct = customerId && Number(amount) > 0 && reason.trim().length >= 3 && !busy;

  return (
    <section className="debt-panel" aria-labelledby="cashbox-title">
      <header className="debt-header">
        <span className="debt-icon"><Wallet aria-hidden="true" /></span>
        <div>
          <h2 id="cashbox-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load} disabled={!customerId}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      <div className="cashbox-form">
        <label>
          {copy.customer}
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">{copy.pick}</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>
          {copy.currency}
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                 placeholder="CNY" inputMode="text" />
        </label>
        <label>
          {copy.amount}
          <input type="number" inputMode="decimal" value={amount}
                 onChange={(e) => { setAmount(e.target.value); setPlan(null); }} placeholder="0.00" />
        </label>
        <label className="cashbox-wide">
          {copy.reason}
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>

      {/* The ledger refuses to value a non-USD amount without a rate, so say so before the attempt. */}
      {currency !== "USD" && !(rate > 0) && (
        <div className="debt-ledger is-bad" role="status">
          <AlertTriangle aria-hidden="true" style={{ width: 14, height: 14, verticalAlign: "-2px" }} />
          {" "}{copy.rateNeeded}
        </div>
      )}

      <div className="cashbox-balance">
        <span>{copy.available}</span>
        <strong>{money(vault.available)} <span className="debt-currency-code">{currency}</span></strong>
      </div>

      <div className="cashbox-actions">
        <button type="button" className="cashbox-btn is-pos" disabled={!canAct} onClick={() => move("in")}>
          {busy ? <Loader2 className="spin" aria-hidden="true" /> : <ArrowDownLeft aria-hidden="true" />} {copy.deposit}
        </button>
        <button type="button" className="cashbox-btn is-neg" disabled={!canAct} onClick={() => move("out")}>
          {busy ? <Loader2 className="spin" aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />} {copy.withdraw}
        </button>
        <button type="button" className="cashbox-btn" disabled={!canAct || !owedByCustomer.length}
                onClick={settle} onMouseEnter={showPreview} onFocus={showPreview}>
          <Scale aria-hidden="true" /> {copy.settle}
        </button>
      </div>

      {!owedByCustomer.length && customerId && (
        <p className="debt-muted">{copy.noDebt}</p>
      )}

      {/* Show where the money lands before it is applied, never after. */}
      {plan && plan.length > 0 && (
        <div className="debt-aging">
          <h3>{copy.preview}</h3>
          <p className="debt-muted">{copy.willSettle}</p>
          <div className="debt-table-wrap">
            <table className="debt-table">
              <tbody>
                {plan.map((p) => (
                  <tr key={p.debtId}>
                    <td>{p.debtId}</td>
                    <td className="debt-amount">{money(p.allocated)} {currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="debt-aging">
        <h3>{copy.statement}</h3>
        {state === "loading" ? <p className="debt-muted">{copy.loading}</p>
          : statement.length === 0 ? <p className="debt-muted">{copy.empty}</p> : (
          <div className="debt-table-wrap">
            <table className="debt-table">
              <tbody>
                {statement.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {copy.kinds[e.kind] || e.kind}
                      {e.reason && <span className="debt-reason">{e.reason}</span>}
                    </td>
                    <td className="debt-amount"
                        style={{ color: e.availableDelta >= 0 ? "var(--pos)" : "var(--neg)" }}>
                      {e.availableDelta >= 0 ? "+" : "−"}{money(Math.abs(e.availableDelta))}{" "}
                      <span className="debt-currency-code">{e.currency}</span>
                    </td>
                    <td>{e.createdAt ? new Date(e.createdAt).toLocaleString("en-GB") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
