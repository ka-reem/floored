#!/usr/bin/env node
/* Headless steering-response bench for TEST MODE (the K toggle).

   The question it answers is "how long after you press the key is the car
   actually turning, and how hard", split into the stages that own the delay:

     1. the KEY FILTER in engine.ts (readInput) ramps `input.st` toward the
        key, at a rate that today HALVES between 0 and 40 m/s,
     2. the STEER RATE in physics.ts ramps `car.delta` toward `st * dmax`,
     3. the car then has to build a yaw rate through the tyres, against a
        steering schedule and an ESC that both cap how much it may have.

   Two headline numbers, because "snappy" is both:
     - t->0.25 rad/s: time from the keypress to a fixed, absolute yaw rate.
       Fixed rather than a percentage of the car's own steady state, so a
       change that gives the car MORE yaw registers as reaching any given
       yaw sooner, which is what a driver feels.
     - ss lateral g: what the corner is actually worth once settled.

   Against them, the spin-risk battery: peak sideslip in a trail brake (hold
   full lock, then stand on the pedal) across speed and pedal travel. This is
   the manoeuvre commit e2e0fe0 fixed — a boosted steerAy ran the yaw rate
   from 0.50 to 1.76 rad/s — and any steering change has to prove it did not
   bring it back. 35% and 50% pedal are in the battery deliberately: e2e0fe0
   found 50% spun every car and was as bad as 100%, because the failure is
   load transfer, not brake force.

   BEFORE/AFTER is measured, not remembered: "before" is produced by setting
   ARCADE_STEER back to the values the file used to hardcode, and "after" by
   the module's own current defaults. Both rows come from the same build of
   the real game/physics.ts, so the table cannot go stale.

   Runs the REAL physics module. No browser, no dev server: TypeScript is
   compiled to a temp dir, exactly as test/engine-rpm-check.mjs does it. The
   engine.ts key filter is mirrored here rather than compiled (engine.ts pulls
   in three.js); if it changes there, change it here — see KEY FILTER MIRROR.

   Usage: node test/steer-response-sim.mjs
          node test/steer-response-sim.mjs --keyfix
            also models the proposed engine.ts key-filter patch, which is the
            single biggest remaining lever and does not live in this file.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "steersim-"));
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
const { stepPhysics, freshCarState, ARCADE_STEER } = physics;
const { CARS, arcadeSpec } = carspecs;

const DT = 1 / 120;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const KEYFIX = process.argv.includes("--keyfix");

/** The values ARCADE_STEER's consumers used to have hardcoded — i.e. test
    mode exactly as it drove before this bench existed. Setting the object to
    these reproduces the old arithmetic step for step. */
const BEFORE = { rate: 6.5, escAy: 10.5, hiBoost: 1, yawDamp: 1450, brakeFade: 5 };
const AFTER = { ...ARCADE_STEER };
const useCfg = (c) => Object.assign(ARCADE_STEER, c);

/* ---- KEY FILTER MIRROR (game/engine.ts, readInput) --------------------
   Keyboard path only; the touch and pad branches take a different rate and
   are not what is being tuned. The `keyfix` branch is the proposed patch,
   which flattens the speed droop in test mode — it is NOT in engine.ts yet,
   and --keyfix is how its value is measured before anyone writes it. */
const KEY_BOOST = 3.2;
function stepKeyFilter(st, target, u, dt, keyfix) {
  let sRate = keyfix
    ? lerp(4.6, 4.0, clamp(Math.abs(u) / 40, 0, 1))
    : lerp(3.4, 1.7, clamp(Math.abs(u) / 40, 0, 1));
  sRate *= 1 + (KEY_BOOST - 1) * (1 - Math.abs(st));
  return st + clamp(target - st, -sRate * dt, sRate * dt);
}

const ARCADE = { mu: 1.26, tcEnabled: true, heightAt: () => 0, arcade: true };
const STOCK = { mu: 1.26, tcEnabled: true, heightAt: () => 0 };

/** Settle at a speed on a straight. Throttle is servo'd rather than scripted
    so every row starts from the same steady state whatever the gearing. */
function settle(spec, opts, u, seconds = 14) {
  const car = freshCarState(0, 0, 0, 0, u);
  for (let i = 0; i * DT < seconds; i++)
    stepPhysics(car, { th: clamp((u - car.u) * 0.5 + 0.15, 0, 1), br: 0, st: 0, hb: 0, horn: 0 },
                spec, DT, opts);
  return car;
}

/** Step the stick to `stick` and hold. Speed is held too, so the row is a
    steering measurement and not a deceleration test — the schedule is 1/u²,
    so a car that scrubs off 30 km/h is being handed a different dmax by the
    end of the run. */
function stepInput(spec, opts, kmh, stick = 1, keyfix = false, seconds = 4) {
  const u0 = kmh / 3.6;
  const car = settle(spec, opts, u0);
  let st = 0;
  const trace = [];
  for (let i = 0; i * DT < seconds; i++) {
    const t = i * DT;
    st = stepKeyFilter(st, stick, car.u, DT, keyfix);
    stepPhysics(car, { th: clamp((u0 - car.u) * 0.5 + 0.15, 0, 1), br: 0, st, hb: 0, horn: 0 },
                spec, DT, opts);
    trace.push({ t, delta: Math.abs(car.delta), r: Math.abs(car.r),
                 beta: Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 4))) });
  }
  const tail = trace.filter((s) => s.t > seconds - 0.5);
  const ssR = tail.reduce((a, s) => a + s.r, 0) / tail.length;
  return {
    ssR,
    ay: (ssR * u0) / 9.81,
    t90: trace.find((s) => s.r >= 0.9 * ssR)?.t ?? NaN,
    tFix: trace.find((s) => s.r >= 0.25)?.t ?? NaN,
    peakBeta: (trace.reduce((a, s) => Math.max(a, s.beta), 0) * 180) / Math.PI,
  };
}

/** Trail brake: settle, hold full lock 0.8 s to load the car, then apply
    `brake` while still holding the stick. Returns peak sideslip in degrees.
    Past ~45 deg the car is going backwards through the corner and no
    counter-steer recovers it; that is the spin threshold used below. */
const SPIN_DEG = 45;
/** How much extra sideslip any single trail-brake row may give up. Small on
    purpose: the point is that the car corners harder, not that it slides
    more when you then brake. */
const MARGIN_DEG = 5;
function trailBrake(spec, opts, kmh, brake, keyfix = false, seconds = 6) {
  const car = settle(spec, opts, kmh / 3.6);
  let st = 0, peakBeta = 0, peakR = 0;
  for (let i = 0; i * DT < seconds; i++) {
    const t = i * DT;
    st = stepKeyFilter(st, 1, car.u, DT, keyfix);
    stepPhysics(car, { th: 0, br: t > 0.8 ? brake : 0, st, hb: 0, horn: 0 }, spec, DT, opts);
    peakBeta = Math.max(peakBeta, Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 4))));
    peakR = Math.max(peakR, Math.abs(car.r));
  }
  return { beta: (peakBeta * 180) / Math.PI, peakR };
}

const SPEEDS = [60, 120, 180, 250];
const TRAIL = [];
for (const kmh of [120, 150, 180, 200]) for (const br of [0.35, 0.5, 0.75, 1]) TRAIL.push([kmh, br]);
const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const fails = [];

/* ---- 1. response and cornering, kaze, before vs after ---------------- */
const kaze = CARS.find((c) => c.id === "kaze");
const kazeSpec = () => arcadeSpec(kaze.phys);

console.log("\nTEST MODE — KAZE GT, step to full lock, speed held");
console.log("t->0.25 = seconds from keypress to 0.25 rad/s of yaw (the headline)\n");
console.log("  km/h |   t->0.25       |   t90 yaw       |  ss lateral g    | sideslip");
console.log("       | before  after   | before  after   | before   after   | after");
for (const kmh of SPEEDS) {
  useCfg(BEFORE); const b = stepInput(kazeSpec(), ARCADE, kmh, 1, KEYFIX);
  useCfg(AFTER);  const a = stepInput(kazeSpec(), ARCADE, kmh, 1, KEYFIX);
  const pct = (x, y) => `${y < x ? "-" : "+"}${Math.abs(((y - x) / x) * 100).toFixed(0)}%`;
  console.log(
    `  ${String(kmh).padStart(4)} | ${f(b.tFix)}  ${f(a.tFix)} ${pct(b.tFix, a.tFix).padStart(5)} ` +
    `| ${f(b.t90)}  ${f(a.t90)} ${pct(b.t90, a.t90).padStart(5)} ` +
    `| ${f(b.ay, 2)}    ${f(a.ay, 2)} ${pct(b.ay, a.ay).padStart(5)} | ${f(a.peakBeta, 1)}deg`
  );
}

/* ---- 2. steering stays linear ---------------------------------------- */
/* A bigger high-speed floor buys cornering right up until the front tyre is
   so far past its slip peak that more lock stops adding grip — at which
   point the top of the travel is dead and the car feels numb, not sharp.
   The bar is ABSOLUTE, not relative to the before row: using more of the
   tyre compresses the top of the curve by construction (that is what tyre
   saturation is), so demanding the last quarter stay as productive as it was
   at 60% of the grip would forbid the whole change. What must not happen is
   the last quarter becoming imperceptible. */
const LAST_QUARTER_MIN = 0.15; // g
console.log("\nLinearity — ss lateral g at 25/50/75/100% stick (the last step must not vanish)\n");
for (const kmh of [180, 250]) {
  const row = (cfg) => {
    useCfg(cfg);
    return [0.25, 0.5, 0.75, 1].map((s) => stepInput(kazeSpec(), ARCADE, kmh, s, KEYFIX).ay);
  };
  const b = row(BEFORE), a = row(AFTER);
  const last = (r) => r[3] - r[2];
  console.log(`  ${kmh} km/h  before ${b.map((v) => v.toFixed(2)).join(" ")} (last +${last(b).toFixed(2)}g)` +
              `   after ${a.map((v) => v.toFixed(2)).join(" ")} (last +${last(a).toFixed(2)}g)`);
  if (last(a) < LAST_QUARTER_MIN)
    fails.push(`${kmh} km/h: last quarter of stick worth only ${last(a).toFixed(2)}g — steering going numb at the top of the travel`);
}

/* ---- 3. trail-brake spin guard, every car ----------------------------- */
console.log("\nTrail brake — hold full lock, then brake. Peak sideslip, deg (X = spun)\n");
console.log("        cols: 120@.35/.5/.75/1  150@...  180@...  200@...");
for (const car of CARS) {
  const spec = () => arcadeSpec(car.phys);
  useCfg(BEFORE); const b = TRAIL.map(([k, p]) => trailBrake(spec(), ARCADE, k, p, KEYFIX));
  useCfg(AFTER);  const a = TRAIL.map(([k, p]) => trailBrake(spec(), ARCADE, k, p, KEYFIX));
  const cell = (x) => `${x.beta.toFixed(0).padStart(2)}${x.beta > SPIN_DEG ? "X" : " "}`;
  console.log(`  ${car.id.padEnd(10)} before ${b.map(cell).join("")}`);
  console.log(`  ${"".padEnd(10)} after  ${a.map(cell).join("")}`);
  for (let i = 0; i < TRAIL.length; i++) {
    /* Only a row the car COMFORTABLY held counts as a regression when it
       spins. Some baseline rows sit within a degree or two of the line
       already (tanuki at 150 km/h is 45.0), and calling 45.0 -> 45.4 a new
       spin measures the threshold, not the change. Those rows are still
       policed, by MARGIN_DEG below. */
    if (b[i].beta <= SPIN_DEG - 5 && a[i].beta > SPIN_DEG)
      fails.push(`${car.id} spins at ${TRAIL[i][0]} km/h on ${TRAIL[i][1]} brake — it comfortably held before (${b[i].beta.toFixed(0)}deg)`);
    if (a[i].beta - b[i].beta > MARGIN_DEG)
      fails.push(`${car.id} at ${TRAIL[i][0]} km/h on ${TRAIL[i][1]} brake: sideslip ${b[i].beta.toFixed(0)} -> ${a[i].beta.toFixed(0)}deg, more than ${MARGIN_DEG}deg of margin given away`);
  }
}

/* ---- 4. stock cars are untouched -------------------------------------- */
/* Not a golden file: ARCADE_STEER is set to deliberately absurd values and
   the stock rows are required to come out bit-identical anyway. That proves
   the gating itself, which is the property that actually matters — a golden
   file only proves today's numbers. */
console.log("\nStock regression — arcade off, ARCADE_STEER driven to absurd values\n");
const stockRun = () =>
  CARS.flatMap((car) => [
    ...SPEEDS.map((kmh) => stepInput(car.phys, STOCK, kmh, 1, false)),
    ...TRAIL.map(([k, p]) => trailBrake(car.phys, STOCK, k, p, false)),
  ]).map((m) => JSON.stringify(m));
useCfg(AFTER); const stockA = stockRun();
useCfg({ rate: 400, escAy: 500, hiBoost: 40, yawDamp: 10, brakeFade: 0 });
const stockB = stockRun();
useCfg(BEFORE); const stockC = stockRun();
useCfg(AFTER);
const same = stockA.every((v, i) => v === stockB[i] && v === stockC[i]);
console.log(`  ${stockA.length} rows across all ${CARS.length} cars, 3 wildly different ARCADE_STEER settings: ` +
            (same ? "IDENTICAL" : "DIFFERENT"));
if (!same) {
  const i = stockA.findIndex((v, j) => v !== stockB[j] || v !== stockC[j]);
  fails.push(`stock car row ${i} moved with ARCADE_STEER — the arcade gating leaks into normal driving`);
}

/* ---- verdict ---------------------------------------------------------- */
console.log("");
if (!KEYFIX)
  console.log("note: run with --keyfix to also model the proposed engine.ts key-filter patch.");
if (fails.length) {
  console.log("\nFAIL:");
  for (const m of fails) console.log("  - " + m);
} else {
  console.log("OK: no new spins, steering still linear, stock cars bit-identical.");
}
rmSync(out, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
