/* Orbit photographer — the car from angles the game never shows you.

   hero-shots.mjs captures the DRIVING cameras, and they all share a problem for
   content: every one of them looks down the road from behind or inside the car,
   so six of them side by side read as the same picture. The owner said exactly
   that: "notice how all 6 of the car photos are the same".

   Photo mode (the O key) is the fix. It parks the sim, hides every scrap of HUD
   and hands over a free orbit rig — drag to swing, wheel to zoom. That gives the
   low front three-quarter, the flat side profile and the high rear that a
   driving camera physically cannot reach, and those are the frames that look
   like a car advert rather than a screenshot.

   Angles are driven through window.__photoTune rather than synthesised mouse
   drags: a drag is relative and lands somewhere different depending on where the
   auto-orbit had drifted to, which is how you get fourteen frames that are all
   slightly wrong. Setting yaw/pitch/dist directly is repeatable.

   Usage: node test/hero-orbit.mjs --url http://localhost:3490 [--tag orbit]
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("url", "http://localhost:3490");
const TAG = arg("tag", "orbit");
const OUT = arg("out", path.join(process.cwd(), "test", "artifacts", "hero"));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* [name, z on the corridor, lane, hour, yaw (rad off heading), pitch, dist] */
const SHOTS = [
  ["low-front",     -300, 0, 21.5,  2.55, -0.04,  5.2],
  ["side-profile",  -300, 0, 21.5,  1.57,  0.10,  7.4],
  ["high-rear",     -300, 0, 21.5,  0.30,  0.85,  8.6],
  ["drone-top",     -300, 0, 21.5,  1.10,  1.18, 12.0],
  ["drone-sweep",   -700, 0, 23.0,  2.05,  0.55, 10.5],
  ["low-rear",      -700, 0, 23.0,  0.35, -0.05,  4.4],
  ["toll-side",     1385, 1, 20.5,  1.20,  0.16,  8.0],
  ["toll-drone",    1385, 1, 20.5,  0.80,  0.95, 11.5],
  ["tunnel-side",    700, 0, 22.0,  1.45,  0.12,  7.0],
  ["mtn-low",      -1880, 0, 17.0,  2.30, -0.02,  5.6],
  ["mtn-drone",    -1880, 0, 17.0,  1.60,  1.05, 12.5],
  ["dawn-side",      200, -1, 5.2,  1.62,  0.14,  7.8],
  ["dawn-low",       200, -1, 5.2,  2.75, -0.05,  5.0],
  ["city-hi",       -300, 0, 21.5,  2.10,  1.00, 11.0],
];

const browser = await puppeteer.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 2 },
  protocolTimeout: 0,
  timeout: 180000,
});
const page = await browser.newPage();
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });

await page.evaluate(() => {
  const raw = localStorage.getItem("neonx.profile.v3");
  const p = raw ? JSON.parse(raw) : { settings: {} };
  p.settings = p.settings || {};
  Object.assign(p.settings, {
    preset: "high", tierOverride: "desktop",
    reflections: true, shadows: true, bloom: true, fxaa: true, traffic: 0.85,
  });
  localStorage.setItem("neonx.profile.v3", JSON.stringify(p));
});
await page.reload({ waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 2400000 });
await sleep(12000);

for (const [name, z, lane, hour, yaw, pitch, dist] of SHOTS) {
  /* Leave photo mode before moving — the rig aims at where the car WAS.
     Toggling blind is what produced five cockpit frames in the first run: if
     the state was already off, the "exit" press ENTERED it, and the later
     "enter" press left it. So every transition below asserts the state it
     wanted and presses again only if it did not get it. */
  const setPhoto = async (want) => {
    for (let t = 0; t < 3; t++) {
      const on = await page.evaluate(() => !!window.__neonx.state().photo);
      if (on === want) return true;
      await page.keyboard.press("o");
      await sleep(900);
    }
    return (await page.evaluate(() => !!window.__neonx.state().photo)) === want;
  };
  await setPhoto(false);
  await page.evaluate((h) => window.__neonx.setTime(h), hour);
  await page.evaluate(({ z, lane }) => {
    const c = window.__neonx.game.terrain.corridor;
    const n = c.lanes(z);
    const k = Math.min(n - 1, Math.max(0, lane < 0 ? n + lane : lane));
    const p = c.worldOf(z, c.laneOffset(k, z));
    window.__neonx.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, 30);
    window.__neonx.setInput({ th: 0.4 });
  }, { z, lane });
  await sleep(3000);

  const entered = await setPhoto(true);
  await sleep(900);
  /* the mode's own on-screen banner is chrome, not the game */
  await page.addStyleTag({ content: `.photoHint, .photoBanner, [class*="photoHint"], [class*="photo-hint"] { opacity: 0 !important; }` });
  const ok = entered && await page.evaluate(({ yaw, pitch, dist }) => {
    /* engine.ts photoEnter(): `this.photo` IS the live rig — {on, yaw, pitch,
       dist, auto}. yaw is ABSOLUTE (it opens at car.h + PHOTO.yaw0), so the
       offset in the table is added to the car's heading here. auto=false stops
       the self-orbit, which is what makes the frame repeatable. */
    const g = window.__neonx.game;
    const ph = g?.photo;
    if (!ph || !ph.on) return false;
    ph.auto = false;
    ph.yaw = g.car.h + yaw;
    ph.pitch = pitch;
    ph.dist = dist;
    return true;
  }, { yaw, pitch, dist });
  await sleep(4500);
  const f = path.join(OUT, `${TAG}-${name}.png`);
  await page.screenshot({ path: f });
  console.log("  📸", path.basename(f), ok ? "" : "(rig not reachable — auto-orbit angle)");
}
await browser.close();
console.log("✅ done —", SHOTS.length, "orbit frames in", OUT);
