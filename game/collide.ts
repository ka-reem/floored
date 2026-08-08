import type { CarState } from "./physics";
import type { WorldData } from "./world/data";
import { HX, HZ, RW, DECKY } from "./world/const";

/* Player collision: deck edges/loops, static AABBs (parapets, pillars, ramp
   walls), building OBBs, and NPC vehicles. NPC hits return impact info so
   traffic can convert the victim into a free-sliding wreck. */

export interface NpcHit {
  npc: any;
  nx: number;
  nz: number;
  relSpeed: number;
}

const tmpN = { x: 0, z: 0 };

function collideAABB(car: CarState, px: number, pz: number, rr: number, bb: any): boolean {
  if (bb.y0 !== undefined && (car.y + 1.4 < bb.y0 || car.y > bb.y1)) return false;
  const cx = Math.max(bb.x0, Math.min(px, bb.x1));
  const cz = Math.max(bb.z0, Math.min(pz, bb.z1));
  const dx = px - cx, dz = pz - cz, d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return false;
  const d = Math.sqrt(d2) || 0.0001;
  tmpN.x = d2 ? dx / d : 1;
  tmpN.z = d2 ? dz / d : 0;
  const pen = rr - d;
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

export function obb2(
  ax: number, az: number, afx: number, afz: number, aw: number, al: number,
  bx: number, bz: number, bfx: number, bfz: number, bw: number, bl: number
) {
  const axes = [
    [afz, -afx], [afx, afz], [bfz, -bfx], [bfx, bfz],
  ];
  const dx = ax - bx, dz = az - bz;
  let pen = 1e9, nx = 0, nz = 0;
  for (const u of axes) {
    const ux = u[0], uz = u[1];
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

  // deck end loops (curved barrier rings)
  for (const e of [1, -1]) {
    const dzc = car.z - e * HZ;
    if (e * dzc > -0.2 && Math.abs(car.y - DECKY) < 2.6) {
      const dxc = car.x - HX, r = Math.hypot(dxc, dzc) || 0.001;
      const nx = dxc / r, nz = dzc / r, rOut = RW / 2 - 0.95, rIn = 2.05;
      if (r > rOut) {
        const pen = r - rOut;
        car.x -= nx * pen;
        car.z -= nz * pen;
        const vn = car.wvx * nx + car.wvz * nz;
        if (vn > 0) {
          car.wvx -= nx * vn * 1.07;
          car.wvz -= nz * vn * 1.07;
        }
        hit = true;
      } else if (r < rIn) {
        const pen = rIn - r;
        car.x += nx * pen;
        car.z += nz * pen;
        const vn = car.wvx * nx + car.wvz * nz;
        if (vn < 0) {
          car.wvx -= nx * vn * 1.07;
          car.wvz -= nz * vn * 1.07;
        }
        hit = true;
      }
    }
  }

  // static geometry, probed at the front and rear axle
  const col = world.colliders;
  for (const off of [halfL * 0.56, -halfL * 0.56]) {
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
