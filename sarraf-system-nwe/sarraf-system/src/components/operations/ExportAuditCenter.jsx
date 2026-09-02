import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileCheck2, Filter, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { AUDIT_DATASET_LABELS, auditTimeline, buildSafeCsv, downloadTextFile, loadAuditExportSnapshot, snapshotChecksum } from "../../services/auditExport";
import { userFacingServiceError } from "../../services/userFacingError";
import "./export-audit-center.css";

const COPY = {
  ku: { eyebrow: "ZEMAN · کۆنترۆڵ", title: "هەناردە و وردبینی", subtitle: "هەناردەی سنووردار، مێژووی یەکخراو و checksum ـی پشکنین—تەنها خوێندنەوە و بێ گۆڕینی داتا.", loading: "بارکردن", error: "هەڵە", verified: "خوێندنەوەی پشتڕاستکراو", from: "لە بەرواری", to: "بۆ بەرواری", limit: "سنووری هەر dataset", load: "بارکردن", loadError: "Snapshot ئامادە نەبوو", counts: "ژمارەی داتاکان", search: "گەڕان لە پیشاندان…", empty: "هیچ ڕیزێک بۆ ئەم داتا/گەڕانە نییە", preview: "پیشاندان", exportRows: "ڕیزی هەناردە", safe: "CSV بۆ spreadsheet پارێزراوە", manifest: "MANIFEST", proof: "بەڵگەی یەکپارچەیی", generated: "دروستکراوە", range: "ماوەی UTC", format: "فۆرمات", calculating: "ژماردن…", download: "JSON + checksum", manifestNote: "ئەم manifest ـە snapshot و checksum ـەکەی پێکەوە هەڵدەگرێت؛ backup/PITR نییە.", trail: "مێژووی یەکخراو", timeline: "مێژووی وردبینی", noEvents: "هیچ ڕووداوێکی وردبینی لەم ماوەیەدا نییە" },
  en: { eyebrow: "ZEMAN · CONTROL", title: "Export & Audit Center", subtitle: "Bounded exports, a unified timeline, and snapshot checksums—read-only and without changing data.", loading: "LOADING", error: "ERROR", verified: "VERIFIED READ", from: "From", to: "To", limit: "Rows per dataset", load: "Load", loadError: "Snapshot unavailable", counts: "Dataset counts", search: "Search preview...", empty: "No row matches this dataset or search", preview: "Preview", exportRows: "Export rows", safe: "CSV values are spreadsheet-safe", manifest: "MANIFEST", proof: "Integrity proof", generated: "Generated", range: "UTC range", format: "Format", calculating: "calculating…", download: "JSON + checksum", manifestNote: "This manifest keeps the snapshot and checksum together; it is not a backup or PITR.", trail: "UNIFIED TRAIL", timeline: "Audit timeline", noEvents: "No audit event exists in this range" },
  ar: { eyebrow: "ZEMAN · التحكم", title: "مركز التصدير والتدقيق", subtitle: "تصدير محدود وسجل موحد وبصمة تحقق—للقراءة فقط ومن دون تغيير البيانات.", loading: "جارٍ التحميل", error: "خطأ", verified: "قراءة موثقة", from: "من تاريخ", to: "إلى تاريخ", limit: "الحد لكل مجموعة", load: "تحميل", loadError: "اللقطة غير متاحة", counts: "أعداد البيانات", search: "البحث في المعاينة…", empty: "لا توجد صفوف مطابقة", preview: "المعاينة", exportRows: "صفوف التصدير", safe: "قيم CSV آمنة للجداول", manifest: "MANIFEST", proof: "دليل السلامة", generated: "تاريخ الإنشاء", range: "نطاق UTC", format: "التنسيق", calculating: "جارٍ الحساب…", download: "JSON + checksum", manifestNote: "يحفظ هذا الملف اللقطة والبصمة معاً؛ وهو ليس نسخة احتياطية أو PITR.", trail: "السجل الموحد", timeline: "سجل التدقيق", noEvents: "لا توجد أحداث تدقيق في هذه المدة" },
};
const localeKey = (lang) => lang === "en" || lang === "ar" ? lang : "ku";
const DATASET_COPY = {
  ku: { transactions: "مامەڵەکان", audit: "تۆماری گۆڕانکاری", receipt_audit: "وردبینی فیش", approvals: "پەسەندکردنەکان", approval_events: "ڕووداوەکانی پەسەندکردن", tx_versions: "وەشانەکانی مامەڵە", receipt_batches: "کۆمەڵە فیشەکان" },
  en: AUDIT_DATASET_LABELS,
  ar: { transactions: "المعاملات", audit: "سجل التغييرات", receipt_audit: "تدقيق الإيصالات", approvals: "الموافقات", approval_events: "أحداث الموافقات", tx_versions: "إصدارات المعاملات", receipt_batches: "دُفعات الإيصالات" },
};

const day = (date) => date.toISOString().slice(0, 10);
const initialRange = () => {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: day(from), to: day(to) };
};
const displayDate = (value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("en-GB") : "—";
};
const safeName = (value) => String(value || "export").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "");

export function ExportAuditCenter({ client, lang = "ku" }) {
  const locale = localeKey(lang);
  const copy = COPY[locale];
  const datasetCopy = DATASET_COPY[locale];
  const statusCopy = locale === "ar" ? { clipped: "محدود", complete: "مكتمل", dataset: "مجموعة البيانات", recorded: "حدث مسجل" } : locale === "en" ? { clipped: "CLIPPED", complete: "COMPLETE", dataset: "DATASET", recorded: "Recorded event" } : { clipped: "سنووردار", complete: "تەواو", dataset: "کۆمەڵەداتا", recorded: "ڕووداو تۆمار کرا" };
  const [range, setRange] = useState(initialRange);
  const [limit, setLimit] = useState(1000);
  const [snapshot, setSnapshot] = useState(null);
  const [active, setActive] = useState("transactions");
  const [query, setQuery] = useState("");
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [checksum, setChecksum] = useState("");

  const load = async () => {
    setState("loading");
    setError("");
    try {
      setSnapshot(await loadAuditExportSnapshot(client, { ...range, limit }));
      setState("ready");
    } catch (cause) {
      console.error("ZEMAN export and audit", cause);
      setError(userFacingServiceError(cause, locale));
      setState("error");
    }
  };

  useEffect(() => { load(); }, []); // The operator controls later refreshes and range changes.
  useEffect(() => {
    let live = true;
    setChecksum("");
    if (snapshot) snapshotChecksum(snapshot).then((value) => { if (live) setChecksum(value || ""); });
    return () => { live = false; };
  }, [snapshot]);

  const rows = snapshot?.datasets?.[active] || [];
  const visibleRows = useMemo(() => {
    const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
    if (!needle) return rows.slice(0, 60);
    return rows.filter((row) => JSON.stringify(row).toLocaleLowerCase().includes(needle)).slice(0, 60);
  }, [query, rows]);
  const columns = useMemo(() => [...new Set(visibleRows.flatMap((row) => Object.keys(row || {})))].slice(0, 8), [visibleRows]);
  const timeline = useMemo(() => auditTimeline(snapshot).slice(0, 40), [snapshot]);
  const clippedKeys = Object.entries(snapshot?.clipped || {}).filter(([, clipped]) => clipped).map(([key]) => key);

  const downloadCsv = () => {
    downloadTextFile(buildSafeCsv(rows), `zeman_${safeName(active)}_${range.from}_${range.to}.csv`, "text/csv;charset=utf-8");
  };
  const downloadManifest = async () => {
    const digest = checksum || await snapshotChecksum(snapshot);
    const manifest = { ...snapshot, integrity: { algorithm: digest ? "SHA-256" : "unavailable", snapshot_checksum: digest } };
    downloadTextFile(JSON.stringify(manifest, null, 2), `zeman_export_audit_${range.from}_${range.to}.json`, "application/json;charset=utf-8");
  };

  return <div className="export-audit-center">
    <header className="export-audit-header">
      <div><span>{copy.eyebrow}</span><h1><ShieldCheck aria-hidden="true" /> {copy.title}</h1><p>{copy.subtitle}</p></div>
      <span className={`export-audit-live ${state === "error" ? "is-error" : ""}`}><i aria-hidden="true" />{state === "loading" ? copy.loading : state === "error" ? copy.error : copy.verified}</span>
    </header>

    <section className="export-audit-filter" aria-label={copy.range}>
      <div><label htmlFor="audit-from">{copy.from}</label><input id="audit-from" type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} /></div>
      <div><label htmlFor="audit-to">{copy.to}</label><input id="audit-to" type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} /></div>
      <div><label htmlFor="audit-limit">{copy.limit}</label><select id="audit-limit" value={limit} onChange={(event) => setLimit(Number(event.target.value))}><option value="500">500</option><option value="1000">1,000</option><option value="2500">2,500</option></select></div>
      <button type="button" onClick={load} disabled={state === "loading"}><RefreshCw aria-hidden="true" className={state === "loading" ? "is-spinning" : ""} />{copy.load}</button>
    </section>

    {state === "error" && <section className="export-audit-error" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>{copy.loadError}</strong><p>{error}</p></div></section>}
    {clippedKeys.length > 0 && <section className="export-audit-warning"><AlertTriangle aria-hidden="true" /><span>{locale === "ar" ? "بلغت بعض مجموعات البيانات حد الصفوف؛ اختر مدة أقصر لتصدير كامل:" : locale === "en" ? "Some datasets reached the row limit; choose a shorter range for a complete export:" : "هەندێ کۆمەڵەداتا گەیشتنە سنووری ڕیز؛ ماوەکە بچووکتر بکە بۆ هەناردەی تەواو:"} {clippedKeys.map((key) => datasetCopy[key] || key).join("، ")}</span></section>}

    <section className="export-audit-counts" aria-label={copy.counts}>
      {Object.keys(AUDIT_DATASET_LABELS).map((key) => <button type="button" key={key} className={active === key ? "is-active" : ""} onClick={() => setActive(key)}><span>{datasetCopy[key]}</span><strong>{Number(snapshot?.counts?.[key] || 0).toLocaleString("en-US")}</strong><small>{snapshot?.clipped?.[key] ? statusCopy.clipped : statusCopy.complete}</small></button>)}
    </section>

    <div className="export-audit-grid">
      <section className="export-audit-dataset">
        <div className="export-audit-section-head"><div><span>{statusCopy.dataset}</span><h2>{datasetCopy[active]}</h2></div><div className="export-audit-actions"><label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.search} /></label><button type="button" onClick={downloadCsv} disabled={!rows.length}><Download aria-hidden="true" />CSV</button></div></div>
        <div className="export-audit-table-wrap">
          {visibleRows.length ? <table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{visibleRows.map((row, index) => <tr key={row.id || `${active}-${index}`}>{columns.map((column) => <td key={column} title={typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column] ?? "")}><span>{typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column] ?? "—")}</span></td>)}</tr>)}</tbody></table> : <div className="export-audit-empty"><Filter aria-hidden="true" />{copy.empty}</div>}
        </div>
        <div className="export-audit-foot"><span>{copy.preview}: {visibleRows.length} / {copy.exportRows}: {rows.length}</span><span>{copy.safe}</span></div>
      </section>

      <aside className="export-audit-manifest">
        <div className="export-audit-section-head"><div><span>{copy.manifest}</span><h2>{copy.proof}</h2></div><FileCheck2 aria-hidden="true" /></div>
        <dl><div><dt>{copy.generated}</dt><dd>{displayDate(snapshot?.generated_at)}</dd></div><div><dt>{copy.range}</dt><dd>{snapshot ? `${snapshot.range?.from} → ${snapshot.range?.to}` : "—"}</dd></div><div><dt>{copy.format}</dt><dd>{snapshot?.format || "—"} v{snapshot?.version || "—"}</dd></div><div><dt>SHA-256</dt><dd className="checksum">{checksum || (snapshot ? copy.calculating : "—")}</dd></div></dl>
        <button type="button" onClick={downloadManifest} disabled={!snapshot}><Download aria-hidden="true" />{copy.download}</button>
        <p>{copy.manifestNote}</p>
      </aside>
    </div>

    <section className="export-audit-timeline">
      <div className="export-audit-section-head"><div><span>{copy.trail}</span><h2>{copy.timeline}</h2></div><CheckCircle2 aria-hidden="true" /></div>
      {timeline.length ? <div>{timeline.map((item, index) => <article key={`${item._dataset}-${item.id || index}`}><i aria-hidden="true" /><div><span>{datasetCopy[item._dataset] || item._dataset}</span><strong>{item._label}</strong><small>{item.detail || item.decision_note || item.actor_name || item.actor_id || statusCopy.recorded}</small></div><time>{displayDate(item._at)}</time></article>)}</div> : <div className="export-audit-empty">{copy.noEvents}</div>}
    </section>
  </div>;
}
