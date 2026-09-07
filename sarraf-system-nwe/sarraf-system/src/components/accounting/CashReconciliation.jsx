import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Scale } from "lucide-react";
import { loadCashReconciliation } from "../../services/partyProfiles";
import { errorText } from "../../services/userFacingError";
import "./debt-center.css";

const COPY = { en: { title: "Cash reconciliation", subtitle: "Physical, system, held, and debt are shown by currency. Differences stay visible.", refresh: "Refresh", loading: "Checking…", physical: "Physical", system: "System", held: "Held", debt: "Debt", matched: "Matched", discrepancy: "Discrepancy", failed: "Could not load reconciliation" }, ku: { title: "ڕێکخستنەوەی قاسە", subtitle: "فیزیکی، سیستەم، بەدەستهێڵراو و قەرز بە جیا بۆ هەر دراوێک پیشان دەدرێن.", refresh: "نوێکردنەوە", loading: "پشکنین…", physical: "فیزیکی", system: "سیستەم", held: "بەدەستهێڵراو", debt: "قەرز", matched: "یەکە", discrepancy: "جیاوازی", failed: "ڕێکخستنەوە بار نەبوو" }, ar: { title: "مطابقة النقد", subtitle: "تظهر الفعلي والنظام والمحتجز والدين لكل عملة، وتبقى الفروقات ظاهرة.", refresh: "تحديث", loading: "جارٍ الفحص…", physical: "فعلي", system: "النظام", held: "محتجز", debt: "دين", matched: "متطابق", discrepancy: "فرق", failed: "تعذّر تحميل المطابقة" } };
const money = (value) => Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
export function CashReconciliation({ client, lang = "en" }) {
  const copy = COPY[lang] || COPY.en; const [state, setState] = useState("loading"); const [rows, setRows] = useState([]); const [failure, setFailure] = useState("");
  const load = useCallback(async () => { setState("loading"); setFailure(""); try { setRows((await loadCashReconciliation(client)).currencies); setState("ready"); } catch (error) { setFailure(errorText(error)); setState("error"); } }, [client]);
  useEffect(() => { load(); }, [load]);
  return <section className="debt-panel" aria-labelledby="cash-reconciliation-title"><header className="debt-header"><span className="debt-icon"><Scale /></span><div><h2 id="cash-reconciliation-title">{copy.title}</h2><p>{copy.subtitle}</p></div><button type="button" className="debt-refresh" onClick={load}><RefreshCw /> {copy.refresh}</button></header>
    {state === "loading" && <p className="debt-empty"><Loader2 className="spin" /> {copy.loading}</p>}
    {failure && <p className="debt-error" role="alert"><AlertTriangle /> {copy.failed} — {failure}</p>}
    {state === "ready" && <div className="debt-table-wrap"><table className="debt-table"><thead><tr><th>Currency</th><th>{copy.physical}</th><th>{copy.system}</th><th>{copy.held}</th><th>{copy.debt}</th><th>Difference</th><th>Status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.currency} style={row.status === "discrepancy" ? { background: "var(--neg-bg)" } : undefined}><td>{row.currency}</td><td>{money(row.physical)}</td><td>{money(row.system)}</td><td>{money(row.held)}</td><td>{money(row.debt)}</td><td>{money(row.difference)}</td><td>{row.status === "matched" ? <><CheckCircle2 /> {copy.matched}</> : <><AlertTriangle /> {copy.discrepancy}</>}</td></tr>)}</tbody></table></div>}
  </section>;
}
