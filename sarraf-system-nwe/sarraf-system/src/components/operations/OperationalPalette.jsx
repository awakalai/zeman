import React, { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { operationalSearch, safeCommand } from "../../services/operationalControl";

const COPY = {
  ku: { trigger: "گەڕان", title: "گەڕان و فەرمانی گشتی", label: "لە تۆمارە ڕێپێدراوەکان بگەڕێ", close: "داخستنی گەڕان", searching: "گەڕان بەردەوامە", failed: "گەڕان سەرکەوتوو نەبوو", empty: "هیچ ئەنجامێکی ڕێپێدراو نەدۆزرایەوە", count: (n) => `${n} ئەنجامی ڕێپێدراو` },
  en: { trigger: "Search", title: "Global command and search", label: "Search authorized records", close: "Close search", searching: "Searching", failed: "Search failed", empty: "No authorized results", count: (n) => `${n} authorized results` },
  ar: { trigger: "بحث", title: "البحث والأوامر العامة", label: "البحث في السجلات المصرح بها", close: "إغلاق البحث", searching: "جارٍ البحث", failed: "تعذر البحث", empty: "لا توجد نتائج مصرح بها", count: (n) => `${n} نتيجة مصرح بها` },
};

// The database returns a key, not a word. A translation kept in SQL is a translation that only
// ever exists in one language, which is how every result used to come back in English inside a
// Kurdish screen.
const KIND_LABELS = {
  ku: { customer: "کڕیار", partner: "هاوبەش", transaction: "مامەڵە", receipt: "فیش",
        intake: "فیشی بارکراو", batch: "کۆمەڵە", currency: "دراو", Command: "فەرمان" },
  en: { customer: "Customer", partner: "Partner", transaction: "Transaction", receipt: "Receipt",
        intake: "Uploaded receipt", batch: "Batch", currency: "Currency", Command: "Command" },
  ar: { customer: "زبون", partner: "شريك", transaction: "معاملة", receipt: "إيصال",
        intake: "إيصال مرفوع", batch: "دفعة", currency: "عملة", Command: "أمر" },
};
const kindLabel = (lang, type) => KIND_LABELS[localeKey(lang)]?.[type] || type;

const NAV_LABELS = {
  ku: ["داشبۆرد", "پشکنینی فیش", "مامەڵەکان", "بەکارهێنەران"],
  en: ["Dashboard", "Receipts", "Transactions", "Users"],
  ar: ["لوحة التحكم", "الإيصالات", "المعاملات", "المستخدمون"],
};
const NAV_PATHS = ["#/dash", "#/receipts", "#/txs", "#/people"];
const localeKey = (lang) => lang === "en" || lang === "ar" ? lang : "ku";
const navigation = (lang) => NAV_LABELS[localeKey(lang)].map((label, index) => ({ label, kind: "navigation", type: "Command", path: NAV_PATHS[index] }));

export function OperationalPalette({ client, lang = "ku", onNavigate = (path) => { window.location.hash = path.slice(1); } }) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(""); const [results, setResults] = useState([]);
  const [active, setActive] = useState(0); const [state, setState] = useState("idle"); const trigger = useRef(null); const input = useRef(null);
  const copy = COPY[localeKey(lang)];
  useEffect(() => { const key = (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setOpen(true); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, []);
  useEffect(() => { if (open) input.current?.focus(); else trigger.current?.focus(); }, [open]);
  useEffect(() => { if (!open) return; const controller = new AbortController(); const timer = setTimeout(async () => { setState("loading"); try { const remote = await operationalSearch(client, query); if (!controller.signal.aborted) { setResults([...navigation(lang).filter((x) => x.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())), ...remote.results]); setActive(0); setState("ready"); } } catch { if (!controller.signal.aborted) setState("error"); } }, 250); return () => { controller.abort(); clearTimeout(timer); }; }, [client, lang, open, query]);
  // `focus` is what the result is about — the batch a receipt sits in — carried separately from
  // the path so that the navigation check still sees a bare hash and nothing can smuggle a query
  // string through it.
  const choose = (item) => { if (!item) return; if (safeCommand(item)) onNavigate(item.path, item.focus || null); else if (item.path && /^#\/[^?#]+$/.test(item.path)) onNavigate(item.path, item.focus || null); setOpen(false); };
  const onKeyDown = (event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } if (event.key === "ArrowDown") { event.preventDefault(); setActive((n) => Math.min(results.length - 1, n + 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setActive((n) => Math.max(0, n - 1)); } if (event.key === "Enter") { event.preventDefault(); choose(results[active]); } };
  return <><button ref={trigger} type="button" className="operation-search-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog"><Search aria-hidden="true" /> <span>{copy.trigger}</span><kbd>⌘/Ctrl K</kbd></button>{open && <div className="operation-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}><section role="dialog" aria-modal="true" aria-labelledby="operation-search-title" className="operation-dialog" onKeyDown={onKeyDown}><h2 id="operation-search-title">{copy.title}</h2><button type="button" onClick={() => setOpen(false)} aria-label={copy.close}><X aria-hidden="true" /></button><label htmlFor="operation-search-input">{copy.label}</label><input ref={input} id="operation-search-input" role="combobox" aria-expanded="true" aria-controls="operation-search-results" aria-activedescendant={results[active] ? `operation-result-${active}` : undefined} autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} /><p className="sr-only" aria-live="polite">{state === "loading" ? copy.searching : state === "error" ? copy.failed : copy.count(results.length)}</p><ul id="operation-search-results" role="listbox">{state === "error" && <li role="alert">{copy.failed}</li>}{state === "ready" && !results.length && <li>{copy.empty}</li>}{results.map((item, index) => <li key={`${item.type}-${item.path}-${index}`} id={`operation-result-${index}`} role="option" aria-selected={active === index}><button type="button" onMouseEnter={() => setActive(index)} onClick={() => choose(item)}><strong>{item.label}</strong><span>{kindLabel(lang, item.type)}{item.context ? ` · ${item.context}` : ""}</span></button></li>)}</ul></section></div>}</>;
}
