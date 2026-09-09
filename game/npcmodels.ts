import * as THREE from "three";
import { buildStamped } from "@/lib/build";
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

/** Where a style's bodyshell lives. Exported so the menu-time prefetch
    (game/prefetch.ts) can name the exact URLs loadNpcModels will ask for
    rather than keeping a second copy of the path. */
export const npcModelUrl = (style: string, base: string = BASE): string =>
  buildStamped(`${base}${style}.glb`);

/* ---- tail lenses ----------------------------------------------------------
   Not every bake tags real tail-lens pixels in `_LAMP` — the whole old
   (Orchids) fleet ships zeros, and even two hi-fi bakes (suv, bus) missed
   their smoked lenses.

   Those styles used to get a pair of lens quads authored here at load time,
   sized in metres off the bake's own anchors. That is gone. However it was
   sized, it was a rectangle laid over a car that already has its taillights
   drawn on it, and it never matched them — the owner, looking at the fifth
   attempt to make one fit: "just remove those rectangles then we don't need
   that ... but keep the light glow."

   So there are exactly two ways a car's lamps light up now, and both of them
   are the car's own: a baked `_LAMP` tag, or (TEX_LENS below) its painted
   lens found per-pixel in the shader. A style with neither shows no lit lens
   at all and carries its lights on the glow alone — see HALO in traffic.ts,
   which is why `hasTailGeo` staying false for those styles matters. */

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

/* ---- measured tail anchors ------------------------------------------------
   The owner: "rav4 tail lights need to be higher so its on the acutal red
   light lamps are. and the bus ltail ights are not bright enoguh theyre very
   idm or inside the bus".

   Both are the SAME defect, and neither is a brightness problem. A hi-fi
   bake finds its lamp anchors from the donor's own lens triangles, but when
   that finder comes up with fewer than four per side it falls back to a blind
   guess — `[±W*0.34, H*0.45, -L*0.47]` (tools/build-hifi-models.mjs, `pair`).
   The suv (Highlander shell — the owner's "rav4") and the bus are the only
   two styles in the fleet running on that fallback, because their lens
   artwork is smoked/unpainted (suv) or missed by the red-texel test (bus).
   And these two are also the styles with no lit lens geometry at ALL, so the
   glow sprite IS their taillight — an anchor in the wrong place is not a
   cosmetic offset here, it is the whole lamp.

   What the fallback gets wrong, measured off the shipped GLBs (rear-facing
   triangles sampled densely; the lens found as the non-paintable cluster on
   the suv, whose atlas paints no lens at all, and as the red texels on the
   bus):

     suv  lens y 0.94..1.14, |x| 0.55..0.79, skin z -2.21
          fallback y 0.805 = H*0.45 on a 1.79 m body -> 0.24 m BELOW the
          lamps, sitting on the bumper step under them. The rest of the
          fleet's anchors measure 0.55..0.74 of H; only the suv and the bus
          read 0.45, which is the fallback's signature.
     bus  lens y 0.94..1.42, |x| ~0.82, skin z -4.50
          fallback z -4.418 is 0.08 m IN FRONT of that skin, i.e. the glow
          point is INSIDE the bodywork. The halo/sprite clouds are
          depthWrite:false but still depth-TESTED (traffic.ts mkCloud), and a
          Points sprite carries one depth for its whole quad, so the bus's own
          rear panel discarded every fragment of it that landed on the bus —
          which is exactly "very dim or inside the bus". Intensity could never
          have fixed that, and per realistic-light it must not be asked to:
          the lamp is occluded, so the anchor moves.

   Values are [ |x|, y, z ], mirrored to the [-x, +x] pair the runtime wants.
   z is set 3-4 cm PROUD of the rear skin at that x/y, so the additive glow
   reads as light on the lens from behind and from the chase camera without
   the panel ever clipping it. Applied at load rather than re-baked because
   the bake's donor shells live in gitignored staging; if they are ever
   re-baked, the finder should be taught these clusters instead. */
const TAIL_FIX: Record<string, [number, number, number]> = {
  suv: [0.676, 1.04, -2.25],
  bus: [0.824, 1.18, -4.54],
};
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

/** Read one channel of a (possibly interleaved) attribute safely. */
type AnyAttr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;


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
  const fix = TAIL_FIX[style];
  if (fix && lamps.tail) lamps.tail = [[-fix[0], fix[1], fix[2]], [fix[0], fix[1], fix[2]]];
  if (!hasTailGeo && lamps.tail && TEX_LENS.has(style)) {
    /* No baked tail lenses, but this bake paints its own: flag the rear panel
       and let the shader light the lens texels (see TEX_LENS). Nothing is
       authored for a style that fails this — it keeps its glow and no lit
       lens, which is the owner's call over a rectangle that doesn't fit. */
    hasTailGeo = tagTexturedTailSkin(geo, lamps.tail);
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
// the ItsDiyor modern heroes, plus the Mint-generated mhybrid that rides
// beside them (owner's call, 2026-09-06: keep the old one AND add this)
export const HD_STYLES = ["sedan", "hybrid", "compact", "suv", "mhybrid"];
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
              npcModelUrl(style, base),
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
