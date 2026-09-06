/* before/after contact sheet + pixel delta, for a change that must be invisible. */
import sharp from "./node_modules/sharp/dist/index.cjs";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const A = process.argv[2], B = process.argv[3], OUT = process.argv[4];
mkdirSync(path.dirname(OUT), { recursive: true });
const places = readdirSync(A).filter((f) => f.endsWith(".png"))
  .map((f) => f.replace(/^before-/, "").replace(/\.png$/, ""));

const SCALE = 0.42;
const rows = [];
const stats = [];
let W = 0, H = 0, PAD = 22;
for (const p of places) {
  const fa = path.join(A, `before-${p}.png`), fb = path.join(B, `after-${p}.png`);
  const ia = sharp(fa), ib = sharp(fb);
  const ra = await ia.raw().toBuffer({ resolveWithObject: true });
  const rb = await ib.raw().toBuffer({ resolveWithObject: true });
  const n = Math.min(ra.data.length, rb.data.length);
  let maxD = 0, sum = 0, diffPx = 0;
  const ch = ra.info.channels;
  const dbuf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(ra.data[i] - rb.data[i]);
    if (d > maxD) maxD = d;
    sum += d;
    if (d) diffPx++;
    dbuf[i] = Math.min(255, d * 8);
  }
  stats.push({ place: p, maxChannelDelta: maxD, meanChannelDelta: +(sum / n).toFixed(4),
    changedSamples: diffPx, totalSamples: n });
  const w = Math.round(ra.info.width * SCALE), h = Math.round(ra.info.height * SCALE);
  const [ba, bb, bd] = await Promise.all([
    sharp(fa).resize(w, h).png().toBuffer(),
    sharp(fb).resize(w, h).png().toBuffer(),
    sharp(dbuf, { raw: { width: ra.info.width, height: ra.info.height, channels: ch } })
      .resize(w, h).png().toBuffer(),
  ]);
  rows.push({ p, ba, bb, bd, w, h });
  W = w * 3 + PAD * 4;
  H += h + PAD * 2;
}
const svgLabel = (t, w, h, size = 15) =>
  Buffer.from(`<svg width="${w}" height="${h}"><text x="4" y="${size}" font-family="monospace"
   font-size="${size}" fill="#e8e8e8">${t}</text></svg>`);

const comps = [];
let y = 0;
for (const r of rows) {
  comps.push({ input: svgLabel(
    `${r.p}   BEFORE                              AFTER                               |diff| x8   max delta ${stats.find(s=>s.place===r.p).maxChannelDelta}`,
    W - 8, PAD), left: 6, top: y + 2 });
  comps.push({ input: r.ba, left: PAD, top: y + PAD });
  comps.push({ input: r.bb, left: PAD * 2 + r.w, top: y + PAD });
  comps.push({ input: r.bd, left: PAD * 3 + r.w * 2, top: y + PAD });
  y += r.h + PAD * 2;
}
await sharp({ create: { width: W, height: H, channels: 3, background: { r: 16, g: 16, b: 20 } } })
  .composite(comps).png().toFile(OUT);
console.log(JSON.stringify(stats, null, 2));
writeFileSync(OUT.replace(/\.png$/, "-stats.json"), JSON.stringify(stats, null, 2));
console.log("wrote", OUT);
