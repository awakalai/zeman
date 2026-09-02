import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Gauge, History, Loader2, RefreshCw, Users } from "lucide-react";
import { loadManagerOverview } from "../../services/managerConsole.js";
import { rankName } from "../../services/adminRanks.js";
import { errorText } from "../../services/userFacingError";
import "./debt-center.css";

/**
 * The installation at a glance — the first screen a manager should meet.
 *
 * The manager sells the software and maintains it. They belong to no business, so a dashboard of
 * cashboxes and profit would be a dashboard of somebody else's money; what they actually need on
 * opening the application is whether the installation is in use, who administers it, and what has
 * changed lately across the whole of it.
 *
 * sarraf_manager_overview has answered exactly that since 202608230001 and nothing had ever read
 * it. The reachability rule in verify:source is what turned it up.
 *
 * ── What is deliberately not here ────────────────────────────────────────────────────────────
 *
 * No balances, no totals, no profit. The server returns counts and names, and that is the whole
 * design: enough to know an installation is alive, not enough to be looking at a customer's
 * money. A manager who needs to act inside a business opens a support session, which is recorded.
 */

const COPY = {
  ku: {
    title: "سیستەم بە گشتی",
    subtitle: "دامەزراندنەکە بە یەک ڕوانین — بێ هیچ ژمارەیەکی پارە",
    refresh: "نوێکردنەوە", loading: "بارکردن...", failed: "زانیارییەکان بار نەبوون",
    managers: "ماناجەر", owners: "خاوەن", people: "بەکارهێنەران",
    admins: "بەڕێوەبەران", noAdmins: "هیچ بەڕێوەبەرێک نییە",
    name: "ناو", rank: "پلە", phone: "ژمارە", since: "لە",
    inactive: "ناچالاک",
    changes: "دوایین گۆڕانکارییەکان", noChanges: "هیچ گۆڕانکارییەک نییە",
    when: "کات", what: "چی", detail: "وردەکاری",
    privacy: "هیچ ژمارەیەکی پارەی هیچ سەرخێڵێک لێرە پیشان نادرێت",
  },
  en: {
    title: "The system at a glance",
    subtitle: "The installation in one view — with no figure of anybody's money",
    refresh: "Refresh", loading: "Loading…", failed: "Could not load",
    managers: "Managers", owners: "Owners", people: "People",
    admins: "Administrators", noAdmins: "No administrator yet",
    name: "Name", rank: "Rank", phone: "Phone", since: "Since",
    inactive: "Inactive",
    changes: "Latest changes", noChanges: "Nothing has changed",
    when: "When", what: "What", detail: "Detail",
    privacy: "No figure from any business's books appears here",
  },
  ar: {
    title: "النظام في لمحة",
    subtitle: "التثبيت في عرض واحد — بلا أي رقم من أموال أحد",
    refresh: "تحديث", loading: "جارٍ التحميل…", failed: "تعذّر التحميل",
    managers: "المدراء", owners: "الملاك", people: "الأشخاص",
    admins: "المسؤولون", noAdmins: "لا مسؤول بعد",
    name: "الاسم", rank: "الرتبة", phone: "الهاتف", since: "منذ",
    inactive: "غير نشط",
    changes: "آخر التغييرات", noChanges: "لم يتغيّر شيء",
    when: "الوقت", what: "ماذا", detail: "التفاصيل",
    privacy: "لا يظهر هنا أي رقم من دفاتر أي عمل",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");

// The ranks as this business names them, which is not the same list as the admin levels.
const ROLE_NAME = {
  ku: { admin: "ئەدمین", customer: "کڕیار", partner: "هاوبەش", investor: "وەبەرهێنەر", office: "نووسینگە" },
  en: { admin: "Administrator", customer: "Customer", partner: "Partner", investor: "Investor", office: "Office" },
  ar: { admin: "مسؤول", customer: "زبون", partner: "شريك", investor: "مستثمر", office: "مكتب" },
};
const when = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—");
const day = (iso) => (iso ? String(iso).slice(0, 10) : "—");

export function ManagerOverview({ client, lang = "ku" }) {
  const copy = COPY[localeKey(lang)];
  const [state, setState] = useState("loading");
  const [overview, setOverview] = useState(null);
  const [failure, setFailure] = useState("");

  const load = useCallback(async () => {
    setState("loading"); setFailure("");
    try {
      setOverview(await loadManagerOverview(client));
      setState("ready");
    } catch (error) {
      setFailure(errorText(error).slice(0, 200));
      setState("error");
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  if (state === "loading") return (
    <section className="debt-panel"><p className="debt-empty">
      <Loader2 aria-hidden="true" /> {copy.loading}
    </p></section>
  );

  if (state === "error") return (
    <section className="debt-panel"><div className="debt-error" role="alert">
      <AlertTriangle aria-hidden="true" /> {copy.failed} — {failure}
      <button type="button" onClick={load}><RefreshCw aria-hidden="true" /> {copy.refresh}</button>
    </div></section>
  );

  const people = Object.entries(overview?.byRole || {});

  return (
    <section className="debt-panel" aria-labelledby="manager-overview-title">
      <header className="debt-header">
        <span className="debt-icon"><Gauge aria-hidden="true" /></span>
        <div>
          <h2 id="manager-overview-title">{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      {/* Counts, and only counts. */}
      <div className="debt-cards" role="status">
        <div className="debt-card">
          <span className="debt-card-label">{copy.managers}</span>
          <strong>{overview.managerCount}</strong>
        </div>
        <div className="debt-card">
          <span className="debt-card-label">{copy.owners}</span>
          <strong>{overview.ownerCount}</strong>
        </div>
        {people.map(([role, n]) => (
          <div className="debt-card" key={role}>
            {/* ROLE_NAME, not rankName — that one maps admin LEVELS (owner, operator, manager)
                and would hand back the raw English role for every customer and partner. */}
            <span className="debt-card-label">{ROLE_NAME[localeKey(lang)][role] || role}</span>
            <strong>{n}</strong>
            <span className="debt-card-note">{copy.people}</span>
          </div>
        ))}
      </div>

      {/* ── who administers it ── */}
      <header className="debt-header">
        <span className="debt-icon"><Users aria-hidden="true" /></span>
        <div><h2>{copy.admins}</h2></div>
      </header>

      {overview.administrators.length === 0 ? <p className="debt-empty">{copy.noAdmins}</p> : (
        <div className="debt-table-wrap">
          <table className="debt-table">
            <thead><tr>
              <th>{copy.name}</th><th>{copy.rank}</th><th>{copy.phone}</th><th>{copy.since}</th>
            </tr></thead>
            <tbody>
              {overview.administrators.map((a) => (
                <tr key={a.id} style={a.deleted ? { opacity: 0.55 } : undefined}>
                  <td>{a.name}{a.deleted ? ` · ${copy.inactive}` : ""}</td>
                  <td>{rankName(a.level, lang) || a.level || "—"}</td>
                  <td>{a.phone || "—"}</td>
                  <td>{day(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── what has changed across the whole installation ── */}
      <header className="debt-header">
        <span className="debt-icon"><History aria-hidden="true" /></span>
        <div><h2>{copy.changes}</h2><p>{copy.privacy}</p></div>
      </header>

      {overview.recentChanges.length === 0 ? <p className="debt-empty">{copy.noChanges}</p> : (
        <div className="debt-table-wrap">
          <table className="debt-table">
            <thead><tr>
              <th>{copy.when}</th><th>{copy.what}</th><th>{copy.detail}</th>
            </tr></thead>
            <tbody>
              {overview.recentChanges.map((c, i) => (
                <tr key={`${c.at}-${i}`}>
                  <td>{when(c.at)}</td>
                  <td>{c.action}</td>
                  {/* The detail is written by whichever command recorded it. Shown as text. */}
                  <td>{String(c.detail || "").slice(0, 300) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default ManagerOverview;
