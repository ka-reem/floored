/* Browser-free checks on the route graph (game/world/routegraph.ts).

   The graph grows the map from one endless corridor into a small closed graph
   of routes, and almost everything that can go wrong with it is arithmetic:
   a bypass that leaves the deck with a kink, a bridge that decapitates a lamp
   post, a merge gore that overlaps the toll plaza, a loop that quietly stopped
   being a loop. All of that is checkable here in plain node, like
   corridor-check.mjs, whose regression suite this file also re-runs — the
   main loop must stay bit-identical to the pre-graph world.

   Usage: node test/routegraph-check.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "routegraph-"));
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
const { getCorridor, TUNNEL, TOLL } = await import(path.join(dir, "corridor.js"));
const {
  getRouteGraph, DIVERGE_Z, MERGE_Z, BYPASS, MTN,
  MAIN_SEAM_EDGE, BYPASS_EDGE, MOUNTAIN_EDGE,
} = await import(path.join(dir, "routegraph.js"));
const { CONNECT_Z } = await import(path.join(dir, "const.js"));
const { spawnWindow } = await import(path.join(dir, "ramps.js"));

const c = getCorridor();
const g = getRouteGraph();
const by = g.bypass;

let fail = 0;
const bad = (m) => {
  console.log("  FAIL " + m);
  fail++;
};
const f = (n) => n.toFixed(2);

/* numbers that live in highway.ts; keep in sync with corridor-check.mjs HWY */
const HWY = { lightTopAboveDeck: 7.6, gantryTopAboveDeck: 7.2, soundTopAboveDeck: 5.4 };
const FURNITURE_TOP = Math.max(
  HWY.lightTopAboveDeck, HWY.gantryTopAboveDeck, HWY.soundTopAboveDeck,
);

/* ---- 0. main-loop regression -------------------------------------------
   corridor.ts is untouched by the graph, so this can only fail if someone
   starts "growing" it non-additively. Run the whole existing suite. */
console.log("main-loop regression (corridor-check.mjs):");
try {
  const r = execFileSync("node", ["test/corridor-check.mjs"], { encoding: "utf8" });
  const last = r.trim().split("\n").pop();
  console.log("  " + last);
  if (!/all corridor checks passed/.test(last)) bad("corridor-check no longer passes");
} catch (e) {
  bad("corridor-check.mjs failed:\n" + (e.stdout || e.message));
}

/* ---- 1. graph closure ---------------------------------------------------- */
console.log("graph closure:");
try {
  g.assertClosed();
  console.log(`  ${g.nodes.length} nodes, ${g.edges.length} edges — strongly connected, no dead ends`);
} catch (e) {
  bad(e.message);
}
for (const loop of g.loops()) {
  const len = loop.edges.reduce((a, id) => a + g.edge(id).len, 0);
  console.log(`  loop "${loop.name}": ${loop.edges.map((i) => g.edge(i).name).join(" → ")}` +
    `  (${f(len)} m)`);
}
// the two expressway loops share the main/seam edge, so both splice through
// the same z-translation the engine already performs — but only if nothing of
// the bypass leaks into the seam windows the mirrors can see
{
  const lim0 = c.Z0 + c.EXT + 10, lim1 = c.Z1 - c.EXT - 10;
  if (by.zb0 < lim0 || by.zb1 > lim1)
    bad(`bypass geometry [${f(by.zb0)}, ${f(by.zb1)}] leaks into the splice windows` +
      ` (must stay inside [${lim0}, ${lim1}])`);
  else
    console.log(`  bypass z-extent [${f(by.zb0)}, ${f(by.zb1)}] stays clear of both splice windows`);
  // and a car driving it never triggers spliceDelta
  let wraps = 0;
  for (const p of by.stations) if (c.spliceDelta(p.z) !== 0) wraps++;
  if (wraps) bad(`${wraps} bypass stations sit outside the canonical band`);
}

/* ---- 2. the main loop's own edges agree with the corridor ---------------- */
{
  let worst = 0;
  const mainEdges = g.edges.filter((e) => e.kind === "main");
  let total = 0;
  for (const e of mainEdges) {
    total += e.len;
    for (let s = 0; s <= e.len; s += 50) {
      const z = e.zAtS(s);
      const p = e.poseAt(s);
      const q = c.pose(z);
      worst = Math.max(worst, Math.abs(p.x - q.x), Math.abs(p.y - q.y),
        Math.abs(p.h - q.h),
        Math.abs(e.halfWidth(s) - c.halfWidth(z)),
        Math.abs(e.laneCount(s) - c.laneCount(z)));
      const s2 = e.sAtZ(z);
      if (s2 === null || Math.abs(s2 - s) > 0.01) worst = Math.max(worst, 1);
    }
  }
  console.log(`main edges: 4 segments, ${f(total)} m total vs corridor lap ${f(c.lapLen)} m,` +
    ` worst delegation error ${worst.toExponential(2)}`);
  if (Math.abs(total - c.lapLen) > 0.5) bad("main edges do not sum to one lap");
  if (worst > 1e-9) bad("a main edge disagrees with the corridor it wraps");
}

/* ---- 3. junction continuity --------------------------------------------- */
console.log("junctions:");
for (const [name, uz, endS] of [
  ["diverge", DIVERGE_Z, 0],
  ["merge", MERGE_Z, null], // the nose sits 8 param-metres before the taper tail
]) {
  const s = endS === null ? by.len - 8 : endS;
  const p = by.poseAt(s);
  const zc = c.zAt(p.x, p.z);
  const latC = c.latAt(p.x, p.z);
  const q = c.pose(zc);
  const dh = Math.abs(p.h - q.h);
  const dy = Math.abs(p.y - c.centerY(zc));
  const edgeGap = Math.abs(latC) - c.halfWidth(zc);
  console.log(`  ${name.padEnd(7)} gore z=${String(uz).padStart(5)}` +
    `  Δh ${dh.toExponential(1)} rad  Δy ${dy.toExponential(1)} m` +
    `  nose ${f(edgeGap)} m off the deck edge  grade Δ ${Math.abs(p.grade - q.grade).toExponential(1)}`);
  if (dh > 2e-3) bad(`${name}: heading discontinuity at the gore`);
  if (dy > 1e-3) bad(`${name}: height discontinuity at the gore`);
  if (Math.abs(p.grade - q.grade) > 2e-3) bad(`${name}: grade discontinuity at the gore`);
  if (edgeGap < 0.3 || edgeGap > 1.2)
    bad(`${name}: gore nose is ${f(edgeGap)} m off the deck edge (want ≈ 0.6)`);
  if (Math.abs(p.bank) > 1e-6) bad(`${name}: banked cross-section at the gore`);
  if (Math.abs(zc - uz) > 6) bad(`${name}: nose landed at main z=${f(zc)}, not ${uz}`);
}
// gore positions must not collide with the world's fixed features
for (const uz of [DIVERGE_Z, MERGE_Z]) {
  if (c.inTunnel(uz)) bad(`gore at z=${uz} is inside the tunnel`);
  if (uz > TOLL.z0 && uz < TOLL.z1) bad(`gore at z=${uz} is inside the toll zone`);
  for (const cz of CONNECT_Z)
    if (Math.abs(uz - cz) < 220) bad(`gore at z=${uz} crowds the town gore at ${cz}`);
}
// ramp-edge junctions: ends at deck height at the gore, at the ground at the foot
for (const id of [5, 7]) {
  const e = g.edge(id);
  const a = e.poseAt(0), b = e.poseAt(e.len);
  const goreEnd = id === 5 ? a : b;
  const footEnd = id === 5 ? b : a;
  if (Math.abs(goreEnd.y - c.centerY(c.zAt(goreEnd.x, goreEnd.z))) > 0.06)
    bad(`${e.name}: gore end is not at deck height`);
  if (Math.abs(footEnd.y) > 0.25) bad(`${e.name}: foot does not reach the ground`);
}

/* ---- 4. bypass alignment quality ---------------------------------------- */
{
  let maxG = 0, maxGAt = 0, maxBank = 0, minR = 1e9, minRAt = 0, maxTurn = 0;
  let yMin = 1e9, yMax = -1e9;
  const st = by.stations;
  for (let i = 0; i < st.length; i++) {
    const p = st[i];
    if (Math.abs(p.grade) > maxG) {
      maxG = Math.abs(p.grade);
      maxGAt = p.z;
    }
    maxBank = Math.max(maxBank, Math.abs(p.bank));
    yMin = Math.min(yMin, p.y);
    yMax = Math.max(yMax, p.y);
    if (i > 0) {
      const a = st[i - 1];
      let dh = Math.atan2(p.tx, p.tz) - Math.atan2(a.tx, a.tz);
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      const ds = Math.max(0.01, p.s - a.s);
      maxTurn = Math.max(maxTurn, Math.abs(dh));
      const k = Math.abs(dh) / ds;
      if (k > 1e-6 && 1 / k < minR) {
        minR = 1 / k;
        minRAt = p.z;
      }
    }
  }
  console.log(`bypass: ${f(by.len)} m (main route covers ${MERGE_Z - DIVERGE_Z} m of z),` +
    ` elevation ${f(yMin)}–${f(yMax)} m`);
  console.log(`  max grade ${f(maxG * 100)}% at z=${f(maxGAt)}, min radius ${f(minR)} m at z=${f(minRAt)},` +
    ` max bank slope ${f(maxBank * 100)}%, max turn/station ${f((maxTurn * 180) / Math.PI)}°`);
  if (maxG > 0.06) bad(`bypass grade ${f(maxG * 100)}% is steeper than 6%`);
  if (minR < 60) bad(`bypass curve radius ${f(minR)} m is under 60 m`);
  if (maxBank > 0.085) bad("bypass superelevation exceeds 8.5%");
  if (maxTurn > 0.09) bad("a station-to-station heading step exceeds ~5° — kink");
  if (yMax - 10 < 8) bad("the bypass never climbs high enough to read as a viaduct");
  // lanes must stay on the pavement wherever the full width is open
  for (const p of st) {
    if (p.hwL < BYPASS.half - 0.01 || p.hwR < BYPASS.half - 0.01) continue;
    for (let k = 0; k < BYPASS.lanes; k++) {
      const off = (k - (BYPASS.lanes - 1) / 2) * 3.7;
      if (Math.abs(off) + 1.0 > Math.min(p.hwL, p.hwR) + 0.01)
        bad(`bypass lane ${k} runs off the pavement at s=${f(p.s)}`);
    }
  }
}

/* ---- 5. bypass vs the main route: over it, beside it, never through it --- */
{
  let touching = 0, flying = 0, limbo = 0, limboAt = 0;
  for (const p of by.stations) {
    const zc = c.zAt(p.x, p.z);
    const latC = c.latAt(p.x, p.z);
    const hw = c.halfWidth(zc);
    if (Math.abs(latC) > hw + BYPASS.half + 1) continue;
    const dy = p.y - c.centerY(zc);
    if (dy <= 0.4) {
      touching++;
      /* side-by-side: the clip must keep the pavements meeting at the deck
         edge, never overlapping — the centre itself stays outside the deck */
      if (Math.abs(latC) < hw - 0.05)
        bad(`bypass centre inside the deck at deck level (z=${f(zc)})`);
      const inner = latC < 0 ? p.hwL : p.hwR;
      if (Math.abs(latC) - inner < hw - 0.06)
        bad(`bypass pavement overlaps the deck at z=${f(zc)}`);
    } else if (dy >= BYPASS.minClear + BYPASS.deckT - 0.2) {
      flying++;
    } else {
      limbo++;
      limboAt = zc;
    }
  }
  console.log(`deck interaction: ${touching} stations side-by-side, ${flying} flying over,` +
    ` ${limbo} in between`);
  if (limbo)
    bad(`bypass passes the deck at an unusable height near z=${f(limboAt)}` +
      ` (neither beside it nor clearing it)`);
}

/* ---- 6. the bridge crossing --------------------------------------------- */
console.log("bridge crossings:");
if (!g.crossings.length) bad("the bypass never crosses over the main route");
for (const cr of g.crossings) {
  console.log(`  over main z ∈ [${f(cr.z0)}, ${f(cr.z1)}], centre at z=${f(cr.zMid)}` +
    ` (bypass s=${f(cr.sMid)}): deck ${f(cr.mainY)} m, bridge ${f(cr.bridgeY)} m,` +
    ` min clear ${f(cr.minClear)} m`);
  if (cr.minClear < BYPASS.minClear)
    bad(`bridge clearance ${f(cr.minClear)} m is under the ${BYPASS.minClear} m minimum`);
  if (c.inTunnel(cr.zMid)) bad("the crossing sits over the tunnel, not over open deck");
  if (cr.zMid > TOLL.z0 && cr.zMid < TOLL.z1) bad("the crossing sits over the toll plaza");
  /* deck furniture under the shadow: nothing the corridor plants there may
     reach the underside. The tallest furniture tops out FURNITURE_TOP above
     the deck (lights 7.6, gantries 7.2 — corridor-check's HWY numbers). */
  for (let z = cr.z0 - 2; z <= cr.z1 + 2; z += 1) {
    const top = c.centerY(z) + FURNITURE_TOP;
    const under = cr.bridgeY - BYPASS.deckT;
    if (top > under - 0.8) {
      bad(`furniture at z=${f(z)} could reach within 0.8 m of the bridge underside`);
      break;
    }
  }
}

/* ---- 7. surfaceAt: physics sees the bypass and only the bypass ----------- */
{
  // along every lane centre, the surface must answer and agree with stations
  let worst = 0;
  for (let s = 4; s < by.len - 4; s += 8) {
    for (let k = 0; k < BYPASS.lanes; k++) {
      const { hwL, hwR } = by.halfWidths(s);
      const off = by.laneOffset(k, s);
      if (off > hwL - 1 || off < -(hwR - 1)) continue; // gore taper
      const w = by.worldOf(s, off);
      const hit = g.surfaceAt(w.x, w.z, 0.5);
      if (!hit) {
        bad(`surfaceAt is null on the bypass lane ${k} centre at s=${f(s)}`);
        continue;
      }
      worst = Math.max(worst, Math.abs(hit.y - w.y));
    }
  }
  console.log(`surfaceAt: lane-centre agreement worst ${worst.toExponential(2)} m`);
  if (worst > 0.15) bad("surfaceAt disagrees with the swept bypass surface");

  /* it must NOT shadow the main deck: anywhere on the main pavement the query
     either misses or answers a bridge high overhead — never a near-deck value
     that terrain.heightAt's refY gate could snap a deck car onto */
  let leaks = 0;
  for (let z = c.Z0; z < c.Z1; z += 17) {
    const hw = c.halfWidth(z);
    for (const lat of [-hw + 0.4, 0, hw - 0.4]) {
      const w = c.worldOf(z, lat);
      const hit = g.surfaceAt(w.x, w.z, 0.0);
      if (hit && Math.abs(hit.y - w.y) < 4) leaks++;
    }
  }
  console.log(`  main-deck shadow test: ${leaks} near-deck answers over the pavement`);
  if (leaks) bad("surfaceAt answers at deck height over the main pavement");

  // and the town streets below the viaduct stay untouched: any answer under
  // 6 m of altitude must be at the gores where the bypass IS at deck level
  let low = 0;
  for (const p of by.stations)
    if (p.y < 6 && p.z > DIVERGE_Z + 60 && p.z < MERGE_Z - 60) low++;
  if (low) bad("the bypass dips below 6 m mid-route (over live streets)");
}

/* ---- 8. piers and clear spans ------------------------------------------- */
{
  const { piers, spans } = g.piers(() => 0);
  console.log(`piers: ${piers.length} at ${BYPASS.pierEvery} m spacing, ${spans.length} clear span(s)`);
  if (!spans.length) bad("no clear span recorded where the bridge crosses the deck");
  for (const p of piers) {
    if (c.heightAt(p.x, p.z, 1.5) !== null)
      bad(`pier at (${f(p.x)}, ${f(p.z)}) stands on the main pavement`);
    if (p.topY < 2) bad(`pier at s=${f(p.s)} has no height to hold`);
  }
  // piers must also stay off the west frontage ramps' pavement
  for (const p of piers)
    for (const r of g.ramps)
      if (p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1)
        for (const q of r.pts)
          if (Math.hypot(q.x - p.x, q.z - p.z) < 6)
            bad(`pier at (${f(p.x)}, ${f(p.z)}) stands on the ${r.kind} ramp`);
}

/* ---- 9. the spawn band and the town loop survive ------------------------- */
{
  const w = spawnWindow();
  console.log(`spawn window: [${w.z0}, ${w.z1}] (${w.z1 - w.z0} m)`);
  if (w.z1 - w.z0 < 200) bad("the spawn band shrank below 200 m");
  const gaps = g.newParapetGaps();
  for (const gp of gaps) {
    console.log(`  new parapet gap: z ∈ [${f(gp.z0)}, ${f(gp.z1)}] on the ${gp.side > 0 ? "east" : "west"} side`);
    if (gp.z1 - gp.z0 < 20 || gp.z1 - gp.z0 > 260)
      bad(`parapet gap [${f(gp.z0)}, ${f(gp.z1)}] has an implausible length`);
    if (gp.z0 < w.z1 && gp.z1 > w.z0) bad("a new parapet gap overlaps the spawn band");
    if (gp.z0 < TUNNEL.z1 && gp.z1 > TUNNEL.z0) bad("a new parapet gap overlaps the tunnel");
  }
  const mw = g.mergeWindow();
  console.log(`  merge window: bypass s ∈ [${f(mw.s0)}, ${f(mw.s1)}]` +
    ` (${f(mw.s1 - mw.s0)} m at deck level beside the fast lane)`);
  if (mw.s1 - mw.s0 < 40) bad("the merge window is too short to change lanes in");
}

/* ---- 10. graph queries the consumers will lean on ------------------------ */
{
  const nj = g.nextJunctionOnMain(100);
  if (nj.node.name !== "bypass-diverge" || Math.abs(nj.dz - 400) > 1)
    bad(`nextJunctionOnMain(100) → ${nj.node.name} at ${f(nj.dz)} m (want bypass-diverge at 400)`);
  // past the bypass merge the next junction is now the mtn diverge, just
  // across the seam; the exit gore comes two junctions later
  const nj2 = g.nextJunctionOnMain(1700);
  if (nj2.node.name !== "mtn-diverge") bad(`nextJunctionOnMain(1700) → ${nj2.node.name}`);
  const nj3 = g.nextJunctionOnMain(MTN.mergeZ + 10);
  if (nj3.node.name !== "exit-gore") bad(`nextJunctionOnMain(past mtn merge) → ${nj3.node.name}`);
  const nx = g.nextEdges(2).map((e) => e.name).sort();
  if (nx.join() !== "bypass,main/tunnel-toll")
    bad(`nextEdges(main/climb) → [${nx}] — the diverge should offer exactly two ways on`);
  const nxm = g.nextEdges(MAIN_SEAM_EDGE).map((e) => e.name).sort();
  if (nxm.join() !== "main/pass-window,mountain")
    bad(`nextEdges(main/seam) → [${nxm}] — the mtn diverge should offer exactly two ways on`);
  const seam = g.edge(MAIN_SEAM_EDGE);
  const zw = seam.zAtS(seam.len - 1);
  if (Math.abs(c.deltaZ(zw, MTN.divergeZ)) > 2)
    bad("the seam edge does not end at the mtn diverge");
  if (g.edge(MOUNTAIN_EDGE) !== g.mtn) bad("MOUNTAIN_EDGE points at the wrong edge");
  const pl = g.polylines();
  if (pl.length !== g.edges.length || pl.some((p) => p.pts.length < 6))
    bad("polylines() is missing an edge");
  if (g.edge(BYPASS_EDGE) !== by) bad("BYPASS_EDGE points at the wrong edge");
}

/* ---- 11. the mountain road (corridor.MTN, EXIT 4) ------------------------
   Same battery the bypass gets — junction continuity, alignment quality,
   surface attachment — plus the two disciplines this road specifically signed
   up for: the splice-copy rule (it lives inside the south splice window, so
   everything of it must fit a z+LOOP copy inside the built extent and never
   cross Z0), and the two-way fiction (both lane centres on pavement the whole
   way, a lay-by pocket for the oncoming stream to die in). */
{
  const mt = g.mtn;
  console.log("mountain road:");

  // splice-copy discipline
  if (mt.zb0 < c.Z0 + 4)
    bad(`mtn geometry reaches z=${f(mt.zb0)} — a car there would trip spliceDelta`);
  if (mt.zb1 > c.Z0 + c.EXT)
    bad(`mtn geometry ends at z=${f(mt.zb1)} — its +LOOP copy would overrun ZB1` +
      ` (must stay ≤ ${c.Z0 + c.EXT})`);
  else
    console.log(`  z-extent [${f(mt.zb0)}, ${f(mt.zb1)}]: never crosses Z0,` +
      ` +LOOP copy fits the built extent`);
  let wraps = 0;
  for (const p of mt.stations) if (c.spliceDelta(p.z) !== 0) wraps++;
  if (wraps) bad(`${wraps} mtn stations sit outside the canonical band`);
  // the strip is bounded by the river's near bank (scenery.ts riprap)
  if (mt.x1 > MTN.xMax)
    bad(`mtn pavement reaches x=${f(mt.x1)} — into the river bank (max ${MTN.xMax})`);
  else console.log(`  east reach x=${f(mt.x1)} stays off the river bank (${MTN.xMax})`);

  // junction continuity at both gores
  for (const [name, uz, s] of [
    ["diverge", MTN.divergeZ, 0],
    ["merge", MTN.mergeZ, mt.len - 8],
  ]) {
    const p = mt.poseAt(s);
    const zc = c.zAt(p.x, p.z);
    const q = c.pose(zc);
    const dh = Math.abs(p.h - q.h);
    const dy = Math.abs(p.y - c.centerY(zc));
    const edgeGap = Math.abs(c.latAt(p.x, p.z)) - c.halfWidth(zc);
    console.log(`  ${name.padEnd(7)} gore z=${String(uz).padStart(6)}` +
      `  Δh ${dh.toExponential(1)} rad  Δy ${dy.toExponential(1)} m` +
      `  nose ${f(edgeGap)} m off the deck edge`);
    if (dh > 2e-3) bad(`mtn ${name}: heading discontinuity at the gore`);
    if (dy > 1e-3) bad(`mtn ${name}: height discontinuity at the gore`);
    if (Math.abs(p.grade - q.grade) > 2e-3) bad(`mtn ${name}: grade discontinuity`);
    if (edgeGap < 0.3 || edgeGap > 1.2)
      bad(`mtn ${name}: gore nose is ${f(edgeGap)} m off the deck edge (want ≈ 0.6)`);
    if (Math.abs(p.bank) > 1e-6) bad(`mtn ${name}: banked cross-section at the gore`);
    if (Math.abs(zc - uz) > 6) bad(`mtn ${name}: nose landed at z=${f(zc)}, not ${uz}`);
    if (c.inTunnel(uz, 30)) bad(`mtn ${name} gore is inside a tunnel`);
    if (c.laneCount(uz) !== 3 || Math.abs(c.slopeX(uz)) > 1e-9)
      bad(`mtn ${name} gore is not on the straight three-lane splice-band deck`);
  }

  // alignment quality: this is a pass, so the budgets differ from the
  // bypass's on purpose — tighter corners and steeper grades are the point,
  // but they still have to be drivable and kink-free
  {
    let maxG = 0, maxGAt = 0, maxBank = 0, minR = 1e9, minRAt = 0, maxTurn = 0;
    let yMin = 1e9, yMax = -1e9;
    const st = mt.stations;
    for (let i = 1; i < st.length; i++) {
      const p = st[i], a = st[i - 1];
      if (Math.abs(p.grade) > maxG) {
        maxG = Math.abs(p.grade);
        maxGAt = p.z;
      }
      maxBank = Math.max(maxBank, Math.abs(p.bank));
      yMin = Math.min(yMin, p.y);
      yMax = Math.max(yMax, p.y);
      let dh = Math.atan2(p.tx, p.tz) - Math.atan2(a.tx, a.tz);
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      const ds = Math.max(0.01, p.s - a.s);
      maxTurn = Math.max(maxTurn, Math.abs(dh));
      const k = Math.abs(dh) / ds;
      if (k > 1e-6 && 1 / k < minR) {
        minR = 1 / k;
        minRAt = p.z;
      }
    }
    console.log(`  ${f(mt.len)} m of road over ${MTN.mergeZ - MTN.divergeZ} m of deck,` +
      ` elevation ${f(yMin)}–${f(yMax)} m`);
    console.log(`  max grade ${f(maxG * 100)}% at z=${f(maxGAt)}, min radius ${f(minR)} m` +
      ` at z=${f(minRAt)}, max bank ${f(maxBank * 100)}%,` +
      ` max turn/station ${f((maxTurn * 180) / Math.PI)}°`);
    /* A real alternate route, not a service road shadowing the deck. The
       bar was ≥ 28% extra road, which the old meander bought with a 13 m
       hairpin. The 2026-09-08 rebuild spends that budget the other way —
       radius instead of length — and inside a fixed 332 m z window the two
       genuinely trade against each other, so this came down to 8% with the
       owner's decision, not around it. Anything at or below 1.0 would mean
       the pass is a SHORTCUT, which would make the deck pointless. */
    if (mt.len < (MTN.mergeZ - MTN.divergeZ) * 1.08)
      bad("the pass is barely longer than the deck it bypasses — not a detour");
    if (maxG > 0.09) bad(`mtn grade ${f(maxG * 100)}% is steeper than 9%`);
    /* The radius band IS the owner's brief, in numbers. The floor was 13 m
       (drivable at all); it is now 55 m, because "so hard to drive, road is
       too tight" is a defect report against anything tighter. The ceiling
       stops the sweeper being flattened into a straight by some later tidy-
       up — at 160 m there is no corner left to drive. */
    if (minR < 55) bad(`mtn corner radius ${f(minR)} m is under 55 m — too tight to drive fast`);
    if (minR > 160) bad(`mtn min radius ${f(minR)} m — the sweeper has gone straight`);
    if (maxBank > 0.065) bad("mtn superelevation exceeds 6.5%");
    if (maxTurn > 0.11) bad("a mtn station-to-station heading step exceeds ~6.3° — kink");
    if (yMax - 10 < 4) bad("the pass never climbs high enough to read as a climb");
  }

  /* ONE-WAY, ONE LANE. The lane centre (there is only one, and it is the
     road's own centreline) stays on pavement wherever the width is fully
     open, the running road is honestly narrow for a single lane, and the
     turnout — the repurposed lay-by — really opens. */
  {
    if (MTN.lanes !== 1) bad(`MTN.lanes is ${MTN.lanes} — the pass is a single lane`);
    if (Math.abs(mt.laneOffset(0, 100)) > 1e-9)
      bad("the single lane is not on the road's centreline");
    const running = 2 * MTN.half;
    /* Width floor raised from 4.4 to 9.0 with the rebuild: "make it wide" was
       half the brief, and the pass reads as a goat track below that. The
       ceiling is what stops it drifting into a second deck. */
    if (running > 13) bad(`the running road is ${f(running)} m wide — that is a second deck`);
    if (running < 9) bad(`the running road is ${f(running)} m wide — too narrow for a sweeper`);
    let turnoutMax = 0;
    for (const p of mt.stations) {
      turnoutMax = Math.max(turnoutMax, p.hwL - MTN.half);
      if (p.hwL < MTN.half - 0.01 || p.hwR < MTN.half - 0.01) continue;
      for (let k = 0; k < MTN.lanes; k++) {
        const off = mt.laneOffset(k, p.s);
        if (off > p.hwL - 0.9 || off < -(p.hwR - 0.9))
          bad(`a mtn lane centre runs off the pavement at s=${f(p.s)}`);
      }
    }
    console.log(`  one lane, ${f(running)} m of running road; turnout pocket:` +
      ` +${f(turnoutMax)} m over s ∈ [${MTN.turnoutS0}, ${MTN.turnoutS1}]` +
      ` (${f(running + turnoutMax)} m across there)`);
    if (turnoutMax < MTN.turnoutW - 0.15) bad("the turnout never opens");
    /* it is not a trap: the turnout has to be wide enough to turn a car
       round in, which is this road's answer to a player who U-turns */
    if (running + turnoutMax < 9)
      bad("the turnout is too narrow to come about in — a one-way road needs one place that is");
    const mw = g.mergeWindow(mt);
    console.log(`  merge window: s ∈ [${f(mw.s0)}, ${f(mw.s1)}] (${f(mw.s1 - mw.s0)} m)`);
    if (mw.s1 - mw.s0 < 25) bad("the mtn merge window is too short");
    if (mw.s0 < mt.len / 2) bad("the mtn merge window reaches back past mid-route");
  }

  // surface attachment along the lane centre and both edges (the physics path)
  {
    let worst = 0, misses = 0;
    for (let s = 4; s < mt.len - 4; s += 5) {
      const { hwL, hwR } = mt.halfWidths(s);
      for (const off of [0, MTN.laneW / 2 - 0.4, -(MTN.laneW / 2 - 0.4)]) {
        if (off > hwL - 1 || off < -(hwR - 1)) continue;
        const w = mt.worldOf(s, off);
        const hit = g.surfaceAt(w.x, w.z, 0.5);
        if (!hit) {
          misses++;
          continue;
        }
        if (hit.edgeId !== MOUNTAIN_EDGE)
          bad(`surfaceAt answered edge ${hit.edgeId} on the mtn at s=${f(s)}`);
        worst = Math.max(worst, Math.abs(hit.y - w.y));
      }
    }
    console.log(`  surfaceAt: lane-centre agreement worst ${worst.toExponential(2)} m,` +
      ` ${misses} misses`);
    if (misses) bad(`surfaceAt is null at ${misses} mtn lane-centre samples`);
    if (worst > 0.15) bad("surfaceAt disagrees with the swept mtn surface");
    // and the deck near both gores still answers as deck, not as mtn pavement
    let leaks = 0;
    for (let z = MTN.divergeZ - 60; z < MTN.mergeZ + 60; z += 3) {
      const hw = c.halfWidth(z);
      for (const lat of [-hw + 0.4, 0, hw - 0.4]) {
        const w = c.worldOf(z, lat);
        const hit = g.surfaceAt(w.x, w.z, 0.0);
        if (hit && hit.edgeId === MOUNTAIN_EDGE && Math.abs(hit.y - w.y) < 4) leaks++;
      }
    }
    /* the shared gore wedges legitimately answer right AT the deck edge; a
       leak is an answer over the deck's own lanes */
    if (leaks) bad(`surfaceAt answers ${leaks} times over the deck lanes near the mtn gores`);
    else console.log("  deck lanes near both gores stay the corridor's own surface");
  }

  // the mtn parapet gaps stay inside the splice window and clear the gantry
  // lattice (PITCH.gantry = 500 puts masts at -2000 and -1500)
  for (const gp of g.newParapetGaps().slice(2)) {
    if (gp.side !== 1) bad("a mtn parapet gap is not on the east side");
    if (gp.z0 < c.Z0 || gp.z1 > c.Z0 + c.EXT)
      bad(`mtn parapet gap [${f(gp.z0)}, ${f(gp.z1)}] leaves the splice window`);
    for (const gz of [-2000, -1500])
      if (gp.z0 < gz + 3 && gp.z1 > gz - 3)
        bad(`mtn parapet gap [${f(gp.z0)}, ${f(gp.z1)}] swallows the gantry at ${gz}`);
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall routegraph checks passed");
process.exit(fail ? 1 : 0);
