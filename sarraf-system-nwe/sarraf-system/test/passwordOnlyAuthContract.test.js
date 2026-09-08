import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("the application uses the chosen phone and password login without an MFA gate", () => {
  const app = read("src/App.jsx");
  assert.match(app, /<Lbl>\{loginCopy\.phone\}<\/Lbl>/);
  assert.match(app, /en: \{ phone: "Phone number"/);
  assert.match(app, /ar: \{ phone: "رقم الهاتف"/);
  assert.match(app, /inputMode="tel"/);
  assert.doesNotMatch(app, /function MfaGate|auth\.mfa\.|accessState === "mfa"/);
});

test("server routes authorize the active role but do not demand a second factor", () => {
  for (const file of [
    "api/admin-user.js",
    "api/read-receipt.js",
    "api/receipt-ocr.js",
    "api/office-payment-evidence.js",
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /mfa_required|multi-factor authentication|\.auth\.admin\.mfa/,
      `${file} still contains the removed second-factor gate`);
    assert.match(source, /app_users/, `${file} no longer checks the active application account`);
  }
});

test("installed database commands accept only an authenticated password session", () => {
  const migration = read("supabase/migrations/20260908201717_password_sessions_are_the_chosen_login.sql");
  assert.match(migration, /when auth\.uid\(\) is not null then 'aal2'/);
  assert.match(migration, /v_actor := public\.sarraf_actor\(\)/);
  assert.match(migration, /v_actor\.role <> 'admin'/);
  assert.match(migration, /anonymous calls do not/i);
});

test("owner and employee can reset an ordinary user's password from the people screen", () => {
  const app = read("src/App.jsx");
  const api = read("api/admin-user.js");
  assert.match(app, /resetUserPassword=\{resetUserPassword\}/);
  assert.match(app, /action: "reset_password"/);
  assert.match(api, /const allowed = isManager\(actor\.profile\)[\s\S]*\|\| targetLevel === null/);
  assert.match(api, /judgePassword\(password, \{ phone: target\.phone, name: target\.name \}\)/);
});
