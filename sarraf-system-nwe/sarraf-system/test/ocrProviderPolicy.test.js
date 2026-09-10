import test from "node:test";
import assert from "node:assert/strict";
import { classifyOcrProviderError, runOcrProviders } from "../api/_ocr-provider-policy.js";

const failure = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

test("Google Vision billing failure falls through to the next configured reader", async () => {
  const called = [];
  const result = await runOcrProviders([
    { name: "google-vision", key: "x", fn: async () => { called.push("vision"); throw failure(403, "billing must be enabled"); } },
    { name: "claude", key: "y", fn: async () => { called.push("claude"); return { data: { amount: 100 }, meta: { provider: "claude" } }; } },
  ], ["image", "image/jpeg", "2026-09-10"]);
  assert.deepEqual(called, ["vision", "claude"]);
  assert.equal(result.meta.provider, "claude");
  assert.deepEqual(result.meta.fallbackFrom, ["google-vision"]);
  assert.equal(result.meta.attempts[0].category, "provider_configuration");
});

test("invalid input is terminal and is never sent to another provider", async () => {
  let secondCalled = false;
  await assert.rejects(() => runOcrProviders([
    { name: "first", key: "x", fn: async () => { throw failure(400, "bad image"); } },
    { name: "second", key: "y", fn: async () => { secondCalled = true; return {}; } },
  ], []), /bad image/);
  assert.equal(secondCalled, false);
  assert.equal(classifyOcrProviderError(failure(400, "bad image")).retryable, false);
});

test("the last transient provider is retried once after a bounded wait", async () => {
  let calls = 0;
  const waits = [];
  const result = await runOcrProviders([
    { name: "groq", key: "x", fn: async () => {
      calls += 1;
      if (calls === 1) throw failure(503, "temporarily unavailable", { retryAfterSeconds: 30 });
      return { data: { amount: 80 }, meta: { provider: "groq" } };
    } },
  ], [], { sleep: async (ms) => waits.push(ms) });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1500]);
  assert.deepEqual(result.meta.fallbackFrom, ["groq"]);
});

test("all provider attempts remain attached to the final failure", async () => {
  const error = await runOcrProviders([
    { name: "groq", key: "x", fn: async () => { throw failure(429, "rate limit"); } },
    { name: "vision", key: "y", fn: async () => { throw failure(403, "billing disabled"); } },
  ], [], { sleep: async () => {} }).catch((caught) => caught);
  assert.deepEqual(error.attempts.map((attempt) => attempt.provider), ["groq", "vision"]);
  assert.equal(error.retryable, true);
});
