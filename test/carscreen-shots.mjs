/* Lane G2 verification: cockpit-camera screenshots of the CarPlay-style head
   unit. Parks the car on the deck / in town, switches to CAM_COCKPIT (1),
   lets it drive, and captures full frames plus a zoomed clip of the centre
   stack. Based on test/corridor-shots.mjs. */

import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const OUT = process.env.SHOT_DIR || path.join(process.cwd(), "test", "artifacts", "carscreen");
mkdirSync(OUT, { recursive: true });
const URL = process.env.SHOT_URL || "http://localhost:3151";
const VW = 1280, VH = 800;

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
await sleep(3000);

/* The screen canvas sits mid-frame in the cockpit view; clip generously
   around the centre stack so the whole head unit is visible zoomed. */
const CLIP = { x: 800, y: 610, width: 360, height: 190 };

const stations = [
  [-1300, 0, "g2-01-deck", 12000],   // long run: map should pan + progress advance
  [150, 1, "g2-02-curve", 4000],     // curve: heading-up rotation visible
  [1330, 2, "g2-03-toll", 4000],     // toll fan-out on the map
];

for (const [z, lane, name, driveMs] of stations) {
  await page.evaluate(
    ({ z, lane }) => {
      const c = window.__neonx.game.terrain.corridor;
      const n = c.lanes(z);
      const k = Math.min(n - 1, Math.max(0, lane < 0 ? n + lane : lane));
      const p = c.worldOf(z, c.laneOffset(k, z));
      window.__neonx.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, 25);
      window.__neonx.setCam(1); // COCKPIT
      window.__neonx.setInput({ th: 0.5 });
    },
    { z, lane }
  );
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, name + "-a.png") });
  await page.screenshot({ path: path.join(OUT, name + "-a-zoom.png"), clip: CLIP });
  await sleep(driveMs);
  await page.screenshot({ path: path.join(OUT, name + "-b.png") });
  await page.screenshot({ path: path.join(OUT, name + "-b-zoom.png"), clip: CLIP });
  console.log("captured", name);
}

/* Also dump the raw 256x160 screen canvas at 1:1 for legibility judging —
   grab the cockpit's screen canvas via the texture-owning mesh is awkward,
   so re-render: find any 256x160 canvas in the DOM? It's offscreen; instead
   zoom shots above are the judge. */

await browser.close();
if (errors.length) {
  console.log("\nERRORS:");
  for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 300));
  process.exit(1);
}
console.log("done ->", OUT);
