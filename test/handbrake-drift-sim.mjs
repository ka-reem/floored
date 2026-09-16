#!/usr/bin/env node
/* Headless handbrake / drift bench.

   The complaint: the handbrake does not do much. It should help the car
   DRIFT — break the rear loose, keep power going down while it is held, and
   let the driver correct out of the slide.

   Three things have to be true for that to be a drift rather than a scrub:

     1. pulling the lever BREAKS THE REAR AXLE LOOSE — rear slip angle and
        yaw rate have to actually go somewhere,
     2. the throttle STILL DRIVES the car while it is held, so the slide is
        sustained instead of decaying into a stop,
     3. the slide is CORRECTABLE — counter-steer pulls the angle back, and
        releasing the lever settles the car instead of snapping it straight.

   Everything here runs the REAL game/physics.ts, compiled to a temp dir the
   way test/steer-response-sim.mjs does it. No browser, no dev server.

   BEFORE/AFTER is measured, not remembered: `HB_BEFORE` (below) is the
   HANDBRAKE object set to the values physics.ts used to hardcode inline, so
   the "before" rows are the old arithmetic reproduced step for step by the
   current build rather than a stale golden file.

   Usage:
     node test/handbrake-drift-sim.mjs             diagnosis + before/after
     node test/handbrake-drift-sim.mjs --variants  the three tuning variants
     node test/handbrake-drift-sim.mjs --csv DIR   also dump traces as CSV
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "hbsim-"));
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
const { stepPhysics, freshCarState, HANDBRAKE, HB_VARIANTS } = physics;
const { CARS } = carspecs;

const DT = 1 / 120;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEG = 180 / Math.PI;
const CSV = process.argv.includes("--csv")
  ? process.argv[process.argv.indexOf("--csv") + 1]
  : null;
if (CSV) mkdirSync(CSV, { recursive: true });

/* The values the handbrake's consumers used to have hardcoded, i.e. the
   handbrake exactly as it drove before this bench existed:
     - rear lateral force scaled by (1 - 0.66*hb)          -> lat 0.34
     - 5600 N of rear brake bolted straight onto bR        -> force 5600
     - nothing at all done to rear LONGITUDINAL grip       -> long 1
     - throttle neither cut nor relieved                   -> thrRelief 0
     - no extra yaw shaping, no release ramp, no speed gate */
const HB_BEFORE = HB_VARIANTS
  ? { ...HB_VARIANTS.stock }
  : { lat: 0.34, long: 1, force: 5600, thrRelief: 1, holdDeg: 0, catchDeg: 1,
      catchGrip: 0, yawDampMul: 1, catchDamp: 1, engageT: 0, releaseT: 0,
      minSpeed: -1, speedRamp: 1 };
const HB_AFTER = HANDBRAKE ? { ...HANDBRAKE } : { ...HB_BEFORE };
const useHB = (c) => HANDBRAKE && Object.assign(HANDBRAKE, c);

const OPTS_TC = { mu: 1.26, tcEnabled: true, heightAt: () => 0 };
const OPTS_NOTC = { mu: 1.26, tcEnabled: false, heightAt: () => 0 };

const base = CARS.find((c) => c.id === "kaze") ?? CARS[0];
const spec = () => ({ ...base.phys });

/* ---- helpers ---------------------------------------------------------- */

function settle(sp, opts, kmh, seconds = 12) {
  const u = kmh / 3.6;
  const car = freshCarState(0, 0, 0, 0, u);
  for (let i = 0; i * DT < seconds; i++)
    stepPhysics(car, { th: clamp((u - car.u) * 0.5 + 0.15, 0, 1), br: 0, st: 0, hb: 0, horn: 0 },
                sp, DT, opts);
  return car;
}

const beta = (car) => Math.atan2(car.v, Math.max(Math.abs(car.u), 4));
/** Rear tyre slip angle, the same expression physics.ts computes internally. */
function rearSlip(car, sp) {
  return Math.atan2(car.v - sp.LB * car.r, Math.max(Math.abs(car.u), 1.4));
}

/** Drive one scripted manoeuvre and return the whole trace.
    `script(t, car)` returns the DriverInput for that instant. */
function run(sp, opts, kmh, script, seconds) {
  const car = settle(sp, opts, kmh);
  const h0 = car.h;
  const rows = [];
  for (let i = 0; i * DT < seconds; i++) {
    const t = i * DT;
    const inp = script(t, car);
    stepPhysics(car, inp, sp, DT, opts);
    rows.push({
      t,
      /* GROUND speed, not car.u. car.u is body-longitudinal, so once the car
         is 60 deg sideways it reads a third of how fast the car is actually
         travelling — measuring the drift with it makes every slide look like
         it stopped. */
      kmh: Math.hypot(car.u, car.v) * 3.6,
      r: car.r,
      ar: rearSlip(car, sp) * DEG,
      beta: beta(car) * DEG,
      head: (car.h - h0) * DEG,
      delta: car.delta * DEG,
      // world pose, so the trace can be drawn as a path with the car's own
      // heading on it — which is how a drift ANGLE is actually read
      x: car.x, z: car.z, h: car.h,
      hb: inp.hb, th: inp.th, st: inp.st,
    });
  }
  return rows;
}

/** The headline manoeuvre: settle, hold the stick, pull the lever for
    `pullFor` seconds with `thr` throttle, release, keep driving. */
function pullScript({ stick = 0, thr = 0.35, pull = [1, 4] }) {
  return (t) => ({
    th: thr,
    br: 0,
    st: stick,
    hb: t >= pull[0] && t < pull[1] ? 1 : 0,
    horn: 0,
  });
}

const peak = (rows, k, from = 0, to = 1e9) =>
  rows.filter((s) => s.t >= from && s.t < to).reduce((a, s) => Math.max(a, Math.abs(s[k])), 0);
const at = (rows, t) => rows.reduce((a, s) => (Math.abs(s.t - t) < Math.abs(a.t - t) ? s : a));
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

/* ---- 1. what the lever actually does, in newtons ----------------------- */
function forceBook(sp, kmh) {
  const u = kmh / 3.6, LWB = sp.LA + sp.LB;
  const aero = 0.8 * u * u;
  const FzT = sp.M * 9.81 + aero;
  const Fzf = clamp((sp.M * 9.81 * sp.LB) / LWB + aero * 0.45, 1800, FzT - 1800);
  const Fzr = FzT - Fzf;
  const muR = 1.26 * sp.gripR * (1 - 4e-6 * Math.max(0, Fzr - (FzT * sp.LA) / LWB));
  const capR = muR * Fzr;
  return { kmh, Fzr, capR, muR };
}

/* ---- report ------------------------------------------------------------ */
const VARIANTS = process.argv.includes("--variants");

if (!VARIANTS) {
  const sp = spec();
  console.log("\n=== 1. THE LEVER, IN NEWTONS (kaze, stock spec, mu 1.26) ===\n");
  for (const kmh of [60, 100]) {
    const b = forceBook(sp, kmh);
    console.log(
      `  ${String(kmh).padStart(3)} km/h  rear load ${b.Fzr.toFixed(0)} N   ` +
      `rear grip cap (muR*Fzr) ${b.capR.toFixed(0)} N`);
    console.log(
      `           lever adds ${HB_BEFORE.force} N of REAR brake; FxR is clamped to ` +
      `+-1.1*cap = ${(b.capR * 1.1).toFixed(0)} N`);
    console.log(
      `           rear LATERAL force scaled to ${HB_BEFORE.lat} of nominal; rear ` +
      `LONGITUDINAL cap untouched (x${HB_BEFORE.long})\n`);
  }

  console.log("=== 2. A 3-SECOND PULL — before vs after ===");
  console.log("   entry speed, stick held, throttle 35% throughout, lever up t=1..4s\n");
  const rowsFor = (cfg, kmh, stick, opts) => {
    useHB(cfg);
    return run(spec(), opts, kmh, pullScript({ stick, thr: 0.35 }), 6);
  };
  const hdr = "  case                    | peak yaw r/s | peak rear slip | peak sideslip |" +
              " speed@4s | heading@4s | settle 4->5s";
  console.log(hdr);
  console.log("  " + "-".repeat(hdr.length - 2));
  for (const [kmh, stick, label] of [
    [60, 0, "60 km/h straight"],
    [60, 1, "60 km/h full stick"],
    [100, 0, "100 km/h straight"],
    [100, 1, "100 km/h full stick"],
  ]) {
    for (const [name, cfg] of [["before", HB_BEFORE], ["after ", HB_AFTER]]) {
      const rows = rowsFor(cfg, kmh, stick, OPTS_TC);
      const a4 = at(rows, 3.95), a5 = at(rows, 5.0);
      console.log(
        `  ${(label + " " + name).padEnd(23)} |    ${f(peak(rows, "r", 1, 4), 2).padStart(5)}     ` +
        `|    ${f(peak(rows, "ar", 1, 4)).padStart(5)} deg  ` +
        `|   ${f(peak(rows, "beta", 1, 4)).padStart(5)} deg ` +
        `| ${f(a4.kmh).padStart(6)}   | ${f(a4.head).padStart(7)}    ` +
        `| ${f(Math.abs(a5.ar)).padStart(5)} deg`);
    }
  }

  console.log("\n=== 3. DOES THE THROTTLE STILL DRIVE IT? ===");
  console.log("   speed at the END of a 3 s pull, by throttle position (60 km/h entry, full stick)\n");
  console.log("  throttle |   before        |   after");
  for (const th of [0, 0.35, 0.7, 1]) {
    const line = ["before", "after"].map((n, i) => {
      useHB(i ? HB_AFTER : HB_BEFORE);
      const rows = run(spec(), OPTS_TC, 60, pullScript({ stick: 1, thr: th }), 6);
      const a = at(rows, 3.95);
      return `${f(a.kmh).padStart(5)} km/h ${f(peak(rows, "ar", 1, 4)).padStart(5)}deg`;
    });
    console.log(`     ${f(th, 2)}  | ${line[0]} | ${line[1]}`);
  }

  console.log("\n=== 4. IS IT CORRECTABLE? ===");
  console.log("   enter a slide, then counter-steer. peak slip, and slip 1 s after the counter\n");
  for (const [name, cfg] of [["before", HB_BEFORE], ["after ", HB_AFTER]]) {
    useHB(cfg);
    const rows = run(spec(), OPTS_TC, 70, (t) => ({
      th: 0.4, br: 0, horn: 0,
      st: t < 1 ? 1 : t < 1.6 ? 1 : -1,          // full lock in, then opposite lock
      hb: t >= 1 && t < 1.6 ? 1 : 0,
    }), 6);
    const pk = peak(rows, "ar", 1, 3);
    console.log(`  ${name}  peak rear slip ${f(pk).padStart(5)} deg   ` +
                `-> at +1 s ${f(Math.abs(at(rows, 2.6).ar)).padStart(5)} deg   ` +
                `-> at +2 s ${f(Math.abs(at(rows, 3.6).ar)).padStart(5)} deg   ` +
                `(spun: ${pk > 90 ? "YES" : "no"})`);
  }

  console.log("\n=== 5. NORMAL DRIVING MUST NOT MOVE ===\n");
  // 5a. handbrake as a plain stop control
  for (const [name, cfg] of [["before", HB_BEFORE], ["after ", HB_AFTER]]) {
    useHB(cfg);
    const car = settle(spec(), OPTS_TC, 60);
    let d = 0, t = 0;
    while (car.u > 0.3 && t < 20) {
      stepPhysics(car, { th: 0, br: 0, st: 0, hb: 1, horn: 0 }, spec(), DT, OPTS_TC);
      d += Math.abs(car.u) * DT; t += DT;
    }
    console.log(`  ${name}  handbrake-only stop from 60 km/h: ${f(d)} m in ${f(t, 2)} s`);
  }
  // 5b. auto-hold at a standstill with the lever up
  for (const [name, cfg] of [["before", HB_BEFORE], ["after ", HB_AFTER]]) {
    useHB(cfg);
    const car = freshCarState(0, 0, 0, 0, 0);
    for (let i = 0; i < 600; i++)
      stepPhysics(car, { th: 0, br: 0, st: 0, hb: 1, horn: 0 }, spec(), DT, OPTS_TC);
    console.log(`  ${name}  5 s parked, lever up: hold=${car.hold} u=${f(car.u, 3)} moved ${f(Math.abs(car.x) + Math.abs(car.z), 3)} m`);
  }
  // 5c. every stock manoeuvre with hb=0 must be bit-identical across configs
  const noHB = () =>
    CARS.flatMap((c) => [60, 120, 180].flatMap((kmh) => [0, 1].map((stick) => {
      const rows = run({ ...c.phys }, OPTS_TC, kmh, () => ({ th: 0.4, br: 0, st: stick, hb: 0, horn: 0 }), 3);
      return JSON.stringify(rows[rows.length - 1]);
    }))).concat(
    CARS.flatMap((c) => [120, 180].map((kmh) => {
      const rows = run({ ...c.phys }, OPTS_TC, kmh, (t) => ({ th: 0, br: t > 0.8 ? 1 : 0, st: 1, hb: 0, horn: 0 }), 4);
      return JSON.stringify(rows[rows.length - 1]);
    })));
  useHB(HB_AFTER); const nA = noHB();
  useHB(HB_BEFORE); const nB = noHB();
  useHB({ ...HB_AFTER, lat: 0.01, long: 0.05, force: 40000, thrRelief: 0,
          holdDeg: 0, catchDeg: 0.5, catchGrip: 1, yawDampMul: 0.02,
          catchDamp: 60, engageT: 3, releaseT: 3, minSpeed: 40, speedRamp: 30 });
  const nC = noHB();
  useHB(HB_AFTER);
  const same = nA.every((v, i) => v === nB[i] && v === nC[i]);
  console.log(`\n  ${nA.length} lever-never-touched rows across all ${CARS.length} cars, ` +
              `3 wildly different HANDBRAKE settings: ${same ? "IDENTICAL" : "DIFFERENT"}`);
  if (!same) {
    const i = nA.findIndex((v, j) => v !== nB[j] || v !== nC[j]);
    console.log(`  FAIL: row ${i} moved — the handbrake block leaks into normal driving`);
    console.log(`    A ${nA[i]}\n    B ${nB[i]}\n    C ${nC[i]}`);
  }

  // 5d. TC on vs off
  console.log("\n  TC interaction — 60 km/h, full stick, 3 s pull, 70% throttle");
  for (const [name, cfg] of [["before", HB_BEFORE], ["after ", HB_AFTER]]) {
    useHB(cfg);
    const on = run(spec(), OPTS_TC, 60, pullScript({ stick: 1, thr: 0.7 }), 6);
    const off = run(spec(), OPTS_NOTC, 60, pullScript({ stick: 1, thr: 0.7 }), 6);
    console.log(`    ${name}  TC on  peak slip ${f(peak(on, "ar", 1, 4)).padStart(5)} deg   ` +
                `TC off peak slip ${f(peak(off, "ar", 1, 4)).padStart(5)} deg`);
  }
}

/* ---- variants ---------------------------------------------------------- */
if (VARIANTS && HB_VARIANTS) {
  console.log("\n=== TUNING VARIANTS ===\n");
  const names = Object.keys(HB_VARIANTS);
  const hdr = "  variant   | 60 straight            | 60 full stick          | 100 full stick";
  console.log(hdr);
  console.log("            | slip  yaw  kmh@4s      | slip  yaw  kmh@4s      | slip  yaw  kmh@4s");
  console.log("  " + "-".repeat(hdr.length + 4));
  for (const n of names) {
    useHB(n === "__before" ? HB_BEFORE : HB_VARIANTS[n]);
    const cells = [[60, 0], [60, 1], [100, 1]].map(([kmh, stick]) => {
      const rows = run(spec(), OPTS_TC, kmh, pullScript({ stick, thr: 0.45 }), 6);
      const a = at(rows, 3.95);
      return `${f(peak(rows, "ar", 1, 4)).padStart(5)} ${f(peak(rows, "r", 1, 4), 2).padStart(5)} ` +
             `${f(a.kmh).padStart(6)}`;
    });
    console.log(`  ${(n === "__before" ? "(today)" : n).padEnd(10)}| ${cells.join("     | ")}`);
  }
  console.log("\n  spin check — 3 s pull at full stick and full throttle, every car\n");
  for (const n of names) {
    useHB(n === "__before" ? HB_BEFORE : HB_VARIANTS[n]);
    const cells = CARS.map((c) => {
      const rows = run({ ...c.phys }, OPTS_TC, 80, pullScript({ stick: 1, thr: 1 }), 7);
      const pk = peak(rows, "ar", 1, 4);
      const settled = Math.abs(at(rows, 6.5).ar);
      return `${c.id.slice(0, 4)} ${f(pk, 0).padStart(3)}${pk > 90 ? "X" : " "}/${f(settled, 0).padStart(2)}`;
    });
    console.log(`  ${(n === "__before" ? "(today)" : n).padEnd(10)} ${cells.join("  ")}`);
  }
  console.log("\n  (peak rear slip deg during the pull / slip 2.5 s after release. X = spun)");
  useHB(HB_AFTER);
}

/* ---- CSV for the plot -------------------------------------------------- */
if (CSV) {
  /* 70% throttle, not the 45% the tables use: the headline the traces have to
     show is the SUSTAINED slide, and at 45% even the new car is scrubbing to a
     stop by the end of a 3 s pull at full lock. */
  const CSV_THR = 0.7;
  const cases = [
    ["a-straight60", 60, 0], ["b-steer60", 60, 1], ["c-steer100", 100, 1],
  ];
  const sets = [["before", HB_BEFORE], ["after", HB_AFTER]];
  if (HB_VARIANTS) for (const n of Object.keys(HB_VARIANTS)) sets.push([n, HB_VARIANTS[n]]);
  for (const [cname, kmh, stick] of cases) {
    for (const [sname, cfg] of sets) {
      useHB(cfg);
      const rows = run(spec(), OPTS_TC, kmh, pullScript({ stick, thr: CSV_THR }), 6);
      writeFileSync(path.join(CSV, `${cname}.${sname}.csv`),
        "t,kmh,r,ar,beta,head,delta,hb,x,z,h\n" +
        rows.map((s) => [s.t, s.kmh, s.r, s.ar, s.beta, s.head, s.delta, s.hb, s.x, s.z, s.h]
          .map((v) => (+v).toFixed(4)).join(",")).join("\n") + "\n");
    }
  }
  useHB(HB_AFTER);
  console.log(`\n  traces written to ${CSV}`);
}

rmSync(out, { recursive: true, force: true });
