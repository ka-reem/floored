#!/usr/bin/env node
/* Top-down "ghost trail" of the handbrake manoeuvre: the car's own outline
   drawn at its real heading every few frames along the path it drives, from
   the traces test/handbrake-drift-sim.mjs --csv writes.

   This is the picture that shows the ANGLE. A chase-camera screenshot shows
   one instant and hides the yaw behind the bodywork; a ghost trail shows the
   whole slide at once — where the nose is pointing against where the car is
   actually going, which IS the drift. (It is also the only view available on
   a box with no GPU: the game renders through swiftshader here and a single
   world load can block the page's main thread past puppeteer's protocol
   timeout.)

   Usage: node test/handbrake-drift-sim.mjs --csv /tmp/hb
          node test/handbrake-drift-path.mjs /tmp/hb /tmp/hb/path.png
*/
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const DIR = process.argv[2];
const OUT = process.argv[3] || path.join(DIR, "handbrake-drift-path.png");
if (!DIR) { console.error("usage: handbrake-drift-path.mjs <csvDir> [out.png]"); process.exit(1); }

const read = (f) => {
  const [head, ...lines] = readFileSync(path.join(DIR, f), "utf8").trim().split("\n");
  const keys = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], +v])));
};
const files = readdirSync(DIR).filter((f) => f.endsWith(".csv"));

/* One row per run we want to draw. Case is the manoeuvre, series the tuning. */
const CASE = process.argv.includes("--case")
  ? process.argv[process.argv.indexOf("--case") + 1]
  : "b-steer60";
const RUNS = (process.argv.includes("--variants")
  ? [["stock", "today"], ["nudge", "nudge"], ["drift", "drift"], ["loose", "loose"]]
  : [["before", "today"], ["after", "after — variant 'drift'"]]
).filter(([s]) => files.includes(`${CASE}.${s}.csv`));

/* Car outline, metres (roughly the player body box). Drawn every STRIDE
   samples; the traces are 120 Hz. */
const CAR_L = 4.5, CAR_W = 1.85, STRIDE = 26;

const PAD = 30, TITLE = 84, LBL = 22, GAPX = 18;
const PANEL_W = 470, PANEL_H = 470;
const W = PAD * 2 + RUNS.length * PANEL_W + (RUNS.length - 1) * GAPX;
const H = TITLE + PANEL_H + LBL + PAD + 26;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
svg += `<rect width="${W}" height="${H}" fill="#12141a"/>`;
svg += `<style>text{font-family:'DejaVu Sans',system-ui,sans-serif;fill:#c9ced8}` +
       `.t{font-size:16px;font-weight:700;fill:#fff}.s{font-size:11px;fill:#8a8f98}` +
       `.ch{font-size:13px;font-weight:700;fill:#fff}.ax{font-size:10px;fill:#6d7480}</style>`;
svg += `<text class="t" x="${PAD}" y="26">Where the nose points vs where the car is going — the drift, seen from above</text>`;
svg += `<text class="s" x="${PAD}" y="44">kaze GT, 60 km/h entry, full stick, 70% throttle held. ` +
       `Amber outlines = handbrake up. Grey line = the path the car actually travelled.</text>`;

/* Common scale across the panels so the two runs are comparable. */
let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
const data = {};
for (const [series] of RUNS) {
  const rows = read(`${CASE}.${series}.csv`);
  data[series] = rows;
  for (const r of rows) {
    minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x);
    minZ = Math.min(minZ, r.z); maxZ = Math.max(maxZ, r.z);
  }
}
const spanM = Math.max(maxX - minX, maxZ - minZ) * 1.14 + 12;
const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

RUNS.forEach(([series, label], i) => {
  const x0 = PAD + i * (PANEL_W + GAPX), y0 = TITLE;
  const S = PANEL_W / spanM;                        // px per metre
  const PX = (x) => x0 + PANEL_W / 2 + (x - cx) * S;
  const PY = (z) => y0 + PANEL_H / 2 - (z - cz) * S; // +z is forward, so up

  svg += `<rect x="${x0}" y="${y0}" width="${PANEL_W}" height="${PANEL_H}" fill="#181b23" stroke="#252a34"/>`;
  // 10 m grid
  for (let m = Math.ceil((cx - spanM / 2) / 10) * 10; m < cx + spanM / 2; m += 10)
    svg += `<line x1="${PX(m).toFixed(1)}" y1="${y0}" x2="${PX(m).toFixed(1)}" y2="${y0 + PANEL_H}" stroke="#1e222b"/>`;
  for (let m = Math.ceil((cz - spanM / 2) / 10) * 10; m < cz + spanM / 2; m += 10)
    svg += `<line x1="${x0}" y1="${PY(m).toFixed(1)}" x2="${x0 + PANEL_W}" y2="${PY(m).toFixed(1)}" stroke="#1e222b"/>`;

  const rows = data[series];
  // the path itself
  let d = "";
  rows.forEach((r, k) => { d += `${k ? "L" : "M"}${PX(r.x).toFixed(1)} ${PY(r.z).toFixed(1)}`; });
  svg += `<path d="${d}" fill="none" stroke="#5a6270" stroke-width="1.6"/>`;

  // the car, at its real heading, every STRIDE samples
  for (let k = 0; k < rows.length; k += STRIDE) {
    const r = rows[k];
    const up = r.hb > 0.5;
    const col = up ? "#f7b32b" : "#5eead4";
    const deg = (-r.h * 180) / Math.PI;             // +h turns right in world
    const w = CAR_W * S, l = CAR_L * S;
    svg += `<g transform="translate(${PX(r.x).toFixed(1)} ${PY(r.z).toFixed(1)}) rotate(${deg.toFixed(1)})">` +
           `<rect x="${(-w / 2).toFixed(1)}" y="${(-l / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${l.toFixed(1)}" ` +
           `rx="${(w * 0.22).toFixed(1)}" fill="${col}" fill-opacity="${up ? 0.2 : 0.13}" stroke="${col}" stroke-width="1.4"/>` +
           // nose marker, so which way it is pointing is never ambiguous
           `<path d="M${(-w * 0.34).toFixed(1)} ${(-l * 0.30).toFixed(1)} L0 ${(-l * 0.46).toFixed(1)} L${(w * 0.34).toFixed(1)} ${(-l * 0.30).toFixed(1)}" ` +
           `fill="none" stroke="${col}" stroke-width="1.6"/></g>`;
  }

  const peak = rows.reduce((a, r) => (Math.abs(r.beta) > Math.abs(a.beta) ? r : a));
  svg += `<text class="ch" x="${x0}" y="${y0 - 8}">${esc(label)}</text>`;
  svg += `<text class="ax" x="${x0 + 4}" y="${y0 + PANEL_H + 16}">` +
         `peak sideslip ${Math.abs(peak.beta).toFixed(0)} deg` +
         `  \u00b7  speed at the end of the pull ${rows.find((r) => r.t > 3.9).kmh.toFixed(0)} km/h` +
         `  \u00b7  grid 10 m</text>`;
});

// legend
svg += `<rect x="${PAD}" y="${H - 26}" width="14" height="9" fill="#5eead4" fill-opacity="0.13" stroke="#5eead4"/>` +
       `<text class="s" x="${PAD + 20}" y="${H - 18}">lever down</text>` +
       `<rect x="${PAD + 100}" y="${H - 26}" width="14" height="9" fill="#f7b32b" fill-opacity="0.2" stroke="#f7b32b"/>` +
       `<text class="s" x="${PAD + 120}" y="${H - 18}">lever up</text>`;
svg += "</svg>";

writeFileSync(OUT.replace(/\.png$/, ".svg"), svg);
await sharp(Buffer.from(svg), { density: 144 }).png().toFile(OUT);
console.log("wrote " + OUT);
