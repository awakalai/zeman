import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Building2, CheckCircle2, Loader2, Plus, RefreshCw, ShieldCheck, Users,
} from "lucide-react";
import {
  createTenant, healthProblems, loadAllAccounts, loadHealth, loadTenants, setTenantActive,
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
    tabs: { tenants: "سەرخێڵەکان", accounts: "ئەکاونتەکان", health: "تەندروستی" },
    refresh: "نوێکردنەوە", loading: "بارکردن...", failed: "بار نەبوو", working: "جێبەجێکردن...",
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
  },
  en: {
    title: "Manager console",
    subtitle: "Businesses, accounts, and the health of the installation",
    tabs: { tenants: "Businesses", accounts: "Accounts", health: "Health" },
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
  },
};
COPY.ar = COPY.en;
const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const day = (v) => (v ? String(v).slice(0, 10) : null);

export function ManagerConsole({ client, lang = "ku", isManager = false, flash = () => {} }) {
  const copy = COPY[localeKey(lang)];
  const [tab, setTab] = useState("tenants");
  const [state, setState] = useState("loading");
  const [tenants, setTenants] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState({ id: "", name: "", note: "" });

  const load = useCallback(async () => {
    setState("loading"); setError("");
    try {
      // Each independently: a failure to read one view must not blank the other two.
      const [t, a, h] = await Promise.allSettled([
        loadTenants(client), loadAllAccounts(client), loadHealth(client),
      ]);
      if (t.status === "fulfilled") setTenants(t.value);
      if (a.status === "fulfilled") setAccounts(a.value);
      if (h.status === "fulfilled") setHealth(h.value);
      if (t.status === "rejected") throw t.reason;
      setState("ready");
    } catch (e) {
      setError(errorText(e).slice(0, 200));
      setState("error");
    }
  }, [client]);

  useEffect(() => { if (isManager) load(); }, [isManager, load]);

  const add = useCallback(async () => {
    const objection = tenantIdObjection(form.id) || tenantNameObjection(form.name);
    if (objection) { setError(objection); return; }
    setBusy("add"); setError("");
    try {
      await createTenant(client, form);
      setForm({ id: "", name: "", note: "" });
      flash(copy.add + " ✓");
      await load();
    } catch (e) {
      setError(errorText(e).slice(0, 200));
    } finally { setBusy(""); }
  }, [client, form, load, flash, copy.add]);

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
        {["tenants", "accounts", "health"].map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k}
                  className={tab === k ? "debt-primary" : ""}
                  onClick={() => setTab(k)}>
            {copy.tabs[k]}
            {k === "health" && problems.length ? ` (${problems.length})` : ""}
          </button>
        ))}
      </div>

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
            <button type="button" className="debt-primary" disabled={busy === "add"} onClick={add}>
              {busy === "add" ? <><Loader2 aria-hidden="true" /> {copy.working}</>
                              : <><Plus aria-hidden="true" /> {copy.add}</>}
            </button>
          </div>
          <p id="tenant-id-hint" className="debt-note">{copy.idHint}</p>
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

      <p className="debt-note">
        <Users aria-hidden="true" /> {tenants?.total_accounts ?? 0} {copy.accounts}
      </p>
    </section>
  );
}

export default ManagerConsole;
