import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { type Rng } from "../util";
import { makeTex, asphalt, signTexF, exitSignTexF, warnTexF, roadWordTexF } from "../textures";
import { RAMP_W, CONNECT_Z } from "./const";
import { parapetGap } from "./ramps";
import {
  getCorridor, assertPitches, signPlan, PITCH, PHASE, SIGN, TUNNEL, TOLL, TOLL_PLAZA,
  type Station,
} from "./corridor";
import type { Mats } from "./mats";
import type { WorldData } from "./data";
import type { Terrain } from "./terrain";
import { worldTierCaps } from "../settings";
import { buildRoadDecals } from "./decals";

const EXIT_NAMES = ["中野 Nakano", "本町 Honchō"];
const LAYER_NOREF = 1;

/* One-way elevated expressway.

   Everything here is swept along the corridor stations (see corridor.ts) —
   pavement, fascia, parapets, markings, tunnel tube and toll plaza — so the
   deck's varying width, its sweeping bends and its grade changes are all
   handled by the same code path and nothing can drift out of alignment with
   what physics queries.

   The deck is emitted in ~300 m chunks so frustum culling keeps only a few
   metres of road in the draw list at a time, and it is built DECK_EXT past
   each canonical end so the loop splice is never in view — ahead of the player
   after the wrap, and behind them in the mirrors before it. */

const CHUNK_Z = 300;
/** parapet geometry every N stations (stations are 4 m apart) */
const WALL_EVERY = 2;

/* ---- perf gates -----------------------------------------------------------
   Each flag guards something additive and purely cosmetic: flipping one off
   removes the feature cleanly with no knock-on effects.

   These are the master KILL-SWITCHES. The live per-device decision is made by
   the renderTier caps (settings.worldTierCaps(), resolved once at world-build
   time — same ?tier= override the engine honours): a feature builds only when
   its FX_* flag AND its TierCaps field agree. Everything gated is instanced
   or merged, so the flags mainly trade overdraw (cones, cutout panels) and a
   handful of draw calls. */
/** additive light cones under the streetlight heads (overdraw) */
export const FX_LAMP_CONES = true;
/** procedural jet fans hung from the tunnel ceiling (3 instanced meshes) */
export const FX_JET_FANS = true;
/** perforated-steel sound barriers (alphaTest overdraw; falls back to the old
    translucent slab wall when off) */
export const FX_FENCE_PANELS = true;
/** gantry catwalk decking + floodlight fittings (a few meshes per gantry) */
export const FX_CATWALKS = true;
/** photoscanned GLB props: jersey barriers + toll floodlights (async loads,
    ~2 MB of textures; skipping them also skips the download and swaps in
    procedural stand-ins — the colliders are identical either way) */
export const FX_PROP_MODELS = true;
/** toll canopy underside lighting (glow points + emissive strips) */
export const FX_TOLL_GLOW = true;
/** road-realism decal overlays: cracks, oil stains, covers, wall streaks */
export const FX_ROAD_DECALS = true;
/** per-lamp sodium ground pools on the deck under the cobra heads */
export const FX_LAMP_POOLS = true;

/** Load a photoscan prop and hand back its meshes (geometry still in the
    file's local space). Failure-tolerant like the PBR sets: a missing file
    simply never calls back, and the world stands without the prop. */
function loadProp(
  url: string,
  cb: (meshes: { geo: THREE.BufferGeometry; mat: THREE.Material }[]) => void
) {
  new GLTFLoader().load(
    url,
    (g) => {
      const out: { geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          const geo = m.geometry.clone();
          geo.applyMatrix4(m.matrixWorld);
          out.push({ geo, mat: m.material as THREE.Material });
        }
      });
      if (out.length) cb(out);
    },
    undefined,
    () => {}
  );
}

type Vec3 = [number, number, number];

/** growable triangle-soup builder; one per (chunk, material) pair */
class Soup {
  pos: number[] = [];
  uv: number[] = [];
  tri(a: Vec3, b: Vec3, c: Vec3) {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
  quadUv(a: Vec3, b: Vec3, c: Vec3, d: Vec3, ua: number[], ub: number[], uc: number[], ud: number[]) {
    this.quad(a, b, c, d);
    this.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    this.uv.push(ua[0], ua[1], uc[0], uc[1], ud[0], ud[1]);
  }
  get empty() {
    return this.pos.length === 0;
  }
  geom(withUv: boolean) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    if (withUv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/* Sign mounting.

   The old signs were posted at a fixed lateral offset, which put their outer
   post past the pavement edge and left it standing in mid-air — up to 2.2 m off
   the deck on the narrow sections. That is what read as "signs on the road,
   glitchy". Every overhead sign is now a cantilever whose dimensions come from
   corridor.SIGN, planted at cor.signPostLat(z):

   - the post stands *outboard* of the parapet, where a real gantry leg goes.
     Inboard of it the post is inside the band a car can still reach (the
     parapet clamp in collide.ts stops the car at hw + 0.06), so it would be
     something you drive straight through — a ghost post beside the lane reads
     as "the sign is on the road" as surely as a misplaced panel does;
   - the arm sits wholly *above* the panel rather than across its face, so no
     two surfaces here are coplanar or near-coplanar;
   - the panel gets a back skin BACK_GAP behind its face, so a sign seen in the
     mirrors after you pass it is a sign, not a hole where one used to be;
   - the panel respects fog. It is a MeshBasicMaterial (a retroreflective board
     stays legible at night), but an unfogged dark-green panel hangs in the haze
     as a hard-edged rectangle at 600 m — the same failure the tunnel portal's
     chevrons had. */
function signFactory(scene: THREE.Scene, cor: ReturnType<typeof getCorridor>) {
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x39404e, roughness: 0.6, metalness: 0.6,
  });
  const backMat = new THREE.MeshStandardMaterial({ color: 0x555c68, roughness: 0.8 });
  const { CLEAR, POST_T, ARM_X, ARM_T, BACK_GAP } = SIGN;
  return function board(z: number, w: number, h: number, tex: THREE.Texture) {
    // a mast this tall would spear the tunnel ceiling, so the tube gets its own
    // signage and never one of these
    if (cor.inTunnel(z)) return null;
    const p = cor.worldOf(z, cor.signPostLat(z));
    const top = CLEAR + h; // panel top; the arm sits on it, the post above that
    const mastH = top + ARM_T + 0.12;
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.BoxGeometry(POST_T, mastH, POST_T), postMat);
    post.position.y = mastH / 2;
    post.castShadow = true;
    g.add(post);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(w + ARM_X + 0.3, ARM_T, ARM_T), postMat);
    arm.position.set(w / 2 + ARM_X, top + ARM_T / 2, 0);
    g.add(arm);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex }));
    panel.position.set(w / 2 + ARM_X, CLEAR + h / 2, -BACK_GAP / 2);
    panel.rotation.y = Math.PI; // face oncoming traffic
    g.add(panel);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), backMat);
    back.position.set(w / 2 + ARM_X, CLEAR + h / 2, BACK_GAP / 2);
    g.add(back);
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = cor.pose(z).h;
    scene.add(g);
    return g;
  };
}

/** A flat, road-hugging quad whose texture reads "up the road".

   Getting this wrong is subtle and very visible. Setting `rotation.x = -π/2`
   and `rotation.z = -h` on a plane composes (XYZ order) to a frame whose
   lateral axis is (cos h, 0, +sin h) — mirrored about the corridor normal, so
   every road decal on a curve sat skewed by twice the heading. Baking the
   plane flat in the geometry instead leaves one honest yaw to apply. */
function flatQuad(w: number, l: number) {
  const g = new THREE.PlaneGeometry(w, l);
  g.rotateX(-Math.PI / 2); // face up
  g.rotateY(Math.PI); // texture "up" now points along +z, i.e. down the road
  return g;
}

export function buildHighway(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  rng: Rng
) {
  const cor = getCorridor();
  assertPitches();
  /* per-device world-dressing caps; every FX_* flag below is ANDed with its
     cap so the FX_ constants stay usable as master kill-switches */
  const caps = worldTierCaps();
  const { concDark, soundwall, hwy } = mats;
  const add = (b: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }) =>
    world.colliders.addAabb(b);
  const ST = cor.stations;

  /* The stock highway texture has six lanes painted into it, which is no use
     when the lane count changes every few hundred metres. Swap in bare asphalt
     and lay the markings down as geometry instead; the material itself (and so
     its wet-road reflection hookup) is untouched. */
  const deckTex = makeTex(256, 256, (ctx, w, h) => asphalt(ctx, w, h, "#14161c"), true);
  hwy.map = deckTex;
  hwy.needsUpdate = true;
  const TILE = 7; // metres per texture tile

  /** world point at station i, `lat` metres to the right of the centreline */
  const pt = (i: number, lat: number, dy = 0): Vec3 => {
    const s = ST[i];
    return [s.x + s.nx * lat, s.y + dy, s.z + s.nz * lat];
  };

  /* ---------------- deck: pavement, fascia, parapets, markings ------------- */
  // shared from mats: it carries the headlight-retroreflection shader, and the
  // polygonOffset/depthWrite flags this geometry needs are set there
  const markMat = mats.markMat;
  /* Shared double-sided variants rather than local clones: the photo-scan
     concrete arrives asynchronously and can only reach materials mats.ts still
     holds a reference to, so a clone made here would stay flat while the road
     around it went photoreal. These carry the identical colour/roughness. */
  const fasciaMat = mats.concDouble;
  const wallMat = mats.barrierDouble;

  const WALL_H = 1.05, WALL_T = 0.34, DECK_TH = 1.15;
  /** stations where a parapet must not be drawn (the ramp divergence zones) */
  const gapZ = terrain.ramps.map(parapetGap);
  const wallOk = (z: number, east: boolean) => {
    if (east) return true; // ramps only ever leave on the west side
    for (const g of gapZ) if (z > g.z0 && z < g.z1) return false;
    return true;
  };
  /** the tunnel supplies its own walls, so skip the parapet through it */
  const inTube = (z: number) => z > TUNNEL.z0 - 3 && z < TUNNEL.z1 + 3;

  const chunkOf = (z: number) => Math.floor(z / CHUNK_Z);
  const road = new Map<number, Soup>();
  const fascia = new Map<number, Soup>();
  const walls = new Map<number, Soup>();
  const marks = new Map<number, Soup>();
  const soup = (m: Map<number, Soup>, c: number) => {
    let s = m.get(c);
    if (!s) m.set(c, (s = new Soup()));
    return s;
  };

  for (let i = 0; i < ST.length - 1; i++) {
    const a = ST[i], b = ST[i + 1];
    const c = chunkOf(a.z);
    // pavement
    const la = pt(i, -a.hw), ra = pt(i, a.hw);
    const lb = pt(i + 1, -b.hw), rb = pt(i + 1, b.hw);
    soup(road, c).quadUv(
      la, lb, rb, ra,
      [0, a.s / TILE], [0, b.s / TILE],
      [(2 * b.hw) / TILE, b.s / TILE], [(2 * a.hw) / TILE, a.s / TILE]
    );
    // fascia: the box girder under the deck
    const lad = pt(i, -a.hw - 0.5, -DECK_TH), rad = pt(i, a.hw + 0.5, -DECK_TH);
    const lbd = pt(i + 1, -b.hw - 0.5, -DECK_TH), rbd = pt(i + 1, b.hw + 0.5, -DECK_TH);
    const F = soup(fascia, c);
    F.quad(la, lb, lbd, lad); // west side
    F.quad(ra, rad, rbd, rb); // east side
    F.quad(lad, lbd, rbd, rad); // soffit
    // parapets
    if (i % WALL_EVERY === 0 && i + WALL_EVERY < ST.length && !inTube(a.z)) {
      const e = ST[i + WALL_EVERY];
      for (const sgn of [-1, 1]) {
        if (!wallOk(a.z, sgn > 0)) continue;
        const W = soup(walls, c);
        const lo = sgn * (a.hw + WALL_T / 2 + 0.06), hi = sgn * (e.hw + WALL_T / 2 + 0.06);
        const a0 = pt(i, lo - sgn * WALL_T / 2), a1 = pt(i, lo + sgn * WALL_T / 2);
        const b0 = pt(i + WALL_EVERY, hi - sgn * WALL_T / 2);
        const b1 = pt(i + WALL_EVERY, hi + sgn * WALL_T / 2);
        const up = (p: Vec3): Vec3 => [p[0], p[1] + WALL_H, p[2]];
        const dn = (p: Vec3): Vec3 => [p[0], p[1] - 0.3, p[2]];
        W.quad(dn(a0), dn(b0), up(b0), up(a0));
        W.quad(dn(a1), dn(b1), up(b1), up(a1));
        W.quad(up(a0), up(b0), up(b1), up(a1));
      }
    }
  }

  /* ---- lane markings ---- */
  {
    const stripe = (z0: number, z1: number, lat0: number, lat1: number, w: number) => {
      const M = soup(marks, chunkOf(z0));
      const p0 = cor.worldOf(z0, lat0 - w / 2), p1 = cor.worldOf(z0, lat0 + w / 2);
      const p2 = cor.worldOf(z1, lat1 + w / 2), p3 = cor.worldOf(z1, lat1 - w / 2);
      const Y = 0.022;
      M.quadUv(
        [p0.x, p0.y + Y, p0.z], [p3.x, p3.y + Y, p3.z],
        [p2.x, p2.y + Y, p2.z], [p1.x, p1.y + Y, p1.z],
        [0, 0], [0, 1], [1, 1], [1, 0]
      );
    };
    // solid edge lines down both shoulders
    const E = PITCH.edge;
    for (const z of cor.lattice(E)) {
      if (z + E > cor.ZB1) continue;
      const h0 = cor.halfWidth(z) - 0.45, h1 = cor.halfWidth(z + E) - 0.45;
      stripe(z, z + E, -h0, -h1, 0.2);
      stripe(z, z + E, h0, h1, 0.2);
    }
    // dashed lane boundaries; a boundary only exists once its lane is real
    const DASH = 6;
    for (const z of cor.lattice(PITCH.dash)) {
      if (z + DASH > cor.ZB1) continue;
      const nf = cor.laneCount(z);
      for (let k = 1; k < Math.ceil(nf - 0.35); k++)
        stripe(z, z + DASH, cor.laneEdge(k, z), cor.laneEdge(k, z + DASH), 0.16);
    }

    /* Raised retroreflective markers down every line.
       These are what actually carry a night motorway: the painted dashes fall
       off into the dark within a few car lengths, but a receding row of studs
       stays readable all the way to the vanishing point and gives the lane a
       shape to aim down.

       They ride the dash lattice rather than a pitch of their own: any spacing
       here must divide LOOP_LEN or the row falls out of phase across the
       splice and the teleport shows up as a stutter in the markers. The phase
       drops each stud into the gap between two dashes, which is where a real
       one is set so tyres track over paint or stud but never both.

       The run is split at the tunnel mouths into two clouds. Only the open-air
       one is registered in neonMats for daylight dimming — a real cat's eye is
       a dull grey lump at noon and only lights up when a headlight is pointed
       into it. Inside the tube it is night at every hour, so dimming those
       would blank the lane guidance exactly where the driver has least else to
       steer by, which is why the ceiling battens are not registered either. */
    const studPts: number[] = [], tubePts: number[] = [];
    for (const z of cor.lattice(PITCH.dash, DASH + (PITCH.dash - DASH) / 2)) {
      if (z > cor.ZB1) continue;
      const into = cor.inTunnel(z) ? tubePts : studPts;
      const lats = [cor.halfWidth(z) - 0.45, -(cor.halfWidth(z) - 0.45)];
      for (let k = 1; k < Math.ceil(cor.laneCount(z) - 0.35); k++) lats.push(cor.laneEdge(k, z));
      for (const lat of lats) {
        const p = cor.worldOf(z, lat);
        into.push(p.x, p.y + 0.05, p.z);
      }
    }
    for (const [pts, mat] of [
      [studPts, mats.studMat], [tubePts, mats.studMatTunnel],
    ] as const) {
      if (!pts.length) continue;
      const sg = new THREE.BufferGeometry();
      sg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
      const studs = new THREE.Points(sg, mat);
      studs.layers.set(LAYER_NOREF);
      studs.frustumCulled = false;
      scene.add(studs);
    }
    world.neonMats.push(mats.studMat); // open-air only; the tube's stay lit
  }

  /* ---- lane-drop tapers: solid diagonal + hatching + merge arrows ---- */
  /* Merge arrow. It bends to the *driver's right*, which is the only direction
     it is ever wanted: lanes stay centred on the alignment, so the lane that
     runs out at a taper is always the outermost one on the left, and the exit
     gore is always on the right too. Canvas +x is the driver's right once the
     quad is laid down by flatQuad(). */
  const arrowTex = makeTex(96, 192, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(235,240,248,.92)";
    ctx.lineWidth = 14;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(w / 2, h - 14);
    ctx.quadraticCurveTo(w / 2, h * 0.4, w * 0.76, h * 0.2);
    ctx.stroke();
    ctx.fillStyle = "rgba(235,240,248,.92)";
    ctx.beginPath();
    ctx.moveTo(w * 0.94, h * 0.22);
    ctx.lineTo(w * 0.58, h * 0.05);
    ctx.lineTo(w * 0.62, h * 0.36);
    ctx.closePath();
    ctx.fill();
  });
  const arrowMat = new THREE.MeshBasicMaterial({
    map: arrowTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  mats.addBeam(arrowMat, { near: 18, far: 62, spread: 0.95 }); // same paint
  const decal = (z: number, lat: number, w: number, l: number, mat: THREE.Material) => {
    const p = cor.worldOf(z, lat);
    const m = new THREE.Mesh(flatQuad(w, l), mat);
    m.rotation.y = cor.pose(z).h;
    m.position.set(p.x, p.y + 0.024, p.z);
    m.layers.set(LAYER_NOREF);
    scene.add(m);
    return m;
  };
  /** every stretch where the lane count falls, found by walking the schedule */
  const drops: { z0: number; z1: number }[] = [];
  {
    let prev = cor.laneCount(cor.ZB0), start = -1;
    for (let z = cor.ZB0; z <= cor.ZB1; z += 8) {
      const n = cor.laneCount(z);
      if (n < prev - 0.002 && start < 0) start = z;
      if (start >= 0 && n >= prev - 0.002) {
        drops.push({ z0: start, z1: z });
        start = -1;
      }
      prev = n;
    }
  }
  for (const d of drops) {
    /* Because the lanes stay centred on the alignment, the roadway narrows from
       both sides and the shoulder edge line already draws the converging taper.
       What the driver still needs is the hatched gore filling the lane that is
       running out, so that is what goes down here: chevron bars slanting from
       the last surviving lane boundary out to the shoulder. */
    const outer = (z: number) => cor.halfWidth(z) - 0.5;
    const inner = (z: number) => cor.laneEdge(Math.ceil(cor.laneCount(z) - 0.35) - 1, z);
    const BAR = 0.28, LEAN = 4.5;
    for (let z = d.z0 + 6; z < d.z1 - LEAN; z += 7) {
      const lo = inner(z), hi = outer(z + LEAN);
      if (hi - lo < 0.9) continue;
      const M = soup(marks, chunkOf(z));
      const a0 = cor.worldOf(z, lo), a1 = cor.worldOf(z, lo + BAR);
      const b1 = cor.worldOf(z + LEAN, hi + BAR), b0 = cor.worldOf(z + LEAN, hi);
      const Y = 0.026;
      M.quadUv(
        [a0.x, a0.y + Y, a0.z], [b0.x, b0.y + Y, b0.z],
        [b1.x, b1.y + Y, b1.z], [a1.x, a1.y + Y, a1.z],
        [0, 0], [0, 1], [1, 1], [1, 0]
      );
    }
    /* "Lane ends, merge" arrows in the closing lane, ahead of the taper. The
       taper out of the toll plaza starts only a few metres past it, so without
       the guard these three land on the plaza deck, painted across the gate
       islands and under the canopy. */
    for (let k = 0; k < 3; k++) {
      const z = d.z0 - 30 - k * 26;
      if (z < cor.ZB0) break;
      if (cor.inTunnel(z) || (z > TOLL.plazaZ0 - 6 && z < TOLL.plazaZ1 + 6)) continue;
      decal(z, cor.laneOffset(Math.round(cor.laneCount(z)) - 1, z), 1.6, 3.4, arrowMat);
    }
  }

  /* ---- road text + toll approach striping ----
     Kanji lane text, elongated ~3:1 like the real paint, laid with the same
     retroreflective beam response as every other marking so it blazes when the
     headlights land on it. All of it keeps clear of the tunnel and the plaza
     islands. */
  const wordMat = (word: string) => {
    const m = new THREE.MeshBasicMaterial({
      map: roadWordTexF(word), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mats.addBeam(m, { near: 18, far: 62, spread: 0.95 });
    return m;
  };
  const word = (z: number, lat: number, mat: THREE.Material, chars: number) =>
    decal(z, lat, 1.5, chars * 2.1 + 0.8, mat);
  {
    // speed limit on every lane, three spots well clear of the features
    const m80 = wordMat("80");
    for (const z of [-1180, -240, 1680])
      for (let k = 0; k < Math.round(cor.laneCount(z)); k++)
        word(z, cor.laneOffset(k, z), m80, 2);
    // 料金所 across all lanes as the plaza looms
    const mToll = wordMat("料金所");
    for (let k = 0; k < Math.round(cor.laneCount(1308)); k++)
      word(1308, cor.laneOffset(k, 1308), mToll, 3);
    // per-gate sorting text where the lanes have spread for the gates
    const mEtc = wordMat("ETC"), mGen = wordMat("一般");
    const zSort = 1360, nSort = cor.lanes(zSort);
    for (let k = 0; k < nSort; k++) {
      const etc = k > 0 && k < nSort - 1;
      word(zSort, cor.laneOffset(k, zSort), etc ? mEtc : mGen, etc ? 3 : 2);
    }
    // transverse rumble-bar groups walking down to the gates
    for (const zg of [1302, 1334, 1362, 1382])
      for (let b = 0; b < 3; b++) {
        const z = zg + b * 1.7;
        const hwz = cor.halfWidth(z) - 0.7;
        const M = soup(marks, chunkOf(z));
        const p0 = cor.worldOf(z, -hwz), p1 = cor.worldOf(z, hwz);
        const p2 = cor.worldOf(z + 0.5, hwz), p3 = cor.worldOf(z + 0.5, -hwz);
        const Y = 0.024;
        M.quadUv(
          [p0.x, p0.y + Y, p0.z], [p3.x, p3.y + Y, p3.z],
          [p2.x, p2.y + Y, p2.z], [p1.x, p1.y + Y, p1.z],
          [0, 0], [0, 1], [1, 1], [1, 0]
        );
      }
  }

  /* ---- emit the chunked deck meshes ---- */
  const emit = (
    m: Map<number, Soup>, mat: THREE.Material, uv: boolean,
    shadow: boolean, noRef: boolean
  ) => {
    for (const [, s] of m) {
      if (s.empty) continue;
      const mesh = new THREE.Mesh(s.geom(uv), mat);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      if (noRef) mesh.layers.set(LAYER_NOREF);
      scene.add(mesh);
    }
  };
  emit(road, hwy, true, false, true);
  emit(fascia, fasciaMat, false, true, false);
  emit(walls, wallMat, false, true, false);
  emit(marks, markMat, true, false, true);

  /* ---------------- piers ---------------- */
  {
    const zs = cor.lattice(PITCH.pier);
    const n = zs.length;
    const pier = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1.15, 1.4, 1, 10), concDark, n);
    const beams = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1.1, 2.4), concDark, n);
    const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(),
      E = new THREE.Euler(), S = new THREE.Vector3();
    let k = 0;
    for (const z of zs) {
      const p = cor.pose(z);
      const gy = terrain.h(p.x, z);
      const hgt = Math.max(1.5, p.y - 1.4 - gy);
      E.set(0, p.h, 0);
      Q.setFromEuler(E);
      V.set(p.x, gy + hgt / 2, z);
      S.set(1, hgt, 1);
      M.compose(V, Q, S);
      pier.setMatrixAt(k, M);
      V.set(p.x, p.y - 1.75, z);
      S.set(cor.halfWidth(z) * 2 + 3, 1, 1);
      M.compose(V, Q, S);
      beams.setMatrixAt(k, M);
      add({ x0: p.x - 1.4, x1: p.x + 1.4, z0: z - 1.4, z1: z + 1.4, y0: gy, y1: gy + hgt - 1 });
      k++;
    }
    pier.count = beams.count = k;
    pier.castShadow = true;
    pier.computeBoundingSphere();
    beams.computeBoundingSphere();
    scene.add(pier, beams);
  }

  /* ---------------- tunnel ---------------- */
  buildTunnel(scene, mats, world, cor, pt);

  /* ---------------- toll plaza ---------------- */
  buildToll(scene, mats, world, cor);

  /* ---------------- ramps ---------------- */
  const postPts: number[] = [];
  buildRampMeshes(scene, mats, world, terrain, postPts);
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

  /* ---------------- exit treatment ---------------- */
  const goreMat = new THREE.MeshBasicMaterial({
    map: mats.goreTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  mats.addBeam(goreMat, { near: 18, far: 62, spread: 0.95 }); // same paint
  world.goreBeaconMat = new THREE.SpriteMaterial({
    map: mats.glowTex, color: 0xffb020, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const board = signFactory(scene, cor);
  const exitWordMat = wordMat("出口");
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x39404e, roughness: 0.6, metalness: 0.6 });

  terrain.ramps.forEach((r) => {
    const isExit = r.kind === "exit";
    const gi = CONNECT_Z.indexOf(r.zr);
    const name = EXIT_NAMES[gi] || "出口";
    const lat = -(cor.halfWidth(r.zr) - 1.9);
    if (isExit) world.exits.push({ z: r.zr, no: gi + 1, name });
    // painted gore chevrons at the nose
    const gp = cor.worldOf(r.zr + (isExit ? 4 : -4), lat);
    const gore = new THREE.Mesh(flatQuad(3.2, 6.4), goreMat);
    gore.rotation.y = cor.pose(r.zr).h + (isExit ? 0 : Math.PI);
    gore.position.set(gp.x, gp.y + 0.03, gp.z);
    gore.layers.set(LAYER_NOREF);
    scene.add(gore);
    // amber beacon on the nose
    const bp = cor.worldOf(r.zr, -(cor.halfWidth(r.zr) - 0.5));
    const bea = new THREE.Sprite(world.goreBeaconMat!);
    bea.scale.set(1.9, 1.9, 1);
    bea.position.set(bp.x, bp.y + 1.9, bp.z);
    scene.add(bea);

    // decel-lane arrows leading into the exit, and 出口 painted in the lane
    if (isExit) {
      for (let k = 0; k < 3; k++) decal(r.zr - 34 - k * 26, lat + 0.5, 1.6, 3.4, arrowMat);
      word(r.zr - 122, lat + 0.5, exitWordMat, 2);
    }
    // ground-level sign at the ramp foot
    const gx = r.footX - 6, gz = r.footZ + (isExit ? -1 : 1) * (RAMP_W / 2 + 2.4);
    const gpole = new THREE.Mesh(new THREE.BoxGeometry(0.24, 3.6, 0.24), postMat);
    gpole.position.set(gx, terrain.h(gx, gz) + 1.8, gz);
    scene.add(gpole);
    const gb = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.8),
      new THREE.MeshBasicMaterial({
        map: signTexF("首都高", isExit ? "OUT ↓" : "IN ↑") }));
    gb.position.set(gx, terrain.h(gx, gz) + 3.4, gz);
    gb.rotation.y = Math.PI / 2;
    scene.add(gb);
  });

  /* Cantilever boards. The plan — which board, where, how big — lives in
     corridor.signPlan() so the browser-free checks can assert the real
     placement rather than a copy of it. */
  for (const s of signPlan()) {
    const nm = (EXIT_NAMES[s.gore] || "出口").split(" ")[0];
    const tex =
      s.kind === "exit-count" ? exitSignTexF(s.gore + 1, s.dist + " m", nm)
        : s.kind === "exit-gore" ? exitSignTexF(s.gore + 1, "出口", nm)
          : s.kind === "merge" ? warnTexF("合流注意", "MERGING TRAFFIC")
            : warnTexF("料金所 " + s.dist + " m", "TOLL");
    board(s.z, s.w, s.h, tex);
  }

  /* ---------------- deck dressing ---------------- */
  /* Edge reflectors, on top of the parapet rather than 40 cm inside the
     pavement edge — where they were, they were below the barrier's top and so
     buried in it from most angles. */
  {
    const pts: number[] = [];
    for (const z of cor.lattice(PITCH.reflector)) {
      if (cor.inTunnel(z)) continue;
      const hw = cor.halfWidth(z) + 0.23;
      const a = cor.worldOf(z, -hw), b = cor.worldOf(z, hw);
      pts.push(a.x, a.y + 1.02, a.z, b.x, b.y + 1.02, b.z);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    /* studTex rather than glowTex: a delineator is a small hard reflector, and
       the soft radial blob read as a hazy lamp rather than a point. The crisp
       core is what makes a line of these recede as distinct dots instead of
       smearing together. Retroreflective like the deck studs, and given the
       same long range — these are the last thing still visible far ahead. */
    const rm = new THREE.PointsMaterial({
      size: 2.2, sizeAttenuation: false, color: 0xffb055, map: mats.studTex,
      transparent: true, opacity: 0.85, fog: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mats.addBeam(rm, { near: 45, far: 210, spread: 0.4 });
    const rp = new THREE.Points(rg, rm);
    rp.frustumCulled = false;
    scene.add(rp);
    world.reflMat = rm;
  }
  // sign gantries
  {
    const gMat = new THREE.MeshStandardMaterial({ color: 0x3a404c, roughness: 0.6, metalness: 0.4 });
    const words = ["箱崎 Hakozaki", "新宿 Shinjuku", "渋谷 Shibuya", "湾岸線 Wangan"];
    /* Shared fittings for the catwalk + floodlight dressing: one material set
       for every gantry, so the extra meshes cost draw calls but no compiles. */
    const floodFaceMat = new THREE.MeshBasicMaterial({ color: 0xe8f1ff, fog: false });
    const floodGlowMat = new THREE.SpriteMaterial({
      map: mats.glowTex, color: 0xcfe4ff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85,
    });
    /** grated walkway deck with UVs in grate tiles (1.2 m pitch) */
    const catwalkGeom = (len: number) => {
      const cg = new THREE.PlaneGeometry(len, 1.1);
      cg.rotateX(-Math.PI / 2);
      const uv = cg.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++)
        uv.setXY(i, uv.getX(i) * (len / 1.2), uv.getY(i) * (1.1 / 1.2));
      return cg;
    };
    for (const z of cor.lattice(PITCH.gantry)) {
      if (cor.inTunnel(z) || cor.inToll(z)) continue;
      if (CONNECT_Z.some((cz) => Math.abs(z - cz) < 220)) continue;
      const p = cor.pose(z);
      const hw = cor.halfWidth(z);
      const g = new THREE.Group();
      // legs straddle the parapet: clear of every lane, and clear of the band a
      // car can still reach when it is scraping the barrier
      const legLat = hw + 0.32;
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.2, 0.5), gMat);
        leg.position.set(s * legLat, 3.6, 0);
        leg.castShadow = true;
        g.add(leg);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(legLat * 2 + 0.9, 0.75, 0.6), gMat);
      beam.position.y = 7.2;
      g.add(beam);
      /* Pick the wording from the *wrapped* lattice index. A random draw here
         would give the gantry 380 m past the splice different text from the
         one 380 m before it — the same structure, relabelled mid-teleport. */
      const w1 = words[cor.latticeIndex(z, PITCH.gantry) % words.length];
      // the deck is only 10.5 m wide where it drops to two lanes, so size the
      // panel to the road rather than hanging it out over the drop
      const sw = Math.min(9, legLat * 2 - 1.4);
      // fogged, and backed, for the same reasons as the cantilever boards
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(sw, sw * 0.29),
        new THREE.MeshBasicMaterial({ map: signTexF(w1, "首都高速 C1") }));
      sign.position.set(0, 5.5, -0.35);
      sign.rotation.y = Math.PI;
      g.add(sign);
      const sBack = new THREE.Mesh(new THREE.PlaneGeometry(sw, sw * 0.29),
        new THREE.MeshStandardMaterial({ color: 0x555c68, roughness: 0.8 }));
      sBack.position.set(0, 5.5, -0.35 + SIGN.BACK_GAP);
      g.add(sBack);
      if (FX_CATWALKS && caps.catwalks !== false) {
        /* Maintenance catwalk along the beam — the detail that makes a gantry
           read as a structure someone climbs rather than a floating goalpost —
           plus a pair of floodlights washing the board. The "light" itself is
           an emissive face + glow sprite, matching the no-new-dynamic-lights
           rule; the board is a MeshBasicMaterial and needs no help. */
        const deckLen = legLat * 2 - 0.8;
        const deck = new THREE.Mesh(catwalkGeom(deckLen), mats.catwalk);
        deck.position.set(0, 7.62, 0.65);
        g.add(deck);
        for (const yr of [8.0, 8.45]) {
          const rail = new THREE.Mesh(new THREE.BoxGeometry(deckLen, 0.05, 0.05), gMat);
          rail.position.set(0, yr, 1.15);
          g.add(rail);
        }
        for (const sx of [-1, 1]) {
          const fl = new THREE.Group();
          fl.position.set(sx * (sw / 2 - 0.4), 7.05, -0.75);
          const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.28), gMat);
          fl.add(body);
          const face = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.16), floodFaceMat);
          face.position.set(0, -0.06, -0.16);
          face.rotation.set(0.7, Math.PI, 0);
          fl.add(face);
          const gl = new THREE.Sprite(floodGlowMat);
          gl.scale.set(1.5, 1.5, 1);
          gl.position.set(0, -0.12, -0.22);
          fl.add(gl);
          g.add(fl);
        }
      }
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.h;
      scene.add(g);
    }
  }
  /* Sound barriers, on the shoulder away from the town. Swept along the
     corridor stations like the rest of the furniture — a straight box drifts
     more than a metre off a curving deck edge over its own length — and kept
     well away from the gores, since a 3 m barrier standing over an exit reads
     as a black panel across the sign line.

     The hero version is a perforated galvanised-mesh screen standing on the
     parapet: an alphaTest cutout (never alpha blend — the depth buffer stays
     honest against every glow sprite behind it), driven by the Fence007A scan
     with a punched-canvas fallback, mast posts every 8 m, and a beam response
     from mats.addBeam so the panels flare as the headlights rake them and die
     away behind the car. UVs run in panel-widths so the scan tiles at life
     size. */
  {
    const SEG = 120, H = 3.0, PANEL_W = 2.4;
    /* the fenceOverdraw cap finally gets its consumer: mobile-base falls back
       to the old translucent slab, shedding the alphaTest overdraw */
    if (FX_FENCE_PANELS && caps.fenceOverdraw) {
      const S = new Soup();
      const postAt: { x: number; y: number; z: number; h: number }[] = [];
      for (const z0 of cor.lattice(PITCH.soundwall)) {
        if (z0 + SEG > cor.ZB1) continue;
        const mid = z0 + SEG / 2;
        if (cor.inTunnel(mid) || cor.inToll(mid)) continue;
        if (CONNECT_Z.some((cz) => Math.abs(mid - cz) < 260)) continue;
        const i0 = Math.round((z0 - cor.ZB0) / 4);
        const i1 = Math.min(ST.length - 1, Math.round((z0 + SEG - cor.ZB0) / 4));
        for (let i = i0; i < i1; i++) {
          // centred over the parapet, rising out of its top (base tucked just
          // below the coping so no sliver of sky shows between them)
          const la = ST[i].hw + 0.23, lb = ST[i + 1].hw + 0.23;
          const y0 = WALL_H - 0.15;
          S.quadUv(
            pt(i, la, y0), pt(i + 1, lb, y0),
            pt(i + 1, lb, y0 + H), pt(i, la, y0 + H),
            [ST[i].s / PANEL_W, 0], [ST[i + 1].s / PANEL_W, 0],
            [ST[i + 1].s / PANEL_W, 1], [ST[i].s / PANEL_W, 1]
          );
          if (i % 2 === 0) {
            const p = ST[i];
            postAt.push({
              x: p.x + p.nx * la, y: p.y + y0, z: p.z + p.nz * la,
              h: Math.atan2(p.tx, p.tz),
            });
          }
        }
      }
      if (!S.empty) {
        const m = new THREE.Mesh(S.geom(true), mats.fence);
        // no castShadow: an alphaTest caster forces alpha-aware depth material
        // work for a shadow nobody can see at night
        scene.add(m);
        // mast posts + a top rail lump, one instanced mesh
        const postG = new THREE.BoxGeometry(0.16, H + 0.3, 0.16);
        const posts = new THREE.InstancedMesh(postG, mats.pole, postAt.length);
        const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(),
          V = new THREE.Vector3(), SC = new THREE.Vector3(1, 1, 1);
        postAt.forEach((p, i) => {
          E.set(0, p.h, 0);
          Q.setFromEuler(E);
          V.set(p.x, p.y + (H + 0.3) / 2 - 0.15, p.z);
          M.compose(V, Q, SC);
          posts.setMatrixAt(i, M);
        });
        posts.computeBoundingSphere();
        scene.add(posts);
      }
    } else {
      // tier fallback: the old translucent polycarbonate slab
      const swMat = soundwall.clone();
      swMat.side = THREE.DoubleSide;
      const S = new Soup();
      for (const z0 of cor.lattice(PITCH.soundwall)) {
        if (z0 + SEG > cor.ZB1) continue;
        const mid = z0 + SEG / 2;
        if (cor.inTunnel(mid) || cor.inToll(mid)) continue;
        if (CONNECT_Z.some((cz) => Math.abs(mid - cz) < 260)) continue;
        const i0 = Math.round((z0 - cor.ZB0) / 4);
        const i1 = Math.min(ST.length - 1, Math.round((z0 + SEG - cor.ZB0) / 4));
        for (let i = i0; i < i1; i++) {
          const la = ST[i].hw + 0.3, lb = ST[i + 1].hw + 0.3;
          S.quad(pt(i, la), pt(i + 1, lb), pt(i + 1, lb, H), pt(i, la, H));
        }
      }
      if (!S.empty) {
        const m = new THREE.Mesh(S.geom(false), swMat);
        m.castShadow = true;
        scene.add(m);
      }
    }
  }

  /* ---------------- streetlights ---------------- */
  const lightPts: number[] = [];
  {
    const poleG = new THREE.CylinderGeometry(0.09, 0.12, 7.6, 6);
    const armG = new THREE.BoxGeometry(1.7, 0.09, 0.09);
    // half a pitch off the lattice origin: the gantry pitch is a multiple of
    // this one, so on phase 0 every gantry would have a light pole inside its leg
    const zs = cor.lattice(PITCH.light, PHASE.light);
    const NP = zs.length;
    const poles = new THREE.InstancedMesh(poleG, mats.pole, NP);
    const arms = new THREE.InstancedMesh(armG, mats.pole, NP);
    /* The head that was always missing: a cobra housing over an emissive lens
       strip. The lens is what your eye reads as "the lamp" from below — the
       glow sprite alone floated in space with no fixture to belong to. */
    const headG = new THREE.BoxGeometry(1.05, 0.15, 0.34);
    const lensG = new THREE.BoxGeometry(0.74, 0.05, 0.24);
    const heads = new THREE.InstancedMesh(headG, mats.pole, NP);
    // fog:true on both lens and cone — an unfogged cone 600 m out renders at
    // full brightness and the row of them reads as a wall of light pyramids
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xffe2b4 });
    const lens = new THREE.InstancedMesh(lensG, lensMat, NP);
    /* Fake volumetric cone under each head: additive, alpha baked into the
       texture, pure overdraw — gated by tier, and the first thing a low tier
       sheds (mobile-high keeps every other one).

       This is the second pass at these. The first pass drew a hard-edged
       orange ribbon — playtest feedback: "you can literally see the lines".
       Three separate hard edges had to die:
       - the START: the old gradient opened at full alpha flush with the
         head, printing a bright horizontal seam. It now fades IN from zero
         over the top ~18% before falling away to the hem;
       - the HEM: brought to zero well above the deck (the ground pools own
         the deck; the cone is only the haze above them);
       - the SILHOUETTE: a cylinder's profile edge shows the mesh outline no
         matter what the texture does, because every ray near the profile
         grazes the same amount of cone. The fresnel-style term in the shader
         patch below zeroes alpha as the view direction goes tangent to the
         surface, which is what dissolves the straight-line outline (and the
         u-seam with it — the seam only ever showed AT the silhouette). */
    const coneTex = makeTex(64, 128, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(255,214,150,0)");
      g.addColorStop(0.18, "rgba(255,214,150,0.30)");
      g.addColorStop(0.55, "rgba(255,214,150,0.12)");
      g.addColorStop(0.88, "rgba(255,214,150,0)");
      g.addColorStop(1, "rgba(255,214,150,0)");
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
    // wider than the first pass (hem 2.05 → 3.0) and peak opacity down: the
    // read is hazy air around the lamp, not a solid shaft
    const coneG = new THREE.CylinderGeometry(0.5, 3.0, 7.1, 14, 1, true);
    /* fog stays ON: with additive blending the night fog colour is near
       black, so fogging is what fades a cone out with distance instead of
       leaving a full-brightness pyramid on the horizon. BackSide only — a
       double-sided cone fills the whole frame with orange the moment the
       camera passes through it, and the far wall alone gives the same read
       from outside at half the overdraw. */
    const coneMat = new THREE.MeshBasicMaterial({
      // warm sodium amber. The old 0xff9e50 came through the ACES grade as
      // salmon — red survives tone-mapping better than green, so the source
      // has to sit further toward yellow than the target colour does.
      map: coneTex, color: 0xffb56a, transparent: true, opacity: 0.26,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.BackSide,
    });
    /* Two shader-side fades:
       - a view-distance fade: driving under a lamp puts the camera inside
         its cone, and even the back wall alone washes half the frame orange;
         fading out inside ~18 m keeps the shafts a mid-distance effect;
       - the fresnel term described above: alpha ∝ |view·normal|^1.5, full
         face-on, zero at the profile edge, so the silhouette has no line to
         draw. (three prepends the normal attribute + normalMatrix uniform to
         every built-in material, so basic can use them.) */
    coneMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>",
          "#include <common>\nvarying float vConeDist;\nvarying vec3 vConeN;\nvarying vec3 vConeV;")
        .replace("#include <project_vertex>",
          "#include <project_vertex>\nvConeDist = -mvPosition.z;\n" +
          "vConeN = normalMatrix * normal;\nvConeV = -mvPosition.xyz;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>",
          "#include <common>\nvarying float vConeDist;\nvarying vec3 vConeN;\nvarying vec3 vConeV;")
        .replace("#include <map_fragment>",
          "#include <map_fragment>\ndiffuseColor.a *= smoothstep(7.0, 19.0, vConeDist);\n" +
          "diffuseColor.a *= pow(abs(dot(normalize(vConeV), normalize(vConeN))), 1.5);");
    };
    coneMat.customProgramCacheKey = () => "lampcone2";
    const wantCones = FX_LAMP_CONES && caps.lampCones !== false;
    const coneEvery = Math.max(1, caps.lampConeEvery ?? 1);
    const cones = wantCones ? new THREE.InstancedMesh(coneG, coneMat, NP) : null;
    /* Ground pools under the cobra heads — the deck-level half of the lamp
       light, and the answer to "spread the lamp light out more". Emitted as
       world-space quads (yaw + grade aligned, elongated down the road) and
       handed to townmesh, which renders them through the SAME material
       instance as the town lamp pools — so the engine's per-frame day/night
       opacity write and sodium tint drive these for free. */
    const wantPools = FX_LAMP_POOLS && caps.lampPoolEvery !== 0;
    const poolEvery = Math.max(1, caps.lampPoolEvery ?? 1);
    const poolPos: number[] = [], poolUv: number[] = [];
    const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(),
      E = new THREE.Euler(), S = new THREE.Vector3(1, 1, 1);
    let n = 0, nc = 0;
    for (const z of zs) {
      if (cor.inTunnel(z) || cor.inToll(z)) continue;
      /* Which side a pole stands on has to be a function of *where* it is, not
         of how many poles have been emitted so far: skipping the tunnel would
         otherwise flip the phase of everything downstream of it, and the two
         sides of the splice would alternate out of step. */
      const li = cor.latticeIndex(z, PITCH.light, PHASE.light);
      const flip = li % 2 ? 1 : -1;
      const p = cor.pose(z);
      // mounted on the parapet, not inside the shoulder where a car scraping
      // the barrier would drive through the pole
      const lat = flip * (cor.halfWidth(z) + 0.23);
      E.set(0, p.h, 0);
      Q.setFromEuler(E);
      V.set(p.x + lat * p.nx, p.y + 3.8, p.z + lat * p.nz);
      M.compose(V, Q, S);
      poles.setMatrixAt(n, M);
      const armLat = lat - flip * 0.8;
      V.set(p.x + armLat * p.nx, p.y + 7.5, p.z + armLat * p.nz);
      M.compose(V, Q, S);
      arms.setMatrixAt(n, M);
      const lampLat = lat - flip * 1.55;
      const lx = p.x + lampLat * p.nx, lz = p.z + lampLat * p.nz;
      lightPts.push(lx, p.y + 7.45, lz);
      V.set(lx, p.y + 7.5, lz);
      M.compose(V, Q, S);
      heads.setMatrixAt(n, M);
      // 7.39, not 7.41: at 7.41 the lens top (7.435) sat inside the head
      // bottom (7.425) and the coplanar overlap z-fought as blue/red banding
      V.set(lx, p.y + 7.39, lz);
      M.compose(V, Q, S);
      lens.setMatrixAt(n, M);
      /* Thinning uses the folded lattice index (not the emit counter) so the
         choice survives the loop splice — and it works in PAIRS: lamp sides
         alternate with li's parity, so a bare li % 2 would strip every cone
         from one side of the road and keep every one on the other. Keeping
         li % (2N) < 2 drops whole pole-pairs instead. */
      const keepNth = (every: number) => li % (2 * every) < 2;
      if (cones && keepNth(coneEvery)) {
        V.set(lx, p.y + 7.45 - 3.55, lz);
        M.compose(V, Q, S);
        cones.setMatrixAt(nc++, M);
      }
      if (wantPools && keepNth(poolEvery)) {
        /* ellipse centred a stride inboard of the head, long axis down the
           road; grade-aligned via the vertical tangent component so neither
           end lifts off a climbing deck */
        const cLat = lampLat - flip * 0.8;
        const cx = p.x + cLat * p.nx, cz = p.z + cLat * p.nz;
        const cy = p.y + 0.055;
        const g = p.grade, tn = 1 / Math.hypot(1, g);
        const tX = p.tx * tn, tY = g * tn, tZ = p.tz * tn; // unit tangent w/ grade
        const A = 3.9;  // lateral half axis
        const B = 5.6;  // longitudinal half axis (elongated along the road)
        const corner = (sa: number, sb: number): [number, number, number] => [
          cx + sa * A * p.nx + sb * B * tX,
          cy + sb * B * tY,
          cz + sa * A * p.nz + sb * B * tZ,
        ];
        const c00 = corner(-1, -1), c10 = corner(1, -1),
          c11 = corner(1, 1), c01 = corner(-1, 1);
        poolPos.push(...c00, ...c10, ...c11, ...c00, ...c11, ...c01);
        poolUv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      }
      n++;
    }
    poles.count = arms.count = heads.count = lens.count = n;
    poles.computeBoundingSphere();
    arms.computeBoundingSphere();
    heads.computeBoundingSphere();
    lens.computeBoundingSphere();
    scene.add(poles, arms, heads, lens);
    if (cones) {
      cones.count = nc;
      cones.computeBoundingSphere();
      scene.add(cones);
    }
    if (poolPos.length) {
      const pg = new THREE.BufferGeometry();
      pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(poolPos), 3));
      pg.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(poolUv), 2));
      deckPoolGeo = pg;
    }
  }

  /* ---------------- road-realism decals ---------------- */
  if (FX_ROAD_DECALS && caps.roadDecals !== false) buildRoadDecals(scene);

  return { deckLightPts: lightPts };
}

/* Handoff for the deck lamp pools. buildTown runs right after buildHighway in
   the same startup call; it takes this geometry and renders it through the
   world.pools material instance so the engine's day/night opacity pass and
   sodium tint reach the deck pools with zero engine changes. One-shot: taking
   it clears it. */
let deckPoolGeo: THREE.BufferGeometry | null = null;
export function takeDeckPoolGeometry(): THREE.BufferGeometry | null {
  const g = deckPoolGeo;
  deckPoolGeo = null;
  return g;
}

/* ============================ tunnel ==================================== */

function buildTunnel(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  cor: ReturnType<typeof getCorridor>,
  pt: (i: number, lat: number, dy?: number) => Vec3
) {
  const H = 6.4; // clear height under the ceiling
  /* Tiled walls, shared from mats so the scanned concrete can reach them (see
     the fascia note above). The material's self-illumination stands in for the
     bounce light a real tunnel gets off its own tiling — without it the tube
     goes pitch black a few metres past the last batten, because the sun and
     moon are both outside. */
  const tileMat = mats.tunnelWall;
  const ceilMat = mats.tunnelCeil;
  const wallS = new Soup(), ceilS = new Soup();
  const i0 = Math.max(0, Math.floor((TUNNEL.z0 - cor.ZB0) / 4));
  const i1 = Math.min(cor.stations.length - 2, Math.ceil((TUNNEL.z1 - cor.ZB0) / 4));
  for (let i = i0; i < i1; i++) {
    const a = cor.stations[i], b = cor.stations[i + 1];
    const wa = a.hw + 0.55, wb = b.hw + 0.55;
    for (const sgn of [-1, 1]) {
      const lo0 = pt(i, sgn * wa), lo1 = pt(i + 1, sgn * wb);
      const hi0 = pt(i, sgn * wa, H), hi1 = pt(i + 1, sgn * wb, H);
      wallS.quad(lo0, lo1, hi1, hi0);
    }
    ceilS.quad(pt(i, -wa, H), pt(i + 1, -wb, H), pt(i + 1, wb, H), pt(i, wa, H));
  }
  const wm = new THREE.Mesh(wallS.geom(false), tileMat);
  const cm = new THREE.Mesh(ceilS.geom(false), ceilMat);
  wm.receiveShadow = true;
  scene.add(wm, cm);

  /* Portal architecture. The bare collar read as a cardboard cut-out; a real
     urban tunnel mouth is a piece of civil engineering — a headwall carrying
     the hill, splayed wing walls, and a rack of signage bolted to the face.
     All of it shares the deck-concrete material so the photoscan reaches it. */
  const portalMat = mats.concDouble;
  for (const z of [TUNNEL.z0, TUNNEL.z1]) {
    const entry = z === TUNNEL.z0;
    // the hill is inside the tube: +z of the entry mouth, -z of the exit one
    const inward = entry ? 1 : -1;
    const p = cor.pose(z);
    const hw = cor.halfWidth(z) + 0.55;
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 3.4, 2.2, 1.6), portalMat);
    top.position.y = H + 1.1;
    g.add(top);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.7, H + 2.2, 1.6), portalMat);
      leg.position.set(s * (hw + 0.85), (H + 2.2) / 2, 0);
      g.add(leg);
    }
    // headwall above and behind the collar, and wing walls splaying off it
    const head = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 13, 5.4, 1.1), portalMat);
    head.position.set(0, H + 2.6, inward * 1.5);
    g.add(head);
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.1, H + 4.4, 7), portalMat);
      wing.position.set(s * (hw + 5.6), (H + 4.4) / 2 - 1.6, inward * 3.4);
      wing.rotation.y = s * 0.42;
      wing.rotation.z = s * 0.05;
      g.add(wing);
    }
    /* Hazard chevrons across the header. This texture has an opaque near-black
       background, so unlike the (bright) sign panels it must respect fog —
       otherwise it stays jet black while the portal around it fades out, and
       reads as a black polygon hanging in the air. */
    const hz = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2 + 3, 1.0),
      new THREE.MeshBasicMaterial({ map: mats.chevTex }));
    // 5 cm off the collar face was close enough to z-fight at distance
    hz.position.set(0, H + 1.1, -0.95);
    hz.rotation.y = Math.PI;
    g.add(hz);
    if (entry) {
      // tunnel name board on the headwall face, over the mouth
      const nameTex = makeTex(512, 96, (ctx, w2, h2) => {
        ctx.fillStyle = "#12312b";
        ctx.fillRect(0, 0, w2, h2);
        ctx.strokeStyle = "#dfe9e4";
        ctx.lineWidth = 4;
        ctx.strokeRect(4, 4, w2 - 8, h2 - 8);
        ctx.fillStyle = "#eef6f1";
        ctx.textAlign = "center";
        ctx.font = '700 44px "Hiragino Sans","Yu Gothic",sans-serif';
        ctx.fillText("汐留トンネル", w2 / 2, 44);
        ctx.font = "700 26px sans-serif";
        ctx.fillText("SHIODOME TN  340m", w2 / 2, 80);
      });
      const name = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 1.4),
        new THREE.MeshBasicMaterial({ map: nameTex }));
      name.position.set(0, H + 2.8, inward * 1.5 - inward * 0.6);
      name.rotation.y = Math.PI;
      g.add(name);
      // clearance board on the left leg, speed roundel on the right
      const clrTex = makeTex(224, 96, (ctx, w2, h2) => {
        ctx.fillStyle = "#d8a41c";
        ctx.fillRect(0, 0, w2, h2);
        ctx.fillStyle = "#171204";
        ctx.textAlign = "center";
        ctx.font = "800 40px sans-serif";
        ctx.fillText("制限高", w2 / 2, 40);
        ctx.fillText("4.5m", w2 / 2, 82);
      });
      const clr = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.75),
        new THREE.MeshBasicMaterial({ map: clrTex }));
      clr.position.set(-(hw + 0.85), 4.1, -0.85);
      clr.rotation.y = Math.PI;
      g.add(clr);
      const spdTex = makeTex(128, 128, (ctx, w2, h2) => {
        ctx.clearRect(0, 0, w2, h2);
        ctx.fillStyle = "#f2f5f9";
        ctx.beginPath();
        ctx.arc(w2 / 2, h2 / 2, 58, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#c81e28";
        ctx.lineWidth = 12;
        ctx.beginPath();
        ctx.arc(w2 / 2, h2 / 2, 50, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#20449c";
        ctx.textAlign = "center";
        ctx.font = "800 56px sans-serif";
        ctx.fillText("60", w2 / 2, h2 / 2 + 20);
      });
      const spd = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95),
        new THREE.MeshBasicMaterial({ map: spdTex, transparent: true }));
      spd.position.set(hw + 0.85, 4.1, -0.85);
      spd.rotation.y = Math.PI;
      g.add(spd);
    }
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = p.h;
    scene.add(g);
  }

  /* Ceiling lighting: twin-tube fluorescent fixtures every 14 m — a dark
     housing carrying two emissive tubes — plus an additive glow sprite, which
     is what actually reads as light without adding real lights to a scene
     that is already at its shadow-caster budget. */
  const battenMat = new THREE.MeshBasicMaterial({ color: 0xfff0cf, fog: false });
  const housingMat = new THREE.MeshStandardMaterial({
    color: 0x272b33, roughness: 0.6, metalness: 0.5 });
  const NL = Math.floor((TUNNEL.z1 - TUNNEL.z0) / 14);
  const housing = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.5, 0.16, 4.9), housingMat, NL);
  const bat = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.07, 4.5), battenMat, NL * 2);
  /* Low wall-washer fittings: the emissive lens the existing glow points were
     always pretending to hang from. */
  const washer = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.55, 0.1, 0.9),
    new THREE.MeshBasicMaterial({ color: 0xffe3ae, fog: false }), NL * 2);
  const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(),
    E = new THREE.Euler(), S = new THREE.Vector3(1, 1, 1);
  const glowPts: number[] = [];
  let n = 0, nt = 0, nw = 0;
  for (let k = 0; k < NL; k++) {
    const z = TUNNEL.z0 + 7 + k * 14;
    const p = cor.pose(z);
    E.set(0, p.h, 0);
    Q.setFromEuler(E);
    V.set(p.x, p.y + H - 0.1, p.z);
    M.compose(V, Q, S);
    housing.setMatrixAt(n++, M);
    for (const s of [-1, 1]) {
      V.set(p.x + s * 0.34 * p.nx, p.y + H - 0.2, p.z + s * 0.34 * p.nz);
      M.compose(V, Q, S);
      bat.setMatrixAt(nt++, M);
    }
    glowPts.push(p.x, p.y + H - 0.3, p.z);
    // wall-washer strips low down on both sides
    for (const sgn of [-1, 1]) {
      const lat = sgn * (cor.halfWidth(z) + 0.5);
      glowPts.push(p.x + lat * p.nx, p.y + 2.6, p.z + lat * p.nz);
      const wlat = sgn * (cor.halfWidth(z) + 0.32);
      V.set(p.x + wlat * p.nx, p.y + 2.72, p.z + wlat * p.nz);
      M.compose(V, Q, S);
      washer.setMatrixAt(nw++, M);
    }
  }
  housing.count = n;
  bat.count = nt;
  washer.count = nw;
  housing.computeBoundingSphere();
  bat.computeBoundingSphere();
  washer.computeBoundingSphere();
  scene.add(housing, bat, washer);

  /* Jet fans, in pairs under the crown. No CC0 model exists for these (the
     asset hunt came back empty), so they are honest geometry: shroud cylinder,
     dark blade disc, ceiling bracket — instanced, three draw calls for all of
     them. At 200 km/h they are silhouettes strobing past the battens, which
     is exactly what they are in life. */
  if (FX_JET_FANS && worldTierCaps().jetFans !== false) {
    const fanZ: number[] = [];
    for (let z = TUNNEL.z0 + 50; z < TUNNEL.z1 - 30; z += 84) fanZ.push(z);
    const NF = fanZ.length * 2;
    const shroudG = new THREE.CylinderGeometry(0.62, 0.62, 2.6, 12, 1, true);
    shroudG.rotateX(Math.PI / 2);
    const shrouds = new THREE.InstancedMesh(shroudG, mats.pole, NF);
    const discG = new THREE.CircleGeometry(0.56, 12);
    const discs = new THREE.InstancedMesh(discG,
      new THREE.MeshStandardMaterial({
        color: 0x14161c, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide }), NF);
    const brackG = new THREE.BoxGeometry(0.22, 1.0, 0.22);
    const bracks = new THREE.InstancedMesh(brackG, mats.pole, NF);
    let nf = 0;
    for (const z of fanZ)
      for (const s of [-1, 1]) {
        const p = cor.pose(z);
        const lat = s * 3.2;
        const fx = p.x + lat * p.nx, fz = p.z + lat * p.nz, fy = p.y + H - 1.15;
        E.set(0, p.h, 0);
        Q.setFromEuler(E);
        V.set(fx, fy, fz);
        M.compose(V, Q, S);
        shrouds.setMatrixAt(nf, M);
        V.set(fx - 1.32 * p.tx, fy, fz - 1.32 * p.tz);
        M.compose(V, Q, S);
        discs.setMatrixAt(nf, M);
        V.set(fx, fy + 0.95, fz);
        M.compose(V, Q, S);
        bracks.setMatrixAt(nf, M);
        nf++;
      }
    shrouds.count = discs.count = bracks.count = nf;
    shrouds.computeBoundingSphere();
    discs.computeBoundingSphere();
    bracks.computeBoundingSphere();
    scene.add(shrouds, discs, bracks);
  }

  /* Emergency-exit boards down the left wall — the single most recognisable
     piece of tunnel furniture there is, and their green is the only colour in
     the tube that is not sodium. Unlit like the battens: it is night in here
     at every hour. */
  {
    const exitTex = makeTex(224, 96, (ctx, w2, h2) => {
      ctx.fillStyle = "#0c7a44";
      ctx.fillRect(0, 0, w2, h2);
      ctx.fillStyle = "#eafff2";
      ctx.textAlign = "center";
      ctx.font = '700 40px "Hiragino Sans",sans-serif';
      ctx.fillText("非常口", w2 / 2 - 24, 60);
      ctx.font = "800 44px sans-serif";
      ctx.fillText("→", w2 - 40, 62);
    });
    const exitMat = new THREE.MeshBasicMaterial({ map: exitTex, fog: false });
    const NE = Math.floor((TUNNEL.z1 - TUNNEL.z0 - 60) / 56);
    const exits = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.2, 0.55), exitMat, NE);
    let ne = 0;
    for (let k = 0; k < NE; k++) {
      const z = TUNNEL.z0 + 44 + k * 56;
      const p = cor.pose(z);
      const lat = -(cor.halfWidth(z) + 0.42);
      E.set(0, p.h + Math.PI / 2, 0);
      Q.setFromEuler(E);
      V.set(p.x + lat * p.nx, p.y + 2.5, p.z + lat * p.nz);
      M.compose(V, Q, S);
      exits.setMatrixAt(ne++, M);
    }
    exits.count = ne;
    exits.computeBoundingSphere();
    scene.add(exits);
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(glowPts), 3));
  const gm = new THREE.PointsMaterial({
    size: 5.5, sizeAttenuation: false, color: 0xffe0a8, map: mats.glowTex,
    transparent: true, opacity: 0.9, fog: false, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const gp = new THREE.Points(gg, gm);
  gp.frustumCulled = false;
  scene.add(gp);
  // deliberately not registered in world.neonMats: the engine dims those with
  // daylight, and a tunnel's lights are exactly the ones that must stay on
}

/* ============================ toll plaza ================================ */

function buildToll(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  cor: ReturnType<typeof getCorridor>
) {
  const add = (b: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }) =>
    world.colliders.addAabb(b);
  const zc = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
  const p0 = cor.pose(zc);
  const hw = cor.halfWidth(zc);
  const lanes = cor.lanes(zc);
  const kerbMat = new THREE.MeshStandardMaterial({ color: 0x6d7484, roughness: 0.75 });
  const boothMat = new THREE.MeshStandardMaterial({
    color: 0xd8dbe2, roughness: 0.5, metalness: 0.2,
    envMap: mats.envMap, envMapIntensity: 0.3 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x1a2836, roughness: 0.15, metalness: 0.8, envMap: mats.envMap,
    envMapIntensity: 0.9, transparent: true, opacity: 0.75,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x3f4653, roughness: 0.55, metalness: 0.6 });
  const boomMat = new THREE.MeshStandardMaterial({
    color: 0xf1f3f7, emissive: 0xff5a3c, emissiveIntensity: 0.35, roughness: 0.6 });

  const plaza = new THREE.Group();
  plaza.position.set(p0.x, p0.y, p0.z);
  plaza.rotation.y = p0.h;
  scene.add(plaza);
  /** local → world for collider boxes (heading is ~0 here by construction) */
  const wx = (lat: number) => p0.x + lat * p0.nx;
  const wz = (lat: number, dz: number) => p0.z + lat * p0.nz + dz;

  /* Islands between every pair of lanes. The gate channel is the corridor's
     lane pitch less the island either side of it, so the room to thread one
     comes from the pitch widening in corridor.ts (lanePitch) rather than from
     shaving the island down to nothing: an island thin enough to give a 4.5 m
     gate on the open road's 3.7 m pitch would be too thin to stand a booth on.
     Every dimension here is shared with the corridor check via TOLL_PLAZA, so
     the clearance it asserts is the clearance actually built. */
  const { kerbW, boothW, islandLen: IL, colliderHw } = TOLL_PLAZA;
  /** warm booth-interior glow points, in plaza-local coordinates */
  const boothGlow: number[] = [];
  for (let k = 1; k < lanes; k++) {
    const lat = cor.laneEdge(k, zc);
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(kerbW, 0.32, IL), kerbMat);
    kerb.position.set(lat, 0.16, 0);
    kerb.castShadow = true;
    plaza.add(kerb);
    add({
      x0: wx(lat) - colliderHw, x1: wx(lat) + colliderHw,
      z0: wz(lat, -IL / 2), z1: wz(lat, IL / 2),
      y0: p0.y - 0.5, y1: p0.y + 3.4,
    });
    // manned booths on the outer islands, bare gate posts on the inner ones
    const manned = k === 1 || k === lanes - 1 || k === 3;
    if (manned) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(boothW, 2.9, 3.4), boothMat);
      b.position.set(lat, 1.77, -1.5);
      b.castShadow = true;
      plaza.add(b);
      // glazing on BOTH faces — the attendant serves whichever lane pays —
      // plus a roof cap and a warm interior glow so the booth reads occupied
      for (const s of [-1, 1]) {
        const gl = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.3), glassMat);
        gl.position.set(lat + s * (boothW / 2 + 0.02), 2.15, -1.5);
        gl.rotation.y = s * Math.PI / 2;
        plaza.add(gl);
      }
      const cap = new THREE.Mesh(new THREE.BoxGeometry(boothW + 0.34, 0.14, 3.7), steel);
      cap.position.set(lat, 3.3, -1.5);
      plaza.add(cap);
      boothGlow.push(lat, 2.3, -1.5);
    } else {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.4), steel);
      post.position.set(lat, 1.1, -2.2);
      plaza.add(post);
    }
    // gate arm, swung up out of the way — every lane is open
    const boom = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 3.4), boomMat);
    boom.position.set(lat, 2.4, 1.6);
    boom.rotation.x = -1.16;
    plaza.add(boom);
    const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.7, 8), steel);
    pivot.position.set(lat, 0.85, 1.6);
    plaza.add(pivot);
  }

  /* Canopy over the whole plaza: corrugated-steel roof deck, brushed-panel
     fascia ring, lit soffit. The roof keeps its box (it carries the shadow);
     the fascia is what the approaching driver actually sees, and the name
     board on it is the "料金所" moment the cantilever warning signs promised. */
  const CW = hw * 2 + 5, CL = TOLL_PLAZA.groupLen;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(CW, 0.9, CL), mats.canopyRoof);
  roof.position.y = 7.4;
  roof.castShadow = true;
  plaza.add(roof);
  for (const [w2, d2, x2, z2] of [
    [CW + 0.3, 0.3, 0, -CL / 2 - 0.05], [CW + 0.3, 0.3, 0, CL / 2 + 0.05],
    [0.3, CL + 0.3, -CW / 2 - 0.05, 0], [0.3, CL + 0.3, CW / 2 + 0.05, 0],
  ] as const) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(w2, 1.3, d2), mats.canopyFascia);
    f.position.set(x2, 7.15, z2);
    plaza.add(f);
  }
  // fascia name board, centred over the middle gate, facing the approach
  const fasciaTex = makeTex(512, 112, (ctx, w2, h2) => {
    ctx.fillStyle = "#173a63";
    ctx.fillRect(0, 0, w2, h2);
    ctx.strokeStyle = "#dfe7f2";
    ctx.lineWidth = 5;
    ctx.strokeRect(5, 5, w2 - 10, h2 - 10);
    ctx.fillStyle = "#f2f7fc";
    ctx.textAlign = "center";
    ctx.font = '800 52px "Hiragino Sans","Yu Gothic",sans-serif';
    ctx.fillText("料金所", w2 / 2, 58);
    ctx.font = "700 30px sans-serif";
    ctx.fillText("TOLL GATE", w2 / 2, 96);
  });
  const fasciaSign = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.55),
    new THREE.MeshBasicMaterial({ map: fasciaTex, fog: false }));
  fasciaSign.position.set(0, 7.15, -CL / 2 - 0.25);
  fasciaSign.rotation.y = Math.PI;
  plaza.add(fasciaSign);
  /* The soffit fakes its own bounce light: nothing dynamic ever reaches it
     (the troffers are emissive props, not lights), so without the emissive
     term the canopy underside is a black slab over a lit plaza. */
  const soffit = new THREE.Mesh(new THREE.BoxGeometry(CW - 1.2, 0.16, CL - 1.2),
    new THREE.MeshStandardMaterial({
      color: 0xe6e9ef, roughness: 0.6,
      emissive: 0x40444e, emissiveIntensity: 1 }));
  soffit.position.y = 6.92;
  plaza.add(soffit);
  /* Underside lighting: rows of emissive troffers plus a cloud of additive
     glow — a real plaza is a pool of flat white light under a dark roof, and
     that read is the whole reason to slow down for it. Not registered in
     neonMats: the canopy shades its own soffit, so these stay lit by day. */
  if (FX_TOLL_GLOW && worldTierCaps().tollGlow !== false) {
    const troffMat = new THREE.MeshBasicMaterial({ color: 0xf4f6ff, fog: false });
    const NTR = 2 * 7;
    const troff = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 0.09, 0.55), troffMat, NTR);
    const TM = new THREE.Matrix4(), TV = new THREE.Vector3(),
      TQ = new THREE.Quaternion(), TS = new THREE.Vector3(1, 1, 1);
    const canopyGlow: number[] = [];
    let ntr = 0;
    for (const sx of [-1, 1])
      for (let j = 0; j < 7; j++) {
        const dz = -CL / 2 + 4 + j * ((CL - 8) / 6);
        TV.set(sx * CW / 4.4, 6.82, dz);
        TM.compose(TV, TQ, TS);
        troff.setMatrixAt(ntr++, TM);
        canopyGlow.push(p0.x + (sx * CW / 4.4) * p0.nx, p0.y + 6.6,
          p0.z + (sx * CW / 4.4) * p0.nz + dz);
      }
    troff.count = ntr;
    troff.computeBoundingSphere();
    plaza.add(troff);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(canopyGlow), 3));
    const cgm = new THREE.PointsMaterial({
      size: 7, sizeAttenuation: false, color: 0xeef2ff, map: mats.glowTex,
      transparent: true, opacity: 0.85, fog: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const cgp = new THREE.Points(cg, cgm);
    cgp.frustumCulled = false;
    scene.add(cgp);
  }
  // canopy columns stand on the outer shoulder — outboard of the widest lane
  // but still on the pavement, so they are not left hanging off the deck edge
  const colLat = hw - 0.75;
  for (const s of [-1, 1])
    for (const dz of [-CL / 2 + 3, CL / 2 - 3]) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.9, 7.4, 0.9), steel);
      col.position.set(s * colLat, 3.7, dz);
      col.castShadow = true;
      plaza.add(col);
      add({
        x0: wx(s * colLat) - 0.55, x1: wx(s * colLat) + 0.55,
        z0: wz(s * colLat, dz) - 0.55, z1: wz(s * colLat, dz) + 0.55,
        y0: p0.y, y1: p0.y + 7.4,
      });
    }

  /* Per-lane overhead signs: green ETC lanes in the middle, purple cash lanes
     on the outside — the colour is the whole read at 200 km/h. */
  const laneSign = (etc: boolean) =>
    makeTex(256, 160, (ctx, w, h) => {
      ctx.fillStyle = etc ? "#0d5a34" : "#4a2069";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#eef4f0";
      ctx.lineWidth = 6;
      ctx.strokeRect(5, 5, w - 10, h - 10);
      ctx.fillStyle = "#f2f8f4";
      ctx.textAlign = "center";
      ctx.font = "800 54px sans-serif";
      ctx.fillText(etc ? "ETC" : "一般", w / 2, 74);
      ctx.font = "700 30px sans-serif";
      ctx.fillText(etc ? "専用" : "CASH", w / 2, 120);
    });
  const etcTex = laneSign(true), cashTex = laneSign(false);
  const sigGreenMat = new THREE.MeshBasicMaterial({ color: 0x3dff8a, fog: false });
  const sigHaloMat = new THREE.SpriteMaterial({
    map: mats.glowTex, color: 0x4dffa0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9,
  });
  const sigHaloWhite = new THREE.SpriteMaterial({
    map: mats.glowTex, color: 0xdfe9ff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8,
  });
  for (let k = 0; k < lanes; k++) {
    const etc = k > 0 && k < lanes - 1;
    const m = new THREE.MeshBasicMaterial({ map: etc ? etcTex : cashTex, fog: false });
    const s = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.8), m);
    s.position.set(cor.laneOffset(k, zc), 5.3, -CL / 2 + 1.2);
    s.rotation.y = Math.PI;
    plaza.add(s);
    /* Lane status signal under each sign: a real fixture — dark housing, a
       hard emissive ↓ lens, an additive halo. Every gate runs green because
       every gate is open (the plaza deliberately never closes a lane the
       player can thread); the housing still carries the dark red-lens slot
       above it, which is what sells it as a signal rather than a lamp. */
    const sig = new THREE.Group();
    sig.position.set(cor.laneOffset(k, zc), 4.15, -CL / 2 + 1.05);
    const hous = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.1, 0.24),
      new THREE.MeshStandardMaterial({ color: 0x1c1f26, roughness: 0.55, metalness: 0.5 }));
    sig.add(hous);
    const red = new THREE.Mesh(new THREE.CircleGeometry(0.17, 12),
      new THREE.MeshStandardMaterial({ color: 0x3a0c0c, roughness: 0.3 }));
    red.position.set(0, 0.26, -0.125);
    red.rotation.y = Math.PI;
    sig.add(red);
    const green = new THREE.Mesh(new THREE.CircleGeometry(0.19, 12), sigGreenMat);
    green.position.set(0, -0.2, -0.125);
    green.rotation.y = Math.PI;
    sig.add(green);
    const halo = new THREE.Sprite(sigHaloMat);
    halo.scale.set(1.3, 1.3, 1);
    halo.position.set(0, -0.2, -0.2);
    sig.add(halo);
    plaza.add(sig);
  }
  // booth interior glow
  if (boothGlow.length) {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(boothGlow), 3));
    const bp = new THREE.Points(bg, new THREE.PointsMaterial({
      size: 5, sizeAttenuation: false, color: 0xffd9a4, map: mats.glowTex,
      transparent: true, opacity: 0.8, fog: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    bp.frustumCulled = false;
    plaza.add(bp);
  }

  /* Photoscanned jersey barriers (two variants alternating, breaking the
     repetition) — crash protection ahead of every island nose, and a
     channelising run down each outer shoulder through the gates. Colliders
     go in immediately so the props are never ghosts; the meshes stream in
     when the GLBs land. */
  {
    interface Slot { lat: number; dz: number; }
    const slotsA: Slot[] = [], slotsB: Slot[] = [];
    for (let k = 1; k < lanes; k++) {
      const lat = cor.laneEdge(k, zc);
      for (let j = 0; j < 3; j++)
        (k % 2 ? slotsA : slotsB).push({ lat, dz: -IL / 2 - 1.3 - j * 1.68 });
      add({
        x0: wx(lat) - colliderHw, x1: wx(lat) + colliderHw,
        z0: wz(lat, -IL / 2 - 6.6), z1: wz(lat, -IL / 2),
        y0: p0.y - 0.5, y1: p0.y + 1.4,
      });
    }
    for (const s of [-1, 1]) {
      const lat = s * (hw - 0.55);
      let j = 0;
      for (let dz = -CL / 2 + 1; dz <= CL / 2 - 1; dz += 1.66, j++)
        (j % 2 ? slotsA : slotsB).push({ lat, dz });
      add({
        x0: wx(lat) - 0.35, x1: wx(lat) + 0.35,
        z0: wz(lat, -CL / 2 + 0.5), z1: wz(lat, CL / 2 - 0.5),
        y0: p0.y - 0.5, y1: p0.y + 1.4,
      });
    }
    const floodSpots = [-CW / 3, -CW / 9, CW / 9, CW / 3];
    if (FX_PROP_MODELS && worldTierCaps().propModels !== false) {
      const place = (slots: Slot[]) => (meshes: { geo: THREE.BufferGeometry; mat: THREE.Material }[]) => {
        const { geo, mat } = meshes[0];
        const im = new THREE.InstancedMesh(geo, mat, slots.length);
        const M = new THREE.Matrix4(), V = new THREE.Vector3(),
          Q = new THREE.Quaternion(), E = new THREE.Euler(0, Math.PI / 2, 0),
          S = new THREE.Vector3(1.05, 1.05, 1.05);
        Q.setFromEuler(E); // the scans run along x; the plaza runs along z
        slots.forEach((sl, i) => {
          V.set(sl.lat, 0, sl.dz);
          M.compose(V, Q, S);
          im.setMatrixAt(i, M);
        });
        im.castShadow = true;
        im.computeBoundingSphere();
        plaza.add(im);
      };
      loadProp("/assets/props/concrete-road-barrier/concrete_road_barrier_1k.gltf", place(slotsA));
      loadProp("/assets/props/concrete-road-barrier-02/concrete_road_barrier_02_1k.gltf", place(slotsB));

      /* Security floodlights along the canopy fascia — the photoscanned heads
         aimed down the approach, with the glow sprites doing the "light". */
      loadProp("/assets/props/security-light/security_light_1k.gltf", (meshes) => {
        const g = new THREE.Group();
        for (const x of floodSpots) {
          for (const { geo, mat } of meshes) {
            const m = mat as THREE.MeshStandardMaterial;
            if (m.name && /glass|bulb/i.test(m.name)) {
              m.emissive = new THREE.Color(0xcfe0ff);
              m.emissiveIntensity = 1.4;
            }
            const mesh = new THREE.Mesh(geo, mat);
            mesh.scale.setScalar(2.2);
            mesh.rotation.set(-2.35, 0, 0);
            mesh.position.set(x, 6.55, -CL / 2 - 0.1);
            g.add(mesh);
          }
          const halo = new THREE.Sprite(sigHaloWhite);
          halo.scale.set(2.2, 2.2, 1);
          halo.position.set(x, 6.35, -CL / 2 - 0.35);
          g.add(halo);
        }
        plaza.add(g);
      });
    } else {
      /* Tier stand-ins: the colliders above are identical, so the plaza plays
         the same — these just make the physics visible without the ~2 MB GLB
         download or the photoscan's texture binds. A jersey barrier is a
         trapezoid to the eye; base slab + narrower cap sells it at speed. */
      const slots = slotsA.concat(slotsB);
      const baseG = new THREE.BoxGeometry(0.62, 0.44, 1.58);
      const capG = new THREE.BoxGeometry(0.28, 0.5, 1.58);
      const base = new THREE.InstancedMesh(baseG, kerbMat, slots.length);
      const cap = new THREE.InstancedMesh(capG, kerbMat, slots.length);
      const M = new THREE.Matrix4(), V = new THREE.Vector3(),
        Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1);
      slots.forEach((sl, i) => {
        V.set(sl.lat, 0.22, sl.dz);
        M.compose(V, Q, S);
        base.setMatrixAt(i, M);
        V.set(sl.lat, 0.69, sl.dz);
        M.compose(V, Q, S);
        cap.setMatrixAt(i, M);
      });
      base.computeBoundingSphere();
      cap.computeBoundingSphere();
      plaza.add(base, cap);
      // floodlight stand-ins: dark housing box + the same halo sprite
      for (const x of floodSpots) {
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.4), steel);
        body.position.set(x, 6.55, -CL / 2 - 0.1);
        body.rotation.x = -0.6;
        plaza.add(body);
        const halo = new THREE.Sprite(sigHaloWhite);
        halo.scale.set(2.2, 2.2, 1);
        halo.position.set(x, 6.35, -CL / 2 - 0.35);
        plaza.add(halo);
      }
    }
  }
  // the approach boards are cantilevers like the exit ones, so they are placed
  // with the rest of the signage from corridor.signPlan()
}

/* ============================ ramp meshes =============================== */

function buildRampMeshes(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  postPts: number[]
) {
  const { concDark, ramp } = mats;
  const surf = new Soup(), skirt = new Soup(), wallS = new Soup();
  const WALL_H = 1.0, WALL_T = 0.3, DECKTH = 0.62;
  const colG = new THREE.BoxGeometry(1.25, 1, 1.25);
  const cols = new THREE.InstancedMesh(colG, concDark, 96);
  const CM = new THREE.Matrix4(), CV = new THREE.Vector3(), CQ = new THREE.Quaternion(),
    CS = new THREE.Vector3(), CE = new THREE.Euler();
  let nCol = 0;

  for (const r of terrain.ramps) {
    const pts = r.pts;
    const edge = (i: number, lat: number, dy = 0): Vec3 => {
      const p = pts[i];
      return [p.x + p.nx * lat, p.y + dy, p.z + p.nz * lat];
    };
    const wallEnd = r.len - 7; // leave the junction with the frontage road open
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const oa = edge(i, -a.hOut), ob = edge(i + 1, -b.hOut);
      const ia = edge(i, a.hIn), ib = edge(i + 1, b.hIn);
      surf.quadUv(oa, ob, ib, ia,
        [0, a.s / 14], [0, b.s / 14], [1, b.s / 14], [1, a.s / 14]);
      // skirt + underside, only where the ramp stands above the ground
      const upA = a.y - a.gy, upB = b.y - b.gy;
      if (upA > 0.25 || upB > 0.25) {
        const da = Math.min(DECKTH, Math.max(0.12, upA));
        const db = Math.min(DECKTH, Math.max(0.12, upB));
        const oab = edge(i, -a.hOut, -da), obb = edge(i + 1, -b.hOut, -db);
        const iab = edge(i, a.hIn, -da), ibb = edge(i + 1, b.hIn, -db);
        skirt.quad(oa, ob, obb, oab);
        skirt.quad(ia, ib, ibb, iab);
        skirt.quad(oab, obb, ibb, iab);
      }
      /* Parapets. The outer one starts at the gore nose and follows the edge as
         it opens away from the deck, so the drop is guarded the whole way. The
         inner one only appears once the ramp has separated — before that the
         deck itself is there. */
      for (const sgn of [-1, 1]) {
        const la = sgn > 0 ? a.hIn : -a.hOut, lb = sgn > 0 ? b.hIn : -b.hOut;
        if (a.s > wallEnd) continue;
        if (sgn > 0 && a.s < r.sSep) continue;
        const off = sgn * (WALL_T / 2 + 0.12);
        const a0 = edge(i, la + off - (sgn * WALL_T) / 2), a1 = edge(i, la + off + (sgn * WALL_T) / 2);
        const b0 = edge(i + 1, lb + off - (sgn * WALL_T) / 2);
        const b1 = edge(i + 1, lb + off + (sgn * WALL_T) / 2);
        const top = (p: Vec3): Vec3 => [p[0], p[1] + WALL_H, p[2]];
        const bot = (p: Vec3): Vec3 => [p[0], p[1] - 0.25, p[2]];
        wallS.quad(bot(a0), bot(b0), top(b0), top(a0));
        wallS.quad(bot(a1), bot(b1), top(b1), top(a1));
        wallS.quad(top(a0), top(b0), top(b1), top(a1));
        // one collider per segment: the outer wall flares out of the gore nose
        // quickly, so a box spanning several segments would cut the corner
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
      if (i % 7 === 0 && upA > 2.2 && nCol < 96) {
        CE.set(0, Math.atan2(a.tx, a.tz), 0);
        CQ.setFromEuler(CE);
        CV.set(a.x, a.gy + (upA - 0.5) / 2, a.z);
        CS.set(1, upA - 0.5, 1);
        CM.compose(CV, CQ, CS);
        cols.setMatrixAt(nCol++, CM);
        world.colliders.addAabb({
          x0: a.x - 0.85, x1: a.x + 0.85, z0: a.z - 0.85, z1: a.z + 0.85,
          y0: 0, y1: a.gy + upA - 1.2,
        });
      }
    }
    // flat apron where the ramp meets the frontage road
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(24, RAMP_W), ramp);
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(r.footX - 11, pts[pts.length - 1].gy + 0.012, r.footZ);
    apron.layers.set(LAYER_NOREF);
    scene.add(apron);
  }
  cols.count = nCol;
  cols.castShadow = true;
  cols.computeBoundingSphere();
  scene.add(cols);

  const sm = new THREE.Mesh(surf.geom(true), ramp);
  sm.receiveShadow = true;
  sm.layers.set(LAYER_NOREF);
  scene.add(sm);
  const sk = new THREE.Mesh(skirt.geom(false), mats.concDarkDouble);
  sk.castShadow = true;
  scene.add(sk);
  const wm = new THREE.Mesh(wallS.geom(false), mats.barrierDouble);
  wm.castShadow = true;
  scene.add(wm);
}

/** Exit HUD helper: the nearest exit ahead, measured along the one-way
    corridor and wrapping across the loop splice. */
export function nearestExitAhead(world: WorldData, z: number, _headingZ?: number) {
  const cor = getCorridor();
  let best: { no: number; name: string; dist: number; z: number } | null = null;
  for (const e of world.exits) {
    let d = cor.deltaZ(z, e.z);
    if (d < -10) d += cor.LOOP;
    if (d > -10 && d < 620 && (!best || d < best.dist))
      best = { no: e.no, name: e.name, dist: d, z: e.z };
  }
  return best;
}

/** Re-export so other systems can read the road without reaching into files. */
export { getCorridor, TUNNEL, TOLL };
export type { Station };
