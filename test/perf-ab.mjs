/* Perf-lane A/B instrument.

   test/perf-probe.mjs measures the right thing (wall-clock frame time at
   named places) but two of its columns cannot answer what this lane needed:

     - `calls`/`tris` are read after the frame is over, and three resets
       renderer.info at the START of every render() call. The last render() of
       a frame is the final full-screen post pass, so the probe reports
       `calls 1  tris 2` for every place. Here the counters are read INSIDE the
       wrapper, straight after the scene render, which is what they mean.
     - a median frame time on a three-lane SwiftShader box is mostly the other
       two lanes. So this also splits the frame into SCENE RENDER and POST
       CHAIN, each closed with gl.finish(), and reports the RATIO between them.
       A ratio survives contention that a millisecond does not.

   Same places and the same chunked sampling as perf-probe; run before and
   after with identical flags.

     node test/perf-ab.mjs --url http://localhost:3202 --frames 12 \
       --only open,tunnel,town --out before.json --shots shots-before --label before
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3202");
const OUT = arg("--out", "/tmp/lane-opt/perf/ab.json");
const FRAMES = Number(arg("--frames", 12));
const ONLY = arg("--only", "");
const SHOTS = arg("--shots", "");
const label = arg("--label", "run");

const PLACES = [
  ["open", 400, "open elevated deck, nothing special"],
  ["tunnel-approach", 860, "60 m before the tunnel mouth"],
  ["tunnel", 1090, "mid-tunnel"],
  ["toll-approach", 1330, "60 m before the plaza canopy"],
  ["toll", 1420, "under the toll canopy"],
  ["toll-exit", 1520, "past the plaza"],
  ["town", 2400, "town lamp field"],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
const t0 = Date.now();
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 900000 });
console.log("loaded in", ((Date.now() - t0) / 1000).toFixed(0), "s");
await sleep(10000);
await page.evaluate(() => window.__neonx.setTime(22.0));
await sleep(2000);

/* Instrument once, for the whole session. */
await page.evaluate(() => {
  const g = window.__neonx.game, r = g.renderer, p = g.post;
  const gl = r.getContext();
  const ab = (window.__ab = { scene: [], post: [], calls: 0, tris: 0, progs: 0 });
  const origProcess = p.process.bind(p);
  p.process = function (o) {
    const t = performance.now();
    origProcess(o);
    gl.finish();
    ab.post.push(performance.now() - t);
  };
  const origRender = r.render.bind(r);
  r.render = function (s, c) {
    if (s === g.scene && c === g.camera) {
      const t = performance.now();
      origRender(s, c);
      gl.finish();
      ab.scene.push(performance.now() - t);
      // three resets renderer.info at the start of every render(); read it here
      ab.calls = r.info.render.calls;
      ab.tris = r.info.render.triangles;
      ab.progs = r.info.programs.length;
    } else origRender(s, c);
  };
  ab.reset = () => { ab.scene.length = 0; ab.post.length = 0; };
});

const only = ONLY ? ONLY.split(",") : null;
const rows = [];
for (const [name, z, note] of PLACES) {
  if (only && !only.includes(name)) continue;
  await page.evaluate((z) => {
    const nx = window.__neonx;
    nx.toCorridor(z, 90, 1);
    nx.setInput({ th: 0.35 });
  }, z);
  await sleep(2500);
  await page.evaluate(() => window.__ab.reset());

  const CHUNK = 4;
  const dtAll = [];
  for (let got = 0; got < FRAMES; got += CHUNK) {
    const part = await page.evaluate(async (n) => {
      const dt = [];
      await new Promise((resolve) => {
        let last = -1, i = 0;
        const tick = (t) => {
          if (last >= 0) dt.push(t - last);
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
    const ab = window.__ab;
    const med = (a) => {
      if (!a.length) return null;
      const s = a.slice().sort((x, y) => x - y);
      return +s[Math.floor(s.length / 2)].toFixed(2);
    };
    const q = (a, p) => {
      const s = a.slice().sort((x, y) => x - y);
      return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
    };
    const g = window.__neonx.game;
    const mem = g.renderer.info.memory;
    const sc = med(ab.scene), po = med(ab.post);
    return {
      med: q(dt, 0.5), p95: q(dt, 0.95), max: +Math.max(...dt).toFixed(2), frames: dt.length,
      sceneMs: sc, postMs: po,
      postShare: sc && po ? +(po / (sc + po)).toFixed(4) : null,
      postPerScene: sc && po ? +(po / sc).toFixed(4) : null,
      sceneN: ab.scene.length, postN: ab.post.length,
      calls: ab.calls, tris: ab.tris, programs: ab.progs,
      geometries: mem.geometries, textures: mem.textures,
    };
  }, dtAll);
  r.place = name; r.z = z; r.note = note;
  rows.push(r);
  console.log(
    name.padEnd(16),
    `frame ${String(r.med).padStart(8)}`,
    `scene ${String(r.sceneMs).padStart(8)}`,
    `post ${String(r.postMs).padStart(7)}`,
    `post/scene ${String(r.postPerScene).padStart(6)}`,
    `calls ${String(r.calls).padStart(5)}`,
    `tris ${String(r.tris).padStart(8)}`,
  );
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) });
}

writeFileSync(OUT, JSON.stringify({ label, url: URL, frames: FRAMES, rows }, null, 2));
console.log("\nwrote", OUT);
await browser.close();
if (errors.length) {
  console.log("PAGE ERRORS:");
  for (const e of errors.slice(0, 5)) console.log(" -", e.slice(0, 200));
}
