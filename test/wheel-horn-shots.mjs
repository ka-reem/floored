/* Before/after shots for the removal of the horn button sitting over the
   steering wheel.

   Shoots the phone's bottom control strip in WHEEL steer mode, which is the
   only mode the wheel — and the HORN boss painted in the middle of it — is on
   screen at all. One crop holds both the wheel (left) and the right-hand puck
   cluster, so the same picture shows the hub gone AND the HORN puck still
   there.

   Usage: node test/wheel-horn-shots.mjs --url http://localhost:3703 --label before
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import sharp from "sharp";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3703");
const LABEL = arg("--label", "run");
const DIR = arg("--dir", "/tmp");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = 390, H = 844, DSR = 3;
const STRIP_H = 250; // CSS px of the bottom control band

mkdirSync(DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 590000,
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DSR, isMobile: true, hasTouch: true });
// wheel steer mode: the only mode that puts the wheel (and its hub) on screen
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("neonx.profile.v3", JSON.stringify({ settings: { steerMode: "wheel" } }));
});
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);
await page.evaluate(() => { window.__neonx.setCam(3); window.__neonx.setTime(22.0); });
await sleep(4000);

const geom = await page.evaluate(() => {
  const r = (id) => {
    const e = document.getElementById(id);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return b.width ? { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) } : null;
  };
  return {
    swheel: r("swheel"), swheelHub: r("swheelHub"), tcH: r("tcH"),
    tcC: r("tcC"), tcF: r("tcF"), tcG: r("tcG"), tcB: r("tcB"), hud: r("hud"),
  };
});
console.log(JSON.stringify(geom, null, 2));

const full = path.join(DIR, `wheelhorn-${LABEL}-full.png`);
await page.screenshot({ path: full });
const crop = path.join(DIR, `wheelhorn-${LABEL}-strip.png`);
await sharp(full)
  .extract({ left: 0, top: (H - STRIP_H) * DSR, width: W * DSR, height: STRIP_H * DSR })
  .toFile(crop);
console.log("wrote", full, "and", crop);
await browser.close();
