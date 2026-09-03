/* Tail-light halo evidence shots: pins the player a fixed gap behind the
   nearest NPC ahead on the open highway at night and captures the rear of
   that car in every shipping camera, running and braking — each frame twice,
   with the lens halos off (`window.__npcHalo` weights 0, the pre-halo look)
   and on (the shipped HALO defaults), so the pair is an exact A/B from one
   browser session.
   Usage: node test/taillight-shots.mjs --url http://localhost:3151 --out DIR
          [--gap 12] [--only pov-run,chase-brake] [--no-ab]
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3151");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts", "taillight"));
const GAP = Number(arg("--gap", 12));
const ONLY = arg("--only", ""); // comma list of shot names to restrict to
const AB = !process.argv.includes("--no-ab");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  dumpio: !!process.env.DUMPIO,
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
await sleep(8000); // HD fleet + props land

await page.evaluate(() => {
  const nx = window.__neonx;
  nx.setTime(22.0);
  nx.toCorridor(-1300, 100, 1);
  nx.setInput({ th: 0.5 });
});
await sleep(4000);

/* Pin: every 40 ms put the player GAP m behind the chosen NPC, on its
   heading, at its speed. The choice is made once (closest active highway
   car ahead, 8..120 m, driving our way), then held. */
/* Traffic is a roll: the lane ahead can be empty at the moment we look, so
   poll for a candidate for a while before giving up. */
let picked = null;
for (let tries = 0; tries < 20 && !picked; tries++) {
  if (tries) await sleep(1500);
  picked = await page.evaluate((GAP) => {
  const nx = window.__neonx, g = nx.game, tr = g.traffic;
  const car = g.car;
  const fx = Math.sin(car.h), fz = Math.cos(car.h);
  let best = null, bd = 1e9;
  for (const n of tr.npcs) {
    if (!n.active || n.wreck || n.rival || n.y < -100) continue;
    const dx = n.x - car.x, dz = n.z - car.z;
    const along = dx * fx + dz * fz;
    const lat = Math.abs(dx * fz - dz * fx);
    if (along < 8 || along > 120 || lat > 6) continue;
    if (Math.cos(n.hVis - car.h) < 0.7) continue;
    if (along < bd) { bd = along; best = n; }
  }
  if (!best) return null;
  const n = best;
  window.__pinNpc = n;
  window.__pinGap = GAP;
  const pin = () => {
    const h = n.hVis;
    const x = n.x - Math.sin(h) * window.__pinGap, z = n.z - Math.cos(h) * window.__pinGap;
    nx.teleport(x, z, undefined, h, n.v);
  };
  window.__pinTimer = setInterval(pin, 40);
  pin();
  return { id: n.id, type: n.type, style: n.style, v: n.v, along: bd };
  }, GAP);
}
console.log("pinned behind", picked);
if (!picked) {
  console.log("no NPC ahead — aborting");
  await browser.close();
  process.exit(2);
}

const setBrake = (on) => page.evaluate((on) => {
  const n = window.__pinNpc;
  if (on) Object.defineProperty(n, "brake", { get: () => true, set() {}, configurable: true });
  else { delete n.brake; n.brake = false; }
}, on);
const setGap = (g) => page.evaluate((g) => { window.__pinGap = g; }, g);
const setHalo = (on) => page.evaluate((on) => {
  window.__npcHalo = on ? undefined : { tailW: 0, brakeW: 0 };
}, on);

const CAMS = { chase: 0, cockpit: 1, hood: 2, pov: 3, console: 4 };
const shots = [
  ["pov-run", "pov", false, GAP],
  ["pov-brake", "pov", true, GAP],
  ["pov-run-far", "pov", false, 35],
  ["pov-run-near", "pov", false, 6],
  ["chase-run", "chase", false, GAP],
  ["chase-brake", "chase", true, GAP],
  ["cockpit-run", "cockpit", false, GAP],
  ["hood-run", "hood", false, GAP],
  ["console-run", "console", false, GAP],
];
const only = ONLY ? ONLY.split(",") : null;
for (const [name, cam, brake, gap] of shots) {
  if (only && !only.includes(name)) continue;
  await setGap(gap);
  await setBrake(brake);
  await page.evaluate((c) => window.__neonx.setCam(c), CAMS[cam]);
  for (const on of AB ? [false, true] : [true]) {
    await setHalo(on);
    await sleep(on && AB ? 900 : 1800);
    const f = path.join(OUT, `${on ? "after" : "before"}-${name}.png`);
    await page.screenshot({ path: f });
    console.log("saved", f);
  }
}
await page.evaluate(() => clearInterval(window.__pinTimer));
await browser.close();
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors.slice(0, 10)) console.log(" -", e.slice(0, 300));
  process.exit(1);
}
console.log("ok");
