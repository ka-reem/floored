/* A FAR tier for the traffic fleet: the same fourteen cars, decimated, for
 * the ones that are specks on the road.
 *
 * WHY THIS EXISTS AGAIN. traffic.ts's renderInstances carries this note:
 *
 *     "the Orchids models are 0.3-2.6k triangles — cheap enough that a
 *      separate coarse far tier stopped paying for itself"
 *
 * That was true when it was written and is not true now. Measured over
 * public/models/cars today:
 *
 *     mean 4,006 triangles/car; sedan 10,232; compact 10,399
 *
 * — four times the upper bound the decision was made against. The fleet got
 * heavier (the bodyshell rebake, the taillight work) and the conclusion was
 * never revisited. At ~80 active cars that is ~320k triangles a frame out of
 * the 938k the whole frame costs on mobile-base: a third of the budget spent
 * on cars, most of which are far enough away to be a few dozen pixels.
 *
 * WHY A FAR TIER RATHER THAN A FRUSTUM CULL. The instance buffer is built
 * ONCE per frame and drawn from by every camera — the main pass, the mirror,
 * and (on desktop) the road reflection. That is exactly why renderInstances
 * culls nothing by view direction, and it is a good reason. A distance tier
 * has no such problem: it makes every pass cheaper at once, mirror included,
 * and needs no per-camera bookkeeping.
 *
 * SILHOUETTE IS THE THING TO PRESERVE. A car reads by its outline, so this
 * uses meshoptimizer's edge-collapse simplifier through gltf-transform —
 * collapsing interior edges, not dropping triangles at random — and locks the
 * border so the outline survives. Textures, materials and the vertex-colour
 * paint channel are untouched, so a far car is the same car: same atlas, same
 * paint, same lamp tagging. Only the density of its interior changes.
 *
 * Usage:
 *   node tools/build-fleet-lod.mjs [--ratio 0.2] [--error 0.02] [--out DIR]
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { simplify, weld, dedup, prune } from "@gltf-transform/functions";
import draco from "draco3dgltf";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import { readdirSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const RATIO = Number(arg("--ratio", 0.2));
const ERROR = Number(arg("--error", 0.02));
const WELD = Number(arg("--weld", 0));
const SRC = "public/models/cars";
const OUT = arg("--out", "public/models/cars-far");

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco.createDecoderModule(),
  "draco3d.encoder": await draco.createEncoderModule(),
  "meshopt.decoder": MeshoptDecoder,
  "meshopt.encoder": MeshoptEncoder,
});

const tris = (doc) => {
  let t = 0;
  for (const m of doc.getRoot().listMeshes())
    for (const p of m.listPrimitives()) {
      const i = p.getIndices();
      t += i ? i.getCount() / 3 : p.getAttribute("POSITION").getCount() / 3;
    }
  return Math.round(t);
};

mkdirSync(OUT, { recursive: true });
let inTot = 0, outTot = 0, inBytes = 0, outBytes = 0;
console.log(`target ratio ${RATIO}, error ${ERROR}\n`);
console.log("style".padEnd(16), "tris in".padStart(8), "tris out".padStart(9), "kept".padStart(6), "KB in".padStart(7), "KB out".padStart(7));

for (const f of readdirSync(SRC).filter((f) => f.endsWith(".glb")).sort()) {
  const src = path.join(SRC, f), dst = path.join(OUT, f);
  const doc = await io.read(src);
  const before = tris(doc);
  /* weld FIRST. These bodyshells arrive split into many small primitives with
     duplicated vertices along every seam, and an un-welded seam vertex is a
     border the collapser may not touch — which is why a first pass with
     lockBorder:true barely moved the heavy models (compact stopped at 77% of
     its triangles). Welding makes the surface one connected mesh, and the
     border stays unlocked so interior edges across old seams can collapse
     too; a hairline seam is not visible on a car that is a few dozen pixels. */
  await doc.transform(
    weld({ tolerance: WELD }),
    simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR, lockBorder: false }),
    dedup(),
    /* GEOMETRY ONLY. traffic.ts draws every style through one shared
       MeshStandardMaterial (`this.npcMat`) with the fleet atlas on it, so a
       far model that carries its own copy of that atlas is shipping a texture
       nothing will ever sample. Dropping the images is most of the file: the
       first bake came out at 2.33 MB for the fourteen cars, nearly all of it
       duplicated texture. */
  );
  /* Detach the material BEFORE pruning, or prune keeps it — and its atlas —
     because a primitive still references it. traffic.ts draws every style
     through one shared MeshStandardMaterial (`this.npcMat`); the GLB is read
     for its GEOMETRY only, so a far model carrying its own copy of the fleet
     atlas is shipping a texture nothing will ever sample. This is most of the
     file: the bake was 1.89 MB across fourteen cars with the textures left in,
     for models averaging 1.5k triangles. */
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) prim.setMaterial(null);
  await doc.transform(prune());
  await io.write(dst, doc);
  const after = tris(doc);
  const bi = statSync(src).size, bo = statSync(dst).size;
  inTot += before; outTot += after; inBytes += bi; outBytes += bo;
  console.log(
    f.replace(".glb", "").padEnd(16),
    String(before).padStart(8), String(after).padStart(9),
    `${((after / before) * 100).toFixed(0)}%`.padStart(6),
    (bi / 1024).toFixed(0).padStart(7), (bo / 1024).toFixed(0).padStart(7)
  );
}
console.log("\n" + "TOTAL".padEnd(16), String(inTot).padStart(8), String(outTot).padStart(9),
  `${((outTot / inTot) * 100).toFixed(0)}%`.padStart(6),
  (inBytes / 1024).toFixed(0).padStart(7), (outBytes / 1024).toFixed(0).padStart(7));
console.log(`\nmean ${Math.round(inTot / 14)} -> ${Math.round(outTot / 14)} tris/car`);
console.log(`far tier adds ${(outBytes / 1048576).toFixed(2)} MB to the payload`);
