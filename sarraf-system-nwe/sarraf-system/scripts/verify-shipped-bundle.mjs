#!/usr/bin/env node
/**
 * The thing that actually ships, loaded the way it will actually be served (§17–19).
 *
 * Every browser gate in this repository — verify:roles, verify:journey — boots the Vite dev
 * server. That is the right tool for what they test, and it is not what a customer loads. The
 * dev server hands the browser unbundled ES modules, transforms on demand, and sends none of
 * the headers vercel.json declares. `npm run build` says "built in 7.38s" and proves only that
 * Rollup did not throw.
 *
 * So there has been a gap the whole way through: the artifact in dist/ has never been opened in
 * a browser, and the Content-Security-Policy that Vercel puts in front of it has never been
 * applied to it. Those two facts meet in a specific, ordinary failure — `script-src 'self'`
 * forbids inline script, a bundler is free to emit some, and the result is a white screen that
 * every test upstream of the deploy passes.
 *
 * This serves dist/ over HTTP with the exact headers read out of vercel.json, opens it in
 * Chromium, and asks whether the sign-in screen arrives. It reads vercel.json rather than
 * restating it, so tightening the policy there is checked here rather than discovered by a
 * customer.
 *
 *   npm run build && npm run verify:bundle
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Its own output directory, so a developer's dist/ is neither read nor destroyed by a check.
const dist = mkdtempSync(path.join(tmpdir(), "zeman-bundle-"));
const PORT = Number(process.env.ZEMAN_BUNDLE_PORT || 5231);
const BASE = `http://127.0.0.1:${PORT}`;

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

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ ok: true, name }); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); }
};

// ── the headers Vercel will actually send ────────────────────────────────────
//
// Read, not restated. vercel.json is the deployment contract; a copy of it here would drift and
// then this gate would be checking a policy nobody serves.
const vercel = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8"));
const rule = (vercel.headers || []).find((h) => h.source === "/(.*)");
if (!rule) {
  console.error("vercel.json has no catch-all header rule; this gate has nothing to apply.");
  process.exit(1);
}
const DEPLOYED_HEADERS = Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".webmanifest": "application/manifest+json",
};

let server = null;
let browser = null;
const stop = () => {
  try { server?.close(); } catch { /* gone */ }
  try { browser?.close(); } catch { /* gone */ }
  try { rmSync(dist, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

try {
  const strict = process.env.CI === "true" || process.env.ZEMAN_E2E_STRICT === "1";
  const unavailable = (why) => {
    if (strict) { console.error(`${why} — the shipped bundle cannot be checked, and this is CI.`); process.exit(1); }
    console.log(`${why} — shipped-bundle check skipped.`);
    console.log("Set ZEMAN_E2E_STRICT=1 to make this a failure instead.");
    process.exit(0);
  };

  // Built here rather than reused from dist/, for two reasons. A dist/ left over from an earlier
  // command may have been built from other source, and this gate would then report on code
  // nobody is shipping. And the bundle needs a Supabase URL baked in — the application refuses
  // to start without one — which a bare `vite build` in a checkout does not have. Stub values
  // are correct here: every request to them is aborted, and what is under test is whether the
  // bundle parses, executes and renders under the deployed headers, not where it points.
  console.log(`Building the bundle to check, into ${dist}`);
  const built = spawn(path.join(root, "node_modules", ".bin", "vite"),
    ["build", "--outDir", dist, "--emptyOutDir"], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_SUPABASE_URL: "https://stub.supabase.co",
        VITE_SUPABASE_ANON_KEY: "stub-anon-key-for-bundle-verification",
      },
    });
  const code = await new Promise((r) => built.on("close", r));
  if (code !== 0) throw new Error("the production build failed, so there is no bundle to load");

  const pw = await loadPlaywright();
  if (!pw) unavailable("Playwright is not installed");
  let executablePath;
  try {
    const own = pw.chromium.executablePath();
    if (own && existsSync(own)) executablePath = own;
  } catch { /* no managed download */ }
  if (!executablePath) executablePath = CHROMIUM_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) executablePath = await loadBundledChromium();
  if (!executablePath) unavailable("No Chromium binary was found");

  // A single-page application: anything that is not a file on disk is index.html, which is what
  // Vercel does too. Serving 404 there would test a server nobody runs.
  const missingAssets = [];
  server = createServer((req, res) => {
    const clean = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(dist, clean);
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // A request for a hashed asset that is not there is a broken bundle, not a route. Vercel
      // would answer index.html for it too — and the browser would then parse HTML as
      // JavaScript, which is the confusing half of this failure. Record it either way.
      if (/\.[a-z0-9]+$/i.test(clean) && clean !== "/") missingAssets.push(clean);
      file = path.join(dist, "index.html");
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      ...DEPLOYED_HEADERS,
      "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": body.length,
    });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });

  browser = await pw.chromium.launch({ executablePath });
  const ctx = await browser.newContext({ locale: "ckb", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const crashes = [];
  const consoleErrors = [];
  const failedRequests = [];
  const cspViolations = [];
  page.on("pageerror", (e) => crashes.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText || "";
    // The Supabase stub aborts on purpose; that is not the bundle failing.
    if (!r.url().includes("stub.supabase.co")) failedRequests.push(`${r.url()} — ${why}`);
  });
  // The browser reports a blocked script through this event and nowhere else that Playwright
  // surfaces as an error, so listen for it before any of the page's own script runs.
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation",
      (e) => window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`));
  });
  // No session, no network: the signed-out screen is what a first visitor gets, and it is the
  // one screen that needs no data to render.
  await page.route("**/*.supabase.co/**", (route) => route.abort());

  const response = await page.goto(BASE, { waitUntil: "load", timeout: 60000 });

  check("the deployed Content-Security-Policy reaches the browser", () => {
    const sent = response.headers()["content-security-policy"];
    if (!sent) throw new Error("no CSP header was served; this gate would prove nothing");
    if (!sent.includes("script-src 'self'")) {
      throw new Error(`the policy no longer restricts script to 'self': ${sent}`);
    }
  });

  let signInReached = true;
  try {
    await page.waitForSelector('input[autocomplete="current-password"]', { timeout: 30000 });
  } catch { signInReached = false; }

  check("the shipped bundle boots and reaches the sign-in screen", () => {
    if (!signInReached) {
      throw new Error("no password field appeared within 30s — the bundle did not render");
    }
  });

  cspViolations.push(...(await page.evaluate(() => window.__csp || [])));
  check("no script the bundle needs is blocked by the policy that ships with it", () => {
    if (cspViolations.length) throw new Error(cspViolations.join("; "));
  });

  check("every asset the bundle asks for is in dist/", () => {
    if (missingAssets.length) {
      throw new Error(`served index.html instead of: ${[...new Set(missingAssets)].join(", ")}`);
    }
  });

  check("nothing threw while the bundle started", () => {
    if (crashes.length) throw new Error(crashes.join(" | "));
  });

  check("no request the bundle made to its own origin failed", () => {
    if (failedRequests.length) throw new Error(failedRequests.join(" | "));
  });

  check("the browser console is clean on a first visit", () => {
    // A signed-out first visit has nothing to report. Anything here is a defect a customer sees
    // the symptoms of without ever seeing the message.
    const real = consoleErrors.filter((t) => !/supabase|net::ERR_FAILED|Failed to fetch/i.test(t));
    if (real.length) throw new Error(real.join(" | "));
  });

  check("the security headers Vercel promises are all present", () => {
    const sent = response.headers();
    const missing = Object.keys(DEPLOYED_HEADERS).filter((k) => !sent[k.toLowerCase()]);
    if (missing.length) throw new Error(`not served: ${missing.join(", ")}`);
  });
} catch (e) {
  results.push({ ok: false, name: "the check could run at all", detail: e.message });
} finally {
  stop();
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log("");
console.log(failed
  ? `The bundle that would ship is not sound: ${failed} of ${results.length} checks failed.`
  : `The bundle that would ship boots under its own deployed headers, across ${results.length} checks.`);
process.exit(failed ? 1 : 0);
