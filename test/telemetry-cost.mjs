/* What the sampler costs, against a control on the same box.

   This machine has NO GPU (SwiftShader, seconds per frame), so an absolute
   frame time here means nothing and a before/after of two page loads means
   less. What survives contention is a RATIO measured in one page, in blocks
   that interleave, against a piece of the game's own work that runs at the
   same rate and is known to be affordable.

   The control is chunksUpdate() — the engine's existing 6.25 Hz chunk walk,
   the very tick the sampler rides. If the sampler is a small fraction of the
   work already being done on that tick, it cannot be what makes a phone drop
   a frame.

   Three measurements, all interleaved A/B/A/B so drift in the box hits both:
     OFF   telemetryTick() with analytics off — the production path for an
           opted-out or blocked browser, and the "free when off" claim
     ON    telemetryTick() sampling for real
     CTRL  chunksUpdate(), same tick, same build

   Usage: node test/telemetry-cost.mjs --url http://localhost:3277 --out cost.json
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3277");
const OUT = arg("--out", "test/artifacts/telemetry/cost.json");
const ROUNDS = Number(arg("--rounds", 9));
const ITERS = Number(arg("--iters", 4000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 900, height: 600 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  pageerror:", String(e.message || e).slice(0, 140)));
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);

const r = await page.evaluate(async (ROUNDS, ITERS) => {
  const g = window.__neonx.game, tel = window.__neonx.telemetry;
  const car = g.car;
  let sunk = 0, sunkBytes = 0;
  tel.setSink((p) => { sunk++; sunkBytes += JSON.stringify(p).length; });

  /* the exact call the engine makes, with live car values so nothing can be
     constant-folded away */
  const one = (i) => tel.tick(0.16, car.x + (i % 17), car.z + (i % 31), car.h,
    car.u + (i % 7) * 0.1, i & 3, (i & 15) === 0, false, 0, 0, 0, 0);

  const block = (fn, n) => {
    const t = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    return (performance.now() - t) * 1000 / n; // microseconds per call
  };

  // warm both paths so JIT state is not part of the first block
  tel.force(false); block(one, 2000);
  tel.force(true); block(one, 2000);
  g.chunksUpdate(); g.chunksUpdate();

  const off = [], on = [], ctrl = [];
  for (let r2 = 0; r2 < ROUNDS; r2++) {
    tel.force(false); off.push(block(one, ITERS));
    tel.force(true); on.push(block(one, ITERS));
    ctrl.push(block(() => g.chunksUpdate(), 200));
  }

  /* the once-per-30 s piece of work on its own: encoding a full batch */
  tel.force(true);
  const enc = [];
  for (let r2 = 0; r2 < ROUNDS; r2++) {
    for (let i = 0; i < 94; i++) one(i);       // fill a 30 s batch
    const t = performance.now();
    tel.flush();
    enc.push((performance.now() - t) * 1000);  // microseconds for the whole flush
  }
  tel.force(false); tel.setSink(null);
  return { off, on, ctrl, enc, sunk, sunkBytes };
}, ROUNDS, ITERS);

const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const f3 = (n) => n.toFixed(3);
const out = {
  url: URL, rounds: ROUNDS, iters: ITERS,
  off_us: med(r.off), on_us: med(r.on), ctrl_us: med(r.ctrl), flush_us: med(r.enc),
  raw: r,
};
out.delta_us = out.on_us - out.off_us;
/* what it costs per second of play at the tick's own rate */
out.on_us_per_sec = out.on_us * 6.25 + out.flush_us / 30;
out.ctrl_us_per_sec = out.ctrl_us * 6.25;
out.pct_of_ctrl = (out.on_us_per_sec / out.ctrl_us_per_sec) * 100;

console.log(`  OFF   ${f3(out.off_us)} us/call   (analytics off: the early return)`);
console.log(`  ON    ${f3(out.on_us)} us/call   (sampling for real)`);
console.log(`  CTRL  ${f3(out.ctrl_us)} us/call  chunksUpdate(), same 6.25 Hz tick`);
console.log(`  FLUSH ${f3(out.flush_us)} us      once per 30 s, 94 samples`);
console.log(`  per second of play: sampler ${f3(out.on_us_per_sec)} us  vs  chunksUpdate ${f3(out.ctrl_us_per_sec)} us` +
  `  = ${out.pct_of_ctrl.toFixed(2)}% of the work already on this tick`);
console.log(`  rounds off: ${r.off.map((v) => v.toFixed(3)).join(" ")}`);
console.log(`  rounds on : ${r.on.map((v) => v.toFixed(3)).join(" ")}`);
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log("wrote", OUT);
await browser.close();
