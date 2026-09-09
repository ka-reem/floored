/* Stack two captures into ONE labelled before/after image.

   AGENTS.md: "Stack before/after into ONE image where you can, labelled, so
   there is nothing to line up by eye." Vertical by default (phone strips are
   wide and short); --side for two tall frames.

   Usage: node test/lib/stack-ab.mjs before.png after.png out.png \
            [--a "BEFORE — ..."] [--b "AFTER — ..."] [--side]
*/
import sharp from "sharp";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i > -1 ? args[i + 1] : d;
};
const [A, B, OUT] = args.filter((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
const LA = opt("--a", "BEFORE");
const LB = opt("--b", "AFTER");
const SIDE = args.includes("--side");
const BAR = 44, GAP = 8;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const label = (text, w) =>
  Buffer.from(
    `<svg width="${w}" height="${BAR}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${BAR}" fill="#0d1018"/>` +
    `<text x="14" y="29" font-family="DejaVu Sans, sans-serif" font-size="20" ` +
    `font-weight="700" fill="#ffd280">${esc(text)}</text></svg>`
  );

const a = sharp(A), b = sharp(B);
const [ma, mb] = [await a.metadata(), await b.metadata()];
const w = Math.max(ma.width, mb.width);
const pa = await sharp(A).extend({ right: w - ma.width, background: "#0d1018" }).png().toBuffer();
const pb = await sharp(B).extend({ right: w - mb.width, background: "#0d1018" }).png().toBuffer();

if (SIDE) {
  const h = Math.max(ma.height, mb.height) + BAR;
  await sharp({ create: { width: w * 2 + GAP, height: h, channels: 3, background: "#0d1018" } })
    .composite([
      { input: label(LA, w), left: 0, top: 0 },
      { input: pa, left: 0, top: BAR },
      { input: label(LB, w), left: w + GAP, top: 0 },
      { input: pb, left: w + GAP, top: BAR },
    ])
    .png().toFile(OUT);
} else {
  const h = ma.height + mb.height + BAR * 2 + GAP;
  await sharp({ create: { width: w, height: h, channels: 3, background: "#0d1018" } })
    .composite([
      { input: label(LA, w), left: 0, top: 0 },
      { input: pa, left: 0, top: BAR },
      { input: label(LB, w), left: 0, top: BAR + ma.height + GAP },
      { input: pb, left: 0, top: BAR * 2 + ma.height + GAP },
    ])
    .png().toFile(OUT);
}
console.log("wrote", OUT);
