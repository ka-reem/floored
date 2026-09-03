/* Focused corridor photographer: boots the game once and parks the car at a
   list of z stations along the one-way expressway, capturing one screenshot
   each. It is the quick way to look at a change to a single feature (the
   tunnel, the toll plaza, a taper) without paying for the whole smoke run —
   which matters on a loaded machine, where a long SwiftShader session tends to
   get its renderer killed.

   Usage: node test/corridor-shots.mjs --url http://localhost:3000 [z,lane,name ...]
   With no stations listed it shoots the standard tour. */

import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const ART = path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });
const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3000";
const rest = process.argv.slice(2).filter((a) => a !== "--url" && a !== URL);
/* SwiftShader allocates its render targets in ordinary RAM, so on a loaded
   machine a 1280x800 session is the difference between finishing and having the
   renderer killed mid-run. SHOT_W/SHOT_H let a run trade resolution for
   survival without editing the script. */
const VW = Number(process.env.SHOT_W || 1280), VH = Number(process.env.SHOT_H || 800);

const TOUR = [
  [-1300, 0, "10-two-lane"],
  [-640, -1, "11-widen-taper"],
  [-560, -1, "04-exit-signs"],
  [-500, -1, "05-exit-gore"],
  [-300, 1, "12-four-lane"],
  [150, 1, "13-curve"],
  [760, -1, "14-lane-drop"],
  [900, 1, "15-tunnel-mouth"],
  [1080, 1, "16-tunnel-interior"],
  [1330, 2, "17-toll-approach"],
  [1445, 2, "18-toll-plaza"],
  [1560, 1, "21-toll-merge"],
  [1960, 1, "19-splice-end"],
  [-1990, 1, "20-splice-start"],
];
const stations = rest.length
  ? rest.map((a) => {
      const [z, lane, name] = a.split(",");
      return [Number(z), Number(lane), name];
    })
  : TOUR;

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
/* The world is built by the staged loader after this click, not by the
   constructor, so __neonx existing no longer means there is a world to
   drive in — wait for the load to finish before touching it. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(3000);

for (const [z, lane, name] of stations) {
  const info = await page.evaluate(
    ({ z, lane }) => {
      const c = window.__neonx.game.terrain.corridor;
      const n = c.lanes(z);
      const k = Math.min(n - 1, Math.max(0, lane < 0 ? n + lane : lane));
      const p = c.worldOf(z, c.laneOffset(k, z));
      window.__neonx.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, 30);
      window.__neonx.setInput({ th: 0.55 });
      return { lanes: n, hw: c.halfWidth(z), y: p.y };
    },
    { z, lane }
  );
  await sleep(1800);
  const st = await page.evaluate(() => window.__neonx.state());
  console.log(
    `  ${name}: z=${z} lanes=${info.lanes} halfWidth=${info.hw.toFixed(2)}` +
      ` deckY=${info.y.toFixed(2)} → car y=${st.y.toFixed(2)}`
  );
  if (Math.abs(st.y - info.y) > 1.2)
    errors.push(`${name}: car is not on the deck (y ${st.y.toFixed(2)} vs ${info.y.toFixed(2)})`);
  await page.screenshot({ path: path.join(ART, name + ".png") });
  console.log("  📸", name);
}

await browser.close();
if (errors.length) {
  console.log("\n❌ ERRORS:");
  for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 400));
  process.exit(1);
}
console.log("✅ corridor shots captured");
