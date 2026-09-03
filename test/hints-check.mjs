/* Headless proof for the first-run hint system (game/hints.ts):
 *
 *  A. fresh browser, desktop: the settle-in hint fires on the first drive,
 *     the EXIT 4 hint fires on the approach, the console hint fires in the
 *     CONSOLE camera — one at a time, never stacked.
 *  B. reload of the same browser: none of them fire again, ever — including
 *     re-entering the same contexts that fired them.
 *  C. fresh browser with settings.hints=false: nothing fires at all.
 *  D. fresh touch browser: the ⋯ drawer hint fires instead of the keyboard one.
 *
 * The pill is watched with an in-page MutationObserver rather than polled
 * from outside: SwiftShader pins the main thread hard enough that evaluate()
 * round-trips can straddle a whole show-and-fade, but the observer commits
 * with each React mutation, so nothing is missed.
 *
 * Usage: node test/hints-check.mjs [--url http://localhost:3111] [--out DIR]
 * (expects a running server — start `next start` first; exits non-zero on
 * assertion failure or page errors)
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
const errors = [];
const fails = [];
const ok = (cond, label) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) fails.push(label);
};

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 300000,
});

/** Record every (text, opacity) state #hint passes through into
    window.__hintLog. Re-run after every load/reload. */
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

const shownLog = async (page) =>
  (await page.evaluate(() => window.__hintLog || [])).filter((s) => s.op === "1");

/** Wait until a hint containing `needle` has been SHOWN (op 1), or timeout.
    Generous timeouts everywhere: SwiftShader frames can run seconds apart
    and the settle timer accumulates capped frame deltas, so game time runs
    well behind wall time here. */
async function waitShown(page, needle, ms) {
  const t0 = Date.now();
  for (;;) {
    const log = await shownLog(page);
    const hit = log.find((s) => s.text.includes(needle));
    if (hit) return hit;
    if (Date.now() - t0 > ms) return null;
    await sleep(500);
  }
}

/** Wait until the pill is faded and the quiet gap after it has passed. */
async function waitClear(page, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const cur = await page.evaluate(() => document.getElementById("hint")?.style.opacity);
    if (cur !== "1") break;
    await sleep(400);
  }
  await sleep(6000); // GAP_S with slack
}

async function boot(ctx, { touch = false } = {}) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text());
  });
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
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b.click();
  });
  // world build (SwiftShader): playing == #hud shown
  await page.waitForFunction(
    () => document.getElementById("hud")?.style.display === "block",
    { timeout: 180000 }
  );
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(OUT, name + ".png") });
    console.log("  📸", name);
  } catch (e) {
    console.log("  ⚠️ screenshot", name, "failed:", String(e.message).slice(0, 80));
  }
}

/* ---------- A: fresh desktop — the three desktop hints fire, in order */
console.log("A. fresh desktop session");
const ctxA = await browser.createBrowserContext();
const pageA = await boot(ctxA);
await drive(pageA);
// keep the car rolling so the exit approach later has |u| > 1
await pageA.evaluate(() => window.__neonx.setInput({ th: 0.35 }));

let hit = await waitShown(pageA, "Q / E", 90000);
ok(!!hit, `settle-in hint fired ("${hit?.text}")`);
await shot(pageA, "drive-hint");

// wait out the show window + gap, then approach EXIT 4
await waitClear(pageA);
await pageA.evaluate(() => {
  const g = window.__neonx.game;
  const e4 = g.world.exits.find((e) => e.no === 4);
  window.__neonx.toCorridor(e4.z - 320, 110);
  window.__neonx.setInput({ th: 0.5 });
});
hit = await waitShown(pageA, "EXIT 4", 45000);
ok(!!hit, `EXIT 4 hint fired ("${hit?.text}")`);
ok(!hit || !hit.text.includes("Q / E"), "hints did not stack (previous text replaced)");
await shot(pageA, "exit4-hint");

// wait out the window again, then the console camera
await waitClear(pageA);
await pageA.evaluate(() => window.__neonx.setCam(4));
hit = await waitShown(pageA, "click the screen", 45000);
ok(!!hit, `console hint fired ("${hit?.text}")`);
await shot(pageA, "console-hint");

/* ---------- B: reload the same browser — nothing may ever fire again */
console.log("B. same browser, reloaded");
const seen = await pageA.evaluate(() => localStorage.getItem("neonx.profile.v3.hintsSeen") || "");
ok(
  ["drive", "exit4", "console"].every((id) => seen.includes(`"${id}"`)),
  `seen-flags persisted (${seen})`
);
await pageA.reload({ waitUntil: "domcontentloaded" });
await pageA.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await watchHint(pageA);
await sleep(300);
await drive(pageA);
await pageA.evaluate(() => {
  const g = window.__neonx.game;
  const e4 = g.world.exits.find((e) => e.no === 4);
  window.__neonx.toCorridor(e4.z - 320, 110); // straight into hint territory
  window.__neonx.setInput({ th: 0.5 });
  window.__neonx.setCam(4);
});
await sleep(30000);
let log = await shownLog(pageA);
ok(log.length === 0, `no hint after reload (${log.length} shown: ${log.map((s) => s.text).join(" | ")})`);
await ctxA.close();

/* ---------- C: fresh browser, hints toggled off — nothing fires */
console.log("C. fresh desktop, hints disabled");
const ctxC = await browser.createBrowserContext();
const pageC = await boot(ctxC);
await pageC.evaluate(() => (window.__neonx.game.settings.hints = false));
await drive(pageC);
await sleep(30000);
log = await shownLog(pageC);
ok(log.length === 0, `no hint with the setting off (${log.length} shown)`);
await ctxC.close();

/* ---------- D: fresh touch browser — the drawer hint, not the keyboard one */
console.log("D. fresh touch session");
const ctxD = await browser.createBrowserContext();
const pageD = await boot(ctxD, { touch: true });
await drive(pageD);
hit = await waitShown(pageD, "⋯", 90000);
ok(!!hit, `touch hint fired ("${hit?.text}")`);
log = await shownLog(pageD);
ok(!log.some((s) => s.text.includes("Q / E")), "keyboard hint did not fire on touch");
await shot(pageD, "touch-hint");
await ctxD.close();

await browser.close();

console.log("");
if (errors.length) console.log("page errors:", errors.slice(0, 5));
if (fails.length || errors.length) {
  console.log(`FAIL — ${fails.length} assertion(s), ${errors.length} page error(s)`);
  process.exit(1);
}
console.log("PASS — hints fire once, in order, never after reload, never when off");
