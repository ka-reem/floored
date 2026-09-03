/* Gallery shots for the drive-stats lane: the pause menu with its STATS
   entry, and the STATS panel itself — once mid-session with the record rows
   lit, and once after a reload showing lifetime totals carried while the
   session column starts over. Drives the same scripted accumulation
   drive-stats-check.mjs verifies, so the numbers on screen are real.

   Usage: node test/stats-shots.mjs [--url http://localhost:3124] */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const OUT = path.join(process.cwd(), "docs", "gallery", "img");
mkdirSync(OUT, { recursive: true });

const argUrl = process.argv.indexOf("--url");
const externalUrl = argUrl > -1 ? process.argv[argUrl + 1] : null;
const PORT = 3124;
const URL = externalUrl || `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDev() {
  if (externalUrl) return null;
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("next dev timeout")), 120000);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Ready") || s.includes("started server")) {
        clearTimeout(to);
        resolve();
      }
    });
    child.on("exit", (c) => reject(new Error("next dev exited " + c)));
  });
  return child;
}

const clickBtn = (page, label) =>
  page.evaluate((l) => {
    [...document.querySelectorAll("button")]
      .find((x) => x.textContent.includes(l))
      ?.click();
  }, label);

async function drive(page) {
  await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
  await clickBtn(page, "DRIVE");
  await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
  await sleep(1000);
}

const shot = (page, name) =>
  page.screenshot({ path: path.join(OUT, name), type: "jpeg", quality: 80 });

async function main() {
  const dev = await startDev();
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    ],
    defaultViewport: { width: 1200, height: 800 },
    protocolTimeout: 300000,
  });
  const page = await browser.newPage();
  await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await drive(page);

  /* a real drive's worth of numbers: a fast run, a mountain traversal, one
     crash — same script the check file runs */
  await page.evaluate(() => {
    window.__neonx.toCorridor(-1300, 140);
    window.__neonx.setInput({ th: 0.9 });
    window.__neonx.simStep(30);
  });
  await page.evaluate(() => {
    const mt = window.__neonx.game.world.routes.mtn;
    for (let i = 0; i <= 40; i++) {
      const s = Math.max(4, Math.min(mt.len - 4, (i / 40) * mt.len));
      const p = mt.worldOf(s, mt.laneOffset(0, s));
      window.__neonx.teleport(p.x, p.z, p.y + 0.15, mt.poseAt(s).h, 25);
      window.__neonx.setInput({ th: 0 });
      window.__neonx.simStep(0.6);
    }
    const c = window.__neonx.game.terrain.corridor;
    const q = c.worldOf(0, 0);
    window.__neonx.teleport(q.x, q.z, q.y + 0.2, c.pose(0).h, 30);
    window.__neonx.simStep(4);
    window.__neonx.crashTest();
  });
  await page.waitForFunction(() => window.__neonx.state().stats.crashes >= 1, {
    timeout: 45000, polling: 500,
  }).catch(() => {});
  await page.evaluate(() => window.__neonx.setInput(null));

  await page.keyboard.press("Escape");
  await sleep(500);
  await shot(page, "stats-pause-menu.jpg");
  await clickBtn(page, "STATS");
  await sleep(400);
  await shot(page, "stats-panel-session.jpg");
  await clickBtn(page, "BACK");
  await sleep(300);
  await clickBtn(page, "RESUME"); // persists the profile

  await sleep(500);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await drive(page);
  await page.keyboard.press("Escape");
  await sleep(500);
  await clickBtn(page, "STATS");
  await sleep(400);
  await shot(page, "stats-panel-lifetime.jpg");

  await browser.close();
  dev?.kill("SIGTERM");
  console.log("shots written to", OUT);
  process.exit(0); // the dev child's pipes keep the loop alive otherwise
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
