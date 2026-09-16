/* Is the harder LOD visible? Photographs, at the distances where it lands.

   The first far tier made no visible difference at all, which is the reason
   to go further. This shoots whether the further version is still invisible, which is the only question that matters
   — the triangle saving is already known.

   Method: park, freeze the clock, then for each distance find the car nearest
   that range on the road ahead, and shoot the SAME frozen frame twice —
   once with the whole fleet pinned to its near bodies and full wheels (what
   shipped before), once at the new cutoffs. Nothing in the world moves
   between the pair, so every pixel that differs IS the LOD. Each pair is also
   cropped tight to the car and scaled up, because a car at 120 m is 20 px in
   a 1280-wide frame and nobody can judge that at full size.

   A third shot repeats the first: the capture's own noise floor. A difference
   smaller than that floor is not a difference.

   Usage: node test/lod-aggressive-shots.mjs --url http://localhost:3702 --out DIR
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import sharp from "sharp";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3702");
const OUT = arg("--out", process.cwd());
const TIER = arg("--tier", "mobile-base");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPOT = -1300, KMH = 92, LANE = 1, FPS = 30;
const RANGES = [70, 90, 120, 180];
/* what shipped before this change, for the "before" half of each pair */
const OLD = { far: 120, wheel: 150 };

const browser = await puppeteer.launch({
  headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
         "--disable-dev-shm-usage", "--mute-audio"],
  protocolTimeout: 3600000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 900000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
await page.evaluate(() =>
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE")).click());
console.log("world build...");
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 3000000, polling: 5000 });
await sleep(8000);
await page.evaluate(({ z, kmh, lane }) => {
  window.__neonx.toCorridor(z, kmh, lane);
  window.__neonx.setInput({ th: 0.34 });
}, { z: SPOT, kmh: KMH, lane: LANE });
await sleep(10000);

const step = () => page.evaluate(() => window.__neonx.step());
const setDt = (dt) => page.evaluate((dt) => window.__neonx.setFixedDt(dt), dt);
await setDt(1 / FPS);
for (let i = 0; i < 60; i++) await step();
// chase: the exterior view where a far body is actually on screen with the
// player's own car for scale
await page.evaluate(() => window.__neonx.setCam(0));
await step();
await setDt(1e-6); // the world stops; only the cutoffs move between a pair

/* triangle census at each setting, so the picture carries a number */
const census = () => page.evaluate(() => {
  const t = window.__neonx.game.traffic;
  const tri = (g) => { const i = g?.getIndex(); return i ? i.count / 3 : (g?.getAttribute("position")?.count ?? 0) / 3; };
  let body = 0, drawnNear = 0, drawnFar = 0;
  for (const s of t.styles) {
    body += s.n * tri(s.mesh.geometry) + (s.far ? s.far.n * tri(s.far.mesh.geometry) : 0);
    drawnNear += s.n; drawnFar += s.far ? s.far.n : 0;
  }
  const wheels = t.wheelCount * tri(t.wheelInst.geometry);
  return {
    near: drawnNear, far: drawnFar,
    bodyTris: Math.round(body), wheelTris: Math.round(wheels),
    total: Math.round(body + wheels),
  };
});

const setLod = (far, wheel) => page.evaluate(({ far, wheel }) => {
  window.__npcLod = { far, wheel };
}, { far, wheel });

/* the engine reads __npcLod.far already; wheel needs the same door */
const hasWheelKnob = await page.evaluate(() => {
  const src = String(window.__neonx.game.traffic.constructor);
  return /__npcLod\?\.wheel/.test(src);
});
console.log("wheel knob present:", hasWheelKnob);

const shot = async (f) => { await step(); await page.screenshot({ path: f }); };

/* where is the car nearest each range, on screen? */
const findCar = (range) => page.evaluate((range) => {
  const g = window.__neonx.game, t = g.traffic, cam = g.camera, c = g.car;
  const fx = Math.sin(c.h), fz = Math.cos(c.h);
  let best = null;
  for (const n of t.npcs) {
    if (!n.active) continue;
    const dx = n.x - c.x, dz = n.z - c.z;
    const d = Math.hypot(dx, dz);
    if ((dx * fx + dz * fz) / (d || 1) < 0.3) continue; // ahead only
    if (!best || Math.abs(d - range) < Math.abs(best.d - range)) best = { d, x: n.x, y: n.y, z: n.z };
  }
  if (!best) return null;
  const v = { x: best.x, y: best.y + 0.7, z: best.z };
  const e = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
  const vx = e[0]*v.x + e[4]*v.y + e[8]*v.z + e[12];
  const vy = e[1]*v.x + e[5]*v.y + e[9]*v.z + e[13];
  const vz = e[2]*v.x + e[6]*v.y + e[10]*v.z + e[14];
  const cw = -vz;
  if (cw <= 0.01) return null;
  const nx = (p[0]*vx + p[8]*vz) / cw, ny = (p[5]*vy + p[9]*vz) / cw;
  return {
    d: +best.d.toFixed(1),
    sx: Math.round((nx * 0.5 + 0.5) * window.innerWidth),
    sy: Math.round((-ny * 0.5 + 0.5) * window.innerHeight),
  };
}, range);

const rows = [];
for (const range of RANGES) {
  const at = await findCar(range);
  if (!at) { console.log("no car near", range); continue; }
  await setLod(OLD.far, OLD.wheel);
  await shot(path.join(OUT, `r${range}-before.png`));
  const cBefore = await census();
  await setLod(undefined, undefined); // shipping cutoffs
  await page.evaluate(() => { delete window.__npcLod; });
  await shot(path.join(OUT, `r${range}-after.png`));
  const cAfter = await census();
  await setLod(OLD.far, OLD.wheel);
  await shot(path.join(OUT, `r${range}-before2.png`)); // noise floor
  rows.push({ range, actualD: at.d, at, before: cBefore, after: cAfter });
  console.log(`range ${range}m -> car at ${at.d}m  before ${cBefore.total} tris  after ${cAfter.total} tris`);

  /* crop tight to the car and scale up 4x, side by side with labels */
  const S = 4, W = 150, H = 100;
  const left = Math.max(0, Math.min(1280 - W, at.sx - W / 2));
  const top = Math.max(0, Math.min(720 - H, at.sy - H / 2));
  const crop = async (f) => sharp(f).extract({ left, top, width: W, height: H })
    .resize(W * S, H * S, { kernel: "nearest" }).toBuffer();
  const [a, b] = [await crop(path.join(OUT, `r${range}-before.png`)),
                  await crop(path.join(OUT, `r${range}-after.png`))];
  const pad = 46;
  const svg = Buffer.from(
    `<svg width="${W*S*2+12}" height="${H*S+pad}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#070910"/>
      <text x="12" y="26" font-family="monospace" font-size="21" fill="#ffb454">BEFORE  swap 120m / wheels 150m  ·  ${cBefore.total.toLocaleString()} tris</text>
      <text x="${W*S+12+12}" y="26" font-family="monospace" font-size="21" fill="#7dd3fc">AFTER  swap 65m / wheels 75m  ·  ${cAfter.total.toLocaleString()} tris</text>
      <text x="12" y="${H*S+pad-10}" font-family="monospace" font-size="19" fill="#a8bde4">car at ${at.d} m  ·  ${S}x nearest-neighbour crop, no smoothing</text>
    </svg>`);
  await sharp(svg)
    .composite([{ input: a, left: 0, top: 34 }, { input: b, left: W * S + 12, top: 34 }])
    .png().toFile(path.join(OUT, `pair-${range}m.png`));
  console.log("wrote", `pair-${range}m.png`);
}
writeFileSync(path.join(OUT, "lod.json"), JSON.stringify({ rows, errors }, null, 1));
console.log("errors:", errors.length, errors.slice(0, 4));
await browser.close();
