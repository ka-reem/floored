import type * as THREE from "three";
import type { RoadNet } from "./roadnet";
import type { RouteGraph } from "./routegraph";
import type { Terrain } from "./terrain";

export interface Aabb {
  x0: number; x1: number; z0: number; z1: number; y0: number; y1: number;
}
export interface Obb {
  x: number; z: number; hw: number; hd: number; cos: number; sin: number;
  y0: number; y1: number;
}

const CELL = 26;
export const cellKey = (x: number, z: number) =>
  (Math.floor(x / CELL) + 2048) * 8192 + (Math.floor(z / CELL) + 2048);

export class ColliderIndex {
  aabbs: Aabb[] = [];
  obbs: Obb[] = [];
  aGrid = new Map<number, number[]>();
  oGrid = new Map<number, number[]>();

  addAabb(b: Aabb) {
    const id = this.aabbs.length;
    this.aabbs.push(b);
    for (let cx = Math.floor((b.x0 - 3) / CELL); cx <= Math.floor((b.x1 + 3) / CELL); cx++)
      for (let cz = Math.floor((b.z0 - 3) / CELL); cz <= Math.floor((b.z1 + 3) / CELL); cz++) {
        const k = (cx + 2048) * 8192 + (cz + 2048);
        let a = this.aGrid.get(k);
        if (!a) this.aGrid.set(k, (a = []));
        a.push(id);
      }
  }

  addObb(o: Obb) {
    const id = this.obbs.length;
    this.obbs.push(o);
    const r = Math.hypot(o.hw, o.hd) + 3;
    for (let cx = Math.floor((o.x - r) / CELL); cx <= Math.floor((o.x + r) / CELL); cx++)
      for (let cz = Math.floor((o.z - r) / CELL); cz <= Math.floor((o.z + r) / CELL); cz++) {
        const k = (cx + 2048) * 8192 + (cz + 2048);
        let a = this.oGrid.get(k);
        if (!a) this.oGrid.set(k, (a = []));
        a.push(id);
      }
  }

  nearbyAabbs(x: number, z: number): number[] {
    return this.aGrid.get(cellKey(x, z)) || [];
  }
  nearbyObbs(x: number, z: number): number[] {
    return this.oGrid.get(cellKey(x, z)) || [];
  }
}

export interface ExitInfo {
  z: number;
  no: number;
  name: string;
}

/** Everything the engine + traffic need to know about the built world. */
export interface WorldData {
  colliders: ColliderIndex;
  net: RoadNet;
  terrain: Terrain;
  /** the route graph (routegraph.ts); optional until the stage-2 build-out
      wires every consumer, so the old world builder keeps compiling */
  routes?: RouteGraph;
  exits: ExitInfo[];
  chunks: { group: THREE.Group; cx: number; cz: number }[];
  /** Live draw-distance uniform for chunked dressing that FADES rather than
      pops (roadside.ts vegetation): chunksUpdate() writes the same scaled
      distance it culls world.chunks at, and every dissolve shader reads it —
      so the fade always finishes inside the cull radius, whatever the tier
      or the perf cap are doing to it this frame. */
  fadeFar?: { value: number };
  // weather-dimmable references
  neonMats: THREE.Material[];
  glowPts?: THREE.Points;
  pools?: THREE.Mesh;
  reflMat?: THREE.PointsMaterial;
  rampPostMat?: THREE.PointsMaterial;
  goreBeaconMat?: THREE.SpriteMaterial;
  beaconPts?: THREE.Points;
  signalHeads?: {
    nsG: THREE.Points; nsY: THREE.Points; nsR: THREE.Points;
    ewG: THREE.Points; ewY: THREE.Points; ewR: THREE.Points;
  };
}

/** Signal phase shared by all signalised intersections.
    0 NS-green 1 NS-yellow 2 all-red 3 EW-green 4 EW-yellow */
export function signalPhase(now: number) {
  const t = now % 24;
  if (t < 9) return 0;
  if (t < 11.6) return 1;
  if (t < 12.4) return 2;
  if (t < 21.4) return 3;
  if (t < 23.2) return 4;
  return 2;
}
