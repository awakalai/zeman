/**
 * Which language the person reading this has chosen.
 *
 * It lived as a module-scoped `let _lang` inside App.jsx, which meant every component outside
 * that file had to be handed it as a prop — and any that were not, could not say anything to
 * the reader in their own language. Here it is one small module both sides can import, so a
 * function that needs to write a sentence does not need the whole component tree to cooperate.
 *
 * Reading and writing localStorage is wrapped, because a browser in private mode throws on both
 * and a language preference is never worth taking a screen down for.
 */

const SUPPORTED = ["ku", "en", "ar"];
const KEY = "lang";

let current = (() => {
  try {
    const saved = localStorage.getItem(KEY);
    return SUPPORTED.includes(saved) ? saved : "ku";
  } catch { return "ku"; }
})();

/** The chosen language, always one of the three the interface actually has. */
export function activeLanguage() {
  return current;
}

/** Remember a new choice. Anything unrecognised leaves the choice as it was. */
export function setActiveLanguage(lang) {
  if (!SUPPORTED.includes(lang)) return current;
  current = lang;
  try { localStorage.setItem(KEY, lang); } catch { /* a preference is not worth a crash */ }
  return current;
}

export const SUPPORTED_LANGUAGES = SUPPORTED;
