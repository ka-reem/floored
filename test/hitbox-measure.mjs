#!/usr/bin/env node
/* WHAT THE FLEET IS ACTUALLY AS WIDE AS — measured off the shipped geometry.

   Every collision box in this game is a number in a table: TYPE_DIM in
   game/traffic.ts for the NPCs, `shell` in game/carspecs.ts for the player.
   Nothing had ever checked those numbers against the meshes that are drawn.
   This does. It decodes the vertex positions out of each shipped GLB, pushes
   them through their node transforms, samples the triangle surfaces, and
   reports where the bodywork really is against where the game thinks it is.

   ---- BODY vs PROTRUSION ----
   A door mirror is not a wide car. It is a small blob hung off a narrower
   car, and the thing a driver judges a gap against is the flank behind it.
   So the widest point of a mesh is the WRONG number for a collision box, and
   the report separates the two.

   Separating them by SPAN ALONG THE CAR does not work: a bus's mirror covers
   3% of its length and its front wheel fairing covers 5%, and only one of
   those is bodywork. What does separate them is AREA. Project the sampled
   surface onto the flank plane — length against height — on a 5 cm grid,
   keep the widest |x| in each cell, and ask how much of the car's side
   actually reaches a given width:

     - a car's door mirror is one blob roughly 0.2 m long and 0.15 m tall,
       about 0.03 m^2; a bus's is about 0.12 m^2;
     - a fender bulge, a wheel arch, a sill, a bus's wheel fairing all run to
       several tenths of a square metre.

   AREA_FRAC is the cut, taken as a fraction of the whole flank (length x
   height) so it means the same thing on a 3.9 m compact and on a 9.4 m bus.
   1.5% of the flank is ~0.10 m^2 on a car and ~0.42 m^2 on the bus: an order
   of magnitude above a mirror and an order of magnitude below any panel.
   `--profile` plots the width along the car so this can be checked style by
   style rather than asserted — that is how the number was chosen, and the
   plots are in the gallery for the same reason.

   Names would have been better than a rule, but there are none left: these
   GLBs are baked down to ONE merged, indexed mesh per style (see
   tools/build-orchids-models.mjs), so mirrors, aerials and roof bars all
   arrive as anonymous triangles inside the same primitive. The rule has to
   work on geometry alone.

   ---- The player ----
   The player's donor shell is not shipped pre-fitted the way the NPCs are:
   game/bodymodel.ts fits it at runtime, non-uniformly, to (W + 0.18) x roof
   x L and then shifts it along z to line the AXLES up rather than the boxes.
   Both are reproduced here so the numbers printed are the ones the player
   actually drives around inside.

   Usage: node test/hitbox-measure.mjs             the table
          node test/hitbox-measure.mjs --profile   width profiles too
          node test/hitbox-measure.mjs --only bus  one style
          node test/hitbox-measure.mjs --json      machine-readable
*/
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import * as fs from "node:fs";
import * as path from "node:path";

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    "draco3d.decoder": await draco.createDecoderModule(),
    "meshopt.decoder": MeshoptDecoder,
  });

const CELL = 0.05;
const AREA_FRAC = 0.015;
/* Barycentric sample spacing on a triangle. --fast doubles it and skips the
   two end grids, which is enough for the width PROFILE the plot draws (a 7 cm
   sample on a 5 cm bin) and about five times cheaper — worth having on a
   shared box. The half-extents in the table are always measured at the fine
   spacing. */
let STEP = 0.035;
const SLICES = 60;

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
const apply = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/** Walk a document's triangles, in scene space, without materialising them. */
function eachTriangle(doc, fn) {
  const walk = (node, m) => {
    const w = mul(m, node.getMatrix());
    const mesh = node.getMesh();
    if (mesh)
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute("POSITION");
        if (!pos) continue;
        const a = pos.getArray();
        const idxA = prim.getIndices();
        const idx = idxA ? idxA.getArray() : null;
        const count = idx ? idx.length : a.length / 3;
        const at = (k) => {
          const q = (idx ? idx[k] : k) * 3;
          return apply(w, a[q], a[q + 1], a[q + 2]);
        };
        for (let k = 0; k + 2 < count; k += 3) fn(at(k), at(k + 1), at(k + 2));
      }
    for (const c of node.listChildren()) walk(c, w);
  };
  for (const scene of doc.getRoot().listScenes())
    for (const n of scene.listChildren()) walk(n, IDENT);
}

/** Sample a triangle's surface on a ~STEP grid. Vertices alone are not
    enough: the bus body is 272 triangles, so a whole flank is two of them and
    a vertex cloud has nothing at all between the corners. */
function sampleTri(a, b, c, pt) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const l1 = Math.hypot(e1[0], e1[1], e1[2]);
  const l2 = Math.hypot(e2[0], e2[1], e2[2]);
  const n = Math.min(64, Math.max(1, Math.ceil(Math.max(l1, l2) / STEP)));
  for (let i = 0; i <= n; i++)
    for (let j = 0; i + j <= n; j++) {
      const u = i / n, v = j / n;
      pt(a[0] + e1[0] * u + e2[0] * v, a[1] + e1[1] * u + e2[1] * v,
         a[2] + e1[2] * u + e2[2] * v);
    }
}

/** Everything the report needs, accumulated in one streaming pass — the point
    cloud itself is never kept (it runs to millions of samples per style). */
function measure(doc, xf, bboxOnly = false, profOnly = false) {
  const bb = {
    x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity,
  };
  const flank = new Map();   // (z,y) cell -> max |x|
  const front = new Map();   // (x,y) cell -> max  z
  const rear = new Map();    // (x,y) cell -> max -z
  const prof = new Map();    // z cell    -> max |x|
  const key = (a, b) => `${Math.round(a / CELL)},${Math.round(b / CELL)}`;
  const bump = (m, k, v) => { const c = m.get(k); if (c === undefined || v > c) m.set(k, v); };
  eachTriangle(doc, (a, b, c) => sampleTri(a, b, c, (x, y, z) => {
    if (xf) { x = xf.sx * x + xf.dx; y = xf.sy * y; z = xf.sz * z + xf.dz; }
    if (x < bb.x0) bb.x0 = x;
    if (x > bb.x1) bb.x1 = x;
    if (y < bb.y0) bb.y0 = y;
    if (y > bb.y1) bb.y1 = y;
    if (z < bb.z0) bb.z0 = z;
    if (z > bb.z1) bb.z1 = z;
    if (bboxOnly) return;
    bump(prof, Math.round(z / CELL), Math.abs(x));
    if (profOnly) return;
    bump(flank, key(z, y), Math.abs(x));
    bump(front, key(x, y), z);
    bump(rear, key(x, y), -z);
  }));
  /** The widest value that at least AREA_FRAC of `area` reaches. */
  const cut = (m, area) => {
    const v = [...m.values()].sort((p, q) => q - p);
    const need = Math.max(1, Math.ceil((area * AREA_FRAC) / (CELL * CELL)));
    return v[Math.min(v.length - 1, need - 1)];
  };
  const H = bb.y1 - bb.y0, L = bb.z1 - bb.z0, W = bb.x1 - bb.x0;
  if (bboxOnly) return { bb };
  if (profOnly) return { bb, prof, fullHalfW: Math.max(Math.abs(bb.x0), Math.abs(bb.x1)) };
  return {
    bb,
    fullHalfW: Math.max(Math.abs(bb.x0), Math.abs(bb.x1)),
    bodyHalfW: cut(flank, L * H),
    bodyFront: cut(front, W * H),
    bodyRear: -cut(rear, W * H),
    prof,
  };
}

/* ---- The boxes in force today -----------------------------------------
   NPCs: game/traffic.ts TYPE_DIM, used as n.W / 2 and n.L / 2 in collide.ts's
   obb2 call. Player: game/carspecs.ts `shell`, through player.ts
   halfW = W/2 - 0.005 and halfL = L/2 + 0.02. */
const NPC_DIM = {
  osedan: [4.44, 1.78], ohybrid: [4.54, 1.75], ocompact: [3.94, 1.70],
  osuv: [4.72, 1.89], hybrid: [4.54, 1.75], mhybrid: [4.54, 1.75],
  sedan: [4.44, 1.78], compact: [3.94, 1.70], suv: [4.72, 1.89],
  taxi: [4.44, 1.78], police: [4.44, 1.78], van: [4.64, 1.77],
  truck: [6.3, 2.09], bus: [9.4, 2.25],
};
/* game/carspecs.ts shell + game/bodymodel.ts fit(). Only the Volvo has a
   donor exterior (player.ts BODY_MODEL); every other car is the procedural
   shell, whose flanks land on |x| = W/2 by construction (carshape.ts
   HULL_SKIN) with the mirrors deliberately outside at W/2 + 0.09. */
const PLAYER = {
  volvo: { L: 4.96, W: 1.88, roof: 1.44, wzF: 1.5, wzR: 1.44, donor: "volvo-s90-body-lite" },
  kaze: { L: 4.42, W: 1.84, roof: 1.24, wzF: 1.38, wzR: 1.32, donor: null },
};
const DONOR_AXLE_MID = 0.14;   // bodymodel.ts

const args = process.argv.slice(2);
const SHOW_PROFILE = args.includes("--profile");
const AS_JSON = args.includes("--json");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
/* --fast: profiles only, coarser sampling. The half-extents then come from
   the numbers this file already published (see MEASURED below) rather than
   being re-derived, so a --fast run can draw the picture on a loaded box
   without pretending to have re-measured. */
const FAST = args.includes("--fast");
if (FAST) STEP = 0.07;
/* The fine-sampling result, kept so --fast can draw without re-deriving it.
   Regenerate by running this file without --fast. */
const MEASURED = {
  bus: [1.130, 0.956, 4.683, -4.686], compact: [0.855, 0.784, 1.970, -1.969],
  hybrid: [0.880, 0.741, 2.262, -2.260], mhybrid: [0.880, 0.802, 2.264, -2.267],
  ocompact: [0.855, 0.768, 1.966, -1.970], ohybrid: [0.880, 0.806, 2.261, -2.263],
  osedan: [0.895, 0.784, 2.209, -2.216], osuv: [0.950, 0.824, 2.357, -2.355],
  police: [0.895, 0.879, 2.220, -2.169], sedan: [0.895, 0.774, 2.210, -2.218],
  suv: [0.950, 0.853, 2.358, -2.349], taxi: [0.895, 0.827, 2.215, -2.217],
  truck: [1.050, 0.780, 3.142, -3.150], van: [0.890, 0.740, 2.312, -2.316],
  volvo: [1.030, 0.956, 2.499, -2.425], kaze: [1.010, 0.920, 2.210, -2.210],
};

const jobs = [];
for (const f of fs.readdirSync("public/models/cars").sort())
  if (f.endsWith(".glb"))
    jobs.push({
      kind: "npc", style: f.replace(/\.glb$/, ""),
      file: path.join("public/models/cars", f),
    });
for (const [id, P] of Object.entries(PLAYER))
  jobs.push({
    kind: "player", style: id,
    file: P.donor ? `public/models/player/${P.donor}.glb` : null, P,
  });

const rows = [];
for (const j of jobs) {
  if (ONLY && j.style !== ONLY) continue;
  let m;
  if (!j.file) {
    /* Procedural shell: no GLB to measure, and none needed — carshape.ts puts
       the flanks on |x| = W/2 exactly and the nose/tail on |z| = L/2. */
    const P = j.P;
    m = {
      fullHalfW: P.W / 2 + 0.09, bodyHalfW: P.W / 2,
      bodyFront: P.L / 2, bodyRear: -P.L / 2,
      bb: { z0: -P.L / 2, z1: P.L / 2, y0: 0, y1: P.roof, x0: -P.W / 2, x1: P.W / 2 },
      prof: null, procedural: true,
    };
  } else {
    const doc = await io.read(j.file);
    let xf = null;
    if (j.kind === "player") {
      /* bodymodel.ts fit(), reproduced: width to W + 0.18 because the donor's
         own bbox includes its door mirrors, length to L, height about the
         ground, and the whole thing shifted along z onto the AXLES rather
         than onto the box centre. */
      const raw = measure(doc, null, true);
      const P = j.P;
      const sx = (P.W + 0.18) / (raw.bb.x1 - raw.bb.x0);
      const sz = P.L / (raw.bb.z1 - raw.bb.z0);
      const sy = P.roof / raw.bb.y1;
      xf = {
        sx, sy, sz,
        dx: -((raw.bb.x0 + raw.bb.x1) / 2) * sx,
        dz: -((raw.bb.z0 + raw.bb.z1) / 2) * sz + (P.wzF - P.wzR) / 2 - DONOR_AXLE_MID * sz,
      };
    }
    m = measure(doc, xf, false, FAST);
    if (FAST) {
      const k = MEASURED[j.style];
      m.fullHalfW = k[0]; m.bodyHalfW = k[1]; m.bodyFront = k[2]; m.bodyRear = k[3];
    }
  }
  const d = j.kind === "npc" ? NPC_DIM[j.style] : null;
  const colHalfW = d ? d[1] / 2 : j.P.W / 2 - 0.005;
  const colHalfL = d ? d[0] / 2 : j.P.L / 2 + 0.02;
  rows.push({
    kind: j.kind, style: j.style, file: j.file,
    fullHalfW: m.fullHalfW, bodyHalfW: m.bodyHalfW,
    bodyFront: m.bodyFront, bodyRear: m.bodyRear,
    fullFront: m.bb.z1, fullRear: m.bb.z0,
    colHalfW, colHalfL,
    prof: m.prof,
    procedural: !!m.procedural,
  });
}

const f3 = (v) => (Number.isFinite(v) ? (v >= 0 ? " " : "") + v.toFixed(3) : "   -  ");
if (!AS_JSON) {
  console.log(
    "\nCOLLISION BOX vs DRAWN BODY — metres. The box is a rectangle centred on\n" +
    "the vehicle's origin; the body is where the mesh actually is.\n"
  );
  console.log(
    "  style          HALF-WIDTH                      NOSE (+z) / TAIL (-z)\n" +
    "                 mesh   body   box    over       bodyF  boxF   over    " +
    "bodyR  boxR   over"
  );
  console.log("  " + "-".repeat(98));
  for (const r of rows) {
    const wOver = r.colHalfW - r.bodyHalfW;
    const fOver = r.colHalfL - r.bodyFront;
    const rOver = r.bodyRear - -r.colHalfL;
    const tag = r.kind === "player" ? (r.procedural ? " (proc)" : " (donor)") : "";
    console.log(
      `  ${(r.style + tag).padEnd(14)}` +
      `${f3(r.fullHalfW)} ${f3(r.bodyHalfW)} ${f3(r.colHalfW)} ${f3(wOver)}` +
      `${wOver > 0.03 ? " <<" : "   "}   ` +
      `${f3(r.bodyFront)} ${f3(r.colHalfL)} ${f3(fOver)}${fOver > 0.03 ? " <<" : "   "} ` +
      `${f3(r.bodyRear)} ${f3(-r.colHalfL)} ${f3(rOver)}${rOver > 0.03 ? " <<" : ""}`
    );
  }
  console.log(
    "\n  mesh  = widest point drawn (mirrors, aerials, roof bars included)\n" +
    "  body  = widest point reached by at least 1.5% of the flank (see the header)\n" +
    "  box   = the half-extent collide.ts tests with today\n" +
    "  over  = box minus body. POSITIVE means the game reports contact this many\n" +
    "          metres before the two bodies touch on screen, on that side."
  );
}

if (SHOW_PROFILE)
  for (const r of rows) {
    if (!r.prof) continue;
    const ks = [...r.prof.keys()].sort((a, b) => a - b);
    console.log(`\n--- ${r.style}: half-width along the car ---`);
    const peak = Math.max(...r.prof.values());
    const stride = Math.max(1, Math.ceil(ks.length / SLICES));
    for (let i = 0; i < ks.length; i += stride) {
      let v = 0;
      for (let j = i; j < Math.min(ks.length, i + stride); j++) v = Math.max(v, r.prof.get(ks[j]));
      console.log(
        `  z ${(ks[i] * CELL).toFixed(2).padStart(6)}  ${v.toFixed(3)}  ` +
        `${"#".repeat(Math.round((v / peak) * 50))}`
      );
    }
  }

/* The width profile goes into the JSON always, not only with --profile: it is
   the top-down silhouette test/hitbox-plot.mjs draws the boxes over, and
   re-deriving it means re-sampling every mesh. */
const dump = () => JSON.stringify(
  rows.map((r) => ({ ...r, prof: r.prof ? Object.fromEntries(r.prof) : null })), null, 1
);
if (OUT) fs.writeFileSync(OUT, dump());
if (AS_JSON)
  console.log(JSON.stringify(
    rows.map((r) => ({ ...r, prof: r.prof ? Object.fromEntries(r.prof) : undefined })),
    null, 1
  ));
