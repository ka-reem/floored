# The two-day overhaul — 2026-08-27 → 2026-08-29, in plain language

What actually landed on `main` across the overnight wave, the day-2 wave, and
the night wave, from the merge history (`git log --merges --since=2026-08-27`)
and the lane reports in `docs/handoff/reports/`. Rollback point for all of it:
the `pre-overnight-2026-08-28` branch (commit `6afff7b`).

The fastest way to *see* everything below: `docs/gallery/index.html`, one
chapter per lane, 184 renders.

## Wave 1 — the overnight overhaul (`ea0cbf7`, "nine of eleven cloud lanes")

Eleven cloud lanes ran in parallel overnight; nine landed real changes, merged
through an integration branch with one real conflict (two lanes extending the
same tier-cap table — both features kept), full verification green.

- **The menus, redesigned** (ui-redesign) — the owner's "it just looks bad"
  menu replaced by one design-token system: shared palette, spacing scale,
  self-hosted Space Grotesk display type, and a viewfinder corner-frame with a
  pulsing status dot as the unique flair. Every element id the engine writes
  into is untouched.
- **The city lights stopped blinding and lagging** (city-lights-perf) — the
  town's lamp/pool/beacon layers had no distance cull at all and rendered
  every frame at any distance; now culled and faded per tier.
- **Console camera unstretched** (cameras-fov, `05cea99`) — the between-the-
  seats camera's FOV no longer runs away at the slider's max (degree-shift
  instead of multiplicative scaling), the speed FOV kick is tamed, and the
  FOV slider now works in every camera.
- **Test-mode acceleration eased** (test-drive-accel) — torque multiplier
  ×3.2 → ×2.7, now a named knob (`TEST_ACCEL_MULT`); top speed unchanged.
- **Weather moved in** (sky-clouds) — the procedural night-cloud deck grew
  storm layers and a dusk pass; still zero downloaded images.
- **Mobile input fixed** (mobile-input) — the double-tap magnifier loupe and
  the stuck steering wheel are gone: per-pointer-id tracking, gesture events
  blocked, and a pause now clears any latched touch input.
- **More to touch in the cabin** (interactivity) — clickable turn-signal and
  hazard switches at the wheel rim (placed by projecting through the live
  dashcam, since the real stalk positions are out of frame), on top of the
  existing interior-light and radio hotspots.
- **The rival and the No Hesi score** (rival-whiteline, `311b43a`) — an
  optional rival pace car that carves through traffic without ever clipping
  through it, and the No Hesi scoring loop: speed + near misses build a combo
  (cap ×8), contact resets the multiplier, never the total; best score
  persists. Both off/on via settings (`rival` off, `noHesiScore` on).
- **Map overhaul, first pass** (map-overhaul) — roadside trees, a crossing
  overpass, and the scenery pass rewired back into the build.
- **Blocked, honestly** (npc-fleet-hd, volvo-body) — both needed Sketchfab
  downloads and the sandbox egress said 403; the machinery (a rear-biased
  car-body build tool) landed, the assets did not. Nothing was faked.

## Wave 2 — day 2 (2026-08-28)

- **The road made real** (highway-realism, `559844a`) — worn, flaked lane
  paint, procedural asphalt detail, deck dressing; all tier-gated and
  splice-safe.
- **Seeing through the dashcam** (dashcam-clarity, `18d916c`) — the POV
  grade's hard black clip became a soft toe (darks fade instead of snapping
  to black), and the grade is now tier-profiled: phones keep every effect at
  legible strengths, desktop keeps the full filmic character.
- **Every control under one thumb** (mobile-controls, `f92d7da`) — the ⋯
  chip and its corner drawer put L/X/M/R/T/V/K/N on touch, and the topbar's
  ◀ ▶ telltales became the signal switches. Built on ui-redesign's tokens;
  drawer rows drive the exact key handlers, so they can never disagree.
- **The QA pass** (qa-pass, `37bc609`) — three assigned issues fixed with
  receipts: the "N" overlapping the score corner was Next's own dev badge
  (moved; the score HUD also got real token styling), the smoke-test ramp
  timeouts were the harness timing the sandbox rather than the game (it now
  budgets in sim-seconds via a new `simStep` hook), and the minimap font
  joined the type tokens. The adversarial sweep found zero new in-game bugs.
- **Six places instead of one corridor** (map-transform, `5fef855`) — the
  driven corridor transformed from bare parapet against blackness into six
  districts the dashcam can actually see: harbor wharf, a rhythm of three lit
  overpasses, the eastside canyon, the interchange high-masts, foreground
  industry with a lit flare stack, and the neon canyon with its 湾岸 gate.
  Zero downloads, everything merged/instanced, density riding a new
  `districts` tier cap.
- **EXIT 4 — the mountain pass** (mountain-road, `bbbb1f2`) — the owner's own
  idea shipped: 峠 Tōge, a curvy two-lane riverside road off the expressway
  and back onto it, with sparse oncoming traffic to dodge, corner speed caps,
  and a lay-by. Sited in the one taper-free window of the lap, now asserted
  per-seed by `test/lane-plan.mjs`.
- **The fleet, baked and re-judged** (`7331275`, then `fc4fda1`, `084dbc4`,
  `8f85877`) — the hi-fi NPC fleet and the Volvo's rear were baked on the
  laptop where Sketchfab answers. Then the owner drove it and called it: the
  civil-pack taxi/police/van read "glitched and angled" and went back to the
  Orchids bakes; the ItsDiyor sedans didn't clear the bar either and followed;
  the HD desktop upgrade parked (`HD_STYLES` empty). What survived: the new
  **bus**, the emissive **lens lamps** that retire the glow sprites up close,
  and the rebuilt **Volvo rear** (0.78 MB, rear-biased decimation) that the
  chase camera and mirror actually look at.
- **The cabin went everywhere** (`b50d5b4`) — the donor Volvo cabin now loads
  on all three tiers; mobile-base skips its PBR detail maps (~184 MB decoded)
  instead of the whole cabin. The garage card shows the real car.

## The night wave (2026-08-29, small hours)

- **Perf pass, instrumented** (`59a41a9`) — the draw-call meter now sweeps
  all three tiers and hunts shader-compile hitches, and a new cold-load
  probe proves lazy assets fetch after first frame. The report's number
  tables were still pending at merge time; the tooling is the deliverable.
- **Branch archaeology closed out** (`ff15914`) — the four pre-rewrite
  branches were proven content-supersets of today's main (nothing on the
  shelf), and the remote has since been cleaned to `main` only.
- **The gallery grew its front door** (`b1f15bd`, `cdfad41`) — an interactive
  era timeline atop the progress page and a rolling summary of the night
  wave; 32 chapters, 184 renders.

## The docs caught up (this lane, 2026-08-29)

README rewritten against the game as it is; GAME.md and DISABLED.md
re-verified claim by claim with commits cited; ATTRIBUTIONS brought in line
with the fleet reversals and the shipped cabin, plus entries for three
previously uncredited (CC0/OFL) assets. The size budget passes: 12.78 / 15 MB
critical, 14.86 / 30 MB total.
