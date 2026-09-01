import test from "node:test";
import assert from "node:assert/strict";
import {
  findingText, gapText, loadBooksReconciliation, loadGaps, summarise,
} from "../src/services/booksReconciliation.js";

const clean = () => ({
  agreed: true, transactions: 40, posted: 40,
  missing_entries: 0, unvalued_entries: 0, orphan_entries: 0,
  ledger_rows: 120, ledger_rows_without_entry: 0,
  trial_balance: { balanced: true, difference: 0, entry_count: 40 },
  checked_at: "2026-08-13T10:00:00Z",
});

test("books that agree report no findings", () => {
  const s = summarise(clean());
  assert.equal(s.agreed, true);
  assert.deepEqual(s.findings, []);
  assert.equal(s.balanced, true);
});

// A green light with an asterisk is how a real divergence gets ignored for a year.
test("a single missing entry withholds the verdict", () => {
  const s = summarise({ ...clean(), agreed: false, missing_entries: 1 });
  assert.equal(s.agreed, false);
  assert.equal(s.findings.length, 1);
  assert.equal(s.findings[0].code, "missing_entries");
  assert.equal(s.findings[0].count, 1);
});

test("each kind of divergence is reported on its own", () => {
  const s = summarise({
    ...clean(), agreed: false,
    missing_entries: 2, unvalued_entries: 3, orphan_entries: 1, ledger_rows_without_entry: 4,
  });
  assert.deepEqual(s.findings.map((f) => f.code).sort(),
    ["ledger_rows_without_entry", "missing_entries", "orphan_entries", "unvalued_entries"]);
  assert.equal(s.findings.find((f) => f.code === "unvalued_entries").count, 3);
});

test("an unbalanced trial balance is a finding with the difference attached", () => {
  const s = summarise({
    ...clean(), agreed: false,
    trial_balance: { balanced: false, difference: -12.5 },
  });
  assert.equal(s.balanced, false);
  const f = s.findings.find((x) => x.code === "trial_balance");
  assert.equal(f.difference, -12.5);
});

// The server's verdict is authoritative; a local "looks fine" must never override it.
test("the server saying no is never overridden by a clean-looking count", () => {
  const s = summarise({ ...clean(), agreed: false });
  assert.equal(s.agreed, false);
});

// "Not measured" and "measured as none" are different claims.
test("a count the server did not return is left out rather than reported as zero", () => {
  const raw = { ...clean() };
  raw.ledger_rows = null;
  raw.ledger_rows_without_entry = null;
  const s = summarise(raw);
  assert.equal(s.ledgerRows, null);
  assert.equal(s.findings.length, 0, "an unmeasured count is not a finding");
  assert.equal(s.agreed, true);
});

test("a missing trial balance reads as unknown, not as balanced", () => {
  const s = summarise({ ...clean(), agreed: false, trial_balance: null });
  assert.equal(s.balanced, null);
  assert.equal(s.findings.length, 0, "unknown is not the same as a failure");
  assert.equal(s.agreed, false, "but the server's verdict still stands");
});

test("an empty answer does not read as agreement", () => {
  const s = summarise(null);
  assert.equal(s.agreed, false);
  assert.equal(s.transactions, 0);
});

test("every finding and gap code reads as plain language", () => {
  for (const code of ["missing_entries", "unvalued_entries", "orphan_entries",
                      "ledger_rows_without_entry", "trial_balance"]) {
    assert.notEqual(findingText(code), code, `${code} needs readable text`);
  }
  for (const code of ["no_journal_entry", "entry_unvalued", "entry_reversed"]) {
    assert.notEqual(gapText(code), code, `${code} needs readable text`);
  }
});

test("an unknown code still reads as something rather than blank", () => {
  assert.equal(gapText("some_new_gap"), "some_new_gap");
});

// ── the bindings ─────────────────────────────────────────────────────────────

test("a server refusal is raised, never reported as agreement", async () => {
  const client = { rpc: async () => ({ data: null, error: { message: "only an administrator may reconcile the books" } }) };
  await assert.rejects(() => loadBooksReconciliation(client));
});

test("the reconciliation is read through its own command", async () => {
  const calls = [];
  const client = { rpc: async (fn) => { calls.push(fn); return { data: clean(), error: null }; } };
  const s = await loadBooksReconciliation(client);
  assert.deepEqual(calls, ["sarraf_ledger_journal_reconciliation"]);
  assert.equal(s.agreed, true);
});

test("the gaps behind a count come back named, so they can be fixed", async () => {
  const client = {
    from: () => ({
      select: () => ({ order: () => ({ limit: () => Promise.resolve({
        data: [{ transaction_id: "t1", code: 12, date: "2026-08-01", transaction_status: "completed",
                 journal_status: "missing", gap: "no_journal_entry" }],
        error: null }) }) }),
    }),
  };
  const [row] = await loadGaps(client);
  assert.equal(row.transactionId, "t1");
  assert.equal(row.text, gapText("no_journal_entry"));
  assert.notEqual(row.text, row.gap, "the operator sees language, not a code");
});

/**
 * A gap the operator can close.
 *
 * The live database carried two entries from 27 and 28 August: completed trades whose journal
 * entry was written as a draft because the currency had no USD rate that day. Nothing in the
 * system could ever finish one — the posting trigger runs once per transaction and refuses to
 * act if an entry already exists — so the money stayed out of the books indefinitely.
 *
 * Only an unvalued entry can be closed from the reconciliation screen. A transaction with no
 * entry at all, or one whose entry was reversed, is a different problem with a different answer,
 * and offering the same button for all three would be offering to do the wrong thing.
 */
const gapRows = () => ([
  { transaction_id: "tx-1", code: 1, date: "2026-08-27", transaction_status: "completed",
    journal_status: "draft", gap: "entry_unvalued", entry_id: "je-tx-tx-1" },
  { transaction_id: "tx-2", code: 2, date: "2026-08-26", transaction_status: "completed",
    journal_status: "missing", gap: "no_journal_entry", entry_id: null },
  { transaction_id: "tx-3", code: 3, date: "2026-08-25", transaction_status: "completed",
    journal_status: "reversed", gap: "entry_reversed", entry_id: "je-tx-tx-3" },
]);

const gapClient = (rows) => ({
  from: () => ({
    select: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }),
  }),
});

test("only an unvalued entry offers to be finished", async () => {
  const gaps = await loadGaps(gapClient(gapRows()));
  assert.deepEqual(gaps.map((g) => g.canFinish), [true, false, false]);
});

test("the entry id travels with the gap, or there is nothing to act on", async () => {
  const gaps = await loadGaps(gapClient(gapRows()));
  assert.equal(gaps[0].entryId, "je-tx-tx-1");
  assert.equal(gaps[1].entryId, null);
});

test("finishing an entry sends the entry and its command key, and nothing else", async () => {
  const { finishUnvaluedEntry } = await import("../src/services/booksReconciliation.js");
  const seen = [];
  const client = { rpc: async (name, args) => { seen.push([name, args]); return { data: { status: "posted" }, error: null }; } };
  const out = await finishUnvaluedEntry(client, "je-tx-tx-1", "finish-draft:je-tx-tx-1:1");
  assert.equal(out.status, "posted");
  assert.deepEqual(seen, [["sarraf_resolve_journal_draft", {
    p_entry_id: "je-tx-tx-1", p_command_key: "finish-draft:je-tx-tx-1:1",
  }]]);
});

test("a refusal from the database is raised, not swallowed into a success", async () => {
  const { finishUnvaluedEntry } = await import("../src/services/booksReconciliation.js");
  const client = { rpc: async () => ({ data: null, error: new Error("no USD rate for this currency yet") }) };
  await assert.rejects(() => finishUnvaluedEntry(client, "je-1", "k"), /no USD rate/);
});

test("the reason a transaction is missing from the books is readable in all three languages", () => {
  for (const lang of ["ku", "en", "ar"]) {
    for (const code of ["no_journal_entry", "entry_unvalued", "entry_reversed"]) {
      const text = gapText(code, lang);
      assert.notEqual(text, code, `${code} is untranslated in ${lang}`);
    }
    for (const code of ["missing_entries", "unvalued_entries", "orphan_entries",
                        "ledger_rows_without_entry", "trial_balance"]) {
      assert.notEqual(findingText(code, lang), code, `${code} is untranslated in ${lang}`);
    }
  }
});

test("an unknown code is shown as itself rather than as an empty line", () => {
  assert.equal(gapText("something_new", "en"), "something_new");
  assert.equal(findingText("something_new", "ar"), "something_new");
});
