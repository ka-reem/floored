/* Dashcam evidence shots for the perf-pass lane: the handful of spots whose
   geometry/textures the lane touched — mountain chevron corner, the waypoint
   lamps, the toll plaza props, the canyon ad boards, the town lamp field —
   CAM_POV, night, so a before/after pair proves no perceptible loss.

   Usage: node test/perf-shots.mjs --url http://localhost:3000 --out DIR
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3000");
const OUT = arg("--out", "perf-shots");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(12000); // deferred fetches (props, HD fleet) land before judging

/* [name, placer] — placers run in page context */
const SPOTS = [
  ["mtn-corner", () => window.__neonx.toMountain(150, 0)],
  ["mtn-lamp-gore", () => window.__neonx.toMountain(30, 0)],
  ["toll-approach", () => window.__neonx.toCorridor(1350, 0)],
  ["canyon-boards", () => window.__neonx.toCorridor(1700, 0)],
  ["town-lamps-west", () => window.__neonx.toCorridor(-400, 0)],
  ["open-south", () => window.__neonx.toCorridor(-1800, 0)],
];

for (const [name, place] of SPOTS) {
  await page.evaluate((src) => {
    const nx = window.__neonx;
    eval(`(${src})()`);
    nx.setCam(3); // CAM_POV
    nx.setInput({ th: 0, br: 1 });
    for (const n of nx.game.traffic.npcs) if (n.active) n.active = false;
  }, place.toString());
  await sleep(3500);
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), quality: 85, type: "jpeg" });
  console.log(`  shot ${name}`);
}
console.log(errors.length ? `page errors: ${errors.join(" | ")}` : "no page errors");
await browser.close();
console.log("done");
