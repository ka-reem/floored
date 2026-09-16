/* Replicating the iPhone 13 / Safari "GPU context lost" report.
 *
 * WHAT CAN AND CANNOT BE REPLICATED ON THIS BOX, stated up front because the
 * difference is the whole value of the number below.
 *
 *   CAN: the CONFIGURATION the phone resolves to, and the TEXTURE MEMORY that
 *   configuration uploads. Both are decisions the game makes from signals we
 *   can reproduce exactly — and both are measured here from the real assets,
 *   not from a static audit of the files.
 *
 *   CANNOT: Safari's decision to drop the context. That is iOS's memory
 *   manager on 4 GB of shared RAM, and no Linux/SwiftShader run reproduces it.
 *
 * So this does not prove that the phone crashes. It proves what the phone is
 * asked to carry, and how much less it is asked to carry in safe mode. The
 * crash report supplies the other half.
 *
 * THE MASKED RENDERER STRING IS THE POINT, not a cheat. iOS Safari really does
 * report "Apple GPU" instead of the true renderer, and that masking is the
 * direct cause of the misclassification: detectRenderTier cannot match the
 * string, falls through to devicePixelRatio, sees 3x and returns mobile-high.
 * Emulating the mask is emulating the input the game actually receives.
 *
 * Usage: node test/ios-memory-check.mjs [--url http://localhost:3131]
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const ART = path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });

const argUrl = process.argv.indexOf("--url");
const externalUrl = argUrl > -1 ? process.argv[argUrl + 1] : null;
const argLoad = process.argv.indexOf("--loadms");
const LOAD_MS = argLoad > -1 ? Number(process.argv[argLoad + 1]) : 2700000;
const PORT = 3132;
const URL = externalUrl || `http://localhost:${PORT}`;

/* iPhone 13, as Safari 17 presents it. 390x844 CSS at devicePixelRatio 3 —
   the 3x that detectRenderTier reads as "flagship" once the GPU string is
   masked out from under it. */
const IPHONE_13 = {
  ua:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (b) => (b / 1048576).toFixed(1);

async function startDev() {
  if (externalUrl) return null;
  const child = spawn("npx", ["next", "dev", "--webpack", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("next dev timeout")), 180000);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Ready") || s.includes("started server")) { clearTimeout(to); resolve(); }
    });
    child.stderr.on("data", (d) => process.stderr.write("[next:err] " + d));
    child.on("exit", (c) => reject(new Error("next dev exited " + c)));
  });
  await sleep(1500);
  return child;
}

/* Everything below runs in the page BEFORE any of the game's own script, so
   the hooks are in place for the very first upload. */
function instrument(maskRenderer) {
  /* 1. Mask the renderer string exactly the way iOS Safari does. Both the
        extension's parameter and the plain RENDERER, because the game reads
        whichever it can get. */
  if (maskRenderer) {
    for (const P of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const gp = P.prototype.getParameter;
      P.prototype.getParameter = function (p) {
        /* 0x9246 = UNMASKED_RENDERER_WEBGL, 0x9245 = UNMASKED_VENDOR_WEBGL */
        if (p === 0x9246 || p === this.RENDERER) return "Apple GPU";
        if (p === 0x9245 || p === this.VENDOR) return "Apple Inc.";
        return gp.call(this, p);
      };
    }
  }

  /* 2. Sum what is actually handed to the GPU. texImage2D's overloads differ
        in where the size lives, so both shapes are read rather than assumed:
        the 9-arg form carries width/height, the 6-arg form carries a source
        object that has them. 4 bytes/texel = RGBA8, which is what an
        un-compressed GLB image becomes. */
  const T = { level0: 0, allLevels: 0, mipped: 0, count: 0, biggest: [] };
  window.__texStats = T;

  const note = (w, h, level) => {
    if (!w || !h) return;
    const b = w * h * 4;
    T.allLevels += b;
    if (!level) {
      T.level0 += b;
      T.count++;
      T.biggest.push({ px: `${w}x${h}`, mb: +(b / 1048576).toFixed(2) });
    }
  };

  for (const P of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const ti = P.prototype.texImage2D;
    P.prototype.texImage2D = function (...a) {
      try {
        if (a.length >= 9) note(a[3], a[4], a[1]);
        else if (a.length === 6 && a[5]) note(a[5].width, a[5].height, a[1]);
      } catch { /* never let measuring break the upload */ }
      return ti.apply(this, a);
    };
    const gm = P.prototype.generateMipmap;
    P.prototype.generateMipmap = function (...a) {
      T.mipped++;
      return gm.apply(this, a);
    };
  }
  if (typeof WebGL2RenderingContext !== "undefined") {
    const ts = WebGL2RenderingContext.prototype.texStorage2D;
    WebGL2RenderingContext.prototype.texStorage2D = function (...a) {
      /* (target, levels, internalformat, width, height) */
      try { note(a[3], a[4], 0); if (a[1] > 1) T.mipped++; } catch { /* as above */ }
      return ts.apply(this, a);
    };
  }
}

const clickBtn = (page, label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(l));
    if (!b) throw new Error("no button " + l);
    b.click();
  }, label);

/** One boot as the iPhone, reporting what it resolved to and what it uploaded. */
async function boot(browser, { safeMode, label }) {
  const page = await browser.newPage();
  await page.setUserAgent(IPHONE_13.ua);
  await page.setViewport(IPHONE_13.viewport);
  await page.evaluateOnNewDocument(instrument, true);
  await page.evaluateOnNewDocument(
    (on) => {
      try {
        if (on) localStorage.setItem("neonx.safemode", JSON.stringify({ fails: 0, on: true }));
        else localStorage.removeItem("neonx.safemode");
      } catch { /* private mode */ }
    },
    safeMode
  );

  await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });

  /* What the masked string made of the device, before a single asset lands. */
  const sniff = await page.evaluate(() => ({
    dpr: devicePixelRatio,
    renderer: (() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const e = gl.getExtension("WEBGL_debug_renderer_info");
      const s = gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return String(s);
    })(),
    tier: window.__neonx.game.renderTier,
  }));

  await clickBtn(page, "DRIVE");
  await page.waitForFunction(() => window.__neonx?.game?.loaded, {
    timeout: LOAD_MS, polling: 5000,
  });
  /* Let the loop run: the sky, the mirror RT and the traffic atlases upload
     on the first drawn frames, not during the stage list. */
  await sleep(20000);

  const out = await page.evaluate(() => {
    const g = window.__neonx.game;
    const T = window.__texStats;
    T.biggest.sort((a, b) => b.mb - a.mb);
    return {
      donorCabin: !!g.rig?.cockpitModel,
      cabinPbrMaps: g.tierCaps?.cabinPbrMaps ?? null,
      deckTexPx: g.tierCaps?.deckTexPx ?? null,
      pixelRatio: g.renderer.getPixelRatio(),
      threeTextures: g.renderer.info.memory.textures,
      level0: T.level0,
      allLevels: T.allLevels,
      mipped: T.mipped,
      count: T.count,
      biggest: T.biggest.slice(0, 8),
    };
  });

  await page.screenshot({ path: path.join(ART, `ios13-${label}.png`) });
  await page.close();
  return { ...sniff, ...out };
}

const report = (r, name) => {
  /* level-0 bytes are what was uploaded; a mipped texture costs ~1/3 again
     for its chain, which is the same multiplier tools/vram-audit.mjs uses. */
  const withMips = r.level0 * 1.333;
  console.log(`\n=== ${name} ===`);
  console.log(`  renderer string seen : ${r.renderer}`);
  console.log(`  devicePixelRatio     : ${r.dpr}   (renderer runs at ${r.pixelRatio})`);
  console.log(`  RESOLVED TIER        : ${r.tier}`);
  console.log(`  donor cabin loaded   : ${r.donorCabin}`);
  console.log(`  cabinPbrMaps         : ${r.cabinPbrMaps}    deckTexPx: ${r.deckTexPx}`);
  console.log(`  textures uploaded    : ${r.count}  (three.js live: ${r.threeTextures})`);
  console.log(`  LEVEL-0 BYTES        : ${MB(r.level0)} MB`);
  console.log(`  + mip chains (x1.333): ${MB(withMips)} MB`);
  console.log(`  biggest uploads      : ${r.biggest.map((b) => `${b.px} ${b.mb}MB`).join(", ")}`);
  return withMips;
};

const run = async () => {
  let dev = null, browser = null;
  try {
    dev = await startDev();
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
    });

    console.log("Booting as iPhone 13 / Safari 17 (masked GPU string, dpr 3)...");
    const before = await boot(browser, { safeMode: false, label: "before" });
    const after = await boot(browser, { safeMode: true, label: "after" });

    const a = report(before, "AS SHIPPED — what the reporting player's phone gets");
    const b = report(after, "IN SAFE MODE — what it gets after the fix");

    console.log("\n=== DELTA ===");
    console.log(`  ${MB(a)} MB  ->  ${MB(b)} MB   (${MB(a - b)} MB less, -${((1 - b / a) * 100).toFixed(0)}%)`);

    writeFileSync(
      path.join(ART, "ios13-memory.json"),
      JSON.stringify({ before, after, beforeMB: +MB(a), afterMB: +MB(b) }, null, 2)
    );
    console.log("\n  -> test/artifacts/ios13-memory.json");
    console.log("  -> test/artifacts/ios13-before.png / ios13-after.png");

    if (before.tier !== "mobile-high")
      console.log(`\n  NOTE: expected mobile-high for the masked 3x phone, got ${before.tier}`);
  } finally {
    await browser?.close().catch(() => {});
    dev?.kill("SIGTERM");
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
