/* Photograph the mountain road at matched points for a BEFORE/AFTER pair.

   Why not reuse mountain-shots.mjs: that one parks at fixed ARCLENGTHS, which
   is the right thing when photographing one build but the wrong thing when
   comparing two. The 2026-09-08 rebuild changed the route's length (412 → 364
   m), so s=168 is a different place in the journey on each side and a pair
   shot there compares two different corners. This parks at FRACTIONS of the
   route instead, so "a third of the way down the pass" means the same thing
   in both frames.

   It also shoots each place TWICE — CAM_POV (the default, and the first frame
   to judge in) and CAM_CHASE (which fronts the rebuilt exterior and is where
   road WIDTH actually reads; a dashcam at night shows very little of the
   pavement the driver is standing on). AGENTS.md: every camera ships.

   Usage: node test/mountain-compare.mjs --url http://localhost:3101 --label after
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3000");
const LABEL = arg("--label", "run");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts", "mtn-compare"));
const CAM_CHASE = 0, CAM_POV = 3;

/* Fractions of route length, plus the two deck-side views of the gores. The
   apex is where the road is furthest out over the water and is the shot that
   carries "how wide is this thing". */
const PLACES = [
  ["entry", 0.10], ["outbound", 0.28], ["apex", 0.50],
  ["homebound", 0.72], ["rejoin", 0.92],
];

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 1280, height: 720 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);
await page.evaluate(() => window.__neonx.setTime(22.0));
await sleep(1500);

const len = await page.evaluate(() => window.__neonx.game.world.routes.mtn.len);
console.log(`${LABEL}: mountain route is ${len.toFixed(1)} m`);

for (const [name, frac] of PLACES) {
  const s = Math.max(6, Math.min(len - 6, len * frac));
  for (const [cam, camName] of [[CAM_POV, "pov"], [CAM_CHASE, "chase"]]) {
    await page.evaluate(({ s, cam }) => {
      const g = window.__neonx;
      g.setCam(cam);
      g.toMountain(s, 90, 0);
      g.setInput({ th: 0.3, br: 0, st: 0, hb: 0, horn: 0 });
    }, { s, cam });
    /* Two settles: the first frames after a teleport still carry the old
       chase-camera position, and CHASE in particular lerps in over ~1 s of
       sim time — which on SwiftShader is several rendered frames. */
    await sleep(2600);
    const f = path.join(OUT, `${LABEL}-${name}-${camName}.jpg`);
    await page.screenshot({ path: f, type: "jpeg", quality: 86 });
    console.log("  📸", path.basename(f), `s=${s.toFixed(0)}`);
  }
}
await browser.close();
