#!/usr/bin/env node
/* Headless check for the bug where leaving the tab and coming back leaves no
   audio.

   REPORTED: leaving the browser and returning to it leaves the audio dead — a
   real phone, backgrounded and brought back, silent for the rest of the session.
   The cause is the AudioContext: a hidden page has its context SUSPENDED by
   the browser, and nothing in game/ ever resumed it. Desktop Chrome does not
   suspend a backgrounded tab's context (it keeps playing), so this script
   suspends the context by hand — that is the only part of the phone's
   behaviour being emulated. Everything after it is the real thing: a real
   visibility transition, the engine's real handlers, the real resume().

   Four phases:
     A  running    hide/show must bring the context back to "running"
     B  paused     hide/show must NOT resume it; pressing RESUME must
     C  refused    resume() rejecting (what iOS does outside a gesture) must
                   arm the gesture fallback, and a real pointerdown must fix it
     D  muted      vol 0 must not resume on return

   Usage: node test/audio-resume-check.mjs --url http://localhost:3427 */
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3427";
const NO_WORLD = process.argv.includes("--no-world");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const advance = async (page, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await page.screenshot({ optimizeForSpeed: true });
    await sleep(60);
  }
};
/* The world build is staged behind requestAnimationFrame, and headless
   Chromium only advances rAF while the compositor is producing frames — so
   waiting on `loaded` without driving frames can wait forever on a busy box.
   Screenshotting IS the frame driver here, and polling this way also prints
   progress instead of failing blind after N minutes. */
async function waitLoaded(page, ms = 1800000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    await page.screenshot({ optimizeForSpeed: true });
    const s = await page.evaluate(() => ({
      loaded: !!window.__neonx?.game?.loaded,
      txt: (document.body.innerText || "").split("\n").filter(Boolean).slice(0, 3).join(" | ").slice(0, 80),
    }));
    const secs = Math.round((Date.now() - t0) / 1000);
    if (s.loaded) { console.log(`  world loaded after ${secs}s`); return; }
    if (s.txt !== last) { console.log(`  … ${secs}s ${s.txt}`); last = s.txt; }
    await sleep(1500);
  }
  throw new Error("world never finished loading");
}
const errors = [];
const rows = [];
const fail = (m) => { console.error("  ✗ " + m); errors.push(m); };
const pass = (m) => console.log("  ✓ " + m);

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
  ],
  // small frame + low preset: this check is about the AudioContext, not the
  // picture, and a lean renderer is what keeps the tab alive on a busy box
  defaultViewport: { width: 640, height: 400 },
  protocolTimeout: 1800000,
  userDataDir: process.env.FLOORED_PROFILE_DIR || undefined,
});
const page = await browser.newPage();
page.on("pageerror", (e) => { const m = "pageerror: " + String(e.message || e); console.log("  !", m); errors.push(m); });
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push("console: " + m.text());
});

console.log("  goto", new Date().toISOString());
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 600000 });
console.log("  html in", new Date().toISOString());
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
console.log("  __neonx up", new Date().toISOString());
/* --no-world drives the audio lifecycle directly instead of building the
   world first. Everything under test — the visibility/pageshow listeners, the
   resume gating, the gesture fallback — is registered in the Game constructor
   and lives on the two AudioContexts, none of which the 4.7 km of expressway
   is involved in; the world build is just eight minutes and a gigabyte in
   front of it. Use it when the box is too loaded to finish a build (the
   renderer gets OOM-killed mid-load); use the default full drive otherwise. */
if (NO_WORLD) {
  console.log("  (--no-world: priming audio without the world build)");
  await page.evaluate(() => {
    const g = window.__neonx.game;
    g.primeAudio();
    // what start()/setRunning(true) set, minus beginLoop — there is no world
    // for the render loop to draw, and the audio path does not read one
    g.started = true;
    g.running = true;
    g.audio.setLevels(g.settings.vol, 1);
  });
} else {
  await page.evaluate(() => {
    const g = window.__neonx.game;
    g.settings.preset = "low";
    g.settings.shadows = false;
    g.applySettings(g.settings);
  });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b?.click();
  });
  await waitLoaded(page);
}
await advance(page, 1200);
console.log("  boot:", JSON.stringify(await page.evaluate(() => ({
  audioOk: !!window.__neonx.game.audio?.ok,
  audioDebug: typeof window.__audioDebug,
  state: window.__neonx.audioState(),
}))));

const state = () => page.evaluate(() => window.__neonx.audioState());
/* What a phone's browser does to a hidden page, done by hand because desktop
   Chrome does not do it. `ctx` is TS-private, which is a compile-time fiction —
   at runtime it is a plain property, and reaching it here is the point. */
const forceSuspend = async () => {
  await page.evaluate(async () => {
    await window.__neonx.game.audio.ctx.suspend();
    const m = window.__neonx.game.music;
    if (m?.ctx) await m.ctx.suspend();
  });
};

/* A REAL visibility transition, not a stubbed one. Three routes, best first;
   which one actually ran is printed, so the result can be read honestly. */
let hideRoute = "none";
const cdp = await page.createCDPSession();
const other = await browser.newPage();
const setVis = async (visible) => {
  try {
    await cdp.send("Emulation.setPageVisibilityState", { state: visible ? "visible" : "hidden" });
    hideRoute = "CDP Emulation.setPageVisibilityState";
    return;
  } catch { /* not in this Chrome build; fall through */ }
  if (visible) await page.bringToFront();
  else await other.bringToFront();
  hideRoute = "second tab + Page.bringToFront";
};
const hide = async () => { await setVis(false); await sleep(400); };
const show = async () => { await setVis(true); await sleep(900); };

const hidden = () => page.evaluate(() => document.hidden);

/* ---------------------------------------------- A: running --------- */
console.log("A. running, hide and return");
let s0 = await state();
rows.push(["A running", "before hide", s0.audio, s0.music, s0.gestureArmed]);
if (s0.audio === "running") pass("context is running while driving");
else fail(`context is ${s0.audio} while driving (want running)`);

await forceSuspend();
await hide();
if (await hidden()) pass(`page really went hidden (${hideRoute})`);
else fail(`could not hide the page (${hideRoute}) — the rest of A is not a real test`);
let s1 = await state();
rows.push(["A running", "while hidden", s1.audio, s1.music, s1.gestureArmed]);
if (s1.audio === "suspended") pass("context suspended while hidden (the bug's starting point)");
else fail(`context is ${s1.audio} while hidden (want suspended)`);

await show();
await advance(page, 600);
let s2 = await state();
rows.push(["A running", "after return", s2.audio, s2.music, s2.gestureArmed]);
if (s2.audio === "running") pass("context back to running on return");
else fail(`context is ${s2.audio} after return (want running) — THE BUG`);
if (s2.music === "running" || s2.music === null) pass("music context back too");
else fail(`music context is ${s2.music} after return`);

/* ---------------------------------------------- B: paused ---------- */
console.log("B. paused, hide and return");
await page.evaluate(() => window.__neonx.game.setRunning(false));
await forceSuspend();
let s3 = await state();
rows.push(["B paused", "while hidden", s3.audio, s3.music, s3.gestureArmed]);
await hide();
await show();
await advance(page, 600);
let s4 = await state();
rows.push(["B paused", "after return", s4.audio, s4.music, s4.gestureArmed]);
if (s4.audio === "suspended") pass("paused game does NOT resume audio on return");
else fail(`paused game came back ${s4.audio} (want suspended)`);
if (!s4.gestureArmed) pass("no gesture listener left armed while paused");
else fail("gesture fallback armed while paused (it would fire on any tap)");

await page.evaluate(() => window.__neonx.game.setRunning(true));
await advance(page, 600);
let s5 = await state();
rows.push(["B paused", "after RESUME", s5.audio, s5.music, s5.gestureArmed]);
if (s5.audio === "running") pass("pressing RESUME lifts the context");
else fail(`RESUME left the context ${s5.audio} (want running)`);

/* ---------------------------------------------- C: refused --------- */
console.log("C. resume() refused (the iOS case), gesture fallback");
await page.evaluate(() => {
  const c = window.__neonx.game.audio.ctx;
  window.__origResume = c.resume.bind(c);
  // exactly what iOS does to a resume() that is not inside a user gesture
  c.resume = () => Promise.reject(new DOMException("not allowed", "NotAllowedError"));
});
await forceSuspend();
await hide();
await show();
await advance(page, 800);
let s6 = await state();
rows.push(["C refused", "after return", s6.audio, s6.music, s6.gestureArmed]);
if (s6.audio === "suspended") pass("a refused resume leaves the context suspended (as expected)");
else fail(`context is ${s6.audio} after a refused resume`);
if (s6.gestureArmed) pass("gesture fallback armed after the refusal");
else fail("gesture fallback NOT armed — a refused resume would be silent forever");
if (!errors.some((e) => /unhandled|NotAllowedError/i.test(e))) pass("no unhandled rejection from the refusal");
else fail("the refused resume() surfaced as an unhandled rejection");

await page.evaluate(() => { window.__neonx.game.audio.ctx.resume = window.__origResume; });
await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
await advance(page, 800);
let s7 = await state();
rows.push(["C refused", "after a tap", s7.audio, s7.music, s7.gestureArmed]);
if (s7.audio === "running") pass("the next tap resumes the context");
else fail(`context still ${s7.audio} after a tap (want running)`);
if (!s7.gestureArmed) pass("gesture listener disarmed once it worked");
else fail("gesture listener still armed after a successful resume");

/* ---------------------------------------------- D: muted ----------- */
console.log("D. volume 0, hide and return");
await page.evaluate(() => {
  const g = window.__neonx.game;
  window.__oldVol = g.settings.vol;
  g.settings.vol = 0;
  g.applySettings(g.settings);
});
await forceSuspend();
await hide();
await show();
await advance(page, 600);
let s8 = await state();
rows.push(["D muted", "after return", s8.audio, s8.music, s8.gestureArmed]);
if (s8.audio === "suspended") pass("a muted session does not resume on return");
else fail(`muted session came back ${s8.audio} (want suspended)`);
await page.evaluate(() => {
  const g = window.__neonx.game;
  g.settings.vol = window.__oldVol;
  g.applySettings(g.settings);
});
await advance(page, 600);
let s9 = await state();
rows.push(["D muted", "after unmute", s9.audio, s9.music, s9.gestureArmed]);
if (s9.audio === "running") pass("unmuting lifts the context");
else fail(`unmute left the context ${s9.audio}`);

/* ---------------------------------------------- report ------------- */
const w = [12, 14, 11, 11, 8];
const line = (c) => "  " + c.map((x, i) => String(x).padEnd(w[i])).join(" ");
console.log("\n  hide route: " + hideRoute);
console.log(line(["CASE", "MOMENT", "audio ctx", "music ctx", "gesture"]));
console.log("  " + "-".repeat(w.reduce((a, b) => a + b + 1, 0)));
for (const r of rows) console.log(line(r));

await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("\naudio-resume-check: OK");
