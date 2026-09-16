/* Browser-free drive of the whole corridor, hunting for anything that stops a
   car that should not be stopped.

   This exists because of a reported "invisible wall at the end of the
   highway". Two things can cause that and neither shows up in a geometry
   check: a collider box sitting in the drivable band with no visible mesh
   under it, and a splice that never fires so the player runs out of road.
   Both are reproducible here with no GPU.

   It rebuilds the collider set that game/world/highway.ts inserts — piers,
   toll islands, canopy columns, ramp walls, ramp columns — from the same
   corridor/ramp arithmetic the real build uses, then sweeps every lane centre
   along the whole built extent and reports the first thing a car would hit.
   Collision uses collide.ts's own test: each axle is a disc of radius
   halfW + 0.05, not a box.

   Usage: node test/corridor-drive.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "drive-"));
execFileSync("npx", [
  "tsc", "game/world/corridor.ts", "game/world/ramps.ts", "--outDir", out,
  "--rootDir", ".", "--module", "esnext", "--target", "es2020",
  "--moduleResolution", "bundler", "--skipLibCheck",
], { stdio: ["ignore", "ignore", "inherit"] });
const dir = path.join(out, "game", "world");
for (const f of ["corridor.js", "ramps.js"]) {
  const p = path.join(dir, f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w/]+)"/g, '"$1.js"'));
}
const { getCorridor, TOLL, TOLL_PLAZA } = await import(path.join(dir, "corridor.js"));
const { buildRamps, spawnZ } = await import(path.join(dir, "ramps.js"));
const { RAMP_W } = await import(path.join(dir, "const.js"));

const c = getCorridor();
// the terrain is flattened to 0 right across the corridor band, so every
// ground height under the deck and the ramps is 0 (terrain.ts: `corr` fades to
// zero by x = 402 and the deck sits at x = 500)
const ramps = buildRamps(() => 0);
/* The widest car in game/carspecs.ts is 1.86 m, and player.ts derives
   halfW = W / 2 + 0.02 — so 0.95 is the binding case, not an average one. */
const HALF_W = 0.95, HALF_L = 2.35;
const RR = HALF_W + 0.05; // collide.ts probe radius

let fail = 0;
const bad = (m) => {
  console.log("  FAIL " + m);
  fail++;
};
const f = (n) => n.toFixed(2);

/* ---- rebuild the collider set highway.ts inserts ---- */
const aabbs = [], obbs = [];
// piers: highway.ts, PITCH.pier lattice
for (const z of c.lattice(32)) {
  const p = c.pose(z), gy = 0;
  const hgt = Math.max(1.5, p.y - 1.4 - gy);
  aabbs.push({
    x0: p.x - 1.4, x1: p.x + 1.4, z0: z - 1.4, z1: z + 1.4,
    y0: gy, y1: gy + hgt - 1, what: `pier z=${z}`,
  });
}
// toll plaza islands and canopy columns
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
        y0: p0.y, y1: p0.y + 7.4, what: `canopy column s=${s} dz=${dz}`,
      });
}
// ramp walls and support columns
for (const r of ramps) {
  const pts = r.pts, WALL_H = 1.0, WALL_T = 0.3;
  const wallEnd = r.len - 7;
  const edge = (i, lat, dy = 0) => {
    const p = pts[i];
    return [p.x + p.nx * lat, p.y + dy, p.z + p.nz * lat];
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    for (const sgn of [-1, 1]) {
      const la = sgn > 0 ? a.hIn : -a.hOut, lb = sgn > 0 ? pts[i + 1].hIn : -pts[i + 1].hOut;
      if (a.s > wallEnd) continue;
      if (sgn > 0 && a.s < r.sSep) continue;
      const off = sgn * (WALL_T / 2 + 0.12);
      const a0 = edge(i, la + off - (sgn * WALL_T) / 2), a1 = edge(i, la + off + (sgn * WALL_T) / 2);
      const b0 = edge(i + 1, lb + off - (sgn * WALL_T) / 2);
      const b1 = edge(i + 1, lb + off + (sgn * WALL_T) / 2);
      const mx = (a0[0] + b0[0] + a1[0] + b1[0]) / 4;
      const mz = (a0[2] + b0[2] + a1[2] + b1[2]) / 4;
      const wdx = (b0[0] + b1[0] - a0[0] - a1[0]) / 2;
      const wdz = (b0[2] + b1[2] - a0[2] - a1[2]) / 2;
      const wl = Math.hypot(wdx, wdz) || 1;
      obbs.push({
        x: mx, z: mz, hw: WALL_T / 2 + 0.2, hd: wl / 2 + 0.1,
        cos: wdz / wl, sin: wdx / wl, y0: a.y - 1.2, y1: a.y + WALL_H + 1.2,
        what: `${r.kind} ramp wall sgn=${sgn} s=${f(a.s)}`,
      });
    }
    const upA = a.y - a.gy;
    if (i % 7 === 0 && upA > 2.2)
      aabbs.push({
        x0: a.x - 0.85, x1: a.x + 0.85, z0: a.z - 0.85, z1: a.z + 0.85,
        y0: 0, y1: a.gy + upA - 1.2, what: `${r.kind} ramp column s=${f(a.s)}`,
      });
  }
}
console.log(`collider set: ${aabbs.length} AABBs, ${obbs.length} OBBs`);

/* ---- collide.ts's own tests ---- */
const hitAabb = (px, pz, y, b) => {
  if (y + 1.4 < b.y0 || y > b.y1) return false;
  const cx = Math.max(b.x0, Math.min(px, b.x1));
  const cz = Math.max(b.z0, Math.min(pz, b.z1));
  const dx = px - cx, dz = pz - cz;
  return dx * dx + dz * dz < RR * RR;
};
const hitObb = (px, pz, y, o) => {
  if (y + 1.4 < o.y0 || y > o.y1) return false;
  const dx = px - o.x, dz = pz - o.z;
  const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
  const cx = Math.max(-o.hw, Math.min(lx, o.hw));
  const cz = Math.max(-o.hd, Math.min(lz, o.hd));
  const ddx = lx - cx, ddz = lz - cz;
  return ddx * ddx + ddz * ddz < (HALF_W + 0.1) ** 2;
};

/* ---- sweep every lane centre along the whole built deck ---- */
console.log("sweeping every lane centre for colliders in the drivable band:");
const blockers = new Map();
for (let z = c.ZB0 + 2; z <= c.ZB1 - 2; z += 0.5) {
  const n = c.lanes(z), y = c.centerY(z);
  for (let k = 0; k < n; k++) {
    const p = c.worldOf(z, c.laneOffset(k, z));
    // collide.ts probes at the front and rear axle
    for (const off of [HALF_L * 0.56, -HALF_L * 0.56]) {
      const px = p.x + Math.sin(0) * off, pz = p.z + Math.cos(0) * off;
      for (const b of aabbs)
        if (hitAabb(px, pz, y, b)) {
          const e = blockers.get(b.what) || { z0: 1e9, z1: -1e9, lanes: new Set() };
          e.z0 = Math.min(e.z0, z);
          e.z1 = Math.max(e.z1, z);
          e.lanes.add(k);
          blockers.set(b.what, e);
        }
      for (const o of obbs)
        if (hitObb(px, pz, y, o)) {
          const e = blockers.get(o.what) || { z0: 1e9, z1: -1e9, lanes: new Set() };
          e.z0 = Math.min(e.z0, z);
          e.z1 = Math.max(e.z1, z);
          e.lanes.add(k);
          blockers.set(o.what, e);
        }
    }
  }
}
if (!blockers.size) console.log("  none — every lane centre is clear end to end");
for (const [what, e] of blockers)
  console.log(`  ${what.padEnd(34)} blocks lanes {${[...e.lanes].sort().join(",")}}` +
    ` over z ∈ [${f(e.z0)}, ${f(e.z1)}]`);

/* A blocker is only legitimate if it is a toll island: those are the gates,
   they are visible, and threading them is the point. Anything else standing in
   a lane centre is the invisible wall. */
for (const [what, e] of blockers)
  if (!what.startsWith("toll island"))
    bad(`${what} stands in lane centre(s) {${[...e.lanes].join(",")}} at z ∈ [${f(e.z0)}, ${f(e.z1)}]`);

/* ---- thread every toll gate at speed -----------------------------------
   The check asserts the gate's clear width arithmetically. This drives it:
   a car aimed down each gate's lane centre, at speed, carrying the lateral
   error a player actually arrives with. A gate that is wide enough on paper
   but whose booth, kerb or canopy column intrudes will show up here and not
   there. */
{
  const zc = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
  const lanes = c.lanes(zc), V = 30, DT = 1 / 120, ERR = 0.5;
  console.log(`threading all ${lanes} gates at ${V} m/s with ±${ERR} m lateral error:`);
  let worstGap = 1e9, worstAt = "";
  for (let k = 0; k < lanes; k++) {
    let contact = null, gap = 1e9;
    for (const err of [-ERR, -ERR / 2, 0, ERR / 2, ERR]) {
      for (let z = TOLL.plazaZ0 - 40; z <= TOLL.plazaZ1 + 40; z += V * DT) {
        const y = c.centerY(z);
        const p = c.worldOf(z, c.laneOffset(k, z) + err);
        for (const off of [HALF_L * 0.56, -HALF_L * 0.56]) {
          const px = p.x, pz = p.z + off;
          for (const b of aabbs) {
            if (hitAabb(px, pz, y, b)) contact = `${b.what} at z=${f(z)}, err ${err}`;
            // how close the car's disc came to this box, for the margin report
            if (y + 1.4 >= b.y0 && y <= b.y1) {
              const cx = Math.max(b.x0, Math.min(px, b.x1));
              const cz = Math.max(b.z0, Math.min(pz, b.z1));
              gap = Math.min(gap, Math.hypot(px - cx, pz - cz) - RR);
            }
          }
        }
      }
    }
    console.log(`  gate ${k}: ${contact ? "CONTACT — " + contact : "clean"}` +
      `, closest approach ${f(gap)} m`);
    if (contact) bad(`gate ${k} cannot be threaded: ${contact}`);
    if (gap < worstGap) {
      worstGap = gap;
      worstAt = `gate ${k}`;
    }
  }
  console.log(`  tightest gate is ${worstAt} with ${f(worstGap)} m of clearance` +
    ` beyond the car's own half-width at ±${ERR} m error`);
  if (worstGap < 0.25)
    bad(`only ${f(worstGap)} m of margin through the tightest gate at ±${ERR} m error`);
}

/* ---- nothing outside the corridor may pin the car short of the seam ------
   The splice can only fire if the car is allowed to reach Z1. stepPhysics()
   ends with a world-bounds clamp on car.x/car.z, inherited from the map that
   existed before the corridor, and if that bound sits inside the wrap band the
   car is held short of the threshold forever: spliceDelta() stays 0, the deck
   carries on ahead to ZB1, and the player is standing against nothing. That is
   the reported "invisible wall".

   physics.ts is out of scope here, so this reads the constant rather than
   changing it — but a geometry check that cannot see the one line able to
   veto the whole loop is not worth much. */
{
  const src = readFileSync("game/physics.ts", "utf8");
  const m = src.match(/Math\.abs\(car\.z\)\s*>\s*(\d+(?:\.\d+)?)/);
  if (!m) {
    console.log("physics z-bound: none found (the splice owns longitudinal containment)");
  } else {
    const lim = Number(m[1]);
    console.log(`physics z-bound: ±${lim} m, corridor wraps at ±${c.Z1} m`);
    if (lim <= c.Z1)
      bad(`stepPhysics clamps car.z to ±${lim}, inside the wrap band ±${c.Z1} — ` +
        `the car can never reach the splice threshold, so the loop never fires ` +
        `and it stops dead against nothing ${c.Z1 - lim} m short of the seam`);
  }
}

/* ---- drive it: does the splice fire before the deck runs out? ---- */
console.log("driving the loop:");
for (const [name, dir] of [["northbound", 1], ["southbound", -1]]) {
  let z = spawnZ(), laps = 0, stuck = null;
  const V = 55, DT = 1 / 120; // 198 km/h
  for (let step = 0; step < 400000; step++) {
    z += dir * V * DT;
    const dz = c.spliceDelta(z);
    if (dz) {
      z += dz;
      laps++;
      if (z < c.Z0 || z >= c.Z1) {
        stuck = `splice left the car outside [Z0, Z1) at z=${f(z)}`;
        break;
      }
    }
    if (z < c.ZB0 || z > c.ZB1) {
      stuck = `ran off the built deck at z=${f(z)} without the splice firing`;
      break;
    }
    if (laps >= 3) break;
  }
  console.log(`  ${name}: ${laps} lap(s), final z=${f(z)}${stuck ? " — " + stuck : ""}`);
  if (stuck) bad(`${name}: ${stuck}`);
  if (laps < 3) bad(`${name}: only completed ${laps} laps`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nno invisible walls; the loop drives");
process.exit(fail ? 1 : 0);
