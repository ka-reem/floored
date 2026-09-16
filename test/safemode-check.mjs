/* Safe mode — does a device that dies on the loading screen recover?
 *
 * The bug this guards (game/safemode.ts has the full write-up): an iPhone 13
 * on Safari is called `mobile-high` off a masked GPU string, loads the full
 * donor cabin, spikes ~210 MB decoding its 21 images during GLB parse, and
 * has its WebGL context taken away. The panel says RELOAD; reloading rebuilds
 * the same world the same way and dies in the same place. The failure is a
 * BRICK, not a crash, and that is what is being tested here — not that the
 * crash stops happening, but that the SECOND one is the last one.
 *
 * Four things, in one browser, two full world builds:
 *   1. a clean boot is untouched  — donor cabin up, nothing latched
 *   2. the crash panel offers the way out, and the button latches it
 *   3. a latched boot really is lighter — mobile-base, procedural cabin
 *   4. a success in safe mode does NOT unlatch (or it re-crashes forever)
 *   5. two unfinished boots latch on their own, for the player who never
 *      finds the button
 *
 * Usage: node test/safemode-check.mjs [--url http://localhost:3111]
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const ART = path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });

const argUrl = process.argv.indexOf("--url");
const externalUrl = argUrl > -1 ? process.argv[argUrl + 1] : null;
const argLoad = process.argv.indexOf("--loadms");
const LOAD_MS = argLoad > -1 ? Number(process.argv[argLoad + 1]) : 2700000;
const PORT = 3131;
const URL = externalUrl || `http://localhost:${PORT}`;
const KEY = "neonx.safemode";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const ok = (cond, msg) => {
  console.log(cond ? "  OK   " : "  FAIL ", msg);
  if (!cond) errors.push(msg);
};

async function startDev() {
  if (externalUrl) return null;
  /* --webpack: this repo's node_modules is a symlink and Turbopack refuses
     it, which reads as "the game is broken" rather than "the harness is". */
  const child = spawn("npx", ["next", "dev", "--webpack", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("next dev timeout")), 180000);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Ready") || s.includes("started server")) {
        clearTimeout(to);
        resolve();
      }
    });
    child.on("exit", (c) => reject(new Error("next dev exited " + c)));
  });
  await sleep(1500);
  return child;
}

const clickBtn = (page, label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      x.textContent.includes(l)
    );
    if (!b) throw new Error("no button " + l);
    b.click();
  }, label);

/** The persisted latch, as the game left it. */
const latch = (page, k) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), k);

/** Seed it, then reload so the module-level snapshot is taken fresh. */
async function seed(page, value) {
  await page.evaluate(
    (key, v) => {
      if (v === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(v));
    },
    KEY, value
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
}

/** DRIVE, then wait out the world build. */
async function drive(page) {
  await clickBtn(page, "DRIVE");
  await page.waitForFunction(() => window.__neonx?.game?.loaded, {
    timeout: LOAD_MS, polling: 5000,
  });
}

/** What the rig actually ended up with — the only honest answer to "is this
    build lighter", since every other signal is a setting rather than a fact. */
const rigState = (page) =>
  page.evaluate(() => ({
    tier: window.__neonx.game.renderTier,
    donorCabin: !!window.__neonx.game.rig?.cockpitModel,
    cabinPbrMaps: window.__neonx.game.tierCaps?.cabinPbrMaps ?? null,
  }));

const run = async () => {
  /* Both of these are started BEFORE the try that owns their cleanup, which
     leaked a next dev on this port the first time the browser launch threw —
     and a held port reads as "the test is broken" on every run after. Declared
     out here, assigned inside, so the finally can close whatever exists. */
  let dev = null;
  let browser = null;
  try {
    dev = await startDev();
    browser = await puppeteer.launch({
    headless: "new",
    /* Honour a browser the environment already has. Sandboxes that skip
       puppeteer's own download (PUPPETEER_SKIP_DOWNLOAD, as app builds set)
       otherwise fail here with "Could not find Chrome", which reads as a
       broken test rather than a missing binary. Unset = puppeteer's own. */
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

    await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });

    /* ---- 1. a clean boot is untouched ---------------------------------- */
    console.log("\n[1] clean boot");
    await seed(page, null);
    await drive(page);
    const clean = await rigState(page);
    ok(clean.donorCabin, `clean boot keeps the donor cabin (tier ${clean.tier})`);
    ok(clean.tier !== "mobile-base", `clean boot keeps its detected tier (${clean.tier})`);
    const cleanLatch = await latch(page, KEY);
    ok(cleanLatch?.on === false, `a finished boot leaves safe mode off (${JSON.stringify(cleanLatch)})`);
    ok(cleanLatch?.fails === 0, "a finished boot clears the strike count");

    /* ---- 2. the panel offers the way out ------------------------------- */
    console.log("\n[2] context loss -> the panel and its button");
    await page.evaluate(() => {
      const cv = window.__neonx.game.renderer.domElement;
      const gl = cv.getContext("webgl2") || cv.getContext("webgl");
      gl.getExtension("WEBGL_lose_context").loseContext();
    });
    await page.waitForSelector("#gfxFail", { timeout: 60000 });
    const panel = await page.evaluate(() => {
      const root = document.getElementById("gfxFail");
      return {
        kind: root?.dataset.kind,
        buttons: [...root.querySelectorAll("button")].map((b) => b.textContent),
      };
    });
    ok(panel.kind === "lost", `the panel raised is the context-lost one (${panel.kind})`);
    ok(
      panel.buttons.some((b) => /SAFE MODE/.test(b)),
      `the panel offers a way out, not just RELOAD (${JSON.stringify(panel.buttons)})`
    );
    await page.screenshot({ path: path.join(ART, "safemode-panel.png") });
    console.log("      -> test/artifacts/safemode-panel.png");

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }),
      clickBtn(page, "SAFE MODE"),
    ]);
    const latched = await latch(page, KEY);
    ok(latched?.on === true, `the button latches safe mode (${JSON.stringify(latched)})`);

    /* ---- 3 + 4. a latched boot is lighter, and stays latched ----------- */
    console.log("\n[3] booting with safe mode latched");
    await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
    await drive(page);
    const safe = await rigState(page);
    ok(safe.tier === "mobile-base", `safe mode drops the tier to mobile-base (got ${safe.tier})`);
    ok(!safe.donorCabin, "safe mode refuses the donor cabin — the 280 MB item");
    ok(safe.cabinPbrMaps === false, "safe mode's tier declines the cabin PBR maps too");
    const afterSafe = await latch(page, KEY);
    ok(
      afterSafe?.on === true,
      `a SUCCESS in safe mode does not unlatch it (${JSON.stringify(afterSafe)}) — ` +
        "unlatching here is the brick with extra steps"
    );
    ok(afterSafe?.fails === 0, "...but it does clear the strike count");
    await page.screenshot({ path: path.join(ART, "safemode-drive.png") });
    console.log("      -> test/artifacts/safemode-drive.png");

    /* ---- 5. two unfinished boots latch on their own -------------------- */
    console.log("\n[5] second unfinished boot latches without the button");
    await seed(page, { fails: 1, on: false });
    const oneStrike = await latch(page, KEY);
    ok(oneStrike?.on === false, `one strike is not enough to latch (${JSON.stringify(oneStrike)})`);

    await clickBtn(page, "DRIVE");
    /* markBootStart() runs at the top of runLoad, before the slow stages, so
       the write lands almost immediately — but the main thread is about to be
       taken for minutes, so poll rather than assume a single read wins. */
    let tripped = null;
    for (let i = 0; i < 40; i++) {
      tripped = await latch(page, KEY).catch(() => null);
      if (tripped?.on === true) break;
      await sleep(500);
    }
    ok(
      tripped?.on === true && tripped?.fails === 2,
      `the second unfinished boot latches by itself (${JSON.stringify(tripped)})`
    );
  } finally {
    await browser?.close().catch(() => {});
    dev?.kill("SIGTERM");
  }

  console.log(errors.length ? `\nFAILED (${errors.length})` : "\nALL PASS");
  for (const e of errors) console.log("  - " + e);
  process.exit(errors.length ? 1 : 0);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
