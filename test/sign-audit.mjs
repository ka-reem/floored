/* SIGN AUDIT — every sign in the world, checked without a browser.

   Three faults are separated because they have three different causes:

     FACING   the sign's face normal must point back DOWN the road at the
              driver who has to read it. Scored as dot(faceNormal, travel):
              −1 is dead-on, 0 is edge-on/broadside, +1 is a board readable
              only from behind. PASS wants dot ≤ −0.5.
     SIDE     the mast must stand on the same shoulder as the feature it
              announces. A left exit signed from the right-hand post hangs its
              panel over the lanes the exit does not concern.
     ARROW    the glyph on the face (or on the pavement) must point the way
              the geometry actually goes. A normal test cannot catch a
              mirrored arrow, so every arrow is compared against the side its
              ramp really leaves or joins on.

   HANDEDNESS, derived rather than assumed — every SIDE verdict rests on it:
     · const.ts: the expressway is ONE-WAY, south→north, increasing z.
     · forward +z, up +y, right-handed basis ⇒ the driver's LEFT is +x. This
       is the same derivation cockpit.ts spells out for the cabin ("with
       forward at +z and up at +y a right-handed basis puts left at +x").
     · corridor lateral offset is measured toward +x, so lat > 0 is the
       driver's LEFT (east, river) and lat < 0 the driver's RIGHT (west,
       town). corridor.laneOffset's own comment agrees: lane 0, the most
       negative offset, is "the driver's right ... the slow lane and the one
       the ramps serve".
     · so: the main deck's two town gores and the bypass diverge are RIGHT
       exits; the bypass merge and the whole mountain route are on the LEFT
       (corridor.MTN: "gore noses, east side (+lat) both — the lap's first
       left exit").

   Usage: node test/sign-audit.mjs [--svg plan.svg] [--git <ref>]
     --git audits the tree as it was at a commit, so the before/after tables
     and diagrams come out of one script.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const REF = arg("--git", "");
const SVG = arg("--svg", "");
const TITLE = arg("--title", REF ? `at ${REF}` : "working tree");

const SRC = ["game/world/corridor.ts", "game/world/ramps.ts", "game/world/routegraph.ts",
  "game/world/const.ts", "game/world/signplan.ts", "game/util.ts"];
const work = mkdtempSync(path.join(tmpdir(), "signaudit-"));
let root = process.cwd();
if (REF) {
  root = path.join(work, "src");
  for (const f of SRC) {
    let txt = "";
    try {
      txt = execFileSync("git", ["show", `${REF}:${f}`], { encoding: "utf8", maxBuffer: 1 << 26 });
    } catch {
      continue; // signplan.ts does not exist before this lane
    }
    mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(root, f), txt);
  }
}
const have = SRC.filter((f) => existsSync(path.join(root, f)));
const js = path.join(work, "js");
execFileSync("npx", ["tsc", "--ignoreConfig", ...have, "--outDir", js, "--rootDir", ".",
  "--module", "esnext", "--target", "es2020", "--moduleResolution", "bundler",
  "--skipLibCheck"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
for (const f of have) {
  const p = path.join(js, f.replace(/\.ts$/, ".js"));
  writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w/]+)"/g, '"$1.js"'));
}
const W = path.join(js, "game", "world");
const cormod = await import(path.join(W, "corridor.js"));
const { getCorridor, SIGN, PITCH, TOLL, MTN, signPlan, tunnels } = cormod;
const { DIVERGE_Z, MERGE_Z } = await import(path.join(W, "routegraph.js"));
const { buildRamps, parapetGap } = await import(path.join(W, "ramps.js"));
const { CONNECT_Z, RAMP_LEAD, LOOP_LEN, FRONT_X } = await import(path.join(W, "const.js"));
const cor = getCorridor();

/* signplan.ts is this lane's own module; when auditing an older ref it is not
   there, so fall back to the plan highway.ts hard-coded at that revision —
   every board on the west post, which is the thing under audit. */
let boardPlan, mastLat, MTN_BOARD_Z;
try {
  ({ boardPlan, mastLat, MTN_BOARD_Z } = await import(path.join(W, "signplan.js")));
} catch {
  const BYPASS_BOARD_D = [800, 400, 200];
  const wz = (z) => (z < -LOOP_LEN / 2 ? z + LOOP_LEN : z);
  MTN_BOARD_Z = () => [wz(MTN.divergeZ - 390), wz(MTN.divergeZ - 190), wz(MTN.divergeZ - 24),
    wz(MTN.divergeZ - 96), MTN.mergeZ - 90];
  mastLat = (z, side) => cor.edgeLat(z, side) + side * SIGN.POST_OUT;
  boardPlan = () => {
    const out = [];
    for (const s of signPlan())
      out.push({
        id: `${s.kind}@${Math.round(s.z)}`, z: s.z, w: s.w, h: s.h, side: -1,
        serves: s.kind === "toll" ? 0 : -1,
        face: s.kind === "merge" ? { t: "merge", dist: s.dist } : { t: "guide" },
      });
    for (const d of BYPASS_BOARD_D)
      out.push({ id: `bypass-count@${DIVERGE_Z - d}`, z: DIVERGE_Z - d, w: 9.4, h: 3.3,
        side: -1, serves: -1, face: { t: "guide" } });
    out.push({ id: `bypass-gore@${DIVERGE_Z - 40}`, z: DIVERGE_Z - 40, w: 7.4, h: 7.4 / 2.848,
      side: -1, serves: -1, face: { t: "guide" } });
    out.push({ id: `bypass-merge@${MERGE_Z - 80}`, z: MERGE_Z - 80, w: 6.6, h: 2.5,
      side: -1, serves: 1, face: { t: "merge", dist: 80 } });
    const [b400, b200, bGore, bOneWay, bMerge] = MTN_BOARD_Z();
    const MB = 7.4;
    for (const [z, d] of [[b400, 400], [b200, 200]])
      out.push({ id: `mtn-count@${Math.round(z)}`, z, w: MB, h: MB / 2.848, side: -1, serves: 1,
        face: { t: "guide" } });
    out.push({ id: `mtn-gore@${Math.round(bGore)}`, z: bGore, w: MB, h: MB / 2.848,
      side: -1, serves: 1, face: { t: "guide" } });
    out.push({ id: `mtn-oneway@${Math.round(bOneWay)}`, z: bOneWay, w: 6.6, h: 2.5,
      side: -1, serves: 1, face: { t: "warn" } });
    out.push({ id: `mtn-merge@${Math.round(bMerge)}`, z: bMerge, w: 6.6, h: 2.5,
      side: -1, serves: 1, face: { t: "warn" } });
    return out.sort((a, b) => a.z - b.z);
  };
}

/* ---- how each family of sign is oriented in the code being audited -------
   Read off the emitters so the numbers here are the shipped ones:
     highway.signFactory   panel.rotation.y = PI inside a group at pose.h
     gantry / toll / tunnel portal / nose chevrons   same, or mesh at h + PI
     billboards (scenery)  ry = pose.h + PI - side * 0.18
     ramp-foot sign        gb.rotation.y = PI / 2, a fixed world yaw
   A plane's normal is +z locally, so a yaw of `a` gives (sin a, 0, cos a). */
const norm = (a) => [Math.sin(a), Math.cos(a)];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];

const rows = [];
/** @param face world yaw of the face; @param trav unit travel dir [tx, tz] */
const add = (o) => {
  const n = norm(o.faceYaw);
  const d = dot2(n, o.trav);
  rows.push({ ...o, dot: d });
};

/* ---------------- 1. cantilever boards ---------------- */
const BOARDS = boardPlan();
for (const b of BOARDS) {
  const p = cor.pose(b.z);
  const inTube = cor.inTunnel(b.z);
  // the panel hangs inboard of its post: lat = mast − side * (w/2 + ARM_X)
  const panelLat = mastLat(b.z, b.side) - b.side * (b.w / 2 + SIGN.ARM_X);
  const near = mastLat(b.z, b.side) - b.side * SIGN.ARM_X;
  add({
    group: "cantilever", id: b.id, kind: b.face.t, z: b.z,
    faceYaw: p.h + Math.PI, trav: [p.tx, p.tz],
    side: b.side, serves: b.serves,
    // the lateral band the panel covers, for the "does it hang over the lanes
    // that must read it" test
    span: [Math.min(near, panelLat * 2 - near), Math.max(near, panelLat * 2 - near)],
    built: !inTube,
    arrow: b.face.t === "merge" ? b.arrowFrom ?? -1 : 0,
  });
}

/* ---------------- 2. route gantries ---------------- */
{
  const nearNewGore = (z, r) => [DIVERGE_Z, MERGE_Z, MTN.divergeZ, MTN.mergeZ]
    .some((g) => Math.abs(cor.deltaZ(z, g)) < r);
  for (const z of cor.lattice(PITCH.gantry)) {
    if (cor.inTunnel(z) || (z > TOLL.z0 && z < TOLL.z1)) continue;
    if (CONNECT_Z.some((cz) => Math.abs(z - cz) < 220)) continue;
    if (nearNewGore(z, 220)) continue;
    const p = cor.pose(z);
    add({
      group: "gantry", id: `gantry@${z}`, kind: "route/VMS", z,
      faceYaw: p.h + Math.PI, trav: [p.tx, p.tz], side: 0, serves: 0,
      span: [-cor.halfWidth(z), cor.halfWidth(z)], built: true, arrow: 0,
    });
  }
}

/* ---------------- 3. tunnel portal signage ---------------- */
for (const T of tunnels()) {
  for (const z of [T.z0, T.z1]) {
    const entry = z === T.z0;
    const p = cor.pose(z);
    const hw = cor.halfWidth(z);
    add({ group: "portal", id: `chevrons@${Math.round(z)}`, kind: "hazard chevrons", z,
      faceYaw: p.h + Math.PI, trav: [p.tx, p.tz], side: 0, serves: 0,
      span: [-hw, hw], built: true, arrow: 0 });
    if (!entry) continue;
    add({ group: "portal", id: `clearance@${Math.round(z)}`, kind: "制限高 4.5m", z,
      faceYaw: p.h + Math.PI, trav: [p.tx, p.tz], side: -1, serves: 0,
      span: [-hw - 1.7, -hw], built: true, arrow: 0 });
    add({ group: "portal", id: `speed@${Math.round(z)}`, kind: "60 roundel", z,
      faceYaw: p.h + Math.PI, trav: [p.tx, p.tz], side: 1, serves: 0,
      span: [hw, hw + 1.7], built: true, arrow: 0 });
    add({ group: "portal", id: `name@${Math.round(z)}`, kind: "tunnel name", z,
      faceYaw: p.h + Math.PI, trav: [p.tx, p.tz], side: 0, serves: 0,
      span: [-3.7, 3.7], built: true, arrow: 0 });
  }
}

/* ---------------- 4. toll plaza lane signs + signals ---------------- */
{
  const zc = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
  const p = cor.pose(zc);
  const lanes = cor.lanes(zc);
  for (let k = 0; k < lanes; k++) {
    const lat = cor.laneOffset(k, zc);
    const etc = k > 0 && k < lanes - 1;
    add({ group: "toll", id: `lane${k}@${Math.round(zc)}`, kind: etc ? "ETC" : "一般 CASH",
      z: zc, faceYaw: p.h + Math.PI, trav: [p.tx, p.tz], side: 0, serves: 0,
      span: [lat - 1.45, lat + 1.45], built: true, arrow: 0 });
    add({ group: "toll", id: `signal${k}@${Math.round(zc)}`, kind: "lane signal",
      z: zc, faceYaw: p.h + Math.PI, trav: [p.tx, p.tz], side: 0, serves: 0,
      span: [lat - 0.33, lat + 0.33], built: true, arrow: 0 });
  }
}

/* ---------------- 5. gore nose chevron boards ---------------- */
{
  const ramps = buildRamps(() => 0);
  for (const r of ramps) {
    const isExit = r.kind === "exit";
    const pg = parapetGap(r);
    const nz = (isExit ? pg.z1 : pg.z0) + (isExit ? 1.2 : -1.2);
    const p = cor.pose(nz);
    add({ group: "nose", id: `nose-${r.kind}@${Math.round(nz)}`, kind: "chevron board", z: nz,
      faceYaw: p.h + Math.PI, trav: [p.tx, p.tz], side: -1, serves: -1,
      span: [-cor.halfWidth(nz) - 1.3, -cor.halfWidth(nz) + 0.2], built: true, arrow: 0 });
    /* ---- 6. ramp-foot ground sign: a FIXED world yaw of PI/2, the only sign
       in the world not derived from a pose. The frontage road runs along z at
       x = FRONT_X, so a +x normal is broadside to it — visible from both
       directions of a two-way street, dead-on to neither. */
    add({ group: "rampfoot", id: `foot-${r.kind}`, kind: isExit ? "首都高 OUT ↓" : "首都高 IN ↑",
      z: r.footZ, faceYaw: Math.PI / 2, trav: [0, 1], side: 0, serves: 0,
      span: [0, 0], built: true, arrow: 0, broadside: true,
      note: `frontage road, x=${r.footX.toFixed(0)} (road centre ${FRONT_X})` });
  }
}

/* ---------------- 7. billboards (scenery.ts ad run) ---------------- */
for (const [wz, side] of [[1655, 1], [1748, -1], [1862, 1], [1956, -1],
  [-1985, -1], [-1902, -1]]) {
  const p = cor.pose(wz);
  add({ group: "billboard", id: `ad@${wz}`, kind: "ad panel", z: wz,
    faceYaw: p.h + Math.PI - side * 0.18, trav: [p.tx, p.tz], side, serves: 0,
    span: [0, 0], built: true, arrow: 0 });
}

/* ---- the two arrow facts that are properties of the TEXTURES, read off
   textures.ts / highway.ts rather than recomputed here ---- */
function readArrowFacts() {
  const hw = readFileSync(path.join(root, "game/world/highway.ts"), "utf8");
  const tx = readFileSync(path.join(root, "game/textures.ts"), "utf8");
  // mountain lane arrows: which material do they use?
  const mtnLeft = /arrowMatL|arrowLeft|mirrorArrow/.test(hw);
  // merge glyph: does mergeSignTexF take a side?
  const mergeSided = /export function mergeSignTexF\([^)]*from/.test(tx);
  /* the pass's running-direction arrows: their quad's u ran from −lat to +lat,
     mirroring every other arrow on the map. Fixed = u runs +lat → −lat. */
  const mtnRunFlip = /AW \/ 2\);\s*\n\s*const p1 = mt\.worldOf\(s \+ AL \/ 2, AW \/ 2\)/.test(hw)
    || /mountain arrows share the deck's canvas sense/.test(hw);
  return { mtnLeft, mergeSided, mtnRunFlip };
}
const facts = REF ? { mtnLeft: false, mergeSided: false, mtnRunFlip: false }
  : readArrowFacts();
/** the stock pavement arrow bends toward the driver's right */
const DECK_ARROW_DIR = -1;
/** the mountain lane arrows: the stock (right-bending) material, or a mirror */
const MTN_ARROW_DIR = facts.mtnLeft ? +1 : DECK_ARROW_DIR;
/** mergeSignTexF draws its side stream to the LEFT of the through stream, so
    the glyph says "joining from the driver's left" unless it is given a side */
const MERGE_GLYPH_FROM = facts.mergeSided ? null : +1;

/* ---------------- arrow checks (a normal test cannot see these) --------- */
/* Every direction below is a SIDE in the corridor's own sign convention:
   +1 = the driver's LEFT (+lat, east), −1 = the driver's RIGHT (−lat, west).

   Pavement arrows: flatQuad() bakes the plane flat and yaws by PI, so canvas
   +x lands on the driver's RIGHT (highway.ts says exactly that where arrowTex
   is drawn) and the stock glyph, which curves toward canvas +x, bends RIGHT
   (−1). `dir` is the side the glyph points at, `want` the side the geometry
   really goes. */
const arrows = [];
const auxLat = (z) => {
  const a = cor.auxWidth(z);
  return a > 2 ? -(cor.halfWidth(z) + a / 2) : -(cor.halfWidth(z) - 1.9);
};
for (const d of [44, 84, 124, 164])
  arrows.push({ id: `exit1-lane-arrow@${CONNECT_Z[0] - d}`, z: CONNECT_Z[0] - d,
    lat: auxLat(CONNECT_Z[0] - d), dir: DECK_ARROW_DIR, want: -1,
    what: "EXIT 1 deceleration lane" });
for (let k = 0; k < 3; k++) {
  const z = DIVERGE_Z - 34 - k * 26;
  arrows.push({ id: `bypass-lane-arrow@${z}`, z, lat: -(cor.halfWidth(z) - 1.9) + 0.5,
    dir: DECK_ARROW_DIR, want: -1, what: "bypass diverge kerb lane" });
}
{
  const wz = (z) => (z < cor.Z0 ? z + cor.LOOP : z);
  const latA = (z) => cor.laneOffset(Math.round(cor.laneCount(z)) - 1, z) - 0.5;
  for (let k = 0; k < 3; k++) {
    const z = wz(MTN.divergeZ - 34 - k * 26);
    arrows.push({ id: `mtn-lane-arrow@${Math.round(z)}`, z, lat: latA(z),
      dir: MTN_ARROW_DIR, want: +1, what: "EXIT 4 (mountain) fast lane" });
  }
}
/* the pass's own running-direction arrows: one lane, no divergence, so the
   only thing to check is that the glyph is not MIRRORED against every other
   arrow in the world (its quad's u ran the other way round) */
arrows.push({ id: "mtn-running-arrows", z: NaN, lat: NaN,
  dir: facts.mtnRunFlip ? DECK_ARROW_DIR : -DECK_ARROW_DIR, want: DECK_ARROW_DIR,
  what: "pass running-direction arrows, canvas sense vs the deck's" });
/* lane-drop "lane ends, merge" arrows: the lane that runs out is always the
   outermost LEFT one (lanes stay centred), so a right bend is right */
arrows.push({ id: "lane-drop-arrows", z: NaN, lat: NaN, dir: DECK_ARROW_DIR, want: -1,
  what: "lane-drop taper, closing lane is the leftmost", drop: true });
/* the merge board's own glyph: the side stream folding in */
for (const b of BOARDS.filter((b) => b.face.t === "merge")) {
  const from = b.id.startsWith("bypass") ? 1 : -1; // where the stream joins from
  arrows.push({ id: `merge-board-glyph:${b.id}`, z: b.z, lat: NaN,
    dir: MERGE_GLYPH_FROM === null ? from : MERGE_GLYPH_FROM, want: from, board: true,
    what: `merge board arrow vs the stream's real side` });
}

/* ============================== report ================================== */
const PASS_DOT = -0.5;
const built = rows.filter((r) => r.built);
let fFacing = 0, fSide = 0, fArrow = 0;
const verdict = (r) => {
  const bad = [];
  if (!r.broadside && r.dot > PASS_DOT) bad.push("FACING");
  else if (r.broadside && Math.abs(r.dot) > 0.5) bad.push("FACING");
  if (r.serves !== 0 && r.side !== 0 && r.side !== r.serves) bad.push("SIDE");
  return bad;
};
const L = [];
L.push(`SIGN AUDIT — ${TITLE}`);
L.push("");
L.push("RULE: one-way corridor in +z; forward +z & up +y ⇒ driver's LEFT is +x.");
L.push("      lat<0 = west = driver's RIGHT (town, aux lanes, EXIT 1/2, bypass diverge)");
L.push("      lat>0 = east = driver's LEFT  (fast lane, bypass merge, EXIT 4 mountain)");
L.push("      a sign facing its reader has dot(face normal, travel) ≈ −1.");
L.push("");
L.push("id                             group       z        side  serves  panel lat span   dot     verdict");
L.push("-".repeat(104));
for (const r of built.sort((a, b) => a.z - b.z)) {
  const bad = verdict(r);
  if (bad.includes("FACING")) fFacing++;
  if (bad.includes("SIDE")) fSide++;
  const sp = r.span[0] === r.span[1] ? "     —      "
    : `${r.span[0].toFixed(1).padStart(6)}…${r.span[1].toFixed(1).padStart(5)}`;
  L.push([
    r.id.padEnd(30), r.group.padEnd(11),
    (Number.isFinite(r.z) ? Math.round(r.z) : "—").toString().padStart(6),
    String(r.side).padStart(5), String(r.serves).padStart(7),
    sp.padStart(14), r.dot.toFixed(3).padStart(8),
    "  " + (bad.length ? "FAIL " + bad.join("+") : "PASS"),
  ].join(" "));
}
L.push("");
L.push("ARROWS — direction of the glyph vs the side the geometry really goes");
L.push("id                                  z     glyph   geometry   verdict   what");
L.push("-".repeat(104));
const S = (v) => (v === null ? "per-board" : v > 0 ? "left " : "right");
for (const a of arrows) {
  const ok = a.dir === null || a.dir === a.want;
  if (!ok) fArrow++;
  L.push([
    a.id.padEnd(35),
    (Number.isFinite(a.z) ? Math.round(a.z) : "—").toString().padStart(6),
    S(a.dir).padStart(8), S(a.want).padStart(10),
    "  " + (ok ? "PASS" : "FAIL").padEnd(8), a.what,
  ].join(" "));
}
L.push("");
L.push(`${built.length} signs + ${arrows.length} arrow checks — ` +
  `FACING ${fFacing} fail, SIDE ${fSide} fail, ARROW ${fArrow} fail`);
const txt = L.join("\n");
console.log(txt);

/* ---------------- top-down plan of the boards ---------------- */
if (SVG) {
  const Z0 = -2100, Z1 = 2100, SC = 0.36, PAD = 60;
  const wpx = (Z1 - Z0) * SC / 4 + PAD * 2, hpx = 560;
  const X = (z) => PAD + ((z - Z0) * SC) / 4;
  const Y = (lat) => hpx / 2 - lat * 4.2;
  const e = [];
  e.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${wpx}" height="${hpx}" viewBox="0 0 ${wpx} ${hpx}">`);
  e.push(`<rect width="100%" height="100%" fill="#12151b"/>`);
  e.push(`<text x="${PAD}" y="26" fill="#e7edf5" font-family="sans-serif" font-size="17" font-weight="700">Sign placement — ${TITLE}</text>`);
  e.push(`<text x="${PAD}" y="46" fill="#8b96a6" font-family="sans-serif" font-size="12">top-down · driver travels left→right (+z) · UP on this page is the driver's LEFT (+x, east)</text>`);
  // pavement
  let up = [], dn = [];
  for (let z = Z0; z <= Z1; z += 10) {
    up.push(`${X(z)},${Y(cor.edgeLat(z, 1))}`);
    dn.unshift(`${X(z)},${Y(cor.edgeLat(z, -1))}`);
  }
  e.push(`<polygon points="${up.concat(dn).join(" ")}" fill="#232833"/>`);
  e.push(`<line x1="${PAD}" y1="${Y(0)}" x2="${wpx - PAD}" y2="${Y(0)}" stroke="#39414f" stroke-dasharray="7 7"/>`);
  // features
  const feat = [
    [CONNECT_Z[0], -1, "EXIT 1"], [CONNECT_Z[1], -1, "entrance"],
    [DIVERGE_Z, -1, "bypass out"], [MERGE_Z, 1, "bypass in"],
    [MTN.divergeZ, 1, "EXIT 4"], [MTN.mergeZ, 1, "pass in"],
    [(TOLL.plazaZ0 + TOLL.plazaZ1) / 2, 0, "toll"],
  ];
  for (const [z, s, nm] of feat) {
    e.push(`<circle cx="${X(z)}" cy="${Y(s * (cor.halfWidth(z) + 3))}" r="4" fill="#ffb020"/>`);
    e.push(`<text x="${X(z)}" y="${Y(s * (cor.halfWidth(z) + 3)) + (s >= 0 ? -10 : 18)}" fill="#ffb020" font-family="sans-serif" font-size="11" text-anchor="middle">${nm}</text>`);
  }
  for (const r of built.filter((b) => b.group === "cantilever")) {
    const bad = verdict(r);
    const col = bad.length ? "#ff5a5a" : "#59d98a";
    const y0 = Y(r.span[0]), y1 = Y(r.span[1]);
    e.push(`<line x1="${X(r.z)}" y1="${y0}" x2="${X(r.z)}" y2="${y1}" stroke="${col}" stroke-width="4"/>`);
    const my = Y(mastLat(r.z, r.side));
    e.push(`<circle cx="${X(r.z)}" cy="${my}" r="3.4" fill="${col}"/>`);
    // facing tick: the face looks back down the road (−z), i.e. left on page
    e.push(`<line x1="${X(r.z)}" y1="${(y0 + y1) / 2}" x2="${X(r.z) - 9}" y2="${(y0 + y1) / 2}" stroke="${col}" stroke-width="2"/>`);
    e.push(`<text x="${X(r.z)}" y="${my + (r.side > 0 ? -8 : 14)}" fill="${col}" font-family="sans-serif" font-size="9" text-anchor="middle">${r.id.split("@")[0]}</text>`);
  }
  e.push(`<text x="${PAD}" y="${hpx - 16}" fill="#8b96a6" font-family="sans-serif" font-size="11">green = mast on the shoulder its feature is on · red = wrong shoulder · bar = the lateral band the panel covers · tick = face direction</text>`);
  e.push("</svg>");
  writeFileSync(SVG, e.join("\n"));
  console.error(`wrote ${SVG}`);
}
if (process.argv.includes("--out")) writeFileSync(arg("--out"), txt + "\n");
process.exitCode = 0;
