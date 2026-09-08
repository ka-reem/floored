/* The stutter that is not the toll plaza.

   The owner reported a lag spike "at the toll booth". Three separate probes
   (test/toll-hitch.mjs, test/cam-hitch.mjs, and the CONSOLE camera) all found
   the same thing instead: the plaza draws LESS than open road, and the worst
   frame in every run landed wherever the player happened to be a few seconds
   after load, with a burst of ~30 new shader programs beside it. That is the
   async photo-scan upgrade in game/world/mats.ts — ensurePbr() fetches nine
   texture sets, then applies ~25 material upgrades in ONE synchronous block,
   each flagging needsUpdate. Every one of those is a program relink, and a
   relink is a synchronous stall, so they all land in a single frame.

   This measures exactly that and nothing else: sit still on open deck from the
   moment the game is playable, sample every frame, and watch the renderer's
   program count. Report:

     - the frame the program count jumped on, and how big the jump was
     - the worst frame time in the run, and whether it coincides
     - how many DISTINCT frames carried relinks

   The last one is the number the fix moves. Spreading the upgrades over frames
   does not make the work smaller — the same ~30 programs are linked either way
   — it stops them landing together. So a fix looks like: same total program
   growth, spread over many more frames, with the worst frame back down near
   the run's median.

   The position is deliberately boring open deck, away from the plaza, the
   tunnels and the gores: this stall follows the CLOCK, not the map, and
   parking somewhere interesting would just re-run the toll test.

   Usage: node test/pbr-hitch.mjs --url http://localhost:3000 --label after
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
const LABEL = arg("--label", "run");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts", `pbr-hitch-${LABEL}.json`));
const FRAMES = Number(arg("--frames", 90));
const AWAY = 400; // open elevated deck: no plaza, no tunnel, no gore
/* Hold the photo-scan downloads back by this many ms so they land AFTER the
   world is drawn — see the LATE note below. 0 = leave the network alone. */
const LATE = Number(arg("--late", 0));
/* Serve the scans a 404 instead. loadPbrSet always resolves and an absent set
   has a null albedo that every upgrade path returns early on, so the world
   builds identically minus the scans — which makes the program count at load
   the NO-SCAN baseline, and the difference against a normal run the number of
   programs the scans are responsible for. That is the burst size, measured
   without having to reproduce the burst's timing. */
const NOSCANS = process.argv.includes("--noscans");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 1280, height: 720 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();

/* THE REPRODUCTION.

   Measured on this box, the nine scan sets resolve 147 SECONDS BEFORE the
   game is playable, while the renderer still holds zero programs — the world
   build is minutes long under a software rasteriser and the assets come off
   local disk. So they cost nothing here: the load's own compile stage sees
   the finished materials and links them once, and there is no burst to find.
   The first version of this probe therefore measured 2 program links in 50
   frames and proved nothing at all.

   The case that matters is the opposite one, and it is the COMMON one for a
   real first-time player: a fast machine that builds the world in a couple of
   seconds, downloading ~5 MB of scans over a phone connection. There the
   scans land well after the compile stage and after the player is driving.

   Rather than throttle the whole session — which would slow the 25 MB of
   other assets and make the world build itself take an hour here — this
   delays ONLY the scan requests. Everything else runs at full speed, so the
   ordering under test is reproduced without any other variable moving. */
if (LATE || NOSCANS) {
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    if (!r.url().includes("/assets/pbr/")) return void r.continue().catch(() => {});
    if (NOSCANS) return void r.respond({ status: 404, body: "" }).catch(() => {});
    setTimeout(() => r.continue().catch(() => {}), LATE);
  });
}
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });

/* NO settle sleep. `loaded` is the moment the player is handed the car, and
   the burst lands somewhere in the seconds after it — sleeping here would
   sleep straight through the thing under test, which is how the first version
   of the toll probe missed it. */
await page.evaluate((z) => {
  window.__neonx.toCorridor(z, 90, 1);
  window.__neonx.setInput({ th: 0.3 });
}, AWAY);

/* Per-frame samples, in short chunks: one evaluate() spanning 90 SwiftShader
   frames blows puppeteer's protocolTimeout. Each chunk records the frame
   delta AND the program count, so a jump can be pinned to a frame. */
/* The program count the moment the game is playable. With --noscans this is
   the world WITHOUT the photo scans; the difference between the two runs is
   what the scans cost in programs, and therefore the size of the burst they
   would land on one frame if they arrived late. */
const atLoad = await page.evaluate(
  () => window.__neonx.game.renderer?.info?.programs?.length ?? null);
console.log(`programs when the game became playable: ${atLoad}${NOSCANS ? "  (no scans)" : ""}`);

const rows = [];
for (let got = 0; got < FRAMES; got += 6) {
  const part = await page.evaluate(async (n) => {
    const out = [];
    const r = window.__neonx.game.renderer;
    await new Promise((resolve) => {
      let last = -1, i = 0;
      const tick = (t) => {
        if (last >= 0) out.push({ dt: t - last, progs: r.info.programs?.length ?? 0 });
        last = t;
        if (++i > n) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return out;
  }, Math.min(6, FRAMES - got));
  rows.push(...part);
}
await browser.close();

const dts = rows.map((r) => r.dt).sort((a, b) => a - b);
const med = dts[Math.floor(dts.length / 2)];
const worst = dts[dts.length - 1];
const worstAt = rows.findIndex((r) => r.dt === worst);

/* Where the relinks landed. A frame whose program count is higher than the one
   before it linked that many programs. */
const jumps = [];
for (let i = 1; i < rows.length; i++) {
  const d = rows[i].progs - rows[i - 1].progs;
  if (d > 0) jumps.push({ frame: i, n: d, dt: +rows[i].dt.toFixed(0) });
}
const total = jumps.reduce((s, j) => s + j.n, 0);
const biggest = jumps.reduce((a, b) => (b.n > (a?.n ?? 0) ? b : a), null);

console.log(`\n${LABEL} — ${rows.length} frames on open deck from the moment the game is playable` +
  (LATE ? `, photo scans held back ${(LATE / 1000).toFixed(0)} s` : ""));
console.log(`  median frame ${med.toFixed(0)} ms, worst ${worst.toFixed(0)} ms at frame ${worstAt}`);
console.log(`  programs linked during the run: ${total}, over ${jumps.length} distinct frame(s)`);
if (biggest)
  console.log(`  biggest single-frame burst: +${biggest.n} programs at frame ${biggest.frame}` +
    ` (that frame took ${biggest.dt} ms, ${(biggest.dt / med).toFixed(1)}x the median)`);
else console.log("  no programs linked during the run — the burst landed before sampling started");
for (const j of jumps.slice(0, 12))
  console.log(`    frame ${String(j.frame).padStart(3)}  +${String(j.n).padStart(2)} programs   ${String(j.dt).padStart(6)} ms`);

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(
  { label: LABEL, noscans: NOSCANS, atLoad, med, worst, worstAt, total, jumps, rows }, null, 2));
console.log("wrote", OUT);
