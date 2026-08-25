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
  /* The asset is meshopt-encoded (0.5 MB against 4.9 MB quantized-only). The
     decoder is a bundled JS+wasm module, not a file to serve — unlike draco,
     which is why the build was re-encoded rather than shipped as-is. */
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
     not survive gracefully — but it is what keeps the silhouette inside the
     collision half-extents the physics already uses, and at chase distance
     the 12% height squash reads as a lower roofline rather than as an error.

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
  scene.position.set(-mid.x * sx, 0, -mid.z * sz);

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
  /* Lands OFF. The procedural body is the one the game ships, and a 0.5 MB
     fetch completing mid-drive is not a reason to change the car under the
     player — the key toggle is. */
  setActive(false);

  return { group: scene, setActive };
}
