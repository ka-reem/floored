/* before | after | |diff|x8 for two directories of frozen frames, plus the
   per-channel numbers under it.

   test/shot-compare.mjs does this already for the desktop look sheets, but
   it matches files by a hard "before-" / "after-" prefix pair, and the
   mobile sheets need to compare two runs that carry the SAME label — a build
   against its own control. This matches on whatever follows the first
   hyphen instead, so `before-open-pov.png` in either directory lines up with
   `x-open-pov.png` in the other.

   What the numbers mean: maxChannelDelta is the largest single 8-bit channel
   difference anywhere in the frame; changedSamples is how many of the
   channel samples differ at all. A change is invisible when both are no
   larger than the CONTROL's — the same build shot twice — which is what
   makes the control the thing worth measuring first.

   Usage:
     node test/shot-delta.mjs A_DIR B_DIR OUT.png [A label] [B label]
*/
import sharp from "./node_modules/sharp/dist/index.cjs";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const [A, B, OUT, LA = "A", LB = "B"] = process.argv.slice(2);
mkdirSync(path.dirname(OUT), { recursive: true });
const key = (f) => f.replace(/\.png$/, "").split("-").slice(1).join("-");
const aFiles = readdirSync(A).filter((f) => f.endsWith(".png"));
const bFiles = readdirSync(B).filter((f) => f.endsWith(".png"));
const bBy = new Map(bFiles.map((f) => [key(f), f]));

const SCALE = 0.34, PAD = 20;
const rows = [], stats = [];
let W = 0, H = 0;
for (const fa of aFiles.sort()) {
  const k = key(fa);
  const fb = bBy.get(k);
  if (!fb) { console.log("no pair for", k); continue; }
  const pa = path.join(A, fa), pb = path.join(B, fb);
  if (!existsSync(pb)) continue;
  const ra = await sharp(pa).raw().toBuffer({ resolveWithObject: true });
  const rb = await sharp(pb).raw().toBuffer({ resolveWithObject: true });
  if (ra.data.length !== rb.data.length) {
    console.log("size mismatch", k, ra.info, rb.info); continue;
  }
  const n = ra.data.length;
  let maxD = 0, sum = 0, diff = 0;
  const dbuf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(ra.data[i] - rb.data[i]);
    if (d > maxD) maxD = d;
    sum += d;
    if (d) diff++;
    dbuf[i] = Math.min(255, d * 8);
  }
  stats.push({ frame: k, maxChannelDelta: maxD, meanChannelDelta: +(sum / n).toFixed(5),
    changedSamples: diff, totalSamples: n,
    changedPct: +((100 * diff) / n).toFixed(3) });
  const w = Math.round(ra.info.width * SCALE), h = Math.round(ra.info.height * SCALE);
  const [ba, bb, bd] = await Promise.all([
    sharp(pa).resize(w, h).png().toBuffer(),
    sharp(pb).resize(w, h).png().toBuffer(),
    sharp(dbuf, { raw: { width: ra.info.width, height: ra.info.height, channels: ra.info.channels } })
      .resize(w, h).png().toBuffer(),
  ]);
  rows.push({ k, ba, bb, bd, w, h });
}
if (!rows.length) { console.log("nothing to compare"); process.exit(1); }
const cols = Math.min(rows.length, 1);
const rw = rows[0].w, rh = rows[0].h;
W = rw * 3 + PAD * 4;
H = rows.length * (rh + PAD + 24) + PAD;
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const label = (t, w, size = 14) => Buffer.from(
  `<svg width="${w}" height="24"><text x="2" y="17" font-family="monospace" font-size="${size}" fill="#e8e8e8">${esc(t)}</text></svg>`);

const comps = [];
let y = PAD;
for (const r of rows) {
  const s = stats.find((x) => x.frame === r.k);
  comps.push({ input: label(
    `${r.k}    ${LA}   |   ${LB}   |   |diff| x8    max ${s.maxChannelDelta}  changed ${s.changedPct}%`,
    W - 8), left: PAD, top: y });
  comps.push({ input: r.ba, left: PAD, top: y + 24 });
  comps.push({ input: r.bb, left: PAD * 2 + r.w, top: y + 24 });
  comps.push({ input: r.bd, left: PAD * 3 + r.w * 2, top: y + 24 });
  y += rh + 24 + PAD;
}
await sharp({ create: { width: W, height: H, channels: 3, background: { r: 14, g: 14, b: 18 } } })
  .composite(comps).png().toFile(OUT);
writeFileSync(OUT.replace(/\.png$/, "-stats.json"), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));
console.log("wrote", OUT);
