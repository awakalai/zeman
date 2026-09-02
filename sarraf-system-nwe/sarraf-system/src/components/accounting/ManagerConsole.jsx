import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Bell, Building2, CheckCircle2, KeyRound, Loader2, Plus, RefreshCw,
  ShieldCheck, Unlock, Users,
} from "lucide-react";
import {
  attentionReasons, closeSupport, currentSupport, healthProblems, loadAllAccounts,
  loadAttention, loadHealth, loadSupportHistory, loadTenants, openBusiness, openSupport,
  ownerEmailObjection, ownerNameObjection, setTenantActive, supportReasonObjection,
  tenantIdObjection, tenantNameObjection,
} from "../../services/managerConsole.js";
import { rankName, rankOf } from "../../services/adminRanks.js";
import "./debt-center.css";
import { errorText } from "../../services/userFacingError";

/**
 * The manager's console: businesses, accounts, and the health of the installation.
 *
 * Not a dashboard of an exchange. The manager maintains the system and sells it; they are not a
 * party to anybody's trades, and no figure from a business's books appears here. What a business
 * has done is shown as counts, which is enough to know whether it is in use and not enough to be
 * looking at somebody's money.
 */

const COPY = {
  ku: {
    title: "کۆنسۆڵی ماناجەر",
    subtitle: "سەرخێڵەکان، ئەکاونتەکان و تەندروستیی سیستەم",
    tabs: {
      attention: "چی پێویستی بە تۆیە", tenants: "سەرخێڵەکان",
      accounts: "ئەکاونتەکان", health: "تەندروستی", support: "پشتگیری",
    },
    refresh: "نوێکردنەوە", loading: "بارکردن…", failed: "بار نەبوو", working: "جێبەجێکردن…",
    notManager: "ئەم بەشە تەنها بۆ ماناجەرە",
    name: "ناو", id: "ناسنامە", accounts: "ئەکاونت", admins: "ئەدمین",
    transactions: "مامەڵە", receipts: "فیش", lastActivity: "دوایین کار", state: "دۆخ",
    active: "چالاک", suspended: "ڕاگیراو",
    suspend: "ڕاگرتن", resume: "چالاککردنەوە", reason: "هۆکار",
    create: "سەرخێڵی نوێ", note: "تێبینی", add: "زیادکردن",
    role: "ڕۆڵ", tenant: "سەرخێڵ", login: "چوونەژوورەوە", phone: "ژمارە",
    noTenant: "بێ سەرخێڵ", deleted: "ناچالاک",
    healthy: "هیچ کێشەیەک نییە", problems: "کێشەکان",
    idHint: "پیتی ئینگلیزیی بچووک، ژمارە و داش — بۆ نموونە zeman-erbil",
    never: "هەرگیز",
    support: "پشتگیری",
    supportLead: "پێش کارکردن لەسەر سەرخێڵێک، بیکەرەوە و هۆکارەکە بنووسە. خاوەنی سەرخێڵەکە هەموو ئەمانە دەبینێت",
    open: "کردنەوە", close: "داخستن", openNow: "ئێستا کراوەیە", nothingOpen: "هیچ سەرخێڵێک کراوە نییە",
    why: "هۆکار", forHowLong: "بۆ چەند خولەک", expires: "بەسەردەچێت",
    opened: "کرایەوە", closed: "داخرا", stillOpen: "کراوەیە", byWhom: "لەلایەن",
    history: "مێژووی پشتگیری", noHistory: "هیچ پشتگیرییەک نەکراوەتەوە",
    needsYou: "چی پێویستی بە تۆیە", needsLead: "ئەمانە بەپێی گرنگی ڕیز کراون — سەرەوە ئەوەیە کە یەکەم جار سەیری بکە", needsNothing: "هیچ بازرگانییەک پێویستی بە تۆ نییە",
    ownerName: "ناوی خاوەن", ownerEmail: "ئیمەیڵی خاوەن", ownerHint: "خاوەنەکە دوای بانگهێشتکردن لە Supabase یەکەم جار کە دەچێتە ژوورەوە دروست دەبێت",
  },
  en: {
    title: "Manager console",
    subtitle: "Businesses, accounts, and the health of the installation",
    tabs: {
      attention: "What needs you", tenants: "Businesses",
      accounts: "Accounts", health: "Health", support: "Support",
    },
    refresh: "Refresh", loading: "Loading…", failed: "Could not load", working: "Working…",
    notManager: "This section is for managers only",
    name: "Name", id: "Id", accounts: "Accounts", admins: "Admins",
    transactions: "Transactions", receipts: "Receipts", lastActivity: "Last activity", state: "State",
    active: "Active", suspended: "Suspended",
    suspend: "Suspend", resume: "Resume", reason: "Reason",
    create: "New business", note: "Note", add: "Add",
    role: "Role", tenant: "Business", login: "Sign-in", phone: "Phone",
    noTenant: "No business", deleted: "Deactivated",
    healthy: "Nothing wrong", problems: "Problems",
    idHint: "Lower-case letters, digits and dashes — for example zeman-erbil",
    never: "Never",
    support: "Support",
    supportLead: "Open a business before acting on it, and say why. The owner of that business sees every one of these",
    open: "Open", close: "Close", openNow: "Open now", nothingOpen: "No business is open",
    why: "Reason", forHowLong: "For how many minutes", expires: "Expires",
    opened: "Opened", closed: "Closed", stillOpen: "Open", byWhom: "By",
    history: "Support history", noHistory: "No support context has been opened",
    needsYou: "What needs you", needsLead: "Ordered by what matters — the top one is where to look first", needsNothing: "No business needs you",
    ownerName: "Owner's name", ownerEmail: "Owner's email", ownerHint: "The owner's account is made the first time they sign in, after you invite them in Supabase",
  },
  ar: {
    title: "لوحة المدير",
    subtitle: "الأعمال والحسابات وصحة النظام",
    tabs: {
      attention: "ما يحتاج إليك", tenants: "الأعمال",
      accounts: "الحسابات", health: "الصحة", support: "الدعم",
    },
    refresh: "تحديث", loading: "جارٍ التحميل…", failed: "تعذّر التحميل", working: "جارٍ التنفيذ…",
    notManager: "هذا القسم للمدير فقط",
    name: "الاسم", id: "المعرّف", accounts: "الحسابات", admins: "مشرفون",
    transactions: "المعاملات", receipts: "الإيصالات", lastActivity: "آخر نشاط", state: "الحالة",
    active: "نشط", suspended: "موقوف",
    suspend: "إيقاف", resume: "استئناف", reason: "السبب",
    create: "عمل جديد", note: "ملاحظة", add: "إضافة",
    role: "الدور", tenant: "العمل", login: "تسجيل الدخول", phone: "الهاتف",
    noTenant: "بلا عمل", deleted: "معطّل",
    healthy: "لا يوجد خطأ", problems: "المشكلات",
    idHint: "أحرف إنجليزية صغيرة وأرقام وشرطات — مثل zeman-erbil",
    never: "أبدًا",
    support: "الدعم",
    supportLead: "افتح العمل قبل التصرف فيه، واذكر السبب. صاحب العمل يرى كل واحدة من هذه",
    open: "فتح", close: "إغلاق", openNow: "مفتوح الآن", nothingOpen: "لا يوجد عمل مفتوح",
    why: "السبب", forHowLong: "لكم دقيقة", expires: "ينتهي",
    opened: "فُتح", closed: "أُغلق", stillOpen: "مفتوح", byWhom: "بواسطة",
    history: "سجل الدعم", noHistory: "لم يُفتح أي دعم",
    needsYou: "ما يحتاج إليك", needsLead: "مرتّبة حسب الأهمية — الأولى هي التي تُنظر أولًا", needsNothing: "لا يوجد عمل يحتاج إليك",
    ownerName: "اسم المالك", ownerEmail: "بريد المالك", ownerHint: "يُنشأ حساب المالك عند أول تسجيل دخول، بعد دعوته من Supabase",
  },
};
const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const day = (v) => (v ? String(v).slice(0, 10) : null);

export function ManagerConsole({ client, lang = "ku", isManager = false, flash = () => {} }) {
  const copy = COPY[localeKey(lang)];
  const [tab, setTab] = useState("attention");
  const [state, setState] = useState("loading");
  const [tenants, setTenants] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState({ id: "", name: "", note: "", ownerEmail: "", ownerName: "" });
  const [openTenant, setOpenTenant] = useState(null);
  const [support, setSupport] = useState({ id: "", reason: "", minutes: 120 });
  const [history, setHistory] = useState([]);
  const [attention, setAttention] = useState([]);

  const load = useCallback(async () => {
    setState("loading"); setError("");
    try {
      // Each independently: a failure to read one view must not blank the other two.
      const [t, a, h, open, log, needs] = await Promise.allSettled([
        loadTenants(client), loadAllAccounts(client), loadHealth(client),
        currentSupport(client), loadSupportHistory(client), loadAttention(client),
      ]);
      if (t.status === "fulfilled") setTenants(t.value);
      if (a.status === "fulfilled") setAccounts(a.value);
      if (h.status === "fulfilled") setHealth(h.value);
      if (open.status === "fulfilled") setOpenTenant(open.value);
      if (log.status === "fulfilled") setHistory(log.value.sessions);
      if (needs.status === "fulfilled") setAttention(needs.value.businesses);
      if (t.status === "rejected") throw t.reason;
      setState("ready");
    } catch (e) {
      setError(errorText(e).slice(0, 200));
      setState("error");
    }
  }, [client]);

  useEffect(() => { if (isManager) load(); }, [isManager, load]);

  // One act, not two. The business used to be created on its own and the owner on a different
  // screen; a manager who forgot the second step left a business that looked created and could
  // not be signed into.
  const add = useCallback(async () => {
    const lang3 = localeKey(lang);
    const objection = tenantIdObjection(form.id) || tenantNameObjection(form.name)
      || ownerEmailObjection(form.ownerEmail, lang3) || ownerNameObjection(form.ownerName, lang3);
    if (objection) { setError(objection); return; }
    setBusy("add"); setError("");
    try {
      const made = await openBusiness(client, {
        id: form.id, name: form.name, note: form.note,
        ownerEmail: form.ownerEmail, ownerName: form.ownerName,
      });
      setForm({ id: "", name: "", note: "", ownerEmail: "", ownerName: "" });
      // What is left to do is said here rather than assumed: the owner has no login until
      // somebody invites them, and nothing in this system can make one.
      flash(made?.next || `${copy.add} ✓`, true);
      await load();
    } catch (e) {
      setError(errorText(e).slice(0, 200));
    } finally { setBusy(""); }
  }, [client, form, load, flash, copy.add, lang]);

  const toggle = useCallback(async (tenant) => {
    const reason = window.prompt(copy.reason);
    if (!reason) return;
    setBusy(`t:${tenant.id}`); setError("");
    try {
      await setTenantActive(client, { id: tenant.id, active: !tenant.active, reason });
      await load();
    } catch (e) {
      setError(errorText(e).slice(0, 200));
    } finally { setBusy(""); }
  }, [client, load, copy.reason]);

  // Opening a business is the act that lets the manager touch it at all; api/admin-user.js
  // refuses every write on a business without one. Closing it is a single press, and it is worth
  // being easy: a context left open is the thing this whole mechanism exists to avoid.
  const beginSupport = useCallback(async () => {
    const objection = supportReasonObjection(support.reason, localeKey(lang));
    if (objection) { setError(objection); return; }
    setBusy("support"); setError("");
    try {
      await openSupport(client, {
        tenantId: support.id, reason: support.reason,
        minutes: Number(support.minutes) || 120, lang: localeKey(lang),
      });
      setSupport({ id: "", reason: "", minutes: 120 });
      flash(copy.openNow + " ✓", true);
      await load();
    } catch (e) {
      setError(errorText(e).slice(0, 200));
    } finally { setBusy(""); }
  }, [client, support, load, flash, copy.openNow, lang]);

  const endSupport = useCallback(async () => {
    setBusy("support"); setError("");
    try {
      await closeSupport(client);
      flash(copy.close + " ✓", true);
      await load();
    } catch (e) {
      setError(errorText(e).slice(0, 200));
    } finally { setBusy(""); }
  }, [client, load, flash, copy.close]);

  const problems = useMemo(() => healthProblems(health, localeKey(lang)), [health, lang]);

  if (!isManager) {
    return <section className="debt-panel"><p className="debt-empty">{copy.notManager}</p></section>;
  }
  if (state === "loading") {
    return <section className="debt-panel"><p className="debt-empty">
      <Loader2 aria-hidden="true" /> {copy.loading}</p></section>;
  }

  return (
    <section className="debt-panel" aria-labelledby="manager-console-title">
      <header className="debt-header">
        <span className="debt-icon"><ShieldCheck aria-hidden="true" /></span>
        <div><h2 id="manager-console-title">{copy.title}</h2><p>{copy.subtitle}</p></div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      {error && <div className="debt-error" role="alert">
        <AlertTriangle aria-hidden="true" /> {error}</div>}

      <div className="debt-actions" role="tablist" aria-label={copy.title}>
        {["attention", "tenants", "accounts", "health", "support"].map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k}
                  className={tab === k ? "debt-primary" : ""}
                  onClick={() => setTab(k)}>
            {copy.tabs[k]}
            {k === "health" && problems.length ? ` (${problems.length})` : ""}
            {k === "support" && openTenant ? " ●" : ""}
            {k === "attention" && attention.some((b) => attentionReasons(b, localeKey(lang)).length)
              ? ` (${attention.filter((b) => attentionReasons(b, localeKey(lang)).length).length})` : ""}
          </button>
        ))}
      </div>

      {tab === "attention" && (() => {
        const needing = attention
          .map((b) => ({ business: b, reasons: attentionReasons(b, localeKey(lang)) }))
          .filter((x) => x.reasons.length);
        return (
          <>
            <p className="debt-note"><Bell aria-hidden="true" /> {copy.needsLead}</p>
            {needing.length === 0
              ? <p className="debt-empty"><CheckCircle2 aria-hidden="true" /> {copy.needsNothing}</p>
              : <ul className="recon-list">
                  {needing.map(({ business, reasons }) => (
                    <li key={business.id}>
                      <div className="recon-row">
                        <span className="recon-row-main">
                          <span className="recon-row-id">{business.name}</span>
                          <span className="recon-row-text">{reasons.join(" · ")}</span>
                        </span>
                        <span className="recon-row-meta">
                          <span className={`recon-badge ${business.never_opened ? "is-bad" : ""}`}>
                            {business.active ? copy.active : copy.suspended}
                          </span>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>}
          </>
        );
      })()}

      {tab === "tenants" && (
        <>
          <div className="debt-table-wrap">
            <table className="debt-table">
              <thead><tr>
                <th>{copy.name}</th><th>{copy.id}</th><th>{copy.accounts}</th>
                <th>{copy.transactions}</th><th>{copy.receipts}</th>
                <th>{copy.lastActivity}</th><th>{copy.state}</th><th />
              </tr></thead>
              <tbody>
                {(tenants?.tenants || []).map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.id}</td>
                    <td>{t.accounts} · {t.admins} {copy.admins}</td>
                    <td>{t.transactions}</td>
                    <td>{t.receipts}</td>
                    <td>{day(t.last_activity) || copy.never}</td>
                    <td>{t.active ? copy.active : copy.suspended}</td>
                    <td>
                      <button type="button" disabled={busy === `t:${t.id}`}
                              onClick={() => toggle(t)}
                              aria-label={`${t.active ? copy.suspend : copy.resume} — ${t.name}`}>
                        {busy === `t:${t.id}`
                          ? <Loader2 aria-hidden="true" />
                          : (t.active ? copy.suspend : copy.resume)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="debt-subhead"><Building2 aria-hidden="true" /> {copy.create}</h3>
          <div className="cashbox-form">
            <label>{copy.id}
              <input value={form.id} aria-label={copy.id} aria-describedby="tenant-id-hint"
                     onChange={(e) => { setForm({ ...form, id: e.target.value }); setError(""); }} />
            </label>
            <label>{copy.name}
              <input value={form.name} aria-label={copy.name}
                     onChange={(e) => { setForm({ ...form, name: e.target.value }); setError(""); }} />
            </label>
            <label>{copy.note}
              <input value={form.note} aria-label={copy.note}
                     onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
            <label>{copy.ownerName}
              <input value={form.ownerName} aria-label={copy.ownerName}
                     onChange={(e) => { setForm({ ...form, ownerName: e.target.value }); setError(""); }} />
            </label>
            <label>{copy.ownerEmail}
              <input type="email" value={form.ownerEmail} aria-label={copy.ownerEmail}
                     style={{ direction: "ltr" }} aria-describedby="owner-email-hint"
                     onChange={(e) => { setForm({ ...form, ownerEmail: e.target.value }); setError(""); }} />
            </label>
            <button type="button" className="debt-primary" disabled={busy === "add"} onClick={add}>
              {busy === "add" ? <><Loader2 aria-hidden="true" /> {copy.working}</>
                              : <><Plus aria-hidden="true" /> {copy.add}</>}
            </button>
          </div>
          <p id="tenant-id-hint" className="debt-note">{copy.idHint}</p>
          <p id="owner-email-hint" className="debt-note">{copy.ownerHint}</p>
        </>
      )}

      {tab === "accounts" && (
        <div className="debt-table-wrap">
          <table className="debt-table">
            <thead><tr>
              <th>{copy.name}</th><th>{copy.role}</th><th>{copy.tenant}</th>
              <th>{copy.login}</th><th>{copy.phone}</th><th>{copy.state}</th>
            </tr></thead>
            <tbody>
              {accounts.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.role === "admin" ? rankName(rankOf({ ...u, adminLevel: u.admin_level }), lang) : u.role}</td>
                  <td>{u.tenant_name || copy.noTenant}</td>
                  <td style={{ direction: "ltr", unicodeBidi: "embed" }}>{u.email || "—"}</td>
                  <td style={{ direction: "ltr", unicodeBidi: "embed" }}>{u.phone || "—"}</td>
                  <td>{u.deleted ? copy.deleted : copy.active}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "health" && (
        problems.length === 0
          ? <p className="debt-empty"><CheckCircle2 aria-hidden="true" /> {copy.healthy}</p>
          : <div className="debt-table-wrap" role="status">
              <table className="debt-table">
                <thead><tr><th>{copy.problems}</th></tr></thead>
                <tbody>{problems.map((p, i) => <tr key={i}><td>{p}</td></tr>)}</tbody>
              </table>
            </div>
      )}

      {tab === "support" && (
        <>
          <p className="debt-note"><KeyRound aria-hidden="true" /> {copy.supportLead}</p>

          {openTenant ? (
            <div className="debt-ledger is-ok">
              <Unlock aria-hidden="true" />{" "}
              {copy.openNow}: <strong>{
                (tenants?.tenants || []).find((t) => t.id === openTenant)?.name || openTenant
              }</strong>
              <button type="button" className="debt-refresh recon-finish"
                      disabled={busy === "support"} onClick={endSupport}>
                {busy === "support" ? <Loader2 aria-hidden="true" /> : <>{copy.close}</>}
              </button>
            </div>
          ) : (
            <div className="debt-ledger">{copy.nothingOpen}</div>
          )}

          <div className="cashbox-form">
            <label>{copy.tenant}
              <select value={support.id} aria-label={copy.tenant}
                      onChange={(e) => { setSupport({ ...support, id: e.target.value }); setError(""); }}>
                <option value="">—</option>
                {(tenants?.tenants || []).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label>{copy.why}
              <input value={support.reason} aria-label={copy.why}
                     onChange={(e) => { setSupport({ ...support, reason: e.target.value }); setError(""); }} />
            </label>
            <label>{copy.forHowLong}
              <input type="number" min="15" max="480" step="15" value={support.minutes}
                     aria-label={copy.forHowLong} style={{ direction: "ltr" }}
                     onChange={(e) => setSupport({ ...support, minutes: e.target.value })} />
            </label>
            <button type="button" className="debt-primary"
                    disabled={busy === "support" || !support.id
                              || !!supportReasonObjection(support.reason, localeKey(lang))}
                    onClick={beginSupport}>
              {busy === "support" ? <Loader2 aria-hidden="true" /> : <Plus aria-hidden="true" />}
              {" "}{copy.open}
            </button>
          </div>

          <h3 className="debt-subhead"><ShieldCheck aria-hidden="true" /> {copy.history}</h3>
          {history.length === 0
            ? <p className="debt-empty">{copy.noHistory}</p>
            : <div className="debt-table-wrap">
                <table className="debt-table">
                  <thead><tr>
                    <th>{copy.tenant}</th><th>{copy.byWhom}</th><th>{copy.why}</th>
                    <th>{copy.opened}</th><th>{copy.state}</th>
                  </tr></thead>
                  <tbody>
                    {history.slice(0, 60).map((r) => (
                      <tr key={r.id}>
                        <td>{r.tenant_name || r.tenant_id}</td>
                        <td>{r.manager_name || "—"}</td>
                        <td>{r.reason}</td>
                        <td style={{ direction: "ltr", unicodeBidi: "embed" }}>
                          {String(r.opened_at || "").slice(0, 16).replace("T", " ")}
                        </td>
                        <td>{r.still_open ? copy.stillOpen
                          : `${copy.closed} ${String(r.closed_at || r.expires_at || "").slice(0, 16).replace("T", " ")}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
        </>
      )}

      <p className="debt-note">
        <Users aria-hidden="true" /> {tenants?.total_accounts ?? 0} {copy.accounts}
      </p>
    </section>
  );
}

export default ManagerConsole;
