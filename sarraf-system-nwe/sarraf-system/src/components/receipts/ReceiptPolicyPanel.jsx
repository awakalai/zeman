import React, { useEffect, useRef, useState } from "react";
import { LockKeyhole, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { createReceiptReviewCommand, loadReceiptPolicy, updateReceiptPolicy } from "../../services/receiptReview";
import { errorTextOr } from "../../services/userFacingError.js";
import "./receipt-policy.css";

const defaults = { min_match_score: 80, require_reason_below: 90, allow_reject: true, allow_correction: true, require_finalization: true, require_separate_finalizer: true, version: 0 };
const COPY = {
  ku: { title: "سیاسەتی پشکنینی فیش", subtitle: "سنووری نمرە، هۆکاری بڕیار و کۆتایی‌هێنانی دروستکەر/پشکنەر", invalid: "سنوورەکانی سیاسەتی فیش نادروستن", short: "هۆکاری گۆڕین دەبێت لانیکەم ١٢ پیت بێت", saved: "سیاسەتی فیش پاشەکەوت و وردبینی کرا ✓", failed: "سیاسەتی فیش پاشەکەوت نەکرا", loadFailed: "سیاسەت بار نەبوو", retry: "دووبارە", min: "کەمترین نمرەی پەسەندکردن", below: "لە ژێر ئەم نمرەیە هۆکار پێویستە", checks: ["ڕەتکردنەوە ڕێپێدراوە", "گەڕاندنەوە بۆ چاککردن ڕێپێدراوە", "کۆتایی‌هێنان پێویستە", "دروستکەر و کۆتایی‌هێنەر جیاوازن"], reason: "هۆکاری گۆڕین", placeholder: "لانیکەم ١٢ پیت؛ لە تۆماری وردبینی دەمێنێتەوە", save: "پاشەکەوتکردن", locked: "تەنها خاوەنی سیستەم دەتوانێت سیاسەت بگۆڕێت" },
  en: { title: "Receipt Review Policy", subtitle: "Score thresholds, decision reasons, and maker/checker finalization", invalid: "Receipt-policy thresholds are invalid", short: "The change reason must contain at least 12 characters", saved: "Receipt policy saved and audited ✓", failed: "Receipt policy was not saved", loadFailed: "Policy could not be loaded", retry: "Retry", min: "Minimum acceptance score", below: "Reason required below", checks: ["Rejection is allowed", "Return for correction is allowed", "Finalization is required", "Maker and finalizer must differ"], reason: "Reason for change", placeholder: "At least 12 characters; retained in the audit log", save: "Save", locked: "Only the System Owner can change this policy" },
  ar: { title: "سياسة مراجعة الإيصالات", subtitle: "حدود التقييم وأسباب القرار والإغلاق وفق مبدأ المُنشئ والمراجع", invalid: "حدود سياسة الإيصالات غير صالحة", short: "يجب ألا يقل سبب التغيير عن 12 حرفاً", saved: "حُفظت سياسة الإيصالات وسُجلت في سجل التدقيق ✓", failed: "تعذر حفظ سياسة الإيصالات", loadFailed: "تعذر تحميل السياسة", retry: "إعادة المحاولة", min: "الحد الأدنى للقبول", below: "يلزم ذكر السبب دون هذه الدرجة", checks: ["السماح بالرفض", "السماح بالإعادة للتصحيح", "الإغلاق النهائي مطلوب", "يجب أن يختلف المُنشئ عن المُغلق النهائي"], reason: "سبب التغيير", placeholder: "12 حرفاً على الأقل؛ يُحفظ في سجل التدقيق", save: "حفظ", locked: "يستطيع مالك النظام فقط تغيير هذه السياسة" },
};
const localeKey = (lang) => lang === "en" || lang === "ar" ? lang : "ku";

export function ReceiptPolicyPanel({ client, isOwner, flash = () => {}, lang = "ku" }) {
  const copy = COPY[localeKey(lang)];
  const [policy, setPolicy] = useState(defaults);
  const [state, setState] = useState("loading");
  const [reason, setReason] = useState("");
  const command = useRef(null);
  const load = async () => { setState("loading"); try { setPolicy(await loadReceiptPolicy(client)); setState("ready"); } catch (error) { console.error("receipt policy", error); setState("error"); } };
  useEffect(() => { load(); }, [client]);
  const save = async () => {
    const min = Number(policy.min_match_score), below = Number(policy.require_reason_below);
    if (!Number.isInteger(min) || !Number.isInteger(below) || min < 0 || below < min || below > 100) return flash(copy.invalid);
    if (reason.trim().length < 12) return flash(copy.short);
    command.current ||= createReceiptReviewCommand("policy", "policy"); setState("saving");
    try {
      await updateReceiptPolicy(client, { policy: { min_match_score: min, require_reason_below: below, allow_reject: !!policy.allow_reject, allow_correction: !!policy.allow_correction, require_finalization: !!policy.require_finalization, require_separate_finalizer: !!policy.require_separate_finalizer }, updateReason: reason, commandKey: command.current });
      command.current = null; setReason(""); await load(); flash(copy.saved);
    } catch (error) { console.error("receipt policy update", error); setState("ready"); flash(errorTextOr(error, copy.failed)); }
  };
  return <section className="receipt-policy-panel" aria-labelledby="receipt-policy-title"><header><span className="receipt-policy-icon"><ShieldCheck aria-hidden="true" /></span><div><h2 id="receipt-policy-title">{copy.title}</h2><p>{copy.subtitle}</p></div><span className="receipt-policy-version">v{policy.version || "—"}</span></header>
    {state === "error" ? <div className="receipt-policy-error" role="alert">{copy.loadFailed} <button type="button" onClick={load}><RefreshCw aria-hidden="true" /> {copy.retry}</button></div> : <>
      <div className="receipt-policy-grid"><label>{copy.min}<input type="number" min="0" max="100" value={policy.min_match_score} disabled={!isOwner || state !== "ready"} onChange={(event) => setPolicy({ ...policy, min_match_score: event.target.value })} /></label><label>{copy.below}<input type="number" min="0" max="100" value={policy.require_reason_below} disabled={!isOwner || state !== "ready"} onChange={(event) => setPolicy({ ...policy, require_reason_below: event.target.value })} /></label></div>
      <div className="receipt-policy-checks">{[["allow_reject", copy.checks[0]], ["allow_correction", copy.checks[1]], ["require_finalization", copy.checks[2]], ["require_separate_finalizer", copy.checks[3]]].map(([key, label]) => <label key={key}><input type="checkbox" checked={!!policy[key]} disabled={!isOwner || state !== "ready"} onChange={(event) => setPolicy({ ...policy, [key]: event.target.checked })} /><span>{label}</span></label>)}</div>
      {isOwner ? <div className="receipt-policy-save"><label>{copy.reason}<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={copy.placeholder} /></label><button type="button" onClick={save} disabled={state !== "ready" || reason.trim().length < 12}><Save aria-hidden="true" /> {copy.save}</button></div> : <div className="receipt-policy-locked"><LockKeyhole aria-hidden="true" /> {copy.locked}</div>}
    </>}
  </section>;
}
