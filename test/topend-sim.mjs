#!/usr/bin/env node
/* Headless top-end bench for the PLAYER car.

   The complaint is about SHAPE, not about a number: pull needs to drop off
   more, and especially so at high speed. A real car
   fights drag that grows as v^2 against thrust that FALLS once the engine is
   past peak power and the box is out of gears, so acceleration collapses at
   the top: 0-60 mph is brisk, 120-140 mph takes forever. This bench measures
   that shape rather than just the terminal number.

   What it prints per configuration:
     - mph segment times (0-30, 30-60, 60-100, 100-120, 120-140)
     - terminal speed (settled, not a peak)
     - the road speed each upshift lands at, and the rpm at terminal
     - the drag/roll/thrust balance at terminal, so it is obvious WHICH term
       is holding the car back (air, gearing, rev limit, or the sanity clamp)

   Configurations come from physics.ts's TOP_END presets, so this bench
   measures the shipped code and cannot go stale.

   Runs the REAL physics module. TypeScript is compiled to a temp dir exactly
   as test/testdrive-accel-sim.mjs and test/steer-response-sim.mjs do it.

   Usage: node test/topend-sim.mjs
          node test/topend-sim.mjs --csv <dir>   (speed/accel traces for plots)
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "topend-"));
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
const { stepPhysics, freshCarState, TOP_END, TOP_END_PRESETS } = physics;
const { CARS } = carspecs;

const DT = 1 / 120;
const STOCK = { mu: 1.26, tcEnabled: true, heightAt: () => 0 };
const MPH = 2.2369362920544;

const car0 = CARS.find((c) => c.id === "volvo") ?? CARS[0];
const spec = car0.phys;

/* ---- reference aerodynamics -------------------------------------------
   An S90-sized saloon: frontal area ~2.3 m^2, Cd ~0.28, sea-level air.
   Half-rho-Cd-A is exactly the constant physics.ts calls spec.drag. */
const RHO = 1.225, CD = 0.28, AREA = 2.3;
const DRAG_REF = 0.5 * RHO * CD * AREA;

const MARKS_MPH = [30, 60, 100, 120, 140, 150, 160, 165, 170];

/** Full throttle from rest on the flat. Long enough that the tail is a
    plateau, so "terminal" is a settled speed and not a peak. */
function pull(seconds = 240) {
  const car = freshCarState(0, 0, 0, 0, 0);
  const t = new Map();
  const shifts = [];
  const trace = [];
  let vmax = 0, lastGear = car.gear, prevU = 0;
  for (let i = 0; i * DT < seconds; i++) {
    stepPhysics(car, { th: 1, br: 0, st: 0, hb: 0, horn: 0 }, spec, DT, STOCK);
    const time = (i + 1) * DT;
    const mph = car.u * MPH;
    vmax = Math.max(vmax, car.u);
    if (car.gear !== lastGear) {
      shifts.push({ gear: car.gear, mph, t: time });
      lastGear = car.gear;
    }
    for (const m of MARKS_MPH) if (!t.has(m) && mph >= m) t.set(m, time);
    if (i % 6 === 0) trace.push({ t: time, mph, kmh: car.u * 3.6, ax: (car.u - prevU) / (6 * DT) });
    if (i % 6 === 0) prevU = car.u;
  }
  return {
    t, shifts, trace, vmax,
    end: { u: car.u, rpm: car.rpmDrive, gear: car.gear },
  };
}

function seg(t, a, b) {
  if (!t.has(a) || !t.has(b)) return null;
  return t.get(b) - t.get(a);
}
const f = (v, d = 2) => (v === null || v === undefined ? "    — " : v.toFixed(d).padStart(6));

const presets = Object.keys(TOP_END_PRESETS ?? { current: null });
const rows = [];
for (const name of presets) {
  if (TOP_END_PRESETS) Object.assign(TOP_END, TOP_END_PRESETS[name]);
  const r = pull();
  rows.push({ name, ...r });
}

console.log("\nPLAYER CAR TOP END — full throttle from rest, flat, stock grip");
console.log(`spec: M=${spec.M}kg  FINAL=${spec.FINAL}  top gear=${spec.RATIOS[spec.RATIOS.length - 1]}` +
            `  revLimit=${spec.revLimit}  drag k=${spec.drag}`);
console.log(`reference 0.5*rho*Cd*A for Cd ${CD}, A ${AREA} m^2 = ${DRAG_REF.toFixed(3)} ` +
            `(model is ${(spec.drag / DRAG_REF * 100).toFixed(0)}% of real)\n`);
console.log("  variant       | 0-30 | 30-60 | 60-100 | 100-120 | 120-140 | 140-150 |  vmax mph (km/h) | rpm@vmax");
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(13)} |${f(r.t.get(30))}|${f(seg(r.t, 30, 60))} |${f(seg(r.t, 60, 100))}  |` +
    `${f(seg(r.t, 100, 120))}   |${f(seg(r.t, 120, 140))}   |${f(seg(r.t, 140, 150))}   |` +
    `   ${(r.vmax * MPH).toFixed(1)} (${(r.vmax * 3.6).toFixed(1)})  |  ${r.end.rpm.toFixed(0)}`
  );
}

console.log("\nupshift points (mph):");
for (const r of rows)
  console.log(`  ${r.name.padEnd(13)} ` + r.shifts.map((s) => `${s.gear}@${s.mph.toFixed(0)}`).join("  "));

console.log("\nforce balance at terminal (N):");
for (const r of rows) {
  const u = r.vmax;
  const drag = spec.drag * u * u, roll = 175 + 2.7 * u;
  console.log(`  ${r.name.padEnd(13)} u=${u.toFixed(1)} m/s  drag=${drag.toFixed(0)}  roll=${roll.toFixed(0)}` +
              `  thrust=${(drag + roll).toFixed(0)}  (real-air drag would be ${(DRAG_REF * u * u).toFixed(0)})`);
}

const csvI = process.argv.indexOf("--csv");
if (csvI > 0) {
  const dir = process.argv[csvI + 1];
  mkdirSync(dir, { recursive: true });
  const payload = rows.map((r) => ({
    name: r.name,
    vmaxMph: r.vmax * MPH,
    vmaxKmh: r.vmax * 3.6,
    marks: Object.fromEntries(r.t),
    shifts: r.shifts,
    trace: r.trace,
  }));
  writeFileSync(path.join(dir, "topend.json"), JSON.stringify(payload));
  console.log(`\nwrote ${path.join(dir, "topend.json")}`);
}

rmSync(out, { recursive: true, force: true });
