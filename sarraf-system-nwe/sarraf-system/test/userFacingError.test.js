import test from "node:test";
import assert from "node:assert/strict";
import { userFacingServiceError } from "../src/services/userFacingError.js";

/**
 * The two properties this file has always guarded, kept as properties rather than as exact
 * wording. The wording changed when the translator stopped answering every failure with one of
 * four sentences: a refusal written to be read is now passed on, and every answer carries a code
 * the person can quote. What must not change is that nothing internal escapes, and that the
 * answer is in the language the reader chose.
 */

test("service errors never expose raw schema or authorization details", () => {
  const missing = userFacingServiceError(
    { code: "PGRST202", message: "Could not find the function public.secret_rpc in the schema cache" }, "ku");
  assert.doesNotMatch(missing, /secret_rpc|schema cache/i);
  assert.match(missing, /داتابەیس/, "the reader is not told what kind of problem this is");

  const denied = userFacingServiceError(
    { code: "42501", message: "admin integrity checks are not authorized" }, "en");
  assert.match(denied, /do not have permission/i);
  assert.match(denied, /ZE-42501/, "there is no code for the person to quote");
});

test("service error copy follows the active interface language", () => {
  assert.match(userFacingServiceError(new Error("Failed to fetch"), "ar"), /الخادم/);
  assert.match(userFacingServiceError(new Error("unexpected"), "en"), /did not work/i);
  assert.match(userFacingServiceError(new Error("unexpected"), "ku"), /سەرکەوتوو نەبوو/);
});
