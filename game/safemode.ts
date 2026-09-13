/* Safe mode — the latch that stops a device bricking itself on the loading
 * screen.
 *
 * THE FAILURE THIS EXISTS FOR, measured rather than assumed.
 *
 * An iPhone 13 on Safari reports a MASKED GPU string ("Apple GPU"), so
 * detectRenderTier falls through to its devicePixelRatio branch, sees 3x and
 * calls it `mobile-high`. `mobile-high` carries `cabinPbrMaps: true` and
 * COCKPIT_MODEL hands every tier the same `volvo-s90-full` — 21 images that
 * decode to 280 MB of RGBA8 once mipped, and, worse, that ALL decode at full
 * size while the GLB is parsed: a ~210 MB transient spike before a single
 * material has been touched. The hardware floor written to guard exactly this
 * (donorCabinAffordable) is only consulted on `mobile-base`, so the phone most
 * likely to answer that spike with a lost context is the one tier that never
 * asks the question.
 *
 * Safari answers the spike by dropping the WebGL context. The player gets the
 * "Graphics context lost" panel, presses RELOAD, and the page comes back in
 * the identical configuration and dies in the identical place. That is the
 * part that matters: without a latch, the failure is not a crash, it is a
 * BRICK. Reloading is not a fix, so telling a player to reload is not advice.
 *
 * WHY A LATCH RATHER THAN A BETTER SNIFF. The sniff is what is already lying —
 * Safari masks the renderer string and withholds `deviceMemory`, which is why
 * the tier is wrong in the first place. Guessing harder at the same masked
 * signals would fix this phone and mis-fire on the next one. A boot that did
 * not finish is not a guess about the device; it is the device having already
 * told us. So this is deliberately CAUSE-AGNOSTIC: it catches any death during
 * the world build, not only the cabin's, and it needs to be right about
 * nothing except "the last two attempts did not reach a drivable frame".
 *
 * TWO strikes, not one, so that closing the tab mid-load — which is
 * indistinguishable from a crash, both leave the boot unfinished — does not
 * quietly downgrade someone who was never in trouble. A genuinely affected
 * device spends its two strikes on the crash and the reload it will already
 * have tried, so it lands here on the same attempt the player would have made
 * anyway.
 */

const KEY = "neonx.safemode";

/** Consecutive unfinished boots before the game degrades itself. */
const TRIP = 2;

interface State {
  /** boots that started and never reached a drivable frame, in a row */
  fails: number;
  /** latched: once true it STAYS true across successful boots */
  on: boolean;
}

const read = (): State => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      fails: typeof raw.fails === "number" && raw.fails >= 0 ? raw.fails : 0,
      on: raw.on === true,
    };
  } catch {
    /* private mode, quota, corrupt JSON — a device that cannot remember its
       own crashes is no worse off than one that never had this file */
    return { fails: 0, on: false };
  }
};

const write = (s: State): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* see above — never let bookkeeping be the thing that throws */
  }
};

/* Latched ONCE, on first ask, and every reader is answered from the latch.
   markBootStart() writes a higher fail count a few milliseconds later, and
   donorCabinAllowed() is asked during the very load that increment describes —
   so reading storage live would let this boot's own attempt change the answer
   underneath the rig that is being built from it. */
let snap: State | null = null;
const load = (): State => (snap ??= read());

/** Should this session hold itself back?
 *
 *  True once TRIP consecutive boots have died before the world finished, or
 *  once the crash panel's button has set it by hand. Callers treat it as a
 *  CEILING on what they would otherwise do, never as an instruction that
 *  overrides an explicit choice by the player — see donorCabinAllowed and
 *  resolveRenderTier, both of which let a stated preference win. */
export const safeMode = (): boolean => load().on;

/** The world build has begun. Counts this attempt as unfinished until
 *  markBootOk() says otherwise, and trips the latch if it is the TRIPth in a
 *  row — trips it in STORAGE only: `snap` is left alone so the session that
 *  is loading right now finishes the way it started rather than changing
 *  tier halfway through a stage list. The degrade lands on the next boot,
 *  which is the one the player is about to trigger anyway. */
export function markBootStart(): void {
  const s = load();
  const fails = s.fails + 1;
  write({ fails, on: s.on || fails >= TRIP });
}

/** The world is built and drivable. Clears the strike count — but NOT the
 *  latch: a device that only got here BECAUSE it is in safe mode would
 *  otherwise clear itself on every success and crash again on every load,
 *  which is the brick with extra steps. Leaving safe mode is an explicit act
 *  (clearSafeMode). */
export function markBootOk(): void {
  const s = load();
  if (s.fails === 0) return;
  write({ fails: 0, on: s.on });
  snap = { fails: 0, on: s.on };
}

/** Turn it on by hand — the "RELOAD IN SAFE MODE" button on the graphics
 *  failure panel, for the player who is staring at the panel now and should
 *  not have to crash twice more to be believed. */
export function forceSafeMode(): void {
  write({ fails: TRIP, on: true });
  snap = { fails: TRIP, on: true };
}

/** Turn it off and forget the strikes. For the player who has changed
 *  something (a new phone, a browser update) and wants the full car back, and
 *  for the debug hook. Takes effect on the next load, like every other
 *  world-build input. */
export function clearSafeMode(): void {
  write({ fails: 0, on: false });
  snap = { fails: 0, on: false };
}
