#!/usr/bin/env node
/* Headless check for the player horn: press-and-hold must be ONE continuous
   horn (single voice start, gain held up the whole time, release only on
   key-up), quick taps must each give a clean short honk, and the sample's
   sustain loop window must sit entirely inside the recording's sustained
   tone — the "beep beep beep under a held key" bug was the loop window
   overshooting into the note's release tail (the recorded horn dies at
   ~0.385 s; the old hardcoded window looped through 0.42 s).

   Uses the __audioDebug hook (the GameAudio instance) for hornDebug() /
   hornSet(), and __neonx.setInput({horn}) to drive the real input path.

   Usage: node test/audio-horn-check.mjs --url http://localhost:3141 */
import puppeteer from "puppeteer";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3141";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Headless Chromium only runs requestAnimationFrame while the compositor
   produces frames; screenshots force BeginFrames (same pattern as
   audio-sampled-check.mjs), so "waiting" interleaves cheap screenshots. */
const advance = async (page, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await page.screenshot({ optimizeForSpeed: true });
    await sleep(60);
  }
};
const errors = [];
const fail = (m) => { console.error("  ✗ " + m); errors.push(m); };
const pass = (m) => console.log("  ✓ " + m);

const horn = (page) => page.evaluate(() => window.__audioDebug.hornDebug());

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
  ],
  defaultViewport: { width: 960, height: 600 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push("console: " + m.text());
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* The world is built by the staged loader after this click, not by the
   constructor, so __neonx existing no longer means there is a world to
   drive in — wait for the load to finish before touching it. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
// horn sample decodes with the rest of the manifest; wait for the set
try {
  await page.waitForFunction(
    () => window.__audioDebug?.getLevels?.()?.sampledEngineReady === true,
    { timeout: 30000 }
  );
} catch {
  fail("sampled audio never became ready (decode/wiring failed?)");
}

let h = await horn(page);
if (h.starts === 0 && !h.sampleActive && !h.synthActive) pass("horn idle at boot (0 starts)");
else fail(`horn not idle at boot: ${JSON.stringify(h)}`);

/* ---- hold 1.5 s: exactly one start, gain up continuously ---- */
const startsBefore = h.starts;
await page.evaluate(() => window.__neonx.setInput({ horn: 1 }));
/* Sample the horn gain across the hold from INSIDE the page: setInterval
   runs on the wall clock even when SwiftShader screenshots crawl and rAF
   frames barely advance, so this reliably yields dozens of reads where
   Node-side polling (bounded by screenshot latency) can manage only one
   or two. A gain dip to ~0 mid-hold is exactly what a release+retrigger
   ("beep beep beep") would show. */
{
  // the game loop (and so hornSet) only runs on forced frames — poll with
  // screenshots, not waitForFunction (whose default rAF polling would stall)
  let started = false;
  for (let i = 0; i < 120 && !started; i++) {
    await page.screenshot({ optimizeForSpeed: true });
    started = (await horn(page)).sampleActive;
  }
  if (!started) fail("horn sample voice never started under held input");
}
await page.evaluate(() => {
  window.__hornGains = [];
  window.__hornGainTimer = setInterval(
    () => window.__hornGains.push(window.__audioDebug.hornDebug().gain), 40);
});
await advance(page, 1500); // keep frames (and the per-frame hornSet calls) coming
const gains = await page.evaluate(() => {
  clearInterval(window.__hornGainTimer);
  return window.__hornGains.slice(8); // skip the 15 ms attack ramp region
});
h = await horn(page);
if (h.starts - startsBefore === 1) pass("1.5 s hold fired exactly one horn start");
else fail(`1.5 s hold fired ${h.starts - startsBefore} starts (want 1)`);
if (h.sampleActive) pass("recorded horn sample is the active voice");
else fail(`recorded sample not active mid-hold: ${JSON.stringify(h)}`);
const minGain = Math.min(...gains);
if (gains.length >= 10 && minGain > 0.1)
  pass(`horn gain held up across ${gains.length} mid-hold samples (min ${minGain.toFixed(3)})`);
else fail(`horn gain dipped mid-hold (min ${minGain} over ${gains.length} samples)`);

/* ---- key auto-repeat / redundant-call storm: still one voice ---- */
await page.evaluate(() => { for (let i = 0; i < 25; i++) window.__audioDebug.hornSet(true); });
h = await horn(page);
if (h.starts - startsBefore === 1) pass("25 redundant hornSet(true) calls mid-hold started nothing new");
else fail(`redundant on-calls retriggered the horn (${h.starts - startsBefore} starts)`);

/* ---- loop window must sit inside the recording's sustain ---- */
const loopCheck = await page.evaluate(() => {
  const a = window.__audioDebug;
  const buf = a.samples.get("hornPlayer");
  const lp = a.hornDebug().loop;
  if (!buf || !lp) return null;
  const d = buf.getChannelData(0), sr = buf.sampleRate;
  const rms = (t0, t1) => {
    let s = 0, c = 0;
    for (let i = Math.floor(t0 * sr); i < Math.floor(t1 * sr); i++) { s += d[i] * d[i]; c++; }
    return Math.sqrt(s / Math.max(1, c));
  };
  let minWin = Infinity;
  for (let t = lp.start; t + 0.01 <= lp.end; t += 0.01) minWin = Math.min(minWin, rms(t, t + 0.01));
  return { ...lp, dur: buf.duration, loopRms: rms(lp.start, lp.end), minWin };
});
if (!loopCheck) fail("could not inspect horn loop window");
else {
  const { start, end, minWin, loopRms, dur } = loopCheck;
  if (end - start >= 0.05 && end <= dur) pass(`loop window ${start.toFixed(3)}..${end.toFixed(3)} s (len ${(end - start).toFixed(3)})`);
  else fail(`degenerate loop window ${start}..${end} (buffer ${dur})`);
  // the beep-beep bug: part of the loop was the note's die-off. Every 10 ms
  // slice of the loop must hold near the loop's own average level.
  if (minWin > loopRms * 0.6)
    pass(`loop stays at sustain level throughout (min 10ms RMS ${minWin.toFixed(3)} vs loop RMS ${loopRms.toFixed(3)})`);
  else fail(`loop window contains a level dip — would beep (min ${minWin.toFixed(3)} vs ${loopRms.toFixed(3)})`);
}

/* ---- release on key-up: voice ends, gain fades out ---- */
await page.evaluate(() => window.__neonx.setInput({ horn: 0 }));
await advance(page, 500);
h = await horn(page);
if (!h.sampleActive && !h.synthActive && h.gain === 0) pass("key-up released the horn (voice gone)");
else fail(`horn stuck after key-up: ${JSON.stringify(h)}`);
if (h.starts - startsBefore === 1) pass("release did not retrigger");
else fail(`release path fired extra starts (${h.starts - startsBefore})`);

/* ---- 5 rapid taps: 5 clean short honks, none stuck ---- */
const tapsBase = h.starts;
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => window.__neonx.setInput({ horn: 1 }));
  await advance(page, 130);
  await page.evaluate(() => window.__neonx.setInput({ horn: 0 }));
  await advance(page, 160);
}
await advance(page, 400);
h = await horn(page);
if (h.starts - tapsBase === 5) pass("5 rapid taps fired 5 distinct honks");
else fail(`5 taps fired ${h.starts - tapsBase} starts (want 5)`);
if (!h.sampleActive && !h.synthActive) pass("no stuck horn after rapid taps");
else fail(`horn stuck after taps: ${JSON.stringify(h)}`);

await page.evaluate(() => window.__neonx.setInput(null));
await browser.close();
if (errors.length) {
  console.log("\n❌ FAILURES:");
  for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 400));
  process.exit(1);
}
console.log("✅ player horn press-and-hold verified");
