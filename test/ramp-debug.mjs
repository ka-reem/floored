/* Focused ramp-descent instrumentation: sample car state every 300 ms and dump
   colliders near the stall point. Requires a running dev server (--url). */
import puppeteer from "puppeteer";

const URL = process.argv[2] || "http://localhost:3000";
const ZR = Number(process.argv[3] ?? -500); // which gore to probe (CONNECT_Z[0])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--mute-audio"],
  defaultViewport: { width: 900, height: 600 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
// the dev server holds an HMR socket open, so the network never goes idle
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await sleep(2000);
// drop the car partway down the ramp, pointing along its centreline
await page.evaluate((zr) => {
  const r = window.__neonx.game.terrain.ramps.find((q) => q.zr === zr);
  const p = r.pts[Math.floor(r.pts.length * 0.45)];
  window.__neonx.teleport(p.x, p.z, p.y + 0.2, Math.atan2(p.tx, p.tz), 11);
  window.__neonx.setInput({ th: 0.4 });
}, ZR);
for (let i = 0; i < 10; i++) {
  await sleep(300);
  const s = await page.evaluate(() => {
    const st = window.__neonx.state();
    return { x: +st.x.toFixed(2), y: +st.y.toFixed(2), z: +st.z.toFixed(2), u: +st.u.toFixed(2), h: +st.h.toFixed(3) };
  });
  console.log(`t=${(i + 1) * 0.3}s`, JSON.stringify(s));
}
const near = await page.evaluate(() => {
  const st = window.__neonx.state();
  return window.__neonx.collidersNear(st.x, st.z);
});
console.log("colliders near stall point:");
for (const a of near.aabbs) console.log("  AABB", JSON.stringify(a));
for (const o of near.obbs)
  console.log("  OBB", JSON.stringify({ x: +o.x.toFixed(1), z: +o.z.toFixed(1), hw: +o.hw.toFixed(1), hd: +o.hd.toFixed(1), y0: +o.y0.toFixed(1), y1: +o.y1.toFixed(1) }));
await browser.close();
process.exit(0);
