#!/usr/bin/env node
/* Headless check for the engine-mix tuning pass (Lane P):
     1. turbo whistle peak level down ~30% — at hard boost the live turbo
        gain must be 0.65-0.75x what the OLD model (p.turbo*thr*rn^2*0.01)
        would produce for the same measured state, and still audible;
     2. under acceleration the engine gains presence — the sampled ladder's
        throttle term must be worth >= +1.5dB over the old model at the
        measured state, the intake/exhaust bed trim must open with throttle
        (bedMix >= 0.75 at full throttle vs the old fixed 0.5), and the
        final output must never clip (windowed |peak| < 0.99);
     3. the no-gas cruise hum is tamed — after a throttle lift the overrun
        gear-whine boost must charge (the lift-off cue is preserved) and
        then DECAY at steady coast: whineBoost < 0.2, the whine level must
        be < 0.6x the old always-boosted model, and the actual turbo osc
        must be silent at thr=0 (the reported "turbo hum" was never the
        turbo).
   State is read via __audioDebug.getLevels().mix — the exact unsmoothed
   engine-mix targets from the most recent audio.update() — so assertions
   compare the new model against the old constants at the SAME rpm/throttle
   state instead of racing the param smoothing.

   Usage: node test/audio-mix-check.mjs --url http://localhost:3141 */
import puppeteer from "puppeteer";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3141";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const fail = (m) => { console.error("  ✗ " + m); errors.push(m); };
const pass = (m) => console.log("  ✓ " + m);
const dB = (ratio) => 20 * Math.log10(ratio);

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
/* The world is built by the staged loader after this click, not by the
   constructor, so __neonx existing no longer means there is a world to
   drive in — wait for the load to finish before touching it. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
try {
  await page.waitForFunction(
    () => window.__audioDebug?.getLevels?.()?.sampledEngineReady === true,
    { timeout: 30000 }
  );
} catch {
  fail("sampled engine never became ready");
}

const snap = () => page.evaluate(() => ({
  lv: window.__audioDebug.getLevels(),
  peak: window.__audioDebug.getOutputPeak(),
  speed: Math.abs(window.__neonx.game?.car?.u ?? 0),
  rpm: window.__neonx.game?.car?.rpm ?? 0,
}));

/* ---- 1+2: sustained full throttle (screenshots force headless frames) ---- */
await page.evaluate(() => window.__neonx.setInput({ th: 1 }));
let best = null; // sample with the highest rn at full effective throttle
let maxPeak = 0;
for (let i = 0; i < 120; i++) {
  await page.screenshot({ optimizeForSpeed: true });
  const s = await snap();
  if (s.peak !== null && s.peak > maxPeak) maxPeak = s.peak;
  const m = s.lv.mix;
  if (m && m.thr > 0.9 && (!best || m.rn > best.m.rn)) best = { m, lv: s.lv, rpm: s.rpm };
}
if (!best) fail("never observed full effective throttle (mix.thr > 0.9)");
else {
  const { m, lv } = best;
  // turbo: live gain vs OLD model at the same state
  const oldTurbo = m.profTurbo * m.thr * m.rn * m.rn * 0.01;
  const tRatio = m.turboTarget / oldTurbo;
  if (tRatio >= 0.65 && tRatio <= 0.75)
    pass(`turbo at boost is ${tRatio.toFixed(3)}x the old level (target 0.65-0.75, ${dB(tRatio).toFixed(1)}dB)`);
  else fail(`turbo ratio ${tRatio.toFixed(3)} outside 0.65-0.75 (old ${oldTurbo.toFixed(5)}, new ${m.turboTarget.toFixed(5)})`);
  if (lv.turbo > 0.001) pass(`turbo still audible on hard boost (live gain ${lv.turbo.toFixed(4)})`);
  else fail(`turbo inaudible on hard boost (${lv.turbo})`);
  // sampled ladder level model vs old constants at the same state (the
  // lim/cut/overrun/p.level factors are identical on both sides and cancel)
  const newCore = 0.07 + m.thr * 0.17 + m.rn * 0.05;
  const oldCore = 0.07 + m.thr * 0.11 + m.rn * 0.05;
  const gainDb = dB(newCore / oldCore);
  if (gainDb >= 1.5) pass(`sampled engine +${gainDb.toFixed(2)}dB at full throttle (thr=${m.thr.toFixed(2)}, rn=${m.rn.toFixed(2)})`);
  else fail(`sampled engine only +${gainDb.toFixed(2)}dB at full throttle (< 1.5dB)`);
  if (m.bedMix >= 0.75) pass(`intake/exhaust beds open with throttle (bedMix ${m.bedMix.toFixed(2)} vs old fixed 0.5, +${dB(m.bedMix / 0.5).toFixed(1)}dB)`);
  else fail(`bedMix only ${m.bedMix} at full throttle`);
  if (lv.sampledEngine > 0.04) pass(`sampled bus carries level under throttle (${lv.sampledEngine.toFixed(3)})`);
  else fail(`sampled bus quiet under throttle (${lv.sampledEngine})`);
}
if (maxPeak > 0 && maxPeak < 0.99) pass(`no output clipping at full song (windowed |peak| ${maxPeak.toFixed(3)})`);
else if (maxPeak === 0) fail("output peak tap read all-zero — analyser not seeing signal?");
else fail(`output clipping: windowed |peak| ${maxPeak.toFixed(3)} >= 0.99`);

/* ---- 3: throttle lift -> cruise. The boost must charge on the lift edge
   (immersion cue preserved) then decay to near-zero at steady coast. ---- */
await page.evaluate(() => window.__neonx.setInput({ th: 0 }));
let sawLiftBoost = 0;
let cruise = null;
for (let i = 0; i < 300; i++) {
  await page.screenshot({ optimizeForSpeed: true });
  const s = await snap();
  const m = s.lv.mix;
  if (!m) continue;
  if (m.thr < 0.06 && m.whineBoost > sawLiftBoost) sawLiftBoost = m.whineBoost;
  // steady coast: gas off, revs still up (overrun regime), boost decayed
  if (m.thr < 0.06 && m.overrun > 0.25 && s.speed > 8 && m.whineBoost < 0.15) {
    cruise = { m, lv: s.lv, speed: s.speed, rpm: s.rpm };
    break;
  }
}
if (sawLiftBoost > 0.5) pass(`lift-off whine cue preserved (boost peaked at ${sawLiftBoost.toFixed(2)} after the lift)`);
else fail(`overrun whine boost never charged on throttle lift (max ${sawLiftBoost.toFixed(2)})`);
if (!cruise) {
  fail("never reached a steady no-gas cruise state (thr 0, overrun > 0.25, boost decayed)");
} else {
  const { m, lv, speed, rpm } = cruise;
  console.log(
    `  · cruise state: speed ${speed.toFixed(1)} m/s, rpm ${rpm.toFixed(0)}, overrun ${m.overrun.toFixed(2)} — ` +
    `whine ${lv.gearWhine.toFixed(4)}, turbo ${lv.turbo.toFixed(5)}, sampled ${lv.sampledEngine.toFixed(3)}, ` +
    `idleBed ${lv.sampledIdle === null ? "n/a" : lv.sampledIdle.toFixed(3)}`
  );
  // the actual turbo must be silent with the foot off the gas
  if (lv.turbo < 0.0005) pass(`turbo osc silent at no-gas cruise (${lv.turbo.toFixed(5)}) — the "turbo hum" was the gear whine`);
  else fail(`turbo osc audible at thr=0 (${lv.turbo})`);
  // whine vs the OLD always-boosted model at the same state
  const oldWhine = (m.whineTarget / (1 + m.overrun * 2.4 * m.whineBoost)) * (1 + m.overrun * 2.4);
  const wRatio = m.whineTarget / oldWhine;
  if (wRatio < 0.6)
    pass(`cruise whine ${wRatio.toFixed(2)}x the old boosted level (${dB(wRatio).toFixed(1)}dB: ${oldWhine.toFixed(4)} -> ${m.whineTarget.toFixed(4)})`);
  else fail(`cruise whine only dropped to ${wRatio.toFixed(2)}x old (${oldWhine.toFixed(4)} -> ${m.whineTarget.toFixed(4)})`);
  // total steady tonal level (turbo target + whine target) vs old model
  const oldTonal = oldWhine + m.profTurbo * m.thr * m.rn * m.rn * 0.01;
  const newTonal = m.whineTarget + m.turboTarget;
  if (newTonal < oldTonal * 0.65)
    pass(`cruise steady tonal sum dropped ${dB(newTonal / oldTonal).toFixed(1)}dB (${oldTonal.toFixed(4)} -> ${newTonal.toFixed(4)})`);
  else fail(`cruise tonal sum only ${oldTonal.toFixed(4)} -> ${newTonal.toFixed(4)}`);
  // idle bed must stay gated out at cruise rpm
  if (lv.sampledIdle === null || rpm < 2000 || lv.sampledIdle < 0.1)
    pass(`idle bed gated out at cruise rpm (${lv.sampledIdle === null ? "n/a" : lv.sampledIdle.toFixed(3)})`);
  else fail(`idle bed audible at cruise rpm ${rpm.toFixed(0)} (${lv.sampledIdle})`);
}

await browser.close();
if (errors.length) {
  console.log("\n❌ FAILURES:");
  for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 400));
  process.exit(1);
}
console.log("✅ engine mix tuning verified");
