/* Library photographer — MANY different frames, not fourteen of the same one.

   hero-shots.mjs (driving cams) and hero-orbit.mjs (photo-mode rig) each carry
   a fixed table and each produce one look: one car, one paint, one traffic
   level, a handful of stations. The owner's verdict on that batch was "notice
   how all 6 of the car photos are the same", and the brief that followed was
   "diff car angles, angles of the city, different spots, diff cars, whole
   bunch of content, make it vary a lot".

   So this one takes its SHOT LIST FROM A FILE and its car/paint/traffic from
   the command line, and one browser session shoots one batch. Everything the
   two older harnesses learned is kept:
     - HIGH preset + DESKTOP tier forced through the profile BEFORE DRIVE;
     - 2x DPR, 1600x900;
     - every scrap of DOM chrome hidden (the topbar clock and the photo-mode
       banner both leaked in the first batch — this walks up from the canvas
       and hides every sibling on the way, so a new overlay cannot leak either);
     - photo-mode transitions ASSERT the state they wanted (hero-orbit.mjs);
     - the orbit rig is driven directly (game.photo yaw/pitch/dist, auto=false).

   New here:
     - --car volvo|kaze and --paint N write the profile's carId/paintIx. The
       kaze id needs the settings.ts one-time "volvodefault" flag stamped first,
       or loadProfile() migrates it straight back to the Volvo (that flag is
       stamped on the first load anyway; setting it explicitly makes the intent
       visible and the harness independent of load order).
     - placements beyond the corridor: the bypass viaduct (toBypass s), the
       mountain pass (toMountain s), the town on-ramp (terrain.ramps, as
       onramp-shots.mjs does), and "near an NPC of type X" for the traffic
       moments — a bus alongside is found, not waited for.
     - rain through the debug hook (setRain), and a per-shot hour.

   Shot file: JSON array of
     { name, at: {z, lane} | {bypass, lane} | {mtn} | {ramp} | {near:"bus", dz, dl},
       hour, rain?, kmh?, th?, wait?, cam?: 0..4, orbit?: [yaw, pitch, dist] }
   yaw is an offset from the car's heading: 0 = camera BEHIND the car (rear
   view), PI = in front, ±PI/2 = flat side, ±2.5 = front three-quarter.

   Usage:
     node test/hero-library.mjs --url http://localhost:3520 --shots batch.json \
          --car kaze --paint 4 --traffic 1 --tag lib --out <dir>
*/
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("url", "http://localhost:3520");
const TAG = arg("tag", "lib");
const CAR = arg("car", "volvo");
const PAINT = Number(arg("paint", "0"));
const TRAFFIC = Number(arg("traffic", "0.85"));
const OUT = arg("out", path.join(process.cwd(), "test", "artifacts", "hero"));
const SHOTS_FILE = arg("shots", "");
const ONLY = arg("only", "");
/* --resume skips shots whose frame already exists — a browser session on this
   box can die under another lane's pkill, and a re-run should not pay for
   the frames it already has. */
const RESUME = process.argv.includes("--resume");
if (!SHOTS_FILE) {
  console.error("need --shots <file.json>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shots = JSON.parse(readFileSync(SHOTS_FILE, "utf8"));
if (ONLY) shots = shots.filter((s) => ONLY.split(",").includes(s.name));
if (RESUME) {
  const before = shots.length;
  shots = shots.filter((s) => !existsSync(path.join(OUT, `${TAG}-${s.name}${s.cam !== undefined && s.orbit ? "-orbit" : ""}.png`)));
  console.log(`resume: ${before - shots.length} already shot, ${shots.length} to go`);
}
if (!shots.length) process.exit(0);

const errors = [];
let browser;
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    browser = await puppeteer.launch({
      executablePath: "/opt/pw-browsers/chromium",
      args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
      defaultViewport: { width: 800, height: 450, deviceScaleFactor: 2 },
      protocolTimeout: 0,
      timeout: 180000,
    });
    break;
  } catch (e) {
    console.log("chromium launch failed, retrying:", String(e).slice(0, 120));
    await sleep(3000);
  }
}
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });

await page.evaluate(({ car, paint, traffic }) => {
  const KEY = "neonx.profile.v3";
  /* settings.ts loadProfile(): without this stamp a stored carId of "kaze" is
     read as a pre-garage profile and moved to the Volvo. */
  localStorage.setItem(KEY + ".volvodefault", "1");
  const raw = localStorage.getItem(KEY);
  const p = raw ? JSON.parse(raw) : { settings: {} };
  p.settings = p.settings || {};
  Object.assign(p.settings, {
    preset: "high", tierOverride: "desktop",
    reflections: true, shadows: true, bloom: true, fxaa: true, traffic,
  });
  p.carId = car;
  p.paintIx = paint;
  localStorage.setItem(KEY, JSON.stringify(p));
}, { car: CAR, paint: PAINT, traffic: TRAFFIC });
await page.reload({ waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });

await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 2400000 });
await waitFrames(20);
console.log("loaded at", stamp());

const info = await page.evaluate(() => ({
  tier: window.__neonx.game.renderTier,
  car: window.__neonx.game.carId,
  paint: window.__neonx.game.settings?.paintIx,
}));
console.log("render tier:", info.tier, "car:", info.car, "paint:", PAINT);
if (info.car !== CAR) errors.push(`asked for car ${CAR}, game has ${info.car}`);

/* Hide the chrome: every sibling of every ancestor of the canvas, plus the
   photo-mode banner by id (it mounts later, on entering the mode). Re-run
   before every frame because screens re-mount their overlays. */
const hideChrome = () =>
  page.evaluate(() => {
    let el = document.querySelector("canvas");
    while (el && el !== document.body) {
      const par = el.parentElement;
      if (!par) break;
      for (const sib of par.children) {
        if (sib !== el) sib.style.setProperty("opacity", "0", "important");
      }
      el = par;
    }
    for (const id of ["photoHint", "topbar", "hud"]) {
      const e = document.getElementById(id);
      if (e) e.style.setProperty("opacity", "0", "important");
    }
  });
await page.addStyleTag({
  content: `#photoHint, #topbar, #hud, .toast, [class*="toast"] { opacity: 0 !important; }`,
});
await page.evaluate(() => { try { window.__neonx.game.grade = false; } catch {} });

/* Wait for N RENDERED frames rather than N seconds: on this box a frame can
   take anything from 0.3 s to 20 s depending on what the other lanes are
   rendering, and a wall-clock sleep either starves the chase spring or burns
   minutes per shot. game.debug.frames is the loop's own counter. */
const frames = () => page.evaluate(() => window.__neonx.state().frames);
const waitFrames = async (n, maxMs = 240000) => {
  const f0 = await frames();
  /* SwiftShader cost is per pixel, and nothing about the settle (chase spring,
   streetlight pools, the orbit rig) needs the shot's resolution — so the
   session lives at a quarter of the pixels and the viewport is grown to the
   real 3200x1800 for two frames around each screenshot. engine.ts onResize
   re-sizes the renderer and rebuilds the post targets on the resize event. */
const big = async () => { await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 }); await waitFrames(2, 120000); };
const small = async () => { await page.setViewport({ width: 800, height: 450, deviceScaleFactor: 2 }); await waitFrames(1, 60000); };
const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(400);
    if ((await frames()) - f0 >= n) return Date.now() - t0;
  }
  return -1;
};
/* SwiftShader cost is per pixel, and nothing about the settle (chase spring,
   streetlight pools, the orbit rig) needs the shot's resolution — so the
   session lives at a quarter of the pixels and the viewport is grown to the
   real 3200x1800 for two frames around each screenshot. engine.ts onResize
   re-sizes the renderer and rebuilds the post targets on the resize event. */
const big = async () => { await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 }); await waitFrames(2, 120000); };
const small = async () => { await page.setViewport({ width: 800, height: 450, deviceScaleFactor: 2 }); await waitFrames(1, 60000); };
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";

const setPhoto = async (want) => {
  for (let t = 0; t < 3; t++) {
    const on = await page.evaluate(() => !!window.__neonx.state().photo);
    if (on === want) return true;
    await page.keyboard.press("o");
    await waitFrames(2, 60000);
  }
  return (await page.evaluate(() => !!window.__neonx.state().photo)) === want;
};

const place = (at, kmh) =>
  page.evaluate(({ at, kmh }) => {
    const g = window.__neonx;
    const game = g.game;
    if (at.bypass !== undefined) { g.toBypass(at.bypass, kmh, at.lane || 0); return "bypass"; }
    if (at.mtn !== undefined) { g.toMountain(at.mtn, kmh, 0); return "mtn"; }
    if (at.ramp !== undefined) {
      const r = game.terrain.ramps.find((q) => q.kind === (at.kind || "entry"));
      let bi = 0, bd = 1e9;
      for (let i = 0; i < r.pts.length; i++) {
        const d = Math.abs(r.pts[i].s - at.ramp);
        if (d < bd) { bd = d; bi = i; }
      }
      const p = r.pts[bi];
      g.teleport(p.x, p.z, p.y + 0.2, Math.atan2(-p.tx, -p.tz), kmh / 3.6);
      return "ramp";
    }
    const c = game.terrain.corridor;
    let z = at.z, lane = at.lane || 0;
    if (at.near) {
      /* the traffic moment: park next to (dl lanes over, dz metres along) an
         NPC of the wanted type, preferring the one closest to at.z */
      const cands = game.traffic.npcs.filter((n) =>
        n.active && n.type === at.near && n.route === -1 && (n.s !== undefined));
      if (!cands.length) return "no-" + at.near;
      cands.sort((a, b) => Math.abs(a.s - at.z) - Math.abs(b.s - at.z));
      const n = cands[0];
      z = c.wrapZ(n.s + (at.dz || -10));
      lane = n.laneK + (at.dl || 1);
    }
    const nl = c.lanes(z);
    const k = Math.min(nl - 1, Math.max(0, lane < 0 ? nl + lane : lane));
    const p = c.worldOf(z, c.laneOffset(k, z));
    g.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, kmh / 3.6);
    return at.near ? `near ${at.near} z=${z.toFixed(0)} lane=${k}` : "cor";
  }, { at, kmh });

const log = [];
for (const s of shots) {
  const kmh = s.kmh ?? 110;
  await setPhoto(false);
  await page.evaluate(({ h, rain }) => {
    window.__neonx.setTime(h);
    window.__neonx.setRain(!!rain);
  }, { h: s.hour ?? 21.5, rain: s.rain });
  const where = await place(s.at, kmh);
  await page.evaluate((th) => window.__neonx.setInput({ th }), s.th ?? 0.5);
  if (s.cam !== undefined) {
    await page.evaluate((c) => window.__neonx.setCam(c), s.cam);
    await waitFrames(s.wait ?? 10);
    await hideChrome();
    await big();
    const f = path.join(OUT, `${TAG}-${s.name}.png`);
    await page.screenshot({ path: f });
    await small();
    log.push({ name: path.basename(f), where, spec: s, car: CAR, paint: PAINT });
    console.log("  📸", path.basename(f), where, stamp());
  }
  if (s.orbit) {
    await waitFrames(s.pre ?? 3);
    const entered = await setPhoto(true);
    const [yaw, pitch, dist] = s.orbit;
    const ok = entered && await page.evaluate(({ yaw, pitch, dist }) => {
      const g = window.__neonx.game;
      const ph = g?.photo;
      if (!ph || !ph.on) return false;
      ph.auto = false;
      ph.yaw = g.car.h + yaw;
      ph.pitch = pitch;
      ph.dist = dist;
      return true;
    }, { yaw, pitch, dist });
    await waitFrames(2);
    await hideChrome();
    await big();
    const f = path.join(OUT, `${TAG}-${s.name}${s.cam !== undefined ? "-orbit" : ""}.png`);
    await page.screenshot({ path: f });
    await small();
    log.push({ name: path.basename(f), where, rig: ok, spec: s, car: CAR, paint: PAINT });
    console.log("  📸", path.basename(f), where, ok ? "" : "(rig not reachable)", stamp());
  }
  if (s.probe) {
    const r = await page.evaluate(() => {
      const g = window.__neonx.game;
      const npcs = g.traffic.npcs.filter((n) => n.active).slice(0, 3);
      return {
        keys: npcs[0] ? Object.keys(npcs[0]).filter((k) => typeof npcs[0][k] !== "object") : [],
        types: g.traffic.npcs.filter((n) => n.active).map((n) => [n.type, n.route, Math.round(n.s ?? -1), n.laneK]),
        bypassLen: g.world.routes?.bypass?.len, mtnLen: g.world.routes?.mtn?.len,
        ramps: g.terrain.ramps.map((r) => [r.kind, r.pts[0].s, r.pts[r.pts.length - 1].s]),
      };
    });
    console.log(JSON.stringify(r));
  }
}
await setPhoto(false);
await page.evaluate(() => { window.__neonx.setInput(null); window.__neonx.setRain(false); });
const logF = path.join(OUT, `${TAG}-log.json`);
const prev = RESUME && existsSync(logF) ? JSON.parse(readFileSync(logF, "utf8")) : [];
writeFileSync(logF, JSON.stringify([...prev.filter((e) => !log.some((n) => n.name === e.name)), ...log], null, 1));
await browser.close();
if (errors.length) {
  console.log("\nerrors:");
  for (const e of errors.slice(0, 8)) console.log("  -", e.slice(0, 200));
}
console.log("✅ done —", log.length, "frames in", OUT);
