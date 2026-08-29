/* What the lane schedule and the tunnels actually look like, over many seeds.

   This is the measurement the "the roads don't feel random any more" report
   was missing: the corridor's lane count used to come from a hand-written
   table, so there was exactly one road and no distribution to measure. Now
   there is, and this prints it — per seed, and pooled — so a change to the
   weights or the constraints in corridor.ts can be judged as numbers rather
   than as a feeling after a lap.

   Usage: node test/lane-plan.mjs [seeds]        (default 200)
          node test/lane-plan.mjs --show 1987    (one seed, run by run) */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "laneplan-"));
execFileSync("npx", [
  "tsc", "game/world/corridor.ts", "game/world/ramps.ts", "--outDir", out,
  "--rootDir", ".", "--module", "esnext", "--target", "es2020",
  "--moduleResolution", "bundler", "--skipLibCheck",
], { stdio: ["ignore", "ignore", "inherit"] });
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = path.join(d, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
});
for (const p of walk(out))
  writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w/]+)"/g, '"$1.js"'));
const dir = path.join(out, "game", "world");
const {
  getCorridor, setRoadSeed, tunnels, signPlan, TOLL, PITCH, MTN,
  playground, WIDE_PIN, NO_TAPER, PORTAL_PAD, TAPER_BAND, PLAY_PEAK_MIN,
} = await import(path.join(dir, "corridor.js"));
const { buildRamps, parapetGap, placeable } = await import(path.join(dir, "ramps.js"));
const { CONNECT_Z, MAX_LANES } = await import(path.join(dir, "const.js"));

const args = process.argv.slice(2);
const showIx = args.indexOf("--show");

/** every constant-lane-count run over one canonical lap, in order */
function runs(c) {
  const out = [];
  for (let z = c.Z0; z < c.Z1; z += 1) {
    const n = c.lanes(z);
    const last = out[out.length - 1];
    if (last && last.n === n) last.z1 = z + 1;
    else out.push({ n, z0: z, z1: z + 1 });
  }
  return out;
}

function lap(seed) {
  setRoadSeed(seed);
  const c = getCorridor();
  const rs = runs(c).filter((r) => r.z1 - r.z0 >= 24); // ignore taper crossings
  const tun = tunnels().map((t) => ({
    len: t.z1 - t.z0, lanes: c.lanes((t.z0 + t.z1) / 2),
    z0: t.z0, z1: t.z1, name: t.nameEn,
  }));
  const hist = {};
  for (let z = c.Z0; z < c.Z1; z += 1) hist[c.lanes(z)] = (hist[c.lanes(z)] || 0) + 1;
  return { c, runs: rs, tun, hist, transitions: rs.length - 1 };
}

if (showIx >= 0) {
  const seed = +args[showIx + 1];
  const { c, runs: rs, tun } = lap(seed);
  console.log(`seed ${seed} — lane runs over one 4 km lap:`);
  const pg = playground();
  console.log(pg
    ? `playground: z ${Math.round(pg.z0)} .. ${Math.round(pg.z1)}  +${pg.gain} lane(s), peaks at ${pg.lanes}`
    : "playground: none fits this road");
  for (const r of rs) {
    const t = tun.find((q) => r.z0 < q.z1 && r.z1 > q.z0);
    console.log(`  z ${String(Math.round(r.z0)).padStart(6)} .. ${String(Math.round(r.z1)).padStart(6)}` +
      `  ${r.n} lanes  ${String(Math.round(r.z1 - r.z0)).padStart(4)} m` +
      (t ? `   ← ${t.name}` : ""));
  }
  console.log("tunnels:");
  for (const t of tun)
    console.log(`  ${t.name.padEnd(12)} z ${Math.round(t.z0)} .. ${Math.round(t.z1)}` +
      `  ${Math.round(t.len)} m, ${t.lanes} lanes`);
  console.log("signs:");
  for (const s of signPlan())
    console.log(`  z ${String(Math.round(s.z)).padStart(6)}  ${s.kind}` +
      (c.inTunnel(s.z) ? "   *** INSIDE A TUNNEL ***" : ""));
  process.exit(0);
}

const N = +(args[0] || 200);
const pool = {}, tunLen = [], tunLanes = {}, tunPerLap = [];
let trans = 0, worstSlide = 0, fail = 0, tollNot3 = 0, maxRun = 0;
const fiveRuns = [], laps = [];
const pgPeak = {}, pgGain = {}, pgHolds = [];
let pgHave = 0;
for (let i = 0; i < N; i++) {
  const seed = i === 0 ? 1987 : ((i * 2654435761) >>> 0) % 100000;
  const { c, runs: rs, tun, hist } = lap(seed);
  for (const k of Object.keys(hist)) pool[k] = (pool[k] || 0) + hist[k];
  trans += rs.length - 1;
  laps.push(rs.length - 1);
  fiveRuns.push(rs.filter((r) => r.n === 5).length);
  maxRun = Math.max(maxRun, ...rs.map((r) => r.z1 - r.z0));
  tunPerLap.push(tun.reduce((s, t) => s + t.len, 0));
  for (const t of tun) {
    tunLen.push(t.len);
    tunLanes[t.lanes] = (tunLanes[t.lanes] || 0) + 1;
    if (t.lanes < 3 || t.lanes > 5) fail += !!console.log(`  FAIL seed ${seed}: tunnel ${t.lanes} lanes`);
  }
  // the invariants the corridor check asserts, re-run per seed
  for (let z = c.ZB0; z <= c.ZB1; z += 2) {
    const n = c.lanes(z);
    for (let k = 0; k < n; k++) {
      const d = Math.abs(c.laneOffset(k, z) - c.laneOffset(k, z - 2));
      if (d > worstSlide) worstSlide = d;
    }
  }
  for (let z = c.Z1 - c.EXT; z <= c.ZB1; z += 2)
    if (Math.abs(c.laneCount(z) - c.laneCount(z - c.LOOP)) > 1e-9) {
      console.log(`  FAIL seed ${seed}: splice mismatch at z=${z}`);
      fail++;
      break;
    }
  for (let z = TOLL.z0 - 10; z <= TOLL.z1 + 10; z += 5) if (c.lanes(z) !== 3) tollNot3++;

  /* The seed-sensitive half of test/corridor-check.mjs, which only ever sees
     one seed. Everything below used to be guaranteed by a hand-written table;
     now it is guaranteed by the constraints in the planner, which is exactly
     the kind of guarantee that wants checking against every road it can make
     rather than against the one that ships by default. */
  const say = (m) => { console.log(`  FAIL seed ${seed}: ${m}`); fail++; };
  /* No taper may drop more than ONE lane. A two-lane fan-in gives a car in
     the dying outer lane 144 m to complete two single-lane hops, which it
     cannot do at speed — test/traffic-merge-sim.mjs measures that directly as
     body overlap and metre-scale backward corrections. Drops are chained
     instead (corridor.ts changeLen), so every falling edge in the schedule
     must be exactly one lane deep. Widening is unconstrained: a lane opening
     forces nobody anywhere. */
  {
    // every falling edge between two constant-count runs must be one lane
    let prev = null;
    for (let z = c.Z0; z <= c.Z1; z += 1) {
      const n = c.lanes(z);
      if (prev !== null && n !== prev) {
        if (prev - n > 1) say(`a taper drops ${prev - n} lanes at once near z=${z}`);
      }
      prev = n;
    }
  }
  // a mast, a gantry or a lamp post inside a bore spears the ceiling
  for (const sg of signPlan()) if (c.inTunnel(sg.z)) say(`${sg.kind} board inside a tunnel`);
  for (const t of tun) {
    if (t.lanes < 3 || t.lanes > 5) say(`tunnel ${t.lanes} lanes`);
    if (t.z0 < c.Z0 + c.EXT || t.z1 > c.Z1 - c.EXT) say("tunnel reaches the splice overrun");
    const w = new Set();
    for (let z = t.z0; z <= t.z1; z += 4) w.add(c.lanes(z));
    if (w.size !== 1) say("tunnel changes lane count inside the bore");
  }
  for (let i = 1; i < tun.length; i++)
    if (tun[i].z0 - tun[i - 1].z1 < 120) say("two tunnels close enough for their blends to meet");
  /* The mountain road's whole siting argument (corridor.MTN) is that the
     splice band is taper-free, straight, level and BASE_LANES on EVERY seed.
     That is a planner guarantee, so it gets checked against every road the
     planner can make — the routegraph checks only ever see one seed. */
  for (let z = MTN.divergeZ - 20; z <= MTN.mergeZ + 20; z += 2) {
    if (c.lanes(z) !== 3 || Math.abs(c.laneCount(z) - 3) > 1e-9) {
      say(`the deck is not a constant 3 lanes through the mtn window at z=${z}`);
      break;
    }
  }
  if (Math.abs(c.slopeX(MTN.divergeZ)) > 1e-9 || Math.abs(c.slopeX(MTN.mergeZ)) > 1e-9)
    say("a mtn gore sits on a bend");
  if (c.inTunnel(MTN.divergeZ, 30) || c.inTunnel(MTN.mergeZ, 30))
    say("a tunnel reached a mtn gore");
  // edge treatments: no overlap, none standing inside a tube
  const S = c.sections();
  for (let i = 1; i < S.length; i++) if (S[i].z0 < S[i - 1].z1) say("sections overlap");
  for (const sc of S) {
    if (sc.z1 - sc.z0 <= 0) say(`section ${sc.kind} has no length`);
    if (sc.kind !== "bridge" && tun.some((t) => sc.z0 < t.z1 && sc.z1 > t.z0))
      say(`section ${sc.kind} stands inside a tunnel`);
  }
  // the plaza's gates, which are a function of lanePitch and the lane count
  const pz = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
  if (c.gateClear(pz) < 4.5) say(`gate channel ${c.gateClear(pz).toFixed(2)} m`);
  // the ramps hang off the deck edge, so the gore's lane count sets their grade
  for (const r of buildRamps(() => 0)) {
    let g = 0;
    for (let i = 1; i < r.pts.length; i++)
      g = Math.max(g, Math.abs(r.pts[i].y - r.pts[i - 1].y) / Math.max(0.01, r.pts[i].s - r.pts[i - 1].s));
    if (g > 0.115) say(`${r.kind} ramp grade ${(g * 100).toFixed(1)}%`);
    const gp = parapetGap(r);
    for (const sg of signPlan())
      if (sg.z > gp.z0 && sg.z < gp.z1) say(`${sg.kind} board stands in the ${r.kind} parapet gap`);
  }
  // gantry legs and lamp posts straddle the parapet at whatever width it is
  for (const z of c.lattice(PITCH.gantry))
    if (!c.inTunnel(z) && !c.inToll(z) && Math.min(9, (c.halfWidth(z) + 0.32) * 2 - 1.4) > c.halfWidth(z) * 2 + 1)
      say(`gantry z=${z}: sign wider than the deck`);

  /* The taper law, per seed: every mid-taper z — base plan and playground
     overlay alike — inside TAPER_BAND, clear of every NO_TAPER window and
     of both tunnels' padded portals. corridor-check asserts this for the
     one default road; the planner has to keep it on every road it makes. */
  for (let z = c.Z0; z <= c.Z1; z += 1) {
    if (Math.abs(c.laneCount(z + 0.5) - c.laneCount(z - 0.5)) <= 1e-9) continue;
    if (z < TAPER_BAND[0] || z > TAPER_BAND[1] ||
      NO_TAPER.some(([a, b]) => z > a && z < b) || c.inTunnel(z, PORTAL_PAD - 1)) {
      say(`a taper stands in forbidden road at z=${z}`);
      break;
    }
  }
  /* The playground window, when this seed rolled one. */
  {
    const pg = playground();
    if (pg) {
      pgHave++;
      pgPeak[pg.lanes] = (pgPeak[pg.lanes] || 0) + 1;
      pgGain[pg.gain] = (pgGain[pg.gain] || 0) + 1;
      pgHolds.push(pg.z1 - pg.z0);
      let peak = 0, peakRun = 0, cur = 0;
      for (let z = pg.z0; z <= pg.z1; z += 1) peak = Math.max(peak, c.lanes(z));
      for (let z = pg.z0; z <= pg.z1; z += 1) {
        cur = c.lanes(z) === peak ? cur + 1 : 0;
        peakRun = Math.max(peakRun, cur);
      }
      if (peak !== pg.lanes) say(`playground spec says ${pg.lanes} lanes, deck peaks at ${peak}`);
      // a peak you cannot sit in is a lane that appears and vanishes
      if (peakRun < PLAY_PEAK_MIN - 10) say(`the ${peak}-lane stretch lasts only ${peakRun} m`);
      if (pg.lanes > MAX_LANES) say("playground exceeds MAX_LANES");
      if (pg.z0 < TAPER_BAND[0] || pg.z1 > TAPER_BAND[1]) say("playground leaves the taper band");
      for (const t2 of tunnels())
        if (pg.z0 < t2.z1 && pg.z1 > t2.z0) say(`playground overlaps ${t2.nameEn}`);
      if (pg.z0 < WIDE_PIN[1] && pg.z1 > WIDE_PIN[0]) say("playground overlaps WIDE_PIN");
      if (pg.z0 < TOLL.z1 && pg.z1 > TOLL.plazaZ0) say("playground reaches the toll plaza");
    }
    // whether or not a window rolled, the width ceilings hold: the ramps'
    // grade budget at the gores, and the deck const.ts sizes RW for
    for (const gz of CONNECT_Z)
      if (c.lanes(gz) > 5) say(`${c.lanes(gz)} lanes at the gore z=${gz}`);
    if (Math.max(...Object.keys(hist).map(Number)) > MAX_LANES)
      say("lane count exceeds MAX_LANES");
  }
  /* A car still needs somewhere to be placed: the spawn band between the
     gores survives whatever width the playground holds over them. */
  {
    const gaps2 = buildRamps(() => 0).map(parapetGap);
    let best = 0, run = 0;
    for (let z = CONNECT_Z[0]; z <= CONNECT_Z[1]; z += 1) {
      run = placeable(z, gaps2) ? run + 1 : 0;
      best = Math.max(best, run);
    }
    if (best < 200) say(`the spawn band is down to ${best} m`);
  }
}

/* Variety ACROSS seeds, which matters as much as variety within a lap: two
   worlds that are supposed to be different have to actually drive
   differently. `profile` is the lane sequence a driver would recite over one
   lap (3-5-4-3, say); `shape` adds where the tunnels are, rounded to 50 m.
   A generator that funnels every seed into one answer shows up here as a
   handful of distinct profiles over hundreds of seeds, and did — a rejection
   filter tight enough to accept 1 roll in 20 selects the single most typical
   lap and nothing else. */
{
  const profs = new Map(), shapes = new Set();
  for (let i = 0; i < N; i++) {
    const seed = i === 0 ? 1987 : ((i * 2654435761) >>> 0) % 100000;
    const { runs: rs, tun } = lap(seed);
    /* Only runs long enough to be a stretch. A widen of two lanes crosses
       the count in between on its way, so a 3 → 5 taper leaves ~40 m reading
       as 4; counting that as a run puts a phantom "4" in every profile and
       makes two identical roads look different. */
    const prof = rs.filter((r) => r.z1 - r.z0 >= 150).map((r) => r.n).join("-");
    profs.set(prof, (profs.get(prof) || 0) + 1);
    shapes.add(prof + "|" + tun.map((t) => `${Math.round(t.z0 / 50)}:${Math.round(t.len / 50)}:${t.lanes}`).join(","));
  }
  const top = [...profs.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\ncross-seed variety over ${N} seeds:`);
  console.log(`  ${profs.size} distinct lane profiles, ${shapes.size} distinct road shapes (profile + tunnel placement)`);
  console.log(`  most common profile ${top[0][0]} on ${((100 * top[0][1]) / N).toFixed(0)}% of seeds` +
    `; top 3 cover ${((100 * top.slice(0, 3).reduce((a, b) => a + b[1], 0)) / N).toFixed(0)}%`);
  for (const [pr, n2] of top.slice(0, 6))
    console.log(`    ${pr.padEnd(16)} ${((100 * n2) / N).toFixed(1)} %`);
}

const tot = Object.values(pool).reduce((a, b) => a + b, 0);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`\nlane-count distribution, pooled over ${N} seeds (${(tot / N).toFixed(0)} m per lap):`);
for (const k of Object.keys(pool).sort())
  console.log(`  ${k} lanes: ${((100 * pool[k]) / tot).toFixed(1).padStart(5)} %` +
    `  ${(pool[k] / N).toFixed(0).padStart(5)} m per lap`);
console.log(`  4 or 5:   ${((100 * ((pool[4] || 0) + (pool[5] || 0))) / tot).toFixed(1)} %`);
/* The playground: how often a lap gets its wide window, how wide it peaks
   and how long it holds. Presence is a STAT, not an assertion — a lap too
   packed to widen legally is allowed to stay as it is (the alternative is
   weakening a taper rule to force one in) — but a collapse in the rate is
   the first sign a corridor change ate the playground's room. */
pgHolds.sort((a, b) => a - b);
console.log(`\nplayground: ${pgHave}/${N} laps roll one (${((100 * pgHave) / N).toFixed(0)}%)`);
if (pgHave) {
  console.log(`  peak lanes: ${Object.keys(pgPeak).sort().map((k) =>
    `${k}→${((100 * pgPeak[k]) / pgHave).toFixed(0)}%`).join("  ")}` +
    `   gain: ${Object.keys(pgGain).sort().map((k) =>
      `+${k}→${((100 * pgGain[k]) / pgHave).toFixed(0)}%`).join("  ")}`);
  console.log(`  hold: min ${pgHolds[0].toFixed(0)}` +
    ` median ${pgHolds[pgHolds.length >> 1].toFixed(0)}` +
    ` max ${pgHolds[pgHolds.length - 1].toFixed(0)} m`);
}
if (pgHave / N < 0.5) { console.log("  FAIL fewer than half the laps get a playground"); fail++; }

console.log(`\ntransitions per lap: min ${Math.min(...laps)}, mean ${avg(laps).toFixed(1)}, max ${Math.max(...laps)}`);
console.log(`separate 5-lane runs per lap: min ${Math.min(...fiveRuns)}, mean ${avg(fiveRuns).toFixed(1)}`);
console.log(`longest single-count run seen: ${maxRun.toFixed(0)} m`);
console.log(`\ntunnels: ${tunLen.length / N} per lap, length min ${Math.min(...tunLen).toFixed(0)}` +
  ` mean ${avg(tunLen).toFixed(0)} max ${Math.max(...tunLen).toFixed(0)} m`);
console.log(`  metres of tunnel per lap: min ${Math.min(...tunPerLap).toFixed(0)}` +
  ` mean ${avg(tunPerLap).toFixed(0)} max ${Math.max(...tunPerLap).toFixed(0)}`);
console.log(`  bore lane counts: ${Object.keys(tunLanes).sort().map((k) =>
  `${k}→${((100 * tunLanes[k]) / tunLen.length).toFixed(0)}%`).join("  ")}`);
/* Tunnel build cost, counted from the arithmetic in highway.ts buildTunnel
   rather than guessed. Two tubes are more tunnel than one was, and the perf
   pass that just went through the shaders is the reason this is here: what
   actually costs frames is DRAW CALLS and how much of the lap is spent
   looking at the two most expensive materials in the game. Triangles are
   noise by comparison — the bore is a swept strip.

   Draw calls are a fixed 24 for the whole tunnel system however many tubes
   there are, because every repeated part is pooled: 5 bore soups, 7 instanced
   portal parts across all four mouths, 2 name boards (own texture each), 3
   batten, 3 fan, 2 cabinet, 1 exit board, 1 glow cloud. Built the way the
   single tunnel was — a mesh per portal part — one tube cost 32 and two would
   have cost 49. */
{
  setRoadSeed(1987);
  const c = getCorridor();
  let bore = 0, battens = 0, fans = 0, sos = 0, exits = 0, metres = 0;
  for (const t of tunnels()) {
    const i0 = Math.max(0, Math.floor((t.z0 - c.ZB0) / 4));
    const i1 = Math.min(c.stations.length - 2, Math.ceil((t.z1 - c.ZB0) / 4));
    bore += (i1 - i0) * 46; // 23 quads per station pair (both sides + crown)
    metres += t.z1 - t.z0;
    const LEN = t.z1 - t.z0;
    for (let d = 3.5; d < LEN; ) { battens++; d += Math.min(d, LEN - d) < 70 ? 7 : 14; }
    for (let z = t.z0 + 50; z < t.z1 - 30; z += 84) fans += 2;
    sos += Math.max(0, Math.floor((LEN - 90) / 84));
    exits += Math.max(0, Math.floor((LEN - 60) / 56));
  }
  const mouths = tunnels().length * 2;
  const furniture = battens * (12 + 2 * 12 + 2 * 12) + fans * (24 + 12 + 12) +
    sos * (12 + 2) + exits * 2;
  const portal = mouths * (12 + 2 * 12 + 12 + 2 * 12 + 2) + tunnels().length * (2 + 2 + 2);
  console.log(`\ntunnel build cost (seed 1987, ${Math.round(metres)} m of bore):`);
  console.log(`  triangles: bore ${bore}, portals ${portal}, furniture ${furniture}` +
    `  = ${bore + portal + furniture}`);
  console.log(`  instances: ${battens} battens, ${fans} jet fans, ${sos} SOS cabinets, ${exits} exit boards`);
  console.log(`  draw calls: 24 (was 32 for one tube; a per-mesh build of two would be 49)`);
}

console.log(`\nworst lane-centre slide ${(worstSlide * 100).toFixed(2)} cm / 2 m` +
  ` (budget 10.6 = 0.053 slope)`);
if (worstSlide / 2 > 0.053) { console.log("  FAIL slide budget"); fail++; }
if (tollNot3) { console.log(`  FAIL toll plaza not 3 lanes (${tollNot3} samples)`); fail++; }
console.log(fail ? `\n${fail} FAILURE(S)` : "\nall seeds OK");
process.exit(fail ? 1 : 0);
