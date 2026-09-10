/* Contact sheet — the judging surface for the library frames.

   The owner judges pictures, not lists, and a lane judging its own frames
   needs the same thing: twenty frames side by side, labelled, small enough
   that "these two are the same picture" is obvious at a glance and big enough
   that a HUD leak or a clipped bumper still shows. 4 columns of 640x360 tiles
   with the file name burned into the corner.

   Usage: node test/hero-sheet.mjs --out sheet.png [--cols 4] file1.png file2.png ...
          node test/hero-sheet.mjs --out sheet.png --dir <dir> [--glob lib-]
*/
import { readdirSync } from "node:fs";
import path from "node:path";
import sharp from "./node_modules/sharp/lib/index.js";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i > -1 ? argv[i + 1] : d;
};
const OUT = arg("out", "sheet.png");
const COLS = Number(arg("cols", "4"));
const DIR = arg("dir", "");
const PREFIX = arg("glob", "");
const TITLE = arg("title", "");
const TW = 640, TH = 360;

let files = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
if (DIR) {
  files = readdirSync(DIR).filter((f) => f.endsWith(".png") && f.startsWith(PREFIX)).sort()
    .map((f) => path.join(DIR, f));
}
if (!files.length) {
  console.error("no input frames");
  process.exit(2);
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const tiles = [];
for (const f of files) {
  const name = path.basename(f, ".png");
  const img = await sharp(f).resize(TW, TH, { fit: "cover" }).png().toBuffer();
  const w = Math.min(TW, 14 + name.length * 8.6);
  const label = Buffer.from(
    `<svg width="${TW}" height="${TH}"><rect x="0" y="0" width="${w}" height="24" fill="#000c"/>` +
    `<text x="6" y="17" font-size="14" font-family="DejaVu Sans Mono, monospace" fill="#fff">${esc(name)}</text></svg>`);
  tiles.push(await sharp(img).composite([{ input: label, top: 0, left: 0 }]).png().toBuffer());
}
const rows = Math.ceil(tiles.length / COLS);
const top = TITLE ? 40 : 0;
const comp = tiles.map((t, i) => ({ input: t, left: (i % COLS) * TW, top: top + Math.floor(i / COLS) * TH }));
if (TITLE) {
  comp.push({
    input: Buffer.from(`<svg width="${COLS * TW}" height="40"><text x="10" y="28" font-size="22" ` +
      `font-family="DejaVu Sans, sans-serif" fill="#fff">${esc(TITLE)}</text></svg>`),
    top: 0, left: 0,
  });
}
await sharp({ create: { width: COLS * TW, height: top + rows * TH, channels: 3, background: "#151515" } })
  .composite(comp).png().toFile(OUT);
console.log("sheet:", OUT, tiles.length, "frames");
