import * as THREE from "three";
import { makeTex } from "../textures";
import { getCorridor, TOLL } from "./corridor";
import { CONNECT_Z } from "./const";
import { rngFor, deckQuat, flatUnit, addInstanced, type Slot } from "./decals";

/* Deck-level realism, all procedural (Lane: highway-realism).

   What separates real night asphalt from a texture is that real wear is
   ANCHORED: tyres polish the same two bands of every lane, patches follow
   lane centres, skid marks pool where drivers brake or turn. None of that
   can live in the deck's 7 m texture tile — the tile repeats across the
   width, and the lanes move (laneCount is a seeded schedule) — so it is laid
   over the deck as geometry that reads the corridor's own lane math, the
   same way the markings are.

   Placement discipline is decals.ts's, verbatim: lattices whose pitch
   divides LOOP_LEN, per-slot dice from the folded lattice index so the two
   built copies of the splice dress identically, and one draw call per
   family. Unlike decals.ts nothing here downloads: every map is a canvas
   baked at build time (the skyCanvas house pattern), which is also why this
   set can afford to run — reduced — on mobile-base, where the JPG decal
   fetch never happens.

   Four families, four draw calls:
     - wheel tracks: tyre-polish darkening down every lane, one merged mesh
     - patch rectangles: resurfaced slabs with a sealant edge, instanced
     - skid arcs: paired tyre scrub where the road bends or braking starts
     - drainage grates: steel gutter grates under the parapet line

   Everything darkening here is alpha-blended DOWN toward the deck tone with
   long soft tails (realistic-light's stop-vs-fade rule applies to dark
   exactly as it does to light: a hard-edged dark band is a painted-on
   sticker, a tailed one is wear). Fog stays ON so the overlays haze out with
   the deck instead of printing dark stripes through it at distance. */

const LAYER_NOREF = 1;

/* Lattice pitches — all divide LOOP_LEN (4000). Phases keep these families
   off decals.ts's (crack 100/37, oil 80/11, manhole 125/53, para 200/71). */
const P_TRACK = 8; // wheel-track segment length; also its splice guarantee
const P_PATCH = 125;
const P_SKID = 50;
const P_GRATE = 40;

const inToll = (z: number) => z > TOLL.z0 - 20 && z < TOLL.z1 + 20;
const inPlaza = (z: number) => z > TOLL.plazaZ0 - 26 && z < TOLL.plazaZ1 + 26;

/* ---------------------------------------------------------------- textures */

/** Two soft tyre-polish bands, u across a lane, v down the road (tiles every
    TRACK_TILE_V m). Alpha peaks ~0.34 over near-black: on the night deck
    (0.086 linear) that composites to ~0.74x — the tracks read as a tone, not
    a stripe. The outer third of each band is a long creep to zero. */
function trackTexF() {
  return makeTex(128, 1024, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const wrapV = (fn: (oy: number) => void) => {
      for (const oy of [-h, 0, h]) fn(oy);
    };
    for (const bx of [w * 0.27, w * 0.73]) {
      // decelerating stops, not knees — the tail is what makes it wear
      const g = ctx.createLinearGradient(bx - 42, 0, bx + 42, 0);
      const stops: [number, number][] = [
        [0, 0], [0.12, 0.05], [0.24, 0.14], [0.36, 0.26], [0.46, 0.33],
        [0.5, 0.34], [0.54, 0.33], [0.64, 0.26], [0.76, 0.14],
        [0.88, 0.05], [1, 0],
      ];
      for (const [p, a] of stops) g.addColorStop(p, `rgba(10,11,15,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(bx - 42, 0, 84, h);
      // break the band up along v: polish is patchy, not a ruled line
      for (let i = 0; i < 7; i++) {
        const gx = bx + (Math.random() * 2 - 1) * 16;
        const gy = Math.random() * h;
        const rx = 14 + Math.random() * 22, ry = 90 + Math.random() * 180;
        ctx.globalCompositeOperation = "destination-out";
        wrapV((oy) => {
          const y = gy + oy;
          if (y + ry < 0 || y - ry > h) return;
          const e = ctx.createRadialGradient(gx, y, 0, gx, y, 1);
          e.addColorStop(0, `rgba(0,0,0,${0.25 + Math.random() * 0.3})`);
          e.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = e;
          ctx.save();
          ctx.translate(gx, y);
          ctx.scale(rx, ry);
          ctx.beginPath();
          ctx.arc(0, 0, 1, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        });
        ctx.globalCompositeOperation = "source-over";
      }
      // fine longitudinal scrub lines inside the band
      for (let i = 0; i < 14; i++) {
        const x = bx + (Math.random() * 2 - 1) * 24;
        const y0 = Math.random() * h, len = 60 + Math.random() * 240;
        ctx.fillStyle = `rgba(8,9,13,${0.04 + Math.random() * 0.08})`;
        wrapV((oy) => ctx.fillRect(x, y0 + oy, 1 + Math.random(), len));
      }
    }
  }, true);
}

/** Resurfaced slab: a slightly darker fill inside a crisp dark sealant line.
    The sealant edge is the one deliberate hard edge in this file — a real
    patch IS a crisp rectangle, and the crispness is what says "road crew",
    not "sticker"; the irregular outline does the de-vectorising instead. */
function patchTexF() {
  return makeTex(128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const pts: [number, number][] = [];
    const N = 10;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      // rectangle-ish radius with jitter: rounded irregular slab
      const rx = w * 0.36 + (Math.random() * 2 - 1) * 4;
      const ry = h * 0.36 + (Math.random() * 2 - 1) * 4;
      pts.push([w / 2 + Math.cos(t) * rx, h / 2 + Math.sin(t) * ry]);
    }
    ctx.beginPath();
    ctx.moveTo((pts[0][0] + pts[N - 1][0]) / 2, (pts[0][1] + pts[N - 1][1]) / 2);
    for (let i = 0; i < N; i++) {
      const a = pts[i], b = pts[(i + 1) % N];
      ctx.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(9,10,14,.48)";
    ctx.fill();
    // sealant band: over-banded tar, the glossy black outline every patch has
    ctx.strokeStyle = "rgba(3,4,6,.85)";
    ctx.lineWidth = 5;
    ctx.stroke();
    // fresh-mix speckle, lighter than the fill so the slab isn't a flat card
    ctx.save();
    ctx.clip();
    for (let i = 0; i < 46; i++) {
      const v = 90 + Math.floor(Math.random() * 50);
      ctx.fillStyle = `rgba(${v},${v + 3},${v + 9},${0.05 + Math.random() * 0.1})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2.5, 1 + Math.random() * 2.5);
    }
    ctx.restore();
  });
}

/** Paired tyre scrub, v along the mark. Both ends feathered to nothing —
    a skid that stops dead reads as paint, one that fades reads as rubber. */
function skidTexF() {
  return makeTex(128, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const drift = 14 + Math.random() * 12; // the arc: both tyres drift together
    for (const x of [w * 0.28, w * 0.72]) {
      for (let pass = 0; pass < 4; pass++) {
        const j = (Math.random() * 2 - 1) * 3;
        ctx.strokeStyle = `rgba(10,11,15,${0.12 + Math.random() * 0.07})`;
        ctx.lineWidth = 8 + Math.random() * 6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x + j, h * 0.96);
        ctx.quadraticCurveTo(x + j + drift * 0.35, h * 0.5, x + j + drift, h * 0.04);
        ctx.stroke();
      }
    }
    // feather both ends and patch the middle so no edge survives
    ctx.globalCompositeOperation = "destination-out";
    for (const [y0, y1] of [[0, h * 0.24], [h, h * 0.78]] as const) {
      const g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.55, "rgba(0,0,0,.4)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, Math.min(y0, y1), w, Math.abs(y1 - y0));
    }
    for (let i = 0; i < 8; i++) {
      const gx = Math.random() * w, gy = Math.random() * h, r = 8 + Math.random() * 18;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
      g.addColorStop(0, `rgba(0,0,0,${0.2 + Math.random() * 0.35})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  });
}

/** Steel gutter grate, drawn opaque with the slots punched to alpha 0 so the
    deck shows through them under alphaTest — same honest-depth reasoning as
    the manhole covers in decals.ts. */
function grateTexF() {
  return makeTex(64, 96, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#31363f";
    ctx.fillRect(2, 2, w - 4, h - 4);
    // machined bevel catches what little light there is
    ctx.fillStyle = "#5c636e";
    ctx.fillRect(2, 2, w - 4, 2);
    ctx.fillRect(2, 2, 2, h - 4);
    ctx.fillStyle = "#171a20";
    ctx.fillRect(2, h - 4, w - 4, 2);
    ctx.fillRect(w - 4, 2, 2, h - 4);
    // transverse slots (the long axis lies along the road when placed)
    for (let y = 12; y < h - 12; y += 12) {
      ctx.clearRect(10, y, w - 20, 6);
      ctx.fillStyle = "#454b56";
      ctx.fillRect(10, y - 1, w - 20, 1); // slot lip
      ctx.fillStyle = "#171a20";
    }
  });
}

/* ------------------------------------------------------------ wheel tracks */

/** Tyre-polish ribbons down every real lane. ONE merged transparent mesh,
    ~2 quads per lane per 8 m — the 8 m step keeps the quad's chord within
    ~5 mm of the deck through the y-bends, well inside the 20 mm hover.
    Splice-safe two ways: the 8 m pitch divides LOOP_LEN, and the map's v is
    tiled by wrapped z (25 m also divides it). */
export function buildWheelTracks(scene: THREE.Scene) {
  const cor = getCorridor();
  const TRACK_TILE_V = 25;
  const HALF_W = 1.45; // quad half-width; the texture's tails die inside it
  const pos: number[] = [], uv: number[] = [];
  for (const z of cor.lattice(P_TRACK)) {
    if (z + P_TRACK > cor.ZB1 || inPlaza(z)) continue;
    const nA = cor.laneCount(z), nB = cor.laneCount(z + P_TRACK);
    const n = Math.floor(Math.min(nA, nB) + 1e-4);
    const v0 = cor.wrapZ(z) / TRACK_TILE_V, v1 = v0 + P_TRACK / TRACK_TILE_V;
    for (let k = 0; k < n; k++) {
      const l0 = cor.laneOffset(k, z), l1 = cor.laneOffset(k, z + P_TRACK);
      const a0 = cor.worldOf(z, l0 - HALF_W), a1 = cor.worldOf(z, l0 + HALF_W);
      const b0 = cor.worldOf(z + P_TRACK, l1 - HALF_W), b1 = cor.worldOf(z + P_TRACK, l1 + HALF_W);
      const Y = 0.02;
      // two tris, wound like Soup.quadUv (a, b, c) + (a, c, d)
      pos.push(
        a0.x, a0.y + Y, a0.z, b0.x, b0.y + Y, b0.z, b1.x, b1.y + Y, b1.z,
        a0.x, a0.y + Y, a0.z, b1.x, b1.y + Y, b1.z, a1.x, a1.y + Y, a1.z
      );
      uv.push(0, v0, 0, v1, 1, v1, 0, v0, 1, v1, 1, v0);
    }
  }
  if (!pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
  const mat = new THREE.MeshBasicMaterial({
    map: trackTexF(), transparent: true, depthWrite: false, fog: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(g, mat);
  // under everything else on the deck: paint, joints and decals all sit on
  // polish, never the other way round
  mesh.renderOrder = -3;
  mesh.layers.set(LAYER_NOREF);
  mesh.frustumCulled = false; // one full-loop ribbon, like the stud clouds
  scene.add(mesh);
}

/* ----------------------------------------------------------- deck dressing */

/** Patch slabs, skid arcs and gutter grates. `density` is the tier knob
    (TierCaps.deckDressing): it scales the dice, so mobile-base keeps a thin
    scatter of the same families rather than a different world. */
export function buildDeckDressing(scene: THREE.Scene, density: number) {
  const cor = getCorridor();

  /* ---- resurfacing patches, lane-aligned like real crews cut them ---- */
  const patchSlots: Slot[] = [];
  for (const z of cor.lattice(P_PATCH, 91)) {
    if (z > cor.ZB1 || cor.inTunnel(z) || inToll(z)) continue;
    const rng = rngFor(cor.latticeIndex(z, P_PATCH, 91), 0x2a7c);
    if (rng() >= 0.55 * density) continue;
    const p = cor.pose(z);
    const lanes = Math.max(1, Math.floor(cor.laneCount(z)));
    const k = Math.min(lanes - 1, Math.floor(rng() * lanes));
    const lat = cor.laneOffset(k, z) + (rng() - 0.5) * 0.6;
    const w = cor.worldOf(z, lat);
    patchSlots.push({
      pos: new THREE.Vector3(w.x, w.y + 0.026, w.z),
      quat: deckQuat(p.h, p.grade),
      scale: new THREE.Vector3(
        (2.6 + rng() * 1.6) * (rng() < 0.5 ? -1 : 1), 1, 5 + rng() * 6),
    });
  }
  addInstanced(scene, flatUnit(), new THREE.MeshBasicMaterial({
    map: patchTexF(), transparent: true, depthWrite: false, fog: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), patchSlots, -2);

  /* ---- skid arcs where the road asks for them ----
     Probability rides the local curvature (heading swing over ±12 m), plus a
     flat bump through the braking run-up to the toll — scrub goes where
     drivers actually shed speed, which is what makes the scatter read as
     history rather than noise. */
  const skidSlots: Slot[] = [];
  for (const z of cor.lattice(P_SKID, 23)) {
    if (z > cor.ZB1 || cor.inTunnel(z) || inToll(z)) continue;
    const rng = rngFor(cor.latticeIndex(z, P_SKID, 23), 0x5c1d);
    const za = Math.max(cor.ZB0, z - 12), zb = Math.min(cor.ZB1, z + 12);
    const kappa = Math.abs(cor.pose(zb).h - cor.pose(za).h);
    const braking = z > TOLL.z0 - 170 && z < TOLL.z0 - 25;
    const p = Math.min(0.65, kappa * 22) + (braking ? 0.5 : 0.02);
    if (rng() >= p * density) continue;
    const pose = cor.pose(z);
    const lanes = Math.max(1, Math.floor(cor.laneCount(z)));
    const k = Math.min(lanes - 1, Math.floor(rng() * lanes));
    const lat = cor.laneOffset(k, z) + (rng() - 0.5) * 1.4;
    const w = cor.worldOf(z, lat);
    const yaw = pose.h + (rng() - 0.5) * 0.2;
    skidSlots.push({
      pos: new THREE.Vector3(w.x, w.y + 0.022, w.z),
      quat: deckQuat(yaw, pose.grade),
      scale: new THREE.Vector3(
        (2.3 + rng() * 0.5) * (rng() < 0.5 ? -1 : 1), 1, 8 + rng() * 8),
    });
  }
  addInstanced(scene, flatUnit(), new THREE.MeshBasicMaterial({
    map: skidTexF(), transparent: true, depthWrite: false, fog: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), skidSlots, -2);

  /* ---- drainage grates at the gutter line ----
     A lit Standard material, not Basic: a grate is the one family here that
     should answer the real headlight SpotLights (it lies in the road plane
     the dipped cones are aimed at), glinting up out of the dark as the beam
     sweeps the shoulder. depthWrite stays on — alphaTest is a cutout, and an
     honest depth under the glow sprites matters (decals.ts's manhole note). */
  const grateSlots: Slot[] = [];
  for (const z of cor.lattice(P_GRATE, 17)) {
    if (z > cor.ZB1 || cor.inTunnel(z) || inToll(z)) continue;
    // ramps punch gaps in the west parapet around the gores; no kerb, no grate
    if (CONNECT_Z.some((cz) => Math.abs(z - cz) < 280)) continue;
    const idx = cor.latticeIndex(z, P_GRATE, 17);
    const rng = rngFor(idx, 0x9a7e);
    if (rng() >= 0.45 + 0.3 * density) continue;
    const p = cor.pose(z);
    const side = idx % 2 ? 1 : -1;
    const w = cor.worldOf(z, side * (cor.halfWidth(z) - 0.62));
    grateSlots.push({
      pos: new THREE.Vector3(w.x, w.y + 0.012, w.z),
      quat: deckQuat(p.h, p.grade),
      scale: new THREE.Vector3(0.55, 1, 0.95),
    });
  }
  addInstanced(scene, flatUnit(), new THREE.MeshStandardMaterial({
    map: grateTexF(), alphaTest: 0.5, roughness: 0.55, metalness: 0.35,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), grateSlots, 0);
}
