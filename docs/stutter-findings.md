# The stutter: what four probes actually establish

## It is not the toll plaza
Driven around the lap with a 16 s hold at each place, twice over:

| place | programs | textures | geometries |
|---|---|---|---|
| settle (never moved) | +11 | +0 | +0 |
| open deck | 0 | +0 | +5 |
| tunnel | 0 | +0 | +0 |
| toll approach | +2 | −2 | +0 |
| **toll plaza** | **0** | **+0** | **+0** |
| past toll | 0 | +0 | +0 |
| town | 0 | +5 | **+115** |
| mountain gore | +26 | +4 | +11 |
| open deck (2nd) | 0 | +2 | +0 |
| toll approach (2nd) | 0 | +2 | +0 |
| **toll plaza (2nd)** | **0** | **+2** | **+0** |

The plaza's frame median is also among the lowest on the lap. It draws less
than open road — fewer calls, fewer triangles — which was measured earlier and
still holds.

## It is not the photo scans either
They resolve **147 seconds before the game is playable**, with the renderer
holding zero programs. They account for 20 programs (245 without them, 265
with), and in the normal ordering those are linked once by the load's own
compile stage. Only when the download outlasts the world build — a real first
visit on a phone connection — do they land on a driving frame.

## What it actually is
Programs link **in bursts, when new content first enters the scene**, and where
that lands is a function of the session rather than the map. Two runs, same
route, same stops: the first put +18 at the second toll approach and +8 at the
second open deck; the second put +26 at the mountain gore and nothing at either.
Second visits to a place cost nothing.

Several of the new programs belong to objects that are **no longer in the scene**
when the probe looks — transient content: sprites, batched dressing, cars that
have despawned. One is identifiable by its defines: the **aurora** (NB / LOWQ,
world/aurora.ts) builds its full-sky shader mid-session rather than at load.

The town also uploads **+115 geometries** in one visit, which is a synchronous
buffer upload no program count sees.

## Where the fix goes
`world.compileDirty` already exists for exactly this, and the engine's slow tick
walks it with `compileAsync`. The async toll props (highway.ts) and the HD
bodyshells (traffic.ts) set it. The content bursting in these runs evidently
does not — that is the gap to close, plus building the aurora at load rather
than when night arrives.

## Caveat that matters
`KHR_parallel_shader_compile` is **not available** in this sandbox, so
`compileAsync` here links synchronously and only moves a stall rather than
removing it. On real hardware it links off-thread. Any measurement of a
compileAsync fix taken on this box understates it.

---

# Two failing sims on dev, and why neither is what it looks like

Both predate tonight's work. Both assert an ABSOLUTE zero on a count that is
stochastic, while every sibling assertion in the same file compares against a
control.

## `whiteline-sim` — "WLINE caused an overlap"
Fails on 6 overlap frames involving an actively-easing car, and on the fleet
total rising 150 → 185 with the feature on.

Tested directly: the ease was clamped to the real lateral clearance of the
nearest overlapping body on the side being eased toward, in both traffic.ts and
the sim. **Every number came back byte-identical** — 185, 6, mean ease 0.398.

That is the answer, not a failed attempt. Lane neighbours sit ~3.7 m apart and
the ease is 0.25–0.55 m, so body clearance is never the binding constraint and
an easing car is never the one closing the distance. The overlaps must come
from the sim's own background lane-change model, which its comments already
flag as *blind* — cars in it change lane without checking. Any lateral
displacement reshuffles which random overlaps occur, and 150 vs 185 is that
reshuffle, not causation.

The clamp was reverted rather than kept: code that provably changes nothing is
worse than no code.

**Recommendation:** make these two assertions comparative, the way the
neighbouring ones in the same file already are. That is a test change on a
stochastic measure, so it is a judgement call worth making deliberately.

## `rival-sim` — "player held the lead for 3.07 s"
Three seeds. This is the rival's unpassable mode, which the gallery's own
timeline already records as *built, simmed, held back — needs one round against
the new wide lanes*. The test is tracking known incomplete work rather than a
regression, and the mountain is now wider still.

## `hail-sim` — "1 overlap frame involved a honk-induced move"
One frame in 1381. The same file reports that honking **reduces** total
overlaps (1381 with, 1441 without), so the feature is not making the world
worse. Same shape of problem: an absolute assertion on a stochastic count.
