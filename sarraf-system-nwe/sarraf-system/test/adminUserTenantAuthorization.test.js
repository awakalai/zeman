import test from "node:test";
import assert from "node:assert/strict";
import { authorizeTarget, withinTenant } from "../api/admin-user.js";

/**
 * The route holds the service key, which bypasses row-level security. Every mutating action
 * loaded its target with `.eq("id", userId)` and no tenant at all, then wrote the same way — so
 * a business owner who knew a user's UUID from another business could deactivate that person,
 * change their commission, reset their password, or change their rank. Nothing had to be forged.
 * The identifier was the whole attack.
 *
 * These drive the decision directly, with a stub standing in for PostgREST, because what is
 * being checked is the decision and not the network.
 */

// The smallest thing that answers `.from().select().eq().maybeSingle()` and remembers what it
// was asked, so a test can assert that the tenant reached the query rather than only the answer.
const stubService = (row, { error = null } = {}) => {
  const calls = [];
  const builder = {
    select(columns) { calls.push(["select", columns]); return builder; },
    eq(column, value) { calls.push(["eq", column, value]); return builder; },
    is(column, value) { calls.push(["is", column, value]); return builder; },
    maybeSingle: async () => ({ data: row, error }),
  };
  return { calls, from(table) { calls.push(["from", table]); return builder; } };
};

const actorIn = (tenantId, level = "owner") => ({
  profile: { id: "actor-1", name: "Owner A", role: "admin", admin_level: level, tenant_id: tenantId },
});

const targetIn = (tenantId, overrides = {}) => ({
  id: "target-1", name: "User B", role: "partner", admin_level: null, deleted: false,
  tenant_id: tenantId, ...overrides,
});

test("an owner may act on a user in their own business", async () => {
  const service = stubService(targetIn("t-a"));
  const decision = await authorizeTarget(service, actorIn("t-a"), "target-1");
  assert.equal(decision.ok, true);
  assert.equal(decision.tenantId, "t-a");
  assert.equal(decision.target.id, "target-1");
});

test("an owner may not act on a user in another business", async () => {
  const service = stubService(targetIn("t-b"));
  const decision = await authorizeTarget(service, actorIn("t-a"), "target-1");
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 404);
});

test("and is told the account does not exist, not that they may not touch it", async () => {
  // "You may not act on that account" confirms the account exists, which is the answer somebody
  // probing a UUID is looking for. A stranger's account and a missing account read alike.
  const foreign = await authorizeTarget(stubService(targetIn("t-b")), actorIn("t-a"), "target-1");
  const absent = await authorizeTarget(stubService(null), actorIn("t-a"), "target-1");
  assert.deepEqual(foreign.body, absent.body);
  assert.equal(foreign.status, absent.status);
});

test("the tenant is loaded whether or not the caller asked for it", async () => {
  // A caller that lists its own columns must not be able to drop the one the decision needs.
  const service = stubService(targetIn("t-a"));
  await authorizeTarget(service, actorIn("t-a"), "target-1", { columns: "id,name,role" });
  const select = service.calls.find(([kind]) => kind === "select");
  assert.match(select[1], /tenant_id/);
});

test("an actor with no business of their own may act on nobody", async () => {
  const service = stubService(targetIn("t-a"));
  const decision = await authorizeTarget(service, { profile: { id: "x", role: "admin", admin_level: "owner", tenant_id: null } }, "target-1");
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 404);
});

test("a manager must name the business they are acting in", async () => {
  const service = stubService(targetIn("t-b"));
  const decision = await authorizeTarget(service, actorIn(null, "manager"), "target-1");
  assert.equal(decision.ok, false);
  assert.equal(decision.body.code, "tenant_context_required");
});

test("and naming the wrong one is refused too", async () => {
  const service = stubService(targetIn("t-b"));
  const decision = await authorizeTarget(service, actorIn(null, "manager"), "target-1", { requestedTenantId: "t-a" });
  assert.equal(decision.ok, false);
  assert.equal(decision.body.code, "tenant_context_required");
});

// Naming the business used to be the whole rule. It is now the first half of it: 202609010002
// added the second, that the manager must also have opened that business and said why. The
// tests for the second half are at the end of this file; this one holds the first half in place
// on its own, because a change that dropped it would still pass those.
test("a manager naming the right business gets past the naming rule", async () => {
  const service = stubService(targetIn("t-b"));
  const decision = await authorizeTarget(service, actorIn(null, "manager"), "target-1", { requestedTenantId: "t-b" });
  assert.equal(decision.ok, false);
  assert.notEqual(decision.body.code, "tenant_context_required",
    "the business was named correctly, so this is no longer what refuses it");
  assert.equal(decision.body.code, "support_context_required");
});

test("a missing identifier is refused before any lookup", async () => {
  const service = stubService(targetIn("t-a"));
  const decision = await authorizeTarget(service, actorIn("t-a"), "");
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 400);
  assert.equal(service.calls.length, 0, "a lookup ran for an empty identifier");
});

test("a failed lookup is an error, not an absent account", async () => {
  // Collapsing "the query failed" into "no such user" cost a day once already: the owner was
  // signed in and told their own account did not exist.
  const service = stubService(null, { error: { message: "permission denied" } });
  await assert.rejects(() => authorizeTarget(service, actorIn("t-a"), "target-1"),
    (e) => e.status === 500 && e.code === "target_lookup_failed");
});

test("the write carries the tenant, not only the check", async () => {
  // A check that runs before the update and is not repeated in it is a check that a tenant
  // change between the two walks straight past.
  const service = stubService(targetIn("t-a"));
  withinTenant(service.from("app_users").select("id").eq("id", "target-1"), "t-a");
  assert.ok(service.calls.some(([kind, column, value]) => kind === "eq" && column === "tenant_id" && value === "t-a"),
    "the update was not narrowed to the authorized tenant");
});

test("a row with no business is narrowed with IS NULL, not equality", async () => {
  const service = stubService(targetIn(null));
  withinTenant(service.from("app_users").select("id").eq("id", "target-1"), null);
  assert.ok(service.calls.some(([kind, column]) => kind === "is" && column === "tenant_id"),
    "a null tenant was compared with equality, which matches nothing");
});

/**
 * The vendor acts on a customer's business, and the customer can see it.
 *
 * The manager belongs to no business — app_users.tenant_id is null — and sarraf_sees_all_tenants()
 * is true, so every policy in the system lets them through. api/admin-user.js let them create an
 * account inside a business, deactivate one, change a partner's commission and reset anybody's
 * password, and nothing recorded that it happened, when, or why. A business owner who buys this
 * system had no way to know whether the vendor had been in their accounts.
 *
 * Now a manager acting on a business must have opened that business, with a reason, inside a
 * context that expires. Naming the business is not enough on its own; naming it and having it
 * open is.
 */

// The stub above answers `.from().select()...`; the support lookup goes through `.rpc()`.
const withSupport = (row, openTenant, { rpcError = null } = {}) => {
  const base = stubService(row);
  return {
    ...base,
    rpc: async (fn, args) => {
      base.calls.push(["rpc", fn, args?.p_manager_id]);
      if (rpcError) return { data: null, error: rpcError };
      return { data: openTenant, error: null };
    },
  };
};

const manager = () => ({
  profile: { id: "mgr-1", name: "Manager", role: "admin", admin_level: "manager", tenant_id: null },
});

test("a manager who has not opened the business is refused", async () => {
  const service = withSupport(targetIn("t-a"), null);
  const decision = await authorizeTarget(service, manager(), "target-1", { requestedTenantId: "t-a" });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
  assert.equal(decision.body.code, "support_context_required");
});

test("a manager who has opened that business may act", async () => {
  const service = withSupport(targetIn("t-a"), "t-a");
  const decision = await authorizeTarget(service, manager(), "target-1", { requestedTenantId: "t-a" });
  assert.equal(decision.ok, true);
  assert.equal(decision.tenantId, "t-a");
});

test("a manager who has opened a different business is refused, and told which", async () => {
  const service = withSupport(targetIn("t-a"), "t-b");
  const decision = await authorizeTarget(service, manager(), "target-1", { requestedTenantId: "t-a" });
  assert.equal(decision.ok, false);
  assert.equal(decision.body.code, "support_context_required");
  assert.match(decision.body.error, /بازرگانییەکی تر/);
});

test("the context is asked about the manager by name, since the server holds no session", async () => {
  const service = withSupport(targetIn("t-a"), "t-a");
  await authorizeTarget(service, manager(), "target-1", { requestedTenantId: "t-a" });
  const asked = service.calls.find(([kind]) => kind === "rpc");
  assert.deepEqual(asked, ["rpc", "sarraf_manager_support_tenant_for", "mgr-1"]);
});

test("a lookup that fails counts as no context, not as a way through", async () => {
  const service = withSupport(targetIn("t-a"), "t-a", { rpcError: new Error("unavailable") });
  const decision = await authorizeTarget(service, manager(), "target-1", { requestedTenantId: "t-a" });
  assert.equal(decision.ok, false);
  assert.equal(decision.body.code, "support_context_required");
});

test("naming the business is still required before the context is even asked about", async () => {
  const service = withSupport(targetIn("t-a"), "t-a");
  const decision = await authorizeTarget(service, manager(), "target-1");
  assert.equal(decision.ok, false);
  assert.equal(decision.body.code, "tenant_context_required");
});

test("platform work needs no business to open — an account belonging to none", async () => {
  // Creating another manager, or acting on an account with no business, is not an act on
  // somebody's business and has nothing to open.
  const service = withSupport(targetIn(null), null);
  const decision = await authorizeTarget(service, manager(), "target-1");
  assert.equal(decision.ok, true);
  assert.equal(decision.tenantId, null);
});

test("an owner is unaffected: they act in their own business with no context to open", async () => {
  const service = withSupport(targetIn("t-a"), null);
  const decision = await authorizeTarget(service, actorIn("t-a"), "target-1");
  assert.equal(decision.ok, true);
  assert.equal(service.calls.some(([kind]) => kind === "rpc"), false,
    "an owner's act should not consult a support context at all");
});

/**
 * Creating an account inside somebody's business is an act on that business.
 *
 * The other four actions all go through authorizeTarget, which demands the support context.
 * `create` does not, because there is no target to authorize yet — so the context was never
 * asked for on the one path that adds a person to a customer's business. A manager could put a
 * new administrator into somebody's accounts with nothing recorded.
 *
 * The rule is asked directly there instead. These drive the exported helper, which is what that
 * path consults.
 */
test("the manager's open business is what the create path is asked about", async () => {
  const { openSupportContext } = await import("../api/admin-user.js");
  const seen = [];
  const service = { rpc: async (fn, args) => { seen.push([fn, args?.p_manager_id]); return { data: "t-a", error: null }; } };
  const open = await openSupportContext(service, manager());
  assert.equal(open, "t-a");
  assert.deepEqual(seen, [["sarraf_manager_support_tenant_for", "mgr-1"]]);
});

test("no context open reads as no business open, not as any business", async () => {
  const { openSupportContext } = await import("../api/admin-user.js");
  const service = { rpc: async () => ({ data: null, error: null }) };
  assert.equal(await openSupportContext(service, manager()), null);
});

test("a lookup that fails reads as no business open", async () => {
  const { openSupportContext } = await import("../api/admin-user.js");
  const service = { rpc: async () => { throw new Error("unavailable"); } };
  assert.equal(await openSupportContext(service, manager()), null);
});

test("an owner is never asked about a support context — they have their own business", async () => {
  const { openSupportContext } = await import("../api/admin-user.js");
  let asked = false;
  const service = { rpc: async () => { asked = true; return { data: "t-a", error: null }; } };
  assert.equal(await openSupportContext(service, actorIn("t-a")), null);
  assert.equal(asked, false);
});

test("the create path in the source asks the same question the other four do", async () => {
  // Read rather than executed: the create branch needs Supabase Auth and a live service key,
  // and what is being held is that the rule is present on that path at all — it was absent, and
  // its absence looked exactly like the other four being correct.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../api/admin-user.js", import.meta.url), "utf8");
  const createBranch = source.slice(source.indexOf('if (action === "create")'),
                                   source.indexOf('if (action === "deactivate")'));
  assert.ok(createBranch.length > 200, "the create branch was not found");
  assert.match(createBranch, /openSupportContext\(/,
    "the create path does not ask whether the manager has opened this business");
  assert.match(createBranch, /support_context_required/);
});
