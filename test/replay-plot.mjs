/* The replay viewer: one session's drive_trace batches, drawn as the drive.

   Takes the JSON a session exported from PostHog looks like (an array of
   `drive_trace` event property blobs, plus the road polylines the capture
   dumped) and draws the whole drive as one top-down picture — the road, the
   line the car took, coloured by speed, with every crash and near miss marked
   and the point the session stopped called out. Under it, the same drive
   against the clock, which is where "they slowed down HERE" is legible.

   This is the deliverable: one image that shows the shape of somebody's
   drive without having to watch a video of it.

   Usage: node test/replay-plot.mjs test/artifacts/telemetry/session.json \
            docs/gallery/img/telemetry-replay.webp
*/
import sharp from "sharp";
import { readFileSync } from "node:fs";

const [SRC, OUT, CROP] = process.argv.slice(2);
const doc = JSON.parse(readFileSync(SRC, "utf8"));
const batches = (doc.batches || doc).slice().sort((a, b) => a.seq - b.seq);

/* ---------- decode the wire format (lib/telemetry.ts, v1) ---------- */
const P = (s) => parseInt(s, 36);
const samples = [], events = [];
let tAbs = 0;
for (const b of batches) {
  if (!b.pts) continue;
  let x = 0, z = 0, i0 = samples.length;
  b.pts.split(";").forEach((tok, i) => {
    const f = tok.split(",");
    tAbs += P(f[0]) / 10;
    x += P(f[1]);
    z += P(f[2]);
    const fl = P(f[5]);
    samples.push({ t: tAbs, x, z, kmh: P(f[3]), hd: P(f[4]), tun: !!(fl & 1), mtn: !!(fl & 2), cam: fl >> 4 });
    void i;
  });
  if (b.ev) for (const e of String(b.ev).split(";").filter(Boolean)) {
    const [i, k, v] = e.split(":");
    events.push({ i: i0 + Number(i), kind: k, v: Number(v) });
  }
}
const last = samples[samples.length - 1] || { t: 0, x: 0, z: 0, kmh: 0 };
const crashes = events.filter((e) => e.kind === "c");
const nears = events.filter((e) => e.kind === "n");
const jsonBytes = batches.reduce((a, b) => a + JSON.stringify(b).length, 0);
const perMin = jsonBytes / (last.t / 60);

/* ---------- canvas ---------- */
const W = 1720, MAP_H = 470, STRIP_H = 260, BAR = 58, GAP = 8, LEG = 46;
const M = { l: 58, r: 26, t: 34, b: 30 };

const map = doc.map || {};
const pts = [];
for (const k of ["c", "l", "r"]) if (map.corridor?.[k]) pts.push(...map.corridor[k]);
if (map.bypass) pts.push(...map.bypass);
if (map.mtn) pts.push(...map.mtn);
for (const s of samples) pts.push([s.x, s.z]);
const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
/* z runs left-right (the corridor is 4 km of it and 200 m of x), x runs down */
const z0 = Math.min(...zs) - 40, z1 = Math.max(...zs) + 40;
const x0 = Math.min(...xs) - 40, x1 = Math.max(...xs) + 40;
const PW = W - M.l - M.r, PH = MAP_H - M.t - M.b;
/* The corridor is 4 km of z and 250 m of x. At one scale for both, the whole
   road is a 15 px hairline and a lane change is invisible — so the lateral
   axis is exaggerated, the way test/toll-nomerge-plot.mjs flattens the plaza,
   and the factor is printed on the picture. */
const scZ = PW / (z1 - z0);
const scX = Math.min(PH / (x1 - x0), scZ * 14);
const EXAG = scX / scZ;
const ox = M.l, oy = M.t + (PH - (x1 - x0) * scX) / 2;
const px = (z) => ox + (z - z0) * scZ;
const py = (x) => oy + (x - x0) * scX;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const F = "DejaVu Sans, sans-serif";

/* Speed ramp. RED IS SLOW on purpose: what this plot is read for is where
   somebody bogged down, so that is what has to jump off the picture. */
const STOPS = [
  [0, [214, 48, 60]], [40, [240, 122, 46]], [80, [232, 200, 70]],
  [130, [122, 214, 118]], [180, [72, 214, 214]], [240, [150, 190, 255]],
];
function col(kmh) {
  for (let i = 1; i < STOPS.length; i++) {
    if (kmh <= STOPS[i][0] || i === STOPS.length - 1) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i];
      const f = Math.max(0, Math.min(1, (kmh - a) / (b - a)));
      return `rgb(${ca.map((v, k) => Math.round(v + (cb[k] - v) * f)).join(",")})`;
    }
  }
  return "#fff";
}

function poly(arr, stroke, w, op = 1, dash = "") {
  if (!arr?.length) return "";
  return `<polyline points="${arr.map(([x, z]) => `${px(z).toFixed(1)},${py(x).toFixed(1)}`).join(" ")}" ` +
    `fill="none" stroke="${stroke}" stroke-width="${w}" opacity="${op}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

/* road: the corridor as a filled band between its two edges, the two other
   routes as plain ribbons */
let road = "";
if (map.corridor?.l && map.corridor?.r) {
  const ring = [...map.corridor.l, ...[...map.corridor.r].reverse()];
  road += `<polygon points="${ring.map(([x, z]) => `${px(z).toFixed(1)},${py(x).toFixed(1)}`).join(" ")}" ` +
    `fill="#232a3a" stroke="#39435c" stroke-width="1"/>`;
  road += poly(map.corridor.c, "#4d5876", 1, 0.9, "10 12");
}
road += poly(map.bypass, "#2f3a52", 10, 0.95) + poly(map.mtn, "#2f3a52", 10, 0.95);

/* the drive: one short segment per sample pair, coloured by the speed it was
   driven at. Breaks on the loop splice (the corridor teleports the car back a
   lap length, which is a real jump on the map, not a dropout). */
let trace = "";
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1], b = samples[i];
  if (Math.abs(b.z - a.z) > 400 || Math.abs(b.x - a.x) > 400) continue;
  trace += `<line x1="${px(a.z).toFixed(1)}" y1="${py(a.x).toFixed(1)}" ` +
    `x2="${px(b.z).toFixed(1)}" y2="${py(b.x).toFixed(1)}" stroke="${col(b.kmh)}" ` +
    `stroke-width="3.4" stroke-linecap="round" opacity="0.95"/>`;
}
/* tunnel stretch, over the trace, so "the driver was in the tunnel here" is
   readable */
let tun = "";
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1], b = samples[i];
  if (!(a.tun && b.tun) || Math.abs(b.z - a.z) > 400) continue;
  tun += `<line x1="${px(a.z).toFixed(1)}" y1="${py(a.x).toFixed(1)}" x2="${px(b.z).toFixed(1)}" ` +
    `y2="${py(b.x).toFixed(1)}" stroke="#7f8cff" stroke-width="8" opacity="0.16"/>`;
}

const at = (i) => samples[Math.max(0, Math.min(samples.length - 1, i))];
let marks = "";
for (const e of nears) {
  const s = at(e.i);
  marks += `<circle cx="${px(s.z).toFixed(1)}" cy="${py(s.x).toFixed(1)}" r="4.6" ` +
    `fill="none" stroke="#ffd166" stroke-width="1.8" opacity="0.9"/>`;
}
/* Label only the hardest few — nineteen "26 m/s" tags on top of each other
   is a worse picture than three. */
const worst = new Set([...crashes].sort((a, b) => b.v - a.v).slice(0, 3).map((e) => e.i));
crashes.forEach((e, k) => {
  const s = at(e.i), X = px(s.z), Y = py(s.x);
  marks += `<circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="11" fill="none" stroke="#ff3b3b" stroke-width="2.6"/>` +
    `<path d="M${(X - 5).toFixed(1)},${(Y - 5).toFixed(1)} l10,10 M${(X + 5).toFixed(1)},${(Y - 5).toFixed(1)} l-10,10" ` +
    `stroke="#fff" stroke-width="2.4"/>`;
  if (worst.has(e.i))
    marks += `<text x="${(X + 15).toFixed(1)}" y="${(Y + (k % 2 ? 26 : -16)).toFixed(1)}" fill="#ff8a8a" ` +
      `font-size="13" font-family="${F}">${e.v} m/s at ${Math.round(s.t)} s</text>`;
});
const s0 = samples[0] || { x: 0, z: 0 };
marks += `<circle cx="${px(s0.z).toFixed(1)}" cy="${py(s0.x).toFixed(1)}" r="9" fill="none" stroke="#4cd6a0" stroke-width="3"/>` +
  `<text x="${(px(s0.z) + 13).toFixed(1)}" y="${(py(s0.x) + 5).toFixed(1)}" fill="#4cd6a0" font-size="14" font-weight="700" font-family="${F}">START</text>`;
const near = Math.abs(px(last.z) - px(s0.z)) < 260;
marks += `<circle cx="${px(last.z).toFixed(1)}" cy="${py(last.x).toFixed(1)}" r="9" fill="none" stroke="#e8e8ff" stroke-width="3"/>` +
  `<text x="${(px(last.z) + 13).toFixed(1)}" y="${(py(last.x) + (near ? 30 : 5)).toFixed(1)}" fill="#e8e8ff" ` +
  `font-size="14" font-weight="700" font-family="${F}">SESSION ENDED  ${Math.round(last.kmh)} km/h</text>`;

/* scale bar, 500 m */
const sbx = W - M.r - 500 * scZ - 10, sby = MAP_H - 16;
const scaleBar = `<line x1="${sbx.toFixed(1)}" y1="${sby}" x2="${(sbx + 500 * scZ).toFixed(1)}" y2="${sby}" ` +
  `stroke="#8a93aa" stroke-width="2"/><text x="${(sbx + 250 * scZ).toFixed(1)}" y="${sby - 6}" fill="#8a93aa" ` +
  `font-size="12" font-family="${F}" text-anchor="middle">500 m</text>`;

const mapSvg = Buffer.from(
  `<svg width="${W}" height="${MAP_H}" xmlns="http://www.w3.org/2000/svg">` +
  `<rect width="${W}" height="${MAP_H}" fill="#10131c"/>` + road + tun + trace + marks + scaleBar +
  `<text x="16" y="24" fill="#c8d2ea" font-size="15" font-weight="700" font-family="${F}">` +
  `THE DRIVE, SEEN FROM ABOVE — line colour is speed, red = slow</text>` +
  `<text x="${W - 16}" y="24" fill="#6f7a94" font-size="13" font-family="${F}" text-anchor="end">` +
  `across-the-road axis exaggerated ${EXAG.toFixed(0)}× — otherwise a 3.7 m lane change is one pixel</text></svg>`);

/* ---------- legend ---------- */
let legend = `<rect width="${W}" height="${LEG}" fill="#0a0c12"/>`;
const LX = 16, LW = 300;
for (let i = 0; i < LW; i++) {
  legend += `<rect x="${LX + i}" y="14" width="1.2" height="16" fill="${col((i / LW) * 240)}"/>`;
}
legend += `<text x="${LX}" y="42" fill="#8a93aa" font-size="12" font-family="${F}">0</text>` +
  `<text x="${LX + LW}" y="42" fill="#8a93aa" font-size="12" font-family="${F}" text-anchor="end">240 km/h</text>` +
  `<circle cx="${LX + LW + 60}" cy="22" r="11" fill="none" stroke="#ff3b3b" stroke-width="2.6"/>` +
  `<path d="M${LX + LW + 55},17 l10,10 M${LX + LW + 65},17 l-10,10" stroke="#fff" stroke-width="2.4"/>` +
  `<text x="${LX + LW + 78}" y="27" fill="#c8d2ea" font-size="13" font-family="${F}">crash (${crashes.length})</text>` +
  `<circle cx="${LX + LW + 210}" cy="22" r="4.6" fill="none" stroke="#ffd166" stroke-width="1.8"/>` +
  `<text x="${LX + LW + 222}" y="27" fill="#c8d2ea" font-size="13" font-family="${F}">near miss (${nears.length})</text>` +
  `<rect x="${LX + LW + 350}" y="16" width="26" height="12" fill="#7f8cff" opacity="0.28"/>` +
  `<text x="${LX + LW + 384}" y="27" fill="#c8d2ea" font-size="13" font-family="${F}">in the tunnel</text>` +
  `<text x="${W - 16}" y="27" fill="#8a93aa" font-size="13" font-family="${F}" text-anchor="end">` +
  `${samples.length} samples · ${batches.length} batches · ${jsonBytes} B of JSON · ` +
  `${(perMin / 1024).toFixed(2)} KB per minute of play</text>`;
const legSvg = Buffer.from(`<svg width="${W}" height="${LEG}" xmlns="http://www.w3.org/2000/svg">${legend}</svg>`);

/* ---------- speed against the clock ---------- */
const SM = { l: 58, r: 26, t: 26, b: 28 };
const SPW = W - SM.l - SM.r, SPH = STRIP_H - SM.t - SM.b;
const tMax = Math.max(1, last.t), vMax = 240;
const sx = (t) => SM.l + (t / tMax) * SPW;
const sy = (v) => SM.t + SPH - (Math.min(v, vMax) / vMax) * SPH;
let strip = `<rect width="${W}" height="${STRIP_H}" fill="#10131c"/>`;
for (const v of [60, 120, 180, 240]) {
  strip += `<line x1="${SM.l}" y1="${sy(v)}" x2="${W - SM.r}" y2="${sy(v)}" stroke="#242c3e" stroke-width="1"/>` +
    `<text x="${SM.l - 8}" y="${(sy(v) + 4).toFixed(1)}" fill="#6f7a94" font-size="12" font-family="${F}" text-anchor="end">${v}</text>`;
}
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1], b = samples[i];
  strip += `<line x1="${sx(a.t).toFixed(1)}" y1="${sy(a.kmh).toFixed(1)}" x2="${sx(b.t).toFixed(1)}" ` +
    `y2="${sy(b.kmh).toFixed(1)}" stroke="${col(b.kmh)}" stroke-width="2.4" stroke-linecap="round"/>`;
}
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1], b = samples[i];
  if (a.tun && b.tun)
    strip += `<rect x="${sx(a.t).toFixed(1)}" y="${SM.t}" width="${Math.max(1, sx(b.t) - sx(a.t)).toFixed(1)}" ` +
      `height="${SPH}" fill="#7f8cff" opacity="0.13"/>`;
}
for (const e of crashes) {
  const s = at(e.i);
  strip += `<line x1="${sx(s.t).toFixed(1)}" y1="${SM.t}" x2="${sx(s.t).toFixed(1)}" y2="${SM.t + SPH}" ` +
    `stroke="#ff3b3b" stroke-width="1.6" opacity="0.85"/>` +
    `<text x="${(sx(s.t) + 4).toFixed(1)}" y="${SM.t + 14}" fill="#ff8a8a" font-size="12" font-family="${F}">crash</text>`;
}
for (const e of nears) {
  const s = at(e.i);
  strip += `<circle cx="${sx(s.t).toFixed(1)}" cy="${(SM.t + SPH - 6).toFixed(1)}" r="3" fill="#ffd166" opacity="0.85"/>`;
}
for (let m = 0; m * 30 <= tMax; m++) {
  const t = m * 30;
  strip += `<line x1="${sx(t).toFixed(1)}" y1="${SM.t + SPH}" x2="${sx(t).toFixed(1)}" y2="${SM.t + SPH + 5}" stroke="#6f7a94"/>` +
    `<text x="${sx(t).toFixed(1)}" y="${SM.t + SPH + 20}" fill="#6f7a94" font-size="12" font-family="${F}" text-anchor="middle">${t}s</text>`;
}
strip += `<text x="16" y="18" fill="#c8d2ea" font-size="15" font-weight="700" font-family="${F}">` +
  `THE SAME DRIVE AGAINST THE CLOCK — km/h</text>`;
const stripSvg = Buffer.from(`<svg width="${W}" height="${STRIP_H}" xmlns="http://www.w3.org/2000/svg">${strip}</svg>`);

const bar = (text, col2, w = W, h = BAR, fs = 22) => Buffer.from(
  `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
  `<rect width="${w}" height="${h}" fill="#0a0c12"/>` +
  `<text x="16" y="${h / 2 + 8}" font-family="${F}" font-size="${fs}" font-weight="700" fill="${col2}">${esc(text)}</text></svg>`);

const title = `ONE SESSION, REPLAYED FROM STATE — ${Math.round(last.t)} s of driving, ` +
  `${crashes.length} crashes, ${nears.length} near misses, no video`;
const H = BAR + MAP_H + LEG + GAP + STRIP_H;
await sharp({ create: { width: W, height: H, channels: 3, background: "#0a0c12" } })
  .composite([
    { input: bar(title, "#4cd6a0"), top: 0, left: 0 },
    { input: mapSvg, top: BAR, left: 0 },
    { input: legSvg, top: BAR + MAP_H, left: 0 },
    { input: stripSvg, top: BAR + MAP_H + LEG + GAP, left: 0 },
  ]).webp({ quality: 88 }).toFile(OUT);
console.log("wrote " + OUT);
console.log(`  ${samples.length} samples, ${batches.length} batches, ${jsonBytes} B JSON, ` +
  `${(perMin / 1024).toFixed(2)} KB/min, ${crashes.length} crashes, ${nears.length} near misses`);

/* the crop that makes it judgeable: the busiest 900 m of the map, big enough
   to read a crash marker in */
if (CROP && crashes.length) {
  const c0 = at(crashes[0].i);
  const cw = Math.min(W, 1000), cx = Math.max(0, Math.min(W - cw, px(c0.z) - cw / 2));
  await sharp({ create: { width: cw, height: BAR + MAP_H, channels: 3, background: "#0a0c12" } })
    .composite([
      { input: bar(`CRASH AT ${Math.round(c0.t)} s — ${crashes[0].v} m/s, ${Math.round(c0.kmh)} km/h`, "#ff8a8a", cw, 46, 19), top: 0, left: 0 },
      { input: await sharp(mapSvg).extract({ left: Math.round(cx), top: 0, width: cw, height: MAP_H }).toBuffer(), top: 46, left: 0 },
    ]).webp({ quality: 90 }).toFile(CROP);
  console.log("wrote " + CROP);
}
