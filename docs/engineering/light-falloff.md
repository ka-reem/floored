
# Light falloff: making light fade instead of stop

> For how the beams land on OTHER surfaces — NPC car bodies, the concrete
> parapets, and the NPC beam budget — see `headlight-reflections.md`.

## The recurring complaint

The same defect has shown up three separate times, on three unrelated
light systems (highway lamp ground pools, the cabin streetlight wash, the car
headlights). Their words, roughly:

> "super bright ... then it doesn't fade out like it should, it has like that
> hard line" / "looks like its scoped there" / "the light is white when it
> should be orange"

It is always the same underlying mistake, and it is **not** "too bright".
Turning brightness down does not fix it and usually makes it worse. The real
defect is that **the light stops instead of fading**, and there are exactly
three mechanisms in this codebase that make light stop.

Diagnose which one is in play before changing any value.

## Mechanism 1 — hard cutoffs

Light that is still strong when it reaches a hard boundary prints that
boundary as a visible line or circle.

- `THREE.SpotLight.distance` is a **hard clip**, not a falloff: intensity is
  zero at exactly `distance`. `HL_THROW = 130` (engine.ts:76) is therefore a
  literal terminator line across the road.
- `decay` controls how fast it dims on the way there. **Shallow decay plus a
  hard distance cutoff is the worst possible pairing** — the beam stays bright
  right up to the clip and then vanishes. Low beam runs `decay = 1.0`
  (engine.ts:1300), i.e. 1/r not 1/r², deliberately for an even carpet, which
  makes its cutoff maximally visible.
- Canvas gradients whose final stop still carries alpha print the quad edge.

**Fix:** put the boundary where the light is *already* dim — extend
`distance` rather than dimming the beam, so the clip lands past anything the
eye can see. Only touch `decay` if you have read why it was set (the low/high
split exists because of the NPC anti-blowout knee in traffic.ts — see the long
comment at engine.ts:1179-1192; changing it has knock-on effects on every car
in the scene).

## Mechanism 2 — the grade bleaches bright pixels to white

The renderer uses `NoToneMapping` with a **manual ACES pass** in the composite
(engine.ts:313, post.ts:255). Two things there destroy hue in highlights:

```glsl
col = aces(col);
float sat = mix(1.16, 1.0, smoothstep(.25,.9,l));   // post.ts:266
```

The vibrance boost fades to 1.0 as luma climbs, and ACES desaturates on its
own. So **anything above roughly 0.8 output luma loses its colour and reads
white**, no matter what colour the light source is.

**Consequences:**
- **Peak level is a hue budget, not a brightness budget.** If you want a light
  to read as *coloured*, it must stay under that ceiling. A saturated orange at
  moderate level reads far more like a streetlight than a blown hotspot does.
- **Decouple hue from level.** Never ramp colour on the same envelope as
  intensity — the light will be the wrong colour everywhere except its peak,
  and bleached white at the peak. Saturate hue *early* and hold it
  (`min(1, w * 2.2)`), then move brightness separately.
- **Source colours must be picked against the grade, not in isolation.** Two
  worked examples already in the tree: the lamp cone at highway.ts:984 —
  *"the old 0xff9e50 came through the ACES grade as salmon — red survives
  tone-mapping better than green, so the source has to sit further toward
  yellow than the target colour does"*; and the cabin wash, where the glow-
  points hex `0xffa235` had to become a deeper `0xff7a10` because a value
  tuned for additive points over near-black is wrong for diffuse light on PBR
  trim through the grade.

## Mechanism 3 — the POV black crush truncates the fade

The dashcam degrade chain crushes blacks hard (post.ts, after the smear):

```glsl
col = max(col - .06, vec3(0.)) * 1.22;                 // anything under .06 -> pure black
col = pow(max(col,vec3(0.)), vec3(1.18,1.24,1.22));    // gamma >1 eats midtones
col *= 1. - r2*.55;                                     // vignette, up to -55% at frame edge
```

A **linear** ramp crossing that floor clips at a definite radius, which is
what reads as "scoped" — a circular cutout rather than a fade.
The vignette compounds it: light near the frame edge loses over half its
value, which is why a lamp head can read pure black even close to camera
despite being an unlit near-white material.

**Fix:** give the falloff a **long, shallow tail** that lingers *near* the
crush floor instead of diving through it. The tail is what converts a cutoff
into a fade.

Note `lampProtect` (post.ts:561) is **not** a culprit — it *protects*
saturated lamps from the blown-white clip, and already runs at full strength.
Do not reach for it.

## Practical rules

1. **Many stops, not knees.** 3-4 stop canvas gradients print their own knees
   as visible rings once stretched over a large footprint. Sample a smooth
   monotone decelerating curve at ~15 stops instead. See `poolGradientTex()`
   in `game/world/decaltex.ts` for the reference implementation.
2. **Spend radius on the tail.** The outer third should be a long low creep to
   zero, not a straight line to zero.
3. **Widen before you brighten.** A wider footprint puts more pixels above the
   crush floor, so it survives POV where a narrow bright patch does not. This
   is why widening a light often makes it *more* visible than brightening it.
4. **Never compensate a widening with an opacity cut.** Doing so cancels the
   change — the core dims by about as much as the edge gains and there is
   no visible difference. If the spread needs taming, take it out of a gradient's
   mid-stops so the core keeps its brightness and only the skirt softens.
5. **Derive footprints from geometry, not fixed metres.** The deck is 3 lanes
   for most of its length and 6 through the toll plaza; use fractions of
   `cor.halfWidth(z)` so the wash still spans the road where it widens. But
   check for overhang — a pool wider than `hw` hangs off the parapet into open
   air on the elevated sections.
6. **Check where the cutoff lands, in metres.** Compute it. A 4.5 m half-axis
   on a 14.2 m road covers less than half the width no matter how it is tuned.

## Verification

Geometry and canvas textures are built **once** at world/cockpit construction,
so hot reload will not show changes to them — a hard reload is required, or
you are judging the previous frame.

The POV knobs in `window.__povTune` (post.ts:29-52) are read fresh every
frame, so the grade can be A/B'd live from the console with no rebuild —
e.g. `window.__povTune.skyCrush = 0`, `sensorGain = 1.8`. Use that rather than
guessing at grade values blind.
