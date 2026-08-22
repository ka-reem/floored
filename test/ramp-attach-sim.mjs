/* Browser-free reproduction of the on/off-ramp teleport bug.

   Replays the exact per-frame position pipeline the engine runs — terrain
   heightAt (deck / ramp / bypass max), the physics y-follow rule, the deck
   parapet clamp and the ramp-wall OBBs from collide.ts/highway.ts — against
   the real compiled geometry, with no GPU and no server.

   Scenarios:
     1. drive every lateral offset across the deck past BOTH gores and flag
        any single-frame position jump larger than the wheels can produce;
     2. drive the exit ramp (take it) and the entry ramp (merge) the same way.

   Usage: node test/ramp-attach-sim.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "rampsim-"));
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
const { buildRamps, rampAt, parapetGap } = await import(path.join(dir, "ramps.js"));
const { getRouteGraph } = await import(path.join(dir, "routegraph.js"));
const { CONNECT_Z, RAMP_W } = await import(path.join(dir, "const.js"));

const cor = getCorridor();
const routes = getRouteGraph();
// the whole corridor band is terrain-flattened, so gh = 0 is exact (the same
// assumption routegraph.ts itself builds on)
const ramps = buildRamps(() => 0);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/* ---- terrain.heightAt, replicated (ground = 0 in the band) ---- */
function heightAt(x, z, refY) {
  let best = 0;
  if (refY > cor.centerY(z) - 3.4) {
    const dy = cor.heightAt(x, z, 1.0);
    if (dy !== null) best = Math.max(best, dy);
  }
  const r = rampAt(ramps, x, z, 1.0);
  if (r && Math.abs(r.y - refY) < 3.4) best = Math.max(best, r.y);
  const g = routes.surfaceAt(x, z, 1.0);
  if (g && Math.abs(g.y - refY) < 3.4) best = Math.max(best, g.y);
  return best;
}
const onRamp = (x, z) => {
  const r = rampAt(ramps, x, z, 1.0);
  return r ? r.y : null;
};

/* ---- ramp-wall OBBs, replicated from highway.ts buildRampMeshes ---- */
const WALL_H = 1.0, WALL_T = 0.3;
const obbs = [];
for (const r of ramps) {
  const pts = r.pts;
  const edge = (i, lat) => {
    const p = pts[i];
    return [p.x + p.nx * lat, p.z + p.nz * lat, p.y];
  };
  const wallEnd = r.len - 7;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    for (const sgn of [-1, 1]) {
      const la = sgn > 0 ? a.hIn : -a.hOut, lb = sgn > 0 ? b.hIn : -b.hOut;
      if (a.s > wallEnd) continue;
      if (sgn > 0) {
        const zc = cor.zAt(a.x, a.z);
        const clear = -cor.halfWidth(zc) - (cor.latAt(a.x, a.z) + a.hIn);
        if (clear < 0.75) continue;
      }
      const off = sgn * (WALL_T / 2 + 0.12);
      const a0 = edge(i, la + off - (sgn * WALL_T) / 2), a1 = edge(i, la + off + (sgn * WALL_T) / 2);
      const b0 = edge(i + 1, lb + off - (sgn * WALL_T) / 2);
      const b1 = edge(i + 1, lb + off + (sgn * WALL_T) / 2);
      const mx = (a0[0] + b0[0] + a1[0] + b1[0]) / 4;
      const mz = (a0[1] + b0[1] + a1[1] + b1[1]) / 4;
      const wdx = (b0[0] + b1[0] - a0[0] - a1[0]) / 2;
      const wdz = (b0[1] + b1[1] - a0[1] - a1[1]) / 2;
      const wl = Math.hypot(wdx, wdz) || 1;
      obbs.push({
        x: mx, z: mz, hw: WALL_T / 2 + 0.2, hd: wl / 2 + 0.1,
        cos: wdz / wl, sin: wdx / wl, y0: a.y - 1.2, y1: a.y + WALL_H + 1.2,
      });
    }
  }
  // nose connector: clipped parapet end -> the outer wall's first post
  const g = parapetGap(r);
  const zP = r.dir > 0 ? g.z0 : g.z1;
  const latP = -(cor.halfWidth(zP) + 0.34 / 2 + 0.06);
  const wP = cor.worldOf(zP, latP);
  const p0 = pts[0];
  const nOff = WALL_T / 2 + 0.12;
  const nx0 = p0.x - p0.nx * nOff, nz0 = p0.z - p0.nz * nOff;
  const dx = nx0 - wP.x, dz = nz0 - wP.z;
  const dl = Math.hypot(dx, dz) || 1;
  obbs.push({
    x: (wP.x + nx0) / 2, z: (wP.z + nz0) / 2,
    hw: WALL_T / 2 + 0.05, hd: dl / 2 + 0.1,
    cos: dz / dl, sin: dx / dl,
    y0: Math.min(wP.y, p0.y) - 1.2, y1: Math.max(wP.y, p0.y) + WALL_H + 1.2,
  });
}

/* ---- collidePlayer's positional writes, replicated ---- */
const halfW = 0.92, halfL = 2.32; // typical rig
const gaps = ramps.map((r) => parapetGap(r));
const newGaps = routes.newParapetGaps();
function collide(car) {
  let moved = 0;
  // deck parapet clamp
  if (Math.abs(car.y - cor.centerY(car.z)) < 2.6 && car.z > cor.ZB0 && car.z < cor.ZB1) {
    const zc = cor.zAt(car.x, car.z);
    const lat = cor.latAt(car.x, car.z);
    const lim = cor.halfWidth(zc) + 0.06 - halfW;
    const side = lat >= 0 ? 1 : -1;
    let guarded = true;
    if (side < 0) {
      for (const g of gaps) if (car.z > g.z0 && car.z < g.z1) guarded = false;
      const ry = onRamp(car.x, car.z);
      if (ry !== null && Math.abs(ry - car.y) < 2.6) guarded = false;
    }
    for (const gp of newGaps)
      if (car.z > gp.z0 && car.z < gp.z1 && side === gp.side) guarded = false;
    if (guarded) {
      const sf = routes.surfaceAt(car.x, car.z, 1.0);
      if (sf !== null && Math.abs(sf.y - car.y) < 2.6) guarded = false;
    }
    if (guarded && Math.abs(lat) > lim) {
      const pen = Math.min(Math.abs(lat) - lim, 0.35); // CLAMP_STEP
      const m = cor.slopeX(zc), inv = 1 / Math.hypot(m, 1);
      const nx = side * inv, nz = side * -m * inv;
      car.x -= nx * pen;
      car.z -= nz * pen;
      moved = Math.max(moved, pen);
    }
  }
  // ramp wall OBBs at both axles
  const fx = Math.sin(car.h), fz = Math.cos(car.h);
  for (const offd of [halfL * 0.56, -halfL * 0.56]) {
    const px = car.x + fx * offd, pz = car.z + fz * offd;
    for (const o of obbs) {
      if (car.y + 1.4 < o.y0 || car.y > o.y1) continue;
      const rr = halfW + 0.1;
      const dx = px - o.x, dz = pz - o.z;
      const lx = dx * o.cos - dz * o.sin;
      const lz = dx * o.sin + dz * o.cos;
      const cx = Math.max(-o.hw, Math.min(lx, o.hw));
      const cz = Math.max(-o.hd, Math.min(lz, o.hd));
      const ddx = lx - cx, ddz = lz - cz, d2 = ddx * ddx + ddz * ddz;
      if (d2 >= rr * rr || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const pen = rr - d;
      const nx = (ddx / d) * o.cos + (ddz / d) * o.sin;
      const nz = -(ddx / d) * o.sin + (ddz / d) * o.cos;
      car.x += nx * pen;
      car.z += nz * pen;
      moved = Math.max(moved, pen);
    }
  }
  return moved;
}

/* ---- physics y-follow, replicated ---- */
function stepY(car, dt) {
  const hHere = heightAt(car.x, car.z, car.y);
  const before = car.y;
  car.y += clamp(hHere - car.y, -14 * dt, 14 * dt);
  if (Math.abs(hHere - car.y) > 3) car.y = hHere;
  return car.y - before;
}

let fail = 0;
const bad = (m) => { console.log("  FAIL " + m); fail++; };
const f = (n) => n.toFixed(2);

/* ---- scenario 0: branch classification ----
   rampAt must claim a point only when the ramp's real pavement (hIn/hOut) is
   under it. The old bare distance-to-centreline test classified a car in the
   deck's outside lane as ON the ramp all along the divergence wedge. */
console.log("scenario 0: rampAt claims only real ramp pavement");
for (const r of ramps) {
  const sgn = r.dir; // exit runs +z from its gore, entry -z
  // a lane-0 car on the deck beside the wedge is not on the ramp
  for (const dz of [5, 10, 30, 50, 70]) {
    const z = r.zr + sgn * dz;
    const w = cor.worldOf(z, cor.laneOffset(0, z));
    const hit = rampAt(ramps, w.x, w.z, 1.0);
    if (hit && hit.ramp === r)
      bad(`${r.kind}: lane-0 car at z=${f(z)} classified as on-ramp (lat=${f(hit.lat)})`);
  }
  // while every centreline point past the nose taper is still claimed
  for (const p of r.pts) {
    if (p.s < 2 || p.s > r.len - 2) continue;
    if (!rampAt(ramps, p.x, p.z, 0))
      bad(`${r.kind}: centreline at s=${f(p.s)} not claimed`);
  }
}
if (!fail) console.log("  ok: wedge-side deck lanes stay off the ramp; centreline stays on");

/* ---- scenario 1: straight-line passes at fixed lateral offset ---- */
console.log("scenario 1: pass both gores at every lateral offset (no steering)");
const dt = 1 / 120, V = 38;
for (let frac = -1; frac <= 0.01; frac += 0.025) {
  // ride a fixed fraction of the drivable width, like a driver holding a lane
  // as tapers slide it: frac -1 hugs the west edge, 0 is the centreline
  const latOf = (z) => frac * (cor.halfWidth(z) - halfW - 0.1);
  const w0 = cor.worldOf(-700, latOf(-700));
  const car = { x: w0.x, y: cor.centerY(-700), z: w0.z, h: 0 };
  const lat0 = latOf(CONNECT_Z[0]);
  let worstJump = 0, worstZ = 0, worstWhat = "";
  // track the corridor parameter separately: worldOf shifts z on bends, so
  // reading car.z back would stall the march there
  for (let zn = -700 + V * dt; zn < 150; zn += V * dt) {
    const w = cor.worldOf(zn, latOf(zn));
    car.h = cor.pose(zn).h;
    car.x = w.x;
    car.z = w.z;
    const dy = stepY(car, dt);
    const preX = car.x, preZ = car.z;
    collide(car);
    const lateralKick = Math.hypot(car.x - preX, car.z - preZ);
    // a real car at 38 m/s can climb/fall 14*dt = 0.117 m/frame; anything
    // bigger is the snap rule firing. Any collide kick at all is wrong here:
    // the car never leaves the pavement.
    const jump = Math.max(Math.abs(dy) > 0.118 ? Math.abs(dy) : 0, lateralKick);
    if (jump > worstJump) {
      worstJump = jump;
      worstZ = preZ;
      worstWhat = lateralKick > 0 ? "lateral kick" : "y snap";
    }
  }
  if (worstJump > 0.001)
    bad(`lat ${f(lat0)}: ${worstWhat} of ${f(worstJump)} m at z=${f(worstZ)}`);
}
if (!fail) console.log("  ok: no jumps while passing on the deck");

/* ---- scenario 2: drive the exit ramp ---- */
console.log("scenario 2: take the exit ramp (follow its centreline)");
{
  const r = ramps.find((q) => q.kind === "exit");
  const car = { x: 0, y: 0, z: 0, h: 0 };
  /* Approach in lane 0, cross the deck edge inside the opening wedge (the
     pavement at the nose itself is zero-width — no car exits over the nose
     point), then follow the ramp centreline once it is fully open. */
  let prev = null, worst = { jump: 0 };
  const path0 = [];
  for (let z = r.zr - 120; z < r.zr; z += 0.25) {
    const lat = cor.laneOffset(0, z);
    const w = cor.worldOf(z, lat);
    path0.push([w.x, w.z]);
  }
  const iJoin = r.pts.findIndex((p) => p.s >= 44);
  const latJoin = cor.latAt(r.pts[iJoin].x, r.pts[iJoin].z);
  const zJoin = r.pts[iJoin].z;
  for (let z = r.zr; z < zJoin; z += 0.25) {
    const t = (z - r.zr) / (zJoin - r.zr);
    const sm = t * t * (3 - 2 * t);
    const w = cor.worldOf(z, -5.55 + (latJoin + 5.55) * sm);
    path0.push([w.x, w.z]);
  }
  for (const p of r.pts.slice(iJoin)) path0.push([p.x, p.z]);
  car.x = path0[0][0]; car.z = path0[0][1]; car.y = cor.centerY(r.zr - 120);
  for (let i = 1; i < path0.length; i++) {
    const [tx, tz] = path0[i];
    const d = Math.hypot(tx - car.x, tz - car.z);
    const steps = Math.max(1, Math.ceil(d / (V * dt)));
    for (let k = 0; k < steps; k++) {
      const remx = tx - car.x, remz = tz - car.z;
      const rem = Math.hypot(remx, remz) || 1;
      const adv = Math.min(V * dt, rem);
      car.h = Math.atan2(remx / rem, remz / rem);
      car.x += (remx / rem) * adv;
      car.z += (remz / rem) * adv;
      const dy = stepY(car, dt);
      const preX = car.x, preZ = car.z;
      collide(car);
      const kick = Math.hypot(car.x - preX, car.z - preZ);
      const jump = Math.max(Math.abs(dy) > 0.118 ? Math.abs(dy) : 0, kick);
      if (jump > worst.jump) worst = { jump, x: preX, z: preZ, kick, dy };
    }
  }
  if (worst.jump > 0.35)
    bad(`exit ramp: jump ${f(worst.jump)} m at (${f(worst.x)}, ${f(worst.z)}) kick=${f(worst.kick)} dy=${f(worst.dy)}`);
  else console.log(`  ok: worst per-frame correction ${f(worst.jump)} m`);
}

/* ---- scenario 3: drive the entry ramp up and merge ---- */
console.log("scenario 3: climb the entry ramp and merge");
{
  const r = ramps.find((q) => q.kind === "entry");
  const path0 = [];
  const iJoin = r.pts.findIndex((p) => p.s >= 44);
  for (let i = r.pts.length - 1; i >= iJoin; i--) path0.push([r.pts[i].x, r.pts[i].z]);
  // merge across the closing wedge into lane 0, then continue on the deck
  const latJoin = cor.latAt(r.pts[iJoin].x, r.pts[iJoin].z);
  const zJoin = r.pts[iJoin].z;
  for (let z = zJoin; z < r.zr + 120; z += 0.25) {
    const t = clamp((z - zJoin) / (r.zr - zJoin), 0, 1);
    const sm = t * t * (3 - 2 * t);
    const w = cor.worldOf(z, latJoin + (-5.55 - latJoin) * sm);
    path0.push([w.x, w.z]);
  }
  const car = { x: path0[0][0], y: r.pts[r.pts.length - 1].y, z: path0[0][1], h: 0 };
  let worst = { jump: 0 };
  for (let i = 1; i < path0.length; i++) {
    const [tx, tz] = path0[i];
    const d = Math.hypot(tx - car.x, tz - car.z);
    const steps = Math.max(1, Math.ceil(d / (V * dt)));
    for (let k = 0; k < steps; k++) {
      const remx = tx - car.x, remz = tz - car.z;
      const rem = Math.hypot(remx, remz) || 1;
      const adv = Math.min(V * dt, rem);
      car.h = Math.atan2(remx / rem, remz / rem);
      car.x += (remx / rem) * adv;
      car.z += (remz / rem) * adv;
      const dy = stepY(car, dt);
      const preX = car.x, preZ = car.z;
      collide(car);
      const kick = Math.hypot(car.x - preX, car.z - preZ);
      const jump = Math.max(Math.abs(dy) > 0.118 ? Math.abs(dy) : 0, kick);
      if (jump > worst.jump) worst = { jump, x: preX, z: preZ, kick, dy };
    }
  }
  if (worst.jump > 0.35)
    bad(`entry ramp: jump ${f(worst.jump)} m at (${f(worst.x)}, ${f(worst.z)}) kick=${f(worst.kick)} dy=${f(worst.dy)}`);
  else console.log(`  ok: worst per-frame correction ${f(worst.jump)} m`);
}

/* ---- scenario 4: the reported bug — pass the exit while drifting right up
   to (and slightly over) the gore, never steering onto the ramp. The car
   keeps its state frame to frame here, so collide pushes feed forward the way
   they do in the engine. Pre-fix this teleported: rampAt claimed the car for
   the ramp, heightAt handed it the descending surface, and physics' >3 m rule
   snapped it 10 m down the moment every surface stopped answering. ---- */
console.log("scenario 4: pass the exit gore drifting onto/over the edge");
{
  const r = ramps.find((q) => q.kind === "exit");
  const hw = cor.halfWidth(r.zr);
  for (const over of [0.0, 0.6, 1.2, 2.0]) {
    const target = -(hw - halfW - 0.1 + over);
    const w0 = cor.worldOf(r.zr - 120, -5.55);
    const car = { x: w0.x, y: cor.centerY(r.zr - 120), z: w0.z, h: 0 };
    let worst = { jump: 0 }, prevY = car.y;
    for (let step = 0; step * V * dt < 300; step++) {
      // straight down the corridor (the window is straight here), drifting
      // west at 1.4 m/s until the target offset is reached
      const lat = cor.latAt(car.x, car.z);
      const drift = lat > target ? -1.4 : 0;
      car.z += V * dt;
      car.x += drift * dt;
      const dy = stepY(car, dt);
      const preX = car.x, preZ = car.z;
      collide(car);
      const kick = Math.hypot(car.x - preX, car.z - preZ);
      const jump = Math.max(Math.abs(dy) > 0.125 ? Math.abs(dy) : 0, kick > 0.36 ? kick : 0);
      if (jump > worst.jump)
        worst = { jump, z: preZ, kick, dy, y: car.y };
      prevY = car.y;
    }
    if (worst.jump > 0.001)
      bad(`over=${f(over)}: jump ${f(worst.jump)} m at z=${f(worst.z)} (kick=${f(worst.kick)} dy=${f(worst.dy)} y=${f(worst.y)})`);
    else console.log(`  ok over=${f(over)}: no teleport (final y=${f(car.y)}, lat=${f(cor.latAt(car.x, car.z))})`);
  }
}

/* ---- scenario 5: barrier continuity along the west deck edge ----
   Outside each gore's drivable mouth (nose -> pavement separation, plus a
   short handover where the slot between the pavements is still too narrow to
   fall through), every z near a gore must be guarded: either the deck parapet
   stands (z outside the parapet-gap window — the engine clamps analytically
   there, and highway.ts now clips the wall mesh to the same window), or a
   ramp/connector wall crosses the escape band just outboard of the edge. */
console.log("scenario 5: barrier continuity at the gores");
{
  const obbDist = (px, pz, o) => {
    const dx = px - o.x, dz = pz - o.z;
    const lx = dx * o.cos - dz * o.sin;
    const lz = dx * o.sin + dz * o.cos;
    const ex = Math.max(0, Math.abs(lx) - o.hw), ez = Math.max(0, Math.abs(lz) - o.hd);
    return Math.hypot(ex, ez);
  };
  for (const r of ramps) {
    const g = parapetGap(r);
    const sepZ = r.zr + r.dir * r.gapZ;
    const open = r.dir > 0 ? [r.zr - 0.5, sepZ + 8.5] : [sepZ - 8.5, r.zr + 0.5];
    let holes = 0, firstHole = null;
    for (let z = g.z0 - 15; z <= g.z1 + 25; z += 0.5) {
      if (z > open[0] && z < open[1]) continue;
      const inGap = z > g.z0 && z < g.z1;
      if (!inGap) continue; // parapet (and the analytic clamp) stand here
      const w = cor.worldOf(z, -(cor.halfWidth(z) + 0.5));
      const dw = cor.centerY(z);
      let d = 1e9;
      for (const o of obbs) {
        if (dw + 1 < o.y0 || dw > o.y1) continue;
        d = Math.min(d, obbDist(w.x, w.z, o));
      }
      if (d > 0.9) {
        holes++;
        if (!firstHole) firstHole = z;
      }
    }
    if (holes)
      bad(`${r.kind} gore: ${holes} unguarded probe(s) outside the mouth, first at z=${f(firstHole)}`);
    else console.log(`  ok ${r.kind} gore: guarded everywhere outside the mouth`);
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall scenarios clean");
process.exit(fail ? 1 : 0);
