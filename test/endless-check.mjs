/* Headless check of ENDLESS MODE (the ENDLESS block in game/engine.ts).

   Four things, all of which have to hold for the mode to mean anything:

     1 SCORE     distance accumulates while driving, in metres
     2 MONEY     it accrues from the same metres at ENDLESS.perMetre
     3 CRASH     a real impact zeroes the score and takes NOTHING from the
                 bank or the record; a scrape zeroes nothing
     4 PERSIST   both survive a reload through the profile (device-only)

   Everything drives __neonx.simStep, the same
   readInput -> stepPhysics -> splice -> collide -> runUpdate pipeline the
   render loop runs, so none of it waits on SwiftShader frame times. The
   crash/scrape geometry is lifted from test/clean-run-check.mjs, which is
   where CLEAN_RUN.impact was measured in the first place.

   Usage: node test/endless-check.mjs --url http://localhost:3153 */

import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3153");
const TIER = arg("--tier", "mobile-base");

const errors = [];
const ok = (cond, msg) => {
  console.log(cond ? "  OK   " : "  FAIL ", msg);
  if (!cond) errors.push(msg);
};

const clickBtn = (page, label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(l));
    if (!b) throw new Error("no button " + l);
    b.click();
  }, label);

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  protocolTimeout: 3000000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  pageerror:", String(e.message || e)));
await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
/* Fresh profile for the FIRST load only — the reload at the end is the whole
   persistence test, so a clear-on-every-document would wipe what it checks. */
await page.evaluateOnNewDocument(() => {
  try {
    if (!sessionStorage.getItem("ezCleared")) {
      localStorage.clear();
      sessionStorage.setItem("ezCleared", "1");
    }
  } catch {}
});
await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 600000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 900000 });
await clickBtn(page, "DRIVE");
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 2400000, polling: 5000 });
console.log("world loaded");

await page.evaluate(() => window.__neonx.setEndless(true));

/* 1 + 2 — ten seconds of clear road on the deck. */
const run = await page.evaluate(() => {
  const nx = window.__neonx, g = nx.game, c = g.terrain.corridor;
  const p = c.worldOf(700, 0);
  nx.teleport(p.x, p.z, p.y + 0.05, c.pose(700).h, 40);
  nx.setInput({ th: 0.6, br: 0, st: 0 });
  const a = nx.state();
  nx.simStep(10);
  const b = nx.state();
  nx.setInput(null);
  return {
    a: { run: a.run, ez: a.ez, odo: a.stats.dist },
    b: { run: b.run, ez: b.ez, odo: b.stats.dist },
  };
});
const dDist = run.b.run.dist - run.a.run.dist;
const dMoney = run.b.ez.money - run.a.ez.money;
/* Money is priced off the ODOMETER's metres, not off the run's: ten seconds
   of deck at 40 m/s can contain a contact, and a run that resets mid-window
   would make the two deltas differ for a reason that is not a bug. Both come
   out of the same integration in statsUpdate. */
const dOdo = run.b.odo - run.a.odo;
ok(dDist > 100, `score accumulates: +${dDist.toFixed(0)} m of run in 10 s at ~40 m/s`);
ok(
  Math.abs(dMoney - dOdo * 0.1) < 0.5,
  `money is the metres priced: +¥${dMoney.toFixed(1)} for ${dOdo.toFixed(0)} m driven` +
    ` (¥${(dOdo * 0.1).toFixed(1)} expected)`
);
ok(run.b.ez.best >= run.b.run.dist, `best tracks the run: ${run.b.ez.best.toFixed(0)} m`);

/* Place the car `off` metres inside the east parapet at station z, `deg` off
   the road direction, and run the sim. Lifted from clean-run-check.mjs. */
const wallRun = (opts) =>
  page.evaluate((o) => {
    const nx = window.__neonx, g = nx.game, c = g.terrain.corridor;
    const lat = c.halfWidth(o.z) - o.off;
    const p = c.worldOf(o.z, lat);
    nx.teleport(p.x, p.z, p.y + 0.05, c.pose(o.z).h + (o.deg * Math.PI) / 180, o.ms);
    nx.setInput({ th: 0.35, br: 0, st: 0 });
    nx.clearImpacts();
    const a = nx.state();
    nx.simStep(o.secs);
    const b = nx.state();
    nx.setInput(null);
    return { peak: b.impactMax, a: { run: a.run, ez: a.ez }, b: { run: b.run, ez: b.ez } };
  }, opts);

/* 3a — a real impact: driven AT the parapet at 25 degrees, 30 m/s. Kept
   SHORT (1.5 s) on purpose: the car goes on driving after the hit, so a long
   run would have the score back off zero and the settle clock expired by the
   time it is read — which says nothing about whether the reset fired. What
   proves the reset is the reset COUNTER. */
const hit = await wallRun({ z: 900, off: 3, deg: 25, ms: 30, secs: 1.5 });
ok(hit.peak >= 5, `crash case really is one: peak normal impact ${hit.peak.toFixed(2)} m/s`);
ok(
  hit.b.run.resets > hit.a.run.resets && hit.b.run.dist < hit.a.run.dist,
  `a real impact resets the run: ${hit.a.run.dist.toFixed(0)} m -> ${hit.b.run.dist.toFixed(1)} m` +
    ` (impact ${hit.b.run.lastImpact.toFixed(2)} m/s)`
);
ok(hit.b.ez.flash > 0, `the panel is told to flash the reset (${hit.b.ez.flash.toFixed(2)} s left)`);
ok(
  hit.b.ez.money >= hit.a.ez.money,
  `the bank is untouched by the crash: ¥${hit.a.ez.money.toFixed(1)} -> ¥${hit.b.ez.money.toFixed(1)}`
);
ok(
  hit.b.ez.best >= hit.a.ez.best,
  `the record is untouched by the crash: ${hit.b.ez.best.toFixed(0)} m`
);

/* 3b — a scrape: kerbing the same parapet at 1 degree, fast. */
await page.evaluate(() => window.__neonx.setCleanRun(3000));
const rub = await wallRun({ z: 900, off: 0.2, deg: 1, ms: 45, secs: 3 });
ok(rub.peak < 5, `scrape case really is one: peak normal impact ${rub.peak.toFixed(2)} m/s`);
ok(rub.b.run.dist > 0, `a scrape does not end the run (${rub.b.run.dist.toFixed(0)} m still standing)`);

/* 4 — persistence. Esc pauses, which is what tears down the playing screen and
   makes GameApp write the profile; then read the store and reload into it. */
const live = await page.evaluate(() => ({ ...window.__neonx.state().ez }));
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 1200));
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("neonx.profile.v3") || "{}"));
ok(
  Math.abs((stored.money ?? -1) - live.money) < 1,
  `money is in the profile: ¥${(stored.money ?? -1).toFixed(1)}`
);
ok(
  Math.abs((stored.bestDistance ?? -1) - live.best) < 1,
  `bestDistance is in the profile: ${(stored.bestDistance ?? -1).toFixed(0)} m`
);
ok(stored.settings?.endless === true, "the mode itself is in the profile");
ok(
  typeof stored.cleanRunBest === "number" && typeof stored.stats === "object" && !!stored.carId,
  "the rest of the profile is intact (cleanRunBest, stats, carId)"
);

/* Reload WITHOUT driving: the engine is constructed on mount, so the seeded
   values are readable long before any world is built. */
const before = await page.evaluate(() => ({ ...window.__neonx.state().ez }));
await page.reload({ waitUntil: "domcontentloaded", timeout: 600000 });
await page.waitForFunction(() => !!window.__neonx?.game, { timeout: 900000 });
/* state() reads world geometry, which does not exist until a world is built —
   read the engine's own field instead. */
const after = await page.evaluate(() => ({ ...window.__neonx.game.ez }));
ok(Math.abs(after.money - before.money) < 1, `money survives a reload: ¥${after.money.toFixed(1)}`);
ok(Math.abs(after.best - before.best) < 1, `best survives a reload: ${after.best.toFixed(0)} m`);

await browser.close();
console.log(errors.length ? `\n${errors.length} FAILED` : "\nall checks passed");
process.exit(errors.length ? 1 : 0);
