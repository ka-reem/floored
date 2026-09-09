/* Sign photographer — every cantilever board on the lap, from the driver's
   approach, in the DASHCAM (CAM_POV) that decides whether a sign is readable.

   The stations are parked short of each board so the panel is in the frame
   ahead rather than overhead and out of it, and the car is put in the lane the
   board is FOR: the kerb lane for a right-hand feature, the fast lane for the
   mountain exit. Which shoulder the mast is on is then the thing the picture
   answers.

   Usage: node test/sign-shots.mjs --url http://localhost:3424 --tag after
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("url", "http://localhost:3424");
const TAG = arg("tag", "shot");
const CAM = Number(arg("cam", 3)); // 3 = CAM_POV dashcam
const OUT = arg("out", path.join(process.cwd(), "test", "artifacts", "signs"));
const ONLY = arg("only", "");
mkdirSync(OUT, { recursive: true });
const VW = Number(process.env.SHOT_W || 1440), VH = Number(process.env.SHOT_H || 900);

/* [name, z of the camera, lane index (negative counts from the fast lane)] */
const STATIONS = [
  // --- the mountain exit, EXIT 4: the lap's only LEFT exit ---
  ["mtn-400", 1642 - 70, -1],
  ["mtn-200", 1842 - 70, -1],
  ["mtn-oneway", 1936 - 60, -1],
  ["mtn-gore", -1992 - 70, -1],
  ["mtn-merge", -1734 - 70, -1],
  // --- the bypass merge, also from the east ---
  ["bypass-merge", 1500 - 70, -1],
  // --- the town entrance: a merge from the RIGHT, for contrast ---
  ["town-merge-a", -380 - 70, 0],
  ["town-merge-b", -130 - 70, 0],
  // --- a right-hand exit that was already correct, as the control ---
  ["exit1-200", -700 - 70, 0],
  ["exit1-only", -590 - 60, 0],
];
const list = ONLY ? STATIONS.filter((s) => ONLY.split(",").some((o) => s[0].startsWith(o)))
  : STATIONS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: VW, height: VH },
  /* this box runs several lanes at once and a SwiftShader world load can take
     well past ten minutes under that load — 0 disables the per-call timeout so
     a slow load is slow rather than a crash */
  protocolTimeout: 0,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 2400000 });
await sleep(10000);
await page.evaluate((c) => window.__neonx.setCam(c), CAM);
await page.evaluate(() => window.__neonx.setTime(16.5));
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
