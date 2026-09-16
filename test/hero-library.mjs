/* Library photographer — MANY different frames, not fourteen of the same one.

   hero-shots.mjs (driving cams) and hero-orbit.mjs (photo-mode rig) each carry
   a fixed table and each produce one look: one car, one paint, one traffic
   level, a handful of stations. The result was six car photos that all read
   as the same picture. What a batch actually needs is variety: different car
   angles, angles of the city, different spots, different cars.

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
       hour, rain?, kmh?, th?, wait?, cam: 0..4 | orbit: [yaw, pitch, dist] }
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
/* --dpr: 2 is the content default (frames get cropped to 9:16 and scaled to
   1080x1920). Lower it only when the box is so loaded that a full frame costs
   minutes — every big frame is rendered exactly once, so the DPR is the one
   cost lever left. */
const DPR = Number(arg("dpr", "2"));
if (!SHOTS_FILE) {
  console.error("need --shots <file.json>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Wait for N RENDERED frames rather than N seconds: on this box a frame can
   take anything from 0.3 s to 20 s depending on what the other lanes are
   rendering, and a wall-clock sleep either starves the chase spring or burns
   minutes per shot. game.debug.frames is the loop's own counter. */
const frames = () => page.evaluate(() => window.__neonx.state().frames);
const VERBOSE = process.argv.includes("--verbose");
const waitFrames = async (n, maxMs = 240000) => {
  const f0 = await frames();
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    await sleep(400);
    if ((await frames()) - f0 >= n) {
      if (VERBOSE) console.log(`    ${n} frames in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      return Date.now() - t;
    }
  }
  console.log(`    waitFrames(${n}) timed out after ${maxMs / 1000}s`);
  return -1;
};
/* SwiftShader cost is per pixel, and nothing about the settle (chase spring,
   streetlight pools, the orbit rig) needs the shot's resolution — so the
   session lives at a quarter of the pixels and the viewport is grown to the
   real 3200x1800 for two frames around each screenshot. engine.ts onResize
   re-sizes the renderer and rebuilds the post targets on the resize event. */
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";


let shots = JSON.parse(readFileSync(SHOTS_FILE, "utf8"));
if (ONLY) shots = shots.filter((s) => ONLY.split(",").includes(s.name));
if (RESUME) {
  const before = shots.length;
  shots = shots.filter((s) => !existsSync(path.join(OUT, `${TAG}-${s.name}.png`)));
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
      defaultViewport: { width: 640, height: 360, deviceScaleFactor: 1 },
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
    /* the clock must not drift between setTime and the shot */
    autoTime: false,
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

await page.addStyleTag({
  content: `#photoHint, #topbar, #hud, .toast, [class*="toast"] { opacity: 0 !important; }`,
});
await page.evaluate(() => { try { window.__neonx.game.grade = false; } catch {} });

/* ONE evaluate per shot. Every puppeteer round trip queues behind whatever
   frame the page is rendering (10-25 s here), so a shot made of fifteen small
   evaluates cost 400 s of which 70 were rendering. Inside the page the waits
   are rAF-exact and the photo-mode toggle goes straight to the UI seam
   (game.ui.photoRequest — the same call the O key makes). The only things
   left outside are the viewport switch and the screenshot. */
const shootInPage = (s, kmh) =>
  page.evaluate(async ({ s, kmh }) => {
    const g = window.__neonx, game = g.game;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const waitF = async (n) => {
      const f0 = g.state().frames;
      while (g.state().frames < f0 + n) await raf();
    };
    const setPhoto = async (want) => {
      for (let t = 0; t < 3; t++) {
        if (!!g.state().photo === want) return true;
        game.ui.photoRequest();
        await raf();
      }
      return !!g.state().photo === want;
    };
    await setPhoto(false);
    g.setTime(s.hour ?? 21.5);
    g.setRain(!!s.rain);
    /* placement */
    let where = "cor";
    const at = s.at;
    if (at.bypass !== undefined) { g.toBypass(at.bypass, kmh, at.lane || 0); where = "bypass"; }
    else if (at.mtn !== undefined) { g.toMountain(at.mtn, kmh, 0); where = "mtn"; }
    else if (at.ramp !== undefined) {
      const r = game.terrain.ramps.find((q) => q.kind === (at.kind || "entry"));
      let bi = 0, bd = 1e9;
      for (let i = 0; i < r.pts.length; i++) {
        const d = Math.abs(r.pts[i].s - at.ramp);
        if (d < bd) { bd = d; bi = i; }
      }
      const p = r.pts[bi];
      g.teleport(p.x, p.z, p.y + 0.2, Math.atan2(-p.tx, -p.tz), kmh / 3.6);
      where = "ramp";
    } else {
      const c = game.terrain.corridor;
      let z = at.z, lane = at.lane || 0;
      if (at.near) {
        const cands = game.traffic.npcs.filter((n) => n.active && n.type === at.near && n.route === -1);
        if (!cands.length) return { where: "no-" + at.near, skip: true };
        cands.sort((a, b) => Math.abs(a.s - at.z) - Math.abs(b.s - at.z));
        const n = cands[0];
        z = c.wrapZ(n.s + (at.dz || -10));
        lane = n.laneK + (at.dl || 1);
        where = `near ${at.near} z=${z.toFixed(0)} lane=${lane}`;
      }
      const nl = c.lanes(z);
      const k = Math.min(nl - 1, Math.max(0, lane < 0 ? nl + lane : lane));
      const p = c.worldOf(z, c.laneOffset(k, z));
      g.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, kmh / 3.6);
    }
    g.setInput({ th: s.th ?? 0.5 });
    let rig = null;
    if (s.orbit) {
      await waitF(s.pre ?? 2);
      const entered = await setPhoto(true);
      const ph = game.photo;
      rig = entered && !!ph && ph.on;
      if (rig) {
        ph.auto = false;
        ph.yaw = game.car.h + s.orbit[0];
        ph.pitch = s.orbit[1];
        ph.dist = s.orbit[2];
      }
    } else {
      g.setCam(s.cam ?? 0);
      await waitF(s.wait ?? 6);
    }
    return { where, rig };
  }, { s, kmh });

/* grow the viewport, wait for exactly one full-size frame, hide the chrome */
const bigFrame = async () => {
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: DPR });
  await page.evaluate(async () => {
    const g = window.__neonx;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    while (innerWidth !== 1600) await raf();
    let el = document.querySelector("canvas");
    while (el && el !== document.body) {
      const par = el.parentElement;
      if (!par) break;
      for (const sib of par.children) if (sib !== el) sib.style.setProperty("opacity", "0", "important");
      el = par;
    }
    for (const id of ["photoHint", "topbar", "hud"]) {
      const e = document.getElementById(id);
      if (e) e.style.setProperty("opacity", "0", "important");
    }
    const f0 = g.state().frames;
    while (g.state().frames < f0 + 1) await raf();
  });
};

const log = [];
for (const s of shots) {
  const kmh = s.kmh ?? 110;
  const r = await shootInPage(s, kmh);
  if (VERBOSE) console.log("  ->", s.name, r.where, stamp());
  if (r.skip) { console.log("  skip", s.name, r.where); continue; }
  await bigFrame();
  const f = path.join(OUT, `${TAG}-${s.name}.png`);
  await page.screenshot({ path: f, optimizeForSpeed: true });
  await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
  log.push({ name: path.basename(f), where: r.where, rig: r.rig, spec: s, car: CAR, paint: PAINT });
  console.log("  📸", path.basename(f), r.where, s.orbit && !r.rig ? "(rig not reachable)" : "", stamp());
}
await page.evaluate(() => {
  const g = window.__neonx;
  if (g.state().photo) g.game.ui.photoRequest();
  g.setInput(null);
  g.setRain(false);
});
const logF = path.join(OUT, `${TAG}-log.json`);
const prev = RESUME && existsSync(logF) ? JSON.parse(readFileSync(logF, "utf8")) : [];
writeFileSync(logF, JSON.stringify([...prev.filter((e) => !log.some((n) => n.name === e.name)), ...log], null, 1));
await browser.close();
if (errors.length) {
  console.log("\nerrors:");
  for (const e of errors.slice(0, 8)) console.log("  -", e.slice(0, 200));
}
console.log("✅ done —", log.length, "frames in", OUT);
