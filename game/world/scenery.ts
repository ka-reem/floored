import * as THREE from "three";
import { mulberry32, rrand, rrandi, type Rng } from "../util";
import { makeTex, neonTexF } from "../textures";
import { getCorridor, roadSeed, PITCH, PHASE } from "./corridor";
import type { Mats } from "./mats";
import type { WorldData } from "./data";
import type { Terrain } from "./terrain";
import { worldTierCaps } from "../settings";
import { buildRoadside } from "./roadside";

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
     [  900,  1580]       FRONTAGE TREES: loose tree line either shoulder —
                          the long bare run between the industrial yard and
                          the billboard run, otherwise the emptiest kilometre
                          on the lap
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
const FRONTAGE = { z0: 900, z1: 1580 };

/* ---- second-pass districts (the map-transform lane) ----------------------
   The zones above were the first pass, and the BEFORE contact sheet (40
   dashcam stations, night) says exactly what they missed: everything lives
   150–500 m out, where fog + the POV black crush erase unlit geometry, so
   from the deck the lap still reads as bare parapet against blackness. The
   districts below all sit INSIDE ~120 m of the pavement edge — the band the
   dashcam can actually see — and each one leads with its lights.

     wrapped z            what stands there (east strip unless noted)
     [-1950, -1300]       WHARF: container yard + straddle cranes + sodium
                          yard masts on the NEAR bank, in front of the water
     [ -560,    40]       EASTSIDE: mid-rise lit-window district on the east
                          frontage strip — the town stretch becomes a canyon
                          with city on BOTH sides
     [   60,   830]       FOREGROUND INDUSTRY: wall-packed warehouses, pipe
                          racks and a lit flare stack at the fence line
                          (clipped at 830: the bypass viaduct owns the east
                          side from its z≈844 crossing to the 1580 merge)
     [ 1580,  2000]       NEON CANYON: densified board run + dark mid-rise
                          shells with lit windows, neon and roof clutter on
                          both sides; straddles the splice via copies()

   Master switch FX_DISTRICTS; density rides TierCaps.districts. All of it
   draws from a FORKED rng stream (mulberry32 of the road seed), never from
   the shared world stream — same-seed worlds keep every existing roll. */
const FX_DISTRICTS = true;
const WHARF = { z0: -1950, z1: -1300 };
const EASTSIDE = { z0: -560, z1: 40 };
const FOREYARD = { z0: 60, z1: 830 };
const CANYON = { z0: 1580, z1: 2000 };

/** Merge helper: bakes transformed template geometries (and per-part colour)
    into one non-indexed soup, one draw call per material. Templates must be
    uv-consistent within a bucket (they all are — box/cylinder/icosa carry
    uv), or the attribute arrays would fall out of step. Exported for
    roadside.ts, which builds by the same rules. */
export class Merge {
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
  /** Wide soft halos behind the key fixtures — a SECOND cloud at ~3x the
      point size and a third of the level, so a yard mast or wall-pack reads
      as a glow with a core rather than a lone crushed dot. Widening, not
      brightening: the POV chain's black floor eats a small dim dot whole,
      while the same energy spread over more pixels survives it (the
      realistic-light rule). One extra draw call for the lot. */
  const halos: number[] = [];
  const lamp = (x: number, y: number, z: number, hex: number, bright: number, halo = false) => {
    const c = new THREE.Color(hex).multiplyScalar(bright);
    lights.push(x, y, z, c.r, c.g, c.b);
    if (halo) {
      c.multiplyScalar(0.38);
      halos.push(x, y, z, c.r, c.g, c.b);
    }
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

  /** True within a few metres of the streetlight lattice (PITCH.light,
      phased — see corridor.ts) — where a canopy is close enough to a sodium
      head to plausibly catch its rim rather than sit flat black. */
  const nearLamp = (z: number) => {
    const ph = PHASE.light ?? 0;
    let d = ((z - ph) % PITCH.light + PITCH.light) % PITCH.light;
    if (d > PITCH.light / 2) d = PITCH.light - d;
    return d < 9;
  };
  const canopyC = new THREE.Color();
  /** Instanced-by-merge tree: a cone-ish trunk plus one or two canopy blobs.
      `warm` washes the canopy toward sodium instead of the flat night green —
      cheap stand-in for a rim light: no extra draw call, still fades with the
      zone's own fog like everything else here (never a hard-lit cutout). */
  const addTree = (x: number, z: number, big: boolean, warm = false) => {
    const gy = terrain.h(x, z);
    const r = big ? rrand(rng, 3.0, 4.6) : rrand(rng, 2.0, 3.2);
    const hgt = r * rrand(rng, 1.5, 1.9);
    place(trunk, trees, x, gy + hgt / 2, z, 1, hgt, 1, 0, canopyC.set(0x241a12));
    canopyC.set(warm ? 0x3a2c14 : 0x101a12).multiplyScalar(rrand(rng, 0.7, 1.15));
    place(blob, trees, x + rrand(rng, -0.4, 0.4), gy + hgt, z,
      r, r * rrand(rng, 0.75, 0.95), r, rrand(rng, 0, Math.PI), canopyC);
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
        lamp(FAR_X + 2, 7.4, z + jz, warm ? 0xffab55 : 0x9fc4e8, bright, true);
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
      addTree(p.x, p.z, rng() < 0.4, nearLamp(z));
    }
    // west tree line, denser and nearer — it strobes past the right window
    const nW = Math.round(((b - a) / 11) * density);
    for (let i = 0; i < nW; i++) {
      const z = rrand(rng, a + 6, b - 6);
      const hw = cor.halfWidth(z);
      const lat = -(hw + rrand(rng, 8, 34));
      const p = cor.worldOf(z, lat);
      addTree(p.x, p.z, rng() < 0.55, nearLamp(z));
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
        lamp(x - dep / 2 - 0.4, gy + hgt - 1.6, wz, 0xff9e42, rrand(rng, 0.34, 0.46), true);
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
      lamp(x, gy + 13.2, yz, 0xffab55, 0.5, true);
    }
  }

  /* ============================= FRONTAGE TREES =========================== */
  /* The gap between the industrial yard and the billboard run used to be the
     bare kilometre of the lap — nothing at the edge for 680 m past the toll
     gates. A looser, unribboned tree line either shoulder (no berm — the
     ground here is already close to grade) keeps the "trees at speed" cue
     going without inventing a whole new district. Skips anywhere the seeded
     tunnel or toll plaza actually lands (the east tube's hard window can
     reach into this z-range on some seeds — see rollRoad in corridor.ts) the
     way decals.ts skips scattered props over the same hazards. Deep inside
     the canonical extent — no splice copies. */
  {
    const [a, b] = [FRONTAGE.z0, FRONTAGE.z1];
    const n = Math.round(((b - a) / 14) * density);
    for (let i = 0; i < n; i++) {
      const z = rrand(rng, a + 4, b - 4);
      if (cor.inTunnel(z, 20) || cor.inToll(z)) continue;
      const hw = cor.halfWidth(z);
      const side = rng() < 0.5 ? 1 : -1;
      const lat = side * (hw + rrand(rng, 9, 30));
      const p = cor.worldOf(z, lat);
      addTree(p.x, p.z, rng() < 0.35, nearLamp(z));
    }
    /* glow pockets: a handful of small, distant light clusters out past the
       tree line — the suggestion of a facility the road never actually
       reaches. Zero geometry, zero colliders: three more points pushed into
       the same merged cloud the whole file already shares, so the cost is
       nothing (see the file-level budget note at the top). Brightness capped
       the same way every other light here is — fades with fog, never a
       blown-white dot. */
    const nGlow = Math.round(((b - a) / 220) * density);
    for (let i = 0; i < nGlow; i++) {
      const z = rrand(rng, a + 20, b - 20);
      if (cor.inTunnel(z, 20) || cor.inToll(z)) continue;
      const hw = cor.halfWidth(z);
      const side = rng() < 0.5 ? 1 : -1;
      const lat = side * (hw + rrand(rng, 45, 90));
      const p = cor.worldOf(z, lat);
      const gy = terrain.h(p.x, p.z);
      const n = rrandi(rng, 3, 6);
      for (let k = 0; k < n; k++)
        lamp(
          p.x + rrand(rng, -14, 14), gy + rrand(rng, 2, 9), p.z + rrand(rng, -14, 14),
          rng() < 0.6 ? 0xffab55 : 0x9fc4e8, rrand(rng, 0.3, 0.45)
        );
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

  /* ========================= TRANSFORM DISTRICTS ========================= */
  /* Second pass — see the FX_DISTRICTS note at the top of the file. All rng
     here comes from a stream FORKED off the road seed: the shared world
     stream above is already spent in a fixed order, and one extra draw
     inserted mid-file would reshuffle every district after it on every seed.
     A fork keeps the first-pass world byte-identical and is still one world
     per seed. */
  const dLevel = Math.max(0, Math.min(1, caps.districts ?? 1));
  if (FX_DISTRICTS && dLevel > 0) {
    const rng2 = mulberry32((roadSeed() ^ 0x9d2c5681) >>> 0);
    /** unit cylinder whose length axis is local Z — for horizontal pipes
        (place() only yaws, so a lying pipe has to lie in its template) */
    const pipe = new THREE.CylinderGeometry(1, 1, 1, 6);
    pipe.rotateX(Math.PI / 2);
    /** Pooled ground light under the yard fixtures — merged flat quads of
        the radial glow map, additive, level baked into vertex colour. Dots
        alone do not read as a WORKING yard from 100 m out through the POV
        crush; an area of sodium on the ground does. One draw call for every
        pool in the pass; fog fades them like everything else here. */
    const glowPools = new Merge();
    const poolG = new THREE.PlaneGeometry(1, 1);
    poolG.rotateX(-Math.PI / 2);
    const poolC = new THREE.Color();
    const pool = (x: number, y: number, z: number, w: number, l: number, hex: number, k: number) => {
      TV.set(x, y, z);
      TS.set(w, 1, l);
      TQ.identity();
      TM.compose(TV, TQ, TS);
      poolC.set(hex).multiplyScalar(k);
      glowPools.add(poolG.clone(), TM, poolC);
    };
    /** shared vertex-coloured bucket: containers, tarps, coloured shells */
    const colored = new Merge();
    const colC = new THREE.Color();
    /** tower instances, one list per window-material variant */
    const towers: THREE.Matrix4[][] = [[], [], []];
    const TM = new THREE.Matrix4(), TQ = new THREE.Quaternion(), TE = new THREE.Euler(),
      TV = new THREE.Vector3(), TS = new THREE.Vector3();
    /** One lit-window building shell, town-mesh idiom (unit box scaled; the
        window map stretches with the box exactly the way the town's does).
        Returns its top, for beacons/clutter. */
    const tower = (
      x: number, z: number, w: number, d: number, hgt: number, ry: number
    ) => {
      const gy = terrain.h(x, z);
      TE.set(0, ry, 0);
      TQ.setFromEuler(TE);
      TV.set(x, gy + hgt / 2 - 0.6, z);
      TS.set(w, hgt + 0.6, d);
      TM.compose(TV, TQ, TS);
      towers[rrandi(rng2, 0, 2)].push(TM.clone());
      world.colliders.addAabb({
        x0: x - w / 2 - 0.3, x1: x + w / 2 + 0.3,
        z0: z - d / 2 - 0.3, z1: z + d / 2 + 0.3,
        y0: gy - 1, y1: gy + hgt,
      });
      return gy + hgt;
    };
    /** rooftop dressing: tank, AC hut, a parapet lip — the clutter that
        stops a roofline reading as an extruded rectangle */
    const roofStuff = (x: number, z: number, top: number, w: number, d: number) => {
      if (rng2() < 0.55)
        place(cyl, struct, x + rrand(rng2, -w / 4, w / 4), top + 1.1,
          z + rrand(rng2, -d / 4, d / 4), 1.3, 2.2, 1.3);
      if (rng2() < 0.5)
        place(box, struct, x + rrand(rng2, -w / 4, w / 4), top + 0.8,
          z + rrand(rng2, -d / 4, d / 4), rrand(rng2, 1.6, 3), 1.6, rrand(rng2, 1.6, 2.6));
    };
    /** merged neon boards, one bucket per material so the whole canyon's
        signage is 4 draw calls however many boards hang */
    const NEON: readonly (readonly [string, number])[] = [
      ["居酒屋", 8], ["カラオケ", 315], ["ホテル", 195], ["パチンコ", 268],
      ["湾岸", 178], // the canyon gate's own board — picked explicitly, below
    ];
    const neonBuckets = NEON.map(() => new Merge());
    const neonPlane = new THREE.PlaneGeometry(1, 1);
    const neonBoard = (
      x: number, y: number, z: number, wd: number, ht: number, ry: number,
      pick?: number
    ) => {
      const k = pick ?? rrandi(rng2, 0, NEON.length - 2);
      TE.set(0, ry, 0);
      TQ.setFromEuler(TE);
      TV.set(x, y, z);
      TS.set(wd, ht, 1);
      TM.compose(TV, TQ, TS);
      neonBuckets[k].add(neonPlane.clone(), TM);
    };

    /* ------------------------------ WHARF ------------------------------ */
    /* The near bank: the first pass put the whole port 400+ m out on the far
       quay, which the night fog erases. This yard sits on the strip between
       the east frontage line and the water (x ≈ 566–648), so the container
       silhouettes and the sodium yard masts stand in the windshield band.
       The zone's head crosses the splice overrun — every roll happens once
       in wrapped space, emitted at each built copy. */
    {
      const CONT: readonly number[] = [0x30424a, 0x4a3a2c, 0x35452f, 0x413138, 0x2c3644];
      // container blocks every ~34 m, rolled in wrapped space
      for (let wz = WHARF.z0 + 16; wz < WHARF.z1 - 12; wz += rrand(rng2, 26, 44)) {
        if (rng2() > 0.85 * dLevel + 0.1) continue;
        const x = rrand(rng2, 574, 620);
        const rows = rrandi(rng2, 1, 2), high = rrandi(rng2, 1, 3);
        const len = rrand(rng2, 9, 13), ry = rrand(rng2, -0.08, 0.08);
        const stack: [number, number, number][] = [];
        for (let r = 0; r < rows; r++)
          for (let hh = 0; hh < (r === 0 ? high : Math.max(1, high - 1)); hh++)
            stack.push([x + r * 3.1, hh, wz]);
        for (const z of copies(wz)) {
          const gy = terrain.h(x, z);
          for (const [sx, hh] of stack) {
            /* baked warm floodlight: the bucket renders unlit (see the
               material note at the bucket's mesh), so the colour IS the
               night read — sodium-washed, sitting near 0.3 luma, the level
               a yard under high-mast flood actually shows */
            colC.set(CONT[rrandi(rng2, 0, CONT.length - 1)]);
            const k = rrand(rng2, 0.9, 1.25);
            colC.setRGB(
              Math.min(1, colC.r * 1.75 * k),
              Math.min(1, colC.g * 1.35 * k),
              colC.b * 0.85 * k
            );
            place(box, colored, sx, gy + 1.3 + hh * 2.6, z, 2.9, 2.55, len, ry, colC);
          }
          world.colliders.addAabb({
            x0: x - 1.6, x1: x + rows * 3.1 + 1.6, z0: z - len / 2 - 0.4,
            z1: z + len / 2 + 0.4, y0: gy - 1, y1: gy + high * 2.6,
          });
        }
      }
      // straddle carriers over the stacks: two portal legs + a machine head,
      // a working silhouette between the road and the water
      for (let wz = WHARF.z0 + 120; wz < WHARF.z1 - 90; wz += rrand(rng2, 240, 330)) {
        const x = rrand(rng2, 586, 616), ch = rrand(rng2, 13, 16);
        for (const z of copies(wz)) {
          const gy = terrain.h(x, z);
          for (const dz of [-4.4, 4.4]) {
            place(box, struct, x - 4.6, gy + ch / 2, z + dz, 0.9, ch, 0.9);
            place(box, struct, x + 4.6, gy + ch / 2, z + dz, 0.9, ch, 0.9);
          }
          place(box, struct, x, gy + ch + 0.8, z, 11.4, 1.7, 10.4);
          place(box, struct, x, gy + ch - 1.6, z, 3.4, 2.6, 3.2);
          lamp(x, gy + ch + 2.1, z, 0xff3040, 0.5);
          for (const dz of [-4.2, 4.2])
            lamp(x, gy + ch - 0.4, z + dz, 0xffab55, 0.4, true);
          world.colliders.addAabb({
            x0: x - 5.3, x1: x + 5.3, z0: z - 5.2, z1: z + 5.2,
            y0: gy - 1, y1: gy + ch + 2,
          });
        }
      }
      // sodium yard masts on the frontage line — the light rhythm that says
      // "working port" from the deck; jittered off the streetlight lattice
      for (let wz = WHARF.z0 + 40; wz < WHARF.z1 - 20; wz += 105) {
        const x = 568, jz = rrand(rng2, -8, 8);
        for (const z of copies(wz)) {
          const gy = terrain.h(x, z + jz);
          place(cyl, struct, x, gy + 8, z + jz, 0.17, 16, 0.17);
          place(box, struct, x, gy + 15.6, z + jz, 2.6, 0.24, 0.24);
          for (const dx of [-1.1, 1.1])
            lamp(x + dx, gy + 15.4, z + jz, 0xffab55, 0.55, true);
          // the pooled throw across the yard, biased toward the stacks
          pool(x + 10, gy + 0.14, z + jz, 42, 28, 0xff9a44, 0.44);
        }
      }
      // near-bank quay string + its own reflection streaks running east into
      // the water (the far bank's run west; both fade with fog)
      const streak2 = new Merge();
      const s2c = new THREE.Color();
      for (let wz = WHARF.z0 + 30; wz < WHARF.z1 - 16; wz += 52) {
        const jz = rrand(rng2, -6, 6);
        const bright = rrand(rng2, 0.42, 0.58);
        const sw = rrand(rng2, 1.6, 2.8), sl = rrand(rng2, 60, 130);
        for (const z of copies(wz)) {
          lamp(650, 4.6, z + jz, 0xffc270, bright, true);
          const sg = new THREE.PlaneGeometry(sw, sl);
          sg.rotateX(-Math.PI / 2);
          sg.rotateY(Math.PI / 2);
          TV.set(656 + sl / 2, 0.09, z + jz);
          TS.set(1, 1, 1);
          TQ.identity();
          TM.compose(TV, TQ, TS);
          s2c.set(0xff9a44).multiplyScalar(bright * 0.75);
          streak2.add(sg, TM, s2c);
          sg.dispose();
        }
      }
      if (!streak2.empty) {
        const sm = new THREE.Mesh(
          streak2.geom(),
          new THREE.MeshBasicMaterial({
            map: mats.streakTex, vertexColors: true, transparent: true,
            blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
            opacity: 0.8,
          })
        );
        sm.renderOrder = 2;
        world.neonMats.push(sm.material as THREE.Material);
        scene.add(sm);
      }
    }

    /* ----------------------------- EASTSIDE ---------------------------- */
    /* The town stretch is the one place the lap already lives — but only to
       the west, 200 m out. This district stands a mid-rise rank on the east
       frontage strip, 50–140 m from the pavement edge, so through the town
       window the road runs between TWO lit skylines. Near row sits low
       (roofs riding just over the parapet line — rooftop clutter reading
       across it is the mission's own ask), far row goes to 48 m. */
    {
      /* The east frontage road (roadnet.ts, x = EFRONT_X = 565, ±5.5 m plus
         sidewalk) runs through this strip for z ∈ [−408, 408] — the near
         rank stands between it and the deck, the far rank past it
         (x 585–645), and neither footprint may clip the carriageway
         (west road edge ≈ 557). The near rank hugs the expressway the way
         the canyon's shells do — facades from ~8 m outside the parapet —
         because the canyon is the proof: at 45 m+ a lit window grid reads
         as speckle, at 20–40 m it reads as a building. */
      const n = Math.round(38 * dLevel);
      for (let i = 0; i < n; i++) {
        const z = rrand(rng2, EASTSIDE.z0 + 8, EASTSIDE.z1 - 8);
        const near = rng2() < 0.5;
        const w = near ? rrand(rng2, 8, 13) : rrand(rng2, 10, 20);
        const d = rrand(rng2, 9, 16);
        const x = near ? rrand(rng2, 526, 542 - w / 2) : rrand(rng2, 573 + w / 2, 645);
        /* near rank 16 m up minimum: from the deck (camera ≈ y 11) the
           parapet hides everything under ~10 m at this range, so a 13 m
           shell showed three metres of itself — the windows have to START
           above the parapet sightline to read at all */
        const hgt = near ? rrand(rng2, 16, 30) : rrand(rng2, 18, 48);
        // the near rank stays axis-true so its road-facing neon can hang
        // flush on the facade; jitter is for the far rank only
        const ry = near ? 0 : rrand(rng2, -0.1, 0.1);
        const top = tower(x, z, w, d, hgt, ry);
        roofStuff(x, z, top, w, d);
        if (hgt > 34) lamp(x, top + 1.2, z, 0xff3040, 0.5);
        if (near && rng2() < 0.5)
          neonBoard(x - w / 2 - 0.25, top - rrand(rng2, 3, Math.max(4, hgt - 6)), z,
            rrand(rng2, 5, 8), rrand(rng2, 1.9, 2.6), -Math.PI / 2);
      }
    }

    /* ------------------------ FOREGROUND INDUSTRY ---------------------- */
    /* Pulls the first-pass yard's identity (which lives at x 690–940, out of
       night range) up to the fence line the dashcam can see. Clipped at
       z 830 — the bypass viaduct owns the east side from its crossing to the
       merge. The high-mast pair highway.ts plants at z 462/780 stands in the
       same strip; these lamps are all sodium so the masts' cool white stays
       the junction cue. */
    {
      let wz = FOREYARD.z0 + rrand(rng2, 10, 40);
      while (wz < FOREYARD.z1 - 40) {
        if (cor.inTunnel(wz, 20)) { wz += 60; continue; }
        const kind = rng2();
        // 586+: east of the frontage carriageway's sidewalk for z ≤ 408
        const x = rrand(rng2, 586, 640);
        const gy = terrain.h(x, wz);
        if (kind < 0.5) {
          // low warehouse with sodium wall-packs facing the road
          const len = rrand(rng2, 22, 40), dep = rrand(rng2, 14, 22),
            hgt = rrand(rng2, 6.5, 9.5);
          place(box, shed, x, gy + hgt / 2, wz + len / 2, dep, hgt, len);
          place(box, shed, x, gy + hgt + 0.6, wz + len / 2, dep * 0.4, 1.2, len * 0.7);
          for (let lz = wz + 6; lz < wz + len - 4; lz += 12) {
            lamp(x - dep / 2 - 0.4, gy + hgt - 1.1, lz, 0xff9e42, rrand(rng2, 0.4, 0.52), true);
            pool(x - dep / 2 - 3.4, gy + 0.14, lz, 11, 8, 0xff9a44, 0.3);
          }
          world.colliders.addAabb({
            x0: x - dep / 2, x1: x + dep / 2, z0: wz, z1: wz + len,
            y0: gy - 1, y1: gy + hgt,
          });
          wz += len + rrand(rng2, 30, 70);
        } else if (kind < 0.8) {
          // pipe rack: two rails of pipes on portal frames, running with the
          // road — industrial texture with almost no faces to light
          const len = rrand(rng2, 40, 70);
          for (let pz = wz; pz < wz + len; pz += 10)
            for (const dx of [-1.5, 1.5])
              place(box, struct, x + dx, gy + 2.6, pz, 0.3, 5.2, 0.3);
          for (const py of [4.1, 5.1])
            for (const dx of [-0.9, 0, 0.9])
              place(pipe, struct, x + dx, gy + py, wz + len / 2, 0.18, 0.18, len);
          lamp(x, gy + 5.9, wz + rrand(rng2, 8, len - 8), 0xffab55, 0.45, true);
          world.colliders.addAabb({
            x0: x - 2, x1: x + 2, z0: wz, z1: wz + len, y0: gy - 1, y1: gy + 5.8,
          });
          wz += len + rrand(rng2, 26, 60);
        } else {
          // flare stack: the yard's night landmark — tall taper, a warm glow
          // cluster at the tip (steady, fog-faded, never a hard flame card)
          const ch = rrand(rng2, 26, 34);
          place(taperCyl, struct, x, gy + ch / 2, wz, 1.4, ch, 1.4);
          place(cyl, struct, x, gy + ch + 0.6, wz, 0.5, 1.2, 0.5);
          lamp(x, gy + ch + 1.6, wz, 0xffa040, 0.58, true);
          lamp(x + 0.8, gy + ch + 2.4, wz + 0.4, 0xff7a28, 0.4);
          lamp(x - 0.6, gy + ch + 3.0, wz - 0.3, 0xff8a30, 0.3);
          lamp(x, gy + ch * 0.55, wz, 0xff3040, 0.34);
          world.colliders.addAabb({
            x0: x - 1.6, x1: x + 1.6, z0: wz - 1.6, z1: wz + 1.6,
            y0: gy - 1, y1: gy + ch,
          });
          wz += rrand(rng2, 60, 110);
        }
      }
    }

    /* --------------------------- NEON CANYON --------------------------- */
    /* The post-toll straight, both sides, straddling the seam: the lap's
       colour burst. Yard-spaced ad boards (a second atlas from the forked
       stream), dark mid-rise shells whose lit windows and merged neon carry
       the district, roof beacons on the tall ones. Everything rolled in
       wrapped space and emitted at every built copy so the splice shows the
       identical canyon on both sides. */
    {
      // extra boards between the first pass's four (those sit at 1655/1748/
      // 1862/1956); keep 30 m clear of each and alternate sides
      const HAVE = [1655, 1748, 1862, 1956];
      const atlas2 = adAtlasTex(rng2);
      const panelMat2 = new THREE.MeshStandardMaterial({
        map: atlas2, emissive: 0xffffff, emissiveMap: atlas2, emissiveIntensity: 0.8,
        roughness: 0.85, metalness: 0,
      });
      const panelM2 = new Merge();
      const panelG2 = new THREE.PlaneGeometry(1, 1);
      let bi = 0;
      for (let wz = CANYON.z0 + 14; wz < CANYON.z1 - 10; wz += rrand(rng2, 55, 85)) {
        if (HAVE.some((h) => Math.abs(wz - h) < 30)) continue;
        if (rng2() > 0.9 * dLevel + 0.1) continue;
        const side = bi++ % 2 ? -1 : 1;
        const design = rrandi(rng2, 0, 3);
        const W = rrand(rng2, 9, 12), H = W * 0.49;
        for (const z of copies(wz)) {
          const hw = cor.halfWidth(z);
          const p = cor.worldOf(z, side * (hw + rrand(rng2, 7, 10)));
          const pose = cor.pose(z);
          const gy = terrain.h(p.x, p.z);
          const cy = p.y + rrand(rng2, 5.6, 7.4);
          const ry = pose.h + Math.PI - side * 0.18;
          TE.set(0, ry, 0);
          TQ.setFromEuler(TE);
          TV.set(p.x, cy, p.z);
          TS.set(W, H, 1);
          TM.compose(TV, TQ, TS);
          const pg = panelG2.clone();
          const u = pg.attributes.uv as THREE.BufferAttribute;
          for (let i = 0; i < u.count; i++)
            u.setXY(
              i,
              (design % 2) * 0.5 + u.getX(i) * 0.5,
              design < 2 ? 0.5 + u.getY(i) * 0.5 : u.getY(i) * 0.5
            );
          panelM2.add(pg, TM);
          pg.dispose();
          const bk = new THREE.PlaneGeometry(1, 1);
          bk.rotateY(Math.PI);
          TM.compose(TV, TQ, TS);
          struct.add(bk, TM);
          bk.dispose();
          place(cyl, struct, p.x, gy + (cy - H / 2 - gy) / 2, p.z,
            0.4, cy - H / 2 - gy, 0.4);
          world.colliders.addAabb({
            x0: p.x - 0.8, x1: p.x + 0.8, z0: p.z - 0.8, z1: p.z + 0.8,
            y0: gy - 1, y1: cy + H / 2,
          });
        }
      }
      panelG2.dispose();
      if (!panelM2.empty) scene.add(new THREE.Mesh(panelM2.geom(), panelMat2));

      /* The canyon gate: a truss portal over the road with a cyan 湾岸
         board — the district announces itself as the toll run ends. Legs
         stand on the deck edge at hw + 0.35 like the sign gantries' legs
         (outboard of the parapet clamp, so never something the car
         threads); the board bottom clears SIGN-level 5.15 m. z = 1730,
         chosen against fixed geometry: past the merge gore's parapet gap
         (ends 1588), past the soundwall-lattice mesh run at 1600–1720
         (whose screens would otherwise stand through the east leg), off the
         gantry lattice (1500/2000), 18 m clear of the west board at 1748,
         and before the rail section opens at 1760. */
      for (const z of copies(1730)) {
        const p = cor.pose(z);
        const hw = cor.halfWidth(z);
        const legLat = hw + 0.35;
        for (const s of [-1, 1]) {
          const w = cor.worldOf(z, s * legLat);
          place(box, struct, w.x, p.y + 4.1, w.z, 0.55, 8.2, 0.55, p.h);
          lamp(w.x, p.y + 8.45, w.z, 0xff3040, 0.42);
        }
        const c = cor.worldOf(z, 0);
        place(box, struct, c.x, p.y + 7.7, c.z, legLat * 2 + 0.9, 1.1, 0.6, p.h);
        place(box, struct, c.x, p.y + 5.05, c.z, legLat * 2 + 0.6, 0.22, 0.22, p.h);
        neonBoard(c.x, p.y + 6.3, c.z, 7.2, 2.2, p.h + Math.PI, NEON.length - 1);
        for (let l = -legLat + 1.2; l <= legLat - 1.2; l += 3.6) {
          const w = cor.worldOf(z, l);
          lamp(w.x, p.y + 8.35, w.z, 0xffab55, 0.4);
        }
      }

      // the canyon's building shells, both sides, rolled in wrapped space
      const n = Math.round(44 * dLevel);
      for (let i = 0; i < n; i++) {
        const wz = rrand(rng2, CANYON.z0 + 6, CANYON.z1 - 6);
        const side = rng2() < 0.5 ? 1 : -1;
        const near = rng2() < 0.4;
        const latOff = near ? rrand(rng2, 16, 34) : rrand(rng2, 40, 78);
        const w = rrand(rng2, 9, 18), d = rrand(rng2, 8, 15);
        const hgt = near ? rrand(rng2, 10, 22) : rrand(rng2, 16, 44);
        // near shells stay square to the corridor so facade neon sits flush
        const ryJ = near ? 0 : rrand(rng2, -0.12, 0.12);
        for (const z of copies(wz)) {
          const hw = cor.halfWidth(z);
          const p = cor.worldOf(z, side * (hw + latOff));
          const pose = cor.pose(z);
          const top = tower(p.x, p.z, w, d, hgt, pose.h + ryJ);
          roofStuff(p.x, p.z, top, w, d);
          if (hgt > 32) lamp(p.x, top + 1.2, p.z, 0xff3040, 0.5);
          if (near && rng2() < 0.45)
            neonBoard(
              p.x - side * pose.nx * (0.25 + w / 2),
              top - rrand(rng2, 2.5, Math.max(3.5, hgt * 0.5)),
              p.z - side * pose.nz * (0.25 + w / 2),
              rrand(rng2, 4.5, 7.5), rrand(rng2, 1.7, 2.4),
              pose.h + (side > 0 ? -Math.PI / 2 : Math.PI / 2)
            );
        }
      }
    }

    /* ---- materialise the district buckets ---- */
    if (!colored.empty) {
      /* UNLIT on purpose: at night a standard material out here renders
         near-black (nothing lights the yard), and a black container field
         is the empty parapet the BEFORE sheet diagnosed. Basic + fog with
         the flood level baked into the vertex colour is the same trick the
         emissive boards use — the yard reads as floodlit, and the fog still
         sinks it with distance. */
      const m = new THREE.Mesh(
        colored.geom(),
        new THREE.MeshBasicMaterial({ vertexColors: true, fog: true })
      );
      scene.add(m);
    }
    const winGeo = new THREE.BoxGeometry(1, 1, 1);
    towers.forEach((list, ti) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(winGeo, mats.winMats[ti], list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = false; // nothing near these ever reads a 100 m shadow
      im.computeBoundingSphere();
      scene.add(im);
    });
    neonBuckets.forEach((bkt, k) => {
      if (bkt.empty) return;
      const nm = new THREE.MeshBasicMaterial({
        map: neonTexF(NEON[k][0], NEON[k][1]), transparent: true, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      world.neonMats.push(nm);
      const mesh = new THREE.Mesh(bkt.geom(), nm);
      mesh.renderOrder = 2;
      scene.add(mesh);
    });
    if (!glowPools.empty) {
      const gm = new THREE.Mesh(
        glowPools.geom(),
        new THREE.MeshBasicMaterial({
          map: mats.glowTex, vertexColors: true, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
        })
      );
      gm.renderOrder = 2;
      world.neonMats.push(gm.material as THREE.Material);
      scene.add(gm);
    }
    neonPlane.dispose();
    poolG.dispose();
    pipe.dispose();
    // winGeo stays live — the tower InstancedMeshes render from it
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
  const pointCloud = (arr: number[], size: number) => {
    if (!arr.length) return;
    const n = arr.length / 6;
    const p = new Float32Array(n * 3), c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      p[i * 3] = arr[i * 6];
      p[i * 3 + 1] = arr[i * 6 + 1];
      p[i * 3 + 2] = arr[i * 6 + 2];
      c[i * 3] = arr[i * 6 + 3];
      c[i * 3 + 1] = arr[i * 6 + 4];
      c[i * 3 + 2] = arr[i * 6 + 5];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    const pm = new THREE.PointsMaterial({
      size, sizeAttenuation: false, map: mats.glowTex, vertexColors: true,
      transparent: true, opacity: 1, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    /* Day/night: the engine drives every neonMats opacity; brightness is
       baked into the vertex colours so full opacity at night still can't
       blow out. Fog stays ON — it is what makes a quay light 400 m out sink
       toward the horizon instead of hanging as a hard dot (fade, not stop). */
    world.neonMats.push(pm);
    scene.add(new THREE.Points(g, pm));
  };
  pointCloud(lights, 5.5);
  pointCloud(halos, 15);

  box.dispose();
  cyl.dispose();
  taperCyl.dispose();
  blob.dispose();
  trunk.dispose();

  /* Third pass — the full-lap roadside density layer (map-density lane):
     continuous clumped tree lines, imposter ranks and near-road clutter
     filling the space BETWEEN the districts above. Runs last and draws only
     from its own forked stream (same contract as FX_DISTRICTS), so it can
     never reshuffle anything rolled before it. */
  buildRoadside(scene, mats, world, terrain);
}
