/**
 * Enough of PostgREST to run the real application against a real database.
 *
 * Every browser check this repository had stubbed the server: it answered each query with a
 * fixture and never executed a line of the database. That is the right way to test what a role
 * may SEE, and it is exactly the wrong way to test whether a command works — because a stub
 * answers whatever the browser asks, including a call with a missing argument, a wrong name, or
 * arguments in the wrong order.
 *
 * Which is what kept happening. `p_command_key` arrived as undefined and the send failed for
 * every uploader for days. `intake_status` was never sent and every receipt was recorded as
 * rejected. Neither is visible to a stub, and neither is visible to a database test, because
 * between them sits the one thing nobody was testing: the browser actually forming the call.
 *
 * So this translates the HTTP the Supabase client speaks into SQL against a real PostgreSQL,
 * as the role a browser connects as, with the caller's own JWT subject in the session. If the
 * browser sends a call the database will not accept, it fails here exactly as it fails in life.
 *
 * It is not PostgREST. It covers what this application sends and refuses the rest loudly rather
 * than inventing an answer — a shim that silently returns `[]` for a query it did not understand
 * would put us straight back where we started.
 */

/** Values arrive as JSON; they leave as SQL literals of unknown type, which Postgres coerces. */
const literal = (value) => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const tag = `x${Math.random().toString(36).slice(2, 8)}`;
  return `$${tag}$${text}$${tag}$`;
};

/**
 * One line, always.
 *
 * `json_agg(...)::text` puts a real newline between elements, and the runner reads a psql result
 * by taking its last line — so a two-row answer arrived at the browser as the second row and a
 * closing bracket. The client then reported the fragment as an error message and the screen sat
 * on «بارکردنی داتا...» for ever. A raw newline can only be that formatting: JSON writes a
 * newline inside a string as the two characters `\n`, never as a byte.
 */
const oneLine = (expr) => `replace(coalesce(${expr}, '[]'), chr(10), '')`;
const jsonRows = (select) => `select ${oneLine(`json_agg(t)::text`)} from (${select}) t`;

/** Whether a function returns a set, asked once and remembered. */
const setReturning = new Map();
function returnsSet(fn, run) {
  if (setReturning.has(fn)) return setReturning.get(fn);
  const raw = run(
    `select coalesce(bool_or(p.proretset), false)::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = ${literal(fn)}`).trim();
  // `bool::text` prints `true`, while a bare boolean column prints `t`. Both mean the same and
  // reading only one of them is how every set-returning function was called the wrong way.
  const answer = ["t", "true"].includes(raw);
  setReturning.set(fn, answer);
  return answer;
}

/** `?column=eq.value&other=in.(a,b)` → a WHERE clause, and nothing it does not recognise. */
function whereFrom(params, unsupported) {
  const clauses = [];
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
    const [op, ...rest] = String(raw).split(".");
    const value = rest.join(".");
    const column = `"${key.replace(/"/g, "")}"`;
    if (op === "eq") clauses.push(`${column} = ${literal(value)}`);
    else if (op === "neq") clauses.push(`${column} <> ${literal(value)}`);
    else if (op === "gt") clauses.push(`${column} > ${literal(value)}`);
    else if (op === "gte") clauses.push(`${column} >= ${literal(value)}`);
    else if (op === "lt") clauses.push(`${column} < ${literal(value)}`);
    else if (op === "lte") clauses.push(`${column} <= ${literal(value)}`);
    else if (op === "is") clauses.push(`${column} is ${value === "null" ? "null" : value}`);
    else if (op === "in") {
      const items = value.replace(/^\(|\)$/g, "").split(",")
        .map((v) => literal(v.replace(/^"|"$/g, "")));
      clauses.push(items.length ? `${column} in (${items.join(",")})` : "false");
    } else unsupported.push(`${key}=${raw}`);
  }
  return clauses.length ? `where ${clauses.join(" and ")}` : "";
}

function orderFrom(params) {
  const order = params.get("order");
  if (!order) return "";
  const parts = order.split(",").map((piece) => {
    const [column, ...flags] = piece.split(".");
    const desc = flags.includes("desc");
    const nulls = flags.includes("nullslast") ? " nulls last"
      : flags.includes("nullsfirst") ? " nulls first" : "";
    return `"${column.replace(/"/g, "")}" ${desc ? "desc" : "asc"}${nulls}`;
  });
  return parts.length ? `order by ${parts.join(", ")}` : "";
}

/**
 * @param {(sql: string) => string} run  executes SQL as the caller and returns the last line
 * @returns {{status:number, body:string, headers:object}}
 */
export function handleRequest({ method, url, headers = {}, body = null, run }) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const params = [...parsed.searchParams.entries()];
  const search = parsed.searchParams;
  const unsupported = [];

  const reply = (payload, { status = 200, count = null } = {}) => ({
    status,
    headers: {
      "content-type": "application/json",
      "content-range": count === null ? "*/*" : `0-${Math.max(count - 1, 0)}/${count}`,
      "access-control-expose-headers": "content-range",
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

  // ── a command ──────────────────────────────────────────────────────────────
  const rpc = path.match(/\/rest\/v1\/rpc\/([a-z0-9_]+)$/i);
  if (rpc) {
    const fn = rpc[1];
    const args = body ? JSON.parse(body) : {};
    const named = Object.entries(args)
      .map(([key, value]) => `${key} := ${literal(value)}`)
      .join(", ");
    try {
      // A function that returns a set comes back from PostgREST as an array; one that returns a
      // single value comes back as that value. Asking the catalogue rather than guessing is what
      // stops `select (select f())` failing with "more than one row returned by a subquery" on
      // every `returns table` function the application has — which is most of the read models.
      const out = returnsSet(fn, run)
        ? run(jsonRows(`select * from public.${fn}(${named})`))
        : run(`select replace(coalesce((select public.${fn}(${named}))::text, 'null'), chr(10), '')`);
      return reply(out === "" ? "null" : out);
    } catch (e) {
      return reply(errorBody(e), { status: 400 });
    }
  }

  const table = path.match(/\/rest\/v1\/([a-z0-9_]+)$/i);
  if (!table) return reply({ message: `this shim does not serve ${path}` }, { status: 501 });
  const name = table[1];

  try {
    // ── how many rows are there ──────────────────────────────────────────────
    const wantsCount = /count=exact/i.test(headers.prefer || headers.Prefer || "");
    if (method === "HEAD" || (wantsCount && method === "GET" && headers.range === undefined)) {
      const where = whereFrom(params, unsupported);
      refuseUnsupported(unsupported, name);
      const total = Number(run(`select count(*) from public."${name}" ${where}`)) || 0;
      if (method === "HEAD") return reply("", { count: total });
    }

    if (method === "GET") {
      const where = whereFrom(params, unsupported);
      refuseUnsupported(unsupported, name);
      let limit = "";
      const range = headers.range;
      if (range) {
        const [from, to] = String(range).split("-").map(Number);
        if (Number.isFinite(from) && Number.isFinite(to)) limit = `offset ${from} limit ${to - from + 1}`;
      } else if (search.get("limit")) {
        limit = `limit ${Number(search.get("limit")) || 0}`;
      }
      const rows = run(jsonRows(
        `select * from public."${name}" ${where} ${orderFrom(search)} ${limit}`));
      const parsedRows = JSON.parse(rows || "[]");
      const total = Number(run(`select count(*) from public."${name}" ${where}`)) || 0;
      // Supabase-js returns a single object rather than an array when asked for one.
      const single = /vnd\.pgrst\.object/.test(headers.accept || "");
      if (single) return reply(parsedRows[0] ?? null, { count: total });
      return reply(parsedRows, { count: total });
    }

    if (method === "POST") {
      const rows = body ? JSON.parse(body) : [];
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length) return reply([], { count: 0 });
      const columns = [...new Set(list.flatMap((row) => Object.keys(row)))];
      const values = list.map((row) =>
        `(${columns.map((c) => literal(row[c] ?? null)).join(",")})`).join(",");
      const conflict = search.get("on_conflict")
        ? `on conflict ("${search.get("on_conflict")}") do nothing` : "";
      const out = run(jsonRows(
        `insert into public."${name}" (${columns.map((c) => `"${c}"`).join(",")})
         values ${values} ${conflict} returning *`));
      return reply(out || "[]", { count: list.length });
    }

    if (method === "PATCH") {
      const patch = body ? JSON.parse(body) : {};
      const sets = Object.entries(patch)
        .map(([key, value]) => `"${key}" = ${literal(value)}`).join(", ");
      const where = whereFrom(params, unsupported);
      refuseUnsupported(unsupported, name);
      if (!sets) return reply([], { count: 0 });
      const out = run(jsonRows(`update public."${name}" set ${sets} ${where} returning *`));
      return reply(out || "[]");
    }

    if (method === "DELETE") {
      const where = whereFrom(params, unsupported);
      refuseUnsupported(unsupported, name);
      const out = run(jsonRows(`delete from public."${name}" ${where} returning *`));
      return reply(out || "[]");
    }
  } catch (e) {
    return reply(errorBody(e), { status: 400 });
  }

  return reply({ message: `this shim does not serve ${method} ${path}` }, { status: 501 });
}

/** A query this shim did not understand is a hole in the test, and it says so. */
function refuseUnsupported(unsupported, table) {
  if (unsupported.length) {
    throw new Error(
      `the shim does not understand ${unsupported.join(", ")} on ${table}; `
      + "answering it anyway would test nothing");
  }
}

/**
 * PostgREST's error shape, so the client's own handling is exercised too.
 *
 * The code matters more than the words: the send decides whether to replay through the server
 * route by asking whether the refusal was 42501. A runner that loses the SQLSTATE turns every
 * refusal into the same unrecognised failure, and the path the application actually takes in
 * life would never be walked here.
 */
function errorBody(e) {
  const text = String(e?.message || e);
  const code = e?.code || text.match(/\b([0-9A-Z]{5})\b/)?.[1] || "P0001";
  const message = text.split("\n").find((l) => /ERROR:/.test(l))?.replace(/^.*ERROR:\s*/, "")
    || text.slice(0, 300);
  return { code, message, details: null, hint: null };
}
