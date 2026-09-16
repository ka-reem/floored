#!/usr/bin/env node
/* Headless straight-line bench for TEST MODE's acceleration multiplier.

   The question it answers is whether lowering arcadeSpec's torque multiplier
   slowed the launch WITHOUT moving top speed — the two claims the change rests
   on. Test-mode vmax is not drag-bound — it sits on the 82 m/s sanity clamp
   in physics.ts, with the gearing/rev-limit above that — so the torque
   multiplier should be free to fall a long way before vmax notices; this
   proves it did not.

   BEFORE/AFTER is measured, not remembered: "after" is whatever multiplier
   arcadeSpec() currently applies (recovered from the spec itself, so the
   table cannot go stale), and "before" is the same spec with TQ_T rebuilt at
   the old x3.2 — the only field the change touched. Stock rows come from the
   untouched base spec and bound the table from below.

   Guards (exit 1):
     - vmax must not move between the old and new multiplier (< 1 km/h),
     - 0-100 must actually be slower, in proportion to the multiplier drop,
     - the current multiplier must sit at or above 2.4 — below that the
       available drive force starts meeting drag+roll near vmax and top-gear
       pull goes soft even before vmax itself moves.

   Runs the REAL physics module, gearbox and launch boost included. No
   browser: TypeScript is compiled to a temp dir, exactly as
   test/steer-response-sim.mjs does it.

   Usage: node test/testdrive-accel-sim.mjs
          node test/testdrive-accel-sim.mjs --trace  (CSV speed traces on
            stdout for plotting; guards still run)
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "accelsim-"));
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
const { CARS, arcadeSpec } = carspecs;

const DT = 1 / 120;
const TRACE = process.argv.includes("--trace");
const ARCADE = { mu: 1.26, tcEnabled: true, heightAt: () => 0, arcade: true };
const STOCK = { mu: 1.26, tcEnabled: true, heightAt: () => 0 };

const kaze = CARS.find((c) => c.id === "kaze");
const base = kaze.phys;
const testNow = arcadeSpec(base);
/* The multiplier as the shipped code applies it, recovered rather than
   restated, so an edit to carspecs.ts is what this bench measures. */
const MULT_NOW = testNow.TQ_T[0] / base.TQ_T[0];
const MULT_OLD = 3.2;
const testOld = { ...testNow, TQ_T: base.TQ_T.map((t) => t * MULT_OLD) };

/** Full throttle from a standstill on a flat straight. Returns the time at
    which each km/h mark was crossed, plus the settled top speed. Long enough
    that the last minute is spent ON vmax, so vmax is a plateau, not a peak. */
function pull(spec, opts, marks, seconds = 150) {
  const car = freshCarState(0, 0, 0, 0, 0);
  const t = new Map();
  const trace = [];
  let vmax = 0;
  for (let i = 0; i * DT < seconds; i++) {
    stepPhysics(car, { th: 1, br: 0, st: 0, hb: 0, horn: 0 }, spec, DT, opts);
    const kmh = car.u * 3.6;
    vmax = Math.max(vmax, kmh);
    for (const m of marks) if (!t.has(m) && kmh >= m) t.set(m, (i + 1) * DT);
    if (TRACE && i % 12 === 0) trace.push(`${((i + 1) * DT).toFixed(1)},${kmh.toFixed(2)}`);
  }
  return { t, vmax, trace };
}

const MARKS = [60, 100, 160, 200, 250, 280, 290];
const rows = [
  ["stock", base, STOCK],
  [`test x${MULT_OLD.toFixed(1)} (old)`, testOld, ARCADE],
  [`test x${MULT_NOW.toFixed(1)} (now)`, testNow, ARCADE],
].map(([name, spec, opts]) => ({ name, ...pull(spec, opts, MARKS) }));

const f = (v, d = 2) => (v === undefined ? "   —  " : v.toFixed(d).padStart(6));
console.log("\nTEST MODE — KAZE GT (shared spec), full throttle from standstill");
console.log(`torque multiplier in carspecs.ts right now: x${MULT_NOW.toFixed(2)}\n`);
console.log("  mode            | 0-100s | 0-200s | 200-280 | 250-290 |  vmax km/h");
for (const r of rows) {
  const seg = (a, b) =>
    r.t.has(a) && r.t.has(b) ? (r.t.get(b) - r.t.get(a)).toFixed(2).padStart(7) : "     — ";
  console.log(
    `  ${r.name.padEnd(15)} | ${f(r.t.get(100))} | ${f(r.t.get(200))} |` +
    ` ${seg(200, 280)} | ${seg(250, 290)} |  ${r.vmax.toFixed(1)}`
  );
}

if (TRACE) {
  console.log("\nTRACE t_s,kmh per mode:");
  for (const r of rows) console.log(`# ${r.name}\n` + r.trace.join("\n"));
}

/* ---- verdict ---------------------------------------------------------- */
const fails = [];
const [, old_, now_] = rows;
const dVmax = Math.abs(now_.vmax - old_.vmax);
if (dVmax > 1)
  fails.push(`vmax moved ${dVmax.toFixed(1)} km/h (${old_.vmax.toFixed(1)} -> ${now_.vmax.toFixed(1)}) — the multiplier is eating the rev-limit margin`);
if (MULT_NOW < 2.4 - 1e-9)
  fails.push(`torque multiplier x${MULT_NOW.toFixed(2)} is below the 2.4 floor that keeps vmax rev-limited with clean margin`);
if (MULT_NOW < MULT_OLD) {
  const t0 = old_.t.get(100), t1 = now_.t.get(100);
  if (!(t1 > t0 * 1.05))
    fails.push(`0-100 barely moved (${t0?.toFixed(2)}s -> ${t1?.toFixed(2)}s) for a x${MULT_OLD} -> x${MULT_NOW.toFixed(2)} torque drop`);
}

console.log("");
if (fails.length) {
  console.log("FAIL:");
  for (const m of fails) console.log("  - " + m);
} else {
  console.log(`OK: accel eased (x${MULT_OLD} -> x${MULT_NOW.toFixed(2)}), vmax unmoved (${old_.vmax.toFixed(1)} vs ${now_.vmax.toFixed(1)} km/h).`);
}
rmSync(out, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
