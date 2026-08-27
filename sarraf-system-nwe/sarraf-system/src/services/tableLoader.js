/**
 * Reading a whole table, completely or not at all.
 *
 * Every figure on the dashboard is computed in the browser from `ledger` and `txs`. A view
 * computed from three quarters of the ledger is not a smaller answer, it is a wrong one — so
 * this either returns every row or it returns an error, and it has never been willing to hand
 * back a partial page. That part is right and is kept exactly as it was.
 *
 * Two things about it were not right, and neither is about the figures.
 *
 * ── a busy business could not sign in ────────────────────────────────────────
 *
 * Completeness was checked as
 *
 *     if (data.length === expected) return ...
 *
 * where `expected` is a COUNT taken before paging began. `ledger` and `txs` are append-only, so
 * the only way that equality can fail on a healthy database is that somebody ELSE wrote a row
 * while the load was running — a customer sending a receipt, a partner being paid, an
 * administrator recording a sale. On a one-person installation that never happens. On a busy
 * exchange it happens constantly, and the result was: retry once, fail again, throw, and the
 * dashboard refuses to open. Normal activity by other people locked the owner out of their own
 * books.
 *
 * A row appended during the load sorts last and is therefore already included in the final page.
 * So `>= expected` is the correct test: it says "nothing that existed when I started is missing".
 * It is strictly weaker than `===` only in the case where a row is DELETED mid-load and another
 * is missed — and neither of these tables allows a delete at all (`ledger_append_only`, and
 * `txs` is soft-deleted by a flag).
 *
 * ── it would page forever ────────────────────────────────────────────────────
 *
 * There is no upper bound. A business two years in with forty thousand transactions downloads
 * every one of them, in 500-row pages, into a phone, on every sign-in and every refresh. That is
 * not wrong today and it is not survivable later, so there is a ceiling — and, because a
 * truncated financial view must never be mistaken for a complete one, hitting the ceiling is
 * reported rather than absorbed. The caller decides what to say about it; this only refuses to
 * lie about it.
 */

export const DEFAULT_PAGE_SIZE = 500;

/** Beyond this, a phone is not the right place to compute a balance sheet. */
export const DEFAULT_CEILING = 50000;

/**
 * @returns {{data: array|null, error: Error|null, expected: number, loaded: number,
 *            truncated: boolean}}
 */
export async function loadWholeTable(client, table, {
  orders = [], pageSize = DEFAULT_PAGE_SIZE, maxAttempts = 2, ceiling = DEFAULT_CEILING,
} = {}) {
  let lastMismatch = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const countRes = await client.from(table).select("*", { count: "exact", head: true });
    if (countRes.error) return { data: null, error: countRes.error, expected: 0, loaded: 0, truncated: false };
    const expected = Number(countRes.count ?? 0);

    const byId = new Map();
    let from = 0;
    let truncated = false;

    while (true) {
      let q = client.from(table).select("*").range(from, from + pageSize - 1);
      for (const order of orders) {
        q = q.order(order.column, { ascending: order.ascending !== false });
      }

      const page = await q;
      if (page.error) return { data: null, error: page.error, expected, loaded: byId.size, truncated: false };
      const rows = page.data || [];
      for (const row of rows) {
        const key = row?.id ?? `${from}:${byId.size}`;
        byId.set(String(key), row);
      }

      if (rows.length < pageSize) break;
      from += pageSize;
      if (from >= ceiling) { truncated = true; break; }
    }

    const data = [...byId.values()];
    // Everything that existed when this started. More than that is somebody else's new row,
    // which sorted last and came along with the final page.
    if (truncated || data.length >= expected) {
      return { data, error: null, expected, loaded: data.length, truncated };
    }

    lastMismatch = new Error(
      `${table} changed while loading (${data.length}/${expected}); retrying for a consistent financial view`
    );
  }

  return {
    data: null,
    error: lastMismatch || new Error(`${table} could not be loaded completely`),
    expected: 0,
    loaded: 0,
    truncated: false,
  };
}
