/* TikTok video maker — frame-stepped game capture in, postable 1080x1920 MP4 out.

   tiktok-slides.mjs makes stills. This makes 7–15 s clips with changing
   captions, in the same type style, so a clip and a slide from the same account look like one voice.

   HOW IT CAPTURES. The build box has no GPU: a game frame through SwiftShader takes
   0.2–3 s, so recording the screen in real time is impossible. Instead the
   engine is put in FRAME-STEPPED mode (__neonx.setFixedDt, game/engine.ts —
   debug builds only): every __neonx.step() advances the sim by exactly 1/fps
   of virtual time and draws one frame, which is screenshotted. 450 stepped
   frames then assemble at 30 fps into 15 s of smooth footage no matter how
   long each one took to draw. Budget ~5–15 min per clip.

   FRAMING. The game already runs at any aspect (the phone layout), so the
   default is to render the browser at a PORTRAIT 1080x1920 viewport with the
   HUD hidden — real pixels, no crop. `portrait: "cover"` renders 16:9 and
   centre-crops; `"letterbox"` lays the 16:9 frame over a blurred fill of
   itself, like the slides do.

   CAPTIONS. Each caption is one transparent PNG (per-line black pills, Anton,
   same textLayer as the slides) overlaid by ffmpeg for its [t0,t1] window with
   a 0.15 s alpha fade either side.

   LOOPS. TikTok loops. `loop: true` makes a photo orbit span exactly one
   revolution (last frame + 1 = first frame), and a driving clip cross-fade its
   final 0.5 s into its opening 0.5 s.

   Usage:
     node tools/tiktok-video.mjs --spec clip.json --out dir/ [--loop] [--recapture] [--keep-frames] [--only name,name]

   Spec (one clip, or { "url", "clips": [ ...clips ] } for several per world load):
     {
       "name": "city-chase", "url": "http://localhost:3510",
       "fps": 30, "portrait": "native" | "cover" | "letterbox", "loop": true,
       "renderH": 1440,      browser height to render at (default 1920; smaller = faster, upscaled)
       "captureFps": 15,     step the sim at this rate and motion-interpolate up to fps (halves capture time)
       "car": "volvo" | "kaze",
       "shot": {
         "route": "corridor" | "mountain" | "bypass",
         "z": -300,            corridor z (route=corridor)
         "s": 60,              arclength (route=mountain|bypass)
         "lane": 0,            negative counts from the fast lane
         "cam": 0,             0 chase · 1 cockpit · 2 hood · 3 dashcam · 4 console
         "hour": 21.5, "hour1": 23,   hour1 = time-lapse end
         "seconds": 12, "kmh": 100, "throttle": 0.5, "steer": 0 | "auto",
         "settle": 2,          seconds of sim before frame 0 (springs, pools)
         "photoOrbit": { "yaw0": 2.55, "yaw1": 8.83, "pitch": -0.04, "dist": 5.2,
                         "pitch1"?, "dist1"? }
       },
       "captions": [ { "t0": 0, "t1": 3, "text": "…", "style": "hook" | "body", "y"?: 300 } ]
     }
   A clip whose frame folder is already full skips the browser — re-captioning
   an hour's capture takes minutes — unless --recapture says otherwise. */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "../test/lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes("--" + k);
const SPEC = arg("spec");
const OUT = arg("out", "/tmp/tiktok/video");
const FFMPEG = arg("ffmpeg", process.env.FFMPEG || "./node_modules/ffmpeg-static/ffmpeg");
if (!SPEC) { console.error("need --spec <file.json>"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = 1080, H = 1920;
const SAFE = { x: 90, y: 200, w: 810, h: 1220 };
const FADE = 0.15;

/* ---------------- captions: same look as tiktok-slides.mjs ---------------- */
const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// Anton measured at 0.41 em/char off the first encodes (the slides use 0.44)
const textW = (s, size, face) => s.length * size * (face === "Anton" ? 0.41 : 0.52);
function wrap(text, size, face, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (textW(next, size, face) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
/** Per-line pills, not one slab — TikTok's own text tool draws a box behind
    EACH line, which is why native captions look like they belong to the
    video. Copied from the slide compositor so the two match. */
function textLayer({ text, size, face, y, scrim = 0.62, stroke = 8, color = "#ffffff", track = 0, pill = true }) {
  const maxW = SAFE.w - 60;
  const lines = wrap(text, size, face, maxW);
  const lh = Math.round(size * 1.2);
  const padX = Math.round(size * 0.34), padY = Math.round(size * 0.16);
  const rx = Math.round(size * 0.18);
  const boxes = [], rows = [];
  lines.forEach((l, i) => {
    const w = Math.min(maxW, textW(l, size, face));
    const top = y + lh * i;
    const bx = Math.round(W / 2 - w / 2 - padX);
    if (pill) boxes.push(`<rect x="${bx}" y="${top}" width="${Math.round(w + padX * 2)}" height="${lh + padY}" rx="${rx}" fill="#000" fill-opacity="${scrim}"/>`);
    rows.push(`<text x="${W / 2}" y="${top + lh * 0.78}" text-anchor="middle"
       font-family="${face}" font-size="${size}" letter-spacing="${track}"
       fill="${color}" stroke="#000" stroke-width="${stroke}" stroke-linejoin="round"
       paint-order="stroke fill">${esc(l)}</text>`);
  });
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    ${boxes.join("")}${rows.join("")}
  </svg>`;
  return { svg: Buffer.from(svg), height: lines.length * lh + padY };
}

/** One caption → one transparent 1080x1920 PNG. Hooks sit at the top of the
    safe box, body lines in its lower third; `y` overrides either. */
async function captionPng(c, file) {
  const hook = (c.style || "body") === "hook";
  const size = c.size ?? (hook ? 96 : 56);
  const face = c.face || "Anton";
  const lines = wrap(c.text, size, face, SAFE.w - 60).length;
  const blockH = lines * Math.round(size * 1.2) + Math.round(size * 0.16);
  const y = c.y ?? (hook ? 300 : SAFE.y + SAFE.h - blockH - 60);
  const t = textLayer({
    text: c.text, size, face, y, color: c.color || "#ffffff",
    scrim: c.scrim ?? (hook ? 0.66 : 0.62), stroke: hook ? 10 : 8, pill: c.pill !== false,
  });
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: t.svg }]).png().toFile(file);
}

/* ---------------- ffmpeg ---------------- */
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    console.error(`${label || cmd} failed (${r.status}):\n${(r.stderr || "").slice(-3000)}`);
    throw new Error(label || cmd);
  }
  return r;
}

/** Base filter: the captured frames → a 1080x1920 yuv420p stream. */
function baseFilter(mode, pre) {
  if (mode === "cover") return `[0:v]${pre}scale=-2:${H}:flags=lanczos,crop=${W}:${H},format=yuv420p[base]`;
  if (mode === "letterbox") return [
    `[0:v]${pre}split[fa][fb]`,
    `[fa]scale=${W}:-2:flags=lanczos[fg]`,
    `[fb]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:4,eq=brightness=-0.22:saturation=1.15[bg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2-160,format=yuv420p[base]`,
  ].join(";");
  return `[0:v]${pre}scale=${W}:${H}:flags=lanczos,format=yuv420p[base]`;
}

async function assemble({ name, dir, framesDir, fps, captureFps, dur, captions, portrait, loopXfade }) {
  const out = path.join(dir, `${name}.mp4`);
  const capDir = path.join(dir, `${name}.captions`);
  mkdirSync(capDir, { recursive: true });
  const cfps = captureFps || fps;
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(cfps), "-i", path.join(framesDir, "f%05d.jpg")];
  /* captured below the output rate: motion-compensated interpolation up to
     it, on the small frames (before the upscale) where it is cheapest */
  const pre = cfps < fps ? `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,` : "";
  const chain = [baseFilter(portrait, pre)];
  let cur = "base";
  let outDur = dur;
  if (loopXfade) {
    /* the last 0.5 s dissolves into the first 0.5 s, so frame N-1 → frame 0
       is a continuous picture when the app loops the clip */
    const x = 0.5;
    outDur = dur - x;
    chain.push(`[${cur}]split[la][lb]`);
    // xfade insists on a constant frame rate, which a trim'd graph no longer declares
    chain.push(`[la]trim=start=${x},setpts=PTS-STARTPTS,fps=${fps}[la1]`);
    chain.push(`[lb]trim=end=${x},setpts=PTS-STARTPTS,fps=${fps}[lb1]`);
    chain.push(`[la1][lb1]xfade=transition=fade:duration=${x}:offset=${(dur - 2 * x).toFixed(3)}[lx]`);
    cur = "lx";
  }
  const txt = [];
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    const png = path.join(capDir, `cap${i}.png`);
    await captionPng(c, png);
    const t0 = Math.max(0, c.t0), t1 = Math.min(outDur, c.t1);
    if (t1 <= t0) continue;
    txt.push(`${t0.toFixed(2)}-${t1.toFixed(2)}  [${c.style || "body"}]  ${c.text}`);
    args.push("-framerate", String(fps), "-loop", "1", "-t", String(outDur), "-i", png);
    const idx = args.filter((a) => a === "-i").length - 1;
    const fo = Math.max(t0, t1 - FADE);
    // a caption that opens the clip is up on frame 0 — the poster is frame 0
    const fin = t0 > 0 ? `fade=t=in:st=${t0}:d=${FADE}:alpha=1,` : "";
    chain.push(`[${idx}:v]format=rgba,${fin}fade=t=out:st=${fo.toFixed(3)}:d=${FADE}:alpha=1[c${i}]`);
    chain.push(`[${cur}][c${i}]overlay=0:0:format=auto:enable='between(t,${t0},${t1})'[v${i}]`);
    cur = `v${i}`;
  }
  args.push(
    "-filter_complex", chain.join(";"), "-map", `[${cur}]`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
    "-r", String(fps), "-t", String(outDur), "-movflags", "+faststart", "-an", out,
  );
  run(FFMPEG, args, "ffmpeg encode");
  writeFileSync(path.join(dir, `${name}.captions.txt`), txt.join("\n") + "\n");
  /* poster = the clip's own first frame, captions and all */
  run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", out, "-frames:v", "1", "-update", "1", path.join(dir, `${name}.poster.png`)], "poster");
  /* contact sheet: three frames across the clip, for a review without playback */
  run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", out,
    "-vf", `select=eq(n\\,0)+eq(n\\,${Math.floor(outDur * fps / 2)})+eq(n\\,${Math.floor(outDur * fps) - 2}),scale=480:-1,tile=3x1`,
    "-frames:v", "1", "-update", "1", path.join(dir, `${name}.contact.png`)], "contact sheet");
  const probe = spawnSync(FFMPEG, ["-hide_banner", "-i", out], { encoding: "utf8" }).stderr
    .split("\n").filter((l) => /Duration|Stream #0:0/.test(l)).map((l) => l.trim()).join("\n  ");
  console.log(`  ✅ ${out}\n  ${probe}`);
  return out;
}

/* ---------------- browser ---------------- */
const HIDE_CSS = `#hud, .hud, #topbar, .topbar, #tcDrawer, #mmap, .mmapWrap, #toast, #hint, #exitHint,
  #photoHint, #clock, #wx, #spd, #runDist, #gearBtn, #swheel, #sslider, .pucks, .hudCorner,
  .recStamp, [class*="puck"], .ind { opacity: 0 !important; pointer-events: none !important; }`;

async function openWorld(browser, url, car, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(debugUrl(url), { waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
  /* the ceiling, as hero-shots does: preset + tier are consumed by the first
     build stage, so they go in BEFORE the drive button */
  await page.evaluate((car) => {
    const KEY = "neonx.profile.v3";
    const raw = localStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : { settings: {} };
    p.settings = p.settings || {};
    Object.assign(p.settings, {
      preset: "high", tierOverride: "desktop",
      reflections: true, shadows: true, bloom: true, fxaa: true, traffic: 0.85,
      autoTime: false,
    });
    // settings.ts moves a pre-garage "kaze" profile onto the default once;
    // stamping the flag first is how a deliberate kaze pick survives the load
    localStorage.setItem(KEY + ".volvodefault", "1");
    if (car) p.carId = car;
    localStorage.setItem(KEY, JSON.stringify(p));
  }, car);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b?.click();
  });
  await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 2400000 });
  await sleep(8000);
  const info = await page.evaluate(() => {
    const nx = window.__neonx, g = nx.game;
    nx.setPerfMode?.(false);
    g.timeSpeed = 0;
    try { g.grade = false; } catch {}
    return { tier: g.renderTier, perf: g.perfMode, car: g.carId, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, hasStep: !!nx.step };
  });
  console.log("  world:", JSON.stringify(info));
  if (!info.hasStep) throw new Error("engine has no __neonx.step — is this build older than the hook?");
  await page.addStyleTag({ content: HIDE_CSS });
  /* …and everything else that is not the WebGL canvas or one of its
     ancestors: the gear badge, the pause line, whatever chrome a later build
     adds. visibility, not opacity — an opacity-0 layer still rasterises. */
  await page.evaluate(() => {
    const cv = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!cv) return;
    const keep = new Set();
    for (let e = cv; e; e = e.parentElement) keep.add(e);
    for (const e of document.body.querySelectorAll("*")) {
      if (keep.has(e) || cv.contains(e)) continue;
      // siblings on the canvas's ancestor chain are chrome; descendants of the
      // container that are not the canvas are chrome too
      e.style.setProperty("visibility", "hidden", "important");
    }
  });
  return { page, errors };
}

/** Assert photo mode on/off — the O key toggles, so a blind press can land
    on the wrong side (see hero-orbit.mjs). Stepped: the loop is not running,
    so each attempt draws one frame for the state to land in. */
async function setPhoto(page, want) {
  for (let t = 0; t < 3; t++) {
    const on = await page.evaluate(() => !!window.__neonx.state().photo);
    if (on === want) return true;
    await page.keyboard.press("o");
    await sleep(400);
    await page.evaluate(() => window.__neonx.step());
  }
  return (await page.evaluate(() => !!window.__neonx.state().photo)) === want;
}

/* Place the car per the shot, from a parked state. */
async function placeCar(page, shot) {
  await page.evaluate((shot) => {
    const nx = window.__neonx, g = nx.game;
    const kmh = shot.kmh ?? 100;
    const route = shot.route || "corridor";
    if (route === "mountain") nx.toMountain(shot.s ?? 40, kmh, shot.lane ?? 0);
    else if (route === "bypass") nx.toBypass(shot.s ?? 60, kmh, shot.lane ?? 0);
    else {
      const c = g.terrain.corridor;
      const z = shot.z ?? -300, lane = shot.lane ?? 0;
      const n = c.lanes(z);
      const k = Math.min(n - 1, Math.max(0, lane < 0 ? n + lane : lane));
      const p = c.worldOf(z, c.laneOffset(k, z));
      nx.teleport(p.x, p.z, p.y + 0.2, c.pose(z).h, kmh / 3.6);
    }
    nx.setCam(shot.cam ?? 0);
    nx.setTime(shot.hour ?? 21.5);
    nx.setInput({ th: shot.throttle ?? 0.5, st: typeof shot.steer === "number" ? shot.steer : 0 });
  }, shot);
}

/* Pure-pursuit lane follow, run in the page every frame when steer="auto":
   aim at the lane centre L metres ahead and steer on the heading error.
   Forward is (sin h, cos h) and +st raises h (physics.ts), so the sign is
   direct. Corridor is parametrised by z, the poly routes by arclength. */
const AUTO_STEER = `(() => {
  const nx = window.__neonx, g = nx.game, car = g.car;
  const u = Math.max(5, Math.abs(car.u));
  const L = 10 + u * 0.55;
  const fx = Math.sin(car.h), fz = Math.cos(car.h);
  let tx, tz;
  if (ROUTE === "corridor") {
    const c = g.terrain.corridor;
    const z = c.zAt(car.x, car.z);
    const n = c.lanes(z);
    const k = Math.min(n - 1, Math.max(0, LANE < 0 ? n + LANE : LANE));
    const a = c.worldOf(z + L, c.laneOffset(k, z + L));
    const b = c.worldOf(z - L, c.laneOffset(k, z - L));
    const da = (a.x - car.x) * fx + (a.z - car.z) * fz;
    const db = (b.x - car.x) * fx + (b.z - car.z) * fz;
    const p = da >= db ? a : b;
    tx = p.x; tz = p.z;
  } else {
    const e = g.world.routes[ROUTE === "mountain" ? "mtn" : "bypass"];
    const pr = e.project(car.x, car.z, 80);
    if (!pr) return 0;
    const dir = ROUTE === "mountain" && LANE === 1 ? -1 : 1;
    const s = Math.max(2, Math.min(e.len - 2, pr.s + dir * L));
    const p = e.worldOf(s, e.laneOffset(LANE, s));
    tx = p.x; tz = p.z;
  }
  const hT = Math.atan2(tx - car.x, tz - car.z);
  let err = hT - car.h;
  while (err > Math.PI) err -= 2 * Math.PI;
  while (err < -Math.PI) err += 2 * Math.PI;
  const st = Math.max(-1, Math.min(1, err * GAIN));
  nx.setInput({ th: TH, st });
  return st;
})()`;

async function captureClip(page, clip, framesDir) {
  const shot = clip.shot || {};
  const fps = clip.captureFps || clip.fps || 30;
  const seconds = Math.min(15, Math.max(1, shot.seconds ?? 10));
  const N = Math.round(seconds * fps);
  const orbit = shot.photoOrbit || null;
  const loop = !!clip.loop;
  mkdirSync(framesDir, { recursive: true });

  await page.evaluate(() => window.__neonx.setFixedDt(0.1));
  await setPhoto(page, false);
  await placeCar(page, shot);
  /* settle at a coarse step: chase spring, streetlight pools, aurora */
  const settleN = Math.round((shot.settle ?? 2) / 0.1);
  const ts = Date.now();
  for (let i = 0; i < settleN; i++) await page.evaluate(() => window.__neonx.step());
  if (settleN) console.log(`  settled ${settleN} steps, ${((Date.now() - ts) / settleN / 1000).toFixed(1)} s/step`);

  let yaw0 = 0, yaw1 = 0;
  if (orbit) {
    const entered = await setPhoto(page, true);
    if (!entered) throw new Error("photo mode did not engage");
    yaw0 = orbit.yaw0 ?? 2.55;
    yaw1 = orbit.yaw1 ?? yaw0 + Math.PI / 2;
    if (loop) yaw1 = yaw0 + Math.PI * 2 * Math.sign(yaw1 - yaw0 || 1);
    await page.evaluate(({ pitch, dist }) => {
      const g = window.__neonx.game, ph = g.photo;
      ph.auto = false; ph.pitch = pitch; ph.dist = dist;
    }, { pitch: orbit.pitch ?? 0.2, dist: orbit.dist ?? 6 });
    await sleep(2500); // the PHOTO MODE toast is wall-clock
  }
  await page.evaluate((dt) => window.__neonx.setFixedDt(dt), 1 / fps);

  const autoSteer = shot.steer === "auto";
  const steerJs = AUTO_STEER
    .replace(/ROUTE/g, JSON.stringify(shot.route || "corridor"))
    .replace(/LANE/g, String(shot.lane ?? 0))
    .replace(/GAIN/g, String(shot.steerGain ?? 2.2))
    .replace(/TH/g, String(shot.throttle ?? 0.5));

  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const f = i / N; // loop-friendly: the frame AFTER the last is frame 0
    const fl = N > 1 ? i / (N - 1) : 0;
    await page.evaluate(({ orbit, f, fl, yaw0, yaw1, hour, hour1, loop, i }) => {
      const nx = window.__neonx, g = nx.game;
      if (orbit) {
        const ph = g.photo;
        const k = loop ? f : fl;
        ph.auto = false;
        ph.yaw = g.car.h + yaw0 + (yaw1 - yaw0) * k;
        if (orbit.pitch1 !== undefined) ph.pitch = orbit.pitch + (orbit.pitch1 - orbit.pitch) * fl;
        if (orbit.dist1 !== undefined) ph.dist = orbit.dist + (orbit.dist1 - orbit.dist) * fl;
      }
      // hour1 may pass midnight (22 → 30 = 06:00); the engine's clock is 0..24
      if (hour1 !== undefined) nx.setTime(((hour + (hour1 - hour) * fl) % 24 + 24) % 24);
    }, { orbit, f, fl, yaw0, yaw1, hour: shot.hour ?? 21.5, hour1: shot.hour1, loop, i });
    if (autoSteer && !orbit) await page.evaluate(steerJs);
    await page.evaluate(() => window.__neonx.step());
    await page.screenshot({ path: path.join(framesDir, `f${String(i).padStart(5, "0")}.jpg`), type: "jpeg", quality: 94 });
    if (i % 30 === 29 || i === N - 1) {
      const el = (Date.now() - t0) / 1000, eta = (el / (i + 1)) * (N - i - 1);
      const st = await page.evaluate(() => { const s = window.__neonx.state(); return `${s.kmh.toFixed(0)} km/h`; });
      console.log(`  frame ${i + 1}/${N}  ${el.toFixed(0)}s  eta ${eta.toFixed(0)}s  ${st}`);
    }
  }
  /* teardown is best-effort: every frame is on disk by now, and a tab that
     dies here must not read as a failed capture (it did once, and the retry
     wiped 80 minutes of frames) */
  try {
    await page.evaluate(() => window.__neonx.setFixedDt(0));
    await setPhoto(page, false);
  } catch {}
  return { N, seconds, fps };
}

/* ---------------- main ---------------- */
const specRaw = JSON.parse(readFileSync(SPEC, "utf8"));
const clips = (specRaw.clips || [specRaw]).map((c, i) => ({
  url: specRaw.url, fps: specRaw.fps, portrait: specRaw.portrait, car: specRaw.car, loop: specRaw.loop,
  renderH: specRaw.renderH, captureFps: specRaw.captureFps,
  ...c, name: c.name || `clip${i + 1}`,
}));
const ONLY = arg("only", "");
const todo = ONLY ? clips.filter((c) => ONLY.split(",").includes(c.name)) : clips;
if (has("loop")) for (const c of todo) c.loop = true;

let browser = null, page = null, curCar = null, curH = 0, errors = [];
const results = [];
for (const clip of todo) {
  const fps = clip.fps || 30;
  const captureFps = clip.captureFps || fps;
  const portrait = clip.portrait || "native";
  const seconds = Math.min(15, Math.max(1, clip.shot?.seconds ?? 10));
  const N = Math.round(seconds * captureFps);
  const framesDir = path.join(OUT, `${clip.name}.frames`);
  const have = existsSync(framesDir) ? readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).length : 0;
  console.log(`\n▶ ${clip.name}  ${seconds}s @ ${fps}fps${captureFps !== fps ? ` (captured @ ${captureFps})` : ""}  ${portrait}${clip.loop ? "  loop" : ""}`);
  /* A full frame folder is never re-captured unless --recapture says so: a
     capture is the expensive half by two orders of magnitude, and the
     encode can always be re-run on top of it. */
  if (have < N || has("recapture")) {
    const car = clip.car || "volvo";
    for (let attempt = 0; ; attempt++) try {
    rmSync(framesDir, { recursive: true, force: true });
    if (!browser) {
      browser = await puppeteer.launch({
        executablePath: "/opt/pw-browsers/chromium",
        args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
        protocolTimeout: 0, timeout: 180000,
      });
    }
    if (!page || car !== curCar || (clip.renderH || H) !== curH) {
      if (page) await page.close();
      /* renderH < 1920 renders smaller and lets ffmpeg upscale (lanczos) —
         SwiftShader time goes with pixels, and a 1.33x upscale is invisible
         after TikTok's own re-encode. Cover/letterbox render 16:9. */
      const rh = clip.renderH || H;
      const vp = portrait === "native"
        ? { width: Math.round(rh * 9 / 16 / 2) * 2, height: rh, deviceScaleFactor: 1 }
        : { width: Math.round(rh * 16 / 9 / 2) * 2, height: rh, deviceScaleFactor: 1 };
      const url = clip.url || "http://localhost:3510";
      console.log(`  loading world (car=${car}, ${vp.width}x${vp.height}@${vp.deviceScaleFactor}) …`);
      ({ page, errors } = await openWorld(browser, url, car, vp));
      curCar = car;
      curH = clip.renderH || H;
    }
    await captureClip(page, clip, framesDir);
    break;
    } catch (e) {
      /* a tab that dies under memory pressure mid-load shows up as a detached
         frame or a closed target; one relaunch is worth more than a report */
      console.log(`  ✗ ${clip.name} attempt ${attempt + 1}: ${String(e.message || e).slice(0, 160)}`);
      try { await browser?.close(); } catch {}
      browser = null; page = null; curCar = null;
      const got = existsSync(framesDir) ? readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).length : 0;
      if (got >= N) { console.log(`  frames complete (${got}) — keeping them`); break; }
      if (attempt >= 1) throw e;
    }
  } else console.log(`  reusing ${have} frames`);
  const out = await assemble({
    name: clip.name, dir: OUT, framesDir, fps, captureFps, dur: seconds,
    captions: clip.captions || [], portrait, loopXfade: !!clip.loop && !clip.shot?.photoOrbit,
  });
  if (!has("keep-frames")) rmSync(framesDir, { recursive: true, force: true });
  results.push(out);
}
if (browser) await browser.close();
if (errors.length) {
  console.log("\npage errors:");
  for (const e of errors.slice(0, 6)) console.log("  -", e.slice(0, 200));
}
console.log(`\n✅ ${results.length} clip(s) in ${OUT}`);
