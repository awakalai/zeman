import test from "node:test";
import assert from "node:assert/strict";
import {
  whatsappNumber, whatsappLink, debtReminderMessage, debtReminderWhatsapp,
} from "../src/services/whatsapp.js";

// «WhatsApp API ئێستا ئامادە نییە؛ بۆیە دوگمەی WhatsApp پەیامێکی ئامادە دروست بکات و WhatsApp
//  بکاتەوە تا بەکارهێنەر خۆی بینێرێت.» — section 20
//
// Nothing here sends. These hold the shape of what a person is handed to send themselves.

test("the same person written four ways is one number", () => {
  // A number stored as any of these is the same customer, and wa.me accepts exactly one shape.
  assert.equal(whatsappNumber("07501234567"), "9647501234567");
  assert.equal(whatsappNumber("+964 750 123 4567"), "9647501234567");
  assert.equal(whatsappNumber("00964 750 123 4567"), "9647501234567");
  assert.equal(whatsappNumber("964-750-123-4567"), "9647501234567");
});

test("a number typed on a Kurdish keyboard is still a number", () => {
  assert.equal(whatsappNumber("٠٧٥٠١٢٣٤٥٦٧"), "9647501234567");
});

test("nothing usable gives null, not a broken link", () => {
  // A dead button lands on "this number is not on WhatsApp", which the owner reads as the
  // customer's fault. The screen must be able to hide it instead.
  for (const bad of [null, undefined, "", "   ", "abc", "---", "07", "0750123456789012345"]) {
    assert.equal(whatsappNumber(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  assert.equal(whatsappLink("", "hello"), null);
  assert.equal(debtReminderWhatsapp({ outstanding: 1, currency: "USD" }, { phone: "" }), null);
});

test("the link carries the message, encoded", () => {
  const href = whatsappLink("07501234567", "سڵاو، ٥٠ دۆلار");
  assert.ok(href.startsWith("https://wa.me/9647501234567?text="));
  assert.ok(!href.includes(" "), "a raw space would truncate the message");
  assert.equal(decodeURIComponent(href.split("text=")[1]), "سڵاو، ٥٠ دۆلار");
});

test("a message says what is owed, when, and why", () => {
  const text = debtReminderMessage(
    { outstanding: 1250.5, currency: "USD", openedAt: "2026-08-01T10:00:00Z",
      dueAt: "2026-09-01T10:00:00Z", reason: "مامەڵەی نەدراوە" },
    { lang: "ku", debtorName: "ئاسۆ", businessName: "ZEMAN" });
  assert.ok(text.includes("ئاسۆ"), "it greets them by name");
  assert.ok(text.includes("1,250.50 USD"), "it names the amount");
  assert.ok(text.includes("2026-08-01"), "it says when it opened");
  assert.ok(text.includes("2026-09-01"), "it says when it is due");
  assert.ok(text.includes("مامەڵەی نەدراوە"), "it says why");
});

test("dinars are written without fractions and dollars with them", () => {
  const iqd = debtReminderMessage({ outstanding: 250000, currency: "IQD" }, {});
  assert.ok(iqd.includes("250,000 IQD"), iqd);
  const usd = debtReminderMessage({ outstanding: 250, currency: "USD" }, {});
  assert.ok(usd.includes("250.00 USD"), usd);
});

test("a debt with no due date does not invent one", () => {
  // «بەرواری دانەوە حەتمی نییە» — section 13. An empty line saying "Due:" would read as though
  // one had been agreed.
  const text = debtReminderMessage({ outstanding: 10, currency: "USD" }, { lang: "en" });
  assert.ok(!text.includes("Due"), text);
  assert.ok(!text.includes("Reason"), text);
});

test("the message never carries what the debtor may not see", () => {
  // Sections 10 and 16: no profit, no commission, nothing internal. A message is the easiest
  // place in the system to leak from, because it leaves through the person's own phone — so it
  // is built from named fields and never from the whole row.
  const text = debtReminderMessage(
    { outstanding: 100, currency: "USD", reason: "قەرز",
      profit: 41.5, commission: 7, tenantId: "t-sarkhel", internalNote: "do not show" }, {});
  for (const secret of ["41.5", "41.50", "7", "t-sarkhel", "do not show"]) {
    assert.ok(!text.includes(secret), `the message leaked ${secret}:\n${text}`);
  }
});

test("all three languages produce a message, and each in its own", () => {
  const debt = { outstanding: 10, currency: "USD" };
  assert.ok(debtReminderMessage(debt, { lang: "ku" }).includes("سڵاو"));
  assert.ok(debtReminderMessage(debt, { lang: "en" }).includes("Hello"));
  assert.ok(debtReminderMessage(debt, { lang: "ar" }).includes("مرحبًا"));
});

test("one call gives the number, the message and the link together", () => {
  // A screen that could build one without the other is a screen that can open WhatsApp empty.
  const out = debtReminderWhatsapp({ outstanding: 90, currency: "USD" },
    { phone: "0750 123 4567", debtorName: "Rawa" });
  assert.equal(out.number, "9647501234567");
  assert.ok(out.message.includes("Rawa"));
  assert.ok(out.href.includes("9647501234567"));
  assert.equal(decodeURIComponent(out.href.split("text=")[1]), out.message);
});
