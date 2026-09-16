/* How much of the instrument cluster does the steering wheel cover?

     node test/wheel-cluster-measure.mjs --url http://localhost:3143 \
       --out /abs/dir --tier desktop --w 1440 --h 900 --tag d1440

   Two things come out of one boot:

   1. GEOMETRY, in cockpit-local metres — the frame every constant in
      cockpit.ts / cockpitmodel.ts / engine.ts is written in. The rim circle is
      FITTED to the wheel meshes actually on screen (the outer-contour scan
      cockpitmodel.ts's fitWheelPivot uses, run in world space), so the radius
      is the RENDERED one, after every scale the code stacks on the donor — not
      the authored one. Divide by the scales it also reports to recover what
      the donor asset holds.

   2. OCCLUSION, per camera and per steering angle, by RASTERISING both the
      wheel and the cluster into a screen-space depth buffer inside the page:
      every visible wheel triangle is projected through the live camera and
      filled with depth, then the cluster's readable faces (the two dial discs,
      the info panel, and the digital speed's own digit box) are filled the
      same way and counted against it. A face pixel is HIDDEN when a wheel
      pixel sits in front of it.

      Pixel-DIFFING two renders was the first cut of this and it does not work
      here: the dashcam's degrade (post.ts) re-grades the whole frame off its
      own auto-gain and lays time-keyed sensor noise over it, so hiding one
      object changes every pixel in the image. Rasterising the geometry
      answers the same question and is immune to the grade — and it costs one
      render instead of six.

   The masks come back out as a PNG overlay per view, composited onto the
   shipping frame: RED = readable face the wheel covers, GREEN = face in the
   clear. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import sharp from "./node_modules/sharp/dist/index.mjs";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3143");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts"));
const TIER = arg("--tier", "desktop");
const VW = Number(arg("--w", 1440)), VH = Number(arg("--h", 900));
const TAG = arg("--tag", `${VW}x${VH}`);
const KMH = Number(arg("--kmh", 0));
/* Measure at several speeds in ONE boot. All three in-car mounts are rigid, so
   the occlusion does not move with speed — but the needles and the digits do,
   and "measured at rest and at speed" is cheap once the page is up. Outputs are
   tagged `${TAG}-${kmh}`. */
const SPEEDS = arg("--speeds", "").split(",").map(Number).filter((n) => !Number.isNaN(n));
const MOBILE = process.argv.includes("--mobile");
/* Prototype deltas, applied to the LIVE scene graph before measuring so an
   option can be costed without editing a constant: --wheel-dy moves the donor
   steering pivot (cockpitmodel.ts's `axisG.position.y -= 0.028`), --cluster-dy
   moves the live gauge cluster (its `clusterGroup.position.copy(clusterAt)`),
   --wheel-scale rescales the rim about that same pivot (`axisG.scale`), and
   --cluster-scale resizes the gauge cluster about its own centre
   (`clusterGroup.scale`) — the lever for fitting it to the donor binnacle. */
const WHEEL_DY = Number(arg("--wheel-dy", 0));
const CLUSTER_DY = Number(arg("--cluster-dy", 0));
const WHEEL_SCALE = Number(arg("--wheel-scale", 1));
const CLUSTER_SCALE = Number(arg("--cluster-scale", 1));
/* --sweep costs SEVERAL prototypes in ONE page boot, which is the whole
   expense here: booting the game under SwiftShader takes minutes, the
   rasterisation takes seconds. Format: semicolon-separated combos of
   "wheelDy,clusterScale,clusterDy[,wheelScale][:label]", e.g.
     --sweep "0,1,0:ship ; 0.042,0.62,-0.035:candidate"
   Each combo is applied to a scene graph reset to its boot state first, so
   the combos do not accumulate. */
const SWEEP = arg("--sweep", "");
/* Which cameras and which steering angles a run pays for. The full set is the
   default; a wide sweep wants `--cams DASHCAM,COCKPIT --angles 0` and then one
   narrow run at full lock on the step it picks, because the rasterisation is
   per camera per angle and it is the whole cost of the instrument. */
const ONLY_CAMS = arg("--cams", "");
const SWEEP_ANGLES = arg("--angles", "0,163,-163").split(",").map(Number);
mkdirSync(OUT, { recursive: true });

const CAMS = [
  { id: 3, name: "DASHCAM" },
  { id: 1, name: "COCKPIT" },
  { id: 4, name: "CONSOLE" },
].filter((c) => !ONLY_CAMS || ONLY_CAMS.split(",").includes(c.name));

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    /* One renderer and a small JS heap. This box runs several headless lanes
       inside ONE memory cgroup, and a SwiftShader renderer at 1440 x 900 is
       the biggest single thing in it — the run before this one was OOM-killed
       outright ("Target closed") when a sibling lane spiked. Nothing here
       changes what is rendered. */
    "--renderer-process-limit=1", "--js-flags=--max-old-space-size=512",
  ],
  defaultViewport: {
    width: VW, height: VH, deviceScaleFactor: 1,
    isMobile: MOBILE, hasTouch: MOBILE,
  },
  protocolTimeout: 1800000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));

await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 600000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 600000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 900000 });
const donor = await page.waitForFunction(() => !!window.__neonx?.game?.rig?.cockpitModel, { timeout: 600000 })
  .then(() => true).catch(() => false);
if (!donor) console.log("WARNING: no donor cabin — this is the procedural fallback");

/** wait n RENDERED frames — SwiftShader takes seconds per frame, clocks lie */
const frames = (n = 4) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const step = () => (++i >= k ? res(null) : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

const drive = async (kmh) => {
  await page.evaluate((k) => {
    window.__neonx.toCorridor(-1300, k, 1);
    window.__neonx.setInput({ th: k > 0 ? 0.45 : 0, br: 0, st: 0 });
  }, kmh);
  await frames(10);
};
await drive(KMH);

if (WHEEL_DY || CLUSTER_DY || WHEEL_SCALE !== 1 || CLUSTER_SCALE !== 1) {
  const applied = await page.evaluate((d) => {
    const cp = window.__neonx.game.rig.cockpit;
    const axisG = cp.wheelGroup.parent;
    /* axisG lives in the donor scene, which counter-scales y/z by the cabin
       width fit — so a metre asked for here is a metre in donor space, the
       same space cockpitmodel.ts's constant is written in. */
    if (d.wdy) axisG.position.y += d.wdy;
    if (d.ws !== 1) axisG.scale.multiplyScalar(d.ws);
    if (d.cs !== 1) cp.clusterGroup.scale.multiplyScalar(d.cs);
    if (d.cdy) cp.clusterGroup.position.y += d.cdy;
    axisG.updateMatrixWorld(true);
    cp.clusterGroup.updateMatrixWorld(true);
    return { axisG: axisG.name, y: axisG.position.y, s: axisG.scale.x, cy: cp.clusterGroup.position.y, cs: cp.clusterGroup.scale.x };
  }, { wdy: WHEEL_DY, cdy: CLUSTER_DY, ws: WHEEL_SCALE, cs: CLUSTER_SCALE });
  console.log("PROTOTYPE", JSON.stringify(applied));
  await frames(4);
}

/* ------------------------------------------------------------- in page -- */

const PAGE_FN = function (opts) {
  const g = window.__neonx.game;
  const cp = g.rig.cockpit;
  const cam = g.camera;
  const W = opts.W, H = opts.H;
  const V3 = cp.group.position.constructor;
  cam.updateMatrixWorld(true);
  cp.group.updateMatrixWorld(true);

  /* ---- projection: world -> CSS pixels + view depth ---- */
  const mvp = new (cam.projectionMatrix.constructor)()
    .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const camPos = new V3().setFromMatrixPosition(cam.matrixWorld);
  /* `d` is a DISTANCE to the lens, so it is never negative and the `d <= 0`
     tests that used to guard the rasteriser could not fire. A triangle BEHIND
     the lens still divides by a negative w, wraps to the far side of the
     frame and then fills its whole clamped bbox — which is both a false
     occlusion and, at 1440 x 900, most of the measurement's running time.
     `vz` is view-space z (negative in front), which is the real test. */
  const mvi = cam.matrixWorldInverse;
  const project = (p) => {
    const v = p.clone().applyMatrix4(mvp); // Vector3.applyMatrix4 divides by w
    const q = p.clone().applyMatrix4(mvi);
    return { x: (v.x * 0.5 + 0.5) * W, y: (1 - (v.y * 0.5 + 0.5)) * H, d: p.distanceTo(camPos), vz: q.z };
  };
  const inFront = (s) => s.vz < -1e-4;

  /* ---- depth rasteriser ---- */
  const raster = () => ({ d: new Float32Array(W * H).fill(Infinity), n: 0 });
  const tri = (buf, a, b, c) => {
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    if (x1 < x0 || y1 < y0) return;
    const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(det) < 1e-9) return;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / det;
        const w1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * a.d + w1 * b.d + w2 * c.d;
        const i = y * W + x;
        if (d < buf.d[i]) { buf.d[i] = d; buf.n++; }
      }
    }
  };
  /** every visible triangle under `root`, projected and filled */
  const rasterObject = (root, buf) => {
    root.updateMatrixWorld(true);
    root.traverseVisible((o) => {
      const geo = o.geometry;
      if (!geo || !o.isMesh) return;
      const pos = geo.getAttribute("position");
      if (!pos) return;
      const idx = geo.index;
      const n = idx ? idx.count : pos.count;
      const p = new V3(), scr = [];
      for (let i = 0; i < pos.count; i++) {
        p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
        scr.push(project(p));
      }
      for (let i = 0; i < n; i += 3) {
        const a = scr[idx ? idx.getX(i) : i], b = scr[idx ? idx.getX(i + 1) : i + 1], c = scr[idx ? idx.getX(i + 2) : i + 2];
        if (!a || !b || !c || !inFront(a) || !inFront(b) || !inFront(c)) continue;
        tri(buf, a, b, c);
      }
    });
  };

  /* ---- the readable faces of the cluster, as their own geometry ----
     Taken from dashboard.ts's own numbers rather than from the meshes, so a
     dial's face and the digit box inside the info panel can be counted
     separately: dials r 0.1 at local x -+0.15, info plane 0.145 x 0.19, and
     the digital speed's digits at logical (88, 100) of a 176 x 232 panel. */
  const cg = cp.clusterGroup;
  cg.updateMatrixWorld(true);
  const L = (x, y, z) => new V3(x, y, z).applyMatrix4(cg.matrixWorld);
  const IW = 176, IH = 232, PW = 0.145, PH = 0.19;
  /* the housing box, read off the live mesh rather than hard-coded, so the
     instrument keeps measuring the right rectangle after the cluster is
     resized. dashboard.ts builds it as the one BoxGeometry in clusterGroup. */
  let SHELL_W = 0.52, SHELL_H = 0.22;
  cg.traverse((o) => {
    const pr = o.geometry?.parameters;
    if (o.isMesh && pr && pr.width && pr.height && pr.depth && pr.width > 0.3) { SHELL_W = pr.width; SHELL_H = pr.height; }
  });
  const panel = (lx, ly, w, h, z) => {
    // logical-panel coords (origin top-left) -> cluster-local metres
    const cx = (lx / IW - 0.5) * PW, cy = (0.5 - ly / IH) * PH;
    return { cx, cy, w: (w / IW) * PW, h: (h / IH) * PH, z };
  };
  const rectTris = (r) => {
    const a = L(r.cx - r.w / 2, r.cy - r.h / 2, r.z), b = L(r.cx + r.w / 2, r.cy - r.h / 2, r.z);
    const c = L(r.cx + r.w / 2, r.cy + r.h / 2, r.z), d = L(r.cx - r.w / 2, r.cy + r.h / 2, r.z);
    return [[a, b, c], [a, c, d]];
  };
  const discTris = (x, r, z) => {
    const out = [], N = 96, mid = L(x, 0, z);
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      out.push([mid, L(x + r * Math.cos(a0), r * Math.sin(a0), z), L(x + r * Math.cos(a1), r * Math.sin(a1), z)]);
    }
    return out;
  };
  const REGIONS = {
    tacho: discTris(-0.15, 0.1, 0.002),
    speedo: discTris(0.15, 0.1, 0.002),
    info: rectTris(panel(88, 116, 164, 216, 0.004)),
    /* the digit box dashboard.ts actually draws: 80px face, "300" wide */
    speedDigits: rectTris(panel(88, 100, 142, 80, 0.005)),
    gearDigit: rectTris(panel(88, 164, 44, 40, 0.005)),
    /* the housing's own face — NOT in FACE, so it does not move the "face
       hidden" number; it exists so the cluster's top and bottom EDGE have a
       measured screen box to compare the rim arc against. */
    shellFace: rectTris({ cx: 0, cy: 0, w: SHELL_W, h: SHELL_H, z: 0.0 }),
  };
  const FACE = ["tacho", "speedo", "info"];
  /* The info panel sliced into 16 rows of its own logical y, so the answer to
     "which rows of the readout are safe in THIS view" is a measurement rather
     than a guess off the rim-top sightline. Row i covers logical y
     8 + i*13.5 .. 8 + (i+1)*13.5 (the panel's drawn area is y 8..224). */
  const ROWS = 16, ROW_H = 216 / ROWS;
  if (opts.rows) for (let i = 0; i < ROWS; i++)
    REGIONS[`row${String(i).padStart(2, "0")}`] = rectTris(panel(88, 8 + (i + 0.5) * ROW_H, 164, ROW_H, 0.005));

  /* ---- measure, at each steering angle ---- */
  const wheelG = cp.wheelGroup;
  const z0 = wheelG.rotation.z;
  let overlayCv = null, overlayShell = null;
  const out = { angles: {} };
  for (const deg of opts.angles) {
    wheelG.rotation.z = (deg * Math.PI) / 180;
    const wheel = raster();
    rasterObject(wheelG, wheel);
    const per = {}, all = { px: 0, hidden: 0 };
    const maskHidden = new Uint8Array(W * H), maskFace = new Uint8Array(W * H);
    for (const [name, tris] of Object.entries(REGIONS)) {
      const buf = raster();
      for (const t of tris) tri(buf, project(t[0]), project(t[1]), project(t[2]));
      let px = 0, hid = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1, hy0 = 1e9;
      for (let i = 0; i < buf.d.length; i++) {
        if (!Number.isFinite(buf.d[i])) continue;
        px++;
        const x = i % W, y = (i / W) | 0;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        const covered = wheel.d[i] < buf.d[i] - 0.002;
        if (covered) { hid++; if (y < hy0) hy0 = y; }
        if (FACE.includes(name)) {
          maskFace[i] = 1;
          if (covered) maskHidden[i] = 1;
        }
      }
      per[name] = {
        px, hidden: hid, frac: px ? hid / px : 0,
        box: bx1 < 0 ? null : { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 },
        topOfCoverY: hid ? hy0 : null,
      };
    }
    for (let i = 0; i < maskFace.length; i++) { if (maskFace[i]) { all.px++; if (maskHidden[i]) all.hidden++; } }
    all.frac = all.px ? all.hidden / all.px : 0;
    out.angles[deg] = { regions: per, face: all };

    if (deg === opts.overlayAngle) {
      overlayCv = document.createElement("canvas");
      overlayCv.width = W; overlayCv.height = H;
      const ctx = overlayCv.getContext("2d");
      const img = ctx.createImageData(W, H);
      for (let i = 0; i < maskFace.length; i++) {
        if (!maskFace[i]) continue;
        const o = i * 4;
        if (maskHidden[i]) { img.data[o] = 255; img.data[o + 1] = 30; img.data[o + 2] = 80; img.data[o + 3] = 170; }
        else { img.data[o] = 40; img.data[o + 1] = 255; img.data[o + 2] = 120; img.data[o + 3] = 90; }
      }
      ctx.putImageData(img, 0, 0);
      overlayShell = per.shellFace.box;
    }
  }
  wheelG.rotation.z = z0;
  wheelG.updateMatrixWorld(true);

  /* ---- geometry report ---- */
  const toLocal = (p) => cp.group.worldToLocal(p.clone());
  const pts = [];
  wheelG.traverseVisible((o) => {
    const a = o.geometry?.getAttribute?.("position");
    if (!a || !o.isMesh) return;
    const step = Math.max(1, Math.floor(a.count / 5000));
    for (let i = 0; i < a.count; i += step)
      pts.push(new V3(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(o.matrixWorld));
  });
  const hubW = new V3().setFromMatrixPosition(wheelG.matrixWorld);
  const e = wheelG.matrixWorld.elements;
  const axis = new V3(e[8], e[9], e[10]).normalize();
  const u = new V3().crossVectors(axis, Math.abs(axis.z) < 0.9 ? new V3(0, 0, 1) : new V3(1, 0, 0)).normalize();
  const wv = new V3().crossVectors(axis, u);
  const BINS = 144, ring = [], inner = [];
  const d = new V3();
  const bin = (qx, qy) => Math.floor(((Math.atan2(qy, qx) + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
  for (const p of pts) {
    d.subVectors(p, hubW);
    const qx = d.dot(u), qy = d.dot(wv), r = Math.hypot(qx, qy), b = bin(qx, qy);
    if (!(ring[b] >= r)) ring[b] = r;
  }
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s[s.length >> 1]; };
  const rOuter = med(ring);
  for (const p of pts) {
    d.subVectors(p, hubW);
    const qx = d.dot(u), qy = d.dot(wv), r = Math.hypot(qx, qy);
    if (r > rOuter * 0.62) { const b = bin(qx, qy); if (!(inner[b] <= r)) inner[b] = r; }
  }
  const rInner = med(inner);
  const box = { min: null, max: null };
  for (const p of pts) {
    if (!box.min) { box.min = p.clone(); box.max = p.clone(); }
    box.min.min(p); box.max.max(p);
  }
  // the highest point of the rim, and where the eye->rim-top ray lands
  let top = null;
  for (const p of pts) {
    d.subVectors(p, hubW);
    const r = Math.hypot(d.dot(u), d.dot(wv));
    if (r > rOuter * 0.9 && (!top || p.y > top.y)) top = p.clone();
  }
  /* ---- FRAMING LANDMARKS, in screen pixels -------------------------------
     The occlusion numbers above answer "is it covered". They cannot answer
     the real question, which is about ARRANGEMENT: in a real car
     the binnacle is read THROUGH the wheel's upper opening — the rim's top
     arc passes ABOVE the top of the cluster and the hub/spoke boss sits
     BELOW the dials. That is a statement about where three horizontal lines
     land in the projected image, so it is measured here in screen pixels and
     normalised by the wheel's own projected outer diameter, which makes the
     ratios independent of focal length and of frame size.

     rimTopY   the highest pixel of the rim's outer ring (r > 0.9 rOuter)
     bossTopY  the highest pixel of the hub/spoke boss (r < 0.5 rOuter)
     rimW      the rim's projected outer width  = the normalising diameter D
     Plus the same three lines for the DONOR's own OEM cluster and its
     binnacle glass, projected through this very camera, so "the real car's
     proportions" is a measurement off the scanned car rather than a guess. */
  let rimTopY = Infinity, bossTopY = Infinity, rimX0 = Infinity, rimX1 = -Infinity, rimBotY = -Infinity;
  for (const p of pts) {
    d.subVectors(p, hubW);
    const r = Math.hypot(d.dot(u), d.dot(wv));
    const s = project(p);
    if (!inFront(s)) continue;
    if (r > rOuter * 0.9) {
      if (s.y < rimTopY) rimTopY = s.y;
      if (s.y > rimBotY) rimBotY = s.y;
      if (s.x < rimX0) rimX0 = s.x;
      if (s.x > rimX1) rimX1 = s.x;
    }
    if (r < rOuter * 0.5 && bossTopY > s.y) bossTopY = s.y;
  }
  /** screen bbox of every vertex under `root`, visible or not */
  const screenBox = (root) => {
    if (!root) return null;
    root.updateMatrixWorld(true);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    const q = new V3();
    root.traverse((o) => {
      const a = o.geometry?.getAttribute?.("position");
      if (!a || !o.isMesh) return;
      for (let i = 0; i < a.count; i++) {
        q.set(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(o.matrixWorld);
        const s = project(q);
        if (!inFront(s)) continue;
        n++;
        if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
        if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y;
      }
    });
    return n ? { x0: +x0.toFixed(1), y0: +y0.toFixed(1), x1: +x1.toFixed(1), y1: +y1.toFixed(1), w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1) } : null;
  };
  const donorScene0 = g.rig.cockpitModel?.group ?? null;
  const find = (nm) => donorScene0?.getObjectByName?.(nm) ?? null;
  const landmarks = {
    rimTopY: +rimTopY.toFixed(1), rimBotY: +rimBotY.toFixed(1),
    bossTopY: +bossTopY.toFixed(1),
    rimW: +(rimX1 - rimX0).toFixed(1), rimX0: +rimX0.toFixed(1), rimX1: +rimX1.toFixed(1),
    ourCluster: screenBox(cg),
    donorCluster: screenBox(find("cluster_0")),
    donorGlass: screenBox(find("clusterGlass_0")),
    donorColumn: screenBox(find("column_0")),
  };

  /* ---- REFERENCE-PHOTO ratios --------------------------------------------
     The reference is a photograph of a BMW 3-series driver's-eye view. A
     photograph is measured in pixels, so these are pixels — the landmarks above, normalised
     by the wheel's own projected outer diameter D, plus the two the landmarks
     did not carry: the DIALS' span (the reference calls out the two main
     dials separately from the whole binnacle, which on that car has small
     outboard gauges) and the wheel's share of the FRAME, which is the ratio
     that says "the wheel dominates the picture".

       wheelD/frameW  0.63    dials/D  0.52    binnacle/D  0.73
       rimAbove/D     0.13    boss top level with the bottom of the dials

     LEGIBILITY comes out here too, because "bigger wheel" and "readable
     cluster" are the two halves of the goal and only one of them is an
     occlusion number. Both heights are projected off the cluster's own raked
     plane rather than divided out of a distance, so the 26-degree rake and
     the yaw are in the answer: the digital speed is drawn 62/232 of a 0.19 m
     panel, a dial numeral numSize (0.094) of a 1024 canvas mapped to the
     0.2 m dial. */
  const rectBox = (hx, hy, z) => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i <= 48; i++) {
      const t = -1 + (2 * i) / 48;
      for (const q of [[hx * t, -hy], [hx * t, hy], [-hx, hy * t], [hx, hy * t]]) {
        const sc = project(L(q[0], q[1], z));
        if (!inFront(sc)) continue;
        if (sc.x < x0) x0 = sc.x; if (sc.x > x1) x1 = sc.x;
        if (sc.y < y0) y0 = sc.y; if (sc.y > y1) y1 = sc.y;
      }
    }
    return { x0: +x0.toFixed(1), x1: +x1.toFixed(1), y0: +y0.toFixed(1), y1: +y1.toFixed(1), w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1) };
  };
  /* dashboard.ts: two dials of radius RD at local x -+0.15, so the pair spans
     2*(0.15+RD). Read RD off the live dial mesh so a resized cluster still
     measures its own dials. */
  let RD = 0.1;
  cg.traverse((o) => {
    const pr = o.geometry?.parameters;
    if (o.isMesh && pr && pr.radius && pr.segments === 64) RD = pr.radius;
  });
  const dialsBox = rectBox(0.15 + RD, RD, 0.002);
  /* near-plane safety: the closest the rim's outer ring comes to the lens */
  let rimNear = Infinity;
  for (const p2 of pts) {
    d.subVectors(p2, hubW);
    if (Math.hypot(d.dot(u), d.dot(wv)) > rOuter * 0.9) {
      const sc = project(p2);
      if (sc.d < rimNear) rimNear = sc.d;
    }
  }
  const pxPerM = (lx) => Math.abs(project(L(lx, 0.02, 0.002)).y - project(L(lx, -0.02, 0.002)).y) / 0.04;
  const D = rimX1 - rimX0;
  const shellBox = out.angles[0]?.regions?.shellFace?.box ?? null;
  const ratios = {
    D: +D.toFixed(1), frameW: W, frameH: H,
    wheelD_frameW: +(D / W).toFixed(3),
    dials_D: +(dialsBox.w / D).toFixed(3),
    binnacle_D: shellBox ? +(shellBox.w / D).toFixed(3) : null,
    binnacleH_D: shellBox ? +(shellBox.h / D).toFixed(3) : null,
    rimAbove_D: shellBox ? +((shellBox.y - rimTopY) / D).toFixed(3) : null,
    bossVsDialBot_D: +((bossTopY - dialsBox.y1) / D).toFixed(3),
    dialsBox, shellBox,
    rimNearM: +rimNear.toFixed(4), camNear: cam.near, rimClipped: rimNear < cam.near,
    legible: {
      /* pxPerM already carries clusterGroup.scale (it projects through
         cg.matrixWorld), so both heights are stated in the cluster's own
         local units and the scale is not applied twice. */
      speedDigitPx: +(((62 / 232) * 0.19) * pxPerM(0)).toFixed(1),
      dialNumeralPx: +((0.094 * 2 * RD) * pxPerM(0.15)).toFixed(1),
    },
  };

  /* Mark the three lines the framing argument is ABOUT, so a frame can be
     read without the numbers: yellow = the rim's top arc, cyan = the
     cluster's top and bottom edge, magenta = the top of the hub/spoke boss.
     Drawn after the landmarks exist, onto the mask overlay built above. */
  if (overlayCv) {
    const ctx = overlayCv.getContext("2d");
    const line = (y, col, label) => {
      if (!Number.isFinite(y)) return;
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([10, 6]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.font = "bold 15px monospace";
      ctx.fillText(label, 12, y - 5);
    };
    line(landmarks.rimTopY, "#ffe14d", "rim top arc");
    if (overlayShell) {
      line(overlayShell.y, "#54e6ff", "cluster top edge");
      line(overlayShell.y + overlayShell.h, "#54e6ff", "cluster bottom edge");
    }
    line(landmarks.bossTopY, "#ff6cf0", "hub / spoke top");
    out.overlay = overlayCv.toDataURL("image/png");
  }

  const A = (v) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
  const donorScene = g.rig.cockpitModel?.group ?? null;
  const axisG = donorScene?.getObjectByName?.("donorSteeringAxis") ?? null;
  return {
    donor: !!g.rig.cockpitModel,
    view: { W, H, fov: cam.fov, aspect: cam.aspect, camMode: g.camMode },
    camLocal: A(toLocal(camPos)), camWorldY: +camPos.y.toFixed(4),
    scales: {
      cockpitGroup: A(cp.group.scale), cockpitGroupPos: A(cp.group.position),
      donorScene: donorScene ? A(donorScene.scale) : null,
      axisG: axisG ? { pos: A(axisG.position), scale: A(axisG.scale) } : null,
    },
    wheel: {
      rimOuterR: +rOuter.toFixed(5), rimInnerR: +rInner.toFixed(5),
      hubLocal: A(toLocal(hubW)), rimTopLocal: top ? A(toLocal(top)) : null,
      bboxLocal: [A(toLocal(box.min)), A(toLocal(box.max))],
      verts: pts.length,
    },
    cluster: {
      centreLocal: A(toLocal(new V3().setFromMatrixPosition(cg.matrixWorld))),
      topLocal: A(toLocal(L(0, 0.11, 0))), botLocal: A(toLocal(L(0, -0.11, 0))),
      speedoLocal: A(toLocal(L(0.15, 0, 0))),
      digitsLocal: A(toLocal(L(0, 0.0131, 0))),
      scale: A(cg.scale),
    },
    landmarks,
    ratios,
    ...out,
  };
};

const ANGLES = [0, 90, -90, 163, -163];

if (SWEEP) {
  /* Remember the boot state so each combo starts from the same graph. */
  await page.evaluate(() => {
    const cp = window.__neonx.game.rig.cockpit;
    window.__base = {
      ay: cp.wheelGroup.parent.position.y, as: cp.wheelGroup.parent.scale.x,
      cy: cp.clusterGroup.position.y, cs: cp.clusterGroup.scale.x,
    };
  });
  const combos = SWEEP.split(";").map((t) => t.trim()).filter(Boolean).map((t) => {
    const [nums, label] = t.split(":");
    const f = nums.split(",");
    /* cdy may be given per camera as POV/COCKPIT/CONSOLE, because the cluster's
       seat is per view now — one number cannot restore two different seats. */
    const cdy = String(f[2] ?? "0").split("/").map(Number);
    return {
      wdy: Number(f[0]) || 0, cs: Number(f[1]) || 1,
      cdy: cdy.length > 1 ? cdy : [cdy[0] || 0, cdy[0] || 0, cdy[0] || 0],
      ws: Number(f[3]) || 1, art: Number(f[4]) || 0,
      /* COCKPIT eye depth. engine.ts already exposes cockpitEye() as the live
         knob `window.__cockpitEye`, so moving the driver's head forward costs
         a combo field rather than an edit-and-rebuild — the same trick the
         wheel and cluster deltas use. Blank = leave it where it ships. */
      edz: f[5] === undefined || f[5] === "" ? null : Number(f[5]),
      label: label || nums,
    };
  });
  /* The combo is applied AFTER setCam, not before: cockpitmodel.ts seats the
     cluster per view now, and engine.ts pushes that seat on the camera-change
     edge — so anything written before the switch is overwritten by it. The
     wheel is written per combo as an absolute off __base; the cluster is
     nudged off whatever seat the live framing just chose. */
  for (const c of combos) {
    await page.evaluate((d) => {
      const cp = window.__neonx.game.rig.cockpit, ax = cp.wheelGroup.parent, b = window.__base;
      ax.position.y = b.ay + d.wdy;
      ax.scale.setScalar(b.as * d.ws);
      ax.updateMatrixWorld(true);
      if (d.edz !== null && window.__cockpitEye) window.__cockpitEye.dz = d.edz;
    }, c);
    await frames(3);
    for (let ci = 0; ci < CAMS.length; ci++) {
      const cam = CAMS[ci];
      await page.evaluate((id) => window.__neonx.setCam(id), cam.id);
      await frames(4);
      await page.evaluate((d) => {
        const cp = window.__neonx.game.rig.cockpit;
        cp.clusterGroup.position.y += d.cdy[d.ci];
        cp.clusterGroup.scale.multiplyScalar(d.cs);
        cp.clusterGroup.updateMatrixWorld(true);
        /* Dial-face art is a separate axis from the cluster's SIZE: a smaller
           cluster drawn with the same numerals is not the same as one drawn
           for its new size. __cluster.s + repaint() is dashboard.ts's own
           live-tuning hook, so a candidate face can be costed here too. */
        const k = window.__cluster;
        if (k) {
          const A = d.art
            ? { numSize: 0.108, numW: "600", numInset: 0.125 }
            : { numSize: 0.094, numW: "400", numInset: 0.155 };
          Object.assign(k.s, A);
          k.repaint();
        }
      }, { ...c, ci });
      await frames(2);
      await page.screenshot({ path: path.join(OUT, `${TAG}-${c.label.replace(/[^\w.-]/g, "_")}-${cam.name}.png`) });
      const r = await page.evaluate(PAGE_FN, { W: VW, H: VH, angles: SWEEP_ANGLES, rows: false });
      const lm = r.landmarks, D = lm.rimW, sf = r.angles["0"].regions.shellFace.box;
      const sp = r.angles["0"].regions.speedo.box;
      const pc = (n, a) => (r.angles[a] ? (r.angles[a].regions[n].frac * 100).toFixed(0) : "-");
      /* rimTop->top POSITIVE = the real-car arrangement: the rim's top arc
         passes above the cluster's top edge. bossTop->dialBot POSITIVE = the
         hub/spoke boss sits below the dial faces. */
      const rt = r.ratios;
      console.log(`${c.label.padEnd(22)} ${cam.name.padEnd(8)} REF  D/frame ${rt.wheelD_frameW}  dials/D ${rt.dials_D}  ` +
        `binnacle/D ${rt.binnacle_D}  binH/D ${rt.binnacleH_D}  rimAbove/D ${rt.rimAbove_D}  boss-dialBot/D ${rt.bossVsDialBot_D}  ` +
        `| D ${rt.D}px  spdDigit ${rt.legible.speedDigitPx}px  dialNum ${rt.legible.dialNumeralPx}px  ` +
        `rimNear ${rt.rimNearM}m/near ${rt.camNear}${rt.rimClipped ? " *NEAR-CLIPPED*" : ""}`);
      console.log(`${c.label.padEnd(22)} ${cam.name.padEnd(8)} ` +
        `rim>top ${(((sf.y) - lm.rimTopY) / D).toFixed(3)}D  boss<dial ${((lm.bossTopY - (sp.y + sp.h)) / D).toFixed(3)}D  ` +
        `W ${(sf.w / D).toFixed(3)}D H ${(sf.h / D).toFixed(3)}D | ` +
        `face ${(r.angles["0"].face.frac * 100).toFixed(1)}%  spd ${pc("speedDigits", 0)}/${pc("speedDigits", 163)}/${pc("speedDigits", -163)}  ` +
        `speedo ${pc("speedo", 0)}/${pc("speedo", 163)}  tacho ${pc("tacho", 0)}/${pc("tacho", 163)}  gear ${pc("gearDigit", 0)}/${pc("gearDigit", 163)}  ` +
        `digits ${r.angles["0"].regions.speedDigits.box.w}x${r.angles["0"].regions.speedDigits.box.h}px`);
    }
    console.log("");
  }
  await browser.close();
  if (errors.length) { console.log("ERRORS:"); for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 240)); }
  process.exit(0);
}

const all = {};
for (const kmh of SPEEDS.length ? SPEEDS : [KMH]) {
if (SPEEDS.length) { await drive(kmh); }
const TAGK = SPEEDS.length ? `${TAG}-${kmh}` : TAG;
for (const cam of CAMS) {
  await page.evaluate((id) => window.__neonx.setCam(id), cam.id);
  await frames(8);
  await page.screenshot({ path: path.join(OUT, `${TAGK}-${cam.name}.png`) });
  const r = await page.evaluate(PAGE_FN, { W: VW, H: VH, angles: ANGLES, overlayAngle: 0, rows: true });
  const overlay = r.overlay;
  delete r.overlay;
  all[cam.name] = r;
  if (overlay) {
    await sharp(path.join(OUT, `${TAGK}-${cam.name}.png`))
      .composite([{ input: Buffer.from(overlay.split(",")[1], "base64"), blend: "over" }])
      .toFile(path.join(OUT, `${TAGK}-${cam.name}-occlusion.png`));
  }
  const f = r.angles["0"];
  console.log(`${TAGK} ${cam.name.padEnd(8)} rows ` +
    Object.entries(f.regions).filter(([k]) => k.startsWith("row"))
      .map(([, v]) => (v.frac > 0.5 ? "#" : v.frac > 0.1 ? "+" : ".")).join(""));
  const lm = r.landmarks, D = lm.rimW;
  const sf = f.regions.shellFace.box, sp = f.regions.speedo.box;
  /* + = the real-car arrangement (rim arc clears the cluster top / boss sits
     below the dials); - = our old compromise, inverted. */
  console.log(`${TAGK} ${cam.name.padEnd(8)} FRAME D ${D}px  rimTop->clusterTop ${(((sf.y) - lm.rimTopY) / D).toFixed(3)}D` +
    `  bossTop->dialBottom ${(((sf ? 0 : 0) + lm.bossTopY - (sp.y + sp.h)) / D).toFixed(3)}D` +
    `  clusterW ${(sf.w / D).toFixed(3)}D  clusterH ${(sf.h / D).toFixed(3)}D` +
    (lm.donorCluster ? `   [donor OEM  W ${(lm.donorCluster.w / D).toFixed(3)}D  H ${(lm.donorCluster.h / D).toFixed(3)}D  top->${((lm.donorCluster.y0 - lm.rimTopY) / D).toFixed(3)}D]` : ""));
  console.log(`${TAGK} ${cam.name.padEnd(8)} face ${(f.face.frac * 100).toFixed(1)}% hidden  ` +
    Object.entries(f.regions).filter(([k]) => !k.startsWith("row"))
      .map(([k, v]) => `${k} ${(v.frac * 100).toFixed(0)}%`).join("  ") +
    `   lock163 ${(r.angles["163"].face.frac * 100).toFixed(1)}% / -163 ${(r.angles["-163"].face.frac * 100).toFixed(1)}%`);
}
console.log(JSON.stringify(all.DASHCAM.wheel), JSON.stringify(all.DASHCAM.scales), JSON.stringify(all.DASHCAM.cluster));
writeFileSync(path.join(OUT, `${TAGK}-measure.json`), JSON.stringify(all, null, 1));
}
await browser.close();
if (errors.length) { console.log("ERRORS:"); for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 240)); }
console.log("done ->", OUT);
