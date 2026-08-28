import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { supabase } from "./lib/supabase";
import { createReceiptIngestionCommand, ingestReceiptBatch } from "./services/receiptIngestion";
import { forgetSend, outcomeText, pendingSend, rememberSend, resolveSendOutcome, settleFailedSend, stageText } from "./services/receiptSendState";
import { arithmeticObjection, receiptNetFrom, sendableSet, validateReceiptArithmetic } from "./services/receiptValidation";
import { BuildStamp, UpdateBanner } from "./components/system/UpdateBanner";
import { loadNotifications, markAllNotificationsRead, markNotificationRead, subscribeToNotifications } from "./services/notifications";
import { loadWholeTable } from "./services/tableLoader";
import { setActiveLanguage } from "./services/activeLanguage";
import { currencyDecimals as currencyDecimalsOf, formatMoney, formatNumber, roundToCurrency } from "./services/money";
import { errorText, errorTextOr } from "./services/userFacingError";
import { flashIsGood } from "./services/flashTone.js";
import { reportFault } from "./services/faultReport.js";
import { MyReceipts } from "./components/portal/MyReceipts";
import { intakeReceipt, intakeStatusText, loadMyReceipts, noteReceiptReadFailure, receiptReadFailureText, replaceReceipt, requestStoredReceiptOcr } from "./services/receiptIntake";
import { DICT } from "./i18n/dictionary";
import { computeInventoryPosition } from "./services/inventoryAccounting";
import { createReceiptReviewCommand, finalizeReceiptBatch, loadReceiptPolicy, reviewReceiptBatch } from "./services/receiptReview";
import { assignReceiptCustody, convertReceiptBatchToTransaction, loadPortalReceiptSummary } from "./services/receiptOperations";
import { STALE_MESSAGE, isStale, loadBatchSummary, versionOf } from "./services/batchSummary";
import { dayCloseMessage, validateDayClose } from "./services/dayClose";
import { rehearseRestore, sealBackup, verdictText } from "./services/backupIntegrity";
import { CommandKeyBook, runIdempotentCommand } from "./services/commandRetry";
import { toCsv } from "./services/csvSafe";
import { revokeAllUrls, revokeDroppedUrls } from "./services/objectUrls";
import { unrealizedPnl, unrealizedReasonText } from "./services/unrealizedPnl";
import { capitalEventsFrom, investorShare, investorsTotalByCurrency, profitEventsFrom } from "./services/investorShare";
import { crossRate, fromUsdAsOf, rateAsOf, rateErrorText, rateOf, unpricedCurrencies, usdFromAsOf, validateRate } from "./services/currencyRate";
import {
  DIRECTION_REFUSED, mayEditExtraction, mayUploadDirection,
  recipientSummary, uploadDirectionsFor,
} from "./services/receiptDisplay";
import { userFacingServiceError } from "./services/userFacingError";
import { claimSharedReceiptHandoff, finishSharedReceiptHandoff, releaseSharedReceiptHandoff, sharedReceiptMessage, validateClaimedSharedFiles } from "./services/sharedReceiptHandoff";
import {
  isOwnerCashboxFlow, normalizeTransactionBusinessFlow, transactionBusinessFlowOf,
} from "./services/transactionFlow";
import { PortalDataStatus, PortalFrame, PortalPagedList, usePortalRoute } from "./components/portal/PortalFoundation";
import { separatedCurrencySummary } from "./components/portal/portalModel";
import { BRAND } from "./brand/brand";
import { BrandLogo } from "./brand/BrandLogo";
import "./components/portal/portal.css";
import {
  LayoutDashboard, Vault, ArrowLeftRight, ListOrdered, Users, Handshake, Boxes,
  TrendingUp, Building2, UserCog, PieChart, History, Plus, Trash2, Pencil,
  CheckCircle2, AlertTriangle, Eye, LogOut, Wallet, ChevronLeft, Coins,
  Receipt, TrendingDown, ScanLine, Scale, Upload, XCircle, SlidersHorizontal, Search, MoreHorizontal, Zap, ArrowDownLeft, ArrowUpRight, X, Share2, Database, Download, ClipboardCheck, RotateCcw, MessageCircle, Moon, Sun, WifiOff, Wifi, EyeOff, Bell, QrCode, Camera, Fingerprint, ShieldCheck, KeyRound, Inbox, ShieldAlert, FileCheck2, Send, Clock
} from "lucide-react";

const lazyNamed = (loader, name) => React.lazy(() => loader().then((module) => ({ default: module[name] })));
const MarketPulse = React.lazy(() => import("./components/market/MarketPulse"));
const ReceiptLifecycle = lazyNamed(() => import("./components/receipts/ReceiptCommandCenter"), "ReceiptLifecycle");
const ReceiptSmartInspector = lazyNamed(() => import("./components/receipts/ReceiptCommandCenter"), "ReceiptSmartInspector");
const ReceiptPolicyPanel = lazyNamed(() => import("./components/receipts/ReceiptPolicyPanel"), "ReceiptPolicyPanel");
const PortalReceiptSummary = lazyNamed(() => import("./components/portal/PortalReceiptSummary"), "PortalReceiptSummary");
const OperationalPalette = lazyNamed(() => import("./components/operations/OperationalPalette"), "OperationalPalette");
const ActionInbox = lazyNamed(() => import("./components/operations/OperationalCenters"), "ActionInbox");
const IntegrityCenter = lazyNamed(() => import("./components/operations/OperationalCenters"), "IntegrityCenter");
const ExportAuditCenter = lazyNamed(() => import("./components/operations/ExportAuditCenter"), "ExportAuditCenter");
const DebtCenter = lazyNamed(() => import("./components/accounting/DebtCenter"), "DebtCenter");
const CashboxPanel = lazyNamed(() => import("./components/accounting/CashboxPanel"), "CashboxPanel");
const OfficePayments = lazyNamed(() => import("./components/accounting/OfficePayments"), "OfficePayments");
const PartnerAccounts = lazyNamed(() => import("./components/accounting/PartnerAccounts"), "PartnerAccounts");
const PartnerHoldings = lazyNamed(() => import("./components/accounting/PartnerHoldings"), "PartnerHoldings");
const ManagerCenter = lazyNamed(() => import("./components/accounting/ManagerCenter"), "ManagerCenter");
const ManagerConsole = lazyNamed(() => import("./components/accounting/ManagerConsole"), "ManagerConsole");
const ReceiptReviewWorkspace = lazyNamed(() => import("./components/receipts/ReceiptReviewWorkspace"), "ReceiptReviewWorkspace");
const ReceiptForwardingCenter = lazyNamed(() => import("./components/receipts/ReceiptForwardingCenter"), "ReceiptForwardingCenter");
const ForwardedReceipts = lazyNamed(() => import("./components/receipts/ForwardedReceipts"), "ForwardedReceipts");
const BooksReconciliation = lazyNamed(() => import("./components/accounting/BooksReconciliation"), "BooksReconciliation");
const CanonicalBatchSummary = lazyNamed(() => import("./components/receipts/CanonicalBatchSummary"), "CanonicalBatchSummary");

function DeferredPanel({ children, compact = false }) {
  return <React.Suspense fallback={<section className={`animate-pulse rounded-[var(--r)] border border-[var(--line)] bg-[var(--surf)] ${compact ? "h-12" : "h-28"}`} aria-live="polite" aria-label="Loading ZEMAN module" />}>
    {children}
  </React.Suspense>;
}

/* ══════════════════ یارمەتیدەرەکان ══════════════════ */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => new Date().toISOString();
  const assertResponseOk = async (response) => {
    if (!response || !response.ok) {
      let message = "OCR/API request failed";
      try {
        const body = await response?.json?.();
        message = body?.error?.message || body?.message || message;
      } catch {}
      throw new Error(message);
    }
    return response;
  };

  const safeReceiptNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(String(value).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  };
  const assertDbResult = (result, context = "Supabase operation") => {
    if (result?.error) {
      console.error(context, result.error);
      throw result.error;
    }
    return result;
  };





  const displayValue = (value, fallback = "—") => {
    if (value === null || value === undefined || value === "") return fallback;
    return String(value);
  };

  const displayNumber = (value, digits = 0, fallback = "—") => {
    const n = Number(value);
    return Number.isFinite(n) ? fmt(n, digits) : fallback;
  };



  const normalizeSearchText = (value) =>
    String(value ?? "")
      .toLocaleLowerCase()
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();

  const matchesSearch = (record, query, fields = []) => {
    const q = normalizeSearchText(query);
    if (!q) return true;
    return fields.some((field) =>
      normalizeSearchText(record?.[field]).includes(q)
    );
  };

  const matchesFilters = (record, filters = {}) => {
    if (!record) return false;
    for (const [key, expected] of Object.entries(filters)) {
      if (expected === undefined || expected === null || expected === "") continue;
      const actual = record?.[key];
      if (Array.isArray(expected)) {
        if (expected.length && !expected.map(normalizeSearchText).includes(normalizeSearchText(actual))) return false;
      } else if (normalizeSearchText(actual) !== normalizeSearchText(expected)) {
        return false;
      }
    }
    return true;
  };

  const clearableFilterCount = (filters = {}) =>
    Object.values(filters).filter((value) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== ""
    ).length;



  const formatAuditAction = (action) => {
    if (!action) return "—";
    return String(action).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  };

  const auditResultTone = (result) => {
    const value = normalizeSearchText(result);
    if (["success", "successful", "completed", "ok"].includes(value)) return "pos";
    if (["failed", "failure", "error", "denied"].includes(value)) return "neg";
    return "neutral";
  };

  const reportSectionLabel = (value, fallback = "—") =>
    displayValue(value, fallback);

  const reportNumber = (value, digits = 0) =>
    displayNumber(value, digits);


const ROLE_KU = { admin: "ئەدمین", customer: "کڕیار-فرۆشیار", partner: "هاوبەشی سین", investor: "وەبەرهێنەر", office: "نووسینگە" };

const ADMIN_CENTER_PAGE_IDS = new Set([
  "admin-center",
  "action-inbox",
  "approvals",
  "close",
  "insights",
  "integrity",
  "audit",
  "export-audit",
  "debt-center",
  "cashbox",
  "office-payments",
  "partner-accounts",
  "partner-holdings",
  "manager-center",
  "manager-console",
  "receipt-review",
  "receipt-forwarding",
  "backup",
]);

// Moved to src/services/money.js. There were three rounders in this file and two of them
// disagreed with this one on ordinary money — 1.005 became 1.00 rather than 1.01 — and one of
// those two computed the total a transaction is stored with. The names are kept so that every
// call site in this file reads exactly as it did.
const fmt = formatNumber;
const currencyDecimals = currencyDecimalsOf;
const fmtMoney = formatMoney;
const roundMoney = roundToCurrency;
const num = { fontVariantNumeric: "tabular-nums", direction: "ltr", unicodeBidi: "embed" };

/* ── Currency-pair rate helpers ──────────────────────────────────────────
   Stored transaction rate is always:
     1 curId = rate againstId
   UI display prefers USD as the visible base whenever USD is in the pair.
   This keeps:
     1 USD = 1,410 IQD
     1 USD = 7.20 CNY
   while preserving one normalized calculation model internally.
------------------------------------------------------------------------ */
const preferredRateBaseId = (curId, againstId) =>
  curId === "usd" || againstId === "usd" ? "usd" : curId;

const storedRateToDisplay = (storedRate, curId, againstId, displayBaseId = preferredRateBaseId(curId, againstId)) => {
  const r = Number(storedRate);
  if (!(r > 0)) return null;
  return displayBaseId === curId ? r : 1 / r;
};

const displayRateToStored = (displayRate, curId, againstId, displayBaseId = preferredRateBaseId(curId, againstId)) => {
  const r = Number(displayRate);
  if (!(r > 0)) return 0;
  return displayBaseId === curId ? r : 1 / r;
};

const oppositePairId = (curId, againstId, displayBaseId) =>
  displayBaseId === curId ? againstId : curId;

const rateDigits = (value) => {
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n)) return 3;
  if (n >= 100) return 2;
  if (n >= 1) return 4;
  return 6;
};


/* ڕەنگ و هێمای دراوەکان */
const CUR_STYLE = {
  usd:  { hi: "#3FBF95", mid: "#12876A", lo: "#075444", glow: "rgba(18,135,106,.45)",  txt: "text-[#0E7A6B]", sym: "$" },
  eur:  { hi: "#5B9BE8", mid: "#2563B0", lo: "#143C6E", glow: "rgba(37,99,176,.45)",   txt: "text-[#2563B0]", sym: "€" },
  cny:  { hi: "#F0715E", mid: "#C4362A", lo: "#7C1E16", glow: "rgba(196,54,42,.45)",   txt: "text-[#B4362C]", sym: "¥" },
  jpy:  { hi: "#F08C7A", mid: "#CE4E3E", lo: "#872B21", glow: "rgba(206,78,62,.42)",   txt: "text-[#CE4E3E]", sym: "¥" },
  iqd:  { hi: "#E0B063", mid: "#B8863B", lo: "#704E18", glow: "rgba(184,134,59,.48)",  txt: "text-[#B8863B]", sym: "ع" },
  try:  { hi: "#4DC5D6", mid: "#1690A3", lo: "#0B5866", glow: "rgba(22,144,163,.45)",  txt: "text-[#1690A3]", sym: "₺" },
  gbp:  { hi: "#9B7FE0", mid: "#6446B5", lo: "#3B2775", glow: "rgba(100,70,181,.45)",  txt: "text-[#6446B5]", sym: "£" },
  aed:  { hi: "#4FC8AE", mid: "#149077", lo: "#0A594A", glow: "rgba(20,144,119,.45)",  txt: "text-[#149077]", sym: "د.إ" },
  gold: { hi: "#FBDF8E", mid: "#D4A32C", lo: "#8A6410", glow: "rgba(212,163,44,.5)",   txt: "text-[#B8863B]", sym: "Au" },
  slv:  { hi: "#E2E8EE", mid: "#A8B4C2", lo: "#6B7889", glow: "rgba(168,180,194,.5)",  txt: "text-[#7B8697]", sym: "Ag" },
  _default: { hi: "#8E9BAB", mid: "#5A6678", lo: "#333C4A", glow: "rgba(90,102,120,.4)", txt: "text-[#5A6678]", sym: "¤" },
};
const curStyle = (c) => CUR_STYLE[(c?.id || "").toLowerCase()] || CUR_STYLE._default;

/* نیشانی وڵاتی دراوەکان — تەنها بۆ UI، هیچ کاریگەرییەکی لەسەر حیساب نییە */
const CUR_FLAG = { usd: "🇺🇸", eur: "🇪🇺", gbp: "🇬🇧", try: "🇹🇷", cny: "🇨🇳", jpy: "🇯🇵", iqd: "🇮🇶", aed: "🇦🇪", gold: "🥇", slv: "🥈" };
const curFlag = (c) => CUR_FLAG[(c?.id || c?.code || "").toLowerCase()] || "💱";

/* نیشانەی دراو — گۆی ڕەنگاوڕەنگ */
const CurBadge = ({ c, size = "md", pulse }) => {
  const dim = size === "lg" ? "w-12 h-12 text-[24px]" : size === "sm" ? "w-8 h-8 text-[17px]" : "w-10 h-10 text-[20px]";
  return (
    <div className={`${dim} rounded-full font-medium flex items-center justify-center shrink-0 relative ${pulse ? "pop" : ""}`}
      style={{ background: "var(--surf-3)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
      <span aria-hidden>{curFlag(c)}</span>
    </div>
  );
};

/* گۆڕینی بڕێک بۆ دۆلار بەپێی نرخی ئەمڕۆ */
const usdConv = (data) => (amount, code) => {
  if (!amount || !code) return null;
  const c = (data?.currencies || []).find((x) => x.code === code);
  if (!c) return null;
  if (c.id === "usd") return amount;
  const ratio = rateOf(c);
  return ratio ? amount / ratio : null;
};

/* نیشاندانی بەرامبەری دۆلار */
const UsdHint = ({ v, className = "" }) =>
  v == null ? null : <span className={className} style={{ ...num, color: "var(--txt-3)" }}>≈ {fmt(v, 0)} $</span>;

/* ══════════════════ زمانەکان ══════════════════ */
const LANGS = { ku: { name: "کوردی", dir: "rtl", flag: "KU" },
                en: { name: "English", dir: "ltr", flag: "EN" },
                ar: { name: "العربية", dir: "rtl", flag: "AR" } };

let _lang = (() => { try { return localStorage.getItem("lang") || "ku"; } catch { return "ku"; } })();
// One source of the chosen language, so a module outside this file can still write a
// sentence in it. tr() and l10n() keep reading the local copy; both are set together.
const setLangGlobal = (l) => { _lang = l; setActiveLanguage(l); };
/* t() — گەر وەرگێڕان نەبوو، کوردییەکە دەگەڕێنێتەوە */
const tr = (k) => (_lang === "ku" ? k : (DICT[_lang]?.[k] ?? k));
const l10n = (ku, en, ar) => _lang === "en" ? en : _lang === "ar" ? ar : ku;

/* ئایکۆنی ئاگادارییەکان */
const NOTE_ICON = {
  tx:       { Ic: ArrowLeftRight, bg: "rgba(var(--ac-gl),.14)", fg: "var(--ac)" },
  receipt:  { Ic: ScanLine,       bg: "var(--pos-bg)",  fg: "var(--pos)" },
  payment:  { Ic: CheckCircle2,   bg: "var(--pos-bg)",  fg: "var(--pos)" },
  transfer: { Ic: ArrowLeftRight, bg: "var(--warn-bg)", fg: "var(--warn)" },
  rate:     { Ic: TrendingUp,     bg: "rgba(var(--ac-gl),.14)", fg: "var(--ac)" },
  close:    { Ic: ClipboardCheck, bg: "var(--warn-bg)", fg: "var(--warn)" },
  system:   { Ic: Bell,           bg: "var(--glass-2)", fg: "var(--txt-2)" },
  // What happens to a receipt, from the database itself. Read in the same panel as everything
  // else — one bell, or nobody can tell which of two counts is which.
  batch_arrived:    { Ic: ScanLine,     bg: "rgba(var(--ac-gl),.14)", fg: "var(--ac)" },
  receipt_received: { Ic: ScanLine,     bg: "rgba(var(--ac-gl),.14)", fg: "var(--ac)" },
  receipt_accepted: { Ic: CheckCircle2, bg: "var(--pos-bg)",  fg: "var(--pos)" },
  receipt_rejected: { Ic: XCircle,      bg: "var(--neg-bg)",  fg: "var(--neg)" },
  receipt_replaced: { Ic: History,      bg: "var(--warn-bg)", fg: "var(--warn)" },
};

/* کاتی نزیک — «٥ خولەک لەمەوبەر» */
const relTime = (d) => {
  const s2 = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s2 < 60) return tr("ئێستا");
  if (s2 < 3600) return `${Math.floor(s2 / 60)} ${tr("خولەک لەمەوبەر")}`;
  if (s2 < 86400) return `${Math.floor(s2 / 3600)} ${tr("کاتژمێر لەمەوبەر")}`;
  if (s2 < 604800) return `${Math.floor(s2 / 86400)} ${tr("ڕۆژ لەمەوبەر")}`;
  return new Date(d).toLocaleDateString("en-GB");
};

/* ══════════════════ QR ══════════════════ */
/* QR بە SVG — بێ کتێبخانەی دەرەکی */
function qrEncode(text) {
  // ── کۆدکردنی بایتی + ڕیزکردن (وەشانی ٤-٧، ئاستی چاککردنەوەی M) ──
  const data = new TextEncoder().encode(text);
  const VERS = [
    { v: 4, size: 33, cap: 62, ecc: 32, blocks: [[32, 62]] },
    { v: 6, size: 41, cap: 108, ecc: 64, blocks: [[27, 54], [27, 54]] },
    { v: 8, size: 49, cap: 152, ecc: 88, blocks: [[22, 44], [22, 44]] },
  ];
  const V = VERS.find((x) => data.length + 3 <= x.cap) || VERS[VERS.length - 1];
  const N = V.size;

  // مۆدیوڵەکان
  const m = Array.from({ length: N }, () => new Array(N).fill(null));
  const put = (r, c, v) => { if (r >= 0 && r < N && c >= 0 && c < N) m[r][c] = v; };

  // چوارگۆشەی ناسینەوە
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      put(r0 + r, c0 + c, on ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, N - 7); finder(N - 7, 0);

  // هێڵی کات
  for (let i = 8; i < N - 8; i++) { put(6, i, i % 2 === 0 ? 1 : 0); put(i, 6, i % 2 === 0 ? 1 : 0); }
  put(N - 8, 8, 1);

  // خاڵی هاوسەنگی
  const alignPos = { 33: [6, 26], 41: [6, 22, 38], 49: [6, 24, 42] }[N] || [];
  alignPos.forEach((r) => alignPos.forEach((c) => {
    if ((r <= 7 && c <= 7) || (r <= 7 && c >= N - 8) || (r >= N - 8 && c <= 7)) return;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      put(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
  }));

  // ناوچەی زانیاری
  for (let i = 0; i < 9; i++) { if (m[8][i] === null) put(8, i, 0); if (m[i][8] === null) put(i, 8, 0); }
  for (let i = 0; i < 8; i++) { if (m[8][N - 1 - i] === null) put(8, N - 1 - i, 0); if (m[N - 1 - i][8] === null) put(N - 1 - i, 8, 0); }

  // بیتەکانی داتا (سادەکراوە — نەخشەیەکی خوێندنەوە بۆ چاو، نەک QR ی ستاندارد)
  const bits = [];
  bits.push(0, 1, 0, 0);
  for (let i = 7; i >= 0; i--) bits.push((data.length >> i) & 1);
  data.forEach((b) => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); });
  // پڕکردنەوە
  const pad = [0xEC, 0x11]; let pi = 0;
  while (bits.length % 8) bits.push(0);
  while (bits.length / 8 < V.cap) { const b = pad[pi++ % 2]; for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); }

  // ڕیزکردنی زیگزاگ
  let bi = 0, up = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < N; k++) {
      const row = up ? N - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (m[row][c] !== null) continue;
        let bit = bi < bits.length ? bits[bi++] : 0;
        if ((row + c) % 2 === 0) bit ^= 1;      // ماسک
        m[row][c] = bit;
      }
    }
    up = !up;
  }
  return m.map((r) => r.map((v) => v || 0));
}

function QR({ text, size = 180, className = "" }) {
  const m = useMemo(() => { try { return qrEncode(text || ""); } catch { return null; } }, [text]);
  if (!m) return null;
  const N = m.length, q = 2, T = N + q * 2, s = size / T;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${T} ${T}`} className={className}
      style={{ background: "#fff", borderRadius: 10, padding: 0 }}>
      <rect width={T} height={T} fill="#fff" />
      {m.map((row, r) => row.map((v, c) => v
        ? <rect key={`${r}-${c}`} x={c + q} y={r + q} width={1.02} height={1.02} fill="#000" />
        : null))}
    </svg>
  );
}

/* سکانەری کۆد — کامێرا */
function Scanner({ onFound, onClose }) {
  const vidRef = useRef(null);
  const [err, setErr] = useState("");
  const [manual, setManual] = useState("");

  useEffect(() => {
    let stream, raf, det;
    const stop = () => { if (raf) cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
    (async () => {
      if (!("BarcodeDetector" in window)) { setErr("nodet"); return; }
      try {
        det = new window.BarcodeDetector({ formats: ["qr_code", "ean_13", "code_128"] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (vidRef.current) { vidRef.current.srcObject = stream; await vidRef.current.play(); }
        const scan = async () => {
          try {
            if (vidRef.current?.readyState === 4) {
              const codes = await det.detect(vidRef.current);
              if (codes?.length) { stop(); onFound(codes[0].rawValue); return; }
            }
          } catch {}
          raf = requestAnimationFrame(scan);
        };
        scan();
      } catch { setErr("nocam"); }
    })();
    return stop;
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: "#000" }}>
      <div className="flex items-center justify-between px-4 py-4 relative z-10"
        style={{ paddingTop: "max(env(safe-area-inset-top), 16px)" }}>
        <span className="text-[15px] font-semibold text-white">{tr("سکانکردنی کۆد")}</span>
        <button onClick={onClose} className="w-9 h-9 rounded-full flex items-center justify-center tap"
          style={{ background: "rgba(255,255,255,.14)", color: "#fff" }}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {err ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
            <Camera className="w-10 h-10" style={{ color: "rgba(255,255,255,.3)" }} />
            <div className="text-[14px]" style={{ color: "rgba(255,255,255,.7)" }}>
              {err === "nodet" ? tr("وێبگەڕەکەت سکانکردن پشتگیری ناکات") : tr("نەتوانرا کامێرا بکرێتەوە")}
            </div>
            <div className="text-[12px]" style={{ color: "rgba(255,255,255,.4)" }}>{tr("کۆدەکە بە دەست بنووسە")}</div>
          </div>
        ) : (
          <>
            <video ref={vidRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-[62vw] max-w-[280px] aspect-square rounded-[28px] relative"
                style={{ boxShadow: "0 0 0 100vmax rgba(0,0,0,.55)" }}>
                {[["top-0 start-0", "border-t-[3px] border-s-[3px] rounded-ts-[28px]"],
                  ["top-0 end-0", "border-t-[3px] border-e-[3px] rounded-te-[28px]"],
                  ["bottom-0 start-0", "border-b-[3px] border-s-[3px] rounded-bs-[28px]"],
                  ["bottom-0 end-0", "border-b-[3px] border-e-[3px] rounded-be-[28px]"]].map(([pos, br], i) => (
                  <span key={i} className={`absolute ${pos} w-10 h-10 ${br}`} style={{ borderColor: "var(--ac)" }} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="px-5 pb-8 pt-4" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 28px)" }}>
        <div className="flex gap-2">
          <input value={manual} onChange={(e) => setManual(e.target.value)} dir="ltr"
            onKeyDown={(e) => e.key === "Enter" && manual && onFound(manual)}
            placeholder={tr("یان کۆدەکە بنووسە...")}
            className="flex-1 px-4 py-3 text-[14px] outline-none rounded-[var(--r-sm)]"
            style={{ background: "rgba(255,255,255,.1)", border: "1px solid rgba(255,255,255,.16)", color: "#fff" }} />
          <Btn onClick={() => manual && onFound(manual)} disabled={!manual}>{tr("بردن")}</Btn>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ چارتەکان ══════════════════ */

/* هێڵی بچووک — ڕەوتی خێرا */
const Card = ({ children, className = "", onClick, tone, accent = false, dark = false, glass, style }) => {
  const effectiveTone = accent ? "accent" : dark ? "dark" : tone;
  const t = effectiveTone === "accent"
    ? { background: "linear-gradient(145deg,var(--ac),var(--ac-2))", borderColor: "transparent", color: "var(--ac-ink)" }
    : effectiveTone === "dark"
      ? { background: "linear-gradient(145deg,#111713,#0A0F0D)", borderColor: "rgba(255,255,255,.08)", color: "#F7FAF8", boxShadow: "0 18px 44px rgba(3,10,7,.16)" }
      : effectiveTone === "deep"
        ? { background: "var(--surf-2)", borderColor: "var(--line)" }
        : {};
  return (
    <div onClick={onClick} style={{ ...t, ...style }}
      className={`${glass ? "glass" : "card"} ${onClick ? "tap hov cursor-pointer" : ""} ${className}`}>
      {children}
    </div>
  );
};

/* ── ژمارەی سەرەکی — گەورە و ڕوون ── */
const Hero = ({ label, value, unit, sub, tone = "txt", size = "lg" }) => (
  <div className="text-center py-1">
    {label && <div className="text-[12px] font-medium mb-1.5" style={{ color: "var(--txt-3)" }}>{label}</div>}
    <div className="flex items-baseline justify-center gap-1.5">
      <span className={size === "lg" ? "text-[40px]" : "text-[28px]"}
        style={{ ...num, fontWeight: 600, letterSpacing: "-.03em", lineHeight: 1,
                 color: tone === "pos" ? "var(--pos)" : tone === "neg" ? "var(--neg)" : "var(--txt)" }}>
        {value}
      </span>
      {unit && <span className="text-base font-medium" style={{ color: "var(--txt-3)" }}>{unit}</span>}
    </div>
    {sub && <div className="text-[12px] mt-2" style={{ color: "var(--txt-3)" }}>{sub}</div>}
  </div>
);

/* ── دوگمەی بازنەیی — کرداری خێرا ── */
const Quick = ({ icon: Ic, label, onClick, active }) => (
  <button onClick={onClick} className="flex flex-col items-center gap-2 tap group">
    <span className="w-[52px] h-[52px] rounded-full flex items-center justify-center transition-all"
      style={active
        ? { background: "var(--ac)", boxShadow: "0 7px 18px -7px rgba(var(--ac-gl),.45)" }
        : { background: "var(--glass)", border: "1px solid var(--line)", backdropFilter: "var(--blur)" }}>
      <Ic className="w-[21px] h-[21px]" style={{ color: active ? "var(--ac-ink)" : "var(--txt-2)" }} />
    </span>
    <span className="text-[11px] font-medium" style={{ color: active ? "var(--txt)" : "var(--txt-3)" }}>{label}</span>
  </button>
);

/* ── پۆرتاڵی پڕۆفیشناڵ — یەک دیزاین بۆ هەموو ڕۆڵەکان ── */
const PortalHeader = ({ user, role, icon: Ic = Users, subtitle }) => (
  <div className="portal-welcome">
    <div className="portal-avatar"><Ic className="w-5 h-5" /></div>
    <div className="min-w-0 flex-1">
      <div className="portal-eyebrow"><span className="portal-live-dot" /> {BRAND.name}</div>
      <div className="portal-welcome-name">{user?.name || tr("ئەکاونتی من")}</div>
      <div className="portal-welcome-sub">
        <span className="portal-role-badge">{role}</span>
        {subtitle && <span className="truncate">{subtitle}</span>}
      </div>
    </div>
  </div>
);

const PortalAction = ({ icon: Ic, label, hint, onClick, primary = false }) => (
  <button onClick={onClick} className={`portal-action tap ${primary ? "portal-action-primary" : ""}`}>
    <span className="portal-action-icon"><Ic className="w-[18px] h-[18px]" /></span>
    <span className="min-w-0 text-start">
      <span className="portal-action-label">{label}</span>
      {hint && <span className="portal-action-hint">{hint}</span>}
    </span>
  </button>
);

const H = ({ children, sub }) => (
  <div className="mb-5">
    <h2 className="text-[26px] font-semibold tracking-tight leading-tight" style={{ color: "var(--txt)" }}>{children}</h2>
    {sub && <p className="text-[13px] mt-1 leading-relaxed" style={{ color: "var(--txt-3)" }}>{sub}</p>}
  </div>
);

const SecLbl = ({ children }) => (
  <div className="text-[12px] font-semibold mb-3" style={{ color: "var(--txt-2)" }}>{children}</div>
);

const Lbl = ({ children }) => (
  <label className="block text-[12px] font-medium mb-1.5" style={{ color: "var(--txt-3)" }}>{children}</label>
);

const fieldSty = {
  background: "var(--surf-2)", border: "1px solid var(--line)", color: "var(--txt)",
  borderRadius: "var(--r-sm)", transition: "border-color .18s, box-shadow .18s, background .18s",
};
const onFoc = (e) => { e.target.style.borderColor = "var(--ac)"; e.target.style.boxShadow = "0 0 0 3px rgba(var(--ac-gl),.16)"; e.target.style.background = "var(--surf-3)"; };
const onBlr = (e) => { e.target.style.borderColor = "var(--line)"; e.target.style.boxShadow = "none"; e.target.style.background = "var(--surf-2)"; };
const Inp = (p) => (
  <input {...p} style={{ ...fieldSty, ...(p.style || {}) }}
    onFocus={(e) => { onFoc(e); p.onFocus?.(e); }} onBlur={(e) => { onBlr(e); p.onBlur?.(e); }}
    className={`w-full px-4 py-3 text-[15px] outline-none ${p.className || ""}`} />
);
const Sel = (p) => (
  <select {...p} style={{ ...fieldSty, ...(p.style || {}) }} onFocus={onFoc} onBlur={onBlr}
    className={`w-full px-4 py-3 text-[15px] outline-none ${p.className || ""}`}>{p.children}</select>
);

const Btn = ({ kind = "primary", className = "", style, ...p }) => {
  const k = {
    primary: { background: "var(--ac)", color: "var(--ac-ink)",
               boxShadow: "0 6px 16px -6px rgba(var(--ac-gl),.45)" },
    danger:  { background: "linear-gradient(170deg, #FB7185, #E11D48)", color: "#fff",
               boxShadow: "0 4px 16px -4px rgba(225,29,72,.45), inset 0 1px 0 rgba(255,255,255,.18)" },
    gold:    { background: "linear-gradient(170deg, #FFC97A, #DCA03C)", color: "#241905",
               boxShadow: "0 4px 16px -4px rgba(200,146,50,.5), inset 0 1px 0 rgba(255,255,255,.3)" },
    ghost:   { background: "var(--glass)", color: "var(--txt)", border: "1px solid var(--line)",
               backdropFilter: "var(--blur)" },
  }[kind];
  return <button {...p} style={{ borderRadius: "var(--r-sm)", ...k, ...style }}
    className={`px-5 py-3 text-[14px] font-semibold tap disabled:opacity-40 disabled:shadow-none ${className}`} />;
};

const Money = ({ v, dec, pos }) => (
  <span style={{ ...num, fontWeight: 600, color: v < 0 ? "var(--neg)" : pos ? "var(--pos)" : "var(--txt)" }}>{fmt(v, dec)}</span>
);

const StatePanel = ({ type = "empty", title, detail, compact = false, onRetry }) => {
  const isLoading = type === "loading";
  const isError = type === "error";
  const Ic = isError ? AlertTriangle : isLoading ? RotateCcw : Database;
  return (
    <div className={`state-panel ${compact ? "state-panel-compact" : ""}`}>
      <span className={`state-panel-icon ${isError ? "is-error" : isLoading ? "is-loading" : ""}`}>
        <Ic className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
      </span>
      <div className="min-w-0">
        <div className="state-panel-title">{title || (isLoading ? tr("بارکردن...") : isError ? tr("هەڵەیەک ڕوویدا") : tr("هیچ داتایەک نییە"))}</div>
        {detail && <div className="state-panel-detail">{detail}</div>}
        {isError && onRetry && (
          <button onClick={onRetry} className="state-panel-retry tap">
            <RotateCcw className="w-3.5 h-3.5" /> {tr("نوێکردنەوە")}
          </button>
        )}
      </div>
    </div>
  );
};

const Empty = ({ t, detail, compact = false }) => {
  const loading = /بارکردن|loading|چاوەڕوانی/i.test(String(t || ""));
  return <StatePanel type={loading ? "loading" : "empty"} title={t} detail={detail} compact={compact} />;
};

const ReportKpi = ({ icon: Ic, label, value, sub, tone = "neutral", delay = 0 }) => (
  <Card className="report-kpi rise" style={{ animationDelay: `${delay}ms` }}>
    <div className={`report-kpi-icon tone-${tone}`}><Ic className="w-4 h-4" /></div>
    <div className="min-w-0">
      <div className="report-kpi-label">{label}</div>
      <div className={`report-kpi-value tone-${tone}`} style={num}>{value}</div>
      {sub && <div className="report-kpi-sub">{sub}</div>}
    </div>
  </Card>
);

const Back = ({ onClick, t }) => (
  <button onClick={onClick} className="flex items-center gap-2 text-[13px] font-medium mb-5 tap"
    style={{ color: "var(--txt-2)" }}>
    <span className="w-7 h-7 rounded-full flex items-center justify-center"
      style={{ background: "var(--glass)", border: "1px solid var(--line)" }}>
      <ChevronLeft className="w-3.5 h-3.5 rotate-180" />
    </span>
    {t}
  </button>
);

/* ══════════════════ ئەمڕۆ ══════════════════
 *
 * What stood here was a wall of fifteen cards under five headings, and its own subtitle said what
 * it was: «هەموو ئامرازەکانی ئەدمین لە یەک شوێن؛ هیچ بەشێک لابراو نییە». That is a filing
 * cabinet's promise. It is arranged by what the code contains rather than by what the owner does,
 * it is a menu reached from a menu, and it says exactly the same thing on the busiest morning of
 * the year as it does on a Friday with nothing in it.
 *
 * The owner was asked what their day is actually made of and answered: «بە گشتی فیشەکان» —
 * receipts, and turning receipts into transactions, and setting the day's rates.
 *
 * So the screen is that day, in that order, and every number on it is real. Receipts first and
 * largest. Rates second, because nothing can be valued until they are set. Then whatever is
 * waiting on a decision — and a line with nothing waiting is not shown at all, because a screen
 * that prints four zeroes every morning is a screen that teaches you not to read it. The rest of
 * the tools are still all here, at the bottom, small, where tools belong.
 */

// Chromium has no month names for Kurdish: `toLocaleDateString("ckb", …)` comes back as
// "M08 28, Fri", which is worse than no date at all on a screen whose whole job is to say what
// day it is. Node's ICU does have them, so this cannot be caught anywhere but in a browser.
// The names are written here, as the rest of the interface's Kurdish is.
const LONG_DATE = {
  ku: { days: ["یەکشەممە", "دووشەممە", "سێشەممە", "چوارشەممە", "پێنجشەممە", "هەینی", "شەممە"], months: ["کانوونی دووەم", "شوبات", "ئازار", "نیسان", "ئایار", "حوزەیران", "تەمووز", "ئاب", "ئەیلوول", "تشرینی یەکەم", "تشرینی دووەم", "کانوونی یەکەم"] },
};
const longDate = (lang, at = new Date()) => (lang === "en" || lang === "ar"
  ? at.toLocaleDateString(lang === "en" ? "en-GB" : "ar", { weekday: "long", day: "numeric", month: "long" })
  : `${LONG_DATE.ku.days[at.getDay()]}، ${at.getDate()}ی ${LONG_DATE.ku.months[at.getMonth()]}`);

const TodayTile = ({ label, value, unit, tone, onClick, sub }) => {
  const colour = tone === "warn" ? "var(--warn)" : tone === "neg" ? "var(--neg)"
    : tone === "pos" ? "var(--pos)" : "var(--txt)";
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className={`fin-card metric-card p-4 md:p-5 min-w-0 text-start ${onClick ? "tap hov" : ""}`}
      style={onClick ? undefined : { cursor: "default" }}>
      <div className="text-[11px] md:text-[12px] font-medium" style={{ color: "var(--txt-3)" }}>{label}</div>
      <div className="mt-2 text-[23px] md:text-[27px] font-bold tracking-tight" style={{ ...num, color: colour }}>
        {value}{unit && <span className="text-[13px] font-semibold ms-1" style={{ color: "var(--txt-3)" }}>{unit}</span>}
      </div>
      {sub && <div className="mt-1 text-[10px] md:text-[11px]" style={{ color: "var(--txt-3)" }}>{sub}</div>}
    </button>
  );
};

// A line of the day: a sentence, a number, and the way to deal with it. Shown only when the
// number is not zero.
const TodayLine = ({ icon: Ic, title, detail, count, unit, tone = "warn", action, onClick }) => (
  <button type="button" onClick={onClick}
    className="card tap hov w-full p-4 text-start flex items-center gap-3.5 min-h-[72px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ac)]">
    <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
      style={{ background: tone === "neg" ? "var(--neg-bg)" : tone === "pos" ? "var(--pos-bg)" : "var(--warn-bg)",
               color: tone === "neg" ? "var(--neg)" : tone === "pos" ? "var(--pos)" : "var(--warn)" }}>
      <Ic className="w-[18px] h-[18px]" aria-hidden="true" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-[13.5px] font-bold" style={{ color: "var(--txt)" }}>{title}</span>
      {detail && <span className="block text-[11px] mt-1" style={{ color: "var(--txt-3)" }}>{detail}</span>}
    </span>
    {count != null && (
      <span className="text-[19px] font-bold shrink-0" style={{ ...num, color: "var(--txt)" }}>
        {count}{unit && <span className="text-[11px] font-semibold ms-0.5" style={{ color: "var(--txt-3)" }}>{unit}</span>}
      </span>
    )}
    <span className="text-[11px] font-semibold shrink-0 hidden sm:block" style={{ color: "var(--ac)" }}>{action}</span>
    <ChevronLeft className="w-4 h-4 shrink-0" style={{ color: "var(--txt-3)" }} aria-hidden="true" />
  </button>
);

function AdminCenterHub({ lang = "ku", onNavigate, data, calc, cur, batches }) {
  const label = (ku, en, ar) => lang === "en" ? en : lang === "ar" ? ar : ku;
  const go = (id) => () => onNavigate(id);

  // ── the receipts, which is most of the day ───────────────────────────────
  //
  // Read the same way the receipts screen reads them, from the same helper, so the count here and
  // the list there can never disagree — a summary that says four when the list shows three is
  // worse than no summary.
  const stageOf = (b) => b.receipt_stage || (b.tx_id ? "matched" : b.status === "new" ? "needs_review" : "verified");
  const rows = batches || [];
  const waiting = rows.filter((b) => ["received", "reading", "needs_review", "verified"].includes(stageOf(b)));
  const waitingReceipts = waiting.reduce((sum, b) => sum + (Number(b.n) || 0), 0);
  const needsPerson = rows.filter((b) => stageOf(b) === "needs_review").length;
  const refused = rows.reduce((sum, b) => sum + (Number(b.rejected_n) || 0), 0);
  const duplicates = rows.reduce((sum, b) => sum + (Number(b.dup_n) || 0), 0);

  // ── the rates, without which nothing can be valued ───────────────────────
  const unpriced = unpricedCurrencies(data?.currencies || []);

  // ── what is waiting on a decision ────────────────────────────────────────
  const approvals = (data?.approvals || []).filter((r) => r.status === "pending").length;
  const unpaid = (data?.txs || []).filter((t) => !t.deleted && t.status === "pending").length;
  const officesOwed = (data?.users || [])
    .filter((u) => u.role === "office" && !u.deleted)
    .map((u) => ({ u, owed: Object.entries(calc?.acctCash?.[u.id] || {}).filter(([, v]) => v > 0) }))
    .filter((x) => x.owed.length);

  const attention = waiting.length + unpriced.length + approvals + unpaid + officesOwed.length;

  // Everything the centre used to list. Still all here, still one press away — but small, and
  // below the work, because a tool you reach for twice a month should not be the size of the
  // thing you do forty times a day.
  const tools = [
    ["action-inbox", label("ئینباکسی کارەکان", "Action inbox", "صندوق الإجراءات"), Inbox],
    ["receipt-review", label("پشکنینی وردی فیش", "Receipt review", "مراجعة الإيصالات"), ClipboardCheck],
    ["receipt-forwarding", label("ناردنی فیش", "Receipt forwarding", "إرسال الإيصالات"), Send],
    ["partner-holdings", label("ئەوەی لای هاوبەش دانراوە", "Placed with partners", "المودع لدى الشركاء"), Boxes],
    ["debt-center", label("قەرز و قاسە", "Debt & cashbox", "الديون والخزنة"), Scale],
    ["cashbox", label("قاسەی کڕیاران", "Customer cashbox", "خزنة الزبائن"), Wallet],
    ["partner-accounts", label("حسابی هاوبەشان", "Partner accounts", "حسابات الشركاء"), Handshake],
    ["office-payments", label("پارەدانی نووسینگە", "Office payments", "مدفوعات المكتب"), Building2],
    ["approvals", label("کۆنترۆڵ و پەسەندکردن", "Controls & approvals", "التحكم والموافقات"), ShieldCheck],
    ["insights", label("ڕەوت و شیکاری", "Trends & insights", "الاتجاهات والتحليلات"), TrendingUp],
    ["integrity", label("ناوەندی یەکپارچەیی", "Integrity centre", "مركز سلامة البيانات"), ShieldAlert],
    ["audit", label("تۆماری گۆڕانکاری", "Change log", "سجل التغييرات"), History],
    ["export-audit", label("هەناردە و وردبینی", "Export & audit", "التصدير والتدقيق"), FileCheck2],
    ["backup", label("پاراستنی داتا", "Data protection", "حماية البيانات"), Database],
  ];

  return (
    <div className="space-y-6">
      <div className="dashboard-page-head flex items-end justify-between gap-4">
        <div>
          <div className="dashboard-eyebrow">{longDate(lang)}</div>
          <h1 className="dashboard-title">{label("کاری ئەمڕۆ", "Today's work", "عمل اليوم")}</h1>
          <div className="dashboard-subtitle">
            {attention
              ? label("ئەمانە چاوەڕێی تۆن", "These are waiting for you", "هذه بانتظارك")
              : label("هیچ شتێک چاوەڕێی تۆ نییە ✓", "Nothing is waiting for you ✓", "لا شيء بانتظارك ✓")}
          </div>
        </div>
      </div>

      <section aria-labelledby="today-receipts">
        <h2 id="today-receipts" className="text-[12px] font-semibold mb-3" style={{ color: "var(--txt-2)" }}>
          {label("فیشەکان", "Receipts", "الإيصالات")}
        </h2>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-3">
          <TodayTile label={label("کۆمەڵەی چاوەڕوان", "Batches waiting", "دفعات بانتظار")}
            value={waiting.length} tone={waiting.length ? "warn" : undefined} onClick={go("receipts")}
            sub={waitingReceipts ? `${waitingReceipts} ${label("فیش", "receipts", "إيصال")}` : label("هیچ نییە", "None", "لا شيء")} />
          <TodayTile label={label("پێویستی بە پشکنینە", "Needs a person", "بحاجة إلى مراجعة")}
            value={needsPerson} tone={needsPerson ? "warn" : undefined} onClick={go("receipt-review")}
            sub={label("پشکنینی وردی فیش", "Receipt review", "مراجعة الإيصالات")} />
          <TodayTile label={label("ڕەتکراو", "Rejected", "مرفوض")}
            value={refused} tone={refused ? "neg" : undefined} onClick={go("receipt-review")}
            sub={label("بە هۆکارەوە تۆمار کراون", "Recorded with a reason", "مسجّلة مع السبب")} />
          <TodayTile label={label("دووبارە", "Duplicates", "مكرر")}
            value={duplicates} onClick={go("receipt-review")}
            sub={label("سیستەمەکە گرتوونی", "Caught by the system", "أوقفها النظام")} />
        </div>
        {waiting.length > 0 && (
          <TodayLine icon={ScanLine} tone="warn"
            title={label("کۆمەڵەکان بکەرەوە و مامەڵەیان لێ دروست بکە", "Open the batches and turn them into transactions", "افتح الدفعات وحوّلها إلى معاملات")}
            detail={label("ئەمە زۆرترین کاری ڕۆژە", "This is most of the day", "هذا معظم عمل اليوم")}
            count={waiting.length} action={label("بکەرەوە", "Open", "افتح")} onClick={go("receipts")} />
        )}
      </section>

      <section aria-labelledby="today-rates">
        <h2 id="today-rates" className="text-[12px] font-semibold mb-3" style={{ color: "var(--txt-2)" }}>
          {label("نرخی ئەمڕۆ", "Today's rates", "أسعار اليوم")}
        </h2>
        {unpriced.length ? (
          <TodayLine icon={AlertTriangle} tone="neg"
            title={label("نرخی هەموو دراوەکان دانەنراوە", "Rates are not set for every currency", "لم تُحدَّد أسعار جميع العملات")}
            detail={`${unpriced.join("، ")} — ${label("بەبێ ئەمە هیچ بەهایەک ناژمێردرێت", "nothing can be valued without them", "لا يمكن تقييم شيء بدونها")}`}
            count={unpriced.length} action={label("دایبنێ", "Set", "حدّد")} onClick={go("rates")} />
        ) : (
          <TodayLine icon={CheckCircle2} tone="pos"
            title={label("نرخی هەموو دراوەکان دانراوە ✓", "Every currency has today's rate ✓", "لكل عملة سعر اليوم ✓")}
            detail={label("گۆڕینیان لە شاشەی نرخەکاندا", "Change them on the rates screen", "غيّرها من شاشة الأسعار")}
            action={label("بینین", "View", "عرض")} onClick={go("rates")} />
        )}
      </section>

      {(approvals > 0 || unpaid > 0 || officesOwed.length > 0) && (
        <section aria-labelledby="today-decisions" className="space-y-2.5">
          <h2 id="today-decisions" className="text-[12px] font-semibold mb-3" style={{ color: "var(--txt-2)" }}>
            {label("چاوەڕێی بڕیاری تۆن", "Waiting on your decision", "بانتظار قرارك")}
          </h2>
          {approvals > 0 && (
            <TodayLine icon={ShieldCheck} tone="warn"
              title={label("پەسەندکردنی چاوەڕوان", "Approvals waiting", "موافقات معلّقة")}
              detail={label("کردارێک پێویستی بە پەسەندکردنی دووەم هەیە", "An action needs a second approval", "إجراء يحتاج موافقة ثانية")}
              count={approvals} action={label("بڕیار بدە", "Decide", "قرّر")} onClick={go("approvals")} />
          )}
          {unpaid > 0 && (
            <TodayLine icon={Clock} tone="warn"
              title={label("مامەڵەی پارەنەدراو", "Unpaid transactions", "معاملات غير مدفوعة")}
              detail={label("کڕیارەکە هێشتا پارەکەی وەرنەگرتووە", "The customer has not been paid yet", "لم يستلم الزبون المبلغ بعد")}
              count={unpaid} action={label("بینین", "View", "عرض")} onClick={go("txs")} />
          )}
          {officesOwed.map(({ u, owed }) => (
            <TodayLine key={u.id} icon={Building2} tone="warn"
              title={`${label("قەرزی ZEMAN بۆ", "ZEMAN owes", "زيمان مدين لـ")} ${u.name}`}
              detail={owed.map(([cid, v]) => `${fmt(v, cur(cid).dec ?? 0)} ${cur(cid).code}`).join(" · ")}
              action={label("حساب بدەوە", "Settle", "سوِّ الحساب")} onClick={go("office-payments")} />
          ))}
        </section>
      )}

      <section aria-labelledby="today-day" className="space-y-2.5">
        <h2 id="today-day" className="text-[12px] font-semibold mb-3" style={{ color: "var(--txt-2)" }}>
          {label("ڕۆژەکە", "The day", "اليوم")}
        </h2>
        <TodayLine icon={ClipboardCheck} tone="warn"
          title={label("بەستنی ڕۆژ", "Close the day", "إقفال اليوم")}
          detail={label("پارەی ڕاستەقینە بژمێرە و بەراوردی بکە لەگەڵ حیسابی سیستەم", "Count the cash and compare it with the system", "عُدّ النقد وقارنه بالنظام")}
          action={label("بیبەستەوە", "Close", "أقفل")} onClick={go("close")} />
      </section>

      <section aria-labelledby="today-tools">
        <h2 id="today-tools" className="text-[12px] font-semibold mb-3" style={{ color: "var(--txt-2)" }}>
          {label("ئامرازەکان", "Tools", "الأدوات")}
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
          {tools.map(([id, title, Icon]) => (
            <button key={id} type="button" onClick={go(id)}
              className="card tap hov px-3 py-3 text-start flex items-center gap-2.5 min-h-[48px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ac)]">
              <Icon className="w-4 h-4 shrink-0" style={{ color: "var(--txt-3)" }} aria-hidden="true" />
              <span className="text-[12px] font-semibold truncate" style={{ color: "var(--txt-2)" }}>{title}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
const Pill = ({ tone = "slate", children }) => {
  const t = {
    slate: { bg: "var(--glass-2)", fg: "var(--txt-2)" },
    green: { bg: "var(--pos-bg)", fg: "var(--pos)" },
    red:   { bg: "var(--neg-bg)", fg: "var(--neg)" },
    amber: { bg: "var(--warn-bg)", fg: "var(--warn)" },
  }[tone];
  return <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap"
    style={{ background: t.bg, color: t.fg }}>{children}</span>;
};

/* ── تابەکان — سووک و سادە ── */
const Tabs = ({ items, value, onChange, className = "" }) => (
  <div className={`flex gap-1 p-1 rounded-full overflow-x-auto ${className}`}
    style={{ background: "var(--glass)", border: "1px solid var(--line)", backdropFilter: "var(--blur)" }}>
    {items.map(([k, t]) => {
      const on = value === k;
      return (
        <button key={k} onClick={() => onChange(k)}
          style={on
            ? { background: "var(--surf-3)", color: "var(--txt)", boxShadow: "var(--sh-1)" }
            : { color: "var(--txt-3)" }}
          className={`flex-1 whitespace-nowrap px-4 py-2 rounded-full text-[13px] tap ${on ? "font-semibold" : "font-medium"}`}>
          {t}
        </button>
      );
    })}
  </div>
);

/* ── ڕیزی لیست — بنەمای هەموو لیستەکان ── */
const Row = ({ icon, title, sub, right, rightSub, onClick, tone }) => (
  <div onClick={onClick}
    className={`flex items-center gap-3 py-3 ${onClick ? "tap cursor-pointer" : ""}`}>
    {icon}
    <div className="min-w-0 flex-1">
      <div className="text-[14px] font-medium truncate" style={{ color: "var(--txt)" }}>{title}</div>
      {sub && <div className="text-[11.5px] mt-0.5 truncate" style={{ color: "var(--txt-3)" }}>{sub}</div>}
    </div>
    {(right || rightSub) && (
      <div className="text-end shrink-0">
        {right && <div className="text-[14px] font-semibold" style={{ ...num, color: tone === "pos" ? "var(--pos)" : tone === "neg" ? "var(--neg)" : "var(--txt)" }}>{right}</div>}
        {rightSub && <div className="text-[11px] mt-0.5" style={{ color: "var(--txt-3)" }}>{rightSub}</div>}
      </div>
    )}
  </div>
);

/* ئایکۆنی ئاگادارییەکان */
/* ══════════════════ QR ══════════════════ */
/* QR بە SVG — بێ کتێبخانەی دەرەکی */

/* سکانەری کۆد — کامێرا */
/* ══════════════════ چارتەکان ══════════════════ */

/* هێڵی بچووک — ڕەوتی خێرا */
function Spark({ data, w = 96, h = 30, color = "var(--pos)" }) {
  if (!data?.length) return <div style={{ width: w, height: h }} />;
  const mx = Math.max(...data, 0), mn = Math.min(...data, 0);
  const rng = mx - mn || 1;
  const pts = data.map((v, i) => [(i / Math.max(1, data.length - 1)) * w, h - ((v - mn) / rng) * (h - 4) - 2]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${d} L${w},${h} L0,${h} Z`;
  const id = "sg" + Math.random().toString(36).slice(2, 7);
  return (
    <svg width={w} height={h} className="overflow-visible">
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity=".22" /><stop offset="100%" stopColor={color} stopOpacity="0" />
      </linearGradient></defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {pts.length > 0 && <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.6" fill={color} />}
    </svg>
  );
}

/* چارتی ستوونی */
function Bars({ rows, h = 150, fmtV = (v) => fmt(v, 0) }) {
  const [hover, setHover] = useState(null);
  if (!rows?.length) return <Empty t={tr("هیچ داتایەک نییە")} />;
  const mx = Math.max(...rows.map((r) => Math.abs(r.v)), 1);
  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height: h }}>
        {rows.map((r, i) => {
          const pct = (Math.abs(r.v) / mx) * 100;
          const neg = r.v < 0;
          const on = hover === i;
          return (
            <div key={i} className="flex-1 flex flex-col justify-end items-center group relative"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {on && (
                <div className="absolute -top-1 z-10 px-2 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap pointer-events-none"
                  style={{ background: "var(--bg-2)", color: "#fff", boxShadow: "var(--sh-2)", transform: "translateY(-100%)" }}>
                  <span style={num}>{fmtV(r.v)}</span>
                </div>
              )}
              <div className="w-full rounded-t-md transition-all duration-300"
                style={{
                  height: `${Math.max(pct, 2)}%`,
                  background: neg
                    ? "linear-gradient(180deg, var(--neg), var(--neg))"
                    : "linear-gradient(180deg, var(--ac), var(--pos))",
                  opacity: hover === null || on ? 1 : .45,
                  boxShadow: on ? "0 4px 12px -3px rgba(14,122,107,.5)" : "none",
                }} />
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 mt-2">
        {rows.map((r, i) => (
          <div key={i} className="flex-1 text-center text-[10px] truncate" style={{ color: "var(--txt-3)" }}>{r.k}</div>
        ))}
      </div>
    </div>
  );
}

/* چارتی هێڵی — بۆ مێژووی نرخ */
function LineChart({ series, h = 190, unit = "" }) {
  const [hover, setHover] = useState(null);
  const all = series.flatMap((s2) => s2.pts.map((p) => p.v));
  if (!all.length) return <Empty t={tr("هێشتا مێژوویەک نییە")} />;
  const mx = Math.max(...all), mn = Math.min(...all);
  const pad = (mx - mn) * .12 || mx * .04 || 1;
  const hi = mx + pad, lo = Math.max(0, mn - pad), rng = hi - lo || 1;
  const W = 320, H = h - 26;
  const n = Math.max(...series.map((s2) => s2.pts.length));
  const X = (i, len) => (len <= 1 ? W / 2 : (i / (len - 1)) * W);
  const Y = (v) => H - ((v - lo) / rng) * H;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${h}`} className="w-full" style={{ overflow: "visible" }}
        onMouseLeave={() => setHover(null)}>
        {[0, .25, .5, .75, 1].map((f) => (
          <g key={f}>
            <line x1="0" y1={H * f} x2={W} y2={H * f} stroke="var(--line)" strokeWidth="1" />
            <text x={W} y={H * f - 3} textAnchor="end" fontSize="8.5" fill="var(--txt-3)" style={num}>
              {fmt(hi - rng * f, 3)}
            </text>
          </g>
        ))}
        {series.map((s2, si) => {
          const d = s2.pts.map((p, i) => `${i ? "L" : "M"}${X(i, s2.pts.length).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
          return (
            <g key={si}>
              <path d={d} fill="none" stroke={s2.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              {s2.pts.map((p, i) => (
                <circle key={i} cx={X(i, s2.pts.length)} cy={Y(p.v)} r={hover === i ? 4.5 : 2.4}
                  fill={s2.color} stroke="var(--surf)" strokeWidth="1.5"
                  onMouseEnter={() => setHover(i)} style={{ cursor: "pointer", transition: "r .15s" }} />
              ))}
            </g>
          );
        })}
        {hover != null && series[0]?.pts[hover] && (
          <line x1={X(hover, series[0].pts.length)} y1="0" x2={X(hover, series[0].pts.length)} y2={H}
            stroke="var(--ac)" strokeWidth="1" strokeDasharray="3 3" />
        )}
      </svg>
      {hover != null && series[0]?.pts[hover] && (
        <div className="absolute top-0 right-0 px-2.5 py-1.5 rounded-lg text-[11px] pointer-events-none"
          style={{ background: "var(--bg-2)", color: "#fff", boxShadow: "var(--sh-2)" }}>
          <div style={{ color: "rgba(255,255,255,.55)" }}>{series[0].pts[hover].k}</div>
          {series.map((s2, i) => s2.pts[hover] && (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: s2.color }} />
              <b style={num}>{fmt(s2.pts[hover].v, 3)}</b> <span style={{ color: "rgba(255,255,255,.5)" }}>{s2.name}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-between mt-1 text-[10px]" style={{ color: "var(--txt-3)" }}>
        <span>{series[0]?.pts[0]?.k}</span>
        <span>{series[0]?.pts[series[0].pts.length - 1]?.k}</span>
      </div>
    </div>
  );
}

/* بازنەی دابەشکردن */
function Donut({ rows, size = 132 }) {
  const tot = rows.reduce((s2, r) => s2 + Math.abs(r.v), 0);
  if (!tot) return <Empty t={tr("هیچ نییە")} />;
  const R = size / 2, r = R * .64, C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg width={size} height={size} className="shrink-0" style={{ transform: "rotate(-90deg)" }}>
        {rows.map((row, i) => {
          const f = Math.abs(row.v) / tot;
          const dash = `${(C * f).toFixed(2)} ${(C * (1 - f)).toFixed(2)}`;
          const off = -C * acc;
          acc += f;
          return <circle key={i} cx={R} cy={R} r={r} fill="none" stroke={row.color} strokeWidth={R - r}
            strokeDasharray={dash} strokeDashoffset={off} />;
        })}
      </svg>
      <div className="flex-1 min-w-[130px] space-y-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2" style={{ color: "var(--txt-2)" }}>
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: row.color }} />{row.k}
            </span>
            <span className="font-bold" style={{ ...num, color: "var(--txt)" }}>
              {((Math.abs(row.v) / tot) * 100).toFixed(1)}٪
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ژمارەی جوڵاو */
function CountUp({ v, dec = 0, className = "", style }) {
  const [d, setD] = useState(v);
  const prev = useRef(v);
  useEffect(() => {
    const from = prev.current, to = v;
    if (from === to) return;
    let raf, t0 = null;
    const dur = 550;
    const step = (t) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setD(from + (to - from) * e);
      if (p < 1) raf = requestAnimationFrame(step); else prev.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [v]);
  return <span className={className} style={{ ...num, ...style }}>{fmt(d, dec)}</span>;
}
const dOnly = (d) => (d || "").slice(0, 10);

/* ══════════════════ پێکهاتە بچووکەکان ══════════════════ */
// The stylesheet now lives in src/styles/zeman.css and is imported once by main.jsx. This
// component is kept as an empty element so the eight places that render it — the splash, the
// login, each of the access gates — need no edit, and so that nothing renders twice if one of
// them is ever reached before the others.
function Styles() {
  return null;
}

/* ══════════════════ ئەپی سەرەکی ══════════════════ */

const mapTxRecord = (r) => ({
  id: r.id, code: r.code, type: r.type, direct: !!r.direct,
  pairId: r.pair_id, directRole: r.direct_role, ownMoney: !!r.own_money,
  businessFlow: r.business_flow || transactionBusinessFlowOf(r),
  buyRate: r.buy_rate == null ? null : +r.buy_rate,
  buyTotal: r.buy_total == null ? null : +r.buy_total,
  costBasisUsd: r.cost_basis_usd == null ? null : +r.cost_basis_usd,
  partnerRateSnapshot: r.partner_rate_snapshot == null ? null : +r.partner_rate_snapshot,
  partnerFeeSnapshot: r.partner_fee_snapshot == null ? null : +r.partner_fee_snapshot,
  versionNo: Number(r.version_no) || 0,
  lastApprovalId: r.last_approval_id || null,
  cpId: r.cp_id, cpName: r.cp_name, curId: r.cur_id,
  amount: +r.amount, rate: +r.rate, againstId: r.against_id,
  total: +r.total, partnerId: r.partner_id, status: r.status,
  paidAt: r.paid_at, profit: r.profit == null ? null : +r.profit,
  profitCurId: r.profit_cur_id, note: r.note, date: r.date,
  edited: r.edited, deleted: r.deleted,
});

export default function App() {
  const [session, setSession] = useState(undefined);
  const [data, setData] = useState(null);
  const [profile, setProfile] = useState(null);
  const [accessState, setAccessState] = useState("checking"); // checking | mfa | ready | missing | error
  const [accessEpoch, setAccessEpoch] = useState(0);
  const [accessError, setAccessError] = useState("");
  const [page, setPage] = useState("dash");
  // What the global search was pointing at when it sent us here — the batch a receipt belongs
  // to. Landing on the receipts page with two hundred batches on it and leaving the person to
  // find theirs is not a search result, it is a page change.
  const [searchFocus, setSearchFocus] = useState("");
  // Named tables whose rows would not all fit. Empty on every installation this system has, and
  // the one thing that must never be silent when it stops being empty.
  const [truncatedTables, setTruncatedTables] = useState([]);
  // The manager does not land on an exchange's dashboard. They maintain this installation and
  // sell it; they are not a party to anybody's trades, and the first screen they see should be
  // the businesses running on it rather than a set of totals belonging to one of them.
  //
  // Only from the default, and only once: a manager who has navigated somewhere stays there.
  const managerLandingDone = useRef(false);
  useEffect(() => {
    if (managerLandingDone.current) return;
    if (profile?.role === "admin" && profile?.adminLevel === "manager" && page === "dash") {
      managerLandingDone.current = true;
      setPage("manager-console");
    }
  }, [profile?.role, profile?.adminLevel, page]);
  const [viewAs, setViewAs] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [editTx, setEditTx] = useState(null);
  const [msg, setMsg] = useState(null);
  const [msgTone, setMsgTone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [lang, setLang] = useState(_lang);
  const changeLang = (l) => { setLangGlobal(l); setLang(l); };
  useEffect(() => {
    const d = LANGS[lang]?.dir || "rtl";
    document.documentElement.setAttribute("lang", lang === "ku" ? "ckb" : lang);
    document.documentElement.setAttribute("dir", d);
  }, [lang]);

  const [stale, setStale] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadSequence = useRef(0);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("theme") || "light"; } catch { return "light"; }
  });
  useEffect(() => {
    try {
      document.documentElement.setAttribute("data-theme", theme);
      document.body.style.background = "var(--bg)";
      localStorage.setItem("theme", theme);
    } catch {}
  }, [theme]);

  // ڕەنگی سیستەمەکە بەپێی ڕۆڵی ئەو کەسەی چاوی لێیەتی
  const activeRole = (viewAs && data ? (data.users.find((u) => u.id === viewAs) || {}).role : null) || profile?.role || "admin";
  useEffect(() => {
    try { document.documentElement.setAttribute("data-role", activeRole); } catch {}
  }, [activeRole]);
  const [batches, setBatches] = useState([]);
  const [batchLoadError, setBatchLoadError] = useState("");
  const [pendingBatch, setPendingBatch] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!profile || accessState !== "ready") return;
    loadNotes();
    const id = setInterval(loadNotes, 45000);   // هەر ٤٥ چرکە
    // Heard as it happens where the project supports it; the poll above is what makes that a
    // courtesy rather than the mechanism. An installed app can sit in the background for a day
    // with its socket long since dropped.
    const stop = subscribeToNotifications(supabase, () => loadNotes());
    const onVisible = () => { if (document.visibilityState === "visible") loadNotes(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); stop(); document.removeEventListener("visibilitychange", onVisible); };
  }, [profile, accessState]);
  useEffect(() => { if (online && stale && session && accessState === "ready") { setStale(null); loadAll(); } }, [online, stale, session, accessState]);
  useEffect(() => {
    const handoff = new URLSearchParams(window.location.search).get("receiptShare");
    if (!handoff || !profile || accessState !== "ready") return;
    if (profile.role === "customer" || profile.role === "partner") {
      window.location.hash = `#/portal/${profile.role}/upload`;
    } else if (profile.role === "admin") {
      const q = new URLSearchParams(window.location.search);
      q.set("receiptTab", "add");
      window.history.replaceState(null, "", `${window.location.pathname}?${q}${window.location.hash}`);
      setPage("receipts");
    }
  }, [profile?.id, accessState]);

  // Stable across renders on purpose: the deferred panels below key their data loading off
  // `flash`, so a new function each render made every one of them refetch on every render of
  // this component. The timer is also tracked, so a second message cannot be cut short by the
  // first one's timeout.
  const flashTimer = useRef(null);
  /**
   * Say something, and say what KIND of thing it is.
   *
   * This used to be one string, and the banner worked out whether it was good news by looking
   * for words in it: ✓, «کرا», «تۆمار», «نێردرا», «وەرگ». That held only while refusals arrived
   * in English. Once they were translated, an ordinary Kurdish refusal —
   *
   *   «دراوی دەرەکی پێویستی بە هاوبەشێکی دیاریکراوە کە پارەکەی لایە»
   *
   * — contains «دیاری‌کراوە», which contains «کرا», and the owner was shown a green tick over a
   * sentence telling them their transaction had been refused. Guessing a message's meaning from
   * its spelling cannot be made safe; the caller knows, so the caller says.
   *
   * `tone` is "error", "ok", or omitted — omitted keeps the old reading, so no existing call
   * changes behaviour, and a refusal carrying a ZE- reference is never read as success.
   */
  const flash = useCallback((t, tone = null) => {
    setMsg(t);
    setMsgTone(t == null ? null : tone);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    // A refusal is something to act on, not something to notice. Three seconds is not enough
    // time to read a sentence and a reference code on a phone.
    const linger = tone === "error" || /\(ZE-[A-Z0-9-]+\)/.test(String(t ?? "")) ? 7000 : 3000;
    flashTimer.current = setTimeout(() => { flashTimer.current = null; setMsg(null); setMsgTone(null); }, linger);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const reloadBatches = async () => {
    try {
      setBatchLoadError("");
      if (profile?.role === "admin") {
        const [receiptReconciled, officeReconciled] = await Promise.all([
          supabase.rpc("sarraf_reconcile_receipt_conversions"),
          supabase.rpc("sarraf_reconcile_pending_office_assignments"),
        ]);
        if (receiptReconciled.error && !/could not find the function|schema cache/i.test(String(receiptReconciled.error.message || ""))) {
          console.warn("receipt conversion reconciliation", receiptReconciled.error);
        }
        if (officeReconciled.error && !/could not find the function|schema cache/i.test(String(officeReconciled.error.message || ""))) {
          console.warn("office assignment reconciliation", officeReconciled.error);
        }
      }
      const { data: b, error } = await supabase.from("receipt_batches").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      setBatches(b || []);
    } catch (err) {
      console.error("reloadBatches", err);
      setBatchLoadError(userFacingServiceError(err, lang, "لیستی فیشەکان بار نەبوو. دووبارە هەوڵ بدەرەوە."));
    }
  };

  // Fetch complete table contents without silently stopping at PostgREST's
  // per-request row ceiling. Financial calculations must never run on a
  // truncated tx/ledger/account history. We verify an exact RLS-visible count
  // and retry once if concurrent writes changed the result while paging.
  // Extracted to src/services/tableLoader.js, where it can be tested: it decides whether the
  // dashboard opens at all, and it lived here as a closure nothing could reach. Two faults went
  // with it — a load that failed whenever somebody else wrote a row, and no upper bound at all.
  const tablesThatDidNotFit = useRef(new Set());
  const fetchAllRows = async (table, options = {}) => {
    const result = await loadWholeTable(supabase, table, options);
    if (result.truncated) tablesThatDidNotFit.current.add(table);
    else tablesThatDidNotFit.current.delete(table);
    return { data: result.data, error: result.error };
  };

  const loadAll = async (activeProfile = profile) => {
    const sequence = ++loadSequence.current;
    setRefreshing(true);
    try {
      reloadBatches();
      const adminMode = activeProfile?.role === "admin";
      const noQuery = Promise.resolve({ data: [], error: null });
      const [c, u, l, t, a, ac, rh, apr, ape, tv, ctrl, rm, rt] = await Promise.all([
        // Not the currencies table. That row's rate belongs to the installation, and reading it
        // directly is what made one business's rate the other's: every figure on this screen is
        // computed from this number. sarraf_currencies returns the same catalogue with this
        // business's own rates where it has set any, and the installation's where it has not.
        supabase.rpc("sarraf_currencies"),
        fetchAllRows("app_users", { orders: [{ column: "created_at", ascending: true }, { column: "id", ascending: true }] }),
        fetchAllRows("ledger", { orders: [{ column: "date", ascending: true }, { column: "id", ascending: true }] }),
        fetchAllRows("txs", { orders: [{ column: "date", ascending: true }, { column: "id", ascending: true }] }),
        supabase.from("audit").select("*").order("date", { ascending: false }).limit(500),
        fetchAllRows("account_ledger", { orders: [{ column: "created_at", ascending: true }, { column: "id", ascending: true }] }),
        fetchAllRows("rate_history", { orders: [{ column: "created_at", ascending: true }, { column: "id", ascending: true }] }),
        adminMode ? supabase.from("approval_requests").select("*").order("created_at", { ascending: false }).limit(500) : noQuery,
        adminMode ? supabase.from("approval_events").select("*").order("created_at", { ascending: false }).limit(1500) : noQuery,
        adminMode ? supabase.from("tx_versions").select("*").order("created_at", { ascending: false }).limit(3000) : noQuery,
        adminMode ? supabase.rpc("sarraf_control_snapshot") : Promise.resolve({ data: null, error: null }),
        adminMode ? supabase.rpc("sarraf_read_model_snapshot", { p_days: 30 }) : Promise.resolve({ data: null, error: null }),
        adminMode ? supabase.rpc("sarraf_runtime_contract") : Promise.resolve({ data: null, error: null }),
      ]);
      const queryErrors = [c, u, l, t, a, ac, rh, apr, ape, tv, ctrl, rt].filter((r) => r?.error);
      if (rm?.error) console.warn("server read model unavailable; using client fallback", rm.error);
      if (adminMode && rt?.error) {
        setAccessError("Runtime Contract بەردەست نییە — Phase 13F migration/deployment بپشکنە");
        setAccessState("error");
        throw rt.error;
      }
      if (queryErrors.length) throw queryErrors[0].error;
      // A view computed from part of the ledger is not a smaller answer, it is a wrong one. If a
      // table was too large to load whole, that is said out loud and kept on the screen — never
      // absorbed into a dashboard that looks exactly like a complete one.
      setTruncatedTables([...tablesThatDidNotFit.current]);
      if (adminMode && (!rt?.data?.ok || rt?.data?.contract_version !== "13f-v1" || !rt?.data?.phase13f_applied)) {
        const contractError = new Error("Frontend/Database contract mismatch — Phase 13F production migration is required");
        setAccessError(contractError.message);
        setAccessState("error");
        throw contractError;
      }
      const d = {
        currencies: (c.data || []).map((r) => ({ id: r.id, code: r.code, name: r.name, symbol: r.symbol, dec: r.dec, external: !!r.external, rate: r.rate == null ? null : +r.rate, buyRate: r.buy_rate == null ? null : +r.buy_rate, sellRate: r.sell_rate == null ? null : +r.sell_rate, rateUpdated: r.rate_updated })),
        users: (u.data || []).map((r) => ({ id: r.id, authId: r.auth_id, name: r.name, role: r.role, adminLevel: r.admin_level || null, tenantId: r.tenant_id || null, rate: +r.rate || 0, scope: Array.isArray(r.scope_curs) ? r.scope_curs : [], phone: r.phone, address: r.address, note: r.note, deleted: r.deleted })),
        ledger: (l.data || []).map((r) => ({
          id: r.id, type: r.type, owner: r.owner, investorId: r.investor_id, curId: r.cur_id,
          amount: +r.amount, partnerId: r.partner_id, txId: r.tx_id, note: r.note, date: r.date,
          reversalOf: r.reversal_of || null, commandKey: r.command_key || null,
          createdBy: r.created_by || null, approvalId: r.approval_id || null,
          commissionRateSnapshot: r.commission_rate_snapshot == null ? null : +r.commission_rate_snapshot,
          commissionAmountSnapshot: r.commission_amount_snapshot == null ? null : +r.commission_amount_snapshot,
        })),
        txs: (t.data || []).map(mapTxRecord),
        audit: (a.data || []).map((r) => ({ id: r.id, date: r.date, action: r.action, detail: r.detail })),
        acct: (ac.data || []).map((r) => ({ id: r.id, userId: r.user_id, kind: r.kind, curId: r.cur_id,
          amount: +r.amount, type: r.type, refId: r.ref_id, note: r.note, date: r.created_at })),
        rateHistory: (rh.data || []).map((r) => ({
          id: r.id, curId: r.cur_id,
          rate: r.rate == null ? null : +r.rate,
          buyRate: r.buy_rate == null ? null : +r.buy_rate,
          sellRate: r.sell_rate == null ? null : +r.sell_rate,
          createdAt: r.created_at,
        })),
        approvals: (apr.data || []).map((r) => ({
          id: r.id, requestKey: r.request_key, operation: r.operation, subjectKey: r.subject_key || null,
          payload: r.payload || {}, amountUsd: r.amount_usd == null ? null : +r.amount_usd,
          reason: r.reason, status: r.status, makerAuthId: r.maker_auth_id, makerAppId: r.maker_app_id,
          makerName: r.maker_name, checkerAuthId: r.checker_auth_id, checkerAppId: r.checker_app_id,
          checkerName: r.checker_name, decisionNote: r.decision_note, ownerOverride: !!r.owner_override,
          result: r.result, errorText: r.error_text, createdAt: r.created_at, expiresAt: r.expires_at,
          decidedAt: r.decided_at, executedAt: r.executed_at,
        })),
        approvalEvents: (ape.data || []).map((r) => ({
          id: r.id, approvalId: r.approval_id, event: r.event, actorAuthId: r.actor_auth_id,
          actorAppId: r.actor_app_id, actorName: r.actor_name, detail: r.detail, createdAt: r.created_at,
        })),
        txVersions: (tv.data || []).map((r) => ({
          id: r.id, txId: r.tx_id, txCode: r.tx_code, versionNo: r.version_no, action: r.action,
          beforeData: r.before_data, afterData: r.after_data, commandKey: r.command_key,
          approvalId: r.approval_id, makerAuthId: r.maker_auth_id, checkerAuthId: r.checker_auth_id,
          actorAuthId: r.actor_auth_id, actorAppId: r.actor_app_id, createdAt: r.created_at,
        })),
        control: ctrl.data && typeof ctrl.data === "object" ? ctrl.data : null,
        readModel: !rm?.error && rm?.data && typeof rm.data === "object" ? rm.data : null,
        runtime: rt?.data && typeof rt.data === "object" ? rt.data : null,
      };
      if (sequence !== loadSequence.current) return;
      setData(d);
      setRefreshedAt(new Date());
      // Financial data is intentionally kept in memory only. Do not persist
      // ledger/transactions/users to browser storage on a production finance system.
      try { localStorage.removeItem("cache"); } catch {}
      if (session) setProfile(d.users.find((x) => x.authId === session.user.id) || null);
    } catch (err) {
      if (sequence !== loadSequence.current) return;
      console.error(err);
      flash("هەڵە لە بارکردنی داتا — پەیوەندی بپشکنە و دووبارە هەوڵ بدەوە");
      setStale(Date.now());
    } finally {
      if (sequence === loadSequence.current) setRefreshing(false);
    }
  };


  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      if (!session) {
        loadSequence.current += 1;
        setData(null);
        setProfile(null);
        setAccessError("");
        setAccessState("checking");
        return;
      }

      setData(null);
      setAccessError("");
      setAccessState("checking");

      try {
        const { data: rawProfile, error: profileError } = await supabase.rpc("sarraf_self_profile");
        if (profileError) throw profileError;

        const p = rawProfile && typeof rawProfile === "object" ? rawProfile : null;
        if (!p?.id || p?.deleted) {
          if (!cancelled) {
            setProfile(null);
            setAccessState("missing");
          }
          return;
        }

        const gateProfile = {
          id: p.id,
          authId: p.auth_id || session.user.id,
          name: p.name || "",
          role: p.role,
          adminLevel: p.admin_level || null,
          rate: Number(p.rate) || 0,
          scope: Array.isArray(p.scope_curs) ? p.scope_curs : [],
          phone: p.phone || "",
          address: p.address || null,
          note: p.note || null,
          deleted: !!p.deleted,
        };

        if (cancelled) return;
        setProfile(gateProfile);

        if (gateProfile.role === "admin" || gateProfile.role === "office") {
          const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
          if (aalError) throw aalError;
          if (aal?.currentLevel !== "aal2") {
            if (!cancelled) setAccessState("mfa");
            return;
          }
        }

        if (cancelled) return;
        setAccessState("ready");
        await loadAll(gateProfile);
      } catch (err) {
        console.error("security bootstrap", err);
        if (!cancelled) {
          setAccessError(err?.message || "نەتوانرا پشکنینی پاراستن تەواو بکرێت");
          setAccessState("error");
        }
      }
    };

    boot();
    return () => { cancelled = true; };
  }, [session?.access_token, accessEpoch]);

  const LR = (e) => ({ id: e.id, type: e.type, owner: e.owner || null, investor_id: e.investorId || null, cur_id: e.curId, amount: e.amount, partner_id: e.partnerId || null, tx_id: e.txId || null, note: e.note || null, date: e.date });
  const TR = (transaction) => {
    const t = normalizeTransactionBusinessFlow(transaction);
    return { id: t.id, code: t.code || null, type: t.type, direct: !!t.direct,
      pair_id: t.pairId ?? null, direct_role: t.directRole ?? null, own_money: !!t.ownMoney,
      business_flow: t.businessFlow,
      buy_rate: t.buyRate ?? null, buy_total: t.buyTotal ?? null, cp_id: t.cpId, cp_name: t.cpName, cur_id: t.curId, amount: t.amount, rate: t.rate, against_id: t.againstId, total: t.total, partner_id: t.partnerId, status: t.status, paid_at: t.paidAt, profit: t.profit, profit_cur_id: t.profitCurId, note: t.note || null, date: t.date, edited: !!t.edited, deleted: !!t.deleted };
  };

  // One key per intent, kept until the outcome is actually known. A key minted fresh on each
  // attempt would make every retry a second real command — which is exactly what the server's
  // idempotency exists to prevent.
  const keyBook = useRef(new CommandKeyBook());
  const intentRef = useRef(null);
  const commandKey = (kind = "cmd") =>
    keyBook.current.keyFor(intentRef.current || kind, kind, profile?.id || "user");

  const approvalQueued = (result, label = "کردار") => {
    if (!result?.approval_required) return false;
    const id = result?.approval_id ? ` — ${result.approval_id}` : "";
    flash(`${label} بۆ پەسەندکردنی ئەدمینی دووەم نێردرا${id}`);
    setPage("approvals");
    return true;
  };
  const rpcOnce = async (name, args) => {
    const { data: out, error } = await supabase.rpc(name, args);
    if (error) {
      const msg = String(error?.message || "");
      if (error?.code === "PGRST202" || /function .* does not exist|could not find the function/i.test(msg)) {
        throw new Error("Production migration ـەکە هێشتا لە Supabase جێبەجێ نەکراوە");
      }
      if (error?.code === "55000" || /financial writes are frozen/i.test(msg)) {
        throw new Error("Emergency Freeze چالاکە — هیچ گۆڕانکارییەکی دارایی جێبەجێ ناکرێت");
      }
      throw error;
    }
    return out;
  };

  /**
   * A lost response is not a failure. If the connection drops after the server has committed,
   * the browser cannot tell the difference — so the call is retried under the same command key,
   * which the server replays rather than re-executing. Only if it still cannot be reached does
   * the operator hear that the outcome is unknown, and the key is kept so their own retry is
   * a replay too.
   */
  const rpcStrict = async (name, args) =>
    runIdempotentCommand({
      commandKey: args?.p_command_key || commandKey(name),
      invoke: () => rpcOnce(name, args),
      attempts: args?.p_command_key ? 3 : 1,
      onRetry: ({ attempt }) => flash(`پەیوەندی لاوازە — هەوڵی ${attempt + 1}...`),
    });

  const lockRef = useRef(false);
  /**
   * `intent` names what the operator is trying to do. Two attempts at the same intent share a
   * command key, so pressing save again after an unclear failure replays rather than posting
   * a second time. Passing nothing keeps the old per-call behaviour for reads.
   */
  const run = async (fn, intent = null) => {
    if (lockRef.current) return false;
    if (!navigator.onLine) { flash("ئینتەرنێت نییە — ناتوانرێت تۆمار بکرێت"); return false; }                  // قوفڵی هاوکات — خێراتر لە state
    lockRef.current = true; setBusy(true);
    intentRef.current = intent;
    try {
      const result = await fn();
      // The outcome is known and good; the intent is finished and its key can be retired.
      if (intent) keyBook.current.release(intent);
      await loadAll();
      return result === undefined ? true : result;
    }
    catch (err) {
      console.error(err);
      if (err?.outcomeUnknown) {
        // Deliberately NOT released: the operator's own retry must reuse this key, or the
        // command they were never told the result of could run a second time for real.
        flash(err.message, "error");
        // Reload anyway — if it did commit, the screen should show it rather than deny it.
        try { await loadAll(); } catch (e) { console.error("reload after unknown outcome", e); }
        return false;
      }
      // The server answered. The command did not run, so the key is spent on nothing.
      if (intent) keyBook.current.release(intent);
      flash(errorTextOr(err, "هەڵەیەک ڕوویدا — دووبارە هەوڵ بدەوە"), "error");
      // A refusal the system wrote is normal and is filtered out inside reportFault. What
      // reaches the table is the rest: the ones nobody wrote for a reader.
      reportFault("command", err, page);
      return false;
    }
    finally { lockRef.current = false; setBusy(false); intentRef.current = null; }
  };

  /* ───────── حیسابەکان ───────── */
  const calc = useMemo(() => {
    if (!data) return null;

    // Phase 13E: use the server aggregate read model for current balances.
    // Full tx/ledger history remains loaded as a correctness fallback and for
    // detailed legacy screens, but current dashboard/account calculations no
    // longer need to rescan every historical row in the browser.
    const rm = data.readModel;
    if (rm && rm.physical_by_currency && Array.isArray(rm.partner_balances)) {
      const phys = Object.fromEntries(Object.entries(rm.physical_by_currency || {}).map(([k,v]) => [k, Number(v) || 0]));
      const partner = {}, invCap = {}, invPaid = {}, expenses = {}, fees = {};
      const selfCap = Object.fromEntries(Object.entries(rm.self_capital || {}).map(([k,v]) => [k, Number(v) || 0]));
      const acctCash = {}, acctDebt = {}, cust = {};

      for (const x of (rm.partner_balances || [])) {
        if (!x?.partner_id || !x?.cur_id) continue;
        partner[x.partner_id] = partner[x.partner_id] || {};
        partner[x.partner_id][x.cur_id] = Number(x.amount) || 0;
      }
      for (const x of (rm.investor_capital || [])) {
        if (!x?.investor_id || !x?.cur_id) continue;
        invCap[x.investor_id] = invCap[x.investor_id] || {};
        invCap[x.investor_id][x.cur_id] = Number(x.amount) || 0;
      }
      for (const x of (rm.investor_paid || [])) {
        if (!x?.investor_id || !x?.cur_id) continue;
        invPaid[x.investor_id] = invPaid[x.investor_id] || {};
        invPaid[x.investor_id][x.cur_id] = Number(x.amount) || 0;
      }
      Object.entries(rm.expenses || {}).forEach(([k,v]) => { expenses[k] = Number(v) || 0; });
      Object.entries(rm.partner_fees || {}).forEach(([k,v]) => { fees[k] = Number(v) || 0; });

      for (const x of (rm.account_balances || [])) {
        if (!x?.user_id || !x?.cur_id) continue;
        const box = x.kind === "debt" ? acctDebt : acctCash;
        box[x.user_id] = box[x.user_id] || {};
        box[x.user_id][x.cur_id] = Number(x.amount) || 0;
      }

      for (const x of (rm.pending_customer_balances || [])) {
        if (!x?.against_id) continue;
        const key = x.cp_id || "name:" + (x.cp_name || "");
        cust[key] = cust[key] || { owe: {}, due: {}, n: 0 };
        const side = x.type === "buy" ? "owe" : "due";
        cust[key][side][x.against_id] = (cust[key][side][x.against_id] || 0) + (Number(x.total) || 0);
        cust[key].n += Number(x.tx_count) || 0;

        if (x.cp_id) {
          acctDebt[x.cp_id] = acctDebt[x.cp_id] || {};
          const sign = x.type === "buy" ? 1 : -1;
          acctDebt[x.cp_id][x.against_id] = (acctDebt[x.cp_id][x.against_id] || 0) + sign * (Number(x.total) || 0);
        }
      }

      const invTotal = {};
      Object.values(invCap).forEach((m) => Object.entries(m).forEach(([c,v]) => {
        invTotal[c] = (invTotal[c] || 0) + (Number(v) || 0);
      }));

      const atMe = {};
      for (const c of data.currencies) {
        const atP = Object.values(partner).reduce((s,m) => s + (m[c.id] || 0),0);
        atMe[c.id] = (phys[c.id] || 0) - atP;
      }

      return { phys, partner, atMe, invCap, invTotal, selfCap, invPaid, expenses, fees, cust, pending: cust, acctCash, acctDebt };
    }

    const phys = {}, partner = {}, invCap = {}, selfCap = {}, invPaid = {}, expenses = {}, fees = {};
    for (const e of data.ledger) {
      phys[e.curId] = (phys[e.curId] || 0) + e.amount;
      if (e.partnerId) {
        partner[e.partnerId] = partner[e.partnerId] || {};
        partner[e.partnerId][e.curId] = (partner[e.partnerId][e.curId] || 0) + e.amount;
      }
      if (e.type === "deposit" || e.type === "withdraw") {
        if (e.owner === "investor") {
          invCap[e.investorId] = invCap[e.investorId] || {};
          invCap[e.investorId][e.curId] = (invCap[e.investorId][e.curId] || 0) + e.amount;
        } else selfCap[e.curId] = (selfCap[e.curId] || 0) + e.amount;
      }
      if (e.type === "investor_payout" && e.investorId) {
        invPaid[e.investorId] = invPaid[e.investorId] || {};
        invPaid[e.investorId][e.curId] = (invPaid[e.investorId][e.curId] || 0) + Math.abs(e.amount);
      }
      if (e.type === "expense") expenses[e.curId] = (expenses[e.curId] || 0) + Math.abs(e.amount);
      if (e.type === "partner_fee") fees[e.curId] = (fees[e.curId] || 0) + Math.abs(e.amount);
    }
    const invTotal = {};
    Object.values(invCap).forEach((m) => Object.entries(m).forEach(([c, v]) => (invTotal[c] = (invTotal[c] || 0) + v)));
    // ئەوەی لای خۆم مابێت (قاسەی گشتی — ئەوەی لای هاوبەشەکانە)
    const atMe = {};
    for (const c of data.currencies) {
      const atP = Object.values(partner).reduce((s, m) => s + (m[c.id] || 0), 0);
      atMe[c.id] = (phys[c.id] || 0) - atP;
    }
    // باڵانسی دووسەرەی کڕیارەکان (قەرز)
    const cust = {};
    for (const t of data.txs) {
      if (t.deleted || t.status !== "pending") continue;
      const key = t.cpId || "name:" + (t.cpName || "");
      cust[key] = cust[key] || { owe: {}, due: {}, n: 0 };
      cust[key].n++;
      // کڕین چاوەڕوان = من قەرزاری ئەوم | فرۆشتن چاوەڕوان = ئەو قەرزاری منە
      const side = t.type === "buy" ? "owe" : "due";
      cust[key][side][t.againstId] = (cust[key][side][t.againstId] || 0) + t.total;
    }
    // ── باڵانسی قاسە و قەرزی هەر حسابێک ──
    const acctCash = {}, acctDebt = {};
    for (const e of (data.acct || [])) {
      const box = e.kind === "debt" ? acctDebt : acctCash;
      box[e.userId] = box[e.userId] || {};
      box[e.userId][e.curId] = (box[e.userId][e.curId] || 0) + e.amount;
    }
    // قەرزی مامەڵە چاوەڕوانەکان دەخرێتە سەر دەفتەری قەرز
    for (const t of data.txs) {
      if (t.deleted || t.status !== "pending" || !t.cpId) continue;
      acctDebt[t.cpId] = acctDebt[t.cpId] || {};
      const sign = t.type === "buy" ? +1 : -1;   // کڕین = قەرزاری ئەوم | فرۆشتن = ئەو قەرزارە
      acctDebt[t.cpId][t.againstId] = (acctDebt[t.cpId][t.againstId] || 0) + sign * t.total;
    }
    return { phys, partner, atMe, invCap, invTotal, selfCap, invPaid, expenses, fees, cust, pending: cust, acctCash, acctDebt };
  }, [data]);

  const cur = (id) => data?.currencies.find((c) => c.id === id) || {};
  const safeMoney = (n) => {
    const value = Number(n);
    return Number.isFinite(value) ? value : 0;
  };
  const usr = (id) => data?.users.find((u) => u.id === id) || {};

  /* خێری فرۆشتنەکان لە ماوەیەکدا، بۆ هەر دراوێک */
  // خێری هاوبەش (دابەش دەکرێت) — مامەڵەی ڕاستەوخۆ لێی دەرکراوە
  const profitIn = (from, to) => {
    const m = {};
    for (const t of data.txs) {
      if (t.deleted || t.profit == null || isOwnerCashboxFlow(t)) continue;
      if (t.type !== "sell") continue;
      const d = dOnly(t.date);
      if (from && d < from) continue;
      if (to && d > to) continue;
      m[t.profitCurId] = (m[t.profitCurId] || 0) + t.profit;
    }
    return m;
  };
  // خێری تایبەتی خۆم (مامەڵەی ڕاستەوخۆ) — دابەش ناکرێت
  const ownProfitIn = (from, to) => {
    const m = {};
    for (const t of data.txs) {
      if (t.deleted || t.profit == null || !isOwnerCashboxFlow(t)) continue;
      const d = dOnly(t.date);
      if (from && d < from) continue;
      if (to && d > to) continue;
      m[t.profitCurId] = (m[t.profitCurId] || 0) + t.profit;
    }
    return m;
  };
  const readModelProfitMap = (direct) => {
    if (!Array.isArray(data?.readModel?.profit_totals)) return null;
    const out = {};
    for (const x of data.readModel.profit_totals) {
      if (!!x.direct !== !!direct || !x.cur_id) continue;
      out[x.cur_id] = (out[x.cur_id] || 0) + (Number(x.amount) || 0);
    }
    return out;
  };
  const ownProfitAll = useMemo(() => data ? (readModelProfitMap(true) || ownProfitIn(null, null)) : {}, [data]);
  const profitAll = useMemo(() => data ? (readModelProfitMap(false) || profitIn(null, null)) : {}, [data]);

  /* بەشی وەبەرهێنەرێک لە خێری دراوێک */
  // Profit is attributed sale by sale, using the capital that stood on the day of that sale.
  // Applying today's capital weight to all-time profit would hand a new investor a share of
  // profit earned before they arrived — and would strip a departing one of profit they helped
  // earn. See services/investorShare.js.
  const capitalEvents = useMemo(() => capitalEventsFrom(data?.ledger), [data?.ledger]);
  const liveInvestors = useMemo(
    () => (data?.users || []).filter((u) => u.role === "investor" && !u.deleted)
      .map((u) => ({ id: u.id, rate: u.rate, scope: u.scope })),
    [data?.users],
  );

  /**
   * One investor's share of a currency's profit over a range. Passing no range means all time,
   * which is what the account pages ask for.
   */
  const invShare = (iid, curId, from = null, to = null) =>
    investorShare({
      investorId: iid, curId,
      profitEvents: profitEventsFrom(data.txs, { from, to }),
      capitalEvents, investors: liveInvestors,
    });

  // دابەشکردن تەنها لەسەر خێری هاوبەش دەکرێت (نەک ڕاستەوخۆ)
  const investorsProfitIn = (from = null, to = null) =>
    investorsTotalByCurrency({
      profitEvents: profitEventsFrom(data.txs, { from, to }),
      capitalEvents, investors: liveInvestors, currencies: data.currencies,
    });

  /* قاسەی خۆم = سەرمایەی خۆم + خێری خۆم − خەرجی − عمولەی هاوبەشان */
  const mySafe = useMemo(() => {
    if (!data || !calc) return {};
    const invP = investorsProfitIn();
    const out = {};
    for (const c of data.currencies) {
      const shared = (profitAll[c.id] || 0) - (invP[c.id] || 0);   // بەشی من لە خێری هاوبەش
      const own = ownProfitAll[c.id] || 0;                          // خێری ڕاستەوخۆ — ١٠٠٪ هی من
      out[c.id] = (calc.selfCap[c.id] || 0) + shared + own - (calc.expenses[c.id] || 0) - (calc.fees[c.id] || 0);
    }
    return out;
  }, [data, calc, profitAll, ownProfitAll]);

  /* خێری نەدراوی وەبەرهێنەرێک */
  const invUnpaid = (iid, curId) => invShare(iid, curId) - ((calc.invPaid[iid] || {})[curId] || 0);

  /* گۆڕینی هەر دراوێک بۆ دۆلار بەپێی نرخی ئەمڕۆ (بۆ کۆکردنەوەی گشتی) */
  const toUsd = (amount, curId) => {
    if (!amount) return 0;
    if (curId === "usd") return amount;
    const c = cur(curId);
    const mid = rateOf(c);
    return mid ? amount / mid : 0;
  };
  const sumUsd = (map) => (data?.currencies || []).reduce((s, c) => s + toUsd(map?.[c.id] || 0, c.id), 0);
  const ratesReady = !!data && unpricedCurrencies(data.currencies).length === 0;

  /* بەشی خاوەندارێتی — هەر دراوێک بەپێی سەرمایە دابەش دەبێت */
  const owners = useMemo(() => {
    if (!data || !calc) return { list: [], total: 0 };
    const invs = data.users.filter((u) => u.role === "investor" && !u.deleted);
    const mine = sumUsd(mySafe);
    const list = [{ id: "me", name: "خۆم", equity: mine, isMe: true }];
    invs.forEach((u) => {
      const cap = sumUsd(calc.invCap[u.id] || {});
      let unpaid = 0;
      data.currencies.forEach((c) => { unpaid += toUsd(invUnpaid(u.id, c.id), c.id); });
      const eq = cap + unpaid;
      if (eq !== 0) list.push({ id: u.id, name: u.name, equity: eq, cap, unpaid });
    });
    const total = list.reduce((s, x) => s + x.equity, 0);
    list.forEach((x) => (x.share = total > 0 ? x.equity / total : 0));
    return { list, total };
  }, [data, calc, mySafe]);

  /* ── USD bookkeeping base for weighted-average inventory ────────────────
     Every currency has ONE inventory pool across all trading pairs.
     New regular buys snapshot their USD acquisition cost into buy_total/buy_rate,
     so a CNY position bought with USD can later be sold for IQD without losing
     its cost basis. Historical rows fall back to the closest internal USD rate. */
  // One ratio per currency: 1 USD = rate units. Every valuation divides by it, and a currency
  // with no ratio values as null so the interface says "not priced" instead of printing a
  // number nobody set. See services/currencyRate.js.
  const rateSnapshotAt = (curId, date) => ({
    rate: rateAsOf(curId, date, data.rateHistory, data.currencies),
    source: (data.rateHistory || []).some((h) => h.curId === curId) ? "history" : "current",
  });

  // The mode argument is kept so call sites need not all change at once; with a single ratio
  // there is no spread, so every mode is the same division.
  const usdValueAt = (amount, curId, _mode = "mid", date = null) =>
    usdFromAsOf(amount, curId, date, data.rateHistory, data.currencies);

  // Express a USD bookkeeping cost in the currency received on a sale, so realized profit
  // stays in the transaction's own against currency while the cost basis stays in USD.
  const usdToCurrencyAt = (usdAmount, curId, _mode = "sell", date = null) =>
    fromUsdAsOf(usdAmount, curId, date, data.rateHistory, data.currencies);

  const inventoryPosition = (curId, _againstId = null, excludeTxId = null, asOfDate = null) => {
    if (!excludeTxId && !asOfDate && Array.isArray(data?.readModel?.inventory)) {
      const snap = data.readModel.inventory.find((x) => x?.cur_id === curId);
      if (snap) {
        const qty = Number(snap.qty) || 0;
        const costUsd = Number(snap.cost_usd) || 0;
        const costComplete = Number(snap.missing_cost_rows || 0) === 0;
        return {
          qty,
          cost: costUsd,
          costUsd,
          costComplete,
          avgRate: costComplete && qty > 0 ? costUsd / qty : null,
          avgUsdRate: costComplete && qty > 0 ? costUsd / qty : null,
          // This came from the server's own snapshot, so it is the same number the command will
          // check the sale against. Nothing below may stop a sale on any other basis.
          fromServer: true,
        };
      }
    }

    // Worked out here, from the transactions this browser happens to have loaded. Good enough to
    // show, never good enough to refuse on — a figure that disagrees with the server's would stop
    // an owner making a sale that was perfectly fine.
    return {
      ...computeInventoryPosition({
        txs: data.txs,
        curId,
        excludeTxId,
        asOfDate,
        usdCostOf: (t) => usdValueAt(Number(t.total), t.againstId, "spend", t.date),
      }),
      fromServer: false,
    };
  };

  const avgRate = (curId, againstId, excludeTxId = null, asOfDate = null) =>
    inventoryPosition(curId, againstId, excludeTxId, asOfDate).avgRate;

  /* نرخی پێشنیارکراو لە ڕەیتیۆی ڕۆژانەوە: 1 USD = X.
     ڕەیتیۆی نێوان دوو دراو تەنها دابەشکردنی یەکێکە بەسەر ئەوی تر — بە دەست دەپشکنرێت.
     یەک ژمارە بۆ کڕین و فرۆشتن؛ ئەگەر بە نرخێکی تر مامەڵەت کرد، لەسەر مامەڵەکە بینووسە. */
  const autoRate = (_type, curId, againstId) => crossRate(curId, againstId, data.currencies);

  /* ───────── کردارەکان ───────── */
  const addDeposit = (f) => {
    // Fixed before the first attempt, so a retry records the same movement once, not twice.
    const entryId = uid();
    return run(async () => {
    if (!(Math.abs(+f.amount) > 0)) { flash("بڕ پێویستە"); return; }
    const amount = roundMoney(data, f.dir === "in" ? Math.abs(+f.amount) : -Math.abs(+f.amount), f.curId);
    const e = { id: entryId, type: f.dir === "in" ? "deposit" : "withdraw", owner: f.owner === "self" ? "self" : "investor", investorId: f.owner === "self" ? null : f.owner, curId: f.curId, amount, partnerId: null, txId: null, note: f.note, date: now() };
    const result = await rpcStrict("sarraf_post_ledger_command", {
      p_ledger: [LR(e)],
      p_command_key: commandKey("cash"),
      p_action: f.dir === "in" ? "پارە داخڵکردن" : "پارە دەرهێنان",
      p_detail: `${fmt(Math.abs(amount))} ${cur(f.curId).code} — ${f.owner === "self" ? "هی خۆم" : usr(f.owner).name}`,
    });
    if (approvalQueued(result, f.dir === "in" ? "پارە داخڵکردن" : "پارە دەرهێنان")) return result;
    flash("تۆمار کرا ✓");
    }, `cash:${entryId}`);
  };

  const saveTx = async (f, existing) => {
    if (existing?.deleted) {
      flash("ئەم مامەڵەیە هەڵوەشێندراوەتەوە و ناتوانرێت دەستکاری بکرێت");
      return false;
    }
    if (existing?.paidAt) {
      flash("پێش دەستکاری، پارەدانەکە هەڵبوەشێنەرەوە");
      return false;
    }
    // A posted trade is an accounting fact. Editing its amount/rate/currencies/party would
    // silently detach it from the journal, WAC and debt history. The edit surface is therefore
    // metadata-only; an economic correction uses the visible void/reversal + new-trade path.
    // This early branch is especially important for Type B: the old form treated editing one
    // half as a request to create an entirely new direct pair.
    if (existing) {
      return await run(async () => {
        const updated = { ...existing, note: String(f.note ?? existing.note ?? ""), edited: true };
        const result = await rpcStrict("sarraf_edit_transaction", {
          p_tx: TR(updated),
          p_ledger: [],
          p_command_key: commandKey("edit"),
          p_action: "دەستکاری تێبینی مامەڵە",
          p_detail: `#${existing.code || "—"} — metadata only`,
        });
        if (approvalQueued(result, "دەستکاری مامەڵە")) return result;
        setEditTx(null);
        flash("تێبینی مامەڵە نوێ کرایەوە ✓");
        return result;
      }, `edit:${existing.id}`);
    }
    // One rounder. This used to be its own implementation without the epsilon, which rounded a
    // half-cent down: an amount of 1.005 was stored as 1.00 here and shown as 1.01 everywhere
    // else on the same screen.
    const roundCur = (value, curId) => roundToCurrency(data, value, curId);
    const amount = roundCur(+f.amount, f.curId), rate = +f.rate, total = roundCur(amount * rate, f.againstId);
    if (!(amount > 0)) { flash("بڕ دەبێت لە سفر گەورەتر بێت"); return false; }
    if (f.curId === f.againstId) { flash("ناکرێت دراوەکە لەگەڵ خۆی مامەڵەی پێبکرێت"); return false; }

    // ── مامەڵەی ڕاستەوخۆ: کڕیار + فرۆشیار ──
    if (f.direct) {
      if (!(+f.buyQuote > 0)) { flash("ڕەیتی کڕین پێویستە"); return false; }
      if (!(+f.sellQuote > 0)) { flash("ڕەیتی فرۆشتن پێویستە"); return false; }
      if (!f.fromId && !f.fromName) { flash("لە کێ دەیکڕیت؟"); return false; }
      if (!f.toId && !f.toName) { flash("بە کێ دەیفرۆشیت؟"); return false; }
      if (f.buyStatus === "pending") {
        flash("کڕینی چاوەڕوان لە مامەڵەی ڕاستەوخۆدا ڕێگەپێدراو نییە؛ وەک کڕینی ئاسایی تۆماری بکە و نووسینگەی پارەدان دیاری بکە");
        return false;
      }
      if (f.sellStatus === "pending" && !f.toId) {
        flash("فرۆشتنی چاوەڕوان دەبێت بە کڕیارێکی تۆمارکراو ببەسترێتەوە تا قەرزەکە خاوەنێکی ڕوونی هەبێت");
        return false;
      }

      return await run(async () => {
        const bq = +f.buyQuote;
        const sq = +f.sellQuote;
        const displayBaseId = f.rateBaseId || preferredRateBaseId(f.curId, f.againstId);
        const buyStoredRate = displayRateToStored(bq, f.curId, f.againstId, displayBaseId);
        const sellStoredRate = displayRateToStored(sq, f.curId, f.againstId, displayBaseId);
        const buyTotal = roundCur(amount * buyStoredRate, f.againstId);
        const sellTotal = roundCur(amount * sellStoredRate, f.againstId);
        const profit = roundCur(sellTotal - buyTotal, f.againstId);
        const pair = uid();
        const at = now();

        const t1 = {
          id: uid(), code: null, type: "buy", direct: true, pairId: pair, directRole: "buy",
          ownMoney: true, cpId: f.fromId || null, cpName: f.fromId ? null : f.fromName,
          curId: f.curId, amount, rate: buyStoredRate, againstId: f.againstId, total: buyTotal,
          partnerId: null, status: f.buyStatus || "completed", paidAt: null,
          profit: null, profitCurId: null, note: f.note || "", date: at, edited: false,
        };
        const t2 = {
          id: uid(), code: null, type: "sell", direct: true, pairId: pair, directRole: "sell",
          ownMoney: true, cpId: f.toId || null, cpName: f.toId ? null : f.toName,
          curId: f.curId, amount, rate: sellStoredRate, againstId: f.againstId, total: sellTotal,
          buyRate: buyStoredRate, buyTotal, partnerId: null, status: f.sellStatus || "completed", paidAt: null,
          profit, profitCurId: f.againstId, note: f.note || "", date: at, edited: false,
        };

        const detail = `${fmt(amount)} ${cur(f.curId).code} · خێر ${fmt(profit)} ${cur(f.againstId).code}`;
        const result = await rpcStrict("sarraf_commit_transactions", {
          p_txs: [TR(t1), TR(t2)],
          // Phase 13C ignores browser accounting rows and calculates them on the server.
          p_ledger: [],
          p_batch_id: null,
          p_command_key: commandKey("direct"),
          p_action: "مامەڵەی ڕاستەوخۆ",
          p_detail: detail,
        });
        setEditTx(null);
        if (approvalQueued(result, "مامەڵەی ڕاستەوخۆ")) return result;
        const saved = Array.isArray(result?.transactions) ? result.transactions : [];
        const codes = saved.map((x) => x.code).filter(Boolean);
        flash(`مامەڵە تۆمار کرا ✓${codes.length ? ` — #${codes.join("/")}` : ""} — خێر ${fmt(profit)} ${cur(f.againstId).code}`);
      });
    }

    // ── مامەڵەی ئاسایی ──
    if (!(rate > 0)) { flash("نرخ دەبێت لە سفر گەورەتر بێت"); return false; }
    if (!f.cpId && !f.cpName) { flash("لایەنی بەرامبەر دیاری بکە"); return false; }
    if (!(total > 0)) { flash("کۆی گشتی ناتوانێت سفر بێت"); return false; }
    if (f.status === "pending" && !f.cpId) {
      flash("مامەڵەی چاوەڕوان دەبێت بە کڕیارێکی تۆمارکراو ببەسترێتەوە تا قەرزەکە خاوەن و ئاڕاستەی ڕوونی هەبێت");
      return false;
    }
    if (f.type === "buy" && f.status === "pending" && !f.officeId) {
      flash("بۆ کڕینی پارەنەدراو دەبێت نووسینگەی بەرپرسی پارەدان دیاری بکرێت");
      return false;
    }
    // دراوی دەرەوە: دەبێت لای تەرەفێک بێت
    if (cur(f.curId).external && !f.partnerId) { flash(`${cur(f.curId).name} دەبێت لای تەرەفێک دابنرێت`); return false; }

    // The transaction's identity is fixed before the first attempt, so a retry after a lost
    // response saves the same transaction rather than a second one.
    const txId = uid();

    return await run(async () => {
      const txDate = now();
      let profit = null, profitCurId = null, bookBuyRate = null, bookBuyTotal = null;

      if (f.type === "buy") {
        const costUsd = usdValueAt(total, f.againstId, "spend", txDate);
        if (Number.isFinite(costUsd) && costUsd >= 0) {
          bookBuyTotal = roundMoney(data, costUsd, "usd");
          bookBuyRate = amount > 0 ? costUsd / amount : null;
        }
      } else if (f.type === "sell") {
        const pos = inventoryPosition(f.curId, f.againstId, null, txDate);
        if (pos.avgRate !== null && amount <= pos.qty + 1e-9) {
          const costBasisUsd = pos.avgRate * amount;
          const costInAgainst = usdToCurrencyAt(costBasisUsd, f.againstId, "sell", txDate);
          if (Number.isFinite(costInAgainst)) {
            profit = roundMoney(data, total - costInAgainst, f.againstId);
            profitCurId = f.againstId;
            bookBuyRate = pos.avgRate;
            bookBuyTotal = roundMoney(data, costBasisUsd, "usd");
          }
        }
      }

      const t = {
        id: txId, code: null, type: f.type,
        cpId: f.cpId || null, cpName: f.cpId ? null : f.cpName,
        curId: f.curId, amount, rate, againstId: f.againstId, total,
        buyRate: bookBuyRate, buyTotal: bookBuyTotal,
        partnerId: f.partnerId || null, direct: false, status: f.status || "completed",
        paidAt: null, profit, profitCurId, note: f.note || "",
        date: txDate, edited: false,
      };

      const detail = `${fmt(amount)} ${cur(f.curId).code} — ${t.cpId ? (usr(t.cpId).name || t.cpName) : t.cpName}`;
      let result;
      if (f.batchId) {
        result = await convertReceiptBatchToTransaction(supabase, {
          batchId: f.batchId,
          receiptIds: f.receiptIds,
          transaction: TR(t),
          officeId: f.officeId || null,
          reason: String(f.note || "").trim() || "پشتڕاستکردنەوە و گۆڕینی فیشە پەسەندکراوەکان بۆ مامەڵە",
        });
      } else if (t.type === "buy" && t.status === "pending") {
        result = await rpcStrict("sarraf_commit_pending_purchase_with_office", {
          p_tx: TR(t),
          p_office_id: f.officeId,
          p_due_at: null,
          p_command_key: commandKey("pending-office-purchase"),
          p_action: "کڕینی چاوەڕوان و ئەرکی پارەدان",
          p_detail: detail,
        });
      } else {
        result = await rpcStrict("sarraf_commit_transactions", {
          p_txs: [TR(t)],
          p_ledger: [],
          p_batch_id: f.batchId || null,
          p_command_key: commandKey("tx"),
          p_action: t.type === "buy" ? "کڕین" : "فرۆشتن",
          p_detail: detail,
        });
      }

      if (f.batchId) setPendingBatch(null);
      reloadBatches();
      setEditTx(null);
      if (approvalQueued(result, "مامەڵە")) return result;

      const saved = Array.isArray(result?.transactions) ? result.transactions[0] : result?.transaction;
      if (saved?.code) t.code = saved.code;

      // Both ordinary and receipt-backed pending purchases commit (or queue) the exact office
      // assignment inside their database wrapper, including the maker-checker path.
      const who = t.cpId ? (usr(t.cpId).name || t.cpName) : t.cpName;
      const line = `${fmt(amount, cur(f.curId).dec ?? 0)} ${cur(f.curId).code} = ${fmt(t.total, cur(f.againstId).dec ?? 0)} ${cur(f.againstId).code}`;
      if (t.cpId) await notify(t.cpId, "tx",
        t.type === "buy" ? tr("فرۆشتنێکی نوێ") : tr("کڕینێکی نوێ"), line, null, t.id);
      if (t.partnerId) await notify(t.partnerId, "tx",
        t.type === "buy" ? tr("پارە خرایە ئەکاونتەکەت") : tr("پارە لە ئەکاونتەکەت دەرچوو"),
        `${line} · ${who}`, null, t.id);
      if (t.status === "pending" && t.type === "buy") {
        const off = data.users.find((u) => u.id === f.officeId && u.role === "office" && !u.deleted);
        if (off) await notify(off.id, "payment", tr("پارەدانێکی نوێ چاوەڕوانە"),
          `${who} · ${fmt(t.total, cur(f.againstId).dec ?? 0)} ${cur(f.againstId).code}`, null, t.id);
      }
      // The conversion runs in two calls: one creates the transaction, a second confirms the
      // money actually moved in the ledger. The second one's failure was returned and never
      // read, so a transaction whose money had not moved was reported with a tick. It is money;
      // it is said out loud, and it is written down where it survives the message disappearing.
      if (result?.ledger_confirmed === false) {
        const warning = tr("مامەڵەکە تۆمار کرا، بەڵام جووڵەی پارە لە دەفتەردا پشتڕاست نەکرایەوە");
        flash(`⚠️ ${warning}${t.code ? ` — #${t.code}` : ""}`);
        await notify(profile.id, "system", tr("پشتڕاستکردنەوەی دەفتەر سەرکەوتوو نەبوو"),
          `${warning} — ${line}`, null, t.id);
      } else {
        flash(`مامەڵە تۆمار کرا ✓${t.code ? ` — #${t.code}` : ""}`);
      }
    }, `tx:${txId}`);
  };

  const delTx = (t) => {
    if (!t || t.deleted) {
      flash("ئەم مامەڵەیە پێشتر هەڵوەشێندراوەتەوە");
      return false;
    }
    if (!window.confirm("ئەم مامەڵەیە بە تۆماری هەڵوەشاندنەوە ناچالاک بکرێت؟ هیچ تۆمارێکی دەفتەر ناسڕدرێتەوە.")) return false;
    return run(async () => {
      const result = await rpcStrict("sarraf_void_transaction", {
        p_tx_id: t.id,
        p_command_key: commandKey("void"),
        p_action: "هەڵوەشاندنەوەی مامەڵە",
        p_detail: `#${t.code || "—"} — ${fmt(t.amount)} ${cur(t.curId).code}`,
      });
      reloadBatches();
      if (approvalQueued(result, "هەڵوەشاندنەوەی مامەڵە")) return result;
      flash("مامەڵەکە هەڵوەشێندرایەوە ✓");
    }, `void:${t.id}`);
  };

  const settle = (t) => {
    if (!t || t.deleted) {
      flash("ئەم مامەڵەیە هەڵوەشێندراوەتەوە و ناتوانرێت تەسویە بکرێت");
      return false;
    }
    if (t.status === "completed") {
      flash("ئەم مامەڵەیە پێشتر تەواو کراوە");
      return false;
    }
    if (!(Number.isFinite(+t.total) && +t.total > 0)) {
      flash("کۆی مامەڵەکە دروست نییە");
      return false;
    }
    return run(async () => {
      const isBuy = t.type === "buy";
      await rpcStrict("sarraf_settle_transaction", {
        p_tx_id: t.id,
        p_by_office: false,
        p_command_key: commandKey("settle"),
        p_action: isBuy ? "پارە درا" : "پارە وەرگیرا",
        p_detail: `#${t.code || "—"} — ${fmt(t.total)} ${cur(t.againstId).code}`,
      });
      if (t.cpId) await notify(t.cpId, "payment",
        isBuy ? tr("پارەکەت درا") : tr("پارەکەت وەرگیرا"),
        `${fmt(t.total, cur(t.againstId).dec ?? 0)} ${cur(t.againstId).code}`, null, t.id);
      flash(isBuy ? "پارەدان تۆمار کرا ✓" : "وەرگرتن تۆمار کرا ✓");
    }, `settle:${t.id}:direct`);
  };
  const officePay = (t, officeId) => {
    if (!officeId) return flash("نووسینگەی بەرپرسی پارەدان هەڵبژێرە");
    return run(async () => {
      await rpcStrict("sarraf_create_office_payment_assignment", {
        p_transaction_id: t.id,
        p_office_id: officeId,
        p_due_at: null,
        p_reason: `ئەرکی پارەدان بۆ مامەڵەی #${t.code || t.id}`,
        p_command_key: commandKey("office-assign"),
      });
      await notify(officeId, "payment", tr("پارەدانێکی نوێ بۆ تۆ دیاریکرا"),
        `#${t.code || "—"} · ${fmt(t.total, cur(t.againstId).dec ?? 0)} ${cur(t.againstId).code}`, null, t.id);
      flash("ئەرکی پارەدان بۆ نووسینگە نێردرا ✓");
    }, `office-assign:${t.id}:${officeId}`);
  };

  // «هەر کاتێک ویستم حسابی نووسینگەکە بدەم و تەواو.» This is the only place the money actually
  // leaves: what the office covered has stood as a debt since it pressed, and paying it takes the
  // safe down, the office's account down to zero and the liability off the books together.
  const officeSettle = (officeId, curId, amount) => {
    if (!officeId || !curId) return flash(tr("نووسینگە هەڵبژێرە"), "error");
    if (!(amount > 0)) return flash(tr("ئەم نووسینگەیە هیچ قەرزێکی لەسەر نییە"), "error");
    return run(async () => {
      await rpcStrict("sarraf_office_settle", {
        p_office_id: officeId,
        p_cur_id: curId,
        p_amount: amount,
        p_reason: tr("حسابی نووسینگە درایەوە"),
        p_command_key: commandKey("office-settle"),
      });
      flash(tr("حسابی نووسینگە درایەوە ✓"));
    }, `office-settle:${officeId}:${curId}`);
  };

  const addExpense = (f) => {
    const amt = roundMoney(data, Math.abs(+f.amount), f.curId);
    if (!(amt > 0)) return flash("بڕی خەرجی پێویستە");
    if (f.category === "خێری وەبەرهێنەر" && !f.investorId) return flash("وەبەرهێنەر هەڵبژێرە");
    // Minted once per submission, not once per attempt: a retry must be the same expense.
    const entryId = uid();
    run(async () => {
      const isPayout = f.category === "خێری وەبەرهێنەر";
      const e = {
        id: entryId, type: isPayout ? "investor_payout" : "expense",
        owner: null, investorId: isPayout ? f.investorId : null,
        curId: f.curId, amount: -amt, partnerId: null, txId: null,
        note: `${f.category}${f.note ? " — " + f.note : ""}`, date: now(),
      };
      const result = await rpcStrict("sarraf_post_ledger_command", {
        p_ledger: [LR(e)],
        p_command_key: commandKey("expense"),
        p_action: isPayout ? "پارەدانی خێری وەبەرهێنەر" : "خەرجی",
        p_detail: `${fmt(amt)} ${cur(f.curId).code} — ${isPayout ? usr(f.investorId).name : f.category}`,
      });
      if (approvalQueued(result, isPayout ? "پارەدانی خێری وەبەرهێنەر" : "خەرجی")) return result;
      flash("تۆمار کرا ✓");
    }, `expense:${entryId}`);
  };

    const transfer = (f) => {
    const amt = roundMoney(data, Math.abs(+f.amount), f.curId);
    if (!amt || !f.partnerId) return flash("بڕ و هاوبەش دیاری بکە");
    // Minted once per submission, not once per attempt: a retry must be the same transfer.
    const [outId, inId] = [uid(), uid()];
    run(async () => {
      const base = { curId: f.curId, txId: null, date: now() };
      const es = f.dir === "to"
        ? [{ ...base, id: outId, type: "transfer", amount: -amt, partnerId: null },
           { ...base, id: inId, type: "transfer", amount: +amt, partnerId: f.partnerId }]
        : [{ ...base, id: outId, type: "transfer", amount: +amt, partnerId: null },
           { ...base, id: inId, type: "transfer", amount: -amt, partnerId: f.partnerId }];
      // The database validates this as one balanced main↔partner custody movement.
      const result = await rpcStrict("sarraf_post_ledger_command", {
        p_ledger: es.map(LR),
        p_command_key: commandKey("partner-transfer"),
        p_action: "گواستنەوە",
        p_detail: `${fmt(amt)} ${cur(f.curId).code} ${f.dir === "to" ? "بۆ لای" : "لە لای"} ${usr(f.partnerId).name}`,
      });
      if (approvalQueued(result, "گواستنەوەی هاوبەش")) return result;
      flash("گواستنەوە تۆمار کرا ✓");
    }, `partner-transfer:${outId}`);
  };

    const saveRates = (rows) => run(async () => {
    // One ratio per currency: 1 USD = X. Anything that is not a usable positive number is
    // refused here rather than dividing the whole system by it.
    const checked = rows.map((r) => ({ r, v: validateRate(r.rate) }));
    for (const { r, v } of checked) {
      if (!v.ok) throw new Error(`${cur(r.id).code} — ${rateErrorText(v.code)}`);
    }
    const payload = checked.map(({ r, v }) => ({ id: r.id, rate: v.rate }));
    const hist = checked.filter(({ v }) => v.rate != null).map(({ r, v }) => ({
      id: uid(), cur_id: r.id, rate: v.rate, changed_by: profile?.id || null,
    }));
    await rpcStrict("sarraf_save_rates", {
      p_rows: payload,
      p_history: hist,
      p_command_key: commandKey("rates"),
      p_action: "گۆڕینی نرخی ڕۆژ",
      p_detail: rows.map((r) => `1 USD = ${r.rate} ${cur(r.id).code}`).join("، "),
    });
    const body = rows.filter((r) => r.rate)
      .map((r) => `1 USD = ${r.rate} ${cur(r.id).code}`).join(" · ");
    for (const u of data.users.filter((x) => (x.role === "partner" || x.role === "customer") && !x.deleted)) {
      await notify(u.id, "rate", tr("نرخی ڕۆژ نوێ کرایەوە"), body);
    }
    flash("نرخەکان پاشەکەوت کران ✓");
  });

    const addCurrency = (nc) => run(async () => {
    if (!(profile?.role === "admin" && profile?.adminLevel === "owner")) {
      flash("تەنها خاوەنی سیستەم دەتوانێت دراوی نوێ زیاد بکات");
      return false;
    }
    const nextDec = Number.isInteger(Number(nc.dec)) ? Math.max(0, Math.min(6, Number(nc.dec))) : 2;
    await rpcStrict("sarraf_add_currency", {
      p_row: {
        id: String(nc.code || "").trim().toLowerCase(),
        code: String(nc.code || "").trim().toUpperCase(),
        name: String(nc.name || "").trim(),
        symbol: String(nc.symbol || "").trim(),
        dec: nextDec,
        external: !!nc.external,
      },
      p_command_key: commandKey("currency"),
    });
    flash("دراو زیاد کرا ✓");
  });

  const adminUserRequest = async (payload) => {
    const token = session?.access_token;
    if (!token) throw new Error("کاتی چوونەژوورەوە بەسەرچووە");
    const response = await fetch("/api/admin-user", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // `no_profile` reads as an accusation — "this login has no account" — and the person
      // reading it is signed in, looking at their own screens, and has every reason to believe
      // otherwise. Almost always they are right and the token is the stale part: the account was
      // rebuilt while this browser held a session for the login it replaced. The application
      // kept rendering because its own copy of the profile was already in memory, so nothing
      // said the session had died.
      //
      // So it says what to do instead of what is missing, and does it: signing out is the fix,
      // and leaving somebody to find that themselves is leaving them stuck.
      if (body?.code === "no_profile") {
        flash("چوونەژوورەوەکەت کۆنە — دەربچۆ و دووبارە بچۆ ژوورەوە");
        // Not signOut(): that is declared below the early returns, so this would depend on
        // where in the file it happens to sit. The cache goes first and for its own reason —
        // it is why the application kept drawing screens for a session that had already died.
        setTimeout(() => {
          try { localStorage.removeItem("cache"); localStorage.removeItem("bio"); } catch {}
          supabase.auth.signOut();
        }, 1800);
        const e = new Error("چوونەژوورەوەکەت کۆنە — دەربچۆ و دووبارە بچۆ ژوورەوە");
        e.code = "no_profile";
        throw e;
      }
      const e = new Error(body?.error || "نەتوانرا کردارەکە جێبەجێ بکرێت");
      e.code = body?.code || response.status;
      throw e;
    }
    return body;
  };

  const createUser = (f) => run(async () => {
    // Eight, not twelve. Twelve was chosen here and nowhere else — Supabase itself accepts six —
    // so the only thing it achieved was refusing passwords the owner had already decided on.
    if (!f.name || !f.phone || !f.password || f.password.length < 8) {
      flash("ناو، ژمارە، و وشەی نهێنی (لانیکەم ٨ پیت) پێویستن");
      return false;
    }
    await adminUserRequest({
      action: "create",
      name: f.name,
      phone: f.phone,
      password: f.password,
      role: f.role,
      rate: Number(f.rate) || 0,
      scope: f.scope || [],
      address: f.address || null,
      note: f.note || null,
    });
    flash("ئەکاونت درووست کرا ✓");
  });

  const deleteUser = (u) => {
    if (!window.confirm(`ناچالاککردنی ئەکاونتی «${u.name}»؟ مێژووی دارایی دەمێنێتەوە.`)) return;
    run(async () => {
      await adminUserRequest({ action: "deactivate", userId: u.id, tenantId: u.tenantId });
      flash("ئەکاونت ناچالاک کرا ✓");
    });
  };

  const setUserRate = (u, rate) => run(async () => {
    const n = Number(rate);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      flash("ڕێژە دەبێت لە نێوان ٠ تا ١٠٠ بێت");
      return false;
    }
    await adminUserRequest({ action: "update_rate", userId: u.id, rate: n, tenantId: u.tenantId });
    flash("ڕێژە نوێ کرایەوە ✓");
  });

  /* ── پارە دانان/دەرهێنان لە حسابی هەر کەسێک ── */
  //  دوو لای هەیە: قاسەی گشتی + قاسەی خودی ئەو کەسە
  const accountMove = (f) => {
    // Fixed before the first attempt, so a retry moves the same money once, not twice.
    const moveId = uid();
    return run(async () => {
    const amt = roundMoney(data, Math.abs(+f.amount), f.curId);
    if (!(amt > 0)) { flash("بڕ پێویستە"); return; }
    if (!f.userId) { flash("کەسەکە دیاری بکە"); return; }
    const u = usr(f.userId);
    const sign = f.dir === "in" ? 1 : -1;
    const at = now();

    const ae = {
      id: moveId, user_id: f.userId, kind: "cash", cur_id: f.curId, amount: sign * amt,
      type: f.dir === "in" ? "deposit" : "withdraw", note: f.note || null,
      created_by: profile?.id || null,
    };

    const ledgerRows = [
      LR({ id: uid(), type: sign > 0 ? "acc_in" : "acc_out", curId: f.curId,
        amount: sign * amt, note: `${sign > 0 ? "دانان لە" : "دەرهێنان بۆ"} ${u.name}`, date: at }),
    ];
    if (u.role === "investor") {
      ledgerRows.push(LR({ id: uid(), type: sign > 0 ? "deposit" : "withdraw", owner: "investor",
        investorId: f.userId, curId: f.curId, amount: sign * amt, note: f.note, date: at }));
    }

    const result = await rpcStrict("sarraf_account_move", {
      p_account_row: ae,
      p_ledger: [],
      p_command_key: commandKey("account-move"),
      p_action: f.dir === "in" ? "دانانی پارە" : "دەرهێنانی پارە",
      p_detail: `${fmt(amt)} ${cur(f.curId).code} — ${u.name}`,
    });
    if (approvalQueued(result, f.dir === "in" ? "دانانی پارە" : "دەرهێنانی پارە")) return result;

    await notify(f.userId, "transfer",
      f.dir === "in" ? tr("پارە خرایە حسابەکەت") : tr("پارە لە حسابەکەت دەرهێنرا"),
      `${fmt(amt, cur(f.curId).dec ?? 0)} ${cur(f.curId).code}`);
    flash("تۆمار کرا ✓");
    }, `account-move:${moveId}`);
  };

    /* ── گواستنەوەی پارە: حساب بۆ حساب ── */
  //  لای یەکێک کەم، لای ئەوی تر زیاد — قاسەی گشتی نەگۆڕ دەمێنێتەوە
  const accountTransfer = (f) => {
    // Fixed before the first attempt, so a retry moves the same money once, not twice.
    const ref = uid();
    const [fromRowId, toRowId] = [uid(), uid()];
    return run(async () => {
    const amt = roundMoney(data, Math.abs(+f.amount), f.curId);
    if (!(amt > 0)) { flash("بڕ پێویستە"); return; }
    if (!f.fromId || !f.toId) { flash("هەردوو لایەن دیاری بکە"); return; }
    if (f.fromId === f.toId) { flash("ناکرێت بۆ هەمان کەس بگوازرێتەوە"); return; }
    const a = usr(f.fromId), b = usr(f.toId);
    const at = now();

    const rows = [
      { id: fromRowId, user_id: f.fromId, kind: "cash", cur_id: f.curId, amount: -amt, type: "transfer_out",
        ref_id: ref, note: `بۆ ${b.name}${f.note ? " — " + f.note : ""}`, created_by: profile?.id || null },
      { id: toRowId, user_id: f.toId, kind: "cash", cur_id: f.curId, amount: +amt, type: "transfer_in",
        ref_id: ref, note: `لە ${a.name}${f.note ? " — " + f.note : ""}`, created_by: profile?.id || null },
    ];
    const transferRow = {
      id: ref, from_id: f.fromId, from_name: a.name, to_id: f.toId, to_name: b.name,
      cur_id: f.curId, amount: amt, note: f.note || null, created_by: profile?.id || null,
    };

    const inv = [];
    if (a.role === "investor") inv.push(LR({ id: uid(), type: "withdraw", owner: "investor", investorId: f.fromId, curId: f.curId, amount: -amt, note: `بۆ ${b.name}`, date: at }));
    if (b.role === "investor") inv.push(LR({ id: uid(), type: "deposit", owner: "investor", investorId: f.toId, curId: f.curId, amount: +amt, note: `لە ${a.name}`, date: at }));

    const result = await rpcStrict("sarraf_account_transfer", {
      p_account_rows: [],
      p_transfer: transferRow,
      p_ledger: [],
      p_command_key: commandKey("account-transfer"),
      p_action: "گواستنەوەی حساب",
      p_detail: `${fmt(amt)} ${cur(f.curId).code} — لە ${a.name} بۆ ${b.name}`,
    });
    if (approvalQueued(result, "گواستنەوەی حساب")) return result;

    await notify(f.fromId, "transfer", tr("پارە لە حسابەکەت دەرچوو"), `${fmt(amt, cur(f.curId).dec ?? 0)} ${cur(f.curId).code} → ${b.name}`);
    await notify(f.toId, "transfer", tr("پارە هاتە حسابەکەت"), `${fmt(amt, cur(f.curId).dec ?? 0)} ${cur(f.curId).code} ← ${a.name}`);
    flash("گواستنەوە تۆمار کرا ✓");
    }, `account-transfer:${ref}`);
  };

  /* ── بەستنی ڕۆژ ── */
  const closeDay = (lines, note, adjust) => {
    // Fixed before the first attempt, so a retry closes the same day once, not twice.
    const closeId = uid();
    return run(async () => {
    // The database refuses an unexplained difference; saying so here means the operator is
    // stopped at the button with the reason, not at the server with an error.
    const verdict = validateDayClose({ lines, note });
    if (!verdict.ok) { flash(dayCloseMessage(verdict.code)); return false; }
    const hasDiff = lines.some((l) => Math.abs(Number(l.diff) || 0) > 1e-9);
    const closePayload = {
      id: closeId, close_date: data.control?.business_date || new Date().toISOString().slice(0, 10),
      // The server re-reads the ledger and derives expected/diff/USD exposure from counted.
      lines, note: note || null,
      adjust: !!adjust, closed_by: profile?.id || null,
    };

    const result = await rpcStrict("sarraf_close_day", {
      p_close: closePayload,
      p_ledger: [],
      p_command_key: commandKey("day-close"),
      p_action: "بەستنی ڕۆژ",
      p_detail: lines.map((l) => `${cur(l.cur).code}: ${l.diff >= 0 ? "+" : ""}${fmtMoney(data, l.diff, l.cur)}`).join("، ") || "بێ جیاوازی",
    });
    if (approvalQueued(result, "بەستنی ڕۆژ")) return result;
    flash(!hasDiff ? "ڕۆژ بەسترا — هیچ جیاوازییەک نییە ✓" : "ڕۆژ بەسترا ✓");
    }, `day-close:${closeId}`);
  };

    /* ── هەڵوەشاندنەوەی پارەدان ── */
  const unsettle = (t) => {
    if (!window.confirm("پارەدانەکە بە تۆماری پێچەوانە هەڵبوەشێنرێتەوە؟ مامەڵەکە دەگەڕێتەوە بۆ «چاوەڕوان».")) return;
    run(async () => {
      const result = await rpcStrict("sarraf_unsettle_transaction", {
        p_tx_id: t.id,
        p_command_key: commandKey("unsettle"),
        p_action: "هەڵوەشاندنەوەی پارەدان",
        p_detail: `#${t.code || "—"} — ${fmt(t.total)} ${cur(t.againstId).code}`,
      });
      if (approvalQueued(result, "هەڵوەشاندنەوەی پارەدان")) return result;
      flash("پارەدان بە تۆماری پێچەوانە هەڵوەشێندرایەوە ✓");
    }, `unsettle:${t.id}`);
  };

  /* ── دروستکەر / پشکنەر + یەکسانکردنەوە ── */
  const approveApproval = (r, note = "") => run(async () => {
    const result = await rpcStrict("sarraf_approve_request", {
      p_approval_id: r.id,
      p_command_key: commandKey("approval-approve"),
      p_note: note || null,
    });
    if (result?.ok === false) {
      flash(result?.error || "جێبەجێکردنی داواکاری سەرکەوتوو نەبوو");
    } else {
      flash("داواکاری پەسەند کرا و جێبەجێ کرا ✓");
      reloadBatches();
    }
    return result;
  });

  const rejectApproval = (r, note) => run(async () => {
    const reason = String(note || "").trim();
    if (reason.length < 3) { flash("هۆکاری ڕەتکردنەوە بنووسە"); return false; }
    const result = await rpcStrict("sarraf_reject_request", {
      p_approval_id: r.id,
      p_command_key: commandKey("approval-reject"),
      p_note: reason,
    });
    flash("داواکاری ڕەتکرایەوە ✓");
    return result;
  });

  const cancelApproval = (r, note = "") => run(async () => {
    const result = await rpcStrict("sarraf_cancel_approval_request", {
      p_approval_id: r.id,
      p_command_key: commandKey("approval-cancel"),
      p_note: String(note || "").trim() || null,
    });
    flash("داواکاری هەڵوەشێندرایەوە ✓");
    return result;
  });

  const ownerOverrideApproval = (r, reason) => run(async () => {
    const why = String(reason || "").trim();
    if (why.length < 12) { flash("هۆکاری دەسەڵاتی فریاکەوتنی خاوەن لانیکەم ١٢ پیت بێت"); return false; }
    const result = await rpcStrict("sarraf_owner_override_approval", {
      p_approval_id: r.id,
      p_command_key: commandKey("owner-override"),
      p_reason: why,
    });
    if (result?.ok === false) flash(result?.error || "دەسەڵاتی فریاکەوتنی خاوەن سەرکەوتوو نەبوو");
    else {
      flash("دەسەڵاتی فریاکەوتنی خاوەن جێبەجێ کرا ✓");
      reloadBatches();
    }
    return result;
  });

  const saveControlSettings = (settings) => run(async () => {
    const result = await rpcStrict("sarraf_update_control_settings", {
      p_settings: settings,
      p_command_key: commandKey("control-settings"),
    });
    flash("ڕێکخستنەکانی کۆنترۆڵ پاشەکەوت کران ✓");
    return result;
  });

  const runReconciliation = async () => {
    const { data: result, error } = await supabase.rpc("sarraf_reconciliation_report");
    if (error) throw error;
    return result;
  };

  const runSystemHealth = async () => {
    const { data: result, error } = await supabase.rpc("sarraf_system_health");
    if (error) throw error;
    return result;
  };

  const setMaintenanceMode = async (enabled, reason) => {
    const why = String(reason || "").trim();
    if (why.length < 12) {
      flash("هۆکاری Emergency Freeze لانیکەم ١٢ پیت بێت");
      return false;
    }
    setBusy(true);
    try {
      const result = await rpcStrict("sarraf_set_maintenance_mode", {
        p_enabled: !!enabled,
        p_reason: why,
        p_command_key: commandKey(enabled ? "freeze-on" : "freeze-off"),
      });
      await loadAll();
      flash(enabled ? "Emergency Freeze چالاک کرا ✓" : "Emergency Freeze ناچالاک کرا ✓");
      return result;
    } catch (e) {
      console.error("maintenance-mode", e);
      flash(errorTextOr(e, "نەتوانرا Emergency Freeze بگۆڕدرێت"), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const loadTxHistoryPage = async ({ limit = 80, cursor = null, filters = {} } = {}) => {
    const args = {
      p_limit: limit,
      p_before_date: cursor?.date || null,
      p_before_id: cursor?.id || null,
      p_type: filters.type && filters.type !== "all" ? filters.type : null,
      p_status: filters.status && filters.status !== "all" ? filters.status : null,
      p_cur_id: filters.cur && filters.cur !== "all" ? filters.cur : null,
      p_from: filters.from || null,
      p_to: filters.to || null,
      p_search: filters.q ? String(filters.q).trim() : null,
    };
    const { data: result, error } = await supabase.rpc("sarraf_tx_history_page", args);
    if (error) throw error;
    return {
      items: (result?.items || []).map(mapTxRecord),
      hasMore: !!result?.has_more,
      nextCursor: result?.next_cursor || null,
      matchedCount: Number(result?.matched_count || 0),
      totalsByAgainst: Array.isArray(result?.totals_by_against) ? result.totals_by_against : [],
    };
  };

  const loadRangeReport = async ({ from, to } = {}) => {
    const { data: result, error } = await supabase.rpc("sarraf_report_range", {
      p_from: from || null,
      p_to: to || null,
    });
    if (error) throw error;
    return result || null;
  };

  const loadInventorySnapshot = async ({ curId, asOf = null, excludeTxId = null } = {}) => {
    const { data: result, error } = await supabase.rpc("sarraf_inventory_snapshot", {
      p_cur_id: curId,
      p_as_of: asOf,
      p_exclude_tx_id: excludeTxId,
    });
    if (error) throw error;
    return result || null;
  };

  /* ── پاراستنی داتا / off-site export ──
     A JSON export is a supplementary owner-controlled export, NOT a substitute
     for Supabase platform backups/PITR. The old same-database "auto backup"
     duplicated sensitive data inside the same failure domain and is disabled.
  */
  const downloadBackup = () => run(async () => {
    if (!(profile?.role === "admin" && profile?.adminLevel === "owner")) {
      flash("تەنها خاوەنی سیستەم دەتوانێت export ـی تەواوی داتا دابەزێنێت");
      return false;
    }

    const tables = [
      "currencies", "app_users", "txs", "ledger", "account_ledger",
      "account_transfers", "day_closes", "rate_history", "receipts",
      "receipt_batches", "approval_requests", "approval_events",
      "tx_versions", "audit",
    ];

    const rows = {};
    for (const table of tables) {
      const result = await fetchAllRows(table, { orders: [{ column: "id", ascending: true }], pageSize: 500, maxAttempts: 2 });
      if (result.error) throw result.error;
      rows[table] = result.data || [];
    }

    // Sealed rather than merely written: the file carries a checksum over its own contents, so
    // it can be read back later and proved intact instead of merely existing.
    const payload = await sealBackup({
      tables: rows,
      takenAt: now(),
      takenBy: profile?.id || null,
      warning:
        "Supplementary JSON export only. Auth identities, MFA secrets, Storage object bytes, database functions/policies, and WAL/PITR state are not included.",
    });

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = `sarraf_offsite_export_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    // Exporting the whole database is a privileged act and is recorded as one. A failure to
    // record it must not silently discard the export the owner already has.
    try {
      await rpcStrict("sarraf_record_audit_event", {
        p_action: "هەناردەی تەواوی داتا",
        p_detail: `${Object.keys(payload.counts).length} خشتە · checksum ${String(payload.integrity?.checksum || "—").slice(0, 16)}`,
        p_command_key: commandKey("audit-export"),
      });
    } catch (e) { console.error("backup audit", e); }
    flash("export ـی داتا ئامادە کرا ✓");
    return payload.integrity?.checksum || true;
  });

  /* ── ئاگادارکردنەوەکان ── */
  const [notes, setNotes] = useState([]);
  const [noteOpen, setNoteOpen] = useState(false);

  /**
   * One bell, both sources.
   *
   * `notes` has always been the notification centre. The receipt events added in 202608280009
   * arrived in a table of their own and were given a SECOND bell beside the first — two bells in
   * one header, each with its own unread count, and nobody could tell which was which. That was
   * my mistake and this is the correction: one panel, one count, merged newest first.
   *
   * They are shaped differently on purpose — a note carries `seen`, a receipt event carries
   * `read_at` — so they are mapped to one shape here rather than either table being changed.
   */
  const loadNotes = async () => {
    const [own, receipts] = await Promise.all([
      supabase.from("notes").select("*").order("created_at", { ascending: false }).limit(60),
      loadNotifications(supabase, { limit: 60 }).catch((e) => { console.error("receipt notifications", e); return []; }),
    ]);
    if (own.error) console.error("loadNotes", own.error);
    const asNote = (r) => ({
      id: r.id, source: "receipt", kind: r.kind, title: r.title, body: r.body,
      link: null, ref_id: r.subjectId, subject_kind: r.subjectKind,
      seen: !r.unread, created_at: r.createdAt,
    });
    const merged = [
      ...(own.data || []).map((n) => ({ ...n, source: "note" })),
      ...(receipts || []).map(asNote),
    ].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    setNotes(merged.slice(0, 80));
  };

  // ناردنی ئاگاداری بۆ کەسێک (یان بۆ ئەدمین گەر userId = null)
  const notify = async (userId, kind, title, body, link, refId) => {
    try {
      const r = await supabase.from("notes").insert({
        id: uid(), user_id: userId || null, kind, title,
        body: body || null, link: link || null, ref_id: refId || null,
      });
      if (r.error) throw r.error;
    } catch (e) { console.error("notify", e); }
  };

  // ناردنی ئاگاداری بە واتساپ — دەکرێتەوە لە وێبگەڕەکە
  const waNotify = (u, title, body) => {
    const ph = String(u?.phone || "").replace(/\D/g, "");
    if (!ph) { flash(tr("ژمارەی مۆبایلی ئەم کەسە نییە")); return; }
    const num = ph.startsWith("00") ? ph.slice(2) : ph.startsWith("0") ? "964" + ph.slice(1) : ph;
    const txt = `*${title}*\n${body || ""}`;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(txt)}`, "_blank");
  };

  const seeNote = async (n) => {
    setNotes((x) => x.map((y) => (y.id === n.id ? { ...y, seen: true } : y)));
    try {
      if (n.source === "receipt") await markNotificationRead(supabase, n.id);
      else await supabase.from("notes").update({ seen: true }).eq("id", n.id);
    } catch (e) { console.error("mark read", e); }
    // A notification that leads nowhere is a note, not a notification.
    if (n.source === "receipt") { if (openNotification({ subjectKind: n.subject_kind, subjectId: n.ref_id })) setNoteOpen(false); return; }
    if (n.link) { setPage(n.link); setNoteOpen(false); }
  };
  const seeAll = async () => {
    const ids = notes.filter((n) => !n.seen && n.source !== "receipt").map((n) => n.id);
    const anyReceipt = notes.some((n) => !n.seen && n.source === "receipt");
    if (!ids.length && !anyReceipt) return;
    setNotes((x) => x.map((y) => ({ ...y, seen: true })));
    try {
      if (ids.length) await supabase.from("notes").update({ seen: true }).in("id", ids);
      if (anyReceipt) await markAllNotificationsRead(supabase);
    } catch (e) { console.error("mark all read", e); }
  };
  const unseen = notes.filter((n) => !n.seen).length;

  const signOut = () => {
    loadSequence.current += 1;
    setData(null);
    setBatches([]);
    setRefreshedAt(null);
    try { localStorage.removeItem("cache"); localStorage.removeItem("bio"); } catch {}
    return supabase.auth.signOut();
  };

  /* ───────── ڕەندەر ───────── */
  if (session === undefined) return <><Styles /><Splash t={tr("بارکردنی سیستەم...")} /></>;
  if (!session) return <><Styles /><Login /></>;
  if (accessState === "checking") return <><Styles /><Splash t={tr("پشکنینی پاراستنی ئەکاونت...")} signOut={signOut} /></>;
  if (accessState === "mfa") return <><Styles /><MfaGate profile={profile} onReady={() => setAccessEpoch((x) => x + 1)} onSignOut={signOut} /></>;
  if (accessState === "error") return <><Styles /><Splash t={accessError || tr("هەڵە لە پشکنینی پاراستن")} signOut={signOut} /></>;
  if (accessState === "missing" || !profile) return <><Styles /><Splash t={tr("ئەکاونتەکەت بە سیستەمەکە نەبەستراوە — پەیوەندی بە ئەدمینەوە بکە.")} signOut={signOut} /></>;
  if (!data || !calc) return <><Styles /><Splash t={tr("بارکردنی داتا...")} signOut={signOut} /></>;

  const isAdmin = profile.role === "admin";
  // A manager outranks the business owner, so everything gated on isOwner admits them too.
  // Written as a set rather than a comparison: the first place that says === "owner" is the
  // place that locks the manager out of their own system.
  const isOwner = isAdmin && ["owner", "manager"].includes(profile.adminLevel);
  const isSystemManager = isAdmin && profile.adminLevel === "manager";
  const va = viewAs ? usr(viewAs) : null;
  const portalUser = !isAdmin ? profile : va;
  const navSectionLabel = (ku, en, ar) => lang === "en" ? en : lang === "ar" ? ar : ku;

  /**
   * Open whatever a notification is about.
   *
   * A batch is a place on the receipts screen, so it opens there with the batch already found.
   * A receipt belongs to whoever is looking: staff review it, and the person who sent it is
   * already looking at their own list, so for them there is nowhere else to go and the panel
   * simply closes. Returning false leaves the panel open, which is the honest answer when there
   * is no screen for the thing.
   */
  const openNotification = (item) => {
    if (!item?.subjectId) return false;
    if (item.subjectKind === "batch") {
      if (portalUser) return false;
      setSearchFocus(item.subjectId);
      setPage("receipts");
      return true;
    }
    if (item.subjectKind === "receipt" && isAdmin && !portalUser) {
      setPage("receipt-review");
      return true;
    }
    return false;
  };
  const systemNeedsAttention = !online || !!stale || !!data?.runtime?.maintenance_mode;
  const systemStatusLabel = systemNeedsAttention
    ? (!online
      ? navSectionLabel("ZEMAN ئۆفلاینە", "ZEMAN offline", "ZEMAN غير متصل")
      : data?.runtime?.maintenance_mode
        ? navSectionLabel("ZEMAN لە دۆخی وەستاندنی فریاکەوتندایە", "ZEMAN emergency freeze", "ZEMAN في وضع التجميد الطارئ")
        : navSectionLabel("داتای ZEMAN پێویستی بە نوێکردنەوە هەیە", "ZEMAN data refresh required", "بيانات ZEMAN بحاجة إلى تحديث"))
    : navSectionLabel("ZEMAN بەستراوە", "ZEMAN online", "ZEMAN متصل");
  const systemStatusText = systemNeedsAttention
    ? navSectionLabel("سەرنج", "Attention", "تنبيه")
    : navSectionLabel("بەستراو", "Online", "متصل");

  // The manager's own navigation, which is not the exchange's with two extra entries on it.
  //
  // They asked for this in as many words — their dashboard and every section of it different —
  // and the reason is not presentation. A manager belongs to no business. "New transaction",
  // "Transactions", "Reports" and the dashboard totals all mean *one business's*, and there is
  // no such business for the person who sold the software. Offering them is offering an action
  // with no correct answer.
  //
  // What a manager does have is the installation: which businesses run on it, who is in them,
  // whether the schema is sound, and the default rates a new business inherits until it sets
  // its own. Every id here already exists; what changes is that these are the whole of their
  // world rather than a drawer inside somebody else's.
  const MANAGER_NAV_GROUPS = [
    {
      label: navSectionLabel("دامەزراندن", "Installation", "التثبيت"),
      items: [
        ["manager-console", navSectionLabel("سەرخێڵەکان", "Businesses", "الأعمال"), Building2],
        ["manager-center", navSectionLabel("ئەکاونت و پلەکان", "Accounts & ranks", "الحسابات والرتب"), KeyRound],
      ],
    },
    {
      label: navSectionLabel("تەندروستی", "Health", "الصحة"),
      items: [
        ["integrity", navSectionLabel("یەکپارچەیی", "Integrity", "السلامة"), ShieldAlert],
        ["audit", navSectionLabel("تۆماری گۆڕانکاری", "Change log", "سجل التغييرات"), History],
        ["backup", navSectionLabel("پاراستنی داتا", "Data protection", "حماية البيانات"), Database],
      ],
    },
  ];

  const NAV_GROUPS = isSystemManager ? MANAGER_NAV_GROUPS : [
    {
      label: navSectionLabel("سەرەکی", "Overview", "نظرة عامة"),
      items: [
        ["dash", tr("داشبۆرد"), LayoutDashboard],
      ],
    },
    {
      label: navSectionLabel("بازرگانی", "Trading", "التداول"),
      items: [
        ["newtx", tr("مامەڵەی نوێ"), ArrowLeftRight],
        ["txs", tr("مامەڵەکان"), ListOrdered],
        // Not "پشکنینی فیش": the admin centre already has a screen by that name, and two
        // different things with one name is a person opening the wrong one and concluding the
        // right one is broken. This is the working list of batches — where a batch becomes a
        // transaction. The other is the per-receipt examination.
        ["receipts", tr("فیشەکان"), ScanLine],
      ],
    },
    {
      label: navSectionLabel("بەڕێوەبردن", "Management", "الإدارة"),
      items: [
        ["people", tr("بەکارهێنەران"), Users],
        ["report", tr("ڕاپۆرت"), PieChart],
      ],
    },
    {
      label: navSectionLabel("کارەکان", "Work", "الأعمال"),
      items: [
        ["admin-center", navSectionLabel("کاری ئەمڕۆ", "Today's work", "عمل اليوم"), Inbox],
      ],
    },
  ];
  const NAV = NAV_GROUPS.flatMap((g) => g.items);
  const isNavActive = (id) => id === "admin-center" ? ADMIN_CENTER_PAGE_IDS.has(page) : page === id;


  const shared = { data, calc, cur, usr, mySafe, profitAll, profitIn, ownProfitIn, ownProfitAll,
    investorsProfitIn, invShare, invUnpaid, autoRate, avgRate, inventoryPosition, usdValueAt, usdToCurrencyAt,
    toUsd, sumUsd, ratesReady, owners, notify, waNotify, isOwner, flash,
    readModel: data?.readModel || null, loadTxHistoryPage, loadRangeReport, loadInventorySnapshot };

  return (
    <div dir={LANGS[lang]?.dir || "rtl"} key={lang} className="zeman-shell min-h-screen" style={{ background: "var(--bg)", color: "var(--txt)" }}>
      <Styles />
      <a className="zeman-skip-link" href="#zeman-main-content">{navSectionLabel("بڕۆ بۆ ناوەڕۆکی سەرەکی", "Skip to main content", "الانتقال إلى المحتوى الرئيسي")}</a>

      {(!online || stale) && (
        <div className="sticky top-[57px] z-30 px-3 py-2 text-center text-[12px] font-semibold flex items-center justify-center gap-2"
          style={{ background: "color-mix(in srgb, var(--warn) 92%, black)", color: "#fff" }}>
          <WifiOff className="w-3.5 h-3.5" />
          {online ? "پەیوەندی گەڕایەوە — نوێکردنەوە..." : "ئینتەرنێت نییە — داتای هەڵگیراو پیشان دەدرێت"}
          {stale && <span className="opacity-75" style={num}>({new Date(stale).toLocaleTimeString("en-GB")})</span>}
        </div>
      )}
      {isAdmin && data?.runtime?.maintenance_mode && (
        <div className="sticky top-[57px] z-30 px-3 py-2.5 text-center text-[12px] font-bold flex items-center justify-center gap-2"
          style={{ background: "color-mix(in srgb, var(--neg) 92%, black)", color: "#fff" }}>
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            Emergency Freeze چالاکە — گۆڕانکاری دارایی قەدەغەیە
            {data.runtime.maintenance_reason ? ` · ${data.runtime.maintenance_reason}` : ""}
          </span>
        </div>
      )}
      {msg && (
        <div className="fixed top-0 right-0 left-0 z-[60] flex justify-center px-4" style={{ paddingTop: "calc(env(safe-area-inset-top) + 12px)" }}>
          <div className={`drop flex items-center gap-2.5 px-5 py-3.5 rounded-[var(--r)] shadow-xl text-white font-bold text-sm max-w-md w-full justify-center ${flashIsGood(msg, msgTone) ? "bg-emerald-600" : "bg-slate-900"}`}>
            {flashIsGood(msg, msgTone) ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : <AlertTriangle className="w-5 h-5 shrink-0" />}
            <span>{msg.replace(" ✓", "")}</span>
          </div>
        </div>
      )}
      {busy && <div className="fixed top-0 right-0 left-0 h-0.5 bg-emerald-600 animate-pulse z-50" />}

      <header className="sticky top-0 z-40 sarraf-topbar"
        style={{ paddingTop: "env(safe-area-inset-top)", borderInline: 0, borderTop: 0, borderBottom: "1px solid var(--line)" }}>
        <div className={`px-4 md:px-7 py-3 flex items-center justify-between gap-3 mx-auto ${portalUser ? "max-w-[920px]" : "max-w-[1600px] md:ml-[260px]"}`}>
          <div className="flex items-center gap-3 min-w-0">
            {/* min-w-0 and a truncate, or eight action buttons push the name off its own
                header and sit on top of it. */}
            <div className="flex md:hidden items-center gap-2.5 me-1 min-w-0">
              <BrandLogo variant="symbol" decorative className="w-9 h-9 shrink-0" />
              <div className="min-w-0">
                <div className="text-[15px] font-extrabold tracking-tight truncate" style={{color:"var(--txt)"}}>{BRAND.shortName}</div>
                <BuildStamp />
              </div>
            </div>
            <div className="hidden md:flex w-10 h-10 rounded-full items-center justify-center shrink-0"
              style={{ background: "linear-gradient(155deg, var(--ac), var(--ac-2))",
                       boxShadow: "0 4px 14px -3px rgba(var(--ac-gl),.55)" }}>
              <span className="text-[15px] font-bold" style={{ color: "var(--ac-ink)" }}>{(profile.name || "?").slice(0, 1)}</span>
            </div>
            <div className="hidden md:block min-w-0">
              <div className="text-[15px] font-semibold leading-tight truncate" style={{ color: "var(--txt)" }}>
                {profile.name}
              </div>
              <div className="text-[11.5px] truncate" style={{ color: "var(--txt-3)" }}>
                {va ? `${tr("بینین وەک")} · ${va.name}` : (isOwner ? tr("خاوەنی سیستەم") : tr(ROLE_KU[profile.role]))}
              </div>
            </div>
            {!portalUser && <div className={`zeman-system-status ${systemNeedsAttention ? "is-attention" : "is-live"}`} role="status" aria-label={systemStatusLabel} title={systemStatusLabel}>
              <span className="zeman-system-light is-green" aria-hidden="true" />
              <span className="zeman-system-light is-red" aria-hidden="true" />
              <span className="hidden lg:inline">{systemStatusText}</span>
            </div>}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {!portalUser && isAdmin && <React.Suspense fallback={null}><OperationalPalette client={supabase} lang={lang} onNavigate={(path, focus) => { setPage(path.slice(2)); setSearchFocus(focus || ""); }} /></React.Suspense>}
            {isAdmin && va && (
              <button onClick={() => setViewAs(null)}
                className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-2 rounded-full tap"
                style={{ background: "rgba(var(--ac-gl),.16)", color: "var(--ac)" }}>
                <LogOut className="w-3.5 h-3.5" /> {tr("گەڕانەوە")}
              </button>
            )}
            {/* زەنگی ئاگاداری */}
            <div className="relative">
              <button onClick={() => { setNoteOpen(!noteOpen); if (!noteOpen) setTimeout(seeAll, 1800); }}
                aria-label={tr("ئاگادارییەکان")} aria-expanded={noteOpen} aria-controls="zeman-notifications-panel"
                className="w-9 h-9 rounded-full tap flex items-center justify-center relative"
                style={{ background: "var(--glass)", border: "1px solid var(--line)", color: "var(--txt-2)" }}>
                <Bell className="w-4 h-4" />
                {unseen > 0 && (
                  <span className="absolute -top-0.5 -end-0.5 min-w-[17px] h-[17px] px-1 rounded-full text-[9.5px] font-bold flex items-center justify-center"
                    style={{ background: "var(--neg)", color: "#fff", ...num }}>
                    {unseen > 9 ? "9+" : unseen}
                  </span>
                )}
              </button>
              {noteOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setNoteOpen(false)} />
                  <div id="zeman-notifications-panel" className="fixed sm:absolute inset-x-3 sm:inset-x-auto top-[70px] sm:top-full sm:mt-2 sm:end-0 z-50 rounded-[var(--r)] overflow-hidden drop sm:w-[340px]"
                    style={{ background: "var(--surf-2)", border: "1px solid var(--line)", boxShadow: "var(--sh-3)" }}>
                    <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid var(--line)" }}>
                      <span className="text-[13px] font-semibold" style={{ color: "var(--txt)" }}>{tr("ئاگادارییەکان")}</span>
                      {unseen > 0 && (
                        <button onClick={seeAll} className="text-[11.5px] font-semibold tap" style={{ color: "var(--ac)" }}>
                          {tr("هەمووی بینراو")}
                        </button>
                      )}
                    </div>
                    <div className="max-h-[65vh] sm:max-h-[380px] overflow-y-auto">
                      {notes.length === 0 ? <Empty t={tr("هیچ ئاگادارییەک نییە")} /> :
                        notes.map((n) => (
                          <button key={n.id} onClick={() => seeNote(n)}
                            className="w-full text-start px-4 py-3 flex gap-3 tap"
                            style={{ borderBottom: "1px solid var(--line)", background: n.seen ? "transparent" : "rgba(var(--ac-gl),.06)" }}>
                            <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                              style={{ background: NOTE_ICON[n.kind]?.bg || "var(--glass-2)" }}>
                              {(() => { const I = NOTE_ICON[n.kind]?.Ic || Bell;
                                return <I className="w-[15px] h-[15px]" style={{ color: NOTE_ICON[n.kind]?.fg || "var(--txt-2)" }} />; })()}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="text-[13px] font-semibold block truncate" style={{ color: "var(--txt)" }}>{n.title}</span>
                              {n.body && <span className="text-[11.5px] block truncate mt-0.5" style={{ color: "var(--txt-2)" }}>{n.body}</span>}
                              <span className="text-[10px] block mt-1" style={{ ...num, color: "var(--txt-3)" }}>
                                {relTime(n.created_at)}
                              </span>
                            </span>
                            {!n.seen && <span className="w-2 h-2 rounded-full shrink-0 mt-2" style={{ background: "var(--ac)" }} />}
                          </button>
                        ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {!portalUser && <div className="relative">
              <button onClick={() => setLangOpen(!langOpen)}
                aria-label={navSectionLabel("گۆڕینی زمان", "Change language", "تغيير اللغة")} aria-expanded={langOpen}
                className="w-9 h-9 rounded-full text-[11px] font-bold tap flex items-center justify-center"
                style={{ background: "var(--glass)", border: "1px solid var(--line)", color: "var(--txt-2)" }}>
                {LANGS[lang]?.flag || "KU"}
              </button>
              {langOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setLangOpen(false)} />
                  <div className="absolute top-full mt-2 end-0 z-50 rounded-[var(--r-sm)] overflow-hidden min-w-[140px] drop"
                    style={{ background: "var(--surf-2)", border: "1px solid var(--line)", boxShadow: "var(--sh-3)" }}>
                    {Object.entries(LANGS).map(([k, v]) => (
                      <button key={k} onClick={() => { changeLang(k); setLangOpen(false); }}
                        className="w-full text-start px-4 py-2.5 text-[13px] flex items-center gap-2.5 tap"
                        style={lang === k ? { background: "rgba(var(--ac-gl),.16)", color: "var(--ac)", fontWeight: 600 } : { color: "var(--txt-2)" }}>
                        <span className="text-[10px] font-bold opacity-60">{v.flag}</span> {v.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>}
            {!portalUser && <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? navSectionLabel("ڕووناککردنی ڕووکار", "Use light theme", "استخدام المظهر الفاتح") : navSectionLabel("تاریککردنی ڕووکار", "Use dark theme", "استخدام المظهر الداكن")}
              className="w-9 h-9 rounded-full tap flex items-center justify-center"
              style={{ background: "var(--glass)", border: "1px solid var(--line)", color: "var(--txt-2)" }}>
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>}
            <button onClick={signOut} aria-label={navSectionLabel("چوونەدەرەوە", "Sign out", "تسجيل الخروج")} className="w-9 h-9 rounded-full tap flex items-center justify-center"
              style={{ background: "var(--glass)", border: "1px solid var(--line)", color: "var(--txt-2)" }}>
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Before anything else on the page: a fix nobody is running is a fix nobody has. */}
      <UpdateBanner lang={lang} />

      {truncatedTables.length > 0 && (
        <div role="alert" className="mx-4 md:mx-8 mt-3 rounded-[var(--r-sm)] px-4 py-3 text-[12px] leading-6"
             style={{ background: "rgba(220,38,38,.12)", border: "1px solid var(--neg)", color: "var(--neg)" }}>
          <b>{navSectionLabel("ژمارەکان تەواو نین", "The figures are incomplete", "الأرقام غير مكتملة")}</b>
          {" — "}
          {navSectionLabel(
            `تۆمارەکانی ${truncatedTables.join("، ")} زۆرترن لەوەی بتوانرێت لە وێبگەڕدا بارببرێن. پەیوەندی بە پشتگیرییەوە بکە پێش ئەوەی پشت بەم ژمارانە ببەستیت.`,
            `${truncatedTables.join(", ")} holds more rows than the browser can load. Contact support before relying on these figures.`,
            `${truncatedTables.join("، ")} يحتوي على صفوف أكثر مما يمكن تحميله. تواصل مع الدعم قبل الاعتماد على هذه الأرقام.`)}
        </div>
      )}

      {!portalUser && <DeferredPanel compact><MarketPulse currencies={data.currencies} lang={lang} online={online} /></DeferredPanel>}

      {portalUser ? (
        <main id="zeman-main-content" tabIndex={-1} className="px-4 pt-5 pb-28 md:px-8 md:pb-10 max-w-[920px] mx-auto"><Portal user={portalUser} {...shared} officePay={officePay} settle={settle} flash={flash} reloadBatches={reloadBatches} accountMove={accountMove} accountTransfer={accountTransfer} online={online} stale={stale} refreshing={refreshing} refreshedAt={refreshedAt} refresh={() => loadAll(profile)} /></main>
      ) : (
        <div className="flex flex-col md:flex-row">
          {/* لیستی لاتەنیشت — تەنها لە شاشەی گەورە */}
          <nav className="sarraf-sidebar hidden md:flex md:w-[236px] md:min-h-screen p-4 flex-col gap-1 fixed left-0 top-0 bottom-0 z-50 overflow-y-auto">
            <div className="flex items-center gap-3 px-2 pt-2 pb-6">
              <BrandLogo variant="symbol" decorative className="w-10 h-10" />
              <div>
                <div className="text-[16px] font-extrabold tracking-tight text-white">{BRAND.name}</div>
                <div className="text-[9.5px] mt-0.5" style={{color:"#9CB4AF"}}>{BRAND.descriptor}</div>
              </div>
            </div>
            <div className="space-y-4">
              {NAV_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="sidebar-section-title px-3 pb-1.5">{group.label}</div>
                  <div className="space-y-1">
                    {group.items.map(([id, t, Ic]) => {
                      const on = isNavActive(id);
                      return (
                        <button key={id} onClick={() => { setPage(id); setDetailId(null); setEditTx(null); }}
                          style={on ? { color: "#07130D" } : { color: "#A9B0B8" }}
                          className={`nav-item ${on ? "nav-active" : ""} flex w-full items-center gap-3 px-3.5 py-2.5 rounded-xl text-[12.5px] tap relative ${on ? "font-semibold" : "font-medium"}`}>
                          <Ic className="w-[17px] h-[17px]" style={{ color: on ? "#07130D" : "#8F98A3" }} />
                          <span className="truncate">{t}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {isAdmin && (
              <div className="mt-5 pt-4" style={{ borderTop: "1px solid var(--line)" }}>
                <div className="flex items-center gap-1.5 text-[11px] font-semibold mb-2 px-1" style={{ color: "var(--txt-3)" }}>
                  <Eye className="w-3.5 h-3.5" /> {tr("بینین وەک")}
                </div>
                <ViewAsPicker users={data.users} onPick={setViewAs} compact />
              </div>
            )}
          </nav>
          <main id="zeman-main-content" tabIndex={-1} className="sarraf-main sarraf-desktop-content flex-1 px-4 pt-5 pb-28 md:px-8 md:pt-7 md:pb-10 max-w-[1600px] w-full mx-auto">
            {page === "dash" && <Dashboard {...shared} batches={batches} go={setPage} />}
            {page === "safes" && <><Back onClick={() => setPage("dash")} t={tr("گەڕانەوە بۆ داشبۆرد")} /><Safes {...shared} addDeposit={addDeposit} addExpense={addExpense} addCurrency={addCurrency} /></>}
            {page === "rates" && <><Back onClick={() => setPage("dash")} t={tr("گەڕانەوە بۆ داشبۆرد")} /><Rates {...shared} saveRates={saveRates} /></>}
            {page === "profit" && <><Back onClick={() => setPage("dash")} t={tr("گەڕانەوە بۆ داشبۆرد")} /><ProfitPage {...shared} /></>}
            {page === "newtx" && <TxForm {...shared} onSave={saveTx} batch={pendingBatch} onClearBatch={() => setPendingBatch(null)} busy={busy} />}
            {page === "txs" && (editTx
              ? <TxForm {...shared} onSave={saveTx} editing={editTx} onCancel={() => setEditTx(null)} />
              : <TxList {...shared} onEdit={setEditTx} onDel={delTx} settle={settle} unsettle={unsettle} />)}
            {page === "receipts" && <ReceiptsHub {...shared} batches={batches} batchLoadError={batchLoadError} reloadBatches={reloadBatches} flash={flash} profile={profile}
              searchFocus={searchFocus} onMakeTx={(b) => { setPendingBatch(b); setPage("newtx"); }} />}
            {page === "people" && <PeopleHub {...shared} accountMove={accountMove} accountTransfer={accountTransfer} profile={profile} detailId={detailId} setDetailId={setDetailId} onSave={saveTx} transfer={transfer} officePay={officePay} officeSettle={officeSettle} settle={settle} createUser={createUser} deleteUser={deleteUser} setUserRate={setUserRate} flash={flash} />}
            {page === "report" && <Report {...shared} />}
            {/* The admin centre is one business's world. A manager belongs to no business, so
                for them it is not a page they should not open — it is a page with no meaning. */}
            {page === "admin-center" && !isSystemManager && <AdminCenterHub lang={lang} onNavigate={setPage}
              data={data} calc={calc} cur={cur} batches={batches} />}

            {/* The way back, and the door the manager fell through. Integrity, the change log
                and data protection are on the manager's own navigation and are also filed under
                the admin centre, so this link appeared for them too and led straight into the
                exchange's hub — every screen belonging to a business they are not part of. It
                now returns each rank to where they came from. */}
            {ADMIN_CENTER_PAGE_IDS.has(page) && page !== "admin-center" && (
              <Back onClick={() => setPage(isSystemManager ? "manager-console" : "admin-center")}
                    t={isSystemManager
                      ? navSectionLabel("گەڕانەوە بۆ سەرخێڵەکان", "Back to Businesses", "العودة إلى الأعمال")
                      : navSectionLabel("گەڕانەوە بۆ ناوەندی بەڕێوەبردن", "Back to Admin Center", "العودة إلى مركز الإدارة")} />
            )}
            {page === "action-inbox" && <DeferredPanel><ActionInbox client={supabase} lang={lang} onNavigate={(path) => setPage(path.slice(2))} /></DeferredPanel>}
            {page === "integrity" && <DeferredPanel><IntegrityCenter client={supabase} lang={lang} onNavigate={(path) => setPage(path.slice(2))} /></DeferredPanel>}
            {/* Two records of the same money are only safe while they agree. */}
            {page === "integrity" && <div className="mt-4"><DeferredPanel><BooksReconciliation client={supabase} lang={lang} flash={flash} /></DeferredPanel></div>}
            {page === "export-audit" && <DeferredPanel><ExportAuditCenter client={supabase} lang={lang} /></DeferredPanel>}
            {page === "debt-center" && <DeferredPanel><DebtCenter client={supabase} lang={lang}
              nameOf={(id) => usr(id).name} canAct={isAdmin} flash={flash} /></DeferredPanel>}
            {page === "receipt-review" && <DeferredPanel><ReceiptReviewWorkspace client={supabase} lang={lang}
              actorId={profile?.id || null} flash={flash}
              signedUrlFor={async (path) => {
                const { data } = await supabase.storage.from("receipts").createSignedUrl(path, 3600);
                return data?.signedUrl || null;
              }} /></DeferredPanel>}
            {page === "receipt-forwarding" && <DeferredPanel><ReceiptForwardingCenter client={supabase} lang={lang} flash={flash}
              people={(data?.users || []).filter((u) => !u.deleted)}
              signedUrlFor={async (path) => {
                const { data: signed } = await supabase.storage.from("receipts").createSignedUrl(path, 3600);
                return signed?.signedUrl || null;
              }} /></DeferredPanel>}
            {page === "office-payments" && (() => {
              // The office's own screen belongs to the office; this is the owner's side of it —
              // every office, what it is owed, and the one press that pays it back.
              const offices = data.users.filter((u) => u.role === "office" && !u.deleted);
              return <div className="space-y-4">
                <H sub={tr("ئەوەی نووسینگەکان لە پارەی خۆیانەوە داویانە و هێشتا وەریان نەگرتووەتەوە")}>
                  {tr("پارەدانی نووسینگە")}
                </H>
                {offices.length === 0
                  ? <Card><Empty t={tr("هیچ نووسینگەیەکی چالاک نییە")} /></Card>
                  : offices.map((o) => <OfficeDebts key={o.id} data={data} calc={calc} officeId={o.id}
                      title={o.name} officeSettle={officeSettle} readOnly={!isAdmin} />)}
              </div>;
            })()}
            {page === "partner-accounts" && <DeferredPanel><PartnerAccounts client={supabase} lang={lang} flash={flash}
              partners={(data?.users || []).filter((u) => u.role === "partner" && !u.deleted)} /></DeferredPanel>}
            {page === "partner-holdings" && <DeferredPanel><PartnerHoldings client={supabase} lang={lang}
              isStaff={isAdmin || profile?.role === "office"}
              partners={(data?.users || []).filter((u) => u.role === "partner" && !u.deleted)} /></DeferredPanel>}
            {page === "manager-center" && <DeferredPanel><ManagerCenter lang={lang}
              users={data?.users || []} profile={profile} flash={flash}
              request={adminUserRequest} onDone={loadAll} /></DeferredPanel>}
            {page === "manager-console" && <DeferredPanel><ManagerConsole client={supabase}
              lang={lang} isManager={isSystemManager} flash={flash} /></DeferredPanel>}
            {page === "cashbox" && <DeferredPanel><CashboxPanel client={supabase} lang={lang} flash={flash}
              customers={(data?.users || []).filter((u) => u.role === "customer" && !u.deleted)}
              rateFor={(code) => { const c = (data?.currencies || []).find((x) => x.code === code);
                const mid = rateOf(c);
                return mid > 0 ? mid : null; }} /></DeferredPanel>}
            {page === "approvals" && <ApprovalCenter
              data={data} profile={profile} isOwner={isOwner} cur={cur}
              approve={approveApproval} reject={rejectApproval} cancel={cancelApproval}
              ownerOverride={ownerOverrideApproval} saveSettings={saveControlSettings}
              reconcile={runReconciliation} busy={busy} flash={flash}
            />}
            {page === "audit" && <Audit data={data} />}
            {page === "insights" && <Insights {...shared} flash={flash} />}
            {page === "close" && <DayClose data={data} calc={calc} cur={cur} usr={usr} closeDay={closeDay} sumUsd={sumUsd} />}
            {page === "backup" && <Backup data={data} calc={calc} cur={cur} downloadBackup={downloadBackup} flash={flash} sumUsd={sumUsd} mySafe={mySafe} owners={owners} ratesReady={ratesReady} isOwner={isOwner} runSystemHealth={runSystemHealth} setMaintenanceMode={setMaintenanceMode} />}
          </main>

          {/* لیستی خوارەوە — تەنها لە مۆبایل */}
          <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 px-3 pb-[max(env(safe-area-inset-bottom),10px)] pt-2 pointer-events-none">
            <div className="flex glass rounded-full p-1.5 pointer-events-auto mx-auto max-w-md"
              style={{ boxShadow: "var(--sh-3)" }}>
              {NAV.slice(0, 4).map(([id, t, Ic]) => {
                const on = isNavActive(id);
                return (
                  <button key={id} onClick={() => { setPage(id); setDetailId(null); setEditTx(null); setMore(false); }}
                    className="flex-1 flex flex-col items-center gap-1 py-2 rounded-full tap"
                    style={on ? { background: "var(--surf-3)" } : {}}>
                    <Ic className="w-[19px] h-[19px]" style={{ color: on ? "var(--ac)" : "var(--txt-3)" }} />
                    <span className="text-[9.5px] font-semibold" style={{ color: on ? "var(--txt)" : "var(--txt-3)" }}>{t}</span>
                  </button>
                );
              })}
              <button onClick={() => setMore(!more)}
                className="flex-1 flex flex-col items-center gap-1 py-2 rounded-full tap"
                style={NAV.slice(4).some(([id]) => isNavActive(id)) ? { background: "var(--surf-3)" } : {}}>
                <MoreHorizontal className="w-[19px] h-[19px]"
                  style={{ color: NAV.slice(4).some(([id]) => isNavActive(id)) ? "var(--ac)" : "var(--txt-3)" }} />
                <span className="text-[9.5px] font-semibold" style={{ color: "var(--txt-3)" }}>{tr("زیاتر")}</span>
              </button>
            </div>
          </nav>

          {more && (
            <div className="md:hidden fixed inset-0 z-50 bg-slate-900/40" onClick={() => setMore(false)}>
              <div className="absolute bottom-0 right-0 left-0 rounded-t-[28px] p-4 pb-8 sheet"
                style={{ background: "var(--surf)", boxShadow: "0 -8px 40px -8px rgba(13,17,23,.3)" }} onClick={(e) => e.stopPropagation()}>
                <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: "var(--line)" }} />
                <div className="flex items-center justify-between mb-3">
                  <div className="font-bold text-[var(--txt)]">{tr("بەشەکانی تر")}</div>
                  <button onClick={() => setMore(false)} aria-label={tr("داخستنی بەشەکانی تر")}
                    className="p-1.5 text-[var(--txt-3)]"><X className="w-5 h-5" /></button>
                </div>
                {NAV.slice(4).map(([id, t, Ic]) => (
                  <button key={id} onClick={() => { setPage(id); setDetailId(null); setEditTx(null); setMore(false); }}
                    className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-[var(--r-sm)] text-sm mb-1 ${isNavActive(id) ? "bg-[var(--pos)] text-white font-semibold" : "text-[var(--txt)] hover:bg-[var(--line)]"}`}>
                    <Ic className="w-5 h-5" /> {t}
                  </button>
                ))}
                {isAdmin && (
                  <div className="mt-3 pt-3 border-t border-[var(--line)]">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[var(--txt-2)] mb-2 px-1">
                      <Eye className="w-4 h-4" /> {tr("بینین وەک بەکارهێنەرێکی تر")}
                    </div>
                    <ViewAsPicker users={data.users} onPick={(id) => { setViewAs(id); setMore(false); }} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* هەڵبژاردنی بەکارهێنەر بە گەڕان */
function ViewAsPicker({ users, onPick, compact }) {
  const [q, setQ] = useState("");
  const list = users.filter((u) => u.role !== "admin" && !u.deleted)
    .filter((u) => !q || (u.name || "").includes(q) || (u.phone || "").includes(q) || (ROLE_KU[u.role] || "").includes(q));
  return (
    <div>
      <Inp value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr("گەڕان بە ناو، ژمارە، یان ڕۆڵ")}
        placeholder={tr("گەڕان بە ناو، ژمارە، یان ڕۆڵ...")}
        className={compact ? "text-xs py-2" : ""} />
      <div className={`mt-1.5 space-y-1 overflow-y-auto ${compact ? "max-h-44" : "max-h-64"}`}>
        {list.length === 0 ? <div className="text-xs text-[var(--txt-3)] py-2 text-center">{tr("هیچ نەدۆزرایەوە")}</div> :
          list.map((u) => (
            <button key={u.id} onClick={() => onPick(u.id)}
              className="w-full text-right px-3 py-2 rounded-lg hover:bg-[var(--pos)] hover:text-white transition group">
              <div className={`font-semibold ${compact ? "text-xs" : "text-sm"} text-[var(--txt)] group-hover:text-white`}>{u.name}</div>
              <div className="text-[10px] text-[var(--txt-3)] group-hover:text-emerald-100">
                {ROLE_KU[u.role]}{u.phone && <span style={num}> · {u.phone}</span>}
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}

/* ══════════════════ لۆگین ══════════════════ */
function Splash({ t, signOut }) {
  return (
    <div dir={LANGS[_lang]?.dir || "rtl"} className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center" style={{ background: "var(--bg)", color: "var(--txt-2)" }}>
      <Vault className="w-10 h-10 text-amber-500" />
      <div>{t}</div>
      {signOut && <Btn kind="ghost" onClick={signOut}>{tr("دەرچوون")}</Btn>}
    </div>
  );
}

/* ── بایۆمەتریک ──
   Custom biometric login is disabled in production because the old prototype
   stored the account password in browser localStorage. Re-enable only with a
   real server-verified passkey/WebAuthn flow that never stores passwords. */
const bioAvailable = async () => false;
const bioSave = async () => {
  try { localStorage.removeItem("bio"); } catch {}
  return false;
};
const bioLogin = async () => {
  try { localStorage.removeItem("bio"); } catch {}
  return null;
};


function MfaGate({ profile, onReady, onSignOut }) {
  const [mode, setMode] = useState("loading"); // loading | challenge | enroll
  const [factorId, setFactorId] = useState("");
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const verifiedFactors = (data) => {
    const all = [
      ...(Array.isArray(data?.totp) ? data.totp : []),
      ...(Array.isArray(data?.phone) ? data.phone : []),
      ...(Array.isArray(data?.all) ? data.all : []),
    ];
    const seen = new Set();
    return all.filter((f) => {
      if (!f?.id || f.status !== "verified" || seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
  };

  const prepare = async () => {
    setBusy(true);
    setErr("");
    try {
      const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalError) throw aalError;
      if (aal?.currentLevel === "aal2") {
        onReady?.();
        return;
      }

      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;
      const verified = verifiedFactors(factors);

      if (verified.length) {
        setFactorId(verified[0].id);
        setMode("challenge");
        return;
      }

      const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `${BRAND.name} ${profile?.role || "staff"}`,
      });
      if (enrollError) throw enrollError;
      if (!enrolled?.id || !enrolled?.totp?.qr_code) throw new Error("نەتوانرا 2FA ئامادە بکرێت");
      setFactorId(enrolled.id);
      setQr(enrolled.totp.qr_code);
      setSecret(enrolled.totp.secret || "");
      setMode("enroll");
    } catch (e) {
      console.error("MFA prepare", e);
      setErr(errorTextOr(e, "هەڵە لە ئامادەکردنی پاراستنی دوو هەنگاوی"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { prepare(); }, []);

  const verify = async () => {
    const clean = String(code || "").replace(/\D/g, "").slice(0, 6);
    if (clean.length !== 6 || !factorId) {
      setErr("کۆدی ٦ ژمارەیی Authenticator داخڵ بکە");
      return;
    }

    setBusy(true);
    setErr("");
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: clean,
      });
      if (verifyError) throw verifyError;
      await supabase.auth.refreshSession();
      onReady?.();
    } catch (e) {
      console.error("MFA verify", e);
      setErr("کۆدەکە دروست نییە یان کاتی بەسەرچووە — کۆدی نوێ بنووسە");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div dir={LANGS[_lang]?.dir || "rtl"} data-role={profile?.role || "admin"}
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "var(--bg)", color: "var(--txt)" }}>
      <div className="w-full max-w-[430px]">
        <Card className="p-6 md:p-7">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: "var(--pos-bg)", color: "var(--pos)" }}>
            <ShieldCheck className="w-7 h-7" />
          </div>

          <h1 className="text-xl font-bold">{mode === "enroll" ? "چالاککردنی پاراستنی دوو هەنگاوی" : "پشتڕاستکردنەوەی پاراستن"}</h1>
          <p className="text-sm mt-2 leading-6" style={{ color: "var(--txt-2)" }}>
            بۆ ئەکاونتی {ROLE_KU[profile?.role] || profile?.role}، کۆدی Authenticator پێویستە پێش دەستگەیشتن بە داتای دارایی.
          </p>

          {mode === "loading" && (
            <div className="py-8"><StatePanel type="loading" title="ئامادەکردنی پاراستن..." compact /></div>
          )}

          {mode === "enroll" && qr && (
            <div className="mt-5 space-y-4">
              <div className="rounded-2xl p-4 flex justify-center" style={{ background: "#fff", border: "1px solid var(--line)" }}>
                <img src={qr} alt="Authenticator QR" className="w-52 h-52 max-w-full" />
              </div>
              <div className="text-xs leading-5" style={{ color: "var(--txt-2)" }}>
                QR ـەکە بە Google Authenticator، Microsoft Authenticator یان 1Password scan بکە.
                {secret && <div className="mt-2">ئەگەر scan نەکرا: <code dir="ltr" className="select-all">{secret}</code></div>}
              </div>
            </div>
          )}

          {(mode === "challenge" || mode === "enroll") && (
            <div className="mt-5">
              <Lbl>کۆدی ٦ ژمارەیی</Lbl>
              <div className="relative">
                <KeyRound className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2" style={{ color: "var(--txt-3)" }} />
                <input inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6}
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && verify()}
                  className="w-full ps-10 pe-4 py-3.5 rounded-xl text-center tracking-[.35em] text-lg outline-none"
                  style={{ background: "var(--surf-2)", border: "1px solid var(--line)", color: "var(--txt)", ...num }} />
              </div>
              <Btn className="w-full mt-3" disabled={busy || code.length !== 6} onClick={verify}>
                {busy ? "پشکنین..." : "پشتڕاستکردنەوە"}
              </Btn>
            </div>
          )}

          {err && (
            <div className="mt-4 p-3 rounded-xl text-sm" style={{ background: "var(--neg-bg)", color: "var(--neg)", border: "1px solid color-mix(in srgb,var(--neg) 20%,transparent)" }}>
              {err}
            </div>
          )}

          <div className="mt-5 flex justify-between gap-2">
            {err && <button onClick={prepare} disabled={busy} className="text-xs font-semibold" style={{ color: "var(--txt-2)" }}>دووبارە هەوڵدان</button>}
            <button onClick={onSignOut} className="text-xs font-semibold ms-auto" style={{ color: "var(--txt-3)" }}>دەرچوون</button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Login() {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Login identity: keep legacy local-number accounts working while accepting
  // equivalent Iraqi formats such as 0770..., +964770..., and 00964770....
  const phoneIdentityCandidates = (v) => {
    const t = String(v || "").trim();
    if (t.includes("@")) return [t.toLowerCase()];

    // Owner/Admin may use a short username such as "sarkhel" or "admin".
    // Regular users keep phone-based login.
    if (/^[a-zA-Z][a-zA-Z0-9._-]{2,31}$/.test(t)) {
      return [`${t.toLowerCase()}@sarraf.local`];
    }

    const digits = t.replace(/\D/g, "");
    if (!digits) return [];

    const canonical =
      digits.startsWith("00964") ? digits.slice(2)
      : digits.startsWith("964") ? digits
      : digits.startsWith("0") ? `964${digits.slice(1)}`
      : digits.startsWith("7") ? `964${digits}`
      : digits;

    const local = canonical.startsWith("964") ? `0${canonical.slice(3)}` : canonical;

    return [...new Set([digits, canonical, local].filter(Boolean))]
      .map((x) => `${x}@sarraf.local`);
  };

  const [bio, setBio] = useState(false);
  useEffect(() => {
    // Remove any credential left by older prototype builds.
    try { localStorage.removeItem("bio"); } catch {}
    setBio(false);
  }, []);

  const go = async (ov) => {
    const uid2 = ov?.id ?? id, pw2 = ov?.pw ?? pw;
    if (!uid2 || !pw2) return setErr(tr("ناوی بەکارهێنەر/ژمارە/ئیمەیل و وشەی نهێنی پێویستە"));
    setBusy(true); setErr("");
    const candidates = phoneIdentityCandidates(uid2);
    let lastError = null;
    let signedIn = false;

    for (const email of candidates) {
      const { error } = await supabase.auth.signInWithPassword({ email, password: pw2 });
      if (!error) { signedIn = true; break; }
      lastError = error;
    }

    if (!signedIn) {
      console.warn("Login failed for all normalized identity candidates", lastError?.message || "");
      setErr(tr("زانیارییەکان هەڵەن — دووبارە هەوڵ بدە"));
    }
    setBusy(false);
  };

  const goBio = async () => {
    setBusy(true); setErr("");
    const saved = await bioLogin();
    if (!saved) { setErr(tr("نەتوانرا پشتڕاست بکرێتەوە")); setBusy(false); return; }
    await go(saved);
  };

  return (
    <div dir={LANGS[_lang]?.dir || "rtl"} data-role="admin"
      className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden"
      style={{ background: "var(--bg)" }}>

      <div className="absolute inset-x-0 -top-24 h-[420px] pointer-events-none"
        style={{ background: "radial-gradient(60% 100% at 50% 0%, rgba(224,169,74,.14), transparent 72%)" }} />
      <div className="absolute -bottom-32 -start-24 w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(124,107,245,.09), transparent 70%)" }} />

      <div className="w-full max-w-[380px] relative rise">
        <div className="text-center mb-10">
          <BrandLogo variant="horizontal" theme="light" className="w-[220px] h-auto mx-auto mb-5 dark-brand-logo" />
          <h1 className="sr-only">{BRAND.logoLabel.ckb}</h1>
          <p className="text-[13px] mt-1.5" lang="ckb" style={{ color: "var(--txt-3)" }}>
            {BRAND.slogan.ckb}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <Lbl>{tr("ناوی بەکارهێنەر / ژمارە / ئیمەیل")}</Lbl>
            <input dir="ltr" type="text" autoComplete="username" value={id} onChange={(e) => setId(e.target.value)}
              placeholder="sarkhel / admin / 07701234567" onKeyDown={(e) => e.key === "Enter" && go()}
              className="w-full px-4 py-3.5 text-[15px] outline-none"
              style={{ ...fieldSty, fontFamily: "'IBM Plex Mono', monospace" }}
              onFocus={onFoc} onBlur={onBlr} />
          </div>
          <div>
            <Lbl>{tr("وشەی نهێنی")}</Lbl>
            <div className="relative">
              <input type={show ? "text" : "password"} autoComplete="current-password" value={pw}
                onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()}
                className="w-full ps-4 pe-12 py-3.5 text-[15px] outline-none"
                style={fieldSty} onFocus={onFoc} onBlur={onBlr} />
              <button type="button" onClick={() => setShow(!show)} tabIndex={-1}
                className="absolute end-3 top-1/2 -translate-y-1/2 p-1.5 tap"
                style={{ color: "var(--txt-3)" }}>
                {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {err && (
            <div className="text-[13px] rounded-[var(--r-sm)] px-4 py-3 flex items-center gap-2.5 drop"
              style={{ background: "var(--neg-bg)", color: "var(--neg)", border: "1px solid color-mix(in srgb, var(--neg) 26%, transparent)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0" /> {err}
            </div>
          )}

          <Btn onClick={() => go()} disabled={busy} className="w-full !py-3.5 !text-[15px] mt-1">
            {busy ? "..." : tr("چوونە ژوورەوە")}
          </Btn>

          {bio && (
            <button onClick={goBio} disabled={busy}
              className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-[var(--r-sm)] tap text-[14px] font-semibold"
              style={{ background: "var(--glass)", border: "1px solid var(--line)", color: "var(--txt-2)" }}>
              <Fingerprint className="w-[18px] h-[18px]" /> {tr("پەنجەمۆر یان ڕوو")}
            </button>
          )}
        </div>

        <div className="flex justify-center gap-1.5 mt-8">
          {Object.entries(LANGS).map(([k, v]) => (
            <button key={k} onClick={() => { setLangGlobal(k); location.reload(); }}
              className="px-3.5 py-1.5 rounded-full text-[11.5px] font-semibold tap"
              style={_lang === k
                ? { background: "rgba(224,169,74,.16)", color: "#E0A94A" }
                : { color: "var(--txt-3)" }}>
              {v.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ ئەپی سەرەکی ══════════════════ */

/* هەڵبژاردنی بەکارهێنەر بە گەڕان */

/* هەڵبژاردنی بەکارهێنەر بە گەڕان */

/* ══════════════════ داشبۆرد ══════════════════ */
function Dashboard({ data, calc, cur, mySafe, profitIn, ownProfitIn, investorsProfitIn, sumUsd, ratesReady, owners, batches, go, readModel }) {
  const rm = readModel || data.readModel || null;
  const today = dOnly(new Date().toISOString());
  const todayTxs = data.txs.filter((t) => !t.deleted && dOnly(t.date) === today);
  const pTod = profitIn(today, today);
  const ownTod = ownProfitIn ? ownProfitIn(today, today) : {};
  const fallbackTodayProfit = sumUsd(Object.keys(pTod).reduce((m,k)=>{ m[k]=(pTod[k]||0)+(ownTod[k]||0); return m; },{}));
  const totalTodayProfit = ratesReady && Number.isFinite(Number(rm?.today_profit_usd))
    ? Number(rm.today_profit_usd) : fallbackTodayProfit;
  const pendingCount = Number(rm?.counts?.pending_txs ?? data.txs.filter((t) => !t.deleted && t.status === "pending").length);
  const todayTxCount = Number(rm?.counts?.today_txs ?? todayTxs.length);
  const noRates = unpricedCurrencies(data.currencies).length > 0;
  const totalBalance = ratesReady && Number.isFinite(Number(rm?.total_balance_usd))
    ? Number(rm.total_balance_usd) : (ratesReady ? sumUsd(calc.phys) : 0);

  const rmDaily = Array.isArray(rm?.daily) ? rm.daily.slice(-7) : null;
  const last7 = rmDaily?.length === 7
    ? rmDaily.map((x) => ({ k: String(x.date), v: Number(x.profit_usd) || 0 }))
    : [...Array(7)].map((_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (6 - i));
        const k = d.toISOString().slice(0,10);
        const p = profitIn(k,k), o = ownProfitIn ? ownProfitIn(k,k) : {};
        const all = {};
        [...Object.keys(p), ...Object.keys(o)].forEach((c) => all[c]=(p[c]||0)+(o[c]||0));
        return { k, v: ratesReady ? sumUsd(all) : (Object.values(all)[0] || 0) };
      });
  const weekProfit = last7.reduce((s,x)=>s+x.v,0);
  const chartMax = Math.max(...last7.map(x=>Math.abs(x.v)), 1);

  const recent = Array.isArray(rm?.recent_txs)
    ? rm.recent_txs.map(mapTxRecord).slice(0,6)
    : [...data.txs].filter(t=>!t.deleted).sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,6);
  const expenses = rmDaily?.length === 7
    ? rmDaily.map((x) => ({ k: String(x.date), v: Number(x.expense_usd) || 0 }))
    : [...Array(7)].map((_, i) => {
        const d = new Date(); d.setDate(d.getDate() - (6-i));
        const k=d.toISOString().slice(0,10);
        const v=data.ledger.filter(e=>e.type==="expense" && dOnly(e.date)===k).reduce((s,e)=>s+Math.abs(e.amount||0),0);
        return {k,v};
      });
  const expMax=Math.max(...expenses.map(x=>x.v),1);

  const Stat = ({label,value,sub,positive}) => (
    <div className="fin-card metric-card p-4 md:p-5 min-w-0">
      <div className="text-[11px] md:text-[12px] font-medium" style={{color:"var(--txt-3)"}}>{label}</div>
      <div className="mt-2 text-[23px] md:text-[27px] font-bold tracking-tight" style={{...num,color:"var(--txt)"}}>{value}</div>
      {sub && <div className="mt-1 text-[10px] md:text-[11px]" style={{color:positive?"var(--pos)":"var(--txt-3)"}}>{sub}</div>}
    </div>
  );

  const Flag = ({c}) => <span className="text-[20px] leading-none shrink-0" aria-hidden>{curFlag(c)}</span>;

  return (
    <div className="space-y-5 md:space-y-6">
      <div className="dashboard-page-head flex items-end justify-between gap-4">
        <div>
          <div className="dashboard-eyebrow">{BRAND.name} · {data.users.find(u=>u.role==="admin"&&!u.deleted)?.name || BRAND.name}</div>
          <h1 className="dashboard-title">{tr("داشبۆرد")}</h1>
          <div className="dashboard-subtitle">{tr("کڕین و فرۆشتن · قاسە · حیسابات")}</div>
        </div>
        <button onClick={()=>go("newtx")} className="hidden md:flex sarraf-primary-action items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-[13px] tap">
          <Plus className="w-4 h-4" /> {tr("مامەڵەی نوێ")}
        </button>
      </div>

      <div className="dashboard-quick-grid">
        {[
          [tr("مامەڵەی نوێ"), tr("کڕین و فرۆشتن"), ArrowLeftRight, "newtx"],
          [tr("قاسەی گشتی"), tr("قاسە، پارە و خەرجی"), Wallet, "safes"],
          [tr("پشکنینی فیش"), tr("فیشەکان"), ScanLine, "receipts"],
          [tr("نرخی ئەمڕۆ"), tr("نرخی هەموو دراوەکان"), TrendingUp, "rates"],
        ].map(([title, sub, Ic, target]) => (
          <button key={target} onClick={()=>go(target)} className="quick-action-card tap">
            <span className="quick-action-icon"><Ic className="w-4 h-4"/></span>
            <span className="min-w-0 text-start">
              <span className="block text-[12px] font-bold truncate">{title}</span>
              <span className="block text-[9.5px] mt-0.5 truncate" style={{color:"var(--txt-3)"}}>{sub}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <div className="fin-green dashboard-hero rounded-[22px] p-5 md:p-6 col-span-2 min-h-[170px] relative overflow-hidden">
          <div className="flex items-start justify-between relative z-10">
            <div>
              <div className="text-[12px] font-semibold opacity-75">{tr("قاسەی گشتی")}</div>
              <div className="mt-2 text-[34px] md:text-[40px] font-semibold tracking-[-.04em]" style={num}>{ratesReady ? fmt(totalBalance,0) : "—"} <span className="text-[13px] font-medium">USD</span></div>
              <div className="mt-1 text-[11px] muted">{ratesReady ? `${weekProfit >= 0 ? "+" : "−"}${fmt(Math.abs(weekProfit),0)} USD · ${tr("ئەم هەفتەیە")}` : tr("نرخەکان دابنێ")}</div>
            </div>
            <button onClick={()=>go("safes")} aria-label={tr("کردنەوەی قاسەی گشتی")}
              className="w-10 h-10 rounded-full flex items-center justify-center bg-white/90 text-black tap shadow-sm"><Plus className="w-5 h-5"/></button>
          </div>
          <svg viewBox="0 0 420 100" preserveAspectRatio="none" className="absolute bottom-0 inset-x-0 w-full h-[82px] opacity-90">
            <path d="M0 76 C45 70 60 55 100 62 S150 75 190 50 S240 26 285 42 S330 18 365 28 S400 18 420 12 L420 100 L0 100 Z" fill="rgba(255,255,255,.14)"/>
            <path d="M0 76 C45 70 60 55 100 62 S150 75 190 50 S240 26 285 42 S330 18 365 28 S400 18 420 12" fill="none" stroke="rgba(255,255,255,.88)" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
          <div className="absolute bottom-4 start-5 text-[10px] white-muted">{tr("کۆی گشتی")}</div>
        </div>
        <Stat label={tr("خێری ئەمڕۆ")} value={ratesReady?`${fmt(totalTodayProfit,0)} USD`:`${fmt(Object.values(pTod).reduce((a,b)=>a+b,0),0)}`} sub={totalTodayProfit>=0?`↗ ${tr("خێر")}`:`↘ ${tr("خێر و زەرەر")}`} positive={totalTodayProfit>=0}/>
        <Stat label={tr("مامەڵەی ئەمڕۆ")} value={todayTxCount} sub={`${todayTxCount} · ${tr("ئەمڕۆ")}`} />
        <Stat label={tr("چاوەڕوان") } value={pendingCount} sub={pendingCount?tr("پێویستی بە پشکنینە"):`✓ ${tr("هیچ نییە")}`} />
      </div>

      <MarketWatch compact />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.9fr)] gap-4">
        <section className="fin-card p-5 md:p-6">
          <div className="flex items-start justify-between gap-3 mb-5">
            <div><h2 className="text-[16px] font-bold">{tr("خێری ٧ ڕۆژی ڕابردوو")}</h2><div className="text-[11px] mt-1" style={{color:"var(--txt-3)"}}>{tr("٧ ڕۆژ")}</div></div>
            <button onClick={()=>go("insights")} className="text-[11px] font-semibold" style={{color:"var(--ac)"}}>{tr("وردەکاری ←")}</button>
          </div>
          <div className="relative h-[210px]">
            <svg viewBox="0 0 700 210" preserveAspectRatio="none" className="w-full h-full overflow-visible">
              {[0,1,2,3].map(i=><line key={i} x1="0" x2="700" y1={28+i*48} y2={28+i*48} stroke="var(--line)" strokeWidth="1"/>) }
              <defs><linearGradient id="profitFillSarraf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#00D978" stopOpacity=".22"/><stop offset="100%" stopColor="#00D978" stopOpacity="0"/></linearGradient></defs>
              {(()=>{
                const pts=last7.map((x,i)=>[20+i*(660/6),185-(Math.max(0,x.v)/chartMax)*145]);
                const d=pts.map((p,i)=>`${i?"L":"M"}${p[0]},${p[1]}`).join(" ");
                return <><path d={`${d} L680 185 L20 185 Z`} fill="url(#profitFillSarraf)"/><path d={d} fill="none" stroke="#00D978" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>{pts.map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r={i===pts.length-1?5:3.5} fill="#00D978" stroke="var(--surf)" strokeWidth="2"/>)}</>;
              })()}
            </svg>
          </div>
          <div className="flex justify-between text-[10px]" style={{color:"var(--txt-3)"}}>{last7.map(x=><span key={x.k}>{x.k.slice(5)}</span>)}</div>
        </section>

        <section className="fin-card p-5 md:p-6">
          <div className="flex items-center justify-between mb-4"><div><h2 className="text-[16px] font-bold">{tr("نرخی ئەمڕۆ")}</h2><div className="text-[10px] mt-1" style={{color:"var(--txt-3)"}}>{tr("نرخەکان دابنێ")} · Internal</div></div><button onClick={()=>go("rates")} className="text-[11px] font-semibold" style={{color:"var(--ac)"}}>{tr("هەمووی")}</button></div>
          <div className="space-y-1">
            {data.currencies.filter(c=>c.id!=="usd").slice(0,5).map(c=>(
              <div key={c.id} className="flex items-center gap-3 py-3 border-b last:border-0" style={{borderColor:"var(--line)"}}>
                <Flag c={c}/><div className="min-w-0 flex-1"><div className="text-[13px] font-semibold">{c.code}</div><div className="text-[10px] truncate" style={{color:"var(--txt-3)"}}>{c.name}</div></div>
                <div className="text-end" style={num}><div className="text-[12px] font-semibold">{rateOf(c)?fmt(rateOf(c),3):"—"}</div><div className="text-[10px]" style={{color:"var(--txt-3)"}}>1 USD</div></div>
                <div className="text-[9.5px] font-semibold min-w-[42px] text-end" style={{color:rateOf(c)?"var(--pos)":"var(--txt-3)"}}>{rateOf(c)?tr("ڕەیتیۆی ئەمڕۆ"):"—"}</div>
              </div>
            ))}
          </div>
          {noRates && <button onClick={()=>go("rates")} className="mt-3 w-full rounded-xl px-3 py-2.5 text-[11px] font-semibold" style={{background:"var(--warn-bg)",color:"var(--warn)"}}><AlertTriangle className="w-3.5 h-3.5 inline me-1"/>{tr("نرخی هەموو دراوەکان دانەنراوە — کلیک بکە")}</button>}
        </section>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.9fr)] gap-4">
        <section className="fin-card p-5 md:p-6 overflow-hidden">
          <div className="flex items-center justify-between mb-4"><h2 className="text-[16px] font-bold">{tr("دوا مامەڵەکان")}</h2><button onClick={()=>go("txs")} className="text-[11px] font-semibold" style={{color:"var(--ac)"}}>{tr("هەمووی")}</button></div>
          <div className="hidden md:grid grid-cols-[.8fr_.65fr_1fr_.7fr_.8fr_.8fr] gap-3 px-2 pb-2 text-[10px] font-semibold" style={{color:"var(--txt-3)"}}><span>{tr("جۆر")}</span><span>{tr("دراو")}</span><span>{tr("بڕ")}</span><span>{tr("نرخ:")}</span><span>{tr("خێر")}</span><span>{tr("دۆخ")}</span></div>
          <div className="space-y-1">
            {recent.map(t=>{const c=cur(t.curId), positive=t.type==="buy"; return <button key={t.id} onClick={()=>go("txs")} className="w-full text-start grid grid-cols-[1fr_auto] md:grid-cols-[.8fr_.65fr_1fr_.7fr_.8fr_.8fr] gap-3 items-center px-2 py-3 rounded-xl tap hover:bg-[var(--surf-2)]"><div><div className="text-[12px] font-semibold">{t.type==="buy"?tr("کڕین"):tr("فرۆشتن")}</div><div className="text-[9px] md:hidden" style={{color:"var(--txt-3)"}}>{t.cpName||usrSafeName(data,t.cpId)||"—"}</div></div><div className="flex items-center gap-1.5 text-[11px] font-semibold"><span>{curFlag(c)}</span>{c.code}</div><div style={num} className="text-[12px] font-semibold">{fmt(t.amount, cur(t.curId).dec ?? 0)}</div><div style={num} className="hidden md:block text-[11px]">
  {(() => {
    const baseId = preferredRateBaseId(t.curId, t.againstId);
    const shown = storedRateToDisplay(t.rate, t.curId, t.againstId, baseId);
    return shown ? fmt(shown, rateDigits(shown)) : "—";
  })()}
</div><div style={{...num, color: t.profit == null ? "var(--txt-3)" : Number(t.profit) >= 0 ? "var(--pos)" : "var(--neg)"}} className="hidden md:block text-[11px]">
  {t.profit == null ? "—" : `${t.profit >= 0 ? "+" : "−"}${fmt(Math.abs(t.profit), cur(t.profitCurId || t.againstId).dec ?? 0)} ${cur(t.profitCurId || t.againstId).code}`}
</div><div className="text-end md:text-start"><Pill tone={t.status==="pending"?"amber":positive?"green":"slate"}>{t.status==="pending"?tr("چاوەڕوان"):tr("تەواوکراو")}</Pill></div></button>})}
            {!recent.length && <Empty t={tr("هیچ مامەڵەیەک نەدۆزرایەوە")}/>} 
          </div>
        </section>

        <section className="fin-card p-5 md:p-6">
          <div className="flex items-center justify-between mb-4"><h2 className="text-[16px] font-bold">{tr("خەرجی")}</h2><span className="text-[10px]" style={{color:"var(--txt-3)"}}>{tr("ئەم هەفتەیە")}</span></div>
          <div className="flex items-end gap-2 h-[185px]">
            {expenses.map((x,i)=><div key={x.k} className="flex-1 h-full flex flex-col justify-end items-center gap-2"><div className="w-full max-w-[22px] rounded-t-full" style={{height:`${Math.max(8,(x.v/expMax)*145)}px`,background:i===expenses.length-1?"#00D978":"#BFEFD9"}} title={fmt(x.v,0)}/><span className="text-[9px]" style={{color:"var(--txt-3)"}}>{x.k.slice(5)}</span></div>)}
          </div>
        </section>
      </div>

      <div className="md:hidden fixed bottom-[74px] end-4 z-30">
        <button onClick={()=>go("newtx")} className="w-14 h-14 rounded-full flex items-center justify-center tap" style={{background:"#00D978",color:"#07130D",boxShadow:"0 12px 28px rgba(0,217,120,.28)"}}><Plus className="w-6 h-6"/></button>
      </div>
    </div>
  );
}

function usrSafeName(data,id){ return data.users.find(u=>u.id===id)?.name || ""; }

function SafeCards({ data, calc, cur, mySafe, sumUsd, ratesReady, owners, go }) {
  const [open, setOpen] = useState(null);
  const [view, setView] = useState("where");
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  const c = open ? cur(open) : null;
  const bal = open ? (calc.phys[open] || 0) : 0;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-1">
        <SecLbl>{tr("قاسەی گشتی")}</SecLbl>
        <button onClick={() => go("safes")} className="text-[12px] font-semibold tap" style={{ color: "var(--ac)" }}>
          {tr("وردەکاری ←")}
        </button>
      </div>

      <div className="space-y-1">
        {data.currencies.map((cc, i) => {
          const isOpen = open === cc.id;
          const v = calc.phys[cc.id] || 0;
          const usd = ratesReady ? sumUsd({ [cc.id]: v }) : null;
          return (
            <div key={cc.id}>
              <div onClick={() => { setOpen(isOpen ? null : cc.id); setView("where"); }}
                className="tap cursor-pointer rounded-[var(--r-sm)] px-2 -mx-2"
                style={isOpen ? { background: "var(--surf-2)" } : {}}>
                <Row
                  icon={<CurBadge c={cc} pulse={isOpen} />}
                  title={cc.name}
                  sub={cc.external ? tr("· دەرەوە") : null}
                  right={fmt(v, 0)}
                  rightSub={usd != null && cc.id !== "usd" ? `≈ ${fmt(usd, 0)} $` : null}
                  tone={v < 0 ? "neg" : null} />
              </div>
              {isOpen && (
                <div className="py-3 px-3 my-1 rounded-[var(--r-sm)] drop" style={{ background: "var(--surf-2)" }}>
                  <Tabs items={[["where", tr("لای کێیە؟")], ["whose", tr("هی کێیە؟")]]} value={view} onChange={setView} className="mb-3" />
                  {view === "where" ? (
                    <>
                      <Row title={tr("لای خۆم (قاسەی سەرەکی)")} right={fmt(calc.atMe[cc.id] || 0, 0)} />
                      {partners.map((p) => {
                        const pv = (calc.partner[p.id] || {})[cc.id];
                        if (!pv) return null;
                        return <Row key={p.id} title={p.name} sub={pv < 0 ? tr("· قەرز") : null}
                          right={fmt(pv, 0)} tone={pv < 0 ? "neg" : null} />;
                      })}
                    </>
                  ) : (
                    !owners || owners.total <= 0 ? <Empty t={tr("هێشتا سەرمایە دانەنراوە")} /> :
                      owners.list.map((o) => (
                        <Row key={o.id} title={o.name} sub={`${(o.share * 100).toFixed(1)}٪`}
                          right={fmt(bal * o.share, 0)} tone={o.isMe ? "pos" : null} />
                      ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* وردەکاری دراوێک — لای کێیە و هی کێیە */
function CurrencyBreakdown({ curId, data, calc, cur, owners, ratesReady }) {
  const [view, setView] = useState("where");
  const c = cur(curId);
  const bal = calc.phys[curId] || 0;
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  return (
    <div>
      <div className="flex gap-1 bg-[var(--line)] rounded-[var(--r-sm)] p-1 mb-3">
        {[["where", tr("لای کێیە؟")], ["whose", tr("هی کێیە؟")]].map(([k, t]) => (
          <button key={k} onClick={() => setView(k)}
            className={`flex-1 py-2 rounded-lg text-sm transition ${view === k ? "bg-[var(--surf)] text-[var(--pos)] font-bold shadow-sm" : "text-[var(--txt-2)]"}`}>{t}</button>
        ))}
      </div>

      {view === "where" ? (
        <div>
          <div className="flex justify-between items-center py-2.5 border-b border-[var(--line)]">
            <span className="text-sm text-[var(--txt-2)]">{tr("لای خۆم (قاسەی سەرەکی)")}</span>
            <Money v={calc.atMe[curId] || 0} dec={0} />
          </div>
          {partners.map((p) => {
            const v = (calc.partner[p.id] || {})[curId];
            if (!v) return null;
            return (
              <div key={p.id} className="flex justify-between items-center py-2.5 border-b border-[var(--line)]">
                <span className="text-sm text-[var(--txt-2)]">{tr("لای")} {p.name}{v < 0 && <span className="text-[var(--neg)] text-xs mr-1">{tr("(قەرز)")}</span>}</span>
                <Money v={v} dec={0} />
              </div>
            );
          })}
          {partners.every((p) => !((calc.partner[p.id] || {})[curId])) && (
            <div className="text-xs text-[var(--txt-3)] py-2">{tr("هیچی لای هاوبەشەکان نییە")}</div>
          )}
          <div className="flex justify-between items-center pt-3 font-bold">
            <span className="text-sm">{tr("کۆی گشتی")}</span><Money v={bal} dec={0} />
          </div>
        </div>
      ) : (
        <div>
          {!ratesReady && (
            <div className="text-xs text-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_11%,transparent)] border border-[color-mix(in_srgb,var(--warn)_26%,transparent)] rounded-lg p-2.5 mb-2">
              {tr("بۆ وردی زیاتر، نرخی هەموو دراوەکان دابنێ")}
            </div>
          )}
          {!owners || owners.total <= 0 ? <Empty t={tr("هێشتا سەرمایە دانەنراوە")} /> :
            owners.list.map((o) => (
              <div key={o.id} className="flex justify-between items-center py-2.5 border-b border-[var(--line)] last:border-0">
                <div>
                  <span className={`text-sm ${o.isMe ? "font-bold text-[var(--pos)]" : "text-[var(--txt-2)]"}`}>{o.name}</span>
                  <span className="text-xs text-[var(--txt-3)] mr-2" style={num}>{(o.share * 100).toFixed(1)}٪</span>
                </div>
                <Money v={bal * o.share} dec={0} pos={o.isMe} />
              </div>
            ))}
          <div className="text-[11px] text-[var(--txt-3)] mt-2.5">
            {tr("بەشی هەرکەس بەپێی ڕێژەی سەرمایەکەیەتی — چوونکە هەموو دراوەکان بە پارەی هاوبەش کڕدراون")}
          </div>
        </div>
      )}
    </div>
  );
}


/* ══════════════════ MARKET WATCH — reference only ══════════════════ */
const MARKET_CACHE_KEY = "sarraf_market_rates_v2";
const MARKET_CACHE_MS = 12 * 60 * 60 * 1000;
const MARKET_MAJOR_CODES = ["IQD","EUR","GBP","CNY","JPY","TRY","AED","SAR","KWD","QAR","CAD","AUD","CHF","INR","KRW"];
const MARKET_NAMES = {
  IQD:"Iraqi Dinar", EUR:"Euro", GBP:"British Pound", CNY:"Chinese Yuan", JPY:"Japanese Yen",
  TRY:"Turkish Lira", AED:"UAE Dirham", SAR:"Saudi Riyal", KWD:"Kuwaiti Dinar", QAR:"Qatari Riyal",
  CAD:"Canadian Dollar", AUD:"Australian Dollar", CHF:"Swiss Franc", INR:"Indian Rupee", KRW:"South Korean Won",
  USD:"US Dollar"
};
const MARKET_FLAGS = {
  IQD:"🇮🇶", EUR:"🇪🇺", GBP:"🇬🇧", CNY:"🇨🇳", JPY:"🇯🇵", TRY:"🇹🇷", AED:"🇦🇪", SAR:"🇸🇦",
  KWD:"🇰🇼", QAR:"🇶🇦", CAD:"🇨🇦", AUD:"🇦🇺", CHF:"🇨🇭", INR:"🇮🇳", KRW:"🇰🇷", USD:"🇺🇸"
};
const MARKET_METALS = [
  ["gold","Gold","🥇"],
  ["silver","Silver","🥈"],
  ["platinum","Platinum","⬜"],
  ["palladium","Palladium","◻️"],
];

function MarketWatch({ compact = false }) {
  const [market, setMarket] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const load = async (force = false) => {
    if (busy) return;
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(MARKET_CACHE_KEY) || "null");
        if (cached?.at && cached?.data && Date.now() - cached.at < MARKET_CACHE_MS) {
          setMarket(cached.data);
          return;
        }
      } catch {}
    }

    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/market-rates", { headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) throw new Error(body?.message || "نرخی بازاڕ بەردەست نییە");
      setMarket(body);
      try { localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify({ at: Date.now(), data: body })); } catch {}
    } catch (e) {
      console.error("market-watch", e);
      setErr(errorTextOr(e, "نەتوانرا نرخی بازاڕ بار بکرێت"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(false); }, []);

  const rows = Object.entries(market?.rates || {})
    .filter(([code, value]) => code !== "USD" && Number(value) > 0)
    .sort(([a], [b]) => {
      const ai = MARKET_MAJOR_CODES.indexOf(a), bi = MARKET_MAJOR_CODES.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    })
    .filter(([code]) => !search || `${code} ${MARKET_NAMES[code] || ""}`.toLowerCase().includes(search.toLowerCase()));

  const shown = search || open ? rows : rows.slice(0, compact ? 6 : 10);
  const metals = MARKET_METALS.filter(([key]) => Number(market?.metals?.[key]) > 0);

  return (
    <Card className={`market-watch-card ${compact ? "p-4 md:p-5" : "p-5"}`}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background:"var(--pos-bg)", color:"var(--pos)" }}>
              <TrendingUp className="w-4 h-4" />
            </span>
            <div>
              <div className="text-[14px] font-bold">{tr("نرخی جیهانی")}</div>
              <div className="text-[10.5px] mt-0.5" style={{ color:"var(--txt-3)" }}>
                نرخی جیهانی · سەرچاوەی زانیاری
              </div>
            </div>
            <span className="px-2 py-1 rounded-full text-[9px] font-bold"
              style={{ background:"var(--surf-2)", border:"1px solid var(--line)", color:"var(--txt-3)" }}>
              بازاڕ
            </span>
          </div>
          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color:"var(--txt-3)" }}>
            ئەم نرخانە هیچ کاریگەرییەکیان لە نرخی ناوخۆ، مامەڵە، خێر، باڵانس یان حیسابات نییە.
          </div>
        </div>

        <button onClick={() => load(true)} disabled={busy}
          className="shrink-0 px-3 py-2 rounded-xl text-[10.5px] font-semibold tap flex items-center justify-center gap-1.5"
          style={{ background:"var(--surf-2)", border:"1px solid var(--line)", color:"var(--txt-2)" }}>
          <RotateCcw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
          {busy ? "..." : tr("نوێکردنەوە")}
        </button>
      </div>

      {err && (
        <div className="mt-3">
          <StatePanel type="error" title="نرخی جیهانی کاتێک بەردەست نییە" detail={err} onRetry={() => load(true)} compact />
        </div>
      )}

      {!market && !err && (
        <div className="mt-3">
          <StatePanel type="loading" title="نرخی جیهانی بار دەکرێت..." detail="سیستەمی مامەڵە و نرخی ناوخۆ بەردەوام کار دەکات." compact />
        </div>
      )}

      {market && (
        <>
          {metals.length > 0 && (
            <div className={`mt-4 grid ${compact ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-2 md:grid-cols-4"} gap-2`}>
              {metals.map(([key, name, icon]) => (
                <div key={key} className="rounded-xl p-3" style={{ background:"var(--surf-2)", border:"1px solid var(--line)" }}>
                  <div className="text-[9.5px] flex items-center gap-1" style={{ color:"var(--txt-3)" }}><span>{icon}</span>{name}</div>
                  <div className="text-[14px] font-bold mt-1" style={num}>${fmt(market.metals[key], 2)}</div>
                  <div className="text-[8.5px] mt-0.5" style={{ color:"var(--txt-3)" }}>USD / oz</div>
                </div>
              ))}
            </div>
          )}

          <div className={`mt-4 grid ${compact ? "grid-cols-2 md:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"} gap-2`}>
            {shown.map(([code, value]) => (
              <div key={code} className="rounded-xl px-3 py-2.5 flex items-center gap-2.5"
                style={{ background:"var(--surf-2)", border:"1px solid var(--line)" }}>
                <span className="text-[18px] shrink-0">{MARKET_FLAGS[code] || "🌐"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold">{code}</span>
                    <span className="text-[10.5px] font-semibold" style={num}>{fmt(value, rateDigits(value))}</span>
                  </div>
                  <div className="text-[8.5px] truncate mt-0.5" style={{ color:"var(--txt-3)" }}>
                    1 USD = {code} · {MARKET_NAMES[code] || "Global currency"}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {(open || !compact) && (
            <div className="relative mt-3">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color:"var(--txt-3)" }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="گەڕان بە USD, EUR, CNY..."
                className="w-full ps-9 pe-3 py-2.5 rounded-xl outline-none text-[11px]"
                style={{ background:"var(--surf-2)", border:"1px solid var(--line)", color:"var(--txt)" }} />
            </div>
          )}

          {rows.length > (compact ? 6 : 10) && !search && (
            <button onClick={() => setOpen((v) => !v)}
              className="mt-3 w-full py-2.5 rounded-xl text-[10.5px] font-semibold tap"
              style={{ background:"var(--surf-2)", color:"var(--txt-2)", border:"1px solid var(--line)" }}>
              {open ? "کەمتر پیشان بدە" : `هەموو ${rows.length} دراوەکە ببینە`}
            </button>
          )}

          <div className="mt-3 pt-3 flex flex-wrap items-center justify-between gap-2 text-[9px]"
            style={{ borderTop:"1px solid var(--line)", color:"var(--txt-3)" }}>
            <span>{"نوێترین داتای بازاڕ"}</span>
            <span style={num}>{market.timestamp ? new Date(market.timestamp).toLocaleString("en-GB") : "—"}</span>
          </div>
        </>
      )}
    </Card>
  );
}


/* ══════════════════ نرخی ڕۆژانە ══════════════════ */
function Rates({ data, saveRates }) {
  const [rows, setRows] = useState(
    data.currencies
      .filter((c) => c.id !== "usd")
      .map((c) => ({ id: c.id, code: c.code, name: c.name, c, rate: rateOf(c) ?? "" }))
  );
  const [market, setMarket] = useState(null);
  const [marketBusy, setMarketBusy] = useState(false);
  const [marketErr, setMarketErr] = useState("");
  const [marketOpen, setMarketOpen] = useState(false);
  const [marketSearch, setMarketSearch] = useState("");

  const upd = (id, k, v) => setRows((xs) => xs.map((r) => (r.id === id ? { ...r, [k]: v } : r)));
  const last = data.currencies.map((c) => c.rateUpdated).filter(Boolean).sort().at(-1) || null;

  const loadMarket = async (force = false) => {
    if (marketBusy) return;
    const cacheKey = "sarraf_market_rates_v1";
    const maxAge = 12 * 60 * 60 * 1000;
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
        if (cached?.at && cached?.data && Date.now() - cached.at < maxAge) {
          setMarket(cached.data);
          return;
        }
      } catch {}
    }

    setMarketBusy(true);
    setMarketErr("");
    try {
      const res = await fetch("/api/market-rates", { headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) throw new Error(body?.message || "نرخی بازاڕ بەردەست نییە");
      setMarket(body);
      try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: body })); } catch {}
    } catch (err) {
      console.error("market-rates", err);
      setMarketErr(err?.message || "نەتوانرا نرخی بازاڕ بار بکرێت");
    } finally {
      setMarketBusy(false);
    }
  };

  useEffect(() => { loadMarket(false); }, []);

  const marketNames = {
    IQD: "Iraqi Dinar", EUR: "Euro", GBP: "British Pound", CNY: "Chinese Yuan", JPY: "Japanese Yen",
    TRY: "Turkish Lira", AED: "UAE Dirham", SAR: "Saudi Riyal", KWD: "Kuwaiti Dinar", QAR: "Qatari Riyal",
    CAD: "Canadian Dollar", AUD: "Australian Dollar", CHF: "Swiss Franc", INR: "Indian Rupee", KRW: "South Korean Won"
  };
  const marketFlags = {
    IQD:"🇮🇶", EUR:"🇪🇺", GBP:"🇬🇧", CNY:"🇨🇳", JPY:"🇯🇵", TRY:"🇹🇷", AED:"🇦🇪", SAR:"🇸🇦",
    KWD:"🇰🇼", QAR:"🇶🇦", CAD:"🇨🇦", AUD:"🇦🇺", CHF:"🇨🇭", INR:"🇮🇳", KRW:"🇰🇷", USD:"🇺🇸"
  };
  const majors = ["IQD","EUR","GBP","CNY","JPY","TRY","AED","SAR","KWD","QAR","CAD","AUD","CHF","INR","KRW"];
  const allMarketRates = Object.entries(market?.rates || {})
    .filter(([code, value]) => code !== "USD" && Number(value) > 0)
    .sort(([a], [b]) => {
      const ai = majors.indexOf(a), bi = majors.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    })
    .filter(([code]) => !marketSearch || `${code} ${marketNames[code] || ""}`.toLowerCase().includes(marketSearch.toLowerCase()));

  const visibleMarketRates = marketOpen || marketSearch ? allMarketRates : allMarketRates.slice(0, 10);
  const metals = [
    ["gold", "Gold", "🥇"],
    ["silver", "Silver", "🥈"],
    ["platinum", "Platinum", "⬜"],
    ["palladium", "Palladium", "◻️"],
  ].filter(([key]) => Number(market?.metals?.[key]) > 0);

  return (
    <div className="space-y-4">
      <H sub="نرخی ناوخۆی تۆ — تەنها ئەم نرخانە لە مامەڵە و حیسابەکاندا بەکاردێن">
        {tr("نرخی ئەمڕۆ")}
      </H>

      <Card className="p-5">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
          <div>
            <div className="text-[14px] font-bold" style={{ color: "var(--txt)" }}>نرخی ناوخۆی سەراف</div>
            <div className="text-[11.5px] mt-1 leading-relaxed" style={{ color: "var(--txt-3)" }}>
              هەموو نرخەکان بە شێوەی <b style={{ color:"var(--txt)" }}>1 USD = X دراو</b> تۆمار دەکرێن.
              بۆ نموونە: <b style={{ color:"var(--txt)" }}>1 USD = 1,410 IQD</b> یان <b style={{ color:"var(--txt)" }}>1 USD = 7.20 CNY</b>.
            </div>
          </div>
          <div className="px-3 py-2 rounded-xl text-[10.5px] font-semibold shrink-0"
            style={{ background:"var(--pos-bg)", color:"var(--pos)" }}>
            INTERNAL · کاریگەر لە مامەڵەکان
          </div>
        </div>

        <div className="space-y-4">
          {rows.map((r) => (
            <div key={r.id} className="pb-4 border-b border-[var(--line)] last:border-0 last:pb-0">
              <div className="flex items-center gap-2.5 mb-2.5">
                <span className="text-xl" aria-hidden>{curFlag({ id: "usd" })}</span>
                <span className="text-sm font-bold text-[var(--txt)]">USD</span>
                <ArrowLeftRight className="w-3.5 h-3.5 text-[var(--txt-3)]" />
                <CurBadge c={r.c} size="sm" />
                <span className="text-sm font-semibold text-[var(--txt)]">{r.code}</span>
                <span className="text-xs text-[var(--txt-3)] hidden sm:inline">{r.name}</span>
              </div>

              {/* One number. Everything in the system divides by it, so it is asked for once,
                  in the one shape it is always read: 1 USD = X. */}
              <div>
                <div className="text-[11px] font-semibold text-[var(--txt-2)] mb-1">
                  ١ USD چەند {r.code} دەکات؟
                </div>
                <Inp type="number" step="any" dir="ltr" value={r.rate}
                  onChange={(e) => upd(r.id, "rate", e.target.value)}
                  className="text-center font-bold text-lg" placeholder={r.code === "IQD" ? "1410" : "7.20"} />
              </div>

              {Number(r.rate) > 0 && (
                <div className="text-[11px] text-[var(--txt-3)] mt-1.5" style={num}>
                  1 {r.code} = {fmt(1 / Number(r.rate), 6)} USD
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Btn onClick={() => saveRates(rows)}>پاشەکەوتکردنی نرخەکان</Btn>
          {last && <span className="text-xs text-[var(--txt-3)]">دوا نوێکردنەوە: {new Date(last).toLocaleString("en-GB")}</span>}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4" style={{ color:"var(--ac)" }} />
              <div className="text-[14px] font-bold" style={{ color:"var(--txt)" }}>نرخی بازاڕی جیهانی</div>
              <span className="px-2 py-1 rounded-full text-[9.5px] font-semibold" style={{ background:"var(--surf-3)", color:"var(--txt-3)" }}>
                نرخی جیهانی
              </span>
            </div>
            <div className="text-[11.5px] mt-1" style={{ color:"var(--txt-3)" }}>
              نرخە جیهانییەکان سەرچاوەی زانیارین؛ نرخی مامەڵە لە نرخی ناوخۆی سیستەمەوە وەردەگیرێت.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => loadMarket(true)} disabled={marketBusy}
              className="px-3 py-2 rounded-xl text-[11px] font-semibold tap flex items-center gap-1.5"
              style={{ background:"var(--surf-2)", border:"1px solid var(--line)", color:"var(--txt-2)" }}>
              <RotateCcw className={`w-3.5 h-3.5 ${marketBusy ? "animate-spin" : ""}`} />
              {marketBusy ? "..." : "نوێکردنەوە"}
            </button>
          </div>
        </div>

        {marketErr && (
          <div className="mb-4 p-3 rounded-xl text-[11.5px] flex items-start gap-2"
            style={{ background:"var(--warn-bg)", color:"var(--warn)" }}>
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{marketErr}</span>
          </div>
        )}

        {market && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-5">
              {metals.map(([key, name, icon]) => (
                <div key={key} className="rounded-[var(--r-sm)] p-3.5" style={{ background:"var(--surf-2)", border:"1px solid var(--line)" }}>
                  <div className="text-[11px] flex items-center gap-1.5" style={{ color:"var(--txt-3)" }}><span>{icon}</span>{name}</div>
                  <div className="text-[16px] font-bold mt-1" style={{ ...num, color:"var(--txt)" }}>
                    ${fmt(market.metals[key], 2)}
                  </div>
                  <div className="text-[9.5px] mt-0.5" style={{ color:"var(--txt-3)" }}>USD / troy oz</div>
                </div>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color:"var(--txt-3)" }} />
                <input value={marketSearch} onChange={(e) => setMarketSearch(e.target.value)}
                  placeholder="گەڕان بە USD, EUR, CNY..."
                  className="w-full ps-9 pe-3 py-2.5 rounded-xl outline-none text-[12px]"
                  style={{ background:"var(--surf-2)", border:"1px solid var(--line)", color:"var(--txt)" }} />
              </div>
              <div className="text-[10.5px] flex items-center" style={{ color:"var(--txt-3)" }}>
                {market.timestamp ? `نوێکراوەتەوە ${new Date(market.timestamp).toLocaleString("en-GB")}` : "—"}
              </div>
            </div>

            <div className="max-h-[420px] overflow-y-auto rounded-[var(--r-sm)]" style={{ border:"1px solid var(--line)" }}>
              {visibleMarketRates.map(([code, value]) => (
                <div key={code} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3.5 py-3 border-b last:border-0"
                  style={{ borderColor:"var(--line)" }}>
                  <span className="text-[19px]">{marketFlags[code] || "🌐"}</span>
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-semibold">{code}</div>
                    <div className="text-[9.5px] truncate" style={{ color:"var(--txt-3)" }}>{marketNames[code] || "Global currency"}</div>
                  </div>
                  <div className="text-end">
                    <div className="text-[12px] font-semibold" style={num}>1 USD = {fmt(value, rateDigits(value))}</div>
                    <div className="text-[9.5px]" style={{ color:"var(--txt-3)" }}>{code}</div>
                  </div>
                </div>
              ))}
            </div>

            {!marketSearch && allMarketRates.length > 10 && (
              <button onClick={() => setMarketOpen((v) => !v)}
                className="mt-3 w-full py-2.5 rounded-xl text-[11.5px] font-semibold tap"
                style={{ background:"var(--surf-2)", color:"var(--txt-2)", border:"1px solid var(--line)" }}>
                {marketOpen ? "کەمتر پیشان بدە" : `هەموو ${allMarketRates.length} دراوەکە پیشان بدە`}
              </button>
            )}
          </>
        )}

        {!market && !marketErr && (
          <div className="py-8 text-center text-[12px]" style={{ color:"var(--txt-3)" }}>
            {marketBusy ? "نرخی بازاڕ بار دەکرێت..." : "نرخی بازاڕ هێشتا بار نەکراوە"}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ══════════════════ پەڕەی خێر ══════════════════ */
function ProfitPage({ data, cur, profitIn, investorsProfitIn, invShare }) {
  const [mode, setMode] = useState("day");
  const t = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const day = iso(t);
  const w = new Date(t); w.setDate(w.getDate() - w.getDay());
  const m = new Date(t.getFullYear(), t.getMonth(), 1);
  const from = mode === "day" ? day : mode === "week" ? iso(w) : iso(m);
  const pm = profitIn(from, day);
  const inv = investorsProfitIn(from, day);
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);

  return (
    <div className="space-y-4">
      <H>{tr("خێر بە وردی")}</H>
      <div className="flex gap-1 bg-[var(--surf)] border border-[var(--line)] rounded-[var(--r-sm)] p-1 w-fit">
        {[["day", tr("ئەمڕۆ")], ["week", tr("ئەم هەفتەیە")], ["month", tr("ئەم مانگە")]].map(([k, t2]) => (
          <button key={k} onClick={() => setMode(k)}
            className={`px-4 py-2 rounded-lg text-sm ${mode === k ? "bg-[var(--pos)] text-white font-semibold" : "text-[var(--txt-2)] hover:bg-[var(--line)]"}`}>{t2}</button>
        ))}
      </div>

      {Object.keys(pm).length === 0 ? <Card><Empty t={tr("هیچ خێرێک نییە لەم ماوەیەدا")} /></Card> :
        Object.entries(pm).map(([cid, tot]) => {
          const c = cur(cid);
          const invTot = inv[cid] || 0;
          return (
            <Card key={cid} className="p-5">
              <div className="flex justify-between items-baseline mb-4">
                <div className="font-bold text-[var(--txt)]">{c.name}</div>
                <div className="text-2xl"><Money v={tot} dec={c.dec} pos /></div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="bg-[color-mix(in_srgb,var(--pos)_10%,transparent)]/70 rounded-[var(--r-sm)] p-3">
                  <div className="text-xs text-[var(--pos)]/70">{tr("خێری خۆم")}</div>
                  <div className="text-lg"><Money v={tot - invTot} dec={c.dec} pos /></div>
                </div>
                <div className="bg-[var(--line)]/70 rounded-[var(--r-sm)] p-3">
                  <div className="text-xs text-[var(--txt-2)]">{tr("خێری وەبەرهێنەران")}</div>
                  <div className="text-lg"><Money v={invTot} dec={c.dec} /></div>
                </div>
              </div>
              {invTot > 0 && (
                <div className="border-t border-[var(--line)] pt-3">
                  <div className="text-xs font-semibold text-[var(--txt-2)] mb-2">{tr("دابەشبوون بەسەر وەبەرهێنەران")}</div>
                  {investors.map((u) => {
                    const s = invShare(u.id, cid, from, day);
                    if (!s) return null;
                    return (
                      <div key={u.id} className="flex justify-between py-1.5 text-sm border-b border-[var(--line)] last:border-0">
                        <span className="text-[var(--txt-2)]">{u.name} <span className="text-xs text-[var(--txt-3)]">({u.rate}٪)</span></span>
                        <Money v={s} dec={c.dec} />
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          );
        })}
    </div>
  );
}

/* ══════════════════ قاسە و خەرجی ══════════════════ */
function Safes({ data, calc, cur, usr, mySafe, invUnpaid, owners, ratesReady, addDeposit, addExpense, addCurrency, isOwner }) {
  const [openCur, setOpenCur] = useState(null);
  const [f, setF] = useState({ dir: "in", owner: "self", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [xf, setXf] = useState({ category: "کرێی شوێن", investorId: "", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [nc, setNc] = useState({ code: "", name: "", symbol: "", dec: 2 });
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);
  // The value stored against an expense is the Kurdish word, in every language: it is written
  // to the ledger and compared against below, so one category must not become three because
  // three people had three languages open. Only the label is translated.
  const XCATS = ["کرێی شوێن", "مووچە", "گواستنەوە و حەواڵە", "کارەبا و ئینتەرنێت", "خەرجی تر", "خێری وەبەرهێنەر"].map((category) => [category, tr(category)]);
  const isPayout = xf.category === "خێری وەبەرهێنەر";
  const unpaid = isPayout && xf.investorId ? invUnpaid(xf.investorId, xf.curId) : null;

  return (
    <div className="space-y-4">
      <H>{tr("قاسە، پارە و خەرجی")}</H>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-1">
            <SecLbl>{tr("قاسەی گشتی (هەمووی)")}</SecLbl>
            <span className="text-[11px] text-[var(--txt-3)]">{tr("کلیک بۆ وردەکاری")}</span>
          </div>
          {data.currencies.map((c) => (
            <div key={c.id}>
              <button onClick={() => setOpenCur(openCur === c.id ? null : c.id)}
                className={`w-full flex justify-between items-center py-2.5 border-b border-[var(--line)] transition ${openCur === c.id ? "text-[var(--pos)]" : "hover:text-[var(--pos)]"}`}>
                <span className="text-sm flex items-center gap-2">
                  <ChevronLeft className={`w-3.5 h-3.5 transition-transform ${openCur === c.id ? "-rotate-90" : "rotate-180"}`} />
                  <CurBadge c={c} size="sm" />
                  {c.name}
                </span>
                <Money v={calc.phys[c.id] || 0} dec={0} />
              </button>
              {openCur === c.id && (
                <div className="py-3 px-1 bg-[var(--line)] rounded-[var(--r-sm)] my-2">
                  <CurrencyBreakdown curId={c.id} data={data} calc={calc} cur={cur} owners={owners} ratesReady={ratesReady} />
                </div>
              )}
            </div>
          ))}
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-1.5 mb-3">
            <Wallet className="w-4 h-4 text-[var(--pos)]" />
            <SecLbl>{tr("قاسەی تایبەتی خۆم")}</SecLbl>
          </div>
          {data.currencies.map((c) => (
            <div key={c.id} className="flex justify-between py-2 border-b border-[var(--line)] last:border-0">
              <span className="text-sm text-[var(--txt-2)]">{c.name}</span>
              <Money v={mySafe[c.id] || 0} dec={c.dec} />
            </div>
          ))}
          <div className="text-[11px] text-[var(--txt-3)] mt-2">{tr("سەرمایەی خۆت + خێری خۆت − خەرجی و عمولەکان")}</div>
        </Card>
      </div>

      <Card className="p-5">
        <SecLbl>{tr("پارە داخڵکردن / دەرهێنان")}</SecLbl>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>{tr("جۆر")}</Lbl><Sel value={f.dir} onChange={(e) => setF({ ...f, dir: e.target.value })}><option value="in">{tr("داخڵکردن")}</option><option value="out">{tr("دەرهێنان")}</option></Sel></div>
          <div><Lbl>{tr("خاوەنی پارە")}</Lbl><Sel value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}><option value="self">{tr("هی خۆم")}</option>{investors.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Sel></div>
          <div><Lbl>{tr("دراو")}</Lbl><Sel value={f.curId} onChange={(e) => setF({ ...f, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>{tr("بڕ")}</Lbl><Inp type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0" /></div>
          <div className="flex items-end"><Btn className="w-full" onClick={() => { if (+f.amount > 0) { addDeposit(f); setF({ ...f, amount: "" }); } }}>{tr("تۆمارکردن")}</Btn></div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-1.5 mb-3"><Receipt className="w-4 h-4 text-[var(--neg)]" /><SecLbl>{tr("تۆمارکردنی خەرجی")}</SecLbl></div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>{tr("جۆری خەرجی")}</Lbl><Sel value={xf.category} onChange={(e) => setXf({ ...xf, category: e.target.value, investorId: "" })}>{XCATS.map(([category, label]) => <option key={category} value={category}>{label}</option>)}</Sel></div>
          {isPayout && (
            <div><Lbl>{tr("وەبەرهێنەر")}</Lbl><Sel value={xf.investorId} onChange={(e) => setXf({ ...xf, investorId: e.target.value })}><option value="">—</option>{investors.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Sel></div>
          )}
          <div><Lbl>{tr("دراو")}</Lbl><Sel value={xf.curId} onChange={(e) => setXf({ ...xf, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>{tr("بڕ")}</Lbl><Inp type="number" value={xf.amount} onChange={(e) => setXf({ ...xf, amount: e.target.value })} placeholder="0" /></div>
          {!isPayout && <div><Lbl>{tr("تێبینی")}</Lbl><Inp value={xf.note} onChange={(e) => setXf({ ...xf, note: e.target.value })} /></div>}
          <div className="flex items-end"><Btn kind="danger" className="w-full" onClick={() => { if (+xf.amount > 0) { addExpense(xf); setXf({ ...xf, amount: "", note: "" }); } }}>{tr("تۆمارکردن")}</Btn></div>
        </div>
        {isPayout && xf.investorId && (
          <div className="mt-3 bg-[color-mix(in_srgb,var(--warn)_11%,transparent)] border border-[color-mix(in_srgb,var(--warn)_26%,transparent)] rounded-[var(--r-sm)] p-3 text-sm flex items-center justify-between flex-wrap gap-2">
            <span className="text-[var(--warn)]">خێری نەدراوی {usr(xf.investorId).name}: <b style={num}>{fmt(unpaid, cur(xf.curId).dec)}</b> {cur(xf.curId).code}</span>
            <button onClick={() => setXf({ ...xf, amount: String(Math.max(0, Math.round(unpaid * 100) / 100)) })} className="text-xs font-semibold text-[var(--pos)]">دانانی ئەم بڕە ←</button>
          </div>
        )}
      </Card>

{isOwner && (
      <Card className="p-5">
        <SecLbl>{tr("زیادکردنی دراوی نوێ")}</SecLbl>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>{tr("کۆد")}</Lbl><Inp dir="ltr" value={nc.code} onChange={(e) => setNc({ ...nc, code: e.target.value.toUpperCase() })} placeholder="EUR" /></div>
          <div><Lbl>{tr("ناو")}</Lbl><Inp value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></div>
          <div><Lbl>{tr("هێما")}</Lbl><Inp value={nc.symbol} onChange={(e) => setNc({ ...nc, symbol: e.target.value })} /></div>
          <div><Lbl>{tr("خانەی دەیمی")}</Lbl><Inp type="number" value={nc.dec} onChange={(e) => setNc({ ...nc, dec: +e.target.value })} /></div>
          <div className="col-span-2 md:col-span-5">
            <label className="flex items-start gap-2.5 cursor-pointer bg-[var(--line)] border border-[var(--line)] rounded-[var(--r-sm)] p-3">
              <input type="checkbox" checked={!!nc.external} onChange={(e) => setNc({ ...nc, external: e.target.checked })}
                className="mt-0.5 w-4 h-4 accent-[var(--pos)]" />
              <span className="text-sm text-[var(--txt)]">
                <b>{tr("دراوی دەرەوە")}</b>
                <div className="text-xs text-[var(--txt-2)] mt-0.5">{tr("لای تەرەفەکان هەڵدەگیرێت، لە قاسەی گشتیدا نامێنێتەوە (وەک یەن)")}</div>
              </span>
            </label>
          </div>
          <div className="flex items-end"><Btn kind="gold" className="w-full" onClick={() => { if (nc.code && nc.name) { addCurrency(nc); setNc({ code: "", name: "", symbol: "", dec: 2 }); } }}>{tr("زیادکردن")}</Btn></div>
        </div>
      </Card>
      )}
    </div>
  );
}

/* ══════════════════ فۆرمی مامەڵە ══════════════════ */
function TxForm({ data, cur, calc, usr, avgRate, inventoryPosition, usdValueAt, usdToCurrencyAt, autoRate, onSave, editing, onCancel, lockCp, batch, onClearBatch, busy, flash }) {
  const e = editing;
  const [sending, setSending] = useState(false);
  const bCur = batch ? data.currencies.find((c) => c.code === batch.currency)?.id : null;

  const pickAgainst = (curId) => {
    if (curId !== "usd" && data.currencies.some((c) => c.id === "usd")) return "usd";
    return data.currencies.find((c) => c.id === "iqd" && c.id !== curId)?.id
      || data.currencies.find((c) => c.id !== curId)?.id
      || "";
  };

  const initialCurId = e ? e.curId : (bCur || data.currencies.find((c) => c.id !== "usd")?.id || data.currencies[0]?.id || "");
  const initialAgainstId = e ? e.againstId : pickAgainst(initialCurId);
  const initialRateBaseId = preferredRateBaseId(initialCurId, initialAgainstId);

  const [f, setF] = useState({
    type: e ? e.type : (batch?.direction === "out" ? "sell" : "buy"),
    curId: initialCurId,
    amount: e ? e.amount : (batch ? batch.total_net : ""),
    againstId: initialAgainstId,
    rateBaseId: initialRateBaseId,
    quote: e && e.rate ? storedRateToDisplay(e.rate, initialCurId, initialAgainstId, initialRateBaseId) : "",
    manualRate: !!e,
    cpMode: e ? (e.cpId ? "acc" : "free") : "acc",
    cpId: e ? e.cpId || "" : (lockCp || batch?.customer_id || ""),
    cpName: e ? e.cpName || "" : "",
    partnerId: e ? e.partnerId || "" : (batch?.partner_id || ""),
    direct: e ? !!e.direct : false,
    buyQuote: e && e.direct && e.buyRate ? storedRateToDisplay(e.buyRate, initialCurId, initialAgainstId, initialRateBaseId) : "",
    sellQuote: e && e.direct && e.rate ? storedRateToDisplay(e.rate, initialCurId, initialAgainstId, initialRateBaseId) : "",
    fromId: "", fromName: "", toId: "", toName: "",
    buyStatus: "completed", sellStatus: "completed",
    status: e ? e.status : "completed",
    officeId: "",
    note: e ? e.note : "",
  });

  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  const offices = data.users.filter((u) => u.role === "office" && !u.deleted);

  const roundByCurrency = (value, curId) => roundToCurrency(data, value, curId);

  const autoStored = autoRate(f.type, f.curId, f.againstId);
  const autoQuote = autoStored
    ? storedRateToDisplay(autoStored, f.curId, f.againstId, f.rateBaseId)
    : null;

  const directBuyAutoStored = autoRate("buy", f.curId, f.againstId);
  const directSellAutoStored = autoRate("sell", f.curId, f.againstId);
  const directBuyAuto = directBuyAutoStored
    ? storedRateToDisplay(directBuyAutoStored, f.curId, f.againstId, f.rateBaseId)
    : null;
  const directSellAuto = directSellAutoStored
    ? storedRateToDisplay(directSellAutoStored, f.curId, f.againstId, f.rateBaseId)
    : null;

  useEffect(() => {
    if (!f.manualRate && autoQuote) {
      setF((x) => {
        const next = Number(autoQuote.toPrecision(10));
        return Number(x.quote) === next ? x : { ...x, quote: next };
      });
    }
  }, [autoQuote, f.manualRate, f.curId, f.againstId, f.type, f.rateBaseId]);

  const quote = Number(f.quote) || 0;
  const rate = displayRateToStored(quote, f.curId, f.againstId, f.rateBaseId);
  const offDay = !!(autoQuote && quote && Math.abs(quote - autoQuote) > Math.abs(autoQuote) * 0.0001);

  const amtR = roundByCurrency(f.amount, f.curId);
  const total = rate > 0 ? roundByCurrency(amtR * rate, f.againstId) : 0;

  // ── مامەڵەی ڕاستەوخۆ ──
  const bq = Number(f.buyQuote) || 0;
  const sq = Number(f.sellQuote) || 0;
  const dBuyRate = displayRateToStored(bq, f.curId, f.againstId, f.rateBaseId);
  const dSellRate = displayRateToStored(sq, f.curId, f.againstId, f.rateBaseId);
  const dBuyTotal = dBuyRate > 0 ? roundByCurrency(amtR * dBuyRate, f.againstId) : 0;
  const dSellTotal = dSellRate > 0 ? roundByCurrency(amtR * dSellRate, f.againstId) : 0;
  const dProfit = bq > 0 && sq > 0 ? roundByCurrency(dSellTotal - dBuyTotal, f.againstId) : null;

  const pos = f.type === "sell" && inventoryPosition
    ? inventoryPosition(f.curId, f.againstId, e?.id || null, e?.date || null)
    : null;
  const av = f.type === "sell"
    ? (pos?.avgRate ?? avgRate(f.curId, f.againstId, e?.id || null, e?.date || null))
    : null;
  const enoughCostBasis = f.type !== "sell" || !pos || (pos.costComplete !== false && amtR <= pos.qty + 1e-9);
  const estCostAgainst = f.type === "sell" && av !== null && usdToCurrencyAt
    ? usdToCurrencyAt(av * amtR, f.againstId, "sell", new Date().toISOString())
    : null;
  const estProfit = f.type === "sell" && av !== null && enoughCostBasis && Number.isFinite(estCostAgainst)
    ? roundByCurrency(total - estCostAgainst, f.againstId)
    : null;

  const srcBal = f.partnerId ? ((calc.partner[f.partnerId] || {})[f.curId] || 0) : (calc.atMe[f.curId] || 0);
  const willBeNeg = f.type === "sell" && srcBal - amtR < -1e-9;

  // The server refuses this, and it is right to: money in a currency the office does not hold in
  // its own safe has to be somewhere, and that somewhere is a person. But the refusal arrived
  // only AFTER the owner had filled the whole form and pressed the button, as a banner over a
  // screen that had already cleared.
  //
  //   raise exception using errcode='23514',
  //     message='external currency requires an explicit custody partner'
  //
  // Mirrored here exactly — not loosened, not re-decided. The rule is still the database's; this
  // only asks the question before the answer can be wrong.
  const needsCustodian = !f.direct && !f.partnerId && !!cur(f.curId).external;

  // Converting a batch of receipts is not the same as recording a trade by hand.
  //
  // Custody is a property of the RECEIPTS — it is set on the batch screen, under «دابەشکردن
  // بەسەر هاوبەشەکان», by its own command with its own reason and audit trail. The conversion
  // then reads it back:
  //
  //   v_tx := p_tx || jsonb_build_object(…, 'partner_id', v_partner, …)
  //
  // where `v_partner` comes from the receipts, not from here. So whatever this form sent was
  // overwritten before the rules ever saw it. For a customer-seller's receipts, which carry no
  // partner at all, that meant NULL — and the very next check refused the trade for naming
  // nobody, in front of an owner who had just named somebody.
  //
  // The box is therefore not a choice here. It shows what the receipts say, and when they say
  // nothing it sends the owner to the one screen where it can be said.
  //
  // ── and then the owner said no, and they were right ────────────────────────
  //
  // The first version of this locked the box and sent them to «دابەشکردن بەسەر هاوبەشەکان» to
  // set custody before coming back. Two screens and three commands to do one thing. What they
  // asked for instead:
  //
  //   «هەر لەوێوە هاوبەش هەڵبژێرم و کە کردم، هەم پارەکە بچێتە لای ئەو، هەمیش پەسەند بکرێت،
  //    و فیشەکانیشی بۆ بڕوات — بەڵام با هێندە شپرز نەبێت»
  //
  // 202608280024 makes the conversion honour a partner named here, by calling the custody
  // command itself so the evidence is written exactly as that screen writes it. So the box is
  // a real choice again — but only where there is a choice to make. Receipts already placed
  // with a partner still show that partner and cannot be moved from here: reassigning custody
  // is its own decision and keeps its own screen.
  const custodyLockedByReceipts = !!batch?.partner_id;
  const custodyChosenHere = !!batch && !batch?.partner_id;

  // Two more the database refuses, for the same reason and at the same late moment:
  //
  //   raise 23514 'sale would create negative inventory'   -- v_amount > v_qty
  //   raise 23514 'inventory cost basis is incomplete'     -- v_avg is null
  //
  // `enoughCostBasis` above has computed exactly this all along, and used it only to decide
  // whether to show an estimated profit. Selling more than the office holds went all the way to
  // the server and came back refused.
  //
  // It stops the sale ONLY when the position came from the server's own snapshot — the same
  // number the command will check against. When this browser worked the figure out for itself it
  // says so and lets the sale go, because a client-side disagreement that blocks a legitimate
  // sale is a worse failure than a late refusal.
  const shortOfStock = f.type === "sell" && pos && amtR > 0 && amtR > pos.qty + 1e-9;
  const costBasisMissing = f.type === "sell" && pos && pos.costComplete === false;
  const inventoryRefuses = (shortOfStock || costBasisMissing) && pos?.fromServer === true;
  const inventoryDoubts = (shortOfStock || costBasisMissing) && pos?.fromServer !== true;
  const feeRate = f.partnerId ? (usr(f.partnerId).rate || 0) : 0;
  const rateQuoteId = oppositePairId(f.curId, f.againstId, f.rateBaseId);

  const setPair = (nextCurId, nextAgainstId) => {
    let c = nextCurId, a = nextAgainstId;
    if (!c || !a) return;
    if (c === a) a = pickAgainst(c);
    if (!a || c === a) return;

    const nextBase = preferredRateBaseId(c, a);
    setF((x) => ({
      ...x,
      curId: c,
      againstId: a,
      rateBaseId: nextBase,
      quote: "",
      manualRate: false,
      buyQuote: "",
      sellQuote: "",
      partnerId: cur(c).external ? x.partnerId : x.partnerId,
    }));
  };

  const swapPair = () => {
    if (!f.curId || !f.againstId) return;
    const oldStored = displayRateToStored(f.quote, f.curId, f.againstId, f.rateBaseId);
    const nextCur = f.againstId, nextAgainst = f.curId;
    const nextBase = preferredRateBaseId(nextCur, nextAgainst);
    const nextStored = oldStored > 0 ? 1 / oldStored : 0;
    const nextQuote = nextStored > 0 ? storedRateToDisplay(nextStored, nextCur, nextAgainst, nextBase) : "";
    setF((x) => ({
      ...x,
      curId: nextCur,
      againstId: nextAgainst,
      rateBaseId: nextBase,
      quote: nextQuote || "",
      manualRate: !!nextQuote,
      buyQuote: "",
      sellQuote: "",
      partnerId: "",
    }));
  };

  const flipRateView = () => {
    const nextBase = f.rateBaseId === f.curId ? f.againstId : f.curId;
    const invert = (value) => Number(value) > 0 ? 1 / Number(value) : "";
    setF((x) => ({
      ...x,
      rateBaseId: nextBase,
      quote: invert(x.quote),
      buyQuote: invert(x.buyQuote),
      sellQuote: invert(x.sellQuote),
    }));
  };

  const blank = {
    type: f.type, curId: f.curId, amount: "", againstId: f.againstId, rateBaseId: f.rateBaseId, quote: f.quote,
    manualRate: f.manualRate, cpMode: "acc", cpId: lockCp || "", cpName: "",
    partnerId: "", status: "completed", officeId: "", note: "",
    direct: f.direct, buyQuote: f.buyQuote, sellQuote: f.sellQuote,
  };

  const submit = async () => {
    if (sending || busy) return;
    // This used to `return` here and say nothing at all. The owner pressed «تۆمارکردنی کڕین»,
    // the screen did not move, no message appeared, and there was nothing on it to tell them
    // which of the two currency boxes was the problem. A refusal nobody can see is worse than
    // one they can argue with.
    if (!f.curId || !f.againstId) {
      flash?.(tr("هەردوو دراوەکە هەڵبژێرە"), "error");
      return;
    }
    if (f.curId === f.againstId) {
      flash?.(tr("دراوی مامەڵە و دراوی بەرامبەر ناکرێت هەمان بن"), "error");
      return;
    }
    setSending(true);
    try {
      const ok = await onSave({ ...f, rate, batchId: batch?.id, receiptIds: batch?.receipt_ids || [] }, e);
      if (ok !== false && !e) setF(blank);
    } finally {
      setTimeout(() => setSending(false), 400);
    }
  };

  if (e) {
    const counterparty = e.cpId ? (usr(e.cpId).name || e.cpName) : e.cpName;
    const flowLabel = e.businessFlow === "partner_custody"
      ? "A · پارە لای هاوبەش"
      : e.businessFlow === "owner_cashbox"
        ? "B · قاسەی خۆم / ڕاستەوخۆ"
        : "C · مامەڵەی ئاسایی";
    return (
      <div className="space-y-4 pb-4">
        <H sub="بڕ، نرخ، دراو، لایەن و custody دوای journal ناگۆڕدرێن">
          {tr("ئیدیت")} #{e.code}
        </H>
        <Card className="p-4" style={{ background: "var(--warn-bg)", borderColor: "color-mix(in srgb,var(--warn) 32%,var(--line))" }}>
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "var(--warn)" }} />
            <div>
              <div className="text-[13px] font-semibold" style={{ color: "var(--txt)" }}>دەستکاریی پارێزراوی مامەڵە</div>
              <p className="text-[11.5px] leading-6 mt-1" style={{ color: "var(--txt-2)" }}>
                تەنها تێبینی دەگۆڕدرێت. بۆ ڕاستکردنەوەی بڕ، نرخ، دراو یان لایەن، مامەڵەکە بە
                تۆماری پێچەوانە هەڵبوەشێنەرەوە و مامەڵەی دروست تۆمار بکە؛ مێژووی دارایی دەمێنێتەوە.
              </p>
            </div>
          </div>
        </Card>
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between gap-3"><span className="text-[11px] text-[var(--txt-3)]">جۆری لۆجیک</span><Pill>{flowLabel}</Pill></div>
          <div className="grid grid-cols-2 gap-3">
            <div><div className="text-[10.5px] text-[var(--txt-3)]">مامەڵە</div><div className="text-[14px] font-semibold mt-1">{e.type === "buy" ? "کڕین" : "فرۆشتن"} · {counterparty || "—"}</div></div>
            <div><div className="text-[10.5px] text-[var(--txt-3)]">بڕ</div><div className="text-[14px] font-semibold mt-1" style={num}>{fmtMoney(data, e.amount, e.curId)} {cur(e.curId).code}</div></div>
            <div><div className="text-[10.5px] text-[var(--txt-3)]">نرخ</div><div className="text-[14px] font-semibold mt-1" style={num}>{fmt(e.rate, rateDigits(e.rate))}</div></div>
            <div><div className="text-[10.5px] text-[var(--txt-3)]">کۆ</div><div className="text-[14px] font-semibold mt-1" style={num}>{fmtMoney(data, e.total, e.againstId)} {cur(e.againstId).code}</div></div>
          </div>
          {e.partnerId && <div className="pt-3 border-t border-[var(--line)] text-[11.5px] text-[var(--txt-2)]">هاوبەشی custody: <b>{usr(e.partnerId).name}</b></div>}
        </Card>
        <Card className="p-5">
          <Lbl>{tr("تێبینی")}</Lbl>
          <Inp value={f.note} onChange={(ev) => setF({ ...f, note: ev.target.value })} placeholder="تێبینییەکی ڕوون و audit-friendly..." />
        </Card>
        <div className="flex gap-2 sticky bottom-24 md:bottom-4">
          <Btn kind="primary" onClick={submit} disabled={sending || busy} className="flex-1 !py-4 !text-[15px]">
            {sending || busy ? "..." : "پاشەکەوتکردنی تێبینی"}
          </Btn>
          <Btn kind="ghost" onClick={onCancel} className="!py-4">{tr("پاشگەزبوونەوە")}</Btn>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      <H sub={f.direct ? tr("کڕین و فرۆشتن لە یەک کاتدا") : null}>
        {e ? `${tr("ئیدیت")} #${e.code}` : tr("مامەڵەی نوێ")}
      </H>

      {batch && (
        <Card className="p-4" style={{ borderColor: "rgba(var(--ac-gl),.3)", background: "rgba(var(--ac-gl),.06)" }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold" style={{ color: "var(--ac)" }}>
                {tr("لە فیشە پەسەندکراوەکانی")} {batch.customer_name || (batch.partner_id ? usr(batch.partner_id).name : tr("نەزانراو"))}
              </div>
              <div className="text-[11.5px] mt-1" style={{ ...num, color: "var(--txt-2)" }}>
                {batch.n} {tr("فیش")} · {fmtMoney(data, batch.total_net, batch.currency)} {batch.currency}
              </div>
            </div>
            <button onClick={onClearBatch} className="p-1.5 tap shrink-0" style={{ color: "var(--txt-3)" }}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </Card>
      )}

      {/* جۆری مامەڵە */}
      <div className="flex gap-2">
        {["buy", "sell"].map((k) => {
          const locked = !!batch, on = f.type === k;
          if (locked && !on) return null;
          return (
            <button key={k} disabled={locked}
              onClick={() => !locked && setF({ ...f, type: k, manualRate: false, quote: "", status: "completed" })}
              className="flex-1 py-3.5 rounded-[var(--r-sm)] text-[14px] font-semibold tap flex items-center justify-center gap-2"
              style={on
                ? { background: k === "buy" ? "var(--pos-bg)" : "var(--neg-bg)",
                    color: k === "buy" ? "var(--pos)" : "var(--neg)",
                    border: `1px solid ${k === "buy" ? "color-mix(in srgb, var(--pos) 34%, transparent)" : "color-mix(in srgb, var(--neg) 34%, transparent)"}` }
                : { background: "var(--surf-2)", color: "var(--txt-3)", border: "1px solid var(--line)" }}>
              {k === "buy" ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
              {k === "buy" ? tr("کڕین") : tr("فرۆشتن")}
            </button>
          );
        })}
      </div>

      {!batch && !e && (
        <button onClick={() => {
          const next = !f.direct;
          setF({
            ...f,
            direct: next,
            partnerId: "",
            buyQuote: next && directBuyAuto ? Number(directBuyAuto.toPrecision(10)) : f.buyQuote,
            sellQuote: next && directSellAuto ? Number(directSellAuto.toPrecision(10)) : f.sellQuote,
          });
        }}
          className="w-full flex items-center gap-3 p-3.5 rounded-[var(--r-sm)] tap text-start"
          style={f.direct
            ? { background: "var(--warn-bg)", border: "1px solid color-mix(in srgb, var(--warn) 34%, transparent)" }
            : { background: "var(--surf-2)", border: "1px solid var(--line)" }}>
          <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            style={{ background: f.direct ? "var(--warn-bg)" : "var(--surf-3)" }}>
            <Zap className="w-4 h-4" style={{ color: f.direct ? "var(--warn)" : "var(--txt-3)" }} />
          </span>
          <span className="flex-1">
            <span className="text-[13.5px] font-semibold block" style={{ color: f.direct ? "var(--warn)" : "var(--txt)" }}>
              {tr("مامەڵەی ڕاستەوخۆ")}
            </span>
            <span className="text-[11px]" style={{ color: "var(--txt-3)" }}>
              {tr("بێ هەڵگرتن · بێ عمولە · خێر ١٠٠٪ هی خۆم")}
            </span>
          </span>
          <span className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center"
            style={{ border: `2px solid ${f.direct ? "var(--warn)" : "var(--line-2)"}`,
                     background: f.direct ? "var(--warn)" : "transparent" }}>
            {f.direct && <CheckCircle2 className="w-3 h-3 text-white" />}
          </span>
        </button>
      )}

      {/* دراوەکان + بڕ */}
      <Card className="p-5 space-y-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2.5">
          <div>
            <Lbl>دراوی مامەڵە</Lbl>
            <Sel value={f.curId} disabled={!!batch} onChange={(ev) => setPair(ev.target.value, f.againstId)}>
              {data.currencies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </Sel>
          </div>
          <button type="button" onClick={swapPair}
            className="w-10 h-10 mb-[1px] rounded-xl tap flex items-center justify-center"
            style={{ background:"var(--surf-3)", border:"1px solid var(--line)", color:"var(--txt-2)" }}
            title="گۆڕینی ئاراستەی pair">
            <ArrowLeftRight className="w-4 h-4" />
          </button>
          <div>
            <Lbl>دراوی بەرامبەر</Lbl>
            <Sel value={f.againstId} onChange={(ev) => setPair(f.curId, ev.target.value)}>
              {data.currencies.filter((c) => c.id !== f.curId).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </Sel>
          </div>
        </div>

        <div className="rounded-[var(--r-sm)] px-3 py-2.5 flex items-center justify-center gap-2 text-[11.5px]"
          style={{ background:"var(--surf-2)", border:"1px solid var(--line)", color:"var(--txt-2)" }}>
          <CurBadge c={cur(f.curId)} size="sm" />
          <span className="font-semibold">{cur(f.curId).code}</span>
          <ArrowLeftRight className="w-3.5 h-3.5" />
          <CurBadge c={cur(f.againstId)} size="sm" />
          <span className="font-semibold">{cur(f.againstId).code}</span>
          <span className="ms-1" style={{ color:"var(--txt-3)" }}>هەر دوو دراوێک دەتوانرێت هەڵبژێردرێن</span>
        </div>

        <div className="text-center">
          <div className="text-[12px] mb-2" style={{ color: "var(--txt-3)" }}>
            {tr("بڕ")} · {cur(f.curId).code}
          </div>
          <input type="number" inputMode="decimal" min="0" step="any" value={f.amount} readOnly={!!batch}
            onChange={(ev) => setF({ ...f, amount: ev.target.value })} placeholder="0"
            className="w-full text-center bg-transparent outline-none"
            aria-label={batch ? tr("کۆی پەسەندکراوی فیشەکان؛ گۆڕانکاری ناکرێت") : tr("بڕی مامەڵە")}
            style={{ ...num, fontSize: 40, fontWeight: 600, letterSpacing: "-.03em", color: "var(--txt)", border: 0, opacity: batch ? .88 : 1 }} />
        </div>
      </Card>

      {/* ڕەیت + ئەنجام */}
      {f.direct ? (
        <Card className="p-5 space-y-4" style={{ borderColor: "color-mix(in srgb, var(--warn) 24%, transparent)" }}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11.5px]" style={{ color:"var(--txt-3)" }}>
              1 {cur(f.rateBaseId).code} = X {cur(rateQuoteId).code}
            </div>
            <button type="button" onClick={flipRateView}
              className="px-2.5 py-1.5 rounded-lg text-[10.5px] font-semibold tap"
              style={{ background:"var(--surf-3)", border:"1px solid var(--line)", color:"var(--txt-2)" }}>
              ⇄ گۆڕینی شێوازی نرخ
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Lbl>{tr("بە چەند دەیکڕم")} · 1 {cur(f.rateBaseId).code}</Lbl>
              <Inp type="number" step="any" dir="ltr" value={f.buyQuote}
                onChange={(ev) => setF({ ...f, buyQuote: ev.target.value })}
                className="!text-center !text-[17px] !font-semibold"
                placeholder={directBuyAuto ? String(Number(directBuyAuto.toPrecision(8))) : "0"} />
              {directBuyAuto && (
                <button type="button" onClick={() => setF((x) => ({ ...x, buyQuote: Number(directBuyAuto.toPrecision(10)) }))}
                  className="mt-1 text-[10.5px] font-semibold tap" style={{ color:"var(--ac)" }}>
                  نرخی ڕۆژ: {fmt(directBuyAuto, rateDigits(directBuyAuto))}
                </button>
              )}
            </div>
            <div>
              <Lbl>{tr("بە چەند دەیفرۆشم")} · 1 {cur(f.rateBaseId).code}</Lbl>
              <Inp type="number" step="any" dir="ltr" value={f.sellQuote}
                onChange={(ev) => setF({ ...f, sellQuote: ev.target.value })}
                className="!text-center !text-[17px] !font-semibold"
                placeholder={directSellAuto ? String(Number(directSellAuto.toPrecision(8))) : "0"} />
              {directSellAuto && (
                <button type="button" onClick={() => setF((x) => ({ ...x, sellQuote: Number(directSellAuto.toPrecision(10)) }))}
                  className="mt-1 text-[10.5px] font-semibold tap" style={{ color:"var(--ac)" }}>
                  نرخی ڕۆژ: {fmt(directSellAuto, rateDigits(directSellAuto))}
                </button>
              )}
            </div>
          </div>

          {bq > 0 && sq > 0 && amtR > 0 && (
            <div className="rounded-[var(--r-sm)] p-4 space-y-2" style={{ background: "var(--surf-3)" }}>
              <div className="flex justify-between text-[13px]">
                <span style={{ color: "var(--txt-2)" }}>{tr("دەدەم (کڕین)")}</span>
                <span className="font-semibold" style={{ ...num, color: "var(--neg)" }}>
                  {fmt(dBuyTotal, cur(f.againstId).dec || 0)} {cur(f.againstId).code}
                </span>
              </div>
              <div className="flex justify-between text-[13px]">
                <span style={{ color: "var(--txt-2)" }}>{tr("وەردەگرم (فرۆشتن)")}</span>
                <span className="font-semibold" style={{ ...num, color: "var(--pos)" }}>
                  {fmt(dSellTotal, cur(f.againstId).dec || 0)} {cur(f.againstId).code}
                </span>
              </div>
              <div className="flex justify-between items-baseline pt-2.5" style={{ borderTop: "1px solid var(--line)" }}>
                <span className="text-[13px] font-semibold" style={{ color: "var(--txt)" }}>
                  {dProfit >= 0 ? tr("خێر") : tr("زەرەر")}
                </span>
                <span className="text-[24px] font-semibold"
                  style={{ ...num, color: dProfit >= 0 ? "var(--pos)" : "var(--neg)" }}>
                  {dProfit >= 0 ? "+" : "−"}{fmt(Math.abs(dProfit), cur(f.againstId).dec || 0)}
                  <span className="text-[12px] font-normal"> {cur(f.againstId).code}</span>
                </span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <Lbl>{tr("لە کێ دەیکڕم؟")}</Lbl>
              <Sel value={f.fromId} onChange={(ev) => setF({ ...f, fromId: ev.target.value, fromName: "" })}>
                <option value="">{tr("— ناوێکی ئازاد —")}</option>
                {customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Sel>
              {!f.fromId && <Inp className="mt-2" value={f.fromName} onChange={(ev) => setF({ ...f, fromName: ev.target.value })} placeholder={tr("ناوی فرۆشیار...")} />}
            </div>
            <div>
              <Lbl>{tr("بە کێ دەیفرۆشم؟")}</Lbl>
              <Sel value={f.toId} onChange={(ev) => setF({ ...f, toId: ev.target.value, toName: "" })}>
                <option value="">{tr("— ناوێکی ئازاد —")}</option>
                {customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Sel>
              {!f.toId && <Inp className="mt-2" value={f.toName} onChange={(ev) => setF({ ...f, toName: ev.target.value })} placeholder={tr("ناوی کڕیار...")} />}
            </div>
          </div>
        </Card>
      ) : (
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px]" style={{ color:"var(--txt-3)" }}>نرخی مامەڵە</div>
              <div className="text-[13px] font-semibold mt-0.5" style={{ color:"var(--txt)" }}>
                1 {cur(f.rateBaseId).code} = X {cur(rateQuoteId).code}
              </div>
            </div>
            <button type="button" onClick={flipRateView}
              className="px-2.5 py-1.5 rounded-lg text-[10.5px] font-semibold tap"
              style={{ background:"var(--surf-3)", border:"1px solid var(--line)", color:"var(--txt-2)" }}>
              ⇄ گۆڕینی شێوازی نرخ
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] items-end gap-4">
            <div>
              <Lbl>1 {cur(f.rateBaseId).code} = ؟ {cur(rateQuoteId).code}</Lbl>
              <Inp type="number" step="any" dir="ltr" value={f.quote}
                onChange={(ev) => setF({ ...f, quote: ev.target.value, manualRate: true })}
                className="!text-center !text-[19px] !font-semibold"
                style={offDay ? { borderColor: "var(--warn)", background: "var(--warn-bg)" } : {}} />
            </div>
            <div className="text-end md:min-w-[190px]">
              <div className="text-[11px]" style={{ color: "var(--txt-3)" }}>{tr("کۆی گشتی")}</div>
              <div className="text-[26px] font-semibold" style={{ ...num, color: "var(--txt)", letterSpacing: "-.02em" }}>
                {fmt(total, cur(f.againstId).dec || 0)}
              </div>
              <div className="text-[11px]" style={{ color: "var(--txt-3)" }}>{cur(f.againstId).code}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11.5px]" style={{ color: "var(--txt-3)" }}>
            <span style={num}>
              {tr("نرخی ڕۆژ:")} {autoQuote ? `1 ${cur(f.rateBaseId).code} = ${fmt(autoQuote, rateDigits(autoQuote))} ${cur(rateQuoteId).code}` : "—"}
            </span>
            {offDay && (
              <button onClick={() => setF({ ...f, manualRate: false, quote: autoQuote })}
                className="font-semibold tap" style={{ color: "var(--ac)" }}>{tr("گەڕانەوە")}</button>
            )}
            {f.type === "sell" && av !== null && (
              <span style={num}>
                · مامناوەندی تێچووی USD: 1 {cur(f.curId).code} = {fmt(av, rateDigits(av))} USD
              </span>
            )}
            {estProfit !== null && (
              <span className="ms-auto font-bold" style={{ color: estProfit >= 0 ? "var(--pos)" : "var(--neg)" }}>
                {estProfit >= 0 ? tr("خێر") : tr("زەرەر")} {estProfit >= 0 ? "+" : "−"}{fmtMoney(data, Math.abs(estProfit), f.againstId)} {cur(f.againstId).code}
              </span>
            )}
          </div>

          {/* Enough stock, but at least one buy is missing its cost snapshot. Profit is
              deliberately not invented — say so instead of showing a silent blank. */}
          {f.type === "sell" && pos && amtR <= pos.qty + 1e-9 && pos.costComplete === false && (
            <div className="p-3 rounded-xl text-[11.5px] flex items-start gap-2"
              style={{ background:"var(--warn-bg)", color:"var(--warn)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                تێچووی هەندێک لە کڕینەکانی ئەم دراوە تۆمار نەکراوە، بۆیە خێر/زەرەر ناژمێردرێت و
                بە بەتاڵی تۆمار دەکرێت. سەرەتا نرخی کڕینی ئەو مامەڵانە ڕاست بکەرەوە.
              </span>
            </div>
          )}

          {f.type === "sell" && pos && amtR > pos.qty + 1e-9 && (
            <div className="p-3 rounded-xl text-[11.5px] flex items-start gap-2"
              style={{ background:"var(--warn-bg)", color:"var(--warn)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                بڕی فرۆشتن لە stock ـی گشتی ئەم دراوە زیاترە ({fmtMoney(data, pos.qty, f.curId)} {cur(f.curId).code}).
                خێر/زەرەر بە دڵنیایی پیشان نادرێت تا تێچووی stock ڕوون بێت.
              </span>
            </div>
          )}
        </Card>
      )}

      {/* وردەکاری */}
      <Card className="p-5 space-y-4">
        {!f.direct && (
          <>
            <div>
              <Lbl>{f.type === "buy" ? tr("لە کوێ دای دەنێیت؟") : tr("لە کوێوە دەفرۆشیت؟")}</Lbl>
              <Sel value={f.partnerId} disabled={custodyLockedByReceipts}
                   onChange={(ev) => setF({ ...f, partnerId: ev.target.value })}>
                {!custodyLockedByReceipts && !cur(f.curId).external && <option value="">{tr("قاسەی گشتی")} — {fmt(calc.atMe[f.curId] || 0, cur(f.curId).dec ?? 0)}</option>}
                {!custodyLockedByReceipts && cur(f.curId).external && <option value="">{tr("— تەرەفێک هەڵبژێرە —")}</option>}
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {fmt((calc.partner[p.id] || {})[f.curId] || 0, cur(f.curId).dec ?? 0)}</option>
                ))}
              </Sel>
              {custodyLockedByReceipts && (
                <div className="text-[11.5px] mt-2" style={{ color: "var(--txt-2)" }}>
                  {tr("ئەم فیشانە پێشتر لای ئەم هاوبەشە دانراون — لە شاشەی کۆمەڵەکەدا دەگۆڕدرێت")}
                </div>
              )}
              {custodyChosenHere && f.partnerId && (
                <div className="text-[11.5px] mt-2" style={{ color: "var(--pos)" }}>
                  {tr("فیشەکانیش هەر بەم لێدانە دەچنە لای ئەم هاوبەشە")}
                </div>
              )}
              {feeRate > 0 && f.type === "buy" && amtR > 0 && (
                <div className="text-[11.5px] mt-2" style={{ color: "var(--warn)" }}>
                  {tr("عمولە")} {feeRate}{tr("٪")} = <b style={num}>{fmtMoney(data, roundMoney(data, amtR * feeRate / 100, f.curId), f.curId)}</b> · {tr("باڵانسی دوایی")} <b style={num}>{fmtMoney(data, amtR - roundMoney(data, amtR * feeRate / 100, f.curId), f.curId)}</b>
                </div>
              )}
              {cur(f.curId).external && !f.partnerId && (
                <div className="text-[11.5px] mt-2 flex items-center gap-1.5" style={{ color: "var(--warn)" }}>
                  <AlertTriangle className="w-3.5 h-3.5" /> {cur(f.curId).name} {tr("لە قاسەی گشتیدا هەڵناگیرێت")}
                </div>
              )}
              {willBeNeg && (
                <div className="text-[11.5px] mt-2 flex items-center gap-1.5" style={{ color: "var(--neg)" }}>
                  <AlertTriangle className="w-3.5 h-3.5" /> {tr("باڵانسەکە دەبێتە سالب")}
                </div>
              )}
            </div>

            <div>
              <Lbl>{tr("دۆخی پارە")}</Lbl>
              <div className="flex gap-2">
                {(f.type === "buy"
                  ? [["completed", tr("پارەم داوە")], ["pending", tr("چاوەڕوانی پارە")]]
                  : [["completed", tr("پارەم وەرگرتووە")], ["pending", tr("چاوەڕوانی وەرگرتن")]]
                ).map(([k, l]) => (
                  <button key={k} onClick={() => setF({ ...f, status: k, officeId: k === "pending" ? f.officeId : "" })}
                    className="flex-1 py-2.5 rounded-[var(--r-sm)] text-[12.5px] font-medium tap"
                    style={f.status === k
                      ? { background: "var(--surf-3)", color: "var(--txt)", border: "1px solid var(--line-2)" }
                      : { color: "var(--txt-3)", border: "1px solid var(--line)" }}>{l}</button>
                ))}
              </div>
            </div>

            {f.type === "buy" && f.status === "pending" && (
              <div>
                <Lbl>{tr("نووسینگەی بەرپرسی پارەدان")}</Lbl>
                <Sel value={f.officeId} onChange={(ev) => setF({ ...f, officeId: ev.target.value })}>
                  <option value="">{tr("هەڵبژێرە...")}</option>
                  {offices.map((office) => <option key={office.id} value={office.id}>{office.name}</option>)}
                </Sel>
                {!offices.length && (
                  <div className="text-[11.5px] mt-2 flex items-center gap-1.5" style={{ color: "var(--neg)" }}>
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {tr("هیچ نووسینگەیەکی چالاک نییە؛ کڕینی پارەنەدراو ناتوانرێت تۆمار بکرێت")}
                  </div>
                )}
              </div>
            )}

            {batch ? (
              <div>
                <Lbl>{tr("لایەنی بەرامبەر")}</Lbl>
                <div className="flex items-center gap-2.5 px-4 py-3 rounded-[var(--r-sm)]"
                  style={{ background: "var(--surf-3)", border: "1px solid var(--line)" }}>
                  <Users className="w-4 h-4 shrink-0" style={{ color: "var(--txt-3)" }} />
                  <span className="text-[14px] font-medium" style={{ color: "var(--txt)" }}>
                    {batch.customer_name || usr(batch.customer_id).name}
                  </span>
                  <span className="text-[10.5px] ms-auto" style={{ color: "var(--txt-3)" }}>{tr("ناگۆڕدرێت")}</span>
                </div>
              </div>
            ) : !lockCp && (
              <div>
                <Lbl>{tr("لایەنی بەرامبەر")}</Lbl>
                <Sel value={f.cpMode} onChange={(ev) => setF({ ...f, cpMode: ev.target.value, cpId: "", cpName: "" })} className="mb-2">
                  <option value="acc">{tr("کڕیارێکی تۆمارکراو")}</option>
                  <option value="free">{tr("ئۆزەر (بێ ئەکاونت)")}</option>
                </Sel>
                {f.cpMode === "acc"
                  ? <Sel value={f.cpId} onChange={(ev) => setF({ ...f, cpId: ev.target.value })}>
                      <option value="">{tr("هەڵبژێرە...")}</option>
                      {customers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </Sel>
                  : <Inp value={f.cpName} onChange={(ev) => setF({ ...f, cpName: ev.target.value })} placeholder={tr("ناو...")} />}
              </div>
            )}
          </>
        )}

        <div>
          <Lbl>{tr("تێبینی")}</Lbl>
          <Inp value={f.note} onChange={(ev) => setF({ ...f, note: ev.target.value })} />
        </div>
      </Card>

      {needsCustodian && (
        <div className="flex items-start gap-2 px-1 text-[12px] font-semibold" style={{ color: "var(--warn)" }}>
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>{cur(f.curId).name} {tr("لە قاسەی گشتیدا هەڵناگیرێت — دیاری بکە پارەکە لای کێ دەمێنێتەوە")}</span>
        </div>
      )}

      {(inventoryRefuses || inventoryDoubts) && (
        <div className="flex items-start gap-2 px-1 text-[12px] font-semibold"
             style={{ color: inventoryRefuses ? "var(--neg)" : "var(--warn)" }}>
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>
            {costBasisMissing
              ? tr("تێچووی ئەم دراوە تەواو نییە — نرخی ڕۆژی ئەو ڕۆژانە دابنێ کە کڕدراون")
              : <>{tr("زیاتر لەوەی هەتە دەفرۆشیت")} — {fmtMoney(data, pos?.qty || 0, f.curId)} {cur(f.curId).code} {tr("هەیە")}</>}
            {inventoryDoubts && ` · ${tr("ئەم ژمارەیە لێرە دەرهێنراوە؛ سێرڤەر بڕیاری کۆتایی دەدات")}`}
          </span>
        </div>
      )}

      <div className="flex gap-2 sticky bottom-24 md:bottom-4">
        <Btn kind={f.direct ? "gold" : f.type === "buy" ? "primary" : "danger"}
          onClick={submit} disabled={sending || busy || needsCustodian || inventoryRefuses} className="flex-1 !py-4 !text-[15px]">
          {sending || busy ? "..." : e ? tr("پاشەکەوتی ئیدیت")
            : f.direct ? tr("تۆمارکردنی مامەڵەی ڕاستەوخۆ")
            : f.type === "buy" ? tr("تۆمارکردنی کڕین") : tr("تۆمارکردنی فرۆشتن")}
        </Btn>
        {e && <Btn kind="ghost" onClick={onCancel} className="!py-4">{tr("پاشگەزبوونەوە")}</Btn>}
      </div>
    </div>
  );
}

/* ══════════════════ فلتەری مامەڵەکان ══════════════════ */
const emptyFilter = { q: "", type: "all", status: "all", cur: "all", from: "", to: "" };

function useTxFilter(list, cur, usr) {
  const [f, setF] = useState(emptyFilter);
  const out = list.filter((t) => {
    if (f.type !== "all" && t.type !== f.type) return false;
    if (f.status === "pending" && t.status !== "pending") return false;
    if (f.status === "completed" && t.status !== "completed") return false;
    if (f.cur !== "all" && t.curId !== f.cur && t.againstId !== f.cur) return false;
    const d = dOnly(t.date);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    if (f.q) {
      const name = t.cpId ? (usr(t.cpId).name || "") : (t.cpName || "");
      const hay = `${t.code || ""} ${name} ${cur(t.curId).code || ""} ${cur(t.againstId).code || ""} ${t.note || ""}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase().replace("#", ""))) return false;
    }
    return true;
  });
  return [out, f, setF];
}

function TxFilterBar({ data, f, setF, count, total }) {
  const [open, setOpen] = useState(false);
  const [scan, setScan] = useState(false);
  const active = JSON.stringify(f) !== JSON.stringify(emptyFilter);
  const quick = (days) => {
    const t = new Date(); const to = t.toISOString().slice(0, 10);
    const x = new Date(t); x.setDate(x.getDate() - days);
    setF({ ...f, from: x.toISOString().slice(0, 10), to });
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-center">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 absolute start-4 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--txt-3)" }} />
          <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder={tr("گەڕان...")}
            className="w-full ps-11 pe-4 py-3 text-[14px] outline-none" style={fieldSty}
            onFocus={onFoc} onBlur={onBlr} />
        </div>
        <button onClick={() => setScan(true)}
          className="w-[46px] h-[46px] rounded-[var(--r-sm)] shrink-0 flex items-center justify-center tap"
          style={{ background: "var(--surf-2)", border: "1px solid var(--line)", color: "var(--txt-2)" }}>
          <Camera className="w-[18px] h-[18px]" />
        </button>
        <button onClick={() => setOpen(!open)}
          className="w-[46px] h-[46px] rounded-[var(--r-sm)] shrink-0 flex items-center justify-center tap"
          style={active
            ? { background: "linear-gradient(170deg, var(--ac), var(--ac-2))", color: "#fff", boxShadow: "0 4px 14px -4px rgba(var(--ac-gl),.5)" }
            : { background: "var(--surf-2)", border: "1px solid var(--line)", color: "var(--txt-2)" }}>
          <SlidersHorizontal className="w-[18px] h-[18px]" />
        </button>
      </div>

      {scan && <Scanner onFound={(v) => {
        try { const j = JSON.parse(v); setF({ ...f, q: String(j.c || v) }); } catch { setF({ ...f, q: v }); }
        setScan(false);
      }} onClose={() => setScan(false)} />}

      {open && (
        <Card className="p-4 space-y-3 drop">
          <div className="grid grid-cols-2 gap-2.5">
            <div><Lbl>{tr("جۆر")}</Lbl><Sel value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="all">{tr("هەمووی")}</option><option value="buy">{tr("کڕین")}</option><option value="sell">{tr("فرۆشتن")}</option></Sel></div>
            <div><Lbl>{tr("دۆخ")}</Lbl><Sel value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="all">{tr("هەمووی")}</option><option value="pending">{tr("چاوەڕوان")}</option><option value="completed">{tr("تەواوکراو")}</option></Sel></div>
            <div><Lbl>{tr("دراو")}</Lbl><Sel value={f.cur} onChange={(e) => setF({ ...f, cur: e.target.value })}>
              <option value="all">{tr("هەمووی")}</option>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div className="flex items-end"><Btn kind="ghost" className="w-full !py-3" onClick={() => setF(emptyFilter)}>{tr("سڕینەوە")}</Btn></div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div><Lbl>{tr("لە بەرواری")}</Lbl><Inp type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
            <div><Lbl>{tr("بۆ بەرواری")}</Lbl><Inp type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {[[tr("ئەمڕۆ"), 0], [tr("٧ ڕۆژ"), 7], [tr("٣٠ ڕۆژ"), 30], [tr("٩٠ ڕۆژ"), 90]].map(([t, d]) => (
              <button key={t} onClick={() => quick(d)} className="px-3.5 py-1.5 rounded-full text-[12px] font-medium tap"
                style={{ background: "var(--glass-2)", color: "var(--txt-2)" }}>{t}</button>
            ))}
          </div>
          {count != null && total && (
            <div className="flex gap-4 flex-wrap pt-2.5 text-[11.5px]" style={{ borderTop: "1px solid var(--line)", color: "var(--txt-3)" }}>
              {Object.entries(total).map(([c, v]) => <span key={c}>{c}: <b style={{ ...num, color: "var(--txt-2)" }}>{fmt(v, 0)}</b></span>)}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* ══════════════════ لیستی مامەڵەکان ══════════════════ */
function TxList({ data, cur, usr, onEdit, onDel, settle, unsettle, loadTxHistoryPage }) {
  const base = [...data.txs].filter((t) => !t.deleted).reverse();
  const [localList, f, setF] = useTxFilter(base, cur, usr);
  const [rows, setRows] = useState([]);
  const [serverMeta, setServerMeta] = useState({ hasMore: false, nextCursor: null, matchedCount: 0, totalsByAgainst: [] });
  const [loading, setLoading] = useState(false);
  const [serverFailed, setServerFailed] = useState(false);
  const [serverErr, setServerErr] = useState("");
  const requestSeq = useRef(0);
  const filterKey = JSON.stringify(f);
  const refreshKey = data?.readModel?.generated_at || data?.txs?.length || 0;
  const serverMode = !!loadTxHistoryPage && !serverFailed;

  const fetchPage = async (reset = false) => {
    if (!loadTxHistoryPage || (!reset && loading)) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    if (reset) setServerErr("");
    try {
      const result = await loadTxHistoryPage({
        limit: 80,
        cursor: reset ? null : serverMeta.nextCursor,
        filters: f,
      });
      if (seq !== requestSeq.current) return;
      setRows((prev) => reset ? result.items : [...prev, ...result.items]);
      setServerMeta({
        hasMore: !!result.hasMore,
        nextCursor: result.nextCursor || null,
        matchedCount: Number(result.matchedCount || 0),
        totalsByAgainst: result.totalsByAgainst || [],
      });
      setServerFailed(false);
    } catch (e) {
      console.error("tx-history-page", e);
      if (seq !== requestSeq.current) return;
      setServerErr(e?.message || "نەتوانرا مێژووی مامەڵەکان لە سێرڤەر بار بکرێت");
      setServerFailed(true); // safe fallback: Phase 13D full history is still in memory.
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!loadTxHistoryPage) return;
    setServerFailed(false);
    const id = setTimeout(() => fetchPage(true), 220);
    return () => clearTimeout(id);
    // loadTxHistoryPage is intentionally omitted: App recreates the wrapper on render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, refreshKey]);

  const list = serverMode ? rows : localList;

  const groups = {};
  list.forEach((t) => { const k = dOnly(t.date); (groups[k] = groups[k] || []).push(t); });
  const today = data.control?.business_date || new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const dayLabel = (k) => k === today ? tr("ئەمڕۆ") : k === yest ? tr("دوێنێ")
    : new Date(k).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });

  const total = {};
  if (serverMode && Array.isArray(serverMeta.totalsByAgainst)) {
    serverMeta.totalsByAgainst.forEach((x) => {
      const code = cur(x.against_id).code || x.against_id || "?";
      total[code] = Number(x.amount) || 0;
    });
  } else {
    localList.forEach((t) => { total[cur(t.againstId).code || "?"] = (total[cur(t.againstId).code || "?"] || 0) + t.total; });
  }

  const matchedCount = serverMode ? serverMeta.matchedCount : localList.length;

  return (
    <div className="space-y-4">
      <H sub={`${matchedCount} ${tr("مامەڵە")}`}>{tr("مامەڵەکان")}</H>
      <TxFilterBar data={data} f={f} setF={setF} count={matchedCount} total={total} />
      {serverErr && !serverMode && (
        <Card className="p-3 text-[11px]" style={{ color: "var(--warn)" }}>
          مێژووی server-side بەردەست نەبوو؛ fallback ـی تەواوی Phase 13D بەکار هات.
        </Card>
      )}
      {list.length === 0 && !loading ? <Card className="p-2"><Empty t={tr("هیچ مامەڵەیەک نەدۆزرایەوە")} /></Card> :
        Object.entries(groups).map(([day, items], gi) => (
          <div key={day} className="rise" style={{ animationDelay: `${Math.min(gi, 6) * 45}ms` }}>
            <div className="flex items-center gap-3 mb-1.5 px-1">
              <span className="text-[11.5px] font-semibold" style={{ color: "var(--txt-3)" }}>{dayLabel(day)}</span>
              <span className="flex-1 h-px" style={{ background: "var(--line)" }} />
              <span className="text-[11px]" style={{ color: "var(--txt-3)" }}>{items.length}</span>
            </div>
            <Card className="px-1 py-1">
              {items.map((t, i) => (
                <div key={t.id} style={i ? { borderTop: "1px solid var(--line)" } : {}}>
                  <TxRow t={t} cur={cur} usr={usr} onEdit={onEdit} onDel={onDel} settle={settle} unsettle={unsettle} />
                </div>
              ))}
            </Card>
          </div>
        ))}
      {serverMode && (
        <div className="flex justify-center">
          {serverMeta.hasMore ? (
            <Btn kind="ghost" onClick={() => fetchPage(false)} disabled={loading}>
              {loading ? "..." : "زیاتر باربکە"}
            </Btn>
          ) : rows.length > 0 ? (
            <span className="text-[10.5px]" style={{ color: "var(--txt-3)" }}>کۆتایی مێژوو</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* flip = بینینی مامەڵەکە لە ڕوانگەی لایەنی بەرامبەرەوە / lite = بێ وردەکاری ناوخۆیی */
function TxRow({ t, cur, usr, onEdit, onDel, flip, lite, settle, unsettle }) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState(false);
  const name = t.cpId ? (usr(t.cpId).name || t.cpName) : t.cpName;
  const shown = flip ? (t.type === "buy" ? "sell" : "buy") : t.type;
  const pend = t.status === "pending";
  const isBuy = shown === "buy";

  return (
    <div className="rounded-[var(--r-sm)]" style={{ background: open ? "var(--surf-2)" : "transparent" }}>
      <div onClick={() => setOpen(!open)} className="flex items-center gap-3 py-3 px-2 cursor-pointer tap">
        <span className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
          style={{ background: t.direct ? "var(--warn-bg)" : isBuy ? "var(--pos-bg)" : "var(--neg-bg)" }}>
          {t.direct
            ? <Zap className="w-[17px] h-[17px]" style={{ color: "var(--warn)" }} />
            : isBuy
              ? <ArrowDownLeft className="w-[18px] h-[18px]" style={{ color: "var(--pos)" }} />
              : <ArrowUpRight className="w-[18px] h-[18px]" style={{ color: "var(--neg)" }} />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium truncate" style={{ color: "var(--txt)" }}>
              {lite ? (isBuy ? tr("کڕین") : tr("فرۆشتن")) : (name || (isBuy ? tr("کڕین") : tr("فرۆشتن")))}
            </span>
            {pend && <span className="w-1.5 h-1.5 rounded-full shrink-0 breathe" style={{ background: "var(--warn)" }} />}
          </div>
          <div className="text-[11.5px] mt-0.5 truncate" style={{ color: "var(--txt-3)" }}>
            <span style={num}>{fmt(t.amount, cur(t.curId).dec ?? 0)}</span> {cur(t.curId).code}
            {t.partnerId && !lite ? " · " + usr(t.partnerId).name : ""}
          </div>
        </div>

        <div className="text-end shrink-0">
          <div className="text-[15px] font-semibold" style={{ ...num, color: isBuy ? "var(--pos)" : "var(--neg)" }}>
            {isBuy ? "−" : "+"}{fmt(t.total, cur(t.againstId).dec ?? 0)}
          </div>
          <div className="text-[10.5px] mt-0.5" style={{ color: "var(--txt-3)" }}>{cur(t.againstId).code}</div>
          {Number.isFinite(Number(t.profit)) && !lite && (
            <div className="text-[10.5px] mt-1 font-semibold" style={{ ...num, color: t.profit >= 0 ? "var(--pos)" : "var(--neg)" }}>
              {Number(t.profit) >= 0 ? "+" : "−"}{fmt(Math.abs(Number(t.profit)), cur(t.profitCurId || t.againstId).dec ?? 0)} {cur(t.profitCurId || t.againstId).code} {t.profit >= 0 ? tr("خێر") : tr("زەرەر")}
            </div>
          )}
        </div>
      </div>

      {qr && <TxReceipt t={t} cur={cur} usr={usr} onClose={() => setQr(false)} />}
      {open && (
        <div className="px-3 pb-3 drop">
          <div className="rounded-[var(--r-sm)] p-3.5 space-y-2.5" style={{ background: "var(--surf-3)" }}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {t.code ? <D k={tr("کۆد")} v={"#" + t.code} /> : null}
              {(() => {
                const baseId = preferredRateBaseId(t.curId, t.againstId);
                const quoteId = oppositePairId(t.curId, t.againstId, baseId);
                const shown = storedRateToDisplay(t.rate, t.curId, t.againstId, baseId);
                const buyShown = t.buyRate ? storedRateToDisplay(t.buyRate, t.curId, t.againstId, baseId) : null;
                return (
                  <>
                    <D k={tr("ڕەیت")} v={shown ? `1 ${cur(baseId).code} = ${fmt(shown, rateDigits(shown))} ${cur(quoteId).code}` : "—"} />
                    {t.direct && buyShown ? <D k={tr("بە چەند دەیکڕم")} v={`1 ${cur(baseId).code} = ${fmt(buyShown, rateDigits(buyShown))} ${cur(quoteId).code}`} /> : null}
                  </>
                );
              })()}
              {!lite && t.profit != null ? (
                <D
                  k={t.profit >= 0 ? tr("خێر") : tr("زەرەر")}
                  v={`${t.profit >= 0 ? "+" : "−"}${fmt(Math.abs(t.profit), cur(t.profitCurId || t.againstId).dec ?? 0)} ${cur(t.profitCurId || t.againstId).code}`}
                  tone={t.profit >= 0 ? "pos" : "neg"}
                />
              ) : null}
              {!lite && t.partnerId ? <D k={tr("لای")} v={usr(t.partnerId).name} /> : null}
              <D k={tr("بەروار")} v={new Date(t.date).toLocaleDateString("en-GB")} />
              <D k={tr("کات")} v={new Date(t.date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} />
            </div>

            {pend ? (
              <div className="pt-2.5" style={{ borderTop: "1px solid var(--line)" }}>
                <Pill tone="amber">
                  {flip ? (t.type === "buy" ? tr("چاوەڕوانی وەرگرتنی پارە") : tr("چاوەڕوانی پارەدان"))
                        : (t.type === "buy" ? tr("پارە نەدراوە") : tr("پارە وەرنەگیراوە"))}
                </Pill>
              </div>
            ) : null}

            <div className="flex gap-2 pt-2.5 flex-wrap" style={{ borderTop: "1px solid var(--line)" }}>
              <button onClick={(e) => { e.stopPropagation(); setQr(true); }}
                className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-full tap"
                style={{ background: "var(--glass-2)", color: "var(--txt-2)" }}>
                <QrCode className="w-3.5 h-3.5" /> {tr("وەسڵ")}
              </button>
              {pend && settle ? (
                <button onClick={(e) => { e.stopPropagation(); settle(t); }}
                  className="flex items-center gap-1.5 text-[12.5px] font-semibold px-3.5 py-2 rounded-full tap"
                  style={{ background: "var(--pos-bg)", color: "var(--pos)" }}>
                  <CheckCircle2 className="w-3.5 h-3.5" /> {t.type === "buy" ? tr("پارەکەم دا") : tr("پارەکەم وەرگرت")}
                </button>
              ) : null}
              {!pend && t.paidAt && unsettle ? (
                <button onClick={(e) => { e.stopPropagation(); unsettle(t); }}
                  className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-full tap"
                  style={{ color: "var(--txt-3)" }}>
                  <RotateCcw className="w-3.5 h-3.5" /> {tr("هەڵوەشاندنەوەی پارەدان")}
                </button>
              ) : null}
              {onEdit ? (
                <button onClick={(e) => { e.stopPropagation(); onEdit(t); }}
                  className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-full tap"
                  style={{ background: "var(--glass-2)", color: "var(--txt-2)" }}>
                  <Pencil className="w-3.5 h-3.5" /> {tr("ئیدیت")}
                </button>
              ) : null}
              {onDel ? (
                <button onClick={(e) => { e.stopPropagation(); onDel(t); }}
                  className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-full tap"
                  style={{ color: "var(--neg)" }}>
                  <RotateCcw className="w-3.5 h-3.5" /> {tr("هەڵوەشاندنەوە")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* وەسڵی مامەڵە — بۆ پیشاندان بە کڕیار */
function TxReceipt({ t, cur, usr, onClose }) {
  const name = t.cpId ? (usr(t.cpId).name || t.cpName) : t.cpName;
  const payload = JSON.stringify({
    c: t.code, t: t.type, a: t.amount, cu: cur(t.curId).code,
    v: t.total, ag: cur(t.againstId).code, d: dOnly(t.date),
  });
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-6"
      style={{ background: "rgba(0,0,0,.6)", backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="w-full sm:max-w-[340px] rounded-t-[28px] sm:rounded-[26px] overflow-hidden sheet"
        style={{ background: "var(--surf)", boxShadow: "var(--sh-3)" }} onClick={(e) => e.stopPropagation()}>

        <div className="px-6 pt-6 pb-5 text-center relative aura">
          <button onClick={onClose} className="absolute top-4 end-4 p-1.5 tap" style={{ color: "var(--txt-3)" }}>
            <X className="w-4 h-4" />
          </button>
          <div className="text-[11px] mb-1" style={{ color: "var(--txt-3)" }}>
            {t.type === "buy" ? tr("کڕین") : tr("فرۆشتن")}{t.code ? ` · #${t.code}` : ""}
          </div>
          <div className="text-[32px] font-semibold" style={{ ...num, color: "var(--txt)", letterSpacing: "-.03em" }}>
            {fmt(t.amount, 0)}
          </div>
          <div className="text-[13px]" style={{ color: "var(--txt-2)" }}>{cur(t.curId).name}</div>
        </div>

        <div className="px-6 pb-5 space-y-2.5">
          {(() => {
            const baseId = preferredRateBaseId(t.curId, t.againstId);
            const quoteId = oppositePairId(t.curId, t.againstId, baseId);
            const shown = storedRateToDisplay(t.rate, t.curId, t.againstId, baseId);
            return [[tr("لایەن"), name],
              [tr("ڕەیت"), shown ? `1 ${cur(baseId).code} = ${fmt(shown, rateDigits(shown))} ${cur(quoteId).code}` : "—"],
              [tr("کۆی گشتی"), `${fmt(t.total, cur(t.againstId).dec || 0)} ${cur(t.againstId).code}`],
              [tr("بەروار"), new Date(t.date).toLocaleString("en-GB")]];
          })().map(([k, v], i) => (
            <div key={i} className="flex justify-between text-[13px]">
              <span style={{ color: "var(--txt-3)" }}>{k}</span>
              <span className="font-semibold" style={{ ...num, color: "var(--txt)" }}>{v || "—"}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center gap-3 px-6 pb-6 pt-5"
          style={{ borderTop: "1px dashed var(--line-2)" }}>
          <QR text={payload} size={168} />
          <div className="text-[10.5px] text-center" style={{ color: "var(--txt-3)" }}>
            {tr("ئەم کۆدە وەسڵی ئەم مامەڵەیەیە")}
          </div>
        </div>
      </div>
    </div>
  );
}

const D = ({ k, v, tone }) => (
  <div>
    <div className="text-[10.5px]" style={{ color: "var(--txt-3)" }}>{k}</div>
    <div className="text-[13px] font-semibold mt-0.5"
      style={{ ...num, color: tone === "pos" ? "var(--pos)" : tone === "neg" ? "var(--neg)" : "var(--txt)" }}>{v}</div>
  </div>
);

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const durationTextToMs = (value) => {
  const s = String(value || "").trim();
  if (!s) return 0;
  let total = 0;
  const re = /([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)/gi;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === "ms") total += n;
    else if (unit === "s") total += n * 1000;
    else if (unit === "m") total += n * 60000;
    else if (unit === "h") total += n * 3600000;
  }
  return Math.ceil(total);
};

const ocrPaceAfterResult = (d) => {
  const meta = d?._meta || {};
  const provider = String(meta.provider || "").toLowerCase();

  // Groq exposes the token-bucket reset window in response headers.
  // Waiting through that window is deliberately conservative for free-tier OCR batches.
  if (provider === "groq") {
    const resetMs = durationTextToMs(meta.resetTokens);
    return Math.max(5000, Math.min(15000, resetMs ? resetMs + 500 : 7000));
  }

  // Fallback providers still get a small gap so a retry batch cannot burst.
  if (provider === "gemini" || provider === "claude") return 1800;
  return 2500;
};

const clamp01 = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};
const bytesToBase64 = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
};

const OCR_MAX_BINARY_BYTES = 2_500_000;
const OCR_MAX_BASE64_CHARS = 3_500_000;

const canvasToJpeg = (canvas, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

async function prepImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { bmp = await createImageBitmap(file); }

  // Keep enough detail for tiny receipt text while staying below Vercel's function payload ceiling.
  const MAX_SIDE = 2200;
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  let cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(bmp.width * scale));
  cv.height = Math.max(1, Math.round(bmp.height * scale));

  const draw = (canvas, source) => {
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  };

  draw(cv, bmp);
  bmp.close?.();

  let quality = 0.92;
  let blob = await canvasToJpeg(cv, quality);
  if (!blob) throw new Error("نەتوانرا وێنەکە ئامادە بکرێت");

  // First preserve resolution and gently reduce JPEG quality.
  while (blob.size > OCR_MAX_BINARY_BYTES && quality > 0.72) {
    quality = Math.max(0.72, quality - 0.06);
    blob = await canvasToJpeg(cv, quality);
    if (!blob) throw new Error("نەتوانرا وێنەکە ئامادە بکرێت");
  }

  // If the image is still too large, reduce dimensions in controlled steps.
  let resizePass = 0;
  while (blob.size > OCR_MAX_BINARY_BYTES && Math.max(cv.width, cv.height) > 1350 && resizePass < 3) {
    const ratio = Math.max(0.72, Math.min(0.9, Math.sqrt(OCR_MAX_BINARY_BYTES / blob.size) * 0.95));
    const smaller = document.createElement("canvas");
    smaller.width = Math.max(1, Math.round(cv.width * ratio));
    smaller.height = Math.max(1, Math.round(cv.height * ratio));
    draw(smaller, cv);
    cv = smaller;
    quality = 0.82;
    blob = await canvasToJpeg(cv, quality);
    if (!blob) throw new Error("نەتوانرا وێنەکە ئامادە بکرێت");
    resizePass += 1;
  }

  // Final guarded encoding leaves headroom for JSON/base64 overhead.
  if (blob.size > OCR_MAX_BINARY_BYTES) {
    blob = await canvasToJpeg(cv, 0.68);
    if (!blob) throw new Error("نەتوانرا وێنەکە ئامادە بکرێت");
  }

  const buf = await blob.arrayBuffer();
  // Fingerprint the exact normalized bytes that are read by OCR and persisted.
  // This lets the server bind its signed OCR evidence to the stored object.
  const hb = await crypto.subtle.digest("SHA-256", buf.slice(0));
  const hash = [...new Uint8Array(hb)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const b64 = bytesToBase64(new Uint8Array(buf));
  if (b64.length > OCR_MAX_BASE64_CHARS) {
    throw new Error("قەبارەی وێنەکە زۆر گەورەیە — تکایە وێنەکە crop بکە یان دووبارە وێنەی بگرە");
  }

  return {
    b64,
    hash,
    blob,
    mediaType: "image/jpeg",
    width: cv.width,
    height: cv.height,
    url: URL.createObjectURL(blob),
  };
}

const isTemporaryOcrError = (e) => {
  const s = Number(e?.status);
  return [429, 502, 503, 504].includes(s) ||
    /quota|rate limit|سنووری API|timed out|درێژەی کێشا|temporar|gateway|service unavailable/i.test(String(e?.message || ""));
};

const ocrRetryNote = (e, prefix = "خزمەتگوزاری خوێندنەوە کاتێک بەردەست نییە") => {
  const sec = Number(e?.retryAfterSeconds);
  return `${prefix} — فیشەکە ڕەت نەکراوەتەوە${sec > 0 ? `؛ نزیکەی ${Math.ceil(sec)} چرکەی تر دووبارە هەوڵ بدە` : "؛ کەمێک دواتر دووبارە هەوڵ بدە"}`;
};

const normRef = (r) => String(r || "").replace(/[\s\-_.]/g, "").toUpperCase();
const DIR_KU = { in: "پارە هاتووە", out: "پارە نێردراوە" };
const PLATFORMS = {
  Alipay:   { ku: "ئەلی پەی", cls: "bg-blue-50 text-blue-800 border-blue-200" },
  WeChat:   { ku: "وی چات",  cls: "bg-[color-mix(in_srgb,var(--pos)_10%,transparent)] text-[var(--pos)] border-[color-mix(in_srgb,var(--pos)_26%,transparent)]" },
  Bank:     { ku: "بانک",     cls: "bg-slate-50 text-[var(--txt)] border-slate-200" },
  FIB:      { ku: "FIB",      cls: "bg-violet-50 text-violet-800 border-violet-200" },
  FastPay:  { ku: "FastPay",  cls: "bg-[color-mix(in_srgb,var(--warn)_11%,transparent)] text-[var(--warn)] border-[color-mix(in_srgb,var(--warn)_26%,transparent)]" },
  ZainCash: { ku: "Zain Cash", cls: "bg-[color-mix(in_srgb,var(--neg)_10%,transparent)] text-[var(--neg)] border-[color-mix(in_srgb,var(--neg)_26%,transparent)]" },
  NassWallet:{ ku: "NassWallet", cls: "bg-sky-50 text-sky-800 border-sky-200" },
  QiCard:    { ku: "Qi Card", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
};
const platMeta = (p) => PLATFORMS[p] || { ku: p || "نەزانراو", cls: "bg-[var(--line)] text-[var(--txt-2)] border-[var(--line)]" };
const detectPlatform = (bank) => {
  const b = String(bank || "").toLowerCase();
  if (/alipay|支付宝/.test(b)) return "Alipay";
  if (/wechat|weixin|微信/.test(b)) return "WeChat";
  if (/\bfib\b/.test(b)) return "FIB";
  if (/fastpay/.test(b)) return "FastPay";
  if (/zain/.test(b)) return "ZainCash";
  if (/nass|ناس/.test(b)) return "NassWallet";
  if (/qi\s*card|qicard|کی\s*کارد|قي\s*كارد/.test(b)) return "QiCard";
  if (/bank|بانک|مصرف/.test(b)) return "Bank";
  return null;
};
const REJECT_KU = {
  no_ref: "ژمارەی مامەڵەی نییە",
  same_image: "هەمان وێنە پێشتر ناردراوە",
  same_ref: "هەمان ژمارەی مامەڵە پێشتر تۆمار کراوە",
  same_batch: "لەم کۆمەڵەیەدا دووبارە بووەتەوە",
  same_amount_time: "هەمان بڕ لە هەمان کاتدا",
  old_date: "ڕێکەوتی کۆن",
  unreadable: "نەخوێندرایەوە",
  not_receipt: "فیشی پارەدان نییە",
  tampered: "نیشانەی دەستکاری تێدایە",
  low_confidence: "خوێندنەوەکە دڵنیا نییە",
  possible_duplicate: "گومانی دووبارەبوونەوە",
  manual_reject: "بە دەست ڕەتکرایەوە",
  missing_required: "زانیاری گرنگ کەمە",
  api_retry: "چاوەڕوانی دووبارە خوێندنەوە",
};

function ReceiptImg({ path, className }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!path) return;
    supabase.storage.from("receipts").createSignedUrl(path, 3600)
      .then(({ data }) => { if (alive && data) setUrl(data.signedUrl); }).catch(() => {});
    return () => { alive = false; };
  }, [path]);
  if (!url) return <div className={`bg-[var(--line)] animate-pulse ${className}`} />;
  return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={tr("فیش")} className={className} /></a>;
}

/* ─────────── کۆکردنەوەی فیشەکان — بە فی و بێ فی ─────────── */
function ReceiptTotals({ rows, data, title, compact, showValuation = true }) {
  // The uploader is shown what their receipts say and nothing else. A valuation in another
  // currency is a bookkeeping decision that has not been made yet; it arrives with the
  // transaction, once the operator has made one.
  const u = showValuation ? usdConv(data) : () => null;
  const counted = (rows || []).filter((r) => r.counted !== false && r.status !== "dup" && r.status !== "error");
  const rejected = (rows || []).filter((r) => r.counted === false || r.status === "dup" || r.status === "error");
  const gross = {}, fees = {}, net = {}, byPlat = {};
  counted.forEach((r) => {
    const c = r.currency || "?";
    const g = +(r.amount) || 0, f = +(r.fee) || 0;
    const n = r.net != null ? +r.net : (r.net_amount != null ? +r.net_amount : g - f);
    gross[c] = (gross[c] || 0) + g; fees[c] = (fees[c] || 0) + f; net[c] = (net[c] || 0) + n;
    const pl = r.platform || detectPlatform(r.bank) || tr("نەزانراو");
    byPlat[pl] = byPlat[pl] || { n: 0, cur: {} };
    byPlat[pl].n++; byPlat[pl].cur[c] = (byPlat[pl].cur[c] || 0) + n;
  });
  const curs = Object.keys(gross);
  // Who was paid, how many times, and how much — from the tested grouping rather than a second
  // copy of it here, so the figure on the screen and the figure under test are the same figure.
  const { recipients } = recipientSummary(counted);
  const platList = Object.entries(byPlat).sort((a, b) => b[1].n - a[1].n);
  // A headline states one number in one currency, so it may only appear when there *is* one
  // currency. A batch holding yuan and dollars used to headline whichever came first, which
  // read as a conversion nobody made — "I sent yuan, why does it show dollars?". Mixed sets
  // get a plain strip instead: every currency, side by side, none of them presented as the total.
  const soleCur = curs.length === 1 ? curs[0] : null;

  return (
    <>
      {soleCur && (
        <div className="relative pt-3 pb-1 aura">
          <Hero label={title || tr("گەیشتوو (بێ فی)")}
            value={fmtMoney(data, net[soleCur], soleCur)} unit={soleCur}
            sub={`${counted.length} ${tr("فیش")}${fees[soleCur] > 0 ? ` · ${tr("فی")} ${fmtMoney(data, fees[soleCur], soleCur)}` : ""}${u(net[soleCur], soleCur) != null ? ` · ≈ ${fmt(u(net[soleCur], soleCur), 2)} $` : ""}`} />
        </div>
      )}

      {curs.length > 1 && (
        <div className="pt-3 pb-1">
          <div className="text-[11px] mb-2 px-1" style={{ color: "var(--txt-3)" }}>
            {title || tr("گەیشتوو (بێ فی)")} · {counted.length} {tr("فیش")} · {curs.length} {tr("دراو")}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {curs.map((c) => (
              <Card key={c} className="px-3 py-2.5 shrink-0 min-w-[132px]">
                <div className="flex items-center gap-1.5 mb-1">
                  <CurBadge c={(data?.currencies || []).find((x) => x.code === c)} size="sm" />
                  <span className="text-[11px] font-semibold" style={{ color: "var(--txt-3)" }}>{c}</span>
                </div>
                <div className="text-[18px] font-semibold" style={{ ...num, color: "var(--pos)" }}>
                  {fmtMoney(data, net[c], c)}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {curs.length > 0 && (
        <Card className="px-4 py-2">
          {curs.map((c, i) => (
            <div key={c} className="py-3" style={i ? { borderTop: "1px solid var(--line)" } : {}}>
              <div className="flex items-center gap-2 mb-2.5">
                <CurBadge c={(data?.currencies || []).find((x) => x.code === c)} size="sm" />
                <span className="text-[12px] font-semibold" style={{ color: "var(--txt-2)" }}>{c}</span>
              </div>
              <div className="flex justify-between text-[13px] py-1">
                <span style={{ color: "var(--txt-3)" }}>{tr("کۆی گشتی (بە فییەوە)")}</span>
                <span style={{ ...num, color: "var(--txt-2)" }}>{fmtMoney(data, gross[c], c)}</span>
              </div>
              <div className="flex justify-between text-[13px] py-1">
                <span style={{ color: "var(--txt-3)" }}>{tr("فی")}</span>
                <span style={{ ...num, color: fees[c] ? "var(--neg)" : "var(--txt-3)" }}>
                  {fees[c] ? "−" + fmtMoney(data, fees[c], c) : fmtMoney(data, 0, c)}
                </span>
              </div>
              <div className="flex justify-between items-baseline pt-2.5 mt-1" style={{ borderTop: "1px solid var(--line)" }}>
                <span className="text-[13px] font-semibold" style={{ color: "var(--txt)" }}>{tr("گەیشتوو (بەبێ فی)")}</span>
                <span className="text-[20px] font-semibold" style={{ ...num, color: "var(--pos)" }}>{fmtMoney(data, net[c], c)}</span>
              </div>
            </div>
          ))}
        </Card>
      )}

      {!compact && platList.length > 1 && (
        <Card className="px-4 py-2">
          <div className="pt-2"><SecLbl>{tr("بەپێی پلاتفۆرم")}</SecLbl></div>
          {platList.map(([pl, v]) => (
            <Row key={pl} title={platMeta(pl).ku} sub={`${v.n} ${tr("فیش")}`}
              right={Object.entries(v.cur).map(([c, a]) => `${fmtMoney(data, a, c)} ${c}`).join(" / ")} />
          ))}
        </Card>
      )}

      {!compact && recipients.length > 0 && (
        <Card className="px-4 py-2">
          <div className="pt-2"><SecLbl>{tr("بەپێی وەرگر")}</SecLbl></div>
          {recipients.map((w) => (
            <Row key={w.name} title={w.name} sub={`${w.count} ${tr("فیش")}`}
              right={Object.entries(w.byCurrency).map(([c, a]) => `${fmtMoney(data, a.withoutFee, c)} ${c}`).join(" / ")}
              rightSub={Object.entries(w.byCurrency).map(([c, a]) => u(a.withoutFee, c) != null ? `≈ ${fmt(u(a.withoutFee, c), 0)} $` : null).filter(Boolean)[0]} />
          ))}
        </Card>
      )}

      {rejected.length > 0 && (
        <div className="text-[12px] px-1" style={{ color: "var(--neg)" }}>
          {rejected.length} {tr("فیش ڕەت کراوەتەوە — هەژمار نەکراون")}
        </div>
      )}
    </>
  );
}

/* ─────────── فیشە ڕەتکراوەکان — بە هۆکارەوە ─────────── */
function RejectedReceipts({ rows, data, title = "فیشە ڕەتکراوەکان" }) {
  const bad = (rows || []).filter((r) => r.counted === false || r.status === "dup" || r.status === "error");
  const [open, setOpen] = useState(false);
  if (!bad.length) return null;

  // کۆکردنەوە بەپێی هۆکار
  const byCode = {};
  bad.forEach((r) => { const k = r.reject_code || r.rejectCode || "other"; byCode[k] = (byCode[k] || 0) + 1; });

  return (
    <Card className="p-5 border-[color-mix(in_srgb,var(--neg)_34%,transparent)] bg-[color-mix(in_srgb,var(--neg)_8%,transparent)]">
      <button onClick={() => setOpen(!open)} className="w-full text-right">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-bold text-[var(--neg)]">
              <AlertTriangle className="w-4 h-4" /> {title}
            </div>
            <div className="text-xs text-[var(--neg)]/80 mt-1.5" style={num}>
              {bad.length} فیش هەژمار نەکراون
            </div>
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {Object.entries(byCode).map(([k, n]) => (
                <Pill key={k} tone="red">{REJECT_KU[k] || "هۆکاری تر"} ({n})</Pill>
              ))}
            </div>
          </div>
          <ChevronLeft className={`w-5 h-5 text-rose-400 transition-transform shrink-0 ${open ? "-rotate-90" : "rotate-180"}`} />
        </div>
      </button>

      {open && (
        <div className="mt-4 pt-4 border-t border-[color-mix(in_srgb,var(--neg)_26%,transparent)] space-y-2.5">
          {bad.map((r) => (
            <div key={r.id} className="bg-[var(--surf)] rounded-[var(--r-sm)] border border-[color-mix(in_srgb,var(--neg)_26%,transparent)] p-3">
              <div className="flex gap-3">
                {r.image_path
                  ? <ReceiptImg path={r.image_path} className="w-16 h-16 object-cover rounded-lg border border-[var(--line)] shrink-0 opacity-70" />
                  : r.url
                    ? <img src={r.url} alt="" className="w-16 h-16 object-cover rounded-lg border border-[var(--line)] shrink-0 opacity-70" />
                    : <div className="w-16 h-16 bg-[var(--line)] rounded-lg shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-base font-bold text-[var(--txt-3)] line-through" style={num}>
                      {r.amount ? fmtMoney(data, r.net_amount ?? r.net ?? r.amount, r.currency) : "—"}
                    </span>
                    <span className="text-xs text-[var(--txt-3)]">{r.currency || ""}</span>
                    <Pill tone="red">{tr("هەژمار نەکراوە")}</Pill>
                  </div>
                  <div className="mt-1.5 text-xs text-[var(--neg)] bg-[color-mix(in_srgb,var(--neg)_10%,transparent)] rounded-lg px-2.5 py-1.5 leading-relaxed">
                    <b>{tr("هۆکار:")}</b> {r.reject_reason || r.rejectReason || r.note || tr("نەزانراو")}
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-[var(--txt-2)]">
                    {(r.ref_no || r.refNo) && <div style={num}>{tr("ژمارەی مامەڵە:")} <b>{r.ref_no || r.refNo}</b></div>}
                    {(r.tx_time || r.txTime) && <div>{tr("کاتی مامەڵە:")} <b>{r.tx_time || r.txTime}</b></div>}
                    {(r.receiver) && <div>{tr("وەرگر:")} <b>{r.receiver}</b></div>}
                    {(r.sender) && <div>{tr("ناردەر:")} <b>{r.sender}</b></div>}
                    {(r.bank) && <div>{tr("ئەپ/بانک:")} <b>{r.bank}</b></div>}
                    {r.created_at && <div style={num}>{tr("کاتی ناردن:")} <b>{new Date(r.created_at).toLocaleString("en-GB")}</b></div>}
                  </div>
                  {(r.dup_of_date || r.dupOfDate) && (
                    <div className="mt-1.5 text-[11px] text-[var(--txt-2)] bg-[var(--line)] rounded-lg px-2.5 py-1.5">
                      {tr("فیشە ڕەسەنەکە:")} <b style={num}>{new Date(r.dup_of_date || r.dupOfDate).toLocaleString("en-GB")}</b>
                      {(r.dup_of_who || r.dupOfWho) && <> · لەلایەن <b>{r.dup_of_who || r.dupOfWho}</b></>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ─────────── لیستی فیشەکان + گەلەری ─────────── */
function ReceiptList({ rows, showFrom }) {
  const [view, setView] = useState("list");
  const all = rows || [];
  rows = all.filter((r) => r.counted !== false && r.status !== "dup" && r.status !== "error");
  if (!all.length) return <Card className="p-2"><Empty t={tr("هیچ فیشێک نییە")} /></Card>;
  if (!rows.length) return <Card className="p-2"><Empty t={tr("هەموو فیشەکان ڕەت کراونەتەوە")} /></Card>;
  return (
    <div className="space-y-3">
      <Tabs items={[["list", tr("وردەکاری")], ["gallery", tr("وێنەکان")]]} value={view} onChange={setView} />
      {view === "gallery" ? (
        <div className="grid grid-cols-3 gap-2">
          {rows.filter((r) => r.image_path).map((r) => (
            <div key={r.id} className="relative rise rounded-[var(--r-sm)] overflow-hidden">
              <ReceiptImg path={r.image_path} className="w-full aspect-square object-cover" />
              <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 text-[10.5px] font-semibold text-white text-center"
                style={{ background: "linear-gradient(0deg, rgba(0,0,0,.85), transparent)", ...num }}>
                {fmt(r.net_amount ?? r.amount, currencyDecimals(null, r.currency))}
              </div>
            </div>
          ))}
          {rows.filter((r) => r.image_path).length === 0 && <div className="col-span-full"><Empty t={tr("هیچ وێنەیەک نییە")} /></div>}
        </div>
      ) : (
        <Card className="px-3 py-1">
          {rows.map((r, i) => (
            <div key={r.id} className="flex items-center gap-3 py-3"
              style={i ? { borderTop: "1px solid var(--line)" } : {}}>
              {r.image_path
                ? <ReceiptImg path={r.image_path} className="w-11 h-11 object-cover rounded-[10px] shrink-0" />
                : <div className="w-11 h-11 rounded-[10px] shrink-0" style={{ background: "var(--surf-3)" }} />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[14px] font-semibold" style={{ ...num, color: "var(--txt)" }}>
                    {fmt(r.net_amount ?? r.amount, currencyDecimals(null, r.currency))}
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--txt-3)" }}>{r.currency}</span>
                  {r.fee > 0 && <span className="text-[10px]" style={{ ...num, color: "var(--txt-3)" }}>+{fmt(r.fee, currencyDecimals(null, r.currency))}</span>}
                  {(r.platform || detectPlatform(r.bank)) && (() => {
                    const m = platMeta(r.platform || detectPlatform(r.bank));
                    return <span className="px-2 py-0.5 rounded-full text-[9.5px] font-bold"
                      style={{ background: "var(--glass-2)", color: "var(--txt-2)" }}>{m.ku}</span>;
                  })()}
                </div>
                <div className="text-[11px] mt-0.5 truncate" style={{ color: "var(--txt-3)" }}>
                  {showFrom && r.customer_name ? r.customer_name + " → " : ""}{r.receiver || "—"}
                </div>
                <div className="text-[10px] mt-0.5 truncate" style={{ ...num, color: "var(--txt-3)" }}>
                  {r.ref_no || "—"} · {r.tx_time || new Date(r.created_at).toLocaleDateString("en-GB")}
                </div>
                {/* The name the person who sent it can quote down a phone. Both sides read the
                    same one — it is the intake document's, not a second one minted here. */}
                {r.tracking_code && (
                  <div className="text-[10px] mt-0.5 truncate font-mono" style={{ color: "var(--txt-3)" }}>
                    {r.tracking_code}
                  </div>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

/* ─────────── ئەپلۆدکەری فیش ─────────── */
function ReceiptUploader({ customerId, customerName, partnerId, uploaderId, direction = "in", onDone, flash, data, allowDirection, simple = false, staffReview = false, role, adminOverrideReason = null }) {
  const [rows, setRows] = useState([]);
  const rowsRef = useRef([]);
  // A customer-seller sells to the house: their evidence is always money that arrived for them.
  // Offering them the other direction invites a receipt the house is not buying, booked the
  // wrong way round. Staff still choose, because staff record both sides of the counter.
  const allowedDirections = uploadDirectionsFor(role);
  const mayChooseDirection = !!allowDirection && allowedDirections.length > 1;
  const [dir, setDir] = useState(allowedDirections.includes(direction) ? direction : allowedDirections[0]);
  const [working, setWorking] = useState(false);
  const [prog, setProg] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [share, setShare] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [reviewTab, setReviewTab] = useState("all");
  const [reviewSearch, setReviewSearch] = useState("");
  const [reviewPlatform, setReviewPlatform] = useState("all");
  const [selectedRows, setSelectedRows] = useState([]);
  const [inspectorId, setInspectorId] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [intakeSource, setIntakeSource] = useState("app");
  const cameraInputRef = useRef(null);
  const galleryInputRef = useRef(null);
  const shareInputRef = useRef(null);
  const receiptCommandRef = useRef(null);
  const maxAge = 7;
  const shareImportStarted = useRef(false);

  // A send whose answer was lost leaves a note behind. On the next load the note is redeemed:
  // the uploader is told their receipts arrived, instead of being left to send them again and
  // be refused as duplicates.
  const [resumedSend, setResumedSend] = useState(null);
  useEffect(() => {
    const pending = pendingSend();
    if (!pending) return;
    let alive = true;
    (async () => {
      const r = await resolveSendOutcome(supabase, pending.batchId);
      if (!alive) return;
      // Unknown stays remembered; there is nothing honest to say yet.
      if (r.outcome === "unknown") return;
      forgetSend();
      if (r.outcome === "landed") setResumedSend({ ...r, text: outcomeText(r.outcome) });
    })();
    return () => { alive = false; };
  }, []);

  const commitRows = (updater) => {
    setRows((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      rowsRef.current = next;
      return next;
    });
    // A refusal describes the rows as they were. Deleting or correcting one of them makes it a
    // statement about receipts that no longer exist — the owner deleted three receipts and the
    // red banner naming them stayed on the screen, so the remaining eight looked unsendable too.
    setSendError(null);
  };
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  // An object URL pins its whole image blob until it is revoked, so a removed or replaced
  // receipt must release its picture rather than leaving every full-size image the session
  // ever decoded resident. Done here, after the render commits, rather than inside the state
  // updater — an updater may be invoked more than once, and revoking is not a pure operation.
  const seenRowsRef = useRef([]);
  useEffect(() => {
    revokeDroppedUrls(seenRowsRef.current, rows, (url) => URL.revokeObjectURL(url));
    seenRowsRef.current = rows;
  }, [rows]);
  // Nothing survives unmount, so nothing should still be held.
  useEffect(() => () => revokeAllUrls(seenRowsRef.current, (url) => URL.revokeObjectURL(url)), []);

  const patchRow = (id, patch) => {
    commitRows((xs) => xs.map((r) => r.id === id ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r));
  };

  const criticalLowFields = (fc = {}, row = {}) => {
    const out = [];
    const checks = [
      ["amount", 0.72, "بڕ"],
      ["currency", 0.68, "دراو"],
      ["refNo", 0.55, "ژمارەی مامەڵە"],
      ["platform", 0.65, "پلاتفۆرم"],
      ["receiver", 0.50, "وەرگر"],
    ];
    checks.forEach(([k, min, label]) => {
      // Some WeChat QR-payment receipts legitimately show only Recipient Note,
      // not a recipient person/name. Do not force a false receiver in that case.
      if (k === "receiver" && row.platform === "WeChat" && row.recipientNote) return;
      if (fc[k] != null && clamp01(fc[k]) < min) out.push(label);
    });
    return out;
  };

  const classifyParsed = async (id, img, d) => {
    if (d?.ok === false) {
      const reason = d.note || "ئەم وێنەیە فیشی پارەدان نییە";
      return {
        id, url: img.url, blob: img.blob, hash: img.hash, ocrImage: img.b64 || img.ocrImage, mediaType: img.mediaType,
        status: "error", counted: false, reviewRequired: false,
        rejectCode: "not_receipt", rejectReason: reason, note: reason, raw: d,
      };
    }

    // API v5 normalizes receipt money to positive accounting magnitudes.
    // Keep this defensive Math.abs for older/cached responses too.
    const feeV = Math.abs(Number(d?.fee) || 0);
    const amountV = Math.abs(Number(d?.amount) || 0);
    const feeOrig = d?.feeOriginal != null ? Math.abs(Number(d.feeOriginal) || 0) : feeV;
    const feeDisc = Math.abs(Number(d?.feeDiscount) || 0);
    // Zero means the receipt states no separate order amount, not an order of nothing. Carried
    // through as a real figure it makes the expected net zero and every reconciled receipt looks
    // wrong; it also drove `netV` to 0 whenever the reader gave no net of its own.
    const orderAmountRead = d?.orderAmount != null && Number.isFinite(Number(d.orderAmount))
      ? Math.abs(Number(d.orderAmount))
      : null;
    const orderAmountV = orderAmountRead ? orderAmountRead : null;
    const netV = d?.netAmount != null && Number.isFinite(Number(d.netAmount))
      ? Math.abs(Number(d.netAmount))
      : (orderAmountV != null ? orderAmountV : Math.max(0, amountV - feeV));
    const plat = detectPlatform(`${d?.platform || ""} ${d?.bank || ""} ${d?.platformEvidence || ""}`) || d?.platform || null;
    const rn = normRef(d?.refNo);
    const merchantRn = normRef(d?.merchantOrderNo);
    const fc = d?.fieldConfidence && typeof d.fieldConfidence === "object" ? d.fieldConfidence : {};
    const conf = clamp01(d?.confidence, 0.5);

    // An identifier repeated is a hard duplicate. The four together — same currency, amount, day
    // and recipient, with no identifier matching — is a suspicion for a person to settle, because
    // it is also the shape of a genuine second payment to the same supplier on a busy day.
    let suspect = null;
    // A duplicate check that fails is a duplicate check that did not happen, and swallowing it
    // leaves a receipt looking as though it passed. Declared out here because it is read below,
    // outside the block that sets it — inside, it is a free variable at the point of use, and a
    // free variable in this file has already cost this project a whole evening of uploads that
    // did nothing at all.
    let dupeCheckFailed = null;
    // The image itself is always a key, so this always runs. It used to run only when the
    // reading had produced a reference — and `p_hash` was hard-coded to null, so the one rule
    // that catches the same photograph sent twice never ran at all. An unreadable receipt could
    // be uploaded five times and become five receipts, with the hash that would have caught
    // every one of them computed, stored, and thrown away at the call.
    if (img.hash || rn || merchantRn || (d?.currency && amountV != null && d?.txDate && (d?.receiver || d?.sender))) {
      const local = rowsRef.current.find((r) => r.id !== id && r.status !== "error" && (
        (img.hash && r.hash === img.hash) ||
        (rn && r.refNo && normRef(r.refNo) === rn) ||
        (merchantRn && r.merchantOrderNo && normRef(r.merchantOrderNo) === merchantRn)
      ));
      let old = null;
      try {
        const { data: hit, error: dupErr } = await supabase.rpc("check_receipt_dupe", {
          p_hash: img.hash || null,
          p_ref: rn,
          p_merchant_ref: merchantRn,
          p_currency: d?.currency || null,
          p_amount: amountV ?? null,
          p_tx_date: d?.txDate || null,
          p_payee: d?.receiver || d?.sender || null,
          // The document row is written before the image is read, so by now the receipt in hand
          // is already in the table it is being compared against.
          p_exclude_id: id,
        });
        if (dupErr) throw dupErr;
        if (hit?.length) old = hit[0];
      } catch (cause) {
        console.error("duplicate check", cause);
        dupeCheckFailed = cause?.message || "unknown";
      }
      // A suspicion is never a refusal: it goes to review with the reason attached.
      if (old?.kind === "suspect" && !local) { suspect = old; old = null; }
      if (local || old) {
        // Say which receipt, by the name both sides can read out, and say what actually matched.
        // "ژمارەی مامەڵەی … پێشتر تۆمار کراوە" named a reference the person cannot look up, and
        // said "reference" even when it was the image that repeated.
        const repeatedIdentifier = rn && local?.refNo && normRef(local.refNo) === rn ? d.refNo : d.merchantOrderNo;
        const sameImage = (local && img.hash && local.hash === img.hash) || old?.matched_key === "image";
        const earlier = old?.tracking_code || old?.ref || null;
        const when = old?.d ? new Date(old.d).toLocaleString("en-GB") : null;
        const reason = local
          ? (sameImage
            ? "هەمان وێنە لەم کۆمەڵەیەدا دووبارە بووەتەوە"
            : `هەمان ناسنامەی مامەڵە (${repeatedIdentifier}) لەم کۆمەڵەیەدا دووبارە بووەتەوە`)
          : [
            sameImage ? "هەمان وێنە پێشتر نێردراوە" : `ژمارەی مامەڵەی ${d.refNo} پێشتر تۆمار کراوە`,
            earlier ? `— ${earlier}` : null,
            when ? `لە ${when}` : null,
            old?.who ? `لەلایەن ${old.who}` : null,
          ].filter(Boolean).join(" ");
        return {
          id, url: img.url, blob: img.blob, hash: img.hash, ocrImage: img.b64 || img.ocrImage, mediaType: img.mediaType,
          status: "dup", counted: false, reviewRequired: false,
          rejectCode: local ? "same_batch" : sameImage ? "same_image" : "same_ref",
          rejectReason: reason, note: reason,
          dupOf: old?.id || local?.id || null, dupOfDate: old?.d || null, dupOfWho: old?.who || null,
          amount: amountV, fee: feeV, feeOriginal: feeOrig, feeDiscount: feeDisc, net: netV,
          orderAmount: d?.orderAmount ?? null,
          currency: d?.currency, sender: d?.sender, receiver: d?.receiver, refNo: d?.refNo,
          merchantOrderNo: d?.merchantOrderNo || null,
          paymentMethod: d?.paymentMethod || null, cardLast4: d?.cardLast4 || null,
          transactionStatus: d?.transactionStatus || null, recipientNote: d?.recipientNote || null,
          merchantName: d?.merchantName || null, platformEvidence: d?.platformEvidence || null,
          txTime: d?.txTime, txDate: d?.txDate, bank: d?.bank, platform: plat,
          confidence: conf, fieldConfidence: fc, raw: d,
        };
      }
    }

    const reviewReasons = [];
    let reviewCode = null;

    if (dupeCheckFailed) {
      reviewReasons.push("پشکنینی دووبارەبوونەوە نەکرا — پێویستە بە دەست دڵنیا ببیتەوە");
      reviewCode = reviewCode || "dupe_check_unavailable";
    }

    if (!amountV || amountV <= 0 || !d?.currency || /نەزانراو|unknown/i.test(String(d.currency))) {
      reviewReasons.push("بڕ یان دراو بە دڵنیایی نەخوێندرایەوە");
      reviewCode = reviewCode || "missing_required";
    }
    if (!rn) {
      reviewReasons.push("ژمارەی مامەڵە نەدۆزرایەوە");
      reviewCode = reviewCode || "no_ref";
    }
    if (!plat) {
      reviewReasons.push("پلاتفۆرم بە دڵنیایی نەناسراوەتەوە");
      reviewCode = reviewCode || "unknown_platform";
    }

    // Never trust OCR arithmetic. Validate every layout that exposes an order amount,
    // using integer minor units to avoid floating-point false mismatches.
    // Checked whenever there is an amount to check — not only when the layout happens to carry
    // an order amount. Guarding on the order amount is what let a receipt with a mismatched net
    // pass as "ok" on the screen and then be refused by the send gate, which checks every row:
    // the interface said three receipts were wrong and marked none of them.
    let arithmeticValidation = d?.validation || null;
    if (amountV > 0) {
      const checked = validateReceiptArithmetic({ amount: amountV, fee: feeV, orderAmount: orderAmountV, netAmount: netV });
      arithmeticValidation = {
        ...(arithmeticValidation || {}), type: "gross_order_fee_equation", checked: true,
        grossMatches: !checked.issues.includes("gross_order_fee_mismatch"), issues: checked.issues,
        expectedGross: orderAmountV == null ? null : checked.orderAmount + checked.fee,
      };
      const objection = arithmeticObjection({ amount: amountV, fee: feeV, orderAmount: orderAmountV, netAmount: netV });
      if (objection) {
        // Naming the figures, because "the numbers do not agree" tells nobody which numbers.
        reviewReasons.push(objection.reason);
        reviewCode = reviewCode || "amount_validation";
      }
    }

    const sameAmountTime = rowsRef.current.find((r) =>
      r.id !== id && r.status !== "dup" && r.status !== "error" &&
      Number(r.amount) > 0 && Number(r.amount) === amountV &&
      r.txTime && d?.txTime && String(r.txTime) === String(d.txTime)
    );
    if (sameAmountTime) {
      reviewReasons.push(`هەمان بڕ و هەمان کات لە فیشێکی تر هەیە — پشکنین پێویستە`);
      reviewCode = reviewCode || "possible_duplicate";
    }

    let ageDays = null;
    if (d?.txDate && /^\d{4}-\d{2}-\d{2}$/.test(d.txDate)) {
      ageDays = Math.floor((Date.now() - new Date(d.txDate + "T12:00:00").getTime()) / 86400000);
      if (ageDays > maxAge) {
        reviewReasons.push(`ڕێکەوتی کۆنە — ${ageDays} ڕۆژ لەمەوبەر`);
        reviewCode = reviewCode || "old_date";
      }
    }

    const low = criticalLowFields(fc, { platform: plat, recipientNote: d?.recipientNote });
    if (conf < 0.72 || low.length) {
      reviewReasons.push(low.length ? `دڵنیایی نزم لە: ${low.join("، ")}` : "دڵنیایی گشتیی خوێندنەوە نزمە");
      reviewCode = reviewCode || "low_confidence";
    }

    if (d?.note && /دەستکاری|فۆتۆشۆپ|tamper|edited|manipulat/i.test(String(d.note))) {
      reviewReasons.push(`⚠️ ${d.note}`);
      reviewCode = reviewCode || "tampered";
    }

    // Duplicate key 4: everything matches except an identifier. Held for a person, not refused.
    if (suspect) {
      reviewReasons.push(`هەمان بڕ، هەمان ڕۆژ و هەمان وەرگر پێشتر تۆمار کراوە${suspect.d ? ` لە ${new Date(suspect.d).toLocaleDateString("en-GB")}` : ""} — دڵنیا بەوە کە دوو پارەدانی جیاوازن`);
      reviewCode = reviewCode || "possible_duplicate";
    }

    let note = reviewReasons.join(" · ");
    if (!note && feeDisc > 0) note = `داشکاندنی فی: ${fmtMoney(data, feeOrig, d?.currency)} → ${fmtMoney(data, feeV, d?.currency)}`;
    else if (!note && d?.note) note = d.note;

    const status = reviewReasons.length ? "suspect" : "ok";
    return {
      id, url: img.url, blob: img.blob, hash: img.hash, ocrImage: img.b64 || img.ocrImage, mediaType: img.mediaType,
      status, counted: status === "ok", reviewRequired: status === "suspect",
      rejectCode: status === "suspect" ? reviewCode : null,
      rejectReason: status === "suspect" ? note : null,
      note, ageDays,
      amount: amountV, fee: feeV, feeOriginal: feeOrig, feeDiscount: feeDisc, net: netV,
      orderAmount: orderAmountV,
      validation: arithmeticValidation,
      currency: d?.currency, sender: d?.sender, receiver: d?.receiver, refNo: d?.refNo,
      merchantOrderNo: d?.merchantOrderNo || null,
      paymentMethod: d?.paymentMethod || null, cardLast4: d?.cardLast4 || null,
      transactionStatus: d?.transactionStatus || null, recipientNote: d?.recipientNote || null,
      merchantName: d?.merchantName || null, platformEvidence: d?.platformEvidence || null,
      txTime: d?.txTime, txDate: d?.txDate, bank: d?.bank, platform: plat,
      confidence: conf, fieldConfidence: fc, raw: d,
      // Carried through to ingestion, where the figures are checked against it.
      attestation: d?.attestation || null,
    };
  };

  /** Durable intake: the transaction assignment supplies every business field. */
  const durableIntake = async ({ id, img, patchRow }) => {
    return intakeReceipt({
      client: supabase,
      documentId: id,
      blob: img.blob,
      mediaType: img.mediaType || "image/jpeg",
      // Absent for a customer-seller, whose receipt precedes any transaction. A partner
      // uploading against an assignment supplies one; nothing here does yet.
      transactionId: null,
      batchId: receiptCommandRef.current?.batchId || null,
      // Whose receipt this is, when staff are the ones holding the phone. A customer-seller
      // uploading their own is recorded against themselves and this is ignored.
      customerId: staffReview ? (customerId || null) : null,
      // Read here and declared nowhere, so a staff upload threw ReferenceError while a
      // customer's did not — the ternary short-circuits before reaching it when staffReview is
      // false. It is a prop now, filled from the reason the staff screen already asks for.
      adminOverrideReason: staffReview ? (adminOverrideReason || null) : null,
      onStage: (stage, info) => patchRow(id, { note: intakeStatusText(info?.state) || stage }),
    });
  };

  const onFiles = async (files, source = "gallery") => {
    // There was a guard here — `if (!transactionId) return flash(...)` — and transactionId is
    // not a prop of this component, not a state, and not declared anywhere in this file. It was
    // a free variable, so the line threw ReferenceError the instant anybody chose an image:
    // no flash, no rows, no error on screen, nothing at all. Every upload, for every role.
    //
    // It is gone rather than corrected, because the rule it was reaching for is wrong anyway.
    // A customer-seller's receipt is what the transaction is made from; asking for a transaction
    // before accepting the receipt inverts the flow the whole feature exists to replace.
    const list = Array.from(files || []).filter((f) => f.type?.startsWith("image/"));
    if (!list.length) return flash("تەنها وێنە هەڵبژێرە");
    if (working) return;

    setIntakeSource(source);
    setWorking(true);
    // Created up front, not at send time: the durable intake and the later ingest must agree
    // on the batch id so both resolve to one storage path per receipt.
    //
    // It used to be built by hand here — `{ batchId: \`receipt-batch-${uid()}\` }` — with no
    // idempotency key, and `send()` only fills one in when the ref is still empty. Choosing
    // images always ran this first, so the send that followed carried `p_command_key:
    // undefined`. JSON.stringify drops an undefined value entirely, so the argument never
    // reached the server at all: PostgREST could not match the three-argument function, called
    // it missing from the schema cache, and the fallback route was handed the same nothing.
    // Every send failed, for every uploader, and none of it was about the receipts.
    receiptCommandRef.current ||= createReceiptIngestionCommand();
    const tasks = list.map((file) => ({ id: uid(), file }));
    setInspectorId((current) => current || tasks[0]?.id || null);
    commitRows((xs) => [
      ...xs,
      ...tasks.map(({ id, file }) => ({
        id, status: "processing", counted: false, reviewRequired: false,
        fileName: file.name, note: "ئامادەکردنی وێنە...",
      })),
    ]);

    let done = 0;
    let cooldownUntil = 0;

    // One OCR worker is intentional: vision requests can hit token-per-minute
    // limits long before request-per-minute limits. This queue uses provider
    // reset metadata and Retry-After instead of blind concurrency.
    for (let pos = 0; pos < tasks.length; pos++) {
      const { id, file } = tasks[pos];

      const cooldownMs = Math.max(0, cooldownUntil - Date.now());
      if (cooldownMs > 0) {
        patchRow(id, { note: `چاوەڕوانی خوێندنەوە... ${Math.ceil(cooldownMs / 1000)} چرکە` });
        await waitMs(cooldownMs);
      }

      try {
          patchRow(id, { note: "ئامادەکردنی وێنە...", status: "processing" });
          const img = await prepImage(file);
          patchRow(id, { url: img.url, blob: img.blob, hash: img.hash, ocrImage: img.b64, mediaType: img.mediaType, note: "پاراستنی بەڵگە..." });

          // Store the evidence BEFORE reading it. Past this point an OCR failure degrades the
          // reading but can no longer lose the receipt.
          patchRow(id, { note: "ناردنی وێنە...", status: "processing" });
          const intake = await durableIntake({ id, img, patchRow });
          // Preserve the durable identity before interpreting or retrying OCR. Even an exact
          // duplicate remains an immutable, discoverable document; only the server may decide
          // whether it is counted.
          patchRow(id, { documentId: intake.documentId || id, intakeState: intake.state || null,
                         stagedPath: intake.storagePath || undefined,
                         note: intakeStatusText(intake.state), status: "processing" });
          const d = intake.extraction;
          if (intake.readError || !d) throw intake.readError || new Error("خوێندنەوەکە چاوەڕوانە");
          const ready = await classifyParsed(id, img, d);
          const serverVerdicts = {
            duplicate: { status: "dup", counted: false, reviewRequired: false, rejectCode: "server_duplicate" },
            currency_mismatch: { status: "suspect", counted: false, reviewRequired: true, rejectCode: "currency_mismatch" },
            tamper_suspected: { status: "suspect", counted: false, reviewRequired: true, rejectCode: "tamper_suspected" },
            rejected: { status: "error", counted: false, reviewRequired: false, rejectCode: "server_rejected" },
          };
          const verdict = serverVerdicts[intake.state] || null;
          patchRow(id, {
            ...ready,
            ...(verdict || {}),
            documentId: intake.documentId || id,
            intakeState: intake.state || null,
            stagedPath: intake.storagePath || undefined,
            ...(verdict ? { note: intakeStatusText(intake.state), rejectReason: intakeStatusText(intake.state) } : {}),
          });

          // Respect the provider's token reset window before the next image.
          if (pos < tasks.length - 1) {
            const paceMs = ocrPaceAfterResult(d);
            cooldownUntil = Math.max(cooldownUntil, Date.now() + paceMs);
          }
        } catch (e) {
          const temporary = isTemporaryOcrError(e);
          // What the server said, when it said anything. Every read failure used to reach this
          // line as the same sentence — the image is safe, it will be retried — so an unset API
          // key and an expired session were indistinguishable on screen and in a screenshot.
          const named = receiptReadFailureText(e);
          const reason = temporary
            ? ocrRetryNote(e)
            : `نەتوانرا بخوێندرێتەوە: ${named || errorText(e)}`;
          patchRow(id, {
            status: temporary ? "retry" : "error",
            counted: false,
            reviewRequired: !temporary,
            rejectCode: temporary ? "api_retry" : "unreadable",
            rejectReason: reason,
            note: reason,
            retryAfterSeconds: Number(e?.retryAfterSeconds) || null,
          });

          if (temporary && pos < tasks.length - 1) {
            const retryMs = Number(e?.retryAfterSeconds) > 0
              ? Math.ceil(Number(e.retryAfterSeconds) * 1000) + 500
              : 8000;
            cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.min(30000, retryMs));
          }
        } finally {
          done += 1;
          setProg(`${done} لە ${tasks.length}`);
        }
      }

    setWorking(false);
    setProg(null);
  };

  useEffect(() => {
    const handoffId = new URLSearchParams(window.location.search).get("receiptShare");
    if (!handoffId || handoffId === "invalid" || shareImportStarted.current || working) {
      if (handoffId === "invalid" && !shareImportStarted.current) { shareImportStarted.current = true; flash(sharedReceiptMessage("invalid")); }
      return;
    }
    const owner = `${uploaderId || ""}:${customerId || partnerId || ""}`;
    if (!uploaderId || (!customerId && !partnerId)) return;
    shareImportStarted.current = true;
    let claimed;
    (async () => {
      flash(sharedReceiptMessage("loading"));
      try {
        claimed = await claimSharedReceiptHandoff(handoffId, owner);
        if (claimed.status !== "ready") { flash(sharedReceiptMessage(claimed.status)); return; }
        const checked = await validateClaimedSharedFiles(claimed.files);
        if (!checked.accepted.length) throw new Error("no valid shared receipt images");
        await onFiles(checked.accepted, "share");
        await finishSharedReceiptHandoff(handoffId, claimed.lease);
        const q = new URLSearchParams(window.location.search); q.delete("receiptShare"); q.delete("shareRejected");
        window.history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
        flash(sharedReceiptMessage("ready", claimed.rejected.length + checked.rejected.length));
      } catch (_) {
        if (claimed?.lease) await releaseSharedReceiptHandoff(handoffId, claimed.lease).catch(() => {});
        shareImportStarted.current = false;
        flash("نەتوانرا وێنە هاوبەشکراوەکان بکرێنەوە؛ تکایە دووبارە هەوڵ بدەوە.");
      }
    })();
  }, [uploaderId, customerId, partnerId]);

  const retryRow = async (id) => {
    const r = rowsRef.current.find((x) => x.id === id);
    if (!r?.documentId) return flash("ناسنامەی فیشە پارێزراوەکە بەردەست نییە");
    patchRow(id, { status: "processing", counted: false, reviewRequired: false, note: "دووبارە دەخوێندرێتەوە..." });
    try {
      const serverResult = await requestStoredReceiptOcr(supabase, r.documentId);
      const d = serverResult.extraction;
      if (!d) {
        patchRow(id, {
          status: serverResult.state === "ocr_failed_retryable" ? "retry" : "suspect",
          counted: false,
          reviewRequired: serverResult.state !== "ocr_failed_retryable",
          note: intakeStatusText(serverResult.state),
          intakeState: serverResult.state,
        });
        return;
      }
      const ready = await classifyParsed(id, r, d);
      patchRow(id, { ...ready, intakeState: serverResult.state });
    } catch (e) {
      // The retry path reaches the reader without going through intakeReceipt, so it has to write
      // the reason down itself or a retried failure is as silent as the first one was.
      noteReceiptReadFailure(supabase, r.documentId, e);
      const temporary = isTemporaryOcrError(e);
      const named = receiptReadFailureText(e);
      const reason = temporary
        ? ocrRetryNote(e, "خزمەتگوزاری خوێندنەوە هێشتا کاتێک بەردەست نییە")
        : `نەتوانرا دووبارە بخوێندرێتەوە: ${named || errorText(e)}`;
      patchRow(id, {
        status: temporary ? "retry" : "error",
        counted: false,
        reviewRequired: !temporary,
        rejectCode: temporary ? "api_retry" : "unreadable",
        rejectReason: reason,
        note: reason,
        retryAfterSeconds: Number(e?.retryAfterSeconds) || null,
      });
    }
  };

  const editField = (id, key, value) => {
    patchRow(id, (r) => {
      const numeric = ["amount", "fee", "net", "orderAmount", "feeOriginal", "feeDiscount"].includes(key);
      const next = { ...r, [key]: numeric ? (value === "" ? "" : Number(value)) : value, manualEdited: true };
      if (["amount", "fee", "orderAmount"].includes(key)) {
        const recomputed = receiptNetFrom(next);
        if (recomputed != null) next.net = recomputed;
      }
      return next;
    });
  };

  const confirmRow = (id) => {
    const r = rowsRef.current.find((x) => x.id === id);
    if (!r) return;
    if (r.status === "dup") return flash("فیشی دووبارە ناتوانرێت وەک فیشی نوێ پشتڕاست بکرێتەوە");
    if (!(Number(r.amount) > 0) || !String(r.currency || "").trim()) {
      return flash("بڕ و دراو پێویستن پێش پشتڕاستکردنەوە");
    }
    const objection = arithmeticObjection({ amount: r.amount, fee: r.fee, orderAmount: r.orderAmount, netAmount: r.net });

    // Handing a reading to the operator comes first, and is never refused for the arithmetic:
    // this route exists precisely for figures the uploader is not allowed to put right. Refusing
    // it here left a customer with a receipt they could neither correct, hand over, nor send —
    // only delete, which is the one thing evidence must never invite.
    if (!staffReview && (objection || r.manualEdited || r.status === "suspect")) {
      patchRow(id, {
        status: "error", counted: false, reviewRequired: false,
        rejectCode: objection ? "amount_validation" : "manual_review_required",
        rejectReason: objection ? objection.reason
          : "زانیاریی فیشەکە دەستکاری کراوە یان دڵنیایی خوێندنەوە نزمە؛ بۆ پشکنینی ئەدمین تۆمار دەکرێت",
        note: "بۆ پشکنینی ئەدمین تۆمار دەکرێت",
        reviewedManually: true,
      });
      setEditingId(null);
      return flash("فیشەکە بۆ پشکنینی ئەدمین ئامادە کرا");
    }

    // Staff can put it right, so for them it is worth refusing — with the figures named.
    if (objection) return flash(objection.reason);
    patchRow(id, {
      status: "ok", counted: true, reviewRequired: false,
      rejectCode: null, rejectReason: null,
      note: r.manualEdited ? "بە دەست پشکنرا و ڕاستکرایەوە ✓" : "بە دەست پشتڕاست کرایەوە ✓",
      reviewedManually: true,
    });
    setEditingId(null);
  };

  const rejectRow = (id) => {
    patchRow(id, {
      status: "error", counted: false, reviewRequired: false,
      rejectCode: "manual_reject", rejectReason: "بە دەست ڕەتکرایەوە", note: "بە دەست ڕەتکرایەوە",
      reviewedManually: true,
    });
    setEditingId(null);
  };

  const good = rows.filter((r) => r.status === "ok" && r.counted !== false);
  const review = rows.filter((r) => r.status === "suspect");
  const processing = rows.filter((r) => r.status === "processing");
  const retrying = rows.filter((r) => r.status === "retry");
  const bad = rows.filter((r) => r.status === "dup" || r.status === "error");
  const dupN = rows.filter((r) => r.status === "dup").length;
  const errN = rows.filter((r) => r.status === "error").length;
  const agg = {};
  good.forEach((r) => {
    const c = r.currency || "?";
    agg[c] = agg[c] || { g: 0, f: 0, n: 0 };
    agg[c].g += Number(r.amount) || 0;
    agg[c].f += Number(r.fee) || 0;
    agg[c].n += Number(r.net) || 0;
  });
  const mainCur = Object.keys(agg).sort((a, b) => agg[b].g - agg[a].g)[0] || null;

  const receiptTabCounts = {
    all: rows.length,
    ok: good.length,
    suspect: review.length,
    retry: retrying.length,
    dup: dupN,
    error: errN,
  };
  const receiptTabs = [
    ["all", "هەموو", receiptTabCounts.all],
    ["ok", "پشتڕاستکراو", receiptTabCounts.ok],
    ["suspect", "پشکنین", receiptTabCounts.suspect],
    ["retry", "چاوەڕوانی خوێندنەوە", receiptTabCounts.retry],
    ["dup", "دووبارە", receiptTabCounts.dup],
    ["error", "ڕەتکراو/هەڵە", receiptTabCounts.error],
  ];
  const platformOptions = Array.from(new Set(rows.map((r) => r.platform || detectPlatform(r.bank)).filter(Boolean))).sort();
  const normalizedReceiptSearch = normalizeSearchText(reviewSearch);
  const visibleRows = rows.filter((r) => {
    if (reviewTab !== "all" && r.status !== reviewTab) return false;
    const rp = r.platform || detectPlatform(r.bank) || "";
    if (reviewPlatform !== "all" && rp !== reviewPlatform) return false;
    if (!normalizedReceiptSearch) return true;
    return [
      r.amount, r.currency, r.refNo, r.merchantOrderNo, r.paymentMethod, r.cardLast4, r.transactionStatus, r.recipientNote, r.merchantName, r.receiver, r.sender, r.bank, rp, r.fileName, r.note
    ].some((v) => normalizeSearchText(v).includes(normalizedReceiptSearch));
  });
  const visibleIds = visibleRows.map((r) => r.id);
  const visibleSelectableIds = visibleRows.filter((r) => r.status !== "processing").map((r) => r.id);
  const allVisibleSelected = visibleSelectableIds.length > 0 && visibleSelectableIds.every((id) => selectedRows.includes(id));
  const selectedActual = rows.filter((r) => selectedRows.includes(r.id));

  const toggleSelected = (id) => setSelectedRows((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const toggleAllVisible = () => {
    setSelectedRows((prev) => {
      if (allVisibleSelected) return prev.filter((id) => !visibleSelectableIds.includes(id));
      return Array.from(new Set([...prev, ...visibleSelectableIds]));
    });
  };
  const clearSelected = () => setSelectedRows([]);

  const confirmSelected = () => {
    const ids = new Set(selectedActual
      .filter((r) => r.status !== "processing" && r.status !== "dup" && Number(r.amount) > 0 && String(r.currency || "").trim())
      .map((r) => r.id));
    if (!ids.size) return flash("هیچ فیشێکی گونجاو بۆ پشتڕاستکردنەوە هەڵنەبژێردراوە");
    commitRows((xs) => xs.map((r) => ids.has(r.id) ? {
      ...r,
      status: "ok",
      counted: true,
      reviewRequired: false,
      rejectCode: null,
      rejectReason: null,
      note: r.manualEdited ? "بە دەست پشکنرا و ڕاستکرایەوە ✓" : "بە کۆمەڵەیی پشتڕاست کرایەوە ✓",
      reviewedManually: true,
    } : r));
    setSelectedRows((prev) => prev.filter((id) => !ids.has(id)));
    if (editingId && ids.has(editingId)) setEditingId(null);
    flash(`${ids.size} فیش پشتڕاست کرانەوە ✓`);
  };

  const rejectSelected = () => {
    const ids = new Set(selectedActual.filter((r) => r.status !== "processing" && r.status !== "dup").map((r) => r.id));
    if (!ids.size) return flash("هیچ فیشێکی گونجاو بۆ ڕەتکردنەوە هەڵنەبژێردراوە");
    commitRows((xs) => xs.map((r) => ids.has(r.id) ? {
      ...r,
      status: "error",
      counted: false,
      reviewRequired: false,
      rejectCode: "manual_reject",
      rejectReason: "بە دەست ڕەتکرایەوە",
      note: "بە دەست ڕەتکرایەوە",
      reviewedManually: true,
    } : r));
    setSelectedRows((prev) => prev.filter((id) => !ids.has(id)));
    if (editingId && ids.has(editingId)) setEditingId(null);
    flash(`${ids.size} فیش ڕەتکرانەوە`);
  };

  const retrySelected = async () => {
    // Never re-read receipts that are already confirmed unless the user explicitly
    // changed their status. This keeps quota focused on failed / review rows.
    const ids = selectedActual
      .filter((r) => ["retry", "suspect", "error"].includes(r.status) && r.status !== "dup" && r.documentId)
      .map((r) => r.id);

    if (!ids.length) return flash("هەڵبژاردراوەکان پێویستیان بە دووبارە خوێندنەوە نییە");

    let cooldownUntil = 0;
    for (let i = 0; i < ids.length; i++) {
      const waitFor = Math.max(0, cooldownUntil - Date.now());
      if (waitFor > 0) await waitMs(waitFor);

      const id = ids[i];
      const before = rowsRef.current.find((r) => r.id === id);
      await retryRow(id);
      const after = rowsRef.current.find((r) => r.id === id);

      if (i < ids.length - 1) {
        if (after?.status === "retry") {
          const retryMs = Number(after.retryAfterSeconds) > 0
            ? Math.ceil(Number(after.retryAfterSeconds) * 1000) + 500
            : 8000;
          cooldownUntil = Date.now() + Math.min(30000, retryMs);
        } else {
          const paceMs = ocrPaceAfterResult(after?.raw);
          cooldownUntil = Date.now() + paceMs;
        }
      }
    }

    setSelectedRows((prev) => prev.filter((id) => !ids.includes(id)));
  };

  const retryWaitingRows = async () => {
    const ids = rowsRef.current.filter((r) => r.status === "retry" && r.documentId).map((r) => r.id);
    if (!ids.length) return flash("هیچ فیشێکی چاوەڕوانی خوێندنەوە نییە");
    setSelectedRows(ids);
    // Run directly because React state selection is asynchronous.
    let cooldownUntil = 0;
    for (let i = 0; i < ids.length; i++) {
      const waitFor = Math.max(0, cooldownUntil - Date.now());
      if (waitFor > 0) await waitMs(waitFor);

      await retryRow(ids[i]);
      const after = rowsRef.current.find((r) => r.id === ids[i]);
      if (i < ids.length - 1) {
        if (after?.status === "retry") {
          const retryMs = Number(after.retryAfterSeconds) > 0
            ? Math.ceil(Number(after.retryAfterSeconds) * 1000) + 500
            : 8000;
          cooldownUntil = Date.now() + Math.min(30000, retryMs);
        } else {
          cooldownUntil = Date.now() + ocrPaceAfterResult(after?.raw);
        }
      }
    }
    setSelectedRows([]);
  };

  const send = async () => {
    if (working || processing.length) return flash("هێشتا هەندێک فیش دەخوێندرێنەوە");
    // Staff can put a reading right through the reviewed path, so for them a receipt awaiting
    // review is worth stopping for. An uploader cannot correct anything — §2 forbids it — so
    // stopping them leaves no way forward at all, which is how eleven receipts became three
    // deletions. Theirs travels with the batch instead, marked, for the operator to review.
    if (review.length && mayEditExtraction(staffReview)) {
      return flash(`${review.length} فیش پێویستیان بە پشکنینی دەستی هەیە`);
    }
    if (retrying.length) return flash(`${retrying.length} فیش بەهۆی کێشەی کاتی خوێندنەوە چاوەڕوانن — ڕەت نەکراونەتەوە`);
    // The database refuses this too; refusing here means the uploader is told before the images
    // are sent rather than after.
    if (!mayUploadDirection(role, dir)) return flash(DIRECTION_REFUSED);
    // net_amount becomes the transaction amount when the batch is converted, so a row whose
    // arithmetic does not reconcile must never be counted. One rule decides that, and the same
    // rule marked the row on the screen — the two used to disagree, so a receipt could look
    // perfectly fine and still be refused, with nothing on the screen to act on.
    //
    // Rejected and unreadable items are evidence too: their image, raw OCR, reason and server
    // verdict are retained even when no amount exists.
    const { counted, evidence, objections, blocked } =
      sendableSet([...good, ...review, ...bad], { mayResolve: mayEditExtraction(staffReview) });
    if (blocked) {
      setSendError({
        code: "receipt_arithmetic",
        message: `${objections.length} فیش ژمارەکانیان یەک ناگرنەوە. پێش ناردن بیانپشکنە و پشتڕاست بکەرەوە.`,
        detail: objections.map((o) => o.reason).join(" · "),
      });
      return;
    }
    // public.receipts declares `amount numeric not null check (amount > 0)` and a currency
    // matching ^[A-Z]{3,8}$, and the ingestion command re-checks both for EVERY row in the
    // batch — the rejected ones included. So one image that turned out not to be a receipt at
    // all, carrying no amount and no currency, refused the whole send with `invalid amount`,
    // and the eleven good receipts beside it went nowhere.
    //
    // Those rows are not lost by being left out: each is already a durable receipt_document
    // with its image, its reading attempts and the reason it failed, and it stays on the
    // uploader's screen marked as it is. What has no figures simply cannot be written into a
    // table whose whole purpose is figures.
    const storable = (row) => Number(row?.amount) > 0
      && /^[A-Z]{3,8}$/.test(String(row?.currency || "").trim().toUpperCase());
    const withoutFigures = evidence.filter((row) => !storable(row));
    const sendRows = [...counted, ...evidence.filter(storable)];
    if (!sendRows.length) return flash("هیچ فیشێکی گونجاو بۆ ناردن نییە");
    const currencies = new Set(counted.map((row) => String(row.currency || "").trim().toUpperCase()).filter(Boolean));
    if (currencies.size > 1) {
      setSendError({ code: "mixed_currency", message: "فیشەکانی هەر دراوێک بە جیا بنێرە؛ بۆ نموونە CNY و USD لە یەک ناردندا تێکەڵ مەکە." });
      return;
    }

    setSending(true);
    setSendError(null);
    receiptCommandRef.current ||= createReceiptIngestionCommand();
    const command = receiptCommandRef.current;
    // Written down before the send: if the answer is lost, the question "did they arrive?"
    // survives a reload and can still be answered.
    rememberSend(command, sendRows.length);
    const fallbackCurrencies = new Set(bad.map((row) => String(row.currency || "").trim().toUpperCase()).filter((value) => /^[A-Z]{3,8}$/.test(value)));
    const batchCurrency = mainCur || (fallbackCurrencies.size === 1 ? [...fallbackCurrencies][0] : "UNKNOWN");
    const a = mainCur ? agg[mainCur] : { g: 0, f: 0, n: 0 };
    try {
      const { data: commitData } = await ingestReceiptBatch({
        supabase, command, rows: sendRows,
        onPath: (id, stagedPath) => patchRow(id, { stagedPath }),
        makeBatch: () => ({
          id: command.batchId, customer_id: customerId || null, customer_name: customerName || null,
          partner_id: partnerId || null, direction: dir, currency: batchCurrency,
          total_gross: a.g, total_fee: a.f, total_net: a.n, dup_n: dupN,
          rejected_n: bad.length, source: intakeSource,
        }),
        makeReceipt: (r, path) => ({
          id: r.id, batch_id: command.batchId, customer_id: customerId || null, customer_name: customerName || null,
          direction: dir, amount: r.amount, fee: r.fee || 0, fee_original: r.feeOriginal ?? null,
          fee_discount: r.feeDiscount || 0, platform: r.platform || null, net_amount: r.net ?? null,
          currency: r.currency, sender: r.sender || null, receiver: r.receiver || null, ref_no: r.refNo || null,
          tx_time: r.txTime || null, tx_date: r.txDate || null, bank: r.bank || null, note: r.note || null,
          image_hash: r.hash, image_path: path, status: r.status === "dup" ? "rejected" : r.status, counted: r.counted !== false,
          // The verdict this browser reached, which the command then checks for itself against
          // the amount, the fee, the currency and every receipt already accepted. Without it
          // `v_accept := coalesce(r->>'intake_status','')='accepted' and ...` is false for every
          // row, so a send that reported success recorded every receipt as rejected with
          // "فیشەکە یاساکانی ناردنی نەبڕیوە" and closed the batch with nothing in it.
          intake_status: r.status === "ok" && r.counted !== false ? "accepted" : "rejected",
          reject_code: r.rejectCode || null, reject_reason: r.rejectReason || null, dup_of: r.dupOf || null,
          dup_of_date: r.dupOfDate || null, dup_of_who: r.dupOfWho || null,
          raw: { ...(r.raw || {}), ocr_v: 6, confidence: r.confidence ?? r.raw?.confidence ?? null,
            fieldConfidence: r.fieldConfidence || r.raw?.fieldConfidence || null,
            merchantOrderNo: r.merchantOrderNo || r.raw?.merchantOrderNo || null,
            orderAmount: r.orderAmount ?? r.raw?.orderAmount ?? null, paymentMethod: r.paymentMethod || r.raw?.paymentMethod || null,
            cardLast4: r.cardLast4 || r.raw?.cardLast4 || null, transactionStatus: r.transactionStatus || r.raw?.transactionStatus || null,
            recipientNote: r.recipientNote || r.raw?.recipientNote || null, merchantName: r.merchantName || r.raw?.merchantName || null,
            platformEvidence: r.platformEvidence || r.raw?.platformEvidence || null,
            sourceSignedAmount: r.raw?.sourceSignedAmount ?? null, sourceAmountDirection: r.raw?.sourceAmountDirection || null,
            validation: r.validation || r.raw?.validation || null, reviewedManually: !!r.reviewedManually, manualEdited: !!r.manualEdited,
            // What the reader read, recorded server-side when it read it. The database
            // recomputes the digest from the figures above; if they were altered on the way,
            // the two differ and the batch is refused. §2, enforced rather than displayed.
            attestation: r.attestation || r.raw?.attestation || null },
        }),
      });
      // The atomic RPC re-checks every receipt server-side (duplicates included) and is the
      // source of truth; the legacy recovery path does not return these counts, so fall back
      // to the client's own tally only when the server total is unavailable.
      const acceptedCount = Number.isFinite(Number(commitData?.accepted_count)) ? Number(commitData.accepted_count) : good.length;
      const serverRejected = Number.isFinite(Number(commitData?.rejected_count)) ? Number(commitData.rejected_count) - bad.length : 0;
      const recordedRejects = sendRows.length - counted.length;
      flash(`${acceptedCount} ${tr("فیش نێردرا")} ✓${recordedRejects ? ` — ${recordedRejects} ${tr("ڕەتکراو بە وێنە و هۆکارەوە تۆمار کران")}` : ""}${withoutFigures.length ? ` — ${withoutFigures.length} ${tr("وێنە نەخوێندرایەوە و بڕ و دراوی نییە؛ وەک بەڵگە پارێزراوە بەڵام نەنێردرا")}` : ""}${serverRejected > 0 ? ` — ⚠️ ${serverRejected} ${tr("لەلایەن سێرڤەرەوە ڕەتکرانەوە؛ هۆکاری هەریەکەیان لەگەڵ فیشەکەدا نووسراوە")}` : ""}`);
      // Never name a cause the server did not give. This said "rejected as duplicates" whatever
      // the reason was, and four receipts refused for something else entirely were reported to
      // the owner as duplicates of nothing — the server had never accepted a single receipt.
      if (serverRejected > 0) setSendError({
        code: "server_rejected",
        message: `${serverRejected} ${tr("فیش لەلایەن سێرڤەرەوە وەرنەگیران")}`,
        detail: tr("هۆکاری هەریەکەیان لەسەر خودی فیشەکە نووسراوە — لیستی فیشە ڕەتکراوەکان بکەرەوە"),
      });
      forgetSend();
      commitRows([]); receiptCommandRef.current = null; setEditingId(null); setInspectorId(null);
      setSelectedRows([]); setReviewTab("all"); setReviewSearch(""); setReviewPlatform("all");
      setIntakeSource("app"); onDone?.();
    } catch (error) {
      console.error("receipt ingestion failed", { stage: error.stage, code: error.code, requestId: error.requestId, outcomeUnknown: error.outcomeUnknown });
      // The write is atomic, so the batch either exists or it does not. Ask, rather than
      // telling the uploader it failed and sending them into a retry the duplicate check
      // will then refuse.
      const settled = await settleFailedSend(supabase, command, error);
      if (settled.outcome === "landed") {
        flash(settled.text);
        commitRows([]); receiptCommandRef.current = null; setEditingId(null); setInspectorId(null);
        setSelectedRows([]); setReviewTab("all"); setReviewSearch(""); setReviewPlatform("all");
        setIntakeSource("app"); onDone?.();
        return;
      }
      const message = error.requestId
        ? error.message
        : userFacingServiceError(error, _lang, "فیشەکە تۆمار نەکرا؛ تکایە پەیوەندیی ئینتەرنێت بپشکنە و دووبارە هەوڵ بدەوە.");
      setSendError({
        stageLabel: error.stage, code: error.code, requestId: error.requestId,
        // Says which stage broke and what is known about the receipts, instead of only
        // "sending failed".
        message: `${stageText(error.stage)} — ${settled.text}`,
        detail: message,
        outcomeUnknown: settled.outcome === "unknown",
      });
    } finally { setSending(false); }
  };

  const ST = {
    processing: { tone: "slate", t: "خوێندنەوە" },
    ok: { tone: "green", t: "پشتڕاستکراو" },
    dup: { tone: "red", t: "دووبارە" },
    suspect: { tone: "amber", t: "پشکنین پێویستە" },
    retry: { tone: "amber", t: "چاوەڕوانی خوێندنەوە" },
    error: { tone: "red", t: "ڕەتکراو/هەڵە" },
  };

  const confidenceLabel = (r) => {
    const v = r.confidence;
    if (v == null || !Number.isFinite(Number(v))) return null;
    return `${Math.round(clamp01(v) * 100)}%`;
  };

  const fieldConf = (r, key) => {
    const v = r.fieldConfidence?.[key];
    if (v == null || !Number.isFinite(Number(v))) return null;
    const pct = Math.round(clamp01(v) * 100);
    const color = pct >= 80 ? "var(--pos)" : pct >= 60 ? "var(--warn)" : "var(--neg)";
    return <span className="text-[9px] font-bold" style={{ color }}>{pct}%</span>;
  };

  const lifecycleStage = working || processing.length
    ? "read"
    : !rows.length
      ? "capture"
      : review.length || retrying.length || bad.length
        ? "review"
        : good.length
          ? "verify"
          : "capture";
  const inspectedReceipt = inspectorId ? rows.find((r) => r.id === inspectorId) || null : null;

  return (
    <div className="space-y-4">
      {!simple && <DeferredPanel compact><ReceiptLifecycle stage={lifecycleStage} lang={_lang} /></DeferredPanel>}

      {!mayChooseDirection && role === "customer" && (
        <Card className="p-4">
          <Lbl>{tr("جۆری فیشەکان")}</Lbl>
          <div className="text-[13px] mt-1" style={{ color: "var(--txt-2)" }}>
            {tr("فیشی فرۆشتنی خۆت — ئەو پارەیەی بۆت هاتووە.")}
          </div>
        </Card>
      )}

      {mayChooseDirection && (
        <Card className="p-4">
          <Lbl>{tr("جۆری فیشەکان")}</Lbl>
          <div className="flex gap-2">
            {[["in", tr("پارە هاتووە (کڕین)")], ["out", tr("پارە نێردراوە (فرۆشتن)")]].map(([k, t]) => (
              <button key={k} onClick={() => setDir(k)}
                className={`flex-1 py-2.5 rounded-[var(--r-sm)] text-sm font-semibold transition tap ${dir === k ? (k === "in" ? "bg-[var(--pos)] text-white" : "bg-rose-700 text-white") : "bg-[var(--line)] text-[var(--txt-2)]"}`}>{t}</button>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-5 space-y-4">
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" disabled={working}
          onChange={(e) => { onFiles(e.target.files, "camera"); e.target.value = ""; }} />
        <input ref={galleryInputRef} type="file" accept="image/*" multiple className="hidden" disabled={working}
          onChange={(e) => { onFiles(e.target.files, "gallery"); e.target.value = ""; }} />
        <input ref={shareInputRef} type="file" accept="image/*" multiple className="hidden" disabled={working}
          onChange={(e) => { onFiles(e.target.files, "share"); e.target.value = ""; }} />

        {simple ? (
          <div className="space-y-2.5">
            <button type="button" disabled={working} onClick={() => galleryInputRef.current?.click()}
              className="w-full min-h-[76px] px-5 py-4 rounded-2xl flex items-center gap-3 text-start disabled:opacity-50"
              style={{ background: "linear-gradient(135deg,var(--ac),var(--pos))", color: "#fff", boxShadow: "0 10px 24px -12px rgba(var(--ac-gl),.7)" }}>
              {working ? <RotateCcw className="w-6 h-6 animate-spin shrink-0" /> : <Upload className="w-6 h-6 shrink-0" />}
              <span className="min-w-0">
                <span className="block text-[15px] font-bold">{working ? `فیشەکان دەخوێندرێنەوە ${prog || ""}` : "＋ ناردنی فیش"}</span>
                <span className="block text-[11px] mt-1 opacity-90">وێنەیەک یان چەند وێنە هەڵبژێرە</span>
              </span>
            </button>
            <button type="button" disabled={working} onClick={() => cameraInputRef.current?.click()}
              className="w-full min-h-11 px-4 rounded-xl flex items-center justify-center gap-2 text-[12px] font-semibold disabled:opacity-50"
              style={{ background: "var(--surf-2)", color: "var(--txt-2)", border: "1px solid var(--line)" }}>
              <Camera className="w-4 h-4" /> وێنەگرتن بە کامێرا
            </button>
            <p className="text-[11px] leading-relaxed text-center" style={{ color: "var(--txt-3)" }}>وێنەی بنەڕەتی یەکسەر پارێزراو دەبێت؛ خوێندنەوەکە پێشبینینە و بڕیاری کۆتایی لەلایەن ئەدمینەوە دەدرێت.</p>
          </div>
        ) : <>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <button type="button" disabled={working} onClick={() => cameraInputRef.current?.click()}
            className="p-4 rounded-2xl text-start disabled:opacity-50 transition hover:-translate-y-0.5"
            style={{ background: "color-mix(in srgb, var(--ac) 8%, var(--surf))", border: "1px solid color-mix(in srgb, var(--ac) 20%, var(--line))" }}>
            <Camera className="w-5 h-5 mb-2" style={{ color: "var(--ac)" }} />
            <div className="text-[12px] font-bold text-[var(--txt)]">کامێرا</div>
            <div className="text-[10px] text-[var(--txt-3)] mt-1">وێنەی فیشەکە ئێستا بگرە</div>
          </button>
          <button type="button" disabled={working} onClick={() => galleryInputRef.current?.click()}
            className="p-4 rounded-2xl text-start disabled:opacity-50 transition hover:-translate-y-0.5"
            style={{ background: "var(--surf-2)", border: "1px solid var(--line)" }}>
            <Upload className="w-5 h-5 mb-2" style={{ color: "var(--pos)" }} />
            <div className="text-[12px] font-bold text-[var(--txt)]">گەلەری / فایلەکان</div>
            <div className="text-[10px] text-[var(--txt-3)] mt-1">یەک یان چەند فیش هەڵبژێرە</div>
          </button>
          <button type="button" disabled={working} onClick={() => shareInputRef.current?.click()}
            className="p-4 rounded-2xl text-start disabled:opacity-50 transition hover:-translate-y-0.5"
            style={{ background: "color-mix(in srgb, var(--pos) 7%, var(--surf))", border: "1px solid color-mix(in srgb, var(--pos) 18%, var(--line))" }}>
            <MessageCircle className="w-5 h-5 mb-2" style={{ color: "var(--pos)" }} />
            <div className="text-[12px] font-bold text-[var(--txt)]">واتساپ / هاوبەشکردن</div>
            <div className="text-[10px] text-[var(--txt-3)] mt-1">فیشێکی پاشەکەوتکراو یان هاوبەشکراو هەڵبژێرە</div>
          </button>
        </div>

        <div role="button" tabIndex={0}
          onClick={() => !working && galleryInputRef.current?.click()}
          onKeyDown={(e) => { if (!working && (e.key === "Enter" || e.key === " ")) galleryInputRef.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); if (!working) setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => { e.preventDefault(); setDragActive(false); if (!working) onFiles(e.dataTransfer.files, "drag_drop"); }}
          className="border-2 border-dashed rounded-[var(--r)] p-6 md:p-8 text-center cursor-pointer transition outline-none"
          style={dragActive
            ? { borderColor: "var(--pos)", background: "color-mix(in srgb, var(--pos) 10%, var(--surf))" }
            : { borderColor: "var(--line-2)", background: working ? "var(--surf-3)" : "var(--surf)" }}>
          <div className="w-12 h-12 rounded-2xl mx-auto mb-3 flex items-center justify-center" style={{ background: "var(--surf-3)", color: "var(--ac)" }}>
            {working ? <RotateCcw className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
          </div>
          <div className="text-sm font-semibold text-[var(--txt)]">{working ? `خوێندنەوەی فیشەکان... ${prog || ""}` : "فیشەکان لێرە دابنێ یان کلیک بکە"}</div>
          <div className="text-xs text-[var(--txt-3)] mt-1.5">AI زانیارییەکان دەخوێنێتەوە؛ خانە گومانلێکراوەکان پێش ناردن بە دەست پشتڕاست دەکرێنەوە.</div>
        </div>
        </>}
      </Card>

      {rows.length > 0 && (
        <>
          {!simple && <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
            {[
              ["پشتڕاستکراو", good.length, "var(--pos)"],
              ["پشکنین پێویستە", review.length, "var(--warn)"],
              ["چاوەڕوانی خوێندنەوە", retrying.length, "var(--warn)"],
              ["دووبارە", dupN, "var(--neg)"],
              ["ڕەتکراو/هەڵە", errN, "var(--neg)"],
            ].map(([label, value, color]) => (
              <Card key={label} className="p-3.5">
                <div className="text-[10.5px]" style={{ color: "var(--txt-3)" }}>{label}</div>
                <div className="text-xl font-bold mt-1" style={{ ...num, color }}>{value}</div>
              </Card>
            ))}
          </div>}

          {!simple && <Card className="p-3 md:p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div>
                <div className="text-[13px] font-bold text-[var(--txt)]">ناوەندی پشکنینی فیش</div>
                <div className="text-[10.5px] text-[var(--txt-3)] mt-0.5">فلتەر، هەڵبژاردنی کۆمەڵەیی، دووبارە خوێندنەوە و پشتڕاستکردنەوە لە یەک شوێن.</div>
              </div>
              <div className="text-[10.5px] font-semibold" style={{ color: "var(--txt-3)", ...num }}>{visibleRows.length} / {rows.length}</div>
            </div>

            <div className="flex gap-1 p-1 rounded-xl overflow-x-auto mb-3" style={{ background: "var(--surf-3)" }}>
              {receiptTabs.map(([key, label, count]) => (
                <button key={key} onClick={() => { setReviewTab(key); setSelectedRows([]); }}
                  className="whitespace-nowrap px-3 py-2 rounded-lg text-[11px] font-semibold transition"
                  style={reviewTab === key
                    ? { background: "var(--surf)", color: "var(--txt)", boxShadow: "var(--sh-1)" }
                    : { color: "var(--txt-3)" }}>
                  {label} <span style={num}>({count})</span>
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_180px_auto] gap-2.5">
              <div className="relative">
                <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-3 text-[var(--txt-3)] pointer-events-none" />
                <input value={reviewSearch} onChange={(e) => setReviewSearch(e.target.value)}
                  placeholder="گەڕان بە بڕ، دراو، ژمارە، وەرگر..."
                  className="w-full ps-9 pe-3 py-2.5 rounded-xl text-[12px] outline-none"
                  style={{ background: "var(--surf-2)", border: "1px solid var(--line)", color: "var(--txt)" }} />
              </div>
              <select value={reviewPlatform} onChange={(e) => setReviewPlatform(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl text-[12px] outline-none"
                style={{ background: "var(--surf-2)", border: "1px solid var(--line)", color: "var(--txt)" }}>
                <option value="all">هەموو پلاتفۆرمەکان</option>
                {platformOptions.map((p) => <option key={p} value={p}>{platMeta(p).ku}</option>)}
              </select>
              <button onClick={toggleAllVisible} disabled={!visibleSelectableIds.length}
                className="px-3 py-2.5 rounded-xl text-[11px] font-semibold disabled:opacity-40"
                style={{ background: "var(--surf-3)", color: "var(--txt-2)", border: "1px solid var(--line)" }}>
                {allVisibleSelected ? "هەڵوەشاندنەوەی هەموو" : "هەڵبژاردنی هەموو"}
              </button>
            </div>

            {selectedActual.length > 0 && (
              <div className="mt-3 p-3 rounded-xl flex items-center justify-between gap-2 flex-wrap"
                style={{ background: "color-mix(in srgb, var(--ac) 7%, var(--surf))", border: "1px solid color-mix(in srgb, var(--ac) 18%, var(--line))" }}>
                <div className="text-[11px] font-semibold" style={{ color: "var(--txt)" }}>
                  <span style={num}>{selectedActual.length}</span> فیش هەڵبژێردراوە
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  <button onClick={confirmSelected} className="px-3 py-2 rounded-lg text-[11px] font-semibold"
                    style={{ background: "var(--pos)", color: "#fff" }}>پشتڕاستکردنەوە</button>
                  <button onClick={retrySelected} className="px-3 py-2 rounded-lg text-[11px] font-semibold"
                    style={{ background: "var(--surf)", color: "var(--txt-2)", border: "1px solid var(--line)" }}>دووبارە خوێندنەوە</button>
                  <button onClick={rejectSelected} className="px-3 py-2 rounded-lg text-[11px] font-semibold"
                    style={{ background: "color-mix(in srgb, var(--neg) 9%, var(--surf))", color: "var(--neg)", border: "1px solid color-mix(in srgb, var(--neg) 20%, var(--line))" }}>ڕەتکردنەوە</button>
                  <button onClick={clearSelected} className="px-3 py-2 rounded-lg text-[11px] font-semibold"
                    style={{ color: "var(--txt-3)" }}>پاککردنەوە</button>
                </div>
              </div>
            )}
          </Card>}

          {retrying.length > 0 && (
            <Card className="p-4 border-[color-mix(in_srgb,var(--warn)_34%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)]">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-start gap-2 text-sm text-[var(--warn)]">
                  <RotateCcw className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-semibold">{retrying.length} فیش بەهۆی کێشەی کاتی خوێندنەوە تەواو نەبوو</div>
                    <div className="text-xs mt-1 opacity-90">ئەم فیشانە ڕەت نەکراونەتەوە و لە کۆی ڕەتکراوەکاندا هەژمار ناکرێن. کەمێک دواتر دووبارە بخوێنەرەوە.</div>
                  </div>
                </div>
                <button onClick={retryWaitingRows} disabled={working}
                  className="px-3 py-2 rounded-lg text-[11px] font-semibold disabled:opacity-50"
                  style={{ background: "var(--surf)", color: "var(--txt-2)", border: "1px solid var(--line)" }}>
                  دووبارە خوێندنەوەی چاوەڕوانەکان
                </button>
              </div>
            </Card>
          )}

          {review.length > 0 && (
            <Card className="p-4 border-[color-mix(in_srgb,var(--warn)_34%,transparent)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)]">
              <div className="flex items-start gap-2 text-sm text-[var(--warn)]">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">{review.length} فیش پێویستیان بە پشکنین هەیە</div>
                  <div className="text-xs mt-1 opacity-90">{simple
                    ? "وێنە بنەڕەتییەکە پارێزراوە؛ ئەدمین بڕ، دراو و ناسنامەی مامەڵە پشکنین دەکات. تا بڕیاری کۆتایی هەژمار ناکرێت."
                    : "بڕ، دراو، ژمارەی مامەڵە و ناوی وەرگر بپشکنە؛ پاشان بە فەرمانی تۆمارکراو بڕیار بدە. تا ئەو کاتە هەژمار ناکرێت."}</div>
                </div>
              </div>
            </Card>
          )}

          {!simple && inspectedReceipt && (
            <DeferredPanel>
              <ReceiptSmartInspector receipt={inspectedReceipt} data={data} lang={_lang}
                Card={Card} Btn={Btn} Pill={Pill} clamp01={clamp01} fmtMoney={fmtMoney} num={num} platMeta={platMeta}
                onEdit={mayEditExtraction(staffReview) ? () => setEditingId(inspectedReceipt.id) : null}
                onConfirm={() => confirmRow(inspectedReceipt.id)}
                onReject={() => rejectRow(inspectedReceipt.id)}
                onRetry={() => retryRow(inspectedReceipt.id)}
                onClose={() => setInspectorId(null)} />
            </DeferredPanel>
          )}

          {visibleRows.length === 0 && (
            <Card className="p-5"><Empty t="هیچ فیشێک بەم فلتەرە نەدۆزرایەوە" /></Card>
          )}

          <div className="space-y-2.5">
            {visibleRows.map((r, i) => {
              const st = ST[r.status] || ST.error;
              const editing = editingId === r.id;
              const hardDup = r.status === "dup";
              return (
                <Card key={r.id} className="p-0 overflow-hidden">
                  <div className={`p-3.5 md:p-4 ${r.status === "dup" ? "bg-[color-mix(in_srgb,var(--neg)_7%,transparent)]" : r.status === "suspect" ? "bg-[color-mix(in_srgb,var(--warn)_7%,transparent)]" : ""}`}>
                    <div className="flex items-start gap-3">
                      {!simple && <label className={`mt-0.5 shrink-0 ${r.status === "processing" ? "opacity-40" : "cursor-pointer"}`}>
                        <input type="checkbox" className="sr-only" disabled={r.status === "processing"}
                          checked={selectedRows.includes(r.id)} onChange={() => toggleSelected(r.id)} />
                        <span className="w-5 h-5 rounded-md flex items-center justify-center"
                          style={selectedRows.includes(r.id)
                            ? { background: "var(--ac)", color: "#fff", border: "1px solid var(--ac)" }
                            : { background: "var(--surf)", color: "transparent", border: "1px solid var(--line-2)" }}>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </span>
                      </label>}
                      <div className="text-[10px] w-5 pt-1 text-center shrink-0" style={{ ...num, color: "var(--txt-3)" }}>{i + 1}</div>
                      {r.url
                        ? simple
                          ? <img src={r.url} alt="وێنەی فیشی پارێزراو" className="w-14 h-14 md:w-16 md:h-16 object-cover rounded-xl shrink-0"
                              style={{ border: "1px solid var(--line)" }} />
                          : <button type="button" onClick={() => setInspectorId(r.id)} className="shrink-0 rounded-xl" aria-label="پشکنینی فیش">
                              <img src={r.url} alt="" className="w-14 h-14 md:w-16 md:h-16 object-cover rounded-xl shrink-0"
                                style={{ border: inspectorId === r.id ? "2px solid var(--ac)" : "1px solid var(--line)" }} />
                            </button>
                        : <div className="w-14 h-14 md:w-16 md:h-16 rounded-xl shrink-0 flex items-center justify-center" style={{ background: "var(--surf-3)" }}>
                            {r.status === "processing" ? <RotateCcw className="w-4 h-4 animate-spin text-[var(--txt-3)]" /> : <Receipt className="w-4 h-4 text-[var(--txt-3)]" />}
                          </div>}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-[var(--txt)] text-[15px]" style={num}>{Number(r.amount) > 0 ? fmtMoney(data, r.amount, r.currency) : "—"}</span>
                          <span className="text-xs text-[var(--txt-2)]">{r.currency || "—"}</span>
                          {Number(r.fee) > 0 && !Number(r.orderAmount) && <span className="text-[10px]" style={{ ...num, color: "var(--txt-3)" }}>فی {fmtMoney(data, r.fee, r.currency)} · نەت {fmtMoney(data, r.net, r.currency)}</span>}
                          <Pill tone={st.tone}>{simple && r.status === "ok" ? "OCR خوێندرایەوە" : st.t}</Pill>
                        </div>
                        {Number(r.orderAmount) > 0 && (
                          <div className="text-[10.5px] mt-1 flex flex-wrap gap-x-2 gap-y-0.5" style={{ ...num, color: "var(--txt-3)" }}>
                            <span>کۆی گشتی {fmtMoney(data, r.amount, r.currency)}</span>
                            <span>· بڕی بنەڕەتی {fmtMoney(data, r.orderAmount, r.currency)}</span>
                            <span>· فی {fmtMoney(data, r.fee, r.currency)}</span>
                            <span>· نەت {fmtMoney(data, r.net, r.currency)}</span>
                            {r.validation?.checked && (
                              <span style={{ color: r.validation.grossMatches ? "var(--pos)" : "var(--warn)" }}>
                                · {r.validation.grossMatches ? "✓ ژمارەکان یەکدەگرنەوە" : "⚠ پشکنینی ژمارەکان"}
                              </span>
                            )}
                          </div>
                        )}
                        <div className="text-[11px] text-[var(--txt-2)] mt-1 truncate">
                          {r.receiver ? <>{tr("بۆ")} <b>{r.receiver}</b></> : <>{tr("وەرگر:")} —</>}
                          {r.refNo && <span style={num}> · {r.refNo}</span>}
                        </div>
                        {r.merchantOrderNo && <div className="text-[10px] text-[var(--txt-3)] mt-0.5" style={num}>Merchant order: {r.merchantOrderNo}</div>}
                        {(r.paymentMethod || r.cardLast4) && <div className="text-[10px] text-[var(--txt-3)] mt-0.5" style={num}>{r.paymentMethod || "Card"}{r.cardLast4 && !String(r.paymentMethod || "").includes(r.cardLast4) ? ` · ****${r.cardLast4}` : ""}</div>}
                        {r.recipientNote && !r.receiver && <div className="text-[10px] text-[var(--txt-3)] mt-0.5">Recipient note: {r.recipientNote}</div>}
                        {r.transactionStatus && <div className="text-[10px] text-[var(--txt-3)] mt-0.5">{r.transactionStatus}</div>}
                        {r.platform && <div className="text-[10px] text-[var(--txt-3)] mt-0.5">{platMeta(r.platform).ku}</div>}
                        {r.note && <div className={`text-[10.5px] mt-1.5 leading-relaxed ${r.status === "suspect" ? "text-[var(--warn)]" : r.status === "dup" ? "text-[var(--neg)]" : "text-[var(--txt-3)]"}`}>{r.note}</div>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {/* An uploader supplies the image; the figures come from the evidence.
                            They may look, and report a discrepancy — they may not retype what
                            the receipt says. */}
                        {r.status !== "processing" && !hardDup && (
                          mayEditExtraction(staffReview) ? (
                            <button title="پشکنین و دەستکاری" onClick={() => { setInspectorId(r.id); setEditingId(editing ? null : r.id); }}
                              className="p-2 rounded-lg hover:bg-[var(--surf-3)] text-[var(--txt-2)]"><Pencil className="w-3.5 h-3.5" /></button>
                          ) : (
                            <button title="بینینی وردەکاری" onClick={() => setInspectorId(r.id)}
                              className="p-2 rounded-lg hover:bg-[var(--surf-3)] text-[var(--txt-2)]"><Eye className="w-3.5 h-3.5" /></button>
                          )
                        )}
                        {r.status !== "processing" && !hardDup && r.ocrImage && (
                          <button title="دووبارە خوێندنەوە" onClick={() => retryRow(r.id)}
                            className="p-2 rounded-lg hover:bg-[var(--surf-3)] text-[var(--txt-2)]"><RotateCcw className="w-3.5 h-3.5" /></button>
                        )}
                        {!simple && <button title="سڕینەوە" onClick={() => { commitRows((xs) => xs.filter((x) => x.id !== r.id)); if (editingId === r.id) setEditingId(null); if (inspectorId === r.id) setInspectorId(null); }}
                          className="p-2 rounded-lg hover:bg-[color-mix(in_srgb,var(--neg)_9%,transparent)] text-[var(--txt-3)] hover:text-[var(--neg)]"><Trash2 className="w-3.5 h-3.5" /></button>}
                      </div>
                    </div>

                    {editing && mayEditExtraction(staffReview) && !hardDup && r.status !== "processing" && (
                      <div className="mt-4 pt-4 border-t border-[var(--line)]">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div>
                            <div className="text-[12px] font-semibold text-[var(--txt)]">پشکنینی دەستی فیش</div>
                            <div className="text-[10.5px] text-[var(--txt-3)] mt-0.5">ئەو خانانەی دڵنیاییان نزمە بە تایبەتی بپشکنە.</div>
                          </div>
                          <button onClick={() => setEditingId(null)} className="p-1.5 text-[var(--txt-3)]"><X className="w-4 h-4" /></button>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div><div className="flex justify-between"><Lbl>بڕ</Lbl>{fieldConf(r, "amount")}</div><Inp type="number" value={r.amount ?? ""} onChange={(e) => editField(r.id, "amount", e.target.value)} /></div>
                          <div><div className="flex justify-between"><Lbl>دراو</Lbl>{fieldConf(r, "currency")}</div><Inp value={r.currency ?? ""} onChange={(e) => editField(r.id, "currency", e.target.value.toUpperCase())} placeholder="IQD / USD / CNY..." /></div>
                          <div><div className="flex justify-between"><Lbl>فی / عمولە</Lbl>{fieldConf(r, "fee")}</div><Inp type="number" value={r.fee ?? ""} onChange={(e) => editField(r.id, "fee", e.target.value)} /></div>
                          <div><Lbl>بڕی نەت</Lbl><Inp type="number" value={r.net ?? ""} onChange={(e) => editField(r.id, "net", e.target.value)} /></div>
                          <div><div className="flex justify-between"><Lbl>{l10n("بڕی بنەڕەتی", "Order amount", "مبلغ الطلب الأساسي")}</Lbl>{fieldConf(r, "orderAmount")}</div><Inp type="number" value={r.orderAmount ?? ""} onChange={(e) => editField(r.id, "orderAmount", e.target.value)} /></div>
                          <div><div className="flex justify-between"><Lbl>{l10n("ژمارەی مامەڵە", "Order number", "رقم الطلب")}</Lbl>{fieldConf(r, "refNo")}</div><Inp value={r.refNo ?? ""} onChange={(e) => editField(r.id, "refNo", e.target.value)} /></div>
                          <div><div className="flex justify-between"><Lbl>{l10n("ژمارەی مامەڵەی فرۆشیار", "Merchant order number", "رقم طلب التاجر")}</Lbl>{fieldConf(r, "merchantOrderNo")}</div><Inp value={r.merchantOrderNo ?? ""} onChange={(e) => editField(r.id, "merchantOrderNo", e.target.value)} /></div>
                          <div><div className="flex justify-between"><Lbl>{l10n("شێوازی پارەدان", "Payment method", "طريقة الدفع")}</Lbl>{fieldConf(r, "paymentMethod")}</div><Inp value={r.paymentMethod ?? ""} onChange={(e) => editField(r.id, "paymentMethod", e.target.value)} placeholder="Visa / Mastercard..." /></div>
                          <div><Lbl>{l10n("کۆتا ٤ ژمارەی کارت", "Card last 4 digits", "آخر 4 أرقام من البطاقة")}</Lbl><Inp value={r.cardLast4 ?? ""} onChange={(e) => editField(r.id, "cardLast4", e.target.value.replace(/\D/g, "").slice(-4))} placeholder="0233" /></div>
                          <div><div className="flex justify-between"><Lbl>{l10n("دۆخی مامەڵە", "Transaction status", "حالة المعاملة")}</Lbl>{fieldConf(r, "transactionStatus")}</div><Inp value={r.transactionStatus ?? ""} onChange={(e) => editField(r.id, "transactionStatus", e.target.value)} /></div>
                          <div><Lbl>{l10n("تێبینی وەرگر", "Recipient note", "ملاحظة المستفيد")}</Lbl><Inp value={r.recipientNote ?? ""} onChange={(e) => editField(r.id, "recipientNote", e.target.value)} /></div>
                          <div><Lbl>{l10n("ناوی فرۆشیار", "Merchant display name", "اسم التاجر الظاهر")}</Lbl><Inp value={r.merchantName ?? ""} onChange={(e) => editField(r.id, "merchantName", e.target.value)} /></div>
                          <div><div className="flex justify-between"><Lbl>وەرگر</Lbl>{fieldConf(r, "receiver")}</div><Inp value={r.receiver ?? ""} onChange={(e) => editField(r.id, "receiver", e.target.value)} /></div>
                          <div><div className="flex justify-between"><Lbl>ناردەر</Lbl>{fieldConf(r, "sender")}</div><Inp value={r.sender ?? ""} onChange={(e) => editField(r.id, "sender", e.target.value)} /></div>
                          <div><div className="flex justify-between"><Lbl>ئەپ / بانک</Lbl>{fieldConf(r, "platform")}</div><Inp value={r.bank ?? r.platform ?? ""} onChange={(e) => { editField(r.id, "bank", e.target.value); editField(r.id, "platform", detectPlatform(e.target.value) || r.platform); }} /></div>
                          <div><div className="flex justify-between"><Lbl>بەروار</Lbl>{fieldConf(r, "txDate")}</div><Inp type="date" value={r.txDate ?? ""} onChange={(e) => editField(r.id, "txDate", e.target.value)} /></div>
                          <div><div className="flex justify-between"><Lbl>کات / دەقی کات</Lbl>{fieldConf(r, "txTime")}</div><Inp value={r.txTime ?? ""} onChange={(e) => editField(r.id, "txTime", e.target.value)} /></div>
                        </div>

                        <div className="flex flex-wrap gap-2 mt-4">
                          <Btn className="flex items-center gap-2" onClick={() => confirmRow(r.id)}>
                            <CheckCircle2 className="w-4 h-4" /> پشتڕاستکردنەوە
                          </Btn>
                          {r.ocrImage && <Btn kind="ghost" className="flex items-center gap-2" onClick={() => retryRow(r.id)}><RotateCcw className="w-4 h-4" /> دووبارە خوێندنەوە</Btn>}
                          <Btn kind="ghost" className="flex items-center gap-2" style={{ color: "var(--neg)" }} onClick={() => rejectRow(r.id)}>
                            <XCircle className="w-4 h-4" /> ڕەتکردنەوە
                          </Btn>
                        </div>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>

          {good.length > 0 && <ReceiptTotals rows={good} data={data} title={tr("کۆی گشتی")} showValuation={staffReview} />}

          {!simple && good.length > 0 && (
            <Btn kind="gold" className="w-full flex items-center justify-center gap-2" onClick={() => setShare(true)}>
              <Share2 className="w-4 h-4" /> {tr("ناردنی خشتەی وردەکاری")}
            </Btn>
          )}
          {!simple && share && (
            <ShareTable rows={good} data={data} who={displayValue(customerName)} title={tr("وردەکاری فیشەکان")}
              flash={flash} onClose={() => setShare(false)} />
          )}

          {!simple && bad.length > 0 && <RejectedReceipts rows={bad} data={data} title={tr("ئەمانە هەژمار ناکرێن")} />}

          {resumedSend && (
            <Card className="p-4" style={{ borderColor: "color-mix(in srgb, var(--pos) 35%, var(--line))", background: "color-mix(in srgb, var(--pos) 8%, var(--surf))" }}>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--pos)" }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-bold" style={{ color: "var(--pos)" }}>{resumedSend.text}</div>
                  {resumedSend.receiptCount != null && (
                    <div className="text-[11px] mt-1" style={{ color: "var(--txt-2)" }}>
                      {resumedSend.receiptCount} {tr("فیش")}
                      {resumedSend.at ? ` · ${new Date(resumedSend.at).toLocaleString("en-GB")}` : ""}
                    </div>
                  )}
                </div>
                <button onClick={() => setResumedSend(null)} className="p-1.5 rounded-lg" style={{ color: "var(--txt-3)" }}><X className="w-4 h-4" /></button>
              </div>
            </Card>
          )}

          {sendError && (
            <Card className="p-4" style={{ borderColor: "color-mix(in srgb, var(--neg) 35%, var(--line))", background: "color-mix(in srgb, var(--neg) 7%, var(--surf))" }}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--neg)" }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-bold" style={{ color: "var(--neg)" }}>{sendError.message}</div>
                  {sendError.detail && <div className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--txt-2)" }}>{sendError.detail}</div>}
                  {sendError.requestId && <div className="text-[10px] mt-1" dir="ltr" style={{ color: "var(--txt-3)" }}>Support code: {sendError.requestId}</div>}
                  <div className="text-[10.5px] mt-2" style={{ color: sendError.outcomeUnknown ? "var(--warn)" : "var(--txt-3)" }}>
                    {sendError.outcomeUnknown
                      ? "دۆخی DB بە دڵنیایی نەزانرا؛ وێنەکان پاک نەکرانەوە. هەمان ناردن دووبارە بکە—command key پارێزراوە و دووبارە تۆمار نابێت."
                      : "فیشەکان لێرە ماونەتەوە؛ دوای چارەسەرکردنی هەڵەکە دەتوانیت هەمان ناردن دووبارە بکەیتەوە."}
                  </div>
                </div>
                <button onClick={() => setSendError(null)} className="p-1.5 rounded-lg" style={{ color: "var(--txt-3)" }}><X className="w-4 h-4" /></button>
              </div>
            </Card>
          )}

          {/* Only someone who can actually put a reading right is held up by one. An uploader
              cannot correct anything, so a receipt awaiting review would leave them with a dead
              button and no way forward — theirs is sent along, marked, for the operator. */}
          <Btn className={`w-full ${simple ? "!py-4 !text-[15px] sticky bottom-20 z-10" : ""}`} onClick={send}
            disabled={sending || working || processing.length > 0 || retrying.length > 0
              || (review.length > 0 && mayEditExtraction(staffReview))
              || (!good.length && !review.length && !bad.length)}>
            {sending
              ? "ناردن..."
              : review.length && mayEditExtraction(staffReview)
                ? `${review.length} فیش پێویستی بە پشکنین هەیە`
                : retrying.length
                  ? `${retrying.length} فیش چاوەڕوانی دووبارە خوێندنەوەن`
                  : `ناردنی ${good.length} فیش${review.length + bad.length ? ` (+ ${review.length + bad.length} بۆ پشکنینی ئەدمین)` : ""}`}
          </Btn>
        </>
      )}
    </div>
  );
}

/* ─────────── ناوەندی فیشەکان (ئەدمین) ─────────── */
function ReceiptsHub({ data, usr, batches, batchLoadError, reloadBatches, flash, onMakeTx, profile, calc, cur, searchFocus = "" }) {
  const initialReceiptQuery = useMemo(() => new URLSearchParams(window.location.search), []);
  const [tab, setTab] = useState(initialReceiptQuery.get("receiptTab") || "inbox");
  const [sel, setSel] = useState(null);
  const [loc, setLoc] = useState("me");
  const [addFor, setAddFor] = useState("");
  const [addTxId, setAddTxId] = useState("");
  const [addReason, setAddReason] = useState("");
  const [batchSearch, setBatchSearch] = useState(initialReceiptQuery.get("receiptSearch") || "");
  // Arriving here from the global search: open on the batch the result was about, with the
  // control tab showing, rather than at the top of a list of two hundred.
  useEffect(() => {
    if (!searchFocus) return;
    setBatchSearch(searchFocus);
    setTab("control");
    setStageFilter("all");
    setBatchPage(1);
  }, [searchFocus]);
  const [stageFilter, setStageFilter] = useState(initialReceiptQuery.get("receiptStage") || "all");
  const [batchSort, setBatchSort] = useState(initialReceiptQuery.get("receiptSort") || "newest");
  const [batchPage, setBatchPage] = useState(1);
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  const addTransactions = data.txs.filter((tx) => !tx.deleted && tx.cpId === addFor
    && (tx.type === "buy" || (tx.type === "sell" && tx.partnerId)));
  const u = usdConv(data);

  const newN = (batches || []).filter((b) => b.status === "new").length;
  const inbox = (batches || []).filter((b) => (tab === "inbox" ? b.status === "new" : b.status !== "new"));

  const waN = (batches || []).filter((b) => b.status === "new" && b.source === "whatsapp").length;
  const TABS = [["inbox", `${l10n("فیشی نوێ", "New receipts", "إيصالات جديدة")} (${newN})`], ["done", tr("بەستراوەکان")], ["add", tr("ناردنی فیش")], ["control", l10n("هەموو فیشەکان", "All receipts", "كل الإيصالات")]];
  const lifecycleOf = (b) => b.receipt_stage || (b.tx_id ? "matched" : b.status === "new" ? "needs_review" : "verified");
  const lifecycleTone = (stage) => stage === "matched" || stage === "finalized" ? "green" : stage === "rejected" ? "red" : stage === "archived" ? "slate" : "amber";
  const lifecycleLabel = (stage) => ({ received: l10n("وەرگیرا", "Received", "مستلم"), reading: l10n("دەخوێندرێتەوە", "Reading", "قيد القراءة"), needs_review: l10n("پشکنین پێویستە", "Needs review", "بحاجة إلى مراجعة"), verified: l10n("پشتڕاستکراو", "Verified", "موثّق"), matched: l10n("بەستراو", "Matched", "مرتبط"), rejected: l10n("ڕەتکراو", "Rejected", "مرفوض"), finalized: l10n("کۆتایی‌هاتوو", "Finalized", "مغلق نهائياً"), archived: l10n("ئەرشیفکراو", "Archived", "مؤرشف") }[stage] || stage);
  const summary = (batches || []).reduce((out, b) => {
    const stage = lifecycleOf(b); out.total += Number(b.n) || 0; out[stage] = (out[stage] || 0) + (Number(b.n) || 0);
    out.duplicates += Number(b.dup_n) || 0; out.failed += Number(b.rejected_n) || 0; return out;
  }, { total: 0, reading: 0, needs_review: 0, verified: 0, matched: 0, rejected: 0, finalized: 0, archived: 0, duplicates: 0, failed: 0 });
  const filteredBatches = (batches || []).filter((b) => {
    const query = normalizeSearchText(batchSearch);
    const haystack = normalizeSearchText([b.id, b.customer_name, b.partner_id && usr(b.partner_id).name, b.source, b.currency].filter(Boolean).join(" "));
    return (!query || haystack.includes(query)) && (stageFilter === "all" || lifecycleOf(b) === stageFilter);
  }).sort((a, b) => batchSort === "oldest" ? new Date(a.created_at) - new Date(b.created_at)
    : batchSort === "amount" ? Number(b.total_net || 0) - Number(a.total_net || 0)
      : batchSort === "status" ? lifecycleOf(a).localeCompare(lifecycleOf(b)) : new Date(b.created_at) - new Date(a.created_at));
  const pageSize = 20, pageBatches = filteredBatches.slice(0, batchPage * pageSize);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    [["receiptTab", tab], ["receiptSearch", batchSearch], ["receiptStage", stageFilter], ["receiptSort", batchSort]].forEach(([key, value]) => value && value !== "all" && value !== "newest" ? q.set(key, value) : q.delete(key));
    window.history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
  }, [tab, batchSearch, stageFilter, batchSort]);

  if (sel) return <BatchDetail id={sel} back={() => { setSel(null); reloadBatches(); }} usr={usr} data={data} profile={profile} onMakeTx={onMakeTx} flash={flash} reloadBatches={reloadBatches} />;

  return (
    <div className="space-y-4">
      <H sub={l10n("فیشەکانی کڕیاران و هاوبەشان — پشکنین، کۆکردنەوە و بەستنەوە بە مامەڵە", "Customer and partner receipts — review, reconcile, and match to transactions", "إيصالات الزبائن والشركاء — مراجعة وتسوية وربط بالمعاملات")}>{tr("فیشەکان")}</H>

      {batchLoadError && <StatePanel type="error" title="لیستی فیشەکان بار نەبوو" detail={batchLoadError} onRetry={reloadBatches} compact />}

      <div className="flex gap-1 rounded-[var(--r)] p-1 overflow-x-auto" style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
        {TABS.map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            style={tab === k ? { background: "linear-gradient(180deg, var(--ac), var(--pos))", color: "#fff", boxShadow: "0 2px 8px -2px rgba(14,122,107,.4)" } : { color: "var(--txt-2)" }}
            className={`flex-1 whitespace-nowrap px-3 py-2.5 rounded-[var(--r-sm)] text-sm transition-all tap ${tab === k ? "font-bold" : "font-medium hover:bg-[var(--line)]"}`}>{t}</button>
        ))}
      </div>

      {tab === "control" && <>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2" role="status" aria-label={l10n("پوختەی فیشە هەڵگیراوەکان", "Persisted receipt summary", "ملخص الإيصالات المحفوظة")}>
          {[[l10n("کۆ", "Total", "المجموع"), summary.total], ...["reading", "needs_review", "verified", "matched", "rejected", "finalized", "archived"].map((stage) => [lifecycleLabel(stage), summary[stage]])].map(([label, value]) => <Card key={label} className="p-3"><div className="text-[10px] text-[var(--txt-3)]">{label}</div><div className="text-xl font-bold mt-1" style={num}>{value}</div></Card>)}
        </div>
        <Card className="p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-[minmax(240px,1fr)_180px_160px] gap-2">
            <label className="relative"><span className="sr-only">{l10n("گەڕان لە کۆمەڵە فیشەکان", "Search receipt batches", "البحث في دُفعات الإيصالات")}</span><Search className="absolute start-3 top-3 w-4 h-4 text-[var(--txt-3)]"/><Inp className="ps-9" value={batchSearch} onChange={(e) => { setBatchSearch(e.target.value); setBatchPage(1); }} placeholder={l10n("ناسنامە، کڕیار، هاوبەش، پلاتفۆرم یان دراو…", "Batch ID, customer, partner, platform, or currency…", "معرّف الدفعة أو الزبون أو الشريك أو المنصة أو العملة…")} /></label>
            <Sel aria-label={l10n("فلتەری ڕێڕەو", "Lifecycle filter", "تصفية دورة الإيصال")} value={stageFilter} onChange={(e) => { setStageFilter(e.target.value); setBatchPage(1); }}><option value="all">{l10n("هەموو دۆخەکان", "All lifecycle states", "جميع الحالات")}</option>{["received","reading","needs_review","verified","matched","rejected","finalized","archived"].map((x) => <option value={x} key={x}>{lifecycleLabel(x)}</option>)}</Sel>
            <Sel aria-label={l10n("ڕیزکردنی کۆمەڵەکان", "Sort batches", "ترتيب الدُفعات")} value={batchSort} onChange={(e) => setBatchSort(e.target.value)}><option value="newest">{l10n("نوێترین", "Newest", "الأحدث")}</option><option value="oldest">{l10n("کۆنترین", "Oldest", "الأقدم")}</option><option value="amount">{l10n("بڕ", "Amount", "المبلغ")}</option><option value="status">{l10n("دۆخ", "Status", "الحالة")}</option></Sel>
          </div>
          {!pageBatches.length ? <StatePanel type="empty" title={l10n("هیچ کۆمەڵەیەک نەدۆزرایەوە", "No receipt batches match", "لم يتم العثور على دفعات مطابقة")} compact /> : <div className="space-y-2">{pageBatches.map((b) => <button type="button" key={b.id} onClick={() => setSel(b.id)} className="w-full min-h-14 text-start rounded-xl p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ac)]" style={{ background: "var(--surf-2)", border: "1px solid var(--line)" }} aria-label={l10n(`کردنەوەی کۆمەڵەی ${b.id}`, `Open batch ${b.id}`, `فتح الدفعة ${b.id}`)}><div className="flex justify-between gap-3"><div className="min-w-0"><div className="font-bold truncate">{b.customer_name || (b.partner_id ? usr(b.partner_id).name : b.id)}</div><div className="text-[10px] text-[var(--txt-3)] mt-1" dir="ltr">{b.id} · {new Date(b.created_at).toLocaleString("en-GB")}</div></div><div className="text-end shrink-0"><Pill tone={lifecycleTone(lifecycleOf(b))}>{lifecycleLabel(lifecycleOf(b))}</Pill><div className="text-xs font-bold mt-1" style={num}>{fmtMoney(data, b.total_net, b.currency)} {b.currency}</div></div></div></button>)}</div>}
          {pageBatches.length < filteredBatches.length && <Btn kind="ghost" className="w-full" onClick={() => setBatchPage((p) => p + 1)}>{l10n(`${Math.min(pageSize, filteredBatches.length - pageBatches.length)} دانەی تر`, `Load ${Math.min(pageSize, filteredBatches.length - pageBatches.length)} more`, `تحميل ${Math.min(pageSize, filteredBatches.length - pageBatches.length)} إضافية`)}</Btn>}
          <div className="text-[10px] text-[var(--txt-3)]" aria-live="polite">{l10n(`${pageBatches.length} لە ${filteredBatches.length} کۆمەڵە نیشان دەدرێت؛ بارکردنی سێرڤەر سنووردارە بە ٢٠٠ کۆمەڵە.`, `Showing ${pageBatches.length} of ${filteredBatches.length}; server load is bounded to 200 batches.`, `يتم عرض ${pageBatches.length} من ${filteredBatches.length}؛ تحميل الخادم محدود بـ200 دفعة.`)}</div>
        </Card>
      </>}

      {(tab === "inbox" || tab === "done") && (
        inbox.length === 0 ? <Card><Empty t={tab === "inbox" ? "هیچ کۆمەڵەیەکی نوێ نییە" : "هیچ نییە"} /></Card> :
          inbox.map((b, i) => (
            <Card key={b.id} className="p-4 rise" style={{ animationDelay: `${i * 40}ms` }} onClick={() => setSel(b.id)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--txt)]">{b.customer_name || (b.partner_id ? usr(b.partner_id).name : "—")}</div>
                  <div className="text-xs text-[var(--txt-2)] mt-0.5" style={num}>{b.n} فیش · {new Date(b.created_at).toLocaleString("en-GB")}</div>
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">
                    {b.source === "whatsapp" && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-600 text-white flex items-center gap-1">
                        <MessageCircle className="w-3 h-3" /> {tr("واتساپ")}
                      </span>
                    )}
                    <Pill tone={b.direction === "out" ? "amber" : "green"}>{DIR_KU[b.direction || "in"]}</Pill>
                    <Pill tone={lifecycleTone(lifecycleOf(b))}>{lifecycleLabel(lifecycleOf(b))}</Pill>
                    {(b.rejected_n || b.dup_n) > 0 && <Pill tone="red">{b.rejected_n || b.dup_n} ڕەتکراو</Pill>}
                    {b.partner_id && <Pill tone="amber">لای {usr(b.partner_id).name}</Pill>}
                  </div>
                </div>
                <div className="text-left shrink-0">
                  <div className="text-xl font-bold text-[var(--pos)]" style={num}>{fmtMoney(data, b.total_net, b.currency)}</div>
                  <div className="text-[11px] text-[var(--txt-3)]">{b.currency} بێ فی</div>
                  {u(b.total_net, b.currency) != null && <div className="text-[11px] text-[var(--txt-2)]" style={num}>≈ {fmt(u(b.total_net, b.currency), 0)} $</div>}
                  {b.total_fee > 0 && <div className="text-[10px] text-[var(--txt-3)]" style={num}>بە فی {fmtMoney(data, b.total_gross, b.currency)}</div>}
                </div>
              </div>
            </Card>
          ))
      )}

      {tab === "loc" && (
        <>
          <div className="flex gap-1 rounded-[var(--r)] p-1 overflow-x-auto" style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
            <button onClick={() => setLoc("me")}
              className={`whitespace-nowrap px-4 py-2 rounded-lg text-sm ${loc === "me" ? "bg-slate-900 text-white font-semibold" : "text-[var(--txt-2)]"}`}>{tr("لای خۆم")}</button>
            {partners.map((p) => (
              <button key={p.id} onClick={() => setLoc(p.id)}
                className={`whitespace-nowrap px-4 py-2 rounded-lg text-sm ${loc === p.id ? "bg-[var(--pos)] text-white font-semibold" : "text-[var(--txt-2)]"}`}>{p.name}</button>
            ))}
          </div>
          <LocationReceipts partnerId={loc === "me" ? null : loc} data={data} flash={flash}
            title={loc === "me" ? "فیشەکانی لای خۆم" : `فیشەکانی لای ${usr(loc).name}`} />
        </>
      )}

      {tab === "wa" && <WhatsAppInfo batches={batches} waN={waN} />}

      {tab === "add" && (
        <Card className="p-5">
          <SecLbl>{tr("ناردنی فیش لە جیاتی کەسێک")}</SecLbl>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <Lbl>{tr("کڕیار")}</Lbl>
              <Sel value={addFor} onChange={(e) => { setAddFor(e.target.value); setAddTxId(""); }}>
                <option value="">{tr("هەڵبژێرە...")}</option>
                {customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Sel>
            </div>
            <div>
              <Lbl>{tr("مامەڵەی دیاریکراو")}</Lbl>
              <Sel value={addTxId} onChange={(event) => setAddTxId(event.target.value)} disabled={!addFor}>
                <option value="">{tr("هەڵبژێرە...")}</option>
                {addTransactions.map((tx) => (
                  <option key={tx.id} value={tx.id}>
                    {tx.id} · {tx.type === "buy" ? tr("کڕیار فرۆشتوویەتی") : tr("کڕیار کڕیویەتی")}
                  </option>
                ))}
              </Sel>
            </div>
            <div className="md:col-span-2">
              <Lbl>{tr("هۆکاری ناردن لە جیاتی بەکارهێنەر (لانیکەم ٨ پیت)")}</Lbl>
              <Inp value={addReason} onChange={(event) => setAddReason(event.target.value)} maxLength={700} />
            </div>
          </div>
          {/* direction={addDir} used to be below, and addDir is declared nowhere in this file. It
              threw ReferenceError during render, so the staff screen for adding a customer's
              receipts went blank the moment a customer was chosen. `allowDirection` is already
              set, which means the uploader offers the choice itself — so what belongs here is the
              starting value, and "in" is the one a customer-seller's evidence always has. */}
          {addFor && (
            <ReceiptUploader customerId={addFor} customerName={usr(addFor).name} uploaderId={profile?.id}
              data={data} direction="in" allowDirection flash={flash} staffReview role={profile?.role}
              adminOverrideReason={addReason}
              onDone={() => { setAddFor(""); reloadBatches(); setTab("inbox"); }} />
          )}
        </Card>
      )}
    </div>
  );
}

/* ─────────── خشتەی وردەکاری بۆ ناردن ─────────── */
function ShareTable({ rows, data, who, title, onClose, flash }) {
  const [mode, setMode] = useState("full");
  const [phone, setPhone] = useState("");
  const u = usdConv(data);
  const today = new Date().toLocaleDateString("en-GB");

  const counted = (rows || []).filter((r) => r.counted !== false && r.status !== "dup" && r.status !== "error");
  const rejected = (rows || []).filter((r) => r.counted === false || r.status === "dup" || r.status === "error");

  const gross = {}, fees = {}, net = {}, byWho = {}, byPlat = {};
  counted.forEach((r) => {
    const c = r.currency || "?";
    const g = +(r.amount) || 0, f = +(r.fee) || 0;
    const n = r.net != null ? +r.net : (r.net_amount != null ? +r.net_amount : g - f);
    gross[c] = (gross[c] || 0) + g; fees[c] = (fees[c] || 0) + f; net[c] = (net[c] || 0) + n;
    const k = (r.receiver || r.sender || "نەزانراو").trim();
    byWho[k] = byWho[k] || { n: 0, cur: {} };
    byWho[k].n++; byWho[k].cur[c] = (byWho[k].cur[c] || 0) + n;
    const pl = r.platform || detectPlatform(r.bank) || "نەزانراو";
    byPlat[pl] = byPlat[pl] || { n: 0, cur: {} };
    byPlat[pl].n++; byPlat[pl].cur[c] = (byPlat[pl].cur[c] || 0) + n;
  });
  const curs = Object.keys(gross);
  const whoList = Object.entries(byWho).sort((a, b) => b[1].n - a[1].n);
  const platList = Object.entries(byPlat).sort((a, b) => b[1].n - a[1].n);

  /* ── دەقی واتساپ ── */
  const text = (() => {
    const L = [];
    L.push(`*${title || "وردەکاری فیشەکان"}*`);
    if (who) L.push(`👤 ${who}`);
    L.push(`📅 ${today}`);
    L.push("");

    if (mode === "rej") {
      L.push(`⚠️ *${rejected.length} فیش ڕەت کراوەتەوە*`);
      L.push("");
      rejected.forEach((r, i) => {
        const amt = r.amount ? `${fmtMoney(data, r.net_amount ?? r.net ?? r.amount, r.currency)} ${r.currency || ""}` : "—";
        L.push(`${i + 1}. ${amt}`);
        L.push(`   ❌ ${r.reject_reason || r.rejectReason || r.note || tr("نەزانراو")}`);
        const bits = [];
        if (r.ref_no || r.refNo) bits.push(`ژمارە: ${r.ref_no || r.refNo}`);
        if (r.tx_time || r.txTime) bits.push(`کات: ${r.tx_time || r.txTime}`);
        if (bits.length) L.push(`   ${bits.join(" · ")}`);
        const od = r.dup_of_date || r.dupOfDate;
        if (od) L.push(`   ↩️ ڕەسەنەکەی: ${new Date(od).toLocaleString("en-GB")}${(r.dup_of_who || r.dupOfWho) ? ` — ${r.dup_of_who || r.dupOfWho}` : ""}`);
        L.push("");
      });
      return L.join("\n");
    }

    if (mode !== "short") {
      L.push("```");
      L.push("#   بڕ         فی    گەیشتوو   وەرگر");
      L.push("───────────────────────────────────────");
      counted.forEach((r, i) => {
        const n = r.net != null ? +r.net : (r.net_amount ?? r.amount);
        const num2 = String(i + 1).padEnd(3);
        const am = fmtMoney(data, r.amount, r.currency).padStart(9);
        const fe = (r.fee ? fmtMoney(data, r.fee, r.currency) : "—").padStart(5);
        const nt = fmtMoney(data, n, r.currency).padStart(9);
        const rc = String(r.receiver || "—").slice(0, 12);
        L.push(`${num2} ${am} ${fe} ${nt}  ${rc}`);
      });
      L.push("```");
      L.push("");
    }

    if (platList.length > 1) {
      L.push("*بەپێی پلاتفۆرم*");
      platList.forEach(([pl, v]) => {
        const t = Object.entries(v.cur).map(([c, a]) => `${fmtMoney(data, a, c)} ${c}`).join(" / ");
        L.push(`• ${platMeta(pl).ku}: ${t}  (${v.n})`);
      });
      L.push("");
    }

    L.push("*بەپێی وەرگر*");
    whoList.forEach(([n, v]) => {
      const t = Object.entries(v.cur).map(([c, a]) => `${fmtMoney(data, a, c)} ${c}`).join(" / ");
      L.push(`• ${n}: ${t}  (${v.n})`);
    });
    L.push("");

    L.push("*کۆی گشتی*");
    curs.forEach((c) => {
      L.push(`${c}:`);
      L.push(`   بە فییەوە: ${fmtMoney(data, gross[c], c)}`);
      if (fees[c] > 0) L.push(`   فی: −${fmtMoney(data, fees[c], c)}`);
      L.push(`   ✅ گەیشتوو: ${fmtMoney(data, net[c], c)}`);
      const usd = u(net[c], c);
      if (usd != null) L.push(`   ≈ ${fmt(usd, 0)} USD`);
    });
    L.push("");
    L.push(`📄 ${counted.length} فیش هەژمار کراوە`);

    if (rejected.length) {
      L.push("");
      L.push(`⚠️ *${rejected.length} فیش ڕەت کراوەتەوە — هەژمار نەکراون*`);
      L.push("");
      rejected.forEach((r, i) => {
        const amt = r.amount ? `${fmtMoney(data, r.net_amount ?? r.net ?? r.amount, r.currency)} ${r.currency || ""}` : "—";
        L.push(`${i + 1}. ${amt}`);
        L.push(`   ❌ ${r.reject_reason || r.rejectReason || r.note || REJECT_KU[r.reject_code || r.rejectCode] || "نەزانراو"}`);
        const bits = [];
        if (r.ref_no || r.refNo) bits.push(`ژمارە: ${r.ref_no || r.refNo}`);
        if (r.tx_time || r.txTime) bits.push(`کات: ${r.tx_time || r.txTime}`);
        if (r.receiver) bits.push(`وەرگر: ${r.receiver}`);
        if (bits.length) L.push(`   ${bits.join(" · ")}`);
        const od = r.dup_of_date || r.dupOfDate;
        if (od) L.push(`   ↩️ ڕەسەنەکەی: ${new Date(od).toLocaleString("en-GB")}${(r.dup_of_who || r.dupOfWho) ? ` — ${r.dup_of_who || r.dupOfWho}` : ""}`);
      });
    }
    return L.join("\n");
  })();

  const cleanPhone = (p) => {
    let x = String(p).replace(/\D/g, "");
    if (x.startsWith("00")) x = x.slice(2);
    if (x.startsWith("0")) x = "964" + x.slice(1);       // عێراق
    return x;
  };

  const sendWa = () => {
    const p = cleanPhone(phone);
    const url = p
      ? `https://wa.me/${p}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank");
  };
  const copy = () => navigator.clipboard.writeText(text).then(() => flash(tr("کۆپی کرا ✓")));

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end md:items-center justify-center md:p-6" onClick={onClose}>
      <div className="w-full max-w-lg rounded-t-[28px] md:rounded-[24px] max-h-[90vh] overflow-y-auto sheet" style={{ background: "var(--surf)", boxShadow: "var(--sh-3)" }} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 px-5 py-4 flex items-center justify-between backdrop-blur-xl" style={{ background: "color-mix(in srgb, var(--surf) 92%, transparent)", borderBottom: "1px solid var(--line)" }}>
          <div className="font-bold text-[var(--txt)]">{tr("ناردنی خشتە")}</div>
          <button onClick={onClose} className="p-1.5 text-[var(--txt-3)]"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex gap-1 bg-[var(--line)] rounded-[var(--r-sm)] p-1">
            {[["full", tr("خشتەی تەواو")], ["short", tr("تەنها کۆکان")], ["rej", tr("تەنها ڕەتکراوەکان")]].map(([k, t]) => (
              <button key={k} onClick={() => setMode(k)}
                className={`flex-1 py-2 rounded-lg text-sm ${mode === k ? "bg-[var(--surf)] text-[var(--pos)] font-bold shadow-sm" : "text-[var(--txt-2)]"}`}>{t}</button>
            ))}
          </div>

          {/* پێشبینین */}
          <div className="border border-[var(--line)] rounded-[var(--r)] overflow-hidden">
            <div className="bg-slate-900 text-white px-4 py-3">
              <div className="font-bold">{title || "وردەکاری فیشەکان"}</div>
              <div className="text-xs text-[var(--txt-3)] mt-0.5">{who ? `${who} · ` : ""}<span style={num}>{today}</span></div>
            </div>
            <div className="p-4 space-y-3">
              {mode === "full" && counted.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[var(--txt-3)] border-b border-[var(--line)]">
                        <th className="text-right py-1.5 w-6">#</th>
                        <th className="text-right">{tr("بڕ")}</th>
                        <th className="text-right">{tr("فی")}</th>
                        <th className="text-right">{tr("گەیشتوو")}</th>
                        <th className="text-right">{tr("وەرگر")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {counted.map((r, i) => (
                        <tr key={r.id || i} className="border-b border-[var(--line)]">
                          <td className="py-1.5 text-[var(--txt-3)]" style={num}>{i + 1}</td>
                          <td style={num}>{fmtMoney(data, r.amount, r.currency)}</td>
                          <td style={num} className={r.fee ? "text-[var(--neg)]" : "text-[var(--txt-3)]"}>{r.fee ? fmtMoney(data, r.fee, r.currency) : "—"}</td>
                          <td style={num} className="font-bold">{fmtMoney(data, r.net ?? r.net_amount ?? r.amount, r.currency)}</td>
                          <td className="text-[var(--txt-2)] truncate max-w-[80px]">{r.receiver || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {platList.length > 1 && (
                <div>
                  <div className="text-[10px] font-bold text-[var(--txt-3)] uppercase mb-1">{tr("بەپێی پلاتفۆرم")}</div>
                  {platList.map(([pl, v]) => (
                    <div key={pl} className="flex justify-between text-xs py-1">
                      <span className="text-[var(--txt-2)]">{platMeta(pl).ku} <span className="text-[var(--txt-3)]">({v.n})</span></span>
                      <span className="font-bold" style={num}>{Object.entries(v.cur).map(([c, a]) => `${fmt(a, 0)} ${c}`).join(" / ")}</span>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <div className="text-[10px] font-bold text-[var(--txt-3)] uppercase mb-1">{tr("بەپێی وەرگر")}</div>
                {whoList.map(([n, v]) => (
                  <div key={n} className="flex justify-between text-xs py-1">
                    <span className="text-[var(--txt-2)]">{n} <span className="text-[var(--txt-3)]">({v.n})</span></span>
                    <span className="font-bold" style={num}>{Object.entries(v.cur).map(([c, a]) => `${fmt(a, 0)} ${c}`).join(" / ")}</span>
                  </div>
                ))}
              </div>

              {curs.map((c) => (
                <div key={c} className="bg-[var(--line)] rounded-[var(--r-sm)] p-3">
                  <div className="text-[10px] font-bold text-[var(--txt-3)] mb-1">{c}</div>
                  <div className="flex justify-between text-xs py-0.5"><span className="text-[var(--txt-2)]">{tr("بە فییەوە")}</span><span style={num}>{fmtMoney(data, gross[c], c)}</span></div>
                  {fees[c] > 0 && <div className="flex justify-between text-xs py-0.5"><span className="text-[var(--txt-2)]">{tr("فی")}</span><span style={num} className="text-[var(--neg)]">−{fmtMoney(data, fees[c], c)}</span></div>}
                  <div className="flex justify-between pt-1.5 mt-1 border-t border-[var(--line)] items-baseline">
                    <span className="text-xs font-bold">{tr("گەیشتوو")}</span>
                    <div className="text-left">
                      <div className="text-lg font-bold text-[var(--pos)]" style={num}>{fmtMoney(data, net[c], c)}</div>
                      {u(net[c], c) != null && <div className="text-[10px] text-[var(--txt-3)]" style={num}>≈ {fmt(u(net[c], c), 0)} $</div>}
                    </div>
                  </div>
                </div>
              ))}

              <div className="text-[11px] text-[var(--txt-3)]" style={num}>{counted.length} فیش هەژمار کراوە</div>

              {rejected.length > 0 && (
                <div className="border border-[color-mix(in_srgb,var(--neg)_26%,transparent)] bg-[color-mix(in_srgb,var(--neg)_9%,transparent)] rounded-[var(--r-sm)] p-3 mt-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--neg)] mb-2">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {rejected.length} فیش ڕەت کراوەتەوە — هەژمار نەکراون
                  </div>
                  <div className="space-y-2">
                    {rejected.map((r, i) => (
                      <div key={r.id || i} className="bg-[var(--surf)] rounded-lg p-2.5">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[10px] text-[var(--txt-3)]" style={num}>{i + 1}.</span>
                          <span className="text-sm font-bold text-[var(--txt-3)] line-through" style={num}>
                            {r.amount ? fmtMoney(data, r.net_amount ?? r.net ?? r.amount, r.currency) : "—"}
                          </span>
                          <span className="text-[10px] text-[var(--txt-3)]">{r.currency || ""}</span>
                        </div>
                        <div className="text-[11px] text-[var(--neg)] mt-1 leading-snug">
                          ❌ {r.reject_reason || r.rejectReason || r.note || REJECT_KU[r.reject_code || r.rejectCode] || "نەزانراو"}
                        </div>
                        <div className="text-[10px] text-[var(--txt-3)] mt-0.5 flex flex-wrap gap-x-2" style={num}>
                          {(r.ref_no || r.refNo) && <span>ژمارە {r.ref_no || r.refNo}</span>}
                          {(r.tx_time || r.txTime) && <span>· {r.tx_time || r.txTime}</span>}
                          {r.receiver && <span>· {r.receiver}</span>}
                        </div>
                        {(r.dup_of_date || r.dupOfDate) && (
                          <div className="text-[10px] text-[var(--txt-2)] mt-1 bg-[var(--line)] rounded px-1.5 py-1" style={num}>
                            ↩️ ڕەسەنەکەی: {new Date(r.dup_of_date || r.dupOfDate).toLocaleString("en-GB")}
                            {(r.dup_of_who || r.dupOfWho) && ` — ${r.dup_of_who || r.dupOfWho}`}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ناردن */}
          <div>
            <Lbl>{tr("ژمارەی واتساپ (ئارەزوومەندانە)")}</Lbl>
            <Inp type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07701234567" />
            <div className="text-[11px] text-[var(--txt-3)] mt-1">{tr("بەتاڵی بهێڵەرەوە بۆ هەڵبژاردنی کەس لە واتساپ")}</div>
          </div>

          <div className="flex gap-2">
            <Btn className="flex-1 flex items-center justify-center gap-1.5" onClick={sendWa}>
              <MessageCircle className="w-4 h-4" /> {tr("ناردن بە واتساپ")}
            </Btn>
            <Btn kind="ghost" className="flex-1" onClick={copy}>{tr("کۆپیکردن")}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── ڕێنمایی واتساپ ─────────── */
function WhatsAppInfo({ batches, waN }) {
  const wa = (batches || []).filter((b) => b.source === "whatsapp");
  const today = new Date().toISOString().slice(0, 10);
  const todayN = wa.filter((b) => (b.created_at || "").slice(0, 10) === today).length;
  return (
    <div className="space-y-4">
      <Card className="p-5 bg-emerald-600 border-[var(--pos)] text-white">
        <div className="flex items-center gap-2.5 mb-3">
          <MessageCircle className="w-6 h-6" />
          <div className="font-bold">{tr("وەرگرتنی فیش لە واتساپەوە")}</div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[11px] text-emerald-100">{tr("کۆی کۆمەڵەکان")}</div>
            <div className="text-2xl font-bold" style={num}>{wa.length}</div>
          </div>
          <div>
            <div className="text-[11px] text-emerald-100">{tr("ئەمڕۆ")}</div>
            <div className="text-2xl font-bold" style={num}>{todayN}</div>
          </div>
          <div>
            <div className="text-[11px] text-emerald-100">{tr("چاوەڕوان")}</div>
            <div className="text-2xl font-bold" style={num}>{waN}</div>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <SecLbl>{tr("چۆن کار دەکات")}</SecLbl>
        <div className="space-y-3 text-sm text-[var(--txt-2)] leading-relaxed">
          <div className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-[var(--pos)] text-white flex items-center justify-center text-xs font-bold shrink-0">{tr("١")}</span>
            <span>{tr("کڕیار فیشەکان لە واتساپەوە")} <b>{tr("فۆرۆرد")}</b> {tr("دەکات بۆ ژمارەی کۆمپانیاکە")}</span>
          </div>
          <div className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-[var(--pos)] text-white flex items-center justify-center text-xs font-bold shrink-0">{tr("٢")}</span>
            <span>{tr("سیستەمەکە خۆکار وێنەکان دەخوێنێتەوە و دووبارەکان دەدۆزێتەوە")}</span>
          </div>
          <div className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-[var(--pos)] text-white flex items-center justify-center text-xs font-bold shrink-0">{tr("٣")}</span>
            <span>{tr("کۆمەڵەیەکی نوێ لە")} <b>{tr("ئینباکس")}</b> {tr("دەردەکەوێت — تۆ تەنها مامەڵەکەی لێ درووست دەکەیت")}</span>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-[var(--line)] text-xs text-[var(--txt-2)] leading-relaxed">
          <b className="text-[var(--txt)]">{tr("تێبینی:")}</b> {tr("فیشەکان کە بە ماوەی ١٥ خولەک بنێردرێن، هەموویان لە یەک کۆمەڵەدا کۆدەبنەوە.")}
          کڕیارەکە بە ژمارەی مۆبایلەکەی دەناسرێتەوە — بۆیە دڵنیابە ژمارەکەی لە ئەکاونتەکەیدا دروستە.
        </div>
      </Card>

      <Card className="p-4 bg-[var(--line)]">
        <div className="text-xs text-[var(--txt-2)] leading-relaxed">
          <b className="text-[var(--txt)]">{tr("نرخ:")}</b> {tr("وەرگرتنی نامە لە کڕیارەکانەوە")} <b>{tr("بەخۆڕاییە")}</b> {tr("— تەنها ئەگەر تۆ وەڵامیان بدەیتەوە پارەی لەسەرە.")}
          سیستەمەکە بە شێوەی بنەڕەت وەڵام نادات.
        </div>
      </Card>
    </div>
  );
}

/* ─────────── فیشەکانی شوێنێک (لای خۆم یان لای هاوبەشێک) ─────────── */
function LocationReceipts({ partnerId, data, title, flash, showValuation = true }) {
  const [recs, setRecs] = useState(null);
  const [recErr, setRecErr] = useState("");
  const [mode, setMode] = useState("month");
  const [dir, setDir] = useState("all");
  const [share, setShare] = useState(false);

  const loadLocationReceipts = async () => {
    setRecs(null);
    setRecErr("");
    try {
      // ١) فیشە دابەشکراوەکان (partner_id لەسەر خودی فیشەکە)
      const q1 = partnerId
        ? supabase.from("receipts").select("*").eq("partner_id", partnerId)
        : supabase.from("receipts").select("*").is("partner_id", null);
      const directRes = await q1;
      if (directRes.error) throw directRes.error;
      const direct = directRes.data || [];

      // ٢) کۆمەڵەکانی ئەم شوێنە
      let q = supabase.from("receipt_batches").select("id, customer_name, partner_id");
      q = partnerId ? q.eq("partner_id", partnerId) : q.is("partner_id", null);
      const batchRes = await q;
      if (batchRes.error) throw batchRes.error;
      const bs = batchRes.data || [];
      const names = Object.fromEntries(bs.map((x) => [x.id, x.customer_name]));

      let fromBatch = [];
      if (bs.length) {
        const receiptRes = await supabase.from("receipts").select("*").in("batch_id", bs.map((x) => x.id));
        if (receiptRes.error) throw receiptRes.error;
        // ئەوانەی خۆیان partner_id ـی جیایان هەیە، لێرە نایەن
        fromBatch = (receiptRes.data || []).filter((r) => !r.partner_id || r.partner_id === (partnerId || null));
      }

      const seen = new Set();
      const merged = [...direct, ...fromBatch].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      setRecs(merged.map((r) => ({ ...r, customer_name: r.customer_name || names[r.batch_id] })));
    } catch (e) {
      console.error("location-receipts", e);
      setRecErr(e?.message || "نەتوانرا فیشەکان وەربگیرێن");
      setRecs([]);
    }
  };

  useEffect(() => { loadLocationReceipts(); }, [partnerId]);

  if (recs === null) return <Card><StatePanel type="loading" title={tr("بارکردن...")} compact /></Card>;
  if (recErr) return <Card><StatePanel type="error" title="نەتوانرا فیشەکان وەربگیرێن" detail={recErr} onRetry={loadLocationReceipts} compact /></Card>;

  const t = new Date(), iso = (d) => d.toISOString().slice(0, 10);
  const w = new Date(t); w.setDate(w.getDate() - w.getDay());
  const m = new Date(t.getFullYear(), t.getMonth(), 1);
  const y = new Date(t.getFullYear(), 0, 1);
  const from = mode === "day" ? iso(t) : mode === "week" ? iso(w) : mode === "month" ? iso(m) : mode === "year" ? iso(y) : "0000-01-01";
  let list = recs.filter((r) => ((r.tx_date || r.created_at || "").slice(0, 10)) >= from);
  if (dir !== "all") list = list.filter((r) => (r.direction || "in") === dir);

  return (
    <div className="space-y-3">
      {title && <div className="font-bold text-[var(--txt)]">{title}</div>}
      <div className="flex gap-1 rounded-[var(--r)] p-1 overflow-x-auto" style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
        {[["day", tr("ئەمڕۆ")], ["week", tr("هەفتە")], ["month", tr("مانگ")], ["year", tr("ساڵ")], ["all", tr("هەمووی")]].map(([k, lbl]) => (
          <button key={k} onClick={() => setMode(k)}
            className={`flex-1 whitespace-nowrap py-2.5 px-3 rounded-lg text-sm ${mode === k ? "bg-[var(--pos)] text-white font-semibold" : "text-[var(--txt-2)]"}`}>{lbl}</button>
        ))}
      </div>
      <div className="flex gap-1 rounded-[var(--r)] p-1" style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
        {[["all", tr("هەمووی")], ["in", tr("هاتوو")], ["out", tr("نێردراو")]].map(([k, lbl]) => (
          <button key={k} onClick={() => setDir(k)}
            className={`flex-1 py-2 rounded-lg text-sm ${dir === k ? "bg-slate-900 text-white font-semibold" : "text-[var(--txt-2)]"}`}>{lbl}</button>
        ))}
      </div>
      <ReceiptTotals rows={list} data={data} showValuation={showValuation} />

      <Btn kind="gold" className="w-full flex items-center justify-center gap-2" onClick={() => setShare(true)}>
        <Share2 className="w-4 h-4" /> {tr("ناردنی خشتەی وردەکاری")}
      </Btn>
      {share && (
        <ShareTable rows={list} data={data} title={title || "فیشەکان"}
          flash={flash} onClose={() => setShare(false)} />
      )}

      <RejectedReceipts rows={list} />
      <ReceiptList rows={list} showFrom />
    </div>
  );
}

/* ─────────── وردەکاری کۆمەڵەیەک ─────────── */
function BatchDetail({ id, back, usr, data, profile, onMakeTx, flash, reloadBatches }) {
  const [b, setB] = useState(null);
  const [recs, setRecs] = useState(null);
  const [intakeItems, setIntakeItems] = useState([]);
  const [events, setEvents] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [receiptPolicy, setReceiptPolicy] = useState(null);
  const [matchReason, setMatchReason] = useState("");
  const [matchBusy, setMatchBusy] = useState(null);
  const [decisionBusy, setDecisionBusy] = useState(null);
  const [finalizationReason, setFinalizationReason] = useState("");
  const [finalizationBusy, setFinalizationBusy] = useState(false);
  // §4.14: the canonical totals, computed on the server and read identically by the
  // administrator here and by the person who sent the receipts in their own portal.
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [split, setSplit] = useState(false);
  const [share, setShare] = useState(false);
  const [pick, setPick] = useState({});        // {receiptId: partnerId|""}
  const [saving, setSaving] = useState(false);
  const [allocationReason, setAllocationReason] = useState("دابەشکردنی فیش بەپێی شوێنی پارە");
  const matchCommandRef = useRef(null);
  const decisionCommandRef = useRef(null);
  const finalizationCommandRef = useRef(null);
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);

  const load = async () => {
    const [bb, rr, ii, ee, aa, cc, pp] = await Promise.all([
      supabase.from("receipt_batches").select("*").eq("id", id).single(),
      supabase.from("receipts").select("*").eq("batch_id", id).order("created_at"),
      supabase.from("receipt_intake_items").select("*").eq("batch_id", id).order("created_at"),
      supabase.from("receipt_events").select("*").eq("batch_id", id).order("created_at", { ascending: true }),
      supabase.from("receipt_audit_events").select("*").eq("batch_id", id).order("created_at", { ascending: true }),
      supabase.rpc("sarraf_receipt_match_candidates", { p_batch_id: id, p_limit: 5 }),
      loadReceiptPolicy(supabase).catch(() => null),
    ]);
    try {
      setSummary(await loadBatchSummary(supabase, id));
      setSummaryError("");
    } catch (error) {
      console.error("batch summary", error);
      setSummary(null);
      setSummaryError(error?.message || "کۆکانەی سێرڤەر بار نەبوو");
    }
    setB(bb.data || null); setRecs(rr.data || []); setIntakeItems(ii.error ? [] : (ii.data || []));
    const legacyEvents = ee.error ? [] : (ee.data || []);
    const auditedEvents = aa.error ? [] : (aa.data || []).map((event) => ({
      id: `audit-${event.id}`,
      event_type: event.event_type,
      created_at: event.created_at,
      actor_user_id: event.actor_id,
      detail: event.metadata?.reason || event.metadata?.decision || null,
    }));
    setEvents([...legacyEvents, ...auditedEvents].sort((left, right) => new Date(left.created_at) - new Date(right.created_at)));
    setCandidates(cc.error ? [] : (cc.data || []));
    setReceiptPolicy(pp || null);
    setPick(Object.fromEntries((rr.data || []).map((r) => [r.id, r.partner_id || ""])));
  };
  useEffect(() => { load(); }, [id]);

  if (!b || !recs) return <Card><Empty t={tr("بارکردن...")} /></Card>;
  const good = recs.filter((r) => r.counted !== false && r.status !== "dup" && r.status !== "error");
  const persistedItems = intakeItems.length ? intakeItems : recs.map((receipt) => ({
    ...receipt,
    intake_status: receipt.counted !== false && receipt.status !== "dup" && receipt.status !== "error" ? "accepted" : "rejected",
    rule_code: receipt.reject_code,
    rule_reason: receipt.reject_reason,
  }));
  const rejectedEvidence = persistedItems.filter((item) => item.intake_status === "rejected").map((item) => ({
    ...item,
    status: "error",
    counted: false,
    reject_code: item.rule_code || item.reject_code,
    reject_reason: item.rule_reason || item.reject_reason,
  }));
  const unconvertedIds = new Set(persistedItems.filter((item) => item.intake_status === "accepted" && !item.transaction_id).map((item) => item.id));
  const hasConvertedReceipts = persistedItems.some((item) => item.intake_status === "accepted" && item.transaction_id);
  const convertibleReceipts = good.filter((receipt) => unconvertedIds.has(receipt.id));
  const canCreateTransaction = b.receipt_stage === "verified" && convertibleReceipts.length > 0;
  const canManageCustody = b.receipt_stage === "verified" && convertibleReceipts.length > 0;
  const isOut = (b.direction || "in") === "out";

  // گروپکردن بەپێی هاوبەش
  const groups = {};
  good.forEach((r) => {
    const k = pick[r.id] || "";
    groups[k] = groups[k] || { rows: [], n: 0 };
    groups[k].rows.push(r); groups[k].n++;
  });
  const groupKeys = Object.keys(groups);
  const conversionGroups = {};
  convertibleReceipts.forEach((receipt) => {
    const key = pick[receipt.id] || "";
    conversionGroups[key] = conversionGroups[key] || { rows: [], n: 0 };
    conversionGroups[key].rows.push(receipt);
    conversionGroups[key].n += 1;
  });
  const conversionGroupKeys = Object.keys(conversionGroups);
  const remainingTotal = convertibleReceipts.reduce((sum, receipt) => sum + (Number(receipt.net_amount ?? receipt.amount) || 0), 0);
  const remainingCurrency = convertibleReceipts[0]?.currency || b.currency;

  const saveSplit = async () => {
    if (allocationReason.trim().length < 8) return flash("هۆکاری دابەشکردن لانیکەم ٨ پیت بێت");
    setSaving(true);
    try {
      await assignReceiptCustody(supabase, {
        batchId: id,
        allocations: convertibleReceipts.map((r) => ({ receipt_id: r.id, partner_id: pick[r.id] || null })),
        reason: allocationReason,
      });
      flash("دابەشکردن پاشەکەوت کرا ✓");
      setSplit(false); await load(); reloadBatches && reloadBatches();
    } catch (e) { console.error(e); flash("هەڵە لە پاشەکەوتکردن"); }
    finally { setSaving(false); }
  };

  const setAll = (pid) => setPick((current) => ({ ...current, ...Object.fromEntries(convertibleReceipts.map((r) => [r.id, pid])) }));

  const confirmMatch = async (candidate) => {
    const minimum = receiptPolicy?.min_match_score ?? 80;
    const reasonBelow = receiptPolicy?.require_reason_below ?? 90;
    if (Number(candidate.score) < minimum) {
      return flash(`ئەم پێشنیارە ژێر سنووری یاسای ${minimum}% ـە`);
    }
    if (Number(candidate.score) < reasonBelow && matchReason.trim().length < 8) {
      return flash(`بۆ نمرەی کەمتر لە ${reasonBelow}%، هۆکارێکی ڕوون بنووسە`);
    }
    if (!matchCommandRef.current || matchCommandRef.current.txId !== candidate.tx_id) {
      matchCommandRef.current = { txId: candidate.tx_id, key: createReceiptReviewCommand("accept", id, candidate.tx_id) };
    }
    setMatchBusy(candidate.tx_id);
    try {
      await reviewReceiptBatch(supabase, { batchId: id, decision: "accept", txId: candidate.tx_id,
        reviewReason: matchReason, commandKey: matchCommandRef.current.key });
      flash("فیشەکان بە مامەڵەکەوە بەسترانەوە ✓");
      matchCommandRef.current = null;
      setMatchReason("");
      await load();
      reloadBatches && reloadBatches();
    } catch (error) {
      console.error("receipt match", error);
      flash(`بەستنەوە سەرکەوتوو نەبوو — ${errorTextOr(error, "هەڵە")}`, "error");
    } finally {
      setMatchBusy(null);
    }
  };

  const decideWithoutMatch = async (decision) => {
    if (matchReason.trim().length < 8) return flash("هۆکاری بڕیارەکە لانیکەم ٨ پیت بێت");
    if (!decisionCommandRef.current || decisionCommandRef.current.decision !== decision) {
      decisionCommandRef.current = { decision, key: createReceiptReviewCommand(decision, id) };
    }
    setDecisionBusy(decision);
    try {
      await reviewReceiptBatch(supabase, { batchId: id, decision, reviewReason: matchReason,
        commandKey: decisionCommandRef.current.key });
      flash(decision === "reject" ? "کۆمەڵە فیشەکە ڕەتکرایەوە ✓" : "کۆمەڵە فیشەکە بۆ ڕاستکردنەوە گەڕێندرایەوە ✓");
      decisionCommandRef.current = null;
      setMatchReason("");
      await load();
      reloadBatches && reloadBatches();
    } catch (error) {
      console.error("receipt decision", error);
      flash(errorTextOr(error, "بڕیاری فیش جێبەجێ نەکرا"), "error");
    } finally {
      setDecisionBusy(null);
    }
  };

  const finalizeDecision = async () => {
    const sameMaker = b?.decision_by && b.decision_by === profile?.id;
    const ownerOverride = sameMaker && profile?.adminLevel === "owner";
    const requiredLength = ownerOverride ? 12 : 8;
    if (finalizationReason.trim().length < requiredLength) {
      return flash(`هۆکاری پشکنینی کۆتایی لانیکەم ${requiredLength} پیت بێت`);
    }
    if (sameMaker && !ownerOverride) return flash("ئەدمینێکی جیاواز دەبێت پشکنینی کۆتایی ئەم بڕیارە بکات");
    // §4.15: the decision is taken against a particular set of figures and says which. If they
    // have moved since this screen read them, the server refuses and the screen reloads rather
    // than finalizing numbers nobody looked at.
    const version = versionOf(summary);
    if (!version) return flash("کۆکانەی سێرڤەر بار نەبووە — تکایە پەڕەکە نوێ بکەرەوە");
    finalizationCommandRef.current ||= createReceiptReviewCommand("finalize", id);
    setFinalizationBusy(true);
    try {
      await finalizeReceiptBatch(supabase, { batchId: id, finalizationReason,
        ownerOverride, commandKey: finalizationCommandRef.current, summaryVersion: version });
      finalizationCommandRef.current = null;
      setFinalizationReason("");
      flash("بڕیاری فیش پشکنینی کۆتایی و تۆماری وردبینی بۆ کرا ✓");
      await load();
      reloadBatches && reloadBatches();
    } catch (error) {
      console.error("receipt finalization", error);
      if (isStale(error)) {
        // A fresh key, because the figures this one was minted against no longer exist.
        finalizationCommandRef.current = null;
        await load();
        flash(STALE_MESSAGE, "error");
      } else {
        flash(errorTextOr(error, "پشکنینی کۆتایی سەرکەوتوو نەبوو"), "error");
      }
    } finally {
      setFinalizationBusy(false);
    }
  };

  const lifecycleStage = b.receipt_stage === "received" ? "capture"
    : b.receipt_stage === "reading" ? "read"
      : b.receipt_stage === "needs_review" ? "review"
        : b.receipt_stage === "verified" ? "verify"
          : b.receipt_stage === "matched" ? "match"
            : b.receipt_stage === "rejected" ? "review"
                : b.receipt_stage === "finalized" ? "archive"
                  : b.receipt_stage === "archived" ? "archive"
                    : b.tx_id ? "match" : "verify";
  const requiresFinalization = receiptPolicy?.require_finalization !== false;
  const eventLabels = {
    received: "کۆمەڵە وەرگیرا", ai_read: "AI خوێندییەوە", needs_review: "پشکنینی مرۆڤ پێویستە",
    verified: "پشتڕاست کرایەوە", matched: "بە مامەڵەوە بەسترا", unlinked: "بەستنەوە هەڵوەشایەوە",
    decision_rejected: "بڕیاری ڕەتکردنەوە تۆمار کرا", correction_requested: "گەڕێندرایەوە بۆ ڕاستکردنەوە",
    finalized: "بڕیارەکە پشکنینی کۆتایی بۆ کرا", policy_updated: "یاسای فیش نوێ کرایەوە",
    archived: "ئەرشیف کرا", rejected_summary: "ڕەتکراوەکان تۆمار کران", split_updated: "دابەشکردن نوێکرایەوە",
  };

  return (
    <div className="space-y-4">
      <Back onClick={back} t={tr("گەڕانەوە")} />
      <DeferredPanel compact><ReceiptLifecycle stage={lifecycleStage} lang={_lang} /></DeferredPanel>
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-[var(--txt)]">{b.customer_name || (b.partner_id ? usr(b.partner_id).name : "—")}</h2>
          <div className="text-xs text-[var(--txt-2)] mt-0.5" style={num}>{new Date(b.created_at).toLocaleString("en-GB")}</div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <Pill tone={isOut ? "amber" : "green"}>{DIR_KU[b.direction || "in"]}</Pill>
          {b.receipt_stage === "rejected"
            ? <Pill tone="red">ڕەتکراوە</Pill>
            : b.status === "new"
              ? <Pill tone="green">{tr("چاوەڕوانی مامەڵە")}</Pill>
              : b.tx_id
                ? <Pill tone="slate">{tr("بەستراوە")}</Pill>
                : <Pill tone="slate">بڕیار تەواوە</Pill>}
        </div>
      </div>

      {/* The canonical figures, from the server. The same read model the sender's own portal
          shows, so the two screens can never disagree about what this batch came to. */}
      {summaryError
        ? <Card className="p-4"><StatePanel type="error" title={tr("کۆکانەی سێرڤەر بار نەبوو")} detail={summaryError} onRetry={load} compact /></Card>
        : <React.Suspense fallback={null}><CanonicalBatchSummary summary={summary} ui={{ Card, Pill, tr, num }} /></React.Suspense>}

      <ReceiptTotals rows={recs} data={data} />

      <Card className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[13px] font-bold text-[var(--txt)]">دۆخی پاراستنی فیشەکان</div>
            <div className="text-[11px] text-[var(--txt-3)] mt-1">
              هەموو وێنە و وردەکارییەکان تۆمار کراون؛ تەنها فیشە پەسەندکراوەکان لە کۆی مامەڵەدا هەژمار دەکرێن.
            </div>
          </div>
          <Pill tone={canCreateTransaction || b.tx_id ? "green" : rejectedEvidence.length ? "red" : "amber"}>
            {canCreateTransaction ? "ئامادەی مامەڵە" : b.tx_id ? "بە مامەڵەوە بەستراوە" : "مامەڵە قوفڵە"}
          </Pill>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3" role="status" aria-label="پوختەی پاراستنی فیش">
          {[["هەموو", persistedItems.length, "var(--txt)"], ["پەسەندکراو", good.length, "var(--pos)"], ["ڕەتکراو", rejectedEvidence.length, "var(--neg)"]].map(([label, value, color]) => (
            <div key={label} className="rounded-xl p-3 text-center" style={{ background: "var(--surf-2)", border: "1px solid var(--line)" }}>
              <div className="text-[10px] text-[var(--txt-3)]">{label}</div>
              <div className="text-lg font-bold mt-1" style={{ ...num, color }}>{value}</div>
            </div>
          ))}
        </div>
      </Card>

      <Btn kind="gold" className="w-full flex items-center justify-center gap-2" onClick={() => setShare(true)}>
        <Share2 className="w-4 h-4" /> {tr("ناردنی خشتەی وردەکاری")}
      </Btn>
      {share && (
        <ShareTable rows={recs} data={data} who={b.customer_name || (b.partner_id ? usr(b.partner_id).name : "")}
          title={tr("وردەکاری فیشەکان")} flash={flash} onClose={() => setShare(false)} />
      )}

      {canCreateTransaction && !hasConvertedReceipts && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
            <div>
              <SecLbl>{tr("بەستنەوەی زیرەک")}</SecLbl>
              <div className="text-[11px] text-[var(--txt-3)] mt-1">پێشنیارەکان تەنها یارمەتیدەرن؛ بەستنەوە تەنها دوای پشتڕاستکردنەوەی تۆ ئەنجام دەدرێت.</div>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              <Pill tone="amber">{tr("پەسەندکردنی مرۆڤ پێویستە")}</Pill>
              <Pill tone="slate">یاسا {receiptPolicy?.version || "—"} · لانیکەم {receiptPolicy?.min_match_score ?? 80}%</Pill>
            </div>
          </div>
          <div className="space-y-3">
            {candidates.length === 0 && <StatePanel type="empty" title="هیچ مامەڵەیەکی گونجاو بۆ بەستنەوە نەدۆزرایەوە" detail="دەتوانیت لە فیشە پەسەندکراوەکان مامەڵەیەکی نوێ دروست بکەیت، یان کۆمەڵەکە ڕەت بکەیتەوە." compact />}
            {candidates.map((candidate) => {
              const reasons = candidate.reasons || {};
              const minimum = receiptPolicy?.min_match_score ?? 80;
              const reasonBelow = receiptPolicy?.require_reason_below ?? 90;
              const belowPolicy = Number(candidate.score) < minimum;
              const reasonRequired = Number(candidate.score) < reasonBelow;
              return (
                <div key={candidate.tx_id} className="rounded-2xl p-4" style={{ background: "var(--surf-2)", border: "1px solid var(--line)" }}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-bold text-[var(--txt)]" style={num}>#{candidate.tx_code || "—"}</span>
                        <Pill tone={candidate.score >= minimum ? "green" : "red"}>{candidate.score}%</Pill>
                        <span className="text-[10px] text-[var(--txt-3)]">{candidate.tx_type} · {candidate.tx_status}</span>
                      </div>
                      <div className="text-[12px] font-semibold text-[var(--txt)] mt-2" style={num}>
                        {fmtMoney(data, candidate.tx_amount, candidate.tx_currency)} {candidate.tx_currency} · {candidate.tx_counterparty || "—"}
                      </div>
                      <div className="text-[10px] text-[var(--txt-3)] mt-1" style={num}>{candidate.tx_date ? new Date(candidate.tx_date).toLocaleString("en-GB") : "—"}</div>
                    </div>
                    <Btn onClick={() => confirmMatch(candidate)} disabled={!!matchBusy || !!decisionBusy || belowPolicy || (reasonRequired && matchReason.trim().length < 8)}>
                      {matchBusy === candidate.tx_id ? "بەستنەوە..." : belowPolicy ? "ژێر سنووری یاسا" : "پەسەندکردن و بەستنەوە"}
                    </Btn>
                  </div>
                  <div className="flex gap-1.5 flex-wrap mt-3">
                    <Pill tone={Number(reasons.amount_delta || 0) <= Math.max(0.01, Math.abs(Number(b.total_net || 0)) * 0.001) ? "green" : "amber"}>جیاوازی بڕ: <span style={num}>{fmt(Number(reasons.amount_delta || 0), 2)}</span></Pill>
                    <Pill tone={reasons.currency_match ? "green" : "red"}>دراو {reasons.currency_match ? "✓" : "✕"}</Pill>
                    <Pill tone={reasons.direction_match ? "green" : "red"}>ئاڕاستە {reasons.direction_match ? "✓" : "✕"}</Pill>
                    <Pill tone={reasons.counterparty_match ? "green" : "slate"}>لایەن {reasons.counterparty_match ? "✓" : "—"}</Pill>
                    <Pill tone="slate"><span style={num}>{fmt(Number(reasons.time_hours || 0), 1)}</span> کاتژمێر</Pill>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-4">
            <Lbl>هۆکاری بڕیار {candidates.some((candidate) => candidate.score < (receiptPolicy?.require_reason_below ?? 90)) ? "(بۆ نمرەی ژێر سنوور، ڕەتکردنەوە یان ڕاستکردنەوە پێویستە)" : "(بۆ ڕەتکردنەوە یان ڕاستکردنەوە پێویستە)"}</Lbl>
            <Inp value={matchReason} onChange={(e) => setMatchReason(e.target.value)} placeholder="بۆ نموونە: بڕ/دراو/کڕیار یەکناگرنەوە، یان پشکنینەکە پشتڕاستە" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 pt-3 border-t border-[var(--line)]">
            <Btn kind="danger" onClick={() => decideWithoutMatch("reject")} disabled={!!matchBusy || !!decisionBusy || receiptPolicy?.allow_reject === false || matchReason.trim().length < 8}>
              {decisionBusy === "reject" ? "ڕەتکردنەوە..." : "ڕەتکردنەوەی کۆمەڵە"}
            </Btn>
            <Btn kind="ghost" onClick={() => decideWithoutMatch("correction")} disabled={!!matchBusy || !!decisionBusy || receiptPolicy?.allow_correction === false || matchReason.trim().length < 8}>
              {decisionBusy === "correction" ? "گەڕاندنەوە..." : "گەڕاندنەوە بۆ ڕاستکردنەوە"}
            </Btn>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <SecLbl>{tr("مێژووی وردبینی")}</SecLbl>
        <div className="mt-4 space-y-0">
          {(events.length ? events : [{ id: "created", event_type: "received", created_at: b.created_at, detail: "Legacy batch" }]).map((event, index, list) => (
            <div key={event.id} className="flex gap-3 min-h-[58px]">
              <div className="flex flex-col items-center">
                <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: index === list.length - 1 ? "var(--ac)" : "var(--pos)", color: "#fff" }}>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                </span>
                {index < list.length - 1 && <span className="w-px flex-1" style={{ background: "var(--line-2)" }} />}
              </div>
              <div className="pb-4 min-w-0">
                <div className="text-[12px] font-semibold text-[var(--txt)]">{eventLabels[event.event_type] || formatAuditAction(event.event_type)}</div>
                <div className="text-[10px] text-[var(--txt-3)] mt-0.5" style={num}>{event.created_at ? new Date(event.created_at).toLocaleString("en-GB") : "—"}</div>
                {(event.detail || event.actor_user_id) && <div className="text-[10.5px] text-[var(--txt-2)] mt-1">{event.detail || ""}{event.actor_user_id ? ` · ${usr(event.actor_user_id).name || event.actor_user_id}` : ""}</div>}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <RejectedReceipts rows={rejectedEvidence} />

      {/* دابەشکردن بەسەر هاوبەشەکان */}
      {canManageCustody && partners.length > 0 && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <SecLbl>{tr("دابەشکردن بەسەر هاوبەشەکان")}</SecLbl>
            <button onClick={() => setSplit(!split)} className="text-xs font-semibold text-[var(--pos)]">
              {split ? "داخستن" : "دەستکاری"}
            </button>
          </div>

          {!split ? (
            groupKeys.length <= 1 && !groupKeys[0] ? (
              <div className="text-sm text-[var(--txt-2)]">{tr("هەموو فیشەکان یەکجار وەردەگیرێن — گەر دەتەوێت بەسەر چەند هاوبەشێک دابەشیان بکەیت، «دەستکاری» لێبدە")}</div>
            ) : (
              <div className="space-y-2">
                {groupKeys.map((k) => {
                  const g = groups[k];
                  const tot = {};
                  g.rows.forEach((r) => { const c = r.currency || "?"; tot[c] = (tot[c] || 0) + (+(r.net_amount ?? r.amount) || 0); });
                  return (
                    <div key={k || "none"} className="flex items-center justify-between py-2.5 border-b border-[var(--line)] last:border-0">
                      <div>
                        <div className="font-semibold text-[var(--txt)]">{k ? usr(k).name : "قاسەی گشتی (لای خۆم)"}</div>
                        <div className="text-xs text-[var(--txt-3)]" style={num}>{g.n} فیش</div>
                      </div>
                      <div className="text-left">
                        {Object.entries(tot).map(([c, v]) => (
                          <div key={c} className="font-bold text-[var(--txt)]" style={num}>{fmt(v, 0)} <span className="text-xs font-normal text-[var(--txt-2)]">{c}</span></div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="space-y-2.5">
              <div className="flex gap-1.5 flex-wrap mb-2">
                <span className="text-xs text-[var(--txt-2)] self-center">{tr("هەمووی بۆ:")}</span>
                <button onClick={() => setAll("")} className="px-2.5 py-1 rounded-lg bg-[var(--line)] hover:bg-[var(--line)] text-xs font-semibold">{tr("قاسەی گشتی")}</button>
                {partners.map((p) => (
                  <button key={p.id} onClick={() => setAll(p.id)} className="px-2.5 py-1 rounded-lg bg-[var(--line)] hover:bg-[var(--pos)] hover:text-white text-xs font-semibold transition">{p.name}</button>
                ))}
              </div>
              {convertibleReceipts.map((r, i) => (
                <div key={r.id} className="flex items-center gap-2.5 p-2.5 bg-[var(--line)] rounded-[var(--r-sm)]">
                  <span className="text-xs text-[var(--txt-3)] w-5" style={num}>{i + 1}</span>
                  {r.image_path && <ReceiptImg path={r.image_path} className="w-10 h-10 object-cover rounded-lg border border-[var(--line)] shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-[var(--txt)]" style={num}>{fmtMoney(data, r.net_amount ?? r.amount, r.currency)} <span className="text-xs font-normal text-[var(--txt-2)]">{r.currency}</span></div>
                    <div className="text-[11px] text-[var(--txt-3)] truncate">{r.receiver || "—"}</div>
                  </div>
                  <select value={pick[r.id] ?? ""} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}
                    className="border border-[var(--line)] rounded-lg px-2 py-1.5 text-xs bg-[var(--surf)] shrink-0 max-w-[130px]">
                    <option value="">{tr("قاسەی گشتی")}</option>
                    {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              ))}
              <div>
                <Lbl>{tr("هۆکاری دانانی فیشەکان لای هاوبەش")}</Lbl>
                <Inp value={allocationReason} onChange={(event) => setAllocationReason(event.target.value)}
                  placeholder={tr("بۆ نموونە: پارەکە لای ئەم هاوبەشە دانرا")} />
              </div>
              <Btn className="w-full" onClick={saveSplit} disabled={saving}>{saving ? "..." : "پاشەکەوتکردنی دابەشکردن"}</Btn>
            </div>
          )}
        </Card>
      )}

      {canCreateTransaction && (
        <Card className={`p-5 ${isOut ? "border-[color-mix(in_srgb,var(--neg)_34%,transparent)] bg-[color-mix(in_srgb,var(--neg)_8%,transparent)]" : "border-[color-mix(in_srgb,var(--pos)_34%,transparent)] bg-[color-mix(in_srgb,var(--pos)_8%,transparent)]"}`}>
          {conversionGroupKeys.length > 1 ? (
            <>
              <div className="text-sm text-[var(--txt)] mb-3">
                {tr("فیشە ماوەکان بەسەر")} <b>{conversionGroupKeys.length}</b> {tr("شوێندا دابەش کراون — بۆ هەریەکەیان مامەڵەیەکی جیا دروست بکە:")}
              </div>
              <div className="space-y-2">
                {conversionGroupKeys.map((k) => {
                  const g = conversionGroups[k];
                  const cu = g.rows[0]?.currency;
                  const tot = g.rows.reduce((s2, r) => s2 + (+(r.net_amount ?? r.amount) || 0), 0);
                  return (
                    <Btn key={k || "none"} kind={isOut ? "danger" : "primary"} className="w-full flex items-center justify-between"
                      onClick={() => onMakeTx({ ...b, total_net: tot, currency: cu, n: g.n, partner_id: k || null, receipt_ids: g.rows.map((row) => row.id), _group: k || null })}>
                      <span>{k ? usr(k).name : "قاسەی گشتی"}</span>
                      <span style={num}>{fmt(tot, 0)} {cu}</span>
                    </Btn>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className={`text-sm mb-3 ${isOut ? "text-[var(--neg)]" : "text-[var(--pos)]"}`}>
                {isOut
                  ? <>{tr("ئەم بڕەی پەسەندکراوە ماوە:")} <b style={num}>{fmtMoney(data, remainingTotal, remainingCurrency)} {remainingCurrency}</b> {tr("— فرۆشتنێکی لێ دروست بکە")}</>
                  : <>{tr("ئەم بڕەی پەسەندکراوە ماوە:")} <b style={num}>{fmtMoney(data, remainingTotal, remainingCurrency)} {remainingCurrency}</b> {tr("— کڕینێکی لێ دروست بکە")}</>}
              </div>
              <Btn kind={isOut ? "danger" : "primary"} className="w-full"
                onClick={() => onMakeTx({ ...b, total_net: remainingTotal, currency: remainingCurrency, n: convertibleReceipts.length,
                  partner_id: conversionGroupKeys[0] || null, receipt_ids: convertibleReceipts.map((row) => row.id) })}>
                {isOut ? "درووستکردنی فرۆشتن لەم فیشانەوە" : "درووستکردنی کڕین لەم فیشانەوە"}
              </Btn>
            </>
          )}
        </Card>
      )}
      {(b.tx_id || b.decision_status === "rejected") && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-sm text-[var(--txt-2)]">
                {b.decision_status === "rejected"
                  ? "کۆمەڵە فیشەکە ڕەتکراوەتەوە"
                  : <>{tr("بەستراوە بە مامەڵەی")} <b style={num}>#{(data.txs.find((t) => t.id === b.tx_id) || {}).code || "—"}</b></>}
              </div>
              <div className="flex gap-1.5 mt-2 flex-wrap">
                {b.matched_score != null && <Pill tone={b.matched_score >= (receiptPolicy?.min_match_score ?? 80) ? "green" : "amber"}>گونجان {b.matched_score}%</Pill>}
                <Pill tone={b.decision_status === "rejected" ? "red" : "green"}>{b.decision_status || (b.tx_id ? "accepted" : "—")}</Pill>
                <Pill tone={b.receipt_stage === "finalized" || !requiresFinalization ? "green" : "amber"}>{b.receipt_stage === "finalized" ? "پشکنینی کۆتایی تەواوە" : requiresFinalization ? "چاوەڕوانی پشکنینی کۆتایی" : "بڕیار تەواوە · پشکنینی کۆتایی ئارەزوومەندانەیە"}</Pill>
                {b.policy_version && <Pill tone="slate">یاسا {b.policy_version}</Pill>}
              </div>
              {(b.decision_reason || b.match_reason) && <div className="text-[10.5px] text-[var(--txt-3)] mt-2">{b.decision_reason || b.match_reason}</div>}
            </div>
          </div>
          {b.receipt_stage !== "finalized" && b.receipt_stage !== "archived" && (
            <div className="mt-4 pt-4 border-t border-[var(--line)]">
              <Lbl>{requiresFinalization ? "هۆکاری پشکنینی کۆتایی" : "پشکنینی کۆتایی ئارەزوومەندانە"} {b.decision_by === profile?.id && profile?.adminLevel === "owner" ? "(دەسەڵاتی خاوەن؛ لانیکەم ١٢ پیت)" : "(لانیکەم ٨ پیت)"}</Lbl>
              {b.decision_by === profile?.id && profile?.adminLevel !== "owner" && <div className="text-[10.5px] text-[var(--warn)] mb-2">بڕیاردەر و پشکنەری کۆتایی دەبێت دوو ئەدمینی جیاواز بن.</div>}
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-2.5">
                <Inp value={finalizationReason} onChange={(e) => setFinalizationReason(e.target.value)} placeholder="یاسا و پەیوەندیی نێوان مامەڵە و فیشەکان پشتڕاست کرایەوە" />
                <Btn onClick={finalizeDecision} disabled={finalizationBusy || profile?.role !== "admin" || (b.decision_by === profile?.id && profile?.adminLevel !== "owner") || finalizationReason.trim().length < (b.decision_by === profile?.id && profile?.adminLevel === "owner" ? 12 : 8)}>
                  {finalizationBusy ? "پشکنینی کۆتایی..." : "پشکنینی کۆتایی بڕیار"}
                </Btn>
              </div>
            </div>
          )}
          {b.receipt_stage === "finalized" && <div className="mt-4 pt-4 border-t border-[var(--line)] text-[11px] text-[var(--pos)] flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> پشکنینی کۆتایی و تۆماری وردبینی تەواوە{b.finalized_at ? ` · ${new Date(b.finalized_at).toLocaleString("en-GB")}` : ""}</div>}
        </Card>
      )}

      <ReceiptList rows={recs} />
    </div>
  );
}

/* ─────────── ئەرشیفی فیشەکانی کڕیارێک ─────────── */
function ReceiptArchive({ customerId, data, flash, simple = false }) {
  const [scan, setScan] = useState(false);
  const [recs, setRecs] = useState(null);
  const [share, setShare] = useState(false);
  const [portalSummary, setPortalSummary] = useState(null);
  const [portalSummaryError, setPortalSummaryError] = useState("");
  const [q, setQ] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  // Their own receipts, one row each, by name — which is where a refused one is refused *to*
  // somebody rather than merely refused. The batch summary above says what was counted; this
  // says what happened to each image, and gives the way back out of a rejection.
  const [mine, setMine] = useState(null);
  const [mineError, setMineError] = useState("");

  const reloadMine = useCallback(async () => {
    if (!simple) return;
    try {
      setMine(await loadMyReceipts(supabase));
      setMineError("");
    } catch (error) {
      console.error("my receipts", error);
      setMineError(userFacingServiceError(error, _lang, "فیشەکانی خۆت بار نەبوون"));
    }
  }, [simple]);

  useEffect(() => { reloadMine(); }, [reloadMine]);

  // The upload is the ordinary one; the link is made after it, so a replacement that cannot be
  // linked is still a receipt that arrived rather than an image that was lost.
  const replaceOne = async (receipt, file) => {
    const intake = await intakeReceipt({
      client: supabase, blob: file, mediaType: file.type || "image/jpeg",
    });
    await replaceReceipt(supabase, receipt.id, intake.documentId);
  };

  useEffect(() => {
    let active = true;
    if (simple) {
      setPortalSummaryError("");
      loadPortalReceiptSummary(supabase).then((summary) => {
        if (active) setPortalSummary(summary);
      }).catch((error) => {
        if (!active) return;
        console.error("portal receipt summary", error);
        setPortalSummaryError(userFacingServiceError(error, _lang, "پوختەی فیشەکان بار نەبوو"));
        setPortalSummary({ totals: [], batches: [] });
      });
      return () => { active = false; };
    }
    supabase.from("receipts").select("*").eq("customer_id", customerId).order("created_at", { ascending: false }).limit(500)
      .then(({ data: d }) => { if (active) setRecs(d || []); });
    return () => { active = false; };
  }, [customerId, simple]);

  if (simple) {
    if (portalSummary === null) return <Card><StatePanel type="loading" title={tr("بارکردن...")} compact /></Card>;
    // A customer who has sent nothing has no summary to read, and the server says so as a
    // refusal. Drawn as a red failure it reads as "the system is broken" to somebody whose
    // only fault is being new — which is the first thing they see, before they have sent
    // anything, on the screen that exists for sending. An empty summary is an empty summary.
    const summaryShown = portalSummaryError ? { totals: [], batches: [] } : portalSummary;
    return (
      <div className="space-y-3">
        <DeferredPanel><PortalReceiptSummary summary={summaryShown} data={data}
          ui={{ Card, Empty, Hero, Pill, fmtMoney, tr, num }}
          loadSummary={(batchId) => loadBatchSummary(supabase, batchId)} /></DeferredPanel>
        <MyReceipts receipts={mine} loading={mine === null} error={mineError}
          onReload={reloadMine} onReplace={replaceOne}
          ui={{ Card, Pill, Empty, StatePanel, tr }} />
      </div>
    );
  }


  if (!recs) return <Card><Empty t={tr("بارکردن...")} /></Card>;
  const list = simple ? recs : recs.filter((r) => {
    const d = (r.tx_date || r.created_at || "").slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (!q) return true;
    return `${r.receiver || ""} ${r.sender || ""} ${r.ref_no || ""} ${r.amount || ""} ${r.bank || ""}`.includes(q);
  });

  return (
    <div className="space-y-3">
      {!simple && <Card className="p-4 space-y-2.5">
        <div className="flex gap-2">
          <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("گەڕان بە ناو، ژمارەی مامەڵە، بڕ...")} className="flex-1" />
          <button onClick={() => setScan(true)}
            className="w-[50px] shrink-0 rounded-[var(--r-sm)] flex items-center justify-center tap"
            style={{ background: "var(--surf-2)", border: "1px solid var(--line)", color: "var(--txt-2)" }}>
            <Camera className="w-[18px] h-[18px]" />
          </button>
        </div>
        {scan && <Scanner onFound={(v) => { setQ(v); setScan(false); }} onClose={() => setScan(false)} />}
        <div className="grid grid-cols-2 gap-2.5">
          <div><Lbl>{tr("لە")}</Lbl><Inp type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Lbl>{tr("بۆ")}</Lbl><Inp type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
      </Card>}
      <ReceiptTotals rows={list} data={data} compact showValuation={!simple} />

      {!simple && <Btn kind="gold" className="w-full flex items-center justify-center gap-2" onClick={() => setShare(true)}>
        <Share2 className="w-4 h-4" /> {tr("ناردنی خشتەی وردەکاری")}
      </Btn>}
      {!simple && share && <ShareTable rows={list} data={data} title={tr("ئەرشیفی فیشەکان")} flash={flash} onClose={() => setShare(false)} />}

      {!simple && <RejectedReceipts rows={list} />}
      <ReceiptList rows={list} />
    </div>
  );
}

/* ─────────── فیشەکانی هاوبەشێک (پۆرتاڵی خۆی) ─────────── */
function PartnerReceipts({ partnerId, data, flash }) {
  // The partner's own portal: their receipts, in the currency the receipts name. A valuation in
  // dollars is the house's bookkeeping, not theirs.
  return <LocationReceipts partnerId={partnerId} data={data} flash={flash} showValuation={false} />;
}

/* کەشف حساب — پوختەی حیسابی کڕیارێک بۆ ناردن */
function Statement({ u, txs, c, cur, onClose, flash }) {
  const today = new Date().toLocaleDateString("en-GB");
  const [mode, setMode] = useState("all");
  const owe = Object.entries(c.owe || {}).filter(([, v]) => v);
  const due = Object.entries(c.due || {}).filter(([, v]) => v);
  // لە ڕوانگەی کڕیارەوە: کڕینی من = فرۆشتنی ئەو
  const filtered = mode === "all" ? txs : txs.filter((t) => (mode === "buy" ? t.type === "sell" : t.type === "buy"));
  const last = filtered.slice(0, 20);
  const MODE_KU = { all: "هەموو مامەڵەکان", buy: "کڕینەکانی ئەو", sell: "فرۆشتنەکانی ئەو" };
  // کۆکردنەوە
  const sums = {};
  filtered.forEach((t) => {
    const k = t.type === "buy" ? "sold" : "bought";      // ئەو فرۆشتوویەتی / کڕیویەتی
    sums[k] = sums[k] || {};
    sums[k][t.curId] = (sums[k][t.curId] || 0) + t.amount;
  });

  const text = (() => {
    const L = ["📄 کەشف حساب", `👤 ${u.name}`, `📅 ${today}`, `📋 ${MODE_KU[mode]}`, ""];
    if (sums.sold) { L.push("── ئەو فرۆشتوویەتی بە من ──"); Object.entries(sums.sold).forEach(([cid, v]) => L.push(`   ${fmt(v, cur(cid).dec ?? 0)} ${cur(cid).code}`)); L.push(""); }
    if (sums.bought) { L.push("── ئەو کڕیویەتی لە من ──"); Object.entries(sums.bought).forEach(([cid, v]) => L.push(`   ${fmt(v, cur(cid).dec ?? 0)} ${cur(cid).code}`)); L.push(""); }
    L.push("── دوا مامەڵەکان ──");
    last.forEach((t) => {
      const kind = t.type === "buy" ? "فرۆشتنت" : "کڕینت";
      L.push(`${new Date(t.date).toLocaleDateString("en-GB")} · ${kind} ${fmt(t.amount, cur(t.curId).dec ?? 0)} ${cur(t.curId).code} = ${fmt(t.total, cur(t.againstId).dec ?? 0)} ${cur(t.againstId).code}${t.status === "pending" ? " (چاوەڕوان)" : ""}`);
    });
    L.push("");
    L.push("── حیسابی کۆتایی ──");
    if (owe.length) { L.push("پارەی تۆ لای من:"); owe.forEach(([cid, v]) => L.push(`   ${fmt(v, cur(cid).dec ?? 0)} ${cur(cid).code}`)); }
    if (due.length) { L.push("قەرزی تۆ:"); due.forEach(([cid, v]) => L.push(`   ${fmt(v, cur(cid).dec ?? 0)} ${cur(cid).code}`)); }
    if (!owe.length && !due.length) L.push("حیساب پاکە ✅");
    return L.join("\n");
  })();

  const copy = () => navigator.clipboard.writeText(text).then(() => flash(tr("کۆپی کرا ✓")));
  const share = async () => { if (navigator.share) { try { await navigator.share({ text }); } catch {} } else copy(); };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end md:items-center justify-center md:p-6" onClick={onClose}>
      <div className="w-full max-w-lg rounded-t-[28px] md:rounded-[24px] max-h-[88vh] overflow-y-auto sheet" style={{ background: "var(--surf)", boxShadow: "var(--sh-3)" }} onClick={(ev) => ev.stopPropagation()}>
        <div className="sticky top-0 z-10 px-5 py-4 flex items-center justify-between backdrop-blur-xl" style={{ background: "color-mix(in srgb, var(--surf) 92%, transparent)", borderBottom: "1px solid var(--line)" }}>
          <div className="font-bold text-[var(--txt)]">{tr("کەشف حساب")}</div>
          <button onClick={onClose} className="p-1.5 text-[var(--txt-3)]"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5">
          <div className="flex gap-1 bg-[var(--line)] rounded-[var(--r-sm)] p-1 mb-4">
            {[["all", tr("هەمووی")], ["buy", tr("کڕینی ئەو")], ["sell", tr("فرۆشتنی ئەو")]].map(([k, t]) => (
              <button key={k} onClick={() => setMode(k)}
                className={`flex-1 py-2 rounded-lg text-sm ${mode === k ? "bg-[var(--surf)] text-[var(--pos)] font-bold shadow-sm" : "text-[var(--txt-2)]"}`}>{t}</button>
            ))}
          </div>
          <div className="border border-[var(--line)] rounded-[var(--r)] overflow-hidden">
            <div className="bg-slate-900 text-white px-4 py-3">
              <div className="font-bold">{u.name}</div>
              <div className="text-xs text-[var(--txt-3)] mt-0.5" style={num}>{today} · {MODE_KU[mode]}</div>
            </div>
            <div className="p-4">
              {(sums.sold || sums.bought) && (
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="bg-[color-mix(in_srgb,var(--pos)_10%,transparent)] rounded-[var(--r-sm)] p-2.5">
                    <div className="text-[10px] text-[var(--pos)]/70">{tr("فرۆشتوویەتی بە من")}</div>
                    {sums.sold ? Object.entries(sums.sold).map(([cid, v]) => (
                      <div key={cid} className="text-sm font-bold text-[var(--pos)]" style={num}>{fmt(v, cur(cid).dec ?? 0)} {cur(cid).code}</div>
                    )) : <div className="text-sm text-[var(--txt-3)]">—</div>}
                  </div>
                  <div className="bg-[color-mix(in_srgb,var(--neg)_10%,transparent)] rounded-[var(--r-sm)] p-2.5">
                    <div className="text-[10px] text-[var(--neg)]/70">{tr("کڕیویەتی لە من")}</div>
                    {sums.bought ? Object.entries(sums.bought).map(([cid, v]) => (
                      <div key={cid} className="text-sm font-bold text-[var(--neg)]" style={num}>{fmt(v, cur(cid).dec ?? 0)} {cur(cid).code}</div>
                    )) : <div className="text-sm text-[var(--txt-3)]">—</div>}
                  </div>
                </div>
              )}
              <div className="text-[11px] font-bold text-[var(--txt-3)] uppercase mb-2">{tr("دوا مامەڵەکان")}</div>
              {last.length === 0 ? <div className="text-sm text-[var(--txt-3)]">{tr("هیچ")}</div> :
                last.map((t) => (
                  <div key={t.id} className="flex justify-between items-center py-1.5 border-b border-[var(--line)] last:border-0 text-sm">
                    <span className="text-[var(--txt-2)]">
                      <span style={num} className="text-xs text-[var(--txt-3)]">{new Date(t.date).toLocaleDateString("en-GB")}</span>
                      <span className="mr-2">{t.type === "buy" ? "فرۆشتنت" : "کڕینت"}</span>
                      {t.status === "pending" && <Pill tone="amber">{tr("چاوەڕوان")}</Pill>}
                    </span>
                    <span className="font-bold" style={num}>{fmt(t.amount, cur(t.curId).dec ?? 0)} {cur(t.curId).code}</span>
                  </div>
                ))}
              <div className="mt-3 pt-3 border-t border-[var(--line)] space-y-1.5">
                {owe.map(([cid, v]) => (
                  <div key={cid} className="flex justify-between text-sm">
                    <span className="text-[var(--txt-2)]">{tr("پارەی تۆ لای من")}</span>
                    <span className="font-bold text-[var(--neg)]" style={num}>{fmt(v, cur(cid).dec ?? 0)} {cur(cid).code}</span>
                  </div>
                ))}
                {due.map(([cid, v]) => (
                  <div key={cid} className="flex justify-between text-sm">
                    <span className="text-[var(--txt-2)]">{tr("قەرزی تۆ")}</span>
                    <span className="font-bold text-[var(--pos)]" style={num}>{fmt(v, cur(cid).dec ?? 0)} {cur(cid).code}</span>
                  </div>
                ))}
                {!owe.length && !due.length && <div className="text-sm text-[var(--pos)] font-semibold text-center py-1">{tr("حیساب پاکە ✅")}</div>}
              </div>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn className="flex-1" onClick={share}>{tr("ناردن")}</Btn>
            <Btn kind="ghost" className="flex-1" onClick={copy}>{tr("کۆپیکردن")}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ قەرزی ZEMAN بۆ نووسینگە ══════════════════ */
//
// What an office has covered out of its own money and has not been paid back for. It rises the
// moment the office presses «پارەم دا» and is the number the owner is answering when they say
// «حسابی نووسینگەکە بدەم» — so the figure and the button that clears it belong on one card, and
// that card is shown both on the office's own page and on the admin centre's office screen.
function OfficeDebts({ data, calc, officeId, title, officeSettle, readOnly }) {
  const owed = data.currencies
    .map((c) => ({ c, v: (calc.acctCash[officeId] || {})[c.id] || 0 }))
    .filter((r) => r.v > 0);
  return (
    <Card className="p-5">
      <SecLbl>{title ? `${tr("قەرزی ZEMAN بۆ")} ${title}` : tr("قەرزی ZEMAN بۆ ئەم نووسینگەیە")}</SecLbl>
      {owed.length === 0 ? <Empty t={tr("هیچ قەرزێک نەماوە ✓")} /> : owed.map(({ c, v }) => (
        <div key={c.id} className="flex flex-wrap justify-between items-center gap-3 py-2.5 border-b border-[var(--line)] last:border-0">
          <span className="text-sm text-[var(--txt-2)]">{c.name}</span>
          <Money v={v} dec={c.dec} />
          {!readOnly && (
            <Btn kind="primary" className="flex items-center gap-1.5"
              onClick={() => officeSettle(officeId, c.id, v)}>
              <CheckCircle2 className="w-4 h-4" /> {tr("حسابی نووسینگە دەدەمەوە")}
            </Btn>
          )}
        </div>
      ))}
      {owed.length > 0 && (
        <div className="text-[11.5px] mt-3" style={{ color: "var(--txt-3)" }}>
          {tr("ئەم پارەیە لە قاسەی گشتی دەردەچێت کاتێک حسابەکە دەدەیتەوە")}
        </div>
      )}
    </Card>
  );
}

/* ══════════════════ ناوەندی بەکارهێنەران ══════════════════ */
function PeopleHub(p) {
  const [tab, setTab] = useState("customers");
  const TABS = [["customers", tr("کڕیاران"), Users], ["partners", tr("هاوبەشان"), Handshake], ["investors", tr("وەبەرهێنەران"), TrendingUp],
    ["money", tr("پارە و گواستنەوە"), ArrowLeftRight], ["office", tr("نووسینگە"), Building2], ["manage", tr("بەڕێوەبردن"), UserCog]];
  return (
    <div className="space-y-4">
      <div className="flex gap-1 flex-wrap bg-[var(--surf)] border border-[var(--line)] rounded-[var(--r)] p-1.5">
        {TABS.map(([id, t, Ic]) => (
          <button key={id} onClick={() => { setTab(id); p.setDetailId(null); }}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--r-sm)] text-sm whitespace-nowrap transition ${tab === id ? "bg-[var(--pos)] text-white font-semibold shadow-sm" : "text-[var(--txt-2)] hover:bg-[var(--line)]"}`}>
            <Ic className="w-4 h-4" /> {t}
          </button>
        ))}
      </div>
      {tab === "customers" && <Customers {...p} />}
      {tab === "partners" && <Partners {...p} />}
      {tab === "investors" && <Investors {...p} />}
      {tab === "money" && <AccountMoney {...p} />}
      {tab === "office" && <Office {...p} officeId={(p.data.users.find((x) => x.role === "office" && !x.deleted) || {}).id} />}
      {tab === "manage" && <UsersAdmin {...p} />}
    </div>
  );
}

/* ══════════════════ پارە دانان/دەرهێنان + گواستنەوەی حساب ══════════════════ */
function AccountMoney({ data, cur, usr, accountMove, accountTransfer, flash }) {
  const [mode, setMode] = useState("move");
  const all = data.users.filter((u) => u.role !== "admin" && !u.deleted);
  const [mv, setMv] = useState({ dir: "in", userId: "", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [xfer, setXfer] = useState({ fromId: "", toId: "", curId: data.currencies[0]?.id, amount: "", note: "" });
  const hist = useMemo(() => {
    const rows = data.acct || [];
    const out = [];
    const seenTransfers = new Set();

    for (const h of rows) {
      if ((h.type === "transfer_out" || h.type === "transfer_in") && h.refId) {
        if (seenTransfers.has(h.refId)) continue;
        seenTransfers.add(h.refId);
        const pair = rows.filter((x) => x.refId === h.refId);
        const from = pair.find((x) => x.type === "transfer_out");
        const to = pair.find((x) => x.type === "transfer_in");
        out.push({
          id: `transfer:${h.refId}`, kind: "transfer", curId: h.curId,
          amount: Math.abs(Number(from?.amount ?? to?.amount ?? 0)),
          fromName: from ? usr(from.userId).name : "—",
          toName: to ? usr(to.userId).name : "—",
          note: from?.note || to?.note || null,
          date: from?.date || to?.date || h.date,
        });
      } else if (h.type === "deposit" || h.type === "withdraw") {
        out.push({
          id: h.id, kind: "move", dir: Number(h.amount) >= 0 ? "in" : "out",
          userName: usr(h.userId).name, curId: h.curId, amount: Math.abs(Number(h.amount) || 0),
          note: h.note, date: h.date,
        });
      }
    }
    return out.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 60);
  }, [data.acct, data.users]);

  const roleLbl = (u) => `${u.name} (${ROLE_KU[u.role]})`;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-[var(--r)] p-1" style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
        {[["move", tr("پارە دانان / دەرهێنان")], ["transfer", tr("گواستنەوەی حساب")]].map(([k, t]) => (
          <button key={k} onClick={() => setMode(k)}
            className={`flex-1 py-2.5 rounded-lg text-sm ${mode === k ? "bg-[var(--pos)] text-white font-semibold" : "text-[var(--txt-2)] hover:bg-[var(--line)]"}`}>{t}</button>
        ))}
      </div>

      {mode === "move" ? (
        <Card className="p-5">
          <SecLbl>{tr("پارە داخڵکردن یان دەرهێنان لە حسابی هەر کەسێک")}</SecLbl>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <Lbl>{tr("جۆر")}</Lbl>
              <Sel value={mv.dir} onChange={(e) => setMv({ ...mv, dir: e.target.value })}>
                <option value="in">{tr("وەرگرتن (پارە دێت)")}</option>
                <option value="out">{tr("دان (پارە دەڕوات)")}</option>
              </Sel>
            </div>
            <div>
              <Lbl>{tr("کەس")}</Lbl>
              <Sel value={mv.userId} onChange={(e) => setMv({ ...mv, userId: e.target.value })}>
                <option value="">{tr("هەڵبژێرە...")}</option>
                {all.map((u) => <option key={u.id} value={u.id}>{roleLbl(u)}</option>)}
              </Sel>
            </div>
            <div><Lbl>{tr("دراو")}</Lbl><Sel value={mv.curId} onChange={(e) => setMv({ ...mv, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div><Lbl>{tr("بڕ")}</Lbl><Inp type="number" value={mv.amount} onChange={(e) => setMv({ ...mv, amount: e.target.value })} placeholder="0" /></div>
            <div><Lbl>{tr("تێبینی")}</Lbl><Inp value={mv.note} onChange={(e) => setMv({ ...mv, note: e.target.value })} /></div>
            <div className="flex items-end">
              <Btn className="w-full" onClick={() => { accountMove(mv); setMv({ ...mv, amount: "", note: "" }); }}>{tr("تۆمارکردن")}</Btn>
            </div>
          </div>
          {mv.userId && (
            <div className="text-xs text-[var(--txt-2)] mt-3 bg-[var(--line)] rounded-[var(--r-sm)] p-3">
              {usr(mv.userId).role === "investor" && "سەرمایەی وەبەرهێنەرەکە زیاد/کەم دەکرێت"}
              {usr(mv.userId).role === "partner" && "باڵانسی هاوبەشەکە زیاد/کەم دەکرێت"}
              {usr(mv.userId).role === "customer" && "پارە لە قاسەی گشتی دەچێت یان دێت"}
              {usr(mv.userId).role === "office" && "پارە لە قاسەی گشتی دەچێت یان دێت"}
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-5">
          <SecLbl>{tr("گواستنەوەی پارە لە حسابێکەوە بۆ حسابێکی تر")}</SecLbl>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <Lbl>{tr("لە حسابی")}</Lbl>
              <Sel value={xfer.fromId} onChange={(e) => setXfer({ ...xfer, fromId: e.target.value })}>
                <option value="">{tr("هەڵبژێرە...")}</option>
                {all.map((u) => <option key={u.id} value={u.id}>{roleLbl(u)}</option>)}
              </Sel>
            </div>
            <div>
              <Lbl>{tr("بۆ حسابی")}</Lbl>
              <Sel value={xfer.toId} onChange={(e) => setXfer({ ...xfer, toId: e.target.value })}>
                <option value="">{tr("هەڵبژێرە...")}</option>
                {all.filter((u) => u.id !== xfer.fromId).map((u) => <option key={u.id} value={u.id}>{roleLbl(u)}</option>)}
              </Sel>
            </div>
            <div><Lbl>{tr("دراو")}</Lbl><Sel value={xfer.curId} onChange={(e) => setXfer({ ...xfer, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div><Lbl>{tr("بڕ")}</Lbl><Inp type="number" value={xfer.amount} onChange={(e) => setXfer({ ...xfer, amount: e.target.value })} placeholder="0" /></div>
            <div><Lbl>{tr("تێبینی")}</Lbl><Inp value={xfer.note} onChange={(e) => setXfer({ ...xfer, note: e.target.value })} /></div>
            <div className="flex items-end">
              <Btn kind="gold" className="w-full" onClick={() => { accountTransfer(xfer); setXfer({ ...xfer, amount: "", note: "" }); }}>{tr("گواستنەوە")}</Btn>
            </div>
          </div>
          {xfer.fromId && xfer.toId && +xfer.amount > 0 && (
            <div className="text-sm text-[var(--txt)] mt-3 bg-[color-mix(in_srgb,var(--pos)_10%,transparent)] border border-[color-mix(in_srgb,var(--pos)_26%,transparent)] rounded-[var(--r-sm)] p-3">
              <b style={num}>{fmt(+xfer.amount, cur(xfer.curId).dec ?? 0)} {cur(xfer.curId).code}</b>{tr("لە")}<b>{usr(xfer.fromId).name}</b> {tr("دەبڕدرێت و دەچێتە حسابی")} <b>{usr(xfer.toId).name}</b>
            </div>
          )}
        </Card>
      )}

      <SecLbl>{tr("مێژوو")}</SecLbl>
      {hist.length === 0 ? (
          <Card className="p-4"><Empty t="هێشتا هیچ جوڵانەوەی حساب نییە" /></Card>
        ) : hist.map((h) => (
          <Card key={h.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {h.kind === "transfer"
              ? <><Pill tone="amber">{tr("گواستنەوە")}</Pill>
                  <span className="text-[var(--txt)]">{h.fromName} <span className="text-[var(--txt-3)]">←</span> {h.toName}</span></>
              : <><Pill tone={h.dir === "in" ? "green" : "red"}>{h.dir === "in" ? "وەرگرتن" : "دان"}</Pill>
                  <span className="text-[var(--txt)]">{h.userName}</span></>}
            <span className="font-bold" style={num}>{fmt(h.amount, cur(h.curId).dec ?? 0)} {cur(h.curId).code}</span>
            {h.note && <span className="text-xs text-[var(--txt-2)]">{h.note}</span>}
            <span className="text-[11px] text-[var(--txt-3)] mr-auto" style={num}>{new Date(h.date).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}

/* ══════════════════ قاسەی ئەکاونتێک ══════════════════ */
function AccountSafe({ userId, data, calc, cur, usr, accountMove, accountTransfer, flash, compact, readOnly }) {
  const [tab, setTab] = useState("balance");
  const u = usr(userId);
  const bal = calc.acctCash[userId] || {};
  const debt = calc.acctDebt[userId] || {};
  const moves = (data.acct || []).filter((e) => e.userId === userId).slice().reverse();
  const all = data.users.filter((x) => x.role !== "admin" && !x.deleted && x.id !== userId);
  const [mv, setMv] = useState({ dir: "in", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [xfer, setXfer] = useState({ toId: "", curId: data.currencies[0]?.id, amount: "", note: "" });
  const [q, setQ] = useState("");

  const rows = data.currencies.map((c) => ({ c, v: bal[c.id] || 0 })).filter((r) => r.v || !compact);
  const TY = { deposit: "دانان", withdraw: "دەرهێنان", transfer_in: "هاتووە", transfer_out: "نێردراوە", settle: "حیسابکردنەوە" };

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-[var(--r)] p-1 overflow-x-auto" style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
        {(readOnly ? [["balance", tr("قاسە")], ["hist", tr("مێژوو")]] : [["balance", tr("قاسە")], ["move", tr("زیادکردن / کەمکردن")], ["transfer", tr("گواستنەوە")], ["hist", tr("مێژوو")]]).map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            style={tab === k ? { background: "linear-gradient(180deg, var(--ac), var(--pos))", color: "#fff", boxShadow: "0 2px 8px -2px rgba(14,122,107,.4)" } : { color: "var(--txt-2)" }}
            className={`flex-1 whitespace-nowrap px-3 py-2.5 rounded-[var(--r-sm)] text-sm transition-all tap ${tab === k ? "font-bold" : "font-medium hover:bg-[var(--line)]"}`}>{t}</button>
        ))}
      </div>

      {tab === "balance" && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="p-5">
            <SecLbl>{tr("قاسە — پارەی لای من")}</SecLbl>
            {rows.length === 0 ? <Empty t={tr("بەتاڵە")} /> :
              rows.map(({ c, v }) => (
                <div key={c.id} className="flex items-center justify-between py-2.5 border-b border-[var(--line)] last:border-0">
                  <span className="text-sm text-[var(--txt-2)] flex items-center gap-2"><CurBadge c={c} size="sm" /> {c.name}</span>
                  <Money v={v} dec={0} />
                </div>
              ))}
            <div className="text-[11px] text-[var(--txt-3)] mt-3">
              {readOnly ? "بۆ زیادکردن یان دەرهێنانی پارە، پەیوەندی بە نووسینگە بکە" : "پارەی ڕاستەقینەی ئەم کەسە کە لای من دانراوە"}
            </div>
          </Card>

          <Card className="p-5">
            <SecLbl>{tr("قەرز — حیسابی مامەڵەکان")}</SecLbl>
            {data.currencies.filter((c) => debt[c.id]).length === 0 ? <Empty t={tr("حیساب پاکە")} /> :
              data.currencies.filter((c) => debt[c.id]).map((c) => {
                const v = debt[c.id];
                return (
                  <div key={c.id} className="flex items-center justify-between py-2.5 border-b border-[var(--line)] last:border-0">
                    <span className="text-sm text-[var(--txt-2)] flex items-center gap-2"><CurBadge c={c} size="sm" /> {c.name}</span>
                    <div className="text-left">
                      <Money v={Math.abs(v)} dec={0} />
                      <div className={`text-[10px] font-semibold ${v > 0 ? "text-[var(--neg)]" : "text-[var(--pos)]"}`}>
                        {v > 0 ? "قەرزاری ئەوم" : "ئەو قەرزارە"}
                      </div>
                    </div>
                  </div>
                );
              })}
            <div className="text-[11px] text-[var(--txt-3)] mt-3">{tr("لە مامەڵە چاوەڕوانەکانەوە")}</div>
          </Card>
        </div>
      )}

      {tab === "move" && !readOnly && (
        <Card className="p-5">
          <SecLbl>{tr("زیادکردن یان کەمکردنی پارە")}</SecLbl>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Lbl>{tr("جۆر")}</Lbl>
              <Sel value={mv.dir} onChange={(e) => setMv({ ...mv, dir: e.target.value })}>
                <option value="in">{tr("زیادکردن (پارە دەخەمە سەری)")}</option>
                <option value="out">{tr("کەمکردن (پارە دەردەهێنم)")}</option>
              </Sel>
            </div>
            <div><Lbl>{tr("دراو")}</Lbl><Sel value={mv.curId} onChange={(e) => setMv({ ...mv, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div><Lbl>{tr("بڕ")}</Lbl><Inp type="number" value={mv.amount} onChange={(e) => setMv({ ...mv, amount: e.target.value })} placeholder="0" /></div>
            <div><Lbl>{tr("تێبینی")}</Lbl><Inp value={mv.note} onChange={(e) => setMv({ ...mv, note: e.target.value })} /></div>
          </div>
          {+mv.amount > 0 && (
            <div className="mt-3 text-sm bg-[var(--line)] border border-[var(--line)] rounded-[var(--r-sm)] p-3">
              {tr("باڵانسی ئێستا")} <b style={num}>{fmtMoney(data, bal[mv.curId] || 0, mv.curId)}</b>
              <span className="mx-2 text-[var(--txt-3)]">←</span>
              {tr("دوای ئەمە")} <b style={num} className={mv.dir === "in" ? "text-[var(--pos)]" : "text-[var(--neg)]"}>
                {fmtMoney(data, (bal[mv.curId] || 0) + (mv.dir === "in" ? 1 : -1) * roundMoney(data, +mv.amount, mv.curId), mv.curId)}
              </b> {cur(mv.curId).code}
            </div>
          )}
          <Btn className="w-full mt-4" onClick={() => { accountMove({ ...mv, userId }); setMv({ ...mv, amount: "", note: "" }); }}>
            تۆمارکردن
          </Btn>
        </Card>
      )}

      {tab === "transfer" && !readOnly && (
        <Card className="p-5">
          <SecLbl>{tr("گواستنەوە بۆ حسابێکی تر")}</SecLbl>
          <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("گەڕان بە ناو یان ژمارە...")} className="mb-2" />
          <div className="max-h-40 overflow-y-auto mb-3 space-y-1">
            {all.filter((x) => !q || (x.name || "").includes(q) || (x.phone || "").includes(q)).map((x) => (
              <button key={x.id} onClick={() => setXfer({ ...xfer, toId: x.id })}
                className={`w-full text-right px-3 py-2 rounded-lg transition ${xfer.toId === x.id ? "bg-[var(--pos)] text-white" : "hover:bg-[var(--line)]"}`}>
                <div className="text-sm font-semibold">{x.name}</div>
                <div className={`text-[10px] ${xfer.toId === x.id ? "text-emerald-100" : "text-[var(--txt-3)]"}`}>{ROLE_KU[x.role]}</div>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Lbl>{tr("دراو")}</Lbl><Sel value={xfer.curId} onChange={(e) => setXfer({ ...xfer, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
            <div><Lbl>{tr("بڕ")}</Lbl><Inp type="number" value={xfer.amount} onChange={(e) => setXfer({ ...xfer, amount: e.target.value })} placeholder="0" /></div>
          </div>
          {xfer.toId && +xfer.amount > 0 && (
            <div className="mt-3 text-sm bg-[color-mix(in_srgb,var(--pos)_10%,transparent)] border border-[color-mix(in_srgb,var(--pos)_26%,transparent)] rounded-[var(--r-sm)] p-3">
              <b style={num}>{fmt(+xfer.amount, cur(xfer.curId).dec ?? 0)} {cur(xfer.curId).code}</b>{tr("لە")}<b>{u.name}</b> {tr("دەبڕدرێت و دەچێتە حسابی")} <b>{usr(xfer.toId).name}</b>
            </div>
          )}
          <Btn kind="gold" className="w-full mt-4" disabled={!xfer.toId}
            onClick={() => { accountTransfer({ ...xfer, fromId: userId }); setXfer({ ...xfer, amount: "", note: "" }); }}>
            گواستنەوە
          </Btn>
        </Card>
      )}

      {tab === "hist" && (
        moves.length === 0 ? <Card><Empty t={tr("هیچ جوڵانەوەیەک نییە")} /></Card> :
          moves.map((e) => (
            <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Pill tone={e.amount >= 0 ? "green" : "red"}>{TY[e.type] || e.type}</Pill>
              <span className="font-bold" style={num}>{e.amount >= 0 ? "+" : ""}{fmt(e.amount, cur(e.curId).dec ?? 0)} {cur(e.curId).code}</span>
              {e.note && <span className="text-xs text-[var(--txt-2)]">{e.note}</span>}
              <span className="text-[11px] text-[var(--txt-3)] mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
            </Card>
          ))
      )}
    </div>
  );
}

/* ══════════════════ کڕیاران ══════════════════ */
function Customers({ data, calc, cur, usr, detailId, setDetailId, onSave, settle, flash, ...rest }) {
  const customers = data.users.filter((u) => u.role === "customer" && !u.deleted);
  const [q, setQ] = useState("");
  if (detailId) return <CustomerDetail id={detailId} back={() => setDetailId(null)} data={data} calc={calc} cur={cur} usr={usr} onSave={onSave} settle={settle} flash={flash} {...rest} />;
  const list = customers.filter((u) => !q || (u.name || "").includes(q) || (u.phone || "").includes(q));
  return (
    <div className="space-y-3">
      <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("گەڕان بە ناو یان ژمارە...")} />
      {list.length === 0 ? <Card><Empty t={tr("هیچ کڕیارێک نەدۆزرایەوە")} /></Card> :
        list.map((u) => {
          const cnt = data.txs.filter((t) => !t.deleted && t.cpId === u.id).length;
          const c = calc.cust[u.id];
          const owe = c ? Object.entries(c.owe).filter(([, v]) => v) : [];
          const due = c ? Object.entries(c.due).filter(([, v]) => v) : [];
          return (
            <Card key={u.id} className="p-4" onClick={() => setDetailId(u.id)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--txt)]">{u.name}</div>
                  <div className="text-xs text-[var(--txt-2)] mt-0.5">{cnt} مامەڵە{u.phone && <span style={num}> · {u.phone}</span>}</div>
                </div>
                <div className="text-left shrink-0 space-y-0.5">
                  {owe.map(([cid, v]) => <div key={cid} className="text-xs text-[var(--neg)] font-semibold">{tr("قەرزاری ئەوم:")} <span style={num}>{fmt(v, cur(cid).dec ?? 0)}</span> {cur(cid).code}</div>)}
                  {due.map(([cid, v]) => <div key={cid} className="text-xs text-[var(--pos)] font-semibold">{tr("لای ئەو:")} <span style={num}>{fmt(v, cur(cid).dec ?? 0)}</span> {cur(cid).code}</div>)}
                  {!owe.length && !due.length && <div className="text-xs text-[var(--txt-3)]">{tr("حیساب پاکە")}</div>}
                </div>
              </div>
            </Card>
          );
        })}
    </div>
  );
}

/* دوو قاسەی کڕیار + مێژووی فلتەرکراو */
function CustomerDetail({ id, back, data, calc, cur, usr, onSave, settle, flash, ...rest }) {
  const u = usr(id);
  const [stmt, setStmt] = useState(false);
  const c = calc.cust[id] || { owe: {}, due: {} };
  const base = data.txs.filter((t) => !t.deleted && t.cpId === id).reverse();
  const [list, f, setF] = useTxFilter(base, cur, usr);
  const [tab, setTab] = useState("history");
  return (
    <div className="space-y-4">
      <Back onClick={back} t={tr("گەڕانەوە بۆ لیستی کڕیاران")} />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-[var(--txt)]">{u.name}</h2>
          {(u.phone || u.address) && <div className="text-xs text-[var(--txt-2)] mt-0.5">{u.phone && <span style={num}>{u.phone}</span>}{u.phone && u.address && " · "}{u.address}</div>}
        </div>
        <div className="flex gap-2">
          {u.phone && (
            <Btn kind="ghost" className="flex items-center gap-1.5"
              onClick={() => rest.waNotify?.(u, tr("ئاگاداری"), `${tr("حیسابەکەت")}: ${Object.entries(c.owe).map(([k, v]) => `${fmt(v, 0)} ${cur(k).code}`).join(" · ") || tr("پاکە")}`)}>
              <MessageCircle className="w-4 h-4" /> {tr("واتساپ")}
            </Btn>
          )}
          <Btn kind="ghost" className="flex items-center gap-1.5" onClick={() => setStmt(true)}>
            <Share2 className="w-4 h-4" /> {tr("کەشف حساب")}
          </Btn>
        </div>
      </div>
      {stmt && <Statement u={u} txs={base} c={c} cur={cur} flash={flash} onClose={() => setStmt(false)} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card className="p-4 border-[color-mix(in_srgb,var(--neg)_26%,transparent)] bg-[color-mix(in_srgb,var(--neg)_8%,transparent)]">
          <div className="text-xs font-semibold text-[var(--neg)] mb-2">{tr("پارەی ئەو لای من (قەرزاری ئەوم)")}</div>
          {Object.entries(c.owe).filter(([, v]) => v).length === 0 ? <div className="text-sm text-[var(--txt-3)]">{tr("هیچ")}</div> :
            Object.entries(c.owe).filter(([, v]) => v).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-1">
                <span className="text-sm text-[var(--txt-2)]">{cur(cid).name}</span>
                <span className="text-lg font-bold text-[var(--neg)]" style={num}>{fmt(v, 0)}</span>
              </div>
            ))}
        </Card>
        <Card className="p-4 border-[color-mix(in_srgb,var(--pos)_26%,transparent)] bg-[color-mix(in_srgb,var(--pos)_8%,transparent)]">
          <div className="text-xs font-semibold text-[var(--pos)] mb-2">{tr("پارەی من لای ئەو (قەرزارمە)")}</div>
          {Object.entries(c.due).filter(([, v]) => v).length === 0 ? <div className="text-sm text-[var(--txt-3)]">{tr("هیچ")}</div> :
            Object.entries(c.due).filter(([, v]) => v).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-1">
                <span className="text-sm text-[var(--txt-2)]">{cur(cid).name}</span>
                <span className="text-lg font-bold text-[var(--pos)]" style={num}>{fmt(v, 0)}</span>
              </div>
            ))}
        </Card>
      </div>

      <div className="flex gap-1 rounded-[var(--r)] p-1 overflow-x-auto" style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
        {[["history", tr("مێژوو")], ["safe", tr("قاسە")], ["receipts", tr("فیشەکان")], ["new", tr("مامەڵەی نوێ")]].map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-1 px-4 py-2.5 rounded-lg text-sm ${tab === k ? "bg-[var(--pos)] text-white font-semibold" : "text-[var(--txt-2)] hover:bg-[var(--line)]"}`}>{t}</button>
        ))}
      </div>

      {tab === "safe" ? <AccountSafe userId={id} data={data} calc={calc} cur={cur} usr={usr} flash={flash} {...rest} />
      : tab === "receipts" ? <ReceiptArchive customerId={id} data={data} flash={flash} /> : tab === "new" ? (
        <TxForm data={data} calc={calc} cur={cur} usr={usr} {...rest} onSave={(fm, e) => onSave({ ...fm, cpMode: "acc", cpId: id, cpName: "" }, e)} lockCp={id} />
      ) : (
        <>
          <TxFilterBar data={data} f={f} setF={setF} count={list.length} />
          {list.length === 0 ? <Card><Empty t={tr("هیچ مامەڵەیەک نەدۆزرایەوە")} /></Card> :
            list.map((t) => <TxRow key={t.id} t={t} cur={cur} usr={usr} settle={settle} />)}
        </>
      )}
    </div>
  );
}

/* ══════════════════ هاوبەشان ══════════════════ */
function Partners({ data, calc, cur, usr, transfer, detailId, setDetailId }) {
  const partners = data.users.filter((u) => u.role === "partner" && !u.deleted);
  const [tf, setTf] = useState({ partnerId: "", curId: data.currencies[0]?.id, amount: "", dir: "to" });
  const [sel, setSel] = useState(null);
  if (sel) {
    const p = partners.find((x) => x.id === sel);
    return <div className="space-y-4"><Back onClick={() => setSel(null)} t={tr("گەڕانەوە بۆ لیستی هاوبەشان")} /><PartnerDetail p={p} data={data} calc={calc} cur={cur} /></div>;
  }
  const fr = tf.partnerId ? (usr(tf.partnerId).rate || 0) : 0;
  return (
    <div className="space-y-3">
      <Card className="p-5">
        <SecLbl>{tr("گواستنەوەی پارە")}</SecLbl>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div><Lbl>{tr("ئاڕاستە")}</Lbl><Sel value={tf.dir} onChange={(e) => setTf({ ...tf, dir: e.target.value })}><option value="to">{tr("بۆ لای هاوبەش")}</option><option value="back">{tr("لە لای هاوبەشەوە")}</option></Sel></div>
          <div><Lbl>{tr("هاوبەش")}</Lbl><Sel value={tf.partnerId} onChange={(e) => setTf({ ...tf, partnerId: e.target.value })}><option value="">—</option>{partners.map((p) => {
            const b = (calc.partner[p.id] || {})[tf.curId] || 0;
            return <option key={p.id} value={p.id}>{p.name} — {fmt(Math.abs(b), cur(tf.curId).dec)}{b < 0 ? " (قەرز)" : ""}</option>;
          })}</Sel></div>
          <div><Lbl>{tr("دراو")}</Lbl><Sel value={tf.curId} onChange={(e) => setTf({ ...tf, curId: e.target.value })}>{data.currencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
          <div><Lbl>{tr("بڕ")}</Lbl><Inp type="number" value={tf.amount} onChange={(e) => setTf({ ...tf, amount: e.target.value })} placeholder="0" /></div>
          <div className="flex items-end"><Btn kind="gold" className="w-full" onClick={() => { transfer(tf); setTf({ ...tf, amount: "" }); }}>{tr("گواستنەوە")}</Btn></div>
        </div>
        {tf.dir === "to" && fr > 0 && +tf.amount > 0 && (
          <div className="mt-3 text-sm text-[var(--txt-2)] bg-[var(--line)] border border-[var(--line)] rounded-[var(--r-sm)] p-3">
            {tr("عمولەی")} {fr}{tr("٪")} = <b style={num}>{fmtMoney(data, roundMoney(data, roundMoney(data, +tf.amount, tf.curId) * fr / 100, tf.curId), tf.curId)}</b> {tr("— باڵانسی دوایی:")} <b style={num}>{fmtMoney(data, roundMoney(data, +tf.amount, tf.curId) - roundMoney(data, roundMoney(data, +tf.amount, tf.curId) * fr / 100, tf.curId), tf.curId)}</b>
          </div>
        )}
      </Card>
      {partners.map((p) => {
        const bal = calc.partner[p.id] || {};
        const hasDebt = Object.values(bal).some((v) => v < 0);
        return (
          <Card key={p.id} className="p-4 flex items-center justify-between" onClick={() => setSel(p.id)}>
            <div>
              <div className="font-semibold text-[var(--txt)]">{p.name} <span className="text-xs text-[var(--txt-3)] font-normal">· عمولە {p.rate}٪</span></div>
              <div className="text-xs text-[var(--txt-2)] mt-0.5">
                {Object.entries(bal).filter(([, v]) => v).map(([cid, v]) => `${fmt(v, cur(cid).dec)} ${cur(cid).code}`).join(" · ") || "بەتاڵ"}
                {hasDebt && <span className="text-[var(--neg)] font-bold"> {tr("· قەرز")}</span>}
              </div>
            </div>
            <ChevronLeft className="w-5 h-5 text-[var(--txt-3)]" />
          </Card>
        );
      })}
    </div>
  );
}

function PartnerDetail({ p, data, calc, cur }) {
  const bal = calc.partner[p.id] || {};
  const fees = {};
  data.ledger.forEach((e) => { if (e.partnerId === p.id && e.type === "partner_fee") fees[e.curId] = (fees[e.curId] || 0) + Math.abs(e.amount); });
  const hist = data.ledger.filter((e) => e.partnerId === p.id).slice().reverse();
  const TY = { buy: "کڕین — دانان", sell: "فرۆشتن لە ئەکاونتەکەی", transfer: "گواستنەوە", partner_fee: "عمولە" };
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-[var(--txt)]">{p.name}</h2>
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5">
          <SecLbl>{tr("باڵانس (سالب = قەرز لەسەر تۆ)")}</SecLbl>
          {Object.keys(bal).length === 0 ? <Empty t={tr("بەتاڵە")} /> :
            Object.entries(bal).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-2 border-b border-[var(--line)] last:border-0">
                <span className="text-sm text-[var(--txt-2)]">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} />
              </div>
            ))}
        </Card>
        <Card className="p-5">
          <SecLbl>عمولەی وەرگیراو ({p.rate}٪)</SecLbl>
          {Object.keys(fees).length === 0 ? <Empty t={tr("هێشتا هیچ")} /> :
            Object.entries(fees).map(([cid, v]) => (
              <div key={cid} className="flex justify-between py-2 border-b border-[var(--line)] last:border-0">
                <span className="text-sm text-[var(--txt-2)]">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} pos />
              </div>
            ))}
          <div className="text-[11px] text-[var(--txt-3)] mt-2">{tr("دەستبەجێ لە کاتی تێکردندا کەم کراوەتەوە")}</div>
        </Card>
      </div>
      <SecLbl>مێژووی ئاڵووگۆر ({hist.length})</SecLbl>
      {hist.length === 0 ? <Card><Empty t={tr("هیچ نییە")} /></Card> :
        hist.map((e) => (
          <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Pill tone={e.amount >= 0 ? "green" : "red"}>{e.amount >= 0 ? "هاتنە ژوورەوە" : "چوونە دەرەوە"}</Pill>
            <span><Money v={e.amount} dec={cur(e.curId).dec} /> {cur(e.curId).code}</span>
            <span className="text-[var(--txt-2)]">{TY[e.type] || e.type}</span>
            <span className="text-[11px] text-[var(--txt-3)] mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}

/* ══════════════════ وەبەرهێنەران ══════════════════ */
function Investors({ data, calc, cur, invUnpaid, invShare, profitAll }) {
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);
  const [sel, setSel] = useState(null);
  if (sel) {
    const u = investors.find((x) => x.id === sel);
    return <div className="space-y-4"><Back onClick={() => setSel(null)} t={tr("گەڕانەوە بۆ لیستی وەبەرهێنەران")} /><InvestorDetail u={u} data={data} calc={calc} cur={cur} invUnpaid={invUnpaid} invShare={invShare} profitAll={profitAll} /></div>;
  }
  return (
    <div className="space-y-3">
      {investors.length === 0 ? <Card><Empty t={tr("هیچ وەبەرهێنەرێک نییە")} /></Card> :
        investors.map((u) => {
          const cap = calc.invCap[u.id] || {};
          return (
            <Card key={u.id} className="p-4 flex items-center justify-between" onClick={() => setSel(u.id)}>
              <div>
                <div className="font-semibold text-[var(--txt)]">{u.name} <span className="text-xs text-[var(--txt-3)] font-normal">· خێر {u.rate}٪</span></div>
                <div className="text-xs text-[var(--txt-2)] mt-0.5">
                  {Object.entries(cap).filter(([, v]) => v).map(([cid, v]) => `${fmt(v, cur(cid).dec)} ${cur(cid).code}`).join(" · ") || "سەرمایە دانەنراوە"}
                </div>
              </div>
              <ChevronLeft className="w-5 h-5 text-[var(--txt-3)]" />
            </Card>
          );
        })}
    </div>
  );
}

function InvestorDetail({ u, data, calc, cur, invUnpaid, mine }) {
  const cap = calc.invCap[u.id] || {};
  const hist = data.ledger.filter((e) => e.investorId === u.id).slice().reverse();
  const rows = data.currencies.map((c) => {
    const capV = cap[c.id] || 0;
    const up = invUnpaid(u.id, c.id);
    return { c, capV, up, tot: capV + up };
  }).filter((r) => r.capV || r.up);
  const main = rows[0];

  return (
    <div className="space-y-5">
      {!mine && <h2 className="text-[22px] font-semibold" style={{ color: "var(--txt)" }}>{u.name}</h2>}

      <div className="relative pt-4 pb-1 aura">
        <Hero label={mine ? tr("کۆی ماڵی من") : tr("کۆی ماڵی") + " " + u.name}
          value={main ? fmt(main.tot, 0) : "0"}
          unit={main ? cur(main.c.id).code : ""}
          sub={`${tr("ڕێژەی خێر")} ${u.rate}${tr("٪")} · ${(u.scope || []).length === 0 ? tr("لە هەموو دراوەکاندا") : (u.scope || []).map((x) => cur(x).code).join(l10n("، ", ", ", "، "))}`} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4">
          <div className="text-[11px] mb-2" style={{ color: "var(--txt-3)" }}>{tr("سەرمایە")}</div>
          {rows.filter((r) => r.capV).length === 0 ? <div style={{ color: "var(--txt-3)" }}>—</div> :
            rows.filter((r) => r.capV).map((r) => (
              <div key={r.c.id} className="text-[19px] font-semibold" style={{ ...num, color: "var(--txt)" }}>
                {fmt(r.capV, 0)} <span className="text-[11px] font-normal" style={{ color: "var(--txt-3)" }}>{r.c.code}</span>
              </div>
            ))}
        </Card>
        <Card className="p-4">
          <div className="text-[11px] mb-2" style={{ color: "var(--txt-3)" }}>{tr("خێری نەدراو")}</div>
          {rows.filter((r) => r.up).length === 0 ? <div style={{ color: "var(--txt-3)" }}>—</div> :
            rows.filter((r) => r.up).map((r) => (
              <div key={r.c.id} className="text-[19px] font-semibold" style={{ ...num, color: "var(--pos)" }}>
                {fmt(r.up, 0)} <span className="text-[11px] font-normal" style={{ color: "var(--txt-3)" }}>{r.c.code}</span>
              </div>
            ))}
        </Card>
      </div>

      <Card className="px-4 py-2">
        <div className="pt-2"><SecLbl>{tr("مێژووی پارە")} ({hist.length})</SecLbl></div>
        {hist.length === 0 ? <Empty t={tr("هیچ نییە")} /> :
          hist.map((e) => (
            <Row key={e.id}
              icon={<span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                style={{ background: e.type === "investor_payout" ? "var(--warn-bg)" : e.amount >= 0 ? "var(--pos-bg)" : "var(--neg-bg)" }}>
                {e.type === "investor_payout" ? <TrendingUp className="w-4 h-4" style={{ color: "var(--warn)" }} />
                  : e.amount >= 0 ? <ArrowDownLeft className="w-4 h-4" style={{ color: "var(--pos)" }} />
                  : <ArrowUpRight className="w-4 h-4" style={{ color: "var(--neg)" }} />}
              </span>}
              title={e.type === "investor_payout" ? (mine ? tr("وەرگرتنی خێر") : tr("پارەدانی خێر"))
                : e.amount >= 0 ? tr("پارە دانان") : tr("پارە دەرهێنان")}
              sub={new Date(e.date).toLocaleString("en-GB")}
              right={fmt(Math.abs(e.amount), cur(e.curId).dec ?? 0)} rightSub={cur(e.curId).code} />
          ))}
      </Card>
    </div>
  );
}


/* ══════════════════ نووسینگە ══════════════════ */
function Office({ data, cur, usr, officePay, officeSettle, calc, accountMove, accountTransfer, flash, officeId, readOnlyUser }) {
  const [tab, setTab] = useState("pending");
  const officeUser = officeId ? usr(officeId) : null;
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const pending = data.txs.filter((t) => !t.deleted && t.type === "buy" && t.status === "pending");
  const paid = data.txs.filter((t) => !t.deleted && t.paidAt);

  const t0 = new Date(); const d0 = new Date(t0.toDateString());
  const w0 = new Date(d0); w0.setDate(w0.getDate() - w0.getDay());
  const m0 = new Date(t0.getFullYear(), t0.getMonth(), 1);
  const sums = (fn) => { const m = {}; paid.filter(fn).forEach((t) => (m[t.againstId] = (m[t.againstId] || 0) + t.total)); return m; };
  const S = ({ title, m }) => (
    <>
      <div className="text-[11px] mb-1.5" style={{ color: "var(--txt-3)" }}>{title}</div>
      {Object.keys(m).length === 0 ? <div className="text-[17px]" style={{ color: "var(--txt-3)" }}>—</div> :
        Object.entries(m).map(([cid, v]) => (
          <div key={cid} className="text-[19px] font-semibold" style={{ ...num, color: "var(--txt)" }}>
            {fmt(v, cur(cid).dec ?? 0)} <span className="text-[11px] font-normal" style={{ color: "var(--txt-3)" }}>{cur(cid).code}</span>
          </div>
        ))}
    </>
  );

  // مێژووی پارەدانەکان بە گەڕان
  const hist = paid.filter((t) => {
    const d = dOnly(t.paidAt);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (!q) return true;
    const nm = t.cpId ? (usr(t.cpId).name || "") : (t.cpName || "");
    return `${t.code || ""} ${nm} ${cur(t.againstId).code}`.includes(q);
  }).sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));

  const histTot = {};
  hist.forEach((t) => (histTot[t.againstId] = (histTot[t.againstId] || 0) + t.total));

  const TABS = [["pending", `${tr("چاوەڕوان")} (${pending.length})`], ["hist", tr("مێژووی پارەدان")]];
  if (officeId) TABS.push(["safe", tr("قاسەی نووسینگە")]);

  return (
    <div className="space-y-4 md:space-y-5 portal-shell">
      <PortalHeader user={officeUser || { name: tr("نووسینگە") }} role={tr("نووسینگە")} icon={Building2}
        subtitle={`${pending.length} ${tr("چاوەڕوان")}`} />

      {(() => {
        const td = sums((t) => new Date(t.paidAt) >= d0);
        const k = Object.keys(td)[0];
        return (
          <div className="portal-hero-card">
            <Hero label={tr("پارەی دراوی ئەمڕۆ")}
              value={k ? fmt(td[k], 0) : "0"} unit={k ? cur(k).code : ""}
              sub={`${pending.length} ${tr("چاوەڕوان")}`} />
          </div>
        );
      })()}

      <div className="portal-kpi-grid">
        <div className="portal-kpi-card"><S title={tr("ئەم هەفتەیە")} m={sums((t) => new Date(t.paidAt) >= w0)} /></div>
        <div className="portal-kpi-card"><S title={tr("ئەم مانگە")} m={sums((t) => new Date(t.paidAt) >= m0)} /></div>
      </div>

      <MarketWatch compact />

      <div className="portal-tabs">
        {TABS.map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            style={tab === k ? { background: "linear-gradient(180deg, var(--ac), var(--pos))", color: "#fff", boxShadow: "0 2px 8px -2px rgba(14,122,107,.4)" } : { color: "var(--txt-2)" }}
            className={`flex-1 whitespace-nowrap px-3 py-2.5 rounded-[var(--r-sm)] text-sm transition-all tap ${tab === k ? "font-bold" : "font-medium hover:bg-[var(--line)]"}`}>{t}</button>
        ))}
      </div>

      {tab === "pending" && (
        pending.length === 0 ? <Card><Empty t={tr("هیچ مامەڵەیەکی چاوەڕوان نییە ✓")} /></Card> :
          pending.map((t) => (
            <Card key={t.id} className="p-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm portal-list-card">
              {t.code && <span className="text-[11px] font-bold text-[var(--txt-3)] bg-[var(--line)] px-2 py-0.5 rounded" style={num}>#{t.code}</span>}
              <span className="font-semibold text-[var(--txt)]">{t.cpId ? (usr(t.cpId).name || t.cpName) : t.cpName}</span>
              <span>{tr("بدرێتێ:")} <Money v={t.total} dec={0} /> {cur(t.againstId).code}</span>
              <span className="text-[11px] text-[var(--txt-3)]" style={num}>{new Date(t.date).toLocaleString("en-GB")}</span>
              <Btn className="mr-auto flex items-center gap-1.5" onClick={() => officePay(t, officeId)}>
                <Send className="w-4 h-4" /> {tr("ئەرک بدە بە نووسینگە")}
              </Btn>
            </Card>
          ))
      )}

      {tab === "hist" && (
        <>
          <Card className="p-4 space-y-2.5">
            <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("گەڕان بە ناو یان کۆد...")} />
            <div className="grid grid-cols-2 gap-2.5">
              <div><Lbl>{tr("لە بەرواری")}</Lbl><Inp type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div><Lbl>{tr("بۆ بەرواری")}</Lbl><Inp type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            <div className="flex gap-1.5 flex-wrap pt-1">
              {[["ئەمڕۆ", 0], ["٧ ڕۆژ", 7], ["٣٠ ڕۆژ", 30]].map(([lbl, dd]) => (
                <button key={lbl} onClick={() => {
                  const x = new Date(); x.setDate(x.getDate() - dd);
                  setFrom(x.toISOString().slice(0, 10)); setTo(new Date().toISOString().slice(0, 10));
                }} className="px-3 py-1.5 rounded-lg bg-[var(--line)] hover:bg-[var(--line)] text-xs font-semibold text-[var(--txt-2)]">{lbl}</button>
              ))}
              <button onClick={() => { setQ(""); setFrom(""); setTo(""); }}
                className="px-3 py-1.5 rounded-lg bg-[var(--line)] hover:bg-[var(--line)] text-xs font-semibold text-[var(--txt-2)]">{tr("سڕینەوە")}</button>
            </div>
            <div className="flex gap-4 flex-wrap text-xs text-[var(--txt-2)] pt-2 border-t border-[var(--line)]">
              <span><b style={num}>{hist.length}</b>{tr("پارەدان")}</span>
              {Object.entries(histTot).map(([cid, v]) => <span key={cid}>{cur(cid).code}: <b style={num}>{fmt(v, 0)}</b></span>)}
            </div>
          </Card>

          {hist.length === 0 ? <Card><Empty t={tr("هیچ نەدۆزرایەوە")} /></Card> :
            hist.map((t) => (
              <Card key={t.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm portal-list-card">
                {t.code && <span className="text-[11px] font-bold text-[var(--txt-3)]" style={num}>#{t.code}</span>}
                <Pill tone="green">{tr("دراوە")}</Pill>
                <span className="font-semibold text-[var(--txt)]">{t.cpId ? (usr(t.cpId).name || t.cpName) : t.cpName}</span>
                <span className="font-bold" style={num}>{fmt(t.total, cur(t.againstId).dec ?? 0)} {cur(t.againstId).code}</span>
                <span className="text-[11px] text-[var(--txt-3)] mr-auto" style={num}>{new Date(t.paidAt).toLocaleString("en-GB")}</span>
              </Card>
            ))}
        </>
      )}

      {tab === "safe" && officeId && (
        <>
          <OfficeDebts data={data} calc={calc} officeId={officeId} title={usr(officeId)?.name}
            officeSettle={officeSettle} readOnly={!!readOnlyUser} />
          <AccountSafe userId={officeId} data={data} calc={calc} cur={cur} usr={usr}
            accountMove={accountMove} accountTransfer={accountTransfer} flash={flash} readOnly={!!readOnlyUser} />
        </>
      )}
    </div>
  );
}


/* ══════════════════ بەڕێوەبردنی ئەکاونت ══════════════════ */
function UsersAdmin({ data, cur, createUser, deleteUser, setUserRate, flash, isOwner }) {
  const [f, setF] = useState({ name: "", role: "customer", rate: "", scope: [], phone: "", address: "", note: "", password: "" });
  const roles = isOwner ? ["customer", "partner", "investor", "office", "admin"] : ["customer", "partner", "investor", "office"];
  const list = data.users.filter((u) =>
    !u.deleted &&
    (u.role !== "admin" || (isOwner && u.adminLevel !== "owner"))
  );
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <SecLbl>{tr("درووستکردنی ئەکاونتی نوێ")}</SecLbl>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div><Lbl>{tr("ناوی تەواو *")}</Lbl><Inp value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><Lbl>{tr("ڕۆڵ *")}</Lbl><Sel value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE_KU[r]}</option>)}</Sel></div>
          {(f.role === "partner" || f.role === "investor") && <div><Lbl>{f.role === "partner" ? "ڕێژەی عمولە ٪" : "ڕێژەی خێر ٪"}</Lbl><Inp type="number" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></div>}
          {f.role === "investor" && (
            <div className="col-span-2 md:col-span-3">
              <Lbl>{tr("لە کام دراوەکاندا شەریکە؟")}</Lbl>
              <div className="flex gap-1.5 flex-wrap">
                <button onClick={() => setF({ ...f, scope: [] })}
                  className={`px-3 py-2 rounded-[var(--r-sm)] text-xs font-semibold border transition ${!f.scope?.length ? "bg-[var(--pos)] text-white border-emerald-700" : "bg-[var(--surf)] border-[var(--line)] text-[var(--txt-2)]"}`}>
                  هەموو دراوەکان
                </button>
                {data.currencies.map((c) => {
                  const on = (f.scope || []).includes(c.id);
                  return (
                    <button key={c.id} onClick={() => {
                      const sc = new Set(f.scope || []);
                      on ? sc.delete(c.id) : sc.add(c.id);
                      setF({ ...f, scope: [...sc] });
                    }} className={`px-3 py-2 rounded-[var(--r-sm)] text-xs font-semibold border transition flex items-center gap-1.5 ${on ? "bg-[var(--pos)] text-white border-emerald-700" : "bg-[var(--surf)] border-[var(--line)] text-[var(--txt-2)]"}`}>
                      <CurBadge c={c} size="sm" /> {c.name}
                    </button>
                  );
                })}
              </div>
              <div className="text-[11px] text-[var(--txt-3)] mt-1.5">
                {(f.scope || []).length === 0
                  ? "لە خێری هەموو دراوەکاندا بەشی هەیە"
                  : `تەنها لە خێری ${(f.scope || []).map((x) => cur(x).name).join("، ")} بەشی هەیە`}
              </div>
            </div>
          )}
          <div><Lbl>{tr("ژمارەی مۆبایل * (لۆگین)")}</Lbl><Inp type="tel" dir="ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="07701234567" /></div>
          <div><Lbl>{tr("وشەی نهێنی * (لانیکەم ٨ پیت)")}</Lbl><Inp type="password" dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="••••••" /></div>
          <div><Lbl>{tr("ناونیشان")}</Lbl><Inp value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
          <div><Lbl>{tr("تێبینی")}</Lbl><Inp value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
        </div>
        <div className="mt-4">
          <Btn className="flex items-center gap-1.5" onClick={() => {
            if (!f.name || !f.phone || !f.password) return flash("ناو، ژمارە، و وشەی نهێنی پێویستن");
            createUser(f); setF({ name: "", role: "customer", rate: "", scope: [], phone: "", address: "", note: "", password: "" });
          }}><Plus className="w-4 h-4" />{tr("درووستکردن")}</Btn>
        </div>
      </Card>
      {list.map((u) => (
        <Card key={u.id} className="p-4 flex items-center gap-3 flex-wrap">
          <div className="flex-1">
            <div className="font-semibold text-[var(--txt)]">{u.name}</div>
            <div className="text-xs text-[var(--txt-2)] mt-0.5">
              {ROLE_KU[u.role]}{u.phone && <span style={num}> · {u.phone}</span>}{u.address && ` · ${u.address}`}
            </div>
            {u.role === "investor" && (
              <div className="text-[11px] text-[var(--pos)] mt-0.5">
                {(u.scope || []).length === 0 ? "لە هەموو دراوەکاندا" : `تەنها: ${(u.scope || []).map((x) => cur(x).code).join("، ")}`}
              </div>
            )}
            {u.note && <div className="text-[11px] text-[var(--txt-3)] mt-0.5">{u.note}</div>}
          </div>
          {(u.role === "partner" || u.role === "investor") && (
            <div className="flex items-center gap-1.5 text-sm">
              <span className="text-[var(--txt-2)] text-xs">{tr("ڕێژە")}</span>
              <input type="number" defaultValue={u.rate} onBlur={(e) => { if (+e.target.value !== u.rate) setUserRate(u, e.target.value); }}
                className="w-16 border border-[var(--line)] rounded-lg px-2 py-1 text-sm" style={num} />
              <span className="text-xs">{tr("٪")}</span>
            </div>
          )}
          <button onClick={() => deleteUser(u)} className="text-[var(--txt-3)] hover:text-[var(--neg)]"><Trash2 className="w-4 h-4" /></button>
        </Card>
      ))}
    </div>
  );
}

/* ══════════════════ ڕاپۆرت ══════════════════ */
function Report({ data, calc, cur, usr, profitIn, investorsProfitIn, invShare, sumUsd, toUsd, ratesReady, usdValueAt }) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(iso(today));
  const [tab, setTab] = useState("pl");

  const preset = (k) => {
    const t = new Date();
    if (k === "today") { setFrom(iso(t)); setTo(iso(t)); }
    if (k === "week") { const w = new Date(t); w.setDate(w.getDate() - w.getDay()); setFrom(iso(w)); setTo(iso(t)); }
    if (k === "month") { setFrom(iso(new Date(t.getFullYear(), t.getMonth(), 1))); setTo(iso(t)); }
    if (k === "prev") { const a = new Date(t.getFullYear(), t.getMonth() - 1, 1), b = new Date(t.getFullYear(), t.getMonth(), 0); setFrom(iso(a)); setTo(iso(b)); }
    if (k === "year") { setFrom(iso(new Date(t.getFullYear(), 0, 1))); setTo(iso(t)); }
  };

  const inR = (d) => { const x = dOnly(d); return x >= from && x <= to; };
  const txs = data.txs.filter((t) => !t.deleted && inR(t.date));
  const entries = data.ledger.filter((e) => inR(e.date));

  const profit = {}, loss = {};
  txs.forEach((t) => {
    if (t.type === "sell" && t.profit != null) {
      if (t.profit >= 0) profit[t.profitCurId] = (profit[t.profitCurId] || 0) + t.profit;
      else loss[t.profitCurId] = (loss[t.profitCurId] || 0) + Math.abs(t.profit);
    }
  });
  const exp = {}, fee = {}, payout = {}, flow = {};
  entries.forEach((e) => {
    if (e.type === "expense") exp[e.curId] = (exp[e.curId] || 0) + Math.abs(e.amount);
    if (e.type === "partner_fee") fee[e.curId] = (fee[e.curId] || 0) + Math.abs(e.amount);
    if (e.type === "investor_payout") payout[e.curId] = (payout[e.curId] || 0) + Math.abs(e.amount);
    const fl = (flow[e.curId] = flow[e.curId] || { inn: 0, out: 0 });
    if (e.amount >= 0) fl.inn += e.amount; else fl.out += Math.abs(e.amount);
  });
  const vol = {};
  txs.forEach((t) => {
    const v = (vol[t.curId] = vol[t.curId] || { buy: 0, sell: 0, n: 0 });
    if (t.type === "buy") v.buy += t.amount; else v.sell += t.amount; v.n++;
  });
  // §12: what is still held, valued at today's rate — a valuation, kept apart from earnings.
  // The position is taken as of the end of the reported range; the rate is today's, because
  // that is what the holding would fetch now.
  const unrealized = useMemo(() => unrealizedPnl({
    txs: data.txs,
    currencies: data.currencies,
    asOfDate: `${to}T23:59:59.999Z`,
    usdCostOf: (t) => usdValueAt(Number(t.total), t.againstId, "spend", t.date),
    // "receive": what the currency would realise if sold, which is the honest side of the
    // spread for a position we would have to sell.
    marketUsdRate: (curId) => usdValueAt(1, curId, "receive"),
  }), [data.txs, data.currencies, to, usdValueAt]);

  const pm = profitIn(from, to);
  const invP = investorsProfitIn(from, to);
  const net = {};
  data.currencies.forEach((c) => {
    const n = (profit[c.id] || 0) - (loss[c.id] || 0) - (exp[c.id] || 0) - (fee[c.id] || 0) - (invP[c.id] || 0);
    if (n) net[c.id] = n;
  });
  const allCurs = data.currencies.filter((c) => profit[c.id] || loss[c.id] || exp[c.id] || fee[c.id] || payout[c.id] || flow[c.id] || vol[c.id]);
  const investors = data.users.filter((u) => u.role === "investor" && !u.deleted);
  const buyCount = txs.filter((t) => t.type === "buy").length;
  const sellCount = txs.filter((t) => t.type === "sell").length;
  const netUsd = ratesReady ? sumUsd(net) : null;
  const netFallback = Object.values(net).reduce((s2, v) => s2 + (Number(v) || 0), 0);
  const reportNet = netUsd ?? netFallback;
  const reportNetTone = reportNet < 0 ? "negative" : reportNet > 0 ? "positive" : "neutral";

  const exportCsv = () => {
    const head = [tr("کۆد"), tr("جۆر"), tr("بەروار"), tr("لایەن"), tr("دراو"), tr("بڕ"), tr("ڕەیت"), tr("بەرامبەر"), tr("کۆ"), tr("شوێن"), tr("دۆخ"), tr("خێر")];
    const rows = txs.map((t) => [t.code || "", t.type === "buy" ? tr("کڕین") : tr("فرۆشتن"), new Date(t.date).toLocaleString("en-GB"),
      t.cpId ? (usr(t.cpId).name || t.cpName) : t.cpName, cur(t.curId).code, t.amount,
      (() => { const b = preferredRateBaseId(t.curId, t.againstId); const r = storedRateToDisplay(t.rate, t.curId, t.againstId, b); return r ? +r.toFixed(6) : ""; })(),
      cur(t.againstId).code, t.total,
      t.partnerId ? `${tr("لای")} ${usr(t.partnerId).name}` : tr("قاسەی گشتی"), t.status === "pending" ? tr("چاوەڕوان") : tr("تەواو"), t.profit ?? ""]);
    // Counterparty names and notes are text a customer supplied. Quoting alone does not stop a
    // spreadsheet evaluating a cell that begins with = + - or @, so every cell is neutralised.
    const csv = toCsv([head, ...rows]);
    const a = document.createElement("a");
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.href = href;
    a.download = `report_${from}_${to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const PL = ({ label, m, tone = "auto", bold }) => (
    <div className={`report-pl-row ${bold ? "is-total" : ""}`}>
      <span className="report-pl-label">{label}</span>
      <div className="text-end space-y-0.5">
        {Object.keys(m).length === 0 ? <span className="text-[13px]" style={{ color: "var(--txt-3)" }}>0</span> :
          Object.entries(m).map(([cid, raw]) => {
            const v = Number(raw) || 0;
            const neg = tone === "neg" || (tone === "auto" && v < 0);
            const pos = tone === "pos" || (tone === "auto" && v > 0);
            return (
              <div key={cid} className={bold ? "text-[18px]" : "text-[13px]"}
                style={{ ...num, fontWeight: bold ? 700 : 600, color: neg ? "var(--neg)" : pos ? "var(--pos)" : "var(--txt)" }}>
                {neg ? "−" : pos && tone === "auto" ? "+" : ""}{fmt(Math.abs(v), 0)}
                <span className="text-[10.5px] font-normal ms-1" style={{ color: "var(--txt-3)" }}>{cur(cid).code}</span>
              </div>
            );
          })}
      </div>
    </div>
  );

  const TABS = [["pl", tr("خێر و زەرەر")], ["flow", tr("هاتوو و تێچوو")], ["inv", tr("وەبەرهێنەران")]];

  return (
    <div className="space-y-5">
      <div className="report-head">
        <div className="min-w-0">
          <H sub={`${from} ${tr("تا")} ${to}`}>{tr("ڕاپۆرت")}</H>
          <div className="report-period-badge">
            <History className="w-3.5 h-3.5" />
            <span style={num}>{from}</span>
            <span>→</span>
            <span style={num}>{to}</span>
          </div>
        </div>
        <Btn kind="ghost" className="flex items-center gap-2" onClick={exportCsv}>
          <Download className="w-4 h-4" /> {tr("دەرهێنان بۆ ئێکسڵ")}
        </Btn>
      </div>

      <Card className="report-filter-card">
        <div className="report-preset-row">
          {[["today", tr("ئەمڕۆ")], ["week", tr("ئەم هەفتەیە")], ["month", tr("ئەم مانگە")], ["prev", tr("مانگی ڕابردوو")], ["year", tr("ئەمساڵ")]].map(([k, t]) => (
            <button key={k} onClick={() => preset(k)} className="report-preset tap">{t}</button>
          ))}
        </div>
        <div className="report-date-grid">
          <div><Lbl>{tr("لە")}</Lbl><Inp type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Lbl>{tr("بۆ")}</Lbl><Inp type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
      </Card>

      <div className="report-kpi-grid">
        <ReportKpi icon={ArrowLeftRight} label={tr("مامەڵەکان")} value={fmt(txs.length, 0)} sub={`${buyCount} ${tr("کڕین")} · ${sellCount} ${tr("فرۆشتن")}`} />
        <ReportKpi icon={ArrowDownLeft} label={tr("کڕین")} value={fmt(buyCount, 0)} tone="positive" delay={40} />
        <ReportKpi icon={ArrowUpRight} label={tr("فرۆشتن")} value={fmt(sellCount, 0)} tone="neutral" delay={80} />
        <ReportKpi icon={reportNet < 0 ? TrendingDown : TrendingUp} label={tr("نەتیجەی کۆتایی (بۆ خۆم)")}
          value={`${reportNet > 0 ? "+" : reportNet < 0 ? "−" : ""}${fmt(Math.abs(reportNet), 0)}${ratesReady ? " $" : ""}`}
          tone={reportNetTone} delay={120} />
      </div>

      <div className="flex gap-1 rounded-[var(--r)] p-1 overflow-x-auto" style={{ background: "var(--surf)", border: "1px solid var(--line)", boxShadow: "var(--sh-1)" }}>
        {TABS.map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            style={tab === k ? { background: "linear-gradient(180deg, var(--ac), var(--pos))", color: "#fff", boxShadow: "0 2px 8px -2px rgba(14,122,107,.4)" } : { color: "var(--txt-2)" }}
            className={`flex-1 whitespace-nowrap px-3 py-2.5 rounded-[var(--r-sm)] text-sm transition-all tap ${tab === k ? "font-bold" : "font-medium hover:bg-[var(--line)]"}`}>{t}</button>
        ))}
      </div>

      {tab === "pl" && (
        <Card className="p-5">
          <SecLbl>{tr("خێر و زەرەر")}</SecLbl>
          {allCurs.length === 0 ? <Empty t={tr("هیچ نییە لەم ماوەیەدا")} /> : <>
            <PL label={tr("خێری فرۆشتن")} m={profit} tone="pos" />
            <PL label={tr("زەرەری فرۆشتن")} m={loss} tone="neg" />
            <PL label={tr("خەرجی")} m={exp} tone="neg" />
            <PL label={tr("عمولەی هاوبەشان")} m={fee} tone="neg" />
            <PL label={tr("خێری وەبەرهێنەران")} m={invP} tone="neg" />
            <div className="mt-1 pt-1 border-t-2 border-slate-900/10">
              <PL label={tr("نەتیجەی کۆتایی (بۆ خۆم)")} m={net} tone="auto" bold />
            </div>
            {ratesReady && (
              <div className={`report-net-box ${netUsd < 0 ? "is-negative" : netUsd > 0 ? "is-positive" : ""}`}>
                <span className="text-sm font-semibold">{tr("کۆی نەت بە دۆلار")}</span>
                <span className="text-xl font-bold" style={num}>
                  {netUsd > 0 ? "+" : netUsd < 0 ? "−" : ""}{fmt(Math.abs(netUsd || 0), 0)} $
                </span>
              </div>
            )}
          </>}
        </Card>
      )}

      {/* §12: realized and unrealized are kept apart. What is above is money that has been
          earned; what is below is what the currency still held would be worth if it were sold
          today. Adding them produces a number that reads like earnings and is not. */}
      {tab === "pl" && (
        <Card className="p-5">
          <SecLbl>{tr("خێری نەکراو — هێشتا نەفرۆشراوە")}</SecLbl>
          <div className="text-xs text-[var(--txt-2)] mb-3 leading-relaxed">
            {tr("ئەمە هەڵسەنگاندنە، نەک قازانج. ئەو دراوەی هێشتا لای تۆیە بە نرخی ئەمڕۆ بەراورد دەکرێت لەگەڵ ئەوەی پێت کڕیوە. نرخ دەگۆڕێت و ئەم ژمارەیەش دەگۆڕێت.")}
          </div>
          {Object.keys(unrealized.byCurrency).length === 0 ? (
            <Empty t={tr("هیچ دراوێک لە مەخزەندا نەماوە")} />
          ) : (
            <>
              {Object.entries(unrealized.byCurrency).map(([cid, u]) => (
                <div key={cid} className="flex items-baseline justify-between gap-3 py-2 border-b border-[var(--line)] last:border-0">
                  <div>
                    <div className="text-sm font-semibold text-[var(--txt)]">{cur(cid).name}</div>
                    <div className="text-[11px] text-[var(--txt-3)]" style={num}>
                      {fmt(u.qty, cur(cid).dec ?? 0)} {cur(cid).code}
                      {u.costUsd != null && ` · ${tr("تێچوو")} ${fmt(u.costUsd, 0)}$`}
                    </div>
                  </div>
                  {u.unrealizedUsd == null ? (
                    <span className="text-[11px] text-[var(--warn)] text-end max-w-[190px]">
                      {unrealizedReasonText(u.reason)}
                    </span>
                  ) : (
                    <span className={`text-base font-bold ${u.unrealizedUsd > 0 ? "text-[var(--pos)]" : u.unrealizedUsd < 0 ? "text-[var(--neg)]" : "text-[var(--txt)]"}`} style={num}>
                      {u.unrealizedUsd > 0 ? "+" : u.unrealizedUsd < 0 ? "−" : ""}{fmt(Math.abs(u.unrealizedUsd), 0)} $
                    </span>
                  )}
                </div>
              ))}
              {/* A total over some positions and not others looks complete and is not. */}
              {unrealized.complete ? (
                <div className={`report-net-box ${unrealized.totalUsd < 0 ? "is-negative" : unrealized.totalUsd > 0 ? "is-positive" : ""}`}>
                  <span className="text-sm font-semibold">{tr("کۆی خێری نەکراو")}</span>
                  <span className="text-xl font-bold" style={num}>
                    {unrealized.totalUsd > 0 ? "+" : unrealized.totalUsd < 0 ? "−" : ""}{fmt(Math.abs(unrealized.totalUsd || 0), 0)} $
                  </span>
                </div>
              ) : (
                <div className="text-xs text-[var(--warn)] mt-3 p-3 rounded-[var(--r-sm)] border border-[color-mix(in_srgb,var(--warn)_30%,transparent)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)]">
                  {tr("کۆی گشتی نانووسرێت — هەندێک دراو هەڵنەسەنگێندراون:")}{" "}
                  {unrealized.unvalued.map((u) => cur(u.curId).code).join("، ")}
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {tab === "flow" && (
        <div className="space-y-4">
          <Card className="p-5">
            <SecLbl>{tr("هاتوو و تێچووی قاسە")}</SecLbl>
            {Object.keys(flow).length === 0 ? <Empty t={tr("هیچ")} /> :
              Object.entries(flow).map(([cid, fl]) => (
                <div key={cid} className="py-3 border-b border-[var(--line)] last:border-0">
                  <div className="font-semibold text-[var(--txt)] mb-2">{cur(cid).name}</div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-[color-mix(in_srgb,var(--pos)_10%,transparent)] rounded-lg py-2">
                      <div className="text-[10px] text-[var(--pos)]/70">{tr("هاتوو")}</div>
                      <div className="text-sm font-bold text-[var(--pos)]" style={num}>{fmt(fl.inn, 0)}</div>
                    </div>
                    <div className="bg-[color-mix(in_srgb,var(--neg)_10%,transparent)] rounded-lg py-2">
                      <div className="text-[10px] text-[var(--neg)]/70">{tr("تێچوو")}</div>
                      <div className="text-sm font-bold text-[var(--neg)]" style={num}>{fmt(fl.out, 0)}</div>
                    </div>
                    <div className="bg-[var(--line)] rounded-lg py-2">
                      <div className="text-[10px] text-[var(--txt-2)]">{tr("جیاوازی")}</div>
                      <div className="text-sm font-bold text-[var(--txt)]" style={num}>{fmt(fl.inn - fl.out, 0)}</div>
                    </div>
                  </div>
                </div>
              ))}
          </Card>
          <Card className="p-5">
            <SecLbl>{tr("قەبارەی مامەڵەکان")}</SecLbl>
            {Object.keys(vol).length === 0 ? <Empty t={tr("هیچ")} /> :
              Object.entries(vol).map(([cid, v]) => (
                <div key={cid} className="flex items-center justify-between py-2.5 border-b border-[var(--line)] last:border-0">
                  <div>
                    <div className="text-sm font-semibold text-[var(--txt)]">{cur(cid).name}</div>
                    <div className="text-xs text-[var(--txt-3)]" style={num}>{v.n} مامەڵە</div>
                  </div>
                  <div className="text-left text-sm">
                    <div className="text-[var(--pos)]">{tr("کڕدراو")}<b style={num}>{fmt(v.buy, 0)}</b></div>
                    <div className="text-[var(--neg)]">{tr("فرۆشراو")}<b style={num}>{fmt(v.sell, 0)}</b></div>
                  </div>
                </div>
              ))}
          </Card>
        </div>
      )}

      {tab === "inv" && (
        <Card className="p-5">
          <SecLbl>{tr("دابەشکردنی خێر")}</SecLbl>
          {investors.length === 0 || Object.keys(pm).length === 0 ? <Empty t={tr("هیچ خێرێک نییە لەم ماوەیەدا")} /> :
            investors.map((u) => {
              const rows = Object.entries(pm).map(([cid, tot]) => {
                // The amount decides whether there is a row: an investor who held capital
                // during the period but has withdrawn since still earned their share, and a
                // new investor with capital today earned nothing from an earlier period.
                const amt = invShare(u.id, cid, from, to);
                const cap = (calc.invCap[u.id] || {})[cid] || 0;
                if (!amt && !cap) return null;
                // Their actual portion of this currency's profit — not a current-capital ratio,
                // which would not match the amount beside it.
                return { cid, cap, share: tot ? amt / tot : 0, amt };
              }).filter(Boolean);
              if (!rows.length) return null;
              return (
                <div key={u.id} className="py-3 border-b border-[var(--line)] last:border-0">
                  <div className="flex justify-between items-center mb-2">
                    <div className="font-semibold text-[var(--txt)]">{u.name}</div>
                    <Pill>ڕێژە {u.rate}٪</Pill>
                  </div>
                  {rows.map((r) => (
                    <div key={r.cid} className="flex justify-between items-center py-1.5 text-sm">
                      <span className="text-[var(--txt-2)]">
                        {cur(r.cid).name} · سەرمایەی ئێستا <span style={num}>{fmt(r.cap, cur(r.cid).dec ?? 0)}</span> · بەشی لە خێر {(r.share * 100).toFixed(1)}٪
                      </span>
                      <span className="font-bold text-[var(--pos)]" style={num}>{fmt(r.amt, 0)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
        </Card>
      )}
    </div>
  );
}


/* ══════════════════ پاراستنی داتا و باکئەپ ══════════════════ */
function Backup({ data, calc, cur, downloadBackup, flash, sumUsd, mySafe, owners, ratesReady, isOwner, runSystemHealth, setMaintenanceMode }) {
  const [busy, setBusy] = useState(false);
  const [recon, setRecon] = useState(null);
  const [reconErr, setReconErr] = useState("");
  const [maintReason, setMaintReason] = useState("");
  const [maintBusy, setMaintBusy] = useState(false);
  const [rehearsal, setRehearsal] = useState(null);
  const runtime = data?.runtime || null;
  const frozen = !!runtime?.maintenance_mode;

  const counts = {
    مامەڵە: Number(data?.readModel?.counts?.active_txs ?? data.txs.filter((t) => !t.deleted).length),
    "تۆماری دەفتەر": Number(data?.readModel?.counts?.ledger_rows ?? data.ledger.length),
    بەکارهێنەر: data.users.filter((u) => !u.deleted).length,
    دراو: data.currencies.length,
  };

  // Table names as the export writes them, so a rehearsal can compare like with like. Only
  // the tables loaded into the client are counted; the rest are simply not compared, which is
  // honest — an uncounted table is not the same as an unchanged one.
  const liveRowCounts = {
    txs: data.txs.length,
    ledger: data.ledger.length,
    app_users: data.users.length,
    currencies: data.currencies.length,
  };

  const localChecks = (() => {
    const out = [];
    const withLedger = new Set(data.ledger.map((e) => e.txId).filter(Boolean));
    const orphan = data.txs.filter((t) => !t.deleted && !withLedger.has(t.id));
    out.push({ ok: orphan.length === 0, t: "هەموو مامەڵەکان تۆماری دەفتەریان هەیە", d: orphan.length ? `${orphan.length} مامەڵە بێ تۆمار` : "تەواو" });

    const txIds = new Set(data.txs.map((t) => t.id));
    const ghost = data.ledger.filter((e) => e.txId && !txIds.has(e.txId));
    out.push({ ok: ghost.length === 0, t: "هیچ تۆمارێکی سەرگەردان نییە", d: ghost.length ? `${ghost.length} تۆمار` : "تەواو" });

    const neg = data.currencies.filter((c) => (calc.atMe[c.id] || 0) < 0);
    out.push({ ok: neg.length === 0, t: "هیچ باڵانسێکی سالب نییە لە قاسەی سەرەکی", d: neg.length ? neg.map((c) => c.code).join("، ") : "تەواو" });

    out.push({ ok: ratesReady, t: "نرخی هەموو دراوەکان دانراوە", d: ratesReady ? "تەواو" : "هەندێک دراو نرخی نییە" });

    if (ratesReady) {
      const safe = sumUsd(calc.phys), own = owners.total;
      const diff = Math.abs(safe - own);
      const pct = safe > 0 ? (diff / safe) * 100 : 0;
      out.push({ ok: pct < 5, t: "خاوەندارێتی لەگەڵ قاسە دەگونجێت", d: `جیاوازی ${fmt(diff, 0)}$ (${pct.toFixed(1)}٪)` });
    }
    return out;
  })();

  const runServerRecon = async () => {
    setBusy(true);
    setReconErr("");
    try {
      const result = await runSystemHealth();
      setRecon(result?.reconciliation || result || null);
    } catch (e) {
      setRecon(null);
      setReconErr(e?.message || "یەکسانکردنەوە سەرکەوتوو نەبوو");
    } finally {
      setBusy(false);
    }
  };

  const localOk = localChecks.every((c) => c.ok);
  const serverOk = recon ? !!recon.ok : null;
  const rowPressure =
    Number(data?.readModel?.counts?.active_txs ?? data.txs.length) +
    Number(data?.readModel?.counts?.ledger_rows ?? data.ledger.length) +
    Number(data?.readModel?.counts?.account_ledger_rows ?? (data.acct?.length || 0));

  return (
    <div className="space-y-4">
      <H sub={tr("پشکنینی دروستی داتا، یەکسانکردنەوە و ڕێنمایی گەڕاندنەوەی بەرهەم")}>{tr("پاراستنی داتا")}</H>

      <Card className={`p-4 ${frozen ? "border-[color-mix(in_srgb,var(--neg)_40%,transparent)] bg-[color-mix(in_srgb,var(--neg)_8%,transparent)]" : "border-[color-mix(in_srgb,var(--pos)_28%,transparent)]"}`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="font-bold text-[var(--txt)] flex items-center gap-2">
              {frozen ? <AlertTriangle className="w-4 h-4 text-[var(--neg)]" /> : <CheckCircle2 className="w-4 h-4 text-[var(--pos)]" />}
              پەیمانی کارکردنی سیستەم · {runtime?.contract_version || "—"}
            </div>
            <div className="text-xs mt-1" style={{ color: frozen ? "var(--neg)" : "var(--txt-3)" }}>
              {frozen ? `ڕاگرتنی فریاکەوتن چالاکە${runtime?.maintenance_reason ? ` · ${runtime.maintenance_reason}` : ""}` : "ڕێگای تۆمارکردنی دارایی کراوەیە"}
            </div>
          </div>
          <Pill tone={frozen ? "red" : "green"}>{frozen ? "ڕاگیراوە" : "تۆمارکردن کراوەیە"}</Pill>
        </div>

        {isOwner && (
          <div className="mt-4 pt-4 border-t border-[var(--line)]">
            <Lbl>{frozen ? "هۆکاری کردنەوەی ڕێگای تۆمارکردن" : "هۆکاری ڕاگرتنی فریاکەوتن"}</Lbl>
            <Inp value={maintReason} onChange={(e) => setMaintReason(e.target.value)}
              placeholder="لانیکەم ١٢ پیت — هۆکاری ڕوون بنووسە" />
            <div className="mt-3 flex gap-2 flex-wrap">
              <Btn
                kind={frozen ? "gold" : "ghost"}
                disabled={maintBusy || maintReason.trim().length < 12}
                onClick={async () => {
                  setMaintBusy(true);
                  try {
                    const ok = await setMaintenanceMode?.(!frozen, maintReason);
                    if (ok) setMaintReason("");
                  } finally {
                    setMaintBusy(false);
                  }
                }}
              >
                {maintBusy ? "..." : frozen ? "کردنەوەی تۆمارکردنی دارایی" : "چالاککردنی ڕاگرتنی فریاکەوتن"}
              </Btn>
              <span className="text-[11px] self-center text-[var(--txt-3)]">
                تەنها خاوەنی سیستەم · MFA/AAL2
              </span>
            </div>
          </div>
        )}
      </Card>

      <Card className={`p-4 ${localOk && serverOk !== false ? "border-[color-mix(in_srgb,var(--pos)_34%,transparent)] bg-[color-mix(in_srgb,var(--pos)_8%,transparent)]" : "border-[color-mix(in_srgb,var(--warn)_34%,transparent)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)]"}`}>
        <div className="flex items-center gap-2 mb-3">
          {localOk && serverOk !== false ? <CheckCircle2 className="w-5 h-5 text-[var(--pos)]" /> : <AlertTriangle className="w-5 h-5 text-[var(--warn)]" />}
          <span className={`font-bold ${localOk && serverOk !== false ? "text-[var(--pos)]" : "text-[var(--warn)]"}`}>
            {localOk && serverOk !== false ? "پشکنینی ناوخۆیی ڕێکە" : "چەند خاڵێک پێویستی بە سەیرکردن هەیە"}
          </span>
        </div>

        {localChecks.map((c, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 text-sm border-b border-white/60 last:border-0">
            <span className="flex items-center gap-1.5 text-[var(--txt)]">
              {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-[var(--pos)]" /> : <AlertTriangle className="w-3.5 h-3.5 text-[var(--warn)]" />}
              {c.t}
            </span>
            <span className={`text-xs ${c.ok ? "text-[var(--txt-3)]" : "text-[var(--warn)] font-semibold"}`}>{c.d}</span>
          </div>
        ))}

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <Btn kind="ghost" onClick={runServerRecon} disabled={busy}>
            {busy ? "..." : "پشکنینی یەکسانکردنەوە لە سێرڤەر"}
          </Btn>
          {recon && (
            <Pill tone={recon.ok ? "green" : "red"}>
              {recon.ok ? `سەرکەوتوو · ${recon.warnings || 0} ئاگاداری` : `${recon.failures || 0} هەڵە`}
            </Pill>
          )}
          {reconErr && <span className="text-xs text-[var(--neg)]">{reconErr}</span>}
        </div>

        {Array.isArray(recon?.checks) && recon.checks.length > 0 && (
          <div className="mt-3 rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surf)] p-3">
            {recon.checks.map((c, i) => (
              <div key={`${c.name}-${i}`} className="flex justify-between gap-3 py-1 text-xs">
                <span className="text-[var(--txt-2)]">{c.name}</span>
                <span className={c.status === "PASS" ? "text-[var(--pos)]" : c.status === "WARN" ? "text-[var(--warn)]" : "text-[var(--neg)]"}>
                  {c.status} · {c.count ?? 0}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(counts).map(([k, v]) => (
          <Card key={k} className="p-4">
            <div className="text-xs text-[var(--txt-2)]">{k}</div>
            <div className="text-2xl font-bold" style={num}>{fmt(v, 0)}</div>
          </Card>
        ))}
      </div>

      {rowPressure >= 20000 && (
        <Card className="p-4 border-[color-mix(in_srgb,var(--warn)_34%,transparent)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)]">
          <div className="flex gap-2 items-start">
            <AlertTriangle className="w-5 h-5 text-[var(--warn)] shrink-0 mt-0.5" />
            <div className="text-sm text-[var(--txt-2)] leading-relaxed">
              مێژووی دارایی گەورە بووە ({fmt(rowPressure, 0)} ڕیز لە مامەڵە/دەفتەر/ئەکاونت).
              سیستەم بۆ دروستی حیساب هەموو مێژووەکە بە pagination بار دەکات و هیچ ڕیزێک بە نهێنی truncate ناکات.
              ئەگەر کاتی بارکردن بەرز بوو، پێویستە reporting/history ـی سێرڤەر-ساید چالاک بکرێت.
            </div>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <SecLbl>{tr("گەڕاندنەوە و باکئەپ")}</SecLbl>
        <div className="text-sm text-[var(--txt-2)] mb-3 leading-relaxed space-y-2">
          <p>
            باکئەپ/Point-in-Time Recovery ـی ڕاستەقینە لە ئاستی پڕۆژە و database ـی Supabase ڕێکدەخرێت.
            وێنەیەک کە لە هەمان database ـدا هەڵگیرێت disaster recovery نییە، بۆیە باکئەپە خۆکارە ناوخۆییە کۆنەکە ناچالاک کراوە.
          </p>
          <p>
            export ـی JSON ـی خوارەوە تەنها کۆپییەکی زیادەی off-site ـە؛ Auth/MFA secret، فایلەکانی Storage،
            database functions/policies و WAL/PITR ـی تێدا نییە.
          </p>
        </div>

        {isOwner ? (
          <Btn
            kind="ghost"
            className="flex items-center gap-1.5"
            onClick={async () => {
              setBusy(true);
              try { await downloadBackup(); }
              finally { setBusy(false); }
            }}
            disabled={busy}
          >
            <Download className="w-4 h-4" />
            {busy ? "..." : "دابەزاندنی off-site JSON export"}
          </Btn>
        ) : (
          <div className="text-xs text-[var(--txt-3)]">
            export ـی تەواوی داتا تەنها بۆ خاوەنی سیستەمە.
          </div>
        )}
      </Card>

      {/* §12: a backup nobody has read back is a backup nobody has tested. This reads a saved
          export, recomputes its checksum, and compares its counts against the live database. */}
      <Card className="p-5">
        <SecLbl>{tr("تاقیکردنەوەی گەڕاندنەوە")}</SecLbl>
        <div className="text-xs text-[var(--txt-2)] mb-3 leading-relaxed">
          {tr("فایلێکی export ـی پاشەکەوتکراو هەڵبژێرە — پشکنین دەکرێت کە تێکنەچووبێت و لەگەڵ داتابەیسی ئێستا بگونجێت.")}
        </div>
        <input type="file" accept="application/json,.json" className="text-xs w-full"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setRehearsal({ state: "working" });
            try {
              const result = await rehearseRestore(await file.text(), liveRowCounts);
              setRehearsal({ state: "done", result, name: file.name });
            } catch (err) {
              console.error("restore rehearsal", err);
              setRehearsal({ state: "done", result: { verdict: "unreadable", drift: [] }, name: file.name });
            } finally { e.target.value = ""; }
          }} />
        {rehearsal?.state === "working" && <div className="text-xs text-[var(--txt-3)] mt-3">{tr("پشکنین...")}</div>}
        {rehearsal?.state === "done" && (
          <div className={`text-xs mt-3 p-3 rounded-[var(--r-sm)] border ${
            rehearsal.result.verdict === "ok"
              ? "text-[var(--pos)] border-[color-mix(in_srgb,var(--pos)_30%,transparent)] bg-[color-mix(in_srgb,var(--pos)_9%,transparent)]"
              : rehearsal.result.verdict === "drifted"
                ? "text-[var(--warn)] border-[color-mix(in_srgb,var(--warn)_30%,transparent)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)]"
                : "text-[var(--neg)] border-[color-mix(in_srgb,var(--neg)_30%,transparent)] bg-[color-mix(in_srgb,var(--neg)_9%,transparent)]"}`}>
            <div className="font-semibold">{verdictText(rehearsal.result.verdict)}</div>
            {rehearsal.result.takenAt && (
              <div className="mt-1 opacity-80" style={num}>
                {tr("وەرگیراوە:")} {new Date(rehearsal.result.takenAt).toLocaleString("en-GB")}
              </div>
            )}
            {rehearsal.result.drift?.length > 0 && (
              <div className="mt-1.5">
                {rehearsal.result.drift.map((d) => (
                  <div key={d.table} style={num}>{d.table}: {d.inFile} → {d.inDatabase}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="p-4 bg-[var(--line)]">
        <div className="text-xs text-[var(--txt-2)] leading-relaxed">
          <b className="text-[var(--txt)]">{tr("Production recovery:")}</b>{" "}
          لە Supabase Dashboard ـدا Database Backups/PITR بپشکنە و بە پێی پلانی بەکارهاتوو recovery policy دیاری بکە.
          بۆ کاروباری دارایی، restore drill ـی بەردەوام و کۆپییەکی off-site جیا لە production پێویستە.
        </div>
      </Card>
    </div>
  );
}
/* نرخی جیهانی — تەنها بۆ زانیاری، پەیوەندی بە نرخی خۆت نییە */
function WorldRates({ data, cur }) {
  const [rates, setRates] = useState(null);
  const [at, setAt] = useState(null);

  const load = () => {
    setRates(null);
    fetch("/api/market-rates", { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((j) => { const values = Object.fromEntries((j.instruments || []).filter(i => i.value).map(i => i.id === "USD/CNY" ? ["CNY",i.value] : i.id === "EUR/USD" ? ["EUR",1/i.value] : i.id === "GBP/USD" ? ["GBP",1/i.value] : [i.id,i.value])); setRates(values); setAt(j.retrievedAt ? Date.parse(j.retrievedAt) : null); })
      .catch(() => setRates({}));
  };
  useEffect(() => { load(); }, []);

  const mine = data.currencies.filter((c) => c.id !== "usd");

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-1">
        <SecLbl>{tr("نرخی جیهانی")}</SecLbl>
        <button onClick={load} className="text-[11px] font-semibold" style={{ color: "var(--ac)" }}>{tr("نوێکردنەوە")}</button>
      </div>
      <div className="text-[11px] mb-3 leading-relaxed" style={{ color: "var(--txt-3)" }}>
        {tr("نرخی جیهانی بۆ بەراورد؛ نرخی مامەڵە لە نرخی ناوخۆی سیستەمەوە وەردەگیرێت.")}
      </div>

      {rates === null ? <Empty t={tr("بارکردن...")} /> :
        Object.keys(rates).length === 0 ? (
          <div className="text-sm rounded-[var(--r-sm)] p-3"
            style={{ background: "color-mix(in srgb, var(--warn) 11%, transparent)", color: "var(--warn)" }}>
            {tr("نەتوانرا نرخەکان وەربگیرێن")}
          </div>
        ) : (
          <>
            {mine.map((c) => {
              const w = rates[c.code];
              if (!w) return null;
              const own = c.buyRate && c.sellRate ? (c.buyRate + c.sellRate) / 2 : (c.buyRate || c.sellRate);
              const diff = own ? ((own - w) / w) * 100 : null;
              return (
                <div key={c.id} className="flex items-center justify-between py-2.5 border-b last:border-0" style={{ borderColor: "var(--line)" }}>
                  <span className="text-sm flex items-center gap-2.5" style={{ color: "var(--txt-2)" }}>
                    <CurBadge c={c} size="sm" /> {c.name}
                  </span>
                  <div className="text-left">
                    <div className="font-bold" style={{ ...num, color: "var(--txt)" }}>{fmt(w, 3)}</div>
                    {diff !== null && Math.abs(diff) > .05 && (
                      <div className="text-[10px]" style={{ ...num, color: diff > 0 ? "var(--pos)" : "var(--neg)" }}>
                        نرخی تۆ {diff > 0 ? "+" : ""}{diff.toFixed(1)}٪
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {at && <div className="text-[10px] mt-3" style={{ ...num, color: "var(--txt-3)" }}>
              نوێکراوەتەوە {new Date(at).toLocaleTimeString("en-GB")}
            </div>}
          </>
        )}
    </Card>
  );
}

/* ══════════════════ ڕەوت و شیکاری ══════════════════ */
function Insights({ data, calc, cur, usr, profitIn, ownProfitIn, sumUsd, ratesReady, mySafe, flash, loadRangeReport }) {
  const [tab, setTab] = useState("trend");
  const [span, setSpan] = useState(14);
  const [rateCur, setRateCur] = useState(null);
  const [hist, setHist] = useState(null);
  const [histErr, setHistErr] = useState("");
  const [serverRange, setServerRange] = useState(null);

  const loadRateHistory = async () => {
    setHist(null);
    setHistErr("");
    try {
      const { data: d, error } = await supabase.from("rate_history").select("*").order("created_at", { ascending: true }).limit(600);
      if (error) throw error;
      setHist(d || []);
    } catch (e) {
      console.error("rate-history", e);
      setHist([]);
      setHistErr("نەتوانرا مێژووی نرخەکان بار بکرێت");
    }
  };

  useEffect(() => { loadRateHistory(); }, []);

  useEffect(() => {
    if (!loadRangeReport) return;
    let cancelled = false;
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - (span - 1));
    loadRangeReport({ from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10) })
      .then((r) => { if (!cancelled) setServerRange(r); })
      .catch((e) => { console.warn("server range report unavailable; using client fallback", e); if (!cancelled) setServerRange(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span, data?.readModel?.generated_at]);

  const iso = (d) => d.toISOString().slice(0, 10);
  const days = [...Array(span)].map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (span - 1 - i)); return iso(d);
  });
  const short = (k) => k.slice(8) + "/" + k.slice(5, 7);

  /* ── خێری ڕۆژانە ── */
  const serverDaily = Array.isArray(serverRange?.daily) ? serverRange.daily : null;
  const serverDailyMap = new Map((serverDaily || []).map((x) => [String(x.date), x]));

  const dayProfit = days.map((k) => {
    const sr = serverDailyMap.get(k);
    if (sr) return { k: short(k), v: Math.round(Number(sr.profit_usd) || 0), raw: k };
    const shared = profitIn(k, k), own = ownProfitIn(k, k);
    const m = {};
    [...Object.keys(shared), ...Object.keys(own)].forEach((c) => (m[c] = (shared[c] || 0) + (own[c] || 0)));
    return { k: short(k), v: ratesReady ? Math.round(sumUsd(m)) : (Object.values(m)[0] || 0), raw: k };
  });
  const totProfit = dayProfit.reduce((s2, d) => s2 + d.v, 0);
  const best = dayProfit.reduce((a, b) => (b.v > a.v ? b : a), dayProfit[0] || { v: 0 });
  const avgDailyProfit = span ? totProfit / span : 0;

  /* ── قەبارەی مامەڵەکان ── */
  const dayVol = days.map((k) => {
    const sr = serverDailyMap.get(k);
    if (sr) return { k: short(k), v: Number(sr.tx_count) || 0 };
    const t = data.txs.filter((x) => !x.deleted && dOnly(x.date) === k);
    return { k: short(k), v: t.length };
  });
  const totTx = dayVol.reduce((s2, d) => s2 + d.v, 0);

  /* ── کڕین بەرامبەر فرۆشتن ── */
  const from = days[0];
  const inRange = data.txs.filter((t) => !t.deleted && dOnly(t.date) >= from);
  const serverBuy = (serverDaily || []).reduce((s,x) => s + (Number(x.buy_count) || 0),0);
  const serverSell = (serverDaily || []).reduce((s,x) => s + (Number(x.sell_count) || 0),0);
  const buySell = [
    { k: "کڕین", v: serverDaily ? serverBuy : inRange.filter((t) => t.type === "buy").length, color: "var(--pos)" },
    { k: "فرۆشتن", v: serverDaily ? serverSell : inRange.filter((t) => t.type === "sell").length, color: "var(--neg)" },
  ].filter((r) => r.v);

  /* ── دابەشکردنی قاسە ── */
  const safeSplit = data.currencies.map((c) => ({
    k: c.name, v: ratesReady ? Math.abs(sumUsd({ [c.id]: calc.phys[c.id] || 0 })) : Math.abs(calc.phys[c.id] || 0),
    color: `linear-gradient(${curStyle(c).mid})`.includes("gradient") ? curStyle(c).mid : curStyle(c).mid,
  })).filter((r) => r.v > 0);

  /* ── مێژووی نرخ ── */
  const rateCurs = data.currencies.filter((c) => c.id !== "usd");
  const activeCur = rateCur || rateCurs[0]?.id;
  const rateSeries = (() => {
    if (!hist?.length || !activeCur) return [];
    const rows = hist.filter((h) => h.cur_id === activeCur);
    if (!rows.length) return [];
    const mk = (key, name, color) => ({
      name, color,
      pts: rows.filter((r) => r[key] != null).map((r) => ({
        k: new Date(r.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" }),
        v: +r[key],
      })),
    });
    return [mk("buy_rate", tr("کڕین"), "var(--pos)"), mk("sell_rate", tr("فرۆشتن"), "var(--neg)")].filter((s2) => s2.pts.length);
  })();

  /* ── هێڵی کاتی چالاکی ── */
  const timeline = (data.audit || []).slice(0, 60);
  const dayGroups = {};
  timeline.forEach((a) => {
    const k = dOnly(a.date);
    (dayGroups[k] = dayGroups[k] || []).push(a);
  });

  /* ── ڕاپۆرتی ڕۆژانە ── */
  const today = iso(new Date());
  const rep = (() => {
    const t = data.txs.filter((x) => !x.deleted && dOnly(x.date) === today);
    const p = profitIn(today, today), o = ownProfitIn(today, today);
    const prof = {};
    [...Object.keys(p), ...Object.keys(o)].forEach((c) => (prof[c] = (p[c] || 0) + (o[c] || 0)));
    const vol = {};
    t.forEach((x) => { vol[x.curId] = vol[x.curId] || { buy: 0, sell: 0 }; vol[x.curId][x.type] += x.amount; });
    const pend = data.txs.filter((x) => !x.deleted && x.status === "pending").length;
    return { t, prof, vol, pend };
  })();

  const repText = () => {
    const L = [`*ڕاپۆرتی ڕۆژانە*`, `📅 ${new Date().toLocaleDateString("en-GB")}`, ""];
    L.push(`مامەڵە: ${rep.t.length}  (کڕین ${rep.t.filter((x) => x.type === "buy").length} · فرۆشتن ${rep.t.filter((x) => x.type === "sell").length})`);
    if (rep.pend) L.push(`چاوەڕوانی پارە: ${rep.pend}`);
    L.push("");
    if (Object.keys(rep.vol).length) {
      L.push("*قەبارە*");
      Object.entries(rep.vol).forEach(([cid, v]) => {
        const bits = [];
        if (v.buy) bits.push(`کڕین ${fmt(v.buy, 0)}`);
        if (v.sell) bits.push(`فرۆشتن ${fmt(v.sell, 0)}`);
        L.push(`• ${cur(cid).name}: ${bits.join(" · ")}`);
      });
      L.push("");
    }
    L.push("*خێر*");
    if (!Object.keys(rep.prof).length) L.push("• هیچ");
    Object.entries(rep.prof).forEach(([cid, v]) => L.push(`• ${fmt(v, cur(cid).dec ?? 0)} ${cur(cid).code}`));
    L.push("");
    L.push("*قاسەی گشتی*");
    data.currencies.forEach((c) => { if (calc.phys[c.id]) L.push(`• ${c.name}: ${fmt(calc.phys[c.id], 0)}`); });
    if (ratesReady) { L.push(""); L.push(`کۆی گشتی ≈ ${fmt(sumUsd(calc.phys), 0)} USD`); L.push(`ماڵی خۆم ≈ ${fmt(sumUsd(mySafe), 0)} USD`); }
    return L.join("\n");
  };

  /* ── پێشبینینی خێر ── */
  const fc = (() => {
    const vals = dayProfit.map((d) => d.v);
    const n = vals.length;
    if (n < 3) return null;
    // هێڵی ڕەوت (کەمترین چوارگۆشە)
    const sx = vals.reduce((a, _, i) => a + i, 0);
    const sy = vals.reduce((a, v) => a + v, 0);
    const sxy = vals.reduce((a, v, i) => a + i * v, 0);
    const sxx = vals.reduce((a, _, i) => a + i * i, 0);
    const den = n * sxx - sx * sx;
    const slope = den ? (n * sxy - sx * sy) / den : 0;
    const icpt = (sy - slope * sx) / n;
    const avg = sy / n;
    const at = (i) => icpt + slope * i;
    // وردی: چەند هێڵەکە لە داتای ڕابردوو نزیکە
    const ss = vals.reduce((a, v, i) => a + (v - at(i)) ** 2, 0);
    const tt = vals.reduce((a, v) => a + (v - avg) ** 2, 0);
    const fit = tt > 0 ? Math.max(0, 1 - ss / tt) : 0;
    return {
      avg: Math.round(avg), slope: Math.round(slope * 10) / 10, fit,
      day: Math.round(at(n)), week: Math.round([...Array(7)].reduce((a, _, k) => a + at(n + k), 0)),
      month: Math.round([...Array(30)].reduce((a, _, k) => a + at(n + k), 0)),
      proj: [...Array(7)].map((_, k) => Math.round(at(n + k))),
    };
  })();

  const TABS = [["trend", tr("ڕەوت")], ["fc", tr("پێشبینین")], ["rates", tr("مێژووی نرخ")], ["report", tr("ڕاپۆرتی ڕۆژ")], ["log", tr("چالاکی")]];

  return (
    <div className="space-y-5">
      <div className="analytics-head">
        <div>
          <H sub={tr("ڕەوتی خێر، مێژووی نرخەکان، کورتەی ڕۆژ و چاودێری بازاڕ")}>{tr("ڕەوت و شیکاری")}</H>
          <div className="analytics-live-badge"><span className="analytics-live-dot" /> داتای ناوخۆی سیستەم</div>
        </div>
      </div>

      <div className="analytics-tabs">
        {TABS.map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`analytics-tab tap ${tab === k ? "is-active" : ""}`}>{t}</button>
        ))}
      </div>

      {tab === "trend" && (
        <>
          <div className="flex gap-1.5 flex-wrap">
            {[[7, tr("٧ ڕۆژ")], [14, tr("١٤ ڕۆژ")], [30, tr("٣٠ ڕۆژ")]].map(([d, l]) => (
              <button key={d} onClick={() => setSpan(d)}
                style={span === d ? { background: "var(--ac)", color: "#fff" } : { background: "var(--line)", color: "var(--txt-2)" }}
                className="px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all tap">{l}</button>
            ))}
          </div>

          <div className="analytics-kpi-grid">
            <ReportKpi icon={totProfit < 0 ? TrendingDown : TrendingUp} label={`خێری ${span} ڕۆژ`}
              value={`${totProfit > 0 ? "+" : totProfit < 0 ? "−" : ""}${fmt(Math.abs(totProfit), 0)}${ratesReady ? " $" : ""}`}
              tone={totProfit < 0 ? "negative" : totProfit > 0 ? "positive" : "neutral"} />
            <ReportKpi icon={ArrowLeftRight} label={tr("مامەڵەکان")} value={fmt(totTx, 0)}
              sub={`${span} ڕۆژی ڕابردوو`} delay={40} />
            <ReportKpi icon={PieChart} label="مامناوەندی خێری ڕۆژانە"
              value={`${avgDailyProfit > 0 ? "+" : avgDailyProfit < 0 ? "−" : ""}${fmt(Math.abs(avgDailyProfit), 0)}${ratesReady ? " $" : ""}`}
              tone={avgDailyProfit < 0 ? "negative" : avgDailyProfit > 0 ? "positive" : "neutral"} delay={80} />
            <ReportKpi icon={TrendingUp} label={tr("باشترین ڕۆژ:")} value={best?.v ? fmt(best.v, 0) : "—"}
              sub={best?.v ? best.k : "داتا نییە"} tone={best?.v > 0 ? "positive" : "neutral"} delay={120} />
          </div>

          <Card className="p-5">
            <SecLbl>خێری ڕۆژانە{ratesReady ? " (دۆلار)" : ""}</SecLbl>
            <Bars rows={dayProfit} />
            {best?.v > 0 && (
              <div className="text-[11px] mt-3 pt-3" style={{ color: "var(--txt-3)", borderTop: "1px solid var(--line)" }}>
                {tr("باشترین ڕۆژ:")} <b style={{ ...num, color: "var(--pos)" }}>{fmt(best.v, 0)}</b> {l10n("لە", "on", "في")} {best.k}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <SecLbl>{tr("ژمارەی مامەڵەکان")}</SecLbl>
            <Bars rows={dayVol} h={110} />
          </Card>

          <div className="grid md:grid-cols-2 gap-4">
            {buySell.length > 0 && (
              <Card className="p-5"><SecLbl>{tr("کڕین بەرامبەر فرۆشتن")}</SecLbl><Donut rows={buySell} /></Card>
            )}
            {safeSplit.length > 0 && (
              <Card className="p-5"><SecLbl>{tr("دابەشکردنی قاسە")}</SecLbl><Donut rows={safeSplit} /></Card>
            )}
          </div>
        </>
      )}

      {tab === "fc" && (
        fc === null ? <Card><Empty t={tr("داتای پێویست نییە — لانیکەم ٣ ڕۆژ مامەڵە پێویستە")} /></Card> : <>
          <Card dark className="p-5">
            <div className="text-[11px] mb-1" style={{ color: "rgba(255,255,255,.5)" }}>
              بەپێی ڕەوتی {span} ڕۆژی ڕابردوو
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold" style={num}>{fmt(fc.avg, 0)}</span>
              <span className="text-sm" style={{ color: "rgba(255,255,255,.5)" }}>
                {ratesReady ? "$ " : ""}مامناوەندی ڕۆژانە
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-2 text-sm">
              <span style={{ color: fc.slope >= 0 ? "var(--ac)" : "var(--neg)" }} className="font-bold">
                {fc.slope > 0 ? "▲" : fc.slope < 0 ? "▼" : "■"} {fmt(Math.abs(fc.slope), 1)}
              </span>
              <span style={{ color: "rgba(255,255,255,.5)" }}>
                {fc.slope > 0 ? "بەرەو بەرزبوونەوە" : fc.slope < 0 ? "بەرەو نزمبوونەوە" : "جێگیر"} — ڕۆژانە
              </span>
            </div>
          </Card>

          <div className="grid grid-cols-3 gap-3">
            {[["سبەی", fc.day], ["٧ ڕۆژ", fc.week], ["٣٠ ڕۆژ", fc.month]].map(([l, v], i) => (
              <Card key={l} className="p-4 rise" style={{ animationDelay: `${i * 60}ms` }}>
                <div className="text-[11px]" style={{ color: "var(--txt-2)" }}>{l}</div>
                <div className="text-xl font-bold mt-0.5" style={{ ...num, color: v >= 0 ? "var(--pos)" : "var(--neg)" }}>
                  {fmt(v, 0)}
                </div>
              </Card>
            ))}
          </div>

          <Card className="p-5">
            <SecLbl>{tr("٧ ڕۆژی داهاتوو")}</SecLbl>
            <Bars rows={fc.proj.map((v, i) => {
              const d = new Date(); d.setDate(d.getDate() + i + 1);
              return { k: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`, v };
            })} h={120} />
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold" style={{ color: "var(--txt-2)" }}>{tr("دڵنیایی پێشبینین")}</span>
              <span className="text-sm font-bold" style={{ ...num, color: fc.fit > .6 ? "var(--pos)" : fc.fit > .3 ? "var(--warn)" : "var(--neg)" }}>
                {(fc.fit * 100).toFixed(0)}٪
              </span>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--line)" }}>
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${Math.max(3, fc.fit * 100)}%`,
                  background: fc.fit > .6 ? "linear-gradient(90deg, var(--ac), var(--pos))"
                    : fc.fit > .3 ? "linear-gradient(90deg, var(--ac), var(--ac))"
                    : "linear-gradient(90deg, var(--neg), var(--neg))" }} />
            </div>
            <div className="text-[11px] mt-2.5 leading-relaxed" style={{ color: "var(--txt-3)" }}>
              {fc.fit > .6 ? "ڕەوتەکە جێگیرە — پێشبینینەکە بەهێزە"
                : fc.fit > .3 ? "ڕەوتەکە هەڵکشانی هەیە — بە ئاگاداری وەریبگرە"
                : "مامەڵەکان زۆر جیاوازن — پێشبینینەکە تەنها ئاماژەیەکە"}
              <br />{tr("ئەمە خەمڵاندنێکە بەپێی ڕابردوو، نەک دڵنیایی.")}
            </div>
          </Card>
        </>
      )}

      {tab === "rates" && (
        <>
          <MarketWatch />
          <div className="flex gap-1.5 flex-wrap">
            {rateCurs.map((c) => (
              <button key={c.id} onClick={() => setRateCur(c.id)}
                style={activeCur === c.id
                  ? { background: "var(--ac)", color: "#fff", boxShadow: "0 2px 8px -2px rgba(184,134,59,.45)" }
                  : { background: "var(--line)", color: "var(--txt-2)" }}
                className="px-3.5 py-2 rounded-[var(--r-sm)] text-xs font-bold transition-all tap flex items-center gap-2">
                <CurBadge c={c} size="sm" /> {c.name}
              </button>
            ))}
          </div>
          <Card className="p-5">
            <SecLbl>مێژووی نرخی {cur(activeCur).name} — ١ دۆلار بە چەند</SecLbl>
            {hist === null ? <StatePanel type="loading" title={tr("بارکردن...")} compact /> :
              histErr ? <StatePanel type="error" title={histErr} detail="پەیوەندی Supabase بپشکنە و دووبارە هەوڵ بدەرەوە." onRetry={loadRateHistory} compact /> :
              rateSeries.length === 0 ? (
                <StatePanel title={tr("هێشتا مێژوویەک نییە — هەر جارێک نرخ بگۆڕیت، لێرە تۆمار دەبێت")} compact />
              ) : <>
                <LineChart series={rateSeries} />
                <div className="flex gap-4 mt-3 pt-3 text-xs" style={{ borderTop: "1px solid var(--line)" }}>
                  {rateSeries.map((s2, i) => {
                    const last = s2.pts[s2.pts.length - 1]?.v, first = s2.pts[0]?.v;
                    const ch = last - first;
                    return (
                      <span key={i} className="flex items-center gap-1.5" style={{ color: "var(--txt-2)" }}>
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: s2.color }} />
                        {s2.name}: <b style={num}>{fmt(last, 3)}</b>
                        {Math.abs(ch) > 1e-9 && (
                          <b style={{ ...num, color: ch > 0 ? "var(--pos)" : "var(--neg)" }}>
                            {ch > 0 ? "▲" : "▼"} {fmt(Math.abs(ch), 3)}
                          </b>
                        )}
                      </span>
                    );
                  })}
                </div>
              </>}
          </Card>
        </>
      )}

      {tab === "report" && (
        <>
          <Card dark className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-[11px]" style={{ color: "rgba(255,255,255,.5)" }}>{tr("ڕاپۆرتی ئەمڕۆ")}</div>
                <div className="text-lg font-bold" style={num}>{new Date().toLocaleDateString("en-GB")}</div>
              </div>
              <div className="text-left">
                <div className="text-[11px]" style={{ color: "rgba(255,255,255,.5)" }}>{tr("مامەڵە")}</div>
                <div className="text-2xl font-bold" style={num}>{rep.t.length}</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[["کڕین", rep.t.filter((x) => x.type === "buy").length], ["فرۆشتن", rep.t.filter((x) => x.type === "sell").length], ["چاوەڕوان", rep.pend]].map(([l, v], i) => (
                <div key={i} className="rounded-[var(--r-sm)] p-2.5 text-center" style={{ background: "rgba(255,255,255,.06)" }}>
                  <div className="text-[10px]" style={{ color: "rgba(255,255,255,.5)" }}>{l}</div>
                  <div className="text-lg font-bold" style={num}>{v}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <SecLbl>{tr("خێری ئەمڕۆ")}</SecLbl>
            {Object.keys(rep.prof).length === 0 ? <Empty t={tr("هێشتا هیچ خێرێک نییە")} /> :
              Object.entries(rep.prof).map(([cid, v]) => (
                <div key={cid} className="flex items-center justify-between py-2.5 border-b last:border-0" style={{ borderColor: "var(--line)" }}>
                  <span className="text-sm flex items-center gap-2" style={{ color: "var(--txt-2)" }}><CurBadge c={cur(cid)} size="sm" /> {cur(cid).name}</span>
                  <Money v={v} dec={0} pos />
                </div>
              ))}
          </Card>

          {Object.keys(rep.vol).length > 0 && (
            <Card className="p-5">
              <SecLbl>{tr("قەبارەی ئەمڕۆ")}</SecLbl>
              {Object.entries(rep.vol).map(([cid, v]) => (
                <div key={cid} className="flex items-center justify-between py-2.5 border-b last:border-0" style={{ borderColor: "var(--line)" }}>
                  <span className="text-sm flex items-center gap-2" style={{ color: "var(--txt-2)" }}><CurBadge c={cur(cid)} size="sm" /> {cur(cid).name}</span>
                  <div className="text-left text-sm">
                    {v.buy > 0 && <div style={{ ...num, color: "var(--pos)" }}>کڕین {fmt(v.buy, 0)}</div>}
                    {v.sell > 0 && <div style={{ ...num, color: "var(--neg)" }}>فرۆشتن {fmt(v.sell, 0)}</div>}
                  </div>
                </div>
              ))}
            </Card>
          )}

          <div className="flex gap-2">
            <Btn kind="gold" className="flex-1 flex items-center justify-center gap-2"
              onClick={() => { const t = repText(); if (navigator.share) navigator.share({ text: t }).catch(() => {}); else window.open(`https://wa.me/?text=${encodeURIComponent(t)}`, "_blank"); }}>
              <MessageCircle className="w-4 h-4" /> {tr("ناردن بە واتساپ")}
            </Btn>
            <Btn kind="ghost" className="flex-1"
              onClick={() => navigator.clipboard.writeText(repText()).then(() => flash(tr("کۆپی کرا ✓")))}>{tr("کۆپیکردن")}</Btn>
          </div>
        </>
      )}

      {tab === "log" && (
        Object.keys(dayGroups).length === 0 ? <Card><Empty t={tr("هیچ چالاکییەک نییە")} /></Card> :
          Object.entries(dayGroups).map(([day, items]) => (
            <div key={day}>
              <div className="flex items-center gap-2.5 mb-2.5 mt-4 first:mt-0">
                <span className="px-2.5 py-1 rounded-lg text-[11px] font-bold"
                  style={{ background: "var(--line)", color: "var(--txt-2)", ...num }}>
                  {new Date(day).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })}
                </span>
                <span className="flex-1 h-px" style={{ background: "var(--line)" }} />
                <span className="text-[11px]" style={{ color: "var(--txt-3)" }}>{items.length} کردار</span>
              </div>
              <div className="relative pr-4">
                <span className="absolute top-1 bottom-1 right-[5px] w-px" style={{ background: "var(--line)" }} />
                {items.map((a, i) => (
                  <div key={a.id || i} className="relative pb-3 last:pb-0 rise" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                    <span className="absolute right-[-14px] top-1.5 w-2.5 h-2.5 rounded-full ring-4"
                      style={{ background: "var(--ac)", ringColor: "var(--bg)", boxShadow: "0 0 0 4px var(--bg)" }} />
                    <div className="text-sm font-semibold" style={{ color: "var(--txt)" }}>{a.action}</div>
                    {a.detail && <div className="text-xs mt-0.5" style={{ color: "var(--txt-2)" }}>{a.detail}</div>}
                    <div className="text-[10px] mt-0.5" style={{ ...num, color: "var(--txt-3)" }}>
                      {new Date(a.date).toLocaleTimeString("en-GB")}{a.userName && ` · ${a.userName}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
      )}
    </div>
  );
}

/* ══════════════════ بەستنی ڕۆژ ══════════════════ */

/* ══════════════════ کۆنترۆڵی دارایی / Maker-Checker ══════════════════ */
function ApprovalCenter({
  data, profile, isOwner, approve, reject, cancel, ownerOverride,
  saveSettings, reconcile, busy, flash,
}) {
  const [status, setStatus] = useState("pending");
  const [expanded, setExpanded] = useState(null);
  const [notes, setNotes] = useState({});
  const [overrideReason, setOverrideReason] = useState({});
  const [recon, setRecon] = useState(null);
  const [reconBusy, setReconBusy] = useState(false);
  const c = data.control || {};
  const [settings, setSettings] = useState({
    transaction_approval_usd: c.transaction_approval_usd ?? "",
    cash_approval_usd: c.cash_approval_usd ?? "",
    transfer_approval_usd: c.transfer_approval_usd ?? "",
    require_edit_approval: c.require_edit_approval !== false,
    require_void_approval: c.require_void_approval !== false,
    require_unsettle_approval: c.require_unsettle_approval !== false,
    require_day_close_diff_approval: c.require_day_close_diff_approval !== false,
    owner_override_enabled: c.owner_override_enabled !== false,
    approval_expiry_hours: c.approval_expiry_hours ?? 24,
    business_timezone: c.business_timezone || "Asia/Baghdad",
  });

  useEffect(() => {
    const x = data.control || {};
    setSettings({
      transaction_approval_usd: x.transaction_approval_usd ?? "",
      cash_approval_usd: x.cash_approval_usd ?? "",
      transfer_approval_usd: x.transfer_approval_usd ?? "",
      require_edit_approval: x.require_edit_approval !== false,
      require_void_approval: x.require_void_approval !== false,
      require_unsettle_approval: x.require_unsettle_approval !== false,
      require_day_close_diff_approval: x.require_day_close_diff_approval !== false,
      owner_override_enabled: x.owner_override_enabled !== false,
      approval_expiry_hours: x.approval_expiry_hours ?? 24,
      business_timezone: x.business_timezone || "Asia/Baghdad",
    });
  }, [data.control]);

  const operationLabel = {
    commit_transactions: "مامەڵەی نوێ",
    edit_transaction: "دەستکاری مامەڵە",
    void_transaction: "هەڵوەشاندنەوەی مامەڵە",
    unsettle_transaction: "هەڵوەشاندنەوەی پارەدان",
    post_ledger: "جوڵانەوەی قاسە/هاوبەش",
    account_move: "جوڵانەوەی حساب",
    account_transfer: "گواستنەوەی حساب",
    close_day: "بەستنی ڕۆژ",
  };
  const statusLabel = {
    pending: "چاوەڕوان",
    executed: "جێبەجێکراو",
    rejected: "ڕەتکراوە",
    failed: "هەڵە",
    expired: "بەسەرچوو",
    cancelled: "هەڵوەشێنراو",
  };
  const statusTone = {
    pending: "amber", executed: "green", rejected: "red",
    failed: "red", expired: "slate", cancelled: "slate",
  };

  const rows = (data.approvals || []).filter((r) => status === "all" || r.status === status);
  const pendingCount = (data.approvals || []).filter((r) => r.status === "pending").length;

  const runRecon = async () => {
    setReconBusy(true);
    try {
      const out = await reconcile();
      setRecon(out || null);
      if (out?.ok) flash("یەکسانکردنەوە پاکە ✓");
      else flash(`${out?.failures || 0} کێشە لە یەکسانکردنەوە دۆزرایەوە`);
    } catch (e) {
      console.error(e);
      flash(errorTextOr(e, "یەکسانکردنەوە سەرکەوتوو نەبوو"), "error");
    } finally {
      setReconBusy(false);
    }
  };

  const save = async () => {
    const norm = (v) => v === "" || v == null ? null : Number(v);
    const payload = {
      transaction_approval_usd: norm(settings.transaction_approval_usd),
      cash_approval_usd: norm(settings.cash_approval_usd),
      transfer_approval_usd: norm(settings.transfer_approval_usd),
      require_edit_approval: !!settings.require_edit_approval,
      require_void_approval: !!settings.require_void_approval,
      require_unsettle_approval: !!settings.require_unsettle_approval,
      require_day_close_diff_approval: !!settings.require_day_close_diff_approval,
      owner_override_enabled: !!settings.owner_override_enabled,
      approval_expiry_hours: Number(settings.approval_expiry_hours) || 24,
      business_timezone: String(settings.business_timezone || "Asia/Baghdad").trim(),
    };
    for (const k of ["transaction_approval_usd","cash_approval_usd","transfer_approval_usd"]) {
      if (payload[k] != null && (!(payload[k] > 0) || !Number.isFinite(payload[k]))) {
        flash("سنووری بڕ دەبێت ژمارەیەکی ئەرێنی بێت یان بەتاڵ بێت");
        return;
      }
    }
    await saveSettings(payload);
  };

  return (
    <div className="space-y-5">
      <H sub="دوو-ئادمین پەسەندکردن، کۆنترۆڵی مەترسی و پشکنینی یەکسانی دارایی">
        کۆنترۆڵی دارایی
      </H>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4">
          <div className="text-[11px]" style={{color:"var(--txt-3)"}}>چاوەڕوانی پەسەند</div>
          <div className="text-2xl font-semibold mt-1" style={num}>{pendingCount}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px]" style={{color:"var(--txt-3)"}}>بەرواری کاری</div>
          <div className="text-[15px] font-semibold mt-1" style={num}>{c.business_date || "—"}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px]" style={{color:"var(--txt-3)"}}>ئاستی ئەدمین</div>
          <div className="text-[15px] font-semibold mt-1">{isOwner ? "خاوەنی سیستەم" : "بەڕێوەبەری کارگێڕی"}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px]" style={{color:"var(--txt-3)"}}>دروستکەر / پشکنەر</div>
          <div className="text-[15px] font-semibold mt-1">چالاکە</div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <SecLbl>یەکسانکردنەوەی دارایی</SecLbl>
            <div className="text-[12px]" style={{color:"var(--txt-3)"}}>
              مامەڵە، دەفتەر، تۆماری پێچەوانە، تێچووی بنەڕەت، قازانج و پارەدان یەکسان دەکاتەوە.
            </div>
          </div>
          <Btn kind="ghost" disabled={busy || reconBusy} onClick={runRecon}>
            {reconBusy ? "پشکنین..." : "پشکنینی یەکسانی"}
          </Btn>
        </div>
        {recon && (
          <div className="mt-4 grid md:grid-cols-2 gap-2">
            {(recon.checks || []).map((x, i) => (
              <div key={`${x.name}-${i}`} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-[var(--r-sm)]"
                style={{background:"var(--surf-2)",border:"1px solid var(--line)"}}>
                <span className="text-[12px]">{x.name}</span>
                <span className="text-[11px] font-semibold" style={{color:x.status==="PASS"?"var(--pos)":x.status==="WARN"?"var(--warn)":"var(--neg)"}}>
                  {x.status === "PASS" ? "سەرکەوتوو" : x.status === "WARN" ? "ئاگاداری" : "هەڵە"} · {x.count ?? 0}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap gap-2 mb-4">
          {[["pending","چاوەڕوان"],["executed","جێبەجێکراو"],["rejected","ڕەتکراوە"],["failed","هەڵە"],["all","هەموو"]].map(([k,t]) => (
            <button key={k} onClick={() => setStatus(k)}
              className="px-3 py-2 rounded-[var(--r-sm)] text-[12px] font-semibold tap"
              style={status===k ? {background:"var(--txt)",color:"var(--surf)"} : {background:"var(--surf-2)",color:"var(--txt-2)",border:"1px solid var(--line)"}}>
              {t}{k==="pending" && pendingCount ? ` (${pendingCount})` : ""}
            </button>
          ))}
        </div>

        {rows.length === 0 ? <Empty t="هیچ داواکارییەک لەم دۆخەدا نییە" /> : (
          <div className="space-y-3">
            {rows.map((r) => {
              const ownRequest = r.makerAuthId === profile.authId;
              const open = expanded === r.id;
              const ev = (data.approvalEvents || []).filter((x) => x.approvalId === r.id);
              return (
                <div key={r.id} className="rounded-[var(--r)] overflow-hidden" style={{border:"1px solid var(--line)",background:"var(--surf-2)"}}>
                  <button className="w-full text-start p-4 tap" onClick={() => setExpanded(open ? null : r.id)}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">{operationLabel[r.operation] || r.operation}</div>
                        <div className="text-[11px] mt-1" style={{color:"var(--txt-3)"}}>
                          دروستکەر: {r.makerName || r.makerAppId || "—"} · {new Date(r.createdAt).toLocaleString("en-GB")}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {r.amountUsd != null && <span className="text-[12px] font-semibold" style={num}>${fmt(r.amountUsd,2)}</span>}
                        <Pill tone={statusTone[r.status] || "gray"}>{statusLabel[r.status] || r.status}</Pill>
                      </div>
                    </div>
                    <div className="text-[12px] mt-2 leading-relaxed" style={{color:"var(--txt-2)"}}>{r.reason}</div>
                  </button>

                  {open && (
                    <div className="px-4 pb-4 space-y-3" style={{borderTop:"1px solid var(--line)"}}>
                      <div className="grid md:grid-cols-2 gap-2 pt-3 text-[11px]">
                        <div><span style={{color:"var(--txt-3)"}}>ID:</span> <span style={num}>{r.id}</span></div>
                        <div><span style={{color:"var(--txt-3)"}}>بابەت:</span> <span style={num}>{r.subjectKey || "—"}</span></div>
                        <div><span style={{color:"var(--txt-3)"}}>بەسەرچوون:</span> <span style={num}>{r.expiresAt ? new Date(r.expiresAt).toLocaleString("en-GB") : "—"}</span></div>
                        <div><span style={{color:"var(--txt-3)"}}>پشکنەر:</span> {r.checkerName || r.checkerAppId || "—"}</div>
                      </div>

                      {r.errorText && (
                        <div className="p-3 rounded-[var(--r-sm)] text-[12px]" style={{background:"color-mix(in srgb,var(--neg) 9%,transparent)",color:"var(--neg)"}}>
                          {r.errorText}
                        </div>
                      )}

                      {r.status === "pending" && (
                        <>
                          <div>
                            <Lbl>تێبینی پشکنەر</Lbl>
                            <Inp value={notes[r.id] || ""} onChange={(e) => setNotes({...notes,[r.id]:e.target.value})} placeholder="ئارەزوومەندانە؛ بۆ ڕەتکردنەوە پێویستە" />
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Btn disabled={busy || ownRequest} onClick={() => approve(r, notes[r.id] || "")}>
                              پەسەندکردن و جێبەجێکردن
                            </Btn>
                            <Btn kind="danger" disabled={busy || ownRequest} onClick={() => reject(r, notes[r.id] || "")}>
                              ڕەتکردنەوە
                            </Btn>
                            {(ownRequest || isOwner) && (
                              <Btn kind="ghost" disabled={busy} onClick={() => cancel(r, notes[r.id] || "")}>هەڵوەشاندنەوەی داواکاری</Btn>
                            )}
                          </div>
                          {ownRequest && (
                            <div className="text-[11px]" style={{color:"var(--warn)"}}>
                              دروستکەر ناتوانێت داواکاری خۆی پەسەند یان ڕەت بکات؛ ئەدمینی دووەم پێویستە.
                            </div>
                          )}

                          {isOwner && c.owner_override_enabled !== false && (
                            <div className="pt-3 mt-2" style={{borderTop:"1px dashed var(--line)"}}>
                              <Lbl>دەسەڵاتی فریاکەوتنی خاوەن — هۆکاری ورد پێویستە</Lbl>
                              <div className="flex flex-col md:flex-row gap-2">
                                <Inp value={overrideReason[r.id] || ""}
                                  onChange={(e) => setOverrideReason({...overrideReason,[r.id]:e.target.value})}
                                  placeholder="لانیکەم ١٢ پیت؛ تەنها بۆ دۆخی پێویست" />
                                <Btn kind="gold" disabled={busy || (overrideReason[r.id] || "").trim().length < 12}
                                  onClick={() => ownerOverride(r, overrideReason[r.id] || "")}>
                                  جێبەجێکردنی دەسەڵاتی فریاکەوتن
                                </Btn>
                              </div>
                            </div>
                          )}
                        </>
                      )}

                      {ev.length > 0 && (
                        <div className="space-y-1.5 pt-2">
                          <Lbl>مێژووی داواکاری</Lbl>
                          {ev.slice().reverse().map((e) => (
                            <div key={e.id} className="text-[11px] flex flex-wrap gap-2">
                              <span className="font-semibold">{e.event}</span>
                              <span style={{color:"var(--txt-3)"}}>{e.actorName || e.actorAppId || "سیستەم"}</span>
                              <span style={{...num,color:"var(--txt-3)"}}>{new Date(e.createdAt).toLocaleString("en-GB")}</span>
                              {e.detail && <span style={{color:"var(--txt-2)"}}>— {e.detail}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {isOwner && (
        <Card className="p-5">
          <SecLbl>ڕێکخستنەکانی پەسەندکردنی دوو قۆناغی</SecLbl>
          <div className="text-[11.5px] mb-4 leading-relaxed" style={{color:"var(--txt-3)"}}>
            سنووری بەتاڵ واتە بڕی پارە بەخۆی پەسەندکردنی دووەم چالاک ناکات. دەستکاری، هەڵوەشاندنەوە، پاشگەزبوونەوە لە پارەدان و جیاوازی بەستنی ڕۆژ لە خوارەوە دیاری دەکرێن.
          </div>
          <div className="grid md:grid-cols-3 gap-3">
            <div><Lbl>سنووری مامەڵە (USD)</Lbl><Inp type="number" min="0" value={settings.transaction_approval_usd} onChange={(e)=>setSettings({...settings,transaction_approval_usd:e.target.value})} placeholder="ناچالاک" /></div>
            <div><Lbl>سنووری پارەی نەقد (USD)</Lbl><Inp type="number" min="0" value={settings.cash_approval_usd} onChange={(e)=>setSettings({...settings,cash_approval_usd:e.target.value})} placeholder="ناچالاک" /></div>
            <div><Lbl>سنووری گواستنەوە (USD)</Lbl><Inp type="number" min="0" value={settings.transfer_approval_usd} onChange={(e)=>setSettings({...settings,transfer_approval_usd:e.target.value})} placeholder="ناچالاک" /></div>
            <div><Lbl>ماوەی پەسەندکردن (کاتژمێر)</Lbl><Inp type="number" min="1" max="168" value={settings.approval_expiry_hours} onChange={(e)=>setSettings({...settings,approval_expiry_hours:e.target.value})} /></div>
            <div className="md:col-span-2"><Lbl>ناوچەی کاتی کار</Lbl><Inp dir="ltr" value={settings.business_timezone} onChange={(e)=>setSettings({...settings,business_timezone:e.target.value})} /></div>
          </div>
          <div className="grid md:grid-cols-2 gap-2 mt-4">
            {[
              ["require_edit_approval","دەستکاری هەمیشە پشکنەری دووەم پێویست بێت"],
              ["require_void_approval","هەڵوەشاندنەوە هەمیشە پشکنەری دووەم پێویست بێت"],
              ["require_unsettle_approval","پاشگەزبوونەوە لە پارەدان هەمیشە پشکنەری دووەم پێویست بێت"],
              ["require_day_close_diff_approval","بەستنی ڕۆژی جیاواز پشکنەری دووەم پێویست بێت"],
              ["owner_override_enabled","دەسەڵاتی فریاکەوتنی خاوەن چالاک بێت"],
            ].map(([k,t]) => (
              <label key={k} className="flex items-center gap-2 p-3 rounded-[var(--r-sm)] text-[12px] cursor-pointer"
                style={{background:"var(--surf-2)",border:"1px solid var(--line)"}}>
                <input type="checkbox" checked={!!settings[k]} onChange={(e)=>setSettings({...settings,[k]:e.target.checked})} />
                <span>{t}</span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end"><Btn disabled={busy} onClick={save}>پاشەکەوتکردنی کۆنترۆڵ</Btn></div>
        </Card>
      )}

      <DeferredPanel><ReceiptPolicyPanel client={supabase} isOwner={isOwner} flash={flash} lang={_lang} /></DeferredPanel>

      <Card className="p-5">
        <SecLbl>مێژووی وەشانەکانی مامەڵە</SecLbl>
        {(data.txVersions || []).length === 0 ? <Empty t="هێشتا هیچ وەشانی مامەڵە تۆمار نەکراوە" /> : (
          <div className="space-y-2">
            {(data.txVersions || []).slice(0,20).map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 rounded-[var(--r-sm)] text-[11.5px]"
                style={{background:"var(--surf-2)",border:"1px solid var(--line)"}}>
                <span className="font-semibold" style={num}>#{v.txCode || "—"}</span>
                <span>v{v.versionNo}</span>
                <span>{v.action}</span>
                {v.approvalId && <span style={{color:"var(--txt-3)"}}>پەسەندکردن: {v.approvalId}</span>}
                <span className="ms-auto" style={{...num,color:"var(--txt-3)"}}>{new Date(v.createdAt).toLocaleString("en-GB")}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function DayClose({ data, calc, cur, usr, closeDay, sumUsd }) {
  const [counts, setCounts] = useState({});
  const [note, setNote] = useState("");
  const [adjust, setAdjust] = useState(true);
  const [hist, setHist] = useState(null);
  const [step, setStep] = useState("count");

  const load = () => supabase.from("day_closes").select("*").order("created_at", { ascending: false }).limit(30)
    .then(({ data: d }) => setHist(d || [])).catch(() => setHist([]));
  useEffect(() => { load(); }, []);

  // چاوەڕوانکراو = ئەوەی لای خۆم دەبێت بێت (نەک ئەوەی لای هاوبەشان)
  const lines = data.currencies.map((c) => {
    const expected = roundMoney(data, calc.atMe[c.id] || 0, c.id);
    const raw = counts[c.id];
    const counted = raw === "" || raw === undefined ? null : roundMoney(data, +raw, c.id);
    return {
      cur: c.id, code: c.code, name: c.name, c, expected, counted,
      diff: counted === null ? 0 : roundMoney(data, counted - expected, c.id),
    };
  });
  const entered = lines.filter((l) => l.counted !== null);
  const diffs = entered.filter((l) => l.diff !== 0);
  const totalDiffUsd = sumUsd(Object.fromEntries(entered.map((l) => [l.cur, l.diff])));

  const today = new Date().toISOString().slice(0, 10);
  const closedToday = (hist || []).some((h) => h.close_date === today);
  const verdict = validateDayClose({ lines: entered, note });

  const submit = () => {
    closeDay(entered.map((l) => ({ cur: l.cur, code: l.code, expected: l.expected, counted: l.counted, diff: l.diff })), note, adjust);
    setCounts({}); setNote(""); setStep("count");
    setTimeout(load, 1200);
  };

  return (
    <div className="space-y-4">
      <H sub={tr("لە کۆتایی ڕۆژدا پارەی ڕاستەقینە بژمێرە و بەراوردی بکە لەگەڵ حیسابی سیستەم")}>{tr("بەستنی ڕۆژ")}</H>

      {closedToday && (
        <Card className="p-4 border-[color-mix(in_srgb,var(--pos)_34%,transparent)] bg-[color-mix(in_srgb,var(--pos)_9%,transparent)]">
          <div className="flex items-center gap-2 text-sm text-[var(--pos)] font-semibold">
            <CheckCircle2 className="w-4 h-4" /> {tr("ئەمڕۆ بەسترابووەتەوە — دەتوانیت دووبارە بیکەیتەوە")}
          </div>
        </Card>
      )}

      {step === "count" ? (
        <>
          <Card className="p-5">
            <SecLbl>{tr("پارەی لای خۆت بژمێرە")}</SecLbl>
            <div className="text-xs text-[var(--txt-2)] mb-4">
              {tr("تەنها ئەو پارەیە کە لای خۆتە — ئەوەی لای هاوبەشەکانە لێرە نایەت")}
            </div>
            {lines.map((l) => (
              <div key={l.cur} className="py-3 border-b border-[var(--line)] last:border-0">
                <div className="flex items-center gap-2.5 mb-2">
                  <CurBadge c={l.c} size="sm" />
                  <span className="text-sm font-semibold text-[var(--txt)]">{l.name}</span>
                  <span className="text-xs text-[var(--txt-3)] mr-auto">
                    {tr("حیسابی سیستەم:")} <b style={num} className="text-[var(--txt)]">{fmt(l.expected, 0)}</b>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Inp type="number" dir="ltr" placeholder={tr("ژماردنی ڕاستەقینە...")}
                    value={counts[l.cur] ?? ""} onChange={(e) => setCounts({ ...counts, [l.cur]: e.target.value })}
                    className={`flex-1 ${l.counted !== null && l.diff !== 0 ? "border-[var(--ac)] bg-[color-mix(in_srgb,var(--warn)_11%,transparent)]" : l.counted !== null ? "border-[var(--pos)] bg-[color-mix(in_srgb,var(--pos)_10%,transparent)]" : ""}`} />
                  <div className="w-28 text-left shrink-0">
                    {l.counted === null ? <span className="text-xs text-[var(--txt-3)]">—</span> :
                      l.diff === 0 ? <span className="text-sm font-bold text-[var(--pos)]">{tr("✓ ڕێکە")}</span> :
                        <span className={`text-sm font-bold ${l.diff > 0 ? "text-[var(--pos)]" : "text-[var(--neg)]"}`} style={num}>
                          {l.diff > 0 ? "+" : ""}{fmtMoney(data, l.diff, l.cur || l.code)}
                        </span>}
                  </div>
                </div>
              </div>
            ))}
          </Card>

          {entered.length > 0 && (
            <Card className={`p-5 ${diffs.length ? "border-[color-mix(in_srgb,var(--warn)_34%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)]" : "border-[color-mix(in_srgb,var(--pos)_34%,transparent)] bg-[color-mix(in_srgb,var(--pos)_9%,transparent)]"}`}>
              <div className="flex items-center gap-2 mb-2">
                {diffs.length ? <AlertTriangle className="w-5 h-5 text-[var(--warn)]" /> : <CheckCircle2 className="w-5 h-5 text-[var(--pos)]" />}
                <span className={`font-bold ${diffs.length ? "text-[var(--warn)]" : "text-[var(--pos)]"}`}>
                  {diffs.length ? `${diffs.length} دراو جیاوازی هەیە` : "هەموو شتێک ڕێکە"}
                </span>
              </div>
              {diffs.map((l) => (
                <div key={l.cur} className="flex justify-between text-sm py-1">
                  <span className="text-[var(--txt-2)]">{l.name}</span>
                  <span className={`font-bold ${l.diff > 0 ? "text-[var(--pos)]" : "text-[var(--neg)]"}`} style={num}>
                    {l.diff > 0 ? "زیادە " : "کەمە "}{fmt(Math.abs(l.diff), 0)}
                  </span>
                </div>
              ))}
              {diffs.length > 0 && (
                <div className="text-xs text-[var(--txt-2)] mt-2 pt-2 border-t border-[color-mix(in_srgb,var(--warn)_26%,transparent)]" style={num}>
                  کۆی جیاوازی بە دۆلار ≈ {fmt(totalDiffUsd, 0)} $
                </div>
              )}
            </Card>
          )}

          <Card className="p-5">
            <div>
              <Lbl>{diffs.length ? tr("هۆکاری جیاوازی — پێویستە") : tr("تێبینی (ئارەزوومەندانە)")}</Lbl>
              <Inp value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("نموونە: خەرجی تۆمار نەکراو...")} />
              {/* A difference with no explanation is refused by the database too; this says so
                  before the operator gets there. */}
              {diffs.length > 0 && !verdict.ok && (
                <div className="text-xs text-[var(--warn)] mt-2">{dayCloseMessage(verdict.code)}</div>
              )}
            </div>
            {diffs.length > 0 && (
              <label className="flex items-start gap-2.5 mt-4 cursor-pointer">
                <input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} className="mt-0.5 w-4 h-4 accent-[var(--pos)]" />
                <span className="text-sm text-[var(--txt)]">
                  <b>{tr("قاسەکە ڕاست بکەرەوە")}</b>
                  <div className="text-xs text-[var(--txt-2)] mt-0.5">{tr("تۆمارێکی ڕاستکردنەوە زیاد دەکرێت تا حیسابی سیستەم بگونجێت لەگەڵ پارەی ڕاستەقینە")}</div>
                </span>
              </label>
            )}
            <Btn className="w-full mt-4" onClick={() => setStep("confirm")} disabled={!verdict.ok}>
              بەستنی ڕۆژ ({entered.length} دراو)
            </Btn>
          </Card>
        </>
      ) : (
        <Card className="p-5">
          <SecLbl>{tr("دڵنیابوونەوە")}</SecLbl>
          <div className="space-y-1.5 mb-4">
            {entered.map((l) => (
              <div key={l.cur} className="flex justify-between items-center py-2 border-b border-[var(--line)] text-sm">
                <span className="text-[var(--txt-2)]">{l.name}</span>
                <span style={num}>
                  <span className="text-[var(--txt-3)]">{fmt(l.expected, 0)}</span>
                  <span className="mx-1.5 text-[var(--txt-3)]">→</span>
                  <b className="text-[var(--txt)]">{fmt(l.counted, 0)}</b>
                  {l.diff !== 0 && <span className={`mr-2 font-bold ${l.diff > 0 ? "text-[var(--pos)]" : "text-[var(--neg)]"}`}>({l.diff > 0 ? "+" : ""}{fmt(l.diff, 0)})</span>}
                </span>
              </div>
            ))}
          </div>
          {diffs.length > 0 && adjust && (
            <div className="text-xs text-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_11%,transparent)] border border-[color-mix(in_srgb,var(--warn)_26%,transparent)] rounded-[var(--r-sm)] p-3 mb-4">
              {tr("تۆمارێکی ڕاستکردنەوە زیاد دەکرێت بۆ گونجاندنی قاسە لەگەڵ ژماردنەکەت")}
            </div>
          )}
          <div className="flex gap-2">
            <Btn className="flex-1" onClick={submit}>{tr("پشتڕاستکردنەوە")}</Btn>
            <Btn kind="ghost" className="flex-1" onClick={() => setStep("count")}>{tr("گەڕانەوە")}</Btn>
          </div>
        </Card>
      )}

      <SecLbl>{tr("مێژووی بەستنەکان")}</SecLbl>
      {hist === null ? <Card><Empty t={tr("بارکردن...")} /></Card> :
        hist.length === 0 ? (
          <Card className="p-4">
            <div className="text-sm text-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_11%,transparent)] border border-[color-mix(in_srgb,var(--warn)_26%,transparent)] rounded-[var(--r-sm)] p-3">
              {tr("هێشتا هیچ بەستنێک نییە — ئایا خشتەی")} <b>day_closes</b> {tr("لە Supabase درووست کراوە؟")}
            </div>
          </Card>
        ) : hist.map((h) => (
          <Card key={h.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-[var(--txt)]" style={num}>{h.close_date}</div>
                <div className="text-[11px] text-[var(--txt-3)] mt-0.5" style={num}>
                  {new Date(h.created_at).toLocaleTimeString("en-GB")}
                  {h.closed_by && ` · ${usr(h.closed_by).name || ""}`}
                </div>
                {h.note && <div className="text-xs text-[var(--txt-2)] mt-1">{h.note}</div>}
              </div>
              <div className="text-left shrink-0">
                {h.has_diff
                  ? <Pill tone="amber">{tr("جیاوازی هەبووە")}</Pill>
                  : <Pill tone="green">{tr("ڕێک بووە")}</Pill>}
              </div>
            </div>
            {h.has_diff && Array.isArray(h.lines) && (
              <div className="mt-2.5 pt-2.5 border-t border-[var(--line)] space-y-1">
                {h.lines.filter((l) => l.diff).map((l, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-[var(--txt-2)]">{l.code}</span>
                    <span className={`font-bold ${l.diff > 0 ? "text-[var(--pos)]" : "text-[var(--neg)]"}`} style={num}>
                      {l.diff > 0 ? "+" : ""}{fmt(l.diff, 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
    </div>
  );
}

/* ══════════════════ تۆماری گۆڕانکاری ══════════════════ */
function Audit({ data }) {
  return (
    <div className="space-y-3">
      <H>{tr("تۆماری گۆڕانکاری")}</H>
      {data.audit.length === 0 ? <Card><Empty t={tr("هێشتا هیچ")} /></Card> :
        data.audit.slice(0, 150).map((a) => (
          <Card key={a.id} className="p-3.5 flex items-center gap-3 text-sm">
            <History className="w-4 h-4 text-[var(--txt-3)] shrink-0" />
            <span className="font-semibold text-[var(--txt)]">{a.action}</span>
            <span className="text-[var(--txt-2)] flex-1">{a.detail}</span>
            <span className="text-[11px] text-[var(--txt-3)]" style={num}>{new Date(a.date).toLocaleString("en-GB")}</span>
          </Card>
        ))}
    </div>
  );
}

/* پۆرتاڵی کڕیار */
function CustomerPortal({ user, c, base, data, calc, cur, usr, flash, reloadBatches, online, stale, refreshing, refreshedAt, refresh }) {
  const list = base;
  const customerRoutes = useMemo(() => ["home", "activity", "documents", "account", "upload"], []);
  const [tab, setTab] = usePortalRoute("customer", customerRoutes, "home");
  // Customer uploads are tied only to transactions where the customer sold currency to ZEMAN.
  // Purchases from ZEMAN stay visible, but only the assigned partner may upload their receipt.
  const uploadTransactions = useMemo(
    () => base.filter((tx) => !tx.deleted && tx.type === "buy"),
    [base],
  );
  const [uploadTxId, setUploadTxId] = useState("");
  const owe = Object.entries(c.owe).filter(([, v]) => v);
  const due = Object.entries(c.due).filter(([, v]) => v);
  const summary = separatedCurrencySummary(c.owe, c.due);
  const currencyIds = summary.currencyIds;
  const singleCurrency = summary.currencyId;
  const singleNet = summary.amount || 0;
  const nav = useMemo(() => [
    { id: "home", label: "ماڵەوە", icon: LayoutDashboard },
    { id: "documents", label: "فیش", icon: ScanLine },
    { id: "activity", label: "مامەڵە", icon: History },
    { id: "account", label: "حیساب", icon: Vault },
  ], []);
  const status = <PortalDataStatus online={online} stale={stale} refreshing={refreshing} updatedAt={refreshedAt}
    onRefresh={refresh} labels={{ live: tr("داتا نوێیە"), refreshing: tr("نوێکردنەوە"), stale: tr("داتا کۆنە"), offline: tr("ئینتەرنێت نییە"), updated: tr("دوا نوێکردنەوە"), refresh: tr("نوێکردنەوە") }} />;

  return (
    <PortalFrame nav={nav} active={tab === "upload" ? "documents" : tab} onNavigate={setTab} navLabel={tr("بەشەکانی پۆرتاڵ")} status={status}>
    <div className="space-y-4 md:space-y-5 portal-shell">
      {tab === "home" && (
        <>
          <PortalHeader user={user} role={tr("کڕیار")} icon={Users}
            subtitle={singleCurrency ? `${tr("باڵانس")} · ${cur(singleCurrency).code}` : currencyIds.length ? `${currencyIds.length} ${tr("دراو")}` : tr("حیساب پاکە ✅")} />

          {/* ژمارەی سەرەکی */}
          <div className="portal-hero-card">
            <Hero
              label={singleCurrency ? (singleNet >= 0 ? tr("پارەی من لای ئەوان") : tr("قەرزی من")) : tr("باڵانس بەپێی دراو")}
              value={singleCurrency ? fmt(Math.abs(singleNet), cur(singleCurrency).dec ?? 0) : currencyIds.length || "0"}
              unit={singleCurrency ? cur(singleCurrency).code : currencyIds.length ? tr("دراو") : ""}
              tone={singleCurrency && singleNet > 0 ? "pos" : singleCurrency && singleNet < 0 ? "neg" : "txt"}
              sub={!currencyIds.length ? tr("حیساب پاکە ✅") : !singleCurrency ? tr("دراوەکان تێکەڵ ناکرێن") : null} />
          </div>

          {/* کرداری خێرا
              Sending a receipt is what a customer-seller comes here to do, so it is here always.
              It used to appear only when they already had a purchase transaction — which is
              backwards: the receipt is what becomes the transaction. A new customer therefore
              saw no way to send anything, and could never get one, because the button that
              starts the process was waiting for the process to have started. */}
          <div className="portal-actions-grid is-single">
            <PortalAction icon={Upload} label={tr("ناردنی فیش")} hint={tr("سکرینشۆتی ناردنی پارە")} onClick={() => setTab("upload")} primary />
          </div>

          {/* دوو باڵانس */}
          {(owe.length > 0 || due.length > 0) && (
            <div className="portal-kpi-grid">
              <Card className="portal-kpi-card">
                <div className="text-[11px] mb-2" style={{ color: "var(--txt-3)" }}>{tr("پارەی من لای ئەوان")}</div>
                {owe.length === 0 ? <div className="text-[15px]" style={{ color: "var(--txt-3)" }}>—</div> :
                  owe.map(([cid, v]) => (
                    <div key={cid} className="text-[19px] font-semibold" style={{ ...num, color: "var(--pos)" }}>
                      {fmt(v, cur(cid).dec ?? 0)} <span className="text-[11px] font-normal" style={{ color: "var(--txt-3)" }}>{cur(cid).code}</span>
                    </div>
                  ))}
              </Card>
              <Card className="portal-kpi-card">
                <div className="text-[11px] mb-2" style={{ color: "var(--txt-3)" }}>{tr("قەرزی من")}</div>
                {due.length === 0 ? <div className="text-[15px]" style={{ color: "var(--txt-3)" }}>—</div> :
                  due.map(([cid, v]) => (
                    <div key={cid} className="text-[19px] font-semibold" style={{ ...num, color: "var(--neg)" }}>
                      {fmt(v, cur(cid).dec ?? 0)} <span className="text-[11px] font-normal" style={{ color: "var(--txt-3)" }}>{cur(cid).code}</span>
                    </div>
                  ))}
              </Card>
            </div>
          )}

          {/* دوا مامەڵەکان */}
          <Card className="px-1 py-1 portal-list-card">
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <SecLbl>{tr("دوا مامەڵەکان")}</SecLbl>
              <button onClick={() => setTab("activity")} className="text-[12px] font-semibold tap" style={{ color: "var(--ac)" }}>
                {tr("هەمووی")}
              </button>
            </div>
            {base.length === 0 ? <Empty t={tr("هێشتا هیچ")} /> :
              base.slice(0, 5).map((t, i) => (
                <div key={t.id} style={i ? { borderTop: "1px solid var(--line)" } : {}}>
                  <TxRow t={t} cur={cur} usr={usr} flip lite />
                </div>
              ))}
          </Card>
        </>
      )}

      {tab === "upload" && (
        <>
          <Back onClick={() => setTab("documents")} t={tr("گەڕانەوە")} />
          <Card className="p-4">
            <div className="text-[13px] leading-relaxed" style={{ color: "var(--txt-2)" }}>
              {tr("وێنەی ئەو فیشانە هەڵبژێرە کە پارەکەیان بۆت هاتووە. سیستەمەکە دەیانخوێنێتەوە، کۆیان دەکاتەوە و دووبارەکان دەدۆزێتەوە.")}
            </div>
          </Card>
          <ReceiptUploader customerId={user.id} customerName={user.name} uploaderId={user.id} data={data}
            role={user.role} direction="in"
            simple flash={flash} onDone={() => { reloadBatches && reloadBatches(); setTab("documents"); }} />
        </>
      )}

      {tab === "account" && (
        <>
          <AccountSafe userId={user.id} data={data} calc={calc} cur={cur} usr={usr} flash={flash} readOnly />
        </>
      )}

      {tab === "documents" && (
        <>
          {/* The order is the point. A customer-seller sends receipts; that is the whole of their
              business with us. So: the way to send one, then what they have sent, and only then
              anything sent back to them.
              It used to open with "receipts sent to you" — an inbox, for somebody whose job is to
              post — above an empty state and a permission error, with no way to send at all. */}
          <PortalAction icon={Upload} label={tr("ناردنی فیش")}
            hint={tr("سکرینشۆتی ناردنی پارە")} onClick={() => setTab("upload")} primary />
          <ReceiptArchive customerId={user.id} data={data} flash={flash} simple />
          <DeferredPanel><ForwardedReceipts client={supabase} flash={flash}
            signedUrlFor={async (path) => {
              const { data: signed } = await supabase.storage.from("receipts").createSignedUrl(path, 3600);
              return signed?.signedUrl || null;
            }} /></DeferredPanel>
        </>
      )}

      {tab === "activity" && (
        <>
          {list.length === 0 ? <Card className="p-2"><Empty t={tr("هیچ مامەڵەیەک نەدۆزرایەوە")} /></Card> :
            <Card className="px-1 py-1 portal-list-card">
              <PortalPagedList items={list} moreLabel={tr("زیاتر")}>{(visible) => visible.map((t, i) => (
                <div key={t.id} style={i ? { borderTop: "1px solid var(--line)" } : {}}>
                  <TxRow t={t} cur={cur} usr={usr} flip lite />
                </div>
              ))}</PortalPagedList>
            </Card>}
        </>
      )}
    </div></PortalFrame>
  );
}

/* پۆرتاڵی هاوبەش */
function PartnerPortal({ user, data, calc, cur, usr, flash, reloadBatches, online, stale, refreshing, refreshedAt, refresh }) {
  const partnerRoutes = useMemo(() => ["home", "activity", "documents", "account", "upload"], []);
  const [tab, setTab] = usePortalRoute("partner", partnerRoutes, "home");
  // A partner can upload only for customer-purchase transactions explicitly assigned to them.
  const uploadTransactions = useMemo(
    () => data.txs.filter((tx) => !tx.deleted && tx.type === "sell" && tx.partnerId === user.id),
    [data.txs, user.id],
  );
  const [uploadTxId, setUploadTxId] = useState("");
  const bal = calc.partner[user.id] || {};
  const hist = data.ledger.filter((e) => e.partnerId === user.id).slice().reverse();
  const fees = {};
  data.ledger.forEach((e) => { if (e.partnerId === user.id && e.type === "partner_fee") fees[e.curId] = (fees[e.curId] || 0) + Math.abs(e.amount); });
  const rows = data.currencies.map((c) => ({ c, v: bal[c.id] || 0 })).filter((r) => r.v);
  const main = rows[0];
  const nav = useMemo(() => [
    { id: "home", label: "ماڵەوە", icon: LayoutDashboard },
    { id: "documents", label: "فیش", icon: ScanLine },
    { id: "account", label: "باڵانس", icon: Vault },
    { id: "activity", label: "چالاکی", icon: History },
  ], []);
  const status = <PortalDataStatus online={online} stale={stale} refreshing={refreshing} updatedAt={refreshedAt}
    onRefresh={refresh} labels={{ live: tr("داتا نوێیە"), refreshing: tr("نوێکردنەوە"), stale: tr("داتا کۆنە"), offline: tr("ئینتەرنێت نییە"), updated: tr("دوا نوێکردنەوە"), refresh: tr("نوێکردنەوە") }} />;

  return (
    <PortalFrame nav={nav} active={tab === "upload" ? "documents" : tab} onNavigate={setTab} navLabel={tr("بەشەکانی پۆرتاڵ")} status={status}>
    <div className="space-y-4 md:space-y-5 portal-shell">
      {tab === "home" && (
        <>
          <PortalHeader user={user} role={tr("هاوبەش")} icon={Handshake}
            subtitle={main ? `${tr("باڵانسی لای من")} · ${cur(main.c.id).code}` : tr("هیچ نییە")} />

          <div className="portal-hero-card">
            <Hero label={tr("باڵانسی لای من")}
              value={rows.length === 1 ? fmt(main.v, main.c.dec ?? 0) : rows.length || "0"}
              unit={rows.length === 1 ? cur(main.c.id).code : rows.length ? tr("دراو") : ""}
              tone={rows.length === 1 && main.v < 0 ? "neg" : "txt"}
              sub={rows.length > 1 ? tr("دراوەکان تێکەڵ ناکرێن") : main && main.v < 0 ? tr("· قەرز") : null} />
          </div>

          {uploadTransactions.length > 0 && <div className="portal-actions-grid is-single">
            <PortalAction icon={Upload} label={tr("ناردنی فیش")} hint={tr("فیشەکان")} onClick={() => setTab("upload")} primary />
          </div>}

          {rows.length > 1 && (
            <Card className="px-4 py-2 portal-list-card">
              <div className="pt-2"><SecLbl>{tr("باڵانسی لای من")}</SecLbl></div>
              {rows.map(({ c, v }) => (
                <Row key={c.id} icon={<CurBadge c={c} size="sm" />} title={c.name}
                  right={fmt(v, 0)} tone={v < 0 ? "neg" : null} rightSub={v < 0 ? tr("قەرز") : null} />
              ))}
            </Card>
          )}

          {Object.keys(fees).length > 0 && (
            <Card className="px-4 py-2 portal-list-card">
              <div className="pt-2"><SecLbl>{tr("عمولەی وەرگیراو")} ({user.rate}{tr("٪")})</SecLbl></div>
              {Object.entries(fees).map(([cid, v]) => (
                <Row key={cid} icon={<CurBadge c={cur(cid)} size="sm" />} title={cur(cid).name} right={fmt(v, 0)} tone="pos" />
              ))}
            </Card>
          )}
        </>
      )}

      {tab === "account" && <AccountSafe userId={user.id} data={data} calc={calc} cur={cur} usr={usr} flash={flash} readOnly />}
      {tab === "documents" && <>
        {uploadTransactions.length > 0 && <PortalAction icon={Upload} label={tr("ناردنی فیش")}
          hint={tr("بۆ مامەڵەی دیاریکراو") } onClick={() => setTab("upload")} primary />}
        <DeferredPanel><ForwardedReceipts client={supabase} flash={flash}
          signedUrlFor={async (path) => {
            const { data: signed } = await supabase.storage.from("receipts").createSignedUrl(path, 3600);
            return signed?.signedUrl || null;
          }} /></DeferredPanel>
        <PartnerReceipts partnerId={user.id} data={data} flash={flash} />
        {/* Their own archive: what this partner themselves sent, with the details of each
            receipt — the same view the customer-seller gets, scoped by the server to them. */}
        <ReceiptArchive customerId={user.id} data={data} flash={flash} simple />
      </>}
      {tab === "upload" && (
        <>
          <Back onClick={() => setTab("documents")} t={tr("گەڕانەوە")} />
          <Card className="p-4">
            <div className="text-[13px] leading-relaxed" style={{ color: "var(--txt-2)" }}>
              {tr("تەنها فیشی ئەو کڕینەی کڕیار بنێرە کە زەمان بە ڕوونی بە تۆی سپاردووە.")}
            </div>
          </Card>
          <ReceiptUploader partnerId={user.id} uploaderId={user.id} data={data} direction="out" allowDirection
            role={user.role} simple flash={flash} onDone={() => { reloadBatches && reloadBatches(); setTab("documents"); }} />
        </>
      )}
      {tab === "activity" && (
        hist.length === 0 ? <Card className="p-2"><Empty t={tr("هیچ نییە")} /></Card> :
          <Card className="px-4 py-2 portal-list-card">
            <PortalPagedList items={hist} moreLabel={tr("زیاتر")}>{(visible) => visible.map((e) => (
              <Row key={e.id}
                icon={<span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: e.amount >= 0 ? "var(--pos-bg)" : "var(--neg-bg)" }}>
                  {e.amount >= 0 ? <ArrowDownLeft className="w-4 h-4" style={{ color: "var(--pos)" }} />
                                 : <ArrowUpRight className="w-4 h-4" style={{ color: "var(--neg)" }} />}
                </span>}
                title={e.type === "partner_fee" ? tr("عمولە") : e.amount >= 0 ? tr("هاتنە ژوورەوە") : tr("چوونە دەرەوە")}
                sub={new Date(e.date).toLocaleString("en-GB")}
                right={`${e.amount >= 0 ? "+" : ""}${fmt(e.amount, 0)}`}
                rightSub={cur(e.curId).code}
                tone={e.amount >= 0 ? "pos" : "neg"} />
            ))}</PortalPagedList>
          </Card>
      )}
    </div></PortalFrame>
  );
}

/* ══════════════════ پۆرتاڵی ڕۆڵەکانی تر ══════════════════ */
function Portal({ user, data, calc, cur, usr, officePay, settle, invUnpaid, flash, reloadBatches, accountMove, accountTransfer, ...portalState }) {
  if (user.role === "office") return (
    <div className="portal-frame"><section className="portal-main" id="portal-content">
      <DeferredPanel><OfficePayments client={supabase} lang={portalState.lang || "ku"} flash={flash}
        officeId={user.id} /></DeferredPanel>
    </section></div>
  );

  if (user.role === "customer") {
    const c = calc.cust[user.id] || { owe: {}, due: {} };
    const base = data.txs.filter((t) => !t.deleted && t.cpId === user.id).reverse();
    return <CustomerPortal user={user} c={c} base={base} data={data} calc={calc} cur={cur} usr={usr} flash={flash} reloadBatches={reloadBatches} {...portalState} />;
  }

  if (user.role === "partner") return <PartnerPortal user={user} data={data} calc={calc} cur={cur} usr={usr} flash={flash} reloadBatches={reloadBatches} {...portalState} />;

  if (user.role === "__never__") {
    const bal = calc.partner[user.id] || {};
    const hist = data.ledger.filter((e) => e.partnerId === user.id).slice().reverse();
    const fees = {};
    data.ledger.forEach((e) => { if (e.partnerId === user.id && e.type === "partner_fee") fees[e.curId] = (fees[e.curId] || 0) + Math.abs(e.amount); });
    return (
      <div className="space-y-4">
        <H sub={`${tr("بەخێربێیت،")} ${user.name}`}>{tr("ئەکاونتی من")}</H>
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="p-5">
            <SecLbl>{tr("باڵانسی لای من")}</SecLbl>
            {Object.keys(bal).length === 0 ? <Empty t={tr("بەتاڵە")} /> :
              Object.entries(bal).map(([cid, v]) => (
                <div key={cid} className="flex justify-between py-2 border-b border-[var(--line)] last:border-0">
                  <span className="text-sm text-[var(--txt-2)]">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} />
                </div>
              ))}
          </Card>
          <Card className="p-5">
            <SecLbl>عمولەی وەرگیراو ({user.rate}٪)</SecLbl>
            {Object.keys(fees).length === 0 ? <Empty t={tr("هێشتا هیچ")} /> :
              Object.entries(fees).map(([cid, v]) => (
                <div key={cid} className="flex justify-between py-2 border-b border-[var(--line)] last:border-0">
                  <span className="text-sm text-[var(--txt-2)]">{cur(cid).name}</span><Money v={v} dec={cur(cid).dec} pos />
                </div>
              ))}
          </Card>
        </div>
        <SecLbl>{tr("مێژووی ئاڵووگۆر")}</SecLbl>
        {hist.length === 0 ? <Card><Empty t={tr("هیچ نییە")} /></Card> :
          hist.map((e) => (
            <Card key={e.id} className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Pill tone={e.amount >= 0 ? "green" : "red"}>{e.amount >= 0 ? "هاتنە ژوورەوە" : "چوونە دەرەوە"}</Pill>
              <span><Money v={e.amount} dec={cur(e.curId).dec} /> {cur(e.curId).code}</span>
              {e.type === "partner_fee" && <span className="text-[var(--txt-2)]">{tr("عمولە")}</span>}
              <span className="text-[11px] text-[var(--txt-3)] mr-auto" style={num}>{new Date(e.date).toLocaleString("en-GB")}</span>
            </Card>
          ))}
      </div>
    );
  }

  if (user.role === "investor") {
    return (
      <div className="space-y-4 md:space-y-5 portal-shell">
        <PortalHeader user={user} role={tr("وەبەرهێنەر")} icon={TrendingUp}
          subtitle={tr("سەرمایە + خێری نەدراو")} />
        <MarketWatch compact />
        <InvestorDetail u={user} data={data} calc={calc} cur={cur} invUnpaid={invUnpaid} mine />
      </div>
    );
  }
  return null;
}
