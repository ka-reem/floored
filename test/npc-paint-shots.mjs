/* NPC random-paint lane photographer + cost meter.

   Shoots the SAME frame twice — once with the compact's tint uniform zeroed
   (what shipped: every compact wagon the same white) and once with it on —
   so the before/after needs no lining up by eye. The flip goes through
   material.userData.paintRef, which traffic.ts hangs off each NPC material
   for exactly this.

   Also reports renderer.info (draw calls, triangles, linked programs) and a
   frame-time sample over a fixed run, before and after the flip.

   Usage: node test/npc-paint-shots.mjs --url http://localhost:3425 --out DIR */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3425");
const OUT = arg("--out", process.cwd());
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});

/* No Math.random override here on purpose. The before/after is shot by
   flipping ONE uniform between two frames of the same run, so the traffic,
   the light and the framing are identical by construction — seeding the page
   would buy nothing, and an overridden Math.random stalled the world build. */

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 180000 });
await sleep(600);

const jpg = async (name) => {
  await page.screenshot({ path: path.join(OUT, name), type: "jpeg", quality: 88 });
  console.log("saved", name);
};
const click = (text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(t));
    b?.click();
  }, text);

await click("DRIVE");
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 900000 });
await sleep(6000);

/* Park at a fixed spot on the deck with a fixed traffic density, then let the
   stream fill in around us. Throttle held at a steady cruise so the fleet
   keeps its normal spacing rather than piling up behind a stopped car. */
const SPOT = -1300, KMH = 92;
const settle = async (ms = 9000) => {
  await page.evaluate((z, kmh) => {
    const nx = window.__neonx;
    nx.toCorridor(z, kmh, 1);
    nx.setInput({ th: 0.34 });
  }, SPOT, KMH);
  await sleep(ms);
};

/* --- flip control: the compact's tint uniform, live ---------------------- */
const setCompactTint = (on) =>
  page.evaluate((on) => {
    const t = window.__neonx.game.traffic;
    const ix = t.styleOf["compact"];
    const mat = t.styles[ix].mesh.material;
    const r = mat.userData.paintRef;
    if (!r) return "no paintRef";
    if (on) r.set(-1, 0.756, 0.12);
    else r.set(0, 0, 0);
    return `${r.x},${r.y},${r.z}`;
  }, on);

const meter = () =>
  page.evaluate(async () => {
    const g = window.__neonx.game;
    const N = 40;
    const ts = [];
    await new Promise((res) => {
      let n = 0, last = performance.now();
      const step = () => {
        const t = performance.now();
        ts.push(t - last); last = t;
        if (++n >= N) return res();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    ts.sort((a, b) => a - b);
    const info = g.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs.length,
      frameMedianMs: ts[Math.floor(ts.length / 2)],
      frameMeanMs: ts.reduce((a, b) => a + b, 0) / ts.length,
      npcs: window.__neonx.state().npcs,
    };
  });

const report = {};
/* Re-assert the flip before every capture: a desktop tier streams the HD
   bodyshells in mid-drive, and applyModel installs a FRESH material clone
   (and a fresh paintRef) when it does. A flip set once could be quietly
   undone between two shots. */
const shoot = async (tag, on) => {
  await setCompactTint(on);
  // dashcam first: the default and the most-played frame
  await page.evaluate(() => window.__neonx.setCam(3));
  await sleep(2500);
  await jpg(`npcpaint-pov-${tag}.jpg`);
  await setCompactTint(on);
  await page.evaluate(() => window.__neonx.setCam(0));
  await sleep(2500);
  await jpg(`npcpaint-chase-${tag}.jpg`);
  await setCompactTint(on);
  await page.evaluate(() => window.__neonx.setCam(3));
  await sleep(1800);
  report[tag] = await meter();
  console.log(tag, JSON.stringify(report[tag]));
};

await settle();
console.log("tint off ->", await setCompactTint(false));
await sleep(1500);
await shoot("before", false);

console.log("tint on ->", await setCompactTint(true));
await sleep(1500);
await shoot("after", true);

/* --- daylight, after only + a matched before ----------------------------- */
await page.evaluate(() => window.__neonx.setTime(12.5));
await sleep(4000);
await page.evaluate(() => window.__neonx.setCam(3));
await sleep(2500);
await jpg("npcpaint-day-after.jpg");
await setCompactTint(false);
await sleep(2000);
await jpg("npcpaint-day-before.jpg");
await setCompactTint(true);
await sleep(1500);
await jpg("npcpaint-day-after2.jpg");

writeFileSync(path.join(OUT, "npcpaint-metrics.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors.slice(0, 10)) console.log(" -", e.slice(0, 300));
  process.exit(1);
}
console.log("clean: no page errors");
