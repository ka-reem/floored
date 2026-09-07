/* One phone boot, both halves of the evidence a mobile change needs.

   Booting this game under SwiftShader on a shared four-core box takes the
   better part of ten minutes. Measuring a change therefore used to cost two
   of those — one for test/perf-mobile.mjs and one for test/look-mobile.mjs —
   and a lane that wants BEFORE, CONTROL and AFTER pays it six times. This
   does both in a single session:

     1. the LOOK sheet: the frozen frame from look-mobile.mjs (fleet hidden,
        car stopped, sim paused, performance.now and Date pinned so the film
        grain, the blink phases and the burnt-in DVR stamp are constants),
        captured for every shipping camera at every place. POV first — it is
        the default and the frame to judge in.
     2. the COST: frame time, renderer.info, and the two numbers that survive
        having no GPU — renderer.render() CALLS PER FRAME and the PIXELS
        those calls cover.

   Look first, cost second, because the freeze is destructive (it stops the
   sim) and thawing back to a driving frame is the cheaper direction.

   Run it three times to judge a change honestly: twice on the unchanged
   build (BEFORE and CONTROL — the second one is the renderer's own noise
   floor, which is what a delta has to beat to mean anything) and once after.

   SwiftShader caveat, unchanged from perf-probe.mjs: no GPU here, so
   milliseconds are not a phone's milliseconds. Ratios and pass/pixel counts
   are what carry.

   Usage:
     node test/mobile-ab.mjs --url http://localhost:3701 --tier mobile-base \
       --label before --shots /tmp/x/before --out /tmp/x/before.json
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3701");
const TIER = arg("--tier", "mobile-base");
const LABEL = arg("--label", "before");
const SHOTS = arg("--shots", `/tmp/lane-mobile/shots/${LABEL}`);
const OUT = arg("--out", `/tmp/lane-mobile/shots/${LABEL}.json`);
const FRAMES = Number(arg("--frames", 45));
const SKIP_LOOK = process.argv.includes("--no-look");
const SKIP_PERF = process.argv.includes("--no-perf");
const SKIP_CENSUS = process.argv.includes("--no-census");
/* Optional second capture of every look shot, into its own directory — see
   the note at the capture site. */
const CTL = arg("--ctl", "");

/* POV first: default view, and the frame the owner judges in. */
const CAMS = [["pov", 3], ["chase", 0], ["cockpit", 1], ["hood", 2], ["console", 4]];
const PLACES = [["open", 400], ["town", 2400]];
/* The cost side is the slow half — a frame here costs seconds, so 45 of them
   per row is minutes. Every camera is priced on the open deck (that is where
   the views differ: the mirror pass only runs from inside the car, the POV
   degrade only in POV), and only the default view is priced again in town,
   which is the heaviest place the corridor has. */
const PERF_ROWS = [["open", 400, CAMS], ["town", 2400, [["pov", 3]]]];

const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });
if (CTL) mkdirSync(CTL, { recursive: true });
mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
  protocolTimeout: 590000,
});
const page = await browser.newPage();
await page.setViewport(PHONE);
await page.setUserAgent(UA);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 300000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });

/* Pin the reactive perf fallback OFF, first thing.

   engine.perfCheck() latches `perfMode` after four seconds of frames slower
   than 37 ms, and then forces devicePixelRatio to 1, rebuilds every render
   target at the perf sizes and drops a bloom iteration. On a phone that is
   the safety net doing its job. On THIS box, where a frame takes a second
   and a half because there is no GPU, it fires every single run, part way
   through, and everything measured after it is the fallback path rather
   than the path a phone actually runs — a before/after where the two runs
   latched at different moments is not a measurement of anything.

   Worse for the look sheet: a run that latches between two screenshots
   changes the render resolution mid-sheet, so the frames are not comparable
   with each other, never mind with another run's.

   So: neuter the check (an own property shadows the prototype method the
   engine calls), and if it already latched during the staged load, put the
   renderer back — clearing lastPR is what makes applySettings rebuild the
   targets and restore the tier's pixel ratio rather than no-op. */
const latchedDuringLoad = await page.evaluate(() => {
  const g = window.__neonx.game;
  g.perfCheck = () => {};
  const was = !!g.perfMode;
  if (was) {
    g.perfMode = false;
    g.lastPR = -1;
    g.applySettings(g.settings);
  }
  return was;
});
if (latchedDuringLoad) console.log("note: perf mode had latched during load; reset");
await sleep(10000);
await page.evaluate(() => window.__neonx.setTime(22.0));
await sleep(2000);

const env = await page.evaluate(() => {
  const g = window.__neonx.game, r = g.renderer;
  return {
    dpr: devicePixelRatio, pixelRatio: r.getPixelRatio(),
    canvas: [r.domElement.width, r.domElement.height],
    css: [innerWidth, innerHeight],
    tier: g.tierCaps?.tier ?? null, dprCap: g.tierCaps?.dprCap ?? null,
    shadowsSetting: !!g.settings?.shadows, sunCastShadow: !!g.sun?.castShadow,
    shadowMap: g.sun?.shadow ? [g.sun.shadow.mapSize.x, g.sun.shadow.mapSize.y] : null,
    mirrorRT: [g.post?.mirrorRT?.width, g.post?.mirrorRT?.height],
    sceneRT: [g.post?.sceneRT?.width, g.post?.sceneRT?.height,
      g.post?.sceneRT?.samples ?? null],
    mem: { ...r.info.memory },
    programs: r.info.programs?.length ?? null,
    perfMode: !!g.perfMode,
  };
});
console.log("env", JSON.stringify(env));

/* ---- 1. the cost ----

   Measured BEFORE the look sheet, deliberately. The renderer process on this
   box does occasionally die part way through a long run, and when it does,
   whatever came first is what survives — so the numbers go first and the
   pictures, which are cheap to re-take, go last. */
const rows = [];
if (!SKIP_PERF) {
  await page.evaluate(() => {
    const g = window.__neonx.game, r = g.renderer;
    if (r.__mobWrapped) return;
    const orig = r.render.bind(r);
    r.render = (...a) => {
      const rt = r.getRenderTarget();
      const w = rt ? rt.width : r.domElement.width;
      const h = rt ? rt.height : r.domElement.height;
      const st = g.__mobStat;
      if (st) {
        st.calls++; st.px += w * h;
        const k = `${w}x${h}`;
        st.byTarget[k] = (st.byTarget[k] || 0) + 1;
      }
      orig(...a);
      const i = r.info.render, p = g.__mobPeak;
      if (!p || i.calls > p.calls) g.__mobPeak = { calls: i.calls, triangles: i.triangles };
    };
    r.__mobWrapped = true;
  });

  /* Every camera gets a cost row too, not just the default: the mirror pass
     only runs from inside the car, and the POV degrade only in POV, so the
     views have genuinely different budgets and a change can help one and
     hurt another. */
  outer:
  for (const [pname, z, cams] of PERF_ROWS) {
    for (const [cname, ci] of cams) {
     try {
      await page.evaluate((a) => {
        const nx = window.__neonx, g = nx.game;
        nx.setCam(a.ci);
        g.__mobPeak = null;
        nx.toCorridor(a.z, 90, 1);
        nx.setInput({ th: 0.35 });
      }, { z, ci });
      await sleep(2500);
      await page.evaluate(() => {
        window.__neonx.game.__mobStat = { calls: 0, px: 0, byTarget: {}, frames: 0 };
      });
      const CHUNK = 15, dtAll = [];
      for (let got = 0; got < FRAMES; got += CHUNK) {
        const part = await page.evaluate(async (n) => {
          const dt = [];
          await new Promise((resolve) => {
            let last = -1, i = 0;
            const tick = (t) => {
              if (last >= 0) { dt.push(t - last); window.__neonx.game.__mobStat.frames++; }
              last = t;
              if (++i > n) return resolve();
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          return dt;
        }, Math.min(CHUNK, FRAMES - got));
        dtAll.push(...part);
      }
      const r = await page.evaluate((dt) => {
        const g = window.__neonx.game, st = g.__mobStat, info = g.__mobPeak ?? null;
        dt = dt.slice().sort((a, b) => a - b);
        const at = (q) => dt[Math.min(dt.length - 1, Math.floor(dt.length * q))];
        return {
          med: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2),
          max: +dt[dt.length - 1].toFixed(2),
          calls: info?.calls ?? null, tris: info?.triangles ?? null,
          programs: g.renderer?.info?.programs?.length ?? null,
          textures: g.renderer?.info?.memory?.textures ?? null,
          geometries: g.renderer?.info?.memory?.geometries ?? null,
          passesPerFrame: st.frames ? +(st.calls / st.frames).toFixed(2) : null,
          mpxPerFrame: st.frames ? +(st.px / st.frames / 1e6).toFixed(4) : null,
          targets: st.byTarget, frames: dt.length,
        };
      }, dtAll);
      r.place = pname; r.cam = cname; r.z = z;
      rows.push(r);
      console.log(`${pname}/${cname}`.padEnd(15),
        `med ${String(r.med).padStart(8)}`, `p95 ${String(r.p95).padStart(8)}`,
        `calls ${String(r.calls).padStart(4)}`,
        `passes ${String(r.passesPerFrame).padStart(6)}`,
        `Mpx/f ${String(r.mpxPerFrame).padStart(8)}`);
      writeFileSync(OUT, JSON.stringify({ label: LABEL, tier: TIER, env, frames: FRAMES, rows }, null, 2));
     } catch (e) {
       console.log("LOST THE TAB during", pname, cname, String(e.message || e).slice(0, 120));
       break outer;
     }
    }
  }
}
/* ---- 2. scene census: what the draw calls and triangles are actually FOR ----

   Not estimated — measured with three's own culling. The scene is rendered
   once with everything on to get the totals, then once per top-level child
   with that child hidden; the drop in renderer.info.render is exactly what
   that subtree was submitting. Costs one extra frame per node, which on this
   box is seconds, and answers "931k triangles of WHAT" without a guess in it. */
if (!SKIP_CENSUS) try {
  await page.evaluate(() => {
    window.__neonx.setCam(3);
    window.__neonx.toCorridor(400, 90, 1);
    window.__neonx.setInput({ th: 0.35 });
  });
  await sleep(2500);
  const census = await page.evaluate(() => {
    const g = window.__neonx.game, r = g.renderer, cam = g.camera;
    cam.updateMatrixWorld();
    const draw = () => {
      r.setRenderTarget(g.post.sceneRT);
      r.render(g.scene, cam);
      r.setRenderTarget(null);
      return { calls: r.info.render.calls, tris: r.info.render.triangles };
    };
    const full = draw();
    const out = [];
    for (const top of g.scene.children) {
      if (!top.visible) continue;
      top.visible = false;
      const off = draw();
      top.visible = true;
      /* Almost nothing in this scene is named, so a bare `top.name ||
         top.type` census prints thirty rows of "Mesh" and identifies
         nothing. Fall back through the things the world builders DO set —
         the material's name, the geometry's — and record whether the node
         opted out of frustum culling, because a full-loop merge with
         culling off submits its whole 4 km of triangles from anywhere on
         the lap and that is the interesting case. */
      const first = top.isMesh || top.isPoints ? top : (() => {
        let f = null;
        top.traverse((o) => { if (!f && (o.isMesh || o.isPoints)) f = o; });
        return f;
      })();
      const m = first && (Array.isArray(first.material) ? first.material[0] : first.material);
      let kids = 0;
      top.traverse(() => kids++);
      out.push({
        node: top.name || top.type,
        mat: m?.name || m?.type || null,
        geo: first?.geometry?.name || null,
        kids,
        culled: first ? first.frustumCulled !== false : null,
        points: !!first?.isPoints,
        calls: full.calls - off.calls,
        tris: full.tris - off.tris,
      });
    }
    return { full, nodes: out.sort((a, b) => b.tris - a.tris) };
  });
  console.log(`\nscene census (POV, open deck): total ${census.full.calls} calls, ${census.full.tris} tris`);
  for (const n of census.nodes)
    console.log(
      `  ${String(n.node).padEnd(10)} ${String(n.mat ?? "-").padEnd(22)}` +
      ` ${String(n.calls).padStart(4)} calls ${String(n.tris).padStart(8)} tris` +
      ` ${n.culled ? "culled" : "NOCULL"}${n.points ? " points" : ""} kids ${n.kids}`);
  writeFileSync(OUT.replace(/\.json$/, "-census.json"), JSON.stringify(census, null, 2));
} catch (e) {
  console.log("census skipped:", String(e.message || e).slice(0, 120));
}

/* ---- 3. the look sheet ---- */
const freeze = () => page.evaluate(() => {
  const g = window.__neonx.game, t = g.traffic, p = g.post;
  for (const s of t.styles) s.mesh.visible = false;
  t.wheelInst.visible = false; t.poolInst.visible = false;
  for (const c of t.cloudList) c.pts.visible = false;
  g.car.u = 0; g.car.v = 0; g.car.r = 0;
  g.running = false;
  const keep = new Set();
  for (let e = document.querySelector("canvas.game"); e; e = e.parentElement) keep.add(e);
  for (const e of document.body.querySelectorAll("*")) if (!keep.has(e)) e.style.visibility = "hidden";
  if (!window.__realNow) window.__realNow = performance.now.bind(performance);
  const T = 3000000;
  performance.now = () => T;
  const RD = window.__RealDate || (window.__RealDate = Date);
  const FIXED = 1767225600000;
  window.Date = function (...a) { return a.length ? new RD(...a) : new RD(FIXED); };
  window.Date.now = () => FIXED;
  p.overAt = -999;
  p.updateOverlay(T / 1000);
});
const thaw = () => page.evaluate(() => {
  const g = window.__neonx.game, t = g.traffic;
  for (const s of t.styles) s.mesh.visible = true;
  t.wheelInst.visible = true; t.poolInst.visible = true;
  for (const c of t.cloudList) c.pts.visible = true;
  for (const e of document.body.querySelectorAll("*")) e.style.visibility = "";
  performance.now = window.__realNow;
  window.Date = window.__RealDate;
  g.running = true;
});

if (!SKIP_LOOK) {
  let tabAlive = true;
  for (const [pname, z] of PLACES) {
    if (!tabAlive) break;
    for (const [cname, ci] of CAMS) {
      await page.evaluate((a) => {
        window.__neonx.setCam(a.ci);
        window.__neonx.toCorridor(a.z, 0, 1);
        window.__neonx.setInput({ th: 0 });
      }, { z, ci });
      await sleep(5000);
      await page.evaluate((a) => {
        window.__neonx.toCorridor(a.z, 0, 1);
        window.__neonx.setInput({ th: 0 });
      }, { z });
      await sleep(2500);
      try {
        await freeze();
        await sleep(2500); // the POV frame blend settles to a fixed point
        await page.screenshot({ path: path.join(SHOTS, `${LABEL}-${pname}-${cname}.png`),
          captureBeyondViewport: false, optimizeForSpeed: true });
        /* The CONTROL, taken here rather than from a second run: the same
           frozen frame, shot again a couple of seconds later with nothing
           touched in between. Whatever it differs by is the renderer's own
           noise — the floor a before/after delta has to clear before it
           counts as a visible change. A separate boot would be a stronger
           control still, but it is also ten minutes and a different set of
           compiled programs; this one is free and it is the same conditions. */
        if (CTL) {
          await sleep(2000);
          await page.screenshot({ path: path.join(CTL, `${LABEL}-${pname}-${cname}.png`),
            captureBeyondViewport: false, optimizeForSpeed: true });
        }
        await thaw();
        console.log("shot", pname, cname);
      } catch (e) {
        /* A SwiftShader tab that has lost its renderer process throws here and
           will throw for everything after it. Say which shot died and stop —
           the cost numbers and the census are already on disk. */
        console.log("LOST THE TAB at", pname, cname, String(e.message || e).slice(0, 120));
        tabAlive = false;
        break;
      }
    }
  }
}

writeFileSync(OUT, JSON.stringify({ label: LABEL, tier: TIER, env, frames: FRAMES, rows }, null, 2));
console.log("wrote", OUT, "and", SHOTS);
await browser.close();
if (errors.length) { console.log("PAGE ERRORS:"); for (const e of errors.slice(0, 5)) console.log(" -", e.slice(0, 200)); }
