# docs/content

Notes and research for the content pipeline: rendered Floored frames in, postable
1080x1920 slide sets out.

## The files

- **`spec.md`** — the working spec. Canvas and safe-zone numbers, type scale, the
  story arc, frame sourcing, and the field notes from sets already shipped.
- **`research.md`** — the sourced findings the spec's numbers come from, tiered by
  source quality, with a confidence table at the end.
- **`viral.md`** — a second pass on what actually performed: verbatim hooks, post
  structures, sounds, comment bait, and accounts worth copying.

## The tools

- `test/hero-shots.mjs` — captures content frames at the quality ceiling (HIGH
  preset, DESKTOP tier, HUD off, 2x).
- `test/hero-orbit.mjs` — photo-mode orbit angles of the car, for variety a
  forward-facing driving camera cannot give.
- `tools/tiktok-slides.mjs` — composites one set from a JSON spec:
  `node tools/tiktok-slides.mjs --spec set.json --out dir/`
- `tools/tiktok-batch.mjs` — the same thing across a story list, picking the
  globally least-used frame so sets do not repeat across the feed.

## Output

Source frames come from `test/artifacts/` and `docs/gallery/img/`. Finished slides
are numbered PNGs written to whatever `--out` directory is given; they are not
committed.
