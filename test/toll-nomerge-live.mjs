/* Where does traffic change lane, relative to the toll plaza?

   The bug: NPCs picked a new lane INSIDE the toll plaza — weaving between
   gates under the canopy, which no real plaza does and which traps a player
   who has already committed to a booth. The fix is a no-merge zone in
   traffic.ts; this is the harness that measures whether it worked.

   Unlike test/traffic-merge-sim.mjs and test/hail-sim.mjs — which reimplement
   updateHwy's arithmetic against the real corridor.ts — this one drives the
   REAL game in a headless browser and samples `game.traffic.npcs` directly,
   so the numbers come from the shipping code path rather than from a mirror
   that can drift.

   Method: the player is teleported onto the corridor a few hundred metres
   upstream of the toll approach and driven straight through it under a held
   throttle (the deck is dead straight from z = 880, so no steering is
   needed), repeatedly. Every NPC's lane index is sampled at ~20 Hz; a change
   in `laneK` is one lane change, booked at the z it happened. The output is a
   histogram over the plaza windows plus a throughput count, which is what
   proves the zone did not simply jam the plaza solid.

   Usage: node test/toll-nomerge-live.mjs --url http://localhost:3401 \
            --out test/artifacts/toll-nomerge --tag before --passes 8 */

import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const URL_ = arg("url", "http://localhost:3401");
const OUT = arg("out", "test/artifacts/toll-nomerge");
const TAG = arg("tag", "run");
const PASSES = +arg("passes", 8);
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: "new",
  protocolTimeout: 900000,
  args: [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage",
  ],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  pageerror:", e.message));
await page.goto(debugUrl(URL_), { waitUntil: "domcontentloaded", timeout: 180000 });
console.log("waiting for __neonx…");
await page.waitForFunction("!!window.__neonx", { timeout: 300000 });
console.log("waiting for game.loaded…");
await page.waitForFunction("window.__neonx.game.loaded", { timeout: 600000, polling: 1000 });
await new Promise((r) => setTimeout(r, 10000));
console.log("loaded.");

/* The sampler lives in the page: a rAF loop is the only way to see every
   lane index the game passes through. Sampling from node over CDP at 20 Hz
   would alias straight past short crossings. */
await page.evaluate(() => {
  const g = window.__neonx.game;
  const cor = g.cor;
  const TOLL = { z0: 1280, z1: 1560, plazaZ0: 1390, plazaZ1: 1450 };
  const st = (window.__tollProbe = {
    changes: [],       // { z, from, to }
    passes: 0,         // cars that crossed the whole plaza window
    seen: new Map(),   // npc -> { laneK, wasIn }
    frames: 0,
    run: true,
  });
  const tick = () => {
    if (!st.run) return;
    st.frames++;
    const live = new Set();
    for (const n of g.traffic.npcs) {
      if (!n.active || !n.hw || n.route !== -1 || n.wreck) continue;
      live.add(n);
      const prev = st.seen.get(n);
      const inPlaza = n.s > TOLL.plazaZ0 && n.s < TOLL.plazaZ1;
      if (!prev) {
        st.seen.set(n, { laneK: n.laneK, s: n.s, wasIn: inPlaza, rival: !!n.rival });
        continue;
      }
      // a recycled slot teleports: never book that as a lane change
      const jump = Math.abs(n.s - prev.s) > 40;
      if (!jump && n.laneK !== prev.laneK && !n.rival)
        st.changes.push({ z: +n.s.toFixed(1), from: prev.laneK, to: n.laneK });
      if (!jump && prev.wasIn && !inPlaza && n.s >= TOLL.plazaZ1) st.passes++;
      prev.laneK = n.laneK; prev.s = n.s; prev.wasIn = inPlaza;
    }
    for (const k of st.seen.keys()) if (!live.has(k)) st.seen.delete(k);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const Z_START = 1000, Z_END = 1660;
for (let p = 0; p < PASSES; p++) {
  await page.evaluate((z) => {
    window.__neonx.toCorridor(z, 105, 1);
    window.__neonx.setInput({ th: 0.75, br: 0, st: 0, hb: 0, horn: 0 });
  }, Z_START);
  // let the pass run: ~660 m at ~30 m/s, plus slack for the spawner to fill
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const z = await page.evaluate(() => window.__neonx.game.car.z);
    if (z > Z_END || Date.now() - t0 > 60000) break;
  }
  console.log(`pass ${p + 1}/${PASSES} done`);
}
await page.evaluate(() => { window.__neonx.setInput(null); window.__tollProbe.run = false; });

const data = await page.evaluate(() => ({
  changes: window.__tollProbe.changes,
  passes: window.__tollProbe.passes,
  frames: window.__tollProbe.frames,
}));

const TOLL = { z0: 1280, z1: 1560, plazaZ0: 1390, plazaZ1: 1450 };
const PRE = 90, POST = 40;
const bands = [
  ["approach  (z 1000-1190, outside the zone)", 1000, TOLL.z0 - PRE],
  ["zone lead-in (z 1190-1280)", TOLL.z0 - PRE, TOLL.z0],
  ["fan-out   (z 1280-1390)", TOLL.z0, TOLL.plazaZ0],
  ["PLAZA     (z 1390-1450)", TOLL.plazaZ0, TOLL.plazaZ1],
  ["fan-in    (z 1450-1560)", TOLL.plazaZ1, TOLL.z1],
  ["zone exit (z 1560-1600)", TOLL.z1, TOLL.z1 + POST],
  ["clear     (z 1600-1800, outside the zone)", TOLL.z1 + POST, 1800],
];
const count = (a, b) => data.changes.filter((c) => c.z >= a && c.z < b).length;
const rows = bands.map(([label, a, b]) => ({ label, a, b, n: count(a, b) }));
const zoneN = count(TOLL.z0 - PRE, TOLL.z1 + POST);
console.log(`\n=== ${TAG} === ${data.frames} sampled frames, ${PASSES} passes`);
for (const r of rows) console.log(`  ${r.label.padEnd(44)} ${String(r.n).padStart(4)}`);
console.log(`  ${"NO-MERGE ZONE TOTAL (z 1190-1600)".padEnd(44)} ${String(zoneN).padStart(4)}`);
console.log(`  ${"cars through the plaza window".padEnd(44)} ${String(data.passes).padStart(4)}`);

writeFileSync(path.join(OUT, `${TAG}.json`),
  JSON.stringify({ tag: TAG, passes: PASSES, frames: data.frames, rows, zoneN,
    through: data.passes, changes: data.changes }, null, 2));
console.log(`wrote ${path.join(OUT, TAG + ".json")}`);
await browser.close();
