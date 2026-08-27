import test from "node:test";
import assert from "node:assert/strict";
import { loadWholeTable, DEFAULT_PAGE_SIZE } from "../src/services/tableLoader.js";

/**
 * The loader that decides whether the dashboard opens at all.
 *
 * It lived as a closure inside App.jsx, where nothing could reach it, and it carried two faults:
 * a load that failed whenever anybody else wrote a row, and no upper bound at all.
 */

// A Supabase-shaped table that can be told to grow midway through being read, the way a real
// one does when a customer sends a receipt while the owner is signing in.
function fakeTable(rows, { growBy = 0, growAfterPage = 1, countOverride = null } = {}) {
  let served = 0;
  const live = [...rows];
  return {
    from() {
      return {
        select(_cols, opts) {
          if (opts?.head) {
            return Promise.resolve({ count: countOverride ?? live.length, error: null });
          }
          const chain = {
            range(from, to) {
              chain._from = from; chain._to = to;
              return chain;
            },
            order() { return chain; },
            then(resolve) {
              const page = live.slice(chain._from, chain._to + 1);
              served += 1;
              if (growBy && served === growAfterPage) {
                for (let i = 0; i < growBy; i += 1) live.push({ id: `new-${i}` });
              }
              resolve({ data: page, error: null });
            },
          };
          return chain;
        },
      };
    },
  };
}

const rows = (n, prefix = "r") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

test("a table that fits comes back whole", async () => {
  const out = await loadWholeTable(fakeTable(rows(120)), "ledger", { pageSize: 50 });
  assert.equal(out.error, null);
  assert.equal(out.data.length, 120);
  assert.equal(out.truncated, false);
});

test("an empty table is not an error", async () => {
  const out = await loadWholeTable(fakeTable([]), "ledger", { pageSize: 50 });
  assert.equal(out.error, null);
  assert.deepEqual(out.data, []);
});

// The lockout. `ledger` and `txs` are append-only, so a count that has grown means somebody else
// wrote a row — normal activity, not corruption — and the new row sorted last and came along
// with the final page anyway.
test("a row written by somebody else during the load does not lock the owner out", async () => {
  const out = await loadWholeTable(
    fakeTable(rows(100), { growBy: 3, growAfterPage: 1 }), "ledger", { pageSize: 50 });
  assert.equal(out.error, null, "a busy business could not open its own books");
  assert.ok(out.data.length >= 100, "rows that existed at the start went missing");
});

// The guarantee that must survive: never hand back a partial view of the money.
test("a genuinely short read is refused rather than shown", async () => {
  // The count says 500 and the table only ever serves 100. Nothing may be returned.
  const out = await loadWholeTable(
    fakeTable(rows(100), { countOverride: 500 }), "ledger", { pageSize: 50, maxAttempts: 2 });
  assert.equal(out.data, null, "three quarters of the ledger was passed off as all of it");
  assert.match(String(out.error.message), /ledger/);
});

test("a failed page is reported, not silently dropped", async () => {
  const broken = { from: () => ({ select: (_c, o) => o?.head
    ? Promise.resolve({ count: 10, error: null })
    : { range() { return this; }, order() { return this; },
        then(resolve) { resolve({ data: null, error: new Error("network") }); } } }) };
  const out = await loadWholeTable(broken, "txs", { pageSize: 5 });
  assert.equal(out.data, null);
  assert.equal(out.error.message, "network");
});

// No upper bound at all meant a business two years in downloads every row it has ever written,
// on every sign-in, onto a phone.
test("a table too large to load stops, and says that it stopped", async () => {
  const out = await loadWholeTable(fakeTable(rows(4000)), "txs", { pageSize: 100, ceiling: 300 });
  assert.equal(out.error, null);
  assert.equal(out.truncated, true, "the ceiling was crossed in silence");
  assert.ok(out.data.length <= 400, `loaded ${out.data.length} rows past a ceiling of 300`);
});

test("a table that fits is never reported as truncated", async () => {
  const out = await loadWholeTable(fakeTable(rows(50)), "txs", { pageSize: 100, ceiling: 300 });
  assert.equal(out.truncated, false);
});

test("the page size the application relies on has not moved", () => {
  assert.equal(DEFAULT_PAGE_SIZE, 500);
});
