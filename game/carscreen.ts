import { getCorridor } from "./world/corridor";
import { getRouteGraph } from "./world/routegraph";
import { drawMiniMap } from "./minimap";
import { TAU } from "./util";
import { drawGamePane, hitGamePane, type GameAction } from "./consolegame";
import type { WorldData } from "./world/data";
import type { CarState } from "./physics";
import type { Npc } from "./traffic";

/* CarPlay-style head unit for the cockpit's centre-stack screen — one 256x160
   canvas, and ONE PANE ON IT AT A TIME.

   It used to be split 60/40, nav map right and a music card left. It is not
   any more: the map now fills the whole panel and the music player is a
   SECOND VIEW behind a click on the screen. Why:

   - The map is the only thing on here anyone reads while driving, and at 154
     px it was reading it through a letterbox. Full width is +66% of pane area
     and about 100 m more road either side at the same zoom.
   - The music card was a display, not a control. Its transport glyphs were
     clickable — nobody could tell, because a static card at a steep angle
     through the dashcam degrade looks exactly like a picture of a stereo.
     Given a view of its own it can afford real buttons with real hover
     states, which is what makes them read as buttons.
   - On TOUCH there is no music view at all, on purpose. Music is disabled on
     touch anyway (music.ts `enabled`), so a transport there would be a row of
     dead buttons; and a tap-to-switch would put a mode change under the
     player's thumb in the one view they actually need. Phones get the map,
     full stop — engine.ts never sets `clickable`, so nothing is drawn to
     suggest otherwise.

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
   - The MUSIC VIEW renders to an offscreen canvas and is repainted only when
     its content changes: a track change (~ every 2.5-3.5 real minutes), the
     progress bar growing by a pixel (~ every 2.5 s), the play/pause state
     flipping, or the cursor crossing a button. Per frame it costs one
     drawImage — and while the map is up it costs nothing at all, because the
     view is never painted until it is asked for.
   - The GAMES VIEW (tic-tac-toe, consolegame.ts) follows the music view's
     contract exactly: an offscreen canvas repainted only on visible change,
     one drawImage per repaint while open, nothing at all while closed — its
     whole update loop runs inside its draw call, so a closed pane's game
     does not even advance.
   - The GLASS overlays (bezel, reflection, vignette) reuse cached gradients:
     three fills and a stroke per frame. */

/* ------------------------------------------------------------- geometry -- */

const W = 256, H = 160;
/* Map zoom, pixels per metre. The HUD overlay runs 0.4 on a 172 px canvas.
   The pane is now the full 256x160 and, in the DASHCAM frame it is tuned for,
   is read ~26 degrees off-normal, so it stays a notch tighter than the
   overlay: chunkier roads survive the angle and the degrade. At 0.55 over 256
   px it holds ±233 x ±145 m — several blocks of town, the whole width of the
   deck and the ramp you are aiming at. Widening the pane widened the VIEW
   rather than the zoom on purpose: the same roads at the same weight, with
   more of them. */
const NAV_SC = 0.55;
/* Map repaint period, ms. drawScreen itself runs at ~45 ms (engine.ts's
   gauge cadence), and walking the road graph twice as often as the HUD does
   for a screen this small is not worth it — so the map bakes at ~11 Hz, a
   little under the overlay's every-4th-frame ~15 Hz. What that would normally
   cost is smoothness while panning; the live marker offset below buys it
   back, since between bakes the arrow slides over a held map instead of the
   whole pane freezing. At 200 km/h a bake is 5 m of travel, under 3 px. */
const NAV_MS = 90;

/* --- music view: the layout, and the ONE place the hit rects come from -----

   music.ts used to carry a copy of these numbers so it could hit-test a click
   for engine.ts, with a comment saying they had to be kept in agreement by
   hand and ought to be exported from here instead. They are now: hitScreen()
   below is the only hit test, it reads the same constants the painter does,
   and music.ts is out of the geometry business. */
const ART = { x: 14, y: 34, s: 96 };   // album art square
const COL_X = 124, COL_R = 244;        // the right-hand column: text + controls
/* Narrowed 20 px each side from the full column width, to leave the VOL_MINUS
   / VOL_PLUS buttons (below) a slot either end without crowding them against
   the progress fill. */
const BAR = { x: COL_X + 20, y: 96, w: COL_R - COL_X - 40, h: 4 };
/* Transport buttons: three 34 px squares on an 8 px gutter, filling the
   column exactly (124 + 3*34 + 2*8 = 242). 34 px of a 256 px panel is a
   generous target for a cursor and, more to the point, big enough to carry a
   visible hover fill — a glyph alone changing colour is not a state anyone
   notices at this size through the dashcam degrade. */
const BTN_S = 34, BTN_Y = 118;
const BTN_X = [COL_X, COL_X + 42, COL_X + 84];
/* Back to the map. Top-left, where the eye lands first, and the only way out
   of this view: dead space deliberately does NOTHING here, so a click that
   misses a button cannot silently throw the view away. Shared by every
   non-map view (music, trip) — one exit, in the same place, however you got
   there. */
const BACK = { x: 8, y: 7, w: 54, h: 18 };
/* And the way IN, on the map view: a pill in the top-right corner, clear of
   the status strip (x 5..93) and the route banner (bottom). The whole panel
   is the button — see hitScreen — and this is what says so. */
const PILL = { x: W - 34, y: 6, w: 26, h: 16 };
/* A second way in, right next to it, to the trip computer — the same size
   and row as PILL so the two read as a pair rather than one afterthought
   bolted beside the other. Left of PILL (music), not right of it: the eye
   already lands top-left first (see BACK above) and this keeps both pills
   in the same sweep. */
const PILL2 = { x: PILL.x - 32, y: PILL.y, w: PILL.w, h: PILL.h };
/* Third of the row: the GAMES pane. Same size, same sweep, leftmost of the
   three — still 30 px clear of the status strip (ends x 93). The glyph is a
   tic-tac-toe grid rather than text: "GAMES" does not fit five characters
   into a 26 px pill at a size that survives the dashcam angle, and the
   noughts-and-crosses grid IS this pane's icon. */
const PILL3 = { x: PILL2.x - 32, y: PILL.y, w: PILL.w, h: PILL.h };
/* In-cabin volume +/- either side of the progress bar. Same row, so the
   knob reads as part of the transport rather than a second control bolted
   above it; BAR itself is narrowed (see below) to make room without
   crowding the album art column. */
const VOL_S = 16, VOL_Y = 90;
const VOL_MINUS = { x: COL_X, y: VOL_Y, w: VOL_S, h: VOL_S };
const VOL_PLUS = { x: COL_R - VOL_S, y: VOL_Y, w: VOL_S, h: VOL_S };

/** Which pane the head unit is showing. */
export type ScreenView = "map" | "music" | "trip" | "game";
/** What a click on the panel does, and equally what the cursor is over.
    The g-prefixed members come from the games pane (consolegame.ts). */
export type ScreenAction =
  | "prev" | "toggle" | "next" | "music" | "map" | "trip" | "game"
  | "volDown" | "volUp" | GameAction;

/** Map a UV hit on the head-unit plane to what a click there does, or null if
    it landed on dead space. `v` is flipped because UV origin is bottom-left
    while the canvas the panel is drawn into is top-down.

    Hover and click ask the same question of the same function, so the thing
    that lit up is always the thing that responds. */
export function hitScreen(u: number, v: number, view: ScreenView): ScreenAction | null {
  const x = u * W, y = (1 - v) * H;
  if (x < 0 || x > W || y < 0 || y > H) return null;
  if (view === "map") {
    if (x >= PILL2.x && x <= PILL2.x + PILL2.w && y >= PILL2.y && y <= PILL2.y + PILL2.h)
      return "trip";
    if (x >= PILL3.x && x <= PILL3.x + PILL3.w && y >= PILL3.y && y <= PILL3.y + PILL3.h)
      return "game";
    return "music"; // everywhere else on the map panel opens the player
  }
  if (x >= BACK.x && x <= BACK.x + BACK.w && y >= BACK.y && y <= BACK.y + BACK.h) return "map";
  if (view === "trip") return null; // nothing else on this pane responds
  if (view === "game") return hitGamePane(x, y); // the pane owns its own rects
  if (y >= BTN_Y && y <= BTN_Y + BTN_S) {
    const ids: ScreenAction[] = ["prev", "toggle", "next"];
    for (let i = 0; i < 3; i++)
      if (x >= BTN_X[i] && x <= BTN_X[i] + BTN_S) return ids[i];
  }
  if (x >= VOL_MINUS.x && x <= VOL_MINUS.x + VOL_MINUS.w && y >= VOL_MINUS.y && y <= VOL_MINUS.y + VOL_MINUS.h)
    return "volDown";
  if (x >= VOL_PLUS.x && x <= VOL_PLUS.x + VOL_PLUS.w && y >= VOL_PLUS.y && y <= VOL_PLUS.y + VOL_PLUS.h)
    return "volUp";
  return null;
}

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
  paintedTitle: string;    // last live-player title painted; "" when on TRACKS
  /** last hover target and play state painted, so the cursor crossing a button
      (or the player being paused) is a repaint and nothing else is */
  paintedHover: ScreenAction | null;
  paintedPlaying: boolean;
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
  music.width = Math.max(1, Math.round(W * scale));
  music.height = Math.max(1, Math.round(H * scale));
  s = {
    g, reflect, vign, music, mg: music.getContext("2d")!,
    trackIdx: 0, trackStart: 0, paintedIdx: -1, paintedPx: -1, paintedTitle: "",
    paintedHover: null, paintedPlaying: true,
    wasBy: false,
    scale, nav: null, navAt: -1e9, navCX: 0, navCZ: 0,
  };
  // Same trick for the card's offscreen context: logical coords, scaled store.
  s.mg.setTransform(scale, 0, 0, scale, 0, 0);
  states.set(cv, s);
  return s;
}

export function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** The shared ‹ MAP exit, identical on every non-map view (music, trip,
    game) — one exit, in the same place, however you got there. Exported so
    the games pane (consolegame.ts) draws the exact pill hitScreen answers
    for, instead of keeping a copy of these numbers. */
export function drawBackPill(g: CanvasRenderingContext2D, on: boolean) {
  rr(g, BACK.x, BACK.y, BACK.w, BACK.h, 9);
  g.fillStyle = on ? "rgba(111,178,255,.22)" : "rgba(255,255,255,.05)";
  g.fill();
  g.strokeStyle = on ? "rgba(150,200,255,.75)" : "rgba(255,255,255,.14)";
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = on ? "#eaf3ff" : "#9aa6bc";
  g.font = "700 8px sans-serif";
  g.textAlign = "left";
  g.fillText("‹  MAP", BACK.x + 9, BACK.y + 12.5);
}

/* ---------------------------------------------------------- music view -- */

/** Procedural square album art: a two-stop gradient plus one simple motif per
    track, so each cover is distinct at 96 px. */
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
      mg.beginPath(); mg.arc(cx, cy - 8, 20, 0, TAU); mg.fill();
      mg.fillStyle = "rgba(0,0,0,.35)";
      for (let i = 0; i < 3; i++) mg.fillRect(x, cy - 6 + i * 7, s, 3);
      break;
    }
    case 1: { // skyline bars
      mg.fillStyle = "rgba(0,0,0,.4)";
      for (let i = 0; i < 5; i++) mg.fillRect(x + 8 + i * 17, y + 26 + ((i * 19) % 31), 11, s);
      break;
    }
    case 2: { // overpass wedge
      mg.beginPath(); mg.moveTo(x + 6, y + s - 11); mg.lineTo(cx, y + 14); mg.lineTo(x + s - 6, y + s - 11);
      mg.closePath(); mg.fill();
      break;
    }
    case 3: { // twin headlight rings
      mg.lineWidth = 4;
      mg.beginPath(); mg.arc(cx - 17, cy, 14, 0, TAU); mg.stroke();
      mg.beginPath(); mg.arc(cx + 17, cy, 14, 0, TAU); mg.stroke();
      break;
    }
    case 4: { // streaking tail lights
      mg.lineWidth = 6; mg.lineCap = "round";
      mg.strokeStyle = "rgba(255,255,255,.35)";
      for (let i = 0; i < 3; i++) {
        mg.beginPath(); mg.moveTo(x + 8, y + 23 + i * 23); mg.lineTo(x + s - 14 - i * 11, y + 14 + i * 23); mg.stroke();
      }
      break;
    }
    case 5: { // interchange loop
      mg.lineWidth = 6;
      mg.beginPath(); mg.arc(cx, cy, 23, 0.6, TAU - 0.6); mg.stroke();
      mg.beginPath(); mg.moveTo(cx + 14, cy + 17); mg.lineTo(x + s - 8, y + s - 8); mg.stroke();
      break;
    }
    default: { // crescent
      mg.beginPath(); mg.arc(cx + 6, cy - 6, 20, 0, TAU); mg.fill();
      mg.fillStyle = t.c1;
      mg.beginPath(); mg.arc(cx - 3, cy - 11, 17, 0, TAU); mg.fill();
    }
  }
  // gloss
  const gl = mg.createLinearGradient(x, y, x, y + s * 0.5);
  gl.addColorStop(0, "rgba(255,255,255,.14)");
  gl.addColorStop(1, "rgba(255,255,255,0)");
  mg.fillStyle = gl;
  mg.fillRect(x, y, s, s * 0.5);
}

/** Repaint the whole music view into the offscreen canvas. Only called when
    something on it actually changed — see the repaint gate in drawCarScreen. */
function paintMusic(
  st: ScreenState, px: number, hover: ScreenAction | null, playing: boolean, live?: ScreenMusic
) {
  /* `live` is the real player when one is running; TRACKS is the fallback
     rotation for when it is not. Without this the card cheerfully showed
     "Midnight Loop / Neon Arcade" while Beethoven was actually playing. */
  const mg = st.mg;
  const t = live
    ? { title: live.title, artist: live.composer, dur: 1,
        c0: live.art.a, c1: live.art.b, motif: st.trackIdx }
    : TRACKS[st.trackIdx];
  mg.clearRect(0, 0, W, H);
  mg.fillStyle = "#0a0d13";
  mg.fillRect(0, 0, W, H);

  /* --- back to the map -------------------------------------------------- */
  drawBackPill(mg, hover === "map");

  // header: generic note glyph + "Music" (no Apple marks anywhere)
  mg.fillStyle = "#8f98ab";
  mg.beginPath(); mg.arc(COL_X + 3, BACK.y + 10, 2.4, 0, TAU); mg.fill();
  mg.fillRect(COL_X + 4.6, BACK.y + 1.6, 1.4, 8.6);
  mg.fillRect(COL_X + 4.6, BACK.y + 1.6, 5.4, 2);
  mg.font = "600 8px sans-serif";
  mg.fillText("Music", COL_X + 14, BACK.y + 13);

  /* --- album art -------------------------------------------------------- */
  mg.save();
  rr(mg, ART.x, ART.y, ART.s, ART.s, 8);
  mg.clip();
  paintArt(mg, t, ART.x, ART.y, ART.s);
  mg.restore();
  rr(mg, ART.x, ART.y, ART.s, ART.s, 8);
  mg.strokeStyle = "rgba(0,0,0,.5)";
  mg.lineWidth = 1;
  mg.stroke();

  /* --- title / artist --------------------------------------------------- */
  mg.textAlign = "left";
  mg.fillStyle = "#eef1f7";
  mg.font = "700 13px sans-serif";
  let title = t.title;
  while (mg.measureText(title).width > COL_R - COL_X && title.length > 3)
    title = title.slice(0, -2);
  mg.fillText(title, COL_X, ART.y + 24);
  mg.fillStyle = "#98a1b3";
  mg.font = "10px sans-serif";
  let artist = t.artist;
  while (mg.measureText(artist).width > COL_R - COL_X && artist.length > 3)
    artist = artist.slice(0, -2);
  mg.fillText(artist, COL_X, ART.y + 40);

  /* --- progress --------------------------------------------------------- */
  rr(mg, BAR.x, BAR.y, BAR.w, BAR.h, BAR.h / 2);
  mg.fillStyle = "rgba(255,255,255,.16)";
  mg.fill();
  if (px > 2) {
    rr(mg, BAR.x, BAR.y, px, BAR.h, BAR.h / 2);
    mg.fillStyle = "#6fb2ff";
    mg.fill();
  }

  /* --- in-cabin volume, either side of the bar --------------------------- */
  for (const [rect, glyph, id] of [
    [VOL_MINUS, "-", "volDown"], [VOL_PLUS, "+", "volUp"],
  ] as const) {
    const on = hover === id;
    rr(mg, rect.x, rect.y, rect.w, rect.h, 5);
    mg.fillStyle = on ? "rgba(111,178,255,.26)" : "rgba(255,255,255,.055)";
    mg.fill();
    mg.strokeStyle = on ? "rgba(160,205,255,.85)" : "rgba(255,255,255,.10)";
    mg.lineWidth = 1;
    mg.stroke();
    mg.fillStyle = on ? "#ffffff" : "#c8d0de";
    mg.font = "700 11px sans-serif";
    mg.textAlign = "center";
    mg.fillText(glyph, rect.x + rect.w / 2, rect.y + rect.h / 2 + 4);
  }
  mg.textAlign = "left";

  /* --- transport -------------------------------------------------------- */
  /* Three states per button and all three are visible on a dark screen at a
     steep angle: rest is a faint plate that says "this is a control", hover
     is a blue wash with a lit rim, and the glyph brightens with it. The rim
     is what carries at the dashcam's angle — a fill alone flattens out. */
  const ids: ScreenAction[] = ["prev", "toggle", "next"];
  for (let i = 0; i < 3; i++) {
    const bx = BTN_X[i], by = BTN_Y, on = hover === ids[i];
    rr(mg, bx, by, BTN_S, BTN_S, 8);
    mg.fillStyle = on ? "rgba(111,178,255,.26)" : "rgba(255,255,255,.055)";
    mg.fill();
    mg.strokeStyle = on ? "rgba(160,205,255,.85)" : "rgba(255,255,255,.10)";
    mg.lineWidth = 1;
    mg.stroke();
    const cx = bx + BTN_S / 2, cy = by + BTN_S / 2;
    mg.fillStyle = on ? "#ffffff" : "#c8d0de";
    /** dir = +1 points right, -1 points left */
    const tri = (tx: number, dir: number) => {
      mg.beginPath();
      mg.moveTo(tx - dir * 4.5, cy - 5);
      mg.lineTo(tx + dir * 3.5, cy);
      mg.lineTo(tx - dir * 4.5, cy + 5);
      mg.closePath();
      mg.fill();
    };
    if (i === 0) { tri(cx - 3, -1); tri(cx + 5, -1); }
    else if (i === 2) { tri(cx + 3, 1); tri(cx - 5, 1); }
    else if (playing) { mg.fillRect(cx - 4.5, cy - 6, 3.5, 12); mg.fillRect(cx + 1, cy - 6, 3.5, 12); }
    else { tri(cx + 1, 1); }
  }
}

/* ------------------------------------------------------------ nav pane -- */

/** Bake the pane's map: the HUD overlay's own routine, drawn into an offscreen
    canvas at this screen's backing-store scale. The context keeps a base
    transform, so drawMiniMap's pixel coordinates ARE the pane's logical ones
    and its line widths and type come out the size it intends. */
function bakeMap(st: ScreenState, world: WorldData, car: CarState, npcs: Npc[], now: number) {
  if (!st.nav) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(W * st.scale));
    c.height = Math.max(1, Math.round(H * st.scale));
    c.getContext("2d")!.setTransform(st.scale, 0, 0, st.scale, 0, 0);
    st.nav = c;
  }
  st.navCX = car.x;
  st.navCZ = car.z;
  drawMiniMap(st.nav, world, car, npcs, now, {
    sc: NAV_SC, w: W, h: H,
    // the head unit has a bezel of its own, and the marker is drawn live
    // below rather than baked into a map that is up to NAV_MS stale
    frame: false, noPlayer: true,
  });
}

function drawNav(g: CanvasRenderingContext2D, st: ScreenState, world: WorldData,
  car: CarState, npcs: Npc[], timeH: number, now: number, ms: number,
  clickable: boolean, hover: ScreenAction | null) {
  if (ms - st.navAt >= NAV_MS) {
    st.navAt = ms;
    bakeMap(st, world, car, npcs, now);
  }

  /* The map's ground is laid down at 80% alpha — on the HUD it sits over the
     page, and that translucency is part of the overlay's look. Here it would
     composite onto the previous frame and trail, so the pane gets an opaque
     floor of its own first. One fill; it also covers the pane while the very
     first bake is still a frame away. */
  g.fillStyle = "#070910";
  g.fillRect(0, 0, W, H);
  if (st.nav) g.drawImage(st.nav, 0, 0, W, H);

  /* The marker — drawn every repaint, not every bake. The map behind it is
     centred on where the car was at NAV_MS ago (navCX/navCZ), so the arrow is
     offset by the travel since: it slides across a held map instead of the
     whole pane jumping. Same mirrored-x, north-up transform drawMiniMap uses
     (+x runs LEFT), which is why the heading rotates by −h, not +h — the old
     fitted basemap here drew +x to the right and rotated the other way, so
     this map and the HUD's disagreed about which way a left turn bends. */
  const mx = W / 2 - (car.x - st.navCX) * NAV_SC;
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

  /* The way through to the player. Drawn ONLY where there is one to reach —
     engine.ts passes clickable false on touch and whenever the stereo is off,
     and an affordance for a thing that cannot happen is worse than no
     affordance. It lights whenever the cursor is anywhere on the panel,
     because anywhere on the panel is what opens the player. */
  if (clickable) {
    const on = hover === "music";
    rr(g, PILL.x, PILL.y, PILL.w, PILL.h, 8);
    g.fillStyle = on ? "rgba(111,178,255,.30)" : "rgba(8,11,18,.78)";
    g.fill();
    g.strokeStyle = on ? "rgba(160,205,255,.85)" : "rgba(255,255,255,.10)";
    g.lineWidth = 1;
    g.stroke();
    // the same generic note glyph the player's header carries
    const nx = PILL.x + 10, ny = PILL.y + 11;
    g.fillStyle = on ? "#ffffff" : "#9aa6bc";
    g.beginPath(); g.arc(nx, ny, 2.4, 0, TAU); g.fill();
    g.fillRect(nx + 1.6, ny - 8.6, 1.4, 8.6);
    g.fillRect(nx + 1.6, ny - 8.6, 5.4, 2);

    // its pair: the way in to the trip computer, same row, same style, a
    // text glyph rather than an icon — "TRIP" reads at this size and nothing
    // in the existing glyph set (note, GPS arrow, signal bars) says "trip".
    const tripOn = hover === "trip";
    rr(g, PILL2.x, PILL2.y, PILL2.w, PILL2.h, 8);
    g.fillStyle = tripOn ? "rgba(111,178,255,.30)" : "rgba(8,11,18,.78)";
    g.fill();
    g.strokeStyle = tripOn ? "rgba(160,205,255,.85)" : "rgba(255,255,255,.10)";
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = tripOn ? "#ffffff" : "#9aa6bc";
    g.font = "700 7px sans-serif";
    g.textAlign = "center";
    g.fillText("TRIP", PILL2.x + PILL2.w / 2, PILL2.y + PILL2.h / 2 + 2.5);
    g.textAlign = "left";

    // and the third: the games pane, wearing its own board as the icon —
    // a noughts-and-crosses grid, the one glyph that says "game" at 10 px
    const gameOn = hover === "game";
    rr(g, PILL3.x, PILL3.y, PILL3.w, PILL3.h, 8);
    g.fillStyle = gameOn ? "rgba(111,178,255,.30)" : "rgba(8,11,18,.78)";
    g.fill();
    g.strokeStyle = gameOn ? "rgba(160,205,255,.85)" : "rgba(255,255,255,.10)";
    g.lineWidth = 1;
    g.stroke();
    g.strokeStyle = gameOn ? "#ffffff" : "#9aa6bc";
    g.lineWidth = 1.2;
    const gx = PILL3.x + PILL3.w / 2, gy = PILL3.y + PILL3.h / 2;
    g.beginPath();
    g.moveTo(gx - 1.7, gy - 5); g.lineTo(gx - 1.7, gy + 5);
    g.moveTo(gx + 1.7, gy - 5); g.lineTo(gx + 1.7, gy + 5);
    g.moveTo(gx - 5, gy - 1.7); g.lineTo(gx + 5, gy - 1.7);
    g.moveTo(gx - 5, gy + 1.7); g.lineTo(gx + 5, gy + 1.7);
    g.stroke();
  }

  // route banner along the bottom
  rr(g, 5, H - 20, 96, 15, 7.5);
  g.fillStyle = "rgba(8,11,18,.78)";
  g.fill();
  g.strokeStyle = "rgba(255,255,255,.07)";
  g.lineWidth = 1;
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
  g.fillText(
    onBy ? "湾岸 Bypass ルート" : onDeck ? "首都高 C1 環状線" : "一般道 Surface Rd",
    23, H - 9,
  );
}

/* ------------------------------------------------------------ trip pane -- */

/** Trip computer: drawn straight into `g` every repaint, same as the nav
    marker — there is nothing here worth caching to an offscreen canvas, it
    is three text draws and a readout that changes every frame anyway. Reads
    car.odo directly rather than the dashboard's "31842 + odo" fiction
    (dashboard.ts): that base mileage is the CAR's, this pane is what its name
    says, the distance covered since this drive began. */
function drawTrip(g: CanvasRenderingContext2D, car: CarState, hover: ScreenAction | null) {
  g.fillStyle = "#070910";
  g.fillRect(0, 0, W, H);

  drawBackPill(g, hover === "map");

  g.fillStyle = "#8f98ab";
  g.font = "600 8px sans-serif";
  g.textAlign = "right";
  g.fillText("TRIP COMPUTER", W - 10, BACK.y + 13);
  g.textAlign = "left";

  const kmh = Math.abs(car.u) * 3.6;
  g.textAlign = "center";
  g.fillStyle = "#eef1f7";
  g.font = "700 40px sans-serif";
  g.fillText(kmh.toFixed(0), W / 2, 84);
  g.fillStyle = "#8f98ab";
  g.font = "600 10px sans-serif";
  g.fillText("KM/H", W / 2, 100);

  rr(g, 40, 118, W - 80, 30, 10);
  g.fillStyle = "rgba(255,255,255,.05)";
  g.fill();
  g.strokeStyle = "rgba(255,255,255,.10)";
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = "#9aa6bc";
  g.font = "600 8px sans-serif";
  g.fillText("TRIP DISTANCE", W / 2, 130);
  g.fillStyle = "#eef1f7";
  g.font = "700 13px sans-serif";
  g.fillText(car.odo.toFixed(1) + " km", W / 2, 144);
  g.textAlign = "left";
}

/* ---------------------------------------------------------- entry point -- */

/** What the card needs from the live player (game/music.ts). Structural, not
    an import of MusicPlayer, so carscreen stays independent of the audio
    layer and the mock rotation below still works when it is absent. */
export interface ScreenMusic {
  title: string;
  composer: string;
  art: { a: string; b: string };
  playing: boolean;
  /** 0..1 through the current piece. */
  progress: number;
}

/** Which pane to draw and what the cursor is doing to it. Owned by engine.ts,
    which is where the pointer is: this module paints, it does not remember. */
export interface ScreenUI {
  view: ScreenView;
  /** hitScreen() for wherever the cursor is, or null — including always null
      on touch, which has no cursor. */
  hover: ScreenAction | null;
  /** whether a click on this panel can do anything at all. False on touch and
      whenever the stereo is off; it is what suppresses the map view's music
      pill, and with it any suggestion that there is a player to reach. */
  clickable: boolean;
}

const UI_MAP: ScreenUI = { view: "map", hover: null, clickable: false };

/** Draw the whole head unit into `cv` (the cockpit's 256x160 screen canvas).
    Caller flips the CanvasTexture's needsUpdate. `timeH` is the in-game clock
    in hours; the music player runs on real time so the accelerated day/night
    clock doesn't spin the playlist. `now` is the engine's seconds clock, and
    goes straight through to the map (it blinks the police blips). */
export function drawCarScreen(
  cv: HTMLCanvasElement, world: WorldData, car: CarState, npcs: Npc[],
  timeH: number, now: number, music?: ScreenMusic, ui: ScreenUI = UI_MAP
) {
  const st = stateFor(cv);
  const g = st.g;
  const ms = performance.now();

  if (ui.view === "music") {
    // ---- music state: advance on real time, repaint only on visible change --
    let px: number;
    let playing = true;
    if (music) {
      /* Real player: the progress bar and the artwork follow it, and a PAUSED
         player freezes the bar rather than letting the mock timer walk it on.
         trackIdx is only carried so the motif (the art pattern) still varies
         per piece — the title/composer/colours come from the player. */
      px = Math.min(BAR.w, (music.progress * BAR.w) | 0);
      playing = music.playing;
      if (st.paintedTitle !== music.title) {
        st.trackIdx = (st.trackIdx + 1) % TRACKS.length;
        st.paintedTitle = music.title;
        st.paintedPx = -1;
      }
    } else {
      if (!st.trackStart) st.trackStart = ms;
      let t = TRACKS[st.trackIdx];
      if ((ms - st.trackStart) / 1000 > t.dur) {
        st.trackIdx = (st.trackIdx + 1) % TRACKS.length;
        st.trackStart = ms;
        t = TRACKS[st.trackIdx];
      }
      px = Math.min(BAR.w, ((ms - st.trackStart) / 1000 / t.dur * BAR.w) | 0);
    }
    if (
      px !== st.paintedPx || st.trackIdx !== st.paintedIdx ||
      ui.hover !== st.paintedHover || playing !== st.paintedPlaying
    ) {
      paintMusic(st, px, ui.hover, playing, music);
      st.paintedPx = px;
      st.paintedIdx = st.trackIdx;
      st.paintedHover = ui.hover;
      st.paintedPlaying = playing;
    }
    g.drawImage(st.music, 0, 0, W, H);
  } else if (ui.view === "trip") {
    drawTrip(g, car, ui.hover);
  } else if (ui.view === "game") {
    /* The games pane runs its whole life inside this call — see
       consolegame.ts. |car.u| is what parks the CPU's think timer while the
       car is moving faster than a walk. */
    drawGamePane(g, st.scale, ui.hover, Math.abs(car.u), ms);
  } else {
    /* Map view: the whole panel. Nothing of the player is drawn or even
       advanced here — the mock rotation's timer picks up from wherever it left
       off the next time the view is asked for, and the live player keeps its
       own clock regardless. */
    drawNav(g, st, world, car, npcs, timeH, now, ms, ui.clickable, ui.hover);
  }

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
