/* Authors the lamp mask for a Mint-generated bodyshell.

     node tools/seed-lamp-mask.mjs <model.glb> <mask.png> [--preview DIR]

   WHY THIS EXISTS
   ---------------
   tools/build-hifi-models.mjs tags lamp pixels by material slot ("rear
   lights") or by red texels. The Mint Prius defeats both: it is ONE
   material, and its lamps are painted into the atlas as WHITE/CLEAR glass
   (81 strongly-red texels in 2.36M — a red threshold finds nothing). So the
   lamp regions are carried by an explicit MASK over the atlas instead, and
   the bake samples each triangle's UV against it.

   THE MASK IS THE COMMITTED SOURCE OF TRUTH, not this script. It is an
   ordinary PNG the size of the model's atlas:

       RED   (255,0,0)  = tail / brake lens   -> lampKind 2
       GREEN (0,255,0)  = headlamp lens       -> lampKind 1
       black            = not a lamp          -> lampKind 0

   Open it in any paint program and fix it by hand; the bake reads whatever
   is in the file. This script only SEEDS it, so the file is reproducible
   from scratch rather than being an unexplained binary.

   HOW THE SEED WORKS
   ------------------
   Two stages, because neither alone is reliable:

   1. A 3D lens box picks the neighbourhood. Each texel's position on the car
      is known exactly (rasterize the UV triangles, interpolate POSITION), so
      "the rear lamp region" is a box in car space, not a guess in atlas
      space. The box is traced by hand on ONE side and MIRRORED to the other
      — the car is symmetric in 3D even though its UV islands are not, so
      one trace gives both lamps and they cannot disagree.

   2. Inside that box, an Otsu split separates lens from the bodywork the
      lens wraps into — a box alone spills onto the quarter panel, and a
      panel that glows red at night is worse than no lamp at all. The two
      lamp kinds need OPPOSITE tests, which is the whole reason this is not
      one threshold: a tail lens is DARK against bright silver, while a
      headlamp lens is bright but heavily STRUCTURED (reflectors, chrome
      segments) against a flat panel. So tails split on luminance and heads
      split on local luminance range.

   Then close / largest-blob / fill-holes, which turns a speckled threshold
   into the solid lens island the bake wants. */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const [SRC, OUT] = process.argv.slice(2);
const pvIx = process.argv.indexOf("--preview");
const PREVIEW = pvIx > -1 ? process.argv[pvIx + 1] : null;
if (!SRC || !OUT) {
  console.error("usage: node tools/seed-lamp-mask.mjs <model.glb> <mask.png> [--preview DIR]");
  process.exit(1);
}

/* Lens boxes in the SOURCE model's own normalized space (this donor arrives
   nose at -Z, ~±1 long). `ax` is |x|, so each entry covers both sides.
   Traced by hand off 8x atlas crops, then widened to the measured 3D extent
   of the traced polygon. Re-measure these if the source model is re-exported;
   everything downstream keys off the mask PNG, not off these numbers. */
const LENS = [
  { name: "tail", kind: 2, mode: "dark",   ax: [0.243, 0.372], y: [-0.020, 0.185], z: [0.795, 0.950] },
  { name: "head", kind: 1, mode: "struct", ax: [0.192, 0.376], y: [-0.070, 0.074], z: [-0.960, -0.672] },
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
});
const doc = await io.read(SRC);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const P = prim.getAttribute("POSITION").getArray();
const UV = prim.getAttribute("TEXCOORD_0").getArray();
const IX = prim.getIndices().getArray();
const img = Buffer.from(doc.getRoot().listTextures()[0].getImage());
const meta = await sharp(img).metadata();
const S = meta.width;
if (meta.width !== meta.height) throw new Error("expected a square atlas");
const alb = await sharp(img).removeAlpha().raw().toBuffer();
console.log(`atlas ${S}x${S}, ${IX.length / 3} tris`);

/* ---- where does each texel live on the car? ---- */
const pos = new Float32Array(S * S * 3);
const cover = new Uint8Array(S * S);
for (let t = 0; t < IX.length; t += 3) {
  const ia = IX[t], ib = IX[t + 1], ic = IX[t + 2];
  const u = [UV[ia * 2] * S, UV[ib * 2] * S, UV[ic * 2] * S];
  const v = [UV[ia * 2 + 1] * S, UV[ib * 2 + 1] * S, UV[ic * 2 + 1] * S];
  const x0 = Math.max(0, Math.floor(Math.min(...u)) - 1), x1 = Math.min(S - 1, Math.ceil(Math.max(...u)) + 1);
  const y0 = Math.max(0, Math.floor(Math.min(...v)) - 1), y1 = Math.min(S - 1, Math.ceil(Math.max(...v)) + 1);
  const d = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0]);
  if (Math.abs(d) < 1e-12) continue;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((u[1] - px) * (v[2] - py) - (u[2] - px) * (v[1] - py)) / d;
    const w1 = ((u[2] - px) * (v[0] - py) - (u[0] - px) * (v[2] - py)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -0.03 || w1 < -0.03 || w2 < -0.03) continue;
    const o = (y * S + x) * 3;
    for (let c = 0; c < 3; c++)
      pos[o + c] = w0 * P[ia * 3 + c] + w1 * P[ib * 3 + c] + w2 * P[ic * 3 + c];
    cover[y * S + x] = 1;
  }
}

const lum = new Uint8Array(S * S);
for (let i = 0; i < S * S; i++)
  lum[i] = Math.round(alb[i * 3] * 0.299 + alb[i * 3 + 1] * 0.587 + alb[i * 3 + 2] * 0.114);
/* Local luminance range. A headlamp lens is full of reflector structure; the
   wing it sits in is flat. This is what separates them when brightness cannot. */
const con = new Uint8Array(S * S);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let mn = 255, mx = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
    const v = lum[yy * S + xx];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  con[y * S + x] = mx - mn;
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; bestT = t; }
  }
  return bestT;
}

const mask = Buffer.alloc(S * S * 3, 0);
for (const L of LENS) for (const side of [-1, 1]) {
  const cand = [];
  const hist = new Uint32Array(256);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < S * S; i++) {
    if (!cover[i]) continue;
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (Math.sign(x) !== side) continue;
    const ax = Math.abs(x);
    if (ax < L.ax[0] || ax > L.ax[1] || y < L.y[0] || y > L.y[1] || z < L.z[0] || z > L.z[1]) continue;
    cand.push(i);
    hist[L.mode === "struct" ? con[i] : lum[i]]++;
    const px = i % S, py = (i / S) | 0;
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  }
  if (!cand.length) { console.log(`${L.name} ${side > 0 ? "R" : "L"}: no candidates`); continue; }
  const T = otsu(hist, cand.length);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const sel = new Uint8Array(w * h);
  for (const i of cand) {
    if (L.mode === "struct" ? con[i] < T : lum[i] > T) continue;
    sel[(((i / S) | 0) - y0) * w + ((i % S) - x0)] = 1;
  }
  const morph = (src, r, dilate) => {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let hit = 0, all = 1;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) { all = 0; continue; }
        if (src[yy * w + xx]) hit = 1; else all = 0;
      }
      o[y * w + x] = dilate ? hit : all;
    }
    return o;
  };
  const closed = morph(morph(sel, 5, true), 5, false);
  // keep only the biggest blob — stray specks elsewhere in the box are not the lens
  const lab = new Int32Array(w * h).fill(-1);
  let best = -1, bestN = 0;
  for (let s = 0; s < w * h; s++) {
    if (!closed[s] || lab[s] >= 0) continue;
    const st = [s]; lab[s] = s; let n = 0;
    while (st.length) {
      const p = st.pop(); n++;
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (closed[q] && lab[q] < 0) { lab[q] = s; st.push(q); }
      }
    }
    if (n > bestN) { bestN = n; best = s; }
  }
  const keep = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) if (lab[s] === best) keep[s] = 1;
  // flood the outside, so enclosed holes (bright reflectors) become lens too
  const bg = new Uint8Array(w * h);
  const st = [];
  for (let x = 0; x < w; x++) st.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) st.push(y * w, y * w + w - 1);
  while (st.length) {
    const p = st.pop();
    if (bg[p] || keep[p]) continue;
    bg[p] = 1;
    const x = p % w, y = (p / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) st.push(yy * w + xx);
    }
  }
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (bg[y * w + x]) continue;
    const i = (y0 + y) * S + (x0 + x);
    if (!cover[i]) continue;
    mask[i * 3 + (L.kind === 2 ? 0 : 1)] = 255;
    n++;
  }
  console.log(`${L.name} ${side > 0 ? "R" : "L"}: island (${x0},${y0}) ${w}x${h}, otsu ${T}, ${n} texels`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await sharp(mask, { raw: { width: S, height: S, channels: 3 } }).png({ palette: true }).toFile(OUT);
console.log("wrote", OUT);

if (PREVIEW) {
  fs.mkdirSync(PREVIEW, { recursive: true });
  const ov = Buffer.alloc(S * S * 3);
  for (let i = 0; i < S * S; i++) {
    const g = alb[i * 3], r = mask[i * 3], gr = mask[i * 3 + 1];
    ov[i * 3] = r ? 255 : (gr ? g >> 2 : g);
    ov[i * 3 + 1] = gr ? 255 : (r ? g >> 2 : g);
    ov[i * 3 + 2] = (r || gr) ? g >> 2 : g;
  }
  const f = path.join(PREVIEW, "lamp-overlay.png");
  await sharp(ov, { raw: { width: S, height: S, channels: 3 } }).png().toFile(f);
  console.log("wrote", f);
}
