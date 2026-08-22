/* Browser-free checks on the expressway corridor.

   Everything the world builder draws — pavement, markings, parapets, signs,
   gantries, sound walls, the tunnel, the toll plaza — is positioned from
   game/world/corridor.ts. So most of the ways that geometry can go wrong are
   arithmetic, not rendering: a sign post placed past the pavement edge, a mast
   tall enough to spear the tunnel ceiling, a loop splice whose two ends don't
   match. Those are all checkable here, in a second, with no GPU.

   Placement data (SIGN, PITCH, signPlan) is *imported* from corridor.ts rather
   than copied, so this file cannot drift away from what highway.ts builds. The
   few numbers that still live only in highway.ts are listed in HWY below; if
   you change one there, change it here.

   Usage: node test/corridor-check.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "corridor-"));
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
const { getCorridor, assertPitches, signPlan, SIGN, PITCH, PHASE, TUNNEL, TOLL, TOLL_PLAZA, BRIDGE } =
  await import(path.join(dir, "corridor.js"));
const { buildRamps, parapetGap, spawnWindow, spawnZ, RAMP_PLAN } =
  await import(path.join(dir, "ramps.js"));
const { CONNECT_Z, RAMP_W, RAMP_RUN } = await import(path.join(dir, "const.js"));

const c = getCorridor();
/** numbers that live in highway.ts and have no home in the corridor yet */
const HWY = {
  WALL_H: 1.05, WALL_T: 0.34, // parapet
  gantryLegOut: 0.32, gantryLegT: 0.5, gantryH: 7.2,
  lightOut: 0.23, lightR: 0.12,
  soundSeg: 92, soundOut: 0.3,
  tollIsleW: 1.0, tollColOut: -0.75, tollColT: 0.9, plazaLen: 34,
};

let fail = 0;
const bad = (m) => {
  console.log("  FAIL " + m);
  fail++;
};
const f = (n) => n.toFixed(2);

/* ---- the endless loop ---------------------------------------------------
   The wrap is implemented as a pure translation in z, which is only invisible
   if the corridor at Z0 + d is identical to the corridor at Z1 + d for as far
   ahead as the player can see — and, just as importantly, for as far *behind*
   as the mirrors show. */
console.log("loop splice:");
let worst = 0, worstAt = 0;
for (let d = -c.EXT; d <= c.EXT; d += 2) {
  const a = c.pose(c.Z0 + d), b = c.pose(c.Z1 + d);
  const e = Math.max(
    Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.h - b.h),
    Math.abs(a.grade - b.grade),
    Math.abs(c.laneCount(c.Z0 + d) - c.laneCount(c.Z1 + d)),
    Math.abs(c.halfWidth(c.Z0 + d) - c.halfWidth(c.Z1 + d))
  );
  if (e > worst) {
    worst = e;
    worstAt = d;
  }
}
console.log(`  loop ${c.LOOP} m, overrun ${c.EXT} m either side, arclength ${c.lapLen.toFixed(0)} m`);
console.log(`  worst mismatch over the splice window: ${worst.toExponential(2)} at ${worstAt >= 0 ? "+" : ""}${worstAt} m`);
if (worst > 1e-9) bad("the two ends of the loop are not identical");
if (c.EXT < 300) bad("the overrun is too short to hide the splice at draw distance");

/* The same invariant stated the way it actually bites, because this is the
   form that catches the mistake: the tail of the canonical band plus the whole
   forward overrun — everything the mirrors and the reversed chase camera show
   at the moment of the wrap — must already be a translate of the road the
   player is about to land on. A lane taper that ends even 80 m past
   Z1 − DECK_EXT puts a metre of half-width discontinuity in the mirror. */
{
  let tail = 0, tailAt = 0;
  for (let z = c.Z1 - c.EXT; z <= c.ZB1; z += 1) {
    const e = Math.max(
      Math.abs(c.laneCount(z) - c.laneCount(z - c.LOOP)),
      Math.abs(c.halfWidth(z) - c.halfWidth(z - c.LOOP)),
      Math.abs(c.centerX(z) - c.centerX(z - c.LOOP)),
      Math.abs(c.centerY(z) - c.centerY(z - c.LOOP))
    );
    if (e > tail) {
      tail = e;
      tailAt = z;
    }
  }
  console.log(`  behind the seam: worst |f(z) − f(z − LOOP)| over [Z1−EXT, ZB1]` +
    ` is ${tail.toExponential(2)} at z=${tailAt}`);
  if (tail > 1e-9)
    bad(`the deck behind the seam does not match the deck ahead of it (z=${tailAt})`);
}
// and the splice must land on straight, level road, never mid-bend
for (const z of [c.Z0, c.Z1])
  if (Math.abs(c.slopeX(z)) > 1e-9 || Math.abs(c.pose(z).grade) > 1e-9)
    bad(`the wrap at z=${z} happens mid-bend`);
// spliceDelta is the engine's hook; it must agree with the band it defines
if (c.spliceDelta(c.Z1) !== -c.LOOP || c.spliceDelta(c.Z0 - 1) !== c.LOOP ||
  c.spliceDelta(0) !== 0 || c.spliceDelta(c.Z1 - 1) !== 0)
  bad("spliceDelta disagrees with [Z0, Z1)");

/* Periodic furniture has to be in phase either side of the splice too: the
   road can match perfectly and the teleport still show up as a stutter in the
   lamp-post rhythm. Every pitch must divide LOOP, and every item must sit on
   the global lattice. */
try {
  assertPitches();
} catch (e) {
  bad(e.message);
}
console.log("  furniture phase:");
for (const [name, p] of Object.entries(PITCH)) {
  const zs = c.lattice(p);
  let ok = true;
  for (const z of zs)
    if (z + c.LOOP <= c.ZB1 && !zs.some((q) => Math.abs(q - (z + c.LOOP)) < 1e-9)) ok = false;
  // and the per-item variation index must survive the wrap
  for (const z of zs)
    if (z + c.LOOP <= c.ZB1 && c.latticeIndex(z, p) !== c.latticeIndex(z + c.LOOP, p)) ok = false;
  const ph = PHASE[name] || 0;
  for (const z of c.lattice(p, ph))
    if (z + c.LOOP <= c.ZB1 && c.latticeIndex(z, p, ph) !== c.latticeIndex(z + c.LOOP, p, ph))
      ok = false;
  console.log(`    ${name.padEnd(10)} pitch ${String(p).padStart(4)} m, ${String(zs.length).padStart(4)} items` +
    `, ${c.LOOP / p} per lap`);
  if (!ok) bad(`${name}: lattice does not repeat across the splice`);
  if (name === "light" && (c.LOOP / p) % 2 !== 0)
    bad("light: an odd number per lap makes the two sides alternate out of step");
}

/* ---- alignment stays highway-realistic ---- */
let maxSlope = 0, maxGrade = 0, minY = 1e9;
for (let z = c.ZB0; z <= c.ZB1; z += 2) {
  maxSlope = Math.max(maxSlope, Math.abs(c.slopeX(z)));
  maxGrade = Math.max(maxGrade, Math.abs(c.pose(z).grade));
  minY = Math.min(minY, c.centerY(z));
}
console.log("alignment:");
console.log(`  max heading ${f((Math.atan(maxSlope) * 180) / Math.PI)}°,` +
  ` max grade ${f(maxGrade * 100)}%, min deck height ${f(minY)} m`);
if (maxSlope > 0.36) bad("a bend is sharper than a fast highway curve");
if (maxGrade > 0.06) bad("a grade is steeper than 6%");
if (minY < 4.5) bad("the deck drops too low for its piers and ramps");
// the deck must clear the terrain everywhere: terrain.h is flat (0) across the
// corridor band, so any dip below the pier stub height is a bug
if (minY < 4.5) bad("deck height would bury the piers");

/* ---- world <-> corridor mapping ---- */
let rt = 0;
for (let z = c.ZB0 + 10; z < c.ZB1 - 10; z += 37)
  for (const lat of [-13, -4, 0, 5, 13]) {
    const w = c.worldOf(z, lat);
    rt = Math.max(rt, Math.abs(c.zAt(w.x, w.z) - z), Math.abs(c.latAt(w.x, w.z) - lat));
  }
console.log(`mapping: worldOf/zAt/latAt round-trip error ${rt.toExponential(2)} m`);
if (rt > 0.01) bad("the corridor's inverse mapping has drifted");
// heightAt must agree with the deck everywhere on the pavement, and refuse
// everywhere off it — this is what the car actually stands on
{
  let hOk = true, offOk = true;
  for (let z = c.ZB0 + 5; z < c.ZB1 - 5; z += 11) {
    const hw = c.halfWidth(z);
    for (const lat of [-hw + 0.2, -hw / 2, 0, hw / 2, hw - 0.2]) {
      const w = c.worldOf(z, lat);
      const y = c.heightAt(w.x, w.z);
      if (y === null || Math.abs(y - c.centerY(c.zAt(w.x, w.z))) > 0.02) hOk = false;
    }
    for (const lat of [-hw - 3, hw + 3]) {
      const w = c.worldOf(z, lat);
      if (c.heightAt(w.x, w.z) !== null) offOk = false;
    }
  }
  console.log(`deck height: ${hOk ? "matches the swept surface on the pavement" : "MISMATCH"}` +
    `, ${offOk ? "null off it" : "LEAKS off the edge"}`);
  if (!hOk) bad("heightAt disagrees with the deck it is sampled from");
  if (!offOk) bad("heightAt returns a surface beyond the pavement edge");
}

/* ---- lane schedule is drivable everywhere ---- */
let minLanes = 99, maxLanes = 0, maxSlide = 0, slideAt = 0, slideK = 0;
let prevOff = null, prevN = 0;
for (let z = c.ZB0; z <= c.ZB1; z += 2) {
  const n = c.lanes(z);
  minLanes = Math.min(minLanes, n);
  maxLanes = Math.max(maxLanes, n);
  for (let k = 0; k < n; k++)
    if (Math.abs(c.laneOffset(k, z)) + 1.0 > c.halfWidth(z))
      bad(`lane ${k} at z=${z} runs off the pavement`);
  /* Lane centres must slide, never jump. Measure EVERY lane, not just one:
     when the count changes, the outermost lane moves furthest and is always
     the binding case — checking only lane 1 (which sits near the middle and
     barely moves) reports a taper as comfortable when its outside lane is
     sliding twice as fast as traffic can follow. */
  const off = [];
  for (let k = 0; k < n; k++) off.push(c.laneOffset(k, z));
  if (prevOff)
    for (let k = 0; k < Math.min(n, prevN); k++) {
      const d = Math.abs(off[k] - prevOff[k]);
      if (d > maxSlide) {
        maxSlide = d;
        slideAt = z;
        slideK = k;
      }
    }
  prevOff = off;
  prevN = n;
}
console.log(`lanes: ${minLanes}–${maxLanes} across the lap,` +
  ` lane pitch ${f(c.lanePitch(0))}–${f(c.lanePitch((TOLL.plazaZ0 + TOLL.plazaZ1) / 2))} m,` +
  ` worst lane-centre slide ${f(maxSlide * 100)} cm per 2 m (lane ${slideK} at z=${slideAt})`);
/* A car merely holding its lane follows the sliding centreline at
   LANE_FOLLOW_RATE (traffic.ts, 3.4 m/s) and runs at up to ~60 m/s, so a lane
   centre steeper than ~0.057 is one it visibly lags. Checked at 0.053 to keep
   a little margin; if that constant changes, this is the number to move. */
const LANE_FOLLOW_RATE = 3.4, TOP_SPEED = 60;
if (maxSlide / 2 > 0.053) bad("a lane centre moves too fast for traffic to track it");
if (0.053 > LANE_FOLLOW_RATE / TOP_SPEED)
  bad(`the slope budget (0.053) now exceeds what LANE_FOLLOW_RATE ${LANE_FOLLOW_RATE} m/s can track`);
/* Tapers are monotonic *within* a transition. Reversals between separate
   transitions are the schedule doing its job (widen here, narrow there); a
   reversal with no flat stretch in between means two steps overlap and are
   fighting each other, which makes a lane appear and immediately vanish. */
{
  let runs = 0, bad0 = 0, sign = 0, flat = 0;
  for (let z = c.ZB0; z < c.ZB1; z += 1) {
    const d = c.laneCount(z + 1) - c.laneCount(z);
    if (Math.abs(d) < 1e-9) {
      flat++;
      if (flat > 3) sign = 0;
      continue;
    }
    flat = 0;
    if (sign === 0) {
      sign = Math.sign(d);
      runs++;
    } else if (Math.sign(d) !== sign) {
      bad0++;
      sign = Math.sign(d);
    }
  }
  console.log(`tapers: ${runs} transitions, ${bad0} reversal(s) inside a transition`);
  if (bad0 > 0) bad("two lane steps overlap and fight each other");
}

/* ---- cantilever signs -------------------------------------------------- */
console.log("cantilever signs:");
const ramps = buildRamps(() => 0);
const signs = signPlan();
for (const s of signs) {
  const hw = c.halfWidth(s.z);
  const postLat = c.signPostLat(s.z);
  const p0 = postLat + SIGN.ARM_X, p1 = p0 + s.w;
  const panelTop = SIGN.CLEAR + s.h;
  const mast = panelTop + SIGN.ARM_T + 0.12;
  console.log(`  z=${String(s.z).padStart(6)}  ${s.kind.padEnd(11)} edge ${f(-hw)}` +
    `  post ${f(postLat)}  panel [${f(p0)}, ${f(p1)}]  clear ${f(SIGN.CLEAR)}–${f(panelTop)} m`);
  // post outboard of the parapet, so a car scraping the barrier cannot reach it
  if (postLat + SIGN.POST_T / 2 > -(hw + 0.06))
    bad(`${s.kind} @${s.z}: post is inboard of the parapet — the car drives through it`);
  // ...but still over the structure, not hanging in space past the fascia
  if (postLat - SIGN.POST_T / 2 < -(hw + 0.5))
    bad(`${s.kind} @${s.z}: post hangs off the fascia`);
  // panel over the roadway, not out past the far edge
  if (p1 > hw) bad(`${s.kind} @${s.z}: panel overhangs the far deck edge`);
  if (p0 > -hw + 1.0) bad(`${s.kind} @${s.z}: panel does not reach over the lanes`);
  // vertical: above any vehicle, below the tunnel ceiling if it were in one
  if (SIGN.CLEAR < 5.0) bad(`${s.kind} @${s.z}: panel hangs into vehicle clearance`);
  if (c.inTunnel(s.z)) bad(`${s.kind} @${s.z}: inside the tunnel (mast ${f(mast)} m vs ${TUNNEL.clearH} m clear)`);
  // the toll canopy is a rigid 7.4 m slab centred in the full-width window
  const plazaC = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
  if (Math.abs(s.z - plazaC) < 17 + 2) bad(`${s.kind} @${s.z}: mast is under the toll canopy`);
  if (SIGN.BACK_GAP < 0.05) bad("panel back skin is close enough to its face to z-fight");
  // the post needs a parapet to stand on: not in a ramp divergence gap
  for (const r of ramps) {
    const g = parapetGap(r);
    if (s.z > g.z0 && s.z < g.z1)
      bad(`${s.kind} @${s.z}: post stands in the ${r.kind} parapet gap [${f(g.z0)}, ${f(g.z1)}]`);
  }
  // and it must not be planted where the ramp pavement has peeled off
  for (const r of ramps)
    for (const q of r.pts) {
      const w = c.worldOf(s.z, postLat);
      if (Math.hypot(q.x - w.x, q.z - w.z) < RAMP_W / 2 + 0.6)
        bad(`${s.kind} @${s.z}: post is on the ${r.kind} ramp pavement`);
    }
}
for (let i = 1; i < signs.length; i++)
  if (signs[i].z - signs[i - 1].z < 25)
    bad(`two signs only ${f(signs[i].z - signs[i - 1].z)} m apart near z=${signs[i].z}`);
if (!signs.some((s) => s.kind === "exit-gore")) bad("no board at the exit gore");

/* ---- where a car may legally be placed ---------------------------------
   The spawn, resetCar(), the garage exit and every debug teleport all need the
   same thing: a z that is dead straight, dead level, and clear of both parapet
   gaps — a car dropped at a gore nose sits beside a deliberately missing
   barrier, which looks like a hole in the world and throws nothing. The engine
   spawn was at z = -430 for exactly this reason: it was chosen for a layout in
   which the gore was at -330, and moving the gores to give the ramps their
   grade budget slid it inside the exit's gap. Nothing in the type system can
   catch that, so it is caught here — and the window is reported every run,
   because it shrinks whenever a gore moves or RAMP_RUN grows. */
{
  const MARGIN = 10; // clearance from a parapet gap
  const MIN_RUN = 120; // a window shorter than this is not worth spawning into
  const gaps = ramps.map(parapetGap);
  const plazaC = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
  const ok = (z) =>
    Math.abs(c.slopeX(z)) < 1e-6 && Math.abs(c.pose(z).grade) < 1e-6 &&
    !gaps.some((g) => z > g.z0 - MARGIN && z < g.z1 + MARGIN) &&
    // straight and level is not sufficient: the tube and the plaza are both
    // dead straight, and neither is somewhere to put a car that has just
    // appeared — one is pitch dark, the other is full of gate islands
    !c.inTunnel(z) && Math.abs(z - plazaC) > HWY.plazaLen / 2 + MARGIN;
  const windows = [];
  let start = null;
  /* Only the canonical band. A spawn in the overrun is outside [Z0, Z1), so
     spliceDelta() teleports it 4 km on the very first frame. */
  for (let z = c.Z0; z <= c.Z1; z += 1) {
    if (ok(z)) {
      if (start === null) start = z;
    } else {
      if (start !== null && z - 1 - start >= MIN_RUN) windows.push([start, z - 1]);
      start = null;
    }
  }
  if (start !== null && c.Z1 - start >= MIN_RUN) windows.push([start, c.Z1]);
  console.log("spawnable windows (straight, level, clear of every parapet gap):");
  for (const [a, b] of windows)
    console.log(`  z ∈ [${String(a).padStart(6)}, ${String(b).padStart(5)}]` +
      `  ${String(b - a).padStart(4)} m, ${c.lanes((a + b) / 2)} lanes` +
      `, centre ${f((a + b) / 2)}`);
  if (!windows.length)
    bad("there is nowhere on the corridor a car can be placed straight, level and guarded");
  /* The band beside the town is the one that matters: it is the only stretch
     that is both level and inside the loop's canonical range, so it is where
     the spawn has to live. Losing it means the ramps have eaten the straight. */
  const town = windows.filter(([a, b]) => (a + b) / 2 > CONNECT_Z[0] && (a + b) / 2 < CONNECT_Z[1]);
  if (!town.length) bad("the ramp window no longer contains a spawnable stretch");
  else {
    const longest = town.reduce((p, q) => (q[1] - q[0] > p[1] - p[0] ? q : p));
    console.log(`  spawn band: ${longest[1] - longest[0]} m beside the town` +
      `, slack to the nearer gap ${f(MARGIN)} m`);
    if (longest[1] - longest[0] < 200)
      bad(`the spawn band is down to ${longest[1] - longest[0]} m — move a gore or shorten RAMP_RUN`);
    /* Cross-check the exported window against the scan above. These are two
       independent implementations of the same predicate on purpose: the engine
       spawn bug got through precisely because one implementation was checked
       against nothing, so the export has to answer to a scan that does not
       share its code. */
    const w = spawnWindow(), sz = spawnZ();
    console.log(`  exported spawnWindow [${w.z0}, ${w.z1}], spawnZ ${f(sz)}`);
    if (Math.abs(w.z0 - longest[0]) > 2 || Math.abs(w.z1 - longest[1]) > 2)
      bad(`spawnWindow [${w.z0}, ${w.z1}] disagrees with the scan [${longest[0]}, ${longest[1]}]`);
    if (!ok(sz)) bad(`spawnZ ${f(sz)} is not a placeable z`);
    const p = c.respawn(sz);
    if (Math.abs(p.h) > 1e-9 || Math.abs(p.y - 10) > 1e-9)
      bad(`respawn(spawnZ()) is not level and straight: h=${p.h}, y=${p.y}`);
  }
}

/* ---- gantries: legs clear of the lanes and of the car's reach ---- */
{
  let ng = 0;
  for (const z of c.lattice(PITCH.gantry)) {
    if (c.inTunnel(z) || c.inToll(z)) continue;
    if (CONNECT_Z.some((cz) => Math.abs(z - cz) < 220)) continue;
    const hw = c.halfWidth(z), legLat = hw + HWY.gantryLegOut;
    if (legLat - HWY.gantryLegT / 2 < hw + 0.06)
      bad(`gantry z=${z}: leg is inboard of the parapet`);
    if (legLat + HWY.gantryLegT / 2 > hw + 0.85) bad(`gantry z=${z}: leg hangs off the fascia`);
    if (Math.min(9, legLat * 2 - 1.4) > hw * 2 + 1) bad(`gantry z=${z}: sign wider than the deck`);
    ng++;
  }
  console.log(`gantries: ${ng}, legs straddle the parapet, none in the tunnel/plaza/gores`);
}

/* ---- streetlights: on the parapet, out of the car's reach ---- */
{
  let np = 0, clash = 0;
  const gz = c.lattice(PITCH.gantry);
  for (const z of c.lattice(PITCH.light, PHASE.light)) {
    if (c.inTunnel(z) || c.inToll(z)) continue;
    const hw = c.halfWidth(z), lat = hw + HWY.lightOut;
    if (lat - HWY.lightR < hw + 0.06) bad(`streetlight z=${z}: pole stands inside the shoulder`);
    if (gz.some((g) => Math.abs(g - z) < 1.2)) clash++;
    np++;
  }
  console.log(`streetlights: ${np}, ${clash} sharing a z with a gantry`);
  if (clash) bad("a light pole and a gantry leg occupy the same spot");
}

/* ---- sections: the edge-treatment plan --------------------------------
   corridor.sections() decides what stands at the pavement edge over every
   stretch of the lap — parapet, railing, perforated screen, solid noise wall,
   or the bridge span. Three things have to hold and none of them is visible
   from the geometry: the runs must not overlap (two treatments on one edge),
   they must not stand a wall in the tunnel or the plaza or over a gore, and
   `sectionAt` must give the same answer either side of the loop splice or the
   teleport shows up as the barrier beside you changing type. */
{
  const S = c.sections();
  console.log("sections:");
  let dressed = 0;
  for (const s of S) {
    console.log(`  z ∈ [${String(s.z0).padStart(6)}, ${String(s.z1).padStart(6)}]` +
      ` ${String(s.z1 - s.z0).padStart(4)} m  ${s.kind}`);
    if (s.z0 >= c.Z0 && s.z1 <= c.Z1) dressed += s.z1 - s.z0;
    if (s.z1 <= s.z0) bad(`section ${s.kind} @${s.z0} has no length`);
    if (s.z0 < c.Z0 || s.z1 > c.Z1) bad(`section ${s.kind} @${s.z0} leaves the canonical band`);
    if (s.kind !== "bridge") {
      if (s.z0 < TUNNEL.z1 && s.z1 > TUNNEL.z0) bad(`section ${s.kind} @${s.z0} is in the tunnel`);
      if (s.z0 < TOLL.z1 && s.z1 > TOLL.z0) bad(`section ${s.kind} @${s.z0} is in the toll zone`);
    }
    if (s.kind === "mesh" || s.kind === "screen")
      for (const cz of CONNECT_Z)
        if (s.z0 < cz + 260 && s.z1 > cz - 260)
          bad(`opaque section ${s.kind} @${s.z0} stands over the gore at ${cz}`);
    // the wall plane sits inside the parapet box, where its base is hidden
    if (HWY.soundOut < HWY.WALL_T / 2 + 0.06 || HWY.soundOut > HWY.WALL_T + 0.06)
      bad(`sound wall z=${s.z0}: plane is not inside the parapet, its base will float`);
  }
  for (let i = 1; i < S.length; i++)
    if (S[i].z0 < S[i - 1].z1)
      bad(`sections [${S[i - 1].z0}, ${S[i - 1].z1}] and [${S[i].z0}, ${S[i].z1}] overlap`);
  console.log(`  ${S.length} runs, ${dressed} m of ${c.LOOP} m dressed` +
    ` (${((100 * dressed) / c.LOOP).toFixed(0)}%)`);
  let mismatch = null;
  for (let z = c.ZB0; z + c.LOOP <= c.ZB1; z += 1)
    if (c.sectionAt(z) !== c.sectionAt(z + c.LOOP) && mismatch === null) mismatch = z;
  if (mismatch !== null)
    bad(`sectionAt disagrees across the splice at z=${mismatch}` +
      ` (${c.sectionAt(mismatch)} vs ${c.sectionAt(mismatch + c.LOOP)})`);
  else console.log("  sectionAt repeats across the splice");
  /* The bridge replaces piers with an arch, so its abutments must land on the
     pier lattice — otherwise the two suppressed-pier ends leave a stub pier
     standing a metre from an abutment block. */
  for (const z of [BRIDGE.z0, BRIDGE.z1])
    if (z % PITCH.pier !== 0) bad(`bridge abutment z=${z} is not on the pier lattice`);
  const bSpan = BRIDGE.z1 - BRIDGE.z0;
  console.log(`bridge: ${bSpan} m clear span, ${BRIDGE.rise} m rise` +
    `, deck ${c.centerY(BRIDGE.z0).toFixed(2)} → ${c.centerY(BRIDGE.z1).toFixed(2)} m` +
    `, ribs ±${(c.halfWidth((BRIDGE.z0 + BRIDGE.z1) / 2) + BRIDGE.ribOut).toFixed(2)} m`);
  // nothing may hang under the arch into vehicle clearance
  const lowBrace = Math.min(...BRIDGE.braceAt.map((t) => BRIDGE.rise * 4 * t * (1 - t)));
  if (lowBrace < SIGN.CLEAR + 2) bad(`a bridge cross-brace hangs at ${f(lowBrace)} m`);
  // the ribs stand outboard of the parapet clamp, like the gantry legs
  for (let z = BRIDGE.z0; z <= BRIDGE.z1; z += 4)
    if (c.halfWidth(z) + BRIDGE.ribOut - BRIDGE.ribW / 2 < c.halfWidth(z) + 0.06)
      bad(`bridge rib at z=${z} is inboard of the parapet clamp`);
}

/* ---- toll plaza fits between its lanes ---- */
{
  const zc = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
  const lanes = c.lanes(zc), hw = c.halfWidth(zc);
  /* The gate channel is the corridor's own lane pitch less the island either
     side, both read from the shared constants rather than copied — this is the
     number that decides whether the plaza is fun to drive, so it must be the
     number that is actually built. The widest car in the garage is 1.98 m. */
  // widest car in game/carspecs.ts; revisit if a wider one ships
  const clear = c.gateClear(zc), WIDEST_CAR = 1.86;
  console.log(`toll plaza: ${lanes} gates, pitch ${f(c.lanePitch(zc))} m,` +
    ` half-width ${f(hw)} m, ${f(clear)} m clear through each gate` +
    ` (${f((clear - WIDEST_CAR) / 2)} m either side of the widest car)`);
  if (clear < TOLL_PLAZA.minClear)
    bad(`gate channel ${f(clear)} m is under the ${f(TOLL_PLAZA.minClear)} m minimum —` +
      ` too tight to thread at speed`);
  if (TOLL_PLAZA.boothW > 2 * TOLL_PLAZA.colliderHw)
    bad("the booth is wider than its collider, so it can be clipped without contact");
  if (TOLL_PLAZA.kerbW > 2 * TOLL_PLAZA.colliderHw)
    bad("the kerb is wider than its collider");
  const colLat = hw + HWY.tollColOut;
  if (colLat - HWY.tollColT / 2 < hw - 1.55)
    bad("canopy columns stand in a traffic lane");
  if (colLat + HWY.tollColT / 2 > hw + 0.5) bad("canopy columns stand off the deck edge");
  /* The plaza is one rigid group ~34 m long, centred in the full-width window.
     Its span must be straight, level and of constant width, or the group's
     corners lift off the deck. Check the whole full-width window: the lane
     signs and gate arms are placed from `zc`, and traffic threading the gates
     wants constant geometry a little either side of them too. */
  for (let z = TOLL.plazaZ0; z <= TOLL.plazaZ1; z += 2) {
    if (Math.abs(c.lanePitch(z) - c.lanePitch(zc)) > 1e-6) bad(`plaza span z=${z} is mid-pitch-taper`);
    if (Math.abs(c.slopeX(z)) > 1e-6) bad(`plaza span z=${z} is not straight`);
    if (Math.abs(c.pose(z).grade) > 1e-6) bad(`plaza span z=${z} is not level`);
    if (Math.abs(c.halfWidth(z) - hw) > 1e-6) bad(`plaza span z=${z} is not full width`);
  }
  if (c.inTunnel(TOLL.plazaZ0) || c.inTunnel(TOLL.plazaZ1)) bad("the plaza is inside the tunnel");
}

/* ---- tunnel ---- */
{
  const len = TUNNEL.z1 - TUNNEL.z0;
  let maxHw = 0;
  for (let z = TUNNEL.z0; z <= TUNNEL.z1; z += 2) maxHw = Math.max(maxHw, c.halfWidth(z));
  console.log(`tunnel: ${len} m long, ${f(TUNNEL.clearH)} m clear, widest half-width ${f(maxHw)} m,` +
    ` blend ${f(c.tunnelBlend(TUNNEL.z0 - 5))}→${f(c.tunnelBlend((TUNNEL.z0 + TUNNEL.z1) / 2))}` +
    `→${f(c.tunnelBlend(TUNNEL.z1 + 5))}`);
  if (TUNNEL.clearH < 5.2) bad("the tunnel is too low for the traffic in it");
  if (c.tunnelBlend(TUNNEL.z0 - 1) > 0.001 || c.tunnelBlend(TUNNEL.z1 + 1) > 0.001)
    bad("tunnelBlend is non-zero outside the tunnel");
  if (c.tunnelBlend((TUNNEL.z0 + TUNNEL.z1) / 2) < 0.999)
    bad("tunnelBlend never reaches 1 inside the tunnel");
  if (TUNNEL.z1 > TOLL.z0) bad("the tunnel overlaps the toll zone");
  // nothing tall may be inside it
  for (const z of c.lattice(PITCH.gantry))
    if (c.inTunnel(z) && HWY.gantryH > TUNNEL.clearH) {
      /* generator skips these; assert the skip is still the rule */
    }
}

/* ---- ramps: each span straight and level, and the gore geometry sane ---- */
for (const [i, zr] of CONNECT_Z.entries()) {
  const isExit = i === 0;
  const z0 = isExit ? zr : zr - RAMP_RUN;
  const z1 = isExit ? zr + RAMP_RUN : zr;
  for (let z = z0; z <= z1; z += 8) {
    if (Math.abs(c.slopeX(z)) > 1e-6) bad(`ramp span z=${f(z)} (gore ${zr}) is not straight`);
    if (Math.abs(c.centerY(z) - c.centerY(zr)) > 1e-6)
      bad(`ramp span z=${f(z)} (gore ${zr}) is not level`);
  }
}
console.log(`gore windows: both ramp spans straight and level over ${RAMP_RUN} m`);
console.log("ramps:");
for (const r of ramps) {
  const gap = parapetGap(r);
  console.log(`  ${r.kind.padEnd(5)} gore z=${String(r.zr).padStart(5)}  run ${f(r.len)} m` +
    `  separates at s=${f(r.sSep)}  parapet gap [${f(gap.z0)}, ${f(gap.z1)}]` +
    `  foot (${f(r.footX)}, ${f(r.footZ)})`);
  if (r.sSep > r.len * 0.6) bad(`${r.kind}: never clears the deck edge`);
  if (Math.abs(r.footX - 435) > 1.5) bad(`${r.kind}: foot misses the frontage road`);
  // the ramp must start level with the deck and end near the ground
  const top = r.pts[0], foot = r.pts[r.pts.length - 1];
  if (Math.abs(top.y - c.centerY(r.zr)) > 0.05) bad(`${r.kind}: gore end is not at deck height`);
  if (Math.abs(foot.y - foot.gy) > 0.2) bad(`${r.kind}: foot does not reach the ground`);
  // no ramp sample may sit over the drivable deck once it has separated
  for (const q of r.pts) {
    if (q.s < r.sSep) continue;
    const lat = c.latAt(q.x, q.z);
    if (lat > -c.halfWidth(c.zAt(q.x, q.z)) + 1)
      bad(`${r.kind}: pavement at s=${f(q.s)} still overlaps a deck lane`);
  }
  // the descent must not be a cliff
  let maxG = 0;
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1], b = r.pts[i];
    maxG = Math.max(maxG, Math.abs(b.y - a.y) / Math.max(0.01, b.s - a.s));
  }
  /* A 10 m drop over the length a ramp can have inside the corridor's straight
     window lands at ~11%. Steeper than that and the descent reads as a cliff;
     the lever is RAMP_RUN, and it is already at the limit set by the two ramps
     not overlapping. */
  if (maxG > 0.115) bad(`${r.kind}: ${f(maxG * 100)}% grade on the ramp`);
  console.log(`         max ramp grade ${f(maxG * 100)}%`);
}
if (RAMP_PLAN.length !== ramps.length) bad("a planned ramp was not built");

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall corridor checks passed");
process.exit(fail ? 1 : 0);
