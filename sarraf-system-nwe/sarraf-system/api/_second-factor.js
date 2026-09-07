/**
 * دوو فاکتەر لەم قۆناغەدا پێویست نییە — بەڵام ئەگەر کەسێک دایناوە، دەبێت بەکاری بهێنێت
 *
 *   «2FA بۆ خاوەن و کارمەند لەم قۆناغەدا پێویست نییە.» — بەشی ٦
 *
 * Four routes each carried their own copy of "an administrator must present a second factor",
 * and one of them — api/admin-user.js — had already worked out the rule that is actually
 * wanted. This is that rule, in one place, so the other three cannot drift from it:
 *
 *   · a session that reached aal2 has presented a factor, and passes;
 *   · a session at aal1 whose account has NO verified factor passes, because aal1 is the
 *     highest that account can reach and refusing it refuses that person forever;
 *   · a session at aal1 whose account HAS a verified factor is refused and told to complete
 *     the challenge, because skipping a factor you own is not the same as not having one.
 *
 * The middle case is what section 6 asks for. The third is kept because dropping it would mean
 * an enrolled factor bought nothing, and an owner who turns it on should get what they turned
 * on. It is also what makes putting the requirement back cheap: the only change would be to
 * treat "not enrolled" as a refusal too.
 *
 * api/read-receipt.js does NOT use this. It reaches PostgREST by fetch with the caller's own
 * token and holds no service key, so it cannot ask whether a factor is enrolled; there the
 * assurance requirement is simply gone, and an active account plus an explicit role list is
 * what guards it. That asymmetry is deliberate and written down rather than smoothed over.
 *
 * The closed circle this replaced is worth remembering. A session cannot reach aal2 without an
 * enrolled factor, so demanding aal2 from an account with none refuses every request it will
 * ever make — which is what stopped both the manager and the business owner from creating a
 * single account, the same shape as needing an owner in order to make the first owner.
 */

/**
 * Throws a 403 with code `mfa_required` when the caller skipped a factor they actually have.
 *
 * `service` is a Supabase client holding the service key; `userId` is the auth user's id; `aal`
 * is the assurance level from the caller's own token.
 */
export async function requireSecondFactorIfEnrolled(service, userId, aal) {
  if (String(aal || "aal1") === "aal2") return;

  let enrolled = false;
  try {
    const { data: factors } = await service.auth.admin.mfa.listFactors({ userId });
    enrolled = (factors?.factors || []).some((f) => f?.status === "verified");
  } catch {
    // The factor list could not be read. Treating that as "not enrolled" would let a transient
    // failure downgrade a protected account, so it counts as enrolled.
    enrolled = true;
  }
  if (!enrolled) return;

  const error = new Error("multi-factor authentication required");
  error.status = 403;
  error.code = "mfa_required";
  throw error;
}

export default requireSecondFactorIfEnrolled;
