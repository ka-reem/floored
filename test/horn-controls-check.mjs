/* Horn controls on a touch-emulated phone, and the steering wheel that no
   longer carries one.

   The HORN boss in the middle of the analog wheel has been removed — a
   second horn control a hand's width from the HORN puck. This file
   used to prove that hub honked without ever costing a steering input; it now
   proves the opposite half — that the wheel is nothing but a wheel, that no
   press anywhere on it can sound the horn, and that every route the horn
   still has works:

     - the HORN puck (#tcH), which is on screen in every steer mode,
     - the F key, including a sub-frame stab (the HORN_MIN_S floor),
     - and a HELD F on a touch device, which the frame watchdog must not eat.

   Runs against a dev or production server: pass --url, or let it default to
   the dev port. Usage: node test/horn-controls-check.mjs --url http://localhost:3141 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer, { KnownDevices } from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";
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

/* down+move in ONE evaluate, so the press and the drag cannot be straddled by
   a slow CDP round trip on this box and read as two separate gestures. */
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
// the wheel only exists in wheel steer mode, so seed the profile into it
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("neonx.profile.v3", JSON.stringify({ settings: { steerMode: "wheel" } }));
});
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
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

/* `horn2-` rather than `horn-`: the old suite's captures are the record of a
   control that existed, so they are never overwritten. */
const shot = async (name, caption) => {
  const raw = await page.screenshot({ type: "png" });
  const out = path.join(OUT, `horn${name}.jpg`);
  await sharp(raw).resize({ width: 1200 }).jpeg({ quality: 80 }).toFile(out);
  console.log("  📸", out, "—", caption);
};

await shot("2-wheel-idle",
  "Dashcam, phone, wheel steer mode after the hub removal: the wheel carries no HORN boss. The horn is the HORN puck in the right-hand cluster, which is on screen in every steer mode.");

check("wheel is mounted (steerMode=wheel)", await page.evaluate(
  () => !!document.getElementById("swheel")));
check("the wheel hub is GONE", await page.evaluate(
  () => !document.getElementById("swheelHub")));
check("no #swheelHub CSS is left behind", await page.evaluate(() => {
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) if (r.selectorText?.includes("swheelHub")) return false;
  }
  return true;
}));
check("HORN puck is still on screen", await page.evaluate(
  () => !!document.getElementById("tcH")?.getBoundingClientRect().width));
check("setWheelHorn is gone from the engine", await page.evaluate(
  () => typeof window.__neonx.game.setWheelHorn === "undefined"));

/* ---- 1. a press at the wheel's CENTRE is silent ----
   Dead centre is where the boss used to be, so this is the assertion that the
   removal was a removal and not just a hidden element. */
let before = await state(page);
await wheelPt(page, "pointerdown", 40);
await advance(page, 3);
let s = await state(page);
check("a press on the wheel centre does not honk", s.starts === before.starts && !s.sounding,
  JSON.stringify(s));
check("...and does not steer either, until it moves", Math.abs(s.wheel) < 1e-6, `wheelVal=${s.wheel}`);
await wheelPt(page, "pointerup", 40);
await advance(page, 3);
s = await state(page);
check("release leaves nothing sounding or held", !s.sounding && !s.key, JSON.stringify(s));

/* ---- 2. a drag from the centre steers, and stays silent ---- */
before = await state(page);
await wheelDragFrom(page, 41, 0, 45);
await advance(page, 3);
s = await state(page);
check("drag from the centre steers", Math.abs(s.wheel) > 0.5, `wheelVal=${s.wheel}`);
check("drag from the centre is silent", s.starts === before.starts && !s.sounding,
  `starts +${s.starts - before.starts} sounding=${s.sounding}`);
await shot("2-drag-from-centre",
  "A finger started dead centre — where the HORN boss used to be — and dragged. The wheel is deflected and steering, and nothing honked.");
await wheelPt(page, "pointerup", 41);
await advance(page, 3);
check("drag release recentres the wheel", Math.abs((await state(page)).wheel) < 1e-6);

/* ---- 3. a drag starting on the RIM is unchanged ---- */
before = await state(page);
await wheelDragFrom(page, 47, 50, 90);
await advance(page, 3);
s = await state(page);
check("rim drag steers", Math.abs(s.wheel) > 0.5, `wheelVal=${s.wheel}`);
check("rim drag is silent", s.starts === before.starts && !s.sounding, JSON.stringify(s));
await wheelPt(page, "pointerup", 47);
await advance(page, 3);
check("rim drag release recentres the wheel", Math.abs((await state(page)).wheel) < 1e-6);

/* ---- 4. pointercancel on the wheel leaves nothing stuck ---- */
await wheelPt(page, "pointerdown", 44);
await advance(page, 2);
await wheelPt(page, "pointermove", 44, 40);
await advance(page, 2);
await wheelPt(page, "pointercancel", 44);
await advance(page, 3);
s = await state(page);
check("pointercancel releases the wheel",
  !s.sounding && !s.key && Math.abs(s.wheel) < 1e-6, JSON.stringify(s));

/* ---- 5. the HORN puck is still the horn ---- */
before = await state(page);
await puckPt(page, "tcH", "pointerdown", 45);
await advance(page, 3);
s = await state(page);
check("HORN puck honks", s.starts === before.starts + 1 && s.sounding, JSON.stringify(s));
check("HORN puck lights while held", await page.evaluate(
  () => !!document.getElementById("tcH")?.classList.contains("pressed")));
await shot("2-puck-honking",
  "The horn that is left: the HORN puck lit and sounding, with the wheel untouched beside it.");
await puckPt(page, "tcH", "pointerup", 45);
await advance(page, 3);
s = await state(page);
check("HORN puck release stops the horn", !s.sounding && !s.key, JSON.stringify(s));

/* ---- 6. the puck and the wheel do not interfere ---- */
before = await state(page);
await puckPt(page, "tcH", "pointerdown", 48);
await advance(page, 2);
await wheelPt(page, "pointerdown", 49);
await advance(page, 2);
await wheelPt(page, "pointermove", 49, 40);
await advance(page, 2);
s = await state(page);
check("steering while honking keeps the horn on", s.sounding && s.key, JSON.stringify(s));
check("...and the wheel still steers", Math.abs(s.wheel) > 0.4, `wheelVal=${s.wheel}`);
await wheelPt(page, "pointerup", 49);
await advance(page, 2);
s = await state(page);
check("letting go of the wheel does not cut the still-held puck", s.sounding && s.key,
  JSON.stringify(s));
await puckPt(page, "tcH", "pointerup", 48);
await advance(page, 3);
s = await state(page);
check("releasing the puck finally stops the horn", !s.sounding && !s.key, JSON.stringify(s));

/* ---- 7. a sub-frame keyboard stab still sounds (the HORN_MIN_S floor) ----
   input.horn is a per-frame sample of keydown["f"], so a press and release
   dispatched back-to-back in one task is exactly the case the floor exists
   for: without it this is silent, which is the half of a quick double beep
   that used to go missing. */
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
   Regression guard for the watchdog bug found here: every puck registers
   a touchHold on its key, and an idle hold's id set is empty. The watchdog
   used to read an empty id set as the finger having lifted, and zero the key on the very
   next frame — whoever had pressed it. On any touch device with a keyboard
   attached that made W/A/S/D/F impossible to HOLD at all. */
before = await state(page);
await page.evaluate(() => dispatchEvent(new KeyboardEvent("keydown", { key: "f" })));
await advance(page, 3);
s = await state(page);
check("a held F survives the touch watchdog", s.sounding && s.key, JSON.stringify(s));
await page.evaluate(() => dispatchEvent(new KeyboardEvent("keyup", { key: "f" })));
await advance(page, 3);
check("...and releasing it stops the horn", !(await state(page)).sounding);

check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
