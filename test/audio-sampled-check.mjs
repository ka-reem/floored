#!/usr/bin/env node
/* Headless check for the recorded-sample audio path: boots the game, waits
   for the sample set to decode, then uses the __audioDebug hook (exposed by
   GameAudio.init()) to assert that
     - all manifest samples decode and the sampled engine wires up,
     - the sampled engine actually carries level while driving,
     - the engineMode toggle swaps voices both ways at runtime,
     - the tunnel drives the convolver (recorded IR) wet bus,
   and that no page errors fire along the way.

   Usage: node test/audio-sampled-check.mjs --url http://localhost:3141 */
import puppeteer from "puppeteer";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3141";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Headless Chromium only runs requestAnimationFrame when the compositor is
   producing frames, and it stops producing them for a page nobody is
   watching — the game (and therefore audio.update()) freezes solid during a
   plain sleep(). Screenshots force BeginFrames (this is why the
   corridor-shots pattern works), so waiting is done by interleaving cheap
   screenshots with short sleeps. */
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

// samples decode async after init(); poll for the sampled engine coming ready
try {
  await page.waitForFunction(
    () => window.__audioDebug?.getLevels?.()?.sampledEngineReady === true,
    { timeout: 30000 }
  );
} catch {
  fail("sampled engine never became ready (decode/wiring failed?)");
}

let lv = await page.evaluate(() => window.__audioDebug.getLevels());
if (lv.engineMode === "sampled") pass("engineMode defaults to 'sampled'");
else fail(`engineMode default is ${lv.engineMode}`);
if (lv.samplesDecoded === 23) pass("all 23 manifest samples decoded");
else fail(`only ${lv.samplesDecoded}/23 samples decoded`);
if (lv.sampledSkid !== null && lv.convolverWet !== null) pass("skid loop + convolver wired");
else fail(`skid/convolver not wired (skid=${lv.sampledSkid}, conv=${lv.convolverWet})`);

// drive: sampled bus must carry level, synth tonal body must sit muted
await page.evaluate(() => window.__neonx.setInput({ th: 0.8 }));
await advance(page, 2500);
lv = await page.evaluate(() => window.__audioDebug.getLevels());
if (lv.sampledEngine > 0.04) pass(`sampled engine carries level under throttle (${lv.sampledEngine.toFixed(3)})`);
else fail(`sampled engine silent under throttle (${lv.sampledEngine})`);
if (lv.engine > 0.005) pass(`synth noise beds still layered under samples (${lv.engine.toFixed(3)})`);
else fail(`synth bed gain unexpectedly zero (${lv.engine})`);

// toggle to synth: sampled bus fades out, synth carries on
await page.evaluate(() => window.__audioDebug.setEngineMode("synth"));
await advance(page, 1500);
lv = await page.evaluate(() => window.__audioDebug.getLevels());
if (lv.sampledEngine < 0.01) pass("toggle to 'synth' silences the sampled bus");
else fail(`sampled bus still audible in synth mode (${lv.sampledEngine})`);
if (lv.engine > 0.02) pass(`synth engine carries in synth mode (${lv.engine.toFixed(3)})`);
else fail(`synth engine silent in synth mode (${lv.engine})`);

// and back
await page.evaluate(() => window.__audioDebug.setEngineMode("sampled"));
await advance(page, 1500);
lv = await page.evaluate(() => window.__audioDebug.getLevels());
if (lv.sampledEngine > 0.04) pass("toggle back to 'sampled' restores the sampled bus");
else fail(`sampled bus did not come back (${lv.sampledEngine})`);

// tunnel: the recorded-IR wet bus must open inside, close outside.
// Sim time crawls far behind wall time here (frames only advance per forced
// screenshot, and SwiftShader screenshots are slow), so drive by condition —
// "the game reports the car enclosed" — with a frame budget, not a duration.
await page.evaluate(() => window.__neonx.toTunnel(90));
for (let i = 0; i < 200; i++) {
  await page.screenshot({ optimizeForSpeed: true });
  const tunT = await page.evaluate(() => window.__neonx.game?.tunT ?? 0);
  if (tunT > 0.8) break;
}
await advance(page, 1200); // let the wet gain ramp settle
lv = await page.evaluate(() => window.__audioDebug.getLevels());
const inTunnelWet = lv.convolverWet;
if (inTunnelWet > 0.02) pass(`convolver wet opens in the tunnel (${inTunnelWet.toFixed(3)})`);
else fail(`convolver wet stayed closed in tunnel (${inTunnelWet}) — car may not have reached it`);
if (lv.reverbWet === 0) pass("synthetic FDN reverb stays parked at zero with IR wired");
else fail(`FDN reverb active alongside convolver (${lv.reverbWet})`);

await browser.close();
if (errors.length) {
  console.log("\n❌ FAILURES:");
  for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 400));
  process.exit(1);
}
console.log("✅ sampled audio path verified");
