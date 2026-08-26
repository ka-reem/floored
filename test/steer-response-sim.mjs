#!/usr/bin/env node
/* Headless steering-response bench for TEST MODE (the K toggle).

   The question this answers is "how long after you press the key does the car
   actually be turning", split into the three stages that each own part of the
   delay:

     1. the KEY FILTER in engine.ts (readInput) ramps `input.st` toward the
        key, at a speed-sensitive rate,
     2. the STEER RATE in physics.ts ramps `car.delta` toward `st * dmax`,
     3. the CAR ITSELF then has to build a yaw rate through the tyres.

   Stage 3 is physics and is not up for tuning. Stages 1 and 2 are, and the
   headline number is t90(yaw) — time from the keypress to 90% of the yaw rate
   the manoeuvre eventually settles at. That is what "snappy" means to a
   driver; t90 on the steer ANGLE alone flatters a change that the tyres then
   swallow.

   Alongside it, the spin-risk numbers: peak yaw rate, peak sideslip, and the
   trail-brake case (hold the stick, then stand on the brake) that spun every
   car before commit e2e0fe0 and that a steering change must not reintroduce.

   Runs the REAL game/physics.ts. No browser, no dev server: TypeScript is
   compiled to a temp dir, exactly as test/engine-rpm-check.mjs does it. The
   engine.ts key filter is small enough to be mirrored here rather than
   compiled (engine.ts pulls in three.js); if it drifts there, fix it here —
   the mirror is marked KEY FILTER MIRROR below.

   Usage: node test/steer-response-sim.mjs
          node test/steer-response-sim.mjs --json   (machine-readable, for
                                                     before/after diffing)
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
const { stepPhysics, freshCarState } = physics;
const { CARS, testDriveSpec } = carspecs;

const DT = 1 / 120;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ---- KEY FILTER MIRROR (game/engine.ts, readInput) --------------------
   Keyboard path only — the touch/pad branches take a different rate and are
   not what the user is tuning. `testMode` selects the progressive ramp added
   in e2e0fe0. Keep in lockstep with engine.ts by eye. */
function stepKeyFilter(st, target, u, dt, testMode, boost) {
  let sRate = lerp(3.4, 1.7, clamp(Math.abs(u) / 40, 0, 1));
  if (testMode) sRate *= 1 + (boost - 1) * (1 - Math.abs(st));
  return st + clamp(target - st, -sRate * dt, sRate * dt);
}
/* The BOOST constant in engine.ts's test-mode branch. Mirrored so a change
   there can be measured here without editing this file's arithmetic. */
const KEY_BOOST = 3.2;

const OPTS_STOCK = { mu: 1.26, tcEnabled: true, heightAt: () => 0 };
const OPTS_ARCADE = { ...OPTS_STOCK, arcade: true };

/** Settle a car at a target speed on a straight, then return it ready to be
    steered. Throttle is servo'd to the speed rather than scripted so every
    speed row starts from the same steady state regardless of gearing. */
function settle(spec, opts, uTarget, seconds = 14) {
  const car = freshCarState(0, 0, 0, 0, uTarget);
  for (let i = 0; i * DT < seconds; i++) {
    const th = clamp((uTarget - car.u) * 0.5 + 0.15, 0, 1);
    stepPhysics(car, { th, br: 0, st: 0, hb: 0, horn: 0 }, spec, DT, opts);
  }
  return car;
}

/** Step the stick to full lock and trace the response.
    Returns t90 on the steer angle and on the yaw rate, plus the peaks. */
function stepInput(spec, opts, kmh, testMode, seconds = 4) {
  const u0 = kmh / 3.6;
  const car = settle(spec, opts, u0);
  let st = 0;
  const trace = [];
  for (let i = 0; i * DT < seconds; i++) {
    const t = i * DT;
    st = stepKeyFilter(st, 1, car.u, DT, testMode, KEY_BOOST);
    // hold the speed so the row is a pure steering measurement and not a
    // deceleration test — the schedule is 1/u², so a car that scrubs off
    // 30 km/h mid-corner is being handed a different dmax by the end
    const th = clamp((u0 - car.u) * 0.5 + 0.15, 0, 1);
    stepPhysics(car, { th, br: 0, st, hb: 0, horn: 0 }, spec, DT, opts);
    trace.push({ t, st, delta: Math.abs(car.delta), r: Math.abs(car.r),
                 beta: Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 4))) });
  }
  // steady state = mean of the last 0.5 s, which is well past the transient
  const tail = trace.filter((s) => s.t > seconds - 0.5);
  const ssDelta = tail.reduce((a, s) => a + s.delta, 0) / tail.length;
  const ssR = tail.reduce((a, s) => a + s.r, 0) / tail.length;
  const t90 = (key, ss) => {
    const hit = trace.find((s) => s[key] >= 0.9 * ss);
    return hit ? hit.t : NaN;
  };
  const peakR = trace.reduce((a, s) => Math.max(a, s.r), 0);
  const peak = trace.find((s) => s.r >= peakR - 1e-9);
  return {
    t90delta: t90("delta", ssDelta),
    t90yaw: t90("r", ssR),
    ssDelta, ssR, peakR, tPeakR: peak.t,
    peakBeta: trace.reduce((a, s) => Math.max(a, s.beta), 0),
  };
}

/** Trail-brake: settle at `kmh`, hold full lock for 0.8 s to load the car up,
    then stand on the brake while still holding the stick. This is the exact
    manoeuvre the boosted steerAy spun the car with (0.50 -> 1.76 rad/s). */
function trailBrake(spec, opts, kmh, testMode, brake = 1, seconds = 6) {
  const car = settle(spec, opts, kmh / 3.6);
  let st = 0;
  let peakR = 0, peakBeta = 0, spun = false;
  for (let i = 0; i * DT < seconds; i++) {
    const t = i * DT;
    st = stepKeyFilter(st, 1, car.u, DT, testMode, KEY_BOOST);
    const br = t > 0.8 ? brake : 0;
    stepPhysics(car, { th: 0, br, st, hb: 0, horn: 0 }, spec, DT, opts);
    const beta = Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 4)));
    peakR = Math.max(peakR, Math.abs(car.r));
    peakBeta = Math.max(peakBeta, beta);
    // a spin is sideslip past ~45 deg: past that the car is going backwards
    // through the corner and no amount of counter-steer is bringing it back
    if (beta > 0.79) spun = true;
  }
  return { peakR, peakBetaDeg: (peakBeta * 180) / Math.PI, spun };
}

const SPEEDS = [60, 120, 180, 250];
const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "  n/a");

const report = { steer: [], trail: [], stock: [] };

const kaze = CARS.find((c) => c.id === "kaze");
const testSpec = testDriveSpec(kaze.phys);

console.log("\nTEST MODE (kaze) — step to full lock, speed held\n");
console.log("  km/h   t90 delta   t90 yaw   ss delta   ss yaw   peak yaw  t(peak)  peak beta");
for (const kmh of SPEEDS) {
  const m = stepInput(testSpec, OPTS_ARCADE, kmh, true);
  report.steer.push({ kmh, ...m });
  console.log(
    `  ${String(kmh).padStart(4)}   ${fmt(m.t90delta)}s     ${fmt(m.t90yaw)}s   ` +
    `${fmt(m.ssDelta, 4)}    ${fmt(m.ssR)}    ${fmt(m.peakR)}    ${fmt(m.tPeakR)}s   ` +
    `${fmt((m.peakBeta * 180) / Math.PI, 1)}deg`
  );
}

console.log("\nTEST MODE (kaze) — trail brake, full lock then full pedal\n");
console.log("  km/h   peak yaw   peak beta   spun");
for (const kmh of [120, 150, 200]) {
  const m = trailBrake(testSpec, OPTS_ARCADE, kmh, true);
  report.trail.push({ kmh, ...m });
  console.log(
    `  ${String(kmh).padStart(4)}   ${fmt(m.peakR)}      ${fmt(m.peakBetaDeg, 1)}deg     ` +
    (m.spun ? "SPUN" : "held")
  );
}

console.log("\nSTOCK (unmodified specs, arcade off) — regression guard\n");
console.log("  car          km/h   t90 delta   t90 yaw   ss yaw   peak yaw");
for (const car of CARS) {
  for (const kmh of [60, 180]) {
    const m = stepInput(car.phys, OPTS_STOCK, kmh, false);
    report.stock.push({ id: car.id, kmh, ...m });
    console.log(
      `  ${car.id.padEnd(11)}  ${String(kmh).padStart(4)}   ${fmt(m.t90delta)}s     ` +
      `${fmt(m.t90yaw)}s   ${fmt(m.ssR)}    ${fmt(m.peakR)}`
    );
  }
}

const spun = report.trail.filter((r) => r.spun);
console.log(
  "\n" + (spun.length ? `FAIL: spun at ${spun.map((r) => r.kmh).join(", ")} km/h` : "OK: no spins")
);

if (process.argv.includes("--json")) {
  console.log("\n--- json ---");
  console.log(JSON.stringify(report, null, 1));
}

rmSync(out, { recursive: true, force: true });
process.exit(spun.length ? 1 : 0);
