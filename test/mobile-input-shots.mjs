/* Gallery screenshots for the mobile-input lane report — the dashcam POV on
   a touch-emulated phone, in both steer modes, plus the pause screen the
   gearBtn/clearLatchedInput fix is about. The lane's actual fixes are
   behavioral (pointer-id tracking, a frame watchdog) and mostly invisible on
   screen — see docs/handoff/reports/mobile-input.md for the real proof —
   these are documentation of the surface they run under, not before/after
   diffs.

   Usage: node test/mobile-input-shots.mjs */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer, { KnownDevices } from "puppeteer";
import sharp from "sharp";

const OUT = path.join(process.cwd(), "docs", "gallery", "img");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDev(port) {
  const child = spawn("npx", ["next", "dev", "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    detached: true,
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
    child.stderr.on("data", (d) => process.stderr.write("[next:err] " + d.toString()));
    child.on("exit", (c) => reject(new Error("next dev exited " + c)));
  });
  return child;
}

function killDev(dev) {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGKILL");
    } catch {}
  }
}

async function shot(page, name, caption) {
  const raw = await page.screenshot({ type: "png" });
  const outPath = path.join(OUT, `mobile-input-${name}.jpg`);
  const img = sharp(raw);
  const meta = await img.metadata();
  const resized = meta.width > 1200 ? img.resize({ width: 1200 }) : img;
  await resized.jpeg({ quality: 80 }).toFile(outPath);
  console.log("  📸", outPath, "—", caption);
}

/** One full session: start a dev server on `port`, load under touch
    emulation with an optional profile seed, click through to Drive, run
    `body`, always clean up the server after. */
async function withSession(port, seedProfile, body) {
  const dev = await startDev(port);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--enable-unsafe-swiftshader",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--mute-audio",
      ],
      protocolTimeout: 300000,
    });
    const page = await browser.newPage();
    await page.emulate(KnownDevices["iPhone 13"]);
    if (seedProfile) {
      await page.evaluateOnNewDocument((profile) => {
        localStorage.setItem("neonx.profile.v3", JSON.stringify(profile));
      }, seedProfile);
    }
    const url = `http://localhost:${port}`;
    console.log("→ loading", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
      b?.click();
    });
    await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
    await page.evaluate(() => window.__neonx.setCam(4)); // CAM_POV is last in the cycle — the shipped dashcam view
    await sleep(2500);
    await body(page);
  } finally {
    if (browser) await browser.close();
    killDev(dev);
  }
}

async function main() {
  await withSession(3114, null, async (page) => {
    await page.evaluate(() => {
      document.getElementById("tcL")?.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
      document.getElementById("tcG")?.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, bubbles: true }));
    });
    await sleep(400);
    await shot(page, "buttons-dashcam", "Dashcam POV, buttons steer mode — left + throttle pucks held, each tracked by its own pointer id now.");

    await page.evaluate(() => {
      document.getElementById("gearBtn")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    await sleep(500);
    await shot(page, "paused", "gearBtn pause: clearLatchedInput() drops the held pucks so Drive never resumes mid-steer.");
  });

  await withSession(3115, { settings: { steerMode: "wheel" } }, async (page) => {
    await page.evaluate(() => {
      document.getElementById("swheel")?.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 1, bubbles: true, clientX: 60, clientY: 60 })
      );
      document.getElementById("swheel")?.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, bubbles: true, clientX: 118, clientY: 60 })
      );
    });
    await sleep(400);
    await shot(page, "wheel-dashcam", "Dashcam POV, wheel steer mode mid-drag — a second finger brushing the wheel no longer jumps or drops the deflection.");
  });

  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
