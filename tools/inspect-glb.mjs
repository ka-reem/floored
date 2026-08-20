/* Reports what is actually inside a GLB, without loading it into a renderer.

     node tools/inspect-glb.mjs <file.glb> [--tree] [--top N] [--grep RE]

   Written for the imported-cockpit work: before any of a donor car model can
   be cut down to the dash the dashcam actually frames, we need to know what
   the nodes are called, where each one physically sits, and which materials
   and textures it drags along with it.

   It parses the GLB container directly rather than going through GLTFLoader
   because these files run to hundreds of megabytes and almost all of that is
   texture payload we do not need to touch. Everything reported here comes out
   of the JSON chunk plus a few dozen bytes per image:

   - Triangle counts come from the index accessor's `count` (or POSITION's,
     for non-indexed primitives) — no buffer reads.
   - Bounding boxes come from the POSITION accessor's mandatory `min`/`max`,
     pushed through the node's world matrix. glTF requires those bounds on
     POSITION specifically, which is what makes a spatial cut plannable
     without ever decoding vertex data.
   - Image resolutions are sniffed from the first bytes of each PNG/JPEG/WebP
     bufferView, so a 4K texture costs ~32 bytes to measure.

   Axis convention: glTF is +Y up, +Z forward, metres — same as the game's
   cockpit space, so the numbers printed here can be compared straight against
   EYE and POV_MOUNT in cockpit.ts / engine.ts. */

import * as fs from "node:fs";

const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith("--"));
const TREE = args.includes("--tree");
const TOP = Number(args[args.indexOf("--top") + 1]) || 25;
const GREP = args.includes("--grep") ? new RegExp(args[args.indexOf("--grep") + 1], "i") : null;

if (!FILE || !fs.existsSync(FILE)) {
  console.error("usage: node tools/inspect-glb.mjs <file.glb> [--tree] [--top N] [--grep RE]");
  process.exit(1);
}

/* ------------------------------------------------------------- container -- */

const buf = fs.readFileSync(FILE);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.error("not a GLB (bad magic)"); process.exit(1); }

/* GLB is a header then a run of length-prefixed chunks; we want the JSON one
   and the offset of the BIN one (image sniffing indexes into it). */
let off = 12, json = null, binOff = 0;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString("utf8"));
  else if (type === 0x004e4942) binOff = off + 8;
  off += 8 + len + ((4 - (len % 4)) % 4);
}
const g = json;
const N = (a) => a || [];

/* ------------------------------------------------------------------ math -- */

const mul = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
const trs = (t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) => {
  const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
};
const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const local = (n) => (n.matrix ? n.matrix : trs(n.translation, n.rotation, n.scale));

/* --------------------------------------------------------- image sniffing -- */

/** Decode WxH from the first bytes of an encoded image, without decoding it. */
function imageSize(view) {
  if (!view) return null;
  const s = binOff + (view.byteOffset || 0), b = buf;
  if (b[s] === 0x89 && b[s + 1] === 0x50) return [b.readUInt32BE(s + 16), b.readUInt32BE(s + 20)]; // PNG
  if (b[s] === 0x52 && b.toString("ascii", s + 8, s + 12) === "WEBP") {                            // WebP (VP8L/VP8X)
    if (b.toString("ascii", s + 12, s + 16) === "VP8X") return [1 + b.readUIntLE(s + 24, 3), 1 + b.readUIntLE(s + 27, 3)];
    return null;
  }
  if (b[s] === 0xff && b[s + 1] === 0xd8) {                                                        // JPEG: walk markers
    let p = s + 2, end = s + (view.byteLength || 0);
    while (p < end - 9) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return [b.readUInt16BE(p + 7), b.readUInt16BE(p + 5)];
      p += 2 + b.readUInt16BE(p + 2);
    }
  }
  return null;
}

/* ------------------------------------------------------------ traversal -- */

const prims = new Map();          // mesh index -> { tris, verts, mats:Set }
N(g.meshes).forEach((m, i) => {
  let tris = 0, verts = 0; const mats = new Set();
  for (const p of N(m.primitives)) {
    const mode = p.mode ?? 4;
    const n = p.indices != null ? g.accessors[p.indices].count : g.accessors[p.attributes.POSITION].count;
    if (mode === 4) tris += n / 3;
    verts += g.accessors[p.attributes.POSITION].count;
    if (p.material != null) mats.add(p.material);
  }
  prims.set(i, { tris, verts, mats });
});

const rows = [];                  // one per mesh-bearing node
const matUse = new Map();         // material index -> tris
const lines = [];

(function walk(idx, parent, depth) {
  const n = g.nodes[idx];
  const world = mul(parent, local(n));
  const name = n.name || `node${idx}`;
  let selfTris = 0, bbox = null;

  if (n.mesh != null) {
    const info = prims.get(n.mesh);
    selfTris = info.tris;
    for (const p of N(g.meshes[n.mesh].primitives)) {
      const acc = g.accessors[p.attributes.POSITION];
      if (!acc.min || !acc.max) continue;
      for (let c = 0; c < 8; c++) {
        const w = xform(world, [c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]]);
        if (!bbox) bbox = [w.slice(), w.slice()];
        for (let k = 0; k < 3; k++) { bbox[0][k] = Math.min(bbox[0][k], w[k]); bbox[1][k] = Math.max(bbox[1][k], w[k]); }
      }
      if (p.material != null) matUse.set(p.material, (matUse.get(p.material) || 0) + (p.indices != null ? g.accessors[p.indices].count : acc.count) / 3);
    }
    rows.push({ name, idx, tris: selfTris, verts: info.verts, bbox, mats: [...info.mats] });
  }
  if (TREE && (!GREP || GREP.test(name)))
    lines.push(`${"  ".repeat(depth)}${name}${n.mesh != null ? `  [${Math.round(selfTris)} tris]` : ""}`);
  for (const c of N(n.children)) walk(c, world, depth + 1);
})(N(g.scenes)[g.scene || 0]?.nodes?.[0] ?? 0, trs(), 0);

// scenes can have several roots; the walk above only entered the first
for (const r of N(N(g.scenes)[g.scene || 0]?.nodes).slice(1)) (function again(i) {
  const n = g.nodes[i]; if (!n) return;
  (function walk2(idx, parent, depth) {
    const nn = g.nodes[idx], world = mul(parent, local(nn)), name = nn.name || `node${idx}`;
    if (nn.mesh != null && !rows.some((r2) => r2.idx === idx)) {
      const info = prims.get(nn.mesh); let bbox = null;
      for (const p of N(g.meshes[nn.mesh].primitives)) {
        const acc = g.accessors[p.attributes.POSITION];
        if (!acc.min || !acc.max) continue;
        for (let c = 0; c < 8; c++) {
          const w = xform(world, [c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]]);
          if (!bbox) bbox = [w.slice(), w.slice()];
          for (let k = 0; k < 3; k++) { bbox[0][k] = Math.min(bbox[0][k], w[k]); bbox[1][k] = Math.max(bbox[1][k], w[k]); }
        }
        if (p.material != null) matUse.set(p.material, (matUse.get(p.material) || 0) + (p.indices != null ? g.accessors[p.indices].count : acc.count) / 3);
      }
      rows.push({ name, idx, tris: info.tris, verts: info.verts, bbox, mats: [...info.mats] });
      if (TREE && (!GREP || GREP.test(name))) lines.push(`${"  ".repeat(depth)}${name}  [${Math.round(info.tris)} tris]`);
    } else if (TREE && (!GREP || GREP.test(name))) lines.push(`${"  ".repeat(depth)}${name}`);
    for (const c of N(nn.children)) walk2(c, world, depth + 1);
  })(i, trs(), 0);
})(r);

/* -------------------------------------------------------------- reporting -- */

const fmt = (n) => (n == null ? "?" : n.toLocaleString("en-US"));
const b3 = (b) => (b ? `[${b[0].map((v) => v.toFixed(2)).join(" ")}] .. [${b[1].map((v) => v.toFixed(2)).join(" ")}]` : "-");
const totalTris = [...prims.values()].reduce((a, v) => a + v.tris, 0);

console.log(`\n${FILE}  —  ${(buf.length / 1e6).toFixed(1)} MB`);
console.log(`generator : ${g.asset?.generator || "?"}   glTF ${g.asset?.version}`);
console.log(`scene     : ${fmt(N(g.nodes).length)} nodes, ${fmt(N(g.meshes).length)} meshes, ` +
            `${fmt(N(g.materials).length)} materials, ${fmt(N(g.images).length)} images`);
console.log(`geometry  : ${fmt(Math.round(totalTris))} triangles, ${fmt([...prims.values()].reduce((a, v) => a + v.verts, 0))} vertices`);

// whole-model extent, so the model's scale/units are obvious at a glance
const all = rows.filter((r) => r.bbox);
if (all.length) {
  const lo = [0, 1, 2].map((k) => Math.min(...all.map((r) => r.bbox[0][k])));
  const hi = [0, 1, 2].map((k) => Math.max(...all.map((r) => r.bbox[1][k])));
  console.log(`extent    : ${b3([lo, hi])}   (size ${hi.map((v, k) => (v - lo[k]).toFixed(2)).join(" x ")})`);
}

console.log(`\n── heaviest ${TOP} mesh nodes ──  (world-space bbox, +Y up / +Z fwd, metres)`);
for (const r of rows.filter((r) => !GREP || GREP.test(r.name)).sort((a, b) => b.tris - a.tris).slice(0, TOP))
  console.log(`  ${fmt(Math.round(r.tris)).padStart(9)}t  ${(r.name || "").slice(0, 38).padEnd(38)} ${b3(r.bbox)}`);

console.log(`\n── materials by triangle share ──`);
for (const [mi, t] of [...matUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
  const m = g.materials[mi] || {};
  const tex = new Set();
  for (const k of ["baseColorTexture", "metallicRoughnessTexture"]) if (m.pbrMetallicRoughness?.[k]) tex.add(m.pbrMetallicRoughness[k].index);
  for (const k of ["normalTexture", "occlusionTexture", "emissiveTexture"]) if (m[k]) tex.add(m[k].index);
  console.log(`  ${fmt(Math.round(t)).padStart(9)}t  ${(m.name || `material${mi}`).slice(0, 38).padEnd(38)} ${tex.size} tex`);
}

console.log(`\n── images ──`);
let px = 0;
const sizes = N(g.images).map((im, i) => {
  const v = im.bufferView != null ? g.bufferViews[im.bufferView] : null;
  const wh = imageSize(v);
  if (wh) px += wh[0] * wh[1];
  return { i, name: im.name || im.uri || `image${i}`, mime: im.mimeType || "?", bytes: v?.byteLength || 0, wh };
});
for (const s of sizes.sort((a, b) => b.bytes - a.bytes).slice(0, TOP))
  console.log(`  ${(s.bytes / 1e6).toFixed(1).padStart(7)} MB  ${s.wh ? `${s.wh[0]}x${s.wh[1]}`.padStart(10) : "         ?"}  ${s.name.slice(0, 44)}`);
/* Decoded VRAM is the number that actually decides what runs: encoded size is
   irrelevant once the GPU has it. RGBA8 + a full mip chain is 4 bytes/texel
   times 4/3, and it is routinely an order of magnitude over the file size. */
console.log(`\n  decoded RGBA8 + mips ≈ ${(px * 4 * 1.333 / 1e9).toFixed(2)} GB VRAM across ${sizes.length} images`);

if (TREE) { console.log(`\n── hierarchy ──`); console.log(lines.join("\n")); }
console.log();
