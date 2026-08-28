/* Browser-free simulation of the mountain pass's two-way traffic
   (traffic.ts updateMountain / trySpawnMountain).

   The pass is one narrow lane each direction with ONCOMING flow — the one
   place in the game where two NPC streams drive at each other — so the thing
   to prove is that "zero overlaps" holds structurally, not by luck: each
   stream owns its lane centre, neither ever targets the other's, the corner
   speed caps keep the following model inside its stopping distance, and the
   wrong-way stream dies in the lay-by pocket before the one-way wedge.

   traffic.ts itself pulls in three.js and a live scene, so — same contract
   as test/traffic-merge-sim.mjs — this reimplements the mountain driving
   arithmetic (corner caps + IDM + the lay-by stop + the deck merge) against
   the REAL routegraph geometry. If the formulas here drift from traffic.ts,
   that's a bug in this file, not evidence either way — keep them in lockstep
   by eye.

   Assertions, over every seed:
     - zero body overlaps (SAT, the same obb2 the game collides with) between
       every pair of mountain cars, oncoming pairs included, at every tick;
     - every car stays inside its own lane's clamp envelope (lay-by pull-in
       excepted, which must stay inside the pocket);
     - no oncoming car ever proceeds past the lay-by floor toward the wedge,
       and every oncoming car eventually stops (the deck is unreachable);
     - forward cars leave only through the merge window, and a merging car
       enters the deck stream without overlapping it;
     - source guard: the rival's update path knows nothing about the pass,
       and the only way onto MOUNTAIN_EDGE is the mountain spawner (which the
       rival slot never reaches) — greps over game/traffic.ts, so a refactor
       that quietly gives deck traffic (or the rival) a route onto the pass
       fails here before it ships.

   Usage: node test/mountain-traffic-sim.mjs [seeds]   (default 14) */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "mtnsim-"));
execFileSync("npx", [
  "tsc", "game/world/corridor.ts", "game/world/ramps.ts", "game/world/routegraph.ts",
  "--outDir", out,
  "--rootDir", ".", "--module", "esnext", "--target", "es2020",
  "--moduleResolution", "bundler", "--skipLibCheck",
], { stdio: ["ignore", "ignore", "inherit"] });
const dir = path.join(out, "game", "world");
for (const f of ["corridor.js", "ramps.js", "routegraph.js"]) {
  const p = path.join(dir, f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w/]+)"/g, '"$1.js"'));
}
const { getCorridor } = await import(path.join(dir, "corridor.js"));
const { getRouteGraph, MTN, MOUNTAIN_EDGE } = await import(path.join(dir, "routegraph.js"));

const cor = getCorridor();
const g = getRouteGraph();
const mt = g.mtn;
const mw = g.mergeWindow(mt);

let fail = 0;
const bad = (m) => { console.log("  FAIL " + m); fail++; };
const f = (n) => n.toFixed(2);

/* ---- source guards ------------------------------------------------------ */
{
  const src = readFileSync("game/traffic.ts", "utf8");
  const rivalBody = src.slice(
    src.indexOf("private updateRival("),
    src.indexOf("/* ----", src.indexOf("private updateRival(")),
  );
  if (/MOUNTAIN/.test(rivalBody))
    bad("updateRival references the mountain route — the rival must not know the pass exists");
  const writes = [...src.matchAll(/route = MOUNTAIN_EDGE/g)].length;
  if (writes !== 1)
    bad(`route = MOUNTAIN_EDGE is assigned ${writes} time(s) — only trySpawnMountain may`);
  if (!/trySpawnMountain[\s\S]{0,400}n\.type === "truck" \|\| n\.type === "bus"/.test(src))
    bad("the mountain spawner no longer bars heavies");
  console.log("source guards: rival path clean, one spawner writes the route, no heavies");
}

/* ---- the ported driving model ------------------------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand2 = (rng, a, b) => a + (b - a) * rng();
const LANE_FOLLOW_RATE = 3.4;
const CAP_FWD = 2, CAP_ONC = 3;

/* corner caps, as traffic.ts builds them (A_LAT 3.4, ±8-station smoothing) */
const mtnCap = (() => {
  const st = mt.stations;
  const n = Math.ceil(mt.len / 4) + 1;
  const capA = new Float32Array(n).fill(24);
  for (let k = 0; k < n; k++) {
    const s = k * 4;
    const i = mt.locate(s);
    let kap = 0, m = 0;
    for (let j = Math.max(1, i - 8); j <= Math.min(st.length - 2, i + 8); j++) {
      const a = st[j - 1], b = st[j + 1];
      let dh = Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz);
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      kap += Math.abs(dh) / Math.max(0.01, b.s - a.s);
      m++;
    }
    kap /= Math.max(1, m);
    capA[k] = clamp(Math.sqrt(3.4 / Math.max(1e-4, kap)), 7, 24);
  }
  return capA;
})();
const capAt = (s, dirn, v) => {
  const look = Math.max(16, v * 2.4);
  let cap = 24;
  for (const d of [0, look * 0.5, look]) {
    const k = Math.round(clamp(s + dirn * d, 0, mt.len) / 4);
    if (k >= 0 && k < mtnCap.length) cap = Math.min(cap, mtnCap[k]);
  }
  return cap;
};

/* SAT overlap on oriented boxes — obb2 from collide.ts, verbatim */
function obb2(ax, az, afx, afz, aw, al, bx, bz, bfx, bfz, bw, bl) {
  const axes = [[afz, -afx], [afx, afz], [bfz, -bfx], [bfx, bfz]];
  const dx = ax - bx, dz = az - bz;
  let pen = 1e9;
  for (const [ux, uz] of axes) {
    const ra = aw * Math.abs(ux * afz - uz * afx) + al * Math.abs(ux * afx + uz * afz);
    const rb = bw * Math.abs(ux * bfz - uz * bfx) + bl * Math.abs(ux * bfx + uz * bfz);
    const o = ra + rb - Math.abs(ux * dx + uz * dz);
    if (o <= 0) return null;
    if (o < pen) pen = o;
  }
  return pen;
}

const dt = 1 / 60;
function runSeed(seed, report) {
  const rng = mulberry32(seed);
  const cars = [];
  let overlaps = 0, worstPen = 0, laneBreaks = 0, wedgeBreaches = 0;
  let merged = 0, mergedBad = 0, parked = 0, spawnFail = 0;
  /* a synthetic deck stream through the merge window: three lanes, the fast
     lane half-occupied, constant-ish IDM pace — what a merging car must
     thread into */
  const deck = [];
  for (let z = MTN.mergeZ - 260; z < MTN.mergeZ + 160; z += rand2(rng, 34, 90))
    deck.push({ z, v: rand2(rng, 22, 30), lane: rng() < 0.5 ? 2 : (rng() < 0.5 ? 0 : 1) });
  /* the player proxy rides the forward lane at mountain pace — spawning is
     keyed off them the way the game keys off playerMt */
  let pS = 6, pV = 13;

  const spawn = () => {
    let fwd = 0, onc = 0;
    for (const c of cars) (c.dirn < 0 ? onc++ : fwd++);
    const wantOnc = onc < CAP_ONC && (rng() < 0.65 || fwd >= CAP_FWD);
    if (!wantOnc && fwd >= CAP_FWD) return;
    const dirn = wantOnc ? -1 : 1;
    const s = pS + rand2(rng, 40, 230);
    if (s > mt.len - (dirn < 0 ? 40 : 60)) return;
    if (dirn < 0 && s < MTN.laybyS1 + 30) return;
    const laneK = dirn < 0 ? 1 : 0;
    for (const c of cars)
      if (c.laneK === laneK && Math.abs(c.s - s) < 30) { spawnFail++; return; }
    const W = rand2(rng, 1.72, 1.98), L = rand2(rng, 4.2, 5.0);
    const bias = clamp(rand2(rng, -0.6, 0.6), -(MTN.laneW / 2 - W / 2 - 0.2), MTN.laneW / 2 - W / 2 - 0.2);
    const drv = { acc: rand2(rng, 0.8, 1.2), gap: rand2(rng, 0.85, 1.3), spd: rand2(rng, 0.85, 1.1) };
    cars.push({
      dirn, laneK, s, off: mt.laneOffset(laneK, s) + bias, bias, W, L, drv,
      v: rand2(rng, 10, 15), v0: rand2(rng, 12, 17) * drv.spd, stopped: 0,
    });
  };

  for (let t = 0; t < 300; t += dt) {
    // the player loops the pass; spawn attempts a few times a second
    pS += pV * dt;
    if (pS > mt.len - 30) pS = 6;
    if (rng() < 3 * dt) spawn();

    for (const c of cars) {
      /* leader: nearest same-direction car ahead in the same lane (no lane
         changes on the pass, so "same lane" is exact) */
      let lead = null, ds = 1e9;
      for (const m of cars) {
        if (m === c || m.laneK !== c.laneK) continue;
        const ahead = (m.s - c.s) * c.dirn;
        if (ahead <= 0 || ahead > 70) continue;
        const d = ahead - (m.L + c.L) / 2;
        if (d < ds) { ds = Math.max(0.1, d); lead = m; }
      }
      let v0 = Math.min(c.v0 * 0.7 * 1.0, capAt(c.s, c.dirn, c.v) * (0.8 + 0.25 * c.drv.spd));
      const aMax = 1.5 * c.drv.acc, bCom = 2.6, T = 1.4 * c.drv.gap,
        s0 = 2.3 + 1.4 * (c.drv.gap - 1);
      let acc;
      if (lead) {
        const dv = c.v - lead.v;
        const sStar = s0 + c.v * T + (c.v * dv) / (2 * Math.sqrt(aMax * bCom));
        acc = aMax * (1 - Math.pow(c.v / v0, 4) - Math.pow(sStar / ds, 2));
      } else acc = aMax * (1 - Math.pow(c.v / v0, 4));
      if (c.dirn < 0) {
        const stopS = MTN.laybyS0 + 18;
        const dstop = c.s - stopS - c.L / 2;
        if (dstop < Math.max(30, c.v * 4)) {
          const sStar = 2.0 + c.v * T + (c.v * c.v) / (2 * Math.sqrt(aMax * bCom));
          acc = Math.min(acc,
            aMax * (1 - Math.pow(c.v / Math.max(4, v0), 4) - Math.pow(sStar / Math.max(dstop, 0.4), 2)));
        }
      } else if (c.s >= mw.s0) {
        /* the merge: port of the gap acceptance against the deck stream
           (laneClearAt with route −1, fast lane) */
        const zc = cor.wrapZ(cor.zAt(
          mt.poseAt(c.s).x + c.off * mt.poseAt(c.s).nx,
          mt.poseAt(c.s).z + c.off * mt.poseAt(c.s).nz));
        let clear = true;
        for (const d2 of deck) {
          if (d2.lane !== 2) continue;
          const dz = cor.deltaZ(zc, d2.z);
          const halfL = (4.6 + c.L) / 2;
          const backNeed = halfL + 13.5 + 3.0 * Math.max(0, d2.v - c.v);
          const fwdNeed = halfL + 23.5 + 2.0 * Math.max(0, c.v - d2.v);
          if (dz > -backNeed && dz < fwdNeed) clear = false;
        }
        if (clear || c.s > mw.s1 - 6) {
          merged++;
          // entering the deck stream: must not overlap the car it slots by
          for (const d2 of deck) {
            if (d2.lane !== 2) continue;
            if (Math.abs(cor.deltaZ(zc, d2.z)) < (4.6 + c.L) / 2) mergedBad++;
          }
          c.gone = true;
          continue;
        }
        acc = Math.min(acc, c.s > mw.s1 - 20 ? -2.8 : -1.4);
      }
      acc = clamp(acc, -8.5, 2.8);
      c.v = Math.max(0, c.v + acc * dt);
      c.s += c.dirn * c.v * dt;
      if (c.dirn > 0) c.s = Math.min(mt.len - 0.5, c.s);
      else {
        if (c.s < MTN.laybyS0 - 2) wedgeBreaches++;
        c.s = Math.max(MTN.laybyS0 - 2, c.s);
        if (c.v < 0.25 && c.s < MTN.laybyS1 + 6) c.stopped += dt;
      }
      let latT = mt.laneOffset(c.laneK, c.s) + c.bias;
      if (c.dirn < 0) {
        const pocket = Math.max(0, mt.halfWidths(c.s).hwL - MTN.half - 0.35);
        if (pocket > 0) latT += Math.min(pocket, MTN.laybyW - 0.35);
      }
      const dOff = latT - c.off;
      c.off += clamp(dOff, -LANE_FOLLOW_RATE * dt, LANE_FOLLOW_RATE * dt);

      /* lane envelope: the car's body must stay inside its own half of the
         road (or the pocket) — the structural half of "zero overlaps" */
      const half = c.laneK === 1 ? mt.halfWidths(c.s).hwL : 0;
      const inLane = c.laneK === 0
        ? c.off - c.W / 2 > -MTN.half - 0.01 && c.off + c.W / 2 < 0.25
        : c.off - c.W / 2 > -0.25 && c.off + c.W / 2 < half + 0.05;
      if (!inLane) {
        laneBreaks++;
        if (laneBreaks < 4 && report)
          console.log(`    BREAK dir ${c.dirn} laneK ${c.laneK} s ${c.s.toFixed(1)} off ${c.off.toFixed(2)} W ${c.W.toFixed(2)} half ${half.toFixed(2)}`);
      }
    }
    for (let i = cars.length - 1; i >= 0; i--) {
      const c = cars[i];
      // recycle: merged away, or parked long enough to have been recycled
      if (c.gone || c.stopped > 25) {
        if (c.stopped > 25) parked++;
        cars.splice(i, 1);
      }
    }
    for (const d2 of deck) d2.z = cor.wrapZ(d2.z + d2.v * dt);

    /* the core assertion: no two bodies on the pass ever overlap, oncoming
       pairs included — checked with the game's own SAT */
    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      const pa = mt.poseAt(a.s);
      const ax = pa.x + a.off * pa.nx, az = pa.z + a.off * pa.nz;
      const ah = Math.atan2(pa.tx, pa.tz) + (a.dirn < 0 ? Math.PI : 0);
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        if (Math.abs(a.s - b.s) > 12) continue;
        const pb = mt.poseAt(b.s);
        const bx2 = pb.x + b.off * pb.nx, bz2 = pb.z + b.off * pb.nz;
        const bh = Math.atan2(pb.tx, pb.tz) + (b.dirn < 0 ? Math.PI : 0);
        const pen = obb2(
          ax, az, Math.sin(ah), Math.cos(ah), a.W / 2, a.L / 2,
          bx2, bz2, Math.sin(bh), Math.cos(bh), b.W / 2, b.L / 2);
        if (pen) { overlaps++; worstPen = Math.max(worstPen, pen); }
      }
    }
  }
  if (report)
    console.log(`  seed ${String(seed).padStart(3)}: ` +
      `${merged} merged, ${parked} parked+recycled, ${spawnFail} spawn rejects — ` +
      `${overlaps} overlap ticks (worst ${f(worstPen)} m), ` +
      `${laneBreaks} lane breaks, ${wedgeBreaches} wedge breaches, ${mergedBad} bad merges`);
  return { overlaps, worstPen, laneBreaks, wedgeBreaches, merged, mergedBad, parked };
}

const seeds = +(process.argv[2] || 14);
console.log(`mountain two-way traffic, ${seeds} seeds × 300 s:`);
let sumMerged = 0, sumParked = 0;
for (let k = 0; k < seeds; k++) {
  const r = runSeed(0x5eed + k * 7919, true);
  sumMerged += r.merged;
  sumParked += r.parked;
  if (r.overlaps) bad(`seed ${k}: ${r.overlaps} overlapping ticks (worst ${f(r.worstPen)} m)`);
  if (r.laneBreaks) bad(`seed ${k}: a car left its lane envelope ${r.laneBreaks} tick(s)`);
  if (r.wedgeBreaches) bad(`seed ${k}: an oncoming car pushed past the lay-by floor`);
  if (r.mergedBad) bad(`seed ${k}: a merge landed inside a deck car`);
}
if (sumMerged === 0) bad("no forward car ever merged onto the deck — the exit path is dead");
if (sumParked === 0) bad("no oncoming car ever parked — the lay-by path is dead");

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall mountain traffic checks passed");
process.exit(fail ? 1 : 0);
