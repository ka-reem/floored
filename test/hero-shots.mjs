/* Hero photographer — the game at its best, for content rather than for QA.

   Every other shots harness in here answers a question ("is the sign on the
   right shoulder", "does the rock clear the deck"). This one has no question:
   it exists to produce the most attractive frames the renderer can make, at
   the scenic stations, in the cameras that flatter the car and the city.

   So it deliberately does what the QA harnesses must NOT do:
     - forces the HIGH preset and the DESKTOP tier, ignoring what this box
       would have detected, because a content frame should show the ceiling
       rather than the default;
     - turns the HUD and the dashcam grade off by default (--hud / --grade to
       keep them), since overlay chrome is the first thing a viewer reads as
       "someone's screenshot" rather than "a game";
     - shoots at 2x device pixel ratio, because these get cropped and scaled
       into a 1080x1920 canvas afterwards and a 1x frame goes soft.

   Usage: node test/hero-shots.mjs --url http://localhost:3490 [--tag hero]
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes("--" + k);
const URL = arg("url", "http://localhost:3490");
const TAG = arg("tag", "hero");
const OUT = arg("out", path.join(process.cwd(), "test", "artifacts", "hero"));
const ONLY = arg("only", "");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* CAM: 0 chase · 1 cockpit · 2 hood · 3 dashcam · 4 console
   [name, z, lane (negative counts from the fast lane), cam, hour] */
const STATIONS = [
  ["city-chase",      -300, 0, 0, 21.5],
  ["city-cockpit",    -300, 0, 1, 21.5],
  ["curve-chase",       -1180, -1, 0, 21.0],
  ["curve-dashcam",     -1180, -1, 3, 21.0],
  ["tunnel-mouth",       620, 0, 0, 22.0],
  ["tunnel-in",          700, 0, 3, 22.0],
  ["toll-approach",     1310, 0, 0, 20.5],
  ["toll-plaza",        1385, 1, 3, 20.5],
  ["mtn-gore",         -1992, -1, 0, 17.0],
  ["mtn-pass",         -1880, 0, 0, 17.0],
  ["deck-hood",         -700, 0, 2, 23.0],
  ["deck-console",      -700, 0, 4, 23.0],
  ["dawn-chase",         200, -1, 0, 5.2],
  ["dusk-dashcam",       200, -1, 3, 18.4],
];
const list = ONLY ? STATIONS.filter(([n]) => ONLY.split(",").includes(n)) : STATIONS;

const errors = [];
const browser = await puppeteer.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 2 },
  protocolTimeout: 0,
  timeout: 180000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });

/* Force the ceiling BEFORE pressing DRIVE: the preset and the tier are both
   consumed by the first build stage, so setting them after the world exists
   would change the panel and not the picture. */
await page.evaluate(() => {
  const raw = localStorage.getItem("neonx.profile.v3");
  const p = raw ? JSON.parse(raw) : { settings: {} };
  p.settings = p.settings || {};
  p.settings.preset = "high";
  p.settings.tierOverride = "desktop";
  p.settings.reflections = true;
  p.settings.shadows = true;
  p.settings.bloom = true;
  p.settings.fxaa = true;
  p.settings.traffic = 0.85;
  localStorage.setItem("neonx.profile.v3", JSON.stringify(p));
});
await page.reload({ waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });

await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 2400000 });
await sleep(12000);

const tier = await page.evaluate(() => window.__neonx.game.renderTier);
console.log("render tier:", tier);

/* HUD and dashcam grade off unless asked for — see the header. */
if (!has("hud")) {
  await page.addStyleTag({
    content: `#hud, .hud, #tcDrawer, .topbar, .pucks, #mmap, .mmapWrap,
              .hudCorner, .recStamp, [class*="puck"] { opacity: 0 !important; }`,
  });
}
if (!has("grade")) {
  await page.evaluate(() => { try { window.__neonx.game.grade = false; } catch {} });
}

for (const [name, z, lane, cam, hour] of list) {
  await page.evaluate((c) => window.__neonx.setCam(c), cam);
  await page.evaluate((h) => window.__neonx.setTime(h), hour);
  await page.evaluate(({ z, lane }) => {
    const c = window.__neonx.game.terrain.corridor;
    const n = c.lanes(z);
    const k = Math.min(n - 1, Math.max(0, lane < 0 ? n + lane : lane));
    const p = c.worldOf(z, c.laneOffset(k, z));
    window.__neonx.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, 33);
    window.__neonx.setInput({ th: 0.55 });
  }, { z, lane });
  /* long settle: the chase spring, the aurora and the streetlight pools all
     need a few seconds to stop moving, and on SwiftShader a frame is slow */
  await sleep(6000);
  const f = path.join(OUT, `${TAG}-${name}.png`);
  await page.screenshot({ path: f });
  console.log("  📸", path.basename(f));
}
await browser.close();
if (errors.length) {
  console.log("\nerrors:");
  for (const e of errors.slice(0, 8)) console.log("  -", e.slice(0, 200));
}
console.log("✅ done —", list.length, "frames in", OUT);
