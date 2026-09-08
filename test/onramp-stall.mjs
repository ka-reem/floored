/* Diagnostic: what is standing at the entry ramp's stall point? */
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

const r = await page.evaluate(() => {
  const g = window.__neonx;
  const r = g.game.terrain.ramps.find((q) => q.kind === "entry");
  return r.pts.slice(50).map((p) => ({ s: +p.s.toFixed(1), x: +p.x.toFixed(1),
    z: +p.z.toFixed(1), y: +p.y.toFixed(2), hIn: +p.hIn.toFixed(2), hOut: +p.hOut.toFixed(2),
    nx: +p.nx.toFixed(3), nz: +p.nz.toFixed(3) }));
});
console.log("entry ramp samples (foot half):");
for (const p of r) console.log("  ", JSON.stringify(p));

const near = await page.evaluate(() => {
  const g = window.__neonx;
  const seen = new Set(); const out = { aabbs: [], obbs: [] };
  for (let x = 430; x <= 480; x += 6) for (let z = -185; z <= -145; z += 6) {
    const n = g.collidersNear(x, z);
    for (const b of n.aabbs) {
      const k = "a" + b.x0 + b.z0 + b.y0; if (seen.has(k)) continue; seen.add(k);
      out.aabbs.push({ x0: +b.x0.toFixed(1), x1: +b.x1.toFixed(1), z0: +b.z0.toFixed(1),
        z1: +b.z1.toFixed(1), y0: +(b.y0 ?? 0).toFixed(1), y1: +(b.y1 ?? 0).toFixed(1) });
    }
    for (const o of n.obbs) {
      const k = "o" + o.x + o.z + o.y0; if (seen.has(k)) continue; seen.add(k);
      out.obbs.push({ x: +o.x.toFixed(1), z: +o.z.toFixed(1), hw: +o.hw.toFixed(2),
        hd: +o.hd.toFixed(2), cos: +o.cos.toFixed(2), sin: +o.sin.toFixed(2),
        y0: +o.y0.toFixed(1), y1: +o.y1.toFixed(1) });
    }
  }
  return out;
});
console.log(`colliders in x[430,480] z[-185,-145]: ${near.aabbs.length} aabb, ${near.obbs.length} obb`);
for (const b of near.aabbs) console.log("   AABB", JSON.stringify(b));
for (const o of near.obbs) console.log("   OBB", JSON.stringify(o));

/* park exactly at the stall point and see which clamp fires */
const st = await page.evaluate(() => {
  const g = window.__neonx;
  g.teleport(447, -168, 0.1, Math.PI / 2, 12);
  g.setInput({ th: 1, br: 0, st: 0, hb: 0, horn: 0 });
  const log = [];
  for (let k = 0; k < 20; k++) {
    g.simStep(0.25);
    const s = g.state();
    log.push({ t: +((k + 1) * 0.25).toFixed(2), x: +s.x.toFixed(2), y: +s.y.toFixed(2),
      z: +s.z.toFixed(2), kmh: +s.kmh.toFixed(1), h: +s.h.toFixed(2) });
  }
  g.setInput(null);
  return log;
});
console.log("pushed east from (447,-168):");
for (const l of st) console.log("  ", JSON.stringify(l));
await browser.close();
process.exit(0);
