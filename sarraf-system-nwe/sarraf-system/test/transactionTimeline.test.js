import test from "node:test";
import assert from "node:assert/strict";
import { transactionTimeline } from "../src/services/transactionTimeline.js";

test("owner timeline is chronological and uses only the transaction's movements", () => {
  const events = transactionTimeline({
    id: "tx-1", date: "2026-09-01T10:00:00Z", paidAt: "2026-09-01T12:00:00Z",
    status: "completed", total: 141000, againstId: "iqd",
  }, {
    ledger: [
      { id: "other", txId: "tx-2", date: "2026-09-01T11:00:00Z", amount: 99, curId: "usd" },
      { id: "movement", txId: "tx-1", date: "2026-09-01T11:00:00Z", amount: -100, curId: "usd" },
    ],
  });

  assert.deepEqual(events.map((event) => event.kind), ["created", "movement", "settled"]);
  assert.deepEqual(events.find((event) => event.kind === "movement"), {
    id: "ledger:movement", kind: "movement", at: "2026-09-01T11:00:00Z", amount: -100, currency: "usd",
  });
});

test("portal timeline exposes milestones only, never internal movements or economics", () => {
  const events = transactionTimeline({
    id: "tx-1", date: "2026-09-01T10:00:00Z", status: "pending", total: 141000,
    againstId: "iqd", profit: 500, partnerId: "secret-partner",
  }, {
    scope: "portal",
    ledger: [{ id: "movement", txId: "tx-1", date: "2026-09-01T11:00:00Z", amount: -100, curId: "usd" }],
  });

  assert.deepEqual(events.map((event) => event.kind), ["created", "pending"]);
  assert.ok(events.every((event) => !("profit" in event) && !("partnerId" in event)));
});

test("missing or unrelated rows do not create timeline entries", () => {
  assert.deepEqual(transactionTimeline(null), []);
  assert.deepEqual(transactionTimeline({ id: "tx-1", date: "not-a-date", status: "pending" }, {
    ledger: [{ id: "movement", txId: "tx-2", date: "2026-09-01T11:00:00Z" }],
  }).map((event) => event.kind), ["created", "pending"]);
});
