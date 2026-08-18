/* Lane J POV framing photographer (NOT committed): boots the game, parks on
   the open highway at night, and captures one DASHCAM (POV) shot and one
   COCKPIT shot. Usage:
     node test/pov-shot.mjs --url http://localhost:3141 --out /abs/dir --tag iter1
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3141");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts"));
const TAG = arg("--tag", "shot");
mkdirSync(OUT, { recursive: true });

const VW = Number(process.env.SHOT_W || 1280), VH = Number(process.env.SHOT_H || 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

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

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await sleep(2500);

// straight open two-lane stretch, cruising, night (game starts at 21.4h)
await page.evaluate(() => {
  const nx = window.__neonx;
  nx.toCorridor(-1300, 100, 1);
  nx.setInput({ th: 0.5 });
  nx.setCam(3); // CAM_POV dashcam
});
await sleep(2200);
await page.screenshot({ path: path.join(OUT, `${TAG}-pov.png`) });
console.log("saved", `${TAG}-pov.png`);

await page.evaluate(() => window.__neonx.setCam(1)); // cockpit
await sleep(700);
await page.screenshot({ path: path.join(OUT, `${TAG}-cockpit.png`) });
console.log("saved", `${TAG}-cockpit.png`);

await browser.close();
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors.slice(0, 10)) console.log(" -", e.slice(0, 300));
  process.exit(1);
}
console.log("ok");
