/* First-run discovery hints.
 *
 * The game has grown features nobody can find from inside a moving car: the
 * signal keys, test mode, EXIT 4's mountain road, the console screen's
 * clickable panes, the touch overflow drawer. The CONTROLS screen lists them,
 * but a list read before driving is forgotten by the first corner — these
 * introduce a feature at the moment it is relevant, once, ever.
 *
 * Rules, all of them load-bearing:
 *  - ONCE EVER per browser, not per session: seen-flags persist through
 *    settings.ts (hintSeen/markHintSeen), so a reload never replays a tip.
 *  - ONE AT A TIME: a hint that becomes due while another is up waits for the
 *    fade plus a beat of quiet air; two stacked tips read as a tutorial, and
 *    this game does not have one.
 *  - ALWAYS FADES: display is time-boxed (HINT_SHOW_MS) and the element
 *    transitions opacity — a tip never sits on the frame until dismissed,
 *    the same fade-not-stop rule every light in the world follows.
 *  - KILLABLE: the settings panel's "First-run hints" toggle gates the whole
 *    system, checked live on every tick so flipping it mid-drive works.
 *
 * This module only decides WHEN a hint fires; the engine forwards the fired
 * message over UiBridge.hint and GameApp owns the element, the timer and the
 * fade. Nothing here touches gameplay — update() is called from the HUD
 * cadence with a read-only snapshot.
 */

import { hintSeen, markHintSeen } from "./settings";

export interface HintMsg {
  en: string;
  jp: string;
}

/** Read-only frame facts the engine passes in; hints never reach back. */
export interface HintSnapshot {
  /** settings.hints — the panel toggle. Checked here rather than by the
      caller so "off" also freezes the pacing clocks. */
  enabled: boolean;
  touch: boolean;
  /** CAM_CONSOLE is the view on screen */
  consoleCam: boolean;
  /** EXIT 4 (峠, the mountain road) is inside the exitHint window ahead */
  exit4Ahead: boolean;
}

/** How long GameApp keeps a fired hint up before fading it. Lives here so the
    no-stack arithmetic below and the UI timer can never disagree. */
export const HINT_SHOW_MS = 6000;
/** Quiet air after a fade before the next hint may fire. */
const GAP_S = 4;
/** Driving time before the settle-in hints fire: late enough that the player
    has the car moving and the load fade is long gone, early enough to still
    be "when you first drive". */
const SETTLE_S = 6;

interface HintDef {
  id: string;
  en: string;
  jp: string;
  when(s: HintSnapshot, driveT: number): boolean;
}

/* Order is priority: the contextual hints (a view or a place the player is IN
   right now) outrank the settle-in ones, which have the whole first drive to
   land. The wipers/rain hint is deliberately absent — it belongs to the
   cabin-wipers lane and ships with it, gated the same way. */
const DEFS: HintDef[] = [
  {
    id: "exit4",
    en: "EXIT 4 — 峠 mountain road ▸",
    jp: "対向車あり",
    when: (s) => s.exit4Ahead,
  },
  {
    /* The console screen's panes are pointer targets on desktop only
       (engine.ts screenTarget: music.enabled is false on touch, where the
       panel stays a map and nothing on it responds) — so is the hint. */
    id: "console",
    en: "click the screen — map / music / trip",
    jp: "画面クリック",
    when: (s) => s.consoleCam && !s.touch,
  },
  {
    id: "drive",
    en: "Q / E — signals · K — test mode",
    jp: "ウインカー・テストモード",
    when: (s, t) => !s.touch && t > SETTLE_S,
  },
  {
    /* The touch counterpart of "drive": on a phone the keyboard hints are
       noise, and the one thing worth knowing is where everything else lives. */
    id: "touch",
    en: "⋯ — all controls",
    jp: "すべての操作",
    when: (s, t) => s.touch && t > SETTLE_S,
  },
];

export class Hints {
  private driveT = 0;
  private lastNow = 0;
  private busyUntil = 0;
  /** cheap early-out once every hint has fired, so steady state is one test */
  private done = false;

  /** Called from the engine's HUD cadence, only while started && running, with
      `now` in seconds (the frame clock). Returns a message exactly once per
      fired hint; the caller shows it for HINT_SHOW_MS and fades. */
  update(now: number, s: HintSnapshot): HintMsg | null {
    if (this.done || !s.enabled) return null;
    /* Accumulate driving time from the call cadence itself rather than trust
       `now` deltas across a pause — updates stop while paused, and a menu
       visit must not count as time behind the wheel. */
    if (this.lastNow) this.driveT += Math.min(0.5, now - this.lastNow);
    this.lastNow = now;
    if (now < this.busyUntil) return null;
    let live = 0;
    for (const d of DEFS) {
      if (hintSeen(d.id)) continue;
      live++;
      if (!d.when(s, this.driveT)) continue;
      markHintSeen(d.id);
      this.busyUntil = now + HINT_SHOW_MS / 1000 + GAP_S;
      return { en: d.en, jp: d.jp };
    }
    if (live === 0) this.done = true;
    return null;
  }
}
