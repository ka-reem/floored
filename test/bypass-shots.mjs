/* Lane I2 verification: screenshots of the bypass viaduct integration plus a
   live-traffic census on both routes.

   Shots: the diverge (ramp peeling off), the viaduct run (city view), the
   bridge seen FROM the main deck below, the merge, and a cockpit view whose
   head unit + minimap show both route ribbons.

   Census: parks the player (a) on the main deck ahead of the diverge and (b)
   on the viaduct, lets the sim run, and asserts NPCs exist on both routes —
   i.e. the diverge choice fires and the bypass spawner works.

   Usage: node test/bypass-shots.mjs --url http://localhost:3141 [--out DIR] */

import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const argOut = process.argv.indexOf("--out");
const ART = argOut > -1 ? process.argv[argOut + 1] : path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });
const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3141";
const VW = Number(process.env.SHOT_W || 1280), VH = Number(process.env.SHOT_H || 800);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let fail = 0;
const bad = (m) => {
  console.log("  FAIL " + m);
  fail++;
};

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: VW, height: VH },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* The world is built by the staged loader after this click, not by the
   constructor, so __neonx existing no longer means there is a world to
   drive in — wait for the load to finish before touching it. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(3500);

async function shot(name, place, settle = 1600) {
  await page.evaluate(place);
  await sleep(settle);
  const st = await page.evaluate(() => window.__neonx.state());
  await page.screenshot({ path: path.join(ART, name + ".png") });
  console.log(`  ${name}.png  y=${st.y?.toFixed?.(1) ?? "?"} onBypass=${st.onBypass}` +
    ` npcs=${st.npcs} npcsBypass=${st.npcsBypass}`);
  return st;
}

console.log("shots:");
// 1. the diverge, from the kerb lane on the approach
await shot("30-diverge", () => window.__neonx.toCorridor(400, 60, 0));
// 2. up on the viaduct — the elevated run with the city view
await shot("31-viaduct-city", () => window.__neonx.toBypass(560, 60, 0));
// 3. the bridge crossing seen from the main deck below
await shot("32-bridge-from-below", () => window.__neonx.toCorridor(760, 60, 2));
// 4. the crossing from up on the bridge itself
await shot("33-on-the-bridge", () => window.__neonx.toBypass(320, 60, 0));
// 5. the merge, from the viaduct's descent
await shot("34-merge-approach", () => window.__neonx.toBypass(980, 60, 0));
// 6. the merge gore from the deck's fast lane
await shot("35-merge-from-deck", () => window.__neonx.toCorridor(1480, 60, 2));
// 7. cockpit on the bypass: head unit + minimap should both show two ribbons
await page.evaluate(() => window.__neonx.setCam(1));
await shot("36-cockpit-nav-bypass", () => window.__neonx.toBypass(700, 40, 1), 2200);
await page.evaluate(() => window.__neonx.setCam(0));

/* ---- traffic census ------------------------------------------------------
   SwiftShader runs the sim at a few percent of real time (dt is clamped at
   0.1 s and a frame takes ~1 s), so the census shrinks the viewport for
   throughput, reads the organic diverge DECISIONS, then walks decided cars
   up to each junction (a position nudge, all driving logic untouched) and
   watches the diverge and merge conversions actually happen in vivo. */
console.log("traffic census:");
await page.setViewport({ width: 360, height: 220 });
{
  // (a) player on the viaduct — the bypass spawner fills the route
  await page.evaluate(() => window.__neonx.toBypass(120, 80, 0));
  await sleep(6000);
  let seenB = 0;
  for (let i = 0; i < 8; i++) {
    const st = await page.evaluate(() => window.__neonx.state());
    seenB = Math.max(seenB, st.npcsBypass);
    await sleep(700);
  }
  console.log(`  on the viaduct: peak bypass npcs=${seenB}`);
  if (seenB < 2) bad(`bypass stays empty while the player drives it (${seenB})`);

  // (b) organic diverge decisions in the approach window
  await page.evaluate(() => window.__neonx.toCorridor(200, 60, 1));
  await sleep(6000);
  let deciders = 0, total = 0;
  for (let i = 0; i < 20 && deciders === 0; i++) {
    const r = await page.evaluate(() => {
      const t = window.__neonx.game.traffic;
      const act = t.npcs.filter((n) => n.active && n.hw && n.route === -1);
      return {
        total: act.length,
        want: act.filter((n) => n.wantBypass === 1).length,
      };
    });
    total = Math.max(total, r.total);
    deciders = r.want;
    await sleep(1000);
  }
  console.log(`  near the diverge: ${total} deck cars, ${deciders} signalling for the bypass`);
  if (total < 10) bad(`too little traffic on the deck (${total})`);
  if (deciders < 1) bad("no driver ever decides to take the diverge");

  // (c) walk a decided car to the gore and watch the diverge conversion
  const conv = await page.evaluate(async () => {
    const t = window.__neonx.game.traffic;
    const n = t.npcs.find((m) => m.active && m.hw && m.route === -1 && !m.wreck);
    if (!n) return { ok: false, why: "no car" };
    n.s = 498;
    n.laneK = 0;
    n.pendK = -1;
    n.wantBypass = 1;
    n.offCur = n.offT = t.cor.laneOffset(0, 498);
    const t0 = performance.now();
    while (performance.now() - t0 < 90000) {
      await new Promise((r) => setTimeout(r, 500));
      if (!n.active) return { ok: false, why: "recycled" };
      if (n.route === 4) return { ok: true, s: n.s, off: n.offCur, y: n.y };
    }
    return { ok: false, why: `stuck at s=${n.s} route=${n.route}` };
  });
  console.log(`  diverge conversion: ${conv.ok ? `OK — on bypass at s=${conv.s.toFixed(1)}` : "FAILED " + conv.why}`);
  if (!conv.ok) bad(`diverge conversion never fired (${conv.why})`);

  // (d) walk a bypass car into the merge window and watch it yield + rejoin
  await page.evaluate(() => window.__neonx.toBypass(950, 60, 0));
  await sleep(4000);
  const mrg = await page.evaluate(async () => {
    const t = window.__neonx.game.traffic;
    const n = t.npcs.find((m) => m.active && m.hw && m.route === 4 && !m.wreck);
    if (!n) return { ok: false, why: "no bypass car live" };
    const by = t.routes.bypass;
    n.s = t.mergeWin.s0 - 30;
    n.laneK = 0;
    n.pendK = -1;
    n.offCur = n.offT = by.laneOffset(0, n.s);
    const t0 = performance.now();
    while (performance.now() - t0 < 120000) {
      await new Promise((r) => setTimeout(r, 500));
      if (!n.active) return { ok: false, why: "recycled" };
      if (n.route === -1)
        return { ok: true, z: n.s, k: n.laneK, lanes: t.cor.lanes(n.s) };
    }
    return { ok: false, why: `stuck at s=${n.s}` };
  });
  console.log(`  merge conversion: ${mrg.ok
    ? `OK — on main z=${mrg.z.toFixed(1)} lane ${mrg.k}/${mrg.lanes - 1} (fast)` : "FAILED " + mrg.why}`);
  if (!mrg.ok) bad(`merge conversion never fired (${mrg.why})`);
  else if (mrg.k !== mrg.lanes - 1) bad(`merge landed in lane ${mrg.k}, not the fast lane`);
}

const relevant = errors.filter((e) => !/Failed to load resource/.test(e));
if (relevant.length) {
  console.log("page errors:");
  for (const e of relevant.slice(0, 8)) console.log("  " + e);
  bad(`${relevant.length} page error(s)`);
}

await browser.close();
console.log(fail ? `\n${fail} FAILURE(S)` : "\nbypass shots + census OK");
process.exit(fail ? 1 : 0);
