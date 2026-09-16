/* In-game captures for the barrier-bounce and hitbox work (NOT committed as a
   fixture — it is a photographer, like test/pov-shot.mjs).

   Everything it needs to show BEFORE is reachable live, so both halves of
   every pair come out of ONE browser session with no rebuild and no HMR:

     - physics.ts's WALL object is on window.__wallBounce, so the old flat
       0.965 scrub / 0.65 yaw / 1.07 reflection can be put back by overwriting
       three methods,
     - SLOPE_PROBE is on window.__slopeProbe, so the nose-down lean bug is one
       boolean,
     - and every NPC's collision half-width is n.cw, so the old mirrors-
       included box is `n.cw = n.W / 2`.

   Usage:
     node test/barrier-hitbox-shots.mjs --url http://localhost:3421 --out /abs/dir
*/
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3421");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts"));
mkdirSync(OUT, { recursive: true });
const VW = Number(process.env.SHOT_W || 1100), VH = Number(process.env.SHOT_H || 690);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: VW, height: VH },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !/favicon|WebSocket/.test(m.text())) errors.push(m.text());
});

console.log("loading…");
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 900000 });
/* The box this runs on is shared with other lanes' browsers, and under
   SwiftShader at load 80+ the client bundle can take many minutes just to
   parse and boot. Poll loudly rather than waiting in silence on a single
   timeout that says nothing about where it got to. */
for (let i = 0; ; i++) {
  const st = await page.evaluate(() => ({
    nx: !!window.__neonx, loaded: !!window.__neonx?.game?.loaded,
    body: document.body?.childElementCount || 0,
  })).catch(() => ({ nx: false, loaded: false, body: -1 }));
  if (st.nx) { console.log(`  __neonx up after ${i * 10}s`); break; }
  if (i % 6 === 0) console.log(`  waiting for __neonx… ${i * 10}s (body ${st.body})`);
  if (i > 180) throw new Error("no __neonx after 30 min");
  await sleep(10000);
}
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"))?.click();
});
for (let i = 0; ; i++) {
  const ok = await page.evaluate(() => !!window.__neonx?.game?.loaded).catch(() => false);
  if (ok) { console.log(`  world built after ${i * 10}s`); break; }
  if (i % 6 === 0) console.log(`  building world… ${i * 10}s`);
  if (i > 180) throw new Error("world never finished loading");
  await sleep(10000);
}
await sleep(3000);
console.log("loaded");

/* Keep the originals so AFTER can be restored exactly rather than retyped. */
await page.evaluate(() => {
  const W = window.__wallBounce;
  window.__orig = {
    rebound: W.rebound, scrub: W.scrub, yawKeep: W.yawKeep,
    cw: window.__neonx.game.traffic.npcs.map((n) => n.cw),
  };
  window.__legacy = (on) => {
    const W = window.__wallBounce, O = window.__orig;
    if (on) {
      W.rebound = (v) => 0.07 * v;      // the old flat `* 1.07`
      W.scrub = () => 0.965;            // the old whole-velocity scale
      W.yawKeep = () => 0.65;           // the old yaw-rate scale
      window.__slopeProbe.guard = false;
      window.__neonx.game.traffic.npcs.forEach((n) => { n.cw = n.W / 2; });
    } else {
      W.rebound = O.rebound; W.scrub = O.scrub; W.yawKeep = O.yawKeep;
      window.__slopeProbe.guard = true;
      window.__neonx.game.traffic.npcs.forEach((n, i) => { n.cw = O.cw[i]; });
    }
  };
  window.__daylight = () => { window.__neonx.setTime(11.5); };
});
// daylight: bodywork gaps are what this shoots, and a night shot hides them
await page.evaluate(() => window.__daylight());
await sleep(500);

const shot = async (name) => {
  await sleep(2200);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log("  shot", name);
};

/* ---------------------------------------------------------------- 1. LEAN
   Jam the car against the east parapet at a big yaw angle — the state where
   the forward slope probe walks off the deck — and look at it from chase,
   where the body is what you see. */
async function leanShot(tag, legacy) {
  await page.evaluate((lg) => {
    window.__legacy(lg);
    const nx = window.__neonx, g = nx.game, cor = g.cor;
    const z = -900;
    const zc = cor.zAt(cor.centerX(z), z);
    const lat = cor.edgeHalf(zc, 1) - 1.0;
    const p = cor.pose ? cor.pose(zc) : null;
    nx.teleport(cor.centerX(zc) + lat, zc, undefined, 1.15, 8);
    nx.setInput({ th: 0.55, st: 1 });
    nx.setCam(0); // chase
    nx.simStep(0.9);
  }, legacy);
  await shot(`lean-${tag}-chase`);
  const st = await page.evaluate(() => {
    const s = window.__neonx.state();
    return { slope: s.slope, pitchDeg: (-Math.atan(s.slope) * 180) / Math.PI, kmh: s.kmh };
  });
  console.log(`  lean ${tag}: slope ${st.slope.toFixed(3)} -> body pitch ${st.pitchDeg.toFixed(1)} deg nose-down`);
  return st;
}

/* ---------------------------------------------------------------- 2. STUCK
   Lean on the same parapet at a shallow angle with the throttle down, for
   three seconds, and read the speed off the HUD. */
async function stuckShot(tag, legacy) {
  const kmh = await page.evaluate((lg) => {
    window.__legacy(lg);
    const nx = window.__neonx, cor = nx.game.cor;
    const z = -900, zc = cor.zAt(cor.centerX(z), z);
    const lat = cor.edgeHalf(zc, 1) - 1.15;
    nx.teleport(cor.centerX(zc) + lat, zc, undefined, 0.10, 120 / 3.6);
    nx.setInput({ th: 1, st: 0.12 });
    nx.setCam(3); // dashcam POV — the default view
    nx.simStep(3.0);
    return window.__neonx.state().kmh;
  }, legacy);
  await shot(`stuck-${tag}-pov`);
  console.log(`  stuck ${tag}: ${kmh.toFixed(1)} km/h after 3 s leaning on the barrier (entered at 120)`);
  return kmh;
}

/* --------------------------------------------------------------- 3. HITBOX
   Park a bus, park the player beside it at the lateral offset where the OLD
   box reported contact, and look at the gap. Then close to where the NEW box
   reports contact — which is where the bodies actually meet. */
async function hitboxShot(tag, gapMode) {
  const info = await page.evaluate((mode) => {
    const nx = window.__neonx, g = nx.game, cor = g.cor;
    window.__legacy(false);
    const bus = g.traffic.npcs.find((n) => n.type === "bus" && n.active)
      || g.traffic.npcs.find((n) => n.type === "bus");
    if (!bus) return null;
    // park the bus in a middle lane on a straight stretch
    const z = -900, zc = cor.zAt(cor.centerX(z), z);
    bus.active = true; bus.wreck = null; bus.fade = 1;
    bus.v = 0; bus.v0 = 0.01; bus.hw = true; bus.route = -1; bus.dir = 1;
    bus.laneK = 1;
    bus.offCur = bus.offT = cor.laneOffset(1, zc);
    bus.s = zc;
    bus.x = cor.centerX(zc) + bus.offCur;
    bus.z = zc;
    bus.y = cor.centerY(zc);
    bus.hVis = 0;
    const hw = g.rig.halfW;
    const old = hw + bus.W / 2;      // where contact fired before
    const now = hw + bus.cw;         // where it fires now
    const d = mode === "old" ? old : now;
    nx.teleport(bus.x + d, bus.z + 0.4, bus.y, 0, 0);
    nx.setInput({ th: 0, st: 0 });
    nx.setCam(0);
    return {
      busW: bus.W, busCw: bus.cw, hw, old, now, d,
      busX: bus.x, busZ: bus.z,
    };
  }, gapMode);
  await shot(`hitbox-${tag}`);
  console.log(`  hitbox ${tag}: centre-to-centre ${info.d.toFixed(3)} m ` +
    `(old box touched at ${info.old.toFixed(3)}, new at ${info.now.toFixed(3)})`);
  return info;
}

const res = {};
console.log("lean:");
res.leanBefore = await leanShot("before", true);
res.leanAfter = await leanShot("after", false);
console.log("stuck:");
res.stuckBefore = await stuckShot("before", true);
res.stuckAfter = await stuckShot("after", false);
console.log("hitbox:");
res.hbOld = await hitboxShot("old-contact", "old");
res.hbNew = await hitboxShot("new-contact", "new");

console.log("\nerrors:", errors.length ? errors.slice(0, 5) : "none");
console.log(JSON.stringify(res, null, 1));
await browser.close();
