# FLOORED — the whole game in one file

Written 2026-08-21; factual claims re-verified and updated 2026-08-29 against
`main` after the two-day overhaul (the 2026-08-28 merge wave — see
`docs/CHANGELOG-2026-08-28.md`). This is the orientation document: read it top
to bottom and you should be able to open any file in `game/` and know why it
looks the way it does. It is not API reference — it is the reasoning.

A warning about line numbers: this document names **files and symbols**, and
mostly avoids line numbers, because the tree was under heavy parallel edit
while this was written and line numbers drift by the hundred. Symbol names are
stable; grep for them.

---

## 1. What the game is

A night drive. You are in a car on an elevated Japanese urban expressway —
首都高 — that loops forever, with a procedurally generated town beneath it.
There is dense AI traffic, rain, neon, fog, seeded tunnels (two per lap), a
toll plaza, an on-ramp and off-ramp, a bypass viaduct that crosses back over
the main deck, a two-way mountain road off EXIT 4 (峠 Tōge, `corridor.MTN` /
`game/world/highway.ts`), a necklace of roadside districts within sight of the
deck (`game/world/scenery.ts`), and a garage of five cars — two playable,
three COMING SOON.

There is no race and no timer, but there is a score: the **clean run**
(`CLEAN_RUN` + `runUpdate` in `engine.ts`) — how far you have driven since
your last real impact, in miles or kilometres depending on the speed-units
setting. A real impact zeroes it, a scrape does not, and the profile keeps
your furthest (`Profile.cleanRunBest`). It is deliberately quiet HUD chrome on
top of the drive (`settings.cleanRunScore` turns it off), plus an optional
**rival** pace car (`settings.rival`, `traffic.ts` "the rabbit"). The game is
still the drive.

Built with Next.js 16 + React 19 + Three.js (r180). Everything is client-side
WebGL; the server does nothing but serve the bundle. Package name
`floored`, version 3.0.0. `racing-game.html` at the repo root is the
pre-Next single-file v2 original, kept for reference and not part of the build.

---

## 2. The one rule that governs everything — and its 2026-08-28 amendment

The original rule explains more odd-looking code than anything else in this
document:

> `CAM_POV` — the hard-mounted **DASHCAM** view, last in the camera cycle — is
> the view the game is actually played in. Treat it as the only one that ships.
> CHASE, COCKPIT and HOOD exist for debugging and possible later use.

**The "only view that ships" half is RETIRED** (2026-08-28): players use
multiple cameras, so CHASE, COCKPIT, HOOD and the
CONSOLE camera are player-facing now, and a change may not degrade them. What
survives: the dashcam is still the **default** and the first frame to judge
any visual change in, and everything below about the optimisations the rigid
POV lens made legal is still how the code is built.

Concretely, `game/engine.ts` declares:

```ts
const CAM_CHASE = 0, CAM_COCKPIT = 1, CAM_HOOD = 2, CAM_POV = 3, CAM_CONSOLE = 4;
const CAM_COUNT = 5;
const CAM_NAMES = ["CHASE", "COCKPIT", "HOOD", "DASHCAM", "CONSOLE"];
const CAM_CYCLE = [CAM_CHASE, CAM_COCKPIT, CAM_HOOD, CAM_CONSOLE, CAM_POV];
```

`C` cycles them in `CAM_CYCLE` order — not numeric order, because `camMode` is
persisted, so CAM_CONSOLE took the free index rather than renumbering every
saved profile. A **first-run profile defaults to `camMode: 3`** — before that
change, every new visitor landed in third person and never saw the interior.

### What follows from the rule

The dashcam is a *rigidly mounted lens*. It does not spring, lean, look ahead,
or look back — entering POV explicitly zeroes all the head-spring state so that
returning to COCKPIT starts centred. Because the lens never moves relative to
the dashboard, a whole class of optimisation becomes legal, and the codebase
takes all of them:

- **The donor dash used to be clipped to the POV frustum at bake time** — 42%
  of the imported Volvo model's geometry deleted as permanently out of frame.
  That cut is RETIRED (it printed sliced edges once the FOV slider widened
  past what it was cut for; see DISABLED.md §11): the shipped
  `volvo-s90-full.glb` is whole donor nodes, decimated, never frustum-clipped.
  The bake-time aggression moved from "delete what the lens can't see" to
  "decimate what it can".
- **POV has its own lens maths but now honours the FOV slider.** It derives
  its vertical FOV from a *horizontal* target against the live aspect ratio
  (`povFov()` / `lensFov()`), with the slider clamped 58–`POV_FOV_MAX` (100°)
  as the last gate before the projection matrix. The old fixed-105°-horizontal
  lens went with the frustum-cut dash.
- **POV forces a harder post-processing degrade**, independent of the `V`-key
  dashcam filter (see §5.6). Cheap-sensor artefacts — interlace tear, macroblock
  snap, bit-crush, sensor bleed — are the *look*, not a toggle.
- **The dashcam has its own microphone character.** `audio.setInterior()` now
  takes three modes — `"pov"`, `"cabin"` (COCKPIT and CONSOLE), `"out"` — and
  POV's cabin lowpass takes more perceived engine loudness out than any level
  knob (see the comment at `audio.ts` ~396). It used to get no interior EQ at
  all; the three-mode split replaced that.
- **The headlight beam carpet is widened 1.5× laterally in POV only**, to
  correct for the wide lens.
- **Impact glitch effects only fire in POV.** They are gated at the *call site*
  rather than inside `post.dashcamHit()`, specifically so a hit taken in another
  camera cannot arm a burst that fires later when the player switches into POV.
- **Every lighting decision is budgeted against two numbers in the POV
  composite**: the blown-highlight clip at `smoothstep(.72, 1.02, luma)` and
  the black crush around `.06`. Comments across `mats.ts`, `traffic.ts`,
  `engine.ts` and `decaltex.ts` quote those two constants as tuning targets.
  (The crush itself was softened in the dashcam-clarity pass — the old hard
  clip `max(col - .06, 0)` is now a soft-max toe, so darks fade out instead of
  snapping to black — but the *threshold* is still the tuning target.) A light
  that "has a hard edge" is usually not a falloff bug — it is one of those two
  thresholds being crossed.

A change is judged in the dashcam first — but "only matters in CHASE" is no
longer a reason to skip it (2026-08-28): the chase camera fronts the rebuilt
player-car exterior and gets real quality attention.

---

## 3. How to run it

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npm start        # serve the production build
npm run lint
```

Deploy is Vercel from git. `vercel.json` is one line of config and it disables
auto-deploy **on `main` only** — feature branches auto-deploy to preview URLs,
production ships by explicit manual promote. The Vercel project is named
`wangan`, not `floored`.

`next.config.mjs` sets `reactStrictMode: false`. That is load-bearing: StrictMode
double-invokes effects, which would construct two `Game` instances and two WebGL
renderers.

**Assets deploy from git**, which is why the baked cockpit GLB (5.7 MB,
`volvo-s90-full.glb`) is committed rather than gitignored. A gitignored dash
means every visitor silently falls back to the procedural one.

### The test suite

~47 scripts in `test/` as of 2026-08-29 (plus whatever `_*-scratch.mjs` probes
are left lying around) — the overhaul brought its own sims and probes with it
— of which exactly **two** are wired to npm:

| Command | What it does | Needs a server? |
|---|---|---|
| `npm run engine-rpm` | Compiles the real `physics.ts` and asserts the flywheel model's properties across the whole roster | **No** |
| `npm run smoke` | Full headless boot, menu walk, drive, crash, screenshots to `test/artifacts/` | **Yes** — and it spawns its own `next dev -p 3111` if you don't pass `--url` |

The rest are run by hand. There is no CI, no runner, no `test` script.
Practically they fall into three tiers: standalone regression checks, browser
assertion checks, and one-off investigation instruments kept around as evidence
(several headers say "NOT part of CI" outright).

**Standalone — no server, no browser** (run these freely; list not
exhaustive): `audio-assets-check`, `audio-creak-sim`, `bypass-drive`,
`corridor-check`, `corridor-drive`, `engine-rpm-check`, `lane-plan`,
`ramp-attach-sim`, `routegraph-check`, `size-budget`, `traffic-bias-check`,
`traffic-merge-sim`, plus the overhaul's own sims (`mountain-traffic-sim`,
`rival-sim`, `whiteline-sim`, `console-fov-sim`, `testdrive-accel-sim`,
`steer-response-sim`, `hail-sim`, `roster-check` and friends — check each
header).

Several of those shell out to `npx tsc` to compile `game/world/*.ts` into a
temp dir first, because there is no bundler in the test path.

**Puppeteer — need the app served over HTTP**: `smoke`, the `audio-*-check`
scripts, `bypass-shots`, `canvas-dump`, `carscreen-shots`, `corridor-shots`,
`lane-r-measure`, `lap-shots` (the 40-station dashcam contact sheet),
`pov-bisect`, `pov-paint`, `pov-shot`, `ramp-debug`, and more of the same
vintage.

URL conventions are inconsistent by vintage — most take `--url <url>` with a
per-script default port (3141, 3142 or 3000); `canvas-dump` and
`carscreen-shots` read `SHOT_URL`; `ramp-debug` takes a bare `process.argv[2]`.
They all drive the game through `window.__neonx`, the debug API the `Game`
constructor installs (see §5.1).

### The size budget now passes

`node test/size-budget.mjs` checks committed assets against a 15 MB
critical-path budget and a 30 MB total budget. When this section was first
written the critical path failed at 22.96 MB, dominated by the 16.35 MB
frustum-cut Volvo dash. That asset was retired and replaced by the 5.68 MB
`volvo-s90-full.glb` whole-cabin decimation, and the budget has passed since.
Verified 2026-08-29:

```
Critical: 12.78 MB / 15 MB budget
Total:    14.86 MB / 30 MB budget
OK: within budget
```

Re-run the script rather than trusting the figures above — the whole point of
the check is that assets keep moving. `public/models/cars-hd` is listed but
absent: the desktop lazy HD fleet upgrade is parked (`HD_STYLES` is empty in
`game/npcmodels.ts`) until a bake worth streaming exists.

---

## 4. Architecture

### The map of `game/`

| File | Owns |
|---|---|
| `engine.ts` | **The conductor.** The `Game` class: main loop, cameras, staged world load, weather and time of day, headlight rig, HUD, tunnel acoustics, endless-highway splice, chunk culling, keybinds, debug API |
| `physics.ts` | Pacejka bicycle-model vehicle sim, drivetrain, the engine flywheel model |
| `carspecs.ts` | The five cars — two playable, three COMING SOON: body shape params, physics params, paints |
| `collide.ts` | Player collision against parapets, static geometry, and NPCs |
| `traffic.ts` | The pooled NPC fleet: IDM car-following, lane changes, wrecks, courtesy/yielding, instanced rendering |
| `npcmodels.ts` | Loads the nine baked NPC body GLBs (and holds the parked HD-fleet lazy-upgrade path, `HD_STYLES`) |
| `bodymodel.ts` | Loads the donor Volvo exterior shell (`volvo-s90-body-lite.glb`) for the chase cameras, mirror and garage |
| `gamepad.ts` | Gamepad polling — a pad that is connected and in use writes the whole frame's input |
| `audio.ts` | The entire Web Audio graph — engine, tyres, wind, rain, crashes, horns, reverb |
| `music.ts` | Synthesised classical music player for the dash screen (independent AudioContext) |
| `post.ts` | `PostFX`: HDR pipeline, bloom, ACES, film grade, FXAA, motion blur, and both dashcam degrade passes |
| `textures.ts` | Procedural canvas textures + the photo-scanned PBR loader |
| `fx.ts` | `RainFX` and `SmokeFX` particle systems |
| `player.ts` | Assembles the player car: materials, wheels, lamps, headlights, cockpit attach |
| `carshape.ts` | Pure parametric car geometry — no materials, no scene |
| `cockpit.ts` | The whole procedural RHD interior, and the interface the imported dash swaps into |
| `cockpitmodel.ts` | Swaps the imported donor dash over the procedural one |
| `dashboard.ts` | The instrument cluster (dials, needles, info panel, shift lights) |
| `carscreen.ts` | The head unit's 256×160 screen — music card + nav pane |
| `minimap.ts` | The north-up map, drawn into both the HUD overlay and the nav pane |
| `carpreview.ts` | Offscreen studio renders of cars for the garage UI |
| `carenv.ts` | HDRI environment map for car bodywork — **nothing to do with audio** despite the name |
| `settings.ts` | Settings shape, the render-tier hardware classifier, profile persistence |
| `loading.ts` | The yield-to-paint machinery that makes a staged loading screen possible |
| `util.ts` | `mulberry32` seeded RNG, `clamp`, `lerp`, and friends |
| `world/` | The world generator — see §5.2 |

React shell: `app/page.tsx` → `components/GameApp.tsx` (dynamic import,
`ssr: false`). `app/layout.tsx` is metadata plus a viewport locked against
pinch-zoom (it would fight the touch controls).

### How a frame flows

The loop is `Game.loop`, an arrow-function field so it is rAF-safe. Verified
order:

```
requestAnimationFrame re-armed FIRST
dt = min(now - last, 0.1)                 // hard clamp: never sim >100 ms
readInput(dt)                             // runs even while paused
hiBeamHold(now)                           // runs even while paused

if (running) {
  acc += dt
  while (acc >= 1/120 && substeps < 6)    // fixed 120 Hz physics
      stepPhysics(car, input, spec.phys, 1/120, { mu, tcEnabled, heightAt })
  if (acc > 1/120) acc = 0                // drop the backlog, never fast-forward

  loopSplice()                            // endless-highway wrap, BEFORE anything reads the car
  collidePlayer(...)                       // parapets, world geometry, NPCs
    -> scrape audio, traffic.applyImpact, audio.crash, post.dashcamHit
  traffic.update(...)                      // NPC AI + instanced render fill
  smokeFX / signals / weather(dt, now)     // time of day, fog, lights, headlight rig, rain
  updateCarVisual() / updateCamera(dt)
  interiorUpdate() / tunnelUpdate()
  audio.update(car.rpm, ...)               // note: car.rpm, not rpmDrive
  npcAudioFeed()
  hud(now, dt)                             // throttled to ~12 Hz
  chunksUpdate()                           // at most every 0.16 s
  minimap redraw                           // every 4th frame
}

mirror RT render                           // every 2nd frame, COCKPIT/POV only
reflection RT render
render(scene, camera) -> post.sceneRT
post.setSpeed() / post.setDashcamPov(camMode === CAM_POV && tierCaps.dashcam)
post.process({ exposure, grade, bloom, fxaa, mblur, time })
perfCheck(frameMs, dt)
```

Three things worth knowing that a sketch of this usually gets wrong:

1. **The timestep and substep cap have no names.** They are the inline literals
   `1 / 120` and `it++ < 6`, written out three times in `engine.ts`. Combined
   with the 0.1 s `dt` clamp, a single frame can consume at most 50 ms of sim.
2. **`loopSplice()` runs after physics, not at frame start** — and the comment
   says why: splice before anything else reads the car this frame, or one of the
   things that tracks it "spends a frame 4 km away."
3. **Rendering is unconditional.** It runs while paused too, so the pause menu
   sits over a live-graded frame. Only the simulation is gated on `running`.

### Boot: a two-phase start

The `Game` **constructor does not build the world.** It creates the renderer,
resolves the render tier, sets up cameras and the three environment lights,
builds `PostFX`, binds input, and installs `window.__neonx`. That's it.

`load(onProgress)` builds the world in **eight stages**, yielding to the browser
between each so the loading screen can actually animate:

| # | Label | Builds |
|---|---|---|
| 1 | `MIXING PAINT` | Materials, car env map, sky |
| 2 | `SHAPING THE LAND` | **Seeds the RNG**, terrain, road net, route graph, ground |
| 3 | `RAISING THE EXPRESSWAY` | The whole corridor: deck, tunnel, toll, ramps, bypass viaduct |
| 4 | `BUILDING THE TOWN` | Streets, sidewalks, buildings, neon, streetlights |
| 5 | `PUTTING CARS ON THE ROAD` | The 120-car fleet, rain and smoke FX |
| 6 | `WARMING THE ENGINE` | Player spawn, car rig, cockpit |
| 7 | `COMPILING SHADERS` | `renderer.compileAsync` |
| 8 | `ROLLING OUT` | Three warm frames through the real loop, paused |

Then `start()` → `primeAudio()` → `beginLoop()`. `primeAudio()` **must** be
called inside the user gesture — iOS only unlocks an `AudioContext` created
inside the tap itself — which is why `GameApp`'s DRIVE handler calls it as its
very first synchronous line, before the `await`.

A stage that throws latches `loadFailed` permanently. There is no resume and no
retry: the error state offers RELOAD, because retrying would stack a second town
on top of the first.

**The world is built once, entirely up front. Nothing streams.** What is
"chunked" is *visibility*, not generation: the town is baked into 96 m groups
and `chunksUpdate()` only flips `group.visible`. The illusion of endlessness
comes from the loop splice, not from streaming.

---

## 5. The subsystems

### 5.1 Engine, cameras, and the debug API

`engine.ts` is ~5100 lines and has explicit `/* ---- section ---- */` headers:
staged load, rig, input, settings, lifecycle, per-frame systems, endless
highway, tunnel, then `weather()` (the single largest method, ~465 lines), then
`updateCamera`, `hud`, and the main loop.

**`window.__neonx`** is installed by the constructor and deleted by `destroy()`.
Every browser test drives the game through it: `teleport`, `setCam`,
`setInput`, `toCorridor`, `toTunnel`, `toSeam`, `toBypass`, `toMountain`,
`state()` (a ~25-field snapshot), `crashTest`, `setRain`, `setTime`,
`collidersNear`, and `loadTimings` (real per-stage milliseconds, attached
after a successful load).
`window.__audioDebug` and `window.__audioTune` / `window.__povTune` are the
audio and post-processing equivalents — the last two are re-read **every frame**,
so you can tune the mix and the dashcam degrade live from the console.

**Keybinds** (verified against the handlers, 2026-08-29):

| Key | Action |
|---|---|
| `W`/`S`/`A`/`D` or arrows | throttle / brake-reverse / steer |
| `Space` | handbrake |
| `F` | horn (hold) |
| `Esc` | pause — the only key that works while paused |
| `C` | cycle camera: CHASE → COCKPIT → HOOD → CONSOLE → **DASHCAM** |
| `L` | headlights ON / AUTO |
| `Q` / `E` | left / right turn signal |
| `G` | high beams — tap to flash-to-pass, **hold 2 s** to latch |
| `B` | look back (hold; CHASE and COCKPIT only, POV ignores it by design) |
| `R` | rain · `T` time-lapse (0 → 150 → 1500) · `V` dashcam grade |
| `M` | mirrors · `X` minimap · `N` reset to nearest road · `H` controls overlay |
| `K` | test mode (the arcade physics set — see DISABLED.md §7) |
| `I` | interior cabin light — desktop only, by explicit request |
| `P` / `,` / `.` | music play-pause / prev / next — desktop only |

On touch, everything secondary lives in the ⋯ overflow drawer
(`components/GameApp.tsx`), which drives the same handlers via `uiKeyTap()` —
a drawer row and the key it stands for cannot drift apart. The README's
controls table was rewritten 2026-08-29 and agrees with this one.

**Reset (`N`)** has three branches: on the bypass viaduct, re-place mid-lane on
the current bypass edge; above y=4 (on the deck), `cor.respawn()`; otherwise find
the nearest town road and sit 1.95 m off its centreline, heading whichever
direction is within 90° of current.

**`perfMode`** is the reactive fallback: an EMA of frame time above 37 ms
sustained for 4 seconds drops DPR to 1, rebuilds render targets, and toasts
"PERFORMANCE MODE". It is orthogonal to the render tier (§5.7) — the tier is what
the hardware *is*, `perfMode` is what the frame times *do*, and they stack.

### 5.2 The world generator, and the seeded RNG chain

Everything lives in `game/world/`. There is no `buildWorld()` — the engine's
`buildStages()` assembles it.

| Module | Owns |
|---|---|
| `const.ts` | Scalar layout only. `HX = 500` (corridor x), `DECKY = 10` (deck height), `HZ = 2000` (half-length), `LOOP_LEN = 4000`, `LANE_W = 3.7`, `MAX_LANES = 6`, `TOWN` extent 760 × 840 m, `CHUNK = 96` |
| `terrain.ts` | The rolling heightfield the town conforms to, flattened under the expressway; the composite `heightAt()` that arbitrates ground / deck / ramp / bypass |
| `roadnet.ts` | The town street **graph**: jittered 74 m grid, pruned links, curved Bezier edges sampled to ~3.2 m polylines. Everything downstream — meshes, traffic, minimap, spawning — reads these samples |
| `corridor.ts` | **The expressway itself**, modelled as a graph over z (see below) |
| `routegraph.ts` | Promotes the corridor into a closed route graph and adds the **bypass** and the **mountain road** (EXIT 4) — `assertClosed()` throws on any dead end |
| `ramps.ts` | The two on/off ramp centrelines — the shared source for parapet gaps, meshes, colliders, drivable height, building keep-out, *and the player spawn* |
| `highway.ts` | All corridor mesh build-out: deck, parapets, markings, tunnel, toll plaza, ramps, bypass viaduct, gantries, signs, lights, barriers |
| `townmesh.ts` | Everything west of the deck. The **only** module that populates `world.chunks` |
| `mats.ts` | The shared material library plus four `onBeforeCompile` shader families |
| `decals.ts` / `decaltex.ts` | Road-realism decal scatter (5 instanced meshes = 5 draw calls for the whole corridor) and its texture supply |
| `sky.ts` | Sky dome, stars, moon, skyline, mountains, distant city glow, three landmarks |
| `aurora.ts` | The procedural aurora (own seed, deliberately off the world seed — `?aurora=<n>` pins it) |
| `nightclouds.ts` | The night cloud deck and storm layers |
| `scenery.ts` | The roadside districts, both passes: the far zone necklace (river/grove/industry/billboards) and the 2026-08-28 near-deck districts (wharf, eastside, foreground industry, neon canyon), gated by `FX_DISTRICTS` + `TierCaps.districts` |
| `deckdetail.ts` | Deck dressing detail overlays (highway-realism lane), scaled by `TierCaps.deckDressing` |
| `data.ts` | The shared contract: `WorldData`, `ColliderIndex` (26 m uniform hash grid), `signalPhase()` |

#### What a "corridor" is

`corridor.ts` models the expressway as **a function of z**. The centreline is
`(HX + xOff(z), DECKY + yOff(z), z)`, where the offsets are sums of smootherstep
"bends" **whose deltas sum to zero**. That is the whole trick: it makes
`z = -HZ` bit-identical to `z = +HZ`, so the endless loop is a **pure
translation** in z — no rotation, no x fix-up. `spliceDelta(car.z)` returns the
shift, and `loopSplice()` applies it to the car and to every camera position the
engine holds.

The corridor also owns the lane-count schedule (seeded per town since
`ca2c95b`: 3 to 5 lanes, `BASE_LANES = 3`, pinned to 3 across the splice and
toll), the two seeded tunnels (240–509 m, with generated Japanese names), the
toll plaza, the bridge and `OVERPASSES` lists, the sign plan, the mountain
road spec (`corridor.MTN`, EXIT 4), and the `stations` array that is the
single source of truth for **both** meshes and physics.

#### The bypass

`routegraph.ts` adds a second carriageway that diverges west at z=500, climbs to
a 22 m viaduct, crosses back *over* the main deck on an oblique bridge at
z≈832 — just as the main route dives into the tunnel — runs elevated above the
east frontage strip, and merges from the **east** at z=1580. Route 0 stays
bit-identical corridor geometry, because main edges delegate every query to the
`Corridor` singleton rather than reimplementing it.

`routegraph.ts` deliberately imports **no three.js**, so the whole module runs in
plain node and the browser-free test harnesses can drive it.

#### The seeded RNG chain — read this before adding any randomness

`util.ts` provides `mulberry32(seed)`. Its doc comment states the contract:
world generation must go through one of these so a seed always reproduces the
same town. The default seed is `1987`; Settings → NEW TOWN changes it and does a
`location.reload()`, because there is no rebuild path.

**It is one shared stream, not per-stage sub-streams.** One `Rng` closure is
created in stage 2 and the *same function object* is passed by reference into
every later stage. There is no `mulberry32(seed ^ SALT)` anywhere in the world
build. The engine's own comment:

> The order here is the order the old constructor ran in and **must stay that
> way**: `rng` is a seeded stream threaded through terrain → road net → highway
> → town, so moving any consumer changes what every later one draws for a given
> seed.

Verified draw order and counts:

| Stage | Draws |
|---|---|
| `makeTerrain(rng)` | Exactly **8**, all at construction — 5 phases and 3 amplitudes of a 3-octave sine hill field. Nothing else in the file touches `rng` |
| `buildRoadNet(rng, terrain)` | **Variable and data-dependent** — node drops, jitter, edge keeps, bulges, signal placement. Several draws are `&&`-short-circuited, so *whether a draw happens* depends on earlier draws |
| `buildHighway(..., rng)` | **Zero.** The parameter is accepted and never used |
| `buildTown(..., rng, ...)` | The heaviest consumer, all data-dependent — depth, height, texture index, roof kit, aerials, neon placement, storefronts, poles, clutter |

**Why one inserted draw breaks every seed.** Because it is a single stream,
*position in the sequence is the identity of a value*. Add one `rng()` call in
`makeTerrain` and every later consumer reads the value its neighbour used to
read. And it is not a clean off-by-one: draws in `roadnet.ts` and `townmesh.ts`
gate *control flow*, so a one-position shift changes **how many** draws the next
iteration makes, and the streams diverge chaotically rather than sliding.

The live hazard: `buildHighway` holds an `rng` reference it never uses. The
first time someone adds a random draw to the highway stage, every seed's town
changes wholesale. That parameter is a loaded gun sitting in the signature.

**Where it is safe to add randomness** — these are deliberately off the shared
stream:

- `corridor.ts` and `routegraph.ts` are fully deterministic. "The corridor is
  deterministic, so there is nothing to seed."
- `decals.ts` derives private per-slot streams from the *folded lattice index*,
  not the world seed — so the copy 380 m past the splice rolls the same dice as
  the copy 380 m before it.
- `sky.ts` uses unseeded `Math.random()` on purpose (cosmetic only — stars and
  distant windows differ every page load even at a fixed seed).
- `traffic.ts` has its own hardcoded `mulberry32(0xbeef)`.

#### The furniture lattice rule

Second only to the RNG ordering in blast radius. From `corridor.ts`:

> Every pitch here **MUST** divide `LOOP_LEN`, and every generator **MUST**
> place items on the global lattice rather than counting from the built extent.
> Otherwise the furniture is out of phase either side of the splice and the
> teleport is visible as a jump in the lamp-post rhythm even though the road
> itself matches perfectly.

`assertPitches()` throws if you break it, and it runs at world build.
`decals.ts` restates the same rule for its own lattice.

### 5.3 Vehicle physics and the drivetrain

`physics.ts` — a **bicycle model** (one front axle "tyre", one rear) with
**Pacejka Magic Formula** lateral tyres, longitudinal load transfer, a friction
ellipse, ABS with EBD brake bias, traction control, ESC, and slope forces. AWD
is a torque split, not extra wheels. Ported from v2 and parameterised per car.

`stepPhysics(car, input, spec, dt, opts)` mutates `car` in place. Grip comes in
through `opts.mu` — `1.26` dry, `0.84` in rain, set at the call site.

Five cars in `carspecs.ts`. Two are playable and **drive identically on
purpose** — they share one `PhysicsSpec` object (`SHARED_PHYS`), so they differ
only in how they look, inside and out: **VOLVO S90** (ボルボ, the default; donor
cabin and donor exterior body) and **KAZE GT** (疾風, procedural at both ends).
Three are `comingSoon`: **SHIRAYUKI** (白雪, RWD sedan, 6700), **TANUKI KEI**
(狸, kei car, 850 kg, 8000), **OKAMI TOURER** (狼, AWD, 6900). Each spec carries a `ShellParams` block
(all metres — length, width, ride height, belt line, roof, rake, arch radius,
wheel positions) consumed by `carshape.ts`, and a `PhysicsSpec` (mass, inertia,
wheelbase halves, CG height, track, wheel radius, final drive, six gear ratios,
a torque-curve breakpoint table, grip coefficients, steering limits, rev limit,
drag).

#### `car.rpm` vs `car.rpmDrive` — the split you must not collapse

This is the single most misunderstandable thing in the physics file, and there
is a whole document about it: **`docs/engine-sound-rpm.md`**. Read it before
retuning anything named `ENGINE_TUNE_DEFAULT`, `RPM_ANCHORS`, `LOOP_F0`, or
`stepEngineSpeed()`.

The short version:

| | `car.rpmDrive` | `car.rpm` |
|---|---|---|
| What it is | Pure driveline kinematics: `road speed / wheel radius × gear × final`, clamped to `[IDLE_RPM, revLimit]` | A **modelled flywheel** — torque converter slip, shift sweep, rev hang, asymmetric slew |
| Written by | The step function, directly | `stepEngineSpeed()` only |
| Read by | Torque lookup, limiter factor, rev limiter, the shift scheduler | The **tachometer**, the **audio**, and the debug snapshot |
| Scope | Never leaves `physics.ts` | Crosses into `engine.ts` and `audio.ts` |

The flywheel model exists because the old signal *had no engine in it*. Clamped
at `IDLE_RPM = 850`, flooring the throttle from rest moved the pitch not at all
— only the volume rose, which is exactly and literally "it's idling and just
getting louder." Gear changes teleported the needle ~2900 rpm between two
consecutive 1/120 s steps. And lifting off fired *two* upshifts in a quarter
second, because the shift map read the raw pedal.

`stepEngineSpeed()` fixes all three with: a converter target
`max(wheelRpm, IDLE + thr × (STALL_RPM − IDLE))` where `STALL_RPM = 2450`
(taking the **max** rather than crossfading on a lock factor, deliberately — a
crossfade sags, and nothing with a converter in it does that); an S-curve shift
sweep that **bypasses the rate limiter entirely** while shifting; `REV_HANG =
0.16 s` applied as a *brake on the downward slew rate*, not as a floor under the
target; asymmetric slew rates that open up ~9× once the clutch is locked; and a
**lagged pedal** (`car.thrPrev`, ~0.35 s trail) feeding the upshift map.

**The result is deliberately not fed back into the torque path**, so handling is
bit-identical to before it existed. Feeding a lagged rpm into the torque curve
would silently retune every car's acceleration.

Guarded by `npm run engine-rpm`, which compiles the real module rather than
checking a recorded trace. Verified passing: worst single-step motion is 134–165
rpm across the roster (was ~2900), and every car reaches exactly 2450 rpm at
0.5 s from a standing start at full throttle.

#### Collision

`collide.ts`, `collidePlayer(car, world, npcs, halfW, halfL)`. Four classes, in
order:

1. **Deck parapets** — *analytic*, not geometry. Clamps the car's lateral offset
   against the corridor's own half-width, so it can never disagree with the
   swept wall mesh (both come from the same number). Exemptions for ramp gaps,
   on-ramp pavement, and bypass gores.
2. **Bypass parapets** — the same analytic clamp in the bypass station frame.
3. **Static world geometry** — AABB for piers/toll islands/ramp walls, OBB for
   buildings, both circle-vs-box with the car probed as two circles along its
   heading. Broadphased by `ColliderIndex`'s 26 m uniform hash grid.
4. **NPC vehicles** — full 2-D SAT OBB-vs-OBB. No grid; a linear scan over 120
   cars with early-outs on `active`, height difference, and squared distance.

Response is positional depenetration plus velocity reflection, and — important
for the hand-back to the physics step — world velocity is **written back into
the body frame** at the
end, since `physics.ts` integrates in body coordinates. The positional
correction is capped per call (`CLAMP_STEP = 0.35`), because applying it whole
teleports the car sideways.

Results feed back three ways: the position delta drives the sustained scrape
audio bed; `npcHits` become wrecks via `traffic.applyImpact`; and impacts above
threshold fire `audio.crash()`, add damage, and glitch the dashcam.

### 5.4 Traffic and NPC behaviour

`traffic.ts` is the largest file in the project. A fixed pool of **120** `Npc`
objects, allocated once and never grown, with each slot's body style fixed for
the session from a weighted roster (sedan .25, hybrid .19, compact .19, suv .17,
taxi .07, van .06, truck .05, bus .02, plus two forced police cars). One
`InstancedMesh` per style — about nine draw calls for the whole fleet.

Live budget is `N × settings.traffic`, redistributed by where the player is.
**Town traffic is off** (`TOWN_TRAFFIC = false`) — the whole town driving path is
live code but unreachable in the shipping build.

**Two positioning worlds.** On the expressway, cars are not on a route graph at
all: they are positioned by *corridor station* (a z value) plus a lateral
offset, and the corridor turns that into a world pose. Only the town path uses
real road-graph edges.

**Car-following is IDM**, hand-rolled and duplicated three times (highway,
bypass, town) with near-identical constants — `aMax ≈ 1.6 × driver.acc`,
`bCom = 2.3`, headway `T = 1.25 × driver.gap`, `s0 = 2.2 + 1.4 × (gap − 1)`.
Leader perception is **not per-frame**: each driver re-reads the road every
`driver.react` seconds and dead-reckons the gap in between, with a forced
re-read inside 11 m.

**Driver personalities.** Five archetypes — dawdler, cautious, average, brisk,
speeder — each a range over `spd, gap, acc, lane, react, corner, timid, weave`,
rolled at spawn. Plus a persistent lateral bias (0.05–0.4 m) and, for ~60% of
drivers, a slow sinusoidal drift over a 20–40 s period.

**Lane changing** is gap acceptance, not MOBIL (despite what the file header
says). Commit is two-stage: blinker first for 1–2 s, *then* the lane index
moves. Crossing takes 2–4 s depending on driver aggression.

**The only junction decision on the expressway is the bypass diverge**, made
once per approach between 30 and 350 m out, tuned so ~28% of the stream peels
off. The return merge gap-accepts against the deck's fast lane with a hard
forced-entry deadline.

**NPCs never wreck each other.** NPC-vs-NPC contact is one cheap overlap pass
that just slows the rear car. Wrecks only come from *player* impacts above
2.6 m/s relative, at which point the car becomes a free body integrated with
damping and spin, contained by the parapets, and eventually dissolved out via an
ordered-dither `discard` on a per-instance attribute (no material clone).

#### The rival ("the rabbit") and the No Hesi score — added 2026-08-28

Two systems built on top of the fleet:

- **The rival** (`settings.rival`, off by default) is an optional persistent
  pace car that lives *in* the `npcs` array — collision needs no special case —
  but drives its own controller: it carves through the stream and will not
  slide into an occupied space (`rivalLatClear`), with `rivalSeparate()` as a
  hard backstop that only ever moves the rival. `settings.rivalSignals`
  decides whether it indicates; the absence of a blinker is characterisation.
- **No Hesi scoring** — RETIRED 2026-09-04, replaced by the clean-run
  distance (below). What survived is the near-miss streak (`scoreEvents` in
  `traffic.ts`, the `COMBO` block and `comboUpdate` in `engine.ts`): it still
  runs, silently, because two lifetime statistics are built on it
  (`stats.nearMisses`, `stats.bestCombo`) and a stored `bestCombo` is a record
  players already hold. The points total, the `×N` multiplier readout and the
  "+N CLOSE" toast are gone.

#### The clean-run score — added 2026-09-04

The game's score is now **distance driven since your last crash**
(`CLEAN_RUN` + `runUpdate` in `engine.ts`), shown in the player's own
distance unit — miles on mph, kilometres on km/h; there is no second unit
control.

- **Distance** is integrated in `statsUpdate`, off the same `|u|` and the same
  standing-still floor the lifetime odometer uses, so the score can never
  drift from the STATS board's DISTANCE row.
- **The crash rule** is one constant, `CLEAN_RUN.impact` (3.0 m/s): a contact
  resets the run when its *closing speed along the contact normal* reaches it.
  That signal is `normalImpact`, returned by `collidePlayer` — the `vn` every
  contact site in `collide.ts` already computed and threw away, maxed across
  walls, buildings and NPCs. It ignores speed *along* a surface, which is what
  separates kerbing a barrier from hitting one. Measurements behind the number
  are recorded with the constant in `engine.ts`.
- **Persistence**: `Profile.cleanRunBest`, metres, written by `persist()` and
  scrubbed in `loadProfile` like every other stored number. The old
  `noHesiBest` held points and is deleted rather than converted.
- **HUD**: one small dim figure, `#hud .runDist`, in three CSS treatments
  selected by `RUN_HUD` in `engine.ts` (corner / speed / ghost). A reset dims
  the figure and lets it settle back to `0.0` — no banner, no toast.

#### Traffic courtesy — the yield system

Committed, and the largest single feature in the file. The design problem it
solves is stated in a 60-line comment: a player flashes their lights *a lot*,
and any fixed per-flash probability converges on certainty.

So instead:

- Every driver rolls a personal **ceiling** at spawn — the total probability
  that this car will *ever* comply. It is indexed by archetype: a dawdler is
  0.55–0.80, a speeder is 0.02–0.15. The cars in your way are the ones worth
  asking. 8% of the fleet are "stone wall" (≤0.03 regardless), heavies are
  scaled to 45%, police are clamped to 0.02.
- Repeated gestures walk a **saturating** curve `C(k) = ceiling × (1 − e^(−k/2.6))`,
  rolled as a conditional probability so it approaches the ceiling and stops.
  Monte-Carlo over the real roster: **8% yield to one flash, 21% to a
  three-flash burst, 33% however long you keep at it.**
- **One car reacts per gesture**, picked by a score off the player's own nose
  (not the camera), within 5–55 m and 5.5 m laterally. Cars that already
  refused are deliberately *not* filtered out of the target search, so a spent
  driver absorbs the gesture rather than handing it to the wrong car.
- A car checks what it *could* do before spending any probability: courtesy is
  always toward the kerb, never out into the fast lane, gap-checked, and it will
  never merge onto the player. If it can neither move over nor speed up, it
  simply "never hears you."
- Two reactions: move over (through the normal signalled path), or speed up
  (preceded by a two-flash hazard acknowledgement).
- **Annoyance**: after 6 refused gestures, low-ceiling drivers have an 18%
  chance per gesture of a readable brake-tap and a horn back. Explicitly never a
  swerve.

The horn is edge-detected inside `traffic.ts` from the continuous input; the
headlight flash is edge-detected in `engine.ts` and passed as a one-frame pulse.

### 5.5 Audio

`audio.ts` is one class, `GameAudio`. The whole graph is built once in `init()`;
`update()` only moves AudioParams. Output spine:

```
master (0.9 × vol × duck) -> cabinLP -> cabinPeak -> destination
```

Both cabin filters sit at unity by default, so an uncalled `setInterior()` is
bit-identical to going straight to the destination.

Both engine voices share one output stage:
`engG + sampBus -> engLevel -> engShelf -> engLim (compressor) -> engMakeup -> master`,
with a reverb send tapped **post-level, pre-shelf**.

Layers, all always running and gain-gated: synth tonal body (3 detuned periodic
waves at the crank half-order through a waveshaper), idle wobble LFOs,
intake/exhaust noise beds, rev-limiter stutter, crackle bursts, turbo,
transmission whine, four tyre layers (rolling hum, singing squeal, broadband
screech, brake squeal), wind, road rumble, rain, a 4-delay FDN reverb replaced
by a convolver once the tunnel IR decodes, the sampled engine ladder, recorded
skid, an NPC doppler pool, scrape/grind, interior trim creaks, and sample
one-shots for crash/horn/chirp.

Public API used by the engine: `init()`, `setCar(id)`, `update(...)`,
`crash(intensity)`, `setInterior(bool)`, `setReverb(t)`, `tick()` (blinker
relay click), `stalkClick()`, `tunnelThump()`, `updateNpcs()`, `npcHorn()`,
`npcChirp()`, `setScrape()`, `setLevels()`, `quiesce()`, `dispose()`.

**NPC engine sound is off by explicit user decision** — the doppler drone pool
is disabled outright. `updateNpcs()` still runs for horn/chirp spatialiser
bookkeeping.

#### The engine sound path, and `LOOP_F0`

Four recorded loops are used as a ladder. The critical numbers:

| Constant | Value | Role |
|---|---|---|
| `LOOP_F0` | `[42.9, 60.0, 64.7, 69.9]` | **Measured** firing fundamental (Hz) of each WAV, by autocorrelation. **The only number that has to be right.** |
| `RPM_ANCHORS` | `[1050, 2400, 4200, 6400]` | Which loop is the dominant *timbre* at a given rpm. Purely a crossfade schedule — it no longer touches pitch |
| `RATE_MIN` / `RATE_MAX` | `0.5` / `3.6` | Hard sanity clamp on playback rate. **Not** a taste knob |
| `LADDER_STRETCH` | `2.8` | Where the recordings stop reading as an engine and the synth takes the top end |
| `SYNTH_FLOOR` | `0.2` | How much correctly-pitched synth stays under the recordings at all rpm |
| `ENGINE_TUNE_DEFAULT` | level 1.25, rumble +5 dB @140 Hz, sub 38 Hz, exhaust 1.35, ceiling −5 dB, makeup 1.15 | Loudness/rumble on the shared engine bus; re-read every frame from `window.__audioTune` |

Playback rate derives from the measured fundamentals against the engine's
**true firing frequency**:

```ts
playbackRate[i] = clamp(base2 / LOOP_F0[i], RATE_MIN, RATE_MAX)
// where base2 = rpm * cylinders / 120
```

Before this, the anchors were used as if they were measured engine speeds and
were wrong by roughly a factor of four. The loops span **1.63×** in pitch; the
anchors claimed **6.1×**. The audible result was pitch that rose within a band
and then *fell 38%* every time the crossfade moved to the next loop — six
backward jumps across the rev range — while two loops a musical fifth apart were
being equal-power crossfaded into each other. That is the "muddy beating" and
the missing rev sweep. It now spans 8.71× monotonically with worst crossfade
dissonance 1.06×.

**If you ever replace the loops, re-measure their fundamentals and update
`LOOP_F0`.** Nothing else has to be right.

Assets live in `public/assets/audio/` — 31 files, ~1.3 MB, **all mono WAV by
policy**: Safari cannot decode OGG, and MP3/AAC pad ~40 ms onto one-shot heads
and break loop seams. Every load failure is per-file non-fatal; an incomplete
ladder just stays on the synth.

`music.ts` is a **separate, independent** system with its own AudioContext,
importing nothing from `audio.ts`. It synthesises four public-domain classical
pieces from note data (a few hundred numbers each) rather than streaming MP3s,
explicitly because the size budget is already over. Desktop only — on touch
devices `enabled` is false and no AudioContext is ever created. It is designed
to be read by the dash screen's music panel, though (see §5.8) that wiring is
not finished.

### 5.6 Rendering and the dashcam post-processing

Renderer: `WebGLRenderer({ antialias: false, powerPreference: "high-performance" })`
— MSAA comes from the half-float scene render target instead, and AA from the
FXAA pass. `toneMapping = NoToneMapping` (ACES is done manually in the composite),
and `THREE.ColorManagement.enabled = false` because the v2 art was authored
non-managed.

**Shadows exist only in daylight.** The sun is the one shadow-casting light and
it is gated off below a day factor of 0.22 — so at night, nothing casts a shadow.

`PostFX` in `post.ts` runs, in order:

1. **Bloom** — bright pass with a soft knee into a quarter-res target, separable
   ping-pong blur, plus an optional second eighth-res halo scale on desktop.
2. **Composite** — radial chromatic aberration, exposure, bloom and halo add,
   **fitted ACES (Hill fit** — Narkowicz was tried and hue-shifted the neon),
   manual gamma, film grade with split toning, speed vignette, film grain, lens
   dirt, quartic vignette.
3. **FXAA + adaptive sharpen** — the unsharp mask reuses FXAA's own taps, with
   the darkening side pushed 1.75× as "cheap contact AO without a depth buffer."
4. **Dashcam grade** (the `V` key, see below).
5. **Motion blur / peripheral streak** — history blend plus a 6-tap radial comet
   toward the vanishing point.
6. **POV degrade** (see below) — applied *after* the frame blend, because the
   smear is optical but noise and codec artefacts come later in a real signal
   chain.

#### Two different dashcam effects

They are separate and often confused:

| | `V` key — `grade` | `setDashcamPov` |
|---|---|---|
| Trigger | Player toggle, persisted as `settings.dashcam` | Automatic, whenever `camMode === CAM_POV` |
| Feel | A plastic-lens consumer dashcam | A *cheap sensor* |
| Does | Barrel distortion, rolling-shutter wobble, soft/sharp lens mix, chroma bleed, low-bitrate macroblocking, milky blacks, green CMOS cast, burnt-in DVR timestamp, luma grain | Interlace row tear, half-res grid snap, strong CA, hot smear clipped to flat white, crushed blacks, red/magenta sensor bleed in the corners, sky pulldown, boiling shadow grain, adaptive auto-gain, interlace comb, and a final bit-crush to 19/23/17 levels |

The POV pass also pins the frame blend at 0.66 regardless of the motion-blur
setting, and kills the peripheral streak.

**The POV shield** is why the instruments stay readable: the rear-view mirror
glass and the head-unit screen are projected to screen-space rects each frame,
and the degrade is mixed *back toward the clean full-res frame* inside them
(mirror 85%, screen 92%). With the shield strengths at zero the shaders are
bit-identical to the unshielded arithmetic.

`dashcamHit(severity)` is the impact glitch — frame jumps, row tears, an
exposure flash, a CA spike, a refocus wobble, and a genuinely dropped frame.
Severity is impact speed in m/s, hard-gated below 3.

Both effects are live-tunable from `window.__povTune`, re-read every frame.

#### The night lighting model

There are only **three environment lights** in the whole scene — a hemisphere,
the sun, and an ambient — plus 4 on the player car (two main beams, two lateral
fill cones) and 2–3 interior points. **That's it.** Real per-NPC spotlights are
banned outright, because each one multiplies the lit-shader cost of every
surface it touches.

Everything else that looks like light is faked, and faked deliberately, because
textures and smoothsteps have no cone and no terminator:

- **The headlight "beam carpet" is the real headlight.** It is an additive
  gradient quad parented to the car's yaw (so it belongs to the road, not the
  body), not a light. The 40-line comment explains why: a spotlight
  *geometrically cannot* look like a dipped beam seen from inside the car — pin
  the cut-off below horizontal and a symmetric cone must aim its hot axis at the
  near tarmac. The wedge has three load-bearing properties: zero at the near
  edge, deliberately **flat rather than peaked** (because the POV chain crushes
  everything under 0.06 to black), and a laterally *growing* half-width.
- **Retroreflection** (`mats.setBeam`) is what makes paint blaze inside the beam
  and vanish outside it, shared across every beam material via five shared
  uniform objects so one write updates everything.
- **Streetlight and NPC ground pools** are quads carrying a 15-stop monotone
  gradient with a long low tail. The tail exists because the POV pass crushes
  blacks with `col - .06` — a *linear* outer ramp crosses that floor at a
  definite radius and clips to a circular edge, which is exactly the "looks
  scoped" complaint.
- **NPC bodies are washed** by per-instance linear-RGB radiance attributes
  carrying light from streetlights, the toll canopy, and the player's own beams.

Ambient is shaped rather than lerped (`pow(dayFactor, 0.7)`), so midnight has
essentially no fill and unlit surfaces go to silhouette. The tunnel puts fill
back in proportion to how deep you are.

`mats.ts` patches materials through four chained `onBeforeCompile` families —
reflection/detail-albedo, `addBeam`, `projectedUv` (world-position UVs for the
UV-less triangle soup the highway emits), and `weatherSurface` (procedural
concrete weathering in world space). They are chained, never clobbered, and the
install order is load-bearing.

### 5.7 Settings, tiers, and persistence

`settings.ts` holds three things.

**`GameSettings`** — preset (low/medium/high), reflections, bloom, shadows,
fxaa, mblur, traction control, dashcam, fog level, draw distance (700 m),
units (mph), touch steering mode, traffic density, base FOV (67), volume,
auto time-of-day, tier override.

**The render tier** — `"mobile-base" | "mobile-high" | "desktop"`, resolved from
a deliberately conservative GPU-string sniff (unknown ⇒ `mobile-base`).
Precedence: `?tier=` URL param (test-only, never persisted) > persisted
override > detection. `TIER_CAPS` gates ~30 things — DPR cap, PBR detail,
spread cones, draw-distance scale, mirror resolution, reflections, motion
blur, dual-scale bloom, and a batch of world-dressing caps that grew with the
overhaul (`districts`, `deckDressing`, `mtnDetail`, `wheelTracks`,
`overpassLights`, `cabinPbrMaps`, `hdFleet`, …). DISABLED.md §2 keeps the
full table.

Caps only ever gate *down*: a user setting can turn something off, never on
above its cap. Note that **`dashcam: true` on every tier including mobile** —
that is deliberate; motion blur is the mobile cut instead.

`worldTierCaps()` is a cached module-level duplicate resolution, because the
world builders in `game/world/*` run inside startup and can't reach the `Game`
instance mid-build.

**Persistence** — one `localStorage` key, `"neonx.profile.v3"`, holding
`{ settings, carId, paintIx, seed, camMode, cleanRunBest, stats, ttt }`. `loadProfile()` does real
defensive migration: it rejects non-object JSON, migrates the old numeric fog
multiplier onto named levels, and forces the numeric keys finite (a NaN here
reaches the projection matrix, the audio gain, or the chunk culler) and the
index keys to non-negative integers (their consumers wrap with `%`, which
recovers an overshoot but not a negative).

**How settings reach the engine**: `GameApp` passes the whole `Profile` into the
constructor, and `engine.settings = profile.settings` — **the engine holds the
same object the React panel mutates**. The panel's update helper mutates in
place and calls `game.applySettings(game.settings)`, which is hit on every
slider tick and is written to be cheap and idempotent. Persistence happens on
*navigation*, not on change.

The React ↔ engine boundary has three distinct channels worth knowing:

1. **React → engine**: direct imperative method calls on a ref.
2. **Engine → React**: a four-callback `UiBridge` — `toast`, `exitHint`,
   `pauseRequest`, `helpRequest`. The last two are *requests*, not commands;
   React decides and calls back into `setRunning`.
3. **Engine → DOM, bypassing React entirely**: React renders empty, stably-id'd
   elements (`#spd`, `#gearTxt`, `#clock`, `#wx`, `#mmap`, touch buttons) and
   the engine writes their content every frame. **The per-frame HUD never goes
   through React state.** That is the performance boundary.

`loading.ts` deserves its own note. Its core export, `yieldToPaint()`, exists
because rAF alone is insufficient — rAF callbacks run *before* compositing, so
resuming inside one blocks the very paint you are waiting for. It instead posts
a `MessageChannel` message from *inside* the rAF callback, which lands after
that frame's rendering opportunity. `setTimeout(0)` was rejected (4 ms nested
clamp) and so was `scheduler.yield()` (resumes above rendering priority). There
is a 250 ms timer backstop for backgrounded tabs, which stop firing rAF
entirely. The other half of the contract is CSS: the loading bar uses
`transform: scaleX()` rather than `width` so it keeps travelling on the
compositor while the next stage blocks the main thread outright.

### 5.8 The cockpit and the dash

Two dashboards exist simultaneously, and **which one you sit in is decided by
the car you picked in the garage** — the VOLVO S90 brings the donor cabin, the
KAZE GT is procedural. (It used to be a `J` key A/B, which is retired: see
§ the garage.) On `mobile-base` no donor is fetched for either car, so the
procedural one below is what ships there.

**The procedural interior** (`cockpit.ts`, ~1700 lines) is always built and
always resident: dash shell, binnacle, vents, centre stack, console, door cards,
pillars, headliner, seats, floor and pedals, ambient LED strips, window glass,
steering wheel with moulded hands, mirrors, wipers, and a rain-droplet canvas on
the windshield. Static trim is merged down to about a dozen draw calls — merged
per *(material, region)* rather than per material, so the import can replace the
dash without also owning the door cards and seats.

**The imported donor dash** (`cockpitmodel.ts`) only performs a *swap*. It never
builds geometry. `cockpit.ts` exposes a fixed set of handles — region groups,
cluster group, screen mesh and texture, nav panel, wheel group, mirror glass —
and `cockpitmodel.ts` may only hide regions, reposition those handles, and
rebind the screen texture onto a donor material. `setActive(on)` is a pure
visibility flip, not a teardown, which is what makes the A/B possible. Its
reason for existing, from the header: *"a 68 MB asset that can 404 must never be
able to leave the player without a dashboard."*

**The donor pipeline.** `public/assets-staging/volvo_s90_recharge_free.glb` is
386 MB, 3.27 M triangles, 45 images. `tools/build-cockpit.mjs` is run offline
(no npm script) and knows **two cuts** (its header is the reference):

- **What ships — `volvo-s90-full`** (`--no-clip --full-cabin --simplify`):
  whole NODES only. Every node the widest legal frustum can reach is kept
  entire and decimated with meshoptimizer; nodes no legal frustum can reach
  (rear bench, rear door cards, all bodywork) are dropped whole. Nothing is
  ever sliced, so there is no cut edge to walk past and the FOV slider is
  clean to its maximum. 356,880 tris, 21 images, 5.68 MB on disk.
- **The retired dash — `volvo-s90`** (default flags): a per-vertex frustum
  clip at near-donor resolution. Sharper over the third of the cabin it kept,
  but sliced — past the frame it was clipped for there is simply nothing, so
  the engine had to cap the lens at 88° while it was on screen. Retired for
  exactly that; recoverable per DISABLED.md §11. The clip survives inside the
  tool because it is still how the `mirror` anchor role is frozen.

Both cuts match nodes to **roles** by regex (cluster, screen, wheel, column,
mirror, cabin, shell), bake world matrices and flatten the hierarchy, measure
the steering axis from the rim's vertex cloud by covariance
eigen-decomposition, and write a JSON sidecar of per-role bounding boxes so
cockpit code binds by role, never by donor node names. As of 2026-08-28 all
three tiers fetch the same `volvo-s90-full` cabin (`COCKPIT_MODEL` in
`player.ts` — the rows stay per-tier as the hook for a future `-4k` desktop
variant); `TierCaps.cabinPbrMaps` decides whether its normal/roughness maps
are paid for (mobile-base declines, saving ~184 MB of decoded texture).

**The instrument cluster** (`dashboard.ts`) is a hybrid: flat art on canvas
textures (dial faces painted once, repainted only when rev limit or units
change; a 176×232 info panel that is change-gated so an unchanged tick short-
circuits), real 3D geometry for the needles, and seven boxes for the shift
lights. Driven at ~22 Hz from the engine, and only when the camera is inside.

`FACE_DIM = 0.40` is one believable layer of binnacle cover glass simulated as a
material tint, applied to the needles, faces and info panel together so they dim
in step and keep their hue. Its history is instructive: the donor's real smoked
pane stacked several near-black double-sided layers between the eye and the
gauges and dimmed them ~25×, so it was hidden; bare canvas then overshot the
other way and the numerals bloomed near-white under the dashcam pass; the tint
went back at 0.62; the user read that as still too hot from the dashcam frame,
so it is now 0.40.

**The mirror is a live render target** — one shared 320×128 half-float target,
filled every *other* frame and only in COCKPIT and POV. All three mirror glasses
(centre and both doors) share one material and one texture, each reading a
different horizontal slice via a rewritten UV attribute. Every glass has
`scale.x = -1` because the rear camera looks backward, so its local right is the
driver's left. **Losing that sign silently un-mirrors the reflection.**

**The head unit** (`carscreen.ts`) is a 256×160 split pane: music card left, nav
map right. The nav map now draws the *same* `drawMiniMap` the HUD overlay draws,
zoomed tighter (0.55 vs 0.4 px/m) because the pane is read ~26° off-normal in
the dashcam frame. It bakes at ~11 Hz and blits between bakes, with the player
marker drawn live every repaint so the arrow slides over a held map rather than
the whole pane freezing.

Both maps use a **mirrored-x** transform with heading rotated by `−car.h`. That
was a real bug fix — the two maps previously disagreed about which way a left
turn bends.

**The music card is no longer fake** — closed 2026-08-28. `carscreen.ts` now
takes a `live` music state (`paintMusic`'s own comment: "Without this the card
cheerfully showed 'Midnight Loop / Neon Arcade' while Beethoven was actually
playing") and the fictional `TRACKS` rotation is only the fallback for when no
real player is running (touch devices, where `music.enabled` is false).

**`player.ts` vs `carshape.ts`**: `carshape.ts` is a pure geometry factory (no
materials, no scene, no lights) that extrudes three side profiles into a hull,
greenhouse and roof cap, then adds panel lines, door furniture, grille and
brake discs — each returned as *one merged geometry* so a whole class of detail
is one draw call. A wheel is a single merged geometry with one group per
material: 3 draws instead of 12 meshes. `player.ts` does assembly: clearcoat
paint materials, lamp emissives, glow sprites, the three tiers of headlight
(narrow main beams, wide short-throw fill cones, and the carpet decal), and the
cockpit attach.

Wipers are in `cockpit.ts`, not `player.ts`.

---

## 6. Landmines

The things that will bite you. Roughly in order of blast radius.

### 1. The seeded RNG ordering

One shared `mulberry32` stream threaded terrain → road net → highway → town.
Inserting or removing **a single draw** anywhere changes every downstream
consumer, and because several draws gate control flow, the divergence is chaotic
rather than an off-by-one. `buildHighway` currently accepts `rng` and never uses
it — the first draw added there re-rolls every seed's town. Add randomness in
`decals.ts`-style private streams, or in `sky.ts`'s unseeded cosmetic path, not
on the shared stream. §5.2.

### 2. `car.rpm` vs `car.rpmDrive`

`rpmDrive` is kinematic and feeds the torque path, the limiter and the shift
map; `rpm` is the modelled flywheel and feeds the tach and the audio. Collapsing
them — or "simplifying" `stepEngineSpeed` to write into the torque path — would
silently retune every car's acceleration. **Read `docs/engine-sound-rpm.md`
first.** Guarded by `npm run engine-rpm`. §5.3.

### 3. `LOOP_F0` in `audio.ts`

Pitch derives from these four *measured* sample fundamentals against the true
firing frequency — **not** from `RPM_ANCHORS`, which now only schedules timbre.
Confusing the two is exactly the bug that made the engine's pitch run backwards
across every crossfade. If you replace the recordings, re-measure and update
`LOOP_F0`. §5.5.

### 4. The furniture lattice must divide `LOOP_LEN`

Every pitch for lamp posts, gantries, signs and decals must divide 4000, and
every generator must place on the global lattice rather than counting from the
built extent — otherwise the wrap teleport becomes visible as a jump in the
lamp-post rhythm. `assertPitches()` throws if you break it. §5.2.

### 5. The asset size budget

`node test/size-budget.mjs` passes today (12.78 / 15 MB critical, 14.86 / 30 MB
total as of 2026-08-29) — but the margin is finite and the reason it passes is
that heavy assets kept getting retired or rebaked. Assets deploy from git, so
anything you commit into `public/` ships to every visitor, and binaries do not
delta — each rebuild of a model adds a permanent full copy to history. Check
the budget before committing a new asset. §3.

### 6. Real per-NPC lights are banned

Each spotlight multiplies the lit-shader cost of every surface it touches. The
player's headlights are the entire dynamic-light budget. NPC illumination is
instanced quads and per-instance wash attributes. §5.6.

### 7. Light falloff is post-processing, not falloff

A hard edge on a light pool is almost never the light's falloff — it is the POV
composite's blown-highlight clip (`smoothstep(.72, 1.02, luma)`) or its black
crush (`col - .06`). **Brightening does not fix it; it grows the hard edge.**
The rule holds for every light in the game: how a beam lands on a surface, and
how a light pool fades, are decided in the post chain, not by the light.

### 8. `LANE_FOLLOW_RATE` is coupled to corridor geometry

`corridor.ts` sizes every lane taper's steepness so a car tracking at
`traffic.ts`'s `LANE_FOLLOW_RATE = 3.4` m/s never falls behind the pavement.
Change one, change the other.

### 9. `traffic.ts` lamp-wash tables must stay in lockstep with `highway.ts`

The tables replicate the streetlight placement rules — tunnel and toll skips,
gore gaps, tier thinning. Drift means cars washing under lamps that do not
render.

### 10. Chain `onBeforeCompile`, never clobber it

`mats.ts` composes four shader-patch families and the install order matters
(`projectedUv` must come after the PBR upgrade because it replaces the hook).
Three keys its program cache on the hook's `toString()`, which is also why
per-style shader variants are banned in `traffic.ts` — the paint reference rides
in as a *uniform* to keep one compiled program for the whole fleet.

### 11. `dashboard.ts`'s `drawInfo` change-gate

The info panel short-circuits when nothing changed, comparing a fixed list of
fields. **Anything new added to `drawInfo` must be added to that list too, or it
will never repaint.**

### 12. Don't clamp `car.z`

The corridor's loop splice folds z back into its band every frame. A clamp in
`physics.ts` would pin the car short of the splice threshold.
`test/corridor-drive.mjs` asserts the absence of one.

### 13. `quiesce()` invalidates caller-side caches

If you cache anything it touches, invalidate on unpause — otherwise a resume
comes back silent or dry and stays that way until the driving value happens to
change on its own. `engine.ts` resets `lastReverb = -1` for exactly this reason.

---

## 7. Where to look for what

| I want to change… | Go to |
|---|---|
| How the car drives — grip, weight transfer, ABS, ESC, steering | `game/physics.ts`, `stepPhysics` |
| A specific car's speed, gearing, or handling | `game/carspecs.ts` — `RATIOS`, `TQ_R`/`TQ_T`, `gripF`/`gripR`, `revLimit` |
| A car's *shape* | `game/carspecs.ts` `ShellParams`, rendered by `game/carshape.ts` |
| How the engine *sounds* like it revs | `game/physics.ts` `stepEngineSpeed()` — and read `docs/engine-sound-rpm.md` |
| Engine loudness, rumble, exhaust | `ENGINE_TUNE_DEFAULT` in `audio.ts`, or live via `window.__audioTune` |
| Any other sound (tyres, wind, rain, crash, horn, creak) | `game/audio.ts` — find its layer's `*G` gain node in `init()`, its drive in `update()` |
| Music on the dash screen | `game/music.ts` (the player) — but the panel still draws `carscreen.ts`'s fake tracklist |
| Traffic density, aggression, lane-change behaviour | `game/traffic.ts` — `ARCH` archetypes, the IDM constants, `rollDriver` |
| Whether NPCs get out of your way | `game/traffic.ts` — the `HAIL` block and `hailGesture`/`hailRoll`/`yieldLane` |
| What NPC cars look like | `game/npcmodels.ts` + `PAINT_TINT` in `traffic.ts`; rebake with `tools/build-orchids-models.mjs` |
| The shape of the expressway — bends, grades, lane counts | `game/world/corridor.ts` — `X_BENDS`, `Y_BENDS`, the lane schedule |
| The tunnel, toll plaza, bridge, gantries, barriers, signs | `game/world/highway.ts` |
| The on/off ramps (and the player spawn) | `game/world/ramps.ts` — `RAMP_PLAN` |
| The bypass viaduct | `game/world/routegraph.ts` |
| The town — streets, buildings, neon, streetlights | `game/world/townmesh.ts` (meshes) and `game/world/roadnet.ts` (the graph) |
| Terrain shape | `game/world/terrain.ts` — `makeTerrain` |
| Road surface, concrete, any world material | `game/world/mats.ts` — `buildMats` |
| Road cracks, oil stains, manholes, tunnel streaks | `game/world/decals.ts` |
| Sky, stars, moon, distant city, landmarks | `game/world/sky.ts` |
| Headlights — throw, brightness, colour, the beam carpet | `HL_*` constants in `engine.ts`, the rig in `player.ts`, driven in `engine.weather()` |
| Streetlight pools, lamp wash | `world/decaltex.ts` (the gradient), `world/highway.ts` (placement), `engine.ts` (day/night opacity) |
| Bloom, tone mapping, film grade, motion blur | `game/post.ts` — `compMat` and `process()` |
| The dashcam look | `game/post.ts` — `dashMat` (V key) and `povMat` (automatic in POV); live-tune via `window.__povTune` |
| Fog, time of day, rain, auto-headlights | `game/engine.ts` — `weather()` |
| The interior — trim, seats, wheel, pillars, wipers | `game/cockpit.ts` |
| The imported dash's position and fitting | `game/cockpitmodel.ts`; rebake with `tools/build-cockpit.mjs` |
| Speedo, tach, shift lights, warning tell-tales | `game/dashboard.ts` |
| The head-unit screen | `game/carscreen.ts` |
| The map (both the HUD one and the in-dash one) | `game/minimap.ts` — `drawMiniMap`, differentiated by `MiniMapOpts` |
| The HUD text (speed, gear, clock, weather icon) | `game/engine.ts` — `hud()`, writing to ids rendered by `GameApp.tsx` |
| Menus, garage, settings panel, mobile controls | `components/GameApp.tsx` |
| A new setting | `game/settings.ts` (`GameSettings` + `defaultSettings`), then the panel in `GameApp.tsx`, then `Game.applySettings` |
| Mobile/low-end behaviour | `TIER_CAPS` in `game/settings.ts` |
| The loading screen | `game/loading.ts` (the mechanism), `buildStages()` in `engine.ts` (the stages), `app/globals.css` (the CSS, which must animate on the compositor) |
| Keybinds | `game/engine.ts` — `onKeyDown`/`onKeyUp`/`readInput`; touch buttons in `bindInput` |
| Camera placement and FOV | `game/engine.ts` — `POV_MOUNT`, `POV_TILT`, `povFov()`/`lensFov()`, `CONSOLE_CAM`, and `updateCamera()` |
| The roadside districts | `game/world/scenery.ts` — both passes, gated by `FX_DISTRICTS` and `TierCaps.districts` |
| The mountain road (EXIT 4) | `corridor.MTN` (spec), `routegraph.ts` (the edge), `highway.ts` (meshes), `traffic.ts` (oncoming flow) |
| The rival, near-miss streak | `game/traffic.ts` ("the rival" / `scoreEvents`), `COMBO` + `comboUpdate` in `engine.ts` |
| The clean-run score | `CLEAN_RUN` + `runUpdate` in `engine.ts`, `normalImpact` in `game/collide.ts`, `#hud .runDist` in `app/globals.css` |

---

## 8. In flight at the time of writing (2026-08-21 — historical)

*2026-08-29 note: everything in this table landed long ago, and the music-card
row is obsolete — the dash panel now reads the live player (§5.8). The table
is kept as a record of what was moving while the document was researched.*

The body of this document was researched against `2b6e472` and describes what
was **committed and stable** there. The tree was under heavy parallel edit
throughout, and three sweeps (`4891fdf`, `00878f9`, `51acadd`) landed while it
was being written — so treat these specific areas as possibly ahead of the text above:

| Area | State |
|---|---|
| **Loading screen** | **Committed** (`4891fdf`). Described above |
| **Music player** | **Committed** (`4891fdf`), engine wiring landed — but the dash-screen panel that reads it does **not** exist yet. The music card still shows a fake tracklist |
| **In-dash map** | **Committed** (`4891fdf`) — the nav pane now shares `drawMiniMap` with the HUD. Described above |
| **Traffic courtesy / yielding** | **Committed** (`2932e18`). Described in full above |
| **Zipper merges through lane shrinks** | **Committed** (`d55c8cf`). Only lightly covered above |
| **Asset diet** | **Committed** (`00878f9`, `51acadd`) — PBR scans, HDRIs, decals and lens dirt shrunk; `ao.jpg` maps deleted. This is why §3's budget numbers moved three times |
| **Gamepad support** | `game/gamepad.ts` — landed in `00878f9`/`51acadd` **after** the research pass, so it is *not* described above. Analog triggers bypass the keyboard input ramp (a trigger is already a pedal); the stick deliberately does **not** bypass the steering ramp, because that ramp exists to stop the front axle snapping to full lock in one frame at 40 m/s |
| **Mobile input, world-static rain, settings persistence** | Landed in `51acadd`, after the research pass. Not described above |
| **Tunnel / bridge / barrier work** | Bridge and barrier materials landed in `4891fdf`; further corridor/highway/mats/routegraph work landed in the later sweeps |
| **`tools/shrink-hdri.mjs`** | Now committed — downsamples Radiance HDRs, since three prefilters the env cube at `width / 4` and everything above 2048 wide is decoded and thrown away |

Also note the commit message on `4891fdf`, which covers the loading screen, dash
screen, bridge, barriers, music and FX pass:

> Everything here compiles (tsc clean) and `npm run engine-rpm` passes, but
> **almost none of it has been seen or heard by a human yet, so treat the visual
> and audio work as unverified.**

---

## 9. Things I could not verify, and known-stale docs

Written down honestly, because a documented unknown beats a confident wrong
statement.

- **`game/world/ROUTEGRAPH-INTEGRATION.md` reads as a to-do list, but most of it
  has landed.** Its "world build", terrain, and bypass-viaduct tasks are all done
  in the tree. Whether its traffic, collide and minimap sections are fully
  implemented was not audited. Do not use it as current documentation.
- ~~**`README.md`'s controls table is out of date**~~ — resolved 2026-08-29:
  the README was rewritten and agrees with §5.1.
- **`tools/build-npc-models.mjs` is a superseded baker.** It targets a different
  (rgsdev CC0) asset pack and defines a `kei` style that is not in the roster.
  The shipping fleet was baked by `tools/build-orchids-models.mjs`. Per
  `ATTRIBUTIONS.md`, none of the older tool's output remains in the shipped
  assets.
- **A stale comment in `traffic.ts`** claims `closeCalls()` never reports while
  `CLOSE_CALL_AUDIO` is false. That is no longer true — the courtesy system's
  annoyed horn-back sets the close-call kind without checking that flag, and the
  engine consumes it unconditionally. The horn-back *is* audible. The newer
  `HAIL` comment says this is intentional; the older one is simply out of date.
- **The NPC emissive lamp path is live now** (was inert when written): the
  2026-08-28 fleet bakes tag real lens geometry (`hasLampGeo` in
  `npcmodels.ts` / `traffic.ts`), and up close the shaped emissive lenses
  carry the light while the round glow sprites retire (`084dbc4`).
- **Road screen-space reflections are no longer hard-disabled** — the old
  `const str = 0` was replaced by a bright-pass-sourced reflection
  (`REF_GAIN` in `mats.ts`; DISABLED.md §3c has the story). The `reflections`
  setting gates it along with the planar RT.
- **Number discrepancies in `player.ts` prose** may persist; the shipped
  cabin is `volvo-s90-full.glb` at 5.68 MB and the build tool's header now
  carries the measured numbers for both cuts. Treat older prose figures as
  approximate.
- **Size-budget figures are a snapshot.** §3's numbers were verified by running
  the script, but an asset-compression pass was mid-flight. Re-run it.
- **The Vercel project is named `wangan`**, not `floored`. Worth knowing;
  I did not investigate why.
- ~~**`fenceOverdraw`** exists in `TIER_CAPS` with no consumer found~~ — it
  has one now (`highway.ts` ~1263: mobile-base falls back to slab walls); only
  the `settings.ts` comment still says "no consumer yet".
- **Nothing in this document has been visually verified.** I read code; I did not
  run the game. Where a comment explains why something looks the way it does, I
  have relayed the comment's reasoning, not confirmed the result on screen.
