/* Where the frames actually go.

   Drives the car to a list of named places, holds it there, and samples
   per-frame wall time alongside the renderer's own counters. The point is to
   make "the toll booth lags" a number instead of a feeling, and to give any
   optimisation a before/after that is the same measurement twice.

   It reads `renderer.info` straight off the Game instance through the debug
   hook. That field is `private` in TypeScript only — at runtime it is an
   ordinary property — so nothing in the engine had to be opened up to measure
   it, and there is no probe left in the shipping build.

   Frame time is sampled in-page with requestAnimationFrame deltas rather than
   from anything the engine reports, so it counts everything the browser does
   per frame, not just the parts the engine knows it is doing. Median is the
   honest "how does it feel" number; p95 is where a spike lives, and a spike is
   what the owner reported at the toll plaza.

   IMPORTANT: this box has no GPU. Chrome runs SwiftShader, so absolute frame
   times are far slower than any real machine and are meaningless on their own.
   RATIOS between places, and before/after on the SAME box, are what this is
   for. Never quote a raw fps from here as if it were the game's fps.

   Usage:
     node test/perf-probe.mjs --url http://localhost:3000 --out probe.json
     node test/perf-probe.mjs --url ... --frames 240 --only toll,tunnel
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3000");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts", "perf-probe.json"));
const FRAMES = Number(arg("--frames", 180));
const ONLY = arg("--only", "");
const SHOTS = arg("--shots", ""); // dir; when set, one PNG per place
const label = arg("--label", "run");

/* The places, in corridor z. Bounds come from game/world/corridor.ts:
   TUNNEL z0/z1 = 920/1260, TOLL plazaZ0/plazaZ1 = 1390/1450. "approach" spots
   sit just outside a structure so the pair isolates what the structure costs. */
const PLACES = [
  ["open", 400, "open elevated deck, nothing special"],
  ["tunnel-approach", 860, "60 m before the tunnel mouth"],
  ["tunnel", 1090, "mid-tunnel"],
  ["toll-approach", 1330, "60 m before the plaza canopy"],
  ["toll", 1420, "under the toll canopy — the reported spike"],
  ["toll-exit", 1520, "past the plaza, still in the wide window"],
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
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000); // let the async props and the HD fleet land

/* Night: the lighting is the expensive half and the owner drives at night. */
await page.evaluate(() => window.__neonx.setTime(22.0));
await sleep(2000);

const only = ONLY ? ONLY.split(",") : null;
const rows = [];
for (const [name, z, note] of PLACES) {
  if (only && !only.includes(name)) continue;
  await page.evaluate((z) => {
    const nx = window.__neonx;
    nx.toCorridor(z, 90, 1);
    nx.setInput({ th: 0.35 });
  }, z);
  await sleep(2500); // settle: streaming, LOD swaps, sprite pools

  /* Sampled in CHUNKS rather than as one long evaluate. A frame under
     SwiftShader with three lanes sharing four cores can take seconds, so a
     single call that waits for every frame blows puppeteer's protocolTimeout
     and kills the run with a ProtocolError instead of returning data. Each
     chunk is short enough to answer; the deltas are concatenated. */
  const CHUNK = 20;
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
    const g = window.__neonx.game;
    const info = g.renderer?.info;
    dt = dt.slice().sort((a, b) => a - b);
    const at = (q) => dt[Math.min(dt.length - 1, Math.floor(dt.length * q))];
    return {
      med: +at(0.5).toFixed(2),
      p95: +at(0.95).toFixed(2),
      max: +dt[dt.length - 1].toFixed(2),
      calls: info?.render?.calls ?? null,
      tris: info?.render?.triangles ?? null,
      programs: info?.programs?.length ?? null,
      geometries: info?.memory?.geometries ?? null,
      textures: info?.memory?.textures ?? null,
      frames: dt.length,
    };
  }, dtAll);

  r.place = name; r.z = z; r.note = note;
  rows.push(r);
  console.log(
    name.padEnd(17),
    `med ${String(r.med).padStart(7)} ms`,
    `p95 ${String(r.p95).padStart(7)} ms`,
    `calls ${String(r.calls).padStart(5)}`,
    `tris ${String(r.tris).padStart(8)}`,
    `progs ${String(r.programs).padStart(3)}`,
  );
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) });
}

/* Every place against the open deck, which is the cheapest thing the game
   draws. A ratio survives the software renderer; a millisecond does not. */
const base = rows.find((r) => r.place === "open");
if (base) {
  console.log("\nrelative to open deck:");
  for (const r of rows)
    console.log(`  ${r.place.padEnd(17)} ${(r.med / base.med).toFixed(2)}x med  ${(r.calls / base.calls).toFixed(2)}x calls`);
}

writeFileSync(OUT, JSON.stringify({ label, url: URL, frames: FRAMES, rows }, null, 2));
console.log("\nwrote", OUT);
await browser.close();
if (errors.length) {
  console.log("PAGE ERRORS:");
  for (const e of errors.slice(0, 5)) console.log(" -", e.slice(0, 200));
}
