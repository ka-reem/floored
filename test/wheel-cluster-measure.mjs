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
const MOBILE = process.argv.includes("--mobile");
/* Prototype deltas, applied to the LIVE scene graph before measuring so an
   option can be costed without editing a constant: --wheel-dy moves the donor
   steering pivot (cockpitmodel.ts's `axisG.position.y -= 0.028`), --cluster-dy
   moves the live gauge cluster (its `clusterGroup.position.copy(clusterAt)`),
   --wheel-scale rescales the rim about that same pivot (`axisG.scale`). */
const WHEEL_DY = Number(arg("--wheel-dy", 0));
const CLUSTER_DY = Number(arg("--cluster-dy", 0));
const WHEEL_SCALE = Number(arg("--wheel-scale", 1));
mkdirSync(OUT, { recursive: true });

const CAMS = [
  { id: 3, name: "DASHCAM" },
  { id: 1, name: "COCKPIT" },
  { id: 4, name: "CONSOLE" },
];

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: {
    width: VW, height: VH, deviceScaleFactor: 1,
    isMobile: MOBILE, hasTouch: MOBILE,
  },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));

await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 180000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 300000 });
const donor = await page.waitForFunction(() => !!window.__neonx?.game?.rig?.cockpitModel, { timeout: 300000 })
  .then(() => true).catch(() => false);
if (!donor) console.log("WARNING: no donor cabin — this is the procedural fallback");

/** wait n RENDERED frames — SwiftShader takes seconds per frame, clocks lie */
const frames = (n = 4) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const step = () => (++i >= k ? res(null) : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

await page.evaluate((kmh) => {
  window.__neonx.toCorridor(-1300, kmh, 1);
  window.__neonx.setInput({ th: kmh > 0 ? 0.45 : 0, br: 0, st: 0 });
}, KMH);
await frames(10);

if (WHEEL_DY || CLUSTER_DY || WHEEL_SCALE !== 1) {
  const applied = await page.evaluate((d) => {
    const cp = window.__neonx.game.rig.cockpit;
    const axisG = cp.wheelGroup.parent;
    /* axisG lives in the donor scene, which counter-scales y/z by the cabin
       width fit — so a metre asked for here is a metre in donor space, the
       same space cockpitmodel.ts's constant is written in. */
    if (d.wdy) axisG.position.y += d.wdy;
    if (d.ws !== 1) axisG.scale.multiplyScalar(d.ws);
    if (d.cdy) cp.clusterGroup.position.y += d.cdy;
    axisG.updateMatrixWorld(true);
    cp.clusterGroup.updateMatrixWorld(true);
    return { axisG: axisG.name, y: axisG.position.y, s: axisG.scale.x, cy: cp.clusterGroup.position.y };
  }, { wdy: WHEEL_DY, cdy: CLUSTER_DY, ws: WHEEL_SCALE });
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
  const project = (p) => {
    const v = p.clone().applyMatrix4(mvp); // Vector3.applyMatrix4 divides by w
    return { x: (v.x * 0.5 + 0.5) * W, y: (1 - (v.y * 0.5 + 0.5)) * H, d: p.distanceTo(camPos) };
  };

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
        if (!a || !b || !c || a.d <= 0 || b.d <= 0 || c.d <= 0) continue;
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
    speedDigits: rectTris(panel(88, 100, 112, 62, 0.005)),
    gearDigit: rectTris(panel(88, 164, 44, 40, 0.005)),
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
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d");
      const img = ctx.createImageData(W, H);
      for (let i = 0; i < maskFace.length; i++) {
        if (!maskFace[i]) continue;
        const o = i * 4;
        if (maskHidden[i]) { img.data[o] = 255; img.data[o + 1] = 30; img.data[o + 2] = 80; img.data[o + 3] = 170; }
        else { img.data[o] = 40; img.data[o + 1] = 255; img.data[o + 2] = 120; img.data[o + 3] = 90; }
      }
      ctx.putImageData(img, 0, 0);
      out.overlay = cv.toDataURL("image/png");
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
    ...out,
  };
};

const ANGLES = [0, 90, -90, 163, -163];
const all = {};
for (const cam of CAMS) {
  await page.evaluate((id) => window.__neonx.setCam(id), cam.id);
  await frames(8);
  await page.screenshot({ path: path.join(OUT, `${TAG}-${cam.name}.png`) });
  const r = await page.evaluate(PAGE_FN, { W: VW, H: VH, angles: ANGLES, overlayAngle: 0, rows: true });
  const overlay = r.overlay;
  delete r.overlay;
  all[cam.name] = r;
  if (overlay) {
    await sharp(path.join(OUT, `${TAG}-${cam.name}.png`))
      .composite([{ input: Buffer.from(overlay.split(",")[1], "base64"), blend: "over" }])
      .toFile(path.join(OUT, `${TAG}-${cam.name}-occlusion.png`));
  }
  const f = r.angles["0"];
  console.log(`${cam.name.padEnd(8)} rows ` +
    Object.entries(f.regions).filter(([k]) => k.startsWith("row"))
      .map(([, v]) => (v.frac > 0.5 ? "#" : v.frac > 0.1 ? "+" : ".")).join(""));
  console.log(`${cam.name.padEnd(8)} face ${(f.face.frac * 100).toFixed(1)}% hidden  ` +
    Object.entries(f.regions).filter(([k]) => !k.startsWith("row"))
      .map(([k, v]) => `${k} ${(v.frac * 100).toFixed(0)}%`).join("  ") +
    `   lock163 ${(r.angles["163"].face.frac * 100).toFixed(1)}% / -163 ${(r.angles["-163"].face.frac * 100).toFixed(1)}%`);
}
console.log(JSON.stringify(all.DASHCAM.wheel), JSON.stringify(all.DASHCAM.scales), JSON.stringify(all.DASHCAM.cluster));
writeFileSync(path.join(OUT, `${TAG}-measure.json`), JSON.stringify(all, null, 1));
await browser.close();
if (errors.length) { console.log("ERRORS:"); for (const e of errors.slice(0, 8)) console.log(" -", e.slice(0, 240)); }
console.log("done ->", OUT);
