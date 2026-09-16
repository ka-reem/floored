/* Lane R beam-aim instrumentation (NOT part of the game): quantifies headlight
   spotlight aim and retro-wedge alignment vs the local road plane at four
   stations — flat control, off-ramp climb, corridor uphill/crest, bypass
   grade — and captures POV (dashcam, graded), HOOD (ungraded control) and
   CHASE screenshots at each, plus a road-region luminance stat per shot.
   Usage:
     node test/lane-r-measure.mjs --url http://localhost:3141 \
       --out /abs/dir --tag before
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";
import sharp from "sharp";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3141");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts"));
const TAG = arg("--tag", "probe");
mkdirSync(OUT, { recursive: true });

const VW = 1280, VH = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: VW, height: VH },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* The world is built by the staged loader after this click, not by the
   constructor, so __neonx existing no longer means there is a world to
   drive in — wait for the load to finish before touching it. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(2500);

/* Resolve stations from the live world so this keeps working if geometry
   shifts. Each station is a teleport pose pointing UP its grade. */
const stations = await page.evaluate(() => {
  const g = window.__neonx.game;
  const out = [];
  const cor = g.terrain.corridor;

  // flat control: the straight the POV framing shots use
  {
    const z = -1300;
    const p = cor.worldOf(z, cor.laneOffset(1, z));
    out.push({ name: "flat", x: p.x, z: p.z, y: p.y + 0.2, h: cor.pose(z).h, grade: cor.pose(z).grade ?? 0 });
  }

  // steepest climbing off-ramp: probe every ramp polyline for max rise
  {
    const ramps = g.terrain.ramps || [];
    let best = null;
    for (const r of ramps) {
      const pts = r.pts;
      if (!pts || pts.length < 8) continue;
      const rise = pts[pts.length - 1].y - pts[0].y;
      const cand = { r, up: rise > 0, mag: Math.abs(rise) };
      if (!best || cand.mag > best.mag) best = cand;
    }
    if (best) {
      const pts = best.r.pts;
      // walk in climbing direction; stand ~40% up the climb
      const i = Math.floor(pts.length * (best.up ? 0.4 : 0.6));
      const p = pts[i], q = pts[i + (best.up ? 2 : -2)] || p;
      const dx = q.x - p.x, dz = q.z - p.z, dy = q.y - p.y;
      const run = Math.hypot(dx, dz) || 1;
      out.push({
        name: "ramp-climb", x: p.x, z: p.z, y: p.y + 0.2,
        h: Math.atan2(dx, dz), grade: dy / run, zr: best.r.zr,
      });
    }
  }

  // corridor: steepest sustained upgrade, and its crest (grade + -> -)
  {
    const z0 = (cor.Z0 ?? -2400), z1 = (cor.Z1 ?? 2400);
    let bz = null, bg = 0;
    const prof = [];
    for (let z = z0; z <= z1; z += 6) {
      let gr = 0;
      try { gr = cor.pose(z).grade ?? 0; } catch { continue; }
      prof.push([z, gr]);
      if (gr > bg) { bg = gr; bz = z; }
    }
    if (bz !== null && bg > 0.008) {
      const p = cor.worldOf(bz, cor.laneOffset(1, bz));
      out.push({ name: "uphill", x: p.x, z: p.z, y: p.y + 0.2, h: cor.pose(bz).h, grade: bg });
      // crest: first sign flip after the steepest point, stand just before it
      for (let k = 0; k < prof.length - 1; k++) {
        if (prof[k][0] <= bz) continue;
        if (prof[k][1] > 0 && prof[k + 1][1] <= 0) {
          const cz = prof[k][0] - 18;
          const cp = cor.worldOf(cz, cor.laneOffset(1, cz));
          out.push({ name: "crest", x: cp.x, z: cp.z, y: cp.y + 0.2, h: cor.pose(cz).h, grade: cor.pose(cz).grade ?? 0 });
          break;
        }
      }
    }
  }

  // bypass viaduct: steepest upgrade along arclength
  {
    const by = g.world.routes?.bypass;
    if (by) {
      let bs = null, bg = 0;
      for (let s = 10; s < by.len - 10; s += 4) {
        const a = by.worldOf(s - 4, 0), b = by.worldOf(s + 4, 0);
        const gr = (b.y - a.y) / 8;
        if (gr > bg) { bg = gr; bs = s; }
      }
      if (bs !== null && bg > 0.008) {
        const p = by.worldOf(bs, by.laneOffset(0, bs));
        out.push({ name: "bypass-grade", x: p.x, z: p.z, y: p.y + 0.2, h: by.poseAt(bs).h, grade: bg });
      }
    }
  }
  return out;
});
console.log("stations:", JSON.stringify(stations.map(s => ({
  name: s.name, grade: +Number(s.grade).toFixed(4), x: +s.x.toFixed(1), z: +s.z.toFixed(1),
}))));

/* Angle + retro measurements, evaluated against live engine state. */
const measure = () => {
  const g = window.__neonx.game;
  const st = window.__neonx.state();
  const rig = g.rig;
  const v = g.beamPos.clone(), t = g.beamPos.clone();
  const dirOf = (sp) => {
    sp.getWorldPosition(v); sp.target.getWorldPosition(t);
    return t.clone().sub(v).normalize();
  };
  const D = 180 / Math.PI;
  const dL = dirOf(rig.spotL), dS = dirOf(rig.spreadL);
  const bd = g.beamDir.clone().normalize();
  const deckDeg = Math.atan(st.slope) * D;
  // where the dipped cone's UPPER EDGE (the cut-off) meets the deck, marching
  // along the edge ray from the lamp — the single number for how much
  // road the pool covers
  rig.spotL.getWorldPosition(v);
  const axisPitch = Math.asin(dL.y); // signed, up positive
  const half = rig.spotL.angle;
  const edgePitch = axisPitch + half; // top of cone
  const fx = Math.sin(st.h), fz = Math.cos(st.h);
  const hmag = Math.hypot(dL.x, dL.z) || 1e-6;
  let edgeHit = null;
  for (let s = 2; s <= 400; s += 1) {
    const ex = v.x + (dL.x / hmag) * s, ez = v.z + (dL.z / hmag) * s;
    const ey = v.y + Math.tan(edgePitch) * s;
    let gy = null;
    try { gy = g.cor.heightAt(ex, ez, 2); } catch { /* off deck */ }
    if (gy === null || gy === undefined) {
      try { gy = g.terrain.heightAt(ex, ez, ey); } catch { gy = null; }
    }
    if (gy !== null && ey <= gy + 0.03) { edgeHit = s; break; }
  }
  // retro-wedge response predicted for lane paint on the deck ahead
  const smooth = (a, b, x) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  const cos0 = 0.95, cos1 = 0.999, range = 130 / 115;
  const bp = g.beamPos;
  const rows = [];
  for (const d of [10, 15, 20, 30, 40, 50, 60]) {
    const px = st.x + fx * d, pz = st.z + fz * d;
    let py = null;
    try { py = g.cor.heightAt(px, pz, 2); } catch { /* off deck */ }
    if (py === null || py === undefined) {
      try { py = g.terrain.heightAt(px, pz, st.y); } catch { py = st.y; }
    }
    const bx = px - bp.x, by = (py + 0.01) - bp.y, bz = pz - bp.z;
    const dist = Math.hypot(bx, by, bz);
    const align = (bx * bd.x + by * bd.y + bz * bd.z) / Math.max(dist, 1e-4);
    const cone = smooth(cos0, cos1, align);
    const fall = 1 - smooth(18 * range, 62 * range, dist);
    rows.push({ d, rise: +(py - st.y).toFixed(2), align: +align.toFixed(4),
      paintLit: +(cone * fall).toFixed(3) });
  }
  return {
    slope: +st.slope.toFixed(4), pitchDyn: +st.pitchDyn.toFixed(4),
    pitchVis: +(g.pitchVis ?? 0).toFixed(4),
    deckPitchDeg: +deckDeg.toFixed(2),
    spotAxisPitchDeg: +(axisPitch * D).toFixed(2),
    spotEdgePitchDeg: +(edgePitch * D).toFixed(2),
    spotEdgeMinusDeckDeg: +((edgePitch * D) - deckDeg).toFixed(2),
    spreadAxisPitchDeg: +(Math.asin(dS.y) * D).toFixed(2),
    retroDirPitchDeg: +(Math.asin(bd.y) * D).toFixed(2),
    retroMinusDeckDeg: +((Math.asin(bd.y) * D) - deckDeg).toFixed(2),
    cutoffHitsDeckAtM: edgeHit,
    paint: rows,
  };
};

/* Mean/p95 luminance of the road band of a screenshot (lower-centre region
   where deck + paint live in all three camera modes). */
async function roadStats(file) {
  const img = sharp(file).extract({
    left: Math.round(VW * 0.30), top: Math.round(VH * 0.52),
    width: Math.round(VW * 0.40), height: Math.round(VH * 0.30),
  }).greyscale();
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  const arr = [...data].sort((a, b) => a - b);
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  return { mean: +mean.toFixed(1), p95: arr[Math.floor(arr.length * 0.95)] };
}

const CAMS = [[3, "pov"], [2, "hood"], [0, "chase"]];
const results = {};
for (const s of stations) {
  await page.evaluate((s) => {
    window.__neonx.teleport(s.x, s.z, s.y, s.h, 17);
    window.__neonx.setInput({ th: 0.42 });
    window.__neonx.setCam(3);
  }, s);
  await sleep(1500); // let slope/pitch settle while still on the grade
  const m = await page.evaluate(measure);
  results[s.name] = { grade: s.grade, ...m, shots: {} };
  for (const [cam, cname] of CAMS) {
    // re-pin to the station each shot so all cameras see the same spot
    await page.evaluate((s, cam) => {
      window.__neonx.teleport(s.x, s.z, s.y, s.h, 17);
      window.__neonx.setInput({ th: 0.42 });
      window.__neonx.setCam(cam);
    }, s, cam);
    await sleep(900);
    const file = path.join(OUT, `${TAG}-${s.name}-${cname}.png`);
    await page.screenshot({ path: file });
    results[s.name].shots[cname] = await roadStats(file);
  }
}

console.log(JSON.stringify(results, null, 1));
await browser.close();
if (errors.length) {
  console.log("PAGE ERRORS:");
  for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 300));
  process.exit(1);
}
console.log("ok");
