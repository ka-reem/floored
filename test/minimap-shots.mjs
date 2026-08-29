/* Minimap photographer: both zoom framings, day and night, plus one in-situ
   chase frame — the images behind docs/handoff/reports/minimap-polish.md.

   The map canvas is 172 px; a gallery image of it at 1:1 would be a stamp.
   So each map shot is blown up in-page 6x with imageSmoothing off — every
   screen pixel of the real canvas becomes a crisp 6x6 block, nothing is
   re-rendered at a size the HUD never uses — and the overlay canvas is
   screenshotted instead. The in-situ frame is the page itself, from CHASE
   (the HUD map is hidden in the in-car views; they carry the head unit).

   The car is parked ~300 m short of EXIT 4's gore, so the near/day pair also
   shows the upcoming-exit ring; time is frozen per shot via timeSpeed = 0.

   Usage: node test/minimap-shots.mjs [--url http://localhost:3111]
          SHOT_DIR overrides the output directory (default test/artifacts). */

import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = process.env.SHOT_DIR || path.join(process.cwd(), "test", "artifacts");
mkdirSync(OUT, { recursive: true });
const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3111";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 1200, height: 675 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(3000);

/* Park short of EXIT 4's gore (inside the EXIT_WARN highlight window, close
   enough that the ring is on the near view's canvas), in CHASE, map on. */
await page.evaluate(() => {
  document.querySelector("nextjs-portal")?.remove(); // the dev-mode "N" badge
  const g = window.__neonx.game;
  const ex4 = g.world.exits.find((e) => e.no === 4) || g.world.exits[0];
  window.__neonx.toCorridor(ex4.z - 150, 0, 1);
  window.__neonx.setCam(0); // CHASE — the HUD map is hidden in in-car views
  g.timeSpeed = 0;
  if (!g.mmap) g.uiKeyTap("x");
  if (g.mmapZoom) g.uiKeyTap("z"); // start from the close-up framing
});
await sleep(1500);

const setTime = (h) => page.evaluate((hh) => {
  const g = window.__neonx.game;
  g.settings.autoTime = false;
  g.time = hh;
}, h);
const setZoom = (loop) => page.evaluate((l) => {
  const g = window.__neonx.game;
  if (g.mmapZoom !== l) g.uiKeyTap("z"); // the real key path, not a field poke
}, loop);

/** Blow the 172 px map canvas up 6x (smoothing off) and screenshot that. */
async function mapShot(name) {
  /* The map repaints every 4th frame, and SwiftShader here renders frames at
     a crawl — a wall-clock sleep can pass without a single repaint (the first
     cut of this file shipped five identical stale screenshots that way).
     Wait for the engine's own frame counter instead: +9 frames spans at
     least two %4 repaints, whatever the frame rate is doing. */
  const f0 = await page.evaluate(() => window.__neonx.game.frameN);
  await page.waitForFunction(
    (f) => window.__neonx.game.frameN > f + 9, { timeout: 120000 }, f0
  );
  await page.evaluate(() => {
    const src = document.getElementById("mmap");
    let big = document.getElementById("mmapBig");
    if (!big) {
      big = document.createElement("canvas");
      big.id = "mmapBig";
      big.width = src.width * 6;
      big.height = src.height * 6;
      big.style.cssText = "position:fixed;left:0;top:0;z-index:99";
      document.body.appendChild(big);
    }
    const c = big.getContext("2d");
    c.imageSmoothingEnabled = false;
    c.fillStyle = "#05060c"; // the UI's --bg behind the map's translucent fill
    c.fillRect(0, 0, big.width, big.height);
    c.drawImage(src, 0, 0, big.width, big.height);
  });
  const el = await page.$("#mmapBig");
  await el.screenshot({ path: path.join(OUT, name + ".jpg"), type: "jpeg", quality: 80 });
  await page.evaluate(() => document.getElementById("mmapBig")?.remove());
  console.log("  📸", name);
}

await setTime(22.4); // night — the shipped look
await setZoom(false);
await mapShot("minimap-near-night");
// the in-situ frame: chase view with the map live in its corner
await page.screenshot({ path: path.join(OUT, "minimap-chase-night.jpg"), type: "jpeg", quality: 80 });
console.log("  📸 minimap-chase-night");
await setZoom(true);
await mapShot("minimap-loop-night");

await setTime(13); // midday
await setZoom(false);
await mapShot("minimap-near-day");
await setZoom(true);
await mapShot("minimap-loop-day");

/* The widest pavement on the lap — the toll plaza fan-out — in the close-up:
   the ribbon must widen station-by-station (per-station hw, not a constant
   stroke), with the amber plaza flag over it. */
await setTime(22.4);
await setZoom(false);
await page.evaluate(() => {
  // the plaza is wherever the corridor is widest — no import needed
  const st = window.__neonx.game.cor.stations;
  let wide = st[0];
  for (const s of st) if (s.hw > wide.hw) wide = s;
  window.__neonx.toCorridor(wide.z - 60, 0, 1);
});
await mapShot("minimap-toll-night");

await browser.close();
if (errors.length) {
  console.error("page errors:", errors);
  process.exit(1);
}
console.log("done →", OUT);
