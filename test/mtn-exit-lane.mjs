/* WHICH LANE DOES EXIT 4 LEAVE FROM?

   The question: should an exit leave from the leftmost or rightmost lane by
   default? Tried here on the mountain exit first.

   This draws the answer rather than asserting it: the deck's lanes at the
   mountain diverge, each with its index and lateral offset, the two deck
   edges, and the mountain road peeling off — so it is visible which lane a
   driver has to be in to take the exit, and which lane a real motorway exit
   would leave from.

   Frame: the corridor's own (deck z across, lateral offset from the deck
   centreline up), exact here because both gores sit in the straight, level
   splice band.

   Usage: node test/mtn-exit-lane.mjs --out mtn-exit-lane.svg
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const OUT = arg("--out", "mtn-exit-lane.svg");
const SRC = ["game/world/corridor.ts", "game/world/ramps.ts", "game/world/routegraph.ts",
  "game/world/const.ts", "game/util.ts"];
const work = mkdtempSync(path.join(tmpdir(), "exitlane-"));
const root = path.join(work, "src");
for (const f of SRC) {
  mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
  writeFileSync(path.join(root, f), readFileSync(f, "utf8"));
}
const js = path.join(work, "js");
execFileSync("npx", ["tsc", ...SRC, "--outDir", js, "--rootDir", ".", "--module", "esnext",
  "--target", "es2020", "--moduleResolution", "bundler", "--skipLibCheck"],
  { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
const dir = path.join(js, "game", "world");
for (const f of ["corridor.js", "ramps.js", "routegraph.js", "const.js"]) {
  const p = path.join(dir, f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w\/]+)"/g, '"$1.js"'));
}
const { getCorridor } = await import(path.join(dir, "corridor.js"));
const { getRouteGraph, MTN } = await import(path.join(dir, "routegraph.js"));
const cor = getCorridor();
const mt = getRouteGraph().mtn;

const Z0 = MTN.divergeZ - 60, Z1 = MTN.divergeZ + 110;
const W = 1560, H = 620, PAD_L = 96, PAD_R = 30, PAD_T = 96, PAD_B = 64;
const latLo = -16, latHi = 30;
const px = (z) => PAD_L + ((z - Z0) / (Z1 - Z0)) * (W - PAD_L - PAD_R);
const py = (lat) => PAD_T + ((latHi - lat) / (latHi - latLo)) * (H - PAD_T - PAD_B);
const zs = [];
for (let z = Z0; z <= Z1; z += 2) zs.push(z);

const nLanes = cor.lanes(MTN.divergeZ);
const deck = zs.map((z) => ({ z, hw: cor.halfWidth(z) }));
const band = `<polygon points="${deck.map((d) => `${px(d.z).toFixed(1)},${py(d.hw).toFixed(1)}`).join(" ")} ${[...deck].reverse().map((d) => `${px(d.z).toFixed(1)},${py(-d.hw).toFixed(1)}`).join(" ")}" fill="#5a6270" fill-opacity="0.5" stroke="#98a2b0" stroke-width="1.6"/>`;

/* lane centres and the dashed lines between them */
let lanes = "";
for (let k = 0; k < nLanes; k++) {
  const pts = zs.map((z) => `${px(z).toFixed(1)},${py(cor.laneOffset(k, z)).toFixed(1)}`).join(" ");
  const isExit = k === nLanes - 1, isSlow = k === 0;
  lanes += `<polyline points="${pts}" fill="none" stroke="${isExit ? "#ff5470" : isSlow ? "#5ee08a" : "#8b98a6"}" stroke-width="${isExit || isSlow ? 2.6 : 1.6}" stroke-dasharray="${isExit || isSlow ? "" : "9 8"}"/>`;
  const o = cor.laneOffset(k, MTN.divergeZ);
  const tag = isExit ? "FAST lane — the exit leaves from HERE"
    : isSlow ? "SLOW lane — where a motorway exit would leave from" : "middle lane";
  lanes += `<text x="${(PAD_L + 12).toFixed(1)}" y="${(py(o) - 8).toFixed(1)}" fill="${isExit ? "#ff5470" : isSlow ? "#5ee08a" : "#8b98a6"}" font-size="15" font-weight="${isExit || isSlow ? 700 : 400}" font-family="ui-monospace,monospace">lane ${k}   lat ${o >= 0 ? "+" : ""}${o.toFixed(2)} m   ${tag}</text>`;
}

/* the mountain road's pavement */
const L = [], R = [];
for (const p of mt.stations) {
  const { hwL, hwR } = mt.halfWidths(p.s);
  for (const [lat, arr] of [[hwL, L], [-hwR, R]]) {
    const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
    const zc = cor.zAt(x, z);
    if (zc < Z0 || zc > Z1) continue;
    arr.push([px(zc), py(cor.latAt(x, z))]);
  }
}
const road = `<polygon points="${L.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")} ${[...R].reverse().map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}" fill="#5ce1ff" fill-opacity="0.28" stroke="#5ce1ff" stroke-width="1.6"/>`;

let axis = "";
for (let lat = -15; lat <= 30; lat += 5)
  axis += `<line x1="${PAD_L}" y1="${py(lat).toFixed(1)}" x2="${(W - PAD_R).toFixed(1)}" y2="${py(lat).toFixed(1)}" stroke="#22262e" stroke-width="1"/>` +
    `<text x="${PAD_L - 10}" y="${(py(lat) + 5).toFixed(1)}" fill="#5b6470" font-size="12" text-anchor="end" font-family="ui-monospace,monospace">${lat} m</text>`;
for (let z = Math.ceil(Z0 / 20) * 20; z <= Z1; z += 20)
  axis += `<text x="${px(z).toFixed(1)}" y="${(H - PAD_B + 22).toFixed(1)}" fill="#5b6470" font-size="12" text-anchor="middle" font-family="ui-monospace,monospace">z ${z}</text>`;

const gx = px(MTN.divergeZ);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
 <rect width="${W}" height="${H}" fill="#0a0c10"/>
 <text x="${PAD_L}" y="34" fill="#fff" font-size="24" font-weight="800" font-family="ui-sans-serif,system-ui">EXIT 4 leaves from the FAST lane</text>
 <text x="${PAD_L}" y="58" fill="#8b98a6" font-size="14" font-family="ui-monospace,monospace">${nLanes} lanes, ${cor.lanePitch(MTN.divergeZ).toFixed(2)} m pitch · lane 0 is the driver’s right, the slow lane, and the only side that can carry a deceleration lane</text>
 <text x="${PAD_L}" y="78" fill="#8b98a6" font-size="14" font-family="ui-monospace,monospace">plan view, corridor frame · vertical axis is lateral offset from the deck centreline · to scale</text>
 ${axis}
 ${band}
 ${road}
 ${lanes}
 <line x1="${gx.toFixed(1)}" y1="${PAD_T}" x2="${gx.toFixed(1)}" y2="${(H - PAD_B).toFixed(1)}" stroke="#ffd27a" stroke-width="1.6" stroke-dasharray="7 6"/>
 <text x="${(gx + 8).toFixed(1)}" y="${(PAD_T + 16).toFixed(1)}" fill="#ffd27a" font-size="14" font-family="ui-monospace,monospace">gore nose z ${MTN.divergeZ}</text>
 <text x="${(W - PAD_R - 8).toFixed(1)}" y="${(H - 22).toFixed(1)}" fill="#5b6470" font-size="13" text-anchor="end" font-family="ui-monospace,monospace">lane 0 is ${Math.abs(cor.laneOffset(0, MTN.divergeZ) - 7.7).toFixed(1)} m across the carriageway from the gore · a 200→130 km/h deceleration lane at 2 m/s² needs 446 m; the whole pass spans 324 m of deck z</text>
</svg>`;
writeFileSync(OUT, svg);
console.log(`wrote ${OUT} — exit leaves from lane ${nLanes - 1} of ${nLanes} (the fast lane)`);
