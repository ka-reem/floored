/* Focused ramp-descent instrumentation: sample car state every 300 ms and dump
   colliders near the stall point. Requires a running dev server (--url). */
import puppeteer from "puppeteer";

const URL = process.argv[2] || "http://localhost:3111";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--mute-audio"],
  defaultViewport: { width: 900, height: 600 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(URL, { waitUntil: "networkidle2", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 60000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await sleep(2000);
await page.evaluate(() => {
  window.__neonx.teleport(478, 260, 8.4, -Math.PI / 2, 11);
  window.__neonx.setInput({ th: 0.4 });
});
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
