/* Photo-mode gallery photographer.

   Boots the game headless, drives onto the deck at night among traffic,
   enters photo mode the way a player does (the O key through the real
   GameApp handler), then walks the orbit through a few framings and saves
   gallery JPEGs straight into docs/gallery/img/ (1200 px wide, q80, per
   HANDOFF.md). The orbit is posed by writing the photo state directly —
   the smoke test already proves the drag/wheel input path; this script's
   job is repeatable framing, not input coverage.

   Usage: node test/photomode-shots.mjs [--url http://localhost:3000]
   (starts its own `next dev` on :3112 when no --url is given) */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const OUT = path.join(process.cwd(), "docs", "gallery", "img");
mkdirSync(OUT, { recursive: true });
const argUrl = process.argv.indexOf("--url");
const externalUrl = argUrl > -1 ? process.argv[argUrl + 1] : null;
const PORT = 3112;
const URL = externalUrl || `http://localhost:${PORT}`;
const VW = 1200, VH = 675;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function startDev() {
  if (externalUrl) return null;
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("next dev timeout")), 120000);
    /* Next 16 prints "Ready" and THEN bows out if another dev server holds
       this directory (a previous run's server surviving its SIGTERM does it),
       so "Ready" alone is a lie — watch both streams for the refusal and say
       which server to reuse instead of dying later on ERR_CONNECTION_REFUSED. */
    const watch = (d) => {
      const s = d.toString();
      if (/already running/.test(s)) {
        clearTimeout(to);
        reject(new Error(
          "another `next dev` owns this dir — rerun with --url pointing at it:\n" + s
        ));
      } else if (/Ready|started server/.test(s)) {
        clearTimeout(to);
        resolve();
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("exit", (c) => reject(new Error("next dev exited " + c)));
  });
  /* "Ready" can print BEFORE the already-running refusal (observed order:
     Ready → refusal → exit), so only an answered request proves the server
     is really this one. */
  for (let i = 0; ; i++) {
    try {
      await fetch(URL);
      break;
    } catch {
      if (i > 60) throw new Error("next dev reported Ready but never served " + URL);
      await sleep(1000);
    }
  }
  return child;
}

const dev = await startDev();
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: VW, height: VH },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(3000);

// night, on the four-lane straight, rolling with traffic so the freeze has
// something in frame besides the player car
await page.evaluate(() => {
  window.__neonx.setTime(21.5);
  window.__neonx.toCorridor(-180, 90, 1);
  window.__neonx.setInput({ th: 0.45 });
});
await sleep(5000);

// enter through the real key path — GameApp pauses the sim and drops the HUD
await page.keyboard.press("o");
await page.waitForFunction(() => window.__neonx.state().photo, { timeout: 20000 });
await sleep(600);

const pose = async (name, yawOff, pitch, dist) => {
  await page.evaluate(
    ({ yawOff, pitch, dist }) => {
      const g = window.__neonx.game;
      g.photo.auto = false;
      g.photo.yaw = g.car.h + yawOff;
      g.photo.pitch = pitch;
      g.photo.dist = dist;
    },
    { yawOff, pitch, dist }
  );
  await sleep(500); // a few frames for photoUpdate to place and settle the lens
  await page.screenshot({ path: path.join(OUT, name + ".jpg"), type: "jpeg", quality: 80 });
  console.log("  📸", name);
};

// the opening framing itself (front three-quarter, the PHOTO.yaw0 default)
await pose("photomode-front34", 0.6, 0.2, 6.0);
// low rear three-quarter — tail lights and the traffic frozen behind
await pose("photomode-rear34-low", Math.PI - 0.7, 0.02, 5.4);
// high side profile with the expressway running through frame
await pose("photomode-high-side", Math.PI / 2, 0.85, 11);

await browser.close();
dev?.kill("SIGTERM");
if (errors.length) {
  console.log("❌ page errors:");
  for (const e of errors.slice(0, 10)) console.log("  -", e.slice(0, 300));
  process.exit(1);
}
console.log("✅ photomode shots saved to docs/gallery/img/");
process.exit(0);
