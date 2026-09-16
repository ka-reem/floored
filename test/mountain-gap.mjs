/* MOUNTAIN <-> HIGHWAY CLEARANCE HARNESS.

   The reported symptom: the mountain geometry clips into the main highway at
   the end of the mountain exit and the beginning of the mountain entrance.

   So: measure, in metres, how far every piece of the mountain route sits from
   the main deck's pavement edge, all the way through both gores. A POSITIVE
   number is clearance east of the deck edge; a NEGATIVE one is the thing
   standing ON the highway, and its magnitude is the bug.

   Three families are measured separately, because they fail for different
   reasons and are fixed in different places:

     PAVEMENT  the mountain's own road surface (routegraph hwR edge)
     PARAPET   the stone wall on the rock (west) side of the pass
     ROCK      the cut face + back flank swept in highway.ts buildMountainRoad

   The rock and parapet extents are RE-DERIVED here from the same formulas
   highway.ts uses (that module imports three.js and cannot run headless), so
   if those constants move, move them here too.

   Usage: node test/mountain-gap.mjs [--git <ref>] [--json out.json]
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const REF = arg("--git", "");
const JSON_OUT = arg("--json", "");
const TITLE = arg("--title", REF ? `at ${REF}` : "working tree");

/* game/util.ts is in the list because corridor.ts and ramps.ts import it;
   compiling from a copy means every source they reach has to be copied too. */
const SRC = ["game/world/corridor.ts", "game/world/ramps.ts", "game/world/routegraph.ts",
  "game/world/const.ts", "game/util.ts"];
const work = mkdtempSync(path.join(tmpdir(), "mtngap-"));
/* Always compile from a COPY, never from the repo root: a tsconfig.json
   beside the sources makes some TypeScript versions refuse a file list
   outright, and which version npx picks here is not stable. */
const root = path.join(work, "src");
for (const f of SRC) {
  mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
  writeFileSync(path.join(root, f), REF
    ? execFileSync("git", ["show", `${REF}:${f}`], { encoding: "utf8", maxBuffer: 1 << 26 })
    : readFileSync(f, "utf8"));
}
const js = path.join(work, "js");
execFileSync("npx", ["tsc", ...SRC, "--outDir", js, "--rootDir", ".",
  "--module", "esnext", "--target", "es2020", "--moduleResolution", "bundler",
  "--skipLibCheck"], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
const dir = path.join(js, "game", "world");
for (const f of ["corridor.js", "ramps.js", "routegraph.js", "const.js"]) {
  const p = path.join(dir, f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w\/]+)"/g, '"$1.js"'));
}
const { getCorridor } = await import(path.join(dir, "corridor.js"));
const { getRouteGraph, MTN } = await import(path.join(dir, "routegraph.js"));
const cor = getCorridor();
const mt = getRouteGraph().mtn;
const st = mt.stations;

/* ---- highway.ts buildMountainRoad constants, re-derived ---- */
const WALL_T = 0.3;
const sstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const rockKs = (s) => sstep((s - 18) / 50) * sstep((mt.len - 22 - s) / 50);
/* the scenery limit routegraph measures beside each station, and the two
   things highway.ts does with it (see buildMountainRoad). It reads Infinity
   on a revision that predates the fix, which collapses both back to the old
   unclamped behaviour — so one harness measures both sides of it. */
const lim = (s) => (typeof mt.westLimit === "function" ? mt.westLimit(s) : Infinity);
const wlim = (s, lat) => Math.min(lat, lim(s));
const rockK = (s, hwR) => rockKs(s) * sstep((lim(s) - (hwR + 1.0)) / 9);
/** the west (rock) side pieces, as lateral offsets from the station centre,
    most-westward first. lat is NEGATIVE toward the deck. */
function westPieces(p) {
  const sh = mt.sharedSides(p.s);
  const { hwL, hwR } = mt.halfWidths(p.s);
  const out = [];
  const K = rockK(p.s, hwR);
  out.push({ kind: "PAVEMENT", lat: -hwR, y: p.y - hwR * p.bank });
  if (!sh.shR && hwR >= 0.55 && K < 0.7)
    out.push({ kind: "PARAPET", lat: -(hwR + 0.06 + WALL_T), y: p.y });
  if (!sh.shR && K > 0.02) {
    // the back flank reaches the flat bank at y = 0.02, 12 m out from the edge
    out.push({ kind: "ROCK", lat: -wlim(p.s, hwR + 12), y: 0.02 });
    out.push({ kind: "ROCK", lat: -wlim(p.s, hwR + 4.6 + 1.6), y: p.y + 6.4 });
  }
  /* the four waypoint lamps: the two gore-mouth ones sit at s = 14 and
     len − 16, on the rock side, 5.6 m of pole */
  for (const ls of [14, mt.len - 16])
    if (Math.abs(p.s - ls) < 0.51)
      out.push({
        kind: "LAMP",
        lat: hwR + 0.55 <= lim(ls) ? -(hwR + 0.55) : hwL + 1.35,
        y: p.y,
      });
  return { out, hwL, hwR, sh };
}

/** clearance of a mountain-frame lateral offset from the deck's east edge */
function clearance(p, lat) {
  const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
  const zc = cor.zAt(x, z);
  return { gap: cor.latAt(x, z) - cor.halfWidth(zc), zc, deckY: cor.centerY(zc) };
}

const rows = [];
for (const p of st) {
  const { out, hwL, hwR, sh } = westPieces(p);
  const rec = { s: p.s, z: p.z, x: p.x, y: p.y, hwL, hwR, shR: sh.shR, shL: sh.shL, k: {} };
  for (const w of out) {
    const c = clearance(p, w.lat);
    const dy = w.y - c.deckY;
    const prev = rec.k[w.kind];
    if (!prev || c.gap < prev.gap) rec.k[w.kind] = { gap: c.gap, dy, zc: c.zc, lat: w.lat };
  }
  rows.push(rec);
}

/* a piece only CLIPS the highway if it is laterally inside the deck edge AND
   at a height where the deck's own structure is: the deck slab is ~1 m thick
   and the parapet ~1.1 m tall, so anything within [-2.0, +1.4] of deck
   centre height is interpenetrating something a player can see or hit. */
const HIT_LO = -2.0, HIT_HI = 1.4;
const clips = (r, kind) => {
  const v = r.k[kind];
  return v && v.gap < 0 && v.dy > HIT_LO && v.dy < HIT_HI;
};
/* the rock back flank runs from the crest all the way to the ground, so it
   spans the deck height whenever it is laterally inside — treat it as a
   vertical curtain rather than a point. */
const clipsRock = (r) => r.k.ROCK && r.k.ROCK.gap < 0;

const KINDS = ["PAVEMENT", "PARAPET", "ROCK", "LAMP"];
const summary = { title: TITLE, len: mt.len, half: MTN.half, junctions: {} };
for (const [name, sLo, sHi] of [["DIVERGE", 0, 170], ["MERGE", mt.len - 170, mt.len]]) {
  const win = rows.filter((r) => r.s >= sLo && r.s <= sHi);
  const j = {};
  for (const kind of KINDS) {
    let worst = null, n = 0;
    for (const r of win) {
      const hit = kind === "ROCK" ? clipsRock(r) : clips(r, kind);
      const v = r.k[kind];
      if (!v) continue;
      if (hit) n++;
      if (!worst || v.gap < worst.gap) worst = { ...v, s: r.s, z: r.z };
    }
    j[kind] = { worstGap: worst ? worst.gap : null, worstS: worst ? worst.s : null,
      worstZ: worst ? worst.z : null, worstDy: worst ? worst.dy : null, nClipping: n };
  }
  summary.junctions[name] = j;
}

const f = (v, w = 8) => (v === null ? "    n/a " : v.toFixed(2).padStart(w));
console.log(`\n=== mountain <-> highway clearance — ${TITLE} ===`);
console.log(`   pass ${mt.len.toFixed(0)} m long, pavement ${(2 * MTN.half).toFixed(2)} m wide`);
for (const name of ["DIVERGE", "MERGE"]) {
  console.log(`\n  ${name}`);
  console.log(`    piece      worst gap   at s      at z     dy(deck)   stations clipping`);
  for (const kind of KINDS) {
    const v = summary.junctions[name][kind];
    console.log(`    ${kind.padEnd(9)} ${f(v.worstGap)} m ${f(v.worstS, 7)}  ${f(v.worstZ, 8)}  ${f(v.worstDy, 7)}      ${String(v.nClipping).padStart(4)}`);
  }
}

/* per-station dump around each gore — the numbers the clearance diagram is
   drawn from */
if (process.argv.includes("--dump")) {
  console.log("\n  s      z        hwR   shR   pavGap  wallGap  rockGap");
  for (const r of rows) {
    if (!(r.s < 170 || r.s > mt.len - 170)) continue;
    if (Math.round(r.s) % 4) continue;
    const g = (k) => (r.k[k] ? r.k[k].gap.toFixed(2).padStart(7) : "      -");
    console.log(`  ${r.s.toFixed(0).padStart(4)} ${r.z.toFixed(0).padStart(7)} ${r.hwR.toFixed(2).padStart(6)}  ${r.shR ? "T" : "F"}  ${g("PAVEMENT")} ${g("PARAPET")} ${g("ROCK")}`);
  }
}

const worst = Math.min(...KINDS.flatMap((k) =>
  ["DIVERGE", "MERGE"].map((n) => summary.junctions[n][k].worstGap ?? 1e9)));
console.log(`\n  WORST CLEARANCE ANYWHERE AT A GORE: ${worst.toFixed(2)} m` +
  (worst < 0 ? "  <-- INTERPENETRATING THE DECK" : "  (clear)"));
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ summary, rows }, null, 1));
  console.log(`  wrote ${JSON_OUT}`);
}
