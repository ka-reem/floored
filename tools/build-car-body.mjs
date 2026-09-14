/* Bakes the player car's LOW-RES BODY — everything the dashcam cut throws away.

     node --max-old-space-size=12288 tools/build-car-body.mjs <donor.glb> \
       [--out NAME] [--tris N] [--tex N] [--rest] [--compress MODE] [--no-join] \
       [--chase-bias] [--tex-hi N] [--rear-bias] [--tex-rear N] [--strip] [--dry]

   Run offline, not at build time — the GLB it writes is committed.

   --chase-bias: the budget follows the THIRD-PERSON CAMERA, measured rather
   than named — every mesh is scored by the solid angle it subtends from the
   chase lens and the two rear three-quarters, and that score scales its share
   of the triangle budget and the size of its textures (--tex-hi). The roof,
   the rear screen, the C-pillars, the tailgate and the upper flanks come out
   sharp; the nose, the grille and the front wings come out cheap, which is
   what the owner asked for and what --rear-bias only approximated. Supersedes
   --rear-bias (which biased the tail LAMPS by name and starved the roof).

   --rear-bias: this asset is a THIRD-PERSON body — the dashcam that ships
   the game never sees it (AGENTS.md), only the chase cam, the mirror, and
   the garage card, all of which frame the car from behind or at a 3/4 rear
   angle far more than they frame the front. Skews the per-part budget (see
   WEIGHTS below) and the texture pass toward -Z, the donor's rear.

   --strip: the game drives its own wheels — they steer and spin, the
   donor's don't — so its rim/tyre/disc/caliper/hub nodes are pure waste in
   this asset. Drops them at selection time instead of the ad-hoc post-strip
   the shipped build used, which left one leftover disc mesh behind.

   tools/build-cockpit.mjs keeps the handful of nodes the rigidly-mounted POV
   lens actually frames and discards the other 90% of the donor: bodywork,
   wheels, lamps, seats, rear cabin. That is the right trade for the shipping
   view and the wrong one for anything that looks AT the car — a chase camera,
   a replay, a photo mode. This builds that missing 90% as a SEPARATE asset,
   decimated hard, so the two load independently and the cockpit GLB is never
   touched.

   The decimation is a real edge-collapse simplifier (meshoptimizer, via
   gltf-transform's `simplify`), not decimation by deletion: a car reads by its
   outline, and dropping triangles at random destroys the outline while
   collapsing interior edges does not.

   The triangle target is counted as DRAWN triangles, not unique ones. The
   donor instances its wheel corner nine ways — rim, tyre, disc, caliper, hub —
   so 3.27M drawn triangles are only 2.72M distinct ones, and a budget counted
   the wrong way is out by a fifth before it starts.

   --rest drops the nodes build-cockpit.mjs already ships whole (dash, vents,
   console, wheel, stalks, cluster, mirror body) so the two assets can be drawn
   together without a doubled dashboard. Without it the output is a
   self-contained whole car, which is what you want if the cockpit is hidden
   while an external camera is live. The cabin shell and door cards are kept
   either way: the cockpit only takes frustum-clipped slivers of those. */

import * as fs from "node:fs";
import * as path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune, dedup, weld, simplifyPrimitive, join, quantize, textureCompress, draco, meshopt } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import draco3d from "draco3dgltf";
import sharp from "sharp";

const argv = process.argv.slice(2);
const SRC = argv.find((a) => !a.startsWith("--"));
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const OUT_NAME = flag("--out", "volvo-s90-body");
const TRIS = Number(flag("--tris", 300000));
const TEX = Number(flag("--tex", 256));
const ERROR = Number(flag("--error", 0.01));
const REST = argv.includes("--rest");
const EXTERIOR = argv.includes("--exterior");
/* The mirror image of --exterior: keep ONLY the cabin. Composes with --rest,
   and `--interior --rest` is the useful pair — everything a person sitting in
   that seat can see, minus the dash the cockpit GLB already ships at full
   resolution. */
const INTERIOR = argv.includes("--interior");
/* You do not model the seat the camera is sitting in. Both driver cameras land
   INSIDE the donor's driver seat — its box is x 0.11..0.69, y 0.27..1.32,
   z -0.29..0.60, and CAM_POV sits at (0.28, 1.20, 0.31) with CAM_COCKPIT at
   (0.36, 1.35, -0.30) — so shipping it puts a headrest across the lens and the
   dash somewhere beyond it. The clipped dash never contained seats, which is
   why this only appeared once the full cabin did. The PASSENGER seat and the
   rear bench stay: nothing is ever inside those. */
const DRIVER_SEAT = /^Driver Seat/i;
/* --strip: the corner the game re-supplies itself — rim, tyre, wheelhub,
   and the disc/caliper behind them, all four wheels. */
const WHEEL_STRIP = /^Rim |^Tire |Wheelhub|Brake Disc|Caliper/i;
const COMPRESS = flag("--compress", "quantize");   // none | quantize | meshopt | draco
const JOIN = !argv.includes("--no-join");
const TANGENTS = argv.includes("--tangents");
const DRY = argv.includes("--dry");
const OUT_DIR = path.resolve(flag("--outdir", path.resolve(import.meta.dirname, "../public/assets-staging")));
const REAR_BIAS = argv.includes("--rear-bias");
const TEX_REAR = Number(flag("--tex-rear", 512));
const STRIP = argv.includes("--strip");
/* --chase-bias supersedes --rear-bias: same intent ("spend the budget where the
   third-person camera looks"), but measured off the chase lens instead of
   guessed from part names. See CHASE_EYES below. --tex-hi is its texture half:
   the maps on the surfaces that fill the chase frame get the big size, the
   nose's maps get --tex. */
const CHASE_BIAS = argv.includes("--chase-bias");
const TEX_HI = Number(flag("--tex-hi", 0));
/** Fraction of the peak visibility score at which a material's maps get TEX_HI. */
const TEX_HI_AT = Number(flag("--tex-hi-at", 0.22));

if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: node tools/build-car-body.mjs <donor.glb> [--out NAME] [--tris N] [--tex N] [--error E] [--rest] [--exterior] [--interior] [--compress none|quantize|meshopt|draco] [--no-join] [--tangents] [--chase-bias] [--tex-hi N] [--rear-bias] [--tex-rear N] [--strip] [--outdir DIR] [--debug] [--dry]");
  process.exit(1);
}

/* Nodes build-cockpit.mjs ships whole. Listed only so --rest can refuse them;
   deliberately NOT including Shell_/DoorPanel/Plane.057, which the cockpit
   takes only a frustum-clipped sliver of and which this asset has to carry in
   full or the cabin has no roof. */
const COCKPIT_OWNED = /SpeedoScreen|SpeedoGlass|InstrumentCluster|GaugeScreen|InfoTainment ?Screen|CenterScreen|NavScreen|^SteeringWheel[ _]|SteeringWheel Emblem|^Stalks|SteeringColumn|RearviewMirror|Dashboard|^Vents|Knobs|Glovebox|CenterConsole|Shifterknob|Plane\.049/i;

/* --exterior throws the cabin away entirely: seats, belts, carpets, door
   cards, dash, console, pedals, the inner shell. From outside, all of it is
   seen through tinted glass and none of it is on the silhouette — and it is a
   third of the donor's triangles and a third of its textures. Worth having as
   its own variant because the whole point of this asset is a camera pointed AT
   the car, and the cockpit GLB already owns everything a camera pointed OUT of
   it can see. The glass itself stays: it is exterior. */
const CABIN_ONLY = /Seat|Carpet|Floor|^Shell_|DoorPanel|Dashboard|Console|RearShelf|SeatBelt|Pedal|PlasticTrim|Knobs|Glovebox|^Vents|Shifterknob|Speedo|InfoTainment|SteeringWheel|SteeringColumn|^Stalks|Rearview|Ceiling|^Plane\./i;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(),
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "meshopt.decoder": MeshoptDecoder,
    "meshopt.encoder": MeshoptEncoder,
  });
await MeshoptEncoder.ready;
const doc = await io.read(SRC);
const root = doc.getRoot();

const meshTris = (mesh) => mesh.listPrimitives().reduce((a, p) => {
  const ix = p.getIndices(); return a + (ix ? ix.getCount() : p.getAttribute("POSITION").getCount()) / 3;
}, 0);
/** Triangles the GPU rasterises per frame — every node counted, instances included. */
function drawn() {
  let tris = 0, calls = 0;
  const visit = (n) => {
    const m = n.getMesh();
    if (m) { tris += meshTris(m); calls += m.listPrimitives().length; }
    n.listChildren().forEach(visit);
  };
  root.getDefaultScene()?.listChildren().forEach(visit);
  return { tris, calls };
}
const unique = () => root.listMeshes().reduce((a, m) => a + meshTris(m), 0);
/** Decoded RGBA8 + mips, measured off the actual image bytes rather than glTF metadata. */
async function vram() {
  let bytes = 0;
  for (const t of root.listTextures()) {
    const img = t.getImage(); if (!img) continue;
    const { width = 0, height = 0 } = await sharp(Buffer.from(img)).metadata();
    bytes += width * height * 4 * 1.333;
  }
  return bytes;
}

const donor = { ...drawn(), img: root.listTextures().length, mat: root.listMaterials().length };

/* ---------------------------------------------------------------- select -- */

/* Same flattening as build-cockpit: the donor nests its parts under authoring
   empties whose transforms are load-bearing, so every kept node is re-parented
   to a fresh root with its world matrix baked onto it. A fresh scene rather
   than a pruned one, for the same reason — detaching in place leaves empty
   stubs that prune() keeps alive. */
const keep = [];
function mulMat(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
const walk = (node, parentMat) => {
  const m = mulMat(parentMat, node.getMatrix());
  const drop = node.getMesh() && ((REST && COCKPIT_OWNED.test(node.getName())) ||
                                 (EXTERIOR && CABIN_ONLY.test(node.getName())) ||
                                 (INTERIOR && !CABIN_ONLY.test(node.getName())) ||
                                 (INTERIOR && DRIVER_SEAT.test(node.getName())) ||
                                 (STRIP && WHEEL_STRIP.test(node.getName())));
  if (node.getMesh() && !drop) keep.push({ node, matrix: m });
  for (const c of node.listChildren()) walk(c, m);
};
for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

const scene = doc.createScene(OUT_NAME);
for (const { node, matrix } of keep)
  scene.addChild(doc.createNode(node.getName()).setMatrix(matrix).setMesh(node.getMesh()));
for (const s of root.listScenes()) if (s !== scene) s.dispose();
root.setDefaultScene(scene);
await doc.transform(prune(), dedup());

const selected = drawn();

/* -------------------------------------------------------------- decimate -- */

/* [pattern, share of the budget, pin open boundaries].

   A flat ratio across every part is the obvious cut and the wrong one. The
   donor was authored for a showroom turntable, so its triangles sit where a
   turntable looks: the four brake discs carry more geometry than the entire
   painted body, and the rim bolts carry twice the bonnet. Cut everything by
   the same 9% and that allocation survives intact into a 300k budget that has
   to describe a car seen from ten metres away at 200 km/h. Measured, on a
   uniform cut at this budget: 44k triangles of brake disc against 12k of
   paint. Weighted, the same budget puts 54k on the paint and 32k on the discs.

   `lock` is a second, independent axis. lockBorder tells meshoptimizer it may
   not collapse a vertex sitting on an open boundary, which is what keeps a
   panel edge attached to its panel and what keeps the gaps between wheel
   spokes from closing into a hubcap — measured: unlock the rims and the spokes
   smear shut even while the rim's triangle count goes UP. It also stops parts
   built from many disconnected shells simplifying at all, since nearly every
   vertex they own is a boundary one. So: on for everything whose edges are
   seen from outside, off for the parts that are hidden anyway and would
   otherwise refuse to shrink — drilled brake discs, seat cushions, underbody. */
const WEIGHTS = [
  /* the painted skin and the glass: every triangle here is on the outline or
     on a reflection that follows it */
  [/Car Paint|Body Frame|Bumper|Hood|Trunk|Fender|^Door |Quarter|Windsheild|MIrror|Grille|Shell Headlight/i, 3.0, true],
  /* lamp clusters and brightwork: small, curved, and the first thing that
     reads as "cheap model" when it goes faceted */
  [/Headlight|Taillight|Runninglight|Turnsignal|ReverseLight|Foglight|Emblem|Lettering|Chrome|Wiper/i, 1.6, true],
  /* a wheel is the second thing anyone looks at, and the spoke gaps are
     boundaries — unlock these and the rim simplifies into a hubcap */
  [/^Rim |^Tire |Wheelhub/i, 1.4, true],
  /* behind the spokes, in shadow, at speed */
  [/Brake Disc|Caliper/i, 0.22, false],
  /* only ever seen by a camera under the car */
  [/Underbody|Exhaust/i, 0.3, false],
  /* the cabin: seen through glass from outside, and in the shipping view the
     high-res cockpit is drawn over the front half of it anyway */
  [/Seat|Carpet|Floor|^Shell_|DoorPanel|Dashboard|Console|RearShelf|SeatBelt|Pedal|PlasticTrim|SunRoof|^Plane\./i, 0.5, false],
];
/* --rear-bias overrides WEIGHTS for named rear parts (checked first, since
   ruleFor takes the first match) and demotes the front. Weight 8 clamps
   ratio_i = min(1, k*weight) to 1.0 at any budget this script is likely to
   be run at — the tail-lamp stack, trunk, rear bumper and badges come out
   effectively undecimated. The generic Headlight|Taillight|... rule in
   WEIGHTS above still catches everything these two miss (fog lights, wing
   mirrors) at its old, even-handed weight. */
const REAR_WEIGHTS = [
  /* The one exception to "front low": the hood. player.ts lifts its connected
     component out of this asset and draws it in the DASHCAM view — the view
     that ships (AGENTS.md) — as the silhouette band along the bottom of the
     frame. Weight 8 lands it near the old build's ~1,500 tris instead of the
     ~450 the front demotion would leave, so the bonnet's crown line does not
     go polygonal in the one place this asset reaches the shipping camera. */
  [/^Hood[ _]/i, 8.0, true],
  [/Taillight|TrunkTaillight|ReverseLight|Bumper[ _]?Rear|^Trunk[ _]|Lettering[ _]?Rear|Quarter|Exhaust/i, 8.0, true],
  [/Grille|Headlight|Bumper[ _]?Front|Fender[ _]?Front|Emblem[ _]?Front|Runninglight|Turnsignal|Wiper/i, 0.8, true],
];
/* An interior asset inverts the exterior's priorities completely. The WEIGHTS
   above put the cabin at 0.5 because from outside it is a blur behind tinted
   glass; from INSIDE, the dash is 30 cm from the lens and is the whole shot,
   while the rear bench is a metre and a half behind your head. Using the
   exterior table for an interior build spends the budget on the parcel shelf
   and decimates the binnacle. */
const INTERIOR_WEIGHTS = [
  // the surfaces a driver's eye lands on, at arm's length
  [/Dashboard|^Vents|Knobs|Glovebox|Speedo|InfoTainment|SteeringWheel|^Stalks|SteeringColumn|CenterConsole|Shifterknob|^Plane\.049/i, 3.0, true],
  // either side of the dash, and the pillars that frame the windscreen
  [/DoorPanel|^Plane\.057|^Shell_|Rearview|CeilingConsole/i, 2.0, true],
  [/Driver Seat|Passenger Seat|SeatBelts Front|Pedal/i, 1.0, true],
  // behind the driver's head, or under their feet
  [/Rear Seats|SeatBelts Rear|RearShelf|Carpet|^Floor_|PlasticTrim|SunRoof/i, 0.4, false],
];
const ruleFor = (name) =>
  (INTERIOR ? INTERIOR_WEIGHTS.find(([re]) => re.test(name)) : null) ??
  (REAR_BIAS ? REAR_WEIGHTS.find(([re]) => re.test(name)) : null) ??
  WEIGHTS.find(([re]) => re.test(name)) ?? [null, 1.0, true];

/* Belt-and-braces for --rear-bias: the name rules above miss anything the
   donor's authors didn't name after its lamps (a stray reflector, a badge
   fused into "Car Paint"), so also read the part's own world-space Z — the
   donor is +Z forward (verified with tools/inspect-glb.mjs: front bumper
   spans z 1.79..2.51, taillights z -2.37..-2.02), so a bbox centred well
   behind the rear axle is rear regardless of what it's called. */
function meshWorldZCenter(mesh, m) {
  let zmin = Infinity, zmax = -Infinity, el = [];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION"); if (!pos) continue;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      const z = m[2] * el[0] + m[6] * el[1] + m[10] * el[2] + m[14];
      if (z < zmin) zmin = z;
      if (z > zmax) zmax = z;
    }
  }
  return zmin <= zmax ? (zmin + zmax) / 2 : 0;
}

/* Weight per distinct mesh, taken from a node that references it, plus how
   many nodes do — an instanced wheel corner costs its triangles four times
   over in the drawn total and has to be budgeted that way. */
const meshInfo = new Map();
for (const node of root.getDefaultScene().listChildren()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const [, ruleWeight, lock] = ruleFor(node.getName());
  let weight = ruleWeight;
  if (CHASE_BIAS) {
    /* handled in a second pass below — the factor is relative to the best-seen
       surface on the car, so every mesh has to be measured before any of them
       can be weighted. */
  } else if (REAR_BIAS) {
    const z = meshWorldZCenter(mesh, node.getMatrix());
    if (z < -1.5) weight *= 3;
    /* Demote the front by ratio only, gently: 0.5 was enough to push the
       nose's paint and lamp shells into the escalating-error regime below,
       which TEARS the silhouette (holes in the bumper, a collapsed fender)
       rather than merely coarsening it — "front low" must mean fewer
       triangles, not brake-disc treatment; the garage card still frames the
       front 3/4. */
    else if (z > 1.0) weight *= 0.7;
  }
  const info = meshInfo.get(mesh) ?? { weight, ruleWeight, lock, instances: 0, tris: meshTris(mesh), name: node.getName(), matrix: node.getMatrix() };
  info.instances++;
  meshInfo.set(mesh, info);
}

/* --chase-bias: measure, don't guess.

   The owner's rule is "whatever the third-person camera sees stays sharp, the
   nose and front flanks can be cheap". --rear-bias tried to spell that out as
   a list of part NAMES and got it wrong in both directions: it pinned the tail
   LAMPS (56% of the shipped file's triangles sit in the lamp cluster) while the
   roof, the rear screen and the upper flanks — which the chase camera stares
   at for the whole race — fell through to the generic rule and were cut with
   the underbody.

   So ask the geometry instead. CHASE_EYES are the real third-person lenses in
   the donor's own space (+Z forward, y = 0 at the road): engine.ts parks the
   chase camera at CHASE_CAM.dist + shell.L * 0.25 = 4.84 m behind the car and
   CHASE_CAM.height = 2.15 m up, and photo mode / the live mirror swing that
   around to the rear three-quarters. For every sampled vertex of every mesh we
   take the best over those eyes of

       max(0, n . d) / |d|^2          d = eye - p

   which is exactly the differential solid angle a surface element subtends —
   screen area per unit of surface area. Averaged over the mesh and normalised
   against the best-lit mesh on the car, that is "how much of the third-person
   frame is this part", between 0 and 1. A surface facing away scores 0, and so
   does one so far from the lens it is a few pixels.

   The score SCALES the name rule rather than replacing it: the name table
   carries the two things geometry cannot see — lockBorder (which edges may not
   be collapsed) and the escalation-gate exemption that stops paint tearing —
   and those must not depend on where a panel happens to sit. */
const CHASE_EYES = [
  [0, 2.15, -4.84],      // CHASE, straight behind (engine.ts CHASE_CAM)
  [3.5, 2.30, -3.90],    // rear three-quarter, right (photo mode, mirror)
  [-3.5, 2.30, -3.90],   // rear three-quarter, left
];
/** Mean solid angle per unit area of a mesh's surface as seen from the chase
    lenses — sampled, since a 400k-triangle donor panel does not need every
    vertex to answer "is this on screen from behind". */
function meshChaseVis(mesh, m) {
  const cof = [
    m[5]*m[10] - m[6]*m[9],  m[6]*m[8] - m[4]*m[10], m[4]*m[9] - m[5]*m[8],
    m[2]*m[9] - m[1]*m[10],  m[0]*m[10] - m[2]*m[8], m[1]*m[8] - m[0]*m[9],
    m[1]*m[6] - m[2]*m[5],   m[2]*m[4] - m[0]*m[6],  m[0]*m[5] - m[1]*m[4],
  ];
  let sum = 0, n = 0, el = [], nl = [];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION"), nor = prim.getAttribute("NORMAL");
    if (!pos || !nor) continue;
    const count = pos.getCount();
    const stride = Math.max(1, Math.floor(count / 2000));
    for (let i = 0; i < count; i += stride) {
      pos.getElement(i, el); nor.getElement(i, nl);
      const px = m[0]*el[0] + m[4]*el[1] + m[8]*el[2]  + m[12];
      const py = m[1]*el[0] + m[5]*el[1] + m[9]*el[2]  + m[13];
      const pz = m[2]*el[0] + m[6]*el[1] + m[10]*el[2] + m[14];
      let nx = cof[0]*nl[0] + cof[3]*nl[1] + cof[6]*nl[2];
      let ny = cof[1]*nl[0] + cof[4]*nl[1] + cof[7]*nl[2];
      let nz = cof[2]*nl[0] + cof[5]*nl[1] + cof[8]*nl[2];
      const ln = Math.hypot(nx, ny, nz) || 1; nx /= ln; ny /= ln; nz /= ln;
      let best = 0;
      for (const [ex, ey, ez] of CHASE_EYES) {
        const dx = ex - px, dy = ey - py, dz = ez - pz;
        const d2 = dx*dx + dy*dy + dz*dz, d = Math.sqrt(d2);
        const c = (nx*dx + ny*dy + nz*dz) / d;
        if (c > 0) best = Math.max(best, c / d2);
      }
      sum += best; n++;
    }
  }
  return n ? sum / n : 0;
}
/** Weight multiplier from the visibility score. Never 0: the front of the car
    is CHEAP, not absent — it is still on the silhouette from every rear
    three-quarter and it is the whole subject of a photo-mode front shot. */
const CHASE_LO = Number(flag("--chase-lo", 0.30));
const CHASE_HI = Number(flag("--chase-hi", 2.6));
if (CHASE_BIAS) {
  let peak = 0;
  for (const [mesh, info] of meshInfo) {
    info.vis = meshChaseVis(mesh, info.matrix);
    peak = Math.max(peak, info.vis);
  }
  for (const [, info] of meshInfo) {
    /* sqrt, not linear: the raw score falls off as 1/r^2, so a linear map puts
       everything but the tailgate at the floor. The square root is the same
       curve in "screen LENGTH per unit length", which is what a silhouette
       reads by. */
    let f = CHASE_LO + (CHASE_HI - CHASE_LO) * Math.sqrt(peak ? info.vis / peak : 0);
    /* The hood is the one front part with a shipping-view job: player.ts lifts
       its connected component into the DASHCAM frame (AGENTS.md), where it is
       the silhouette band along the bottom. Cheap, but not polygonal. */
    if (/^Hood[ _]/i.test(info.name)) f = Math.max(f, 1.0);
    info.chaseF = f;
    info.weight = info.ruleWeight * f;
  }
}
/* Same score, spent on pixels instead of triangles: a material is worth a big
   map only if some surface wearing it fills part of the chase frame. Recorded
   here, while the meshes still exist un-joined, and consumed by the texture
   pass far below. */
const matVis = new Map();
/** Texture ids (URI, or name for a packed donor) that earn TEX_HI. Resolved to
    strings HERE and not at texture time, because join()/dedup() in between may
    have merged the material object this hung off. */
const hiTexIds = new Set();
if (CHASE_BIAS) {
  let peak = 0;
  for (const [, info] of meshInfo) peak = Math.max(peak, info.vis ?? 0);
  for (const [mesh, info] of meshInfo)
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial(); if (!mat) continue;
      const rel = peak ? (info.vis ?? 0) / peak : 0;
      matVis.set(mat, Math.max(matVis.get(mat) ?? 0, rel));
    }
  for (const [mat, v] of matVis) {
    if (v < TEX_HI_AT) continue;
    for (const t of [mat.getBaseColorTexture(), mat.getNormalTexture(), mat.getMetallicRoughnessTexture(),
                     mat.getEmissiveTexture(), mat.getOcclusionTexture()])
      if (t) hiTexIds.add(t.getURI() || t.getName());
  }
}

/* Solve the one free scalar: ratio_i = min(1, k * weight_i), chosen so the
   weighted budget lands on TRIS. Bisection rather than algebra because of the
   min() — parts whose weight would ask for more triangles than they have just
   clamp, and hand their surplus back to the rest. */
function solveK(target) {
  let lo = 0, hi = 1e3;
  for (let i = 0; i < 80; i++) {
    const k = (lo + hi) / 2;
    let sum = 0;
    for (const [, info] of meshInfo) sum += info.tris * Math.min(1, k * info.weight) * info.instances;
    if (sum > target) hi = k; else lo = k;
  }
  return (lo + hi) / 2;
}
const k = solveK(TRIS);
for (const [, info] of meshInfo) info.target = Math.max(12, Math.round(info.tris * Math.min(1, k * info.weight)));

/* One pass does not land on target. meshoptimizer refuses any collapse that
   would exceed `error` or unpick a locked border, so a part that is mostly
   seam — a badge, a wiper, a tyre's tread blocks — stops short of its share.
   Re-asking each mesh for the fraction it still owes recovers most of that.
   Some of it never comes back: the drilled discs and the treaded tyres are
   simply not reducible past a point, so a --tris budget is a floor to aim at,
   not a promise, and the report prints what was actually achieved. */
await MeshoptSimplifier.ready;
const passes = [];
for (let pass = 0; pass < 6; pass++) {
  await doc.transform(weld());
  for (const [mesh, info] of meshInfo) {
    const now = meshTris(mesh);
    if (now <= info.target * 1.02) continue;
    /* Error budget is the weight again, read the other way round: a part we
       care six times less about may also deviate six times further, and each
       pass that fails to reach target relaxes it further still. Without this
       the low-weight parts simply refuse — the brake discs stall at 5x their
       share, and the whole car lands 50% over budget with the surplus spent
       entirely behind the wheels.

       A high-weight part (>= 3, i.e. paint/glass or a --rear-bias lamp
       cluster) is exempted from the escalation: it is meant to stall near
       full resolution, not eventually give way to it. Without this gate the
       tail-lamp stack's many boundary-locked shells — the exact geometry
       --rear-bias exists to protect — get progressively unlocked by
       Math.pow(3, pass) across six passes and end up as crushed as before.
       The gate reads the NAME-RULE weight, not the spatially-biased one:
       --rear-bias halving a front panel's budget must not also strip the
       hood — a paint panel, weight 3.0 by rule — of this exemption, or the
       nose's boundary-locked skin gets progressively unlocked and torn. */
    const err = (ERROR / info.weight) * (Math.max(info.weight, info.ruleWeight ?? 0) >= 3 ? 1 : Math.pow(3, pass));
    for (const prim of mesh.listPrimitives())
      simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: info.target / now, error: err, lockBorder: info.lock });
  }
  await doc.transform(prune());          // dedup() would merge meshes out from under meshInfo
  const to = drawn().tris;
  passes.push(to);
  if (to <= TRIS * 1.03) break;
}
if (argv.includes("--debug")) {
  const over = [...meshInfo].map(([m, i]) => ({ n: m.getName(), got: Math.round(meshTris(m)), want: i.target, w: i.weight, x: i.instances }))
    .filter((o) => o.got > o.want * 1.1).sort((a, b) => (b.got - b.want) * b.x - (a.got - a.want) * a.x);
  console.log("  over budget:");
  for (const o of over.slice(0, 15)) console.log(`    ${o.n.padEnd(40)} want ${o.want} got ${o.got}  (w ${o.w}, x${o.x})`);
  if (CHASE_BIAS) {
    const rows = [...meshInfo].map(([m, i]) => ({ n: i.name, got: Math.round(meshTris(m)), f: i.chaseF, w: i.weight }))
      .sort((a, b) => b.f - a.f);
    console.log("  chase visibility (weight multiplier, tris kept):");
    for (const r of rows) console.log(`    ${r.n.padEnd(44)} x${r.f.toFixed(2)}  w ${r.w.toFixed(2)}  ${r.got}`);
  }
}
await doc.transform(dedup());
const simplified = drawn();

/* TANGENT is 17% of the vertex payload and only 15 of 42 materials carry a
   normal map at all. three derives a tangent frame from screen-space
   derivatives when the attribute is absent, which on a decimated body — seen
   from a chase camera, at speed — is indistinguishable and free. */
if (!TANGENTS)
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) prim.setAttribute("TANGENT", null);

/* ------------------------------------------------------------ draw calls -- */

/* join() merges primitives that share a material — every painted panel into
   one draw call, every chrome strip into one — but it can only do that once
   node transforms are baked into the vertex data, and gltf-transform's own
   flatten() gets that wrong on this donor: half its parts are MIRRORED
   instances (one wheel mesh, four corners; one door mesh, both sides) and the
   negative-determinant matrices come back out of flatten() rotated into
   nonsense, a 1.43 m tall car turning into a 4.84 m one.
   So bake them here instead, where the mirror case can be handled properly:
   positions by the matrix, normals by its inverse-transpose, and — the part
   that matters — triangle winding reversed whenever the determinant is
   negative, because a mirror turns every front face into a back face.

   Baking is done AFTER simplification on purpose: it clones each shared mesh
   per instance, so doing it first would hand the simplifier 3.27M distinct
   triangles to chew on instead of 2.72M, for exactly the same result. */
function bakeTransforms() {
  const users = new Map();      // mesh -> how many nodes reference it
  for (const node of root.getDefaultScene().listChildren())
    if (node.getMesh()) users.set(node.getMesh(), (users.get(node.getMesh()) ?? 0) + 1);

  for (const node of root.getDefaultScene().listChildren()) {
    const m = node.getMatrix();
    let mesh = node.getMesh();
    if (!mesh) continue;

    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    // normals transform by the inverse-transpose; for the 3x3 part that is the
    // adjugate transposed, which is the cofactor matrix, scale-invariant once
    // renormalised — so the cofactors are all we need
    const cof = [
      m[5]*m[10] - m[6]*m[9],  m[6]*m[8] - m[4]*m[10], m[4]*m[9] - m[5]*m[8],
      m[2]*m[9] - m[1]*m[10],  m[0]*m[10] - m[2]*m[8], m[1]*m[8] - m[0]*m[9],
      m[1]*m[6] - m[2]*m[5],   m[2]*m[4] - m[0]*m[6],  m[0]*m[5] - m[1]*m[4],
    ];

    if (users.get(mesh) > 1) {                 // shared: give this node its own copy
      const copy = doc.createMesh(mesh.getName());
      for (const p of mesh.listPrimitives()) {
        const q = doc.createPrimitive().setMaterial(p.getMaterial()).setMode(p.getMode());
        if (p.getIndices()) q.setIndices(p.getIndices().clone());
        for (const sem of p.listSemantics()) q.setAttribute(sem, p.getAttribute(sem).clone());
        copy.addPrimitive(q);
      }
      users.set(mesh, users.get(mesh) - 1);
      node.setMesh(copy);
      mesh = copy;
    }

    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION"), el = [];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, el);
        pos.setElement(i, [
          m[0]*el[0] + m[4]*el[1] + m[8]*el[2]  + m[12],
          m[1]*el[0] + m[5]*el[1] + m[9]*el[2]  + m[13],
          m[2]*el[0] + m[6]*el[1] + m[10]*el[2] + m[14],
        ]);
      }
      for (const sem of ["NORMAL", "TANGENT"]) {
        const a = prim.getAttribute(sem); if (!a) continue;
        for (let i = 0; i < a.getCount(); i++) {
          a.getElement(i, el);
          const x = cof[0]*el[0] + cof[3]*el[1] + cof[6]*el[2];
          const y = cof[1]*el[0] + cof[4]*el[1] + cof[7]*el[2];
          const z = cof[2]*el[0] + cof[5]*el[1] + cof[8]*el[2];
          const n = Math.hypot(x, y, z) || 1;
          // TANGENT's w is a handedness flag, and a mirror reverses handedness
          a.setElement(i, sem === "TANGENT" ? [x/n, y/n, z/n, det < 0 ? -el[3] : el[3]] : [x/n, y/n, z/n]);
        }
      }
      if (det < 0) {
        const ix = prim.getIndices();
        if (ix) { const arr = ix.getArray(); for (let t = 0; t + 2 < arr.length; t += 3) { const s = arr[t]; arr[t] = arr[t + 2]; arr[t + 2] = s; } ix.setArray(arr); }
      }
    }
    node.setMatrix([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  }
}
if (JOIN) { bakeTransforms(); await doc.transform(join({ keepNamed: false }), prune(), dedup()); }

/* --------------------------------------------------------------- texture -- */

/* Rear-lamp materials get their own, larger target: at 128px the taillight
   graphic is the single biggest "looks cheap" contributor at chase distance
   (per-part budget above only buys triangle silhouette, not the texture
   drawn across it), while the decoded-VRAM cost of a few 512px maps is
   trivial next to the donor's 3.5 GB. Runs BEFORE the general pass so it
   works off the untouched source texture, not an already-downsized one —
   and the general pass then excludes anything it already sized. */
const REAR_TEX = /Taillight|TrunkTaillight|ReverseLight|Bumper[ _]?Rear|^Trunk|Quarter|Lettering[ _]?Rear/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (TEX && CHASE_BIAS && TEX_HI > TEX) {
  /* The chase-visible half of the atlas at TEX_HI, everything else at TEX.
     Which textures those are is not a guess either: it is matVis, the same
     per-surface score the triangle budget was solved with, carried through the
     material each map hangs off. Big-map first, off the untouched source. */
  const ids = [...hiTexIds].filter(Boolean).map(esc);
  console.log(`  tex-hi    : ${ids.length} maps at ${TEX_HI}px (materials scoring >= ${TEX_HI_AT} of peak chase visibility)`);
  if (ids.length) {
    const hiRe = new RegExp(`^(?:${ids.join("|")})$`, "i");
    await doc.transform(textureCompress({
      encoder: sharp, targetFormat: "webp", resize: [TEX_HI, TEX_HI], resizeFilter: "lanczos3", pattern: hiRe,
    }));
    await doc.transform(textureCompress({
      encoder: sharp, targetFormat: "webp", resize: [TEX, TEX], resizeFilter: "lanczos3",
      pattern: new RegExp(`^(?!(?:${ids.join("|")})$).*$`, "i"),
    }));
  } else {
    await doc.transform(textureCompress({
      encoder: sharp, targetFormat: "webp", resize: [TEX, TEX], resizeFilter: "lanczos3",
    }));
  }
} else if (TEX && REAR_BIAS) {
  await doc.transform(textureCompress({
    encoder: sharp, targetFormat: "webp", resize: [TEX_REAR, TEX_REAR], resizeFilter: "lanczos3", pattern: REAR_TEX,
  }));
  await doc.transform(textureCompress({
    encoder: sharp, targetFormat: "webp", resize: [TEX, TEX], resizeFilter: "lanczos3",
    pattern: new RegExp(`^(?!.*(?:${REAR_TEX.source})).*$`, "i"),
  }));
} else if (TEX) {
  await doc.transform(textureCompress({
    encoder: sharp, targetFormat: "webp", resize: [TEX, TEX], resizeFilter: "lanczos3",
  }));
}

const vramBytes = await vram();

/* Quantization is the compression that costs the runtime nothing:
   KHR_mesh_quantization is native in three's GLTFLoader, no decoder to
   register and no wasm to serve. meshopt and draco beat it on bytes but each
   needs a decoder wired onto the loader, which is an integration decision, not
   a build one. */
if (COMPRESS === "quantize") await doc.transform(quantize());
else if (COMPRESS === "meshopt") { await MeshoptEncoder.ready; await doc.transform(quantize(), meshopt({ encoder: MeshoptEncoder, level: "high" })); }
else if (COMPRESS === "draco") await doc.transform(quantize(), draco());

/* ---------------------------------------------------------------- report -- */

const after = drawn();
const pc = (a, b) => `${((100 * a) / b).toFixed(1)}%`;

console.log(`\n${path.basename(SRC)} -> ${OUT_NAME}.glb   ${INTERIOR ? (REST ? "(cabin only, minus the cockpit dash)" : "(cabin only)") : EXTERIOR ? "(exterior only: cabin dropped)" : REST ? "(rest-of-car: cockpit parts dropped)" : "(whole car)"}${CHASE_BIAS ? " [chase-bias]" : ""}${REAR_BIAS ? " [rear-bias]" : ""}${STRIP ? " [wheels stripped]" : ""}`);
console.log(`  selected  : ${donor.tris.toLocaleString()} -> ${selected.tris.toLocaleString()} drawn tris  (${pc(selected.tris, donor.tris)} of donor)`);
console.log(`  decimated : ${selected.tris.toLocaleString()} -> ${simplified.tris.toLocaleString()} drawn tris  (target ${TRIS.toLocaleString()}, passes ${passes.map((p) => p.toLocaleString()).join(" -> ")})`);
console.log(`  triangles : ${after.tris.toLocaleString()} drawn, ${Math.round(unique()).toLocaleString()} distinct`);
console.log(`  draw calls: ${after.calls}  (donor: ${donor.calls}),  ${root.listMaterials().length} materials`);
console.log(`  textures  : ${donor.img} -> ${root.listTextures().length}${TEX ? (CHASE_BIAS && TEX_HI > TEX ? ` @ ${TEX}px webp (${TEX_HI}px on the chase-visible maps)` : REAR_BIAS ? ` @ ${TEX}px webp (${TEX_REAR}px for rear-lamp maps)` : ` @ ${TEX}px webp`) : " (source resolution)"}`);
/* The per-texture size histogram, printed rather than assumed. The --tex-hi
   regression this catches shipped for days behind a log line that only ever
   reported what the FIRST resize pass intended, never what came out. */
const texHist = async () => {
  const c = new Map();
  for (const t of root.listTextures()) {
    const img = t.getImage(); if (!img) continue;
    const { width = 0, height = 0 } = await sharp(Buffer.from(img)).metadata();
    const k = `${width}x${height}`; c.set(k, (c.get(k) ?? 0) + 1);
  }
  return [...c].sort((a, b) => parseInt(b[0]) - parseInt(a[0])).map(([k, n]) => `${n}x${k}`).join("  ") || "none";
};
console.log(`  tex sizes : ${await texHist()}`);
console.log(`  VRAM      : ${(vramBytes / 1e6).toFixed(1)} MB decoded RGBA8 + mips  (donor: 3,500 MB)`);
console.log(`  compress  : ${COMPRESS}${TANGENTS ? " +tangents" : ""}`);

if (DRY) { console.log("\n  --dry: nothing written\n"); process.exit(0); }
fs.mkdirSync(OUT_DIR, { recursive: true });
const outGlb = path.join(OUT_DIR, `${OUT_NAME}.glb`);
await io.write(outGlb, doc);
console.log(`\n  wrote ${outGlb}  (${(fs.statSync(outGlb).size / 1e6).toFixed(2)} MB)\n`);
