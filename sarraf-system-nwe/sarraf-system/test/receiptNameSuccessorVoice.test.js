import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mayBeReplaced, receiptOutcome } from "../src/services/receiptIntake.js";
import { NOTIFICATION_KINDS, notificationTone, subscribeToNotifications } from "../src/services/notifications.js";

/**
 * The three things the owner asked for and the system did not have.
 *
 *   ٥. کۆدی تایبەت (Unique Tracking ID)
 *   ٤. دووبارە بارکردنەوە، بەستراوە بە فیشە ڕەتکراوەکەی پێشوو
 *   ٥. سیستەمی ئاگادارکردنەوە بۆ هەردولا
 *
 * The database half is gated by verify:isolation. What is here is the half a database cannot
 * check: that the browser reads the state the way the specification names it, and — the fault
 * that has bitten this repository more than any other — that the code which exists is actually
 * reached by a screen. `sarraf_my_receipt_intakes` has existed since 12 August and no line of
 * the application has ever called it, so a customer whose receipt was refused was told nothing
 * for a fortnight by a function written to tell them.
 */

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

test("the four outcomes are the four the owner named", () => {
  assert.equal(receiptOutcome({ state: "needs_manual_review" }), "pending");
  assert.equal(receiptOutcome({ state: "validated" }), "pending");
  assert.equal(receiptOutcome({ state: "accepted" }), "approved");
  assert.equal(receiptOutcome({ state: "finalized" }), "approved");
  assert.equal(receiptOutcome({ state: "rejected" }), "rejected");
  assert.equal(receiptOutcome({ state: "duplicate" }), "rejected");
});

// REPLACED is never stored. A stored copy of it is a second answer that can disagree with the
// link, and the two disagreeing is exactly the audit hole the link was added to close.
test("a refused receipt reads as replaced once something is sent in its place", () => {
  const refused = { state: "rejected" };
  assert.equal(receiptOutcome(refused), "rejected");
  assert.equal(receiptOutcome({ ...refused, replacedBy: "doc-2" }), "replaced");
});

test("only a refused receipt with no successor offers the re-upload", () => {
  assert.equal(mayBeReplaced({ state: "rejected" }), true);
  assert.equal(mayBeReplaced({ state: "rejected", replacedBy: "doc-2" }), false,
    "a receipt already replaced would let the uploader fork the chain");
  assert.equal(mayBeReplaced({ state: "needs_manual_review" }), false,
    "a receipt still under review would be replaced before anyone had refused it");
  assert.equal(mayBeReplaced({ state: "accepted" }), false);
});

test("every kind the database may write has a tone the bell can draw", () => {
  for (const kind of NOTIFICATION_KINDS) {
    assert.ok(notificationTone(kind), `${kind} has no tone`);
  }
  assert.equal(notificationTone("receipt_rejected"), "red");
  assert.equal(notificationTone("receipt_accepted"), "green");
});

// A client with no realtime — an old bundle, a stub, a test — must not take the screen down, and
// must still hand back something the caller can safely call on cleanup.
test("subscribing without realtime returns an unsubscribe rather than throwing", () => {
  const stop = subscribeToNotifications({}, () => {});
  assert.equal(typeof stop, "function");
  stop();
});

// Originally: a bell of its own. That was wrong — the application already had a notification
// centre, and a second bell beside it meant two unread counts in one header with nothing to say
// which was which. The receipt events now arrive in the one panel that already existed.
test("the receipt events reach the notification centre that already existed", () => {
  assert.match(app, /import \{ loadNotifications, markAllNotificationsRead, markNotificationRead, subscribeToNotifications \}/,
    "the application does not read the receipt notifications at all");
  assert.match(app, /loadNotifications\(supabase/, "nothing loads them");
  assert.match(app, /subscribeToNotifications\(supabase/, "they are never heard as they happen");
  assert.ok(!/NotificationBell/.test(app), "a second bell is back beside the first");
});

test("the uploader's own receipts are actually shown, and can be replaced", () => {
  assert.match(app, /import \{ MyReceipts \}/, "the uploader's own list is not imported");
  assert.match(app, /<MyReceipts /, "the uploader's own list is never rendered");
  assert.match(app, /onReplace=\{replaceOne\}/, "nothing is wired to the re-upload button");
  assert.match(app, /await replaceReceipt\(supabase, receipt\.id, intake\.documentId\)/,
    "a replacement is uploaded but never linked to the receipt it replaces");
});

test("the owner's receipt list quotes the receipt's name", () => {
  assert.match(app, /\{r\.tracking_code\}/,
    "the owner cannot see the code the person who sent it would quote");
});
