/* Browser-free simulation of the HORN / HEADLIGHT-FLASH yield (the HAIL block
   in traffic.ts: rollDriver's yieldMax, hailGesture, yieldLane, hailRoll).

   The mechanic has to satisfy four things at once and they pull against each
   other, which is why it wants a harness rather than an eyeball:

     1. it must NOT work from a distance ("it shouldn't work where I'm far away
        and they move because I'm honking from far away"),
     2. it must reach exactly ONE car — the one in front — and not the
        neighbours,
     3. it must never be a button: most cars must ignore you, forever, however
        long you lean on the horn,
     4. and a car that does move must never be shoved into the player or into
        another body to do it.

   (1) and (3) are the ones that are easy to get wrong in opposite directions,
   and (3) is measured against a curve whose whole point is that it saturates —
   so the number that matters is not "did it work" but "what does it converge
   to after a hundred gestures".

   Same contract as test/traffic-merge-sim.mjs and test/rival-sim.mjs:
   traffic.ts pulls in three.js and a live scene, so the arithmetic under test
   is reimplemented here against the REAL corridor.ts geometry. If the formulas
   drift from traffic.ts that is a bug in THIS file — keep them in lockstep by
   eye. The constants below are transcribed from the HAIL / ARCH blocks.

   Usage: node test/hail-sim.mjs
          HAIL_SIM_GATE=fixed node test/hail-sim.mjs   (A/B the superseded gate:
              a flat 55 m window with no speed term, which lets a car 3.7 s up
              the road yield to a honk in slow traffic)
          HAIL_SIM_VERBOSE=1 node test/hail-sim.mjs    (per-scenario lines) */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "hailsim-"));
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
const { getCorridor } = await import(path.join(dir, "corridor.js"));
const c = getCorridor();

let fail = 0;
const bad = (m) => { console.log("  FAIL " + m); fail++; };
const ok = (m) => console.log("  ok   " + m);
const f = (n) => n.toFixed(2);
const pc = (n) => (n * 100).toFixed(1) + "%";
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

/* ================= mirrors traffic.ts ================= */
const LANE_FOLLOW_RATE = 3.4;

const ARCH = [
  { spd: [0.72, 0.83], gap: [1.35, 1.62], acc: [0.72, 0.85], lane: [0, 0.12], react: [0.42, 0.6] },
  { spd: [0.85, 0.95], gap: [1.12, 1.34], acc: [0.85, 0.96], lane: [0.15, 0.38], react: [0.32, 0.44] },
  { spd: [0.95, 1.08], gap: [0.94, 1.12], acc: [0.96, 1.06], lane: [0.4, 0.62], react: [0.22, 0.34] },
  { spd: [1.08, 1.2], gap: [0.82, 0.95], acc: [1.06, 1.18], lane: [0.64, 0.86], react: [0.18, 0.26] },
  { spd: [1.2, 1.32], gap: [0.68, 0.82], acc: [1.18, 1.32], lane: [0.88, 1], react: [0.12, 0.2] },
];

const HAIL = {
  near: 5, far: 55, reachT: 0.9, nearAlways: 18, side: 3.0,
  cd: 0.9, holdRearm: 1.0,
  K: 2.6, tau: 6.0, pFull: 2.5, wMin: 0.55,
  ceil: [[0.55, 0.80], [0.45, 0.70], [0.28, 0.55], [0.12, 0.34], [0.02, 0.15]],
  stoneWall: 0.08, stoneCeil: [0.0, 0.03],
  heavyCeil: 0.45, policeCeil: 0.02, ceilCap: 0.88,
  moveP: 0.68, boost: 1.22, boostT: 4.5, ackT: 1.9, yieldHold: 6,
  annoyAfter: 6, annoyCeil: 0.30, annoyP: 0.18, annoyDrop: 0.82, annoyT: 1.3,
};

/* The superseded gate, kept so the A/B below is against something real rather
   than against a description of it: a flat metre window, no speed term. */
const GATE = process.env.HAIL_SIM_GATE === "fixed" ? "fixed" : "headway";
const reachOf = (pv) =>
  GATE === "fixed" ? HAIL.far : clamp(pv * HAIL.reachT, HAIL.nearAlways, HAIL.far);

/* ---- rollDriver, reduced to what the hail model reads ---- */
function rollDriver(rng, type) {
  const heavy = type === "truck" || type === "bus";
  let r = rng();
  if (type === "police") r = 0.74 + r * 0.18;
  else if (heavy) r = Math.min(r, 0.66);
  const idx = r < 0.1 ? 0 : r < 0.3 ? 1 : r < 0.72 ? 2 : r < 0.92 ? 3 : 4;
  const A = ARCH[idx];
  const R = (p) => p[0] + rng() * (p[1] - p[0]);
  const d = {
    spd: R(A.spd), gap: R(A.gap), acc: R(A.acc), lane: R(A.lane), react: R(A.react),
    idx,
  };
  if (rng() < HAIL.stoneWall) d.yieldMax = R(HAIL.stoneCeil);
  else {
    let y = R(HAIL.ceil[idx]);
    if (heavy) y *= HAIL.heavyCeil;
    else if (type === "police") y = Math.min(y, HAIL.policeCeil);
    d.yieldMax = Math.min(y, HAIL.ceilCap);
  }
  return d;
}

/* ---- hailRoll's dice: q(k) walking C(k) = A·(1 − e^(−k/K)) ---- */
function qOf(A, k) {
  const cPrev = A * (1 - Math.exp(-(k - 1) / HAIL.K));
  return (A * (1 - Math.exp(-k / HAIL.K)) - cPrev) / (1 - cPrev);
}
function wOf(p) {
  return HAIL.wMin + ((1 - HAIL.wMin) * Math.min(p, HAIL.pFull)) / HAIL.pFull;
}

/* The population of cars the road actually puts in front of you. trySpawnHwy's
   type mix, transcribed: mostly cars, some heavies, the odd police car. */
function rollType(rng) {
  const r = rng();
  if (r < 0.055) return "truck";
  if (r < 0.075) return "bus";
  if (r < 0.09) return "police";
  return "car";
}

/* =====================================================================
   PART A — the compliance curve over the real roster.
   Pure arithmetic: no geometry, no driving. Answers "is this a button?".
   ===================================================================== */
function partA() {
  console.log("\n---- A. compliance over the fleet (Monte Carlo through rollDriver) ----");
  const N = 400000;
  const rng = mulberry32(20260826);
  const marks = [1, 3, 5, 10, 20, 100];
  const hit = new Array(marks.length).fill(0);
  let ceilSum = 0, stone = 0;
  /* Fastest cadence the cooldown permits, so pressure sits at its ceiling —
     this is the BEST case for the player, deliberately. */
  const wBurst = wOf(HAIL.pFull);
  for (let i = 0; i < N; i++) {
    const d = rollDriver(rng, rollType(rng));
    ceilSum += d.yieldMax;
    if (d.yieldMax < 0.10) stone++;
    let done = false;
    for (let mi = 0, k = 1; mi < marks.length; mi++) {
      for (; k <= marks[mi]; k++) {
        if (done) break;
        /* first gesture of a burst is isolated; the rest carry full weight */
        const w = k === 1 ? wOf(1) : wBurst;
        if (rng() < qOf(d.yieldMax, k) * w) done = true;
      }
      if (done) hit[mi]++;
    }
  }
  console.log(`   fleet mean ceiling ${f(ceilSum / N)} | ${pc(stone / N)} of drivers sit under a 10% ceiling`);
  console.log("   chance a random car in front has yielded after k gestures:");
  marks.forEach((m, i) => console.log(`      k=${String(m).padStart(3)}  ${pc(hit[i] / N)}`));

  const one = hit[0] / N, ever = hit[marks.length - 1] / N;
  if (one > 0.20) bad(`a single gesture works ${pc(one)} of the time — that is a button`);
  else ok(`a single gesture works ${pc(one)} of the time`);
  if (ever > 0.55) bad(`spamming converges to ${pc(ever)} — no such thing as a stubborn car`);
  else ok(`spamming converges to ${pc(ever)}, so ${pc(1 - ever)} of cars never move for you at all`);
  /* the saturation is the whole design: 20 and 100 must be near-identical */
  const drift = hit[marks.length - 1] / N - hit[marks.length - 2] / N;
  if (drift > 0.02) bad(`k=20 → k=100 still gains ${pc(drift)} — the curve is not saturating`);
  else ok(`k=20 → k=100 gains only ${pc(drift)} — the curve is flat, spam is worthless`);
}

/* =====================================================================
   PART B — the driving sim: does the gesture reach the right car, from the
   right distance, and can it ever put a body somewhere illegal?
   ===================================================================== */
const Z_IN = 200, Z_OUT = 1150;

function makeSim(seed) {
  const rng = mulberry32(seed);
  const rand = (a, b) => a + rng() * (b - a);
  /* The hail dice draw from their OWN stream. Sharing `rng` would make the
     no-honk control arm diverge from the honking arm on the very first roll —
     different traffic, not the same traffic minus the mechanic — and the
     overlap delta would then be measuring chaos rather than the feature. */
  const hrng = mulberry32(seed ^ 0x5eed);
  const hrand = (a, b) => a + hrng() * (b - a);
  const cars = [];
  let nextId = 0;

  /* laneClearAt, transcribed — including the PLAYER branch, which keeps its
     full closing-speed terms whatever envelope the NPC half was passed. That
     rule is what makes a yield safe, so the sim must carry it verbatim. */
  function laneClearAt(n, s, off2, back = 13.5, fwd = 23.5, backC = 3.0, fwdC = 2.0) {
    for (const m of cars) {
      if (m === n || m.wreck) continue;
      if (Math.abs(m.offCur - off2) > 2.2) continue;
      const ds = m.s - s;
      const halfL = (m.L + n.L) / 2;
      const backNeed = halfL + back + backC * Math.max(0, m.v - n.v);
      const fwdNeed = halfL + fwd + fwdC * Math.max(0, n.v - m.v);
      if (ds > -backNeed && ds < fwdNeed) return false;
    }
    if (Math.abs(P.off - off2) < 2.2) {
      const ds = P.s - s;
      const halfL = (4.5 + n.L) / 2;
      const backNeed = halfL + 6 + 3.0 * Math.max(0, P.v - n.v);
      const fwdNeed = halfL + 9 + 2.0 * Math.max(0, n.v - P.v);
      if (ds > -backNeed && ds < fwdNeed) return false;
    }
    return true;
  }

  /* yieldLane: toward the kerb only, gap-checked, and never onto the player */
  function yieldLane(n, pOff) {
    if (n.pendK >= 0 || n.blink !== 0 || n.laneK <= 0) return -1;
    const k2 = n.laneK - 1;
    const off2 = c.laneOffset(k2, n.s);
    /* the URGENT envelope, same as yieldToRival — see yieldLane in traffic.ts */
    if (!laneClearAt(n, n.s, off2, 1.2 + 0.25 * n.v, 2.5 + 0.35 * n.v)) return -1;
    if (Math.abs(pOff - off2) < 2.2) return -1;
    return k2;
  }

  const P = { s: 0, off: 0, v: 0, laneK: 0 };

  const stats = {
    gestures: 0, reached: 0, rolled: 0,
    moved: 0, sped: 0, annoyed: 0,
    couldMoveButSped: 0, boxedSoSped: 0,
    carsHailed: new Set(), carsComplied: 0, couldMove: 0,
    targetWasNearest: 0, targetOffLane: 0,
  };

  function spawn(z) {
    const nl = Math.min(c.lanes(z), c.lanes(z + 300));
    const type = rollType(rng);
    const drv = rollDriver(rng, type);
    const heavy = type === "truck" || type === "bus";
    const q = clamp(drv.spd - 0.72 + rand(-0.18, 0.18), 0, 0.99) / 0.62;
    const laneK = Math.min(nl - 1, Math.floor(q * nl));
    const off = c.laneOffset(laneK, z);
    for (const m of cars) {
      if (Math.abs(m.offCur - off) > 2.2) continue;
      if (Math.abs(m.s - z) < 20) return false;
    }
    if (Math.abs(P.off - off) < 2.2 && Math.abs(P.s - z) < 24) return false;
    const L = heavy ? 9.5 : 4.5;
    const n = {
      id: nextId++, type, L, W: heavy ? 2.4 : 1.87,
      s: z, v: 0, v0: (rand(24, 30) + laneK * 1.1) * drv.spd,
      laneK, pendK: -1, blink: 0, blinkT: 0, turnCd: rand(2, 8),
      offCur: off, offT: off, laneRate: c.lanePitch(z) / 3,
      drv, pT: rng() * drv.react, pLead: { ds: Infinity, v: 0 },
      hailGest: 0, hailP: 0, hailAt: -1e9, hailDone: false, hailAck: 0, hailMad: 0,
      nudgeT: 0, wreck: false,
      /* bookkeeping only — not state traffic.ts carries */
      reacted: 0,
    };
    n.v = n.v0 * rand(0.85, 1.0);
    cars.push(n);
    return true;
  }

  /* hailRoll, transcribed. Returns what the car decided, for the histograms. */
  function hailRoll(n, now) {
    if (n.hailDone) return "done";
    if (now - n.hailAt < HAIL.cd) return "cooldown";

    const pOff = P.off; // straight-ish corridor: offsets transfer directly
    const over = yieldLane(n, pOff);
    const canSpeed = n.pLead.ds > 22 && n.v < n.v0 * 1.15;
    if (over < 0 && !canSpeed) return "nothing-it-can-do";

    n.hailP = n.hailP * Math.exp(-(now - n.hailAt) / HAIL.tau) + 1;
    n.hailAt = now;
    const k = ++n.hailGest;
    stats.rolled++;
    stats.carsHailed.add(n.id);

    const A = n.drv.yieldMax;
    const q = qOf(A, k);
    const w = wOf(n.hailP);

    if (hrng() < q * w) {
      n.hailDone = true;
      n.reacted++;
      if (over >= 0) stats.couldMove++;
      if (over >= 0 && (!canSpeed || hrng() < HAIL.moveP)) {
        const off2 = c.laneOffset(over, n.s);
        const pitch = c.lanePitch(n.s);
        n.pendK = over;
        n.blink = off2 < n.offCur ? -1 : 1;
        n.blinkT = hrand(0.5, 0.9);
        n.laneRate = pitch / lerp(3.2, 2, n.drv.lane);
        n.turnCd = Math.max(n.turnCd, HAIL.yieldHold);
        /* attribution window: the signalled crossing is ~2 s at these rates,
           so 4 s covers the manoeuvre and the beat after it settles. Any
           overlap this car is party to inside it is blamed on the honk — the
           only way to tell a hail bug from the harness's own coarse IDM. */
        n.hailMoveT = 4;
        stats.moved++; stats.carsComplied++;
        return "moved";
      }
      n.nudgeT = HAIL.boostT;
      n.hailAck = HAIL.ackT;
      /* NOT marked as a hail move: a car that speeds up accelerates AWAY from
         the player and cannot put a body anywhere it was not already going.
         Only the lane change crosses road somebody else may be on, and that
         is what the attribution window is for. */
      stats.sped++; stats.carsComplied++;
      /* was the speed-up a CHOICE or the only option? yieldLane already told
         us: over >= 0 means a kerbward lane was open and the coin still came
         up "just get on with it". */
      if (over >= 0) stats.couldMoveButSped++; else stats.boxedSoSped++;
      return "sped";
    }

    if (k >= HAIL.annoyAfter && A < HAIL.annoyCeil && hrng() < HAIL.annoyP) {
      n.hailMad = HAIL.annoyT;
      /* the snap IS a brake-tap in front of the player, so unlike the boost it
         can genuinely raise rear-end risk. Attribute it. */
      n.hailMoveT = HAIL.annoyT + 1;
      n.hailDone = true;
      n.reacted++;
      stats.annoyed++;
      return "annoyed";
    }
    return "refused";
  }

  /* hailGesture: pick the ONE car, then roll it */
  function hailGesture(now) {
    stats.gestures++;
    const reach = reachOf(P.v);
    let best = null, bestScore = Infinity;
    let nearestSameLane = null, nsd = Infinity;
    for (const n of cars) {
      if (n.wreck) continue;
      const ahead = n.s - P.s;           // corridor is the player's forward axis
      const side = Math.abs(n.offCur - P.off);
      if (side < 1.9 && ahead > 0 && ahead < nsd) { nsd = ahead; nearestSameLane = n; }
      if (ahead < HAIL.near || ahead > reach) continue;
      if (side > HAIL.side) continue;
      const score = ahead + side * 8;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (!best) return null;
    stats.reached++;
    if (best === nearestSameLane) stats.targetWasNearest++;
    if (Math.abs(best.offCur - P.off) > 1.9) stats.targetOffLane++;
    return { car: best, res: hailRoll(best, now) };
  }

  function step(dt, now) {
    for (const n of cars) {
      const drv = n.drv;
      let v0 = n.v0;
      if (n.nudgeT > 0) { n.nudgeT -= dt; v0 *= HAIL.boost; }
      if (n.hailAck > 0) n.hailAck -= dt;
      if (n.hailMad > 0) { n.hailMad -= dt; v0 *= HAIL.annoyDrop; }
      if (n.hailMoveT > 0) n.hailMoveT -= dt;

      /* ordinary discretionary lane changes stay on, so the honk-induced move
         is measured inside real traffic rather than a frozen diorama */
      n.turnCd -= dt;
      if (n.pendK < 0 && n.blink === 0 && n.turnCd <= 0 && drv.lane > 0.5) {
        const nl = c.lanes(n.s);
        for (const k2 of [n.laneK + 1, n.laneK - 1]) {
          if (k2 < 0 || k2 > nl - 1) continue;
          const off2 = c.laneOffset(k2, n.s);
          if (laneClearAt(n, n.s, off2, 9, 16)) {
            n.pendK = k2;
            n.blink = off2 < n.offCur ? -1 : 1;
            n.blinkT = rand(1, 2);
            n.laneRate = c.lanePitch(n.s) / lerp(3, 2, drv.lane);
            n.turnCd = rand(4, 12);
            break;
          }
        }
        if (n.pendK < 0) n.turnCd = rand(2, 5);
      }

      /* perception (the player is an obstacle like anything else) */
      n.pT -= dt;
      if (n.pT <= 0) {
        let ds = Infinity, lv = 0;
        for (const m of cars) {
          if (m === n) continue;
          const ahead = m.s - n.s;
          if (ahead <= 0 || ahead > 70) continue;
          if (Math.abs(m.offCur - n.offCur) > (m.blink !== 0 ? 2.9 : 1.9)) continue;
          const d = Math.max(ahead - (m.L + n.L) / 2, 0.1);
          if (d < ds) { ds = d; lv = m.v; }
        }
        const pa = P.s - n.s;
        if (pa > 0 && pa < 70 && Math.abs(P.off - n.offCur) < 1.9) {
          const d = Math.max(pa - (4.5 + n.L) / 2, 0.1);
          if (d < ds) { ds = d; lv = P.v; }
        }
        n.pLead.ds = ds; n.pLead.v = lv;
        n.pT = drv.react * rand(0.8, 1.2);
      } else if (n.pLead.ds < 1e8) {
        n.pLead.ds = Math.max(0.15, n.pLead.ds + (n.pLead.v - n.v) * dt);
      }
      if (n.pLead.ds < 11) n.pT = Math.min(n.pT, 0.06);
      const lead = n.pLead.ds < 1e8 ? n.pLead : null;

      const aMax = 1.6 * drv.acc, bCom = 2.3, T = 1.25 * drv.gap,
        s0 = 2.2 + 1.4 * (drv.gap - 1);
      let acc;
      if (lead) {
        const dv = n.v - lead.v;
        const sStar = s0 + n.v * T + (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
        acc = aMax * (1 - Math.pow(n.v / v0, 4) - Math.pow(sStar / Math.max(lead.ds, 0.55), 2));
      } else acc = aMax * (1 - Math.pow(n.v / v0, 4));
      acc = clamp(acc, -8.5, 3.2);
      n.v = Math.max(0, n.v + acc * dt);
      n.s += n.v * dt;

      if (n.pendK >= 0) {
        n.blinkT -= dt;
        if (n.blinkT <= 0) { n.laneK = n.pendK; n.pendK = -1; }
      }
      n.offT = c.laneOffset(n.laneK, n.s);
      const dOff = n.offT - n.offCur;
      const rate = n.blink !== 0 ? n.laneRate || c.lanePitch(n.s) / 3 : LANE_FOLLOW_RATE;
      if (Math.abs(dOff) > 0.02) {
        n.offCur += clamp(dOff, -rate * dt, rate * dt);
        if (n.blink !== 0 && n.pendK < 0 && Math.abs(dOff) < 0.35) n.blink = 0;
      } else {
        n.offCur = n.offT;
        if (n.blink !== 0 && n.pendK < 0) n.blink = 0;
      }
    }

    /* the overlap resolver, transcribed (traffic.ts, reduced to corridor
       space). Without it the harness's own coarse IDM leaves rear-end
       interpenetrations that have nothing to do with the mechanic. */
    for (let a = 0; a < cars.length; a++) {
      const A = cars[a];
      for (let b = a + 1; b < cars.length; b++) {
        const B = cars[b];
        const dz = B.s - A.s, dOff = B.offCur - A.offCur;
        const need = (A.L + B.L) / 2 + 0.6;
        if (Math.abs(dOff) > 1.7 || Math.abs(dz) > need) continue;
        const rear = dz > 0 ? A : B, front = dz > 0 ? B : A;
        rear.v = Math.min(rear.v, front.v * 0.9);
        rear.s = rear.s - (need - Math.abs(dz)) * 0.5;
      }
    }
    return null;
  }

  return { cars, spawn, step, hailGesture, P, stats, rng, rand, laneClearAt };
}

/* ---- one scenario: the player tailgates traffic and honks on a schedule ----
   The player deliberately runs faster than the flow and follows close, because
   that is the situation the mechanic exists for: something is in your way and
   you want it gone. A polite player never triggers it and would measure
   nothing. `noHail` runs the identical seeded scenario with the gestures
   removed, which is the control the overlap numbers are read against. */
function run(seed, { playerV, hz, minutes = 3, noHail = false }) {
  const sim = makeSim(seed);
  const { cars, P } = sim;
  P.s = Z_IN + 60; P.v = playerV; P.laneK = 2; P.off = c.laneOffset(2, P.s);

  for (let z = Z_IN; z < Z_OUT; z += 12) if (sim.rng() < 0.9) sim.spawn(z);
  for (const n of cars) n.v = n.v0 * 0.9;

  const dt = 1 / 60;
  let now = 0, nextHail = 1.0;
  let overlapFrames = 0, worstPen = 0, playerOverlap = 0, worstPlayerPen = 0;
  let hailOverlapFrames = 0, hailPlayerOverlap = 0, multiReactFrames = 0;
  let followSum = 0, followN = 0, heldT = 0;

  const steps = Math.round((minutes * 60) / dt);
  for (let i = 0; i < steps; i++) {
    now += dt;

    /* The player: hold a lane, close on whatever is in front, never crash into
       it. A simple IDM against its own leader — the point is a realistic
       following distance distribution, not a driving model. */
    let ds = Infinity, lv = 0;
    for (const m of cars) {
      const a = m.s - P.s;
      if (a <= 0 || a > 120) continue;
      if (Math.abs(m.offCur - P.off) > 1.9) continue;
      const d = Math.max(a - (m.L + 4.5) / 2, 0.1);
      if (d < ds) { ds = d; lv = m.v; }
    }
    {
      /* an impatient tailgater: 0.45 s headway, 2 m standstill gap */
      const aMax = 4.0, bCom = 4.0, T = 0.45, s0 = 2.0;
      let acc;
      if (ds < 1e8) {
        const dv = P.v - lv;
        const sStar = s0 + P.v * T + (P.v * dv) / (2 * Math.sqrt(aMax * bCom));
        acc = aMax * (1 - Math.pow(P.v / playerV, 4) - Math.pow(sStar / Math.max(ds, 0.55), 2));
        followSum += ds; followN++;
      } else acc = aMax * (1 - Math.pow(P.v / playerV, 4));
      P.v = Math.max(0, P.v + clamp(acc, -9, 5) * dt);
      P.s += P.v * dt;
      P.off = c.laneOffset(P.laneK, P.s);
    }

    /* The player gives up and goes around. Nobody sits behind one refusing car
       for three minutes, and if the harness does, the whole run measures a
       sample of one driver. Every `patience` seconds of being held up, hop a
       lane — which is also what puts a fresh car in front to hail. */
    heldT = ds < 30 && P.v < playerV * 0.92 ? heldT + dt : 0;
    if (heldT > 4) {
      heldT = 0;
      const nl = c.lanes(P.s);
      const k2 = P.laneK + (sim.rng() < 0.5 ? 1 : -1);
      const o2 = k2 >= 0 && k2 <= nl - 1 ? c.laneOffset(k2, P.s) : null;
      /* and it must not TELEPORT onto somebody — the harness's player has no
         collision response, so an unchecked hop invents thousands of overlap
         frames and buries the signal this file exists to measure */
      let free = o2 !== null;
      if (free) {
        for (const m of cars) {
          if (Math.abs(m.offCur - o2) > 2.2) continue;
          if (Math.abs(m.s - P.s) < (m.L + 4.5) / 2 + 12) { free = false; break; }
        }
      }
      if (free) { P.laneK = k2; P.off = o2; }
    }

    /* honk / flash on a fixed cadence, exactly as a player mashing the key
       would (the per-car cd is what limits it, not this) */
    const before = cars.map((n) => n.reacted);
    if (!noHail && now >= nextHail) { sim.hailGesture(now); nextHail = now + 1 / hz; }
    sim.step(dt, now);
    let reactedNow = 0;
    for (let j = 0; j < cars.length; j++) if (cars[j].reacted !== before[j]) reactedNow++;
    if (reactedNow > 1) multiReactFrames++;

    /* overlap audit — every pair, plus the player against every car */
    for (let a = 0; a < cars.length; a++) {
      const A = cars[a];
      for (let b = a + 1; b < cars.length; b++) {
        const B = cars[b];
        if (Math.abs(B.offCur - A.offCur) > (A.W + B.W) / 2) continue;
        const need = (A.L + B.L) / 2;
        const dz = Math.abs(B.s - A.s);
        if (dz < need) {
          overlapFrames++;
          worstPen = Math.max(worstPen, need - dz);
          if (A.hailMoveT > 0 || B.hailMoveT > 0) hailOverlapFrames++;
        }
      }
      if (Math.abs(A.offCur - P.off) <= (A.W + 1.87) / 2) {
        const need = (A.L + 4.5) / 2;
        const dz = Math.abs(A.s - P.s);
        if (dz < need) {
          playerOverlap++;
          worstPlayerPen = Math.max(worstPlayerPen, need - dz);
          if (A.hailMoveT > 0) hailPlayerOverlap++;
        }
      }
    }

    /* recycle */
    for (let j = cars.length - 1; j >= 0; j--) {
      if (cars[j].s > P.s + 700 || cars[j].s < P.s - 200) cars.splice(j, 1);
    }
    while (cars.length < 55) {
      if (!sim.spawn(P.s + 180 + sim.rng() * 500)) break;
    }
  }
  return {
    sim, overlapFrames, worstPen, playerOverlap, worstPlayerPen,
    hailOverlapFrames, hailPlayerOverlap, multiReactFrames, minutes,
    meanFollow: followN ? followSum / followN : Infinity,
  };
}

/* =====================================================================
   PART C — the range gate, measured directly. One car straight ahead at a
   fixed distance, honked at relentlessly, over many drivers. This is the
   "honking from far away must do nothing" test and it is the one the fixed
   metre gate fails.
   ===================================================================== */
function rangeCurve(playerV, dists, trials = 4000) {
  const rng = mulberry32(77 + Math.round(playerV * 10));
  const rows = [];
  for (const d of dists) {
    let hit = 0;
    for (let t = 0; t < trials; t++) {
      const reach = reachOf(playerV);
      if (d < HAIL.near || d > reach) continue; // gesture never lands
      const drv = rollDriver(rng, rollType(rng));
      /* eight gestures at the fastest cadence the cooldown allows */
      let done = false;
      let p = 0;
      for (let k = 1; k <= 8 && !done; k++) {
        p = p * Math.exp(-HAIL.cd / HAIL.tau) + 1;
        if (rng() < qOf(drv.yieldMax, k) * wOf(p)) done = true;
      }
      if (done) hit++;
    }
    rows.push({ d, rate: hit / trials });
  }
  return rows;
}

/* ===================== run ===================== */
console.log(`hail-sim — gate: ${GATE}` + (GATE === "fixed" ? "  (SUPERSEDED, A/B arm)" : ""));

partA();

console.log("\n---- B. the range gate: one car dead ahead, 8 gestures at it ----");
for (const pv of [15, 25, 40, 70]) {
  const reach = reachOf(pv);
  const rows = rangeCurve(pv, [8, 15, 25, 35, 45, 55, 70]);
  console.log(`   player ${String(pv).padStart(2)} m/s — reach ${f(reach)} m (headway ${f(reach / pv)} s)`);
  console.log("      " + rows.map((r) => `${r.d}m:${pc(r.rate)}`).join("  "));
}
{
  /* the assertions the user's words translate to */
  const slowFar = rangeCurve(15, [45, 55])[0].rate + rangeCurve(15, [45, 55])[1].rate;
  if (slowFar > 0.001) bad(`at 15 m/s a car 45-55 m ahead still yields (${pc(slowFar)}) — that is honking from a distance`);
  else ok("at 15 m/s nothing 45 m+ ahead can hear you at all");
  const slowNear = rangeCurve(15, [8, 15])[1].rate;
  if (slowNear < 0.10) bad(`at 15 m/s a car 15 m ahead only yields ${pc(slowNear)} — the floor is too tight`);
  else ok(`at 15 m/s a car 15 m ahead still yields ${pc(slowNear)} — crawling traffic still works`);
  const fastFar = rangeCurve(70, [55])[0].rate;
  if (fastFar < 0.10) bad(`at 70 m/s a car 55 m ahead (0.8 s) yields only ${pc(fastFar)} — too tight at speed`);
  else ok(`at 70 m/s a car 55 m ahead is 0.79 s away and yields ${pc(fastFar)}`);
  const beyond = rangeCurve(70, [70])[0].rate;
  if (beyond > 0.001) bad(`70 m is hailable at 70 m/s — the absolute cap leaked`);
  else ok("nothing past 55 m is ever hailable, at any speed");
}

console.log("\n---- C. in traffic: one gesture, one car ----");
/* Many short runs rather than a few long ones: the quantity that needs a big
   sample is DISTINCT DRIVERS HAILED, and one long tailgate behind one stubborn
   car contributes exactly one of those however many gestures it racks up. */
const SCEN = [];
for (let i = 0; i < 40; i++) SCEN.push([100 + i, 26 + (i % 5) * 8]);
let totMoved = 0, totSped = 0, totAnnoy = 0, totCould = 0, totBoxed = 0, totCouldMove = 0;
let totGest = 0, totReach = 0, totRolled = 0, totOffLane = 0, totNearest = 0, totMulti = 0;
let totOverlap = 0, totHailOverlap = 0, totPlayerOverlap = 0, worstAny = 0;
let totHailPlayerOverlap = 0, ctlOverlap = 0, ctlPlayerOverlap = 0, followSum = 0;
let totCars = 0, totComplied = 0;
for (const [seed, playerV] of SCEN) {
  const r = run(seed, { playerV, hz: 1.5, minutes: 2 });
  const ctl = run(seed, { playerV, hz: 1.5, minutes: 2, noHail: true });
  const s = r.sim.stats;
  totMoved += s.moved; totSped += s.sped; totAnnoy += s.annoyed;
  totCould += s.couldMoveButSped; totBoxed += s.boxedSoSped; totCouldMove += s.couldMove;
  totGest += s.gestures; totReach += s.reached; totRolled += s.rolled;
  totOffLane += s.targetOffLane; totNearest += s.targetWasNearest;
  totMulti += r.multiReactFrames;
  totOverlap += r.overlapFrames; totHailOverlap += r.hailOverlapFrames;
  totPlayerOverlap += r.playerOverlap; totHailPlayerOverlap += r.hailPlayerOverlap;
  totCars += s.carsHailed.size; totComplied += s.carsComplied;
  ctlOverlap += ctl.overlapFrames; ctlPlayerOverlap += ctl.playerOverlap;
  followSum += r.meanFollow;
  worstAny = Math.max(worstAny, r.worstPen, r.worstPlayerPen);
  if (process.env.HAIL_SIM_VERBOSE) console.log(
    `   seed ${seed} @ ${String(playerV).padStart(2)} m/s (mean follow gap ${f(r.meanFollow)} m): ` +
    `${s.reached}/${s.gestures} gestures found a car, ${s.rolled} rolled → ` +
    `${s.moved} moved / ${s.sped} sped / ${s.annoyed} snapped`
  );
}
console.log(`   TOTAL: ${totGest} gestures, ${totReach} reached a car (${pc(totReach / totGest)}), ` +
  `${totRolled} got as far as the dice`);
console.log(`   mean following gap across the runs: ${f(followSum / SCEN.length)} m`);
console.log(`   reactions: ${totMoved} moved over, ${totSped} sped up, ${totAnnoy} snapped ` +
  `→ move/speed split ${pc(totMoved / (totMoved + totSped))} / ${pc(totSped / (totMoved + totSped))}`);
console.log(`   of the ${totSped} speed-ups, ${totBoxed} had NOWHERE to go (already in the kerb lane, or ` +
  `no gap) and ${totCould} could have moved over and chose not to`);
console.log(`   WHERE THERE WAS A CHOICE: ${totCouldMove} cars had an open kerb lane → ${totMoved} moved ` +
  `(${pc(totMoved / Math.max(1, totCouldMove))}), ${totCould} just sped up (${pc(totCould / Math.max(1, totCouldMove))}) ` +
  `— HAIL.moveP is ${HAIL.moveP}`);
console.log(`   PER CAR: ${totCars} distinct cars were hailed, ${totComplied} of them complied ` +
  `(${pc(totComplied / Math.max(1, totCars))}) — ${pc(1 - totComplied / Math.max(1, totCars))} never moved however long they were leant on`);
console.log(`   PER GESTURE: ${pc((totMoved + totSped) / Math.max(1, totRolled))} of the ${totRolled} rolls landed ` +
  `(most rolls are repeats at a car that has already refused, where q(k) has collapsed)`);
console.log(`   TARGET: it was the NEAREST car in the player's own lane on ${totNearest} of ${totReach} ` +
  `gestures (${pc(totNearest / Math.max(1, totReach))}); it was a car outside that lane at all on ` +
  `${totOffLane} (${pc(totOffLane / Math.max(1, totReach))})`);
console.log(`   NPC-NPC overlap frames: ${totOverlap} with honking, ${ctlOverlap} in the SAME seeds ` +
  `with honking off — of which ${totHailOverlap} involved a car mid-honk-move`);
console.log(`   NPC-player overlap frames: ${totPlayerOverlap} with honking, ${ctlPlayerOverlap} with it off ` +
  `— of which ${totHailPlayerOverlap} involved a car mid-honk-reaction (these are the harness's own ` +
  `player IDM rear-ending hard-braking traffic; it has no collision response)`);
console.log(`   worst penetration anywhere: ${f(worstAny)} m`);

if (totMulti > 0) bad(`${totMulti} frames had more than one car react to a single gesture`);
else ok("never more than one car reacted to a gesture — the whole run");
if (totOffLane / Math.max(1, totReach) > 0.15) bad(`${pc(totOffLane / totReach)} of gestures landed on a neighbour, not the car in front`);
else ok(`${pc(totOffLane / Math.max(1, totReach))} of gestures landed outside the player's lane`);
if (totNearest / Math.max(1, totReach) < 0.9) bad(`only ${pc(totNearest / totReach)} of gestures hit the nearest car in the player's own lane`);
else ok(`${pc(totNearest / Math.max(1, totReach))} of gestures hit the nearest car in the player's own lane`);
if (totHailPlayerOverlap > 0) bad(`a honk-induced reaction put a car inside the player ${totHailPlayerOverlap} times`);
else ok("no honk-induced reaction ever put a car inside the player");
/* The paired-seed arms CANNOT stay bit-identical: the moment one car reacts,
   the world it is in diverges, and every car behind it takes a different
   trajectory from then on. So the aggregate delta is a sanity band, not an
   equality — the hard test is the attribution above, which is exactly zero.
   A delta is also expected in the honking arm's favour of being worse: the
   annoyance reaction is a deliberate brake-tap in front of a player this
   harness gives no collision response and no brake pedal to. */
const pRatio = totPlayerOverlap / Math.max(1, ctlPlayerOverlap);
if (pRatio > 1.5) bad(`honking raised NPC-player overlap ${f(pRatio)}x over the control — beyond seed noise`);
else ok(`NPC-player overlap within seed noise of the control (${totPlayerOverlap} vs ${ctlPlayerOverlap}, ${f(pRatio)}x)`);
if (totHailOverlap > 0) bad(`${totHailOverlap} overlap frames involved a car making a honk-induced move`);
else ok("no honk-induced lane change ever produced an overlap");
if (totOverlap > ctlOverlap) bad(`honking ADDED ${totOverlap - ctlOverlap} overlap frames over the control`);
else ok(`honking added no overlap over the control (${totOverlap} vs ${ctlOverlap} background)`);
const comply = totComplied / Math.max(1, totCars);
if (comply > 0.45) bad(`${pc(comply)} of hailed cars complied — it reads as a button`);
else ok(`${pc(comply)} of hailed cars ever complied — most cars ignore you`);
/* "prefer moving over" can only be asked of cars that HAVE a lane to move
   into. A dawdler in the kerb lane has nowhere courteous to go and speeds up
   instead — by design, and it is also what happens on a real road. So the
   preference is measured among cars with the choice, against moveP. */
const moveRate = totMoved / Math.max(1, totCouldMove);
if (totCouldMove >= 10 && moveRate < 0.5)
  bad(`only ${pc(moveRate)} of cars WITH an open lane moved over — it should PREFER moving`);
else ok(`${pc(moveRate)} of cars with an open lane moved over (HAIL.moveP = ${HAIL.moveP})`);
if (totCouldMove >= 10 && totCould === 0)
  bad("every car that could move over did — the speed-up-anyway roll is not firing");
else ok(`${totCould} cars could have moved over and just sped up instead — the choice is not deterministic`);

console.log(fail ? `\n${fail} hail check(s) FAILED` : "\nall hail checks passed");
process.exit(fail ? 1 : 0);
