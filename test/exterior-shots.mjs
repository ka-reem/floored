/* Player EXTERIOR photographer: the chase camera, at night, on one fixed
   pinned frame, so two runs of two different body GLBs differ ONLY by the
   GLB. Deterministic by construction — teleport parks the car (v=0), the
   clock is frozen with setFixedDt and advanced a fixed number of step()s,
   and the time of day is pinned — which is what makes a run-to-run noise
   floor meaningful.

   setPerfMode(false) is not optional: a software renderer trips PERFORMANCE
   MODE within seconds of loading and halves the resolution of everything
   captured after it (game/engine.ts), which is exactly the detail under test.

   Usage: node test/exterior-shots.mjs --out DIR [--tag NAME] [--glb FILE]
*/
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { serveExport } from "./lib/cf-assets-server.mjs";
import { debugUrl } from "./lib/debug-url.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const OUT = arg("--out", path.join(ROOT, "test", "artifacts", "exterior"));
const TAG = arg("--tag", "shot");
const GLB = arg("--glb", "");
mkdirSync(OUT, { recursive: true });

/* Swap the body in the SERVED export, not in public/ — the working tree stays
   clean and the only thing that changes between runs is these 1.4 MB. */
const SERVED = path.join(ROOT, "out", "models", "player", "volvo-s90-body-lite.glb");
if (GLB) {
  if (!existsSync(GLB)) { console.error("no such glb:", GLB); process.exit(2); }
  copyFileSync(GLB, SERVED);
  console.log(`body <- ${path.basename(GLB)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { url, close } = await serveExport(path.join(ROOT, "out"));
console.log("serving", url);

const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
         "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 900000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("favicon") && !t.includes("WebSocket")) errors.push(t);
});

await page.goto(debugUrl(url), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DRIVE"))?.click());
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 900000 });
console.log("world loaded");
await sleep(9000); // HD fleet, props and the donor body all land after `loaded`

/* Freeze everything that could drift between runs. */
await page.evaluate(() => {
  const nx = window.__neonx;
  nx.setPerfMode(false);          // else every capture is half-resolution
  nx.setTime(22.0);               // night: this is a night game
  nx.setInput({ th: 0, br: 0, st: 0, hb: 0, horn: 0 });
  nx.toCorridor(-1300, 0, 1);
});
await sleep(2500);
await page.evaluate(() => {
  const nx = window.__neonx;
  nx.teleport(nx.game.car.x, nx.game.car.z, undefined, nx.game.car.h, 0);
  nx.setCam(0);                   // CAM_CHASE — the view under test
  nx.setFixedDt(1 / 30);
});
for (let i = 0; i < 40; i++) { await page.evaluate(() => window.__neonx.step()); }
await sleep(1200);

/* A lost graphics context still screenshots perfectly happily — it just
   screenshots the "Graphics context lost" panel. Under SwiftShader that
   happens often enough that a silent crash frame would otherwise be averaged
   into a noise floor as if it were a render. Fail the run instead. */
const assertAlive = async () => {
  const bad = await page.evaluate(() =>
    /Graphics context lost/i.test(document.body.innerText) || !window.__neonx?.game?.loaded);
  if (bad) { console.log("CONTEXT LOST — run is not usable"); await browser.close(); await close(); process.exit(3); }
};

const shot = async (name) => {
  for (let i = 0; i < 6; i++) await page.evaluate(() => window.__neonx.step());
  await sleep(500);
  const f = path.join(OUT, `${TAG}-${name}.png`);
  await page.screenshot({ path: f, type: "png" });
  console.log("saved", path.basename(f));
};

await assertAlive();
await shot("chase");
await assertAlive();
/* No second, closer lens. Under a software renderer each frozen-clock step()
   is a full 1440x900 software frame, and settling the rig into a new distance
   costs more wall clock than the whole rest of the run — for a view the game
   does not actually ship. The detail this exists to judge is read instead by
   CROPPING this frame and scaling it up, which has the added virtue of being
   the real shipped pixels rather than a different camera. */

console.log(errors.length ? `ERRORS (${errors.length}): ${errors.slice(0, 5).join(" | ")}` : "no console/page errors");
await browser.close();
await close();
