/* Top-down plan of BOTH corridors at each mountain gore, before and after,
   stacked into one picture per junction with the clearance annotated in
   metres. This is the drawing that proves the fix — a night photograph of a
   dark rock against a dark deck cannot.

   Frame: the corridor's own. Horizontal axis is deck z, vertical axis is
   lateral offset from the deck centreline, so the expressway is a straight
   grey band and "the gap" is a vertical distance you can put a ruler on.
   That is exact here and not a projection trick: both gores sit inside the
   splice band, which is straight and level by construction (see corridor.MTN).

   Usage:
     node test/mtn-gore-plan.mjs --before <git-ref> [--after <git-ref>] \
       --outdir <dir>
   `--after` defaults to the working tree.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const BEFORE = arg("--before", "");
const AFTER = arg("--after", "");
const OUTDIR = arg("--outdir", process.cwd());
mkdirSync(OUTDIR, { recursive: true });

/* game/util.ts is in the list because corridor.ts and ramps.ts import it;
   compiling from a copy means every source they reach has to be copied too. */
const SRC = ["game/world/corridor.ts", "game/world/ramps.ts", "game/world/routegraph.ts",
  "game/world/const.ts", "game/util.ts"];

/** Build one revision (or the working tree) and return its plan geometry. */
async function load(ref, label) {
  const work = mkdtempSync(path.join(tmpdir(), "goreplan-"));
  /* Always compile from a COPY, never from the repo root: a tsconfig.json
     beside the sources makes some TypeScript versions refuse a file list
     outright, and which version npx resolves here is not stable. */
  const root = path.join(work, "src");
  for (const f of SRC) {
    mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(root, f), ref
      ? execFileSync("git", ["show", `${ref}:${f}`], { encoding: "utf8", maxBuffer: 1 << 26 })
      : readFileSync(f, "utf8"));
  }
  const js = path.join(work, "js");
  execFileSync("npx", ["tsc", ...SRC, "--outDir", js, "--rootDir", ".",
    "--module", "esnext", "--target", "es2020", "--moduleResolution", "bundler",
    "--skipLibCheck"], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  const dir = path.join(js, "game", "world");
  for (const f of ["corridor.js", "ramps.js", "routegraph.js", "const.js"]) {
    const p = path.join(dir, f);
    writeFileSync(p, readFileSync(p, "utf8").replace(/"(\.\.?\/[\w\/]+)"/g, '"$1.js"'));
  }
  const { getCorridor } = await import(path.join(dir, "corridor.js"));
  const { getRouteGraph, MTN } = await import(path.join(dir, "routegraph.js"));
  const cor = getCorridor();
  const mt = getRouteGraph().mtn;

  /* highway.ts buildMountainRoad's west-side extents, re-derived (that module
     needs three.js and will not run headless) — kept in step with the source
     by test/mountain-gap.mjs, which asserts the same numbers. */
  const sstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const rockKs = (s) => sstep((s - 18) / 50) * sstep((mt.len - 22 - s) / 50);
  const roomOf = (p, hwR) => {
    /* the fix's own limiter, read back out of the built route: how far west
       of this station's centre the scenery is allowed to reach. Present only
       on the fixed revision; `null` means "unlimited", which is the bug. */
    return typeof mt.westLimit === "function" ? mt.westLimit(p.s) : null;
  };
  const proj = (p, lat) => {
    const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
    const zc = cor.zAt(x, z);
    return { zc, lat: cor.latAt(x, z), hw: cor.halfWidth(zc) };
  };

  const rows = [];
  for (const p of mt.stations) {
    const { hwL, hwR } = mt.halfWidths(p.s);
    const sh = mt.sharedSides(p.s);
    const lim = roomOf(p, hwR);
    const K = rockKs(p.s) * (lim === null ? 1 : sstep((lim - (hwR + 1.0)) / 9));
    const clamp = (v) => (lim === null ? v : Math.min(v, lim));
    const r = {
      s: p.s, y: p.y,
      pav: proj(p, -hwR), pavE: proj(p, hwL),
      wall: (!sh.shR && hwR >= 0.55 && K < 0.7) ? proj(p, -clamp(hwR + 0.36)) : null,
      rock: (!sh.shR && K > 0.02) ? proj(p, -clamp(hwR + 12)) : null,
    };
    rows.push(r);
  }
  const deck = [];
  for (let z = MTN.divergeZ - 60; z <= MTN.mergeZ + 60; z += 2)
    deck.push({ zc: z, hw: cor.halfWidth(z) });
  return { label, rows, deck, MTN, len: mt.len, hasLimit: typeof mt.westLimit === "function" };
}

const A = await load(BEFORE, `BEFORE${BEFORE ? ` (${BEFORE.slice(0, 9)})` : ""}`);
const B = await load(AFTER, AFTER ? `AFTER (${AFTER.slice(0, 9)})` : "AFTER");

/* ---- drawing ------------------------------------------------------------ */
const PANEL_W = 1500, PANEL_H = 470, PAD_L = 78, PAD_R = 26, PAD_T = 46, PAD_B = 40;

let panelSeq = 0;
function panel(g, win, yOff, title) {
  const [z0, z1] = win;
  const latLo = -26, latHi = 62;
  const CLIP = `clip${panelSeq++}`;
  const px = (z) => PAD_L + ((z - z0) / (z1 - z0)) * (PANEL_W - PAD_L - PAD_R);
  const py = (lat) => yOff + PAD_T + ((latHi - lat) / (latHi - latLo)) * (PANEL_H - PAD_T - PAD_B);
  const seg = (rows, pick) => {
    const out = [];
    let run = [];
    for (const r of rows) {
      const v = pick(r);
      if (!v || v.zc < z0 || v.zc > z1) { if (run.length > 1) out.push(run); run = []; continue; }
      run.push([px(v.zc), py(v.lat)]);
    }
    if (run.length > 1) out.push(run);
    return out;
  };
  const pl = (runs, stroke, w, extra = "") => runs.map((r) =>
    `<polyline points="${r.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="${stroke}" stroke-width="${w}" ${extra}/>`).join("");

  const deckIn = g.deck.filter((d) => d.zc >= z0 && d.zc <= z1);
  const deckBand = `<polygon points="${deckIn.map((d) => `${px(d.zc).toFixed(1)},${py(d.hw).toFixed(1)}`).join(" ")} ${[...deckIn].reverse().map((d) => `${px(d.zc).toFixed(1)},${py(-d.hw).toFixed(1)}`).join(" ")}" fill="#5a6270" fill-opacity="0.55" stroke="#98a2b0" stroke-width="1.4"/>`;

  /* mountain pavement ribbon */
  const ribbon = [];
  {
    let run = [];
    const flush = () => {
      if (run.length > 1)
        ribbon.push(`<polygon points="${run.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")} ${[...run].reverse().map((p) => `${p[0].toFixed(1)},${p[2].toFixed(1)}`).join(" ")}" fill="#5ce1ff" fill-opacity="0.3" stroke="#5ce1ff" stroke-width="1.3"/>`);
      run = [];
    };
    for (const r of g.rows) {
      if (r.pav.zc < z0 || r.pav.zc > z1) { flush(); continue; }
      run.push([px(r.pav.zc), py(r.pav.lat), py(r.pavE.lat)]);
    }
    flush();
  }

  /* the rock footprint: from the pavement's west edge out to the flank foot */
  const rockPoly = [];
  {
    let run = [];
    const flush = () => {
      if (run.length > 1)
        rockPoly.push(`<polygon points="${run.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")} ${[...run].reverse().map((p) => `${p[0].toFixed(1)},${p[2].toFixed(1)}`).join(" ")}" fill="#b0652f" fill-opacity="0.42" stroke="#e08a45" stroke-width="1.3"/>`);
      run = [];
    };
    for (const r of g.rows) {
      if (!r.rock || r.rock.zc < z0 || r.rock.zc > z1) { flush(); continue; }
      run.push([px(r.rock.zc), py(r.rock.lat), py(r.pav.lat)]);
    }
    flush();
  }

  /* Worst clearance in this window over the SCENERY. The pavement is left
     out on purpose: routegraph clips it to abut the deck exactly, so it
     reads 0.00 on both sides of the fix and would always win the pick. */
  let worst = null;
  for (const r of g.rows) {
    for (const [kind, v] of [["rock face", r.rock], ["parapet", r.wall]]) {
      if (!v || v.zc < z0 || v.zc > z1) continue;
      const gap = v.lat - v.hw;
      if (!worst || gap < worst.gap) worst = { gap, kind, ...v };
    }
  }
  const wx = px(worst.zc), wy0 = py(worst.hw), wy1 = py(worst.lat);
  const bad = worst.gap < 0;
  const col = bad ? "#ff5470" : "#5ee08a";
  const ann = `
   <line x1="${wx.toFixed(1)}" y1="${wy0.toFixed(1)}" x2="${wx.toFixed(1)}" y2="${wy1.toFixed(1)}" stroke="${col}" stroke-width="3"/>
   <circle cx="${wx.toFixed(1)}" cy="${wy0.toFixed(1)}" r="3.4" fill="${col}"/>
   <circle cx="${wx.toFixed(1)}" cy="${wy1.toFixed(1)}" r="3.4" fill="${col}"/>
   <rect x="${(wx + 10).toFixed(1)}" y="${((wy0 + wy1) / 2 - 17).toFixed(1)}" width="360" height="34" rx="5" fill="#12151b" stroke="${col}" stroke-width="1.4"/>
   <text x="${(wx + 20).toFixed(1)}" y="${((wy0 + wy1) / 2 + 6).toFixed(1)}" fill="${col}" font-size="17" font-weight="700" font-family="ui-monospace,monospace">${worst.kind}: ${worst.gap >= 0 ? "+" : ""}${worst.gap.toFixed(2)} m ${bad ? "OVER THE DECK" : "clear of the deck"}</text>`;

  /* axis: lateral ticks and a z scale bar */
  let axis = "";
  for (let lat = -20; lat <= 60; lat += 10)
    axis += `<line x1="${PAD_L}" y1="${py(lat).toFixed(1)}" x2="${(PANEL_W - PAD_R).toFixed(1)}" y2="${py(lat).toFixed(1)}" stroke="#2a2f38" stroke-width="1"/>` +
      `<text x="${PAD_L - 9}" y="${(py(lat) + 5).toFixed(1)}" fill="#68727f" font-size="12" text-anchor="end" font-family="ui-monospace,monospace">${lat} m</text>`;
  for (let z = Math.ceil(z0 / 20) * 20; z <= z1; z += 20)
    axis += `<line x1="${px(z).toFixed(1)}" y1="${(yOff + PANEL_H - PAD_B).toFixed(1)}" x2="${px(z).toFixed(1)}" y2="${(yOff + PANEL_H - PAD_B + 6).toFixed(1)}" stroke="#68727f" stroke-width="1"/>` +
      `<text x="${px(z).toFixed(1)}" y="${(yOff + PANEL_H - PAD_B + 22).toFixed(1)}" fill="#68727f" font-size="12" text-anchor="middle" font-family="ui-monospace,monospace">z ${z}</text>`;

  /* every panel is clipped to its own band — without this the second panel's
     polygons draw across the first one's axis */
  return `<g>
   <clipPath id="${CLIP}"><rect x="0" y="${yOff.toFixed(1)}" width="${PANEL_W}" height="${(PANEL_H - 6).toFixed(1)}"/></clipPath>
   <text x="${PAD_L}" y="${(yOff + 28).toFixed(1)}" fill="#fff" font-size="20" font-weight="700" font-family="ui-sans-serif,system-ui">${title}</text>
   <g clip-path="url(#${CLIP})">
   ${axis}
   ${deckBand}
   ${rockPoly.join("")}
   ${ribbon.join("")}
   ${pl(seg(g.rows, (r) => r.wall), "#ffd27a", 2.2)}
   ${ann}
   </g>
  </g>`;
}

const legend = (y) => `
 <g font-family="ui-sans-serif,system-ui" font-size="13">
  <rect x="78" y="${y}" width="26" height="12" fill="#5a6270" fill-opacity="0.55" stroke="#98a2b0"/><text x="112" y="${y + 11}" fill="#98a2b0">expressway deck pavement</text>
  <rect x="330" y="${y}" width="26" height="12" fill="#5ce1ff" fill-opacity="0.3" stroke="#5ce1ff"/><text x="364" y="${y + 11}" fill="#5ce1ff">mountain road pavement</text>
  <rect x="586" y="${y}" width="26" height="12" fill="#b0652f" fill-opacity="0.42" stroke="#e08a45"/><text x="620" y="${y + 11}" fill="#e08a45">rock cut face + back flank (footprint)</text>
  <line x1="922" y1="${y + 6}" x2="948" y2="${y + 6}" stroke="#ffd27a" stroke-width="2.2"/><text x="956" y="${y + 11}" fill="#ffd27a">stone parapet</text>
 </g>`;

for (const [name, win, heading] of [
  ["diverge", [A.MTN.divergeZ - 20, A.MTN.divergeZ + 130], "EXIT 4 DIVERGE — mountain road leaving the expressway"],
  ["merge", [A.MTN.mergeZ - 130, A.MTN.mergeZ + 20], "EXIT 4 MERGE — mountain road rejoining the expressway"],
]) {
  const H = PANEL_H * 2 + 96;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${H}" viewBox="0 0 ${PANEL_W} ${H}">
 <rect width="${PANEL_W}" height="${H}" fill="#0a0c10"/>
 <text x="${PAD_L}" y="30" fill="#fff" font-size="24" font-weight="800" font-family="ui-sans-serif,system-ui">${heading}</text>
 <text x="${PAD_L}" y="52" fill="#8b98a6" font-size="14" font-family="ui-monospace,monospace">plan view, corridor frame · vertical axis is lateral offset from the deck centreline · to scale</text>
 <g transform="translate(0,44)">${panel(A, win, 0, A.label)}</g>
 <g transform="translate(0,44)">${panel(B, win, PANEL_H, B.label)}</g>
 ${legend(H - 26)}
</svg>`;
  const out = path.join(OUTDIR, `mtn-gore-${name}.svg`);
  writeFileSync(out, svg);
  console.log("wrote", out);
}
