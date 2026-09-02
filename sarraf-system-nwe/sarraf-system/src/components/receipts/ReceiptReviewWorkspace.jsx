import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, History,
  Loader2, Minus, RefreshCw, XCircle, ZoomIn,
} from "lucide-react";
import {
  correctExtraction, diffVersions, enterReadingByHand, loadDocumentDetail, loadReplacementChain,
  loadReviewQueue, finalizeReceipt, loadReceiptSummary, reviewEquation, reviewTotals,
  setReceiptDailyRate, transitionDocument,
} from "../../services/receiptWorkspace";
import "./receipt-review.css";
import { errorText } from "../../services/userFacingError";

const COPY = {
  ku: {
    title: "شوێنی پشکنینی فیش", subtitle: "وێنەی ڕەسەن و ئەوەی OCR خوێندوویەتی، تەنیشت یەک",
    queue: "ڕیزی چاوەڕوان", empty: "هیچ فیشێک چاوەڕوانی پشکنین نییە", loading: "بارکردن…",
    refresh: "نوێکردنەوە", prev: "پێشوو", next: "دواتر",
    original: "خوێندنەوەی ڕەسەن", current: "دوایین وەشان", version: "وەشان",
    equation: "پشکنینی ژمارەکان", reconciles: "ژمارەکان یەک دەگرنەوە", mismatch: "ژمارەکان یەک ناگرنەوە",
    reconcilesByNet: "فی لە بڕەکە کەم کراوەتەوە و ژمارەکان یەک دەگرنەوە",
    mismatchByNet: "کۆی گشتی کە فی لێ کەم بکرێتەوە، ئەوەی نووسراوە نادات",
    undecidable: "ناتوانرێت بڕیار بدرێت — فیشەکە بڕی بنەڕەتی نەنووسیوە",
    gross: "کۆی گشتی", order: "بڕی بنەڕەتی", fee: "فی", net: "نەت", expected: "پێویستە بێت", inUsd: "بە USD",
    treatment: "شێوازی فی", currency: "دراو", ref: "ژمارەی مامەڵە", payee: "وەرگر",
    accept: "پەسەندکردن", acceptReason: "هۆکاری پەسەندکردن (لانیکەم ٨ پیت)",
    reject: "ڕەتکردنەوە", review: "بۆ پشکنینی دەستی",
    rejectReason: "هۆکاری ڕەتکردنەوە (لانیکەم ٨ پیت)",
    correct: "ڕاستکردنەوە", correctReason: "هۆکاری ڕاستکردنەوە (لانیکەم ٨ پیت)",
    save: "پاشەکەوت", cancel: "پاشگەزبوونەوە", working: "جێبەجێکردن…",
    history: "مێژووی قۆناغەکان", changes: "گۆڕانکارییەکان", before: "پێشتر", after: "ئێستا",
    totals: "کۆی کۆمەڵە", accepted: "پەسەندکراو", pending: "چاوەڕوان", rejected: "ڕەتکراو", duplicate: "دووبارە",
    noImage: "وێنە بەردەست نییە", zoomOut: "بچووککردنەوە", zoomIn: "گەورەکردن", reset: "گەڕاندنەوە",
    immutable: "خوێندنەوەی ڕەسەن هەرگیز ناگۆڕدرێت — ڕاستکردنەوە وەشانێکی نوێ دروست دەکات",
    valuation: "جێگیرکردنی نرخی USD", businessDate: "بەرواری کاری مامەڵە",
    convention: "یاسای نرخ", availableRate: "نرخی بەردەست", noRate: "نرخی ئەم ڕۆژە هێشتا دانەنراوە",
    rateValue: "چەند یەکەی ئەم دراوە = 1 USD", rateReason: "هۆکاری دانانی نرخ (لانیکەم ٨ پیت)",
    setRate: "دانانی وەشانی نوێی نرخ", finalReason: "هۆکاری جێگیرکردن (لانیکەم ٨ پیت)",
    finalize: "جێگیرکردن و ئامادەکردن بۆ ناردن", mfa: "ئەم هەنگاوە MFA ـی ئەدمین پێویستە",
    frozen: "نرخ لەسەر خودی فیشەکە جێگیر دەکرێت و دوای ئەوە ناگۆڕدرێت",
    code: "کۆدی فیش", copied: "کۆپی کرا",
    unread: "خوێنەرەکە ئەم فیشەی نەخوێندەوە",
    unreadNote: "دەتوانیت خۆت ئەوەی لەسەر وێنەکەیە بنووسیت. هەمان مەرجی خوێندنەوەی ئۆتۆماتیکی بەسەریدا دەسەپێت، و ناوی تۆ لەسەری تۆمار دەکرێت.",
    enter: "نووسینی خوێندنەوە بە دەست", enterReason: "هۆکاری نووسین بە دەست (لانیکەم ٨ پیت)",
    platform: "پلاتفۆرم", txDate: "بەرواری فیش", txTime: "کاتی فیش",
    replacesTitle: "ئەم فیشە جێگرەوەیە",
    replacesBody: (code) => `لە جێگەی ${code} نێردراوە، کە پێشتر ڕەت کرابووەوە.`,
    replacesWhy: "هۆکاری ڕەتکردنەوەی پێشوو",
    replacedTitle: "ئەم فیشە گۆڕدراوە",
    replacedBody: (code) => `${code} لە جێگەی ئەمە نێردراوە.`,
    treatments: {
      added_on_top: "لەسەر زیادکراوە", deducted_from_principal: "لە بڕی سەرەکی لابراوە",
      included_in_total: "لە کۆدا تێکەڵە", no_fee: "فی نییە", unknown: "نادیار",
    },
  },
  en: {
    title: "Reviewing a receipt", subtitle: "The original image and what the reader made of it, side by side",
    queue: "Waiting", empty: "No receipt is waiting to be reviewed", loading: "Loading…",
    refresh: "Refresh", prev: "Previous", next: "Next",
    original: "The original reading", current: "Latest version", version: "Version",
    equation: "Do the numbers agree", reconciles: "The numbers agree", mismatch: "The numbers do not agree",
    reconcilesByNet: "The fee was taken out of the amount, and the numbers agree",
    mismatchByNet: "The total less the fee does not give what is written",
    undecidable: "Cannot be decided — the receipt does not state an order amount",
    gross: "Total", order: "Order amount", fee: "Fee", net: "Net", expected: "Should be", inUsd: "In USD",
    treatment: "How the fee was taken", currency: "Currency", ref: "Transaction number", payee: "Paid to",
    accept: "Accept", acceptReason: "Why it is accepted (at least 8 characters)",
    reject: "Reject", review: "Send for review by hand",
    rejectReason: "Why it is rejected (at least 8 characters)",
    correct: "Correct it", correctReason: "Why it is corrected (at least 8 characters)",
    save: "Save", cancel: "Cancel", working: "Working…",
    history: "What has happened to it", changes: "What changed", before: "Was", after: "Now",
    totals: "The batch", accepted: "Accepted", pending: "Waiting", rejected: "Rejected", duplicate: "Duplicate",
    noImage: "No image available", zoomOut: "Smaller", zoomIn: "Larger", reset: "Reset",
    immutable: "The original reading is never changed — a correction makes a new version",
    valuation: "Fixing the USD rate", businessDate: "Business date of the transaction",
    convention: "Rate convention", availableRate: "Rate available", noRate: "No rate has been set for this day yet",
    rateValue: "How many of this currency = 1 USD", rateReason: "Why this rate (at least 8 characters)",
    setRate: "Set a new version of the rate", finalReason: "Why it is being fixed (at least 8 characters)",
    finalize: "Fix it and make it ready to send", mfa: "This step needs the administrator's second factor",
    frozen: "The rate is fixed onto the receipt itself and does not change afterwards",
    code: "Receipt code", copied: "Copied",
    unread: "The reader could not read this receipt",
    unreadNote: "You can write down what is on the image yourself. The same rules the automatic reading obeys apply to it, and your name is recorded on it.",
    enter: "Enter the reading by hand", enterReason: "Why it is entered by hand (at least 8 characters)",
    platform: "Platform", txDate: "Receipt date", txTime: "Receipt time",
    replacesTitle: "This receipt is a replacement",
    replacesBody: (code) => `Sent in place of ${code}, which was rejected.`,
    replacesWhy: "Why the earlier one was rejected",
    replacedTitle: "This receipt was replaced",
    replacedBody: (code) => `${code} was sent in its place.`,
    treatments: {
      added_on_top: "Added on top", deducted_from_principal: "Taken from the principal",
      included_in_total: "Included in the total", no_fee: "No fee", unknown: "Not known",
    },
  },
  ar: {
    title: "مراجعة إيصال", subtitle: "الصورة الأصلية وما قرأه النظام منها، جنبًا إلى جنب",
    queue: "في الانتظار", empty: "لا يوجد إيصال ينتظر المراجعة", loading: "جارٍ التحميل…",
    refresh: "تحديث", prev: "السابق", next: "التالي",
    original: "القراءة الأصلية", current: "أحدث نسخة", version: "نسخة",
    equation: "هل تتطابق الأرقام", reconciles: "الأرقام متطابقة", mismatch: "الأرقام غير متطابقة",
    reconcilesByNet: "خُصمت الرسوم من المبلغ، والأرقام متطابقة",
    mismatchByNet: "الإجمالي ناقص الرسوم لا يعطي المكتوب",
    undecidable: "لا يمكن الحسم — الإيصال لا يذكر مبلغ الطلب",
    gross: "الإجمالي", order: "مبلغ الطلب", fee: "الرسوم", net: "الصافي", expected: "يجب أن يكون", inUsd: "بالدولار",
    treatment: "كيف أُخذت الرسوم", currency: "العملة", ref: "رقم المعاملة", payee: "دُفع إلى",
    accept: "قبول", acceptReason: "سبب القبول (٨ أحرف على الأقل)",
    reject: "رفض", review: "إرسال للمراجعة اليدوية",
    rejectReason: "سبب الرفض (٨ أحرف على الأقل)",
    correct: "تصحيح", correctReason: "سبب التصحيح (٨ أحرف على الأقل)",
    save: "حفظ", cancel: "إلغاء", working: "جارٍ التنفيذ…",
    history: "ما جرى له", changes: "ما تغيّر", before: "كان", after: "الآن",
    totals: "الدفعة", accepted: "مقبول", pending: "في الانتظار", rejected: "مرفوض", duplicate: "مكرر",
    noImage: "لا توجد صورة", zoomOut: "تصغير", zoomIn: "تكبير", reset: "إعادة",
    immutable: "القراءة الأصلية لا تتغير أبدًا — التصحيح يُنشئ نسخة جديدة",
    valuation: "تثبيت سعر الدولار", businessDate: "تاريخ المعاملة",
    convention: "قاعدة السعر", availableRate: "السعر المتاح", noRate: "لم يُحدَّد سعر لهذا اليوم بعد",
    rateValue: "كم وحدة من هذه العملة = ١ دولار", rateReason: "سبب هذا السعر (٨ أحرف على الأقل)",
    setRate: "تعيين نسخة جديدة من السعر", finalReason: "سبب التثبيت (٨ أحرف على الأقل)",
    finalize: "ثبّته وجهّزه للإرسال", mfa: "هذه الخطوة تتطلب العامل الثاني للمشرف",
    frozen: "يُثبَّت السعر على الإيصال نفسه ولا يتغير بعدها",
    code: "رمز الإيصال", copied: "نُسخ",
    unread: "تعذّر على النظام قراءة هذا الإيصال",
    unreadNote: "يمكنك كتابة ما في الصورة بنفسك. تنطبق عليها القواعد نفسها التي تخضع لها القراءة الآلية، ويُسجَّل اسمك عليها.",
    enter: "إدخال القراءة يدويًا", enterReason: "سبب الإدخال اليدوي (٨ أحرف على الأقل)",
    platform: "المنصة", txDate: "تاريخ الإيصال", txTime: "وقت الإيصال",
    replacesTitle: "هذا الإيصال بديل",
    replacesBody: (code) => `أُرسل بدل ${code} الذي رُفض.`,
    replacesWhy: "سبب رفض السابق",
    replacedTitle: "هذا الإيصال استُبدل",
    replacedBody: (code) => `أُرسل ${code} بدلًا عنه.`,
    treatments: {
      added_on_top: "أُضيفت فوقه", deducted_from_principal: "خُصمت من الأصل",
      included_in_total: "مشمولة في الإجمالي", no_fee: "بلا رسوم", unknown: "غير معروف",
    },
  },
};
const money = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function Field({ label, value, suffix }) {
  return (
    <div className="rrw-field">
      <span className="rrw-field-label">{label}</span>
      <span className="rrw-field-value">{value ?? "—"}{suffix ? ` ${suffix}` : ""}</span>
    </div>
  );
}

export function ReceiptReviewWorkspace({ client, lang = "ku", signedUrlFor = null, flash = () => {} }) {
  const copy = COPY[lang] || COPY.ku;
  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState(null);
  const [chain, setChain] = useState(null);
  const [state, setState] = useState("loading");
  const [zoom, setZoom] = useState(1);
  const [imageUrl, setImageUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [acceptText, setAcceptText] = useState("");
  const [rejectText, setRejectText] = useState("");
  const [editing, setEditing] = useState(null);
  // Writing down what the reader could not. Separate from `editing`, which corrects a reading
  // that exists; these are two different acts and the database refuses to confuse them.
  const [handEntry, setHandEntry] = useState(null);
  const [handReason, setHandReason] = useState("");
  const [correctReason, setCorrectReason] = useState("");
  const [rateValue, setRateValue] = useState("");
  const [rateReason, setRateReason] = useState("");
  const [finalReason, setFinalReason] = useState("");
  const flashRef = useRef(flash);
  flashRef.current = flash;

  const loadQueue = useCallback(async () => {
    setState("loading");
    try {
      const rows = await loadReviewQueue(client);
      setQueue(rows);
      setIndex((i) => Math.min(i, Math.max(0, rows.length - 1)));
      setState("ready");
    } catch (e) { console.error("review queue", e); flashRef.current(errorText(e)); setState("error"); }
  }, [client]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const currentDoc = queue[index] || null;

  useEffect(() => {
    let alive = true;
    setDetail(null); setChain(null); setImageUrl(null); setZoom(1); setEditing(null); setAcceptText(""); setRejectText("");
    setHandEntry(null); setHandReason("");
    setRateValue(""); setRateReason(""); setFinalReason("");
    if (!currentDoc) return;
    (async () => {
      try {
        const d = await loadDocumentDetail(client, currentDoc.id);
        if (!alive) return;
        setDetail(d);
        setRateValue(d.summary?.availableRateValue == null ? "" : String(d.summary.availableRateValue));
        // Best effort, and deliberately not awaited into the same failure: a reviewer who cannot
        // be told the history must still be able to review the receipt in front of them.
        loadReplacementChain(client, d.document)
          .then((c) => { if (alive) setChain(c); })
          .catch((e) => console.error("replacement chain", e));
        if (signedUrlFor && d.document.storagePath) {
          const url = await signedUrlFor(d.document.storagePath);
          if (alive) setImageUrl(url);
        }
      } catch (e) { if (alive) { console.error("review detail", e); flashRef.current(errorText(e)); } }
    })();
    return () => { alive = false; };
  }, [client, currentDoc, signedUrlFor]);

  const equation = useMemo(() => reviewEquation(detail?.current), [detail]);
  const changes = useMemo(
    () => (detail && detail.original !== detail.current ? diffVersions(detail.original, detail.current) : []),
    [detail]
  );
  const totals = useMemo(() => reviewTotals(queue), [queue]);
  const isAccepted = currentDoc?.state === "accepted";
  const receiptCurrency = detail?.summary?.currency || currentDoc?.expectedCurrency || "";
  const rateReady = Number(detail?.summary?.availableRateValue) > 0;

  const act = async (fn, message, { reloadQueue = true } = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await fn();
      flashRef.current(typeof message === "function" ? message(result) : message);
      if (reloadQueue) { await loadQueue(); setDetail(null); }
    }
    catch (e) { console.error("review action", e); flashRef.current(errorText(e)); }
    finally { setBusy(false); }
  };

  const accept = () => act(
    () => transitionDocument(client, {
      documentId: currentDoc.id,
      toState: "accepted",
      reason: acceptText,
    }), "✓");
  const reject = () => act(
    () => transitionDocument(client, { documentId: currentDoc.id, toState: "rejected", reason: rejectText }), "✓");
  const HAND_FIELDS = ["grossAmount", "orderAmount", "feeAmount", "netAmount", "currency",
                       "refNo", "payee", "platform", "txDate", "txTime"];
  const saveHandEntry = () => act(async () => {
    const reading = {};
    for (const key of HAND_FIELDS) {
      const value = String(handEntry?.[key] ?? "").trim();
      if (!value) continue;
      reading[key] = ["grossAmount", "orderAmount", "feeAmount", "netAmount"].includes(key)
        ? Number(value) : value;
    }
    return enterReadingByHand(client, {
      documentId: currentDoc.id, reading, reason: handReason,
    });
  }, "✓");

  const saveCorrection = () => act(async () => {
    const changed = {};
    for (const [k, v] of Object.entries(editing || {})) {
      const base = detail.current?.[k];
      const next = ["grossAmount", "orderAmount", "feeAmount", "netAmount"].includes(k)
        ? (v === "" ? null : Number(v)) : v;
      if (String(next ?? "") !== String(base ?? "")) changed[k] = next;
    }
    await correctExtraction(client, {
      documentId: currentDoc.id, base: detail.current, changes: changed,
      reason: correctReason,
    });
  }, "✓");

  const saveRate = () => act(async () => {
    await setReceiptDailyRate(client, {
      currency: detail.summary?.currency || currentDoc.expectedCurrency,
      effectiveDate: detail.summary?.businessDate,
      rate: rateValue,
      reason: rateReason,
    });
    const refreshed = await loadDocumentDetail(client, currentDoc.id);
    setDetail(refreshed);
    setRateValue(refreshed.summary?.availableRateValue == null ? "" : String(refreshed.summary.availableRateValue));
    setRateReason("");
  }, "✓", { reloadQueue: false });

  const finalize = () => act(async () => {
    const result = await finalizeReceipt(client, { documentId: currentDoc.id, reason: finalReason });
    if (result?.valuation_status !== "valued") throw new Error(copy.noRate);
    return loadReceiptSummary(client, currentDoc.id);
  }, (summary) => summary?.netUsd == null ? "✓" : `✓ ${copy.net} ${copy.inUsd}: $${money(summary.netUsd)}`);

  if (state === "loading") return <div className="rrw"><div className="rrw-empty">{copy.loading}</div></div>;

  return (
    <section className="rrw" aria-labelledby="rrw-title">
      <header className="rrw-header">
        <div>
          <h2 id="rrw-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="rrw-btn" onClick={loadQueue}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      <div className="rrw-totals" role="status">
        <span><b>{totals.accepted}</b> {copy.accepted}</span>
        <span><b>{totals.pending}</b> {copy.pending}</span>
        <span><b>{totals.rejected}</b> {copy.rejected}</span>
        <span><b>{totals.duplicate}</b> {copy.duplicate}</span>
      </div>

      {queue.length === 0 ? <p className="rrw-empty">{copy.empty}</p> : (
        <>
          <nav className="rrw-nav" aria-label={copy.queue}>
            <button type="button" className="rrw-btn" disabled={index === 0}
                    onClick={() => setIndex((i) => i - 1)}><ArrowRight aria-hidden="true" /> {copy.prev}</button>
            <span className="rrw-counter">{index + 1} / {queue.length}</span>
            <button type="button" className="rrw-btn" disabled={index >= queue.length - 1}
                    onClick={() => setIndex((i) => i + 1)}>{copy.next} <ArrowLeft aria-hidden="true" /></button>
          </nav>

          <div className="rrw-split">
            {/* Left: the original evidence, always visible beside the numbers. */}
            <section className="rrw-image" aria-label={copy.original}>
              <div className="rrw-zoom" dir="ltr">
                <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                        aria-label={copy.zoomOut}><Minus aria-hidden="true" /></button>
                <button type="button" onClick={() => setZoom(1)} aria-label={copy.reset}>{Math.round(zoom * 100)}%</button>
                <button type="button" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
                        aria-label={copy.zoomIn}><ZoomIn aria-hidden="true" /></button>
              </div>
              <div className="rrw-image-frame" tabIndex={0}>
                {imageUrl
                  ? <img src={imageUrl} alt={copy.original} style={{ transform: `scale(${zoom})` }} />
                  : <div className="rrw-empty">{copy.noImage}</div>}
              </div>
            </section>

            <section className="rrw-detail" aria-label={copy.current}>
              {!detail ? <div className="rrw-empty">{copy.loading}</div> : (
                <>
                  {/* The name of the thing being looked at. Two people on a phone need one word
                      for it, and until today the only one was a random fourteen characters. */}
                  {detail.document?.trackingCode && (
                    <div className="rrw-code" dir="ltr">
                      <span className="rrw-code-label">{copy.code}</span>
                      <code>{detail.document.trackingCode}</code>
                    </div>
                  )}

                  {/* Why this receipt exists. Without it a replacement reads as a second claim
                      on money that was already refused once. */}
                  {chain?.replaces && (
                    <div className="rrw-chain">
                      <History aria-hidden="true" />
                      <div>
                        <b>{copy.replacesTitle}</b>
                        <p dir="auto">{copy.replacesBody(chain.replaces.trackingCode || chain.replaces.id)}</p>
                        {chain.replaces.ruleReason && (
                          <p className="rrw-chain-why" dir="auto">
                            {copy.replacesWhy}: {chain.replaces.ruleReason}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  {chain?.replacedBy && (
                    <div className="rrw-chain is-closed">
                      <History aria-hidden="true" />
                      <div>
                        <b>{copy.replacedTitle}</b>
                        <p dir="auto">{copy.replacedBody(chain.replacedBy.trackingCode || chain.replacedBy.id)}</p>
                      </div>
                    </div>
                  )}

                  {/* The arithmetic verdict, stated rather than left for the reviewer to compute. */}
                  {equation && (
                    <div className={`rrw-equation ${equation.reconciles === true ? "is-ok"
                      : equation.reconciles === false ? "is-bad" : "is-unknown"}`}>
                      {equation.reconciles === true ? <CheckCircle2 aria-hidden="true" />
                        : <AlertTriangle aria-hidden="true" />}
                      <span>
                        {equation.reconciles === true
                          ? (equation.basis === "net" ? copy.reconcilesByNet : copy.reconciles)
                          : equation.reconciles === false
                            ? (equation.basis === "net" ? copy.mismatchByNet : copy.mismatch)
                            : copy.undecidable}
                        {equation.expectedGross != null && equation.reconciles === false && (
                          <> — {copy.expected} {money(equation.expectedGross)}</>
                        )}
                      </span>
                    </div>
                  )}

                  <div className="rrw-fields">
                    <Field label={copy.gross} value={money(detail.current?.grossAmount)} suffix={detail.current?.currency} />
                    <Field label={copy.order} value={money(detail.current?.orderAmount)} suffix={detail.current?.currency} />
                    <Field label={copy.fee} value={money(detail.current?.feeAmount)} suffix={detail.current?.currency} />
                    <Field label={copy.net} value={money(detail.current?.netAmount)} suffix={detail.current?.currency} />
                    <Field label={copy.treatment} value={copy.treatments[detail.current?.feeTreatment] || detail.current?.feeTreatment} />
                    <Field label={copy.currency} value={detail.current?.currency} />
                    <Field label={copy.ref} value={detail.current?.refNo} />
                    <Field label={copy.payee} value={detail.current?.payee} />
                  </div>

                  {/* A correction never overwrites: show what changed from the original reading. */}
                  {changes.length > 0 && (
                    <div className="rrw-changes">
                      <h3><History aria-hidden="true" /> {copy.changes}</h3>
                      {changes.map((c) => (
                        <div key={c.field} className="rrw-change">
                          <span>{c.label}</span>
                          <span className="rrw-before">{String(c.before ?? "—")}</span>
                          <span>→</span>
                          <span className="rrw-after">{String(c.after ?? "—")}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="rrw-note">{copy.immutable}</p>

                  {isAccepted ? (
                    <div className="rrw-valuation">
                      <div className="rrw-valuation-head">
                        <h3>{copy.valuation}</h3>
                        <span>{copy.mfa}</span>
                      </div>
                      <div className="rrw-fields">
                        <Field label={copy.businessDate} value={detail.summary?.businessDate} />
                        <Field label={copy.convention} value="1 USD = X currency" />
                        <Field
                          label={copy.availableRate}
                          value={rateReady ? `1 USD = ${detail.summary.availableRateValue} ${receiptCurrency}` : copy.noRate}
                        />
                      </div>
                      {receiptCurrency !== "USD" && (
                        <div className="rrw-edit">
                          <label>
                            {copy.rateValue}
                            <input type="number" min="0" step="any" inputMode="decimal" value={rateValue}
                                   onChange={(e) => setRateValue(e.target.value)} />
                          </label>
                          <label className="rrw-wide">
                            {copy.rateReason}
                            <input value={rateReason} onChange={(e) => setRateReason(e.target.value)} />
                          </label>
                          <div className="rrw-actions">
                            <button type="button" className="rrw-btn"
                                    disabled={busy || !(Number(rateValue) > 0) || rateReason.trim().length < 8
                                      || !detail.summary?.businessDate}
                                    onClick={saveRate}>
                              {busy ? <Loader2 className="rrw-spin" aria-hidden="true" /> : null} {copy.setRate}
                            </button>
                          </div>
                        </div>
                      )}
                      {!rateReady && <p className="rrw-rate-warning"><AlertTriangle aria-hidden="true" /> {copy.noRate}</p>}
                      <div className="rrw-reject">
                        <input placeholder={copy.finalReason} value={finalReason}
                               onChange={(e) => setFinalReason(e.target.value)} />
                        <button type="button" className="rrw-btn is-pos"
                                disabled={busy || !rateReady || finalReason.trim().length < 8} onClick={finalize}>
                          {busy ? <Loader2 className="rrw-spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                          {copy.finalize}
                        </button>
                      </div>
                      <p className="rrw-note">{copy.frozen}</p>
                    </div>
                  ) : editing ? (
                    <div className="rrw-edit">
                      {["grossAmount", "orderAmount", "feeAmount", "netAmount", "currency", "refNo", "payee"].map((k) => (
                        <label key={k}>
                          {copy[{ grossAmount: "gross", orderAmount: "order", feeAmount: "fee",
                                  netAmount: "net", currency: "currency", refNo: "ref", payee: "payee" }[k]]}
                          <input value={editing[k] ?? ""} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
                        </label>
                      ))}
                      <label className="rrw-wide">
                        {copy.correctReason}
                        <input value={correctReason} onChange={(e) => setCorrectReason(e.target.value)} />
                      </label>
                      <div className="rrw-actions">
                        <button type="button" className="rrw-btn is-pos"
                                disabled={busy || correctReason.trim().length < 8} onClick={saveCorrection}>
                          {busy ? <Loader2 className="rrw-spin" aria-hidden="true" /> : null} {copy.save}
                        </button>
                        <button type="button" className="rrw-btn" onClick={() => setEditing(null)}>{copy.cancel}</button>
                      </div>
                    </div>
                  ) : handEntry ? (
                    <div className="rrw-edit">
                      {HAND_FIELDS.map((k) => (
                        <label key={k}>
                          {copy[{ grossAmount: "gross", orderAmount: "order", feeAmount: "fee",
                                  netAmount: "net", currency: "currency", refNo: "ref", payee: "payee",
                                  platform: "platform", txDate: "txDate", txTime: "txTime" }[k]]}
                          <input value={handEntry[k] ?? ""} inputMode={
                            ["grossAmount", "orderAmount", "feeAmount", "netAmount"].includes(k) ? "decimal" : undefined}
                            onChange={(e) => setHandEntry({ ...handEntry, [k]: e.target.value })} />
                        </label>
                      ))}
                      <label className="rrw-wide">
                        {copy.enterReason}
                        <input value={handReason} onChange={(e) => setHandReason(e.target.value)} />
                      </label>
                      <div className="rrw-actions">
                        <button type="button" className="rrw-btn is-pos"
                                disabled={busy || handReason.trim().length < 8} onClick={saveHandEntry}>
                          {busy ? <Loader2 className="rrw-spin" aria-hidden="true" /> : null} {copy.save}
                        </button>
                        <button type="button" className="rrw-btn" onClick={() => setHandEntry(null)}>{copy.cancel}</button>
                      </div>
                    </div>
                  ) : !detail.current ? (
                    // Nothing was ever read. Before today this was the end of the road: nothing to
                    // correct because nothing exists, nothing to accept for the same reason, and
                    // the only move left was to reject a receipt for real money.
                    <div className="rrw-chain">
                      <AlertTriangle aria-hidden="true" />
                      <div>
                        <b>{copy.unread}</b>
                        <p>{copy.unreadNote}</p>
                        <div className="rrw-actions">
                          <button type="button" className="rrw-btn is-pos"
                                  onClick={() => setHandEntry({ currency: currentDoc?.expectedCurrency || "" })}>
                            {copy.enter}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="rrw-reject">
                        <input placeholder={copy.acceptReason} value={acceptText}
                               onChange={(e) => setAcceptText(e.target.value)} />
                        <button type="button" className="rrw-btn is-pos"
                                disabled={busy || acceptText.trim().length < 8} onClick={accept}>
                          <CheckCircle2 aria-hidden="true" /> {copy.accept}
                        </button>
                      </div>
                      <div className="rrw-actions">
                        <button type="button" className="rrw-btn"
                                onClick={() => setEditing({ ...detail.current })}>{copy.correct}</button>
                      </div>
                    </div>
                  )}

                  <div className="rrw-reject">
                    <input placeholder={copy.rejectReason} value={rejectText}
                           onChange={(e) => setRejectText(e.target.value)} />
                    <button type="button" className="rrw-btn is-neg"
                            disabled={busy || rejectText.trim().length < 8} onClick={reject}>
                      <XCircle aria-hidden="true" /> {copy.reject}
                    </button>
                  </div>

                  {detail.history?.length > 0 && (
                    <div className="rrw-history">
                      <h3>{copy.history}</h3>
                      <ol>
                        {detail.history.map((h, i) => (
                          <li key={i}>
                            <span>{h.from || "—"} → <b>{h.to}</b></span>
                            <time>{h.at ? new Date(h.at).toLocaleString("en-GB") : ""}</time>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
