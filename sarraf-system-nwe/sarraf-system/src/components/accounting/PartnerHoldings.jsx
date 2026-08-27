import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, Loader2, RefreshCw } from "lucide-react";
import { detailRows, loadBatchDetail, loadHoldings, platformName } from "../../services/partnerBatches.js";
import "./debt-center.css";
import { errorText } from "../../services/userFacingError";

/**
 * What a partner is holding for the house, and the receipts behind it.
 *
 * Task A's screen. A seller transfers yuan straight to a partner and uploads the receipt; the
 * admin turns the batch into a transaction naming that partner; from then on the partner can
 * open the same details the house reviewed — the receiver, the date, the wallet, and whether
 * each receipt carried a fee.
 *
 * Every figure comes from the server. Nothing is added up here, because a partner and the house
 * disagreeing about a total is the one outcome this screen exists to prevent.
 */

const COPY = {
  ku: {
    title: "ئەوەی لای تۆ دانراوە",
    subtitle: "کۆمەڵە فیشەکانی کە پارەکەیان لای تۆ دانراوە — بە وردەکاری",
    staffSubtitle: "کۆمەڵە فیشەکان بەپێی ئەو هاوبەشەی پارەکەی لای دانراوە",
    refresh: "نوێکردنەوە", loading: "بارکردن...",
    empty: "هیچ کۆمەڵەیەک لای تۆ دانەنراوە",
    staffEmpty: "هیچ کۆمەڵەیەک بۆ ئەم هاوبەشە دانەنراوە",
    failed: "زانیارییەکان بار نەبوون",
    batch: "کۆمەڵە", receipts: "فیش", amount: "بڕ", customer: "فرۆشیار",
    open: "وردەکاری", close: "داخستن",
    receiver: "وەرگر", date: "بەروار", platform: "پلاتفۆرم",
    withFee: "بە فی", withoutFee: "بێ فی", fee: "فی", feeStatus: "دۆخی فی",
    ref: "ژمارەی ئاماژە", state: "دۆخ",
    total: "کۆی گشتی", byPlatform: "بەپێی پلاتفۆرم", byReceiver: "بەپێی وەرگر",
    pick: "هاوبەشێک هەڵبژێرە",
  },
  en: {
    title: "Placed with you",
    subtitle: "Receipt batches whose money is held by you, in full",
    staffSubtitle: "Receipt batches by the partner holding the money",
    refresh: "Refresh", loading: "Loading…",
    empty: "Nothing has been placed with you",
    staffEmpty: "Nothing has been placed with this partner",
    failed: "Could not load",
    batch: "Batch", receipts: "Receipts", amount: "Amount", customer: "Seller",
    open: "Details", close: "Close",
    receiver: "Receiver", date: "Date", platform: "Platform",
    withFee: "With fee", withoutFee: "Without fee", fee: "Fee", feeStatus: "Fee status",
    ref: "Reference", state: "State",
    total: "Total", byPlatform: "By platform", byReceiver: "By recipient",
    pick: "Choose a partner",
  },
};
COPY.ar = COPY.en;

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v ? String(v).slice(0, 10) : "—");

export function PartnerHoldings({ client, lang = "ku", isStaff = false, partners = [] }) {
  const copy = COPY[localeKey(lang)];
  const [state, setState] = useState("loading");
  const [held, setHeld] = useState(null);
  const [partnerId, setPartnerId] = useState("");
  const [openBatch, setOpenBatch] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setHeld(await loadHoldings(client, isStaff ? partnerId : null));
      setState("ready");
    } catch {
      setState("error");
    }
  }, [client, isStaff, partnerId]);

  useEffect(() => { load(); }, [load]);

  // A failure to read one batch's details must leave the list standing: the person can still
  // see what they hold, and try the row again.
  const open = useCallback(async (batchId) => {
    if (openBatch === batchId) { setOpenBatch(null); setDetail(null); return; }
    setOpenBatch(batchId); setDetail(null); setDetailError("");
    try { setDetail(await loadBatchDetail(client, batchId)); }
    catch (error) { setDetailError(errorText(error).slice(0, 200)); }
  }, [client, openBatch]);

  const batches = held?.batches || [];
  const rows = useMemo(() => (detail ? detailRows(detail, { lang }) : []), [detail, lang]);

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
    <section className="debt-panel" aria-labelledby="partner-holdings-title">
      <header className="debt-header">
        <span className="debt-icon"><Boxes aria-hidden="true" /></span>
        <div>
          <h2 id="partner-holdings-title">{copy.title}</h2>
          <p>{isStaff ? copy.staffSubtitle : copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      {isStaff && (
        <div className="cashbox-form">
          <label>{copy.pick}
            <select value={partnerId} aria-label={copy.pick}
                    onChange={(event) => { setPartnerId(event.target.value); setOpenBatch(null); }}>
              <option value="">{copy.pick}</option>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
      )}

      {(held?.by_currency || []).length > 0 && (
        <div className="debt-cards" role="status">
          {held.by_currency.map((c) => (
            <div className="debt-card" key={c.currency}>
              <span className="debt-card-label">{c.currency}</span>
              <strong>{money(c.amount)}</strong>
              <span className="debt-card-note">{c.batches} {copy.batch} · {c.receipts} {copy.receipts}</span>
            </div>
          ))}
        </div>
      )}

      {batches.length === 0 ? (
        <p className="debt-empty">{isStaff ? copy.staffEmpty : copy.empty}</p>
      ) : (
        <div className="debt-table-wrap">
          <table className="debt-table">
            <thead><tr>
              <th>{copy.batch}</th><th>{copy.customer}</th><th>{copy.receipts}</th>
              <th>{copy.amount}</th><th>{copy.date}</th><th />
            </tr></thead>
            <tbody>
              {batches.map((b) => (
                <React.Fragment key={b.batch_id}>
                  <tr>
                    <td>{b.batch_id}</td>
                    <td>{b.customer_name || b.customer_id || "—"}</td>
                    <td>{b.item_count}</td>
                    <td>{money(b.amount)} {b.currency}</td>
                    <td>{day(b.created_at)}</td>
                    <td>
                      <button type="button" onClick={() => open(b.batch_id)}
                              aria-expanded={openBatch === b.batch_id}
                              aria-label={`${copy.open} — ${b.batch_id}`}>
                        {openBatch === b.batch_id ? copy.close : copy.open}
                      </button>
                    </td>
                  </tr>
                  {openBatch === b.batch_id && (
                    <tr><td colSpan={6}>
                      {detailError
                        ? <div className="debt-error" role="alert">
                            <AlertTriangle aria-hidden="true" /> {copy.failed} — {detailError}
                          </div>
                        : !detail
                          ? <p className="debt-empty"><Loader2 aria-hidden="true" /> {copy.loading}</p>
                          : (
                            <>
                              <div className="debt-table-wrap">
                                <table className="debt-table">
                                  <thead><tr>
                                    <th>{copy.receiver}</th><th>{copy.date}</th><th>{copy.platform}</th>
                                    <th>{copy.withFee}</th><th>{copy.fee}</th><th>{copy.withoutFee}</th>
                                    <th>{copy.feeStatus}</th><th>{copy.ref}</th><th>{copy.state}</th>
                                  </tr></thead>
                                  <tbody>
                                    {rows.map((r, i) => (
                                      <tr key={detail.rows[i]?.id || i}>
                                        <td>{r["وەرگر"]}</td>
                                        <td>{r["بەروار"]}</td>
                                        <td>{r["پلاتفۆرم"]}</td>
                                        <td>{money(r["بڕ (بە فی)"])}</td>
                                        <td>{money(r["فی"])}</td>
                                        <td>{money(r["بڕ (بێ فی)"])}</td>
                                        <td>{r["دۆخی فی"]}</td>
                                        <td>{r["ژمارەی ئاماژە"]}</td>
                                        <td>{r["دۆخ"]}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              <div className="debt-cards" role="status">
                                {(detail.totals || []).map((t) => (
                                  <div className="debt-card" key={`t-${t.currency}`}>
                                    <span className="debt-card-label">{copy.total} — {t.currency}</span>
                                    <strong>{money(t.with_fee)}</strong>
                                    <span className="debt-card-note">
                                      {copy.withoutFee}: {money(t.without_fee)} · {copy.fee}: {money(t.fee)}
                                    </span>
                                  </div>
                                ))}
                                {(detail.by_platform || []).map((p) => (
                                  <div className="debt-card" key={`p-${p.platform}-${p.currency}`}>
                                    <span className="debt-card-label">
                                      {copy.byPlatform} — {platformName(p.platform, lang)}
                                    </span>
                                    <strong>{money(p.with_fee)}</strong>
                                    <span className="debt-card-note">{p.n} {copy.receipts} · {p.currency}</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default PartnerHoldings;
