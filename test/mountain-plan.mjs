/* A true-to-scale PLAN VIEW of the mountain road, drawn from the built route
   itself (routegraph's real stations, both pavement edges), as an SVG.

   Two reasons this exists alongside the photographs. A night dashcam shows
   almost none of the pavement the driver is standing on, so how wide the road
   is and how tight a given corner is are the two questions a screenshot answers
   worst — and they are the whole brief of the 2026-09-08 rebuild. And a plan
   view costs a second of node time, against ~8 minutes to boot the game under
   SwiftShader for one frame.

   It draws the swept pavement (not a centreline), so the width is the real
   width, and it marks the tightest corner with its own radius circle at the
   same scale, which is the only honest way to show what "13 m radius" meant.

   Usage: node test/mountain-plan.mjs --out plan.svg [--git <ref>]
     --git renders the road as it was at some commit, by building that
     revision's three files in a temp dir. That is how the before/after pair
     is made without a second checkout.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const OUT = arg("--out", "mountain-plan.svg");
const REF = arg("--git", "");
const TITLE = arg("--title", REF ? `at ${REF}` : "working tree");

const SRC = ["game/world/corridor.ts", "game/world/ramps.ts", "game/world/routegraph.ts",
  "game/world/const.ts"];
const work = mkdtempSync(path.join(tmpdir(), "mtnplan-"));
let root = process.cwd();
if (REF) {
  root = path.join(work, "src");
  for (const f of SRC) {
    mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(root, f),
      execFileSync("git", ["show", `${REF}:${f}`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  }
}
const js = path.join(work, "js");
execFileSync("npx", ["tsc", ...SRC, "--outDir", js, "--rootDir", ".",
  "--module", "esnext", "--target", "es2020", "--moduleResolution", "bundler",
  "--skipLibCheck"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const dir = path.join(js, "game", "world");
for (const f of ["corridor.js", "ramps.js", "routegraph.js", "const.js"]) {
  const p = path.join(dir, f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w/]+)"/g, '"$1.js"'));
}
const { getCorridor } = await import(path.join(dir, "corridor.js"));
const { getRouteGraph, MTN } = await import(path.join(dir, "routegraph.js"));
const cor = getCorridor();
const mt = getRouteGraph().mtn;

/* geometry: both pavement edges, the deck edge, and the tightest corner */
const L = [], R = [], C = [];
for (const p of mt.stations) {
  const { hwL, hwR } = mt.halfWidths(p.s);
  L.push([p.x + p.nx * hwL, p.z + p.nz * hwL]);
  R.push([p.x - p.nx * hwR, p.z - p.nz * hwR]);
  C.push([p.x, p.z, p.s]);
}
let minR = 1e9, minAt = 0;
for (let i = 2; i < mt.stations.length - 2; i++) {
  const a = mt.stations[i - 2], b = mt.stations[i], c = mt.stations[i + 2];
  let dh = Math.atan2(c.tx, c.tz) - Math.atan2(a.tx, a.tz);
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const k = Math.abs(dh) / Math.max(0.01, c.s - a.s);
  if (k > 1e-6 && 1 / k < minR) { minR = 1 / k; minAt = i; }
}
const width = 2 * MTN.half;

/* deck edge through the same z window, east side */
const deck = [];
for (let z = MTN.divergeZ - 40; z <= MTN.mergeZ + 40; z += 4) {
  const p = cor.pose(z), hw = cor.halfWidth(z);
  deck.push([p.x + hw * p.nx, p.z + hw * p.nz]);
}

const all = [...L, ...R, ...deck];
const xs = all.map((p) => p[0]), zs = all.map((p) => p[1]);
const PAD = 26, SC = 1.05;
const x0 = Math.min(...xs) - 12, x1 = Math.max(...xs) + 12;
const z0 = Math.min(...zs) - 12, z1 = Math.max(...zs) + 12;
/* z runs across the page (the road runs along the deck), x down it */
/* the header line is fixed-width text, so the canvas has to be at least wide
   enough for it or the metrics get clipped off the right edge */
const W = Math.max(760, (z1 - z0) * SC + PAD * 2), H = (x1 - x0) * SC + PAD * 2 + 54;
const px = (x, z) => [PAD + (z - z0) * SC, PAD + (x - x0) * SC];
const poly = (pts) => pts.map(([x, z]) => px(x, z).map((v) => v.toFixed(1)).join(",")).join(" ");

const mid = mt.stations[minAt];
const [cx, cy] = px(mid.x, mid.z);
const nx = mid.nx, nz = mid.nz;
/* the radius circle sits on the INSIDE of the corner, centre one radius along
   the normal — drawn at the same scale as the road, which is the point */
let dh = Math.atan2(mt.stations[minAt + 2].tx, mt.stations[minAt + 2].tz) -
  Math.atan2(mt.stations[minAt - 2].tx, mt.stations[minAt - 2].tz);
while (dh > Math.PI) dh -= 2 * Math.PI;
while (dh < -Math.PI) dh += 2 * Math.PI;
const sgn = Math.sign(dh) || 1;
const [ox, oy] = px(mid.x + sgn * nx * minR, mid.z + sgn * nz * minR);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}">
<rect width="${W.toFixed(0)}" height="${H.toFixed(0)}" fill="#0a0c10"/>
<text x="${PAD}" y="26" fill="#fff" font-size="19" font-weight="700" font-family="ui-sans-serif,system-ui">EXIT 4 — plan view, ${TITLE}</text>
<text x="${PAD}" y="46" fill="#8b98a6" font-size="13" font-family="ui-monospace,monospace">${width.toFixed(1)} m wide  ·  tightest ${minR.toFixed(0)} m radius  ·  ${mt.len.toFixed(0)} m long  ·  drawn to scale</text>
<clipPath id="plot"><rect x="0" y="0" width="${W.toFixed(0)}" height="${(H - 54).toFixed(0)}"/></clipPath>
<g transform="translate(0,54)" clip-path="url(#plot)">
  <polyline points="${poly(deck)}" fill="none" stroke="#7d858f" stroke-width="2" stroke-dasharray="10 7"/>
  <text x="${px(deck[3][0], deck[3][1])[0] + 6}" y="${px(deck[3][0], deck[3][1])[1] - 8}" fill="#7d858f" font-size="12" font-family="ui-monospace,monospace">expressway deck edge</text>
  <polygon points="${poly(L)} ${poly([...R].reverse())}" fill="#5ce1ff" fill-opacity="0.22" stroke="#5ce1ff" stroke-width="1.2"/>
  <circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="${(minR * SC).toFixed(1)}" fill="none" stroke="#ffd27a" stroke-width="1.1" stroke-dasharray="5 5" opacity="0.85"/>
  <line x1="${ox.toFixed(1)}" y1="${oy.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="#ffd27a" stroke-width="1" opacity="0.6"/>
  <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5" fill="#ffd27a"/>
  <text x="${cx.toFixed(1)}" y="${(cy - 11).toFixed(1)}" fill="#ffd27a" font-size="13" text-anchor="middle" font-family="ui-monospace,monospace">tightest corner — R ${minR.toFixed(0)} m</text>
</g></svg>`;
writeFileSync(OUT, svg);
console.log(`${TITLE}: ${width.toFixed(2)} m wide, min radius ${minR.toFixed(1)} m, ${mt.len.toFixed(1)} m long -> ${OUT}`);
