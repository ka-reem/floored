/* Bakes the hi-fi NPC fleet from vetted CC-BY Sketchfab donors into the
   runtime's one-mesh GLB contract (see tools/build-orchids-models.mjs and
   game/npcmodels.ts — attributes POSITION/NORMAL/COLOR_0/TEXCOORD_0/
   _PAINTABLE/_LAMP plus scene extras {style, dims, lamps, wheels}).

     node tools/build-hifi-models.mjs --dl <donor-dir> [style ...] [--hd]
     node tools/build-hifi-models.mjs --mint <staging-dir> [style ...] [--hd]

   --mint bakes a Mint-generated bodyshell instead of a Sketchfab donor. It
   is the same pipeline — same fit, same wheel strip, same extras, same GLB
   writer — with three source-shaped differences, all driven off the MINT
   table below rather than a parallel script:

   - The source is ONE Draco-compressed .glb with ONE material and ONE
     embedded atlas, so there is nothing to repack: the atlas is resized in
     place and the UVs pass through untouched. Nothing to visibility-cull
     either (a retopo has no interior) and nothing to simplify.
   - Lamps cannot be found by material slot ("rear lights") or by red texels:
     the shell is one material and its lamps are painted as WHITE glass. They
     come from an explicit atlas MASK instead — see tools/seed-lamp-mask.mjs,
     which authors the committed PNG this reads.
   - Because the lamps are white, the tail lens is TINTED RED into the atlas
     at bake time, keyed off that same mask. That is what makes the existing
     runtime work unchanged: traffic.ts's emissive is `albedo * level`, so a
     red lens gives red running/brake lamps with no shader change, and it is
     also the correct unlit daylight look. Headlamps stay clear.

   Branding is painted out of the atlas in the same pass (see `brand`): the
   donor is a real-world car and shipping its badges is a trademark problem.

   <donor-dir> holds one subdirectory per donor (camry/, prius/, golf/,
   highlander/, civil/), each an unzipped Sketchfab glTF export
   (scene.gltf + scene.bin + textures/). The donors are deliberately NOT in
   the repo (100MB+ of source for ~3MB of output); ATTRIBUTIONS.md carries
   their licences and uids, docs/handoff/briefs/brief-npc-fleet.md the
   sourcing history.

   Two quality levels from one pipeline (the owner wants the new fleet on
   MOBILE too, with desktop a step up):

   - BASE (default): public/models/cars/<style>.glb — critical path, so
     hero donors are visibility-culled (interiors and all occluded geometry
     dropped), wheel geometry removed in favor of the fleet's shared
     instanced wheels, then rear-bias simplified to a few thousand
     triangles with a 512px single-atlas texture.
   - HD (--hd): public/models/cars-hd/<style>.glb — same bake at gentler
     ratios and a 1024px atlas, lazy-loaded on desktop after the first
     drivable frame and hot-swapped through the existing applyModel path.

   Rear bias is the entire point: traffic is overtaken from behind in the
   dashcam view, so the tail keeps several times the triangle share of the
   nose. Interiors are removed by multi-view visibility, not by name —
   these donors ship one anonymous mesh. */

import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { MeshoptSimplifier } from "meshoptimizer";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const DL = flag("--dl", null);
const MINT = flag("--mint", null);
const HD = argv.includes("--hd");
const ONLY = [];
const SRC_OVERRIDE = {};
for (const a of argv) {
  if (a.startsWith("--") || a === DL || a === MINT) continue;
  const eq = a.indexOf("=");
  if (eq > 0) SRC_OVERRIDE[a.slice(0, eq)] = a.slice(eq + 1);
  else ONLY.push(a);
}
const OUT = path.resolve(
  import.meta.dirname,
  HD ? "../public/models/cars-hd" : "../public/models/cars"
);
const ROOT = MINT || DL;
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error("usage: node tools/build-hifi-models.mjs (--dl <donor-dir> | --mint <staging-dir>) [style ...] [--hd]");
  process.exit(1);
}

/* Fitted dims mirror tools/build-orchids-models.mjs (W/L feed traffic.ts's
   TYPE_DIM contract: the GLB's whole box lands on exactly these numbers).

   Hero fields: axles/wheelR seed the wheel finder (fractions of source L /
   meters at source scale ~= real car scale, all four donors are ~1:1).
   Pack fields: node prefix + spin (about +Y, after auto-length-to-Z).
   tailY/headY: lamp-box vertical band as fractions of fitted H. */
const STYLES = {
  sedan: { kind: "hero", src: "camry", L: 4.44, W: 1.79, H: 1.45 },
  hybrid: { kind: "hero", src: "prius", L: 4.54, W: 1.76, H: 1.51 },
  compact: { kind: "hero", src: "golf", L: 3.94, W: 1.71, H: 1.42 },
  suv: { kind: "hero", src: "highlander", L: 4.72, W: 1.9, H: 1.79 },
  taxi: { kind: "pack", src: "civil", node: "taxi", L: 4.44, W: 1.79, H: 1.45 },
  police: { kind: "pack", src: "civil", node: "police", L: 4.44, W: 1.79, H: 1.52,
    flashR: [-0.16, 1.0, 0.1], flashB: [0.16, 1.0, 0.1] },
  van: { kind: "pack", src: "civil", node: "postvan", L: 4.64, W: 1.78, H: 1.91 },
  bus: { kind: "pack", src: "civil", node: "citybus", L: 9.4, W: 2.26, H: 3.0 },
};
/* Per-style orientation fixes discovered by rendering (see --probe):
   spin=Math.PI flips a donor whose nose came out at -Z. */
const SPIN = { taxi: Math.PI, police: Math.PI, van: Math.PI, bus: 0 };

/* --mint styles. Same L/W/H contract as above; the extra fields are the
   three things a Mint shell needs that a Sketchfab donor does not.

   `spin`: this shell arrives nose at -Z (verified — the amber-indicator
   headlamp texels sit at z < -0.6), and the runtime wants +Z forward.

   `mask`: the committed lamp mask, resolved next to this tool (the shells
   themselves live in gitignored staging; the mask is a build INPUT and is
   in the repo). Authored by tools/seed-lamp-mask.mjs — red = tail lens,
   green = headlamp lens. Sampled per triangle at its UV centroid, so a
   lamp's whole triangle is tagged or none of it is — partial tagging would
   interpolate lampKind across a face and bleed emissive onto bodywork.

   `tailLens`: linear-RGB the tail lens albedo is retinted to. Matched to
   what the rest of the fleet's tagged lenses measure — traffic.ts quotes a
   red lens texel at roughly (0.62, 0.055, 0.06) — so the running (3.1) and
   brake (4.4) levels it was tuned with land in the same place here.

   `brand`: atlas rectangles painted out before anything else reads the
   texture. Toyota roundels and the tailgate wordmarks; a Laplace fill from
   each rect's own border, which on flat panels and flat grille is
   indistinguishable from the bodywork around it. */
const MINT_STYLES = {
  /* `mhybrid` -- the Mint generation of the hybrid, riding ALONGSIDE the
     ItsDiyor `hybrid` and the Orchids `ohybrid` rather than replacing either.
     Same naming idea as the o-prefix: the prefix is the generation the shell
     came from, and the fleet mix in traffic.ts splits one hybrid-class share
     of traffic between the three. */
  mhybrid: {
    kind: "mint", src: "mint/prius-retopo.glb", L: 4.54, W: 1.76, H: 1.51,
    spin: Math.PI,
    mask: "masks/prius-lamp-mask.png",
    tailLens: [0.62, 0.055, 0.06],
    brand: [
      [1070, 204, 38, 36],  // roundel, front grille
      [707, 542, 40, 38],   // roundel, front grille (second island)
      [816, 1181, 40, 38],  // roundel, tailgate
      [700, 1188, 66, 28],  // tailgate script
      [764, 1200, 74, 20],  // embossed tailgate text
      [272, 815, 20, 36],   // pillar mark
      [161, 1228, 60, 20],  // tailgate script (second island)
      [359, 1236, 64, 22],  // tailgate script (third island)
    ],
    source: "Mint-generated bodyshell, retopologized (see ATTRIBUTIONS.md)",
  },
};

/* ---------------- glTF reading (scene.gltf + bin + image files) --------- */
function loadDoc(dir) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, "scene.gltf"), "utf8"));
  const buffers = (json.buffers || []).map((b) =>
    b.uri.startsWith("data:")
      ? Buffer.from(b.uri.split(",")[1], "base64")
      : fs.readFileSync(path.join(dir, decodeURIComponent(b.uri)))
  );
  return { json, buffers, dir };
}
const CT = {
  5120: [1, "readInt8"], 5121: [1, "readUInt8"], 5122: [2, "readInt16LE"],
  5123: [2, "readUInt16LE"], 5125: [4, "readUInt32LE"], 5126: [4, "readFloatLE"],
};
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function accessor(doc, i) {
  const a = doc.json.accessors[i];
  const v = doc.json.bufferViews[a.bufferView];
  const buf = doc.buffers[v.buffer];
  const [bytes, get] = CT[a.componentType];
  const w = NC[a.type];
  const stride = v.byteStride || bytes * w;
  const start = (v.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * w);
  for (let k = 0; k < a.count; k++)
    for (let c = 0; c < w; c++) out[k * w + c] = buf[get](start + k * stride + c * bytes);
  return out;
}
function matMul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
function localMat(n) {
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

/** Every world-space triangle of the selected donor subtree, with UV and
 *  source material index. `nodeFilter` (packs) selects by node-name prefix. */
function collectTris(doc, nodeFilter) {
  const parents = new Array(doc.json.nodes.length).fill(-1);
  doc.json.nodes.forEach((n, i) => n.children?.forEach((c) => (parents[c] = i)));
  const wc = new Map();
  const world = (i) => {
    if (wc.has(i)) return wc.get(i);
    const l = localMat(doc.json.nodes[i]);
    const p = parents[i];
    const m = p < 0 ? l : matMul(world(p), l);
    wc.set(i, m);
    return m;
  };
  const tris = [];
  doc.json.nodes.forEach((n, ni) => {
    if (n.mesh === undefined) return;
    if (nodeFilter && !(n.name || "").startsWith(nodeFilter)) return;
    const m = world(ni);
    for (const prim of doc.json.meshes[n.mesh].primitives) {
      const pos = accessor(doc, prim.attributes.POSITION);
      const uv = prim.attributes.TEXCOORD_0 !== undefined ? accessor(doc, prim.attributes.TEXCOORD_0) : null;
      const nor = prim.attributes.NORMAL !== undefined ? accessor(doc, prim.attributes.NORMAL) : null;
      const idx = prim.indices !== undefined
        ? accessor(doc, prim.indices)
        : Float64Array.from({ length: pos.length / 3 }, (_, k) => k);
      for (let k = 0; k < idx.length; k += 3) {
        const t = { p: [], uv: [], n: [], mat: prim.material ?? -1 };
        for (let e = 0; e < 3; e++) {
          const ix = idx[k + e];
          const x = pos[ix * 3], y = pos[ix * 3 + 1], z = pos[ix * 3 + 2];
          t.p.push([
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          ]);
          t.uv.push(uv ? [uv[ix * 2], uv[ix * 2 + 1]] : [0.5, 0.5]);
          if (nor) {
            // rotation part only — the donors carry no shear, and normals renormalize
            const nx = nor[ix * 3], ny = nor[ix * 3 + 1], nz = nor[ix * 3 + 2];
            const wx = m[0] * nx + m[4] * ny + m[8] * nz;
            const wy = m[1] * nx + m[5] * ny + m[9] * nz;
            const wz = m[2] * nx + m[6] * ny + m[10] * nz;
            const l = Math.hypot(wx, wy, wz) || 1;
            t.n.push([wx / l, wy / l, wz / l]);
          } else t.n.push(null);
        }
        tris.push(t);
      }
    }
  });
  return tris;
}

/* ---------------- Mint source: one Draco .glb, one atlas --------------- */
/* Same `tris` shape collectTris produces, so everything downstream — wheel
   strip, crease normals, fit, lamp extras, writer — is shared verbatim. */
async function loadMintGlb(file) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });
  const doc = await io.read(file);
  const meshes = doc.getRoot().listMeshes();
  const tris = [];
  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute("POSITION").getArray();
      const N = prim.getAttribute("NORMAL")?.getArray() || null;
      const UV = prim.getAttribute("TEXCOORD_0")?.getArray() || null;
      const ix = prim.getIndices();
      const IX = ix ? ix.getArray() : Uint32Array.from({ length: P.length / 3 }, (_, k) => k);
      for (let k = 0; k < IX.length; k += 3) {
        const t = { p: [], uv: [], n: [], mat: 0 };
        for (let e = 0; e < 3; e++) {
          const v = IX[k + e];
          t.p.push([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
          t.uv.push(UV ? [UV[v * 2], UV[v * 2 + 1]] : [0.5, 0.5]);
          t.n.push(N ? [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]] : null);
        }
        tris.push(t);
      }
    }
  }
  const tex = doc.getRoot().listTextures()[0];
  return { tris, image: tex ? Buffer.from(tex.getImage()) : null };
}

/** Rotate a triangle soup about +Y (used to put the nose on +Z). */
function spinTris(tris, a) {
  if (!a) return;
  const c = Math.cos(a), s = Math.sin(a);
  for (const t of tris) {
    t.p = t.p.map(([x, y, z]) => [x * c + z * s, y, -x * s + z * c]);
    t.n = t.n.map((n) => (n ? [n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c] : n));
  }
}

/** Fill each rect from its own border by relaxation, so a painted-out badge
    takes the colour and gradient of the panel it sat on rather than a flat
    patch. 120 Jacobi sweeps is plenty at these sizes (<= 74 px wide). */
function inpaintRects(buf, w, h, ch, rects) {
  for (const [rx, ry, rw, rh] of rects) {
    const x0 = Math.max(0, rx), y0 = Math.max(0, ry);
    const x1 = Math.min(w, rx + rw), y1 = Math.min(h, ry + rh);
    if (x1 <= x0 || y1 <= y0) continue;
    const bw = x1 - x0, bh = y1 - y0;
    for (let c = 0; c < 3; c++) {
      // seed from the mean of the ring just outside the rect
      let sum = 0, n = 0;
      for (let x = Math.max(0, x0 - 2); x < Math.min(w, x1 + 2); x++)
        for (const y of [y0 - 2, y0 - 1, y1, y1 + 1]) {
          if (y < 0 || y >= h) continue;
          sum += buf[(y * w + x) * ch + c]; n++;
        }
      for (let y = Math.max(0, y0 - 2); y < Math.min(h, y1 + 2); y++)
        for (const x of [x0 - 2, x0 - 1, x1, x1 + 1]) {
          if (x < 0 || x >= w) continue;
          sum += buf[(y * w + x) * ch + c]; n++;
        }
      const seed = n ? sum / n : 128;
      let cur = new Float32Array(bw * bh).fill(seed);
      let nxt = new Float32Array(bw * bh);
      const at = (x, y) =>
        x >= x0 && x < x1 && y >= y0 && y < y1
          ? cur[(y - y0) * bw + (x - x0)]
          : (x >= 0 && x < w && y >= 0 && y < h ? buf[(y * w + x) * ch + c] : seed);
      for (let it = 0; it < 120; it++) {
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++)
            nxt[(y - y0) * bw + (x - x0)] =
              (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
        const t = cur; cur = nxt; nxt = t;
      }
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
          buf[(y * w + x) * ch + c] = Math.max(0, Math.min(255, Math.round(cur[(y - y0) * bw + (x - x0)])));
    }
  }
}

const srgb = (u) => (u <= 0.0031308 ? u * 12.92 : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);

/** Retint the mask's tail-lens texels to red plastic, keeping the lens's own
    internal structure (chrome bars, LED segments) by scaling about the
    region's mean rather than flooding it with a flat colour. */
function tintTailLens(buf, w, h, ch, mask, mw, target) {
  let sum = 0, n = 0;
  const idx = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const mi = (Math.min(mw - 1, Math.round((x / w) * mw)) +
      Math.min(mw - 1, Math.round((y / h) * mw)) * mw) * 3;
    if (mask[mi] < 128) continue; // red channel = tail
    const o = (y * w + x) * ch;
    idx.push(o);
    sum += buf[o] * 0.299 + buf[o + 1] * 0.587 + buf[o + 2] * 0.114;
    n++;
  }
  if (!n) return 0;
  const mean = sum / n;
  const tgt = target.map((v) => srgb(v) * 255);
  for (const o of idx) {
    const k = (buf[o] * 0.299 + buf[o + 1] * 0.587 + buf[o + 2] * 0.114) / Math.max(1, mean);
    for (let c = 0; c < 3; c++) buf[o + c] = Math.max(0, Math.min(255, Math.round(tgt[c] * k)));
  }
  return n;
}

const cen = (t) => [
  (t.p[0][0] + t.p[1][0] + t.p[2][0]) / 3,
  (t.p[0][1] + t.p[1][1] + t.p[2][1]) / 3,
  (t.p[0][2] + t.p[1][2] + t.p[2][2]) / 3,
];
function bounds(tris) {
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const t of tris)
    for (const p of t.p)
      for (let a = 0; a < 3; a++) {
        if (p[a] < mn[a]) mn[a] = p[a];
        if (p[a] > mx[a]) mx[a] = p[a];
      }
  return { mn, mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
}

/* ---------------- wheels: find, record, remove -------------------------- */
/* The donors merge wheels into the anonymous body mesh, so wheels are
   located geometrically: the two densest z-bands of low outboard geometry
   are the axles; everything within a cylinder around each axle (axis along
   x, outboard of the rocker line) is wheel. The removed cluster's bounds
   feed extras.wheels so the shared instanced wheels land in the arches. */
function findAxles(tris, b) {
  const L = b.size[2], H = b.size[1], W = b.size[0];
  const bins = new Float64Array(48);
  for (const t of tris) {
    const c = cen(t);
    if (c[1] - b.mn[1] > 0.42 * H) continue;
    if (Math.abs(c[0] - (b.mn[0] + W / 2)) < 0.3 * W) continue;
    bins[Math.min(47, Math.max(0, Math.floor(((c[2] - b.mn[2]) / L) * 48)))]++;
  }
  // two peaks at least a third of the car apart
  let a1 = 0;
  for (let i = 1; i < 48; i++) if (bins[i] > bins[a1]) a1 = i;
  let a2 = -1;
  for (let i = 0; i < 48; i++) {
    if (Math.abs(i - a1) < 16) continue;
    if (a2 < 0 || bins[i] > bins[a2]) a2 = i;
  }
  const z = (i) => b.mn[2] + ((i + 0.5) / 48) * L;
  return [z(Math.min(a1, a2)), z(Math.max(a1, a2))];
}
function stripWheels(tris, b, pack = false) {
  const H = b.size[1], W = b.size[0];
  const midX = b.mn[0] + W / 2;
  const axles = findAxles(tris, b);

  /* Wheels were authored as separate parts and merged UNWELDED into the
     body mesh, so connected components recover them exactly: removing a
     whole component can never tear the fender the way a spatial cut can.
     A component is a wheel when its box is wheel-sized and sits at a
     wheel station (outboard, low, near an axle). */
  const parent = new Int32Array(tris.length * 3).map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, c) => {
    const ra = find(a), rc = find(c);
    if (ra !== rc) parent[rc] = ra;
  };
  const vmap = new Map();
  tris.forEach((t, ti) => {
    for (let e = 0; e < 3; e++) {
      const p = t.p[e];
      const key = `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;
      const prev = vmap.get(key);
      if (prev === undefined) vmap.set(key, ti * 3 + e);
      else union(prev, ti * 3 + e);
    }
    union(ti * 3, ti * 3 + 1);
    union(ti * 3, ti * 3 + 2);
  });
  const comps = new Map(); // root -> {tris:[], bbox}
  tris.forEach((t, ti) => {
    const r = find(ti * 3);
    let c = comps.get(r);
    if (!c) comps.set(r, (c = { tris: [], mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }));
    c.tris.push(ti);
    for (const p of t.p)
      for (let a = 0; a < 3; a++) {
        if (p[a] < c.mn[a]) c.mn[a] = p[a];
        if (p[a] > c.mx[a]) c.mx[a] = p[a];
      }
  });
  /* Pack donors weld their wheels into the body shell, and their arches
     are tight — every geometric cut tried here tore bodywork. So packs
     keep their authored wheels (static; invisible at night) and the
     runtime skips the shared instanced wheels for them instead. */
  if (pack) return { kept: tris, wheels: [], removed: 0 };

  const wheelComps = new Set();
  const clusters = [];
  for (const [root, c] of comps) {
    const sy = c.mx[1] - c.mn[1], sz = c.mx[2] - c.mn[2];
    const cx = (c.mn[0] + c.mx[0]) / 2, cy = (c.mn[1] + c.mx[1]) / 2, cz = (c.mn[2] + c.mx[2]) / 2;
    /* A wheel part is wheel-diameter bounded, wholly below the beltline,
       outboard, near an axle, and round-ish in the y/z plane. Doors fail
       the beltline + diameter tests (this filter once ate the Golf's
       door and drove it around with a black inner shell). */
    if (sy > 0.5 * H || sz > 0.5 * H || sy < 0.02 * H) continue;
    if (c.mx[1] - b.mn[1] > 0.55 * H) continue;
    if (cy - b.mn[1] > 0.42 * H) continue;
    if (Math.abs(cx - midX) < 0.24 * W) continue;
    if (!axles.some((az) => Math.abs(cz - az) < 0.14 * b.size[2])) continue;
    if (Math.max(sy, sz) / Math.max(0.01, Math.min(sy, sz)) > 1.6) continue;
    wheelComps.add(root);
    clusters.push({ x: cx, y: cy, z: cz, sy, root, n: c.tris.length });
  }
  /* Merge same-corner fragments (tire, rim, disc arrive as separate
     components) into one wheel record per corner. */
  const corners = [];
  for (const cl of clusters) {
    let corner = corners.find(
      (k) =>
        Math.sign(k.x / k.n - midX) === Math.sign(cl.x - midX) &&
        Math.abs(k.z / k.n - cl.z) < 0.55
    );
    if (!corner) corners.push((corner = { x: 0, y: 0, z: 0, r: 0, n: 0, parts: 0 }));
    corner.x += cl.x * cl.n; corner.y += cl.y * cl.n; corner.z += cl.z * cl.n;
    corner.r = Math.max(corner.r, cl.sy / 2);
    corner.n += cl.n; corner.parts++;
  }
  const wheels = corners
    .filter((k) => k.n > 8)
    .sort((a, c) => c.n - a.n)
    .slice(0, 4)
    .map((k) => ({ x: k.x / k.n, y: k.y / k.n, z: k.z / k.n, r: k.r }));

  /* Second sweep: brake calipers/discs are separate components that fail
     the roundness test but sit wholly inside an emptied arch — take any
     component whose whole box fits inside a found wheel's sphere. */
  for (const [root, c] of comps) {
    if (wheelComps.has(root)) continue;
    const inside = wheels.some((w) => {
      const r2 = (w.r * 1.2 + 0.12) ** 2;
      for (const px of [c.mn[0], c.mx[0]])
        for (const py of [c.mn[1], c.mx[1]])
          for (const pz of [c.mn[2], c.mx[2]])
            if ((px - w.x) ** 2 + (py - w.y) ** 2 + (pz - w.z) ** 2 >= r2) return false;
      return true;
    });
    if (inside) wheelComps.add(root);
  }

  const kept = [];
  tris.forEach((t, ti) => {
    if (!wheelComps.has(find(ti * 3))) kept.push(t);
  });
  return { kept, wheels, removed: tris.length - kept.length };
}

/* ---------------- visibility cull (drops interiors + occluded) ---------- */
/* Rasterizes triangle ids into z-buffers from a sphere of orthographic
   viewpoints (plus low grazing rings so arches and sills survive). BLEND
   glass is treated as OPAQUE on purpose: whatever is only seen through
   glass is exactly the interior the owner wants gone. */
function visibilityCull(tris, res = 420) {
  const dirs = [];
  const N = 36;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    dirs.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    dirs.push([Math.cos(a) * 0.985, -0.17, Math.sin(a) * 0.985]); // under-view grazing
    dirs.push([Math.cos(a) * 0.985, 0.17, Math.sin(a) * 0.985]);
  }
  const visible = new Uint16Array(tris.length);
  const seen = new Uint8Array(tris.length);
  const zb = new Float64Array(res * res);
  const ib = new Int32Array(res * res);
  for (const d of dirs) {
    // basis
    const up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let rx = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]];
    const rl = Math.hypot(...rx);
    rx = rx.map((v) => v / rl);
    const ry = [d[1] * rx[2] - d[2] * rx[1], d[2] * rx[0] - d[0] * rx[2], d[0] * rx[1] - d[1] * rx[0]];
    // projected bounds
    let mnu = 1e9, mxu = -1e9, mnv = 1e9, mxv = -1e9;
    const proj = (p) => [
      p[0] * rx[0] + p[1] * rx[1] + p[2] * rx[2],
      p[0] * ry[0] + p[1] * ry[1] + p[2] * ry[2],
      p[0] * d[0] + p[1] * d[1] + p[2] * d[2],
    ];
    for (const t of tris)
      for (const p of t.p) {
        const u = p[0] * rx[0] + p[1] * rx[1] + p[2] * rx[2];
        const v = p[0] * ry[0] + p[1] * ry[1] + p[2] * ry[2];
        if (u < mnu) mnu = u;
        if (u > mxu) mxu = u;
        if (v < mnv) mnv = v;
        if (v > mxv) mxv = v;
      }
    const su = (res - 2) / (mxu - mnu || 1), sv = (res - 2) / (mxv - mnv || 1);
    const s = Math.min(su, sv);
    zb.fill(-1e18);
    ib.fill(-1);
    for (let ti = 0; ti < tris.length; ti++) {
      const t = tris[ti];
      const q = t.p.map(proj);
      const X = q.map((p) => (p[0] - mnu) * s + 1);
      const Y = q.map((p) => (p[1] - mnv) * s + 1);
      const minx = Math.max(0, Math.floor(Math.min(X[0], X[1], X[2])));
      const maxx = Math.min(res - 1, Math.ceil(Math.max(X[0], X[1], X[2])));
      const miny = Math.max(0, Math.floor(Math.min(Y[0], Y[1], Y[2])));
      const maxy = Math.min(res - 1, Math.ceil(Math.max(Y[0], Y[1], Y[2])));
      const den = (Y[1] - Y[2]) * (X[0] - X[2]) + (X[2] - X[1]) * (Y[0] - Y[2]);
      if (Math.abs(den) < 1e-12) continue;
      for (let y = miny; y <= maxy; y++)
        for (let x = minx; x <= maxx; x++) {
          const w0 = ((Y[1] - Y[2]) * (x - X[2]) + (X[2] - X[1]) * (y - Y[2])) / den;
          const w1 = ((Y[2] - Y[0]) * (x - X[2]) + (X[0] - X[2]) * (y - Y[2])) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * q[0][2] + w1 * q[1][2] + w2 * q[2][2];
          const o = y * res + x;
          if (z > zb[o]) {
            zb[o] = z;
            ib[o] = ti;
          }
        }
    }
    for (let o = 0; o < ib.length; o++) if (ib[o] >= 0) seen[ib[o]] = 1;
    for (let i = 0; i < tris.length; i++)
      if (seen[i]) {
        visible[i]++;
        seen[i] = 0;
      }
  }
  /* View-count doubles as baked ambient occlusion: a panel seen from most
     directions is open sky, a grille slat or wheel-well wall seen from two
     is a cavity. Shaped gently so it shades, never dirties. */
  const out = [];
  for (let i = 0; i < tris.length; i++) {
    if (!visible[i]) continue;
    const t = tris[i];
    t.ao = 0.42 + 0.58 * Math.pow(Math.min(1, visible[i] / 34), 0.55);
    out.push(t);
  }
  return out;
}

/* ---------------- rear-biased simplification ---------------------------- */
/* One connected mesh through three passes of simplifyWithAttributes, so
   there are no region-seam cracks to lock against:

     pass A  no locks          → everything at the REAR's quality
     pass B  rear locked       → mid+front drop further
     pass C  rear+mid locked   → the nose drops hardest

   `ratios` = [rear, mid, front] as fractions of the culled source count.
   The nose is at +z for the hero donors (verified by render), so "rear"
   is the low-z third — exactly what tailgates the dashcam. UVs ride as
   simplification attributes so lens/badge artwork doesn't smear. */
async function simplifyRearBiased(tris, b, ratios) {
  await MeshoptSimplifier.ready;
  const L = b.size[2], z0 = b.mn[2];
  // weld by position+uv+mat (UV seams stay split; attribute error handles them)
  const map = new Map();
  const pos = [], uvs = [], nrm = [], aos = [], mats = [], idx = [];
  for (const t of tris)
    for (let e = 0; e < 3; e++) {
      const p = t.p[e], u = t.uv[e], nn = t.n[e] || [0, 1, 0];
      const key =
        `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}|${u[0].toFixed(4)},${u[1].toFixed(4)}|` +
        `${nn[0].toFixed(2)},${nn[1].toFixed(2)},${nn[2].toFixed(2)}|${t.mat}`;
      let ix = map.get(key);
      if (ix === undefined) {
        ix = pos.length / 3;
        map.set(key, ix);
        pos.push(p[0], p[1], p[2]);
        uvs.push(u[0], u[1]);
        nrm.push(nn[0], nn[1], nn[2]);
        aos.push(t.ao ?? 1);
        mats.push(t.mat);
      }
      idx.push(ix);
    }
  let indices = Uint32Array.from(idx);
  const positions = Float32Array.from(pos);
  /* UVs AND the authored smooth normals ride as simplification attributes:
     recomputing normals after decimation is what made the first bake read
     BLOCKY in-game — the donors' shading is authored, keep it. */
  const attributes = new Float32Array((pos.length / 3) * 6);
  for (let i = 0; i < pos.length / 3; i++) {
    attributes[i * 6] = uvs[i * 2];
    attributes[i * 6 + 1] = uvs[i * 2 + 1];
    attributes[i * 6 + 2] = nrm[i * 3];
    attributes[i * 6 + 3] = nrm[i * 3 + 1];
    attributes[i * 6 + 4] = nrm[i * 3 + 2];
    attributes[i * 6 + 5] = aos[i];
  }
  const nvtx = pos.length / 3;
  const zf = new Float64Array(nvtx);
  for (let i = 0; i < nvtx; i++) zf[i] = (pos[i * 3 + 2] - z0) / L;
  const lockRear = new Uint8Array(nvtx);
  const lockRearMid = new Uint8Array(nvtx);
  for (let i = 0; i < nvtx; i++) {
    if (zf[i] < 0.34) lockRear[i] = lockRearMid[i] = 1;
    else if (zf[i] < 0.62) lockRearMid[i] = 1;
  }
  const total = indices.length;
  const share = (lock) => {
    // triangle count whose verts are all unlocked, for pass targeting
    let free = 0;
    for (let k = 0; k < indices.length; k += 3)
      if (!lock[indices[k]] && !lock[indices[k + 1]] && !lock[indices[k + 2]]) free += 3;
    return free;
  };
  const run = (lock, target) => {
    try {
      const [simplified] = MeshoptSimplifier.simplifyWithAttributes(
        indices, positions, 3, attributes, 6, [0.9, 0.9, 0.55, 0.55, 0.55, 0.3], lock,
        Math.max(300, Math.floor(target / 3) * 3), 0.03, []
      );
      if (simplified.length < indices.length) indices = simplified;
    } catch (e) {
      console.warn("  simplify pass skipped:", e.message);
    }
  };
  // A: uniform to rear quality
  run(null, total * ratios[0]);
  // B: hold the rear, take mid+front down to mid quality
  {
    const lockedTris = indices.length - share(lockRear);
    run(lockRear, lockedTris + share(lockRear) * (ratios[1] / ratios[0]));
  }
  // C: hold rear+mid, nose to front quality
  {
    const lockedTris = indices.length - share(lockRearMid);
    run(lockRearMid, lockedTris + share(lockRearMid) * (ratios[2] / ratios[1]));
  }
  const out = [];
  for (let k = 0; k < indices.length; k += 3) {
    const t = { p: [], uv: [], n: [], mat: mats[indices[k]] };
    for (let e = 0; e < 3; e++) {
      const ix = indices[k + e];
      t.p.push([positions[ix * 3], positions[ix * 3 + 1], positions[ix * 3 + 2]]);
      t.uv.push([attributes[ix * 6], attributes[ix * 6 + 1]]);
      const nx = attributes[ix * 6 + 2], ny = attributes[ix * 6 + 3], nz = attributes[ix * 6 + 4];
      const l = Math.hypot(nx, ny, nz);
      t.n.push(l > 1e-6 ? [nx / l, ny / l, nz / l] : null);
      (t.aoV ??= []).push(Math.min(1, Math.max(0.3, attributes[ix * 6 + 5])));
    }
    out.push(t);
  }
  return out;
}

/* ---------------- single-atlas texture bake ----------------------------- */
/* One albedo (+ one metallicRoughness) atlas per style, so the runtime
   keeps its one-texture contract. Fixed shelf layout, biggest source
   first; untextured materials become small swatches. The body-paint
   material (untextured in all four hero donors) becomes a WHITE swatch
   with paintable=1 — per-instance paintCol recolors it directly, which is
   cleaner than the old fleet's texel-hue recolour. */
/** Extend a tile's edge pixels outward by `m` px on every side — atlas
    dilation. Without it the gutters hold background colour, and the
    mipmaps traffic is actually seen through (cars spend their lives 30+ m
    away) average that background into every panel edge: dark seams up
    close, rainbow mush at distance. The margins make minified samples
    blend toward the region's own content instead. */
async function dilateTile(tile, w, h, m) {
  const img = sharp(tile);
  const strip = async (left, top, ew, eh, dw, dh) =>
    sharp(await img.clone().extract({ left, top, width: ew, height: eh }).png().toBuffer())
      .resize(dw, dh, { fit: "fill", kernel: "nearest" })
      .png()
      .toBuffer();
  const [T, B, L, R, TL, TR, BL, BR] = await Promise.all([
    strip(0, 0, w, 1, w, m), strip(0, h - 1, w, 1, w, m),
    strip(0, 0, 1, h, m, h), strip(w - 1, 0, 1, h, m, h),
    strip(0, 0, 1, 1, m, m), strip(w - 1, 0, 1, 1, m, m),
    strip(0, h - 1, 1, 1, m, m), strip(w - 1, h - 1, 1, 1, m, m),
  ]);
  return sharp({
    create: { width: w + 2 * m, height: h + 2 * m, channels: 3, background: { r: 24, g: 26, b: 32 } },
  })
    .composite([
      { input: TL, left: 0, top: 0 }, { input: T, left: m, top: 0 }, { input: TR, left: m + w, top: 0 },
      { input: L, left: 0, top: m }, { input: tile, left: m, top: m }, { input: R, left: m + w, top: m },
      { input: BL, left: 0, top: m + h }, { input: B, left: m, top: m + h }, { input: BR, left: m + w, top: m + h },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function bakeAtlas(doc, tris, size) {
  const used = new Map(); // mat -> tri count
  for (const t of tris) used.set(t.mat, (used.get(t.mat) || 0) + 1);
  const mats = [...used.keys()];
  const meta = new Map();
  for (const mi of mats) {
    const m = doc.json.materials?.[mi] || {};
    const pbr = m.pbrMetallicRoughness || {};
    const ti = pbr.baseColorTexture?.index;
    let img = null, w = 0;
    if (ti !== undefined) {
      const image = doc.json.images[doc.json.textures[ti].source];
      img = path.join(doc.dir, decodeURIComponent(image.uri));
      w = 1024; // treat sources as comparable; layout sorts by tris*res
    }
    const mrTi = pbr.metallicRoughnessTexture?.index;
    meta.set(mi, {
      img,
      mrImg: mrTi !== undefined
        ? path.join(doc.dir, decodeURIComponent(doc.json.images[doc.json.textures[mrTi].source].uri))
        : null,
      base: pbr.baseColorFactor || [1, 1, 1, 1],
      metal: pbr.metallicFactor ?? 1,
      rough: pbr.roughnessFactor ?? 1,
      blend: m.alphaMode === "BLEND",
      name: m.name || `m${mi}`,
      paint: !img && /paint/i.test(m.name || ""),
      score: (used.get(mi) || 0) * (img ? 4 : 1),
    });
  }
  /* Layout: big cell 3/4 x 3/4 for the best textured mat; right column and
     bottom row split among the rest. ALL coordinates are glTF/top-down
     fractions (x from left, t from top) — the same frame the composites,
     the UV remap and the written TEXCOORD_0 use, so there is exactly one
     v convention in this file. */
  const order = mats.slice().sort((a, b) => meta.get(b).score - meta.get(a).score);
  const cells = [
    { x: 0, t: 0, w: 0.75, h: 0.75 },
    { x: 0.75, t: 0, w: 0.25, h: 0.375 },
    { x: 0.75, t: 0.375, w: 0.25, h: 0.375 },
    { x: 0, t: 0.75, w: 0.25, h: 0.25 },
    { x: 0.25, t: 0.75, w: 0.25, h: 0.25 },
    { x: 0.5, t: 0.75, w: 0.25, h: 0.25 },
    { x: 0.75, t: 0.75, w: 0.25, h: 0.25 },
  ];
  const GUT = 5 / size; // gutter so bilinear+mip sampling never crosses regions
  const region = new Map();
  order.forEach((mi, i) => {
    const c = cells[Math.min(i, cells.length - 1)];
    region.set(mi, {
      x: c.x + GUT, t: c.t + GUT, w: c.w - 2 * GUT, h: c.h - 2 * GUT,
    });
  });

  const albedo = sharp({
    create: { width: size, height: size, channels: 3, background: { r: 24, g: 26, b: 32 } },
  });
  const mr = { width: size >> 1, height: size >> 1 };
  const compA = [], compM = [];
  for (const mi of order) {
    const inf = meta.get(mi);
    const r = region.get(mi);
    const px = { left: Math.round(r.x * size), top: Math.round(r.t * size), width: Math.max(1, Math.round(r.w * size)), height: Math.max(1, Math.round(r.h * size)) };
    let tile;
    if (inf.img) {
      let s = sharp(inf.img).resize(px.width, px.height, { fit: "fill" });
      if (inf.blend) {
        // composite the lens/glass artwork over dark glass so it bakes opaque
        const overlay = await s.ensureAlpha().png().toBuffer();
        tile = await sharp({
          create: { width: px.width, height: px.height, channels: 3, background: { r: 16, g: 18, b: 24 } },
        }).composite([{ input: overlay }]).jpeg().toBuffer();
      } else tile = await s.jpeg().toBuffer();
    } else {
      const c = inf.paint
        ? { r: 255, g: 255, b: 255 }
        : {
            r: Math.round(Math.pow(inf.base[0], 1 / 2.2) * 255),
            g: Math.round(Math.pow(inf.base[1], 1 / 2.2) * 255),
            b: Math.round(Math.pow(inf.base[2], 1 / 2.2) * 255),
          };
      tile = await sharp({ create: { width: px.width, height: px.height, channels: 3, background: c } }).jpeg().toBuffer();
    }
    {
      const m = Math.max(3, Math.round(GUT * size));
      const fat = await dilateTile(tile, px.width, px.height, m);
      compA.push({ input: fat, left: px.left - m, top: px.top - m });
    }
    // metallicRoughness at half res: source map or constants (G=rough, B=metal)
    const hpx = { left: px.left >> 1, top: px.top >> 1, width: Math.max(1, px.width >> 1), height: Math.max(1, px.height >> 1) };
    let mtile;
    if (inf.mrImg) mtile = await sharp(inf.mrImg).resize(hpx.width, hpx.height, { fit: "fill" }).jpeg().toBuffer();
    else {
      const rough = inf.paint ? 0.34 : inf.blend ? 0.12 : Math.min(1, inf.rough);
      const metal = inf.paint ? 0.5 : inf.blend ? 0 : Math.min(1, inf.metal * 0.5);
      mtile = await sharp({
        create: {
          width: hpx.width, height: hpx.height, channels: 3,
          background: { r: 0, g: Math.round(rough * 255), b: Math.round(metal * 255) },
        },
      }).jpeg().toBuffer();
    }
    {
      const m = Math.max(2, Math.round((GUT * size) / 2));
      const fat = await dilateTile(mtile, hpx.width, hpx.height, m);
      compM.push({ input: fat, left: hpx.left - m, top: hpx.top - m });
    }
  }
  const albedoJpg = await albedo.composite(compA).jpeg({ quality: 85, chromaSubsampling: "4:4:4" }).toBuffer();
  const albedoRaw = await sharp(albedoJpg).raw().toBuffer({ resolveWithObject: true });
  const mrJpg = await sharp({
    create: { width: mr.width, height: mr.height, channels: 3, background: { r: 0, g: 180, b: 20 } },
  }).composite(compM).jpeg({ quality: 82 }).toBuffer();

  /* Remap every corner's UV into its material's region — top-down glTF v
     throughout (donor UVs verified within [0,1], clamped for safety). */
  for (const t of tris) {
    const r = region.get(t.mat);
    for (let e = 0; e < 3; e++) {
      const u = Math.min(1, Math.max(0, t.uv[e][0]));
      const v = Math.min(1, Math.max(0, t.uv[e][1]));
      t.uv[e] = [r.x + u * r.w, r.t + v * r.h];
    }
    t.paint = meta.get(t.mat).paint ? 1 : 0;
    t.blend = meta.get(t.mat).blend;
  }
  return { albedoJpg, mrJpg, albedoRaw };
}

/* ---------------- normals, lamps, fit, write ---------------------------- */
function faceNormalsSmoothed(tris, degLimit = 44) {
  const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
  const at = new Map(), fn = [];
  tris.forEach((t, i) => {
    const [a, b, c] = t.p;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n) || 1;
    fn.push(n.map((q) => q / l));
    for (const p of t.p) {
      const k = key(p);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(i);
    }
  });
  const cos = Math.cos((degLimit * Math.PI) / 180);
  return tris.map((t, i) =>
    t.p.map((p) => {
      let ax = 0, ay = 0, az = 0;
      for (const j of at.get(key(p))) {
        const d = fn[i][0] * fn[j][0] + fn[i][1] * fn[j][1] + fn[i][2] * fn[j][2];
        if (d >= cos) {
          ax += fn[j][0]; ay += fn[j][1]; az += fn[j][2];
        }
      }
      const l = Math.hypot(ax, ay, az);
      return l > 1e-9 ? [ax / l, ay / l, az / l] : fn[i];
    })
  );
}

const CT_FLOAT = 5126, CT_USHORT = 5123, TARGET_ARRAY = 34962, TARGET_ELEMENT = 34963;
const pad4 = (n) => (4 - (n % 4)) % 4;
function writeGlb(file, m) {
  const nv = m.position.length / 3;
  const map = new Map(), P = [], N = [], CO = [], UV = [], PA = [], LK = [], IDX = [];
  for (let i = 0; i < nv; i++) {
    /* 1 mm positions / 2 dp normals / 3 dp UVs: coarse enough to weld the
       simplifier's near-duplicates, fine enough for a car-sized mesh under
       a 512-1024px atlas. */
    const key =
      `${m.position[i * 3].toFixed(3)},${m.position[i * 3 + 1].toFixed(3)},${m.position[i * 3 + 2].toFixed(3)}|` +
      `${m.normal[i * 3].toFixed(2)},${m.normal[i * 3 + 1].toFixed(2)},${m.normal[i * 3 + 2].toFixed(2)}|` +
      `${m.texcoord[i * 2].toFixed(3)},${m.texcoord[i * 2 + 1].toFixed(3)}|${m.paintable[i]}|${m.lampKind[i]}|` +
      `${(m.color ? m.color[i * 3] : 1).toFixed(2)}`;
    let ix = map.get(key);
    if (ix === undefined) {
      ix = P.length / 3;
      map.set(key, ix);
      P.push(m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2]);
      N.push(m.normal[i * 3], m.normal[i * 3 + 1], m.normal[i * 3 + 2]);
      if (m.color) CO.push(m.color[i * 3], m.color[i * 3 + 1], m.color[i * 3 + 2]);
      else CO.push(1, 1, 1);
      UV.push(m.texcoord[i * 2], m.texcoord[i * 2 + 1]);
      PA.push(m.paintable[i]);
      LK.push(m.lampKind[i]);
    }
    IDX.push(ix);
  }
  if (P.length / 3 > 65535) throw new Error(`${file}: index overflow (${P.length / 3} verts)`);
  const chunks = [], views = [], accessors = [];
  let off = 0;
  const addView = (buf, target) => {
    const padding = pad4(buf.length);
    chunks.push(buf, Buffer.alloc(padding));
    views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, ...(target ? { target } : {}) });
    off += buf.length + padding;
    return views.length - 1;
  };
  const addF32 = (arr, width) => {
    const typed = Float32Array.from(arr);
    const view = addView(Buffer.from(typed.buffer), TARGET_ARRAY);
    const min = new Array(width).fill(Infinity), max = new Array(width).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) {
      const k = i % width;
      if (arr[i] < min[k]) min[k] = arr[i];
      if (arr[i] > max[k]) max[k] = arr[i];
    }
    accessors.push({
      bufferView: view, componentType: CT_FLOAT, count: arr.length / width,
      type: ["SCALAR", "VEC2", "VEC3"][width - 1], min, max,
    });
    return accessors.length - 1;
  };
  /* Quantized attributes (KHR_mesh_quantization for the int8 normals;
     uint16 texcoords and uint8 colors are core-legal). Positions stay
     float32 — game/npcmodels.ts reads the geometry raw with no node
     transform, so a dequantize scale would be silently lost. Cuts the
     fleet's on-disk geometry nearly in half vs all-float. */
  const addQuant = (arr, width, Ctor, ct, normalized, scale) => {
    const typed = new Ctor(arr.length);
    for (let i = 0; i < arr.length; i++) typed[i] = Math.round(arr[i] * scale);
    const view = addView(Buffer.from(typed.buffer), TARGET_ARRAY);
    const min = new Array(width).fill(Infinity), max = new Array(width).fill(-Infinity);
    for (let i = 0; i < typed.length; i++) {
      const k = i % width;
      if (typed[i] < min[k]) min[k] = typed[i];
      if (typed[i] > max[k]) max[k] = typed[i];
    }
    accessors.push({
      bufferView: view, componentType: ct, count: arr.length / width,
      type: ["SCALAR", "VEC2", "VEC3"][width - 1], min, max,
      ...(normalized ? { normalized: true } : {}),
    });
    return accessors.length - 1;
  };
  const aPos = addF32(P, 3);
  const aNor = addQuant(N, 3, Int8Array, 5120, true, 127);
  const aCol = addQuant(CO, 3, Uint8Array, 5121, true, 255);
  const aUv = addQuant(UV, 2, Uint16Array, 5123, true, 65535);
  const aPaint = addQuant(PA, 1, Uint8Array, 5121, true, 255);
  const aLamp = addQuant(LK, 1, Uint8Array, 5121, false, 1);
  const indices = Uint16Array.from(IDX);
  const indexView = addView(Buffer.from(indices.buffer), TARGET_ELEMENT);
  accessors.push({
    bufferView: indexView, componentType: CT_USHORT, count: IDX.length,
    type: "SCALAR", min: [0], max: [P.length / 3 - 1],
  });
  const aIdx = accessors.length - 1;
  const imageView = addView(m.image);
  const mrView = addView(m.mrImage);
  const binary = Buffer.concat(chunks);
  const gltf = {
    asset: { version: "2.0", generator: "racing-game tools/build-hifi-models.mjs" },
    extensionsUsed: ["KHR_mesh_quantization"],
    extensionsRequired: ["KHR_mesh_quantization"],
    scene: 0,
    scenes: [{ nodes: [0], extras: m.extras }],
    nodes: [{ mesh: 0, name: m.extras.style, extras: m.extras }],
    meshes: [{
      name: m.extras.style,
      extras: m.extras,
      primitives: [{
        attributes: { POSITION: aPos, NORMAL: aNor, COLOR_0: aCol, TEXCOORD_0: aUv, _PAINTABLE: aPaint, _LAMP: aLamp },
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
        metallicFactor: 1, roughnessFactor: 1,
      },
    }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    textures: [{ sampler: 0, source: 0 }, { sampler: 0, source: 1 }],
    images: [
      { mimeType: "image/jpeg", bufferView: imageView },
      { mimeType: "image/jpeg", bufferView: mrView },
    ],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: binary.length }],
  };
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonPad = Buffer.alloc(pad4(json.length), 0x20);
  const binPad = Buffer.alloc(pad4(binary.length), 0);
  const total = 12 + 8 + json.length + jsonPad.length + 8 + binary.length + binPad.length;
  const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  jh.writeUInt32LE(json.length + jsonPad.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(binary.length + binPad.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([header, jh, json, jsonPad, bh, binary, binPad]));
  return { bytes: total, tris: IDX.length / 3, verts: P.length / 3 };
}

/* ---------------- per-style bake ---------------------------------------- */
async function build(style, cfg) {
  /* --dl dir + `style=subdir` overrides point a style at a round-2 hero
     donor; overridden styles are treated as heroes regardless of table. */
  if (SRC_OVERRIDE[style] && cfg.kind !== "mint") cfg = { ...cfg, src: SRC_OVERRIDE[style], kind: "hero" };
  const mint = cfg.kind === "mint";
  const doc = mint ? null : loadDoc(path.join(DL, cfg.src));
  let tris, mintAtlas = null;
  if (mint) {
    const m = await loadMintGlb(path.join(MINT, cfg.src));
    tris = m.tris;
    mintAtlas = m.image;
    /* Nose to +Z before anything measures the car, so the wheel finder, the
       lamp boxes and the fit all agree with the rest of the fleet. */
    spinTris(tris, cfg.spin || 0);
  } else {
    tris = collectTris(doc, cfg.kind === "pack" ? cfg.node : null);
  }
  let b = bounds(tris);

  /* Packs: length to +Z (rotate about Y if the donor lies along X), then an
     optional half-turn from SPIN once the nose has been checked visually. */
  if (cfg.kind === "pack") {
    const rot = b.size[0] > b.size[2] ? Math.PI / 2 : 0;
    const spin = rot + (SPIN[style] || 0);
    if (spin) {
      const c = Math.cos(spin), s = Math.sin(spin);
      for (const t of tris) {
        t.p = t.p.map(([x, y, z]) => [x * c + z * s, y, -x * s + z * c]);
        t.n = t.n.map((nn) => (nn ? [nn[0] * c + nn[2] * s, nn[1], -nn[0] * s + nn[2] * c] : nn));
      }
      b = bounds(tris);
    }
  }

  /* A 500k-2M donor would make the 46-view cull crawl; a quick uniform
     pre-pass to ~200k loses nothing the rear-biased pass would keep. */
  if (cfg.kind === "hero" && tris.length > 230000) {
    const before = tris.length;
    tris = await simplifyRearBiased(tris, b, [200000 / tris.length * 3, 200000 / tris.length * 3, 200000 / tris.length * 3].map((r) => Math.min(1, r / 3)));
    console.log(`  pre-decimate ${before} -> ${tris.length}`);
    b = bounds(tris);
  }

  const { kept, wheels, removed } = stripWheels(tris, b, cfg.kind === "pack");
  tris = kept;
  const beforeCull = tris.length;
  /* Mint shells are retopologized outer surfaces — there is no interior to
     cull, and at ~1.4k triangles the cull could only cost geometry (thin
     trim reads as occluded from most of the 46 views). Skip it. */
  tris = mint ? tris : visibilityCull(tris);
  const afterCull = tris.length;

  if (cfg.kind === "pack") {
    /* Packs skip the simplifier, so their per-TRI ao would split every
       shared vertex at the weld (adjacent tris rarely agree to 2dp).
       Average it per position first — smooth shading, welded verts. */
    const acc = new Map();
    const key = (pt) => `${pt[0].toFixed(3)},${pt[1].toFixed(3)},${pt[2].toFixed(3)}`;
    for (const t of tris)
      for (const pt of t.p) {
        const k = key(pt);
        const a = acc.get(k) || [0, 0];
        a[0] += t.ao ?? 1;
        a[1]++;
        acc.set(k, a);
      }
    for (const t of tris) {
      t.aoV = t.p.map((pt) => {
        const a = acc.get(key(pt));
        return a[0] / a[1];
      });
      delete t.ao;
    }
  }

  if (cfg.kind === "hero") {
    /* Heroes arrive nose at +z (verified by render); regions are rear→front. */
    const ratios = HD ? [0.85, 0.5, 0.3] : [0.3, 0.14, 0.1];
    tris = await simplifyRearBiased(tris, bounds(tris), ratios);
  }

  /* Texture. A Mint shell already IS a single atlas for a single material,
     so there is nothing to repack and the UVs pass through: paint the
     branding out, retint the tail lens red off the mask, resize, done.
     (No dilation pass either — the gutters are the source's own, not ones
     this tool created by shuffling tiles about.) */
  let albedoJpg, mrJpg, albedoRaw, lampMask = null, maskW = 0;
  if (mint) {
    const maskFile = path.resolve(import.meta.dirname, cfg.mask);
    lampMask = await sharp(maskFile).removeAlpha().raw().toBuffer();
    maskW = (await sharp(maskFile).metadata()).width;
    const src = sharp(mintAtlas);
    const sm = await src.metadata();
    const full = await sharp(mintAtlas).removeAlpha().raw().toBuffer();
    inpaintRects(full, sm.width, sm.height, 3, cfg.brand || []);
    const lensN = tintTailLens(full, sm.width, sm.height, 3, lampMask, maskW, cfg.tailLens);
    console.log(`  atlas ${sm.width}px: ${(cfg.brand || []).length} brand patches, ${lensN} tail-lens texels retinted`);
    const size = HD ? 1024 : 512;
    /* 4:4:4 rather than the default 4:2:0: this atlas puts near-black glass
       hard against white bodywork, and subsampled chroma turns that edge
       into coloured speckle right where the cabin is. */
    albedoJpg = await sharp(full, { raw: { width: sm.width, height: sm.height, channels: 3 } })
      .resize(size, size).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
    /* The source carries no MR map (metallic 0, roughness 0.8 as factors).
       The runtime sets material.roughness/metalness = 1 whenever a bake
       ships these maps, so the factors have to come across AS a map or the
       car turns into a mirror: flat grey = metal 0, roughness 0.8. */
    mrJpg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 204, b: 0 } },
    }).jpeg({ quality: 90 }).toBuffer();
    albedoRaw = { data: full, info: { width: sm.width, height: sm.height, channels: 3 } };
  } else {
    ({ albedoJpg, mrJpg, albedoRaw } = await bakeAtlas(doc, tris, HD ? 1024 : 512));
  }
  const texel = (u, v) => {
    const { data, info } = albedoRaw;
    const x = Math.min(info.width - 1, Math.max(0, Math.round(u * info.width)));
    const y = Math.min(info.height - 1, Math.max(0, Math.round(v * info.height)));
    const o = (y * info.width + x) * info.channels;
    return [data[o], data[o + 1], data[o + 2]];
  };
  /** Lamp kind from the committed atlas mask, sampled at a UV point. */
  const maskAt = (u, v) => {
    const x = Math.min(maskW - 1, Math.max(0, Math.round(u * maskW)));
    const y = Math.min(maskW - 1, Math.max(0, Math.round(v * maskW)));
    const o = (y * maskW + x) * 3;
    return lampMask[o] > 128 ? 2 : lampMask[o + 1] > 128 ? 1 : 0;
  };

  /* Fit to the game's dims: whole box (mirrors included) lands exactly on
     L/W/H, ground at y=0, +Z nose. Wheels ride through the same transform. */
  b = bounds(tris);
  const scale = [cfg.W / b.size[0], cfg.H / b.size[1], cfg.L / b.size[2]];
  const cx = b.mn[0] + b.size[0] / 2, cz = b.mn[2] + b.size[2] / 2;
  const fit = ([x, y, z]) => [(x - cx) * scale[0], (y - b.mn[1]) * scale[1], (z - cz) * scale[2]];
  for (const t of tris) {
    t.p = t.p.map(fit);
    // non-uniform fit → normals transform by the inverse scale, renormalized
    if (t.n)
      t.n = t.n.map((nn) => {
        if (!nn) return nn;
        const nx = nn[0] / scale[0], ny = nn[1] / scale[1], nz = nn[2] / scale[2];
        const l = Math.hypot(nx, ny, nz) || 1;
        return [nx / l, ny / l, nz / l];
      });
  }
  const fittedWheels = wheels
    .map((w) => {
      const c = fit([w.x, w.y, w.z]);
      return { x: c[0], y: c[1], z: c[2], r: w.r * scale[1] };
    })
    .sort((a, b2) => b2.z - a.z || a.x - b2.x);

  /* Lamps: lens-material (BLEND) triangles inside the front/rear boxes get
     the emissive lampKind; their per-side centroids anchor the glow
     sprites. Fractions of the fitted dims, like the orchids anchors. */
  const tailZ = -cfg.L * 0.5 + 0.55, headZ = cfg.L * 0.5 - 0.55;
  const lampSum = {
    head: [
      { x: 0, y: 0, z: 0, n: 0 },
      { x: 0, y: 0, z: 0, n: 0 },
    ],
    tail: [
      { x: 0, y: 0, z: 0, n: 0 },
      { x: 0, y: 0, z: 0, n: 0 },
    ],
  };
  for (const t of tris) {
    const c = cen(t);
    const inY = c[1] > cfg.H * 0.25 && c[1] < cfg.H * 0.78;
    const outX = Math.abs(c[0]) > cfg.W * 0.12;
    let kind = 0;
    const uc = (t.uv[0][0] + t.uv[1][0] + t.uv[2][0]) / 3;
    const vc = (t.uv[0][1] + t.uv[1][1] + t.uv[2][1]) / 3;
    if (mint) {
      /* One material and white lamp glass, so neither the slot test nor the
         red-texel test below can see anything. The committed mask decides,
         sampled once at the triangle's UV centroid — whole triangles, so
         lampKind never interpolates across a face onto bodywork. The
         position gate still applies: it is the backstop against a stray
         mask pixel lighting up somewhere that is not a lamp. */
      const m = maskAt(uc, vc);
      if (m && outX && (m === 2 ? c[2] < 0 : c[2] > 0)) kind = m;
    } else if (t.blend && inY && outX && (c[2] < tailZ || c[2] > headZ)) {
      /* Position puts the triangle at a lamp cluster; the TEXEL decides if
         it is actually lens. Without this the whole smoked housing glowed
         and the rears read as one red smear from 20 m out. */
      const [r, g, bl] = texel(uc, vc);
      if (c[2] < tailZ) {
        if (r > 60 && r > g * 1.35 && r > bl * 1.2) kind = 2;
      } else if (r > 110 && g > 100 && bl > 90) kind = 1;
    }
    t.lamp = kind;
    if (kind) {
      const side = lampSum[kind === 1 ? "head" : "tail"][c[0] < 0 ? 0 : 1];
      side.x += c[0]; side.y += c[1]; side.z += c[2]; side.n++;
    }
  }
  /* The fallback below is a blind guess and it has shipped two wrong lamps:
     the suv's tail landed 0.24 m under its lenses and the bus's landed 0.08 m
     INSIDE the rear panel, where the depth test ate the glow sprite whole.
     Both are corrected by the measured TAIL_FIX table in game/npcmodels.ts —
     if this finder is ever taught to see those two lens clusters, retire that
     entry rather than leaving the two corrections stacked. */
  const pair = (k, fallbackY, fallbackZ) => {
    const s = lampSum[k];
    if (s[0].n > 3 && s[1].n > 3)
      return [
        [s[0].x / s[0].n, s[0].y / s[0].n, s[0].z / s[0].n],
        [s[1].x / s[1].n, s[1].y / s[1].n, s[1].z / s[1].n],
      ];
    return [
      [-cfg.W * 0.34, fallbackY, fallbackZ],
      [cfg.W * 0.34, fallbackY, fallbackZ],
    ];
  };
  const lamps = {
    head: pair("head", cfg.H * 0.42, cfg.L * 0.49),
    tail: pair("tail", cfg.H * 0.45, -cfg.L * 0.47),
    flashR: cfg.flashR ? [cfg.flashR[0] * cfg.W, cfg.flashR[1] * cfg.H, cfg.flashR[2] * cfg.L] : null,
    flashB: cfg.flashB ? [cfg.flashB[0] * cfg.W, cfg.flashB[1] * cfg.H, cfg.flashB[2] * cfg.L] : null,
  };

  /* Flatten to the writer's soup arrays. */
  const nv = tris.length * 3;
  const position = new Float32Array(nv * 3);
  const normal = new Float32Array(nv * 3);
  const texcoord = new Float32Array(nv * 2);
  const color = new Float32Array(nv * 3);
  const paintable = new Float32Array(nv);
  const lampKind = new Float32Array(nv);
  const crease = faceNormalsSmoothed(tris);
  tris.forEach((t, i) => {
    for (let e = 0; e < 3; e++) {
      const o = (i * 3 + e) * 3;
      position.set(t.p[e], o);
      normal.set(t.n && t.n[e] ? t.n[e] : crease[i][e], o);
      texcoord[(i * 3 + e) * 2] = t.uv[e][0];
      texcoord[(i * 3 + e) * 2 + 1] = t.uv[e][1]; // already top-down glTF v
      /* COLOR_0 carries the baked AO (lamps exempt — a lens must not dim
         its own emissive). The NPC material multiplies vertex colour into
         the albedo, so this shades wells, grilles and shutlines for free. */
      const ao = t.lamp ? 1 : t.aoV ? t.aoV[e] : t.ao ?? 1;
      color[(i * 3 + e) * 3] = ao;
      color[(i * 3 + e) * 3 + 1] = ao;
      color[(i * 3 + e) * 3 + 2] = ao;
      paintable[i * 3 + e] = t.paint || 0;
      lampKind[i * 3 + e] = t.lamp || 0;
    }
  });
  const extras = {
    style,
    dims: { L: cfg.L, W: cfg.W, H: cfg.H },
    lamps,
    wheels: fittedWheels,
    source: cfg.source
      ?? (cfg.kind === "hero"
        ? "ItsDiyor on Sketchfab (CC-BY 4.0) — see ATTRIBUTIONS.md"
        : "Generic civil service vehicles pack by comrade1280 (CC-BY 4.0)"),
  };
  if (mint) {
    const tagged = tris.filter((t) => t.lamp).length;
    console.log(`  lamp mask: ${tris.filter((t) => t.lamp === 2).length} tail tris, ` +
      `${tris.filter((t) => t.lamp === 1).length} head tris (${tagged} of ${tris.length})`);
  }
  const result = writeGlb(path.join(OUT, `${style}.glb`), {
    position, normal, texcoord, color, paintable, lampKind,
    image: albedoJpg, mrImage: mrJpg, extras,
  });
  console.log(
    `${style.padEnd(8)} ${(HD ? "HD " : "BASE")} src ${String(beforeCull + removed).padStart(6)} → cull ${String(afterCull).padStart(6)} → ${String(result.tris).padStart(5)} tris  ` +
    `${String(result.verts).padStart(5)} verts  wheels ${fittedWheels.length}  ${(result.bytes / 1024).toFixed(0)} KB`
  );
}

fs.mkdirSync(OUT, { recursive: true });
/* --mint and --dl no longer contend for a slot: the owner's call (2026-09-06)
   was to keep the ItsDiyor `hybrid` AND add the Mint shell beside it, so the
   Mint table writes `mhybrid` and the two tables no longer share a key. */
const table = MINT ? MINT_STYLES : STYLES;
const todo = Object.entries(table).filter(([s]) => !ONLY.length || ONLY.includes(s));
if (!todo.length) {
  console.error(`no styles to build (have: ${Object.keys(table).join(", ")})`);
  process.exit(1);
}
for (const [style, cfg] of todo) await build(style, cfg);
