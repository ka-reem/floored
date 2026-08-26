import { clamp, lerp, sstep } from "./util";
import { BRAKE_F, STEER_AY, type PhysicsSpec } from "./carspecs";

/* Bicycle-model vehicle sim with Pacejka lateral tires, longitudinal load
   transfer, friction ellipse, ABS, TC and slope forces. Ported from v2 and
   parameterised per car; AWD splits drive torque across both axles. */

/* ---- Arcade (test mode) steering feel ---------------------------------
   Test mode multiplies grip by 2.8 (carspecs.ts, testDriveSpec) but the
   constants in THIS file were sized for a 1.0-grip road car and do not scale
   with it, so the car ends up with F1 tyres and a saloon's idea of how much
   of them it is allowed to use. These are those constants. Every one is read
   ONLY behind `opts.arcade`, and each non-arcade path still uses its original
   literal inline, so nothing in here can move normal driving.

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
  sigL: boolean; sigR: boolean; lightsUser: boolean; lightsOn: boolean;
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
    thrEff: 0, brkEff: 0, slipAmt: 0, slipDemand: 0,
    slope: 0, pitchDyn: 0, rollDyn: 0, odo: 0, shiftT: 0, cut: 0, absOn: false, hold: true,
    tcOn: false, sigL: false, sigR: false, lightsUser: false, lightsOn: true,
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
  const hb = input.hb;
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
  if (opts.tcEnabled && thr > 0.1 && Math.abs(ar) > 0.13 && Math.abs(car.u) > 4 && !car.rev && hb < 0.3) {
    thr *= clamp(1 - (Math.abs(ar) - 0.13) * (spec.awd ? 7.5 : 5.5), spec.awd ? 0.3 : 0.18, 1);
    car.tcOn = true;
  }
  // rear-axle grip bias lives in spec.gripR (legacy's inline 1.04)
  let Fyr = pacejka(ar, 11.8, muR * Fzr * gf) * (1 - 0.66 * hb);

  /* longitudinal */
  const sgn = Math.tanh(car.u * 2.5);
  const driveT =
    thr *
    // rpmDrive, not rpm: the torque path deliberately keeps reading the raw
    // driveline kinematics so the flywheel model above stays a display/audio
    // change and cannot retune how any car accelerates. See stepEngineSpeed.
    engineTorque(spec, car.rpmDrive) *
    limiterFactor(car.rpmDrive, spec.revLimit) *
    (car.rpmDrive < 1400 && Math.abs(car.u) < 6 ? 1.55 : 1);
  const driveF = (driveT * gearRatio(spec, car.gear) * FINAL) / WR;
  const fSplit = spec.awd ? 0.42 : 0;
  const capF = muF * Fzf, capR = muR * Fzr;

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
  let bF = bias * brakeF, bR = (1 - bias) * brakeF + hb * 5600;
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
    if (bR > lR + hb * 5600) { bR = lR + hb * 5600; car.absOn = true; }
  }
  let FxR = (car.rev ? -revF : driveF * (1 - fSplit)) - bR * sgn;
  let FxF = (car.rev ? 0 : driveF * fSplit) - bF * sgn;

  // traction side: unchanged wheelspin ceiling on drive force
  if (!car.rev && thr < 0.02 && Math.abs(FxR) > capR * 0.99 && hb < 0.5 && Math.abs(car.u) > 3) {
    FxR = Math.sign(FxR) * capR * 0.97;
    car.absOn = true;
  }
  FxR = clamp(FxR, -capR * 1.1, capR * 1.1);
  FxF = clamp(FxF, -capF * 1.05, capF * 1.05);

  /* friction ellipse */
  Fyf *= Math.sqrt(clamp(1 - Math.pow(FxF / (muF * Fzf), 2), 0.05, 1));
  Fyr *= Math.sqrt(clamp(1 - Math.pow(FxR / (muR * Fzr), 2), 0.05, 1));

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
  if (opts.tcEnabled && hb < 0.3 && Math.abs(car.u) > 4) {
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
  const yawDamp = opts.arcade ? ARCADE_STEER.yawDamp : 1450;
  const dr = (LA * Fyf * Math.cos(car.delta) - LB * Fyr - car.r * yawDamp + escMz) / IZ;
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
  const hF = opts.heightAt(car.x + fx * 2.2, car.z + fz * 2.2, car.y);
  const hB = opts.heightAt(car.x - fx * 2.2, car.z - fz * 2.2, car.y);
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
