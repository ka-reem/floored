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

/* ---- seating a glow anchor on the car's own rear skin ---------------------
   A style with no lit lens at all carries its whole taillight on the glow
   sprite (see HALO in traffic.ts), so for those styles the anchor IS the lamp
   and it has to be somewhere the camera can actually see.

   It often is not. The bake falls back to a blind `[±W*0.34, H*0.45, -L*0.47]`
   whenever its lens finder comes up short (tools/build-hifi-models.mjs,
   `pair`), and that guess is made from the bounding box without ever asking
   where the bodywork is — so it lands inside the tail on one car and out in
   the air beside it on another. Measured off the shipped GLBs by
   test/tail-audit-glb.mjs:

     van    anchor |x| 0.748, but the rear panel at lamp height stops at
            0.710 — the lamp hangs 3.8 cm OUTBOARD of the van, in mid-air
     truck  anchor |x| 0.840 against a panel reaching 0.766: 7.4 cm outboard
     osedan anchor 0.8 cm IN FRONT of its own rear skin, i.e. inside the boot
     ohybrid grazing it at 0.1 cm, which the depth test rounds either way

   Why that matters rather than being a cosmetic offset: the halo and sprite
   clouds are depthWrite:false but still depth-TESTED (traffic.ts mkCloud), and
   a Points sprite carries ONE depth for its whole quad. An anchor inside the
   bodywork has its entire glow discarded by the car's own rear panel — which
   is exactly the "very dim or inside the bus" the owner reported — and an
   anchor floating outboard draws a taillight that is visibly not attached to
   the car.

   So the anchor is seated on the shell the car actually has: cast a ray up +z
   through it to find the rear skin directly over it, walk inboard if the ray
   misses the body altogether, and push it just proud of that skin. Everything
   comes from the GLB's own geometry, so unlike a TAIL_FIX row there is no
   hand-measured number here to go stale when a shell is re-baked.

   Deliberately conservative in two ways. It only ever moves an anchor
   BACKWARDS (`Math.min` on z), so a style whose anchor already clears its skin
   is left exactly as it is — on today's fleet that is suv, bus, police,
   ocompact and osuv, none of which move. And it runs only for styles that end
   up with no lit lens geometry, because where a lens does light up the anchor
   is positioning a halo AROUND that lens and belongs on it, not behind it. */

/** How far behind the rear skin a moved anchor is seated — the same 3-4 cm
    TAIL_FIX's two rows were hand-fitted to, which is enough for the additive
    glow to read as light on the lens without the panel clipping it. */
const ANCHOR_PROUD = 0.035;
/** How far inboard the search may walk to find bodywork under an anchor that
    is hanging off the side of the car, and in what steps. Capped: past this
    the anchor would be somewhere the lamp plainly is not, and leaving it alone
    is more honest than moving it into the middle of the tailgate. */
const ANCHOR_WALK = 0.30, ANCHOR_STEP = 0.02;

/** Rear-most point at which a ray straight up +z through (x, y) pierces the
    shell, or null if it misses the body entirely there.

    A 2-D point-in-triangle test in the xy plane and then the plane's z — the
    ray is axis-aligned, so there is nothing to normalise. Read through the
    attribute accessors, never `.array`: these bakes ship interleaved buffers
    (the same trap `extract` documents for the lamp tags). */
function rearSkinAt(geo: THREE.BufferGeometry, x: number, y: number): number | null {
  const pos = geo.attributes.position as AnyAttr;
  const idx = geo.index;
  const triN = idx ? idx.count / 3 : pos.count / 3;
  let best: number | null = null;
  for (let t = 0; t < triN; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const ax = pos.getX(i0), ay = pos.getY(i0);
    const bx = pos.getX(i1), by = pos.getY(i1);
    const cx = pos.getX(i2), cy = pos.getY(i2);
    if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx)) continue;
    if (y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue; // edge-on to the ray
    const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < 0 || l1 < 0 || l2 < 0) continue;
    const z = l0 * pos.getZ(i0) + l1 * pos.getZ(i1) + l2 * pos.getZ(i2);
    if (best === null || z < best) best = z;
  }
  return best;
}

/** Seat both tail anchors of a lensless style just proud of its rear skin.
    Returns a new pair; anchors it cannot improve are passed through unchanged. */
function seatTailAnchors(geo: THREE.BufferGeometry, tail: [Vec3, Vec3]): [Vec3, Vec3] {
  const seat = (a: Vec3): Vec3 => {
    const [x0, y, z] = a;
    let x = x0, hit = rearSkinAt(geo, x, y);
    // hanging off the side of the car: walk in toward the centreline
    for (let d = ANCHOR_STEP; hit === null && d <= ANCHOR_WALK; d += ANCHOR_STEP) {
      x = x0 - Math.sign(x0) * d;
      hit = rearSkinAt(geo, x, y);
    }
    if (hit === null) return a; // nothing under it anywhere; leave it be
    // only ever move it further back, never forward into the bodywork
    return [x, y, Math.min(z, hit - ANCHOR_PROUD)];
  };
  return [seat(tail[0]), seat(tail[1])];
}

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
  /* Still no lit lens: the glow sprite IS this car's taillight, so its anchor
     has to be on the car and visible from behind. See seatTailAnchors — it
     only ever moves an anchor that is buried in the bodywork or hanging off
     the side of it, and it reads the answer off this shell's own geometry
     rather than from another hand-measured table. */
  if (!hasTailGeo && lamps.tail) lamps.tail = seatTailAnchors(geo, lamps.tail);
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
