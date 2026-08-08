/* Headless smoke test: boots the game in Chrome (SwiftShader WebGL), walks the
   menus, drives in each zone, forces a crash, and captures screenshots +
   console errors into test/artifacts/. Exits non-zero on page errors.

   Usage: node test/smoke.mjs [--url http://localhost:3111] (starts `next dev`
   itself when no --url is given). */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const ART = path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });

const argUrl = process.argv.indexOf("--url");
const externalUrl = argUrl > -1 ? process.argv[argUrl + 1] : null;
const PORT = 3111;
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
      process.stdout.write("[next] " + s);
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

const errors = [];
const warnings = [];

async function shot(page, name) {
  await page.screenshot({ path: path.join(ART, name + ".png") });
  console.log("  📸", name);
}

async function main() {
  const dev = await startDev();
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,800",
      "--mute-audio",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    if (t === "error") {
      // ignore benign favicon 404s
      if (txt.includes("favicon")) return;
      errors.push(txt);
      console.log("  ⛔ console.error:", txt.slice(0, 300));
    } else if (t === "warning" && !txt.includes("Download the React DevTools")) {
      warnings.push(txt);
    }
  });
  page.on("pageerror", (e) => {
    errors.push(String(e.message || e));
    console.log("  ⛔ pageerror:", String(e.message || e).slice(0, 400));
  });

  console.log("→ loading", URL);
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 120000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 60000 });
  await sleep(1200);
  await shot(page, "01-menu");

  // garage
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("GARAGE"));
    b?.click();
  });
  await sleep(600);
  await shot(page, "02-garage");
  // pick the kei car then back to kaze, then DONE
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".carCard h3")];
    cards.find((c) => c.textContent.includes("TANUKI"))?.parentElement?.click();
  });
  await sleep(400);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".carCard h3")];
    cards.find((c) => c.textContent.includes("KAZE"))?.parentElement?.click();
    const done = [...document.querySelectorAll("button")].find((x) => x.textContent === "DONE");
    done?.click();
  });
  await sleep(300);

  // drive!
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b?.click();
  });
  await sleep(3500);
  await shot(page, "03-highway-chase");

  const st0 = await page.evaluate(() => window.__neonx.state());
  console.log("  state on deck:", JSON.stringify({ ...st0, errors: undefined }));

  // drive forward on the deck toward an exit
  await page.evaluate(() => {
    window.__neonx.teleport(500 + 6.9, -520, 9, 0, 26);
    window.__neonx.setInput({ th: 1 });
  });
  await sleep(4000);
  await shot(page, "04-exit-approach");

  // NOTE: SwiftShader renders ~4 fps and physics substeps are frame-capped, so
  // sim time runs slower than wall clock — poll for the condition instead of
  // sleeping a fixed interval.
  const waitState = async (cond, timeoutMs, label) => {
    const t0 = Date.now();
    let st;
    for (;;) {
      st = await page.evaluate(() => window.__neonx.state());
      if (cond(st)) return st;
      if (Date.now() - t0 > timeoutMs) {
        errors.push(`${label} timed out: x=${st.x.toFixed(1)} y=${st.y.toFixed(2)} u=${st.u.toFixed(1)}`);
        return st;
      }
      await sleep(400);
    }
  };

  // off-ramp descent: start mid-ramp heading west (downhill), roll into town
  await page.evaluate(() => {
    window.__neonx.teleport(478, 260, 8.4, -Math.PI / 2, 11);
    window.__neonx.setInput({ th: 0.4 });
  });
  const stRamp = await waitState((s) => s.y < 2.5, 30000, "ramp descent");
  console.log("  after descent: y =", stRamp.y.toFixed(2), " x =", stRamp.x.toFixed(1));
  await shot(page, "04b-ramp-descent");

  // on-ramp climb: from the west foot heading east up to the deck
  await page.evaluate(() => {
    window.__neonx.teleport(431, -260, 0.3, Math.PI / 2, 9);
    window.__neonx.setInput({ th: 1 });
  });
  const stClimb = await waitState((s) => s.y > 8.4, 30000, "on-ramp climb");
  console.log("  after climb: y =", stClimb.y.toFixed(2), " x =", stClimb.x.toFixed(1));
  await shot(page, "04c-ramp-climb");

  // town: teleport to origin, drive
  await page.evaluate(() => {
    window.__neonx.setInput(null);
    window.__neonx.teleport(0, 0);
    window.__neonx.game.resetCar();
    window.__neonx.setInput({ th: 0.8 });
  });
  await sleep(4500);
  await shot(page, "05-town-drive");
  const st1 = await page.evaluate(() => window.__neonx.state());
  console.log("  state in town:", JSON.stringify({ ...st1, errors: undefined }));

  // crash test
  await page.evaluate(() => {
    window.__neonx.setInput({ th: 1 });
    window.__neonx.crashTest();
  });
  await sleep(1800);
  await shot(page, "06-crash");
  await sleep(1500);
  const st2 = await page.evaluate(() => window.__neonx.state());
  console.log("  after crash:", JSON.stringify({ ...st2, errors: undefined }));

  // rain + cockpit
  await page.evaluate(() => {
    window.__neonx.setInput({ th: 0.5 });
    window.__neonx.setRain(true);
    window.__neonx.setCam(1);
  });
  await sleep(2000);
  await shot(page, "07-rain-cockpit");

  // hood cam + day time
  await page.evaluate(() => {
    window.__neonx.setRain(false);
    window.__neonx.setCam(2);
    window.__neonx.setTime(13);
  });
  await sleep(1500);
  await shot(page, "08-day-hood");

  // fps estimate
  const f0 = await page.evaluate(() => window.__neonx.state().frames);
  await sleep(3000);
  const f1 = await page.evaluate(() => window.__neonx.state().frames);
  console.log(`  ~fps (swiftshader): ${((f1 - f0) / 3).toFixed(1)}`);

  // pause menu
  await page.keyboard.press("Escape");
  await sleep(500);
  await shot(page, "09-pause");

  await browser.close();
  dev?.kill("SIGTERM");

  console.log("\nwarnings:", warnings.length);
  if (errors.length) {
    console.log("\n❌ ERRORS:");
    for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 500));
    process.exit(1);
  }
  console.log("✅ smoke test passed —", st2.npcs, "npcs,", st2.chunksVisible + "/" + st2.chunksTotal, "chunks visible");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
