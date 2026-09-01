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

/**
 * Which business needs the vendor, and why.
 *
 * The list of businesses answers "what exists". The live database had one nobody had ever been
 * inside — the owner had a login and had never passed the MFA gate — and the console said
 * nothing. It took a database inspection to find, and the vendor would have found out when the
 * customer rang.
 *
 * A single "unhealthy" flag would collapse "nobody has ever signed in" and "quiet for forty
 * days" into one colour. They are different problems with different answers.
 */
const { attentionReasons } = await import("../src/services/managerConsole.js");

test("a business nobody has opened says so, first", () => {
  const reasons = attentionReasons({ never_opened: true, active: true }, "en");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /Nobody has ever signed in/);
});

test("a business with nothing wrong says nothing", () => {
  assert.deepEqual(attentionReasons({ never_opened: false, active: true, quiet: false }, "en"), []);
  assert.deepEqual(attentionReasons({}, "ku"), []);
});

test("each reason is its own sentence, not one flag", () => {
  const reasons = attentionReasons(
    { never_opened: true, active: false, quiet: true, without_mfa: 2, receipts_waiting: 3 }, "en");
  assert.equal(reasons.length, 5, `expected five distinct reasons, got: ${reasons.join(" | ")}`);
  assert.equal(new Set(reasons).size, 5, "two reasons read the same");
});

test("a count is shown where a count is what is meant", () => {
  const reasons = attentionReasons({ receipts_waiting: 7, active: true }, "en");
  assert.match(reasons[0], /\(7\)/);
});

test("zero is not a reason", () => {
  const reasons = attentionReasons(
    { active: true, without_mfa: 0, receipts_waiting: 0, entries_unposted: 0, waiting_to_claim: 0 }, "en");
  assert.deepEqual(reasons, []);
});

test("every reason reads in the language it was asked for", () => {
  const business = { never_opened: true, active: false, quiet: true, without_mfa: 1 };
  const ku = attentionReasons(business, "ku");
  const en = attentionReasons(business, "en");
  const ar = attentionReasons(business, "ar");
  assert.equal(ku.length, en.length);
  assert.equal(en.length, ar.length);
  for (let i = 0; i < en.length; i += 1) {
    assert.match(en[i], /[A-Za-z]/, `the English reason ${i} is not in English`);
    assert.notEqual(ku[i], en[i], `reason ${i} is the same in Kurdish and English`);
    assert.notEqual(en[i], ar[i], `reason ${i} is the same in English and Arabic`);
  }
});

test("the suspended reason says it still reads, which is the whole point", () => {
  const reasons = attentionReasons({ active: false }, "en");
  assert.match(reasons[0], /reads/i,
    "a suspended business keeps every right to read its own books, and the console should say so");
});
