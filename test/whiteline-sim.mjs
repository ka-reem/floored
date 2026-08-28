/* Browser-free simulation of white-lining (the WLINE block in traffic.ts,
   wlinePaired/wlinePairRoll/wlineUpdate). Same contract as
   test/rival-sim.mjs: traffic.ts pulls in three.js and a live scene, so the
   driving arithmetic is reimplemented here against the REAL corridor.ts
   geometry. Keep this in lockstep with traffic.ts by eye.

   What this measures, per the brief:
     1. the distribution of side-by-side lateral gaps, WLINE off vs on, same
        seed and same traffic — does the gap actually grow, and on ~70% of
        pairs;
     2. zero new overlaps anywhere in the fleet with WLINE on;
     3. no oscillation — wlCur should not flap sign under a car that is
        genuinely holding a pair.

   Usage: node test/whiteline-sim.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "wlinesim-"));
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
const { getCorridor, setRoadSeed } = await import(path.join(dir, "corridor.js"));
if (process.env.ROAD_SEED) setRoadSeed(+process.env.ROAD_SEED);
const c = getCorridor();

let fail = 0;
const bad = (m) => { console.log("  FAIL " + m); fail++; };
const ok = (m) => console.log("  ok   " + m);
const f = (n) => n.toFixed(3);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- mirrors the WLINE block in traffic.ts ---- */
const WLINE = {
  sFrac: 0.6, dwell: 1.5, dv: 4, minSpeed: 9,
  openChance: 0.7, gapLo: 0.25, gapHi: 0.55, rate: 0.18, probe: 2.2,
  scanEvery: 0.3, scanJitter: 0.2,
};

const DT = 1 / 60;
const DIM = { car: { L: 4.62, W: 1.82 }, truck: { L: 9.4, W: 2.5 } };

function nearestLane(z, off) {
  const nl = c.lanes(z);
  let k = 0, bd = 1e9;
  for (let i = 0; i < nl; i++) {
    const d = Math.abs(c.laneOffset(i, z) - off);
    if (d < bd) { bd = d; k = i; }
  }
  return k;
}

function mkFleet(rng, nCars, aroundZ) {
  const out = [];
  let tries = 0, id = 0;
  while (out.length < nCars && tries++ < nCars * 40) {
    const z = c.wrapZ(aroundZ + (rng() - 0.5) * 1600);
    const heavy = rng() < 0.12;
    const d = heavy ? DIM.truck : DIM.car;
    const k = Math.min(Math.floor(rng() * c.lanes(z)), c.lanes(z) - 1);
    const off = c.laneOffset(k, z);
    let blocked = false;
    for (const m of out)
      if (Math.abs(m.off - off) < 2.2 && Math.abs(c.deltaZ(m.s, z)) < 25) blocked = true;
    if (blocked) continue;
    const cruise = heavy ? 16 + rng() * 5 : 19 + rng() * 12;
    out.push({
      id: id++, s: z, L: d.L, W: d.W, off, offT: off, laneK: k, v: cruise, v0: cruise,
      turnCd: 3 + rng() * 10, blink: 0, pendK: -1, mergeLean: 0, wreck: null,
      wlPartner: null, wlDwell: 0, wlRolled: false, wlOpen: false, wlGap: 0,
      wlLat: 0, wlCur: 0, wlT: rng() * WLINE.scanEvery,
    });
  }
  return out;
}

// -------- the driving model: IDM follow + blind lane changes (see
// test/rival-sim.mjs's fleet model — same shape, reused here) --------
function stepFleet(fleet, rng, wlineOn, stats) {
  for (const m of fleet) {
    let ld = Infinity, lv = 0;
    for (const o of fleet) {
      if (o === m) continue;
      if (Math.abs(o.off - m.off) > 1.9) continue;
      const ah = c.deltaZ(m.s, o.s);
      if (ah <= 0 || ah > 70) continue;
      const d = Math.max(ah - (o.L + m.L) / 2, 0.1);
      if (d < ld) { ld = d; lv = o.v; }
    }
    let acc;
    const aMax = 1.6, bCom = 2.3, T = 1.25, s0 = 2.2;
    if (ld < 1e8) {
      const dv = m.v - lv;
      const sS = s0 + m.v * T + (m.v * dv) / (2 * Math.sqrt(aMax * bCom));
      acc = aMax * (1 - Math.pow(m.v / m.v0, 4) - Math.pow(sS / Math.max(ld, 0.55), 2));
    } else acc = aMax * (1 - Math.pow(m.v / m.v0, 4));
    m.v = Math.max(0, m.v + clamp(acc, -8.5, 3.2) * DT);
    m.s = c.wrapZ(m.s + m.v * DT);

    m.turnCd -= DT;
    const nl = c.lanes(m.s);
    if (m.turnCd <= 0) {
      m.turnCd = 6 + rng() * 12;
      const k2 = m.laneK + (rng() < 0.5 ? -1 : 1);
      if (k2 >= 0 && k2 <= nl - 1) {
        const off2 = c.laneOffset(k2, m.s);
        let ok2 = true;
        for (const o of fleet) {
          if (o === m) continue;
          if (Math.abs(o.off - off2) > 2.2) continue;
          const dz = c.deltaZ(m.s, o.s);
          if (dz > -(13.5 + (o.L + m.L) / 2) && dz < 23.5 + (o.L + m.L) / 2) { ok2 = false; break; }
        }
        if (ok2) { m.laneK = k2; m.blink = k2 > (m.prevLaneK ?? k2) ? 1 : -1; m.blinkT = 0.4; }
      }
    }
    if (m.blinkT > 0) { m.blinkT -= DT; if (m.blinkT <= 0) m.blink = 0; }
    m.laneK = Math.min(m.laneK, nl - 1);
    const wantOff = c.laneOffset(m.laneK, m.s);
    m.offT = wantOff; // bias/mergeLean omitted — not what this sim measures
  }

  // white-lining pass — mirrors wlinePaired/wlinePairRoll/wlineUpdate
  if (wlineOn) for (const n of fleet) wlineUpdate(n, fleet, rng, stats);
  else for (const n of fleet) { n.wlLat = 0; n.wlCur = 0; n.wlPartner = null; }

  for (const m of fleet) {
    const target = clamp(m.offT + m.wlCur,
      -Math.max(0, c.halfWidth(m.s) - m.W / 2 - 0.3),
      Math.max(0, c.halfWidth(m.s) - m.W / 2 - 0.3));
    m.off += clamp(target - m.off, -2.0 * DT, 2.0 * DT);
  }
}

function laneClearAt(n, cand, fleet) {
  for (const m of fleet) {
    if (m === n) continue;
    if (Math.abs(m.off - cand) >= (n.W + m.W) / 2 + 0.3) continue;
    const ds = c.deltaZ(n.s, m.s);
    if (ds > -(n.L + m.L) / 2 - 1.0 && ds < (n.L + m.L) / 2 + 1.0) return false;
  }
  return true;
}

function wlinePaired(n, p, fleet) {
  if (!p || p.wreck) return false;
  if (p.blink !== 0 || p.pendK >= 0 || p.mergeLean !== 0) return false;
  if (n.blink !== 0 || n.pendK >= 0 || n.mergeLean !== 0) return false;
  if (n.v < WLINE.minSpeed || p.v < WLINE.minSpeed) return false;
  if (Math.abs(p.v - n.v) > WLINE.dv) return false;
  if (Math.abs(c.deltaZ(n.s, p.s)) > WLINE.sFrac * (n.L + p.L) / 2) return false;
  const dLane = Math.abs(nearestLane(p.s, p.off) - nearestLane(n.s, n.off));
  return dLane === 1;
}

function wlinePairRoll(n, p) {
  const lo = Math.min(n.id, p.id), hi = Math.max(n.id, p.id);
  const bucket = Math.round(n.s / 25);
  const seed = (lo * 2654435761 + hi * 40503 + bucket * 97) >>> 0;
  const rnd = mulberry32(seed);
  const open = rnd() < WLINE.openChance;
  const gap = lerp(WLINE.gapLo, WLINE.gapHi, (rnd() + rnd()) / 2);
  return { open, gap };
}

function wlineUpdate(n, fleet, rng, stats) {
  let p = wlinePaired(n, n.wlPartner, fleet) ? n.wlPartner : null;
  if (!p) {
    n.wlT -= DT;
    if (n.wlT <= 0) {
      n.wlT = WLINE.scanEvery + rng() * WLINE.scanJitter;
      let bestDs = Infinity;
      for (const m of fleet) {
        if (m === n) continue;
        if (!wlinePaired(n, m, fleet)) continue;
        const ds = Math.abs(c.deltaZ(n.s, m.s));
        if (ds < bestDs) { bestDs = ds; p = m; }
      }
    }
  }
  if (p !== n.wlPartner) { n.wlPartner = p; n.wlDwell = 0; n.wlRolled = false; }
  if (!p) {
    n.wlDwell = 0;
    n.wlLat = 0;
  } else {
    n.wlDwell += DT;
    if (!n.wlRolled && n.wlDwell >= WLINE.dwell) {
      n.wlRolled = true;
      const roll = wlinePairRoll(n, p);
      n.wlOpen = roll.open;
      n.wlGap = roll.gap;
      if (stats) { stats.rolls++; if (roll.open) stats.rollsOpen++; stats.gapSum += roll.gap; }
    }
    if (n.wlOpen && n.wlDwell >= WLINE.dwell) {
      const away = Math.sign(n.off - p.off) || 1;
      let middled = false;
      for (const m of fleet) {
        if (m === n || m === p) continue;
        if (Math.sign(m.off - n.off) !== away) continue;
        if (wlinePaired(n, m, fleet)) { middled = true; break; }
      }
      const lim = Math.max(0, c.halfWidth(n.s) - n.W / 2 - 0.3);
      const want = middled ? 0 : clamp(away * n.wlGap, -lim, lim);
      n.wlLat = want !== 0 && laneClearAt(n, n.off + away * WLINE.probe, fleet) ? want : 0;
    } else {
      n.wlLat = 0;
    }
  }
  const dw = n.wlLat - n.wlCur;
  if (Math.abs(dw) > 0.004) n.wlCur += clamp(dw, -WLINE.rate * DT, WLINE.rate * DT);
  else n.wlCur = n.wlLat;
}

/* ============ run one full scenario, WLINE on or off ============ */
function run(wlineOn, seed, NC, minutes) {
  const rng = mulberry32(seed);
  const fleet = mkFleet(rng, NC, c.Z0 + 300);
  const STEPS = Math.round(minutes * 60 / DT);

  const gapSamples = []; // one sample per encounter, taken at its SETTLED gap
  const seenThisEncounter = new Map(); // key -> most recent gap seen
  let overlapFrames = 0, worstPen = 0, wlineOverlapFrames = 0;
  let wlSignFlips = 0, wlActiveCarFrames = 0;
  const lastSign = new Map();
  const stats = { rolls: 0, rollsOpen: 0, gapSum: 0 };

  // The two O(N^2) measurement passes below (gap sampling, overlap check)
  // are pure instrumentation, not the driving model — sampled every few
  // frames rather than at 60 Hz. WLINE eases at 0.18 m/s, so a transient
  // that only exists for under a sampling period is not a real overlap risk.
  const SAMPLE_EVERY = 3;

  for (let i = 0; i < STEPS; i++) {
    stepFleet(fleet, rng, wlineOn, stats);
    if (i % SAMPLE_EVERY !== 0) continue;

    // -- measure independent side-by-side gaps (adjacent lane, near |Δs|=0),
    // regardless of whether WLINE actually paired them, so "before" and
    // "after" are measuring the same population of encounters. Sampled at
    // the SETTLED gap (the last reading before the encounter breaks), not
    // at first contact — WLINE takes ~dwell seconds to roll and ~gap/rate
    // seconds to ease, so the interesting number is where it lands, not
    // where it started. */
    const active = new Map(); // key -> {gap, frames}
    for (const n of fleet) {
      let nearestAdj = null, bestDs = Infinity;
      for (const m of fleet) {
        if (m === n) continue;
        const dLane = Math.abs(nearestLane(m.s, m.off) - nearestLane(n.s, n.off));
        if (dLane !== 1) continue;
        const ds = Math.abs(c.deltaZ(n.s, m.s));
        if (ds < 3 && ds < bestDs) { bestDs = ds; nearestAdj = m; }
      }
      if (nearestAdj && n.id < nearestAdj.id) {
        const key = `${n.id}:${nearestAdj.id}`;
        const gap = Math.abs(n.off - nearestAdj.off) - (n.W + nearestAdj.W) / 2;
        const prior = seenThisEncounter.get(key);
        active.set(key, { gap, frames: (prior ? prior.frames : 0) + 1 });
      }
    }
    for (const [key, rec] of seenThisEncounter) {
      // encounter just ended: record its settled gap, but only if it lasted
      // long enough to plausibly reach WLINE.dwell — a car merely passing
      // through an adjacent lane for a moment isn't a "pair" either way
      if (!active.has(key) && rec.frames * DT * SAMPLE_EVERY >= WLINE.dwell)
        gapSamples.push(rec.gap);
    }
    seenThisEncounter.clear();
    for (const [key, rec] of active) seenThisEncounter.set(key, rec);

    // -- overlaps: any two fleet bodies sharing space, anywhere. Also
    // isolates overlaps where a car actively easing (|wlCur|>0.02) is one
    // of the two bodies — the background blind-lane-change model this sim
    // borrows from rival-sim is not collision-free by its own admission
    // ("without [laneClearAt] here they cut each other up"), so total
    // overlapFrames carries that pre-existing noise; wlineOverlapFrames is
    // the number that actually says something about THIS feature. --
    for (let a = 0; a < fleet.length; a++) {
      for (let b = a + 1; b < fleet.length; b++) {
        const n = fleet[a], m = fleet[b];
        const dLat = Math.abs(n.off - m.off), dLon = Math.abs(c.deltaZ(n.s, m.s));
        const latPen = (n.W + m.W) / 2 - dLat, lonPen = (n.L + m.L) / 2 - dLon;
        if (latPen > 0 && lonPen > 0) {
          overlapFrames++;
          worstPen = Math.max(worstPen, Math.min(latPen, lonPen));
          if (Math.abs(n.wlCur) > 0.02 || Math.abs(m.wlCur) > 0.02) wlineOverlapFrames++;
        }
      }
    }

    // -- oscillation: does wlCur flap sign under a car holding a pair? --
    if (wlineOn) for (const n of fleet) {
      if (Math.abs(n.wlCur) < 0.02) { lastSign.delete(n.id); continue; }
      wlActiveCarFrames++;
      const s = Math.sign(n.wlCur);
      const prev = lastSign.get(n.id);
      if (prev !== undefined && prev !== s) wlSignFlips++;
      lastSign.set(n.id, s);
    }
  }

  const sorted = gapSamples.slice().sort((a, b) => a - b);
  const q = (p) => sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : NaN;
  return {
    n: gapSamples.length, med: q(0.5), p10: q(0.1), p90: q(0.9),
    overlapFrames, worstPen, wlineOverlapFrames, wlSignFlips, wlActiveCarFrames,
    rolls: stats.rolls, rollsOpen: stats.rollsOpen,
    meanGap: stats.rolls ? stats.gapSum / stats.rolls : NaN,
  };
}

console.log("1. gap distribution — WLINE off vs on, same seed and same traffic");
console.log("   density   n_pairs   p10(off)  med(off)  p90(off)  |  p10(on)  med(on)  p90(on)");
const SEEDS = [55, 771];
let aggOff = [], aggOn = [];
for (const NC of [110, 55]) {
  for (const seed of SEEDS) {
    const off = run(false, seed, NC, 2);
    const on = run(true, seed, NC, 2);
    aggOff.push(off); aggOn.push(on);
    console.log(`   ${NC === 110 ? "dense  " : "flowing"}  seed ${String(seed).padStart(6)}  ` +
      `n=${String(off.n).padStart(4)}  ${f(off.p10)}  ${f(off.med)}  ${f(off.p90)}  |  ` +
      `${f(on.p10)}  ${f(on.med)}  ${f(on.p90)}`);
  }
}

console.log("2. aggregate");
{
  const meanOf = (arr, k) => arr.reduce((s, r) => s + r[k], 0) / arr.length;
  const medOff = meanOf(aggOff, "med"), medOn = meanOf(aggOn, "med");
  console.log(`   mean of the median gap: OFF ${f(medOff)} m → ON ${f(medOn)} m`);
  if (medOn <= medOff) bad(`median gap did not grow with WLINE on (${f(medOff)} → ${f(medOn)})`);
  else ok(`median gap grows with WLINE on (${f(medOff)} m → ${f(medOn)} m)`);

  // "opened on ~70% of pairs, randomised width": read straight off the
  // mechanism's own rolls (wlinePairRoll), not inferred from the gap
  // distribution — the ON/OFF runs' RNG streams diverge the moment WLINE
  // starts consuming rng() draws for its scan jitter, so the two runs are
  // only comparable in aggregate, not pair-for-pair.
  const rolls = aggOn.reduce((s, r) => s + r.rolls, 0);
  const rollsOpen = aggOn.reduce((s, r) => s + r.rollsOpen, 0);
  const openRate = rolls ? rollsOpen / rolls * 100 : NaN;
  const meanGap = aggOn.reduce((s, r) => s + (r.meanGap || 0) * r.rolls, 0) / Math.max(rolls, 1);
  console.log(`   pair rolls: ${rolls}, opened ${rollsOpen} (${f(openRate)}%) — target ${WLINE.openChance * 100}%`);
  console.log(`   mean per-car ease on an opened pair: ${f(meanGap)} m (band ${WLINE.gapLo}-${WLINE.gapHi} m)`);
  if (Math.abs(openRate - WLINE.openChance * 100) > 5)
    bad(`open rate ${f(openRate)}% is more than 5 points off the ${WLINE.openChance * 100}% target`);
  else ok(`open rate ${f(openRate)}% matches the ~${WLINE.openChance * 100}% spec within noise`);

  const totalOverlapOff = aggOff.reduce((s, r) => s + r.overlapFrames, 0);
  const totalOverlapOn = aggOn.reduce((s, r) => s + r.overlapFrames, 0);
  const wlineOverlap = aggOn.reduce((s, r) => s + r.wlineOverlapFrames, 0);
  console.log(`   overlap frames (whole fleet, background blind-lane-change model — see the report caveat): OFF ${totalOverlapOff}, ON ${totalOverlapOn}`);
  console.log(`   overlap frames where an actively-easing car was one of the two bodies: ${wlineOverlap}`);
  if (wlineOverlap > 0)
    bad(`an actively-easing car shared a body on ${wlineOverlap} sampled frames — WLINE caused an overlap`);
  else ok("zero overlaps in which an actively-easing car was involved");
  if (totalOverlapOn > totalOverlapOff)
    bad(`WLINE increased total fleet overlap frames (${totalOverlapOff} → ${totalOverlapOn})`);
  else ok(`WLINE does not increase total fleet overlap frames (${totalOverlapOff} → ${totalOverlapOn})`);

  const flips = aggOn.reduce((s, r) => s + r.wlSignFlips, 0);
  const activeFrames = aggOn.reduce((s, r) => s + r.wlActiveCarFrames, 0);
  console.log(`   WIGGLE (ease sign flips while actively easing): ${flips} in ${activeFrames} active car-frames`);
  if (flips > 0) bad(`wlCur flipped sign ${flips} times while a car was actively easing — oscillation`);
  else ok("no sign flips while actively easing — the drift never oscillates");
}

console.log(fail ? `\n${fail} FAILED` : "\nall white-lining checks passed");
process.exit(fail ? 1 : 0);
