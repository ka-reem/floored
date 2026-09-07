import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { ShellParams } from "./carspecs";

/* Swaps an imported exterior body in over the procedural one.

   Same shape, and the same rule, as cockpitmodel.ts: the procedural body
   (player.ts) is always built and is always what is on screen until this
   lands. If the GLB 404s or fails to parse, nothing happens and the player
   keeps a car. A body asset that can go missing must never be able to leave
   the player driving an invisible one.

   Deliberately much simpler than the dash import. Nothing here is rebound to
   anything live: the donor is a static shell, its wheels were stripped at
   build time and the game's own wheels stay on show (they steer and spin,
   which is the whole reason to keep them). The lamps are the procedural
   emissive boxes' job either way — the donor's headlight geometry is inert.

   The group parents INSIDE exteriorG rather than beside it, which is what
   keeps the camera rule honest for free: engine.ts hides exteriorG whenever
   the view is inside the car (COCKPIT and the shipping POV), and a child
   inherits that without this module knowing the rule exists. */

export interface BodyModelHandle {
  /** The donor's root, already parented into the exterior group. */
  group: THREE.Group;
  /** Put the procedural body back. Nothing is disposed either way, so this is
      an A/B toggle rather than a teardown. */
  setActive(on: boolean): void;
}

const BASE = "/models/player/";
/** Where a donor exterior lives. Exported so game/prefetch.ts names the same
    URL this module will ask for rather than keeping a second copy of it. */
export const bodyModelUrl = (name: string): string => `${BASE}${name}.glb`;

export function attachBodyModel(
  exteriorG: THREE.Group,
  shell: ShellParams,
  name: string,
  /** Procedural children that stay on show under the donor — the wheels (the
      donor has none) and the lamp glow sprites. */
  keep: THREE.Object3D[],
  onDone?: (h: BodyModelHandle | null) => void,
): void {
  /* Snapshot before the donor is added, so the donor itself is never in the
      list of things to hide when it is the one being shown. */
  const keepSet = new Set(keep);
  const procedural = exteriorG.children.filter((c) => !keepSet.has(c));

  const loader = new GLTFLoader();
  /* The asset is meshopt-encoded (1.4 MB — the first build of it measured
     0.5 MB meshopt against 4.9 MB quantize-only, and the ratio is why this
     encoding is worth a decoder at all). The decoder is a bundled JS+wasm
     module, not a file to serve — unlike draco, which is why the build was
     re-encoded rather than shipped as-is. */
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(
    `${BASE}${name}.glb`,
    (gltf) => {
      try {
        onDone?.(fit(exteriorG, gltf.scene, shell, procedural));
      } catch (e) {
        console.warn(`[bodymodel] ${name}: wiring failed — keeping the procedural body`, e);
        onDone?.(null);
      }
    },
    undefined,
    (e) => {
      console.warn(`[bodymodel] ${name}: model failed to load — keeping the procedural body`, e);
      onDone?.(null);
    },
  );
}

function fit(
  exteriorG: THREE.Group,
  scene: THREE.Group,
  P: ShellParams,
  procedural: THREE.Object3D[],
): BodyModelHandle {
  /* A real S90 is 4.96 x 2.02 x 1.44 and kaze's shell is 4.42 x 1.84 x 1.24,
     so the donor is fitted to the spec box on each axis independently. Not
     pretty — a non-uniform squash is exactly the thing a real car body does
     not survive gracefully — but it is what keeps the silhouette roughly on
     the collision half-extents the physics already uses, and at chase distance
     the 15% height squash reads as a lower roofline rather than as an error.

     Width goes to W + 0.18, not W: the donor's bbox includes its door mirrors
     (a real S90 is 1.88 across the body and 2.02 across the mirrors), and
     player.ts puts the procedural mirrors at W/2 + 0.09 for the same reason. */
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());
  const sx = (P.W + 0.18) / size.x;
  const sz = P.L / size.z;
  /* Height is scaled about the GROUND, not about the bbox centre: car-local
     y = 0 is the road in both spaces, and the donor's own y = 0 is where its
     (now stripped) tyres met it. Dividing by max.y rather than by size.y is
     what keeps the sills on the deck instead of floating the whole car by
     however much its lowest surviving surface sits above the tarmac. */
  const sy = P.roof / box.max.y;
  scene.scale.set(sx, sy, sz);
  /* Lined up on the AXLES, not on the bbox centre. The game's own wheels stay
     on show under this body (the donor's were stripped), so where the arches
     land is the one alignment anyone will notice — and the S90's 2.94 m
     wheelbase inside a 4.96 m car is not centred the way kaze's 2.70 m inside
     4.42 m is. Centring the boxes leaves the rear wheel 13 cm behind its arch;
     matching the axle midpoints instead splits that to ~5 cm at each end.
     DONOR_AXLE_MID is the midpoint of the donor's front and rear axles in its
     own space, measured from the wheel geometry before it was stripped. The
     trade is 8 cm of tail sitting proud of the collision half-length, which is
     the forgiving direction and only applies while this body is switched on. */
  const DONOR_AXLE_MID = 0.14;
  scene.position.set(-mid.x * sx, 0, (P.wzF - P.wzR) / 2 - DONOR_AXLE_MID * sz);

  for (const o of scene.children) {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
  }

  exteriorG.add(scene);

  const setActive = (on: boolean) => {
    scene.visible = on;
    for (const c of procedural) c.visible = !on;
  };
  /* Lands ON, and the caller immediately re-applies whatever state the J
     toggle is actually in — see player.ts. Both calls happen in the same
     callback, so no frame is ever drawn on a guess. */
  setActive(true);

  return { group: scene, setActive };
}
