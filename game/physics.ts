import { clamp, lerp } from "./util";
import type { PhysicsSpec } from "./carspecs";

/* Bicycle-model vehicle sim with Pacejka lateral tires, longitudinal load
   transfer, friction ellipse, ABS, TC and slope forces. Ported from v2 and
   parameterised per car; AWD splits drive torque across both axles. */

export interface CarState {
  x: number; y: number; z: number; h: number;
  u: number; v: number; r: number; delta: number;
  /** -1 reverse, 0 neutral, 1..RATIOS.length forward. */
  gear: number;
  rev: boolean; revT: number;
  wvx: number; wvz: number; axS: number; ayS: number;
  rpm: number; onLimiter: boolean; thrEff: number; brkEff: number; slipAmt: number;
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
    wvx: 0, wvz: 0, axS: 0, ayS: 0, rpm: 1200, onLimiter: false,
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

  car.rpm = clamp(
    (Math.abs(car.u) / WR) * gearRatio(spec, car.gear) * FINAL * 9.549,
    IDLE_RPM,
    spec.revLimit
  );

  // rev limiter: brief hard cut once the needle reaches redline, which is what
  // stops each gear from pulling forever and forces the upshift
  car.onLimiter = false;
  if (car.rpm >= spec.revLimit * REDLINE_FRAC && thr > 0.05) {
    car.onLimiter = true;
    if (car.cut <= 0) car.cut = 0.07;
  }

  if (car.shiftT > 0) {
    car.shiftT -= dt;
    thr *= 0.25;
  } else if (!car.rev) {
    const top = RATIOS.length;
    // part throttle short-shifts; wide-open runs each gear into the limiter.
    // The wide-open point is deliberately the same rpm that arms the limiter:
    // any higher and the fuel cut would stop the revs ever reaching the shift
    // point, leaving the box stuck bouncing off redline in a low gear.
    const upR = lerp(spec.revLimit * 0.7, spec.revLimit * REDLINE_FRAC, thrCmd);
    if (car.rpm > upR && car.gear < top) {
      car.gear++;
      car.shiftT = 0.24;
    } else if (car.rpm < 1900 && car.gear > 1) {
      car.gear--;
      car.shiftT = 0.2;
    } else if (thrCmd > 0.85 && car.gear > 1 && car.rpm < spec.revLimit * 0.49) {
      // kickdown: only if the lower gear won't bounce off the limiter
      const rN = (car.rpm * gearRatio(spec, car.gear - 1)) / gearRatio(spec, car.gear);
      if (rN < spec.revLimit * 0.85) {
        car.gear--;
        car.shiftT = 0.26;
      }
    }
  }

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
    engineTorque(spec, car.rpm) *
    limiterFactor(car.rpm, spec.revLimit) *
    (car.rpm < 1400 && Math.abs(car.u) < 6 ? 1.55 : 1);
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
  const brakeF = brk * 16400;
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
  const bias = clamp(Fzf / FzT + 0.1 * lat, 0.62, 0.88);
  let bF = bias * brakeF, bR = (1 - bias) * brakeF + hb * 5600;
  if (brk > 0.02 && Math.abs(car.u) > 2.5) {
    // reserve < 1 on the front lets a little braking bleed past the pure-circle
    // answer (load transfer really does buy the front grip); the floors keep the
    // pedal scrubbing speed even at full lateral. The rear holds further back
    // the harder it is cornering — a locked rear axle is what starts a spin.
    const lF = capF * Math.max(0.3, 0.98 * Math.sqrt(Math.max(0, 1 - useF * useF * 0.85)));
    const lR = capR * Math.max(0.12, lerp(0.97, 0.84, lat) * Math.sqrt(Math.max(0, 1 - useR * useR)));
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
    const escRef = Math.min(
      Math.abs((car.u * Math.tan(car.delta)) / LWB),
      (mu * 10.5) / Math.max(Math.abs(car.u), 4)
    );
    // yaw rate beyond what the steer angle asked for, and sideslip beyond the
    // ~9 deg a tidy car ever shows — either one alone can pitch you into a spin
    const eR = Math.max(0, Math.abs(car.r) - (escRef * 1.15 + 0.07));
    const eB = Math.max(0, Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 4))) - 0.16);
    if (eR > 0 || eB > 0) {
      // The excess bleeds off over ~0.3 s rather than being opposed outright, so
      // the intervention reads as the car settling, not a handbrake grab. The
      // sideslip term fades once the yaw rate is back inside the reference —
      // otherwise it keeps pulling against a slide it has already caught and the
      // car judders instead of settling.
      const bFade = clamp(Math.abs(car.r) / (escRef + 0.15), 0, 1);
      escMz = -Math.sign(car.r) * clamp(eR * 4.5 + eB * 8 * bFade, 0, 3.5) * IZ;
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
  const dr = (LA * Fyf * Math.cos(car.delta) - LB * Fyr - car.r * 1450 + escMz) / IZ;
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
  const dmax = clamp(((spec.steerAy ?? 19.5) * LWB) / sp2, spec.steerHi, spec.steerMax);
  const target = input.st * dmax;
  // rate limit scales with the available travel so lock-to-lock takes about the
  // same time at any speed — a fixed rad/s limit was effectively infinite once
  // dmax shrank, making high-speed inputs step discontinuities
  const rate = Math.max(dmax * 6.5, 0.1);
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
