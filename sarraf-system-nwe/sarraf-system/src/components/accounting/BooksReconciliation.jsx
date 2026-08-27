import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Scale } from "lucide-react";
import { loadBooksReconciliation, loadGaps } from "../../services/booksReconciliation";
import "./debt-center.css";
import { errorText } from "../../services/userFacingError";

const COPY = {
  ku: {
    title: "پێکهاتنەوەی دەفتەرەکان",
    subtitle: "دەفتەری کۆن و دەفتەری ژمێریاری هەردووکیان هەمان پارە تۆمار دەکەن — لێرەدا دەپشکنرێت کە یەک دەگرنەوە",
    refresh: "نوێکردنەوە", loading: "پشکنین...",
    agreed: "هەردوو دەفتەرەکە یەک دەگرنەوە ✓",
    disagreed: "یەک ناگرنەوە — خوارەوە بڕوانە",
    transactions: "مامەڵە", posted: "تۆمارکراو", ledgerRows: "ڕیزی دەفتەری کۆن",
    difference: "جیاوازی", checkedAt: "پشکنراوە",
    gaps: "ئەو مامەڵانەی کێشەیان هەیە", noGaps: "هیچ مامەڵەیەکی کێشەدار نییە",
    unknown: "هەڵسەنگاندنی دەفتەر بەردەست نییە",
  },
};
COPY.en = COPY.ku; COPY.ar = COPY.ku;

const money = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function BooksReconciliation({ client, lang = "ku", flash = () => {} }) {
  const copy = COPY[lang] || COPY.ku;
  const [result, setResult] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [state, setState] = useState("loading");
  const flashRef = useRef(flash);
  flashRef.current = flash;

  const load = useCallback(async () => {
    setState("loading");
    try {
      const summary = await loadBooksReconciliation(client);
      setResult(summary);
      // Only fetched when there is something to show; a clean reconciliation needs no list.
      setGaps(summary.agreed ? [] : await loadGaps(client).catch(() => []));
      setState("ready");
    } catch (e) {
      console.error("books reconciliation", e);
      flashRef.current(errorText(e));
      setState("error");
    }
  }, [client]);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="debt-panel">
      <header className="debt-header">
        <div className="debt-icon"><Scale /></div>
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <button type="button" className="debt-refresh" onClick={load} disabled={state === "loading"}>
          <RefreshCw /> {copy.refresh}
        </button>
      </header>

      {state === "loading" && (
        <div className="debt-ledger"><Loader2 className="recon-spin" /> {copy.loading}</div>
      )}

      {state === "ready" && result && (
        <>
          {/* All-or-nothing on purpose: "mostly reconciled" is not a state a set of books
              can be in, and a green light with an asterisk is how a divergence gets ignored. */}
          <div className={`debt-ledger ${result.agreed ? "is-ok" : "is-bad"}`}>
            {result.agreed ? <CheckCircle2 /> : <AlertTriangle />}{" "}
            {result.agreed ? copy.agreed : copy.disagreed}
          </div>

          <div className="debt-aging-grid">
            <div className="debt-card">
              <h3>{copy.transactions}</h3>
              <span className="debt-currency-amount">{result.transactions}</span>
            </div>
            <div className="debt-card">
              <h3>{copy.posted}</h3>
              <span className="debt-currency-amount">{result.posted}</span>
            </div>
            {result.ledgerRows != null && (
              <div className="debt-card">
                <h3>{copy.ledgerRows}</h3>
                <span className="debt-currency-amount">{result.ledgerRows}</span>
              </div>
            )}
            <div className={`debt-card ${result.balanced === false ? "is-negative" : ""}`}>
              <h3>{copy.difference}</h3>
              <span className="debt-currency-amount">
                {/* An unknown balance says so; it is not the same as a balanced one. */}
                {result.balanced == null ? copy.unknown : `${money(result.difference)} $`}
              </span>
            </div>
          </div>

          {result.findings.length > 0 && (
            <ul className="recon-list is-bad">
              {result.findings.map((f) => (
                <li key={f.code}>
                  <div className="recon-row">
                    <span className="recon-row-main">
                      <span className="recon-row-text">{f.text}</span>
                    </span>
                    <span className="recon-row-meta">
                      <span className="recon-badge is-bad">
                        {f.code === "trial_balance" ? `${money(f.difference)} $` : f.count}
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {gaps.length > 0 && (
            <div>
              <h3 className="recon-subtitle">{copy.gaps}</h3>
              <ul className="recon-list">
                {gaps.slice(0, 40).map((g) => (
                  <li key={g.transactionId}>
                    <div className="recon-row">
                      <span className="recon-row-main">
                        <span className="recon-row-id">#{g.code ?? g.transactionId}</span>
                        <span className="recon-row-text">{g.text}</span>
                      </span>
                      <span className="recon-row-meta">
                        <span className="recon-badge">{g.journalStatus}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.checkedAt && (
            <p className="recon-note">
              {copy.checkedAt}: {new Date(result.checkedAt).toLocaleString("en-GB")}
            </p>
          )}
        </>
      )}

      {state === "error" && (
        <div className="debt-ledger is-bad"><AlertTriangle /> {copy.disagreed}</div>
      )}
    </section>
  );
}
