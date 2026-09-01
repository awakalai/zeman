import test from "node:test";
import assert from "node:assert/strict";
import { judgePassword, MIN_PASSWORD_LENGTH } from "../api/_password.js";

/**
 * The rule was written twice and disagreed with itself.
 *
 * `create` demanded eight characters. `reset_password` demanded eight and told the caller it
 * wanted twelve. The screen's label said eight. Whichever number was right, the person setting
 * the password read one rule while the server applied another, which reads as the system being
 * broken rather than as a password being refused.
 *
 * It is one rule now, in api/_password.js, and it is twelve. Eight characters of anything is
 * inside reach of an offline attack on a leaked hash, and this system holds a business's whole
 * ledger. No composition requirements: one capital, one digit, one symbol measurably produces
 * worse passwords, because everybody satisfies them the same way and then reuses the result.
 */

test("the floor is twelve, and it is one number", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12);
  assert.equal(judgePassword("a".repeat(11) + "Z").ok, true);
  assert.equal(judgePassword("Short1!").ok, false);
});

test("a short password is refused for being short, and says so", () => {
  const verdict = judgePassword("abcdefg");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "password_too_short");
  assert.match(verdict.error, /١٢/, "the sentence counts in the digits the rest of the interface uses");
});

test("a long passphrase is accepted, with no capital, digit or symbol in it", () => {
  assert.equal(judgePassword("correct horse battery staple").ok, true);
});

test("what gets tried first is refused", () => {
  for (const tried of ["password1234", "PASSWORD1234", "123456789012", "letmein12345"]) {
    const verdict = judgePassword(tried);
    assert.equal(verdict.ok, false, `${tried} was accepted`);
    assert.equal(verdict.code, "password_too_common");
  }
});

test("one character twelve times is not twelve characters", () => {
  assert.equal(judgePassword("aaaaaaaaaaaa").code, "password_too_common");
  assert.equal(judgePassword("111111111111").code, "password_too_common");
});

test("a walk along the keyboard is refused in both directions", () => {
  assert.equal(judgePassword("abcdefghijkl").code, "password_too_common");
  assert.equal(judgePassword("lkjihgfedcba").code, "password_too_common");
});

test("the account's own phone number is not a secret from anybody who can see the account", () => {
  const verdict = judgePassword("zx9647701234567qw", { phone: "9647701234567" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "password_is_the_phone");
});

test("nor is the account's own name", () => {
  const verdict = judgePassword("bryarbryarbryar", { name: "Bryar" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "password_is_the_name");
});

test("a short name is not enough to refuse on — too many passwords contain three letters", () => {
  assert.equal(judgePassword("a-good-long-passphrase", { name: "Ali" }).ok, true);
});

test("padding is refused, because it is invisible and gets trimmed somewhere later", () => {
  assert.equal(judgePassword(" a-good-long-passphrase ").code, "password_padded");
});

test("nothing at all is refused as too short, not accepted as empty", () => {
  for (const nothing of ["", null, undefined]) {
    assert.equal(judgePassword(nothing).code, "password_too_short");
  }
});

test("every refusal carries a code and a sentence a person can act on", () => {
  for (const bad of ["", "short", "password1234", "aaaaaaaaaaaa", " padded-out-here "]) {
    const verdict = judgePassword(bad);
    assert.equal(verdict.ok, false);
    assert.match(verdict.code, /^password_/);
    assert.ok(verdict.error.length > 10, `${verdict.code} has no sentence`);
  }
});
