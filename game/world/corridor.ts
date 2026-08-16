import {
  HX, DECKY, HZ, LOOP_LEN, DECK_EXT, LANE_W, SHOULDER, MAX_LANES, CONNECT_Z,
} from "./const";

/* ============================================================================
   The expressway corridor: one deck, one direction of travel (+z).

   The whole alignment is a *graph over z*: the centreline is
   (HX + xOff(z), DECKY + yOff(z), z). That one decision buys a lot —
   traffic, the minimap, collision and spawning can all keep using z as their
   longitudinal coordinate, and, crucially, it makes the endless loop a pure
   translation: the corridor is built so that everything at z = -HZ is
   identical to everything at z = +HZ, so sending the player back by LOOP_LEN
   in z alone is an exact isometry. No rotation, no x fix-up.

   xOff/yOff are sums of smootherstep "bends": each bend has zero slope at both
   of its ends, so the stretches between bends are dead straight and level, and
   there is never a kink. Sum of all bend deltas is zero, which is what makes
   the two ends match.

   Everything visible (pavement, markings, barriers, tunnel, toll plaza, lights)
   is generated from the sampled stations in `stations`, so it cannot drift out
   of sync with what physics and traffic query.
   ========================================================================== */

/** smootherstep: zero 1st *and* 2nd derivative at both ends */
function sm(t: number) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function smD(t: number) {
  if (t <= 0 || t >= 1) return 0;
  return 30 * t * t * (t - 1) * (t - 1);
}

interface Bend {
  z0: number;
  z1: number;
  d: number;
}

/** Horizontal alignment. Deltas sum to zero; the straight windows between them
    are where the ramps, tunnel and toll plaza live. */
const X_BENDS: Bend[] = [
  { z0: -1500, z1: -1050, d: +62 },
  { z0: -900, z1: -430, d: -62 }, // ← dead straight from here: the ramp window
  { z0: -30, z1: 260, d: +34 },
  { z0: 600, z1: 880, d: -34 }, // ← straight from 880 on: tunnel, toll, splice
];

/** Vertical alignment. Max grade ≈ 3.8 %, which is steep enough to feel and
    flat enough to stay fast. */
const Y_BENDS: Bend[] = [
  { z0: -1550, z1: -1250, d: +5 },
  { z0: -1250, z1: -950, d: -5 },
  // level through the ramp window so the gores and the spawn sit at DECKY
  { z0: -30, z1: 200, d: +4 },
  { z0: 200, z1: 420, d: -4 },
  { z0: 600, z1: 900, d: -4 }, // dive toward the tunnel mouth…
  { z0: 940, z1: 1240, d: +4 }, // …and climb back out inside it
];

function bendSum(bends: Bend[], z: number) {
  let v = 0;
  for (const b of bends) v += b.d * sm((z - b.z0) / (b.z1 - b.z0));
  return v;
}
function bendSlope(bends: Bend[], z: number) {
  let v = 0;
  for (const b of bends) v += (b.d / (b.z1 - b.z0)) * smD((z - b.z0) / (b.z1 - b.z0));
  return v;
}

/** Lane-count schedule. Each entry widens or narrows over [z0, z1]; between
    entries the count is constant. `to` is the count after the transition. */
interface LaneStep {
  z0: number;
  z1: number;
  to: number;
}
const BASE_LANES = 3;
const LANE_STEPS: LaneStep[] = [
  { z0: -1550, z1: -1400, to: 2 }, // drop to two through the first sweeper
  { z0: -1150, z1: -1000, to: 3 },
  { z0: -520, z1: -380, to: 4 }, // fourth lane opens ahead of the exit
  { z0: 700, z1: 860, to: 3 }, // lane drop into the tunnel
  { z0: 1300, z1: 1400, to: 6 }, // toll plaza fan-out
  { z0: 1490, z1: 1620, to: 3 }, // merge back down to the splice width
];

/* ---- named features ---- */
export const TUNNEL = { z0: 920, z1: 1260 };
export const TOLL = { z0: 1280, z1: 1640, plazaZ0: 1400, plazaZ1: 1490 };

export interface CorridorPose {
  /** centreline point */
  x: number;
  y: number;
  z: number;
  /** unit tangent in the travel direction (+z) */
  tx: number;
  tz: number;
  /** unit lateral normal, pointing toward +x — which is the *driver's left*
      when travelling +z, and the side the town is not on */
  nx: number;
  nz: number;
  /** heading in the engine's convention: atan2(tx, tz) */
  h: number;
  /** grade, dy/ds */
  grade: number;
}

export interface Station {
  z: number;
  x: number;
  y: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  /** arclength from the first station */
  s: number;
  /** fractional lane count here */
  nf: number;
  /** pavement half-width */
  hw: number;
}

const STEP = 4; // station spacing, metres of z

export class Corridor {
  readonly Z0 = -HZ;
  readonly Z1 = HZ;
  readonly LOOP = LOOP_LEN;
  readonly EXT = DECK_EXT;
  readonly LANE_W = LANE_W;
  readonly MAX_LANES = MAX_LANES;
  /** built extent, including the overrun past each end */
  readonly ZB0 = -HZ - DECK_EXT;
  readonly ZB1 = HZ + DECK_EXT;
  readonly stations: Station[] = [];
  /** total arclength of one lap (≈ LOOP, a touch longer through the bends) */
  readonly lapLen: number;

  constructor() {
    let acc = 0, px = 0, pz = 0;
    for (let z = this.ZB0; z <= this.ZB1 + 0.001; z += STEP) {
      const x = this.centerX(z), y = this.centerY(z);
      const m = bendSlope(X_BENDS, z);
      const inv = 1 / Math.hypot(m, 1);
      const tx = m * inv, tz = inv;
      if (this.stations.length) acc += Math.hypot(x - px, z - pz);
      px = x;
      pz = z;
      const nf = this.laneCount(z);
      this.stations.push({
        z, x, y, tx, tz, nx: tz, nz: -tx, s: acc, nf,
        hw: (nf * LANE_W) / 2 + SHOULDER,
      });
    }
    const a = this.stations.find((q) => q.z >= this.Z0)!;
    const b = this.stations.find((q) => q.z >= this.Z1)!;
    this.lapLen = b.s - a.s;
  }

  /* ---- alignment ---- */
  xOff(z: number) {
    return bendSum(X_BENDS, z);
  }
  yOff(z: number) {
    return bendSum(Y_BENDS, z);
  }
  centerX(z: number) {
    return HX + bendSum(X_BENDS, z);
  }
  centerY(z: number) {
    return DECKY + bendSum(Y_BENDS, z);
  }
  /** dx/dz of the centreline */
  slopeX(z: number) {
    return bendSlope(X_BENDS, z);
  }

  pose(z: number, out?: CorridorPose): CorridorPose {
    const o = out || ({} as CorridorPose);
    const m = bendSlope(X_BENDS, z);
    const inv = 1 / Math.hypot(m, 1);
    o.x = this.centerX(z);
    o.y = this.centerY(z);
    o.z = z;
    o.tx = m * inv;
    o.tz = inv;
    o.nx = o.tz;
    o.nz = -o.tx;
    o.h = Math.atan2(m, 1);
    o.grade = bendSlope(Y_BENDS, z) * inv;
    return o;
  }

  /* ---- lanes ---- */
  /** fractional lane count — smooth through tapers so lane centres slide
      instead of jumping when a lane is added or dropped */
  laneCount(z: number) {
    let n = BASE_LANES;
    for (const st of LANE_STEPS) {
      const t = sm((z - st.z0) / (st.z1 - st.z0));
      n = n + (st.to - n) * t;
    }
    return n;
  }
  /** how many lanes a driver would say there are here */
  lanes(z: number) {
    return Math.max(2, Math.round(this.laneCount(z)));
  }
  /** Lateral offset of lane k's centre. Lane 0 is at the most negative offset
      — world −x, the town side, and the driver's *right* when travelling +z,
      so it is the slow lane and the one the ramps serve. Lane n−1 is the fast
      lane on the far side.

      Lanes stay centred on the alignment, so a taper slides every lane a
      little rather than shunting the whole roadway sideways. */
  laneOffset(k: number, z: number) {
    const nf = this.laneCount(z);
    return (k - (nf - 1) / 2) * LANE_W;
  }
  halfWidth(z: number) {
    return (this.laneCount(z) * LANE_W) / 2 + SHOULDER;
  }
  /** offset of the boundary between lane k-1 and lane k (k = 1..n-1) */
  laneEdge(k: number, z: number) {
    return this.laneOffset(k, z) - LANE_W / 2;
  }

  /* ---- world <-> corridor ---- */
  /** world point at (z, lateral offset) */
  worldOf(z: number, lat: number, out?: { x: number; y: number; z: number }) {
    const m = bendSlope(X_BENDS, z);
    const inv = 1 / Math.hypot(m, 1);
    const o = out || { x: 0, y: 0, z: 0 };
    o.x = this.centerX(z) + lat * inv;
    o.y = this.centerY(z);
    o.z = z - lat * m * inv;
    return o;
  }

  /** Inverse of worldOf: the z whose normal passes through (x, z). Two
      fixed-point steps are plenty — |dx/dz| never exceeds ~0.26. */
  zAt(x: number, z: number) {
    let zc = z;
    for (let i = 0; i < 2; i++) {
      const m = bendSlope(X_BENDS, zc);
      const inv = 1 / Math.hypot(m, 1);
      const nx = inv, nz = -m * inv;
      const lat = (x - this.centerX(zc)) * nx + (z - zc) * nz;
      zc = z - lat * nz;
    }
    return zc;
  }
  /** signed lateral offset of a world point from the centreline */
  latAt(x: number, z: number) {
    const zc = this.zAt(x, z);
    const m = bendSlope(X_BENDS, zc);
    const inv = 1 / Math.hypot(m, 1);
    return (x - this.centerX(zc)) * inv + (z - zc) * -m * inv;
  }

  /** Deck surface height under a world point, or null when it is off the
      pavement. `pad` widens the test (physics wants slack, queries don't). */
  heightAt(x: number, z: number, pad = 0): number | null {
    if (z < this.ZB0 - pad || z > this.ZB1 + pad) return null;
    if (Math.abs(x - HX) > 90) return null; // cheap reject, bends stay inside ±62
    const zc = this.zAt(x, z);
    const lat = this.latAt(x, z);
    if (Math.abs(lat) > this.halfWidth(zc) + pad) return null;
    return this.centerY(zc);
  }

  /* ---- arclength (for systems that want a metric s rather than z) ---- */
  sOfZ(z: number) {
    const i = Math.floor((z - this.ZB0) / STEP);
    const a = this.stations[Math.max(0, Math.min(this.stations.length - 2, i))];
    const b = this.stations[Math.max(1, Math.min(this.stations.length - 1, i + 1))];
    const t = (z - a.z) / (b.z - a.z || 1);
    return a.s + (b.s - a.s) * t;
  }
  zOfS(s: number) {
    let lo = 0, hi = this.stations.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.stations[mid].s <= s) lo = mid;
      else hi = mid;
    }
    const a = this.stations[lo], b = this.stations[hi];
    const t = (s - a.s) / (b.s - a.s || 1);
    return a.z + (b.z - a.z) * t;
  }

  /* ---- the endless loop ---- */
  /** true once the player has run past the canonical end and should be wrapped */
  shouldWrap(z: number) {
    return z >= this.Z1;
  }
  /** fold any z back into [Z0, Z1) */
  wrapZ(z: number) {
    let v = z;
    while (v >= this.Z1) v -= this.LOOP;
    while (v < this.Z0) v += this.LOOP;
    return v;
  }
  /** signed along-corridor distance from a to b, taking the shorter way round */
  deltaZ(a: number, b: number) {
    let d = b - a;
    while (d > this.LOOP / 2) d -= this.LOOP;
    while (d < -this.LOOP / 2) d += this.LOOP;
    return d;
  }

  /** Where to put a car that has to be placed back on the expressway: the
      middle lane at (a wrapped) z, facing down the corridor. Anything that
      used to hardcode `HX + LANE_OFF[1]` wants this instead — the centreline
      wanders by up to 62 m and the deck rises and falls by 5. */
  respawn(z: number, lane?: number) {
    const zc = this.wrapZ(z);
    const n = this.lanes(zc);
    const k = lane === undefined ? Math.floor(n / 2) : Math.max(0, Math.min(n - 1, lane));
    const p = this.worldOf(zc, this.laneOffset(k, zc));
    return { x: p.x, y: p.y, z: p.z, h: this.pose(zc).h };
  }

  /* ---- features, for anything that wants to react to them ---- */
  inTunnel(z: number) {
    return z > TUNNEL.z0 && z < TUNNEL.z1;
  }
  inToll(z: number) {
    return z > TOLL.z0 && z < TOLL.z1;
  }
  /** 0 outside the tunnel, 1 well inside — good for audio reverb / exposure */
  tunnelBlend(z: number) {
    const fade = 26;
    return Math.min(sm((z - TUNNEL.z0) / fade), sm((TUNNEL.z1 - z) / fade));
  }
}

/** Singleton — the corridor is deterministic, so there is nothing to seed. */
let _corridor: Corridor | null = null;
export function getCorridor(): Corridor {
  if (!_corridor) _corridor = new Corridor();
  return _corridor;
}

/** z of the two gores, re-exported so callers don't need const.ts as well */
export const GORE_Z = CONNECT_Z;
