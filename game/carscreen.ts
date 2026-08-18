import { getCorridor, TUNNEL, TOLL } from "./world/corridor";
import { HX } from "./world/const";
import { TAU } from "./util";
import type { NavWorld, NavEdge, NavRamp } from "./cockpit";

/* CarPlay-style head unit for the cockpit's centre-stack screen: a split UI on
   the existing 256x160 canvas — a live nav map on the left (~60%), a music
   player card on the right (~40%), thin bezel and a glass reflection over the
   lot.

   Cost model (this repaints on cockpit.ts's ~45 ms drawScreen cadence):
   - The NAV PANE redraws fully every call — it pans and rotates with the car,
     so there is nothing to cache. The drawing is the same road-network walk
     the old full-screen nav did (which itself mirrors minimap.ts), kept
     allocation-free: module-scratch points, no per-point tuples, and every
     gradient is built once per canvas and cached.
   - The MUSIC CARD renders to an offscreen canvas and is repainted only when
     its content changes: a track change (~ every 2.5-3.5 real minutes) or the
     progress bar growing by a pixel (~ every 2.5 s). Per frame it costs one
     drawImage.
   - The GLASS overlays (bezel, reflection, vignette) reuse cached gradients:
     three fills and a stroke per frame. */

/* ------------------------------------------------------------- geometry -- */

const W = 256, H = 160;
const NAV_W = 154;                 // split: left 60% map, right 40% music
const NCX = 77, NCY = 100;         // chevron centre — low, so more road ahead shows
const SC = 1.45;                   // px per metre
const R = 95;                      // metres of world drawn around the car
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
  bg: CanvasGradient;      // nav-pane ground
  reflect: CanvasGradient; // diagonal glass sheen
  vign: CanvasGradient;    // corner falloff
  music: HTMLCanvasElement;
  mg: CanvasRenderingContext2D;
  trackIdx: number;
  trackStart: number;      // performance.now() when the track began
  paintedIdx: number;      // last track painted into the music canvas
  paintedPx: number;       // last progress-bar width painted
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
  const bg = g.createRadialGradient(NCX, NCY - 20, 12, NCX, NCY - 20, 150);
  bg.addColorStop(0, "#101722");
  bg.addColorStop(1, "#080b12");
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
    g, bg, reflect, vign, music, mg: music.getContext("2d")!,
    trackIdx: 0, trackStart: 0, paintedIdx: -1, paintedPx: -1,
  };
  // Same trick for the card's offscreen context: logical coords, scaled store.
  s.mg.setTransform(scale, 0, 0, scale, 0, 0);
  states.set(cv, s);
  return s;
}

/* ------------------------------------------------------------- scratch -- */

const LAPS = [0, -1, 1]; // corridor drawn in place and a lap either side
const NO_LAPS: number[] = [];

const _p = { x: 0, y: 0, z: 0 }; // corridor.worldOf output
const _s = { x: 0, y: 0 };       // world→screen output
let _cx = 0, _cz = 0, _sin = 0, _cos = 0; // view params for the current call

/** Heading-up world→screen into _s: car-forward maps to screen-up. */
function toS(wx: number, wz: number) {
  const dx = wx - _cx, dz = wz - _cz;
  _s.x = NCX + (dx * _cos - dz * _sin) * SC;
  _s.y = NCY - (dx * _sin + dz * _cos) * SC;
}

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

/* ------------------------------------------------------------ nav pane -- */

function drawNav(g: CanvasRenderingContext2D, st: ScreenState,
  x: number, z: number, h: number, timeH: number, world?: NavWorld) {
  g.save();
  g.beginPath();
  g.rect(0, 0, NAV_W, H);
  g.clip();
  g.fillStyle = st.bg;
  g.fillRect(0, 0, NAV_W, H);

  _cx = x; _cz = z; _sin = Math.sin(h); _cos = Math.cos(h);

  // world-aligned grid: the faint block texture that makes it read as a map
  // app rather than a radar. Rotates with the view because it lives in world
  // space; 40 m pitch keeps it ~8 lines a direction.
  g.strokeStyle = "rgba(90,120,170,.10)";
  g.lineWidth = 1;
  const GP = 40;
  for (let gx = Math.floor((x - R) / GP) * GP; gx <= x + R; gx += GP) {
    toS(gx, z - R); g.beginPath(); g.moveTo(_s.x, _s.y);
    toS(gx, z + R); g.lineTo(_s.x, _s.y); g.stroke();
  }
  for (let gz = Math.floor((z - R) / GP) * GP; gz <= z + R; gz += GP) {
    toS(x - R, gz); g.beginPath(); g.moveTo(_s.x, _s.y);
    toS(x + R, gz); g.lineTo(_s.x, _s.y); g.stroke();
  }

  if (world) {
    // nearest road under the car, so the one being driven reads as "current"
    let bestEdge: NavEdge | null = null, bestRamp: NavRamp | null = null, bestD = 26;
    for (const e of world.net.edges) {
      const n = e.ss.length - 1;
      for (let i = 0; i <= n; i += 3) {
        const dx = e.pts[i * 3] - x, dz = e.pts[i * 3 + 2] - z;
        const d = Math.hypot(dx, dz);
        if (d < bestD) { bestD = d; bestEdge = e; bestRamp = null; }
      }
    }
    for (const r of world.terrain?.ramps ?? []) {
      for (const p of r.pts) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bestD) { bestD = d; bestRamp = r; bestEdge = null; }
      }
    }

    // town roads: dark casing + lighter fill, two passes, map-app style
    for (let pass = 0; pass < 2; pass++) {
      for (const e of world.net.edges) {
        const n = e.ss.length - 1;
        const mx = e.pts[Math.floor(n / 2) * 3], mz = e.pts[Math.floor(n / 2) * 3 + 2];
        if (Math.hypot(mx - x, mz - z) > R + e.len / 2) continue;
        const cur = e === bestEdge;
        if (pass === 0) {
          g.strokeStyle = "rgba(10,14,22,.9)";
          g.lineWidth = cur ? 6.5 : 4.5;
        } else {
          g.strokeStyle = cur ? "#3f87f5" : "rgba(135,155,190,.72)";
          g.lineWidth = cur ? 4.5 : 2.6;
        }
        g.beginPath();
        let started = false;
        for (let i = 0; i <= n; i += 2) {
          toS(e.pts[i * 3], e.pts[i * 3 + 2]);
          if (_s.x < -20 || _s.x > NAV_W + 20 || _s.y < -20 || _s.y > H + 20) { started = false; continue; }
          if (!started) { g.moveTo(_s.x, _s.y); started = true; } else g.lineTo(_s.x, _s.y);
        }
        g.stroke();
      }
    }

    /* Expressway corridor, traced from the live alignment (same walk as
       minimap.ts) — drawn in place and a lap either side so the loop splice
       never pops. When the car is on the deck the pavement fills route-blue:
       that IS the route line, corridor-wide. */
    {
      const cor = getCorridor();
      const stn = cor.stations;
      const step = (stn.length > 1 ? stn[1].z - stn[0].z : 4) || 4;
      const onDeck = cor.heightAt(x, z, 4) !== null;
      const curDeck = !bestEdge && !bestRamp && onDeck;
      const corNear = stn.length > 1 && Math.abs(x - HX) < R + 90;
      const paveAt = (lo: number, hi: number, dz: number): boolean => {
        const i0 = Math.max(0, Math.ceil((lo - stn[0].z) / step));
        const i1 = Math.min(stn.length - 1, Math.floor((hi - stn[0].z) / step));
        if (i1 - i0 < 1) return false;
        g.beginPath();
        for (let i = i0; i <= i1; i++) {
          cor.worldOf(stn[i].z, stn[i].hw, _p);
          toS(_p.x, _p.z + dz);
          if (i === i0) g.moveTo(_s.x, _s.y); else g.lineTo(_s.x, _s.y);
        }
        for (let i = i1; i >= i0; i--) {
          cor.worldOf(stn[i].z, -stn[i].hw, _p);
          toS(_p.x, _p.z + dz);
          g.lineTo(_s.x, _s.y);
        }
        g.closePath();
        return true;
      };
      const centreAt = (lo: number, hi: number, dz: number): boolean => {
        const i0 = Math.max(0, Math.ceil((lo - stn[0].z) / step));
        const i1 = Math.min(stn.length - 1, Math.floor((hi - stn[0].z) / step));
        if (i1 - i0 < 1) return false;
        g.beginPath();
        for (let i = i0; i <= i1; i++) {
          toS(stn[i].x, stn[i].z + dz);
          if (i === i0) g.moveTo(_s.x, _s.y); else g.lineTo(_s.x, _s.y);
        }
        return true;
      };
      for (const lap of corNear ? LAPS : NO_LAPS) {
        const dz = lap * cor.LOOP;
        const lo = Math.max(cor.ZB0, z - R - dz);
        const hi = Math.min(cor.ZB1, z + R - dz);
        if (hi - lo < 8) continue;
        if (paveAt(lo, hi, dz)) {
          g.fillStyle = curDeck ? "rgba(38,102,220,.9)" : "rgba(44,72,112,.85)";
          g.fill();
          g.strokeStyle = curDeck ? "#7db6ff" : "rgba(110,160,220,.8)";
          g.lineWidth = curDeck ? 2 : 1.4;
          g.stroke();
        }
        // tunnel: roofed, so grey the deck back out
        const tLo = Math.max(lo, TUNNEL.z0), tHi = Math.min(hi, TUNNEL.z1);
        if (tHi > tLo && paveAt(tLo, tHi, dz)) {
          g.fillStyle = "rgba(10,13,20,.72)";
          g.fill();
        }
        // toll plaza fan-out
        const kLo = Math.max(lo, TOLL.plazaZ0), kHi = Math.min(hi, TOLL.plazaZ1);
        if (kHi > kLo && paveAt(kLo, kHi, dz)) {
          g.fillStyle = "rgba(255,210,120,.28)";
          g.fill();
        }
        if (centreAt(lo, hi, dz)) {
          g.strokeStyle = curDeck ? "rgba(235,245,255,.85)" : "rgba(190,220,255,.45)";
          g.lineWidth = 1;
          g.stroke();
        }
      }
    }

    // ramps
    for (const r of world.terrain?.ramps ?? []) {
      const mx = (r.x0 + r.x1) / 2, mz = (r.z0 + r.z1) / 2;
      if (Math.hypot(mx - x, mz - z) > R + 60) continue;
      const cur = r === bestRamp;
      g.strokeStyle = cur ? "#3f87f5" : "rgba(110,190,160,.75)";
      g.lineWidth = cur ? 4.5 : 2.6;
      g.beginPath();
      let started = false;
      for (const p of r.pts) {
        toS(p.x, p.z);
        if (_s.x < -20 || _s.x > NAV_W + 20 || _s.y < -20 || _s.y > H + 20) { started = false; continue; }
        if (!started) { g.moveTo(_s.x, _s.y); started = true; } else g.lineTo(_s.x, _s.y);
      }
      g.stroke();
    }

    // exits: POI dot + name
    g.font = "700 7px sans-serif";
    g.textAlign = "left";
    const cor = getCorridor();
    for (const ex of world.exits ?? []) {
      if (Math.abs(ex.z - z) > R) continue;
      cor.worldOf(ex.z, -(cor.halfWidth(ex.z) + 14), _p);
      toS(_p.x, _p.z);
      if (_s.x < -6 || _s.x > NAV_W - 4 || _s.y < 26 || _s.y > H - 22) continue;
      g.fillStyle = "#8fd9b5";
      g.beginPath();
      g.arc(_s.x, _s.y, 2, 0, TAU);
      g.fill();
      g.fillText(`${ex.no} ${ex.name}`, _s.x + 4, _s.y + 2.5);
    }
  }

  // player chevron: white arrow in a route-blue puck, CarPlay-style
  g.fillStyle = "rgba(80,150,255,.28)";
  g.beginPath(); g.arc(NCX, NCY, 11, 0, TAU); g.fill();
  g.fillStyle = "#2f7ae5";
  g.beginPath(); g.arc(NCX, NCY, 8, 0, TAU); g.fill();
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(NCX, NCY - 5.5);
  g.lineTo(NCX + 4, NCY + 4.5);
  g.lineTo(NCX, NCY + 2);
  g.lineTo(NCX - 4, NCY + 4.5);
  g.closePath();
  g.fill();

  // status strip: clock (the game's in-game clock, hours 0-24) + GPS glyphs
  rr(g, 5, 5, 88, 15, 7.5);
  g.fillStyle = "rgba(8,11,18,.78)";
  g.fill();
  g.strokeStyle = "rgba(255,255,255,.07)";
  g.lineWidth = 1;
  g.stroke();
  const hh = timeH | 0, mm = ((timeH % 1) * 60) | 0;
  g.fillStyle = "#dde4f0";
  g.font = "700 9px sans-serif";
  g.textAlign = "left";
  g.fillText((hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm, 12, 16);
  // signal bars
  g.fillStyle = "#9aa6bc";
  for (let b = 0; b < 3; b++) g.fillRect(60 + b * 4, 15 - b * 2.4, 2.6, 2.6 + b * 2.4);
  // GPS arrow
  g.beginPath();
  g.moveTo(84, 8);
  g.lineTo(87.5, 16.5);
  g.lineTo(84, 14.5);
  g.lineTo(80.5, 16.5);
  g.closePath();
  g.fill();

  // route banner along the bottom, with a lane-guidance arrow
  rr(g, 5, H - 20, 96, 15, 7.5);
  g.fillStyle = "rgba(8,11,18,.78)";
  g.fill();
  g.strokeStyle = "rgba(255,255,255,.07)";
  g.stroke();
  g.fillStyle = "#6fb2ff";
  g.beginPath();
  g.moveTo(14, H - 16);
  g.lineTo(17.5, H - 8.5);
  g.lineTo(14, H - 10.5);
  g.lineTo(10.5, H - 8.5);
  g.closePath();
  g.fill();
  g.fillStyle = "#cfd8e8";
  g.font = "600 8px sans-serif";
  g.fillText("首都高 C1 環状線", 23, H - 9);

  // compass: north needle, correct under the heading-up rotation
  g.fillStyle = "rgba(8,11,18,.7)";
  g.beginPath(); g.arc(NAV_W - 14, H - 13, 8, 0, TAU); g.fill();
  const nx = -_sin, ny = -_cos; // screen direction of world north (+z)
  g.strokeStyle = "#e26a5a";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(NAV_W - 14, H - 13);
  g.lineTo(NAV_W - 14 + nx * 5.5, H - 13 + ny * 5.5);
  g.stroke();
  g.strokeStyle = "#8b93a5";
  g.beginPath();
  g.moveTo(NAV_W - 14, H - 13);
  g.lineTo(NAV_W - 14 - nx * 4, H - 13 - ny * 4);
  g.stroke();

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

  // ---- left: nav map (full redraw — it pans/rotates every frame) ----------
  drawNav(g, st, x, z, h, timeH, world);

  // ---- right: cached music card, one blit ---------------------------------
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
