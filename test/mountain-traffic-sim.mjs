/* Browser-free simulation of the mountain pass's ONE-WAY traffic
   (traffic.ts updateMountain / trySpawnMountain).

   EXIT 4 峠 Tōge is a single-lane, single-direction road: one stream, no
   oncoming, no overtaking. The thing to prove is therefore different from
   the two-way version this file used to be:

     - the road is one-way STRUCTURALLY, not by luck — no code path ever
       puts an NPC on the pass facing backwards;
     - a stream that cannot overtake still flows: the turnout at
       MTN.turnoutS0..S1 is the repurposed lay-by, and a car the player is
       closing on pulls into it, stops clear of the lane and lets them by,
       then RESUMES and leaves through the merge. A let-by that never
       resumes is a rolling roadblock, which is the failure mode a
       single-lane road has, so it is asserted against directly;
     - the pull-in stays inside the pocket that is actually open at that
       station (the assert that caught the old lay-by opening late);
     - zero body overlaps, with the game's own SAT;
     - forward cars leave only through the merge window and never land
       inside a deck car.

   traffic.ts itself pulls in three.js and a live scene, so — same contract
   as test/traffic-merge-sim.mjs — this reimplements the mountain driving
   arithmetic (corner caps + IDM + the turnout let-by + the deck merge)
   against the REAL routegraph geometry. If the formulas here drift from
   traffic.ts, that's a bug in this file, not evidence either way — keep them
   in lockstep by eye.

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
  const spawnBody = src.slice(
    src.indexOf("private trySpawnMountain("),
    src.indexOf("/** clamp(drv.bias)", src.indexOf("private trySpawnMountain(")),
  );
  if (!/n\.type === "truck" \|\| n\.type === "bus"/.test(spawnBody))
    bad("the mountain spawner no longer bars heavies");
  /* ONE-WAY, structurally: the spawner is the only thing that puts a car on
     the pass, and the only direction it may write is +1. A future lane that
     re-introduces a backwards stream has to delete this line to do it. */
  if (!/n\.dir = 1;/.test(spawnBody))
    bad("trySpawnMountain no longer pins n.dir = 1 — the pass must be one-way");
  if (/dir\s*=\s*-1|dir\s*<\s*0/.test(spawnBody))
    bad("trySpawnMountain still knows about a backwards direction");
  const updBody = src.slice(
    src.indexOf("private updateMountain("),
    src.indexOf("/* ---------------- instanced rendering", src.indexOf("private updateMountain(")),
  );
  if (/n\.dir\s*<\s*0/.test(updBody))
    bad("updateMountain still branches on a backwards pass car");
  console.log("source guards: rival path clean, one spawner writes the route," +
    " no heavies, the pass is one-way by construction");
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
const CAP = 3;

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

/* SAT overlap on oriented boxes — obb2 from collide.ts, copied unchanged */
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
  let overlaps = 0, worstPen = 0, laneBreaks = 0, backwards = 0;
  let merged = 0, mergedBad = 0, letBys = 0, resumed = 0, stuck = 0, spawnFail = 0;
  /* a synthetic deck stream through the merge window: three lanes, the fast
     lane half-occupied, constant-ish IDM pace — what a merging car must
     thread into */
  const deck = [];
  for (let z = MTN.mergeZ - 260; z < MTN.mergeZ + 160; z += rand2(rng, 34, 90))
    deck.push({ z, v: rand2(rng, 22, 30), lane: rng() < 0.5 ? 2 : (rng() < 0.5 ? 0 : 1) });
  /* the player proxy drives the pass in the ONE legal direction — spawning
     and the turnout let-by are both keyed off them the way the game keys
     off playerMt */
  let pS = 6, pV = 15;

  const spawn = () => {
    if (cars.length >= CAP) return;
    const s = pS + rand2(rng, 40, 230);
    if (s > mt.len - 60) return;
    for (const c of cars)
      if (Math.abs(c.s - s) < 30) { spawnFail++; return; }
    const W = rand2(rng, 1.72, 1.98), L = rand2(rng, 4.2, 5.0);
    const bias = clamp(rand2(rng, -0.6, 0.6), -(MTN.laneW / 2 - W / 2 - 0.2), MTN.laneW / 2 - W / 2 - 0.2);
    const drv = { acc: rand2(rng, 0.8, 1.2), gap: rand2(rng, 0.85, 1.3), spd: rand2(rng, 0.85, 1.1) };
    cars.push({
      s, off: mt.laneOffset(0, s) + bias, bias, W, L, drv,
      v: rand2(rng, 10, 15), v0: rand2(rng, 12, 17) * drv.spd, held: 0, didLetBy: false,
    });
  };

  for (let t = 0; t < 300; t += dt) {
    // the player runs the pass, in the legal direction only, and laps it
    pS += pV * dt;
    if (pS > mt.len - 30) pS = 6;
    if (rng() < 3 * dt) spawn();

    for (const c of cars) {
      /* leader: nearest car ahead. One lane, one direction, no lane changes,
         so "ahead" is just a larger s. */
      let lead = null, ds = 1e9;
      for (const m of cars) {
        if (m === c) continue;
        const ahead = m.s - c.s;
        if (ahead <= 0 || ahead > 70) continue;
        const d = ahead - (m.L + c.L) / 2;
        if (d < ds) { ds = Math.max(0.1, d); lead = m; }
      }
      let v0 = Math.min(c.v0 * 0.7 * 1.0, capAt(c.s, 1, c.v) * (0.8 + 0.25 * c.drv.spd));
      const aMax = 1.5 * c.drv.acc, bCom = 2.6, T = 1.4 * c.drv.gap,
        s0 = 2.3 + 1.4 * (c.drv.gap - 1);
      let acc;
      if (lead) {
        const dv = c.v - lead.v;
        const sStar = s0 + c.v * T + (c.v * dv) / (2 * Math.sqrt(aMax * bCom));
        acc = aMax * (1 - Math.pow(c.v / v0, 4) - Math.pow(sStar / ds, 2));
      } else acc = aMax * (1 - Math.pow(c.v / v0, 4));

      /* THE LET-BY (traffic.ts updateMountain): inside the turnout window,
         with the player closing from behind, the car pulls into the pocket
         and stops against a virtual wall short of the pocket's end. */
      const gap = c.s - pS;
      const yielding = c.s > MTN.turnoutS0 && c.s < MTN.turnoutS1 && gap > 0 && gap < 90;
      if (yielding) {
        if (!c.didLetBy) { c.didLetBy = true; letBys++; }
        const stopS = MTN.turnoutS1 - 6;
        const dstop = stopS - c.s - c.L / 2;
        if (dstop < Math.max(25, c.v * 4)) {
          const sStar = 2.0 + c.v * T + (c.v * c.v) / (2 * Math.sqrt(aMax * bCom));
          acc = Math.min(acc,
            aMax * (1 - Math.pow(c.v / Math.max(4, v0), 4) - Math.pow(sStar / Math.max(dstop, 0.4), 2)));
        }
      } else if (c.s >= mw.s0) {
        /* the merge: port of the gap acceptance against the deck stream
           (laneClearAt with route −1, fast lane) */
        const pp = mt.poseAt(c.s);
        const zc = cor.wrapZ(cor.zAt(pp.x + c.off * pp.nx, pp.z + c.off * pp.nz));
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
          if (c.didLetBy) resumed++;
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
      const before = c.s;
      c.s += c.v * dt;                       // one direction, always
      if (c.s < before - 1e-9) backwards++;  // structural: never reverses
      c.s = Math.min(mt.len - 0.5, c.s);
      /* a car that has let the player by and is still crawling in the pocket
         long after they are gone is a rolling roadblock, not a let-by */
      if (c.didLetBy && !yielding && c.v < 0.5) c.held += dt; else if (!yielding) c.held = 0;
      if (c.held > 20) stuck++;

      let latT = mt.laneOffset(0, c.s) + c.bias;
      const pocket = Math.max(0, mt.halfWidths(c.s).hwL - MTN.half - 0.35);
      if (yielding && pocket > 0) latT += Math.min(pocket, MTN.turnoutW - 0.35);
      const dOff = latT - c.off;
      c.off += clamp(dOff, -LANE_FOLLOW_RATE * dt, LANE_FOLLOW_RATE * dt);

      /* Lane envelope: the body must stay on the pavement that is actually
         open here — the lane when running, the lane plus the open pocket
         when letting by. A SHARED edge is skipped: through the two gore
         throats the road's west edge is the deck's edge and the pavement is
         continuous across it (routegraph shL/shR, and collide.ts exempts the
         same edges), so hanging past the clipped half-width there is being
         on the deck, not being off the road. */
      const hw = mt.halfWidths(c.s);
      const sh = mt.sharedSides(c.s);
      const inLane =
        (sh.shR || c.off - c.W / 2 > -hw.hwR - 0.01) &&
        (sh.shL || c.off + c.W / 2 < hw.hwL + 0.05);
      if (!inLane) {
        laneBreaks++;
        if (laneBreaks < 4 && report)
          console.log(`    BREAK s ${c.s.toFixed(1)} off ${c.off.toFixed(2)} W ${c.W.toFixed(2)} hwL ${hw.hwL.toFixed(2)} hwR ${hw.hwR.toFixed(2)} sh ${sh.shL ? "L" : "-"}${sh.shR ? "R" : "-"}`);
      }
    }
    for (let i = cars.length - 1; i >= 0; i--) if (cars[i].gone) cars.splice(i, 1);
    for (const d2 of deck) d2.z = cor.wrapZ(d2.z + d2.v * dt);

    /* the core assertion: no two bodies on the pass ever overlap — checked
       with the game's own SAT */
    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      const pa = mt.poseAt(a.s);
      const ax = pa.x + a.off * pa.nx, az = pa.z + a.off * pa.nz;
      const ah = Math.atan2(pa.tx, pa.tz);
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        if (Math.abs(a.s - b.s) > 12) continue;
        const pb = mt.poseAt(b.s);
        const bx2 = pb.x + b.off * pb.nx, bz2 = pb.z + b.off * pb.nz;
        const bh = Math.atan2(pb.tx, pb.tz);
        const pen = obb2(
          ax, az, Math.sin(ah), Math.cos(ah), a.W / 2, a.L / 2,
          bx2, bz2, Math.sin(bh), Math.cos(bh), b.W / 2, b.L / 2);
        if (pen) { overlaps++; worstPen = Math.max(worstPen, pen); }
      }
    }
  }
  if (report)
    console.log(`  seed ${String(seed).padStart(3)}: ` +
      `${merged} merged, ${letBys} let-bys (${resumed} resumed + merged), ` +
      `${spawnFail} spawn rejects — ` +
      `${overlaps} overlap ticks (worst ${f(worstPen)} m), ` +
      `${laneBreaks} lane breaks, ${backwards} reversals, ${stuck} stuck, ${mergedBad} bad merges`);
  return { overlaps, worstPen, laneBreaks, backwards, merged, mergedBad, letBys, resumed, stuck };
}

const seeds = +(process.argv[2] || 14);
console.log(`mountain one-way traffic, ${seeds} seeds × 300 s:`);
let sumMerged = 0, sumLetBy = 0, sumResumed = 0;
for (let k = 0; k < seeds; k++) {
  const r = runSeed(0x5eed + k * 7919, true);
  sumMerged += r.merged;
  sumLetBy += r.letBys;
  sumResumed += r.resumed;
  if (r.overlaps) bad(`seed ${k}: ${r.overlaps} overlapping ticks (worst ${f(r.worstPen)} m)`);
  if (r.laneBreaks) bad(`seed ${k}: a car left its lane envelope ${r.laneBreaks} tick(s)`);
  if (r.backwards) bad(`seed ${k}: a pass car moved backwards — the pass is not one-way`);
  if (r.stuck) bad(`seed ${k}: ${r.stuck} car(s) stayed stopped after the let-by — rolling roadblock`);
  if (r.mergedBad) bad(`seed ${k}: a merge landed inside a deck car`);
}
if (sumMerged === 0) bad("no car ever merged onto the deck — the exit path is dead");
if (sumLetBy === 0) bad("no car ever used the turnout — the let-by path is dead");
if (sumResumed === 0) bad("no car resumed after a let-by — the turnout is a trap");

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall mountain traffic checks passed");
process.exit(fail ? 1 : 0);
