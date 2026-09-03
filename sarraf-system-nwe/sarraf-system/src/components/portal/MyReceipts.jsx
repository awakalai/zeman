import React from "react";
import { receiptOutcome, mayBeReplaced, mayBeDismissed } from "../../services/receiptIntake";
import { MAX_BUNDLE_RECEIPTS } from "../../services/receiptBundle.js";

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

export function MyReceipts({ receipts, loading, error, onReload, onReplace, onDismiss, onBundle, ui }) {
  const { Card, Pill, Empty, StatePanel, tr } = ui;
  const [busy, setBusy] = React.useState(null);
  const [failed, setFailed] = React.useState("");
  const inputs = React.useRef({});

  // §11: «تا ١٠٠ دانە بەیەکەوە فۆرۆرد بکرێت و بنێررێت بۆ واتس ئەپ.»
  //
  // The selection is a Set of ids and nothing more. Which of them may actually leave is not this
  // component's question and must not be — the server re-checks every id and returns only what
  // the subject is entitled to, so what is reported below is what came back, never what was
  // ticked. `outcome` therefore says three separate numbers rather than one: what is in the
  // package, what the server declined, and what would not download.
  const [picked, setPicked] = React.useState(() => new Set());
  const [packing, setPacking] = React.useState(null);
  const [outcome, setOutcome] = React.useState(null);
  const all = receipts || [];
  const toggle = (id) => setPicked((was) => {
    const next = new Set(was);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // A hundred is the server's limit as well, so stopping here means a person is told before they
  // press rather than refused after.
  const canPick = picked.size < MAX_BUNDLE_RECEIPTS;

  const run = async (mode) => {
    if (!onBundle || picked.size === 0) return;
    setFailed(""); setOutcome(null); setPacking({ done: 0, total: picked.size });
    try {
      const result = await onBundle([...picked], {
        mode,
        onProgress: (p) => setPacking(p),
      });
      setOutcome(result);
      // Only a completed hand-off clears the selection. A cancelled share sheet leaves the
      // choice standing, because the person has not finished with it.
      if (result?.delivery !== "cancelled") setPicked(new Set());
    } catch (e) {
      setFailed(e?.message || tr("پاکێجەکە ئامادە نەبوو"));
    } finally {
      setPacking(null);
    }
  };

  const pick = (id) => inputs.current[id]?.click();

  // «هەر لە تەنیشت خۆیا دیلێتکردنی ئەو فیشە هەبێت.»  It leaves this list; the row, the reason and
  // the history stay in the database, which is what lets the owner still see who keeps sending
  // bad ones.  Confirmed first, because a mis-tap next to «بارکردنەوەی فیشی نوێ» would otherwise
  // take away the refusal reason the person still needs to read.
  const [confirming, setConfirming] = React.useState(null);
  const putAway = async (receipt) => {
    setFailed("");
    setBusy(receipt.id);
    try {
      await onDismiss(receipt);
      setConfirming(null);
      await onReload?.();
    } catch (e) {
      setFailed(e?.message || tr("لابردنەکە سەرکەوتوو نەبوو"));
    } finally {
      setBusy(null);
    }
  };

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

  if (loading && !receipts) return <Card><StatePanel type="loading" title={tr("بارکردن…")} compact /></Card>;

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

      {onBundle && all.length > 0 && (
        <Card className="p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[12px] font-semibold">
              {picked.size} {tr("فیش هەڵبژێردراوە")}
              <span className="text-[11px] font-normal text-[var(--txt-3)]"> · {tr("بەکۆمەڵ")}</span>
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={!!packing}
                onClick={() => setPicked(new Set(all.slice(0, MAX_BUNDLE_RECEIPTS).map((r) => r.id)))}
                className="text-[11px] underline text-[var(--txt-2)] tap disabled:opacity-60">
                {tr("هەڵبژاردنی هەموو")}
              </button>
              <button type="button" disabled={!!packing || picked.size === 0}
                onClick={() => { setPicked(new Set()); setOutcome(null); }}
                className="text-[11px] underline text-[var(--txt-2)] tap disabled:opacity-60">
                {tr("پاککردنەوەی هەڵبژاردن")}
              </button>
            </div>
          </div>

          {packing && (
            <div className="text-[11.5px] text-[var(--txt-3)]" aria-live="polite">
              {tr("ئامادەکردن…")} {packing.done}/{packing.total}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!!packing || picked.size === 0} onClick={() => run("share")}
              className="rounded-[var(--r-sm)] py-2.5 text-[12px] font-bold tap disabled:opacity-60"
              style={{ background: "var(--accent)", color: "var(--on-accent)" }}>
              {packing ? tr("دەنێردرێت…") : tr("ناردن")}
            </button>
            <button type="button" disabled={!!packing || picked.size === 0} onClick={() => run("save")}
              className="rounded-[var(--r-sm)] py-2.5 text-[12px] font-bold tap disabled:opacity-60"
              style={{ background: "var(--surf-2)", color: "var(--txt)", border: "1px solid var(--line)" }}>
              {tr("هەڵگرتن")}
            </button>
          </div>

          {/* What actually happened, in three numbers rather than one. A package that quietly
              contained fewer receipts than were ticked would be the worst outcome here. */}
          {outcome && (
            <div className="text-[11.5px] space-y-1" role="status">
              <div style={{ color: "var(--pos)" }}>
                {outcome.included} {tr("فیش لە پاکێجەکەدا")}
                {outcome.delivery === "cancelled" ? ` · ${tr("ناردنەکە هەڵوەشێندرایەوە")}`
                  : outcome.delivery === "saved" ? ` · ${tr("هەڵگیرا")}` : ""}
              </div>
              {outcome.skipped > 0 && (
                <div style={{ color: "var(--warn)" }}>{outcome.skipped} {tr("دەرنەچوون")}</div>
              )}
              {outcome.unreadable?.length > 0 && (
                <div style={{ color: "var(--warn)" }}>
                  {outcome.unreadable.length} {tr("نەخوێندرانەوە")}
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {error && <Card className="p-3 text-[12px]" style={{ color: "var(--neg)" }}>{error}</Card>}
      {failed && <Card className="p-3 text-[12px]" style={{ color: "var(--neg)" }}>{failed}</Card>}

      {!receipts?.length && <Card><Empty t={tr("هێشتا هیچ فیشێکت نەناردووە")} /></Card>}

      {(receipts || []).map((r) => {
        // Named `state`, not `outcome`: the bundle result above owns that word now, and two
        // different things called `outcome` in one component is how a wrong one gets rendered.
        const state = OUTCOME[receiptOutcome(r)] || OUTCOME.pending;
        return (
          <Card key={r.id} className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                {onBundle && (
                  <input type="checkbox" checked={picked.has(r.id)}
                         disabled={!!packing || (!picked.has(r.id) && !canPick)}
                         onChange={() => toggle(r.id)}
                         aria-label={`${tr("هەڵبژاردنی هەموو")} — ${r.trackingCode || r.id}`} />
                )}
                <div className="text-[12px] font-mono tracking-wide truncate">{r.trackingCode || r.id}</div>
              </div>
              <Pill tone={state.tone}>{tr(state.label)}</Pill>
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
                  {busy === r.id ? tr("دەنێردرێت…") : tr("بارکردنەوەی فیشی نوێ")}
                </button>
              </>
            )}

            {onDismiss && mayBeDismissed(r) && (
              confirming === r.id ? (
                <div className="rounded-[var(--r-sm)] p-2.5 space-y-2"
                     style={{ background: "var(--surf-2)", border: "1px solid var(--line)" }}>
                  <div className="text-[11.5px] leading-6 text-[var(--txt-2)]">
                    {tr("لە لیستەکەت لادەبرێت. ناسڕێتەوە — تۆمارەکەی و هۆکارەکەی دەمێننەوە.")}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" disabled={busy === r.id} onClick={() => putAway(r)}
                      className="rounded-[var(--r-sm)] py-2 text-[12px] font-bold tap disabled:opacity-60"
                      style={{ background: "var(--neg)", color: "var(--on-accent)" }}>
                      {busy === r.id ? tr("لادەبرێت…") : tr("بەڵێ، لایبە")}
                    </button>
                    <button type="button" disabled={busy === r.id} onClick={() => setConfirming(null)}
                      className="rounded-[var(--r-sm)] py-2 text-[12px] font-bold tap disabled:opacity-60"
                      style={{ background: "var(--surf)", color: "var(--txt)", border: "1px solid var(--line)" }}>
                      {tr("پاشگەزبوونەوە")}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirming(r.id)}
                  className="w-full rounded-[var(--r-sm)] py-2 text-[12px] font-semibold tap"
                  style={{ background: "transparent", color: "var(--txt-2)", border: "1px solid var(--line)" }}>
                  {tr("لابردن لە لیستەکەم")}
                </button>
              )
            )}
          </Card>
        );
      })}
    </div>
  );
}
