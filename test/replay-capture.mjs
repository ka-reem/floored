/* Capture a drive_trace the way a real tester's browser would produce one.

   The sampler in lib/telemetry.ts rides the engine's 6.25 Hz chunk tick, which
   only turns over once per RENDERED frame — and this box has no GPU, so a
   rendered frame is 5-20 s. A three-minute drive would take a day.

   So this drives with the same headless pipeline every other sim script uses:
   __neonx.simStep() runs readInput → stepPhysics → loopSplice → collidePlayer
   at the real 120 Hz substep with rendering left out, and the harness turns
   traffic over beside it so NPCs really move and the near-miss feed is real.
   Then it hands lib/telemetry.ts's own telemetryTick() exactly what the engine
   hands it, at exactly the rate the engine would (every 0.32 s), and collects
   the batches track() would have been given.

   Two honest caveats, both stated on the picture:
   - `crashes` here is the CLEAN RUN reset counter (collide.ts's normalImpact
     over CLEAN_RUN.impact), which simStep does maintain; stats.crashes is
     banked in the render loop, which is not running.
   - a steering autopilot is not a person. The speed profile and the two
     distraction windows are scripted to look like a tester, not measured off
     one.

   It also dumps the road network as polylines so the viewer has a map to draw
   the trace on.

   Usage: node test/replay-capture.mjs --url http://localhost:3277 \
            --secs 240 --out test/artifacts/telemetry/session.json
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3277");
const SECS = Number(arg("--secs", 240));
const OUT = arg("--out", "test/artifacts/telemetry/session.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 900, height: 600 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  pageerror:", String(e.message || e).slice(0, 160)));
const t0 = Date.now();
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
console.log("loaded in", ((Date.now() - t0) / 1000).toFixed(0), "s");
await sleep(10000);

/* ---- the map the viewer draws the trace on ---- */
const map = await page.evaluate(() => {
  const g = window.__neonx.game, cor = g.cor, R = g.world.routes;
  const corr = { c: [], l: [], r: [] };
  for (let z = cor.Z0; z <= cor.Z1; z += 12) {
    const hw = cor.halfWidth(z);
    const c = cor.worldOf(z, 0), l = cor.worldOf(z, hw), r = cor.worldOf(z, -hw);
    corr.c.push([Math.round(c.x), Math.round(c.z)]);
    corr.l.push([Math.round(l.x), Math.round(l.z)]);
    corr.r.push([Math.round(r.x), Math.round(r.z)]);
  }
  const line = (e) => {
    const out = [];
    if (!e) return out;
    for (let s = 0; s <= e.len; s += 10) {
      const p = e.worldOf(s, 0);
      out.push([Math.round(p.x), Math.round(p.z)]);
    }
    return out;
  };
  return { corridor: corr, bypass: line(R?.bypass), mtn: line(R?.mtn) };
});
console.log("map: corridor", map.corridor.c.length, "bypass", map.bypass.length, "mtn", map.mtn.length);

/* ---- the drive ---- */
const res = await page.evaluate(async (SECS) => {
  const g = window.__neonx.game, tel = window.__neonx.telemetry, cor = g.cor;
  const batches = [];
  tel.force(true);
  tel.setSink((p) => batches.push(p));

  window.__neonx.setTime(21.5);
  window.__neonx.toCorridor(-1750, 40, 1);
  g.camMode = 0;

  const DT = 0.16;                 // one engine chunk tick
  const N = Math.round(SECS / DT);
  let now = performance.now() / 1000;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  /* A tester-shaped speed profile: nervous first half-minute, settling into a
     cruise, a lift for the tunnel, a hard push after it, a long slow patch in
     the town, then giving up and coasting. Metres/second targets. */
  const targetKmh = (t) => {
    if (t < 25) return 55 + t * 1.6;
    if (t < 70) return 120;
    if (t < 95) return 78;          // tunnel: everyone lifts
    if (t < 140) return 165;        // push
    if (t < 175) return 60;         // slow patch
    if (t < 205) return 140;
    return 45;                      // trailing off
  };
  /* Distraction windows: the wheel is held off-centre for a second and a bit,
     which is what actually puts a car into a parapet. */
  const drift = (t) =>
    (t > 88 && t < 89.6) ? 0.42 :
    (t > 152 && t < 153.4) ? -0.45 :
    (t > 196 && t < 197.2) ? 0.5 : 0;

  let camAt = 0;
  let lane = 1, laneT = 0;
  /* Blockage: how far ahead the nearest active NPC is in a given lane, so the
     autopilot lifts for traffic and picks a clear lane instead of ploughing
     into the back of a bus. Corridor space, because that is the space the
     lanes are defined in. */
  const clearAhead = (zc, k) => {
    let best = 200;
    const off = cor.laneOffset(k, zc);
    for (const n of g.traffic.npcs) {
      if (!n.active) continue;
      const nz = cor.zAt(n.x, n.z);
      let d = nz - zc;
      if (d < 0 || d > 200) continue;
      const p = cor.worldOf(nz, off);
      if (Math.hypot(n.x - p.x, n.z - p.z) > 2.6) continue;
      if (d < best) best = d;
    }
    return best;
  };

  for (let i = 0; i < N; i++) {
    const t = i * DT;
    const car = g.car;
    const zc = cor.zAt(car.x, car.z);
    /* lane choice, at most every 1.6 s so it cannot dither */
    laneT -= DT;
    if (laneT <= 0) {
      laneT = 1.6;
      let bk = lane, bd = clearAhead(zc, lane) + 12; // stickiness
      for (const k of [0, 1, 2]) {
        const d = clearAhead(zc, k);
        if (d > bd) { bd = d; bk = k; }
      }
      lane = bk;
    }
    /* lane-keeping: aim 26 m up the corridor, in the chosen lane */
    const la = cor.laneOffset(lane, zc + 26);
    const aim = cor.worldOf(zc + 26, la);
    const want = Math.atan2(aim.x - car.x, aim.z - car.z);
    const d = drift(t);
    const st = d || Math.max(-1, Math.min(1, wrap(want - car.h) * 2.2));
    const kmh = Math.abs(car.u) * 3.6;
    /* speed: the scripted profile, capped by what the car in front allows */
    const gap = clearAhead(zc, lane);
    const tk = Math.min(targetKmh(t), gap < 26 ? 30 : gap < 55 ? 80 : 999);
    const th = kmh < tk - 3 ? 1 : 0;
    const br = kmh > tk + 10 ? 0.55 : 0;
    window.__neonx.setInput({ th, br, st, hb: 0, horn: 0 });

    window.__neonx.simStep(DT);
    /* the traffic half of the frame loop, so NPCs move and the No Hesi
       near-miss feed is real; rendering is still left out */
    try {
      g.traffic.update(DT, now, car, Math.sin(car.h), Math.cos(car.h),
        g.settings.traffic, false, true, false);
      g.comboUpdate(DT, false);
    } catch (e) { window.__trafErr = String(e); }
    now += DT;

    /* a player switching views mid-drive, so the trace carries more than one
       camera mode */
    if (t > 60 && camAt === 0) { g.camMode = 1; camAt = 1; }
    if (t > 150 && camAt === 1) { g.camMode = 3; camAt = 2; }

    const s = window.__neonx.state();
    tel.tick(DT, car.x, car.z, car.h, car.u, g.camMode, !!s.inTunnel,
      !!s.stats?.mtnOn, s.run.resets, s.stats.nearMisses, s.run.resets,
      s.run.lastImpact);
  }
  tel.setSink(null);
  tel.force(false);
  const s = window.__neonx.state();
  /* one last flush, the way pagehide would */
  tel.setSink((p) => batches.push(p));
  tel.force(true);
  tel.flush();
  tel.setSink(null);
  tel.force(false);
  return {
    batches,
    trafErr: window.__trafErr || null,
    final: {
      dist: Math.round(s.stats.dist), topKmh: Math.round(s.stats.topSpeed * 3.6),
      nearMisses: s.stats.nearMisses, resets: s.run.resets,
      cleanBest: Math.round(s.run.best), simSeconds: SECS,
    },
  };
}, SECS);

if (res.trafErr) console.log("  traffic.update threw:", res.trafErr);
const bytes = res.batches.reduce((a, b) => a + JSON.stringify(b).length, 0);
console.log("batches:", res.batches.length,
  "samples:", res.batches.reduce((a, b) => a + b.n, 0),
  "json bytes:", bytes,
  "=", (bytes / (SECS / 60)).toFixed(0), "B/min");
console.log("final:", JSON.stringify(res.final));
writeFileSync(OUT, JSON.stringify({ map, ...res, url: URL, at: new Date().toISOString() }));
console.log("wrote", OUT);
await browser.close();
