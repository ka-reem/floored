/* The frame budget as a picture: what the renderer touches, per frame, per
   camera, before and after.

   The numbers this draws come from test/mobile-ab.mjs's per-target counters,
   which are counted rather than timed — a pass that stops running stops
   running on a phone too. Every bar is one render target class, stacked in
   the order the chain runs, so the length of the bar IS the fill the phone
   pays for.

   Usage:
     node test/frame-budget.mjs --before before.json --after after.json \
       --out budget.png [--cam pov] [--place open]
*/
import sharp from "./node_modules/sharp/dist/index.cjs";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const OUT = arg("--out", "/tmp/budget.png");
const CAM = arg("--cam", "pov");
const PLACE = arg("--place", "open");
const runs = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--run") {
    const s = process.argv[i + 1], j = s.lastIndexOf("=");
    runs.push({ label: s.slice(0, j), file: s.slice(j + 1) });
  }
}
mkdirSync(path.dirname(OUT), { recursive: true });

/* Classify a target by its width against the canvas, with a couple of pixels
   of slack: the half-res pair is `w >> 1`, so at an odd canvas width it is one
   pixel short of exactly half and an exact test files it under quarter. */
const CLASS = (w, h, canvasW) =>
  h <= 80 ? "mirror"
    : w * 2 >= canvasW - 2 ? (w >= canvasW - 2 ? "screen-sized" : "half res")
      : "quarter res";
const COLOR = { "screen-sized": "#e8624a", "half res": "#e8a33d", "quarter res": "#4d9de0", mirror: "#7bc86c" };
const ORDER = ["screen-sized", "half res", "quarter res", "mirror"];

const series = [];
for (const r of runs) {
  const d = JSON.parse(readFileSync(r.file, "utf8"));
  const row = d.rows.find((x) => x.cam === CAM && x.place === PLACE);
  if (!row) { console.error("no row", CAM, PLACE, "in", r.file); process.exit(1); }
  const canvasW = d.env.canvas[0];
  const frames = row.frames;
  const parts = {};
  let total = 0, passes = 0;
  for (const [k, n] of Object.entries(row.targets)) {
    const [w, h] = k.split("x").map(Number);
    const cls = CLASS(w, h, canvasW);
    const mpx = (w * h * n) / frames / 1e6;
    parts[cls] = (parts[cls] || 0) + mpx;
    total += mpx;
    passes += n / frames;
  }
  series.push({ label: r.label, parts, total, passes, canvas: d.env.canvas });
}

const MAX = Math.max(...series.map((s) => s.total));
const W = 1500, BARH = 62, GAP = 46, LEFT = 330, RIGHT = 40, TOP = 108;
const H = TOP + series.length * (BARH + GAP) + 104;
const barW = W - LEFT - RIGHT;
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#0e0e12"/>
<text x="34" y="42" font-family="monospace" font-size="24" fill="#f4f4f4">What one frame costs on a phone — ${esc(CAM.toUpperCase())} camera, ${esc(PLACE)}</text>
<text x="34" y="70" font-family="monospace" font-size="14" fill="#9aa0aa">megapixels the renderer fills per frame, by target size. ${series[0].canvas[0]}x${series[0].canvas[1]} buffer (390x844 CSS at devicePixelRatio 3, mobile-base dprCap 1.1).</text>
<text x="34" y="90" font-family="monospace" font-size="14" fill="#9aa0aa">Counted, not timed: every renderer.render() call and the pixels of the target it drew into.</text>`;

let y = TOP;
for (const s of series) {
  svg += `<text x="34" y="${y + 26}" font-family="monospace" font-size="17" fill="#e8e8e8">${esc(s.label)}</text>`;
  svg += `<text x="34" y="${y + 48}" font-family="monospace" font-size="14" fill="#9aa0aa">${s.total.toFixed(2)} Mpx  ·  ${s.passes.toFixed(1)} passes</text>`;
  let x = LEFT;
  for (const cls of ORDER) {
    const v = s.parts[cls] || 0;
    if (v <= 0) continue;
    const w = (v / MAX) * barW;
    svg += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${BARH}" fill="${COLOR[cls]}"/>`;
    if (w > 86)
      svg += `<text x="${(x + 8).toFixed(1)}" y="${y + BARH / 2 + 5}" font-family="monospace" font-size="13" fill="#14141a">${cls} ${v.toFixed(2)}</text>`;
    x += w + 2;
  }
  y += BARH + GAP;
}
const first = series[0], last = series[series.length - 1];
if (series.length > 1) {
  const dp = (1 - last.total / first.total) * 100;
  svg += `<text x="34" y="${H - 44}" font-family="monospace" font-size="18" fill="#8fe08f">${dp.toFixed(0)}% fewer pixels per frame  (${first.total.toFixed(2)} -> ${last.total.toFixed(2)} Mpx), ${first.passes.toFixed(1)} -> ${last.passes.toFixed(1)} passes</text>`;
}
svg += `<text x="34" y="${H - 18}" font-family="monospace" font-size="13" fill="#9aa0aa">Frame TIME is not shown: this box has no GPU (SwiftShader), so milliseconds here are not a phone's milliseconds. Pixels and passes transfer; times do not.</text>`;
svg += "</svg>";
await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log("wrote", OUT);
