import React from "react";
import { receiptOutcome, mayBeReplaced } from "../../services/receiptIntake";

/**
 * «هەر بەکارهێنەرێک مێژوو و وردەکاری فیشەکانی خۆی ببینێت»
 *
 * Every receipt this person has sent, by name, with what became of it — and, on the ones that
 * were refused, the way back out: بارکردنەوەی فیشی نوێ.
 *
 * The four outcomes are the ones the owner specified. Three of them are the receipt's own state;
 * the fourth, REPLACED, is not stored anywhere and is not allowed to be: it is what a refused
 * receipt becomes the moment something is sent in its place, read from the link itself so that a
 * screen and the database can never disagree about it.
 *
 * The reason a receipt was refused is shown in full. A refusal that says only "ڕەتکرایەوە" tells
 * the person nothing they can act on, and the whole point of the re-upload button is that they
 * can act on it.
 */

const OUTCOME = {
  pending: { label: "چاوەڕوانی پشکنین", tone: "amber" },
  approved: { label: "پەسەند کرا", tone: "green" },
  rejected: { label: "ڕەت کرایەوە", tone: "red" },
  replaced: { label: "گۆڕدرا", tone: "slate" },
};

const when = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-GB");
};

export function MyReceipts({ receipts, loading, error, onReload, onReplace, ui }) {
  const { Card, Pill, Empty, StatePanel, tr } = ui;
  const [busy, setBusy] = React.useState(null);
  const [failed, setFailed] = React.useState("");
  const inputs = React.useRef({});

  const pick = (id) => inputs.current[id]?.click();

  const chosen = async (receipt, file) => {
    if (!file) return;
    setFailed("");
    setBusy(receipt.id);
    try {
      await onReplace(receipt, file);
      await onReload?.();
    } catch (e) {
      setFailed(e?.message || tr("بارکردنەوەی فیشی نوێ سەرکەوتوو نەبوو"));
    } finally {
      setBusy(null);
      // Let the same file be chosen again after a failure; a file input keeps its value.
      if (inputs.current[receipt.id]) inputs.current[receipt.id].value = "";
    }
  };

  if (loading && !receipts) return <Card><StatePanel type="loading" title={tr("بارکردن...")} compact /></Card>;

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-bold">{tr("فیشەکانی من")}</div>
            <div className="text-[11px] text-[var(--txt-3)] mt-0.5">
              {tr("هەر فیشێک کۆدی تایبەتی خۆی هەیە — بۆ پرسیارکردن ئەو کۆدە بڵێ")}
            </div>
          </div>
          <button onClick={() => onReload?.()} className="text-[11px] underline text-[var(--txt-2)] tap">
            {tr("نوێکردنەوە")}
          </button>
        </div>
      </Card>

      {error && <Card className="p-3 text-[12px]" style={{ color: "var(--neg)" }}>{error}</Card>}
      {failed && <Card className="p-3 text-[12px]" style={{ color: "var(--neg)" }}>{failed}</Card>}

      {!receipts?.length && <Card><Empty t={tr("هێشتا هیچ فیشێکت نەناردووە")} /></Card>}

      {(receipts || []).map((r) => {
        const outcome = OUTCOME[receiptOutcome(r)] || OUTCOME.pending;
        return (
          <Card key={r.id} className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[12px] font-mono tracking-wide">{r.trackingCode || r.id}</div>
              <Pill tone={outcome.tone}>{tr(outcome.label)}</Pill>
            </div>
            <div className="text-[11px] text-[var(--txt-3)]">{when(r.receivedAt)}</div>

            {r.reason && (
              <div className="text-[12px] leading-6 rounded-[var(--r-sm)] p-2.5"
                   style={{ background: "var(--surf-2)", color: "var(--txt-2)" }}>
                {r.reason}
              </div>
            )}

            {r.replacedBy && (
              <div className="text-[11px] text-[var(--txt-3)]">
                {tr("لە جێگەی ئەمە ئەمە نێردرا")}: <span className="font-mono">{r.replacedByTrackingCode || r.replacedBy}</span>
              </div>
            )}

            {mayBeReplaced(r) && (
              <>
                <input
                  ref={(el) => { inputs.current[r.id] = el; }}
                  type="file" accept="image/*" className="hidden"
                  onChange={(e) => chosen(r, e.target.files?.[0])} />
                <button
                  onClick={() => pick(r.id)}
                  disabled={busy === r.id}
                  className="w-full rounded-[var(--r-sm)] py-2.5 text-[12px] font-bold tap disabled:opacity-60"
                  style={{ background: "var(--accent)", color: "var(--on-accent)" }}>
                  {busy === r.id ? tr("دەنێردرێت...") : tr("بارکردنەوەی فیشی نوێ")}
                </button>
              </>
            )}
          </Card>
        );
      })}
    </div>
  );
}
