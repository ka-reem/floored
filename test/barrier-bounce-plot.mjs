#!/usr/bin/env node
/* The restitution curve, drawn. Reads game/physics.ts's WALL object directly
   — the same one collide.ts resolves contacts with — so the picture is the
   shipping curve and not a redrawing of it.

   Panel 1: closing speed in against rebound speed out, before and after, with
   the DEAD ZONE (where a soft contact does not bounce at all) shaded.
   Panel 2: the restitution ratio itself.
   Panel 3: what a barrier costs you — speed kept a second after a shallow
   lean-on, before against after, which is the "car gets stuck" bug.

   Pure SVG rasterised with sharp, the same way test/handbrake-drift-plot.mjs
   does it: no browser, no plotting dependency.

   Usage: node test/barrier-bounce-plot.mjs [out.png]
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const OUT = process.argv[2] || "/tmp/barrier-bounce.png";
const out = mkdtempSync(path.join(tmpdir(), "bounceplot-"));
execFileSync("npx", [
  "tsc", "game/physics.ts", "game/carspecs.ts", "--outDir", out,
  "--module", "commonjs", "--target", "es2022", "--skipLibCheck",
], { stdio: "pipe" });
const { WALL } = createRequire(import.meta.url)(path.join(out, "physics.js"));
rmSync(out, { recursive: true, force: true });

const W = 1360, H = 1180, PAD = 92;
const BG = "#0e1015", FG = "#e6e9ef", GRID = "#242833";
const BEFORE = "#8a8f98", AFTER = "#f7b32b", DEAD = "#2f6f4e";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const parts = [`<rect width="${W}" height="${H}" fill="${BG}"/>`];
const txt = (x, y, s, o = {}) =>
  parts.push(
    `<text x="${x}" y="${y}" fill="${o.fill || FG}" font-family="ui-monospace,Menlo,monospace" ` +
    `font-size="${o.size || 17}" text-anchor="${o.anchor || "start"}"${o.weight ? ` font-weight="${o.weight}"` : ""}` +
    `${o.op ? ` opacity="${o.op}"` : ""}>${esc(s)}</text>`
  );

/* Closing speed, in km/h, is the axis to read this on: how fast the car was
   going INTO the wall. 0 to 150 covers everything from a settling car to a
   full-speed broadside. */
const VMAX = 42;            // m/s of closing speed
const N = 600;
const xs = Array.from({ length: N + 1 }, (_, i) => (i / N) * VMAX);
const beforeOut = (v) => v * 0.07;              // the old flat coefficient
const afterOut = (v) => WALL.rebound(v);

function panel(px, py, pw, ph, title, ymax, yLabel, series, shadeTo) {
  parts.push(`<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="#12151c" stroke="${GRID}"/>`);
  txt(px, py - 16, title, { size: 20, weight: 600 });
  const X = (v) => px + (v / VMAX) * pw;
  const Y = (v) => py + ph - (v / ymax) * ph;
  if (shadeTo > 0) {
    parts.push(
      `<rect x="${X(0)}" y="${py}" width="${X(shadeTo) - X(0)}" height="${ph}" ` +
      `fill="${DEAD}" opacity="0.22"/>`
    );
    txt(X(shadeTo) + 10, py + 30, `dead zone: no bounce below ${(shadeTo * 3.6).toFixed(1)} km/h`,
      { size: 16, fill: "#7fd6a6" });
  }
  for (let i = 0; i <= 5; i++) {
    const v = (i / 5) * ymax, y = Y(v);
    parts.push(`<line x1="${px}" y1="${y}" x2="${px + pw}" y2="${y}" stroke="${GRID}"/>`);
    txt(px - 12, y + 6, v.toFixed(ymax <= 1 ? 2 : 1), { anchor: "end", size: 15, op: 0.8 });
  }
  for (let k = 0; k <= 150; k += 25) {
    const x = X(k / 3.6);
    parts.push(`<line x1="${x}" y1="${py}" x2="${x}" y2="${py + ph}" stroke="${GRID}"/>`);
    txt(x, py + ph + 26, `${k}`, { anchor: "middle", size: 15, op: 0.8 });
  }
  txt(px + pw / 2, py + ph + 54, "closing speed INTO the wall  (km/h)", { anchor: "middle", size: 16, op: 0.85 });
  txt(px - 66, py + ph / 2, yLabel, {
    anchor: "middle", size: 16, op: 0.85,
  });
  parts[parts.length - 1] = parts[parts.length - 1].replace(
    "<text ", `<text transform="rotate(-90 ${px - 66} ${py + ph / 2})" `
  );
  for (const [fn, col, w, label] of series) {
    const d = xs.map((v, i) => `${i ? "L" : "M"}${X(v).toFixed(1)},${Y(Math.min(fn(v), ymax)).toFixed(1)}`).join("");
    parts.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}"/>`);
    parts.push(`<circle cx="${px + pw - 300}" cy="${py + 24 + series.indexOf(series.find((s) => s[3] === label)) * 26}" r="6" fill="${col}"/>`);
    txt(px + pw - 282, py + 30 + series.indexOf(series.find((s) => s[3] === label)) * 26, label, { size: 16 });
  }
}

txt(PAD, 46, "BARRIER BOUNCE — what a hit gives back", { size: 30, weight: 700 });
txt(PAD, 74, "game/physics.ts WALL, read live. Before = the flat 1.07 reflection collide.ts hardcoded at every contact.",
  { size: 16, op: 0.75 });

const PW = W - PAD * 2, PH = 300;
panel(PAD, 130, PW, PH, "REBOUND SPEED OFF THE WALL", 7, "rebound out (m/s)", [
  [beforeOut, BEFORE, 2.6, "before (flat e = 0.07)"],
  [afterOut, AFTER, 3.4, "after"],
], WALL.dead);

panel(PAD, 130 + PH + 118, PW, PH, "RESTITUTION  e  (before the 6 m/s rebound cap)", 0.5, "e", [
  [() => 0.07, BEFORE, 2.6, "before"],
  [(v) => WALL.bounce(v), AFTER, 3.4, "after"],
], WALL.dead);

/* Panel 3 is a bar pair, not a curve: the measured lean-on result. */
const p3y = 130 + (PH + 118) * 2;
parts.push(`<rect x="${PAD}" y="${p3y}" width="${PW}" height="${PH - 60}" fill="#12151c" stroke="${GRID}"/>`);
txt(PAD, p3y - 16, "THE STUCK BUG — 6° lean on a barrier at 120 km/h, throttle held", { size: 20, weight: 600 });
const bars = [["before", 18.2, BEFORE], ["after", 116.2, AFTER]];
bars.forEach(([label, v, col], i) => {
  const by = p3y + 46 + i * 92, bw = (v / 130) * (PW - 300);
  parts.push(`<rect x="${PAD + 150}" y="${by}" width="${bw.toFixed(1)}" height="54" fill="${col}"/>`);
  txt(PAD + 134, by + 36, label, { anchor: "end", size: 20 });
  txt(PAD + 164 + bw, by + 36, `${v.toFixed(0)} km/h after 4 s`, { size: 20, weight: 600 });
});
txt(PAD + 150, p3y + PH - 76, "entered at 120 km/h  —  test/barrier-bounce-sim.mjs", { size: 15, op: 0.7 });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(`wrote ${OUT}`);
console.log(`dead zone ends at ${(WALL.dead * 3.6).toFixed(1)} km/h closing; ` +
  `peak e ${WALL.peak} at ${(WALL.full * 3.6).toFixed(0)}-${(WALL.soft * 3.6).toFixed(0)} km/h; ` +
  `rebound capped at ${WALL.capOut} m/s`);
