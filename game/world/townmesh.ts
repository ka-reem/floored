import * as THREE from "three";
import { clamp, rrand, type Rng, TAU } from "../util";
import { makeTex, asphalt, neonTexF } from "../textures";
import { CHUNK, SIDEWALK_W, RAMP_W, HX } from "./const";
import { distToRamp } from "./ramps";
import type { Mats } from "./mats";
import type { WorldData } from "./data";
import type { Terrain } from "./terrain";
import type { REdge, EdgePose } from "./roadnet";

/* Town geometry: curved road ribbons that follow the terrain, raised
   sidewalks, intersection patches, dense buildings placed along each street
   (chunked into 96 m cells so whole blocks frustum/distance-cull), neon,
   streetlights, utility poles, vending machines and signalised crossings. */

const NEON_WORDS: [string, number][] = [
  ["焼肉", 350], ["ラーメン", 28], ["カラオケ", 190], ["居酒屋", 140], ["パチンコ", 265],
  ["寿司", 50], ["ホテル", 320], ["薬局", 210], ["麻雀", 95], ["喫茶", 15],
];

export function buildTown(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  rng: Rng,
  deckLightPts: number[]
) {
  const net = world.net;
  const pose: EdgePose = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };

  /* ---------- road ribbons (one merged mesh) ---------- */
  {
    const posA: number[] = [], uvA: number[] = [], idxA: number[] = [];
    for (const e of net.edges) {
      const n = e.ss.length - 1;
      const base = posA.length / 3;
      for (let i = 0; i <= n; i++) {
        const x = e.pts[i * 3], y = e.pts[i * 3 + 1], z = e.pts[i * 3 + 2];
        const i0 = Math.max(0, i - 1), i1 = Math.min(n, i + 1);
        let tx = e.pts[i1 * 3] - e.pts[i0 * 3], tz = e.pts[i1 * 3 + 2] - e.pts[i0 * 3 + 2];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const rx = tz, rz = -tx, hw = e.w / 2;
        posA.push(x - rx * hw, y + 0.06, z - rz * hw, x + rx * hw, y + 0.06, z + rz * hw);
        uvA.push(0, e.ss[i] / 14, 1, e.ss[i] / 14);
        if (i < n) {
          const a = base + i * 2;
          // CCW from above: (L0, L1, R0) (R0, L1, R1)
          idxA.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(posA, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvA, 2));
    g.setIndex(idxA);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mats.road);
    m.receiveShadow = true;
    m.layers.set(1);
    scene.add(m);
  }

  /* ---------- intersection patches ---------- */
  const plainTexLocal = makeTex(128, 128, (ctx, w, h) => asphalt(ctx, w, h, "#16181f"), true);
  const plainMat = new THREE.MeshStandardMaterial({
    map: plainTexLocal, roughness: 0.42, metalness: 0.1,
    envMap: mats.envMap, envMapIntensity: 0.4,
  });
  mats.addReflection(plainMat, 0.3);
  {
    const posA: number[] = [], uvA: number[] = [], idxA: number[] = [];
    const SEG = 14;
    for (const nd of net.nodes) {
      if (!nd.edges.length) continue;
      let r = 0;
      for (const eid of nd.edges) r = Math.max(r, net.edges[eid].w * 0.72);
      const y = terrain.h(nd.x, nd.z) + 0.075;
      const base = posA.length / 3;
      posA.push(nd.x, y, nd.z);
      uvA.push(nd.x * 0.06, nd.z * 0.06);
      for (let k = 0; k <= SEG; k++) {
        const a = (k / SEG) * TAU;
        const px = nd.x + Math.cos(a) * r, pz = nd.z + Math.sin(a) * r;
        posA.push(px, terrain.h(px, pz) + 0.075, pz);
        uvA.push(px * 0.06, pz * 0.06);
        if (k < SEG) idxA.push(base, base + 2 + k, base + 1 + k);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(posA, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvA, 2));
    g.setIndex(idxA);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, plainMat);
    m.receiveShadow = true;
    m.layers.set(1);
    scene.add(m);
  }

  /* ---------- sidewalks (top + curb skirt) ---------- */
  {
    const posA: number[] = [], idxA: number[] = [];
    function walkStrip(e: REdge, side: number) {
      const n = e.ss.length - 1;
      let started = false, base = 0, count = 0;
      for (let i = 0; i <= n; i++) {
        const s = e.ss[i];
        if (s < 6 || s > e.len - 6) {
          started = false;
          continue;
        }
        const x = e.pts[i * 3], y = e.pts[i * 3 + 1], z = e.pts[i * 3 + 2];
        const i0 = Math.max(0, i - 1), i1 = Math.min(n, i + 1);
        let tx = e.pts[i1 * 3] - e.pts[i0 * 3], tz = e.pts[i1 * 3 + 2] - e.pts[i0 * 3 + 2];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const rx = tz * side, rz = -tx * side;
        const o0 = e.w / 2 + 0.12, o1 = e.w / 2 + SIDEWALK_W;
        if (!started) {
          base = posA.length / 3;
          count = 0;
          started = true;
        }
        // curb bottom, curb top(inner), walk outer
        posA.push(
          x + rx * o0, y + 0.02, z + rz * o0,
          x + rx * o0, y + 0.17, z + rz * o0,
          x + rx * o1, y + 0.17, z + rz * o1
        );
        if (count > 0) {
          const a = base + (count - 1) * 3;
          idxA.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
          idxA.push(a + 1, a + 2, a + 4, a + 2, a + 5, a + 4);
        }
        count++;
      }
    }
    for (const e of net.edges) {
      walkStrip(e, 1);
      walkStrip(e, -1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(posA, 3));
    g.setIndex(idxA);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mats.sidewalk);
    m.receiveShadow = true;
    scene.add(m);
  }

  /* ---------- crosswalk decals at signal nodes ---------- */
  {
    const xm = new THREE.MeshBasicMaterial({
      map: mats.xingTex, transparent: true, depthWrite: false, opacity: 0.92,
    });
    const group = new THREE.Group();
    for (const nd of net.nodes) {
      if (!nd.signal) continue;
      for (const eid of nd.edges) {
        const e = net.edges[eid];
        const atA = e.a === nd.id;
        const s = atA ? 8.2 : e.len - 8.2;
        net.sampleEdge(e, s, pose);
        const q = new THREE.Mesh(new THREE.PlaneGeometry(e.w - 1, 3.4), xm);
        q.rotation.x = -Math.PI / 2;
        q.rotation.z = -Math.atan2(pose.tx, pose.tz) + Math.PI / 2;
        q.position.set(pose.x, pose.y + 0.085, pose.z);
        q.layers.set(1);
        group.add(q);
      }
    }
    scene.add(group);
  }

  /* ---------- buildings, chunked ---------- */
  type ChunkAcc = {
    win: THREE.Matrix4[][];
    sf: THREE.Matrix4[];
    clutter: THREE.Matrix4[];
    neon: { x: number; z: number; y: number; ry: number; w: number; h: number }[];
  };
  const chunkMap = new Map<string, ChunkAcc>();
  const chunkOf = (x: number, z: number) => {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const k = cx + "_" + cz;
    let c = chunkMap.get(k);
    if (!c) chunkMap.set(k, (c = { win: [[], [], []], sf: [], clutter: [], neon: [] }));
    return c;
  };
  const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(),
    SC = new THREE.Vector3(1, 1, 1), E = new THREE.Euler();
  const tallTops: [number, number, number][] = [];
  let neonBudget = 96;

  function tryPlaceBuilding(e: REdge, side: number, s: number, w: number) {
    net.sampleEdge(e, s, pose);
    const rx = pose.tz * side, rz = -pose.tx * side;
    const d = rrand(rng, 9, 19);
    const setback = e.w / 2 + SIDEWALK_W + 0.7 + d / 2;
    const cx = pose.x + rx * setback, cz = pose.z + rz * setback;
    if (Math.abs(cx) > 620 || Math.abs(cz) > 470) return;
    const rC0 = Math.hypot(w / 2, d / 2);
    // keep the curved ramp corridors (both sides) clear
    const clear = RAMP_W / 2 + 5 + rC0;
    if (distToRamp(terrain.ramps, cx, cz, clear + 1) < clear) return;
    // never under the elevated deck itself
    if (Math.abs(cx - HX) < 16 + rC0) return;
    const yaw = Math.atan2(pose.tx, pose.tz);
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    // reject if the footprint clips any nearby road
    const rC = Math.hypot(w / 2, d / 2);
    const cellR = Math.ceil((rC + 8) / 12);
    const ci = Math.floor(cx / 12), cj = Math.floor(cz / 12);
    for (let di = -cellR; di <= cellR; di++)
      for (let dj = -cellR; dj <= cellR; dj++) {
        const arr = net.hash.get((ci + di + 2048) * 8192 + (cj + dj + 2048));
        if (!arr) continue;
        for (const [sx, sz, eid2] of arr) {
          const lx = (sx - cx) * cos - (sz - cz) * sin;
          const lz = (sx - cx) * sin + (sz - cz) * cos;
          const margin = net.edges[eid2].w / 2 + SIDEWALK_W + 0.3;
          if (Math.abs(lx) < w / 2 + margin && Math.abs(lz) < d / 2 + margin) return;
        }
      }
    const central = clamp(1 - Math.hypot(cx, cz) / 520, 0, 1);
    let hgt = rrand(rng, 7, 20) + central * rrand(rng, 0, 26);
    if (central > 0.35 && rng() < 0.16) hgt = rrand(rng, 55, 130);
    const gy = terrain.h(cx, cz);
    const chunk = chunkOf(cx, cz);
    const ti = Math.floor(rng() * 3);
    E.set(0, yaw, 0);
    Q.setFromEuler(E);
    V.set(cx, gy + hgt / 2 - 0.6, cz);
    SC.set(w, hgt + 0.6, d);
    M.compose(V, Q, SC);
    chunk.win[ti].push(M.clone());
    world.colliders.addObb({
      x: cx, z: cz, hw: w / 2, hd: d / 2, cos, sin, y0: gy - 1, y1: gy + hgt,
    });
    if (hgt > 55) tallTops.push([cx, gy + hgt, cz]);
    if (hgt < 40 && rng() < 0.78) {
      V.set(cx, gy + 2.0, cz);
      SC.set(w + 0.45, 4.2, d + 0.45);
      M.compose(V, Q, SC);
      chunk.sf.push(M.clone());
    }
    if (hgt > 11 && rng() < 0.45) {
      V.set(cx + rrand(rng, -w / 4, w / 4), gy + hgt + 0.9, cz + rrand(rng, -d / 4, d / 4));
      SC.set(1, 1, 1);
      M.compose(V, Q, SC);
      chunk.clutter.push(M.clone());
    }
    if (neonBudget > 0 && hgt > 8 && rng() < 0.3) {
      neonBudget--;
      const fx = cx - rx * (d / 2 + 0.35), fz = cz - rz * (d / 2 + 0.35);
      chunk.neon.push({
        x: fx, z: fz, y: gy + rrand(rng, 4.5, Math.max(5.5, hgt - 2)),
        ry: Math.atan2(-rx, -rz), w: rrand(rng, 5.5, 9.5), h: rrand(rng, 2.2, 3.2),
      });
    }
  }

  for (const e of net.edges) {
    for (const side of [1, -1]) {
      let s = rrand(rng, 8, 14);
      while (s < e.len - 9) {
        const w = rrand(rng, 9, 19);
        if (s + w / 2 > e.len - 9) break;
        tryPlaceBuilding(e, side, s + w / 2, w);
        s += w + rrand(rng, 0.5, 4);
      }
    }
  }

  /* materialise chunks */
  const winGeo = new THREE.BoxGeometry(1, 1, 1);
  const tankG = new THREE.CylinderGeometry(1.6, 1.6, 2.6, 8);
  const neonMatCache: THREE.MeshBasicMaterial[] = [];
  for (const [word, hue] of NEON_WORDS)
    neonMatCache.push(
      new THREE.MeshBasicMaterial({
        map: neonTexF(word, hue), transparent: true, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      })
    );
  world.neonMats.push(...neonMatCache);
  for (const [key, acc] of chunkMap) {
    const [cxs, czs] = key.split("_").map(Number);
    const group = new THREE.Group();
    for (let ti = 0; ti < 3; ti++) {
      const list = acc.win[ti];
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(winGeo, mats.winMats[ti], list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      group.add(im);
    }
    if (acc.sf.length) {
      const im = new THREE.InstancedMesh(winGeo, mats.sfMat, acc.sf.length);
      acc.sf.forEach((m, i) => im.setMatrixAt(i, m));
      im.computeBoundingSphere();
      group.add(im);
    }
    if (acc.clutter.length) {
      const im = new THREE.InstancedMesh(tankG, mats.clutterMat, acc.clutter.length);
      acc.clutter.forEach((m, i) => im.setMatrixAt(i, m));
      im.computeBoundingSphere();
      group.add(im);
    }
    for (const nn of acc.neon) {
      const mat = neonMatCache[Math.floor(rng() * neonMatCache.length)];
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(nn.w, nn.h), mat);
      mesh.position.set(nn.x, nn.y, nn.z);
      mesh.rotation.y = nn.ry;
      group.add(mesh);
    }
    scene.add(group);
    world.chunks.push({ group, cx: cxs * CHUNK + CHUNK / 2, cz: czs * CHUNK + CHUNK / 2 });
  }

  /* rooftop beacons */
  {
    const p = new Float32Array(tallTops.length * 3);
    tallTops.forEach((t, i) => {
      p[i * 3] = t[0];
      p[i * 3 + 1] = t[1] + 1.6;
      p[i * 3 + 2] = t[2];
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    const beaconMat = new THREE.PointsMaterial({
      size: 2.6, map: mats.glowTex, color: 0xff3040, transparent: true,
      opacity: 0.8, sizeAttenuation: false, depthWrite: false,
    });
    world.beaconPts = new THREE.Points(g, beaconMat);
    world.beaconPts.frustumCulled = false;
    scene.add(world.beaconPts);
  }

  /* ---------- streetlights along edges ---------- */
  const lightPts: [number, number, number, number][] = []; // x, lampY, z, groundY
  {
    const poleG = new THREE.CylinderGeometry(0.09, 0.12, 7.6, 6);
    const armG = new THREE.BoxGeometry(1.7, 0.09, 0.09);
    const items: { x: number; y: number; z: number; armX: number; armZ: number }[] = [];
    for (const e of net.edges) {
      let flip = rng() < 0.5 ? 1 : -1;
      for (let s = 16; s < e.len - 10; s += 42) {
        net.sampleEdge(e, s, pose);
        const rx = pose.tz * flip, rz = -pose.tx * flip;
        const o = e.w / 2 + 0.6;
        items.push({
          x: pose.x + rx * o, y: pose.y, z: pose.z + rz * o,
          armX: -rx * 0.8, armZ: -rz * 0.8,
        });
        lightPts.push([pose.x + rx * o - rx * 1.55, pose.y + 7.45, pose.z + rz * o - rz * 1.55, pose.y]);
        flip = -flip;
      }
    }
    const poles = new THREE.InstancedMesh(poleG, mats.pole, items.length);
    const arms = new THREE.InstancedMesh(armG, mats.pole, items.length);
    const Q0 = new THREE.Quaternion();
    items.forEach((it, i) => {
      V.set(it.x, it.y + 3.8, it.z);
      SC.set(1, 1, 1);
      E.set(0, Math.atan2(it.armX, it.armZ) + Math.PI / 2, 0);
      Q0.setFromEuler(E);
      M.compose(V, Q0, SC);
      poles.setMatrixAt(i, M);
      V.set(it.x + it.armX, it.y + 7.5, it.z + it.armZ);
      M.compose(V, Q0, SC);
      arms.setMatrixAt(i, M);
    });
    poles.computeBoundingSphere();
    arms.computeBoundingSphere();
    scene.add(poles, arms);
  }
  // merge deck lights into the pooled glow + ground pools
  for (let i = 0; i < deckLightPts.length; i += 3)
    lightPts.push([deckLightPts[i], deckLightPts[i + 1], deckLightPts[i + 2], deckLightPts[i + 1] - 7.42]);
  {
    const p = new Float32Array(lightPts.length * 3);
    lightPts.forEach((l, i) => {
      p[i * 3] = l[0];
      p[i * 3 + 1] = l[1];
      p[i * 3 + 2] = l[2];
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    world.glowPts = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 7, map: mats.glowTex, color: 0xffd9a0, transparent: true,
        opacity: 1, sizeAttenuation: false, depthWrite: false,
      })
    );
    world.glowPts.frustumCulled = false;
    scene.add(world.glowPts);
    // warm light pools on the ground under each lamp
    const pool = new Float32Array(lightPts.length * 18);
    const uv = new Float32Array(lightPts.length * 12);
    const half = 5.4;
    lightPts.forEach((l, i) => {
      const o = i * 18;
      const y = l[3] + 0.06;
      const vs = [
        [-half, -half], [half, -half], [half, half],
        [-half, -half], [half, half], [-half, half],
      ];
      vs.forEach((v, k) => {
        pool[o + k * 3] = l[0] + v[0];
        pool[o + k * 3 + 1] = y + 0.04;
        pool[o + k * 3 + 2] = l[2] + v[1];
      });
      const us = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
      us.forEach((u, k) => {
        uv[i * 12 + k * 2] = u[0];
        uv[i * 12 + k * 2 + 1] = u[1];
      });
    });
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pool, 3));
    pg.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const poolTex = makeTex(128, 128, (ctx, w, h) => {
      const g2 = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
      g2.addColorStop(0, "rgba(255,214,150,.5)");
      g2.addColorStop(1, "rgba(255,214,150,0)");
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, w, h);
    });
    world.pools = new THREE.Mesh(
      pg,
      new THREE.MeshBasicMaterial({
        map: poolTex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0.3, side: THREE.DoubleSide,
      })
    );
    world.pools.layers.set(1);
    world.pools.frustumCulled = false;
    scene.add(world.pools);
  }

  /* ---------- utility poles + wires ---------- */
  {
    const pg = new THREE.CylinderGeometry(0.14, 0.17, 9.5, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a352e, roughness: 0.9 });
    const positions: [number, number, number][] = [];
    const wirePos: number[] = [];
    for (const e of net.edges) {
      if (rng() < 0.5 || e.front) continue;
      let prev: [number, number, number] | null = null;
      for (let s = 10; s < e.len - 6; s += 44) {
        net.sampleEdge(e, s, pose);
        const rx = pose.tz, rz = -pose.tx;
        const o = e.w / 2 + SIDEWALK_W + 0.4;
        const px = pose.x - rx * o, py = pose.y, pz = pose.z - rz * o;
        positions.push([px, py, pz]);
        if (prev) {
          for (const hy of [8.6, 9.1]) {
            const segs = 7;
            for (let s2 = 0; s2 < segs; s2++) {
              const t0 = s2 / segs, t1 = (s2 + 1) / segs;
              const sag = (t: number) => 1.1 * Math.sin(Math.PI * t);
              wirePos.push(
                prev[0] + (px - prev[0]) * t0, prev[1] + hy - sag(t0) + (py - prev[1]) * t0,
                prev[2] + (pz - prev[2]) * t0,
                prev[0] + (px - prev[0]) * t1, prev[1] + hy - sag(t1) + (py - prev[1]) * t1,
                prev[2] + (pz - prev[2]) * t1
              );
            }
          }
        }
        prev = [px, py, pz];
      }
    }
    const upoles = new THREE.InstancedMesh(pg, mat, Math.max(1, positions.length));
    positions.forEach((p, i) => {
      V.set(p[0], p[1] + 4.75, p[2]);
      SC.set(1, 1, 1);
      M.compose(V, new THREE.Quaternion(), SC);
      upoles.setMatrixAt(i, M);
    });
    upoles.count = positions.length;
    upoles.castShadow = true;
    upoles.computeBoundingSphere();
    scene.add(upoles);
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(wirePos), 3));
    scene.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x05060a })));
  }

  /* ---------- vending machines ---------- */
  {
    const vg = new THREE.BoxGeometry(0.95, 1.85, 0.75);
    const list: THREE.Matrix4[] = [];
    for (const nd of net.nodes) {
      if (nd.front || rng() > 0.34 || list.length >= 110) continue;
      const a = rrand(rng, 0, TAU), r = rrand(rng, 9.5, 13);
      const x = nd.x + Math.cos(a) * r, z = nd.z + Math.sin(a) * r;
      V.set(x, terrain.h(x, z) + 0.95, z);
      E.set(0, rrand(rng, 0, TAU), 0);
      Q.setFromEuler(E);
      SC.set(1, 1, 1);
      M.compose(V, Q, SC);
      list.push(M.clone());
    }
    if (list.length) {
      const vend = new THREE.InstancedMesh(vg, mats.vendMat, list.length);
      list.forEach((m, i) => vend.setMatrixAt(i, m));
      vend.computeBoundingSphere();
      scene.add(vend);
    }
  }

  /* ---------- traffic lights at signal nodes ---------- */
  {
    const poleG = new THREE.CylinderGeometry(0.1, 0.12, 5.6, 6);
    const headG = new THREE.BoxGeometry(1.5, 0.55, 0.32);
    const sigNodes = net.nodes.filter((n) => n.signal);
    const tp = new THREE.InstancedMesh(poleG, mats.pole, sigNodes.length * 2);
    const th = new THREE.InstancedMesh(
      headG, new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.6 }),
      sigNodes.length * 4
    );
    const lampNS: [number, number, number][] = [], lampEW: [number, number, number][] = [];
    let pn = 0, hn = 0;
    const Q0 = new THREE.Quaternion();
    for (const nd of sigNodes) {
      const gy = terrain.h(nd.x, nd.z);
      for (const [ox, oz, ry] of [[-8.6, -8.6, 0], [8.6, 8.6, Math.PI]] as const) {
        const cx = nd.x + ox, cz = nd.z + oz;
        V.set(cx, gy + 2.8, cz);
        SC.set(1, 1, 1);
        M.compose(V, new THREE.Quaternion(), SC);
        tp.setMatrixAt(pn++, M);
        V.set(cx, gy + 5.35, cz + (ry === 0 ? 0.55 : -0.55));
        E.set(0, ry, 0);
        Q0.setFromEuler(E);
        M.compose(V, Q0, SC);
        th.setMatrixAt(hn++, M);
        lampNS.push([cx, gy + 5.35, cz + (ry === 0 ? 0.75 : -0.75)]);
        V.set(cx + (ry === 0 ? 0.55 : -0.55), gy + 5.35, cz);
        E.set(0, ry + Math.PI / 2, 0);
        Q0.setFromEuler(E);
        M.compose(V, Q0, SC);
        th.setMatrixAt(hn++, M);
        lampEW.push([cx + (ry === 0 ? 0.75 : -0.75), gy + 5.35, cz]);
      }
    }
    tp.count = pn;
    th.count = hn;
    tp.computeBoundingSphere();
    th.computeBoundingSphere();
    scene.add(tp, th);
    function lampCloud(list: [number, number, number][], color: number) {
      const p = new Float32Array(list.length * 3);
      list.forEach((l, i) => {
        p[i * 3] = l[0];
        p[i * 3 + 1] = l[1];
        p[i * 3 + 2] = l[2];
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p, 3));
      const pts = new THREE.Points(
        g,
        new THREE.PointsMaterial({
          size: 5, map: mats.glowTex, color, transparent: true,
          sizeAttenuation: false, depthWrite: false,
        })
      );
      pts.frustumCulled = false;
      scene.add(pts);
      return pts;
    }
    world.signalHeads = {
      nsG: lampCloud(lampNS, 0x3aff7a), nsY: lampCloud(lampNS, 0xffc23a),
      nsR: lampCloud(lampNS, 0xff3a4a), ewG: lampCloud(lampEW, 0x3aff7a),
      ewY: lampCloud(lampEW, 0xffc23a), ewR: lampCloud(lampEW, 0xff3a4a),
    };
  }
}
