/* Functional checks + gallery screenshots for the mobile-controls lane: the
   ⋯ overflow drawer and the tappable signal telltales, on a touch-emulated
   phone against a production build (next start).

   The load-bearing assertions are the defensive ones from the mission brief:
   a press on the wheel or a puck must register while the drawer is open AND
   while it is animating closed (the drawer may only ever close as a side
   effect of input, never consume it), drive input must close it, and the
   sheet must never overlap a steering/pedal hit area.

   Usage: next build && node test/mobile-controls-check.mjs */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer, { KnownDevices } from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";
import sharp from "sharp";

const PORT = 3211;
const OUT = path.join(process.cwd(), "docs", "gallery", "img");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail); }
}

async function startServer() {
  const child = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("next start timeout")), 120000);
    child.stdout.on("data", (d) => {
      if (d.toString().includes("Ready")) { clearTimeout(to); resolve(); }
    });
    child.stderr.on("data", (d) => process.stderr.write("[next:err] " + d.toString()));
    child.on("exit", (c) => reject(new Error("next start exited " + c)));
  });
  return child;
}

/* `name` is the full gallery basename: this file now shoots for two lanes
   (mobile-controls-* and the slider mode's swipe-*). */
async function shot(page, name, caption) {
  const raw = await page.screenshot({ type: "png" });
  const outPath = path.join(OUT, `${name}.jpg`);
  const img = sharp(raw);
  const meta = await img.metadata();
  const resized = meta.width > 1200 ? img.resize({ width: 1200 }) : img;
  await resized.jpeg({ quality: 80 }).toFile(outPath);
  console.log("  📸", outPath, "—", caption);
}

const pageErrors = [];

async function newSession(browser, { viewport, seedProfile } = {}) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) pageErrors.push(m.text());
  });
  if (viewport) await page.setViewport({ ...viewport, isMobile: true, hasTouch: true });
  else await page.emulate(KnownDevices["iPhone 13"]);
  if (seedProfile) {
    await page.evaluateOnNewDocument((profile) => {
      localStorage.setItem("neonx.profile.v3", JSON.stringify(profile));
    }, seedProfile);
  }
  await page.goto(debugUrl(`http://localhost:${PORT}`), { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b?.click();
  });
  await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
  await page.evaluate(() => window.__neonx.setCam(4)); // CAM_POV — the shipped dashcam view
  await sleep(2000);
  return page;
}

const pd = (id, pointerId, opts = {}) =>
  `document.getElementById(${JSON.stringify(id)})?.dispatchEvent(new PointerEvent("pointerdown", { pointerId: ${pointerId}, bubbles: true, cancelable: true, ...${JSON.stringify(opts)} }))`;
const pu = (id, pointerId) =>
  `document.getElementById(${JSON.stringify(id)})?.dispatchEvent(new PointerEvent("pointerup", { pointerId: ${pointerId}, bubbles: true, cancelable: true }))`;

async function openDrawer(page) {
  await page.evaluate(pd("tcMore", 90));
  await page.evaluate(pu("tcMore", 90));
  await page.waitForFunction(
    () => document.getElementById("tcDrawer")?.classList.contains("open"),
    { timeout: 3000 }
  );
  await sleep(250); // let the 160 ms transition land
}

async function tapRow(page, label) {
  await page.evaluate((l) => {
    const row = [...document.querySelectorAll("#tcDrawer .qdRow")].find((r) =>
      r.textContent.includes(l)
    );
    row?.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 91, bubbles: true }));
    row?.dispatchEvent(new PointerEvent("pointerup", { pointerId: 91, bubbles: true }));
  }, label);
}

async function main() {
  const server = await startServer();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
        "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
      ],
      protocolTimeout: 300000,
    });

    /* ---------------- session A: iPhone 13, default (buttons) mode -------- */
    console.log("— session A: iPhone 13, buttons mode");
    const page = await newSession(browser);

    // surface exists, correctly gated, correct functional CSS
    check("body.touch set", await page.evaluate(() => document.body.classList.contains("touch")));
    check("⋯ chip visible", await page.evaluate(
      () => getComputedStyle(document.getElementById("tcMore")).display === "flex"));
    check("⋯ chip touch-action manipulation", await page.evaluate(
      () => getComputedStyle(document.getElementById("tcMore")).touchAction === "manipulation"));
    check("drawer mounted but inert while closed", await page.evaluate(() => {
      const s = getComputedStyle(document.getElementById("tcDrawer"));
      return s.opacity === "0" && s.pointerEvents === "none";
    }));
    /* The tap-to-signal telltales were REMOVED at the owner's request
       (d4356a7) — signals are keyboard-only again, and the telltales must be
       passive glyphs a mid-turn touch cannot trip. These three checks used
       to assert the opposite and were left failing by that commit; they now
       pin the removal instead. */
    check("signal telltales are passive again (owner removed tap-to-signal)", await page.evaluate(
      () => getComputedStyle(document.getElementById("indL")).pointerEvents === "none"));
    await page.evaluate(pd("indL", 80));
    await page.evaluate(pu("indL", 80));
    check("tap on ◀ cannot toggle a signal", await page.evaluate(() => window.__neonx.game.car.sigL === false));
    // the glyphs still light from the engine's own path (the E key)
    await page.evaluate(() => window.__neonx.game.uiKeyTap("e"));
    check("telltale still lights from the key path", await page.evaluate(
      () => window.__neonx.game.car.sigR === true));
    try {
      await page.waitForFunction(() => document.getElementById("indR")?.className.includes("on"), { timeout: 2000 });
    } catch {}
    await shot(page, "mobile-controls-01-driving", "Dashcam driving view: pucks, the lit ▶ signal telltale, and the ⋯ overflow chip beside the pause gear.");
    await page.evaluate(() => window.__neonx.game.uiKeyTap("e")); // signal back off

    // drawer opens; no geometric overlap with any driving control
    await openDrawer(page);
    // pointer-events flips with the class; opacity needs the compositor,
    // which under SwiftShader runs at a few fps — poll rather than sleep
    let drawerShown = false;
    try {
      await page.waitForFunction(
        () => getComputedStyle(document.getElementById("tcDrawer")).opacity === "1",
        { timeout: 8000, polling: 120 }
      );
      drawerShown = await page.evaluate(
        () => getComputedStyle(document.getElementById("tcDrawer")).pointerEvents === "auto");
    } catch {}
    check("drawer opens from ⋯", drawerShown);
    check("drawer overlaps no steering/pedal hit area", await page.evaluate(() => {
      const d = document.getElementById("tcDrawer").getBoundingClientRect();
      const hit = (r) => d.left < r.right && d.right > r.left && d.top < r.bottom && d.bottom > r.top;
      return ["tcL", "tcR", "tcG", "tcB", "tcC", "tcF", "tcH", "swheel", "sslider"].every((id) => {
        const el = document.getElementById(id);
        if (!el || getComputedStyle(el).display === "none") return true;
        return !hit(el.getBoundingClientRect());
      });
    }));
    await shot(page, "mobile-controls-02-drawer", "The ⋯ drawer open mid-drive (game not paused): every keyboard-only feature as a labeled bilingual toggle, clear of all driving controls.");

    // rows drive the real key paths and read back live state
    await tapRow(page, "HEADLIGHTS");
    check("HEADLIGHTS row = L key", await page.evaluate(() => window.__neonx.game.car.lightsUser === true));
    check("row state chip updated", await page.evaluate(() =>
      [...document.querySelectorAll("#tcDrawer .qdRow")].find((r) => r.textContent.includes("HEADLIGHTS"))
        ?.querySelector(".qdState")?.textContent === "ON"));
    await tapRow(page, "RAIN");
    check("RAIN row = R key", await page.evaluate(() => window.__neonx.game.rain === true));
    await tapRow(page, "RAIN"); // leave the shots dry
    await tapRow(page, "TEST MODE");
    check("TEST MODE row = K key (writes the persisted setting)", await page.evaluate(
      () => window.__neonx.game.settings.testMode === true));
    await tapRow(page, "TEST MODE");
    check("drawer still open after toggling rows", await page.evaluate(
      () => document.getElementById("tcDrawer").classList.contains("open")));

    // THE defensive core: drive input registers instantly and closes the drawer
    await page.evaluate(pd("tcL", 11));
    check("steer press registers synchronously while drawer is open", await page.evaluate(
      () => window.__neonx.game.keydown["a"] === 1));
    await page.waitForFunction(() => !document.getElementById("tcDrawer").classList.contains("open"), { timeout: 2000 });
    check("that same press closes the drawer", true);
    check("steer still held through the close", await page.evaluate(
      () => window.__neonx.game.keydown["a"] === 1));
    await page.evaluate(pu("tcL", 11));
    check("steer releases cleanly", await page.evaluate(() => window.__neonx.game.keydown["a"] === 0));

    // input lands during the close animation too (the sheet is already inert)
    await openDrawer(page);
    await page.evaluate(pd("tcG", 12)); // throttle: closes drawer, must also drive
    await shot(page, "mobile-controls-03-close-on-drive", "Close-on-drive-input: a throttle press while the drawer was open — the already-inert sheet fades away and the very press that dismissed it is driving.");
    const midClose = await page.evaluate(() => {
      const s = getComputedStyle(document.getElementById("tcDrawer"));
      return { opacity: parseFloat(s.opacity), pe: s.pointerEvents, th: window.__neonx.game.keydown["w"] };
    });
    check("throttle held while drawer animates closed", midClose.th === 1, JSON.stringify(midClose));
    check("closing drawer is pointer-inert (cannot eat input)", midClose.pe === "none", JSON.stringify(midClose));
    await page.evaluate(pd("tcB", 13));
    check("second press lands during the close animation", await page.evaluate(
      () => window.__neonx.game.keydown["s"] === 1));
    await page.evaluate(pu("tcG", 12));
    await page.evaluate(pu("tcB", 13));

    // reset row is one-shot and self-closing
    await openDrawer(page);
    await tapRow(page, "RESET CAR");
    await page.waitForFunction(() => !document.getElementById("tcDrawer").classList.contains("open"), { timeout: 2000 });
    check("RESET CAR fires and closes the drawer", true);
    await page.close();

    /* ---------------- session B: wheel steer mode ------------------------- */
    console.log("— session B: iPhone 13, wheel mode");
    const pageW = await newSession(browser, { seedProfile: { settings: { steerMode: "wheel" } } });
    await openDrawer(pageW);
    await pageW.evaluate(() => {
      const w = document.getElementById("swheel");
      w?.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 21, bubbles: true, clientX: 70, clientY: 700 }));
      w?.dispatchEvent(new PointerEvent("pointermove", { pointerId: 21, bubbles: true, clientX: 120, clientY: 700 }));
    });
    check("steering wheel deflects on the press that closes the drawer", await pageW.evaluate(
      () => window.__neonx.game.wheelVal > 0.5));
    await sleep(60);
    check("wheel still deflected while drawer animates closed", await pageW.evaluate(
      () => window.__neonx.game.wheelVal > 0.5));
    await shot(pageW, "mobile-controls-04-wheel-mid-close", "Wheel steer mode: the drag that closed the drawer holds the wheel at lock — the drawer never blocks steering in any state.");
    await pageW.evaluate(() => {
      document.getElementById("swheel")?.dispatchEvent(new PointerEvent("pointerup", { pointerId: 21, bubbles: true }));
    });
    await pageW.close();

    /* ---------------- session C: small phone, 360x780 --------------------- */
    console.log("— session C: 360x780 small phone");
    const pageS = await newSession(browser, { viewport: { width: 360, height: 780 } });
    await openDrawer(pageS);
    check("small phone: drawer still overlaps no driving control", await pageS.evaluate(() => {
      const d = document.getElementById("tcDrawer").getBoundingClientRect();
      const hit = (r) => d.left < r.right && d.right > r.left && d.top < r.bottom && d.bottom > r.top;
      return ["tcL", "tcR", "tcG", "tcB", "tcC", "tcF", "tcH", "swheel", "sslider"].every((id) => {
        const el = document.getElementById(id);
        if (!el || getComputedStyle(el).display === "none") return true;
        return !hit(el.getBoundingClientRect());
      });
    }));
    check("small phone: drawer fits above the pedal strip", await pageS.evaluate(() => {
      const d = document.getElementById("tcDrawer").getBoundingClientRect();
      return d.bottom < document.getElementById("tcG").getBoundingClientRect().top;
    }));
    await shot(pageS, "mobile-controls-05-small-phone", "360×780 small-phone check: the drawer stays a corner sheet, clear of the map, HUD, pedals and steering.");
    await pageS.close();

    /* ---------------- session D: slider steer mode ------------------------ */
    /* The swipe-steer lane's mode: #sslider replaces the wheel, feeding the
       same wheelVal channel with ABSOLUTE thumb-position mapping. The checks
       mirror session B's pointer-discipline bar plus the slider's own
       contract: position = angle, release re-centres (value now, nub eased),
       a second finger on a pedal neither steals nor disturbs the drag, and
       the drawer neither eats the strip nor overlaps it. */
    console.log("— session D: iPhone 13, slider mode");
    const pageL = await newSession(browser, { seedProfile: { settings: { steerMode: "slider" } } });
    check("slider mounted, wheel and steer pucks not", await pageL.evaluate(() => {
      const puckHidden = (id) => getComputedStyle(document.getElementById(id)).display === "none";
      return !!document.getElementById("sslider") && !document.getElementById("swheel") &&
        puckHidden("tcL") && puckHidden("tcR");
    }));
    check("strip owns its gestures (touch-action none, children inert)", await pageL.evaluate(() => {
      const s = getComputedStyle(document.getElementById("sslider"));
      const kids = [...document.getElementById("sslider").querySelectorAll("*")];
      return s.touchAction === "none" && kids.every((k) => getComputedStyle(k).pointerEvents === "none");
    }));
    check("strip clear of every pedal/puck hit area", await pageL.evaluate(() => {
      const d = document.getElementById("sslider").getBoundingClientRect();
      const hit = (r) => d.left < r.right && d.right > r.left && d.top < r.bottom && d.bottom > r.top;
      return ["tcG", "tcB", "tcC", "tcF", "tcH"].every((id) => {
        const el = document.getElementById(id);
        if (!el || getComputedStyle(el).display === "none") return true;
        return !hit(el.getBoundingClientRect());
      });
    }));
    await sleep(600); // SwiftShader paints at a few fps — let the lit state actually land
    await shot(pageL, "swipe-01-strip-center", "Slider steer mode at rest: a low-profile token-styled strip where the wheel sits — centre detent, nub parked straight ahead.");

    // absolute mapping: the thumb's position on the strip IS the angle
    const geo = await pageL.evaluate(() => {
      const r = document.getElementById("sslider").getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, half: r.width / 2 - 22 };
    });
    const dragTo = (frac, pointerId = 41) => pageL.evaluate((x, y, pid) => {
      document.getElementById("sslider")?.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: pid, bubbles: true, clientX: x, clientY: y }));
    }, geo.cx + frac * geo.half, geo.cy, 41);
    await pageL.evaluate((x, y) => {
      document.getElementById("sslider")?.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 41, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, geo.cx, geo.cy);
    check("grab at the centre detent = straight ahead", await pageL.evaluate(
      () => Math.abs(window.__neonx.game.wheelVal) < 0.02));
    await dragTo(0.55);
    const vMid = await pageL.evaluate(() => window.__neonx.game.wheelVal);
    check("thumb at 55% of half-range steers to ~0.55", Math.abs(vMid - 0.55) < 0.03, `wheelVal=${vMid}`);
    await sleep(600); // SwiftShader paints at a few fps — let the lit state actually land
    await shot(pageL, "swipe-02-mid-swipe", "Mid-swipe: absolute mapping — the nub sits exactly where the thumb is, fill and nub lighting toward the accent with lock.");
    await dragTo(-0.55);
    const vRev = await pageL.evaluate(() => window.__neonx.game.wheelVal);
    check("crossing the centre reverses without re-basing", Math.abs(vRev + 0.55) < 0.03, `wheelVal=${vRev}`);
    await dragTo(1.4);
    check("past the strip's end clamps to full lock", await pageL.evaluate(
      () => window.__neonx.game.wheelVal === 1));
    await sleep(600); // SwiftShader paints at a few fps — let the lit state actually land
    await shot(pageL, "swipe-03-full-lock", "Full lock: the fill run out to the strip's end and the nub flush against it, lit to the accent.");

    // pointer discipline: a second finger on a pedal must not steal or disturb
    await pageL.evaluate(pd("tcG", 42));
    check("second finger throttles while the slider holds lock", await pageL.evaluate(
      () => window.__neonx.game.keydown["w"] === 1 && window.__neonx.game.wheelVal === 1));
    await pageL.evaluate(pu("tcG", 42));
    check("pedal finger's lift does not release the slider", await pageL.evaluate(
      () => window.__neonx.game.wheelVal === 1 && window.__neonx.game.keydown["w"] === 0));
    // ...and a second finger landing ON the strip neither re-bases nor releases
    await pageL.evaluate((x, y) => {
      const el = document.getElementById("sslider");
      el?.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 43, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el?.dispatchEvent(new PointerEvent("pointerup", { pointerId: 43, bubbles: true }));
    }, geo.cx, geo.cy);
    check("second finger on the strip itself is ignored", await pageL.evaluate(
      () => window.__neonx.game.wheelVal === 1));

    // release: the value re-centres now, the nub glides back (eased, not snapped)
    await pageL.evaluate(() => {
      document.getElementById("sslider")?.dispatchEvent(new PointerEvent("pointerup", { pointerId: 41, bubbles: true }));
    });
    check("release re-centres the steering value", await pageL.evaluate(
      () => window.__neonx.game.wheelVal === 0 && window.__neonx.game.wheelPointerId === null));
    /* The eased return is wall-clock CSS, but its interpolated value only
       advances when a frame commits, and SwiftShader here runs at sub-fps —
       polling the animated transform is a coin flip (same class of problem
       the touch-input suite hit with its fixed-sleep watchdog check). Assert
       the mechanism instead: React committed the centre as the target, the
       drag class is gone, and the not-dragging transition rule is live on
       the nub — which is exactly "eases home" on any real-speed device. */
    check("nub eases home after release (centre target + live transition)", await pageL.evaluate(() => {
      const el = document.getElementById("sslider");
      const nub = el.querySelector(".ssNub");
      const cs = getComputedStyle(nub);
      return !el.classList.contains("drag") &&
        nub.style.transform === "translateX(0px)" &&
        cs.transitionProperty.includes("transform") &&
        parseFloat(cs.transitionDuration) > 0;
    }));

    // pointercancel (browser hijack) releases to centre the same way
    await pageL.evaluate((x, y) => {
      const el = document.getElementById("sslider");
      el?.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 44, bubbles: true, cancelable: true, clientX: x + 40, clientY: y }));
      el?.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 44, bubbles: true }));
    }, geo.cx, geo.cy);
    check("pointercancel releases to centre", await pageL.evaluate(
      () => window.__neonx.game.wheelVal === 0 && window.__neonx.game.wheelPointerId === null));

    // drawer: opening it must not eat the strip, and the drag that closes it steers
    await openDrawer(pageL);
    check("drawer overlaps the strip nowhere", await pageL.evaluate(() => {
      const d = document.getElementById("tcDrawer").getBoundingClientRect();
      const r = document.getElementById("sslider").getBoundingClientRect();
      return !(d.left < r.right && d.right > r.left && d.top < r.bottom && d.bottom > r.top);
    }));
    await pageL.evaluate((x, y) => {
      document.getElementById("sslider")?.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 45, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, geo.cx + 0.8 * geo.half, geo.cy);
    check("slider deflects on the press that closes the drawer", await pageL.evaluate(
      () => window.__neonx.game.wheelVal > 0.7));
    await pageL.waitForFunction(() => !document.getElementById("tcDrawer").classList.contains("open"), { timeout: 2000 });
    check("that press closed the drawer and still steers", await pageL.evaluate(
      () => window.__neonx.game.wheelVal > 0.7));
    await pageL.evaluate(() => {
      document.getElementById("sslider")?.dispatchEvent(new PointerEvent("pointerup", { pointerId: 45, bubbles: true }));
    });
    await pageL.close();

    console.log(`\n${pass} passed, ${fail} failed, ${pageErrors.length} page errors`);
    for (const e of pageErrors) console.log("  [pageerror]", e);
    if (fail || pageErrors.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server?.pid) { try { process.kill(-server.pid, "SIGKILL"); } catch {} }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
