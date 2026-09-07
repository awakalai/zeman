import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { BRAND } from "../../brand/brand";
import "./printable-sheet.css";

/**
 * کاغەزێک کە چاپ دەبێت — و ئەوەی خاوەن پاشەکەوتی دەکات PDFـە
 *
 *   «PDF ـەکان براندکراو، کوردی، RTL و گونجاو بۆ چاپ بن.»  — بەشی ٢١
 *
 * The document comes from src/services/statement.js, which decides what may appear on it and
 * never copies a row. This only draws it.
 *
 * ── Why a portal onto <body> ────────────────────────────────────────────────────────────────
 *
 * The print rules hide every child of <body> and show one of them back. A sheet rendered deep
 * inside the application tree would be hidden along with its ancestors, however it was marked,
 * because an ancestor with `display: none` takes its descendants with it whatever they say.
 * So the sheet is mounted as a sibling of the app, not inside it.
 */
const COPY = {
  ku: { print: "چاپ / PDF", close: "داخستن" },
  en: { print: "Print / PDF", close: "Close" },
  ar: { print: "طباعة / PDF", close: "إغلاق" },
};
const localeKey = (lang) => (lang === "en" ? "en" : lang === "ar" ? "ar" : "ku");

export function PrintableSheet({ doc, onClose, autoPrint = false, lang = "ku" }) {
  const copy = COPY[localeKey(lang)];
  useEffect(() => {
    if (!autoPrint || !doc) return undefined;
    // One frame, so the sheet is laid out before the dialogue reads it. Printing on the same
    // tick prints the page as it was before this mounted.
    const id = requestAnimationFrame(() => window.print());
    return () => cancelAnimationFrame(id);
  }, [autoPrint, doc]);

  if (!doc) return null;

  const sheet = (
    <div className="zeman-print-root" dir="rtl">
      <article className="zeman-sheet" lang="ckb">
        <header className="zeman-sheet__brand">
          <strong>{doc.business || BRAND.name}</strong>
          <span>{doc.title}</span>
        </header>

        <div className="zeman-sheet__party">
          <b>{doc.party?.name || "—"}</b>
          {doc.party?.phone && <span dir="ltr">{doc.party.phone}</span>}
          <span>{doc.party?.role}</span>
          <span>
            {doc.periodLabel}
            {doc.period && `: ${doc.period.from || "…"} — ${doc.period.to || "…"}`}
          </span>
          <span>{doc.issued}</span>
        </div>

        {doc.sections.map((section) => (
          <section className="zeman-sheet__section" key={section.title}>
            <h3>{section.title}</h3>
            {section.lines.length === 0 ? (
              <p className="zeman-sheet__empty">{section.empty}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{doc.columns.date}</th>
                    <th>{doc.columns.reference}</th>
                    <th>{doc.columns.kind}</th>
                    <th className="num">{doc.columns.amount}</th>
                    <th className="num">{doc.columns.total}</th>
                  </tr>
                </thead>
                <tbody>
                  {section.lines.map((line, i) => (
                    <tr key={`${line.date}-${line.reference}-${i}`}>
                      <td dir="ltr">{line.date}</td>
                      <td dir="ltr">{line.reference || "—"}</td>
                      <td>{line.kind}{line.reason ? ` — ${line.reason}` : ""}</td>
                      <td className="num">{line.amount}</td>
                      <td className="num">{line.total || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}

        {doc.totals.length > 0 && (
          <section className="zeman-sheet__totals">
            <h3>{doc.balanceLabel}</h3>
            {doc.totals.map((t) => (
              <React.Fragment key={t.currency}>
                <div><span>{doc.sections[0].title}</span><span className="num">{t.traded}</span></div>
                {t.owed && <div><span>{t.owedLabel}</span><span className="num">{t.owed}</span></div>}
                {t.held && <div><span>{t.heldLabel}</span><span className="num">{t.held}</span></div>}
              </React.Fragment>
            ))}
          </section>
        )}

        <footer className="zeman-sheet__foot">{doc.business || BRAND.name} — {doc.issued}</footer>
      </article>

      {/* Not printed: the rules hide everything that is not the sheet, and this sits outside it. */}
      {onClose && (
        <div style={{ textAlign: "center", padding: "12px" }} className="zeman-sheet__controls">
          <button type="button" onClick={() => window.print()}>{copy.print}</button>{" "}
          <button type="button" onClick={onClose}>{copy.close}</button>
        </div>
      )}
    </div>
  );

  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

export default PrintableSheet;
