/* Draw-call meter for the perf lanes: parks the car at fixed stations (the
   same ones before and after), lets the renderer run, and reads renderer.info
   accumulated across whole frames — autoReset off, reset at a frame boundary,
   sampled a few frames later and divided by the frames elapsed. The per-render
   info the screenshot tour logs only ever sees the composite pass (1 call),
   which is useless as a budget number.

   The perf-pass extensions, on top of the original ten deck stations:

   - `--tier desktop|mobile-high|mobile-base|all` sweeps the device tiers via
     the `?tier=` URL param (which both the engine and worldTierCaps() honour
     ahead of detection), with a phone-shaped viewport on the mobile tiers so
     the DPR caps and `body.touch` CSS get exercised too.
   - mountain-road and toll stations (`mtn:s`, prefixed rows) — the two new
     route surfaces the original table never saw.
   - `programs` per station: renderer.info.programs.length — the shader-
     compile budget. A program count that GROWS between stations means the
     drive is compiling shaders mid-lap, which is the "hard to load" hitch.
   - `--hitches` runs scripted drives through the route transitions (tunnel
     entry, toll, mountain entry/exit, district boundary) recording rAF frame
     deltas and the program count before/after: compile stutter shows as a
     multi-hundred-ms outlier paired with a program-count jump. SwiftShader
     inflates every absolute number; the outlier-vs-median SHAPE is the
     signal, and the program delta is exact on any backend.
   - `--json <path>` appends machine-readable rows for the report tables.

   Usage: node test/lap-calls.mjs --url http://localhost:3000 [--label before]
            [--tier all] [--hitches] [--json out.json]
*/
import puppeteer from "puppeteer";
import { appendFileSync } from "node:fs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3000");
const LABEL = arg("--label", "run");
const TIER = arg("--tier", "desktop");
const JSON_OUT = arg("--json", null);
const HITCHES = process.argv.includes("--hitches");

const STATIONS = [-1800, -1300, -900, -400, 160, 420, 700, 1100, 1450, 1850];
/* The routes the original table never saw: mountain road low/high (arclength)
   — measured with toMountain, so the row label carries the prefix. */
const MTN_STATIONS = [80, 420];

const TIERS =
  TIER === "all" ? ["desktop", "mobile-high", "mobile-base"] : [TIER];

/* Phone-shaped viewport for the mobile tiers: the tier itself is forced by
   ?tier=, but the viewport decides canvas size (fill, DPR cap) and body.touch
   (mobile CSS), so a mobile row measured in a desktop window would flatter
   nothing but itself. */
const VIEWPORT = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1 },
  "mobile-high": { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  "mobile-base": { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (row) => {
  if (JSON_OUT) appendFileSync(JSON_OUT, JSON.stringify(row) + "\n");
};

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 300000,
});

/* One whole-frame renderer.info sample: reset at a frame boundary, accumulate
   N frames, divide. Returns per-frame calls/tris plus the absolute program
   count (not per-frame — it only ever grows). */
const sample = (page) =>
  page.evaluate(async () => {
    const nx = window.__neonx;
    const info = nx.game.renderer.info;
    await new Promise((res) => requestAnimationFrame(res));
    info.reset();
    const f0 = nx.state().frames;
    const N = 3;
    await new Promise((res) => {
      const poll = () =>
        nx.state().frames >= f0 + N ? res() : setTimeout(poll, 120);
      poll();
    });
    const frames = nx.state().frames - f0;
    return {
      calls: Math.round(info.render.calls / frames),
      tris: Math.round(info.render.triangles / frames),
      programs: info.programs.length,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      frames,
    };
  });

/* Scripted drive through a route transition: full throttle from a teleport,
   recording every rAF delta and the program count on both sides.

   Frame-counted, not wall-clocked: under SwiftShader a driving frame takes
   on the order of a second, so a seconds-long tape would catch almost no
   frames at all. Physics advances at most 0.05 s of sim per rendered frame
   (engine loop, 6 substeps), so at 140 km/h each frame covers ~2 m and 60
   frames cross ~120 m of road — the start points sit ~60 m before each
   boundary so the tape straddles it. Absolute ms are SwiftShader numbers;
   the signal is the worst/median RATIO paired with the program delta. */
const driveThrough = async (page, name, place, kmh = 140) => {
  await page.evaluate(place);
  await sleep(1500); // culling + any deferred fetch settles before the tape rolls
  const r = await page.evaluate(async () => {
    const nx = window.__neonx;
    const p0 = nx.game.renderer.info.programs.length;
    nx.setInput({ th: 1, br: 0 });
    const N = 60;
    const deltas = [];
    let last;
    let done;
    const filled = new Promise((res) => (done = res));
    const tick = () => {
      const now = performance.now();
      if (last !== undefined) deltas.push(now - last);
      last = now;
      if (deltas.length >= N) done();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await Promise.race([filled, new Promise((res) => setTimeout(res, 150000))]);
    nx.setInput({ th: 0, br: 1 });
    const p1 = nx.game.renderer.info.programs.length;
    const sorted = [...deltas].sort((a, b) => a - b);
    const q = (f) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] : NaN;
    return {
      frames: deltas.length,
      p50: +q(0.5).toFixed(1),
      p95: +q(0.95).toFixed(1),
      worst: sorted.slice(-5).map((d) => Math.round(d)),
      programsBefore: p0,
      programsAfter: p1,
    };
  });
  const ratio = r.worst.length ? (r.worst[r.worst.length - 1] / r.p50).toFixed(1) : "?";
  console.log(
    `  hitch ${name}: ${r.frames}f p50=${r.p50}ms p95=${r.p95}ms worst=[${r.worst}] ` +
    `worst/p50=${ratio}x programs ${r.programsBefore}→${r.programsAfter}` +
    (r.programsAfter > r.programsBefore ? "  ← compiles mid-drive" : "")
  );
  emit({ label: LABEL, tier: page.__tier, kind: "hitch", name, kmh, ...r });
};

for (const tier of TIERS) {
  const page = await browser.newPage();
  page.__tier = tier;
  await page.setViewport(VIEWPORT[tier]);
  await page.goto(`${URL}/?tier=${tier}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b?.click();
  });
  await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
  /* long enough for the desktop tier's deferred work (PBR detail fetch, HD
     fleet stream) to land, so stations measure the steady state */
  await sleep(8000);

  const echoTier = await page.evaluate(() => window.__neonx.state().renderTier);
  console.log(`label=${LABEL} tier=${tier} (engine says ${echoTier})`);

  for (const z of STATIONS) {
    await page.evaluate((z) => {
      const nx = window.__neonx;
      nx.toCorridor(z, 0);
      nx.setInput({ th: 0, br: 1 });
      nx.game.renderer.info.autoReset = false;
    }, z);
    await sleep(2500); // let culling settle at the new position
    const r = await sample(page);
    console.log(
      `  z=${z} calls/frame=${r.calls} tris/frame=${r.tris} programs=${r.programs} (over ${r.frames} frames)`
    );
    emit({ label: LABEL, tier, kind: "station", z, ...r });
  }
  for (const s of MTN_STATIONS) {
    await page.evaluate((s) => {
      const nx = window.__neonx;
      nx.toMountain(s, 0);
      nx.setInput({ th: 0, br: 1 });
      nx.game.renderer.info.autoReset = false;
    }, s);
    await sleep(2500);
    const r = await sample(page);
    console.log(
      `  mtn:s=${s} calls/frame=${r.calls} tris/frame=${r.tris} programs=${r.programs} (over ${r.frames} frames)`
    );
    emit({ label: LABEL, tier, kind: "station", z: `mtn:${s}`, ...r });
  }

  if (HITCHES) {
    /* Each drive re-arms autoReset first — the station loop turned it off,
       and a stuck accumulator makes the per-frame numbers above nonsense if
       anything later reads them without resetting. */
    await page.evaluate(() => { window.__neonx.game.renderer.info.autoReset = true; });
    await driveThrough(page, "tunnel-entry", () => window.__neonx.toCorridor(860, 140));
    await driveThrough(page, "toll-splice", () => window.__neonx.toCorridor(1330, 140));
    await driveThrough(page, "district-east", () => window.__neonx.toCorridor(-620, 140));
    await driveThrough(page, "mountain-entry", () => window.__neonx.toMountain(10, 70), 70);
    await driveThrough(page, "mountain-exit", () => window.__neonx.toMountain(
      window.__neonx.game.world.routes.mtn.len - 100, 70), 70);
  }
  await page.close();
}
await browser.close();
console.log("done");
