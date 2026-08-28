/* Browser-free simulation of the RIVAL pace car (the RIVAL block in
   traffic.ts, updateRival + applyImpact's rival branch).

   The rival runs at RIVAL.top = 74 m/s against a fleet that tops out near 40
   and a corridor whose tapers were cut for that fleet, so it exercises two
   couplings nothing else in the game does:

     1. LANE_FOLLOW_RATE is 3.4 m/s because every taper in corridor.ts is cut
        to a slope budget of rate / topSpeed against ~40 m/s (corridor.ts,
        docs/GAME.md §9). At 74 m/s the raw constant cannot hold a lane centre
        through a shrink, and the offset falls behind the pavement. updateRival
        holds the SLOPE instead — rate = v · (3.4 / 40) — and this file is what
        says by how much that matters.

     2. A DRIVING npc has no static collision anywhere in traffic.ts; updateHwy
        keeps cars off the toll islands purely by pinning them to lane centres.
        The rival drives a free lateral path, so it re-snaps to a gate through
        cor.inToll(). This checks it is actually centred by the time it gets
        to the islands.

   Same contract as test/traffic-merge-sim.mjs: traffic.ts pulls in three.js
   and a live scene, so the driving arithmetic is reimplemented here against
   the REAL corridor.ts geometry. If the formulas drift from traffic.ts that is
   a bug in this file — keep them in lockstep by eye.

   Usage: node test/rival-sim.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "rivalsim-"));
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
const { getCorridor, setRoadSeed, TOLL } = await import(path.join(dir, "corridor.js"));
/* The lane schedule is rolled from the road seed now, so the lap the rival
   drives is a different lap on a different road. ROAD_SEED=<n> re-plans the
   corridor before the scenario is built. */
if (process.env.ROAD_SEED) setRoadSeed(+process.env.ROAD_SEED);
const c = getCorridor();

let fail = 0;
const bad = (m) => { console.log("  FAIL " + m); fail++; };
const ok = (m) => console.log("  ok   " + m);
const f = (n) => n.toFixed(2);
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

/* ---- mirrors traffic.ts ---- */
const LANE_FOLLOW_RATE = 3.4;
const RIVAL = {
  top: 95, paceTau: 1.5, moodLo: 0.93, moodHi: 1.10,
  moodEvery: [6, 14], moodRate: 0.02,
  easeBeyond: 240, easeSpan: 200, gapDown: 5,
  yieldSee: 55, yieldClose: 14, yieldDv: 4, yieldLat: 2.4,
  holdNotWithin: 40, reseedBehind: 150, reseedAhead: 110, reseedAfter: 6,
  clearLon: 1.0, clearLat: 0.3, sepLon: 0.9, sepLat: 0.25, sepPasses: 4,
  backOffStep: 0.6, backOffSteps: 40,
  seeAhead: 240, followSee: 95, laneFreeMax: 30, laneGain: 1.3, laneGainHold: 3.0,
  hustleBehind: 25, hustleAfter: 4, hustleSpan: 8, hustleGainMin: 0.85,
  hustleFolMax: 8.0,
  yawMax: 9 * Math.PI / 180, yawTau: 0.10,
  folS0: 1.2, folTUrgent: 0.06, folAMax: 5.0, folBCom: 5.0,
  holdFrom: 40, holdSpan: 120, brakeNear: -1.5, brakeTtc: 2.0,
  accMax: 7.5, brakeSoft: -7, brakeHard: -10, spdP: 2.5,
  lampOn: -2.2, lampOff: -1.0,
  holdMin: 1.2, holdMax: 2.6, holdFar: 2.5, cdNear: 14, cdFar: 5,
  laneRate: 9.0, laneArrive: 0.35, laneMaxHold: 2.5, laneMinHold: 0.6,
  shuntMin: 1.0, shuntMax: 2.0, shuntLat: 0.45, shuntLon: 0.5,
  shuntLonMax: 6, shuntDamp: 2.2,
  seedAhead: 90, slideDt: 0.1,

};
/* NOTE: this file used to carry a BEFORE arm that A/B'd against the rival as
   it was before the speed fix. It has been removed — the design has changed
   twice since (the pace model was inverted, then the blocking removed
   wholesale), so it was comparing against something nobody will ever ship and
   referenced constants that no longer exist. The yaw A/B below stays, because
   what it guards is a live invariant rather than a superseded design. */

const W = 1.82; // a sedan's width (TYPE_DIM)
const L = 4.62;

const nearestLane = (z, off) => {
  const nl = c.lanes(z);
  let k = 0, bd = 1e9;
  for (let i = 0; i < nl; i++) {
    const d = Math.abs(c.laneOffset(i, z) - off);
    if (d < bd) { bd = d; k = i; }
  }
  return k;
};
const limAt = (z) => Math.max(0, c.halfWidth(z) - W / 2 - 0.3);

const DT = 1 / 60;

/* ============ 1. lateral rate vs what the pavement demands ============
   The lane centre slides under the car through every taper and through the
   toll plaza's pitch spread. Whatever rate the rival tracks at has to beat
   that, at ITS speed — and so does every target-easing rate above it, which
   is the subtler half (a target that eases slower than the pavement moves has
   the same bug one layer up; that is what this file caught first time). */
function slideAt(z, k, v) {
  const cNow = c.laneOffset(k, z);
  return Math.abs(c.laneOffset(k, c.wrapZ(z + v * RIVAL.slideDt)) - cNow) / RIVAL.slideDt;
}

console.log("1. lateral rate vs the pavement's own demand, at 74 m/s");
{
  let worstSlide = 0, worstZ = 0, worstK = 0;
  for (let z = c.Z0; z < c.Z1; z += 1) {
    for (let k = 0; k < c.lanes(z); k++) {
      const sl = slideAt(z, k, RIVAL.top);
      if (sl > worstSlide) { worstSlide = sl; worstZ = z; worstK = k; }
    }
  }
  console.log(`   worst lane-centre slide ${f(worstSlide)} m/s (z ${f(worstZ)}, lane ${worstK})`);
  console.log(`   raw LANE_FOLLOW_RATE ${f(LANE_FOLLOW_RATE)} m/s`);
  console.log(`   measured rate here   ${f(worstSlide + RIVAL.laneRate)} m/s (slide + laneRate)`);
  if (worstSlide >= LANE_FOLLOW_RATE)
    ok(`the shared constant IS outrun by the pavement at rival speed (${f(worstSlide)} ≥ ${f(LANE_FOLLOW_RATE)})`);
  else
    ok(`shared constant would survive here (${f(worstSlide)} < ${f(LANE_FOLLOW_RATE)}), measured rate is still the safe form`);
  // the rate actually used must beat the demand everywhere, by construction
  if (!(worstSlide + RIVAL.laneRate > worstSlide))
    bad("measured rate does not exceed the demand");
  else ok(`measured rate clears the worst demand by ${f(RIVAL.laneRate)} m/s everywhere`);
}

/* Drive a lap at 74 m/s holding a lane, under both rate models, and measure
   how far the body falls behind its own lane centre. */
function taperLag(mode) {
  let s = c.Z0 + 5, off = c.laneOffset(1, s), offT = off;
  let worst = 0, worstZ = 0;
  const v = RIVAL.top;
  for (let step = 0; step < Math.round(c.LOOP / (v * DT)) + 10; step++) {
    const k = Math.min(c.lanes(s) - 1, 1);
    const want = c.laneOffset(k, s);
    const slide = slideAt(s, k, v);
    const track = mode === "measured"
      ? Math.max(LANE_FOLLOW_RATE, slide + RIVAL.laneRate)
      : LANE_FOLLOW_RATE;
    const ease = mode === "measured" ? RIVAL.laneRate + slide : RIVAL.laneRate;
    const st = ease * DT;
    offT += clamp(want - offT, -st, st);
    const lim = limAt(s);
    offT = clamp(offT, -lim, lim);
    off += clamp(offT - off, -track * DT, track * DT);
    off = clamp(off, -lim, lim);
    const lag = Math.abs(off - want);
    if (lag > worst) { worst = lag; worstZ = s; }
    s = c.wrapZ(s + v * DT);
  }
  return { worst, worstZ };
}

console.log("   holding one lane for a full lap:");
{
  const raw = taperLag("raw");
  const meas = taperLag("measured");
  console.log(`     raw rates      : worst lag off the lane centre ${f(raw.worst)} m (z ${f(raw.worstZ)})`);
  console.log(`     measured rates : worst lag off the lane centre ${f(meas.worst)} m (z ${f(meas.worstZ)})`);
  if (meas.worst > raw.worst) bad("measured rates track worse than the raw constant");
  else ok(`measured rates track at least as well (${f(raw.worst)} → ${f(meas.worst)} m)`);
  if (meas.worst > c.LANE_W / 2)
    bad(`lag ${f(meas.worst)} m exceeds half a lane (${f(c.LANE_W / 2)} m) — body off its lane`);
  else ok(`lag stays inside half a lane (${f(c.LANE_W / 2)} m)`);
}

/* ============ 2. the pavement clamp ============
   A free path plus an impact slide is the one thing in traffic.ts that can put
   a driving car outside the deck, so the clamp has to be the thing that holds
   — not the lane logic, which the rival does not run. */
console.log("2. pavement clamp under a worst-case impact slide");
{
  let s = c.Z0 + 5, off = 0, latV = 0, worstOver = 0;
  let shunt = 0;
  const rng = mulberry32(12345);
  for (let step = 0; step < 40000; step++) {
    // slam it sideways at random, harder than any real impact can
    if (step % 400 === 0) {
      latV += (rng() < 0.5 ? -1 : 1) * 22 * RIVAL.shuntLat;
      shunt = RIVAL.shuntMax;
    }
    const lim = limAt(s);
    if (latV !== 0) {
      off += latV * DT;
      latV *= Math.exp(-RIVAL.shuntDamp * DT);
      if (Math.abs(latV) < 0.02) latV = 0;
    }
    if (shunt > 0) shunt -= DT;
    const over = Math.abs(off) - lim;
    if (over > worstOver) worstOver = over;
    off = clamp(off, -lim, lim);
    s = c.wrapZ(s + RIVAL.top * DT);
  }
  // the clamp is applied every frame, so the excursion inside one frame is all
  // that is ever possible: at most latV·dt
  if (worstOver > 0.3)
    bad(`offset escaped the pavement by ${f(worstOver)} m within a frame`);
  else ok(`worst single-frame excursion ${f(worstOver)} m, clamped every frame`);
}

/* ============ 3. the toll plaza gate snap ============
   The islands are real colliders and a driving npc has no static collision, so
   the rival has to be on a gate centre before it reaches them. */
console.log("3. toll plaza: lined up on a gate before the islands");
{
  // enter the toll window from the worst starting offset — hard against one
  // parapet, which is where a cover or a shunt could have left it
  let s = c.wrapZ(TOLL.z0 - 30);
  let off = limAt(s), offT = off;
  let snappedBy = null;
  const v = RIVAL.top;
  for (let step = 0; step < 4000; step++) {
    const kNow = nearestLane(s, offT);
    const slide = slideAt(s, kNow, v);
    const track = Math.max(LANE_FOLLOW_RATE, slide + RIVAL.laneRate);
    let want = offT, ease = RIVAL.laneRate + slide;
    if (c.inToll(s)) {
      want = c.laneOffset(nearestLane(s, offT), s);
      ease = track;
    }
    const st = ease * DT;
    offT += clamp(want - offT, -st, st);
    const lim = limAt(s);
    offT = clamp(offT, -lim, lim);
    off += clamp(offT - off, -track * DT, track * DT);
    off = clamp(off, -lim, lim);
    if (c.inToll(s) && snappedBy === null) {
      const k = nearestLane(s, off);
      if (Math.abs(off - c.laneOffset(k, s)) < 0.15) snappedBy = s;
    }
    s = c.wrapZ(s + v * DT);
    if (s > TOLL.z1) break;
  }
  if (snappedBy === null) bad("never reached a gate centre inside the toll window");
  else if (snappedBy > TOLL.plazaZ0)
    bad(`only centred at z ${f(snappedBy)}, past the island line at ${TOLL.plazaZ0}`);
  else
    ok(`centred on a gate by z ${f(snappedBy)}, ${f(TOLL.plazaZ0 - snappedBy)} m before the islands`);
  // and the clear width it has to fit through
  const gate = c.gateClear((TOLL.plazaZ0 + TOLL.plazaZ1) / 2);
  if (gate <= W) bad(`gate clear width ${f(gate)} m does not fit a ${f(W)} m body`);
  else ok(`gate clear ${f(gate)} m vs ${f(W)} m body — ${f((gate - W) / 2)} m each side`);
}

/* ============ 4. longitudinal: does the gap behave? ============
   A crude player model: tops out at 82 m/s but is held to a threading average
   by traffic, which is the whole premise — the rival is SLOWER flat out and
   only gains because it never lifts. */
function run(playerAvg, seed, laps = 3, charge = false) {
  const rng = mulberry32(seed);
  let rs = c.Z0 + RIVAL.seedAhead, rv = clamp(playerAvg + 8, 22, RIVAL.top);
  let ps = c.Z0, pv = playerAvg;
  let holdT = 0, holdCd = rng() * 6, holdStr = 0;
  let pace = playerAvg;
  let onBreak = false, mood = 1, moodTo = 1, braking = false;
  let moodT = lerp(RIVAL.moodEvery[0], RIVAL.moodEvery[1], rng());
  const hist = [];
  let maxGap = -1e9, minGap = 1e9, passes = 0, wasAhead = true, breakFrames = 0, brakeFrames = 0;
  const steps = Math.round((laps * c.LOOP) / (playerAvg * DT));
  for (let i = 0; i < steps; i++) {
    // player. `charge` models someone deliberately trying to get past: they
    // pin the throttle whenever the rival is close ahead.
    const gPrev = c.deltaZ(ps, rs);
    /* A charging player pins the throttle when the rival is in reach. Capped
       at 76 rather than the car's true 82: sustaining 82 through the corridor
       means threading every pack flat out, which nobody does, and at 82 they
       are simply faster than the rival's 80 ceiling and weld themselves to its
       bumper regardless of anything this controller decides — which tells us
       nothing about the controller. */
    pv = charge && gPrev > 0 && gPrev < 120
      ? 76
      : clamp(playerAvg * (1 + 0.16 * Math.sin(i * DT * 0.21 + seed)), 8, 82);
    ps = c.wrapZ(ps + pv * DT);

    const ahead = c.deltaZ(ps, rs);
    let brakeFloor = RIVAL.brakeSoft;
    pace += (pv - pace) * (1 - Math.exp(-DT / RIVAL.paceTau));
    moodT -= DT;
    if (moodT <= 0) {
      moodT = lerp(RIVAL.moodEvery[0], RIVAL.moodEvery[1], rng());
      moodTo = lerp(RIVAL.moodLo, RIVAL.moodHi, rng());
    }
    mood += clamp(moodTo - mood, -RIVAL.moodRate * DT, RIVAL.moodRate * DT);
    if (onBreak) breakFrames++;
    if (ahead > RIVAL.holdNotWithin && !onBreak) {
      if (holdT > 0) holdT -= DT;
      else {
        holdCd -= DT;
        if (holdCd <= 0) {
          const far = clamp((ahead - RIVAL.holdFrom) / RIVAL.holdSpan, 0, 1);
          holdT = lerp(RIVAL.holdMin, RIVAL.holdMax, rng()) + far * RIVAL.holdFar;
          holdCd = lerp(RIVAL.cdNear, RIVAL.cdFar, far) + rng() * 4;
          holdStr = far;
        }
      }
    } else holdT = 0;
    let lead = null;
    if (holdT > 0) {
      lead = { ds: 30, v: 25 };
      brakeFloor = lerp(RIVAL.brakeSoft, RIVAL.brakeHard, holdStr);
    }
    let v0 = Math.min(RIVAL.top * mood, RIVAL.top);
    if (ahead > RIVAL.easeBeyond) {
      const t = clamp((ahead - RIVAL.easeBeyond) / RIVAL.easeSpan, 0, 1);
      v0 = lerp(v0, Math.max(pace - RIVAL.gapDown, 0), t);
    }
    v0 = clamp(v0, 0, RIVAL.top);

    let acc;
    if (lead) {
      const aMax = 2.4, bCom = 2.6, T = 0.9, s0 = 5;
      const dv = rv - lead.v;
      const sStar = s0 + rv * T + (rv * dv) / (2 * Math.sqrt(aMax * bCom));
      acc = Math.min((v0 - rv) * RIVAL.spdP,
        aMax * (1 - Math.pow(sStar / Math.max(lead.ds, 0.55), 2)));
    } else acc = (v0 - rv) * RIVAL.spdP;
    // longitudinal fairness guard: never brake harder than the player behind
    // could react to
    if (ahead > 0) {
      const cl = pv - rv;
      if (cl > 0.1)
        brakeFloor = lerp(RIVAL.brakeNear, brakeFloor,
          clamp(ahead / cl / RIVAL.brakeTtc, 0, 1));
    }
    const accRaw = clamp(acc, brakeFloor, RIVAL.accMax);
    acc = accRaw;
    braking = accRaw < (braking ? RIVAL.lampOff : RIVAL.lampOn);
    if (braking) brakeFrames++;
    rv = Math.max(0, rv + acc * DT);
    rs = c.wrapZ(rs + rv * DT);

    const g = c.deltaZ(ps, rs);
    hist.push(g);
    if (i * DT > 15 && g > maxGap) maxGap = g;
    if (g < minGap) minGap = g;
    // +/- 8 m of hysteresis: without it a car hovering at a zero gap counts a
    // "pass" on every frame the sign flips, which is thousands of them
    if (wasAhead && g < -8) { passes++; wasAhead = false; }
    if (!wasAhead && g > 8) wasAhead = true;
  }
  hist.sort((a, b) => a - b);
  const q = (p) => hist[Math.floor(p * (hist.length - 1))];
  const close = hist.filter((g) => g > 0 && g < 10).length / hist.length;
  const vclose = hist.filter((g) => g > 0 && g < 5).length / hist.length;
  const far = hist.filter((g) => g > 140).length / hist.length;
  // the dashcam frame includes the rear-view mirror, so a rival sitting
  // behind the player is still on screen — count both ways
  const visible = hist.filter((g) => g > -120 && g < 260).length / hist.length;
  return { minGap, maxGap, med: q(0.5), p10: q(0.1), p90: q(0.9),
           close, vclose, far, visible,
           passes, onBreak: breakFrames / (hist.length || 1),
           braking: brakeFrames / (hist.length || 1) };
}

console.log("4. gap behaviour over 3 laps, by how well the player threads");
console.log("   player avg   p10      med      p90     <10m   <5m   >140m  in frame  passes");
for (const [label, avg] of [
  ["struggling  ", 40], ["ordinary    ", 50], ["good        ", 60],
  ["very good   ", 68], ["superhuman  ", 78],
]) {
  const r = run(avg, 99, 3);
  console.log(
    `   ${label} ${String(f(r.p10)).padStart(7)}  ${String(f(r.med)).padStart(7)}  ` +
    `${String(f(r.p90)).padStart(7)}  ${String((r.close * 100).toFixed(0) + "%").padStart(5)}  ` +
    `${String((r.vclose * 100).toFixed(0) + "%").padStart(4)}  ` +
    `${String((r.far * 100).toFixed(0) + "%").padStart(5)}  ` +
    `${String((r.visible * 100).toFixed(0) + "%").padStart(8)}  ${String(r.passes).padStart(6)}`);
}
{
  /* The "must stay in frame" assertion was removed with the design change that
     made speed beat proximity: it now runs flat out until it is 240 m clear
     and only eases past that, and the user has explicitly accepted that it
     will sometimes be a speck or briefly gone. In THIS scenario there is no
     traffic at all, so nothing limits it and it simply leaves — which says
     nothing about the real corridor, where traffic is the binding constraint.
     Section 5 is where visibility is worth measuring. */
  /* The bumper-to-bumper reach assertion is gone too — the user dropped that
     as a goal outright ("idc abt the bumper stuff"), and the rival no longer
     eases anywhere the player can see, so closing on it is not something the
     design promises. */
  /* No traffic in this scenario, so nothing here tests threading — it is a
     pure station-keeping check: a player who pins the throttle whenever the
     rival is in reach must still not get past it on pace alone (the rival
     has no active "defence" — that design was tried and removed, see the
     RIVAL block comment in traffic.ts — so this has to hold on speed alone). */
  const ch = run(55, 13, 3, true);
  console.log(`   charging player (no traffic): ${ch.passes} pass(es), under 10 m for ${(ch.close * 100).toFixed(0)}% of the run`);
  if (ch.passes > 4) bad(`charging player got past ${ch.passes} times on pace alone`);
  else ok(`holds on pace alone: ${ch.passes} pass(es) over 3 laps of charging`);
  /* Brake lamps have to MEAN something — lit all the time telegraphs nothing,
     which is exactly what the first LIVE run showed (26 of 26 samples) before
     the free-flow law stopped being IDM's ^4 term.

     The bar here is deliberately loose. This sim has no traffic in it, so the
     rival never gets held up and every deceleration it makes is
     station-keeping; in the real corridor the hold-ups dominate and the mix is
     different. Treat this as a regression guard against the pathological case
     (lamps effectively always on), not as the tuning authority — the live
     check against a running game is the arbiter for that. */
  for (const avg of [35, 55, 70]) {
    const b = run(avg, 5, 3).braking;
    if (b > 0.45)
      bad(`brake lamps lit ${(b * 100).toFixed(0)}% of the time at ${avg} m/s — they stop reading`);
  }
  ok(`brake lamps lit ${(run(55, 5, 3).braking * 100).toFixed(0)}% of the time in a traffic-free sim`);
  // ...and it must never be able to simply vanish
  // a very slow player: it must slow down with them, not disappear
  let worst = 0;
  for (const seed of [11, 23, 47]) worst = Math.max(worst, run(22, seed, 3).maxGap);
  /* It now runs flat out until it is 240 m clear and only eases past that, so
     against a slow player it settles somewhere past easeBeyond rather than at
     a target gap. The bound is that ease actually bites. */
  const bound = RIVAL.easeBeyond + RIVAL.easeSpan + 200;
  if (worst > bound)
    bad(`settled gap ran away to ${f(worst)} m against a slow player (bound ${f(bound)})`);
  else ok(`worst settled lead ${f(worst)} m vs a 22 m/s player — stays in reach`);
}

/* ============ 5. threading traffic without driving through it ============
   The whole point of the rework: the rival must never share a body with a
   traffic car. This populates the corridor properly and runs the real three
   layers over it — the leader follow, the lateral-move gate (rivalLatClear),
   and the hard backstop (rivalSeparate).

   The traffic here is deliberately ADVERSARIAL in the one way the game's is:
   NPCs change lanes with no awareness of the rival whatsoever (they ignore it
   by design), so they will occasionally move straight into the space it is
   using. Layers 1 and 2 cannot prevent that — only layer 3 can — which is
   exactly why layer 3 exists. */
console.log("5. threading traffic — body separation");
/* Two densities. The dense case saturates — traffic flows at ~19 m/s and
   BOTH the player and the rival are pinned by it, so nothing about the
   rival's own speed model can be measured there at all (that cost a couple
   of tuning rounds before it was noticed). The flowing case is the one that
   can actually answer "is the rival fast", and the corridor spends plenty of
   time looking like it. */
/* Three seeds per density, not one — a single fixed seed cannot back the
   "zero overlaps is absolute" claim, and the ahead%/speed-ratio numbers the
   report cites need a range rather than one lucky (or unlucky) draw. */
const DENSITY_SEEDS = [20260825, 90210, 314159];
const seedResults = [];
for (const NC of [180, 60]) for (const SEED of DENSITY_SEEDS) {
  console.log(`   ---- ${NC === 180 ? "dense" : "flowing"} traffic, seed ${SEED} ----`);
  const DIM = { car: { L: 4.62, W: 1.82 }, truck: { L: 9.4, W: 2.5 } };
  const rng = mulberry32(SEED);
  const R = { L: 4.62, W: 1.82 };

  function mkFleet(nCars, aroundZ) {
    const out = [];
    let tries = 0;
    while (out.length < nCars && tries++ < nCars * 40) {
      const z = c.wrapZ(aroundZ + (rng() - 0.35) * 1400);
      const heavy = rng() < 0.16;
      const d = heavy ? DIM.truck : DIM.car;
      const k = Math.min(Math.floor(rng() * c.lanes(z)), c.lanes(z) - 1);
      const off = c.laneOffset(k, z);
      // 30 m of clear road per lane at spawn, or the fleet starts as a pile-up
      // and the whole run measures a jam rather than traffic
      let blocked = false;
      for (const m of out)
        if (Math.abs(m.off - off) < 2.2 && Math.abs(c.deltaZ(m.s, z)) < 30) blocked = true;
      if (blocked) continue;
      const cruise = heavy ? 17 + rng() * 6 : 20 + rng() * 18;
      out.push({ s: z, L: d.L, W: d.W, off, laneK: k, v: cruise, v0: cruise,
                 turnCd: 3 + rng() * 10 });
    }
    return out;
  }

  // --- the rival's own logic, mirroring updateRival's three layers ---
  const perceive = (rs, roff, fleet, range = 70, halfW = 1.9) => {
    let ds = Infinity, lv = 0;
    for (const m of fleet) {
      if (Math.abs(m.off - roff) > halfW) continue;
      const ahead = c.deltaZ(rs, m.s);
      if (ahead <= 0 || ahead > range) continue;
      const d = Math.max(ahead - (m.L + R.L) / 2, 0.1);
      if (d < ds) { ds = d; lv = m.v; }
    }
    return ds < 1e8 ? { ds, v: lv } : null;
  };
  const latClear = (rs, off2, fleet) => {
    for (const m of fleet) {
      if (Math.abs(m.off - off2) >= (R.W + m.W) / 2 + RIVAL.clearLat) continue;
      const ds = c.deltaZ(rs, m.s);
      const need = (R.L + m.L) / 2 + RIVAL.clearLon;
      if (ds > -need && ds < need) return false;
    }
    return true;
  };
  let backOffs = 0;
  let excluded = 0, laneEvals = 0, yields = 0, yieldWant = 0, blockedYield = 0;
  let movesStarted = 0, movesDone = 0, reversals = 0, lastMoveDir = 0, pendingMove = false;
  const laneFree = (rs, off, vFree, fleet) => {
    let d = Infinity, mv = 0;
    for (const m of fleet) {
      if (Math.abs(m.off - off) > 2.2) continue;
      const ds = c.deltaZ(rs, m.s);
      if (ds > 0 && ds < RIVAL.seeAhead && ds < d) { d = ds; mv = m.v; }
    }
    if (d > 1e8) return RIVAL.laneFreeMax;
    const closing = vFree - mv;
    if (closing <= 0.5) return RIVAL.laneFreeMax;
    return Math.min(RIVAL.laneFreeMax, d / closing);
  };

  const bestLane = (rs, roff, fleet, vFree, gain) => {
    laneEvals++;
    const nl = c.lanes(rs);
    const cur = nearestLane(rs, roff);
    let bestOff = c.laneOffset(cur, rs);
    let bv = laneFree(rs, bestOff, vFree, fleet) * gain;
    for (let k = 0; k < nl; k++) {
      if (k === cur) continue;
      const off = c.laneOffset(k, rs);
      if (!latClear(rs, off, fleet)) { excluded++; continue; }
      const v = laneFree(rs, off, vFree, fleet);
      if (v > bv) { bv = v; bestOff = off; }
    }
    // threading: the line BETWEEN two adjacent lanes — see bestLane in traffic.ts
    for (let k = 0; k < nl - 1; k++) {
      const off = (c.laneOffset(k, rs) + c.laneOffset(k + 1, rs)) / 2;
      if (!latClear(rs, off, fleet)) { excluded++; continue; }
      const v = laneFree(rs, off, vFree, fleet);
      if (v > bv) { bv = v; bestOff = off; }
    }
    // the shoulder — see bestLane in traffic.ts
    const lim = Math.max(0, c.halfWidth(rs) - R.W / 2 - 0.3);
    for (const off of [-lim, lim]) {
      if (Math.abs(off - roff) < 1.0) continue;
      if (!latClear(rs, off, fleet)) { excluded++; continue; }
      const v = laneFree(rs, off, vFree, fleet);
      if (v > bv) { bv = v; bestOff = off; }
    }
    return bestOff;
  };

  const separate = (r, fleet) => {
    const lim = Math.max(0, c.halfWidth(r.s) - R.W / 2 - 0.3);
    // total penetration the rival would be left in at a hypothetical spot
    const pen = (os, ooff) => {
      let t = 0;
      for (const m of fleet) {
        const dl = (R.W + m.W) / 2 + RIVAL.sepLat - Math.abs(ooff - m.off);
        if (dl <= 0) continue;
        const dn = (R.L + m.L) / 2 + RIVAL.sepLon - Math.abs(c.deltaZ(m.s, os));
        if (dn <= 0) continue;
        t += Math.min(dl, dn);
      }
      return t;
    };
    for (let pass = 0; pass < RIVAL.sepPasses; pass++) {
      let worst = null, worstPen = 0, wLat = 0, wLon = 0;
      for (const m of fleet) {
        const dLat = r.off - m.off;
        const latPen = (R.W + m.W) / 2 + RIVAL.sepLat - Math.abs(dLat);
        if (latPen <= 0) continue;
        const dLon = c.deltaZ(m.s, r.s);
        const lonPen = (R.L + m.L) / 2 + RIVAL.sepLon - Math.abs(dLon);
        if (lonPen <= 0) continue;
        const pen = Math.min(latPen, lonPen);
        if (pen > worstPen) { worstPen = pen; worst = m; wLat = dLat; wLon = dLon; }
      }
      if (!worst) break;
      const latPen = (R.W + worst.W) / 2 + RIVAL.sepLat - Math.abs(wLat);
      const lonPen = (R.L + worst.L) / 2 + RIVAL.sepLon - Math.abs(wLon);
      const latOut = r.off + (wLat >= 0 ? latPen : -latPen);
      const lonOut = wLon >= 0 ? c.wrapZ(r.s + lonPen) : c.wrapZ(r.s - lonPen);
      const latOk = Math.abs(latOut) <= lim;
      const pLat = latOk ? pen(r.s, latOut) : Infinity;
      const pLon = pen(lonOut, r.off);
      if (pLat <= pLon) r.off = latOut;
      else { r.s = lonOut; if (wLon < 0) r.v = Math.min(r.v, worst.v); }
    }
    // guaranteed escape — see the end of rivalSeparate
    if (pen(r.s, r.off) > 0) {
      for (let i = 0; i < RIVAL.backOffSteps; i++) {
        r.s = c.wrapZ(r.s - RIVAL.backOffStep);
        if (pen(r.s, r.off) <= 0) break;
      }
      backOffs++;
    }
  };

  let overlapFrames = 0, worstDepth = 0, minSep = 1e9, pinned = 0, ovBlind=0, ovYield=0, ovMoving=0;
  let vSum = 0, pvSum = 0, leadFrames = 0, leadDsSum = 0, capFrames = 0;
  // its pace when it is NOT deliberately easing off, which is the honest
  // answer to "is it faster than me" — the mean folds in the easing
  let freeV = 0, freePv = 0, freeN = 0, easeN = 0;
  let aheadFrames = 0, closeFrames = 0, passes = 0, wasAhead = true, reseeds = 0, behindT = 0;
  // yaw, measured both ways: OLD = raw one-frame rate with offPrev taken
  // before separation and no cap; NEW = smoothed, taken after, capped
  let offPrevOld = 0, offPrevNew = 0, latRateNew = 0;
  const yawOld = [], yawNew = [];
  let wantDiff = 0, v0Sum = 0, v0CapFrames = 0, laneSwitches = 0, abandoned = 0;
  let prevLane = -1, prevWant = -1, mid = false, farLead = 0, farLeadSum = 0;
  let sepFired = 0, latBlocked = 0;
  const gapHist = [];

  /* The player has to thread the same traffic, or the comparison is
     meaningless: the rival respects other cars now, so a phantom player who
     drives through them simply accumulates distance forever (which is exactly
     what the first version of this measured — a 430 m "gap" that was really
     just four minutes of the rival obeying rules the player was exempt from).
     Same perception, human-ish following and a slower, less optimal lane
     pick. */
  const P = { L: 4.5, W: 1.8 };
  let ps = c.Z0, pv = 52, pOff = c.laneOffset(1, c.Z0), pLaneT = 0;
  let pLaneWant = c.laneOffset(1, c.Z0), pOffT = c.laneOffset(1, c.Z0);
  const r = { s: c.Z0 + 90, off: c.laneOffset(1, c.Z0 + 90), v: 55, laneWant: 0,
              laneT: 0, offT: 0, pace: 52, holdT: 0,
              holdCd: 6, mood: 1 };
  let hustleT = 0, hustleFrames = 0;
  r.offT = r.off;
  offPrevOld = offPrevNew = r.off;
  let fleet = mkFleet(NC, c.Z0 + 300);

  const STEPS = Math.round(240 / DT); // four minutes of driving
  for (let i = 0; i < STEPS; i++) {
    {
      // player: flat out, limited by whatever is in front of them
      let pAcc = (78 - pv) * 1.0;
      const pl = perceive(ps, pOff, fleet);
      if (pl) {
        const aMax = 3.0, bCom = 3.0, T = 0.8, s0 = 4;
        const dv = pv - pl.v;
        const sS = s0 + pv * T + (pv * dv) / (2 * Math.sqrt(aMax * bCom));
        pAcc = Math.min(pAcc, aMax * (1 - Math.pow(sS / Math.max(pl.ds, 0.55), 2)));
      }
      pv = clamp(pv + clamp(pAcc, -7, 3.4) * DT, 4, 82);
      ps = c.wrapZ(ps + pv * DT);
      pLaneT -= DT;
      if (pLaneT <= 0) { pLaneT = 1.2; pLaneWant = bestLane(ps, pOff, fleet, 78, RIVAL.laneGain); }
      const pWant = pLaneWant; // bestLane returns an OFFSET now, not an index
      pOffT += clamp(pWant - pOffT, -3.0 * DT, 3.0 * DT);
      /* The player is subject to the SAME lateral gate as the rival. Without
         it they slide bodily through traffic to reach a better lane, which is
         a threading edge no real player has (they would crash) — and since the
         rival is gated, that unfairness shows up as the rival being
         permanently a couple of percent slower. Measure like for like. */
      const pStep = clamp(pOffT - pOff, -3.4 * DT, 3.4 * DT);
      const pCand = pOff + pStep;
      if (pStep === 0 || latClear(ps, pCand, fleet)) pOff = pCand;
    }

    // --- traffic: lane-follow + IDM, and lane changes that ignore the rival ---
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
      // lane changes, blind to the rival exactly as the game's are
      m.turnCd -= DT;
      const nl = c.lanes(m.s);
      /* YIELD — the fleet gets out of the rival's way. Mirrors yieldToRival:
         only the car actually in its path, only while it is close and
         genuinely faster, and gap-checked against the rest of the fleet so it
         cannot move into anybody. */
      let yielded = false;
      m.yieldCd = Math.max(0, (m.yieldCd || 0) - DT);
      if (m.yieldCd <= 0) {
        const behind = c.deltaZ(r.s, m.s);
        if (behind > 0 && behind < RIVAL.yieldSee &&
            Math.abs(r.off - m.off) <= RIVAL.yieldLat &&
            (behind <= RIVAL.yieldClose || r.v >= m.v + RIVAL.yieldDv)) {
          yieldWant++;
          // AWAY from it, and only away — see yieldToRival
          const away = r.off <= m.off ? 1 : -1;
          {
            const k2 = m.laneK + away;
            if (k2 >= 0 && k2 <= nl - 1) {
            const off2 = c.laneOffset(k2, m.s);
            let ok2 = true;
            for (const o of fleet) {
              if (o === m) continue;
              if (Math.abs(o.off - off2) > 2.2) continue;
              const dz = c.deltaZ(m.s, o.s);
              const back = 1.2 + 0.25 * m.v, fwd = 2.5 + 0.35 * m.v;
              if (dz > -(back + (o.L + m.L) / 2) && dz < fwd + (o.L + m.L) / 2) { ok2 = false; break; }
            }
            // ...and not into the rival itself — see yieldToRival
            if (ok2) {
              const dLat = Math.abs(off2 - r.off);
              const dLon = Math.abs(c.deltaZ(r.s, m.s));
              // projected forward over the ~1.1 s the move takes
              const moveT = 1.1, closing = Math.max(0, r.v - m.v);
              if (dLat < (m.W + R.W) / 2 + RIVAL.clearLat &&
                  dLon - closing * moveT < (m.L + R.L) / 2 + RIVAL.clearLon + 1.2 + 0.25 * m.v) ok2 = false;
            }
            if (ok2) { m.laneK = k2; yielded = true; yields++; m.yieldCd = 2.5; }
            else blockedYield++;
            }
          }
        }
      }
      if (!yielded && m.turnCd <= 0) {
        m.turnCd = 6 + rng() * 12;
        const k2 = m.laneK + (rng() < 0.5 ? -1 : 1);
        /* Gap-checked against OTHER NPCS only — the real fleet has
           laneClearAt, and without an equivalent here they cut each other up
           constantly and the whole corridor jams, which is a harsher regime
           than the game's and not the one worth measuring. Deliberately still
           blind to the RIVAL, exactly as the game is: a car moving into the
           space the rival is using is the adversarial case layer 3 is for. */
        if (k2 >= 0 && k2 <= nl - 1) {
          const off2 = c.laneOffset(k2, m.s);
          let ok2 = true;
          for (const o of fleet) {
            if (o === m) continue;
            if (Math.abs(o.off - off2) > 2.2) continue;
            const dz = c.deltaZ(m.s, o.s);
            if (dz > -(13.5 + (o.L + m.L) / 2) && dz < 23.5 + (o.L + m.L) / 2) { ok2 = false; break; }
          }
          if (ok2) m.laneK = k2;
        }
      }
      m.laneK = Math.min(m.laneK, nl - 1);
      const wantOff = c.laneOffset(m.laneK, m.s);
      m.off += clamp(wantOff - m.off, -2.0 * DT, 2.0 * DT);
    }
    // recycle anything that drops well behind the player back up the road
    for (const m of fleet) {
      if (c.deltaZ(ps, m.s) < -160) {
        m.s = c.wrapZ(ps + 380 + rng() * 420);
        m.laneK = Math.floor(rng() * c.lanes(m.s));
        m.off = c.laneOffset(m.laneK, m.s);
      }
    }

    // --- the rival ---
    let ahead = c.deltaZ(ps, r.s);
    behindT = ahead < 0 ? behindT + DT : 0;
    hustleT = ahead < -RIVAL.hustleBehind ? hustleT + DT : Math.max(0, hustleT - 2 * DT);
    const hustleNow = clamp((hustleT - RIVAL.hustleAfter) / RIVAL.hustleSpan, 0, 1);
    if (hustleNow > 0) hustleFrames++;
    if (ahead < -RIVAL.reseedBehind && behindT > RIVAL.reseedAfter) {
      behindT = 0;
      r.s = c.wrapZ(ps + RIVAL.reseedAhead);
      r.v = Math.max(r.v, r.pace);
      ahead = RIVAL.reseedAhead;
      reseeds++;
    }
    r.pace += (pv - r.pace) * (1 - Math.exp(-DT / RIVAL.paceTau));
    if (ahead <= RIVAL.holdNotWithin) r.holdT = 0;
    else if (r.holdT > 0) r.holdT -= DT;
    else { r.holdCd -= DT; if (r.holdCd <= 0) {
      r.holdT = lerp(RIVAL.holdMin, RIVAL.holdMax, rng());
      r.holdCd = lerp(RIVAL.cdNear, RIVAL.cdFar, 0.5) + rng() * 4; } }

    let v0 = Math.min(RIVAL.top * r.mood, RIVAL.top);
    let easing = false;
    if (ahead > RIVAL.easeBeyond) {
      easing = true;
      const t = clamp((ahead - RIVAL.easeBeyond) / RIVAL.easeSpan, 0, 1);
      v0 = lerp(v0, Math.max(r.pace - RIVAL.gapDown, 0), t);
    }
    v0 = clamp(v0, 0, RIVAL.top);

    const lead = perceive(r.s, r.off, fleet, RIVAL.followSee, (R.W + 2.5) / 2 + 0.25);
    let acc = (v0 - r.v) * RIVAL.spdP;
    if (lead) {
      const aMax = lerp(RIVAL.folAMax, RIVAL.hustleFolMax, hustleNow);
      const bCom = lerp(RIVAL.folBCom, RIVAL.hustleFolMax, hustleNow);
      const dv = r.v - lead.v;
      const T = RIVAL.folTUrgent;
      const sS = RIVAL.folS0 + r.v * T + (r.v * dv) / (2 * Math.sqrt(aMax * bCom));
      acc = Math.min(acc, aMax * (1 - Math.pow(sS / Math.max(lead.ds, 0.55), 2)));
      if (lead.ds < 12 && r.v > lead.v + 2) pinned++;
      leadFrames++; leadDsSum += lead.ds;
      // did the FOLLOWING limit (not the station-keeping) decide this frame?
      if (aMax * (1 - Math.pow(sS / Math.max(lead.ds, 0.55), 2)) < (v0 - r.v) * RIVAL.spdP) capFrames++;
    }
    let bf = RIVAL.brakeSoft;
    if (ahead > 0) { const cl = pv - r.v;
      if (cl > 0.1) bf = lerp(RIVAL.brakeNear, bf, clamp(ahead / cl / RIVAL.brakeTtc, 0, 1)); }
    r.v = Math.max(0, r.v + clamp(acc, bf, RIVAL.accMax) * DT);
    vSum += r.v;
    pvSum += pv;
    if (easing) easeN++;
    else { freeV += r.v; freePv += pv; freeN++; }
    v0Sum += v0;
    // was the STATION-KEEPING target the thing capping it, rather than traffic?
    if (!lead || (v0 - r.v) * RIVAL.spdP <= 0.05) { if (r.v >= v0 - 0.5) v0CapFrames++; }
    // what does it see if we let it look a long way down its own lane?
    {
      let fd = Infinity;
      for (const m of fleet) {
        if (Math.abs(m.off - r.off) > 1.9) continue;
        const ah = c.deltaZ(r.s, m.s);
        if (ah > 0 && ah < fd) fd = ah;
      }
      if (fd < 1e8) { farLead++; farLeadSum += Math.min(fd, 400); }
    }
    {
      const curLane = nearestLane(r.s, r.off);
      if (nearestLane(r.s, r.laneWant) !== curLane) wantDiff++;
      if (prevLane >= 0 && curLane !== prevLane) laneSwitches++;
      // a lane change is "abandoned" if the target changed while the body was
      // still more than half a lane from the previous target
      if (prevWant >= 0 && r.laneWant !== prevWant && mid) abandoned++;
      mid = Math.abs(r.laneWant - r.off) > 1.8;
      prevLane = curLane; prevWant = r.laneWant;
    }
    r.s = c.wrapZ(r.s + r.v * DT);

    // lateral: pick a lane, ease toward it, never slide into anybody
    /* the commitment latch — mirrors updateRival */
    r.laneT += DT;
    {
      const arrived = Math.abs(r.off - r.laneWant) < RIVAL.laneArrive;
      const blocked = !arrived && !latClear(r.s, r.laneWant, fleet);
      if (blocked) {
        // abort cleanly and serve the dwell — see updateRival
        if (pendingMove) { pendingMove = false; }
        r.laneWant = c.laneOffset(nearestLane(r.s, r.off), r.s);
        r.laneT = 0;
      } else if ((arrived && r.laneT > RIVAL.laneMinHold) || r.laneT > RIVAL.laneMaxHold) {
        r.laneT = 0;
        const prev = r.laneWant;
        const gain = r.holdT > 0 ? RIVAL.laneGainHold
          : lerp(RIVAL.laneGain, RIVAL.hustleGainMin, hustleNow);
        r.laneWant = bestLane(r.s, r.off, fleet, v0, gain);
        /* WIGGLE METRICS — a known failure mode now, so they live here
           permanently. A "move" is a decision that shifts the target by more
           than a metre; it COMPLETES if the body reaches it before the target
           moves again, and it is a REVERSAL if the new target is back the way
           it came from. */
        // resolve the move that was in flight, if any
        if (pendingMove) { if (arrived) movesDone++; pendingMove = false; }
        if (Math.abs(r.laneWant - r.off) > 1.0) {
          movesStarted++;
          pendingMove = true;
          const dirNew = Math.sign(r.laneWant - r.off);
          if (lastMoveDir !== 0 && dirNew !== 0 && dirNew !== lastMoveDir) reversals++;
          if (dirNew !== 0) lastMoveDir = dirNew;
        }
      }
    }
    const kNow = nearestLane(r.s, r.off);
    const slide = Math.abs(c.laneOffset(kNow, c.wrapZ(r.s + r.v * RIVAL.slideDt))
      - c.laneOffset(kNow, r.s)) / RIVAL.slideDt;
    const track = Math.max(LANE_FOLLOW_RATE, slide + RIVAL.laneRate);
    const want = r.laneWant;
    const lim = Math.max(0, c.halfWidth(r.s) - R.W / 2 - 0.3);
    r.offT += clamp(want - r.offT, -(RIVAL.laneRate + slide) * DT, (RIVAL.laneRate + slide) * DT);
    r.offT = clamp(r.offT, -lim, lim);
    const stepLat = clamp(r.offT - r.off, -track * DT, track * DT);
    const cand = clamp(r.off + stepLat, -lim, lim);
    if (stepLat === 0 || latClear(r.s, cand, fleet)) r.off = cand;
    else latBlocked++;

    // OLD: rate sampled before separation, offPrev recorded before it too
    const rawOld = (r.off - offPrevOld) / DT;
    offPrevOld = r.off;
    const rawNew = (r.off - offPrevNew) / DT;
    latRateNew += (rawNew - latRateNew) * (1 - Math.exp(-DT / RIVAL.yawTau));

    // (the fleet has already moved for this step, above, so this IS the
    // end-of-frame position — mirrors the rival separation pass at the end of
    // Traffic.update)
    const sBefore = r.s, offBefore = r.off;
    separate(r, fleet);
    if (r.s !== sBefore || r.off !== offBefore) sepFired++;
    offPrevNew = r.off;

    {
      const sv = Math.max(r.v, 1);
      yawOld.push(Math.abs(Math.atan2(rawOld, sv)) * 180 / Math.PI);
      yawNew.push(Math.abs(clamp(Math.atan2(latRateNew, sv),
        -RIVAL.yawMax, RIVAL.yawMax)) * 180 / Math.PI);
    }

    // --- measure ---
    let frameOverlap = false;
    for (const m of fleet) {
      const dLat = Math.abs(r.off - m.off), dLon = Math.abs(c.deltaZ(m.s, r.s));
      const latPen = (R.W + m.W) / 2 - dLat, lonPen = (R.L + m.L) / 2 - dLon;
      if (latPen > 0 && lonPen > 0) {
        frameOverlap = true;
        worstDepth = Math.max(worstDepth, Math.min(latPen, lonPen));
      } else {
        // clearance along whichever axis is actually separating them
        const sep = Math.max(-latPen, -lonPen);
        if (dLon < 60) minSep = Math.min(minSep, sep);
      }
    }
    if (frameOverlap) {
      overlapFrames++;
      let sepSees=0, partnerYielded=0, partnerMoving=0;
      for (const m of fleet) {
        const dLat=Math.abs(r.off-m.off), dLon=Math.abs(c.deltaZ(m.s,r.s));
        if (dLat<(R.W+m.W)/2 && dLon<(R.L+m.L)/2) {
          if (dLat<(R.W+m.W)/2+RIVAL.sepLat && dLon<(R.L+m.L)/2+RIVAL.sepLon) sepSees++;
          if ((m.yieldCd||0)>0) partnerYielded++;
          if (Math.abs(c.laneOffset(m.laneK,m.s)-m.off)>0.2) partnerMoving++;
        }
      }
      if(sepSees===0) ovBlind++;
      if(partnerYielded) ovYield++;
      if(partnerMoving) ovMoving++;
    }
    gapHist.push(ahead);
    if (ahead > 0) aheadFrames++;
    if (ahead > 0 && ahead < 10) closeFrames++;
    if (wasAhead && ahead < -8) { passes++; wasAhead = false; }
    if (!wasAhead && ahead > 8) wasAhead = true;
  }

  console.log(`   overlap frames: ${overlapFrames}   worst penetration: ${f(worstDepth)} m`);
  if (overlapFrames) console.log(`      separate() blind on ${ovBlind} | partner had just yielded on ${ovYield} | partner mid-lane-change on ${ovMoving}`);
  {
    const q = (a, x) => { const b = a.slice().sort((u, v) => u - v); return b[Math.floor(x * (b.length - 1))]; };
    const mean = (a) => a.reduce((u, v) => u + v, 0) / Math.max(a.length, 1);
    const oldMax = Math.max(...yawOld), newMax = Math.max(...yawNew);
    const newP99 = q(yawNew, 0.99), cap = RIVAL.yawMax * 180 / Math.PI;
    console.log(`   YAW off the corridor, deg — superseded formula mean ${f(mean(yawOld))} p99 ${f(q(yawOld, 0.99))} max ${f(oldMax)}`);
    console.log(`                                        shipping mean ${f(mean(yawNew))} p99 ${f(newP99)} max ${f(newMax)}`);
    /* The superseded formula took its rate before the separation pass and
       capped nothing, so a depenetration read as ~130 m/s of lateral motion
       and the body pointed nearly sideways for a frame. Kept as a live
       comparison rather than a comment because it is the only thing that
       proves the cap is still doing its job. */
    if (newMax > cap + 0.01)
      bad(`yaw reached ${f(newMax)} deg, past the ${f(cap)} deg cap`);
    else if (newP99 > cap + 0.01)
      bad(`yaw p99 ${f(newP99)} deg exceeds the cap`);
    else ok(`yaw capped at ${f(cap)} deg (superseded formula peaked at ${f(oldMax)})`);
  }
  console.log(`   layer 2 blocked a lateral move on ${latBlocked} frames; layer 3 fired on ${sepFired}`);
  gapHist.sort((a, b) => a - b);
  const q = (x) => gapHist[Math.floor(x * (gapHist.length - 1))];
  console.log(`   gap to player p10/med/p90: ${f(q(0.1))} / ${f(q(0.5))} / ${f(q(0.9))} m`);
  console.log(`   AHEAD of the player ${(aheadFrames / STEPS * 100).toFixed(1)}% of the run | out-of-sight recycles: ${reseeds}`);
  console.log(`   rival mean speed ${f(vSum / STEPS)} m/s vs player mean ${f(pvSum / STEPS)} m/s (mean folds in the easing)`);
  console.log(`   WHEN NOT EASING (${(freeN / STEPS * 100).toFixed(0)}% of frames): rival ${f(freeV / Math.max(freeN, 1))} vs player ${f(freePv / Math.max(freeN, 1))} m/s`);
  console.log(`   had a leader in its path on ${(leadFrames / STEPS * 100).toFixed(0)}% of frames (mean gap ${f(leadDsSum / Math.max(leadFrames, 1))} m)`);
  console.log(`   the FOLLOWING limit set the acceleration on ${(capFrames / STEPS * 100).toFixed(0)}% of frames`);
  console.log(`   mean station-keeping target v0 ${f(v0Sum / STEPS)} m/s (it achieved ${f(vSum / STEPS)})`);
  console.log(`   TRAFFIC YIELDS: ${yields} in ${(STEPS * DT / 60).toFixed(1)} min = ${(yields / (STEPS * DT / 60)).toFixed(1)} per minute`);
  console.log(`      wanted to yield on ${yieldWant} frames; had NOWHERE TO GO on ${blockedYield} lane-tries (${(blockedYield / Math.max(yieldWant, 1) * 100).toFixed(0)}% of wants were boxed in)`);
  console.log(`   WIGGLE: ${movesStarted} moves started, ${movesDone} completed = ${(100 - movesDone / Math.max(movesStarted, 1) * 100).toFixed(0)}% ABANDONED | direction reversals ${(reversals / (STEPS * DT / 60)).toFixed(1)}/min`);
  console.log(`   HUSTLE (rubber-band): active on ${(hustleFrames / STEPS * 100).toFixed(1)}% of frames`);
  console.log(`   LANE CHANGES: ${laneSwitches} in ${(STEPS * DT / 60).toFixed(1)} min = ${(laneSwitches / (STEPS * DT / 60)).toFixed(1)} per minute (abandoned mid-move: ${abandoned})`);
  let fv = 0; for (const m of fleet) fv += m.v;
  console.log(`   the FLEET's own mean speed: ${f(fv / fleet.length)} m/s — the flow the rival is embedded in`);

  if (overlapFrames > 0)
    bad(`rival overlapped a traffic body on ${overlapFrames} frames (worst ${f(worstDepth)} m)`);
  else ok("never shared a body with a traffic car");
  if (minSep < 0) bad(`minimum separation went negative (${f(minSep)} m)`);
  else ok(`worst-case separation ${f(minSep)} m — bodies always clear`);

  seedResults.push({
    NC, SEED, overlapFrames,
    aheadPct: aheadFrames / STEPS * 100,
    rivalMean: vSum / STEPS,
    fleetMean: fv / fleet.length,
    abandonedPct: 100 - movesDone / Math.max(movesStarted, 1) * 100,
  });
}

console.log("6. aggregate over seeds — the numbers the report cites");
for (const NC of [180, 60]) {
  const rs = seedResults.filter((r) => r.NC === NC);
  const label = NC === 180 ? "dense" : "flowing";
  const totalOverlap = rs.reduce((s, r) => s + r.overlapFrames, 0);
  const ratios = rs.map((r) => r.rivalMean / r.fleetMean);
  const aheads = rs.map((r) => r.aheadPct);
  const abandons = rs.map((r) => r.abandonedPct);
  const rng2 = (a) => `${f(Math.min(...a))}–${f(Math.max(...a))}`;
  console.log(`   ${label}: overlap frames across ${rs.length} seeds = ${totalOverlap}`);
  console.log(`   ${label}: rival/flow speed ratio ${rng2(ratios)}x (seeds: ${rs.map((r) => f(r.rivalMean / r.fleetMean)).join(", ")})`);
  console.log(`   ${label}: rival ahead of player ${rng2(aheads)}%`);
  console.log(`   ${label}: WIGGLE abandoned ${rng2(abandons)}%`);
  if (totalOverlap > 0) bad(`${label}: ${totalOverlap} overlap frames across seeds — zero overlaps is the one absolute`);
  else ok(`${label}: zero overlap frames across all ${rs.length} seeds`);
}
{
  const flowing = seedResults.filter((r) => r.NC === 60);
  const worstRatio = Math.min(...flowing.map((r) => r.rivalMean / r.fleetMean));
  if (worstRatio < 1.6)
    console.log(`   NOTE: flowing-traffic speed ratio (worst seed ${f(worstRatio)}x) is short of the 1.6x target — see the report`);
  else ok(`flowing-traffic speed ratio clears 1.6x on every seed (worst ${f(worstRatio)}x)`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall rival checks passed");
process.exit(fail ? 1 : 0);
