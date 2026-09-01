import test from "node:test";
import assert from "node:assert/strict";
import {
  openBusiness, ownerEmailObjection, ownerNameObjection, supportReasonObjection,
} from "../src/services/managerConsole.js";

/**
 * A new customer buys ZEMAN.
 *
 * createTenant made the business and stopped there. Nobody could sign into it, and the manager's
 * next act was on a different screen — so a manager who forgot the second step left a business
 * that looked created and was unusable. Selling this means doing it once per customer, without
 * remembering a second step.
 *
 * No password is created or held anywhere by this path. What is written is a row saying who a
 * login will be; the owner is invited through Supabase and becomes the owner on first sign-in.
 */

const client = (result = { id: "t-new" }) => {
  const calls = [];
  return { calls, rpc: async (fn, args) => { calls.push({ fn, args }); return { data: result, error: null }; } };
};

test("opening a business names the owner in the same call", async () => {
  const c = client({ id: "t-new", next: "invite them" });
  const out = await openBusiness(c, {
    id: "t-new", name: "بازرگانیی نوێ", ownerEmail: "Owner@Example.COM", ownerName: "خاوەن",
  });
  assert.equal(out.id, "t-new");
  assert.equal(c.calls.length, 1, "the business and its owner are one act, not two");
  assert.equal(c.calls[0].fn, "sarraf_manager_open_business");
  assert.equal(c.calls[0].args.p_owner_email, "owner@example.com", "the email is folded to lower case");
  assert.equal(c.calls[0].args.p_id, "t-new");
});

test("no password crosses this path at all", async () => {
  const c = client();
  await openBusiness(c, { id: "t-new", name: "ناو", ownerEmail: "a@b.co", ownerName: "خاوەن" });
  const sent = JSON.stringify(c.calls[0].args).toLowerCase();
  assert.ok(!sent.includes("password"), "a password reached the onboarding call");
});

test("a business is not opened without an owner to open it", async () => {
  const c = client();
  await assert.rejects(() => openBusiness(c, { id: "t-new", name: "ناو", ownerName: "خاوەن" }));
  await assert.rejects(() => openBusiness(c, { id: "t-new", name: "ناو", ownerEmail: "a@b.co" }));
  assert.equal(c.calls.length, 0, "the server was asked to make a business with no owner");
});

test("nor with an id or a name the database would refuse", async () => {
  const c = client();
  await assert.rejects(() => openBusiness(c, { id: "T NEW", name: "ناو", ownerEmail: "a@b.co", ownerName: "خ" }));
  await assert.rejects(() => openBusiness(c, { id: "t-new", name: "", ownerEmail: "a@b.co", ownerName: "خاوەن" }));
  assert.equal(c.calls.length, 0);
});

test("what is not an email address is refused before the round trip", () => {
  for (const bad of ["", "owner", "owner@", "@example.com", "owner@example", "a b@c.co"]) {
    assert.ok(ownerEmailObjection(bad), `${bad} was accepted as an email`);
  }
  assert.equal(ownerEmailObjection("owner@example.com"), null);
  assert.equal(ownerEmailObjection("  Owner@Example.Com  "), null);
});

test("a name of one letter is not a name", () => {
  assert.ok(ownerNameObjection("خ"));
  assert.equal(ownerNameObjection("خاوەن"), null);
});

test("every refusal a manager can read is written in their own language", () => {
  for (const lang of ["ku", "en", "ar"]) {
    const email = ownerEmailObjection("nope", lang);
    const name = ownerNameObjection("x", lang);
    const reason = supportReasonObjection("short", lang);
    for (const [what, text] of [["email", email], ["name", name], ["reason", reason]]) {
      assert.ok(text && text.length > 5, `${what} has no sentence in ${lang}`);
    }
    if (lang === "en") {
      assert.match(email, /[A-Za-z]/, "the English refusal is not in English");
      assert.match(reason, /[A-Za-z]/);
    }
  }
});

test("the refusals differ between languages, rather than one being copied", () => {
  const ku = ownerEmailObjection("nope", "ku");
  const en = ownerEmailObjection("nope", "en");
  const ar = ownerEmailObjection("nope", "ar");
  assert.notEqual(ku, en);
  assert.notEqual(en, ar);
  assert.notEqual(ku, ar);
});

test("a refusal from the database is raised, not turned into a success", async () => {
  const c = { rpc: async () => ({ data: null, error: new Error("that email already has an account") }) };
  await assert.rejects(
    () => openBusiness(c, { id: "t-new", name: "ناو", ownerEmail: "a@b.co", ownerName: "خاوەن" }),
    /already has an account/,
  );
});
