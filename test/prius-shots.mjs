/* Prius (Mint hybrid bodyshell) evidence shots: finds an ACTIVE NPC of a
   given style on the open highway, pins the player a fixed gap behind it,
   and photographs it running and braking in the shipping cameras, by day
   and at night — the same frames for the shell that came before it, so the
   pair is a true before/after.

   It is test/taillight-shots.mjs narrowed to one style: that script pins
   behind whatever car happens to be ahead, which for a 0.11-weight style is
   a coin toss, and a before/after has to be the same car in the same frame.

   Two capture-only overrides, neither of which changes the game:
   - the dashcam impact glitch is muted (post.dashcamHit). Pinning teleports
     the player through moving traffic 25x a second, so it collides
     constantly, and an 0.8 s tear-and-chroma burst was landing on top of
     the car we are trying to photograph.
   - `--paint RRGGBB` forces the pinned car's per-instance paint, which is
     how a "does this shell take fleet paint" claim gets shown rather than
     asserted.

   Usage: node test/prius-shots.mjs --url http://localhost:3111 --out DIR
          [--style hybrid] [--gap 11] [--tag after] [--set full|paint]
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3111");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts", "prius"));
const STYLE = arg("--style", "hybrid");
const GAP = Number(arg("--gap", 11));
const TAG = arg("--tag", "after");
const SET = arg("--set", "full");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 590000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("error", (e) => console.log("PAGE CRASHED:", String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket") && !m.text().includes("ERR_TUNNEL"))
    errors.push(m.text());
});
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(9000); // the HD fleet swaps in after the first drivable frame

await page.evaluate(() => {
  const g = window.__neonx.game;
  g.post.dashcamHit = () => {}; // capture-only, see the header
  window.__neonx.toCorridor(-1300, 100, 1);
  window.__neonx.setInput({ th: 0.5 });
});
await sleep(3000);

/* Pin the player behind one chosen NPC of STYLE, at its heading and speed.
   Unlike the general tail-light shooter this teleports to the car wherever
   it is: the style is a 1-in-9 roll, and waiting for one to land in the
   lane ahead by chance wastes a headless session. */
const pin = async () => page.evaluate(({ STYLE, GAP }) => {
  const nx = window.__neonx, tr = nx.game.traffic;
  const cands = tr.npcs.filter((n) => n.active && !n.wreck && !n.rival && n.type === STYLE && n.y > -100);
  if (!cands.length) return null;
  const n = cands[0];
  window.__pinNpc = n;
  window.__pinGap = GAP;
  window.__pinPaint = null;
  const put = () => {
    const h = n.hVis;
    nx.teleport(n.x - Math.sin(h) * window.__pinGap, n.z - Math.cos(h) * window.__pinGap, undefined, h, n.v);
    const p = window.__pinPaint;
    if (p) { n.cr = p[0]; n.cg = p[1]; n.cb = p[2]; }
  };
  window.__pinTimer = setInterval(put, 40);
  put();
  return { id: n.id, type: n.type, style: n.style, v: n.v, paint: [n.cr, n.cg, n.cb] };
}, { STYLE, GAP });

const setTime = (t) => page.evaluate((t) => window.__neonx.setTime(t), t);
/* Pin the brake flag in BOTH directions. Handing it back to the sim is not a
   "running lights" frame: the pinned car is in traffic and brakes for the car
   ahead of IT, so half the run frames came back with the brake lamps lit and
   the pair proved nothing. */
const setBrake = (on) => page.evaluate((on) => {
  Object.defineProperty(window.__pinNpc, "brake", { get: () => on, set() {}, configurable: true });
}, on);
const setGap = (g) => page.evaluate((g) => { window.__pinGap = g; }, g);
/* n.cr/cg/cb hold the NPC_COLORS entry exactly as Color.setHex stored it —
   measured off a pinned car: 0.353/0.122/0.149 is 0x5a1f26 / 255, so the
   fleet is not going through a linear conversion and neither does this. */
const setPaint = (hex) => page.evaluate((hex) => {
  window.__pinPaint = hex === null ? null
    : [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}, hex);
const CAMS = { chase: 0, cockpit: 1, hood: 2, pov: 3, console: 4 };

let picked = null;
for (let t = 0; t < 25 && !picked; t++) {
  if (t) await sleep(1500);
  picked = await pin();
}
if (!picked) {
  console.log(`no active ${STYLE} NPC — aborting`);
  await browser.close();
  process.exit(2);
}
console.log("pinned behind", picked);

/* name, camera, brake, gap, hour, paint override */
/* Every A/B frame forces the same silver, so before and after differ in the
   BODYSHELL and nothing else — the pinned car is whichever hybrid the traffic
   roll produced, and it would otherwise be a different colour in each run. */
const AB = 0xd8dde6;
const FULL = [
  ["day-pov", "pov", false, 14, 16.0, AB],
  ["day-pov-near", "pov", false, 8, 16.0, AB],
  ["day-chase", "chase", false, 14, 16.0, AB],
  ["night-pov-run", "pov", false, 14, 22.0, AB],
  ["night-pov-brake", "pov", true, 14, 22.0, AB],
  ["night-pov-near-run", "pov", false, 8, 22.0, AB],
  ["night-pov-near-brake", "pov", true, 8, 22.0, AB],
  ["night-chase-run", "chase", false, 14, 22.0, AB],
  ["night-chase-brake", "chase", true, 14, 22.0, AB],
  ["night-hood-run", "hood", false, 14, 22.0, AB],
  ["night-hood-brake", "hood", true, 14, 22.0, AB],
  ["night-cockpit-run", "cockpit", false, 14, 22.0, AB],
  ["night-console-run", "console", false, 14, 22.0, AB],
];
const PAINT = [
  ["paint-silver", "pov", false, 10, 16.0, 0xd8dde6],
  ["paint-red", "pov", false, 10, 16.0, 0x83202c],
  ["paint-blue", "pov", false, 10, 16.0, 0x1d2f52],
  ["paint-black", "pov", false, 10, 16.0, 0x14161c],
  ["paint-red-night", "pov", false, 10, 22.0, 0x83202c],
];
const shots = SET === "paint" ? PAINT : FULL;

const report = [];
for (const [name, cam, brake, gap, hour, paint] of shots) {
  await setTime(hour);
  await setGap(gap);
  await setBrake(brake);
  await setPaint(paint);
  await page.evaluate((c) => window.__neonx.setCam(c), CAMS[cam]);
  await sleep(2200);
  const f = path.join(OUT, `${TAG}-${name}.png`);
  await page.screenshot({ path: f });
  const m = await page.evaluate(() => {
    const n = window.__pinNpc, g = window.__neonx.game;
    const dx = n.x - g.car.x, dz = n.z - g.car.z;
    const surf = g.world.routes?.surfaceAt(n.x, n.z, 2);
    return {
      gap: Math.hypot(dx, dz),
      dHead: Math.atan2(Math.sin(n.hVis - g.car.h), Math.cos(n.hVis - g.car.h)),
      npcY: n.y, roadY: surf ? surf.y : null,
      lampX: n.lampLvl ? n.lampLvl[0] : null, lampY: n.lampLvl ? n.lampLvl[1] : null,
      brake: !!n.brake, kmh: n.v * 3.6,
    };
  });
  report.push({ name, ...m });
  console.log("saved", f, JSON.stringify(m));
}
const measured = await page.evaluate(() => {
  const n = window.__pinNpc, g = window.__neonx.game;
  const dims = g.traffic.npcs.find((m) => m.id === n.id);
  return {
    style: n.type, L: dims.L, W: dims.W, H: dims.H,
    paintInstance: [n.cr, n.cg, n.cb],
    activeOfStyle: g.traffic.npcs.filter((m) => m.active && m.type === n.type).length,
    errorsSeen: g.debug.errors,
  };
});
console.log("MEASURED", JSON.stringify({ measured, report }, null, 2));
await page.evaluate(() => clearInterval(window.__pinTimer));
await browser.close();
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors.slice(0, 10)) console.log(" -", e.slice(0, 300));
  process.exit(1);
}
console.log("ok");
