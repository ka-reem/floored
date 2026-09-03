/* Headless check of the drive-stats accumulator (the STATS block in
   game/engine.ts) and its persistence path (Profile.stats in settings.ts):

   1. distance / time-driven / top-speed integrate correctly against the
      car's own odometer over a scripted full-throttle run;
   2. a full mountain-pass traversal banks exactly one TOUGE run, and a
      half-pass U-turn banks none;
   3. crossing the endless-highway seam banks a lap;
   4. a forced crash (the smoke test's own crashTest) counts once;
   5. the lifetime totals survive RESUME → reload → DRIVE via the profile,
      and the session counters start over.

   Uses __neonx.simStep, which advances the same physics/splice/stats
   pipeline the render loop runs, so none of this waits on SwiftShader
   frame times (except the crash, which needs the loop's collision gates).

   Usage: node test/drive-stats-check.mjs [--url http://localhost:3111]
   (starts `next dev` itself when no --url is given). */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const ART = path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });

const argUrl = process.argv.indexOf("--url");
const externalUrl = argUrl > -1 ? process.argv[argUrl + 1] : null;
const PORT = 3123;
const URL = externalUrl || `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const ok = (cond, msg) => {
  if (cond) console.log("  ✅", msg);
  else {
    errors.push(msg);
    console.log("  ⛔", msg);
  }
};

async function startDev() {
  if (externalUrl) return null;
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("next dev timeout")), 120000);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Ready") || s.includes("started server")) {
        clearTimeout(to);
        resolve();
      }
    });
    child.on("exit", (c) => reject(new Error("next dev exited " + c)));
  });
  return child;
}

/** Click the first <button> whose text contains `label`. */
const clickBtn = (page, label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      x.textContent.includes(l)
    );
    if (!b) throw new Error("no button " + l);
    b.click();
  }, label);

/** DRIVE from the main menu and wait for the world. */
async function drive(page) {
  await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
  await clickBtn(page, "DRIVE");
  await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
  await sleep(800);
}

const state = (page) => page.evaluate(() => window.__neonx.state());

async function main() {
  const dev = await startDev();
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    ],
    defaultViewport: { width: 1200, height: 800 },
    protocolTimeout: 300000,
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message || e)));

  console.log("→ loading", URL);
  await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
  // fresh profile, so the lifetime column starts from zero
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await drive(page);

  /* ---- 1. the integrator against the car's own odometer ---- */
  const s0 = await state(page);
  await page.evaluate(() => {
    window.__neonx.setInput({ th: 1 });
    window.__neonx.simStep(30);
  });
  const s1 = await state(page);
  const dOdo = (s1.odo - s0.odo) * 1000; // odo is km, integrated |u|·dt
  const dDist = s1.stats.dist - s0.stats.dist;
  console.log(
    `  30 s full throttle: dist +${dDist.toFixed(1)} m, odo +${dOdo.toFixed(1)} m,` +
      ` top ${s1.stats.topSpeed.toFixed(1)} m/s, driveT +${(s1.stats.driveT - s0.stats.driveT).toFixed(1)} s`
  );
  // odo also integrates below the moveFloor, so allow a few metres of slack
  ok(Math.abs(dDist - dOdo) < 12, `distance tracks the odometer (Δ ${(dDist - dOdo).toFixed(2)} m)`);
  // a blind throttle-only run can spend much of it shoving traffic — the
  // correctness claim is the odometer match above, this only proves motion
  ok(dDist > 80, "distance actually accumulated");
  ok(
    s1.stats.topSpeed >= Math.abs(s1.u) - 0.2 && s1.stats.topSpeed < 120,
    `top speed holds the run's max (${s1.stats.topSpeed.toFixed(1)} vs now ${Math.abs(s1.u).toFixed(1)} m/s)`
  );
  const dT = s1.stats.driveT - s0.stats.driveT;
  ok(dT > 25 && dT < 31, `time driven ≈ sim time (${dT.toFixed(1)} s of 30)`);

  /* ---- 2a. full mountain traversal = one TOUGE run ---- */
  const walkPass = async (fromFrac, toFrac) =>
    page.evaluate(
      ({ fromFrac, toFrac }) => {
        const g = window.__neonx.game;
        const mt = g.world.routes.mtn;
        const n = 40;
        const dir = toFrac > fromFrac ? 1 : -1;
        for (let i = 0; i <= n; i++) {
          const f = fromFrac + ((toFrac - fromFrac) * i) / n;
          const s = Math.max(4, Math.min(mt.len - 4, f * mt.len));
          const p = mt.worldOf(s, mt.laneOffset(0, s));
          const h = mt.poseAt(s).h + (dir < 0 ? Math.PI : 0);
          window.__neonx.teleport(p.x, p.z, p.y + 0.15, h, 40);
          window.__neonx.setInput({ th: 0 });
          window.__neonx.simStep(0.6); // ≥1 stats probe per station (0.5 s cadence)
        }
        return mt.len;
      },
      { fromFrac, toFrac }
    );
  const backToDeck = () =>
    page.evaluate(() => {
      const c = window.__neonx.game.terrain.corridor;
      const p = c.worldOf(0, 0);
      window.__neonx.teleport(p.x, p.z, p.y + 0.2, c.pose(0).h, 30);
      window.__neonx.simStep(4); // > the 1.5 s off-pass grace → visit closes
    });

  const mtnLen = await walkPass(0.03, 0.97);
  await backToDeck();
  const s2 = await state(page);
  console.log(`  mountain pass len ${mtnLen.toFixed(0)} m; runs = ${s2.stats.mtnRuns}`);
  ok(s2.stats.mtnRuns === 1, `full pass traversal banked one touge run (${s2.stats.mtnRuns})`);

  /* ---- 2b. half a pass then back out = no run ---- */
  await walkPass(0.03, 0.45);
  await walkPass(0.45, 0.03);
  await backToDeck();
  const s3 = await state(page);
  ok(s3.stats.mtnRuns === 1, `half-pass U-turn banked nothing (still ${s3.stats.mtnRuns})`);

  /* ---- 3. a seam crossing banks a lap ---- */
  await page.evaluate(() => {
    window.__neonx.toSeam(150); // 120 m short of Z1, at speed
    window.__neonx.setInput({ th: 0.9 });
    window.__neonx.simStep(20); // far enough to cross the splice window
  });
  const s4 = await state(page);
  ok(s4.stats.laps >= 1, `seam crossing banked a lap (laps ${s4.stats.laps}, loops ${s4.loops})`);

  /* ---- 4. a crash counts (needs the render loop's collision gates) ---- */
  await page.evaluate(() => {
    window.__neonx.setInput({ th: 0, br: 0 });
    window.__neonx.crashTest();
  });
  try {
    await page.waitForFunction(() => window.__neonx.state().stats.crashes >= 1, {
      timeout: 45000, polling: 500,
    });
  } catch {
    /* fall through to the assert below */
  }
  const s5 = await state(page);
  ok(s5.stats.crashes >= 1, `forced crash counted (crashes ${s5.stats.crashes})`);
  await page.evaluate(() => window.__neonx.setInput(null));

  /* ---- 5. persistence: RESUME writes the profile; reload seeds lifetime ---- */
  const before = await state(page);
  await page.keyboard.press("Escape");
  await sleep(400);
  await clickBtn(page, "RESUME"); // persist() runs here
  await sleep(400);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("neonx.profile.v3") || "null")
  );
  ok(
    stored && stored.stats && Math.abs(stored.stats.dist - before.lifetime.dist) < 60,
    `profile stored lifetime dist ${(stored?.stats?.dist ?? -1).toFixed?.(1)} m` +
      ` (engine says ${before.lifetime.dist.toFixed(1)})`
  );
  ok(
    stored?.stats?.mtnRuns === before.lifetime.mtnRuns &&
      stored?.stats?.crashes === before.lifetime.crashes,
    "profile stored the counters"
  );

  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await drive(page);
  const s6 = await state(page);
  console.log(
    `  after reload: lifetime dist ${s6.lifetime.dist.toFixed(1)} m,` +
      ` session dist ${s6.stats.dist.toFixed(1)} m`
  );
  ok(
    s6.lifetime.dist >= stored.stats.dist - 1,
    "lifetime distance survived the reload"
  );
  ok(
    s6.lifetime.mtnRuns === stored.stats.mtnRuns && s6.lifetime.crashes === stored.stats.crashes,
    "lifetime counters survived the reload"
  );
  ok(s6.stats.dist < 40, `session counters started over (${s6.stats.dist.toFixed(1)} m)`);

  await browser.close();
  dev?.kill("SIGTERM");

  console.log(errors.length ? `\n${errors.length} FAILURE(S)` : "\nALL CHECKS PASSED");
  for (const e of errors) console.log("  -", e);
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
