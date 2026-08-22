/* Browser-free simulation of the expressway lane-SHRINK merges (traffic.ts).

   The corridor drops 5 → 4 → 3 lanes over z 640..860. Every NPC caught in a
   dying lane has to merge out of it, and with heavy traffic that used to look
   glitchy: the anticipatory merge did nothing at all when the target lane had
   no gap, so cars held speed until the pavement ran out, were snapped across
   by the safety net into occupied slots, and the overlap resolver then shoved
   them around while two bodies shared one piece of road.

   traffic.ts itself pulls in three.js and a live scene, so — same contract as
   test/traffic-bias-check.mjs — this reimplements the updateHwy driving
   arithmetic (perception + IDM + the taper merge rules + offset tracking +
   the overlap resolver) against the real corridor.ts geometry. If the
   formulas here drift from traffic.ts, that's a bug in this file, not
   evidence either way — keep them in lockstep by eye.

   Two rule sets are run over the same seeded scenario:
     old  — pre-fix rules: roomy gap box only, no yield, spawner ignores the
            downstream lane count (expected to overlap; reported, not asserted)
     new  — zipper rules: single-lane hops only; length- and closing-speed-
            aware gap acceptance (tighter but still bumper-clear when the
            lane is nearly gone); yield braking while blocked, leaning to the
            lane edge with the blinker on so target-lane followers perceive
            the merger early and hold back; an IDM stop at the measured lane
            end when no slot ever opens; brisk crossings when urgent or from
            a crawl; spawns capped to the downstream lane count
   Assertions (new rules): zero body overlaps through the taper, no backward
   position jumps, lateral motion never faster than the sanctioned rates, and
   nobody exits the taper still indexed into a lane that no longer exists.

   Usage: node test/traffic-merge-sim.mjs */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "mergesim-"));
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
const f = (n) => n.toFixed(2);

/* mulberry32, same generator traffic.ts uses, seeded for repeatability */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* mirrors traffic.ts */
const LANE_FOLLOW_RATE = 3.4;

/* the shrink under test: 5 → 4 → 3 over z 640..860 (see LANE_STEPS) */
const Z_IN = 200;      // seeding starts here, well upstream (5 lanes)
const Z_OUT = 1150;    // recycle past here (3 lanes, settled)
const TAPER_LO = 600, TAPER_HI = 900; // window the overlap stats care about most

function makeSim(mode, seed) {
  const rng = mulberry32(seed);
  const rand = (a, b) => a + rng() * (b - a);
  const cars = [];
  let nextId = 0;
  const note = (n, m) => {
    if (process.env.MERGE_SIM_DEBUG) n.hist.push(m);
  };

  /* new rules: back/fwd are required clear-road gaps, lengths added per
     pair, both ends stretched by closing speed. old rules: the pre-fix
     static centre-to-centre box. */
  function laneClearAt(n, s, off2, back, fwd) {
    for (const m of cars) {
      if (m === n) continue;
      if (Math.abs(m.offCur - off2) > 2.2) continue;
      const ds = m.s - s;
      let backNeed, fwdNeed;
      if (mode === "new") {
        const halfL = (m.L + n.L) / 2;
        backNeed = halfL + (back ?? 13.5) + 3.0 * Math.max(0, m.v - n.v);
        fwdNeed = halfL + (fwd ?? 23.5) + 2.0 * Math.max(0, n.v - m.v);
      } else {
        backNeed = back ?? 18;
        fwdNeed = fwd ?? 28;
      }
      if (ds > -backNeed && ds < fwdNeed) return false;
    }
    return true;
  }

  /* trySpawnHwy's lane pick + spacing, reduced to the shrink question. The
     NEW spawner seeds for the downstream lane count (min over +300 m). */
  function spawn(z) {
    const nl = mode === "new"
      ? Math.min(c.lanes(z), c.lanes(z + 300))
      : c.lanes(z);
    const spd = rand(0.85, 1.2);
    const q = clamp(spd - 0.72 + rand(-0.18, 0.18), 0, 0.99) / 0.62;
    const laneK = Math.min(nl - 1, Math.floor(q * nl));
    const off = c.laneOffset(laneK, z);
    for (const m of cars) {
      if (Math.abs(m.offCur - off) > 2.2) continue;
      if (Math.abs(m.s - z) < 20) return false;
    }
    const L = rand(0, 1) < 0.1 ? 6.3 : 4.5;
    cars.push({
      id: nextId++, hist: [],
      L, W: 1.87,
      s: z, v: 0, v0: (rand(24, 30) + laneK * 1.1) * spd,
      laneK, pendK: -1, blink: 0, blinkT: 0, turnCd: rand(2, 8),
      offCur: off, offT: off,
      laneRate: c.lanePitch(z) / 3,
      drv: { lane: rng(), gap: rand(0.8, 1.4), acc: rand(0.8, 1.2), react: rand(0.12, 0.6) },
      pT: rng() * 0.4, pLead: { ds: Infinity, v: 0 },
    });
    const n = cars[cars.length - 1];
    n.v = n.v0 * rand(0.85, 1.0);
    return true;
  }

  /* one updateHwy step for every car (corridor space: s along, off lateral) */
  function step(dt) {
    for (const n of cars) {
      const nl = c.lanes(n.s);
      const drv = n.drv;

      /* taper merge — the block under test, kept in lockstep with updateHwy.
         New rules: single-lane hops only, blink gate (a lean-waiting car is
         re-admitted), speed-scaled urgent acceptance, lean-and-signal while
         blocked. */
      let mergeCap = Infinity;
      let stopDs = -1;
      const wasLean = (n.mergeLean || 0) !== 0;
      n.mergeLean = 0;
      if (mode === "new") {
        if (n.pendK < 0 && (n.blink === 0 || wasLean) && n.laneK <= nl - 1 && n.laneK > 0) {
          const aheadZ = n.s + clamp(n.v, 15, 32) * 9;
          const nlAhead = c.lanes(aheadZ);
          if (n.laneK > nlAhead - 1) {
            const k2 = n.laneK - 1;
            const off2 = c.laneOffset(k2, n.s);
            const urgent = c.lanes(n.s + Math.max(n.v, 8) * 3) - 1 < n.laneK;
            const clear = urgent
              ? laneClearAt(n, n.s, off2, 1.2 + 0.25 * n.v, 2.5 + 0.35 * n.v)
              : laneClearAt(n, n.s, off2);
            if (clear) {
              const brisk = urgent || n.v < 15;
              n.pendK = k2;
              note(n, `accept ${n.laneK}->${k2} s=${n.s.toFixed(0)} off=${n.offCur.toFixed(2)} urgent=${urgent} v=${n.v.toFixed(1)}`);
              n.blink = off2 < n.offCur ? -1 : 1;
              n.blinkT = brisk ? rand(0.2, 0.5) : rand(1, 2);
              n.laneRate = brisk
                ? c.lanePitch(n.s) / 1.4
                : c.lanePitch(n.s) / lerp(3, 2, drv.lane);
              n.turnCd = Math.max(n.turnCd, 2);
            } else {
              mergeCap = urgent ? -2.6 : -0.9;
              if (process.env.MERGE_SIM_DEBUG) {
                const ystate = `yield u=${urgent}`;
                if (n.lastY !== ystate) { n.lastY = ystate; note(n, `${ystate} s=${n.s.toFixed(0)} v=${n.v.toFixed(1)}`); }
              }
              if (urgent) {
                const maxBias = Math.max(0, c.lanePitch(n.s) / 2 - n.W / 2 - 0.25);
                n.mergeLean = (off2 < n.offCur ? -1 : 1) * (maxBias + 0.2);
                n.blink = off2 < n.offCur ? -1 : 1;
                n.laneRate = Math.max(n.laneRate, LANE_FOLLOW_RATE);
                // still blocked with the pavement running out: virtual
                // stopped leader a few metres short of the lane end
                let lo = 0, hi = Math.max(n.v, 4) * 3;
                if (c.lanes(n.s + hi) - 1 < n.laneK) {
                  for (let i = 0; i < 5; i++) {
                    const mid = (lo + hi) / 2;
                    if (c.lanes(n.s + mid) - 1 < n.laneK) hi = mid; else lo = mid;
                  }
                  stopDs = Math.max(0.3, lo - 6);
                }
              }
            }
          }
        }
      } else if (n.pendK < 0 && n.laneK <= nl - 1) {
        const aheadZ = n.s + clamp(n.v, 15, 32) * 9;
        const nlAhead = c.lanes(aheadZ);
        if (n.laneK > nlAhead - 1) {
          const k2 = Math.max(0, Math.min(n.laneK - 1, nlAhead - 1));
          const off2 = c.laneOffset(k2, n.s);
          if (k2 !== n.laneK && laneClearAt(n, n.s, off2)) {
            n.pendK = k2;
            n.blink = off2 < n.offCur ? -1 : 1;
            n.blinkT = rand(1, 2);
            n.laneRate = c.lanePitch(n.s) / lerp(3, 2, drv.lane);
            n.turnCd = Math.max(n.turnCd, 2);
          }
        }
      }
      /* hard safety net */
      if (n.laneK > nl - 1) {
        note(n, `SNAP ${n.laneK}->${nl - 1} s=${n.s.toFixed(0)} off=${n.offCur.toFixed(2)} v=${n.v.toFixed(1)}`);
        n.blink = c.laneOffset(nl - 1, n.s) < n.offCur ? -1 : 1;
        n.laneRate = Math.max(n.laneRate, c.lanePitch(n.s) / 1.4);
        n.laneK = nl - 1;
        n.pendK = -1;
        n.snaps = (n.snaps || 0) + 1;
        if (mode === "new") mergeCap = Math.min(mergeCap, -2.6);
      }

      /* perception: reaction-lagged leader, dead-reckoned in between */
      n.pT -= dt;
      if (n.pT <= 0) {
        let ds = Infinity, lv = 0;
        for (const m of cars) {
          if (m === n) continue;
          const ahead = m.s - n.s;
          if (ahead <= 0 || ahead > 70) continue;
          // a signalling car reads wider — the follower yields to the nose
          // easing over before the body is in-lane (new rules only)
          const lim = mode === "new" && m.blink !== 0 ? 2.9 : 1.9;
          if (Math.abs(m.offCur - n.offCur) > lim) continue;
          const d = Math.max(ahead - (m.L + n.L) / 2, 0.1);
          if (d < ds) { ds = d; lv = m.v; }
        }
        n.pLead.ds = ds;
        n.pLead.v = lv;
        n.pT = drv.react * rand(0.8, 1.2);
      } else if (n.pLead.ds < 1e8) {
        n.pLead.ds = Math.max(0.15, n.pLead.ds + (n.pLead.v - n.v) * dt);
      }
      if (n.pLead.ds < 11) n.pT = Math.min(n.pT, 0.06);
      let lead = n.pLead.ds < 1e8 ? n.pLead : null;
      if (stopDs >= 0 && (!lead || stopDs < lead.ds)) lead = { ds: stopDs, v: 0 };

      /* IDM */
      const v0 = n.v0;
      const aMax = 1.6 * drv.acc, bCom = 2.3, T = 1.25 * drv.gap,
        s0 = 2.2 + 1.4 * (drv.gap - 1);
      let acc;
      if (lead) {
        const dv = n.v - lead.v;
        const sStar = s0 + n.v * T + (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
        acc = aMax * (1 - Math.pow(n.v / v0, 4) - Math.pow(sStar / Math.max(lead.ds, 0.55), 2));
      } else acc = aMax * (1 - Math.pow(n.v / v0, 4));
      if (mergeCap < Infinity) acc = Math.min(acc, mergeCap);
      acc = clamp(acc, -8.5, 3.2);
      n.v = Math.max(0, n.v + acc * dt);
      n.s += n.v * dt;

      /* pre-signal delay, then the lane index flips and offT follows */
      if (n.pendK >= 0) {
        n.blinkT -= dt;
        if (n.blinkT <= 0) { note(n, `flip ->${n.pendK} s=${n.s.toFixed(0)} off=${n.offCur.toFixed(2)}`); n.laneK = n.pendK; n.pendK = -1; }
      }
      n.offT = c.laneOffset(n.laneK, n.s) + (n.mergeLean || 0);
      const dOff = n.offT - n.offCur;
      const rate = n.blink !== 0 ? n.laneRate || c.lanePitch(n.s) / 3 : LANE_FOLLOW_RATE;
      n.rateUsed = rate;
      if (Math.abs(dOff) > 0.02) {
        n.offCur += clamp(dOff, -rate * dt, rate * dt);
        if (n.blink !== 0 && n.pendK < 0 && !(n.mergeLean || 0) && Math.abs(dOff) < 0.35) n.blink = 0;
      } else {
        n.offCur = n.offT;
        if (n.blink !== 0 && n.pendK < 0 && !(n.mergeLean || 0)) n.blink = 0;
      }
    }

    /* overlap resolver (traffic.ts, reduced to corridor space) */
    for (let a = 0; a < cars.length; a++) {
      const A = cars[a];
      for (let b = a + 1; b < cars.length; b++) {
        const B = cars[b];
        const dz = B.s - A.s, dOff = B.offCur - A.offCur;
        const need = (A.L + B.L) / 2 + 0.6;
        if (Math.abs(dOff) > 1.7 || Math.abs(dz) > need) continue;
        const rear = dz > 0 ? A : B, front = dz > 0 ? B : A;
        rear.v = Math.min(rear.v, front.v * 0.9);
        rear.shoved = Math.max(rear.shoved || 0, (need - Math.abs(dz)) * 0.5);
        rear.s = rear.s - (need - Math.abs(dz)) * 0.5;
      }
    }
  }

  return { cars, spawn, step, rand };
}

function run(mode, seed) {
  const sim = makeSim(mode, seed);
  const DT = 1 / 60, DUR = 240;
  /* dense pre-seed over the approach, then a continuous inflow at Z_IN */
  for (let z = Z_OUT - 100; z > Z_IN; z -= 9) sim.spawn(z);
  const stats = {
    overlapFrames: 0, overlapPairs: 0, worstDepth: 0,
    maxBackJump: 0, maxLatRate: 0, snaps: 0, done: 0, ghostLane: 0,
  };
  const seen = new Set();
  for (let t = 0; t < DUR; t += DT) {
    // keep the pressure on: try to top the stream up every frame
    sim.spawn(Z_IN + sim.rand(0, 30));
    const before = sim.cars.map((n) => ({ s: n.s, off: n.offCur }));
    sim.step(DT);
    /* recycle + hygiene checks */
    let overlapThisFrame = false;
    for (let i = 0; i < sim.cars.length; i++) {
      const n = sim.cars[i], b = before[i];
      /* backward jump: only the resolver moves a car backward; a visible
         teleport would be metres. */
      const back = b.s - n.s;
      if (back > stats.maxBackJump) stats.maxBackJump = back;
      /* lateral speed, net of the taper's own centreline slide (a car
         following its lane is carried sideways by the geometry) */
      const slide = Math.abs(
        c.laneOffset(n.laneK, n.s) - c.laneOffset(n.laneK, b.s));
      const lat = Math.abs(n.offCur - b.off);
      const latRate = Math.max(0, lat - slide) / DT;
      if (latRate > stats.maxLatRate) stats.maxLatRate = latRate;
      if (n.s > TAPER_HI && n.laneK > c.lanes(n.s) - 1) stats.ghostLane++;
      stats.snaps += n.snaps || 0;
      n.snaps = 0;
    }
    /* body overlap: two car rectangles sharing road */
    for (let a = 0; a < sim.cars.length; a++) {
      const A = sim.cars[a];
      for (let b2 = a + 1; b2 < sim.cars.length; b2++) {
        const B = sim.cars[b2];
        const dz = Math.abs(B.s - A.s), dOff = Math.abs(B.offCur - A.offCur);
        const zNeed = (A.L + B.L) / 2, oNeed = (A.W + B.W) / 2;
        if (dz < zNeed && dOff < oNeed) {
          stats.overlapPairs++;
          overlapThisFrame = true;
          const depth = Math.min(zNeed - dz, oNeed - dOff);
          if (depth > stats.worstDepth) stats.worstDepth = depth;
          if (process.env.MERGE_SIM_DEBUG && stats.overlapPairs < 25 && mode === "new") {
            console.log(`    t=${f(t)} OVERLAP dz=${f(dz)} dOff=${f(dOff)} | ` +
              `A#${A.id} s=${f(A.s)} k=${A.laneK} pend=${A.pendK} blink=${A.blink} off=${f(A.offCur)}->${f(A.offT)} v=${f(A.v)} | ` +
              `B#${B.id} s=${f(B.s)} k=${B.laneK} pend=${B.pendK} blink=${B.blink} off=${f(B.offCur)}->${f(B.offT)} v=${f(B.v)}`);
            for (const q of [A, B])
              console.log(`      #${q.id} hist: ${q.hist.slice(-4).join(" | ")}`);
          }
        }
      }
    }
    if (overlapThisFrame) stats.overlapFrames++;
    for (let i = sim.cars.length - 1; i >= 0; i--) {
      if (sim.cars[i].s > Z_OUT) {
        stats.done++;
        sim.cars.splice(i, 1);
      }
    }
    void seen;
  }
  return stats;
}

console.log(`shrink under test: lanes ${c.lanes(500)} @ z=500 → ${c.lanes(755)} @ z=755 → ${c.lanes(900)} @ z=900`);
for (const seed of [0xbeef, 42, 7, 1234, 99, 2026]) {
  const oldS = run("old", seed);
  const newS = run("new", seed);
  console.log(`seed ${seed}:`);
  console.log(`  old rules: ${oldS.overlapFrames} overlap frames (${oldS.overlapPairs} pair-frames, worst depth ${f(oldS.worstDepth)} m), ` +
    `${oldS.snaps} forced snaps, ${oldS.done} cars through`);
  console.log(`  new rules: ${newS.overlapFrames} overlap frames (${newS.overlapPairs} pair-frames, worst depth ${f(newS.worstDepth)} m), ` +
    `${newS.snaps} forced snaps, ${newS.done} cars through`);
  console.log(`  new rules: max backward correction ${f(newS.maxBackJump * 100)} cm/frame, ` +
    `max lateral rate ${f(newS.maxLatRate)} m/s, ghost-lane frames ${newS.ghostLane}`);
  if (newS.overlapFrames > 0) bad(`seed ${seed}: cars overlap through the taper under the new rules`);
  if (newS.ghostLane > 0) bad(`seed ${seed}: a car exits the taper still in a lane that no longer exists`);
  if (newS.maxBackJump > 0.6) bad(`seed ${seed}: backward correction ${f(newS.maxBackJump)} m in one frame reads as a jump`);
  /* both LANE_FOLLOW_RATE (3.4, passive taper tracking) and lanePitch/1.4
     (the emergency crossing rate) are sanctioned lateral speeds */
  const latCap = Math.max(3.4, c.lanePitch(750) / 1.4) + 0.05;
  if (newS.maxLatRate > latCap) bad(`seed ${seed}: lateral motion ${f(newS.maxLatRate)} m/s beats every sanctioned lane rate`);
  if (newS.done < 50) bad(`seed ${seed}: only ${newS.done} cars made it through — the taper is jammed solid`);
}

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall merge-sim checks passed");
process.exit(fail ? 1 : 0);
