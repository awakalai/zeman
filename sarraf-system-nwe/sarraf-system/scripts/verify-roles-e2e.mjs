#!/usr/bin/env node
/**
 * Per-role end-to-end check, in a real browser (§12).
 *
 * Every other verifier in this repo tests a layer: the database contracts, the pure services,
 * the bundle. None of them answers the question a millions-of-dollars system actually needs
 * answered — does the screen a customer sees show only that customer's money?
 *
 * So this boots the shipped application in Chromium against a stubbed Supabase, signs in as
 * each role in turn, and checks two things per role: that the surfaces that role is entitled to
 * are present, and that the surfaces it is NOT entitled to are absent. The database enforces
 * this too, through RLS; the point here is that the interface does not leak what the database
 * would have refused, and does not hide what the role is supposed to have.
 *
 * The stub is deliberately generous — it answers every query with the same fixture regardless
 * of who asked. That inverts the test in the useful direction: if the interface were relying on
 * the server to filter, the forbidden surfaces would appear and the check would fail.
 *
 *   npm run verify:roles
 */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.ZEMAN_E2E_PORT || 5199);
const BASE = `http://localhost:${PORT}`;

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean);

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
    } catch { /* try the next one */ }
  }
  return null;
};

// CI runners frequently provide no system browser, while a direct Playwright CDN download may be
// blocked even though npm dependencies are available.  The pinned serverless Chromium archive is
// therefore the deterministic final fallback.  Only the executable is inflated; the application
// bundles its own fonts and this avoids platform-specific ownership metadata in the font archive.
const loadBundledChromium = async () => {
  try {
    const archive = path.join(root, "node_modules/@sparticuz/chromium/bin/chromium.br");
    if (!existsSync(archive)) return null;
    const target = path.join(tmpdir(), "chromium");
    if (existsSync(target) && statSync(target).size === 0) rmSync(target, { force: true });
    const { inflate } = await import("@sparticuz/chromium");
    const executable = await inflate(archive);
    return existsSync(executable) && statSync(executable).size > 0 ? executable : null;
  } catch { return null; }
};

// ── the fixture every role is offered ────────────────────────────────────────
// One customer, one partner, one investor, one office, one admin, and money that belongs to
// exactly one of them. Any role seeing another's figures is the failure.
const USERS = {
  admin:    { id: "u-admin",    name: "ئەدمین",      role: "admin",    admin_level: "owner" },
  customer: { id: "u-customer", name: "کڕیاری تاقی", role: "customer" },
  partner:  { id: "u-partner",  name: "هاوبەشی تاقی", role: "partner" },
  investor: { id: "u-investor", name: "وەبەرهێنەر",  role: "investor" },
  office:   { id: "u-office",   name: "نووسینگە",    role: "office" },
};

const ROLE_EXPECTATIONS = {
  admin: {
    // The admin owns the whole system; these are the surfaces that must exist for them.
    //
    // The six section headings are listed here on purpose. «دەمەوێت بەشەکان زۆر بە ڕوونی جیا
    // بکەیتەوە نەک ئاوا هەمووی لە یەک شوێن بێت» — and before this the application had four
    // groups holding seven entries with SIXTEEN more screens listed at the foot of one of them.
    // Naming the sections here means the structure cannot quietly collapse back into a drawer.
    present: [
      "ئەمڕۆ", "مامەڵە", "فیش", "پارە", "خەڵک", "ڕاپۆرت",
      "کاری ئەمڕۆ", "کۆمەڵەکان", "پشکنین", "ناردن",
      "قەرز و قاسە", "حساب و عمولە", "شیکردنەوەی باڵانس",
    ],
    // The tools drawer is gone, and it must stay gone: a grid of sixteen buttons at the foot of
    // one page is what the owner meant by «جەنجاڵ».
    absent: ["ئامرازەکان"],
  },
  customer: {
    present: ["فیش"],
    // A customer must never be offered an operator surface.
    absent: ["کاری ئەمڕۆ", "بەستنی ڕۆژ", "پاراستنی داتا", "ناردنی فیش بۆ خاوەنەکەی"],
  },
  partner: {
    present: ["فیش"],
    absent: ["کاری ئەمڕۆ", "بەستنی ڕۆژ", "پاراستنی داتا", "ناردنی فیش بۆ خاوەنەکەی"],
  },
  office: {
    absent: ["کاری ئەمڕۆ", "بەستنی ڕۆژ", "پاراستنی داتا"],
    present: ["پارەدانی نووسینگە"],
  },
  investor: {
    absent: ["کاری ئەمڕۆ", "بەستنی ڕۆژ", "پاراستنی داتا"],
    present: [],
  },
};


/**
 * An unsigned JWT carrying the assurance level. supabase-js reads `aal` by base64-decoding the
 * payload, so this is enough to exercise the administrator MFA gate in both directions without
 * standing up a real auth server.
 */
const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const stubJwt = (userId, aal) => [
  b64url({ alg: "HS256", typ: "JWT" }),
  b64url({
    sub: `auth-${userId}`, aud: "authenticated", role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600, aal,
    amr: aal === "aal2" ? [{ method: "password" }, { method: "totp" }] : [{ method: "password" }],
  }),
  "stub-signature",
].join(".");

const results = [];
const record = (ok, name, detail = "") => results.push({ ok, name, detail });

let server = null;
let browser = null;
const envFile = path.join(root, ".env.e2e.local");

const stop = () => {
  try { if (server && !server.killed) process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
  try { rmSync(envFile, { force: true }); } catch { /* gone */ }
};
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

const waitForServer = async (url, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

try {
  // Skipping is a convenience for a developer machine without a browser. In CI it would be a
  // silent pass, which is worse than no check at all — so there it is a failure.
  const strict = process.env.CI === "true" || process.env.ZEMAN_E2E_STRICT === "1";
  const unavailable = (why) => {
    if (strict) {
      console.error(`${why} — per-role browser checks cannot run, and this is CI.`);
      process.exit(1);
    }
    console.log(`${why} — per-role browser checks skipped.`);
    console.log("Set ZEMAN_E2E_STRICT=1 to make this a failure instead.");
    process.exit(0);
  };

  const pw = await loadPlaywright();
  if (!pw) unavailable("Playwright is not installed");

  // Playwright knows where its own download went, which is the case on a CI runner. The
  // explicit candidates are the fallback for an environment that supplies a browser some
  // other way — as this container does through PLAYWRIGHT_BROWSERS_PATH.
  let executablePath;
  try {
    const own = pw.chromium.executablePath();
    if (own && existsSync(own)) executablePath = own;
  } catch { /* no managed download; fall back below */ }
  if (!executablePath) executablePath = CHROMIUM_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) executablePath = await loadBundledChromium();
  if (!executablePath) unavailable("No Chromium binary was found");

  // The app refuses to boot without a Supabase URL; every call is intercepted anyway.
  writeFileSync(envFile,
    "VITE_SUPABASE_URL=https://stub.supabase.co\nVITE_SUPABASE_ANON_KEY=stub-anon-key-for-role-verification\n");

  const viteBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  if (!existsSync(viteBin)) unavailable("The local Vite binary is not installed");
  server = spawn(viteBin, ["--port", String(PORT), "--strictPort", "--mode", "e2e"], {
    cwd: root, detached: true, stdio: "ignore",
    env: { ...process.env, NODE_ENV: "development" },
  });

  if (!(await waitForServer(BASE))) throw new Error(`the dev server did not start on ${BASE}`);

  browser = await pw.chromium.launch({ executablePath });

  // §12 requires a second factor for the roles that operate the business. Each of those is run
  // twice: once without it, where the interface must stop at the gate, and once with it.
  const MFA_REQUIRED = new Set(["admin", "office"]);
  const runs = [];
  for (const role of Object.keys(ROLE_EXPECTATIONS)) {
    if (MFA_REQUIRED.has(role)) runs.push({ role, aal: "aal1", expectGate: true });
    runs.push({ role, aal: MFA_REQUIRED.has(role) ? "aal2" : "aal1", expectGate: false });
  }
  // ── and once on a phone ──────────────────────────────────────────────────────────────────
  //
  // Every check above runs at 1280×900, and this business runs on phones. The six sections
  // «دەمەوێت بەشەکان زۆر بە ڕوونی جیا بکەیتەوە» were built into the sidebar, which a phone
  // does not have: the phone flattened the same groups into one list and hid everything past
  // the fourth entry behind «زیاتر» — twenty screens in a single unlabelled scroll. That is
  // the drawer this overhaul deleted, still standing on the device that matters most, and no
  // gate could see it because no gate had ever been narrow.
  runs.push({ role: "admin", aal: "aal2", expectGate: false, phone: true });

  for (const { role, aal, expectGate, phone } of runs) {
    const expect = ROLE_EXPECTATIONS[role];
    const me = USERS[role];
    const label = phone ? `${role} on a phone` : expectGate ? `${role} without a second factor` : role;
    const ctx = await browser.newContext({ locale: "ckb",
      viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const crashes = [];
    page.on("pageerror", (e) => crashes.push(String(e)));

    // A generous stub: it answers everyone identically. If the interface were leaning on the
    // server to filter by role, the forbidden surfaces would show up here.
    await page.route("**/stub.supabase.co/**", async (route) => {
      const url = route.request().url();
      // PostgREST reports the exact row count in Content-Range, and the client refuses to run
      // financial calculations on a page it cannot prove is complete. A stub that omits the
      // header would leave the app loading for ever.
      const json = (body, status = 200) => {
        const rows = Array.isArray(body) ? body.length : 0;
        // contentType is deliberately not used: it and `headers` do not merge, and the range
        // header is what the client needs.
        return route.fulfill({
          status,
          headers: {
            "content-type": "application/json",
            "content-range": rows ? `0-${rows - 1}/${rows}` : "*/0",
            "access-control-expose-headers": "content-range",
          },
          body: JSON.stringify(body),
        });
      };

      if (url.includes("/auth/v1/token")) {
        return json({
          access_token: stubJwt(me.id, aal), token_type: "bearer", expires_in: 3600,
          refresh_token: "stub-refresh",
          user: { id: `auth-${me.id}`, aud: "authenticated", role: "authenticated", email: `${role}@example.test` },
        });
      }
      if (url.includes("/auth/v1/user")) {
        return json({ id: `auth-${me.id}`, aud: "authenticated", role: "authenticated" });
      }
      // The gate an administrator must pass. Supplied as a claim so the check itself can be
      // exercised in both directions.
      if (url.includes("/auth/v1/factors") || url.includes("/auth/v1/mfa")) return json([]);
      if (url.includes("/rpc/sarraf_self_profile")) {
        return json({ ...me, auth_id: `auth-${me.id}`, deleted: false, rate: 0, scope_curs: [], phone: "07500000000" });
      }
      if (url.includes("/app_users")) {
        return json(Object.values(USERS).map((u) => ({ ...u, auth_id: `auth-${u.id}`, deleted: false, rate: 0, scope_curs: [] })));
      }
      // The catalogue, and the caller's own rates over it.
      //
      // This used to answer only `/currencies`, the table. 202608250002 stopped the browser
      // reading that table — its rate belongs to the installation, and reading it directly made
      // one business's rate the other's — and moved every caller to sarraf_currencies(). The
      // stub did not follow, so the call fell through to the catch-all `/rpc/` branch and came
      // back as `{}`; loadAll then ran `(c.data || []).map(...)` over an object, threw inside
      // its own try, and left every role on "بارکردنی داتا..." forever.
      //
      // Every "cannot reach" check passed on that empty screen, and every "can reach" check
      // failed. Nobody saw it, because the workflow this gate runs in has never once started.
      const CURRENCIES = [
        { id: "usd", code: "USD", name: "Dollar", dec: 2, rate: 1, buy_rate: 1, sell_rate: 1, own_rate: false },
        { id: "iqd", code: "IQD", name: "Dinar", dec: 0, rate: 1410, buy_rate: 1400, sell_rate: 1420, own_rate: true },
      ];
      if (url.includes("/rpc/sarraf_currencies") || url.includes("/currencies")) {
        return json(CURRENCIES);
      }
      // The administrator path refuses to load unless the database reports the contract it was
      // built against. Stubbed so the role check exercises the interface, not the migration.
      if (url.includes("/rpc/sarraf_runtime_contract")) {
        return json({ ok: true, contract_version: "13f-v1", phase13f_applied: true });
      }
      if (url.includes("/rpc/")) return json({});
      return json([]);
    });

    await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });

    // Sign in as this role. The stub accepts any credentials and returns this role's identity.
    try {
      await page.waitForSelector('input[type="password"]', { timeout: 20000 });
      await page.locator("input").first().fill("07500000000");
      await page.locator('input[type="password"]').first().fill("stub-password");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(6000);
    } catch {
      record(false, `${label}: the sign-in screen did not appear`);
      await ctx.close();
      continue;
    }

    const body = await page.innerText("body").catch(() => "");
    // ZEMAN_E2E_DUMP prints what each role actually saw, which is how a failing expectation
    // gets diagnosed without re-instrumenting the script.
    if (process.env.ZEMAN_E2E_DUMP) console.log(`\n===== ${label} =====\n${body.slice(0, 700)}\n=====`);
    const mounted = await page.evaluate(() => document.querySelector("#root")?.children.length || 0);
    record(mounted > 0, `${label}: the application renders`, mounted > 0 ? "" : "#root is empty");

    // Without a second factor an operator role must be stopped, and must not be shown the
    // business behind the gate.
    // The gate names itself; relying on the absence of business text would pass for any
    // screen that merely failed to load.
    const gated = /پشتڕاستکردنەوەی پاراستن|Authenticator|قۆدی|2FA|MFA/i.test(body);
    if (expectGate) {
      record(gated, `${label}: is stopped at the second-factor gate`,
        gated ? "" : "an operator role reached the system with one factor");
      record(!body.includes("بەستنی ڕۆژ") && !body.includes("پاراستنی داتا"),
        `${label}: sees nothing behind the gate`);
      const realGated = crashes.filter((e) => !/supabaseUrl|Failed to load resource|net::ERR/i.test(e));
      record(realGated.length === 0, `${label}: no uncaught error`, realGated.slice(0, 2).join(" | "));
      await ctx.close();
      continue;
    }

    // An absence check only means something once the role is actually inside. A run that never
    // got past sign-in would otherwise pass every one of them for the wrong reason.
    const signedIn = body.includes("دەرچوون") || body.includes(me.name);
    record(signedIn, `${label}: reaches their own screen`,
      signedIn ? "" : `sign-in did not complete — the checks below would pass for the wrong reason: ${body.slice(0, 120)}`);
    if (!signedIn) { await ctx.close(); continue; }

    if (phone) {
      // Nothing may be wider than the phone. A number that scrolls sideways is a number a
      // person reads half of.
      const wide = await page.evaluate(() =>
        document.documentElement.scrollWidth - window.innerWidth);
      record(wide <= 1, `${label}: the page is not wider than the screen`,
        wide > 1 ? `${wide}px of horizontal overflow` : "");

      // The product's own name, whole. Five action buttons in one header had left it 39
      // pixels for a word that needs 55, so ZEMAN rendered as «…AN» on every phone.
      const brandCut = await page.evaluate(() => {
        for (const el of document.querySelectorAll("div,span")) {
          if (el.children.length === 0 && (el.textContent || "").trim() === "ZEMAN") {
            return el.scrollWidth > el.clientWidth + 1;
          }
        }
        return null;
      });
      record(brandCut === false, `${label}: the brand name is not cut off`,
        brandCut === null ? "no element carries the brand name" : "the name does not fit its box");

      // The six sections, on the phone, with their headings — the whole point of this run.
      //
      // Read as HEADINGS, not as text anywhere on the page. The first version of this searched
      // the body for each word and four of the five passed with the headings deleted, because
      // «مامەڵە», «فیش», «پارە» and «ڕاپۆرت» are also the names of screens in the list. Only
      // «خەڵک» failed. A check that four fifths of it cannot fail is measuring almost nothing.
      let headings = [];
      try {
        await page.getByText("زیاتر", { exact: true }).first().click({ timeout: 5000 });
        await page.waitForTimeout(700);
        headings = await page.evaluate(() => [...document.querySelectorAll(".sidebar-section-title")]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => el.textContent.trim()));
      } catch (error) {
        record(false, `${label}: «زیاتر» opens`, String(error?.message || error).slice(0, 120));
      }
      for (const heading of ["مامەڵە", "فیش", "پارە", "خەڵک", "ڕاپۆرت"]) {
        record(headings.includes(heading),
          `${label}: «${heading}» is a named section, not a line in a list`,
          headings.length ? `the sheet's headings are: ${headings.join(" · ")}` : "the sheet has no headings at all");
      }
      // And the sheet must be a panel you can shut: with every section, the settings row and
      // the "view as" picker stacked, it grew past the height of the phone and pushed its own
      // close button off the top of the screen.
      const closeVisible = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")]
          .find((x) => /داخستنی/.test(x.getAttribute("aria-label") || ""));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      record(closeVisible === true, `${label}: the sheet can be closed without scrolling to find the button`,
        closeVisible === null ? "the sheet has no close button" : "the close button is off screen");

      // The same accessible-names contract the desktop runs, because the phone has controls
      // the desktop does not. It found one immediately: the floating «مامەڵەی نوێ» button,
      // the largest control in the mobile application, announced as "button" and nothing
      // more. It is md:hidden, so ten desktop passes could never have seen it.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      const nameless = await page.evaluate(() => [...document.querySelectorAll("button,a[href],input,select,textarea")]
        .filter((el) => {
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden"
            && box.width > 0 && box.height > 0 && el.getAttribute("type") !== "hidden";
        })
        .filter((el) => ![el.getAttribute("aria-label"), el.getAttribute("title"), el.textContent,
          [...(el.labels || [])].map((l) => l.textContent || "").join(" ")]
          .some((v) => String(v || "").trim()))
        .map((el) => `${el.tagName.toLowerCase()}@${Math.round(el.getBoundingClientRect().x)},${Math.round(el.getBoundingClientRect().y)}`)
        .slice(0, 8));
      record(nameless.length === 0, `${label}: visible controls have accessible names`,
        nameless.join(", "));

      const phoneCrashes = crashes.filter((e) => !/supabaseUrl|Failed to load resource|net::ERR/i.test(e));
      record(phoneCrashes.length === 0, `${label}: no uncaught error`, phoneCrashes.slice(0, 2).join(" | "));
      await ctx.close();
      continue;
    }

    for (const needle of expect.absent) {
      record(!body.includes(needle),
        `${label}: cannot reach «${needle}»`,
        body.includes(needle) ? "the surface was offered to a role that must not have it" : "");
    }
    for (const needle of expect.present) {
      record(body.includes(needle),
        `${label}: can reach «${needle}»`,
        body.includes(needle) ? "" : "the surface this role is entitled to was missing");
    }

    // No page-level band may start underneath the sidebar.
    //
    // The sidebar is `fixed left-0` and 236px wide, so anything laid out full-width is drawn
    // behind it. That is what had happened to the market ticker: market-pulse.css offset it
    // with `margin-inline-start`, which in a right-to-left interface is the RIGHT edge — so
    // it was pushed away from the side that has nothing on it and left running under the
    // navigation. The first rate scrolled under the sidebar on every desktop.
    //
    // Measured on the BANDS, not on every leaf. The first version of this walked every text
    // node, and the marquee's track is deliberately wider than its own `overflow:hidden` box
    // — so it reported items that are clipped and invisible, and went on reporting them after
    // the bug was fixed. A check that cannot go quiet is not a check.
    const underSidebar = await page.evaluate(() => {
      const bar = document.querySelector(".sarraf-sidebar");
      if (!bar) return null;
      const edge = bar.getBoundingClientRect().right;
      if (edge < 10) return [];
      const bands = [".market-ticker", "main", ".sarraf-topbar > div"];
      const wrong = [];
      for (const selector of bands) {
        for (const el of document.querySelectorAll(selector)) {
          const r = el.getBoundingClientRect();
          if (r.width < 50) continue;
          // Where the CONTENT starts, not where the box does. <main> spans the full width and
          // steps aside with padding-left:260px, which is a correct way to clear a fixed
          // sidebar; measuring its border box would call that a fault.
          const inner = r.left + parseFloat(getComputedStyle(el).paddingLeft || 0);
          if (inner < edge - 4) wrong.push(`${selector} content starts at ${Math.round(inner)}px, sidebar ends at ${Math.round(edge)}px`);
        }
      }
      return wrong;
    });
    if (underSidebar !== null) {
      record(underSidebar.length === 0, `${label}: nothing is drawn underneath the sidebar`,
        underSidebar.join(" · "));
    }

    // A back link that guesses is worse than no back link.
    //
    // «گەڕانەوە بۆ ناوەندی بەڕێوەبردن» was shown on every page in ADMIN_CENTER_PAGE_IDS. That
    // was right when those pages had no entry of their own; twenty of the twenty-one have one
    // now, so somebody opening «پشکنین» from the sidebar was offered a way back to a place
    // they had never been. The admin centre still leads to seven of them, and for a person who
    // arrived that way the link is exactly right — so it must depend on the route taken, and
    // both routes are walked here.
    if (role === "admin" && !expectGate) {
      const BACK = "گەڕانەوە بۆ ناوەندی بەڕێوەبردن";
      const openFromSidebar = async (label) => {
        try { await page.getByText(label, { exact: true }).first().click({ timeout: 4000 }); }
        catch { return null; }
        await page.waitForTimeout(900);
        return page.innerText("body").catch(() => "");
      };
      const viaSidebar = await openFromSidebar("پشکنین");
      if (viaSidebar === null) {
        record(false, `${label}: «پشکنین» opens from the navigation`);
      } else {
        record(!viaSidebar.includes(BACK),
          `${label}: no way "back" to a place they never came from`,
          viaSidebar.includes(BACK) ? "the admin-centre link was offered after a sidebar visit" : "");
      }
      // The other direction — that the link IS there for somebody who came through the hub —
      // cannot be walked here. The admin centre shows a line only when something is waiting,
      // which is its whole design, so against an empty fixture it offers no route into these
      // pages at all. That half is pinned in test/adminCenterNavigation.test.js instead, on
      // the source, where it needs no data.
    }

    // Critical accessibility contract in the shipped DOM: every visible interactive control
    // has a programmatic name, IDs are unique, and keyboard focus can enter the interface.
    const accessibility = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      };
      const controls = [...document.querySelectorAll("button,a[href],input,select,textarea")]
        .filter((element) => visible(element) && element.getAttribute("type") !== "hidden");
      const unnamed = controls.filter((element) => {
        const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent || "").join(" ");
        const labels = [...(element.labels || [])].map((label) => label.textContent || "").join(" ");
        const childAlt = [...element.querySelectorAll?.("img[alt]") || []].map((img) => img.alt).join(" ");
        return ![element.getAttribute("aria-label"), labelledBy, labels, element.getAttribute("title"),
          element.textContent, childAlt].some((value) => String(value || "").trim());
      }).map((element) => {
        const selector = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.className ? `.${String(element.className).split(/\s+/).slice(0,2).join(".")}` : ""}`;
        const hint = element.getAttribute("placeholder") || element.parentElement?.textContent?.trim().slice(0, 60) || "";
        return hint ? `${selector} [${hint}]` : selector;
      });
      const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
      const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      return { unnamed: unnamed.slice(0, 12), duplicateIds: duplicateIds.slice(0, 12) };
    });
    record(accessibility.unnamed.length === 0, `${label}: visible controls have accessible names`,
      accessibility.unnamed.join(", "));
    record(accessibility.duplicateIds.length === 0, `${label}: rendered IDs are unique`,
      accessibility.duplicateIds.join(", "));
    await page.keyboard.press("Tab");
    const keyboardEntered = await page.evaluate(() => document.activeElement && document.activeElement !== document.body);
    record(keyboardEntered, `${label}: keyboard focus enters the interface`);

    const real = crashes.filter((e) => !/supabaseUrl|Failed to load resource|net::ERR/i.test(e));
    record(real.length === 0, `${label}: no uncaught error`, real.slice(0, 2).join(" | "));

    await ctx.close();
  }
} catch (e) {
  record(false, "the per-role run could not complete", String(e?.message || e).slice(0, 300));
} finally {
  try { if (browser) await browser.close(); } catch { /* already gone */ }
  stop();
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  if (!r.ok) failed++;
}
console.log(failed
  ? `\n${failed} of ${results.length} per-role checks failed.`
  : `\nPer-role interface boundaries hold across ${results.length} checks in a real browser.`);
process.exit(failed ? 1 : 0);
