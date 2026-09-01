import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import {
  PASSWORD_MIN, byRank, grantableRanks, isManager, lastManagerObjection,
  passwordObjection, passwordTooShort, rankName, rankObjection, rankOf,
} from "../../services/adminRanks.js";
import "./debt-center.css";
import { errorText } from "../../services/userFacingError";

/**
 * What only a manager can do: hand out ranks, and put a password back.
 *
 * Every rule shown here is also enforced by the API and by the database. This screen exists so
 * that a control a person cannot use is not offered to them — a refusal after the click is a
 * worse answer than an absence before it, when the answer was never going to change.
 *
 * A new password is never displayed back, never kept in state after it is sent, and never
 * written to the change log. Only that it was changed, by whom, for whom.
 */

const COPY = {
  ku: {
    title: "ناوەندی ماناجەر",
    subtitle: "پلەکان و وشەی نهێنی — تەنها بۆ ماناجەر",
    ranks: "پلەکان", people: "بەکارهێنەران",
    rank: "پلە", name: "ناو", account: "ئەکاونت", change: "گۆڕین",
    password: "وشەی نهێنیی نوێ", reset: "دانانی وشەی نهێنی",
    working: "جێبەجێکردن...", refresh: "نوێکردنەوە",
    failed: "نەتوانرا بکرێت", done: "کرا ✓",
    pick: "کەسێک هەڵبژێرە",
    notManager: "ئەم بەشە تەنها بۆ ماناجەرە",
    hint: `لانیکەم ${PASSWORD_MIN} پیت. دوای ناردن پیشان نادرێتەوە.`,
    lastManager: "دوایین ماناجەرە",
  },
  en: {
    title: "Manager centre",
    subtitle: "Ranks and passwords — managers only",
    ranks: "Ranks", people: "People",
    rank: "Rank", name: "Name", account: "Account", change: "Change",
    password: "New password", reset: "Set password",
    working: "Working…", refresh: "Refresh",
    failed: "Could not do that", done: "Done ✓",
    pick: "Choose somebody",
    notManager: "This section is for managers only",
    hint: `At least ${PASSWORD_MIN} characters. Never shown again after sending.`,
    lastManager: "The last manager",
  },
  ar: {
    title: "مركز المدير",
    subtitle: "الرتب وكلمات المرور — للمدير فقط",
    ranks: "الرتب", people: "الأشخاص",
    rank: "الرتبة", name: "الاسم", account: "الحساب", change: "تغيير",
    password: "كلمة مرور جديدة", reset: "تعيين كلمة المرور",
    working: "جارٍ التنفيذ…", refresh: "تحديث",
    failed: "تعذّر تنفيذ ذلك", done: "تم ✓",
    pick: "اختر شخصًا",
    notManager: "هذا القسم للمدير فقط",
    hint: `${PASSWORD_MIN} حرفًا على الأقل. لا تُعرض مرة أخرى بعد الإرسال.`,
    lastManager: "آخر مدير",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");

export function ManagerCenter({ users = [], profile, lang = "ku", request, flash = () => {}, onDone }) {
  const copy = COPY[localeKey(lang)];
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pwTarget, setPwTarget] = useState("");
  const [pw, setPw] = useState("");

  const admins = useMemo(() => users.filter((u) => u.role === "admin" && !u.deleted).sort(byRank), [users]);
  const everyone = useMemo(
    () => users.filter((u) => !u.deleted).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
    [users]
  );
  const grantable = grantableRanks(profile);

  // Clearing the password the moment the panel closes, so it never sits in memory behind a
  // screen nobody is looking at.
  useEffect(() => { if (!pwTarget) setPw(""); }, [pwTarget]);

  const send = useCallback(async (key, payload, okText) => {
    setBusy(key); setError("");
    try {
      await request(payload);
      flash(okText || copy.done);
      onDone?.();
      return true;
    } catch (e) {
      setError(errorText(e).slice(0, 200));
      return false;
    } finally {
      setBusy("");
    }
  }, [request, flash, onDone, copy.done]);

  const setRank = useCallback(async (user, level) => {
    const objection = rankObjection(profile, user, level)
      || lastManagerObjection(users, user, level);
    if (objection) { setError(objection); return; }
    await send(`rank:${user.id}`, { action: "set_level", userId: user.id, adminLevel: level, tenantId: user.tenantId });
  }, [profile, users, send]);

  const resetPassword = useCallback(async () => {
    const user = users.find((u) => u.id === pwTarget);
    const objection = passwordObjection(profile, user) || passwordTooShort(pw);
    if (objection) { setError(objection); return; }
    const ok = await send(`pw:${user.id}`, { action: "reset_password", userId: user.id, password: pw, tenantId: user.tenantId });
    // Cleared whether or not it worked: a failed attempt is not a reason to keep it on screen.
    setPw("");
    if (ok) setPwTarget("");
  }, [users, pwTarget, pw, profile, send]);

  if (!isManager(profile)) {
    return <section className="debt-panel"><p className="debt-empty">{copy.notManager}</p></section>;
  }

  return (
    <section className="debt-panel" aria-labelledby="manager-centre-title">
      <header className="debt-header">
        <span className="debt-icon"><ShieldCheck aria-hidden="true" /></span>
        <div><h2 id="manager-centre-title">{copy.title}</h2><p>{copy.subtitle}</p></div>
      </header>

      {error && (
        <div className="debt-error" role="alert">
          <AlertTriangle aria-hidden="true" /> {copy.failed} — {error}
        </div>
      )}

      <h3 className="debt-subhead">{copy.ranks}</h3>
      <div className="debt-table-wrap">
        <table className="debt-table">
          <thead><tr>
            <th>{copy.name}</th><th>{copy.rank}</th><th>{copy.change}</th>
          </tr></thead>
          <tbody>
            {admins.map((u) => {
              const last = lastManagerObjection(users, u, "operator");
              return (
                <tr key={u.id}>
                  <td>{u.name}{u.id === profile?.id ? " ·" : ""}</td>
                  <td>{rankName(rankOf(u), lang)}{last ? ` · ${copy.lastManager}` : ""}</td>
                  <td>
                    <div className="debt-actions">
                      {grantable.map((level) => {
                        const objection = rankObjection(profile, u, level)
                          || lastManagerObjection(users, u, level);
                        if (objection) return null;
                        return (
                          <button key={level} type="button"
                                  disabled={busy === `rank:${u.id}`}
                                  onClick={() => setRank(u, level)}
                                  aria-label={`${u.name} → ${rankName(level, lang)}`}>
                            {busy === `rank:${u.id}`
                              ? <Loader2 aria-hidden="true" />
                              : `→ ${rankName(level, lang)}`}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="debt-subhead">{copy.password}</h3>
      <div className="cashbox-form">
        <label>{copy.account}
          <select value={pwTarget} aria-label={copy.pick}
                  onChange={(event) => { setPwTarget(event.target.value); setError(""); }}>
            <option value="">{copy.pick}</option>
            {everyone.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} — {u.role === "admin" ? rankName(rankOf(u), lang) : u.role}
              </option>
            ))}
          </select>
        </label>
        <label>{copy.password}
          <input type="password" value={pw} autoComplete="new-password"
                 aria-label={copy.password} aria-describedby="manager-pw-hint"
                 onChange={(event) => { setPw(event.target.value); setError(""); }} />
        </label>
        <button type="button" className="debt-primary"
                disabled={!pwTarget || busy.startsWith("pw:")}
                onClick={resetPassword}>
          {busy.startsWith("pw:")
            ? <><Loader2 aria-hidden="true" /> {copy.working}</>
            : <><KeyRound aria-hidden="true" /> {copy.reset}</>}
        </button>
      </div>
      <p id="manager-pw-hint" className="debt-note">{copy.hint}</p>
    </section>
  );
}

export default ManagerCenter;
