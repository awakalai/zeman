/**
 * What the manager sees, which is not what anybody else sees.
 *
 * The manager maintains the installation and sells it. They are not a party to any business's
 * trades, and their console shows businesses, accounts and the health of the system rather than
 * transactions, receipts and rates. Reaching a business's own figures means stepping into it
 * deliberately, not having them mixed into a dashboard by default.
 *
 * Nothing here computes a total from business data. That is the point: a manager reading a
 * different number from the business that owns it would be worse than reading none.
 */

const clean = (v) => String(v ?? "").normalize("NFKC").trim();
const say = (phrase, lang) => phrase[lang === "en" ? "en" : lang === "ar" ? "ar" : "ku"];

export const TENANT_ID_MIN = 3;

/** A business's id is typed once and lives forever in every row it owns. */
export function tenantIdObjection(id) {
  const value = clean(id);
  if (value.length < TENANT_ID_MIN) return `ناسنامەی سەرخێڵ لانیکەم ${TENANT_ID_MIN} پیت بێت`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    return "تەنها پیتی ئینگلیزیی بچووک، ژمارە و داش (-)";
  }
  return null;
}

export function tenantNameObjection(name) {
  return clean(name).length < 2 ? "ناوی سەرخێڵ پێویستە" : null;
}

/** Every business, with what it holds. Manager only; the server refuses anybody else. */
export async function loadTenants(client) {
  const { data, error } = await client.rpc("sarraf_manager_tenants");
  if (error) throw error;
  return data || { tenants: [], total_accounts: 0 };
}

/**
 * A new customer, in one act.
 *
 * createTenant made the business and stopped there: nobody could sign into it, and the manager's
 * next act was on a different screen. If they forgot, the business sat there looking created and
 * was unusable. This makes the business, its settings, and the person who will open it.
 *
 * No password is created or held anywhere. What is written is a row saying who a login will be;
 * the owner is invited through Supabase and becomes the owner the first time they arrive.
 */
export async function openBusiness(client, { id, name, ownerEmail, ownerName, note = null }) {
  const objection = tenantIdObjection(id) || tenantNameObjection(name)
    || ownerEmailObjection(ownerEmail) || ownerNameObjection(ownerName);
  if (objection) throw new Error(objection);
  const { data, error } = await client.rpc("sarraf_manager_open_business", {
    p_id: clean(id), p_name: clean(name),
    p_owner_email: clean(ownerEmail).toLowerCase(), p_owner_name: clean(ownerName),
    p_note: clean(note) || null,
  });
  if (error) throw error;
  return data;
}

const NEEDS_AN_EMAIL = {
  ku: "ئیمەیڵی خاوەنەکە پێویستە",
  en: "The owner's email address is required",
  ar: "البريد الإلكتروني للمالك مطلوب",
};
const NEEDS_AN_OWNER_NAME = {
  ku: "ناوی خاوەنەکە پێویستە",
  en: "The owner's name is required",
  ar: "اسم المالك مطلوب",
};

export function ownerEmailObjection(email, lang = "ku") {
  const value = clean(email).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? null : say(NEEDS_AN_EMAIL, lang);
}

export function ownerNameObjection(name, lang = "ku") {
  return clean(name).length < 2 ? say(NEEDS_AN_OWNER_NAME, lang) : null;
}

/**
 * Suspending a business rather than deleting it.
 *
 * Their data stays exactly where it is. A business that has stopped paying, or stopped trading,
 * is not a business whose books should be destroyed — and reversing a suspension is a switch
 * where reversing a deletion is a restore from backup.
 */
export async function setTenantActive(client, { id, active, reason }) {
  if (!clean(id)) throw new Error("سەرخێڵێک پێویستە");
  if (clean(reason).length < 4) throw new Error("هۆکارێک بنووسە");
  const { data, error } = await client.rpc("sarraf_manager_set_tenant_active", {
    p_id: clean(id), p_active: Boolean(active), p_reason: clean(reason),
  });
  if (error) throw error;
  return data;
}

/** The state of the installation itself: drift, tenancy gaps, rows belonging to nobody. */
export async function loadHealth(client) {
  const [schema, coverage, orphans] = await Promise.all([
    client.rpc("sarraf_schema_report"),
    client.rpc("sarraf_tenant_coverage"),
    client.rpc("sarraf_tenant_orphans"),
  ]);
  if (schema.error) throw schema.error;
  return {
    schema: schema.data || { tables: [], columns: [] },
    // A coverage or orphan read that fails must not hide the schema report that succeeded.
    coverage: coverage.error ? null : (coverage.data || []),
    orphans: orphans.error ? null : (orphans.data?.orphans || {}),
    coverageError: coverage.error ? String(coverage.error.message || coverage.error) : null,
    orphansError: orphans.error ? String(orphans.error.message || orphans.error) : null,
  };
}

/**
 * Is the installation in good order?
 *
 * Returns the list of what is wrong, in the order it matters. An empty list is the only good
 * answer, and it is stated as a list rather than a boolean so a screen can show what to do.
 */
export function healthProblems(health, lang = "ku") {
  const out = [];
  const ku = lang !== "en";
  for (const t of health?.schema?.tables || []) {
    out.push(ku
      ? `خشتەی ${t.table_name} — ${t.state === "missing from the database" ? "لە داتابەیسدا نییە" : "بەڕێوە نابرێت"}`
      : `table ${t.table_name} — ${t.state}`);
  }
  for (const c of health?.schema?.columns || []) {
    out.push(ku
      ? `ستوونی ${c.table_name}.${c.column_name} — چاوەڕوان ${c.expected}، دۆزرایەوە ${c.found}`
      : `${c.table_name}.${c.column_name} — expected ${c.expected}, found ${c.found}`);
  }
  for (const g of health?.coverage || []) {
    out.push(ku
      ? `${g.table_name} — جیاکردنەوەی سەرخێڵی نییە`
      : `${g.table_name} — ${g.problem}`);
  }
  for (const [table, n] of Object.entries(health?.orphans || {})) {
    out.push(ku ? `${table} — ${n} ڕیز خاوەنیان نییە` : `${table} — ${n} rows belong to nobody`);
  }
  return out;
}

/** Accounts across every business, for the one screen that is allowed to see across them. */
export async function loadAllAccounts(client) {
  const { data, error } = await client.rpc("sarraf_manager_accounts");
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * The support context: the manager opens one business, says why, and it expires.
 *
 * The manager belongs to no business and every policy in the system lets them through, so
 * without this a business owner has no way to know whether the person who sold them the system
 * has been in their accounts. api/admin-user.js refuses to act on a business without one, and
 * the row it writes is readable by the owner of that business and cannot be deleted.
 */

export const SUPPORT_REASON_MIN = 8;

/**
 * A phrase written here rather than in the dictionary, in all three languages.
 *
 * These are refusals the caller sees before anything reaches the server, so they are not
 * server messages and have no key. Writing them in one language would leave an English or
 * Arabic reader with a Kurdish sentence at the one moment they are being told they did
 * something wrong.
 */
const NEEDS_A_REASON = {
  ku: `هۆکارەکە دەبێت لانیکەم ${SUPPORT_REASON_MIN} پیت بێت`,
  en: `The reason must be at least ${SUPPORT_REASON_MIN} characters`,
  ar: `يجب ألا يقل السبب عن ${SUPPORT_REASON_MIN} أحرف`,
};
const NEEDS_A_BUSINESS = { ku: "سەرخێڵێک پێویستە", en: "Choose a business", ar: "اختر عملًا" };

export function supportReasonObjection(reason, lang = "ku") {
  return clean(reason).length < SUPPORT_REASON_MIN ? say(NEEDS_A_REASON, lang) : null;
}

export async function openSupport(client, { tenantId, reason, minutes = 120, lang = "ku" }) {
  if (!clean(tenantId)) throw new Error(say(NEEDS_A_BUSINESS, lang));
  const objection = supportReasonObjection(reason, lang);
  if (objection) throw new Error(objection);
  const { data, error } = await client.rpc("sarraf_manager_open_support", {
    p_tenant_id: clean(tenantId), p_reason: clean(reason), p_minutes: minutes,
  });
  if (error) throw error;
  return data;
}

export async function closeSupport(client, reason = null) {
  const { data, error } = await client.rpc("sarraf_manager_close_support", {
    p_reason: clean(reason) || null,
  });
  if (error) throw error;
  return data;
}

/** Which business is open right now, or null. */
export async function currentSupport(client) {
  const { data, error } = await client.rpc("sarraf_manager_support_tenant");
  if (error) throw error;
  return clean(data) || null;
}

/**
 * Every context opened, newest first.
 *
 * A manager sees their own across all businesses; a business owner sees the ones opened against
 * theirs. That second reading is the whole point — it is what a customer can point at when they
 * ask whether the vendor has been in their books.
 */
export async function loadSupportHistory(client, days = 90) {
  const { data, error } = await client.rpc("sarraf_support_history", { p_days: days });
  if (error) throw error;
  return {
    days: Number(data?.days) || days,
    sessions: Array.isArray(data?.sessions) ? data.sessions : [],
  };
}

/**
 * Which business needs the vendor, and why.
 *
 * loadTenants answers "what exists". This answers "where do I need to go" — the question
 * somebody running the platform actually opens the console with. The live database had a
 * business nobody had ever been inside and the console said nothing; it took a database
 * inspection to find.
 *
 * Counts and states, never amounts. A count of entries waiting to be posted says the books need
 * attention; the figures in them are the business's own.
 */
export async function loadAttention(client, quietDays = 30) {
  const { data, error } = await client.rpc("sarraf_manager_attention", { p_quiet_days: quietDays });
  if (error) throw error;
  return {
    quietDays: Number(data?.quiet_days) || quietDays,
    checkedAt: data?.checked_at || null,
    businesses: Array.isArray(data?.businesses) ? data.businesses : [],
  };
}

/**
 * What this business needs, in the order it matters, written for a person to read.
 *
 * A single "unhealthy" flag would collapse "nobody has ever signed in" and "quiet for forty
 * days" into one colour, and they are different problems with different answers.
 */
export function attentionReasons(business, lang = "ku") {
  const out = [];
  const pick = (phrase) => say(phrase, lang);
  if (business?.never_opened) out.push(pick(NEVER_OPENED));
  if (business?.active === false) out.push(pick(SUSPENDED));
  if (business?.quiet) out.push(pick(QUIET));
  if (business?.waiting_to_claim > 0) out.push(`${pick(WAITING_TO_CLAIM)} (${business.waiting_to_claim})`);
  if (business?.without_mfa > 0) out.push(`${pick(WITHOUT_MFA)} (${business.without_mfa})`);
  if (business?.receipts_waiting > 0) out.push(`${pick(RECEIPTS_WAITING)} (${business.receipts_waiting})`);
  if (business?.entries_unposted > 0) out.push(`${pick(ENTRIES_UNPOSTED)} (${business.entries_unposted})`);
  return out;
}

const NEVER_OPENED = {
  ku: "هێشتا کەس نەچووەتە ژوورەوە",
  en: "Nobody has ever signed in",
  ar: "لم يدخل أحد بعد",
};
const SUSPENDED = {
  ku: "ڕاگیراوە — دەخوێندرێتەوە، مامەڵە ناکات",
  en: "Suspended — reads, does not trade",
  ar: "موقوف — يقرأ ولا يتاجر",
};
const QUIET = {
  ku: "ماوەیەکە هیچ کارێکی نەکردووە",
  en: "Nothing has happened for a while",
  ar: "لم يحدث شيء منذ فترة",
};
const WAITING_TO_CLAIM = {
  ku: "بانگهێشت وەرنەگیراوە",
  en: "Invitation not accepted",
  ar: "الدعوة لم تُقبل",
};
const WITHOUT_MFA = {
  ku: "ئەکاونتی پارێزراو بێ MFA",
  en: "Protected account with no second factor",
  ar: "حساب محمي بلا عامل ثانٍ",
};
const RECEIPTS_WAITING = {
  ku: "فیشی وەستاو",
  en: "Receipts that stopped moving",
  ar: "إيصالات متوقفة",
};
const ENTRIES_UNPOSTED = {
  ku: "تۆماری ژورناڵی نەپۆستکراو",
  en: "Journal entries not posted",
  ar: "قيود غير مُرحَّلة",
};

/**
 * The installation at a glance — the first thing a manager should see.
 *
 * sarraf_manager_overview has existed since 202608230001 and nothing has ever read it. It
 * answers the questions the person who sold the software actually opens the application with:
 * how many businesses are on it, who administers them, and what has changed lately across the
 * whole installation rather than inside one business's books.
 *
 * No money appears here and none is available to. A manager is not a party to anybody's trades,
 * and the function returns counts and names — enough to know an installation is in use, not
 * enough to be looking at somebody's money.
 */
export async function loadManagerOverview(client) {
  const { data, error } = await client.rpc("sarraf_manager_overview");
  if (error) throw error;
  const answer = data || {};
  return {
    administrators: (answer.administrators || []).map((a) => ({
      id: a.id,
      name: a.name || a.id,
      level: a.level || null,
      phone: a.phone || null,
      deleted: a.deleted === true,
      createdAt: a.created_at || null,
    })),
    byRole: answer.by_role || {},
    managerCount: Number(answer.manager_count ?? 0),
    ownerCount: Number(answer.owner_count ?? 0),
    // Newest first, as the server orders them. Fifty is the server's limit, not a page size.
    recentChanges: (answer.recent_changes || []).map((c) => ({
      at: c.at || null,
      action: c.action || "",
      detail: c.detail || "",
    })),
  };
}
