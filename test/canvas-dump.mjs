/* Dump the cockpit head-unit's offscreen 256x160 canvas 1:1 (and 3x scaled)
   while driving, to judge the CarPlay UI at source resolution. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = process.env.SHOT_DIR;
mkdirSync(OUT, { recursive: true });
const URL = process.env.SHOT_URL || "http://localhost:3151";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
await page.evaluateOnNewDocument(() => {
  const orig = document.createElement.bind(document);
  window.__cvs = [];
  document.createElement = (tag, ...a) => {
    const el = orig(tag, ...a);
    if (String(tag).toLowerCase() === "canvas") window.__cvs.push(el);
    return el;
  };
});
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await sleep(2500);
const DECK_Z = Number(process.env.SHOT_Z ?? -1300); // e.g. 150 = the corridor curve
await page.evaluate((z) => {
  const c = window.__neonx.game.terrain.corridor;
  const p = c.worldOf(z, c.laneOffset(0, z));
  window.__neonx.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, 25);
  window.__neonx.setCam(1);
  window.__neonx.setInput({ th: 0.5 });
}, DECK_Z);
await sleep(2500);

async function dump(name) {
  const data = await page.evaluate(() => {
    // 256x160 logical space at any integer backing-store scale (cockpit now
    // raises the head unit to 512x320 for sharpness)
    const cvs = window.__cvs.filter((c) =>
      c.width > 0 && c.width % 256 === 0 && c.width / 256 === c.height / 160);
    return cvs.map((cv) => {
      const up = document.createElement("canvas");
      up.width = 256 * 3; up.height = 160 * 3;
      const g = up.getContext("2d");
      g.imageSmoothingEnabled = false;
      g.drawImage(cv, 0, 0, up.width, up.height);
      return { x1: cv.toDataURL("image/png"), x3: up.toDataURL("image/png") };
    });
  });
  if (!data.length) { errors.push("no 256x160 canvases"); return; }
  data.forEach((d, i) => {
    writeFileSync(path.join(OUT, `${name}-c${i}-1x.png`), Buffer.from(d.x1.split(",")[1], "base64"));
    writeFileSync(path.join(OUT, `${name}-c${i}-3x.png`), Buffer.from(d.x3.split(",")[1], "base64"));
  });
  console.log("dumped", name, data.length, "candidates");
}

await dump("screen-t0");
await sleep(8000);
await dump("screen-t8");
// jump into town so the road-graph half of the map shows too
await page.evaluate(() => {
  window.__neonx.teleport(-40, 200, 1, 0, 15);
  window.__neonx.setInput({ th: 0.4 });
});
await sleep(3000);
await dump("screen-town");

await browser.close();
if (errors.length) {
  console.log("ERRORS:"); for (const e of errors) console.log(" -", e.slice(0, 300));
  process.exit(1);
}
console.log("ok");
