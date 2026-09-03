/* Full-lap dashcam contact sheet: parks the car at fixed z stations around the
   whole loop (default every 100 m), CAM_POV, night, and captures one shot per
   station plus renderer.info.render.calls — the before/after evidence pair for
   the map-transform lane.

   Usage: node lapshots.mjs --url http://localhost:3000 --out DIR [--step 100]
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3000");
const OUT = arg("--out", "shots");
const STEP = Number(arg("--step", "100"));
/* --clear empties the NPC pool at each station before shooting: with the
   car parked, traffic otherwise stacks up around it and blocks the very
   roadside the sheet exists to judge. */
const CLEAR = process.argv.includes("--clear");
mkdirSync(OUT, { recursive: true });

const VW = Number(process.env.SHOT_W || 1280), VH = Number(process.env.SHOT_H || 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

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
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(4000);

const stats = [];
for (let z = -2000; z < 2000; z += STEP) {
  const name = `z${String(z).replace("-", "m").padStart(5, "0")}`;
  const info = await page.evaluate((z) => {
    const nx = window.__neonx;
    nx.toCorridor(z, 0);
    nx.setInput({ th: 0, br: 1 });
    return { lanes: nx.game.terrain.corridor.lanes(z) };
  }, z);
  await sleep(1400);
  if (CLEAR) {
    await page.evaluate(() => {
      for (const n of window.__neonx.game.traffic.npcs) n.active = false;
    });
    await sleep(900); // a rendered frame or two, so the pool write lands
  }
  const st = await page.evaluate(() => {
    const nx = window.__neonx;
    const r = nx.game.renderer.info.render;
    const s = nx.state();
    return { calls: r.calls, tris: r.triangles, x: s.x, y: s.y, z: s.z };
  });
  stats.push({ z, lanes: info.lanes, calls: st.calls, tris: st.tris });
  await page.screenshot({ path: path.join(OUT, name + ".jpg"), quality: 78, type: "jpeg" });
  console.log(`  📸 ${name} lanes=${info.lanes} calls=${st.calls} tris=${st.tris}`);
}
writeFileSync(path.join(OUT, "stats.json"), JSON.stringify(stats, null, 1));

await browser.close();
if (errors.length) {
  console.log("\n⚠ page errors:");
  for (const e of errors.slice(0, 15)) console.log("  -", e.slice(0, 300));
}
console.log("✅ lap contact sheet captured →", OUT);
