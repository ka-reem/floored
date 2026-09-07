/* One boot, every lever, both ways — the option sheet's raw frames.

   Each mobile cap this lane adds is a quality/cost trade, and the owner
   picks the trades. Judging them from separate builds would mean a boot per
   lever per state, and a boot on this box is ten minutes; worse, two boots
   are two different runs, so any difference between them includes the
   renderer's own noise.

   So: boot ONCE on the patched build, park at a fixed pose, freeze
   everything that moves (the same freeze test/look-shots.mjs uses — fleet
   hidden, sim paused, performance.now and Date pinned so the film grain, the
   blinks and the DVR stamp are constants), and then flip each lever at
   runtime and shoot the frozen frame again. Every pair differs by exactly
   one thing, and the CONTROL pair — the same state shot twice with nothing
   touched between — is the noise floor the pairs have to beat to count as a
   visible difference at all.

   Levers, and how each is reached without a rebuild:
     msaa       post.setMsaa() + makeTargets(); the scene target is
                reallocated, so the reflection texture is re-bound after.
     povfxaa    post.setPovFxaa()
     bloom      post.setBloomIters()
     shadow     sun.castShadow — a program-cache flip, so it is given extra
                frames to recompile before the shot.
     aniso      walked over every material in the scene and set on every map
                it holds. This is the one lever whose COST cannot be judged
                here at all: SwiftShader's sampler does not price anisotropy
                the way a phone's does. The pictures are still the pictures.

   mirrorEvery has no entry: it changes only how OFTEN the mirror is
   redrawn, and in a frozen frame the mirror holds the same image at any
   cadence. It is a temporal trade and a still cannot show it.

   Usage:
     node test/mobile-levers.mjs --url http://localhost:3701 \
       --tier mobile-base --shots /tmp/x/levers
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3701");
const TIER = arg("--tier", "mobile-base");
const SHOTS = arg("--shots", "/tmp/lane-mobile-art/levers");
const CAM = Number(arg("--cam", 3));      // 3 = dashcam POV, the default view
const Z = Number(arg("--z", 2400));       // town: lamps, glow, signs — where the levers show
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const waitFramesIn = (pg, n) => pg.evaluate((n) => new Promise((res) => {
  let i = 0;
  const tick = () => (++i >= n ? res(i) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  protocolTimeout: 890000,
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
await page.evaluate(() => {
  const g = window.__neonx.game;
  g.perfCheck = () => {};                       // see test/mobile-ab.mjs
  if (g.perfMode) { g.perfMode = false; g.lastPR = -1; g.applySettings(g.settings); }
});
await sleep(10000);
await page.evaluate(() => {
  const g = window.__neonx.game;
  window.__neonx.setTime(22.0);
  // and STOP the clock: at timeSpeed 150 a second of real time is two and a
  // half minutes of game night, and on this box a frame is seconds. See the
  // same note in test/mobile-ab.mjs.
  g.timeSpeed = 0;
});
await sleep(2000);

await page.evaluate((a) => {
  window.__neonx.setCam(a.cam);
  window.__neonx.toCorridor(a.z, 0, 1);
  window.__neonx.setInput({ th: 0 });
}, { cam: CAM, z: Z });
await sleep(6000);
await page.evaluate((a) => {
  window.__neonx.toCorridor(a.z, 0, 1);
  window.__neonx.setInput({ th: 0 });
}, { z: Z });
await sleep(3000);
await waitFramesIn(page, 4);

/* Freeze once and stay frozen for the whole sheet — every shot below is the
   same pose, the same clock and the same grain seed. */
await page.evaluate(() => {
  const g = window.__neonx.game, t = g.traffic, p = g.post;
  for (const s of t.styles) s.mesh.visible = false;
  t.wheelInst.visible = false; t.poolInst.visible = false;
  for (const c of t.cloudList) c.pts.visible = false;
  g.car.u = 0; g.car.v = 0; g.car.r = 0;
  g.running = false;
  g.timeSpeed = 0; g.time = 22.0;
  const keep = new Set();
  for (let e = document.querySelector("canvas.game"); e; e = e.parentElement) keep.add(e);
  for (const e of document.body.querySelectorAll("*")) if (!keep.has(e)) e.style.visibility = "hidden";
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
await sleep(3000);

/* Lever setters, run in-page. Each takes the value the DESKTOP tier ships
   (the expensive side) or the mobile one (the cheap side). */
const setLever = (name, rich) => page.evaluate((a) => {
  const g = window.__neonx.game, post = g.post;
  const rebuildTargets = () => {
    post.makeTargets(false);
    g.mats?.setReflectionTexture(post.reflectRT.texture);
    g.mats?.setReflectionScreen(
      innerWidth * g.renderer.getPixelRatio(), innerHeight * g.renderer.getPixelRatio());
  };
  switch (a.name) {
    case "msaa": post.setMsaa(a.rich ? 4 : 0); rebuildTargets(); break;
    case "povfxaa": post.setPovFxaa(a.rich); break;
    case "bloom": post.setBloomIters(a.rich ? 3 : 2); break;
    case "shadow": g.sun.castShadow = a.rich; g.sun.shadow.needsUpdate = true; break;
    case "aniso": {
      const n = a.rich ? 16 : 4;
      const seen = new Set();
      g.scene.traverse((o) => {
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          if (seen.has(m)) continue;
          seen.add(m);
          for (const k of Object.keys(m)) {
            const v = m[k];
            if (v && v.isTexture && v.anisotropy !== undefined && v.anisotropy !== n) {
              v.anisotropy = n; v.needsUpdate = true;
            }
          }
        }
      });
      break;
    }
  }
}, { name, rich });

/* Wait for N frames to be DRAWN, not for N seconds — the same reason
   test/mobile-ab.mjs does it. Flipping `shadow` changes the directional
   shadow COUNT in three's program cache key, so the next render recompiles
   every lit material in the scene; on a box with no GPU and no
   KHR_parallel_shader_compile that single frame can take minutes, and a
   fixed sleep would shoot straight through it and capture the frame before. */
const waitFrames = (n) => page.evaluate((n) => new Promise((res) => {
  let i = 0;
  const tick = () => (++i >= n ? res(i) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

const shoot = async (file) => {
  await waitFrames(5);                  // the POV frame blend re-settles
  await page.screenshot({ path: path.join(SHOTS, `${file}.png`),
    captureBeyondViewport: false, optimizeForSpeed: true });
  console.log("shot", file);
};

/* Everything rich first: that is the frame as the game ships on desktop, and
   the reference every cheap frame is judged against. */
for (const l of ["msaa", "povfxaa", "bloom", "shadow", "aniso"]) await setLever(l, true);
await shoot("rich");
await shoot("rich-control");            // the noise floor: same state, shot twice

for (const l of ["msaa", "povfxaa", "bloom", "shadow", "aniso"]) {
  await setLever(l, false);
  await shoot(`cheap-${l}`);
  await setLever(l, true);              // one lever at a time
  await waitFrames(3);
}
/* ...and all of them together, which is what a phone would actually run. */
for (const l of ["msaa", "povfxaa", "bloom", "shadow", "aniso"]) await setLever(l, false);
await shoot("cheap-all");

await browser.close();
console.log("wrote", SHOTS);
