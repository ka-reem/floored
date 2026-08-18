/* Browser-free drive of BOTH expressway loops — the plain main loop and the
   loop via the bypass viaduct — hunting for anything that would drop, eject
   or strand a car that stage 2 made drivable.

   What it asserts, per loop:
   - the physics height query (terrain.ts's heightAt, re-derived here with the
     same refY gating over flat ground — exact in the corridor band) supports
     the car every frame: no frame-to-frame ground discontinuity > 0.15 m;
   - no static collider (piers old and new, toll islands, canopy columns, ramp
     walls, bypass piers, gore nose blocks) stands in the driven line;
   - the loop splice fires and the car completes laps on both routings;
   - the diverge and merge handoffs are position-continuous (the corridor→
     bypass and bypass→corridor conversions used by traffic.ts agree with the
     geometry to well under a lane width).

   Usage: node test/bypass-drive.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "bypass-drive-"));
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
const { getCorridor, TOLL, TOLL_PLAZA } = await import(path.join(dir, "corridor.js"));
const { buildRamps, rampAt, spawnZ } = await import(path.join(dir, "ramps.js"));
const { getRouteGraph, BYPASS, DIVERGE_Z, MERGE_Z } =
  await import(path.join(dir, "routegraph.js"));

const c = getCorridor();
const g = getRouteGraph();
const by = g.bypass;
const ramps = buildRamps(() => 0); // the corridor band is flattened to 0

let fail = 0;
const bad = (m) => {
  console.log("  FAIL " + m);
  fail++;
};
const f = (n) => n.toFixed(2);

/* ---- terrain.heightAt, re-derived (terrain.ts) over flat ground ---------- */
function heightAt(x, z, refY) {
  let best = 0; // flat ground in the whole corridor band
  if (refY > c.centerY(z) - 3.4) {
    const dy = c.heightAt(x, z, 1.0);
    if (dy !== null) best = Math.max(best, dy);
  }
  const r = rampAt(ramps, x, z, 1.0);
  if (r && Math.abs(r.y - refY) < 3.4) best = Math.max(best, r.y);
  const s = g.surfaceAt(x, z, 1.0);
  if (s && Math.abs(s.y - refY) < 3.4) best = Math.max(best, s.y);
  return best;
}

/* ---- static collider set: corridor-drive's, plus the stage-2 boxes ------- */
const aabbs = [];
for (const z of c.lattice(32)) {
  const p = c.pose(z);
  const hgt = Math.max(1.5, p.y - 1.4);
  aabbs.push({
    x0: p.x - 1.4, x1: p.x + 1.4, z0: z - 1.4, z1: z + 1.4,
    y0: 0, y1: hgt - 1, what: `deck pier z=${z}`,
  });
}
{
  const zc = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
  const p0 = c.pose(zc), hw = c.halfWidth(zc), lanes = c.lanes(zc);
  const wx = (lat) => p0.x + lat * p0.nx;
  const wz = (lat, dz) => p0.z + lat * p0.nz + dz;
  const IL = TOLL_PLAZA.islandLen, IHW = TOLL_PLAZA.colliderHw;
  for (let k = 1; k < lanes; k++) {
    const lat = c.laneEdge(k, zc);
    aabbs.push({
      x0: wx(lat) - IHW, x1: wx(lat) + IHW,
      z0: wz(lat, -IL / 2), z1: wz(lat, IL / 2),
      y0: p0.y - 0.5, y1: p0.y + 3.4, what: `toll island k=${k}`,
    });
  }
  const colLat = hw - 0.75, CL = TOLL_PLAZA.groupLen;
  for (const s of [-1, 1])
    for (const dz of [-CL / 2 + 3, CL / 2 - 3])
      aabbs.push({
        x0: wx(s * colLat) - 0.55, x1: wx(s * colLat) + 0.55,
        z0: wz(s * colLat, dz) - 0.55, z1: wz(s * colLat, dz) + 0.55,
        y0: p0.y, y1: p0.y + 7.4, what: `canopy column s=${s}`,
      });
}
// bypass piers, exactly as highway.ts builds them (flat ground)
const { piers } = g.piers(() => 0);
for (const p of piers)
  aabbs.push({
    x0: p.x - 1.0, x1: p.x + 1.0, z0: p.z - 1.0, z1: p.z + 1.0,
    y0: 0, y1: p.topY - 0.6, what: `bypass pier s=${f(p.s)}`,
  });
// gore nose blocks, as highway.ts places them
{
  const FULL = BYPASS.half - 0.02;
  const st = by.stations;
  const iDiv = st.findIndex((p) => p.hwL >= FULL && p.s > 8);
  if (iDiv > 0) {
    const p = st[iDiv];
    const lat = p.hwL + 0.55;
    const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
    aabbs.push({
      x0: x - 0.6, x1: x + 0.6, z0: z - 0.8, z1: z + 0.8,
      y0: p.y - 0.5, y1: p.y + 1.1, what: "diverge nose block",
    });
  }
  const mrgGap = g.newParapetGaps().find((q) => q.side > 0);
  if (mrgGap) {
    const w = c.worldOf(mrgGap.z0 - 1, c.halfWidth(mrgGap.z0 - 1) + 0.23);
    aabbs.push({
      x0: w.x - 0.6, x1: w.x + 0.6, z0: w.z - 0.8, z1: w.z + 0.8,
      y0: w.y - 0.5, y1: w.y + 1.1, what: "merge parapet end block",
    });
  }
}
console.log(`static collider set: ${aabbs.length} AABBs`);

const HALF_W = 0.95, HALF_L = 2.35, RR = HALF_W + 0.05;
const hitAabb = (px, pz, y, b) => {
  if (y + 1.4 < b.y0 || y > b.y1) return false;
  const cx = Math.max(b.x0, Math.min(px, b.x1));
  const cz = Math.max(b.z0, Math.min(pz, b.z1));
  const dx = px - cx, dz = pz - cz;
  return dx * dx + dz * dz < RR * RR;
};
function collideCheck(x, z, y, hx, hz, label, hits) {
  for (const off of [HALF_L * 0.56, -HALF_L * 0.56]) {
    const px = x + hx * off, pz = z + hz * off;
    for (const b of aabbs)
      if (hitAabb(px, pz, y, b)) hits.add(`${b.what} — ${label}`);
  }
}

const V = 42, DT = 1 / 120;

/* ---- 1. the main loop, lane by lane -------------------------------------- */
console.log("driving the MAIN loop (every lane centre):");
{
  const nLanes = 4;
  for (let k = 0; k < nLanes; k++) {
    let z = spawnZ(), laps = 0, prevY = c.centerY(z), maxJump = 0, jumpAt = 0;
    const hits = new Set();
    let steps = 0;
    while (laps < 2 && steps++ < 300000) {
      z += V * DT;
      const dz = c.spliceDelta(z);
      if (dz) {
        z += dz;
        laps++;
      }
      const nl = c.lanes(z);
      const kk = Math.min(k, nl - 1);
      const p = c.worldOf(z, c.laneOffset(kk, z));
      const y = heightAt(p.x, p.z, prevY);
      const jump = Math.abs(y - prevY);
      if (laps === 0 || dz === 0) {
        if (jump > maxJump) {
          maxJump = jump;
          jumpAt = z;
        }
      }
      prevY = y;
      const po = c.pose(z);
      collideCheck(p.x, p.z, y, po.tx, po.tz, `lane ${kk} z=${f(z)}`, hits);
    }
    console.log(`  lane ${k}: ${laps} laps, worst frame step ${f(maxJump * 100)} cm at z=${f(jumpAt)}` +
      `${hits.size ? " — HIT " + [...hits][0] : ""}`);
    if (laps < 2) bad(`main loop lane ${k}: only ${laps} laps`);
    if (maxJump > 0.15) bad(`main loop lane ${k}: ground step ${f(maxJump)} m at z=${f(jumpAt)}`);
    for (const h of hits) bad(`main loop: collider in the driven line: ${h}`);
  }
}

/* ---- 2. the bypass loop --------------------------------------------------- */
console.log("driving the BYPASS loop (kerb lane → viaduct → fast-lane merge):");
{
  let laps = 0, steps = 0;
  let mode = "main-approach"; // → "bypass" → "main-after"
  let z = spawnZ();
  let s = 0;
  let prevY = c.centerY(z), maxJump = 0, jumpAt = "";
  const hits = new Set();
  let divergeErr = null, mergeErr = null;
  let sawViaductAltitude = 0;
  while (laps < 2 && steps++ < 400000) {
    let x, zz, y, hx, hz, label;
    if (mode === "main-approach" || mode === "main-after") {
      z += V * DT;
      const dz = c.spliceDelta(z);
      if (dz) {
        z += dz;
        laps++;
      }
      if (mode === "main-approach" && Math.abs(c.deltaZ(z, DIVERGE_Z)) < V * DT) {
        /* the diverge handoff traffic.ts performs: same world point, new
           station space */
        const kerb = c.worldOf(z, c.laneOffset(0, z));
        const hit = by.project(kerb.x, kerb.z, BYPASS.half + 10);
        if (!hit) {
          bad("diverge: bypass.project missed the kerb lane at the gore");
          break;
        }
        const w = by.worldOf(hit.s, hit.lat);
        divergeErr = Math.hypot(w.x - kerb.x, w.z - kerb.z);
        mode = "bypass";
        s = hit.s;
        // ease from the handoff lat onto the inner lane centre over ~60 m
        var lat0 = hit.lat;
      }
      const kk = mode === "main-approach" ? 0 : c.lanes(z) - 1;
      const p = c.worldOf(z, c.laneOffset(kk, z));
      const po = c.pose(z);
      x = p.x; zz = p.z; hx = po.tx; hz = po.tz;
      label = `${mode} z=${f(z)}`;
    } else {
      s += V * DT;
      const useLat = s < 70
        ? lat0 + (by.laneOffset(1, s) - lat0) * Math.min(1, s / 60)
        : by.laneOffset(1, s);
      const mw = g.mergeWindow();
      if (s >= (mw.s0 + mw.s1) / 2) {
        // the merge handoff: back into corridor space, fast lane
        const w0 = by.worldOf(s, by.laneOffset(0, s));
        const zc = c.wrapZ(c.zAt(w0.x, w0.z));
        const latC = c.latAt(w0.x, w0.z);
        const w1 = c.worldOf(zc, latC);
        mergeErr = Math.hypot(w1.x - w0.x, w1.z - w0.z);
        mode = "main-after";
        z = zc;
        continue;
      }
      const p = by.worldOf(s, useLat);
      const po = by.poseAt(s);
      x = p.x; zz = p.z; hx = po.tx; hz = po.tz;
      label = `bypass s=${f(s)}`;
      sawViaductAltitude = Math.max(sawViaductAltitude, p.y);
    }
    y = heightAt(x, zz, prevY);
    const jump = Math.abs(y - prevY);
    if (jump > maxJump) {
      maxJump = jump;
      jumpAt = label;
    }
    prevY = y;
    collideCheck(x, zz, y, hx, hz, label, hits);
  }
  console.log(`  ${laps} laps; worst frame step ${f(maxJump * 100)} cm at ${jumpAt};` +
    ` viaduct crest ${f(sawViaductAltitude)} m`);
  console.log(`  diverge handoff error ${divergeErr === null ? "n/a" : f(divergeErr) + " m"},` +
    ` merge handoff error ${mergeErr === null ? "n/a" : f(mergeErr) + " m"}`);
  if (laps < 2) bad(`bypass loop: only ${laps} laps (splice or routing failed)`);
  if (maxJump > 0.15) bad(`bypass loop: ground step ${f(maxJump)} m at ${jumpAt}`);
  /* the handoffs go through project(), a 4 m-segment polyline projection, so
     the bound is chord error at the gore's curvature — ~0.1 m, a fortieth of
     a lane. A quarter-metre here would mean a real discontinuity. */
  if (divergeErr === null || divergeErr > 0.25)
    bad(`diverge handoff is not position-continuous (${divergeErr} m)`);
  if (mergeErr === null || mergeErr > 0.25)
    bad(`merge handoff is not position-continuous (${mergeErr} m)`);
  if (sawViaductAltitude < 18) bad("the driven line never climbed the viaduct");
  for (const h of hits) bad(`bypass loop: collider in the driven line: ${h}`);
}

/* ---- 3. bypass lane centres are supported end to end --------------------- */
{
  console.log("bypass lane-centre support sweep:");
  let worstGap = 0, at = 0;
  for (let s = 20; s < by.len - 20; s += 2) {
    for (let k = 0; k < 2; k++) {
      const off = by.laneOffset(k, s);
      const { hwL, hwR } = by.halfWidths(s);
      if (off > hwL - 1 || off < -(hwR - 1)) continue;
      const w = by.worldOf(s, off);
      const y = heightAt(w.x, w.z, w.y);
      const d = Math.abs(y - w.y);
      if (d > worstGap) {
        worstGap = d;
        at = s;
      }
    }
  }
  console.log(`  worst support error ${f(worstGap * 100)} cm at s=${f(at)}`);
  if (worstGap > 0.05) bad(`heightAt disagrees with the bypass surface by ${f(worstGap)} m at s=${f(at)}`);
}

/* ---- 4. the streets below stay untouched --------------------------------- */
{
  let yanked = 0;
  for (const p of by.stations) {
    if (p.y < 8) continue; // gore approaches sit at deck height by design
    const y = heightAt(p.x, p.z, 0.2); // a car on the ground under the viaduct
    if (y > 3) yanked++;
  }
  console.log(`ground under the viaduct: ${yanked} stations would yank a ground car up`);
  if (yanked) bad("heightAt lifts ground traffic under the viaduct");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nboth loops drive clean");
process.exit(fail ? 1 : 0);
