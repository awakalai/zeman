import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleGauge, Inbox, RefreshCw, ShieldAlert } from "lucide-react";
import { loadActionInbox, loadIntegrityCenter, safeInboxAction } from "../../services/operationalControl";
import { userFacingServiceError } from "../../services/userFacingError";
import "./operational-centers.css";

const COPY = {
  ku: {
    refresh: "نوێکردنەوە", failed: "بارکردن سەرکەوتوو نەبوو", retry: "دووبارە هەوڵ بدەرەوە", open: "کردنەوە", summary: "پوختە", clear: "پاک",
    inbox: { eyebrow: "ZEMAN · کارەکان", title: "ئینباکسی کارەکان", subtitle: "ئەو کارانەی ئێستا پێویستیان بە سەرنج و بڕیاری مرۆڤ هەیە", empty: "هیچ کارێکی چاوەڕوان نییە", emptyDetail: "هیچ فیش، مامەڵە، نرخ یان پەسەندکردنێکی کراوە نەدۆزرایەوە.", total: "کاری چاوەڕوان" },
    integrity: { eyebrow: "ZEMAN · دڵنیایی", title: "ناوەندی یەکپارچەیی", subtitle: "پشکنینی تۆماری ناکۆک، دووبارە و پەیوەندییە شکێنراوەکان—بەبێ گۆڕینی خۆکارانە", empty: "هیچ ناکۆکییەک نەدۆزرایەوە", emptyDetail: "فیش، کۆمەڵە و مامەڵە پشکنراوەکان لە سنووری ئەم پشکنینەدا ڕێکن.", total: "دۆزراوەی یەکپارچەیی" },
  },
  en: {
    refresh: "Refresh", failed: "Could not load this area", retry: "Try again", open: "Open", summary: "Summary", clear: "Clear",
    inbox: { eyebrow: "ZEMAN · OPERATIONS", title: "Action Inbox", subtitle: "Work that currently needs human attention or a decision", empty: "Nothing is waiting", emptyDetail: "No open receipt, transaction, rate, or approval item was found.", total: "waiting items" },
    integrity: { eyebrow: "ZEMAN · ASSURANCE", title: "Integrity Center", subtitle: "Read-only checks for inconsistent, duplicate, or broken records", empty: "No integrity issue was found", emptyDetail: "The checked receipts, batches, and transactions are consistent within this scan.", total: "integrity findings" },
  },
  ar: {
    refresh: "تحديث", failed: "تعذر تحميل هذا القسم", retry: "حاول مرة أخرى", open: "فتح", summary: "ملخص", clear: "سليم",
    inbox: { eyebrow: "ZEMAN · العمليات", title: "صندوق الإجراءات", subtitle: "الأعمال التي تحتاج الآن إلى انتباه أو قرار بشري", empty: "لا توجد أعمال معلقة", emptyDetail: "لم يتم العثور على إيصال أو معاملة أو سعر أو موافقة مفتوحة.", total: "عناصر معلقة" },
    integrity: { eyebrow: "ZEMAN · الضمان", title: "مركز سلامة البيانات", subtitle: "فحوصات للبيانات المتعارضة أو المكررة أو الروابط المقطوعة من دون تعديل تلقائي", empty: "لم يتم العثور على مشكلة", emptyDetail: "الإيصالات والدُفعات والمعاملات المفحوصة متسقة ضمن هذا الفحص.", total: "نتائج السلامة" },
  },
};
const localeKey = (lang) => lang === "en" || lang === "ar" ? lang : "ku";

const tone = (value) => value === "critical" || value === "high" ? "danger" : value === "medium" ? "warning" : "neutral";
const dateText = (value, lang) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(lang === "ar" ? "ar-IQ" : lang === "en" ? "en-GB" : "ckb-IQ") : "—";
};

function useCenter(loader, client, lang) {
  const [snapshot, setSnapshot] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      setSnapshot(await loader(client));
      setState("ready");
    } catch (cause) {
      console.error("ZEMAN operational center", cause);
      setError(userFacingServiceError(cause, lang));
      setState("error");
    }
  }, [client, lang, loader]);
  useEffect(() => { refresh(); }, [refresh]);
  return { snapshot, state, error, refresh };
}

function Center({ kind, client, lang = "ku", onNavigate }) {
  const locale = localeKey(lang);
  const common = COPY[locale];
  const copy = common[kind];
  const loader = kind === "inbox" ? loadActionInbox : loadIntegrityCenter;
  const { snapshot, state, error, refresh } = useCenter(loader, client, locale);
  const items = snapshot?.items || [];
  const counts = useMemo(() => Object.entries(snapshot?.counts || {}).sort((a, b) => Number(b[1]) - Number(a[1])), [snapshot?.counts]);
  const Icon = kind === "inbox" ? Inbox : ShieldAlert;

  return <div className="operation-center">
    <header className="operation-center-header">
      <div className="operation-center-heading">
        <span className="operation-center-eyebrow">{copy.eyebrow}</span>
        <h1><Icon aria-hidden="true" /> {copy.title}</h1>
        <p>{copy.subtitle}</p>
      </div>
      <button type="button" className="operation-center-refresh" onClick={refresh} disabled={state === "loading"}>
        <RefreshCw aria-hidden="true" className={state === "loading" ? "is-spinning" : ""} />
        {common.refresh}
      </button>
    </header>

    {state === "error" && <section className="operation-center-state is-error" role="alert">
      <AlertTriangle aria-hidden="true" /><div><strong>{common.failed}</strong><p>{error}</p></div>
      <button type="button" onClick={refresh}>{common.retry}</button>
    </section>}

    {state !== "error" && <>
      <section className="operation-center-summary" aria-label={common.summary}>
        <div className="operation-summary-primary">
          <span className={`operation-summary-orb ${items.length ? "has-items" : "is-clear"}`}><CircleGauge aria-hidden="true" /></span>
          <div><strong>{snapshot?.total ?? "—"}</strong><span>{copy.total}</span></div>
        </div>
        <div className="operation-summary-counts">
          {counts.length ? counts.map(([label, count]) => <span key={label}><b>{count}</b>{label.replaceAll("_", " ")}</span>) : <span><b>0</b>{common.clear}</span>}
        </div>
      </section>

      {state === "loading" && !snapshot ? <section className="operation-center-loading" aria-live="polite">
        {[0, 1, 2].map((item) => <span key={item} />)}
      </section> : items.length === 0 ? <section className="operation-center-state is-clear">
        <CheckCircle2 aria-hidden="true" /><div><strong>{copy.empty}</strong><p>{copy.emptyDetail}</p></div>
      </section> : <section className="operation-center-list" aria-label={copy.title}>
        {items.map((item, index) => {
          const level = item.priority || item.severity || "neutral";
          return <article key={`${item.kind}-${item.created_at || item.detected_at}-${index}`} className={`operation-center-item tone-${tone(level)}`}>
            <span className="operation-item-light" aria-hidden="true" />
            <div className="operation-item-copy">
              <div className="operation-item-meta"><span>{String(item.kind || "item").replaceAll("_", " ")}</span><time>{dateText(item.created_at || item.detected_at, locale)}</time></div>
              <h2>{item.title}</h2>
              <p>{item.detail || "—"}</p>
            </div>
            {safeInboxAction(item) && <button type="button" onClick={() => onNavigate(safeInboxAction(item).path, item.focus || null)} aria-label={`${item.title} — ${common.open}`}>
              <span>{common.open}</span><ArrowLeft aria-hidden="true" />
            </button>}
          </article>;
        })}
      </section>}
    </>}
  </div>;
}

export function ActionInbox(props) { return <Center kind="inbox" {...props} />; }
export function IntegrityCenter(props) { return <Center kind="integrity" {...props} />; }
