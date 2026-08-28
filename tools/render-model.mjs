/* Offline software renderer for glTF/GLB car models — no GPU, no browser.
   Renders orthographic side/front/rear/top or a simple 3/4 perspective view
   to a PNG so model quality can be judged from images alone.

     node render-model.mjs <model.gltf|.glb> <out.png> [view] [w] [clipX]

   view: side | front | rear | top | rear34 | front34  (default side)
   clipX: if set (e.g. 0), only triangles whose centroid x >= clipX render —
          a cutaway that exposes the interior. */
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";

const [SRC, OUT, VIEW = "side", WPX = "900", CLIPX = ""] = process.argv.slice(2);
if (!SRC || !OUT) { console.error("usage: node render-model.mjs <src> <out.png> [view] [w] [clipX]"); process.exit(1); }

/* ---------- glTF parsing (gltf+bin or glb) ---------- */
function loadDoc(file) {
  if (file.endsWith(".glb")) {
    const b = fs.readFileSync(file);
    const jsonLen = b.readUInt32LE(12);
    const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8").replace(/\0+$/, ""));
    const binHead = 20 + jsonLen;
    const binLen = b.readUInt32LE(binHead);
    const bin = b.subarray(binHead + 8, binHead + 8 + binLen);
    return { json, buffers: [bin], dir: path.dirname(file) };
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const dir = path.dirname(file);
  const buffers = (json.buffers || []).map((bf) => {
    if (bf.uri?.startsWith("data:")) return Buffer.from(bf.uri.split(",")[1], "base64");
    return fs.readFileSync(path.join(dir, decodeURIComponent(bf.uri)));
  });
  return { json, buffers, dir };
}

const { json: doc, buffers, dir } = loadDoc(SRC);

const CT = { 5120: [1, "readInt8"], 5121: [1, "readUInt8"], 5122: [2, "readInt16LE"], 5123: [2, "readUInt16LE"], 5125: [4, "readUInt32LE"], 5126: [4, "readFloatLE"] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function acc(i) {
  const a = doc.accessors[i];
  const v = doc.bufferViews[a.bufferView];
  const buf = buffers[v.buffer];
  const [bytes, get] = CT[a.componentType];
  const width = NC[a.type];
  const stride = v.byteStride || bytes * width;
  const start = (v.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * width);
  for (let k = 0; k < a.count; k++)
    for (let c = 0; c < width; c++)
      out[k * width + c] = buf[get](start + k * stride + c * bytes);
  if (a.normalized)
    for (let k = 0; k < out.length; k++)
      out[k] /= { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType] ?? 1;
  return { arr: out, n: a.count, w: width };
}

/* node world matrices (column-major 4x4, minimal math) */
function matMul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function nodeLocal(n) {
  if (n.matrix) return Float64Array.from(n.matrix);
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return Float64Array.from([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}
const parents = new Array(doc.nodes.length).fill(-1);
doc.nodes.forEach((n, i) => n.children?.forEach((c) => { parents[c] = i; }));
const wcache = new Map();
function world(i) {
  if (wcache.has(i)) return wcache.get(i);
  const l = nodeLocal(doc.nodes[i]);
  const p = parents[i];
  const m = p < 0 ? l : matMul(world(p), l);
  wcache.set(i, m);
  return m;
}
const xf = (m, p, o) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/* ---------- decode textures ---------- */
const texCache = new Map();
async function texPixels(ti) {
  if (ti === undefined) return null;
  if (texCache.has(ti)) return texCache.get(ti);
  const img = doc.images[doc.textures[ti].source];
  let bytes;
  if (img.uri) bytes = fs.readFileSync(path.join(dir, decodeURIComponent(img.uri)));
  else {
    const v = doc.bufferViews[img.bufferView];
    bytes = buffers[v.buffer].subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
  }
  const d = await sharp(bytes).ensureAlpha().resize(512, 512, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const t = { data: d.data, w: d.info.width, h: d.info.height };
  texCache.set(ti, t);
  return t;
}

/* ---------- collect world-space triangles ---------- */
const tris = []; // {p:[[x,y,z]x3], uv, col, tex, alpha}
for (let ni = 0; ni < doc.nodes.length; ni++) {
  const n = doc.nodes[ni];
  if (n.mesh === undefined) continue;
  const m = world(ni);
  for (const prim of doc.meshes[n.mesh].primitives) {
    const pos = acc(prim.attributes.POSITION);
    const uv = prim.attributes.TEXCOORD_0 !== undefined ? acc(prim.attributes.TEXCOORD_0) : null;
    const col = prim.attributes.COLOR_0 !== undefined ? acc(prim.attributes.COLOR_0) : null;
    const idx = prim.indices !== undefined ? acc(prim.indices).arr : Float64Array.from({ length: pos.n }, (_, k) => k);
    const mat = doc.materials?.[prim.material];
    const pbr = mat?.pbrMetallicRoughness || {};
    const base = pbr.baseColorFactor || [1, 1, 1, 1];
    const ti = pbr.baseColorTexture?.index;
    const alpha = mat?.alphaMode === "BLEND" ? 0.45 : 1;
    for (let k = 0; k < idx.length; k += 3) {
      const t = { p: [], uv: [], c: [], tex: ti, alpha, base };
      for (let e = 0; e < 3; e++) {
        const ix = idx[k + e];
        t.p.push(xf(m, [pos.arr[ix * 3], pos.arr[ix * 3 + 1], pos.arr[ix * 3 + 2]]));
        t.uv.push(uv ? [uv.arr[ix * 2], uv.arr[ix * 2 + 1]] : [0, 0]);
        t.c.push(col ? [col.arr[ix * col.w], col.arr[ix * col.w + 1], col.arr[ix * col.w + 2]] : [1, 1, 1]);
      }
      tris.push(t);
    }
  }
}

/* cutaway */
let use = tris;
if (CLIPX !== "") {
  const cx = parseFloat(CLIPX);
  use = tris.filter((t) => (t.p[0][0] + t.p[1][0] + t.p[2][0]) / 3 >= cx);
}

/* ---------- camera ---------- */
// bounds
let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
for (const t of use) for (const p of t.p) for (let a = 0; a < 3; a++) {
  mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]);
}
const ctr = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
const R = (v) => { const s = Math.sin(v), c = Math.cos(v); return { s, c }; };
// view basis: right, up, fwd (camera looks along -fwd)
let basis;
switch (VIEW) {
  case "front": basis = [[-1, 0, 0], [0, 1, 0], [0, 0, 1]]; break;   // looking at nose (+z toward cam)
  case "rear": basis = [[1, 0, 0], [0, 1, 0], [0, 0, -1]]; break;
  case "top": basis = [[1, 0, 0], [0, 0, 1], [0, 1, 0]]; break;
  case "rear34": { const a = Math.PI * 0.82, e = 0.26; const { s, c } = R(a);
    const f = [s * Math.cos(e), Math.sin(e), c * Math.cos(e)];
    const r = [Math.cos(a + Math.PI / 2) ? -c : -c, 0, s]; // right = cross(up-ish)
    basis = null; makeBasis(f); break; }
  case "front34": { const e = 0.26; const a = Math.PI * 0.18; makeBasis([Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)]); break; }
  default: basis = [[0, 0, 1], [0, 1, 0], [1, 0, 0]]; // side: +x toward cam
}
function makeBasis(f) {
  const len = Math.hypot(...f); f = f.map((v) => v / len);
  const up0 = [0, 1, 0];
  const r = [up0[1] * f[2] - up0[2] * f[1], up0[2] * f[0] - up0[0] * f[2], up0[0] * f[1] - up0[1] * f[0]];
  const rl = Math.hypot(...r); const rn = r.map((v) => v / rl);
  const u = [f[1] * rn[2] - f[2] * rn[1], f[2] * rn[0] - f[0] * rn[2], f[0] * rn[1] - f[1] * rn[0]];
  basis = [rn, u, f];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const view = (p) => {
  const q = [p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]];
  return [dot(q, basis[0]), dot(q, basis[1]), dot(q, basis[2])];
};

// projected extent
let pmn = [1e9, 1e9], pmx = [-1e9, -1e9];
for (const t of use) for (const p of t.p) {
  const v = view(p);
  pmn[0] = Math.min(pmn[0], v[0]); pmx[0] = Math.max(pmx[0], v[0]);
  pmn[1] = Math.min(pmn[1], v[1]); pmx[1] = Math.max(pmx[1], v[1]);
}
const W = parseInt(WPX, 10);
const pad = 0.05 * Math.max(pmx[0] - pmn[0], pmx[1] - pmn[1]);
const sx = (W - 2) / (pmx[0] - pmn[0] + 2 * pad);
const H = Math.max(64, Math.round((pmx[1] - pmn[1] + 2 * pad) * sx) + 2);
const scale = sx;

const rgb = new Float64Array(W * H * 3).fill(0.13);
const zb = new Float64Array(W * H).fill(-1e9);

const light = (() => { const l = [0.5, 0.8, 0.6]; const n = Math.hypot(...l); return l.map((v) => v / n); })();

const texs = new Map();
for (const t of use) if (t.tex !== undefined && !texs.has(t.tex)) texs.set(t.tex, await texPixels(t.tex));

function sample(tex, u, v) {
  u = ((u % 1) + 1) % 1; v = ((v % 1) + 1) % 1;
  const x = Math.min(tex.w - 1, (u * tex.w) | 0), y = Math.min(tex.h - 1, (v * tex.h) | 0);
  const o = (y * tex.w + x) * 4;
  return [tex.data[o] / 255, tex.data[o + 1] / 255, tex.data[o + 2] / 255];
}

for (const t of use) {
  const v = t.p.map(view);
  // face normal in world for lambert
  const e1 = [t.p[1][0] - t.p[0][0], t.p[1][1] - t.p[0][1], t.p[1][2] - t.p[0][2]];
  const e2 = [t.p[2][0] - t.p[0][0], t.p[2][1] - t.p[0][1], t.p[2][2] - t.p[0][2]];
  let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const nl = Math.hypot(...n) || 1; n = n.map((q) => q / nl);
  const lam = 0.35 + 0.65 * Math.abs(dot(n, light));
  const px = v.map((q) => [(q[0] - pmn[0] + pad) * scale, H - 1 - (q[1] - pmn[1] + pad) * scale, q[2]]);
  // raster bbox
  const minx = Math.max(0, Math.floor(Math.min(px[0][0], px[1][0], px[2][0])));
  const maxx = Math.min(W - 1, Math.ceil(Math.max(px[0][0], px[1][0], px[2][0])));
  const miny = Math.max(0, Math.floor(Math.min(px[0][1], px[1][1], px[2][1])));
  const maxy = Math.min(H - 1, Math.ceil(Math.max(px[0][1], px[1][1], px[2][1])));
  const [A, B, C] = px;
  const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
  if (Math.abs(den) < 1e-12) continue;
  const tex = t.tex !== undefined ? texs.get(t.tex) : null;
  for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    const w0 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den;
    const w1 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
    const o = y * W + x;
    if (z <= zb[o]) continue;
    let c;
    if (tex) {
      const u = w0 * t.uv[0][0] + w1 * t.uv[1][0] + w2 * t.uv[2][0];
      const vv = w0 * t.uv[0][1] + w1 * t.uv[1][1] + w2 * t.uv[2][1];
      c = sample(tex, u, vv);
    } else c = [t.base[0], t.base[1], t.base[2]];
    const vc = [
      w0 * t.c[0][0] + w1 * t.c[1][0] + w2 * t.c[2][0],
      w0 * t.c[0][1] + w1 * t.c[1][1] + w2 * t.c[2][1],
      w0 * t.c[0][2] + w1 * t.c[1][2] + w2 * t.c[2][2],
    ];
    if (t.alpha < 1) {
      // cheap blend against what's there; do not write z
      for (let k = 0; k < 3; k++) rgb[o * 3 + k] = rgb[o * 3 + k] * (1 - t.alpha) + c[k] * vc[k] * lam * t.alpha;
      continue;
    }
    zb[o] = z;
    for (let k = 0; k < 3; k++) rgb[o * 3 + k] = c[k] * vc[k] * lam;
  }
}

const out = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H * 3; i++) out[i] = Math.max(0, Math.min(255, Math.round(Math.pow(rgb[i], 1 / 2.2) * 255)));
await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(OUT);
console.log(`${OUT} ${W}x${H} tris=${use.length}`);
