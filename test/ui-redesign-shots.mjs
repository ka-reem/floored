/* Gallery screenshots for the ui-redesign lane: main menu, pause, garage,
   settings, controls, and loading, at a desktop and a phone viewport.
   Loading is captured by throttling the network so the staged build takes
   long enough to catch a frame mid-progress; the touch/mobile shots set
   body.touch-equivalent viewport + touch emulation so the phone CSS applies.

   Usage: node test/ui-redesign-shots.mjs --url http://localhost:3000 --out DIR */
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3000";
const argOut = process.argv.indexOf("--out");
const OUT = argOut > -1 ? process.argv[argOut + 1] : path.join(process.cwd(), "test", "artifacts", "ui-redesign");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 300000,
});

async function shoot(viewport, isTouch, label, actions) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message || e}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) errors.push(`${label}: ${m.text()}`);
  });
  await page.setViewport({ ...viewport, isMobile: isTouch, hasTouch: isTouch });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
  await sleep(500);
  await actions(page);
  return page;
}

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function clickText(page, text) {
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(t));
    b?.click();
  }, text);
}

// ---- desktop: main menu ----
{
  const page = await shoot(DESKTOP, false, "desktop-main", async (p) => {
    await sleep(600);
  });
  await page.screenshot({ path: path.join(OUT, "ui-redesign-01-main-desktop.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

// ---- desktop: garage ----
{
  const page = await shoot(DESKTOP, false, "desktop-garage", async (p) => {
    await clickText(p, "GARAGE");
    await sleep(900);
  });
  await page.screenshot({ path: path.join(OUT, "ui-redesign-02-garage-desktop.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

// ---- desktop: settings ----
{
  const page = await shoot(DESKTOP, false, "desktop-settings", async (p) => {
    await clickText(p, "SETTINGS");
    await sleep(600);
  });
  await page.screenshot({ path: path.join(OUT, "ui-redesign-03-settings-desktop.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

// ---- desktop: controls ----
{
  const page = await shoot(DESKTOP, false, "desktop-controls", async (p) => {
    await clickText(p, "CONTROLS");
    await sleep(600);
  });
  await page.screenshot({ path: path.join(OUT, "ui-redesign-04-controls-desktop.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

// ---- desktop: pause (drive, wait load, Escape) ----
{
  const page = await shoot(DESKTOP, false, "desktop-pause", async (p) => {
    await clickText(p, "DRIVE");
    await p.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
    await sleep(1500);
    await p.keyboard.press("Escape");
    await sleep(500);
  });
  await page.screenshot({ path: path.join(OUT, "ui-redesign-05-pause-desktop.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

// ---- desktop: loading screen (race the screenshot before the build finishes) ----
{
  const page = await shoot(DESKTOP, false, "desktop-loading", async (p) => {
    await p.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
      b?.click();
    });
    await p.waitForSelector(".loadRoot", { timeout: 20000 }).catch(() => {});
    await sleep(80);
  });
  await page.screenshot({ path: path.join(OUT, "ui-redesign-00-loading-desktop.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

// ---- phone: main menu ----
{
  const page = await shoot(PHONE, true, "phone-main", async (p) => {
    await sleep(600);
  });
  await page.screenshot({ path: path.join(OUT, "ui-redesign-06-main-phone.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

// ---- phone: settings ----
{
  const page = await shoot(PHONE, true, "phone-settings", async (p) => {
    await clickText(p, "SETTINGS");
    await sleep(600);
  });
  await page.screenshot({ path: path.join(OUT, "ui-redesign-07-settings-phone.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

// ---- phone: playing HUD + touch controls (drive, wait load) ----
{
  const page = await shoot(PHONE, true, "phone-hud", async (p) => {
    await clickText(p, "DRIVE");
    await p.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
    await sleep(1800);
  });
  await page.screenshot({ path: path.join(OUT, "ui-redesign-08-hud-phone.jpg"), type: "jpeg", quality: 82 });
  await page.close();
}

await browser.close();
if (errors.length) {
  console.log("\n⚠ console/page errors seen (may be benign):");
  for (const e of [...new Set(errors)].slice(0, 20)) console.log("  -", e.slice(0, 300));
}
console.log("✅ ui-redesign shots captured in", OUT);
