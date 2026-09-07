/* Build identity — the one place the game says WHICH BUILD it is.
 *
 * Every player-facing surface that names the game or prints a version number
 * reads from here: the home guide-sign, the loading board, the pause board,
 * the credits screen, the bug-report mailto, the document title / Open Graph
 * metadata in app/layout.tsx, the install manifest, the 404 and crash pages
 * and the WebGL-failure screen. Nothing prints `pkg.version` itself.
 *
 * ── SHIPPING OUT OF BETA ────────────────────────────────────────────────
 *   Set IS_BETA to false, one line below. That is the whole change: every
 *   BETA plate, every "v3.0.0 BETA" and every "(BETA)" in the tab title and
 *   the share card disappears, and the version strings go back to plain
 *   "v3.0.0". Do not delete the plates screen by screen.
 * ────────────────────────────────────────────────────────────────────────
 */

import pkg from "../package.json";

/** package.json's version, shown small on the home plate, the pause board and
    the credits screen so a bug report can say which build it saw. */
export const VERSION: string = pkg.version;

/** THE SWITCH. `true` while the game is a public beta. */
export const IS_BETA = true;

/** DEVELOPER SETTINGS. The three rows in the settings panel that are not for
 *  players — device tier, imported cabin, test mode — plus the K key that
 *  flips test mode from inside the car.
 *
 *  Same gate as game/debug.ts's DEBUG_HOOKS (on in any non-production build,
 *  and in production only behind `?debug`), with one addition: an EXPLICIT
 *  `?debug=0` turns it off in a dev build too, so the public screen can be
 *  reviewed — and screenshotted, and tested — from `next dev` without making
 *  a production build. It is not imported from debug.ts because of that extra
 *  branch and because lib/ does not otherwise reach into game/.
 *
 *  Hiding a row never rewrites the stored value: game/settings.ts RESOLVES
 *  the three settings as auto / auto / false while this is false and writes
 *  nothing back, so `?debug=1` shows every one of them exactly as the player
 *  left it and flipping this flag is reversible in both directions. */
export const SHOW_DEV_SETTINGS: boolean = (() => {
  let q: string | null = null;
  try {
    if (typeof location !== "undefined") q = new URLSearchParams(location.search).get("debug");
  } catch {
    /* ignore malformed URLs */
  }
  if (q !== null) return q !== "0" && q !== "false";
  return process.env.NODE_ENV !== "production";
})();

/** A token that changes with every build (next.config.mjs BUILD_REV): the
    deployment's commit sha where there is one, the build's own timestamp
    otherwise. Not shown anywhere — it is a CACHE KEY, for anything the client
    stores or caches that would go stale the moment the bundle changes: today
    the garage's persisted card art (game/carpreview.ts) and the immutable
    model URLs below. Empty string if the env var somehow did not make it into
    the bundle, which every reader must treat as "do not cache" rather than as
    a key. */
export const BUILD_REV: string = process.env.NEXT_PUBLIC_BUILD_REV || "";

/** Stamp a /public asset URL with the build it belongs to.
 *
 *  public/models/*.glb are NOT content-hashed the way the JS bundles are —
 *  they keep the same filenames build after build while their contents change,
 *  so the only safe cache header for them has been "revalidate every time".
 *  That is a round trip per file before a single byte comes out of the disk
 *  cache: measured on Slow 4G, the 14 traffic bodyshells cost ~2 s of pure
 *  revalidation even when every one of them was already downloaded.
 *
 *  Adding the build's own token to the query makes the URL change whenever the
 *  file might have, which is exactly what an immutable cache entry needs.
 *  next.config.mjs serves /models/* with a one-year immutable lifetime ONLY
 *  for requests that carry this `v` — an unstamped request keeps the old
 *  revalidate-always behaviour, so nothing that asks for a bare path (a test
 *  harness, a hand-typed URL) can ever be handed a stale year-old model.
 *
 *  Returns the url unchanged when there is no token, which is the same
 *  fail-safe: no token, no immutable caching. */
export const buildStamped = (url: string): string =>
  BUILD_REV ? `${url}?v=${BUILD_REV}` : url;

/** The game's own name, unqualified. */
export const GAME_NAME = "NEON EXPRESSWAY";

/** The word on the plate, and its Japanese. 試験版 = "trial edition" — the
    supplementary-plate reading, to match the sign language everywhere else. */
export const BETA_LABEL = "BETA";
export const BETA_JP = "試験版";

/** "v3.0.0 BETA" / "v3.0.0" — the version chip on home, pause and credits. */
export const VERSION_LABEL = IS_BETA ? `v${VERSION} ${BETA_LABEL}` : `v${VERSION}`;

/** "NEON EXPRESSWAY v3.0.0 BETA" — where the name and build print together
    (the pause footbar, the credits corner, the bug-report mail body). */
export const NAME_VERSION = `${GAME_NAME} ${VERSION_LABEL}`;

/** "NEON EXPRESSWAY (BETA)" — the name where a plate cannot be drawn: the
    browser tab, the share card, the install manifest, the plain-DOM error
    screens. */
export const NAME_LABEL = IS_BETA ? `${GAME_NAME} (${BETA_LABEL})` : GAME_NAME;

/** The one line of beta copy, in the sign voice: what a beta player should
    expect and where the bug link lives. Rendered on the home board's
    supplementary plate — never on the driving HUD. */
export const BETA_NOTE =
  "PUBLIC BETA · ROUGH EDGES AND BUGS ARE EXPECTED · PAUSE (Esc) → REPORT A BUG";
