import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Cockpit } from "./cockpit";

/* Swaps an imported dash in over the procedural one.

   The procedural cockpit (cockpit.ts) is always built and is always the
   fallback. This loads a cut-down donor dash produced by
   tools/build-cockpit.mjs, and if it arrives intact it hides the procedural
   dash region and re-anchors the live parts onto the donor's geometry. If the
   fetch fails, the model is missing a role, or the user is on a tier that does
   not want it, nothing happens and the procedural dash stays on screen. That
   fail-soft is the whole reason this is a separate module: a 68 MB asset that
   can 404 must never be able to leave the player without a dashboard.

   Loading is async and deliberately not awaited anywhere. The game starts on
   the procedural dash and the donor pops in a beat later — the same pattern
   world/highway.ts uses for its roadside props.

   What is replaced vs kept:

   - REPLACED  dash pad, binnacle, vents, centre stack, centre console, and
               the head-unit body (cockpit.ts's "dash" merge region).
   - KEPT      door cards, pillars, roof, headliner, seats, glass, mirrors,
               wipers, the droplet overlay, and both light rigs. A donor dash
               is a dash; it does not bring a cabin.
   - MOVED     the instrument cluster (dashboard.ts) and the head-unit canvas
               (carscreen.ts). These stay OURS — they are live, and a donor's
               are painted on — but they relocate onto the donor's binnacle and
               screen so they sit where that car actually puts them. */

/** Roles the build tool tags nodes with. Anything else in the file is ignored. */
interface Manifest {
  source: string;
  parts: Record<string, { name: string; tris: number; bbox: [number[], number[]] }[]>;
  /** Hub and axis of the steering column, measured from the donor's own wheel
      geometry (see build-cockpit.mjs). Absent if the donor has no wheel. */
  steering?: { hub: number[]; axis: number[] };
}

export interface CockpitModelHandle {
  /** The donor's root, already parented into the cockpit. */
  group: THREE.Group;
  /** Put the procedural dash back. Cheap — nothing is disposed either way, so
      this is an A/B toggle, not a teardown. */
  setActive(on: boolean): void;
}

const BASE = "/models/cockpits/";

/** Rotation taking +Z onto `axis`, which is how the donor's raked steering
    column is turned into something the engine's `wheelGroup.rotation.z` can
    drive without the rim wobbling. */
function alignZ(axis: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize());
}

export function attachCockpitModel(
  cockpit: Cockpit,
  name: string,
  onDone?: (h: CockpitModelHandle | null) => void,
): void {
  let manifest: Manifest | null = null;

  const fail = (why: string, err?: unknown) => {
    console.warn(`[cockpitmodel] ${name}: ${why} — keeping the procedural dash`, err ?? "");
    onDone?.(null);
  };

  fetch(`${BASE}${name}.json`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest HTTP ${r.status}`))))
    .then((m: Manifest) => {
      manifest = m;
      new GLTFLoader().load(
        `${BASE}${name}.glb`,
        (gltf) => { try { onDone?.(wire(cockpit, gltf.scene, manifest!)); } catch (e) { fail("wiring failed", e); } },
        undefined,
        (e) => fail("model failed to load", e),
      );
    })
    .catch((e) => fail("manifest failed to load", e));
}

function wire(cockpit: Cockpit, scene: THREE.Group, man: Manifest): CockpitModelHandle {
  /* Look parts up by role, not by node name: node names are the donor's, and
     every donor spells them differently. The manifest is the only place a
     donor-specific string is allowed to appear. */
  const byRole = (role: string): THREE.Object3D[] =>
    (man.parts[role] ?? [])
      .map((p) => scene.getObjectByName(p.name))
      .filter((o): o is THREE.Object3D => !!o);

  const cluster = byRole("cluster")[0];
  const screen = byRole("screen")[0];
  if (!cluster || !screen) {
    /* Name the roles AND what did arrive: the failure this guards against is a
       lookup miss, and "which names does the scene actually have" is the only
       thing that tells you whether the build tool or the loader dropped it. */
    throw new Error(
      `missing role(s): ${[!cluster && "cluster", !screen && "screen"].filter(Boolean).join(", ")}; ` +
      `scene has [${scene.children.map((c) => c.name).join(", ")}]`,
    );
  }

  /* EVERY transform below is computed in cockpit-group-local space, and that
     is load-bearing rather than stylistic.

     The donor scene is attached to cockpit.group at the END of this function.
     Until then its nodes' `matrixWorld` is relative to a detached root — while
     `cockpit.wheelGroup.matrixWorld` is a real world matrix carrying
     cockpit.group's offset and scale, bodyG, and carGroup's world position AND
     heading rotation. Mixing the two yields a transform wrong by wherever the
     car happens to be standing and whichever way it is pointing, which puts
     the rim somewhere near the roof.

     Local space avoids the whole question: build-cockpit.mjs bakes each donor
     node's world matrix into its LOCAL matrix and parents every node straight
     to the scene root, so a donor node's `matrix` already IS its cockpit-local
     matrix. No world matrices are needed here at all. */
  scene.updateMatrixWorld(true);
  for (const c of scene.children) c.updateMatrix();

  /* cockpit.group carries a non-uniform x-scale so the procedural trim can be
     fitted to each car's width. A donor dash is a real object at real
     proportions and cannot absorb that: at the kei car's 1.48/1.84 it would be
     squeezed 20% along one axis only. Counter-scaling y and z to match turns
     the parent's (sx,1,1) into a uniform (sx,sx,sx) — the dash then shrinks
     evenly to suit a smaller car instead of being flattened. */
  const sx = cockpit.group.scale.x;
  scene.scale.set(1, sx, sx);

  /* --- the donor's own screens ------------------------------------------- */

  /* Its cluster is a painted-on picture of gauges, so it goes: ours is live
     and has real needles. Its centre screen stays and takes our nav canvas —
     that one IS just a lit rectangle, which is exactly what a texture is for. */
  cluster.visible = false;
  /* Centre of the donor binnacle in cockpit-local space: the mesh's own
     geometry bounds pushed through its (already cockpit-local) matrix. */
  const clusterMesh = cluster as THREE.Mesh;
  clusterMesh.geometry.computeBoundingBox();
  const clusterAt = clusterMesh.geometry.boundingBox!
    .getCenter(new THREE.Vector3())
    .applyMatrix4(clusterMesh.matrix)
    .multiply(scene.scale);

  for (const m of screen.type === "Mesh" ? [screen as THREE.Mesh] : []) {
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
    mat.map = cockpit.screenTexture;
    /* Same reasoning as the procedural head unit: an LCD is a light source,
       and tone-mapped down it reads as a dead black slab at night. */
    mat.emissiveMap = cockpit.screenTexture;
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveIntensity = 1.15;
    mat.toneMapped = false;
    mat.needsUpdate = true;
  }

  /* --- our live parts, relocated ----------------------------------------- */

  /* The cluster keeps its own orientation (it is built facing the driver) and
     only moves: the donor binnacle's centre is a far better anchor than the
     procedural POD constant, which was fitted to different geometry. */
  const clusterHome = cockpit.clusterGroup.position.clone();
  cockpit.clusterGroup.position.copy(clusterAt);

  /* --- steering ----------------------------------------------------------- */

  /* engine.ts drives `wheelGroup.rotation.z` and knows nothing about donors,
     so the donor rim is hung inside that same group and an OUTER group carries
     the hub position and the column rake. Putting the rake on wheelGroup
     itself would not survive: the engine assigns rotation.z every frame, which
     rewrites the whole Euler and would flatten the rake back out. */
  const wheelParts = byRole("wheel");
  const proceduralWheel = [...cockpit.wheelGroup.children];
  let axisG: THREE.Group | null = null;
  /* Where wheelGroup sat before the donor took it over. setActive has to put
     it back exactly: it is moved INTO the donor scene below, and hiding that
     scene would otherwise take the procedural rim down with it and leave the
     A/B toggle showing a car with no steering wheel at all. */
  const wheelHome = {
    parent: cockpit.wheelGroup.parent,
    position: cockpit.wheelGroup.position.clone(),
    quaternion: cockpit.wheelGroup.quaternion.clone(),
    scale: cockpit.wheelGroup.scale.clone(),
  };

  if (wheelParts.length && man.steering) {
    const { hub, axis } = man.steering;
    axisG = new THREE.Group();
    axisG.name = "donorSteeringAxis";
    axisG.position.set(hub[0], hub[1], hub[2]);
    axisG.quaternion.copy(alignZ(new THREE.Vector3(axis[0], axis[1], axis[2])));
    /* Hung inside the donor scene, not beside it, so the hub and the rim share
       one space and the width fitting above applies to both. It also keeps the
       rotation clear of shear: cockpit.group's (sx,1,1) and the scene's
       (1,sx,sx) both sit ABOVE this rotation and multiply out to a plain
       isotropic sx, whereas a rotation placed between them would skew the rim
       into an ellipse. */
    scene.add(axisG);
    axisG.updateMatrix();

    /* Re-parent rather than reposition: the engine's handle has to stay the
       same object or every call site would need to learn about donors. */
    cockpit.wheelGroup.position.set(0, 0, 0);
    cockpit.wheelGroup.rotation.set(0, 0, 0);
    cockpit.wheelGroup.scale.setScalar(1);
    axisG.add(cockpit.wheelGroup);

    /* wheelGroup sits at identity inside axisG, so "local to axisG" and "local
       to wheelGroup" are the same thing — one inverse, no world matrices. */
    const inv = axisG.matrix.clone().invert();
    for (const p of wheelParts) {
      p.updateMatrix();
      const local = inv.clone().multiply(p.matrix);
      p.parent?.remove(p);
      local.decompose(p.position, p.quaternion, p.scale);
      cockpit.wheelGroup.add(p);
    }
    // the donor's own rim replaces ours; the moulded hands go with it
    for (const c of proceduralWheel) c.visible = false;
  }

  /* --- attach ------------------------------------------------------------- */

  cockpit.group.add(scene);

  const setActive = (on: boolean) => {
    scene.visible = on;
    cockpit.dashGroup.visible = !on;
    cockpit.screenMesh.visible = !on;
    for (const c of proceduralWheel) c.visible = !on;
    for (const p of wheelParts) p.visible = on;
    /* wheelGroup is the engine's handle and has to keep steering either way,
       so it moves between the donor's raked axis and its original mount rather
       than being hidden with whichever dash is off. */
    if (axisG) {
      if (on) {
        axisG.add(cockpit.wheelGroup);
        cockpit.wheelGroup.position.set(0, 0, 0);
        cockpit.wheelGroup.quaternion.identity();
        cockpit.wheelGroup.scale.setScalar(1);
      } else {
        wheelHome.parent?.add(cockpit.wheelGroup);
        cockpit.wheelGroup.position.copy(wheelHome.position);
        cockpit.wheelGroup.quaternion.copy(wheelHome.quaternion);
        cockpit.wheelGroup.scale.copy(wheelHome.scale);
      }
    }
    cockpit.clusterGroup.position.copy(on ? clusterAt : clusterHome);
  };
  setActive(true);

  return { group: scene, setActive };
}
