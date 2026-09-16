/* Does a SECOND simultaneous finger light its puck?

   The reported symptom: on mobile, pressing two buttons — the second one,
   landing while the first is still held — leaves the second unlit.

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

/* ---- phase 2: press one, then the NEXT one, one finger at a time -------
   The report also reads as SEQUENTIAL ("two buttons ... like the next one"),
   and a latch left behind by the first press would only ever show on the
   second. Cheap to rule out, so rule it out. */
for (const [aId, aKey, bId, bKey] of PAIRS) {
  await touchDown(1, await centre(aId));
  await touchUp(1);
  await touchDown(1, await centre(bId));
  const bLit = await lit(bId), bKeyV = await keydown(bKey);
  check(`${bId} lights when pressed AFTER ${aId} was released`, bLit && bKeyV === 1,
        `pressed=${bLit} key=${bKeyV}`);
  await touchUp(1);
  const aRes = await keydown(aKey), bRes = await keydown(bKey);
  check(`${aId}/${bId} both released after the sequence`, aRes === 0 && bRes === 0,
        `${aKey}=${aRes} ${bKey}=${bRes}`);
  await sleep(200);
}

/* Regression guard: a lost pointer must still release every hold. Press two,
   then blur the window without ever lifting a finger. Runs BEFORE phase 3,
   which opens the drawer and changes the layout under everything. */
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
  await touchUp(2);
  await touchUp(1);
  await sleep(300);
}

/* ---- phase 3: the controls that are NOT hold pucks --------------------
   bindPointerHold's `pressed` class is only on the seven .tc pucks. The other
   things a thumb lands on during a drive — the ⋯ chip, the drawer rows, the
   CAM tap — light by other means, and each is checked the same way: does its
   PAINT change when it is the second finger, and does it change when it is
   the only finger? A control that lights alone and not in company is the
   reported bug. */
const paint = (id) => page.evaluate((i) => {
  const e = document.getElementById(i) || document.querySelector(i);
  if (!e) return null;
  const s = getComputedStyle(e);
  return [s.borderColor, s.backgroundColor, s.boxShadow].join(" | ");
}, id);

// settle short enough to still be inside a 140 ms tap flash
const FLASH_PEEK = 40;
async function tapDown(id, p, wait = FLASH_PEEK) {
  live.set(id, p);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts() });
  await sleep(wait);
}

const SECONDARY = [
  ["tcG", "w", "tcC", "the CAM tap"],
  ["tcG", "w", "tcF", "the LTS puck"],
  ["tcG", "w", "tcMore", "the ⋯ drawer chip"],
];
for (const [holdId, holdKey, tgt, what] of SECONDARY) {
  const h = await centre(holdId), t = await centre(tgt);
  if (!h || !t) { check(`${tgt} on screen`, false, "not laid out"); continue; }

  // alone: does this control light at all on a single finger?
  const idle = await paint(tgt);
  await tapDown(3, t);
  const alone = await paint(tgt);
  await touchUp(3);
  await sleep(250);

  // in company: same press, but with a finger already down on a puck
  await touchDown(1, h);
  await tapDown(2, t);
  const together = await paint(tgt);
  const holdStill = await lit(holdId);
  await touchUp(2);
  await touchUp(1);
  await sleep(250);

  check(`${what} (#${tgt}) lights on its own`, alone !== idle, `idle=${idle} pressed=${alone}`);
  check(`${what} (#${tgt}) lights as the SECOND finger`, together !== idle,
        `idle=${idle} second=${together}`);
  check(`${holdId} keeps its glow under ${what}`, holdStill, `pressed=${holdStill}`);
  if (alone !== idle && together === idle)
    console.log(`       ^ lights alone but NOT in company — this is the reported bug`);
  // the ⋯ chip TOGGLES the drawer; two presses above left it closed again,
  // but make sure, so phase 4 starts from a known layout
  await page.evaluate(() => {
    if (document.getElementById("tcDrawer")?.classList.contains("open"))
      document.getElementById("tcMore")?.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 77, bubbles: true }));
  });
  await sleep(400);
}

/* ---- phase 4: the drawer rows, which are also :active-only ------------- */
{
  await page.evaluate(() => document.getElementById("tcMore")?.dispatchEvent(
    new PointerEvent("pointerdown", { pointerId: 78, bubbles: true })));
  await sleep(600);
  const rowBox = await page.evaluate(() => {
    const r = document.querySelector("#tcDrawer .qdRow");
    if (!r) return null;
    const b = r.getBoundingClientRect();
    r.id = r.id || "qdRow0";
    return b.width ? { id: r.id, x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  });
  if (!rowBox) check("a drawer row is on screen", false, "drawer did not open");
  else {
    const idle = await paint(rowBox.id);
    await tapDown(4, { x: rowBox.x, y: rowBox.y });
    const alone = await paint(rowBox.id);
    await touchUp(4);
    check(`a drawer row (.qdRow) lights when pressed`, alone !== idle,
          `idle=${idle} pressed=${alone}`);
  }
  await sleep(400);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ label: LABEL, url: URL, fails, results, traces }, null, 2));
console.log(`\n${LABEL}: ${results.length - fails}/${results.length} checks passed`);
console.log("wrote", OUT);
await browser.close();
process.exit(fails ? 1 : 0);
