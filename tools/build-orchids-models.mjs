/* Bakes a small, mobile-safe subset of the CC-BY Orchids Simulator Traffic
   Car Pack into the NPC fleet's existing one-mesh/vertex-colour format.

     node tools/build-orchids-models.mjs <path-to-original-pack.glb>

   The downloaded pack is deliberately not shipped. It is one unnamed 26 MB
   scene with 323 meshes and 77 embedded images. Four ordinary passenger cars
   are selected by their stable glTF node indices, their UVs are preserved,
   their 1K colour textures are resized to 512px JPEGs (metallic/roughness to
   256px), wheel geometry is discarded, and the result is fitted to
   traffic.ts's dimensions. Tail-light anchors are detected from the actual
   red lens artwork instead of guessed from body dimensions. Each style remains
   one instanced draw call.

   Source: "Orchids Simulator Traffic Car Pack" by SphereBall20, CC-BY 4.0.
   See ATTRIBUTIONS.md for the canonical URL and required credit. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as THREE from "three";
import sharp from "sharp";

const SRC = process.argv[2];
const OUT = path.resolve(import.meta.dirname, "../public/models/cars");
if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: node tools/build-orchids-models.mjs <path-to-original-pack.glb>");
  process.exit(1);
}

/* Body node + front/rear wheel-group nodes in the original GLB. The source has
   no node names, so these indices are guarded by the expected triangle count. */
const CARS = {
  hybrid:  { body: 216, wheels: [225, 235], tris: 1194, L: 4.54, W: 1.76, H: 1.51 },
  suv:     { body: 331, wheels: [333, 337], tris: 1410, L: 4.72, W: 1.90, H: 1.79 },
  compact: { body: 348, wheels: [352, 356], tris: 1434, L: 3.94, W: 1.71, H: 1.55 },
  sedan:   { body: 355, wheels: [221, 359], tris: 1414, L: 4.44, W: 1.79, H: 1.45 },
};

function parseGlb(file) {
  const fileBuf = fs.readFileSync(file);
  if (fileBuf.readUInt32LE(0) !== 0x46546c67 || fileBuf.readUInt32LE(4) !== 2)
    throw new Error("source is not a glTF 2.0 GLB");
  const jsonLen = fileBuf.readUInt32LE(12);
  const json = JSON.parse(fileBuf.subarray(20, 20 + jsonLen).toString("utf8").replace(/\0+$/, ""));
  const binHead = 20 + jsonLen;
  if (fileBuf.readUInt32LE(binHead + 4) !== 0x004e4942)
    throw new Error("source GLB has no BIN chunk");
  const binLen = fileBuf.readUInt32LE(binHead);
  const bin = fileBuf.subarray(binHead + 8, binHead + 8 + binLen);
  return { json, bin };
}

const { json: doc, bin } = parseGlb(SRC);
if (doc.asset?.generator !== "3D Builder" || doc.nodes?.length !== 391 || doc.meshes?.length !== 323)
  throw new Error("source layout does not match the inspected Orchids pack");

const component = {
  5120: { bytes: 1, get: "getInt8" },
  5121: { bytes: 1, get: "getUint8" },
  5122: { bytes: 2, get: "getInt16" },
  5123: { bytes: 2, get: "getUint16" },
  5125: { bytes: 4, get: "getUint32" },
  5126: { bytes: 4, get: "getFloat32" },
};
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(index) {
  const a = doc.accessors[index];
  if (!a || a.sparse) throw new Error(`unsupported accessor ${index}`);
  const view = doc.bufferViews[a.bufferView];
  const kind = component[a.componentType];
  const width = components[a.type];
  if (!view || !kind || !width) throw new Error(`bad accessor ${index}`);
  const stride = view.byteStride || width * kind.bytes;
  const start = (view.byteOffset || 0) + (a.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Array(a.count * width);
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < width; k++) {
      const off = start + i * stride + k * kind.bytes;
      out[i * width + k] = dv[kind.get](off, true);
    }
  }
  return { array: out, count: a.count, width };
}

function localMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
  const p = new THREE.Vector3(...(node.translation || [0, 0, 0]));
  const q = new THREE.Quaternion(...(node.rotation || [0, 0, 0, 1]));
  const s = new THREE.Vector3(...(node.scale || [1, 1, 1]));
  return new THREE.Matrix4().compose(p, q, s);
}

const parents = new Array(doc.nodes.length).fill(-1);
doc.nodes.forEach((n, i) => n.children?.forEach((c) => { parents[c] = i; }));
const worldCache = new Map();
function worldMatrix(index) {
  if (worldCache.has(index)) return worldCache.get(index);
  const local = localMatrix(doc.nodes[index]);
  const p = parents[index];
  const world = p < 0 ? local : worldMatrix(p).clone().multiply(local);
  worldCache.set(index, world);
  return world;
}

function meshRecord(nodeIndex) {
  const node = doc.nodes[nodeIndex];
  const mesh = doc.meshes[node.mesh];
  if (!mesh || mesh.primitives.length !== 1)
    throw new Error(`node ${nodeIndex} is not a one-primitive mesh`);
  return mesh.primitives[0];
}

function descendants(index, out = []) {
  const node = doc.nodes[index];
  if (node.mesh !== undefined) out.push(index);
  node.children?.forEach((c) => descendants(c, out));
  return out;
}

function nodePoints(nodeIndex) {
  const primitive = meshRecord(nodeIndex);
  const src = readAccessor(primitive.attributes.POSITION);
  const matrix = worldMatrix(nodeIndex);
  const v = new THREE.Vector3();
  const points = [];
  for (let i = 0; i < src.count; i++) {
    v.set(src.array[i * 3], src.array[i * 3 + 1], src.array[i * 3 + 2]).applyMatrix4(matrix);
    points.push([v.x, v.y, v.z]);
  }
  return points;
}

function boundsOfNodes(nodes) {
  const box = new THREE.Box3();
  for (const node of nodes)
    for (const p of nodePoints(node)) box.expandByPoint(new THREE.Vector3(...p));
  return box;
}

const imageCache = new Map();
const sourcePixelCache = new Map();

function sourceImageBytes(textureIndex) {
  const imageIndex = doc.textures[textureIndex]?.source;
  if (imageIndex === undefined) return null;
  const image = doc.images[imageIndex];
  if (image.uri) throw new Error("external source images are not supported");
  const view = doc.bufferViews[image.bufferView];
  return {
    imageIndex,
    bytes: bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength),
  };
}

async function imageForTexture(textureIndex, size, quality) {
  const source = sourceImageBytes(textureIndex);
  if (!source) return null;
  const { imageIndex, bytes } = source;
  const cacheKey = `${imageIndex}:${size}:${quality}`;
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
  const value = await sharp(bytes)
    .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality, chromaSubsampling: "4:4:4" })
    .toBuffer();
  imageCache.set(cacheKey, value);
  return value;
}

async function sourcePixelsForTexture(textureIndex) {
  const source = sourceImageBytes(textureIndex);
  if (!source) return null;
  if (sourcePixelCache.has(source.imageIndex)) return sourcePixelCache.get(source.imageIndex);
  const decoded = await sharp(source.bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const value = {
    data: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
  };
  sourcePixelCache.set(source.imageIndex, value);
  return value;
}

async function imagesForMaterial(materialIndex) {
  const pbr = doc.materials[materialIndex]?.pbrMetallicRoughness;
  return {
    base: await imageForTexture(pbr?.baseColorTexture?.index, 512, 86),
    metallicRoughness: await imageForTexture(pbr?.metallicRoughnessTexture?.index, 256, 82),
    sourcePixels: await sourcePixelsForTexture(pbr?.baseColorTexture?.index),
  };
}

/** Every triangle of one selected body, transformed to pack world space and
 * carrying the source UV at each vertex. */
function bodyTriangles(nodeIndex) {
  const primitive = meshRecord(nodeIndex);
  const pos = readAccessor(primitive.attributes.POSITION);
  const uv = readAccessor(primitive.attributes.TEXCOORD_0);
  const idx = readAccessor(primitive.indices);
  const matrix = worldMatrix(nodeIndex);
  const v = new THREE.Vector3();
  const out = [];
  for (let i = 0; i < idx.count; i += 3) {
    const p = [], texcoord = [];
    for (let k = 0; k < 3; k++) {
      const ix = idx.array[i + k];
      v.set(pos.array[ix * 3], pos.array[ix * 3 + 1], pos.array[ix * 3 + 2]).applyMatrix4(matrix);
      p.push([v.x, v.y, v.z]);
      texcoord.push([uv.array[ix * 2], uv.array[ix * 2 + 1]]);
    }
    out.push({ p, uv: texcoord });
  }
  return out;
}

function texturePixel(image, u, v) {
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;
  const x = Math.min(image.width - 1, Math.floor(u * image.width));
  const y = Math.min(image.height - 1, Math.floor(v * image.height));
  const o = (y * image.width + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2]];
}

/** Locate the actual red lamp artwork on the fitted rear body. Sampling the
 * original 1K texture over rear-facing geometry is more reliable than a
 * dimension-based guess, and keeps each glow sprite centered on its lens. */
function tailLampPair(tris, image, cfg) {
  const sides = [
    { x: 0, y: 0, z: 0, w: 0, samples: 0 },
    { x: 0, y: 0, z: 0, w: 0, samples: 0 },
  ];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  const steps = 10;
  const samplesPerTri = ((steps + 1) * (steps + 2)) / 2;

  for (const tri of tris) {
    const z = (tri.p[0][2] + tri.p[1][2] + tri.p[2][2]) / 3;
    if (z > -cfg.L * 0.34) continue;
    a.set(...tri.p[0]); b.set(...tri.p[1]); c.set(...tri.p[2]);
    const area = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5;
    const weight = area / samplesPerTri;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const wa = i / steps, wb = j / steps, wc = 1 - wa - wb;
        const x = tri.p[0][0] * wa + tri.p[1][0] * wb + tri.p[2][0] * wc;
        const y = tri.p[0][1] * wa + tri.p[1][1] * wb + tri.p[2][1] * wc;
        const pz = tri.p[0][2] * wa + tri.p[1][2] * wb + tri.p[2][2] * wc;
        if (Math.abs(x) < cfg.W * 0.12 || y < cfg.H * 0.27) continue;
        const u = tri.uv[0][0] * wa + tri.uv[1][0] * wb + tri.uv[2][0] * wc;
        const v = tri.uv[0][1] * wa + tri.uv[1][1] * wb + tri.uv[2][1] * wc;
        const [r, g, blue] = texturePixel(image, u, v);
        if (r < 65 || r < g * 1.3 || r < blue * 1.18 || r - g < 22) continue;
        const side = sides[x < 0 ? 0 : 1];
        side.x += x * weight;
        side.y += y * weight;
        side.z += pz * weight;
        side.w += weight;
        side.samples++;
      }
    }
  }

  if (sides.some((side) => side.samples < 8 || side.w <= 0))
    throw new Error(`${cfg.body}: could not identify both textured tail-light clusters`);
  return sides.map((side) => [
    side.x / side.w,
    side.y / side.w,
    side.z / side.w - 0.055,
  ]);
}

/** Smooth panels without melting actual body creases. */
function creaseNormals(tris, cosLimit) {
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
  const at = new Map(), fn = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  tris.forEach((t, i) => {
    a.set(...t.p[0]); b.set(...t.p[1]); c.set(...t.p[2]);
    const n = new THREE.Vector3().crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
    fn.push(n.lengthSq() > 1e-16 ? n.normalize() : new THREE.Vector3(0, 1, 0));
    for (const p of t.p) {
      const k = key(p);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(i);
    }
  });
  const acc = new THREE.Vector3();
  return tris.map((t, i) => t.p.map((p) => {
    acc.set(0, 0, 0);
    for (const j of at.get(key(p))) if (fn[i].dot(fn[j]) >= cosLimit) acc.add(fn[j]);
    return acc.lengthSq() > 1e-12 ? acc.normalize().toArray() : fn[i].toArray();
  }));
}

async function build(style, cfg) {
  const wheelNodes = cfg.wheels.flatMap((n) => descendants(n));
  const allNodes = [cfg.body, ...wheelNodes];
  const box = boundsOfNodes(allNodes);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  const scale = [cfg.W / size.x, cfg.H / size.y, cfg.L / size.z];
  const fit = (p) => [
    (p[0] - ctr.x) * scale[0],
    (p[1] - box.min.y) * scale[1],
    (p[2] - ctr.z) * scale[2],
  ];

  const tris = bodyTriangles(cfg.body);
  if (tris.length !== cfg.tris)
    throw new Error(`${style}: expected ${cfg.tris} triangles, found ${tris.length}`);
  for (const tri of tris) tri.p = tri.p.map(fit);
  const normals = creaseNormals(tris, Math.cos(THREE.MathUtils.degToRad(42)));
  const images = await imagesForMaterial(meshRecord(cfg.body).material);
  if (!images.base) throw new Error(`${style}: source body has no base-colour texture`);
  if (!images.metallicRoughness)
    throw new Error(`${style}: source body has no metallic-roughness texture`);
  if (!images.sourcePixels)
    throw new Error(`${style}: source body texture could not be decoded`);

  const wheels = wheelNodes.map((node) => {
    const b = boundsOfNodes([node]);
    const c = fit(b.getCenter(new THREE.Vector3()).toArray());
    const s = b.getSize(new THREE.Vector3());
    return { x: c[0], y: c[1], z: c[2], r: (s.y / 2) * scale[1] };
  }).sort((a, b) => b.z - a.z || a.x - b.x);

  const nv = tris.length * 3;
  const position = new Float32Array(nv * 3);
  const normal = new Float32Array(nv * 3);
  const color = new Float32Array(nv * 3);
  const texcoord = new Float32Array(nv * 2);
  const paintable = new Float32Array(nv);
  const lampKind = new Float32Array(nv);
  color.fill(1);
  tris.forEach((tri, i) => {
    for (let k = 0; k < 3; k++) {
      const o = (i * 3 + k) * 3;
      position.set(tri.p[k], o);
      normal.set(normals[i][k], o);
      texcoord.set(tri.uv[k], (i * 3 + k) * 2);
    }
  });

  /* These four retain their authored paint and detail texture, so their paint
     mask remains zero. Other fleet styles still use random per-instance paint,
     keeping the overall stream varied. */
  const frontY = cfg.H * 0.46;
  const lamps = {
    head: [[-cfg.W * 0.32, frontY, cfg.L * 0.49], [cfg.W * 0.32, frontY, cfg.L * 0.49]],
    tail: tailLampPair(tris, images.sourcePixels, cfg),
    flashR: null,
    flashB: null,
  };
  const extras = {
    style,
    dims: { L: cfg.L, W: cfg.W, H: cfg.H },
    lamps,
    wheels,
    source: "Orchids Simulator Traffic Car Pack by SphereBall20 (CC-BY 4.0)",
  };
  return {
    position, normal, color, texcoord, paintable, lampKind,
    image: images.base,
    metallicRoughnessImage: images.metallicRoughness,
    extras,
  };
}

/* Minimal one-mesh GLB writer, matching tools/build-npc-models.mjs. */
const CT_FLOAT = 5126, CT_USHORT = 5123, TARGET_ARRAY = 34962, TARGET_ELEMENT = 34963;
function pad4(n) { return (4 - (n % 4)) % 4; }

function writeGlb(file, m) {
  const nv = m.position.length / 3;
  const map = new Map(), P = [], N = [], CO = [], UV = [], PA = [], LK = [], IDX = [];
  for (let i = 0; i < nv; i++) {
    const key =
      `${m.position[i * 3].toFixed(4)},${m.position[i * 3 + 1].toFixed(4)},${m.position[i * 3 + 2].toFixed(4)}|` +
      `${m.normal[i * 3].toFixed(3)},${m.normal[i * 3 + 1].toFixed(3)},${m.normal[i * 3 + 2].toFixed(3)}|` +
      `${m.texcoord[i * 2].toFixed(5)},${m.texcoord[i * 2 + 1].toFixed(5)}|0|0`;
    let ix = map.get(key);
    if (ix === undefined) {
      ix = P.length / 3;
      map.set(key, ix);
      P.push(m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2]);
      N.push(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]);
      CO.push(m.color[i * 3], m.color[i * 3 + 1], m.color[i * 3 + 2]);
      UV.push(m.texcoord[i * 2], m.texcoord[i * 2 + 1]);
      PA.push(0); LK.push(0);
    }
    IDX.push(ix);
  }
  if (P.length / 3 > 65535) throw new Error("index overflow");

  const chunks = [], views = [], accessors = [];
  let off = 0;
  const addView = (buf, target) => {
    const padding = pad4(buf.length);
    chunks.push(buf, Buffer.alloc(padding));
    views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target });
    off += buf.length + padding;
    return views.length - 1;
  };
  const addF32 = (arr, width) => {
    const typed = Float32Array.from(arr);
    const view = addView(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength), TARGET_ARRAY);
    const min = new Array(width).fill(Infinity), max = new Array(width).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) {
      const k = i % width;
      min[k] = Math.min(min[k], arr[i]); max[k] = Math.max(max[k], arr[i]);
    }
    accessors.push({
      bufferView: view, componentType: CT_FLOAT, count: arr.length / width,
      type: ["SCALAR", "VEC2", "VEC3"][width - 1], min, max,
    });
    return accessors.length - 1;
  };

  const aPos = addF32(P, 3), aNor = addF32(N, 3), aCol = addF32(CO, 3);
  const aUv = addF32(UV, 2);
  const aPaint = addF32(PA, 1), aLamp = addF32(LK, 1);
  const indices = Uint16Array.from(IDX);
  const indexView = addView(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength), TARGET_ELEMENT);
  accessors.push({
    bufferView: indexView, componentType: CT_USHORT, count: IDX.length,
    type: "SCALAR", min: [0], max: [P.length / 3 - 1],
  });
  const aIdx = accessors.length - 1;
  const imageView = addView(m.image);
  const metallicRoughnessImageView = addView(m.metallicRoughnessImage);
  const binary = Buffer.concat(chunks);
  const gltf = {
    asset: { version: "2.0", generator: "racing-game tools/build-orchids-models.mjs" },
    scene: 0,
    scenes: [{ nodes: [0], extras: m.extras }],
    nodes: [{ mesh: 0, name: m.extras.style, extras: m.extras }],
    meshes: [{
      name: m.extras.style,
      extras: m.extras,
      primitives: [{
        attributes: {
          POSITION: aPos, NORMAL: aNor, COLOR_0: aCol, TEXCOORD_0: aUv,
          _PAINTABLE: aPaint, _LAMP: aLamp,
        },
        indices: aIdx,
        material: 0,
      }],
    }],
    materials: [{
      name: "npcBody",
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: { index: 0, texCoord: 0 },
        metallicRoughnessTexture: { index: 1, texCoord: 0 },
        metallicFactor: 1,
        roughnessFactor: 1,
      },
    }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    textures: [{ sampler: 0, source: 0 }, { sampler: 0, source: 1 }],
    images: [
      { mimeType: "image/jpeg", bufferView: imageView },
      { mimeType: "image/jpeg", bufferView: metallicRoughnessImageView },
    ],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: binary.length }],
  };

  const json = Buffer.from(JSON.stringify(gltf));
  const jsonPad = Buffer.alloc(pad4(json.length), 0x20);
  const binPad = Buffer.alloc(pad4(binary.length), 0);
  const total = 12 + 8 + json.length + jsonPad.length + 8 + binary.length + binPad.length;
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  jsonHeader.writeUInt32LE(json.length + jsonPad.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(binary.length + binPad.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([
    header, jsonHeader, json, jsonPad, binHeader, binary, binPad,
  ]));
  return { bytes: total, tris: IDX.length / 3, verts: P.length / 3 };
}

fs.mkdirSync(OUT, { recursive: true });
let bytes = 0;
for (const [style, cfg] of Object.entries(CARS)) {
  const model = await build(style, cfg);
  const result = writeGlb(path.join(OUT, `${style}.glb`), model);
  bytes += result.bytes;
  console.log(
    `${style.padEnd(8)} ${String(result.tris).padStart(4)} tris  ` +
    `${String(result.verts).padStart(4)} verts  ${(result.bytes / 1024).toFixed(1)} KB`
  );
}
console.log(`4 models, ${(bytes / 1024).toFixed(1)} KB total`);
