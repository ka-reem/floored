#!/usr/bin/env node
/* Headless barrier-contact bench.

   Two questions, one rig:

   1. WHY DOES THE CAR STICK TO A BARRIER AND LEAN NOSE-DOWN?
      Reproduced here from the real modules, with the deck's analytic parapet
      clamp mirrored out of collide.ts (see PARAPET MIRROR) because collide.ts
      itself drags in the whole world build. Everything that decides how a
      contact FEELS — the restitution curve, the tangential scrub, the yaw
      damping — is imported from game/physics.ts, so this bench cannot go
      stale against the shipping numbers.

   2. WHAT DOES A HIT AT SPEED X GIVE BACK?
      Sweeps closing speed along the wall normal from a 3 km/h brush to a
      150 km/h broadside and prints, per speed: closing speed in, rebound
      speed out, the restitution ratio, whether the car stayed on the deck,
      and how long until the driver has the car back.

   BEFORE/AFTER is measured, not remembered: `--before` re-installs the
   constants collide.ts used to hardcode (a flat 1.07 normal reflection, a
   flat 0.965 on the whole velocity, a flat 0.65 on yaw, and physics.ts's
   unguarded slope probe) and re-runs the identical rig.

   Usage: node test/barrier-bounce-sim.mjs
          node test/barrier-bounce-sim.mjs --before
          node test/barrier-bounce-sim.mjs --both      (both tables)
          node test/barrier-bounce-sim.mjs --json      (machine-readable)
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "bouncesim-"));
let physics, carspecs;
try {
  execFileSync(
    "npx",
    ["tsc", "game/physics.ts", "game/carspecs.ts", "--outDir", out,
     "--module", "commonjs", "--target", "es2022", "--skipLibCheck"],
    { stdio: "pipe" }
  );
  const require_ = createRequire(import.meta.url);
  physics = require_(path.join(out, "physics.js"));
  carspecs = require_(path.join(out, "carspecs.js"));
} catch (e) {
  console.error("could not compile game/physics.ts:", e.stdout?.toString() || e.message);
  process.exit(1);
}
const { stepPhysics, freshCarState, WALL, SLOPE_PROBE } = physics;
const { CARS, arcadeSpec } = carspecs;

const DT = 1 / 120;
const FRAME = 1 / 60;              // collide runs once per RENDERED frame
const SUB = Math.round(FRAME / DT); // physics substeps per collide call
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ---- WORLD MIRROR ------------------------------------------------------
   A straight, level slice of the expressway deck: DECKY = 10 m up, a
   half-width of HW either side, and open air (the town's ground plane, y ~ 0)
   past it. corridor.heightAt() answers null more than `pad` metres outside
   the pavement, and terrain.heightAt() then falls back to the ground — that
   fallback is the whole of finding #1 below, so it is modelled exactly.
   world/const.ts: DECKY 10, LANE_W 3.7, SHOULDER 1.55. Four lanes here. */
const DECKY = 10;
const HW = (4 * 3.7) / 2 + 1.55;   // 8.95 m, a normal open-road section
const PAD = 1.0;                   // corridor.heightAt's physics pad
const GROUND = 0;
const heightAt = (x, _z, _refY) => (Math.abs(x) <= HW + PAD ? DECKY : GROUND);

/* ---- PARAPET MIRROR (game/collide.ts, the deck-parapet clamp) ----------
   Straight wall, so slopeX = 0 and the outward normal is +/-x. Everything
   else — CLAMP_STEP, the +0.06 lip, the halfW inset, the post-hit scaling —
   is the file's own arithmetic. If collide.ts changes, change it here. */
const CLAMP_STEP = 0.35;
const halfW = 1.88 / 2 - 0.005;    // player.ts: P.W / 2 - 0.005
const halfL = 4.96 / 2 + 0.02;

/** The constants collide.ts hardcoded before this change. */
const BEFORE = {
  normal: (vn) => 1.07,   // flat reflection: e = 0.07 at every speed
  scrub: () => 0.965,     // whole velocity, every frame of contact
  yaw: () => 0.65,        // yaw rate, every frame of contact
  slopeGuard: false,
};
const AFTER = {
  normal: (vn) => 1 + WALL.rebound(vn) / vn,
  scrub: (vn) => WALL.scrub(vn),
  yaw: (vn) => WALL.yawKeep(vn),
  slopeGuard: true,
};

function collideWall(car, cfg) {
  const lim = HW + 0.06 - halfW;
  let normalImpact = 0, hit = false;
  const preVx = car.wvx, preVz = car.wvz;
  const lat = car.x;
  if (Math.abs(lat) > lim) {
    const side = lat >= 0 ? 1 : -1;
    const nx = side, nz = 0;
    const pen = Math.min(Math.abs(lat) - lim, CLAMP_STEP);
    car.x -= nx * pen;
    car.z -= nz * pen;
    const vn = car.wvx * nx + car.wvz * nz;
    if (vn > 0) {
      const k = cfg.normal(vn);
      car.wvx -= nx * vn * k;
      car.wvz -= nz * vn * k;
      normalImpact = vn;
    }
    hit = true;
  }
  if (hit) {
    const s = cfg.scrub(normalImpact);
    car.wvx *= s;
    car.wvz *= s;
    const fx = Math.sin(car.h), fz = Math.cos(car.h), rx = fz, rz = -fx;
    car.u = car.wvx * fx + car.wvz * fz;
    car.v = car.wvx * rx + car.wvz * rz;
    car.r *= cfg.yaw(normalImpact);
  }
  const dvx = car.wvx - preVx, dvz = car.wvz - preVz;
  return { hit, normalImpact, wallImpact: hit ? Math.hypot(dvx, dvz) : 0 };
}

/* The shipping car: PLAYABLE_CARS[0], the Volvo S90, through arcadeSpec()
   — Game.arcade is true and every car is derived through it (carspecs.ts). */
const volvo = CARS.find((c) => c.id === "volvo") || CARS[0];
const spec = arcadeSpec(volvo.phys);

/** One approach. The car enters COASTING at `speed` m/s, `deg` off the wall,
    starting `gap` metres clear of the wall line, and is then left alone: no
    throttle, no brake, no steering. Whatever happens next is the contact
    model's doing and nothing else's. */
function run(cfg, speed, deg, opts = {}) {
  const secs = opts.secs ?? 4.0;
  const th = opts.th ?? 0;
  const gap = opts.gap ?? 1.2;
  SLOPE_PROBE.guard = cfg.slopeGuard;
  const h = (deg * Math.PI) / 180;           // heading, +x is into the east wall
  const car = freshCarState(HW - halfW - gap, DECKY, 0, h, speed);
  car.hold = false;
  car.gear = 5;
  car.wvx = Math.sin(h) * speed;
  car.wvz = Math.cos(h) * speed;
  const input = { th, br: 0, st: 0, hb: 0, horn: 0 };
  const popts = { mu: 1.26, tcEnabled: true, heightAt, arcade: true };

  let vnIn = 0, vnOut = 0, tHit = -1, t = 0, spHit = 0;
  let crashes = 0, cool = 0, contacts = 0, contactFrames = 0;
  let offDeck = false, worstSlope = 0, worstY = DECKY, lastContactT = -1;
  let maxOver = 0, minX = Infinity;
  const trace = [];
  const frames = Math.round(secs / FRAME);
  const lim = HW + 0.06 - halfW;
  for (let f = 0; f < frames; f++) {
    for (let s = 0; s < SUB; s++) stepPhysics(car, input, spec, DT, popts);
    // closing speed and overshoot measured BEFORE the clamp touches anything
    const vnPre = car.wvx;
    if (Math.abs(car.x) - lim > maxOver) maxOver = Math.abs(car.x) - lim;
    const res = collideWall(car, cfg);
    cool = Math.max(0, cool - FRAME);
    if (res.hit) {
      contactFrames++;
      if (lastContactT < 0 || t - lastContactT > 0.5) contacts++;
      lastContactT = t;
      if (res.wallImpact > 4 && cool <= 0) { cool = 0.4; crashes++; }
      if (tHit < 0 && res.normalImpact > 0) {
        tHit = t;
        vnIn = vnPre;
        vnOut = -car.wvx;            // outward = away from the east wall
        spHit = Math.hypot(car.wvx, car.wvz);
      }
    }
    if (car.y < DECKY - 0.5) offDeck = true;
    if (car.y < worstY) worstY = car.y;
    if (car.x < minX) minX = car.x;
    if (Math.abs(car.slope) > Math.abs(worstSlope)) worstSlope = car.slope;
    trace.push({
      t, x: car.x, y: car.y, u: car.u, v: car.v, r: car.r,
      sp: Math.hypot(car.wvx, car.wvz),
      slope: car.slope, hit: res.hit, vn: res.normalImpact,
    });
    t += FRAME;
  }
  /* CONTROL RECOVERED: off the wall for a quarter second, yaw rate back under
     0.3 rad/s and sideslip back under 10 deg — i.e. the car is pointing where
     it is going again and the driver has it. NOTE the car is given no
     steering input at all in this rig, so a contact that never developed
     enough rebound to leave the wall on its own reads "never": that is the
     SCRUB result, not a loss of control, and the rebound column says which
     is which. */
  let tCtl = Infinity;
  for (let i = 0; i < trace.length; i++) {
    const a = trace[i];
    if (tHit < 0 || a.t < tHit) continue;
    const slip = Math.abs(Math.atan2(a.v, Math.abs(a.u) + 1e-6));
    if (Math.abs(a.r) >= 0.3 || slip >= 0.175 || a.sp <= 3) continue;
    let clear = true;
    for (let j = i; j < trace.length && trace[j].t < a.t + 0.25; j++)
      if (trace[j].hit) clear = false;
    if (!clear) continue;
    tCtl = a.t - tHit;
    break;
  }
  // speed one second after the hit, as a share of the speed it hit at
  const after = trace.find((p) => p.t >= tHit + 1) || trace[trace.length - 1];
  return {
    vnIn, vnOut, e: vnIn > 1e-6 ? vnOut / vnIn : 0,
    tHit, tCtl, crashes, contacts, contactFrames,
    offDeck, worstY, worstSlope, maxOver, minX,
    kept: spHit > 1e-6 ? after.sp / spHit : 0,
    uEnd: car.u, speedEnd: Math.hypot(car.wvx, car.wvz), trace,
  };
}

/** Entry speed / heading that produce a given closing speed along the normal.
    Below 130 km/h of travel the angle does the work (a real glancing hit);
    above it the car is aimed straight at the wall. */
function approachFor(vnTarget) {
  const cruise = 130 / 3.6;
  if (vnTarget <= cruise * 0.999) {
    return { speed: cruise, deg: (Math.asin(vnTarget / cruise) * 180) / Math.PI };
  }
  return { speed: vnTarget, deg: 90 };
}

const kmh = (v) => v * 3.6;
const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);

/* Closing speeds swept, m/s. 0.4 is a car settling against the barrier; 1.5
   is a lane-change that clips it; 5-9 is a proper glancing hit at expressway
   speed; 21 is a 150 km/h car aimed 35 deg at the wall; 41.7 is 150 km/h
   dead into it, which is the worst thing the deck can be asked to survive. */
const SWEEP = [0.4, 0.8, 1.2, 1.8, 2.5, 4, 6, 9, 13, 18, 25, 34, 41.7];

function table(cfg, label) {
  console.log(`\n=== ${label} — closing-speed sweep into the east parapet ===`);
  console.log(
    "  closing in        rebound out        e     approach    on deck  " +
    "through?  crashes  off wall  speed kept"
  );
  const rows = [];
  for (const vt of SWEEP) {
    const a = approachFor(vt);
    const r = run(cfg, a.speed, a.deg, { gap: 0.9, secs: 6 });
    rows.push({ target: vt, deg: a.deg, entry: a.speed, ...r });
    console.log(
      `  ${f2(r.vnIn).padStart(5)} m/s ${f1(kmh(r.vnIn)).padStart(6)} km/h   ` +
      `${f2(r.vnOut).padStart(5)} m/s ${f1(kmh(r.vnOut)).padStart(6)} km/h  ` +
      `${f2(r.e).padStart(5)}  ` +
      `${f1(a.deg).padStart(5)} deg @ ${String(Math.round(kmh(a.speed))).padStart(3)}  ` +
      `${(r.offDeck ? " NO " : " yes").padStart(6)}  ` +
      `${f2(r.maxOver).padStart(7)} m ` +
      `${String(r.crashes).padStart(6)}   ` +
      `${(r.tCtl === Infinity ? " never" : f2(r.tCtl) + " s").padStart(7)}  ` +
      `${f1(r.kept * 100).padStart(6)} %`
    );
  }
  return rows;
}

function stickTable(cfg, label) {
  /* THE STUCK CASE. A shallow 6 deg lean on the wall at 120 km/h — the
     everyday "I kissed the barrier" — with the throttle held, as a player
     would. A real car scrubs paint and keeps going. */
  console.log(`\n=== ${label} — 6 deg lean-on at 120 km/h, throttle held ===`);
  const r = run(cfg, 120 / 3.6, 6, { secs: 4, th: 1, gap: 1.2 });
  console.log("     t     speed km/h   lateral x   deck y   slope   body pitch");
  for (const p of r.trace) {
    if (Math.round(p.t * 60) % 30 !== 0) continue;
    console.log(
      `  ${f2(p.t).padStart(5)}   ${f1(kmh(Math.abs(p.u))).padStart(9)}   ` +
      `${f2(p.x).padStart(9)}   ${f2(p.y).padStart(6)}   ${f2(p.slope).padStart(5)}   ` +
      `${f1((-Math.atan(p.slope) * 180) / Math.PI).padStart(7)} deg`
    );
  }
  console.log(
    `  -> ${f1(kmh(Math.abs(r.trace[r.trace.length - 1].u)))} km/h after 4 s ` +
    `(entered at 120), ${r.contactFrames} contact frames, ${r.crashes} crash(es), ` +
    `worst body pitch ${f1((-Math.atan(r.worstSlope) * 180) / Math.PI)} deg`
  );
  return r;
}

function spinTable(cfg, label) {
  /* THE LEAN CASE. A big-angle hit — the car already sideways when it reaches
     the wall — which is where the slope probe walks off the deck. */
  console.log(`\n=== ${label} — 62 deg broadside at 90 km/h (slope-probe case) ===`);
  const r = run(cfg, 90 / 3.6, 62, { secs: 3, th: 0.3, gap: 1.2 });
  console.log(
    `  worst slope ${f2(r.worstSlope)} -> body pitch ` +
    `${f1((-Math.atan(r.worstSlope) * 180) / Math.PI)} deg nose-down, ` +
    `lowest y ${f2(r.worstY)} m (deck is ${DECKY}), ` +
    `off deck: ${r.offDeck ? "YES" : "no"}`
  );
  return r;
}

const args = process.argv.slice(2);
const both = args.includes("--both");
const onlyBefore = args.includes("--before");
const asJson = args.includes("--json");

const runs = [];
if (both || onlyBefore) runs.push([BEFORE, "BEFORE"]);
if (both || !onlyBefore) runs.push([AFTER, "AFTER"]);

const results = {};
for (const [cfg, label] of runs) {
  results[label] = {
    sweep: table(cfg, label),
    stick: stickTable(cfg, label),
    spin: spinTable(cfg, label),
  };
}
if (asJson) {
  const strip = (o) => ({ ...o, trace: undefined });
  const slim = {};
  for (const k of Object.keys(results))
    slim[k] = {
      sweep: results[k].sweep.map(strip),
      stick: { ...strip(results[k].stick), trace: results[k].stick.trace },
      spin: strip(results[k].spin),
    };
  console.log("\n__JSON__" + JSON.stringify(slim));
}
rmSync(out, { recursive: true, force: true });
