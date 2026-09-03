/* Lane M occluder paint-probe v2: paint each candidate mesh flat magenta one
   at a time and score how magenta the probed region turns — hiding is useless
   when the background is black too. Candidates are prefiltered to meshes whose
   world AABB crosses a camera ray through any of the probe pixels.
     node test/pov-paint.mjs --url URL --out DIR --px "900,520;960,540"
   Prints one line per candidate as it goes; summary at the end. Saves a full
   crop for every candidate that scores > 3.
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";
import sharp from "sharp";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3142");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts"));
const PX = arg("--px", "900,520;960,540;1000,560").split(";").map((s) => s.split(",").map(Number));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* The world is built by the staged loader after this click, not by the
   constructor, so __neonx existing no longer means there is a world to
   drive in — wait for the load to finish before touching it. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(2500);
await page.evaluate(() => {
  const nx = window.__neonx;
  nx.toCorridor(-1300, 100, 1);
  nx.setInput({ th: 0.5 });
  nx.setCam(3);
});
await sleep(2200);

const table = await page.evaluate((pixels) => {
  const game = window.__neonx.game;
  const cam = game.camera;
  cam.updateMatrixWorld(true);
  const V3 = cam.position.constructor;
  const rays = pixels.map(([px, py]) => {
    const p = new V3((px / 1280) * 2 - 1, -((py / 800) * 2 - 1), 0.5);
    p.applyMatrix4(cam.projectionMatrixInverse);
    p.applyMatrix4(cam.matrixWorld);
    return p.sub(cam.position).normalize();
  });
  const o0 = cam.position;
  window.__hunt = [];
  const rows = [];
  game.scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    for (let q = o.parent; q; q = q.parent) if (!q.visible) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
    let hit = false;
    for (const d of rays) {
      let t0 = 0, t1 = 2; // only the first 2 m matters for cabin occluders
      for (const ax of ["x", "y", "z"]) {
        const inv = 1 / d[ax];
        let ta = (bb.min[ax] - o0[ax]) * inv;
        let tb = (bb.max[ax] - o0[ax]) * inv;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
      if (t0 <= t1) { hit = true; break; }
    }
    if (!hit) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const chain = [];
    for (let q = o.parent; q && q !== game.scene; q = q.parent) chain.push(q.name || q.type);
    window.__hunt.push(o);
    rows.push(
      `${o.name || "?"} mat=${m.name || m.type}#${m.color ? m.color.getHexString() : "-"}` +
      ` size=${(bb.max.x - bb.min.x).toFixed(2)}x${(bb.max.y - bb.min.y).toFixed(2)}x${(bb.max.z - bb.min.z).toFixed(2)}` +
      ` chain=${chain.join("<")}`
    );
  });
  // paint material: clone any basic material, strip maps, magenta
  window.__paint = null;
  game.scene.traverse((o) => {
    if (window.__paint || !o.isMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m.type === "MeshBasicMaterial") {
      const p = m.clone();
      p.map = null;
      p.transparent = false;
      p.opacity = 1;
      p.toneMapped = false;
      p.fog = false;
      p.color.setRGB(1, 0, 1);
      window.__paint = p;
    }
  });
  return rows;
}, PX);
console.log(`${table.length} candidates`);

// crop window around the probed pixels, padded
const xs = PX.map((p) => p[0]), ys = PX.map((p) => p[1]);
const clip = {
  x: Math.max(0, Math.min(...xs) - 120), y: Math.max(0, Math.min(...ys) - 120),
  width: Math.min(...[Math.max(...xs) - Math.min(...xs) + 240]),
  height: Math.max(...ys) - Math.min(...ys) + 240,
};
clip.width = Math.min(clip.width, 1280 - clip.x);
clip.height = Math.min(clip.height, 800 - clip.y);

const scores = [];
for (let i = 0; i < table.length; i++) {
  await page.evaluate((j) => {
    const o = window.__hunt[j];
    o.userData.__savedMat = o.material;
    o.material = window.__paint;
  }, i);
  await sleep(80);
  const buf = await page.screenshot({ clip });
  await page.evaluate((j) => {
    const o = window.__hunt[j];
    o.material = o.userData.__savedMat;
  }, i);
  const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let s = 0, n = 0;
  for (let k = 0; k + 2 < data.length; k += 3) {
    s += Math.max(0, Math.min(data[k], data[k + 2]) - data[k + 1]);
    n++;
  }
  const sc = s / n;
  scores.push([i, sc]);
  console.log(`idx ${i} score ${sc.toFixed(2)} :: ${table[i]}`);
  if (sc > 3) writeFileSync(path.join(OUT, `paint-${String(i).padStart(2, "0")}.png`), buf);
}
scores.sort((a, b) => b[1] - a[1]);
console.log("--- top scorers");
for (const [i, s] of scores.slice(0, 8)) console.log(s.toFixed(2), "idx", i, "=>", table[i]);
await browser.close();
