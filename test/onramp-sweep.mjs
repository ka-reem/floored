/* Live sweep of the ENTRY ramp — town frontage road → gore → deck.

   The browser-free sims (ramp-attach-sim, corridor-check) drive the ANALYTIC
   surface and say so: "static geometry (pier boxes, gore nose blocks) is left
   out on purpose". So they cannot see the one thing that actually stops a
   player driving the on-ramp — something standing IN it. This harness is the
   live counterpart, modelled on test/mountain-shots.mjs:

     1. collider sweep — every station of every ramp, lane centre and both
        pavement edges, against the real collider grid (world.colliders);
     2. settle probes — park the car on the ramp with real physics frames and
        assert it ends up ON the pavement, not under it and not stopped;
     3. the drive — start on the frontage road at the foot, full throttle,
        and check the car actually reaches the deck.

   Usage: node test/onramp-sweep.mjs [url] */
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const URL = process.argv[2] || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 900, height: 600 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);

/* ---- 0. what the geometry says -------------------------------------- */
const plan = await page.evaluate(() => {
  const g = window.__neonx;
  return g.game.terrain.ramps.map((r) => ({
    kind: r.kind, zr: r.zr, len: +r.len.toFixed(2), sSep: +r.sSep.toFixed(2),
    lead: r.lead, footX: +r.footX.toFixed(1), footZ: +r.footZ.toFixed(1),
    n: r.pts.length,
  }));
});
console.log("ramps:", JSON.stringify(plan));

/* ---- 1. collider sweep ----------------------------------------------- */
/* A car is 1.8 m wide; anything whose box reaches inside the pavement minus
   that half-width is something the player hits without leaving the road. */
const sweep = await page.evaluate(() => {
  const g = window.__neonx;
  const out = [];
  const HALFW = 0.9;
  for (const r of g.game.terrain.ramps) {
    for (let i = 0; i < r.pts.length; i++) {
      const p = r.pts[i];
      // the drivable band, per side, pulled in by the car's half-width
      const hi = p.hIn - HALFW, lo = -(p.hOut - HALFW);
      if (hi <= lo) continue; // no room for a car here (deck covers this band)
      const lats = [lo, (lo + hi) / 2, hi];
      for (const lat of lats) {
        const x = p.x + p.nx * lat, z = p.z + p.nz * lat, y = p.y;
        const near = g.collidersNear(x, z);
        for (const b of near.aabbs) {
          if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 &&
            y + 1.2 > (b.y0 ?? -1e9) && y < (b.y1 ?? 1e9))
            out.push({ kind: r.kind, s: +p.s.toFixed(1), z: +p.z.toFixed(1),
              lat: +lat.toFixed(1), type: "aabb",
              box: { x0: +b.x0.toFixed(1), x1: +b.x1.toFixed(1),
                z0: +b.z0.toFixed(1), z1: +b.z1.toFixed(1),
                y0: +(b.y0 ?? 0).toFixed(1), y1: +(b.y1 ?? 0).toFixed(1) } });
        }
        for (const o of near.obbs) {
          const dx = x - o.x, dz = z - o.z;
          const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
          if (Math.abs(lx) < o.hw && Math.abs(lz) < o.hd && y + 1.2 > o.y0 && y < o.y1)
            out.push({ kind: r.kind, s: +p.s.toFixed(1), z: +p.z.toFixed(1),
              lat: +lat.toFixed(1), type: "obb",
              box: { x: +o.x.toFixed(1), z: +o.z.toFixed(1), hw: +o.hw.toFixed(2),
                hd: +o.hd.toFixed(2), y0: +o.y0.toFixed(1), y1: +o.y1.toFixed(1) } });
        }
      }
    }
  }
  return out;
});
console.log(`collider sweep: ${sweep.length} intrusions`);
for (const s of sweep.slice(0, 24)) console.log("  ", JSON.stringify(s));
if (sweep.length) errors.push(`${sweep.length} colliders stand on ramp pavement`);

/* ---- 2. settle probes ------------------------------------------------ */
const entry = await page.evaluate(() =>
  window.__neonx.game.terrain.ramps.findIndex((r) => r.kind === "entry"));
const probes = [];
for (let f = 0; f <= 1.0001; f += 1 / 24) {
  const st = await page.evaluate(({ ri, frac }) => {
    const g = window.__neonx;
    const r = g.game.terrain.ramps[ri];
    const i = Math.min(r.pts.length - 1, Math.round(frac * (r.pts.length - 1)));
    const p = r.pts[i];
    // sit in the middle of whatever pavement exists here, facing UP the ramp
    const hi = p.hIn - 0.9, lo = -(p.hOut - 0.9);
    const lat = hi > lo ? (hi + lo) / 2 : 0;
    const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
    // the entry ramp's tangent runs gore→foot, so "up" is the reverse
    g.teleport(x, z, p.y + 0.25, Math.atan2(-p.tx, -p.tz), 0);
    g.setInput({ th: 0, br: 0, st: 0, hb: 0, horn: 0 });
    g.simStep(1.2);
    const s2 = g.state();
    return { s: +p.s.toFixed(1), z: +p.z.toFixed(1), surf: +p.y.toFixed(2),
      y: +s2.y.toFixed(2), dx: +(s2.x - x).toFixed(2), dz: +(s2.z - z).toFixed(2) };
  }, { ri: entry, frac: f });
  probes.push(st);
}
let worst = 0;
for (const p of probes) {
  const dy = Math.abs(p.y - p.surf);
  worst = Math.max(worst, dy);
  if (dy > 1.4) errors.push(`settle s=${p.s} z=${p.z}: y ${p.y} vs ramp ${p.surf}`);
}
console.log(`settle probes: ${probes.length}, worst |y - ramp| ${worst.toFixed(2)} m`);
for (const p of probes) console.log("  ", JSON.stringify(p));

/* ---- 3. the drive ---------------------------------------------------- */
/* From the frontage road at the foot, flat out, up the ramp. The player has
   to end up on the deck; anything else is the reported bug. */
const drive = await page.evaluate(async ({ ri }) => {
  const g = window.__neonx;
  const r = g.game.terrain.ramps[ri];
  const p = r.pts[r.pts.length - 1];
  const h = Math.atan2(-p.tx, -p.tz);
  // start 12 m back down the approach, on the frontage road
  g.teleport(p.x - Math.sin(h) * 12, p.z - Math.cos(h) * 12, undefined, h, 8);
  g.setInput({ th: 1, br: 0, st: 0, hb: 0, horn: 0 });
  const log = [];
  for (let k = 0; k < 40; k++) {
    g.simStep(0.5);
    const s = g.state();
    const rr = g.game.terrain.onRamp(s.x, s.z);
    const deck = g.game.terrain.corridor.heightAt(s.x, s.z, 1.0);
    log.push({ t: +((k + 1) * 0.5).toFixed(1), x: +s.x.toFixed(1), y: +s.y.toFixed(2),
      z: +s.z.toFixed(1), kmh: +s.kmh.toFixed(0),
      ramp: rr === null ? null : +rr.toFixed(2),
      deck: deck === null ? null : +deck.toFixed(2) });
  }
  g.setInput(null);
  return log;
}, { ri: entry });
console.log("drive from the foot, full throttle:");
for (const d of drive) console.log("  ", JSON.stringify(d));
const top = drive[drive.length - 1];
if (top.deck === null) errors.push(`the drive never reached the deck (ended at z=${top.z} y=${top.y})`);

console.log(errors.length ? `\nFAIL (${errors.length})` : "\nPASS");
for (const e of errors) console.log("  -", e);
await browser.close();
process.exit(errors.length ? 1 : 0);
