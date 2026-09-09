#!/usr/bin/env node
/* Shots for the quick-drawer FOV row (owner: "field of view should be able to
   be adjusted from the 3 dots").

   Two things to look at:
     1. the drawer itself, with the new FIELD OF VIEW row, at three viewports;
     2. the SAME parked frame at each of the four stops the row offers, so the
        control's actual effect is visible rather than described.

   The drawer is display:none off body.touch (globals.css) — desktop reaches
   the same control with the K key — so every viewport here is captured with
   hasTouch, including the desktop-sized one.

   Usage: node test/fov-drawer-shots.mjs --url http://localhost:3427 --out DIR */
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3427");
const OUT = arg("--out", "/tmp/fov-shots");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* SwiftShader only advances rAF while the compositor is producing frames, so
   a screenshot is what makes time pass here — same trick as the audio checks. */
const advance = async (page, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { await page.screenshot({ optimizeForSpeed: true }); await sleep(80); }
};
/* The world build is staged behind requestAnimationFrame, and headless
   Chromium only advances rAF while the compositor is producing frames — so
   waiting on `loaded` without driving frames can wait forever on a busy box.
   Screenshotting IS the frame driver here, and polling this way also prints
   progress instead of failing blind after N minutes. */
async function waitLoaded(page, ms = 1800000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    await page.screenshot({ optimizeForSpeed: true });
    const s = await page.evaluate(() => ({
      loaded: !!window.__neonx?.game?.loaded,
      txt: (document.body.innerText || "").split("\n").filter(Boolean).slice(0, 3).join(" | ").slice(0, 80),
    }));
    const secs = Math.round((Date.now() - t0) / 1000);
    if (s.loaded) { console.log(`  world loaded after ${secs}s`); return; }
    if (s.txt !== last) { console.log(`  … ${secs}s ${s.txt}`); last = s.txt; }
    await sleep(1500);
  }
  throw new Error("world never finished loading");
}
const errs = [];

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
  ],
  protocolTimeout: 1800000,
  userDataDir: process.env.FLOORED_PROFILE_DIR || undefined,
});

async function session(w, h, { touch = true } = {}) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errs.push(String(e.message || e)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) errs.push(m.text()); });
  await page.setViewport({ width: w, height: h, isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
  console.log("  goto", new Date().toISOString());
  await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 900000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
  console.log("  __neonx up", new Date().toISOString());
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b?.click();
  });
  await waitLoaded(page);
  await advance(page, 2500);
  return page;
}

async function openDrawer(page) {
  await page.evaluate(() =>
    document.getElementById("tcMore")?.dispatchEvent(
      new PointerEvent("pointerdown", { pointerId: 90, bubbles: true, cancelable: true })));
  await page.waitForFunction(
    () => document.getElementById("tcDrawer")?.classList.contains("open"), { timeout: 5000 });
  await advance(page, 500);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + ".png"), type: "png" });
  console.log("  📸", path.join(OUT, name + ".png"));
}

/* Crop to the drawer itself — a 390x664 frame is far too small to read a row
   label in, and the row is the whole point of the shot. */
async function drawerCrop(page, name) {
  const box = await page.evaluate(() => {
    const r = document.getElementById("tcDrawer").getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({
    path: path.join(OUT, name + ".png"), type: "png",
    clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 },
  });
  console.log("  📸", path.join(OUT, name + ".png"), `(drawer ${Math.round(box.width)}x${Math.round(box.height)})`);
}

/* ---- 1. the drawer, three viewports ---- *
   ONE session, resized between shots. The world build costs minutes on
   SwiftShader, and body.touch (which is what makes the drawer visible at all)
   is decided once in the Game constructor from hasTouch — so a resize is the
   only part that has to change between these three. */
console.log("drawer session");
const dpage = await session(390, 664);
for (const [name, w, h] of [
  ["phone-portrait", 390, 664],
  ["phone-landscape", 844, 390],
  ["desktop", 1440, 900],
]) {
  await dpage.setViewport({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await advance(dpage, 1500);
  await openDrawer(dpage);
  await shot(dpage, `drawer-${name}-full`);
  await drawerCrop(dpage, `drawer-${name}-crop`);
  console.log(`   ${name} ${w}x${h}:`, JSON.stringify(await dpage.evaluate(() => window.__neonx.game.fovRow)));
  /* Tap the row once so the state chip is caught mid-ladder rather than only
     ever at the default — proof the tap actually moves it. */
  await dpage.evaluate(() => {
    const row = [...document.querySelectorAll("#tcDrawer .qdRow")]
      .find((r) => r.textContent.includes("FIELD OF VIEW"));
    row?.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 91, bubbles: true }));
  });
  await advance(dpage, 500);
  await drawerCrop(dpage, `drawer-${name}-crop-tapped`);
  console.log("   after one tap:", JSON.stringify(await dpage.evaluate(() => window.__neonx.game.fovRow)));
  // close it again so the next viewport starts from the same place
  await dpage.evaluate(() =>
    document.getElementById("tcMore")?.dispatchEvent(
      new PointerEvent("pointerdown", { pointerId: 92, bubbles: true, cancelable: true })));
  await advance(dpage, 400);
}
await dpage.close();

/* ---- 2. the same parked frame at every stop ---- */
const STOPS = [58, 67, 80, 100];
const fpage = await session(1440, 900, { touch: false });
await fpage.evaluate(() => {
  const g = window.__neonx.game;
  g.timeSpeed = 0;      // frozen sky, so only the lens differs between frames
  g.time = 20.2;        // night, headlights lit
});
for (const [camName, camIx] of [["dashcam", 3], ["chase", 0]]) {
  console.log(`FOV ladder, ${camName}`);
  await fpage.evaluate((ix) => window.__neonx.setCam(ix), camIx);
  // parked in lane on the expressway: identical camera position in all four
  await fpage.evaluate(() => window.__neonx.toCorridor(1200, 0, 0));
  await fpage.evaluate(() => window.__neonx.setInput({ th: 0, br: 1, st: 0 }));
  await advance(fpage, 3000);
  for (const v of STOPS) {
    await fpage.evaluate((f) => { window.__neonx.game.settings.fovBase = f; }, v);
    await advance(fpage, 1500);
    await shot(fpage, `fov-${camName}-${v}`);
    console.log(`   ${camName} ${v}:`, JSON.stringify(await fpage.evaluate(
      () => ({ camFov: +window.__neonx.game.camera.fov.toFixed(2) }))));
  }
}
await fpage.close();

await browser.close();
if (errs.length) { console.error("page errors:"); for (const e of errs) console.error("  - " + e); process.exit(1); }
console.log("fov-drawer-shots: OK");
