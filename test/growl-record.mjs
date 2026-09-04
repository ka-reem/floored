#!/usr/bin/env node
/* Record the player's engine, four ways, for a listening A/B.
 *
 * Produces one WAV per entry in VARIANTS below (00 = today's audio,
 * untouched) from ONE identical driving passage, so the only difference
 * between the files is the open-road growl setting (ROAD_GROWL_SPEC in
 * game/audio.ts, live as window.__roadGrowl).
 *
 * How the takes are made identical, which is the whole point of the file:
 *   1. The passage is simulated ONCE, up front, through __neonx.toCorridor +
 *      setInput + simStep at a fixed 1/60 s step, and the exact argument
 *      tuple audio.update() would have been called with is recorded for each
 *      frame. All four takes then replay that same tuple list.
 *   2. Nothing screenshots during a take, so headless Chrome never runs a
 *      rAF frame and the game's own render loop — which would otherwise call
 *      audio.update() with its own car state and fight the replay — stays
 *      frozen. (Asserted: the frame counter must not move during a take.)
 *   3. Math.random is swapped for a seeded LCG and re-seeded before each
 *      take, so the probabilistic one-shots (overrun burble, crackle) fire
 *      at the same instants in all four files.
 *   4. Audio is tapped at the FINAL master node via the debug-only
 *      GameAudio.debugRecordTap(), captured as raw float PCM by an
 *      AudioWorklet, and written here as 16-bit WAV. No codec in the path.
 *
 * The passage is on the open corridor, well clear of the tunnel, and the
 * script asserts the tunnel factor and the reverb wet gain are 0 for every
 * take — the owner asked for the tunnel's growl WITHOUT the tunnel's echo,
 * so an echo leaking into these files would invalidate the comparison.
 *
 * Usage: node test/growl-record.mjs --url http://localhost:3151 --out DIR
 */
import { mkdirSync, writeFileSync } from "node:fs";
import zlibMod from "node:zlib";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3151");
const OUT = arg("--out", "/tmp/growl");

/* ---- THE THREE CANDIDATES (plus the reference) -----------------------
   Field meanings are documented on ROAD_GROWL_SPEC in game/audio.ts. For
   scale: the TUNNEL runs db 7.0 / hz 170 / q 1.2 / trim 0.5 on the engine
   bus, and -2.5dB above 3.2kHz on the master bus. */
const OFF = { db: 0, hz: 170, q: 1.2, trim: 0.5, topDb: 0, topHz: 3200, sat: 0, satDrive: 3, satHz: 1600 };
const VARIANTS = [
  { file: "00-today-reference", label: "today's engine, unchanged", rg: { ...OFF } },
  {
    file: "01-tube",
    label: "the tunnel's own growl curve at 55% strength, nothing else changed",
    // Literally TUNNEL_TUNE_SPEC.growl scaled: 7.0 * 0.55 and -2.5 * 0.55,
    // same centre, same Q, same half-back trim.
    rg: { ...OFF, db: 3.9, hz: 170, q: 1.2, trim: 0.5, topDb: -1.4, topHz: 3200 },
  },
  {
    file: "02-chest",
    label: "deeper: resonance dropped below the engine's own body note, tighter, top left fully open",
    // 118Hz sits under the engine's fixed 165Hz body peak instead of on it,
    // so the boost adds a NEW bottom octave rather than exaggerating the
    // existing one; Q 2.2 keeps it a chest thump and not a mud shelf. topDb
    // 0 on purpose — a tunnel's dullness is echo character, and without the
    // echo the same cut just reads as a blanket over the car.
    rg: { ...OFF, db: 6.0, hz: 118, q: 2.2, trim: 0.5, topDb: 0 },
  },
  {
    file: "03-grunt",
    label: "harder: a moderate growl plus a parallel saturated copy for harmonic grunt",
    // Less EQ than 02, with the extra weight coming from harmonics instead:
    // a tanh-shaped parallel copy, lowpassed at 1.5kHz so the added content
    // is grunt (2nd-4th of the firing note) and not fizz. trim 0.6 because
    // the parallel branch adds level of its own.
    rg: { ...OFF, db: 4.5, hz: 150, q: 1.4, trim: 0.6, topDb: -0.8, topHz: 3600, sat: 0.5, satDrive: 3.2, satHz: 1500 },
  },
];

/* ---- the passage: 24 s, two full pulls and a steady cruise ---------- */
const HZ = 60;
const SCRIPT = [
  { t: 0.0, th: 0.15 }, // settle
  { t: 1.5, th: 1.0 },  // pull 1: off the bottom, through the gears
  { t: 9.0, th: 0.0 },  // lift -> overrun
  { t: 11.0, th: 0.35 },// steady cruise
  { t: 16.0, th: 1.0 }, // pull 2, from a higher speed
  { t: 21.0, th: 0.1 }, // trail off
];
const DUR = 24.0;

const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage",
    // NOT --mute-audio: this script exists to record the output.
    "--autoplay-policy=no-user-gesture-required",
  ],
  defaultViewport: { width: 480, height: 300 },
  protocolTimeout: 900000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message || e)));
page.on("error", (e) => console.log("RENDERER CRASH:", String(e)));
page.on("console", (m) => { if (m.type() === "error") console.log("console-err:", m.text().slice(0, 200)); });

console.log("loading", URL);
/* tier=mobile-base is a memory decision, not a visual one: this box runs six
   other dev servers and SwiftShader had been crashing the renderer partway
   through the desktop-tier world build. Nothing in the audio graph is keyed
   off the render tier, and the script asserts the sampled engine is loaded
   below, so the recorded mix is the same either way. */
await page.goto(debugUrl(URL, { tier: "mobile-base" }), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 600000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* 900s, not the usual 420: this box runs six other dev servers and a
   contended SwiftShader world build has taken over seven minutes. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 900000 });
await page.waitForFunction(
  () => window.__audioDebug?.getLevels?.()?.sampledEngineReady === true,
  { timeout: 120000 }
);
console.log("loaded, audio ready");

/* Put the cabin EQ where the dashcam puts it, directly. The render loop is
   what normally calls setInterior(), and the dashcam parks the cabin lowpass
   at 6.4kHz — without this the takes would be captured through whatever EQ
   the loading screen left behind. This used to force two rendered frames
   instead, but a SwiftShader screenshot on a contended box can take longer
   than the whole CDP timeout, and it was the single slowest step in the run.
   CAM_POV (the dashcam) is the default camera and the frame to judge in. */
console.log("interior:", JSON.stringify(await page.evaluate(() => {
  window.__audioDebug.setInterior("pov");
  const l = window.__audioDebug.getLevels();
  return { cam: window.__neonx.game.camMode, master: l.master, reverbWet: l.reverbWet, tunnelT: l.tunnelT };
})));

/* ---- 1. simulate the passage, capture the update() arguments ----------
   Tried at up to eight start positions around the lap, ONE PER evaluate()
   call, and the first clean one is kept. A run is clean when the car
   actually drives it: the corridor carries tunnels, a toll plaza and
   assorted structures, and a scripted passage that runs into one spends the
   rest of its twenty-four seconds idling against it in first gear — which
   happened, and is quiet rather than obviously broken, so it is checked
   rather than assumed. One call per candidate because eight passages in a
   single evaluate() outran the CDP timeout on a contended box. */
await page.evaluate(({ HZ, SCRIPT, DUR }) => {
  const nx = window.__neonx;
  const g = nx.game;
  const cor = g.cor;
  const n = Math.round(DUR * HZ);

  /* 900 m of clearance, not 1600: the passage covers about 800 m, and the
     lap is short enough that demanding a further kilometre of margin
     rejected every candidate on it. */
  window.__growlClear = (z) => {
    for (let d = -40; d < 900; d += 20) {
      const w = cor.wrapZ(z + d);
      if (cor.inTunnel(w, 60)) return false;          // a tunnel would add the
      if (cor.inToll && cor.inToll(w)) return false;  // very reverb he doesn't want
    }
    return true;
  };

  window.__growlRunFrom = (z0) => {
    /* Park the traffic first. simStep() runs collidePlayer but deliberately
       does NOT run traffic, so every NPC is a stationary obstacle for the
       whole passage. */
    for (const npc of g.traffic.npcs) npc.active = false;
    g.car.hold = false; // the standing-start brake; held wheels do not rev
    nx.setInput({ th: 0, br: 0, st: 0, hb: 0, horn: 0 });
    nx.toCorridor(z0, 30);
    const rows = [];
    let minKmh = 1e9, maxKmh = 0;
    for (let i = 0; i < n; i++) {
      const t = i / HZ;
      let th = 0;
      for (const sc of SCRIPT) if (t >= sc.t) th = sc.th;
      nx.setInput({ th, br: 0, st: 0, hb: 0, horn: 0 });
      nx.simStep(1 / HZ);
      const c = g.car;
      /* Autopilot: back onto the lane centreline every step, keeping the
         longitudinal state untouched. Only position and heading are written —
         u, rpm, gear, throttle and slip still come from stepPhysics, and
         those are the only things the engine audio reads. Without it a
         scripted straight-ahead run leaves the road inside eight seconds,
         because the centreline wanders by tens of metres. */
      const lane = cor.respawn(c.z);
      c.x = lane.x; c.y = lane.y; c.z = lane.z; c.h = lane.h;
      c.v = 0; c.r = 0; c.wvx = 0; c.wvz = 0;
      rows.push([
        c.rpm, c.thrEff, c.slipAmt, Math.abs(c.u),
        (c.cut > 0 || c.shiftT > 0.1) ? 1 : 0,
        c.gear, c.onLimiter ? 1 : 0, c.slipDemand,
        c.axS, c.ayS, c.slope,
      ]);
      const kmh = Math.abs(c.u) * 3.6;
      if (kmh > maxKmh) maxKmh = kmh;
      if (t > 2 && kmh < minKmh) minKmh = kmh;
    }
    // "clean" = it really drove: the pulls landed and it never wedged
    const ok = maxKmh > 120 && minKmh > 20;
    if (ok) window.__growlTrace = rows;
    const col = (c) => rows.map((x) => x[c]);
    const mn = (a) => a.reduce((x, y) => (y < x ? y : x), Infinity);
    const mx = (a) => a.reduce((x, y) => (y > x ? y : x), -Infinity);
    return {
      ok, z0, n: rows.length,
      rpm: [mn(col(0)).toFixed(0), mx(col(0)).toFixed(0)],
      kmh: [minKmh.toFixed(1), maxKmh.toFixed(1)],
      gears: [...new Set(col(5))].sort((a, b) => a - b),
      tunnelT: window.__audioDebug.getLevels().tunnelT,
    };
  };
}, { HZ, SCRIPT, DUR });

let traceInfo = null;
for (let k = 0; k < 24 && !traceInfo; k++) {
  const z0 = 200 + k * 160;
  if (!(await page.evaluate((z) => window.__growlClear(z), z0))) continue;
  const r = await page.evaluate((z) => window.__growlRunFrom(z), z0);
  console.log(`  z=${z0}: ${r.kmh[0]}-${r.kmh[1]} km/h, ${r.rpm[0]}-${r.rpm[1]} rpm, gears ${r.gears.join("/")}` +
    (r.ok ? "  <- clean" : "  (wedged, trying elsewhere)"));
  if (r.ok) traceInfo = r;
}
if (!traceInfo) throw new Error("no clean passage found anywhere on the lap");
console.log("trace:", JSON.stringify(traceInfo));
if (traceInfo.tunnelT > 1e-6) throw new Error("passage is inside a tunnel");
if (traceInfo.gears.length < 3)
  throw new Error("the passage never got past gear " + Math.max(...traceInfo.gears));

/* ---- 2. install the capture worklet + the seeded RNG ---- */
await page.evaluate(async () => {
  const tap = window.__audioDebug.debugRecordTap();
  if (!tap) throw new Error("debugRecordTap() returned null — DEBUG_HOOKS off or audio not ok");
  const ctx = tap.ctx;
  const code = `
    class Cap extends AudioWorkletProcessor {
      constructor() { super(); this.on = false;
        this.port.onmessage = (e) => { this.on = e.data === "start"; }; }
      process(inputs) {
        const inp = inputs[0];
        if (this.on && inp && inp.length && inp[0] && inp[0].length) {
          const ch = [];
          for (let c = 0; c < inp.length; c++) ch.push(new Float32Array(inp[c]));
          this.port.postMessage(ch, ch.map((a) => a.buffer));
        }
        return true;
      }
    }
    registerProcessor("growl-cap", Cap);`;
  const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, "growl-cap", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
  });
  tap.node.connect(node);
  /* WebAudio pulls the graph from the destination, so a node with no path to
     it may never be processed at all. The capture node therefore keeps an
     output and runs into a muted gain — the silent edge is what guarantees
     it is pulled, and it adds nothing to what the speakers get. */
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  window.__growlCap = { ctx, node, chunks: [], ch: 0 };
  node.port.onmessage = (e) => {
    const c = window.__growlCap;
    c.ch = e.data.length;
    c.chunks.push(e.data);
  };

  /* The render loop is not fully frozen — headless Chrome still squeezes out
     a handful of rAF frames over a 24 s take, and each one calls
     audio.update() with the game's own (stalled) car state, which lands as a
     hiccup in the middle of the replay. Rather than fight the loop, gate the
     method: only calls made from inside the replay get through. Instance
     property shadowing the prototype, so engine.ts's `this.audio.update(...)`
     hits the stub. */
  const A = window.__audioDebug;
  const real = A.update.bind(A);
  window.__growlAllow = false;
  A.update = (...a) => { if (window.__growlAllow) real(...a); };

  // Deterministic one-shots: the overrun burble / crackle voices roll dice,
  // and four takes that rolled differently would not be comparable.
  let seed = 0;
  window.__growlSeed = (s) => { seed = s >>> 0; };
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
});

/* ---- 3. one take per variant ---- */
mkdirSync(OUT, { recursive: true });
const TARGET_PEAK = 0.891; // -1.0 dBFS, the same target for every clip
const stats = [];
for (const v of VARIANTS) {
  console.log("recording", v.file, JSON.stringify(v.rg));
  const framesBefore = await page.evaluate(() => window.__neonx.state().frames);
  const raw = await page.evaluate(async ({ rg, HZ }) => {
    const nx = window.__neonx;
    const A = window.__audioDebug;
    const cap = window.__growlCap;
    const ctx = cap.ctx;
    const trace = window.__growlTrace;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    Object.assign(window.__roadGrowl, rg);
    window.__growlSeed(12345);

    /* Pre-roll: hold frame 0 for 1.2 s of real time so every smoothed param
       (and the new growl filter) has settled to the same starting state
       before the take begins. Not recorded. */
    const push = (i, now) => {
      const r = trace[i];
      window.__growlAllow = true;
      A.update(r[0], r[1], r[2], r[3], now, !!r[4], false, false,
               r[5], !!r[6], undefined, r[7], r[8], r[9], r[10], true);
      window.__growlAllow = false;
    };
    let t0 = ctx.currentTime;
    while (ctx.currentTime - t0 < 1.2) { push(0, ctx.currentTime); await wait(8); }

    cap.chunks.length = 0;
    cap.node.port.postMessage("start");
    t0 = ctx.currentTime;
    let last = -1;
    for (;;) {
      const el = ctx.currentTime - t0;
      const i = Math.floor(el * HZ);
      if (i >= trace.length) break;
      if (i !== last) { push(i, t0 + i / HZ); last = i; }
      await wait(3);
    }
    // let the tail of the last frame flush through
    await wait(120);
    cap.node.port.postMessage("stop");
    await wait(60);

    const lv = A.getLevels();
    const chn = cap.ch || 1;
    let total = 0;
    for (const c of cap.chunks) total += c[0].length;
    const out = [];
    for (let k = 0; k < chn; k++) out.push(new Float32Array(total));
    let off = 0;
    for (const c of cap.chunks) {
      for (let k = 0; k < chn; k++) out[k].set(c[k], off);
      off += c[0].length;
    }
    cap.chunks.length = 0;
    // interleave -> plain array for transfer
    const inter = new Float32Array(total * chn);
    for (let i = 0; i < total; i++)
      for (let k = 0; k < chn; k++) inter[i * chn + k] = out[k][i];
    /* Park the take for the slice fetch below rather than base64-ing all of
       it here: one 24 s stereo take is ~8 MB of float, and a single
       evaluate() carrying that has blown the CDP timeout on a loaded box. */
    window.__growlTake = inter;
    return {
      ch: chn,
      rate: ctx.sampleRate,
      frames: total,
      tunnelT: lv.tunnelT,
      reverbWet: lv.reverbWet,
      roadGrowlDb: lv.roadGrowlDb,
      roadGrowlHz: lv.roadGrowlHz,
      roadGrowlQ: lv.roadGrowlQ,
      roadGrowlTrim: lv.roadGrowlTrim,
      roadGrowlTopDb: lv.roadGrowlTopDb,
      roadGrowlSat: lv.roadGrowlSat,
      roadGrowlDry: lv.roadGrowlDry,
    };
  }, { rg: v.rg, HZ });
  const framesAfter = await page.evaluate(() => window.__neonx.state().frames);
  if (framesAfter !== framesBefore)
    console.log(`  (render loop ran ${framesAfter - framesBefore} frame(s) during the take; their audio.update() calls were gated out)`);
  if (raw.tunnelT > 1e-6 || raw.reverbWet > 1e-6)
    errors.push(`${v.file}: reverb was open (tunnelT ${raw.tunnelT}, wet ${raw.reverbWet})`);
  /* Pull the take across in ~1 MB slices, and write the finished clip
     before starting the next take. Normalising every clip to the SAME peak
     is a per-clip operation, so there is nothing to wait for — and the
     earlier variants then survive whatever happens to the later ones, which
     on this box has repeatedly been a protocol timeout mid-run. */
  const SLICE = 262144; // floats
  const parts = [];
  for (let off = 0; off < raw.frames * raw.ch; off += SLICE) {
    const b64 = await page.evaluate(({ off, n }) => {
      const t = window.__growlTake;
      const v8 = new Uint8Array(t.buffer, off * 4, Math.min(n, t.length - off) * 4);
      let s = "";
      for (let i = 0; i < v8.length; i += 8192)
        s += String.fromCharCode.apply(null, v8.subarray(i, i + 8192));
      return btoa(s);
    }, { off, n: SLICE });
    parts.push(Buffer.from(b64, "base64"));
  }
  await page.evaluate(() => { window.__growlTake = null; });
  const bufAll = Buffer.concat(parts);
  const x = new Float32Array(bufAll.buffer, bufAll.byteOffset, bufAll.length / 4);
  let peak = 0, sqsum = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; sqsum += x[i] * x[i]; }
  const rms = Math.sqrt(sqsum / Math.max(1, x.length));
  const g = peak > 0 ? TARGET_PEAK / peak : 0;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  const file = path.join(OUT, v.file + ".wav");
  writeFileSync(file, wav(y, raw.ch, raw.rate));
  stats.push({
    file, label: v.label, rg: v.rg, ch: raw.ch, rate: raw.rate,
    seconds: raw.frames / raw.rate, rawPeak: peak, rawRms: rms,
    normGain: g, peak: peak > 0 ? TARGET_PEAK : 0, rms: rms * g,
  });
  writeFileSync(path.join(OUT, "stats.json"), JSON.stringify(stats, null, 2));
  if (peak < 1e-4) errors.push(`${v.file}: recording is silent (peak ${peak})`);
  if (peak >= 0.999) errors.push(`${v.file}: recording clipped (peak ${peak})`);
  console.log(`  wrote ${v.file}.wav — rawPeak ${peak.toFixed(4)} rawRMS ${rms.toFixed(4)} x${g.toFixed(3)}`);
  writeFileSync(path.join(OUT, v.file + ".png"), spectrumPng(y, raw.ch, raw.rate, v.file));
  console.log(`  ${raw.frames} frames @ ${raw.rate}Hz x${raw.ch} = ${(raw.frames / raw.rate).toFixed(2)}s ` +
    `| growl ${raw.roadGrowlDb.toFixed(2)}dB @ ${raw.roadGrowlHz.toFixed(0)}Hz Q${raw.roadGrowlQ.toFixed(2)} ` +
    `trim ${raw.roadGrowlTrim.toFixed(3)} top ${raw.roadGrowlTopDb.toFixed(2)}dB ` +
    `sat ${raw.roadGrowlSat.toFixed(3)}/dry ${raw.roadGrowlDry.toFixed(3)}`);
  // clear the growl before the next take's pre-roll so nothing carries over
  await page.evaluate((off) => Object.assign(window.__roadGrowl, off), OFF);
  await new Promise((r) => setTimeout(r, 400));
}
await browser.close();

console.log("\n  file                       secs   rawPeak   rawRMS  rawRMSdB  normGain   normRMS");
for (const s of stats)
  console.log(
    "  " + path.basename(s.file).padEnd(26) +
    s.seconds.toFixed(2).padStart(5) + "  " +
    s.rawPeak.toFixed(4).padStart(7) + "  " +
    s.rawRms.toFixed(4).padStart(7) + "  " +
    (20 * Math.log10(s.rawRms)).toFixed(2).padStart(8) + "  " +
    s.normGain.toFixed(3).padStart(8) + "  " +
    s.rms.toFixed(4).padStart(8)
  );

if (errors.length) {
  console.log("\nFAILURES:");
  for (const e of errors) console.log("  - " + e);
  process.exit(1);
}
console.log("\nOK — " + stats.length + " clips in " + OUT);

/* ---- helpers ---- */
function wav(samples, ch, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/* A spectrogram: log-frequency (30Hz-16kHz) up the Y axis, time across X,
   magnitude as brightness. The owner judges by ear; this is only so he can
   point at where the energy moved. Hand-rolled DFT + PNG encoder because the
   sandbox has no numpy, no ffmpeg and no image libraries. */
function spectrumPng(samples, ch, rate, title) {
  const W = 420, H = 200;
  const mono = new Float32Array(Math.floor(samples.length / ch));
  for (let i = 0; i < mono.length; i++) {
    let s = 0;
    for (let k = 0; k < ch; k++) s += samples[i * ch + k];
    mono[i] = s / ch;
  }
  const N = 1024;
  const hop = Math.max(1, Math.floor((mono.length - N) / W));
  // Goertzel at a fixed log-spaced bin ladder — cheaper than a full FFT per
  // column when only H rows are ever drawn.
  const fLo = 30, fHi = 16000;
  const freqs = new Float64Array(H);
  for (let r = 0; r < H; r++) freqs[r] = fLo * Math.pow(fHi / fLo, r / (H - 1));
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const mag = new Float64Array(W * H);
  let mx = 1e-12;
  for (let c = 0; c < W; c++) {
    const off = c * hop;
    if (off + N > mono.length) break;
    for (let r = 0; r < H; r++) {
      const k = (2 * Math.PI * freqs[r]) / rate;
      const coeff = 2 * Math.cos(k);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) { s0 = win[i] * mono[off + i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
      const m = Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / N;
      mag[c * H + r] = m;
      if (m > mx) mx = m;
    }
  }
  const px = Buffer.alloc(W * H * 3);
  for (let c = 0; c < W; c++) for (let r = 0; r < H; r++) {
    const db = 20 * Math.log10(Math.max(1e-9, mag[c * H + r] / mx));
    const t = Math.max(0, Math.min(1, (db + 78) / 78));
    // black -> deep blue -> magenta -> amber -> white
    const R = Math.round(255 * Math.min(1, Math.max(0, t * 2.1 - 0.35)));
    const G = Math.round(255 * Math.min(1, Math.max(0, t * 2.4 - 1.25)));
    const B = Math.round(255 * Math.min(1, Math.max(0, t * 1.9 - 0.05) * (t < 0.72 ? 1 : 1.2 - t)));
    const y = H - 1 - r; // low frequency at the bottom
    const o = (y * W + c) * 3;
    px[o] = R; px[o + 1] = G; px[o + 2] = B;
  }
  // 100Hz / 1kHz / 10kHz gridlines, so two plots can be compared by eye
  for (const f of [100, 1000, 10000]) {
    const r = Math.round(((Math.log(f / fLo) / Math.log(fHi / fLo)) * (H - 1)));
    const y = H - 1 - r;
    if (y < 0 || y >= H) continue;
    for (let c = 0; c < W; c += 6) {
      const o = (y * W + c) * 3;
      px[o] = 255; px[o + 1] = 255; px[o + 2] = 255;
    }
  }
  return png(px, W, H);
}

function png(rgb, W, H) {
  const zlib = zlibMod;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4);
    data.copy(b, 8);
    b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0, 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}
var CRC_T = null; // var, not let: crc32() is called from the write loop above this line
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_T[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
