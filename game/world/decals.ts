import * as THREE from "three";
import { mulberry32 } from "../util";
import { getCorridor, TUNNEL, TOLL } from "./corridor";
import { CONNECT_Z } from "./const";
import { loadDecalMaps } from "./decaltex";

/* Road-realism decal scatter (Lane H).

   Cracked/patched asphalt and oil staining on the deck, manhole/drainage
   covers along the shoulders, and moisture streaks down the tunnel walls and
   parapet faces. All of it is seasoning, not soup: densities are low, every
   placement is deterministic, and each decal family is ONE InstancedMesh —
   five draw calls for the whole corridor.

   Placement rules borrowed from the furniture code in highway.ts:

   - everything sits on the corridor lattice, with pitches that divide
     LOOP_LEN. The deck is built DECK_EXT past each canonical end, so any
     off-period pitch would dress the two copies of the splice differently
     and the wrap teleport would show as decals popping.
   - per-slot randomness is seeded from the *folded* lattice index
     (latticeIndex), so the copy 380 m past the splice rolls the same dice as
     the copy 380 m before it.
   - decals never touch the road material itself: they are overlay quads a few
     centimetres up with polygonOffset, alpha-faded (or alphaTest cutout for
     the covers, whose mask has a hard true edge).

   Textures load async (JPG pairs, see decaltex.ts); the meshes appear when
   they land and the world stands fine without them. */

const LAYER_NOREF = 1;

/* Lattice pitches — all divide LOOP_LEN (4000). Phases keep the families off
   each other and off the lamp/gantry lattices. */
const P_CRACK = 100;
const P_OIL = 80;
const P_MANHOLE = 125;
const P_PARA = 200;

interface Slot {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
}

/** Deterministic per-slot dice: same lattice index ⇒ same rolls, either side
    of the loop splice. */
const rngFor = (index: number, salt: number) =>
  mulberry32((Math.imul(index + 1, 0x9e3779b1) ^ salt) >>> 0);

/** Quaternion laying a flat quad on the deck: yaw to the corridor heading,
    then pitch to the grade so neither end of the quad buries or floats on a
    climb (5% grade over a 5 m quad is a 25 cm gap — very visible). */
function deckQuat(h: number, grade: number) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-Math.asin(grade), h, 0, "YXZ")
  );
}

/** Unit quad lying flat, texture-up pointing down the road (same frame as
    highway.ts's flatQuad — see the mirroring note there). */
function flatUnit() {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  g.rotateY(Math.PI);
  return g;
}

function addInstanced(
  scene: THREE.Scene,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  slots: Slot[],
  renderOrder: number
) {
  if (!slots.length) return;
  const im = new THREE.InstancedMesh(geo, mat, slots.length);
  const M = new THREE.Matrix4();
  slots.forEach((s, i) => {
    M.compose(s.pos, s.quat, s.scale);
    im.setMatrixAt(i, M);
  });
  im.computeBoundingSphere();
  // reflections never sample the deck top at glancing angles anyway; skip the
  // planar-reflection pass like the studs and pools do
  im.layers.set(LAYER_NOREF);
  im.renderOrder = renderOrder;
  scene.add(im);
}

const inToll = (z: number) => z > TOLL.z0 - 20 && z < TOLL.z1 + 20;

export function buildRoadDecals(scene: THREE.Scene) {
  const cor = getCorridor();

  /* ---- cracked / patched asphalt, anywhere on the pavement ---- */
  const crackSlots: Slot[] = [];
  for (const z of cor.lattice(P_CRACK, 37)) {
    if (z > cor.ZB1 || cor.inTunnel(z) || inToll(z)) continue;
    const rng = rngFor(cor.latticeIndex(z, P_CRACK, 37), 0xc1ac);
    if (rng() < 0.35) continue;
    const p = cor.pose(z);
    const hw = cor.halfWidth(z);
    const lat = (rng() * 2 - 1) * Math.max(0.5, hw - 2.6);
    const w = cor.worldOf(z, lat);
    const size = 3.8 + rng() * 2.4;
    crackSlots.push({
      pos: new THREE.Vector3(w.x, w.y + 0.03, w.z),
      quat: deckQuat(p.h, p.grade),
      // mirror variants stand in for rotation (a flat quad can't spin in
      // plane via a single Euler once it also carries yaw+pitch)
      scale: new THREE.Vector3(size * (rng() < 0.5 ? -1 : 1), 1, size * (rng() < 0.5 ? -1 : 1)),
    });
  }

  /* ---- oil / grime staining, down the lane centres where it drips ---- */
  const oilSlots: Slot[] = [];
  for (const z of cor.lattice(P_OIL, 11)) {
    if (z > cor.ZB1 || inToll(z)) continue;
    const rng = rngFor(cor.latticeIndex(z, P_OIL, 11), 0x0117);
    if (rng() < 0.45) continue;
    const p = cor.pose(z);
    const lanes = Math.max(1, Math.floor(cor.laneCount(z)));
    const k = Math.min(lanes - 1, Math.floor(rng() * lanes));
    const w = cor.worldOf(z, cor.laneOffset(k, z));
    oilSlots.push({
      pos: new THREE.Vector3(w.x, w.y + 0.028, w.z),
      quat: deckQuat(p.h, p.grade),
      scale: new THREE.Vector3(
        (1.7 + rng() * 0.9) * (rng() < 0.5 ? -1 : 1), 1, 3.4 + rng() * 1.8),
    });
  }

  /* ---- manhole / drainage covers along the shoulders ---- */
  const mhSlots: Slot[] = [];
  for (const z of cor.lattice(P_MANHOLE, 53)) {
    if (z > cor.ZB1 || inToll(z)) continue;
    const idx = cor.latticeIndex(z, P_MANHOLE, 53);
    const rng = rngFor(idx, 0x3a11);
    if (rng() < 0.3) continue;
    const p = cor.pose(z);
    const side = idx % 2 ? 1 : -1;
    const w = cor.worldOf(z, side * (cor.halfWidth(z) - 1.15));
    mhSlots.push({
      pos: new THREE.Vector3(w.x, w.y + 0.026, w.z),
      quat: deckQuat(p.h, p.grade),
      scale: new THREE.Vector3(1.15 * (rng() < 0.5 ? -1 : 1), 1, 1.15),
    });
  }

  /* ---- moisture streaks: tunnel walls ---- */
  const tubeSlots: Slot[] = [];
  for (let z = TUNNEL.z0 + 14; z < TUNNEL.z1 - 8; z += 21) {
    for (const side of [-1, 1]) {
      const rng = rngFor(Math.round(z) * 2 + (side > 0 ? 1 : 0), 0x7e0a);
      if (rng() < 0.35) continue;
      const p = cor.pose(z);
      const hw = cor.halfWidth(z);
      const lat = side * (hw + 0.55 - 0.07);
      const w = cor.worldOf(z, lat);
      const wq = 1.8 + rng() * 1.6, hq = 2.6 + rng() * 1.2;
      tubeSlots.push({
        // hang from just under the batten line; dies out mid-wall
        pos: new THREE.Vector3(w.x, w.y + 6.15 - hq / 2, w.z),
        quat: new THREE.Quaternion().setFromEuler(
          new THREE.Euler(0, p.h + (side < 0 ? Math.PI / 2 : -Math.PI / 2), 0)),
        scale: new THREE.Vector3(wq * (rng() < 0.5 ? -1 : 1), hq, 1),
      });
    }
  }

  /* ---- moisture streaks: parapet inner faces on the open deck ---- */
  const paraSlots: Slot[] = [];
  for (const z of cor.lattice(P_PARA, 71)) {
    if (z > cor.ZB1 || cor.inTunnel(z) || inToll(z)) continue;
    // ramps punch gaps in the west parapet around the gores; stay clear
    if (CONNECT_Z.some((cz) => Math.abs(z - cz) < 280)) continue;
    const idx = cor.latticeIndex(z, P_PARA, 71);
    const rng = rngFor(idx, 0x5eed);
    if (rng() < 0.4) continue;
    const p = cor.pose(z);
    const side = idx % 2 ? 1 : -1;
    const w = cor.worldOf(z, side * (cor.halfWidth(z) + 0.03));
    paraSlots.push({
      pos: new THREE.Vector3(w.x, w.y + 0.48, w.z),
      quat: new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, p.h + (side < 0 ? Math.PI / 2 : -Math.PI / 2), 0)),
      scale: new THREE.Vector3((1.3 + rng() * 0.8) * (rng() < 0.5 ? -1 : 1), 0.95, 1),
    });
  }

  /* ---- materials arrive async; meshes appear as the JPGs land ---- */
  const D = "/assets/decals";
  loadDecalMaps(`${D}/asphalt_damage_col.jpg`, `${D}/asphalt_damage_a.jpg`,
    { softEdge: true }, ({ map, alphaMap }) => {
      addInstanced(scene, flatUnit(), new THREE.MeshStandardMaterial({
        map, alphaMap, transparent: true, depthWrite: false, opacity: 0.85,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        roughness: 0.95, metalness: 0,
        // the scan is a LIGHT repair patch; pulled down toward the deck tone
        // so it reads as damage, not as a glowing plate
        color: 0x5f6167,
      }), crackSlots, -1);
    });
  loadDecalMaps(`${D}/oil_stain_col.jpg`, `${D}/oil_stain_a.jpg`,
    {}, ({ map, alphaMap }) => {
      addInstanced(scene, flatUnit(), new THREE.MeshStandardMaterial({
        map, alphaMap, transparent: true, depthWrite: false, opacity: 0.8,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        // slicker than the deck: headlights and lamp pools catch it first
        roughness: 0.45, metalness: 0, color: 0x87878a,
      }), oilSlots, -1);
    });
  loadDecalMaps(`${D}/manhole_col.jpg`, `${D}/manhole_a.jpg`,
    {}, ({ map, alphaMap }) => {
      addInstanced(scene, flatUnit(), new THREE.MeshStandardMaterial({
        // hard-edged cutout, never blend: the cover's rim is a real edge and
        // an honest depth buffer under every glow sprite matters more here
        map, alphaMap, alphaTest: 0.5,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        roughness: 0.8, metalness: 0.25, color: 0x989ca3,
      }), mhSlots, 0);
    });
  loadDecalMaps(`${D}/leak_streak_col.jpg`, `${D}/leak_streak_a.jpg`,
    {}, ({ map, alphaMap }) => {
      const mat = new THREE.MeshBasicMaterial({
        // Basic, not Standard: the tunnel lining is self-illuminated and the
        // parapet sits unlit at night — a lit material would go pure black.
        // The scan is near-black already; this renders it as a dark veil.
        map, alphaMap, transparent: true, depthWrite: false, opacity: 0.55,
        color: 0x9a9da2,
      });
      addInstanced(scene, new THREE.PlaneGeometry(1, 1), mat, tubeSlots, -1);
      addInstanced(scene, new THREE.PlaneGeometry(1, 1), mat, paraSlots, -1);
    });
}
