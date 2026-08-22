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
  { z0: -960, z1: -520, d: -62 }, // ← dead straight from here: the ramp window
  { z0: 40, z1: 300, d: +34 },
  { z0: 620, z1: 880, d: -34 }, // ← straight from 880 on: tunnel, toll, splice
];

/** Vertical alignment. Max grade ≈ 3.8 %, which is steep enough to feel and
    flat enough to stay fast. */
const Y_BENDS: Bend[] = [
  { z0: -1550, z1: -1250, d: +5 },
  { z0: -1250, z1: -950, d: -5 },
  // level through the ramp window so the gores and the spawn sit at DECKY
  { z0: 40, z1: 270, d: +4 },
  { z0: 270, z1: 490, d: -4 },
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
/* Steps must not overlap, and each one has to be long enough that a lane
   *centre* slides no faster than traffic can track it. The binding rate is
   LANE_FOLLOW_RATE in traffic.ts — currently 3.4 m/s, the rate at which a car
   merely *holding* its lane follows that lane's centreline as a taper slides
   it sideways. (Do not size against the slower per-driver `laneRate`: that one
   governs deliberate, signalled lane changes, which are a different motion.)
   At 60 m/s that caps the lateral slope of a lane centre at ~0.057, above
   which a car sitting still in its lane visibly cuts across the boundary.
   A smootherstep's peak slope is 1.875·Δ/L, so a step that moves a lane centre
   by Δ needs L ≥ 35·Δ — 35 rather than the bare 33 for margin. Note Δ is the
   worst move over *every* lane, not the middle one: adding a lane shifts the
   outermost lane furthest, and it is always the binding case. */
const BASE_LANES = 3;
const LANE_STEPS: LaneStep[] = [
  { z0: -1550, z1: -1400, to: 2 }, // drop to two through the first sweeper
  { z0: -1150, z1: -1000, to: 3 },
  /* Widest section of the lap: five lanes, fully open ahead of the exit gore.
     Δ = 3.7 m (two lanes added shift every centre by pitch), so the 140 m step
     sits at 1.875·3.7/140 ≈ 0.050 lateral slope — inside the 0.053 budget. */
  { z0: -700, z1: -560, to: 5 },
  /* Lane drops into the tunnel, and the last change of count before the
     splice: everything must be settled by Z1 − DECK_EXT, because the mirrors
     show the overrun behind the player and it has to already match the other
     end. The toll plaza deliberately does NOT change the lane count — see
     LANE_PITCH. Two single-lane drops rather than one 5→3 fan-in: traffic
     chains one forced merge at a time, and a two-lane taper in one step is
     exactly the pileup shape the zipper logic in traffic.ts has to fight. */
  { z0: 640, z1: 745, to: 4 },
  { z0: 765, z1: 860, to: 3 },
];

/** Lane pitch — the spacing between lane centres, which is *not* constant.

    The toll plaza needs a channel a car can thread at 200 km/h: on the open
    road's 3.7 m pitch, a gate island leaves 2.5 m, and the widest car in the
    garage is 1.98 m. That is a quarter of a metre either side, which is a wall
    magnet rather than a gate.

    The cheap way to buy that room is to spread the lanes apart without adding
    any. Adding a lane is what costs taper length: a fan-out from 3 lanes to 5
    shifts the outermost lane 7.9 m sideways, and at the LANE_FOLLOW_RATE
    budget (see LANE_STEPS) that needs 261 m of taper either side of the plaza
    — 520 m, against the 320 m that exists between the tunnel portal and the
    splice window. Widening the pitch instead leaves the middle lane exactly
    where it was and moves the outer pair by only (TOLL_PITCH − LANE_W), so the
    whole plaza costs 152 m of taper and fits with room to spare.

    Everything downstream reads laneOffset()/laneEdge()/halfWidth(), so the
    gates, the markings, the studs and the NPCs all follow the wider spacing
    with no extra plumbing. */
const TOLL_PITCH = 6.0;
interface PitchStep {
  z0: number;
  z1: number;
  to: number;
}
const PITCH_STEPS: PitchStep[] = [
  { z0: 1290, z1: 1390, to: TOLL_PITCH }, // spread out for the gates
  { z0: 1450, z1: 1550, to: LANE_W }, // and back to open-road spacing
];

/** Toll plaza part sizes, here rather than in highway.ts so the corridor check
    can assert the gate clearance against the real numbers. */
export const TOLL_PLAZA = {
  /** kerbed island between two gates */
  kerbW: 1.0,
  /** booth body — kept inside the collider so nothing visible pokes out of it */
  boothW: 0.95,
  islandLen: 15,
  /** half-width of the island's collider box; the gate channel is
      lanePitch − 2 × this */
  colliderHw: 0.55,
  /** length of the rigid plaza group (canopy) */
  groupLen: 34,
  /** a gate narrower than this is not threadable at speed */
  minClear: 4.5,
};

/* ---- named features ---- */
export const TUNNEL = { z0: 920, z1: 1260, /** clear height under the ceiling */ clearH: 6.4 };
/** `plazaZ0/plazaZ1` bound the full-width window; the rigid plaza group (canopy,
    islands, booths) is centred in it and is only ~34 m long. */
export const TOLL = { z0: 1280, z1: 1560, plazaZ0: 1390, plazaZ1: 1450 };

/* ---- placement contract ------------------------------------------------
   Deck furniture is generated by highway.ts but *described* here, so the
   browser-free checks in test/corridor-check.mjs can assert against the real
   numbers instead of a copy that quietly drifts. */

/** Cantilever sign mount. One post outboard of the parapet, an arm reaching in
    over the lanes, the panel hung under the arm. Nothing here is coplanar with
    anything else: the arm sits entirely above the panel and the panel's back
    skin is 12 cm behind its face. */
export const SIGN = {
  /** deck → bottom of a panel that overhangs a lane */
  CLEAR: 5.15,
  /** post centre, this far *outboard* of the pavement edge (behind the
      parapet, like real gantry legs — a post inboard of the barrier is one the
      player collides with while hugging the wall) */
  POST_OUT: 0.3,
  POST_T: 0.3,
  /** panel/arm inboard offset from the post centre */
  ARM_X: 0.35,
  ARM_T: 0.26,
  /** gap between the panel face and its back skin */
  BACK_GAP: 0.12,
};

/** Where periodic deck furniture repeats.

    Every pitch here MUST divide LOOP_LEN, and every generator MUST place items
    on the global lattice `lattice(pitch, phase)` rather than counting from the
    built extent. Otherwise the furniture is out of phase either side of the
    splice and the teleport is visible as a jump in the lamp-post rhythm even
    though the road itself matches perfectly. `assertPitches()` guards it. */
export const PITCH = {
  pier: 32,
  light: 50,
  gantry: 500,
  soundwall: 400,
  reflector: 25,
  /** dashed lane line: DASH + GAP */
  dash: 16,
  /** shoulder edge line quad length */
  edge: 8,
};

/** Lattice phase offsets. The gantry pitch is a whole multiple of the light
    pitch, so on a shared phase every gantry would have a lamp post standing
    inside one of its legs. */
export const PHASE: Partial<Record<keyof typeof PITCH, number>> = {
  light: PITCH.light / 2,
};

export type SignKind = "exit-count" | "exit-gore" | "merge" | "toll";
export interface SignSpec {
  z: number;
  /** panel size */
  w: number;
  h: number;
  kind: SignKind;
  /** index into CONNECT_Z for the gore this serves, −1 for the toll boards */
  gore: number;
  /** distance-to-feature the panel announces, metres */
  dist: number;
}

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
        hw: (nf * this.lanePitch(z)) / 2 + SHOULDER,
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
  /** Spacing between lane centres here. Constant at LANE_W except through the
      toll plaza, where the lanes spread apart to make the gates threadable. */
  lanePitch(z: number) {
    let w = LANE_W;
    for (const st of PITCH_STEPS) w = w + (st.to - w) * sm((z - st.z0) / (st.z1 - st.z0));
    return w;
  }
  laneOffset(k: number, z: number) {
    const nf = this.laneCount(z);
    return (k - (nf - 1) / 2) * this.lanePitch(z);
  }
  halfWidth(z: number) {
    return (this.laneCount(z) * this.lanePitch(z)) / 2 + SHOULDER;
  }
  /** offset of the boundary between lane k-1 and lane k (k = 1..n-1) */
  laneEdge(k: number, z: number) {
    return this.laneOffset(k, z) - this.lanePitch(z) / 2;
  }
  /** Clear width through a toll gate: the lane pitch less the island either
      side of it. This is the number that decides whether the plaza is fun. */
  gateClear(z: number) {
    return this.lanePitch(z) - 2 * TOLL_PLAZA.colliderHw;
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
  /** The z translation to apply this frame, or 0. Covers reversing back over
      the seam as well, which `shouldWrap` does not — a car that spins and
      drives backwards off the start of the band needs +LOOP, and the engine
      would otherwise have to open-code the other half of the condition.
      Everything the engine holds that is an absolute world z and must stay
      glued to the car gets `+= spliceDelta(car.z)`. */
  spliceDelta(z: number) {
    if (z >= this.Z1) return -this.LOOP;
    if (z < this.Z0) return this.LOOP;
    return 0;
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

  /* ---- furniture placement ---- */
  /** Every z of the form `phase + k * pitch` inside the built extent, k running
      over the *global* integers. Because each pitch divides LOOP, an item at z
      has a twin at z + LOOP, which is what keeps the splice invisible. */
  lattice(pitch: number, phase = 0): number[] {
    const out: number[] = [];
    const k0 = Math.ceil((this.ZB0 - phase) / pitch);
    const k1 = Math.floor((this.ZB1 - phase) / pitch);
    for (let k = k0; k <= k1; k++) out.push(phase + k * pitch);
    return out;
  }
  /** lattice index of a z, folded into the lap — use it to pick per-item
      variation (a sign's wording, say) that must survive the wrap */
  latticeIndex(z: number, pitch: number, phase = 0) {
    const n = Math.round(this.LOOP / pitch);
    const k = Math.round((this.wrapZ(z) - phase) / pitch);
    return ((k % n) + n) % n;
  }
  /** lateral offset of a cantilever sign's post: outboard of the parapet, on
      the town side, so it is never standing in a lane or in mid-air */
  signPostLat(z: number) {
    return -(this.halfWidth(z) + SIGN.POST_OUT);
  }
}

/** Throws if a furniture pitch would put the two sides of the splice out of
    phase. Called once at world build; the corridor check calls it too. */
export function assertPitches() {
  for (const [k, p] of Object.entries(PITCH))
    if (LOOP_LEN % p !== 0)
      throw new Error(`corridor: PITCH.${k} = ${p} does not divide LOOP_LEN ${LOOP_LEN}`);
}

/** The cantilever boards, in one place so the geometry and the checks agree.
    Ordered by z. */
export function signPlan(): SignSpec[] {
  const out: SignSpec[] = [];
  const exitZ = CONNECT_Z[0], entryZ = CONNECT_Z[1];
  for (const d of [400, 200])
    out.push({ z: exitZ - d, w: 7.4, h: 2.8, kind: "exit-count", gore: 0, dist: d });
  out.push({ z: exitZ - 40, w: 7.4, h: 2.8, kind: "exit-gore", gore: 0, dist: 0 });
  /* Far enough back from the entrance to clear its parapet gap, near enough to
     be five seconds' notice at expressway speed. */
  out.push({ z: entryZ - 150, w: 6.6, h: 2.5, kind: "merge", gore: 1, dist: 150 });
  /* Toll boards are placed by absolute z, not by distance: the tunnel sits
     between the plaza and anywhere a "500 m" board would naturally go, and a
     cantilever mast does not fit under the tube. One goes just short of the
     entry portal, one just past the exit portal. */
  for (const z of [TUNNEL.z0 - 40, TUNNEL.z1 + 70])
    out.push({
      z, w: 7.4, h: 2.8, kind: "toll", gore: -1,
      // to the gates themselves, which sit at the centre of the full-width
      // window, not at its leading edge
      dist: Math.round(((TOLL.plazaZ0 + TOLL.plazaZ1) / 2 - z) / 10) * 10,
    });
  return out.sort((a, b) => a.z - b.z);
}

/** Singleton — the corridor is deterministic, so there is nothing to seed. */
let _corridor: Corridor | null = null;
export function getCorridor(): Corridor {
  if (!_corridor) _corridor = new Corridor();
  return _corridor;
}

/** z of the two gores, re-exported so callers don't need const.ts as well */
export const GORE_Z = CONNECT_Z;
