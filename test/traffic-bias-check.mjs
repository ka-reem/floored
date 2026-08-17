/* Browser-free verification of NPC lane-position personality (traffic.ts):
   persistent per-driver lateral bias + ultra-subtle slow drift.

   traffic.ts itself pulls in three.js and a live scene, so this reimplements
   the exact bias/drift arithmetic added there (rollDriver's bias+drift roll,
   maxBias()/biasAt(), and the offT/offCur tracking in updateHwy) against the
   real corridor.ts geometry, the same way corridor-drive.mjs re-derives
   highway.ts's collider set to drive the loop without a GPU. If the formulas
   here ever drift from traffic.ts, that's a bug in this file, not evidence
   either way — keep them in lockstep by eye.

   Usage: node test/traffic-bias-check.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "bias-"));
execFileSync("npx", [
  "tsc", "game/world/corridor.ts", "--outDir", out,
  "--rootDir", ".", "--module", "esnext", "--target", "es2020",
  "--moduleResolution", "bundler", "--skipLibCheck",
], { stdio: ["ignore", "ignore", "inherit"] });
const dir = path.join(out, "game", "world");
{
  const p = path.join(dir, "corridor.js");
  writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w/]+)"/g, '"$1.js"'));
}
const { getCorridor, TOLL } = await import(path.join(dir, "corridor.js"));
const c = getCorridor();

const TAU = Math.PI * 2;
let fail = 0;
const bad = (m) => { console.log("  FAIL " + m); fail++; };
const f = (n) => n.toFixed(3);

/* mulberry32, same generator traffic.ts uses, seeded for repeatability */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = (rng, lo, hi) => lo + rng() * (hi - lo);

/* ARCH tiers, mirrored from traffic.ts */
const ARCH = [
  { spd: [0.72, 0.83] }, // dawdler
  { spd: [0.85, 0.95] }, // cautious
  { spd: [0.95, 1.08] }, // average
  { spd: [1.08, 1.2] },  // brisk
  { spd: [1.2, 1.32] },  // speeder
];
const TIER_NAME = ["dawdler", "cautious", "average", "brisk", "speeder"];

const TYPE_DIM = {
  hybrid: 1.84, sedan: 1.87, compact: 1.79, kei: 1.57, suv: 1.98,
  taxi: 1.87, police: 1.87, van: 1.86, truck: 2.1, bus: 2.36, bike: 0.8,
};
const TYPES = Object.keys(TYPE_DIM);

function maxBias(W, z) {
  return Math.max(0, c.lanePitch(z) / 2 - W / 2 - 0.25);
}
function biasAt(bias, W, z) {
  const m = maxBias(W, z);
  return Math.max(-m, Math.min(bias, m));
}

/** Roll one driver exactly as traffic.ts's rollDriver does for bias/drift. */
function rollDriver(rng, type) {
  const heavy = type === "truck" || type === "bus";
  let r = rng();
  if (type === "police") r = 0.74 + r * 0.18;
  else if (heavy) r = Math.min(r, 0.66);
  const idx = r < 0.1 ? 0 : r < 0.3 ? 1 : r < 0.72 ? 2 : r < 0.92 ? 3 : 4;
  const biasLo = idx <= 1 ? 0.05 : idx === 2 ? 0.1 : 0.15;
  const biasHi = idx <= 1 ? 0.15 : idx === 2 ? 0.3 : 0.4;
  const bias = (rng() < 0.5 ? -1 : 1) * rand(rng, biasLo, biasHi);
  let driftAmp = 0, driftRate = 0;
  if (rng() >= 0.4) {
    driftAmp = rand(rng, 0.04, 0.08);
    driftRate = TAU / rand(rng, 20, 40);
  }
  const driftPhase = rng() * TAU;
  return { type, idx, bias, driftAmp, driftRate, driftPhase, W: TYPE_DIM[type] };
}

/* ---- 1. spawn distribution: bias magnitude per archetype tier ---- */
console.log("spawn distribution — bias magnitude by archetype tier:");
{
  const rng = mulberry32(1234);
  const N = 20000;
  const byTier = Array.from({ length: 5 }, () => []);
  let zeroDrift = 0, driftCount = 0, minDriftAmp = 1e9, maxDriftAmp = -1e9;
  let minPeriod = 1e9, maxPeriod = -1e9;
  for (let i = 0; i < N; i++) {
    const type = TYPES[Math.floor(rng() * TYPES.length)];
    const d = rollDriver(rng, type);
    byTier[d.idx].push(Math.abs(d.bias));
    if (d.driftAmp === 0) zeroDrift++;
    else {
      driftCount++;
      minDriftAmp = Math.min(minDriftAmp, d.driftAmp);
      maxDriftAmp = Math.max(maxDriftAmp, d.driftAmp);
      const period = TAU / d.driftRate;
      minPeriod = Math.min(minPeriod, period);
      maxPeriod = Math.max(maxPeriod, period);
    }
  }
  const expected = [
    [0.05, 0.15], [0.05, 0.15], [0.1, 0.3], [0.15, 0.4], [0.15, 0.4],
  ];
  for (let t = 0; t < 5; t++) {
    const arr = byTier[t];
    if (!arr.length) { bad(`tier ${TIER_NAME[t]}: no samples`); continue; }
    const lo = Math.min(...arr), hi = Math.max(...arr);
    console.log(`  ${TIER_NAME[t].padEnd(8)} n=${arr.length.toString().padStart(6)}  |bias| in [${f(lo)}, ${f(hi)}] m`);
    if (lo < expected[t][0] - 1e-9 || hi > expected[t][1] + 1e-9)
      bad(`tier ${TIER_NAME[t]} bias out of [${expected[t][0]}, ${expected[t][1]}]: got [${f(lo)}, ${f(hi)}]`);
  }
  console.log(`  drift: ${zeroDrift}/${N} = ${(100 * zeroDrift / N).toFixed(1)}% zero (target ~40%)`);
  console.log(`  drift amp range (non-zero): [${f(minDriftAmp)}, ${f(maxDriftAmp)}] m (target [0.04, 0.08])`);
  console.log(`  drift period range: [${minPeriod.toFixed(1)}, ${maxPeriod.toFixed(1)}] s (target [20, 40])`);
  if (Math.abs(zeroDrift / N - 0.4) > 0.02) bad(`zero-drift fraction ${(zeroDrift / N).toFixed(3)} far from 0.4`);
  if (driftCount && (minDriftAmp < 0.04 - 1e-9 || maxDriftAmp > 0.08 + 1e-9))
    bad(`drift amplitude escaped [0.04, 0.08]: [${f(minDriftAmp)}, ${f(maxDriftAmp)}]`);
  if (driftCount && (minPeriod < 20 - 1e-6 || maxPeriod > 40 + 1e-6))
    bad(`drift period escaped [20, 40]s: [${minPeriod.toFixed(2)}, ${maxPeriod.toFixed(2)}]`);
}

/* ---- 2. bias never eats the containment margin, at every lane/width the
   corridor produces, including the toll plaza's spread pitch and the fan
   tapers ---- */
console.log("bias containment across the built corridor (incl. tapers/toll):");
{
  const rng = mulberry32(99);
  let worstMargin = 1e9, worstAt = "";
  let checked = 0;
  for (let z = c.ZB0 + 1; z <= c.ZB1 - 1; z += 2) {
    const nl = c.lanes(z);
    for (const type of TYPES) {
      const d = rollDriver(rng, type);
      const hw = c.halfWidth(z);
      for (let k = 0; k < nl; k++) {
        const off = c.laneOffset(k, z) + biasAt(d.bias, d.W, z);
        const margin = hw - Math.abs(off) - d.W / 2;
        checked++;
        if (margin < worstMargin) { worstMargin = margin; worstAt = `z=${f(z)} lane ${k} type=${type}`; }
      }
    }
  }
  console.log(`  checked ${checked} (z, lane, driver) combinations`);
  console.log(`  worst pavement margin: ${f(worstMargin)} m at ${worstAt}`);
  if (worstMargin < 0) bad(`biased car pokes outside the pavement: margin ${f(worstMargin)} m at ${worstAt}`);
}

/* ---- 3. 10k-frame lane-following sim: offCur chases offT (laneOffset +
   bias) at LANE_FOLLOW_RATE, same as traffic.ts's updateHwy tail. Confirms
   no excursion past the pavement at any point along a lap, through every
   taper and the toll plaza. ---- */
console.log("10k-frame lane-follow sim (LANE_FOLLOW_RATE tracking, one car per lane*archetype):");
{
  const LANE_FOLLOW_RATE = 3.4;
  const DT = 1 / 60;
  const STEPS = 10000;
  const rng = mulberry32(4242);
  const cars = [];
  // seed one car per (type, lane at z=ZB0) so the fleet spans every lane the
  // corridor opens at its narrowest fan-in, then just let them ride the taper
  const z0 = c.ZB0 + 5;
  const nl0 = c.lanes(z0);
  for (const type of TYPES) {
    for (let k = 0; k < nl0; k++) {
      const d = rollDriver(rng, type);
      const off0 = c.laneOffset(k, z0) + biasAt(d.bias, d.W, z0);
      cars.push({ d, laneK: k, s: z0, offCur: off0, wobHist: [] });
    }
  }
  let worstMargin = 1e9, worstAt = "";
  let now = 0;
  for (let step = 0; step < STEPS; step++) {
    now += DT;
    for (const car of cars) {
      const V = 28; // m/s, mid-pack cruise
      car.s = c.wrapZ(car.s + V * DT);
      const nl = c.lanes(car.s);
      if (car.laneK > nl - 1) car.laneK = nl - 1; // taper safety net, as traffic.ts does
      const offT = c.laneOffset(car.laneK, car.s) + biasAt(car.d.bias, car.d.W, car.s);
      const dOff = offT - car.offCur;
      if (Math.abs(dOff) > 0.02) {
        car.offCur += Math.max(-LANE_FOLLOW_RATE * DT, Math.min(LANE_FOLLOW_RATE * DT, dOff));
      } else car.offCur = offT;
      const drift = car.d.driftAmp > 0 ? Math.sin(now * car.d.driftRate + car.d.driftPhase) * car.d.driftAmp : 0;
      if (car.d.driftAmp > 0 && step > 60) car.wobHist.push(Math.abs(drift));
      const renderOff = car.offCur + drift;
      const hw = c.halfWidth(car.s);
      const margin = hw - Math.abs(renderOff) - car.d.W / 2;
      if (margin < worstMargin) { worstMargin = margin; worstAt = `step=${step} z=${f(car.s)} type=${car.d.type}`; }
    }
  }
  console.log(`  simulated ${cars.length} cars x ${STEPS} frames = ${cars.length * STEPS} car-frames`);
  console.log(`  worst pavement margin over the run: ${f(worstMargin)} m at ${worstAt}`);
  if (worstMargin < 0) bad(`pavement excursion during 10k-frame run: margin ${f(worstMargin)} m at ${worstAt}`);

  // followed-car drift check: peak |drift| for every drifting car must stay <= 0.08
  let peak = 0, peakType = "";
  for (const car of cars) {
    if (!car.wobHist.length) continue;
    const m = Math.max(...car.wobHist);
    if (m > peak) { peak = m; peakType = car.d.type; }
  }
  console.log(`  peak observed drift magnitude across all drifting cars: ${f(peak)} m (type=${peakType})`);
  if (peak > 0.08 + 1e-9) bad(`observed drift ${f(peak)} m exceeds the 0.08 m cap`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall checks pass — bias stays on the pavement, drift stays subliminal");
process.exit(fail ? 1 : 0);
