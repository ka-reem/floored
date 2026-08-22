/* Downsamples a Radiance .hdr equirect panorama in place of a bigger one, and
   reports what the resize costs the things the game actually cares about.

     node tools/shrink-hdri.mjs <in.hdr> [--out out.hdr] [--width N] [--stats]

   The HDRIs under public/hdri are never drawn — game/carenv.ts feeds the one
   it finds straight to PMREMGenerator and throws the source away, so the only
   consumer is the prefiltered cube the car materials reflect. three's PMREM
   sizes that cube at `equirect.width / 4` (PMREMGenerator._fromTexture), so a
   2048-wide panorama buys a 512-per-face cube and a 1024-wide one buys 256.
   That is the entire visual budget the file is spent on; the megabytes above
   it are decoded, measured and discarded.

   Radiance RGBE is simple enough to round-trip here rather than shell out:
   a text header, a `-Y H +X W` resolution line, then per-scanline RLE over
   four component planes. Everything below matches three's HDRLoader byte for
   byte on the decode side (mantissa/255 * 2^(e-128)) so what this script
   measures is what the game will see.

   The resize is a box filter in linear float — the correct filter for an
   environment map, where each destination texel must carry the mean radiance
   of the solid angle it covers. It is also the lossy step: a street lamp
   narrower than the destination texel keeps its energy but loses its peak,
   and peaks are what draw a highlight across a clearcoated panel. `--stats`
   prints that trade (mean luminance, peak, and the share of total light
   coming out of the brightest 0.1% of pixels) at every candidate width so the
   choice is made on numbers rather than on file size alone.

   Re-runnable: writing over the input is refused, and `--stats` alone writes
   nothing. Originals live in public/assets-staging/hdri-night/. */

import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith("--"));
const flag = (n) => {
  const i = args.indexOf(n);
  return i < 0 ? null : args[i + 1];
};
const OUT = flag("--out");
const WIDTH = Number(flag("--width")) || 0;
const STATS = args.includes("--stats");

if (!FILE || !fs.existsSync(FILE)) {
  console.error("usage: node tools/shrink-hdri.mjs <in.hdr> [--out out.hdr] [--width N] [--stats]");
  process.exit(1);
}
if (OUT && path.resolve(OUT) === path.resolve(FILE)) {
  console.error("refusing to write over the input; pass a different --out");
  process.exit(1);
}

/* --------------------------------------------------------------- decode -- */

/** Parse the Radiance text header. Returns the pixel offset and dimensions. */
function readHeader(buf) {
  if (buf[0] !== 0x23 || buf[1] !== 0x3f) throw new Error("not a Radiance file (bad magic)");
  let pos = 0, line = "", rle = false;
  const nextLine = () => {
    let s = "";
    while (pos < buf.length && buf[pos] !== 0x0a) s += String.fromCharCode(buf[pos++]);
    pos++; // the newline
    return s;
  };
  nextLine(); // #?RADIANCE
  for (;;) {
    line = nextLine();
    if (line === "") break; // blank line closes the header
    if (/^FORMAT=/.test(line)) rle = /32-bit_rle_rgbe/.test(line);
  }
  const dim = nextLine().match(/^-Y (\d+) \+X (\d+)$/);
  if (!dim) throw new Error(`unsupported resolution line: ${line}`);
  return { pos, height: Number(dim[1]), width: Number(dim[2]), rle };
}

/** Decode the whole image to a Float32Array of linear RGB triples. */
function decode(buf) {
  const { pos, width, height } = readHeader(buf);
  let p = pos;
  const out = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4); // one scanline, RGBE interleaved

  const emit = (row) => {
    for (let x = 0; x < width; x++) {
      const e = scan[x * 4 + 3];
      const s = e === 0 ? 0 : Math.pow(2, e - 128) / 255;
      const o = (row * width + x) * 3;
      out[o] = scan[x * 4] * s;
      out[o + 1] = scan[x * 4 + 1] * s;
      out[o + 2] = scan[x * 4 + 2] * s;
    }
  };

  for (let y = 0; y < height; y++) {
    const newRLE =
      width >= 8 && width < 32768 &&
      buf[p] === 2 && buf[p + 1] === 2 && ((buf[p + 2] << 8) | buf[p + 3]) === width;
    if (!newRLE) {
      // flat (or old-style RLE) scanlines: four bytes per pixel, straight through
      for (let x = 0; x < width; x++) {
        scan[x * 4] = buf[p++]; scan[x * 4 + 1] = buf[p++];
        scan[x * 4 + 2] = buf[p++]; scan[x * 4 + 3] = buf[p++];
      }
      emit(y);
      continue;
    }
    p += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        const n = buf[p++];
        const count = n > 128 ? n - 128 : n;
        // a plane that overruns its scanline means the stream is misaligned —
        // the failure mode that silently yields a garbage env map
        if (count === 0 || x + count > width)
          throw new Error(`corrupt RLE at row ${y} plane ${c} (count ${count}, x ${x})`);
        if (n > 128) { // run of (n - 128) copies
          const v = buf[p++];
          for (let i = 0; i < count; i++) scan[(x++) * 4 + c] = v;
        } else { // n literal bytes
          for (let i = 0; i < count; i++) scan[(x++) * 4 + c] = buf[p++];
        }
      }
    }
    emit(y);
  }
  return { data: out, width, height };
}

/* --------------------------------------------------------------- encode -- */

/** RLE one component plane of a scanline into `out` (Radiance's own scheme:
 *  runs of 4+ become a count byte >128, everything else goes out literal). */
function encodePlane(scan, c, width, out) {
  let x = 0;
  while (x < width) {
    let run = 1;
    while (x + run < width && run < 127 && scan[(x + run) * 4 + c] === scan[x * 4 + c]) run++;
    if (run >= 4) {
      out.push(128 + run, scan[x * 4 + c]);
      x += run;
      continue;
    }
    /* gather literals up to the next run of 4. The count byte has to stay
       <= 128 — 129 and up mean "run" to every decoder, so letting a trailing
       pair push the tally past 128 silently reinterprets the whole plane. */
    let lit = 0;
    while (x + lit < width && lit < 128) {
      const v = scan[(x + lit) * 4 + c];
      let same = 1;
      while (x + lit + same < width && same < 4 && scan[(x + lit + same) * 4 + c] === v) same++;
      if (same >= 4) break;
      if (lit + same > 128) break;
      lit += same;
    }
    if (lit === 0) lit = 1;
    out.push(lit);
    for (let i = 0; i < lit; i++) out.push(scan[(x + i) * 4 + c]);
    x += lit;
  }
}

/** Float RGB -> a new-style RLE Radiance buffer. */
function encode(data, width, height) {
  const head = Buffer.from(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, "latin1");
  const body = [];
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const d = Math.max(r, g, b);
      if (!(d > 1e-32)) { scan[x * 4] = scan[x * 4 + 1] = scan[x * 4 + 2] = scan[x * 4 + 3] = 0; continue; }
      // pick the exponent that puts the largest channel in (128, 255]
      let e = Math.ceil(Math.log2(d)) + 128;
      if (e < 1) e = 1; else if (e > 254) e = 254;
      const s = 255 / Math.pow(2, e - 128);
      const q = (v) => Math.max(0, Math.min(255, Math.round(v * s)));
      scan[x * 4] = q(r); scan[x * 4 + 1] = q(g); scan[x * 4 + 2] = q(b); scan[x * 4 + 3] = e;
    }
    body.push(2, 2, (width >> 8) & 0xff, width & 0xff);
    for (let c = 0; c < 4; c++) encodePlane(scan, c, width, body);
  }
  return Buffer.concat([head, Buffer.from(body)]);
}

/* --------------------------------------------------------------- resize -- */

/** Box-filter to `w` x `w/2`. Integer factors only — every candidate width for
 *  a 2:1 equirect divides the source evenly, and an integer box keeps the mean
 *  radiance of each destination solid angle exact. */
function resize(img, w) {
  const h = w >> 1;
  const fx = img.width / w, fy = img.height / h;
  if (!Number.isInteger(fx) || !Number.isInteger(fy))
    throw new Error(`${img.width}x${img.height} -> ${w}x${h} is not an integer box`);
  const out = new Float32Array(w * h * 3);
  const n = fx * fy;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = y * fy; sy < (y + 1) * fy; sy++) {
        for (let sx = x * fx; sx < (x + 1) * fx; sx++) {
          const o = (sy * img.width + sx) * 3;
          r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2];
        }
      }
      const o = (y * w + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { data: out, width: w, height: h };
}

/* ---------------------------------------------------------------- stats -- */

/** The three numbers that decide whether a resize is visible on car paint:
 *  mean luminance (carenv.ts rescales the whole map to match the painted cube,
 *  so this must survive), peak luminance, and the share of all light emitted
 *  by the brightest 0.1% of pixels — carenv.ts picks its primary HDRI on
 *  exactly that concentration figure. */
function stats(img) {
  const n = img.width * img.height;
  const lum = new Float64Array(n);
  let sum = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * img.data[i * 3] + 0.7152 * img.data[i * 3 + 1] + 0.0722 * img.data[i * 3 + 2];
    lum[i] = l; sum += l;
    if (l > peak) peak = l;
  }
  const top = Math.max(1, Math.round(n * 0.001));
  const sorted = Float64Array.from(lum).sort();
  let topSum = 0;
  for (let i = n - top; i < n; i++) topSum += sorted[i];
  return { mean: sum / n, peak, top01: sum > 0 ? topSum / sum : 0 };
}

const fmt = (s) =>
  `mean ${s.mean.toFixed(4)}  peak ${s.peak.toFixed(1).padStart(9)}  ` +
  `top0.1% ${(s.top01 * 100).toFixed(1).padStart(5)}%`;

/* ------------------------------------------------------------------ run -- */

const src = decode(fs.readFileSync(FILE));
console.log(`${path.basename(FILE)}  ${src.width}x${src.height}  ` +
  `${(fs.statSync(FILE).size / 1048576).toFixed(2)} MB`);
console.log(`  ${String(src.width).padStart(4)}  ${fmt(stats(src))}   (source)`);

if (STATS) {
  for (let w = src.width >> 1; w >= 128; w >>= 1) {
    const r = resize(src, w);
    const bytes = encode(r.data, r.width, r.height).length;
    console.log(`  ${String(w).padStart(4)}  ${fmt(stats(r))}   ` +
      `${(bytes / 1024).toFixed(0)} KB  cube ${w / 4}px/face`);
  }
}

if (WIDTH && OUT) {
  const r = WIDTH === src.width ? src : resize(src, WIDTH);
  const buf = encode(r.data, r.width, r.height);
  fs.writeFileSync(OUT, buf);
  // read it straight back: a corrupt env map breaks every reflective surface
  const back = decode(fs.readFileSync(OUT));
  if (back.width !== r.width || back.height !== r.height)
    throw new Error(`round-trip size mismatch: ${back.width}x${back.height}`);
  const a = stats(r), b = stats(back);
  const drift = Math.abs(b.mean - a.mean) / a.mean;
  console.log(`wrote ${OUT}  ${back.width}x${back.height}  ${(buf.length / 1024).toFixed(0)} KB`);
  console.log(`  re-decoded: ${fmt(b)}  (mean drift ${(drift * 100).toFixed(3)}%)`);
  if (drift > 0.01) throw new Error("round-trip mean drifted more than 1% — not shipping this");
}
