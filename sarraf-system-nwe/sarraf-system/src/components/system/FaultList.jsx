import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bug, Loader2, RefreshCw } from "lucide-react";
import { loadFaults } from "../../services/faultReport.js";
import { errorText } from "../../services/userFacingError";
import "../accounting/debt-center.css";

/**
 * What actually broke, on somebody else's phone.
 *
 * 202608280022 is titled "a break at a customer's reaches somebody who can fix it", and half of
 * that was true: AppErrorBoundary writes a fault row whenever a screen crashes, with the code,
 * the screen, a fingerprint and how many times it has happened.
 *
 * Nothing ever read them. The rows have been accumulating in a table nobody opens, which means a
 * customer whose screen went white had exactly as much chance of being helped as before the
 * feature was built. The reachability rule in verify:source is what found it.
 *
 * Grouped by fingerprint on the server, so a crash that happened forty times is one line with a
 * count rather than forty lines — the thing worth knowing is which break, not how much noise.
 */

const COPY = {
  ku: {
    title: "ئەو شتانەی شکاون",
    subtitle: "کاتێک شاشەی کەسێک تێکدەچێت، لێرە دەردەکەوێت",
    none: "هیچ شتێک نەشکاوە ✓",
    loading: "بارکردن...", failed: "زانیارییەکان بار نەبوون", refresh: "نوێکردنەوە",
    screen: "شاشە", code: "کۆد", times: "چەند جار", last: "دوا جار", detail: "وردەکاری",
    days: "١٤ ڕۆژی ڕابردوو",
  },
  en: {
    title: "What has broken",
    subtitle: "When somebody's screen fails, it appears here",
    none: "Nothing has broken ✓",
    loading: "Loading…", failed: "Could not load", refresh: "Refresh",
    screen: "Screen", code: "Code", times: "Times", last: "Last seen", detail: "Detail",
    days: "Last 14 days",
  },
  ar: {
    title: "ما الذي تعطّل",
    subtitle: "عندما تتعطّل شاشة أحدهم، تظهر هنا",
    none: "لم يتعطّل شيء ✓",
    loading: "جارٍ التحميل…", failed: "تعذّر التحميل", refresh: "تحديث",
    screen: "الشاشة", code: "الرمز", times: "المرات", last: "آخر مرة", detail: "التفاصيل",
    days: "آخر ١٤ يومًا",
  },
};

const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");
const when = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—");

export function FaultList({ client, lang = "ku", days = 14 }) {
  const copy = COPY[localeKey(lang)];
  const [state, setState] = useState("loading");
  const [faults, setFaults] = useState([]);
  const [failure, setFailure] = useState("");

  const load = useCallback(async () => {
    setState("loading"); setFailure("");
    try {
      setFaults(await loadFaults(client, days));
      setState("ready");
    } catch (error) {
      setFailure(errorText(error).slice(0, 200));
      setState("error");
    }
  }, [client, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="debt-panel" aria-labelledby="fault-list-title">
      <header className="debt-header">
        <span className="debt-icon"><Bug aria-hidden="true" /></span>
        <div>
          <h2 id="fault-list-title">{copy.title}</h2>
          <p>{copy.subtitle} · {copy.days}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load}>
          <RefreshCw aria-hidden="true" /> {copy.refresh}
        </button>
      </header>

      {state === "loading" && <p className="debt-empty">
        <Loader2 aria-hidden="true" /> {copy.loading}
      </p>}

      {state === "error" && <div className="debt-error" role="alert">
        <AlertTriangle aria-hidden="true" /> {copy.failed} — {failure}
      </div>}

      {state === "ready" && (faults.length === 0
        ? <p className="debt-empty">{copy.none}</p>
        : (
          <div className="debt-table-wrap">
            <table className="debt-table">
              <thead><tr>
                <th>{copy.screen}</th><th>{copy.code}</th><th>{copy.times}</th>
                <th>{copy.last}</th><th>{copy.detail}</th>
              </tr></thead>
              <tbody>
                {faults.map((f) => (
                  <tr key={f.id || f.fingerprint}>
                    <td>{f.screen || "—"}</td>
                    <td>{f.code || f.kind || "—"}</td>
                    <td>{f.seen ?? 1}</td>
                    <td>{when(f.last_at)}</td>
                    {/* The detail is whatever the browser said. It is shown as text and never
                        as markup: a crash message is data from a stranger's device. */}
                    <td>{String(f.detail ?? "").slice(0, 300) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

export default FaultList;
