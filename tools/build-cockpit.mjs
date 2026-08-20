/* Cuts a donor car model down to the dash the dashcam actually frames.

     node tools/build-cockpit.mjs <donor.glb> [--out NAME] [--tex N] [--dry]

   Run offline, not at build time — the GLB it writes is committed.

   Donor models are whole cars: bodywork, seats, wheels, rear cabin, all of it
   at full texture resolution. The POV camera (engine.ts POV_MOUNT, at
   cockpit-local 0.28/1.32/0.31 looking +z) sees none of that. It sees the dash
   pad, the binnacle, the head unit, the top of the wheel rim and the mirror.
   So this keeps that handful of nodes and throws the rest away, which is worth
   roughly an order of magnitude:

     Volvo S90 donor   3,273,670 tris   45 images   3.50 GB decoded
     hero dash cut       428,922 tris    9 images   0.81 GB decoded  (@4K)

   The saving is mostly in the textures, not the triangles. Nine 4K maps
   survive the cut because only three materials do; the other 36 images go
   with the geometry that referenced them. Triangles were never the problem —
   3.3M rasterises fine — but 3.5 GB of decoded texture does not fit anywhere.

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
import { prune, dedup, textureCompress } from "@gltf-transform/functions";
import sharp from "sharp";

const argv = process.argv.slice(2);
const SRC = argv.find((a) => !a.startsWith("--"));
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const OUT_NAME = flag("--out", "volvo-s90");
const TEX = Number(flag("--tex", 0)) || 0;   // 0 = leave source resolution
const DRY = argv.includes("--dry");
const CLIP = !argv.includes("--no-clip");
const OUT_DIR = path.resolve(import.meta.dirname, "../public/models/cockpits");

if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: node tools/build-cockpit.mjs <donor.glb> [--out NAME] [--tex N] [--no-clip] [--dry]");
  process.exit(1);
}

/* ------------------------------------------------------ the POV frustum -- */

/* The dashcam lens, in cockpit-local metres, mirroring engine.ts: POV_MOUNT
   (with the imported-dash height) offset from cockpit.ts's EYE, pitched down
   POV_TILT, at POV_HFOV horizontal.

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

   The margins are deliberately loose. Vertical especially: three's fov is
   vertical and engine.ts derives it from the aspect each frame, so a portrait
   phone sees materially more than a 16:9 desktop. Cutting to a desktop frame
   would print a hard geometry edge across a phone's view. Cheap insurance —
   the parts near the frame edge are the thin ones. */
const CAM = [0.28, 1.35 - 0.15, -0.30 + 0.61];
const TILT = 0.227;
const H_HALF = Math.tan((105 / 2) * Math.PI / 180);
const V_HALF = H_HALF / (16 / 9);
const H_MARGIN = 1.25, V_MARGIN = 1.7;
const NEAR = 0.02;

/** Is a cockpit-local point inside the dashcam frustum (with margin)? */
function inFrustum(x, y, z) {
  const dx = x - CAM[0], dy = y - CAM[1], dz = z - CAM[2];
  // rotate into camera space; the lens looks along +z, pitched down by TILT
  const cz = dz * Math.cos(TILT) - dy * Math.sin(TILT);
  if (cz <= NEAR) return false;
  const cy = dz * Math.sin(TILT) + dy * Math.cos(TILT);
  return Math.abs(dx) <= H_HALF * cz * H_MARGIN && Math.abs(cy) <= V_HALF * cz * V_MARGIN;
}

/* Clip one primitive to the frustum, keeping any triangle with a vertex
   inside, and COMPACT the result. Dropping indices alone would leave every
   original vertex in the buffers — the triangle count would fall and the file
   would not, which is the opposite of the point. Vertices are therefore
   remapped and every attribute rebuilt against the survivors. */
function clipPrimitive(doc, prim, matrix) {
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
    vis[v] = inFrustum(x, y, z) ? 1 : 0;
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
  ["cabin", /^Shell_|DoorPanel|^Plane\.057/i],
  ["shell", /Dashboard|^Vents|Knobs|Glovebox|CenterConsole|Shifterknob|Plane\.049/i],
];
const roleOf = (name) => ROLES.find(([, re]) => re.test(name))?.[0] ?? null;

const io = new NodeIO();
const doc = await io.read(SRC);
const root = doc.getRoot();

const triCount = (mesh) => mesh.listPrimitives().reduce((a, p) => {
  const ix = p.getIndices(); return a + (ix ? ix.getCount() : p.getAttribute("POSITION").getCount()) / 3;
}, 0);
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
for (const { node, role, matrix } of keep) {
  const mesh = node.getMesh();

  /* Clip BEFORE the node is named and recorded, so a part that turns out to be
     entirely out of frame — the shifter and its knob, on this donor — is
     dropped rather than shipped as an empty mesh with a live material keeping
     4K textures alive behind it. */
  if (CLIP) {
    let live = 0;
    for (const prim of mesh.listPrimitives()) {
      const r = clipPrimitive(doc, prim, matrix);
      clipBefore += r.before; clipAfter += r.after;
      if (r.after === 0) prim.dispose(); else live++;
    }
    if (!live) { mesh.dispose(); continue; }
  }

  const n = (seen[role] = (seen[role] ?? -1) + 1);
  const id = `${role}_${n}`;
  const flat = doc.createNode(id).setMatrix(matrix).setMesh(mesh);
  scene.addChild(flat);
  (manifest.parts[role] ??= []).push({
    name: id,
    donorName: node.getName(),      // kept for tracing back to the source file
    tris: Math.round(triCount(mesh)),
    bbox: worldBounds(mesh, matrix),
  });
}
function worldBounds(mesh, m) {
  let lo = null, hi = null;
  for (const p of mesh.listPrimitives()) {
    const a = p.getAttribute("POSITION"); const mn = a.getMin([]), mx = a.getMax([]);
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
await doc.transform(prune(), dedup());
if (TEX) await doc.transform(textureCompress({ encoder: sharp, resize: [TEX, TEX], resizeFilter: "lanczos3" }));

const after = { tris: root.listMeshes().reduce((a, m) => a + triCount(m), 0), img: root.listTextures().length };
const vram = root.listTextures().reduce((a, t) => { const s = t.getSize() || [0, 0]; return a + s[0] * s[1] * 4 * 1.333; }, 0);

/* ---------------------------------------------------------------- report -- */

const pc = (a, b) => `${((100 * a) / b).toFixed(1)}%`;
console.log(`\n${path.basename(SRC)} -> ${OUT_NAME}.glb`);
console.log(`  triangles : ${before.tris.toLocaleString()} -> ${after.tris.toLocaleString()}  (${pc(after.tris, before.tris)})`);
console.log(`  textures  : ${before.img} -> ${after.img}${TEX ? `  resized to ${TEX}px` : "  (source resolution)"}`);
console.log(`  VRAM      : ${(vram / 1e9).toFixed(2)} GB decoded RGBA8 + mips`);
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
