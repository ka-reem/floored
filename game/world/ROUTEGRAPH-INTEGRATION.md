# Route graph — stage-2 integration contract

> **2026-08-28, mountain-road lane:** the graph has since grown EXIT 4
> (`corridor.MTN`, the one-way mountain pass — two-way when it first
> landed, reworked to a single lane in one direction on 2026-09-04). Two
> junction nodes split the
> old seam edge, and three edges were appended — `MAIN_PASS_WINDOW_EDGE` (8),
> `MAIN_RIVER_EDGE` (9), `MOUNTAIN_EDGE` (10, `graph.mtn`) — so ids 0–7 below
> keep their meaning but `main/seam` now ends at `mtn-diverge` and there is a
> fourth loop, `mountain`. `surfaceAt`/`newParapetGaps`/`distToNew` walk
> `graph.attached` (`[bypass, mtn]`); `mergeWindow(edge?)` takes the edge;
> gap entries carry an `edgeId`; `graph.apronW/apronAt/mtnAprons` are the
> deck-frame gore runoff aprons (see docs/handoff/reports/mountain-road.md).
> The stage-2 contract below is otherwise unchanged and remains accurate for
> the bypass/town wiring it describes.

Stage 1 (this worktree) shipped the graph **core**: `game/world/routegraph.ts`,
verified standalone by `test/routegraph-check.mjs`. Nothing visual changed and
no consumer was touched — the main loop is bit-identical (corridor-check runs
inside routegraph-check as a regression gate).

This file is the exact work order for stage 2, per consumer, on fresh main
after the concurrent lanes merge. Everything stage 2 needs is already exported
and tested; the tasks below are mechanical.

## The model (what stage 2 builds against)

```ts
import {
  getRouteGraph, RouteGraph, RouteEdge, MainRouteEdge, PolyRouteEdge,
  RouteStation, RoutePose, BridgeCrossing, Pier, SurfaceHit,
  DIVERGE_Z, MERGE_Z, BYPASS,                  // gore z's + cross-section spec
  MAIN_SEAM_EDGE, MAIN_TOWN_EDGE, MAIN_CLIMB_EDGE, MAIN_TUNNEL_EDGE,
  BYPASS_EDGE, EXIT_RAMP_EDGE, FRONTAGE_EDGE, ENTRY_RAMP_EDGE,
} from "./routegraph";                          // (path from game/world)
```

- **Nodes** (6): `exit-gore` (z −500), `entry-gore` (z 20), `bypass-diverge`
  (z 500, west side), `bypass-merge` (z 1580, EAST side — a Shuto-style
  fast-lane merge), `exit-foot`, `entry-foot` (frontage road, x 435).
- **Edges** (8): four `MainRouteEdge`s covering the whole corridor loop
  (delegating every query to the untouched `Corridor`), the `bypass`
  (`PolyRouteEdge`, 2 lanes, 1123.7 m), the two wrapped town ramps, and the
  `frontage-link` street edge (`viaRoadNet: true` — topological only; real
  pavement/traffic stay on the RoadNet).
- **Loops**: `graph.loops()` → `main`, `bypass`, `town`; all close;
  `graph.assertClosed()` throws on any regression. Call it once in the world
  build right next to `assertPitches()`.
- Every edge answers the full corridor-style API **in its own arc-length
  station space `s`**: `poseAt(s, out?)`, `worldOf(s, lat, out?)`,
  `laneCount/lanes/lanePitch/laneOffset/laneEdge/halfWidth(s)`,
  `heightAt(x, z, pad?)`, `project(x, z)`, `polyline(step?)`,
  `sLattice(pitch, phase?)`. `MainRouteEdge` additionally has
  `zAtS(s)`/`sAtZ(z)` so z-thinking consumers never need to convert by hand.
  `PolyRouteEdge` additionally exposes `stations` and `halfWidths(s)`
  (asymmetric `hwL`/`hwR` — the gore wedges clip the deck side) and per-station
  `bank` (dy/dlat superelevation; 0 at both gores, ≤ 8%).

Bypass shape (all verified by the test):
- Diverges west at z 500, separates by z ~580, climbs at ≤ 5.1% to 22 m.
- **Bridge**: crosses back east OVER the open main deck at main z ∈ [812, 840]
  (centre 832, right before the tunnel mouth the main route is diving into);
  deck 6.3 m, bridge 18.2 m, min clearance 9.45 m — clears the 7.6 m lamp
  masts under it by > 3 m. `graph.crossings` carries `{z0, z1, zMid, sMid,
  mainY, bridgeY, minClear}`.
- Elevated run above the east frontage strip (y 18–22) while the main route is
  in the tunnel and toll plaza, one dip for rhythm, min curve radius 87 m.
- Descends and merges from the east at z 1580; `graph.mergeWindow()` →
  `{s0, s1}` (64 m at deck level beside the fast lane).
- `graph.piers(terrain.h)` → `{piers: {x, z, topY, s}[], spans}` — 26 piers,
  one clear span over the deck. `graph.newParapetGaps()` →
  `[{z0: 492, z1: 580, side: -1}, {z0: 1516, z1: 1588, side: +1}]`.
- `graph.surfaceAt(x, z, pad?)` → `{y, edgeId, s, lat, bank} | null` — the
  bypass surface ONLY (main deck and town ramps keep their existing channels,
  so no double-reporting). `graph.distToNew(x, z, max)` for building keep-out.

## world build (whichever module assembles WorldData — today highway.ts's caller)

1. `const routes = getRouteGraph(); routes.assertClosed();` and store it:
   `world.routes = routes` (`WorldData.routes` already exists, optional).

## terrain.ts (Lane H's file — ONE addition)

`makeTerrain().heightAt(x, z, refY)` gains, next to the ramp clause:

```ts
const g = getRouteGraph().surfaceAt(x, z, 1.0);
if (g && Math.abs(g.y - refY) < 3.4) best = Math.max(best, g.y);
```

Same refY gating as ramps, so a car on the frontage road under the viaduct is
never yanked up (test guarantees the bypass is ≥ 6 m above any live street
mid-route and never answers near deck height over the main pavement).
Optionally expose `onBypass = (x, z) => routes.surfaceAt(x, z)?.y ?? null`.

## highway.ts (mesh build-out)

- **Bypass deck**: sweep `routes.bypass.stations` exactly like the main deck
  sweep over `cor.stations` — pavement quad strip using per-station
  `x,y,z,nx,nz` with edges at `+hwL` / `−hwR` and cross-fall `lat * bank`;
  fascia + parapets along both edges except where `hwL`/`hwR` < full
  (`BYPASS.half`) on the deck side (the gore wedges — there the deck's own
  edge continues). Markings: centre dash via `bypass.laneEdge(1, s)` on
  `bypass.sLattice(16)`; edge lines at `±(half − 0.45)`.
- **Bridge**: for each `cr of routes.crossings`, build the crossing span's
  girder/underside between `cr.z0 − 10` and `cr.z1 + 10` (use `cr.sMid` to
  index stations); `BYPASS.deckT` = 1.1 is the structural depth the clearance
  numbers assume — do not thicken below the soffit.
- **Piers**: instance the existing pier mesh at `routes.piers(terrain.h).piers`
  (box from ground `terrain.h(x,z)` up to `topY`). No pier inside `spans`.
- **Parapet cut-outs**: extend the existing `parapetGap` skip with
  `routes.newParapetGaps()` — west wall gap [500, 580], east wall gap
  [1512, 1588]. (Note: the EAST parapet gains its first-ever gap.) The windows
  are derived from the stations, so read them, never the numbers: the west one
  used to open 8 m ahead of the diverge nose, which cut the parapet over deck
  edge the bypass does not reach yet and left an open 10 m drop beside the
  kerb lane. Each gap now starts and ends where the bypass pavement does.
- **Furniture skips** (same predicates that already guard CONNECT_Z):
  - gantries: also skip `|z − DIVERGE_Z| < 220 || |z − MERGE_Z| < 220`
    (today a gantry lands exactly at z = 500 — it must go);
  - sound walls: also skip within 260 of the two new gores;
  - streetlights: skip poles whose z falls inside a new parapet gap **on the
    gap's side** (`side` field vs the pole's `flip`).
- **Signs**: extend `signPlan()` (corridor.ts, additive) or place directly:
  exit-count boards at DIVERGE_Z − 400/−200, exit-gore board at
  DIVERGE_Z − 40 (west), and a merge board on the main deck at
  MERGE_Z − 150 ≈ 1430 — that z is inside the toll zone, so hang it from the
  toll canopy or move to 1240 (tunnel exit + 
  a "merging traffic" wording). Bypass-side furniture (lights every 50 m of s
  via `bypass.sLattice(50, 25)`, its own gore beacon at the merge) is free
  spacing — no LOOP-phase constraint, the bypass never crosses the seam.
- **exits HUD**: `world.exits.push({ z: DIVERGE_Z, no: 3, name: "湾岸 Bypass" })`.

## collide.ts

The analytic parapet clamp currently exempts only west-side ramp gaps. Add:

```ts
for (const gp of world.routes.newParapetGaps())
  if (car.z > gp.z0 && car.z < gp.z1 && side === gp.side) guarded = false;
// and while on the bypass surface at deck height, like onRamp:
const s = world.routes.surfaceAt(car.x, car.z, 1.0);
if (s !== null && Math.abs(s.y - car.y) < 2.6) guarded = false;
```

Bypass edge containment (its own "parapets"): clamp exactly like the deck —
`hit = routes.bypass.project(x, z)`; if `|hit.lat| > halfWidth(s) + 0.06 −
halfW` and the car's y is within 2.6 of the surface, push back along the
station normal. Skip the clamp where `halfWidths(s)` is gore-clipped on the
deck side (the wedge is shared pavement).

## traffic.ts

NPC state: add `route: number` (edge id; main edges keep `n.s` = corridor z
exactly as today, so **existing behavior is the `route ∈ {0..3}` case and needs
no change** — main-route cars can even keep `route` implicit). Bypass cars:
`route = BYPASS_EDGE`, `n.s` = edge arclength (the town-street cars already
work this way on REdges — same pattern).

- **Route choice**: in `stepHwy`, when `graph.nextJunctionOnMain(n.s).node
  .name === "bypass-diverge"` and `dz < 350` and lane 0 (kerb lane), roll the
  driver's exit probability (~0.25); set blinker, steer to lane 0, and at
  `dz ≤ 0` switch to the bypass: `n.s = 0` (+ carry-over), positions from
  `bypass.worldOf(s, bypass.laneOffset(k, s))`, `hVis` from
  `bypass.poseAt(s).h`.
- **On the bypass**: IDM unchanged; leaders are cars with the same `route`
  ordered by s (no wrap on the bypass — it is finite; cars past
  `mergeWindow().s0` change "lane" onto the deck). Lane follow uses
  `bypass.laneOffset(k, s)`; speeds ~10% higher than the deck's slow lanes —
  it is the sporty route.
- **Merge**: inside `mergeWindow()` s-range, convert back:
  `n.s = cor.zAt(x, z)` (≈ 1516–1580), `laneK = cor.lanes(z) − 1` (fast
  lane — it is an east merge), then normal lane logic takes over. Yield: run
  the same gap-acceptance used for lane changes against deck cars in the top
  lane.
- **Spawn/despawn**: `trySpawnHwy` may also seed onto the bypass when the
  player is on it (same hidden-check; use `bypass.worldOf`); recycling by
  distance uses world positions, unchanged. `placeHwy`'s deck-height snap must
  use `graph.surfaceAt` when `route === BYPASS_EDGE` instead of
  `cor.heightAt`.

## minimap.ts / cockpit.ts (nav screen)

Both draw the corridor band from `cor.stations`. Add, once per canvas rebuild:
`for (const pl of world.routes.polylines())` draw `pl.pts` (skip
`kind === "main"` — already drawn; draw `street` dashed). The bypass ribbon
can use `bypass.stations` with `hwL/hwR` for a true-width band. Mark the two
new gores like the existing exit triangles (`DIVERGE_Z` west, `MERGE_Z` east).
Player-on-bypass detection for the "you are here" arrow:
`world.routes.surfaceAt(x, z)` non-null → snap the arrow to the bypass ribbon.

## engine.ts

- `respawn`/`resetCar`: unchanged (spawn band untested… tested unchanged:
  [−407, −73]). Optionally: if the car was on the bypass
  (`surfaceAt(x,z,2) !== null`), respawn to
  `bypass.worldOf(s, laneOffset(mid))` instead of the corridor.
- The wrap logic needs NO change: the bypass never leaves the canonical band
  (asserted in tests), so `spliceDelta` behaves.
- Debug: `toBypass: (kmh) => teleport(bypass.worldOf(60, 0)…)`.

## audio / post

Nothing required. Optional: wind gust + reverb drop on the viaduct via
`surfaceAt` altitude (y − 10).

## Ordering & verification for stage 2

1. Wire `world.routes` + terrain clause + collide exemptions (car can drive
   the bypass on invisible pavement) → verify with test/corridor-drive.mjs
   extended to steer into the diverge.
2. Meshes (deck, bridge, piers, parapet cuts, furniture skips).
3. Traffic, then minimap/nav, then signs/HUD.
4. `node test/routegraph-check.mjs` after every step — it re-runs
   corridor-check inside itself; both must stay green with zero diffs to
   corridor.ts.
