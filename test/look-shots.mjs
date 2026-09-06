/* Deterministic look check: park the car at a fixed pose, hide the fleet,
   freeze the clock, pause the sim, then screenshot. Run before and after a
   change that is supposed to be invisible; the two sheets should match
   pixel for pixel everywhere the static world is drawn. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3202");
const SHOTS = arg("--shots", "/tmp/lane-opt/perf/look-before");
const label = arg("--label", "before");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

const PLACES = [["open", 400], ["tunnel", 1090]];

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERR", String(e.message || e).slice(0, 160)));
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);
await page.evaluate(() => window.__neonx.setTime(22.0));
await sleep(2000);

for (const [name, z] of PLACES) {
  await page.evaluate((z) => { window.__neonx.toCorridor(z, 0, 1); window.__neonx.setInput({ th: 0 }); }, z);
  await sleep(6000); // let the camera smoothing converge on the parked pose
  await page.evaluate((z) => {
    const nx = window.__neonx, g = nx.game;
    nx.toCorridor(z, 0, 1);          // snap to the exact pose again
    nx.setInput({ th: 0 });
  }, z);
  await sleep(3000);
  await page.evaluate(() => {
    const g = window.__neonx.game, t = g.traffic, p = g.post;
    /* Everything below makes the frame a FUNCTION OF THE BUILD and nothing
       else, so two runs can be compared pixel for pixel. */
    // 1. the fleet: where the cars are depends on this run's frame history
    for (const s of t.styles) s.mesh.visible = false;
    t.wheelInst.visible = false;
    t.poolInst.visible = false;
    for (const c of t.cloudList) c.pts.visible = false;
    // 2. the car, stopped dead, and the sim frozen
    g.car.u = 0; g.car.v = 0; g.car.r = 0;
    g.running = false;
    // 3. the DOM HUD (speed, gear, exit hint, minimap) — hide anything that
    //    is not on the path to the WebGL canvas
    const keep = new Set();
    for (let e = document.querySelector("canvas.game"); e; e = e.parentElement) keep.add(e);
    for (const e of document.body.querySelectorAll("*"))
      if (!keep.has(e)) e.style.visibility = "hidden";
    // 4. the clock the film grain, the blinks and the exposure ride on
    if (!window.__realNow) window.__realNow = performance.now.bind(performance);
    const T = 3000000;
    performance.now = () => T;
    // 5. the burnt-in DVR stamp, which reads the wall clock
    const RD = window.__RealDate || (window.__RealDate = Date);
    const FIXED = 1767225600000;
    window.Date = function (...a) { return a.length ? new RD(...a) : new RD(FIXED); };
    window.Date.now = () => FIXED;
    p.overAt = -999;
    p.updateOverlay(T / 1000);
  });
  await sleep(2500);
  await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) });
  await page.evaluate(() => {
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
  console.log("shot", name);
}
await browser.close();
