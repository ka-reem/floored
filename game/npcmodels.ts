import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/* Real bodyshells for the NPC fleet.

   public/models/cars/<style>.glb holds one merged, indexed body mesh per
   traffic style, baked by tools/build-orchids-models.mjs from the CC-BY
   Orchids Simulator Traffic Car Pack (see ATTRIBUTIONS.md). They are baked
   into exactly the conventions traffic.ts renders with, so a loaded model
   drops into the existing InstancedMesh with no reshaping at runtime:

   - +Z forward, origin on the ground between the wheels, already scaled to
     that style's L/W/H from the tables in traffic.ts;
   - a baked `color` per vertex plus the `paintable` mask the NPC shader
     reads. The Orchids bakes keep their authored paint and carry small
     base-colour (and usually metallic-roughness) textures, so their
     paintable mask is zero — per-instance colour on these bodies comes from
     traffic.ts's PAINT_TINT recolour of the texture instead;
   - no wheels — traffic.ts instances one wheel across the whole fleet — but
     the arches' centres and radii ride along in `wheels` so those shared
     wheels land where the bodywork expects them;
   - lamp cluster centroids in `lamps`, so the light sprites sit on the actual
     lamps instead of at a guessed offset from the bumper.

   Loading is per style and never throws: traffic.ts holds a style out of the
   spawn rotation until its model lands (there is no procedural fallback body
   any more — an unloaded style is simply absent), so a missing or corrupt
   file thins the roster rather than putting a placeholder on the road. */

export type Vec3 = [number, number, number];

export interface NpcLamps {
  /** [-x side, +x side] in body-local metres; the lateral sign matches the
      `so` convention traffic.ts already uses for wheels and signals */
  head: [Vec3, Vec3] | null;
  tail: [Vec3, Vec3] | null;
  flashR: Vec3 | null;
  flashB: Vec3 | null;
}

export interface NpcWheel { x: number; y: number; z: number; r: number }

export interface NpcModel {
  style: string;
  /** position / normal / color / paintable — ready to hand to an InstancedMesh */
  geo: THREE.BufferGeometry;
  /** Optional per-style detail texture loaded from the model's material. */
  map: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  lamps: NpcLamps;
  wheels: NpcWheel[];
  /** the bake tagged real lens geometry — split per lamp kind, because a
      bake can find headlight pixels yet miss smoked tail lenses (the
      Fortuner did exactly that and drove around with no tail lights): a
      kind with no tagged pixels must keep its glow sprite at every range */
  hasHeadGeo: boolean;
  hasTailGeo: boolean;
}

const BASE = "/models/cars/";

/* ---- runtime tail lenses -------------------------------------------------
   Not every bake tags real tail-lens pixels in `_LAMP` — the whole old
   (Orchids) fleet ships zeros, and even two hi-fi bakes (suv, bus) missed
   their smoked lenses. The owner's call: every car shows REAL illuminated
   taillights, not round glow blobs. So a model that arrives without tail
   tags gets a pair of small lens quads authored here at load time: placed
   on the bake's own `extras.lamps.tail` anchors, pushed out to the actual
   rear surface (found by scanning the body's vertices around the anchor, so
   a stale anchor can never bury the lens inside the bodywork), and tagged
   `lampKind = LENS_KIND`. The NPC shader gives that kind an authored
   dark-red lens albedo and the same per-instance tail/brake emissive levels
   the baked lenses use, so running/brake behaviour is identical across the
   fleet — and the glow sprites retire near-range for every style. */

/** lampKind for a runtime-authored lens quad. The NPC shader (traffic.ts,
    npcShader) keys its albedo/roughness override on the 3.5..4.5 band — keep
    in sync. */
export const LENS_KIND = 4;

/** lampKind for "this is rear bodywork that PAINTS its own tail lens": the
    shader lights only the texels there that test as lens red, so the lit
    shape is the car's own artwork rather than a quad laid over it.
    Keyed on `> 4.5` in npcShader. */
export const SKIN_KIND = 5;

/* ---- the car's own painted lens ------------------------------------------
   The owner, on the authored quads: "u cant just overlay the taillight
   rectangles over the actual red taillights ... shaped to the cars tailights
   properly". Right — where the bake HAS a lamp, the lamp should be the thing
   that lights up.

   Whether it has one is a question about the texture, not the geometry, and
   these bakes are low-poly: the lens is a few square centimetres of artwork
   on a large flat panel, so no amount of per-triangle tagging can find its
   shape. What can is a per-PIXEL test in the fragment shader — and then the
   only thing decided here is which styles have a lens worth testing for.

   That was measured offline over every bake (scratchpad probe: decode the
   GLB's own base texture, sample the rear-facing triangles densely, and
   report the share of the rear panel that reads as saturated red):

     ohybrid 4.6%   osedan 3.3%   taxi 1.1%     <- two-sided, real clusters
     van 1.1%       ocompact 0.4%  osuv 1.0%    <- ONE side only
     truck 0.1%     police 0.0%    suv/bus 0.0% <- no red lamp in the bake

   A one-sided hit means the other lamp simply is not red in that texture, and
   lighting it would give the car a single taillight — worse than the quad. So
   ohybrid, osedan and taxi went to a render, and only the taxi survived it:
   the osedan carries a red trim strip across its tailgate and around the rear
   glass, which passes the same test the lens does and lit up the whole back
   of the car. The measurement says "there is red here", not "the red is the
   lamp" — that part only a frame can tell you, so a style earns its place in
   this set by being LOOKED at, not by its percentage.

   Everything else keeps the authored quads: smoked, dark or unpainted lens
   artwork gives the per-pixel test nothing to find.

   (sedan/compact/hybrid are not in this list because they need nothing: the
   hi-fi bakes already tag their real lens pixels in `_LAMP`. That hand tag is
   what the rest of the fleet is really missing, and baking one per style is
   the honest fix here — this is the part of it that can be had for free.) */
const TEX_LENS = new Set(["taxi"]);
/** how far forward of the rear-most vertex the lens artwork can reach, and how
    far off rearward a normal may point (the wrap onto the rear quarter). Both
    kept tight: past this the same red test starts finding body paint. */
const SKIN_DEPTH = 0.40, SKIN_NZ = 0.30, SKIN_YBAND = 0.55;

/** Flag the rear bodywork of a style whose own texture paints its tail lens.
    Returns false (and changes nothing) if the gate found no vertices, so the
    caller can fall back to the authored quads. */
function tagTexturedTailSkin(
  geo: THREE.BufferGeometry,
  tail: [Vec3, Vec3]
): boolean {
  const pos = geo.attributes.position as AnyAttr;
  const nor = geo.attributes.normal as AnyAttr;
  const n = pos.count;
  let zMin = Infinity;
  for (let i = 0; i < n; i++) zMin = Math.min(zMin, pos.getZ(i));
  const yMid = (tail[0][1] + tail[1][1]) / 2;
  const out = new Float32Array(n);
  let tagged = 0;
  for (let i = 0; i < n; i++) {
    if (pos.getZ(i) > zMin + SKIN_DEPTH) continue;
    if (nor.getZ(i) > SKIN_NZ) continue;
    if (Math.abs(pos.getY(i) - yMid) > SKIN_YBAND) continue;
    out[i] = SKIN_KIND;
    tagged++;
  }
  if (!tagged) return false;
  geo.setAttribute("lampKind", new THREE.BufferAttribute(out, 1));
  return true;
}

type LensSpec = { w: number; h: number; wrap: number };
/** Rear-quad width/height plus the width of the wrap-around wing that carries
    the lamp into rear-quarter views (chase camera). Metres, per style; sizes
    read off each style's rear render. `wrap: 0` for the flat-backed boxes.

    Aspect is deliberate, not just size: the first pass sat near 2.4:1, which
    with the halo skirt on top read as a rounded square block on the tailgate
    ("looks weird/cheap with those squares"). Every horizontal lamp is now
    ~4:1 — a real car's tail lamp is a wide, shallow bar, and the shape is
    what the eye names the lamp by once the glow around it stops covering it
    (see HALO in traffic.ts, sized down in the same change). The vertical
    van/bus clusters go the other way for the same reason: narrower, so they
    read as door-edge columns rather than squares. */
const LENS_DEFAULT: LensSpec = { w: 0.40, h: 0.095, wrap: 0.09 };
const TAIL_LENS: Record<string, Partial<LensSpec>> = {
  suv:   { w: 0.44, h: 0.105 },
  osuv:  { w: 0.42, h: 0.10 },
  van:   { w: 0.11, h: 0.32, wrap: 0 }, // vertical door-edge clusters
  bus:   { w: 0.12, h: 0.34, wrap: 0 },
  truck: { w: 0.36, h: 0.085, wrap: 0 }, // bumper-bar lamps
};

/** Unlit look of a synthetic lens for renderers that honour vertex colour but
    not the NPC shader override (the offline render tools): dark red plastic.
    In game the shader's authored albedo wins — see npcShader. */
const LENS_COL: Vec3 = [0.3, 0.02, 0.03];

/** Read one channel of a (possibly interleaved) attribute safely. */
type AnyAttr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

/** Append two tail-lens quads (plus wrap wings) to `geo`, one per anchor.
    Returns a fresh, de-interleaved geometry; `geo`'s arrays are not shared. */
function withTailLenses(
  geo: THREE.BufferGeometry,
  style: string,
  tail: [Vec3, Vec3]
): THREE.BufferGeometry {
  const spec = { ...LENS_DEFAULT, ...TAIL_LENS[style] };
  const pos = geo.attributes.position as AnyAttr;
  const n = pos.count;

  /* The rear surface at each lamp: rear-most vertex (min z) inside a window
     around the anchor, so the quad sits just proud of the fascia whatever
     the anchor's own depth says (the bus anchor, for one, floats 28 cm
     inside the body). */
  const faceZ = tail.map((a) => {
    const wx = Math.max(0.3, spec.w), wy = Math.max(0.22, spec.h);
    let zMin = Infinity;
    for (let i = 0; i < n; i++) {
      if (Math.abs(pos.getX(i) - a[0]) > wx) continue;
      if (Math.abs(pos.getY(i) - a[1]) > wy) continue;
      const z = pos.getZ(i);
      if (z < 0 && z < zMin) zMin = z;
    }
    return (isFinite(zMin) ? zMin : a[2]) - 0.02;
  });

  /* How far the body actually extends outboard of each lamp, measured on the
     rear panel itself (vertices within 35 cm of the lens plane, in a band
     around the lamp's own height). A fixed metre width is wrong here: the
     owner's complaint that the lamp "doesn't match the body line" is a quad
     that runs past the corner of a narrow car and floats in open air, and the
     bakes span a kei van and a coach. So the authored width is a CEILING and
     the silhouette is the limit — the quad shrinks to sit inside the panel,
     with a 3 cm inset so it never touches the edge. */
  const LENS_INSET = 0.03;
  const bodyOuter = tail.map((a, li) => {
    const s = li === 0 ? -1 : 1;
    let far = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(pos.getZ(i) - faceZ[li]) > 0.35) continue;
      if (Math.abs(pos.getY(i) - a[1]) > 0.30) continue;
      const x = pos.getX(i) * s; // outboard-positive, whichever side
      if (x > far) far = x;
    }
    return far;
  });

  const V: number[] = [], NR: number[] = [], IX: number[] = [];
  let vn = 0;
  const quad = (
    c: [number, number, number][], nx: number, ny: number, nz: number, flip: boolean
  ) => {
    for (const p of c) { V.push(p[0], p[1], p[2]); NR.push(nx, ny, nz); }
    if (flip) IX.push(vn, 2 + vn, 1 + vn, vn, 3 + vn, 2 + vn);
    else IX.push(vn, 1 + vn, 2 + vn, vn, 2 + vn, 3 + vn);
    vn += 4;
  };
  for (let li = 0; li < 2; li++) {
    const [ax, ay] = tail[li];
    const z = faceZ[li], s = li === 0 ? -1 : 1;
    /* Fit the authored width inside the panel (bodyOuter): the room from the
       anchor out to the silhouette sets the half-width, and the quad keeps its
       anchor centred rather than sliding inboard. Floored at 55% of the
       authored width so a bake with a stray outlying vertex — or an anchor
       sitting right on the corner — still gets a lamp rather than a sliver;
       a measurement that found nothing leaves the width alone. */
    const room = bodyOuter[li] - Math.abs(ax) - LENS_INSET;
    const w = bodyOuter[li] > 0
      ? Math.max(spec.w * 0.55, Math.min(spec.w, room * 2))
      : spec.w;
    const wrapW = spec.wrap * (w / spec.w); // the wing narrows with the lens
    const x0 = ax - w / 2, x1 = ax + w / 2;
    const y0 = ay - spec.h / 2, y1 = ay + spec.h / 2;
    // rear face, normal -z (order chosen for a -z front face; the NPC
    // material is DoubleSide, so this only matters to offline tools)
    quad([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], 0, 0, -1, true);
    if (wrapW > 0) {
      // wrap wing: carries the lens around the corner for rear-quarter views
      const xe = s > 0 ? x1 : x0;
      const xo = xe + s * wrapW * 0.62, zo = z + wrapW * 0.78;
      quad(
        [[xe, y0, z], [xe, y1, z], [xo, y1, zo], [xo, y0, zo]],
        s * 0.78, 0, -0.62, s < 0
      );
    }
  }

  /* Rebuild every attribute as a tight planar array (the Orchids bakes ship
     interleaved buffers) with the lens vertices appended. */
  const total = n + vn;
  const read = (a: AnyAttr | undefined, size: number, fill: number[]) => {
    const out = new Float32Array(total * size);
    if (a) for (let i = 0; i < n; i++) {
      if (size > 0) out[i * size] = a.getX(i);
      if (size > 1) out[i * size + 1] = a.getY(i);
      if (size > 2) out[i * size + 2] = a.getZ(i);
    }
    for (let i = 0; i < vn; i++)
      for (let c = 0; c < size; c++) out[(n + i) * size + c] = fill[c] ?? 0;
    return out;
  };
  const posOut = read(pos, 3, []);
  const norOut = read(geo.attributes.normal as AnyAttr, 3, []);
  const colOut = read(geo.attributes.color as AnyAttr, 3, [...LENS_COL]);
  const pntOut = read(geo.attributes.paintable as AnyAttr, 1, [0]);
  const lmpOut = read(geo.attributes.lampKind as AnyAttr, 1, [LENS_KIND]);
  const uvAttr = geo.attributes.uv as AnyAttr | undefined;
  for (let i = 0; i < vn; i++) {
    posOut.set(V.slice(i * 3, i * 3 + 3), (n + i) * 3);
    norOut.set(NR.slice(i * 3, i * 3 + 3), (n + i) * 3);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(posOut, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(norOut, 3));
  out.setAttribute("color", new THREE.BufferAttribute(colOut, 3));
  out.setAttribute("paintable", new THREE.BufferAttribute(pntOut, 1));
  out.setAttribute("lampKind", new THREE.BufferAttribute(lmpOut, 1));
  if (uvAttr) out.setAttribute("uv", new THREE.BufferAttribute(read(uvAttr, 2, [0.5, 0.5]), 2));
  const idx: number[] = [];
  if (geo.index) {
    const src = geo.index;
    for (let i = 0; i < src.count; i++) idx.push(src.getX(i));
  } else for (let i = 0; i < n; i++) idx.push(i);
  for (const i of IX) idx.push(n + i);
  out.setIndex(idx);
  return out;
}

/** Highest wheel count any single model may contribute, so traffic.ts can size
    its shared wheel buffer before it knows what the models hold. */
export const MAX_WHEELS = 6;

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && isFinite(n));
}

function readLamps(src: any): NpcLamps {
  const pair = (v: unknown): [Vec3, Vec3] | null =>
    Array.isArray(v) && v.length === 2 && isVec3(v[0]) && isVec3(v[1])
      ? // keep the -x anchor first; traffic.ts indexes this pair by lateral sign
        (v[0][0] <= v[1][0] ? [v[0], v[1]] : [v[1], v[0]])
      : null;
  const one = (v: unknown): Vec3 | null => (isVec3(v) ? v : null);
  return {
    head: pair(src?.head),
    tail: pair(src?.tail),
    flashR: one(src?.flashR),
    flashB: one(src?.flashB),
  };
}

function readWheels(src: unknown): NpcWheel[] {
  if (!Array.isArray(src)) return [];
  const out: NpcWheel[] = [];
  for (const w of src) {
    if (!w || ![w.x, w.y, w.z, w.r].every((n) => typeof n === "number" && isFinite(n))) continue;
    if (w.r <= 0) continue;
    out.push({ x: w.x, y: w.y, z: w.z, r: w.r });
    if (out.length === MAX_WHEELS) break;
  }
  return out;
}

/** Pull the single body mesh out of a loaded GLB and rename its attributes to
    what the NPC shader binds to. Returns null if the file isn't one of ours. */
function extract(style: string, gltf: { scene: THREE.Object3D }): NpcModel | null {
  let mesh: THREE.Mesh | null = null;
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !mesh) mesh = o as THREE.Mesh;
  });
  if (!mesh) return null;
  const src = (mesh as THREE.Mesh).geometry;
  if (!src?.attributes.position || !src.attributes.normal) return null;

  /* GLTFLoader lowercases attributes it doesn't know, so _PAINTABLE arrives as
     `_paintable`; COLOR_0 arrives as `color`. Build a fresh geometry holding
     only what the shader wants, rather than dragging along whatever else a
     re-export might have added. */
  const paint = src.attributes._paintable ?? src.attributes.paintable;
  const color = src.attributes.color;
  if (!paint || !color) return null;
  const lamp = src.attributes._lamp ?? src.attributes.lampKind;

  let geo = new THREE.BufferGeometry();
  geo.setAttribute("position", src.attributes.position);
  geo.setAttribute("normal", src.attributes.normal);
  geo.setAttribute("color", color);
  geo.setAttribute("paintable", paint);
  if (src.attributes.uv) geo.setAttribute("uv", src.attributes.uv);
  /* Which lamp each vertex belongs to (1 head, 2 tail, 0 none). An older model
     file without it still works — the shader reads 0 and simply emits nothing,
     leaving that style's lamps to the glow sprites alone. */
  geo.setAttribute(
    "lampKind",
    lamp ?? new THREE.BufferAttribute(new Float32Array(src.attributes.position.count), 1)
  );
  let hasHeadGeo = false, hasTailGeo = false;
  if (lamp) {
    /* Read via getX, never `.array`: the Orchids bakes ship interleaved
       buffers, where `.array` is the whole mixed position/normal/uv buffer.
       Scanning that raw found values > 1.5 in every file — position floats,
       not lamp tags — so all eight untagged styles claimed lens geometry
       they didn't have, traffic.ts retired their tail sprites inside 70 m,
       and most of the fleet drove around with dark rears. */
    for (let i = 0; i < lamp.count && !(hasHeadGeo && hasTailGeo); i++) {
      const v = lamp.getX(i);
      if (v > 1.5) hasTailGeo = true;
      else if (v > 0.5) hasHeadGeo = true;
    }
  }
  if (src.index) geo.setIndex(src.index);

  const extras: any = (gltf.scene.userData as any) ?? {};
  const lamps = readLamps(extras.lamps);
  if (!hasTailGeo && lamps.tail) {
    /* No baked tail lenses. Two ways to get one, and the first is always
       better because it is the car's own artwork rather than a shape laid
       over it: flag the rear panel and let the shader light the lens texels
       (TEX_LENS), or, where the bake paints no lens to find, author quads
       (withTailLenses). Either way report tail geometry as present, so the
       glow sprites retire near-range for this style exactly like the tagged
       bakes. */
    if (!(TEX_LENS.has(style) && tagTexturedTailSkin(geo, lamps.tail)))
      geo = withTailLenses(geo, style, lamps.tail);
    hasTailGeo = true;
  }
  geo.computeBoundingSphere();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const material = materials.length === 1
    ? materials[0] as THREE.MeshStandardMaterial
    : null;
  return {
    style,
    geo,
    map: material?.map ?? null,
    roughnessMap: material?.roughnessMap ?? null,
    metalnessMap: material?.metalnessMap ?? null,
    lamps,
    wheels: readWheels(extras.wheels),
    hasHeadGeo,
    hasTailGeo,
  };
}

/** The styles a desktop-only HD variant is baked for (1024px atlas, gentler
    decimation) — tools/build-hifi-models.mjs --hd writes exactly these. */
export const HD_STYLES = ["sedan", "hybrid", "compact", "suv"]; // the ItsDiyor modern heroes (owner's final call)
export const HD_BASE = "/models/cars-hd/";

/** Load a bodyshell per style, calling `onModel` as each one lands. Never
    rejects and never throws: a style whose file is missing or malformed is
    simply skipped, and its caller keeps the procedural shell it started with.
    The returned promise settles when every style has been tried. `base`
    selects the fleet directory — the default ships to everyone, HD_BASE is
    the desktop upgrade streamed in after the drive has started. */
export function loadNpcModels(
  styles: string[],
  onModel: (m: NpcModel) => void,
  base: string = BASE
): Promise<void> {
  const loader = new GLTFLoader();
  return Promise.all(
    styles.map(
      (style) =>
        new Promise<void>((resolve) => {
          try {
            loader.load(
              `${base}${style}.glb`,
              (gltf) => {
                try {
                  const m = extract(style, gltf as unknown as { scene: THREE.Object3D });
                  if (m) onModel(m);
                } catch {
                  /* a bad model must never take the fleet down */
                }
                resolve();
              },
              undefined,
              () => resolve()
            );
          } catch {
            // loader.load() itself can throw synchronously (e.g. a relative
            // URL with no resolvable base) rather than routing through the
            // onError callback — catch that too, or this promise (and the
            // Promise.all() above it) rejects, breaking the "never rejects"
            // contract this function documents.
            resolve();
          }
        })
    )
  ).then(() => undefined);
}
