Warning: truncated output (original token count: 186202)
Total output lines: 12606

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { supabase } from "./lib/supabase";
import { createReceiptIngestionCommand, ingestReceiptBatch } from "./services/receiptIngestion";
import { forgetSend, outcomeText, pendingSend, rememberSend, resolveSendOutcome, settleFailedSend, stageText } from "./services/receiptSendState";
import { arithmeticObjection, receiptNetFrom, sendableSet, validateReceiptArithmetic } from "./services/receiptValidation";
import { BuildStamp, UpdateBanner } from "./components/system/UpdateBanner";
import { loadNotifications, markAllNotificationsRead, markNotificationRead, subscribeToNotifications } from "./services/notifications";
import { loadWholeTable } from "./services/tableLoader";
import { activeLanguage, setActiveLanguage } from "./services/activeLanguage";
import { currencyDecimals as currencyDecimalsOf, formatMoney, formatNumber, roundToCurrency } from "./services/money";
import { errorText, errorTextOr } from "./services/userFacingError";
import { flashIsGood } from "./services/flashTone.js";
import { settlementChoices, settlementWords } from "./services/settlement.js";
import { loadMoneyAtOffices, loadOfficeHoldings, moneyAtOfficeText, officeAdvance } from "./services/accounting.js";
import { buildBundleForReceipts, bundleArchiveName, shareOrSaveBundle } from "./services/receiptBundleTransfer.js";
import { reportFault } from "./services/faultReport.js";
import { MyReceipts } from "./components/portal/MyReceipts";
import { dismissRejectedReceipt, intakeReceipt, intakeStatusText, loadMyReceipts, noteReceiptReadFailure, receiptDismissCommandKey, receiptReadFailureText, replaceReceipt, requestStoredReceiptOcr } from "./services/receiptIntake";
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
import { EARNING_KINDS, earningsByKind } from "./services/earningsByKind";
import { capitalEventsFrom, investorShare, investorsTotalByCurrency, profitEventsFrom, sharedCostEventsFrom } from "./services/investorShare";
import { batchStage, todaysWork } from "./services/todaysWork.js";
import { receiptWorkBuckets } from "./services/receiptCommandCenter.js";
import { directTradeLegs, filledSellers, firstIncompleteSeller } from "./services/directTrade.js";
import { transactionTimeline } from "./services/transactionTimeline.js";
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
  LayoutDashboard, Vault, ArrowLeftRight, ListOrdered, Users, UserRound, Handshake, Boxes,
  TrendingUp, Building2, Banknote, UserCog, PieChart, History, Plus, Trash2, Pencil,
  CheckCircle2, AlertTriangle, Eye, LogOut, Wallet, ChevronLeft, Coins,
  Receipt, TrendingDown, ScanLine, Scale, Upload, XCircle, SlidersHorizontal, Search, MoreHorizontal, Zap, ArrowDownLeft, ArrowUpRight, X, Share2, Database, Download, ClipboardCheck, RotateCcw, MessageCircle, Moon, Sun, WifiOff, Wifi, EyeOff, Bell, QrCode, Camera, Fingerprint, ShieldCheck, KeyRound, Inbox, ShieldAlert, FileCheck2, Send, Clock, Gauge
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
const CashAccounts = lazyNamed(() => import("./components/accounting/CashAccounts"), "CashAccounts");
const CommissionTrade = lazyNamed(() => import("./components/accounting/CommissionTrade"), "CommissionTrade");
const ExplainBalance = lazyNamed(() => import("./components/accounting/ExplainBalance"), "ExplainBalance");
const FaultList = lazyNamed(() => import("./components/system/FaultList"), "FaultList");
const PartnerHoldings = lazyNamed(() => import("./components/accounting/PartnerHoldings"), "PartnerHoldings");
const ManagerCenter = lazyNamed(() => import("./components/accounting/ManagerCenter"), "ManagerCenter");
const ManagerConsole = lazyNamed(() => import("./components/accounting/ManagerConsole"), "ManagerConsole");
const ManagerOverview = lazyNamed(() => import("./components/accounting/ManagerOverview"), "ManagerOverview");
const ReceiptReviewWorkspace = lazyNamed(() => import("./components/receipts/ReceiptReviewWorkspace"), "ReceiptReviewWorkspace");
const ReceiptForwardingCenter = lazyNamed(() => import("./components/receipts/ReceiptForwardingCenter"), "ReceiptForwardingCenter");
const ForwardedReceipts = lazyNamed(() => import("./components/receipts/ForwardedReceipts"), "ForwardedReceipts");
const BooksReconciliation = lazyNamed(() => import("./components/accounting/BooksReconciliation"), "BooksReconciliation");
const Party360 = lazyNamed(() => import("./components/accounting/Party360"), "Party360");
const CashReconciliation = lazyNamed(() => import("./components/accounting/CashReconciliation"), "CashReconciliation");
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
  "explain-balance",
  "manager-center",
  "manager-console",
  "manager-overview",
  "receipt-review",
  "receipt-forwarding",
  "cash-reconciliation",
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
            placeholder={tr("یان کۆدەکە بنووسە…")}
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
        <div className="state-panel-title">{title || (isLoading ? tr("بارکردن…") : isError ? tr("هەڵەیەک ڕوویدا") : tr("هیچ داتایەک نییە"))}</div>
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
  // Counted in services/todaysWork.js, with its own tests, rather than inline here. These are
  // the numbers the owner reads before deciding what to do with the morning, and arithmetic
  // that decides something belongs where it can be tested — the same reason the money maths
  // left this file.
  const today = todaysWork({
    batches,
    txs: data?.txs,
    users: data?.users,
    approvals: data?.approvals,
    unpricedCurrencies: unpricedCurrencies(data?.currencies || []),
    officeCash: calc?.acctCash,
  });
  const { waitingReceipts, needsPerson, refused, duplicates, unpaid, officesOwed } = today;
  const waiting = { length: today.waitingBatches };
  const unpriced = today.unpriced;
  const approvals = today.approvals;
  const attention = today.total;

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
          {officesOwed.map((office) => (
            <TodayLine key={office.id} icon={Building2} tone="warn"
              title={`${label("قەرزی ZEMAN بۆ", "ZEMAN owes", "زيمان مدين لـ")} ${office.name}`}
              detail={office.owed.map(({ curId, amount }) =>
                `${fmt(amount, cur(curId).dec ?? 0)} ${cur(curId).code}`).join(" · ")}
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

      {/*
        * The sixteen-tool grid that used to sit here is gone, and nothing went with it.
        * Every one of those screens now has a named place in the navigation — «فیش», «پارە»,
        * «ڕاپۆرت» — because a grid of sixteen buttons at the foot of a page is not a section,
        * it is a drawer, and a drawer is where things go when nobody has decided what they are.
        * This page is now what its title says: the work waiting today.
        */}
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
  const [accessState, setAccessState] = useState("checking"); // checking | ready | missing | error
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
  // Where the person actually came from, rather than where the code assumes they did.
  //
  // The «گەڕانەوە» link was shown on every page in ADMIN_CENTER_PAGE_IDS, which was right when
  // those pages had no entry of their own. Twenty of the twenty-one have one now — they are in
  // the six sections — so somebody who opened «پشکنین» from the sidebar was offered a way back
  // to a place they had never been. A back link that guesses is worse than no back link.
  //
  // The admin centre still leads to seven of them, and for a person who arrived that way the
  // link is exactly right. So it is set when the admin centre navigates, and cleared by every
  // other route into a page.
  const [cameFromHub, setCameFromHub] = useState(false);
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
  // Which of the two forms «مامەڵەی نوێ» is showing. Buying and selling is the ordinary day, so
  // that is what opens; a commission trade is asked for by name.
  const [newTxKind, setNewTxKind] = useState("trade");

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
      q.set("receiptTab", "review");
      q.set("receiptAdd", "1");
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
        // «Runtime Contract بەردەست نییە — Phase 13F migration/deployment بپشکنە» stood here,
        // full-screen, as the only thing a currency dealer was left looking at. It named a
        // contract, a phase number and two deployment steps, and offered no action any of
        // them could take. The neighbouring message one line below already does this right:
        // «ئەکاونتەکەت بە سیستەمەکە نەبەستراوە — پەیوەندی بە ئەدمینەوە بکە.»
        //
        // The marker is not lost — it goes to the console, where the person who can act on it
        // is the person who would look.
        console.error("runtime contract unavailable — check the Phase 13F migration/deployment", rt.error);
        setAccessError(tr("سیستەمەکە ئامادە نییە — نوێکردنەوەی داتابەیس تەواو نەبووە. پەیوەندی بە پشتگیرییەوە بکە."));
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
          paidFrom: r.paid_from || null,
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
  }, [session?.access_token]);

  const LR = (e) => ({ id: e.id, type: e.type, owner: e.owner || null, investor_id: e.investorId || null, cur_id: e.curId, amount: e.amount, partner_id: e.partnerId || null, cash_account_id: e.cashAccountId || null, paid_from: e.paidFrom || null, tx_id: e.txId || null, note: e.note || null, date: e.date });
  const TR = (transaction) => {
    const t = normalizeTransactionBusinessFlow(transaction);
    return { id: t.id, code: t.code || null, type: t.type, direct: !!t.direct,
      pair_id: t.pairId ?? null, direct_role: t.directRole ?? null, own_money: !!t.ownMoney,
      business_flow: t.businessFlow,
      buy_rate: t.buyRate ?? null, buy_total: t.buyTotal ?? null, cp_id: t.cpId, cp_name: t.cpName, cur_id: t.curId, amount: t.amount, rate: t.rate, against_id: t.againstId, total: t.total, partner_id: t.partnerId, partner_fee: t.partnerFee ?? null, status: t.status, paid_at: t.paidAt, profit: t.profit, profit_cur_id: t.profitCurId, note: t.note || null, date: t.date, edited: !!t.edited, deleted: !!t.deleted };
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
        // Same reasoning as the access error above: the person reading this cannot apply a
        // migration, and telling them the name of the thing that is missing does not change
        // that. The detail stays in the console for whoever can.
        console.error("a database command is missing — the production migration has not been applied", error);
        throw new Error(tr("ئەم کارە ئێستا نییە — نوێکردنەوەی داتابەیس تەواو نەبووە. پەیوەندی بە پشتگیرییەوە بکە."));
      }
      if (error?.code === "55000" || /financial writes are frozen/i.test(msg)) {
        throw new Error("ڕاگرتنی فریاکەوتن چالاکە — هیچ گۆڕانکارییەکی دارایی جێبەجێ ناکرێت");
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
      // «قاسەی تایبەتی خۆم», computed on the server so that the figure a rule is written against
      // and the figure a screen shows are the same number. verify:accounting runs a scenario
      // through both this and the browser's own derivation below and refuses to pass unless
      // they agree to the last unit.
      // «لە وردەکاری قاسەی گشتیدا ئاماژەی پێبدات کە لای ئەوە و پارەی ئەوە.» In the drawer,
      // counted in the total, and not the owner's to move.
      const customerHeld = Object.fromEntries(
        Object.entries(rm.customer_held_by_currency || {}).map(([k, v]) => [k, Number(v) || 0]));
      const ownMoney = rm.own_money_by_currency
        ? Object.fromEntries(Object.entries(rm.own_money_by_currency).map(([k,v]) => [k, Number(v) || 0]))
        : null;
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

      // The owner's safe, asked for directly rather than derived.
      //
      // This used to be `phys − Σ partner`: the total holding of a currency minus what partners
      // held. A residual, and anything the ledger could not describe fell into it — money at an
      // office, money in a bank account — because until 202609010011 and 202609010012 there was
      // no column that could say otherwise. That is why a cashbox could read a number nobody
      // could account for.
      //
      // owner_safe_by_currency is the rows that name no partner, no office and no account. The
      // subtraction is kept as the fallback for a snapshot taken before 202609010014, where it
      // is still the best answer available.
      const safe = rm.owner_safe_by_currency;
      const atMe = {};
      for (const c of data.currencies) {
        if (safe && Object.prototype.hasOwnProperty.call(safe, c.id)) {
          atMe[c.id] = Number(safe[c.id]) || 0;
        } else if (safe) {
          atMe[c.id] = 0;
        } else {
          const atP = Object.values(partner).reduce((s,m) => s + (m[c.id] || 0),0);
          atMe[c.id] = (phys[c.id] || 0) - atP;
        }
      }

      const office = {}, cashAccounts = {};
      for (const x of (rm.office_balances || [])) {
        if (!x?.office_id || !x?.cur_id) continue;
        office[x.office_id] = office[x.office_id] || {};
        office[x.office_id][x.cur_id] = Number(x.amount) || 0;
      }
      for (const x of (rm.cash_account_balances || [])) {
        if (!x?.cash_account_id || !x?.cur_id) continue;
        cashAccounts[x.cash_account_id] = cashAccounts[x.cash_account_id] || {};
        cashAccounts[x.cash_account_id][x.cur_id] = Number(x.amount) || 0;
      }

      return { phys, partner, office, cashAccounts, atMe, invCap, invTotal, selfCap, ownMoney, customerHeld, invPaid, expenses, fees, cust, pending: cust, acctCash, acctDebt };
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
    return { phys, partner, atMe, invCap, invTotal, selfCap, ownMoney: null, customerHeld: {}, invPaid, expenses, fees, cust, pending: cust, acctCash, acctDebt };
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
  // The server sends one row per currency: {cur_id, profit, direct_profit}. This read `x.direct`
  // and `x.amount`, which are not fields the snapshot has ever had — so `Number(undefined) || 0`
  // made every shared total zero and the `!!undefined !== !!true` test threw away every direct
  // one. Both maps came back empty of profit, and because an empty object is truthy the `||`
  // fallback to the transaction walk never ran.
  //
  // The consequence was «قاسەی تایبەتی خۆم»: it adds (sharedProfit − investorsShare) and
  // ownProfit, so with both at zero it read as capital minus the investors' share minus every
  // expense — the owner's own money short by every unit of profit they had ever earned, and
  // negative as soon as the investors' share exceeded the capital. The ownership panel and the
  // dashboard's «ماڵی خۆم» are the same figure and were wrong with it.
  //
  // The reader is gone rather than corrected. Even reading the right fields it would be wrong
  // here: the snapshot is asked for 30 days, and these two are all-time figures, so it would
  // have traded a visible bug for a quiet one that drops everything older than a month.
  // profitIn and ownProfitIn walk the transactions the browser already holds and already
  // agree with every other profit figure on the screen.
  const ownProfitAll = useMemo(() => data ? ownProfitIn(null, null) : {}, [data]);
  const profitAll = useMemo(() => data ? profitIn(null, null) : {}, [data]);

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
  // Sales earn the pool; expenses paid out of the general safe come out of it. Both are dated
  // events shared by the capital standing on their own day, so one list carries both — an
  // investor's share must never be computed from a pool that counts only the good half.
  const poolEvents = (from = null, to = null) => [
    ...profitEventsFrom(data.txs, { from, to }),
    ...sharedCostEventsFrom(data.ledger, { from, to }),
  ];

  const invShare = (iid, curId, from = null, to = null) =>
    investorShare({
      investorId: iid, curId,
      profitEvents: poolEvents(from, to),
      capitalEvents, investors: liveInvestors,
    });

  // دابەشکردن تەنها لەسەر خێری هاوبەش دەکرێت (نەک ڕاستەوخۆ)
  const investorsProfitIn = (from = null, to = null) =>
    investorsTotalByCurrency({
      profitEvents: poolEvents(from, to),
      capitalEvents, investors: liveInvestors, currencies: data.currencies,
    });

  /* قاسەی خۆم = سەرمایەی خۆم + خێری خۆم − خەرجی − عمولەی هاوبەشان */
  const mySafe = useMemo(() => {
    if (!data || !calc) return {};
    // The server's answer when there is one. It is the same definition, written once more in
    // SQL because a rule the server enforces cannot read a number the browser computed — and
    // the two are held to each other by a gate rather than by hope.
    if (calc.ownMoney) {
      return Object.fromEntries(data.currencies.map((c) => [c.id, calc.ownMoney[c.id] || 0]));
    }
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
    if (!(Math.abs(+f.amount) > 0)) { flash(tr("بڕ پێویستە")); return; }
    const amount = roundMoney(data, f.dir === "in" ? Math.abs(+f.amount) : -Math.abs(+f.amount), f.curId);
    // «هەمیشە هەڵبژێرە: کاش یان حسابێک» — no place named means the cash, which is what every
    // movement recorded before today meant, so old rows and new rows say the same thing.
    const e = { id: entryId, type: f.dir === "in" ? "deposit" : "withdraw", owner: f.owner === "self" ? "self" : "investor", investorId: f.owner === "self" ? null : f.owner, curId: f.curId, amount, partnerId: null, cashAccountId: f.place || null, txId: null, note: f.note, date: now() };
    const result = await rpcStrict("sarraf_post_ledger_command", {
      p_ledger: [LR(e)],
      p_command_key: commandKey("cash"),
      p_action: f.dir === "in" ? "پارە داخڵکردن" : "پارە دەرهێنان",
      p_detail: `${fmt(Math.abs(amount))} ${cur(f.curId).code} — ${f.owner === "self" ? "هی خۆم" : usr(f.owner).name}${f.placeName ? " · " + f.placeName : ""}`,
    });
    if (approvalQueued(result, f.dir === "in" ? "پارە داخڵکردن" : "پارە دەرهێنان")) return result;
    flash(tr("تۆمار کرا ✓"));
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

      // Every extra seller must be a whole leg or none of it. A half-filled row would reach
      // the server as a purchase of nothing from nobody and be refused there; refusing it here
      // says which row is wrong.
      const extras = filledSellers(f.extraSellers);
      const incomplete = firstIncompleteSeller(f.extraSellers);
      if (incomplete) {
        const what = incomplete.missing === "person" ? tr("لە کێ دەیکڕیت؟")
          : incomplete.missing === "amount" ? tr("بڕ دەبێت لە سفر گەورەتر بێت")
          : tr("ڕەیتی کڕین پێویستە");
        flash(`${tr("فرۆشیاری")} ${incomplete.position}: ${what}`);
        return false;
      }

      return await run(async () => {
        const bq = +f.buyQuote;
        const sq = +f.sellQuote;
        const displayBaseId = f.rateBaseId || preferredRateBaseId(f.curId, f.againstId);
        const buyStoredRate = displayRateToStored(bq, f.curId, f.againstId, displayBaseId);
        const sellStoredRate = displayRateToStored(sq, f.curId, f.againstId, displayBaseId);
        const pair = uid();
        const at = now();

        // Every purchase, the sale, and what the trade came to — computed in one tested place
        // rather than here. Each extra seller is priced at their own rate, in the same currency
        // pair as the first.
        const math = directTradeLegs({
          amount, buyRate: buyStoredRate, sellRate: sellStoredRate,
          extras: extras.map((x) => ({
            amount: x.amount,
            rate: displayRateToStored(+x.quote, f.curId, f.againstId, displayBaseId),
          })),
          curId: f.curId, againstId: f.againstId, rounder: roundCur,
        });
        const buyTotal = math.legs[0].total;
        const { soldAmount, boughtTotal, sellTotal, profit } = math;

        const extraLegs = math.legs.slice(1).map((leg, i) => ({
          id: uid(), code: null, type: "buy", direct: true, pairId: pair, directRole: "buy",
          ownMoney: true, cpId: extras[i].cpId || null, cpName: extras[i].cpId ? null : extras[i].cpName,
          curId: f.curId, amount: leg.amount, rate: leg.rate, againstId: f.againstId,
          total: leg.total,
          partnerId: null, status: f.buyStatus || "completed", paidAt: null,
          profit: null, profitCurId: null, note: f.note || "", date: at, edited: false,
        }));

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
          curId: f.curId, amount: soldAmount, rate: sellStoredRate, againstId: f.againstId, total: sellTotal,
          buyRate: roundCur(boughtTotal / soldAmount, f.againstId), buyTotal: boughtTotal,
          partnerId: null, status: f.sellStatus || "completed", paidAt: null,
          profit, profitCurId: f.againstId, note: f.note || "", date: at, edited: false,
        };

        const detail = `${fmt(amount)} ${cur(f.curId).code} · خێر ${fmt(profit)} ${cur(f.againstId).code}`;
        const result = await rpcStrict("sarraf_commit_transactions", {
          // The sale goes last so the command reads the way the trade happened: bought, bought,
          // bought, then sold.
          p_txs: [TR(t1), ...extraLegs.map(TR), TR(t2)],
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

    // عمولەی هاوبەش — «بڕەکە خۆم دایدەنێم». Left empty, the partner's stored rate decides on the
    // server. Typed, it is the commission, and it is checked here so the owner is told before
    // they press rather than refused after. The server checks it again and is the authority.
    const commissionText = String(f.partnerFee ?? "").trim();
    if (commissionText !== "" && f.partnerId && f.type === "buy") {
      const asked = Number(commissionText);
      if (!Number.isFinite(asked)) { flash(tr("عمولەکە ژمارەیەکی دروست نییە")); return false; }
      if (asked < 0) { flash(tr("عمولە ناتوانێت کەمتر لە سفر بێت")); return false; }
      if (asked > amount) { flash(tr("عمولە ناتوانێت لە بڕی مامەڵەکە زیاتر بێت")); return false; }
    }

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
        // Sent as the text the owner typed. Rounding a commission in the browser and then
        // letting the server round it again is two answers to one question.
        partnerFee: f.partnerId && f.type === "buy" && commissionText !== "" ? commissionText : null,
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
      // The words the owner picked at creation, said back to them now. p_action above is left
      // alone: that is the audit trail's own vocabulary and it agrees with the server's memo.
      const said = settlementWords({ type: t.type, lang });
      if (t.cpId) await notify(t.cpId, "payment", said.notice,
        `${fmt(t.total, cur(t.againstId).dec ?? 0)} ${cur(t.againstId).code}`, null, t.id);
      flash(said.done);
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
  // «بەڵێ، پارە لە قاسەی من دەچێتە لای نووسینگە.» The owner's own answer, and the half of §5.2
  // that had no button: sending an office money BEFORE it pays somebody on the owner's behalf.
  // 202609010013 posts Dr acc-1300 / Cr acc-1000 and refuses an advance the safe cannot cover —
  // that refusal is the server's to make, and it reaches the owner as written rather than being
  // second-guessed here.
  const officeAdvanceTo = (officeId, curId, amount) => {
    if (!officeId || !curId) return flash(tr("نووسینگە هەڵبژێرە"), "error");
    if (!(amount > 0)) return flash(tr("بڕێکی دروست بنووسە"), "error");
    return run(async () => {
      await officeAdvance(supabase, {
        officeId,
        currencyCode: cur(curId).code,
        amount,
        reason: `پارە نێردرا بۆ نووسینگە — ${usr(officeId).name || officeId}`,
        commandKey: commandKey("office-advance"),
      });
      await notify(officeId, "payment", tr("پارەت بۆ نێردرا"),
        `${fmt(amount, cur(curId).dec ?? 0)} ${cur(curId).code}`, null, null);
      flash(tr("پارە بۆ نووسینگە نێردرا ✓"));
    }, `office-advance:${officeId}:${curId}`);
  };

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
        curId: f.curId, amount: -amt, partnerId: null, cashAccountId: f.place || null, txId: null,
        // «ئاماژە بەوە بکات لە قاسەی گشتی دیدەی یان قاسەی تایبەتی خۆت.» An investor's payout is
        // not an expense of either safe — it is their own profit going back to them — so it
        // names none, which is what the server stores for it anyway.
        paidFrom: isPayout ? null : (f.paidFrom === "general" ? "general" : "own"),
        note: `${f.category}${f.note ? " — " + f.note : ""}`, date: now(),
      };
      const result = await rpcStrict("sarraf_post_ledger_command", {
        p_ledger: [LR(e)],
        p_command_key: commandKey("expense"),
        p_action: isPayout ? "پارەدانی خێری وەبەرهێنەر" : "خەرجی",
        p_detail: `${fmt(amt)} ${cur(f.curId).code} — ${isPayout ? usr(f.investorId).name : f.category}`,
      });
      if (approvalQueued(result, isPayout ? "پارەدانی خێری وەبەرهێنەر" : "خەرجی")) return result;
      flash(tr("تۆمار کرا ✓"));
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
    // Twelve, and the same twelve the server applies — api/_password.js is the one place the
    // rule is written. It used to be eight here and eight on the server while the label said
    // twelve, so the number a person read and the number that was checked were different.
    //
    // This check is only so the refusal arrives without a round trip. The server's is the one
    // that matters, and it says more than a length: a password that is the account's own phone
    // number, or one of the strings that get tried first, is refused there with its own reason.
    if (!f.name || !f.phone || !f.password || f.password.length < 12) {
      flash(tr("ناو، ژمارە، و وشەی نهێنی (لانیکەم ١٢ پیت) پێویستن"));
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

  const d…116202 tokens truncated…px] font-semibold" style={{ color: "var(--txt)" }}>{u.name}</h2>}

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
            <Inp value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("گەڕان بە ناو یان کۆد…")} />
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
function UsersAdmin({ data, cur, createUser, deleteUser, setUserRate, resetUserPassword, flash, isOwner }) {
  const [f, setF] = useState({ name: "", role: "customer", rate: "", scope: [], phone: "", address: "", note: "", password: "" });
  const [passwordTarget, setPasswordTarget] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deactivateTarget, setDeactivateTarget] = useState("");
  const [deactivateReason, setDeactivateReason] = useState("");
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
          <div><Lbl>{tr("وشەی نهێنی * (لانیکەم ١٢ پیت)")}</Lbl><Inp type="password" dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="••••••" /></div>
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
          <button type="button" onClick={() => {
            setPasswordTarget(passwordTarget === u.id ? "" : u.id);
            setNewPassword("");
          }} aria-label={`گۆڕینی وشەی نهێنیی ${u.name}`}
            className="text-[var(--txt-3)] hover:text-[var(--ac)]">
            <KeyRound className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => {
            setDeactivateTarget(deactivateTarget === u.id ? "" : u.id);
            setDeactivateReason("");
          }} aria-label={`ناچالاککردنی ئەکاونتی ${u.name}`}
            className="text-[var(--txt-3)] hover:text-[var(--neg)]"><Trash2 className="w-4 h-4" /></button>
          {passwordTarget === u.id && (
            <div className="basis-full grid gap-2 sm:grid-cols-[1fr_auto] pt-3 border-t border-[var(--line)]">
              <Inp type="password" dir="ltr" autoComplete="new-password" value={newPassword}
                aria-label={`وشەی نهێنیی نوێ بۆ ${u.name}`} placeholder="لانیکەم ١٢ پیت"
                onChange={(e) => setNewPassword(e.target.value)} />
              <Btn disabled={newPassword.length < 12} onClick={async () => {
                const ok = await resetUserPassword(u, newPassword);
                setNewPassword("");
                if (ok !== false) setPasswordTarget("");
              }}>دانانی وشەی نهێنی</Btn>
            </div>
          )}
          {deactivateTarget === u.id && (
            <div className="basis-full space-y-2 pt-3 border-t border-[var(--line)]">
              <div className="text-sm font-semibold text-[var(--neg)]">ناچالاککردنی ئەکاونتی «{u.name}»</div>
              <div className="text-xs text-[var(--txt-2)]">تەنها ئەگەر هەموو باڵانس و قەرزەکانی سفر بن ئەنجام دەدرێت. مێژووی دارایی ناسڕێتەوە.</div>
              <Inp value={deactivateReason} onChange={(e) => setDeactivateReason(e.target.value)}
                aria-label={`هۆکاری ناچالاککردنی ${u.name}`} placeholder="هۆکار بنووسە — حەتمییە" />
              <div className="flex gap-2 justify-end">
                <Btn kind="ghost" onClick={() => { setDeactivateTarget(""); setDeactivateReason(""); }}>پاشگەزبوونەوە</Btn>
                <Btn kind="danger" disabled={deactivateReason.trim().length < 3} onClick={async () => {
                  const ok = await deleteUser(u, deactivateReason);
                  if (ok !== false) { setDeactivateTarget(""); setDeactivateReason(""); }
                }}>ناچالاککردن</Btn>
              </div>
            </div>
          )}
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

  // «دەبێت لە ڕاپۆرتا هەموو خێرێک هەبێت کە لەم ئیشە یان هەر ئیشیکی تر چەندم خیر کردووە» —
  // the line above adds every sale's spread into one figure and a commission trade is not in it
  // at all. The split lives in its own module, with its own tests, because it is money maths.
  const earningKinds = useMemo(
    () => earningsByKind({ txs, usdValueAt }), [txs, usdValueAt]);

  // «کە خەرجییەکەم دا ئاماژە بەوە بکات لە قاسەی گشتی دیدەی یان قاسەی تایبەتی خۆت» — the total
  // is still one figure, and beside it the two safes it came out of. An expense recorded before
  // the question was asked reads as the owner's own, which is what every screen has always
  // done with it.
  const exp = {}, expGeneral = {}, expOwn = {}, fee = {}, payout = {}, flow = {};
  entries.forEach((e) => {
    if (e.type === "expense") {
      exp[e.curId] = (exp[e.curId] || 0) + Math.abs(e.amount);
      const safe = e.paidFrom === "general" ? expGeneral : expOwn;
      safe[e.curId] = (safe[e.curId] || 0) + Math.abs(e.amount);
    }
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
            <PL label={tr("— لە قاسەی گشتی")} m={expGeneral} tone="neg" />
            <PL label={tr("— لە قاسەی تایبەتی خۆم")} m={expOwn} tone="neg" />
            <PL label={tr("عمولەی هاوبەشان")} m={fee} tone="neg" />
            <PL label={tr("خێری وەبەرهێنەران")} m={invP} tone="neg" />
            <div className="mt-1 pt-1 border-t-2 border-slate-900/10">
              <PL label={tr("نەتیجەی کۆتایی (بۆ خۆم)")} m={net} tone="auto" bold />
            </div>

            {/* «هەموو خێرێک هەبێت کە لەم ئیشە یان هەر ئیشیکی تر چەندم خیر کردووە» — the line
              * above is one figure for every sale added together, and a commission trade is not
              * in it at all. This says which work earned what, in dollars, because that is the
              * only unit the three kinds share. */}
            <div className="mt-4 pt-3 border-t border-[var(--line)]">
              <SecLbl>{tr("کام ئیشە چەندی خێر کردووە")}</SecLbl>
              <div className="mt-2 space-y-1">
                {EARNING_KINDS.map((key) => {
                  const k = earningKinds[key];
                  const label = key === "commission" ? tr("مامەڵەی عمولە")
                    : key === "direct" ? tr("مامەڵەی ڕاستەوخۆ") : tr("کڕین و فرۆشتن");
                  return (
                  <div key={key} className="report-pl-row">
                    <span className="report-pl-label">
                      {label}
                      <span className="text-[10.5px] ms-1.5" style={{ color: "var(--txt-3)" }}>
                        {k.n} {tr("مامەڵە")}
                      </span>
                    </span>
                    <div className="text-end">
                      <span className="text-[13px]" style={{ ...num, fontWeight: 600,
                        color: k.usd < 0 ? "var(--neg)" : k.usd > 0 ? "var(--pos)" : "var(--txt-3)" }}>
                        {k.usd < 0 ? "−" : k.usd > 0 ? "+" : ""}{fmt(Math.abs(k.usd), 2)}
                        <span className="text-[10.5px] font-normal ms-1" style={{ color: "var(--txt-3)" }}>USD</span>
                      </span>
                    </div>
                  </div>
                  );
                })}
              </div>
              {/* Said rather than left to be worked out: a trade whose currency had no rate that
                  day cannot be valued, so it is counted apart rather than counted as zero. */}
              <div className="text-[10.5px] mt-2" style={{ color: "var(--txt-3)" }}>
                {tr("بە دۆلار هەڵسەنگێندراوە بە نرخی هەمان ڕۆژ — ئەو مامەڵانەی نرخیان نەبووە لێرەدا نین")}
                {EARNING_KINDS.reduce((n, key) => n + earningKinds[key].unvalued, 0) > 0 && (
                  <> · <b>{EARNING_KINDS.reduce((n, key) => n + earningKinds[key].unvalued, 0)}</b></>
                )}
              </div>
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
function Backup({ data, calc, cur, lang = "ku", downloadBackup, flash, sumUsd, mySafe, owners, ratesReady, isOwner, runSystemHealth, setMaintenanceMode }) {
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
      setReconErr(userFacingServiceError(e, lang, "یەکسانکردنەوە سەرکەوتوو نەبوو"));
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
                {maintBusy ? tr("جێبەجێکردن…") : frozen ? tr("کردنەوەی تۆمارکردنی دارایی") : tr("چالاککردنی ڕاگرتنی فریاکەوتن")}
              </Btn>
              <span className="text-[11px] self-center text-[var(--txt-3)]">
                تەنها خاوەنی سیستەم
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
            {busy ? tr("جێبەجێکردن…") : tr("پشکنینی یەکسانکردنەوە لە سێرڤەر")}
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
            export ـی JSON ـی خوارەوە تەنها کۆپییەکی زیادەی off-site ـە؛ زانیاریی نهێنیی Auth، فایلەکانی Storage،
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
            {busy ? tr("جێبەجێکردن…") : tr("دابەزاندنی هەناردەی JSON بۆ دەرەوە")}
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
          {tr("فایلێکی هەناردەی پاشەکەوتکراو هەڵبژێرە — پشکنین دەکرێت کە تێکنەچووبێت و لەگەڵ داتابەیسی ئێستا بگونجێت.")}
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
        {rehearsal?.state === "working" && <div className="text-xs text-[var(--txt-3)] mt-3">{tr("پشکنین…")}</div>}
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

      {rates === null ? <Empty t={tr("بارکردن…")} /> :
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

  // ── What each of these five actually answers ───────────────────────────────────────────────
  //
  //   «بەشەکانی تریش هیچ لێیان تێناگەم زۆر زۆر ناڕوونن ... پێویستە ئەو بەشانە ڕوون بن.»
  //
  // The screen was five words — ڕەوت، پێشبینین، مێژووی نرخ، ڕاپۆرتی ڕۆژ، چالاکی — over charts
  // with no statement of what they are of. A person who does not already know what a tab is for
  // cannot find out by pressing it, because the chart looks the same either way. One sentence
  // each, saying the question it answers, is the whole difference between a wall of numbers and
  // a screen somebody can use.
  const TAB_HELP = {
    trend: l10n("چەندت خێر کردووە لە هەر ڕۆژێکدا، و چەند مامەڵەت کردووە — بۆ ئەوەی بزانیت کام ڕۆژ باشتر بووە",
      "What you earned each day and how many trades you made — so you can see which days went well",
      "كم ربحت كل يوم وكم معاملة أجريت — لترى أي الأيام كانت أفضل"),
    fc: l10n("ئەگەر ڕۆژەکانی داهاتوو وەک ڕۆژەکانی ڕابردوو بن، چەند خێر چاوەڕێ دەکرێت — ئەمە پێشبینینە، نەک بەڵێن",
      "If the coming days look like the past ones, what to expect — this is an estimate, not a promise",
      "إذا كانت الأيام القادمة كالماضية، فما المتوقع — هذا تقدير وليس وعداً"),
    rates: l10n("نرخەکان چۆن گۆڕاون بە درێژایی کات، بەو نرخانەی خۆت تۆمارت کردوون",
      "How the rates have moved over time, from the rates you recorded yourself",
      "كيف تحرّكت الأسعار عبر الوقت، حسب الأسعار التي سجّلتها بنفسك"),
    report: l10n("کورتەی ئەمڕۆ بە یەک ڕوانین: چی هاتووە، چی چووە، و چی ماوە",
      "Today at a glance: what came in, what went out, and what is left",
      "اليوم بلمحة: ما دخل وما خرج وما تبقّى"),
    log: l10n("کێ چی کردووە و کەی — هەموو کردارێک کە کەسێک ئەنجامی داوە",
      "Who did what and when — every action anybody took",
      "من فعل ماذا ومتى — كل إجراء قام به أي شخص"),
  };

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

      {/* Under the tabs rather than inside each one, so it is in the same place every time and
          a person learns where to look for it. */}
      <p className="text-[12px] leading-relaxed" style={{ color: "var(--txt-2)" }} aria-live="polite">
        {TAB_HELP[tab]}
      </p>

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
            {hist === null ? <StatePanel type="loading" title={tr("بارکردن…")} compact /> :
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
            {reconBusy ? "پشکنین…" : "پشکنینی یەکسانی"}
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
                  <Inp type="number" dir="ltr" placeholder={tr("ژماردنی ڕاستەقینە…")}
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
              <Inp value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("نموونە: خەرجی تۆمار نەکراو…")} />
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
      {hist === null ? <Card><Empty t={tr("بارکردن…")} /></Card> :
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
function CustomerPortal({ user, c, base, data, calc, cur, usr, flash, reloadBatches, online, stale, refreshing, refreshedAt, refresh, previewing = false }) {
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
  // «دەبێت لای ئەو بنووسرێت پارەکەت لە فڵان نوسینگەیە.» The balance above says how much is owed
  // and has never said where it is. A failure here must leave the balance standing: knowing the
  // office is an improvement on the figure, not a precondition for showing it.
  const [atOffices, setAtOffices] = useState([]);
  useEffect(() => {
    let alive = true;
    loadMoneyAtOffices(supabase, user.id)
      .then((rows) => { if (alive) setAtOffices(rows); })
      .catch(() => { if (alive) setAtOffices([]); });
    return () => { alive = false; };
  }, [user.id, refreshedAt]);
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
                {atOffices.map((row) => (
                  <div key={row.assignmentId} className="text-[11.5px] mt-1.5 flex items-center gap-1.5"
                       style={{ color: "var(--warn)" }}>
                    <Building2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{moneyAtOfficeText(row, activeLanguage())}
                      {" · "}<b style={num}>{fmt(row.outstanding)}</b> {row.currency}</span>
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
          <ReceiptArchive customerId={user.id} data={data} flash={flash} simple previewing={previewing} />
          <DeferredPanel><ForwardedReceipts client={supabase} flash={flash} subjectId={user.id}
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
function PartnerPortal({ user, data, calc, cur, usr, flash, reloadBatches, online, stale, refreshing, refreshedAt, refresh, previewing = false }) {
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
        <DeferredPanel><ForwardedReceipts client={supabase} flash={flash} subjectId={user.id}
          signedUrlFor={async (path) => {
            const { data: signed } = await supabase.storage.from("receipts").createSignedUrl(path, 3600);
            return signed?.signedUrl || null;
          }} /></DeferredPanel>
        <PartnerReceipts partnerId={user.id} data={data} flash={flash} />
        {/* Their own archive: what this partner themselves sent, with the details of each
            receipt — the same view the customer-seller gets, scoped by the server to them. */}
        <ReceiptArchive customerId={user.id} data={data} flash={flash} simple previewing={previewing} />
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
function Portal({ user, data, calc, cur, usr, officePay, settle, invUnpaid, flash, reloadBatches, accountMove, accountTransfer, previewing = false, ...portalState }) {
  if (user.role === "office") return (
    <div className="portal-frame"><section className="portal-main" id="portal-content">
      <DeferredPanel><OfficePayments client={supabase} lang={portalState.lang || "ku"} flash={flash}
        officeId={user.id} /></DeferredPanel>
    </section></div>
  );

  if (user.role === "customer") {
    const c = calc.cust[user.id] || { owe: {}, due: {} };
    const base = data.txs.filter((t) => !t.deleted && t.cpId === user.id).reverse();
    return <CustomerPortal user={user} c={c} base={base} data={data} calc={calc} cur={cur} usr={usr} flash={flash} reloadBatches={reloadBatches} previewing={previewing} {...portalState} />;
  }

  if (user.role === "partner") return <PartnerPortal user={user} data={data} calc={calc} cur={cur} usr={usr} flash={flash} reloadBatches={reloadBatches} previewing={previewing} {...portalState} />;

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
