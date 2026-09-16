# TikTok slide sets for Floored

The working spec for turning rendered Floored frames into postable 1080x1920 slide
sets — canvas, safe zones, type, story arc, and the tooling that composites them.

The output of this pipeline is a numbered set of finished 1080x1920 images with the
text already burned in. Not a description of what to post, not a template that still
needs editing — finished images, in order, ready to upload.

`research.md` in this directory is the sourced findings behind every number here, with
a confidence table at the end. Check it before overriding anything.

## Read this first — the format is weaker than it looks

The widely-repeated "TikTok photo mode gets 5x more reach than video" is **false**.
It is an inverted statistic. Metricool's 2026 study (2.31M posts) found *videos* get
~5x more reach than images/carousels, and image-post views fell 23% year on year.
Buffer 2026 agrees: TikTok video 3.39% engagement vs carousels 1.92%.

Two consequences, and neither gets quietly dropped:

- Slideshows are worth making because they cost ~20 minutes instead of hours, and
  because this game photographs well. They are **not** a reach cheat code.
- **Instagram carousels measure at 6.9% engagement — 3.5x TikTok's.** Every set
  should be cross-posted there. For carousels specifically, the honest answer to
  "which platform first" is Instagram.

## The spec

```
canvas      1080 x 1920, sRGB
slides      8   (6-10 acceptable; before/after sets 2-4; never above 12)
safe box    x 90..900, y 200..1420
```

The safe box is the conservative union of conflicting sources — TikTok itself says
the caption block's height varies with caption length. Outside it live: the
`n/N` photo counter (top right), the like/comment/share rail (right ~180px), and
the pagination dots plus caption (bottom ~500px). **Photo mode has two overlays
video does not** — the counter and the dots — and they are the ones that get
forgotten.

Nothing that must be read goes outside that box. Image content can and should
bleed to the edges; only *text* is constrained.

### Type

| role | size | face | treatment |
|---|---|---|---|
| hook | 72-110px | Anton | white on 60-70% black scrim, upper-middle (y 260..700) |
| body | 48-60px | Anton / Archivo Black | white, heavy black stroke, or scrim over busy frames |
| label | 30-40px | Archivo Black | letterspaced caps, used for numbers and units |

36px is the absolute legibility floor on a phone. Anton and Archivo Black live in
`~/.local/share/fonts`; if they are missing, re-fetch from Google Fonts, convert
woff2 -> ttf with fontTools, then `fc-cache -f`.

**Use a scrim, not bare stroke, over Floored frames.** This is a night game full of
headlight bloom, wet-road highlights and neon. A pure stroke — the CapCut default —
fails exactly where the frame is brightest, which is where the eye already is.

### The arc

```
1  HOOK      5-8 words, biggest text. This is also the thumbnail. ~80% of the effort.
2  PROBLEM   show the bad state
3-6 ESCALATE one idea per slide, each making the next more wanted
7  PAYOFF    the best-looking frame in the set. Full bleed, minimal text.
8  LOOP      re-pose slide 1 now that the viewer understands it
```

Slide 8 looping back to slide 1 is the one real mechanical trick: photo posts
auto-advance and cycle, so 8 sits adjacent to 1. A set watched three times yields
300% watch percentage. Alternatives to the loop, in order: a question (measured
+26.19% comments), then a soft CTA.

### Hook patterns that fit this game

Ranked by what Floored actually has:

1. **Format flex** — "This is a browser tab. Not a console." Most people do not
   believe a browser does this. Floored's most under-used and best cold hook.
2. **Confession** — "My headlights were wrong for six months." Highest trust,
   best for a returning audience. This repo is *full* of these; every real bug
   that got found is a confession hook.
3. **Number** — "I spent 400 hours on a road you'll drive past." Specific numbers
   beat vague ones every time. This repo measures everything, so the real figure
   goes on the slide, never a rounded invention.
4. **Question** — "Rate my rain. Be brutally honest." Deploy when comments are
   the goal.

**A hook the set does not pay off never ships.** Bait-and-switch is a named
top-five slideshow killer, and it is the one mistake that costs the account rather
than the post.

## Sourcing frames

`test/hero-shots.mjs` exists for this. Unlike every QA harness in `test/`, it has no
question to answer — it forces the HIGH preset and the DESKTOP tier, hides the HUD
and the dashcam grade, and shoots at 2x. Content frames should show the ceiling,
not the default a phone would get.

```
npx next dev --webpack -p 3490
node test/hero-shots.mjs --url http://localhost:3490 --tag hero
```

A full game load is ~3 minutes on this box and each frame settles for 6s, so a
14-station run is ~15 minutes. Budget for it.

The QA captures in `test/artifacts/` and the 400+ webps in `docs/gallery/img/` are
also fair game, and the before/after pairs there are *already* the comparison
format that generates the most shares. A marked-up diagnostic image often
outperforms a pretty frame, because it shows the work.

## Building the set

`tools/tiktok-slides.mjs` composites. It takes a JSON spec and writes numbered PNGs:

```
node tools/tiktok-slides.mjs --spec /path/to/set.json --out /path/to/dir
```

Each slide takes `image` (source path), `hook` or `body` text, optional `label`, and
optional `crop`. The script letterboxes a landscape frame over a blurred fill of
itself, so the whole composition survives instead of being cropped to a 9:16
keyhole, and puts a scrim behind text automatically.

## Shipping a set

The slides go out in order, as images, in one message — they get screenshotted and
posted by hand.

Alongside them, in a few lines and no more:

- the post caption (200+ chars, hook in the first 100, ending in a question)
- 3-5 hashtags — **hard cap is 5 since Aug 2025**, most guides online are stale
- a sound direction (night-drive / city-pop / phonk), not a specific track — links rot

When a set is offered as options, the **angle** varies, not the polish: a
format-flex set, a confession set and a before/after set are three genuinely
different bets. Three palettes of the same set is not options.

## Field notes after the first three sets (2026-09-10)

Review of sets A/B/C and the rules that follow from it. These override the generic
guidance above where they conflict — they come from looking at real output, which
the sources did not.

**Slide count: 5-8, and prefer the low end.** Every slide is screenshotted by hand,
so each one costs real effort. 8 was the research's arithmetic optimum; 6 is the
working default now, and 8 only ships when the story genuinely needs it.

**Debugging content did not land.** The bug-hunt sets (B and C) read as inside
baseball. What works instead is the angle only this project has: the game is built
by an AI, so the content uses the AI's own perspective — how it thinks, how it
approached building a game, written in FIRST PERSON as the AI. That is the
differentiator; a bug story is not.

**Every frame must be a different picture.** All six car photos in a set being the
same shot is the most common failure. The driving cameras all look down the road
from behind or inside the car, so a set built only from `hero-shots.mjs` is six
near-identical images. Build a contact sheet before choosing, and pull from
`hero-orbit.mjs` (photo mode: low front three-quarter, side profile, high rear)
plus the genuinely distinct driving stations — `toll-plaza` (neon, wet
reflections), `mtn-gore` (daylight, ferris wheel), `deck-hood` (headlight beams,
no car), `mtn-pass`. More city frames are wanted.

**Facts must be checked, not estimated.** "85 cars" went onto a slide from a
smoke-test reading and was wrong: traffic count varies with the density setting, so
it was never a fixed fact. A number only goes on a slide once it has been verified
in the code or measured — a wrong number in public is worse than no number.

**No link while the game is in beta.** No "link in bio", no URL, no call to play.
Curiosity is the CTA.

**Keep the size flex.** "The whole game is X MB" lands. Size,
browser-not-console and no-install are all live angles.

**Audience: gamers, and attention generally.** Not a developer audience.

**The strategy is volume and variance.** Ship several different bets rather than
polishing one. Vary the ANGLE, not the palette.

## What actually went viral (2026-09-10 research pass — `viral.md`)

`viral.md` is the second research pass: specific posts with verbatim hooks and
numbers, 34 hooks adapted to Floored, accounts to copy. The rules it changes:

- **Lead with "is this real".** The one hook that works in BOTH the car niche
  (Forza/Assetto "this is a game please don't delete") and the AI niche
  (the "an AI one-shotted this game" post, 3.8M) is doubt about whether the
  footage is real. Dashcam-view frames are the ammunition.
- **"AI wrote it" and "no download" are the slide-2/6 TWIST, not the opener.**
  As openers they are claims; after a frame that fooled someone they are payoffs.
- **"Wait for it" is dead.** Documented. Use "slide 4 is why…" / "the last slide
  is the first slide" — a specific promise, not a vague one.
- **Night-drive niche conventions:** Nightcall, Déjà Vu, drift phonk, or
  engine-only "no music"; captions in lower case POV voice; rain, tunnel, tail
  lights, dashboard are the tropes. The game sits squarely in a niche that is
  huge — borrow its grammar.
- **Comment bait that is safe:** eurobeat vs phonk, cockpit vs chase, manual vs
  auto, name the car, rate the tunnel, tag a friend. A question in the caption
  is still the only measured comment lever (+26%).
- **Volume with variance beats polish.** `tools/tiktok-batch.mjs` takes a story
  list and makes fifty sets to pick from. Story lists live in a scratch dir while
  a batch runs; the ones worth keeping get copied into `docs/content/`.

Gaps the research admits: no verified AI-perspective game post exists yet (so
that angle is a bet, not a copy), and view counts come from third-party pages.

## What kills a set

1. A wall of text. One idea, 15 words max, per slide — auto-advance is ~2.5s.
2. Text under the right rail or in the bottom 500px.
3. Low contrast — white text straight onto a bright headlight bloom.
4. No hook on slide 1.
5. Reading as an ad. Show the work, not the product.
6. A visible watermark from another platform.

## Self-critique of the first 44 sets (2026-09-10, 11:40Z, before the frame library landed)

Measured, not felt: `27 distinct frames across 44 sets`, `hero-toll-plaza.png`
in 22 of them, `drone-low-front.png` and `hero-tunnel-in.png` in 15 each.
Every set passes "no repeats inside a set"; the FEED fails it. A viewer who
sees three posts has seen the toll plaza three times. Fixes, in order:

1. `tiktok-batch.mjs` now picks the globally least-used matching frame, and
   takes `--stories a.json,b.json` so one run covers the whole batch.
   Re-run everything once `lib/` has frames — do not patch sets one at a time.
2. The POV/dashcam grade is mud at slide size (grain + crush + vignette). It
   is the right frame ONLY when the point is "is this a dashcam" (sets 25, 26).
   Everywhere else prefer cockpit / hood / chase / orbit.
3. "Number-only" body slides ("2.", "3.") are lazy filler. They work for an
   open-loop count ("slide 4 is why…") and nowhere else; every other slide needs
   a line that earns the swipe.
4. Set 38 "find the bug" plants no bug — a viewer who looks will feel cheated.
   Rebuild it with a `vision` broken-on-purpose frame so there IS one.
5. The loop trick (slide 1 = slide N) is used in ~30 of 44 sets. It is right
   for TikTok's autoplay, but the closer needs a NEW line on the same frame,
   never the hook repeated.

## Numbers that went stale overnight (2026-09-10, 16:30Z)

- **Download size is 14.7 MB, not 19.** The 19 MB figure was true when it was
  first used; the release build measured 14.68 MB against the 15 MB cap. Five
  sets carried the old number. Re-measure before every post (`du -sh out/` on
  the static export) — a size claim is the easiest thing a commenter can
  disprove.
- **Corner radius is 68.1 m** (`game/world/corridor.ts`), not 68.2.
- **Wall restitution peaks at 0.42** (`game/physics.ts` `WALL.peak`).
- The vision "off" drone frame still draws the player box label; say "boxes
  off" only over the chase off-frame.
