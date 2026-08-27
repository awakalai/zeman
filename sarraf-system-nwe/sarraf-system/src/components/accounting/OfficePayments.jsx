import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Building2, CheckCircle2, Clock, Eye, FileUp, Loader2, RefreshCw, Send, ShieldCheck } from "lucide-react";
import "./debt-center.css";
import { errorText } from "../../services/userFacingError";

const COPY = {
  ku: {
    title: "پارەدانی نووسینگە", subtitle: "تەنها ئەو ئەرکانەی بۆ تۆ دیاریکراون — بڕ و دراو لە مامەڵەکەوە دێن و ناگۆڕدرێن",
    empty: "هیچ ئەرکێکی پارەدانت نییە", refresh: "نوێکردنەوە", loading: "بارکردن...",
    amount: "بڕی داواکراو", paid: "دراوە", outstanding: "ماوە", due: "کاتی کۆتایی",
    ack: "بینیم", initiated: "دەستم پێکرد", report: "پارەم دا",
    reference: "ژمارەی پسووڵە", note: "تێبینی", reportAmount: "بڕی دراو",
    evidence: "بەڵگەی پارەدان (وێنە یان PDF)", evidenceRequired: "پێش ڕاپۆرتکردن، بەڵگەی پارەدان هەڵبژێرە",
    viewEvidence: "بینینی بەڵگە",
    send: "ناردن", working: "جێبەجێکردن...",
    confirm: "پشتڕاستکردنەوە و تەسویە", confirmReason: "هۆکاری پشتڕاستکردنەوە (لانیکەم ٨ پیت)",
    failed: "زانیاریی ئەرکەکانی نووسینگە بار نەبوو",
    statuses: {
      assigned: "دیاریکراو", acknowledged: "بینراوە", payment_initiated: "دەستی پێکراوە",
      paid_reported: "ڕاپۆرتکراو", confirmed: "پشتڕاستکراو", rejected: "ڕەتکراو", cancelled: "هەڵوەشێنراوە",
    },
    confirmNote: "پشتڕاستکردنەوە لەلایەن ئەدمینەوە دەکرێت — تۆ ناتوانیت پارەدانی خۆت پشتڕاست بکەیت",
    confirmed: "پارەدانەکە پشتڕاست کرایەوە",
  },
  en: {
    title: "Office payments", subtitle: "Only assignments given to you — amount and currency come from the transaction and cannot be changed",
    empty: "No payment assignments", refresh: "Refresh", loading: "Loading…",
    amount: "Amount due", paid: "Paid", outstanding: "Outstanding", due: "Due",
    ack: "Acknowledge", initiated: "Payment started", report: "Report payment",
    reference: "Reference", note: "Note", reportAmount: "Amount paid",
    evidence: "Payment evidence (image or PDF)", evidenceRequired: "Choose payment evidence before reporting",
    viewEvidence: "View evidence",
    send: "Send", working: "Working…",
    confirm: "Confirm and settle", confirmReason: "Confirmation reason (at least 8 characters)",
    failed: "Could not load office assignments",
    statuses: {
      assigned: "Assigned", acknowledged: "Acknowledged", payment_initiated: "Started",
      paid_reported: "Reported", confirmed: "Confirmed", rejected: "Rejected", cancelled: "Cancelled",
    },
    confirmNote: "Confirmation is done by an administrator — you cannot confirm your own payment",
    confirmed: "Payment confirmed",
  },
};
COPY.ar = COPY.en;
const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const commandKey = () =>
  `office-pay:${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;

export function OfficePayments({ client, lang = "ku", flash = () => {}, canConfirm = false }) {
  const copy = COPY[localeKey(lang)];
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("loading");
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState({ amount: "", reference: "", note: "", file: null });
  const [confirmReasons, setConfirmReasons] = useState({});
  const [busy, setBusy] = useState(false);
  const intentKeys = useRef(new Map());
  const evidenceIntents = useRef(new Map());
  const keyFor = (intent) => {
    if (!intentKeys.current.has(intent)) intentKeys.current.set(intent, commandKey());
    return intentKeys.current.get(intent);
  };

  const load = useCallback(async () => {
    setState("loading");
    try {
      // RLS returns only this office's assignments; no client-side filtering is relied on.
      const { data, error } = await client
        .from("office_payment_assignments")
        .select("*")
        .order("assigned_at", { ascending: false });
      if (error) throw error;
      setRows((data || []).map((r) => ({
        id: r.id,
        amount: Number(r.amount) || 0,
        paid: Number(r.amount_paid) || 0,
        currency: r.currency,
        status: r.status,
        dueAt: r.due_at,
        reference: r.payment_reference,
        note: r.payment_note,
        evidencePath: r.evidence_path,
        transactionId: r.transaction_id,
      })));
      setState("ready");
    } catch (e) {
      console.error("office payments", e);
      flash(errorText(e));
      setState("error");
    }
  }, [client, flash]);

  useEffect(() => { load(); }, [load]);

  const attachEvidence = async (row, intent) => {
    const file = form.file;
    if (!file) throw new Error(copy.evidenceRequired);
    const allowed = {
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf",
    };
    const extension = allowed[file.type];
    if (!extension || !(file.size > 0 && file.size <= 10 * 1024 * 1024)) {
      throw new Error(copy.evidenceRequired);
    }
    let evidence = evidenceIntents.current.get(intent);
    if (!evidence) {
      const objectId = globalThis.crypto?.randomUUID?.() || Date.now().toString(36);
      evidence = {
        path: `ingest/office-payments/${row.id}/${objectId}.${extension}`,
        uploaded: false, attached: false,
      };
      evidenceIntents.current.set(intent, evidence);
    }
    if (!evidence.uploaded) {
      const { error } = await client.storage.from("receipts").upload(evidence.path, file, {
        upsert: false, cacheControl: "3600", contentType: file.type,
      });
      if (error) throw error;
      evidence.uploaded = true;
    }
    if (!evidence.attached) {
      const session = await client.auth.getSession();
      const token = session?.data?.session?.access_token;
      if (session?.error || !token) throw session?.error || new Error("session required");
      const response = await fetch("/api/office-payment-evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          assignmentId: row.id,
          storagePath: evidence.path,
          commandKey: keyFor(`evidence:${intent}`),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || "payment evidence could not be attested");
      evidence.attached = true;
    }
    return evidence.path;
  };

  const viewEvidence = async (row) => {
    if (!row.evidencePath) return;
    try {
      const { data, error } = await client.storage.from("receipts").createSignedUrl(row.evidencePath, 300);
      if (error) throw error;
      if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    } catch (error) { flash(errorText(error)); }
  };

  const report = async (row, status) => {
    if (busy) return;
    const fileKey = form.file
      ? `${form.file.name}:${form.file.type}:${form.file.size}:${form.file.lastModified}` : "no-file";
    const intent = `report:${row.id}:${status}:${form.amount}:${form.reference}:${form.note}:${fileKey}`;
    setBusy(true);
    try {
      if (status === "paid_reported") await attachEvidence(row, intent);
      const { error } = await client.rpc("sarraf_office_payment_report", {
        p_assignment_id: row.id,
        p_status: status,
        p_amount: status === "paid_reported" ? Number(form.amount) : null,
        p_reference: form.reference || null,
        p_note: form.note || null,
        p_command_key: keyFor(intent),
      });
      if (error) throw error;
      intentKeys.current.delete(intent);
      intentKeys.current.delete(`evidence:${intent}`);
      evidenceIntents.current.delete(intent);
      flash("✓");
      setOpenId(null);
      setForm({ amount: "", reference: "", note: "", file: null });
      await load();
    } catch (e) {
      console.error("office report", e);
      flash(errorText(e));
    } finally { setBusy(false); }
  };

  const confirm = async (row) => {
    const reason = String(confirmReasons[row.id] || "").trim();
    if (busy || reason.length < 8) return;
    const intent = `confirm:${row.id}:${reason}`;
    setBusy(true);
    try {
      const { error } = await client.rpc("sarraf_office_payment_confirm", {
        p_assignment_id: row.id,
        p_reason: reason,
        p_command_key: keyFor(intent),
      });
      if (error) throw error;
      intentKeys.current.delete(intent);
      flash(`${copy.confirm} ✓`);
      setConfirmReasons((current) => ({ ...current, [row.id]: "" }));
      await load();
    } catch (e) {
      console.error("office confirmation", e);
      flash(errorText(e));
    } finally { setBusy(false); }
  };

  if (state === "loading") return <div className="debt-panel"><div className="debt-loading">{copy.loading}</div></div>;
  if (state === "error") return (
    <section className="debt-panel">
      <div className="debt-error" role="alert"><AlertTriangle aria-hidden="true" /> {copy.failed}
        <button type="button" onClick={load}><RefreshCw aria-hidden="true" /> {copy.refresh}</button>
      </div>
    </section>
  );

  return (
    <section className="debt-panel" aria-labelledby="office-pay-title">
      <header className="debt-header">
        <span className="debt-icon"><Building2 aria-hidden="true" /></span>
        <div>
          <h2 id="office-pay-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      {rows.length === 0 ? <p className="debt-muted debt-empty">{copy.empty}</p> : rows.map((row) => {
        const outstanding = row.amount - row.paid;
        const settled = row.status === "confirmed" || outstanding <= 0;
        const canReport = !canConfirm && !["confirmed", "cancelled", "rejected"].includes(row.status);
        const canApprove = canConfirm && row.status === "paid_reported" && outstanding <= 0 && row.evidencePath;
        return (
          <article key={row.id} className="debt-card">
            <div className="debt-currency-row">
              <span className="debt-card-title">
                <strong>{money(row.amount)} <span className="debt-currency-code">{row.currency}</span></strong>
                <span className="debt-reason">{copy.amount}</span>
              </span>
              <span className={`debt-badge ${settled ? "is-ok" : ""}`}
                    style={settled ? { background: "var(--pos-bg)", color: "var(--pos)" } : undefined}>
                {settled ? <CheckCircle2 aria-hidden="true" style={{ width: 11, height: 11, verticalAlign: "-1px" }} />
                         : <Clock aria-hidden="true" style={{ width: 11, height: 11, verticalAlign: "-1px" }} />}
                {" "}{copy.statuses[row.status] || row.status}
              </span>
            </div>

            <div className="debt-currency-list">
              <div className="debt-currency-row">
                <span className="debt-currency-code">{copy.paid}</span>
                <span className="debt-currency-amount pos">{money(row.paid)}</span>
              </div>
              <div className="debt-currency-row">
                <span className="debt-currency-code">{copy.outstanding}</span>
                <span className={`debt-currency-amount ${outstanding > 0 ? "neg" : ""}`}>{money(outstanding)}</span>
              </div>
              {row.dueAt && (
                <div className="debt-currency-row">
                  <span className="debt-currency-code">{copy.due}</span>
                  <span className="debt-currency-amount">{new Date(row.dueAt).toLocaleDateString("en-GB")}</span>
                </div>
              )}
              {row.evidencePath && (
                <button type="button" className="cashbox-btn" onClick={() => viewEvidence(row)}>
                  <Eye aria-hidden="true" /> {copy.viewEvidence}
                </button>
              )}
            </div>

            {canReport && (
              <>
                <div className="cashbox-actions">
                  <button type="button" className="cashbox-btn" disabled={busy}
                          onClick={() => report(row, "acknowledged")}>
                    {busy ? <Loader2 className="spin" aria-hidden="true" /> : null} {copy.ack}
                  </button>
                  <button type="button" className="cashbox-btn" disabled={busy}
                          onClick={() => report(row, "payment_initiated")}>{copy.initiated}</button>
                  <button type="button" className="cashbox-btn is-pos"
                          onClick={() => setOpenId(openId === row.id ? null : row.id)}>
                    <Send aria-hidden="true" /> {copy.report}
                  </button>
                </div>

                {openId === row.id && (
                  <div className="cashbox-form">
                    <label>
                      {copy.reportAmount}
                      <input type="number" inputMode="decimal" value={form.amount}
                             max={outstanding}
                             onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                    </label>
                    <label>
                      {copy.reference}
                      <input value={form.reference}
                             onChange={(e) => setForm({ ...form, reference: e.target.value })} />
                    </label>
                    <label className="cashbox-wide">
                      {copy.note}
                      <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                    </label>
                    <label className="cashbox-wide">
                      {copy.evidence}
                      <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
                             onChange={(e) => setForm({ ...form, file: e.target.files?.[0] || null })} />
                    </label>
                    <button type="button" className="cashbox-btn is-pos cashbox-wide"
                            disabled={busy || !(Number(form.amount) > 0) || Number(form.amount) > outstanding
                              || form.reference.trim().length < 3 || !form.file}
                            onClick={() => report(row, "paid_reported")}>
                      {busy ? copy.working : <><FileUp aria-hidden="true" /> {copy.send}</>}
                    </button>
                  </div>
                )}
              </>
            )}

            {canApprove && (
              <div className="cashbox-form">
                <label className="cashbox-wide">
                  {copy.confirmReason}
                  <input value={confirmReasons[row.id] || ""}
                         onChange={(e) => setConfirmReasons((current) => ({ ...current, [row.id]: e.target.value }))} />
                </label>
                <button type="button" className="cashbox-btn is-pos cashbox-wide"
                        disabled={busy || String(confirmReasons[row.id] || "").trim().length < 8}
                        onClick={() => confirm(row)}>
                  {busy ? <Loader2 className="spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                  {copy.confirm}
                </button>
              </div>
            )}

            {/* The office reports; only a verifier confirms. Say so, so the absence is not a puzzle. */}
            {!canConfirm && <p className="debt-muted">{copy.confirmNote}</p>}
          </article>
        );
      })}
    </section>
  );
}
