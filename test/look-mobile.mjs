/* Deterministic look check ON A PHONE, across every shipping camera.

   The sibling of test/look-shots.mjs, with three differences that matter for
   a mobile lane:

   - the page is opened as a 3x phone (touch, deviceScaleFactor 3) with
     `?tier=` forcing the rung under test, because everything a mobile
     optimisation touches is behind `tierCaps` and a desktop viewport gets
     none of it;
   - every player-facing camera is captured, not just the default one. The
     dashcam POV is still shot FIRST because it is the default and the frame
     to judge in, but per AGENTS.md "only matters in CHASE" is not a reason
     to skip a view;
   - the freeze is the same one look-shots.mjs uses and for the same reason:
     hide the fleet, stop the car, pause the sim, pin performance.now and
     Date so the film grain, the blink phases and the burnt-in DVR stamp are
     constants. What is left is a function of the BUILD alone, which is what
     makes "before" and "after" comparable pixel for pixel.

   Run it twice against the same build to get the renderer's own noise floor
   (the CONTROL), then once more after the change. A change is invisible when
   its delta is not bigger than the control's.

   Usage:
     node test/look-mobile.mjs --url http://localhost:3701 --tier mobile-base \
       --shots /tmp/x/before --label before
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3701");
const TIER = arg("--tier", "mobile-base");
const SHOTS = arg("--shots", "/tmp/lane-mobile-shots");
const label = arg("--label", "before");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

/* POV first: the default view and the one to judge in. */
const CAMS = [["pov", 3], ["chase", 0], ["cockpit", 1], ["hood", 2], ["console", 4]];
const PLACES = [["open", 400], ["town", 2400]];

const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  protocolTimeout: 590000,
});
const page = await browser.newPage();
await page.setViewport(PHONE);
await page.setUserAgent(UA);
page.on("pageerror", (e) => console.log("PAGEERR", String(e.message || e).slice(0, 160)));
await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);
await page.evaluate(() => window.__neonx.setTime(22.0));
await sleep(2000);

const freeze = () => page.evaluate(() => {
  const g = window.__neonx.game, t = g.traffic, p = g.post;
  for (const s of t.styles) s.mesh.visible = false;
  t.wheelInst.visible = false;
  t.poolInst.visible = false;
  for (const c of t.cloudList) c.pts.visible = false;
  g.car.u = 0; g.car.v = 0; g.car.r = 0;
  g.running = false;
  const keep = new Set();
  for (let e = document.querySelector("canvas.game"); e; e = e.parentElement) keep.add(e);
  for (const e of document.body.querySelectorAll("*"))
    if (!keep.has(e)) e.style.visibility = "hidden";
  if (!window.__realNow) window.__realNow = performance.now.bind(performance);
  const T = 3000000;
  performance.now = () => T;
  const RD = window.__RealDate || (window.__RealDate = Date);
  const FIXED = 1767225600000;
  window.Date = function (...a) { return a.length ? new RD(...a) : new RD(FIXED); };
  window.Date.now = () => FIXED;
  p.overAt = -999;
  p.updateOverlay(T / 1000);
});
const thaw = () => page.evaluate(() => {
  const g = window.__neonx.game, t = g.traffic;
  for (const s of t.styles) s.mesh.visible = true;
  t.wheelInst.visible = true;
  t.poolInst.visible = true;
  for (const c of t.cloudList) c.pts.visible = true;
  for (const e of document.body.querySelectorAll("*")) e.style.visibility = "";
  performance.now = window.__realNow;
  window.Date = window.__RealDate;
  g.running = true;
});

for (const [pname, z] of PLACES) {
  for (const [cname, ci] of CAMS) {
    await page.evaluate((a) => {
      window.__neonx.setCam(a.ci);
      window.__neonx.toCorridor(a.z, 0, 1);
      window.__neonx.setInput({ th: 0 });
    }, { z, ci });
    await sleep(6000);            // camera smoothing converges on the parked pose
    await page.evaluate((a) => {
      window.__neonx.toCorridor(a.z, 0, 1);
      window.__neonx.setInput({ th: 0 });
    }, { z });
    await sleep(3000);
    await freeze();
    await sleep(2500);            // the POV frame blend settles to a fixed point
    await page.screenshot({ path: path.join(SHOTS, `${label}-${pname}-${cname}.png`) });
    await thaw();
    console.log("shot", pname, cname);
  }
}
await browser.close();
console.log("wrote", SHOTS);
