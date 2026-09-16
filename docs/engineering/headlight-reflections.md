
# Car & barrier response to headlights

Read `light-falloff.md` first — its three stop-vs-fade
mechanisms and the grade/crush math are assumed everywhere below.

## The core fact: the real SpotLights cannot light vertical things

The player rig is four SpotLights (engine.ts `weather()`: `spotL/R` main
cones, `spreadL/R` lateral fill). Every one of them is **edge-pinned with
penumbra 1.0**: the cone's upper edge is held at/near horizontal, so the axis
points down by its own half-angle into the tarmac, and the angular term
(`smoothstep` from axis to rim) is ~0 everywhere except near the axis.

Consequence — verified numerically, not a guess: a vertical surface (a car's
rear panel, a barrier face) is *always* in the last degree before the cone
rim. At 30 m the bumper of a car ahead receives ≈ `60/30^0.45 × 0.012 ≈ 0.09`
— invisible. The barrier at 5.3 m lateral never gets inside the 0.26 rad main
cone below ~20 m, and past that it is rim-starved too. The lights are NOT
excluded by layers and NPC materials (MeshStandardMaterial, metalness 0.24,
roughness 0.64) respond normally — there is simply almost no incident light.

**Do not fix this by widening/re-aiming/brightening the cones.** The cone
geometry IS the beam-on-road look this took weeks to land (the long comments
at engine.ts ~1480-1590 explain why every parameter is where it is). Both
reflections are therefore *matching fakes*, the same pattern as the
streetlight wash and the NPC ground pools.

## Mechanism 1 — headlight-on-NPC: the player-beam wash (traffic.ts)

`renderInstances()` writes a per-instance radiance into the **washCol**
attribute (the channel the streetlight wash already uses). The `HLW_*`
constants above `washFall()` define a forward wedge from the player's nose:

- `HLW_GAIN = 0.12` — peak wash, deliberately tiny ("really subtle" — user).
- `HLW_CORE_D = 18, HLW_R_D = 60` — full to 18 m, smoothstep tail to 60 m.
- `HLW_CORE_L0/R_L0 + …LK·along` — lateral gate that widens with distance.
- Tint `(1.0, 0.858, 0.708)` = dipped 0xffeeda in linear.

It lands in `npcShader()` as `vWashCol * albedo * (0.55 + 0.45·normal.y)` and
rides inside `outgoingLight`, so the **anti-blowout knee** (`KNEE = 1.3`,
`KNEE_MAX = 4.0`, traffic.ts ~line 233) caps it along with everything else —
the knee compresses anything above 1.3 pre-grade radiance toward 4.0, which
ACES then maps near-white; the wash never gets close. Gated on
`night && player.lightsOn`; costs one dot product per NPC per frame, zero
lights, zero attributes.

Worked POV numbers (grade math, per realistic-light): a 0.35-albedo panel at
night sits ≈ 0.042 linear ≈ 0.13 display luma after ACES + dashcam crush.
Full wash adds ≈ 0.023 linear → ≈ 0.20 display. At 30 m following distance
the wedge factor is ≈ 0.8 → about half that lift. Subtle by construction.

## Mechanism 2 — headlight-on-barrier: addBeam's `wash` mode (world/mats.ts)

`addBeam(mat, {near, far, spread, wash})` has two paths:

- **multiplier** (default, no `wash`): `albedo ×= mix(floor, 1, cone·fall·k)`
  — for UNLIT retro materials (lane paint, studs, the perforated fence).
  Never use it on a lit material: outside the beam it darkens the ambient
  night look everywhere.
- **wash** (`wash: <gain>`): adds
  `albedo × dippedTint × cone × fall × uBeamK × gain` as emissive — for LIT
  materials. Registered on `barrier` and `barrierDouble` (the parapets,
  built in world/highway.ts as `wallMat`) with
  `{near: 22, far: 78, spread: 0.55, wash: 0.5}`.

Shared frame state comes from `setBeam()` (called in engine `weather()`):
`uBeamK = lampsOn ? night : 0` kills it in daylight; `uBeamRange`
(= throw/115) stretches near/far for high beam automatically. The fade is the
cone smoothstep (align 0.55 → 0.71) times the range smoothstep (22 → 78 m) —
no hard line by construction, satisfying realistic-light's rules.

Worked numbers: parapet albedo ≈ 0.15 linear (0x8d939f × concrete scan);
peak wash 0.15 × 0.5 ≈ 0.08 linear → ≈ 0.33 display luma in POV. Clip starts
at 0.72; hue bleach ≈ 0.8. Plenty of headroom.

**Trap:** `projectedUv()` (same file) is applied to the parapet materials
when the async photo scans land, and it now **chains** the prior
`onBeforeCompile` and composes the program cache key (`projuv|beam|…`). If
you add another shader hook to a concrete material, keep that chain intact —
the pre-fix behavior (clobbering) silently deleted any earlier hook, and a
shared cache key across different hook sets makes three reuse the wrong
program.

## Mechanism 3 — NPC beams (traffic.ts POOL_*)

Real per-NPC SpotLights are **banned** (each multiplies the lit-shader cost of
every surface it touches). NPC beams are: emissive-ish glow sprites
(`clouds.head`, capped by `SPRITE_MAX`) + one instanced additive ground-pool
quad per car (`POOL_LEN/POOL_W/POOL_GAIN`, texture in `poolTexture()`).

- "Longer/stronger" is bought with **POOL_LEN** (span): the POV crush keeps
  only pixels above its floor, so footprint ≈ apparent brightness. The
  non-uniform `POOL_ROWS` v-mapping stretches with the quad, keeping the
  long tail.
- **POOL_GAIN has no headroom.** The hot core (0.85 texel × 0.36) already
  composites to ≈ 0.71 display luma against the 0.72 blown-white clip.
  Raising it hands the delta to the clip and prints a white patch.
- The head-glow tint/size (0xa9b7d1, 1.35) was set by an explicit user pass
  ("spread more, less focused bright") — do not "restore" it brighter.

## Change log of the 2026-08-21 pass (one lever at a time)

1. traffic.ts: added `HLW_*` player-beam wash, `HLW_GAIN` chosen 0.12
   (nothing → 0.12; the math above says ~+0.07 display luma on the car ahead
   at following distance — the requested "very light" read).
2. mats.ts: `addBeam` gained the `wash` path (new mechanism, no existing
   value changed); `projectedUv` chains hooks instead of clobbering.
3. mats.ts: parapets registered — `wash` nothing → 0.5, reach 22/78 m,
   spread 0.55.
4. traffic.ts: `POOL_LEN` 15.0 → 18.0. `POOL_GAIN` deliberately unchanged
   (clip math above). No other NPC-light value touched.

## Tuning procedure (stronger / weaker later)

- Car-ahead response: move **HLW_GAIN only**, in ~0.03 steps; past ~0.25 the
  car reads self-lit. To change *where* it reads, move `HLW_CORE_D/HLW_R_D`
  (keep `R_D − CORE_D` ≥ ~30 m — that gap is the tail that makes it a fade).
- Barrier response: move the `wash` gain on the two `addBeam(barrier…)`
  lines in ~0.1 steps; keep peak `albedo × wash` under ~0.35 linear or the
  near wall approaches the clip. Reach: move `far`, never add a hard stop;
  `near`→`far` is already a smoothstep.
- NPC beams: span via POOL_LEN; brightness is spent — see above.
- Never compensate a widening with a gain cut (realistic-light rule 4), and
  verify by grade math + `npx tsc --noEmit`, never by running `next dev`.
- Hot reload will NOT show mats.ts/texture changes — world materials build
  once, so a hard reload is needed to see a change.
