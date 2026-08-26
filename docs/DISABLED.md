# Disabled, capped and hidden — but still in the codebase

A register of everything that is **present in the repo but not running**: settings
defaulted off, constants set to a disabling value, content locked out of the UI,
geometry hidden rather than deleted, assets retired but recoverable, and debug
hatches that exist but are undocumented.

The question this document is written to answer is **"why is X not happening?"**
Each entry gives what it is, where it lives, the exact mechanism, why it was
turned off, and a concrete re-enable instruction.

Two things this document is *not*: it is not a changelog (git has that), and it
is not a wishlist. If something is genuinely gone, it is only here when a copy
still exists somewhere recoverable.

Written 2026-08-26 against `main` @ `31d623e`. Line numbers drift — the
constant names and comment quotes are the durable handles.

---

## 1. Settings defaulted off

`game/settings.ts` `defaultSettings()` (line 252) is the first-run profile.
An **existing** profile in `localStorage` under `neonx.profile.v3` keeps whatever
it last held, so changing a default here only affects new players — with the one
exception noted in the migration row.

| Setting | Line | Default | Why |
|---|---|---|---|
| `mblur` | 262 | `false` | Chase-cam motion blur. *"reported as unwanted smear at speed rather than read as a camera effect. Still a setting, so it can be turned back on; only the default moved."* |
| `dashcam` | 264 | `false` | The V-key degrade grade. Off as a *global* filter; the DASHCAM POV forces its own, harder chain regardless (see §6). |
| `rain` | 269 | `false` | Wet road + rain particles. R toggles. |
| `rival` | 281 | `false` | The rival pace car in `game/traffic.ts`. *"A mode, not a difficulty: off until it is switched on... Off costs one boolean test per frame — no pool slot is reserved and no controller runs."* |
| `rivalSignals` | 282 | `false` | Whether the rival indicates its lane changes. *"a car that cuts through traffic and still signals is a contradiction, and the ABSENCE of a blinker is characterisation the player reads immediately."* Only shown in the panel while `rival` is on. |
| `testMode` | 283 | `false` | See §7. |
| `tierOverride` | 277 | `"auto"` | Manual render-tier pin, deferring to device detection. |

**Re-enable:** tick the box in the pause → Settings panel (`components/GameApp.tsx`
~line 594 onward), or press the in-game key (V / R / K / X). To change the
*shipped* default, edit the value in `defaultSettings()` — existing players are
unaffected unless you also write a migration like the one below.

### 1a. The one-time `mblur` scrub (a migration, not a default)

`game/settings.ts:372-376`, in `loadProfile()`. Under key
`neonx.profile.v3.mbcleared`, an existing profile's `mblur:true` is forced to
`false` **exactly once**, then never touched again.

> *"Runs exactly once, under its own key, and then never touches the value again:
> after this the setting belongs to the user, and someone who turns motion blur
> back on must have it stay on. A plain `settings.mblur = false` here would be a
> setting that cannot be changed."*

**To undo for testing:** `localStorage.removeItem("neonx.profile.v3.mbcleared")`
and reload. Deleting the block from the source would leave already-migrated
profiles as they are.

---

## 2. Per-tier caps — capability hidden by hardware class

`game/settings.ts` `TIER_CAPS` (line 78). A cap **never adds** a feature; it only
gates one further down. The effective state is `userSetting && tierCap`.

| Cap | mobile-base | mobile-high | desktop | What is lost when off |
|---|---|---|---|---|
| `reflections` | ✗ | ✗ | ✓ | Planar road-reflection RT is not rendered into at all |
| `mblur` | ✗ | ✗ | ✓ | Frame-blend motion blur — **and the dashcam exposure blend, see §6** |
| `pbrDetail` | ✗ | ✓ | ✓ | Scanned-road PBR detail layers + their deferred fetch |
| `spreadCones` | ✗ | ✓ | ✓ | Headlight lateral fill cones |
| `fenceOverdraw` | ✗ | ✓ | ✓ | Perforated-steel sound barriers → translucent slab wall fallback |
| `mirrorHalf` | ✓ | ✓ | ✗ | Mirror RT at 160×64 instead of 320×128 |
| `dualBloom` | ✗ | ✗ | ✓ | Two-scale bloom; off ⇒ original single-chain, bit-identical |
| `filmLook` | ✗ | ✗ | ✓ | Extra vignette / edge CA / lens dirt (grain + tone now run everywhere) |
| `lampCones` | ✗ | ✓ | ✓ | Fake volumetric cones under streetlight heads |
| `catwalks` | ✗ | ✓ | ✓ | Gantry catwalk decking + floodlight fittings |
| `jetFans` | ✗ | ✓ | ✓ | Tunnel-crown jet fans |
| `propModels` | ✗ | ✓ | ✓ | Photoscan GLB props → procedural stand-ins (colliders identical) |
| `roadDecals` | ✗ | ✓ | ✓ | Cracks, oil, covers, wall streaks |
| `cityRings` | 2 | 3 | 3 | Distant-city point-cloud depth stack |
| `lampConeEvery` | 2 | 2 | 1 | Cone under every Nth lamp |
| `lampPoolEvery` | 2 | 1 | 1 | Sodium ground pool under every Nth lamp |
| `dprCap` | 1.1 | 1.35 | 1.75 | Renderer pixel-ratio ceiling |
| `drawDistScale` | 0.65 | 0.85 | 1.0 | Multiplier on `settings.drawDist` for town chunk culling |

`dashcam` is `true` on **every** tier — deliberately: *"the POV filter is core to
the game's look (user call); mblur (chase-cam motion blur) remains the perf cut."*
`bloom` is deliberately absent from the table and stays on everywhere.

**Re-enable / test another tier without a rebuild:** append `?tier=mobile-base`
(or `mobile-high` / `desktop`) to the URL. The param is read-only and never
persisted, so *"a test link can't quietly rewrite someone's saved profile."*
Or set the tier override dropdown in the settings panel, which does persist.

`perfMode` still layers on top of all of this — it reacts to frame times and can
degrade any tier further; nothing in the cap table disables it.

---

## 3. Feature flags set to a disabling value

### 3a. `CHASE_SHAKE = 0` — chase-camera sensation, gated to nothing

`game/engine.ts:360`. One multiplier gating **three** effects together:
head-spring bob, the G-lean roll, and the speed FOV kick.

> *"Reported as unwanted wobble in third person, so it ships at 0."*

Applied at `engine.ts:3185` (`camMode === CAM_CHASE ? this.chaseShake() : 1`) and
in the FOV kick at 3203.

**Re-enable:** live, `window.__chaseShake = 1`, no reload — `chaseShake()`
(engine.ts:546) seeds the window value from the constant on first read and then
reads the window value every frame. To ship it, change the constant.
Per AGENTS.md this only affects a debug camera, so it barely matters either way.

### 3b. `TOWN_TRAFFIC = false` — the entire town driving model, parked

`game/traffic.ts:87`.

> *"Town/side-street traffic is parked for now at the user's request: the whole
> budget goes to the expressway. The town driving model below is intact — flip
> this back to true to bring it back."*

The model behind it (junction yielding, blinkers, curvature-aware speeds — see
the note at `traffic.ts:30`) is complete and compiled; only the spawn target is
zeroed, at `traffic.ts:3319` (`const townTarget = TOWN_TRAFFIC ? … : …`).

**Re-enable:** set to `true` and rebuild. Expect a real frame-rate cost — this is
the largest single disabled feature in the repo.

### 3c. Road SSR — forced to zero regardless of the settings toggle

`game/world/mats.ts:1139-1147`, inside `setWet()`. `const str = 0;` with
`void reflectionsOn;` swallowing the parameter.

> *"Road SSR is disabled outright (str 0 regardless of the settings toggle):
> even luminance-gated, the mirrored skyline painted white patches across the
> road that no tuning pass killed — the user chose to drop the effect. The
> shader path and wet/rough plumbing stay; restore by reverting to
> `reflectionsOn ? d.refStr * (on ? 2.6 : 1) : 0` if a future reflection source
> is better behaved."*

**Re-enable:** exactly the line the comment gives. Note the **Reflections**
checkbox in the settings panel currently controls only the planar reflection RT,
not this — so the box is partially inert on the road surface.

### 3d. NPC engine voices — the doppler drone pool, disabled outright

`game/audio.ts:619`, `private static readonly NPC_VOICES_ENABLED = false;`
Consumed at `audio.ts:2869`.

> *"User decision (2026-08-17): NPC traffic makes NO engine/proximity sound at
> all — the doppler drone pool is disabled outright. `updateNpcs()` still runs so
> its bookkeeping (player pose for the horn/chirp spatializer) stays fresh, but
> every voice is released and no per-car sound is emitted. Event one-shots
> (npcHorn/npcChirp) are unaffected."*

**Re-enable:** flip the constant to `true`. The 8-voice pool (`NPC_POOL`) and all
its wiring are intact.

### 3e. FDN reverb — superseded, parked at zero

`game/audio.ts`, `wireConvolver()` (line 1292) and `setReverb()` (line 2743).
Once the recorded underpass impulse response decodes, the convolver becomes the
only reverb voice and the feedback-delay-network reverb is killed
(*"the FDN stays parked at zero (wireConvolver() killed it)"*). The FDN code path
remains and is still the live fallback if `ir` fails to decode.

**Not a bug** — this is a graceful supersede, and the fallback is load-bearing.

### 3f. Synth engine voice — intact, but not the default

`game/audio.ts:587`, `private engineMode: EngineMode = "sampled";`

The synthesized engine model *"stays fully intact for A/B"*. One-shots
(crash, horns) are sample-first with synth fallback regardless of mode.

**Switch live:** `__audioDebug.setEngineMode("synth")` — `update()` crossfades on
its normal smoothing constants, so it is a quick fade, not a click.

### 3g. `FX_*` master kill-switches — all currently ON

Listed for completeness because they are the master switches the tier caps gate
*under*, and someone chasing a missing effect will land here:

| Flag | File | State |
|---|---|---|
| `FX_AURORA` | `game/world/aurora.ts:46` | `true` |
| `FX_CITY_LAYERS` | `game/world/sky.ts:18` | `true` |
| `FX_NIGHT_CLOUDS` | `game/world/nightclouds.ts:39` | `true` |
| `FX_LAMP_CONES`, `FX_JET_FANS`, `FX_FENCE_PANELS`, `FX_CATWALKS`, `FX_PROP_MODELS`, `FX_TOLL_GLOW`, `FX_ROAD_DECALS`, `FX_LAMP_POOLS` | `game/world/highway.ts:49-66` | all `true` |
| `DUAL_BLOOM`, `FILM_GRAIN`, `FILM_VIGNETTE`, `FILM_CA`, `FILM_TONE`, `FILM_DIRT` | `game/post.ts:135-147` | all `true` |

A feature builds only when its `FX_*` flag **and** its `TierCaps` field agree. So
if an effect is missing on your machine, check the tier first — the flag is
probably not the reason. `FILM_GRAIN` and `FILM_TONE` are the exception to the
`filmLook` cap: *"they cost nothing but ALU and were making the mobile frame
worse rather than cheaper, so they now run on every tier."*

---

## 4. Content locked out of the UI

### Three of the four cars

`game/carspecs.ts`, `comingSoon: true` at lines 226 (SHIRAYUKI), 247 (TANUKI KEI),
268 (OKAMI TOURER). **KAZE GT is the only playable car.**

Everything else about them is whole — shell params, physics spec, torque curves,
stat bars, cockpit accent colour. The lock is one line and three consequences:

| Layer | File | Behaviour |
|---|---|---|
| Roster filter | `carspecs.ts:291` | `PLAYABLE_CARS` excludes them; `DEFAULT_CAR_ID` derives from it |
| Engine lookup | `carspecs.ts:321` `getCar()` | *"A locked id falls back exactly like an unknown one"* → KAZE |
| Raw lookup | `carspecs.ts:304` `carById()` | **Ignores** the lock, so the garage card draws the car as itself |
| Profile scrub | `settings.ts:394` `loadProfile()` | A stored `carId:"tanuki"` is rewritten to `DEFAULT_CAR_ID` on load, so the next save doesn't carry it forward |
| Garage card | `GameApp.tsx:474-482` | Renders dimmed with a COMING SOON badge; `onClick` is dropped, `aria-disabled` set. Stat bars stay (greyed) *"because they are what the card is teasing, and because a card without them would sit at a different height and break the grid row it shares with KAZE"* |

> *"putting a car back on the roster is deleting this one line."*

**Re-enable:** delete `comingSoon: true` from the spec. Nothing else needs to
change — the guard is derived, not hardcoded. Be aware the physics numbers have
not been driven since the lock went on, and the `dashImported` J-key donor
interior is fitted to KAZE's proportions (the cabin is x-scaled per car, and
`player.ts:743` flags that *"a real dash is not a stretchable object"*).

---

## 5. Geometry present but hidden at runtime

All of this lives in `game/cockpitmodel.ts` and is hidden **deliberately**, with
the donor GLB still fully in the scene graph. Nothing here is disposed — the
J key A/B is a visibility flip, not a teardown.

| What is hidden | Where | Why (from the code) |
|---|---|---|
| The donor's **painted cluster** | `wire()`, line 182 — `cluster.visible = false` | *"Its cluster is a painted-on picture of gauges, so it goes: ours is live and has real needles."* Our `clusterGroup` relocates onto the donor binnacle's measured centre |
| The donor's **cluster cover glass** | line 188 — `for (const g of byRole("clusterGlass")) g.visible = false` | *"a near-black blended shell (baseColor ~0.007, alpha ~0.68, double-sided) sitting between the eye and our relocated gauges, and the scan is dense enough that a POV ray crosses it several times — each layer multiplies through, dimming the cluster roughly 25×"* |
| The donor's **rear-view mirror body** — **in the DASHCAM only** | `placeMirror()`, `p.visible = cabin` (line ~505) | Two reasons. Read: *"from 12 cm in front of a 105-degree dashcam lens it fills a chunk of the frame as an unlit plastic lump behind the mirror — the reported 'plastic mirror holder, it's glitched'."* Geometric: *"it was modelled around ITS OWN glass, and ours is a different size and gets rescaled to fit the aperture."* **Neither reason survives the move to CAM_COCKPIT, which is why that view shows it.** The parts stay in the graph either way *"because the bbox above is what positions the glass — deleting them would take the anchor with them"* |
| The **procedural steering rim + moulded hands** | line 417 — `for (const c of proceduralWheel) c.visible = false` | *"the donor's own rim replaces ours; the moulded hands go with it."* `wheelGroup` (the engine's steering handle) is re-parented onto the donor's measured column axis rather than hidden, so steering keeps working in both states |
| The **procedural window panes** | `setActive()`, line 467 — `for (const w of cockpit.windowGlass) w.visible = !on` | *"They are hand-placed against ITS openings and live outside every merge region, so nothing else here hides them — under a donor they float as pale squares in the middle of that car's glazing. The donor brings its own."* (added in `7439226`) |
| The **procedural head-unit tablet** | `setActive()`, line 462 — `cockpit.screenMesh.visible = !on` | The nav canvas is re-projected onto the donor's own centre screen mesh, which is handed to `post.ts` as a shielded panel |
| Whichever **procedural merge regions** the donor supplies | `setActive()`, line 458-461 | `supplies` is derived from what the donor actually brought, per region — *"a dashboard-only donor has no 'cabin' parts, and hiding our pillars for it would open the cabin to the sky"* |

Always **KEPT**, never hidden: *"seats, glass, mirrors, wipers, the droplet
overlay and both light rigs"* — the light strips and window glass in particular
*"are lighting features tuned against the night pass, and a donor's equivalents
are inert geometry."*

**To see the procedural cabin instead:** press **J** in game. It flips
`dashImported` and calls `setActive(false)`, which restores every one of the
above. It also swaps the exterior body, off the same flag — *"they are two cuts
of the same donor and a car wearing one of them is a car nobody asked for."*

**Not currently reachable at all:** on `mobile-base`, `COCKPIT_MODEL` is `""`
(`game/player.ts:43`), so no donor is fetched and J reports "NO IMPORTED CAR".
*"The procedural dash is not a placeholder for those players — it is the shipped one."*

---

## 6. The dashcam exposure blend — off by default as of this batch

Worth its own entry because it is the most recent behavioural removal and the
one most likely to be asked about.

The DASHCAM POV's 40 ms frame blend (`POV_MB_TAU`, `game/post.ts`) used to be
forced on with `|| pov`, ignoring the Motion blur setting. Commit `5c6cadd`
removed that force (`post.ts:1134-1143`):

> *"That reasoning is defensible but it made the Motion blur checkbox a lie in the
> one view the game is actually played in: turning it off changed the chase camera
> and nothing else, so a player who did not want smear had no way to say so.
> Reported twice. … The 40 ms exposure (POV_MB_TAU) is still the default and still
> what the night look was authored around — this only means it can be switched off."*

Combined with `mblur` defaulting to `false` (§1) and the one-time scrub (§1a),
the net effect **today** is that the long-exposure night smear the POV look was
authored around is **not running for anyone** unless they tick the box.

**Re-enable:** Settings → Motion blur. `POV_MB_TAU` itself is untouched.

⚠️ **On mobile, ticking the box does nothing in POV.** `engine.ts:3488` gates on
`this.settings.mblur && this.tierCaps.mblur`, and `tierCaps.mblur` is `false` on
both mobile tiers — so `opts.mblur` is always 0 there, `doFinal` is false in POV,
and the blend pass never runs. See §9.

---

## 7. Test mode — an alternate physics set, off unless toggled

`game/carspecs.ts:100` `testDriveSpec(spec)`, gated by `settings.testMode`
(default `false`) and toggled by **K** or the settings-panel row.

Derived from whichever car is active rather than written out as a fifth spec,
*"so it works for all four and cannot drift out of sync when someone retunes one
of them."* `Game.testMode` is a *view* onto `settings.testMode`, so K and the
panel can never disagree; the derived spec is memoised against the source spec
object, not the flag, so changing car in the garage while test mode is on
recomputes correctly.

The second, deliberately arcade pass:

| Parameter | Multiplier | Reason (abridged from the code) |
|---|---|---|
| `gripF` / `gripR` | ×2.8 | Multiplies Pacejka's **D**, so the ceiling rises without moving the slip angle the peak arrives at — *"the car takes far more and still lets go at the same stick position rather than turning to ice at the limit"* |
| `TQ_T` | ×3.2 | Torque alone would just spin the tyres |
| `FINAL` | ×0.72 | *"what turns it into speed rather than noise"* |
| `drag` | ×0.6 | Lifts the top end the shorter final would cost |
| `brakeF` | ×4 | *"not optional at this grip… the car would corner like an F1 car and stop like a saloon, which is the worst of both"* |
| `HCG` | ×0.55 | Load transfer is `M·ax·HCG/LWB` — halving CG height halves rear unloading under braking. *"every stock car spun at 50% brake in a 120 km/h corner, and raising grip alone did not help"* |
| `steerMax` / `steerHi` | ×1.25 / ×1.4 | Much less than the grip on purpose — *"matching it to the grip multiplier would make half lock at speed an instant spin"* |
| `steerAy` | **unchanged** | The schedule is `ay·L/u²`, so it opens UP as speed falls; boosting it made braking into a corner feed ever more lock and the yaw rate ran away — *"0.50 to 1.76 rad/s in the trace"* |

Deliberately **untouched**: `revLimit` and `RATIOS`. *"revLimit is duplicated in
the audio engine profile and cached by the tacho face in dashboard.ts, and
neither should have to follow a dev toggle."*

**Re-enable:** press **K** (a toast is the only in-car feedback), or tick the row
in the settings panel. It persists across reloads like any other setting.

---

## 8. Debug-only cameras and single-key toggles

### Cameras

AGENTS.md is explicit: **`CAM_POV` (DASHCAM) is the only view that ships.**
Constants at `game/engine.ts:230`; the C key cycles them.

| Index | Name | Status |
|---|---|---|
| 0 | CHASE | Debug. Its sensation effects are gated to 0 (§3a) |
| 1 | COCKPIT | Debug. Carries its own eye offset `COCKPIT_EYE_IMPORTED` (engine.ts:356) and its own mirror framing (donor housing shown) |
| 2 | HOOD | Debug |
| 3 | **DASHCAM** — `CAM_POV` | **The shipping view.** `defaultProfile().camMode = 3` (settings.ts:297) |
| 4 | CONSOLE — `CAM_CONSOLE` | **EXPERIMENTAL.** A wide lens on the tunnel between the seats. `CONSOLE_CAM` at engine.ts:401 |

The cycle order is **not** numeric order (`CAM_CYCLE`, engine.ts:246). The
dashcam must stay last in the cycle, but `camMode` is *persisted*, so renumbering
*"would boot every existing player into whatever took index 3"* — hence
CAM_CONSOLE taking the free index at the end while the cycle walks a table.

CAM_CONSOLE has its own FOV (78° vertical, ~110° horizontal at 16:9 — the widest
lens in the car) rather than inheriting the slider, *"because this camera exists
to be experimented with, not to inherit the shipping view's constraints."*

`defaultProfile().camMode = 3` was itself a fix: it *"defaulted to chase, which
meant every new visitor landed in third person and never saw the interior at all."*

### Keys

Canonical list, `game/engine.ts` `onKeyDown` (line 1324) — mirrored in the in-game
CONTROLS screen at `components/GameApp.tsx:294-312`.

| Key | Action | Note |
|---|---|---|
| W / S | throttle · brake & reverse | |
| A / D | steer | |
| Space | handbrake | |
| **C** | cycle camera | chase → cockpit → hood → console → dashcam |
| **B** | look back | chase & cockpit only |
| Q / E | turn signals | |
| F | horn | traffic speeds up |
| L | headlights on / auto | |
| G | high beams | tap = flash-to-pass, hold 2 s (`HI_HOLD`) = latch |
| **M** | cockpit mirrors on/off | |
| **R** | rain | writes `settings.rain` |
| **T** | time-lapse | cycles ×0 → ×150 → ×1500 |
| **V** | dashcam grade | writes `settings.dashcam`; the DASHCAM view forces its own, harder |
| **X** | minimap | writes `settings.mmap` |
| **N** | reset to nearest road | |
| **H** | help screen | |
| **J** | imported Volvo interior + body ⟷ procedural (A/B) | see §5 |
| **K** | test mode | see §7 |
| **P** | music play / pause | desktop only — `music.enabled` is false on touch |
| **, / .** | previous / next track | desktop only |
| Esc | pause menu | music pauses with it |

J, K, T and V are the debug/A-B set. There is no build flag hiding them — they
ship live to players, and the CONTROLS screen documents them.

---

## 9. Caps and clamps that hide capability

| Clamp | Where | Value | Note |
|---|---|---|---|
| `POV_FOV_MAX` | `engine.ts:472` | 100° | *"A clamp rather than a comment, because the slider's `max` attribute does not bind"* — `settings.ts` only TYPE-checks `fovBase`, so a value saved while the maximum was briefly higher survives forever. This is the last gate before the projection matrix. **`POV_FOV_MAX_CUT = 88` is gone** with the frustum-cut dash |
| `povFov()` floor | `engine.ts:632` | 58° | Lower bound on the slider |
| `POV_V_CAP` / `POV_V_FLOOR` / `POV_H_CEIL` | `engine.ts:448-451` | 1.25 / 62 / 118 | Aspect-relative caps so portrait doesn't become a fisheye and ultrawide doesn't become a letterbox slit |
| Draw distance | `GameApp.tsx:638` slider, `settings.drawDist` | 350–1100 m, default 700 | Multiplied by `drawDistScale` per tier (0.65 / 0.85 / 1.0) |
| Traffic density | `GameApp.tsx:644` | 20–100% | |
| Asset size budgets | `test/size-budget.mjs:17-19` | 15 MB critical / 30 MB total | `public/assets-staging` is intentionally NOT scanned. `public/assets/audio` and `public/assets/lens` count against total, not critical |
| `NPC_POOL` | `audio.ts:612` | 8 voices | Moot while `NPC_VOICES_ENABLED` is false (§3d) |

---

## 10. Live console knobs (undocumented capability, not disabled features)

These are tuning hatches. They exist on the shipped build, are read fresh each
frame, and take effect with **no reload and no rebuild**. Settled values are
meant to be brought back into the source constants.

### `window.__povMount` — dashcam lens position
```js
window.__povMount.dy = -0.28   // down (this is THE seating position)
window.__povMount.dz = 0.16    // forward, past the seat
window.__povMount.dx = 0.02    // inboard / outboard
```
Seeded from `POV_MOUNT_DELTA` (engine.ts:331). **If you settle on a `dy`, move
`cockpitmodel.ts`'s `MIRROR_NUDGE.y` by the same amount in the same direction, or
the mirror leaves the top of frame.** The framing bounds written in the engine.ts
comment block were measured against the *retired* cut dash and the file says so
plainly: *"Trust the reported frame over the numbers here until someone
re-measures them on the current asset."*

### `window.__cockpitEye` — CAM_COCKPIT eye offset
```js
window.__cockpitEye.dy = -0.14
window.__cockpitEye.dz = 0.30
```
Seeded from `COCKPIT_EYE_IMPORTED` (engine.ts:356).

### `window.__consoleCam` — the experimental console camera
```js
window.__consoleCam.z = -0.1   // also .x .y .fov .tilt
```
Seeded from `CONSOLE_CAM` (engine.ts:401). *"This is the view whose whole point
is being moved around."*

### `window.__chaseShake` — restores the chase sensation effects
```js
window.__chaseShake = 1        // 0 = as shipped
```

### `window.__povTune` — the POV degrade chain
```js
window.__povTune.gainFloor    = 0.4    // 0..1  (0 = off)
window.__povTune.shadowGrain  = 1      // 0..1
window.__povTune.lampProtect  = 1      // 0..1
window.__povTune.sensorGain   = 1.25   // 1..3  (1 = off)
window.__povTune.skyCrush     = 0.6    // 0..1  (0 = off)
window.__povTune.mirrorShield = 0.85   // 0..1  (0 = A/B the mirror shield off)
window.__povTune.screenShield = 0.92   // 0..1  (0 = A/B the head-unit shield off)
```
Defaults are `POV_TUNE_DEFAULT` (post.ts:105). *"the defaults below are the
shipped balance, not 'off' — only sensorGain=1 and skyCrush/gainFloor=0 are truly
off."* Values are clamped on read, so a nonsense value falls back rather than
poisoning the chain.

### `window.__aurora` / `window.__clouds` — the sky
```js
__aurora.next()        // step to the next seed, prints what it rolled
__aurora.reroll(1234)  // pin a specific seed (or omit for random)
__aurora.gain = 1.4    // live brightness multiplier, 1 = as shipped
__aurora.lock()        // print how to pin the sky currently on screen
__aurora.roll          // { seed, palette, bands, detail[] }
```
*"The sky is the one thing here a player can't audition without a rebuild, so the
whole control surface goes on the console."* Also pinnable by URL: `?aurora=<n>`.
The aurora seed deliberately does **not** ride the world seed — *"a fresh aurora
every run is the point."*

### `window.__audioTune` — engine bus level and rumble
Seeded from `ENGINE_TUNE_DEFAULT` (audio.ts:310). Read fresh each frame via
`readAudioTune()`. Safe to turn up: `engLim` is a real `DynamicsCompressorNode`
on the engine bus only, and `test/audio-mix-check.mjs` asserts final peak < 0.99.

### `window.__audioDebug` — the `GameAudio` instance
```js
__audioDebug.getLevels()              // every noise/tone layer's live gain
__audioDebug.setEngineMode("synth")   // or "sampled"
```
*"for identifying which layer a 'mystery noise' report is coming from in one call
instead of guessing."*

### `window.__neonx` — the test-harness hook (engine.ts:862)
```js
__neonx.state()                       // full pose/perf/tier snapshot
__neonx.teleport(x, z, y?, h?, u?)
__neonx.toCorridor(z, kmh = 110, lane?)
__neonx.toTunnel(kmh = 110)           // 80 m before the tunnel mouth
__neonx.toSeam(kmh = 110)             // the run-up to the loop splice
__neonx.toBypass(s = 60, kmh = 110, lane = 0)
__neonx.setCam(i)                     // 0..4, bypasses CAM_CYCLE
__neonx.setInput({ … } | null)        // drive the car programmatically
__neonx.crashTest()                   // spawn an obstacle ahead at 22 m/s
__neonx.setRain(on) / __neonx.setTime(t)
__neonx.collidersNear(x, z)
__neonx.loadTimings                   // real per-stage load ms
__neonx.game                          // the Game instance
```
Deleted on `dispose()` (engine.ts:1855).

---

## 11. Assets retired but recoverable

### The frustum-cut Volvo dash — `volvo-s90.glb`

**Deleted from the repo** in `a716c90` ("Retire the cut Volvo dash; ship the whole
cabin instead"). Recoverable three ways:

1. **On disk, gitignored:** `public/assets-staging/interiors/volvo-s90.glb`
   (8.28 MB) + its `.json` manifest. Present as of this writing.
2. **In git history:** `git show a716c90^:public/models/cockpits/volvo-s90.glb`
   (8,945,076 bytes as committed).
3. **Rebuildable** from the donor with `tools/build-cockpit.mjs … --out volvo-s90`
   and no other flags — the command is recorded in `.gitignore`.

Why it went: *"it printed sliced edges at wide field of view"* — it was per-vertex
frustum-clipped geometry, so *"it printed torn shards at the frame borders as soon
as the Field-of-view slider went past what it was cut for, and engine.ts had to
hold the lens down to 88 whenever it was on screen."* Retiring it removed
`POV_FOV_MAX_CUT` and collapsed the J key from three states to two.

What survived it: `tools/build-cockpit.mjs` still **freezes the `mirror` role to
the cut's frustum** *"precisely so the anchors below did not move when it went."*
That is a live dependency on a retired asset — do not "clean it up".

### The 386 MB donor source

`public/assets-staging/volvo_s90_recharge_free.glb`. Gitignored **and** listed in
`.vercelignore`, because *"a `vercel` CLI deploy uploads the working directory,
not a git tree."* CC-BY material; *"the built 5.4 MB interior is what ships, never
the donor."* Rebuild command in `.gitignore`.

### The development render gallery

`docs/gallery/` — 2.9 MB, 87 renders, committed (`eb76226`) and excluded from
deploys via `.vercelignore`. Unreachable at runtime three times over (outside
`public/`, not imported, not walked by the size budget). Browse it on GitHub or
open `index.html` from a clone over `file://`.

### Not built: a `-4k` interior variant

`game/player.ts:31` — *"Build a -4k variant and point desktop at it if a brighter
interior ever makes the difference visible."* Desktop and mobile-high currently
share one file, because the dash covers ~344k pixels of a 1080p frame and the
dashcam pass then softens, grains and crushes most of it toward black.

---

## 12. Unmerged branches

`git branch --no-merged main` — two, and they should be handled very differently.

### `engine-sfx-candidate` — replacement engine audio, **never listened to**

`eb1b185` "Replace the ladder with one real recording of an ordinary saloon".
Also on `origin`. Diff against main:

```
 ATTRIBUTIONS.md                       |  35 ++++-
 docs/engine-sound-rpm.md              | 169 +++++++++++++++++++---
 game/audio.ts                         | 254 +++++++++++++++++++++++-----------
 public/assets/audio/engine/loop_0..3.wav | replaced (each ~half the size)
 public/assets/audio/engine/loop_4.wav | new
 test/audio-assets-check.mjs           |   2 +-
```

**What should happen:** somebody should actually listen to it. It is a real
candidate with docs and an updated asset check, and it will rot — the `audio.ts`
delta is 254 lines against a file that is being actively edited on main. Either
merge it or write down why not.

### `verify/cloud-pass-1` — 74.6 MB of disposable verification PNGs

`58c88a3`, 129 files, also pushed to `origin`. These are artifacts from a
verification pass, not source.

**What should happen:** delete it, locally and on the remote
(`git branch -D verify/cloud-pass-1 && git push origin --delete verify/cloud-pass-1`).
Binaries do not delta — as `.gitignore` warns about cockpit rebuilds, *"each
rebuild adds another full copy permanently."* Every clone pays for this branch.
If any of the images matter, they belong in `docs/gallery/`.

### Other branches (merged, but still present)

`feature/npc-traffic-cars`, `fix/npc-car-textures`, `fix/npc-lamp-anchors`,
`louder-engine-rumble`, `night-lighting-pass`, `npc-random-paint`,
`volvo-dash-prototype` all point at or behind `d660a43` and report as merged.
They are stale labels, not pending work.

---

## 13. Done in this batch

### The head-unit music card, switched off; the nav map expanded to fill the console

**Status at the time of writing: not landed.** `game/carscreen.ts` is byte-identical
to `HEAD` (`git diff` is empty; mtime 2026-08-21 18:11), and still describes and
draws the split layout:

- `carscreen.ts:10-11` — *"a nav map on the right (~60%), a music player card on
  the left (~40%), thin bezel and a glass reflection over the lot"*
- `carscreen.ts:43-44` — `const NAV_W = 154;` `// split: right 60% map, left 40% music`
  and `const NAV_X = W - NAV_W;` `// nav pane spans NAV_X..W; music pane 0..NAV_X`
- `carscreen.ts:60` — `const CARD = { x: 6, y: 6, w: 91, h: 148 };` the music card rect
- `carscreen.ts:61` — `const BAR_X = 15, BAR_W = 73, BAR_Y = 128;` its progress bar
- `carscreen.ts:151` / `:215` — the music-card section and its offscreen repaint
- `carscreen.ts:298` — the nav pane section

So I am describing the *intent* rather than the code, and deliberately not
guessing at post-edit line numbers. Once it lands this entry should be rewritten
against the real diff.

**Intent, as given:** the music **panel on the dash** is switched off and the nav
map takes the freed space, filling the whole 256×160 centre-console screen.

**What is explicitly NOT deleted:** the music system itself. `game/music.ts`
(45 KB), the audio graph, and the P / `,` / `.` transport keys all stay. Music
still plays; it just stops having a card on the head unit. Note `music.enabled`
is already `false` on touch devices (`music.ts:487`) — so on mobile the card was
already showing a static fallback rotation, which is part of why it was the
expendable half of the split.

**To turn the card back on:** restore the split — the pane geometry is the whole
of it (`NAV_W` / `NAV_X` and the `CARD` rect), and `drawCard()` and its offscreen
canvas are what feed it. `drawNav()` already takes its pane width and scale as
options (`NAV_SC`, `NAV_W`, `H`), so widening and re-narrowing the map is a
parameter change, not a rewrite.

---

## 14. Things that look like accidents rather than deliberate disables

Flagged, **not fixed** — per the brief.

1. **Two stale comments now assert the opposite of what the code does.**
   Commit `5c6cadd` removed the `|| pov` force on the dashcam frame blend, but:
   - `game/post.ts:1195-1199` still says *"the mobile tiers run this path even
     with mblur off, because POV forces doMbSetting on"* — they no longer do.
   - `game/engine.ts:3495` still says *"this path runs on mobile even though
     tierCaps.mblur is false there — POV forces the blend on regardless of the
     setting"* — it does not.

   These are exactly the comments the next person will trust.

2. **On mobile, the Motion blur checkbox cannot affect the dashcam at all.**
   `engine.ts:3488` gates on `settings.mblur && tierCaps.mblur`, and
   `tierCaps.mblur` is `false` on both mobile tiers — so `opts.mblur` is always
   0, `doFinal` is false in POV, and the exposure blend pass never runs. The
   *point* of `5c6cadd` was to give the player a say; on mobile they still have
   none, in the opposite direction from before. Whether the 40 ms POV exposure
   should be gated by the *chase-cam perf cap* at all is the real question —
   they are different effects sharing one cap. Probably wants its own cap field.

3. **The Reflections checkbox is partly inert.** Road SSR is hardcoded to 0
   (§3c) with the settings parameter explicitly voided (`void reflectionsOn;`).
   The checkbox still governs the planar reflection RT, so it is not *fully*
   dead — but a player who unticks it expecting the road to change sees nothing.
   Deliberate at the shader level; the UI was never told.

4. **`fenceOverdraw` is described as having no consumer, and now does.**
   `settings.ts:32` still reads *"no consumer yet; the fence lane gates on this"*,
   but `highway.ts:1159-1161` consumes it (*"the fenceOverdraw cap finally gets
   its consumer"*). Harmless, but the comment misleads.

5. **The steer-response sim is modified in the working tree.**
   `test/steer-response-sim.mjs` and `game/physics.ts` were dirty during this
   sweep — another lane's in-flight work, not a disable. Noted so it is not
   mistaken for one.

6. **Not an accident, but easy to mistake for one:** `tools/build-cockpit.mjs`
   freezes the `mirror` role to the *retired* cut dash's frustum. It looks like
   dead donor-specific code. It is load-bearing — removing it moves every mirror
   anchor in `cockpitmodel.ts`.
