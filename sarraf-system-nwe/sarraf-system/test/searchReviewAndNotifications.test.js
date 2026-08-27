import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { safeCommand } from "../src/services/operationalControl.js";
import { loadReplacementChain } from "../src/services/receiptWorkspace.js";

/**
 * Three things a person does with a receipt after it exists: find it, understand it, act on it.
 *
 * Each of them was half-built. The search matched prefixes, so a code read out down a phone
 * could not be typed in at the other end. The review screen showed a receipt with no name and no
 * history, so a replacement arrived as an unexplained second claim on money already refused
 * once. And the bell marked itself read and led nowhere.
 */

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const palette = readFileSync(new URL("../src/components/operations/OperationalPalette.jsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../src/components/receipts/ReceiptReviewWorkspace.jsx", import.meta.url), "utf8");
const bell = readFileSync(new URL("../src/components/system/NotificationBell.jsx", import.meta.url), "utf8");

// ── find it ──────────────────────────────────────────────────────────────────

test("a search result still cannot smuggle a query string into navigation", () => {
  assert.equal(safeCommand({ kind: "navigation", path: "#/receipts" }), true);
  assert.equal(safeCommand({ kind: "navigation", path: "#/receipts?x=1" }), false);
  assert.equal(safeCommand({ kind: "navigation", path: "javascript:alert(1)" }), false);
  assert.equal(safeCommand({ path: "#/receipts" }), false, "only a navigation command is one");
});

test("the palette says the kind of result in the language that is on", () => {
  assert.match(palette, /kindLabel\(lang, item\.type\)/,
    "the palette prints the database's own English word for a result");
  for (const kind of ["customer", "partner", "transaction", "receipt", "intake", "batch", "currency"]) {
    assert.ok(new RegExp(`${kind}:`).test(palette), `no label for a ${kind} result`);
  }
});

test("choosing a result says which record it was about", () => {
  assert.match(palette, /onNavigate\(item\.path, item\.focus \|\| null\)/,
    "the result's subject is dropped, so the receipts page opens at the top of a long list");
  assert.match(app, /onNavigate=\{\(path, focus\) =>/, "the application ignores what was chosen");
  assert.match(app, /setBatchSearch\(searchFocus\)/,
    "the receipts screen does not open on the batch the search found");
});

// ── understand it ────────────────────────────────────────────────────────────

test("the chain is not read when there is nothing to read", async () => {
  const refuse = { from: () => { throw new Error("the chain was fetched for a receipt with none"); } };
  assert.equal(await loadReplacementChain(refuse, { id: "d1" }), null);
  assert.equal(await loadReplacementChain(refuse, null), null);
});

test("the chain reports both directions, and survives a row it cannot see", async () => {
  const client = {
    from: () => ({
      select: () => ({
        in: async () => ({
          data: [{ id: "old", tracking_code: "ZR-1", state: "rejected", rule_reason: "وێنەکە ڕوون نییە" }],
          error: null,
        }),
      }),
    }),
  };
  const chain = await loadReplacementChain(client, {
    id: "new", replacesDocumentId: "old", replacedByDocumentId: "gone",
  });
  assert.equal(chain.replaces.trackingCode, "ZR-1");
  assert.equal(chain.replaces.ruleReason, "وێنەکە ڕوون نییە",
    "the reviewer is not told why the receipt this one replaces was refused");
  assert.deepEqual(chain.replacedBy, { id: "gone" },
    "a link to a row the reviewer cannot read must still be reported, not dropped");
});

test("the reviewer is shown the code and the reason a replacement exists", () => {
  assert.match(workspace, /detail\.document\?\.trackingCode/, "the receipt under review has no name on screen");
  assert.match(workspace, /chain\?\.replaces &&/, "nothing says this receipt replaces a refused one");
  assert.match(workspace, /chain\.replaces\.ruleReason/, "the earlier refusal's reason is not shown");
  assert.match(workspace, /loadReplacementChain\(client, d\.document\)/, "the chain is never loaded");
});

// ── act on it ────────────────────────────────────────────────────────────────

test("a notification opens what it is about", () => {
  assert.match(bell, /const openOne = async \(item\) => \{\s*if \(onOpen\)/,
    "opening a notification only marks it read");
  assert.match(app, /onOpen=\{openNotification\}/, "the bell is given nowhere to send anybody");
  assert.match(app, /if \(item\.subjectKind === "batch"\)/, "a batch notification leads nowhere");
});

// A notification whose target has no screen must leave the panel open rather than close it on
// somebody who then has no idea whether anything happened.
test("a notification with nowhere to go leaves the panel where it was", () => {
  assert.match(app, /if \(!item\?\.subjectId\) return false;/,
    "a notification with no subject still closes the panel as though it did something");
  assert.match(bell, /if \(handled\) setOpen\(false\);/,
    "the panel closes whether or not anything was opened");
});
