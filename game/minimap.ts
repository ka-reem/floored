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
   little map in the car and the big one on the glass can never drift apart. */

const SC = 0.4; // pixels per metre
/** the corridor is drawn in place and a lap either side, to hide the splice */
const LAPS = [0, -1, 1];
const NO_LAPS: number[] = [];
/** every Nth station is plenty at this scale (stations are 4 m apart) */
const SKIP = 2;

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
    one edge, back along the other. `dz` shifts the whole run by a lap. */
function pavePath(
  g: CanvasRenderingContext2D,
  cor: Corridor,
  zLo: number,
  zHi: number,
  dz: number,
  tx: (x: number) => number,
  tz: (z: number) => number
): boolean {
  const st = cor.stations;
  if (st.length < 2) return false;
  const step = st[1].z - st[0].z || 4;
  const i0 = Math.max(0, Math.ceil((zLo - st[0].z) / step));
  const i1 = Math.min(st.length - 1, Math.floor((zHi - st[0].z) / step));
  if (i1 - i0 < SKIP) return false;
  g.beginPath();
  for (let i = i0; i <= i1; i += SKIP) {
    const s = st[i];
    cor.worldOf(s.z, s.hw, _p);
    if (i === i0) g.moveTo(tx(_p.x), tz(_p.z + dz));
    else g.lineTo(tx(_p.x), tz(_p.z + dz));
  }
  for (let i = i1; i >= i0; i -= SKIP) {
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
  tx: (x: number) => number,
  tz: (z: number) => number
): boolean {
  const st = cor.stations;
  if (st.length < 2) return false;
  const step = st[1].z - st[0].z || 4;
  const i0 = Math.max(0, Math.ceil((zLo - st[0].z) / step));
  const i1 = Math.min(st.length - 1, Math.floor((zHi - st[0].z) / step));
  if (i1 - i0 < SKIP) return false;
  g.beginPath();
  for (let i = i0; i <= i1; i += SKIP) {
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
  const sc = opts?.sc ?? SC;
  // x mirrored: +x in this y-up world points LEFT when north (+z) is
  // up-screen — the old +x mapping drew a view-from-below (left turns bent
  // right on the map). Same fix as the head-unit map's toS.
  const tx = (x: number) => Wp / 2 - (x - car.x) * sc;
  const tz = (z: number) => Hp / 2 - (z - car.z) * sc;
  g.clearRect(0, 0, Wp, Hp);
  g.fillStyle = "rgba(8,10,18,.8)";
  g.fillRect(0, 0, Wp, Hp);

  /** world-space radius the canvas covers, plus a margin for wide geometry.
      Taken off the LONGER side so a non-square pane still culls correctly. */
  const R = Math.max(Wp, Hp) / (2 * sc) + 40;

  // ---- town roads, straight off the graph ----
  g.strokeStyle = "rgba(110,130,170,.55)";
  g.lineWidth = 2.5;
  for (const e of world.net.edges) {
    const n = e.ss.length - 1;
    const mi = Math.floor(n / 2) * 3;
    const mx = e.pts[mi], mz = e.pts[mi + 2];
    if (Math.abs(mx - car.x) > R + e.len / 2 || Math.abs(mz - car.z) > R + e.len / 2) continue;
    g.beginPath();
    let started = false;
    for (let i = 0; i <= n; i += 2) {
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
  const corNear = Math.abs(car.x - HX) < R + 90;
  for (const lap of corNear ? LAPS : NO_LAPS) {
    const dz = lap * cor.LOOP;
    // the span of *station* z that lands inside the view once shifted by dz
    const zLo = Math.max(cor.ZB0, car.z - R - dz);
    const zHi = Math.min(cor.ZB1, car.z + R - dz);
    if (zHi - zLo < 8) continue;

    if (pavePath(g, cor, zLo, zHi, dz, tx, tz)) {
      g.fillStyle = "rgba(46,86,120,.75)";
      g.fill();
      g.strokeStyle = "rgba(120,200,255,.9)";
      g.lineWidth = 1.4;
      g.stroke();
    }
    // tunnel: the deck is roofed here, so grey it back out
    const tLo = Math.max(zLo, TUNNEL.z0), tHi = Math.min(zHi, TUNNEL.z1);
    if (tHi > tLo && pavePath(g, cor, tLo, tHi, dz, tx, tz)) {
      g.fillStyle = "rgba(10,14,26,.72)";
      g.fill();
    }
    // toll plaza: the wide bit, flagged so the fan-out reads as deliberate
    const kLo = Math.max(zLo, TOLL.plazaZ0), kHi = Math.min(zHi, TOLL.plazaZ1);
    if (kHi > kLo && pavePath(g, cor, kLo, kHi, dz, tx, tz)) {
      g.fillStyle = "rgba(255,210,120,.32)";
      g.fill();
    }
    // centreline, so the direction of travel is legible even where it bends
    if (centrePath(g, cor, zLo, zHi, dz, tx, tz)) {
      g.strokeStyle = "rgba(160,220,255,.5)";
      g.lineWidth = 1;
      g.stroke();
    }

    /* ---- the bypass viaduct: a second ribbon, drawn AFTER the corridor so
       the bridge crossing reads as the overlap it is. Station-swept with the
       asymmetric half-widths, so the gore wedges taper on the map exactly as
       they do on the road. */
    const bst = world.routes?.bypass.stations;
    if (bst && bst.length > 2 &&
      bst[0].z + dz < car.z + R && bst[bst.length - 1].z + dz > car.z - R) {
      g.beginPath();
      for (let i = 0; i < bst.length; i += SKIP) {
        const p = bst[i];
        const X = tx(p.x + p.nx * p.hwL), Z = tz(p.z + p.nz * p.hwL + dz);
        if (i === 0) g.moveTo(X, Z);
        else g.lineTo(X, Z);
      }
      for (let i = bst.length - 1; i >= 0; i -= SKIP) {
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
  }

  // ---- ramps: the real curved centrelines ----
  g.lineWidth = 3;
  g.strokeStyle = "rgba(120,255,190,.85)";
  for (const r of world.terrain.ramps) {
    const mx = (r.x0 + r.x1) / 2, mz = (r.z0 + r.z1) / 2;
    if (Math.abs(mx - car.x) > R + (r.x1 - r.x0) / 2) continue;
    if (Math.abs(mz - car.z) > R + (r.z1 - r.z0) / 2) continue;
    const n = r.pts.length - 1;
    g.beginPath();
    let started = false;
    for (let i = 0; i <= n; i += 2) {
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

  // ---- exit numbers, on the town side of the deck ----
  g.font = exitFont();
  g.textAlign = "center";
  g.fillStyle = "rgba(120,255,190,.95)";
  for (const ex of world.exits) {
    if (Math.abs(ex.z - car.z) > R) continue;
    cor.worldOf(ex.z, -(cor.halfWidth(ex.z) + 12), _p);
    const X = tx(_p.x), Z = tz(_p.z);
    if (X < 8 || X > Wp - 8 || Z < 8 || Z > Hp - 8) continue;
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

  // ---- player ----
  if (!opts?.noPlayer) {
    g.save();
    g.translate(Wp / 2, Hp / 2);
    g.rotate(-car.h); // mirrored x flips the heading's screen sense too
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(0, -6.5);
    g.lineTo(4.2, 5.2);
    g.lineTo(-4.2, 5.2);
    g.closePath();
    g.fill();
    g.restore();
  }
  if (opts?.frame ?? true) {
    g.strokeStyle = "rgba(150,170,210,.4)";
    g.lineWidth = 2;
    g.strokeRect(1, 1, Wp - 2, Hp - 2);
  }
}
