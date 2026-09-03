#!/usr/bin/env node
/* Headless check for the high-beam stalk click (lane O): boots the game and
   uses the __audioDebug hook plus synthetic G-key events to assert that
     - latching the high beams ON fires the click exactly once,
     - latching them OFF fires nothing (turn-on only),
     - five rapid flash-to-pass taps produce at most five clicks (one per
       press, none stacked inside the 70ms debounce window),
     - two presses inside the debounce window produce a single click,
   and that no page errors fire along the way.

   Usage: node test/audio-stalk-click-check.mjs --url http://localhost:3141 */
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3141";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Headless Chromium only advances requestAnimationFrame while the compositor
   produces frames — screenshots force BeginFrames (same pattern as
   audio-sampled-check.mjs), so waiting interleaves cheap screenshots with
   short sleeps. Key events and the audio clock run on wall time regardless;
   only the frame-clock hold resolution (HI_HOLD) needs the screenshots. */
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

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* The world is built by the staged loader after this click, not by the
   constructor, so __neonx existing no longer means there is a world to
   drive in — wait for the load to finish before touching it. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await page.waitForFunction(() => !!window.__audioDebug, { timeout: 30000 });
await advance(page, 800); // let the sim settle into running

const key = (type, k) =>
  page.evaluate(([ty, kk]) => window.dispatchEvent(new KeyboardEvent(ty, { key: kk })), [type, k]);
const clicks = () => page.evaluate(() => window.__audioDebug.getStalkClickCount());
const beamState = () =>
  page.evaluate(() => ({ latch: window.__neonx.game.hiLatch, on: window.__neonx.game.highBeam }));

let st = await beamState();
if (!st.latch && !st.on) pass("high beams start OFF");
else fail(`high beams not off at start (latch=${st.latch}, on=${st.on})`);
const c0 = await clicks();

// 1) latch ON: hold G past HI_HOLD (2s of frame-clock time), then release
await key("keydown", "g");
await advance(page, 2600);
await key("keyup", "g");
await advance(page, 300);
st = await beamState();
let c = await clicks();
if (st.latch) pass("held G latches high beams ON");
else fail("latch did not engage after 2.6s hold");
if (c - c0 === 1) pass("toggle ON fired the click exactly once");
else fail(`toggle ON fired ${c - c0} clicks (want 1)`);

// 2) latch OFF: same gesture — beams were on, so the press must be silent
await key("keydown", "g");
await advance(page, 2600);
await key("keyup", "g");
await advance(page, 300);
st = await beamState();
const c2 = await clicks();
if (!st.latch && !st.on) pass("held G latches high beams back OFF");
else fail(`latch did not release (latch=${st.latch}, on=${st.on})`);
if (c2 - c === 0) pass("toggle OFF fired no click");
else fail(`toggle OFF fired ${c2 - c} clicks (want 0)`);

// 3) five rapid flash-to-pass taps: one click per press, at most five total
for (let i = 0; i < 5; i++) {
  await key("keydown", "g");
  await sleep(90);
  await key("keyup", "g");
  await sleep(90);
}
await advance(page, 300);
const c3 = await clicks();
if (c3 - c2 >= 1 && c3 - c2 <= 5) pass(`5 rapid flashes fired ${c3 - c2} clicks (≤5, ≥1)`);
else fail(`5 rapid flashes fired ${c3 - c2} clicks (want 1..5)`);
st = await beamState();
if (!st.on) pass("beams back off after the flash volley (no click possible on release)");
else fail("beams stuck on after flash volley");

// 4) two presses inside the 70ms debounce window collapse to one click
await key("keydown", "g");
await key("keyup", "g");
await key("keydown", "g");
await key("keyup", "g");
await advance(page, 300);
const c4 = await clicks();
if (c4 - c3 === 1) pass("back-to-back presses inside the debounce window click once (no overlap)");
else fail(`debounce window presses fired ${c4 - c3} clicks (want 1)`);

// 5) the turn-signal stalk clicks too: Q engage + Q cancel = two clicks
// (spaced past the 70ms debounce), and the signal state actually toggles
await key("keydown", "q");
await key("keyup", "q");
await advance(page, 300);
let sig = await page.evaluate(() => window.__neonx.game.car.sigL);
if (sig) pass("Q engages the left signal");
else fail("Q did not set sigL");
await key("keydown", "q");
await key("keyup", "q");
await advance(page, 300);
sig = await page.evaluate(() => window.__neonx.game.car.sigL);
const c5 = await clicks();
if (!sig) pass("second Q cancels the left signal");
else fail("second Q did not clear sigL");
if (c5 - c4 === 2) pass("both signal toggle edges click the stalk");
else fail(`signal toggles fired ${c5 - c4} clicks (want 2)`);

// 6) pass-by whoosh voice: the one-shot builds and rate-limits without error
const pb = await page.evaluate(() => {
  const a = window.__audioDebug;
  const n0 = a.getPassbyCount();
  a.npcPassby(25, 3.5); // full-speed pass one lane over — must fire
  a.npcPassby(25, -3.5); // inside the 150ms pile-up gate — must not
  a.npcPassby(3, 3.5); // under the 6 m/s closing floor — must not
  return a.getPassbyCount() - n0;
});
if (pb === 1) pass("pass-by whoosh fires once and gates the pile-up/slow cases");
else fail(`pass-by fired ${pb} of 3 calls (want exactly 1)`);

await browser.close();
if (errors.length) {
  console.log("\n❌ FAILURES:");
  for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 400));
  process.exit(1);
}
console.log("✅ stalk click verified");
