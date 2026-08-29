/* Headless proof that the head unit's view switching works end-to-end for
   ALL panes — map ↔ music ↔ trip ↔ games — and that a whole game of
   tic-tac-toe can be played through the panel, with real synthetic pointer
   events on the canvas rather than direct method calls.

   Why the paranoia about the full event path: the owner reported clicks on
   the panel's MAP pill not switching views. Every hop is exercised here the
   way a mouse does it — pointermove for hover, pointerdown for the click,
   the engine's own raycast, hitScreen's uv → rect mapping, the view flip,
   and the repaint — so a regression anywhere in that chain fails this test
   rather than waiting for the owner to click on it.

   The panel is aimed at through the engine's own ray: findClient() scans
   client space for the point whose panel-hit uv lands closest to the target
   uv, using game.aimRayAt + clickRay (TS `private` is erased at runtime —
   the same __neonx.game access every other test here uses). That makes the
   test camera- and mesh-agnostic: it holds for the procedural tablet and
   for a donor cabin's own screen mesh alike, at whatever angle the dashcam
   leaves them.

   Usage: node test/console-clicks.mjs [--url http://localhost:3117] */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const ART = path.join(process.cwd(), "test", "artifacts");
mkdirSync(ART, { recursive: true });

const argUrl = process.argv.indexOf("--url");
const externalUrl = argUrl > -1 ? process.argv[argUrl + 1] : null;
const PORT = 3117;
const URL = externalUrl || `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** the spawned dev server, for the failure-path cleanup below */
let devChild = null;

async function startDev() {
  if (externalUrl) return null;
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    detached: true,
  });
  devChild = child;
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

let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log("  OK   " + name);
  else {
    fail++;
    console.log("  FAIL " + name + (detail ? "  (" + detail + ")" : ""));
  }
};

/* The head unit's logical space (carscreen.ts). Rect centres below are the
   layout constants from carscreen.ts/consolegame.ts — if those move, move
   these; the test clicking where the art no longer is IS the failure. */
const W = 256, H = 160;
const uvOf = (x, y) => ({ u: x / W, v: 1 - y / H });
const PILL_MUSIC = uvOf(256 - 34 + 13, 6 + 8);
const PILL_TRIP = uvOf(256 - 66 + 13, 6 + 8);
const PILL_GAME = uvOf(256 - 98 + 13, 6 + 8);
const BACK = uvOf(8 + 27, 7 + 9);
const AGAIN = uvOf(140 + 53, 122 + 12);
const cellUV = (i) => uvOf(16 + (i % 3) * 37 + 17, 38 + ((i / 3) | 0) * 37 + 17);

/** Find the client-space point whose panel hit lands closest to (u,v), via
    the engine's own raycast. Coarse pass finds the panel's screen footprint,
    fine pass dials the uv in; ~1px precision on a ~200px panel image. */
async function findClient(page, u, v) {
  return page.evaluate(
    ({ u, v }) => {
      const g = window.__neonx.game;
      const panel = g.screenTarget();
      if (!panel) return { err: "no panel target (touch or music disabled?)" };
      const r = g.renderer.domElement.getBoundingClientRect();
      let best = null, bd = 1e9;
      const probe = (cx, cy) => {
        g.aimRayAt(cx, cy);
        const hit = g.clickRay.intersectObject(panel, false)[0];
        if (!hit || !hit.uv) return false;
        const d = (hit.uv.x - u) ** 2 + (hit.uv.y - v) ** 2;
        if (d < bd) { bd = d; best = { cx, cy, u: hit.uv.x, v: hit.uv.y }; }
        return true;
      };
      // coarse: find the panel's on-screen bbox
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, any = false;
      for (let cy = r.top + 4; cy < r.bottom; cy += 10)
        for (let cx = r.left + 4; cx < r.right; cx += 10)
          if (probe(cx, cy)) {
            any = true;
            x0 = Math.min(x0, cx); x1 = Math.max(x1, cx);
            y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
          }
      if (!any) return { err: "panel never hit by the scan" };
      // fine: 1px inside the bbox (padded a step for the coarse quantisation)
      for (let cy = y0 - 10; cy <= y1 + 10; cy += 1)
        for (let cx = x0 - 10; cx <= x1 + 10; cx += 1) probe(cx, cy);
      return { ...best, du: best.u - u, dv: best.v - v, box: [x0, y0, x1, y1] };
    },
    { u, v }
  );
}

async function clickUV(page, name, uv) {
  const pt = await findClient(page, uv.u, uv.v);
  if (pt.err) {
    check(`${name}: aim`, false, pt.err);
    return null;
  }
  const close = Math.abs(pt.du) < 0.02 && Math.abs(pt.dv) < 0.02;
  if (!close) {
    /* The uv target sits off the panel's reachable surface — that is a
       layout/visibility failure worth naming, not a silent misclick. */
    check(`${name}: uv reachable`, false, `du=${pt.du.toFixed(3)} dv=${pt.dv.toFixed(3)}`);
    return null;
  }
  await page.mouse.move(pt.cx, pt.cy);
  await sleep(120); // a hover frame, so the highlight path runs too
  await page.mouse.down();
  await page.mouse.up();
  await sleep(160); // let the gauge-cadence repaint catch up
  return pt;
}

const view = (page) => page.evaluate(() => window.__neonx.game.screenView);
const hover = (page) => page.evaluate(() => window.__neonx.game.screenHover);
const ttt = (page) =>
  page.evaluate(() => {
    const t = window.__ttt;
    return { board: [...t.board], turn: t.turn, outcome: t.outcome, tally: { ...t.tally } };
  });

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
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));

  console.log("→ loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });

  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
    b?.click();
  });
  await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 180000 });
  await sleep(2500);

  /* The dashcam (POV) is the shipped frame and the default camera; hold the
     car still so the CPU opponent's think timer runs (it pauses over a
     walking pace, and the spawn leaves the car parked — braked for safety). */
  await page.evaluate(() => window.__neonx.setInput({ th: 0, br: 1 }));
  const setup = await page.evaluate(() => ({
    cam: window.__neonx.game.camMode,
    donor: !!window.__neonx.game.rig?.cockpitModel,
    view: window.__neonx.game.screenView,
    speed: Math.abs(window.__neonx.game.car?.u ?? 0),
  }));
  console.log("  setup:", JSON.stringify(setup));
  check("starts on the map view", setup.view === "map");

  /* ---- view switching, every pane, there and back ---------------------- */
  let pt = await clickUV(page, "map→music (dead space)", uvOf(70, 100));
  if (pt) check("map→music (dead space)", (await view(page)) === "music", `view=${await view(page)}`);
  await page.screenshot({ path: path.join(ART, "console-music.png") });

  pt = await clickUV(page, "music→map (‹ MAP pill)", BACK);
  if (pt) check("music→map (‹ MAP pill)", (await view(page)) === "map", `view=${await view(page)}`);

  pt = await clickUV(page, "map→trip (TRIP pill)", PILL_TRIP);
  if (pt) check("map→trip (TRIP pill)", (await view(page)) === "trip", `view=${await view(page)}`);

  pt = await clickUV(page, "trip→map (‹ MAP pill)", BACK);
  if (pt) check("trip→map (‹ MAP pill)", (await view(page)) === "map", `view=${await view(page)}`);

  pt = await clickUV(page, "map→music (♪ pill)", PILL_MUSIC);
  if (pt) check("map→music (♪ pill)", (await view(page)) === "music", `view=${await view(page)}`);
  await clickUV(page, "music→map again", BACK);

  /* hover: the highlight must point at what a click would do */
  const hp = await findClient(page, PILL_GAME.u, PILL_GAME.v);
  if (!hp.err) {
    await page.mouse.move(hp.cx, hp.cy);
    await sleep(150);
    check("games pill hover reads 'game'", (await hover(page)) === "game", `hover=${await hover(page)}`);
  }

  pt = await clickUV(page, "map→games (grid pill)", PILL_GAME);
  if (pt) check("map→games (grid pill)", (await view(page)) === "game", `view=${await view(page)}`);
  await page.screenshot({ path: path.join(ART, "console-games-empty.png") });

  pt = await clickUV(page, "games→map (‹ MAP pill)", BACK);
  if (pt) check("games→map (‹ MAP pill)", (await view(page)) === "map", `view=${await view(page)}`);
  await clickUV(page, "back into games", PILL_GAME);

  /* ---- a full game of tic-tac-toe via synthetic clicks ------------------ */
  const t0 = await ttt(page);
  check("board starts clean", t0.board.every((c) => c === 0) && t0.outcome === 0);
  const tallySum = (t) => t.tally.w + t.tally.l + t.tally.d;
  const sum0 = tallySum(t0);

  let moves = 0, shotMid = false;
  for (let round = 0; round < 12; round++) {
    let t = await ttt(page);
    if (t.outcome !== 0) break;
    if (t.turn === 1) {
      const empty = t.board.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0);
      // centre first if free, else first empty — enough to sometimes win
      const target = t.board[4] === 0 ? 4 : empty[0];
      const before = t.board[target];
      await clickUV(page, `place X in cell ${target}`, cellUV(target));
      t = await ttt(page);
      check(`X landed in cell ${target}`, before === 0 && t.board[target] === 1,
        `board=${t.board.join("")}`);
      if (t.board[target] !== 1) break;
      moves++;
      if (!shotMid && moves === 2) {
        shotMid = true;
        await page.screenshot({ path: path.join(ART, "console-games-mid.png") });
      }
    } else {
      /* CPU's turn: its think timer only runs while the pane is drawn and
         the car is slow — both true here — so the move lands inside ~1s. */
      const landed = await page
        .waitForFunction(
          () => window.__ttt.turn === 1 || window.__ttt.outcome !== 0,
          { timeout: 8000 }
        )
        .then(() => true)
        .catch(() => false);
      check("CPU answered within 8s", landed);
      if (!landed) break;
    }
  }
  const t1 = await ttt(page);
  check("game reached a result", t1.outcome !== 0, `outcome=${t1.outcome}`);
  check("tally recorded exactly one result", tallySum(t1) === sum0 + 1,
    `${sum0} → ${tallySum(t1)}`);
  console.log(
    `  result: ${["in play", "player win", "cpu win", "draw"][t1.outcome]},` +
    ` tally W-L-D ${t1.tally.w}-${t1.tally.l}-${t1.tally.d}, board ${t1.board.join("")}`
  );
  await page.screenshot({ path: path.join(ART, "console-games-over.png") });

  /* ---- rematch ---------------------------------------------------------- */
  pt = await clickUV(page, "NEW GAME tap", AGAIN);
  if (pt) {
    const t2 = await ttt(page);
    check("rematch clears the board", t2.board.every((c) => c === 0) && t2.outcome === 0,
      `board=${t2.board.join("")} outcome=${t2.outcome}`);
    check("rematch keeps the tally", tallySum(t2) === sum0 + 1);
  }

  /* ---- tally persistence through the profile ----------------------------
     GameApp's persist() runs on resume, so pause (Escape) → RESUME writes
     the profile the way real play does; then read the tally off disk. */
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  await sleep(400);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "RESUME");
    b?.click();
  });
  await sleep(400);
  const saved = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("neonx.profile.v3"))?.ttt ?? null; }
    catch { return null; }
  });
  check("tally persisted to the profile", !!saved && tallySum({ tally: saved }) === sum0 + 1,
    JSON.stringify(saved));

  check("no page errors", errors.length === 0, errors[0]);

  await browser.close();
  if (dev) {
    try { process.kill(-dev.pid, "SIGTERM"); } catch {}
  }
  console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL OK");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  /* Take the detached dev server down with us — a dev process left holding
     the port turns the next run's failure into EADDRINUSE noise. */
  if (devChild) try { process.kill(-devChild.pid, "SIGTERM"); } catch {}
  process.exit(1);
});
