/* Headless proof for the mobile-input lane's stuck-steering / cross-finger
   fixes (bindPointerHold, watchdogTouchInput, SteerWheel in GameApp.tsx).

   Loads the real page under touch+coarse-pointer emulation so Game.isTouch
   is true, gets to "playing" the normal way (DRIVE tap), then drives the
   actual bound DOM elements with synthetic PointerEvents and reads the
   result straight off window.__neonx.game — the same debug handle every
   other test/*.mjs script in this repo uses (TS `private` is erased at
   runtime, so game.keydown/touchHolds/wheelVal/livePointers are all plain
   properties). No new debug surface added for this.

   Usage: node test/touch-input-check.mjs [--url http://localhost:3113] */

import { spawn } from "node:child_process";
import puppeteer, { KnownDevices } from "puppeteer";

const argUrl = process.argv.indexOf("--url");
const externalUrl = argUrl > -1 ? process.argv[argUrl + 1] : null;
const PORT = 3113;
const URL = externalUrl || `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDev() {
  if (externalUrl) return null;
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    detached: true, // own process group, so killing it also kills Turbopack's child
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("next dev timeout")), 120000);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      process.stdout.write("[next] " + s);
      if (s.includes("Ready") || s.includes("started server")) {
        clearTimeout(to);
        resolve();
      }
    });
    child.stderr.on("data", (d) => process.stderr.write("[next:err] " + d.toString()));
    child.on("exit", (c) => reject(new Error("next dev exited " + c)));
  });
  return child;
}

let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    console.log("  OK   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (detail ? "  (" + detail + ")" : ""));
  }
};

/* Dispatches a real PointerEvent at an element id inside the page — same
   constructor a browser uses for a finger touching glass, just with an
   id we control so we can pit two "fingers" against each other. */
async function firePointer(page, elId, type, pointerId, extra = {}) {
  await page.evaluate(
    (id, t, pid, ex) => {
      const el = document.getElementById(id) || window;
      const ev = new PointerEvent(t, {
        pointerId: pid,
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
        isPrimary: true,
        clientX: 100,
        clientY: 100,
        ...ex,
      });
      el.dispatchEvent(ev);
    },
    elId,
    type,
    pointerId,
    extra,
  );
}

const gameState = (page, path) =>
  page.evaluate((p) => {
    const g = window.__neonx?.game;
    if (!g) return undefined;
    return p.split(".").reduce((o, k) => o?.[k], g);
  }, path);

async function main() {
  const dev = await startDev();
  try {
    await run(dev);
  } finally {
    // detached: true above puts Turbopack's real child in its own group —
    // killing just `dev` leaves the port bound and every re-run EADDRINUSEs.
    if (dev?.pid) {
      try {
        process.kill(-dev.pid, "SIGKILL");
      } catch {}
    }
  }
}

async function run(dev) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=430,932",
      "--mute-audio",
    ],
    protocolTimeout: 300000,
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) pageErrors.push(m.text());
  });

  // Touch + coarse-pointer BEFORE navigation: Game.isTouch is computed once,
  // synchronously, in the constructor.
  await page.emulate(KnownDevices["iPhone 13"]);
  // Seed the profile with steerMode:"wheel" before the app's own script runs,
  // so #swheel (SteerWheel in GameApp.tsx) mounts once Drive is tapped —
  // otherwise the default "buttons" mode never renders it and the wheel-mode
  // pointer-id fix below would have nothing to test against.
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("neonx.profile.v3", JSON.stringify({ settings: { steerMode: "wheel" } }));
  });

  console.log("→ loading", URL, "(touch-emulated)");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });

  const isTouch = await gameState(page, "isTouch");
  const bodyTouch = await page.evaluate(() => document.body.classList.contains("touch"));
  check("Game.isTouch true under emulation", isTouch === true, `isTouch=${isTouch}`);
  check("body.touch class present", bodyTouch === true);
  if (!isTouch) {
    console.log("  Emulation did not produce a coarse pointer in this environment — the");
    console.log("  rest of this script exercises the desktop pointer path instead, which");
    console.log("  the touch-only bindPointerHold/watchdog code never runs. Treat the");
    console.log("  results below as informative only; see the report's reasoning table.");
  }

  // ---- get to "playing": same path a real driver takes ----
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b?.click();
  });
  await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
  await sleep(1500); // let the loop (beginLoop) settle into a steady frame rate

  console.log("\n=== TEST A — a stray pointerup from an UNCAPTURED second finger must not release the first finger's hold (CONFIRMED bug) ===");
  await firePointer(page, "tcL", "pointerdown", 101);
  check("press finger 1 -> keydown.a = 1", (await gameState(page, "keydown.a")) === 1);
  await firePointer(page, "tcL", "pointerup", 202); // a finger that never pressed tcL
  check("stray pointerup from finger 2 does NOT release", (await gameState(page, "keydown.a")) === 1);
  await firePointer(page, "tcL", "pointerup", 101);
  check("finger 1's own pointerup DOES release", (await gameState(page, "keydown.a")) === 0);

  console.log("\n=== TEST B — two fingers on the SAME puck: first lift must not release it (press-counting) ===");
  await firePointer(page, "tcG", "pointerdown", 1);
  await firePointer(page, "tcG", "pointerdown", 2);
  check("both fingers down -> keydown.w = 1", (await gameState(page, "keydown.w")) === 1);
  await firePointer(page, "tcG", "pointerup", 1);
  check("first finger up, second still down -> still held", (await gameState(page, "keydown.w")) === 1);
  await firePointer(page, "tcG", "pointerup", 2);
  check("last finger up -> released", (await gameState(page, "keydown.w")) === 0);

  console.log("\n=== TEST C — lostpointercapture fires with no matching pointerup/cancel (element hidden mid-hold, capture stolen, etc.) ===");
  await firePointer(page, "tcB", "pointerdown", 5);
  check("press -> keydown.s = 1", (await gameState(page, "keydown.s")) === 1);
  await firePointer(page, "tcB", "lostpointercapture", 5);
  check("lostpointercapture alone releases", (await gameState(page, "keydown.s")) === 0);

  console.log("\n=== TEST D — pause (gearBtn) clears a mid-hold touch press so Drive cannot resume already-steering ===");
  await firePointer(page, "tcL", "pointerdown", 7);
  check("holding steer-left going into pause", (await gameState(page, "keydown.a")) === 1);
  await page.evaluate(() => document.getElementById("gearBtn")?.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
  ));
  await sleep(150);
  const runningAfterPause = await gameState(page, "running");
  check("setRunning(false) actually paused", runningAfterPause === false);
  check("keydown.a cleared by the pause (clearLatchedInput)", (await gameState(page, "keydown.a")) === 0);
  // resume — real finger is long gone; the stuck-ON scenario this guards
  // against is exactly "resumes still steering with nobody touching it"
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "RESUME");
    b?.click();
  });
  await sleep(150);
  check("still not steering after resume with no finger down", (await gameState(page, "keydown.a")) === 0);

  console.log("\n=== TEST E — belt-and-braces watchdog: window sees the pointer go away but the element itself gets nothing ===");
  const livePointers = () => page.evaluate(() => Array.from(window.__neonx.game.livePointers));
  const touchHoldIds = (id) =>
    page.evaluate((elId) => Array.from(window.__neonx.game.touchHolds.get(elId)?.ids ?? []), id);
  await firePointer(page, "tcH", "pointerdown", 42);
  check("press -> keydown.f = 1", (await gameState(page, "keydown.f")) === 1);
  const seenLive = await livePointers();
  check("window-level capture listener recorded the pointer id", seenLive.includes(42), JSON.stringify(seenLive));
  check("tcH's own hold set recorded pointer 42", (await touchHoldIds("tcH")).includes(42));
  // dispatched at window, not at #tcH: the element gets nothing, only the
  // capture-phase window listener (onLivePointerGone) sees this pointer end —
  // standing in for a browser-level gesture hijack that eats the element-level
  // release entirely.
  await firePointer(page, "window", "pointerup", 42);
  check("keydown.f still 1 immediately (no element release fired)", (await gameState(page, "keydown.f")) === 1);
  check("but livePointers no longer has it", !(await livePointers()).includes(42), JSON.stringify(await livePointers()));
  // SwiftShader in this sandbox renders at a few fps, not 60 — wait on the
  // frame counter itself (a couple of real ticks of the rAF loop) rather than
  // a fixed sleep that assumes a frame rate this environment doesn't have.
  const f0 = await gameState(page, "debug.frames");
  await page.waitForFunction(
    (start) => (window.__neonx?.game?.debug.frames ?? start) >= start + 2,
    { timeout: 20000 },
    f0,
  );
  check(
    "watchdog releases it within a couple of real frames",
    (await gameState(page, "keydown.f")) === 0,
    `holds=${JSON.stringify(await touchHoldIds("tcH"))} live=${JSON.stringify(await livePointers())}`,
  );

  console.log("\n=== TEST F — SteerWheel (wheel mode): a second finger joining mid-drag must not re-base the origin or end the drag ===");
  const swheelPresent = await page.evaluate(() => !!document.getElementById("swheel"));
  check("#swheel mounted (steerMode:\"wheel\" seed took)", swheelPresent);
  if (swheelPresent) {
    // finger 1 grabs the wheel and drags right — clientX matters here (unlike
    // the hold pucks above), so give each event its own coordinates instead
    // of firePointer's fixed 100,100.
    await page.evaluate(() => {
      document.getElementById("swheel").dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 11, bubbles: true, cancelable: true, pointerType: "touch", clientX: 50, clientY: 50 })
      );
    });
    await page.evaluate(() => {
      document.getElementById("swheel").dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 11, bubbles: true, cancelable: true, pointerType: "touch", clientX: 108, clientY: 50 })
      ); // +58px = full lock right, v should land at 1
    });
    const vAfterFirstDrag = await gameState(page, "wheelVal");
    check("finger 1 drag -> wheelVal ~= 1", Math.abs(vAfterFirstDrag - 1) < 0.05, `wheelVal=${vAfterFirstDrag}`);
    // second finger joins mid-drag: pre-fix this re-based cx to finger 2's
    // position, so the NEXT move from finger 1 would jump to a wrong value —
    // post-fix, onPointerDown returns early because active.current is true.
    await page.evaluate(() => {
      document.getElementById("swheel").dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 22, bubbles: true, cancelable: true, pointerType: "touch", clientX: 50, clientY: 50 })
      );
    });
    // finger 2 lifts — pre-fix, ANY pointerup ended the drag (end() -> 0);
    // post-fix this is ignored because pid.current is still 11.
    await page.evaluate(() => {
      document.getElementById("swheel").dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 22, bubbles: true, cancelable: true, pointerType: "touch" })
      );
    });
    check("finger 2's join+lift did not reset the drag", Math.abs((await gameState(page, "wheelVal")) - 1) < 0.05, `wheelVal=${await gameState(page, "wheelVal")}`);
    // finger 1, still down, keeps steering — proves the origin was never re-based
    await page.evaluate(() => {
      document.getElementById("swheel").dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 11, bubbles: true, cancelable: true, pointerType: "touch", clientX: 50, clientY: 50 })
      ); // back to origin -> v should land at 0, not some offset from finger 2's touch point
    });
    check("finger 1 still owns the drag, no jump from finger 2's origin", Math.abs(await gameState(page, "wheelVal")) < 0.05, `wheelVal=${await gameState(page, "wheelVal")}`);
    // finger 1 lifts -> real release
    await page.evaluate(() => {
      document.getElementById("swheel").dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 11, bubbles: true, cancelable: true, pointerType: "touch" })
      );
    });
    check("finger 1's release zeroes the wheel", (await gameState(page, "wheelVal")) === 0);
    check("wheelPointerId cleared", (await gameState(page, "wheelPointerId")) === null);
  }

  console.log("\n=== TEST G — CSS: #mmap lets touches fall through to the canvas, user-select:none is global ===");
  const mmapPE = await page.evaluate(() => getComputedStyle(document.getElementById("mmap")).pointerEvents);
  check("#mmap pointer-events: none", mmapPE === "none", mmapPE);
  const bodyUserSelect = await page.evaluate(() => getComputedStyle(document.body).webkitUserSelect || getComputedStyle(document.body).userSelect);
  check("body user-select: none", bodyUserSelect === "none", bodyUserSelect);
  const tcUserSelect = await page.evaluate(() => {
    const el = document.getElementById("tcG");
    return el ? getComputedStyle(el).userSelect : "n/a";
  });
  check("touch puck inherits user-select: none from the global rule", tcUserSelect === "none", tcUserSelect);

  console.log("\n=== errors ===");
  if (pageErrors.length) {
    for (const e of pageErrors) console.log("  ⛔", e.slice(0, 300));
    fail += pageErrors.length;
  } else {
    console.log("  none");
  }

  await browser.close();
  console.log(fail ? `\nFAIL (${fail})` : "\nOK: all touch-input checks passed");
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
