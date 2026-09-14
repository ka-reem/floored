/* Fleet far-tier (LOD) census + proof-it-is-invisible photographer.

   One page load does all of it, from ONE frozen frame, so nothing has to be
   lined up by eye:

   - the exact triangle census (every style's drawn instance count times the
     triangle count of the geometry that tier actually renders, near + far),
     plus the whole frame's triangles accumulated across every pass
     (renderer.info is reset per render() call and this game renders ~15
     times a frame — see census note in test/mobile-ab.mjs);
   - one capture per camera (chase / cockpit / dashcam);
   - with --ab, the SAME frozen frame shot twice per camera through
     `window.__npcLod.far` — pinned all-near (what shipped before the far
     tier existed) and at the shipping swap distance. Same sim state by
     construction, so any difference in those pixels IS the far tier;
   - with --ab, a crossing: the car closest to the swap distance, shot with
     the threshold either side of it, cropped to that car.

   Usage:
     node test/fleet-lod-shots.mjs --url http://localhost:3701 --out DIR \
       [--tag before] [--ab]
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3701");
const OUT = arg("--out", process.cwd());
const TAG = arg("--tag", "run");
const AB = process.argv.includes("--ab");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The same spot every run: a fixed station on the deck, in lane, at a fixed
   cruise. Traffic's own rng is seeded (mulberry32(0xbeef)), so with the pose
   pinned and the clock frame-stepped the fleet lands in very nearly the same
   places run to run — "very nearly" is exactly what the noise floor in the
   report measures. */
const SPOT = -1300, KMH = 92, LANE = 1;
const FPS = 30, SETTLE_STEPS = 90;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: [
    "--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 3600000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

await page.goto(debugUrl(URL, { tier: "mobile-base" }), { waitUntil: "domcontentloaded", timeout: 900000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
await page.evaluate(() =>
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE")).click()
);
console.log("world build (minutes under swiftshader)...");
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 3000000, polling: 5000 });
await page.waitForFunction(() => window.__neonx.state().npcs > 40, { timeout: 600000, polling: 3000 }).catch(() => {});
await sleep(12000);

/* Park, let the fleet settle around the parked spot, then freeze the clock. */
await page.evaluate(({ z, kmh, lane }) => {
  const nx = window.__neonx;
  nx.toCorridor(z, kmh, lane);
  nx.setInput({ th: 0.34 });
}, { z: SPOT, kmh: KMH, lane: LANE });
await sleep(12000);
await page.evaluate((dt) => window.__neonx.setFixedDt(dt), 1 / FPS);
for (let i = 0; i < SETTLE_STEPS; i++) await page.evaluate(() => window.__neonx.step());

const setLod = (m) => page.evaluate((m) => { window.__npcLod = m === null ? undefined : { far: m }; }, m);
const step = () => page.evaluate(() => window.__neonx.step());
const shot = async (name) => {
  await step();
  const p = path.join(OUT, name);
  await page.screenshot({ path: p });
  console.log("saved", name);
  return p;
};
const setCam = (i) => page.evaluate((i) => window.__neonx.setCam(i), i);

const CAMS = [[0, "chase"], [1, "cockpit"], [3, "pov"]];

/* ---- census: triangles, exactly ---------------------------------------- */
const census = await page.evaluate(async () => {
  const g = window.__neonx.game, r = g.renderer, t = g.traffic;
  const triOf = (geo) => {
    if (!geo) return 0;
    const idx = geo.getIndex();
    return idx ? idx.count / 3 : (geo.getAttribute("position")?.count ?? 0) / 3;
  };
  const rows = t.styles.map((s, i) => {
    const nearEach = Math.round(triOf(s.mesh.geometry));
    const farEach = s.far ? Math.round(triOf(s.far.mesh.geometry)) : 0;
    return {
      style: i, drawnNear: s.n, drawnFar: s.far ? s.far.n : 0,
      nearEach, farEach,
      tris: Math.round(s.n * nearEach + (s.far ? s.far.n * farEach : 0)),
    };
  }).filter((x) => x.drawnNear + x.drawnFar > 0).sort((a, b) => b.tris - a.tris);
  const bodyTris = rows.reduce((a, x) => a + x.tris, 0);
  const wheelTris = Math.round(t.wheelCount * triOf(t.wheelInst.geometry));
  const poolTris = Math.round((t.poolInst.count || 0) * triOf(t.poolInst.geometry));
  const drawn = rows.reduce((a, x) => a + x.drawnNear + x.drawnFar, 0);

  /* whole-frame triangles: accumulate across every render() call of a frame */
  const orig = r.render.bind(r);
  let acc = null;
  r.render = (s, c) => { orig(s, c); if (acc) { acc.calls += r.info.render.calls; acc.tris += r.info.render.triangles; } };
  const frames = (n) => new Promise((res) => {
    acc = { calls: 0, tris: 0 };
    let i = 0;
    const tick = () => {
      window.__neonx.step();
      if (++i >= n) { const a = acc; acc = null; res({ calls: a.calls / n, tris: a.tris / n }); }
      else setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  });
  const full = await frames(4);
  r.render = orig;
  return {
    npcs: window.__neonx.state().npcs,
    perStyle: rows, drawn,
    bodyTris, wheelTris, poolTris,
    trafficTotal: bodyTris + wheelTris + poolTris,
    frameTris: Math.round(full.tris), frameCalls: Math.round(full.calls),
    meanTriPerCar: Math.round(bodyTris / Math.max(1, drawn)),
  };
});
console.log(JSON.stringify(census, null, 1));
writeFileSync(path.join(OUT, `census-${TAG}.json`), JSON.stringify(census, null, 1));

/* ---- the three cameras -------------------------------------------------- */
for (const [ci, name] of CAMS) {
  await setCam(ci);
  await step();
  await shot(`${TAG}-${name}.png`);
}

/* ---- same frame, both tiers -------------------------------------------- */
if (AB) {
  for (const [ci, name] of CAMS) {
    await setCam(ci);
    await step();
    await setLod(1e9);          // every car on its near body: the old build
    await shot(`${TAG}-${name}-nearonly.png`);
    await setLod(null);         // shipping swap distance
    await shot(`${TAG}-${name}-lod.png`);
  }

  /* ---- a car crossing the swap distance ------------------------------- */
  await setCam(0);
  await step();
  const target = await page.evaluate(() => {
    const g = window.__neonx.game, t = g.traffic, cam = g.camera, c = g.car;
    const fx = Math.sin(c.h), fz = Math.cos(c.h);
    let best = null;
    for (const n of t.npcs) {
      if (!n.active) continue;
      const dx = n.x - c.x, dz = n.z - c.z;
      const d = Math.hypot(dx, dz);
      const along = dx * fx + dz * fz;
      if (along < 40) continue;
      if (!best || Math.abs(d - 120) < Math.abs(best.d - 120)) best = { d, x: n.x, y: n.y, z: n.z, style: n.style };
    }
    if (!best) return null;
    // project to screen with the live camera (view then projection, by hand —
    // nothing here may allocate a three class the page has not exported)
    const obj = { x: best.x, y: best.y + 0.7, z: best.z };
    const e = cam.matrixWorldInverse.elements;
    const tx = e[0] * obj.x + e[4] * obj.y + e[8] * obj.z + e[12];
    const ty = e[1] * obj.x + e[5] * obj.y + e[9] * obj.z + e[13];
    const tz = e[2] * obj.x + e[6] * obj.y + e[10] * obj.z + e[14];
    const q = cam.projectionMatrix.elements;
    const cx = q[0] * tx + q[4] * ty + q[8] * tz + q[12];
    const cy = q[1] * tx + q[5] * ty + q[9] * tz + q[13];
    const cw = q[3] * tx + q[7] * ty + q[11] * tz + q[15];
    return {
      d: best.d, style: best.style,
      sx: (cx / cw * 0.5 + 0.5) * innerWidth,
      sy: (-cy / cw * 0.5 + 0.5) * innerHeight,
      onScreen: cw > 0,
      dpr: devicePixelRatio, w: innerWidth, h: innerHeight,
    };
  });
  console.log("crossing target", JSON.stringify(target));
  writeFileSync(path.join(OUT, `crossing-${TAG}.json`), JSON.stringify(target, null, 1));
  if (target) {
    const d = target.d;
    for (const [i, th] of [d + 10, d + 2, d - 2, d - 10].entries()) {
      await setLod(th);
      await shot(`${TAG}-cross${i}-th${th.toFixed(0)}.png`);
    }
    await setLod(null);
  }
}

await page.evaluate(() => window.__neonx.setFixedDt(0)).catch(() => {});
writeFileSync(path.join(OUT, `errors-${TAG}.json`), JSON.stringify(errors, null, 1));
console.log("page errors:", errors.length);
await browser.close();
