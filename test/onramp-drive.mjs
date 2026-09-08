/* Drive the ENTRY ramp the way a player does: from the town frontage road,
   up the ramp, through the gore, onto the deck — with a driver that actually
   steers (pure pursuit on the ramp centreline, then the aux lane).

   Also sweeps a CAR-SIZED box (not a point) along the ramp so a post that
   sits between two sample stations cannot hide. */
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";
const URL = process.argv[2] || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 900, height: 600 }, protocolTimeout: 590000,
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

/* ---- car-box clearance sweep ---------------------------------------- */
const boxes = await page.evaluate(() => {
  const g = window.__neonx;
  const HW = 0.92, HL = 2.25; // player rig half-width / half-length
  const sat = (ax, az, afx, afz, aw, al, o) => {
    const bfx = o.sin, bfz = o.cos, bw = o.hw, bl = o.hd;
    const axes = [[afz, -afx], [afx, afz], [bfz, -bfx], [bfx, bfz]];
    const dx = ax - o.x, dz = az - o.z;
    for (const [ux, uz] of axes) {
      const ra = aw * Math.abs(ux * afz - uz * afx) + al * Math.abs(ux * afx + uz * afz);
      const rb = bw * Math.abs(ux * bfz - uz * bfx) + bl * Math.abs(ux * bfx + uz * bfz);
      if (ra + rb - Math.abs(ux * dx + uz * dz) <= 0) return false;
    }
    return true;
  };
  const out = [];
  for (const r of g.game.terrain.ramps) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      for (let f = 0; f < 1; f += 0.34) {
        const x0 = a.x + (b.x - a.x) * f, z0 = a.z + (b.z - a.z) * f;
        const y = a.y + (b.y - a.y) * f;
        const nx = a.nx, nz = a.nz, tx = a.tx, tz = a.tz;
        const hi = a.hIn - HW, lo = -(a.hOut - HW);
        if (hi <= lo) continue;
        for (let k = 0; k <= 6; k++) {
          const lat = lo + ((hi - lo) * k) / 6;
          const x = x0 + nx * lat, z = z0 + nz * lat;
          const near = g.collidersNear(x, z);
          for (const o of near.obbs) {
            if (y + 1.3 < o.y0 || y > o.y1) continue;
            if (sat(x, z, tx, tz, HW, HL, o))
              out.push({ kind: r.kind, s: +a.s.toFixed(1), lat: +lat.toFixed(1),
                x: +x.toFixed(1), z: +z.toFixed(1), obb: { x: +o.x.toFixed(1),
                  z: +o.z.toFixed(1), hw: o.hw, hd: +o.hd.toFixed(2),
                  y0: +o.y0.toFixed(1), y1: +o.y1.toFixed(1) } });
          }
          for (const b2 of near.aabbs) {
            if (y + 1.3 < (b2.y0 ?? -1e9) || y > (b2.y1 ?? 1e9)) continue;
            const o = { x: (b2.x0 + b2.x1) / 2, z: (b2.z0 + b2.z1) / 2,
              hw: (b2.x1 - b2.x0) / 2, hd: (b2.z1 - b2.z0) / 2, cos: 1, sin: 0 };
            if (sat(x, z, tx, tz, HW, HL, o))
              out.push({ kind: r.kind, s: +a.s.toFixed(1), lat: +lat.toFixed(1),
                x: +x.toFixed(1), z: +z.toFixed(1), aabb: b2 });
          }
        }
      }
    }
  }
  // dedupe by (kind, s)
  const seen = new Set();
  return out.filter((o) => { const k = o.kind + o.s; if (seen.has(k)) return false; seen.add(k); return true; });
});
console.log(`car-box sweep: ${boxes.length} stations where a car in the lane touches a collider`);
for (const b of boxes.slice(0, 20)) console.log("  ", JSON.stringify(b));

/* ---- the drive -------------------------------------------------------- */
const runs = [];
for (const startS of [258, 200, 140, 90]) {
  const log = await page.evaluate(({ s0 }) => {
    const g = window.__neonx;
    const r = g.game.terrain.ramps.find((q) => q.kind === "entry");
    const pts = r.pts;
    // nearest sample to arclength s0
    const idxAt = (s) => { let bi = 0, bd = 1e9;
      for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i].s - s);
        if (d < bd) { bd = d; bi = i; } } return bi; };
    const i0 = idxAt(s0);
    const p0 = pts[i0];
    const h0 = Math.atan2(-p0.tx, -p0.tz);
    g.teleport(p0.x, p0.z, p0.y + 0.2, h0, 12);
    const out = [];
    let stalled = 0;
    for (let k = 0; k < 90; k++) {
      const st = g.state();
      // pure pursuit: aim 14 m up the ramp centreline (s decreasing), then
      // once past the top of the ramp, aim along the corridor
      let bi = 0, bd = 1e9;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - st.x, pts[i].z - st.z);
        if (d < bd) { bd = d; bi = i; }
      }
      let tx, tz;
      if (bi > 3 && bd < 14) {
        const ti = Math.max(0, bi - 5);
        tx = pts[ti].x; tz = pts[ti].z;
      } else {
        const cor = g.game.terrain.corridor;
        const zc = cor.zAt(st.x, st.z);
        const w = cor.worldOf(zc + 26, -(cor.halfWidth(zc + 26) + cor.auxWidth(zc + 26) / 2));
        tx = w.x; tz = w.z;
      }
      let da = Math.atan2(tx - st.x, tz - st.z) - st.h;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const steer = Math.max(-1, Math.min(1, da * 1.6));
      const want = 55; // km/h
      g.setInput({ th: st.kmh < want ? 1 : 0, br: st.kmh > want + 14 ? 0.4 : 0,
        st: steer, hb: 0, horn: 0 });
      g.simStep(0.35);
      const s2 = g.state();
      const deck = g.game.terrain.corridor.heightAt(s2.x, s2.z, 1.0);
      out.push({ t: +((k + 1) * 0.35).toFixed(1), x: +s2.x.toFixed(1), y: +s2.y.toFixed(2),
        z: +s2.z.toFixed(1), kmh: +s2.kmh.toFixed(0), off: +bd.toFixed(1),
        onDeck: deck !== null });
      if (s2.kmh < 3) stalled++; else stalled = 0;
      if (stalled > 6) { out.push({ STALLED: true }); break; }
      if (deck !== null && s2.z > 40) { out.push({ REACHED_DECK: true }); break; }
    }
    g.setInput(null);
    return out;
  }, { s0: startS });
  runs.push({ startS, log });
}
for (const r of runs) {
  const last = r.log[r.log.length - 1];
  console.log(`\n--- start s=${r.startS} -> ${last.REACHED_DECK ? "REACHED DECK" : last.STALLED ? "STALLED" : "ran out of time"}`);
  for (const l of r.log) console.log("  ", JSON.stringify(l));
}
await browser.close();
process.exit(0);
