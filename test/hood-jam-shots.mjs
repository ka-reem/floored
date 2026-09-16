/* Proof shots for two owner items, from ONE page load and ONE frozen frame.

   #15 HOOD VIEW — the hood camera is a live knob (`window.__hoodCam`), so the
   old mount and the new one can be shot from the SAME frozen frame: nothing
   in the world moves between the pair, so every pixel that differs is the
   camera. The old values are hardcoded here as the before.

   #11 TRAFFIC AT 100% — the density slider is read every frame, so it can be
   swept in place. Each setting gets time to re-seed (the spawner trickles 5
   cars a frame on an ordinary frame), then a count, a nearest-gap measurement
   and a shot. The measurement is what makes the picture trustworthy: median
   bumper-to-bumper gap in the player's own lane, in metres.

   #16 GREEN DOTS — the dashcam POV chain is the only thing in the renderer
   that can put green where the scene has none. Three mechanisms in it, all of
   them reachable from `window.__povTune`, so each can be nulled in turn on the
   SAME frozen frame parked in a streetlight pool and the green counted:

     grain      col += vec3(n2-.5,(n2+n3)*.5-.5,n3-.5) * .10 * dark, off a
                np = floor(uv*uLow*.8) grid — coarse BLOCKS, not per-pixel
                speckle, i.e. dots.
     gainFloor  col += lift * vec3(1.02,1.05,.98) * (.72+.56*n1) — a green-
                biased lift (G 1.05 against B 0.98) that only fires where luma
                is under ~0.055, modulated by the same block noise. Dark floor
                only, which is where he saw them.
     shadowGrain  how much of the grain survives in the shadows.

   Counted as pixels where G leads both R and B by a margin, in the lower half
   of the frame only (the road), with the DOM hidden so no HUD can be read as
   scene — the two false positives that cost the last attempt.

   Usage: node test/hood-jam-shots.mjs --url http://localhost:3701 --out DIR
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3701");
const OUT = arg("--out", process.cwd());
const TIER = arg("--tier", "desktop");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPOT = -1300, KMH = 92, LANE = 1, FPS = 30;
/* The mount that shipped before this change: half a metre of clear air over
   the bonnet, which is why no bonnet was ever in frame. */
const OLD_HOOD = { dy: 0.5, dz: 0.6, tilt: 0, legacy: true };

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
         "--disable-dev-shm-usage", "--mute-audio"],
  protocolTimeout: 3600000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !/favicon|WebSocket/.test(m.text())) errors.push(m.text());
});
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 900000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
await page.evaluate(() =>
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE")).click()
);
console.log("world build (minutes under swiftshader)...");
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 3000000, polling: 5000 });
await page.waitForFunction(() => window.__neonx.state().npcs > 40, { timeout: 600000, polling: 3000 }).catch(() => {});
await sleep(12000);

await page.evaluate(({ z, kmh, lane }) => {
  window.__neonx.toCorridor(z, kmh, lane);
  window.__neonx.setInput({ th: 0.34 });
}, { z: SPOT, kmh: KMH, lane: LANE });
await sleep(12000);

const step = () => page.evaluate(() => window.__neonx.step());
const setDt = (dt) => page.evaluate((dt) => window.__neonx.setFixedDt(dt), dt);
const setCam = (i) => page.evaluate((i) => window.__neonx.setCam(i), i);
const shot = async (name) => {
  await step();
  await page.screenshot({ path: path.join(OUT, name) });
  console.log("saved", name);
};

await setDt(1 / FPS);
for (let i = 0; i < 90; i++) await step();

/* ---------- #15 hood view: same frame, both mounts ---------------------- */
await setCam(2); // CAM_HOOD
await step();
await setDt(1e-6); // the world stops; only the mount moves between the pair
await step();

const setHood = (v) => page.evaluate((v) => {
  if (!v) { delete window.__hoodCam; return; }
  /* The legacy mount was an ABSOLUTE (0, belt+0.5, L/2-0.6). The new knob is
     offsets from the cowl, so reproduce the old numbers by cancelling the
     hood term: dz_legacy = hood - 0.6. */
  const P = window.__neonx.game.spec.shell;
  window.__hoodCam = v.legacy
    ? { dy: v.dy, dz: P.hood - v.dz, tilt: v.tilt }
    : { dy: v.dy, dz: v.dz, tilt: v.tilt };
}, v);

await setHood(OLD_HOOD);
await shot("hood-before.png");
await setHood(null);
await shot("hood-after.png");
await setHood(OLD_HOOD);
await shot("hood-before2.png"); // the capture's own noise floor
await setHood(null);

/* where the bonnet lands in frame, measured rather than eyeballed */
const hoodGeom = await page.evaluate(() => {
  const g = window.__neonx.game, P = g.spec.shell, cam = g.camera;
  const k = window.__hoodCam || { dy: 0.03, dz: 0.22 };
  const eyeY = P.belt + k.dy, eyeZ = P.L / 2 - P.hood + k.dz;
  const noseZ = P.L / 2 - 0.09, noseY = P.nose;
  const deg = (Math.atan2(eyeY - noseY, noseZ - eyeZ) * 180) / Math.PI;
  const halfV = cam.fov / 2;
  return {
    mount: { y: +eyeY.toFixed(3), z: +eyeZ.toFixed(3) },
    glassBaseZ: +(P.L / 2 - P.hood + 0.08).toFixed(3),
    noseBelowHorizonDeg: +deg.toFixed(1),
    fovV: +cam.fov.toFixed(1),
    bonnetPctOfFrame: +(((halfV - deg) / cam.fov) * 100).toFixed(1),
  };
});
console.log("hood geometry", hoodGeom);

/* ---------- #11 traffic density sweep ---------------------------------- */
await setDt(1 / FPS);
await setCam(3); // dashcam: the frame the owner judges in first
const rows = [];
for (const d of [0.5, 0.75, 1]) {
  await page.evaluate((d) => { window.__neonx.game.settings.traffic = d; }, d);
  // let the fleet re-seed: the spawner trickles 5 cars a frame off a seed frame
  for (let i = 0; i < 420; i++) await step();
  const m = await page.evaluate(() => {
    const g = window.__neonx.game, t = g.traffic, cor = t.cor, c = g.car;
    const deck = t.npcs.filter((n) => n.active && n.hw && n.route === -1);
    /* Bumper-to-bumper gaps, per lane, along the corridor. Sorting by
       arclength inside a lane and differencing is the only honest way to say
       "how far apart is the traffic" — a mean over all pairs is meaningless
       on a one-way road. */
    const lanes = new Map();
    for (const n of deck) {
      const k = Math.round(n.offCur / 3.4);
      (lanes.get(k) || lanes.set(k, []).get(k)).push({ s: n.s, L: n.L });
    }
    const gaps = [];
    for (const arr of lanes.values()) {
      arr.sort((a, b) => a.s - b.s);
      for (let i = 1; i < arr.length; i++) {
        const d = cor.deltaZ(arr[i - 1].s, arr[i].s) - (arr[i].L + arr[i - 1].L) / 2;
        if (d > 0 && d < 400) gaps.push(d);
      }
    }
    gaps.sort((a, b) => a - b);
    const med = gaps.length ? gaps[gaps.length >> 1] : null;
    return {
      density: g.settings.traffic,
      fleetMax: t.N,
      active: t.npcs.filter((n) => n.active).length,
      deck: deck.length,
      medianGapM: med === null ? null : +med.toFixed(1),
      kmh: +(Math.abs(c.u) * 3.6).toFixed(0),
      meanSpeedKmh: deck.length
        ? +((deck.reduce((a, n) => a + n.v, 0) / deck.length) * 3.6).toFixed(0) : null,
    };
  });
  console.log("density", d, m);
  rows.push(m);
  await shot(`traffic-${String(Math.round(d * 100)).padStart(3, "0")}.png`);
}

/* ---------- #16 green dots in the dashcam chain ------------------------- */
await page.evaluate(() => {
  /* Every earlier hunt for these was poisoned by the HUD and by the cluster
     drawn INSIDE the canvas, so both go: the DOM overlay is hidden outright
     and the camera is parked in POV where the cluster sits in the bottom
     strip, which the count already excludes by looking at rows 0.5..0.92. */
  for (const el of document.querySelectorAll("body > *"))
    if (!el.querySelector("canvas") && el.tagName !== "CANVAS") el.style.visibility = "hidden";
});
await page.evaluate((d) => { window.__neonx.game.settings.traffic = d; }, 1);
/* Park under a lamp: the pools sit on the lattice, so walk a short way and
   stop where the road in front is brightest and most orange. */
await setCam(3);
for (let i = 0; i < 60; i++) await step();
await setDt(1e-6);
await step();

const greenCount = () => page.evaluate(() => {
  const cv = window.__neonx.game.renderer.domElement;
  const c = document.createElement("canvas");
  c.width = cv.width; c.height = cv.height;
  const g = c.getContext("2d");
  g.drawImage(cv, 0, 0);
  const y0 = Math.floor(c.height * 0.5), y1 = Math.floor(c.height * 0.92);
  const d = g.getImageData(0, y0, c.width, y1 - y0).data;
  let n = 0, worst = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    const lead = gg - Math.max(r, b);
    if (lead > 6 && gg > 24) { n++; if (lead > worst) worst = lead; }
  }
  return { green: n, worstLead: worst, px: (y1 - y0) * c.width };
});

const tune = (o) => page.evaluate((o) => Object.assign(window.__povTune, o), o);
const green = [];
for (const [name, knobs] of [
  ["shipping", {}],
  ["grain-0", { grain: 0 }],
  ["gainfloor-0", { gainFloor: 0 }],
  ["both-0", { grain: 0, gainFloor: 0 }],
]) {
  await page.evaluate(() => {
    const d = window.__neonx.game.post.povDef;
    Object.assign(window.__povTune, d);
  });
  await tune(knobs);
  await step();
  const g = await greenCount();
  green.push({ name, ...g });
  console.log("green", name, g);
  await page.screenshot({ path: path.join(OUT, `green-${name}.png`) });
}
await page.evaluate(() => {
  const d = window.__neonx.game.post.povDef;
  Object.assign(window.__povTune, d);
});

writeFileSync(path.join(OUT, "measurements.json"),
  JSON.stringify({ hoodGeom, traffic: rows, green, errors }, null, 1));
console.log("errors:", errors.length, errors.slice(0, 5));
await browser.close();
