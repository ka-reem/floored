import * as THREE from "three";
import { clamp, lerp, rand, pick, TAU, angDiff, mulberry32 } from "./util";
import { carShellGeos, roundedBoxGeo } from "./carshape";
import type { ShellParams } from "./carspecs";
import { HX, HZ, DECKY, LANE_OFF, LANE_LAT } from "./world/const";
import { signalPhase, type WorldData } from "./world/data";
import type { REdge, EdgePose } from "./world/roadnet";
import type { CarState } from "./physics";
import type { NpcHit } from "./collide";

/* Traffic v3.
   Town NPCs follow the curved road graph (IDM car-following, signals, turn
   blinkers, curvature-aware speeds). Expressway NPCs keep the v2 IDM+MOBIL
   lane-change model with U-turn loop arcs. The fleet is a recycled pool:
   vehicles only exist near the player, spawn out of view, and despawn far
   away. Player impacts convert victims into free-sliding wrecks that blink
   hazards, smoke, block traffic, then fade out. */

const NPC_SHELLS: Record<string, ShellParams> = {
  sedan: { L: 4.3, W: 1.7, ride: 0.34, nose: 0.56, tail: 0.6, belt: 0.88, roof: 1.33, hood: 1.05, trunk: 1.02, rakeF: 0.74, rakeR: 0.6, archR: 0.4, wzF: 1.35, wzR: 1.35, wheelR: 0.3, wheelWidth: 0.22 },
  kei: { L: 3.2, W: 1.44, ride: 0.32, nose: 0.62, tail: 0.64, belt: 0.97, roof: 1.5, hood: 0.55, trunk: 0.42, rakeF: 0.5, rakeR: 0.34, archR: 0.36, wzF: 1.0, wzR: 1.0, wheelR: 0.27, wheelWidth: 0.18 },
  van: { L: 4.6, W: 1.74, ride: 0.33, nose: 0.78, tail: 0.96, belt: 1.06, roof: 1.82, hood: 0.62, trunk: 0.2, rakeF: 0.55, rakeR: 0.16, archR: 0.4, wzF: 1.5, wzR: 1.5, wheelR: 0.31, wheelWidth: 0.22 },
  bus: { L: 9.4, W: 2.26, ride: 0.36, nose: 0.5, tail: 0.5, belt: 1.18, roof: 2.72, hood: 0.3, trunk: 0.25, rakeF: 0.32, rakeR: 0.18, archR: 0.5, wzF: 3.4, wzR: 3.4, wheelR: 0.44, wheelWidth: 0.3 },
  cab: { L: 2.3, W: 2.0, ride: 0.4, nose: 0.8, tail: 1.1, belt: 1.35, roof: 2.4, hood: 0.42, trunk: 0.08, rakeF: 0.4, rakeR: 0.1, archR: 0.46, wzF: 0.5, wzR: -99, wheelR: 0.42, wheelWidth: 0.3 },
};

const TYPE_DIM: Record<string, { L: number; W: number; wr: number; wz: number; mass: number }> = {
  sedan: { L: 4.3, W: 1.8, wr: 0.3, wz: 1.35, mass: 1350 },
  taxi: { L: 4.3, W: 1.8, wr: 0.3, wz: 1.35, mass: 1350 },
  police: { L: 4.3, W: 1.8, wr: 0.3, wz: 1.35, mass: 1400 },
  kei: { L: 3.2, W: 1.54, wr: 0.27, wz: 1.0, mass: 820 },
  van: { L: 4.6, W: 1.84, wr: 0.31, wz: 1.5, mass: 1700 },
  truck: { L: 6.3, W: 2.1, wr: 0.42, wz: 2.3, mass: 4200 },
  bus: { L: 9.4, W: 2.36, wr: 0.44, wz: 3.4, mass: 9000 },
  bike: { L: 2.1, W: 0.8, wr: 0.3, wz: 0.72, mass: 240 },
};

const NPC_COLORS = [0xd8dde6, 0x14161c, 0x9298a4, 0x5a1f26, 0x1d2f52, 0x27402c, 0x6b6154, 0xc4c9d4, 0x2a2c34, 0x83202c];
const GLASS_C = 0x0a0e18, TRIM_C = 0x101218;

function mergeGeos(parts: { g: THREE.BufferGeometry; c: number }[]) {
  let vc = 0, ic = 0;
  for (const p of parts) {
    const n = p.g.attributes.position.count;
    vc += n;
    ic += p.g.index ? p.g.index.count : n;
  }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), col = new Float32Array(vc * 3);
  const idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  const C = new THREE.Color();
  for (const p of parts) {
    const n = p.g.attributes.position.count;
    pos.set(p.g.attributes.position.array as Float32Array, vo * 3);
    nor.set(p.g.attributes.normal.array as Float32Array, vo * 3);
    C.setHex(p.c);
    for (let i = 0; i < n; i++) {
      col[(vo + i) * 3] = C.r;
      col[(vo + i) * 3 + 1] = C.g;
      col[(vo + i) * 3 + 2] = C.b;
    }
    if (p.g.index) {
      const I = p.g.index.array;
      for (let i = 0; i < I.length; i++) idx[io++] = (I as any)[i] + vo;
    } else for (let i = 0; i < n; i++) idx[io++] = vo + i;
    vo += n;
    p.g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

function npcBodyGeo(type: string, cHex: number) {
  const parts: { g: THREE.BufferGeometry; c: number }[] = [];
  const rb = (w: number, h: number, d: number, x: number, y: number, z: number, c: number, r?: number) => {
    const g = roundedBoxGeo(w, h, d, r || 0.1, 2);
    g.translate(x, y, z);
    parts.push({ g, c });
  };
  if (type === "bike") {
    rb(0.34, 0.5, 1.9, 0, 0.62, 0, cHex, 0.12);
    rb(0.42, 0.46, 0.4, 0, 1.06, -0.18, 0x14161c, 0.13);
    rb(0.3, 0.27, 0.29, 0, 1.4, -0.12, 0x0d0f14, 0.11);
    rb(0.52, 0.07, 0.09, 0, 0.96, 0.55, TRIM_C, 0.03);
    return mergeGeos(parts);
  }
  if (type === "truck") {
    const S2 = carShellGeos(NPC_SHELLS.cab, false);
    for (const k of ["hull", "glass", "roof"] as const) {
      S2[k].translate(0, 0, 2.0);
      parts.push({ g: S2[k], c: k === "glass" ? GLASS_C : cHex });
    }
    rb(2.15, 2.2, 4.2, 0, 1.42, -1.05, 0xd6dae2, 0.07);
    rb(2.1, 0.3, 0.5, 0, 0.34, 3.05, TRIM_C, 0.06);
    return mergeGeos(parts);
  }
  const P = NPC_SHELLS[type] || NPC_SHELLS.sedan;
  const S2 = carShellGeos(P, false);
  const roofC = type === "taxi" ? 0xe8b830 : type === "police" ? 0x111318 : cHex;
  const hullC = type === "taxi" ? 0xe8b830 : type === "police" ? 0xeef0f4 : cHex;
  parts.push({ g: S2.hull, c: hullC });
  parts.push({ g: S2.glass, c: GLASS_C });
  parts.push({ g: S2.roof, c: roofC });
  rb(P.W * 0.98, 0.16, P.L * 0.985, 0, P.ride - 0.02, 0, TRIM_C, 0.05);
  rb(P.W * 0.92, 0.14, 0.3, 0, P.nose * 0.72, P.L / 2 - 0.06, TRIM_C, 0.05);
  rb(P.W * 0.92, 0.15, 0.28, 0, P.nose * 0.76, -P.L / 2 + 0.05, TRIM_C, 0.05);
  if (type === "police") rb(0.92, 0.12, 0.34, 0, P.roof + 0.1, -0.15, 0x15171d, 0.04);
  return mergeGeos(parts);
}

export interface Npc {
  id: number;
  active: boolean;
  type: string;
  g: THREE.Group;
  body: THREE.Mesh;
  L: number; W: number; wr: number; wz: number; mass: number;
  wheelOffs: [number, number][];
  hw: boolean;
  edge: REdge | null;
  eDir: number;
  segHint: { i: number };
  nextEdgeId: number;
  dir: number; laneK: number; offCur: number; offT: number;
  arc: { end: number; th: number; stall?: number } | null;
  s: number;
  v: number; v0: number; aggr: number;
  brake: boolean; blink: number; blinkT: number; turnCd: number; nudgeT: number;
  hVis: number; x: number; y: number; z: number; spin: number; wob: number;
  wreck: { vx: number; vz: number; vr: number; age: number } | null;
  fade: number;
}

type Cloud = { arr: Float32Array; geo: THREE.BufferGeometry; pts: THREE.Points };

export class Traffic {
  npcs: Npc[] = [];
  private scene: THREE.Scene;
  private world: WorldData;
  private npcMat: THREE.MeshStandardMaterial;
  private wheelInst: THREE.InstancedMesh;
  private clouds: Record<string, Cloud> = {};
  private pose: EdgePose = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
  private pose2: EdgePose = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
  private rng = mulberry32(0xbeef);
  private _wd = new THREE.Object3D();
  readonly N: number;

  constructor(scene: THREE.Scene, world: WorldData, envMap: THREE.CubeTexture, glowTex: THREE.Texture, N = 120) {
    this.scene = scene;
    this.world = world;
    this.N = N;
    this.npcMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.42, metalness: 0.62,
      envMap, envMapIntensity: 0.9, side: THREE.DoubleSide,
    });
    this.wheelInst = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 0.24, 10),
      new THREE.MeshStandardMaterial({ color: 0x0a0a0e, roughness: 0.9 }),
      N * 4
    );
    this.wheelInst.frustumCulled = false;
    scene.add(this.wheelInst);

    const mkCloud = (color: number, size: number): Cloud => {
      const arr = new Float32Array(N * 2 * 3);
      arr.fill(-999);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const pts = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          size, map: glowTex, color, transparent: true, opacity: 0.95,
          sizeAttenuation: true, depthWrite: false, blending: THREE.AdditiveBlending,
        })
      );
      pts.frustumCulled = false;
      scene.add(pts);
      return { arr, geo, pts };
    };
    this.clouds = {
      head: mkCloud(0xcfe0ff, 1.05), tail: mkCloud(0xff3344, 0.85),
      brake: mkCloud(0xff2233, 1.5), sig: mkCloud(0xffa028, 1.05),
      roof: mkCloud(0xffb040, 0.95), polR: mkCloud(0xff3040, 1.5),
      polB: mkCloud(0x3d74ff, 1.5),
    };

    // pre-build the pool: ~45% highway-flavoured, rest town
    const hwyTypes = ["sedan", "sedan", "sedan", "kei", "van", "taxi", "truck", "truck", "bus", "bike", "bike"];
    const townTypes = ["sedan", "sedan", "kei", "kei", "taxi", "taxi", "van", "bike"];
    for (let i = 0; i < N; i++) {
      const isHwyFlavour = i < N * 0.45;
      let type = pick(isHwyFlavour ? hwyTypes : townTypes);
      if (i === 3 || i === Math.floor(N * 0.6)) type = "police";
      const d = TYPE_DIM[type];
      const g = new THREE.Group();
      const body = new THREE.Mesh(npcBodyGeo(type, pick(NPC_COLORS)), this.npcMat);
      body.castShadow = true;
      g.add(body);
      g.visible = false;
      scene.add(g);
      const hw2 = d.W / 2 - 0.1;
      this.npcs.push({
        id: i, active: false, type, g, body,
        L: d.L, W: d.W, wr: d.wr, wz: d.wz, mass: d.mass,
        wheelOffs:
          type === "bike"
            ? [[d.wz, 0], [-d.wz, 0]]
            : [[d.wz, hw2], [d.wz, -hw2], [-d.wz, hw2], [-d.wz, -hw2]],
        hw: isHwyFlavour, edge: null, eDir: 1, segHint: { i: 0 }, nextEdgeId: -1,
        dir: 1, laneK: 1, offCur: 0, offT: 0, arc: null, s: 0,
        v: 0, v0: 10, aggr: rand(0.85, 1.25), brake: false,
        blink: 0, blinkT: 0, turnCd: rand(2, 8), nudgeT: 0,
        hVis: 0, x: 0, y: -999, z: 0, spin: 0, wob: 0,
        wreck: null, fade: 1,
      });
    }
  }

  /* ---------------- spawning ---------------- */

  private deactivate(n: Npc) {
    n.active = false;
    n.g.visible = false;
    n.y = -999;
    if (n.wreck) {
      n.wreck = null;
      if (n.body.material !== this.npcMat) {
        (n.body.material as THREE.Material).dispose();
        n.body.material = this.npcMat;
      }
    }
    n.fade = 1;
  }

  private trySpawnTown(n: Npc, player: CarState, camFx: number, camFz: number): boolean {
    const net = this.world.net;
    for (let attempt = 0; attempt < 12; attempt++) {
      const e = net.edges[Math.floor(this.rng() * net.edges.length)];
      if (e.len < 30) continue;
      const s = rand(8, e.len - 8);
      const i = Math.min(e.ss.length - 2, Math.floor((s / e.len) * (e.ss.length - 1)));
      const px = e.pts[i * 3], pz = e.pts[i * 3 + 2];
      const dx = px - player.x, dz = pz - player.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 130 || dist > 430) continue;
      // don't pop into view: reject spawns inside the camera's forward cone
      if (dist < 280 && (dx * camFx + dz * camFz) / dist > 0.6) continue;
      // spacing on the edge
      let blocked = false;
      for (const m of this.npcs) {
        if (!m.active || m.edge !== e) continue;
        const ms = m.eDir > 0 ? m.s : e.len - m.s;
        if (Math.abs(ms - s) < 16) blocked = true;
      }
      if (blocked) continue;
      n.active = true;
      n.hw = false;
      n.edge = e;
      n.eDir = this.rng() < 0.5 ? 1 : -1;
      n.s = n.eDir > 0 ? s : e.len - s;
      n.segHint.i = 0;
      n.nextEdgeId = -1;
      n.arc = null;
      n.wreck = null;
      n.fade = 1;
      n.blink = 0;
      n.v0 = rand(7.5, 12.5) * (n.type === "bike" ? 1.15 : 1);
      n.v = n.v0 * rand(0.6, 0.9);
      n.turnCd = rand(2, 6);
      this.placeTown(n);
      n.hVis = Math.atan2(this.pose.tx, this.pose.tz);
      n.g.visible = true;
      return true;
    }
    return false;
  }

  private trySpawnHwy(n: Npc, player: CarState, playerUp: boolean): boolean {
    for (let attempt = 0; attempt < 10; attempt++) {
      const dir = this.rng() < 0.5 ? 1 : -1;
      let z: number;
      if (playerUp) {
        const behind = this.rng() < 0.5 ? -1 : 1;
        z = player.z + behind * rand(130, 520);
      } else z = rand(-HZ + 40, HZ - 40);
      if (Math.abs(z) > HZ - 30) continue;
      const laneK = n.type === "truck" || n.type === "bus" ? 1 + Math.floor(this.rng() * 2) : Math.floor(this.rng() * 3);
      const off = dir * LANE_OFF[laneK];
      let blocked = false;
      for (const m of this.npcs) {
        if (!m.active || !m.hw || m.dir !== dir) continue;
        if (Math.abs(m.offCur - off) > 1.7) continue;
        if (Math.abs(m.s - z) < 18) blocked = true;
      }
      if (blocked) continue;
      n.active = true;
      n.hw = true;
      n.edge = null;
      n.dir = dir;
      n.laneK = laneK;
      n.offCur = n.offT = off;
      n.arc = null;
      n.s = z;
      n.wreck = null;
      n.fade = 1;
      n.v0 = rand(21, 33) + (1 - laneK) * 2.2;
      if (n.type === "truck" || n.type === "bus") n.v0 = Math.min(n.v0, 24);
      if (n.type === "bike") n.v0 += 3;
      n.v = n.v0 * rand(0.7, 0.95);
      n.turnCd = rand(2, 8);
      n.blink = 0;
      this.placeHwy(n);
      n.hVis = n.dir > 0 ? 0 : Math.PI;
      n.g.visible = true;
      return true;
    }
    return false;
  }

  /* ---------------- pose helpers ---------------- */

  private sampleTravel(n: Npc, sT: number, out: EdgePose) {
    const e = n.edge!;
    this.world.net.sampleEdge(e, n.eDir > 0 ? sT : e.len - sT, out, n.segHint);
    if (n.eDir < 0) {
      out.tx *= -1;
      out.tz *= -1;
    }
    return out;
  }

  private placeTown(n: Npc) {
    const p = this.sampleTravel(n, n.s, this.pose); // n.s is in travel space
    const rx = p.tz, rz = -p.tx;
    n.x = p.x + rx * LANE_LAT + (n.wob || 0) * rx;
    n.z = p.z + rz * LANE_LAT + (n.wob || 0) * rz;
    n.y = p.y;
  }

  private placeHwy(n: Npc) {
    if (n.arc) {
      const off = Math.max(2.4, Math.abs(n.offCur));
      n.x = HX + Math.cos(n.arc.th) * off;
      n.z = n.arc.end * HZ + Math.sin(n.arc.th) * off;
      n.y = DECKY;
    } else {
      n.x = HX + n.offCur + (n.wob || 0);
      n.z = n.s;
      n.y = DECKY;
    }
  }

  /* ---------------- impact from player ---------------- */

  applyImpact(hit: NpcHit) {
    const n: Npc = hit.npc;
    if (!n.active) return;
    if (hit.relSpeed > 2.6 && !n.wreck) {
      // clone material so this wreck can fade independently
      const mat = this.npcMat.clone();
      mat.transparent = true;
      n.body.material = mat;
      // carry the victim's travel velocity + the impact impulse
      n.wreck = {
        vx: Math.sin(n.hVis) * n.v + hit.nx * hit.relSpeed * 0.72,
        vz: Math.cos(n.hVis) * n.v + hit.nz * hit.relSpeed * 0.72,
        vr: (this.rng() < 0.5 ? -1 : 1) * clamp(hit.relSpeed * 0.28, 0.6, 3.4),
        age: 0,
      };
      n.brake = true;
      n.v = 0;
    } else if (n.wreck) {
      n.wreck.vx += hit.nx * hit.relSpeed * 0.6;
      n.wreck.vz += hit.nz * hit.relSpeed * 0.6;
      n.wreck.age = Math.min(n.wreck.age, 6);
    } else {
      // light tap: shove + brake
      n.v = Math.max(0, n.v - hit.relSpeed * 0.8);
      n.brake = true;
    }
  }

  /** Positions of active wrecks (for smoke emitters). */
  activeWrecks(): Npc[] {
    return this.npcs.filter((n) => n.active && n.wreck);
  }

  /** Debug/test helper: park an NPC ~24 m ahead of the player, in lane. */
  spawnObstacleAhead(car: CarState): boolean {
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    const tx = car.x + fx * 24, tz = car.z + fz * 24;
    const n = this.npcs.find((m) => !m.active && m.type !== "bike");
    if (!n) return false;
    n.active = true;
    n.wreck = null;
    n.fade = 1;
    n.v = 0;
    n.v0 = 0.01;
    n.blink = 0;
    n.turnCd = 99;
    if (car.y > 4) {
      n.hw = true;
      n.dir = fz >= 0 ? 1 : -1;
      const off = car.x - HX;
      let bestK = 0, bd = 1e9;
      LANE_OFF.forEach((o, k) => {
        const d = Math.abs(Math.abs(off) - o);
        if (d < bd) {
          bd = d;
          bestK = k;
        }
      });
      n.laneK = bestK;
      n.offCur = n.offT = (off >= 0 ? 1 : -1) * LANE_OFF[bestK];
      n.arc = null;
      n.s = tz;
      this.placeHwy(n);
      n.hVis = n.dir > 0 ? 0 : Math.PI;
    } else {
      const near = this.world.net.nearest(tx, tz);
      if (!near) {
        n.active = false;
        return false;
      }
      n.hw = false;
      n.edge = near.edge;
      n.segHint.i = 0;
      n.nextEdgeId = -1;
      this.world.net.sampleEdge(near.edge, near.s, this.pose);
      const hr = Math.atan2(this.pose.tx, this.pose.tz);
      const same = Math.cos(hr - car.h) >= 0;
      n.eDir = same ? 1 : -1;
      n.s = same ? near.s : near.edge.len - near.s;
      this.placeTown(n); // pose now holds the travel-direction tangent
      n.hVis = Math.atan2(this.pose.tx, this.pose.tz);
    }
    n.g.visible = true;
    n.g.position.set(n.x, n.y, n.z);
    n.g.rotation.y = n.hVis;
    return true;
  }

  /* ---------------- per-frame update ---------------- */

  update(
    dt: number, now: number, player: CarState,
    camFx: number, camFz: number, density: number, hornHeld: boolean, night = true
  ) {
    const playerUp = player.y > 4;
    const cap = Math.round(this.N * clamp(density, 0.15, 1));
    const hwyTarget = Math.round(cap * (playerUp ? 0.6 : 0.24));
    const townTarget = Math.round(cap * (playerUp ? 0.16 : 0.55));

    /* recycle far NPCs + census */
    let hwyCount = 0, townCount = 0;
    const idleHwy: Npc[] = [], idleTown: Npc[] = [];
    for (const n of this.npcs) {
      if (n.active) {
        if (n.hw) {
          const far = playerUp ? Math.abs(n.s - player.z) > 620 : false;
          if (far && !n.arc && !n.wreck) this.deactivate(n);
          else hwyCount++;
        } else {
          const far = Math.hypot(n.x - player.x, n.z - player.z) > 520;
          if (far) this.deactivate(n);
          else townCount++;
        }
      }
      if (!n.active) (n.hw ? idleHwy : idleTown).push(n);
    }
    // over-target trims (density slider / zone change): drop the farthest
    if (hwyCount > hwyTarget + 6) {
      let worst: Npc | null = null, wd = -1;
      for (const n of this.npcs)
        if (n.active && n.hw && !n.wreck && !n.arc) {
          const d = Math.abs(n.s - player.z);
          if (d > wd) { wd = d; worst = n; }
        }
      if (worst && wd > 200) this.deactivate(worst);
    }
    if (townCount > townTarget + 6) {
      let worst: Npc | null = null, wd = -1;
      for (const n of this.npcs)
        if (n.active && !n.hw && !n.wreck) {
          const d = Math.hypot(n.x - player.x, n.z - player.z);
          if (d > wd) { wd = d; worst = n; }
        }
      if (worst && wd > 240) this.deactivate(worst);
    }
    /* spawn toward targets (a few per frame max); pools borrow from each
       other — any vehicle can serve the deck, but no trucks/buses in town */
    let spawnBudget = 3;
    while (spawnBudget > 0 && hwyCount < hwyTarget && (idleHwy.length || idleTown.length)) {
      const n = idleHwy.length ? idleHwy.pop()! : idleTown.pop()!;
      if (this.trySpawnHwy(n, player, playerUp)) hwyCount++;
      spawnBudget--;
    }
    while (spawnBudget > 0 && townCount < townTarget && (idleTown.length || idleHwy.length)) {
      let n = idleTown.length ? idleTown.pop() : undefined;
      if (!n) {
        const ix = idleHwy.findIndex((m) => m.type !== "truck" && m.type !== "bus");
        if (ix < 0) break;
        n = idleHwy.splice(ix, 1)[0];
      }
      if (this.trySpawnTown(n, player, camFx, camFz)) townCount++;
      spawnBudget--;
    }

    const phase = signalPhase(now);
    const cfx = Math.sin(player.h), cfz = Math.cos(player.h);
    const playerSpeed = Math.abs(player.u);

    /* main per-NPC update */
    for (const n of this.npcs) {
      if (!n.active) continue;

      /* wreck free-body */
      if (n.wreck) {
        const w = n.wreck;
        w.age += dt;
        n.x += w.vx * dt;
        n.z += w.vz * dt;
        n.hVis += w.vr * dt;
        const damp = Math.exp(-1.5 * dt);
        w.vx *= damp;
        w.vz *= damp;
        w.vr *= Math.exp(-1.9 * dt);
        n.y = this.world.terrain.heightAt(n.x, n.z, n.y);
        // crude wall response
        for (const bi of this.world.colliders.nearbyAabbs(n.x, n.z)) {
          const b = this.world.colliders.aabbs[bi];
          if (n.y + 1.4 < b.y0 || n.y > b.y1) continue;
          const cx = Math.max(b.x0, Math.min(n.x, b.x1)), cz = Math.max(b.z0, Math.min(n.z, b.z1));
          const ddx = n.x - cx, ddz = n.z - cz, d2 = ddx * ddx + ddz * ddz;
          const rr = n.W / 2 + 0.3;
          if (d2 < rr * rr && d2 > 1e-9) {
            const d = Math.sqrt(d2);
            n.x += (ddx / d) * (rr - d);
            n.z += (ddz / d) * (rr - d);
            const vn = (w.vx * ddx + w.vz * ddz) / d;
            if (vn < 0) {
              w.vx -= (ddx / d) * vn * 1.4;
              w.vz -= (ddz / d) * vn * 1.4;
              w.vx *= 0.6;
              w.vz *= 0.6;
            }
          }
        }
        const speed2 = w.vx * w.vx + w.vz * w.vz;
        if (w.age > 9 || (w.age > 4 && speed2 < 0.05 && Math.hypot(n.x - player.x, n.z - player.z) > 60)) {
          n.fade -= dt * 1.4;
          (n.body.material as THREE.Material as any).opacity = Math.max(0, n.fade);
          if (n.fade <= 0) {
            this.deactivate(n);
            continue;
          }
        }
        n.g.position.set(n.x, n.y, n.z);
        n.g.rotation.y = n.hVis;
        n.brake = false;
        continue;
      }

      let v0 = n.v0;
      /* horn nudge */
      if (hornHeld && Math.abs(player.y - n.y) < 3) {
        const dx = player.x - n.x, dz = player.z - n.z;
        const aC = -dx * cfx - dz * cfz, sC = Math.abs(-dx * cfz + dz * cfx);
        if (aC > 0 && aC < 16 && sC < 2.6) {
          n.nudgeT = 2.5;
          n.turnCd = Math.min(n.turnCd, 0.4);
        }
      }
      if (n.nudgeT > 0) {
        n.nudgeT -= dt;
        v0 *= 1.15;
      }

      /* leader: nearest same-path vehicle ahead */
      let lead: { ds: number; v: number } | null = null;
      const fx = Math.sin(n.hVis), fz = Math.cos(n.hVis);
      for (const m of this.npcs) {
        if (m === n || !m.active) continue;
        if (Math.abs(m.y - n.y) > 3) continue;
        const dx = m.x - n.x, dz = m.z - n.z;
        const ahead = dx * fx + dz * fz;
        if (ahead <= 0 || ahead > 70) continue;
        const side = Math.abs(dx * fz - dz * fx);
        if (side > (m.wreck ? 2.6 : 1.9)) continue;
        if (n.hw && m.hw && !m.wreck && m.dir !== n.dir) continue;
        const ds = ahead - (m.L + n.L) / 2;
        const mv = m.wreck ? 0 : m.v * clamp(fx * Math.sin(m.hVis) + fz * Math.cos(m.hVis), 0, 1);
        if (!lead || ds < lead.ds) lead = { ds: Math.max(ds, 0.1), v: mv };
      }
      /* player as obstacle */
      let panic = false;
      if (Math.abs(player.y - n.y) < 3) {
        const dx = player.x - n.x, dz = player.z - n.z;
        const ahead = dx * fx + dz * fz;
        const side = Math.abs(dx * fz - dz * fx);
        if (ahead > 0 && ahead < 60 && side < 2.3) {
          const ds = Math.max(ahead - n.L / 2 - 2.2, 0.1);
          const pv = playerSpeed * clamp(fx * cfx * Math.sign(player.u) + fz * cfz * Math.sign(player.u), 0, 1);
          if (!lead || ds < lead.ds) lead = { ds, v: pv };
        }
        if (ahead > 0 && ahead < 9 && side < 3) panic = true;
      }

      if (n.hw) this.updateHwy(n, dt, v0, lead, panic);
      else this.updateTown(n, dt, v0, lead, phase, panic);

      /* smooth heading + place */
      if (n.hw) this.placeHwy(n);
      else this.placeTown(n);
      let targetH: number;
      if (n.hw) {
        targetH = n.arc ? -n.arc.th : n.dir > 0 ? 0 : Math.PI;
      } else {
        targetH = Math.atan2(this.pose.tx, this.pose.tz);
      }
      let dh = angDiff(targetH, n.hVis);
      n.hVis += clamp(dh, -6 * dt, 6 * dt);
      n.spin += (n.v / n.wr) * dt;
      n.wob = n.type === "bike" ? Math.sin(now * 0.9 + n.id * 2.1) * 0.28 : 0;
      n.g.position.set(n.x, n.y, n.z);
      n.g.rotation.y = n.hVis;
    }

    /* overlap resolution between NPCs sharing a lane (cheap, one pass) */
    for (let a = 0; a < this.npcs.length; a++) {
      const A = this.npcs[a];
      if (!A.active || A.wreck || A.arc) continue;
      for (let b = a + 1; b < this.npcs.length; b++) {
        const B = this.npcs[b];
        if (!B.active || B.wreck || B.arc) continue;
        if (A.hw !== B.hw) continue;
        if (Math.abs(A.y - B.y) > 3) continue;
        const dx = B.x - A.x, dz = B.z - A.z;
        const need = (A.L + B.L) / 2 + 0.6;
        if (Math.abs(dx) > need || Math.abs(dz) > need) continue;
        const fx = Math.sin(A.hVis), fz = Math.cos(A.hVis);
        const along = dx * fx + dz * fz;
        const side = Math.abs(dx * fz - dz * fx);
        if (side > 1.7 || Math.abs(along) > need) continue;
        const rear = along > 0 ? A : B, front = along > 0 ? B : A;
        rear.v = Math.min(rear.v, front.v * 0.9);
        rear.brake = true;
        if (rear.hw && !rear.arc) rear.s -= rear.dir * (need - Math.abs(along)) * 0.5;
        else if (!rear.hw) rear.s = Math.max(0, rear.s - (need - Math.abs(along)) * 0.5);
      }
    }

    this.updateWheels();
    this.updateLights(now, night);
  }

  /* town graph driving */
  private updateTown(
    n: Npc, dt: number, v0: number,
    lead: { ds: number; v: number } | null, phase: number, panic = false
  ) {
    const e = n.edge!;
    const net = this.world.net;
    const remain = e.len - n.s;

    /* choose the next edge ahead of time (for blinkers) */
    if (n.nextEdgeId < 0 && remain < 34) {
      const endNode = n.eDir > 0 ? e.b : e.a;
      const opts = net.nodes[endNode].edges.filter((id) => id !== e.id);
      n.nextEdgeId = opts.length ? opts[Math.floor(this.rng() * opts.length)] : e.id;
      // blinker by turn direction
      this.sampleTravel(n, Math.max(0, e.len - 2), this.pose);
      const h0 = Math.atan2(this.pose.tx, this.pose.tz);
      const ne = net.edges[n.nextEdgeId];
      const fromA = ne.a === endNode;
      // tangent of the new edge sampled 4 m in, in travel direction
      const p2 = this.pose2;
      net.sampleEdge(ne, fromA ? 4 : ne.len - 4, p2, { i: 0 });
      let t2x = p2.tx, t2z = p2.tz;
      if (!fromA) {
        t2x *= -1;
        t2z *= -1;
      }
      const turn = angDiff(Math.atan2(t2x, t2z), h0);
      n.blink = turn > 0.45 ? 1 : turn < -0.45 ? -1 : 0;
    }

    /* speed limits: curvature + approaching intersection + signals */
    this.sampleTravel(n, n.s, this.pose);
    const hHere = Math.atan2(this.pose.tx, this.pose.tz);
    this.sampleTravel(n, Math.min(e.len, n.s + 7), this.pose2);
    const hNext = Math.atan2(this.pose2.tx, this.pose2.tz);
    const curv = Math.abs(angDiff(hNext, hHere)) / 7;
    if (curv > 0.004) v0 = Math.min(v0, Math.sqrt(2.9 / curv) * 0.9);
    if (remain < 16 || n.s < 8) v0 = Math.min(v0, 6.5);

    let stop: { ds: number; v: number } | null = null;
    const endNode = net.nodes[n.eDir > 0 ? e.b : e.a];
    // legacy grace: once past the stop line, clear the intersection instead
    if (endNode.signal && remain < 46 && remain > 5.5) {
      // arm classification by current heading
      const ew = Math.abs(Math.sin(hHere)) > Math.abs(Math.cos(hHere));
      const red = ew ? phase <= 2 || phase > 4.5 : phase >= 2 && phase <= 4;
      if (red) stop = { ds: Math.max(remain - 7.5, 0.3), v: 0 };
    }
    if (stop && (!lead || stop.ds < lead.ds)) lead = stop;

    /* IDM */
    const aMax = 1.7 * n.aggr, bCom = 2.4, T = 1.25 / n.aggr, s0 = 2.4;
    let acc: number;
    if (lead) {
      const dv = n.v - lead.v;
      const sStar = s0 + n.v * T + (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
      acc = aMax * (1 - Math.pow(n.v / v0, 4) - Math.pow(sStar / Math.max(lead.ds, 0.55), 2));
    } else acc = aMax * (1 - Math.pow(n.v / v0, 4));
    if (panic) acc = Math.min(acc, -6.5);
    acc = clamp(acc, -8.5, 3.2);
    n.brake = acc < -1.2;
    n.v = Math.max(0, n.v + acc * dt);
    n.s += n.v * dt;

    /* edge hop */
    if (n.s >= e.len - 0.2) {
      const endId = n.eDir > 0 ? e.b : e.a;
      const nid = n.nextEdgeId >= 0 ? n.nextEdgeId : e.id;
      const ne = net.edges[nid];
      n.edge = ne;
      n.eDir = ne.a === endId ? 1 : -1;
      n.s = Math.max(0, n.s - e.len);
      n.segHint.i = 0;
      n.nextEdgeId = -1;
      n.blink = 0;
      n.turnCd = rand(3, 8);
    }
  }

  /* expressway driving (v2 port) */
  private updateHwy(
    n: Npc, dt: number, v0: number,
    lead: { ds: number; v: number } | null, panic = false
  ) {
    if (n.arc) v0 = Math.min(v0, 2.6 + Math.abs(n.offCur) * 0.55);
    else {
      const dEnd = n.dir > 0 ? HZ - n.s : n.s + HZ;
      if (dEnd < 120) v0 = Math.min(v0, 5.5 + Math.max(0, dEnd - 16) * 0.17);
    }
    const aMax = 1.6 * n.aggr, bCom = 2.3, T = 1.3 / n.aggr, s0 = 2.4;
    let acc: number;
    if (lead) {
      const dv = n.v - lead.v;
      const sStar = s0 + n.v * T + (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
      acc = aMax * (1 - Math.pow(n.v / v0, 4) - Math.pow(sStar / Math.max(lead.ds, 0.55), 2));
    } else acc = aMax * (1 - Math.pow(n.v / v0, 4));
    if (panic) acc = Math.min(acc, -6.5);
    acc = clamp(acc, -8.5, 3.2);
    n.brake = acc < -1.2;
    n.v = Math.max(0, n.v + acc * dt);
    if (!n.arc) n.s += n.dir * n.v * dt;

    n.turnCd -= dt;
    /* lane change when stuck behind slower traffic */
    if (
      n.blink === 0 && !n.arc &&
      (n.dir > 0 ? HZ - n.s : n.s + HZ) > 130 &&
      n.turnCd <= 0 && lead && lead.ds < 30 && lead.v < n.v0 * 0.85
    ) {
      for (const dk of [1, -1]) {
        const k2 = n.laneK + dk;
        if (k2 < 0 || k2 > 2) continue;
        const off2 = n.dir * LANE_OFF[k2];
        let clear = true;
        for (const m of this.npcs) {
          if (m === n || !m.active || !m.hw || m.arc || m.wreck) continue;
          if (m.dir !== n.dir || Math.abs(m.offCur - off2) > 1.7) continue;
          const ds = (m.s - n.s) * n.dir;
          if (ds > -18 && ds < 28) {
            clear = false;
            break;
          }
        }
        if (clear) {
          n.laneK = k2;
          n.offT = off2;
          n.blink = off2 < n.offCur ? -1 : 1;
          n.blinkT = 0;
          n.turnCd = 9.5;
          break;
        }
      }
    }
    if (Math.abs(n.offT - n.offCur) > 0.02) {
      n.offCur += clamp(n.offT - n.offCur, -3.2 * dt, 3.2 * dt);
      n.blinkT += dt;
    } else {
      n.offCur = n.offT;
      if (n.blink !== 0) n.blink = 0;
    }
    /* U-turn loop arcs */
    if (!n.arc) {
      if (n.dir > 0 && n.s > HZ) n.arc = { end: 1, th: 0 };
      else if (n.dir < 0 && n.s < -HZ) n.arc = { end: -1, th: Math.PI };
      if (n.arc) {
        n.s = n.arc.end * HZ;
        n.offT = n.offCur;
        n.blink = 0;
      }
    } else {
      const off = Math.max(2.4, Math.abs(n.offCur));
      n.arc.th += (n.v / off) * dt;
      const thEnd = n.arc.end > 0 ? Math.PI : Math.PI * 2;
      if (n.arc.th >= thEnd) {
        const exDir = -n.arc.end;
        const exOff = exDir * LANE_OFF[n.laneK];
        let blocked = false;
        for (const m of this.npcs) {
          if (m === n || !m.active || !m.hw || m.arc || m.wreck) continue;
          if (m.dir !== exDir || Math.abs(m.offCur - exOff) > 1.7) continue;
          const aheadE = (n.arc.end * HZ - m.s) * -exDir;
          if (aheadE > -0.5 && aheadE < 9) {
            blocked = true;
            break;
          }
        }
        if (blocked) {
          n.arc.stall = (n.arc.stall || 0) + dt;
          n.arc.th = thEnd - 0.02;
          n.v = Math.min(n.v, 1.2);
        }
        if (!blocked || (n.arc.stall || 0) > 1.3) {
          n.dir = exDir;
          n.offCur = n.offT = exOff;
          n.s = clamp(n.arc.end * HZ + exDir * 1.5, -HZ + 1, HZ - 1);
          n.arc = null;
          n.turnCd = Math.max(n.turnCd, 3);
          if (blocked) n.v = Math.min(n.v, 3);
        }
      }
    }
  }

  /* wheels */
  private updateWheels() {
    for (let i = 0; i < this.npcs.length; i++) {
      const n = this.npcs[i];
      let k = 0;
      if (n.active) {
        const fx = Math.sin(n.hVis), fz = Math.cos(n.hVis), rx = fz, rz = -fx;
        for (const [lo, so] of n.wheelOffs) {
          this._wd.position.set(n.x + fx * lo + rx * so, n.y + n.wr, n.z + fz * lo + rz * so);
          this._wd.rotation.set(0, n.hVis, 0);
          this._wd.rotateZ(Math.PI / 2);
          this._wd.rotateY(n.spin % TAU);
          this._wd.scale.set(n.wr, 1, n.wr);
          this._wd.updateMatrix();
          this.wheelInst.setMatrixAt(i * 4 + k, this._wd.matrix);
          k++;
        }
      }
      for (; k < 4; k++) {
        this._wd.position.set(0, -999, 0);
        this._wd.scale.set(0.001, 0.001, 0.001);
        this._wd.rotation.set(0, 0, 0);
        this._wd.updateMatrix();
        this.wheelInst.setMatrixAt(i * 4 + k, this._wd.matrix);
      }
    }
    this.wheelInst.instanceMatrix.needsUpdate = true;
  }

  /* light sprites */
  private updateLights(now: number, night: boolean) {
    const SP = this.clouds;
    const blinkOn = now % 0.9 < 0.45;
    for (let i = 0; i < this.npcs.length; i++) {
      const n = this.npcs[i];
      const put = (cloud: Cloud, slot: number, x: number, y: number, z: number, show: boolean) => {
        const o = (i * 2 + slot) * 3, a = cloud.arr;
        if (show) {
          a[o] = x;
          a[o + 1] = y;
          a[o + 2] = z;
        } else a[o + 1] = -999;
      };
      if (!n.active) {
        for (const key in SP) {
          SP[key].arr[i * 2 * 3 + 1] = -999;
          SP[key].arr[(i * 2 + 1) * 3 + 1] = -999;
        }
        continue;
      }
      const fx = Math.sin(n.hVis), fz = Math.cos(n.hVis), rx = fz, rz = -fx;
      const cx2 = n.x, cz2 = n.z, cy = n.y, hl = n.L / 2, hw2 = n.W / 2 - 0.22;
      const wrecked = !!n.wreck;
      const running = night && !wrecked;
      put(SP.head, 0, cx2 + fx * hl - rx * hw2, cy + 0.68, cz2 + fz * hl - rz * hw2, running);
      put(SP.head, 1, cx2 + fx * hl + rx * hw2, cy + 0.68, cz2 + fz * hl + rz * hw2, running);
      put(SP.tail, 0, cx2 - fx * hl - rx * hw2, cy + 0.74, cz2 - fz * hl - rz * hw2, running && !n.brake);
      put(SP.tail, 1, cx2 - fx * hl + rx * hw2, cy + 0.74, cz2 - fz * hl + rz * hw2, running && !n.brake);
      put(SP.brake, 0, cx2 - fx * hl - rx * hw2, cy + 0.74, cz2 - fz * hl - rz * hw2, !wrecked && n.brake);
      put(SP.brake, 1, cx2 - fx * hl + rx * hw2, cy + 0.74, cz2 - fz * hl + rz * hw2, !wrecked && n.brake);
      // signals — wrecks flash hazards on both slots
      if (wrecked) {
        put(SP.sig, 0, cx2 + fx * hl - rx * hw2, cy + 0.66, cz2 + fz * hl - rz * hw2, blinkOn);
        put(SP.sig, 1, cx2 - fx * hl + rx * hw2, cy + 0.72, cz2 - fz * hl + rz * hw2, blinkOn);
      } else {
        const sx = n.blink < 0 ? -1 : 1, show = n.blink !== 0 && blinkOn;
        put(SP.sig, 0, cx2 + fx * hl + rx * hw2 * sx, cy + 0.66, cz2 + fz * hl + rz * hw2 * sx, show);
        put(SP.sig, 1, cx2 - fx * hl + rx * hw2 * sx, cy + 0.72, cz2 - fz * hl + rz * hw2 * sx, show);
      }
      put(SP.roof, 0, cx2, cy + 1.36, cz2, n.type === "taxi" && night && !wrecked);
      put(SP.roof, 1, cx2, cy - 999, cz2, false);
      const isPol = n.type === "police", flash = (now * 3.2) % 1 < 0.5;
      put(SP.polR, 0, cx2 + rx * 0.24, cy + 1.38, cz2 + rz * 0.24, isPol && flash);
      put(SP.polR, 1, cx2, cy - 999, cz2, false);
      put(SP.polB, 0, cx2 - rx * 0.24, cy + 1.38, cz2 - rz * 0.24, isPol && !flash);
      put(SP.polB, 1, cx2, cy - 999, cz2, false);
    }
    for (const key in SP) (SP[key].geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
