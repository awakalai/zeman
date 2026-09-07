import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_ROUTES, UNAVAILABLE_ROUTES, paymentRouteChoices, paymentRouteLabel,
  paymentRouteEffect, paymentRouteObjection, paymentRouteObjectionText,
} from "../src/services/paymentRoute.js";

// «شێوازی پارەدانی مامەڵە بە تەواوی لەلایەن خاوەن/کارمەند دیاری بکرێت.» — section 12

test("a sale offers all four routes and a purchase offers three", () => {
  // A purchase is money leaving this business, so there is no balance of the seller's to take
  // it from. Offering it would be offering something the server has to refuse.
  assert.deepEqual(paymentRouteChoices("sell").map(([v]) => v), PAYMENT_ROUTES);
  assert.deepEqual(paymentRouteChoices("buy").map(([v]) => v),
    ["owner_direct", "office", "becomes_debt"]);
});

test("every route has words in all three languages", () => {
  for (const lang of ["ku", "en", "ar"]) {
    for (const route of [...PAYMENT_ROUTES, ...UNAVAILABLE_ROUTES]) {
      const label = paymentRouteLabel(route, lang);
      assert.notEqual(label, route, `${route} has no ${lang} label`);
      assert.ok(label.trim().length > 0);
    }
  }
});

test("each route says what it does to the transaction", () => {
  assert.deepEqual(paymentRouteEffect("owner_direct"),
    { status: "completed", needsOffice: false, needsCustomer: false, drawsOnBalance: false });
  assert.deepEqual(paymentRouteEffect("office"),
    { status: "pending", needsOffice: true, needsCustomer: true, drawsOnBalance: false });
  assert.deepEqual(paymentRouteEffect("customer_balance"),
    { status: "completed", needsOffice: false, needsCustomer: true, drawsOnBalance: true });
  assert.deepEqual(paymentRouteEffect("becomes_debt"),
    { status: "pending", needsOffice: false, needsCustomer: true, drawsOnBalance: false });
});

test("exactly one route draws on the customer's balance", () => {
  // The whole reason for this module. It used to happen on every sale to a customer who had a
  // balance, whatever the person recording it had in mind.
  const drawing = PAYMENT_ROUTES.filter((r) => paymentRouteEffect(r).drawsOnBalance);
  assert.deepEqual(drawing, ["customer_balance"]);
});

test("a route that needs an office says so before the press", () => {
  assert.equal(paymentRouteObjection("office", { customerId: "cust-1" }), "needOffice");
  assert.equal(paymentRouteObjection("office", { customerId: "cust-1", officeId: "off-1" }), null);
});

test("the three routes that leave a trail need somebody the books can find again", () => {
  // A free-typed name cannot be sent a reminder, cannot hold a balance and cannot be settled.
  for (const route of ["office", "customer_balance", "becomes_debt"]) {
    assert.equal(paymentRouteObjection(route, { officeId: "off-1" }), "needCustomer", route);
  }
  // Paying it yourself needs nobody registered: a walk-in with a name is a customer too.
  assert.equal(paymentRouteObjection("owner_direct", {}), null);
});

test("the fifth route is named and refused, not silently absent", () => {
  // Section 12 lists five. Settling against a mutual debt is done in the debt centre, where
  // both sides and their currencies are in front of the person doing it.
  assert.deepEqual(UNAVAILABLE_ROUTES, ["mutual_offset"]);
  assert.equal(paymentRouteObjection("mutual_offset", { customerId: "cust-1" }), "unavailable");
  assert.ok(paymentRouteLabel("mutual_offset", "ku").includes("ناوەندی قەرز"));
});

test("something that is not a route at all is refused", () => {
  assert.equal(paymentRouteEffect("whatever_i_typed"), null);
  assert.equal(paymentRouteObjection("whatever_i_typed", { customerId: "cust-1" }), "unavailable");
  assert.equal(paymentRouteObjection(undefined, {}), "unavailable");
});

test("an objection is a code, and the words come after", () => {
  // A caller that matched on English text would break the day somebody switched to Kurdish.
  const code = paymentRouteObjection("office", { customerId: "c" });
  assert.equal(code, "needOffice");
  assert.notEqual(paymentRouteObjectionText(code, "ku"), paymentRouteObjectionText(code, "en"));
});
