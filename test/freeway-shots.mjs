/* Freeway exit/entrance photographer.

   Shoots the APPROACH as a sequence — 1 km / 500 m / 200 m / at the gore —
   which is the thing that proves an exit is announced rather than sprung on
   the driver. One run covers the town exit gore, the town entrance and the
   bypass diverge, in whichever camera is asked for.

   Usage:
     node test/freeway-shots.mjs --url http://localhost:3311 --tag before
     node test/freeway-shots.mjs --url ... --tag after --cam 0   (CHASE)
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("url", "http://localhost:3311");
const TAG = arg("tag", "shot");
const CAM = Number(arg("cam", 3)); // 3 = CAM_POV dashcam
const OUT = arg("out", path.join(process.cwd(), "test", "artifacts", "freeway"));
const TIME = arg("time", "");
const ONLY = arg("only", "");
mkdirSync(OUT, { recursive: true });
const VW = Number(process.env.SHOT_W || 1440), VH = Number(process.env.SHOT_H || 900);

/* z of each station, relative to the feature it is approaching. Named by the
   distance-to-gore so the file list itself reads as the sequence. */
const EXIT_Z = -500, ENTRY_Z = 20, DIVERGE = 500, MERGE = 1580;
const STATIONS = [
  ["exit-1000", EXIT_Z - 1000, 0],
  ["exit-500", EXIT_Z - 500, 0],
  ["exit-200", EXIT_Z - 200, 0],
  ["exit-060", EXIT_Z - 60, 0],
  ["exit-gore", EXIT_Z + 6, 0],
  ["entry-300", ENTRY_Z - 300, 0],
  ["entry-120", ENTRY_Z - 120, 0],
  ["entry-gore", ENTRY_Z + 4, 0],
  ["div-1000", DIVERGE - 1000, 0],
  ["div-500", DIVERGE - 500, 0],
  ["div-200", DIVERGE - 200, 0],
  ["div-gore", DIVERGE + 6, 0],
  ["mrg-200", MERGE - 200, 0],
  ["mrg-gore", MERGE + 6, 0],
];
const list = ONLY ? STATIONS.filter((s) => ONLY.split(",").some((o) => s[0].startsWith(o))) : STATIONS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: VW, height: VH },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);
await page.evaluate((c) => window.__neonx.setCam(c), CAM);
if (TIME) await page.evaluate((t) => window.__neonx.setTime(Number(t)), TIME);
await sleep(1500);

for (const [name, z, lane] of list) {
  await page.evaluate(({ z, lane }) => {
    const c = window.__neonx.game.terrain.corridor;
    const n = c.lanes(z);
    const k = Math.min(n - 1, Math.max(0, lane < 0 ? n + lane : lane));
    const p = c.worldOf(z, c.laneOffset(k, z));
    window.__neonx.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, 26);
    window.__neonx.setInput({ th: 0.35 });
  }, { z, lane });
  await sleep(2600);
  const f = path.join(OUT, `${TAG}-${name}.png`);
  await page.screenshot({ path: f });
  console.log("  📸", path.basename(f));
}
await browser.close();
if (errors.length) {
  console.log("\n❌ ERRORS:");
  for (const e of errors.slice(0, 12)) console.log("  -", e.slice(0, 300));
  process.exit(1);
}
console.log("✅ done");
