/* Does a SECOND simultaneous finger light its puck?

   Owner: "on mobile if i press two buttons like the next one the 2nd button
   im pressing wont light up."

   The press glow is the `pressed` class, written by engine.ts bindPointerHold
   from the same down/up the input reads (`:active` is unreliable under a
   captured pointer — that was a deliberate earlier fix). So the question is
   whether a second finger, landing while a first is still down, gets its
   element lit.

   page.touchscreen alone will NOT reproduce this: it is single-touch.  This
   drives CDP Input.dispatchTouchEvent directly with the full set of ACTIVE
   touch points, which is what a real two-finger press looks like to Chrome.

   It also records every pointer/touch event the window sees (capture phase),
   so a failure says WHICH half is broken: no pointerdown for finger 2 at all
   (the browser never delivered it) vs a pointerdown that arrived and did not
   light (our bookkeeping).

   Usage: node test/multitouch-glow-check.mjs --url http://localhost:3703
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3703");
const LABEL = arg("--label", "run");
const OUT = arg("--out", `/tmp/multitouch-${LABEL}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (ok) console.log("  OK   " + name);
  else { fails++; console.log("  FAIL " + name + (detail ? "  (" + detail + ")" : "")); }
};

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 590000,
});
const page = await browser.newPage();
// the touch controls only mount on a touch device
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await page.evaluateOnNewDocument(() => {
  window.__mt = [];
  for (const t of ["pointerdown", "pointerup", "pointercancel", "lostpointercapture",
                   "touchstart", "touchend", "touchcancel"]) {
    window.addEventListener(t, (e) => {
      window.__mt.push({
        type: t,
        id: e.pointerId ?? null,
        target: (e.target && (e.target.id || e.target.tagName)) || null,
        touches: e.touches ? e.touches.length : null,
      });
    }, true);
  }
});
await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
await sleep(10000);

const cdp = await page.createCDPSession();

const centre = (id) =>
  page.evaluate((i) => {
    const r = document.getElementById(i)?.getBoundingClientRect();
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, id);

/* CDP wants the full set of points that are DOWN, every time. `type` is
   derived from what changed, exactly as a real device would report it. */
const live = new Map(); // id -> {x,y}
const pts = () => [...live.entries()].map(([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y), radiusX: 8, radiusY: 8, force: 1 }));
async function touchDown(id, p) {
  live.set(id, p);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts() });
  await sleep(160);
}
async function touchUp(id) {
  const gone = { id, x: Math.round(live.get(id).x), y: Math.round(live.get(id).y), radiusX: 8, radiusY: 8, force: 0 };
  live.delete(id);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [gone] });
  await sleep(160);
}

const lit = (id) => page.evaluate((i) => !!document.getElementById(i)?.classList.contains("pressed"), id);
const keydown = (k) => page.evaluate((kk) => window.__neonx.game.keydown[kk] ?? 0, k);
const trace = () => page.evaluate(() => window.__mt.splice(0));

const shot = async (name) => {
  const p = path.join(path.dirname(OUT), name);
  await page.screenshot({ path: p });
  console.log("  shot", p);
  return p;
};

// ---- the pairs a player actually presses together ----------------------
const PAIRS = [
  ["tcG", "w", "tcL", "a"],  // throttle + steer left
  ["tcG", "w", "tcH", "f"],  // throttle + horn
  ["tcR", "d", "tcB", "s"],  // steer right + brake
];

const traces = {};
for (const [aId, aKey, bId, bKey] of PAIRS) {
  const a = await centre(aId), b = await centre(bId);
  if (!a || !b) { check(`${aId}+${bId} both on screen`, false, "a puck is not laid out"); continue; }
  await trace();

  await touchDown(1, a);
  const aLit1 = await lit(aId), aKey1 = await keydown(aKey);
  check(`${aId} lights on the FIRST finger`, aLit1 && aKey1 === 1, `pressed=${aLit1} key=${aKey1}`);

  await touchDown(2, b);
  const bLit = await lit(bId), bKeyV = await keydown(bKey), aStill = await lit(aId);
  check(`${bId} lights on the SECOND finger (first still down)`, bLit, `pressed=${bLit} key=${bKeyV}`);
  check(`${bId} input registers on the second finger`, bKeyV === 1, `key=${bKeyV}`);
  check(`${aId} stays lit while the second finger is down`, aStill, `pressed=${aStill}`);
  if (!bLit) await shot(`multitouch-${LABEL}-${aId}-${bId}-fail.png`);

  traces[`${aId}+${bId}`] = await trace();

  await touchUp(2);
  const bOff = await lit(bId), aKeep = await lit(aId), aKeyKeep = await keydown(aKey);
  check(`${bId} goes dark when its finger lifts`, !bOff, `pressed=${bOff}`);
  check(`${aId} survives the other finger's lift`, aKeep && aKeyKeep === 1, `pressed=${aKeep} key=${aKeyKeep}`);

  await touchUp(1);
  const aOff = await lit(aId), aKeyOff = await keydown(aKey), bKeyOff = await keydown(bKey);
  check(`${aId} releases cleanly`, !aOff && aKeyOff === 0, `pressed=${aOff} key=${aKeyOff}`);
  check(`${bId} key released`, bKeyOff === 0, `key=${bKeyOff}`);
  await sleep(300);
}

/* Regression guard: a lost pointer must still release every hold. Press two,
   then blur the window without ever lifting a finger. */
{
  const a = await centre("tcG"), b = await centre("tcB");
  await touchDown(1, a);
  await touchDown(2, b);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await sleep(200);
  const stuck = await page.evaluate(() =>
    [...document.querySelectorAll(".tc.pressed")].map((e) => e.id));
  const keys = await page.evaluate(() => ({ w: window.__neonx.game.keydown.w, s: window.__neonx.game.keydown.s }));
  check("blur releases BOTH holds", stuck.length === 0 && !keys.w && !keys.s,
        `stuck=[${stuck}] keys=${JSON.stringify(keys)}`);
  live.clear();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }).catch(() => {});
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ label: LABEL, url: URL, fails, results, traces }, null, 2));
console.log(`\n${LABEL}: ${results.length - fails}/${results.length} checks passed`);
console.log("wrote", OUT);
await browser.close();
process.exit(fails ? 1 : 0);
