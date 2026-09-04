#!/usr/bin/env node
/* Draws the traces test/handbrake-drift-sim.mjs --csv writes into one PNG:
   yaw rate, rear slip angle, ground speed and heading, before against after,
   with the handbrake pull shaded. Pure SVG, rasterised with sharp — no
   browser and no plotting dependency.

   Usage: node test/handbrake-drift-sim.mjs --csv /tmp/hb
          node test/handbrake-drift-plot.mjs /tmp/hb /tmp/hb/handbrake.png
*/
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const DIR = process.argv[2];
const OUT = process.argv[3] || path.join(DIR, "handbrake-drift.png");
if (!DIR) { console.error("usage: handbrake-drift-plot.mjs <csvDir> [out.png]"); process.exit(1); }

const read = (f) => {
  const [head, ...lines] = readFileSync(path.join(DIR, f), "utf8").trim().split("\n");
  const keys = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], +v])));
};

const files = readdirSync(DIR).filter((f) => f.endsWith(".csv"));
const cases = [...new Set(files.map((f) => f.split(".")[0]))].sort();
/* Which series get a line, and in what order — "before" first so the after
   curves draw over it. Anything else in the directory (the other variants) is
   drawn thin and grey unless it is named here. */
const SERIES = process.argv.includes("--variants")
  ? [["before", "#8a8f98", 2], ["nudge", "#4cc9f0", 2.2], ["drift", "#f7b32b", 2.6], ["loose", "#ef476f", 2.2]]
  : [["before", "#8a8f98", 2.2], ["after", "#f7b32b", 2.8]];

const PANELS = [
  { k: "r", title: "yaw rate", unit: "rad/s", sym: true },
  { k: "ar", title: "rear tyre slip angle", unit: "deg", sym: true },
  { k: "kmh", title: "ground speed", unit: "km/h", sym: false },
  { k: "head", title: "heading change", unit: "deg", sym: true },
];

const CASE_LABEL = {
  "a-straight60": "60 km/h, straight ahead",
  "b-steer60": "60 km/h, full stick",
  "c-steer100": "100 km/h, full stick",
};

const PW = 300, PH = 132, GX = 62, GY = 46, PADX = 26, PADY = 34;
const W = PADX * 2 + GX + cases.length * (PW + 34) - 34;
const H = PADY + GY + PANELS.length * (PH + 26) + 54;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
svg += `<rect width="${W}" height="${H}" fill="#12141a"/>`;
svg += `<style>text{font-family:'DejaVu Sans',system-ui,sans-serif;fill:#c9ced8}` +
       `.t{font-size:15px;font-weight:700;fill:#fff}.s{font-size:11px;fill:#8a8f98}` +
       `.ax{font-size:9px;fill:#6d7480}.pl{font-size:11px;font-weight:600;fill:#e7eaf0}` +
       `.ch{font-size:12px;font-weight:700;fill:#fff}</style>`;
svg += `<text class="t" x="${PADX}" y="24">Handbrake drift — 3-second pull, lever up t=1s, released t=4s</text>`;
svg += `<text class="s" x="${PADX}" y="40">kaze GT, mu 1.26, TC on, 70% throttle held throughout. Shaded band = lever up.</text>`;

// legend
let lx = PADX;
for (const [name, col, w] of SERIES) {
  svg += `<line x1="${lx}" y1="${H - 20}" x2="${lx + 22}" y2="${H - 20}" stroke="${col}" stroke-width="${w}"/>`;
  svg += `<text class="s" x="${lx + 28}" y="${H - 16}">${esc(name)}</text>`;
  lx += 34 + name.length * 7;
}

cases.forEach((cname, ci) => {
  const x0 = PADX + GX + ci * (PW + 34);
  svg += `<text class="ch" x="${x0}" y="${GY + 6}">${esc(CASE_LABEL[cname] || cname)}</text>`;
  const data = {};
  for (const [name] of SERIES) {
    const f = `${cname}.${name}.csv`;
    if (files.includes(f)) data[name] = read(f);
  }
  const tMax = 6;
  PANELS.forEach((p, pi) => {
    const y0 = GY + 20 + pi * (PH + 26);
    let lo = 0, hi = 0;
    for (const rows of Object.values(data)) for (const s of rows) {
      lo = Math.min(lo, s[p.k]); hi = Math.max(hi, s[p.k]);
    }
    if (!p.sym) lo = 0;
    const span = Math.max(hi - lo, 1e-3), pad = span * 0.12;
    lo -= pad; hi += pad;
    const X = (t) => x0 + (t / tMax) * PW;
    const Y = (v) => y0 + PH - ((v - lo) / (hi - lo)) * PH;

    svg += `<rect x="${x0}" y="${y0}" width="${PW}" height="${PH}" fill="#181b23" stroke="#252a34"/>`;
    svg += `<rect x="${X(1)}" y="${y0}" width="${X(4) - X(1)}" height="${PH}" fill="#f7b32b" opacity="0.07"/>`;
    if (lo < 0 && hi > 0)
      svg += `<line x1="${x0}" y1="${Y(0)}" x2="${x0 + PW}" y2="${Y(0)}" stroke="#333a46" stroke-width="1"/>`;
    for (let t = 1; t < tMax; t++)
      svg += `<line x1="${X(t)}" y1="${y0}" x2="${X(t)}" y2="${y0 + PH}" stroke="#20242d"/>`;
    if (ci === 0)
      svg += `<text class="pl" x="${PADX}" y="${y0 + 60}">${esc(p.title)}</text>` +
             `<text class="ax" x="${PADX}" y="${y0 + 73}">${esc(p.unit)}</text>`;
    for (const v of [lo + (hi - lo) * 0.5, hi - pad, lo + pad]) {
      svg += `<text class="ax" x="${x0 - 4}" y="${Y(v) + 3}" text-anchor="end">${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}</text>`;
    }
    for (const [name, col, w] of SERIES) {
      const rows = data[name];
      if (!rows) continue;
      let d = "";
      rows.forEach((s, i) => { d += `${i ? "L" : "M"}${X(s.t).toFixed(1)} ${Y(s[p.k]).toFixed(1)}`; });
      svg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round"/>`;
    }
    if (pi === PANELS.length - 1)
      for (let t = 0; t <= tMax; t++)
        svg += `<text class="ax" x="${X(t)}" y="${y0 + PH + 14}" text-anchor="middle">${t}s</text>`;
  });
});
svg += "</svg>";

writeFileSync(OUT.replace(/\.png$/, ".svg"), svg);
await sharp(Buffer.from(svg), { density: 144 }).png().toFile(OUT);
console.log("wrote " + OUT);
