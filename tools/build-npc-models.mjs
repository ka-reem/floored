/* Bakes the NPC traffic fleet's GLBs from the source FBX pack.
   Run offline, not at build time — the GLBs it writes are committed.

     node tools/build-npc-models.mjs <path-to-unzipped-pack>

   Source: "Free Low Poly Vehicles Pack" by Raphael Gonçalves (rgsdev), CC0.
   See ATTRIBUTIONS.md for the download URL and licence text.

   Per style it emits one GLB holding a single merged body mesh in the game's
   own conventions, so game/npcmodels.ts can hand the geometry straight to an
   InstancedMesh with no runtime rework:

   - +Z forward, origin at the ground plane between the wheels, and the whole
     vehicle scaled *non-uniformly* into the L/W/H that traffic.ts already
     uses. The source proportions are cartoonish (a 2.8 m wide sedan); fitting
     them to real dimensions is what makes them read as traffic.
   - The wheel meshes are dropped — traffic.ts already instances one spinning
     wheel across the whole fleet — but their fitted centres and radii are
     recorded so the shared wheels land in these bodies' arches.
   - Material slots collapse into a baked vertex colour plus the `paintable`
     mask the NPC shader reads, so the dominant body panel takes the
     per-instance paint colour while glass, lamps and trim stay fixed.
   - Lamp/flasher slot centroids are recorded so the light sprites sit on the
     actual lamps rather than at a guessed offset from the bumper. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

const SRC = process.argv[2];
const OUT = path.resolve(import.meta.dirname, "../public/models/cars");
if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: node tools/build-npc-models.mjs <path-to-unzipped-pack>");
  process.exit(1);
}

/* Game palette. Kept in step with the constants at the top of traffic.ts so a
   model body and a procedural one light the same way. */
const GLASS_C = 0x0a0e18, TRIM_C = 0x101218, BUMP_C = 0x2b2f38;
const LAMP_C = 0xdfe6f2, TAIL_C = 0x8e1620, PLATE_C = 0xd4d8e0;
const FLASH_R = 0x8e1620, FLASH_B = 0x1b2f6b;

/* style -> source model, target size, and which material slot takes the paint.
   L/W come from TYPE_DIM/BODY in traffic.ts; H is the roof line plus the few
   centimetres of roof skin the procedural shell caps it with. Everything not
   named `paint` gets a fixed colour from MAT_C below. */
const STYLES = {
  hybrid:  { src: "Hatchback",    L: 4.54, W: 1.76, H: 1.51, paint: "body dark yellow" },
  sedan:   { src: "Sedan",        L: 4.44, W: 1.79, H: 1.45, paint: "body grey" },
  compact: { src: "Pickup",       L: 3.94, W: 1.71, H: 1.55, paint: "body dark green" },
  kei:     { src: "Van",          L: 3.42, W: 1.49, H: 1.79, paint: "body dark blue" },
  suv:     { src: "SUV",          L: 4.72, W: 1.90, H: 1.79, paint: "body dark purple" },
  van:     { src: "Van",          L: 4.64, W: 1.78, H: 1.91, paint: "body dark blue" },
  taxi:    { src: "Taxi",         L: 4.44, W: 1.79, H: 1.45, paint: "body yellow" },
  // the livery is the point: white takes the paint (police paint is off-white)
  // and the black stays black, so it reads as a marked car from any angle
  police:  { src: "Police Sedan", L: 4.44, W: 1.79, H: 1.52, paint: "body white" },
  /* The source truck is a bobtail tractor unit: a cab-over cab and then bare
     chassis. traffic.ts wants a box truck, so a cargo body is grafted on
     behind the cab (measured off the fitted cab: its rear face sits at
     z = +0.67, the chassis rails at y = 1.06). Left unpainted, like a real
     delivery box — the cab is what carries the per-instance colour. */
  truck:   { src: "Truck",        L: 6.30, W: 2.10, H: 3.10, paint: "body dark green",
             /* Off-white rather than the near-white the procedural box used:
                it is the largest flat panel in the fleet and it faces the
                player's headlights square-on, so its albedo is the one that
                decides how hard the knee in traffic.ts has to work. */
             cargo: { z0: -3.14, z1: 0.62, y0: 1.02, y1: 3.06, w: 2.06, c: 0xb4bac6 } },
  bus:     { src: "Bus",          L: 9.40, W: 2.26, H: 3.00, paint: "body light blue" },
};

/** Fixed colour for every non-paint slot, by source material name. */
function matColor(name) {
  if (name === "windows") return GLASS_C;
  if (name === "headlights") return LAMP_C;
  if (name === "rear lights") return TAIL_C;
  if (name === "flashers siren red") return FLASH_R;
  if (name === "flashers siren blue") return FLASH_B;
  if (name === "body black") return TRIM_C;
  if (name === "body white") return PLATE_C;
  if (name === "body grey") return BUMP_C;
  return BUMP_C; // any remaining accent panel reads as trim
}

/* ------------------------------------------------------------------ */

function loadFbx(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const root = new FBXLoader().parse(ab, "");
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  return meshes;
}

/** Every triangle of a mesh, in world space, tagged with its material name. */
function meshTris(m) {
  const g = m.geometry, pos = g.attributes.position, idx = g.index;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  const groups = g.groups.length
    ? g.groups
    : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }];
  const out = [];
  const v = new THREE.Vector3();
  for (const gr of groups) {
    const name = (mats[gr.materialIndex] || mats[0]).name;
    for (let i = gr.start; i < gr.start + gr.count; i += 3) {
      const p = [];
      for (let k = 0; k < 3; k++) {
        const ix = idx ? idx.getX(i + k) : i + k;
        v.fromBufferAttribute(pos, ix).applyMatrix4(m.matrixWorld);
        p.push([v.x, v.y, v.z]);
      }
      out.push({ p, name });
    }
  }
  return out;
}

/** Smooth normals with a crease threshold: panels that meet at a shallow angle
    share a normal (so a roof or a bonnet curves), while real body creases and
    shutlines stay hard. Flat-shading the whole thing is what makes low-poly
    look faceted, and smoothing all of it melts the car into a blob. */
function creaseNormals(tris, cosLimit) {
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
  const at = new Map(); // position -> face indices meeting there
  const fn = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  tris.forEach((t, i) => {
    a.set(...t.p[0]); b.set(...t.p[1]); c.set(...t.p[2]);
    e1.subVectors(b, a); e2.subVectors(c, a);
    const n = new THREE.Vector3().crossVectors(e1, e2);
    fn.push(n.lengthSq() > 1e-16 ? n.normalize() : new THREE.Vector3(0, 1, 0));
    for (const p of t.p) {
      const k = key(p);
      let l = at.get(k);
      if (!l) at.set(k, (l = []));
      l.push(i);
    }
  });
  const acc = new THREE.Vector3();
  return tris.map((t, i) => t.p.map((p) => {
    acc.set(0, 0, 0);
    for (const j of at.get(key(p))) {
      if (fn[i].dot(fn[j]) >= cosLimit) acc.add(fn[j]);
    }
    if (acc.lengthSq() < 1e-12) acc.copy(fn[i]);
    else acc.normalize();
    return [acc.x, acc.y, acc.z];
  }));
}

/** An axis-aligned box, in already-fitted coordinates, as flat triangles. */
function boxTris(b) {
  const x0 = -b.w / 2, x1 = b.w / 2;
  const c = [[x0, b.y0, b.z0], [x1, b.y0, b.z0], [x1, b.y1, b.z0], [x0, b.y1, b.z0],
             [x0, b.y0, b.z1], [x1, b.y0, b.z1], [x1, b.y1, b.z1], [x0, b.y1, b.z1]];
  const faces = [
    [0, 2, 1], [0, 3, 2], // -z
    [4, 5, 6], [4, 6, 7], // +z
    [0, 1, 5], [0, 5, 4], // -y
    [3, 7, 6], [3, 6, 2], // +y
    [0, 4, 7], [0, 7, 3], // -x
    [1, 2, 6], [1, 6, 5], // +x
  ];
  return faces.map((f) => ({ p: f.map((i) => c[i].slice()), name: "cargo", hex: b.c }));
}

function centroid(tris) {
  if (!tris.length) return null;
  let x = 0, y = 0, z = 0;
  for (const t of tris) {
    for (const p of t.p) { x += p[0]; y += p[1]; z += p[2]; }
  }
  const n = tris.length * 3;
  return [x / n, y / n, z / n];
}

/** Split a lamp slot into its left and right cluster by x sign. Buses put a
    lamp bar right across the nose, so a slot that never crosses the centre
    line falls back to a single anchor mirrored by the caller. */
function lampPair(tris) {
  const l = centroid(tris.filter((t) => (t.p[0][0] + t.p[1][0] + t.p[2][0]) / 3 < 0));
  const r = centroid(tris.filter((t) => (t.p[0][0] + t.p[1][0] + t.p[2][0]) / 3 >= 0));
  if (l && r) return [l, r];
  const one = l || r || centroid(tris);
  return one ? [[-Math.abs(one[0]), one[1], one[2]], [Math.abs(one[0]), one[1], one[2]]] : null;
}

function build(style, cfg) {
  const file = path.join(SRC, cfg.src, `${cfg.src}.fbx`);
  const meshes = loadFbx(file);
  const bodyMeshes = meshes.filter((m) => !/wheel/i.test(m.name));
  const wheelMeshes = meshes.filter((m) => /wheel/i.test(m.name));
  if (!bodyMeshes.length) throw new Error(`${cfg.src}: no body mesh`);

  // fit the *whole* vehicle (wheels included) so the tyres touch y = 0
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  const S = [cfg.W / size.x, cfg.H / size.y, cfg.L / size.z];
  const fit = (p) => [
    (p[0] - ctr.x) * S[0],
    (p[1] - box.min.y) * S[1],
    (p[2] - ctr.z) * S[2],
  ];

  let tris = [];
  for (const m of bodyMeshes) tris = tris.concat(meshTris(m));
  for (const t of tris) t.p = t.p.map(fit);
  if (cfg.cargo) tris = tris.concat(boxTris(cfg.cargo));

  /* A non-uniform fit skews normals: the correct transform for a normal is the
     inverse transpose, i.e. divide each axis by its scale. Recomputing them
     from the fitted triangles gets that for free and is exact. */
  const normals = creaseNormals(tris, Math.cos(THREE.MathUtils.degToRad(38)));

  const slot = (name) => tris.filter((t) => t.name === name);
  const lamps = {
    head: lampPair(slot("headlights")),
    tail: lampPair(slot("rear lights")),
    flashR: centroid(slot("flashers siren red")),
    flashB: centroid(slot("flashers siren blue")),
  };

  const wheels = wheelMeshes.map((m) => {
    const b = new THREE.Box3().setFromObject(m);
    const c = fit(b.getCenter(new THREE.Vector3()).toArray());
    const s = b.getSize(new THREE.Vector3());
    // the tyre is round in Y/Z; Y is the axis the fit scales independently
    return { x: c[0], y: c[1], z: c[2], r: (s.y / 2) * S[1] };
  }).sort((a, b) => b.z - a.z || a.x - b.x);

  /* Vertex colour + paint mask per material slot. The paint slot is left white
     so the shader's per-instance colour lands unmodulated. */
  const C = new THREE.Color();
  const nv = tris.length * 3;
  const position = new Float32Array(nv * 3);
  const normal = new Float32Array(nv * 3);
  const color = new Float32Array(nv * 3);
  const paintable = new Float32Array(nv);
  let seenPaint = false;
  tris.forEach((t, i) => {
    const isPaint = t.name === cfg.paint;
    if (isPaint) seenPaint = true;
    C.setHex(isPaint ? 0xffffff : t.hex ?? matColor(t.name), THREE.SRGBColorSpace);
    for (let k = 0; k < 3; k++) {
      const o = (i * 3 + k) * 3;
      position.set(t.p[k], o);
      normal.set(normals[i][k], o);
      color[o] = C.r; color[o + 1] = C.g; color[o + 2] = C.b;
      paintable[i * 3 + k] = isPaint ? 1 : 0;
    }
  });
  if (!seenPaint) throw new Error(`${cfg.src}: paint slot "${cfg.paint}" not found`);

  const extras = {
    style,
    dims: { L: cfg.L, W: cfg.W, H: cfg.H },
    lamps,
    wheels,
    source: "Free Low Poly Vehicles Pack by rgsdev (CC0)",
  };
  return { position, normal, color, paintable, extras, tris: tris.length };
}

/* ------------------------- minimal GLB writer ------------------------- */

const CT_FLOAT = 5126, CT_USHORT = 5123, TARGET_ARRAY = 34962, TARGET_ELEMENT = 34963;

function pad4(n) { return (4 - (n % 4)) % 4; }

/** Write one glTF 2.0 binary with a single indexed mesh. Vertices are welded on
    exact position+normal+colour+mask matches, which is what turns the
    triangle soup above back into a compact indexed buffer. */
function writeGlb(file, m) {
  const nv = m.position.length / 3;
  const map = new Map();
  const P = [], N = [], CO = [], PA = [], IDX = [];
  for (let i = 0; i < nv; i++) {
    const k = `${m.position[i * 3].toFixed(4)},${m.position[i * 3 + 1].toFixed(4)},${m.position[i * 3 + 2].toFixed(4)}|` +
      `${m.normal[i * 3].toFixed(3)},${m.normal[i * 3 + 1].toFixed(3)},${m.normal[i * 3 + 2].toFixed(3)}|` +
      `${m.color[i * 3].toFixed(3)},${m.color[i * 3 + 1].toFixed(3)},${m.color[i * 3 + 2].toFixed(3)}|${m.paintable[i]}`;
    let ix = map.get(k);
    if (ix === undefined) {
      ix = P.length / 3;
      map.set(k, ix);
      P.push(m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2]);
      N.push(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]);
      CO.push(m.color[i * 3], m.color[i * 3 + 1], m.color[i * 3 + 2]);
      PA.push(m.paintable[i]);
    }
    IDX.push(ix);
  }
  if (P.length / 3 > 65535) throw new Error("index overflow: needs uint32 indices");

  const chunks = [];
  const views = [];
  const accessors = [];
  let off = 0;
  const addView = (buf, target) => {
    const p = pad4(buf.length);
    chunks.push(buf, Buffer.alloc(p));
    views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target });
    off += buf.length + p;
    return views.length - 1;
  };
  const addF32 = (arr, comps, name) => {
    const a = Float32Array.from(arr);
    const v = addView(Buffer.from(a.buffer, a.byteOffset, a.byteLength), TARGET_ARRAY);
    const min = new Array(comps).fill(Infinity), max = new Array(comps).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) {
      const c = i % comps;
      if (arr[i] < min[c]) min[c] = arr[i];
      if (arr[i] > max[c]) max[c] = arr[i];
    }
    accessors.push({
      bufferView: v, componentType: CT_FLOAT, count: arr.length / comps,
      type: ["SCALAR", "VEC2", "VEC3"][comps - 1], min, max,
    });
    return accessors.length - 1;
  };

  const aPos = addF32(P, 3);
  const aNor = addF32(N, 3);
  const aCol = addF32(CO, 3);
  const aPaint = addF32(PA, 1);
  const ia = Uint16Array.from(IDX);
  const vIdx = addView(Buffer.from(ia.buffer, ia.byteOffset, ia.byteLength), TARGET_ELEMENT);
  accessors.push({
    bufferView: vIdx, componentType: CT_USHORT, count: IDX.length, type: "SCALAR",
    min: [0], max: [P.length / 3 - 1],
  });
  const aIdx = accessors.length - 1;

  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: "2.0", generator: "racing-game tools/build-npc-models.mjs" },
    scene: 0,
    scenes: [{ nodes: [0], extras: m.extras }],
    nodes: [{ mesh: 0, name: m.extras.style, extras: m.extras }],
    meshes: [{
      name: m.extras.style,
      extras: m.extras,
      primitives: [{
        attributes: { POSITION: aPos, NORMAL: aNor, COLOR_0: aCol, _PAINTABLE: aPaint },
        indices: aIdx, material: 0,
      }],
    }],
    // a viewer needs *some* material; the game replaces it with its own
    materials: [{
      name: "npcBody",
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.3, roughnessFactor: 0.55 },
    }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = Buffer.alloc(pad4(jsonBuf.length), 0x20);
  const binPad = Buffer.alloc(pad4(bin.length), 0);
  const total = 12 + 8 + jsonBuf.length + jsonPad.length + 8 + bin.length + binPad.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); // "glTF"
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jHead = Buffer.alloc(8);
  jHead.writeUInt32LE(jsonBuf.length + jsonPad.length, 0);
  jHead.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  const bHead = Buffer.alloc(8);
  bHead.writeUInt32LE(bin.length + binPad.length, 0);
  bHead.writeUInt32LE(0x004e4942, 4); // "BIN"
  fs.writeFileSync(file, Buffer.concat([head, jHead, jsonBuf, jsonPad, bHead, bin, binPad]));
  return { verts: P.length / 3, tris: IDX.length / 3, bytes: total };
}

fs.mkdirSync(OUT, { recursive: true });
let totalBytes = 0, totalTris = 0;
for (const style in STYLES) {
  const m = build(style, STYLES[style]);
  const r = writeGlb(path.join(OUT, `${style}.glb`), m);
  totalBytes += r.bytes;
  totalTris += r.tris;
  console.log(
    `${style.padEnd(8)} <- ${STYLES[style].src.padEnd(13)} ` +
    `${String(r.tris).padStart(5)} tris  ${String(r.verts).padStart(5)} verts  ` +
    `${(r.bytes / 1024).toFixed(1).padStart(6)} KB  ` +
    `wheels=${m.extras.wheels.length} lamps=${m.extras.lamps.head ? "y" : "n"}/${m.extras.lamps.tail ? "y" : "n"}`
  );
}
console.log(`\n${Object.keys(STYLES).length} models, ${totalTris} tris, ${(totalBytes / 1024).toFixed(1)} KB total`);
