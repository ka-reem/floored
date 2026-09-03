/* garage-paint lane photographer: three swatches in the
   garage (real Volvo bodywork card), then dashcam + chase in game.
   Usage: node paint-shots.mjs --url http://localhost:3141 --out DIR */
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3141");
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
  defaultViewport: { width: 1200, height: 750 },
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
await sleep(600);

const jpg = async (name) => {
  await page.screenshot({ path: path.join(OUT, name), type: "jpeg", quality: 80 });
  console.log("saved", name);
};
const click = (text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(t));
    b?.click();
  }, text);

// ---- garage: three swatches ----
await click("GARAGE");
await sleep(1200);
const pick = async (ix, wait) => {
  await page.evaluate((i) => document.querySelectorAll(".paintDot")[i]?.click(), ix);
  await sleep(wait); // pass-two real-bodywork shot lands async
  // the swatch row sits at the panel's bottom; scroll it into the frame
  await page.evaluate(() => {
    const p = document.querySelector(".panel");
    if (p) p.scrollTop = p.scrollHeight;
  });
  await sleep(200);
};
await pick(6, 5000); await jpg("paint-01-garage-silver.jpg");   // Moonlight Silver (new)
await pick(4, 5000); await jpg("paint-02-garage-red.jpg");      // Cherry Red
await pick(0, 5000); await jpg("paint-03-garage-indigo.jpg");   // Midnight Indigo

// leave the garage on Cherry Red so the in-game shots read unmistakably
await pick(4, 3000);
await click("DONE");
await sleep(400);

// ---- drive: dashcam then chase ----
await click("DRIVE");
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(3000); // let the donor body + cabin land and the first frames settle

await page.evaluate(() => {
  const nx = window.__neonx;
  nx.toCorridor(-1300, 100, 1);
  nx.setInput({ th: 0.5 });
  nx.setCam(3); // CAM_POV dashcam — judge here first
});
await sleep(2500);
await jpg("paint-04-dashcam-red.jpg");

await page.evaluate(() => window.__neonx.setCam(0)); // chase: the body itself
await sleep(1200);
await jpg("paint-05-chase-red.jpg");

// swap paint mid-session to prove the live path: silver, chase
await page.evaluate(() => window.__neonx.game.setCar("volvo", 6));
await sleep(9000); // rig rebuild refetches donors (browser-cached) and rewires
await page.evaluate(() => {
  window.__neonx.toCorridor(-1300, 100, 1);
  window.__neonx.setInput({ th: 0.5 });
});
await sleep(1500);
await jpg("paint-06-chase-silver.jpg");

await browser.close();
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors.slice(0, 10)) console.log(" -", e.slice(0, 300));
  process.exit(1);
}
console.log("clean: no page errors");
