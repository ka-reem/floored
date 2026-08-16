import * as THREE from "three";
import { rrand, type Rng } from "../util";
import { makeTex, signTexF, exitSignTexF, warnTexF } from "../textures";
import { HX, DECKY, HZ, RW, CONNECT_Z, RAMP_W } from "./const";
import type { Mats } from "./mats";
import type { WorldData } from "./data";
import type { Terrain } from "./terrain";

const EXIT_NAMES = ["中野 Nakano", "本町 Honchō", "港南 Kōnan"];

/* Elevated expressway: deck, pillars, parapets, U-turn loop ends, and the
   v3 exit treatment — long decel taper, painted gore, countdown signage at
   300/150 m, lit edge posts and flashing beacons. Ramps on both sides. */

export function buildHighway(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  rng: Rng
) {
  const { conc, concDark, barrier, soundwall, hwy, ramp } = mats;
  const add = (b: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }) =>
    world.colliders.addAabb(b);

  /* ---- deck ---- */
  {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(RW + 2.2, 1.25, HZ * 2), conc);
    slab.position.set(HX, DECKY - 0.66, 0);
    slab.castShadow = true;
    slab.receiveShadow = true;
    scene.add(slab);
    const deckRoad = new THREE.Mesh(new THREE.PlaneGeometry(RW, HZ * 2), hwy);
    deckRoad.rotation.x = -Math.PI / 2;
    deckRoad.position.set(HX, DECKY + 0.005, 0);
    (hwy.map as THREE.Texture).repeat.set(1, 86);
    deckRoad.receiveShadow = true;
    deckRoad.layers.set(1);
    scene.add(deckRoad);

    const pg = new THREE.CylinderGeometry(1.15, 1.35, DECKY - 0.1, 10);
    const pier = new THREE.InstancedMesh(pg, concDark, 92);
    const bg = new THREE.BoxGeometry(RW + 3, 1.1, 2.4);
    const beams = new THREE.InstancedMesh(bg, concDark, 92);
    const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(),
      SC = new THREE.Vector3(1, 1, 1);
    let n = 0, m = 0;
    for (let z = -HZ + 14; z <= HZ - 14; z += 26) {
      V.set(HX, (DECKY - 0.1) / 2, z);
      M.compose(V, Q, SC);
      pier.setMatrixAt(n++, M);
      add({ x0: HX - 1.35, x1: HX + 1.35, z0: z - 1.35, z1: z + 1.35, y0: 0, y1: DECKY - 1 });
      V.set(HX, DECKY - 1.35, z);
      M.compose(V, Q, SC);
      beams.setMatrixAt(m++, M);
    }
    pier.count = n;
    beams.count = m;
    pier.castShadow = true;
    pier.computeBoundingSphere();
    beams.computeBoundingSphere();
    scene.add(pier, beams);
  }

  function wall(x0: number, x1: number, z0: number, z1: number, h: number, y0: number,
    mat?: THREE.Material, noMesh?: boolean) {
    add({ x0, x1, z0, z1, y0, y1: y0 + h + 2 });
    if (noMesh) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, z1 - z0), mat || barrier);
    m.position.set((x0 + x1) / 2, y0 + h / 2, (z0 + z1) / 2);
    m.castShadow = true;
    scene.add(m);
  }

  /* ---- parapets with exit gaps on BOTH sides + median with crossover gaps ----
     The gap has to span the whole divergence zone: the ramp runs alongside the
     deck until it has cleared the edge, and only then can a parapet reappear. */
  const gapHalf = new Map<number, number>();
  for (const r of terrain.ramps)
    gapHalf.set(r.zr, Math.max(gapHalf.get(r.zr) ?? 0, r.gapZ + 2));
  for (const side of [-1, 1]) {
    const xa = side < 0 ? HX - RW / 2 - 0.55 : HX + RW / 2 - 0.05;
    const xb = side < 0 ? HX - RW / 2 + 0.05 : HX + RW / 2 + 0.55;
    let zs = -HZ;
    for (const zr of CONNECT_Z) {
      const g = gapHalf.get(zr) ?? RAMP_W / 2 + 1.6;
      wall(xa, xb, zs, zr - g, 1.05, DECKY);
      zs = zr + g;
    }
    wall(xa, xb, zs, HZ, 1.05, DECKY);
  }
  {
    let z0 = -HZ;
    for (const g of CONNECT_Z) {
      wall(HX - 0.5, HX + 0.5, z0, g - 5, 1.0, DECKY);
      z0 = g + 5;
    }
    wall(HX - 0.5, HX + 0.5, z0, HZ, 1.0, DECKY);
  }
  // sound walls, east side, kept clear of ramp gaps
  for (let z = -HZ + 60; z < HZ - 160; z += 340) {
    let ok = true;
    for (const zr of CONNECT_Z) if (Math.abs(z + 75 - zr) < 150) ok = false;
    if (!ok) continue;
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.6, 150), soundwall);
    m.position.set(HX + RW / 2 + 0.3, DECKY + 1.05 + 1.3, z + 75);
    scene.add(m);
  }

  /* ---- ramps: one curved carriageway per exit, side and travel direction ----
     Each ramp is a swept ribbon along its centreline (see ramps.ts): pavement,
     a concrete apron/skirt underneath, parapets down both edges and support
     columns wherever it is off the ground. All of it goes into three merged
     buffers so the whole interchange set costs a handful of draw calls. */
  const postPts: number[] = [];
  {
    const surfPos: number[] = [], surfUv: number[] = [], skirtPos: number[] = [],
      wallPos: number[] = [];
    const WALL_H = 1.0, WALL_T = 0.3, DECKTH = 0.62;
    type P3 = [number, number, number];
    const tri = (a: number[], p: P3, q: P3, r: P3) =>
      a.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
    // p0..p3 wind around the quad; `flip` reverses the facing
    const quad = (a: number[], p0: P3, p1: P3, p2: P3, p3: P3, flip: boolean) => {
      if (flip) {
        tri(a, p0, p2, p1);
        tri(a, p0, p3, p2);
      } else {
        tri(a, p0, p1, p2);
        tri(a, p0, p2, p3);
      }
    };
    const colG = new THREE.BoxGeometry(1.25, 1, 1.25);
    const cols = new THREE.InstancedMesh(colG, concDark, 220);
    const CM = new THREE.Matrix4(), CV = new THREE.Vector3(), CQ = new THREE.Quaternion(),
      CS = new THREE.Vector3(), CE = new THREE.Euler();
    let nCol = 0;

    for (const r of terrain.ramps) {
      const flip = r.mir * r.dir < 0;
      const pts = r.pts;
      // lateral offsets: +n is the deck side
      const edge = (i: number, lat: number, dy = 0): P3 => {
        const p = pts[i];
        return [p.x + p.nx * lat, p.y + dy, p.z + p.nz * lat];
      };
      const wallEnd = r.len - 7; // leave the junction with the frontage road open
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const va = a.s / 14, vb = b.s / 14;
        const oa = edge(i, -a.hOut), ob = edge(i + 1, -b.hOut);
        const ia = edge(i, a.hIn), ib = edge(i + 1, b.hIn);
        quad(surfPos, oa, ob, ib, ia, flip);
        if (flip) surfUv.push(0, va, 1, vb, 0, vb, 0, va, 1, va, 1, vb);
        else surfUv.push(0, va, 0, vb, 1, vb, 0, va, 1, vb, 1, va);
        // skirt + underside, only where the ramp stands above the ground
        const upA = a.y - a.gy, upB = b.y - b.gy;
        if (upA > 0.25 || upB > 0.25) {
          const da = Math.min(DECKTH, Math.max(0.12, upA));
          const db = Math.min(DECKTH, Math.max(0.12, upB));
          const oab = edge(i, -a.hOut, -da), obb = edge(i + 1, -b.hOut, -db);
          const iab = edge(i, a.hIn, -da), ibb = edge(i + 1, b.hIn, -db);
          quad(skirtPos, oa, ob, obb, oab, flip);
          quad(skirtPos, ia, ib, ibb, iab, !flip);
          quad(skirtPos, oab, obb, ibb, iab, !flip);
        }
        // Parapets. The outer one starts at the gore nose and follows the edge
        // as it opens away from the deck, so the drop is guarded the whole way
        // and the driver is always inboard of it. The inner one only appears
        // once the ramp has separated — before that the deck itself is there.
        for (const sgn of [-1, 1]) {
          const la = sgn > 0 ? a.hIn : -a.hOut, lb = sgn > 0 ? b.hIn : -b.hOut;
          if (a.s > wallEnd) continue;
          if (sgn > 0 && a.s < r.sSep) continue;
          const off = sgn * (WALL_T / 2 + 0.12);
          const a0 = edge(i, la + off - sgn * WALL_T / 2), a1 = edge(i, la + off + sgn * WALL_T / 2);
          const b0 = edge(i + 1, lb + off - sgn * WALL_T / 2),
            b1 = edge(i + 1, lb + off + sgn * WALL_T / 2);
          const top = (p: P3): P3 => [p[0], p[1] + WALL_H, p[2]];
          const bot = (p: P3): P3 => [p[0], p[1] - 0.25, p[2]];
          quad(wallPos, bot(a0), bot(b0), top(b0), top(a0), false);
          quad(wallPos, bot(a1), bot(b1), top(b1), top(a1), false);
          quad(wallPos, top(a0), top(b0), top(b1), top(a1), false);
          // one collider per segment: the outer wall flares out of the gore
          // nose quickly, so a box spanning several segments would cut the
          // corner and sit on the pavement
          const mx = (a0[0] + b0[0] + a1[0] + b1[0]) / 4;
          const mz = (a0[2] + b0[2] + a1[2] + b1[2]) / 4;
          const wdx = (b0[0] + b1[0] - a0[0] - a1[0]) / 2;
          const wdz = (b0[2] + b1[2] - a0[2] - a1[2]) / 2;
          const wl = Math.hypot(wdx, wdz) || 1;
          world.colliders.addObb({
            x: mx, z: mz, hw: WALL_T / 2 + 0.2, hd: wl / 2 + 0.1,
            cos: wdz / wl, sin: wdx / wl, y0: a.y - 1.2, y1: a.y + WALL_H + 1.2,
          });
        }
        // edge lighting down both sides
        if (i % 8 === 0 && a.s < wallEnd) {
          const lo = edge(i, -a.hOut - 0.5, 0.95), li = edge(i, a.hIn + 0.5, 0.95);
          postPts.push(lo[0], lo[1], lo[2], li[0], li[1], li[2]);
        }
        // support columns
        if (i % 7 === 0 && upA > 2.2 && nCol < 220) {
          CE.set(0, Math.atan2(a.tx, a.tz), 0);
          CQ.setFromEuler(CE);
          CV.set(a.x, a.gy + (upA - 0.5) / 2, a.z);
          CS.set(1, upA - 0.5, 1);
          CM.compose(CV, CQ, CS);
          cols.setMatrixAt(nCol++, CM);
          add({ x0: a.x - 0.85, x1: a.x + 0.85, z0: a.z - 0.85, z1: a.z + 0.85,
            y0: 0, y1: a.gy + upA - 1.2 });
        }
      }
      // flat apron where the ramp meets the frontage road
      const apron = new THREE.Mesh(new THREE.PlaneGeometry(24, RAMP_W), ramp);
      apron.rotation.x = -Math.PI / 2;
      apron.position.set(r.footX - r.mir * 11, pts[pts.length - 1].gy + 0.012, r.footZ);
      apron.layers.set(1);
      scene.add(apron);
    }
    cols.count = nCol;
    cols.castShadow = true;
    cols.computeBoundingSphere();
    scene.add(cols);

    const mkGeom = (pos: number[], uv?: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      if (uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    };
    const surf = new THREE.Mesh(mkGeom(surfPos, surfUv), ramp);
    surf.receiveShadow = true;
    surf.layers.set(1);
    scene.add(surf);
    const skirtMat = concDark.clone();
    skirtMat.side = THREE.DoubleSide;
    const skirt = new THREE.Mesh(mkGeom(skirtPos), skirtMat);
    skirt.castShadow = true;
    scene.add(skirt);
    const wallMat = barrier.clone();
    wallMat.side = THREE.DoubleSide;
    const walls = new THREE.Mesh(mkGeom(wallPos), wallMat);
    walls.castShadow = true;
    scene.add(walls);
  }

  /* ---- U-turn loop ends ---- */
  const arcMat = new THREE.MeshStandardMaterial({
    color: 0x171921, roughness: 0.42, metalness: 0.1,
    envMap: mats.envMap, envMapIntensity: 0.4,
  });
  for (const e of [1, -1]) {
    const cz = e * HZ;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.0, RW / 2, 44, 1, e > 0 ? Math.PI : 0, Math.PI), arcMat);
    ring.rotateX(-Math.PI / 2);
    ring.position.set(HX, DECKY + 0.004, cz);
    ring.receiveShadow = true;
    ring.layers.set(1);
    scene.add(ring);
    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(RW / 2 + 1.1, RW / 2 + 1.1, 1.25, 26, 1, false,
        e > 0 ? -Math.PI / 2 : Math.PI / 2, Math.PI), conc);
    slab.position.set(HX, DECKY - 0.66, cz);
    slab.castShadow = true;
    scene.add(slab);
    const Rp = RW / 2 + 0.18, Nseg = 20;
    for (let k = 0; k < Nseg; k++) {
      const f0 = ((k + 0.5) / Nseg) * Math.PI;
      const px = HX + e * Math.cos(f0) * Rp, pz = cz + e * Math.sin(f0) * Rp;
      const seg = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 1.05, (Math.PI * Rp) / Nseg + 0.5), barrier);
      seg.position.set(px, DECKY + 0.52, pz);
      seg.rotation.y = Math.atan2(-Math.sin(f0), Math.cos(f0));
      scene.add(seg);
      add({ x0: px - 1.1, x1: px + 1.1, z0: pz - 1.1, z1: pz + 1.1, y0: DECKY - 1, y1: DECKY + 2 });
      if (k % 3 === 1) {
        const ch = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.95),
          new THREE.MeshBasicMaterial({ map: mats.chevTex, fog: false }));
        ch.position.set(px - e * Math.cos(f0) * 0.5, DECKY + 1.35, pz - e * Math.sin(f0) * 0.5);
        ch.rotation.y = Math.atan2(HX - px, cz - pz);
        scene.add(ch);
      }
    }
    const pil = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 1.3, 14), barrier);
    pil.position.set(HX, DECKY + 0.55, cz);
    scene.add(pil);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, DECKY, 12), concDark);
    col.position.set(HX, DECKY / 2 - 0.6, cz);
    col.castShadow = true;
    scene.add(col);
    add({ x0: HX - 1.25, x1: HX + 1.25, z0: cz - 1.25, z1: cz + 1.25, y0: 0, y1: DECKY + 1.6 });
    for (const f of [Math.PI * 0.3, Math.PI * 0.7]) {
      const px = HX + e * Math.cos(f) * (RW / 2 - 3), pz = cz + e * Math.sin(f) * (RW / 2 - 3);
      const p = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.2, DECKY - 1, 10), concDark);
      p.position.set(px, DECKY / 2 - 0.9, pz);
      scene.add(p);
    }
    const wg = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 2.4),
      new THREE.MeshBasicMaterial({ map: warnTexF("この先 Uターン", "U-TURN 250 m"), fog: false }));
    wg.position.set(HX + e * 7, DECKY + 5.2, cz - e * 250);
    wg.rotation.y = e > 0 ? Math.PI : 0;
    scene.add(wg);
    for (const px2 of [HX + e * 7 - 4.4, HX + e * 7 + 4.4]) {
      const p2 = new THREE.Mesh(new THREE.BoxGeometry(0.26, 6.2, 0.26),
        new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.6, metalness: 0.6 }));
      p2.position.set(px2, DECKY + 3.1, cz - e * 250);
      scene.add(p2);
    }
  }

  /* ---- exit clarity pack v3 ---- */
  const goreMat = new THREE.MeshBasicMaterial({ map: mats.goreTex, transparent: true, depthWrite: false });
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0xf2f5fa });
  world.goreBeaconMat = new THREE.SpriteMaterial({
    map: mats.glowTex, color: 0xffb020, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  // painted decel-lane taper + curved exit arrows on the deck surface
  const arrowTex = makeTex(96, 192, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(235,240,248,.92)";
    ctx.lineWidth = 14;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(w / 2, h - 14);
    ctx.quadraticCurveTo(w / 2, h * 0.4, w * 0.24, h * 0.2);
    ctx.stroke();
    ctx.fillStyle = "rgba(235,240,248,.92)";
    ctx.beginPath();
    ctx.moveTo(w * 0.06, h * 0.22);
    ctx.lineTo(w * 0.42, h * 0.05);
    ctx.lineTo(w * 0.38, h * 0.36);
    ctx.closePath();
    ctx.fill();
  });
  const taperTex = makeTex(128, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(240,244,250,.9)";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(w - 6, 0);
    ctx.lineTo(6, h);
    ctx.stroke();
    ctx.setLineDash([18, 22]);
    ctx.beginPath();
    ctx.moveTo(w - 6, 0);
    ctx.lineTo(w - 6, h);
    ctx.stroke();
  });
  const exitBoards: THREE.Mesh[] = [];
  CONNECT_Z.forEach((zr, gi) => {
    world.exits.push({ z: zr, no: gi + 1, name: EXIT_NAMES[gi] || "出口" });
    for (const MIR of [1, -1]) {
      const edgeX = HX - MIR * (RW / 2 - 1.9);
      // gore chevrons on the surface
      const gore = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 5.6), goreMat);
      gore.rotation.x = -Math.PI / 2;
      gore.rotation.z = MIR > 0 ? 0 : Math.PI;
      gore.position.set(edgeX, DECKY + 0.02, zr);
      gore.layers.set(1);
      scene.add(gore);
      // white gore edge strokes
      for (const sgn of [-1, 1]) {
        const st = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 7.5), edgeMat);
        st.rotation.x = -Math.PI / 2;
        st.rotation.z = MIR * sgn * 0.42;
        st.position.set(HX - MIR * (RW / 2 - 1.0), DECKY + 0.02, zr + sgn * (RAMP_W / 2 + 3.4));
        st.layers.set(1);
        scene.add(st);
      }
      // amber beacon at the gore nose
      const bea = new THREE.Sprite(world.goreBeaconMat);
      bea.scale.set(1.9, 1.9, 1);
      bea.position.set(HX - MIR * (RW / 2 - 0.5), DECKY + 1.9, zr);
      scene.add(bea);
      // decel taper + arrows for both travel directions on this side
      for (const dir of [1, -1]) {
        const tp = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 46), new THREE.MeshBasicMaterial({
          map: taperTex, transparent: true, depthWrite: false }));
        tp.rotation.x = -Math.PI / 2;
        tp.rotation.z = dir > 0 ? (MIR > 0 ? 0 : Math.PI) : MIR > 0 ? Math.PI : 0;
        tp.position.set(HX - MIR * (RW / 2 - 2.1), DECKY + 0.018, zr - dir * 34);
        tp.layers.set(1);
        scene.add(tp);
        for (let k = 0; k < 3; k++) {
          const ar = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 3.2), new THREE.MeshBasicMaterial({
            map: arrowTex, transparent: true, depthWrite: false }));
          ar.rotation.x = -Math.PI / 2;
          ar.rotation.z = dir > 0 ? 0 : Math.PI;
          if (MIR < 0) ar.scale.x = -1;
          ar.position.set(HX - MIR * (RW / 2 - 2.6), DECKY + 0.02, zr - dir * (58 + k * 26));
          ar.layers.set(1);
          scene.add(ar);
        }
        // countdown signage at 300 / 150 m
        for (const dist of [300, 150]) {
          const sx = HX - MIR * 7;
          const szz = zr - dir * dist;
          if (Math.abs(szz) > HZ - 30) continue;
          const board = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 2.8),
            new THREE.MeshBasicMaterial({
              map: exitSignTexF(gi + 1, dist + " m", (EXIT_NAMES[gi] || "").split(" ")[0]),
              fog: false,
            }));
          board.position.set(sx, DECKY + 5.4, szz);
          board.rotation.y = dir > 0 ? Math.PI : 0;
          scene.add(board);
          exitBoards.push(board);
          for (const px of [sx - 4, sx + 4]) {
            const p = new THREE.Mesh(new THREE.BoxGeometry(0.28, 6.8, 0.28),
              new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.6, metalness: 0.6 }));
            p.position.set(px, DECKY + 3.4, szz);
            scene.add(p);
          }
        }
      }
      // sign right at the gore
      for (const ry of [0, Math.PI]) {
        const eb = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.9),
          new THREE.MeshBasicMaterial({
            map: exitSignTexF(gi + 1, "出口", (EXIT_NAMES[gi] || "").split(" ")[0]), fog: false }));
        eb.position.set(HX - MIR * (RW / 2 + 0.35), DECKY + 3.1, zr + (ry === 0 ? -1 : 1) * 2.2);
        eb.rotation.y = ry;
        scene.add(eb);
      }
      // ground-level entrance sign at each ramp foot on this side
      for (const r of terrain.ramps) {
        if (r.zr !== zr || r.mir !== MIR) continue;
        const gx = r.footX - MIR * 6;
        const gz = r.footZ + MIR * (RAMP_W / 2 + 2.4);
        const gp = new THREE.Mesh(new THREE.BoxGeometry(0.24, 3.6, 0.24),
          new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.6, metalness: 0.6 }));
        gp.position.set(gx, 1.8, gz);
        scene.add(gp);
        const gb = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.8),
          new THREE.MeshBasicMaterial({ map: signTexF("首都高", "IN ↑"), fog: false }));
        gb.position.set(gx, 3.4, gz);
        gb.rotation.y = MIR > 0 ? Math.PI / 2 : -Math.PI / 2;
        scene.add(gb);
      }
    }
  });
  {
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(postPts), 3));
    const pm = new THREE.PointsMaterial({
      size: 3.2, sizeAttenuation: false, color: 0xffc060, map: mats.glowTex,
      transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(pg, pm);
    pts.frustumCulled = false;
    scene.add(pts);
    world.rampPostMat = pm;
  }

  /* ---- deck dressing: edge reflectors, gantries ---- */
  {
    const pts: number[] = [];
    for (let z = -HZ + 12; z <= HZ - 12; z += 24)
      pts.push(HX - RW / 2 + 0.4, DECKY + 0.92, z, HX + RW / 2 - 0.4, DECKY + 0.92, z);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    const rm = new THREE.PointsMaterial({
      size: 2.6, sizeAttenuation: false, color: 0xffb055, map: mats.glowTex,
      transparent: true, opacity: 0.85, fog: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const rp = new THREE.Points(rg, rm);
    rp.frustumCulled = false;
    scene.add(rp);
    world.reflMat = rm;
  }
  {
    const gMat = new THREE.MeshStandardMaterial({ color: 0x3a404c, roughness: 0.6, metalness: 0.4 });
    const words = ["箱崎 Hakozaki", "新宿 Shinjuku", "渋谷 Shibuya", "湾岸線 Wangan"];
    for (let z = -900; z <= 900; z += 450) {
      let nearExit = false;
      for (const zr of CONNECT_Z) if (Math.abs(z - zr) < 180) nearExit = true;
      if (nearExit) continue; // keep gantries clear of exit signage
      const g = new THREE.Group();
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6, 0.5), gMat);
        leg.position.set(s * (RW / 2 + 0.6), 3, 0);
        g.add(leg);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(RW + 2.5, 0.75, 0.6), gMat);
      beam.position.y = 6;
      g.add(beam);
      const w1 = words[Math.floor(rrand(rng, 0, words.length)) % words.length];
      const w2 = words[Math.floor(rrand(rng, 0, words.length)) % words.length];
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.6),
        new THREE.MeshBasicMaterial({ map: signTexF(w1, "首都高速 C1") }));
      sign.position.set(-5, 4.7, -0.35);
      sign.rotation.y = Math.PI;
      g.add(sign);
      const sign2 = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.6),
        new THREE.MeshBasicMaterial({ map: signTexF(w2, "首都高速 C1") }));
      sign2.position.set(5, 4.7, 0.35);
      g.add(sign2);
      g.position.set(HX, DECKY, z);
      scene.add(g);
    }
  }

  /* ---- streetlights on deck ---- */
  const lightPts: number[] = [];
  {
    const poleG = new THREE.CylinderGeometry(0.09, 0.12, 7.6, 6);
    const armG = new THREE.BoxGeometry(1.7, 0.09, 0.09);
    const NP = 110;
    const poles = new THREE.InstancedMesh(poleG, mats.pole, NP);
    const arms = new THREE.InstancedMesh(armG, mats.pole, NP);
    const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(),
      SC = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (let z = -HZ + 30; z <= HZ - 30 && n < NP; z += 44) {
      const side = (z / 44) % 2 ? 1 : -1;
      const x = HX + side * (RW / 2 - 0.6);
      V.set(x, DECKY + 3.8, z);
      M.compose(V, Q, SC);
      poles.setMatrixAt(n, M);
      V.set(x - side * 0.8, DECKY + 7.5, z);
      M.compose(V, Q, SC);
      arms.setMatrixAt(n, M);
      lightPts.push(x - side * 1.55, DECKY + 7.45, z);
      n++;
    }
    poles.count = arms.count = n;
    poles.computeBoundingSphere();
    arms.computeBoundingSphere();
    scene.add(poles, arms);
  }
  return { deckLightPts: lightPts };
}

/** Exit HUD helper: nearest exit ahead when driving the deck. */
export function nearestExitAhead(world: WorldData, z: number, headingZ: number) {
  const dir = headingZ >= 0 ? 1 : -1;
  let best: { no: number; name: string; dist: number; z: number } | null = null;
  for (const e of world.exits) {
    const d = (e.z - z) * dir;
    if (d > -10 && d < 420 && (!best || d < best.dist))
      best = { no: e.no, name: e.name, dist: d, z: e.z };
  }
  return best;
}
