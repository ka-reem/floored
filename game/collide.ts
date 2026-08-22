import type { CarState } from "./physics";
import type { WorldData } from "./world/data";
import { parapetGap, type Ramp } from "./world/ramps";
import { BYPASS, type RouteGraph, type RoutePose } from "./world/routegraph";

/* Player collision: the corridor's parapets (analytic, from the same
   half-width the walls are swept from), static AABBs (piers, toll islands,
   ramp walls), building OBBs, and NPC vehicles. NPC hits return impact info so
   traffic can convert the victim into a free-sliding wreck. */

export interface NpcHit {
  npc: any;
  nx: number;
  nz: number;
  relSpeed: number;
}

const tmpN = { x: 0, z: 0 };

/* newParapetGaps() walks every bypass station, so resolve it once per graph
   rather than once per frame. */
let _gapsFor: RouteGraph | null = null;
let _newGaps: { z0: number; z1: number; side: 1 | -1 }[] = [];
function newGaps(routes: RouteGraph) {
  if (_gapsFor !== routes) {
    _gapsFor = routes;
    _newGaps = routes.newParapetGaps();
  }
  return _newGaps;
}
/* Same deal for the ramp gores: parapetGap() builds a fresh window per ramp,
   and the ramp list is fixed for the life of a terrain. */
let _rgFor: Ramp[] | null = null;
let _rampGaps: { z0: number; z1: number }[] = [];
function rampGaps(ramps: Ramp[]) {
  if (_rgFor !== ramps) {
    _rgFor = ramps;
    _rampGaps = ramps.map(parapetGap);
  }
  return _rampGaps;
}
const _byPose: RoutePose = {
  x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: 1, nz: 0, h: 0, grade: 0, bank: 0,
};

/* The analytic wall clamps below depenetrate by the full overlap in one frame.
   Against a wall you actually drove into that is at most v_lat·dt (~0.15 m at
   120 Hz), but when a clamp *re-arms* — the car crosses out of a parapet-gap
   window, or an on-ramp/on-bypass exemption stops holding — the "penetration"
   is however far outside the wall line the car legitimately got, and applying
   it whole teleports the car sideways. Classification changes must not move
   the car, so the positional correction is capped per call; the velocity
   reflection still kills the outward speed immediately. */
const CLAMP_STEP = 0.35;

function collideAABB(car: CarState, px: number, pz: number, rr: number, bb: any): boolean {
  if (bb.y0 !== undefined && (car.y + 1.4 < bb.y0 || car.y > bb.y1)) return false;
  const cx = Math.max(bb.x0, Math.min(px, bb.x1));
  const cz = Math.max(bb.z0, Math.min(pz, bb.z1));
  const dx = px - cx, dz = pz - cz, d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return false;
  let pen: number;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    tmpN.x = dx / d;
    tmpN.z = dz / d;
    pen = rr - d;
  } else {
    /* Probe inside the box: the clamped point IS the probe, so there is no
       contact direction to normalise. Push out along the shallowest face, the
       same fallback collideObb() already uses. The old default was a fixed +x
       of the full rr, a direction unrelated to the box — for a wall-shaped
       AABB that is as likely to drive the car deeper in as out. */
    const hx = (bb.x1 - bb.x0) / 2, hz = (bb.z1 - bb.z0) / 2;
    const lx = px - (bb.x0 + hx), lz = pz - (bb.z0 + hz);
    const ex = hx - Math.abs(lx), ez = hz - Math.abs(lz);
    if (ex < ez) {
      tmpN.x = Math.sign(lx) || 1;
      tmpN.z = 0;
      pen = ex + rr;
    } else {
      tmpN.x = 0;
      tmpN.z = Math.sign(lz) || 1;
      pen = ez + rr;
    }
  }
  car.x += tmpN.x * pen;
  car.z += tmpN.z * pen;
  const vn = car.wvx * tmpN.x + car.wvz * tmpN.z;
  if (vn < 0) {
    car.wvx -= tmpN.x * vn * 1.07;
    car.wvz -= tmpN.z * vn * 1.07;
  }
  return true;
}

function collideObb(car: CarState, px: number, pz: number, rr: number, o: any): boolean {
  if (car.y + 1.4 < o.y0 || car.y > o.y1) return false;
  // into building local frame
  const dx = px - o.x, dz = pz - o.z;
  const lx = dx * o.cos - dz * o.sin;
  const lz = dx * o.sin + dz * o.cos;
  const cx = Math.max(-o.hw, Math.min(lx, o.hw));
  const cz = Math.max(-o.hd, Math.min(lz, o.hd));
  const ddx = lx - cx, ddz = lz - cz, d2 = ddx * ddx + ddz * ddz;
  if (d2 >= rr * rr) return false;
  const d = Math.sqrt(d2) || 0.0001;
  let nlx: number, nlz: number, pen: number;
  if (d2 > 1e-8) {
    nlx = ddx / d;
    nlz = ddz / d;
    pen = rr - d;
  } else {
    // center inside the box: push out along the shallowest face
    const ex = o.hw - Math.abs(lx), ez = o.hd - Math.abs(lz);
    if (ex < ez) {
      nlx = Math.sign(lx) || 1;
      nlz = 0;
      pen = ex + rr;
    } else {
      nlx = 0;
      nlz = Math.sign(lz) || 1;
      pen = ez + rr;
    }
  }
  // back to world frame
  const nx = nlx * o.cos + nlz * o.sin;
  const nz = -nlx * o.sin + nlz * o.cos;
  car.x += nx * pen;
  car.z += nz * pen;
  const vn = car.wvx * nx + car.wvz * nz;
  if (vn < 0) {
    car.wvx -= nx * vn * 1.07;
    car.wvz -= nz * vn * 1.07;
  }
  return true;
}

/* The four separating-axis candidates, as flat [ux,uz] pairs. obb2 runs once
   per nearby NPC per frame and the old array-of-arrays literal was five
   allocations a call, so the scratch is module-scope. Nothing obb2 calls can
   re-enter it. */
const _sat = new Float64Array(8);

export function obb2(
  ax: number, az: number, afx: number, afz: number, aw: number, al: number,
  bx: number, bz: number, bfx: number, bfz: number, bw: number, bl: number
) {
  _sat[0] = afz; _sat[1] = -afx;
  _sat[2] = afx; _sat[3] = afz;
  _sat[4] = bfz; _sat[5] = -bfx;
  _sat[6] = bfx; _sat[7] = bfz;
  const dx = ax - bx, dz = az - bz;
  let pen = 1e9, nx = 0, nz = 0;
  for (let i = 0; i < 8; i += 2) {
    const ux = _sat[i], uz = _sat[i + 1];
    const ra = aw * Math.abs(ux * afz - uz * afx) + al * Math.abs(ux * afx + uz * afz);
    const rb = bw * Math.abs(ux * bfz - uz * bfx) + bl * Math.abs(ux * bfx + uz * bfz);
    const dist = ux * dx + uz * dz;
    const o = ra + rb - Math.abs(dist);
    if (o <= 0) return null;
    if (o < pen) {
      pen = o;
      const s = dist < 0 ? -1 : 1;
      nx = ux * s;
      nz = uz * s;
    }
  }
  return { pen, nx, nz };
}

export function collidePlayer(
  car: CarState,
  world: WorldData,
  npcs: any[],
  halfW: number,
  halfL: number
): { hit: boolean; npcHits: NpcHit[]; wallImpact: number } {
  const fx = Math.sin(car.h), fz = Math.cos(car.h), rx = fz, rz = -fx;
  let hit = false;
  let wallImpact = 0;
  const npcHits: NpcHit[] = [];
  const preVx = car.wvx, preVz = car.wvz;

  /* Deck parapets. The corridor's width changes along its length, so rather
     than filling the collider grid with a few thousand wall boxes we clamp the
     car's lateral offset against the analytic edge — cheaper, and it can never
     disagree with the swept wall geometry, which is generated from the same
     half-width. The exception is a gore: there the parapet is cut away so the
     ramp can leave, and the ramp's own wall OBBs take over — so a car anywhere
     on ramp pavement is exempt for as long as it is still up at deck height. */
  const cor = world.terrain.corridor;
  if (Math.abs(car.y - cor.centerY(car.z)) < 2.6 && car.z > cor.ZB0 && car.z < cor.ZB1) {
    const zc = cor.zAt(car.x, car.z);
    const lat = cor.latAt(car.x, car.z);
    const lim = cor.halfWidth(zc) + 0.06 - halfW;
    const side = lat >= 0 ? 1 : -1;
    let guarded = true;
    if (side < 0) {
      // the parapet mesh is cut away across the divergence zone…
      for (const g of rampGaps(world.terrain.ramps))
        if (car.z > g.z0 && car.z < g.z1) guarded = false;
      // …and stays absent for as long as the car is on ramp pavement
      const ry = world.terrain.onRamp(car.x, car.z);
      if (ry !== null && Math.abs(ry - car.y) < 2.6) guarded = false;
    }
    /* the bypass gores cut the parapet too — west at the diverge, and the
       east wall's first-ever gap at the merge — and a car on bypass pavement
       at deck height (the shared gore wedges) is likewise exempt */
    if (world.routes) {
      for (const gp of newGaps(world.routes))
        if (car.z > gp.z0 && car.z < gp.z1 && side === gp.side) guarded = false;
      if (guarded) {
        const sf = world.routes.surfaceAt(car.x, car.z, 1.0);
        if (sf !== null && Math.abs(sf.y - car.y) < 2.6) guarded = false;
      }
    }
    if (guarded && Math.abs(lat) > lim) {
      const pen = Math.min(Math.abs(lat) - lim, CLAMP_STEP);
      const m = cor.slopeX(zc), inv = 1 / Math.hypot(m, 1);
      const nx = side * inv, nz = side * -m * inv; // outward wall normal
      car.x -= nx * pen;
      car.z -= nz * pen;
      const vn = car.wvx * nx + car.wvz * nz;
      if (vn > 0) {
        car.wvx -= nx * vn * 1.07;
        car.wvz -= nz * vn * 1.07;
      }
      hit = true;
    }
  }

  /* Bypass parapets: the same analytic clamp, in the bypass's own station
     frame. Skipped on a side whose half-width is gore-clipped (the wedge is
     shared pavement — the deck's own edge continues there), and only while
     the car is actually at the bypass surface, so nothing under the viaduct
     ever feels it. */
  if (world.routes) {
    const by = world.routes.bypass;
    const bHit = by.project(car.x, car.z, BYPASS.half + 6);
    if (bHit) {
      const p = by.poseAt(bHit.s, _byPose);
      const surfY = p.y + bHit.lat * p.bank;
      if (Math.abs(car.y - surfY) < 2.6) {
        const { hwL, hwR } = by.halfWidths(bHit.s);
        const hwSide = bHit.lat >= 0 ? hwL : hwR;
        if (hwSide > BYPASS.half - 0.05) {
          const lim = hwSide + 0.06 - halfW;
          if (Math.abs(bHit.lat) > lim) {
            const pen = Math.min(Math.abs(bHit.lat) - lim, CLAMP_STEP);
            const sgn = bHit.lat >= 0 ? 1 : -1;
            const nx = sgn * p.nx, nz = sgn * p.nz; // outward wall normal
            car.x -= nx * pen;
            car.z -= nz * pen;
            const vn = car.wvx * nx + car.wvz * nz;
            if (vn > 0) {
              car.wvx -= nx * vn * 1.07;
              car.wvz -= nz * vn * 1.07;
            }
            hit = true;
          }
        }
      }
    }
  }

  // static geometry, probed at the front and rear axle
  const col = world.colliders;
  const axle = halfL * 0.56;
  for (let k = 0; k < 2; k++) {
    const off = k === 0 ? axle : -axle;
    const px = car.x + fx * off, pz = car.z + fz * off;
    for (const bi of col.nearbyAabbs(px, pz))
      if (collideAABB(car, px, pz, halfW + 0.05, col.aabbs[bi])) hit = true;
    for (const oi of col.nearbyObbs(px, pz))
      if (collideObb(car, px, pz, halfW + 0.1, col.obbs[oi])) hit = true;
  }

  // NPC vehicles
  for (const n of npcs) {
    if (!n.active) continue;
    if (Math.abs(car.y - n.y) > 2.6) continue;
    const ddx = car.x - n.x, ddz = car.z - n.z;
    const reach = n.L / 2 + halfL + 1.6;
    if (ddx * ddx + ddz * ddz > reach * reach) continue;
    const res = obb2(
      car.x, car.z, fx, fz, halfW, halfL,
      n.x, n.z, Math.sin(n.hVis), Math.cos(n.hVis), n.W / 2, n.L / 2
    );
    if (res) {
      car.x += res.nx * res.pen * 0.55;
      car.z += res.nz * res.pen * 0.55;
      const nvx = n.wreck ? n.wreck.vx : Math.sin(n.hVis) * n.v;
      const nvz = n.wreck ? n.wreck.vz : Math.cos(n.hVis) * n.v;
      const relVx = car.wvx - nvx, relVz = car.wvz - nvz;
      const vn = relVx * res.nx + relVz * res.nz;
      if (vn < 0) {
        // exchange momentum: player loses some, NPC gains along -n
        const carM = 1450, npcM = n.mass || 1300;
        const j = (-vn * 1.5) / (1 / carM + 1 / npcM);
        car.wvx += (res.nx * j) / carM;
        car.wvz += (res.nz * j) / carM;
        npcHits.push({ npc: n, nx: -res.nx, nz: -res.nz, relSpeed: -vn });
      }
      hit = true;
    }
  }

  if (hit) {
    car.wvx *= 0.965;
    car.wvz *= 0.965;
    car.u = car.wvx * fx + car.wvz * fz;
    car.v = car.wvx * rx + car.wvz * rz;
    car.r *= 0.65;
    const dvx = car.wvx - preVx, dvz = car.wvz - preVz;
    wallImpact = Math.hypot(dvx, dvz);
  }
  return { hit, npcHits, wallImpact };
}
