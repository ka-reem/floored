/* Gallery screenshots for the first-run-hints lane. Same flow as
 * hints-check.mjs (each hint genuinely fires, in a fresh browser context) —
 * but a SwiftShader screenshot can take longer than the pill's 6 s display,
 * so once a hint has fired the pill's opacity is pinned back up for the
 * camera and released after the shot. The content is always the real fired
 * hint; only the fade is held.
 *
 * Usage: node test/hints-shots.mjs [--url http://localhost:3111] [--out DIR]
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3111";
const argOut = process.argv.indexOf("--out");
const OUT = argOut > -1 ? process.argv[argOut + 1] : path.join(process.cwd(), "test", "artifacts", "hints");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 300000,
});

const watchHint = (page) =>
  page.evaluate(() => {
    window.__hintLog = [];
    const el = document.getElementById("hint");
    const rec = () => {
      const s = { text: el.textContent, op: el.style.opacity };
      const last = window.__hintLog[window.__hintLog.length - 1];
      if (!last || last.text !== s.text || last.op !== s.op) window.__hintLog.push(s);
    };
    new MutationObserver(rec).observe(el, {
      attributes: true, childList: true, subtree: true, characterData: true,
    });
    rec();
  });

async function waitShown(page, needle, ms) {
  const t0 = Date.now();
  for (;;) {
    const log = (await page.evaluate(() => window.__hintLog || [])).filter((s) => s.op === "1");
    if (log.some((s) => s.text.includes(needle))) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(400);
  }
}

async function shotWithPill(page, name) {
  /* A !important style-tag pin: React re-renders (the fade timer, the live
     exit-hint distance) rewrite the inline opacity under a plain DOM poke. */
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.id = "pinHint";
    st.textContent = "#hint{opacity:1 !important; transition:none !important}";
    document.head.appendChild(st);
  });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, name + ".png") });
  await page.evaluate(() => document.getElementById("pinHint")?.remove());
  console.log("📸", name);
}

async function boot(ctx, { touch = false } = {}) {
  const page = await ctx.newPage();
  await page.setViewport(
    touch
      ? { width: 390, height: 844, isMobile: true, hasTouch: true }
      : { width: 1280, height: 800 }
  );
  await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
  await watchHint(page);
  await sleep(300);
  return page;
}

async function drive(page) {
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE")).click();
  });
  await page.waitForFunction(
    () => document.getElementById("hud")?.style.display === "block",
    { timeout: 180000 }
  );
}

async function waitClear(page, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const cur = await page.evaluate(() => document.getElementById("hint")?.style.opacity);
    if (cur !== "1") break;
    await sleep(400);
  }
  await sleep(6000);
}

/* desktop: the three desktop hints, held for the camera as they fire */
const ctxA = await browser.createBrowserContext();
const pageA = await boot(ctxA);
// the refreshed CONTROLS screen needs no world — take it from the main menu
await pageA.evaluate(() => {
  [...document.querySelectorAll("button")].find((x) => x.textContent.includes("CONTROLS")).click();
});
await sleep(400);
await pageA.screenshot({ path: path.join(OUT, "controls.png") });
console.log("📸 controls");
await pageA.evaluate(() => {
  [...document.querySelectorAll("button")].find((x) => x.textContent === "BACK").click();
});
await sleep(300);

await drive(pageA);
await pageA.evaluate(() => window.__neonx.setInput({ th: 0.35 }));
if (await waitShown(pageA, "Q / E", 90000)) await shotWithPill(pageA, "drive-hint");

await waitClear(pageA);
await pageA.evaluate(() => {
  const e4 = window.__neonx.game.world.exits.find((e) => e.no === 4);
  window.__neonx.toCorridor(e4.z - 260, 110);
  window.__neonx.setInput({ th: 0.5 });
});
if (await waitShown(pageA, "EXIT 4", 45000)) await shotWithPill(pageA, "exit4-hint");

await waitClear(pageA);
await pageA.evaluate(() => window.__neonx.setCam(4));
if (await waitShown(pageA, "click the screen", 45000)) await shotWithPill(pageA, "console-hint");
await ctxA.close();

/* phone: the ⋯ hint */
const ctxD = await browser.createBrowserContext();
const pageD = await boot(ctxD, { touch: true });
await drive(pageD);
if (await waitShown(pageD, "⋯", 90000)) await shotWithPill(pageD, "touch-hint");
await ctxD.close();

await browser.close();
console.log("done →", OUT);
