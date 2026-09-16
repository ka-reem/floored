import { WALL, type CarState } from "./physics";
import type { WorldData } from "./world/data";
import { SURFACE_TOL } from "./world/const";
import { parapetGap, type Ramp } from "./world/ramps";
import {
  MOUNTAIN_EDGE, type RouteGraph, type RoutePose, type SurfaceHit,
} from "./world/routegraph";

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
let _newGaps: { z0: number; z1: number; side: 1 | -1; edgeId: number }[] = [];
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
/* per-frame query targets for the parapet clamps below — same discipline as
   _byPose: read and dropped within the frame, never held across calls */
const _bySurf: SurfaceHit = { y: 0, edgeId: 0, s: 0, lat: 0, bank: 0 };
const _byHit = { s: 0, lat: 0 };
const _byHw = { hwL: 0, hwR: 0 };
const _bySh = { shL: false, shR: false };

/* The analytic wall clamps below depenetrate by the full overlap in one frame.
   Against a wall you actually drove into that is at most v_lat·dt (~0.15 m at
   120 Hz), but when a clamp *re-arms* — the car crosses out of a parapet-gap
   window, or an on-ramp/on-bypass exemption stops holding — the "penetration"
   is however far outside the wall line the car legitimately got, and applying
   it whole teleports the car sideways. Classification changes must not move
   the car, so the positional correction is capped per call; the velocity
   reflection still kills the outward speed immediately. */
const CLAMP_STEP = 0.35;

/* How far past a wall line a car may be and still be pushed back by THAT wall.
   The clamps run every frame, so a car that drove into one is at most v_lat·dt
   beyond it (~0.25 m at 120 Hz), and a closing gore taper sliding the line
   under a car moves it less again — the clamp catches the line as it passes
   and never lets `over` grow. Anything further out is not a car against this
   wall, it is a car on some other piece of road that happens to fall inside
   the search radius. */
const WALL_REACH = 1.2;

/* Resolve one solid contact. `nx,nz` is the SEPARATION direction (out of the
   obstacle, toward where the car should end up) and `close` the closing speed
   along it, > 0. The inward component is killed and a rebound added on top:
   the size of that rebound is physics.ts's WALL.rebound(), a function of the
   closing speed with a hard zero below a graze. Every static contact site in
   this file used to inline `* 1.07` here, i.e. a flat 7% off anything it
   touched however gently — see the WALL block for why that is wrong at both
   ends. The impulse is purely horizontal, so no contact can ever launch the
   car off the deck. */
function bounceOff(car: CarState, nx: number, nz: number, close: number) {
  const dv = close + WALL.rebound(close);
  car.wvx += nx * dv;
  car.wvz += nz * dv;
}

/* CONTACT SEVERITY. Both static-geometry helpers return the CLOSING SPEED
   along the contact normal (m/s, >= 0), or NO_CONTACT when they did not
   touch — the thing every contact site here already computes as `vn` and
   then threw away. It is the only honest severity number in this file:
   collidePlayer's wallImpact is |Δv| across the whole call and therefore
   carries the flat 0.965 velocity scale applied to ANY hit, so at 60 m/s a
   pure sideways scrape reads 2.1 before the wall has done anything. The
   normal component does not care how fast the car was travelling ALONG the
   wall — which is exactly the scrape-vs-impact distinction. */
export const NO_CONTACT = -1;

function collideAABB(car: CarState, px: number, pz: number, rr: number, bb: any): number {
  if (bb.y0 !== undefined && (car.y + 1.4 < bb.y0 || car.y > bb.y1)) return NO_CONTACT;
  const cx = Math.max(bb.x0, Math.min(px, bb.x1));
  const cz = Math.max(bb.z0, Math.min(pz, bb.z1));
  const dx = px - cx, dz = pz - cz, d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return NO_CONTACT;
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
    bounceOff(car, tmpN.x, tmpN.z, -vn);
    return -vn;
  }
  return 0;
}

function collideObb(car: CarState, px: number, pz: number, rr: number, o: any): number {
  if (car.y + 1.4 < o.y0 || car.y > o.y1) return NO_CONTACT;
  // into building local frame
  const dx = px - o.x, dz = pz - o.z;
  const lx = dx * o.cos - dz * o.sin;
  const lz = dx * o.sin + dz * o.cos;
  const cx = Math.max(-o.hw, Math.min(lx, o.hw));
  const cz = Math.max(-o.hd, Math.min(lz, o.hd));
  const ddx = lx - cx, ddz = lz - cz, d2 = ddx * ddx + ddz * ddz;
  if (d2 >= rr * rr) return NO_CONTACT;
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
    bounceOff(car, nx, nz, -vn);
    return -vn;
  }
  return 0;
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
  halfL: number,
  /** Frame time, so the per-contact scrub and yaw damping below are a rate
      and not a per-frame lottery. Optional and defaulted to a 60 Hz frame so
      the old two-argument call sites keep exactly the behaviour they had. */
  dt = 1 / 60
): { hit: boolean; npcHits: NpcHit[]; wallImpact: number; normalImpact: number } {
  const fx = Math.sin(car.h), fz = Math.cos(car.h), rx = fz, rz = -fx;
  let hit = false;
  let wallImpact = 0;
  /* Hardest contact this call, as closing speed along the contact normal —
     see NO_CONTACT. Walls, buildings and NPCs all fold into this one number,
     so how hard a contact was has a single answer everywhere it is judged. */
  let normalImpact = 0;
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
  /* at deck height AND within the deck's own width plus the apron bulge —
     deck or paved runoff pocket, the moving east wall below contains it */
  let onDeckPocket = false;
  if (Math.abs(car.y - cor.centerY(car.z)) < SURFACE_TOL && car.z > cor.ZB0 && car.z < cor.ZB1) {
    const zc = cor.zAt(car.x, car.z);
    const lat = cor.latAt(car.x, car.z);
    /* The east wall line BULGES outward through the mountain gores by the
       runoff-apron width (routegraph.apronW): through the gore mouth that
       opens the exit, and past it the taper is the angled barrier that walls
       a car that missed the exit back onto the deck. The clamp stays ARMED
       the whole way — this is a moving wall, not an exemption — which is
       what contains a flat-out wall-hugger that the mountain road's own
       (route-frame) clamps could never catch. */
    const apron = world.routes && lat > 0 ? world.routes.apronW(zc) : 0;
    const side = lat >= 0 ? 1 : -1;
    /* The WEST edge carries the auxiliary ramp lanes (corridor.AUX_LANES), so
       the analytic wall on that side has to be read off `edgeHalf`, not off
       halfWidth. Read off halfWidth it was an invisible barrier down the
       middle of the deceleration lane. */
    const edge = cor.edgeHalf(zc, side);
    const lim = edge + apron + 0.06 - halfW;
    onDeckPocket = lat <= cor.halfWidth(zc) + apron + 0.3 &&
      -lat <= cor.edgeHalf(zc, -1) + 0.3;
    let guarded = true;
    if (side < 0) {
      // the parapet mesh is cut away across the divergence zone…
      for (const g of rampGaps(world.terrain.ramps))
        if (car.z > g.z0 && car.z < g.z1) guarded = false;
      // …and stays absent for as long as the car is on ramp pavement
      const ry = world.terrain.onRamp(car.x, car.z);
      if (ry !== null && Math.abs(ry - car.y) < SURFACE_TOL) guarded = false;
    }
    /* the bypass gores cut the parapet too — west at the diverge, and the
       east wall's first-ever gap at the merge — and a car on bypass pavement
       at deck height (the shared gore wedges) is likewise exempt. The
       MOUNTAIN gaps are deliberately NOT in this exemption: their windows
       are covered by the apron bulge above, which keeps a wall armed. */
    if (world.routes) {
      for (const gp of newGaps(world.routes))
        if (gp.edgeId !== MOUNTAIN_EDGE && car.z > gp.z0 && car.z < gp.z1 && side === gp.side)
          guarded = false;
      if (guarded) {
        const sf = world.routes.surfaceAt(car.x, car.z, 1.0, _bySurf);
        if (sf !== null && Math.abs(sf.y - car.y) < SURFACE_TOL) {
          if (sf.edgeId !== MOUNTAIN_EDGE) guarded = false;
          else if (side > 0) {
            /* MOUNTAIN pavement. The apron's moving wall used to stay armed
               here too, on the theory that the road inside the bulge is the
               hugger hole. It is not — and armed, it was the wall players
               hit: the apron caps and tapers back at 0.35 m/m from the first
               z where the road's inner edge has left the deck edge, which is
               ~20 m past the nose, while the road itself is still at deck
               height (it climbs 3.4 m only ~100 m in) and still swinging out
               across the deck frame. So from s ≈ 20 to ≈ 100 the deck-frame
               wall line ran THROUGH the pass's forward lane, and every car
               that took EXIT 4 was clamped to a dead stop on the road at
               corLat ≈ hw + apron — the same wall, mirrored, shut the merge
               end from the pass side. A car INSIDE the road's own pavement
               (no pad: strictly between its edges) is the road's business —
               its free-edge clamps below hold it, and the instant it leaves
               that pavement it is on the apron pocket or the deck and this
               wall is armed again. That keeps the hugger contained: through
               the wedge the road's east edge IS the apron's outer edge, so
               a car sliding out of the road meets the road wall first and
               the re-armed apron wall a step later. */
            const { hwL, hwR } = world.routes.mtn.halfWidths(sf.s, _byHw);
            if (sf.lat <= hwL && sf.lat >= -hwR) guarded = false;
          }
        }
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
        bounceOff(car, -nx, -nz, vn);
        if (vn > normalImpact) normalImpact = vn;
      }
      hit = true;
    }
  }

  /* Bypass parapets: the same analytic clamp, in the bypass's own station
     frame, and only while the car is at the bypass surface so nothing under
     the viaduct ever feels it. Two more gates, both of which cost blood:

     - the edge must be FREE, not shared with the deck through a gore wedge
       (routegraph's shL/shR). The old test for that was
       `hwSide > BYPASS.half - 0.05` — "this side is not clipped" — which also
       switched the wall off across both gore NOSES, where the pavement tapers
       open from nothing over a 10 m drop and is the only thing between the
       car and the ground.
     - the car must actually be up against the wall. project() searches out to
       BYPASS.half + 6, which is ~10 m of reach for a 4.7 m half-width road:
       beside either gore that is far enough to grab a car driving the MAIN
       DECK's kerb lane (or its fast lane at the merge) and drag it sideways
       onto the viaduct at CLAMP_STEP a frame — and where the deck's own
       parapet had re-armed, the two clamps then fought frame to frame.

     No such reach limit belongs on the deck clamp above: the corridor frame is
     valid across the whole roadway, so a car at deck height in the band really
     is on the deck however far out it has got. The bypass is a narrow ribbon
     whose frame means nothing a lane away from it. */
  if (world.routes) {
    /* both new pavements: the bypass's concrete parapets and the mountain
       road's rock face / stone parapet share one contract — an analytic wall
       at each FREE edge, none through the shared gore wedges */
    for (const e of world.routes.attached) {
      /* MOUNTAIN: no free-edge wall for a car on the deck or its runoff
         apron. The road's west edge stops being "shared" the moment the
         road's centre is MTN.half outside the deck edge (s ≈ 18 at each
         gore), and hwR snaps to full width there — while the paved apron
         pocket still runs from the deck edge to that line and a car taking
         EXIT 4 at speed is crossing it diagonally. This clamp does not know
         inside from outside: the car arriving from the pocket sat within
         WALL_REACH of the line, its velocity relative to the peeling road
         counted as "outward", and it was reflected — 70 → 7 km/h on the
         exit, the same wall mirrored on the way in at the merge. A car in
         the pocket is the deck clamp's (apron-widened, always armed)
         business; this wall takes over once it is off both pavements. The
         bypass keeps the wall: its deck clamp is switched OFF through its
         gores, so the free edge is what stands between a car and the drop.
         West side (−lat) only — the deck is west of this road at both gores;
         the east edge stays walled even inside the apron span, so a car's
         body never hangs over the stone parapet while its centre is still
         inside the pavement (the deck clamp is exempt there). */
      const bHit = e.project(car.x, car.z, e.maxHalf + 6, _byHit);
      if (!bHit) continue;
      if (onDeckPocket && e.id === MOUNTAIN_EDGE && bHit.lat < 0) continue;
      const p = e.poseAt(bHit.s, _byPose);
      const surfY = p.y + bHit.lat * p.bank;
      if (Math.abs(car.y - surfY) < SURFACE_TOL) {
        const { hwL, hwR } = e.halfWidths(bHit.s, _byHw);
        const { shL, shR } = e.sharedSides(bHit.s, _bySh);
        const sgn = bHit.lat >= 0 ? 1 : -1;
        const hwSide = sgn > 0 ? hwL : hwR;
        const lim = hwSide + 0.06 - halfW;
        const over = Math.abs(bHit.lat) - lim;
        if (!(sgn > 0 ? shL : shR) && over > 0 && over < WALL_REACH) {
          const pen = Math.min(over, CLAMP_STEP);
          const nx = sgn * p.nx, nz = sgn * p.nz; // outward wall normal
          car.x -= nx * pen;
          car.z -= nz * pen;
          const vn = car.wvx * nx + car.wvz * nz;
          if (vn > 0) {
            bounceOff(car, -nx, -nz, vn);
            if (vn > normalImpact) normalImpact = vn;
          }
          hit = true;
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
    for (const bi of col.nearbyAabbs(px, pz)) {
      const im = collideAABB(car, px, pz, halfW + 0.05, col.aabbs[bi]);
      if (im === NO_CONTACT) continue;
      hit = true;
      if (im > normalImpact) normalImpact = im;
    }
    for (const oi of col.nearbyObbs(px, pz)) {
      const im = collideObb(car, px, pz, halfW + 0.1, col.obbs[oi]);
      if (im === NO_CONTACT) continue;
      hit = true;
      if (im > normalImpact) normalImpact = im;
    }
  }

  // NPC vehicles
  for (const n of npcs) {
    if (!n.active) continue;
    // NOT SURFACE_TOL: this is car-vs-car vertical overlap, not "same road"
    if (Math.abs(car.y - n.y) > 2.6) continue;
    const ddx = car.x - n.x, ddz = car.z - n.z;
    const reach = n.L / 2 + halfL + 1.6;
    if (ddx * ddx + ddz * ddz > reach * reach) continue;
    /* n.cw, NOT n.W / 2: the NPC bakes are fitted so their whole bounding box
       — door mirrors included — lands on W, so W is between 6 and 27 cm per
       side wider than the flank a player sees and judges a gap against. cw is
       the measured bodywork. Length keeps L / 2, which measured correct.
       See TYPE_DIM in traffic.ts and test/hitbox-measure.mjs. */
    const res = obb2(
      car.x, car.z, fx, fz, halfW, halfL,
      n.x, n.z, Math.sin(n.hVis), Math.cos(n.hVis), n.cw ?? n.W / 2, n.L / 2
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
        if (-vn > normalImpact) normalImpact = -vn;
      }
      hit = true;
    }
  }

  if (hit) {
    /* CONTACT DRAG. Both of these were flat per-frame constants (0.965 on the
       whole velocity, 0.65 on the yaw rate) applied to any contact however
       gentle, which is what glued a car to a barrier: a second of leaning on
       a wall at 60 fps left 12% of the car's speed and 0% of its ability to
       steer off. They are now functions of how hard the contact actually was
       (WALL.scrub / WALL.yawKeep, physics.ts) and raised to the frame's share
       of 1/60 s, so a 120 Hz display no longer scrubs twice as hard as a
       60 Hz one. A resting contact costs 0.4%/frame; a real impact still
       costs the same 6%/frame and still damps yaw hard, which is what keeps a
       barrier strike at 150 km/h from becoming an unrecoverable spin. */
    const fr = Math.max(dt, 1e-4) * 60;
    const s = Math.pow(WALL.scrub(normalImpact), fr);
    car.wvx *= s;
    car.wvz *= s;
    car.u = car.wvx * fx + car.wvz * fz;
    car.v = car.wvx * rx + car.wvz * rz;
    car.r *= Math.pow(WALL.yawKeep(normalImpact), fr);
    const dvx = car.wvx - preVx, dvz = car.wvz - preVz;
    wallImpact = Math.hypot(dvx, dvz);
  }
  return { hit, npcHits, wallImpact, normalImpact };
}
