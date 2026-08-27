#!/usr/bin/env node
/**
 * The receipt's journey, in a real browser, against a real database.
 *
 * Every other gate in this repository tests one side of a line.
 *
 *   verify:flows      the commands, executed against a real PostgreSQL — but called by SQL
 *   verify:roles      the screens, in a real Chromium — but against a stub that answers anything
 *   npm test          the pure functions, and the source, read as text
 *
 * Nine faults this month lived exactly on the line between them, where nothing looked:
 *
 *   `p_command_key` arrived undefined, so PostgREST could not find a three-argument function
 *   with two arguments, and every send failed for every uploader for days
 *
 *   `intake_status` was never sent, so the command accepted nothing and each batch closed empty
 *   while the screen said "n فیش نێردرا ✓"
 *
 *   a free variable threw ReferenceError inside an event handler: no flash, no rows, nothing
 *
 * A stub cannot see any of them — it answers whatever the browser asks, including a call the
 * database would refuse. A database test cannot see them either, because it makes the call
 * itself, correctly, by hand. Only the browser forming the real call against the real database
 * shows them.
 *
 * So: the shipped bundle in Chromium, the real migrations in PostgreSQL, and between them a shim
 * that turns the HTTP the Supabase client speaks into SQL — as `authenticated`, with the caller's
 * own subject in the session. Auth and the OCR provider are stubbed, because neither is this
 * repository's code. Storage is not stubbed away: the object row is written exactly as the
 * storage service writes it, because the send reads that row back and refuses without it.
 *
 *   npm run verify:journey
 */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { postgresAvailable, PG_HINT, startDatabase } from "./lib/zeman-db.mjs";
import { handleRequest } from "./lib/postgrest-shim.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.ZEMAN_JOURNEY_PORT || 5211);
const BASE = `http://localhost:${PORT}`;
const envFile = path.join(root, ".env.e2e.local");

// The one receipt this journey carries. The reader returns these figures and the owner's screen
// must show them; keeping them in one place is what makes the owner-side check a real comparison
// rather than a second copy of the same guess.
const READING = { gross: "1246.30", fee: "36.30", net: "1210.00", currency: "CNY" };
const grouped = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CUSTOMER = "cccccccc-1111-1111-1111-111111111111";
const OWNER = "aaaaaaaa-1111-1111-1111-111111111111";

const results = [];
const record = (ok, name, detail = "") => results.push({ ok, name, detail });

let server = null;
let browser = null;
let db = null;
const stop = () => {
  try { if (server && !server.killed) process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
  try { rmSync(envFile, { force: true }); } catch { /* gone */ }
  try { db?.stop(); } catch { /* gone */ }
};
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const stubJwt = (authId) => [
  b64url({ alg: "HS256", typ: "JWT" }),
  b64url({
    sub: authId, aud: "authenticated", role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600, aal: "aal2",
    amr: [{ method: "password" }, { method: "totp" }],
  }),
  "stub-signature",
].join(".");

const loadPlaywright = async () => {
  const require = createRequire(import.meta.url);
  for (const spec of ["playwright", "/opt/node22/lib/node_modules/playwright/index.mjs"]) {
    try {
      if (spec.startsWith("/")) {
        if (!existsSync(spec)) continue;
        const loaded = await import(spec);
        return loaded.chromium ? loaded : loaded.default;
      }
      const loaded = await import(require.resolve(spec));
      return loaded.chromium ? loaded : loaded.default;
    } catch { /* try the next */ }
  }
  return null;
};

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].filter(Boolean);

const waitForServer = async (url, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};


const strict = process.env.CI === "true" || process.env.ZEMAN_JOURNEY_STRICT === "1";
const unavailable = (why) => {
  if (strict) { console.error(`${why} — the receipt journey cannot be driven, and this is CI.`); process.exit(1); }
  console.log(`${why} — the browser receipt journey is skipped.`);
  console.log("Set ZEMAN_JOURNEY_STRICT=1 to make this a failure instead.");
  process.exit(0);
};

if (!postgresAvailable()) unavailable(PG_HINT.split("\n")[0]);

try {
  // ── the database, from the real migrations ─────────────────────────────────
  db = startDatabase();
  const { psql } = db;

  // auth.uid() follows whoever the request carries, which is what it does in production.
  psql(`create or replace function auth.uid() returns uuid language sql stable
        as $fn$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $fn$;`);

  // One business, its owner, and a customer who sells to it. Seeded with the triggers off
  // because creating an account is itself a guarded command and that guard is not what this
  // gate is about.
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.app_users where auth_id in ('${OWNER}','${CUSTOMER}');
    insert into public.app_users(id,name,role,admin_level,auth_id,tenant_id) values
      ('jr-owner','خاوەن کار','admin','owner','${OWNER}','t-sarkhel'),
      ('jr-cus','کڕیار فرۆشیار','customer',null,'${CUSTOMER}','t-sarkhel')
    on conflict (id) do update set auth_id = excluded.auth_id, tenant_id = excluded.tenant_id;
    commit;`);

  /**
   * Every command the browser sends, run through one helper that reports the SQLSTATE.
   *
   * The code is what the client branches on: the send tries the command directly, is refused
   * with 42501 «not authorized by the ingestion service», and only then replays through the
   * server route. psql prints the message and not the code, so parsing its output would lose the
   * one field that decides which path the application takes — and the fallback would never run
   * in this gate while running in life. A helper that catches its own exception returns both,
   * and leaves the transaction usable afterwards.
   */
  psql(`
    create or replace function public.journey_call(p_sql text) returns text
    language plpgsql as $fn$
    declare v text;
    begin
      execute p_sql into v;
      return json_build_object('ok', true, 'value', v)::text;
    exception when others then
      return json_build_object('ok', false, 'sqlstate', sqlstate, 'message', sqlerrm)::text;
    end
    $fn$;`);

  const sqlLiteral = (value) => {
    const tag = `j${Math.random().toString(36).slice(2, 8)}`;
    return `$${tag}$${value == null ? "" : String(value)}$${tag}$`;
  };
  const literalSql = sqlLiteral;

  /** Run SQL as the role a browser connects as, for the person the request names. */
  const call = (sub, sql) => {
    const out = psql(`
      begin;
      select set_config('request.jwt.claim.sub','${sub}',true);
      select set_config('request.jwt.claim.aal','aal2',true);
      set local role authenticated;
      select public.journey_call(${sqlLiteral(sql)});
      commit;`);
    const line = String(out).split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "{}";
    try { return JSON.parse(line); } catch { return { ok: false, sqlstate: "P0001", message: line }; }
  };

  /** The value, or an Error carrying the SQLSTATE the client will read. */
  const asCaller = (sub, sql) => {
    const answer = call(sub, sql);
    if (answer.ok) return answer.value ?? "";
    const error = new Error(answer.message || "command failed");
    error.code = answer.sqlstate || "P0001";
    throw error;
  };

  // ── the browser ────────────────────────────────────────────────────────────
  const pw = await loadPlaywright();
  if (!pw) unavailable("Playwright is not installed");
  let executablePath;
  try { const own = pw.chromium.executablePath(); if (own && existsSync(own)) executablePath = own; } catch { /* none */ }
  if (!executablePath) executablePath = CHROMIUM_CANDIDATES.find((p) => existsSync(p) && statSync(p).size > 0);
  if (!executablePath) unavailable("No Chromium binary was found");

  writeFileSync(envFile,
    "VITE_SUPABASE_URL=https://stub.supabase.co\nVITE_SUPABASE_ANON_KEY=stub-anon-key-for-journey\n");
  const viteBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  if (!existsSync(viteBin)) unavailable("The local Vite binary is not installed");
  server = spawn(viteBin, ["--port", String(PORT), "--strictPort", "--mode", "e2e"], {
    cwd: root, detached: true, stdio: "ignore", env: { ...process.env, NODE_ENV: "development" },
  });
  if (!(await waitForServer(BASE))) throw new Error(`the application did not start on ${BASE}`);

  browser = await pw.chromium.launch({ executablePath });
  const ctx = await browser.newContext({ locale: "ckb", viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();

  const crashes = [];
  page.on("pageerror", (e) => crashes.push(String(e)));
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const text = msg.text();
    if (/Failed to load resource|net::ERR|realtime|Download the React/i.test(text)) return;
    consoleErrors.push(text.slice(0, 300));
    if (process.env.ZEMAN_JOURNEY_TRACE) {
      Promise.all(msg.args().map((a) => a.jsonValue().catch(() => "⟨unserialisable⟩")))
        .then((args) => console.log(`  console ${msg.type()}:`,
          ...args.map((a) => (typeof a === "string" ? a : JSON.stringify(a)).slice(0, 900))))
        .catch(() => {});
    }
  });

  // Every call the browser makes, answered by the real database. What this shim cannot
  // translate, it refuses — an unrecognised query answered with `[]` would be a stub again.
  const shimFailures = [];
  let signedInAs = CUSTOMER;
  const storedObjects = [];

  const routeSupabase = async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    const headers = request.headers();

    const json = (payload, status = 200, extra = {}) => route.fulfill({
      status,
      headers: { "content-type": "application/json", "access-control-expose-headers": "content-range", ...extra },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });

    // Auth is Supabase's own service, not this repository's code.
    if (url.includes("/auth/v1/token")) {
      return json({
        access_token: stubJwt(signedInAs), token_type: "bearer", expires_in: 3600,
        refresh_token: "stub-refresh",
        user: { id: signedInAs, aud: "authenticated", role: "authenticated", email: "journey@example.test" },
      });
    }
    if (url.includes("/auth/v1/user")) {
      return json({ id: signedInAs, aud: "authenticated", role: "authenticated" });
    }
    if (url.includes("/auth/v1/factors") || url.includes("/auth/v1/mfa")) return json([]);
    if (url.includes("/auth/v1/logout")) return json({});
    if (url.includes("/realtime/")) return route.abort();

    // Storage. The object row is written the way the storage service writes it — first without
    // its metadata, then completed — because the send reads that row back and refuses a receipt
    // whose staged object it cannot find.
    const upload = url.match(/\/storage\/v1\/object\/(?:receipts)\/(.+?)(?:\?|$)/);
    if (upload) {
      const objectPath = decodeURIComponent(upload[1]);
      if (method === "POST" || method === "PUT") {
        try {
          // Written as a SELECT over a CTE because every command here is run through one helper
          // that reads a value back — which is what lets it report the SQLSTATE the client
          // branches on.
          asCaller(signedInAs,
            `with staged as (
               insert into storage.objects(bucket_id,name,owner_id,metadata)
               values ('receipts', ${sqlLiteral(objectPath)}, '${signedInAs}', '{}'::jsonb)
               on conflict do nothing returning 1)
             select coalesce((select count(*) from staged), 0)::text`);
          // The storage service knows the size and type only once the bytes have landed.
          psql(`update storage.objects
                   set metadata = '{"size":264888,"mimetype":"image/jpeg"}'::jsonb
                 where bucket_id='receipts' and name='${objectPath.replace(/'/g, "''")}'`);
          storedObjects.push(objectPath);
          return json({ Key: `receipts/${objectPath}` });
        } catch (e) {
          return json({ statusCode: "400", message: String(e.message || e) }, 400);
        }
      }
      return json({ signedURL: `${BASE}/receipt.jpg` });
    }
    if (url.includes("/storage/v1/")) return json({});

    // Everything else is this repository's own commands and tables, run for real.
    try {
      const reply = handleRequest({
        method, url, headers, body: request.postData(),
        run: (sql) => asCaller(signedInAs, sql),
      });
      if (reply.status === 501) shimFailures.push(`${method} ${new URL(url).pathname}`);
      if (process.env.ZEMAN_JOURNEY_TRACE) {
        console.log(`  ${String(reply.status).padEnd(4)} ${method.padEnd(6)} ${new URL(url).pathname}${new URL(url).search.slice(0, 90)}`
          + (reply.status >= 400 ? `\n       ${String(reply.body).slice(0, 200)}` : ""));
      }
      return route.fulfill(reply);
    } catch (e) {
      shimFailures.push(`${method} ${new URL(url).pathname}: ${String(e.message || e).slice(0, 160)}`);
      return json({ code: "P0001", message: String(e.message || e) }, 400);
    }
  };

  await page.route("**/stub.supabase.co/**", (route) => routeSupabase(route));

  // The reader. Not this repository's provider, but the recording IS this repository's command,
  // so the route calls it exactly as api/receipt-ocr does — with the service key and no user.
  await page.route("**/api/receipt-ocr", async (route) => {
    const { documentId } = JSON.parse(route.request().postData() || "{}");
    const extraction = {
      grossAmount: READING.gross, feeAmount: READING.fee, netAmount: READING.net,
      currency: READING.currency,
      refNo: "JOURNEY0001", payee: "لەیلا", txDate: new Date().toISOString().slice(0, 10), txTime: "10:15",
      platform: "alipay", feeTreatment: "unknown", transactionStatus: "success", confidence: 0.96,
    };
    try {
      psql(`select public.sarraf_receipt_record_server_extraction(
        '${documentId}', '${"a".repeat(64)}', 264888, 'image/jpeg', true,
        '${JSON.stringify(extraction).replace(/'/g, "''")}'::jsonb,
        'journey', 'gate', 120, 'journey-request-${documentId}')`);
    } catch (e) {
      return route.fulfill({ status: 500, contentType: "application/json",
        body: JSON.stringify({ code: "ocr_record_failed", message: String(e.message || e) }) });
    }
    const state = psql(`select state from public.receipt_documents where id='${documentId}'`).trim();
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ documentId, state, extraction, requestId: `journey-${documentId}` }),
    });
  });

  // The send. A browser calling sarraf_ingest_receipt_batch directly is refused by design — only
  // the ingestion service can mint the authorization — so the client falls back to this route,
  // which mints one with the service key and then runs the SAME command under the caller's own
  // token. Both halves are this repository's, so both run for real.
  let ingestionCalls = 0;
  await page.route("**/api/receipt-ingestion", async (route) => {
    ingestionCalls += 1;
    const { p_batch, p_receipts, p_command_key } = JSON.parse(route.request().postData() || "{}");
    try {
      const token = `journeyToken${Math.random().toString(36).slice(2)}`.padEnd(43, "x").slice(0, 43);
      psql(`
        begin;
        select set_config('request.jwt.claim.role','service_role',true);
        set local role service_role;
        insert into public.receipt_ingestion_authorizations(command_key, actor_id, authorization_token, expires_at)
        values (${literalSql(p_command_key)}, 'jr-cus', ${literalSql(token)}, now() + interval '5 minutes')
        on conflict (command_key) do update set
          actor_id = excluded.actor_id,
          authorization_token = excluded.authorization_token,
          expires_at = excluded.expires_at;
        commit;`);
      const batch = { ...p_batch, _authorization_token: token };
      const out = asCaller(CUSTOMER, `select public.sarraf_ingest_receipt_batch(
        ${literalSql(JSON.stringify(batch))}::jsonb,
        ${literalSql(JSON.stringify(p_receipts))}::jsonb,
        ${literalSql(p_command_key)})::text`);
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ data: JSON.parse(out) }) });
    } catch (e) {
      const message = String(e?.message || e).split("\n").find((l) => /ERROR:/.test(l)) || String(e?.message || e);
      return route.fulfill({ status: 400, contentType: "application/json",
        body: JSON.stringify({ code: "ingest_failed", message: message.slice(0, 400) }) });
    }
  });

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });

  // ── the customer signs in ──────────────────────────────────────────────────
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await page.locator("input").first().fill("07500000000");
  await page.locator('input[type="password"]').first().fill("journey-password");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(7000);

  const mounted = await page.evaluate(() => document.querySelector("#root")?.children.length || 0);
  record(mounted > 0, "the customer's screen opens against a real database",
    mounted > 0 ? "" : "#root is empty");

  const body = await page.innerText("body").catch(() => "");
  if (process.env.ZEMAN_JOURNEY_DUMP) console.log(`\n===== screen =====\n${body.slice(0, 1500)}\n=====`);

  // ── the customer sends a receipt ───────────────────────────────────────────
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    + "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    + "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");

  // The customer's home screen is their balance; sending a receipt is its own place. A gate
  // that only ever looks at the first screen is not walking the journey.
  for (const label of ["ناردنی فیش", "فیش"]) {
    const tab = page.getByText(label, { exact: true }).first();
    if (await tab.count().catch(() => 0)) {
      await tab.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
      if (await page.locator('input[type="file"]').count()) break;
    }
  }

  const fileInputs = page.locator('input[type="file"]');
  const inputCount = await fileInputs.count();
  record(inputCount > 0, "the uploader offers somewhere to choose an image",
    inputCount > 0 ? "" : "no file input is on the customer's screen");

  if (inputCount > 0) {
    await fileInputs.first().setInputFiles({ name: "receipt.jpg", mimeType: "image/jpeg", buffer: jpeg });
    // Claim, store, read: three round trips to a real database and a real command each.
    await page.waitForTimeout(12000);

    const claimed = Number(psql("select count(*) from public.receipt_documents").trim());
    record(claimed > 0, "the image is claimed as a durable receipt before it is read",
      claimed > 0 ? "" : "no receipt_documents row was written by the browser");

    record(storedObjects.length > 0, "the bytes are stored where the send will look for them",
      storedObjects.length > 0 ? storedObjects[0] : "the browser never uploaded an object");

    const state = psql(`select coalesce(string_agg(state::text, ','), '⟨none⟩')
                          from public.receipt_documents`).trim();
    record(/validated|parsed|needs_manual_review/.test(state),
      "the reading is recorded against the receipt", `state: ${state}`);

    const extracted = psql(`select coalesce(max(net_amount)::text, '⟨none⟩')
                              from public.receipt_extractions`).trim();
    record(extracted.startsWith("1210"), "the figures the reader saw are on the receipt",
      `net_amount: ${extracted}`);
  }

  // ── the customer presses send ──────────────────────────────────────────────
  if (inputCount > 0) {
    // "＋ ناردنی فیش" opens the file picker; the send is the control that says how many it is
    // about to send. Matching the first thing containing «ناردن» pressed the picker again and
    // reported that nothing had been sent.
    const sendButton = page.getByRole("button", { name: /ناردنی\s*\d+\s*فیش/ }).first();
    const hasSend = await sendButton.count().catch(() => 0);
    record(hasSend > 0, "there is a way to send what was read",
      hasSend > 0 ? "" : "no send control appeared after the receipt was read");
    if (hasSend > 0) {
      const name = await sendButton.innerText().catch(() => "?");
      const disabled = await sendButton.isDisabled().catch(() => null);
      if (process.env.ZEMAN_JOURNEY_TRACE) console.log(`  send button: "${name}" disabled=${disabled}`);
      await sendButton.click({ timeout: 8000 }).catch((e) => {
        if (process.env.ZEMAN_JOURNEY_TRACE) console.log(`  send click failed: ${String(e).slice(0, 200)}`);
      });
      await page.waitForTimeout(9000);
      if (process.env.ZEMAN_JOURNEY_TRACE) {
        console.log(`  the ingestion route was called ${ingestionCalls} time(s)`);
        console.log(`  screen after send:\n${(await page.innerText("body").catch(() => "")).slice(0, 900)}`);
      }
    }

    // Every one of these was broken at some point this month, and each was invisible from both
    // sides of the line: the command key that never arrived, the verdict that was never sent,
    // the batch that closed with nothing in it.
    const batch = psql(`select coalesce(receipt_stage || '/' || status || '/' || n::text, '⟨none⟩')
                          from public.receipt_batches order by created_at desc limit 1`).trim();
    record(/^verified\/new\//.test(batch),
      "the batch closes as one the owner must act on", `receipt_stage/status/n: ${batch}`);

    const accepted = psql(`select coalesce(string_agg(intake_status, ','), '⟨none⟩')
                             from public.receipt_intake_items`).trim();
    record(accepted === "accepted", "the receipt is recorded as accepted, not as refused",
      `intake_status: ${accepted}`);

    const named = psql(`select coalesce(max(tracking_code), '⟨none⟩') from public.receipts`).trim();
    record(/^ZR-\d{8}-\d{6}-/.test(named), "the receipt has the name both sides can quote",
      `tracking_code: ${named}`);

    // The whole question the owner has been asking: does a receipt reach سەرخێڵ.
    const seenByOwner = asCaller(OWNER,
      `select coalesce(string_agg(id || ':' || status, ', '), '<none>') from public.receipt_batches`);
    record(seenByOwner.includes(":new"), "the owner sees the batch their customer sent",
      `the owner's view: ${seenByOwner}`);

    const told = asCaller(OWNER,
      `select coalesce(string_agg(kind, ','), '<none>') from public.zeman_notifications`);
    record(told.includes("batch_arrived"), "and is told about it without asking",
      `notifications: ${told}`);
  }

  // ── and now the owner opens the same system ────────────────────────────────
  //
  // Everything above proves the receipt reached the database. It does not prove the one thing
  // the owner actually asked for all week: that it turns up on THEIR screen. Both halves of the
  // journey run in the same browser against the same database, which is the only way to know
  // that what one person sent is what the other person sees.
  if (inputCount > 0) {
    signedInAs = OWNER;
    const ownerCtx = await browser.newContext({ locale: "ckb", viewport: { width: 430, height: 900 } });
    const ownerPage = await ownerCtx.newPage();
    const ownerCrashes = [];
    ownerPage.on("pageerror", (e) => ownerCrashes.push(String(e)));
    await ownerPage.route("**/stub.supabase.co/**", (route) => routeSupabase(route));
    await ownerPage.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });

    let ownerScreen = "";
    try {
      await ownerPage.waitForSelector('input[type="password"]', { timeout: 30000 });
      await ownerPage.locator("input").first().fill("07500000001");
      await ownerPage.locator('input[type="password"]').first().fill("journey-password");
      await ownerPage.keyboard.press("Enter");
      await ownerPage.waitForTimeout(9000);
      // The receipts screen is where a batch waiting for a decision appears. The nav entry is
      // «پشکنینی فیش»; its own subtitle says «فیشەکان», so an exact-text match on the subtitle
      // finds a label and clicks nothing.
      for (const label of ["پشکنینی فیش", "فیشەکان"]) {
        const tab = ownerPage.getByText(label, { exact: true }).first();
        if (await tab.count().catch(() => 0)) {
          await tab.click({ timeout: 5000 }).catch(() => {});
          await ownerPage.waitForTimeout(4000);
          break;
        }
      }
      ownerScreen = await ownerPage.innerText("body").catch(() => "");
    } catch (e) {
      ownerScreen = `⟨the owner could not sign in: ${String(e).slice(0, 160)}⟩`;
    }
    if (process.env.ZEMAN_JOURNEY_DUMP) console.log(`\n===== the owner's screen =====\n${ownerScreen.slice(0, 1200)}\n=====`);

    // Not "some receipts word appeared" — the batch is listed as one still awaiting a decision,
    // and the figures on it are the figures the customer's receipt actually carried.
    record(/فیشی نوێ\s*\(\s*[1-9]/.test(ownerScreen),
      "the owner's own screen lists the batch as still awaiting their decision",
      ownerScreen.replace(/\s+/g, " ").slice(0, 220));

    record(ownerScreen.includes(grouped(READING.net)) && ownerScreen.includes(READING.currency),
      "the amount the customer sent is the amount the owner is shown",
      `looking for ${grouped(READING.net)} ${READING.currency}`);

    record(ownerScreen.includes(grouped(READING.gross)),
      "and the with-fee figure the customer was quoted is there too",
      `looking for ${grouped(READING.gross)}`);

    const ownerCrashesReal = ownerCrashes.filter(
      (e) => !/supabaseUrl|Failed to load resource|net::ERR|realtime/i.test(e));
    record(ownerCrashesReal.length === 0, "nothing throws on the owner's side either",
      ownerCrashesReal.slice(0, 2).join(" | "));

    await ownerCtx.close();
    signedInAs = CUSTOMER;
  }

  // A ReferenceError inside an event handler leaves no message on the screen at all, which is
  // exactly how one upload path was dead for a whole evening.
  const realCrashes = crashes.filter((e) => !/supabaseUrl|Failed to load resource|net::ERR|realtime/i.test(e));
  record(realCrashes.length === 0, "nothing threw while the receipt was being sent",
    realCrashes.slice(0, 2).join(" | "));

  record(shimFailures.length === 0, "every call the browser made was one the database understood",
    [...new Set(shimFailures)].slice(0, 4).join(" | "));

  await ctx.close();

  // ── the report ─────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : `\n        ${r.detail}`}`);
  }
  console.log(failed.length
    ? `\n${failed.length} of ${results.length} journey checks failed.`
    : `\nThe receipt's journey holds across ${results.length} checks, in a browser, against a real database.`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error("The receipt journey could not run:", String(e?.message || e).slice(0, 3000));
  process.exit(1);
}
