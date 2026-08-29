import type { WorldData } from "./world/data";
import type { CarState } from "./physics";
import type { Npc } from "./traffic";
import { getCorridor, TUNNEL, TOLL, type Corridor } from "./world/corridor";
import { MERGE_Z } from "./world/routegraph";
import { HX } from "./world/const";

/* North-up top-down minimap: the town road graph, the expressway corridor
   drawn from the alignment itself, its ramps and numbered exits, traffic dots
   and the player arrow.

   The corridor is not a straight line any more — it sweeps up to 62 m either
   side of its reference x, widens to six lanes at the toll plaza and narrows
   into the tunnel — so it is drawn by walking the same `stations` the physics
   and traffic query rather than by any constant. It also loops: crossing the
   north end teleports the player back by LOOP, so near the seam the corridor
   is drawn a second time, shifted a lap, and the map reads as continuous.

   This runs every fourth frame on a small canvas, so it stays deliberately
   arithmetic: one reused scratch point, no per-station allocation.

   Two consumers now: the HUD overlay canvas (engine.ts), and the nav pane of
   the in-dash head unit (carscreen.ts), which draws the same map into an
   offscreen canvas at its own scale and cadence. `MiniMapOpts` is the whole
   difference between them — the drawing below is shared verbatim, so the
   little map in the car and the big one on the glass can never drift apart.

   The HUD map has two framings (the Z key / a click on the map, engine.ts):
   the close-up follow above, and a whole-loop overview that fixes the frame
   on the corridor band and lets the player marker travel instead. Same code
   path — the framing only changes the view centre, the scale and how coarsely
   the polylines are walked (at ~0.04 px/m every station is sub-pixel noise).

   Colours are the UI's design tokens (globals.css :root), hand-mirrored:
   canvas fills cannot read CSS custom properties, and resolving them per draw
   is a getComputedStyle round-trip this cadence does not want. If the token
   palette moves, move these with it — town roads --ink-faint, corridor
   --accent/--accent-2, ramps + exit plates --ok, player --ink, frame the
   --border hue. Route identities (bypass violet, mountain earth, toll amber)
   and the police strobe are map semantics, not chrome, and stay their own. */

const SC = 0.4; // pixels per metre
/** the corridor is drawn in place and a lap either side, to hide the splice */
const LAPS = [0, -1, 1];
/** the overview holds the whole band, splice overlap included — one pass */
const LAP0 = [0];
const NO_LAPS: number[] = [];
/** every Nth station is plenty at this scale (stations are 4 m apart) */
const SKIP = 2;
/** an exit this close ahead (metres to its gore) gets the highlight below */
const EXIT_WARN = 400;

const _p = { x: 0, y: 0, z: 0 };

/* Canvas text cannot read CSS custom properties, so resolve the UI's
   --font-display token (ui-redesign's type system, globals.css) once and
   build the exit-number font from it — the map's numerals should sit in the
   same face as the HUD chrome around them, not a hardcoded sans-serif.
   Resolved lazily at first draw, when the stylesheet is certainly live, and
   only cached once it answers non-empty. */
let _exitFont: string | null = null;
function exitFont(): string {
  if (_exitFont !== null) return _exitFont;
  const fam = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-display").trim();
  const f = `700 9px ${fam || "sans-serif"}`;
  if (fam) _exitFont = f;
  return f;
}

/* The merge gore marker sits at a fixed station, so its world point is static
   for the life of a corridor. It was being rebuilt — and freshly allocated,
   since worldOf() without an `out` returns a new object — once per lap pass,
   so up to three times a draw. */
let _mergeFor: Corridor | null = null;
const _mergePt = { x: 0, y: 0, z: 0 };
function mergePoint(cor: Corridor) {
  if (_mergeFor !== cor) {
    _mergeFor = cor;
    cor.worldOf(MERGE_Z, cor.halfWidth(MERGE_Z) + 8, _mergePt);
  }
  return _mergePt;
}

/** Trace the pavement outline between two z values as a closed path: out along
    one edge, back along the other. `dz` shifts the whole run by a lap; `sk` is
    the station stride (coarser in the overview, where 4 m is sub-pixel). */
function pavePath(
  g: CanvasRenderingContext2D,
  cor: Corridor,
  zLo: number,
  zHi: number,
  dz: number,
  sk: number,
  tx: (x: number) => number,
  tz: (z: number) => number
): boolean {
  const st = cor.stations;
  if (st.length < 2) return false;
  const step = st[1].z - st[0].z || 4;
  const i0 = Math.max(0, Math.ceil((zLo - st[0].z) / step));
  const i1 = Math.min(st.length - 1, Math.floor((zHi - st[0].z) / step));
  if (i1 - i0 < sk) return false;
  g.beginPath();
  for (let i = i0; i <= i1; i += sk) {
    const s = st[i];
    cor.worldOf(s.z, s.hw, _p);
    if (i === i0) g.moveTo(tx(_p.x), tz(_p.z + dz));
    else g.lineTo(tx(_p.x), tz(_p.z + dz));
  }
  for (let i = i1; i >= i0; i -= sk) {
    const s = st[i];
    cor.worldOf(s.z, -s.hw, _p);
    g.lineTo(tx(_p.x), tz(_p.z + dz));
  }
  g.closePath();
  return true;
}

/** The centreline over the same span, as an open path. */
function centrePath(
  g: CanvasRenderingContext2D,
  cor: Corridor,
  zLo: number,
  zHi: number,
  dz: number,
  sk: number,
  tx: (x: number) => number,
  tz: (z: number) => number
): boolean {
  const st = cor.stations;
  if (st.length < 2) return false;
  const step = st[1].z - st[0].z || 4;
  const i0 = Math.max(0, Math.ceil((zLo - st[0].z) / step));
  const i1 = Math.min(st.length - 1, Math.floor((zHi - st[0].z) / step));
  if (i1 - i0 < sk) return false;
  g.beginPath();
  for (let i = i0; i <= i1; i += sk) {
    const s = st[i];
    if (i === i0) g.moveTo(tx(s.x), tz(s.z + dz));
    else g.lineTo(tx(s.x), tz(s.z + dz));
  }
  return true;
}

export interface MiniMapOpts {
  /** pixels per metre (default SC) */
  sc?: number;
  /** Logical size to draw at. Defaults to the canvas's own pixel size; pass
      it when the context carries a backing-store scale transform (the head
      unit's pane does), so line widths and type stay in logical pixels
      instead of shrinking with the store. */
  w?: number;
  h?: number;
  /** the HUD's outer frame — off for a pane that has its own bezel */
  frame?: boolean;
  /** Skip the centred player arrow. A caller that redraws the map less often
      than it repaints draws its own marker live on top, offset by how far the
      car has moved since the map was baked (carscreen.ts). */
  noPlayer?: boolean;
  /** "near" (default): close-up follow, car centred, `sc` respected. "loop":
      the whole lap in one frame — fixed on the corridor band, scaled to fit
      it, the player drawn in place. HUD-only today; the head unit keeps its
      own follow framing (its live marker assumes a car-centred bake). */
  zoom?: "near" | "loop";
}

export function drawMiniMap(
  cv: HTMLCanvasElement,
  world: WorldData,
  car: CarState,
  npcs: Npc[],
  now: number,
  opts?: MiniMapOpts
) {
  const g = cv.getContext("2d");
  if (!g) return;
  const cor = getCorridor();
  const Wp = opts?.w ?? cv.width, Hp = opts?.h ?? cv.height;
  const loopView = opts?.zoom === "loop";
  /* The overview's frame is the corridor band itself: centred on its
     reference x and the middle of its z span, scaled so a whole lap (plus a
     little air) fits the canvas's shorter side. The car drops out of the
     transform entirely — the map holds still and the marker travels. */
  const sc = loopView
    ? (Math.min(Wp, Hp) - 14) / (cor.ZB1 - cor.ZB0 + 160)
    : opts?.sc ?? SC;
  const vx = loopView ? HX : car.x;
  const vz = loopView ? (cor.ZB0 + cor.ZB1) / 2 : car.z;
  /* station/point strides: at the overview's ~0.04 px/m a 4 m station is a
     twentieth of a pixel, so walk the polylines four times coarser there —
     same shapes, a quarter of the lineTo traffic. */
  const sk = loopView ? SKIP * 4 : SKIP;
  const ptSk = loopView ? 6 : 2;
  // x mirrored: +x in this y-up world points LEFT when north (+z) is
  // up-screen — the old +x mapping drew a view-from-below (left turns bent
  // right on the map). Same fix as the head-unit map's toS.
  const tx = (x: number) => Wp / 2 - (x - vx) * sc;
  const tz = (z: number) => Hp / 2 - (z - vz) * sc;
  g.clearRect(0, 0, Wp, Hp);
  g.fillStyle = "rgba(8,10,18,.8)";
  g.fillRect(0, 0, Wp, Hp);

  /** world-space radius the canvas covers, plus a margin for wide geometry.
      Taken off the LONGER side so a non-square pane still culls correctly. */
  const R = Math.max(Wp, Hp) / (2 * sc) + 40;

  // ---- town roads, straight off the graph ----
  g.strokeStyle = "rgba(123,135,171,.55)"; // --ink-faint
  g.lineWidth = loopView ? 1.2 : 2.5;
  for (const e of world.net.edges) {
    const n = e.ss.length - 1;
    const mi = Math.floor(n / 2) * 3;
    const mx = e.pts[mi], mz = e.pts[mi + 2];
    if (Math.abs(mx - vx) > R + e.len / 2 || Math.abs(mz - vz) > R + e.len / 2) continue;
    g.beginPath();
    let started = false;
    for (let i = 0; i <= n; i += ptSk) {
      const X = tx(e.pts[i * 3]), Z = tz(e.pts[i * 3 + 2]);
      if (X < -20 || X > Wp + 20 || Z < -20 || Z > Hp + 20) {
        started = false;
        continue;
      }
      if (!started) {
        g.moveTo(X, Z);
        started = true;
      } else g.lineTo(X, Z);
    }
    g.stroke();
  }

  /* ---- the expressway corridor ----
     Drawn up to three times: in place, and a lap either side, so the seam at
     the north end is invisible — approaching it, the deck that is about to be
     spliced on is already on the map. Each pass clips itself to the built
     extent, so the two extra passes cost a pair of comparisons when they are
     off-screen.

     The alignment never strays more than 90 m from its reference x (the same
     cheap reject the corridor itself uses), so from town the whole deck is
     skipped rather than built into a path the canvas would clip away. */
  const corNear = Math.abs(vx - HX) < R + 90;
  for (const lap of corNear ? (loopView ? LAP0 : LAPS) : NO_LAPS) {
    const dz = lap * cor.LOOP;
    // the span of *station* z that lands inside the view once shifted by dz
    const zLo = Math.max(cor.ZB0, vz - R - dz);
    const zHi = Math.min(cor.ZB1, vz + R - dz);
    if (zHi - zLo < 8) continue;

    if (pavePath(g, cor, zLo, zHi, dz, sk, tx, tz)) {
      g.fillStyle = "rgba(95,141,255,.30)"; // --accent, thinned to a glass fill
      g.fill();
      g.strokeStyle = "rgba(127,216,255,.9)"; // --accent-2
      g.lineWidth = 1.4;
      g.stroke();
    }
    // tunnel: the deck is roofed here, so grey it back out
    const tLo = Math.max(zLo, TUNNEL.z0), tHi = Math.min(zHi, TUNNEL.z1);
    if (tHi > tLo && pavePath(g, cor, tLo, tHi, dz, sk, tx, tz)) {
      g.fillStyle = "rgba(10,14,26,.72)";
      g.fill();
    }
    // toll plaza: the wide bit, flagged so the fan-out reads as deliberate
    const kLo = Math.max(zLo, TOLL.plazaZ0), kHi = Math.min(zHi, TOLL.plazaZ1);
    if (kHi > kLo && pavePath(g, cor, kLo, kHi, dz, sk, tx, tz)) {
      g.fillStyle = "rgba(255,210,120,.32)";
      g.fill();
    }
    // centreline, so the direction of travel is legible even where it bends
    // (sub-pixel against the pave fill in the overview — skip it there)
    if (!loopView && centrePath(g, cor, zLo, zHi, dz, sk, tx, tz)) {
      g.strokeStyle = "rgba(127,216,255,.45)"; // --accent-2
      g.lineWidth = 1;
      g.stroke();
    }

    /* ---- the bypass viaduct: a second ribbon, drawn AFTER the corridor so
       the bridge crossing reads as the overlap it is. Station-swept with the
       asymmetric half-widths, so the gore wedges taper on the map exactly as
       they do on the road. */
    const bst = world.routes?.bypass.stations;
    if (bst && bst.length > 2 &&
      bst[0].z + dz < vz + R && bst[bst.length - 1].z + dz > vz - R) {
      g.beginPath();
      for (let i = 0; i < bst.length; i += sk) {
        const p = bst[i];
        const X = tx(p.x + p.nx * p.hwL), Z = tz(p.z + p.nz * p.hwL + dz);
        if (i === 0) g.moveTo(X, Z);
        else g.lineTo(X, Z);
      }
      for (let i = bst.length - 1; i >= 0; i -= sk) {
        const p = bst[i];
        g.lineTo(tx(p.x - p.nx * p.hwR), tz(p.z - p.nz * p.hwR + dz));
      }
      g.closePath();
      g.fillStyle = "rgba(74,58,128,.85)";
      g.fill();
      g.strokeStyle = "rgba(172,150,255,.9)";
      g.lineWidth = 1.4;
      g.stroke();
      // merge gore marker on the east side, the diverge carries exit no. 3
      const mp = mergePoint(cor);
      const MX = tx(mp.x), MZ = tz(mp.z + dz);
      if (MX > 6 && MX < Wp - 6 && MZ > 6 && MZ < Hp - 6) {
        g.fillStyle = "rgba(172,150,255,.95)";
        g.beginPath();
        g.moveTo(MX, MZ - 3.2);
        g.lineTo(MX + 2.8, MZ + 2.4);
        g.lineTo(MX - 2.8, MZ + 2.4);
        g.closePath();
        g.fill();
      }
    }

    /* ---- the mountain road (EXIT 4): same station-swept ribbon, in earth
       tones so the two detours read apart at a glance. It lives against the
       south end of the band, so the lap shifts are what keep it on the map
       while the player is coming up on the seam. */
    const mst = world.routes?.mtn.stations;
    if (mst && mst.length > 2 &&
      mst[0].z + dz < vz + R && mst[mst.length - 1].z + dz > vz - R) {
      g.beginPath();
      for (let i = 0; i < mst.length; i += sk * 2) {
        const p = mst[i];
        const X = tx(p.x + p.nx * p.hwL), Z = tz(p.z + p.nz * p.hwL + dz);
        if (i === 0) g.moveTo(X, Z);
        else g.lineTo(X, Z);
      }
      for (let i = mst.length - 1; i >= 0; i -= sk * 2) {
        const p = mst[i];
        g.lineTo(tx(p.x - p.nx * p.hwR), tz(p.z - p.nz * p.hwR + dz));
      }
      g.closePath();
      g.fillStyle = "rgba(110,84,52,.85)";
      g.fill();
      g.strokeStyle = "rgba(232,186,120,.9)";
      g.lineWidth = 1.4;
      g.stroke();
    }
  }

  // ---- ramps: the real curved centrelines ----
  g.lineWidth = loopView ? 1.5 : 3;
  g.strokeStyle = "rgba(87,255,154,.85)"; // --ok
  for (const r of world.terrain.ramps) {
    const mx = (r.x0 + r.x1) / 2, mz = (r.z0 + r.z1) / 2;
    if (Math.abs(mx - vx) > R + (r.x1 - r.x0) / 2) continue;
    if (Math.abs(mz - vz) > R + (r.z1 - r.z0) / 2) continue;
    const n = r.pts.length - 1;
    g.beginPath();
    let started = false;
    for (let i = 0; i <= n; i += ptSk) {
      const p = r.pts[Math.min(i, n)];
      const X = tx(p.x), Z = tz(p.z);
      if (X < -20 || X > Wp + 20 || Z < -20 || Z > Hp + 20) {
        started = false;
        continue;
      }
      if (!started) {
        g.moveTo(X, Z);
        started = true;
      } else g.lineTo(X, Z);
    }
    g.stroke();
  }

  /* ---- exit numbers, on the town side of the deck ----
     The one the player is about to make a decision about — its gore (the z
     every ExitInfo carries, straight off the route graph) less than EXIT_WARN
     ahead along the travel direction — gets a soft pulsing ring. The scan is
     over ≤ a handful of exits and allocates nothing; passing the gore wraps
     the distance to nearly a full lap, so the ring drops the moment the
     decision is behind the car. */
  let hlEx = -1, hlD = EXIT_WARN;
  for (let i = 0; i < world.exits.length; i++) {
    let d = world.exits[i].z - car.z;
    d -= Math.floor(d / cor.LOOP) * cor.LOOP;
    if (d < hlD) { hlD = d; hlEx = i; }
  }
  g.font = exitFont();
  g.textAlign = "center";
  for (let i = 0; i < world.exits.length; i++) {
    const ex = world.exits[i];
    /* Nearest lap image of the exit, not its raw z: the corridor near the
       seam is drawn a lap shifted, and a plate that doesn't shift with it
       simply vanishes there — which is exactly where EXIT 4's gore lives. */
    let ezd = ex.z - vz;
    ezd -= Math.round(ezd / cor.LOOP) * cor.LOOP;
    if (Math.abs(ezd) > R) continue;
    // the overview's 12 m offset is sub-pixel: push the plate clear of the deck
    cor.worldOf(ex.z, -(cor.halfWidth(ex.z) + (loopView ? 100 : 12)), _p);
    const X = tx(_p.x), Z = tz(vz + ezd);
    if (X < 8 || X > Wp - 8 || Z < 8 || Z > Hp - 8) continue;
    if (i === hlEx) {
      g.strokeStyle = "rgba(87,255,154,.9)"; // --ok, breathing via alpha only
      g.globalAlpha = 0.5 + 0.3 * Math.sin(now * 5);
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(X, Z - 3, 7, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = "#eef3ff"; // --ink: the plate itself steps up, not green
    } else {
      g.fillStyle = "rgba(87,255,154,.95)"; // --ok
    }
    g.fillText(String(ex.no), X, Z);
  }

  // traffic dots removed by request — only police still show (gameplay signal)
  for (const n of npcs) {
    if (!n.active || n.type !== "police") continue;
    const X = tx(n.x), Z = tz(n.z);
    if (X < 2 || X > Wp - 2 || Z < 2 || Z > Hp - 2) continue;
    g.fillStyle = ((now * 3) | 0) % 2 ? "#ff4050" : "#3d74ff";
    g.fillRect(X - 1.4, Z - 1.4, 2.8, 2.8);
  }
  /* The rival, on the same "gameplay signal" grounds as the police blips: it
     spends most of its life beyond the windshield's useful range, and where
     it went is the one piece of information the chase actually turns on.
     Drawn last and larger so it reads over a police car sharing its pixel. */
  for (const n of npcs) {
    if (!n.active || !n.rival) continue;
    const X = tx(n.x), Z = tz(n.z);
    if (X < 3 || X > Wp - 3 || Z < 3 || Z > Hp - 3) continue;
    g.fillStyle = "#ff7a3c";
    g.beginPath();
    g.arc(X, Z, 3, 0, Math.PI * 2);
    g.fill();
  }

  // ---- player: centred in the follow view, in place on the overview ----
  if (!opts?.noPlayer) {
    g.save();
    g.translate(tx(car.x), tz(car.z)); // ≡ (Wp/2, Hp/2) when following
    g.rotate(-car.h); // mirrored x flips the heading's screen sense too
    if (loopView) g.scale(0.72, 0.72); // a marker, not a car-sized smear
    g.fillStyle = "#eef3ff"; // --ink
    g.beginPath();
    g.moveTo(0, -6.5);
    g.lineTo(4.2, 5.2);
    g.lineTo(-4.2, 5.2);
    g.closePath();
    g.fill();
    g.restore();
  }
  if (opts?.frame ?? true) {
    g.strokeStyle = "rgba(154,174,214,.4)"; // --border hue, canvas alpha
    g.lineWidth = 2;
    g.strokeRect(1, 1, Wp - 2, Hp - 2);
  }
}
