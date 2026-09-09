/* The ENTRY RAMP, live: can a player actually drive from the town up onto the
   expressway, and what does it look like?

   Why this exists. Every browser-free sim scored the entry ramp a clean 0.00
   while it was unclimbable, because they all measured how far the car was
   JOLTED and the car was never jolted — it simply never rose. It sat on the
   flat ground UNDER the ramp for the whole 264 m climb and stopped against the
   ramp's first pier. So this harness asks the two questions a sim of the
   analytic surface cannot:

     1. does anything STAND in the ramp? A car-sized box (not a point — a post
        can hide between two sample stations) swept along the pavement against
        the real collider grid, which the sims leave out on purpose;
     2. can the drive be DONE? Frontage road in the town, up the ramp, through
        the gore, down the acceleration lane, with a driver that steers.

   Then it photographs it: dashcam first (the default view), then chase.

   Usage: node test/onramp-shots.mjs [url] [outdir] */
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { debugUrl } from "./lib/debug-url.mjs";

const URL = process.argv[2] || "http://localhost:3000";
const OUT = process.argv[3] || path.join(process.cwd(), "test", "artifacts", "onramp");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 1440, height: 900 }, protocolTimeout: 590000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => { console.log("pageerror:", e.message); errors.push("pageerror: " + e.message); });
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);

/* ---- 1. is anything standing in the ramp? ---------------------------- */
const intrusions = await page.evaluate(() => {
  const g = window.__neonx;
  const HW = 0.92, HL = 2.25; // the player rig
  /* SAT, exactly as collide.ts runs it, box vs box */
  const hits = (ax, az, afx, afz, o) => {
    const bfx = o.sin, bfz = o.cos;
    const axes = [[afz, -afx], [afx, afz], [bfz, -bfx], [bfx, bfz]];
    const dx = ax - o.x, dz = az - o.z;
    for (const [ux, uz] of axes) {
      const ra = HW * Math.abs(ux * afz - uz * afx) + HL * Math.abs(ux * afx + uz * afz);
      const rb = o.hw * Math.abs(ux * bfz - uz * bfx) + o.hd * Math.abs(ux * bfx + uz * bfz);
      if (ra + rb - Math.abs(ux * dx + uz * dz) <= 0) return false;
    }
    return true;
  };
  const out = [];
  for (const r of g.game.terrain.ramps) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      for (let f = 0; f < 1; f += 0.34) {
        const cx = a.x + (b.x - a.x) * f, cz = a.z + (b.z - a.z) * f;
        const y = a.y + (b.y - a.y) * f;
        /* The RUNNING LANE: the middle 60% of the pavement, which leaves a
           2 m shoulder either side of a 10.5 m ramp.

           Not the full width minus a half-car. The ramp's own parapet faces
           stand 0.08 m inside the nominal pavement edge, and each wall
           collider is a straight chord across a curve whose radius falls to
           ~20 m at the foot, so a 4.5 m car riding the extreme edge of the
           pavement clips its own coping — 64 hits, all of them hw = 0.35 ramp
           walls, none of them an obstruction. What this sweep is for is a
           post, pier, mast or sign standing IN the road, and anything a
           player would call that is inside the middle 60%. */
        const hi = a.hIn * 0.6, lo = -a.hOut * 0.6;
        if (hi - lo < 2 * HW) continue; // no room for a car — the deck has this band
        for (let k = 0; k <= 6; k++) {
          const lat = lo + ((hi - lo) * k) / 6;
          const x = cx + a.nx * lat, z = cz + a.nz * lat;
          const near = g.collidersNear(x, z);
          const boxes = [...near.obbs, ...near.aabbs.map((q) => ({
            x: (q.x0 + q.x1) / 2, z: (q.z0 + q.z1) / 2, hw: (q.x1 - q.x0) / 2,
            hd: (q.z1 - q.z0) / 2, cos: 1, sin: 0, y0: q.y0 ?? -1e9, y1: q.y1 ?? 1e9 }))];
          for (const o of boxes) {
            if (y + 1.3 < o.y0 || y > o.y1) continue;
            if (hits(x, z, a.tx, a.tz, o))
              out.push(`${r.kind} ramp s=${a.s.toFixed(1)} lat=${lat.toFixed(1)}: `
                + `box at (${o.x.toFixed(1)}, ${o.z.toFixed(1)}) `
                + `${o.hw.toFixed(2)}x${o.hd.toFixed(2)} y[${o.y0.toFixed(1)}, ${o.y1.toFixed(1)}]`);
          }
        }
      }
    }
  }
  const seen = new Set();
  return out.filter((s) => { const k = s.slice(0, 22); if (seen.has(k)) return false; seen.add(k); return true; });
});
console.log(`collider sweep: ${intrusions.length} car-sized intrusions into ramp pavement`);
for (const s of intrusions.slice(0, 12)) console.log("  ", s);
if (intrusions.length) errors.push(`${intrusions.length} colliders stand in a ramp lane`);

/* ---- 2. can the drive be done? --------------------------------------- */
const drive = await page.evaluate(() => {
  const g = window.__neonx;
  const cor = g.game.terrain.corridor;
  const r = g.game.terrain.ramps.find((q) => q.kind === "entry");
  const pts = r.pts;
  /* the player's own route: north up the west frontage road, into the mouth,
     up the ramp, then down the acceleration lane onto the deck */
  const wp = [];
  for (let z = -230; z < r.footZ - 6; z += 6) wp.push({ x: 435, z });
  for (let i = pts.length - 1; i >= 0; i--) wp.push({ x: pts[i].x, z: pts[i].z });
  for (let z = 84; z < 300; z += 8) {
    const w = cor.worldOf(z, -(cor.halfWidth(z) + cor.auxWidth(z) / 2));
    wp.push({ x: w.x, z: w.z });
  }
  g.teleport(435, -236, undefined, 0, 12);
  const log = []; let wi = 0, stall = 0, minAboveGround = 1e9, climbed = 0;
  for (let k = 0; k < 220; k++) {
    const st = g.state();
    while (wi < wp.length - 1 && Math.hypot(wp[wi].x - st.x, wp[wi].z - st.z) < 11) wi++;
    let ti = wi;
    while (ti < wp.length - 1 && Math.hypot(wp[ti].x - st.x, wp[ti].z - st.z) < 13) ti++;
    let da = Math.atan2(wp[ti].x - st.x, wp[ti].z - st.z) - st.h;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const want = Math.abs(da) > 0.5 ? 26 : 58;
    g.setInput({ th: st.kmh < want ? 1 : 0, br: st.kmh > want + 10 ? 0.5 : 0,
      st: Math.max(-1, Math.min(1, da * 1.9)), hb: 0, horn: 0 });
    g.simStep(0.3);
    const s2 = g.state();
    const ry = g.game.terrain.onRamp(s2.x, s2.z);
    /* THE assertion this whole file exists for: while the car is over ramp
       pavement it must be ON it, not on the ground beneath it. */
    if (ry !== null) minAboveGround = Math.min(minAboveGround, s2.y - (ry - 0.4));
    climbed = Math.max(climbed, s2.y);
    log.push({ t: +((k + 1) * 0.3).toFixed(1), x: +s2.x.toFixed(1), y: +s2.y.toFixed(2),
      z: +s2.z.toFixed(1), kmh: +s2.kmh.toFixed(0), ramp: ry === null ? null : +ry.toFixed(2) });
    if (s2.kmh < 3) stall++; else stall = 0;
    if (stall > 8) { log.push({ STALLED_AT: { x: +s2.x.toFixed(1), z: +s2.z.toFixed(1), y: +s2.y.toFixed(2) } }); break; }
    if (wi >= wp.length - 2) { log.push({ COMPLETED: true, y: +s2.y.toFixed(2), z: +s2.z.toFixed(1) }); break; }
  }
  g.setInput(null);
  return { log, minAboveGround: +minAboveGround.toFixed(2), climbed: +climbed.toFixed(2) };
});
console.log("frontage road -> ramp -> deck:");
for (const l of drive.log) console.log("  ", JSON.stringify(l));
const last = drive.log[drive.log.length - 1];
if (!last.COMPLETED)
  errors.push(`the drive did not finish: ${JSON.stringify(last)}`);
if (drive.minAboveGround < 0)
  errors.push(`the car was under the ramp surface by ${(-drive.minAboveGround).toFixed(2)} m`);
if (drive.climbed < 9)
  errors.push(`the climb only reached y=${drive.climbed} — the deck is ~10 m up`);
console.log(`  highest y reached ${drive.climbed} m; worst clearance below the ramp surface`
  + ` ${drive.minAboveGround} m`);

/* ---- 3. the photographs ---------------------------------------------- */
const shot = async (name) => {
  await sleep(9000);
  await page.screenshot({ path: path.join(OUT, name + ".png") });
  console.log("shot", name);
};
for (const cam of [3, 0]) { // dashcam first — it is the default view
  const tag = cam === 3 ? "pov" : "chase";
  for (const [name, s0] of [["1-foot", 256], ["2-climb", 190], ["3-gore", 95], ["4-merge", 25]]) {
    await page.evaluate(({ s0, cam }) => {
      const g = window.__neonx;
      const r = g.game.terrain.ramps.find((q) => q.kind === "entry");
      let bi = 0, bd = 1e9;
      for (let i = 0; i < r.pts.length; i++) {
        const d = Math.abs(r.pts[i].s - s0); if (d < bd) { bd = d; bi = i; }
      }
      const p = r.pts[bi];
      g.setCam(cam);
      g.teleport(p.x, p.z, p.y + 0.2, Math.atan2(-p.tx, -p.tz), 52 / 3.6);
      g.setInput({ th: 0.35, br: 0, st: 0, hb: 0, horn: 0 });
    }, { s0, cam });
    await shot(`${tag}-${name}`);
  }
}
await page.evaluate(() => window.__neonx.setInput(null));
console.log(errors.length ? `\nFAIL (${errors.length})` : "\nPASS: the entry ramp is drivable");
for (const e of errors) console.log("  -", e);
await browser.close();
process.exit(errors.length ? 1 : 0);
