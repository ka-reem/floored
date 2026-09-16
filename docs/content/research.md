# TikTok Photo Slideshows — Findings Report

Sourced research behind the slide spec and caption rules used by the Floored content pipeline.

**Compiled 2026-09-10.** For: solo dev promoting *Floored*, a browser-based Tokyo-expressway night-driving game.
**Purpose:** the evidence base for the pipeline's defaults. Confidence levels are marked. Gaps are marked as gaps.

---

## 0. How to read this report (source-quality warning — read this first)

The search space for "TikTok photo mode" is ~80% AI-generated SEO content farms
(reelbase.io, ghostshorts.com, usevisuals.com, instacarousel.com, posteverywhere.ai,
conbersa.ai, socialrails, tokportal, creou, reeldrift, slidestorm…). They recycle each
other's numbers with no methodology. I have tiered everything:

- **[A] Large-sample study or platform primary source.** Buffer, Metricool, Socialinsider, Sprout Social, TikTok's own ad docs, Game Developer / presskit.gg / Cloutboost for the games side.
- **[B] Credible practitioner / trade source**, plausible but unverified numbers.
- **[C] SEO content farm.** Directionally useful as a *consensus of what practitioners believe*, but treat every number as unsourced. I flag these explicitly.

**The single most important correction in this report:** the ubiquitous claim that
"TikTok Photo Mode gets 5x more reach than video" is almost certainly a **corrupted
inversion of a real statistic that says the exact opposite**. See §6.

---

## 1. IMAGE COUNT — the headline answer

### The answer

| | Value |
|---|---|
| **Platform maximum** | **35 images** per post |
| **Platform minimum for a carousel** | **2** (a single image posts as a photo post, not a carousel) |
| **Practitioner consensus optimal range** | **5–10 slides** |
| **Tighter consensus** | **6–8 slides** |
| **Recommended single default for this use case** | **8 slides** |

### The evidence

The 35-photo ceiling is consistent across every source and is the one hard number I am
fully confident in:
- https://wavegen.ai/tiktok-slideshow-size — "Up to 35 Photos"
- https://openclip.app/learn/tiktok-slideshow-size
- https://metricool.com/tiktok-slideshow/ [A] — "up to 35 images"
- https://www.socialinsider.io/blog/tiktok-carousel/ [A]
- https://www.reelcarousel.app/blog/tiktok-carousel-size — max 35, **min 2**

The optimal range — every source that gives one:

| Source | Recommended | Tier |
|---|---|---|
| Metricool https://metricool.com/tiktok-slideshow/ | 5–10 | A |
| Socialinsider https://www.socialinsider.io/blog/tiktok-carousel/ | 5–10 (min 2–3) | A |
| ReelCarousel https://www.reelcarousel.app/blog/tiktok-carousel-size | **5–8** | C |
| PostNitro https://postnitro.ai/blog/post/tiktok-carousel | 3–10 | C |
| UseVisuals https://usevisuals.com/blog/tiktok-carousel-post-best-practices | **4–8** | C |
| Conbersa https://www.conbersa.ai/learn/how-to-make-a-slideshow-on-tiktok | 5–15 | C |
| YouCanBuildThings https://youcanbuildthings.com/articles/tiktok-slideshow-formats-viral/ | **8–12** | C (outlier high) |

Median of all recommendations lands squarely on **~7**. The only source pushing 8–12 is
describing listicle/story formats ("5 mistakes that…"), which legitimately need more slides.

### Why 8, specifically

**The arithmetic is the real argument.** TikTok photo posts advance on a timer as well as
by swipe. Default dwell is **~2.5 seconds per image**
(https://www.flexclip.com/learn/edit-duration-of-photos-on-tiktok.html, [B]), with sources
citing 2.5–5s depending on mode
(https://socialrails.com/blog/how-to-make-slideshow-on-tiktok, [C]).

At 2.5–3s/slide:
- 5 slides = 12–15s → completes easily, but low total watch time per view. Weak reach signal.
- **8 slides = 20–24s → the sweet spot.** Comparable to a well-performing short video's watch time, still completable in one pass, and it loops back to slide 1 fast enough that a rewatch is cheap.
- 12 slides = 30–36s → completion rate starts falling off a cliff; you are asking for a 30-second commitment from a cold audience.
- 20+ slides = you are making a document, not a post.

**Structural argument:** 8 gives you exactly `1 hook + 6 content + 1 payoff/loop`, which is
the arc in §5 with no compression.

**Algorithmic argument:** the primary ranking signal for carousels is reported as
**swipe-through / completion rate** — what percentage of the slides the average viewer sees
(Sprout Social https://sproutsocial.com/insights/tiktok-algorithm/ [A] confirms carousels are
ranked on a swipe-through-rate signal analogous to video completion). Slide count is the one
variable you fully control that moves completion rate. Fewer slides = mechanically higher
completion. The trade-off is that fewer slides also = less total watch time. 8 is the knee of
that curve.

### Cited completion-rate benchmarks (treat as soft)

- "A healthy completion rate is 40–60% for carousels with 8+ slides" — https://usevisuals.com/blog/tiktok-carousel-algorithm-2025 [C]
- "Saves per view is your most important engagement metric for carousels; >3% strong, >5% exceptional" — https://usevisuals.com/blog/tiktok-carousel-post-best-practices [C]
- "Comments per view on carousels run higher than video — benchmark above 0.5%" — [C], multiple
- "Completion >35% + one engagement signal >1.5% graduates to a 5,000–10,000 viewer expansion pool" — [C], very specific and completely unsourced; **do not trust this number**, it smells fabricated

### ⚠️ HONEST GAP

**I could not find a single source with real A/B data linking slide count to completion rate
or reach on TikTok.** No study, no platform statement, no creator experiment with numbers.
The 5–10 range is *practitioner consensus*, well-supported by the timing arithmetic above and
consistent across independent sources, but it is not measured. The pipeline defaults to 8, and
**the account's own analytics settle it** (TikTok shows "photos viewed" and "total play time"
per post — https://www.socialinsider.io/blog/tiktok-carousel/), because first-party data beats
any of this.

### Practical rules for Floored

- **Default: 8.**
- **Range: 6–10.** Go to 6 when each slide is a big visual with almost no text; go to 10 only for a numbered list where the count is the promise ("10 things I…").
- **Exception — the pure before/after: 2–4 slides.** This is its own format and works short.
- **Never above 12.**
- **Never 5 slides of which 2 are a title card and a CTA.** Every slide must earn its place.

---

## 2. DIMENSIONS AND SAFE ZONES

### Canvas

| Spec | Value | Confidence |
|---|---|---|
| **Recommended dimensions** | **1080 × 1920 px** | High — universal |
| **Aspect ratio** | **9:16** (native, no letterboxing) | High |
| Also supported | 1:1 (1080×1080), 4:5 (1080×1350) — but these get pillar/letterboxed | Med |
| Minimum resolution | 720 × 1280 | Med |
| Max file size per image | ~20 MB | Med |
| Max total post size | 500 MB | Med |
| Formats | JPG / JPEG / PNG (WebP reported) | High |
| Colour space | **sRGB** — avoid P3/CMYK (colours shift) | Med |
| Practical per-image target | 300 KB – 2 MB | Low/[C] |

Sources: https://metricool.com/tiktok-slideshow/ · https://www.socialinsider.io/blog/tiktok-carousel/ ·
https://www.reelcarousel.app/blog/tiktok-carousel-size · https://picturesizes.com/specs/social-media/tiktok/

**Use 9:16 / 1080×1920. Anything else wastes screen and is a self-inflicted wound.**

### Safe zones — sources conflict, here is the reconciliation

Four independent sets of numbers, all on a 1080×1920 canvas:

| Source | Top | Bottom | Left | Right | Safe area |
|---|---|---|---|---|---|
| **A** — most-repeated set, appears to trace to TikTok's own ads creative guidance (https://rightblogger.com/blog/tiktok-safe-zone-template, https://www.recharm.com/blog/tiktok-video-ad-specs, https://houseofmarketers.com/guide-to-safe-zones-tiktok-facebook-instagram-stories-reels/, https://zeely.ai/blog/tiktok-safe-zones/) | 130 | **484** | 44 | 140 | 896 × 1306 |
| **B** — https://adchecklab.com/articles/tiktok-safe-zone-dimensions-2026 | **200** | 334 | 86 | 140 | 854 × 1386 |
| **C** — https://creamate.ai/en/blog/tiktok-safe-zone-guide (conservative preset) | 140 | 400 | 60 | **180** | 840 × 1380 |
| **D** — **carousel-specific**, https://www.reelcarousel.app/blog/tiktok-carousel-size | 200–250 | 400–500 | — | 150–200 | ~880 × 1300 starting ~250 from top |

**They agree on the right rail (~140–180 px) and disagree on top and bottom.** The disagreement
is real, not sloppiness: TikTok itself says the safe zone *varies with caption length, format
and add-ons* (https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads). A 2-line caption
and a 5-line caption produce very different bottom overlays.

### The recommendation: the conservative union

Take the worst case from every source. **This is the box the pipeline bakes in:**

```
Canvas            1080 × 1920
Top inset          200 px   (10.4%)
Bottom inset       500 px   (26.0%)
Left inset          90 px   ( 8.3%)
Right inset        180 px   (16.7%)
─────────────────────────────────────
SAFE BOX          810 × 1220 px
Safe box origin   x = 90 … 900,  y = 200 … 1420
```

Nothing load-bearing — hook text, CTA, the URL, a logo, a measurement callout — goes outside
that box. Background art can and should bleed to all four edges.

### What is actually sitting in each region

**Top band (0 → ~200 px):** device status bar (clock, battery, notch/Dynamic Island), TikTok's
`Following | For You` tab switcher, the search icon, LIVE badge.
**Photo-mode extra:** a **photo counter ("1/8") in the top-right corner** — this does *not*
exist on video posts and is routinely missed. Keep the top-right ~200×120 px clear.
(https://www.kapwing.com/resources/how-to-post-photos-and-carousels-on-tiktok-with-photo-mode/)

**Right rail (~900 → 1080 px, i.e. rightmost 140–180 px, roughly y = 900 → 1700):** creator
avatar + follow button, like heart, comment, bookmark/save, share, and the spinning sound disc.
Right-aligned text is the single most common casualty.

**Bottom band (~1420 → 1920 px):** in order going up from the bottom — the app navigation bar,
then the caption block (username, caption text, hashtags — expands with caption length), the
sound/music marquee, and **for carousels, the pagination dots**, which sit above the caption.

**Photo-mode-specific summary:** carousels have **two** UI elements video does not — the
top-right `n/N` counter and the bottom pagination dots. Both eat into zones people assume are free.

### Practical layout rule for Floored

- Put hook text in the **upper-middle**: roughly `y = 260 → 700`, horizontally centred, max width ~810 px. Above the right rail entirely, below the tab switcher, and it is the first thing the eye lands on.
- Never bottom-align text. The bottom quarter is TikTok's.
- Never right-align text.
- If you need a lower caption line, keep it above `y = 1400` and left of `x = 880`.
- **Verify by screenshotting a real post on a real phone.** Every source, including TikTok, says the safe zone is device- and caption-dependent. One 30-second check beats any table.

---

## 3. CAPTION / TEXT-OVERLAY STYLE

### What actually dominates

The obvious instinct — **white text with a black surround** — is correct and is the
consensus recommendation. "White with black outline works for 90% of content"
(https://blitzcutai.com/blog/best-caption-style-tiktok, [C]);
"White text with a dark stroke, shadow, or solid background is a safe starting point…
because it survives changing footage better than subtle colour choices"
(https://digitalzoomstudio.net/2026/06/text-overlays-for-reels-and-tiktok-what-actually-works-in-2026/, [B]).

**Three distinct treatments, and they are not interchangeable:**

**1. Native TikTok text — white on a solid rounded black/coloured pill.**
Applied inside the app. Reads as native, authentic, "a person made this on their phone."
Guaranteed legible because the background is opaque. Cost: it covers the image.
**Best for:** the hook slide, and any slide where the text *is* the content.

**2. CapCut-style heavy stroke — bold white sans-serif with a thick black outline, no box.**
Currently the dominant *look* on short-form. Lets the image show through completely.
Cost: on a busy or high-contrast image (headlight bloom, neon signs, wet asphalt reflections —
i.e. **exactly what Floored looks like**) a stroke alone can still get lost.
**Best for:** slides where the screenshot is the star.

**3. Semi-transparent black bar/scrim behind the text.**
The most reliable of the three. A ~55–70% black rounded rect or a bottom-up gradient scrim,
white text on top. Recommended explicitly by the readability-first sources
(https://overlaytext.com/blog/text-overlay-for-reels-tiktok-viral-templates,
https://digitalzoomstudio.net/2026/06/…). Slightly less "native" but never fails.

### 👉 Judgement for Floored

**Use (1) native-style pill or (3) scrim for the hook slide, and (2) heavy stroke for content slides.**

Reason: Floored is a *night* game. Dark, high-contrast, bright specular highlights, neon.
A pure stroke over a headlight bloom or a lit sign is where white-on-white failures happen.
A dark scrim also visually agrees with the game's palette rather than fighting it. And there is
a bonus: on a mostly-dark frame, a **white text block is itself the brightest object**, which is
its own scroll-stopper.

Do **not** add a white outline to white text. Do not use drop shadow alone on a dark image
(shadow on dark = invisible shadow = no separation).

### Concrete type specs (1080 × 1920)

| Element | Size | Notes | Confidence |
|---|---|---|---|
| **Absolute minimum readable** | **36 px** | anything below is illegible at arm's length on a 6" phone | Med [B] |
| **Body / content-slide text** | **48–60 px** | | Med [B] |
| **Hook slide headline** | **72–110 px** | "48–72px for primary text" is the cited floor; go bigger on slide 1 | Med [B] |
| Secondary / attribution | 32–40 px | | Med [B] |

Sources: https://www.rocketshiphq.com/text-overlays-video-ads-mobile/ ·
https://digitalzoomstudio.net/2026/06/text-overlays-for-reels-and-tiktok-what-actually-works-in-2026/ ·
https://legibility.info/rules-for-text-in-videos

**Weight and face:** bold / heavy sans-serif. Named recommendations: **Anton, Bebas Neue**,
and generally condensed heavy grotesques. TikTok's native editor has no bold button — you
simulate it with the "Heavy" font plus outline width
(https://blitzcutai.com/blog/best-caption-fonts-tiktok).

**Word counts — this is where most slideshows die:**
- **Hook slide: 5–8 words maximum.** Multiple sources converge here. Under 10 words absolutely.
- **Content slides: one idea, ≤15 words, ideally one short sentence.**
- **The 3-second test:** if a slide takes longer than ~3 seconds to read, it gets skipped ([C], repeated everywhere, and it matches the 2.5s auto-advance — so it is arithmetically true, not just folk wisdom).
- Line length: 2–3 lines max, break lines by meaning not by width.

**Position:** hook text in the **upper-middle / centre**, per §2. The cited claim is that
opening-frame text is *"roughly 10× more important than any other overlay"*
(https://digitalzoomstudio.net/2026/06/…, [B]).

### The SEO reason to burn text into the image

TikTok runs **OCR on on-screen text and treats it as searchable metadata**, and on-screen text
is reported to be weighted **more heavily than caption-only keywords**
(https://seosherpa.com/tiktok-seo/, [B]; corroborated by Sprout Social's ranking-signal list,
https://sproutsocial.com/insights/tiktok-algorithm/, [A], which lists on-screen text and
captions under "Video information").

**Practical consequence:** the words "Tokyo", "expressway", "racing game", "browser game",
"night driving", "solo dev" should appear as *rendered text on slide 1 or 2*, not only in the
caption. One [B] source claims optimised text overlays get "up to 8× more search impressions
over 30 days" — treat the multiple as marketing, the mechanism as real.

---

## 4. THE HOOK (slide 1)

### Why it matters more here than on video

On a video, a bad hook loses you at 1–2 seconds. On a slideshow, slide 1 is a **static image
that has to survive being looked at**, with no motion, no sound cue, no cut. It is also the
thumbnail. TikTok for Business research cited widely: **63% of videos with the highest CTR hook
viewers within the first three seconds** (https://www.opus.pro/blog/tiktok-hook-formulas, [B]).

Cited hook data (all [B]/[C] — directionally useful, numbers unverified):
- Hooks containing **a specific number** → **37% higher completion rates** than generic openings
- Hooks **under 2 seconds** (≈5–12 words) → **23% higher completion** than 4–5 second hooks
- Verbal hook + **visual pattern interrupt** → **47% higher 3-second retention** than words alone
(https://www.socialgrowthengineers.com/viral-solos-founders-50-viral-hook-patterns-content-market-fit)

### The reusable patterns

1. **Curiosity gap / open loop** — state an outcome, withhold the mechanism.
2. **Specific number + sacrifice** — "I spent X so you don't have to." Specificity is the whole trick; `400 hours` beats `a long time`.
3. **Contrarian / challenge a belief** — "Everyone says X. Wrong."
4. **Confession / self-deprecation** — lowers defences, invites comments. Extremely strong for dev content.
5. **Identity call** — name the viewer's tribe.
6. **Before/after promise** — the transformation is the hook.
7. **Direct visual flex + one-line frame** — let a genuinely good screenshot be the hook, text just frames it.
8. **Question / opinion bait** — Metricool [A]: **posts that include a question get 26.19% more comments** (https://metricool.com/press-release-tiktok-study-2026/). This is one of the few *measured* numbers in this whole report.
9. **Numbered list promise** — "8 things…" sets an explicit completion target, which is the completion-rate hack.
10. **Impossible-claim / format flex** — "this runs in a browser" is genuinely surprising to most people.

### 15 hook lines, written for Floored

Use verbatim or adapt. Each is ≤8 words where possible, and each is a promise the rest of the set must actually keep.

1. **"This is a browser tab. Not a console."**
2. **"I spent 400 hours on a road you'll drive past."**
3. **"Nobody asked for the Shuto Expressway at 2am."**
4. **"My headlights were wrong for six months."**
5. **"Everyone says browser games look cheap. Swipe."**
6. **"The reflections are fake. Here's the trick."**
7. **"Rate my rain. Be brutally honest."**
8. **"Before → after. Three lines of code."**
9. **"I deleted 90% of the lights. It looked better."**
10. **"Day 112 of building a racing game alone."**
11. **"This bug shipped. 4,000 people drove it."**
12. **"8 screenshots. One year. No team."**
13. **"Which car ships? You pick."**
14. **"The first version. Please don't laugh."**
15. **"Tokyo, 3am, 180km/h — no download required."**

**Notes on these:**
- #1, #5, #15 lead on the *format flex* (browser game). This is Floored's single most under-used hook and probably its best cold-audience opener — most people do not believe a browser can do this.
- #7, #13 are **question hooks** — deploy these when you want comments (the +26.19% number).
- #4, #9, #11, #14 are **confession hooks** — highest trust, best for building a returning audience rather than raw reach.
- #2, #10, #12 are **number hooks** — the +37% completion pattern.
- Rule: **never write a hook the set does not pay off.** Bait-and-switch is explicitly named as a top-5 slideshow killer (https://www.slidestorm.ai/articles/tiktok-slideshow-watch-time-mistakes).

---

## 5. STRUCTURE / ARC ACROSS SLIDES

### The base arc

**Hook → Context → Escalation → Payoff → Loop/CTA.**
(https://www.influencers-time.com/carousel-style-tiktoks-why-slideshows-beat-video-on-watch-ti/, [C];
consistent across sources.)

Mapped onto the recommended 8 slides:

| Slide | Job | Floored example |
|---|---|---|
| 1 | **Hook.** 5–8 words, biggest text, ~80% of your design effort. Also the thumbnail. | "My headlights were wrong for six months." |
| 2 | **Context / the problem.** Show the bad state. | the old flat-cutoff headlight pool, marked up |
| 3–6 | **Escalation.** One idea per slide. Each slide should make the next one more wanted. | the diagnosis, the fix, a measurement, the new falloff |
| 7 | **Payoff.** The best-looking frame in the whole set. Full-bleed, minimal text. | the money shot: wet asphalt, headlight falloff, neon |
| 8 | **Loop / CTA.** | see below |

### The three proven format archetypes

From https://youcanbuildthings.com/articles/tiktok-slideshow-formats-viral/ [C] — the taxonomy
is sound even if the numbers aren't:

- **Numbered list** → generates the most **saves**. The number is a completion contract.
- **Comparison / before-after pairs** → generates the most **shares** (people tag friends).
- **Story reveal** (chronological, building to a payoff) → **highest completion rates**.

For a dev account, story-reveal and before/after are your bread and butter; numbered lists are
your save-farming format.

### The last slide

Three options, in order of my preference for this use case:

**1. The loop (best for reach).** *"A loop is when the last slide visually or textually connects
back to the first, making people want to rewatch it."* TikTok photo posts auto-advance and cycle,
so the last slide sits adjacent to the first. If slide 8 re-poses slide 1's question, or is the
*same frame* as slide 1 now that the viewer understands it, the viewer re-enters at slide 1
instead of scrolling. This mechanically multiplies watch-percentage: a set viewed 3× yields 300%
watch percentage vs 100% for a longer set viewed once
(https://slidycreator.com/blog/what-is-looping-video/, [B]).

*Floored implementation:* slide 1 is the fixed shot with the bad lighting and the text
"My headlights were wrong for six months." Slide 8 is **the identical camera framing, fixed**,
with the text "…here's six months later." The eye snaps between them on loop.

**2. The payoff-plus-soft-ask.** Best frame + one short line. `"Playable free in your browser — link in bio."`

**3. The question (best for comments).** `"Which corner should I rebuild next?"` — leans on the
measured +26.19% comments figure.

**Never end with:** a bare logo, a bare "follow me", or nothing at all. "The weak, pointless
ending" is one of the five named slideshow killers
(https://www.slidestorm.ai/articles/tiktok-slideshow-watch-time-mistakes).

### Pacing

- Match slide duration to reading time: a few words → 1–2s; a short sentence → 2–3s.
- **Sync slide changes to the beat of the audio.** Put your payoff slide on a beat drop. Named explicitly as a fix for the pacing mistake, same source.
- Visual consistency across slides — same font, same text position, same treatment. It reads as one artefact and makes the swipe feel rhythmic.

---

## 6. SLIDESHOWS VS VIDEO — the big correction

### The myth

Dozens of pages assert **"Photo Mode gets 5x more reach than video"** and "creators report 2–5x,
some 10x". Examples:
https://reelbase.io/blog/tiktok-photo-mode-algorithm-explained ·
https://ghostshorts.com/blog/tiktok-photo-mode-algorithm-2026 ·
https://instacarousel.com/blog/tiktok-carousel-photo-mode-2026/ — all tier [C], all sourceless,
all published 2026, all repeating each other.

### What the large-sample data actually says

**Metricool 2026 TikTok Study** [A] — **2,314,756 posts from 92,000+ accounts**, Jan–Feb 2025 vs
Jan–Feb 2026 (https://metricool.com/press-release-tiktok-study-2026/):

> **"Videos remain TikTok's strongest format, generating 5x more reach and 6x more interactions
> than images or carousels."**

> Image/carousel posts **grew ~140% in volume year over year**, but **per-post views dropped 23%
> and interactions fell 62%**.

**Buffer, March 2026** [A] (https://buffer.com/resources/data-best-content-format-social-media/),
millions of posts:

> TikTok **video: 3.39%** median engagement rate. TikTok **carousels and photos: 1.92%**.
> **Video outperforms by 77%.**

**Note the shape of the error:** Metricool says *video gets 5x more reach than images*. The
content farms say *images get 5x more reach than video*. **The "5x" figure has been inverted.**
That is my read on where the myth came from, and I'd bet on it.

Also worth flagging as *cross-platform* context from Buffer [A]: Instagram carousels do 6.9%
engagement and LinkedIn PDF carousels 21.77% — **carousels genuinely are a strong format, just
not on TikTok.** That is very likely how the confusion spread.

One dissenting [A]-adjacent datapoint: Socialinsider cites Youthforia's carousels getting
**11% higher reach** than their typical video posts, and a Shark Tank carousel at **6.6M views**
(https://www.socialinsider.io/blog/tiktok-carousel/). So carousels *can* outperform for a given
account — that is a brand-storytelling account, not a games account.

### 👉 Judgement

**Photo mode is NOT algorithmically favoured on TikTok in 2026. It is, by the two largest
available samples, the weaker format on that platform — and getting weaker as supply floods in.**

That does **not** mean don't use it. It means use it for the right reasons:

**Use photo mode when:**
- The content is **inherently comparative or enumerable** — before/after, N things, a progression, a spec sheet. Swiping is genuinely the right interaction.
- You have **great stills but no good video**. A crisp screenshot beats a shaky 15fps screen capture. For a *visually gorgeous* game like Floored this is a real advantage — a still holds up to scrutiny where compressed motion does not.
- You want **saves and comments** rather than raw views. Carousels reportedly over-index on comments-per-view and saves, and under-index on shares (Fanpage Karma: carousel shares ~⅓ lower than video, cited [C]).
- **Production cost.** 8 screenshots + text is 20 minutes. A good 20-second video is hours. For a solo dev on a 1–2 hr/week marketing budget (presskit.gg's number), that ratio is the whole argument.

**Use video when you want reach.** For Floored specifically, **motion is the product** — a
night-driving game's appeal is largely in the motion of light. Photo mode structurally cannot
show your best asset.

**Recommended mix: video-first, slideshows as the cheap high-frequency filler and for
explicitly comparative content.** Roughly 1 slideshow to every 2 videos.

### Broader reach context for games (sobering, [A])

From Cloutboost (https://www.cloutboost.com/blog/tiktoks-changing-landscape-for-game-marketing-in-2026-what-developers-need-to-know):
- Average organic reach for gaming accounts: **~15–20% in 2024 → 4–8% by early 2026.**
- Owlcat Games, same creator: **425.8K views in June → 6K views in November** (~98.6% drop).
- For **85–90% of creators tested**, **YouTube Shorts and Instagram Reels delivered significantly higher organic reach than TikTok.**
- Metricool [A] corroborates the platform-wide decline: video views **−31.30%**, reach **−28.73%**, interactions **−31.17%** YoY.

**Implication for the pipeline:** whatever gets built should be **format-portable**. Render the same
8 images and post them to TikTok photo mode, IG carousel (where carousels do 6.9%), and as a
Shorts/Reels slideshow. Do not build TikTok-only. And **strip the TikTok watermark before
cross-posting** — competing-platform watermarks are algorithmically suppressed
(https://presskit.gg/field-guides/tiktok-indie-game-marketing).

---

## 7. SOUND, DESCRIPTION, HASHTAGS

### Sound

- **Always attach audio.** Sound is a discovery surface: a slideshow on a rising audio can ride that audio's momentum onto more For You placements. Sprout Social [A] lists sounds as a ranking signal.
- **Trending > perfect fit, but only just.** Game Developer [A] (https://www.gamedeveloper.com/business/tiktok-guide-for-indie-game-devs) is blunt: trending songs "provide boosts but aren't mandatory."
- **Match the vibe.** Mismatched audio tone is one of the five named slideshow killers. For Floored the obvious lane is **night-drive / city-pop / phonk / lo-fi** — which is also a *huge* TikTok audio niche in its own right and a genuine discovery channel. Audio-genre alignment here is unusually valuable: the audience for a Tokyo-at-night aesthetic already exists and is sorted by sound.
- **Audio plays through the whole carousel** while the viewer swipes, so pick a track whose structure supports 20–24s and put the payoff slide on a beat.
- ⚠️ The claim **"photo mode without audio gets 70% less reach"** ([C], reelbase) is **unsourced and I would not repeat it.** Directionally: yes, attach audio. The number is invented.
- Commercial caveat: business/brand accounts are restricted to the Commercial Music Library. A personal creator account is not.

### Description / caption

- **Character limit: 4,000** (up from 300 → 2,200 historically). Sources vary between 2,200 and 4,000 — 4,000 is the current figure from the more recent sources (https://typecount.com/blog/tiktok-caption-character-limit).
- **Only ~100–150 characters show before the "more" cut.** First two lines carry all the weight.
- **Longer captions are recommended for carousels specifically — 200+ characters.** ([C] consensus + Socialinsider [A] "over 200 characters recommended"). Rationale: caption text is search-indexed and carousels have less other signal to give the algorithm.
- **Keywords beat hashtags for discovery in 2026.** "Keyword-rich captions outperform hashtag-heavy posts for discoverability" — Sprout Social [A] lists captions under "video information" ranking signals. Write for TikTok search: *"browser racing game", "Tokyo expressway", "night driving game", "solo indie dev", "no download"*.
- **Put a question in it.** Metricool [A], measured: **+26.19% comments.**

### Hashtags

**This changed and most guidance is stale.** In **August 2025 TikTok imposed a 5-hashtag cap** —
you can type more, but **only the first five are registered by the algorithm**
(https://www.socialmediatoday.com/news/tiktok-implements-five-hashtag-limit-per-post/757857/ [A];
corroborated https://www.heylist.com/academy/tiktoks-new-5-hashtag-limit-what-creators-and-brands-need-to-know).

- **Use 3–5. Never more.** Anything beyond 5 is dead weight that clutters the caption.
- They still matter, measurably: Metricool [A] — **posts with ≥1 hashtag get ~5% more views and >9% more interactions**, and hashtag-driven traffic **grew 114% YoY**. Modest but real, and free.
- **Mix broad + niche.** presskit.gg [A] notes TikTok favours niche tags for this vertical.
- Suggested set for Floored: `#indiedev #gamedev #indiegame` + one aesthetic/topical tag
  (`#tokyo`, `#nightdrive`, `#jdm`, `#browsergame`) + one branded (`#floored`).
  Rotate the 4th slot per post to match the specific content.

### Timing

- Metricool [A]: peak engagement window **6–9 pm, with 8 pm the single peak hour.**
- Sprout Social [A]: "midweek afternoons and evenings, 2–6 pm."
- These conflict; both are global aggregates and neither beats your own analytics.
- Metricool [A], useful: posts reach **96% of total reach and ~98% of total interactions within the first 10 days.** So a post is essentially dead after ~10 days — but that also means a 10-day tail exists, which is longer than most people assume.

---

## 8. WHAT KILLS A SLIDESHOW

Primary source for the taxonomy: https://www.slidestorm.ai/articles/tiktok-slideshow-watch-time-mistakes
and https://www.slidestorm.ai/articles/5-biggest-mistakes-new-tiktok-slideshow-creators-make [C],
corroborated across sources. The failure modes are consistent enough that I'm confident in the list
even though the source tier is low.

**Fatal:**

1. **The wall of text.** A paragraph on a slide is homework, not a post. Viewers cannot finish it before auto-advance and their thumb has already moved. → One idea, ≤15 words, per slide.
2. **No hook / a weak slide 1.** Slide 1 is also the thumbnail. If it doesn't work as a standalone image, nothing else matters.
3. **Bait-and-switch.** Shocking claim on slide 1 that the set doesn't deliver. Destroys trust and tanks your account-level signal, not just the post.
4. **Text under the UI.** Right-aligned text under the action rail; bottom-aligned text under the caption block; anything in the top-right under the `n/N` photo counter. Silent, total, and invisible to you because *your own* preview doesn't show the overlay.
5. **Low contrast.** White stroke text over headlight bloom / bright neon / a white car. Endemic to a night-driving game with high dynamic range. → scrim or pill on the hook slide.
6. **The pointless ending.** No loop, no payoff, no ask. Wastes the completion you earned.

**Also damaging:**

7. **Reads as an ad.** Polished marketing beats work *worse* than WIP on this platform. presskit.gg [A] is explicit: "authenticity" and "imperfections (programmer art, placeholder sounds, janky animations)" drive engagement; work-in-progress clips often outperform polished marketing.
8. **Watermarks from other tools/platforms** — and specifically, a **TikTok watermark on a cross-post to Reels/Shorts is algorithmically suppressed** ([A], presskit.gg).
9. **Pacing mismatch** — 5s on a three-word slide (boring), or 1s on a sentence (unreadable).
10. **Audio/visual tone mismatch.**
11. **Inconsistent design between slides** — text jumping position slide to slide breaks the swipe rhythm.
12. **Too many slides.** See §1. Every slide past ~10 is a chance to lose someone.
13. **Off-platform links pushed too hard.** TikTok does not love sending people away. "Link in bio" once, on the last slide, not on every slide.
14. **Wrong colour space / low-res source.** P3 screenshots shift on upload; sub-720p gets crushed by TikTok's compression. Export sRGB at 1080×1920.

---

## 9. GAME-DEV / INDIE-DEV SPECIFIC

### Angles that demonstrably work

From presskit.gg [A] (https://presskit.gg/field-guides/tiktok-indie-game-marketing) and
Game Developer [A] (https://www.gamedeveloper.com/business/tiktok-guide-for-indie-game-devs):

| Angle | Why it works | Slideshow-friendly? |
|---|---|---|
| **Before / after** | Transformation is self-explanatory, needs no context. Use **hard cuts, not fades**, and lead with the most dramatic improvement. | ★★★ ideal |
| **Bugs and glitches** | *"Bugs and glitches are some of the best-performing game dev content."* Physics failures, stretched models, pathfinding disasters. | ★★☆ better as video, but a bug-compilation carousel works |
| **"Day X of making a game"** | Serialised, builds narrative momentum. Needs ≥2×/week consistency to work. | ★★★ ideal |
| **Devlog progress clips (15–30s)** | Authenticity and visible imperfection outperform polish | ★★☆ |
| **Satisfying mechanic on loop** | Best for physics/building/idle. | ★☆☆ video only |
| **Dev-tool / how-it's-made** | Shader breakdowns, editor views. Nerd-bait, high saves. | ★★★ ideal — the "here's the trick" carousel |
| **Numbers / measurements** | Specificity is the hook. "400 hours", "3 lines of code", "90% fewer lights". | ★★★ |
| **Dev talking to camera** | *"The highest-performing game dev TikToks usually feature the developer talking to camera."* | ✗ video only — but this is the strongest single finding on the games side, and it argues for not being slideshow-only |

**Things TikTok is bad for (presskit.gg [A]):** text-heavy RPGs, strategy games, narrative titles,
anything targeting 35+. **Floored is well-suited** — it's a visual, instantly-legible, single-loop
game whose appeal reads in one frame. It sits in the "strong visual hooks and stylised aesthetics"
bucket that Cloutboost [A] names as the best performer.

### Cadence and effort

- **2–3 posts/week** (presskit.gg [A]); **3 minimum, 4–5 optimal** (Cloutboost [A]).
- **1–2 hours/week is a sustainable budget.** Workflow: capture during development → batch-edit weekly → post 2–3×/week → cross-post.
- Game Developer [A]: *"every post is a new ticket in the TikTok lottery"* — follower count barely matters; every post is judged fresh. This is genuinely good news for a zero-follower account.

### Named accounts / case studies

**Documented and worth studying:**
- **YAPYAP** — first announcement video **1.5M views**; entered Oct 2025 Steam Next Fest 3rd most-played demo, exited #2. Key insight from presskit.gg: **community-made content outperformed the developer's own TikToks.**
- **A Webbing Journey** (Future Friends Games) — dev team posts **daily**, ~**150k followers**. Also the source of the documented organic-reach decline in late 2025.
- **Shotgun Farmers** — **1.4M followers**, credited with an Xbox chart climb. The canonical indie-TikTok success story.
- **Clone Drone in the Danger Zone** — 23,000 followers in ~3 months.
- **Cloud Gardens** — 9,000 followers in under a week.
- **Quarantine Zone** — a single streamer's pre-demo playtest TikTok hit **30M views**.
- **Fruit Mountain** (BeXide) — **#FruitMountain: 87.9M views**, driven by TikTok *Live* streamers, not the dev.
- **@SammyC_TV** — streamer, 24k followers, more engagement on TikTok Live than Twitch.

⚠️ **Gap:** I could **not** find a well-documented indie-game account whose growth came
specifically from **photo mode / slideshows**. Every named games case study above is video or
Live. The slideshow-specific case studies found (Youthforia 6.6M, and the personal-finance
creator at 127k views in 72 hours) are from other verticals. **This caveat travels with the
defaults.** A slideshow workflow for Floored is, as far as this research can tell, ahead of
documented practice in this vertical rather than a copy of a proven playbook.

### The under-used angle for Floored

**"It's a browser game" is the strongest and least-used hook available.** Every source says
pattern interrupt + surprising claim is the top hook category, and "console-looking night racer,
zero download, one tap" *is* a genuine surprise. It also removes the single biggest friction in
indie game marketing — the install step. A CTA that says "you can play this in 5 seconds, right
now, on the phone you're holding" converts at a rate a Steam wishlist ask never will.

---

## 10. OTHER EVIDENCE-BACKED LEVERS

1. **Ask a question in the caption. +26.19% comments.** Metricool [A], measured on 2.3M posts. The cheapest win in this document.
2. **Use at least one hashtag. +~5% views, +>9% interactions.** Metricool [A]. Cap at 5.
3. **Post 6–9 pm, peak 8 pm.** Metricool [A]. Conflicts with Sprout's 2–6 pm [A]; both are aggregates, override with your own data.
4. **A post's life is ~10 days** (96% of reach, 98% of interactions land inside it) — Metricool [A]. Don't judge a post at 24 hours; don't expect a tail past two weeks.
5. **Cross-post everything, watermark-free.** For 85–90% of creators tested, **Shorts and Reels beat TikTok on organic reach** in late 2025/2026 (Cloutboost [A]). The same 8 images work on all three plus an IG carousel — and IG carousels do **6.9%** engagement vs TikTok's 1.92% (Buffer [A]). *For a carousel specifically, Instagram may be the better primary platform and TikTok the secondary.* That is a genuine strategic finding.
6. **Optimise for saves and comments, not likes.** Sprout [A]: saves and shares "outweigh simple Likes by a significant margin." Carousels naturally over-index on saves/comments and under-index on shares — lean into the strength.
7. **Burn keywords into the image, not just the caption.** OCR-indexed and reportedly weighted above caption-only keywords ([B]).
8. **Design slide 1 as a thumbnail first.** It is doing double duty — feed thumbnail and hook. Judge it at gallery size.
9. **Community content beats dev content.** The YAPYAP finding [A]. Anything that makes Floored easy for *other people* to post (a shareable moment, a distinctive visual signature, an easy screenshot key) is worth more than another dev post.
10. **Volume over polish.** Game Developer [A] is explicit: prioritise quantity; each post is an independent lottery ticket. This is the strongest argument for slideshows in the mix — they cost ~20 minutes.

---

## Appendix A — Pipeline defaults (the short version)

```yaml
canvas:        1080 x 1920 px, 9:16, sRGB, JPG/PNG
slides:        8   (range 6-10; before/after 2-4; never >12)
safe_box:      x 90..900, y 200..1420   # 810 x 1220
                # avoid: top-right n/N counter, right rail (180px),
                #        bottom 500px (dots + caption + nav)
hook_text:     5-8 words, 72-110px, heavy sans (Anton/Bebas),
               white on 60% black scrim or pill, upper-middle (y 260..700)
body_text:     <=15 words, 48-60px, white + heavy black stroke
slide_dwell:   2-3s   -> ~20-24s total
arc:           hook / problem / 4x escalation / payoff / loop
last_slide:    loop back to slide 1 framing  (or question, or soft CTA)
audio:         always. night-drive/city-pop/phonk. payoff on the beat.
caption:       200+ chars, keyword-rich, hook in first 100 chars, ends with a question
hashtags:      3-5 max (hard cap since Aug 2025)
post_time:     18:00-21:00 local (peak 20:00)
cross_post:    IG carousel + Reels + Shorts, watermark stripped
```

## Appendix B — Confidence summary

| Claim | Confidence |
|---|---|
| 35-image max, 2 min, 1080×1920 9:16 | **High** |
| Right rail ~140–180px must be kept clear | **High** |
| 5-hashtag cap since Aug 2025 | **High** [A] |
| Video > photo on TikTok reach/engagement (2026) | **High** [A] ×2 independent large samples |
| Question in caption → +26.19% comments | **High** [A] measured |
| Optimal slide count 5–10, default 8 | **Medium** — strong consensus + sound arithmetic, **no A/B data exists** |
| Exact top/bottom safe-zone insets | **Medium** — sources conflict 130–200 top, 334–500 bottom; TikTok says it varies. Use the conservative union. |
| Font size bands (36 min / 48–72 body / 72–110 hook) | **Medium** [B] |
| White-on-dark-scrim > stroke for a night game | **Medium** — judgement call, from first principles, not from data |
| The loop technique drives rewatches | **Medium** — mechanism is sound, no TikTok-specific measurement found |
| "Photo mode gets 5x reach" | **False** — inverted stat, see §6 |
| "No audio = 70% less reach" | **Unverified, likely fabricated** |
| "Completion >35% + 1.5% engagement → 5–10k expansion pool" | **Unverified, likely fabricated** |
| A proven indie-game slideshow playbook exists | **No evidence found** — genuine gap |
