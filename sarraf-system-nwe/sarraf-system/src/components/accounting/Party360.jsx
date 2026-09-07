import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Search, UserRound } from "lucide-react";
import { loadPartyProfile } from "../../services/partyProfiles";
import { errorText } from "../../services/userFacingError";
import "./debt-center.css";

const COPY = {
  en: { title: "Party 360", pick: "Choose a party", loading: "Loading…", refresh: "Refresh", failed: "Could not load profile", balances: "Balances", debts: "Open debts", receipts: "Receipts", transactions: "Transactions", payments: "Office payments", empty: "Nothing recorded", kind: "Kind" },
  ku: { title: "پڕۆفایلی ٣٦٠ی لایەن", pick: "لایەنێک هەڵبژێرە", loading: "بارکردن…", refresh: "نوێکردنەوە", failed: "پڕۆفایل بار نەبوو", balances: "باڵانسەکان", debts: "قەرزە کراوەکان", receipts: "فیشەکان", transactions: "مامەڵەکان", payments: "پارەدانی نووسینگە", empty: "هیچ تۆمارێک نییە", kind: "جۆر" },
  ar: { title: "ملف الطرف 360", pick: "اختر طرفًا", loading: "جارٍ التحميل…", refresh: "تحديث", failed: "تعذّر تحميل الملف", balances: "الأرصدة", debts: "الديون المفتوحة", receipts: "الإيصالات", transactions: "المعاملات", payments: "مدفوعات المكتب", empty: "لا توجد سجلات", kind: "النوع" },
};
const locale = (lang) => COPY[lang] || COPY.en;
const money = (value) => Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const kinds = ["customer", "partner", "office", "investor"];

export function Party360({ client, parties = [], lang = "en" }) {
  const copy = locale(lang);
  const [selection, setSelection] = useState({ id: "", kind: "customer" });
  const [profile, setProfile] = useState(null);
  const [state, setState] = useState("idle");
  const [failure, setFailure] = useState("");
  const load = useCallback(async () => {
    if (!selection.id) return;
    setState("loading"); setFailure("");
    try { setProfile(await loadPartyProfile(client, selection.id, selection.kind)); setState("ready"); }
    catch (error) { setFailure(errorText(error)); setState("error"); }
  }, [client, selection]);
  useEffect(() => { if (selection.id) load(); }, [load, selection.id]);
  const selectedParties = useMemo(() => parties.filter((party) => !party.deleted && kinds.includes(party.role)), [parties]);
  const section = (title, rows, render) => (
    <article className="debt-card" style={{ gridColumn: "1 / -1" }}>
      <h3>{title}</h3>
      {!rows?.length ? <p className="debt-muted">{copy.empty}</p> : <div className="debt-table-wrap"><table className="debt-table"><tbody>{rows.slice(0, 80).map(render)}</tbody></table></div>}
    </article>
  );
  return <section className="debt-panel" aria-labelledby="party-360-title">
    <header className="debt-header"><span className="debt-icon"><UserRound /></span><div><h2 id="party-360-title">{copy.title}</h2><p>{profile?.party?.name || copy.pick}</p></div>{selection.id && <button type="button" className="debt-refresh" onClick={load}><RefreshCw /> {copy.refresh}</button>}</header>
    <div className="cashbox-form">
      <label>{copy.kind}<select value={selection.kind} onChange={(event) => setSelection({ id: "", kind: event.target.value })}>{kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
      <label>{copy.pick}<select value={selection.id} onChange={(event) => setSelection({ ...selection, id: event.target.value })}><option value="">{copy.pick}</option>{selectedParties.filter((party) => party.role === selection.kind).map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>
    </div>
    {state === "loading" && <p className="debt-empty"><Loader2 className="spin" /> {copy.loading}</p>}
    {failure && <p className="debt-error" role="alert"><AlertTriangle /> {copy.failed} — {failure}</p>}
    {state === "ready" && profile && <div className="debt-aging-grid">
      {section(copy.balances, profile.balances, (row) => <tr key={row.currency}><td>{row.currency}</td><td>{money(row.total || row.amount)}</td></tr>)}
      {section(copy.debts, profile.debts, (row) => <tr key={row.id}><td>{row.direction}</td><td>{money(row.outstanding)} {row.currency}</td><td>{row.status}</td></tr>)}
      {section(copy.receipts, profile.receipts, (row) => <tr key={row.id}><td>{row.reference || row.id}</td><td>{money(row.amount)} {row.currency}</td><td>{row.status}</td></tr>)}
      {section(copy.transactions, profile.transactions, (row) => <tr key={row.id}><td>{row.code || row.id}</td><td>{money(row.total)} {row.against_currency}</td><td>{row.status}</td></tr>)}
      {section(copy.payments, profile.payments, (row) => <tr key={row.id}><td>{row.status}</td><td>{money(row.outstanding)} {row.currency}</td><td>{row.reference || "—"}</td></tr>)}
    </div>}
    {state === "idle" && <p className="debt-empty"><Search /> {copy.pick}</p>}
  </section>;
}
