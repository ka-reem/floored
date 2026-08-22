import { clamp } from "./util";
import type { DriverInput } from "./physics";

/* Gamepad driving input — strictly additive to the keyboard/touch paths.

   The physics has always wanted analog: `input.th/br/st` are continuous
   floats, and the keyboard only ever feeds them 0 or 1 through a rate limiter
   that fakes a pedal out of a switch. A pad feeds them directly, so this
   module deliberately splits the two halves:

     - triggers BYPASS the ramp. A trigger is already a pedal; running it
       through the keyboard's clamp would add ~250 ms of lag to a control the
       driver is modulating by hand, which is the whole reason to hold one.
     - the stick does NOT bypass the steering ramp. The stick is analog, but
       the ramp is not there to fake an analog axis — it is what stops the
       front axle being snapped to full lock in a frame at 40 m/s. Feeding it
       the same `sTarget` the keyboard feeds keeps the car stable and keeps
       the speed-sensitive rate (engine.ts computes it from `car.u`) honest.

   Polling only. `navigator.getGamepads()` must be re-read every frame — the
   returned array and its Gamepad objects are snapshots, not live views — and
   its entries can be null for unplugged slots.

   No pad connected (or no pad touched recently) => `pollGamepad` returns
   false, writes nothing, and the caller runs exactly the code it ran before. */

/** Standard-mapping button indices we care about. */
const BTN_A = 0; // handbrake (held)
const BTN_B = 1; // horn (held)
const BTN_Y = 3; // lights toggle (edge)
const BTN_LT = 6; // left trigger  -> brake
const BTN_RT = 7; // right trigger -> throttle
const BTN_RB = 5; // camera cycle (edge)
const BTN_DUP = 12; // camera cycle (edge)

/** Stick deadzone. Cheap pads rest anywhere inside ~0.08; 0.12 clears that
    with margin without eating usable travel, because the curve below spends
    most of its resolution just outside the zone anyway. */
const DEAD = 0.12;
/** Triggers rest at exactly 0 on a standard mapping, but a worn spring or an
    XInput-over-Bluetooth pad can idle a hair above it. */
const TRIG_DEAD = 0.03;

/** Once the pad has been touched it owns the input for this long after the
    last input, so letting go of everything for a frame does not flicker
    ownership back to the keyboard mid-corner. */
const HOLD = 0.35;

/** Steering response: mostly cubic, with a little linear mixed back in so the
    stick still does something in the first few degrees. Full deflection still
    reaches exactly 1, i.e. full lock is never taken away — only the middle is
    stretched out, which is where all the small corrections live. */
function curve(t: number) {
  return 0.3 * t + 0.7 * t * t * t;
}

/** Edge-triggered actions the pad can fire. These mirror the once-per-press
    keyboard handlers (engine.ts `onKeyDown`, which drops `e.repeat`), so a
    held button must not re-fire them every frame — see `prev` below. */
export interface PadEdge {
  /** cycle camera — same body as the `c` key */
  cam(): void;
  /** toggle user lights — same body as the `l` key */
  lights?(): void;
}

/** Previous-frame pressed state, by button index. Re-primed (NOT cleared —
    see `prime`) whenever the pad we are reading changes, or whenever polling
    itself has been interrupted. */
let prev: boolean[] = [];
let prevIndex = -1;
/** Seconds left of pad ownership; see HOLD. */
let hold = 0;
/** Timestamp of the last poll, seconds. See GAP. */
let lastPoll = -Infinity;

/** A gap longer than this between polls means we stopped watching the pad and
    cannot trust `prev` any more. Two things cause it and neither is rare:

      - pause. readInput returns at the pause guard, above our call site, so
        the pad is not polled at all while the menu is up.
      - window blur / background tab, where rAF is throttled to a crawl or
        stopped outright and the whole frame loop goes with it.

    400 ms is comfortably longer than any real frame (a 4 fps frame would have
    to miss it) and far shorter than any pause or tab switch a human performs. */
const GAP = 0.4;

/** Seconds, monotonic where available. */
function nowSec() {
  return typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000;
}

/** Seed `prev` from what the pad is doing RIGHT NOW, and give up ownership.

    This is the whole trick, and it is why the two callers below must not just
    do `prev = []`. Clearing makes every `was` false, so a button still held
    across the gap reads as `now && !was` on the very next poll and fires the
    edge — it guarantees the press it was supposed to swallow. Priming records
    the button as already-down, so it stays silent until it is genuinely
    released and pressed again.

    Concretely: hold RB through a pause, or replug the pad with RB down, and
    the camera must not cycle the instant play resumes. The keyboard already
    holds this line — the high-beam flash is gated on `running` so a flash
    banked in a menu cannot fire on resume — and the pad has to match it. */
function prime(gp: Gamepad) {
  prev = [];
  for (let i = 0; i < gp.buttons.length; i++) prev[i] = down(gp, i);
  /* Ownership is dropped too: a HOLD grace banked before the gap would
     otherwise let a neutral pad write the input on the resume frame, which is
     exactly what the pause guard above us just finished zeroing. */
  hold = 0;
}

/** First usable pad. Slots can hold nulls, and a disconnected pad may linger
    in the array with `connected === false`. Standard mapping is preferred
    because every index above assumes it, but a non-standard pad is still
    better than nothing — the axes are conventional even when the buttons are
    not. */
function pick(): Gamepad | null {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function")
    return null;
  let pads: (Gamepad | null)[];
  try {
    pads = navigator.getGamepads();
  } catch {
    return null; // some browsers throw when the API is permission-gated
  }
  if (!pads) return null;
  let fallback: Gamepad | null = null;
  for (const p of pads) {
    if (!p || !p.connected) continue;
    if (p.mapping === "standard") return p;
    if (!fallback) fallback = p;
  }
  return fallback;
}

/** Analog button read that tolerates a pad reporting triggers as digital. */
function trig(gp: Gamepad, i: number) {
  const b = gp.buttons[i];
  if (!b) return 0;
  const v = typeof b.value === "number" ? b.value : b.pressed ? 1 : 0;
  return v > TRIG_DEAD ? clamp(v, 0, 1) : 0;
}

function down(gp: Gamepad, i: number) {
  const b = gp.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
}

/**
 * Poll pad 0 and, if it is being used, write the whole driver input for this
 * frame and return true — the caller should then skip its keyboard read.
 * Returns false when no pad is connected or none has been touched recently,
 * in which case nothing at all is written.
 *
 * @param input     the live DriverInput, written in place
 * @param dt        frame time, seconds
 * @param steerRate the caller's own speed-sensitive steering rate (rad of
 *                  normalised travel per second) — passed in rather than
 *                  recomputed here so pad and keyboard can never drift apart
 * @param edge      once-per-press actions
 */
export function pollGamepad(
  input: DriverInput,
  dt: number,
  steerRate: number,
  edge: PadEdge
): boolean {
  const t = nowSec();
  const gapped = t - lastPoll > GAP;
  lastPoll = t;

  const gp = pick();
  if (!gp) {
    prev = [];
    prevIndex = -1;
    hold = 0;
    return false;
  }
  /* Prime and bail on the first poll after a gap (pause, blur, first frame
     ever) or after the pad changed. Costs one frame of pad input — the
     keyboard path runs instead, writing nothing a released key would not —
     and buys immunity to a press banked while nobody was looking. */
  if (gapped || gp.index !== prevIndex) {
    prime(gp);
    prevIndex = gp.index;
    return false;
  }

  const ax = gp.axes.length > 0 ? gp.axes[0] : 0;
  const th = trig(gp, BTN_RT);
  const br = trig(gp, BTN_LT);
  const hb = down(gp, BTN_A);
  const horn = down(gp, BTN_B);

  /* Edges first, and unconditionally: a camera press should register even if
     it is the only thing the driver does, i.e. before the activity test below
     has had anything analog to look at. */
  let pressedAny = false;
  for (let i = 0; i < gp.buttons.length; i++) {
    const now = down(gp, i);
    const was = !!prev[i];
    prev[i] = now;
    if (now) pressedAny = true;
    if (now && !was) {
      if (i === BTN_RB || i === BTN_DUP) edge.cam();
      else if (i === BTN_Y && edge.lights) edge.lights();
    }
  }

  /* Ownership: a pad that is plugged in but untouched must not silently kill
     the keyboard — plenty of people leave one connected. Any real deflection
     claims the frame, and HOLD keeps it for a moment after release. */
  const active = Math.abs(ax) > DEAD || th > 0 || br > 0 || pressedAny;
  hold = active ? HOLD : Math.max(0, hold - dt);
  if (!active && hold <= 0) return false;

  // triggers: straight through, no ramp (see header)
  input.th = th;
  input.br = br;
  input.hb = hb ? 1 : 0;
  input.horn = horn ? 1 : 0;

  /* Stick: deadzone, rescale so the first usable degree is 0 rather than
     DEAD (otherwise steering jumps as you leave the zone), curve, then feed
     the caller's rate limiter. Sign matches the keyboard's `sL - sR`, where
     positive is left and stick +X is right. */
  const mag = Math.abs(ax);
  let sTarget = 0;
  if (mag > DEAD) sTarget = -Math.sign(ax) * curve((mag - DEAD) / (1 - DEAD));
  input.st += clamp(sTarget - input.st, -steerRate * dt, steerRate * dt);
  // centred stick unwinds the wheel the same way released keys do
  if (sTarget === 0) input.st *= Math.max(0, 1 - 6.5 * dt);
  return true;
}
