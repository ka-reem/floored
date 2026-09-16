/* Shrink an already-baked cockpit GLB's textures in place.
 *
 * THE FIX THIS EXISTS FOR. `volvo-s90-full.glb` decodes to 280 MB of RGBA8,
 * and every one of its 21 images is decoded at FULL size while the GLB is
 * parsed — so the load spikes through ~210 MB before a material has been
 * touched, whatever the render tier decides to keep afterwards. That spike is
 * what an iPhone answers with a lost context, and no tier cap, no lazy load
 * and no recovery mode can reach it: by the time any of them run, the decode
 * has already happened.
 *
 * The only thing that shrinks the spike is shipping smaller images. So this
 * rewrites the shipped file rather than re-baking from the 368 MB donor (which
 * is gitignored and not on every box): read the GLB, resample each image with
 * sharp, write it back. Payload goes DOWN as a side effect — the opposite
 * direction from every other quality lever here.
 *
 * Usage:
 *   node tools/shrink-cockpit.mjs <in.glb> --out <out.glb> --cap 1024 [--q 82]
 *
 *   --cap  longest edge any image may keep. Images already at or under it are
 *          left completely alone (re-encoding them would only lose quality).
 *   --q    JPEG quality for opaque images. Images WITH an alpha channel are
 *          re-encoded as PNG, because the cabin's alpha is cutout masks and a
 *          JPEG would turn their hard edges into grey fringes.
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco from "draco3dgltf";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { statSync } from "node:fs";
import sharp from "sharp";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d; };
const IN = args.find((a) => !a.startsWith("--") && a.endsWith(".glb"));
const OUT = opt("--out");
const CAP = Number(opt("--cap", 1024));
const Q = Number(opt("--q", 82));
if (!IN || !OUT) { console.error("usage: shrink-cockpit.mjs <in.glb> --out <out.glb> --cap 1024"); process.exit(1); }

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco.createDecoderModule(),
  "draco3d.encoder": await draco.createEncoderModule(),
  "meshopt.decoder": MeshoptDecoder,
  "meshopt.encoder": MeshoptEncoder,
});

const doc = await io.read(IN);
const MB = (b) => (b / 1048576).toFixed(2);
const vramOf = (list) => list.reduce((a, t) => { const [w, h] = t.getSize(); return a + w * h * 4 * 4 / 3; }, 0);

const before = doc.getRoot().listTextures();
const vramBefore = vramOf(before);
console.log(`in : ${IN}  ${MB(statSync(IN).size)} MB disk, ${MB(vramBefore)} MB VRAM, ${before.length} images`);

let touched = 0;
for (const t of doc.getRoot().listTextures()) {
  const [w, h] = t.getSize();
  const long = Math.max(w, h);
  if (long <= CAP) continue;
  const scale = CAP / long;
  /* Power-of-two in, power-of-two out: three.js mipmaps these, and a NPOT
     texture silently loses its mip chain on some drivers — which would cost
     more in shimmer than the resize saves in memory. */
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));

  const src = Buffer.from(t.getImage());
  const meta = await sharp(src).metadata();
  const pipe = sharp(src).resize(nw, nh, { fit: "fill", kernel: "lanczos3" });
  const [buf, mime] = meta.hasAlpha
    ? [await pipe.png({ compressionLevel: 9 }).toBuffer(), "image/png"]
    : [await pipe.jpeg({ quality: Q, mozjpeg: true }).toBuffer(), "image/jpeg"];

  t.setImage(buf).setMimeType(mime);
  console.log(`  ${(t.getName() || "(unnamed)").padEnd(28)} ${w}x${h} -> ${nw}x${nh}  ${meta.hasAlpha ? "png" : "jpg"} ${MB(buf.length)} MB`);
  touched++;
}

await io.write(OUT, doc);
const after = doc.getRoot().listTextures();
const vramAfter = vramOf(after);
console.log(`out: ${OUT}  ${MB(statSync(OUT).size)} MB disk, ${MB(vramAfter)} MB VRAM  (${touched} images resampled)`);
console.log(`VRAM ${MB(vramBefore)} -> ${MB(vramAfter)} MB  (-${(100 - (vramAfter / vramBefore) * 100).toFixed(0)}%)`);
console.log(`disk ${MB(statSync(IN).size)} -> ${MB(statSync(OUT).size)} MB`);
