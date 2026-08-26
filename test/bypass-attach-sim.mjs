/* Browser-free reproduction of the bypass gore (diverge / merge) glitches.

   ramp-attach-sim.mjs does this job for the two town ramps; this is the same
   idea for the second carriageway's own junctions — the west diverge at
   DIVERGE_Z and the east merge at MERGE_Z, which is where the deck and the
   bypass share pavement and where the surface a car is standing on changes
   hands.

   Unlike that sim this one imports the REAL terrain.heightAt and the REAL
   collidePlayer rather than restating them, so it cannot drift out of sync
   with the code it is guarding. Static geometry (pier boxes, gore nose blocks)
   is left out on purpose: what is under test here is the analytic parapet
   clamps and the resolved ground height, and both of those are pure functions
   of the corridor / route geometry.

   Usage: node test/bypass-attach-sim.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const out = mkdtempSync(path.join(tmpdir(), "bypasssim-"));
execFileSync("npx", [
  "tsc", "game/world/terrain.ts", "game/collide.ts",
  "--outDir", out,
  "--rootDir", ".", "--module", "esnext", "--target", "es2020",
  "--moduleResolution", "bundler", "--skipLibCheck",
], { stdio: ["ignore", "ignore", "inherit"] });
/* the emitted tree lives in a temp dir, so bare specifiers cannot resolve
   against the project's node_modules — point "three" straight at the file.
   (Only buildGround touches it; nothing here calls that.) */
const three = pathToFileURL(
  createRequire(import.meta.url).resolve("three")
).href;
for (const f of [
  "game/util.js", "game/collide.js",
  "game/world/terrain.js", "game/world/corridor.js",
  "game/world/ramps.js", "game/world/routegraph.js", "game/world/const.js",
]) {
  const p = path.join(out, f);
  if (!existsSync(p)) continue;
  writeFileSync(p, readFileSync(p, "utf8")
    .replace(/"(\.\.?\/[\w/]+)"/g, '"$1.js"')
    .replace(/ from "three"/g, ` from "${three}"`));
}
const imp = (f) => import(path.join(out, f));
const { makeTerrain } = await imp("game/world/terrain.js");
const { collidePlayer } = await imp("game/collide.js");
const { getCorridor } = await imp("game/world/corridor.js");
const { getRouteGraph, DIVERGE_Z, MERGE_Z, BYPASS } = await imp("game/world/routegraph.js");

const cor = getCorridor();
const routes = getRouteGraph();
// deterministic rng: the hill field is faded to zero across the whole corridor
// band, so the seed cannot change a single number this sim looks at
let seed = 1;
const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const terrain = makeTerrain(rng);
const world = {
  terrain,
  routes,
  colliders: { aabbs: [], obbs: [], nearbyAabbs: () => [], nearbyObbs: () => [] },
};
const halfW = 0.92, halfL = 2.32; // typical rig
const dt = 1 / 120, V = 38;
/** the follow rate physics.ts uses, per frame */
const FOLLOW = 14 * dt;

let fail = 0;
const bad = (m) => { console.log("  FAIL " + m); fail++; };
const f = (n) => n.toFixed(2);

function newCar(x, y, z, h = 0) {
  return {
    x, y, z, h, u: V, v: 0, r: 0, wvx: Math.sin(h) * V, wvz: Math.cos(h) * V,
    slope: 0, odo: 0, absOn: false, slipAmt: 0, slipDemand: 0,
    pitchDyn: 0, rollDyn: 0, axS: 0, ayS: 0,
  };
}

/** one frame of the engine's position pipeline, minus the driving inputs:
    resolve the ground, follow it the way physics.ts does, then collide */
function frame(car) {
  const hHere = terrain.heightAt(car.x, car.z, car.y);
  const y0 = car.y;
  car.y += Math.max(-FOLLOW, Math.min(FOLLOW, hHere - car.y));
  const snapped = Math.abs(hHere - car.y) > 3;
  if (snapped) car.y = hHere;
  const px = car.x, pz = car.z;
  const res = collidePlayer(car, world, [], halfW, halfL);
  return {
    dy: car.y - y0,
    snapped,
    kick: Math.hypot(car.x - px, car.z - pz),
    hit: res.hit,
  };
}

/* Drive a lateral-offset-holding line down the corridor and report the worst
   single-frame discontinuity. `lat(z)` is the offset to hold; the car is
   placed on the line each frame (the point is the surface and the clamps, not
   the tyre model), but its own state carries forward so a clamp that moves it
   is visible in the next frame's numbers. */
function runDeck(z0, z1, latOf) {
  const w0 = cor.worldOf(z0, latOf(z0));
  const car = newCar(w0.x, cor.centerY(z0), w0.z);
  let worst = { bad: 0 };
  for (let zn = z0; zn < z1; zn += V * dt) {
    const w = cor.worldOf(zn, latOf(zn));
    car.h = cor.pose(zn).h;
    car.x = w.x;
    car.z = w.z;
    const r = frame(car);
    /* On the deck at a held offset nothing may move the car: no snap, no
       climb faster than the follow rate, and no clamp kick at all — every
       lateral offset tested is inside the pavement. */
    const sev = Math.max(r.snapped ? 99 : 0, Math.abs(r.dy) >= FOLLOW - 1e-6 ? Math.abs(r.dy) : 0, r.kick);
    if (sev > worst.bad) worst = { bad: sev, z: zn, dy: r.dy, kick: r.kick, snapped: r.snapped, y: car.y };
  }
  return worst;
}

/* ---- scenario 1: hold every deck lane past both gores ---- */
console.log("scenario 1: hold every deck lane through the diverge and the merge");
for (const [z0, z1, name] of [[DIVERGE_Z - 140, DIVERGE_Z + 260, "diverge"],
                              [MERGE_Z - 160, MERGE_Z + 200, "merge"]]) {
  for (let k = 0; k < 6; k++) {
    // hold lane k where it exists; lanes(z) changes through the tapers, so
    // ride the lane the corridor itself would put a driver in
    const latOf = (z) => cor.laneOffset(Math.min(k, cor.lanes(z) - 1), z);
    if (cor.lanes(z0) <= k && cor.lanes(z1) <= k) continue;
    const worst = runDeck(z0, z1, latOf);
    if (worst.bad > 0.001)
      bad(`${name} lane ${k}: ${worst.snapped ? "SNAP" : "move"} at z=${f(worst.z)} `
        + `(dy=${f(worst.dy)} kick=${f(worst.kick)} y=${f(worst.y)})`);
  }
}
/* and the same holding the very edge of the pavement, where the clamps live */
for (const [z0, z1, name] of [[DIVERGE_Z - 140, DIVERGE_Z + 260, "diverge"],
                              [MERGE_Z - 160, MERGE_Z + 200, "merge"]]) {
  for (const sgn of [-1, 1]) {
    const latOf = (z) => sgn * (cor.halfWidth(z) - halfW - 0.12);
    const worst = runDeck(z0, z1, latOf);
    if (worst.bad > 0.001)
      bad(`${name} edge ${sgn > 0 ? "east" : "west"}: ${worst.snapped ? "SNAP" : "move"} `
        + `at z=${f(worst.z)} (dy=${f(worst.dy)} kick=${f(worst.kick)} y=${f(worst.y)})`);
  }
}
if (!fail) console.log("  ok: nothing moves a car holding its line on the deck");

/* ---- scenario 2: drive the bypass end to end ---- */
console.log("scenario 2: drive the bypass from the diverge nose to the merge");
{
  const by = routes.bypass;
  for (const frac of [-0.75, -0.35, 0, 0.35, 0.75]) {
    /* Hold a fraction of the pavement — but a closing gore taper is *supposed*
       to move a car: at both noses the free edge sweeps inboard past the
       centreline and funnels the driver onto the deck. So the line is capped
       against the free edge's own limit; the shared edge has no wall and no
       limit, because the deck simply continues past it. */
    const latAt = (s) => {
      const { hwL, hwR } = by.halfWidths(s);
      const { shL, shR } = by.sharedSides(s);
      const hw = frac >= 0 ? hwL : hwR;
      let lat = frac * Math.max(0, hw - halfW - 0.12);
      if (!shL) lat = Math.min(lat, hwL + 0.06 - halfW - 0.02);
      if (!shR) lat = Math.max(lat, -(hwR + 0.06 - halfW - 0.02));
      return lat;
    };
    const p0 = by.worldOf(2, latAt(2));
    const car = newCar(p0.x, p0.y, p0.z);
    let worst = { bad: 0 };
    for (let s = 2; s < by.len - 2; s += V * dt) {
      const p = by.worldOf(s, latAt(s));
      const po = by.poseAt(s);
      car.h = po.h;
      car.x = p.x;
      car.z = p.z;
      const r = frame(car);
      const sev = Math.max(r.snapped ? 99 : 0,
        Math.abs(r.dy) >= FOLLOW - 1e-6 ? Math.abs(r.dy) : 0, r.kick);
      if (sev > worst.bad) worst = { bad: sev, s, dy: r.dy, kick: r.kick, snapped: r.snapped, y: car.y, py: p.y };
    }
    if (worst.bad > 0.001)
      bad(`bypass frac ${f(frac)}: ${worst.snapped ? "SNAP" : "move"} at s=${f(worst.s)} `
        + `(dy=${f(worst.dy)} kick=${f(worst.kick)} y=${f(worst.y)} want ${f(worst.py)})`);
  }
}
if (!fail) console.log("  ok: the viaduct carries a car end to end with no correction");

/* ---- scenario 3: the reported bug — hold a deck lane beside a gore and
   drift toward it, the way a driver hugging the kerb (or the fast lane at the
   merge) does. Pre-fix the bypass parapet clamp reached ~10 m off its own
   centreline and dragged a car OFF the deck onto the viaduct; where the deck
   parapet had re-armed the two clamps then fought frame to frame. ---- */
console.log("scenario 3: drift toward each gore from the adjacent deck lane");
{
  for (const [zStart, zEnd, side, name] of [
    [DIVERGE_Z - 160, DIVERGE_Z + 220, -1, "diverge (kerb lane)"],
    [MERGE_Z - 180, MERGE_Z + 140, 1, "merge (fast lane)"],
  ]) {
    for (const drift of [0, 0.5, 1.2]) {
      const w0 = cor.worldOf(zStart, side * 2);
      const car = newCar(w0.x, cor.centerY(zStart), w0.z);
      let worst = { bad: 0 }, offDeck = null;
      for (let step = 0; car.z < zEnd; step++) {
        // straight down the corridor, drifting toward the gore side until the
        // car is up against the parapet line
        const zc = cor.zAt(car.x, car.z);
        const lat = cor.latAt(car.x, car.z);
        const lim = cor.halfWidth(zc) - halfW - 0.12;
        car.z += V * dt;
        if (side * lat < lim) car.x += side * drift * dt;
        const r = frame(car);
        const sev = Math.max(r.snapped ? 99 : 0,
          Math.abs(r.dy) >= FOLLOW - 1e-6 ? Math.abs(r.dy) : 0,
          r.kick > 0.001 ? r.kick : 0);
        if (sev > worst.bad) worst = { bad: sev, z: car.z, dy: r.dy, kick: r.kick, snapped: r.snapped };
        // the car must still be supported at deck height the whole way
        if (offDeck === null && car.y < cor.centerY(car.z) - 1.5) offDeck = car.z;
      }
      if (offDeck !== null)
        bad(`${name} drift ${f(drift)}: fell off the deck at z=${f(offDeck)} (final y=${f(car.y)})`);
      else if (worst.bad > 0.001)
        bad(`${name} drift ${f(drift)}: ${worst.snapped ? "SNAP" : "move"} at z=${f(worst.z)} `
          + `(dy=${f(worst.dy)} kick=${f(worst.kick)})`);
    }
  }
}
if (!fail) console.log("  ok: a car that stays on the deck stays on the deck");

/* ---- scenario 4: barrier continuity along the free edges ----
   Every metre of pavement edge that is NOT shared with the neighbouring
   carriageway is a 10 m drop, and something has to hold the car there.
   Driving into it is the only fair way to ask: the clamps deliberately do not
   reach for a car that is already several metres out (that reach is what let
   the bypass wall grab cars off the main deck), so a probe teleported past the
   wall line would report a hole that no car can ever reach. */
console.log("scenario 4: barrier continuity along the free edges");
{
  const by = routes.bypass;
  /** shove a car sideways off `start` for two seconds and see where it ends */
  const shove = (x, y, z, h, nx, nz) => {
    const car = newCar(x, y, z, h);
    for (let k = 0; k < 240; k++) {
      // hold the outward slide at 6 m/s on top of the along-road speed
      car.x += (car.wvx + nx * 6) * dt;
      car.z += (car.wvz + nz * 6) * dt;
      const r = frame(car);
      if (r.snapped || car.y < y - 2) return { fell: true, x: car.x, z: car.z, y: car.y };
    }
    return { fell: false, y: car.y };
  };
  const holes = [];
  // the bypass's own edges
  for (let s = 1; s < by.len; s += 2) {
    const { hwL, hwR } = by.halfWidths(s);
    const { shL, shR } = by.sharedSides(s);
    const po = by.poseAt(s);
    for (const [sgn, hw, shared] of [[1, hwL, shL], [-1, hwR, shR]]) {
      if (shared) continue; // the deck carries on past this edge
      // start inside the wall line, wherever the taper currently puts it
      const lat = sgn * Math.max(0, hw - halfW - 0.2);
      const r = shove(
        po.x + po.nx * lat, po.y, po.z + po.nz * lat, Math.atan2(po.tx, po.tz),
        po.nx * sgn, po.nz * sgn);
      if (r.fell) holes.push({ where: `bypass s=${f(s)} side ${sgn > 0 ? "+lat" : "-lat"}`, r });
    }
  }
  // and the deck's own edges through both new parapet gaps
  for (const g of routes.newParapetGaps()) {
    for (let z = g.z0 - 30; z <= g.z1 + 30; z += 2) {
      const lat = g.side * Math.max(0, cor.halfWidth(z) - halfW - 0.2);
      const w = cor.worldOf(z, lat);
      const po = cor.pose(z);
      const r = shove(w.x, cor.centerY(z), w.z, po.h, po.nx * g.side, po.nz * g.side);
      if (r.fell) holes.push({ where: `deck z=${f(z)} side ${g.side}`, r });
    }
  }
  if (holes.length) {
    bad(`${holes.length} place(s) where a car slid off a free edge; `
      + `first: ${holes[0].where} -> y=${f(holes[0].r.y)}`);
    if (process.env.DUMP_HOLES) for (const h of holes) console.log(`    ${h.where}`);
  } else console.log("  ok: no free edge lets a car slide off");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall scenarios clean");
process.exit(fail ? 1 : 0);
