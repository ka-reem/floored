#!/usr/bin/env node
/* Top-down: the drawn body, the OLD collision box and the NEW one, per
   vehicle, dimensioned. Reads the JSON test/hitbox-measure.mjs --out writes,
   so the silhouettes are the measured meshes and not a redrawing of them.

   The silhouette is the width profile from the measurement (widest |x| in
   each 5 cm slice along the car) mirrored about the centreline — i.e. the
   shape you would see looking straight down at the car, mirrors and all.

   Pure SVG rasterised with sharp, the same way test/handbrake-drift-plot.mjs
   does it: no browser, no plotting dependency.

   Usage: node test/hitbox-measure.mjs --out /tmp/hb.json
          node test/hitbox-plot.mjs /tmp/hb.json out.png [--only bus,sedan]
*/
import { readFileSync } from "node:fs";
import sharp from "sharp";

const IN = process.argv[2];
const OUT = process.argv[3] || "/tmp/hitboxes.png";
const onlyArg = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1].split(",")
  : null;
if (!IN) { console.error("usage: hitbox-plot.mjs <hitbox.json> [out.png] [--only a,b]"); process.exit(1); }

let rows = JSON.parse(readFileSync(IN, "utf8"));
if (onlyArg) rows = onlyArg.map((s) => rows.find((r) => r.style === s)).filter(Boolean);

/* New half-extents, by the rule this lane landed on: the box is the DRAWN
   BODY, less the 1 cm of leeway traffic.ts already believed it was applying
   ("a gap that looks clear IS clear"). Mirrors, aerials and roof bars are
   outside it deliberately — they are the parts that fold. */
const LEEWAY = 0.005;
const newW = (r) => r.bodyHalfW - LEEWAY;
const newL = (r) => Math.max(r.bodyFront, -r.bodyRear);

const COLS = Math.min(3, rows.length);
const ROWS = Math.ceil(rows.length / COLS);
const CW = 620, CH = 300, PAD = 40, TOP = 118;
const W = PAD * 2 + CW * COLS, H = TOP + PAD + CH * ROWS;
const BG = "#0e1015", FG = "#e6e9ef", GRID = "#242833";
const MESH = "#5b6472", OLD = "#ef476f", NEW = "#4cc98a";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const parts = [`<rect width="${W}" height="${H}" fill="${BG}"/>`];
const txt = (x, y, s, o = {}) =>
  parts.push(
    `<text x="${x}" y="${y}" fill="${o.fill || FG}" font-family="ui-monospace,Menlo,monospace" ` +
    `font-size="${o.size || 15}" text-anchor="${o.anchor || "start"}"` +
    `${o.weight ? ` font-weight="${o.weight}"` : ""}${o.op ? ` opacity="${o.op}"` : ""}>${esc(s)}</text>`
  );

txt(PAD, 48, "HITBOX AUDIT — drawn body vs collision box, seen from above", { size: 30, weight: 700 });
txt(PAD, 78,
  "Grey = the mesh the game draws (mirrors included).  Red dashed = the box collide.ts tested against.  " +
  "Green = the new box.",
  { size: 16, op: 0.8 });
txt(PAD, 100,
  "Measured off the shipped GLBs by test/hitbox-measure.mjs. Nose points right.",
  { size: 15, op: 0.6 });

rows.forEach((r, i) => {
  const cx0 = PAD + (i % COLS) * CW, cy0 = TOP + Math.floor(i / COLS) * CH;
  parts.push(`<rect x="${cx0 + 6}" y="${cy0 + 6}" width="${CW - 16}" height="${CH - 16}" fill="#12151c" stroke="${GRID}"/>`);
  const half = Math.max(r.colHalfL, r.bodyFront, -r.bodyRear) * 1.12;
  const S = (CW - 130) / (2 * half);          // px per metre, same on both axes
  const ox = cx0 + CW / 2, oy = cy0 + CH / 2 + 8;
  const X = (z) => ox + z * S;                 // car z -> screen x (nose right)
  const Y = (x) => oy - x * S;                 // car x -> screen y

  // silhouette, from the measured width profile, mirrored about the centreline
  if (r.prof) {
    const ks = Object.keys(r.prof).map(Number).sort((a, b) => a - b);
    const up = ks.map((k) => `${X(k * 0.05).toFixed(1)},${Y(r.prof[k]).toFixed(1)}`);
    const dn = [...ks].reverse().map((k) => `${X(k * 0.05).toFixed(1)},${Y(-r.prof[k]).toFixed(1)}`);
    parts.push(`<polygon points="${up.concat(dn).join(" ")}" fill="${MESH}" opacity="0.55" stroke="${MESH}"/>`);
  } else {
    // procedural shell: a plain rectangle is exactly what carshape.ts builds
    parts.push(
      `<rect x="${X(r.bodyRear)}" y="${Y(r.bodyHalfW)}" width="${(r.bodyFront - r.bodyRear) * S}" ` +
      `height="${2 * r.bodyHalfW * S}" fill="${MESH}" opacity="0.55" stroke="${MESH}"/>`
    );
  }
  const box = (hl, hw, col, dash) => parts.push(
    `<rect x="${X(-hl)}" y="${Y(hw)}" width="${2 * hl * S}" height="${2 * hw * S}" fill="none" ` +
    `stroke="${col}" stroke-width="2.4"${dash ? ` stroke-dasharray="8 6"` : ""}/>`
  );
  box(r.colHalfL, r.colHalfW, OLD, true);
  box(newL(r), newW(r), NEW, false);

  const dW = (r.colHalfW - newW(r)) * 100, dL = (r.colHalfL - newL(r)) * 100;
  const tag = r.kind === "player" ? (r.procedural ? "  PLAYER (procedural)" : "  PLAYER (donor body)") : "";
  txt(cx0 + 20, cy0 + 34, r.style.toUpperCase() + tag, { size: 20, weight: 700 });
  txt(cx0 + 20, cy0 + 56,
    `half-width  ${r.colHalfW.toFixed(3)} -> ${newW(r).toFixed(3)} m   (${dW >= 0 ? "-" : "+"}${Math.abs(dW).toFixed(1)} cm per side)`,
    { size: 15, fill: dW > 3 ? OLD : FG });
  txt(cx0 + 20, cy0 + 76,
    `half-length ${r.colHalfL.toFixed(3)} -> ${newL(r).toFixed(3)} m   (${dL >= 0 ? "-" : "+"}${Math.abs(dL).toFixed(1)} cm per end)`,
    { size: 15, fill: dL > 3 ? OLD : FG });
  txt(cx0 + CW - 26, cy0 + CH - 24,
    `mesh widest ${r.fullHalfW.toFixed(3)} m (mirrors)`, { size: 13, anchor: "end", op: 0.6 });
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(`wrote ${OUT} (${rows.length} vehicles)`);
for (const r of rows)
  console.log(
    `${r.style.padEnd(10)} W ${r.colHalfW.toFixed(3)} -> ${newW(r).toFixed(3)}   ` +
    `L ${r.colHalfL.toFixed(3)} -> ${newL(r).toFixed(3)}`
  );
