/* Chase-camera launch trace. Boots the game headless, drives the car
   deterministically (no rAF, fixed sim dt, a simple lane-keeper on the
   corridor, traffic parked off) from standstill to top speed in CHASE, and
   logs per-frame camera pitch / heights / look-ahead. Then restarts the loop
   on a fake 60 fps clock for screenshots.
     node test/chase-trace.mjs --url http://localhost:3907 --out /abs/dir --tag before --mode trace
     node test/chase-trace.mjs ... --mode shots  (chase-rest, chase-100, pov-100, cockpit-100)
   Point --url at a `next start` (production) server on its own port so HMR
   cannot disturb the trace; the script adds ?debug=1 for the hook itself.
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3907");
const OUT = arg("--out", process.cwd());
const TAG = arg("--tag", "trace");
const MODE = arg("--mode", "trace");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 960, height: 600 },
  protocolTimeout: 900000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});
log("goto");
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
log("__neonx up");
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 900000 });
log("game loaded");
await sleep(1500);

/* Stop the rAF loop and park traffic: simStep does not move NPCs, so a live
   fleet is a wall to crash into. */
const freeze = () => page.evaluate(() => {
  const g = window.__neonx.game;
  cancelAnimationFrame(g.raf);
  for (const n of g.traffic.npcs) n.active = false;
});

/* ---- deterministic trace: step sim + camera by hand ---- */
const runTrace = (jitter) => page.evaluate((jitter) => {
  const nx = window.__neonx, g = nx.game, car = g.car;
  cancelAnimationFrame(g.raf);
  for (const n of g.traffic.npcs) n.active = false;
  nx.setCam(0);
  nx.toCorridor(-1300, 0, 0);
  car.u = 0;
  nx.setInput({ th: 0, st: 0 });
  g.lastCamMode = -1; // fresh entry: snap the chase rig onto the car
  const rows = [];
  let t = 0;
  const v = g.tmpV.clone();
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  // lane-keeper: pure pursuit on the lane centre, lookahead scaled with speed
  const steer = () => {
    const L = 20 + 0.8 * Math.abs(car.u);
    const p = g.cor.respawn(car.z + L, 0);
    const alpha = wrap(Math.atan2(p.x - car.x, p.z - car.z) - car.h);
    return Math.max(-1, Math.min(1, alpha * 3 - car.r * 0.1));
  };
  const rec = (phase) => {
    const d = g.camera.getWorldDirection(v);
    const sh = Math.sin(car.h), ch = Math.cos(car.h);
    const cp = g.camera.position, lp = g.lookPos;
    const p = g.cor.respawn(car.z, 0);
    rows.push({
      t: +t.toFixed(4), phase,
      kmh: +(Math.abs(car.u) * 3.6).toFixed(2),
      z: +car.z.toFixed(1), laneErr: +(car.x - p.x).toFixed(3),
      carY: +car.y.toFixed(4), camY: +cp.y.toFixed(4), lookY: +lp.y.toFixed(4),
      pitch: +((Math.asin(d.y) * 180) / Math.PI).toFixed(4),
      // signed along-heading offsets from the car's contact point, metres
      lookAhead: +(((lp.x - car.x) * sh + (lp.z - car.z) * ch)).toFixed(4),
      camBack: +(-((cp.x - car.x) * sh + (cp.z - car.z) * ch)).toFixed(4),
      fov: g.camera.fov, slope: +car.slope.toFixed(4), pitchDyn: +car.pitchDyn.toFixed(4),
    });
  };
  // frame pattern: uniform 60 fps, or alternating 1/40 + 1/120 (mean 1/60)
  const dts = jitter ? [1 / 40, 1 / 120] : [1 / 60];
  const run = (secs, phase, th) => {
    let acc = 0, i = 0;
    while (acc < secs) {
      const dt = dts[i++ % dts.length];
      nx.setInput({ th, st: steer() });
      nx.simStep(dt);
      g.updateCamera(dt);
      acc += dt; t += dt;
      rec(phase);
    }
  };
  run(2, "rest", 0);
  run(13, "launch", 1);
  run(5, "steady", 1); // ~180-205 km/h, before the bypass diverge
  return rows;
}, jitter);

const summarize = (rows, label) => {
  const rest = rows.filter((r) => r.phase === "rest");
  const steady = rows.filter((r) => r.phase === "steady");
  const launch = rows.filter((r) => r.phase === "launch");
  const restPitch = rest[rest.length - 1].pitch;
  const minPitch = Math.min(...rows.map((r) => r.pitch));
  const minRow = rows.find((r) => r.pitch === minPitch);
  const deltas = (arr, k) => arr.slice(1).map((r, i) => Math.abs(r[k] - arr[i][k]));
  const stat = (d) => ({
    max: +Math.max(...d).toFixed(4),
    rms: +Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length).toFixed(4),
  });
  const dSteady = deltas(steady, "pitch"), dLaunch = deltas(launch, "pitch");
  const sign = steady.slice(1).map((r, i) => Math.sign(r.pitch - steady[i].pitch));
  let flips = 0;
  for (let i = 1; i < sign.length; i++) if (sign[i] && sign[i - 1] && sign[i] !== sign[i - 1]) flips++;
  const kmhAt = (n) => rows.find((r) => r.kmh >= n);
  return {
    label,
    frames: rows.length,
    restPitchDeg: restPitch,
    topKmh: Math.max(...rows.map((r) => r.kmh)),
    steadyKmh: { min: Math.min(...steady.map((r) => r.kmh)), max: Math.max(...steady.map((r) => r.kmh)) },
    maxLaneErr: +Math.max(...rows.map((r) => Math.abs(r.laneErr))).toFixed(2),
    pitchAt100: kmhAt(100)?.pitch, lookAheadAt100: kmhAt(100)?.lookAhead,
    pitchAt200: kmhAt(200)?.pitch, lookAheadAt200: kmhAt(200)?.lookAhead,
    steadyPitchDeg: { min: Math.min(...steady.map((r) => r.pitch)), max: Math.max(...steady.map((r) => r.pitch)) },
    minPitchDeg: minPitch, minPitchAt: { t: minRow.t, kmh: minRow.kmh, lookAhead: minRow.lookAhead, camBack: minRow.camBack },
    pitchDownFromRestDeg: +(restPitch - minPitch).toFixed(3),
    steadyLookAhead: { min: Math.min(...steady.map((r) => r.lookAhead)), max: Math.max(...steady.map((r) => r.lookAhead)) },
    steadyCamBack: { min: Math.min(...steady.map((r) => r.camBack)), max: Math.max(...steady.map((r) => r.camBack)) },
    launchFramePitchDelta: stat(dLaunch),
    steadyFramePitchDelta: stat(dSteady),
    steadyFrameCamYDelta: stat(deltas(steady, "camY")),
    steadyPitchSignFlips: flips,
    steadyPitchFlipHz: +(flips / 5).toFixed(2),
  };
};

const toCsv = (rows) => {
  const k = Object.keys(rows[0]);
  return [k.join(","), ...rows.map((r) => k.map((x) => r[x]).join(","))].join("\n");
};

/* ---- screenshots: explicit frames, no rAF loop ----
   loop() re-arms its own rAF first thing, so calling it and cancelling that
   id right after renders exactly one frame under a clock we control (pass
   more frames per shot to let the post chain settle; 1 keeps SwiftShader
   runs short). The live loop stays parked
   (freeze) so nothing renders between the state set-up and the capture. */
const renderFrames = (n = 3) => page.evaluate((n) => {
  const g = window.__neonx.game;
  for (const nn of g.traffic.npcs) nn.active = false;
  g.chunksUpdate();
  for (let i = 0; i < n; i++) {
    g.last = performance.now() / 1000 - 1 / 60;
    g.acc = 0;
    cancelAnimationFrame(g.raf);
    g.loop();
    cancelAnimationFrame(g.raf);
  }
}, n);
const shot = async (name, frames = 1) => {
  await renderFrames(frames);
  const st = await page.evaluate(() => {
    const g = window.__neonx.game, c = g.car;
    return { cam: g.camMode, kmh: +(Math.abs(c.u) * 3.6).toFixed(1), z: +c.z.toFixed(1), running: g.running };
  });
  log("state", JSON.stringify(st));
  await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
  log("saved", `${TAG}-${name}.png`);
};

if (MODE === "trace" || MODE === "all") {
  log("trace uniform");
  const rowsU = await runTrace(false);
  log("trace uniform done", rowsU.length);
  writeFileSync(path.join(OUT, `${TAG}-trace-60fps.csv`), toCsv(rowsU));
  const sumU = summarize(rowsU, `${TAG} uniform 60fps`);
  log("trace jitter");
  const rowsJ = await runTrace(true);
  log("trace jitter done", rowsJ.length);
  writeFileSync(path.join(OUT, `${TAG}-trace-jitter.csv`), toCsv(rowsJ));
  const sumJ = summarize(rowsJ, `${TAG} jitter 40/120fps`);
  writeFileSync(path.join(OUT, `${TAG}-summary.json`), JSON.stringify([sumU, sumJ], null, 2));
  console.log(JSON.stringify(sumU));
  console.log(JSON.stringify(sumJ));
  // rowsJ left the car at top speed with full throttle, camera in steady state
  await shot("chase-topspeed");
}
if (MODE === "shots" || MODE === "all") {
  await freeze();
  await page.evaluate(() => {
    const nx = window.__neonx, g = nx.game;
    nx.setCam(0);
    nx.toCorridor(-1300, 0, 0);
    g.car.u = 0;
    nx.setInput({ th: 0, st: 0 });
    g.lastCamMode = -1;
    g.updateCamera(1 / 60);
  });
  await shot("chase-rest");
  await page.evaluate(() => {
    const nx = window.__neonx, g = nx.game;
    nx.toCorridor(-1300, 100, 0);
    nx.setInput({ th: 0.5, st: 0 });
    g.lastCamMode = -1;
    // settle the chase rig at 100 km/h the way the trace does, no rendering
    for (let i = 0; i < 180; i++) { nx.simStep(1 / 60); g.updateCamera(1 / 60); }
  });
  await shot("chase-100");
  await page.evaluate(() => {
    const nx = window.__neonx;
    nx.toCorridor(-1300, 100, 0);
    nx.setInput({ th: 0.5, st: 0 });
    nx.setCam(3);
  });
  await shot("pov-100");
  await page.evaluate(() => {
    const nx = window.__neonx;
    nx.toCorridor(-1300, 100, 0);
    nx.setInput({ th: 0.5, st: 0 });
    nx.setCam(1);
  });
  await shot("cockpit-100");
}

await browser.close();
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors.slice(0, 10)) console.log(" -", e.slice(0, 300));
  process.exit(1);
}
console.log("ok");
