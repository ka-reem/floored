/* Steering-wheel hub-center acceptance check (dashcam view).

   Boots the game, parks on the corridor at night, and holds the steering at a
   sweep of angles (0, ±90°, full lock). At each angle it measures, from the
   LIVE scene graph, the 3D center of the steering wheel rim: sample the wheel
   meshes' vertices in world space, fit the rim circle (angular-bin outer
   contour + least-squares circle fit), and record the center and its screen
   projection. If the wheel spins about its true hub, that center is invariant
   across angles; an off-hub pivot makes it orbit, which is exactly the
   "wheel wobbles instead of turning in place" bug this guards against.

   Also saves a dashcam screenshot per angle and difference overlays against
   the centered frame (hub crosshair drawn in), so the pass/fail number comes
   with a picture a human can check.

   Usage:
     node test/wheel-center-check.mjs [--url http://localhost:3141]
                                      [--out test/artifacts/wheel-center]
                                      [--no-assert]    # measure + shots only
                                      [--procedural]   # test the fallback cabin
   Pass criteria: max rim-center drift across angles < 4 mm in world space
   and < 3 px in the frame (1280x800).
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import sharp from "sharp";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const URL = arg("--url", "http://localhost:3141");
const OUT = arg("--out", path.join(process.cwd(), "test", "artifacts", "wheel-center"));
const ASSERT = !process.argv.includes("--no-assert");
const PROCEDURAL = process.argv.includes("--procedural");
mkdirSync(OUT, { recursive: true });

const VW = 1280, VH = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

/* Wheel angles under test, expressed as the steer input `st` that produces
   them at parking speed (delta = st * steerMax, wheel rot.z = -delta * 4.6).
   steerMax 0.62 puts full lock at ±163° of wheel rotation; ±90° needs
   |st| = (PI/2) / 4.6 / 0.62 = 0.5508. */
const STEER_MAX = 0.62;
const ANGLES = [
  { tag: "center", st: 0 },
  { tag: "left90", st: -(Math.PI / 2) / 4.6 / STEER_MAX },
  { tag: "right90", st: (Math.PI / 2) / 4.6 / STEER_MAX },
  { tag: "lockL", st: -1 },
  { tag: "lockR", st: 1 },
];

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
  ],
  defaultViewport: { width: VW, height: VH },
  protocolTimeout: 900000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon") && !m.text().includes("WebSocket"))
    errors.push(m.text());
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => !!window.__neonx, { timeout: 120000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("DRIVE"));
  b?.click();
});
/* SwiftShader's staged load can take minutes on a cold dev server. */
await page.waitForFunction(() => window.__neonx?.game?.loaded, { timeout: 600000 });
/* The donor cabin loads async after the world; the default car (Volvo) has
   one, and the wheel under test must be the wheel that ships. */
await page.waitForFunction(() => !!window.__neonx.game.rig?.cockpitModel, { timeout: 120000 });
await sleep(1500);

/* SwiftShader renders this scene at seconds per frame, so wall-clock sleeps
   guarantee nothing: gate every settle on RENDERED FRAMES via a rAF counter. */
await page.evaluate(() => {
  window.__frames = 0;
  const tick = () => { window.__frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const waitFrames = async (n, timeout = 240000) => {
  const start = await page.evaluate(() => window.__frames);
  await page.waitForFunction(
    (s, k) => window.__frames >= s + k,
    { timeout, polling: 250 }, start, n,
  );
};

// park on the open two-lane stretch, night, dashcam
await page.evaluate((procedural) => {
  const nx = window.__neonx;
  nx.toCorridor(-1300, 0, 1);
  nx.setInput({ th: 0, st: 0 });
  nx.setCam(3); // CAM_POV
  // A/B hook: the same check must hold for the procedural fallback wheel
  if (procedural) nx.game.rig.cockpitModel?.setActive(false);
}, PROCEDURAL);
await waitFrames(8);

/* In-page measurement: rim-circle fit of the visible wheel meshes, in world
   space, plus the screen projection of the fitted center. */
const measure = () => page.evaluate(() => {
  const nx = window.__neonx;
  const game = nx.game;
  const wg = game.rig.cockpit.wheelGroup;
  const cam = game.camera;
  cam.updateMatrixWorld(true);
  wg.updateWorldMatrix(true, true);

  // gather world-space vertices of every visible mesh under the wheel group
  const pts = [];
  wg.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    let p = o; let vis = true;
    while (p) { if (p.visible === false) vis = false; p = p.parent; }
    if (!vis) return;
    const a = o.geometry.getAttribute("position");
    if (!a) return;
    const step = Math.max(1, Math.floor(a.count / 8000));
    const m = o.matrixWorld.elements;
    for (let i = 0; i < a.count; i += step) {
      const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
      pts.push([
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      ]);
    }
  });
  if (pts.length < 300) return { error: "too few wheel vertices: " + pts.length };

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };

  // smallest principal axis of a cloud (the wheel is a flat disc)
  const smallestAxis = (cloud, c) => {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of cloud) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      C[i][j] += (p[i] - c[i]) * (p[j] - c[j]);
    const tr = C[0][0] + C[1][1] + C[2][2];
    const M = C.map((r, i) => r.map((v, j) => (i === j ? tr - v : -v)));
    let v = [0.3, 0.5, 0.81];
    for (let it = 0; it < 80; it++) {
      const w = M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
      const n = Math.hypot(w[0], w[1], w[2]); v = [w[0] / n, w[1] / n, w[2] / n];
    }
    return v;
  };

  let center = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  let axis = smallestAxis(pts, center);
  let R = 0;
  for (let iter = 0; iter < 5; iter++) {
    let u = norm(cross(axis, Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    const w = cross(axis, u);
    const BINS = 72; const contour = new Array(BINS).fill(null);
    for (const p of pts) {
      const d = sub(p, center);
      const q = [dot(d, u), dot(d, w), dot(d, axis)];
      const r = Math.hypot(q[0], q[1]);
      const b = Math.floor((Math.atan2(q[1], q[0]) + Math.PI) / (2 * Math.PI) * BINS) % BINS;
      if (!contour[b] || r > contour[b].r) contour[b] = { x: q[0], y: q[1], z: q[2], r };
    }
    let ring = contour.filter(Boolean);
    const med = ring.map((c) => c.r).sort((a, b) => a - b)[Math.floor(ring.length / 2)];
    ring = ring.filter((c) => Math.abs(c.r - med) / med < 0.06);
    let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz2 = 0, Syz2 = 0, Sz2 = 0;
    const n = ring.length;
    for (const c of ring) {
      const z2 = c.x * c.x + c.y * c.y;
      Sx += c.x; Sy += c.y; Sxx += c.x * c.x; Syy += c.y * c.y; Sxy += c.x * c.y;
      Sxz2 += c.x * z2; Syz2 += c.y * z2; Sz2 += z2;
    }
    const A00 = 2 * (Sxx - Sx * Sx / n), A01 = 2 * (Sxy - Sx * Sy / n), A11 = 2 * (Syy - Sy * Sy / n);
    const B0 = Sxz2 - Sx * Sz2 / n, B1 = Syz2 - Sy * Sz2 / n;
    const det = A00 * A11 - A01 * A01;
    const cx = (B0 * A11 - B1 * A01) / det, cy = (A00 * B1 - A01 * B0) / det;
    R = Math.sqrt((Sz2 - 2 * (cx * Sx + cy * Sy)) / n + cx * cx + cy * cy);
    const zMean = ring.reduce((s, c) => s + c.z, 0) / ring.length;
    center = [
      center[0] + cx * u[0] + cy * w[0] + zMean * axis[0],
      center[1] + cx * u[1] + cy * w[1] + zMean * axis[1],
      center[2] + cx * u[2] + cy * w[2] + zMean * axis[2],
    ];
    const band = pts.filter((p) => {
      const d = sub(p, center);
      const along = dot(d, axis);
      const rad = Math.hypot(d[0] - axis[0] * along, d[1] - axis[1] * along, d[2] - axis[2] * along);
      return Math.abs(rad - R) / R < 0.12;
    });
    if (band.length > 200) {
      const bc = [0, 1, 2].map((k) => band.reduce((s, p) => s + p[k], 0) / band.length);
      axis = smallestAxis(band, bc);
    }
  }

  // project the fitted center through the live camera
  const v = { x: center[0], y: center[1], z: center[2] };
  const e = cam.matrixWorldInverse.elements;
  const pm = cam.projectionMatrix.elements;
  const cx = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
  const cy = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
  const cz = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
  const cw = e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15];
  const ndcX = (pm[0] * cx + pm[4] * cy + pm[8] * cz + pm[12] * cw);
  const ndcY = (pm[1] * cx + pm[5] * cy + pm[9] * cz + pm[13] * cw);
  const ndcW = (pm[3] * cx + pm[7] * cy + pm[11] * cz + pm[15] * cw);
  const px = (ndcX / ndcW * 0.5 + 0.5) * innerWidth;
  const py = (-ndcY / ndcW * 0.5 + 0.5) * innerHeight;

  return {
    center, axis, R,
    px: [px, py],
    delta: game.car.delta,
    wheelRotZ: game.rig.cockpit.wheelGroup.rotation.z,
    nPts: pts.length,
    // which wheel got measured: the donor rim hangs inside its raked axis group
    imported: game.rig.cockpit.wheelGroup.parent?.name === "donorSteeringAxis",
  };
});

const results = [];
for (const a of ANGLES) {
  await page.evaluate((st) => window.__neonx.setInput({ th: 0, st }), a.st);
  /* The steer schedule (and arcade mode's boost of it) owns the exact angle a
     given st produces, so wait for delta to STABILIZE rather than predicting
     it — the invariance check needs distinct angles, not exact ones. Stability
     is judged across rendered frames, not wall time. */
  let last = Infinity;
  for (let i = 0; i < 60; i++) {
    await waitFrames(2);
    const d = await page.evaluate(() => window.__neonx.game.car.delta);
    if (Math.abs(d - last) < 1e-4) break;
    last = d;
  }
  await waitFrames(3); // let camera smoothing settle on the final angle
  const m = await measure();
  if (m.error) { console.error("measure failed:", m.error); process.exit(1); }
  m.tag = a.tag;
  results.push(m);
  await page.screenshot({ path: path.join(OUT, `wheel-${a.tag}.png`) });
  const deg = (-m.delta * 4.6 * 180 / Math.PI).toFixed(1);
  console.log(
    `${a.tag.padEnd(7)} wheel ${String(deg).padStart(7)}°  ` +
    `rim center [${m.center.map((x) => x.toFixed(4)).join(", ")}]  ` +
    `px [${m.px.map((x) => x.toFixed(1)).join(", ")}]  (${m.nPts} verts, ${m.imported ? "donor" : "procedural"} cabin)`,
  );
}

await browser.close();

/* --- drift across angles ------------------------------------------------- */
const c0 = results[0];
let maxMm = 0, maxPx = 0;
for (const r of results.slice(1)) {
  const mm = Math.hypot(...r.center.map((v, i) => v - c0.center[i])) * 1000;
  const dpx = Math.hypot(r.px[0] - c0.px[0], r.px[1] - c0.px[1]);
  maxMm = Math.max(maxMm, mm);
  maxPx = Math.max(maxPx, dpx);
  console.log(`${r.tag.padEnd(7)} drift vs center: ${mm.toFixed(1)} mm, ${dpx.toFixed(1)} px`);
}

/* --- difference overlays: |frame - center frame|, hub crosshair drawn ---- */
const cross = (x, y, color) => Buffer.from(
  `<svg width="${VW}" height="${VH}">
     <line x1="${x - 22}" y1="${y}" x2="${x + 22}" y2="${y}" stroke="${color}" stroke-width="2"/>
     <line x1="${x}" y1="${y - 22}" x2="${x}" y2="${y + 22}" stroke="${color}" stroke-width="2"/>
     <circle cx="${x}" cy="${y}" r="14" fill="none" stroke="${color}" stroke-width="1.5"/>
   </svg>`,
);
const base = path.join(OUT, "wheel-center.png");
for (const r of results.slice(1)) {
  const A = await sharp(base).raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(path.join(OUT, `wheel-${r.tag}.png`)).raw().toBuffer({ resolveWithObject: true });
  const n = Math.min(A.data.length, B.data.length);
  const D = Buffer.alloc(n);
  for (let i = 0; i < n; i++) D[i] = Math.abs(A.data[i] - B.data[i]);
  await sharp(D, { raw: { width: A.info.width, height: A.info.height, channels: A.info.channels } })
    .composite([
      { input: cross(c0.px[0], c0.px[1], "#00ff88"), top: 0, left: 0 },
      { input: cross(r.px[0], r.px[1], "#ff3355"), top: 0, left: 0 },
    ])
    .png().toFile(path.join(OUT, `diff-center-vs-${r.tag}.png`));
}
writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, maxMm, maxPx }, null, 2));

console.log(`\nmax rim-center drift: ${maxMm.toFixed(1)} mm world, ${maxPx.toFixed(1)} px screen`);
if (errors.length) {
  console.log("PAGE ERRORS:");
  for (const e of errors.slice(0, 10)) console.log(" -", e.slice(0, 300));
}
if (ASSERT) {
  const ok = maxMm < 4 && maxPx < 3 && errors.length === 0;
  console.log(ok ? "PASS: wheel spins about its true hub" : "FAIL: wheel rim center moves with steering angle");
  process.exit(ok ? 0 : 1);
}
