/* Draw test/cam-hitch.mjs's two JSON runs as one picture: how many GL shader
   programs each camera links the FIRST time it is entered, before and after
   the pre-warm. Program links are synchronous main-thread stalls, so this
   chart is the hitch.

   Usage: node test/lib/cam-hitch-chart.mjs before.json after.json out.webp
*/
import { readFileSync } from "node:fs";
import sharp from "sharp";

const [A, B, OUT] = process.argv.slice(2);
const first = (f) => {
  const rows = JSON.parse(readFileSync(f, "utf8")).rows.filter((r) => r.pass === 1);
  return new Map(rows.map((r) => [r.name, r]));
};
const before = first(A), after = first(B);
const NAMES = [...before.keys()];

const W = 1180, H = 620, PAD = 78, BASE = H - 118, TOP = 132;
const max = Math.max(4, ...NAMES.map((n) =>
  Math.max(before.get(n)?.newPrograms ?? 0, after.get(n)?.newPrograms ?? 0)));
const colW = (W - PAD * 2) / NAMES.length;
const barW = Math.min(58, colW / 2.9);
const yOf = (v) => BASE - (v / max) * (BASE - TOP);

const T = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" font-family="DejaVu Sans, sans-serif" font-size="${o.size || 20}" ` +
  `font-weight="${o.w || 400}" fill="${o.fill || "#c8d2e8"}" text-anchor="${o.a || "middle"}"` +
  `${o.ls ? ` letter-spacing="${o.ls}"` : ""}>${s}</text>`;

let g = "";
// baseline + a gridline at the max
g += `<line x1="${PAD - 16}" y1="${BASE}" x2="${W - PAD + 16}" y2="${BASE}" stroke="#39435c" stroke-width="2"/>`;
g += `<line x1="${PAD - 16}" y1="${TOP}" x2="${W - PAD + 16}" y2="${TOP}" stroke="#232a3c" stroke-width="1"/>`;
g += T(PAD - 26, TOP + 7, String(max), { a: "end", size: 17, fill: "#6d7891" });
g += T(PAD - 26, BASE + 7, "0", { a: "end", size: 17, fill: "#6d7891" });

NAMES.forEach((n, i) => {
  const cx = PAD + colW * (i + 0.5);
  const b = before.get(n)?.newPrograms ?? 0, a = after.get(n)?.newPrograms ?? 0;
  const bx = cx - barW - 5, ax = cx + 5;
  const draw = (x, v, fill, stroke) => {
    const h = Math.max(v > 0 ? 3 : 0, BASE - yOf(v));
    return (v > 0
      ? `<rect x="${x}" y="${BASE - h}" width="${barW}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" rx="2"/>`
      : `<rect x="${x}" y="${BASE - 3}" width="${barW}" height="3" fill="${stroke}" opacity="0.5"/>`) +
      T(x + barW / 2, BASE - h - 13, `+${v}`, { size: 20, w: 700, fill: v > 0 ? "#ffd280" : "#5d6880" });
  };
  g += draw(bx, b, "rgba(255,180,84,0.30)", "#ffb454");
  g += draw(ax, a, "rgba(120,150,210,0.18)", "#5d80c0");
  g += T(cx, BASE + 30, n, { size: 18, w: 700, fill: "#9fb0cf", ls: "1.5" });
});

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
  `<rect width="${W}" height="${H}" fill="#0d1018"/>` +
  T(PAD, 56, "GL shader programs linked on the FIRST switch into each camera", { a: "start", size: 27, w: 700, fill: "#eef3ff" }) +
  T(PAD, 88, "one link is a synchronous main-thread stall — this is the hitch, counted", { a: "start", size: 19, fill: "#8894ad" }) +
  `<rect x="${W - PAD - 300}" y="74" width="18" height="18" fill="rgba(255,180,84,0.30)" stroke="#ffb454" stroke-width="1.5"/>` +
  T(W - PAD - 274, 89, "before", { a: "start", size: 18, fill: "#ffd280" }) +
  `<rect x="${W - PAD - 190}" y="74" width="18" height="18" fill="rgba(120,150,210,0.18)" stroke="#5d80c0" stroke-width="1.5"/>` +
  T(W - PAD - 164, 89, "after the pre-warm", { a: "start", size: 18, fill: "#9fb0cf" }) +
  g +
  T(PAD, H - 42, "CHASE is the camera one press of C from the dashcam the game ships in.", { a: "start", size: 19, fill: "#8894ad" }) +
  T(PAD, H - 16, "Second lap of the cycle links nothing in either build — that is what makes it a compile, not a draw cost.", { a: "start", size: 19, fill: "#6d7891" }) +
  `</svg>`;

await sharp(Buffer.from(svg)).webp({ quality: 88 }).toFile(OUT);
console.log("wrote", OUT);
