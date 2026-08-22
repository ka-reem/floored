import { LANE_W, CONNECT_Z, FRONT_X, RAMP_W } from "./const";
import { getCorridor, type Corridor } from "./corridor";
import { buildRamps, parapetGap, type Ramp } from "./ramps";

/* ============================================================================
   The route graph: the map grown from one endless corridor into a small closed
   graph of routes.

   The main expressway loop (corridor.ts) is untouched and stays route 0 —
   bit-identical geometry, same z-space, same endless splice. This module adds
   a GRAPH on top of it:

     nodes = junctions (gore noses, ramp feet)
     edges = route segments, each with its own arc-length station space

   and one genuinely new route: the BYPASS, a divergent second carriageway
   that leaves the main deck at DIVERGE_Z through a west-side exit gore,
   climbs onto a viaduct, crosses BACK OVER the main route on an oblique
   bridge just before the tunnel mouth (the main route dives beneath it), runs
   an elevated stretch above the east frontage strip while the main route is
   in the tunnel and the toll plaza, then descends and merges from the east
   (a Shuto-style fast-lane merge) at MERGE_Z.

   Design rules that keep the endless-splice architecture alive:

   - Every piece of new geometry lives strictly inside z ∈ (Z0 + EXT, Z1 − EXT),
     so the splice windows either side of the seam still see nothing but the
     plain corridor and the wrap stays a pure translation. Neither loop —
     main-only or main+bypass — ever crosses the seam anywhere new.
   - The bypass leaves and rejoins *within one lap*, so a car on it never
     triggers spliceDelta() and every consumer's z-based bookkeeping survives.
   - The main route's geometry is never re-derived here: main edges delegate
     every query to the Corridor singleton, so they cannot drift from it.

   The bypass centreline is laid out in the corridor's own frame: for a
   parameter u (a main-route z), the centre sits at

       world(u) = mainCentre(u) + lat(u) · mainNormal(u),  y = y(u)

   with lat(u) and y(u) sums of smootherstep bends exactly like the corridor's
   own alignment. That buys the same guarantees the corridor gets from it:
   zero-slope bend ends mean the bypass leaves and rejoins the deck perfectly
   tangentially, C² everywhere, and the bridge crossing is simply the u where
   lat(u) = 0. The sampled stations are the single source of truth — meshes,
   collision, traffic and the minimap must all read them (or the pose API on
   top of them), exactly as the corridor's stations work today.

   Nothing here imports three.js: the whole module runs in plain node so the
   browser-free checks in test/routegraph-check.mjs can drive it.
   ========================================================================== */

/* ---- smootherstep bends (same machinery as corridor.ts) ---- */
function sm(t: number) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function sst(t: number) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
interface Bend {
  z0: number;
  z1: number;
  d: number;
}
function bendSum(bends: Bend[], z: number) {
  let v = 0;
  for (const b of bends) v += b.d * sm((z - b.z0) / (b.z1 - b.z0));
  return v;
}

/* ---- public types ------------------------------------------------------- */

export type EdgeKind = "main" | "detour" | "ramp" | "street";

export interface RoutePose {
  /** centreline point */
  x: number;
  y: number;
  z: number;
  /** unit tangent in the travel direction (ground plane) */
  tx: number;
  tz: number;
  /** unit lateral normal: (tz, -tx) — the driver's left, exactly as corridor.ts */
  nx: number;
  nz: number;
  /** heading in the engine's convention: atan2(tx, tz) */
  h: number;
  /** grade, dy/ds */
  grade: number;
  /** lateral surface slope dy/dlat (superelevation). 0 everywhere on route 0. */
  bank: number;
}

export interface RouteStation {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  /** arclength from the edge's start */
  s: number;
  /** fractional lane count */
  nf: number;
  /** pavement half-widths: L toward +lat (the normal side), R toward −lat.
      Asymmetric only through the gore wedges, where the inner side is clipped
      so the pavement meets the deck edge instead of overlapping it. */
  hwL: number;
  hwR: number;
  /** lateral surface slope dy/dlat */
  bank: number;
  /** grade dy/ds */
  grade: number;
}

export interface RouteNode {
  id: number;
  name: string;
  kind: "diverge" | "merge" | "foot";
  /** the junction point (a gore nose or a ramp foot) in world space */
  x: number;
  y: number;
  z: number;
  /** z of the gore on the main route, or null for off-corridor nodes */
  mainZ: number | null;
  in: number[];
  out: number[];
}

export interface SurfaceHit {
  y: number;
  edgeId: number;
  s: number;
  /** signed lateral offset, positive toward the station normal (+lat) */
  lat: number;
  bank: number;
}

/* ---- the two new junctions on the main route ---------------------------- */

/** Gore nose of the bypass diverge (west side, like the town exit). Sits in
    the corridor's straight window past the town, clear of the spawn band. */
export const DIVERGE_Z = 500;
/** Gore nose of the bypass merge — from the EAST, into the fast lane, just
    after the toll plaza's pitch taper has settled. Shuto-style right merge. */
export const MERGE_Z = 1580;

/** Bypass cross-section. Two lanes plus a narrow shoulder: a sporty elevated
    carriageway, deliberately tighter than the main deck. */
export const BYPASS = {
  lanes: 2,
  laneW: LANE_W,
  shoulder: 1.0,
  /** pavement half width when fully open */
  half: (2 * LANE_W) / 2 + 1.0,
  /** gore taper length: pavement opens/closes over this many metres */
  nose: 16,
  /** structural deck thickness — the bridge's underside is y − deckT */
  deckT: 1.1,
  /** min clear height demanded over the main pavement at the crossing */
  minClear: 6.5,
  /** pier spacing along the viaduct, metres of arclength */
  pierEvery: 36,
};

/* Horizontal plan, as lateral offset from the MAIN centreline over u = main z.
   Starts at the west deck edge, swings out past the frontage line, then one
   big bend carries it back east across the deck (the bridge), a weave along
   the east frontage strip, and an approach bend back to the east deck edge.
   The first and last deltas are computed at build time so the ends land at
   exactly (halfWidth + 0.6) off the deck edge whatever the lane schedule says. */
const LAT_BENDS: Bend[] = [
  { z0: 506, z1: 700, d: -17 }, // separate west
  { z0: 750, z1: 950, d: +88 }, // the crossing — lat passes 0 near u ≈ 828
  { z0: 980, z1: 1100, d: -16 }, // weave out…
  { z0: 1120, z1: 1240, d: +18 }, // …and back over the east frontage strip
  { z0: 1240, z1: 1360, d: -14 },
  { z0: 1400, z1: 1560, d: 0 }, // approach; delta computed in buildBypass()
];

/* Vertical profile. Climbs only after the pavement has fully separated from
   the deck (u ≈ 580), crests at +12 over the crossing and the viaduct, dips
   once for rhythm, and is back at deck height and dead level well before the
   merge gore. Peak grade ≈ 5.4% — steeper than the main route's 3.8%, which
   is part of the bypass's character. Last delta computed so the end height
   matches the deck exactly. */
const Y_BENDS: Bend[] = [
  { z0: 580, z1: 1000, d: +12 },
  { z0: 1040, z1: 1160, d: -3 },
  { z0: 1200, z1: 1530, d: 0 }, // computed in buildBypass()
];

/** parameter range: gore nose to the end of the merge taper */
const U0 = DIVERGE_Z;
const U1 = MERGE_Z + 8;
const U_STEP = 4;

/** Superelevation: e ≈ v²/(g·R) at the bypass's design speed, capped at 8%.
    Expressed directly as dy/dlat so no trig is needed downstream. */
const BANK_V2_OVER_G = 111; // (33 m/s)² / 9.81
const BANK_MAX = 0.08;
/** banking fades to zero within this arclength of each gore */
const BANK_FADE = 60;

/* ---- edges -------------------------------------------------------------- */

/** Same out-parameter contract as corridor.pose: pass `out` on hot paths,
    omit it and get a fresh object (never a shared scratch — aliasing bugs). */
function poseScratch(out?: RoutePose): RoutePose {
  return (
    out || { x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: 1, nz: 0, h: 0, grade: 0, bank: 0 }
  );
}

export abstract class RouteEdge {
  constructor(
    readonly id: number,
    readonly name: string,
    readonly kind: EdgeKind,
    /** node ids */
    readonly from: number,
    readonly to: number,
  ) {}
  /** arclength of the edge */
  abstract readonly len: number;
  abstract poseAt(s: number, out?: RoutePose): RoutePose;
  abstract laneCount(s: number): number;
  abstract lanePitch(s: number): number;
  /** symmetric drivable half-width (the tighter side through gore wedges) */
  abstract halfWidth(s: number): number;
  /** surface height under a world point, or null off this edge's pavement */
  abstract heightAt(x: number, z: number, pad?: number): number | null;
  /** inverse mapping onto this edge, or null when beyond `maxLat` of it */
  abstract project(
    x: number,
    z: number,
    maxLat?: number,
  ): { s: number; lat: number } | null;

  lanes(s: number) {
    return Math.max(1, Math.round(this.laneCount(s)));
  }
  laneOffset(k: number, s: number) {
    return (k - (this.laneCount(s) - 1) / 2) * this.lanePitch(s);
  }
  laneEdge(k: number, s: number) {
    return this.laneOffset(k, s) - this.lanePitch(s) / 2;
  }
  /** private scratch for worldOf's intermediate pose — never handed out, and
      read back before worldOf returns, so it cannot alias a caller's pose */
  private _wp: RoutePose = poseScratch();
  worldOf(s: number, lat: number, out?: { x: number; y: number; z: number }) {
    const p = this.poseAt(s, this._wp);
    const o = out || { x: 0, y: 0, z: 0 };
    o.x = p.x + lat * p.nx;
    o.y = p.y + lat * p.bank;
    o.z = p.z + lat * p.nz;
    return o;
  }
  /** s values every `pitch` metres (edge-local; no splice constraint — new
      edges never cross the seam, which is exactly why this can be simple) */
  sLattice(pitch: number, phase = 0): number[] {
    const out: number[] = [];
    for (let s = phase; s <= this.len; s += pitch) out.push(s);
    return out;
  }
  /** centreline polyline for nav/minimap drawing, [x0,y0,z0, x1,…] */
  polyline(step = 12): Float32Array {
    const n = Math.max(2, Math.ceil(this.len / step) + 1);
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = this.poseAt((i / (n - 1)) * this.len);
      a[i * 3] = p.x;
      a[i * 3 + 1] = p.y;
      a[i * 3 + 2] = p.z;
    }
    return a;
  }
}

/** A main-route segment between two junctions. Pure delegation to the
    Corridor — the loop stays bit-identical to today by construction. Its
    station space is the corridor's own arclength; `zAtS`/`sAtZ` convert to
    the z-space every existing consumer already thinks in. The seam edge's
    z-window runs past Z1 and is folded by wrapZ per query. */
export class MainRouteEdge extends RouteEdge {
  readonly len: number;
  private s0: number;
  constructor(
    id: number,
    name: string,
    from: number,
    to: number,
    readonly cor: Corridor,
    /** unwrapped z-window; z1 may exceed Z1 (the seam edge) but z1−z0 < LOOP */
    readonly z0: number,
    readonly z1: number,
  ) {
    super(id, name, "main", from, to);
    this.s0 = this.rawS(z0);
    this.len = this.rawS(z1) - this.s0;
  }
  /** corridor arclength of an unwrapped z ≥ this.z0, accumulating one wrap */
  private rawS(z: number) {
    const c = this.cor;
    if (z <= c.Z1) return c.sOfZ(z);
    return c.sOfZ(c.Z1) + (c.sOfZ(z - c.LOOP) - c.sOfZ(c.Z0));
  }
  /** canonical (wrapped) main-route z at edge arclength s */
  zAtS(s: number) {
    const c = this.cor;
    const sAbs = this.s0 + Math.max(0, Math.min(this.len, s));
    const sEnd = c.sOfZ(c.Z1);
    if (sAbs <= sEnd) return c.zOfS(sAbs);
    return c.zOfS(c.sOfZ(c.Z0) + (sAbs - sEnd));
  }
  /** edge arclength of a canonical z, or null if z is outside the window */
  sAtZ(z: number): number | null {
    const c = this.cor;
    const zw = c.wrapZ(z);
    for (const cand of [zw, zw + c.LOOP])
      if (cand >= this.z0 - 1e-9 && cand <= this.z1 + 1e-9)
        return this.rawS(cand) - this.s0;
    return null;
  }
  poseAt(s: number, out?: RoutePose): RoutePose {
    const o = poseScratch(out);
    const p = this.cor.pose(this.zAtS(s));
    o.x = p.x;
    o.y = p.y;
    o.z = p.z;
    o.tx = p.tx;
    o.tz = p.tz;
    o.nx = p.nx;
    o.nz = p.nz;
    o.h = p.h;
    o.grade = p.grade;
    o.bank = 0;
    return o;
  }
  laneCount(s: number) {
    return this.cor.laneCount(this.zAtS(s));
  }
  lanePitch(s: number) {
    return this.cor.lanePitch(this.zAtS(s));
  }
  halfWidth(s: number) {
    return this.cor.halfWidth(this.zAtS(s));
  }
  heightAt(x: number, z: number, pad = 0) {
    const y = this.cor.heightAt(x, z, pad);
    if (y === null) return null;
    return this.sAtZ(this.cor.zAt(x, z)) === null ? null : y;
  }
  project(x: number, z: number, maxLat = 60) {
    const zc = this.cor.zAt(x, z);
    const lat = this.cor.latAt(x, z);
    if (Math.abs(lat) > maxLat) return null;
    const s = this.sAtZ(zc);
    return s === null ? null : { s, lat };
  }
}

/** centreline segments per project() bounding block */
const SEG_BLK = 16;

/** Any station-sampled route segment: the bypass, the two connector ramps and
    the frontage link all use this. Geometry queries interpolate the stations;
    the inverse mapping scans segments with a bbox reject, exactly the pattern
    rampAt() uses today. */
export class PolyRouteEdge extends RouteEdge {
  readonly len: number;
  readonly x0: number;
  readonly x1: number;
  readonly zb0: number;
  readonly zb1: number;
  constructor(
    id: number,
    name: string,
    kind: EdgeKind,
    from: number,
    to: number,
    readonly stations: RouteStation[],
    private nfBase: number,
    private pitch: number,
    /** street edges are topological: traffic must drive the RoadNet instead */
    readonly viaRoadNet = false,
  ) {
    super(id, name, kind, from, to);
    this.len = stations[stations.length - 1].s;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const p of stations) {
      const r = Math.max(p.hwL, p.hwR) + 1;
      x0 = Math.min(x0, p.x - r);
      x1 = Math.max(x1, p.x + r);
      z0 = Math.min(z0, p.z - r);
      z1 = Math.max(z1, p.z + r);
    }
    this.x0 = x0;
    this.x1 = x1;
    this.zb0 = z0;
    this.zb1 = z1;

    /* Segment and block bounding boxes for project(). A point outside a
       segment's box inflated by the current best distance cannot be closer to
       that segment than that distance, so skipping it is exactly the `continue`
       the full scan would have taken — the answer is unchanged, the scan just
       stops paying a hypot for the ~1100 m of viaduct it is nowhere near. */
    const nSeg = Math.max(0, stations.length - 1);
    const nBlk = Math.ceil(nSeg / SEG_BLK);
    const sb = (this.segBox = new Float64Array(nSeg * 4));
    const bb = (this.blkBox = new Float64Array(nBlk * 4));
    for (let k = 0; k < nBlk; k++) {
      bb[k * 4] = 1e9; bb[k * 4 + 1] = -1e9;
      bb[k * 4 + 2] = 1e9; bb[k * 4 + 3] = -1e9;
    }
    for (let i = 0; i < nSeg; i++) {
      const a = stations[i], b = stations[i + 1];
      const ax0 = Math.min(a.x, b.x), ax1 = Math.max(a.x, b.x);
      const az0 = Math.min(a.z, b.z), az1 = Math.max(a.z, b.z);
      sb[i * 4] = ax0; sb[i * 4 + 1] = ax1;
      sb[i * 4 + 2] = az0; sb[i * 4 + 3] = az1;
      const q = ((i / SEG_BLK) | 0) * 4;
      if (ax0 < bb[q]) bb[q] = ax0;
      if (ax1 > bb[q + 1]) bb[q + 1] = ax1;
      if (az0 < bb[q + 2]) bb[q + 2] = az0;
      if (az1 > bb[q + 3]) bb[q + 3] = az1;
    }
  }
  /** [x0, x1, z0, z1] per centreline segment, and per block of SEG_BLK */
  private readonly segBox: Float64Array;
  private readonly blkBox: Float64Array;
  /** interpolation fraction left behind by locate(); see its contract */
  segT = 0;
  /** Non-allocating stationAt: returns the index of the station at or before
      `s` (its partner is the next one) and leaves the fraction in `segT`.
      Read the index and `segT` out before calling anything else on this edge —
      the next locate() overwrites `segT`. */
  locate(s: number): number {
    const st = this.stations;
    s = Math.max(0, Math.min(this.len, s));
    let lo = 0, hi = st.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (st[mid].s <= s) lo = mid;
      else hi = mid;
    }
    const a = st[lo], b = st[hi];
    this.segT = Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s || 1)));
    return lo;
  }
  stationAt(s: number): { a: RouteStation; b: RouteStation; t: number } {
    const st = this.stations;
    const i = this.locate(s);
    return { a: st[i], b: st[i + 1] ?? st[i], t: this.segT };
  }
  poseAt(s: number, out?: RoutePose): RoutePose {
    const st = this.stations;
    const i = this.locate(s);
    const a = st[i], b = st[i + 1] ?? a, t = this.segT;
    const o = poseScratch(out);
    o.x = a.x + (b.x - a.x) * t;
    o.y = a.y + (b.y - a.y) * t;
    o.z = a.z + (b.z - a.z) * t;
    const tx = a.tx + (b.tx - a.tx) * t;
    const tz = a.tz + (b.tz - a.tz) * t;
    const inv = 1 / (Math.hypot(tx, tz) || 1);
    o.tx = tx * inv;
    o.tz = tz * inv;
    o.nx = o.tz;
    o.nz = -o.tx;
    o.h = Math.atan2(o.tx, o.tz);
    o.grade = a.grade + (b.grade - a.grade) * t;
    o.bank = a.bank + (b.bank - a.bank) * t;
    return o;
  }
  laneCount(_s: number) {
    return this.nfBase;
  }
  lanePitch(_s: number) {
    return this.pitch;
  }
  halfWidth(s: number) {
    const st = this.stations;
    const i = this.locate(s);
    const a = st[i], b = st[i + 1] ?? a, t = this.segT;
    return Math.min(a.hwL + (b.hwL - a.hwL) * t, a.hwR + (b.hwR - a.hwR) * t);
  }
  /** asymmetric half-widths, for mesh sweeping through the gore wedges */
  halfWidths(s: number): { hwL: number; hwR: number } {
    const st = this.stations;
    const i = this.locate(s);
    const a = st[i], b = st[i + 1] ?? a, t = this.segT;
    return {
      hwL: a.hwL + (b.hwL - a.hwL) * t,
      hwR: a.hwR + (b.hwR - a.hwR) * t,
    };
  }
  project(x: number, z: number, maxLat = 30) {
    if (
      x < this.x0 - maxLat || x > this.x1 + maxLat ||
      z < this.zb0 - maxLat || z > this.zb1 + maxLat
    )
      return null;
    const st = this.stations;
    const sb = this.segBox, bb = this.blkBox;
    const nSeg = st.length - 1;
    let bd = maxLat, bs = -1, bl = 0;
    /* blocks then segments, in index order — same visit order as the old full
       scan, so a tie still resolves to the earliest segment */
    for (let i0 = 0, q = 0; i0 < nSeg; i0 += SEG_BLK, q += 4) {
      if (
        x < bb[q] - bd || x > bb[q + 1] + bd ||
        z < bb[q + 2] - bd || z > bb[q + 3] + bd
      )
        continue;
      const i1 = Math.min(i0 + SEG_BLK, nSeg);
      for (let i = i0; i < i1; i++) {
        const p = i * 4;
        if (
          x < sb[p] - bd || x > sb[p + 1] + bd ||
          z < sb[p + 2] - bd || z > sb[p + 3] + bd
        )
          continue;
        const a = st[i], b = st[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1e-9) continue;
        let t = ((x - a.x) * dx + (z - a.z) * dz) / d2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = x - (a.x + dx * t), pz = z - (a.z + dz * t);
        const d = Math.hypot(px, pz);
        if (d >= bd) continue;
        bd = d;
        bs = a.s + (b.s - a.s) * t;
        bl = px * a.nx + pz * a.nz;
      }
    }
    return bs < 0 ? null : { s: bs, lat: bl };
  }
  heightAt(x: number, z: number, pad = 0) {
    const hit = this.project(x, z, Math.max(BYPASS.half, RAMP_W / 2) + pad + 2);
    if (!hit) return null;
    const st = this.stations;
    const i = this.locate(hit.s);
    const a = st[i], b = st[i + 1] ?? a, t = this.segT;
    const hwL = a.hwL + (b.hwL - a.hwL) * t;
    const hwR = a.hwR + (b.hwR - a.hwR) * t;
    if (hit.lat > hwL + pad || hit.lat < -(hwR + pad)) return null;
    const bank = a.bank + (b.bank - a.bank) * t;
    return a.y + (b.y - a.y) * t + hit.lat * bank;
  }
}

/* ---- bridge crossings and piers ----------------------------------------- */

export interface BridgeCrossing {
  /** main-route z window shadowed by the bypass deck */
  z0: number;
  z1: number;
  /** main-route z under the bypass centreline's lat = 0 point */
  zMid: number;
  /** bypass edge arclength at zMid */
  sMid: number;
  /** deck heights at zMid */
  mainY: number;
  bridgeY: number;
  /** bridge underside minus main deck, minimum over the whole shadow */
  minClear: number;
}

export interface Pier {
  x: number;
  z: number;
  /** underside of the carried deck — the pier runs from the ground to here */
  topY: number;
  /** bypass arclength, for spacing/debugging */
  s: number;
}

/* ---- the graph ----------------------------------------------------------- */

export class RouteGraph {
  readonly cor: Corridor;
  readonly nodes: RouteNode[] = [];
  readonly edges: RouteEdge[] = [];
  /** the bypass — edge id BYPASS_EDGE, typed for direct access */
  readonly bypass: PolyRouteEdge;
  readonly crossings: BridgeCrossing[];
  /** the ramps the graph wrapped (flat-ground build — exact in this zone) */
  readonly ramps: Ramp[];

  constructor() {
    const cor = (this.cor = getCorridor());
    this.ramps = buildRamps(() => 0);
    const exitRamp = this.ramps.find((r) => r.kind === "exit")!;
    const entryRamp = this.ramps.find((r) => r.kind === "entry")!;

    const bypassSt = buildBypass(cor);
    const bStart = bypassSt[0], bEnd = bypassSt[bypassSt.length - 1];

    /* nodes */
    const node = (
      name: string,
      kind: RouteNode["kind"],
      x: number,
      y: number,
      z: number,
      mainZ: number | null,
    ) => {
      const n: RouteNode = {
        id: this.nodes.length, name, kind, x, y, z, mainZ, in: [], out: [],
      };
      this.nodes.push(n);
      return n;
    };
    const exG = exitRamp.pts[0];
    const enG = entryRamp.pts[0];
    const nExit = node("exit-gore", "diverge", exG.x, exG.y, exG.z, CONNECT_Z[0]);
    const nEntry = node("entry-gore", "merge", enG.x, enG.y, enG.z, CONNECT_Z[1]);
    const nDiv = node("bypass-diverge", "diverge", bStart.x, bStart.y, bStart.z, DIVERGE_Z);
    const nMrg = node("bypass-merge", "merge", bEnd.x, bEnd.y, bEnd.z, MERGE_Z);
    const nExitFoot = node(
      "exit-foot", "foot", exitRamp.footX, exitRamp.pts[exitRamp.pts.length - 1].y,
      exitRamp.footZ, null,
    );
    const nEntryFoot = node(
      "entry-foot", "foot", entryRamp.footX, entryRamp.pts[entryRamp.pts.length - 1].y,
      entryRamp.footZ, null,
    );

    /* edges */
    const add = (e: RouteEdge) => {
      this.edges.push(e);
      this.nodes[e.from].out.push(e.id);
      this.nodes[e.to].in.push(e.id);
      return e;
    };
    add(new MainRouteEdge(
      0, "main/seam", nMrg.id, nExit.id, cor, MERGE_Z, CONNECT_Z[0] + cor.LOOP,
    ));
    add(new MainRouteEdge(1, "main/town", nExit.id, nEntry.id, cor, CONNECT_Z[0], CONNECT_Z[1]));
    add(new MainRouteEdge(2, "main/climb", nEntry.id, nDiv.id, cor, CONNECT_Z[1], DIVERGE_Z));
    add(new MainRouteEdge(3, "main/tunnel-toll", nDiv.id, nMrg.id, cor, DIVERGE_Z, MERGE_Z));
    this.bypass = add(new PolyRouteEdge(
      4, "bypass", "detour", nDiv.id, nMrg.id, bypassSt, BYPASS.lanes, BYPASS.laneW,
    )) as PolyRouteEdge;
    add(new PolyRouteEdge(
      5, "exit-ramp", "ramp", nExit.id, nExitFoot.id,
      rampStations(exitRamp, false), 1, RAMP_W - 2,
    ));
    add(new PolyRouteEdge(
      6, "frontage-link", "street", nExitFoot.id, nEntryFoot.id,
      frontageStations(exitRamp.footZ, entryRamp.footZ), 2, 3.9, true,
    ));
    add(new PolyRouteEdge(
      7, "entry-ramp", "ramp", nEntryFoot.id, nEntry.id,
      rampStations(entryRamp, true), 1, RAMP_W - 2,
    ));

    this.crossings = findCrossings(cor, this.bypass);
  }

  edge(id: number) {
    return this.edges[id];
  }
  node(id: number) {
    return this.nodes[id];
  }
  outEdges(nodeId: number): RouteEdge[] {
    return this.nodes[nodeId].out.map((i) => this.edges[i]);
  }
  /** edges a driver can continue onto after finishing `edgeId` */
  nextEdges(edgeId: number): RouteEdge[] {
    return this.outEdges(this.edges[edgeId].to);
  }

  /** The next junction node downstream of a main-route z (wrapped), and the
      distance to it. What traffic wants for route choice and blinkers. */
  nextJunctionOnMain(z: number): { node: RouteNode; dz: number } {
    const zw = this.cor.wrapZ(z);
    let best: RouteNode | null = null, bd = Infinity;
    for (const n of this.nodes) {
      if (n.mainZ === null) continue;
      let d = n.mainZ - zw;
      if (d < 0) d += this.cor.LOOP;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return { node: best!, dz: bd };
  }

  /** Surface height of NEW pavement (the bypass only) under a world point.
      The main deck and the two town ramps keep answering through their
      existing channels (corridor.heightAt / rampAt), so wiring this into
      terrain.heightAt cannot double-report a surface that is already there. */
  surfaceAt(x: number, z: number, pad = 0): SurfaceHit | null {
    const e = this.bypass;
    const hit = e.project(x, z, BYPASS.half + pad + 2);
    if (!hit) return null;
    const st = e.stations;
    const i = e.locate(hit.s);
    const a = st[i], b = st[i + 1] ?? a, t = e.segT;
    const hwL = a.hwL + (b.hwL - a.hwL) * t;
    const hwR = a.hwR + (b.hwR - a.hwR) * t;
    if (hit.lat > hwL + pad || hit.lat < -(hwR + pad)) return null;
    const bank = a.bank + (b.bank - a.bank) * t;
    return {
      y: a.y + (b.y - a.y) * t + hit.lat * bank,
      edgeId: e.id,
      s: hit.s,
      lat: hit.lat,
      bank,
    };
  }

  /** Distance from a point to the nearest bypass station (capped) — building
      keep-out for town/frontage dressing, the same job distToRamp does. */
  distToNew(x: number, z: number, max: number): number {
    const e = this.bypass;
    if (
      x < e.x0 - max || x > e.x1 + max ||
      z < e.zb0 - max || z > e.zb1 + max
    )
      return max;
    let best = max;
    for (const p of e.stations) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best) best = d;
    }
    return best;
  }

  /** Where the main deck's parapet must be cut for the new gores — collide.ts
      exemptions and the stage-2 parapet mesh both read this. side: +1 = east
      (+lat, the merge), −1 = west (−lat, the diverge). Existing ramps keep
      using parapetGap(); these are only the NEW gaps. */
  newParapetGaps(): { z0: number; z1: number; side: 1 | -1 }[] {
    const c = this.cor;
    const e = this.bypass;
    /* the gap spans while the bypass pavement touches the deck edge */
    let divEnd = DIVERGE_Z + 30, mrgStart = MERGE_Z - 30;
    for (const p of e.stations) {
      const zc = c.zAt(p.x, p.z);
      const latC = c.latAt(p.x, p.z);
      const gap = Math.abs(latC) - c.halfWidth(zc);
      const dy = Math.abs(p.y - c.centerY(zc));
      if (dy < 2 && gap < BYPASS.half + 0.4) {
        if (latC < 0) divEnd = Math.max(divEnd, zc + 4);
        else mrgStart = Math.min(mrgStart, zc - 4);
      }
    }
    return [
      { z0: DIVERGE_Z - 8, z1: divEnd, side: -1 },
      { z0: mrgStart, z1: MERGE_Z + 8, side: 1 },
    ];
  }

  /** The window (bypass arclength) where a merging car can slot onto the main
      deck: pavements touching, height matched. */
  mergeWindow(): { s0: number; s1: number } {
    const c = this.cor;
    const e = this.bypass;
    let s0 = e.len - 40, s1 = e.len - 4;
    for (const p of e.stations) {
      const zc = c.zAt(p.x, p.z);
      const latC = c.latAt(p.x, p.z);
      if (latC <= 0) continue;
      const gap = latC - c.halfWidth(zc);
      if (gap < BYPASS.half && Math.abs(p.y - c.centerY(zc)) < 0.4) {
        s0 = Math.min(s0, p.s);
        break;
      }
    }
    return { s0, s1 };
  }

  /** Viaduct piers: one every BYPASS.pierEvery metres wherever the bypass is
      clear of the main pavement. `gh` is the bare terrain height field (pass
      terrain.h at build time; () => 0 is exact for tests — the whole corridor
      band is flattened). Returns positions + the clear-span windows where the
      bridge crosses the deck and piers must NOT stand. */
  piers(gh: (x: number, z: number) => number = () => 0): {
    piers: Pier[];
    spans: { s0: number; s1: number }[];
  } {
    const e = this.bypass;
    const c = this.cor;
    const piers: Pier[] = [];
    const spans: { s0: number; s1: number }[] = [];
    let spanStart: number | null = null;
    const step = BYPASS.pierEvery;
    for (let s = step / 2; s < e.len - step / 4; s += step) {
      const p = e.poseAt(s);
      const zc = c.zAt(p.x, p.z);
      const latC = c.latAt(p.x, p.z);
      const overDeck =
        Math.abs(latC) < c.halfWidth(zc) + 3 && p.y - c.centerY(zc) > 3;
      const nearDeckLevel =
        Math.abs(latC) < c.halfWidth(zc) + BYPASS.half + 1 &&
        Math.abs(p.y - c.centerY(zc)) <= 3;
      if (overDeck) {
        if (spanStart === null) spanStart = s - step / 2;
        continue;
      }
      if (spanStart !== null) {
        spans.push({ s0: spanStart, s1: s - step / 2 });
        spanStart = null;
      }
      if (nearDeckLevel) continue; // gore wedges: the deck's own piers carry it
      const gy = gh(p.x, p.z);
      if (p.y - BYPASS.deckT - gy < 2) continue;
      piers.push({ x: p.x, z: p.z, topY: p.y - BYPASS.deckT, s });
    }
    if (spanStart !== null) spans.push({ s0: spanStart, s1: e.len });
    return { piers, spans };
  }

  /** every route centreline, for the minimap / nav screens */
  polylines(): { edgeId: number; kind: EdgeKind; pts: Float32Array }[] {
    return this.edges.map((e) => ({
      edgeId: e.id,
      kind: e.kind,
      pts: e.polyline(e.kind === "main" ? 24 : 12),
    }));
  }

  /** The canonical driving loops, as edge-id cycles. Every cycle starts and
      ends at the same node; tests assert they close. */
  loops(): { name: string; edges: number[] }[] {
    return [
      { name: "main", edges: [2, 3, 0, 1] },
      { name: "bypass", edges: [2, 4, 0, 1] },
      /* off at the town exit, along the frontage road, back on at the entry
         gore, then once around the expressway to the exit again */
      { name: "town", edges: [5, 6, 7, 2, 3, 0] },
    ];
  }

  /** Throws unless the graph is closed: every node flows on, every edge is
      reachable from every other, and every declared loop actually cycles. */
  assertClosed() {
    for (const n of this.nodes) {
      if (!n.out.length) throw new Error(`routegraph: node ${n.name} is a dead end`);
      if (!n.in.length) throw new Error(`routegraph: node ${n.name} is unreachable`);
    }
    for (const start of this.edges) {
      const seen = new Set<number>([start.id]);
      const stack = [start.id];
      while (stack.length) {
        const e = this.edges[stack.pop()!];
        for (const nx of this.nodes[e.to].out)
          if (!seen.has(nx)) {
            seen.add(nx);
            stack.push(nx);
          }
      }
      if (seen.size !== this.edges.length)
        throw new Error(
          `routegraph: only ${seen.size}/${this.edges.length} edges reachable from ${start.name}`,
        );
    }
    for (const loop of this.loops()) {
      let at = this.edges[loop.edges[0]].from;
      for (const id of loop.edges) {
        const e = this.edges[id];
        if (e.from !== at)
          throw new Error(`routegraph: loop ${loop.name} breaks at edge ${e.name}`);
        at = e.to;
      }
      if (at !== this.edges[loop.edges[0]].from)
        throw new Error(`routegraph: loop ${loop.name} does not close`);
    }
  }
}

/* ---- builders ------------------------------------------------------------ */

function buildBypass(cor: Corridor): RouteStation[] {
  const lat0 = -(cor.halfWidth(DIVERGE_Z) + 0.6);
  const latEnd = cor.halfWidth(MERGE_Z) + 0.6;
  /* close the composed deltas so the ends land exactly on the deck edges and
     at exactly deck height, whatever the lane/pitch schedule currently says */
  const latBends = LAT_BENDS.map((b) => ({ ...b }));
  {
    let sum = 0;
    for (let i = 0; i < latBends.length - 1; i++) sum += latBends[i].d;
    latBends[latBends.length - 1].d = latEnd - (lat0 + sum);
  }
  const y0 = cor.centerY(DIVERGE_Z);
  const yEnd = cor.centerY(MERGE_Z);
  const yBends = Y_BENDS.map((b) => ({ ...b }));
  {
    let sum = 0;
    for (let i = 0; i < yBends.length - 1; i++) sum += yBends[i].d;
    yBends[yBends.length - 1].d = yEnd - (y0 + sum);
  }

  /* sample the centreline */
  const raw: { x: number; y: number; z: number }[] = [];
  for (let u = U0; u <= U1 + 0.001; u += U_STEP) {
    const p = cor.pose(u);
    const lat = lat0 + bendSum(latBends, u);
    raw.push({
      x: p.x + lat * p.nx,
      y: y0 + bendSum(yBends, u),
      z: p.z + lat * p.nz,
    });
  }

  /* stations: arclength, frames, widths, banking */
  const st: RouteStation[] = [];
  let acc = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.hypot(dx, dz) || 1;
    if (i > 0) acc += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
    const tx = dx / d, tz = dz / d;
    st.push({
      x: raw[i].x, y: raw[i].y, z: raw[i].z, tx, tz, nx: tz, nz: -tx,
      s: acc, nf: BYPASS.lanes, hwL: BYPASS.half, hwR: BYPASS.half,
      bank: 0, grade: 0,
    });
  }
  const len = acc;

  /* grades from neighbours */
  for (let i = 0; i < st.length; i++) {
    const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
    st[i].grade = (b.y - a.y) / Math.max(0.01, b.s - a.s);
  }

  /* pavement clipping: while the bypass runs at deck height beside the deck,
     its inner half-width is clipped to the gap so the two pavements meet at
     the deck edge and never overlap — the same rule buildRamps applies. The
     outer side opens/closes over the gore noses. */
  for (const p of st) {
    const zc = cor.zAt(p.x, p.z);
    const latC = cor.latAt(p.x, p.z);
    const dy = Math.abs(p.y - cor.centerY(zc));
    if (dy < 4) {
      const gap = Math.abs(latC) - cor.halfWidth(zc);
      if (latC < 0) p.hwL = Math.min(p.hwL, Math.max(0, gap)); // deck to the east
      else p.hwR = Math.min(p.hwR, Math.max(0, gap)); // deck to the west
    }
    // gore-nose tapers: outer side widens out of / narrows into the deck edge
    p.hwR = Math.min(p.hwR, BYPASS.half * sst(p.s / BYPASS.nose));
    p.hwL = Math.min(p.hwL, BYPASS.half * sst((len - p.s) / BYPASS.nose));
  }

  /* superelevation from smoothed curvature, faded to zero at the gores so the
     junction cross-sections match the flat deck exactly */
  const kappa: number[] = st.map((_, i) => {
    const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
    const ha = Math.atan2(a.tx, a.tz), hb = Math.atan2(b.tx, b.tz);
    let dh = hb - ha;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return dh / Math.max(0.01, b.s - a.s);
  });
  for (let i = 0; i < st.length; i++) {
    let k = 0, n = 0;
    for (let j = Math.max(0, i - 5); j <= Math.min(st.length - 1, i + 5); j++) {
      k += kappa[j];
      n++;
    }
    k /= n;
    /* inside of the curve lower: turning left (k > 0, toward +lat) drops the
       +lat side, so dy/dlat is negative */
    let bank = -Math.sign(k) * Math.min(BANK_MAX, BANK_V2_OVER_G * Math.abs(k) * 0.5);
    /* dead flat through both gore wedges (not merely fading at the very ends):
       the junction cross-sections must match the unbanked deck exactly */
    bank *=
      sst((st[i].s - 2 * BYPASS.nose) / BANK_FADE) *
      sst((len - 2 * BYPASS.nose - st[i].s) / BANK_FADE);
    st[i].bank = bank;
  }
  return st;
}

/** Wrap a corridor connector ramp (ramps.ts) as a graph edge. Entry ramps are
    stored gore-outward, so they are reversed into travel order (foot → gore). */
function rampStations(r: Ramp, reverse: boolean): RouteStation[] {
  const pts = reverse ? [...r.pts].reverse() : r.pts;
  const st: RouteStation[] = [];
  const total = r.len;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const s = reverse ? total - p.s : p.s;
    /* travel-order tangent; the stored one points gore → foot */
    const tx = reverse ? -p.tx : p.tx;
    const tz = reverse ? -p.tz : p.tz;
    /* the ramp's stored normal already points at the deck on both kinds and
       equals (tz, -tx) in travel order — see ramps.ts sgn = mir * dir */
    st.push({
      x: p.x, y: p.y, z: p.z, tx, tz, nx: tz, nz: -tx, s,
      /* the stored normal points at the deck and equals (tz, -tx) in travel
         order for both kinds (ramps.ts sgn = mir * dir), so hIn is the +lat
         side and hOut the −lat side unconditionally */
      nf: 1, hwL: p.hIn, hwR: p.hOut,
      bank: 0, grade: 0,
    });
  }
  for (let i = 0; i < st.length; i++) {
    const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
    st[i].grade = (b.y - a.y) / Math.max(0.01, Math.abs(b.s - a.s));
  }
  return st;
}

/** The west frontage road between the two ramp feet. Topological: the real
    pavement, heights and traffic live in the RoadNet — this polyline exists so
    the graph closes and the nav layer can draw the connection. The ground is
    exactly flat here (the terrain flattens the whole corridor band). */
function frontageStations(zFrom: number, zTo: number): RouteStation[] {
  const st: RouteStation[] = [];
  const n = Math.max(2, Math.ceil(Math.abs(zTo - zFrom) / 8));
  const dir = Math.sign(zTo - zFrom) || 1;
  for (let i = 0; i <= n; i++) {
    const z = zFrom + ((zTo - zFrom) * i) / n;
    st.push({
      x: FRONT_X, y: 0, z, tx: 0, tz: dir, nx: dir, nz: 0,
      s: Math.abs(z - zFrom), nf: 2, hwL: 5.5, hwR: 5.5, bank: 0, grade: 0,
    });
  }
  return st;
}

function findCrossings(cor: Corridor, e: PolyRouteEdge): BridgeCrossing[] {
  const out: BridgeCrossing[] = [];
  let cur: BridgeCrossing | null = null;
  let prevLat = 0;
  for (const p of e.stations) {
    const zc = cor.zAt(p.x, p.z);
    const latC = cor.latAt(p.x, p.z);
    const deckY = cor.centerY(zc);
    const hw = cor.halfWidth(zc);
    const over = Math.abs(latC) < hw + BYPASS.half && p.y - deckY > 3;
    if (over) {
      const clear = p.y - BYPASS.deckT - deckY;
      if (!cur) {
        cur = {
          z0: zc, z1: zc, zMid: zc, sMid: p.s,
          mainY: deckY, bridgeY: p.y, minClear: clear,
        };
        prevLat = latC;
      } else {
        cur.z0 = Math.min(cur.z0, zc);
        cur.z1 = Math.max(cur.z1, zc);
        cur.minClear = Math.min(cur.minClear, clear);
        if (prevLat !== 0 && Math.sign(latC) !== Math.sign(prevLat)) {
          cur.zMid = zc;
          cur.sMid = p.s;
          cur.mainY = deckY;
          cur.bridgeY = p.y;
        }
        if (latC !== 0) prevLat = latC;
      }
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ---- singleton ----------------------------------------------------------- */

/** Deterministic, like the corridor — nothing to seed. */
let _graph: RouteGraph | null = null;
export function getRouteGraph(): RouteGraph {
  if (!_graph) _graph = new RouteGraph();
  return _graph;
}

/** edge-id constants, so consumers don't scatter magic numbers */
export const MAIN_SEAM_EDGE = 0;
export const MAIN_TOWN_EDGE = 1;
export const MAIN_CLIMB_EDGE = 2;
export const MAIN_TUNNEL_EDGE = 3;
export const BYPASS_EDGE = 4;
export const EXIT_RAMP_EDGE = 5;
export const FRONTAGE_EDGE = 6;
export const ENTRY_RAMP_EDGE = 7;
