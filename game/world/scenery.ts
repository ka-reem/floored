import * as THREE from "three";
import { rrand, rrandi, type Rng } from "../util";
import { makeTex } from "../textures";
import { getCorridor } from "./corridor";
import type { Mats } from "./mats";
import type { WorldData } from "./data";
import type { Terrain } from "./terrain";
import { worldTierCaps } from "../settings";

/* Roadside scenery zones: the stretches of world the corridor passes that are
   neither the town nor the backdrop rings. Before this file the map east of
   the frontage strip — and everything past the town's z range — was bare
   heightfield, so a lap read as "town, then nothing, nothing, nothing, town".
   Each zone below gives a stretch of the lap its own signature so the player
   always knows where on the loop they are, the way a real orbital reads as a
   necklace of districts:

     wrapped z            east (driver's left)          west (driver's right)
     [-1950, -1300]       RIVER: black water, far        —
                          quay lights + reflections,
                          port cranes
     [-1240,  -620]       GROVE: earth embankment        tree line
                          with a tree line on top
     [   60,   880]       INDUSTRY: warehouses, tank     —
                          farm, chimneys, yard lights
     [ 1620,  2000]       BILLBOARD RUN: lit ad boards either side of the deck

   Splice discipline: everything is *defined* at a wrapped z (all rng rolls
   happen once, in wrapped space) and then *emitted* at every copy of that z
   inside the built extent [ZB0, ZB1] — the same rule as the corridor's own
   furniture lattice — so the seam at ±HZ shows identical scenery on both
   sides and the wrap stays invisible (the billboard run and the river head
   both straddle it).

   Budget: everything procedural, merged by material — the whole file adds
   ~10 draw calls and zero asset bytes. Night is the design target (dashcam
   POV): structures are silhouettes, each zone's identity is carried by its
   LIGHTS, and every light here fades by fog + baked-down vertex colour
   rather than stopping (no hard edges, nothing near the blowout ceiling —
   see the realistic-light notes). */

/* ---- zone bounds (wrapped z) ---- */
const RIVER = { z0: -1950, z1: -1300 };
const GROVE = { z0: -1240, z1: -620 };
const INDUSTRY = { z0: 60, z1: 880 };

/** Merge helper: bakes transformed template geometries (and per-part colour)
    into one non-indexed soup, one draw call per material. Templates must be
    uv-consistent within a bucket (they all are — box/cylinder/icosa carry
    uv), or the attribute arrays would fall out of step. */
class Merge {
  pos: number[] = [];
  norm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, color?: THREE.Color) {
    const g = geo.clone().applyMatrix4(m);
    const p = g.attributes.position as THREE.BufferAttribute;
    const n = g.attributes.normal as THREE.BufferAttribute | undefined;
    const u = g.attributes.uv as THREE.BufferAttribute | undefined;
    const push = (k: number) => {
      this.pos.push(p.getX(k), p.getY(k), p.getZ(k));
      if (n) this.norm.push(n.getX(k), n.getY(k), n.getZ(k));
      if (u) this.uv.push(u.getX(k), u.getY(k));
      if (color) this.col.push(color.r, color.g, color.b);
    };
    const idx = g.index;
    if (idx) for (let i = 0; i < idx.count; i++) push(idx.getX(i));
    else for (let i = 0; i < p.count; i++) push(i);
    g.dispose();
  }
  get empty() {
    return this.pos.length === 0;
  }
  geom() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    if (this.norm.length)
      g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.norm), 3));
    else g.computeVertexNormals();
    if (this.uv.length)
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    if (this.col.length)
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    return g;
  }
}

/* ---- billboard ad atlas: four abstract night-sign designs, 2×2 ------------
   Drawn against the grade (see realistic-light): peaks stay near 0.75 of full
   white so the emissive panel keeps its hue instead of clipping, and every
   glow in the artwork is a long-tailed gradient, not a hard disc. */
function adAtlasTex(rng: Rng): THREE.Texture {
  return makeTex(1024, 512, (ctx) => {
    const designs: ((x: number, y: number, w: number, h: number) => void)[] = [
      (x, y, w, h) => {
        // vertical sodium gradient wash + big katakana
        const g = ctx.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, "#3a1404");
        g.addColorStop(1, "#100503");
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "rgba(235,150,60,.9)";
        ctx.font = "bold 120px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("オイル", x + w / 2, y + h / 2 + 20);
        ctx.font = "26px sans-serif";
        ctx.fillStyle = "rgba(220,180,140,.7)";
        ctx.fillText("2 4 時 間 · S E R V I C E", x + w / 2, y + h - 34);
      },
      (x, y, w, h) => {
        // cool blue field, off-centre ring mark
        ctx.fillStyle = "#04101c";
        ctx.fillRect(x, y, w, h);
        const cx = x + w * 0.3, cy = y + h * 0.5;
        const rg = ctx.createRadialGradient(cx, cy, 8, cx, cy, 120);
        rg.addColorStop(0, "rgba(120,190,235,.55)");
        rg.addColorStop(0.35, "rgba(120,190,235,.2)");
        rg.addColorStop(1, "rgba(120,190,235,0)");
        ctx.fillStyle = rg;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(150,210,240,.85)";
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.arc(cx, cy, 62, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(190,220,240,.85)";
        ctx.font = "bold 72px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("湾岸", x + w * 0.52, y + h * 0.48);
        ctx.font = "30px sans-serif";
        ctx.fillStyle = "rgba(140,180,210,.7)";
        ctx.fillText("W A N G A N", x + w * 0.52, y + h * 0.66);
      },
      (x, y, w, h) => {
        // warm diner board: horizontal amber bar + text
        ctx.fillStyle = "#160b04";
        ctx.fillRect(x, y, w, h);
        const g = ctx.createLinearGradient(x, y + h * 0.32, x, y + h * 0.62);
        g.addColorStop(0, "rgba(230,120,30,0)");
        g.addColorStop(0.5, "rgba(230,120,30,.5)");
        g.addColorStop(1, "rgba(230,120,30,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x + 20, y, w - 40, h);
        ctx.fillStyle = "rgba(240,200,150,.9)";
        ctx.font = "bold 96px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("うどん", x + w / 2, y + h * 0.56);
        ctx.font = "28px sans-serif";
        ctx.fillStyle = "rgba(210,150,90,.75)";
        ctx.fillText("次 の 出 口 · N E X T  E X I T", x + w / 2, y + h * 0.82);
      },
      (x, y, w, h) => {
        // magenta hotel sign: skyline bars motif
        ctx.fillStyle = "#12040e";
        ctx.fillRect(x, y, w, h);
        for (let i = 0; i < 9; i++) {
          const bw = 22 + ((i * 37) % 30), bh = 40 + ((i * 61) % 110);
          const bx = x + 30 + i * 50, by = y + h - 26 - bh;
          ctx.fillStyle = `rgba(215,90,170,${0.16 + ((i * 29) % 40) / 100})`;
          ctx.fillRect(bx, by, bw, bh);
        }
        ctx.fillStyle = "rgba(235,140,200,.9)";
        ctx.font = "bold 84px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("ホテル", x + w / 2, y + h * 0.42);
      },
    ];
    // slight per-build shuffle so two seeds don't share an atlas layout
    const order = [0, 1, 2, 3];
    for (let i = order.length - 1; i > 0; i--) {
      const j = rrandi(rng, 0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    order.forEach((d, i) => {
      const x = (i % 2) * 512, y = Math.floor(i / 2) * 256;
      designs[d](x, y, 512, 256);
      // frame line, dim — reads as the board's rim under the floods
      ctx.strokeStyle = "rgba(90,90,100,.8)";
      ctx.lineWidth = 6;
      ctx.strokeRect(x + 3, y + 3, 506, 250);
    });
  });
}

export function buildScenery(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  rng: Rng
) {
  const cor = getCorridor();
  const caps = worldTierCaps();
  const density = Math.min(1, (caps.drawDistScale ?? 1) + 0.25); // mobile-base ≈ 0.9

  /** every built-extent copy of a wrapped z (the splice-duplication rule) */
  const copies = (wz: number) => {
    const out: number[] = [];
    for (const z of [wz - cor.LOOP, wz, wz + cor.LOOP])
      if (z >= cor.ZB0 && z <= cor.ZB1) out.push(z);
    return out;
  };
  /** wrapped z-range clipped into built-extent ranges */
  const rangeCopies = (z0: number, z1: number) => {
    const out: [number, number][] = [];
    for (const off of [-cor.LOOP, 0, cor.LOOP]) {
      const a = Math.max(z0 + off, cor.ZB0), b = Math.min(z1 + off, cor.ZB1);
      if (b > a + 1) out.push([a, b]);
    }
    return out;
  };

  /* ---- shared merged buckets (one draw call each) ---- */
  const struct = new Merge(); // dark steel/concrete: cranes, chimneys, posts, quays
  const shed = new Merge(); // industrial volumes: warehouses, tanks
  const trees = new Merge();
  /** scenery lights: [x, y, z, r, g, b]. Brightness lives in the colour (kept
      ≤ ~0.6 so an additive point can never blow white through the grade); the
      material's opacity stays the day/night handle the engine drives. */
  const lights: number[] = [];
  const lamp = (x: number, y: number, z: number, hex: number, bright: number) => {
    const c = new THREE.Color(hex).multiplyScalar(bright);
    lights.push(x, y, z, c.r, c.g, c.b);
  };

  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(),
    V = new THREE.Vector3(), S = new THREE.Vector3();
  const place = (
    geo: THREE.BufferGeometry, into: Merge,
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number, ry = 0, color?: THREE.Color
  ) => {
    E.set(0, ry, 0);
    Q.setFromEuler(E);
    V.set(x, y, z);
    S.set(sx, sy, sz);
    M.compose(V, Q, S);
    into.add(geo, M, color);
  };

  /* template geometries (baked via Merge — never added to the scene) */
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 10);
  const taperCyl = new THREE.CylinderGeometry(0.62, 1, 1, 8);
  const blob = new THREE.IcosahedronGeometry(1, 0);
  const trunk = new THREE.CylinderGeometry(0.12, 0.2, 1, 5);
  /** dark earth for berms — its own material because the merged berm ribbons
      carry no uv and must not ride a mapped material */
  const earthMat = new THREE.MeshStandardMaterial({ color: 0x0f120e, roughness: 1 });
  const bermRibbon = (
    profile: (z: number) => [number, number, number][], z0: number, z1: number, step: number
  ) => {
    const rows: [number, number, number][][] = [];
    for (let z = z0; z <= z1; z += step) rows.push(profile(z));
    const bp: number[] = [];
    for (let i = 0; i < rows.length - 1; i++)
      for (let k = 0; k < rows[i].length - 1; k++) {
        const q0 = rows[i][k], q1 = rows[i + 1][k], q2 = rows[i + 1][k + 1], q3 = rows[i][k + 1];
        bp.push(...q0, ...q1, ...q2, ...q0, ...q2, ...q3);
      }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bp), 3));
    bg.computeVertexNormals();
    const m = new THREE.Mesh(bg, earthMat);
    m.receiveShadow = true;
    scene.add(m);
  };

  /* ================================ RIVER ================================ */
  /* Black water east of the deck with the far bank's quay lights dragging
     long reflection streaks across it. The corridor's first sweeper bends
     +62 m toward the water through exactly this stretch, so the quay line
     lands square in the windshield band on the way in. The zone's head
     crosses the splice overrun, so every rng roll happens once in wrapped
     space and the results are emitted at each built copy. */
  {
    const NEAR_X = 652, FAR_X = 1058;
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x060a12, roughness: 0.14, metalness: 0.72,
      envMap: mats.envMap, envMapIntensity: 0.5,
    });
    for (const [a, b] of rangeCopies(RIVER.z0, RIVER.z1)) {
      const len = b - a;
      const wg = new THREE.PlaneGeometry(FAR_X - NEAR_X, len);
      wg.rotateX(-Math.PI / 2);
      const water = new THREE.Mesh(wg, waterMat);
      water.position.set((NEAR_X + FAR_X) / 2, 0.045, (a + b) / 2);
      scene.add(water);
      // near bank: a low riprap berm so the water doesn't butt against flat
      // ground; far side: quay wall a hair above the waterline
      bermRibbon((z) => [
        [NEAR_X - 30, 0.05, z], [NEAR_X - 12, 1.8, z], [NEAR_X + 2, 0.05, z],
      ], a, b, 40);
      place(box, struct, FAR_X + 3, 1.1, (a + b) / 2, 7, 2.6, len);
    }
    // quay lights + one long flat streak each, rolled in wrapped space
    const streakM = new Merge();
    const sc = new THREE.Color();
    for (let wz = RIVER.z0 + 20; wz < RIVER.z1 - 12; wz += 46) {
      const warm = rng() < 0.72;
      const jz = rrand(rng, -4, 4);
      const bright = rrand(rng, 0.4, 0.58);
      const sw = rrand(rng, 1.8, 3.2), sl = rrand(rng, 90, 190);
      const sb = rrand(rng, 0.3, 0.5);
      for (const z of copies(wz)) {
        lamp(FAR_X + 2, 7.4, z + jz, warm ? 0xffab55 : 0x9fc4e8, bright);
        const sg = new THREE.PlaneGeometry(sw, sl);
        sg.rotateX(-Math.PI / 2);
        V.set(FAR_X - sl / 2 - 4, 0.09, z + jz);
        S.set(1, 1, 1);
        Q.identity();
        M.compose(V, Q, S);
        sc.set(warm ? 0xff9a44 : 0x86b0dd).multiplyScalar(sb);
        streakM.add(sg, M, sc);
        sg.dispose();
      }
    }
    // container cranes on the far bank: two legs, a raked boom over the
    // water, machine house — pure silhouette with a red tip light
    for (let wz = RIVER.z0 + 90; wz < RIVER.z1 - 60; wz += rrand(rng, 210, 300)) {
      const ch = rrand(rng, 24, 30);
      for (const z of copies(wz)) {
        for (const dz of [-7, 7])
          place(box, struct, FAR_X + 16, ch / 2, z + dz, 1.6, ch, 1.6);
        place(box, struct, FAR_X + 16, ch + 1, z, 3.2, 2.2, 17);
        const boomG = new THREE.BoxGeometry(30, 1.1, 1.3);
        boomG.translate(-15, 0, 0); // pivot at the tower, reach over the water
        boomG.rotateZ(-0.2);
        place(boomG, struct, FAR_X + 15, ch + 1.6, z, 1, 1, 1);
        boomG.dispose();
        place(box, struct, FAR_X + 16, ch - 2.5, z, 4.5, 3.4, 4.5);
        lamp(FAR_X + 16, ch + 3.4, z, 0xff3040, 0.5);
      }
    }
    if (!streakM.empty) {
      const sm = new THREE.Mesh(
        streakM.geom(),
        new THREE.MeshBasicMaterial({
          map: mats.streakTex, vertexColors: true, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
          opacity: 0.85,
        })
      );
      sm.renderOrder = 2;
      world.neonMats.push(sm.material as THREE.Material);
      scene.add(sm);
    }
  }

  /* ================================ GROVE ================================ */
  /* Tree lines close in on both shoulders, the east one riding a low earth
     embankment — after a kilometre of open water the corridor suddenly runs
     through a green cutting, which is the strongest "different place now"
     cue on the lap. Canopies are merged icosa blobs: at night they read as
     the correct thing, a serrated black edge eating the city glow. The zone
     sits deep inside the canonical extent, so no splice copies arise. */
  {
    const canopyC = new THREE.Color();
    const addTree = (x: number, z: number, big: boolean) => {
      const gy = terrain.h(x, z);
      const r = big ? rrand(rng, 3.0, 4.6) : rrand(rng, 2.0, 3.2);
      const hgt = r * rrand(rng, 1.5, 1.9);
      place(trunk, trees, x, gy + hgt / 2, z, 1, hgt, 1, 0, canopyC.set(0x241a12));
      canopyC.set(0x101a12).multiplyScalar(rrand(rng, 0.7, 1.15));
      place(blob, trees, x + rrand(rng, -0.4, 0.4), gy + hgt, z,
        r, r * rrand(rng, 0.75, 0.95), r, rrand(rng, 0, Math.PI), canopyC);
    };
    const [a, b] = [GROVE.z0, GROVE.z1];
    // east embankment: a ribbon swept along the corridor so it tracks the
    // sweeper's exit instead of drifting away from the deck edge
    bermRibbon((z) => {
      const hw = cor.halfWidth(z);
      const p0 = cor.worldOf(z, hw + 7);
      const p1 = cor.worldOf(z, hw + 15);
      const p2 = cor.worldOf(z, hw + 24);
      const g0 = terrain.h(p0.x, p0.z);
      return [
        [p0.x, g0 + 0.1, p0.z], [p1.x, g0 + 2.3, p1.z], [p2.x, g0 + 0.1, p2.z],
      ];
    }, a, b, 20);
    // trees on the embankment crest + a looser second rank behind it
    const nE = Math.round(((b - a) / 16) * density);
    for (let i = 0; i < nE; i++) {
      const z = rrand(rng, a + 6, b - 6);
      const hw = cor.halfWidth(z);
      const lat = hw + (rng() < 0.6 ? rrand(rng, 12, 18) : rrand(rng, 24, 44));
      const p = cor.worldOf(z, lat);
      addTree(p.x, p.z, rng() < 0.4);
    }
    // west tree line, denser and nearer — it strobes past the right window
    const nW = Math.round(((b - a) / 11) * density);
    for (let i = 0; i < nW; i++) {
      const z = rrand(rng, a + 6, b - 6);
      const hw = cor.halfWidth(z);
      const lat = -(hw + rrand(rng, 8, 34));
      const p = cor.worldOf(z, lat);
      addTree(p.x, p.z, rng() < 0.55);
    }
  }

  /* ============================== INDUSTRY =============================== */
  /* A working yard east of the frontage strip on the run up to the tunnel:
     warehouse slabs with sodium wall-packs, a tank farm, two chimneys with
     red beacons, high-mast yard lights along the fence line. Ends before the
     bypass viaduct takes over the east side at the tunnel mouth. Deep inside
     the canonical extent — no splice copies. */
  {
    const [a, b] = [INDUSTRY.z0, INDUSTRY.z1];
    // warehouses along x ≈ 690–780
    let z = a + 40;
    while (z < b - 90) {
      const len = rrand(rng, 46, 74), dep = rrand(rng, 24, 34), hgt = rrand(rng, 8.5, 13);
      const x = rrand(rng, 690, 780);
      const gy = terrain.h(x, z + len / 2);
      place(box, shed, x, gy + hgt / 2, z + len / 2, dep, hgt, len);
      // shallow roof monitor ridge
      place(box, shed, x, gy + hgt + 0.8, z + len / 2, dep * 0.35, 1.6, len * 0.8);
      world.colliders.addAabb({
        x0: x - dep / 2, x1: x + dep / 2, z0: z, z1: z + len,
        y0: gy - 1, y1: gy + hgt,
      });
      // sodium wall-packs down the road-facing wall
      for (let wz = z + 8; wz < z + len - 6; wz += 16)
        lamp(x - dep / 2 - 0.4, gy + hgt - 1.6, wz, 0xff9e42, rrand(rng, 0.34, 0.46));
      z += len + rrand(rng, 26, 70);
    }
    // tank farm in the back half of the zone
    let tz = a + (b - a) * 0.52;
    for (let i = 0; i < 5 && tz < b - 30; i++) {
      const r = rrand(rng, 8, 13), th = rrand(rng, 9, 13);
      const x = rrand(rng, 850, 940);
      const gy = terrain.h(x, tz);
      place(cyl, shed, x, gy + th / 2, tz, r, th, r);
      place(cyl, struct, x, gy + th + 0.35, tz, r * 0.99, 0.7, r * 0.99);
      world.colliders.addAabb({
        x0: x - r, x1: x + r, z0: tz - r, z1: tz + r, y0: gy - 1, y1: gy + th,
      });
      if (i % 2 === 0) lamp(x, gy + th + 1.4, tz, 0xffb469, 0.36);
      tz += rrand(rng, 34, 46);
    }
    // chimneys, the zone's landmark against the sky
    for (const [cx, czf, ch] of [[905, 0.22, 58], [872, 0.34, 44]] as const) {
      const cz = a + (b - a) * czf;
      const gy = terrain.h(cx, cz);
      place(taperCyl, struct, cx, gy + ch / 2, cz, 3.1, ch, 3.1);
      lamp(cx, gy + ch + 1.5, cz, 0xff3040, 0.52);
      lamp(cx, gy + ch * 0.62, cz, 0xff3040, 0.3);
    }
    // high-mast yard lights along the fence line nearest the road
    for (let yz = a + 30; yz < b - 20; yz += 120) {
      const x = 648, gy = terrain.h(x, yz);
      place(cyl, struct, x, gy + 6.5, yz, 0.16, 13, 0.16);
      lamp(x, gy + 13.2, yz, 0xffab55, 0.5);
    }
  }

  /* =========================== BILLBOARD RUN ============================= */
  /* Lit ad boards flanking the deck on the long straight from the toll gates
     to the seam (and its mirror-image overrun behind the spawn). The panels
     are emissive against the grade — peak artwork luma sits near 0.75 so the
     boards glow in colour instead of clipping white. */
  {
    const atlas = adAtlasTex(rng);
    const panelMat = new THREE.MeshStandardMaterial({
      map: atlas, emissive: 0xffffff, emissiveMap: atlas, emissiveIntensity: 0.8,
      roughness: 0.85, metalness: 0,
    });
    const panelM = new Merge();
    const panelG = new THREE.PlaneGeometry(1, 1);
    const boards: [number, number][] = [
      // [wrapped z, side] — side +1 = east (driver's left)
      [1655, 1], [1748, -1], [1862, 1], [1956, -1],
      // a pair on the western shoulder announcing the town from the south
      [-1985, -1], [-1902, -1],
    ];
    boards.forEach(([wz, side], bi) => {
      const design = bi % 4;
      for (const z of copies(wz)) {
        const hw = cor.halfWidth(z);
        const p = cor.worldOf(z, side * (hw + 7.5));
        const pose = cor.pose(z);
        const gy = terrain.h(p.x, p.z);
        const cy = p.y + 6.2; // panel centre rides above parapet height
        const W = 11, H = 5.4;
        // face oncoming traffic, canted a touch toward the deck
        const ry = pose.h + Math.PI - side * 0.18;
        E.set(0, ry, 0);
        Q.setFromEuler(E);
        V.set(p.x, cy, p.z);
        S.set(W, H, 1);
        M.compose(V, Q, S);
        const pg = panelG.clone();
        const u = pg.attributes.uv as THREE.BufferAttribute;
        for (let i = 0; i < u.count; i++)
          u.setXY(
            i,
            (design % 2) * 0.5 + u.getX(i) * 0.5,
            design < 2 ? 0.5 + u.getY(i) * 0.5 : u.getY(i) * 0.5
          );
        panelM.add(pg, M);
        pg.dispose();
        // back skin so the mirror never sees through the artwork
        const bk = new THREE.PlaneGeometry(1, 1);
        bk.rotateY(Math.PI);
        M.compose(V, Q, S); // Q/V/S still hold the panel pose
        struct.add(bk, M);
        bk.dispose();
        // monopole + head frame
        place(cyl, struct, p.x, gy + (cy - H / 2 - gy) / 2, p.z,
          0.42, cy - H / 2 - gy, 0.42);
        place(box, struct, p.x, cy - H / 2 - 0.4, p.z, 3.2, 0.8, 0.9, ry);
        world.colliders.addAabb({
          x0: p.x - 0.8, x1: p.x + 0.8, z0: p.z - 0.8, z1: p.z + 0.8,
          y0: gy - 1, y1: cy + H / 2,
        });
        /* two flood heads over the top edge — dim: they only *imply* the
           fixture, the panel's own emissive is the light. The panel's local
           +x axis in world space is (cos ry, 0, -sin ry). */
        const ax = Math.cos(ry), az = -Math.sin(ry);
        for (const s of [-0.36, 0.36])
          lamp(p.x + ax * s * W, cy + H / 2 + 0.5, p.z + az * s * W, 0xcfe0f5, 0.28);
      }
    });
    panelG.dispose();
    if (!panelM.empty) scene.add(new THREE.Mesh(panelM.geom(), panelMat));
  }

  /* ---- materialise the shared buckets ---- */
  if (!struct.empty) {
    const m = new THREE.Mesh(
      struct.geom(),
      new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.8, metalness: 0.25 })
    );
    m.castShadow = true;
    scene.add(m);
  }
  if (!shed.empty) {
    const m = new THREE.Mesh(
      shed.geom(),
      new THREE.MeshStandardMaterial({ color: 0x232830, roughness: 0.85, metalness: 0.1 })
    );
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
  if (!trees.empty) {
    const m = new THREE.Mesh(
      trees.geom(),
      new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1 })
    );
    m.castShadow = true;
    scene.add(m);
  }
  if (lights.length) {
    const n = lights.length / 6;
    const p = new Float32Array(n * 3), c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      p[i * 3] = lights[i * 6];
      p[i * 3 + 1] = lights[i * 6 + 1];
      p[i * 3 + 2] = lights[i * 6 + 2];
      c[i * 3] = lights[i * 6 + 3];
      c[i * 3 + 1] = lights[i * 6 + 4];
      c[i * 3 + 2] = lights[i * 6 + 5];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    const pm = new THREE.PointsMaterial({
      size: 4.5, sizeAttenuation: false, map: mats.glowTex, vertexColors: true,
      transparent: true, opacity: 1, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    /* Day/night: the engine drives every neonMats opacity; brightness is
       baked into the vertex colours so full opacity at night still can't
       blow out. Fog stays ON — it is what makes a quay light 400 m out sink
       toward the horizon instead of hanging as a hard dot (fade, not stop). */
    world.neonMats.push(pm);
    scene.add(new THREE.Points(g, pm));
  }

  box.dispose();
  cyl.dispose();
  taperCyl.dispose();
  blob.dispose();
  trunk.dispose();
}
