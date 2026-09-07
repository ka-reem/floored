/* The same measurement as perf-probe.mjs, taken on a PHONE.

   perf-probe.mjs opens a 1280x800 desktop viewport at devicePixelRatio 1.
   That is the wrong build to optimise a phone against: settings.ts branches
   the whole quality ladder on `detectRenderTier`, which needs touch + a real
   devicePixelRatio to land anywhere but "desktop", and the single largest
   number in the mobile budget — how many pixels the renderer actually fills —
   is `min(devicePixelRatio, tierCaps.dprCap)`, which is pinned to 1 on a
   desktop viewport no matter what tier is forced.

   So this script emulates the device instead: a 3x phone screen, touch, a
   phone UA, and the `?tier=` override to pick which of the two mobile rungs
   is under test. The tier still has to be forced rather than sniffed because
   SwiftShader reports itself as SwiftShader, which detectRenderTier correctly
   files under "unknown GPU".

   It reports three families of number:

   - frame time (med/p95/max), sampled from rAF deltas in-page. THE SAME
     SwiftShader CAVEAT AS perf-probe APPLIES AND IS WORSE HERE: this box has
     no GPU, and the mobile path's whole point is to move work off the GPU.
     A software rasteriser prices fill rate roughly linearly in pixels, which
     is directionally right for a phone but is not a phone. Ratios only.
   - the renderer's own counters: draw calls and triangles of the biggest
     pass (the scene), programs, geometries, textures.
   - what this script exists for: `renderer.render()` CALLS PER FRAME and the
     PIXELS each one covers. That is the fill-rate budget, it is counted
     exactly rather than timed, and it is the one number here that is
     hardware-independent — a pass that stops running stops running on a
     phone too.

   Usage:
     node test/perf-mobile.mjs --url http://localhost:3701 --tier mobile-base \
       --out out.json [--shots dir] [--label before] [--cam 0]
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3701");
const TIER = arg("--tier", "mobile-base");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts", "perf-mobile.json"));
const FRAMES = Number(arg("--frames", 120));
const ONLY = arg("--only", "");
const SHOTS = arg("--shots", "");
const LABEL = arg("--label", "run");
const CAM = arg("--cam", "");

/* A 3x phone: iPhone-class logical viewport, deviceScaleFactor 3, touch. The
   viewport is what the renderer sizes its targets from, so it has to be a
   phone's, not a desktop window scaled down. */
const PHONE = {
  width: 390, height: 844, deviceScaleFactor: 3, isMobile: true,
  hasTouch: true, isLandscape: false,
};
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const PLACES = [
  ["open", 400, "open elevated deck"],
  ["tunnel", 1090, "mid-tunnel"],
  ["toll", 1420, "under the toll canopy"],
  ["town", 2400, "town lamp field"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 590000,
});
const page = await browser.newPage();
await page.setViewport(PHONE);
await page.setUserAgent(UA);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);
await page.evaluate(() => window.__neonx.setTime(22.0));
if (CAM !== "") await page.evaluate((c) => window.__neonx.setCam(+c), CAM);
await sleep(2000);

/* Instrument render(): count every call, and the pixel area of the target
   each one covers. `null` target = the canvas itself. This is the fill-rate
   budget, exactly, with no timer in it. */
await page.evaluate(() => {
  const g = window.__neonx.game, r = g.renderer;
  if (r.__mobWrapped) return;
  const orig = r.render.bind(r);
  r.render = (...a) => {
    const rt = r.getRenderTarget();
    const w = rt ? rt.width : Math.floor(r.domElement.width);
    const h = rt ? rt.height : Math.floor(r.domElement.height);
    const st = g.__mobStat;
    if (st) {
      st.calls++;
      st.px += w * h;
      const k = `${w}x${h}`;
      st.byTarget[k] = (st.byTarget[k] || 0) + 1;
    }
    orig(...a);
    const i = r.info.render, p = g.__mobPeak;
    if (!p || i.calls > p.calls) g.__mobPeak = { calls: i.calls, triangles: i.triangles };
  };
  r.__mobWrapped = true;
});

const env = await page.evaluate(() => {
  const g = window.__neonx.game, r = g.renderer;
  return {
    dpr: devicePixelRatio,
    pixelRatio: r.getPixelRatio(),
    canvas: { w: r.domElement.width, h: r.domElement.height },
    css: { w: innerWidth, h: innerHeight },
    tier: g.tierCaps?.tier ?? null,
    dprCap: g.tierCaps?.dprCap ?? null,
    camMode: g.camMode,
    shadowsOn: !!g.settings?.shadows,
    sunCastShadow: !!g.sun?.castShadow,
    shadowMap: g.sun?.shadow?.mapSize ? [g.sun.shadow.mapSize.x, g.sun.shadow.mapSize.y] : null,
    mirrorRT: [g.post?.mirrorRT?.width, g.post?.mirrorRT?.height],
    sceneSamples: g.post?.sceneRT?.samples ?? null,
    sceneRT: [g.post?.sceneRT?.width, g.post?.sceneRT?.height],
  };
});
console.log("env", JSON.stringify(env));

const only = ONLY ? ONLY.split(",") : null;
const rows = [];
for (const [name, z, note] of PLACES) {
  if (only && !only.includes(name)) continue;
  await page.evaluate((z) => {
    const nx = window.__neonx, g = nx.game;
    g.__mobPeak = null;
    nx.toCorridor(z, 90, 1);
    nx.setInput({ th: 0.35 });
  }, z);
  await sleep(2500);

  await page.evaluate(() => {
    window.__neonx.game.__mobStat = { calls: 0, px: 0, byTarget: {}, frames: 0 };
  });

  const CHUNK = 15;
  const dtAll = [];
  for (let got = 0; got < FRAMES; got += CHUNK) {
    const part = await page.evaluate(async (n) => {
      const dt = [];
      await new Promise((resolve) => {
        let last = -1, i = 0;
        const tick = (t) => {
          if (last >= 0) { dt.push(t - last); window.__neonx.game.__mobStat.frames++; }
          last = t;
          if (++i > n) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return dt;
    }, Math.min(CHUNK, FRAMES - got));
    dtAll.push(...part);
  }

  const r = await page.evaluate((dt) => {
    const g = window.__neonx.game;
    const info = g.__mobPeak ?? null;
    const st = g.__mobStat;
    dt = dt.slice().sort((a, b) => a - b);
    const at = (q) => dt[Math.min(dt.length - 1, Math.floor(dt.length * q))];
    return {
      med: +at(0.5).toFixed(2),
      p95: +at(0.95).toFixed(2),
      max: +dt[dt.length - 1].toFixed(2),
      calls: info?.calls ?? null,
      tris: info?.triangles ?? null,
      programs: g.renderer?.info?.programs?.length ?? null,
      geometries: g.renderer?.info?.memory?.geometries ?? null,
      textures: g.renderer?.info?.memory?.textures ?? null,
      /* per FRAME, not per sample window: passes and the pixels they cover */
      passesPerFrame: st.frames ? +(st.calls / st.frames).toFixed(2) : null,
      mpxPerFrame: st.frames ? +(st.px / st.frames / 1e6).toFixed(3) : null,
      targets: st.byTarget,
      frames: dt.length,
    };
  }, dtAll);

  r.place = name; r.z = z; r.note = note;
  rows.push(r);
  console.log(
    name.padEnd(9),
    `med ${String(r.med).padStart(7)}`,
    `p95 ${String(r.p95).padStart(7)}`,
    `calls ${String(r.calls).padStart(4)}`,
    `tris ${String(r.tris).padStart(7)}`,
    `passes ${String(r.passesPerFrame).padStart(5)}`,
    `Mpx/f ${String(r.mpxPerFrame).padStart(7)}`,
  );
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${LABEL}-${name}.png`) });
}

writeFileSync(OUT, JSON.stringify({ label: LABEL, url: URL, tier: TIER, cam: CAM, env, frames: FRAMES, rows }, null, 2));
console.log("\nwrote", OUT);
await browser.close();
if (errors.length) {
  console.log("PAGE ERRORS:");
  for (const e of errors.slice(0, 5)) console.log(" -", e.slice(0, 200));
}
