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

test("a manager naming the right business may act", async () => {
  const service = stubService(targetIn("t-b"));
  const decision = await authorizeTarget(service, actorIn(null, "manager"), "target-1", { requestedTenantId: "t-b" });
  assert.equal(decision.ok, true);
  assert.equal(decision.tenantId, "t-b");
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
