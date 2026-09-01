import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, Eye, FileText, Inbox, Loader2, RefreshCw } from "lucide-react";
import {
  deliveryText, forwardedTotals, loadForwardedToMe, markSeen,
} from "../../services/receiptForwarding";
import "./receipt-forwarding.css";
import { errorText } from "../../services/userFacingError";

const COPY = {
  ku: {
    title: "فیشەکانی نێردراو بۆ تۆ",
    subtitle: "بەڵگەی مامەڵەکانت — بڕەکان وەک لە فیشەکەدا نووسراون",
    empty: "هێشتا هیچ فیشێکت بۆ نەنێردراوە",
    loading: "بارکردن...", refresh: "نوێکردنەوە",
    gross: "کۆی گشتی", order: "بڕی بنەڕەتی", fee: "فی", net: "نەت", count: "فیش",
    usd: "بە USD", rate: "نرخی جێگیرکراو", rateDate: "بەرواری نرخ",
    ref: "ژمارەی مامەڵە", merchant: "ژمارەی فرۆشیار", date: "بەروار", view: "بینینی فیش", ack: "بینیم",
    acked: "بینراوە ✓", pending: "بڕەکانی نەخوێندراوەتەوە",
    totals: "کۆی گشتی بەپێی دراو",
    noSum: "دراوە جیاوازەکان تێکەڵ ناکرێن",
  },
  en: {
    title: "The receipts sent to you",
    subtitle: "The evidence for your transactions — the amounts exactly as the receipt states them",
    empty: "No receipt has been sent to you yet",
    loading: "Loading…", refresh: "Refresh",
    gross: "Total", order: "Order amount", fee: "Fee", net: "Net", count: "receipts",
    usd: "In USD", rate: "Rate as fixed", rateDate: "Rate date",
    ref: "Transaction number", merchant: "Merchant number", date: "Date", view: "Open the receipt",
    ack: "I have seen it",
    acked: "Seen ✓", pending: "Its amounts have not been read yet",
    totals: "Total by currency",
    noSum: "Different currencies are not added together",
  },
  ar: {
    title: "الإيصالات المُرسَلة إليك",
    subtitle: "دليل معاملاتك — المبالغ كما وردت في الإيصال تمامًا",
    empty: "لم يُرسل إليك أي إيصال بعد",
    loading: "جارٍ التحميل…", refresh: "تحديث",
    gross: "الإجمالي", order: "مبلغ الطلب", fee: "الرسوم", net: "الصافي", count: "إيصالات",
    usd: "بالدولار", rate: "السعر المثبَّت", rateDate: "تاريخ السعر",
    ref: "رقم المعاملة", merchant: "رقم التاجر", date: "التاريخ", view: "افتح الإيصال",
    ack: "رأيته",
    acked: "شوهد ✓", pending: "لم تُقرأ مبالغه بعد",
    totals: "الإجمالي حسب العملة",
    noSum: "العملات المختلفة لا تُجمع معًا",
  },
};

const money = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const rateText = (row) => row.rateValue == null
  ? "—"
  : `1 USD = ${Number(row.rateValue).toLocaleString("en-US", { maximumFractionDigits: 8 })} ${row.currency || ""}`;

export function ForwardedReceipts({ client, lang = "ku", signedUrlFor = null, flash = () => {} }) {
  const copy = COPY[lang] || COPY.ku;
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("loading");
  const [busyId, setBusyId] = useState(null);
  // Callers pass a fresh `flash` on every render. Holding it in a ref keeps `load` stable, so
  // the list is fetched when it needs to be — not once per render of whatever renders this.
  const flashRef = useRef(flash);
  flashRef.current = flash;

  const load = useCallback(async () => {
    setState("loading");
    try {
      const data = await loadForwardedToMe(client);
      setRows(data);
      setState("ready");
    } catch (e) {
      console.error("forwarded receipts", e);
      flashRef.current(errorText(e));
      setState("error");
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => forwardedTotals(rows), [rows]);
  const totalCodes = Object.keys(totals);

  const acknowledge = async (row) => {
    if (busyId) return;
    setBusyId(row.documentId);
    try {
      await markSeen(client, row.documentId);
      setRows((prev) => prev.map((x) =>
        x.documentId === row.documentId
          ? { ...x, deliveryStatus: "seen", seenAt: new Date().toISOString() }
          : x));
    } catch (e) {
      console.error("mark seen", e);
      flash(errorText(e));
    } finally { setBusyId(null); }
  };

  const open = async (row) => {
    if (!signedUrlFor || !row.storagePath) return;
    try {
      // §8.10: a short-lived signed URL fetched at view time, never a stored public link.
      const url = await signedUrlFor(row.storagePath);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) { flash(errorText(e)); }
  };

  return (
    <section className="fwd-panel is-portal">
      <header className="fwd-header">
        <div className="fwd-icon"><Inbox /></div>
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="fwd-refresh" onClick={load}>
          <RefreshCw /> {copy.refresh}
        </button>
      </header>

      {totalCodes.length > 0 && (
        <div className="fwd-totals">
          <h3>{copy.totals}</h3>
          {/* One row per currency. Nothing is ever added across currencies. */}
          <div className="fwd-totals-grid">
            {totalCodes.map((code) => (
              <div key={code} className="fwd-total-card">
                <span className="fwd-total-code">{code}</span>
                <span className="fwd-total-net">{money(totals[code].net)}</span>
                <span className="fwd-total-sub">
                  {copy.gross} {money(totals[code].gross)} · {copy.fee} {money(totals[code].fee)} · {totals[code].count} {copy.count}
                </span>
              </div>
            ))}
          </div>
          {totalCodes.length > 1 && <p className="fwd-note">{copy.noSum}</p>}
        </div>
      )}

      {state === "loading" && <div className="fwd-empty"><Loader2 className="fwd-spin" /> {copy.loading}</div>}
      {state === "ready" && rows.length === 0 && <div className="fwd-empty">{copy.empty}</div>}

      {rows.length > 0 && (
        <ul className="fwd-list is-portal">
          {rows.map((r) => (
            <li key={r.documentId}>
              <div className="fwd-doc">
                <div className="fwd-doc-head">
                  <FileText />
                  <span className="fwd-doc-amount">
                    {r.net == null ? copy.pending : `${money(r.net)} ${r.currency || ""}`}
                  </span>
                  <span className={`fwd-badge is-${r.deliveryStatus}`}>{deliveryText(r.deliveryStatus)}</span>
                </div>
                {r.net != null && (
                  <div className="fwd-doc-figures">
                    <span>{copy.gross} <b>{money(r.gross)}</b></span>
                    <span>{copy.order} <b>{money(r.orderAmount)}</b></span>
                    <span>{copy.fee} <b>{money(r.fee)}</b></span>
                    <span>{copy.net} <b>{money(r.net)}</b></span>
                  </div>
                )}
                {r.netUsd != null && (
                  <div className="fwd-doc-valuation">
                    <div className="fwd-doc-figures">
                      <span>{copy.gross} {copy.usd} <b>${money(r.grossUsd)}</b></span>
                      <span>{copy.fee} {copy.usd} <b>${money(r.feeUsd)}</b></span>
                      <span>{copy.net} {copy.usd} <b>${money(r.netUsd)}</b></span>
                    </div>
                    <small>
                      {copy.rate}: <b dir="ltr">{rateText(r)}</b>
                      {r.rateDate ? <> · {copy.rateDate}: <b dir="ltr">{r.rateDate}</b></> : null}
                      {r.rateVersion != null ? <> · v{r.rateVersion}</> : null}
                    </small>
                  </div>
                )}
                <div className="fwd-doc-meta">
                  {r.refNo && <span>{copy.ref}: <code>{r.refNo}</code></span>}
                  {r.merchantOrderNo && <span>{copy.merchant}: <code>{r.merchantOrderNo}</code></span>}
                  {r.txDate && <span>{copy.date}: {r.txDate}</span>}
                </div>
                <div className="fwd-doc-actions">
                  {signedUrlFor && r.storagePath && (
                    <button type="button" className="fwd-view" onClick={() => open(r)}>
                      <Eye /> {copy.view}
                    </button>
                  )}
                  {r.deliveryStatus === "seen" ? (
                    <span className="fwd-acked"><CheckCheck /> {copy.acked}</span>
                  ) : (
                    <button type="button" className="fwd-ack" onClick={() => acknowledge(r)} disabled={busyId === r.documentId}>
                      {busyId === r.documentId ? <Loader2 className="fwd-spin" /> : <CheckCheck />} {copy.ack}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
