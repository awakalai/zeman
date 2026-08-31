/**
 * Do the legacy ledger and the double-entry journal agree? (§12)
 *
 * The system keeps two records of the same money. That is only safe while they agree, and
 * nothing was checking. This reads the server's answer and turns it into something an operator
 * can act on: not a score, but a list of what is wrong and what it means.
 *
 * "Agreed" is treated as all-or-nothing on purpose. A set of books is either reconciled or it
 * is not; "mostly reconciled" is not a state, and a green light with an asterisk is how a real
 * divergence gets ignored for a year.
 */

export const GAP = Object.freeze({
  ku: {
    no_journal_entry: "مامەڵەکە تۆمار کراوە بەڵام نەگەیشتووەتە دەفتەری ژمێریاری",
    entry_unvalued: "بە دۆلار هەڵنەسەنگێندراوە — نرخی دراوەکە دانەنراوە",
    entry_reversed: "تۆمارەکەی پێچەوانە کراوەتەوە",
  },
  en: {
    no_journal_entry: "Recorded as a transaction but it never reached the journal",
    entry_unvalued: "Not valued in dollars — the currency had no rate",
    entry_reversed: "Its entry was reversed",
  },
  ar: {
    no_journal_entry: "سُجّلت كمعاملة لكنها لم تصل إلى دفتر القيد",
    entry_unvalued: "لم تُقيَّم بالدولار — لم يكن للعملة سعر",
    entry_reversed: "تم عكس قيدها",
  },
});
export const gapText = (code, lang = "ku") => (GAP[lang] || GAP.ku)[code] || code;

export const FINDING = Object.freeze({
  ku: {
    missing_entries: "مامەڵە بێ تۆماری ژمێریاری",
    unvalued_entries: "تۆماری هەڵنەسەنگێندراو",
    orphan_entries: "تۆماری بێ مامەڵە",
    ledger_rows_without_entry: "ڕیزی دەفتەری کۆن بێ تۆماری ژمێریاری",
    trial_balance: "دەفتەر هاوسەنگ نییە",
  },
  en: {
    missing_entries: "Transactions with no journal entry",
    unvalued_entries: "Entries that could not be valued",
    orphan_entries: "Entries with no transaction",
    ledger_rows_without_entry: "Old ledger rows with no journal entry",
    trial_balance: "The books do not balance",
  },
  ar: {
    missing_entries: "معاملات بلا قيد",
    unvalued_entries: "قيود تعذّر تقييمها",
    orphan_entries: "قيود بلا معاملة",
    ledger_rows_without_entry: "سطور دفتر قديم بلا قيد",
    trial_balance: "الدفاتر غير متوازنة",
  },
});
export const findingText = (code, lang = "ku") => (FINDING[lang] || FINDING.ku)[code] || code;

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function loadBooksReconciliation(client, lang = "ku") {
  const { data, error } = await client.rpc("sarraf_ledger_journal_reconciliation");
  if (error) throw error;
  return summarise(data, lang);
}

/**
 * Turns the server's counters into a verdict plus the findings behind it.
 *
 * A count the server did not return — because the legacy table is absent — is `null` and is
 * left out of the findings rather than reported as zero. "Not measured" and "measured as none"
 * are different claims.
 */
export function summarise(raw, lang = "ku") {
  const trial = raw?.trial_balance || null;
  const balanced = trial ? trial.balanced === true : null;

  const findings = [];
  for (const key of ["missing_entries", "unvalued_entries", "orphan_entries", "ledger_rows_without_entry"]) {
    const value = raw?.[key];
    if (value == null) continue;
    if (count(value) > 0) findings.push({ code: key, text: findingText(key, lang), count: count(value) });
  }
  if (balanced === false) {
    findings.push({
      code: "trial_balance",
      text: findingText("trial_balance", lang),
      count: 1,
      difference: trial?.difference == null ? null : Number(trial.difference),
    });
  }

  return {
    // The server's own verdict is authoritative; the local one only has to agree with it.
    agreed: raw?.agreed === true && findings.length === 0,
    findings,
    transactions: count(raw?.transactions),
    posted: count(raw?.posted),
    ledgerRows: raw?.ledger_rows == null ? null : count(raw.ledger_rows),
    balanced,
    difference: trial?.difference == null ? null : Number(trial.difference),
    checkedAt: raw?.checked_at || null,
  };
}

/** The transactions behind a "missing" or "unvalued" count, so the operator can go and fix them. */
export async function loadGaps(client, limit = 100, lang = "ku") {
  const { data, error } = await client
    .from("v_ledger_journal_gaps")
    .select("transaction_id,code,date,transaction_status,journal_status,gap,entry_id")
    .order("date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((r) => ({
    transactionId: r.transaction_id,
    code: r.code,
    date: r.date,
    transactionStatus: r.transaction_status,
    journalStatus: r.journal_status,
    gap: r.gap,
    entryId: r.entry_id,
    text: gapText(r.gap, lang),
    // The only gap an operator can close from here. A transaction with no entry at all, or one
    // that was reversed, is a different problem and needs a different answer.
    canFinish: r.gap === "entry_unvalued" && !!r.entry_id,
  }));
}

/**
 * Finish an entry that could not be valued when the trade happened.
 *
 * The command key is what makes a second press — or a retry after a lost response — the same
 * act rather than a second one. It is generated here, once per attempt, and reused if the caller
 * retries with the same one.
 */
export async function finishUnvaluedEntry(client, entryId, commandKey) {
  const { data, error } = await client.rpc("sarraf_resolve_journal_draft", {
    p_entry_id: entryId,
    p_command_key: commandKey,
  });
  if (error) throw error;
  return data;
}
