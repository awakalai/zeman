import test from "node:test";
import assert from "node:assert/strict";
import {
  byRank, grantableRanks, isManager, isOwner, lastManagerObjection,
  passwordObjection, passwordTooShort, rankName, rankObjection, rankOf,
} from "../src/services/adminRanks.js";

const manager = { id: "m", role: "admin", adminLevel: "manager", name: "ماناجەر" };
const owner = { id: "o", role: "admin", adminLevel: "owner", name: "سەرخێڵ" };
const operator = { id: "p", role: "admin", adminLevel: "operator", name: "ئەدمین" };
const customer = { id: "c", role: "customer", name: "کڕیار" };

test("an administrator with no rank recorded is the least, never the greatest", () => {
  assert.equal(rankOf({ role: "admin" }), "operator");
  assert.equal(isManager({ role: "admin" }), false);
  assert.equal(isOwner({ role: "admin" }), false);
});

test("a manager outranks an owner, so counts as one", () => {
  assert.equal(isOwner(manager), true);
  assert.equal(isManager(manager), true);
  assert.equal(isManager(owner), false);
  assert.equal(isOwner(owner), true);
});

test("somebody who is not an administrator has no rank at all", () => {
  assert.equal(rankOf(customer), null);
  assert.equal(isOwner(customer), false);
});

test("nobody may hand out a rank above their own", () => {
  assert.deepEqual(grantableRanks(manager), ["manager", "owner", "operator"]);
  assert.deepEqual(grantableRanks(owner), ["owner", "operator"]);
  assert.deepEqual(grantableRanks(operator), []);
  assert.deepEqual(grantableRanks(customer), []);
});

test("an owner cannot appoint a manager", () => {
  assert.match(rankObjection(owner, operator, "manager"), /پلەیەک بدەیت کە خۆت نایتە/);
  assert.equal(rankObjection(manager, operator, "owner"), null);
});

test("only a manager touches a manager's rank", () => {
  assert.match(rankObjection(owner, manager, "operator"), /تەنها ماناجەر/);
  assert.equal(rankObjection(manager, manager, "operator"), null);
});

test("a rank that is already set is refused, so the button says why", () => {
  assert.match(rankObjection(manager, owner, "owner"), /پلەکەی هەر ئەوەیە/);
});

test("only an administrator has a rank to change", () => {
  assert.match(rankObjection(manager, customer, "owner"), /تەنها ئەدمین/);
});

test("a manager may reset anyone's password", () => {
  assert.equal(passwordObjection(manager, owner), null);
  assert.equal(passwordObjection(manager, operator), null);
  assert.equal(passwordObjection(manager, customer), null);
});

// Otherwise an owner could take the system from a manager by changing their password.
test("an owner may reset their own staff and ordinary users, and nobody above", () => {
  assert.equal(passwordObjection(owner, operator), null);
  assert.equal(passwordObjection(owner, customer), null);
  assert.match(passwordObjection(owner, manager), /تەنها لەلایەن ماناجەرەوە/);
  assert.match(passwordObjection(owner, { ...owner, id: "o2" }), /تەنها لەلایەن ماناجەرەوە/);
});

test("staff may restore an ordinary user's login but never an administrator account", () => {
  assert.equal(passwordObjection(operator, customer), null);
  assert.match(passwordObjection(operator, owner), /دەسەڵاتت نییە/);
});

test("a deactivated account has no password worth setting", () => {
  assert.match(passwordObjection(manager, { ...customer, deleted: true }), /ناچالاک/);
});

test("the password minimum is stated once, and enforced from it", () => {
  assert.match(passwordTooShort("short"), /لانیکەم 12 پیت/);
  assert.equal(passwordTooShort("123456789012"), null);
});

test("the last manager cannot be demoted", () => {
  const users = [manager, owner, operator];
  assert.match(lastManagerObjection(users, manager, "operator"), /دوایین ماناجەر/);
});

test("a manager may be demoted once another exists", () => {
  const users = [manager, { ...manager, id: "m2" }, owner];
  assert.equal(lastManagerObjection(users, manager, "operator"), null);
});

test("a deactivated manager does not count as the spare", () => {
  const users = [manager, { ...manager, id: "m2", deleted: true }];
  assert.match(lastManagerObjection(users, manager, "operator"), /دوایین ماناجەر/);
});

test("keeping a manager a manager is never the last-manager problem", () => {
  assert.equal(lastManagerObjection([manager], manager, "manager"), null);
  assert.equal(lastManagerObjection([manager], owner, "operator"), null);
});

test("administrators read top down, highest rank first", () => {
  const sorted = [operator, manager, owner].sort(byRank).map((u) => rankOf(u));
  assert.deepEqual(sorted, ["manager", "owner", "operator"]);
});

test("a rank is named the way a person names it", () => {
  assert.equal(rankName("manager", "ku"), "ماناجەر");
  assert.equal(rankName("owner", "ku"), "سەرخێڵ");
  assert.equal(rankName("operator", "en"), "Admin");
  assert.equal(rankName(null), "—");
});
