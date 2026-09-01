// What counts as a password for an account that can move money.
//
// One place, because it was two: `create` demanded eight characters and `reset_password`
// demanded eight while telling the caller it wanted twelve. A rule written twice is a rule that
// disagrees with itself, and the half a user reads is the half that was wrong.
//
// The rule follows NIST 800-63B rather than the older habit of composition requirements. Those
// requirements — one capital, one digit, one symbol — measurably produce worse passwords, because
// people satisfy them the same way everybody else does (Password1!) and then reuse it. What
// actually helps is length, and refusing the handful of strings that are tried first.
//
// Twelve is the floor. It is not a guess: eight characters of anything is inside reach of an
// offline attack on a leaked hash, and this system holds a business's whole ledger. Existing
// passwords are not affected — this is checked when one is set, so nobody is locked out by it.

export const MIN_PASSWORD_LENGTH = 12;

// The interface counts in Kurdish digits everywhere else; a refusal that suddenly says "12"
// reads as if it came from somewhere other than this program.
const KURDISH_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const inKurdish = (n) => String(n).replace(/[0-9]/g, (d) => KURDISH_DIGITS[Number(d)]);

// Not a breach corpus — that belongs in a service, not in a repository. This is the short list
// of what is actually typed when somebody is asked to invent a password and does not want to.
const TRIED_FIRST = new Set([
  "password", "passw0rd", "password1", "password12", "password123", "password1234",
  "123456", "1234567", "12345678", "123456789", "1234567890", "123456789012",
  "qwertyuiop", "qwerty123456", "1q2w3e4r5t6y", "adminadmin", "administrator",
  "letmein", "letmein12345", "welcome12345", "iloveyou1234", "abcd1234abcd",
  "zemanzeman", "zeman123456", "sarrafsarraf", "sarraf123456",
]);

const ONLY_ONE_CHARACTER = (value) => new Set(value).size === 1;

const isARun = (value) => {
  if (value.length < 4) return false;
  let up = true; let down = true;
  for (let i = 1; i < value.length; i += 1) {
    const step = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (step !== 1) up = false;
    if (step !== -1) down = false;
  }
  return up || down;
};

/**
 * Judge a password that is about to be set.
 *
 * Returns `{ ok: true }` or `{ ok: false, code, error }`, where `error` is the sentence the
 * person setting it will read. Every refusal says what to do differently — "too short" with no
 * number is a refusal somebody has to guess their way past.
 *
 * `about` carries what the password must not simply repeat: the account's phone and name. A
 * password that is the account's own phone number is not a password.
 */
export function judgePassword(password, about = {}) {
  const value = String(password ?? "");

  if (value.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: "password_too_short",
      error: `وشەی نهێنی دەبێت لانیکەم ${inKurdish(MIN_PASSWORD_LENGTH)} پیت بێت`,
    };
  }
  if (value.length > 200) {
    return { ok: false, code: "password_too_long", error: "وشەی نهێنی زۆر درێژە" };
  }
  if (value.trim().length !== value.length) {
    return {
      ok: false,
      code: "password_padded",
      error: "وشەی نهێنی نابێت بە بۆشایی دەست پێبکات یان کۆتایی پێبێت",
    };
  }

  const folded = value.toLowerCase();
  if (TRIED_FIRST.has(folded) || ONLY_ONE_CHARACTER(folded) || isARun(folded)) {
    return {
      ok: false,
      code: "password_too_common",
      error: "ئەم وشەی نهێنییە زۆر ئاساییە — یەکێکی تر هەڵبژێرە",
    };
  }

  // The account's own details are not a secret from anybody who can see the account.
  const phone = String(about.phone || "").replace(/\D/g, "");
  if (phone.length >= 7 && folded.includes(phone)) {
    return {
      ok: false,
      code: "password_is_the_phone",
      error: "وشەی نهێنی نابێت ژمارەی مۆبایلەکە لەخۆ بگرێت",
    };
  }
  const name = String(about.name || "").trim().toLowerCase();
  if (name.length >= 4 && folded.includes(name)) {
    return {
      ok: false,
      code: "password_is_the_name",
      error: "وشەی نهێنی نابێت ناوی ئەکاونتەکە لەخۆ بگرێت",
    };
  }

  return { ok: true };
}
