/* Within-one-session A/B for the static-matrix freeze.

   Counts the nodes three actually walks in one scene.updateMatrixWorld(),
   and times it, with the freeze ON (as shipped) and then with the flags put
   back the way they were. Both measurements come from the same page, the
   same frame budget and the same contention, so the difference is the
   change and nothing else. */
import { writeFileSync } from "node:fs";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3202");
const OUT = arg("--out", "/tmp/lane-opt/perf/matrix-ab.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 900000 });
await sleep(10000);
await page.evaluate(() => window.__neonx.setTime(22.0));
await sleep(2000);
await page.evaluate(() => { window.__neonx.toCorridor(2400, 90, 1); window.__neonx.setInput({ th: 0.35 }); });
await sleep(4000);

const out = await page.evaluate(async () => {
  const g = window.__neonx.game;
  const scene = g.scene;
  const proto = Object.getPrototypeOf(scene);           // Scene -> Object3D chain
  const O3D = Object.getPrototypeOf(Object.getPrototypeOf(scene)) ?? proto;
  // Object3D.prototype.updateMatrixWorld is what every node uses
  let O = scene;
  while (O && !Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(O), "updateMatrixWorld"))
    O = Object.getPrototypeOf(O);
  const P = Object.getPrototypeOf(O);
  const orig = P.updateMatrixWorld;

  const measure = () => {
    // three walks every child either way; what the freeze removes is the
    // per-node Matrix4.compose + multiplyMatrices, so count those, not visits
    let walked = 0, composed = 0, multiplied = 0;
    P.updateMatrixWorld = function (f) {
      walked++;
      if (this.matrixAutoUpdate) composed++;
      if (this.matrixWorldNeedsUpdate || f) multiplied++;
      return orig.call(this, f);
    };
    scene.updateMatrixWorld();
    P.updateMatrixWorld = orig;
    const t = [];
    for (let i = 0; i < 300; i++) {
      const a = performance.now();
      scene.updateMatrixWorld();
      t.push(performance.now() - a);
    }
    t.sort((a, b) => a - b);
    return { walked: walked - 1, composed, multiplied,
      medMs: +t[150].toFixed(4), p90Ms: +t[270].toFixed(4) };
  };

  const frozen = measure();

  // put the flags back the way they were before the change, measure again
  scene.matrixAutoUpdate = true;
  for (const c of g.world.chunks) c.group.traverse((o) => { o.matrixAutoUpdate = true; });
  const thawed = measure();

  // restore the shipped state
  scene.matrixAutoUpdate = false;
  for (const c of g.world.chunks) c.group.traverse((o) => { o.matrixAutoUpdate = false; });
  scene.updateMatrixWorld();
  let total = 0;
  scene.traverse(() => total++);
  return { sceneNodes: total, chunks: g.world.chunks.length, before: thawed, after: frozen };
});
console.log(JSON.stringify(out, null, 2));
writeFileSync(OUT, JSON.stringify(out, null, 2));
await browser.close();
