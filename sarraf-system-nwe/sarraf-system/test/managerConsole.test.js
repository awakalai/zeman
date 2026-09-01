import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  healthProblems, loadHealth, loadTenants, openBusiness, setTenantActive,
  tenantIdObjection, tenantNameObjection,
} from "../src/services/managerConsole.js";

const ok = { rpc: async () => ({ data: {}, error: null }) };

test("a business id is checked before it is written into every row it will own", () => {
  assert.equal(tenantIdObjection("zeman-erbil"), null);
  assert.equal(tenantIdObjection("abc"), null);
  assert.match(tenantIdObjection("ab"), /لانیکەم/);
  assert.match(tenantIdObjection("Upper"), /پیتی ئینگلیزیی بچووک/);
  assert.match(tenantIdObjection("has space"), /پیتی ئینگلیزیی بچووک/);
  assert.match(tenantIdObjection("-leading"), /پیتی ئینگلیزیی بچووک/);
});

test("a business needs a name", () => {
  assert.equal(tenantNameObjection("سەرخێڵ"), null);
  assert.match(tenantNameObjection("ک"), /ناوی سەرخێڵ/);
});

test("an invalid business is refused before the server is asked", async () => {
  // createTenant used to be the call here. It made a business and nobody who could sign into
  // it, so the console now opens a business and its first owner in one act; this holds the same
  // thing it always held — that an id which cannot be valid never reaches the server.
  let called = false;
  const client = { rpc: async () => { called = true; return { data: {}, error: null }; } };
  await assert.rejects(() => openBusiness(client, {
    id: "AB", name: "x", ownerEmail: "a@b.co", ownerName: "خاوەن",
  }));
  assert.equal(called, false, "the server was asked about a business that could not be valid");
});

test("suspending says why, and refuses to be silent about it", async () => {
  await assert.rejects(() => setTenantActive(ok, { id: "t-1", active: false, reason: "" }),
    /هۆکارێک بنووسە/);
  await assert.rejects(() => setTenantActive(ok, { id: "", active: false, reason: "not paying" }),
    /سەرخێڵێک پێویستە/);
});

test("the business list defaults to empty rather than to null", async () => {
  const client = { rpc: async () => ({ data: null, error: null }) };
  const out = await loadTenants(client);
  assert.deepEqual(out.tenants, []);
});

test("a refusal from the server is passed on rather than swallowed", async () => {
  const client = { rpc: async () => ({ data: null, error: new Error("42501") }) };
  await assert.rejects(() => loadTenants(client), /42501/);
});

// A coverage read that fails must not hide the schema report that succeeded: the manager needs
// whichever answers they can get, not the first failure.
test("one failing health read does not blank the others", async () => {
  const client = {
    rpc: async (fn) => fn === "sarraf_tenant_coverage"
      ? { data: null, error: new Error("permission denied") }
      : { data: { tables: [], columns: [] }, error: null },
  };
  const health = await loadHealth(client);
  assert.deepEqual(health.schema.tables, []);
  assert.equal(health.coverage, null);
  assert.match(health.coverageError, /permission denied/);
});

test("a healthy installation reports no problems at all", () => {
  assert.deepEqual(healthProblems({ schema: { tables: [], columns: [] }, coverage: [], orphans: {} }), []);
  assert.deepEqual(healthProblems(null), []);
});

test("every kind of problem is named, in the order it matters", () => {
  const problems = healthProblems({
    schema: {
      tables: [{ table_name: "txs", state: "missing from the database" }],
      columns: [{ table_name: "audit", column_name: "user_id", expected: "text", found: "<missing>" }],
    },
    coverage: [{ table_name: "notes", problem: "holds no tenant_id" }],
    orphans: { receipts: 4 },
  });
  assert.equal(problems.length, 4);
  assert.match(problems[0], /txs/);
  assert.match(problems[1], /audit\.user_id/);
  assert.match(problems[2], /notes/);
  assert.match(problems[3], /receipts/);
});

// The manager maintains the installation and sells it. They are not a party to anybody's trades,
// and a console that added up somebody else's money would be reading what is not theirs.
test("the console computes no figure from a business's books", () => {
  const source = readFileSync(new URL("../src/services/managerConsole.js", import.meta.url), "utf8");
  const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["reduce(", "+=", "Math.round", "toFixed", "sum"]) {
    assert.ok(!body.includes(forbidden), `${forbidden} appears in a console that must not total`);
  }
});
