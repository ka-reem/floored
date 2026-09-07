/* Pictures of the press glow, with two real fingers on the glass.

   The gallery's picks0905 chapter carries the one claim on the page with no
   picture behind it: that the touch pucks' sodium press glow was fixed. This
   takes that picture — and the one for the controls that were missed at the
   time, the ⋯ chip and the pause gear, which were still on `:active` and so
   never lit at all.

   Multi-touch is dispatched through CDP with the full set of ACTIVE touch
   points; page.touchscreen is single-touch and cannot hold two pucks down.

   Usage: node test/press-glow-shots.mjs --url http://localhost:3703 --dir /tmp
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
const DIR = arg("--dir", "/tmp");
const LABEL = arg("--label", "after");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 390, H = 844, DSR = 3;
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

const cdp = await page.createCDPSession();
const live = new Map();
const pts = () => [...live.entries()].map(([id, p]) =>
  ({ id, x: Math.round(p.x), y: Math.round(p.y), radiusX: 8, radiusY: 8, force: 1 }));
const centre = (id) => page.evaluate((i) => {
  const r = document.getElementById(i)?.getBoundingClientRect();
  return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}, id);
async function down(id, p) {
  live.set(id, p);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts() });
}
async function up(id) {
  const p = live.get(id);
  live.delete(id);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd",
    touchPoints: [{ id, x: Math.round(p.x), y: Math.round(p.y), radiusX: 8, radiusY: 8, force: 0 }] });
}

const crop = async (name, box) => {
  const raw = await page.screenshot({ type: "png" });
  const out = path.join(DIR, `${name}.png`);
  await sharp(raw).extract({
    left: box.l * DSR, top: box.t * DSR, width: box.w * DSR, height: box.h * DSR,
  }).toFile(out);
  console.log("  wrote", out);
  return out;
};

const STRIP = { l: 0, t: H - 210, w: W, h: 210 };   // the puck band
const TOPBAR = { l: W - 140, t: 0, w: 140, h: 70 }; // the gear + ⋯ chip

// --- two pucks held at once -------------------------------------------
await crop(`glow-${LABEL}-pucks-idle`, STRIP);
await down(1, await centre("tcG"));
await sleep(120);
await down(2, await centre("tcL"));
await sleep(120);
console.log("  lit:", await page.evaluate(() =>
  [...document.querySelectorAll(".tc.pressed")].map((e) => e.id).join("+")));
await crop(`glow-${LABEL}-pucks-two`, STRIP);
await up(2);
await up(1);
await sleep(400);

// --- the ⋯ chip, which used to have no press state on touch ----------
await crop(`glow-${LABEL}-more-idle`, TOPBAR);
await down(3, await centre("tcMore"));
await sleep(60);
console.log("  tcMore pressed:", await page.evaluate(() =>
  !!document.getElementById("tcMore")?.classList.contains("pressed")));
await crop(`glow-${LABEL}-more-lit`, TOPBAR);
await up(3);

await browser.close();
