/**
 * Client bindings for the double-entry accounting layer.
 *
 * Every write here is an audited, idempotent RPC. The browser never sets a balance, posts a
 * journal line, or decides a debt's direction — it asks for a command to be executed and the
 * database decides whether it may be. Reads go through RLS-protected tables and views.
 */

const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const reason = (value) => String(value ?? "").normalize("NFKC").trim();
const upper = (value) => String(value ?? "").trim().toUpperCase();

export const accountingCommandKey = (operation, subject = "none") =>
  `acct-${operation}:${String(subject).slice(0, 80)}:${id()}`;

const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** A rate is required for anything that is not already USD; the ledger refuses to invent one. */
export function requireRateFor(currency, rate) {
  if (upper(currency) === "USD") return 1;
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("نرخی ئەمڕۆی USD دانەنراوە — بەبێ نرخ ناتوانرێت بە دۆلار هەڵبسەنگێندرێت");
  }
  return n;
}

async function callCommand(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw error;
  return data;
}

/**
 * Deposit into or withdraw from a customer's cashbox.
 * A deposit increases what ZEMAN holds and what ZEMAN owes that customer. It is not income.
 */
export async function moveCustomerVault(client, {
  customerId, currency, amount, direction, rate, reason: why, commandKey,
}) {
  const value = positive(amount);
  if (!customerId) throw new Error("کڕیار پێویستە");
  if (!value) throw new Error("بڕ دەبێت لە سفر گەورەتر بێت");
  if (!["in", "out"].includes(direction)) throw new Error("ئاڕاستەی نادروست");
  const text = reason(why);
  if (text.length < 3) throw new Error("هۆکار پێویستە");
  const key = commandKey || accountingCommandKey("vault", customerId);
  return {
    result: await callCommand(client, "sarraf_customer_vault_move", {
      p_customer_id: customerId,
      p_currency: upper(currency),
      p_amount: value,
      p_direction: direction,
      p_rate: requireRateFor(currency, rate),
      p_reason: text,
      p_command_key: key,
    }),
    commandKey: key,
  };
}

/** Settle a customer's debts from their own cashbox, same currency, via the waterfall. */
export async function applyVaultToDebt(client, {
  customerId, currency, amount, rate, reason: why, commandKey,
}) {
  const value = positive(amount);
  if (!customerId) throw new Error("کڕیار پێویستە");
  if (!value) throw new Error("بڕ دەبێت لە سفر گەورەتر بێت");
  const text = reason(why);
  if (text.length < 3) throw new Error("هۆکار پێویستە");
  const key = commandKey || accountingCommandKey("settle", customerId);
  return {
    result: await callCommand(client, "sarraf_apply_vault_to_debt", {
      p_customer_id: customerId,
      p_currency: upper(currency),
      p_amount: value,
      p_rate: requireRateFor(currency, rate),
      p_reason: text,
      p_command_key: key,
    }),
    commandKey: key,
  };
}

/** Turn a debt ZEMAN owes a customer into cashbox credit, closing the debt in the same step. */
export async function creditDebtToVault(client, { debtId, amount, rate, currency, reason: why, commandKey }) {
  if (!debtId) throw new Error("قەرز پێویستە");
  const text = reason(why);
  if (text.length < 3) throw new Error("هۆکار پێویستە");
  const key = commandKey || accountingCommandKey("d2v", debtId);
  return {
    result: await callCommand(client, "sarraf_zeman_debt_to_vault", {
      p_debt_id: debtId,
      p_amount: positive(amount),
      p_rate: requireRateFor(currency, rate),
      p_reason: text,
      p_command_key: key,
    }),
    commandKey: key,
  };
}

/** Preview where a payment would land before it is applied. */
export async function previewDebtWaterfall(client, {
  debtorType, debtorId = null, creditorType, creditorId = null, currency, amount,
}) {
  const { data, error } = await client.rpc("sarraf_debt_waterfall", {
    p_debtor_type: debtorType,
    p_debtor_id: debtorId,
    p_creditor_type: creditorType,
    p_creditor_id: creditorId,
    p_currency: upper(currency),
    p_amount: positive(amount) ?? 0,
  });
  if (error) throw error;
  return (data || []).map((row) => ({
    debtId: row.debt_id,
    outstanding: Number(row.outstanding) || 0,
    allocated: Number(row.allocated) || 0,
    remainingAfter: Number(row.remaining_after) || 0,
  }));
}

export async function loadCustomerVaults(client, customerId = null) {
  let query = client.from("customer_vaults").select("*").order("currency");
  if (customerId) query = query.eq("customer_id", customerId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((v) => ({
    id: v.id,
    customerId: v.customer_id,
    currency: v.currency,
    available: Number(v.available) || 0,
    reserved: Number(v.reserved) || 0,
    total: (Number(v.available) || 0) + (Number(v.reserved) || 0),
    lastEventAt: v.last_event_at,
  }));
}

export async function loadVaultStatement(client, { customerId, currency = null, limit = 200 }) {
  let query = client.from("customer_vault_events").select("*")
    .eq("customer_id", customerId).order("created_at", { ascending: false }).limit(limit);
  if (currency) query = query.eq("currency", upper(currency));
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((e) => ({
    id: e.id,
    kind: e.kind,
    currency: e.currency,
    availableDelta: Number(e.available_delta) || 0,
    reservedDelta: Number(e.reserved_delta) || 0,
    reason: e.reason,
    debtId: e.debt_id,
    journalEntryId: e.journal_entry_id,
    createdAt: e.created_at,
  }));
}

/**
 * Open debts, split by direction so the UI can say "I owe" and "owed to me" in words
 * rather than leaving the reader to interpret a sign.
 */
export async function loadDebts(client, { partyId = null, currency = null } = {}) {
  let query = client.from("debts").select("*")
    .in("status", ["open", "partially_settled"])
    .order("due_at", { ascending: true, nullsFirst: false });
  if (currency) query = query.eq("currency", upper(currency));
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data || []).map((d) => ({
    id: d.id,
    debtorType: d.debtor_type,
    debtorId: d.debtor_id,
    creditorType: d.creditor_type,
    creditorId: d.creditor_id,
    currency: d.currency,
    originalPrincipal: Number(d.original_principal) || 0,
    outstanding: Number(d.outstanding_principal) || 0,
    status: d.status,
    reason: d.reason,
    openedAt: d.opened_at,
    dueAt: d.due_at,
    overdue: !!d.due_at && new Date(d.due_at).getTime() < Date.now(),
  }));
  if (!partyId) return rows;
  return rows.filter((d) => d.debtorId === partyId || d.creditorId === partyId);
}

export const AGING_BUCKETS = ["current", "1-7", "8-30", "31-60", "60+"];

export function agingBucketOf(dueAt) {
  if (!dueAt) return "current";
  const days = Math.floor((Date.now() - new Date(dueAt).getTime()) / 86400000);
  if (days <= 0) return "current";
  if (days <= 7) return "1-7";
  if (days <= 30) return "8-30";
  if (days <= 60) return "31-60";
  return "60+";
}

/** Totals per currency, never summed across currencies. */
export function summarizeDebts(debts, zemanIsDebtor = (d) => d.debtorType === "zeman") {
  const out = { weOwe: {}, owedToUs: {}, byBucket: {}, currencies: [] };
  for (const d of debts || []) {
    const target = zemanIsDebtor(d) ? out.weOwe : out.owedToUs;
    target[d.currency] = (target[d.currency] || 0) + d.outstanding;
    const bucket = agingBucketOf(d.dueAt);
    out.byBucket[bucket] = out.byBucket[bucket] || {};
    out.byBucket[bucket][d.currency] = (out.byBucket[bucket][d.currency] || 0) + d.outstanding;
    if (!out.currencies.includes(d.currency)) out.currencies.push(d.currency);
  }
  out.currencies.sort();
  return out;
}

export async function loadTrialBalance(client) {
  const { data, error } = await client.rpc("sarraf_trial_balance_check");
  if (error) throw error;
  return {
    baseDebit: Number(data?.base_debit) || 0,
    baseCredit: Number(data?.base_credit) || 0,
    difference: Number(data?.difference) || 0,
    balanced: data?.balanced === true,
    entryCount: Number(data?.entry_count) || 0,
    checkedAt: data?.checked_at || null,
  };
}

export async function loadSubledgerReconciliation(client) {
  const { data, error } = await client.rpc("sarraf_subledger_reconciliation");
  if (error) throw error;
  return data || {};
}

/** Partner balance is never allowed to go negative; excess disbursement becomes explicit debt. */
export async function disbursePartnerFunds(client, {
  partnerId, currency, amount, rate, transactionId = null, reason: why, commandKey,
}) {
  const value = positive(amount);
  if (!partnerId) throw new Error("هاوبەش پێویستە");
  if (!value) throw new Error("بڕ دەبێت لە سفر گەورەتر بێت");
  const text = reason(why);
  if (text.length < 3) throw new Error("هۆکار پێویستە");
  const key = commandKey || accountingCommandKey("partner-disburse", partnerId);
  return {
    result: await callCommand(client, "sarraf_partner_disburse", {
      p_partner_id: partnerId,
      p_currency: upper(currency),
      p_amount: value,
      p_rate: requireRateFor(currency, rate),
      p_transaction_id: transactionId || null,
      p_reason: text,
      p_command_key: key,
    }),
    commandKey: key,
  };
}

/** New partner credit clears oldest matching debt first; only the remainder becomes available. */
export async function creditPartnerFunds(client, {
  partnerId, currency, amount, rate, reason: why, commandKey,
}) {
  const value = positive(amount);
  if (!partnerId) throw new Error("هاوبەش پێویستە");
  if (!value) throw new Error("بڕ دەبێت لە سفر گەورەتر بێت");
  const text = reason(why);
  if (text.length < 3) throw new Error("هۆکار پێویستە");
  const key = commandKey || accountingCommandKey("partner-credit", partnerId);
  return {
    result: await callCommand(client, "sarraf_partner_credit", {
      p_partner_id: partnerId,
      p_currency: upper(currency),
      p_amount: value,
      p_rate: requireRateFor(currency, rate),
      p_reason: text,
      p_command_key: key,
    }),
    commandKey: key,
  };
}

export async function loadPartnerAccounts(client, partnerId = null) {
  let query = client.from("partner_accounts").select("*").order("currency");
  if (partnerId) query = query.eq("partner_id", partnerId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    partnerId: row.partner_id,
    currency: row.currency,
    available: Number(row.available) || 0,
    reserved: Number(row.reserved) || 0,
    lastEventAt: row.last_event_at,
  }));
}

/** Latest immutable manual rate per currency, under the single 1 USD = X convention. */
export async function loadDailyAccountingRates(client, effectiveDate = new Date().toISOString().slice(0, 10)) {
  const { data, error } = await client.from("receipt_daily_rates")
    .select("currency,effective_date,rate_value,version")
    .lte("effective_date", effectiveDate)
    .order("effective_date", { ascending: false })
    .order("version", { ascending: false });
  if (error) throw error;
  const rates = { USD: { value: 1, effectiveDate, version: 1 } };
  for (const row of data || []) {
    if (rates[row.currency]) continue;
    const value = Number(row.rate_value);
    if (value > 0) rates[row.currency] = {
      value,
      effectiveDate: row.effective_date,
      version: Number(row.version) || 1,
    };
  }
  return rates;
}

/**
 * Every movement behind one currency's balance, with the running total after each.
 *
 * The owner reported a CNY cashbox that goes negative for no visible reason. It is not one bad
 * transaction: the cashbox figure is a residual — every ledger row naming no partner — and
 * nothing constrains a residual to stay positive. Mirrors public.sarraf_explain_balance.
 *
 * `holder` is "owner", "partner" (with holderId) or "all".
 */
export async function explainBalance(client, currencyId, { holder = "owner", holderId = null, limit = 500 } = {}) {
  const { data, error } = await client.rpc("sarraf_explain_balance", {
    p_cur_id: currencyId, p_holder: holder, p_holder_id: holderId, p_limit: limit,
  });
  if (error) throw error;
  return (data || []).map((r) => ({
    seq: Number(r.seq),
    ledgerId: r.ledger_id,
    movedAt: r.moved_at,
    entryType: r.entry_type,
    amount: Number(r.amount),
    runningBalance: Number(r.running_balance),
    wentNegative: r.went_negative === true,
    partnerId: r.partner_id || null,
    partnerName: r.partner_name || null,
    txId: r.tx_id || null,
    note: r.note || null,
  }));
}

/** Which movement took a balance below zero first, or a plain "it never did". */
export async function firstNegativeMovement(client, currencyId, { holder = "owner", holderId = null } = {}) {
  const { data, error } = await client.rpc("sarraf_balance_first_negative", {
    p_cur_id: currencyId, p_holder: holder, p_holder_id: holderId,
  });
  if (error) throw error;
  const answer = data || {};
  return {
    currency: answer.currency || currencyId,
    holder: answer.holder || holder,
    everNegative: answer.ever_negative === true,
    finalBalance: Number(answer.final_balance ?? 0),
    firstNegative: answer.first_negative
      ? {
        seq: Number(answer.first_negative.seq),
        ledgerId: answer.first_negative.ledger_id,
        movedAt: answer.first_negative.moved_at,
        entryType: answer.first_negative.entry_type,
        amount: Number(answer.first_negative.amount),
        balanceAfter: Number(answer.first_negative.balance_after),
        txId: answer.first_negative.transaction || null,
        partnerName: answer.first_negative.partner || null,
        note: answer.first_negative.note || null,
      }
      : null,
  };
}

/**
 * A service the business performs for a fee — not a currency trade (§3).
 *
 * The owner's example: one million leaves the FIB account, one million arrives in the safe, and
 * three thousand is charged for doing it. FIB is an example; any account a business holds money
 * in behaves this way. Mirrors public.sarraf_service_transaction.
 *
 * Principal and commission are kept apart all the way through — there is deliberately no
 * combined total, because they are not the same kind of money.
 */
export async function recordService(client, {
  id, accountId, direction = "into_safe", amount, commission = 0,
  commissionCollected = true, customerId = null, description = "", commandKey,
}) {
  const { data, error } = await client.rpc("sarraf_service_transaction", {
    p_id: id,
    p_cash_account_id: accountId,
    p_direction: direction,
    p_amount: amount,
    p_commission: commission,
    p_commission_collected: commissionCollected,
    p_customer_id: customerId,
    p_description: description,
    p_command_key: commandKey,
  });
  if (error) throw error;
  const answer = data || {};
  return {
    id: answer.id,
    accountId: answer.account,
    accountName: answer.account_name,
    direction: answer.direction,
    currency: answer.currency,
    principal: Number(answer.principal ?? 0),
    commission: Number(answer.commission ?? 0),
    commissionCollected: answer.commission_collected === true,
    commissionReceivable: Number(answer.commission_receivable ?? 0),
    entryId: answer.entry_id || null,
    commissionEntryId: answer.commission_entry_id || null,
    replayed: answer.replayed === true,
  };
}

/** The places this business holds money that are not the main safe, and what is in each. */
export async function loadCashAccounts(client) {
  const { data, error } = await client.rpc("sarraf_cash_account_balances");
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    currencyId: r.cur_id,
    active: r.active === true,
    balance: Number(r.balance ?? 0),
  }));
}

/** Open one. */
export async function openCashAccount(client, { id, name, currencyId, kind = "bank", note = null }) {
  const { data, error } = await client.rpc("sarraf_open_cash_account", {
    p_id: id, p_name: name, p_cur_id: currencyId, p_kind: kind, p_note: note,
  });
  if (error) throw error;
  return data || null;
}
