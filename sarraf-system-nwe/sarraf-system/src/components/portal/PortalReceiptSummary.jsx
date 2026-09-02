import React from "react";
import { CanonicalBatchSummary } from "../receipts/CanonicalBatchSummary";

const STAGE_LABEL = {
  received: "وەرگیرا",
  reading: "دەخوێندرێتەوە",
  needs_review: "پشکنین پێویستە",
  verified: "پشتڕاستکراو",
  matched: "بەستراوەکان",
  archived: "ئەرشیفکراو",
  rejected: "دووبارە",
  created: "ئامادەکردن", uploading: "دەنێردرێت", uploaded: "گەیشت",
  ocr_pending: "چاوەڕوانی خوێندنەوە", ocr_processing: "دەخوێندرێتەوە",
  ocr_failed_retryable: "خوێندنەوە دووبارە دەکرێتەوە", parsed: "خوێندرایەوە",
  needs_manual_review: "لە پشکنینی ئەدمین", currency_mismatch: "دراو یەک ناگرێتەوە",
  duplicate: "دووبارە", tamper_suspected: "پشکنینی زیاتر", validated: "پشتڕاستکرا",
  submitted: "نێردرا", accepted: "پەسەندکرا", finalized: "تەواوکرا",
  forwarded: "نێردرا بۆ وەرگر", delivered: "گەیشت", seen: "بینرا",
};
const STAGE_TONE = {
  received: "slate", reading: "slate", needs_review: "amber",
  verified: "green", matched: "green", archived: "slate", rejected: "red",
  created: "slate", uploading: "slate", uploaded: "slate", ocr_pending: "slate",
  ocr_processing: "slate", ocr_failed_retryable: "amber", parsed: "amber",
  needs_manual_review: "amber", currency_mismatch: "amber", duplicate: "red",
  tamper_suspected: "amber", validated: "green", submitted: "green", accepted: "green",
  finalized: "green", forwarded: "green", delivered: "green", seen: "green",
};

const num0 = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);

/**
 * The uploader's own screen: what they sent, to whom, and what it came to.
 *
 * The owner set the contents of this screen precisely:
 *
 *   "the details the customer-seller needs to see are only: how many receipts went to which
 *    recipient and how much went, the recipient's name, that many receipts and that much yuan,
 *    and at the end the grand total with fee and without fee — and the customer-seller and
 *    every other user must see the history and details of their own receipts, so that they can
 *    see their own archive of what they sent."
 *
 * Two things are deliberately absent. There is no valuation in another currency: what a receipt
 * is worth in dollars is a bookkeeping decision the house has not made at upload time. And when
 * the receipts span more than one currency there is no single headline figure, because there is
 * no such number — a batch holding yuan and dollars used to headline whichever currency came
 * first, which reads as a conversion nobody made.
 *
 * Every figure comes from the server (sarraf_portal_receipt_summary); nothing here is totalled
 * in the browser.
 */
export function PortalReceiptSummary({ summary, data, ui, loadSummary }) {
  const { Card, Empty, Hero, Pill, tr, num } = ui;
  const fmtMoney = ui.fmtMoney;
  const [showAll, setShowAll] = React.useState(false);
  // §4.14: the same canonical read model the administrator sees for a batch, opened here by the
  // person who sent it. One endpoint, one set of figures, no second implementation to disagree.
  const [openBatch, setOpenBatch] = React.useState(null);
  const [batchSummary, setBatchSummary] = React.useState(null);
  const [batchError, setBatchError] = React.useState("");

  const openBatchSummary = async (batchId) => {
    if (openBatch === batchId) { setOpenBatch(null); return; }
    setOpenBatch(batchId); setBatchSummary(null); setBatchError("");
    if (!loadSummary) return;
    try { setBatchSummary(await loadSummary(batchId)); }
    catch (error) { setBatchError(error?.message || "کۆکانە بار نەبوو"); }
  };

  const totals = Array.isArray(summary?.totals) ? summary.totals : [];
  const batches = Array.isArray(summary?.batches) ? summary.batches : [];
  const recipients = Array.isArray(summary?.by_recipient) ? summary.by_recipient : [];
  const receipts = Array.isArray(summary?.receipts) ? summary.receipts : [];

  // The grand total the owner asked for. A database that has not yet been given the newer
  // summary still answers with batch totals, which carry the same three figures under other
  // names, so the screen degrades to the older shape rather than to a blank.
  const grand = Array.isArray(summary?.grand_total) && summary.grand_total.length
    ? summary.grand_total.map((g) => ({
      currency: g.currency, count: num0(g.count),
      withFee: num0(g.with_fee), fee: num0(g.fee), withoutFee: num0(g.without_fee),
    }))
    : totals.map((t) => ({
      currency: t.currency, count: num0(t.accepted_count),
      withFee: num0(t.total_gross), fee: num0(t.total_fee), withoutFee: num0(t.total_net),
    }));

  const soleCur = grand.length === 1 ? grand[0] : null;
  const receiptCount = grand.reduce((n, g) => n + g.count, 0);
  const shown = showAll ? receipts : receipts.slice(0, 20);

  if (!grand.length && !batches.length && !receipts.length) {
    return <Card className="p-2"><Empty t={tr("هیچ فیشێک نییە")} /></Card>;
  }

  return (
    <div className="space-y-3">
      {soleCur && (
        <div className="relative pt-3 pb-1">
          <Hero label={tr("گەیشتوو (بێ فی)")}
            value={fmtMoney(data, soleCur.withoutFee, soleCur.currency)} unit={soleCur.currency}
            sub={`${soleCur.count} ${tr("فیش")}${summary?.rejected_count ? ` · ${summary.rejected_count} ${tr("هەژمار نەکراوە")}` : ""}`} />
        </div>
      )}

      {grand.length > 1 && (
        <div className="pt-3 pb-1">
          <div className="text-[11px] mb-2 px-1" style={{ color: "var(--txt-3)" }}>
            {tr("گەیشتوو (بێ فی)")} · {receiptCount} {tr("فیش")} · {grand.length} {tr("دراو")}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {grand.map((g) => (
              <Card key={g.currency} className="px-3 py-2.5 shrink-0 min-w-[132px]">
                <div className="text-[11px] mb-1" style={{ color: "var(--txt-3)" }}>{g.currency}</div>
                <div className="text-[18px] font-semibold" style={{ ...num, color: "var(--pos)" }}>
                  {fmtMoney(data, g.withoutFee, g.currency)}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* بەپێی وەرگر — چەند فیش بۆ کێ ڕۆیشتووە و چەندی بۆ چووە */}
      {recipients.length > 0 && (
        <Card className="px-4 py-2">
          <div className="pt-3 pb-1 text-[11px] font-semibold" style={{ color: "var(--txt-3)" }}>
            {tr("بەپێی وەرگر")}
          </div>
          {recipients.map((r, i) => (
            <div key={`${r.payee || "?"}-${i}`} className="flex items-start justify-between gap-3 py-3"
              style={i ? { borderTop: "1px solid var(--line)" } : {}}>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold truncate"
                  style={{ color: r.named === false ? "var(--txt-3)" : "var(--txt)" }}>
                  {r.named === false ? tr("ناوی وەرگر لە فیشەکەدا نییە") : r.payee}
                </div>
                <div className="text-[11px] mt-0.5" style={{ ...num, color: "var(--txt-3)" }}>
                  {num0(r.count)} {tr("فیش")}
                </div>
              </div>
              <div className="text-left shrink-0">
                {Object.entries(r.by_currency || {}).map(([c, v]) => (
                  <div key={c} className="text-[14px] font-semibold" style={{ ...num, color: "var(--pos)" }}>
                    {fmtMoney(data, num0(v.without_fee), c)} <span className="text-[10px] font-normal" style={{ color: "var(--txt-3)" }}>{c}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* کۆی گشتی — بە فییەوە و بەبێ فی */}
      {grand.length > 0 && (
        <Card className="px-4 py-2">
          {grand.map((g, i) => (
            <div key={g.currency} className="py-3" style={i ? { borderTop: "1px solid var(--line)" } : {}}>
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-[12px] font-semibold" style={{ color: "var(--txt-2)" }}>{g.currency}</span>
                <span className="text-[11px]" style={{ ...num, color: "var(--txt-3)" }}>{g.count} {tr("فیش")}</span>
              </div>
              <div className="flex justify-between text-[13px] py-1">
                <span style={{ color: "var(--txt-3)" }}>{tr("کۆی گشتی (بە فییەوە)")}</span>
                <span style={{ ...num, color: "var(--txt-2)" }}>{fmtMoney(data, g.withFee, g.currency)}</span>
              </div>
              <div className="flex justify-between text-[13px] py-1">
                <span style={{ color: "var(--txt-3)" }}>{tr("فی")}</span>
                <span style={{ ...num, color: g.fee ? "var(--neg)" : "var(--txt-3)" }}>
                  {g.fee ? "−" + fmtMoney(data, g.fee, g.currency) : fmtMoney(data, 0, g.currency)}
                </span>
              </div>
              <div className="flex justify-between items-baseline pt-2.5 mt-1" style={{ borderTop: "1px solid var(--line)" }}>
                <span className="text-[13px] font-semibold" style={{ color: "var(--txt)" }}>{tr("کۆی گشتی (بەبێ فی)")}</span>
                <span className="text-[20px] font-semibold" style={{ ...num, color: "var(--pos)" }}>{fmtMoney(data, g.withoutFee, g.currency)}</span>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* ئەرشیفی خۆم — چیم ناردووە و وردەکاری هەر فیشێک */}
      {receipts.length > 0 && (
        <Card className="px-4 py-2">
          <div className="pt-3 pb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold" style={{ color: "var(--txt-3)" }}>{tr("مێژووی فیشەکانم")}</span>
            <span className="text-[11px]" style={{ ...num, color: "var(--txt-3)" }}>{receipts.length}</span>
          </div>
          {shown.map((r, i) => {
            const counted = r.counted !== false && r.status !== "dup" && r.status !== "error";
            return (
              <div key={r.id || i} className="py-3" style={i ? { borderTop: "1px solid var(--line)" } : {}}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate" style={{ color: "var(--txt)" }}>
                      {r.payee || tr("ناوی وەرگر لە فیشەکەدا نییە")}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ ...num, color: "var(--txt-3)" }}>
                      {(r.tx_date || r.created_at || "").slice(0, 10)}
                      {r.tx_time ? ` · ${String(r.tx_time).slice(0, 5)}` : ""}
                      {r.ref_no ? ` · ${r.ref_no}` : ""}
                      {r.platform || r.bank ? ` · ${r.platform || r.bank}` : ""}
                    </div>
                  </div>
                  <div className="text-left shrink-0">
                    <div className="text-[15px] font-semibold"
                      style={{ ...num, color: counted ? "var(--pos)" : "var(--txt-3)" }}>
                      {r.currency
                        ? fmtMoney(data, num0(r.net_amount ?? (num0(r.amount) - num0(r.fee))), r.currency)
                        : "—"}
                      {r.currency && <span className="text-[10px] font-normal" style={{ color: "var(--txt-3)" }}> {r.currency}</span>}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ ...num, color: "var(--txt-3)" }}>
                      {r.currency ? `${fmtMoney(data, num0(r.amount), r.currency)} − ${fmtMoney(data, num0(r.fee), r.currency)} ${tr("فی")}` : tr("دراوەکە نەخوێندراوەتەوە")}
                    </div>
                  </div>
                </div>
                {!counted && (
                  <div className="mt-1.5"><Pill tone="red">{tr("هەژمار نەکراوە")}</Pill></div>
                )}
              </div>
            );
          })}
          {receipts.length > shown.length && (
            <button onClick={() => setShowAll(true)} className="w-full py-3 text-[12px] font-semibold tap"
              style={{ color: "var(--ac)", borderTop: "1px solid var(--line)" }}>
              {tr("زیاتر")}
            </button>
          )}
        </Card>
      )}

      {batches.length > 0 && (
        <Card className="px-4 py-2">
          <div className="pt-3 pb-1 text-[11px] font-semibold" style={{ color: "var(--txt-3)" }}>
            {tr("ناردنەکان")}
          </div>
          {batches.map((b, i) => (
            <div key={b.id} style={i ? { borderTop: "1px solid var(--line)" } : {}}>
              <button type="button" onClick={() => openBatchSummary(b.id)}
                className="w-full flex items-center justify-between gap-3 py-3 text-right tap"
                aria-expanded={openBatch === b.id}>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold" style={{ ...num, color: "var(--txt)" }}>
                    {fmtMoney(data, b.total_net, b.currency)} <span className="text-[11px]" style={{ color: "var(--txt-3)" }}>{b.currency}</span>
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: "var(--txt-3)" }}>
                    {b.n || 0} {tr("فیش")}{b.rejected_n ? ` · ${b.rejected_n} ${tr("هەژمار نەکراوە")}` : ""} · {b.created_at ? new Date(b.created_at).toLocaleDateString("en-GB") : "—"}
                  </div>
                </div>
                <Pill tone={STAGE_TONE[b.receipt_stage] || "slate"}>{tr(STAGE_LABEL[b.receipt_stage] || b.receipt_stage || "—")}</Pill>
              </button>
              {openBatch === b.id && (
                <div className="pb-3">
                  {batchError
                    ? <div className="text-[12px]" style={{ color: "var(--neg)" }}>{batchError}</div>
                    : batchSummary
                      // The uploader is shown the native figures only; §4 keeps the valuation
                      // for the operator's own screen until the transaction has been made.
                      ? <CanonicalBatchSummary summary={batchSummary} ui={ui} showUsd={false} />
                      : <div className="text-[12px]" style={{ color: "var(--txt-3)" }}>{tr("بارکردن…")}</div>}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
