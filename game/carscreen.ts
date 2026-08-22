import { getCorridor } from "./world/corridor";
import { getRouteGraph } from "./world/routegraph";
import { drawMiniMap } from "./minimap";
import { TAU } from "./util";
import type { WorldData } from "./world/data";
import type { CarState } from "./physics";
import type { Npc } from "./traffic";

/* CarPlay-style head unit for the cockpit's centre-stack screen: a split UI on
   the existing 256x160 canvas — a nav map on the right (~60%), a music
   player card on the left (~40%), thin bezel and a glass reflection over the
   lot. (Map on the RIGHT: in the dashcam POV the left edge of the tablet is
   partially occluded by dash geometry, so the important pane lives right.)

   The nav pane is the SAME MAP the HUD overlay draws — drawMiniMap from
   minimap.ts, into an offscreen pane canvas, with the pane's own scale and
   cadence passed in as options. It replaced a static whole-network overview
   that was fitted once and never panned: at that fit the ~1 x 4 km network
   squeezed into 154 px, every town street collapsed onto its neighbours and
   the car crawled across it a pixel at a time. The overlay's car-centred view
   is the one that actually shows the road you are on — swept pavement edges
   with the tunnel and toll plaza called out, the bypass ribbon, real ramp
   centrelines, exit numbers and police blips — so the head unit now shows
   that, and only that. One map, one code path: a change to either lands on
   both.

   Cost model (this repaints on cockpit.ts's ~45 ms drawScreen cadence):
   - The MAP is redrawn on its own NAV_MS timer (see below), not on every
     repaint, into an offscreen pane canvas at the backing-store scale. In
     between, the pane costs one drawImage; the marker is drawn live on top at
     the full repaint rate, offset by how far the car has moved since the bake,
     so the "you" arrow never stutters even though the world under it steps.
   - The MUSIC CARD renders to an offscreen canvas and is repainted only when
     its content changes: a track change (~ every 2.5-3.5 real minutes) or the
     progress bar growing by a pixel (~ every 2.5 s). Per frame it costs one
     drawImage.
   - The GLASS overlays (bezel, reflection, vignette) reuse cached gradients:
     three fills and a stroke per frame. */

/* ------------------------------------------------------------- geometry -- */

const W = 256, H = 160;
const NAV_W = 154;                 // split: right 60% map, left 40% music
const NAV_X = W - NAV_W;           // nav pane spans NAV_X..W; music pane 0..NAV_X
/* Map zoom, pixels per metre. The HUD overlay runs 0.4 on a 172 px canvas;
   the pane is 154x160 logical and, in the DASHCAM frame it is tuned for, ends
   up about the same size on screen but read ~26 degrees off-normal. So it is
   zoomed a notch tighter than the overlay: chunkier roads survive the angle
   and the degrade, and ±140 x ±145 m still holds several blocks of town, the
   whole width of the deck and the ramp you are aiming at. */
const NAV_SC = 0.55;
/* Map repaint period, ms. drawScreen itself runs at ~45 ms (engine.ts's
   gauge cadence), and walking the road graph twice as often as the HUD does
   for a screen this small is not worth it — so the map bakes at ~11 Hz, a
   little under the overlay's every-4th-frame ~15 Hz. What that would normally
   cost is smoothness while panning; the live marker offset below buys it
   back, since between bakes the arrow slides over a held map instead of the
   whole pane freezing. At 200 km/h a bake is 5 m of travel, under 3 px. */
const NAV_MS = 90;
const CARD = { x: 6, y: 6, w: 91, h: 148 };
const BAR_X = 15, BAR_W = 73, BAR_Y = 128; // progress bar, inside the card

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
  /** the pane's map, baked by drawMiniMap every NAV_MS (see drawNav) */
  nav: HTMLCanvasElement | null;
  /** performance.now() of the last bake, and the car position it was centred
      on — the live marker is offset by the difference */
  navAt: number;
  navCX: number;
  navCZ: number;
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
    scale, nav: null, navAt: -1e9, navCX: 0, navCZ: 0,
  };
  // Same trick for the card's offscreen context: logical coords, scaled store.
  s.mg.setTransform(scale, 0, 0, scale, 0, 0);
  states.set(cv, s);
  return s;
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
    card's own canvas space (origin at screen x = 0 — the music pane is the
    left pane, blitted at 0). */
function paintMusic(st: ScreenState, px: number) {
  const mg = st.mg, t = TRACKS[st.trackIdx];
  const x0 = CARD.x, y0 = CARD.y, cw = CARD.w, ch = CARD.h;
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
  const bx = BAR_X;
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

/** Bake the pane's map: the HUD overlay's own routine, drawn into an offscreen
    canvas at this screen's backing-store scale. The context keeps a base
    transform, so drawMiniMap's pixel coordinates ARE the pane's logical ones
    and its line widths and type come out the size it intends. */
function bakeMap(st: ScreenState, world: WorldData, car: CarState, npcs: Npc[], now: number) {
  if (!st.nav) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(NAV_W * st.scale));
    c.height = Math.max(1, Math.round(H * st.scale));
    c.getContext("2d")!.setTransform(st.scale, 0, 0, st.scale, 0, 0);
    st.nav = c;
  }
  st.navCX = car.x;
  st.navCZ = car.z;
  drawMiniMap(st.nav, world, car, npcs, now, {
    sc: NAV_SC, w: NAV_W, h: H,
    // the head unit has a bezel of its own, and the marker is drawn live
    // below rather than baked into a map that is up to NAV_MS stale
    frame: false, noPlayer: true,
  });
}

function drawNav(g: CanvasRenderingContext2D, st: ScreenState, world: WorldData,
  car: CarState, npcs: Npc[], timeH: number, now: number, ms: number) {
  if (ms - st.navAt >= NAV_MS) {
    st.navAt = ms;
    bakeMap(st, world, car, npcs, now);
  }

  g.save();
  g.beginPath();
  g.rect(NAV_X, 0, NAV_W, H);
  g.clip();

  /* The map's ground is laid down at 80% alpha — on the HUD it sits over the
     page, and that translucency is part of the overlay's look. Here it would
     composite onto the previous frame and trail, so the pane gets an opaque
     floor of its own first. One fill; it also covers the pane while the very
     first bake is still a frame away. */
  g.fillStyle = "#070910";
  g.fillRect(NAV_X, 0, NAV_W, H);
  if (st.nav) g.drawImage(st.nav, NAV_X, 0, NAV_W, H);

  /* The marker — drawn every repaint, not every bake. The map behind it is
     centred on where the car was at NAV_MS ago (navCX/navCZ), so the arrow is
     offset by the travel since: it slides across a held map instead of the
     whole pane jumping. Same mirrored-x, north-up transform drawMiniMap uses
     (+x runs LEFT), which is why the heading rotates by −h, not +h — the old
     fitted basemap here drew +x to the right and rotated the other way, so
     this map and the HUD's disagreed about which way a left turn bends. */
  const mx = NAV_X + NAV_W / 2 - (car.x - st.navCX) * NAV_SC;
  const my = H / 2 - (car.z - st.navCZ) * NAV_SC;
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
  g.rotate(-car.h);
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(0, -3.8);
  g.lineTo(2.7, 3.1);
  g.lineTo(0, 1.5);
  g.lineTo(-2.7, 3.1);
  g.closePath();
  g.fill();
  g.restore();

  /* live route state, for the banner. The pane has no y, so the bridge
     crossing (bypass OVER deck) is settled by continuity: once on the bypass,
     stay "on" it until its pavement is genuinely left — a deck car passing
     under never latches. */
  const cor = getCorridor();
  const onDeck = cor.heightAt(car.x, car.z, 4) !== null;
  const byHit = getRouteGraph().surfaceAt(car.x, car.z, 4);
  const onBy = !!byHit && (st.wasBy || !onDeck);
  st.wasBy = onBy;

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
  for (let b = 0; b < 3; b++) g.fillRect(NAV_X + 60 + b * 4, 15 - b * 2.4, 2.6, 2.6 + b * 2.4);
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
    clock doesn't spin the playlist. `now` is the engine's seconds clock, and
    goes straight through to the map (it blinks the police blips). */
export function drawCarScreen(
  cv: HTMLCanvasElement, world: WorldData, car: CarState, npcs: Npc[],
  timeH: number, now: number
) {
  const st = stateFor(cv);
  const g = st.g;

  // ---- music state: advance on real time, repaint only on visible change --
  const ms = performance.now();
  if (!st.trackStart) st.trackStart = ms;
  let t = TRACKS[st.trackIdx];
  if ((ms - st.trackStart) / 1000 > t.dur) {
    st.trackIdx = (st.trackIdx + 1) % TRACKS.length;
    st.trackStart = ms;
    t = TRACKS[st.trackIdx];
  }
  const px = Math.min(BAR_W, ((ms - st.trackStart) / 1000 / t.dur * BAR_W) | 0);
  if (st.trackIdx !== st.paintedIdx || px !== st.paintedPx) {
    paintMusic(st, px);
    st.paintedIdx = st.trackIdx;
    st.paintedPx = px;
  }

  // ---- right: nav map (baked minimap blit + live marker + overlays) -------
  drawNav(g, st, world, car, npcs, timeH, now, ms);

  // ---- left: cached music card, one blit ----------------------------------
  g.drawImage(st.music, 0, 0, W - NAV_W, H);

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
