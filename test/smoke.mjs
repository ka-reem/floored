/* Headless smoke test: boots the game in Chrome (SwiftShader WebGL), walks the
   menus, drives in each zone, forces a crash, and captures screenshots +
   console errors into test/artifacts/. Exits non-zero on page errors.

   Usage: node test/smoke.mjs [--url http://localhost:3111] (starts `next dev`
   itself when no --url is given). */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const ART = path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });

const argUrl = process.argv.indexOf("--url");
const externalUrl = argUrl > -1 ? process.argv[argUrl + 1] : null;
const PORT = 3111;
const URL = externalUrl || `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      process.stdout.write("[next] " + s);
      if (s.includes("Ready") || s.includes("started server")) {
        clearTimeout(to);
        resolve();
      }
    });
    child.stderr.on("data", (d) => process.stderr.write("[next:err] " + d.toString()));
    child.on("exit", (c) => reject(new Error("next dev exited " + c)));
  });
  return child;
}

const errors = [];
const warnings = [];

/* A SwiftShader frame can take seconds on a loaded machine, and a screenshot
   waits on one. Never let that sink the whole run — the driving checks below
   are the part that actually verifies the game. */
async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(ART, name + ".png") });
    console.log("  📸", name);
  } catch (e) {
    warnings.push(`screenshot ${name} failed: ${e.message}`);
    console.log("  ⚠️  screenshot", name, "skipped:", String(e.message).slice(0, 80));
  }
}

async function main() {
  const dev = await startDev();
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,800",
      "--mute-audio",
    ],
    defaultViewport: { width: 1280, height: 800 },
    protocolTimeout: 300000,
  });
  const page = await browser.newPage();
  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    if (t === "error") {
      // ignore benign favicon 404s
      if (txt.includes("favicon")) return;
      errors.push(txt);
      console.log("  ⛔ console.error:", txt.slice(0, 300));
    } else if (t === "warning" && !txt.includes("Download the React DevTools")) {
      warnings.push(txt);
    }
  });
  page.on("pageerror", (e) => {
    errors.push(String(e.message || e));
    console.log("  ⛔ pageerror:", String(e.message || e).slice(0, 400));
  });

  console.log("→ loading", URL);
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 120000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 60000 });
  await sleep(1200);
  await shot(page, "01-menu");

  // garage
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("GARAGE"));
    b?.click();
  });
  await sleep(600);
  await shot(page, "02-garage");
  // pick the kei car then back to kaze, then DONE
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".carCard h3")];
    cards.find((c) => c.textContent.includes("TANUKI"))?.parentElement?.click();
  });
  await sleep(400);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".carCard h3")];
    cards.find((c) => c.textContent.includes("KAZE"))?.parentElement?.click();
    const done = [...document.querySelectorAll("button")].find((x) => x.textContent === "DONE");
    done?.click();
  });
  await sleep(300);

  // drive!
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b?.click();
  });
  await sleep(3500);
  await shot(page, "03-highway-chase");

  const st0 = await page.evaluate(() => window.__neonx.state());
  console.log("  state on deck:", JSON.stringify({ ...st0, errors: undefined }));

  // drive forward on the deck toward an exit
  await page.evaluate(() => {
    window.__neonx.teleport(500 + 6.9, -520, 9, 0, 26);
    window.__neonx.setInput({ th: 1 });
  });
  await sleep(4000);
  await shot(page, "04-exit-approach");

  /* Ramp runs. SwiftShader renders ~4 fps and physics substeps are frame-capped,
     so sim time runs far slower than wall clock — poll for the condition instead
     of sleeping a fixed interval. The ramps are curved (see game/world/ramps.ts),
     so a fixed heading drives straight off the pavement: drop the car on a ramp
     centreline sample and steer toward a lookahead sample each poll. `way` +1
     heads down toward the frontage road, -1 climbs back up to the deck. `off` is
     how far the car has strayed from the centreline — the ramp is 10.5 m wide,
     so anything past ~6 m means it has left the road. */
  const driveRamp = async (sel, way, cond, timeoutMs, label) => {
    await page.evaluate(
      ({ sel, way }) => {
        const t = window.__neonx.game.terrain;
        const r = t.ramps.find(
          (q) => q.zr === sel.zr && q.mir === sel.mir && q.dir === sel.dir
        );
        // start partway along so the run fits the timeout at SwiftShader speed
        const i = Math.max(0, r.pts.findIndex((p) => p.y < (way > 0 ? 8.5 : 2.5)));
        const p = r.pts[i];
        window.__neonx.__ramp = { r, way, i };
        window.__neonx.teleport(p.x, p.z, p.y + 0.2,
          Math.atan2(p.tx * way, p.tz * way), 10);
      },
      { sel, way }
    );
    const t0 = Date.now();
    let st, offMax = 0;
    for (;;) {
      st = await page.evaluate(() => {
        const s = window.__neonx.state();
        const { r, way } = window.__neonx.__ramp;
        let bi = 0, bd = 1e9;
        for (let k = 0; k < r.pts.length; k++) {
          const d = Math.hypot(r.pts[k].x - s.x, r.pts[k].z - s.z);
          if (d < bd) { bd = d; bi = k; }
        }
        const la = r.pts[Math.max(0, Math.min(r.pts.length - 1, bi + way * 6))];
        let dh = Math.atan2(la.x - s.x, la.z - s.z) - s.h;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        window.__neonx.setInput({
          th: s.kmh < 42 ? 0.85 : 0.1,
          st: Math.max(-1, Math.min(1, dh * 2.4)),
        });
        return { ...s, off: bd };
      });
      offMax = Math.max(offMax, st.off);
      if (cond(st)) break;
      if (Date.now() - t0 > timeoutMs) {
        errors.push(`${label} timed out: x=${st.x.toFixed(1)} y=${st.y.toFixed(2)} off=${st.off.toFixed(1)}`);
        break;
      }
      await sleep(300);
    }
    if (offMax > 6)
      errors.push(`${label} left the ramp: max offset ${offMax.toFixed(1)} m`);
    return { ...st, offMax };
  };

  // off-ramp descent: roll down a west-side ramp into town
  const stRamp = await driveRamp({ zr: 260, mir: 1, dir: -1 }, 1,
    (s) => s.y < 2.5, 45000, "ramp descent");
  console.log("  after descent: y =", stRamp.y.toFixed(2), " x =", stRamp.x.toFixed(1),
    " maxOff =", stRamp.offMax.toFixed(1));
  await shot(page, "04b-ramp-descent");

  // on-ramp climb: from the foot of a west-side ramp back up to the deck
  const stClimb = await driveRamp({ zr: -260, mir: 1, dir: 1 }, -1,
    (s) => s.y > 8.4, 60000, "on-ramp climb");
  console.log("  after climb: y =", stClimb.y.toFixed(2), " x =", stClimb.x.toFixed(1),
    " maxOff =", stClimb.offMax.toFixed(1));
  await shot(page, "04c-ramp-climb");

  // town: teleport to origin, drive
  await page.evaluate(() => {
    window.__neonx.setInput(null);
    window.__neonx.teleport(0, 0);
    window.__neonx.game.resetCar();
    window.__neonx.setInput({ th: 0.8 });
  });
  await sleep(4500);
  await shot(page, "05-town-drive");
  const st1 = await page.evaluate(() => window.__neonx.state());
  console.log("  state in town:", JSON.stringify({ ...st1, errors: undefined }));

  // crash test
  await page.evaluate(() => {
    window.__neonx.setInput({ th: 1 });
    window.__neonx.crashTest();
  });
  await sleep(1800);
  await shot(page, "06-crash");
  await sleep(1500);
  const st2 = await page.evaluate(() => window.__neonx.state());
  console.log("  after crash:", JSON.stringify({ ...st2, errors: undefined }));

  // rain + cockpit
  await page.evaluate(() => {
    window.__neonx.setInput({ th: 0.5 });
    window.__neonx.setRain(true);
    window.__neonx.setCam(1);
  });
  await sleep(2000);
  await shot(page, "07-rain-cockpit");

  // hood cam + day time
  await page.evaluate(() => {
    window.__neonx.setRain(false);
    window.__neonx.setCam(2);
    window.__neonx.setTime(13);
  });
  await sleep(1500);
  await shot(page, "08-day-hood");

  // fps estimate
  const f0 = await page.evaluate(() => window.__neonx.state().frames);
  await sleep(3000);
  const f1 = await page.evaluate(() => window.__neonx.state().frames);
  console.log(`  ~fps (swiftshader): ${((f1 - f0) / 3).toFixed(1)}`);

  // pause menu
  await page.keyboard.press("Escape");
  await sleep(500);
  await shot(page, "09-pause");

  await browser.close();
  dev?.kill("SIGTERM");

  console.log("\nwarnings:", warnings.length);
  if (errors.length) {
    console.log("\n❌ ERRORS:");
    for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 500));
    process.exit(1);
  }
  console.log("✅ smoke test passed —", st2.npcs, "npcs,", st2.chunksVisible + "/" + st2.chunksTotal, "chunks visible");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
