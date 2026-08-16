import { sstep } from "../util";
import {
  HX, DECKY, RW, RAMP_W, RAMP_X0, RAMP_X1, RAMP_RUN, RAMP_NOSE, CONNECT_Z,
} from "./const";

/* Ramp centrelines.

   Every exit is served by one ramp per travel direction per side of the deck.
   A ramp leaves the deck edge *tangentially* — its first metres run parallel to
   the expressway as a deceleration lane — then curves west (or east) over
   RAMP_RUN metres of longitudinal run and arrives at the frontage road heading
   straight at it. The two ramps of one gore are mirror images that meet at the
   gore nose, so together they read as a single smooth curve kissing the deck.

   The path is a cubic Bezier laid out in a "west frame" (x from the deck edge
   out to RAMP_X0, forward progress along z), then mirrored/flipped per side and
   direction. Everything downstream — deck parapet gaps, ramp meshes, barriers,
   colliders, drivable height, building keep-out — is derived from these
   samples, so the geometry can never drift out of sync. */

/** x of the west deck edge; the mirrored east edge is 2*HX - this. */
const DECK_EDGE = HX - RW / 2;
const HALF = RAMP_W / 2;
/** samples per ramp; ~2.3 m apart at RAMP_RUN = 110 */
const NS = 56;
/** cubic-Bezier control offset that approximates a quarter arc */
const K = 0.5523;

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
  /** z of the gore this ramp leaves from (matches the exit sign / HUD) */
  zr: number;
  /** 1 = west of the deck, -1 = east */
  mir: number;
  /** deck travel direction this ramp serves */
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

/** Build the twelve ramp centrelines. `gh` is the bare terrain height field. */
export function buildRamps(gh: (x: number, z: number) => number): Ramp[] {
  const out: Ramp[] = [];
  const DX = RAMP_X1 - RAMP_X0;
  for (const zr of CONNECT_Z)
    for (const mir of [1, -1])
      for (const dir of [1, -1]) {
        // Control points in the west frame: (x, forward progress along the deck).
        // K is the cubic-Bezier quarter-arc constant, so the path is very close
        // to a quarter ellipse — gentle where it leaves the deck (~220 m radius)
        // and tightening only as it flattens out at the foot.
        const px = [RAMP_X1, RAMP_X1, RAMP_X0 + K * DX, RAMP_X0];
        const pz = [0, K * RAMP_RUN, RAMP_RUN, RAMP_RUN];
        const pts: RampSample[] = [];
        let acc = 0, lx = 0, lz = 0;
        for (let i = 0; i <= NS; i++) {
          const t = i / NS;
          const fx = bez(px[0], px[1], px[2], px[3], t); // west-frame x
          const fz = bez(pz[0], pz[1], pz[2], pz[3], t); // forward progress
          const x = mir > 0 ? fx : 2 * HX - fx;
          const z = zr + dir * fz;
          if (i > 0) acc += Math.hypot(x - lx, z - lz);
          lx = x;
          lz = z;
          pts.push({
            x, z, y: 0, tx: 0, tz: 0, nx: 0, nz: 0, s: acc,
            // inner edge is clipped to the deck edge so the nose is a true gore
            hIn: Math.min(HALF, Math.max(0, DECK_EDGE - fx)),
            hOut: HALF * sstep(acc / RAMP_NOSE),
            gy: gh(x, z),
          });
        }
        const len = acc;
        // tangents / normals from neighbouring samples
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
        for (const p of pts) {
          const k = 1 - drop((p.s - sSep) / (sEnd - sSep));
          p.y = p.gy + (DECKY - p.gy) * k;
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
          zr, mir, dir, pts, len, sSep, gapZ,
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
  const zs: number[] = [];
  for (const zr of CONNECT_Z) for (const dir of [1, -1]) zs.push(zr + dir * RAMP_RUN);
  return zs;
}
