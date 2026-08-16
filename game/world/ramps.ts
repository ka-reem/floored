import { sstep } from "../util";
import {
  RAMP_W, RAMP_RUN, RAMP_NOSE, CONNECT_Z, FRONT_X,
} from "./const";
import { getCorridor } from "./corridor";

/* Ramp centrelines.

   The corridor is one-way, so a gore is either an *exit* (pavement peels off
   forward of the gore) or an *entrance* (pavement climbs up to the gore from
   behind it). Both are the same curve; the entrance is the exit run backwards.

   The path is a cubic Bezier laid out in the corridor's own frame at the gore
   — "forward" along the deck, "lateral" west toward the frontage road — then
   rotated into world space by the corridor pose there. It leaves tangentially
   (the first metres are a deceleration lane running parallel to the deck) and
   arrives perpendicular to the corridor, pointing straight at the frontage
   road. Everything downstream — parapet gaps, ramp meshes, colliders, drivable
   height, building keep-out — is derived from these samples, so the geometry
   can never drift out of sync.

   Both gores sit in the corridor's straight, zero-lateral-offset window beside
   the town: that is the only stretch where the deck is close enough to the
   frontage road for a ramp to reach it. See CONNECT_Z. */

const HALF = RAMP_W / 2;
/** samples per ramp; ~2.3 m apart at RAMP_RUN = 112 */
const NS = 56;
/** cubic-Bezier control offset that approximates a quarter arc */
const K = 0.5523;

/** The gores served today: one exit and one entrance, both on the west side,
    both inside the corridor's straight window beside the town. */
export const RAMP_PLAN: { zr: number; kind: "exit" | "entry" }[] = [
  { zr: CONNECT_Z[0], kind: "exit" },
  { zr: CONNECT_Z[1], kind: "entry" },
];

/** Vertical profile: 0 at the top, 1 at the bottom, with a linear middle and
    eased ends so there is no kink where the ramp leaves the deck or lands. */
function drop(u: number) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const e = 0.28, m = 1 / (1 - e);
  if (u < e) return (m * u * u) / (2 * e);
  if (u > 1 - e) return 1 - (m * (1 - u) * (1 - u)) / (2 * e);
  return m * (u - e / 2);
}

export interface RampSample {
  x: number;
  y: number;
  z: number;
  /** unit tangent, pointing away from the gore toward the foot */
  tx: number;
  tz: number;
  /** unit normal pointing at the deck (the ramp's inner side) */
  nx: number;
  nz: number;
  /** arclength from the gore nose */
  s: number;
  /** lateral half-widths: inner is clipped so pavement never overlaps the deck,
      outer opens from zero at the nose */
  hIn: number;
  hOut: number;
  /** ground height under this sample */
  gy: number;
}

export interface Ramp {
  /** z of the gore this ramp serves (matches the exit sign / HUD) */
  zr: number;
  /** "exit" leaves the deck ahead of the gore, "entry" joins it at the gore */
  kind: "exit" | "entry";
  /** 1 = west of the deck (the only side served today), -1 = east */
  mir: number;
  /** which way z runs as `s` grows: +1 for an exit, -1 for an entrance */
  dir: number;
  pts: RampSample[];
  len: number;
  /** arclength at which the ramp has cleared the deck edge and starts to fall */
  sSep: number;
  /** z extent of the divergence zone, i.e. how much parapet has to be removed */
  gapZ: number;
  footX: number;
  footZ: number;
  x0: number; x1: number; z0: number; z1: number; // bbox (centreline + half width)
}

function bez(a: number, b: number, c: number, d: number, t: number) {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

/** Build the ramp centrelines. `gh` is the bare terrain height field. */
export function buildRamps(gh: (x: number, z: number) => number): Ramp[] {
  const cor = getCorridor();
  const out: Ramp[] = [];
  for (const { zr, kind } of RAMP_PLAN) {
    const mir = 1; // west side only
    const dir = kind === "exit" ? 1 : -1;
    const pose = cor.pose(zr);
    // where the pavement leaves the deck edge, and how far it has to travel
    // laterally to reach the frontage road
    const lat0 = -(cor.halfWidth(zr) + 0.6);
    const edgeX = pose.x + lat0 * pose.nx;
    const DX = edgeX - FRONT_X;
    // control points in the gore frame: (forward along the deck, lateral west)
    const pf = [0, K * RAMP_RUN, RAMP_RUN, RAMP_RUN];
    const pl = [0, 0, -DX * (1 - K), -DX];
    const pts: RampSample[] = [];
    let acc = 0, lx = 0, lz = 0;
    for (let i = 0; i <= NS; i++) {
      const t = i / NS;
      const f = bez(pf[0], pf[1], pf[2], pf[3], t) * dir;
      const l = bez(pl[0], pl[1], pl[2], pl[3], t);
      // gore frame → world (the gore frame's forward axis is the corridor
      // tangent there, its lateral axis the corridor normal)
      const x = edgeX + f * pose.tx + l * pose.nx;
      const z = zr + f * pose.tz + l * pose.nz;
      if (i > 0) acc += Math.hypot(x - lx, z - lz);
      lx = x;
      lz = z;
      // the deck edge moves with the lane taper, so re-read it at this z
      const zc = cor.zAt(x, z);
      const deckEdgeLat = -cor.halfWidth(zc);
      const latHere = cor.latAt(x, z);
      pts.push({
        x, z, y: 0, tx: 0, tz: 0, nx: 0, nz: 0, s: acc,
        hIn: Math.min(HALF, Math.max(0, deckEdgeLat - latHere)),
        hOut: HALF * sstep(acc / RAMP_NOSE),
        gy: gh(x, z),
      });
    }
    const len = acc;
    // tangents / normals from neighbouring samples; the normal points at the deck
    const sgn = mir * dir;
    for (let i = 0; i <= NS; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(NS, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz) || 1;
      const p = pts[i];
      p.tx = dx / d;
      p.tz = dz / d;
      p.nx = sgn * p.tz;
      p.nz = -sgn * p.tx;
    }
    // where the pavement has fully cleared the deck edge: descent starts here
    let sSep = len * 0.25, gapZ = 0;
    for (const p of pts)
      if (p.hIn >= HALF - 0.001) {
        sSep = p.s;
        gapZ = Math.abs(p.z - zr);
        break;
      }
    const sEnd = Math.max(sSep + 8, len - 6); // short flat apron at the foot
    const topY = cor.centerY(zr);
    for (const p of pts) {
      const k = 1 - drop((p.s - sSep) / (sEnd - sSep));
      p.y = p.gy + (topY - p.gy) * k;
    }
    const foot = pts[NS];
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const p of pts) {
      x0 = Math.min(x0, p.x - HALF - 1);
      x1 = Math.max(x1, p.x + HALF + 1);
      z0 = Math.min(z0, p.z - HALF - 1);
      z1 = Math.max(z1, p.z + HALF + 1);
    }
    out.push({
      zr, kind, mir, dir, pts, len, sSep, gapZ,
      footX: foot.x, footZ: foot.z, x0, x1, z0, z1,
    });
  }
  return out;
}

export interface RampHit {
  /** surface height */
  y: number;
  /** signed lateral offset from the centreline (positive = deck side) */
  lat: number;
  s: number;
  ramp: Ramp;
}

const hit: RampHit = { y: 0, lat: 0, s: 0, ramp: null as unknown as Ramp };

/** Ramp surface under (x, z), or null. Within one ramp the *closest* piece of
    centreline wins (a tight curve can bring two stretches within a half-width
    of each other); between ramps the highest surface wins, so the deck-level
    end of a gore beats the ramp descending underneath it. `pad` widens the
    half-width test — use slack for physics, none for rendering queries. */
export function rampAt(ramps: Ramp[], x: number, z: number, pad = 0): RampHit | null {
  let best: RampHit | null = null;
  const lim = HALF + pad;
  for (const r of ramps) {
    if (x < r.x0 - pad || x > r.x1 + pad || z < r.z0 - pad || z > r.z1 + pad) continue;
    const pts = r.pts;
    let bd = lim, by = 0, bl = 0, bs = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1e-9) continue;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / d2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x - (a.x + dx * t), pz = z - (a.z + dz * t);
      const lat = Math.hypot(px, pz);
      if (lat >= bd) continue;
      bd = lat;
      by = a.y + (b.y - a.y) * t;
      bl = px * a.nx + pz * a.nz;
      bs = a.s + (b.s - a.s) * t;
    }
    if (bd >= lim) continue;
    if (!best || by > best.y) {
      hit.y = by;
      hit.lat = bl;
      hit.s = bs;
      hit.ramp = r;
      best = hit;
    }
  }
  return best;
}

/** Distance from (x, z) to the nearest ramp centreline (capped at `max`). */
export function distToRamp(ramps: Ramp[], x: number, z: number, max: number): number {
  let best = max;
  for (const r of ramps) {
    if (x < r.x0 - max || x > r.x1 + max || z < r.z0 - max || z > r.z1 + max) continue;
    for (const p of r.pts) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best) best = d;
    }
  }
  return best;
}

/** z positions where ramps meet the frontage roads, for the road network. */
export function rampFootZs(): number[] {
  return RAMP_PLAN.map((p) => p.zr + (p.kind === "exit" ? 1 : -1) * RAMP_RUN);
}
