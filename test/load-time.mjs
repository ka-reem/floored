/* Cold-load meter for the perf pass: production build, 4x CPU throttle
   (CDP), one cold visit. Reports the times that make up "hard to load":

   - nav → menu interactive (__neonx debug hook up, DRIVE clickable)
   - DRIVE click → game.loaded (the world build, per-stage breakdown from
     __neonx.loadTimings — the loader's own real milliseconds)
   - every network request for /models/, stamped relative to the DRIVE click,
     so the lazy HD fleet's downloads are provably AFTER first frame — any
     cars-hd fetch that starts before loaded flips would be blocking it.

   SwiftShader + 4x throttle is far slower than any real phone GPU-wise; the
   value is the before/after delta and the ORDER of events, not the absolute
   seconds.

   Usage: node test/load-time.mjs --url http://localhost:3000 [--label before]
            [--tier desktop] [--throttle 4]
*/
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3000");
const LABEL = arg("--label", "run");
const TIER = arg("--tier", "desktop");
const THROTTLE = +arg("--throttle", "4");

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
const cdp = await page.createCDPSession();
await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

const reqs = [];
let t0 = 0, tDrive = 0;
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("/models/")) reqs.push({ url: u.replace(/^.*\/models\//, "models/"), t: performance.now() });
});

t0 = performance.now();
await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 180000 });
const tMenu = performance.now() - t0;

tDrive = performance.now();
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 300000 });
const tLoaded = performance.now() - tDrive;

// let post-load deferred work (HD fleet, PBR detail) issue its fetches
await new Promise((r) => setTimeout(r, 12000));
const timings = await page.evaluate(() => window.__neonx.loadTimings || {});

console.log(`label=${LABEL} tier=${TIER} throttle=${THROTTLE}x`);
console.log(`  nav → menu interactive: ${Math.round(tMenu)} ms`);
console.log(`  DRIVE → loaded (first frame behind overlay): ${Math.round(tLoaded)} ms`);
console.log(`  loader stages (engine's own ms):`);
for (const [k, v] of Object.entries(timings))
  console.log(`    ${k}: ${Math.round(v)} ms`);
console.log(`  /models/ requests (t relative to DRIVE, − = before):`);
for (const r of reqs) {
  const rel = Math.round(r.t - tDrive);
  const afterLoad = r.t - tDrive > tLoaded;
  console.log(`    ${rel} ms ${afterLoad ? "(after loaded)" : "(during load)"}  ${r.url}`);
}
await browser.close();
console.log("done");
