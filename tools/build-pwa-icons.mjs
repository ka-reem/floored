/* Renders the home-screen install icons procedurally — no downloaded assets.

     node tools/build-pwa-icons.mjs

   Outputs are committed (repo convention: deterministic tool, committed
   renders; also wired as `prebuild` so `npm run build` refreshes them):

     public/icons/icon-192.png           manifest icon (purpose: any)
     public/icons/icon-512.png           manifest icon (purpose: any)
     public/icons/icon-512-maskable.png  manifest icon (purpose: maskable)
     app/apple-icon.png                  180px — Next's file convention emits
                                         the <link rel="apple-touch-icon">

   The artwork is the app/icon.svg emblem (the two speed slashes and the road
   line, in the UI's accent/jp/cyan colors) redrawn at 512 on the menus' own
   dark scrim gradient, with a soft blurred underlayer so the strokes glow
   instead of sitting flat — same fade-never-stop rule as every light in the
   game. Pure paths, no text: SVG text would rasterize with whatever fonts
   the building machine happens to have, and the render must be identical
   everywhere.

   The maskable variant shrinks the emblem to 70% around center: Android
   adaptive masks may crop anything outside the inner ~80% circle, and a
   slash clipped mid-stroke reads as a broken icon. The `any` icons keep the
   full-bleed square — iOS and Android both round the corners themselves.

   Bytes: sharp's palette PNG (libimagequant) keeps all four files ~30 KB
   total. They live in public/icons/, which test/size-budget.mjs counts as a
   LAZY dir — the browser fetches manifest icons at install time, never on
   the path to the first drivable frame. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/* Emblem paths are app/icon.svg's 64-grid coordinates scaled x8 onto the 512
   canvas. emblemScale shrinks the group around the canvas center (maskable
   safe zone); the background always fills the full square. */
function iconSvg(size, { emblemScale = 1 } = {}) {
  const s = size / 512;
  const t = `translate(${256 * s} ${256 * s}) scale(${s * emblemScale}) translate(-256 -256)`;
  const emblem = `
    <path d="M80 368 L240 112 L304 112 L216 368 Z" fill="#5f8dff"/>
    <path d="M240 368 L368 160 L416 160 L320 368 Z" fill="#ff5f8f"/>
    <rect x="64" y="392" width="384" height="32" rx="16" fill="#37c8ff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <!-- the menus' scrim-load gradient: blue-black glow low in the frame -->
    <radialGradient id="ground" cx="50%" cy="110%" r="120%">
      <stop offset="0%" stop-color="#141b3a"/>
      <stop offset="55%" stop-color="#080a16"/>
      <stop offset="100%" stop-color="#04050c"/>
    </radialGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="${18 * s * emblemScale}"/>
    </filter>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#ground)"/>
  <g transform="${t}">
    <g filter="url(#glow)" opacity="0.85">${emblem}</g>
    ${emblem}
  </g>
</svg>`;
}

async function render(svg, outPath) {
  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
  writeFileSync(join(ROOT, outPath), png);
  console.log(`  ${outPath.padEnd(36)} ${(png.length / 1024).toFixed(1).padStart(6)} KB`);
}

mkdirSync(join(ROOT, "public/icons"), { recursive: true });
await render(iconSvg(192), "public/icons/icon-192.png");
await render(iconSvg(512), "public/icons/icon-512.png");
await render(iconSvg(512, { emblemScale: 0.7 }), "public/icons/icon-512-maskable.png");
await render(iconSvg(180), "app/apple-icon.png");
