/* TikTok slide compositor — game frames in, postable 1080x1920 PNGs out.

   The posting workflow is to screenshot the slide and post it, so the text has
   to be BURNED IN and the frame has to already respect TikTok's overlays. See
   docs/tiktok-slides.md for why each number is what it is, and the sources
   behind them.

   Two decisions worth knowing before you change anything:

   LETTERBOX, NOT KEYHOLE. The game renders 16:9 and TikTok is 9:16. Cropping a
   landscape frame to 9:16 throws away ~68% of the width, which for this game is
   the skyline and the road ahead — the two things worth showing. So the frame is
   laid full-width over a blurred, over-scaled copy of ITSELF. The fill reads as
   deliberate, the composition survives, and the blur carries the frame's own
   colour so the slide still looks like one image rather than a photo on a slab.

   SCRIM, NOT BARE STROKE. CapCut's default is white text with a heavy stroke.
   That fails over exactly the pixels this game is full of — headlight bloom, wet
   asphalt highlights, neon. Every text block gets a soft dark scrim sized to the
   text, and the stroke stays as a second line of defence.

   Usage: node tools/tiktok-slides.mjs --spec set.json --out dir/
*/
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const SPEC = arg("spec");
const OUT = arg("out", "/tmp/tiktok/slides");
if (!SPEC) { console.error("need --spec <file.json>"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const W = 1080, H = 1920;
/* The conservative union of conflicting sources. Outside it sit
   the n/N counter, the action rail, and the dots + caption block. */
const SAFE = { x: 90, y: 200, w: 810, h: 1220 };

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/* Rough advance width for Anton/Archivo Black at a given size. Both are narrow
   display faces; 0.46em is measured off a few sample strings and is close enough
   to wrap on, since every line is re-centred anyway. */
const textW = (s, size, face) => s.length * size * (face === "Anton" ? 0.44 : 0.52);

function wrap(text, size, face, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (textW(next, size, face) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** One text block as an SVG layer.

    PER-LINE PILLS, not one slab. TikTok's own text tool draws a rounded box
    behind EACH LINE, sized to that line — which is why native captions look
    like they belong to the video and a single full-width rectangle looks like
    a slide from a deck. Ragged pill edges also let the frame show through
    between lines, so the image keeps working as an image.

    `pill: false` falls back to stroke only, for a line sitting over ground
    that is already dark enough to carry it. */
function textLayer({ text, size, face, y, scrim = 0.62, stroke = 8, color = "#ffffff", track = 0, pill = true }) {
  const maxW = SAFE.w - 60;
  const lines = wrap(text, size, face, maxW);
  const lh = Math.round(size * 1.2);
  const padX = Math.round(size * 0.34), padY = Math.round(size * 0.16);
  const rx = Math.round(size * 0.18);

  const boxes = [], rows = [];
  lines.forEach((l, i) => {
    const w = Math.min(maxW, textW(l, size, face));
    const top = y + lh * i;
    const bx = Math.round(W / 2 - w / 2 - padX);
    if (pill) boxes.push(`<rect x="${bx}" y="${top}" width="${Math.round(w + padX * 2)}" height="${lh + padY}" rx="${rx}" fill="#000" fill-opacity="${scrim}"/>`);
    rows.push(`<text x="${W / 2}" y="${top + lh * 0.78}" text-anchor="middle"
       font-family="${face}" font-size="${size}" letter-spacing="${track}"
       fill="${color}" stroke="#000" stroke-width="${stroke}" stroke-linejoin="round"
       paint-order="stroke fill">${esc(l)}</text>`);
  });

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    ${boxes.join("")}${rows.join("")}
  </svg>`;
  return { svg: Buffer.from(svg), height: lines.length * lh + padY };
}

/** A single enormous figure — the payoff slide. One number, no pill, a hard
    stroke and a wide tracked caption under it. This is the only place a slide
    is allowed to be mostly type: it works because the eye has nothing to do
    but land on it. */
function statLayer({ stat, under, y }) {
  const s1 = 250, s2 = 44;
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="${W / 2}" y="${y + s1 * 0.78}" text-anchor="middle" font-family="Anton"
      font-size="${s1}" fill="#ffffff" stroke="#000" stroke-width="16"
      stroke-linejoin="round" paint-order="stroke fill">${esc(stat)}</text>
    ${under ? `<text x="${W / 2}" y="${y + s1 + s2 * 1.3}" text-anchor="middle"
      font-family="Archivo Black" font-size="${s2}" letter-spacing="7"
      fill="#ffd280" stroke="#000" stroke-width="8" stroke-linejoin="round"
      paint-order="stroke fill">${esc(under)}</text>` : ""}
  </svg>`);
}

async function buildSlide(slide, i, total) {
  const src = sharp(slide.image);
  const meta = await src.metadata();

  /* the frame, full canvas width */
  let frame = sharp(slide.image);
  if (slide.crop) {
    const c = slide.crop; // {left,top,width,height} in source px
    frame = frame.extract(c);
  }
  /* The frame is COVER-fit to a tall box, not letterboxed to its own aspect.
     Letterboxing a 16:9 frame at 1080 wide leaves it 608px tall in a 1920
     canvas — two thirds of the slide is then blurred filler, which reads as a
     small photo on a slab rather than as a game. Cover-fitting to 1440 keeps
     the car and the road at a size worth looking at and still keeps far more
     width than a true 9:16 keyhole crop would. */
  const frameH = slide.frameH ?? 1440;
  /* `fit` is per-slide because the two kinds of source want opposite things.
     A GAME FRAME (16:9) is cover-cropped: the subject is centred, the sides are
     scenery, and cropping buys a much bigger car. A DIAGNOSTIC PAIR — a
     before/after stacked side by side, a measurement table — must be
     `contain`ed: cover-cropping one of those slices straight through the seam
     between the two panels and destroys the only thing the image is for. */
  /* RESTACK a side-by-side pair into a vertical one. A before/after shot is
     authored side by side because that is how it is judged on a desktop, but at
     1080 wide on a phone the two panels end up ~500px each and the detail the
     pair exists to show is gone. Splitting at the midpoint and stacking gives
     each panel the full width — which is the whole reason the comparison format
     travels on a vertical feed. */
  if (slide.restack) {
    const m = await frame.metadata();
    const halfW = Math.floor(m.width / 2);
    const gap = slide.restackGap ?? 14;
    const left = await sharp(await frame.toBuffer())
      .extract({ left: 0, top: 0, width: halfW, height: m.height })
      .resize({ width: W }).toBuffer();
    const right = await sharp(await frame.toBuffer())
      .extract({ left: m.width - halfW, top: 0, width: halfW, height: m.height })
      .resize({ width: W }).toBuffer();
    const lh = (await sharp(left).metadata()).height;
    const rh = (await sharp(right).metadata()).height;
    const stacked = await sharp({
      create: { width: W, height: lh + rh + gap, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    }).composite([{ input: left, top: 0, left: 0 }, { input: right, top: lh + gap, left: 0 }])
      .png().toBuffer();
    frame = sharp(stacked);
  }

  const fit = slide.fit ?? "cover";
  const fBuf = await frame
    .resize({ width: W, height: frameH, fit, position: slide.framePos ?? "centre",
              background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const fMeta = await sharp(fBuf).metadata();

  /* blurred over-scaled fill of the same frame, so the slide reads as one image */
  const fill = await sharp(slide.image)
    .resize({ width: Math.round(W * 1.9), height: Math.round(H * 1.05), fit: "cover", position: "centre" })
    .blur(42).modulate({ brightness: 0.42, saturation: 1.15 })
    .resize(W, H, { fit: "cover", position: "centre" })
    .toBuffer();

  /* vertical placement: sit the frame just below the hook band, not dead centre,
     because the bottom 500px is caption territory the eye never rests in */
  const frameY = slide.frameY ?? 300;

  const layers = [
    { input: fBuf, top: frameY, left: 0 },
    /* a soft vignette top and bottom so text has somewhere to sit even when the
       frame behind it is bright */
    {
      input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#000" stop-opacity="0.72"/>
          <stop offset="0.30" stop-color="#000" stop-opacity="0"/>
          <stop offset="0.70" stop-color="#000" stop-opacity="0"/>
          <stop offset="1" stop-color="#000" stop-opacity="0.82"/>
        </linearGradient></defs>
        <rect width="${W}" height="${H}" fill="url(#g)"/></svg>`),
      top: 0, left: 0,
    },
  ];

  if (slide.hook) {
    const size = slide.hookSize ?? 96;
    const t = textLayer({ text: slide.hook, size, face: "Anton", y: slide.hookY ?? 250, scrim: slide.hookScrim ?? 0.66, stroke: 10, pill: slide.hookPill !== false });
    layers.push({ input: t.svg, top: 0, left: 0 });
  }
  if (slide.body) {
    const size = slide.bodySize ?? 54;
    const lines = wrap(slide.body, size, "Anton", SAFE.w - 60).length;
    const blockH = lines * Math.round(size * 1.14) + Math.round(size * 0.68);
    const y = slide.bodyY ?? (SAFE.y + SAFE.h - blockH - 30);
    const t = textLayer({ text: slide.body, size, face: "Anton", y, scrim: slide.bodyScrim ?? 0.62, stroke: 7, pill: slide.bodyPill !== false });
    layers.push({ input: t.svg, top: 0, left: 0 });
  }
  if (slide.label) {
    const t = textLayer({
      text: slide.label, size: slide.labelSize ?? 34, face: "Archivo Black",
      y: slide.labelY ?? 200, scrim: 0.55, stroke: 5, color: slide.labelColor ?? "#ffd280", track: 3,
    });
    layers.push({ input: t.svg, top: 0, left: 0 });
  }

  if (slide.stat) {
    layers.push({ input: statLayer({ stat: slide.stat, under: slide.statUnder, y: slide.statY ?? 620 }), top: 0, left: 0 });
  }

  /* slide counter, inside the safe box on the LEFT — the top right is TikTok's
     own n/N counter and anything we put there collides with it */
  if (slide.counter !== false) {
    const c = `${i + 1}/${total}`;
    layers.push({
      input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <text x="${SAFE.x}" y="${H - 545}" font-family="Archivo Black" font-size="30"
          fill="#ffffff" fill-opacity="0.55" stroke="#000" stroke-width="4"
          paint-order="stroke fill" letter-spacing="2">${c}</text></svg>`),
      top: 0, left: 0,
    });
  }

  const out = path.join(OUT, `slide-${String(i + 1).padStart(2, "0")}.png`);
  await sharp(fill).composite(layers).png({ compressionLevel: 9 }).toFile(out);
  console.log(`  ${path.basename(out)}  ${slide.hook ? "HOOK " : ""}${(slide.hook || slide.body || "").slice(0, 52)}`);
  return out;
}

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const slides = spec.slides || spec;
console.log(`building ${slides.length} slides -> ${OUT}`);
for (let i = 0; i < slides.length; i++) await buildSlide(slides[i], i, slides.length);
if (spec.caption) writeFileSync(path.join(OUT, "caption.txt"),
  spec.caption + "\n\n" + (spec.hashtags || []).join(" ") + "\n");
console.log("done");
