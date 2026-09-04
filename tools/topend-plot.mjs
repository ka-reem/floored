#!/usr/bin/env node
/* Turns test/topend-sim.mjs's trace dump into the two pictures the top-end
   report leads with:

     top-end-speed.png  — speed against time, today vs the three variants,
                          with the mph segment times called out. The main one.
     top-end-accel.png  — acceleration against speed, which is where the
                          fall-off the owner described is actually visible.

   SVG is written by hand and rasterised with sharp (already a dependency);
   there is no plotting library in this repo and no GPU to spare.

   Usage:
     node test/topend-sim.mjs --csv <dir>
     node tools/topend-plot.mjs <dir> <outdir>
*/
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const [, , dataDir, outDir] = process.argv;
if (!dataDir || !outDir) {
  console.error("usage: node tools/topend-plot.mjs <dataDir> <outDir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const runs = JSON.parse(readFileSync(path.join(dataDir, "topend.json"), "utf8"));

/* ---- palette (validated categorical slots + text tokens) ---- */
const INK = "#0b0b0b", INK2 = "#52514e", MUTED = "#8a8880";
const SURFACE = "#fcfcfb", GRID = "#e6e5e0", PANEL = "#f4f3ef";
const STYLE = {
  today:     { c: "#52514e", w: 3,   dash: "9 7",  label: "TODAY" },
  mild:      { c: "#eb6834", w: 3.5, dash: null,   label: "MILD" },
  realistic: { c: "#2a78d6", w: 5,   dash: null,   label: "REALISTIC" },
  firm:      { c: "#1baf7a", w: 3.5, dash: null,   label: "FIRM" },
};
const ORDER = ["today", "mild", "realistic", "firm"];
const BLURB = {
  today: "what the car does now",
  mild: "still pulls hard everywhere, just stops climbing sooner",
  realistic: "quick to 60, then the air starts winning  ← RECOMMENDED",
  firm: "you have to really want the last 20 mph",
};
const by = Object.fromEntries(runs.map((r) => [r.name, r]));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const txt = (x, y, s, o = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${o.fill ?? INK}" ` +
  `font-family="DejaVu Sans, Verdana, sans-serif" font-size="${o.size ?? 22}" ` +
  `font-weight="${o.weight ?? 400}" text-anchor="${o.anchor ?? "start"}"` +
  `${o.spacing ? ` letter-spacing="${o.spacing}"` : ""}>${esc(s)}</text>`;

/* ================= figure 1: speed vs time ================= */
function speedFigure() {
  const W = 1760, H = 1180;
  const L = 116, R = W - 330, T = 168, B = 726;          // plot box
  const TMAX = 90, VMAX = 180;                            // axes
  const px = (t) => L + (t / TMAX) * (R - L);
  const py = (v) => B - (v / VMAX) * (B - T);
  const o = [];

  o.push(`<rect width="${W}" height="${H}" fill="${SURFACE}"/>`);
  o.push(txt(L, 62, "The car stops pulling sooner", { size: 42, weight: 700 }));
  o.push(txt(L, 102, "Speed against time, flat out from a standstill — today's physics and three ways of tapering it off.",
    { size: 23, fill: INK2 }));
  o.push(txt(L, 134, "Flatter to the right = the drop-off the owner asked for. The dashed grey line is the car as it is today.",
    { size: 23, fill: INK2 }));

  /* grid + axes */
  for (let v = 0; v <= VMAX; v += 20) {
    o.push(`<line x1="${L}" y1="${py(v)}" x2="${R}" y2="${py(v)}" stroke="${GRID}" stroke-width="1.5"/>`);
    o.push(txt(L - 16, py(v) + 8, `${v}`, { size: 21, fill: MUTED, anchor: "end" }));
  }
  for (let t = 0; t <= TMAX; t += 10) {
    o.push(`<line x1="${px(t)}" y1="${T}" x2="${px(t)}" y2="${B}" stroke="${GRID}" stroke-width="1.5"/>`);
    o.push(txt(px(t), B + 34, `${t}`, { size: 21, fill: MUTED, anchor: "middle" }));
  }
  o.push(`<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="${INK2}" stroke-width="2"/>`);
  o.push(txt((L + R) / 2, B + 70, "seconds from a standing start", { size: 23, fill: INK2, anchor: "middle" }));
  o.push(txt(L - 16, T - 22, "mph", { size: 23, fill: INK2, anchor: "end" }));

  /* the 120-140 mph band — the segment the complaint is about */
  o.push(`<rect x="${L}" y="${py(140)}" width="${R - L}" height="${py(120) - py(140)}" fill="#2a78d6" opacity="0.055"/>`);
  for (const v of [60, 100, 120, 140]) {
    o.push(`<line x1="${L}" y1="${py(v)}" x2="${R}" y2="${py(v)}" stroke="${MUTED}" stroke-width="1.6" stroke-dasharray="5 6"/>`);
  }
  o.push(txt(R - 10, py(140) + 30, "the 120 → 140 mph band",
    { size: 21, fill: "#2a78d6", weight: 700, anchor: "end" }));

  /* traces */
  for (const name of ORDER) {
    const r = by[name]; if (!r) continue;
    const s = STYLE[name];
    const pts = r.trace.filter((p) => p.t <= TMAX).map((p) => `${px(p.t).toFixed(1)},${py(p.mph).toFixed(1)}`);
    o.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${s.c}" stroke-width="${s.w}" ` +
           `${s.dash ? `stroke-dasharray="${s.dash}" ` : ""}stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  /* direct labels: a legend block in the right gutter, ordered by where the
     lines finish, so identity is never colour alone and nothing overlaps */
  ORDER.slice().sort((a, b) => by[b].vmaxMph - by[a].vmaxMph).forEach((n, i) => {
    const s = STYLE[n], r = by[n], y = T + 52 + i * 74;
    o.push(`<rect x="${R + 30}" y="${y - 22}" width="30" height="10" rx="5" fill="${s.c}"/>`);
    o.push(txt(R + 72, y - 12, s.label, { size: 25, weight: 700, fill: s.c, spacing: 1 }));
    o.push(txt(R + 30, y + 16, `tops out ${r.vmaxMph.toFixed(0)} mph`, { size: 21, fill: INK2 }));
  });

  /* the headline callout, parked in the empty bottom-right of the plot */
  const ax0 = px(41), ay0 = py(62);
  o.push(txt(ax0, ay0, "120 \u2192 140 mph takes:", { size: 27, weight: 700 }));
  ORDER.forEach((n, i) => {
    const s = STYLE[n], r = by[n];
    const v = r.marks[120] !== undefined && r.marks[140] !== undefined
      ? `${(r.marks[140] - r.marks[120]).toFixed(1)} s` : "never gets there";
    o.push(`<rect x="${ax0}" y="${ay0 + 26 + i * 38}" width="26" height="9" rx="4" fill="${s.c}"/>`);
    o.push(txt(ax0 + 40, ay0 + 36 + i * 38, s.label, { size: 22, weight: 700, fill: s.c, spacing: 1 }));
    o.push(txt(ax0 + 320, ay0 + 36 + i * 38, v, { size: 24, anchor: "end" }));
  });

  /* ---- segment table ---- */
  const cols = ["0–30", "30–60", "60–100", "100–120", "120–140", "140–150"];
  const pairs = [[0, 30], [30, 60], [60, 100], [100, 120], [120, 140], [140, 150]];
  const TY = 828, rowH = 56, cx0 = 348, cw = 178;
  o.push(`<rect x="${L - 24}" y="${TY - 66}" width="${W - 2 * (L - 24)}" height="${rowH * 5 + 92}" rx="10" fill="${PANEL}"/>`);
  o.push(txt(L, TY - 26, "How long each stretch takes — seconds", { size: 27, weight: 700 }));
  o.push(txt(L, TY + 4, "the lower half of the range barely moves; the top of it is where the change lands",
    { size: 20, fill: INK2 }));
  cols.forEach((c, i) =>
    o.push(txt(cx0 + i * cw + cw / 2, TY + 46, `${c} mph`, { size: 21, fill: INK2, anchor: "middle", weight: 700 })));
  o.push(txt(cx0 + cols.length * cw + 92, TY + 46, "top speed", { size: 21, fill: INK2, anchor: "middle", weight: 700 }));
  ORDER.forEach((name, ri) => {
    const r = by[name], s = STYLE[name], y = TY + 46 + (ri + 1) * rowH;
    o.push(`<line x1="${L}" y1="${y - 38}" x2="${W - L + 24}" y2="${y - 38}" stroke="${GRID}" stroke-width="1.5"/>`);
    o.push(`<rect x="${L}" y="${y - 26}" width="26" height="9" rx="4" fill="${s.c}"/>`);
    o.push(txt(L + 40, y - 16, s.label, { size: 23, weight: 700, fill: s.c, spacing: 1 }));
    o.push(txt(L + 40, y + 12, BLURB[name], { size: 19, fill: INK2 }));
    pairs.forEach(([a, b], i) => {
      const va = r.marks[a] ?? (a === 0 ? 0 : undefined), vb = r.marks[b];
      const v = va !== undefined && vb !== undefined ? (vb - va).toFixed(1) : "—";
      const hot = a === 120;
      o.push(txt(cx0 + i * cw + cw / 2, y - 6, v,
        { size: hot ? 32 : 28, weight: hot ? 700 : 400, anchor: "middle", fill: hot ? s.c : INK }));
    });
    o.push(txt(cx0 + cols.length * cw + 92, y - 6, `${r.vmaxMph.toFixed(0)} mph`,
      { size: 26, anchor: "middle", fill: INK }));
    o.push(txt(cx0 + cols.length * cw + 92, y + 18, `${r.vmaxKmh.toFixed(0)} km/h`,
      { size: 19, anchor: "middle", fill: MUTED }));
  });
  o.push(txt(L, H - 26, "NEON EXPRESSWAY · player car · full throttle, flat road, no traffic · measured with test/topend-sim.mjs on the real physics",
    { size: 19, fill: MUTED }));
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${o.join("")}</svg>`, W, H };
}

/* ================= figure 2: acceleration vs speed ================= */
function accelFigure() {
  const W = 1760, H = 940;
  const L = 132, R = W - 330, T = 178, B = 782;
  const SMAX = 180, AMAX = 9.0;                      // mph, m/s^2
  const px = (v) => L + (v / SMAX) * (R - L);
  const py = (a) => B - (a / AMAX) * (B - T);
  const o = [];

  o.push(`<rect width="${W}" height="${H}" fill="${SURFACE}"/>`);
  o.push(txt(L, 62, "Where the pull dies", { size: 42, weight: 700 }));
  o.push(txt(L, 102, "How hard the car is still shoving at each speed. Higher = more shove. This is the drop-off, seen directly.",
    { size: 23, fill: INK2 }));
  o.push(txt(L, 134, "Today's grey line is still pushing hard at 140 mph. The coloured ones have run out of air and gearing by then.",
    { size: 23, fill: INK2 }));

  for (let a = 0; a <= AMAX; a += 1) {
    o.push(`<line x1="${L}" y1="${py(a)}" x2="${R}" y2="${py(a)}" stroke="${GRID}" stroke-width="1.5"/>`);
    o.push(txt(L - 16, py(a) + 8, a.toFixed(0), { size: 21, fill: MUTED, anchor: "end" }));
  }
  for (let v = 0; v <= SMAX; v += 20) {
    o.push(`<line x1="${px(v)}" y1="${T}" x2="${px(v)}" y2="${B}" stroke="${GRID}" stroke-width="1.5"/>`);
    o.push(txt(px(v), B + 34, `${v}`, { size: 21, fill: MUTED, anchor: "middle" }));
  }
  o.push(`<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="${INK2}" stroke-width="2"/>`);
  o.push(txt((L + R) / 2, B + 70, "speed, mph", { size: 23, fill: INK2, anchor: "middle" }));
  o.push(txt(L - 52, T - 12, "acceleration, m/s²   (1 g ≈ 9.8)", { size: 23, fill: INK2 }));

  o.push(`<rect x="${px(120)}" y="${T}" width="${px(140) - px(120)}" height="${B - T}" fill="#2a78d6" opacity="0.06"/>`);
  o.push(txt(px(130), T - 14, "120 – 140 mph", { size: 21, fill: "#2a78d6", weight: 700, anchor: "middle" }));

  for (const name of ORDER) {
    const r = by[name]; if (!r) continue;
    const s = STYLE[name];
    /* Acceleration re-differenced over a +/-0.25 s window rather than the
       trace's own 0.05 s step: a real driver feels the pull averaged over
       about that long, and it turns each gearchange's throttle cut into the
       shallow notch it feels like instead of a full-depth spike. Then
       median-binned into 2 mph bins to kill the remaining sample noise. */
    const tr = r.trace, K = 5, DTT = 0.05;
    const bins = new Map();
    for (let i = K; i < tr.length - K; i++) {
      if (tr[i].mph < 3) continue;
      const a = (tr[i + K].mph - tr[i - K].mph) / (2 * K * DTT) / 2.2369362920544;
      const k = Math.round(tr[i].mph / 2) * 2;
      (bins.get(k) ?? bins.set(k, []).get(k)).push(a);
    }
    const pts = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([v, arr]) => {
      arr.sort((a, b) => a - b);
      return [v, Math.max(0, arr[Math.floor(arr.length / 2)])];
    });
    const d = pts.map(([v, a]) => `${px(v).toFixed(1)},${py(Math.min(a, AMAX)).toFixed(1)}`);
    o.push(`<polyline points="${d.join(" ")}" fill="none" stroke="${s.c}" stroke-width="${s.w}" ` +
           `${s.dash ? `stroke-dasharray="${s.dash}" ` : ""}stroke-linejoin="round" stroke-linecap="round"/>`);
  }

  /* legend in the right gutter, ordered by where each line reaches zero */
  const lab = ORDER.map((n) => ({ n, v: by[n].vmaxMph })).sort((a, b) => b.v - a.v);
  lab.forEach((e, i) => {
    const s = STYLE[e.n], y = T + 44 + i * 60;
    o.push(`<rect x="${R + 30}" y="${y - 20}" width="26" height="9" rx="4" fill="${s.c}"/>`);
    o.push(txt(R + 68, y - 10, s.label, { size: 24, weight: 700, fill: s.c, spacing: 1 }));
    o.push(txt(R + 30, y + 18, `dies at ${e.v.toFixed(0)} mph`, { size: 20, fill: INK2 }));
  });

  /* what is actually left at 140 mph — the reading behind the complaint */
  const bx = px(86), byy = py(8.3);
  o.push(txt(bx, byy, "still pulling at 140 mph:", { size: 26, weight: 700 }));
  ORDER.forEach((n, i) => {
    const st = STYLE[n], tr = by[n].trace, K = 5, DTT = 0.05;
    let best = null;
    for (let i2 = K; i2 < tr.length - K; i2++) {
      if (Math.abs(tr[i2].mph - 140) > 1.2) continue;
      const a = (tr[i2 + K].mph - tr[i2 - K].mph) / (2 * K * DTT) / 2.2369362920544;
      if (best === null || a > best) best = a;
    }
    const y = byy + 26 + i * 38;
    o.push(`<rect x="${bx}" y="${y - 10}" width="26" height="9" rx="4" fill="${st.c}"/>`);
    o.push(txt(bx + 40, y, st.label, { size: 22, weight: 700, fill: st.c, spacing: 1 }));
    o.push(txt(bx + 330, y, best === null ? "never reaches it" : `${best.toFixed(2)} m/s\u00b2`,
      { size: 23, anchor: "end" }));
  });

  o.push(txt(L, H - 26, "NEON EXPRESSWAY · player car · gear-change notches are real — the box is shifting · test/topend-sim.mjs",
    { size: 19, fill: MUTED }));
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${o.join("")}</svg>`, W, H };
}

for (const [file, fig] of [["top-end-speed.png", speedFigure()], ["top-end-accel.png", accelFigure()]]) {
  const p = path.join(outDir, file);
  await sharp(Buffer.from(fig.svg), { density: 96 }).png().toFile(p);
  console.log("wrote", p);
}
