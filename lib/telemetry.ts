/* Drive telemetry — the replay that is not a video.

   The point is to be able to watch testers play. PostHog session replay
   records the DOM, and this game is one <canvas>, so a replay without canvas capture is a
   black rectangle where the driving is. Canvas capture is on for desktop only
   (see lib/analytics.ts): reading the canvas back forces a GPU pipeline sync,
   four times a second, on exactly the phones that have no frame time spare.

   So this records STATE instead of PIXELS. Twice a second-ish the car's
   position, heading and speed are appended to a flat number array; every 30 s
   that array is encoded into one short string and shipped as a normal
   `drive_trace` event. There is nothing to read back from the GPU, nothing to
   encode, nothing per frame — it costs a boolean test on a 6.25 Hz tick when
   it is off, and a handful of rounded numbers when it is on. It works on every
   device and covers every session rather than a sample.

   Read back by test/replay-plot.mjs, which draws the whole drive as one
   top-down picture: the line coloured by speed, crashes and near misses
   marked, and where the session stopped.

   Discipline this file inherits and must not break:
   - it goes through track() in lib/analytics.ts, so the developer opt-out
     (`?owner=1`), the webdriver guard that keeps the harnesses out of the
     dashboard, and the "PostHog never loaded" no-op path all apply unchanged;
   - it accumulates NOTHING when analytics is not live. Opted out, blocked by
     an extension, DNT, headless: telemetryTick() returns on its first line and
     the sample array stays empty for the life of the tab;
   - it is anonymous gameplay telemetry. Car pose, speed, camera, and the
     counters the game already keeps. No identifiers beyond the anonymous
     distinct_id PostHog itself assigns, nothing the player typed, no
     device fingerprinting of its own.

   WIRE FORMAT v1 (`drive_trace`)
   ------------------------------
   pts: samples joined by ";", fields inside a sample by ",", every field
        base36:
          dt  0.1 s since the previous sample
          dx  metres of world x since the previous sample (absolute for the first)
          dz  metres of world z since the previous sample (absolute for the first)
          kmh speed, rounded, absolute
          hd  heading, 0..255 over a full turn, absolute
          fl  flags: 1 tunnel, 2 mountain pass, camera mode in bits 4+
   ev:  discrete things that happened, joined by ";", as "sampleIndex:kind:value":
          c  crash — value is the contact closing speed in m/s, rounded
          n  near miss — value is how many landed at once
   Everything else on the event is a plain number, and the batch carries no
   text the player produced. */

import { analyticsLive, track } from "./analytics";

/* One sample every N ticks of the engine's existing 6.25 Hz chunk tick — no
   timer of this file's own, and nothing that can land in the middle of a
   frame. 2 gives ~3.1 Hz, ~10 m between samples at motorway speed, which is
   finer than anything the map picture can show. Counters (crashes, near
   misses) are still read on EVERY tick, so a crash cannot slip between two
   position samples. */
const SAMPLE_EVERY = 2;
/** Ship a batch this often. 30 s ≈ 94 samples ≈ 1.4 KB of `pts`, three
    orders below PostHog's ~1 MB per-event ceiling. */
const FLUSH_MS = 30000;
/** Hard ceiling on one batch, in case a tab is throttled and dt jumps: the
    array is flushed the moment it reaches this, whatever the clock says. */
const BATCH_MAX = 400;
/** Fields per sample in the flat array (dt, x, z, kmh, hd, fl). */
const F = 6;

let ticks = 0;
let seq = 0;
/** Flat, packed, and never re-created: samples are pushed as small integers
    and the array is truncated (length = 0) after each flush. */
const buf: number[] = [];
/** "sampleIndex:kind:value" markers for the batch being filled. */
const evs: string[] = [];
let tAcc = 0;          // seconds since the last sample was taken
let tSession = 0;      // seconds of driving in this session
let tBatch0 = 0;       // tSession at the first sample of this batch
let lastFlush = 0;     // Date.now() of the last flush
let px = 0, pz = 0;    // previous sample's position, for the delta
let started = false;   // listeners installed
let n0Crash = -1, n0Near = -1; // counter high-water, for edge detection
/* Session rollups, carried on the final batch so a session that ends in one
   batch still reports its shape. */
let maxKmh = 0, nCrash = 0, nNear = 0;

/** Test seam: when set, batches go here INSTEAD of PostHog. Only ever set by
    the headless harness through the debug hook below — production never
    touches it. */
let sink: ((props: Record<string, string | number>) => void) | null = null;
/** Test seam: force the sampler on when analytics is (correctly) off, e.g.
    under puppeteer, which sets navigator.webdriver. Debug hook only. */
let forced = false;

function b36(n: number) { return Math.round(n).toString(36); }

function install() {
  if (started || typeof window === "undefined") return;
  started = true;
  /* pagehide is the one that fires reliably on mobile Safari when a tab is
     swiped away; visibilitychange covers backgrounding, which on iOS is often
     the last event a page ever gets. Both flush, neither tears anything down —
     a player who comes back keeps sampling into the next batch. */
  const bye = () => flush("hidden");
  addEventListener("pagehide", bye);
  addEventListener("visibilitychange", () => { if (document.hidden) bye(); });
}

/**
 * Called from the engine's 6.25 Hz chunk tick, inside the running branch —
 * never from the render path, never from a timer. Positional primitives on
 * purpose: nothing here allocates unless a sample is actually taken.
 *
 * @param dt        seconds since the previous tick
 * @param x,z       world position, metres
 * @param h         heading, radians
 * @param u         longitudinal speed, m/s (signed; reverse is negative)
 * @param cam       camera mode index
 * @param tunnel    inside the tunnel
 * @param mtn       on the mountain pass (the engine's own 2 Hz probe)
 * @param crashes   session crash counter
 * @param nears     session near-miss counter
 * @param resets    clean-run resets (a real impact, by CLEAN_RUN.impact)
 * @param impact    the closing speed of the last one, m/s
 */
export function telemetryTick(
  dt: number, x: number, z: number, h: number, u: number, cam: number,
  tunnel: boolean, mtn: boolean,
  crashes: number, nears: number, resets: number, impact: number,
) {
  /* THE off switch. Opted out, blocked, headless, DNT, or PostHog's module
     never landed: return before anything is measured or kept. */
  if (!forced && !analyticsLive()) return;
  if (!started) install();

  tSession += dt;
  tAcc += dt;

  /* Counters first, every tick: a crash that happens between two position
     samples still lands on the sample that is about to be written. */
  if (n0Crash < 0) { n0Crash = crashes; n0Near = nears; }
  const i = buf.length / F;
  if (crashes > n0Crash) {
    nCrash += crashes - n0Crash;
    n0Crash = crashes;
    evs.push(i + ":c:" + Math.round(impact));
  }
  if (nears > n0Near) {
    nNear += nears - n0Near;
    evs.push(i + ":n:" + (nears - n0Near));
    n0Near = nears;
  }

  if (++ticks % SAMPLE_EVERY) return;

  const kmh = Math.abs(u) * 3.6;
  if (kmh > maxKmh) maxKmh = kmh;
  if (!buf.length) { tBatch0 = tSession; px = 0; pz = 0; }
  const hd = Math.round((((h % 6.283185) + 6.283185) % 6.283185) * 40.7437) & 255;
  const fl = (tunnel ? 1 : 0) | (mtn ? 2 : 0) | (cam << 4);
  buf.push(
    Math.round(tAcc * 10),
    Math.round(x) - px,
    Math.round(z) - pz,
    Math.round(kmh),
    hd,
    fl,
  );
  px = Math.round(x);
  pz = Math.round(z);
  tAcc = 0;
  void resets; // reserved: the clean-run reset is already implied by :c:

  const now = Date.now();
  if (!lastFlush) lastFlush = now;
  if (buf.length / F >= BATCH_MAX || now - lastFlush >= FLUSH_MS) flush("timer");
}

/** Encode and ship whatever is buffered. Safe to call at any time, from any
    of the flush paths; a flush with nothing in it sends nothing. */
export function flush(reason: "timer" | "hidden" | "end") {
  lastFlush = Date.now();
  if (buf.length < F) return;
  const n = buf.length / F;
  let pts = "";
  for (let i = 0; i < buf.length; i += F) {
    if (i) pts += ";";
    pts += b36(buf[i]) + "," + b36(buf[i + 1]) + "," + b36(buf[i + 2]) + "," +
      b36(buf[i + 3]) + "," + b36(buf[i + 4]) + "," + b36(buf[i + 5]);
  }
  const props: Record<string, string | number> = {
    v: 1,
    seq: seq++,
    t0: Math.round(tBatch0),
    n,
    hz: Math.round(1000 / (160 * SAMPLE_EVERY) * 100) / 100,
    reason,
    pts,
    ev: evs.join(";"),
    bytes: pts.length,
    session_seconds: Math.round(tSession),
    session_top_kmh: Math.round(maxKmh),
    session_crashes: nCrash,
    session_near_misses: nNear,
  };
  buf.length = 0;
  evs.length = 0;
  if (sink) sink(props);
  else track("drive_trace", props);
}

/** Debug/test seam. game/engine.ts hangs this off window.__neonx.telemetry
    when DEBUG_HOOKS is on, so the headless harness can force the sampler on
    (puppeteer sets navigator.webdriver, which correctly keeps analytics off)
    and read the exact payloads track() would have been handed. */
export const telemetryDebug = {
  /** Run the sampler even though analytics is off (headless harness only). */
  force(on: boolean) { forced = on; },
  /** The sampler itself, so a headless harness can feed it exactly what the
      engine feeds it while driving through simStep() instead of frames. */
  tick: telemetryTick,
  /** Divert batches to a local sink instead of PostHog. */
  setSink(fn: ((props: Record<string, string | number>) => void) | null) { sink = fn; },
  flush: () => flush("end"),
  /** Bytes currently buffered, unencoded — for the cost measurement. */
  buffered: () => buf.length / F,
};
