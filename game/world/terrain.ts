import * as THREE from "three";
import { sstep, type Rng, rrand } from "../util";
import { SURFACE_TOL } from "./const";
import { getCorridor, type Corridor } from "./corridor";
import { getRouteGraph, type SurfaceHit } from "./routegraph";
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

/** How far a surface may stand ABOVE the car and still be the one it is
    standing ON rather than driving under.

    A physics substep is 1/120 s, so at the corridor's steepest grade (10%) the
    pavement under the wheels rises about 1 cm per substep at 100 km/h and
    never more than ~7 cm at any speed this car reaches. A kerb's worth of
    headroom is therefore generous for "the road is climbing", and far too
    small for anything the car drives beneath: the entry ramp is already 2 m up
    where it grows its first pier, and the bypass viaduct clears every live
    street by 6 m. It also bounds the old worry this rule replaces — a gore
    whose pavement crept over the deck edge can now lift a car by at most
    STEP_UP, not by the metres Math.max would have allowed. */
const STEP_UP = 0.35;
/** float slack on "at the car's own height" */
const EPS = 1e-6;

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

  /* surfaceAt target for heightAt below — read and dropped inside one call,
     which physics makes up to 18×/frame (3 probes × 6 substeps); a fresh
     SurfaceHit per probe was steady GC churn on the hottest path there is */
  const _surfHit: SurfaceHit = { y: 0, edgeId: 0, s: 0, lat: 0, bank: 0 };

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
     riding before it can take over.

     …with ONE exception, and it cost the entry ramp. "Agrees with the old
     Math.max everywhere a car can reach" was wrong about the bare ground: the
     ground is a candidate at every point in the world, and a car sitting on it
     is at EXACTLY its height, so the ground scores d = 0 and nothing can ever
     beat it. The instant the entry ramp lifted off the ground under the wheels
     the ramp was a centimetre away and the ground was zero away, so the ground
     kept the car — for the whole 264 m climb. The player drove along the flat
     ground UNDERNEATH the ramp and stopped dead against its first pier, which
     is the "the on ramp is broken, i cant drive on it" report. Nothing threw,
     nothing jumped, and every browser-free sim scored it a clean 0.00, because
     they were all measuring how far the car was JOLTED and the car was never
     jolted; it just never went up.

     So `riser` is carried alongside: the highest surface that is at, or a
     kerb's worth above, the car's own height. Pavement rising under the wheels
     cannot be driven through, so it wins over anything below it — while a road
     the car is driving UNDER stays a road it is driving under. See STEP_UP. */
  function heightAt(x: number, z: number, refY: number) {
    let best = h(x, z);
    let bestD = Math.abs(best - refY);
    let riser = h(x, z) >= refY - EPS && h(x, z) <= refY + STEP_UP ? h(x, z) : -Infinity;
    /** ties go to the higher surface — a car straddling two sits on top */
    const take = (y: number) => {
      const d = Math.abs(y - refY);
      if (y >= refY - EPS && y <= refY + STEP_UP && y > riser) riser = y;
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
    /* the bypass viaduct and the mountain road (routegraph.ts), with the
       same refY gating as the ramps: a car on the street or frontage under
       them is never yanked up — the graph's own tests guarantee the bypass
       runs ≥ 6 m above any live street mid-route and neither answers near
       deck height over the main pavement */
    const routes = getRouteGraph();
    const g = routes.surfaceAt(x, z, 1.0, _surfHit);
    if (g && Math.abs(g.y - refY) < SURFACE_TOL) take(g.y);
    /* the mountain gores' runoff aprons: deck-height pavement just outside
       the deck edge, same refY gate as the deck itself */
    if (refY > corridor.centerY(z) - SURFACE_TOL) {
      const ay = routes.apronAt(x, z, 1.0);
      if (ay !== null) take(ay);
    }
    return riser > best ? riser : best;
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
