#!/usr/bin/env node
/* Pure-node sanity sim of lane U's trimCreaks() trigger math — no browser,
   no server, no audio: cheap enough to run anywhere (`node
   test/audio-creak-sim.mjs`). The full in-game check (needs a running
   server) is test/audio-creak-check.mjs.
   NOTE: this MIRRORS the model in game/audio.ts (jerk thresholds, slope
   smoothing, stick-slip probability, gates) rather than importing it — the
   class is welded to WebAudio — so if you retune the constants there, keep
   this copy in sync. Inputs are synthesized the way physics.ts produces
   them: axS/ayS are first-order lags at 9/s toward a target; slope raw per
   frame. */
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

function makeCreak() {
  const s = {
    prevAx: 0, prevAy: 0, prevSlope: 0, slopeS: 0, havePrev: false,
    gateT: 0, rolls: [], fires: [],
  };
  return {
    s,
    step(now, dt, speed, axS, ayS, slope) {
      const h = Math.max(dt, 1 / 240);
      s.slopeS += (slope - s.slopeS) * Math.min(1, 8 * h);
      const jx = (axS - s.prevAx) / h;
      const jy = (ayS - s.prevAy) / h;
      const js = (s.slopeS - s.prevSlope) / h;
      const had = s.havePrev;
      s.prevAx = axS; s.prevAy = ayS; s.prevSlope = s.slopeS; s.havePrev = true;
      if (!had) return;
      if (now < s.gateT) return;
      const sLong = smoothstep(28, 70, Math.abs(jx));
      const sLat = smoothstep(22, 60, Math.abs(jy));
      const sVert = smoothstep(0.15, 0.5, Math.abs(js));
      const strength = Math.max(sLong, sLat, sVert);
      if (strength <= 0) return;
      const axis = strength === sLong ? "long" : strength === sLat ? "lat" : "vert";
      const p = 0.3 + strength * 0.3;
      s.rolls.push({ t: now, axis, strength, p });
      if (Math.random() >= p) { s.gateT = now + 0.5; return; }
      s.gateT = now + 0.8 + Math.random() * 1.7;
      s.fires.push({ t: now, axis, strength, p });
    },
  };
}

const DT = 1 / 60;
let failures = 0;
const check = (ok, msg) => { console.log((ok ? "  ✓ " : "  ✗ ") + msg); if (!ok) failures++; };

// 1) steady cruise, 60s: axS jitters ±0.3 m/s², ayS ±0.4 (lane texture), flat road
{
  const c = makeCreak();
  let ax = 0, ay = 0;
  for (let i = 0; i < 60 * 60; i++) {
    ax += ((Math.random() - 0.5) * 0.6 - ax) * Math.min(1, 9 * DT);
    ay += ((Math.random() - 0.5) * 0.8 - ay) * Math.min(1, 9 * DT);
    c.step(i * DT, DT, 30, ax, ay, 0.002 * Math.sin(i * 0.01));
  }
  check(c.s.rolls.length === 0, `steady cruise 60s: ${c.s.rolls.length} rolls (want 0)`);
}

// 2) gentle braking episodes (-2.5 m/s² target): must never roll
{
  const c = makeCreak();
  let ax = 0, t = 0;
  for (let ep = 0; ep < 50; ep++) {
    for (let i = 0; i < 60; i++) { ax += (-2.5 - ax) * Math.min(1, 9 * DT); c.step(t += DT, DT, 25, ax, 0, 0); }
    for (let i = 0; i < 60; i++) { ax += (0 - ax) * Math.min(1, 9 * DT); c.step(t += DT, DT, 25, ax, 0, 0); }
  }
  check(c.s.rolls.length === 0, `50 gentle brakes (-2.5): ${c.s.rolls.length} rolls (want 0)`);
}

// 3) hard-brake episodes (-9 target, 1.2s on / 1.6s off), 400 episodes
{
  const c = makeCreak();
  let ax = 0, t = 0;
  for (let ep = 0; ep < 400; ep++) {
    for (let i = 0; i < 72; i++) { ax += (-9 - ax) * Math.min(1, 9 * DT); c.step(t += DT, DT, 28, ax, 0, 0); }
    for (let i = 0; i < 96; i++) { ax += (0 - ax) * Math.min(1, 9 * DT); c.step(t += DT, DT, 20, ax, 0, 0); }
  }
  const r = c.s.rolls.length, f = c.s.fires.length, ratio = f / r;
  check(r >= 400, `400 hard brakes: ${r} qualifying rolls (want >=400; onset + release both qualify)`);
  check(f > 0 && f < r, `probabilistic: ${f}/${r} fired (ratio ${ratio.toFixed(2)}, want strictly 0<ratio<1)`);
  check(ratio > 0.25 && ratio < 0.75, `fire ratio ${ratio.toFixed(2)} within the 0.3-0.6 design band (+margin)`);
  const rollsPerSec = r / t;
  check(rollsPerSec < 1.1, `roll rate ${rollsPerSec.toFixed(2)}/s — one event per transient, no per-frame re-rolls`);
  let minGap = Infinity;
  for (let i = 1; i < c.s.fires.length; i++) minGap = Math.min(minGap, c.s.fires[i].t - c.s.fires[i - 1].t);
  check(minGap >= 0.8 - 1e-9, `min fire gap ${minGap.toFixed(3)}s respects 0.8s refractory floor`);
  check(c.s.rolls.every((e) => e.axis === "long"), "all brake rolls attributed to the longitudinal axis");
}

// 4) slalom: ayS target ±7 m/s² alternating every 0.7s for 60s
{
  const c = makeCreak();
  let ay = 0, t = 0;
  for (let i = 0; i < 60 * 60; i++) {
    const target = Math.floor(t / 0.7) % 2 ? 7 : -7;
    ay += (target - ay) * Math.min(1, 9 * DT);
    c.step(t += DT, DT, 30, 0, ay, 0);
  }
  const lat = c.s.rolls.filter((e) => e.axis === "lat").length;
  check(lat >= 30, `slalom 60s: ${lat} lateral rolls (want plenty)`);
  check(c.s.fires.length > 0 && c.s.fires.length < c.s.rolls.length, `slalom fires ${c.s.fires.length}/${c.s.rolls.length} — probabilistic`);
}

// 5) settled steady corner: ayS holds 7 after one turn-in — only the entry may roll
{
  const c = makeCreak();
  let ay = 0, t = 0;
  for (let i = 0; i < 60 * 20; i++) { ay += (7 - ay) * Math.min(1, 9 * DT); c.step(t += DT, DT, 30, 0, ay, 0); }
  check(c.s.rolls.length <= 1, `20s settled corner: ${c.s.rolls.length} roll(s) (want <=1, the turn-in only)`);
}

// 6) slope: per-frame seam noise (±0.005 raw steps) silent; a real gore
//    (0.12 step) qualifies through the 8/s smoothing
{
  const c = makeCreak();
  let t = 0;
  for (let i = 0; i < 60 * 30; i++) c.step(t += DT, DT, 25, 0, 0, (Math.random() - 0.5) * 0.01);
  check(c.s.rolls.length === 0, `30s of raw slope seam-noise (±0.005): ${c.s.rolls.length} rolls (want 0)`);
  const c2 = makeCreak();
  t = 0;
  let slope = 0, rollsB4 = 0;
  for (let ep = 0; ep < 100; ep++) {
    for (let i = 0; i < 120; i++) c2.step(t += DT, DT, 25, 0, 0, slope);
    slope = slope > 0 ? 0 : 0.12; // gore/grade-break crossing
  }
  check(c2.s.rolls.length >= 50, `100 grade-break crossings (0.12 step): ${c2.s.rolls.length} vert rolls (want most to qualify)`);
  check(c2.s.rolls.every((e) => e.axis === "vert"), "grade-break rolls attributed to the vert axis");
}

console.log(failures ? `\n❌ ${failures} failure(s)` : "\n✅ trigger math sane");
process.exit(failures ? 1 : 0);
