/**
 * Which build is actually running, and is there a newer one.
 *
 * Every fix shipped on the morning of 27 August was invisible on the owner's phone. The code was
 * on the server; the screen kept showing sentences that no longer existed in the source; and
 * neither the owner nor anybody reading their screenshot could tell which of the two they were
 * looking at. Hours went into diagnosing behaviour that had already been fixed.
 *
 * A build nobody can name is a build nobody can confirm. This gives it a name, puts that name
 * where a person can read it, and asks the server — past every cache — whether it is still the
 * current one.
 */

/** The build this bundle was made in. Replaced at build time; "dev" when Vite is serving. */
export const RUNNING_BUILD = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

/** Short enough to read aloud or type into a message. */
export const shortBuild = (id = RUNNING_BUILD) =>
  id === "dev" ? "dev" : `${id.slice(2, 8)}·${id.slice(9, 13)}`;

/**
 * The build the server is serving now, or null when it cannot be asked.
 *
 * `cache: "no-store"` and a changing query are both deliberate: the whole point is to defeat the
 * cache that made this necessary, and an iOS home-screen app has more than one of them.
 */
export async function publishedBuild({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const response = await fetchImpl(`/version.json?at=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    const build = typeof body?.build === "string" ? body.build : null;
    return build || null;
  } catch {
    return null;
  }
}

/**
 * True when the server has a build this page is not running.
 *
 * A development build never reports itself stale, and neither does an unanswered question — being
 * offline is not a reason to tell somebody their app is out of date.
 */
export function isStale(published, running = RUNNING_BUILD) {
  if (!published || running === "dev") return false;
  return published !== running;
}
