import { getCorridor, TUNNEL, TOLL } from "./world/corridor";
import { getRouteGraph } from "./world/routegraph";
import { TAU } from "./util";
import type { NavWorld } from "./cockpit";

/* CarPlay-style head unit for the cockpit's centre-stack screen: a split UI on
   the existing 256x160 canvas — a nav map pane (~60%), a music player card
   (~40%), thin bezel and a glass reflection over the lot.

   The nav pane is a STATIC, NORTH-UP overview: the full route network (one
   canonical lap of the expressway loop, the bypass viaduct, both town ramps
   and the town road grid) is fitted once to the pane and never pans or
   rotates. The only per-frame motion is the player marker — a chevron puck
   that tracks (x, z) through a fixed world→pane transform and rotates to show
   heading — plus the live overlays (route-blue highlight of the surface being
   driven, the clock pill and the route banner). A paper map with a moving
   you-are-here dot.

   Cost model (this repaints on cockpit.ts's ~45 ms drawScreen cadence):
   - The BASEMAP (ground, graticule, town roads, ramps, corridor with its
     TUNNEL/TOLL styling, bypass ribbon, exit markers, labels, compass, loop
     arrows) renders ONCE into an offscreen canvas at the backing-store scale,
     lazily on the first draw (rebuilt a single time when the road-graph world
     first arrives). Two more offscreen canvases hold the route-blue highlight
     for the main loop and for the bypass. Per frame the pane costs one or two
     drawImage calls plus the marker, pill and banner — no path walks, no
     gradient builds, no allocations.
   - The MUSIC CARD renders to an offscreen canvas and is repainted only when
     its content changes: a track change (~ every 2.5-3.5 real minutes) or the
     progress bar growing by a pixel (~ every 2.5 s). Per frame it costs one
     drawImage.
   - The GLASS overlays (bezel, reflection, vignette) reuse cached gradients:
     three fills and a stroke per frame. */

/* ------------------------------------------------------------- geometry -- */

const W = 256, H = 160;
const NAV_W = 154;                 // split: ~60% map, ~40% music
/** pane origin x — the map pane's left edge on the 256-wide screen */
const NAV_X = 0;
/** margin around the fitted network inside the pane */
const MARG = 9;
const CARD = { x: 159, y: 6, w: 91, h: 148 };
const BAR_X = 168, BAR_W = 73, BAR_Y = 128; // progress bar, inside the card

/* ------------------------------------------------------------ tracklist -- */

interface Track { title: string; artist: string; dur: number; c0: string; c1: string; motif: number }

/** Fictional night-drive rotation. `dur` is real seconds, so a track turns
    over every 2.5-3.5 minutes of play. */
export const TRACKS: Track[] = [
  { title: "Midnight Loop", artist: "Neon Arcade", dur: 187, c0: "#ff5f6d", c1: "#2b1055", motif: 0 },
  { title: "Chrome Horizon", artist: "Vantablack FM", dur: 178, c0: "#41c7c7", c1: "#0b2447", motif: 1 },
  { title: "Overpass", artist: "Sodium Glow", dur: 162, c0: "#ffb347", c1: "#3d1c02", motif: 2 },
  { title: "Ghost Lane", artist: "The Tollbooths", dur: 199, c0: "#b39ddb", c1: "#12081f", motif: 3 },
  { title: "Tail Lights", artist: "Aya Reiko", dur: 176, c0: "#ff4e6a", c1: "#1a0b2e", motif: 4 },
  { title: "Interchange", artist: "Motorway Club", dur: 193, c0: "#7ee787", c1: "#032b1a", motif: 5 },
  { title: "First Light", artist: "Kaido Drift", dur: 168, c0: "#9fd8ff", c1: "#123", motif: 6 },
];

/* ------------------------------------------------------- per-canvas state -- */

interface ScreenState {
  g: CanvasRenderingContext2D;
  reflect: CanvasGradient; // diagonal glass sheen
  vign: CanvasGradient;    // corner falloff
  music: HTMLCanvasElement;
  mg: CanvasRenderingContext2D;
  trackIdx: number;
  trackStart: number;      // performance.now() when the track began
  paintedIdx: number;      // last track painted into the music canvas
  paintedPx: number;       // last progress-bar width painted
  /** on-bypass latch: the pane has no y, so under/over the bridge crossing is
      disambiguated by continuity (see drawNav) */
  wasBy: boolean;
  /** backing-store scale (canvas px per logical px) */
  scale: number;
  /** static north-up basemap, rendered once (see buildBase) */
  base: HTMLCanvasElement | null;
  /** route-blue highlight overlays: main loop / bypass */
  hlMain: HTMLCanvasElement | null;
  hlBy: HTMLCanvasElement | null;
  /** whether the basemap was built with the road-graph world available */
  baseHasWorld: boolean;
  /** the fixed world→pane fit: pane = pane-centre + (world − mapC) · mapS */
  mapS: number;
  mapCX: number;
  mapCZ: number;
}

const states = new WeakMap<HTMLCanvasElement, ScreenState>();

function stateFor(cv: HTMLCanvasElement): ScreenState {
  let s = states.get(cv);
  if (s) return s;
  const g = cv.getContext("2d")!;
  /* All drawing below uses the module's logical 256x160 space; a base
     transform maps it onto whatever resolution the canvas actually is, so
     the cockpit can raise the backing store for a sharper panel without
     touching any coordinates. save/restore pairs preserve a base transform,
     so this survives every code path. */
  const scale = cv.width / W;
  g.setTransform(scale, 0, 0, cv.height / H, 0, 0);
  const reflect = g.createLinearGradient(0, 0, W * 0.75, H);
  reflect.addColorStop(0, "rgba(190,215,255,.085)");
  reflect.addColorStop(0.32, "rgba(190,215,255,.02)");
  reflect.addColorStop(0.5, "rgba(190,215,255,0)");
  const vign = g.createRadialGradient(W / 2, H / 2, 70, W / 2, H / 2, 170);
  vign.addColorStop(0, "rgba(0,0,0,0)");
  vign.addColorStop(1, "rgba(0,0,0,.42)");
  const music = document.createElement("canvas");
  music.width = (W - NAV_W) * scale;
  music.height = H * scale;
  s = {
    g, reflect, vign, music, mg: music.getContext("2d")!,
    trackIdx: 0, trackStart: 0, paintedIdx: -1, paintedPx: -1, wasBy: false,
    scale, base: null, hlMain: null, hlBy: null, baseHasWorld: false,
    mapS: 1, mapCX: 0, mapCZ: 0,
  };
  // Same trick for the card's offscreen context: logical coords, scaled store.
  s.mg.setTransform(scale, 0, 0, scale, 0, 0);
  states.set(cv, s);
  return s;
}

/* ------------------------------------------------------------- scratch -- */

const _p = { x: 0, y: 0, z: 0 }; // corridor.worldOf output (build-time only)
const EMPTY_DASH: number[] = [];

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* ---------------------------------------------------------- music card -- */

/** Procedural square album art: a two-stop gradient plus one simple motif per
    track, so each cover is distinct at 68 px. */
function paintArt(mg: CanvasRenderingContext2D, t: Track, x: number, y: number, s: number) {
  const gr = mg.createLinearGradient(x, y, x + s, y + s);
  gr.addColorStop(0, t.c0);
  gr.addColorStop(1, t.c1);
  mg.fillStyle = gr;
  mg.fillRect(x, y, s, s);
  mg.fillStyle = "rgba(255,255,255,.22)";
  mg.strokeStyle = "rgba(255,255,255,.3)";
  const cx = x + s / 2, cy = y + s / 2;
  switch (t.motif) {
    case 0: { // low sun over a grid horizon
      mg.beginPath(); mg.arc(cx, cy - 6, 14, 0, TAU); mg.fill();
      mg.fillStyle = "rgba(0,0,0,.35)";
      for (let i = 0; i < 3; i++) mg.fillRect(x, cy - 4 + i * 5, s, 2);
      break;
    }
    case 1: { // skyline bars
      mg.fillStyle = "rgba(0,0,0,.4)";
      for (let i = 0; i < 5; i++) mg.fillRect(x + 6 + i * 12, y + 18 + ((i * 13) % 22), 8, s);
      break;
    }
    case 2: { // overpass wedge
      mg.beginPath(); mg.moveTo(x + 4, y + s - 8); mg.lineTo(cx, y + 10); mg.lineTo(x + s - 4, y + s - 8);
      mg.closePath(); mg.fill();
      break;
    }
    case 3: { // twin headlight rings
      mg.lineWidth = 3;
      mg.beginPath(); mg.arc(cx - 12, cy, 10, 0, TAU); mg.stroke();
      mg.beginPath(); mg.arc(cx + 12, cy, 10, 0, TAU); mg.stroke();
      break;
    }
    case 4: { // streaking tail lights
      mg.lineWidth = 4; mg.lineCap = "round";
      mg.strokeStyle = "rgba(255,255,255,.35)";
      for (let i = 0; i < 3; i++) {
        mg.beginPath(); mg.moveTo(x + 6, y + 16 + i * 16); mg.lineTo(x + s - 10 - i * 8, y + 10 + i * 16); mg.stroke();
      }
      break;
    }
    case 5: { // interchange loop
      mg.lineWidth = 4;
      mg.beginPath(); mg.arc(cx, cy, 16, 0.6, TAU - 0.6); mg.stroke();
      mg.beginPath(); mg.moveTo(cx + 10, cy + 12); mg.lineTo(x + s - 6, y + s - 6); mg.stroke();
      break;
    }
    default: { // crescent
      mg.beginPath(); mg.arc(cx + 4, cy - 4, 14, 0, TAU); mg.fill();
      mg.fillStyle = t.c1;
      mg.beginPath(); mg.arc(cx - 2, cy - 8, 12, 0, TAU); mg.fill();
    }
  }
  // gloss
  const gl = mg.createLinearGradient(x, y, x, y + s * 0.5);
  gl.addColorStop(0, "rgba(255,255,255,.14)");
  gl.addColorStop(1, "rgba(255,255,255,0)");
  mg.fillStyle = gl;
  mg.fillRect(x, y, s, s * 0.5);
}

/** Repaint the whole card into the offscreen canvas. Only called when the
    track flips or the progress bar grows a pixel. Coordinates here are in the
    card's own canvas space (origin at screen x = NAV_W). */
function paintMusic(st: ScreenState, px: number) {
  const mg = st.mg, t = TRACKS[st.trackIdx];
  const x0 = CARD.x - NAV_W, y0 = CARD.y, cw = CARD.w, ch = CARD.h;
  const cx = x0 + cw / 2;
  mg.clearRect(0, 0, st.music.width, st.music.height);
  // pane ground behind the floating card
  mg.fillStyle = "#0a0d13";
  mg.fillRect(0, 0, st.music.width, st.music.height);
  // card
  rr(mg, x0, y0, cw, ch, 9);
  mg.fillStyle = "#141822";
  mg.fill();
  mg.strokeStyle = "rgba(255,255,255,.08)";
  mg.lineWidth = 1;
  mg.stroke();
  // header: generic note glyph + "Music" (no Apple marks anywhere)
  mg.fillStyle = "#8f98ab";
  mg.beginPath(); mg.arc(x0 + 10, y0 + 12, 2.4, 0, TAU); mg.fill();
  mg.fillRect(x0 + 11.6, y0 + 3.6, 1.4, 8.6);
  mg.fillRect(x0 + 11.6, y0 + 3.6, 5.4, 2);
  mg.font = "600 8px sans-serif";
  mg.textAlign = "left";
  mg.fillText("Music", x0 + 21, y0 + 15);
  // album art
  const as = 68, ax = (cx - as / 2) | 0, ay = y0 + 22;
  mg.save();
  rr(mg, ax, ay, as, as, 6);
  mg.clip();
  paintArt(mg, t, ax, ay, as);
  mg.restore();
  rr(mg, ax, ay, as, as, 6);
  mg.strokeStyle = "rgba(0,0,0,.5)";
  mg.stroke();
  // title / artist
  mg.textAlign = "center";
  mg.fillStyle = "#eef1f7";
  mg.font = "700 9px sans-serif";
  let title = t.title;
  while (mg.measureText(title).width > cw - 10 && title.length > 3) title = title.slice(0, -2);
  mg.fillText(title, cx, ay + as + 14);
  mg.fillStyle = "#98a1b3";
  mg.font = "8px sans-serif";
  mg.fillText(t.artist, cx, ay + as + 25);
  // progress bar
  const bx = BAR_X - NAV_W;
  rr(mg, bx, BAR_Y, BAR_W, 3, 1.5);
  mg.fillStyle = "rgba(255,255,255,.16)";
  mg.fill();
  if (px > 2) {
    rr(mg, bx, BAR_Y, px, 3, 1.5);
    mg.fillStyle = "#6fb2ff";
    mg.fill();
  }
  // transport glyphs: prev | pause | next
  const gy = BAR_Y + 15;
  mg.fillStyle = "#dfe4ec";
  /** dir = +1 points right, -1 points left */
  const tri = (tx: number, dir: number) => {
    mg.beginPath();
    mg.moveTo(tx - dir * 4, gy - 4);
    mg.lineTo(tx + dir * 3, gy);
    mg.lineTo(tx - dir * 4, gy + 4);
    mg.closePath();
    mg.fill();
  };
  tri(cx - 26, -1); tri(cx - 19, -1);       // prev ◀◀
  mg.fillRect(cx - 4, gy - 5, 3, 10);       // pause
  mg.fillRect(cx + 1, gy - 5, 3, 10);
  tri(cx + 19, 1); tri(cx + 26, 1);         // next ▶▶
}

/* ------------------------------------------------- static basemap build -- */

/** Render the whole route network once, north-up, fitted to the pane.
    Called lazily from drawNav on the first paint, and once more when the
    road-graph world first shows up so the town grid joins the map. Build
    cost is irrelevant — it runs once — which is exactly what buys the
    per-frame budget of a drawImage plus the marker. */
function buildBase(st: ScreenState, world?: NavWorld) {
  const cor = getCorridor();
  const rg = getRouteGraph();
  const stn = cor.stations;
  const bst = rg.bypass.stations;

  /* ---- bounds of everything drawn: one canonical lap of the corridor,
     the bypass with its widths, the town graph and the ramps ---- */
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  const grow = (wx: number, wz: number) => {
    if (wx < x0) x0 = wx;
    if (wx > x1) x1 = wx;
    if (wz < z0) z0 = wz;
    if (wz > z1) z1 = wz;
  };
  for (let i = 0; i < stn.length; i += 8) {
    const s = stn[i];
    if (s.z < cor.Z0 || s.z > cor.Z1) continue;
    grow(s.x - s.hw, s.z);
    grow(s.x + s.hw, s.z);
  }
  for (const p of bst) {
    grow(p.x + p.nx * p.hwL, p.z + p.nz * p.hwL);
    grow(p.x - p.nx * p.hwR, p.z - p.nz * p.hwR);
  }
  if (world) {
    for (const e of world.net.edges) {
      const n = e.ss.length - 1;
      for (let i = 0; i <= n; i += 2) grow(e.pts[i * 3], e.pts[i * 3 + 2]);
    }
    for (const r of world.terrain?.ramps ?? [])
      for (const p of r.pts) grow(p.x, p.z);
  }

  /* ---- the fit: uniform contain-scale, centred. The network is a tall strip
     (≈1000 x 4000 m), so the fit is z-bound and the map letterboxes in x —
     the margins are put to work holding the exit labels, feature tags and
     the compass. ---- */
  const S = Math.min(
    (NAV_W - 2 * MARG) / Math.max(1, x1 - x0),
    (H - 2 * MARG) / Math.max(1, z1 - z0),
  );
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  st.mapS = S;
  st.mapCX = cx;
  st.mapCZ = cz;
  /* north-up: +z is up, +x is right — the same convention as minimap.ts */
  const X = (wx: number) => NAV_W / 2 + (wx - cx) * S;
  const Y = (wz: number) => H / 2 - (wz - cz) * S;

  const sc = st.scale;
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(NAV_W * sc));
    c.height = Math.max(1, Math.round(H * sc));
    return c;
  };

  /* pane-local coordinates throughout (0..NAV_W x 0..H); drawNav blits the
     result at NAV_X, so the basemap itself is layout-agnostic */
  const base = mk();
  const b = base.getContext("2d")!;
  b.setTransform(sc, 0, 0, sc, 0, 0);
  b.lineCap = "round";
  b.lineJoin = "round";

  // ground
  b.fillStyle = "#0a0e16";
  b.fillRect(0, 0, NAV_W, H);
  const rad = b.createRadialGradient(NAV_W / 2, H / 2, 20, NAV_W / 2, H / 2, 120);
  rad.addColorStop(0, "#101722");
  rad.addColorStop(1, "rgba(16,23,34,0)");
  b.fillStyle = rad;
  b.fillRect(0, 0, NAV_W, H);

  // graticule: 500 m pitch, axis-aligned because the map never rotates
  b.strokeStyle = "rgba(90,120,170,.10)";
  b.lineWidth = 1;
  const GP = 500;
  const wx0 = cx - NAV_W / 2 / S, wx1 = cx + NAV_W / 2 / S;
  const wz0 = cz - H / 2 / S, wz1 = cz + H / 2 / S;
  for (let gx = Math.ceil(wx0 / GP) * GP; gx <= wx1; gx += GP) {
    b.beginPath();
    b.moveTo(X(gx), 0);
    b.lineTo(X(gx), H);
    b.stroke();
  }
  for (let gz = Math.ceil(wz0 / GP) * GP; gz <= wz1; gz += GP) {
    b.beginPath();
    b.moveTo(0, Y(gz));
    b.lineTo(NAV_W, Y(gz));
    b.stroke();
  }

  // town roads: dark casing + lighter fill, two passes, map-app style
  if (world) {
    for (let pass = 0; pass < 2; pass++) {
      b.strokeStyle = pass ? "rgba(135,155,190,.62)" : "rgba(10,14,22,.9)";
      b.lineWidth = pass ? 1.1 : 2.1;
      for (const e of world.net.edges) {
        const n = e.ss.length - 1;
        b.beginPath();
        for (let i = 0; i <= n; i += 2) {
          if (i === 0) b.moveTo(X(e.pts[0]), Y(e.pts[2]));
          else b.lineTo(X(e.pts[i * 3]), Y(e.pts[i * 3 + 2]));
        }
        b.stroke();
      }
    }
    // connector ramps
    b.strokeStyle = "rgba(110,190,160,.8)";
    b.lineWidth = 1.2;
    for (const r of world.terrain?.ramps ?? []) {
      b.beginPath();
      for (let i = 0; i < r.pts.length; i++) {
        const p = r.pts[i];
        if (i === 0) b.moveTo(X(p.x), Y(p.z));
        else b.lineTo(X(p.x), Y(p.z));
      }
      b.stroke();
    }
  }

  /* the expressway: one canonical lap of the centreline. At this zoom the
     24 m pavement is under a pixel wide, so the deck is a stroked line with
     screen-space width — classic paper-map rendering. */
  const corPath = (ctx: CanvasRenderingContext2D, zLo: number, zHi: number): boolean => {
    ctx.beginPath();
    let first = true;
    for (let i = 0; i < stn.length; i += 4) {
      const s = stn[i];
      if (s.z < zLo || s.z > zHi) continue;
      if (first) { ctx.moveTo(X(s.x), Y(s.z)); first = false; }
      else ctx.lineTo(X(s.x), Y(s.z));
    }
    return !first;
  };
  const byPath = (ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    for (let i = 0; i < bst.length; i += 2) {
      const p = bst[i];
      if (i === 0) ctx.moveTo(X(p.x), Y(p.z));
      else ctx.lineTo(X(p.x), Y(p.z));
    }
  };

  corPath(b, cor.Z0, cor.Z1);
  b.strokeStyle = "rgba(8,12,20,.9)";
  b.lineWidth = 4.2;
  b.stroke();
  corPath(b, cor.Z0, cor.Z1);
  b.strokeStyle = "rgba(96,130,182,.95)";
  b.lineWidth = 2.6;
  b.stroke();
  // toll plaza: amber band over the widened window
  if (corPath(b, TOLL.plazaZ0, TOLL.plazaZ1)) {
    b.strokeStyle = "rgba(255,210,120,.6)";
    b.lineWidth = 3.6;
    b.stroke();
  }
  // tunnel: knocked back + dashed casing — the paper-map convention for roofed
  if (corPath(b, TUNNEL.z0, TUNNEL.z1)) {
    b.strokeStyle = "#0a0e16";
    b.lineWidth = 3;
    b.stroke();
    b.setLineDash([2.6, 2]);
    corPath(b, TUNNEL.z0, TUNNEL.z1);
    b.strokeStyle = "rgba(110,160,220,.8)";
    b.lineWidth = 1.5;
    b.stroke();
    b.setLineDash(EMPTY_DASH);
  }

  // the bypass viaduct: second ribbon over the corridor
  byPath(b);
  b.strokeStyle = "rgba(10,14,22,.9)";
  b.lineWidth = 3.4;
  b.stroke();
  byPath(b);
  b.strokeStyle = "rgba(150,132,230,.9)";
  b.lineWidth = 2;
  b.stroke();

  // loop seam: the lap's two ends are the same road — say so with chevrons
  b.fillStyle = "rgba(120,160,220,.85)";
  const sxT = X(cor.pose(cor.Z1).x), syT = Y(cor.Z1);
  const sxB = X(cor.pose(cor.Z0).x), syB = Y(cor.Z0);
  b.beginPath();
  b.moveTo(sxT, syT - 5);
  b.lineTo(sxT + 2.6, syT - 1);
  b.lineTo(sxT - 2.6, syT - 1);
  b.closePath();
  b.fill();
  b.beginPath();
  b.moveTo(sxB, syB + 5);
  b.lineTo(sxB + 2.6, syB + 1);
  b.lineTo(sxB - 2.6, syB + 1);
  b.closePath();
  b.fill();

  // feature tags, out in the letterbox margin east of the deck
  b.textAlign = "left";
  b.font = "600 6px sans-serif";
  const tag = (wz: number, txt: string, col: string) => {
    b.fillStyle = col;
    b.fillText(txt, X(cor.pose(wz).x) + 6, Y(wz) + 2);
  };
  tag((TUNNEL.z0 + TUNNEL.z1) / 2, "TUNNEL", "rgba(150,190,240,.85)");
  tag((TOLL.plazaZ0 + TOLL.plazaZ1) / 2, "TOLL", "rgba(255,210,120,.9)");

  // route names
  b.font = "700 5px sans-serif";
  b.fillStyle = "rgba(150,180,225,.7)";
  b.fillText("C1", X(cor.pose(-1200).x) + 5, Y(-1200) + 2);
  let bApex = bst[0]; // bypass label at its eastern apex
  for (const p of bst) if (p.x > bApex.x) bApex = p;
  b.fillStyle = "rgba(172,150,255,.75)";
  b.fillText("BYPASS", X(bApex.x) + 4, Y(bApex.z) + 2);

  // exits: gore dot on the deck's west edge, label out in the east margin
  if (world?.exits) {
    b.font = "700 6px sans-serif";
    for (const ex of world.exits) {
      cor.worldOf(ex.z, -(cor.halfWidth(ex.z) + 4), _p);
      const dx = X(_p.x), dy = Y(_p.z);
      const lx = X(cor.pose(ex.z).x) + 6;
      b.strokeStyle = "rgba(143,217,181,.35)";
      b.lineWidth = 0.8;
      b.beginPath();
      b.moveTo(dx + 2, dy);
      b.lineTo(lx - 1.5, dy);
      b.stroke();
      b.fillStyle = "#8fd9b5";
      b.beginPath();
      b.arc(dx, dy, 1.7, 0, TAU);
      b.fill();
      b.fillText(`${ex.no} ${ex.name}`, lx, dy + 2);
    }
  }

  // compass: static — north is simply up, always
  b.fillStyle = "rgba(8,11,18,.7)";
  b.beginPath();
  b.arc(NAV_W - 13, H - 15, 8, 0, TAU);
  b.fill();
  b.strokeStyle = "#e26a5a";
  b.lineWidth = 2;
  b.beginPath();
  b.moveTo(NAV_W - 13, H - 15);
  b.lineTo(NAV_W - 13, H - 20.5);
  b.stroke();
  b.strokeStyle = "#8b93a5";
  b.beginPath();
  b.moveTo(NAV_W - 13, H - 15);
  b.lineTo(NAV_W - 13, H - 11);
  b.stroke();
  b.fillStyle = "#dde4f0";
  b.font = "700 5px sans-serif";
  b.textAlign = "center";
  b.fillText("N", NAV_W - 13, H - 25);

  /* ---- highlight overlays: the route-blue "you are on this" layer, one per
     drivable surface, pre-rendered so per frame each costs one drawImage ---- */
  const hm = mk();
  const hg = hm.getContext("2d")!;
  hg.setTransform(sc, 0, 0, sc, 0, 0);
  hg.lineCap = "round";
  hg.lineJoin = "round";
  corPath(hg, cor.Z0, cor.Z1);
  hg.strokeStyle = "rgba(63,135,245,.30)";
  hg.lineWidth = 5.5;
  hg.stroke();
  corPath(hg, cor.Z0, cor.Z1);
  hg.strokeStyle = "#3f87f5";
  hg.lineWidth = 2.4;
  hg.stroke();

  const hb = mk();
  const bg = hb.getContext("2d")!;
  bg.setTransform(sc, 0, 0, sc, 0, 0);
  bg.lineCap = "round";
  bg.lineJoin = "round";
  byPath(bg);
  bg.strokeStyle = "rgba(63,135,245,.30)";
  bg.lineWidth = 5;
  bg.stroke();
  byPath(bg);
  bg.strokeStyle = "#3f87f5";
  bg.lineWidth = 2.2;
  bg.stroke();

  st.base = base;
  st.hlMain = hm;
  st.hlBy = hb;
  st.baseHasWorld = !!world;
}

/* ------------------------------------------------------------ nav pane -- */

function drawNav(g: CanvasRenderingContext2D, st: ScreenState,
  x: number, z: number, h: number, timeH: number, world?: NavWorld) {
  if (!st.base || (!st.baseHasWorld && world)) buildBase(st, world);

  g.save();
  g.beginPath();
  g.rect(NAV_X, 0, NAV_W, H);
  g.clip();

  // the whole static map: one blit
  g.drawImage(st.base!, NAV_X, 0, NAV_W, H);

  /* live route state. The pane has no y, so the bridge crossing (bypass OVER
     deck) is settled by continuity: once on the bypass, stay "on" it until
     its pavement is genuinely left — a deck car passing under never latches. */
  const cor = getCorridor();
  const onDeck = cor.heightAt(x, z, 4) !== null;
  const byHit = getRouteGraph().surfaceAt(x, z, 4);
  const onBy = !!byHit && (st.wasBy || !onDeck);
  st.wasBy = onBy;
  if (onBy) {
    if (st.hlBy) g.drawImage(st.hlBy, NAV_X, 0, NAV_W, H);
  } else if (onDeck && st.hlMain) {
    g.drawImage(st.hlMain, NAV_X, 0, NAV_W, H);
  }

  /* the marker — the ONLY thing that moves. Fold z into the canonical lap
     (the splice teleport means raw z can sit in the deck extensions), then
     the fixed north-up transform. rotate(h) is the corrected marker
     convention (identical to minimap.ts): h = 0 (north, +z) points up,
     heading east turns the chevron clockwise to the right, and a left turn
     in game spins it counterclockwise on screen. */
  let zw = z;
  while (zw >= cor.Z1) zw -= cor.LOOP;
  while (zw < cor.Z0) zw += cor.LOOP;
  const mx = NAV_X + NAV_W / 2 + (x - st.mapCX) * st.mapS;
  const my = H / 2 - (zw - st.mapCZ) * st.mapS;
  g.fillStyle = "rgba(80,150,255,.30)";
  g.beginPath();
  g.arc(mx, my, 6.5, 0, TAU);
  g.fill();
  g.fillStyle = "#2f7ae5";
  g.beginPath();
  g.arc(mx, my, 4.2, 0, TAU);
  g.fill();
  g.save();
  g.translate(mx, my);
  g.rotate(h);
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(0, -3.8);
  g.lineTo(2.7, 3.1);
  g.lineTo(0, 1.5);
  g.lineTo(-2.7, 3.1);
  g.closePath();
  g.fill();
  g.restore();

  // status strip: clock (the game's in-game clock, hours 0-24) + GPS glyphs
  rr(g, NAV_X + 5, 5, 88, 15, 7.5);
  g.fillStyle = "rgba(8,11,18,.78)";
  g.fill();
  g.strokeStyle = "rgba(255,255,255,.07)";
  g.lineWidth = 1;
  g.stroke();
  const hh = timeH | 0, mm = ((timeH % 1) * 60) | 0;
  g.fillStyle = "#dde4f0";
  g.font = "700 9px sans-serif";
  g.textAlign = "left";
  g.fillText((hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm, NAV_X + 12, 16);
  // signal bars
  g.fillStyle = "#9aa6bc";
  for (let b = 0; b < 3; b++)
    g.fillRect(NAV_X + 60 + b * 4, 15 - b * 2.4, 2.6, 2.6 + b * 2.4);
  // GPS arrow
  g.beginPath();
  g.moveTo(NAV_X + 84, 8);
  g.lineTo(NAV_X + 87.5, 16.5);
  g.lineTo(NAV_X + 84, 14.5);
  g.lineTo(NAV_X + 80.5, 16.5);
  g.closePath();
  g.fill();

  // route banner along the bottom
  rr(g, NAV_X + 5, H - 20, 96, 15, 7.5);
  g.fillStyle = "rgba(8,11,18,.78)";
  g.fill();
  g.strokeStyle = "rgba(255,255,255,.07)";
  g.stroke();
  g.fillStyle = "#6fb2ff";
  g.beginPath();
  g.moveTo(NAV_X + 14, H - 16);
  g.lineTo(NAV_X + 17.5, H - 8.5);
  g.lineTo(NAV_X + 14, H - 10.5);
  g.lineTo(NAV_X + 10.5, H - 8.5);
  g.closePath();
  g.fill();
  g.fillStyle = "#cfd8e8";
  g.font = "600 8px sans-serif";
  g.fillText(
    onBy ? "湾岸 Bypass ルート" : onDeck ? "首都高 C1 環状線" : "一般道 Surface Rd",
    NAV_X + 23, H - 9,
  );

  g.restore();
}

/* ---------------------------------------------------------- entry point -- */

/** Draw the whole head unit into `cv` (the cockpit's 256x160 screen canvas).
    Caller flips the CanvasTexture's needsUpdate. `timeH` is the in-game clock
    in hours; the music player runs on real time so the accelerated day/night
    clock doesn't spin the playlist. */
export function drawCarScreen(
  cv: HTMLCanvasElement, x: number, z: number, h: number, timeH: number, world?: NavWorld
) {
  const st = stateFor(cv);
  const g = st.g;

  // ---- music state: advance on real time, repaint only on visible change --
  const now = performance.now();
  if (!st.trackStart) st.trackStart = now;
  let t = TRACKS[st.trackIdx];
  if ((now - st.trackStart) / 1000 > t.dur) {
    st.trackIdx = (st.trackIdx + 1) % TRACKS.length;
    st.trackStart = now;
    t = TRACKS[st.trackIdx];
  }
  const px = Math.min(BAR_W, ((now - st.trackStart) / 1000 / t.dur * BAR_W) | 0);
  if (st.trackIdx !== st.paintedIdx || px !== st.paintedPx) {
    paintMusic(st, px);
    st.paintedIdx = st.trackIdx;
    st.paintedPx = px;
  }

  // ---- nav map: static basemap blit + marker + live overlays --------------
  drawNav(g, st, x, z, h, timeH, world);

  // ---- cached music card, one blit ----------------------------------------
  g.drawImage(st.music, NAV_W, 0, W - NAV_W, H);

  // ---- glass: bezel, reflection sweep, vignette ---------------------------
  g.fillStyle = st.reflect;
  g.fillRect(0, 0, W, H);
  g.fillStyle = st.vign;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "#03040a";
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, W - 3, H - 3);
  g.strokeStyle = "rgba(160,190,240,.10)";
  g.lineWidth = 1;
  g.strokeRect(3.5, 3.5, W - 7, H - 7);
}
