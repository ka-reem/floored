import {
  HX, DECKY, HZ, LOOP_LEN, DECK_EXT, LANE_W, SHOULDER, MAX_LANES, CONNECT_Z,
  RAMP_W, RAMP_LEAD,
} from "./const";
/* The only import beyond ./const, and deliberately a leaf one: ten pure-node
   harnesses compile this file standalone with tsc, so anything reached from
   here has to be free of three.js and of browser globals. util.ts is. */
import { mulberry32, rrand, type Rng } from "../util";

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
/** The schedule for the lap, rolled from the road seed by `planRoad()` below
    — it lives after the named features because it is planned around them.
    It replaced a hand-written table of five steps whose consequence was that
    every session, on every lap, the road was the *same* road: 3 lanes for
    53% of the lap, 5 for 33% in one unbroken 1.3 km slab, and 4 lanes for
    159 m of the 4 km. See ROAD_PLAN for what varies and what cannot. */
let LANE_STEPS: LaneStep[] = [];

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

export interface TunnelSpec {
  z0: number;
  z1: number;
  /** clear height under the ceiling */
  clearH: number;
  /** driver-visible lane count through the bore; constant end to end */
  lanes: number;
  nameJa: string;
  nameEn: string;
}

/** Every tunnel on the lap, ordered by z. Rolled from the road seed; the
    count is fixed (two), the lengths, positions and widths are not.

    `TUNNEL` below is tunnel #0 and exists only so the handful of consumers
    that predate a second tube keep working. Anything new should read
    `tunnels()` / `inTunnel()` / `tunnelBlend()`, all of which cover the lot. */
const TUNNELS: TunnelSpec[] = [];
/** @deprecated the lap has more than one tunnel — use `tunnels()`. Kept as a
    live mirror of `TUNNELS[0]` (mutated in place, so imported bindings stay
    valid across a re-seed) for engine.ts's debug teleport and the minimap. */
export const TUNNEL: TunnelSpec = {
  z0: 920, z1: 1260, clearH: 6.4, lanes: 3, nameJa: "汐留トンネル", nameEn: "SHIODOME TN",
};
/** `plazaZ0/plazaZ1` bound the full-width window; the rigid plaza group (canopy,
    islands, booths) is centred in it and is only ~34 m long. */
export const TOLL = { z0: 1280, z1: 1560, plazaZ0: 1390, plazaZ1: 1450 };

/* ---- the road plan ------------------------------------------------------

   Everything from here to `applyRoadSeed()` decides, from one integer, how
   many lanes the deck has where and where the tunnels are. It is the answer
   to "the roads don't feel random any more": they never were. The corridor
   used to be a hand-written table, so the lane sequence 3-2-3-5-4-3 at fixed
   z was the only road the game had ever shipped, and re-rolling the world
   seed in the settings panel (which does change the town, the terrain and
   the sky) left the expressway byte-identical.

   The plan is still *deterministic*: one seed, one road, every session. What
   changed is that the seed reaches it.

   ---- what may vary, and what may not ----

   Almost all of the constraints here are load-bearing and were paid for once
   already; none of them is a style choice:

   - **The splice.** Crossing z = Z1 teleports the player back by LOOP, which
     is only invisible because the road at Z0 + d is *identical* to the road
     at Z1 + d for the whole DECK_EXT of overrun either side — the mirrors
     show it. laneCount() saturates to BASE_LANES below every step and to the
     last step's `to` above them, so the plan must open and close on
     BASE_LANES and no taper may touch [Z1 − EXT, Z1] or [Z0, Z0 + EXT].
     TAPER_BAND is that window, less a margin.
   - **Taper rate.** A step that moves a lane centre by Δ needs L ≥ 35·Δ (see
     the LaneStep note above); adding d lanes moves every centre by
     d·LANE_W/2, hence `stepLen`. Below that, a car merely *holding* its lane
     cannot follow the centreline sliding under it and visibly cuts the line.
   - **The toll plaza** spreads the lane *pitch* to 6.0 m rather than adding
     lanes, and 3 × 6.0 is already most of the deck — so the count is pinned
     to BASE_LANES from before the first pitch step to after the last. That
     pin, plus the splice pin, is why ~1.1 km of the lap is 3 lanes no matter
     what the seed says. Making it four would need MAX_LANES raised and both
     pitch tapers lengthened; it is the one remaining lever on this stretch.
   - **The gores.** The two town ramps (CONNECT_Z), the tied-arch bridge and
     the bypass diverge all attach to the deck *edge*, i.e. to halfWidth. The
     ramp sweep re-reads halfWidth per sample so a taper near a gore is
     survivable, but the bypass takes its gore wedge from halfWidth at a
     single z — so no taper crosses one, and the bridge/diverge stretch is
     pinned to five lanes outright. That also guarantees the lap has at least
     one five-lane section, and keeps the bypass geometry (and everything
     routegraph-check asserts about it) exactly as it was.
   - **The tunnels** hold one count end to end: the bore is swept from the
     stations so it would happily taper, but a lane drop inside a tube is
     both bad practice and unreadable at night. */

/** rrand, but never inverted: several windows here collapse to a point when
    a tunnel takes the whole of one, and a reversed range would place a taper
    behind its own start. */
const span = (rng: Rng, a: number, b: number) => (b <= a ? a : rrand(rng, a, b));

/** Weighted lane counts. Deliberately top-heavy: the ask was to see five
    lanes more often, and the old road only ever offered five in one slab. */
const LANE_WEIGHTS: readonly (readonly [number, number])[] = [
  [2, 0.05], [3, 0.11], [4, 0.28], [5, 0.56],
];
/* Two lanes is in the table and almost never comes up, and that is a decision
   rather than an oversight. The old road had a 399 m two-lane sweeper, and
   getting one back now costs a chained drop down (216 m from four, 336 m from
   five) plus a two- or three-lane fan-out to climb back — most of the only
   stretch of the lap long enough to hold it, which is also where the west
   tunnel now lives. Measured over 400 seeds, forcing one in bought 0.7
   points of two-lane road and cost 3.3 points of four-or-five, against an ask
   that was specifically for more wide road. Re-enabling it is a `squeeze`
   option on planSpan in the history of this file if that trade ever flips. */
function rollLanes(rng: Rng, from: number, near: number, span: number): number {
  /* `near` ± `span` keeps the road within reach of where the next fixed point
     needs it; `from` is where it is now, and never a legal answer.

     Single-lane moves are favoured 2.2:1 over jumps, for two reasons that
     point the same way. A lane opening on its own is what an expressway
     actually does, and a Δ1 taper is 96 m against a Δ2's 144 and a Δ3's 216
     — so at a fixed budget of taper-legal road, preferring Δ1 buys visibly
     more changes of width per lap, which is the thing being asked for. */
  const opts = LANE_WEIGHTS.filter(([n]) => n !== from && Math.abs(n - near) <= span);
  const w = opts.map(([n, p]) => p * (Math.abs(n - from) === 1 ? 2.2 : 1));
  const tot = w.reduce((a, b) => a + b, 0);
  let r = rng() * tot;
  for (let i = 0; i < opts.length; i++) if ((r -= w[i]) <= 0) return opts[i][0];
  return opts[opts.length - 1][0];
}

/** Minimum taper length for a change of `d` lanes, rounded up to a whole
    metre. 72·d against the 64.75·d the slide budget actually demands, so a
    later tweak to LANE_W or the follow rate does not silently eat the margin;
    never shorter than 96 m, which is ~1.7 s at speed — below that a lane
    appears and vanishes rather than opening. */
const stepLen = (d: number) => Math.max(96, Math.ceil(72 * Math.abs(d)));
/** Flat road between the two halves of a chained lane drop. */
const DROP_GAP = 24;
/** One single-lane DROP, held a little longer than the widening minimum. The
    extra is not slide budget — it is time for a car in the dying lane to find
    a gap in the next one over.

    Do not read that as "longer is safer" and reach for a bigger number — it
    has been tried, twice, and it goes the wrong way. Over 14 road seeds × 5
    traffic seeds of test/traffic-merge-sim: 96 m leaves 2 failing
    assertions, 120 leaves 3, 144 leaves 5, and stretching only the drops
    that leave a five-lane road to 168 leaves 9. Past ~100 m the residual is
    the scenario moving under the taper, not the taper being short, so this
    sits at the hand-written schedule's own figure (its two drops were 105 m
    and 95 m). What is left belongs to the gap box in traffic.ts — it sizes
    acceptance on the merger's speed AT acceptance and does not re-check
    after the merger brakes — not here. */
const DROP_LEN = 120;
/** Metres of road a change from `from` to `to` lanes costs.

    Widening is one smootherstep however many lanes it adds — a lane opening
    beside you forces nobody anywhere, so the only budget is the slide rate.

    NARROWING IS NOT. Every car in a dying lane has to be somewhere else by
    the end of the taper, and the zipper logic in traffic.ts hops one lane at
    a time: a two-lane fan-in gives a car in the outer lane one taper — 144 m,
    2.4 s at 60 m/s — to complete two hops, and it cannot.
    test/traffic-merge-sim catches it as ~10 body overlaps up to 0.20 m deep
    through the taper and metre-scale backward corrections as the IDM stop at
    the lane end fires; chained, the same seeds report zero. So a drop of k lanes is
    k separate single-lane drops with real road between them, which is what
    the hand-written schedule did (5 → 4 over 105 m, 20 m flat, 4 → 3 over
    95 m) and why it did it. */
function changeLen(from: number, to: number) {
  if (to >= from) return stepLen(to - from);
  const k = from - to;
  return k * DROP_LEN + (k - 1) * DROP_GAP;
}
/** Emit the step (or the chain of steps) for one change; returns its end z. */
function emitChange(out: LaneStep[], z0: number, from: number, to: number) {
  if (to >= from) {
    const z1 = z0 + stepLen(to - from);
    out.push({ z0, z1, to });
    return z1;
  }
  let z = z0;
  for (let n = from; n > to; n--) {
    out.push({ z0: z, z1: z + DROP_LEN, to: n - 1 });
    z += DROP_LEN + (n - 1 > to ? DROP_GAP : 0);
  }
  return z;
}
/** Worst change `vary` lanes of free variation can leave in front of a
    closing taper — how much road the closing span has to reserve. */
function widestChange(nTo: number, vary: number) {
  let w = 0;
  for (const [n] of LANE_WEIGHTS)
    if (Math.abs(n - nTo) <= vary) w = Math.max(w, changeLen(n, nTo));
  return w;
}
/** Shortest stretch of constant lane count worth BUILDING — not the shortest
    one that is legal.

    This is the frequency dial, and it is deliberately set high. The road is
    supposed to feel varied, not busy: a deck that adds and drops a lane every
    few hundred metres reads as chaotic, and is worse than a monotonous one.
    What registers as "this part of the road is wide" is a stretch you sit in
    for several seconds, so a run is sized in seconds — 200 m is 3.6 s at
    200 km/h, and the leads below stretch that to 5–10 s.

    The lap therefore keeps roughly the change COUNT the hand-written schedule
    had (5–7 against its 6). What varies is where those changes are, which way
    they go, and how wide the stretches between them get. */
const MIN_RUN = 160;
/** A short flat gap, not a run: portal breathing room, and the clearance
    between two steps of a chained drop. Independent of MIN_RUN — this one is
    "nothing is mid-taper here", not "there is road to settle on". */
const EDGE_PAD = 24;
/** Clearance a taper keeps from a tunnel portal, so the mouth is built at one
    width and the headwall does not sit on a moving deck edge. Exported for the
    taper-legality scans in test/corridor-check.mjs and test/lane-plan.mjs. */
export const PORTAL_PAD = 20;
/** No taper outside this: the splice needs DECK_EXT of matching overrun. */
export const TAPER_BAND: [number, number] = [-HZ + DECK_EXT + 20, HZ - DECK_EXT - 20];
/** Lane count is pinned to BASE_LANES from here to the end of the band: the
    toll plaza's pitch widening owns the deck through it. */
const TOLL_PIN_Z = PITCH_STEPS[0].z0 - 6;
/** The wide section: the tied-arch span and the bypass diverge gore. No taper
    crosses it — both hang off the deck EDGE, and the bypass takes its gore
    wedge from halfWidth at a single z rather than re-reading it per station —
    but the width it holds is rolled, four or five, leaning five.

    It used to be pinned at five outright, on the theory that keeping the
    bypass geometry bit-identical was free. It was not free: with the middle
    of the lap always five lanes, 500 seeds produced TWO distinct lane
    profiles between them. Four is verified — routegraph-check closes, the
    gore nose still sits 0.60 m off the deck edge, the flyover keeps 9.17 m
    over the deck against the 7.6 m lamp masts, and bypass-attach-sim is
    clean — so the wide section is now a place the seed can change. */
export const WIDE_PIN: [number, number] = [300, 620];
const WIDE_WEIGHTS: readonly [number, number][] = [[4, 0.25], [5, 0.75]];
/** Stretches no taper may overlap. The gore windows cover the nose, the
    pavement peel-off and the parapet gap either side of it. Exported so the
    checks assert against the real windows instead of a copy. */
export const NO_TAPER: readonly (readonly [number, number])[] = [
  [-580, -250], // exit gore (CONNECT_Z[0]) + ramp peel-off + spawn band
  [-210, 70], // entrance gore (CONNECT_Z[1]) + its approach
  WIDE_PIN,
];

/* ---- auxiliary (deceleration / acceleration) lanes ----------------------

   A real freeway does not drop you onto a ramp out of a through lane. It
   opens a whole extra lane hundreds of metres upstream, separates it from the
   through lanes with a SOLID white line, and lets the ramp simply carry that
   lane away. The entrance is the same film run backwards: the ramp arrives as
   a full lane and that lane tapers back into the deck a long way downstream.

   The lane is real pavement, not paint: `auxWidth(z)` widens the deck on the
   WEST side only (the town side, which is the driver's right and the only
   side a ramp ever leaves from). It is deliberately NOT part of `laneCount`:
   traffic keeps its lane centres, its lane changes and its edge clamp on the
   through lanes exactly as before, and an NPC never wanders into the exit.
   Everything that draws or clamps the west edge asks `edgeLat(z, -1)`.

   Lengths. The exit lane opens 400 m ahead of the gore — 280 m of opening
   taper (a 1:27 divergence, flatter than any lane taper on the lap) and 120 m
   at full width, which is the stretch the "EXIT ONLY" paint and the arrows
   live in. It cannot start earlier: the west tunnel's structure may reach
   z = -930 on some seeds and a lane cannot open inside a bore. The entrance
   lane runs the other way — full width off the gore, then 160 m of merge
   taper — and stops short of the bypass diverge window (WIDE_PIN) so the two
   never share a deck edge.

   Before this the "deceleration lane" was the outside through lane with three
   arrows painted in it over 52 m. */
/** Width of an auxiliary lane: the ramp's own pavement width, so the ramp
    continues the lane rather than stepping in or out of it. */
export const AUX_W = RAMP_W;
interface AuxSpec {
  /** widening starts */
  z0: number;
  /** …and is complete */
  z1: number;
  /** full width holds to here */
  z2: number;
  /** …then closes by here */
  z3: number;
  w: number;
}
export const AUX_LANES: readonly AuxSpec[] = [
  /* EXIT 1. Opens 400 m ahead of the gore, holds full width for 140 m of
     "EXIT ONLY" paint, then hands the lane over to the ramp across the last
     RAMP_LEAD metres — the deck's share closes as the ramp's pavement opens
     into the same band, which is why there is no step and no gore wedge. */
  {
    z0: CONNECT_Z[0] - 400, z1: CONNECT_Z[0] - 200,
    z2: CONNECT_Z[0] - RAMP_LEAD, z3: CONNECT_Z[0], w: AUX_W,
  },
  /* EXIT 1's entrance ramp, the same film backwards: the ramp hands the lane
     to the deck over RAMP_LEAD, it runs on for 110 m, and then merges into
     the through lanes over a 110 m taper. It stops short of z = 300 so the
     bypass diverge's own gore wedge never shares a deck edge with it. */
  {
    z0: CONNECT_Z[1], z1: CONNECT_Z[1] + RAMP_LEAD,
    z2: CONNECT_Z[1] + 170, z3: CONNECT_Z[1] + 280, w: AUX_W,
  },
];

/** Extra pavement on the WEST side of the deck at z, metres. Zero on all but
    the ~700 m of the lap that carries a ramp lane. */
export function auxWidth(z: number) {
  let w = 0;
  for (const a of AUX_LANES) {
    if (z <= a.z0 || z >= a.z3) continue;
    w += a.w * (z < a.z1 ? sm((z - a.z0) / (a.z1 - a.z0))
      : z <= a.z2 ? 1
        : 1 - sm((z - a.z2) / (a.z3 - a.z2)));
  }
  return w;
}
/** The auxiliary lane that hands its pavement to (or takes it from) the ramp
    at this gore, or null when the gore has no aux lane. An exit's lane ENDS
    at its gore (z3), an entrance's BEGINS at it (z0). */
export function auxAtGore(zr: number): AuxSpec | null {
  for (const a of AUX_LANES)
    if (Math.abs(a.z3 - zr) < 1 || Math.abs(a.z0 - zr) < 1) return a;
  return null;
}

/** The z span each auxiliary lane occupies, for the checks and for the paint. */
export function auxSpan(i: number) {
  const a = AUX_LANES[i];
  return { z0: a.z0, z1: a.z1, z2: a.z2, z3: a.z3, w: a.w };
}

/** Tunnel names, drawn per tunnel so a re-seed renames them too. */
const TUNNEL_NAMES: readonly (readonly [string, string])[] = [
  ["汐留トンネル", "SHIODOME TN"], ["台場トンネル", "DAIBA TN"],
  ["芝浦トンネル", "SHIBAURA TN"], ["天王洲トンネル", "TENNOZU TN"],
  ["豊洲トンネル", "TOYOSU TN"], ["有明トンネル", "ARIAKE TN"],
  ["晴海トンネル", "HARUMI TN"], ["築地トンネル", "TSUKIJI TN"],
];

/** Subtract `holes` from `[a, b]`, dropping anything too short to taper in. */
function freeSpans(a: number, b: number, holes: readonly (readonly [number, number])[]) {
  let out: [number, number][] = [[a, b]];
  for (const [h0, h1] of holes) {
    const next: [number, number][] = [];
    for (const [s0, s1] of out) {
      if (h1 <= s0 || h0 >= s1) { next.push([s0, s1]); continue; }
      if (h0 > s0) next.push([s0, h0]);
      if (h1 < s1) next.push([h1, s1]);
    }
    out = next;
  }
  return out.filter(([s0, s1]) => s1 - s0 >= stepLen(1));
}

/** Place the tapers that carry the count from `nFrom` at the start of this
    span to `nTo` by the end of it, plus whatever extra changes fit on the way.

    The closing taper goes in the last span long enough to hold it; everything
    before it is free variation, so a long open stretch gets two or three
    changes of width instead of running at one count for a kilometre. */
function planSpan(
  rng: Rng, spans: [number, number][], nFrom: number, nTo: number, out: LaneStep[],
  opts: { vary?: number; hurry?: boolean } = {}
): number {
  /* Free variation is capped at ±`vary` lanes either side of `nTo`, so
     whatever it leaves behind the closing taper is at most a `vary`-lane
     change — size the reserved window for the worse of that and the change we
     already owe. */
  const vary = opts.vary ?? 2;
  const wide = widestChange(nTo, vary);
  const last = (need: number) => {
    for (let i = spans.length - 1; i >= 0; i--)
      if (spans[i][1] - spans[i][0] >= need) return i;
    return -1;
  };
  /* The closing taper goes in the last span that can hold the widest change
     free variation might leave in front of it. When no span is that long,
     variation is switched off for this stretch entirely and the span only has
     to fit the change we actually owe — otherwise a roll can widen the road
     into a window with no room left to bring it back. */
  let closeIx = last(wide);
  const allowVary = closeIx >= 0;
  if (closeIx < 0) closeIx = last(changeLen(nFrom, nTo));
  if (closeIx < 0) {
    /* No span here is long enough to change the count in. Fine when there is
       nothing to change — the stretch behind a tunnel that already holds the
       count the plaza wants is exactly this case, and it just stays put. Not
       fine otherwise: callers size their windows so it cannot happen, and if
       a constant ever moves we want a throw, not a road whose lane count
       disagrees with its toll plaza. */
    if (nFrom === nTo) return nFrom;
    throw new Error(`corridor: no room to go ${nFrom} → ${nTo} lanes`);
  }
  let n = nFrom;
  /* `hurry` biases both the run in front of a taper and the closing taper's
     position toward the start of the span. The stretch off the splice needs
     it: with a uniform draw its one change lands mid-span as often as not,
     and the opening BASE_LANES run then joins the toll plaza's pinned one on
     the far side of the seam into a kilometre and a half at a single count —
     which is the shape of the road this whole plan exists to break up. */
  const soon = () => (opts.hurry ? Math.min(rng(), rng()) : rng());
  /** as many extra changes as fit in [cur, limit], each behind a run of road */
  const fill = (cur: number, limit: number, tries: number) => {
    for (let guard = 0; guard < tries; guard++) {
      let to = rollLanes(rng, n, nTo, vary);
      const lead = MIN_RUN * (opts.hurry ? 0.5 : 0.8) + soon() * MIN_RUN * 1.4;
      /* A chained drop is long. Rather than give up on varying at all when
         the rolled target does not fit, walk it back toward where the road
         already is — one lane narrower still reads as a change. */
      while (to !== n && cur + lead + changeLen(n, to) + MIN_RUN * 0.5 > limit)
        to += to > n ? -1 : 1;
      if (to === n) break;
      cur = emitChange(out, cur + lead, n, to);
      n = to;
      if (rng() < 0.5) break; // one change is usually enough for a stretch
    }
    return cur;
  };
  for (let i = 0; i < spans.length; i++) {
    const [a, b] = spans[i];
    if (i === closeIx) {
      // a long closing span gets free changes of its own before the closer
      const cur = allowVary ? fill(a, b - wide - MIN_RUN * 0.5, 1) : a;
      if (n !== nTo) {
        const L = changeLen(n, nTo);
        /* Clamped at BOTH ends. The lower bound is a settling run behind
           whatever free variation just did; the upper one is the span itself,
           and it is not decoration — without it a long MIN_RUN pushes the
           closing taper straight through the end of its window and out the
           far side, which lands the toll plaza's fan-in inside the plaza. */
        const lo = Math.min(b - L, Math.max(cur + MIN_RUN * 0.5, a));
        emitChange(out, lo + soon() * (b - L - lo), n, nTo);
        n = nTo;
      }
      break; // nothing may change after the closing taper
    }
    if (allowVary) fill(a, b, 2);
  }
  return n;
}

/** One tunnel's z-window and the lane count it holds.

    `spanZ0`/`spanZ1` are where the tapers either side of the tube may start
    and must finish; `hardZ0`/`hardZ1` are where the *structure* may go, which
    is a tighter window (the east tube's entry portal cannot back into the
    bypass flyover). The lane count is rolled first because it decides how
    much of the span the tapers eat, and so how long the tube can be. */
function planTunnel(
  rng: Rng,
  spanZ0: number, spanZ1: number, hardZ0: number, hardZ1: number,
  lenLo: number, lenHi: number,
  weights: readonly number[], leadFrom: number, tailTo: number | null
): TunnelSpec {
  const tot = weights.reduce((s, w) => s + w, 0);
  let r = rng() * tot, lanes = 3;
  for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) <= 0) { lanes = 3 + i; break; }
  /* Room for the taper either side, and never less than half a run of plain
     road: a portal built where the deck edge is still moving, or one opening
     straight onto the toll approach, both read as a mistake. */
  const pad = EDGE_PAD;
  const lead = Math.max(pad, leadFrom === lanes ? 0 : changeLen(leadFrom, lanes) + pad);
  const tail = Math.max(pad, tailTo === null || tailTo === lanes ? 0 : changeLen(lanes, tailTo) + pad);
  const lo = Math.max(hardZ0, spanZ0 + lead) + PORTAL_PAD;
  const hi = Math.min(hardZ1, spanZ1 - tail) - PORTAL_PAD;
  /* Draw the length from what the window can actually hold, rather than
     drawing from [lenLo, lenHi] and clamping. Clamping puts a point mass on
     "exactly fills the window", and the window is often the binding limit —
     so a third of five-lane west tubes came out at the identical z and the
     identical length on unrelated seeds. Two worlds that are supposed to
     differ have to differ HERE: the tunnel is the landmark the lap is read
     against. */
  const lenMax = Math.min(lenHi, hi - lo);
  const len = span(rng, Math.min(lenLo, lenMax), lenMax);
  const z0 = span(rng, lo, hi - len);
  return { z0, z1: z0 + len, clearH: 6.4, lanes, nameJa: "", nameEn: "" };
}

/** The whole plan for one seed: tunnels first (they are the landmarks and the
    biggest holes in the taper band), then the lane schedule around them. */
function rollRoad(seed: number): { steps: LaneStep[]; tunnels: TunnelSpec[] } {
  const rng = mulberry32(seed);
  /* West tube — new, and the long one. It goes in the sweepers, the stretch
     that used to be 400 m of two-lane deck and nothing else. Its far end
     stops short of the first exit-count board (CONNECT_Z[0] − 400 = −900):
     a cantilever mast does not fit under a tube, and moving that board would
     bunch it against the next one. */
  const t0 = planTunnel(
    rng, TAPER_BAND[0], WIDE_PIN[0], TAPER_BAND[0], -930,
    300, 620, [0.12, 0.23, 0.65], BASE_LANES, null);
  /* How wide the bridge / bypass-diverge section runs. Rolled before the east
     tube because it is what the tube's approach taper starts from. */
  let wr = rng(), wideLanes = WIDE_WEIGHTS[WIDE_WEIGHTS.length - 1][0];
  for (const [n, w] of WIDE_WEIGHTS) if ((wr -= w) <= 0) { wideLanes = n; break; }
  /* East tube (the Shiodome, the one that was already here). Three or four
     lanes, never five, and that is a consequence rather than a preference:
     its portal cannot back into the bypass flyover at z ≈ 812–844, and the
     drop from the bore to the plaza's pinned three has to be CHAINED one lane
     at a time (see changeLen). Five lanes would want 216 m of chained drop
     behind the exit portal on top of a ≥200 m bore, and the 664 m between the
     flyover and the plaza does not hold both. So the lap's five-lane tube is
     the west one, and this is where the road steps down toward the toll —
     5 → 4 through the bore → 3 for the gates, which is the shape the
     hand-written schedule had and the shape traffic merges cleanly. */
  const t1 = planTunnel(
    rng, WIDE_PIN[1], TOLL_PIN_Z, 845, TOLL_PIN_Z,
    240, 380, [0.4, 0.6], wideLanes, BASE_LANES);
  const tunnels = [t0, t1];
  /* Names last, from ONE draw for the lap: the table is walked by a stride
     coprime with its length, so two tubes on the same lap can never land on
     the same name however the draw falls. */
  const NN = TUNNEL_NAMES.length;
  const nameBase = (rng() * NN) | 0;
  tunnels.forEach((t, i) => {
    [t.nameJa, t.nameEn] = TUNNEL_NAMES[(nameBase + i * 3) % NN];
  });
  const holes: [number, number][] = [
    ...NO_TAPER.map(([a, b]) => [a, b] as [number, number]),
    ...tunnels.map((t) => [t.z0 - PORTAL_PAD, t.z1 + PORTAL_PAD] as [number, number]),
  ];
  const band = (a: number, b: number) => freeSpans(a, b, holes);
  const steps: LaneStep[] = [];
  let n = BASE_LANES;
  n = planSpan(rng, band(TAPER_BAND[0], t0.z0), n, t0.lanes, steps, { hurry: true });
  /* The long one: everything between the west tube and the bridge, including
     the whole ramp window. vary 3 so the squeeze can reach two lanes and the
     road can still climb back to the five the bridge is pinned to — the
     closing span here ([70, 300], between the entrance gore and the span) is
     sized for exactly that. */
  /* `hurry` here too, and for a reason worth writing down: this span holds
     the only stretch that can differ when the west tube and the bridge
     section happen to roll the same width. Left to a lazy lead the change
     does not fit in the room before the exit gore, the tube and the bridge
     merge into one 1.6 km run, and the plan gets rejected — which quietly
     made five-lane tubes rare, because five is what they most often shared. */
  n = planSpan(rng, band(t0.z1, WIDE_PIN[0]), n, wideLanes, steps, { vary: 3, hurry: true });
  n = planSpan(rng, band(WIDE_PIN[1], t1.z0), n, t1.lanes, steps);
  planSpan(rng, band(t1.z1, TOLL_PIN_Z), n, BASE_LANES, steps, { hurry: true });
  steps.sort((a, b) => a.z0 - b.z0);
  return { steps, tunnels };
}

/** Lane count implied by a schedule at z — the free function `laneCount` is
    built on, so the coverage test below can score a plan before it is live. */
function countAt(steps: readonly LaneStep[], z: number) {
  let n = BASE_LANES;
  for (const st of steps) n = n + (st.to - n) * sm((z - st.z0) / (st.z1 - st.z0));
  return n;
}

/** Is this lap actually varied — and not varied to the point of being busy?

    A weighted roll can hand back a road that is four lanes from end to end,
    which is the complaint this whole file is answering; it can equally hand
    back one that changes width every 300 m, which is worse than monotonous.
    Rather than bias the weights until neither can happen (which narrows every
    road), score the plan and re-roll. The seed still determines the road, it
    just determines it through a filter.

    Note the run count is bounded on BOTH sides. The upper bound is the point:
    the lap is meant to have a handful of long stretches of different widths,
    not a lane opening and closing under you. Five to eight runs is five to
    seven changes, against the hand-written schedule's six. */
function varied(steps: readonly LaneStep[], tunnels: readonly TunnelSpec[]) {
  const runs: { n: number; len: number }[] = [];
  for (let z = -HZ; z < HZ; z += 2) {
    const n = Math.max(2, Math.round(countAt(steps, z)));
    const last = runs[runs.length - 1];
    if (last && last.n === n) last.len += 2;
    else runs.push({ n, len: 2 });
  }
  // a "run" is a stretch you sit in, not a metre the rounding passes through
  const solid = runs.filter((r) => r.len >= MIN_RUN);
  const seen = (n: number) => solid.filter((r) => r.n === n).length;
  const metres = (n: number) => solid.reduce((s, r) => s + (r.n === n ? r.len : 0), 0);
  const longest = Math.max(...solid.map((r) => r.len));
  return (
    /* Three different widths on the lap, and a five-lane stretch you actually
       spend time in — 450 m is ~8 s at cruise.

       A PRESENCE test, deliberately, not a metres quota. "At least 620 m of
       five-lane road per lap" buys about 1.5 points of extra five-lane
       surface and costs more than half the distinct roads: measured over 500
       seeds it took 7 lane profiles down to 3, because a filter tight enough
       to reject four rolls in five stops selecting and starts funnelling
       every seed into the one most typical lap. Where the width comes from
       is the weights and the four places the seed gets to choose — each tube,
       the stretch through the ramp window, and the bridge section. This only
       rejects the shapes that are no fun. */
    new Set(solid.map((r) => r.n)).size >= 3 &&
    solid.some((r) => r.n === 5 && r.len >= 450) &&
    /* Bounded on BOTH sides. The upper bound is the point: the lap wants a
       handful of long stretches of different widths, not a lane opening and
       closing under you. Five to eight runs is four to seven changes, against
       the hand-written schedule's six. */
    solid.length >= 5 && solid.length <= 8 &&
    /* No single count may own more than this much of the lap. The floor is
       ~1.2 km whatever the seed does — the toll plaza's pinned stretch runs
       into the splice band on the other side of the seam — so this only bites
       when a rolled run lands on BASE_LANES and extends it. The hand-written
       schedule's worst was 1713 m. */
    longest <= 1700 &&
    // and both tubes have to be worth driving through
    tunnels.every((t) => t.z1 - t.z0 >= 200)
  );
}

/* ---- the playground -----------------------------------------------------

   "add some sections where we get wider lanes … make it a bit random": one
   stretch per lap where the deck opens out PAST what the base plan rolls —
   up to MAX_LANES, a count the machinery has always carried (const.ts sizes
   RW for six) and the planner has never used — purely to give the player
   room to play. It is laid down AFTER the base plan, from a FORKED rng
   stream, and that is load-bearing twice over: the base plan's own draws
   (tunnels, steps, names) see exactly the sequence they saw before this
   existed, so a seed's road does not reshuffle under anyone; and `varied()`
   still scores the base plan alone, so the same re-roll attempt passes per
   seed as before. The window closes back onto the base schedule's own
   counts, so everything downstream of it is byte-identical to the road
   without it.

   MECHANISM: an overlay window, not an insert. The window opens (a rise of
   its own, a lengthened base widen, or a base drop that simply does not
   happen — see the Opener/Closer notes below), holds `gain` extra lanes,
   and closes (its own chained drop, or a base widen that absorbs the
   extra); any base steps INSIDE the window keep their z and their length
   and simply run `gain` lanes higher (`to + gain`). That is legal by
   construction: a
   single-lane base drop stays a single-lane drop of the same 120 m, and the
   slide budget is gain-invariant — a taper's lane-centre slide depends on
   how many lanes it CHANGES, not on how many it starts from. Overlaying
   rather than inserting is what makes room: the corridor's taper-free real
   estate comes in ~100–180 m fragments (map-overhaul's report proved the
   long stretches are all claimed), so demanding a whole wide section in one
   fragment strands most seeds with none.

   Placement rules, all inherited rather than invented:
   - the overlay's own two tapers obey stepLen/changeLen and live inside
     TAPER_BAND, clear of every NO_TAPER window and both tunnels' padded
     extents — the same taper law as the base plan, through the same
     freeSpans();
   - the window may span a town-gore window (holding a count over a gore is
     what the base plan does routinely; the ramp sweep re-reads halfWidth
     per sample) but never contains a tunnel (a bore holds its spec'd count
     end to end, and the spec is rolled before this exists) and never
     WIDE_PIN (the bypass takes its gore wedge from halfWidth at a single
     z — four and five lanes are verified there, six is not);
   - when the window sheds its lanes itself, the drop is chained one lane
     at a time, like every drop;
   - the splice band stays untouched: runs start MIN_RUN/2 inside
     TAPER_BAND, which also keeps the mountain-road merge (corridor.MTN,
     z −1644) the settled three-lane road its report verified. */

export interface PlaygroundSpec {
  /** the overlay holds over the whole of [z0, z1] (its own taper ends);
      the base schedule keeps stepping inside it, `gain` lanes higher */
  z0: number;
  z1: number;
  /** the widest the deck gets inside the window */
  lanes: number;
  /** lanes added over the base plan, 1 or 2 */
  gain: number;
}

let PLAYGROUND: PlaygroundSpec | null = null;
/** The wide playground stretch this seed rolled, or null when no run had
    room for one — test/lane-plan.mjs reports how often that happens. */
export const playground = () => PLAYGROUND;

/** A hold you actually get to play in — ~3.6 s at 200 km/h — and a cap so
    one feature does not own a quarter of the lap. The cap is sized to admit
    the one long spot most seeds have: a hold spanning BOTH town-gore windows
    (their outer edges are 650 m apart, so a hold that clears them both is
    ≥ ~650 m by construction). When a road's ONLY legal windows are longer
    than the cap — both ends absorbed into base steps that happen to sit far
    apart — the cap yields up to LOOSE rather than costing the lap its
    playground. */
const WIDE_HOLD_MIN = 200;
const WIDE_HOLD_MAX = 900;
const WIDE_HOLD_LOOSE = 1300;
/** Shortest stretch the window's PEAK count may hold — the widest the deck
    gets must last at least as long as the drop that ends it (~2.2 s at
    speed), or the extra lane appears and vanishes. MIN_RUN would be the
    stricter bar, but it prices six-lane peaks out of existence: the only
    runs long enough to carry six for 160 m are the ones the tunnels and
    WIDE_PIN already own. Exported so the checks hold the planner to it. */
export const PLAY_PEAK_MIN = 120;
/** How wide the window peaks, weighted; top-heavy toward MAX_LANES for the
    same reason LANE_WEIGHTS leans five — the ask is a WIDE section. Only
    peaks a spot can legally reach are in play, so "+2" happens exactly
    where a two-lane jump fits its chained drop, and a lap whose only room
    sits beside a three-lane run still gets its playground. */
const PLAY_WEIGHTS: readonly (readonly [number, number])[] = [
  [6, 0.66], [5, 0.24], [4, 0.1],
];

/** Lay the playground over the finished base plan; returns the merged,
    sorted schedule and the spec the checks assert against. */
function planPlayground(
  seed: number, steps: readonly LaneStep[], tuns: readonly TunnelSpec[]
): { steps: LaneStep[]; spec: PlaygroundSpec | null } {
  /* Forked stream: nothing here may consume a draw the base plan sees. */
  const rng = mulberry32((seed ^ 0x85ebca6b) >>> 0);
  /* Tapers avoid both lists; the window itself may span `soft` (the town
     gores) but never `hard` (a tunnel, or the bypass's pinned section). */
  const hard: [number, number][] = [
    ...tuns.map((t) => [t.z0 - PORTAL_PAD, t.z1 + PORTAL_PAD] as [number, number]),
    [WIDE_PIN[0], WIDE_PIN[1]],
  ];
  const holes: [number, number][] = [
    ...hard,
    ...NO_TAPER.filter((w) => w !== WIDE_PIN).map(([a, b]) => [a, b] as [number, number]),
  ];
  /* The base plan's constant-count runs, padded off its tapers. */
  const runs: { z0: number; z1: number; n: number }[] = [];
  let z = TAPER_BAND[0] + MIN_RUN * 0.5, n = BASE_LANES;
  for (const st of steps) {
    runs.push({ z0: z, z1: st.z0 - EDGE_PAD, n });
    z = st.z1 + EDGE_PAD;
    n = st.to;
  }
  runs.push({ z0: z, z1: TOLL_PIN_Z, n });
  /* Taper-legal fragments, each remembering which run it belongs to. */
  const spans: { a: number; b: number; run: number }[] = [];
  runs.forEach((r, ri) => {
    for (const [a, b] of freeSpans(r.z0, r.z1, holes)) spans.push({ a, b, run: ri });
  });

  /* Three ways to OPEN the window, in rising order of how little room they
     need. A standalone RISE wants a ≥ stepLen(g) fragment of its own.
     RETARGETING a base widen — the same taper carried `gain` lanes further,
     over the properly lengthened run-up — only wants the lengthening
     (stepLen grows by 48–120 m) clear behind the step it already has. And
     ABSORBING a base drop needs no room at all: bumped by `gain`, the
     falling step's delta becomes `gain − 1` — inert for one extra lane, a
     legal 120 m single-lane widen for two — so the road simply declines to
     narrow, and the window opens where the drop would have been. The last
     two doors are what keep the hit rate honest: the corridor's taper-free
     fragments cluster just under the standalone minimums. */
  interface Opener {
    kind: "rise" | "retarget" | "absorb";
    g: number;
    /** run the window interior starts in */
    run: number;
    /** window-start (fully-`gain`-wide) range; lo === hi unless a rise */
    lo: number;
    hi: number;
    /** earliest z the opener occupies, for the hard-hole test */
    z0: number;
    /** index of the base step retargeted/absorbed, -1 for a rise */
    step: number;
    /** metres past the window start before the deck is fully open — only a
        two-lane absorb has any: the absorbed drop spends its length as a
        single-lane widen first */
    flatOff: number;
  }
  const openers: Opener[] = [];
  for (const s of spans)
    for (let g = 1; g <= 2; g++) {
      if (s.b - s.a < stepLen(g)) continue;
      openers.push({
        kind: "rise", g, run: s.run, lo: s.a + stepLen(g), hi: s.b, z0: s.a, step: -1,
        flatOff: 0,
      });
    }
  steps.forEach((st, k) => {
    const pre = k === 0 ? BASE_LANES : steps[k - 1].to;
    for (let g = 1; g <= 2; g++) {
      if (st.to < pre) {
        // absorb: the window starts just shy of the step so the bump below
        // catches it; nothing new is built here
        const z = st.z0 - 0.5;
        openers.push({
          kind: "absorb", g, run: k + 1, lo: z, hi: z, z0: z, step: k,
          flatOff: g === 1 ? 0 : st.z1 - z,
        });
        continue;
      }
      if (st.to === pre) continue;
      const before = k === 0 ? TAPER_BAND[0] + MIN_RUN * 0.5 : steps[k - 1].z1 + EDGE_PAD;
      const z0 = st.z1 - stepLen(st.to - pre + g);
      if (z0 < before) continue;
      if (holes.some(([h0, h1]) => h0 < st.z0 && h1 > z0)) continue;
      openers.push({
        kind: "retarget", g, run: k + 1, lo: st.z1, hi: st.z1, z0, step: k, flatOff: 0,
      });
    }
  });

  /* Two ways to CLOSE it: a chained drop of our own in a taper-legal
     fragment, or ABSORBING into a base widen of d ≥ gain lanes — entering
     `gain` high, that step's delta becomes d − gain (a gentler widen, or
     inert), so the overlay hands its extra lanes to the base plan's own
     widening and nothing new is built. d < gain would turn the widen into
     a drop shorter than DROP_LEN, so it is not offered. */
  interface Closer {
    kind: "chain" | "absorb";
    /** run the window closes in (its count is what the window returns to) */
    run: number;
    /** drop-start / window-end range; lo === hi for an absorb */
    lo: number;
    hi: number;
    /** z past which nothing of the closer reaches, for the hard-hole test */
    z1: number;
    dLen: (g: number) => number;
    legal: (g: number) => boolean;
  }
  const closers: Closer[] = [];
  for (const s of spans) {
    const nJ = runs[s.run].n;
    closers.push({
      kind: "chain", run: s.run, lo: s.a, hi: s.b, z1: s.b,
      dLen: (g) => changeLen(nJ + g, nJ),
      legal: (g) => s.b - s.a >= changeLen(nJ + g, nJ),
    });
  }
  steps.forEach((st, k) => {
    const pre = k === 0 ? BASE_LANES : steps[k - 1].to;
    if (st.to <= pre) return;
    const z = st.z0 - 0.5;
    closers.push({
      kind: "absorb", run: k, lo: z, hi: z, z1: z,
      dLen: () => 0,
      legal: (g) => st.to - pre >= g,
    });
  });

  /** a legal spot: an opener and a closer with a hold in
      [WIDE_HOLD_MIN, WIDE_HOLD_MAX] between them, no hard hole inside the
      window, the peak on the deck const.ts sizes, and the peak GUARANTEED
      to survive for a MIN_RUN — a six-lane deck that lasts 80 m before a
      base drop inside the window takes it back is a lane that appears and
      vanishes, the exact shape MIN_RUN exists to prevent */
  interface Spot {
    o: Opener;
    c: Closer;
    peak: number;
    dLo: number; dHi: number; // drop START (window end) range
    /** window-start cap that keeps the peak stretch ≥ MIN_RUN when the
        opening run is what carries the peak */
    wCap: number;
  }
  /* The ramps are the one consumer with a real width ceiling: their sweep
     re-reads halfWidth per sample, but the descent's grade budget is spent
     against the deck edge at the gore, and at six lanes the edge sits far
     enough out that the drop to the frontage road crosses the 11.5% limit
     test/lane-plan.mjs holds it to. Five lanes at a gore is base-verified
     (the plan rolls it); six is not — so a gain that would push a gore past
     five makes that gore's whole no-taper hole uncrossable for the window. */
  const hardFor = (g: number): [number, number][] => [
    ...hard,
    ...CONNECT_Z.flatMap((gz, i) =>
      Math.round(countAt(steps, gz)) + g > 5
        ? [[NO_TAPER[i][0], NO_TAPER[i][1]] as [number, number]]
        : []
    ),
  ];
  const hardG = [hardFor(1), hardFor(2)];
  const findSpots = (holdMax: number) => {
    const out: Spot[] = [];
    for (const o of openers)
      for (const c of closers) {
        if (c.run < o.run || !c.legal(o.g)) continue;
        if (hardG[o.g - 1].some(([h0, h1]) => h0 < c.z1 && h1 > o.z0)) continue;
        let maxBase = 0;
        for (let k = o.run; k <= c.run; k++) maxBase = Math.max(maxBase, runs[k].n);
        if (maxBase + o.g > MAX_LANES) continue;
        let dLo = Math.max(c.lo, o.lo), dHi = c.hi - c.dLen(o.g);
        let wCap = o.hi;
        /* The peak must have a run to live on. A one-run window's peak IS
           the hold (≥ WIDE_HOLD_MIN); otherwise some run at maxBase must
           keep ≥ PLAY_PEAK_MIN inside the window — an interior run
           outright, or a boundary run with the window's end held back far
           enough. */
        if (o.run < c.run) {
          let ok = false;
          for (let k = o.run + 1; k < c.run && !ok; k++)
            ok = runs[k].n === maxBase && runs[k].z1 - runs[k].z0 >= PLAY_PEAK_MIN;
          if (!ok && runs[o.run].n === maxBase) {
            const cap = steps[o.run].z0 - PLAY_PEAK_MIN - o.flatOff;
            if (o.lo <= cap) { wCap = Math.min(wCap, cap); ok = true; }
          }
          if (!ok && runs[c.run].n === maxBase) {
            const floor = steps[c.run - 1].z1 + PLAY_PEAK_MIN;
            if (dHi >= floor) { dLo = Math.max(dLo, floor); ok = true; }
          }
          if (!ok) continue;
        }
        if (dHi < dLo) continue;
        // some pair (window start, window end) must leave a legal hold
        if (dHi - o.lo < WIDE_HOLD_MIN) continue;
        if (dLo - wCap > holdMax) continue;
        out.push({ o, c, peak: maxBase + o.g, dLo, dHi, wCap });
      }
    return out;
  };
  let holdMax = WIDE_HOLD_MAX;
  let spots = findSpots(holdMax);
  if (!spots.length) spots = findSpots((holdMax = WIDE_HOLD_LOOSE));
  if (!spots.length) return { steps: [...steps], spec: null };

  /* Peak width first — the seed's headline roll — then the spot among those
     that reach it, leaning roomy so the section lands generous. */
  const have = new Set(spots.map((s) => s.peak));
  const opts = PLAY_WEIGHTS.filter(([t]) => have.has(t));
  /* A spot can exist whose only reachable peak is 3 lanes — a "playground" no
     wider than the base road, which PLAY_WEIGHTS (4/5/6) deliberately does not
     offer. That left `opts` empty and the peak roll below dereferenced
     undefined, THROWING out of setRoadSeed and taking the whole world build
     with it: 14 of 4000 sampled seeds, so roughly 1 player in 285 got a game
     that would not load at all. Such a seed simply gets no playground, the
     same answer as no spot at all. */
  if (!opts.length) return { steps: [...steps], spec: null };
  let r2 = rng() * opts.reduce((s, [, w]) => s + w, 0);
  let peak = opts[opts.length - 1][0];
  for (const [t, w] of opts) if ((r2 -= w) <= 0) { peak = t; break; }
  const pool = spots.filter((s) => s.peak === peak);
  const weight = (s: Spot) => s.o.hi - s.o.lo + s.dHi - s.dLo + 60;
  let r3 = rng() * pool.reduce((s, q) => s + weight(q), 0);
  let pick = pool[pool.length - 1];
  for (const s of pool) if ((r3 -= weight(s)) <= 0) { pick = s; break; }
  const g = pick.o.g;

  /* Place the window inside the spot: hold first, then where it opens.
     Fixed ends (a retarget or an absorb) just collapse their range. */
  const holdLo = Math.max(WIDE_HOLD_MIN, pick.dLo - pick.wCap);
  const holdHi = Math.min(holdMax, pick.dHi - pick.o.lo);
  const hold = holdLo + rng() * (holdHi - holdLo);
  const wLo = Math.max(pick.o.lo, pick.dLo - hold);
  const wHi = Math.min(pick.wCap, pick.dHi - hold);
  const w1 = wLo + rng() * (wHi - wLo); // window start: fully wide from here
  const d0 = w1 + hold; // window end: where the extra lanes start to go

  const extra: LaneStep[] = [];
  /* Base steps inside the window run `gain` lanes higher — same z, same
     length, so every budget they were sized for still holds: a single-lane
     drop stays a single-lane drop, and a taper's slide depends on the lanes
     it CHANGES, not on the count it starts from. Cloned, not mutated:
     rollRoad's plan must stay what it rolled. */
  const merged = steps.map((st, k) => {
    if (pick.o.kind === "retarget" && k === pick.o.step) {
      const pre = k === 0 ? BASE_LANES : steps[k - 1].to;
      return { z0: st.z1 - stepLen(st.to - pre + g), z1: st.z1, to: st.to + g };
    }
    return st.z0 > w1 && st.z0 < d0 ? { ...st, to: st.to + g } : st;
  });
  if (pick.o.kind === "rise") {
    const nI = runs[pick.o.run].n;
    emitChange(extra, w1 - stepLen(g), nI, nI + g);
  }
  if (pick.c.kind === "chain") {
    const nJ = runs[pick.c.run].n;
    emitChange(extra, d0, nJ + g, nJ);
  }
  return {
    steps: [...merged, ...extra].sort((a, b) => a.z0 - b.z0),
    spec: { z0: w1, z1: d0, lanes: pick.peak, gain: g },
  };
}

const DEFAULT_ROAD_SEED = 1987; // settings.ts defaultProfile().seed

/** The world seed, read the way aurora.ts reads it — except that this file
    cannot import ../settings (the pure-node harnesses compile it alone), so
    it goes to the stored profile directly. A miss is harmless: the road falls
    back to the shipped default and is simply the same one every session,
    which is what it was before this existed. `?road=<n>` overrides, so a road
    can be flicked through without touching the saved profile. */
function storedSeed(): number {
  try {
    const g = globalThis as unknown as {
      location?: { search?: string };
      localStorage?: { length: number; key(i: number): string | null; getItem(k: string): string | null };
    };
    const q = g.location?.search?.match(/[?&]road=(-?\d+)/);
    if (q) return +q[1] >>> 0;
    const ls = g.localStorage;
    if (!ls) return DEFAULT_ROAD_SEED;
    // highest "neonx.profile.vN" present, so a future key bump keeps working
    let bestKey: string | null = null, bestV = -1;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i), m = k && /^neonx\.profile\.v(\d+)$/.exec(k);
      if (m && +m[1] > bestV) { bestV = +m[1]; bestKey = k; }
    }
    if (!bestKey) return DEFAULT_ROAD_SEED;
    const s = JSON.parse(ls.getItem(bestKey) || "{}").seed;
    return typeof s === "number" && Number.isFinite(s) ? s >>> 0 : DEFAULT_ROAD_SEED;
  } catch {
    return DEFAULT_ROAD_SEED;
  }
}

let _roadSeed = -1;

/** Re-plan the corridor for `seed`. Also the module's own initialiser.

    Call it BEFORE the first getCorridor(): it drops the cached corridor, and
    anything holding a reference to the old one keeps the old road. */
export function setRoadSeed(seed: number) {
  const s = seed >>> 0;
  if (s === _roadSeed) return;
  _roadSeed = s;
  let plan = rollRoad(s);
  /* Sub-rolls until one passes `varied`; the attempt index is part of the
     seed, so this is still exactly one road per seed. The constraints below
     accept roughly one roll in twenty, which is what the headroom is for —
     rollRoad is a few hundred arithmetic ops and this happens once, at module
     load. Falls through to the last roll rather than throwing: a dull road
     beats no road. test/lane-plan.mjs reports how many seeds fall through. */
  for (let i = 1; i < 300 && !varied(plan.steps, plan.tunnels); i++)
    plan = rollRoad((s ^ Math.imul(i, 0x9e3779b1)) >>> 0);
  /* The playground rides on top of the settled base plan — always from the
     ORIGINAL seed, so the fork does not depend on which re-roll passed. */
  const play = planPlayground(s, plan.steps, plan.tunnels);
  LANE_STEPS = play.steps;
  PLAYGROUND = play.spec;
  TUNNELS.length = 0;
  TUNNELS.push(...plan.tunnels);
  Object.assign(TUNNEL, TUNNELS[0]);
  _corridor = null;
}
export const roadSeed = () => _roadSeed;
/** Every tunnel on the lap, ordered by z. */
export const tunnels = (): readonly TunnelSpec[] => TUNNELS;

/* ---- sectional variety --------------------------------------------------

   A 4 km lap of identically-dressed three-lane deck reads as one endless road
   no matter how good the dressing is, and at 150 km/h the only variation the
   driver can actually register is the thing at eye level a metre from the
   door: the edge. So the corridor is cut into SECTIONS, stretches whose
   *edges* are built differently from their neighbours'.

   Crucially a section decides nothing but what stands at the pavement edge.
   The alignment, the lane schedule, the pitch schedule and the half-width are
   untouched by anything here, so no amount of re-sequencing sections can
   break a taper, a clearance or the loop splice.

   Kinds, ordered by how enclosed the road feels inside them:

     rail    — the parapet drops to a 0.42 m kerb carrying a three-band steel
               railing. You can see the drop, the ground and the town straight
               through it. Used on the sweepers and on the stretch the bypass
               viaduct crosses, where having something to look *at* is the
               whole point.
     viaduct — the default: the 1.05 m solid concrete parapet.
     mesh    — perforated galvanised screens standing on the parapet. These
               were on their own PITCH.soundwall lattice inside highway.ts;
               they are resolved here now so that every edge treatment is
               decided in one place and two of them can never overlap.
     screen  — solid concrete noise walls 4.6 m above the parapet on BOTH
               sides: the Shuto "trench" that turns the deck into a canyon and
               takes the sky away. The counterweight to `rail`, and the reason
               `rail` reads as open when you come out into it.
     bridge  — the tied-arch span, see BRIDGE.

   Placement is keyed on wrapZ(z). That is what makes the splice free: the
   DECK_EXT of overrun built past each end of the canonical band asks for the
   section of the road it is a copy of and gets it, so no table entry here has
   to sum to anything the way the bend deltas do. */

export type SectionKind = "viaduct" | "rail" | "mesh" | "screen" | "bridge";

export interface Section {
  z0: number;
  z1: number;
  kind: SectionKind;
}

/** The tied-arch bridge.

    An expressway that is already a viaduct from end to end cannot make a
    bridge read by lifting the road up — it is up. What separates a bridge
    from the viaduct either side of it is the structure you drive *through*
    and the hole underneath it, so this span gets both: the 32 m piers stop
    at each abutment and a parabolic tied arch carries the deck across the
    gap between them, with the deck's own girder deepened to act as the tie.

    Both ends land on the pier lattice (multiples of PITCH.pier) so the
    abutments replace two piers that would otherwise stand there rather than
    fighting them, and the span is clear of the bypass diverge gore at z=500
    and of every cantilever sign mast. */
export const BRIDGE = {
  /** abutments; both are PITCH.pier multiples, and z1 − z0 is the clear span */
  z0: 320,
  z1: 448,
  /** crown rise above the deck at midspan — span/6, an ordinary tied arch */
  rise: 21,
  /** rib centre, this far outboard of the pavement edge. Same reasoning as
      the gantry legs: anything inboard of the parapet clamp is something the
      car drives through while scraping the wall. */
  ribOut: 0.55,
  /** rib box section */
  ribW: 0.55,
  ribD: 0.9,
  /** hangers per rib, evenly spaced over the span excluding the springings */
  hangers: 9,
  /** structural depth of the tie girder (the plain viaduct's is 1.15 m) */
  girder: 2.1,
  /** cross-braces between the ribs, as fractions of the span. All three sit
      where the arch is over 15 m up, i.e. nowhere near vehicle clearance. */
  braceAt: [0.25, 0.5, 0.75],
};

/** Every arch span on the lap, in z order — the generic list every
    multi-bridge consumer (deck thickness, pier suppression, the builder
    itself) walks instead of naming BRIDGE directly. A second deck-integrated
    arch was tried (z 480-608, the only unclaimed stretch of WIDE_PIN) and
    dropped: routegraph-check's own printed numbers put the bypass diverge
    gore's parapet gap at z ∈ [500, 580] — dead centre of that span — so a
    second abutment there would stand in the gap the bypass pavement opens
    through. See OVERPASS below for the second structure instead: a crossing
    that does not touch the deck edge or its width has no such constraint. */
export const BRIDGES = [BRIDGE];

/** A city road crossing OVER the expressway on its own piers, outboard of
    the deck edge — the brief's cheaper alternative to a second arch: it
    never touches cor.sectionAt/deckTh/lane width, so none of BRIDGE's siting
    rules (WIDE_PIN, pier-lattice alignment) apply to it. What it still has to
    respect: z=160 sits in the one long stretch that is simultaneously clear
    of both tunnels' hard windows (west tube ends by z≈-930, east tube starts
    at z≈845 — rollRoad above), clear of the bypass's own z-extent
    (DIVERGE_Z=500 onward), and clear of both gore NO_TAPER windows
    ([-210,70] and [300,620]). Piers stand `outSet` beyond halfWidth, which is
    read per-build rather than baked in because the lane count at z=160 is
    seeded (3-5 lanes). */
export const OVERPASS = {
  z: 160,
  /** deck → soffit, matching the bypass flyover's own clearance precedent */
  clear: 9.0,
  girderD: 2.2,
  girderW: 9.5,
  /** pier centre, this far beyond halfWidth(z) — clear of every lane count */
  outSet: 4.5,
};

/** Every crossing overpass on the lap, in z order — the generic list the
    builder walks, the same shape BRIDGES gives the arches. The three new
    crossings sit in the grove stretch, whose whole width is provably free of
    everything a crossing must dodge: the west tube's structure can never end
    past z = −950 (planTunnel hardZ1 −930 − PORTAL_PAD), the bypass's own
    z-extent starts at DIVERGE_Z = 500, and the exit gore's NO_TAPER window
    opens at −580. The two cantilever exit-count masts at z −900/−700 top out
    at ~8.4 m (SIGN.CLEAR + panel + arm), under every soffit here by half a
    metre — and signPlan() can never move them into a tube on any seed, since
    no tube reaches past −950. Spacing is ~96 m so at speed they strobe
    overhead one-two-three, which is the point: one crossing is a landmark,
    a rhythm of them is a district boundary — the road visibly passing under
    the city grid on its way into town. */
export const OVERPASSES = [
  { ...OVERPASS, z: -912 },
  { ...OVERPASS, z: -816, girderW: 12.5 },
  { ...OVERPASS, z: -720, clear: 9.6 },
  OVERPASS,
];
/** The mountain road (EXIT 4, 峠 Tōge): a single-carriageway, ONE-WAY
    riverside pass that leaves the deck through an east-side gore, lifts onto
    a rock shelf above the river bank, sweeps out over the water and back, and
    merges through a second east gore.

    REBUILT 2026-09-08 (owner's pick, "option G"). It used to be a genuine
    tōge: 5.40 m of pavement and a 17.4 m radius corner, entered off a deck
    the player crosses at 200 km/h. The owner's verdict was "so hard to drive,
    road is too tight", and the brief for the rebuild was "make it wide and
    easier to drive". So the character changed deliberately — this is no
    longer a technical climb, it is a FAST SWEEPER: 11.00 m wide, 68.1 m
    worst radius, and a quarter of the steering rate (3.48 → 0.89 °/station).
    test/mountain-speed.mjs puts the consequence in one number: the pass used
    to be under 80 km/h for 68% of its length, and now for none of it. The numbers that carry
    that intent are asserted in test/routegraph-check.mjs, whose old bounds
    (a 60 m radius CEILING, a 6.2 m width ceiling) encoded the old design and
    were moved with it rather than worked around. The
    geometry itself is a routegraph PolyRouteEdge (routegraph.ts buildMountain
    reads this spec); the numbers live HERE, like BRIDGE and OVERPASS, so the
    browser-free checks can assert real placement and sections() can keep its
    lattice fills clear of the gores without importing routegraph.

    WHY THESE Z. The map-overhaul lane proved the no-taper budget inside
    TAPER_BAND is fully claimed (tunnel hard windows, both town gores,
    WIDE_PIN, the toll pin — see its report). But the SPLICE BAND is taper-free
    BY CONSTRUCTION: no lane step may touch z outside TAPER_BAND, the pitch
    schedule is long since settled, and neither tunnel can reach past its hard
    window — so [-2000, -1600] is guaranteed straight (first X bend starts at
    -1500), level (first Y bend at -1550) and BASE_LANES wide on every seed.
    The price is the splice discipline the bypass avoided by staying inside
    (Z0+EXT, Z1−EXT): everything of the road below Z0+EXT must ALSO be emitted
    at z+LOOP so the overrun the player sees across the seam (and the mirrors
    show behind it) carries the same gores and the same road. Meshes and gap
    windows are duplicated (scenery.ts copies() rule); colliders and physics
    stay canonical-only, because a car is wrapped back into [Z0, Z1) before it
    can ever stand on a copy.

    Siting details the checks pin down: both gores clear the z=-2000/-1500
    gantries, every hand-placed section, both tunnels' hard windows, and the
    toll; the road's own extent stays ≥ 8 m inside Z0 so nothing a car can
    drive triggers spliceDelta; laterally it lives in the flat strip between
    the deck edge and the river's near bank (scenery.ts RIVER, water from
    x=652), i.e. centreline lat ≤ ~105. */
export const MTN = {
  /** gore noses, east side (+lat) both — the lap's first left exit */
  divergeZ: -1968,
  mergeZ: -1644,
  /** ONE carriageway, ONE direction of travel: diverge → merge, the way the
      deck runs. 8.60 m of running lane against the old 4.20: wide enough to
      pick a line through a corner instead of tracking a kerb, wide enough
      that the rock wall is never in the mirror, and wide enough for the
      arcade car's 295 km/h top end to be survivable if the player carries it
      in. It is still ONE lane in the route graph (no centre line, no
      oncoming stream, no wrong-way lay-by) — the width is line-choice room,
      not a second lane. 1.20 m of shoulder each side puts the parapet off
      the pavement edge rather than at it. */
  lanes: 1,
  laneW: 8.6,
  shoulder: 1.2,
  /** pavement half width when fully open (lanes · laneW / 2 + shoulder) */
  half: (1 * 8.6) / 2 + 1.2,
  /** Gore taper length. Longer than the old 14 m because the pavement it has
      to open is twice as wide: at 14 m the mouth flared at nearly 45° and
      read as a hole in the parapet rather than as an exit. */
  nose: 20,
  /** structural skirt depth below the pavement */
  deckT: 0.9,
  /** The TURNOUT — a 待避所, in edge arclength from the diverge nose. On the
      old narrow pass this pocket was load-bearing: it was the only place a
      slower car could let you by and the only place wide enough to turn
      round. An 8.6 m carriageway can be overtaken on anywhere, so its job is
      now mostly the second one — plus it is the scenic pull-off, which is
      why it moved to the APEX of the outbound sweeper (s ≈ 168–212), the
      point furthest out over the water with the city behind you. traffic.ts
      updateMountain still pulls a slower pass car into it.

      It is narrower than the old 4.6 m because the road it widens is twice
      the width: +3.2 m on 11.0 m of pavement is 14.2 m across the pocket,
      comfortably over the 9 m the turn-round check wants. Extra width on
      +lat, the fill side, where a shelf road's turnout is really built. */
  turnoutS0: 168,
  turnoutS1: 212,
  turnoutW: 3.2,
  /** the river's near-bank riprap starts at x≈622 (scenery.ts) — the road,
      its skirt included, must stay west of it */
  xMax: 614,
};

/** Hand-placed sections. Everything else is `viaduct`, and the `mesh` runs
    come off the PITCH.soundwall lattice (see `sections()`).

    Why these z: each one is a stretch with no cantilever sign mast, no gore,
    no lane taper mid-way and no tunnel or plaza in it, and each is long
    enough (≥ 128 m, ~3 s at speed) to register as a place rather than as a
    glitch. Boundaries are PITCH.pier multiples so a section changes at a pier
    and an expansion joint, the way a real structure changes. */
const SECTION_PLAN: readonly Section[] = [
  /* Harbor overlook: the wharf district (scenery.ts) stands on the near
     bank at x ≈ 566–650 through this stretch, and behind a solid parapet —
     or the soundwall-lattice mesh run this window used to collect at
     z −1600 — none of it reads from the seat. An open railing is the whole
     point of `rail`: the container stacks, the yard masts' sodium pools and
     the water's light streaks swing past below the bands. Both ends are
     PITCH.pier multiples; the west tube (whose seeded window can reach
     z −1600) simply trims this run when it lands on top — sections() already
     does that for every hand-placed run. */
  { z0: -1888, z1: -1440, kind: "rail" },
  // second sweeper, at its narrowest (two lanes): open railing on a curve,
  // so the drop and the town swing past outside the car
  { z0: -1408, z1: -1248, kind: "rail" },
  // ...then the opposite extreme 200 m later, walled in on both sides
  { z0: -1056, z1: -832, kind: "screen" },
  { z0: BRIDGE.z0, z1: BRIDGE.z1, kind: "bridge" },
  // the stretch the bypass viaduct crosses back over (routegraph puts its
  // flyover at z ≈ 812–840): railing, so the span overhead is visible
  { z0: 608, z1: 800, kind: "rail" },
  /* Past the toll plaza the lap used to run 800 m to the first sweeper with
     nothing in it at all — the longest undressed stretch on the road, and it
     straddles the splice, so it is also the stretch the player sees twice in
     a row. It is inside the canonical band, so wrapZ keying builds its twin
     in the overrun before Z0 for free and the seam stays invisible. */
  { z0: 1760, z1: 1920, kind: "rail" },
];

/** Length of one perforated-screen run on the PITCH.soundwall lattice. */
const MESH_SEG = 120;

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
  /** parapet-mounted emergency-phone cabinets */
  sos: 200,
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
  /* 30, not 0: on phase 0 the SOS lattice shares a z with every second gantry
     (500 and 200 both divide 1000) and the cabinet ends up inside a leg. 30
     misses every gantry, every cantilever mast in signPlan() and both bypass
     board runs, and clears the lamp lattice by 5 m. */
  sos: 30,
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
  /** pavement half-width (through lanes + shoulder, both sides) */
  hw: number;
  /** west-side half-width: `hw` plus any auxiliary ramp lane here */
  hwL: number;
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
      const hw = (nf * this.lanePitch(z)) / 2 + SHOULDER;
      this.stations.push({
        z, x, y, tx, tz, nx: tz, nz: -tx, s: acc, nf,
        hw, hwL: hw + auxWidth(z),
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
  /** Extra pavement on the west (town) side: the deceleration/acceleration
      lane serving a gore. Zero everywhere else. See AUX_LANES. */
  auxWidth(z: number) {
    return auxWidth(z);
  }
  /** @see auxAtGore */
  auxAtGore(zr: number) {
    return auxAtGore(zr);
  }
  /** Unsigned half-width of the pavement on one side — west (`side` < 0)
      carries the auxiliary lane, east never does. Anything that draws,
      clamps or stands on a deck EDGE wants this, not halfWidth(). */
  edgeHalf(z: number, side: number) {
    return side < 0 ? this.halfWidth(z) + auxWidth(z) : this.halfWidth(z);
  }
  /** Signed lateral offset of that edge. */
  edgeLat(z: number, side: number) {
    return side < 0 ? -(this.halfWidth(z) + auxWidth(z)) : this.halfWidth(z);
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
    if (lat > this.halfWidth(zc) + pad) return null;
    if (-lat > this.edgeHalf(zc, -1) + pad) return null;
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
  /** Every tunnel on the lap, ordered by z. Same list as the module-level
      `tunnels()`; here too so consumers that already hold a corridor do not
      need a second import. */
  tunnels(): readonly TunnelSpec[] {
    return TUNNELS;
  }
  /** Inside ANY tunnel on the lap. `pad` widens the test outward at both
      mouths — geometry that must not exist in a tube (a mast, a lamp post, a
      parapet) wants a metre or two of it so nothing pokes through a portal. */
  inTunnel(z: number, pad = 0) {
    for (const t of TUNNELS) if (z > t.z0 - pad && z < t.z1 + pad) return true;
    return false;
  }
  /** The tunnel covering z, or null. */
  tunnelAt(z: number, pad = 0): TunnelSpec | null {
    for (const t of TUNNELS) if (z > t.z0 - pad && z < t.z1 + pad) return t;
    return null;
  }
  inToll(z: number) {
    return z > TOLL.z0 && z < TOLL.z1;
  }
  /** 0 outside every tunnel, 1 well inside one — audio reverb / exposure.

      The max over the tubes, not a sum: with two of them the value has to
      come all the way back to 0 between them or engine.ts's `tunT` never
      closes and the reverb tail is left hanging on the open road. The
      planner keeps the tubes far enough apart (kilometres) that the two
      fades never meet. */
  tunnelBlend(z: number) {
    const fade = 26;
    let v = 0;
    for (const t of TUNNELS)
      v = Math.max(v, Math.min(sm((z - t.z0) / fade), sm((t.z1 - z) / fade)));
    return v;
  }

  /* ---- sections ---- */
  private _sections: Section[] | null = null;
  /** The resolved edge-treatment plan for one lap, sorted by z and with no
      two runs overlapping. Everything is stated in canonical-band z; use
      `sectionAt` rather than this list to look a station up, because that is
      what folds the overrun back onto its twin.

      The hand-placed runs win outright; the `mesh` lattice fills in around
      them, skipping anything that would stand a screen inside the tunnel or
      the toll plaza, over a ramp gore, or on top of a hand-placed run. (The
      whole window is tested, not just its midpoint: the midpoint test used to
      let the run at z0 = 1200 build its screens straight through the tunnel's
      exit portal and on into the plaza.) */
  sections(): readonly Section[] {
    if (this._sections) return this._sections;
    /* Hand-placed runs are stated against a lap that has no tunnel in the
       sweepers; the west tube is rolled per seed and lands right on top of
       them. A tunnel IS an edge treatment — its own walls — so it wins, and
       a run it swallows is trimmed rather than punched through: half a noise
       wall ending inside a portal is worse than no noise wall. */
    const inTube = (a: number, b: number) => TUNNELS.some((t) => a < t.z1 + 6 && b > t.z0 - 6);
    const out: Section[] = [];
    for (const s of SECTION_PLAN) {
      const t = TUNNELS.find((q) => s.z0 < q.z1 + 6 && s.z1 > q.z0 - 6);
      if (!t) { out.push({ ...s }); continue; }
      // keep whichever end of the run survives, if it is still long enough
      if (s.z0 < t.z0 - 6 && t.z0 - 6 - s.z0 >= 96) out.push({ ...s, z1: t.z0 - 6 });
      if (s.z1 > t.z1 + 6 && s.z1 - (t.z1 + 6) >= 96) out.push({ ...s, z0: t.z1 + 6 });
    }
    const clashes = (a: number, b: number) =>
      out.some((s) => a < s.z1 && b > s.z0) ||
      inTube(a, b) ||
      (a < TOLL.z1 && b > TOLL.z0) ||
      CONNECT_Z.some((cz) => a < cz + 260 && b > cz - 260) ||
      // the mountain-road gores cut the east parapet the same way the town
      // gores cut the west one — no screen run may stand over either
      [MTN.divergeZ, MTN.mergeZ].some((cz) => a < cz + 240 && b > cz - 240);
    for (const z0 of this.lattice(PITCH.soundwall)) {
      // one entry per lap: the overrun's copies are found through wrapZ
      if (z0 < this.Z0 || z0 >= this.Z1) continue;
      const z1 = z0 + MESH_SEG;
      if (z1 > this.Z1 || clashes(z0, z1)) continue;
      out.push({ z0, z1, kind: "mesh" });
    }
    out.sort((a, b) => a.z0 - b.z0);
    return (this._sections = out);
  }

  /** The section run covering z, folded across the splice, or null on plain
      viaduct. Callers that need to veto a whole run (rather than a station)
      want this one — a guard applied per-station punches a hole in the middle
      of a wall instead of removing it. */
  sectionRunAt(z: number): Section | null {
    const w = this.wrapZ(z);
    for (const s of this.sections()) if (w >= s.z0 && w < s.z1) return s;
    return null;
  }

  /** Edge treatment at z, folded across the splice. */
  sectionAt(z: number): SectionKind {
    return this.sectionRunAt(z)?.kind ?? "viaduct";
  }

  /** True when z is within `pad` of a section boundary — where the deck gets
      its expansion joint and the structure visibly hands over. */
  atSectionEdge(z: number, pad: number) {
    const w = this.wrapZ(z);
    for (const s of this.sections())
      if (Math.abs(w - s.z0) < pad || Math.abs(w - s.z1) < pad) return true;
    return false;
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
    return this.edgeLat(z, -1) - SIGN.POST_OUT;
  }
}

/** Throws if a furniture pitch would put the two sides of the splice out of
    phase. Called once at world build; the corridor check calls it too. */
export function assertPitches() {
  for (const [k, p] of Object.entries(PITCH))
    if (LOOP_LEN % p !== 0)
      throw new Error(`corridor: PITCH.${k} = ${p} does not divide LOOP_LEN ${LOOP_LEN}`);
}

/** Advance-warning countdown for a gore, metres back from it. A real freeway
    tells you about an exit at a kilometre, again at 500 and again at 200, and
    only then puts a panel on the gore itself — so that is the sequence.
    Before this the whole warning was two boards, at 400 m and 200 m. */
export const EXIT_COUNTDOWN = [1000, 500, 200] as const;
/** …and for an entrance, where what the through driver needs is notice that
    traffic is about to join, not a destination. */
export const MERGE_COUNTDOWN = [400, 150] as const;

/** Place one countdown board, dodging the tunnels.

    A mast does not fit under a tube, and the west bore moves with the seed,
    so a board's nominal z may land inside one. Rather than deleting the board
    (which is how the lap ended up with no warning at all through a long tube)
    it is moved to whichever portal keeps its distance closest to the one
    asked for, and RELABELLED with the distance it actually has. A countdown
    that reads 950 / 460 / 200 is still a countdown; one with a hole in it is
    not. */
function countdownZ(gore: number, d: number, tubes: readonly TunnelSpec[]) {
  let z = gore - d;
  const t = tubes.find((q) => z > q.z0 - 12 && z < q.z1 + 12);
  if (t) {
    const back = t.z0 - 45, fwd = t.z1 + 45;
    z = Math.abs(gore - back - d) <= Math.abs(gore - fwd - d) ? back : fwd;
  }
  return { z, dist: Math.max(0, Math.round((gore - z) / 10) * 10) };
}

/** The cantilever boards, in one place so the geometry and the checks agree.
    Ordered by z. */
export function signPlan(): SignSpec[] {
  const out: SignSpec[] = [];
  const exitZ = CONNECT_Z[0], entryZ = CONNECT_Z[1];
  const tubes = TUNNELS;
  /* EXIT 1 countdown. The panels are wider than the old boards (9.4 m against
     7.4) because the mast now stands outboard of the deceleration lane: at
     7.4 m the panel hung entirely over the aux lane and never reached the
     through lanes a driver is actually in. Height is unchanged — the crossing
     overpasses at z −912/−816/−720 have a 9.0 m soffit and the mast tops out
     at 8.4 m under it. */
  for (const d of EXIT_COUNTDOWN) {
    const { z, dist } = countdownZ(exitZ, d, tubes);
    out.push({ z, w: 9.4, h: 2.8, kind: "exit-count", gore: 0, dist });
  }
  /* The EXIT ONLY panel. It hangs over the deceleration lane at the point
     the lane is handed to the ramp — 40 m used to put it at the mouth, but
     the mouth is now RAMP_LEAD longer and a mast there would be standing in
     the parapet gap, on the ramp's own pavement. */
  out.push({
    z: exitZ - RAMP_LEAD - 30, w: 9.4, h: 2.8, kind: "exit-gore", gore: 0, dist: 0,
  });
  /* Merging traffic ahead, twice, so it is not a surprise either. */
  for (const d of MERGE_COUNTDOWN) {
    const { z, dist } = countdownZ(entryZ, d, tubes);
    out.push({ z, w: 6.6, h: 2.5, kind: "merge", gore: 1, dist });
  }
  /* Toll boards are placed by absolute z, not by distance: the tunnel sits
     between the plaza and anywhere a "500 m" board would naturally go, and a
     cantilever mast does not fit under the tube. One goes just short of the
     entry portal, one just past the exit portal. */
  const east = TUNNELS[TUNNELS.length - 1]; // the tube the plaza sits behind
  for (const z of [east.z0 - 40, east.z1 + 70])
    out.push({
      z, w: 7.4, h: 2.8, kind: "toll", gore: -1,
      // to the gates themselves, which sit at the centre of the full-width
      // window, not at its leading edge
      dist: Math.round(((TOLL.plazaZ0 + TOLL.plazaZ1) / 2 - z) / 10) * 10,
    });
  /* Two boards on top of each other read as one unreadable board, and the
     countdown resolver can stack two of them against the same portal. Keep
     the one that is closer to its gore — the later warning is the one a
     driver still needs. */
  const sorted = out.slice().sort((a, b) => a.z - b.z);
  const kept: SignSpec[] = [];
  for (const s of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && s.z - prev.z < 45) kept[kept.length - 1] = s;
    else kept.push(s);
  }
  return kept;
}

/** Singleton. The corridor is deterministic *given the road seed*, which is
    resolved here — at module load, before anything can ask for a corridor —
    rather than threaded through every caller. setRoadSeed() re-plans and
    drops the cache; see the road-plan block above. */
let _corridor: Corridor | null = null;
setRoadSeed(storedSeed());
export function getCorridor(): Corridor {
  if (!_corridor) _corridor = new Corridor();
  return _corridor;
}

/** z of the two gores, re-exported so callers don't need const.ts as well */
export const GORE_Z = CONNECT_Z;
