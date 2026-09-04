/* Headless check of the CLEAN RUN score (CLEAN_RUN / runUpdate in
   game/engine.ts) and of the crash rule behind it:

   PART 1 — MEASUREMENT. Five scripted contacts, from a barrier kerbed at a
   shallow angle up to a head-on into a wall, each reporting the peak
   contact-normal closing speed (collide.ts's normalImpact). This is where
   CLEAN_RUN.impact comes from: the threshold is placed in the empty band
   between "scrape" and "impact", not guessed.

   PART 2 — BEHAVIOUR. The distance accumulates while driving, a hard hit
   zeroes it, a scrape does not, and the personal best survives a reload
   through the profile.

   Everything rides __neonx.simStep, which runs the same
   readInput -> stepPhysics -> splice -> collide -> runUpdate pipeline the
   render loop runs, so none of this waits on SwiftShader frame times. NPCs
   do not move inside simStep (traffic is loop-only), which is exactly what
   makes a repeatable "brush that car's flank" test possible.

   Usage: node test/clean-run-check.mjs --url http://localhost:3153 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const ART = path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3153";
/* Render tier for the page. NONE OF THIS TEST IS VISUAL — it is physics,
   collision and persistence — and the lowest tier builds far fewer chunks,
   which is the difference between a world that loads in a minute on a loaded
   box and one that never finishes loading at all. --tier desktop re-runs the
   same numbers on full settings. */
const argTier = process.argv.indexOf("--tier");
const TIER = argTier > -1 ? process.argv[argTier + 1] : "mobile-base";
/** ms to allow for the world build before giving up (--loadms to raise). */
const argLoad = process.argv.indexOf("--loadms");
const LOAD_MS = argLoad > -1 ? Number(process.argv[argLoad + 1]) : 2700000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const ok = (cond, msg) => {
  if (cond) console.log("  OK  ", msg);
  else {
    errors.push(msg);
    console.log("  FAIL", msg);
  }
};

const clickBtn = (page, label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      x.textContent.includes(l)
    );
    if (!b) throw new Error("no button " + l);
    b.click();
  }, label);

async function drive(page) {
  await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
  await clickBtn(page, "DRIVE");
  /* The world build is the one genuinely slow step here. Deliberately a
     single waitForFunction rather than a progress poll: on a contended box
     the shader-compile stage blocks the page's main thread for minutes at a
     time, and every extra evaluate() queued behind it just turns a slow load
     into a protocol timeout. */
  await page.waitForFunction(() => window.__neonx?.game?.loaded, {
    timeout: LOAD_MS, polling: 5000,
  });
  /* Let the RENDER LOOP run for a while before anything is measured: traffic
     is loop-only (simStep deliberately leaves it out), so the NPC scenarios
     below have nothing to aim at until the loop has spawned the stream — and
     on SwiftShader that is a handful of frames a second. */
  await page.waitForFunction(() => window.__neonx.state().npcs > 3, {
    timeout: 300000, polling: 2000,
  }).catch(() => {});
}

const state = (page) => page.evaluate(() => window.__neonx.state());

/* Place the car on the deck at station z, `lat` metres off the centreline,
   heading `deg` degrees off the road direction, at `ms` metres/second, then
   run the sim for `secs`. Returns the peak contact-normal closing speed seen
   and the clean-run state either side. */
const wallRun = (page, { z, ref, off, deg, ms, secs }) =>
  page.evaluate(
    ({ z, ref, off, deg, ms, secs }) => {
      const nx = window.__neonx, g = nx.game, c = g.terrain.corridor;
      /* The deck WIDENS and narrows along its length, so a lateral offset is
         only meaningful relative to something: ref "wall" is `off` metres
         inside the east parapet at THIS station, ref "centre" is `off` metres
         out from the centreline. worldOf(z, lat) takes the station first;
         +lat is along the corridor normal, and rotating the heading by +deg
         steers toward +lat, so a positive angle always drives into that
         parapet. */
      const lat = ref === "wall" ? c.halfWidth(z) - off : off;
      const p = c.worldOf(z, lat);
      nx.teleport(p.x, p.z, p.y + 0.05, c.pose(z).h + (deg * Math.PI) / 180, ms);
      nx.setInput({ th: 0.35, br: 0, st: 0 });
      nx.clearImpacts();
      const before = { ...nx.state().run };
      nx.simStep(secs);
      const s = nx.state();
      nx.setInput(null);
      return {
        peak: s.impactMax,
        n: s.impacts.length,
        before,
        after: s.run,
      };
    },
    { z, ref, off, deg, ms, secs }
  );

/* Same, but aimed at an NPC: pick the nearest active NPC ahead, drop the car
   `back` metres behind it and `side` metres to one side, pointing `deg` off
   its heading. NPCs are frozen inside simStep, so the geometry holds. */
const npcRun = (page, { back, side, deg, dv, secs }) =>
  page.evaluate(
    ({ back, side, deg, dv, secs }) => {
      const nx = window.__neonx, g = nx.game;
      /* The NEAREST live NPC in any direction. simStep never runs traffic, so
         the cars sit exactly where the render loop parked them at load — the
         car is teleported to them rather than the other way round, and
         "ahead of me" would only rule out perfectly good targets. */
      const car = g.car;
      let best = null, bd = 1e9;
      for (const n of g.traffic.npcs) {
        if (!n.active || n.wreck) continue;
        const dx = n.x - car.x, dz = n.z - car.z;
        const d = Math.hypot(dx, dz);
        if (d > 600) continue;
        if (d < bd) { bd = d; best = n; }
      }
      if (!best) return { none: true };
      const h = best.hVis;
      const fx = Math.sin(h), fz = Math.cos(h);
      const rx = fz, rz = -fx; // right of the NPC
      /* `side` is a GAP, measured from the point where the two bodies just
         touch — the half-widths are what decide that, and they differ per
         vehicle. A brush has to start within a few centimetres of contact:
         simStep leaves the NPC parked while the car keeps its real speed, so
         the two are only abreast for a fraction of a second and a lateral
         drift of ~1 m/s has no time to close a metre. */
      const gap = side === 0 ? 0 : best.W / 2 + g.rig.halfW + side;
      const x = best.x - fx * back + rx * gap;
      const z = best.z - fz * back + rz * gap;
      /* Speed is set RELATIVE TO THE NPC (dv), because that is what the
         contact severity is made of: the collision reads the NPC's own
         cruising velocity even though simStep leaves it parked, so a car
         matched to its speed and angled a degree or two into its flank is a
         genuine brush, and dv is a genuine closing speed. */
      nx.teleport(x, z, best.y + 0.05, h + (deg * Math.PI) / 180, best.v + dv);
      nx.setInput({ th: 0, br: 0, st: 0 });
      nx.clearImpacts();
      const before = { ...nx.state().run };
      nx.simStep(secs);
      const s = nx.state();
      nx.setInput(null);
      return {
        peak: s.impactMax,
        n: s.impacts.length,
        npcV: best.v,
        before,
        after: s.run,
      };
    },
    { back, side, deg, dv, secs }
  );

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    ],
    defaultViewport: { width: 800, height: 600 },
    protocolTimeout: 3600000,
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message || e)));
  /* Fresh profile WITHOUT a second navigation: on a loaded box the app can
     take minutes to boot, and paying for that twice is what a clear-then-
     reload costs. The sessionStorage latch makes the wipe fire on the first
     document only, so the reload at the end of the run still finds the
     profile it is meant to be checking. */
  await page.evaluateOnNewDocument(() => {
    try {
      if (!sessionStorage.getItem("__wiped")) {
        localStorage.clear();
        sessionStorage.setItem("__wiped", "1");
      }
    } catch {}
  });

  console.log("-> loading", URL);
  await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 600000 });
  console.log("   page served; waiting for the engine");
  await drive(page);
  console.log("   world loaded");

  /* ---------------- PART 1: contact severity measurements ---------------- */
  console.log("\n== contact severity (peak closing speed along the contact normal) ==");
  const rows = [];
  const measure = async (name, fn) => {
    const r = await fn();
    if (r.none) {
      console.log(`  ${name}: NO NPC FOUND`);
      return null;
    }
    rows.push({ name, peak: r.peak, n: r.n, reset: r.after.resets - r.before.resets });
    const reset = r.after.resets - r.before.resets;
    console.log(
      `  ${name.padEnd(36)} peak ${r.peak.toFixed(2).padStart(6)} m/s -> ` +
        (reset ? `RESET at ${r.after.lastImpact.toFixed(2)}` : "kept")
    );
    return r;
  };

  const halfW = await page.evaluate(
    () => window.__neonx.game.terrain.corridor.halfWidth(600)
  );
  console.log(
    `  (deck half-width at z=600: ${halfW.toFixed(2)} m;` +
      ` ${(await state(page)).npcs} NPCs on the road)`
  );

  /* NPC CONTACTS FIRST, while the car is still parked in the traffic the
     loop spawned around it. */
  await measure("NPC flank brush, 1.5 deg, matched speed", () =>
    npcRun(page, { back: -1, side: 0.05, deg: -1.5, dv: 0, secs: 2 }));
  await measure("NPC flank brush, 3 deg, matched speed", () =>
    npcRun(page, { back: -1, side: 0.05, deg: -3, dv: 0, secs: 2 }));
  await measure("nudge traffic from behind, +4 m/s", () =>
    npcRun(page, { back: 14, side: 0, deg: 0, dv: 4, secs: 3 }));
  await measure("rear-end traffic, +8 m/s", () =>
    npcRun(page, { back: 20, side: 0, deg: 0, dv: 8, secs: 3 }));
  await measure("rear-end traffic, +12 m/s", () =>
    npcRun(page, { back: 26, side: 0, deg: 0, dv: 12, secs: 3 }));
  await measure("square hit on traffic, +18 m/s", () =>
    npcRun(page, { back: 24, side: 0, deg: 0, dv: 18, secs: 3 }));

  /* THE SCRAPES: shallow-angle kerbing, the contact a player makes by
     drifting a lane too far — fast along the barrier, barely anything into
     it. Four stations, because the deck bends and the approach a fixed
     heading offset actually produces varies with the curvature. */
  for (const [z, deg, ms] of [
    [600, 1, 50], [900, 2, 50], [1200, 1, 25], [1500, 2, 25],
  ])
    await measure(`barrier kerb, ${deg} deg @ ${Math.round(ms * 3.6)} km/h`, () =>
      wallRun(page, { z, ref: "wall", off: 2.4, deg, ms, secs: 5 }));

  /* THE IMPACTS: driving at the barrier rather than along it. */
  await measure("wall at 20 deg @ 180 km/h", () =>
    wallRun(page, { z: 1800, ref: "centre", off: 2, deg: 20, ms: 50, secs: 4 }));
  await measure("wall at 45 deg @ 90 km/h", () =>
    wallRun(page, { z: 2100, ref: "centre", off: 2, deg: 45, ms: 25, secs: 4 }));
  await measure("head-on into a wall, 90 deg @ 90 km/h", () =>
    wallRun(page, { z: 600, ref: "centre", off: 2, deg: 90, ms: 25, secs: 4 }));

  writeFileSync(
    path.join(ART, "clean-run-impacts.json"),
    JSON.stringify(rows, null, 2)
  );

  /* ---------------- PART 2: the score itself ---------------- */
  console.log("\n== clean-run behaviour ==");

  /* 1. accumulation, against the lifetime odometer's own integration. The
     road is emptied first: simStep leaves NPCs parked (traffic is loop-only),
     so a blind full-throttle run down a live lane is a run into the back of a
     stationary car, which is a crash test, not a distance test. */
  await page.evaluate(() => {
    for (const n of window.__neonx.game.traffic.npcs) n.active = false;
    window.__neonx.setInput({ th: 1 });
  });
  const a0 = await state(page);
  /* Six short bursts, each re-centred in lane, rather than one long one: the
     corridor BENDS, and a straight-ahead throttle-only run walks into the
     parapet inside half a minute — which is a crash test, not a distance
     test. A teleport moves the car without moving the odometer, so the six
     bursts add up exactly as one drive would. */
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++) {
      window.__neonx.toCorridor(400 + i * 400, 150);
      window.__neonx.simStep(4);
    }
  });
  const a1 = await state(page);
  await page.evaluate(() => window.__neonx.setInput(null));
  const dRun = a1.run.dist - a0.run.dist;
  const dStat = a1.stats.dist - a0.stats.dist;
  console.log(`  24 s of driving: clean run +${dRun.toFixed(1)} m, odometer +${dStat.toFixed(1)} m`);
  ok(dRun > 500, `clean-run distance accumulated (${dRun.toFixed(1)} m)`);
  ok(
    a1.run.resets === a0.run.resets ? Math.abs(dRun - dStat) < 0.01 : true,
    "clean-run distance is the odometer's own integration"
  );
  ok(a1.run.best >= a1.run.dist - 0.01, "best tracks the running distance");

  // 2. a scrape does NOT reset
  const beforeScrape = (await state(page)).run;
  const scr = await wallRun(page, { z: 1200, ref: "wall", off: 2.4, deg: 1, ms: 25, secs: 6 });
  const afterScrape = (await state(page)).run;
  console.log(
    `  scrape: peak ${scr.peak.toFixed(2)} m/s, dist ${beforeScrape.dist.toFixed(0)}` +
      ` -> ${afterScrape.dist.toFixed(0)} m`
  );
  ok(scr.peak > 0, `the scrape really made contact (peak ${scr.peak.toFixed(2)} m/s)`);
  ok(afterScrape.resets === beforeScrape.resets, "a scrape did not end the run");
  ok(afterScrape.dist > beforeScrape.dist, "the run kept counting through the scrape");

  // 3. a hard hit DOES reset
  const beforeHit = (await state(page)).run;
  const hit = await wallRun(page, { z: 900, ref: "centre", off: 2, deg: 90, ms: 25, secs: 4 });
  const afterHit = (await state(page)).run;
  console.log(
    `  hard hit: peak ${hit.peak.toFixed(2)} m/s, dist ${beforeHit.dist.toFixed(0)}` +
      ` -> ${afterHit.dist.toFixed(0)} m, resets ${beforeHit.resets} -> ${afterHit.resets}`
  );
  ok(afterHit.resets === beforeHit.resets + 1, "a hard hit ended the run exactly once");
  ok(afterHit.dist < beforeHit.dist, "the run distance was zeroed by the hit");
  ok(
    afterHit.best >= beforeHit.dist - 1,
    `the best survived the reset (${afterHit.best.toFixed(0)} m)`
  );

  // 4. persistence across a reload
  const before = await state(page);
  await page.keyboard.press("Escape");
  await sleep(500);
  await clickBtn(page, "RESUME"); // persist() runs here
  await sleep(500);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("neonx.profile.v3") || "null")
  );
  console.log(
    `  stored cleanRunBest ${Math.round(stored?.cleanRunBest ?? -1)} m` +
      ` (engine says ${before.run.best.toFixed(0)})`
  );
  ok(
    stored && Math.abs(stored.cleanRunBest - before.run.best) < 60,
    "profile stored cleanRunBest"
  );
  ok(!("noHesiBest" in (stored || {})), "the retired noHesiBest key is gone from the profile");
  ok(
    stored?.settings && !("noHesiScore" in stored.settings) &&
      typeof stored.settings.cleanRunScore === "boolean",
    "the settings toggle is stored under its new name"
  );

  await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 600000 });
  await drive(page);
  const after = await state(page);
  console.log(
    `  after reload: best ${after.run.best.toFixed(0)} m, this run ${after.run.dist.toFixed(1)} m`
  );
  ok(after.run.best >= stored.cleanRunBest - 1, "the personal best survived the reload");
  ok(after.run.dist < 40, `the run itself started over (${after.run.dist.toFixed(1)} m)`);

  await browser.close();
  console.log(errors.length ? `\n${errors.length} FAILURE(S)` : "\nALL CHECKS PASSED");
  for (const e of errors) console.log("  -", e);
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
