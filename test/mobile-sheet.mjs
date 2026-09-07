/* Labelled option sheets and proof sheets from the mobile shot dirs.

   test/shot-compare.mjs already answers "is this change invisible" for a
   whole frame. This answers the other two questions the owner actually looks
   at: "what do the OPTIONS look like side by side", and "what changed, big
   enough to see". A 429x928 phone frame shrunk into a contact sheet is far
   too small to judge a bloom edge or a mirror in, so this crops first.

   Usage:
     node test/mobile-sheet.mjs --out sheet.png --title "..." \
       --crop 0.25,0.35,0.5,0.3 \
       --col "A: as it ships=/path/before-open-pov.png" \
       --col "B: MSAA off=/path/after-open-pov.png"

   --crop is x,y,w,h as FRACTIONS of the frame, so the same numbers frame the
   same part of the picture whatever the capture resolution was. Omit it for
   the whole frame. Columns are laid out left to right in the order given,
   each under its own label, at a shared scale.
*/
import sharp from "./node_modules/sharp/dist/index.cjs";
import { mkdirSync } from "node:fs";
import path from "node:path";

const argAll = (k) => process.argv.reduce((a, v, i) =>
  (process.argv[i - 1] === k ? [...a, v] : a), []);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };

const OUT = arg("--out", "/tmp/sheet.png");
const TITLE = arg("--title", "");
const NOTE = arg("--note", "");
const SCALE = Number(arg("--scale", 1));
const CROP = arg("--crop", "");
const cols = argAll("--col").map((s) => {
  const i = s.lastIndexOf("=");
  return { label: s.slice(0, i), file: s.slice(i + 1) };
});
if (!cols.length) { console.error("need at least one --col label=path"); process.exit(1); }
mkdirSync(path.dirname(OUT), { recursive: true });

const PAD = 16, LAB = 26, TOP = TITLE ? 40 : 0, BOT = NOTE ? 34 : 0;
const tiles = [];
for (const c of cols) {
  let img = sharp(c.file);
  const meta = await img.metadata();
  if (CROP) {
    const [fx, fy, fw, fh] = CROP.split(",").map(Number);
    img = sharp(c.file).extract({
      left: Math.round(meta.width * fx), top: Math.round(meta.height * fy),
      width: Math.max(1, Math.round(meta.width * fw)),
      height: Math.max(1, Math.round(meta.height * fh)),
    });
  }
  const m2 = await img.metadata();
  const w = Math.round((CROP ? m2.width : meta.width) * SCALE);
  const h = Math.round((CROP ? m2.height : meta.height) * SCALE);
  tiles.push({ label: c.label, buf: await img.resize(w, h).png().toBuffer(), w, h });
}
const H = Math.max(...tiles.map((t) => t.h));
const W = tiles.reduce((a, t) => a + t.w, 0) + PAD * (tiles.length + 1);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (t, w, h, size, fill) => Buffer.from(
  `<svg width="${w}" height="${h}"><text x="2" y="${size}" font-family="monospace" font-size="${size}" fill="${fill}">${esc(t)}</text></svg>`);

const comps = [];
if (TITLE) comps.push({ input: text(TITLE, W - 8, TOP, 20, "#f2f2f2"), left: PAD, top: 8 });
let x = PAD;
for (const t of tiles) {
  comps.push({ input: text(t.label, t.w, LAB, 15, "#cfe3ff"), left: x, top: TOP + 4 });
  comps.push({ input: t.buf, left: x, top: TOP + LAB });
  x += t.w + PAD;
}
if (NOTE) comps.push({ input: text(NOTE, W - 8, BOT, 14, "#b9b9b9"), left: PAD, top: TOP + LAB + H + 8 });
await sharp({ create: { width: W, height: TOP + LAB + H + PAD + BOT, channels: 3, background: { r: 14, g: 14, b: 18 } } })
  .composite(comps).png().toFile(OUT);
console.log("wrote", OUT, `${W}x${TOP + LAB + H + PAD + BOT}`);
