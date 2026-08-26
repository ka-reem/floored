import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { Cockpit } from "./cockpit";

/* Swaps an imported interior in over the procedural one.

   The procedural cockpit (cockpit.ts) is always built and is always the
   fallback. This loads a donor cabin produced by tools/build-cockpit.mjs, and
   if it arrives intact it hides the procedural regions it replaces and
   re-anchors the live parts onto the donor's geometry. If the fetch fails, the
   model is missing a role, or the user is on a tier that does not want it,
   nothing happens and the procedural dash stays on screen. That fail-soft is
   the whole reason this is a separate module: a 7 MB asset that can 404 must
   never be able to leave the player without a dashboard.

   DONOR-AGNOSTIC BY CONSTRUCTION, and that is what let the shipped asset be
   swapped underneath it. Nothing here knows the file it is reading: roles come
   out of the manifest, placement comes out of the manifest's bounding boxes,
   and the steering rake comes out of its measured column axis. The interior
   that ships today (volvo-s90-full: whole donor nodes, decimated, never
   frustum-clipped) replaced a per-vertex frustum CUT of the same car without
   one line of this file changing shape — the cut is retired because it printed
   sliced edges at wide field of view, and the build tool freezes the `mirror`
   role to the cut's frustum precisely so the anchors below did not move when
   it went.

   Loading is async and deliberately not awaited anywhere. The game starts on
   the procedural dash and the donor pops in a beat later — the same pattern
   world/highway.ts uses for its roadside props.

   What is replaced vs kept:

   - REPLACED  whichever of cockpit.ts's merge regions the donor actually
               supplies. "dash" is the pad, binnacle, vents, stack, console and
               head-unit body; "cabin" is the door cards, pillars, roof and
               headliner. Checked per region rather than assumed: a
               dashboard-only donor brings no pillars, and hiding ours for it
               would open the cabin to the sky.
   - KEPT      seats, glass, mirrors, wipers, the droplet overlay and both
               light rigs — always. The light strips and window glass in
               particular are lighting features tuned against the night pass,
               and a donor's equivalents are inert geometry.
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
      /* EXT_meshopt_compression is REQUIRED by the shipped interior, so a
         loader without this decoder does not degrade — it rejects the file and
         the player gets the procedural dash. Meshopt rather than Draco because
         the decoder is a plain ES module that bundles with the app, where
         Draco needs wasm files served out of public/. */
      new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load(
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

  /* Which procedural regions this donor is entitled to replace. Derived from
     what it actually brought, not assumed: a dashboard-only donor has no
     "cabin" parts, and hiding our pillars for it would open the cabin to the
     sky. Roles map to cockpit.ts's merge regions. */
  const supplies = new Set<string>();
  if ((man.parts.shell ?? []).length) supplies.add("dash");
  if ((man.parts.cabin ?? []).length) supplies.add("cabin");
  if ((man.parts.mirror ?? []).length) supplies.add("mirror");

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
  /* Its cover glass goes with it. The pane is a near-black blended shell
     (baseColor ~0.007, alpha ~0.68, double-sided) sitting between the eye and
     our relocated gauges, and the scan is dense enough that a POV ray crosses
     it several times — each layer multiplies through, dimming the cluster
     roughly 25x. Fail-soft: byRole returns [] for donors without the role. */
  for (const g of byRole("clusterGlass")) g.visible = false;
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
    /* Hand the mesh over so post.ts can shield THIS panel from the dashcam
       degrade once the donor is on show — the map is only worth reading if it
       stays sharp, and after the swap the procedural tablet it was projecting
       is hidden inside the dash. */
    cockpit.donorScreen = m;
  }

  /* --- our live parts, relocated ----------------------------------------- */

  /* The cluster keeps its own orientation (it is built facing the driver) and
     only moves: the donor binnacle's centre is a far better anchor than the
     procedural POD constant, which was fitted to different geometry. */
  const clusterHome = cockpit.clusterGroup.position.clone();
  cockpit.clusterGroup.position.copy(clusterAt);

  /* --- rear-view mirror --------------------------------------------------- */

  /* Take the donor's housing, keep our glass. A donor mirror is a painted
     rectangle; ours is fed by a render target, UV-cropped to its own slice of
     the rear camera, and registered with post.ts so the dashcam degrade does
     not chew it. So the procedural SHELL hides (region "mirror") and the glass
     moves into the donor's.

     This also fixes the framing for free. The procedural mirror hangs at
     EYE.y + 0.085 (y 1.435), which was fitted to a lens 12 cm higher than the
     imported dash uses — from the lower mount it rides the very top edge of
     the frame and shows housing underside rather than glass. The Volvo hangs
     its mirror at y ~1.31, so following the donor drops it ~12 cm and puts the
     glass back in shot. */
  /* Nudge applied to the donor's whole mirror assembly, housing and glass
     together. The Volvo hangs its mirror at z 0.44 — only 12.7 cm ahead of the
     POV lens at z 0.31 — and that proximity, not its height, is what puts it
     out of shot: the visible half-height at 12.7 cm is 0.07, while the glass
     centre sits 0.14 above the lens axis. Dropping it alone would have to go
     absurdly low to win. Moving it FORWARD instead buys frame cheaply, and it
     is where the mirror belongs anyway: the donor's windscreen passes through
     z ~0.58 at this height, so +0.10 parks the housing against the glass it
     would really be stuck to, instead of floating 14 cm behind it. The small
     drop then settles it just inside the top edge.

     THE Y TERM TRACKS THE LENS, and is the one number here that is not free.
     The mirror hangs ABOVE the lens, so its height in frame is set by the gap
     between the two and by nothing else: at the tuned placement the glass
     centre projects to 86% of the way up the frame at the default field of
     view, which is just inside the top edge, and it takes only ~2.5 cm of
     extra gap to push it off the top entirely. engine.ts dropped
     POV_MOUNT_DY_IMPORTED by 25 mm (-0.15 -> -0.175) for the seating position,
     so this dropped by exactly 25 mm too (-0.04 -> -0.065) and the gap — and
     therefore the framing — is unchanged. If that constant moves again, move
     this by the same amount in the same direction.

     The x and z terms are framing choices rather than physical ones. The Volvo
     hangs its mirror on the car's centreline (x ~0.01) while the POV lens sits
     inboard of the driver at x 0.28, so a centred mirror lands right of frame
     centre — true to where a real mirror is, but it crowds that side. +x is
     screen-LEFT here (car-local +x maps to screen-left through the POV
     camera's heading), so this walks the whole assembly back toward the middle
     of the frame. Those two are cosmetic; move them freely. */
  const MIRROR_NUDGE = new THREE.Vector3(0.08, -0.16, 0.10);

  const mirrorParts = byRole("mirror");
  const glass = cockpit.mirrorGlass;
  const frame = cockpit.mirrorFrame;
  const glassHome = {
    position: glass.position.clone(),
    quaternion: glass.quaternion.clone(),
    scale: glass.scale.clone(),
  };
  /* The frame travels with the glass. It lives outside the "mirror" merge
     region precisely so it survives this donor taking that region over — see
     cockpit.ts — but surviving is only half of it: parked at its procedural
     home while the glass moved to the donor's mounting point, it would frame
     empty air a hand's width from the mirror. */
  const frameHome = {
    position: frame.position.clone(),
    quaternion: frame.quaternion.clone(),
    scale: frame.scale.clone(),
  };
  let glassAt: THREE.Vector3 | null = null;
  let glassScale = 1;

  if (mirrorParts.length) {
    const box = new THREE.Box3();
    for (const p of mirrorParts) {
      const m = p as THREE.Mesh;
      if (!m.geometry) continue;
      m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrix));
    }
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    /* Sit on the housing's cabin-facing face (min z — the driver looks toward
       +z), a hair proud so the glass never z-fights the shell it sits in. */
    glassAt = new THREE.Vector3(mid.x, mid.y, box.min.z - 0.004)
      .add(MIRROR_NUDGE)
      .multiply(scene.scale);
    // the housing follows the glass, or the two come apart
    for (const p of mirrorParts) p.position.add(MIRROR_NUDGE);
    /* Fit the glass to the housing's aperture rather than assuming a size:
       ours is 0.30 m wide and the Volvo's body is 0.21, so at native size it
       would hang out either side of its own frame. Inset slightly so a bezel
       still reads around it. */
    glassScale = Math.min(1, (size.x * 0.88) / 0.30) * sx;

    /* The donor's mirror BODY is hidden, and only its glass survives.

       Two reasons. The read one: the Volvo's housing is a moulded shell that
       was authored to be seen from outside the car in a showroom render, and
       from 12 cm in front of a 105-degree dashcam lens it fills a chunk of
       the frame as an unlit plastic lump behind the mirror — the reported
       "plastic mirror holder, it's glitched". The geometric one: it was
       modelled around ITS OWN glass, and ours is a different size and gets
       rescaled to fit the aperture, so the shell and the glass it frames no
       longer agree.

       The parts stay in the scene graph rather than being removed, because
       the bbox above is what positions the glass — deleting them would take
       the anchor with them. Hiding is also what keeps the imported/procedural
       A/B toggle honest: setActive() below walks these same parts. */
    for (const p of mirrorParts) p.visible = false;
  }

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

  /* --- fill light --------------------------------------------------------- */

  /* Replaces the reach of the ambient strips this donor displaces. Those were
     pinned to the procedural door card and left with it, and cockpit.ts is
     blunt about what they were for: without an interior source "the vents,
     glovebox and console reduce to a black mass however well they are
     modelled". That is exactly what a donor dash inherits.

     Shaped to WIDEN rather than brighten, which is the thing that actually
     survives the POV chain. That chain crushes everything under 0.06 to pure
     black and then takes up to 55% more off at the frame edge, so a small hot
     spot buys one bright patch and leaves the rest below the floor — while a
     broad, gentle wash lifts the whole pad over it. Hence:

     - decay 1, not the physical 2. 1/r instead of 1/r^2 spreads an even carpet
       across a 1.5 m dash instead of blowing out whatever is nearest and
       dropping the corners through the floor. Same reasoning as the low beam
       in engine.ts.
     - distance 4.0 against a dash barely 1.3 m away. `distance` is a HARD clip
       in three, not a falloff, so it has to land far past anything visible or
       it prints its own edge on the trim.
     - 0xffb070 rather than a paler warm. The manual ACES pass desaturates as
       luma climbs, so a source has to sit further toward yellow than the
       colour you actually want; a pale tint arrives white and reads as a
       flashlight rather than cabin ambience.

     Parented to the donor scene so it lives and dies with it — the procedural
     dash keeps its own strips and must not be lit twice. */
  const fill = new THREE.PointLight(0xffb070, 1.0, 4.0, 1.0);
  fill.position.set(0.05, 1.22, 0.42);
  scene.add(fill);

  /* --- attach ------------------------------------------------------------- */

  cockpit.group.add(scene);

  const setActive = (on: boolean) => {
    scene.visible = on;
    for (const [name, gp] of Object.entries(cockpit.regionGroups)) {
      // regions this donor did not supply stay visible in both states
      gp.visible = on ? !supplies.has(name) : true;
    }
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

    if (glassAt && on) {
      /* scale.x stays negative: cockpit.ts flips the glass so the rear camera's
         backward view reads as a mirror rather than a shoulder-check. Losing
         that sign would silently un-mirror the reflection. */
      glass.position.copy(glassAt);
      glass.scale.set(-glassScale, glassScale, glassScale);
      /* Same place and the same scale, but NOT the negative x: the flip exists
         to un-mirror the rear camera's image and the frame has no image to
         un-mirror. Negating it too would turn the shell inside out — its faces
         would wind backwards and it would render as the far side of itself.
         The glass sits at frame z +0.002 in cockpit.ts — in the plane of the
         lip, not in front of it — so the frame origin is 2 mm BEHIND the
         glass, and the sign matters: +0.004 here used to push the rim further
         back still and leave the pane standing proud of it. */
      frame.position.set(glassAt.x, glassAt.y, glassAt.z - 0.002 * glassScale);
      frame.quaternion.copy(glass.quaternion);
      frame.scale.setScalar(glassScale);
    } else {
      glass.position.copy(glassHome.position);
      glass.quaternion.copy(glassHome.quaternion);
      glass.scale.copy(glassHome.scale);
      frame.position.copy(frameHome.position);
      frame.quaternion.copy(frameHome.quaternion);
      frame.scale.copy(frameHome.scale);
    }
  };
  setActive(true);

  return { group: scene, setActive };
}
