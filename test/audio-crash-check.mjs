#!/usr/bin/env node
/* Headless check for the severity-mapped crash path: boots the game, waits
   for the sample set to decode, then drives GameAudio.crash() directly at a
   sweep of severities through the __audioDebug hook and asserts, via the
   crash debug log (getCrashLog()):
     - the three severity regimes select different layer stacks
       (soft = thud only, no crash body / glass / debris; med = crash body,
       no glass; heavy = full stack with glass + debris),
     - soft hits are low-passed dull and quieter than heavy hits,
     - gain and lowpass cutoff rise monotonically with severity,
     - consecutive same-severity hits never pick the identical variant set
       (shuffle-bag + repitch randomization),
     - a rapid re-hit within the dedupe window plays a quiet single-layer
       rattle rather than re-stacking a full crash — and a hit after the
       window plays full again (no play-to-completion dead time).

   Usage: node test/audio-crash-check.mjs --url http://localhost:3141 */
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3141";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  defaultViewport: { width: 640, height: 400 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message || e)));

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* The world is built by the staged loader after this click, not by the
   constructor, so __neonx existing no longer means there is a world to
   drive in — wait for the load to finish before touching it. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await page.waitForFunction(
  () => window.__audioDebug?.getLevels?.()?.samplesDecoded >= 33,
  { timeout: 30000 }
);

/* helper: fire crash(sev) and return the log entry it appended.
   AudioContext.currentTime advances in wall time, so real sleeps between
   calls move the audio clock past the dedupe windows. */
const hit = async (sev) => page.evaluate((s) => {
  const a = window.__audioDebug;
  const before = a.getCrashLog().length;
  a.crash(s);
  const log = a.getCrashLog();
  return log.length > before ? log[log.length - 1] : null;
}, sev);

// ---- severity sweep: one hit per severity, spaced past the re-hit window
const sweep = [3, 4, 5.5, 7, 9, 12, 15, 20, 27];
const entries = [];
for (const s of sweep) {
  entries.push(await hit(s));
  await sleep(850);
}
if (entries.every((e) => e && e.kind === "full")) pass("sweep: every spaced hit played a full crash (no dead-time latch)");
else fail(`sweep: non-full entries: ${JSON.stringify(entries.filter((e) => !e || e.kind !== "full"))}`);

const byTier = (t) => entries.filter((e) => e && e.tier === t);
const soft = byTier("soft"), med = byTier("med"), heavy = byTier("heavy");
if (soft.length && med.length && heavy.length) pass(`sweep covers all tiers (soft=${soft.length} med=${med.length} heavy=${heavy.length})`);
else fail(`tier coverage hole: soft=${soft.length} med=${med.length} heavy=${heavy.length}`);

// soft: thud/light-metal only — never a crash body, glass or debris
const softBad = soft.filter((e) =>
  e.layers.some((l) => l.startsWith("crash") || l.startsWith("glass")));
if (!softBad.length) pass("soft hits carry no crash body / glass / debris layers");
else fail(`soft hit leaked heavy layers: ${JSON.stringify(softBad)}`);
if (soft.every((e) => e.layers.length >= 1 && e.layers.every((l) => l.startsWith("thud") || l.startsWith("metalL"))))
  pass("soft hits are thud/light-metal only");
else fail(`soft layers wrong: ${JSON.stringify(soft.map((e) => e.layers))}`);

// med: crash body present, no glass
if (med.every((e) => e.layers.includes("crashMed")) &&
    !med.some((e) => e.layers.some((l) => l.startsWith("glass"))))
  pass("med hits use the med crash body and never glass");
else fail(`med layers wrong: ${JSON.stringify(med.map((e) => e.layers))}`);

// heavy: full stack — heavy body + glass + debris on at least most hits
if (heavy.every((e) => e.layers.includes("crashHeavy") && e.layers.includes("crashDebris")))
  pass("heavy hits carry heavy body + debris tail");
else fail(`heavy layers wrong: ${JSON.stringify(heavy.map((e) => e.layers))}`);
if (heavy.some((e) => e.layers.some((l) => l.startsWith("glass"))))
  pass("glass appears in the heavy tier");
else fail("no glass layer in any heavy hit");

// different tiers actually select different sample sets
const softSet = new Set(soft.flatMap((e) => e.layers));
const heavySet = new Set(heavy.flatMap((e) => e.layers));
if (![...softSet].some((l) => heavySet.has(l))) pass("soft and heavy tiers share no samples");
else fail(`tier overlap: ${[...softSet].filter((l) => heavySet.has(l))}`);

// continuous scaling: lp cutoff and gain rise with severity (jitter is
// +/-3dB / +/-15%, tier spans are far wider, so endpoints must order)
const first = entries[0], last = entries[entries.length - 1];
if (last.lpHz > first.lpHz * 3) pass(`lowpass opens with severity (${first.lpHz.toFixed(0)}Hz -> ${last.lpHz.toFixed(0)}Hz)`);
else fail(`lowpass barely moves: ${first.lpHz} -> ${last.lpHz}`);
if (last.gain > first.gain * 1.5) pass(`gain scales with severity (${first.gain.toFixed(3)} -> ${last.gain.toFixed(3)})`);
else fail(`gain barely moves: ${first.gain} -> ${last.gain}`);

// ---- consecutive same-severity hits must differ -------------------------
const reps = [];
for (let i = 0; i < 6; i++) {
  reps.push(await hit(8));
  await sleep(850);
}
const metalOf = (e) => e.layers.find((l) => l.startsWith("metalM"));
let distinct = 0;
for (let i = 1; i < reps.length; i++) {
  if (metalOf(reps[i]) !== metalOf(reps[i - 1]) || Math.abs(reps[i].rate - reps[i - 1].rate) > 0.005)
    distinct++;
}
if (distinct === reps.length - 1) pass("6 consecutive same-severity hits: no two adjacent renders identical (variant or rate differs)");
else fail(`adjacent identical renders: ${JSON.stringify(reps.map((e) => [metalOf(e), e.rate]))}`);
const metals = new Set(reps.map(metalOf));
if (metals.size >= 3) pass(`same-severity metal variants rotate through the bag (${metals.size} distinct of ${reps.length})`);
else fail(`metal bag barely rotates: ${[...metals]}`);

// ---- rapid re-hit gating ------------------------------------------------
await sleep(900);
const full1 = await hit(9);
await sleep(50);
const burst = await hit(9); // same contact burst -> dropped
await sleep(250);
const rat = await hit(7); // pileup follow-up -> quiet single rattle
await sleep(900);
const full2 = await hit(9); // window passed -> full again
if (full1.kind === "full" && burst.kind === "skip") pass("re-hit <120ms is dropped (same contact burst)");
else fail(`burst gating wrong: ${full1.kind}/${burst.kind}`);
if (rat.kind === "rattle" && rat.layers.length === 1 && rat.gain < full1.gain)
  pass(`re-hit in the pileup window plays one quiet rattle layer (${rat.layers[0]})`);
else fail(`pileup rattle wrong: ${JSON.stringify(rat)}`);
if (full2.kind === "full") pass("after the window a full crash plays again");
else fail(`post-window hit not full: ${JSON.stringify(full2)}`);

// a clearly bigger hit inside the window still gets its full crash
await sleep(900);
await hit(6);
await sleep(300);
const esc = await hit(20);
if (esc.kind === "full") pass("escalating hit inside the window still plays full (bigger crash never swallowed)");
else fail(`escalating hit swallowed: ${JSON.stringify(esc)}`);

await browser.close();
if (errors.length) {
  console.error(`\nFAIL: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log("\nOK: crash severity mapping, variation and re-hit gating all check out");
