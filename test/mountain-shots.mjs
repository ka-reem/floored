/* Mountain-road photographer + live drive-through.

   Two jobs, one boot (SwiftShader sessions are expensive on a loaded box):

   1. DRIVE the pass under the real engine — physics heightAt, collidePlayer,
      the analytic walls. The pass is ONE lane in ONE direction now, so the
      probes walk the lane centre and both edges rather than two lane
      centres — and they also face BACKWARDS at every station, because a
      one-way road that traps a player who turns round is the failure this
      lane cares about: the car has to be held up either way it points.
   2. Photograph it from the dashcam (CAM_POV is the shipped view): the exit
      gore across the seam, the approach boards, mid-corner with the rock
      face, the turnout, a pass car using the turnout to let the player by,
      and the merge back onto the expressway.

   Usage: node test/mountain-shots.mjs --url http://localhost:3000 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { debugUrl } from "./lib/debug-url.mjs";

const ART = path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });
const argUrl = process.argv.indexOf("--url");
const URL = argUrl > -1 ? process.argv[argUrl + 1] : "http://localhost:3000";
const VW = Number(process.env.SHOT_W || 1200), VH = Number(process.env.SHOT_H || 675);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: VW, height: VH },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});

await page.goto(debugUrl(URL), { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
await sleep(3000);

const shoot = async (name) => {
  await page.screenshot({
    path: path.join(ART, name + ".jpg"), type: "jpeg", quality: 80,
  });
  console.log("  📸", name);
};

/* ---- 1. live physics + collider verification -----------------------------
   SwiftShader in this sandbox runs the frame loop at ~1% of real time (the
   dt clamp caps sim progress per rendered frame), so an end-to-end wall-clock
   drive is off the table — the smoke suite's ramp timeouts are this same
   effect. What the browser session uniquely adds over the node sims (which
   already drive the REAL terrain.heightAt + collidePlayer for hours of sim
   time) is the fully BUILT world: the real collider index and the staged
   loader's actual output. So verify exactly that, fast:
   - settled teleport probes: park the car at 30+ stations along the lane and
     its two edges, facing both directions, let real frames run (physics +
     clamps + ground follow), and assert it settles ON the road at road
     height;
   - a collider sweep of the driven line: nothing highway.ts built (nose
     blocks, lamp poles, sign masts) may stand inside the lane. */
console.log("live probes (real physics frames at each station):");
const mtLen = await page.evaluate(() => window.__neonx.game.world.routes.mtn.len);
{
  let worstDy = 0, off = 0, probes = 0;
  for (let s0 = 10; s0 < mtLen - 10; s0 += 12) {
    /* lane centre, then a metre inside each edge — and every third probe
       faces backwards, the U-turn case a one-way road must survive */
    const lat = [0, 1, -1][probes % 3];
    const back = probes % 3 === 2;
    await page.evaluate(({ s0, lat, back }) => {
      const g = window.__neonx;
      g.toMountain(s0, 14, 0);
      if (lat) {
        const mt = g.game.world.routes.mtn;
        const h = mt.halfWidths(s0);
        const d = lat > 0 ? Math.max(0, h.hwL - 1.0) : -Math.max(0, h.hwR - 1.0);
        const p = mt.poseAt(s0);
        g.game.car.x += d * p.nx;
        g.game.car.z += d * p.nz;
      }
      if (back) g.game.car.h += Math.PI;
    }, { s0, lat, back });
    await sleep(320);
    const st = await page.evaluate(({ s0 }) => {
      const g = window.__neonx;
      const mt = g.game.world.routes.mtn;
      const w = mt.worldOf(s0, 0);
      const s2 = g.state();
      return { y: s2.y, ey: w.y, on: s2.onMountain, x: s2.x, z: s2.z, ex: w.x, ez: w.z };
    }, { s0 });
    probes++;
    const dy = Math.abs(st.y - st.ey);
    worstDy = Math.max(worstDy, dy);
    if (!st.on) off++;
    if (dy > 1.4)
      errors.push(`probe s=${s0} lat ${lat}${back ? " (facing back)" : ""}: ` +
        `y ${st.y.toFixed(2)} vs road ${st.ey.toFixed(2)}`);
  }
  console.log(`  ${probes} probes (lane centre + both edges, every third facing` +
    ` backwards), worst |y - road| ${worstDy.toFixed(2)} m, off-surface ${off}`);
  if (off) errors.push(`${off} probes settled off the mountain surface`);

  const colliders = await page.evaluate(() => {
    const g = window.__neonx;
    const mt = g.game.world.routes.mtn;
    const bad = [];
    for (let s = 2; s < mt.len - 2; s += 2) {
      const { hwL, hwR } = mt.halfWidths(s);
      for (const lat of [-Math.max(0, hwR - 1.0), 0, Math.max(0, hwL - 1.0)]) {
        const w = mt.worldOf(s, lat);
        const near = g.collidersNear(w.x, w.z);
        for (const b of near.aabbs) {
          if (w.x > b.x0 && w.x < b.x1 && w.z > b.z0 && w.z < b.z1 &&
            w.y + 1.2 > (b.y0 ?? -1e9) && w.y < (b.y1 ?? 1e9))
            bad.push(`aabb on pavement at s=${s.toFixed(0)} lat=${lat.toFixed(1)}`);
        }
        for (const o of near.obbs) {
          const dx = w.x - o.x, dz = w.z - o.z;
          const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
          if (Math.abs(lx) < o.hw + 0.4 && Math.abs(lz) < o.hd + 0.4 &&
            w.y + 1.2 > o.y0 && w.y < o.y1)
            bad.push(`obb on pavement at s=${s.toFixed(0)} lat=${lat.toFixed(1)}`);
        }
      }
    }
    return bad.slice(0, 8);
  });
  if (colliders.length) for (const c of colliders) errors.push(c);
  else console.log("  collider sweep: nothing stands in the lane");
}

/* ---- 2. the photographs ------------------------------------------------- */
console.log("photographs (dashcam):");
/* park helper: place on the pass, idle throttle so the dashcam reads alive */
const parkMtn = async (s, _lane = 0, facing = 1) => {
  await page.evaluate(({ s, facing }) => {
    const g = window.__neonx;
    g.toMountain(s, 8, 0);
    if (facing < 0) g.game.car.h += Math.PI; // the U-turn view
    g.setInput({ th: 0.12, br: 0, st: 0, hb: 0, horn: 0 });
  }, { s, facing });
  await sleep(1700);
};

// the exit picture across the seam: the +LOOP copy of the gore dead ahead
await page.evaluate(() => window.__neonx.toCorridor(1958, 12, 99));
await page.evaluate(() => window.__neonx.setInput({ th: 0.12, br: 0, st: 0, hb: 0, horn: 0 }));
await sleep(1700);
await shoot("mountain-exit-seam");
// …and the real gore mouth
await page.evaluate(() => window.__neonx.toCorridor(-1998, 10, 99));
await sleep(1700);
await shoot("mountain-exit-gore");

await parkMtn(96, 0);
await shoot("mountain-climb");
await parkMtn(168, 0);
await shoot("mountain-corner");
await parkMtn(258, 0);
await shoot("mountain-crest");
await parkMtn(mtLen - 42, 0);
await shoot("mountain-rejoin");

/* the LET-BY: park just short of the turnout and put a real pass car into
   it, so the photograph shows what replaced the oncoming stream — a slower
   car pulling into the pocket to wave the player through. The pass runs at
   ~1% sim speed in this sandbox, so the seeding is forced the same way the
   old oncoming shot forced it: warpSeed every poll (it is consumed per
   update) and, if the shared spawn budget is starved by the deck fleet,
   call the real spawner directly on an idle slot. */
await parkMtn(46, 0);
let got = false;
for (let i = 0; i < 60; i++) {
  await page.evaluate(() => {
    const g = window.__neonx;
    const tr = g.game.traffic;
    tr.warpSeed = true;
    const s2 = g.state();
    if (s2.npcsMtn === 0) {
      const idle = tr.npcs.find((n) =>
        !n.active && !n.rival && tr.ready[n.style] &&
        n.type !== "truck" && n.type !== "bus");
      if (idle) tr.trySpawnMountain(idle, g.game.car, 0, 1, 140);
    }
    return null;
  });
  /* frames are seconds apart here, so after a few polls stage the picture:
     take the real seeded pass car and put it in the turnout window, 26 m
     ahead — photography only; the sim suite owns the dynamics */
  if (i === 18) {
    await page.evaluate(() => {
      const g = window.__neonx;
      const tr = g.game.traffic;
      const mt = g.game.world.routes.mtn;
      const st = g.state();
      const me = mt.project(st.x, st.z, 12);
      if (!me) return;
      for (const n of tr.npcs) {
        if (!n.active || n.route !== 10) continue;
        n.s = Math.max(me.s + 26, 70);
        n.v = 3;
        break;
      }
    });
  }
  const d = await page.evaluate(() => {
    const g = window.__neonx.game;
    const st = window.__neonx.state();
    const mt = g.world.routes.mtn;
    const me = mt.project(st.x, st.z, 12);
    if (!me) return null;
    let best = null;
    for (const n of g.traffic.npcs) {
      if (!n.active || n.route !== 10) continue;
      const hit = mt.project(n.x, n.z, 12);
      if (!hit) continue;
      const ds = hit.s - me.s;
      if (ds > 4 && ds < 85 && (best === null || ds < best)) best = ds;
    }
    return best;
  });
  if (d !== null && d < 40) {
    got = true;
    console.log(`  pass car in the turnout at ${d.toFixed(1)} m — shooting`);
    await shoot("mountain-letby");
    break;
  }
  await sleep(900);
}
if (!got) {
  errors.push("no pass car ever appeared ahead — the one-way flow is not alive");
  await shoot("mountain-letby");
}
await sleep(1100);
await shoot("mountain-letby-2");

// the turnout itself, and the view a player who turned round gets
await parkMtn(74, 0);
await shoot("mountain-turnout");
await parkMtn(210, 0, -1);
await shoot("mountain-wrong-way");

// the ridge as seen from the expressway below
await page.evaluate(() => {
  window.__neonx.toCorridor(-1840, 15, 2);
  window.__neonx.setInput({ th: 0.15, br: 0, st: 0, hb: 0, horn: 0 });
});
await sleep(1700);
await shoot("mountain-ridge-from-deck");

const errCount = await page.evaluate(() => window.__neonx.state().errors?.length ?? 0);
console.log(`  page errors: ${errCount}`);
if (errCount) errors.push(`the page logged ${errCount} runtime error(s)`);

await browser.close();
if (errors.length) {
  console.log("\n❌ ERRORS:");
  for (const e of errors.slice(0, 20)) console.log("  -", String(e).slice(0, 400));
  process.exit(1);
}
console.log("✅ mountain drive-through clean, shots captured");
