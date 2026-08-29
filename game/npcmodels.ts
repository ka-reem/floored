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
  /** the bake tagged real lens geometry (_LAMP has nonzero entries) — the
      runtime can then let the shaped emissive lenses carry the light up
      close instead of the round glow sprites */
  hasLampGeo: boolean;
}

const BASE = "/models/cars/";

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

  const geo = new THREE.BufferGeometry();
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
  let hasLampGeo = false;
  if (lamp) {
    const la = lamp.array as ArrayLike<number>;
    for (let i = 0; i < la.length; i++)
      if (la[i] > 0) { hasLampGeo = true; break; }
  }
  if (src.index) geo.setIndex(src.index);
  geo.computeBoundingSphere();

  const extras: any = (gltf.scene.userData as any) ?? {};
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
    lamps: readLamps(extras.lamps),
    wheels: readWheels(extras.wheels),
    hasLampGeo,
  };
}

/** The styles a desktop-only HD variant is baked for (1024px atlas, gentler
    decimation) — tools/build-hifi-models.mjs --hd writes exactly these. */
export const HD_STYLES = ["sedan", "compact", "suv"]; // owner-picked hero bakes (hybrid pending its Draco-donor rebake)
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
