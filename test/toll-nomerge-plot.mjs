/* Plan view of the toll plaza: every NPC's lateral position against z, before
   and after the no-merge zone. A night screenshot cannot carry this — the
   thing to see is 650 m long and a lane change is a 3.7 m sideways step — so
   the picture is the road seen from directly above, flattened into corridor
   space, with one thin line per car.

   Reads the trace written by test/toll-nomerge-sim.mjs --trace, stacks the
   two panels into one labelled webp.

   Usage: node test/toll-nomerge-sim.mjs --seeds 1 --dur 120 \
            --trace test/artifacts/toll-nomerge/trace.json
          node test/toll-nomerge-plot.mjs test/artifacts/toll-nomerge/trace.json \
            docs/gallery/img/toll-nomerge-plan.webp
*/
import sharp from "sharp";
import { readFileSync } from "node:fs";

const [SRC, OUT] = process.argv.slice(2);
const t = JSON.parse(readFileSync(SRC, "utf8"));
const { TOLL } = t;

const Z0 = 1050, Z1 = 1700;
const W = 1600, PH = 430, BAR = 52, GAP = 10;
const PAD_L = 74, PAD_R = 22, PAD_T = 16, PAD_B = 42;
const PW = W - PAD_L - PAD_R, PIH = PH - PAD_T - PAD_B;
const LAT = 11; // metres either side of the centreline
const x = (z) => PAD_L + ((z - Z0) / (Z1 - Z0)) * PW;
const y = (off) => PAD_T + PIH / 2 - (off / LAT) * (PIH / 2);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const band = (a, b, fill, op) =>
  `<rect x="${x(a).toFixed(1)}" y="${PAD_T}" width="${(x(b) - x(a)).toFixed(1)}" ` +
  `height="${PIH}" fill="${fill}" opacity="${op}"/>`;

/** lane centre guides, which themselves fan out across the plaza */
function laneGuides() {
  const n = Math.max(...t.lanes.map(([, o]) => o.length));
  let out = "";
  for (let k = 0; k < n; k++) {
    const pts = t.lanes.filter(([, o]) => k < o.length)
      .map(([z, o]) => `${x(z).toFixed(1)},${y(o[k]).toFixed(1)}`).join(" ");
    out += `<polyline points="${pts}" fill="none" stroke="#aab6d4" ` +
      `stroke-width="1.1" stroke-dasharray="9 9" opacity="0.55"/>`;
  }
  return out;
}

/** lane-index changes seen in the trace itself, inside the plaza core */
function coreChanges(pts) {
  const by = new Map();
  for (const [z, , k, id] of pts) {
    if (!by.has(id)) by.set(id, []);
    by.get(id).push([z, k]);
  }
  let n = 0;
  for (const arr of by.values()) {
    arr.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < arr.length; i++)
      if (arr[i][1] !== arr[i - 1][1] && arr[i][0] - arr[i - 1][0] < 30 &&
        arr[i][0] >= TOLL.z0 && arr[i][0] <= 1600) n++;
  }
  return n;
}

function panel(pts, stroke, title, sub) {
  /* group the flat samples by car, in z order */
  const byId = new Map();
  for (const [z, off, , id] of pts) {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push([z, off]);
  }
  let paths = "", n = 0;
  for (const arr of byId.values()) {
    arr.sort((a, b) => a[0] - b[0]);
    /* a car wraps or is recycled: break the polyline on a big z jump */
    let run = [];
    const flush = () => {
      if (run.length > 3) {
        paths += `<polyline points="${run.map(([z, o]) =>
          `${x(z).toFixed(1)},${y(o).toFixed(1)}`).join(" ")}" fill="none" ` +
          `stroke="${stroke}" stroke-width="1.5" opacity="0.72" ` +
          `stroke-linejoin="round"/>`;
        n++;
      }
      run = [];
    };
    for (const p of arr) {
      if (run.length && p[0] - run[run.length - 1][0] > 30) flush();
      run.push(p);
    }
    flush();
  }
  const ticks = [1100, 1200, 1300, 1400, 1500, 1600, 1700].map((z) =>
    `<line x1="${x(z).toFixed(1)}" y1="${PAD_T + PIH}" x2="${x(z).toFixed(1)}" ` +
    `y2="${PAD_T + PIH + 5}" stroke="#8a93aa" stroke-width="1"/>` +
    `<text x="${x(z).toFixed(1)}" y="${PAD_T + PIH + 22}" fill="#8a93aa" ` +
    `font-size="14" font-family="DejaVu Sans, sans-serif" text-anchor="middle">${z}</text>`
  ).join("");
  return Buffer.from(
    `<svg width="${W}" height="${PH}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${W}" height="${PH}" fill="#10131c"/>` +
    band(TOLL.z0, TOLL.z1, "#2b3550", 0.55) +
    band(TOLL.plazaZ0, TOLL.plazaZ1, "#5d4a20", 0.85) +
    paths + laneGuides() +
    `<text x="${x((TOLL.plazaZ0 + TOLL.plazaZ1) / 2).toFixed(1)}" y="${PAD_T + 18}" ` +
    `fill="#e8c377" font-size="15" font-weight="700" font-family="DejaVu Sans, sans-serif" ` +
    `text-anchor="middle">PLAZA</text>` +
    `<text x="${x(TOLL.z0 + 26).toFixed(1)}" y="${PAD_T + PIH - 10}" fill="#93a2c8" ` +
    `font-size="14" font-family="DejaVu Sans, sans-serif">fan-out</text>` +
    `<text x="${x(TOLL.z1 - 84).toFixed(1)}" y="${PAD_T + PIH - 10}" fill="#93a2c8" ` +
    `font-size="14" font-family="DejaVu Sans, sans-serif">fan-in</text>` +
    `<text x="14" y="${PAD_T + 20}" fill="#c8d2ea" font-size="15" font-weight="700" ` +
    `font-family="DejaVu Sans, sans-serif">${esc(title)}</text>` +
    `<text x="14" y="${PAD_T + 40}" fill="#8a93aa" font-size="13" ` +
    `font-family="DejaVu Sans, sans-serif">${esc(sub)} · ${n} car paths</text>` +
    `<text x="${(PAD_L + PW / 2).toFixed(0)}" y="${PH - 6}" fill="#8a93aa" font-size="13" ` +
    `font-family="DejaVu Sans, sans-serif" text-anchor="middle">corridor z (m)</text>` +
    ticks + `</svg>`);
}

const nOld = coreChanges(t.old), nNew = coreChanges(t.new);
const A = panel(t.old, "#ff8a4c", "BEFORE — merges live through the plaza",
  "one line per car, seen from above; every diagonal is a lane change");
const B = panel(t.new, "#4cd6a0", "AFTER — no-merge zone: pick a booth on the approach, hold it",
  "same road seed, same traffic seed, same 120 s");

const bar = (text, col, w = W) => Buffer.from(
  `<svg width="${w}" height="${BAR}" xmlns="http://www.w3.org/2000/svg">` +
  `<rect width="${w}" height="${BAR}" fill="#0a0c12"/>` +
  `<text x="16" y="34" font-family="DejaVu Sans, sans-serif" font-size="21" ` +
  `font-weight="700" fill="${col}">${esc(text)}</text></svg>`);

const H = BAR * 2 + PH * 2 + GAP;
await sharp({ create: { width: W, height: H, channels: 3, background: "#0a0c12" } })
  .composite([
    { input: bar(`BEFORE  ·  ${nOld} lane changes inside the plaza core (z 1280-1600) in this 120 s`, "#ff8a4c"), top: 0, left: 0 },
    { input: A, top: BAR, left: 0 },
    { input: bar(`AFTER  ·  ${nNew} there — and 0 across 12 road seeds x 2 densities in test/toll-nomerge-sim.mjs`, "#4cd6a0"), top: BAR + PH + GAP, left: 0 },
    { input: B, top: BAR * 2 + PH + GAP, left: 0 },
  ])
  .webp({ quality: 84 })
  .toFile(OUT);
console.log("wrote " + OUT);

/* …and the crop that makes it judgeable: just the zone core, both panels, so
   the plaza is big enough to read rather than 60 px of a 650 m plot. */
if (process.argv[4]) {
  const L = Math.round(x(TOLL.z0) - 12), R = Math.round(x(1600) + 12);
  const CW = R - L;
  const cropOf = async (img, top) =>
    sharp(img).extract({ left: L, top: 0, width: CW, height: PH })
      .extract({ left: 0, top, width: CW, height: PH - top - 34 }).toBuffer();
  const ca = await cropOf(A, 18), cb = await cropOf(B, 18);
  const ch = PH - 18 - 34;
  await sharp({ create: { width: CW, height: BAR * 2 + ch * 2 + GAP, channels: 3, background: "#0a0c12" } })
    .composite([
      { input: bar(`BEFORE  ·  the plaza core, ${nOld} lane changes`, "#ff8a4c", CW), top: 0, left: 0 },
      { input: ca, top: BAR, left: 0 },
      { input: bar(`AFTER  ·  the same 320 m, ${nNew} lane changes`, "#4cd6a0", CW), top: BAR + ch + GAP, left: 0 },
      { input: cb, top: BAR * 2 + ch + GAP, left: 0 },
    ]).webp({ quality: 86 }).toFile(process.argv[4]);
  console.log("wrote " + process.argv[4]);
}
