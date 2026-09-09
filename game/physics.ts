import { clamp, lerp, sstep } from "./util";
import { BRAKE_F, STEER_AY, type PhysicsSpec } from "./carspecs";

/* Bicycle-model vehicle sim with Pacejka lateral tires, longitudinal load
   transfer, friction ellipse, ABS, TC and slope forces. Ported from v2 and
   parameterised per car; AWD splits drive torque across both axles. */

/* ---- Arcade (test mode) steering feel ---------------------------------
   Test mode multiplies grip by 2.8 (carspecs.ts, testDriveSpec) but the
   constants in THIS file were sized for a 1.0-grip road car and do not scale
   with it, so the car ends up with F1 tyres and a saloon's idea of how much
   of them it is allowed to use. These are those constants.

   Nothing in here can move normal driving. Two of them (`rate`, `yawDamp`)
   sit behind a literal `opts.arcade ?` with the original constant on the
   other arm; the other two ride `arcadeAuth`, which is hard 0 outside test
   mode, so their lerp collapses onto the stock value exactly. That is a
   property worth checking rather than asserting, and
   test/steer-response-sim.mjs checks it: it drives this whole object to
   absurd values and requires 80 stock-car rows to come out bit-identical.

   The important structural point is `brakeFade`. e2e0fe0 established, with a
   trace, that anything which hands the car MORE steering authority while it
   is braking brings back the trail-braking spin — the rear axle is unloaded
   exactly then, and extra front lock is what tips it over. So both authority
   knobs below are faded back to their stock road-car values by the brake
   pedal, and are only at full value off the brake. Turn-in and a held
   high-speed corner get the arcade numbers; the moment the pedal goes down
   the car is governed exactly as it is today. Measured, this is the
   difference between "no new spins on any car" and "spins tanuki at
   150 km/h" — see test/steer-response-sim.mjs.

   Live on the console as `window.__arcadeSteer` (same pattern as
   __povMount / __aurora): these are read fresh every physics step, so
   assigning to them retunes the car between one corner and the next with no
   rebuild. test/steer-response-sim.mjs sweeps the same object headlessly. */
export const ARCADE_STEER = {
  /** Steer-travel rate, as a multiple of dmax (the travel available at this
   *  speed) per second — so 1/rate is roughly lock-to-lock time, and it is
   *  the same at every speed. Stock 6.5 is 0.154 s, which is SLOWER than the
   *  keyboard filter that feeds it, i.e. it was quietly the floor on how
   *  snappy the car could ever be made from the input side. Costs nothing in
   *  stability (every trail-brake row is unchanged by it), so it is set well
   *  clear of the input rather than just above it. */
  rate: 12,
  /** The lateral acceleration, m/s², that ESC believes the tyres can hold;
   *  it ceilings the yaw rate ESC will allow at all. Stock 10.5 is ~1.07 g —
   *  right for a road car, and less than half what a 2.8-grip arcade tyre
   *  actually delivers, so ESC spends a steady 250 km/h corner fighting a car
   *  that has not run out of grip. It looks like the obvious fix, and it is
   *  MEASURED AND REJECTED: raising it is a far more expensive way to buy
   *  cornering than hiBoost below. 14 bought kaze +5% lateral and cost tanuki
   *  8 deg of sideslip on a 150 km/h trail brake, taking a row that held over
   *  the spin line; hiBoost bought +32% for 4 deg and took nothing over.
   *  Left at the stock 10.5, i.e. inert — a knob to feel out, not a change.
   *  If you do raise it: it only moves the yaw-rate half of ESC, the sideslip
   *  term (slipPad) that catches an actual slide is untouched, and above ~26
   *  the kinematic term of the min() binds and it stops doing anything. */
  escAy: 10.5,
  /** Multiplier on spec.steerHi, the high-speed FLOOR under the steer
   *  schedule — so this is the one lever that adds steering ANGLE, and it
   *  adds it only where the schedule has bottomed out, i.e. only at speed.
   *  That is what makes it safe where boosting steerAy was not: steerAy
   *  scales a term that GROWS as the car slows, which is the runaway
   *  e2e0fe0 measured at 0.50 -> 1.76 rad/s; a floor can only ever make the
   *  schedule FLATTER, never steeper, so braking into a corner hands the
   *  front less extra lock than it does today, not more. Faded out by the
   *  brake as well, belt and braces.
   *
   *  1.8 is where the measured curve stops paying: it is the largest value
   *  that keeps the top of the stick as linear as stock (the last quarter of
   *  travel is still worth +0.30 g at 180 km/h, exactly what stock gives),
   *  and past ~2.4 the front tyre is being driven so far past its slip peak
   *  that adding lock stops adding cornering — numb, not sharp. */
  hiBoost: 1.8,
  /** Yaw damping, N·m per rad/s, opposing rotation — a first-order lag on
   *  how fast the car answers the wheel, so lowering it looks like an
   *  obvious snap lever. It is not: measured, it buys under 1% more yaw and
   *  costs a lot of trail-brake margin (700 spun the car at 150 km/h where
   *  1450 held). Left at the stock 1450 on purpose; here as a knob, not as a
   *  change. */
  yawDamp: 1450,
  /** How steeply escAy and hiBoost fade back to stock as the brake goes on:
   *  fade = clamp(pedal * this, 0, 1). Must be steep. 50% pedal is the
   *  position e2e0fe0 found spun every car, and 35% is worse still on some,
   *  so anything that leaves the car boosted at a third of a pedal is the old
   *  bug wearing a new name. At 5, a fifth of a pedal is already fully stock. */
  brakeFade: 5,
};

/* Console handle. Wrapped because this module is imported during SSR, where
   there is no window at all. */
try {
  (window as unknown as { __arcadeSteer?: unknown }).__arcadeSteer = ARCADE_STEER;
} catch {
  /* non-browser (SSR, tests) — the sim imports the object directly */
}

/* ---- Handbrake / drift ------------------------------------------------
   WHAT WAS WRONG (test/handbrake-drift-sim.mjs, before this block existed).
   The old lever was three inline numbers: rear lateral force scaled by
   `1 - 0.66*hb`, a flat 5600 N bolted onto the rear brake, and ESC plus TC
   switched off outright above hb 0.3. Traced at 60 km/h with half a stick and
   45% throttle, that is not a drift, it is a pirouette to a dead stop:

     t=1.00 pull   67.6 km/h  yaw 0.42 rad/s  rear slip  -2.6 deg
     t=1.50        59.1 km/h  yaw 1.75        rear slip -25.3
     t=1.75        40.1 km/h  yaw 2.80        rear slip -53.4
     t=2.00         3.5 km/h  yaw 0.45        rear slip -83.4   <- stopped
     t=2.25 .. 4.00 the car sits still for the rest of the pull

   Every stick position from 15% to 100% did the same thing, and full throttle
   bought 10.8 km/h at the end of the pull against 0.0 km/h at no throttle —
   i.e. the pedal was worth nothing. Three causes, all of them here:

     1. NO EQUILIBRIUM. Rear lateral was crushed to 0.34 and then the friction
        ellipse took another x0.71 off it (FxR sat at -5600 N against an
        8011 N cap), leaving the rear a quarter of the front's grip. Past the
        Pacejka peak more slip means LESS force, so nothing ever pushed back:
        the yaw rate ran to its 3.6 rad/s hard clamp every time.
     2. NOTHING CAUGHT IT. ESC and TC both switch off at hb 0.3, deliberately,
        so a deliberate slide works — but there was then no other bound of any
        kind on yaw or sideslip.
     3. THE PEDAL LOST TO THE LEVER. driveF and the 5600 N are summed into the
        same FxR, so the lever simply won; and once the car is at 80 deg of
        slip the drive force points across the direction of travel anyway.

   WHAT THIS DOES INSTEAD. `lat`/`long` take grip off the rear axle (a locked
   tyre loses BOTH, which the old model never did), `force` and `thrRelief`
   let the throttle out-pull the lever so the slide is sustained rather than
   scrubbed off, and `holdDeg`/`catchDeg`/`catchGrip` hand the rear its grip
   back progressively once the angle goes past what the lever is meant to
   hold. That last part is the whole trick: inside the band nothing pushes
   back and the angle is the driver's to hold, outside it the restoring force
   grows with the angle, so a big slide is BOUNDED instead of divergent.

   NOTHING HERE CAN MOVE NORMAL DRIVING. Every consumer is a lerp on `hbG`,
   which is exactly 0 whenever the lever has been down for `releaseT`, and
   HB_VARIANTS.stock reproduces the old arithmetic bit for bit. The sim drives
   this object to absurd values and requires every lever-never-touched row to
   come out identical — a property check, not a golden file.

   Live on the console as `window.__handbrake`, same as __arcadeSteer: read
   fresh every physics step, so the feel can be retuned between one corner and
   the next with no rebuild. */
export interface HandbrakeTune {
  /** Rear LATERAL grip left while the lever is up, as a fraction of normal.
   *  This is what breaks the axle loose. Lower is looser — but on its own it
   *  only makes the car diverge faster, which is what the old 0.34 did. */
  lat: number;
  /** Rear LONGITUDINAL grip cap while the lever is up, as a fraction. The old
   *  model left this at 1, i.e. a "locked" rear tyre kept every newton of its
   *  drive and braking authority, which is why the lever could out-pull the
   *  engine. Ceilings the lever's own force too, so it is also what stops the
   *  handbrake being a stronger brake than the brakes. */
  long: number;
  /** The lever's rear brake force, N. 5600 was enough to take 28 km/h out of
   *  the car in a second before the slide had even developed. */
  force: number;
  /** What the lever's force is multiplied by at FULL throttle. 1 = the pedal
   *  and the lever fight each other in the same FxR the way they used to;
   *  0.4 means standing on it releases 60% of the lever, which is the owner's
   *  "still push out power". Faded out at parking speed (see `minSpeed`) so
   *  throttle can never drive out from under the lever in a car park. */
  thrRelief: number;
  /** Sideslip, degrees, the lever will hold with nothing pushing back. This
   *  is the drift angle the car settles at, and the single most useful knob:
   *  raise it for a looser car, drop it for one that only rotates. */
  holdDeg: number;
  /** Degrees beyond `holdDeg` over which the rear takes its grip back. Small
   *  is a wall you bounce off, large is a soft ceiling you can lean on. */
  catchDeg: number;
  /** How much of the lost rear grip comes back at the top of that ramp.
   *  1 = the axle is fully gripping again by holdDeg+catchDeg (cannot spin,
   *  but the ceiling is firm); 0 = the old divergent behaviour. */
  catchGrip: number;
  /** Yaw damping multiplier while the lever is up and inside the band. Under
   *  1 lets the car rotate freely onto its angle. */
  yawDampMul: number;
  /** Seconds of LOOKAHEAD the catch reads the slide angle through. Without
   *  it the catch is pure proportional control on an angle that is already
   *  moving, which overshoots and turns the drift into a pendulum (measured:
   *  a 3 s pull that ended anywhere between 0 and 41 deg of sideslip for the
   *  same inputs, and once swung 14 deg past straight the other way). The
   *  lookahead extrapolates the LATERAL VELOCITY along its own derivative —
   *  `v + (ayS - u*r)*t`, i.e. last step's dv — which is the derivative term.
   *  It has to be dv and not `-u*r*t`: a steady drift has a large yaw rate by
   *  definition, so `-u*r*t` reads a settled 22 deg slide as a runaway and
   *  the catch never lets the angle past half of holdDeg. dv is 0 in a
   *  steady slide, whatever the yaw rate, and large exactly when the angle is
   *  actually running away. Set 0 for pure proportional. */
  catchLead: number;
  /** Yaw acceleration, rad/s^2, of CATCH at the top of that ramp: a
   *  corrective moment that rotates the car back toward its own velocity
   *  vector, which is exactly what a driver's counter-steer does. This is the
   *  term that turns the slide from divergent into bounded — grip coming back
   *  at 70 deg of sideslip is worth almost nothing, because the Pacejka curve
   *  is long past its peak there, so the catch has to act on the ANGLE
   *  directly. Zero inside the band, so it never fights a held drift. */
  catchYaw: number;
  /** Yaw damping multiplier at the top of the catch ramp. Over 1 stops the
   *  rotation dead once the angle is past the band, so the catch settles the
   *  car rather than bouncing it. */
  catchDamp: number;
  /** Seconds for the lever to take full effect. Non-zero mostly so a tapped
   *  lever flicks the tail rather than snapping it. */
  engageT: number;
  /** Seconds for grip to come back on RELEASE. The reason the car settles
   *  instead of snapping straight; 0 is the old instant restore. */
  releaseT: number;
  /** Below this road speed, m/s, the lever is a plain parking brake again:
   *  no grip loss, no throttle relief, full force. Keeps auto-hold, the
   *  standstill and low-speed manoeuvring exactly as they are. */
  minSpeed: number;
  /** m/s over which that fades in above `minSpeed`. */
  speedRamp: number;
}

/** The three tunings the feel was chosen from. Swapping the default below is
 *  a one-line change; nothing else in the file names a variant.
 *
 *  stock   the handbrake exactly as it shipped — kept so the sim can measure
 *          against it rather than remember it, and as an instant revert.
 *  nudge   "nudges the back out": rotates the car into a corner and tucks
 *          straight back in. Barely a drift, very hard to get wrong.
 *  drift   "holds a slide if you stay on the power" — the recommended one.
 *  loose   "hangs it right out and lets you steer on the throttle": a big
 *          lazy angle that needs the pedal and the counter-steer to hold. */
export const HB_VARIANTS: Record<string, HandbrakeTune> = {
  stock: {
    lat: 0.34, long: 1, force: 5600, thrRelief: 1,
    holdDeg: 0, catchDeg: 1, catchGrip: 0, catchYaw: 0, catchLead: 0,
    yawDampMul: 1, catchDamp: 1,
    engageT: 0, releaseT: 0, minSpeed: -1, speedRamp: 1,
  },
  nudge: {
    lat: 0.62, long: 0.84, force: 5600, thrRelief: 0.45,
    holdDeg: 12, catchDeg: 10, catchGrip: 1, catchYaw: 12, catchLead: 0.4,
    yawDampMul: 0.9, catchDamp: 2.6,
    engageT: 0.1, releaseT: 0.45, minSpeed: 1.5, speedRamp: 4,
  },
  drift: {
    lat: 0.5, long: 0.76, force: 4800, thrRelief: 0.3,
    holdDeg: 22, catchDeg: 14, catchGrip: 1, catchYaw: 11, catchLead: 0.4,
    yawDampMul: 0.8, catchDamp: 2.4,
    engageT: 0.1, releaseT: 0.5, minSpeed: 1.5, speedRamp: 4,
  },
  loose: {
    lat: 0.4, long: 0.7, force: 4000, thrRelief: 0.22,
    holdDeg: 34, catchDeg: 20, catchGrip: 0.95, catchYaw: 10, catchLead: 0.42,
    yawDampMul: 0.68, catchDamp: 2.1,
    engageT: 0.09, releaseT: 0.55, minSpeed: 1.5, speedRamp: 4,
  },
};

/** The live tuning. ONE-LINE VARIANT SWAP: change `drift` to `nudge`, `loose`
 *  or `stock` here and nothing else in the game needs to know. */
export const HANDBRAKE: HandbrakeTune = { ...HB_VARIANTS.drift };

try {
  (window as unknown as { __handbrake?: unknown }).__handbrake = HANDBRAKE;
} catch {
  /* non-browser (SSR, tests) — the sim imports the object directly */
}

/* ---- BARRIER CONTACT --------------------------------------------------
   How a contact with a solid — a parapet, a pier, a building — is resolved.
   The numbers live here rather than in collide.ts because collide.ts cannot
   be compiled on its own (it drags in the whole world build), and this is
   the one part of a crash a bench has to be able to drive directly:
   test/barrier-bounce-sim.mjs imports THIS object, so the table it prints
   is the shipping curve and cannot go stale.

   The three terms and why each one exists:

   `bounce(vn)` — RESTITUTION, as a function of the CLOSING SPEED ALONG THE
   WALL NORMAL. It used to be a flat 0.07 (collide.ts reflected with a
   hardcoded `* 1.07` at every contact site), which is wrong at both ends: a
   hard hit barely came off the wall, and every gentle kerb of a barrier got
   the same 7% trampoline. So:

     - below `dead` (1.1 m/s ≈ 4 km/h of closing speed) it is exactly ZERO.
       That is the graze: the car scrubs along the wall and stays on it,
       which is what a driver leaning on a barrier expects. This dead zone
       is the most important number in the block — a restitution that is
       merely *small* at low closing speed still makes a car hunting along a
       wall chatter off it, and chatter reads as a bug.
     - it rises on a smoothstep to `peak` (0.42) at `full` (7 m/s ≈ 25 km/h
       of closing speed), which is the hit you feel.
     - and past `soft` (13 m/s) it FALLS again, toward `high` (0.20) by
       `crush` (26 m/s). Not a safety fudge: it is what a real structure
       does. Past the point where sheet metal and a concrete parapet start
       deforming, the energy goes into the crush and less of it comes back.
       It also happens to be what stops a 150 km/h broadside firing the car
       across the deck.

   `capOut` is the belt to those braces: whatever the curve says, the car
   never leaves a wall faster than 6 m/s along the normal. The deck is ~18 m
   wide, so that is a bounce the driver has most of a second to catch, and it
   can never carry the car into the opposite parapet in one hop.

   `scrub(vn)` — how much of the car's WHOLE velocity a frame of contact
   costs. This is the "car gets stuck on the barrier" term. It was a flat
   0.965 on any contact, every frame, regardless of how gently the car was
   touching: a 60 fps second of leaning on a wall left 12% of the car's
   speed, and at 120 Hz, 1.4%. A car does not stop dead because it is
   touching a wall; it scrubs paint. So the loss now scales with the same
   closing speed the bounce does — 0.4%/frame for a car merely resting
   against the barrier, up to 6%/frame for a real impact — and the caller
   normalises it to a 60 Hz frame, so a 120 Hz display no longer scrubs
   twice as hard as a 60 Hz one did.

   `yawKeep(vn)` — the same story for yaw rate, which was a flat 0.65 a
   frame. That is what stopped the player steering off the wall at all: two
   frames of contact and the car had 42% of its yaw rate left, so it just
   lay there. A hard hit still gets heavy yaw damping — that is what keeps a
   barrier strike from becoming an unrecoverable spin at 150 km/h — while a
   graze now keeps essentially all of it.

   Live on the console as `window.__wallBounce`. */
export const WALL = {
  dead: 1.1,
  full: 7.0,
  peak: 0.42,
  soft: 13.0,
  crush: 26.0,
  high: 0.2,
  capOut: 6.0,
  /** Restitution for a contact closing at `vn` m/s along the wall normal. */
  bounce(vn: number) {
    if (vn <= this.dead) return 0;
    if (vn < this.full) {
      const t = (vn - this.dead) / (this.full - this.dead);
      return this.peak * t * t * (3 - 2 * t);
    }
    if (vn <= this.soft) return this.peak;
    const t = clamp((vn - this.soft) / (this.crush - this.soft), 0, 1);
    return lerp(this.peak, this.high, t * t * (3 - 2 * t));
  },
  /** Outward normal speed a contact at `vn` actually leaves with, capped. */
  rebound(vn: number) {
    return Math.min(vn * this.bounce(vn), this.capOut);
  },
  /** Per-60Hz-frame velocity retention while in contact. */
  scrub(vn: number) {
    return 1 - clamp(0.004 + 0.0072 * vn, 0, 0.06);
  },
  /** Per-60Hz-frame yaw-rate retention while in contact. */
  yawKeep(vn: number) {
    return lerp(0.985, 0.62, clamp(vn / 6, 0, 1));
  },
};

try {
  (window as unknown as { __wallBounce?: unknown }).__wallBounce = WALL;
} catch {
  /* non-browser (SSR, tests) — the sim imports the object directly */
}

/* ---- SLOPE PROBE ------------------------------------------------------
   Body pitch is `-atan(car.slope)` (engine.ts, updateCarVisual) and the POV
   camera hangs off that, so `slope` is not a physics detail — it is where
   the horizon is.

   It is measured by sampling the surface 2.2 m ahead of and behind the car
   and dividing by the 4.4 m between them. The trap: terrain.heightAt() has
   no concept of "off the road". corridor.heightAt() returns null more than a
   metre outside the pavement, and terrain.heightAt() then falls back to the
   town's ground plane — which, on the elevated deck, is TEN METRES DOWN. So
   a car jammed against a parapet at a big yaw angle puts its forward probe
   out past the barrier, reads hF ≈ 0 against hB ≈ 10, and pegs `slope` at
   the -0.35 clamp: 19 degrees of nose-down lean on a car that is standing on
   flat concrete. That is the "leans downward" the owner reported. It is a
   pure reporting bug — nothing in the handling model moved.

   The guard: a probe more than `maxRise` metres away from the ground under
   the car is not a grade, it is a different surface, so it is discarded and
   the car's own ground height stands in for it. 1.2 m over a 2.2 m reach is
   a 55% grade; the steepest real thing in this world is a ramp at ~5%
   (RAMP_RUN drops the deck's 10 m over 190 m) and `slope` is clamped to 0.35
   afterwards anyway, so nothing legitimate is within reach of it. */
export const SLOPE_PROBE = { guard: true, maxRise: 1.2 };

export interface CarState {
  x: number; y: number; z: number; h: number;
  u: number; v: number; r: number; delta: number;
  /** -1 reverse, 0 neutral, 1..RATIOS.length forward. */
  gear: number;
  rev: boolean; revT: number;
  wvx: number; wvz: number; axS: number; ayS: number;
  /** Engine speed as the tachometer draws it and the audio pitches to: the
      flywheel model in stepEngineSpeed(), NOT the raw driveline kinematics.
      Has inertia, sweeps across gear changes, and can leave idle against a
      stationary car. Read this for anything a human sees or hears. */
  rpm: number;
  /** Driveline-kinematic engine speed — road speed through the current gear,
      clamped to [IDLE_RPM, revLimit] and nothing more. This is what `rpm`
      used to be, and it stays the signal the torque lookup, the rev limiter
      and the shift scheduler run on, so the handling model is untouched by
      the flywheel model above. Physics reads this; humans read `rpm`. */
  rpmDrive: number;
  onLimiter: boolean; thrEff: number; brkEff: number; slipAmt: number;
  /** How loose the handbrake currently has the rear axle, 0..1. Ramps up over
      HANDBRAKE.engageT and, more importantly, back DOWN over releaseT, so grip
      returns on a short ramp instead of the instant the key comes up — that is
      what makes the car settle out of a slide rather than snap straight. Every
      handbrake term reads this rather than input.hb, so all of them share one
      release. Exactly 0 once the ramp has run out, which is what keeps normal
      driving bit-identical. */
  hbGrip: number;
  /** Flywheel-model state (see stepEngineSpeed). `shiftLen` is the duration
      the in-flight shift was scheduled for and `rpmShiftFrom` the engine
      speed it started at, which together let the needle sweep across the
      ratio step instead of teleporting; `revHang` counts down the beat a
      real engine holds its revs for after a throttle lift; `thrPrev` is last
      step's pedal, only used to detect that lift. `engSeeded` is false until
      the flywheel has been given its first initial condition — see the seed
      in stepPhysics, right after rpmDrive is computed. */
  shiftLen: number; rpmShiftFrom: number; revHang: number; thrPrev: number;
  engSeeded: boolean;
  /** Pre-intervention yaw/sideslip demand ESC is actively correcting for
      this frame, 0 when ESC isn't intervening — see stepPhysics's ESC
      block. Additive-only field for audio (a confident swerve that ESC
      fully cancels leaves slipAmt itself at 0, since slipAmt is derived
      from tire slip angles that ESC's ongoing correction keeps small
      across frames — this exposes the control-error signal instead, which
      IS large in exactly that moment). Does not feed back into physics. */
  slipDemand: number;
  slope: number; pitchDyn: number; rollDyn: number;
  odo: number; shiftT: number; cut: number; absOn: boolean; tcOn: boolean;
  /** Auto-hold: stopped and staying stopped until the driver asks to move. */
  hold: boolean;
  sigL: boolean; sigR: boolean;
  /** What the driver asked for: "auto" lights up at dusk and in rain,
      "on" forces them lit, "off" keeps them out whatever the sky does. */
  lightsMode: "auto" | "on" | "off"; lightsOn: boolean;
  damage: number;
}

export interface DriverInput {
  th: number; br: number; st: number; hb: number; horn: number;
}

export function freshCarState(x: number, y: number, z: number, h: number, u = 0): CarState {
  return {
    x, y, z, h, u, v: 0, r: 0, delta: 0, gear: 1, rev: false, revT: 0,
    wvx: 0, wvz: 0, axS: 0, ayS: 0, rpm: 1200, rpmDrive: IDLE_RPM, onLimiter: false,
    shiftLen: 0.24, rpmShiftFrom: 1200, revHang: 0, thrPrev: 0, engSeeded: false,
    thrEff: 0, brkEff: 0, slipAmt: 0, slipDemand: 0, hbGrip: 0,
    slope: 0, pitchDyn: 0, rollDyn: 0, odo: 0, shiftT: 0, cut: 0, absOn: false, hold: true,
    tcOn: false, sigL: false, sigR: false, lightsMode: "auto", lightsOn: true,
    damage: 0,
  };
}

function engineTorque(spec: PhysicsSpec, rpm: number) {
  const R = spec.TQ_R, T = spec.TQ_T;
  rpm = clamp(rpm, R[0], R[R.length - 1]);
  for (let i = 1; i < R.length; i++)
    if (rpm <= R[i]) return lerp(T[i - 1], T[i], (rpm - R[i - 1]) / (R[i] - R[i - 1]));
  return T[T.length - 1];
}

/* ---- Top end: how the car runs out of pull -----------------------------
   The owner's note was "the speed needs to be dropped off a little bit,
   especially at higher speeds". Measured with the real sim
   (test/topend-sim.mjs), the model's AIR was already honest and its THRUST
   was not:

     - spec.drag 0.4 IS 0.5*rho*Cd*A for Cd 0.28 and a 2.3 m^2 frontal area
       (0.394) — 101% of what an S90-shaped saloon really has. Rolling
       resistance (175 + 2.7u N) is a normal Crr ~0.013 too. Neither is the
       problem, and neither is touched here.
     - the 82 m/s clamp at the bottom of stepPhysics never bound the road
       car: terminal was 74.7 m/s. It is not a hidden speed limiter and it is
       still load-bearing for TEST MODE, which does ride it (carspecs.ts,
       TEST_ACCEL_MULT) — so it is left exactly where it is.
     - what was wrong is that the engine never gave up. TQ_T hands over
       289 N.m at the 6400 rev limiter against a 335 N.m peak, so peak POWER
       landed ON the limiter: in top gear the car made its most power at the
       exact moment it was going its fastest. And driveF used 100% of crank
       torque — there was no driveline loss in the model at all.

   So two real terms, both on the thrust side:

   1) POWER FALL-OFF. Real engines make peak power a little short of the
      limiter and fall away after it. `taperFrom` is the fraction of revLimit
      where the fall-off starts, `taperTo` the torque multiplier once the
      needle is on the limiter, smoothstepped between so nothing steps.

   2) DRIVELINE LOSS. A longitudinal automatic loses ~10-15% through the
      converter, the gearsets and the final drive, and the loss grows with
      engine speed (pumping, windage, oil churn):
      eff = effBase - effFall*(rpm/revLimit)^2.

   Why this changes the SHAPE and not just the number: both terms take a
   percentage off thrust, and a percentage off thrust costs far more at the
   top than at the bottom. At 60 mph drag is ~10% of what the engine is
   making, so 15% off the engine is ~15% off the acceleration. At 150 mph
   drag is nearly all of it, so the same 15% off the engine is most of what
   was left. That is the taper being asked for: 0-60 stays brisk, 120-140
   becomes genuinely hard-won.

   HOW TO SWAP: change the preset TOP_END is initialised from, one line
   below. Nothing else in the game reads these numbers.
   `today` reproduces the pre-change arithmetic exactly (taper 1, eff 1), so
   the bench can measure "before" through this same code path rather than
   from memory.

   Live on the console as `window.__topEnd`; test/topend-sim.mjs drives every
   preset through the real sim and prints the segment times. */
export interface TopEndProfile {
  /** Fraction of revLimit where the engine's fall-off begins. */
  taperFrom: number;
  /** Torque multiplier once the needle is on the limiter. */
  taperTo: number;
  /** Driveline efficiency extrapolated to zero rpm. */
  effBase: number;
  /** How much of that efficiency is lost by the limiter, as (rpm/revLimit)^2. */
  effFall: number;
}
export const TOP_END_PRESETS = {
  /** Exactly what shipped before this block existed — inert, kept as the
   *  measurement baseline. */
  today: { taperFrom: 1, taperTo: 1, effBase: 1, effFall: 0 },
  /** "Still pulls hard everywhere, just stops climbing sooner." Softens only
   *  the last tenth of the rev range: 0-60 mph 4.30 -> 4.54 s, while 120-140
   *  goes 7.9 -> 10.6 s. */
  mild: { taperFrom: 0.9, taperTo: 0.9, effBase: 0.97, effFall: 0.07 },
  /** SHIPPED. "Quick to 60, then the air starts winning." Matched so the car
   *  settles at 251 km/h — a real S90's 250 — with 0-60 mph 4.74 s and
   *  120-140 mph 14.1 s against today's 7.9. */
  realistic: { taperFrom: 0.86, taperTo: 0.84, effBase: 0.95, effFall: 0.09 },
  /** "You have to really want the last 20 mph." 120-140 mph takes 25.6 s and
   *  140-150 takes 29.7. Still upshifts into 6th at the same 141 mph every
   *  other preset does — no variant strands the car below top gear. */
  firm: { taperFrom: 0.8, taperTo: 0.78, effBase: 0.93, effFall: 0.11 },
} satisfies Record<string, TopEndProfile>;

/** The profile in force. Swap the preset on this line to change the feel. */
export const TOP_END: TopEndProfile = { ...TOP_END_PRESETS.realistic };

/* Console handle, same pattern (and same SSR guard) as ARCADE_STEER. */
try {
  (window as unknown as { __topEnd?: unknown }).__topEnd = TOP_END;
} catch {
  /* non-browser (SSR, tests) — the sim imports the object directly */
}

/** Engine fall-off past peak power, as a multiplier on the torque table.
    1 below TOP_END.taperFrom * revLimit, TOP_END.taperTo at the limiter. */
function topEndTaper(rpm: number, revLimit: number) {
  const from = TOP_END.taperFrom * revLimit;
  if (rpm <= from || revLimit <= from) return 1;
  return lerp(1, TOP_END.taperTo, sstep((rpm - from) / (revLimit - from)));
}

/** Driveline efficiency: what fraction of crank torque reaches the tyres.
    Falls with engine speed, so it costs most in a tall gear at speed. */
function drivelineEff(rpm: number, revLimit: number) {
  const x = clamp(rpm / revLimit, 0, 1.2);
  return clamp(TOP_END.effBase - TOP_END.effFall * x * x, 0.4, 1);
}

const IDLE_RPM = 850;
/** Reverse speed cap, m/s (~47 km/h). */
const REV_VMAX = 13;
/** Fraction of revLimit that counts as "on the redline". */
const REDLINE_FRAC = 0.985;

/** Ratio for a 1-based gear; reverse (-1) falls back to a slightly taller 1st. */
export function gearRatio(spec: PhysicsSpec, gear: number) {
  if (gear <= -1) return spec.REV ?? spec.RATIOS[0] * 1.08;
  if (gear === 0) return spec.RATIOS[0];
  return spec.RATIOS[Math.min(gear, spec.RATIOS.length) - 1];
}

/** Fuel-cut taper as revs approach the limiter, so power dies instead of
    pulling smoothly past redline. */
function limiterFactor(rpm: number, revLimit: number) {
  // must start above the wide-open upshift point, or every gear would be
  // strangled on its way to the shift
  const soft = revLimit * 0.99;
  if (rpm <= soft) return 1;
  return clamp(1 - (rpm - soft) / (revLimit - soft), 0, 1) * 0.9 + 0.1;
}

/** Engine speed a torque converter pulls the engine to at full throttle with
    the car held still — "stall speed". It is what makes a standing start
    sound like a launch: the engine climbs to here first and the car catches
    up to it, rather than the revs waiting for the wheels. */
const STALL_RPM = 2450;
/** Seconds the revs hang after a throttle lift before they start to fall. A
    real engine has a closing throttle plate working against a spinning mass,
    and every modern ECU adds deliberate anti-shunt hang on top; without it a
    lift reads as a fuel cut rather than a release. */
const REV_HANG = 0.16;

/* ---- Engine speed: the needle and the sound ----------------------------
   `car.rpmDrive`, computed in stepPhysics, is road speed through the current
   gear and nothing else. That is the right input to the torque lookup and it
   stays the physics signal — but it is a poor *engine speed*, and it is the
   one the tachometer draws and the audio pitches to:

   - It has no inertia, so a gear change teleports it. 1st->2nd is a
     3.54:2.13 ratio step, so a wide-open upshift dropped the needle ~2900rpm
     between two frames, and the audio's pitch with it. Heard, that is a
     glitch, not a shift.
   - It is clamped at IDLE_RPM, so it cannot leave idle while the car is
     stationary. Pinning the throttle at a standstill therefore moved the
     needle not at all and moved the engine's PITCH not at all — only its
     level, because the audio mixer's throttle term is the one thing that
     responded. That is exactly the reported "it sounds like it's idling and
     just getting louder, it doesn't sound like the revs are climbing".

   So the engine gets its own state: a flywheel with inertia, coupled to the
   driveline through a clutch that opens across shifts and slips at low speed
   the way a converter does. The result is deliberately NOT fed back into the
   torque path — engineTorque()/limiterFactor()/the shift map all still read
   rpmDrive — so the handling model is bit-identical to before this existed.
   This is a fidelity change to what the driver sees and hears, and it is
   confined to that on purpose: feeding a lagged rpm into the torque curve
   would retune every car's acceleration as a side effect. */
function stepEngineSpeed(
  car: CarState, spec: PhysicsSpec, dt: number, thrCmd: number, thrEff: number
) {
  const wheel = car.rpmDrive;
  let target: number;

  if (car.shiftT > 0 && car.shiftLen > 0) {
    /* Mid-shift: the clutch is open, so the engine is not tied to the wheels
       and is free to be swept. Drive it from where it was when the gear
       changed to where the new ratio puts it, on an S-curve over the shift's
       own duration — ease out of the old speed, ease into the new one. That
       shape is the whole point: a linear ramp still starts and stops
       abruptly, and abrupt is what read as a teleport. Works in both
       directions, so a downshift flares the revs UP across the shift the way
       a real box blips into the lower gear. */
    const s = sstep(1 - car.shiftT / car.shiftLen);
    target = lerp(car.rpmShiftFrom, wheel, s);
  } else {
    /* Converter slip. The engine runs at whichever is HIGHER: the speed the
       driveline is turning it at, or the speed it pulls itself to against a
       slipping converter on this much throttle (idle closed, stall wide
       open). Below stall the converter is slipping and the engine leads the
       car — that is a launch. Above it the converter is effectively locked
       and the wheels win, which is also what makes lifting off at speed drop
       you to the road's rpm rather than to idle: engine braking.

       Taking the max, rather than crossfading the two on a lock factor, is
       deliberate. A crossfade SAGS: the engine flares to stall, then the
       rising lock factor drags the target back down toward a wheel speed
       that has not caught up yet, so the needle climbs to 2450, falls to
       ~1900, and climbs again. Nothing with a torque converter in it does
       that — engine speed off the line is monotonic — and a sag is doubly
       wrong here because the audio pitches to this number, so it would be
       audible as the revs dipping mid-launch. */
    const free = IDLE_RPM + thrCmd * (STALL_RPM - IDLE_RPM);
    target = Math.max(wheel, free);
  }

  /* Rev hang, detected against the lagged pedal below: thrPrev still high
     while thrCmd has gone to nothing means the lift happened just now. It is
     suppressed across a shift — the clutch is open there, the sweep above
     already owns the whole trajectory, and letting the hang veto it froze the
     needle for the length of the shift and then dumped the entire ratio step
     in three frames once the hang expired. That is the same teleport this
     model exists to remove, reintroduced from the other side. */
  const shifting = car.shiftT > 0;
  if (shifting) car.revHang = 0;
  else if (thrCmd < 0.05 && car.thrPrev > 0.3) car.revHang = REV_HANG;
  if (car.revHang > 0) car.revHang -= dt;
  target = clamp(target, IDLE_RPM, spec.revLimit);

  if (shifting) {
    /* Mid-shift the S-curve above IS the trajectory, and it is smooth by
       construction, so the slew limiter below is not merely unnecessary but
       actively harmful: with the throttle cut to a quarter through a shift
       its downward allowance works out around 40rpm per step, well under the
       ~150 the sweep needs at its steepest, so the needle fell behind its own
       sweep for the whole shift and then closed the gap in three frames the
       moment the limits opened up again. Same teleport, one step removed. */
    car.rpm = clamp(target, IDLE_RPM, spec.revLimit);
  } else {
    /* Slew: a flywheel has mass, so engine speed is rate-limited both ways,
       and asymmetrically — the pull-up is whatever spare torque the engine
       has to accelerate its own inertia with (so it scales with throttle),
       while the fall-off is only pumping and friction losses dragging it
       back. That asymmetry is the "vroom, and then it comes down slowly"
       shape, and it is the half the old kinematic rpm had none of.

       Both limits open right up once the clutch is locked, because there the
       driveline is physically turning the engine and can change its speed
       faster than the engine could change it alone (hard braking from
       200km/h, for instance). So the limiter only bites where it should: at
       launch and on a lift.

       Rev hang lands here too, as a brake on the DOWNWARD rate rather than as
       a floor under the target. A floor plateaus the revs dead flat for its
       duration, and a plateau is its own artefact once the audio is pitching
       to this number — a sixth of a second of frozen note, then a fall.
       Slowing the decay instead gives the droop-then-fall that a real
       throttle plate closing against a spinning mass actually produces. */
    const open = wheel > IDLE_RPM + 900 ? 9 : 1;
    const hang = car.revHang > 0 ? 0.18 : 1;
    const up = (2600 + thrEff * 7400) * open;
    const down = (2200 + (1 - thrEff) * 3400) * open * hang;
    const d = target - car.rpm;
    const step = d > 0 ? Math.min(d, up * dt) : Math.max(d, -down * dt);
    car.rpm = clamp(car.rpm + step, IDLE_RPM, spec.revLimit);
  }

  /* Lagged pedal. Feeds the rev-hang edge detector above and, more
     importantly, the upshift map in stepPhysics — see the comment there for
     why the shift scheduler must not see the raw pedal. ~0.35s trail,
     framerate-independent. */
  car.thrPrev += (thrCmd - car.thrPrev) * (1 - Math.exp(-dt / 0.35));
}

function pacejka(a: number, B: number, D: number) {
  const C = 1.38, E = -0.18;
  return -D * Math.sin(C * Math.atan(B * a - E * (B * a - Math.atan(B * a))));
}

export function stepPhysics(
  car: CarState,
  input: DriverInput,
  spec: PhysicsSpec,
  dt: number,
  opts: {
    mu: number;
    tcEnabled: boolean;
    heightAt: (x: number, z: number, refY: number) => number;
    /** Test/arcade drive mode (the K toggle). Gates the two handling changes
        that cannot live in the spec because they are behaviour, not numbers:
        a tighter ESC deadband and a rear brake that gives up more of the
        pedal while cornering. Absent or false everywhere in normal play, and
        every branch it guards is written so that `false` reproduces the
        previous arithmetic exactly — normal driving is untouched. */
    arcade?: boolean;
  }
) {
  const { M, IZ, LA, LB, HCG, TRACK, WR, FINAL, RATIOS } = spec;
  const LWB = LA + LB;
  const mu = opts.mu;
  const aero = 0.8 * car.u * car.u;
  let thr = input.th, brk = input.br;
  // raw pedal demand: shift scheduling must not react to the limiter's own
  // fuel cut (or a crash cut), which zeroes `thr` below
  const thrCmd = input.th;
  const hb = clamp(input.hb, 0, 1);
  /* ---- handbrake state -------------------------------------------------
     One ramp feeds every handbrake term below, so the lever engages and (the
     point of it) releases as one thing. `hbGrip` is the lever itself; `hbG`
     is the lever gated by road speed, and is what takes grip away — below
     HANDBRAKE.minSpeed it collapses to 0 and the lever is a plain parking
     brake again, which is what leaves auto-hold and low-speed manoeuvring
     alone. With HB_VARIANTS.stock (engageT/releaseT 0, minSpeed -1) hbGrip
     and hbG are both exactly input.hb and every lerp below collapses onto the
     old inline arithmetic. */
  const HB = HANDBRAKE;
  const hbUp = HB.engageT > 0 ? dt / HB.engageT : Infinity;
  const hbDn = HB.releaseT > 0 ? dt / HB.releaseT : Infinity;
  car.hbGrip = clamp((car.hbGrip || 0) + clamp(hb - (car.hbGrip || 0), -hbDn, hbUp), 0, 1);
  const hbSpd = clamp((Math.abs(car.u) - HB.minSpeed) / Math.max(HB.speedRamp, 1e-6), 0, 1);
  const hbLever = car.hbGrip;
  const hbG = hbLever * hbSpd;
  if (car.cut > 0) {
    car.cut -= dt;
    thr = 0;
  }
  if (!car.rev) {
    if (Math.abs(car.u) < 0.5 && brk > 0.5 && thr < 0.1) {
      car.revT += dt;
      if (car.revT > 0.35) car.rev = true;
    } else car.revT = 0;
  } else if (thr > 0.3 && car.u > -0.4) car.rev = false;
  let revF = 0;
  if (car.rev) {
    const t = thr;
    thr = 0;
    const rt = brk;
    brk = t;
    // Reverse pull is scaled to mass so every car backs up with the same ~4.6
    // m/s², and tapers into the speed cap instead of switching off at a wall.
    revF = rt * M * 4.6 * clamp((REV_VMAX + car.u) / 2.5, 0, 1);
  }
  car.thrEff = car.rev ? 0 : thr;
  car.brkEff = brk;
  /* How much of the arcade steering-authority boost applies this step: 1 off
     the brake, 0 with the pedal down. Both consumers (the ESC yaw ceiling and
     the high-speed steer floor) share it so they can never disagree about
     whether the car is braking. Always 0 outside test mode, which is what
     keeps every stock number in this file exactly where it was. */
  const arcadeAuth = opts.arcade
    ? 1 - clamp(brk * ARCADE_STEER.brakeFade, 0, 1)
    : 0;

  /* Auto-hold, as a modern automatic has: once stopped, stay stopped until the
     driver asks for something. Creep alone would crawl the car away at 8 km/h
     the moment every input is released, so a parked car was never actually
     parked — and because body pitch follows the terrain slope underneath it, a
     car that wanders while "parked" shows a different resting pitch every time.
     Releases on throttle, on reverse, or on being shoved (a collision). */
  if (car.hold) {
    if (thr > 0.05 || car.rev || Math.abs(car.u) > 0.3) car.hold = false;
  } else if (Math.abs(car.u) < 0.25 && thr < 0.05 && !car.rev) car.hold = true;

  /* gearbox: -1 reverse, 1..RATIOS.length forward */
  if (car.rev) car.gear = -1;
  else if (car.gear < 1) car.gear = 1;

  car.rpmDrive = clamp(
    (Math.abs(car.u) / WR) * gearRatio(spec, car.gear) * FINAL * 9.549,
    IDLE_RPM,
    spec.revLimit
  );

  /* First step for this CarState: give the flywheel an initial condition
     instead of letting it slew up from freshCarState's placeholder. The
     player spawns already rolling (freshCarState(..., 23), engine.ts), so
     without this the engine starts at 1200rpm and stepEngineSpeed sweeps it
     up to whatever 83km/h in 1st implies — measured, a 1200 -> 8000rpm whoop
     on tanuki (5308/4532/5693 on the others) inside a quarter second, with a
     worst single step of 354rpm, at every spawn. That is the same needle
     teleport this model exists to remove, arriving from the initial
     condition instead of from a gear change.

     Deliberately BEFORE the shift block below, not inside stepEngineSpeed: a
     car dropped in at speed upshifts on its very first step, and the block
     captures rpmShiftFrom from car.rpm, so a seed placed any later would be
     read after the sweep had already been anchored to the placeholder. */
  if (!car.engSeeded) {
    car.engSeeded = true;
    car.rpm = car.rpmDrive;
  }

  // rev limiter: brief hard cut once the needle reaches redline, which is what
  // stops each gear from pulling forever and forces the upshift
  car.onLimiter = false;
  if (car.rpmDrive >= spec.revLimit * REDLINE_FRAC && thr > 0.05) {
    car.onLimiter = true;
    if (car.cut <= 0) car.cut = 0.07;
  }

  if (car.shiftT > 0) {
    car.shiftT -= dt;
    thr *= 0.25;
  } else if (!car.rev) {
    const top = RATIOS.length;
    /* part throttle short-shifts; wide-open runs each gear into the limiter.
       The wide-open point is deliberately the same rpm that arms the limiter:
       any higher and the fuel cut would stop the revs ever reaching the shift
       point, leaving the box stuck bouncing off redline in a low gear.

       The shift map reads a LAGGED pedal (car.thrPrev, a ~0.35s trail of
       thrCmd) rather than thrCmd itself. With the raw pedal, lifting off at
       speed collapsed upR from revLimit*0.985 to revLimit*0.7 within a single
       frame, which instantly satisfied the upshift test at whatever rpm the
       car happened to be pulling — and, because each upshift only drops the
       revs by one ratio step, could satisfy it AGAIN 0.24s later. Lifting off
       in 4th at 6800rpm fired two upshifts in a quarter of a second and threw
       the needle from 6800 to ~4500. That is the "the revs teleport when I
       come off the gas" report: not the engine model, the shift scheduler
       reacting to the pedal faster than any gearbox does. Trailing the pedal
       makes the lift-off upshift arrive once, deliberately, the way a real
       automatic's ~0.5s of pedal filtering does. */
    const upR = lerp(spec.revLimit * 0.7, spec.revLimit * REDLINE_FRAC, car.thrPrev);
    if (car.rpmDrive > upR && car.gear < top) {
      car.gear++;
      car.shiftT = 0.24;
    } else if (car.rpmDrive < 1900 && car.gear > 1) {
      car.gear--;
      car.shiftT = 0.2;
    } else if (thrCmd > 0.85 && car.gear > 1 && car.rpmDrive < spec.revLimit * 0.49) {
      // kickdown: only if the lower gear won't bounce off the limiter
      const rN = (car.rpmDrive * gearRatio(spec, car.gear - 1)) / gearRatio(spec, car.gear);
      if (rN < spec.revLimit * 0.85) {
        car.gear--;
        car.shiftT = 0.26;
      }
    }
    // A gear actually changed this step: freeze where the needle was and how
    // long it has to get to the new gear's speed, so stepEngineSpeed() can
    // sweep it across the ratio step instead of letting it jump (see there).
    if (car.shiftT > 0) {
      car.shiftLen = car.shiftT;
      car.rpmShiftFrom = car.rpm;
    }
  }

  stepEngineSpeed(car, spec, dt, thrCmd, thr);

  /* loads */
  const FzT = M * 9.81 + aero;
  const Fzf = clamp((M * 9.81 * LB) / LWB + aero * 0.45 - (M * car.axS * HCG) / LWB, 1800, FzT - 1800);
  const Fzr = FzT - Fzf;
  const dFz = Math.abs((M * car.ayS * HCG) / TRACK);
  const gf = 1 - 0.16 * clamp(dFz / (FzT * 0.5), 0, 1);

  /* slip angles */
  const uAbs = Math.max(Math.abs(car.u), 1.4);
  // The steer angle enters the front slip angle with the sign of travel. Rolling
  // backwards, a given steer angle slips the tyre the other way, which is what
  // swings the nose away from the turn (and the tail into it) while reversing.
  // Ramped rather than stepped through zero so the lateral force can't snap sign
  // as the car rocks around a standstill.
  const dir = clamp(car.u / 0.8, -1, 1);
  const af = Math.atan2(car.v + LA * car.r, uAbs) - car.delta * dir;
  const ar = Math.atan2(car.v - LB * car.r, uAbs);
  const muF = mu * spec.gripF * (1 - 4e-6 * Math.max(0, Fzf - (FzT * LB) / LWB));
  const muR = mu * spec.gripR * (1 - 4e-6 * Math.max(0, Fzr - (FzT * LA) / LWB));
  let Fyf = pacejka(af, 10.4, muF * Fzf * gf);
  car.tcOn = false;
  if (opts.tcEnabled && thr > 0.1 && Math.abs(ar) > 0.13 && Math.abs(car.u) > 4 && !car.rev && hbLever < 0.3) {
    thr *= clamp(1 - (Math.abs(ar) - 0.13) * (spec.awd ? 7.5 : 5.5), spec.awd ? 0.3 : 0.18, 1);
    car.tcOn = true;
  }
  /* ---- how loose the rear is, and how far out it may go ----------------
     `over` is how far past the angle the lever is meant to HOLD the car has
     already swung, normalised across the catch ramp. Inside the band it is 0
     and the rear keeps the reduced `lat` grip: that is the driver's angle to
     hold, and nothing pushes back. Past it the rear takes its grip back in
     proportion, which turns a divergent slide (the old behaviour: rear at a
     quarter of the front's grip, past the Pacejka peak, nothing to stop it)
     into one with a ceiling you can lean on. Read from sideslip rather than
     yaw rate deliberately — a spin is an ANGLE, and the old car reached 83 deg
     of it with the yaw rate already back down to 0.45 rad/s.

     Read through a short lookahead (HB.catchLead) rather than off the
     instantaneous angle, so the catch leads the slide instead of chasing it
     and lets go the moment the driver's counter-steer has it coming back.
     Pure proportional control on the angle alone measured as a pendulum: the
     same 3 s pull finishing anywhere between 0 and 41 deg of sideslip for the
     same inputs, and once 14 deg past straight the other way. */
  const hbLook = car.v + (car.ayS - car.u * car.r) * HB.catchLead;
  const hbBeta = Math.abs(Math.atan2(hbLook, Math.max(Math.abs(car.u), 4))) * (180 / Math.PI);
  const hbOver = clamp((hbBeta - HB.holdDeg) / Math.max(HB.catchDeg, 1e-6), 0, 1);
  const hbLat = lerp(1, lerp(HB.lat, lerp(HB.lat, 1, HB.catchGrip), hbOver), hbG);
  // rear-axle grip bias lives in spec.gripR (legacy's inline 1.04)
  let Fyr = pacejka(ar, 11.8, muR * Fzr * gf) * hbLat;

  /* longitudinal */
  const sgn = Math.tanh(car.u * 2.5);
  const driveT =
    thr *
    // rpmDrive, not rpm: the torque path deliberately keeps reading the raw
    // driveline kinematics so the flywheel model above stays a display/audio
    // change and cannot retune how any car accelerates. See stepEngineSpeed.
    engineTorque(spec, car.rpmDrive) *
    // the engine gives up past peak power, and the driveline takes its cut —
    // see the TOP_END block. Both are on the thrust side on purpose: the
    // drag term was already correct.
    topEndTaper(car.rpmDrive, spec.revLimit) *
    limiterFactor(car.rpmDrive, spec.revLimit) *
    (car.rpmDrive < 1400 && Math.abs(car.u) < 6 ? 1.55 : 1);
  const driveF =
    (driveT * gearRatio(spec, car.gear) * FINAL * drivelineEff(car.rpmDrive, spec.revLimit)) / WR;
  const fSplit = spec.awd ? 0.42 : 0;
  /* A locked tyre gives up its LONGITUDINAL grip as well as its lateral —
     the old model took only the lateral, so the lever kept full authority to
     both brake and drive and could simply out-pull the engine. capR0 is the
     ungoverned cap and stays the friction ellipse's reference (the ellipse is
     about how much of the REAL tyre the drive force is using); capR is what
     actually limits FxR. */
  const capF = muF * Fzf, capR0 = muR * Fzr;
  const capR = capR0 * lerp(1, HB.long, hbG);

  /* Brake demand is resolved separately from drive force so ABS can modulate it
     alone, and each axle is capped by what the friction circle has left once the
     lateral force that tyre is already producing is subtracted. Stomping the
     pedal mid-corner therefore gives up stopping power rather than steering,
     which is what a modern ABS/EBD car does; previously both were computed
     independently, the tyres went straight past the limit, and a braked corner
     ended in a spin every time. */
  const brakeF = brk * (spec.brakeF ?? BRAKE_F);
  car.absOn = false;
  // how much of each axle's grip the corner is already using, 0..1
  const useF = clamp(Math.abs(Fyf) / Math.max(capF, 1), 0, 1);
  const useR = clamp(Math.abs(Fyr) / Math.max(capR, 1), 0, 1);
  const lat = Math.max(useF, useR);
  /* EBD: proportion the pedal to the axle loads as they stand, and shade it
     further forward the harder the car is cornering. The old fixed 66/34 split
     kept asking the rear for a third of the braking while load transfer had left
     it a quarter of the weight — the rear spent its whole budget stopping and
     had none left to hold the corner. Understeer is the safe failure. */
  /* arcade shades the pedal harder toward the front as lateral load climbs
     (0.1 -> 0.28) and lifts the forward cap, so the rear keeps more of its
     grip budget for holding the corner instead of spending it stopping.
     Understeer is the safe failure; a rear that runs out mid-corner is the
     spin. Stock keeps the 0.1/0.88 it always had. */
  const bias = opts.arcade
    ? clamp(Fzf / FzT + 0.28 * lat, 0.62, 0.94)
    : clamp(Fzf / FzT + 0.1 * lat, 0.62, 0.88);
  /* The lever's own force, and how much of it the throttle lets go of. This
     is the owner's "still push out power": at full throttle the lever keeps
     only HB.thrRelief of its pull, so drive wins the FxR sum and the slide is
     sustained instead of scrubbed to a stop. Speed-gated through hbSpd so a
     stationary car cannot drive out from under its own parking brake. */
  const hbForce = hbLever * HB.force * lerp(1, HB.thrRelief, thr * hbSpd);
  let bF = bias * brakeF, bR = (1 - bias) * brakeF + hbForce;
  if (brk > 0.02 && Math.abs(car.u) > 2.5) {
    // reserve < 1 on the front lets a little braking bleed past the pure-circle
    // answer (load transfer really does buy the front grip); the floors keep the
    // pedal scrubbing speed even at full lateral. The rear holds further back
    // the harder it is cornering — a locked rear axle is what starts a spin.
    const lF = capF * Math.max(0.3, 0.98 * Math.sqrt(Math.max(0, 1 - useF * useF * 0.85)));
    const lR = capR * Math.max(
      0.12,
      lerp(0.97, opts.arcade ? 0.45 : 0.84, lat) * Math.sqrt(Math.max(0, 1 - useR * useR))
    );
    if (bF > lF) { bF = lF; car.absOn = true; }
    if (bR > lR + hbForce) { bR = lR + hbForce; car.absOn = true; }
  }
  let FxR = (car.rev ? -revF : driveF * (1 - fSplit)) - bR * sgn;
  let FxF = (car.rev ? 0 : driveF * fSplit) - bF * sgn;

  // traction side: unchanged wheelspin ceiling on drive force
  if (!car.rev && thr < 0.02 && Math.abs(FxR) > capR * 0.99 && hbLever < 0.5 && Math.abs(car.u) > 3) {
    FxR = Math.sign(FxR) * capR * 0.97;
    car.absOn = true;
  }
  FxR = clamp(FxR, -capR * 1.1, capR * 1.1);
  FxF = clamp(FxF, -capF * 1.05, capF * 1.05);

  /* friction ellipse */
  Fyf *= Math.sqrt(clamp(1 - Math.pow(FxF / (muF * Fzf), 2), 0.05, 1));
  Fyr *= Math.sqrt(clamp(1 - Math.pow(FxR / capR0, 2), 0.05, 1));

  /* creep + resistances */
  const creep =
    !car.hold && !car.rev && thr < 0.05 && brk < 0.05 && Math.abs(car.u) < 2.2 ? 520 : 0;
  const drag = spec.drag * car.u * Math.abs(car.u);
  const roll = (175 + 2.7 * Math.abs(car.u)) * sgn;
  // held cars don't roll down hills either, so the parked pose is the same on
  // any gradient rather than slowly sliding to somewhere with a different one
  const slopeF = car.hold ? 0 : 9.81 * car.slope;
  /* ESC: a modern car answers a mid-corner yaw excursion by braking individual
     wheels, i.e. with a corrective yaw moment and a little drag. Without it the
     rear axle — unloaded by a 1g stop — hands over more yaw than the steering
     asked for and the car pirouettes. The reference is the yaw rate the steer
     angle actually asks for, ceilinged by what the tyres can hold at this speed;
     the deadband leaves room for a playful slide, and the handbrake switches it
     off entirely so deliberate drifts still work. */
  let escMz = 0, escDrag = 0, slipDemand = 0;
  if (opts.tcEnabled && hbLever < 0.3 && Math.abs(car.u) > 4) {
    /* The second term is a grip ceiling: the yaw rate a tyre of this mu can
       sustain at this speed. 10.5 m/s² is a road-car number, and an arcade
       tyre holds nearly three times it — left alone, ESC caps a steady
       250 km/h corner at 1.35 g while the tyres still have 3 g, which is
       exactly the "it refuses to turn at speed" feel.

       Raising it flat, however, hands the trail-brake spin straight back:
       measured, escAy 18 applied at all times spun tanuki at 150 km/h on the
       manoeuvre e2e0fe0 fixed. So it rides arcadeAuth back down to the stock
       road-car number under brake, which is both the safe answer and the
       honest one — a tyre spending its budget stopping genuinely has less
       lateral ceiling left, and the friction ellipse a few lines up already
       says so. Off the brake the car uses the grip it has; on the brake ESC
       is exactly as tight as it is today. Stock keeps a flat 10.5. */
    const escAy = lerp(10.5, ARCADE_STEER.escAy, arcadeAuth);
    const escRef = Math.min(
      Math.abs((car.u * Math.tan(car.delta)) / LWB),
      (mu * escAy) / Math.max(Math.abs(car.u), 4)
    );
    // yaw rate beyond what the steer angle asked for, and sideslip beyond the
    // ~9 deg a tidy car ever shows — either one alone can pitch you into a spin
    /* Arcade tightens both deadbands and catches the slide much earlier. The
       stock numbers let sideslip reach 0.16 rad (9.2 deg) before ESC does
       anything, which is past the point a mid-corner brake is recoverable —
       measured, every car spun. 0.06 rad (3.4 deg) is still slack enough for
       a deliberate slide to read as one. Stock values unchanged. */
    const yawSlack = opts.arcade ? 1.04 : 1.15;
    const yawPad = opts.arcade ? 0.025 : 0.07;
    const slipPad = opts.arcade ? 0.06 : 0.16;
    const eR = Math.max(0, Math.abs(car.r) - (escRef * yawSlack + yawPad));
    const eB = Math.max(0, Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 4))) - slipPad);
    if (eR > 0 || eB > 0) {
      // The excess bleeds off over ~0.3 s rather than being opposed outright, so
      // the intervention reads as the car settling, not a handbrake grab. The
      // sideslip term fades once the yaw rate is back inside the reference —
      // otherwise it keeps pulling against a slide it has already caught and the
      // car judders instead of settling.
      const bFade = clamp(Math.abs(car.r) / (escRef + 0.15), 0, 1);
      const escK = opts.arcade ? 2.2 : 1;
      escMz = -Math.sign(car.r) * clamp(eR * 4.5 * escK + eB * 8 * escK * bFade, 0, 3.5 * escK) * IZ;
      escDrag = clamp(eR * 0.25 + eB * 0.45 * bFade, 0, 0.25) * M;
      car.tcOn = true;
      // Audio-only, additive: the same eR/eB excess that's about to be
      // corrected below, exposed BEFORE that correction is integrated —
      // see CarState.slipDemand. Not read anywhere else in this function.
      slipDemand = eR * 3 + eB * 5 * bFade;
    }
  }
  const du =
    (FxF + FxR + creep - drag - roll - escDrag * sgn - Fyf * Math.sin(car.delta)) / M -
    slopeF +
    car.v * car.r;
  const dv = (Fyf * Math.cos(car.delta) + Fyr) / M - car.u * car.r;
  /* Yaw damping is softened while the lever is up so the car rotates onto
     its angle freely, and stiffened again across the same catch ramp the rear
     grip rides, so the two agree about where the band ends and the catch
     settles the car instead of letting it bounce off the grip wall. */
  const yawDamp = (opts.arcade ? ARCADE_STEER.yawDamp : 1450) *
    lerp(1, lerp(HB.yawDampMul, HB.catchDamp, hbOver), hbG);
  /* Drift catch. Beyond the band the car is handed a yaw moment toward the
     sign of its own lateral velocity, i.e. it counter-steers itself: rotating
     the nose into the slide is what shrinks the rear slip angle and lets the
     tyre bite again. It has to be the ANGLE that is caught, not the yaw rate —
     the old car reached 83 deg of rear slip with the yaw rate already back
     down to 0.45 rad/s, and grip handed back that far past the Pacejka peak
     is worth almost nothing. Ramped through hbLook rather than
     switched on its sign, so it cannot chatter around a straight line, and
     exactly 0 inside holdDeg, so a held drift is never fought. */
  const hbMz = hbG * hbOver * HB.catchYaw * clamp(hbLook / 1.5, -1, 1) * IZ;
  const dr = (LA * Fyf * Math.cos(car.delta) - LB * Fyr - car.r * yawDamp + escMz + hbMz) / IZ;
  car.axS = lerp(car.axS, du, clamp(9 * dt, 0, 1));
  car.ayS = lerp(car.ayS, dv + car.u * car.r, clamp(9 * dt, 0, 1));
  car.u += du * dt;
  car.v += dv * dt;
  car.r += dr * dt;
  const sp = Math.abs(car.u);
  if (sp < 3) {
    const k = 1 - sp / 3;
    car.r = lerp(car.r, (car.u * Math.tan(car.delta)) / LWB, k * 0.6);
    car.v *= Math.max(0, 1 - k * 5 * dt);
  }
  if (Math.abs(car.u) < 0.2 && thr < 0.05 && revF === 0 && creep === 0) {
    car.u *= 0.7;
    if (Math.abs(car.u) < 0.05) car.u = 0;
  }
  car.u = clamp(car.u, -REV_VMAX, 82);
  car.v = clamp(car.v, -17, 17);
  car.r = clamp(car.r, -3.6, 3.6);

  /* steering — the wheel travel available at a given speed is scheduled so that
     full lock always asks for roughly the same lateral acceleration (steerAy),
     i.e. dmax = ay*L/u². The old linear speed lerp handed out ~5g worth of steer
     angle at 150 km/h, so half a stick at speed drove the front axle far past
     what the rear could follow and the car snapped into a spin; it also kinked
     at 42 m/s, which is exactly where the response felt like it changed
     character. steerMax caps it at parking speed, steerHi is the high-speed
     floor so there is always some authority left. */
  const sp2 = Math.max(Math.abs(car.u), 1) ** 2;
  /* Test mode lifts the FLOOR, never the ay term. The floor is the only part
     of this schedule that can be raised without making it steeper: below the
     speed where it binds it does nothing at all, and above that speed it
     replaces a 1/u² curve with a constant, so the schedule gets FLATTER. That
     is the opposite of the steerAy boost e2e0fe0 reverted, where slowing down
     fed the front more and more lock until the yaw rate ran away. It also
     rides arcadeAuth down under brake, so a car being slowed is never handed
     the extra lock in the first place. */
  const steerHi = spec.steerHi * lerp(1, ARCADE_STEER.hiBoost, arcadeAuth);
  const dmax = clamp(((spec.steerAy ?? STEER_AY) * LWB) / sp2, steerHi, spec.steerMax);
  const target = input.st * dmax;
  // rate limit scales with the available travel so lock-to-lock takes about the
  // same time at any speed — a fixed rad/s limit was effectively infinite once
  // dmax shrank, making high-speed inputs step discontinuities
  const rate = Math.max(dmax * (opts.arcade ? ARCADE_STEER.rate : 6.5), 0.1);
  car.delta += clamp(target - car.delta, -rate * dt, rate * dt);

  /* integrate pose */
  car.h += car.r * dt;
  const fx = Math.sin(car.h), fz = Math.cos(car.h), rx = fz, rz = -fx;
  car.wvx = fx * car.u + rx * car.v;
  car.wvz = fz * car.u + rz * car.v;
  car.x += car.wvx * dt;
  car.z += car.wvz * dt;
  car.odo += (Math.abs(car.u) * dt) / 1000;

  /* terrain height + slope */
  const hHere = opts.heightAt(car.x, car.z, car.y);
  let hF = opts.heightAt(car.x + fx * 2.2, car.z + fz * 2.2, car.y);
  let hB = opts.heightAt(car.x - fx * 2.2, car.z - fz * 2.2, car.y);
  /* A probe that has walked off the pavement reads the ground ten metres
     below the deck, not a grade — see SLOPE_PROBE. Discard it. */
  if (SLOPE_PROBE.guard) {
    if (Math.abs(hF - hHere) > SLOPE_PROBE.maxRise) hF = hHere;
    if (Math.abs(hB - hHere) > SLOPE_PROBE.maxRise) hB = hHere;
  }
  car.slope = clamp((hF - hB) / 4.4, -0.35, 0.35);
  car.y += clamp(hHere - car.y, -14 * dt, 14 * dt);
  if (Math.abs(hHere - car.y) > 3) car.y = hHere;
  car.slipAmt =
    clamp(Math.max(Math.abs(af), Math.abs(ar)) * 2 - 0.35, 0, 1.4) + (car.absOn ? 0.15 : 0);
  car.slipDemand = slipDemand;
  car.pitchDyn = lerp(car.pitchDyn, clamp(-car.axS * 0.016, -0.05, 0.05), clamp(6 * dt, 0, 1));
  car.rollDyn = lerp(car.rollDyn, clamp(car.ayS * 0.02, -0.07, 0.07), clamp(6 * dt, 0, 1));
  if (Math.abs(car.x) > 1700) {
    car.x = clamp(car.x, -1700, 1700);
    car.u *= 0.98;
  }
  // no z bound: the corridor's loop splice folds z back into its band every
  // frame — a clamp here would pin the car short of the splice threshold
  // (test/corridor-drive.mjs guards against reintroducing one)
}
