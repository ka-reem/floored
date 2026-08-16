import { clamp, rrand, type Rng } from "../util";
import type { Terrain } from "./terrain";
import { TOWN, FRONT_X, EFRONT_X, ROAD_W, FRONT_W } from "./const";
import { rampFootZs } from "./ramps";

/* Seeded road-network graph: a jittered grid with pruned links and curved
   edges, plus straight frontage roads flanking the expressway. Streets are
   sampled into dense polylines that conform to the terrain — everything
   downstream (meshes, traffic, minimap, spawning) reads these samples. */

export interface RNode {
  id: number;
  x: number;
  z: number;
  edges: number[];
  signal: boolean;
  front?: boolean;
}

export interface REdge {
  id: number;
  a: number;
  b: number;
  /** flat [x,y,z] samples from a→b, ~3.2 m apart */
  pts: Float32Array;
  /** cumulative arclength per sample */
  ss: Float32Array;
  len: number;
  w: number; // road width
  front?: boolean;
}

export interface EdgePose {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
}

export interface RoadNet {
  nodes: RNode[];
  edges: REdge[];
  sampleEdge(e: REdge, s: number, out: EdgePose, hint?: { i: number }): EdgePose;
  nearest(x: number, z: number): { edge: REdge; s: number; dist: number } | null;
  /** edge samples spatial hash (cell 12 m) — used for building placement + nearest() */
  hash: Map<number, Array<[number, number, number, number]>>; // [x, z, edgeId, s]
}

const CELL = 12;
const hkey = (x: number, z: number) =>
  (Math.floor(x / CELL) + 2048) * 8192 + (Math.floor(z / CELL) + 2048);

export function buildRoadNet(rng: Rng, terrain: Terrain): RoadNet {
  const nodes: RNode[] = [];
  const edges: REdge[] = [];
  const hash = new Map<number, Array<[number, number, number, number]>>();

  function addNode(x: number, z: number, front = false): number {
    const id = nodes.length;
    nodes.push({ id, x, z, edges: [], signal: false, front });
    return id;
  }

  function pushSample(x: number, z: number, eid: number, s: number) {
    const k = hkey(x, z);
    let arr = hash.get(k);
    if (!arr) hash.set(k, (arr = []));
    arr.push([x, z, eid, s]);
  }

  function addEdge(a: number, b: number, bulge: number, w: number, front = false) {
    const A = nodes[a], B = nodes[b];
    const dx = B.x - A.x, dz = B.z - A.z;
    const L = Math.hypot(dx, dz);
    if (L < 8) return null;
    const nx = -dz / L, nz = dx / L; // left normal
    const mx = (A.x + B.x) / 2 + nx * bulge;
    const mz = (A.z + B.z) / 2 + nz * bulge;
    const n = Math.max(6, Math.ceil(L / 3.2));
    const pts = new Float32Array((n + 1) * 3);
    const ss = new Float32Array(n + 1);
    let px = 0, pz = 0, acc = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const x = u * u * A.x + 2 * u * t * mx + t * t * B.x;
      const z = u * u * A.z + 2 * u * t * mz + t * t * B.z;
      if (i > 0) acc += Math.hypot(x - px, z - pz);
      pts[i * 3] = x;
      pts[i * 3 + 1] = terrain.h(x, z);
      pts[i * 3 + 2] = z;
      ss[i] = acc;
      px = x;
      pz = z;
    }
    const id = edges.length;
    const e: REdge = { id, a, b, pts, ss, len: acc, w, front };
    edges.push(e);
    nodes[a].edges.push(id);
    nodes[b].edges.push(id);
    for (let i = 0; i <= n; i += 2) pushSample(pts[i * 3], pts[i * 3 + 2], id, ss[i]);
    return e;
  }

  /* ---- town grid ---- */
  const SPACING = 74;
  const NX = Math.floor((TOWN.x1 - TOWN.x0) / SPACING) + 1;
  const NZ = Math.floor((TOWN.z1 - TOWN.z0) / SPACING) + 1;
  const grid: (number | null)[][] = [];
  for (let i = 0; i < NX; i++) {
    grid[i] = [];
    for (let j = 0; j < NZ; j++) {
      if (rng() < 0.09) {
        grid[i][j] = null;
        continue;
      }
      const x = TOWN.x0 + i * SPACING + rrand(rng, -15, 15);
      const z = TOWN.z0 + j * SPACING + rrand(rng, -15, 15);
      grid[i][j] = addNode(x, z);
    }
  }
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NZ; j++) {
      const a = grid[i][j];
      if (a === null) continue;
      if (i + 1 < NX && grid[i + 1][j] !== null && rng() < 0.88)
        addEdge(a, grid[i + 1][j]!, rrand(rng, -12, 12), ROAD_W);
      if (j + 1 < NZ && grid[i][j + 1] !== null && rng() < 0.88)
        addEdge(a, grid[i][j + 1]!, rrand(rng, -12, 12), ROAD_W);
    }
  // guarantee no orphan nodes: link to a neighbor if isolated
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NZ; j++) {
      const a = grid[i][j];
      if (a === null || nodes[a].edges.length > 0) continue;
      const cand = [
        i + 1 < NX ? grid[i + 1][j] : null,
        j + 1 < NZ ? grid[i][j + 1] : null,
        i > 0 ? grid[i - 1][j] : null,
        j > 0 ? grid[i][j - 1] : null,
      ].filter((c) => c !== null) as number[];
      if (cand.length) addEdge(a, cand[0], rrand(rng, -8, 8), ROAD_W);
    }

  /* ---- west frontage road (straight, passes through all ramp feet) ---- */
  const footZs = rampFootZs();
  const frontZs: number[] = [];
  for (let z = TOWN.z0 + 10; z <= TOWN.z1 - 10; z += 76) {
    // don't drop a node right next to a ramp foot; the feet win
    if (footZs.some((fz) => Math.abs(z - fz) < 26)) continue;
    frontZs.push(z);
  }
  for (const fz of footZs) frontZs.push(fz);
  frontZs.sort((a, b) => a - b);
  const dedup = frontZs.filter((z, i) => i === 0 || z - frontZs[i - 1] > 24);
  let prevF: number | null = null;
  const frontNodes: number[] = [];
  for (const z of dedup) {
    const id = addNode(FRONT_X, z, true);
    frontNodes.push(id);
    if (prevF !== null) addEdge(prevF, id, 0, FRONT_W, true);
    prevF = id;
  }
  // connect frontage into the town grid (nearest last-column node per row)
  for (const fid of frontNodes) {
    const F = nodes[fid];
    let best: number | null = null, bd = 1e9;
    for (let j = 0; j < NZ; j++) {
      const a = grid[NX - 1][j] ?? grid[NX - 2]?.[j] ?? null;
      if (a === null) continue;
      const d = Math.abs(nodes[a].z - F.z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    if (best !== null && bd < 55) addEdge(best, fid, rrand(rng, -6, 6), ROAD_W);
  }

  /* ---- east frontage strip ---- */
  const eastZs: number[] = [];
  for (let z = -408; z <= 408; z += 68)
    if (!footZs.some((fz) => Math.abs(z - fz) < 26)) eastZs.push(z);
  for (const fz of footZs) eastZs.push(fz);
  eastZs.sort((a, b) => a - b);
  let prevE: number | null = null;
  for (const z of eastZs.filter((z, i, arr) => i === 0 || z - arr[i - 1] > 24)) {
    const id = addNode(EFRONT_X, z, true);
    if (prevE !== null) addEdge(prevE, id, 0, FRONT_W, true);
    prevE = id;
  }

  /* ---- signals at busy 4-way town intersections ---- */
  let sigCount = 0;
  for (const n of nodes) {
    if (n.front || n.edges.length !== 4) continue;
    if (Math.abs(n.x) > 320 || Math.abs(n.z) > 320) continue;
    if (sigCount >= 14) break;
    if (rng() < 0.55) {
      n.signal = true;
      sigCount++;
    }
  }

  function sampleEdge(e: REdge, s: number, out: EdgePose, hint?: { i: number }): EdgePose {
    s = clamp(s, 0, e.len);
    const n = e.ss.length - 1;
    let i = hint ? clamp(hint.i, 0, n - 1) : 0;
    // walk the hint to the right segment (amortised O(1) for traffic)
    while (i > 0 && e.ss[i] > s) i--;
    while (i < n - 1 && e.ss[i + 1] < s) i++;
    if (hint) hint.i = i;
    const s0 = e.ss[i], s1 = e.ss[i + 1];
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    const ax = e.pts[i * 3], ay = e.pts[i * 3 + 1], az = e.pts[i * 3 + 2];
    const bx = e.pts[(i + 1) * 3], by = e.pts[(i + 1) * 3 + 1], bz = e.pts[(i + 1) * 3 + 2];
    out.x = ax + (bx - ax) * t;
    out.y = ay + (by - ay) * t;
    out.z = az + (bz - az) * t;
    const dl = Math.hypot(bx - ax, bz - az) || 1;
    out.tx = (bx - ax) / dl;
    out.tz = (bz - az) / dl;
    return out;
  }

  function nearest(x: number, z: number) {
    let best: { edge: REdge; s: number; dist: number } | null = null;
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    for (let r = 0; r < 9; r++) {
      for (let di = -r; di <= r; di++)
        for (let dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const arr = hash.get((ci + di + 2048) * 8192 + (cj + dj + 2048));
          if (!arr) continue;
          for (const [sx, sz, eid, s] of arr) {
            const d = Math.hypot(sx - x, sz - z);
            if (!best || d < best.dist) best = { edge: edges[eid], s, dist: d };
          }
        }
      if (best && best.dist < (r - 1) * CELL) break;
    }
    return best;
  }

  return { nodes, edges, sampleEdge, nearest, hash };
}

/** Pick the next edge leaving `node`, avoiding an immediate U-turn when possible. */
export function pickNextEdge(rng: Rng, net: RoadNet, nodeId: number, fromEdge: number): number {
  const opts = net.nodes[nodeId].edges.filter((e) => e !== fromEdge);
  if (!opts.length) return fromEdge;
  return opts[Math.floor(rng() * opts.length) % opts.length];
}
