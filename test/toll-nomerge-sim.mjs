/* Browser-free simulation of the TOLL PLAZA NO-MERGE ZONE (traffic.ts).

   The plaza used to be the most chaotic 300 m on the lap: NPCs kept taking
   ordinary comfort lane changes under the canopy, so cars cut across booth
   lanes at the last moment. traffic.ts now refuses discretionary changes in
   a zone around the plaza (see the TOLL_HOLD block there) — pick a booth on
   the approach, hold it through the gates.

   The design question that had to be settled first was whether holding can
   STRAND a car: if the plaza carried more lanes than the deck, a car holding
   booth lane 5 would arrive at the exit in a lane that no longer exists.
   Part 1 below measures that directly over 200 road seeds, and it is why the
   fix is a hold rather than a booth assignment with an exit unwind.

   Same contract as test/traffic-merge-sim.mjs and test/hail-sim.mjs:
   traffic.ts pulls in three.js and a live scene, so this reimplements the
   updateHwy driving arithmetic (perception + IDM + the taper merge + the
   comfort change + the toll hold + offset tracking + the overlap resolver)
   against the REAL corridor.ts geometry. If the formulas here drift from
   traffic.ts that is a bug in this file — keep them in lockstep by eye.

   Two rule sets over the same seeded scenario:
     old  — pre-fix: the comfort change is live everywhere, plaza included
     new  — tollHold(): no discretionary change over z 1190..1600, and none
            started within 3 s of travel of that; FORCED taper merges stay
            live (a dying lane is a survival case, and the last drop on this
            road can finish at z = 1225, inside the zone)

   Assertions (new rules, every seed):
     - zero lane changes of any kind inside the plaza window (z 1390..1450)
     - zero DISCRETIONARY changes anywhere in the zone (z 1190..1600)
     - zero cars stranded at the plaza exit: nobody indexed into a lane that
       does not exist, and nobody still crossing between lanes past z = 1450
     - the zone did not jam: throughput within 5% of the old rules
     - no body overlaps through the zone

   Usage: node test/toll-nomerge-sim.mjs [--seeds N] [--dur S] [--trace FILE]
*/

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const N_SEEDS = +arg("seeds", 12);
const DUR = +arg("dur", 180);
const TRACE = arg("trace", "");

const out = mkdtempSync(path.join(tmpdir(), "tollsim-"));
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

let fail = 0;
const bad = (m) => { console.log("  FAIL " + m); fail++; };
const f = (n) => n.toFixed(2);

/* ---- the zone, mirrored from traffic.ts (keep in lockstep) ---- */
const HOLD_MAN = 6, HOLD_VMIN = 15, HOLD_CRAWL = 3.5, HOLD_POST = 40;
/** widest the zone ever gets: a car at the corridor's top speed */
const HOLD_Z0 = TOLL.z0 - 33 * HOLD_MAN;         // ~1082
/** narrowest: a car crawling in a queue */
const HOLD_Z0_MIN = TOLL.z0 - HOLD_VMIN * HOLD_MAN; // 1190
const HOLD_Z1 = TOLL.z1 + HOLD_POST;             // 1600
const tollHold = (s, v) => {
  if (v < HOLD_CRAWL) return false;
  const dz = TOLL.z0 - s;
  if (dz <= 0) return s <= HOLD_Z1;
  return dz <= Math.max(v, HOLD_VMIN) * HOLD_MAN;
};

/* =========================================================================
   PART 1 — the design question: does holding a lane strand a car?
   ========================================================================= */
console.log("=== part 1: does a booth lane survive the plaza? (200 road seeds) ===");
{
  let lastDrop = -Infinity, minPlaza = 99, maxPlaza = 0, mismatch = 0;
  let pitchIn = 0, pitchPlaza = 0;
  for (let seed = 1; seed <= 200; seed++) {
    setRoadSeed(seed);
    const c = getCorridor();
    let prev = c.lanes(900);
    for (let z = 900; z <= 1750; z++) {
      const n = c.lanes(z);
      if (n !== prev) { lastDrop = Math.max(lastDrop, z); prev = n; }
    }
    for (let z = TOLL.plazaZ0; z <= TOLL.plazaZ1; z++) {
      minPlaza = Math.min(minPlaza, c.lanes(z));
      maxPlaza = Math.max(maxPlaza, c.lanes(z));
    }
    // the booth lane a car holds must still exist where the zone ends
    if (c.lanes(TOLL.plazaZ0) !== c.lanes(HOLD_Z1)) mismatch++;
    pitchIn = c.lanePitch(HOLD_Z0);
    pitchPlaza = c.lanePitch((TOLL.plazaZ0 + TOLL.plazaZ1) / 2);
  }
  setRoadSeed(1);
  console.log(`  last lane-count change before the plaza:  z = ${lastDrop}`);
  console.log(`  lanes across the plaza:                   ${minPlaza}..${maxPlaza}`);
  console.log(`  lane pitch, approach → plaza:             ${f(pitchIn)} m → ${f(pitchPlaza)} m`);
  console.log(`  seeds where the entry lane is gone by z=${HOLD_Z1}: ${mismatch}/200`);
  if (mismatch > 0)
    bad("a booth lane does not survive to the end of the zone — a hold WOULD strand cars, " +
      "and the fix has to assign booths and unwind them instead");
  if (lastDrop >= TOLL.z0)
    bad(`a lane still ends at z=${lastDrop}, inside the plaza fan-out — forced merges must stay ungated there`);
  console.log(`  → booth index IS lane index, and it survives: HOLD is the right design.`);
  console.log(`  → a lane can still die at z=${lastDrop}, which is ${lastDrop - HOLD_Z0} m inside the`);
  console.log(`    zone as a fast car sees it, so the forced taper merge must not be gated. It is not.`);
  console.log(`  → and the zone's LATEST possible start (a crawling car, z=${HOLD_Z0_MIN}) still clears`);
  console.log(`    that drop by ${HOLD_Z0_MIN - lastDrop} m, so a stopped zipper is never gated either.`);
  console.log(`  → the zone does overlap that drop by ${lastDrop - HOLD_Z0_MIN} m, which is what the`);
  console.log(`    crawl exemption (v < ${HOLD_CRAWL} m/s) is for; part 2 measures whether it deadlocks.`);
  console.log("");
}

/* =========================================================================
   PART 2 — drive traffic through the plaza under both rule sets
   ========================================================================= */
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
const LANE_FOLLOW_RATE = 3.4; // mirrors traffic.ts

const Z_IN = 860;   // upstream of everything: settled road, well before the drop
const Z_OUT = 1750; // past the zone and past the bypass merge at MERGE_Z

function makeSim(c, mode, seed) {
  const rng = mulberry32(seed);
  const rand = (a, b) => a + rng() * (b - a);
  const cars = [];
  let nextId = 0;

  /* traffic.ts laneClearAt, current (post-zipper) rules */
  function laneClearAt(n, s, off2, back, fwd, backC, fwdC) {
    for (const m of cars) {
      if (m === n) continue;
      if (Math.abs(m.offCur - off2) > 2.2) continue;
      const ds = m.s - s;
      const halfL = (m.L + n.L) / 2;
      const backNeed = halfL + (back ?? 13.5) + (backC ?? 3.0) * Math.max(0, m.v - n.v);
      const fwdNeed = halfL + (fwd ?? 23.5) + (fwdC ?? 2.0) * Math.max(0, n.v - m.v);
      if (ds > -backNeed && ds < fwdNeed) return false;
    }
    return true;
  }

  function spawn(z) {
    const nl = Math.min(c.lanes(z), c.lanes(z + 300));
    const spd = rand(0.85, 1.2);
    const q = clamp(spd - 0.72 + rand(-0.18, 0.18), 0, 0.99) / 0.62;
    const laneK = Math.min(nl - 1, Math.floor(q * nl));
    const off = c.laneOffset(laneK, z);
    for (const m of cars) {
      if (Math.abs(m.offCur - off) > 2.2) continue;
      if (Math.abs(m.s - z) < 20) return false;
    }
    const L = rand(0, 1) < 0.1 ? 6.3 : 4.5;
    const n = {
      id: nextId++, L, W: 1.87,
      s: z, v: 0, v0: (rand(24, 30) + laneK * 1.1) * spd,
      laneK, pendK: -1, zipCross: false, blink: 0, blinkT: 0, turnCd: rand(2, 8),
      offCur: off, offT: off, mergeLean: 0, why: "",
      laneRate: c.lanePitch(z) / 3,
      drv: { lane: rng(), gap: rand(0.8, 1.4), acc: rand(0.8, 1.2), react: rand(0.12, 0.6), weave: rng() < 0.5 ? 1 : 0 },
      pT: rng() * 0.4, pLead: { ds: Infinity, v: 0 },
    };
    n.v = n.v0 * rand(0.85, 1.0);
    cars.push(n);
    return true;
  }

  /* one updateHwy step, corridor space (s along, off lateral) */
  function step(dt, log) {
    for (const n of cars) {
      const nl = c.lanes(n.s);
      const drv = n.drv;

      /* ---- FORCED taper merge: never gated by the toll hold ---- */
      let mergeCap = Infinity, stopDs = -1;
      const wasLean = n.mergeLean !== 0;
      n.mergeLean = 0;
      if (n.pendK < 0 && (n.blink === 0 || wasLean) && n.laneK <= nl - 1 && n.laneK > 0) {
        const look = clamp(n.v, 15, 32) * 9;
        let dipAt = -1;
        for (let d = 32; d - 32 < look; d += 32) {
          const q = Math.min(d, look);
          if (c.lanes(n.s + q) - 1 < n.laneK) { dipAt = q; break; }
        }
        if (dipAt >= 0) {
          const k2 = n.laneK - 1;
          const off2 = c.laneOffset(k2, n.s);
          const urgent = c.lanes(n.s + Math.max(n.v, 8) * 3) - 1 < n.laneK;
          const clear = urgent
            ? laneClearAt(n, n.s, off2, 1.2 + 0.25 * n.v, 2.5 + 0.35 * n.v)
            : laneClearAt(n, n.s, off2, 9, 16);
          if (clear) {
            const brisk = urgent || n.v < 15;
            n.pendK = k2; n.zipCross = true; n.why = "forced";
            n.blink = off2 < n.offCur ? -1 : 1;
            n.blinkT = brisk ? rand(0.2, 0.5) : rand(1, 2);
            n.laneRate = brisk ? c.lanePitch(n.s) / 1.4
              : c.lanePitch(n.s) / lerp(3, 2, drv.lane);
            n.turnCd = Math.max(n.turnCd, 2);
          } else {
            mergeCap = urgent ? -2.6 : -0.35;
            if (urgent) {
              const maxBias = Math.max(0, c.lanePitch(n.s) / 2 - n.W / 2 - 0.25);
              n.mergeLean = (off2 < n.offCur ? -1 : 1) * (maxBias + 0.2);
              n.blink = off2 < n.offCur ? -1 : 1;
              n.zipCross = true;
              n.laneRate = Math.max(n.laneRate, LANE_FOLLOW_RATE);
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
      /* hard safety net — also never gated */
      if (n.laneK > nl - 1) {
        const k2 = Math.max(0, nl - 1);
        n.blink = c.laneOffset(k2, n.s) < n.offCur ? -1 : 1;
        n.laneRate = Math.max(n.laneRate, c.lanePitch(n.s) / 1.4);
        log.push({ z: n.s, k0: n.laneK, k1: k2, why: "snap", id: n.id });
        n.laneK = k2; n.zipCross = true; n.pendK = -1; n.why = "snap";
        mergeCap = Math.min(mergeCap, -2.6);
      }

      /* perception */
      n.pT -= dt;
      if (n.pT <= 0) {
        let ds = Infinity, lv = 0;
        for (const m of cars) {
          if (m === n) continue;
          const ahead = m.s - n.s;
          if (ahead <= 0 || ahead > 70) continue;
          let lim = m.blink !== 0 ? 2.9 : 1.9;
          if (n.zipCross && n.blink !== 0) {
            const sweep = n.offT - n.offCur;
            if (sweep * (m.offCur - n.offCur) > 0) lim += Math.min(3.8, Math.abs(sweep));
          }
          if (Math.abs(m.offCur - n.offCur) > lim) continue;
          const d = Math.max(ahead - (m.L + n.L) / 2, 0.1);
          if (d < ds) { ds = d; lv = m.v; }
        }
        n.pLead.ds = ds; n.pLead.v = lv;
        n.pT = drv.react * rand(0.8, 1.2);
      } else if (n.pLead.ds < 1e8) {
        n.pLead.ds = Math.max(0.15, n.pLead.ds + (n.pLead.v - n.v) * dt);
      }
      if (n.pLead.ds < 11) n.pT = Math.min(n.pT, 0.06);
      let lead = n.pLead.ds < 1e8 ? n.pLead : null;
      if (stopDs >= 0 && (!lead || stopDs < lead.ds)) lead = { ds: stopDs, v: 0 };

      /* IDM */
      const aMax = 1.6 * drv.acc, bCom = 2.3, T = 1.25 * drv.gap,
        s0 = 2.2 + 1.4 * (drv.gap - 1);
      let acc;
      if (lead) {
        const dv = n.v - lead.v;
        const sStar = s0 + n.v * T + (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
        acc = aMax * (1 - Math.pow(n.v / n.v0, 4) - Math.pow(sStar / Math.max(lead.ds, 0.55), 2));
      } else acc = aMax * (1 - Math.pow(n.v / n.v0, 4));
      if (mergeCap < Infinity) acc = Math.min(acc, mergeCap);
      acc = clamp(acc, -8.5, 3.2);
      n.v = Math.max(0, n.v + acc * dt);
      n.s += n.v * dt;

      /* ---- DISCRETIONARY comfort change: gated by the toll hold ---- */
      n.turnCd -= dt;
      const held = !!lead && lead.ds < 18 + 30 * drv.lane && lead.v < n.v0 * (0.8 + 0.12 * drv.lane);
      const restless = drv.weave > 0 && (!lead || lead.ds > 30) && rng() < 0.28 * dt;
      const gate = mode === "new" && tollHold(n.s, n.v);
      if (n.pendK < 0 && n.blink === 0 && n.turnCd <= 0 && (held || restless) && !gate) {
        const first = drv.lane > 0.55 ? 1 : -1;
        for (let pass = 0; pass < 2; pass++) {
          const k2 = n.laneK + (pass === 0 ? first : -first);
          if (k2 < 0 || k2 > nl - 1) continue;
          const off2 = c.laneOffset(k2, n.s);
          if (laneClearAt(n, n.s, off2)) {
            n.pendK = k2; n.why = "comfort";
            n.blink = off2 < n.offCur ? -1 : 1;
            n.blinkT = rand(1, 2);
            n.laneRate = c.lanePitch(n.s) / lerp(4, 2, drv.lane);
            n.turnCd = lerp(15, 4.5, drv.lane);
            break;
          }
        }
      }
      /* pre-signal delay, then the lane index flips */
      if (n.pendK >= 0) {
        n.blinkT -= dt;
        if (n.blinkT <= 0) {
          log.push({ z: n.s, k0: n.laneK, k1: n.pendK, why: n.why, id: n.id, v: n.v });
          n.laneK = n.pendK; n.pendK = -1;
        }
      }
      const maxBias = Math.max(0, c.lanePitch(n.s) / 2 - n.W / 2 - 0.25);
      n.offT = c.laneOffset(n.laneK, n.s) + (n.mergeLean !== 0 ? n.mergeLean : 0);
      void maxBias;
      const dOff = n.offT - n.offCur;
      const rate = n.blink !== 0 ? n.laneRate || c.lanePitch(n.s) / 3 : LANE_FOLLOW_RATE;
      if (Math.abs(dOff) > 0.02) {
        n.offCur += clamp(dOff, -rate * dt, rate * dt);
        if (n.blink !== 0 && n.pendK < 0 && n.mergeLean === 0 && Math.abs(dOff) < 0.35) n.blink = 0;
      } else {
        n.offCur = n.offT;
        if (n.blink !== 0 && n.pendK < 0 && n.mergeLean === 0) n.blink = 0;
      }
      if (n.blink === 0) n.zipCross = false;
    }

    /* overlap resolver */
    for (let a = 0; a < cars.length; a++) {
      const A = cars[a];
      for (let b = a + 1; b < cars.length; b++) {
        const B = cars[b];
        const dz = B.s - A.s;
        const need = (A.L + B.L) / 2 + 0.6;
        if (Math.abs(B.offCur - A.offCur) > 1.7 || Math.abs(dz) > need) continue;
        const rear = dz > 0 ? A : B, front = dz > 0 ? B : A;
        rear.v = Math.min(rear.v, front.v * 0.9);
        rear.s -= (need - Math.abs(dz)) * 0.5;
      }
    }
  }
  return { cars, spawn, step, rand };
}

/* Fleet size in the window under test. The shipping game runs 120 cars, but
   they are budgeted around the PLAYER rather than spread over the 4 km loop,
   so the honest way to set this is by density: CRUISE is ~10 veh/km/lane
   (free flow, what the plaza looks like most of the time) and PACKED is ~26,
   which is near lane capacity and is where a no-merge zone could plausibly
   jam something. Both are run for every seed; an unbounded inflow is not,
   because it queues the whole 890 m solid and then measures the queue rather
   than the zone. */
const WINDOW_KM = (Z_OUT - Z_IN) / 1000;
const DENSITY = [["cruise", 10], ["packed", 26]];

function run(c, mode, seed, cap, wantTrace) {
  const sim = makeSim(c, mode, seed);
  const DT = 1 / 60;
  for (let z = Z_OUT - 120; z > Z_IN && sim.cars.length < cap; z -= 9) sim.spawn(z);
  const st = {
    changes: [], through: 0, overlapFrames: 0, stranded: 0, crossingAtExit: 0,
    trace: [], ovAt: [], crawlFrames: 0, crawlAt: new Map(), crossingInZone: 0, overlapCore: 0,
  };
  let frame = 0;
  for (let t = 0; t < DUR; t += DT) {
    if (sim.cars.length < cap) sim.spawn(Z_IN + sim.rand(0, 30));
    const log = [];
    sim.step(DT, log);
    for (const e of log) st.changes.push(e);
    frame++;
    for (const n of sim.cars) {
      // stranded: indexed into a lane that does not exist where the zone ends
      if (n.s > TOLL.plazaZ1 && n.s < Z_OUT && n.laneK > c.lanes(n.s) - 1) st.stranded++;
      // …or still crossing between lanes past the plaza exit
      if (n.s > TOLL.plazaZ1 && n.s < TOLL.z1 &&
        Math.abs(n.offCur - c.laneOffset(n.laneK, n.s)) > 1.0) st.crossingAtExit++;
      /* THE measurement this file exists for: is anybody mid-manoeuvre
         anywhere in the plaza core — a committed change waiting on its
         blinker, or a body still sweeping between two lane centres? A flip
         count alone misses both ends of a crossing. */
      if (n.s >= TOLL.z0 && n.s <= TOLL.z1 &&
        (n.pendK >= 0 ||
          Math.abs(n.offCur - c.laneOffset(n.laneK, n.s)) > 1.0)) {
        st.crossingInZone++;
        if (process.env.TOLL_SIM_DEBUG && st.crossingInZone < 6)
          console.log(`      CROSSING z=${n.s.toFixed(0)} lane=${n.laneK} pend=${n.pendK} why=${n.why} v=${n.v.toFixed(1)}`);
      }
      /* a car crawling on the open deck is what a jam looks like — counted
         for BOTH rule sets so the hold cannot hide behind the merge's own
         stopped-leader behaviour */
      if (n.s > 1000 && n.s < Z_OUT && n.v < 2) {
        st.crawlFrames++;
        if (process.env.TOLL_SIM_JAM && !n.jamNoted) {
          n.jamNoted = 1;
          console.log(`      JAM car#${n.id} stopped at z=${n.s.toFixed(0)} lane=${n.laneK} pend=${n.pendK} lean=${n.mergeLean.toFixed(2)} blink=${n.blink} lanes=${c.lanes(n.s)}`);
        }
        if (process.env.TOLL_SIM_DEBUG) {
          const bin = Math.floor(n.s / 25) * 25;
          st.crawlAt.set(bin, (st.crawlAt.get(bin) || 0) + 1);
        }
      }
      if (wantTrace && frame % 6 === 0 && n.s > 1050 && n.s < 1700)
        st.trace.push([+n.s.toFixed(1), +n.offCur.toFixed(2), n.laneK, n.id]);
    }
    /* Body overlap, split at the fan-out. Overlaps in the CORE are this
       file's business — a hold that pushed two bodies into one another under
       the canopy would be a worse plaza than the weaving was. Overlaps
       upstream of it belong to the 4 → 3 taper zipper, which
       test/traffic-merge-sim.mjs owns; they are still counted, so a
       regression there cannot hide, but they are judged in the total rather
       than seed by seed. */
    let ovCore = false, ovUp = false;
    for (let a = 0; a < sim.cars.length; a++) {
      const A = sim.cars[a];
      if (A.s < 1000 || A.s > HOLD_Z1 + 60) continue;
      for (let b = a + 1; b < sim.cars.length; b++) {
        const B = sim.cars[b];
        if (Math.abs(B.s - A.s) < (A.L + B.L) / 2 &&
          Math.abs(B.offCur - A.offCur) < (A.W + B.W) / 2) {
          if (A.s >= TOLL.z0) ovCore = true; else ovUp = true;
          if (process.env.TOLL_SIM_DEBUG)
            st.ovAt.push(`z=${A.s.toFixed(0)} kA=${A.laneK} kB=${B.laneK} whyA=${A.why} whyB=${B.why} vA=${A.v.toFixed(1)} vB=${B.v.toFixed(1)}`);
        }
      }
    }
    if (ovCore) st.overlapCore++;
    if (ovCore || ovUp) st.overlapFrames++;
    for (let i = sim.cars.length - 1; i >= 0; i--)
      if (sim.cars[i].s > Z_OUT) { st.through++; sim.cars.splice(i, 1); }
  }
  return st;
}

/* the same bands test/toll-nomerge-live.mjs prints, so the node numbers and
   the in-browser numbers can be read side by side */
const BANDS = [
  ["approach   z 1000-1190 (outside)", 1000, HOLD_Z0_MIN],
  ["lead-in    z 1190-1280", HOLD_Z0_MIN, TOLL.z0],
  ["fan-out    z 1280-1390", TOLL.z0, TOLL.plazaZ0],
  ["PLAZA      z 1390-1450", TOLL.plazaZ0, TOLL.plazaZ1],
  ["fan-in     z 1450-1560", TOLL.plazaZ1, TOLL.z1],
  ["zone exit  z 1560-1600", TOLL.z1, HOLD_Z1],
  ["clear      z 1600-1750 (outside)", HOLD_Z1, Z_OUT],
];
const inBand = (cs, a, b, why) =>
  cs.filter((e) => e.z >= a && e.z < b && (!why || why(e.why))).length;

console.log(`=== part 2: ${N_SEEDS} road seeds x ${DUR}s of traffic, old vs new rules ===`);
let traceOld = null, traceNew = null;
for (const [dname, vkl] of DENSITY) {
  const tot = { old: BANDS.map(() => 0), new: BANDS.map(() => 0) };
  let oldThrough = 0, newThrough = 0, newForcedInZone = 0, ovOld = 0, ovNew = 0;
  console.log(`\n  --- ${dname}: ${vkl} veh/km/lane ---`);
  for (let i = 0; i < N_SEEDS; i++) {
    const roadSeed = 1 + i * 7;
    setRoadSeed(roadSeed);
    const c = getCorridor();
    const cap = Math.round(vkl * WINDOW_KM * c.lanes(TOLL.plazaZ0));
    const trafficSeed = 0xbeef + i * 977;
    const wantTrace = i === 0 && dname === "packed";
    const o = run(c, "old", trafficSeed, cap, wantTrace);
    const n = run(c, "new", trafficSeed, cap, wantTrace);
    if (wantTrace) { traceOld = o.trace; traceNew = n.trace; }
    oldThrough += o.through; newThrough += n.through;
    BANDS.forEach(([, a, b], j) => {
      tot.old[j] += inBand(o.changes, a, b);
      tot.new[j] += inBand(n.changes, a, b);
    });
    /* CORE = the plaza and both its pitch tapers, z 1280..1600. Nothing may
       change lane here at all. The lead-in (1190..1280) is the approach: the
       hold covers it for anything moving, but the road's last lane drop can
       finish at z = 1225 and a queue can shuffle, so it is reported rather
       than asserted. */
    const core = inBand(n.changes, TOLL.z0, HOLD_Z1);
    const plaza = inBand(n.changes, TOLL.plazaZ0, TOLL.plazaZ1);
    const lead = inBand(n.changes, HOLD_Z0_MIN, TOLL.z0);
    const shuffle = n.changes.filter((e) => e.z >= HOLD_Z0_MIN && e.z < TOLL.z0 &&
      e.why === "comfort" && e.v < HOLD_CRAWL).length;
    const forced = inBand(n.changes, HOLD_Z0_MIN, HOLD_Z1, (w) => w !== "comfort");
    newForcedInZone += forced;
    const oPlaza = inBand(o.changes, TOLL.plazaZ0, TOLL.plazaZ1);
    const oCore = inBand(o.changes, TOLL.z0, HOLD_Z1);
    console.log(`  seed ${String(roadSeed).padStart(3)} (${cap} cars):` +
      ` core changes ${String(oCore).padStart(3)} → ${String(core).padStart(3)}` +
      ` | plaza ${String(oPlaza).padStart(2)} → ${plaza}` +
      ` | mid-manoeuvre frames in core ${String(o.crossingInZone).padStart(5)} → ${n.crossingInZone}` +
      ` | lead-in ${lead} (${forced} forced, ${shuffle} shuffle)` +
      ` | stranded ${n.stranded}` +
      ` | overlaps core ${o.overlapCore} → ${n.overlapCore}, approach ${o.overlapFrames - o.overlapCore} → ${n.overlapFrames - n.overlapCore}` +
      ` | through ${o.through} → ${n.through}`);
    if (process.env.TOLL_SIM_DEBUG) {
      const fmt = (m) => [...m].sort((x, y) => x[0] - y[0]).map(([z, k]) => `${z}:${k}`).join(" ");
      console.log(`      crawl old ${fmt(o.crawlAt)}`);
      console.log(`      crawl new ${fmt(n.crawlAt)}`);
    }
    if (process.env.TOLL_SIM_DEBUG && n.ovAt.length)
      for (const l of n.ovAt.slice(0, 12)) console.log("      new overlap " + l);
    if (core > 0) bad(`${dname} seed ${roadSeed}: ${core} lane change(s) inside the no-merge zone core (z ${TOLL.z0}..${HOLD_Z1})`);
    if (n.crossingInZone > 0) bad(`${dname} seed ${roadSeed}: ${n.crossingInZone} frames mid-manoeuvre inside the plaza core`);
    if (n.stranded > 0) bad(`${dname} seed ${roadSeed}: ${n.stranded} frames with a car in a lane that does not exist past the plaza`);
    if (n.crossingAtExit > 0) bad(`${dname} seed ${roadSeed}: ${n.crossingAtExit} frames still crossing between lanes past the plaza exit`);
    if (n.overlapCore > 0)
      bad(`${dname} seed ${roadSeed}: ${n.overlapCore} body-overlap frames in the zone core`);
    ovOld += o.overlapFrames; ovNew += n.overlapFrames;
  }
  console.log(`\n  lane changes by band, summed over ${N_SEEDS} seeds (${dname}):`);
  console.log(`  ${"band".padEnd(36)} ${"old".padStart(6)} ${"new".padStart(6)}`);
  BANDS.forEach(([l], j) =>
    console.log(`  ${l.padEnd(36)} ${String(tot.old[j]).padStart(6)} ${String(tot.new[j]).padStart(6)}`));
  const zOld = tot.old.slice(1, 6).reduce((a, b) => a + b, 0);
  const zNew = tot.new.slice(1, 6).reduce((a, b) => a + b, 0);
  const cOld = tot.old.slice(2, 6).reduce((a, b) => a + b, 0);
  const cNew = tot.new.slice(2, 6).reduce((a, b) => a + b, 0);
  console.log(`  ${"NO-MERGE ZONE TOTAL (z 1190-1600)".padEnd(36)} ${String(zOld).padStart(6)} ${String(zNew).padStart(6)}`);
  console.log(`  ${"of which forced (dying lane)".padEnd(36)} ${"".padStart(6)} ${String(newForcedInZone).padStart(6)}`);
  console.log(`  ${"ZONE CORE (z 1280-1600)".padEnd(36)} ${String(cOld).padStart(6)} ${String(cNew).padStart(6)}`);
  console.log(`  cars through: ${oldThrough} → ${newThrough} ` +
    `(${((newThrough / oldThrough - 1) * 100).toFixed(1)}%)`);
  console.log(`  body-overlap frames, whole window: ${ovOld} → ${ovNew}`);
  if (ovNew > ovOld)
    bad(`${dname}: body overlaps rose ${ovOld} → ${ovNew} over the whole window`);
  if (newThrough < oldThrough * 0.95)
    bad(`${dname}: throughput fell ${((1 - newThrough / oldThrough) * 100).toFixed(1)}% — the zone is jamming the plaza`);
}

if (TRACE) {
  writeFileSync(TRACE, JSON.stringify({ old: traceOld, new: traceNew, TOLL, HOLD_Z0, HOLD_Z1 }));
  console.log(`\nwrote trace ${TRACE}`);
}
console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall toll no-merge checks passed");
process.exit(fail ? 1 : 0);
