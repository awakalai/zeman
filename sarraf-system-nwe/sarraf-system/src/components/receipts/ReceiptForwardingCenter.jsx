import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, Eye, Loader2, RefreshCw, Send, Truck, UserRound,
} from "lucide-react";
import {
  forwardCommandKey, forwardReceipts, loadForwardingReconciliation,
  partitionForForwarding, recipientRoleFor, skipReasonText,
} from "../../services/receiptForwarding";
import "./receipt-forwarding.css";
import { errorText } from "../../services/userFacingError";

const COPY = {
  ku: {
    title: "ناردنی فیش بۆ خاوەنەکەی",
    subtitle: "تەنها فیشی تەواوکراو دەنێردرێت؛ سێرڤەر وەرگری ڕاستەقینە لە assignment ـی مامەڵەکەوە دەستنیشان دەکات",
    refresh: "نوێکردنەوە", loading: "بارکردن…", empty: "هیچ فیشێکی تەواوکراو بۆ ناردن نییە",
    eligible: "ئامادەی ناردن", blocked: "نانێردرێت", selected: "هەڵبژێردراو",
    selectAll: "هەمووی", clearAll: "لابردن",
    reason: "هۆکاری ناردن (لانیکەم ٨ پیت)", send: "ناردن", working: "دەنێردرێت…",
    sent: "نێردرا", skipped: "نەنێردرا",
    flows: {
      customer_buys_from_zeman: "کڕیار کڕیویەتی لە زەمان → بۆ کڕیار",
    },
    wantsCustomer: "ئەم فیشە بۆ کڕیار دەنێردرێت",
    recon: "پێکهاتنەوەی گەیاندن", reconForwarded: "نێردراو", reconSent: "لە ڕێگادا",
    reconDelivered: "گەیشتوو", reconSeen: "بینراو", reconFailed: "نەگەیشتوو",
    reconNote: "ناردن، گەیشتن و بینین سێ شتی جیاوازن و بە جیا دەژمێردرێن",
    result: "ئەنجام", replayed: "ئەم فەرمانە پێشتر جێبەجێکرابوو — دووبارە نەنێردرا",
    noneSelected: "هیچ فیشێک هەڵنەبژێردراوە",
    roles: { customer: "کڕیار", partner: "هاوبەش" },
    view: "بینینی وێنە",
  },
  en: {
    title: "Sending a receipt to the person it belongs to",
    subtitle: "Only a finalised receipt is sent; the server decides the real recipient from the transaction's assignment",
    refresh: "Refresh", loading: "Loading…", empty: "No finalised receipt is waiting to be sent",
    eligible: "Ready to send", blocked: "Cannot be sent", selected: "Selected",
    selectAll: "All", clearAll: "None",
    reason: "Why it is being sent (at least 8 characters)", send: "Send", working: "Sending…",
    sent: "Sent", skipped: "Not sent",
    flows: {
      customer_buys_from_zeman: "The customer bought from ZEMAN → to the customer",
    },
    wantsCustomer: "This receipt goes to the customer",
    recon: "Did it arrive", reconForwarded: "Sent", reconSent: "On its way",
    reconDelivered: "Arrived", reconSeen: "Seen", reconFailed: "Did not arrive",
    reconNote: "Sending, arriving and being seen are three different things, counted separately",
    result: "Result", replayed: "This command had already run — nothing was sent twice",
    noneSelected: "No receipt is selected",
    roles: { customer: "Customer", partner: "Partner" },
    view: "Open the image",
  },
  ar: {
    title: "إرسال الإيصال إلى صاحبه",
    subtitle: "لا يُرسل إلا إيصال مُنجَز؛ الخادم يحدد المستلم الحقيقي من تخصيص المعاملة",
    refresh: "تحديث", loading: "جارٍ التحميل…", empty: "لا يوجد إيصال مُنجَز ينتظر الإرسال",
    eligible: "جاهز للإرسال", blocked: "لا يمكن إرساله", selected: "المحدد",
    selectAll: "الكل", clearAll: "لا شيء",
    reason: "سبب الإرسال (٨ أحرف على الأقل)", send: "إرسال", working: "جارٍ الإرسال…",
    sent: "أُرسل", skipped: "لم يُرسل",
    flows: {
      customer_buys_from_zeman: "اشترى العميل من زيمان → إلى العميل",
    },
    wantsCustomer: "هذا الإيصال يذهب إلى العميل",
    recon: "هل وصل", reconForwarded: "أُرسل", reconSent: "في الطريق",
    reconDelivered: "وصل", reconSeen: "شوهد", reconFailed: "لم يصل",
    reconNote: "الإرسال والوصول والمشاهدة ثلاثة أشياء مختلفة، وتُعدّ كلٌّ على حدة",
    result: "النتيجة", replayed: "هذا الأمر سبق تنفيذه — لم يُرسل مرتين",
    noneSelected: "لم يُحدَّد أي إيصال",
    roles: { customer: "عميل", partner: "شريك" },
    view: "افتح الصورة",
  },
};

const money = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function ReceiptForwardingCenter({
  client, lang = "ku", people = [], flash = () => {}, signedUrlFor = null,
}) {
  const copy = COPY[lang] || COPY.ku;
  const [docs, setDocs] = useState([]);
  const [state, setState] = useState("loading");
  const [picked, setPicked] = useState(() => new Set());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [recon, setRecon] = useState(null);
  // Callers pass a fresh `flash` on every render. Holding it in a ref keeps `load` stable, so
  // the queue is fetched when it needs to be — not once per render of whatever renders this.
  const flashRef = useRef(flash);
  flashRef.current = flash;

  const load = useCallback(async () => {
    setState("loading");
    try {
      // The server's RLS decides what an operator may see; nothing here widens it.
      const { data, error } = await client
        .from("receipt_documents")
        .select("id,flow,state,expected_currency,customer_id,partner_id,transaction_id,storage_path,received_at")
        .eq("state", "finalized")
        .eq("flow", "customer_buys_from_zeman")
        .order("received_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      setDocs(data || []);
      setState("ready");
      setRecon(await loadForwardingReconciliation(client).catch(() => null));
    } catch (e) {
      console.error("forwarding queue", e);
      flashRef.current(errorText(e));
      setState("error");
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  const { eligible, blocked } = useMemo(
    () => partitionForForwarding(docs),
    [docs],
  );

  // A receipt that stops being eligible must also stop being selected.
  useEffect(() => {
    setPicked((prev) => {
      const ok = new Set(eligible.map((d) => d.id));
      const next = new Set([...prev].filter((id) => ok.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [eligible]);

  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const send = async () => {
    if (busy) return;
    if (!picked.size) { flash(copy.noneSelected); return; }
    setBusy(true);
    setResult(null);
    try {
      const r = await forwardReceipts(client, {
        documentIds: [...picked],
        reason,
        commandKey: forwardCommandKey("assigned"),
      });
      setResult(r);
      setPicked(new Set());
      setReason("");
      await load();
    } catch (e) {
      console.error("forward", e);
      flash(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const openImage = async (path) => {
    if (!signedUrlFor || !path) return;
    try {
      const url = await signedUrlFor(path);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) { flash(errorText(e)); }
  };

  const nameOf = (id) => (people || []).find((p) => p.id === id)?.name || id || "—";

  return (
    <section className="fwd-panel">
      <header className="fwd-header">
        <div className="fwd-icon"><Truck /></div>
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="fwd-refresh" onClick={load} disabled={busy}>
          <RefreshCw /> {copy.refresh}
        </button>
      </header>

      {recon && (
        <div className="fwd-recon">
          <h3>{copy.recon}</h3>
          <div className="fwd-recon-grid">
            <div className="fwd-recon-cell"><span>{copy.reconForwarded}</span><b>{recon.forwarded}</b></div>
            <div className="fwd-recon-cell"><span>{copy.reconSent}</span><b>{recon.sent}</b></div>
            <div className="fwd-recon-cell"><span>{copy.reconDelivered}</span><b>{recon.delivered}</b></div>
            <div className="fwd-recon-cell"><span>{copy.reconSeen}</span><b>{recon.seen}</b></div>
            <div className={`fwd-recon-cell ${recon.failed ? "is-bad" : ""}`}><span>{copy.reconFailed}</span><b>{recon.failed}</b></div>
          </div>
          <p className="fwd-note">{copy.reconNote}</p>
        </div>
      )}

      <div className="fwd-controls">
        <label className="fwd-field fwd-field-wide">
          <span>{copy.reason}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={700} />
        </label>
        <button type="button" className="fwd-send" onClick={send} disabled={busy || !picked.size}>
          {busy ? <Loader2 className="fwd-spin" /> : <Send />}
          {busy ? copy.working : `${copy.send} (${picked.size})`}
        </button>
      </div>

      {result && (
        <div className={`fwd-result ${result.skipped.length ? "is-mixed" : "is-ok"}`}>
          <h3><CheckCircle2 /> {copy.result}</h3>
          <p>{copy.sent}: <b>{result.forwarded}</b>{result.replayed ? ` — ${copy.replayed}` : ""}</p>
          {result.destinations?.length > 0 && (
            <ul className="fwd-skip-list">
              {result.destinations.map((destination) => (
                <li key={destination.documentId}>
                  <code>{destination.documentId}</code> → {nameOf(destination.toActorId)} ({copy.roles[destination.toRole] || destination.toRole})
                </li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <ul className="fwd-skip-list">
              {result.skipped.map((s) => (
                <li key={s.id}><code>{s.id}</code> — {s.text}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state === "loading" && <div className="fwd-empty"><Loader2 className="fwd-spin" /> {copy.loading}</div>}

      {state === "ready" && (
        <>
          <div className="fwd-section">
            <div className="fwd-section-head">
              <h3>{copy.eligible} <span className="fwd-count">{eligible.length}</span></h3>
              <div className="fwd-bulk">
                <button type="button" onClick={() => setPicked(new Set(eligible.map((d) => d.id)))}
                  disabled={!eligible.length}>{copy.selectAll}</button>
                <button type="button" onClick={() => setPicked(new Set())} disabled={!picked.size}>{copy.clearAll}</button>
              </div>
            </div>
            {eligible.length === 0 ? (
              <div className="fwd-empty">{copy.empty}</div>
            ) : (
              <ul className="fwd-list">
                {eligible.map((d) => {
                  const wants = recipientRoleFor(d.flow);
                  return (
                    <li key={d.id} className={picked.has(d.id) ? "is-picked" : ""}>
                      <label className="fwd-row">
                        <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                        <span className="fwd-row-main">
                          <span className="fwd-row-id">{d.id}</span>
                          <span className="fwd-row-flow">{copy.flows[d.flow] || d.flow}</span>
                        </span>
                        <span className="fwd-row-meta">
                          <span className="fwd-badge">{d.state}</span>
                          {wants && (
                            <span className="fwd-wants">
                              <UserRound /> {copy.wantsCustomer}
                            </span>
                          )}
                        </span>
                      </label>
                      {signedUrlFor && d.storage_path && (
                        <button type="button" className="fwd-view" onClick={() => openImage(d.storage_path)}>
                          <Eye /> {copy.view}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Named, not hidden: an operator who cannot see why a receipt did not go will
              assume the system lost it. */}
          {blocked.length > 0 && (
            <div className="fwd-section">
              <div className="fwd-section-head">
                <h3><AlertTriangle /> {copy.blocked} <span className="fwd-count">{blocked.length}</span></h3>
              </div>
              <ul className="fwd-list is-blocked">
                {blocked.map((d) => (
                  <li key={d.id}>
                    <div className="fwd-row">
                      <span className="fwd-row-main">
                        <span className="fwd-row-id">{d.id}</span>
                        <span className="fwd-row-flow">
                          {d.customer_id ? nameOf(d.customer_id) : d.partner_id ? nameOf(d.partner_id) : ""}
                        </span>
                      </span>
                      <span className="fwd-row-meta">
                        <span className="fwd-badge is-blocked">{skipReasonText(d.blockedBy)}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {state === "error" && (
        <div className="fwd-empty is-error"><AlertTriangle /> {copy.loading}</div>
      )}
    </section>
  );
}
