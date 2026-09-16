/* Decoded VRAM of every model the web build ships. File size is what you
   download; THIS is what has to fit in the phone's graphics memory, and it is
   the number that produces "context lost" crashes and frame-rate cliffs.
   RGBA8 + mips = w*h*4*1.333. */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco.createDecoderModule(),
  "meshopt.decoder": MeshoptDecoder,
});
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const rows = [];
for (const f of walk("public/models").filter((f) => f.endsWith(".glb"))) {
  try {
    const doc = await io.read(f);
    let tris = 0;
    for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
      const i = p.getIndices();
      tris += i ? i.getCount() / 3 : p.getAttribute("POSITION").getCount() / 3;
    }
    let vram = 0; const tex = doc.getRoot().listTextures();
    const sizes = {};
    for (const t of tex) { const s = t.getSize(); vram += s[0] * s[1] * 4 * 4 / 3;
      sizes[s.join("x")] = (sizes[s.join("x")] || 0) + 1; }
    rows.push({ f: f.replace("public/models/", ""), mb: statSync(f).size / 1048576,
      tris, vram: vram / 1048576, tex: tex.length,
      sizes: Object.entries(sizes).map(([k, v]) => `${v}x${k}`).join(" ") });
  } catch (e) { rows.push({ f, err: String(e).slice(0, 60) }); }
}
rows.sort((a, b) => (b.vram || 0) - (a.vram || 0));
console.log("file".padEnd(42), "disk".padStart(7), "tris".padStart(10), "VRAM".padStart(9), " textures");
let tDisk = 0, tVram = 0, tTris = 0;
for (const r of rows) {
  if (r.err) { console.log(r.f.padEnd(42), "ERR", r.err); continue; }
  tDisk += r.mb; tVram += r.vram; tTris += r.tris;
  console.log(r.f.padEnd(42), r.mb.toFixed(2).padStart(7), Math.round(r.tris).toLocaleString().padStart(10),
    (r.vram.toFixed(1) + " MB").padStart(9), " " + r.sizes);
}
console.log("-".repeat(96));
console.log("TOTAL".padEnd(42), tDisk.toFixed(2).padStart(7), Math.round(tTris).toLocaleString().padStart(10),
  (tVram.toFixed(1) + " MB").padStart(9));
