import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ownerPasswordObjection,
  ownerPhoneObjection,
  provisionBusiness,
} from "../src/services/managerConsole.js";

test("manager onboarding asks only for business facts and creates the owner in one request", async () => {
  const calls = [];
  const request = async (payload) => {
    calls.push(payload);
    return { ok: true, business: { id: "hidden-id", name: payload.name } };
  };

  const result = await provisionBusiness(request, {
    name: "ZEMAN Duhok",
    ownerName: "خاوەن",
    ownerPhone: "0750 123 4567",
    password: "long-private-passphrase",
    note: "لقی دهۆک",
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    action: "create_business",
    name: "ZEMAN Duhok",
    ownerName: "خاوەن",
    ownerPhone: "0750 123 4567",
    password: "long-private-passphrase",
    note: "لقی دهۆک",
  });
  assert.ok(!("id" in calls[0]), "the manager was still asked to invent a database id");
  assert.ok(!("email" in calls[0]), "the manager was still asked for a synthetic login email");
});
test("invalid phone or temporary password is refused before the server request", async () => {
  let called = false;
  const request = async () => { called = true; };

  await assert.rejects(() => provisionBusiness(request, {
    name: "ZEMAN", ownerName: "خاوەن", ownerPhone: "123", password: "long-private-passphrase",
  }), /مۆبایل/);
  await assert.rejects(() => provisionBusiness(request, {
    name: "ZEMAN", ownerName: "خاوەن", ownerPhone: "07501234567", password: "short",
  }), /لانیکەم 12/);
  assert.equal(called, false);
});

test("phone and password refusals exist in every manager language", () => {
  for (const lang of ["ku", "en", "ar"]) {
    assert.ok(ownerPhoneObjection("123", lang));
    assert.ok(ownerPasswordObjection("short", lang));
    assert.equal(ownerPhoneObjection("07501234567", lang), null);
    assert.equal(ownerPasswordObjection("long-private-passphrase", lang), null);
  }
});

test("the manager form exposes no tenant id, email, or Supabase invitation step", () => {
  const source = readFileSync(
    new URL("../src/components/accounting/ManagerConsole.jsx", import.meta.url), "utf8",
  );
  const form = source.slice(source.indexOf("manager-onboarding-form"), source.indexOf('{tab === "accounts"'));
  assert.doesNotMatch(form, /ownerEmail|tenant-id|Supabase|copy\.id/);
  assert.match(form, /ownerPhone/);
  assert.match(form, /ownerPassword/);
});

test("business onboarding is server-only and rolls back the Auth user if the database fails", () => {
  const api = readFileSync(new URL("../api/admin-user.js", import.meta.url), "utf8");
  const migration = readFileSync(new URL(
    "../supabase/migrations/20260908201710_manager_creates_business_with_phone.sql",
    import.meta.url,
  ), "utf8");

  assert.match(api, /action === "create_business"/);
  assert.match(api, /sarraf_manager_create_business_owner/);
  assert.match(api, /businessError[\s\S]*deleteUser\(authId\)/);
  assert.match(api, /app_metadata: \{ role, admin_level: adminLevel, tenant_id: tenantId \}/);
  assert.doesNotMatch(api, /user_metadata: \{ name, role, phone, admin_level/);
  assert.match(migration, /revoke all on function public\.sarraf_manager_create_business_owner[\s\S]*authenticated/);
  assert.match(migration, /grant execute on function public\.sarraf_manager_create_business_owner[\s\S]*service_role/);
  assert.match(migration, /insert into public\.control_settings\(singleton, tenant_id, updated_by\)/);
  assert.match(migration, /insert into public\.receipt_control_policy\(singleton, tenant_id, updated_by\)/);
  assert.doesNotMatch(migration, /from public\.control_settings c/);
});
