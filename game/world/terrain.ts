import * as THREE from "three";
import { sstep, type Rng, rrand } from "../util";
import { SURFACE_TOL } from "./const";
import { getCorridor, type Corridor } from "./corridor";
import { getRouteGraph } from "./routegraph";
import { buildRamps, rampAt, type Ramp } from "./ramps";

/* Rolling terrain the whole town conforms to. Flattened along the expressway
   corridor (so the piers, ramps and frontage roads sit on level ground) and
   faded out toward the world edge. */

export interface Terrain {
  h(x: number, z: number): number;
  heightAt(x: number, z: number, refY: number): number;
  corridor: Corridor;
  /** curved on/off ramp centrelines, shared by meshes, colliders and physics */
  ramps: Ramp[];
  /** ramp surface height under a point, or null when off the pavement */
  onRamp(x: number, z: number): number | null;
  /** bypass viaduct surface height under a point, or null when off it */
  onBypass(x: number, z: number): number | null;
}

export function makeTerrain(rng: Rng): Terrain {
  const corridor = getCorridor();
  // seeded hill field: 3 octaves of drifting sines
  const p1 = rrand(rng, 0, 6.28), p2 = rrand(rng, 0, 6.28), p3 = rrand(rng, 0, 6.28);
  const p4 = rrand(rng, 0, 6.28), p5 = rrand(rng, 0, 6.28);
  const A1 = rrand(rng, 2.6, 3.6), A2 = rrand(rng, 1.2, 1.9), A3 = rrand(rng, 3.4, 4.6);

  function hills(x: number, z: number) {
    return (
      A1 * Math.sin(x * 0.0102 + p1) * Math.cos(z * 0.0088 + p2) +
      A2 * Math.sin(x * 0.019 - z * 0.016 + p3) +
      A3 * Math.cos(x * 0.0047 + p4) * Math.sin(z * 0.0053 + p5)
    );
  }

  function h(x: number, z: number) {
    // flatten from ~x=336 eastward so the expressway corridor sits on level ground
    const corr = sstep((402 - x) / 66);
    const zFade = sstep((900 - Math.abs(z)) / 260);
    const xFade = sstep((x + 940) / 300);
    const k = corr * zFade * xFade;
    if (k <= 0.0001) return 0;
    return hills(x, z) * k;
  }

  const ramps = buildRamps(h);
  const onRamp = (x: number, z: number) => {
    const r = rampAt(ramps, x, z, 1.0);
    return r ? r.y : null;
  };

  /* Which surface is under the car: of the candidates that pass their refY
     gate, the one NEAREST the car's current height — not the highest.

     By construction they never overlap (ramp and bypass pavement is clipped to
     *meet* the deck edge rather than cross it), so on today's geometry this
     agrees with the old Math.max everywhere a car can reach. It is written
     this way because "highest wins" has no defence if that ever stops being
     true: a gore whose pavement crept a metre over the deck edge would start
     snapping cars UP off the deck onto it, mid-lane, at speed. Nearest cannot
     do that — and refY is the car's own height from last frame, so the pick is
     already sticky: a surface has to come closer than the one the car is
     riding before it can take over. */
  function heightAt(x: number, z: number, refY: number) {
    let best = h(x, z);
    let bestD = Math.abs(best - refY);
    /** ties go to the higher surface — a car straddling two sits on top */
    const take = (y: number) => {
      const d = Math.abs(y - refY);
      if (d < bestD || (d === bestD && y > best)) {
        best = y;
        bestD = d;
      }
    };
    // the deck, but only when the query is already up near it — otherwise a car
    // on the frontage road underneath would be yanked onto the expressway
    if (refY > corridor.centerY(z) - SURFACE_TOL) {
      const dy = corridor.heightAt(x, z, 1.0);
      if (dy !== null) take(dy);
    }
    // curved ramps
    const r = rampAt(ramps, x, z, 1.0);
    if (r && Math.abs(r.y - refY) < SURFACE_TOL) take(r.y);
    /* the bypass viaduct (routegraph.ts), with the same refY gating as the
       ramps: a car on the street or frontage under it is never yanked up —
       the graph's own tests guarantee it runs ≥ 6 m above any live street
       mid-route and never answers near deck height over the main pavement */
    const g = getRouteGraph().surfaceAt(x, z, 1.0);
    if (g && Math.abs(g.y - refY) < SURFACE_TOL) take(g.y);
    return best;
  }

  const onBypass = (x: number, z: number) =>
    getRouteGraph().surfaceAt(x, z)?.y ?? null;

  return { h, heightAt, corridor, ramps, onRamp, onBypass };
}

/** Ground heightfield mesh matching terrain.h. Wide enough in z to sit under
    the whole corridor including its overrun, and centred between the town and
    the expressway rather than on the origin. */
export function buildGround(terrain: Terrain, mat: THREE.Material) {
  const CX = 40, SX = 3400, SZ = 5600, SEGX = 80, SEGZ = 132;
  const g = new THREE.PlaneGeometry(SX, SZ, SEGX, SEGZ);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + CX, z = pos.getZ(i);
    pos.setY(i, terrain.h(x, z) - 0.09);
  }
  g.translate(CX, 0, 0);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}
