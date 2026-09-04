/* CHASE-camera photographer for the handbrake drift (NOT a regression test):
   boots the game, drops the car on a straight at speed, pulls the lever with
   the throttle still on, and grabs a frame every 0.5 s through the slide.
   The frames are stitched into one strip so the angle is visible at a glance.

   Usage:
     npx next dev --webpack -p 3152        (in the worktree, backgrounded)
     node test/handbrake-drift-shots.mjs --url http://localhost:3152 --out /abs/dir
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import sharp from "sharp";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3152");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts"));
const TAG = arg("--tag", "drift");
mkdirSync(OUT, { recursive: true });

const VW = Number(process.env.SHOT_W || 900), VH = Number(process.env.SHOT_H || 560);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(2500);

/* Daylight, so the angle of the car reads in the frame rather than a pair of
   tail lights. The clock is the game's own, exposed on the engine. */
await page.evaluate(() => window.__neonx.setTime(13.2));

async function shoot(name, script) {
  await page.evaluate(() => { window.__neonx.setInput(null); });
  await page.evaluate(() => window.__neonx.toCorridor(-1250, 95, 1));
  await page.evaluate(() => window.__neonx.setCam(0)); // CAM_CHASE
  await page.evaluate(() => window.__neonx.setInput({ th: 0.8, br: 0, st: 0, hb: 0, horn: 0 }));
  await sleep(1400);
  const frames = [];
  for (const [i, step] of script.entries()) {
    await page.evaluate((s) => window.__neonx.setInput(s), step.in);
    await sleep(step.ms);
    const p = path.join(OUT, `${TAG}-${name}-${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path: p });
    frames.push({ p, label: step.label });
    const st = await page.evaluate(() => {
      const c = window.__neonx.game.car;
      return { beta: (Math.atan2(c.v, Math.max(Math.abs(c.u), 4)) * 180) / Math.PI,
               kmh: Math.hypot(c.u, c.v) * 3.6 };
    });
    console.log(`  ${name} ${String(i).padStart(2, "0")} ${step.label}  ` +
                `sideslip ${st.beta.toFixed(1)} deg  ${st.kmh.toFixed(0)} km/h`);
  }
  await page.evaluate(() => window.__neonx.setInput(null));
  return frames;
}

/* Turn in, then pull the lever with the throttle still down — the manoeuvre
   the whole change is about. Each entry is held for `ms` and then shot. */
const PULL = [
  { in: { th: 0.8, st: 0.55, hb: 0 }, ms: 700, label: "turn in" },
  { in: { th: 0.8, st: 0.55, hb: 1 }, ms: 450, label: "lever up" },
  { in: { th: 0.9, st: 0.2, hb: 1 }, ms: 450, label: "on the power" },
  { in: { th: 0.9, st: -0.5, hb: 1 }, ms: 450, label: "counter-steer" },
  { in: { th: 0.9, st: -0.5, hb: 1 }, ms: 450, label: "holding it" },
  { in: { th: 0.85, st: -0.35, hb: 0 }, ms: 500, label: "lever down" },
  { in: { th: 0.85, st: 0, hb: 0 }, ms: 700, label: "settled" },
];

const frames = await shoot("chase", PULL);
await browser.close();

/* Stitch into one strip: two rows, labelled. */
const COLS = 4, SW = 440, SH = Math.round((VH / VW) * SW);
const rows = Math.ceil(frames.length / COLS);
const GAP = 6, LBL = 22;
const W = COLS * SW + (COLS + 1) * GAP;
const H = rows * (SH + LBL) + (rows + 1) * GAP;
const tiles = [];
for (const [i, fr] of frames.entries()) {
  const cx = GAP + (i % COLS) * (SW + GAP);
  const cy = GAP + Math.floor(i / COLS) * (SH + LBL + GAP);
  tiles.push({ input: await sharp(fr.p).resize(SW, SH).png().toBuffer(), left: cx, top: cy });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${LBL}">` +
    `<rect width="${SW}" height="${LBL}" fill="#12141a"/>` +
    `<text x="6" y="15" font-family="DejaVu Sans,sans-serif" font-size="12" fill="#f7b32b">` +
    `${i + 1}. ${fr.label}</text></svg>`;
  tiles.push({ input: Buffer.from(svg), left: cx, top: cy + SH });
}
const stripPath = path.join(OUT, `${TAG}-chase-strip.png`);
await sharp({ create: { width: W, height: H, channels: 3, background: "#12141a" } })
  .composite(tiles).png().toFile(stripPath);
console.log("wrote " + stripPath);
if (errors.length) { console.log("ERRORS:"); errors.slice(0, 6).forEach((e) => console.log(" -", e.slice(0, 200))); }
