import * as THREE from "three";
import { mulberry32, rrand, rrandi, type Rng } from "../util";
import { makeTex } from "../textures";
import {
  getCorridor, roadSeed, signPlan, PITCH, PHASE, TOLL,
} from "./corridor";
import type { Mats } from "./mats";
import type { WorldData } from "./data";
import type { Terrain } from "./terrain";
import { worldTierCaps } from "../settings";
import { Merge } from "./scenery";

/* Continuous roadside density (the map-density lane).

   The transform pass gave the lap six lit districts; the owner's verdict was
   that the space BETWEEN them still reads as the same empty road — what he
   asked for was "trees and rendering and stuff", i.e. the continuous texture
   a real orbital carries at its edges, not another landmark. This file is
   that texture, in two registers:

   VEGETATION — a full-lap planting pass. Naturally-clumped tree lines run
   along both shoulders wherever the world allows (a low-frequency density
   wave plus per-slot dice makes clusters and clearings, never a picket
   fence), an undergrowth strip at their feet so the trunks rise out of
   scrub instead of floating on the heightfield, and a sparser second rank
   40-90 m out giving the line depth. Species follow the districts:
   broadleaf clumps in the open country, formal street trees on the eastside
   frontage strip, a poplar row along the industry fence, conifers
   thickening the grove.

   Every plant is the same cheap thing: three crossed alpha-cutout planes
   (6 triangles) from one canvas-baked foliage atlas, instanced per chunk.
   Cutout silhouettes, not solid geometry, on purpose: the dashcam's night
   frame turns any near tree into a black shape against the sky glow, and a
   merged-blob canopy was tried first and read as giant faceted wedges —
   leaf-scale ragged EDGES are what make a black shape read as foliage, and
   only a texture's alpha channel draws edges that fine for free.

   CLUTTER — the small stuff that flickers past at speed and sells the rest:
   kilometre plates, utility cabinets on the coping, guardrail end blocks
   where a railing run hands back to concrete, and weed tufts breaking out
   of the gutter line at the parapet base.

   Budget rules, same as the rest of world/:
   - zero downloads — every texture is a canvas bake;
   - everything instanced or merged: vegetation is ONE draw call per 280 m
     chunk (a single InstancedMesh of crossed-plane plants), the clutter
     families one draw each for the whole lap;
   - vegetation chunks ride the engine's chunk cull (world.chunks), and the
     foliage material carries a screen-door distance dissolve that finishes
     BEFORE the cull distance, so nothing ever pops — things grain in and
     out through the dashcam's own noise floor instead (the fade rule: ease,
     never pop). The dissolve tracks the live draw distance through
     world.fadeFar, which chunksUpdate() feeds every cull tick;
   - placement is point-checked against the real world, not guessed bans:
     route-graph pavement (bypass + mountain road, whichever side the seed
     put them), ramp bboxes, town/frontage streets, and every collider AABB
     — so clusters open up around structures by construction;
   - all randomness comes from a stream FORKED off the road seed (the
     districts' rule): the shared world stream is spent in a fixed order and
     this file must not reshuffle it.

   Master switch FX_ROADSIDE; density rides TierCaps.vegetation. */

const FX_ROADSIDE = true;

/** Vegetation chunk length. Shorter than the town's 96 m cells would multiply
    draw calls; longer would push the dissolve horizon too far in from the
    cull distance (the dissolve must finish before the NEAREST fragment of a
    chunk whose CENTRE crosses the cull radius can vanish — see vegDissolve). */
const CHUNK_VEG = 280;

/* ---- foliage atlas: six canvas-baked plants, 3×2 ---------------------------
   Painted at daylight albedo (dark olives — at night the ambient is nearly
   nothing and the whole plant collapses to the correct thing, a serrated
   black silhouette against the city glow). The alpha channel IS the
   silhouette: alphaTest cuts it hard, so edges are drawn ragged with
   leaf-scale speckle rather than smooth blob outlines. */
function foliageAtlasTex(rng: Rng): THREE.Texture {
  return makeTex(768, 512, (ctx) => {
    const GREENS = ["#2a3a20", "#3c4f28", "#556936", "#202c16"];
    const blob = (x: number, y: number, r: number, c: string, a: number) => {
      const g = ctx.createRadialGradient(x, y, r * 0.15, x, y, r);
      g.addColorStop(0, c);
      g.addColorStop(0.75, c);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = a;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    const speckle = (x0: number, y0: number, w: number, h: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const x = x0 + rrand(rng, 0, w), y = y0 + rrand(rng, 0, h);
        if (rng() < 0.45) {
          // punch leaf-gap holes so sky reads through the crown
          ctx.globalCompositeOperation = "destination-out";
          blob(x, y, rrand(rng, 2.5, 6), "#000", 0.9);
          ctx.globalCompositeOperation = "source-over";
        } else {
          blob(x, y, rrand(rng, 1.5, 4), GREENS[rrandi(rng, 0, 3)], 0.8);
        }
      }
    };
    const trunk = (cx: number, baseY: number, topY: number, w: number) => {
      ctx.strokeStyle = "#33261a";
      ctx.lineCap = "round";
      const lean = rrand(rng, -6, 6);
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(cx, baseY);
      ctx.quadraticCurveTo(cx + lean * 0.4, (baseY + topY) / 2, cx + lean, topY);
      ctx.stroke();
      for (const s of [-1, 1]) {
        ctx.lineWidth = w * 0.45;
        ctx.beginPath();
        ctx.moveTo(cx + lean * 0.5, (baseY + topY) / 2 + rrand(rng, -8, 8));
        ctx.lineTo(cx + lean * 0.5 + s * rrand(rng, 14, 26), topY + rrand(rng, -14, 6));
        ctx.stroke();
      }
    };
    /** broadleaf: trunk + a crown of overlapping lobes, ragged edge */
    const broadleaf = (x0: number, y0: number) => {
      const cx = x0 + 128, baseY = y0 + 250, crownY = y0 + 100;
      trunk(cx, baseY, crownY + 44, 12);
      const lobes = rrandi(rng, 6, 9);
      for (let l = 0; l < lobes; l++) {
        const a = (l / lobes) * Math.PI * 2 + rrand(rng, -0.4, 0.4);
        const lx = cx + Math.cos(a) * rrand(rng, 18, 60);
        const ly = crownY + Math.sin(a) * rrand(rng, 12, 42);
        const tone = GREENS[ly < crownY ? (rng() < 0.6 ? 2 : 1) : rrandi(rng, 0, 1)];
        for (let k = 0; k < 10; k++)
          blob(lx + rrand(rng, -15, 15), ly + rrand(rng, -12, 12),
            rrand(rng, 6, 13), tone, 0.9);
      }
      // core fill so the crown centre never shows holes
      for (let k = 0; k < 14; k++)
        blob(cx + rrand(rng, -30, 30), crownY + rrand(rng, -16, 22),
          rrand(rng, 11, 18), GREENS[rrandi(rng, 0, 1)], 0.95);
      speckle(x0 + 24, y0 + 24, 208, 156, 80);
    };
    /** conifer: narrowing ragged layers — reads at every distance */
    const conifer = (x0: number, y0: number) => {
      const cx = x0 + 128, baseY = y0 + 250, topY = y0 + 24;
      trunk(cx, baseY, baseY - 36, 9);
      const layers = 9;
      for (let l = 0; l < layers; l++) {
        const t = l / (layers - 1);
        const ly = baseY - 42 - t * (baseY - 60 - topY);
        const half = (1 - t) * 62 + 7;
        for (let k = 0; k < 12; k++) {
          const lx = cx + rrand(rng, -half, half);
          blob(lx, ly + rrand(rng, -7, 9), rrand(rng, 4.5, 9),
            GREENS[rng() < 0.25 ? 2 : rng() < 0.6 ? 0 : 3], 0.92);
        }
      }
      speckle(x0 + 48, y0 + 28, 160, 196, 44);
    };
    /** poplar/columnar: tall narrow crown almost to the ground */
    const poplar = (x0: number, y0: number) => {
      const cx = x0 + 128, baseY = y0 + 250;
      trunk(cx, baseY, baseY - 30, 8);
      for (let l = 0; l < 12; l++) {
        const t = l / 11;
        const ly = baseY - 26 - t * 200;
        const half = 26 + Math.sin(t * Math.PI) * 22;
        for (let k = 0; k < 8; k++)
          blob(cx + rrand(rng, -half, half), ly + rrand(rng, -8, 8),
            rrand(rng, 6, 11), GREENS[rrandi(rng, 0, 2)], 0.9);
      }
      speckle(x0 + 62, y0 + 20, 132, 210, 44);
    };
    /** low bush dome — the gutter-weed and scrub-accent tile */
    const bush = (x0: number, y0: number) => {
      const cx = x0 + 128, baseY = y0 + 246;
      for (let l = 0; l < 3; l++) {
        const lx = cx + (l - 1) * rrand(rng, 30, 46);
        const ly = baseY - rrand(rng, 26, 44) - (l === 1 ? 16 : 0);
        for (let k = 0; k < 12; k++)
          blob(lx + rrand(rng, -22, 22), ly + rrand(rng, -13, 13),
            rrand(rng, 8, 15), GREENS[rrandi(rng, 0, 2)], 0.9);
      }
      // grass spikes breaking the dome's base line
      ctx.strokeStyle = GREENS[1];
      ctx.lineWidth = 3;
      for (let k = 0; k < 24; k++) {
        const sx = cx + rrand(rng, -84, 84);
        ctx.globalAlpha = rrand(rng, 0.5, 0.95);
        ctx.beginPath();
        ctx.moveTo(sx, baseY + 8);
        ctx.lineTo(sx + rrand(rng, -8, 8), baseY - rrand(rng, 22, 48));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      speckle(x0 + 30, y0 + 152, 196, 90, 40);
    };
    /** wide low scrub tangle — the undergrowth strip tile */
    const scrub = (x0: number, y0: number) => {
      const baseY = y0 + 248;
      for (let k = 0; k < 60; k++) {
        const sx = x0 + 24 + rrand(rng, 0, 208);
        const sy = baseY - Math.abs(rrand(rng, 0, 1) * rrand(rng, 0, 1)) * 74 - 6;
        blob(sx, sy, rrand(rng, 7, 14), GREENS[rrandi(rng, 0, 3)], 0.85);
      }
      ctx.strokeStyle = GREENS[0];
      ctx.lineWidth = 3;
      for (let k = 0; k < 30; k++) {
        const sx = x0 + 20 + rrand(rng, 0, 216);
        ctx.globalAlpha = rrand(rng, 0.4, 0.9);
        ctx.beginPath();
        ctx.moveTo(sx, baseY + 6);
        ctx.lineTo(sx + rrand(rng, -10, 10), baseY - rrand(rng, 26, 60));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      speckle(x0 + 26, y0 + 160, 204, 84, 40);
    };
    broadleaf(0, 0);
    broadleaf(256, 0);
    conifer(512, 0);
    poplar(0, 256);
    bush(256, 256);
    scrub(512, 256);
  });
}

/** uv-offset of each atlas tile (geometry uv is pre-scaled to one tile).
    Canvas row 0 is texture v [0.5, 1]. */
const TX = 1 / 3;
const TILE = {
  leafA: [0, 0.5] as const,
  leafB: [TX, 0.5] as const,
  conifer: [2 * TX, 0.5] as const,
  poplar: [0, 0] as const,
  bush: [TX, 0] as const,
  scrub: [2 * TX, 0] as const,
};
type Tile = readonly [number, number];

export function buildRoadside(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain
) {
  const caps = worldTierCaps();
  const level = Math.max(0, Math.min(1, caps.vegetation ?? 1));
  if (!FX_ROADSIDE || level <= 0) return;
  const cor = getCorridor();
  const rng = mulberry32((roadSeed() ^ 0x51ed2ea7) >>> 0);

  /** every built-extent copy of a wrapped z (the splice-duplication rule) */
  const copies = (wz: number) => {
    const out: number[] = [];
    for (const z of [wz - cor.LOOP, wz, wz + cor.LOOP])
      if (z >= cor.ZB0 && z <= cor.ZB1) out.push(z);
    return out;
  };

  /* ---- keep-out: ask the world, don't guess ---- */
  const routes = world.routes;
  const gaps = routes ? routes.newParapetGaps() : [];
  const ramps = routes ? routes.ramps : [];
  const signs = signPlan();
  /** the parapet is open here (bypass/mountain gores) — nothing may stand on
      or against the coping */
  const inGap = (wz: number, side: 1 | -1, pad = 6) =>
    gaps.some((g) => g.side === side && wz > g.z0 - pad && wz < g.z1 + pad);
  const inRampBox = (x: number, z: number, pad = 5) =>
    ramps.some((r) =>
      x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad);
  const onStreet = (x: number, z: number) => {
    const n = world.net.nearest(x, z);
    return !!n && n.dist < n.edge.w / 2 + 3.5;
  };
  const hitsCollider = (x: number, z: number, r: number) => {
    for (const id of world.colliders.nearbyAabbs(x, z)) {
      const b = world.colliders.aabbs[id];
      if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
    }
    return false;
  };
  /** may a plant of footprint r stand at (x, z)? */
  const plantOK = (x: number, z: number, r: number) => {
    if (routes && routes.distToNew(x, z, 15) < 15) return false;
    if (inRampBox(x, z)) return false;
    if (onStreet(x, z)) return false;
    if (hitsCollider(x, z, r)) return false;
    return true;
  };
  /* Hand-placed no-plant bands (wrapped z, per side) for the stretches a
     district or the mountain road owns outright — vegetation there would
     stand in a paved yard or block the very view a section was opened for:
     east: the mountain pass + wharf/river frontage, and the neon canyon;
     west: the canyon's other half. */
  const EAST_SKIP: readonly [number, number][] = [[-2000, -1285], [1565, 2000]];
  const WEST_SKIP: readonly [number, number][] = [[1565, 2000]];
  const inBand = (wz: number, bands: readonly [number, number][]) =>
    bands.some(([a, b]) => wz > a && wz < b);

  /* ---- the distance dissolve ----
     chunksUpdate() culls world.chunks at dd and writes dd into world.fadeFar
     every tick. A chunk goes invisible when its CENTRE crosses dd, i.e. its
     nearest content at dd − CHUNK_VEG/2 − (lateral reach) — so the dissolve
     is done ~150 m inside dd and the binary cull only ever removes fragments
     the screen-door has already fully discarded. Screen-door rather than
     blended alpha because the foliage is an alphaTest cutout: no sorting, no
     transparency pass, and under the POV grain a stochastic dissolve is
     invisible as a mechanism. */
  const fadeFar = (world.fadeFar ??= { value: 700 });
  const vegDissolve = (mat: THREE.Material) => {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      sh.uniforms.uVegFar = fadeFar;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec2 aTile;")
        .replace(
          "#include <uv_vertex>",
          "#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv += aTile;\n#endif"
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float uVegFar;"
        )
        .replace(
          "#include <clipping_planes_fragment>",
          `{
	float vegEnd = max(uVegFar - 150.0, uVegFar * 0.55);
	float keep = 1.0 - smoothstep(vegEnd - 130.0, vegEnd, length(vViewPosition));
	if (keep < 0.999) {
		float h = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
		if (h >= keep) discard;
	}
}
#include <clipping_planes_fragment>`
        );
    };
  };

  /* ---- the one foliage material (one program for the whole layer) ---- */
  const atlas = foliageAtlasTex(rng);
  const folMat = new THREE.MeshStandardMaterial({
    map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 1,
  });
  /* Beam wash FIRST — addBeam assigns onBeforeCompile outright, so the
     dissolve must be layered on afterwards (it chains whatever it finds).
     The wash is tuned for the gutter weeds an arm from the door; trees a
     shoulder-width out catch a faint brush of it on the way past, which is
     exactly what a hedge in headlights does. */
  mats.addBeam(folMat, { near: 14, far: 46, spread: 0.5 });
  vegDissolve(folMat);

  /* ---- per-chunk instance buckets ---- */
  const nChunks = Math.ceil((cor.ZB1 - cor.ZB0) / CHUNK_VEG);
  interface Bucket { m: THREE.Matrix4[]; tile: number[]; col: number[] }
  const chunks: (Bucket | null)[] = new Array(nChunks).fill(null);
  const chunkOf = (z: number) =>
    Math.max(0, Math.min(nChunks - 1, Math.floor((z - cor.ZB0) / CHUNK_VEG)));

  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(),
    V = new THREE.Vector3(), S = new THREE.Vector3();
  const C = new THREE.Color();

  /** near a sodium head's lattice slot — tint the silhouette warm, the same
      cheap rim-light stand-in the first-pass trees use */
  const nearLamp = (wz: number) => {
    const ph = PHASE.light ?? 0;
    let d = ((wz - ph) % PITCH.light + PITCH.light) % PITCH.light;
    if (d > PITCH.light / 2) d = PITCH.light - d;
    return d < 9;
  };

  /** One plant: three crossed cutout planes, instanced. `h` metres tall,
      `w` metres wide, sunk 0.2 m so the base never floats on a terrain seam. */
  const addPlant = (
    z: number, x: number, gy: number, tile: Tile, h: number, w: number,
    warm = false
  ) => {
    const b = chunks[chunkOf(z)] ??= { m: [], tile: [], col: [] };
    E.set(0, rrand(rng, 0, Math.PI), 0);
    Q.setFromEuler(E);
    V.set(x, gy - 0.2, z);
    S.set(w * (rng() < 0.5 ? -1 : 1), h, w);
    b.m.push(new THREE.Matrix4().compose(V, Q, S));
    b.tile.push(tile[0], tile[1]);
    const k = rrand(rng, 0.7, 1.12);
    if (warm) C.setRGB(1.25 * k, 0.98 * k, 0.62 * k);
    else C.setRGB(0.92 * k, k, 0.88 * k);
    b.col.push(C.r, C.g, C.b);
  };

  /* ---- the density wave: low-frequency clumping over wrapped z ----
     Two incommensurate sines forked off the seed. The product spends real
     stretches near zero — those are the clearings that make the planted
     stretches read as clumps rather than a wall. */
  const p1 = rrand(rng, 0, Math.PI * 2), p2 = rrand(rng, 0, Math.PI * 2);
  const wave = (wz: number) => {
    const a = 0.5 + 0.5 * Math.sin(wz * 0.011 + p1);
    const b = 0.5 + 0.5 * Math.sin(wz * 0.0043 + p2);
    return Math.min(1, 0.25 + 1.5 * a * b);
  };
  /** species mix by stretch: conifers thicken the grove, mixed elsewhere */
  const pickTile = (wz: number): Tile => {
    const groveish = wz > -1300 && wz < -560;
    const r = rng();
    if (groveish) return r < 0.45 ? TILE.conifer : r < 0.7 ? TILE.leafA : TILE.leafB;
    return r < 0.14 ? TILE.conifer : r < 0.3 ? TILE.poplar
      : r < 0.65 ? TILE.leafA : TILE.leafB;
  };

  /* ================= PASS A: the main tree line, both shoulders ============ */
  for (let wz = -2000; wz < 2000; wz += 9) {
    if (cor.inTunnel(wz, 22) || cor.inToll(wz) || wz > TOLL.z0 - 26 && wz < TOLL.z1 + 26)
      continue;
    for (const side of [1, -1] as const) {
      if (inBand(wz, side > 0 ? EAST_SKIP : WEST_SKIP)) continue;
      // the eastside frontage strip gets its formal street trees in PASS B
      if (side > 0 && wz > -560 && wz < 40) continue;
      if (rng() >= 0.44 * wave(wz) * level) continue;
      // one cluster: 1-4 trees around an anchor, correlated sizes
      const hw = cor.halfWidth(wz);
      const lat0 = side * (hw + rrand(rng, 9, 24));
      const n = rrandi(rng, 1, 4);
      const tile = pickTile(wz);
      const deckY = cor.pose(wz).y;
      /* crown tops ride a couple of metres over the parapet sightline — high
         enough to serrate the glow band, low enough that a near cluster
         stays a roadside line instead of a wall over the windshield */
      const hBase = rrand(rng, -1.5, 4);
      let planted = 0;
      for (let k = 0; k < n; k++) {
        const dz = k === 0 ? 0 : rrand(rng, -8, 8);
        const lat = lat0 + (k === 0 ? 0 : side * rrand(rng, -4, 9));
        const p = cor.worldOf(wz + dz, lat);
        if (!plantOK(p.x, p.z, 1.6)) continue;
        const t2 = k > 0 && rng() < 0.25 ? pickTile(wz) : tile;
        const hj = rrand(rng, -1.5, 2);
        // ground is sampled at each EMITTED copy — the heightfield is not
        // loop-periodic, so a splice twin re-seats on its own terrain
        for (const z of copies(wz + dz)) {
          const gy = terrain.h(p.x, p.z + (z - (wz + dz)));
          const h = Math.max(5.5, Math.min(18, deckY + hBase + hj - gy));
          const w = h * (t2 === TILE.conifer ? rrand(rng, 0.42, 0.55)
            : t2 === TILE.poplar ? rrand(rng, 0.3, 0.4) : rrand(rng, 0.72, 0.95));
          addPlant(z, p.x, gy, t2, h, w, nearLamp(wz));
        }
        planted++;
      }
      // undergrowth strip between the coping and the trunks — no floating
      if (planted) {
        const nb = rrandi(rng, 1, 3);
        for (let k = 0; k < nb; k++) {
          const dz = rrand(rng, -8, 8);
          const lat = side * (hw + rrand(rng, 6, 12));
          const p = cor.worldOf(wz + dz, lat);
          if (!plantOK(p.x, p.z, 0.8)) continue;
          const h = rrand(rng, 1.1, 2.4);
          for (const z of copies(wz + dz))
            addPlant(z, p.x, terrain.h(p.x, p.z + (z - (wz + dz))),
              TILE.scrub, h, h * rrand(rng, 1.8, 2.6));
        }
      }
    }
  }

  /* ============ PASS B: street trees on the eastside frontage strip ========
     Between the near tower rank (x ≤ ~542) and the east frontage road
     (carriageway from x ≈ 557) there is a planted verge; a formal row —
     one species, even size, near-regular pitch — reads as the city block
     the district wants, where a wild clump would read as wasteland. */
  for (let wz = -536; wz < 26; wz += 26) {
    if (rng() >= 0.85 * level) continue;
    const z0 = wz + rrand(rng, -5, 5);
    const x = 547.4 + rrand(rng, -1.4, 1.4);
    if (!plantOK(x, z0, 1.4)) continue;
    const gy = terrain.h(x, z0);
    const deckY = cor.pose(z0).y;
    const h = Math.max(7, Math.min(14, deckY + rrand(rng, 0.5, 3) - gy));
    addPlant(z0, x, gy, TILE.leafA, h, h * rrand(rng, 0.75, 0.9), nearLamp(wz));
  }

  /* ============ PASS C: the poplar row along the industry fence ============
     A working yard plants poplars at its fence, not an English hedgerow —
     a tall thin beat every ~17 m tying the FOREYARD sheds together. */
  for (let wz = 92; wz < 822; wz += 17) {
    if (cor.inTunnel(wz, 24)) continue;
    if (rng() >= 0.7 * level) continue;
    const z0 = wz + rrand(rng, -4, 4);
    const x = 577 + rrand(rng, -2.5, 2.5);
    if (!plantOK(x, z0, 1.2)) continue;
    const deckY = cor.pose(z0).y;
    const hj = rrand(rng, 1.5, 5);
    for (const z of copies(z0)) {
      const gy = terrain.h(x, z);
      const h = Math.max(8, Math.min(17, deckY + hj - gy));
      addPlant(z, x, gy, TILE.poplar, h, h * rrand(rng, 0.3, 0.38));
    }
  }

  /* ================= PASS D: the second rank, 35-90 m out ==================
     Depth behind the silhouette line for six triangles a tree. Clamped off
     the river (x < 640 keeps every plant out of the water). */
  for (let wz = -2000; wz < 2000; wz += 13) {
    if (cor.inTunnel(wz, 12) || cor.inToll(wz)) continue;
    for (const side of [1, -1] as const) {
      if (inBand(wz, side > 0 ? EAST_SKIP : WEST_SKIP)) continue;
      if (side > 0 && wz > -560 && wz < 40) continue;
      if (rng() >= 0.42 * wave(wz + 900 * side) * level) continue;
      const hw = cor.halfWidth(wz);
      const n = rrandi(rng, 1, 2);
      for (let k = 0; k < n; k++) {
        const dz = rrand(rng, -6, 6);
        const lat = side * (hw + rrand(rng, 35, 88));
        const p = cor.worldOf(wz + dz, lat);
        if (side > 0 && p.x > 640) continue;
        if (!plantOK(p.x, p.z, 1)) continue;
        const conif = rng() < (wz > -1300 && wz < -560 ? 0.5 : 0.2);
        const h = rrand(rng, 10, 19);
        const w = h * (conif ? rrand(rng, 0.42, 0.55) : rrand(rng, 0.72, 0.95));
        const tile = conif ? TILE.conifer : rng() < 0.5 ? TILE.leafA : TILE.leafB;
        for (const z of copies(wz + dz))
          addPlant(z, p.x, terrain.h(p.x, p.z + (z - (wz + dz))), tile, h, w);
      }
    }
  }

  /* ---- materialise the vegetation chunks: one InstancedMesh each ---- */
  // template: three crossed unit quads, base pivot, uv scaled to one atlas
  // tile (aTile offsets pick the tile per instance)
  const template = (() => {
    const m = new Merge();
    const q = new THREE.PlaneGeometry(1, 1);
    q.translate(0, 0.5, 0);
    for (const ry of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
      E.set(0, ry, 0);
      Q.setFromEuler(E);
      V.set(0, 0, 0);
      S.set(1, 1, 1);
      M.compose(V, Q, S);
      m.add(q, M);
    }
    q.dispose();
    const g = m.geom();
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * TX, uv.getY(i) * 0.5);
    return g;
  })();
  const LAYER_NOREF = 1;
  for (let k = 0; k < nChunks; k++) {
    const b = chunks[k];
    if (!b || !b.m.length) continue;
    const g = template.clone();
    g.setAttribute("aTile",
      new THREE.InstancedBufferAttribute(new Float32Array(b.tile), 2));
    const im = new THREE.InstancedMesh(g, folMat, b.m.length);
    for (let i = 0; i < b.m.length; i++) {
      im.setMatrixAt(i, b.m[i]);
      im.setColorAt(i, C.setRGB(b.col[i * 3], b.col[i * 3 + 1], b.col[i * 3 + 2]));
    }
    im.computeBoundingSphere();
    im.castShadow = false;
    im.layers.set(LAYER_NOREF);
    const group = new THREE.Group();
    group.add(im);
    const zc = cor.ZB0 + (k + 0.5) * CHUNK_VEG;
    scene.add(group);
    world.chunks.push({ group, cx: cor.centerX(zc), cz: zc });
  }

  /* ======================= NEAR-ROAD CLUTTER ==============================
     The eye-level furniture that flickers past at speed. All of it is on
     the corridor's own lattice discipline (pitches divide LOOP_LEN, rolls
     keyed off the wrapped slot) and skips every real hazard: tunnels, the
     plaza, parapet gaps, ramp boxes, sign masts, and the rail/bridge
     sections that have no coping to stand things on. */
  const clutter = new Merge();
  const boxG = new THREE.BoxGeometry(1, 1, 1);
  const cylG = new THREE.CylinderGeometry(1, 1, 1, 8);
  const put = (
    geo: THREE.BufferGeometry,
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number, ry: number, c: THREE.Color
  ) => {
    E.set(0, ry, 0);
    Q.setFromEuler(E);
    V.set(x, y, z);
    S.set(sx, sy, sz);
    M.compose(V, Q, S);
    clutter.add(geo, M, c);
  };
  const nearSign = (wz: number) => signs.some((s) => Math.abs(wz - s.z) < 7);
  const copingOK = (wz: number, side: 1 | -1) => {
    if (cor.inTunnel(wz, 5) || cor.inToll(wz)) return false;
    const kind = cor.sectionAt(wz);
    if (kind === "rail" || kind === "bridge") return false;
    if (inGap(wz, side)) return false;
    if (side < 0) {
      // the two ramp gores cut the west parapet; their boxes know where
      const w = cor.worldOf(wz, -(cor.halfWidth(wz) + 0.3));
      if (inRampBox(w.x, w.z, 10)) return false;
    }
    return true;
  };

  /* -- utility cabinets / vent stacks on the west coping, every 250 m -- */
  for (const z of cor.lattice(250, 115)) {
    const wz = cor.wrapZ(z);
    if (!copingOK(wz, -1) || nearSign(wz)) continue;
    // stay off the SOS-phone lattice — two cabinets on one post is a glitch
    const dSos = Math.abs(
      ((wz - (PHASE.sos ?? 0)) % PITCH.sos + PITCH.sos * 1.5) % PITCH.sos - PITCH.sos / 2);
    if (dSos < 8) continue;
    const r = mulberry32((cor.latticeIndex(z, 250, 115) * 0x9e3779b1 ^ 0x5eed) >>> 0);
    if (r() < 0.3) continue;
    const p = cor.worldOf(z, -(cor.halfWidth(z) + 0.32));
    const h = cor.pose(z).h;
    const kind = r();
    if (kind < 0.55) {
      // junction cabinet: grey-green double box
      put(boxG, p.x, p.y + 1.05 + 0.34, p.z, 0.5, 0.68, 0.9, h, C.set(0x39413a));
      put(boxG, p.x, p.y + 1.05 + 0.15, p.z, 0.54, 0.3, 0.96, h, C.set(0x2b3130));
    } else if (kind < 0.85) {
      // squat vent stack with a rain cap
      put(cylG, p.x, p.y + 1.05 + 0.45, p.z, 0.16, 0.9, 0.16, 0, C.set(0x474d55));
      put(cylG, p.x, p.y + 1.05 + 0.95, p.z, 0.26, 0.1, 0.26, 0, C.set(0x30353c));
    } else {
      // hydrant/standpipe cabinet: the red one
      put(boxG, p.x, p.y + 1.05 + 0.4, p.z, 0.44, 0.8, 0.66, h, C.set(0x6e1f1a));
    }
  }

  /* -- guardrail end blocks where a railing section hands back to concrete --
     A rail run's open end against a solid parapet face is the one seam the
     eye catches on every lap; a real road bolts a ramped terminal there. */
  for (const s of cor.sections()) {
    if (s.kind !== "rail") continue;
    for (const end of [s.z0, s.z1]) {
      for (const side of [1, -1] as const) {
        for (const z of copies(end)) {
          const wz = cor.wrapZ(z);
          if (cor.inTunnel(wz, 4) || cor.inToll(wz) || inGap(wz, side, 3)) continue;
          const off = end === s.z0 ? -1.1 : 1.1;
          const p = cor.worldOf(z + off, side * (cor.halfWidth(z + off) + 0.16));
          const h = cor.pose(z + off).h;
          put(boxG, p.x, p.y + 0.55, p.z, 0.3, 1.06, 1.9, h, C.set(0x565b63));
          put(boxG, p.x, p.y + 1.02, p.z, 0.34, 0.14, 2.1, h, C.set(0x3b4046));
        }
      }
    }
  }

  /* -- kilometre plates: one per km, west coping, nudged clear of hazards -- */
  const kmTex = makeTex(256, 256, (ctx) => {
    for (let i = 0; i < 4; i++) {
      const x = (i % 2) * 128, y = Math.floor(i / 2) * 128;
      ctx.fillStyle = "#0d4f31";
      ctx.fillRect(x + 10, y + 10, 108, 108);
      ctx.strokeStyle = "#dfe8df";
      ctx.lineWidth = 5;
      ctx.strokeRect(x + 16, y + 16, 96, 96);
      ctx.fillStyle = "#eef4ee";
      ctx.textAlign = "center";
      ctx.font = "bold 62px sans-serif";
      ctx.fillText(String(i + 1), x + 64, y + 78);
      ctx.font = "22px sans-serif";
      ctx.fillText("km", x + 64, y + 104);
    }
  });
  const kmM = new Merge();
  const kmQuad = new THREE.PlaneGeometry(1, 1);
  [-1000, 0, 1000, 2000].forEach((wz0, i) => {
    // walk outward from the nominal kilometre point until the coping is real
    let wz: number | null = null;
    for (const d of [0, -24, 24, -48, 48, -72, 72, -96, 96]) {
      const c = cor.wrapZ(wz0 + d);
      if (copingOK(c, -1) && !nearSign(c)) { wz = c; break; }
    }
    if (wz === null) return;
    for (const z of copies(wz)) {
      const p = cor.worldOf(z, -(cor.halfWidth(z) + 0.34));
      const h = cor.pose(z).h;
      put(cylG, p.x, p.y + 1.05 + 0.42, p.z, 0.05, 0.84, 0.05, 0, C.set(0x3d4148));
      const pg = kmQuad.clone();
      const uv = pg.attributes.uv as THREE.BufferAttribute;
      for (let k2 = 0; k2 < uv.count; k2++)
        uv.setXY(k2,
          (i % 2) * 0.5 + uv.getX(k2) * 0.5,
          (i < 2 ? 0.5 : 0) + uv.getY(k2) * 0.5);
      // face oncoming traffic (the driver approaches from −z of the plate)
      E.set(0, h + Math.PI, 0);
      Q.setFromEuler(E);
      V.set(p.x, p.y + 1.05 + 0.62, p.z);
      S.set(0.52, 0.52, 1);
      M.compose(V, Q, S);
      kmM.add(pg, M);
      pg.dispose();
    }
  });
  kmQuad.dispose();
  if (!kmM.empty) {
    const km = new THREE.Mesh(
      kmM.geom(),
      new THREE.MeshStandardMaterial({ map: kmTex, roughness: 0.6, metalness: 0.2 })
    );
    scene.add(km);
  }

  if (!clutter.empty) {
    const m = new THREE.Mesh(
      clutter.geom(),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 })
    );
    scene.add(m);
  }

  /* -- gutter weeds: tufts breaking out of the parapet base ----------------
     The closest, fastest-moving detail on the lap — a tuft at the shoulder
     edge crosses the whole windshield in a third of a second at speed. On
     the pavement side of the wall at the gutter line, exactly where a real
     deck grows them. They ride the player's beams (addBeam on the foliage
     material) so the near ones catch the headlights on the way past. */
  {
    const slots: { z: number; side: 1 | -1; w: number; h: number; mir: number; tone: number }[] = [];
    for (const z of cor.lattice(40, 13)) {
      const wz = cor.wrapZ(z);
      const r = mulberry32((cor.latticeIndex(z, 40, 13) * 0x85ebca6b ^ 0x9eed) >>> 0);
      for (const side of [1, -1] as const) {
        if (r() < 0.62) continue;
        if (cor.inTunnel(wz, 4) || cor.inToll(wz)) continue;
        if (cor.sectionAt(wz) === "bridge" || inGap(wz, side, 4)) continue;
        if (side < 0) {
          const w = cor.worldOf(wz, -(cor.halfWidth(wz) + 0.2));
          if (inRampBox(w.x, w.z, 10)) continue;
        }
        const n = r() < 0.3 ? 2 : 1;
        for (let k = 0; k < n; k++)
          slots.push({
            z: z + (r() * 14 - 7), side,
            w: 0.5 + r() * 0.6, h: 0.32 + r() * 0.42,
            mir: r() < 0.5 ? -1 : 1, tone: 0.6 + r() * 0.55,
          });
      }
    }
    const weedLevel = Math.max(0.4, level);
    const kept = slots.filter((_, i) => (i % 10) / 10 < weedLevel);
    if (kept.length) {
      const g = new THREE.PlaneGeometry(1, 1);
      g.translate(0, 0.5, 0);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++)
        uv.setXY(i, TILE.bush[0] + uv.getX(i) * TX, TILE.bush[1] + uv.getY(i) * 0.5);
      // aTile must exist for folMat's shader; the uv already sits on the tile
      g.setAttribute("aTile",
        new THREE.InstancedBufferAttribute(new Float32Array(kept.length * 2), 2));
      const im = new THREE.InstancedMesh(g, folMat, kept.length);
      kept.forEach((s, i) => {
        const lat = s.side * (cor.halfWidth(s.z) - 0.28);
        const p = cor.worldOf(s.z, lat);
        E.set(0, cor.pose(s.z).h + (rng() < 0.5 ? 0 : Math.PI / 2), 0);
        Q.setFromEuler(E);
        V.set(p.x, p.y + 0.02, p.z);
        S.set(s.w * s.mir, s.h, s.w);
        M.compose(V, Q, S);
        im.setMatrixAt(i, M);
        im.setColorAt(i, C.setScalar(s.tone));
      });
      im.computeBoundingSphere();
      im.frustumCulled = false; // spans the whole loop; cheap enough to keep
      im.layers.set(LAYER_NOREF);
      scene.add(im);
    }
  }

  boxG.dispose();
  cylG.dispose();
}
