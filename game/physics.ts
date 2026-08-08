import { clamp, lerp } from "./util";
import type { PhysicsSpec } from "./carspecs";

/* Bicycle-model vehicle sim with Pacejka lateral tires, longitudinal load
   transfer, friction ellipse, ABS, TC and slope forces. Ported from v2 and
   parameterised per car; AWD splits drive torque across both axles. */

export interface CarState {
  x: number; y: number; z: number; h: number;
  u: number; v: number; r: number; delta: number;
  gear: number; rev: boolean; revT: number;
  wvx: number; wvz: number; axS: number; ayS: number;
  rpm: number; thrEff: number; brkEff: number; slipAmt: number;
  slope: number; pitchDyn: number; rollDyn: number;
  odo: number; shiftT: number; cut: number; absOn: boolean; tcOn: boolean;
  sigL: boolean; sigR: boolean; lightsUser: boolean; lightsOn: boolean;
  damage: number;
}

export interface DriverInput {
  th: number; br: number; st: number; hb: number; horn: number;
}

export function freshCarState(x: number, y: number, z: number, h: number, u = 0): CarState {
  return {
    x, y, z, h, u, v: 0, r: 0, delta: 0, gear: 1, rev: false, revT: 0,
    wvx: 0, wvz: 0, axS: 0, ayS: 0, rpm: 1200, thrEff: 0, brkEff: 0, slipAmt: 0,
    slope: 0, pitchDyn: 0, rollDyn: 0, odo: 0, shiftT: 0, cut: 0, absOn: false,
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
    revF = car.u > -8 ? rt * 3400 : 0;
  }
  car.thrEff = car.rev ? 0 : thr;
  car.brkEff = brk;

  /* gearbox */
  car.rpm = clamp((Math.abs(car.u) / WR) * RATIOS[car.gear] * FINAL * 9.549, 850, spec.revLimit);
  if (car.rpm > spec.revLimit - 250 && car.cut <= 0) car.cut = 0.09;
  if (car.shiftT > 0) {
    car.shiftT -= dt;
    thr *= 0.25;
  } else {
    const top = RATIOS.length - 1;
    const upR = lerp(spec.revLimit * 0.7, spec.revLimit * 0.93, thr);
    if (car.rpm > upR && car.gear < top) {
      car.gear++;
      car.shiftT = 0.24;
    } else if (car.rpm < 1900 && car.gear > 0) {
      car.gear--;
      car.shiftT = 0.2;
    } else if (thr > 0.85 && car.gear > 0 && car.rpm < spec.revLimit * 0.49) {
      const rN = (car.rpm * RATIOS[car.gear - 1]) / RATIOS[car.gear];
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
  const af = Math.atan2(car.v + LA * car.r, uAbs) - car.delta;
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
    thr * engineTorque(spec, car.rpm) * (car.rpm < 1400 && Math.abs(car.u) < 6 ? 1.55 : 1);
  const driveF = (driveT * RATIOS[car.gear] * FINAL) / WR;
  const fSplit = spec.awd ? 0.42 : 0;
  let FxR = (car.rev ? -revF : driveF * (1 - fSplit)) - (0.34 * brk * 16400 + hb * 5600) * sgn;
  let FxF = (car.rev ? 0 : driveF * fSplit) - 0.66 * brk * 16400 * sgn;

  /* ABS (front clamp only while braking — AWD drive force must not trip it) */
  car.absOn = false;
  if (brk > 0.05 && Math.abs(FxF) > muF * Fzf * 0.99 && Math.abs(car.u) > 3) {
    FxF = Math.sign(FxF) * muF * Fzf * 0.97;
    car.absOn = true;
  }
  if (!car.rev && thr < 0.02 && Math.abs(FxR) > muR * Fzr * 0.99 && hb < 0.5 && Math.abs(car.u) > 3) {
    FxR = Math.sign(FxR) * muR * Fzr * 0.97;
    car.absOn = true;
  }
  FxR = clamp(FxR, -muR * Fzr * 1.1, muR * Fzr * 1.1);
  FxF = clamp(FxF, -muF * Fzf * 1.05, muF * Fzf * 1.05);

  /* friction ellipse */
  Fyf *= Math.sqrt(clamp(1 - Math.pow(FxF / (muF * Fzf), 2), 0.05, 1));
  Fyr *= Math.sqrt(clamp(1 - Math.pow(FxR / (muR * Fzr), 2), 0.05, 1));

  /* creep + resistances */
  const creep = !car.rev && thr < 0.05 && brk < 0.05 && Math.abs(car.u) < 2.2 ? 520 : 0;
  const drag = spec.drag * car.u * Math.abs(car.u);
  const roll = (175 + 2.7 * Math.abs(car.u)) * sgn;
  const slopeF = 9.81 * car.slope;
  const du = (FxF + FxR + creep - drag - roll - Fyf * Math.sin(car.delta)) / M - slopeF + car.v * car.r;
  const dv = (Fyf * Math.cos(car.delta) + Fyr) / M - car.u * car.r;
  const dr = (LA * Fyf * Math.cos(car.delta) - LB * Fyr - car.r * 1450) / IZ;
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
  car.u = clamp(car.u, -10, 82);
  car.v = clamp(car.v, -17, 17);
  car.r = clamp(car.r, -3.6, 3.6);

  /* steering */
  const dmax = lerp(spec.steerMax, spec.steerHi, clamp(Math.abs(car.u) / 42, 0, 1));
  const target = input.st * dmax;
  car.delta += clamp(target - car.delta, -3.2 * dt, 3.2 * dt);

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
  car.pitchDyn = lerp(car.pitchDyn, clamp(-car.axS * 0.016, -0.05, 0.05), clamp(6 * dt, 0, 1));
  car.rollDyn = lerp(car.rollDyn, clamp(car.ayS * 0.02, -0.07, 0.07), clamp(6 * dt, 0, 1));
  if (Math.abs(car.x) > 1700) {
    car.x = clamp(car.x, -1700, 1700);
    car.u *= 0.98;
  }
  if (Math.abs(car.z) > 1700) {
    car.z = clamp(car.z, -1700, 1700);
    car.u *= 0.98;
  }
}
