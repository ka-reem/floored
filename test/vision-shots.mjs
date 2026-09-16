/* Photographer for the what-the-AI-sees debug overlay (game/vision.ts) over
   the game's best frames, for content rather than for QA.

   Modelled on hero-shots.mjs (HIGH preset, desktop tier, HUD and dashcam
   grade off, 2x DPR) with two additions:

     PAIRS   a station shot with the overlay OFF and then ON from the SAME
             frozen frame — the sim is paused (game.setRunning(false)) between
             the two, so the before/after slides need nothing lined up by eye.
     ORBITS  photo mode (the O key) with the rig set directly, as
             hero-orbit.mjs does, so some layers are seen from above like a
             scanner rather than from the driving seat.

   Three frames are DELIBERATELY BROKEN, using live knobs rather than reverted
   code, and stamped as such on the frame itself via the overlay's `note`:
     - the parapet lean with window.__slopeProbe.guard = false (the 19.3°
       nose-down on flat concrete);
     - the bus scrape with every NPC's cw written back to W/2 (mirrors in the
       collision box) so the car is shoved by air.

   Usage: node test/vision-shots.mjs --url http://localhost:3530 [--only a,b]
          [--out DIR]   (default test/artifacts/vision)
   Writes DIR/vision-*.png, DIR/sheet-*.png and DIR/vision-INDEX.md. */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import sharp from "sharp";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes("--" + k);
const URL = arg("url", "http://localhost:3530");
const OUT = arg("out", path.join(process.cwd(), "test", "artifacts", "vision"));
const ONLY = arg("only", "");
const SETTLE = +arg("settle", 8000);
/* 1.5 by default: 2x on this box under other lanes' browsers was ten minutes a frame */
const DPR = +arg("dpr", 1.5);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* CAM: 0 chase · 1 cockpit · 2 hood · 3 dashcam · 4 console
   place: {kind:"lane", z, lane} | {kind:"lean"} | {kind:"bus", mode}
   orbit: {yaw, pitch, dist} → photo mode instead of a driving cam
   layers: flags for __neonx.vision.set
   pair: also shoot the overlay-OFF frame first, from the frozen same frame
   legacy: write the pre-fix live knobs for this station (restored after)
   what: the INDEX line, in plain words */
const L = (o) => ({ hitboxes: false, probes: false, lanes: false, brain: false, lights: false, signs: false, terrain: false, note: "", ...o });
const ALL = L({ hitboxes: true, probes: true, lanes: true, brain: true, lights: true, signs: true, terrain: true });
const CITY = { kind: "lane", z: -300, lane: 0 }, DECK = { kind: "lane", z: -700, lane: 0 };
const TOLL = { kind: "lane", z: 1385, lane: 1 }, MTN = { kind: "lane", z: -1992, lane: -1 };
const STATIONS = [
  /* ---- 1. hitboxes: city deck at night, every car boxed ---- */
  { name: "city-hitboxes-chase", crowd: true, place: CITY, cam: 0, hour: 21.5, layers: L({ hitboxes: true }), pair: true,
    what: "Every car on the night deck wearing its real collision box (cyan). The faint magenta box is the old one that counted the door mirrors." },
  { name: "city-hitboxes-cockpit", crowd: true, place: CITY, cam: 1, hour: 21.5, layers: L({ hitboxes: true }),
    what: "Same boxes from the driver's seat — the traffic ahead framed in glowing wire." },
  { name: "city-hitboxes-drone", crowd: true, place: CITY, orbit: { yaw: 1.1, pitch: 1.18, dist: 13 }, hour: 21.5, layers: L({ hitboxes: true }), pair: true,
    what: "Straight down from above like a scanner: the boxes, the barrier walls in orange, the player in magenta." },
  { name: "city-hitboxes-hood", crowd: true, extra: true, place: CITY, cam: 2, hour: 21.5, layers: L({ hitboxes: true, labels: true }),
    what: "Hood camera: each car's box carries its name and how many centimetres the mirrors used to add." },

  /* ---- 2. probes: the parapet lean, the 19.3-degree bug drawn ---- */
  { name: "parapet-probes-chase", place: { kind: "lean" }, cam: 0, hour: 21.5, layers: L({ probes: true }), pair: true, settle: 3000,
    what: "The car jammed against the wall at an angle. Two rays feel for the ground 2.2 m ahead and behind; the front one hangs over the edge and is thrown away (red)." },
  { name: "parapet-probes-side", place: { kind: "lean" }, orbit: { yaw: 1.45, pitch: 0.12, dist: 8.5 }, hour: 21.5, layers: L({ probes: true }), settle: 3000,
    what: "Side view of the same jam: the front probe reaching past the parapet toward the town ten metres below." },
  { name: "BROKEN-parapet-lean-chase", place: { kind: "lean" }, cam: 0, hour: 21.5, legacy: true, settle: 3000,
    layers: L({ probes: true, note: "BEFORE FIX · slope guard OFF" }),
    what: "BROKEN ON PURPOSE: the guard switched off live. The probe that fell off the deck is ACCEPTED, and the car tips 19 degrees nose-down on flat concrete." },
  { name: "BROKEN-parapet-lean-side", place: { kind: "lean" }, orbit: { yaw: 1.45, pitch: 0.12, dist: 8.5 }, hour: 21.5, legacy: true, settle: 3000,
    layers: L({ probes: true, note: "BEFORE FIX · slope guard OFF" }),
    what: "BROKEN ON PURPOSE, from the side: the magenta line is the ground the car THINKS it is on. The deck is flat." },

  /* ---- 3. brain: the toll plaza, what every driver intends ---- */
  { name: "toll-brain-dashcam", crowd: true, place: TOLL, cam: 3, hour: 20.5, layers: L({ brain: true }), pair: true,
    what: "Dashcam at the toll plaza: an arrow from each car showing where it means to go, the gap it is keeping, and the zone where it panics." },
  { name: "toll-brain-chase", crowd: true, extra: true, place: TOLL, cam: 0, hour: 20.5, layers: L({ brain: true }),
    what: "Same plaza from behind: labels read each driver's lane, speed and mood (CRUISE / BRAKE / CHANGING)." },
  { name: "toll-brain-drone", crowd: true, place: TOLL, orbit: { yaw: 0.8, pitch: 1.0, dist: 14 }, hour: 20.5, layers: L({ brain: true }), pair: true,
    what: "From above: the plaza as the AI drivers see it — intentions as arrows, danger zones as orange boxes." },

  /* ---- 4. lanes: the mountain diverge, the road graph ---- */
  { name: "mtn-lanes-chase", place: MTN, cam: 0, hour: 18.6, layers: L({ lanes: true }), pair: true,
    what: "Exit 4 at dusk: the lane grid the traffic drives on, and the mountain road peeling off in magenta." },
  { name: "mtn-lanes-drone", place: MTN, orbit: { yaw: 1.6, pitch: 1.05, dist: 16 }, hour: 18.6, layers: L({ lanes: true }),
    what: "The fork from above: two roads as the map knows them, with the junction node ringed." },
  { name: "bypass-lanes-chase", place: { kind: "lane", z: 455, lane: 0 }, cam: 0, hour: 21.0, layers: L({ lanes: true }),
    what: "The bypass diverge: main lanes in cyan, the viaduct leaving in magenta, the split point ringed." },

  /* ---- 5. lights: the headlight footprint ---- */
  { name: "deck-lights-dashcam", crowd: true, place: DECK, cam: 3, hour: 23.0, layers: L({ lights: true }), pair: true,
    what: "Dashcam at night: the outline of where the two headlight cones actually land on the road, and every other car's beam pool." },
  { name: "deck-lights-chase", crowd: true, extra: true, place: DECK, cam: 0, hour: 23.0, layers: L({ lights: true }),
    what: "From behind: two orange footprints thrown 130 m up the deck, the axis of each beam in cyan." },
  { name: "deck-lights-drone", crowd: true, place: DECK, orbit: { yaw: 2.6, pitch: 0.75, dist: 14 }, hour: 23.0, layers: L({ lights: true }),
    what: "High front three-quarter: the cones' edges cut against the road like a lighting plan." },

  /* ---- 6. signs: the audit made visible ---- */
  { name: "toll-signs-chase", place: { kind: "lane", z: 1250, lane: 1 }, cam: 0, hour: 20.5, layers: L({ signs: true }), pair: true,
    what: "Every overhead sign with an arrow for the way its face points. Green means it faces the driver — the check the sign audit runs." },
  { name: "mtn-signs-hood", place: { kind: "lane", z: -2150, lane: -1 }, cam: 2, hour: 18.6, layers: L({ signs: true }),
    what: "The Exit 4 countdown boards on the approach, each one's face normal drawn and scored." },

  /* ---- 7. terrain: the height grid ---- */
  { name: "city-terrain-chase", extra: true, place: CITY, cam: 0, hour: 21.5, layers: L({ terrain: true }),
    what: "A grid of ground samples around the car: cyan where the deck is, blue where it drops to the town below." },
  { name: "city-terrain-drone", place: CITY, orbit: { yaw: 2.1, pitch: 0.95, dist: 18 }, hour: 21.5, layers: L({ terrain: true }), pair: true,
    what: "From above: the deck as a floating wireframe sheet over the streets — this is the only 'ground' the physics knows." },

  /* ---- 8. everything on ---- */
  { name: "city-everything-chase", crowd: true, place: CITY, cam: 0, hour: 21.5, layers: ALL,
    what: "Every layer at once — all the machinery the game runs under one night frame." },
  { name: "city-everything-cockpit", crowd: true, place: CITY, cam: 1, hour: 21.5, layers: ALL,
    what: "Everything on, from the driver's seat." },
  { name: "toll-everything-dashcam", crowd: true, place: TOLL, cam: 3, hour: 20.5, layers: ALL,
    what: "Everything on, dashcam, toll plaza — full noise." },
  { name: "mtn-everything-drone", extra: true, place: MTN, orbit: { yaw: 1.6, pitch: 1.05, dist: 16 }, hour: 18.6, layers: ALL,
    what: "Everything on, from above the mountain fork." },

  /* ---- 9. the bus scrape: broken and fixed ---- */
  { name: "BROKEN-bus-scrape-chase", place: { kind: "bus", mode: "old" }, cam: 0, hour: 21.5, legacy: true,
    layers: L({ hitboxes: true, note: "BEFORE FIX · mirrors in the hitbox" }),
    what: "BROKEN ON PURPOSE: the old widths written into live traffic. The car is shoved off a bus it is not touching — the box is wider than the bus." },
  { name: "BROKEN-bus-scrape-drone", place: { kind: "bus", mode: "old" }, orbit: { yaw: 1.2, pitch: 1.15, dist: 11 }, hour: 21.5, legacy: true,
    layers: L({ hitboxes: true, note: "BEFORE FIX · mirrors in the hitbox" }),
    what: "BROKEN ON PURPOSE, from above: daylight between the bodies, boxes overlapping." },
  { name: "bus-scrape-fixed-chase", place: { kind: "bus", mode: "new" }, cam: 0, hour: 21.5, layers: L({ hitboxes: true }),
    what: "After the fix: the cyan box is the bus's real flank, the magenta ghost is where the mirrors used to make it 17 cm wider." },
  { name: "bus-scrape-fixed-drone", place: { kind: "bus", mode: "new" }, orbit: { yaw: 1.2, pitch: 1.15, dist: 11 }, hour: 21.5, layers: L({ hitboxes: true }),
    what: "After the fix, from above: the car is against the bus's real box, and the old box is drawn as a ghost." },
];
/* `extra` stations only run with --all — the core set is already 33 frames */
const base = has("all") ? STATIONS : STATIONS.filter((s) => !s.extra);
const list = ONLY ? STATIONS.filter((s) => ONLY.split(",").some((k) => s.name.includes(k))) : base;

/* ---------------------------------------------------------------- browser */
const errors = [];
const browser = await puppeteer.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: DPR },
  protocolTimeout: 0,
  timeout: 180000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => { const t = m.text(); if (/error|fail|vision|chunk/i.test(t)) console.log("  [console]", t.slice(0, 220)); });
page.on("requestfailed", (r) => console.log("  [reqfail]", r.url().slice(-120), r.failure()?.errorText));

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
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"))?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 2400000 });
await sleep(12000);
console.log("render tier:", await page.evaluate(() => window.__neonx.game.renderTier));

if (!has("hud")) {
  await page.addStyleTag({
    content: `#hud, .hud, #topbar, #tcDrawer, .topbar, .pucks, #mmap, .mmapWrap, .hudCorner, .recStamp,
              #toast, #exitHint, #hint, #gearBtn, #tcMore, .tc, #swheel, #sslider, button,
              [class*="puck"], #photoHint, .photoHint, .photoBanner, [class*="photoHint"], [class*="photo-hint"]
              { opacity: 0 !important; }`,
  });
}
if (!has("grade")) await page.evaluate(() => { try { window.__neonx.game.grade = false; } catch {} });
if (!has("hud")) await page.evaluate(() => {
  /* whatever the id list above missed (the N badge): every positioned
     element that does not contain the canvas goes transparent */
  const cv = document.querySelector("canvas");
  for (const el of document.body.querySelectorAll("*")) {
    if (el === cv || el.contains(cv)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.position === "absolute") el.style.setProperty("opacity", "0", "important");
  }
});

/* the pre-fix knobs, and their restore — same shape as barrier-hitbox-shots */
await page.evaluate(() => {
  const g = window.__neonx.game;
  window.__orig = { cw: g.traffic.npcs.map((n) => n.cw) };
  window.__legacy = (on) => {
    if (on) {
      window.__slopeProbe.guard = false;
      g.traffic.npcs.forEach((n) => { n.cw = n.W / 2; });
    } else {
      window.__slopeProbe.guard = true;
      g.traffic.npcs.forEach((n, i) => { n.cw = window.__orig.cw[i]; });
    }
  };
});

const setPhoto = async (want) => {
  for (let t = 0; t < 3; t++) {
    const on = await page.evaluate(() => !!window.__neonx.state().photo);
    if (on === want) return true;
    await page.keyboard.press("o");
    await sleep(900);
  }
  return (await page.evaluate(() => !!window.__neonx.state().photo)) === want;
};

/* After a teleport the fleet reseeds 110 m+ ahead (traffic.ts reseedAhead),
   which at night is an empty road for the first ten seconds. Pull a handful
   of live expressway cars into the frame instead — same lanes, same brains,
   they just start closer. s/laneK/offCur are what traffic.ts derives x/z
   from every frame, so writing those is enough. */
const crowd = async () => page.evaluate(() => {
  const nx = window.__neonx, g = nx.game, cor = g.cor, car = g.car;
  const zc = cor.zAt(car.x, car.z);
  const n = cor.lanes(zc);
  const lat = cor.latAt(car.x, car.z);
  let pk = 0, best = 1e9;
  for (let k = 0; k < n; k++) { const d = Math.abs(cor.laneOffset(k, zc) - lat); if (d < best) { best = d; pk = k; } }
  const slots = [[14, 0], [24, 1], [40, -1], [52, 1], [66, 0], [30, 2], [84, -1], [100, 1]];
  const pool = g.traffic.npcs.filter((x) => x.hw && !x.rival && x.route === -1 && !x.wreck);
  pool.sort((a, b) => Math.hypot(b.x - car.x, b.z - car.z) - Math.hypot(a.x - car.x, a.z - car.z)); // farthest first
  let i = 0;
  for (const [ds, dk] of slots) {
    const m = pool[i++]; if (!m) break;
    const k = Math.min(n - 1, Math.max(0, pk + dk));
    if (k === pk && ds < 20) continue;
    const sz = zc + ds;
    m.active = true; m.fade = 1; m.wreck = null; m.spin = 0;
    m.s = sz; m.laneK = k; m.pendK = -1; m.offCur = m.offT = cor.laneOffset(k, sz);
    const p = cor.worldOf(sz, m.offCur);
    m.x = p.x; m.z = p.z; m.y = p.y; m.hVis = cor.pose(sz).h;
    m.v = Math.max(8, Math.abs(car.u) * (0.85 + 0.1 * (i % 3)));
    m.v0 = m.v;
  }
  return i;
});

const place = async (p) => {
  if (p.kind === "lane") {
    await page.evaluate(({ z, lane }) => {
      const c = window.__neonx.game.terrain.corridor;
      const n = c.lanes(z);
      const k = Math.min(n - 1, Math.max(0, lane < 0 ? n + lane : lane));
      const q = c.worldOf(z, c.laneOffset(k, z));
      window.__neonx.teleport(q.x, q.z, q.y + 0.2, c.pose(z).h, 33);
      window.__neonx.setInput({ th: 0.55 });
    }, p);
  } else if (p.kind === "lean") {
    /* barrier-hitbox-shots.mjs's jam: east parapet, big yaw, throttle + lock */
    await page.evaluate(() => {
      const nx = window.__neonx, cor = nx.game.cor;
      const zc = cor.zAt(cor.centerX(-900), -900);
      const lat = cor.edgeHalf(zc, 1) - 1.0;
      nx.teleport(cor.centerX(zc) + lat, zc, undefined, 1.15, 8);
      nx.setInput({ th: 0.55, st: 1 });
      nx.simStep(0.9);
      nx.setInput({ th: 0.2, st: 1 });
    });
  } else if (p.kind === "bus") {
    await page.evaluate((mode) => {
      const nx = window.__neonx, g = nx.game, cor = g.cor;
      const bus = g.traffic.npcs.find((n) => n.type === "bus" && n.active) || g.traffic.npcs.find((n) => n.type === "bus");
      const z = -300, zc = cor.zAt(cor.centerX(z), z);
      bus.active = true; bus.wreck = null; bus.fade = 1;
      bus.v = 0; bus.v0 = 0.01; bus.hw = true; bus.route = -1; bus.dir = 1;
      bus.laneK = 1; bus.offCur = bus.offT = cor.laneOffset(1, zc);
      bus.s = zc; bus.x = cor.centerX(zc) + bus.offCur; bus.z = zc; bus.y = cor.centerY(zc); bus.hVis = 0;
      const hw = g.rig.halfW;
      /* "old": start 5 cm off the REAL flank — clear in reality — and let the
         inflated box shove the car out to W/2. "new": sit on the real box. */
      const d = mode === "old" ? hw + bus.W / 2 - 0.12 : hw + bus.cw + 0.01;
      nx.teleport(bus.x + d, bus.z + 0.4, bus.y, 0, 0);
      nx.setInput({ th: 0, st: 0 });
      nx.simStep(0.5);
    }, p.mode);
  }
};

const kept = [], rejected = [];
const shoot = async (name, what, layers) => {
  const f = path.join(OUT, `vision-${name}.png`);
  await page.screenshot({ path: f });
  const st = await sharp(f).stats();
  const mean = st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3;
  if (mean < 3 || mean > 248) {
    rejected.push({ name, mean });
    unlinkSync(f);
    console.log("  ✗", path.basename(f), `mean ${mean.toFixed(1)} — rejected`);
    return;
  }
  kept.push({ name, file: path.basename(f), what, layers, mean });
  console.log("  📸", path.basename(f), `mean ${mean.toFixed(1)}`);
};

for (const s of list) {
  console.log(`\n▶ ${s.name}`);
  await setPhoto(false);
  await page.evaluate(async ({ cam, hour, legacy }) => {
    const nx = window.__neonx;
    nx.game.setRunning(true);
    window.__legacy(!!legacy);
    await nx.vision.off();
    if (cam !== undefined) nx.setCam(cam);
    nx.setTime(hour);
  }, { cam: s.cam, hour: s.hour, legacy: s.legacy });
  await place(s.place);
  if (s.crowd) await crowd();
  await sleep(s.settle ?? SETTLE);

  if (s.orbit) {
    const entered = await setPhoto(true);
    await sleep(900);
    const ok = entered && await page.evaluate(({ yaw, pitch, dist }) => {
      const g = window.__neonx.game, ph = g?.photo;
      if (!ph || !ph.on) return false;
      ph.auto = false; ph.yaw = g.car.h + yaw; ph.pitch = pitch; ph.dist = dist;
      return true;
    }, s.orbit);
    if (!ok) console.log("  (photo rig not reachable — auto-orbit angle)");
    await sleep(4000);
  } else {
    // freeze the frame so OFF and ON are the same picture
    await page.evaluate(() => window.__neonx.game.setRunning(false));
    await sleep(1500);
  }
  const cam = s.orbit ? "orbit" : ["chase", "cockpit", "hood", "dashcam", "console"][s.cam];
  if (s.pair) await shoot(`${s.name}--off`, s.what, "none");
  const flags = await page.evaluate((l) => Promise.race([
    window.__neonx.vision.set(l),
    new Promise((_, rej) => setTimeout(() => rej(new Error("vision.set timed out (chunk load?)")), 90000)),
  ]), s.layers);
  await sleep(5500);
  const { probe, st } = await page.evaluate(() => ({ probe: window.__neonx.vision.probe(), st: window.__neonx.state() }));
  if (s.layers.probes) console.log(`  probe: slope ${st.slope.toFixed(3)} → pitch ${(Math.atan(st.slope) * 180 / Math.PI).toFixed(1)}°  rejF ${probe?.rejF} rejB ${probe?.rejB}  hF-hHere ${(probe.hF - probe.hHere).toFixed(2)} m`);
  const on = Object.entries(flags).filter(([k, v]) => v === true && !["oldW", "labels"].includes(k)).map(([k]) => k).join("+");
  await shoot(`${s.name}--on`, s.what, on);
  kept[kept.length - 1] && Object.assign(kept[kept.length - 1], { cam, spot: JSON.stringify(s.place), legacy: !!s.legacy, slopeDeg: Math.atan(st.slope) * 180 / Math.PI });
  await page.evaluate(async () => { await window.__neonx.vision.off(); window.__neonx.game.setRunning(true); });
}
await page.evaluate(() => window.__legacy(false));
await browser.close();

/* ------------------------------------------------------------- sheets */
const label = (text, w) => Buffer.from(
  `<svg width="${w}" height="34"><rect width="${w}" height="34" fill="#06090f"/>
   <text x="10" y="23" font-family="monospace" font-size="18" fill="#35f0ff">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`);
async function sheet(name, files, cols = 3, cw = 800) {
  if (!files.length) return null;
  const ch = Math.round(cw * 900 / 1600), rows = Math.ceil(files.length / cols);
  const tiles = [];
  for (let i = 0; i < files.length; i++) {
    const f = path.join(OUT, files[i]);
    const x = (i % cols) * cw, y = Math.floor(i / cols) * (ch + 34);
    tiles.push({ input: await sharp(f).resize(cw, ch).png().toBuffer(), left: x, top: y + 34 });
    tiles.push({ input: label(files[i].replace(/^vision-|\.png$/g, ""), cw), left: x, top: y });
  }
  const out = path.join(OUT, `sheet-${name}.png`);
  await sharp({ create: { width: cw * cols, height: rows * (ch + 34), channels: 4, background: "#000" } })
    .composite(tiles).png().toFile(out);
  console.log("  🧾", path.basename(out));
  return path.basename(out);
}
const sheets = [];
const names = kept.map((k) => k.file);
const pairs = [];
for (const k of kept) if (k.name.endsWith("--off")) {
  const on = kept.find((o) => o.name === k.name.replace(/--off$/, "--on"));
  if (on) pairs.push(k.file, on.file);
}
sheets.push(await sheet("pairs", pairs, 2, 800));
for (const [tag, pick] of [
  ["hitboxes", (n) => /hitboxes|bus-scrape/.test(n)], ["probes", (n) => /probes|parapet/.test(n)],
  ["brain", (n) => /brain/.test(n)], ["lanes", (n) => /lanes/.test(n)], ["lights", (n) => /lights/.test(n)],
  ["signs", (n) => /signs/.test(n)], ["terrain", (n) => /terrain/.test(n)], ["everything", (n) => /everything/.test(n)],
  ["broken", (n) => /BROKEN/.test(n)],
]) sheets.push(await sheet(tag, names.filter(pick), 3, 640));

/* --------------------------------------------------------------- INDEX */
const md = [
  "# What the AI sees — frame index", "",
  `${kept.length} kept, ${rejected.length} rejected (black/blown). Layers as \`window.__neonx.vision\` flags; cams: chase/cockpit/hood/dashcam or photo-mode orbit.`, "",
  "| frame | layer(s) | spot | cam | what it shows |", "|---|---|---|---|---|",
  ...kept.map((k) => `| ${k.file} | ${k.layers} | ${k.spot ?? ""}${k.legacy ? " **LEGACY KNOBS**" : ""} | ${k.cam ?? ""} | ${k.name.startsWith("BROKEN") ? "**BROKEN ON PURPOSE.** " : ""}${k.what}${k.layers === "none" ? " (overlay OFF — the 'before' half of the pair)" : ""} |`),
  "", "## Sheets", ...sheets.filter(Boolean).map((s) => `- ${s}`),
  "", "## Rejected", ...(rejected.length ? rejected.map((r) => `- ${r.name} (mean ${r.mean.toFixed(1)})`) : ["- none"]),
];
writeFileSync(path.join(OUT, "vision-INDEX.md"), md.join("\n") + "\n");
if (errors.length) { console.log("\npage errors:"); for (const e of errors.slice(0, 8)) console.log("  -", e.slice(0, 200)); }
console.log(`\n✅ ${kept.length} kept, ${rejected.length} rejected → ${OUT}`);
