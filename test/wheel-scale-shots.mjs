/* One question, and nothing else: with the POV held exactly where it is, what
   does a LARGER wheel look like?

   One boot, one camera, N wheel scales. Cameras are NOT touched. The cluster is
   NOT touched — not its size, not its seat. The only variable is axisG.scale,
   the donor wheel's own size, applied about its fitted hub so the rim grows and
   the wheel's inner opening grows with it.

   Deliberately does NOT rasterise an occlusion buffer the way
   wheel-cluster-measure.mjs does. That buffer is the whole cost of the other
   instrument (a depth pass per region per camera per steering angle) and this
   box cannot afford it; what comes back instead is the handful of projected
   landmarks the reference photograph is actually about, which cost a few
   hundred point projections:

     D          the wheel's projected outer diameter  = the normalising length
     D/frameW   the reference's "the wheel dominates the picture" (target 0.63)
     dials/D    the two main dials together           (target 0.52)
     binnacle/D the whole cluster housing             (target 0.73)
     rimAbove/D the rim's top arc ABOVE the cluster's top edge (target 0.13)
     boss-dialBot/D  the airbag boss against the bottom of the dials (target 0)

   plus the two heights that decide whether it is readable at all — the digital
   speed and a dial numeral — projected off the cluster's own raked plane. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "./node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { debugUrl } from "./lib/debug-url.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL = arg("--url", "http://localhost:3146");
const OUT = arg("--out", process.cwd());
const VW = Number(arg("--w", 1440)), VH = Number(arg("--h", 900));
const TIER = arg("--tier", "desktop");
const KMH = Number(arg("--kmh", 0));
const CAM = arg("--cam", "COCKPIT");
const SCALES = arg("--scales", "1.00,1.30,1.60").split(",").map(Number);
const TAG = arg("--tag", "shot");
mkdirSync(OUT, { recursive: true });
const CAM_ID = { CHASE: 0, COCKPIT: 1, HOOD: 2, DASHCAM: 3, CONSOLE: 4 }[CAM];

const browser = await puppeteer.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
    "--renderer-process-limit=1", "--js-flags=--max-old-space-size=512"],
  defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 },
  protocolTimeout: 1800000,
});
const page = await browser.newPage();
await page.goto(debugUrl(URL, { tier: TIER }), { waitUntil: "domcontentloaded", timeout: 600000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 600000 });
await page.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"))?.click());
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 900000 });
await page.waitForFunction(() => !!window.__neonx?.game?.rig?.cockpitModel, { timeout: 600000 }).catch(() => {});

const frames = (n = 4) => page.evaluate((k) => new Promise((res) => {
  let i = 0; const step = () => (++i >= k ? res(null) : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

await page.evaluate((kmh) => {
  window.__neonx.toCorridor(-1300, kmh, 1);
  window.__neonx.setInput({ th: kmh > 0 ? 0.45 : 0, br: 0, st: 0 });
}, KMH);
await frames(10);
await page.evaluate((id) => window.__neonx.setCam(id), CAM_ID);
await frames(8);
await page.evaluate(() => { window.__baseScale = window.__neonx.game.rig.cockpit.wheelGroup.parent.scale.x; });

/* Landmarks only — see the header for why there is no depth buffer here. */
const MEASURE = function (opts) {
  const g = window.__neonx.game, cp = g.rig.cockpit, cam = g.camera;
  const W = opts.W, H = opts.H;
  const V3 = cp.group.position.constructor;
  cam.updateMatrixWorld(true); cp.group.updateMatrixWorld(true);
  const mvp = new (cam.projectionMatrix.constructor)()
    .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const mvi = cam.matrixWorldInverse;
  const camPos = new V3().setFromMatrixPosition(cam.matrixWorld);
  const project = (p) => {
    const v = p.clone().applyMatrix4(mvp), q = p.clone().applyMatrix4(mvi);
    return { x: (v.x * 0.5 + 0.5) * W, y: (1 - (v.y * 0.5 + 0.5)) * H, d: p.distanceTo(camPos), vz: q.z };
  };
  const front = (s) => s.vz < -1e-4;

  /* fit the rim circle to the wheel meshes actually on screen — the RENDERED
     radius, after every scale the code stacks on the donor */
  const wheelG = cp.wheelGroup;
  wheelG.updateMatrixWorld(true);
  const pts = [];
  wheelG.traverseVisible((o) => {
    const a = o.geometry?.getAttribute?.("position");
    if (!a || !o.isMesh) return;
    const step = Math.max(1, Math.floor(a.count / 4000));
    for (let i = 0; i < a.count; i += step)
      pts.push(new V3(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(o.matrixWorld));
  });
  const hubW = new V3().setFromMatrixPosition(wheelG.matrixWorld);
  const e = wheelG.matrixWorld.elements;
  const axis = new V3(e[8], e[9], e[10]).normalize();
  const u = new V3().crossVectors(axis, Math.abs(axis.z) < 0.9 ? new V3(0, 0, 1) : new V3(1, 0, 0)).normalize();
  const wv = new V3().crossVectors(axis, u);
  const BINS = 144, ring = [], d = new V3();
  for (const p of pts) {
    d.subVectors(p, hubW);
    const qx = d.dot(u), qy = d.dot(wv), r = Math.hypot(qx, qy);
    const b = Math.floor(((Math.atan2(qy, qx) + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
    if (!(ring[b] >= r)) ring[b] = r;
  }
  const s = ring.filter(Number.isFinite).sort((a, b) => a - b);
  const rOuter = s[s.length >> 1];

  let rimTopY = Infinity, rimX0 = Infinity, rimX1 = -Infinity, bossTopY = Infinity, rimNear = Infinity;
  for (const p of pts) {
    d.subVectors(p, hubW);
    const r = Math.hypot(d.dot(u), d.dot(wv));
    const sc = project(p);
    if (!front(sc)) continue;
    if (r > rOuter * 0.9) {
      if (sc.y < rimTopY) rimTopY = sc.y;
      if (sc.x < rimX0) rimX0 = sc.x;
      if (sc.x > rimX1) rimX1 = sc.x;
      if (sc.d < rimNear) rimNear = sc.d;
    }
    if (r < rOuter * 0.5 && sc.y < bossTopY) bossTopY = sc.y;
  }
  const D = rimX1 - rimX0;

  const cg = cp.clusterGroup;
  cg.updateMatrixWorld(true);
  const L = (x, y, z) => new V3(x, y, z).applyMatrix4(cg.matrixWorld);
  const rectBox = (hx, hy, z) => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i <= 48; i++) {
      const t = -1 + (2 * i) / 48;
      for (const q of [[hx * t, -hy], [hx * t, hy], [-hx, hy * t], [hx, hy * t]]) {
        const sc = project(L(q[0], q[1], z));
        if (!front(sc)) continue;
        if (sc.x < x0) x0 = sc.x; if (sc.x > x1) x1 = sc.x;
        if (sc.y < y0) y0 = sc.y; if (sc.y > y1) y1 = sc.y;
      }
    }
    return { x0: +x0.toFixed(1), x1: +x1.toFixed(1), y0: +y0.toFixed(1), y1: +y1.toFixed(1), w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1) };
  };
  /* dashboard.ts: dials r RD at local x -+0.15; housing is the one big Box */
  let RD = 0.1, SW = 0.52, SH = 0.22;
  cg.traverse((o) => {
    const pr = o.geometry?.parameters;
    if (!o.isMesh || !pr) return;
    if (pr.radius && pr.segments === 64) RD = pr.radius;
    if (pr.width && pr.height && pr.depth && pr.width > 0.3) { SW = pr.width; SH = pr.height; }
  });
  const dials = rectBox(0.15 + RD, RD, 0.002);
  const shell = rectBox(SW / 2, SH / 2, 0);
  const pxPerM = (lx) => Math.abs(project(L(lx, 0.02, 0.002)).y - project(L(lx, -0.02, 0.002)).y) / 0.04;
  const r3 = (n) => +n.toFixed(3);
  return {
    D: +D.toFixed(1), frameW: W, frameH: H,
    rimOuterR_m: +rOuter.toFixed(5), rimDiam_mm: +(rOuter * 2000).toFixed(1),
    wheelD_frameW: r3(D / W),
    dials_D: r3(dials.w / D),
    binnacle_D: r3(shell.w / D),
    binnacleH_D: r3(shell.h / D),
    rimAbove_D: r3((shell.y0 - rimTopY) / D),
    bossVsDialBot_D: r3((bossTopY - dials.y1) / D),
    speedDigitPx: +(((62 / 232) * 0.19) * pxPerM(0)).toFixed(1),
    dialNumeralPx: +((0.094 * 2 * RD) * pxPerM(0.15)).toFixed(1),
    rimNearM: +rimNear.toFixed(4), camNear: cam.near, rimClipped: rimNear < cam.near,
    dials, shell, rimTopY: +rimTopY.toFixed(1), bossTopY: +bossTopY.toFixed(1),
  };
};

const out = {};
for (const sc of SCALES) {
  await page.evaluate((k) => {
    const ax = window.__neonx.game.rig.cockpit.wheelGroup.parent;
    ax.scale.setScalar(window.__baseScale * k);
    ax.updateMatrixWorld(true);
  }, sc);
  await frames(6);
  const file = path.join(OUT, `${TAG}-${CAM}-${sc.toFixed(2)}.png`);
  await page.screenshot({ path: file });
  const m = await page.evaluate(MEASURE, { W: VW, H: VH });
  out[sc.toFixed(2)] = m;
  console.log(`${CAM} x${sc.toFixed(2)}  rim ${m.rimDiam_mm}mm  D ${m.D}px  ` +
    `D/frame ${m.wheelD_frameW}  dials/D ${m.dials_D}  binnacle/D ${m.binnacle_D}  ` +
    `rimAbove/D ${m.rimAbove_D}  boss-dialBot/D ${m.bossVsDialBot_D}  ` +
    `| spdDigit ${m.speedDigitPx}px  dialNum ${m.dialNumeralPx}px  ` +
    `near ${m.rimNearM}/${m.camNear}${m.rimClipped ? " CLIPPED" : ""}  -> ${path.basename(file)}`);
  writeFileSync(path.join(OUT, `${TAG}-${CAM}-ratios.json`), JSON.stringify(out, null, 1));
}
await browser.close();
console.log("done ->", OUT);
