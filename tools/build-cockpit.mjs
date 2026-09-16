/* Cuts a donor car model down to the interior the dashcam actually frames.

     node tools/build-cockpit.mjs <donor.glb> [--out NAME] [--tex N] [--dry]

   Run offline, not at build time — the GLB it writes is committed.

   TWO CUTS, one tool. They differ in WHERE the geometry is thrown away:

     --no-clip --full-cabin --simplify   (what ships: volvo-s90-full)
        Whole NODES only. Every node the widest legal frustum can reach is
        kept ENTIRE and then decimated with meshoptimizer; nodes no legal
        frustum can reach (rear bench, rear door cards, all bodywork) are
        dropped whole. Nothing is ever sliced, so there is no cut edge to walk
        past and the Field-of-view slider is clean to its maximum.

     (default, no flags)                 (the retired dash: volvo-s90)
        Per-VERTEX frustum clip at near-donor resolution. Smaller and sharper
        over the third of the cabin it keeps, but it is sliced geometry: past
        the frame it was clipped for there is simply nothing, so engine.ts had
        to cap the lens for it. Kept working because the clip is still how the
        `mirror` anchor is frozen (see ANCHOR_ROLES) and because a sharper
        dash-only cut may be worth revisiting.

   The exact command that produced the shipped asset is recorded in
   .gitignore next to the "Built cockpit dashes ARE committed" note.

   Donor models are whole cars: bodywork, seats, wheels, rear cabin, all of it
   at full texture resolution. The POV camera (engine.ts POV_MOUNT, at
   cockpit-local 0.28/1.175/0.31 looking +z, pitched down POV_TILT) sees a
   fraction of that — no bodywork at all, and nothing behind the front seats.

     Volvo S90 donor      3,273,670 tris   45 images   3.50 GB decoded
     whole-cabin build      356,880 tris   21 images   0.42 GB decoded  (@2K)
     retired dash cut       428,922 tris    9 images   0.81 GB decoded  (@4K)

   The saving is as much in the textures as in the triangles: images follow
   materials and materials follow the nodes that survive, so refusing the rear
   half of the car takes 24 of the donor's 45 maps with it. Triangles were
   never the bottleneck — 3.3M rasterises fine — but 3.5 GB of decoded texture
   does not fit anywhere.

   Output is a flat scene: every kept node is re-parented to the root with its
   world transform baked in. The hierarchy in these files is authoring
   scaffolding (empties, mirrored duplicates, per-part groups) and flattening
   it means game code can look a part up by role and position it directly.

   A sidecar `<name>.json` records, per role, the node name and its world
   bounding box, so cockpit code binds by ROLE ("cluster", "screen") rather
   than by the donor's own node names, which differ per model. */

import * as fs from "node:fs";
import * as path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { prune, dedup, weldPrimitive, simplifyPrimitive, meshopt } from "@gltf-transform/functions";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import sharp from "sharp";

const argv = process.argv.slice(2);
const SRC = argv.find((a) => !a.startsWith("--"));
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const OUT_NAME = flag("--out", "volvo-s90");
const TEX = Number(flag("--tex", 0)) || 0;   // 0 = leave source resolution
const DRY = argv.includes("--dry");
const CLIP = !argv.includes("--no-clip");
/* Take the rest of the cabin — front seats, floor, carpets, pedals, headliner
   console — not just the dash. Only meaningful with --no-clip: under the
   frustum clip those roles would each come through as a sliced fragment,
   which is exactly the artefact the unclipped build exists to avoid. Off by
   default so the dash cut stays byte-reproducible. */
const FULL_CABIN = argv.includes("--full-cabin");
/* Decimate with meshoptimizer, per role, to the SIMPLIFY table below. The
   clipped build does not need this — the frustum already threw 87% of the
   geometry away — but an unclipped whole-cabin build starts at 1.2M triangles
   and has nothing else to give. */
const SIMPLIFY_ON = argv.includes("--simplify");
/* EXT_meshopt_compression on the geometry buffers. Costs the runtime a decoder
   (cockpitmodel.ts hands GLTFLoader three's MeshoptDecoder, a plain ES module
   that bundles with the app — unlike Draco, which needs wasm served out of
   public/) and buys ~5x on vertex data, which is what the whole-cabin build
   spends nearly all of its bytes on: 357k triangles is 7.5 MB of float32
   uncompressed and 1.5 MB through this.

   POSITION PRECISION IS THE THING TO WATCH, because cockpitmodel.ts anchors
   the live gauge cluster and the mirror glass off bounding boxes taken from
   these vertices. Two guards, and they are why 14-bit quantisation drifted
   boxes by 10 mm when this was tried by hand outside the tool:

   - QUANT_POSITION is 16, not gltf-transform's default 14. Combined with the
     default per-MESH quantisation volume (each mesh gets its own grid rather
     than sharing one sized to the whole car) the worst error here is the
     largest mesh's extent over 65535 — 1.7 m / 65535, or 26 micrometres.
   - The manifest is measured AFTER this runs, off the quantised accessors and
     the dequantisation transforms quantize() bakes into the node matrices. So
     the boxes describe the file that ships, whatever the encoder did to it. */
const MESHOPT = argv.includes("--meshopt");
const QUANT_POSITION = 16;
const OUT_DIR = path.resolve(flag("--outdir", path.resolve(import.meta.dirname, "../public/models/cockpits")));

if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: node tools/build-cockpit.mjs <donor.glb> [--out NAME] [--tex N] [--clip-h D] [--clip-v D] [--jpeg-q N] [--margin M] [--outdir DIR] [--no-clip] [--full-cabin] [--simplify] [--meshopt] [--dry]");
  process.exit(1);
}

/* ------------------------------------------------------ the POV frustum -- */

/* The dashcam lens, in cockpit-local metres, mirroring engine.ts: POV_MOUNT
   (with the imported-dash height) offset from cockpit.ts's EYE, pitched down
   POV_TILT.

   Clipping to this is worth an unusual amount here because the lens is RIGIDLY
   MOUNTED. It has no head springs, no lean and no lookahead, so unlike a
   cockpit camera the frustum never moves relative to the dash — what is out of
   frame is out of frame permanently, not just this instant. On the donor that
   is 42% of the geometry: the whole centre console (1% visible), the shifter
   and its knob (0%), and the passenger third of the pad.

   It also buys the A-pillars. They live inside `Shell_Shell_0`, one welded
   103k-triangle mesh spanning the entire cabin, so no amount of node-picking
   can extract them — but only 9% of that mesh is ever in frame, and clipping
   takes exactly that 9%.

   THE ANGLES BELOW ARE NOT A LENS, THEY ARE A BUDGET. The dashcam used to run
   one fixed 105 deg lens and this file clipped to it with loose margins on the
   guess that a portrait phone would need the slack. It now honours the Field
   of view slider, so the frame is no longer one shape, and the defaults below
   are sized for a slider cap of 88: 119.6 deg horizontal on a 16:9 screen and
   110 deg vertical on a phone, swept over 58..88 crossed with every aspect
   from 9:21 to 32:9 rather than estimated. Any triangle inside those is a
   triangle the player can be shown; anything narrower prints a hard sliced
   edge across the dash at some legal combination of slider and screen.

   THAT CAP IS HISTORY. engine.ts's POV_FOV_MAX is 100 for both interiors it
   now ships, and there is no longer a lower per-interior cap, because the
   asset that needed one is retired. Clipping still runs for the two purposes
   named at the top of this file — reviving a sharper dash-only cut, and
   freezing the `mirror` anchor — and a revived cut would want --clip-h 129.5
   --clip-v 125.0 to match the slider it would have to survive (measured at
   +0.87 MB over the 88 cut). The defaults are left at 88 because that is what
   the retired asset was cut for and nothing has asked for a wider one.

   MARGIN is small precisely because the maxima are now exact rather than
   guessed. It covers the near-field parallax that the flat-frustum test does
   not model, and nothing else. */
const CAM = [0.28, 1.35 - 0.175, -0.30 + 0.61];   // cockpit.ts EYE + POV_MOUNT (imported height)
const TILT = 0.227;
/** Widest horizontal and vertical engine.ts's povFov() can produce, degrees,
    over the whole Field-of-view slider range crossed with every aspect. These
    two numbers are a slider cap expressed as geometry — at a cap of 88 they
    are 119.6 and 110.0; at 95, 125.5 and 118.8; at engine.ts's current
    POV_FOV_MAX of 100, 129.5 and 125.0 (measured: 9.15 MB, +0.87 over the 88
    cut). The defaults below are the 88 pair, which is what the retired dash
    was cut for; a revived cut has to be given the 100 pair or it shows the
    edge it was sliced on. --full-cabin builds screen whole NODES against the
    100 pair instead and never slice, so this does not bind them.
    Overridable so a deliberately over-wide control build can be made and
    diffed against the shipped one — that diff is how the clip's width gets
    demonstrated to be sufficient rather than asserted. */
const CLIP_HFOV = Number(flag("--clip-h", 119.6));
const CLIP_VFOV = Number(flag("--clip-v", 110.0));
/* Base mozjpeg quality for the colour maps; normal maps get +5 on top, since a
   normal map's error tilts the lighting rather than softening a photograph.
   90 reproduces the byte count of the hand-shrunk file this pass replaced;
   dropping to 84 saves ~180 KB for a worst-case texel error of 1.6/255, which
   is the cheapest lever available if this asset ever has to fit a budget. */
const JPEG_Q = Number(flag("--jpeg-q", 90));
/* A NaN here does not throw, it just makes every comparison in inFrustum()
   false and quietly ships 0.1% of the dash — which is exactly what a mistyped
   `--clip-h` with no value did once. Fail loudly instead. */
for (const [n, v] of [["--clip-h", CLIP_HFOV], ["--clip-v", CLIP_VFOV]])
  if (!Number.isFinite(v) || v <= 0 || v >= 180) {
    console.error(`${n} must be an angle in (0,180) degrees, got ${JSON.stringify(v)}`);
    process.exit(1);
  }
const MARGIN = Number(flag("--margin", 1.15));
const H_HALF = Math.tan((CLIP_HFOV / 2) * Math.PI / 180) * MARGIN;
const V_HALF = Math.tan((CLIP_VFOV / 2) * Math.PI / 180) * MARGIN;
const NEAR = 0.02;

/* The `mirror` role is exempt from the widening, and stays cut to the frame
   the 105 deg lens gave it. It is the one role that is never RENDERED: the
   donor's housing is hidden the moment it loads (cockpitmodel.ts) because it
   was authored to be seen from outside the car and reads as a plastic lump
   12 cm from the lens. What survives the cut exists only so its bounding box
   can anchor the game's own RT-fed glass — position, and the scale that fits
   the glass to the aperture, both come straight off that box.

   So widening it cannot fix a sliced edge (there is no visible edge to fix)
   and can only move the mirror: a wider cut keeps more housing, the box grows,
   and the glass silently slides back and scales up. Freezing this one role
   keeps the tuned mirror placement bit-for-bit identical across the rebuild.

   THIS CLIP RUNS EVEN UNDER --no-clip, and that is the whole reason an
   unclipped whole-cabin build can inherit the mirror the dash cut was tuned
   for. --no-clip means not slicing geometry the player might see; the
   mirror housing is never seen, so it is not geometry in that sense — it is a
   measuring stick, and a measuring stick that changes length between builds
   is worse than useless. Anchor roles are also exempt from --simplify below,
   for the same reason: decimation moves vertices, and these vertices ARE the
   anchor. */
const LEGACY_H_HALF = Math.tan((105 / 2) * Math.PI / 180) * 1.25;
const LEGACY_V_HALF = Math.tan((105 / 2) * Math.PI / 180) / (16 / 9) * 1.7;
/* And a frozen LENS to go with the frozen angles, because CAM is not frozen:
   it tracks engine.ts's real mount, and that moved 25 mm down when the seating
   position was lowered. Every millimetre CAM moves would slide the anchor
   frustum over the mirror housing, grow or shrink its bounding box, and take
   the glass with it — the exact failure freezing the angles exists to prevent,
   arriving through the other input. So the anchor clip is pinned to the mount
   the mirror was tuned at and stays there. Do not "fix" this to CAM. */
const LEGACY_CAM = [0.28, 1.20, 0.31];
const ANCHOR_ROLES = new Set(["mirror"]);

/** Is a cockpit-local point inside the dashcam frustum (with margin)? */
function inFrustum(x, y, z, hHalf, vHalf, cam = CAM) {
  const dx = x - cam[0], dy = y - cam[1], dz = z - cam[2];
  // rotate into camera space; the lens looks along +z, pitched down by TILT
  const cz = dz * Math.cos(TILT) - dy * Math.sin(TILT);
  if (cz <= NEAR) return false;
  const cy = dz * Math.sin(TILT) + dy * Math.cos(TILT);
  return Math.abs(dx) <= hHalf * cz && Math.abs(cy) <= vHalf * cz;
}

/* Clip one primitive to the frustum, keeping any triangle with a vertex
   inside, and COMPACT the result. Dropping indices alone would leave every
   original vertex in the buffers — the triangle count would fall and the file
   would not, which is the opposite of the point. Vertices are therefore
   remapped and every attribute rebuilt against the survivors. */
function clipPrimitive(doc, prim, matrix, hHalf, vHalf, cam) {
  const pos = prim.getAttribute("POSITION");
  if (!pos) return { before: 0, after: 0 };
  const idx = prim.getIndices();
  const triCount = (idx ? idx.getCount() : pos.getCount()) / 3;
  const at = (i) => (idx ? idx.getScalar(i) : i);

  // vertex-level visibility, computed once each rather than per triangle
  const vis = new Uint8Array(pos.getCount());
  const el = [];
  for (let v = 0; v < pos.getCount(); v++) {
    pos.getElement(v, el);
    const x = matrix[0] * el[0] + matrix[4] * el[1] + matrix[8] * el[2] + matrix[12];
    const y = matrix[1] * el[0] + matrix[5] * el[1] + matrix[9] * el[2] + matrix[13];
    const z = matrix[2] * el[0] + matrix[6] * el[1] + matrix[10] * el[2] + matrix[14];
    vis[v] = inFrustum(x, y, z, hHalf, vHalf, cam) ? 1 : 0;
  }

  const kept = [];
  for (let t = 0; t < triCount; t++) {
    const a = at(t * 3), b = at(t * 3 + 1), c = at(t * 3 + 2);
    if (vis[a] || vis[b] || vis[c]) kept.push(a, b, c);
  }
  if (kept.length === 0) return { before: triCount, after: 0, empty: true };
  if (kept.length === triCount * 3) return { before: triCount, after: triCount };

  // remap surviving vertices to a dense range
  const remap = new Int32Array(pos.getCount()).fill(-1);
  const order = [];
  for (const v of kept) if (remap[v] < 0) { remap[v] = order.length; order.push(v); }

  for (const sem of prim.listSemantics()) {
    const a = prim.getAttribute(sem);
    const size = a.getElementSize();
    const out = new (a.getArray().constructor)(order.length * size);
    const tmp = [];
    for (let i = 0; i < order.length; i++) {
      a.getElement(order[i], tmp);
      for (let c = 0; c < size; c++) out[i * size + c] = tmp[c];
    }
    prim.setAttribute(sem, doc.createAccessor().setType(a.getType()).setNormalized(a.getNormalized()).setArray(out));
  }
  prim.setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(kept.map((v) => remap[v]))));
  return { before: triCount, after: kept.length / 3 };
}

/* Roles the cockpit code binds to, in priority order — first pattern that
   matches a node claims it. `cluster` and `screen` matter most: those two are
   replaced at runtime with our own live canvases (dashboard.ts / carscreen.ts),
   so they have to come through as their own meshes with their own materials
   rather than merged into the dash. Everything under `shell` is static trim
   that only has to look right. */
const ROLES = [
  ["cluster", /SpeedoScreen|InstrumentCluster|GaugeScreen/i],
  ["clusterGlass", /SpeedoGlass/i],
  ["screen", /InfoTainment ?Screen|CenterScreen|NavScreen/i],
  /* `wheel` turns with steering; `column` does not. Stalks especially: they
     are fixed to the column, and a donor that models them as part of the wheel
     assembly will swing them round with the rim if they share a role. */
  ["wheel", /^SteeringWheel[ _]|SteeringWheel Emblem/i],
  ["column", /^Stalks|SteeringColumn/i],
  /* Cabin structure, added once clipping made it affordable. These are whole-
     car meshes — the shell spans bumper to bumper and the door card runs the
     length of the cabin — and they are only worth taking because the frustum
     keeps 9% and 17% of them respectively: the A-pillars, the windscreen
     header, and the sliver of driver's door that shows past the dash. Without
     clipping this role would cost 228k triangles instead of ~27k.
     Corresponds to the "cabin" merge region in cockpit.ts, which is what the
     procedural pillars/roof/door cards hide behind when a donor brings its
     own. */
  /* The donor's rear-view mirror gets its own role, not "cabin": we take its
     BODY and refuse its glass. A reflection needs a render target and a
     donor's mirror is painted on, so cockpit.ts keeps its own RT-fed,
     UV-cropped glass and simply moves it into this housing. */
  ["mirror", /RearviewMirror/i],
  ["cabin", /^Shell_|DoorPanelFront|^Plane\.057/i],
  ["shell", /Dashboard|^Vents|Knobs|Glovebox|CenterConsole|Shifterknob|Plane\.049/i],
];

/* The rest of the cabin, added by --full-cabin. These roles exist ONLY for the
   unclipped build and the runtime binds to none of them: they are trim that
   has to be there so the cabin is whole when the lens is wound out wide, and
   nothing more.

   Which nodes made the list is a measurement, not taste. Every donor node was
   tested against the widest frustum the Field-of-view slider can produce
   (129.5 x 125 degrees, the POV_FOV_MAX pair from engine.ts, plus MARGIN) at
   every lens height the mount is likely to use, and only nodes some legal
   frustum can reach are here. The rear bench, the rear door cards, the rear
   shelf, the seat belts and the entire bodywork all fail that test with room
   to spare — they sit behind the lens, so no field of view reaches them.

   NOT here on purpose: the donor's windscreen ("Windsheild Null"). cockpit.ts
   keeps its own window glass in every state (see the KEPT list in
   cockpitmodel.ts) and a second pane in the same place would double the
   reflections.

   `sideMirror` is the one role here that is NOT interior trim, and it earns
   its place on a different argument from the rest. A door mirror is the only
   thing outside the cabin the driver is supposed to look AT rather than
   through, and cockpit.ts hangs its own RT-fed glass in it — which was
   floating, because the procedural housings it was fitted to were placed
   against different geometry and the donor's own mirrors were never taken.
   Taking them gives that glass a real shell at the car's real mounting point.

   It is also the one role the frustum test does not clear outright. Measured
   from the shipped lens (0.28, 1.20, 0.31), the LEFT mirror sits 62.3 degrees
   off axis — inside the 64.8-degree half-angle POV_FOV_MAX gives, so it
   enters frame at a wide setting and not at the default 67 — while the RIGHT
   one is 74.5 degrees off and no legal frustum reaches it. It comes anyway,
   for free: the donor models both mirrors as ONE symmetric mesh per material,
   so there is no version of this role that keeps the left and drops the right
   short of slicing geometry, which --no-clip exists to avoid. */
const FULL_ROLES = [
  ["seats", /^(Driver|Passenger) Seat/i],
  // the FRONT carpets only — "Rear Carpet" is under the rear bench, which no
  // legal frustum reaches, and a bare /Carpet/ quietly swept it in
  ["floor", /^Floor_|^Driver Carpet|^PassengerCarpet|^PlasticTrim/i],
  ["pedals", /Pedal/i],
  ["headliner", /^CeilingConsole/i],
  /* Anchored, and NOT a bare /mirror/i, for two reasons that both bite.
     The donor spells the wing mirror with a capital I — "MIrror_Car Paint_0",
     "MIrrorTurnSignal Glass_Glass_0" — so a pattern that assumes "Mirror"
     silently matches nothing; and the rear-view mirror is "RearviewMirror",
     which a loose pattern WOULD match. The `mirror` role above claims that
     one first, but relying on table order to keep them apart is a trap: the
     `mirror` role is frozen to a legacy frustum precisely because its
     bounding box positions the game's rear-view glass, and anything that
     reaches it moves the mirror. The ^ is what makes that impossible. */
  ["sideMirror", /^MIrror(_| |Turn)/i],
];
if (FULL_CABIN) ROLES.push(...FULL_ROLES);

/* Decimation budget per role: [ratio of triangles to keep, error limit as a
   fraction of the mesh radius, lock topological borders].

   Ratios are set by how close the part gets to the lens and how much of the
   frame it holds, not by triangle count. The dash pad and the vents are the
   hero surfaces — they fill the bottom half of the dashcam frame at arm's
   length — so they give up the least. The seats and the footwell are only
   reachable at all with the slider wound to its maximum, where they appear
   far down the frame edge behind the console, so they give up the most.

   `error` is what actually binds: meshoptimizer stops at the ratio OR the
   error limit, whichever comes first, so an error limit tight enough to be
   invisible on a dash (0.4% of a 0.9 m mesh radius is ~4 mm) will refuse to
   reach an aggressive ratio and the report below will show the shortfall.
   Roles absent from this table are NOT simplified — see ANCHOR_ROLES, and
   note that `wheel` is out for a second reason: the manifest's steering axis
   is a principal-axis fit to that vertex cloud, and thinning the rim
   asymmetrically would tilt it.

   `lockBorder` on `cabin` because that role is where the A-pillars and the
   windscreen header live: they are the open edges of a shell mesh, they are
   silhouetted against a bright sky, and an unlocked border retracts them into
   visibly ragged pillars. */
/* Texture budget per role, in pixels, resolved per IMAGE as the largest
   budget of any role that reaches it (see TEX_ROLE resolution below). 0 leaves
   the source resolution alone; roles absent from the table fall back to --tex.

   A global --tex is the wrong instrument here, and the measurement says so
   plainly. At a flat 2048 the six heavy materials cost 4.55 MB, and the
   ranking is upside down: `Front_Seat` is the single most expensive thing in
   the file at 1.17 MB, for geometry that only enters frame with the slider at
   100 and then only at the extreme edge — while `Dashboard`, the pad 30 cm
   from the lens that fills the bottom half of every dashcam frame, is the
   CHEAPEST of the six at 0.54 MB. Halving the global number to pay for the
   file taxes the hero surface to subsidise the upholstery.

   So: arm's reach keeps 2048, structure gets 1536, and things that are only
   ever seen dark, far down the frame, or not at all get 1024 or 512. The dash
   is not touched by any of it.

   `mirror` is 512 and could be anything: cockpitmodel.ts hides the donor's
   housing the moment it loads and keeps only the bounding box, so those texels
   are never sampled. It shares the `Shell` material with `cabin`, which is why
   the resolution rule is a MAX and not a MIN — a min would let this role, the
   one role that renders nothing, drag the A-pillars down with it. */
const TEX_ROLE = {
  shell: 2048, wheel: 2048, column: 2048,   // arm's reach, and always in frame
  cabin: 1536,                              // A-pillars, header, door cards: mostly silhouette
  headliner: 1024, floor: 1024, pedals: 1024,
  seats: 512, mirror: 512, sideMirror: 512,
  cluster: 0, clusterGlass: 0, screen: 0,   // already small; the live canvas covers them anyway
};

const SIMPLIFY = {
  shell:     { ratio: 0.45, error: 0.004 },
  cabin:     { ratio: 0.28, error: 0.008, lockBorder: true },
  column:    { ratio: 0.35, error: 0.008 },
  headliner: { ratio: 0.30, error: 0.010 },
  floor:     { ratio: 0.15, error: 0.020 },
  pedals:    { ratio: 0.30, error: 0.015 },
  seats:     { ratio: 0.10, error: 0.030 },
  /* The tightest error in the table, on the role with the loosest ratio, and
     the two are not in tension: a door mirror is a smooth painted blob at the
     edge of frame, so 70% of its triangles buy nothing — but `error` here is
     a fraction of MESH radius, and this mesh spans both mirrors, so its radius
     is ~1.0 m rather than the 0.2 m object you are looking at. 0.003 is 3 mm
     absolute; the 0.008 that `cabin` uses would be 8 mm on a 171 mm bezel,
     which is a visibly nibbled ring. Tight also because cockpit.ts sits its
     glass on that bezel from measured constants — see SIDE_MIR there — so
     millimetres of drift here are millimetres the glass floats by. */
  sideMirror: { ratio: 0.30, error: 0.003 },
};
const roleOf = (name) => ROLES.find(([, re]) => re.test(name))?.[0] ?? null;

/* Only the two extensions --meshopt writes, deliberately not ALL_EXTENSIONS.
   Registering an extension registers it for READING too, and this donor
   carries KHR_materials_clearcoat and KHR_materials_transmission that are
   currently dropped on the way in — picking them up would silently change the
   shading of every part that ships, which is not this flag's business. */
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(SRC);
const root = doc.getRoot();

const primTris = (p) => {
  const ix = p.getIndices(); return (ix ? ix.getCount() : p.getAttribute("POSITION").getCount()) / 3;
};
const triCount = (mesh) => mesh.listPrimitives().reduce((a, p) => a + primTris(p), 0);
const before = { tris: root.listMeshes().reduce((a, m) => a + triCount(m), 0), img: root.listTextures().length };

/* ---------------------------------------------------------------- select -- */

/* Walk the scene accumulating world matrices, because the parts we keep are
   nested under authoring groups whose transforms are load-bearing. */
const keep = [];
const walk = (node, parentMat) => {
  const m = mulMat(parentMat, node.getMatrix());
  const role = node.getMesh() ? roleOf(node.getName()) : null;
  if (role) keep.push({ node, role, matrix: m });
  for (const c of node.listChildren()) walk(c, m);
};
function mulMat(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

if (!keep.length) { console.error("no nodes matched any role — check ROLES against `node tools/inspect-glb.mjs <src> --tree`"); process.exit(1); }

/* --------------------------------------------------------------- rebuild -- */

/* A fresh scene rather than pruning the old one: the donors carry deep empty
   hierarchies, and detaching in place leaves stubs that prune() keeps alive. */
/* Measured BEFORE clipping. The frustum keeps only ~41% of the rim (its
   lower half is under the frame edge), and fitting a plane to an arc that
   has been cut asymmetrically drags the normal off the true column axis.
   The axis is a fact about the donor car, not about what is in shot. */
let steering = null;
/* The steering axis, measured rather than guessed. The game spins its own
   wheel about local Z, but a donor's column is raked back and sits at whatever
   angle that car uses, so turning the imported rim about any world axis visibly
   wobbles it. A steering wheel is a flat-ish disc, so its vertices have very
   little spread along the column direction and a lot across it: the smallest
   principal axis of the vertex cloud IS the steering axis, and the centroid is
   the hub. Recorded here so the runtime can build a pivot and never has to
   read vertex data. */
if (keep.some((k) => k.role === "wheel")) {
  const pts = [];
  for (const { node, role, matrix } of keep) {
    if (role !== "wheel") continue;
    for (const p of node.getMesh().listPrimitives()) {
      const a = p.getAttribute("POSITION"), el = [];
      // every 7th vertex: plenty for a covariance estimate, and keeps big rims cheap
      for (let i = 0; i < a.getCount(); i += 7) {
        a.getElement(i, el);
        pts.push([matrix[0]*el[0]+matrix[4]*el[1]+matrix[8]*el[2]+matrix[12],
                  matrix[1]*el[0]+matrix[5]*el[1]+matrix[9]*el[2]+matrix[13],
                  matrix[2]*el[0]+matrix[6]*el[1]+matrix[10]*el[2]+matrix[14]]);
      }
    }
  }
  const c = [0, 1, 2].map((k) => pts.reduce((a, p) => a + p[k], 0) / pts.length);
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for (const p of pts) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (p[i]-c[i]) * (p[j]-c[j]);
  /* Smallest eigenvector by inverse power iteration, done as repeated
     multiplication by (trace*I - C): that flips the spectrum so the SMALLEST
     eigenvector of C becomes the largest, which plain power iteration finds. */
  const tr = C[0][0] + C[1][1] + C[2][2];
  const M = C.map((r, i) => r.map((v, j) => (i === j ? tr - v : -v)));
  let v = [0.3, 0.5, 0.81];
  for (let it = 0; it < 60; it++) {
    const w = M.map((r) => r[0]*v[0] + r[1]*v[1] + r[2]*v[2]);
    const n = Math.hypot(...w); v = w.map((x) => x / n);
  }
  if (v[2] < 0) v = v.map((x) => -x);           // point the axis back toward the driver
  steering = { hub: c.map((x) => +x.toFixed(4)), axis: v.map((x) => +x.toFixed(4)) };
}

const scene = doc.createScene(OUT_NAME);
const manifest = { source: path.basename(SRC), parts: {} };

/* Nodes are RENAMED to `<role>_<n>` rather than keeping the donor's names, and
   that is load-bearing rather than tidiness. three's GLTFLoader pushes every
   name through PropertyBinding.sanitizeNodeName on the way in, which turns
   spaces into underscores and strips dots — so donor names like
   "InfoTainment Screen_infotainmentScreen_0" or "Plane.049_CenterConsole_0"
   arrive under a different string than the one written here, and a lookup by
   the donor's spelling silently finds nothing. Worse, donors reuse names (this
   one has two nodes called "Dashboard_Dashboard_0") and the loader quietly
   uniquifies the duplicate, so even an exact match can land on the wrong mesh.
   Role-indexed names are unique, contain nothing sanitizing touches, and mean
   the runtime never has to know how a particular donor spells anything. */
const seen = {};
let clipBefore = 0, clipAfter = 0;
const flatParts = [];
for (const { node, role, matrix } of keep) {
  const mesh = node.getMesh();

  /* Clip BEFORE the node is named and recorded, so a part that turns out to be
     entirely out of frame — the shifter and its knob, on this donor — is
     dropped rather than shipped as an empty mesh with a live material keeping
     4K textures alive behind it. */
  const anchor = ANCHOR_ROLES.has(role);
  if (CLIP || anchor) {
    let live = 0;
    for (const prim of mesh.listPrimitives()) {
      const r = clipPrimitive(doc, prim, matrix,
        anchor ? LEGACY_H_HALF : H_HALF, anchor ? LEGACY_V_HALF : V_HALF,
        anchor ? LEGACY_CAM : CAM);
      clipBefore += r.before; clipAfter += r.after;
      if (r.after === 0) prim.dispose(); else live++;
    }
    if (!live) { mesh.dispose(); continue; }
  }

  const n = (seen[role] = (seen[role] ?? -1) + 1);
  const id = `${role}_${n}`;
  const flat = doc.createNode(id).setMatrix(matrix).setMesh(mesh);
  scene.addChild(flat);
  // recorded, but the manifest entry is filled in after decimation — its
  // triangle counts and bounding boxes have to describe what actually ships
  flatParts.push({ role, id, mesh, flat, donorName: node.getName() });
}
/* Accessor min/max in the accessor's OWN units, converted back to the floats
   the renderer will see. --meshopt leaves POSITION as normalized Int16 — the
   value is raw/32767 and the node matrix carries the rest of the scale — and
   reading the raw integers instead gives boxes thousands of "metres" across,
   which is a number, looks like a number, and silently parks the gauge cluster
   somewhere over the horizon. */
function denorm(a, v) {
  if (!a.getNormalized()) return v;
  const bytes = a.getArray().BYTES_PER_ELEMENT, signed = /Int(8|16|32)Array/.test(a.getArray().constructor.name);
  const scale = signed ? 2 ** (8 * bytes - 1) - 1 : 2 ** (8 * bytes) - 1;
  return v.map((x) => Math.max(signed ? -1 : 0, x / scale));
}
function worldBounds(mesh, m) {
  let lo = null, hi = null;
  for (const p of mesh.listPrimitives()) {
    const a = p.getAttribute("POSITION");
    const mn = denorm(a, a.getMin([])), mx = denorm(a, a.getMax([]));
    for (let c = 0; c < 8; c++) {
      const v = [c & 1 ? mx[0] : mn[0], c & 2 ? mx[1] : mn[1], c & 4 ? mx[2] : mn[2]];
      const w = [m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12], m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13], m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14]];
      if (!lo) { lo = w.slice(); hi = w.slice(); }
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
    }
  }
  return [lo.map((v) => +v.toFixed(4)), hi.map((v) => +v.toFixed(4))];
}


if (steering) manifest.steering = steering;

for (const s of root.listScenes()) if (s !== scene) s.dispose();
root.setDefaultScene(scene);

/* prune() is what actually collects the win: with the old scenes gone, every
   mesh, material, texture and accessor the discarded geometry owned is now
   unreachable and goes with it. */
await doc.transform(prune());

/* ------------------------------------------------------------- decimate -- */

/* Per PART rather than as a document transform, because the whole point is
   that the roles do not share a budget: the dash keeps 45% and the seats keep
   10%, and gltf-transform's `simplify()` takes one ratio for the file.

   Welding first is not optional — meshoptimizer collapses edges, and a donor
   mesh exported with split vertices per face has no shared edges to collapse,
   so an unwelded primitive comes back at very nearly its original size. Welded
   per primitive rather than through weld() for the same reason as above: the
   anchor roles must not be touched at all.

   Runs BEFORE dedup() so that no two parts can be sharing one mesh by the time
   ratios are applied — deduplicated first, a mesh reached from two roles would
   be decimated twice, once at each ratio. */
const simp = new Map();             // role -> { before, after, want }
if (SIMPLIFY_ON) {
  await MeshoptSimplifier.ready;
  for (const { role, mesh } of flatParts) {
    const budget = SIMPLIFY[role];
    if (!budget || ANCHOR_ROLES.has(role)) continue;
    const row = simp.get(role) ?? { before: 0, after: 0, want: budget.ratio };
    for (const prim of mesh.listPrimitives()) {
      row.before += primTris(prim);
      weldPrimitive(prim, { overwrite: false });
      simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ...budget });
      row.after += primTris(prim);
    }
    simp.set(role, row);
  }
}

await doc.transform(dedup());

/* Resolve each image's pixel budget from the roles that actually reach it.
   Done here, while the flat scene still maps node -> role by name, because
   after this point the only link left between a texture and the part wearing
   it is the material graph. */
const texBudget = new Map();
{
  const roleOfNode = new Map(flatParts.map((f) => [f.id, f.role]));
  for (const node of scene.listChildren()) {
    const role = roleOfNode.get(node.getName());
    const mesh = node.getMesh();
    if (role === undefined || !mesh) continue;
    const want = TEX_ROLE[role] ?? TEX;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat) continue;
      for (const tex of [mat.getBaseColorTexture(), mat.getNormalTexture(), mat.getMetallicRoughnessTexture(),
                         mat.getEmissiveTexture(), mat.getOcclusionTexture()]) {
        if (!tex) continue;
        // MAX, not min: a map shared with a hero role keeps the hero's budget
        const cur = texBudget.get(tex);
        texBudget.set(tex, cur === undefined ? want : (cur === 0 || want === 0 ? 0 : Math.max(cur, want)));
      }
    }
  }
}

/* ---------------------------------------------------------------- shrink -- */

/* Container, not content. The clipped dash is ~340k triangles of float32
   everything in PNG wrappers, which lands around 18 MB; the same model with
   its buffers packed honestly is 7. Everything here is either exactly lossless
   or below the threshold the shipped rendering can resolve, and NONE of it
   touches POSITION — cockpitmodel.ts anchors the live gauge cluster and the
   mirror glass off bounding boxes computed from those vertices, so drifting
   them by even a millimetre silently misplaces both. (14-bit position
   quantisation was tried when this pass was first done by hand: another
   880 KB, but it shredded the A-pillar and drifted the boxes by up to 10 mm.
   --meshopt does quantise positions, at 16 bits over a per-mesh volume rather
   than 14 over the car, and re-measures the manifest afterwards — see the
   MESHOPT block at the top for why that is a different proposition.)

   Under --meshopt the NORMAL and TEXCOORD passes stand down and quantize()
   does that job instead: it packs the same attributes to the widths the
   meshopt FILTER encoder expects, and handing it attributes that are already
   normalised integers only costs a round trip.

   This used to live outside the repo — the shipped GLB was shrunk once, in
   place, by a pass that was never committed. That drift is why a rebuild from
   this tool produced a file two and a half times the size of the one next to
   it in git. Folded in here so the tool reproduces what it ships. */
function shrinkBuffers() {
  let idxSaved = 0, tanSaved = 0, attrSaved = 0;
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    /* three derives a per-fragment tangent frame from screen-space derivatives
       when TANGENT is absent, which every other mesh in this game already
       relies on. */
    const tan = prim.getAttribute("TANGENT");
    if (tan) { tanSaved += tan.getArray().byteLength; prim.setAttribute("TANGENT", null); }

    // Uint32 indices on primitives that cannot hold more than 65,535 vertices
    const ix = prim.getIndices(), verts = prim.getAttribute("POSITION").getCount();
    if (ix && verts <= 65535 && ix.getArray().BYTES_PER_ELEMENT > 2) {
      idxSaved += ix.getArray().byteLength / 2;
      ix.setArray(new Uint16Array(ix.getArray()));
    }

    /* Unit normals in float32 spend 32 bits describing a number that is always
       within [-1,1]: byte-normalised costs a quarter of that and 0.5 deg of
       angular error, well under what a 512px normal map already contributes.
       UVs go to normalised Uint16 — 1/65535 of a texture, i.e. a hundredth of
       a texel at this resolution — but only when they are inside [0,1], since
       normalised integers cannot express a tiled UV at all. */
    const nrm = prim.getAttribute("NORMAL");
    if (nrm && !nrm.getNormalized() && !MESHOPT) {
      const src = nrm.getArray(), out = new Int8Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(src[i] * 127)));
      attrSaved += src.byteLength - out.byteLength;
      nrm.setArray(out).setNormalized(true);
    }
    const uv = prim.getAttribute("TEXCOORD_0");
    if (uv && !uv.getNormalized() && !MESHOPT) {
      const src = uv.getArray();
      let inRange = true;
      for (let i = 0; i < src.length; i++) if (src[i] < 0 || src[i] > 1) { inRange = false; break; }
      if (inRange) {
        const out = new Uint16Array(src.length);
        for (let i = 0; i < src.length; i++) out[i] = Math.round(src[i] * 65535);
        attrSaved += src.byteLength - out.byteLength;
        uv.setArray(out).setNormalized(true);
      }
    }
  }
  return { idxSaved, tanSaved, attrSaved };
}
const shrunk = shrinkBuffers();
// detaching TANGENT leaves its accessors orphaned in the document, and an
// orphaned accessor is still written out — 3.8 MB of it, here
await doc.transform(prune());

if (MESHOPT) {
  await MeshoptEncoder.ready;
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "high", quantizePosition: QUANT_POSITION }));
}

/* --------------------------------------------------------- the manifest -- */

/* Measured HERE, last, off the geometry and the node transforms that are about
   to be written out — not off the donor's. Everything above moves vertices or
   the matrices over them: the frustum clip drops them, --simplify collapses
   them, --meshopt quantises them and pushes the dequantisation into the node.
   cockpitmodel.ts positions the live gauge cluster and the RT-fed mirror glass
   from these boxes and nothing else, so a box measured one stage too early is
   a cluster in the wrong place, silently and only at runtime. */
/* Looked up by NAME in the finished scene, and the matrix accumulated up
   through whatever parents it now has, rather than reusing the node handle and
   the world matrix from the flattening pass. quantize() does not promise to
   leave either alone: it pushes a dequantisation transform somewhere above the
   mesh, and whether that lands on this node or on a wrapper it inserts is an
   implementation detail. Reading it back out of the scene is the only version
   that cannot go stale — and going stale here is silent, since the numbers
   still look like numbers (they come out in quantisation units, thousands of
   "metres" from the car). */
const nodeByName = new Map();
(function index(parent, mat) {
  for (const n of parent.listChildren()) {
    const m = mulMat(mat, n.getMatrix());
    if (n.getMesh()) nodeByName.set(n.getName(), { node: n, matrix: m });
    index(n, m);
  }
})(scene, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

for (const { role, id, donorName } of flatParts) {
  const hit = nodeByName.get(id);
  if (!hit) continue;               // clipped away to nothing, or pruned
  const mesh = hit.node.getMesh();
  (manifest.parts[role] ??= []).push({
    name: id,
    donorName,                      // kept for tracing back to the source file
    tris: Math.round(triCount(mesh)),
    bbox: worldBounds(mesh, hit.matrix),
  });
}

/* PNG is a lossless wrapper around a photograph, which is the wrong trade for
   a 512px car-interior map. mozjpeg at 4:4:4 for the normal maps specifically:
   a normal's X and Y live in the R and G channels, and ordinary 4:2:0 chroma
   subsampling smears exactly those two while leaving Z alone, which tilts the
   lighting rather than softening it. Anything with real transparency is left
   as it is — JPEG has no alpha channel to leave it in. */
const normalTex = new Set();
for (const mat of root.listMaterials()) if (mat.getNormalTexture()) normalTex.add(mat.getNormalTexture());
let imgBefore = 0, imgAfter = 0;
const texReport = [];
for (const tex of root.listTextures()) {
  const img = tex.getImage(); if (!img) continue;
  imgBefore += img.byteLength;
  const src = tex.getSize() || [0, 0];
  /* Resize and re-encode in ONE pass. These used to be two — gltf-transform's
     textureCompress() for the resize, then this loop for the JPEG — and that
     decoded every 4K image twice. It also meant an image that arrived as JPEG
     took the `continue` below and silently skipped the resize with it. */
  const want = texBudget.get(tex) ?? TEX;
  const resize = want > 0 && (src[0] > want || src[1] > want);
  if (!resize && tex.getMimeType() === "image/jpeg") { imgAfter += img.byteLength; continue; }

  let pipe = sharp(Buffer.from(img));
  const { hasAlpha } = await pipe.metadata();
  /* Real transparency is left exactly as it arrived, resize and all: JPEG has
     no alpha channel to put it in, and re-encoding as PNG at a new size is not
     a saving worth the risk of flattening a cutout. */
  if (hasAlpha && (await pipe.clone().stats()).isOpaque === false) { imgAfter += img.byteLength; continue; }
  if (resize) pipe = pipe.resize(want, want, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" });
  const isNormal = normalTex.has(tex);
  const out = await pipe
    .flatten({ background: "#000000" })
    .jpeg({ mozjpeg: true, quality: isNormal ? JPEG_Q + 5 : JPEG_Q, chromaSubsampling: isNormal ? "4:4:4" : "4:2:0" })
    .toBuffer();
  tex.setImage(out).setMimeType("image/jpeg");
  imgAfter += out.byteLength;
  texReport.push({ px: resize ? want : src[0], was: src[0], bytes: out.byteLength });
}

const after = { tris: root.listMeshes().reduce((a, m) => a + triCount(m), 0), img: root.listTextures().length };
const vram = root.listTextures().reduce((a, t) => { const s = t.getSize() || [0, 0]; return a + s[0] * s[1] * 4 * 1.333; }, 0);

/* ---------------------------------------------------------------- report -- */

const pc = (a, b) => `${((100 * a) / b).toFixed(1)}%`;
console.log(`\n${path.basename(SRC)} -> ${OUT_NAME}.glb`);
console.log(`  triangles : ${before.tris.toLocaleString()} -> ${after.tris.toLocaleString()}  (${pc(after.tris, before.tris)})`);
const byPx = new Map();
for (const t of texReport) byPx.set(t.px, (byPx.get(t.px) ?? 0) + t.bytes);
console.log(`  textures  : ${before.img} -> ${after.img}` +
  (byPx.size ? `   ${[...byPx].sort((a, b) => b[0] - a[0]).map(([px, b]) => `${px}px ${(b / 1e6).toFixed(2)}MB`).join(", ")}` : ""));
console.log(`  VRAM      : ${(vram / 1e9).toFixed(2)} GB decoded RGBA8 + mips`);
if (simp.size) {
  /* "want" vs "got" is the number to read: a role that lands well short of its
     ratio hit its error limit, which means the budget above is asking for more
     than that mesh can give without visible damage. Raise the error, not the
     ratio. */
  console.log(`  decimate  :`);
  for (const [role, r] of simp)
    console.log(`    ${role.padEnd(13)} ${Math.round(r.before).toLocaleString().padStart(9)} -> ` +
                `${Math.round(r.after).toLocaleString().padStart(8)}t   want ${(r.want * 100).toFixed(0)}%, got ${pc(r.after, r.before)}`);
}
console.log(`  shrink    : indices -${(shrunk.idxSaved / 1e6).toFixed(2)} MB, tangents -${(shrunk.tanSaved / 1e6).toFixed(2)} MB, ` +
            `normals+UVs -${(shrunk.attrSaved / 1e6).toFixed(2)} MB, images ${(imgBefore / 1e6).toFixed(2)} -> ${(imgAfter / 1e6).toFixed(2)} MB`);
console.log(`  parts     :`);
for (const [role, list] of Object.entries(manifest.parts))
  console.log(`    ${role.padEnd(13)} ${list.map((p) => `${p.name} <- ${p.donorName} (${p.tris.toLocaleString()}t)`).join(", ")}`);
if (manifest.steering) {
  const { hub, axis } = manifest.steering;
  console.log(`  steering  : hub [${hub.join(" ")}]  axis [${axis.join(" ")}]  ` +
              `(${(Math.acos(Math.min(1, Math.abs(axis[2]))) * 180 / Math.PI).toFixed(1)} deg of column rake)`);
}

if (DRY) { console.log("\n  --dry: nothing written\n"); process.exit(0); }
fs.mkdirSync(OUT_DIR, { recursive: true });
const outGlb = path.join(OUT_DIR, `${OUT_NAME}.glb`);
await io.write(outGlb, doc);
fs.writeFileSync(path.join(OUT_DIR, `${OUT_NAME}.json`), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n  wrote ${outGlb}  (${(fs.statSync(outGlb).size / 1e6).toFixed(1)} MB)`);
console.log(`  wrote ${path.join(OUT_DIR, `${OUT_NAME}.json`)}\n`);
