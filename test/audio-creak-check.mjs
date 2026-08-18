#!/usr/bin/env node
/* Headless check for the interior trim creaks (lane U): boots the game and
   uses __neonx (teleport + input override + camera) plus the
   __audioDebug.getCreakLog() hook to assert that
     - steady cruise produces no creak triggers at all (gentle driving is
       silent — no rolls, no fires),
     - repeated hard-brake transients qualify (rolls) and fire
       PROBABILISTICALLY: over N trials some but not all rolls fire,
     - a slalom (hard turn-in flicks) produces lateral-axis rolls,
     - consecutive fires respect the 0.8s minimum randomized refractory,
     - every fire's gain stays at or below the configured cap, and exterior
       (chase) camera fires are ducked to <=25% of the cap,
   and that no page errors fire along the way.

   Usage: node test/audio-creak-check.mjs --url http://localhost:3141 */
import puppeteer from "puppeteer";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3141";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Headless Chromium only advances requestAnimationFrame while the compositor
   produces frames — screenshots force BeginFrames (same pattern as
   audio-sampled-check.mjs / audio-stalk-click-check.mjs). */
const advance = async (page, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await page.screenshot({ optimizeForSpeed: true });
    await sleep(60);
  }
};
const errors = [];
const fail = (m) => { console.error("  ✗ " + m); errors.push(m); };
const pass = (m) => console.log("  ✓ " + m);

const GAIN_CAP = 0.06; // GameAudio.CREAK_GAIN_CAP
const MIN_REFRACTORY = 0.8;

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
  ],
  defaultViewport: { width: 960, height: 600 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push("console: " + m.text());
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => !!window.__audioDebug, { timeout: 30000 });
await advance(page, 800);

const setInput = (o) => page.evaluate((oo) => window.__neonx.setInput(oo), o);
const setCam = (i) => page.evaluate((ii) => window.__neonx.setCam(ii), i);
const toTunnel = (kmh) => page.evaluate((k) => window.__neonx.toTunnel(k), kmh);
const creakLog = () =>
  page.evaluate(() => window.__audioDebug.getCreakLog().map((e) => ({ ...e })));

/* The log is a shifting 64-entry window, so phases diff snapshots by the
   (t, kind) identity of entries rather than by index. */
const keyOf = (e) => `${e.t.toFixed(4)}|${e.kind}|${e.axis}`;
const newSince = (before, after) => {
  const seen = new Set(before.map(keyOf));
  return after.filter((e) => !seen.has(keyOf(e)));
};

// 1) steady cruise (cockpit cam): settle onto the straight tunnel approach
//    at ~100 km/h with moderate throttle, then watch a 4s window.
await setCam(1);
await toTunnel(100);
await setInput({ th: 0.45, br: 0, st: 0, hb: 0, horn: 0 });
await advance(page, 1500); // let the throttle-onset transient decay outside the window
let before = await creakLog();
await advance(page, 4000);
let fresh = newSince(before, await creakLog());
// Grade-break ("vert") transients are road features, not driver inputs — a
// gore/crest inside the window is a designed creak source, so the steady-
// cruise assertions key on the input axes and only report vert counts.
const cruiseInput = fresh.filter((e) => e.axis === "long" || e.axis === "lat");
const cruiseFires = cruiseInput.filter((e) => e.kind === "fire").length;
const cruiseRolls = cruiseInput.filter((e) => e.kind === "roll").length;
const cruiseVert = fresh.filter((e) => e.axis === "vert").length;
if (cruiseFires === 0) pass("steady cruise fired no input-transient creaks");
else fail(`steady cruise fired ${cruiseFires} input-transient creaks (want 0)`);
if (cruiseRolls === 0) pass(`steady cruise produced no qualifying input transients (${cruiseVert} road-grade event(s) ignored)`);
else fail(`steady cruise produced ${cruiseRolls} input-transient rolls (want 0)`);

// 2) hard-brake trials: 10 max-effort stops from ~110 km/h. Each brake
//    onset (and often the release) is a qualifying transient; fires must be
//    some-but-not-all of the rolls (stick-slip probability 30-60%).
before = await creakLog();
for (let i = 0; i < 10; i++) {
  await toTunnel(110);
  await setInput({ th: 0, br: 1, st: 0, hb: 0, horn: 0 });
  await advance(page, 1200);
  await setInput({ th: 0, br: 0, st: 0, hb: 0, horn: 0 });
  await advance(page, 1600); // clear the max 2.5s refractory before the next onset
}
fresh = newSince(before, await creakLog());
const brakeRolls = fresh.filter((e) => e.kind === "roll"); // 1 per qualifying transient (fires log an extra entry)
const brakeFires = fresh.filter((e) => e.kind === "fire");
if (brakeRolls.length >= 8) pass(`hard-brake trials produced ${brakeRolls.length} qualifying transients`);
else fail(`hard-brake trials produced only ${brakeRolls.length} qualifying transients (want >=8)`);
if (brakeFires.length >= 1) pass(`creaks fired on hard braking (${brakeFires.length})`);
else fail("no creak ever fired across 10 hard-brake trials (p>=0.3 each — vanishingly unlikely)");
if (brakeFires.length < brakeRolls.length)
  pass(`probabilistic: ${brakeFires.length}/${brakeRolls.length} qualifying transients fired (not all)`);
else fail(`every one of ${brakeRolls.length} qualifying transients fired — trigger is not probabilistic`);
const longRolls = fresh.filter((e) => e.axis === "long").length;
if (longRolls >= 1) pass("brake transients registered on the longitudinal axis");
else fail("no longitudinal-axis roll during brake trials");

// 3) slalom: hard alternating turn-in flicks at ~110 km/h must register
//    lateral-axis transients (fires themselves stay probabilistic).
await toTunnel(110);
before = await creakLog();
await setInput({ th: 0.3, br: 0, st: 0.85, hb: 0, horn: 0 });
for (let i = 0; i < 6; i++) {
  await advance(page, 650);
  await setInput({ th: 0.3, br: 0, st: i % 2 ? 0.85 : -0.85, hb: 0, horn: 0 });
}
await setInput({ th: 0, br: 0, st: 0, hb: 0, horn: 0 });
await advance(page, 400);
fresh = newSince(before, await creakLog());
const latRolls = fresh.filter((e) => e.axis === "lat").length;
if (latRolls >= 1) pass(`slalom produced ${latRolls} lateral-axis transient(s)`);
else fail("slalom produced no lateral-axis rolls");

// 4) refractory + level bounds over EVERYTHING fired so far (cockpit cam).
const all = await creakLog();
const fires = all.filter((e) => e.kind === "fire").sort((a, b) => a.t - b.t);
let refractoryOk = true;
for (let i = 1; i < fires.length; i++)
  if (fires[i].t - fires[i - 1].t < MIN_REFRACTORY - 0.01) refractoryOk = false;
if (refractoryOk) pass(`all ${fires.length} fires respect the ${MIN_REFRACTORY}s minimum refractory`);
else fail("two fires closer than the minimum refractory");
const overCap = fires.filter((e) => e.gain > GAIN_CAP + 1e-6);
if (!overCap.length) pass(`every fire's gain <= ${GAIN_CAP} cap (max seen ${Math.max(0, ...fires.map((e) => e.gain)).toFixed(4)})`);
else fail(`${overCap.length} fire(s) exceeded the ${GAIN_CAP} gain cap`);
const cabinFires = fires.filter((e) => e.cabin === true);
if (cabinFires.length === fires.length) pass("all cockpit-phase fires carry the in-cabin flag");
else fail(`${fires.length - cabinFires.length} fire(s) missing the in-cabin flag despite cockpit cam`);

// 5) chase camera duck: same brake gesture from the exterior camera — any
//    fires must be flagged exterior and ducked to <=25% of the cap.
await setCam(0);
before = await creakLog();
for (let i = 0; i < 4; i++) {
  await toTunnel(110);
  await setInput({ th: 0, br: 1, st: 0, hb: 0, horn: 0 });
  await advance(page, 1200);
  await setInput({ th: 0, br: 0, st: 0, hb: 0, horn: 0 });
  await advance(page, 1600);
}
fresh = newSince(before, await creakLog());
const chaseFires = fresh.filter((e) => e.kind === "fire");
const chaseBad = chaseFires.filter((e) => e.cabin !== false || e.gain > GAIN_CAP * 0.25 + 1e-6);
if (!chaseBad.length)
  pass(`chase-cam fires (${chaseFires.length}) all ducked to <=25% of cap`);
else fail(`${chaseBad.length} chase-cam fire(s) not ducked (want gain <= ${GAIN_CAP * 0.25})`);

await browser.close();
if (errors.length) {
  console.log("\n❌ FAILURES:");
  for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 400));
  process.exit(1);
}
console.log("✅ interior trim creaks verified");
