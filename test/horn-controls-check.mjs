/* Horn controls, on a touch-emulated phone: the steering-wheel hub honks
   WITHOUT ever costing the player a steering input.

   The load-bearing assertions are the adversarial ones. The hub sits in the
   middle of the analog steering wheel, so the only way it is allowed to exist
   is if steering always wins:
     - a press that never moves honks,
     - a drag that starts on the hub steers and stays SILENT,
     - a honk in progress is cut the moment the finger starts steering,
     - and no path leaves the horn stuck on.

   Also covers the two controls that share keydown["f"] (the HORN puck and the
   hub): releasing either must not zero the key under the other.

   Runs against a dev or production server: pass --url, or let it default to
   the dev port. Usage: node test/horn-controls-check.mjs --url http://localhost:3141 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer, { KnownDevices } from "puppeteer";
import sharp from "sharp";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3141";
const OUT = path.join(process.cwd(), "docs", "gallery", "img");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail); }
};

/* Headless Chromium only runs rAF while the compositor produces frames, and
   the horn is driven from the game loop (input.horn is a per-frame read), so
   "waiting" has to force frames the way the audio checks do. */
const advance = async (page, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await page.screenshot({ optimizeForSpeed: true });
    await sleep(40);
  }
};

/* Synthetic PointerEvents on #swheel. Dispatched with bubbles:true so they
   run the full capture path — which is how Game.onLivePointerDown (window,
   capture phase) sees them, and therefore how the frame watchdog's
   livePointers stays honest for these fakes exactly as for a real finger. */
const wheelPt = (page, type, id, dx = 0, dy = 0) =>
  page.evaluate((type, id, dx, dy) => {
    const el = document.getElementById("swheel");
    if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent(type, {
      pointerId: id, bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true,
      clientX: r.left + r.width / 2 + dx, clientY: r.top + r.height / 2 + dy,
    }));
    return true;
  }, type, id, dx, dy);

/* down+move in ONE evaluate: the "drag that starts on the hub" case has to
   cross DRAG_PX inside HOLD_MS, and two CDP round trips could straddle it and
   turn a real regression into a green run (or a green build into a flake). */
const wheelDragFrom = (page, id, dx0, dx1) =>
  page.evaluate((id, dx0, dx1) => {
    const el = document.getElementById("swheel");
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2, cx = r.left + r.width / 2;
    const ev = (type, x) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: id, bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true,
      clientX: cx + x, clientY: cy,
    }));
    ev("pointerdown", dx0);
    ev("pointermove", dx1);
  }, id, dx0, dx1);

const puckPt = (page, id, type, pointerId) =>
  page.evaluate((id, type, pointerId) => {
    document.getElementById(id)?.dispatchEvent(new PointerEvent(type, {
      pointerId, bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true,
    }));
  }, id, type, pointerId);

const state = (page) => page.evaluate(() => ({
  starts: window.__audioDebug.hornDebug().starts,
  sounding: window.__neonx.game.input.horn > 0,
  key: window.__neonx.game.keydown["f"] === 1,
  wheel: window.__neonx.game.wheelVal,
  steer: window.__neonx.game.input.st,
}));

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
  ],
  protocolTimeout: 300000,
});
const pageErrors = [];
const page = await browser.newPage();
page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    pageErrors.push(m.text());
});
await page.emulate(KnownDevices["iPhone 13"]);
// the hub only exists in wheel steer mode, so seed the profile into it
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("neonx.profile.v3", JSON.stringify({ settings: { steerMode: "wheel" } }));
});
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"))?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 240000 });
try {
  await page.waitForFunction(
    () => window.__audioDebug?.getLevels?.()?.sampledEngineReady === true, { timeout: 60000 });
} catch { check("sampled audio ready", false, "decode/wiring failed"); }
await page.evaluate(() => window.__neonx.setCam(3)); // CAM_POV — the shipped dashcam
await advance(page, 1200);

check("wheel is mounted (steerMode=wheel)", await page.evaluate(
  () => !!document.getElementById("swheel")));
check("hub is painted", await page.evaluate(() => !!document.getElementById("swheelHub")));
/* The hub must not be an event target: if it took the capture, the drag that
   starts on it would break. This is the single most important line here. */
check("hub is pointer-inert (pointer-events:none)", await page.evaluate(
  () => getComputedStyle(document.getElementById("swheelHub")).pointerEvents === "none"));
check("HORN puck still present for buttons/tilt users", await page.evaluate(
  () => !!document.getElementById("tcH")));

/* ---- 1. press-and-hold the hub: honks, and does NOT steer ---- */
let before = await state(page);
await wheelPt(page, "pointerdown", 40);
await advance(page, 500);
let s = await state(page);
check("hub press honks", s.starts === before.starts + 1 && s.sounding, JSON.stringify(s));
check("hub press did not steer", Math.abs(s.wheel) < 1e-6 && Math.abs(s.steer) < 1e-6,
  `wheelVal=${s.wheel} st=${s.steer}`);
await page.screenshot({ type: "png" }).then(async (raw) => {
  await sharp(raw).resize({ width: 1200 }).jpeg({ quality: 80 })
    .toFile(path.join(OUT, "horn-01-hub-honking.jpg"));
  console.log("  📸 horn-01-hub-honking.jpg — Dashcam, phone: the wheel's HORN boss lit while held.");
});
await wheelPt(page, "pointerup", 40);
await advance(page, 400);
s = await state(page);
check("hub release stops the horn", !s.sounding && !s.key, JSON.stringify(s));

/* ---- 2. STEERING ALWAYS WINS: a drag that starts on the hub is silent ---- */
before = await state(page);
await wheelDragFrom(page, 41, 0, 45); // starts on the hub, past DRAG_PX inside HOLD_MS
await advance(page, 500);
s = await state(page);
check("drag from the hub steers", Math.abs(s.wheel) > 0.5, `wheelVal=${s.wheel}`);
check("drag from the hub never honked", s.starts === before.starts && !s.sounding,
  `starts +${s.starts - before.starts} sounding=${s.sounding}`);
await wheelPt(page, "pointerup", 41);
await advance(page, 300);
check("drag release recentres the wheel", Math.abs((await state(page)).wheel) < 1e-6);

/* ---- 3. a honk already sounding is cut the moment steering starts ---- */
before = await state(page);
await wheelPt(page, "pointerdown", 42);
await advance(page, 400);
s = await state(page);
check("hub honking before the drag", s.sounding, JSON.stringify(s));
await wheelPt(page, "pointermove", 42, 50);
await advance(page, 300);
s = await state(page);
check("starting to steer cuts the horn", !s.sounding && !s.key, JSON.stringify(s));
check("...and steering took over", Math.abs(s.wheel) > 0.5, `wheelVal=${s.wheel}`);
await wheelPt(page, "pointerup", 42);
await advance(page, 300);

/* ---- 4. a quick tap still beeps (the stab) ---- */
before = await state(page);
await wheelPt(page, "pointerdown", 43);
await advance(page, 40); // lifts inside HOLD_MS: never sustained
await wheelPt(page, "pointerup", 43);
await advance(page, 60);
s = await state(page);
check("a quick hub tap still beeps", s.starts === before.starts + 1, JSON.stringify(s));
await advance(page, 500);
s = await state(page);
check("the stab releases itself", !s.sounding && !s.key, JSON.stringify(s));

/* ---- 5. pointercancel (the gesture hijack) leaves nothing stuck ---- */
await wheelPt(page, "pointerdown", 44);
await advance(page, 400);
check("honking before the cancel", (await state(page)).sounding);
await wheelPt(page, "pointercancel", 44);
await advance(page, 400);
s = await state(page);
check("pointercancel releases the horn and the wheel",
  !s.sounding && !s.key && Math.abs(s.wheel) < 1e-6, JSON.stringify(s));

/* ---- 6. the two controls share "f" without cutting each other off ---- */
await puckPt(page, "tcH", "pointerdown", 45);
await advance(page, 300);
check("HORN puck honks", (await state(page)).sounding);
await wheelPt(page, "pointerdown", 46);
await advance(page, 300);
await wheelPt(page, "pointerup", 46);
await advance(page, 200);
s = await state(page);
check("releasing the hub does not cut the still-held puck", s.sounding && s.key, JSON.stringify(s));
await puckPt(page, "tcH", "pointerup", 45);
await advance(page, 400);
s = await state(page);
check("releasing the puck finally stops the horn", !s.sounding && !s.key, JSON.stringify(s));

/* ---- 7. a sub-frame keyboard stab still sounds (the HORN_MIN_S floor) ----
   input.horn is a per-frame sample of keydown["f"], so a press and release
   dispatched back-to-back in one task is exactly the case the floor exists
   for: without it this is silent, which is the half of "beep beep" that
   used to go missing. */
before = await state(page);
await page.evaluate(() => {
  dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
  dispatchEvent(new KeyboardEvent("keyup", { key: "f" }));
});
await advance(page, 120);
s = await state(page);
check("a sub-frame F stab still honks", s.starts === before.starts + 1, JSON.stringify(s));
await advance(page, 500);
check("the sub-frame stab releases itself", !(await state(page)).sounding);

/* ---- 8. a drag starting on the RIM is unchanged ---- */
before = await state(page);
await wheelDragFrom(page, 47, 50, 90); // starts on the rim, outside HUB_R
await advance(page, 400);
s = await state(page);
check("rim drag steers", Math.abs(s.wheel) > 0.5, `wheelVal=${s.wheel}`);
check("rim drag is silent", s.starts === before.starts && !s.sounding, JSON.stringify(s));
await wheelPt(page, "pointerup", 47);
await advance(page, 300);

check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
