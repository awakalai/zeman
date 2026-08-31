import test from "node:test";
import assert from "node:assert/strict";
import { ACTOR_COLUMNS, isTenantless, sameTenant, withinTenant, notFound } from "../api/_tenant.js";
import { validateContext } from "../api/receipt-ingestion.js";

/**
 * Three routes hold the service key, and the service key switches row level security off for
 * everything they read and write. Two of them decided authorization by role alone:
 *
 *   · api/receipt-ocr.js allowed `actor.role === "admin"` to run OCR on any receipt document
 *     by id — downloading the image bytes of a receipt belonging to a different business;
 *   · api/receipt-ingestion.js treated any administrator or office as "staff" and then looked
 *     up the named customer and partner with the service key, checking only role and deleted.
 *     An administrator of one business could therefore open a batch against another business's
 *     customer, and the portal read policy — which matches on customer_id — would show that
 *     customer a batch from a business they have never dealt with.
 *
 * The third defect is not about who but about where the row lands: the recovery path in
 * receipt-ingestion.js writes through the service key, where auth.uid() is null, so the
 * tenant_id default of sarraf_tenant() yields null. A batch, its receipts, its intake rows and
 * its notification would all have belonged to no business — invisible to the people who sent
 * them and hidden from every administrator by the restrictive policies.
 */

const actor = (tenantId, role = "admin") => ({ id: "actor-1", role, deleted: false, tenant_id: tenantId, admin_level: role === "admin" ? "owner" : null });

// The smallest thing that answers `.from().select().eq()…maybeSingle()`, remembering the
// filters so a test can assert what actually reached the query.
const stubService = (rowsByTable) => {
  const calls = [];
  return {
    calls,
    from(table) {
      const builder = {
        select(columns) { calls.push(["select", table, columns]); return builder; },
        eq(column, value) { calls.push(["eq", table, column, value]); return builder; },
        maybeSingle: async () => ({ data: rowsByTable[table] ?? null, error: null }),
      };
      return builder;
    },
  };
};

const batch = { id: "b-1", customer_id: "cust-1", direction: "in", currency: "CNY" };

test("the actor lookup asks for the tenant, or nothing below it can be checked", () => {
  assert.ok(ACTOR_COLUMNS.split(",").includes("tenant_id"));
});

test("an actor with no business belongs to no business", () => {
  assert.equal(isTenantless({ id: "m", tenant_id: null }), true);
  assert.equal(isTenantless({ id: "o", tenant_id: "t-a" }), false);
});

test("two rows of the same business are the same business", () => {
  assert.equal(sameTenant({ tenant_id: "t-a" }, { tenant_id: "t-a" }), true);
});

test("two rows of different businesses are not", () => {
  assert.equal(sameTenant({ tenant_id: "t-a" }, { tenant_id: "t-b" }), false);
});

test("a row belonging to no business is refused rather than shared by everybody", () => {
  assert.equal(sameTenant({ tenant_id: "t-a" }, { tenant_id: null }), false);
  assert.equal(sameTenant({ tenant_id: null }, { tenant_id: null }), false);
});

test("a query without a business is a bug, and says so instead of matching everything", () => {
  assert.throws(() => withinTenant({}, null), /without a business/);
});

test("withinTenant puts the business into the query", () => {
  const seen = [];
  withinTenant({ eq: (c, v) => seen.push([c, v]) }, "t-a");
  assert.deepEqual(seen, [["tenant_id", "t-a"]]);
});

test("the refusal about somebody else's receipt says only that it was not found", () => {
  const error = notFound("receipt");
  assert.equal(error.status, 404);
  assert.equal(error.code, "receipt_not_found");
});

test("an administrator may open a batch for a customer of their own business", async () => {
  const service = stubService({ app_users: { id: "cust-1", name: "Ali", role: "customer", deleted: false, tenant_id: "t-a" } });
  const context = await validateContext(service, actor("t-a"), batch);
  assert.equal(context.customerId, "cust-1");
  assert.equal(context.tenantId, "t-a");
});

test("an administrator may not open a batch for another business's customer", async () => {
  const service = stubService({ app_users: { id: "cust-1", name: "Ali", role: "customer", deleted: false, tenant_id: "t-b" } });
  await assert.rejects(() => validateContext(service, actor("t-a"), batch), (e) => e.code === "invalid_customer");
});

test("an administrator may not name another business's partner either", async () => {
  const service = stubService({ app_users: { id: "p-1", role: "partner", deleted: false, tenant_id: "t-b" } });
  await assert.rejects(
    () => validateContext(service, actor("t-a"), { ...batch, customer_id: null, partner_id: "p-1" }),
    (e) => e.code === "invalid_partner",
  );
});

test("the customer lookup asks for the tenant it is about to compare", async () => {
  const service = stubService({ app_users: { id: "cust-1", name: "Ali", role: "customer", deleted: false, tenant_id: "t-a" } });
  await validateContext(service, actor("t-a"), batch);
  const select = service.calls.find(([kind, table]) => kind === "select" && table === "app_users");
  assert.ok(select[2].includes("tenant_id"));
});

test("a manager, who has no business of their own, does not send receipts", async () => {
  const service = stubService({ app_users: { id: "cust-1", role: "customer", deleted: false, tenant_id: "t-a" } });
  await assert.rejects(
    () => validateContext(service, { ...actor(null), admin_level: "manager" }, batch),
    (e) => e.code === "context_denied",
  );
});

test("a customer may still send their own receipts", async () => {
  const service = stubService({ app_users: { id: "cust-1", name: "Ali", role: "customer", deleted: false, tenant_id: "t-a" } });
  const context = await validateContext(service, { id: "cust-1", role: "customer", deleted: false, tenant_id: "t-a" }, batch);
  assert.equal(context.customerId, "cust-1");
});

test("a customer may not send a batch about somebody else", async () => {
  const service = stubService({ app_users: { id: "cust-1", role: "customer", deleted: false, tenant_id: "t-a" } });
  await assert.rejects(
    () => validateContext(service, { id: "cust-9", role: "customer", deleted: false, tenant_id: "t-a" }, batch),
    (e) => e.code === "context_denied",
  );
});

test("the recovery path names the business on every row it writes", async () => {
  // The source is read rather than executed: the recovery path needs a live PostgREST and a
  // storage bucket, and what is being asserted is that no row leaves here without a business.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../api/receipt-ingestion.js", import.meta.url), "utf8");
  const writes = source.split("\n").filter((line) => /^\s*(await )?(const \w+ = await )?(insertCompat|service\.from\("(receipts|receipt_batches|receipt_intake_items|notes)"\)\.insert)/.test(line));
  assert.ok(writes.length >= 3, `expected the recovery path's inserts, found ${writes.length}`);
  assert.equal((source.match(/tenant_id: context\.tenantId/g) || []).length, 4,
    "each of the four row shapes the recovery path writes must name the business");
});
