/* The player's own journey: town frontage road -> entry ramp mouth -> deck.
   Prints the full car-box clearance sweep first, then drives it, then shoots. */
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { debugUrl } from "./lib/debug-url.mjs";
const URL = process.argv[2] || "http://localhost:3000";
const OUT = process.argv[3] || path.join(process.cwd(), "test", "artifacts", "onramp");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 1440, height: 900 }, protocolTimeout: 590000,
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

/* ---- the drive: frontage road -> mouth -> deck ------------------------- */
const drive = await page.evaluate(async () => {
  const g = window.__neonx;
  const cor = g.game.terrain.corridor;
  const r = g.game.terrain.ramps.find((q) => q.kind === "entry");
  const pts = r.pts;
  /* waypoints the player follows: up the frontage road from the south, into
     the mouth, up the ramp, then down the acceleration lane. */
  const wp = [];
  for (let z = -230; z < r.footZ - 6; z += 6) wp.push({ x: 435, z });
  for (let i = pts.length - 1; i >= 0; i--) wp.push({ x: pts[i].x, z: pts[i].z });
  for (let z = 84; z < 320; z += 8) {
    const w = cor.worldOf(z, -(cor.halfWidth(z) + cor.auxWidth(z) / 2));
    wp.push({ x: w.x, z: w.z });
  }
  g.teleport(435, -236, undefined, 0, 12);
  const log = [];
  let wi = 0, stall = 0;
  for (let k = 0; k < 200; k++) {
    const st = g.state();
    // advance the waypoint cursor past anything behind us
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
    log.push({ t: +((k + 1) * 0.3).toFixed(1), x: +s2.x.toFixed(1), y: +s2.y.toFixed(2),
      z: +s2.z.toFixed(1), kmh: +s2.kmh.toFixed(0), wp: wi,
      onRamp: g.game.terrain.onRamp(s2.x, s2.z) !== null });
    if (s2.kmh < 3) stall++; else stall = 0;
    if (stall > 8) { log.push({ STALLED_AT: { x: +s2.x.toFixed(1), z: +s2.z.toFixed(1) } }); break; }
    if (wi >= wp.length - 2) { log.push({ COMPLETED: true }); break; }
  }
  g.setInput(null);
  return log;
});
console.log("frontage road -> ramp -> deck:");
for (const l of drive) console.log("  ", JSON.stringify(l));

/* ---- pictures ---------------------------------------------------------- */
const shots = [
  ["foot", 258], ["climb", 175], ["gore", 100], ["merge", 20],
];
for (const cam of [3, 0]) {
  for (const [name, s0] of shots) {
    await page.evaluate(({ s0, cam }) => {
      const g = window.__neonx;
      const r = g.game.terrain.ramps.find((q) => q.kind === "entry");
      const pts = r.pts;
      let bi = 0, bd = 1e9;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(pts[i].s - s0); if (d < bd) { bd = d; bi = i; }
      }
      const p = pts[bi];
      g.setCam(cam);
      g.teleport(p.x, p.z, p.y + 0.2, Math.atan2(-p.tx, -p.tz), 55 / 3.6);
      g.setInput({ th: 0.35, br: 0, st: 0, hb: 0, horn: 0 });
    }, { s0, cam });
    await sleep(9000);
    await page.screenshot({ path: path.join(OUT, `${cam === 3 ? "pov" : "chase"}-${name}.png`) });
    console.log("shot", name, cam === 3 ? "pov" : "chase");
  }
}
await page.evaluate(() => window.__neonx.setInput(null));
await browser.close();
process.exit(0);
