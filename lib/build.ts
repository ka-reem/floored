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
