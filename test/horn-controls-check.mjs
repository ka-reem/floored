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

/* Headless Chromium only runs rAF while the compositor produces frames, so
   waiting has to force them — but it must also COUNT them. input.horn is a
   per-frame read, and the forced-frame rate under SwiftShader on a cold cloud
   sandbox measures well under 1 fps, so anything sized in wall time can
   contain no game frame at all and assert nothing. Every wait below is
   therefore denominated in game frames. */
const frameNo = (page) => page.evaluate(() => window.__neonx.game.debug.frames);
const advance = async (page, n = 2, budgetMs = 120000) => {
  const from = await frameNo(page);
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await page.screenshot({ optimizeForSpeed: true });
    if ((await frameNo(page)) - from >= n) return true;
    await sleep(30);
  }
  return false;
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

/* down+up in ONE evaluate, so the lift is guaranteed to land inside HOLD_MS
   and this really is the stab path rather than a short sustained honk. */
const wheelTap = (page, id) =>
  page.evaluate((id) => {
    const el = document.getElementById("swheel");
    const r = el.getBoundingClientRect();
    const o = { pointerId: id, bubbles: true, cancelable: true, pointerType: "touch",
      isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
  }, id);

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
await advance(page, 3);

const shot = async (name, caption) => {
  const raw = await page.screenshot({ type: "png" });
  const out = path.join(OUT, `horn-${name}.jpg`);
  await sharp(raw).resize({ width: 1200 }).jpeg({ quality: 80 }).toFile(out);
  console.log("  📸", out, "—", caption);
};

await shot("01-wheel-idle",
  "Dashcam, phone, wheel steer mode: the horn is the wheel's own hub — the authentic control, and the one already under the driver's thumbs.");

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
await advance(page, 3);
let s = await state(page);
check("hub press honks", s.starts === before.starts + 1 && s.sounding, JSON.stringify(s));
check("hub press did not steer", Math.abs(s.wheel) < 1e-6 && Math.abs(s.steer) < 1e-6,
  `wheelVal=${s.wheel} st=${s.steer}`);
await shot("02-hub-honking",
  "Held: the HORN boss lights while the horn sounds. The wheel has not moved — a press that never becomes a drag honks and does not steer.");
await wheelPt(page, "pointerup", 40);
await advance(page, 3);
s = await state(page);
check("hub release stops the horn", !s.sounding && !s.key, JSON.stringify(s));

/* ---- 2. STEERING ALWAYS WINS: a drag that starts on the hub is silent ---- */
before = await state(page);
await wheelDragFrom(page, 41, 0, 45); // starts on the hub, past DRAG_PX inside HOLD_MS
await advance(page, 3);
s = await state(page);
check("drag from the hub steers", Math.abs(s.wheel) > 0.5, `wheelVal=${s.wheel}`);
check("drag from the hub never honked", s.starts === before.starts && !s.sounding,
  `starts +${s.starts - before.starts} sounding=${s.sounding}`);
await shot("03-drag-from-hub-steers",
  "The proof: the same finger, started on the hub, dragged. The wheel is deflected and steering, the HORN boss is dark — steering always wins.");
await wheelPt(page, "pointerup", 41);
await advance(page, 3);
check("drag release recentres the wheel", Math.abs((await state(page)).wheel) < 1e-6);

/* ---- 3. a honk already sounding is cut the moment steering starts ---- */
before = await state(page);
await wheelPt(page, "pointerdown", 42);
await advance(page, 3);
s = await state(page);
check("hub honking before the drag", s.sounding, JSON.stringify(s));
await wheelPt(page, "pointermove", 42, 50);
await advance(page, 3);
s = await state(page);
check("starting to steer cuts the horn", !s.sounding && !s.key, JSON.stringify(s));
check("...and steering took over", Math.abs(s.wheel) > 0.5, `wheelVal=${s.wheel}`);
await wheelPt(page, "pointerup", 42);
await advance(page, 3);

/* ---- 4. a quick tap still beeps (the stab) ---- */
before = await state(page);
await wheelTap(page, 43); // down+up in one task, inside HOLD_MS: never sustained
await advance(page, 2);
s = await state(page);
check("a quick hub tap still beeps", s.starts === before.starts + 1, JSON.stringify(s));
await advance(page, 3);
s = await state(page);
check("the stab releases itself", !s.sounding && !s.key, JSON.stringify(s));

/* ---- 5. pointercancel (the gesture hijack) leaves nothing stuck ---- */
await wheelPt(page, "pointerdown", 44);
await advance(page, 3);
check("honking before the cancel", (await state(page)).sounding);
await wheelPt(page, "pointercancel", 44);
await advance(page, 3);
s = await state(page);
check("pointercancel releases the horn and the wheel",
  !s.sounding && !s.key && Math.abs(s.wheel) < 1e-6, JSON.stringify(s));

/* ---- 6. the two controls share "f" without cutting each other off ---- */
await puckPt(page, "tcH", "pointerdown", 45);
await advance(page, 3);
check("HORN puck honks", (await state(page)).sounding);
await wheelPt(page, "pointerdown", 46);
await advance(page, 3);
await wheelPt(page, "pointerup", 46);
await advance(page, 2);
s = await state(page);
check("releasing the hub does not cut the still-held puck", s.sounding && s.key, JSON.stringify(s));
await puckPt(page, "tcH", "pointerup", 45);
await advance(page, 3);
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
await advance(page, 2);
s = await state(page);
check("a sub-frame F stab still honks", s.starts === before.starts + 1, JSON.stringify(s));
await advance(page, 3);
check("the sub-frame stab releases itself", !(await state(page)).sounding);

/* ---- 8. a HELD key survives the frame watchdog on a touch device ----
   Regression guard for the watchdog bug this lane found: every puck registers
   a touchHold on its key, and an idle hold's id set is empty. The watchdog
   used to read "no ids" as "the finger is gone" and zero the key on the very
   next frame — whoever had pressed it. That cut the hub's honk within a frame
   and, on any touch device with a keyboard attached, made W/A/S/D/F
   impossible to HOLD at all. */
before = await state(page);
await page.evaluate(() => dispatchEvent(new KeyboardEvent("keydown", { key: "f" })));
await advance(page, 3);
s = await state(page);
check("a held F survives the touch watchdog", s.sounding && s.key, JSON.stringify(s));
await page.evaluate(() => dispatchEvent(new KeyboardEvent("keyup", { key: "f" })));
await advance(page, 3);
check("...and releasing it stops the horn", !(await state(page)).sounding);

/* ---- 9. a drag starting on the RIM is unchanged ---- */
before = await state(page);
await wheelDragFrom(page, 47, 50, 90); // starts on the rim, outside HUB_R
await advance(page, 3);
s = await state(page);
check("rim drag steers", Math.abs(s.wheel) > 0.5, `wheelVal=${s.wheel}`);
check("rim drag is silent", s.starts === before.starts && !s.sounding, JSON.stringify(s));
await wheelPt(page, "pointerup", 47);
await advance(page, 3);

check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
