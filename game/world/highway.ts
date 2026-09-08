import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mulberry32, sstep, type Rng } from "../util";
import {
  makeTex, asphalt, signTexF, exitSignTexF, warnTexF, roadWordTexF,
  guideSignTexF, mergeSignTexF,
} from "../textures";
import { RAMP_W, CONNECT_Z, LOOP_LEN } from "./const";
import { parapetGap } from "./ramps";
import { BYPASS, DIVERGE_Z, MERGE_Z, MOUNTAIN_EDGE, type RouteGraph } from "./routegraph";
import {
  getCorridor, assertPitches, signPlan, roadSeed, PITCH, PHASE, SIGN, TUNNEL, TOLL,
  TOLL_PLAZA, BRIDGE, BRIDGES, OVERPASS, OVERPASSES, MTN, AUX_LANES, AUX_W,
  type SectionKind, type Station,
} from "./corridor";
import type { Mats } from "./mats";
import type { WorldData } from "./data";
import type { Terrain } from "./terrain";
import { worldTierCaps } from "../settings";
import { buildRoadDecals } from "./decals";
import { buildWheelTracks, buildDeckDressing } from "./deckdetail";

const EXIT_NAMES = ["中野 Nakano", "本町 Honchō"];

/** Advance-warning distances for the bypass diverge. Not 1000/500/200 like
    the town exit: a board a kilometre back from z = 500 lands on the town
    exit's own gore, so the run starts at 800 instead. Shared with the
    mastGaps list above so the soundwall lattice steps around the same masts
    the boards are actually built on. */
const BYPASS_BOARD_D = [800, 400, 200];

/** "1 km" / "500 m". A board that says 1000 m reads as a typo. */
function distLabel(d: number) {
  return d >= 1000
    ? (d % 1000 === 0 ? String(d / 1000) : (d / 1000).toFixed(1)) + " km"
    : d + " m";
}
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
/** the cross-street overpasses (corridor.OVERPASSES) — instanced girders,
    piers and street lamps, 4 draw calls for the whole list */
export const FX_OVERPASS = true;
/** interchange high-mast lighting clusters (2 instanced meshes + points) */
export const FX_HIGH_MASTS = true;
/** lane-following tyre-polish ribbons on the deck (one blended overlay) */
export const FX_WHEEL_TRACKS = true;
/** the mountain road (corridor.MTN / routegraph): pavement, rock faces,
    parapet, markings, delineators, gore kit, boards. Physics/route-graph
    attachment is NOT gated by this — killing it leaves an invisible but
    drivable road, which is exactly what a debug bisect wants. */
export const FX_MOUNTAIN = true;
/** procedural deck dressing: patch slabs, skid arcs, gutter grates */
export const FX_DECK_DRESSING = true;

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
  /* 256 → 1024, and the reason is a measurement rather than a preference.
     The deck's uv runs one unit per TILE (7 m), so a 256 px canvas laid 36.6
     texels on a metre of road — a 2.7 cm texel. The dashcam renders about 465
     screen pixels per metre at 2 m and 186 at 5 m, so the base asphalt was
     being MAGNIFIED four to twelve times over the whole stretch of road the
     driver is actually looking at, and no amount of anisotropy fixes a texture
     that simply has fewer texels than the screen has pixels. 1024 puts it at
     146 texels/m, and it also finally puts asphalt()'s own grain at life size:
     its speckle is drawn 1-2.6 px across, which at 256 was a 2.7-7 cm chipping
     and at 1024 is 0.7-1.8 cm — actual aggregate.

     Procedural, so this costs 0 MB of download; it costs ~5 MB of VRAM with
     mips, on a tier that already holds several 1K scans.

     TIER-GATED (TierCaps.deckTexPx), and the reason is bandwidth rather than
     the VRAM the paragraph above budgets. makeTex sets anisotropy 16 on
     everything it produces, and a road seen from a dashcam is the single most
     grazing surface in the frame — which is exactly the geometry that makes
     the sampler take all sixteen taps. At 256² this map plus its mips was
     ~350 KB and sixteen taps landed inside the texture cache for free; at
     1024² the working set is ~5.5 MB and the same sixteen taps go to memory,
     on the surface that covers more of the dashcam frame than anything else.
     That is a per-FRAME cost, not the one-off paint the note above accounts
     for, and it scales with fill — so it lands hardest on exactly the tiers
     that can least afford it.

     Desktop keeps the full 1024 and the measurement above stands unchanged.
     mobile-high takes 512 (73 texels/m — still double what shipped before this
     commit, and still inside magnification range at 5 m), mobile-base 256,
     which is what it had. The paint cost drops with it too: asphalt() is
     O(pixels), and 1024² is sixteen times the work of 256² inside the staged
     loader. */
  const deckPx = caps.deckTexPx ?? 1024;
  const deckTex = makeTex(deckPx, deckPx, (ctx, w, h) => asphalt(ctx, w, h, "#14161c"), true);
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
  /* ---- section dressing ---------------------------------------------------
     corridor.sectionAt(z) says how the deck edge is built over this stretch
     (see the long note in corridor.ts). Three things read off it here:
     how tall the concrete at the edge is, whether a steel railing stands on
     it instead of a parapet, and whether a noise wall stands over it. */
  /** kerb height where a railing replaces the parapet */
  const KERB_H: Partial<Record<SectionKind, number>> = { rail: 0.42, bridge: 0.55 };
  /** solid noise wall height, measured up from the parapet coping */
  const SCREEN_H = 4.6;
  /** railing bands, [height above the kerb top, band depth] */
  const RAIL_BANDS: readonly (readonly [number, number])[] = [
    [0.10, 0.09], [0.36, 0.08], [0.60, 0.10],
  ];
  /** structural depth of the deck girder — deepened over a bridge span,
      where the girder is the arch's tie and has to look like it */
  const deckTh = (z: number) => {
    const b = BRIDGES.find((b) => z >= b.z0 && z <= b.z1);
    return b ? b.girder : DECK_TH;
  };
  /** z windows where a mast comes up through the deck edge, and which side.
      A 5.65 m screen wall built straight through a gantry leg swallows it,
      and the leg is the thing that tells you the sign overhead is bolted to
      something — so the wall steps around them, the way a real one does.
      side −1 is the town side (where every cantilever post stands), 0 both. */
  const mastGaps: { z0: number; z1: number; side: number }[] = [];
  for (const s of signPlan()) mastGaps.push({ z0: s.z - 1.5, z1: s.z + 1.5, side: -1 });
  // …and the bypass's own boards, which buildBypassViaduct hangs off the same
  // corridor edge from its own gores
  for (const z of [...BYPASS_BOARD_D.map((d) => DIVERGE_Z - d), DIVERGE_Z - 40, MERGE_Z - 80])
    mastGaps.push({ z0: z - 1.5, z1: z + 1.5, side: -1 });
  /* …and the mountain road's (buildMountainRoad). Its approach runs into the
     seam, so the boards sit at wrapped z back inside the canonical band. */
  for (const z of MTN_BOARD_Z())
    mastGaps.push({ z0: z - 1.5, z1: z + 1.5, side: -1 });
  for (const z of cor.lattice(PITCH.gantry)) mastGaps.push({ z0: z - 1.2, z1: z + 1.2, side: 0 });
  /** stations where a parapet must not be drawn (the ramp divergence zones) */
  const gapZ = terrain.ramps.map(parapetGap);
  /** The bypass and mountain-road gores cut the parapet too (routegraph.ts
      computes all four windows, in canonical z). The deck is BUILT over
      [ZB0, ZB1] though, and the mountain gores sit inside the south splice
      window — so their windows must also cut the overrun copy of that deck
      stretch past Z1, or the copied road (emitted at z + LOOP by
      buildMountainRoad) would dive through an intact copied parapet.
      Fold every window to each raw-z copy that intersects the built extent;
      mid-band windows (the bypass's) come through unchanged. */
  const canonGaps = world.routes ? world.routes.newParapetGaps() : [];
  const newGaps: { z0: number; z1: number; side: 1 | -1 }[] = [];
  for (const g of canonGaps)
    for (const off of [-LOOP_LEN, 0, LOOP_LEN]) {
      const z0 = g.z0 + off, z1 = g.z1 + off;
      if (z1 > cor.ZB0 && z0 < cor.ZB1) newGaps.push({ z0, z1, side: g.side });
    }
  /** [z0, z1] minus this side's gap windows (ramps only ever leave on the
      west side; the bypass cuts both). The old whole-segment test — keep the
      segment iff its *start* z was outside every gap — quantised every gap to
      the 8 m wall pitch, leaving up to a segment of extra missing barrier
      past each gore mouth; clipping ends the runs exactly at the gap edges. */
  const wallSpans = (z0: number, z1: number, east: boolean): [number, number][] => {
    let spans: [number, number][] = [[z0, z1]];
    const cut = (g: { z0: number; z1: number }) => {
      const next: [number, number][] = [];
      for (const [a, b] of spans) {
        if (g.z1 <= a || g.z0 >= b) {
          next.push([a, b]);
          continue;
        }
        if (g.z0 > a) next.push([a, g.z0]);
        if (g.z1 < b) next.push([g.z1, b]);
      }
      spans = next;
    };
    for (const g of newGaps) if ((east ? g.side > 0 : g.side < 0)) cut(g);
    if (!east) for (const g of gapZ) cut(g);
    return spans.filter(([a, b]) => b - a > 0.3); // drop unbuildable slivers
  };
  /** [zA, zB] minus every mast window that applies to this side. Same shape
      as wallSpans, and applied on top of it, so a screen wall inherits the
      gore cuts and then loses the metre and a half around each post. */
  const clipMasts = (zA: number, zB: number, sgn: number): [number, number][] => {
    let spans: [number, number][] = [[zA, zB]];
    for (const g of mastGaps) {
      if (g.side !== 0 && g.side !== sgn) continue;
      const next: [number, number][] = [];
      for (const [a2, b2] of spans) {
        if (g.z1 <= a2 || g.z0 >= b2) {
          next.push([a2, b2]);
          continue;
        }
        if (g.z0 > a2) next.push([a2, g.z0]);
        if (g.z1 < b2) next.push([g.z1, b2]);
      }
      spans = next;
    }
    return spans.filter(([a2, b2]) => b2 - a2 > 0.3);
  };
  /** z's the bypass/mountain gores keep clear of long deck furniture */
  const nearNewGore = (z: number, r: number) =>
    world.routes !== undefined &&
    (Math.abs(z - DIVERGE_Z) < r || Math.abs(z - MERGE_Z) < r ||
      Math.abs(z - MTN.divergeZ) < r || Math.abs(z - MTN.mergeZ) < r);
  /** the tunnel supplies its own walls, so skip the parapet through it */
  const inTube = (z: number) => cor.inTunnel(z, 3);
  /* corridor.ts resolves the section plan, but it cannot see the bypass gores
     without importing routegraph.ts, which imports it — so the last veto is
     applied here. It is applied to the whole RUN, not to the station: a guard
     that fires per-station punches a hole through the middle of a wall rather
     than removing it. */
  const sectionAt = (z: number): SectionKind => {
    const run = cor.sectionRunAt(z);
    if (!run) return "viaduct";
    // only the opaque treatments: a tall wall standing over a gore reads as a
    // black panel across the sign line. A railing hides nothing.
    if ((run.kind === "mesh" || run.kind === "screen") &&
      (nearNewGore(cor.wrapZ(run.z0), 260) || nearNewGore(cor.wrapZ(run.z1), 260)))
      return "viaduct";
    return run.kind;
  };

  const chunkOf = (z: number) => Math.floor(z / CHUNK_Z);
  const road = new Map<number, Soup>();
  const fascia = new Map<number, Soup>();
  const walls = new Map<number, Soup>();
  const marks = new Map<number, Soup>();
  /** steel railing ribbons on the open sections; DoubleSide, so a single
      quad per band is enough (same trick the bypass crossing rail uses) */
  const rails = new Map<number, Soup>();
  /** solid noise walls over the parapet on the `screen` sections */
  const screens = new Map<number, Soup>();
  /** transverse expansion joints, on their own coarse chunking: two triangles
      every 32 m is not worth a per-300 m draw call */
  const joints = new Map<number, Soup>();
  const soup = (m: Map<number, Soup>, c: number) => {
    let s = m.get(c);
    if (!s) m.set(c, (s = new Soup()));
    return s;
  };
  /** railing post mounts, gathered here and instanced once at the end */
  const railPosts: { x: number; y: number; z: number; h: number }[] = [];

  for (let i = 0; i < ST.length - 1; i++) {
    const a = ST[i], b = ST[i + 1];
    const c = chunkOf(a.z);
    // pavement
    /* `hwL` is the WEST half-width — `hw` plus whatever auxiliary ramp lane
       is open here (corridor.AUX_LANES). The deck is the only asymmetric
       thing on the corridor and this is where that starts. */
    const la = pt(i, -a.hwL), ra = pt(i, a.hw);
    const lb = pt(i + 1, -b.hwL), rb = pt(i + 1, b.hw);
    soup(road, c).quadUv(
      la, lb, rb, ra,
      [0, a.s / TILE], [0, b.s / TILE],
      [(b.hw + b.hwL) / TILE, b.s / TILE], [(a.hw + a.hwL) / TILE, a.s / TILE]
    );
    // fascia: the box girder under the deck. Its depth follows the section —
    // the bridge span's girder is the arch tie and is nearly twice as deep,
    // which is most of what makes the span read as a bridge from below and
    // from the mirrors on the way off it.
    const dtA = deckTh(a.z), dtB = deckTh(b.z);
    const lad = pt(i, -a.hwL - 0.5, -dtA), rad = pt(i, a.hw + 0.5, -dtA);
    const lbd = pt(i + 1, -b.hwL - 0.5, -dtB), rbd = pt(i + 1, b.hw + 0.5, -dtB);
    const F = soup(fascia, c);
    F.quad(la, lb, lbd, lad); // west side
    F.quad(ra, rad, rbd, rb); // east side
    F.quad(lad, lbd, rbd, rad); // soffit
    // parapets, clipped exactly to the gap windows (worldOf at a clipped z is
    // identical to pt() at a station, so uncut segments are unchanged)
    if (i % WALL_EVERY === 0 && i + WALL_EVERY < ST.length && !inTube(a.z)) {
      const e = ST[i + WALL_EVERY];
      const kind = sectionAt(a.z);
      /* On `rail` and `bridge` the concrete stops at a kerb and a steel
         railing carries on up to the same 1.05 m the parapet reached, so the
         delineators on top of it and the analytic parapet clamp in collide.ts
         (which is a function of halfWidth alone, and never of what is drawn)
         both stay exactly where they were. Only the sightline changes. */
      const kerb = KERB_H[kind];
      const hWall = kerb ?? WALL_H;
      for (const sgn of [-1, 1]) {
        for (const [zA, zB] of wallSpans(a.z, e.z, sgn > 0)) {
          const W = soup(walls, c);
          const P = (z: number, out: number, dy = 0): Vec3 => {
            const lat = cor.edgeLat(z, sgn) + sgn * (WALL_T / 2 + 0.06) + out;
            const w = cor.worldOf(z, lat);
            return [w.x, w.y + dy, w.z];
          };
          const a0 = P(zA, -sgn * WALL_T / 2), a1 = P(zA, sgn * WALL_T / 2);
          const b0 = P(zB, -sgn * WALL_T / 2), b1 = P(zB, sgn * WALL_T / 2);
          const up = (p: Vec3): Vec3 => [p[0], p[1] + hWall, p[2]];
          const dn = (p: Vec3): Vec3 => [p[0], p[1] - 0.3, p[2]];
          W.quad(dn(a0), dn(b0), up(b0), up(a0));
          W.quad(dn(a1), dn(b1), up(b1), up(a1));
          W.quad(up(a0), up(b0), up(b1), up(a1));
          if (kerb !== undefined) {
            // three flat ribbons on the kerb line; posts are instanced below
            const R = soup(rails, c);
            for (const [y0, t] of RAIL_BANDS) {
              const lo0 = P(zA, 0, kerb + y0), lo1 = P(zB, 0, kerb + y0);
              R.quad(
                lo0, lo1,
                [lo1[0], lo1[1] + t, lo1[2]], [lo0[0], lo0[1] + t, lo0[2]]
              );
            }
            const m = P(zA, 0, kerb);
            railPosts.push({ x: m[0], y: m[1], z: m[2], h: cor.pose(zA).h });
          } else if (kind === "screen") {
            /* Solid noise wall over the coping, stepped around any mast that
               comes up through the edge here. It leans 12 cm inboard at the
               top: a dead-vertical 4.6 m slab beside the lane reads as a
               texture on a wall, whereas the lean puts its coping in the top
               of the windscreen and is what makes the road feel roofed in. */
            const LEAN = -0.12; // lateral drift of the coping, inboard
            for (const [mA, mB] of clipMasts(zA, zB, sgn)) {
              const S2 = soup(screens, c);
              const foot = (z: number, o: number) => P(z, o, WALL_H);
              const head = (z: number, o: number) =>
                P(z, o + sgn * LEAN, WALL_H + SCREEN_H);
              const oi = -sgn * WALL_T / 2, oo = sgn * WALL_T / 2;
              S2.quad(foot(mA, oi), foot(mB, oi), head(mB, oi), head(mA, oi));
              S2.quad(foot(mA, oo), foot(mB, oo), head(mB, oo), head(mA, oo));
              S2.quad(head(mA, oi), head(mB, oi), head(mB, oo), head(mA, oo));
            }
          }
        }
      }
    }
  }

  /* ---- lane markings ---- */
  {
    /* markMat carries a wear map whose v axis runs down the road. Tiling v by
       wrapped z rather than 0..1 per quad is what makes no two dashes wear
       alike; 12.5 divides LOOP_LEN, so the copy of a dash on the far side of
       the splice samples the identical stretch of the map (same rule as the
       furniture lattices). 12.5 against the 16 m dash pitch also means the
       sampling phase only recurs every 200 m — a 12-dash cycle nobody counts
       at speed. */
    const PAINT_TILE_V = 12.5;
    const stripe = (z0: number, z1: number, lat0: number, lat1: number, w: number) => {
      const M = soup(marks, chunkOf(z0));
      const p0 = cor.worldOf(z0, lat0 - w / 2), p1 = cor.worldOf(z0, lat0 + w / 2);
      const p2 = cor.worldOf(z1, lat1 + w / 2), p3 = cor.worldOf(z1, lat1 - w / 2);
      const Y = 0.022;
      const v0 = cor.wrapZ(z0) / PAINT_TILE_V, v1 = v0 + (z1 - z0) / PAINT_TILE_V;
      M.quadUv(
        [p0.x, p0.y + Y, p0.z], [p3.x, p3.y + Y, p3.z],
        [p2.x, p2.y + Y, p2.z], [p1.x, p1.y + Y, p1.z],
        [0, v0], [0, v1], [1, v1], [1, v0]
      );
    };
    /* Solid edge lines down both shoulders. The WEST one rides the outer edge
       of the auxiliary lane where one is open, which is what makes the exit
       lane read as pavement peeling away rather than as a wider shoulder.

       And where it has peeled away, the line it left behind is drawn too —
       a wide SOLID divider on the through-lane edge, the line a real freeway
       uses to say "past here you are committed to the exit". It is 0.30 m
       against the shoulder line's 0.20: on a 400 m approach the extra width
       is most of what tells the two lines apart at range. */
    const E = PITCH.edge;
    for (const z of cor.lattice(E)) {
      if (z + E > cor.ZB1) continue;
      const h0 = cor.halfWidth(z) - 0.45, h1 = cor.halfWidth(z + E) - 0.45;
      const a0 = cor.edgeHalf(z, -1) - 0.45, a1 = cor.edgeHalf(z + E, -1) - 0.45;
      stripe(z, z + E, -a0, -a1, 0.2);
      stripe(z, z + E, h0, h1, 0.2);
      if (cor.auxWidth(z) > 0.5 || cor.auxWidth(z + E) > 0.5)
        stripe(z, z + E, -h0, -h1, 0.3);
    }
    /* The merge taper at an entrance is the one stretch where that divider
       must NOT be solid — traffic is supposed to cross it — so it runs as a
       dash there instead, on the dash lattice like every other broken line. */
    for (const a of AUX_LANES) {
      if (a.z2 >= a.z3) continue;
      const DASH_M = 6;
      for (const z of cor.lattice(PITCH.dash)) {
        if (z < a.z2 || z + DASH_M > a.z3) continue;
        stripe(z, z + DASH_M,
          -(cor.halfWidth(z) - 0.45), -(cor.halfWidth(z + DASH_M) - 0.45), 0.3);
      }
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
      const lats = [cor.halfWidth(z) - 0.45, -(cor.edgeHalf(z, -1) - 0.45)];
      if (cor.auxWidth(z) > 0.5) lats.push(-(cor.halfWidth(z) - 0.45));
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

  /* Section dressing: the railing ribbons and the noise walls. The screens
     share barrierDouble with the parapets they stand on, so the photoscan
     concrete reaches them and they cost draw calls but no extra shader. */
  const railMat = new THREE.MeshStandardMaterial({
    color: 0x545c6b, roughness: 0.45, metalness: 0.75, side: THREE.DoubleSide,
  });
  emit(rails, railMat, false, false, false);
  emit(screens, wallMat, false, true, false);
  if (railPosts.length) {
    /* One post per station (4 m) on the open sections. A railing without
       verticals reads as three floating lines from the dashcam — the posts
       are what give it a rhythm and, at speed, the strobing that says the
       barrier beside you is close. */
    const postG = new THREE.BoxGeometry(0.1, 0.66, 0.1);
    const posts = new THREE.InstancedMesh(postG, railMat, railPosts.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(),
      V = new THREE.Vector3(), SC = new THREE.Vector3(1, 1, 1);
    railPosts.forEach((p, i) => {
      E.set(0, p.h, 0);
      Q.setFromEuler(E);
      V.set(p.x, p.y + 0.33, p.z);
      M.compose(V, Q, SC);
      posts.setMatrixAt(i, M);
    });
    posts.computeBoundingSphere();
    scene.add(posts);
  }

  /* ---- expansion joints ----
     A segmental viaduct is a chain of spans, and where two of them meet there
     is a finger joint straight across the deck. They cost two triangles each
     and they are the cheapest thing on this road that conveys speed: on the
     PITCH.pier lattice they arrive at better than one a second at 150 km/h,
     and a rhythm you can count is what turns "a texture scrolling past" into
     "ground going past". Riding the pier lattice also means a joint always
     lands over a pier — and so over every section boundary, since those are
     pier multiples too, which is exactly where a real structure changes.

     Laid a hair PROUD of the lane paint rather than under it: paint stops at
     a real joint, so drawing the joint on top is both what happens in life
     and the way out of a z-fight with the markings that cross it. Beam-
     responsive like the paint, so the steel edge angles flare when the
     headlights reach them and die away behind the car. */
  {
    const jointTex = makeTex(8, 64, (ctx, w2, h2) => {
      const band = (y0: number, y1: number, col: string) => {
        ctx.fillStyle = col;
        ctx.fillRect(0, y0, w2, y1 - y0);
      };
      band(0, h2, "#0d0f14");
      band(3, 11, "#666d78"); // galvanised edge angle, the bit that catches
      band(11, 27, "#0a0b0f"); // the gap
      band(27, 39, "#3d434d"); // finger plate
      band(39, 55, "#0a0b0f");
      band(55, 63, "#666d78");
    });
    const jointMat = new THREE.MeshBasicMaterial({
      map: jointTex, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    mats.addBeam(jointMat, { near: 18, far: 62, spread: 0.95 });
    const JL = 0.55;
    for (const z of cor.lattice(PITCH.pier)) {
      if (z + JL > cor.ZB1) continue;
      // the plaza's own deck is dressed with rumble bars and gate islands;
      // one more transverse band across it is noise
      if (z > TOLL.plazaZ0 - 26 && z < TOLL.plazaZ1 + 26) continue;
      const J = soup(joints, Math.floor(z / (CHUNK_Z * 3)));
      const hw0 = cor.halfWidth(z) - 0.05, hw1 = cor.halfWidth(z + JL) - 0.05;
      const p0 = cor.worldOf(z, -hw0), p1 = cor.worldOf(z, hw0);
      const p2 = cor.worldOf(z + JL, hw1), p3 = cor.worldOf(z + JL, -hw1);
      const Y = 0.03;
      J.quadUv(
        [p0.x, p0.y + Y, p0.z], [p3.x, p3.y + Y, p3.z],
        [p2.x, p2.y + Y, p2.z], [p1.x, p1.y + Y, p1.z],
        [0, 0], [0, 1], [1, 1], [1, 0]
      );
    }
    emit(joints, jointMat, true, false, true);
  }


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
      /* Each bridge's whole argument is the hole under it: the arch carries
         the deck from abutment to abutment, so the piers that would otherwise
         stand inside its span are not there. The abutments are on the
         lattice as well and get their own splayed blocks (buildBridge), so
         they come out here too rather than being drawn twice. */
      if (BRIDGES.some((b) => z >= b.z0 && z <= b.z1)) continue;
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

  /* ---------------- the tied-arch bridges ---------------- */
  for (const spec of BRIDGES) buildBridge(scene, mats, world, terrain, cor, spec);

  /* ---------------- the crossing overpasses + interchange masts -------- */
  if (FX_OVERPASS) buildOverpasses(scene, mats, world, terrain, cor);
  if (FX_HIGH_MASTS) buildHighMasts(scene, mats, world, terrain, cor);

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

  const mergeWordMat = wordMat("合流");
  terrain.ramps.forEach((r) => {
    const isExit = r.kind === "exit";
    const gi = CONNECT_Z.indexOf(r.zr);
    const name = EXIT_NAMES[gi] || "出口";
    const fwd = isExit ? 1 : -1; // "toward the gore" in z
    /** Centre of the lane that leaves (or joins): the auxiliary lane where
        one is open, the kerb lane where there is not. */
    const auxLat = (z: number) => {
      const a = cor.auxWidth(z);
      return a > 2 ? -(cor.halfWidth(z) + a / 2) : -(cor.halfWidth(z) - 1.9);
    };
    if (isExit) world.exits.push({ z: r.zr, no: gi + 1, name });
    /* Painted gore. What used to be here was ONE 3.2 x 6.4 m chevron patch at
       the nose — 6 m of paint for a divergence that is 50 m long, and at
       100 km/h it went past in a fifth of a second. The real gore is the
       triangle that opens between the through-lane edge and the ramp as the
       two pull apart, so the hatch is laid down the whole of it, widening the
       way the triangle does. */
    for (let d = 5; d < 56; d += 6.4) {
      const z = r.zr + fwd * d;
      const wd = Math.min(8.6, 0.17 * d + 0.7);
      const inner = -(cor.halfWidth(z) - 0.3);
      const g = decal(z, inner - wd / 2, wd, 6.0, goreMat);
      if (!isExit) g.rotation.y += Math.PI;
    }
    /* Amber beacon on the physical nose — the point where the deck's own
       parapet picks up again past the mouth, which with a deceleration lane
       is 60 m further on than the gore z. */
    const pg = parapetGap(r);
    const noseZ = isExit ? pg.z1 : pg.z0;
    const bp = cor.worldOf(noseZ, -(cor.halfWidth(noseZ) + 0.5));
    const bea = new THREE.Sprite(world.goreBeaconMat!);
    bea.scale.set(1.9, 1.9, 1);
    bea.position.set(bp.x, bp.y + 1.9, bp.z);
    scene.add(bea);

    /* Lane guidance down the auxiliary lane. Four arrows and three 出口 over
       350 m, against three arrows and one word over 122 m before — the paint
       is what says "this whole lane is leaving", and it has to be readable
       from the moment the lane opens. */
    if (isExit) {
      for (const d of [44, 84, 124, 164])
        decal(r.zr - d, auxLat(r.zr - d), 1.8, 4.0, arrowMat);
      for (const d of [210, 280, 350]) word(r.zr - d, auxLat(r.zr - d), exitWordMat, 2);
    } else {
      for (const d of [80, 130, 180]) word(r.zr + d, auxLat(r.zr + d), mergeWordMat, 2);
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
    const [jp, en] = (EXIT_NAMES[s.gore] || "出口 Exit").split(" ");
    const tex =
      s.kind === "exit-count" ? guideSignTexF(s.gore + 1, jp, en || "", distLabel(s.dist))
        : s.kind === "exit-gore"
          ? guideSignTexF(s.gore + 1, jp, en || "", "", { only: true })
          : s.kind === "merge" ? mergeSignTexF(distLabel(s.dist))
            : warnTexF("料金所 " + s.dist + " m", "TOLL");
    board(s.z, s.w, s.h, tex);
  }

  /* ---------------- the bypass viaduct (route graph, stage 2) --------------
     Swept from routegraph.ts's stations exactly the way the main deck is
     swept from the corridor's: pavement with the per-station asymmetric
     half-widths (the gore wedges) and banked cross-fall, the 1.1 m box girder
     the bridge clearance numbers assume, parapets that yield to a steel
     railing over the crossing span, centre dash + edge lines in the same
     retroreflective paint, piers with caps (and colliders), and the gore kit
     the ramps already use — chevrons, beacons, signs, kerb-lane arrows. */
  if (world.routes) buildBypassViaduct(scene, mats, world, terrain, {
    add, board, decal, word, wordMat, arrowMat, goreMat,
  });

  /* ---------------- the mountain road (route graph, EXIT 4) ----------------
     Swept from routegraph.ts's mtn stations: a one-way rock-shelf pass above
     the river bank. Rock faces both sides (the cut face west, the drop to the
     bank east), a low stone parapet on the river edge, double-yellow centre
     line, retroreflective delineators, sparse warm lamps, the gore kit, and
     EXIT 4 boards. Everything visible is emitted at z AND z + LOOP — the road
     lives inside the south splice window, so the overrun past Z1 must carry
     its copy (see corridor.MTN); colliders and the exit entry stay canonical. */
  if (world.routes && FX_MOUNTAIN) buildMountainRoad(scene, mats, world, terrain, {
    add, board, decal, word, wordMat, arrowMat, goreMat,
  });

  /* ---------------- deck dressing ---------------- */
  /* Edge reflectors, on top of the parapet rather than 40 cm inside the
     pavement edge — where they were, they were below the barrier's top and so
     buried in it from most angles. */
  {
    const pts: number[] = [];
    for (const z of cor.lattice(PITCH.reflector)) {
      if (cor.inTunnel(z)) continue;
      const hwE = cor.halfWidth(z) + 0.23, hwW = cor.edgeHalf(z, -1) + 0.23;
      /* not in a parapet gap: a delineator rides the coping, and where a gore
         has cut the barrier away it would float in mid-air over the mouth */
      const inGap = (side: 1 | -1) =>
        newGaps.some((g) => g.side === side && z > g.z0 && z < g.z1) ||
        (side < 0 && gapZ.some((g) => z > g.z0 && z < g.z1));
      if (!inGap(-1)) {
        const a = cor.worldOf(z, -hwW);
        pts.push(a.x, a.y + 1.02, a.z);
      }
      if (!inGap(1)) {
        const b = cor.worldOf(z, hwE);
        pts.push(b.x, b.y + 1.02, b.z);
      }
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
  /* Emergency-phone cabinets on the parapet coping, one every PITCH.sos.
     Deck furniture at eye level and an arm's length from the door is what the
     driver actually registers on a road whose scenery is 300 m away, and this
     is the cheapest such thing there is: two instanced meshes for the whole
     lap. Only where the edge is solid concrete — on the railing sections
     there is no coping to bolt one to, and standing one on a kerb would put
     it in the sightline the railing exists to open up. */
  {
    const slots: { x: number; y: number; z: number; h: number; nx: number; nz: number }[] = [];
    for (const z of cor.lattice(PITCH.sos, PHASE.sos)) {
      if (cor.inTunnel(z) || cor.inToll(z)) continue;
      const kind = sectionAt(z);
      if (kind === "rail" || kind === "bridge") continue;
      // never in a parapet gap: there is nothing there to stand it on
      if (gapZ.some((g) => z > g.z0 - 2 && z < g.z1 + 2)) continue;
      if (newGaps.some((g) => g.side < 0 && z > g.z0 - 2 && z < g.z1 + 2)) continue;
      const p = cor.pose(z);
      const lat = cor.edgeLat(z, -1) - 0.23;
      slots.push({
        x: p.x + lat * p.nx, y: p.y + WALL_H, z: p.z + lat * p.nz,
        h: p.h, nx: p.nx, nz: p.nz,
      });
    }
    if (slots.length) {
      const boxMat = new THREE.MeshStandardMaterial({
        color: 0xc08a2e, roughness: 0.55, metalness: 0.35,
      });
      const sosTex = makeTex(160, 128, (ctx, w2, h2) => {
        ctx.fillStyle = "#d4531c";
        ctx.fillRect(0, 0, w2, h2);
        ctx.strokeStyle = "#fff3e2";
        ctx.lineWidth = 5;
        ctx.strokeRect(4, 4, w2 - 8, h2 - 8);
        ctx.fillStyle = "#fff3e2";
        ctx.textAlign = "center";
        ctx.font = '700 26px "Hiragino Sans",sans-serif';
        ctx.fillText("非常電話", w2 / 2, 52);
        ctx.font = "800 34px sans-serif";
        ctx.fillText("SOS", w2 / 2, 94);
      });
      const box = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.34, 0.95, 0.62), boxMat, slots.length);
      const plate = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.54, 0.44),
        // fogged: an unfogged orange plate 500 m out is a hard-edged dot in
        // the haze, the same failure the tunnel portal chevrons had
        new THREE.MeshBasicMaterial({ map: sosTex }), slots.length);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(),
        V = new THREE.Vector3(), SC = new THREE.Vector3(1, 1, 1);
      slots.forEach((s, i) => {
        E.set(0, s.h, 0);
        Q.setFromEuler(E);
        V.set(s.x, s.y + 0.47, s.z);
        M.compose(V, Q, SC);
        box.setMatrixAt(i, M);
        // face the plate across the deck, at the driver rather than at the town
        E.set(0, s.h + Math.PI / 2, 0);
        Q.setFromEuler(E);
        // +normal is inboard here: the cabinet sits at a negative lat
        V.set(s.x + 0.18 * s.nx, s.y + 0.62, s.z + 0.18 * s.nz);
        M.compose(V, Q, SC);
        plate.setMatrixAt(i, M);
      });
      box.computeBoundingSphere();
      plate.computeBoundingSphere();
      scene.add(box, plate);
    }
  }
  // sign gantries
  {
    const gMat = new THREE.MeshStandardMaterial({ color: 0x3a404c, roughness: 0.6, metalness: 0.4 });
    const words = ["箱崎 Hakozaki", "新宿 Shinjuku", "渋谷 Shibuya", "湾岸線 Wangan"];
    /* Variable-message boards. Amber dot-matrix on near-black, drawn as
       discrete dots rather than as solid glyphs — the dot grid is the whole
       read, and at distance it is what separates a VMS from a yellow sign.
       The amber is held around 0.7 luma on purpose: the ACES grade bleaches
       anything much above 0.8 to white, and a board that goes white stops
       being a VMS (see the lamp-cone note further down). */
    const vmsLines: readonly (readonly [string, string])[] = [
      ["この先 渋滞 3km", "CONGESTION AHEAD"],
      ["トンネル内 車線変更禁止", "NO LANE CHANGE IN TUNNEL"],
      ["前方 工事 車線規制", "ROADWORKS  LANE CLOSED"],
      ["路面凍結注意", "ICE — REDUCE SPEED"],
    ];
    const vmsTex = (line: readonly [string, string]) =>
      makeTex(512, 160, (ctx, w2, h2) => {
        ctx.fillStyle = "#07080b";
        ctx.fillRect(0, 0, w2, h2);
        ctx.strokeStyle = "#23272f";
        ctx.lineWidth = 8;
        ctx.strokeRect(4, 4, w2 - 8, h2 - 8);
        /* Render the text to an offscreen mask, then stamp one dot per lit
           cell. Cheaper to write than a bitmap font and it gives the real
           artefact: strokes that break into dots when you get close. */
        const cv = document.createElement("canvas");
        cv.width = w2;
        cv.height = h2;
        const c2 = cv.getContext("2d")!;
        c2.fillStyle = "#fff";
        c2.textAlign = "center";
        c2.font = '700 46px "Hiragino Sans","Yu Gothic",sans-serif';
        c2.fillText(line[0], w2 / 2, 66);
        c2.font = "700 30px sans-serif";
        c2.fillText(line[1], w2 / 2, 116);
        const src = c2.getImageData(0, 0, w2, h2).data;
        const STEP = 5;
        ctx.fillStyle = "#e0972a";
        for (let y = 2; y < h2; y += STEP)
          for (let x = 2; x < w2; x += STEP)
            if (src[(y * w2 + x) * 4 + 3] > 110) {
              ctx.beginPath();
              ctx.arc(x, y, 1.7, 0, Math.PI * 2);
              ctx.fill();
            }
      });
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
      // the bypass gores: a gantry lands exactly on the diverge nose otherwise
      if (nearNewGore(z, 220)) continue;
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
      const gi = cor.latticeIndex(z, PITCH.gantry);
      const w1 = words[gi % words.length];
      // the deck is only 10.5 m wide where it drops to two lanes, so size the
      // panel to the road rather than hanging it out over the drop
      const sw = Math.min(9, legLat * 2 - 1.4);
      /* Every fourth gantry on the lattice carries a variable-message board
         instead of a route board. Same structure, same cost, completely
         different thing to read at 500 m — an amber dot-matrix panel is the
         one sign on an expressway whose colour says "this is live", and
         having two kinds of gantry is most of what stops five identical
         goalposts a lap reading as one repeated prop. Chosen from the folded
         lattice index for the same reason the wording is: a random draw would
         relabel the gantry mid-teleport. */
      const vms = gi % 4 === 2;
      // fogged, and backed, for the same reasons as the cantilever boards
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(sw, sw * 0.29),
        new THREE.MeshBasicMaterial({
          map: vms ? vmsTex(vmsLines[(gi >> 2) % vmsLines.length]) : signTexF(w1, "首都高速 C1"),
        }));
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
  /* Sound barriers — the `mesh` sections. Where they go is now decided by the
     section plan in corridor.ts rather than by a lattice walk here, so the
     screens, the solid noise walls and the open railings cannot land on top
     of one another and the whole sequence of edge treatments can be read in
     one table. The sweep still walks the corridor's own stations (a straight
     box drifts more than a metre off a curving deck edge over its own length)
     and the gore veto is still applied, since a 3 m barrier standing over an
     exit reads as a black panel across the sign line.

     The hero version is a perforated galvanised-mesh screen standing on the
     parapet: an alphaTest cutout (never alpha blend — the depth buffer stays
     honest against every glow sprite behind it), driven by the Fence007A scan
     with a punched-canvas fallback, mast posts every 8 m, and a beam response
     from mats.addBeam so the panels flare as the headlights rake them and die
     away behind the car. UVs run in panel-widths so the scan tiles at life
     size. */
  {
    const H = 3.0, PANEL_W = 2.4;
    /* the fenceOverdraw cap finally gets its consumer: mobile-base falls back
       to the old translucent slab, shedding the alphaTest overdraw */
    if (FX_FENCE_PANELS && caps.fenceOverdraw) {
      const S = new Soup();
      const postAt: { x: number; y: number; z: number; h: number }[] = [];
      for (let i = 0; i < ST.length - 1; i++) {
        if (sectionAt(ST[i].z) !== "mesh") continue;
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
      for (let i = 0; i < ST.length - 1; i++) {
        if (sectionAt(ST[i].z) !== "mesh") continue;
        const la = ST[i].hw + 0.3, lb = ST[i + 1].hw + 0.3;
        S.quad(pt(i, la), pt(i + 1, lb), pt(i + 1, lb, H), pt(i, la, H));
      }
      if (!S.empty) {
        const m = new THREE.Mesh(S.geom(false), swMat);
        m.castShadow = true;
        scene.add(m);
      }
    }
  }

  /* ---------------- streetlights ---------------- */
  /* Deck lamp pool footprint — ASYMMETRIC, and hung off the head, not off the
     road centre. An earlier pass centred the pool at 0.30·hw to get it out over
     the lanes, which put its hot core 3.65 m inboard of the head that supposedly
     casts it; a bright patch that is not under its lamp is exactly what reads as
     a spotlight rather than as light falling from a fitting. So the core goes
     back under the head and the road coverage comes from asymmetry instead:
     - OUT: 1.5 m outboard, head → parapet. The head hangs 1.32 m inboard of the
       parapet (arm 1.55 m in from a pole 0.23 m out), so 1.5 m lands the outer
       edge just past the barrier base, where the wall hides the last of it.
       Constant in metres, not a fraction of hw: the arm geometry does not widen
       with the deck, so this distance is the same on three lanes and on six.
     - IN_F: 1.68·hw inboard, i.e. across the carriageway, stopping ~1 m short of
       the far shoulder so nothing overhangs the opposite edge. A fraction
       because this one DOES have to track the deck, which runs three lanes for
       most of its length and six through the toll plaza.
     Real cobra heads throw like this — across the roadway, not back over the
     barrier — so the asymmetry is what the fitting would actually do, and it
     also makes the far-side overhang impossible by construction.
     - B: metres, not a fraction: set by PITCH.light (50 m). Lamps alternate
       sides on the lattice parity, so same-side pools sit 100 m apart, and even
       at 25 m of half-length the pools of adjacent stations only just meet, and
       they meet at their zero-alpha extremes where nothing prints. The
       along-road fade is the one the driver actually travels through, so it is
       the one worth the metres. */
  const POOL_OUT = 1.5, POOL_IN_F = 1.68, POOL_B = 25.0;

  /* Longitudinal UV banding: [texture radius fraction, POOL_B fraction].
     The pool gradient itself is deliberately NOT reshaped — it looks right and
     is shared with the town lamps. The problem it has is one of ALLOCATION: its
     low tail (alpha .086 → 0) occupies the final 3% of its radius, so under a
     uniform mapping that tail gets ~3% of the pool's length — about 30 cm of
     road at the old B, which is why the light appeared to stop dead.

     So instead of moving the stops, move the SAMPLING. Splitting the quad
     longitudinally and advancing texture radius more slowly than distance hands
     the outer, dimmer part of the same curve a disproportionate share of the
     ground: the inner 60% of the radius covers 8 m, the outer 40% covers 14 m.
     Identical texture, identical curve shape; the .086 -> 0 tail goes from 0.6 m
     of road to 3.5 m (5.8x) and the visible .25 -> .05 fade from 2.3 m to 8.8 m
     (3.8x). (Same technique as the lateral split above — see emitPool.)

     The banding is weighted hardest at the very END, where it matters most: the
     POV chain crushes with `max(col-.06,0)`, an absolute cliff to zero, so the
     last transition cannot be removed — it can only be moved somewhere the light
     is already faint and the shadow grain dithers across it. Hence the four
     closely-spaced outer entries: r .84->1 (alpha .18 -> 0) is given 44% of the
     pool's length. Metres are taken from the mid-range to pay for it rather than
     by growing the pool much, so the bright core is unchanged.

     Alpha along the road that this produces: .35 at 8 m, .25 at 11 m, .18 at
     14 m, .13 at 16.5 m, .086 at 19.8 m, 0 at 25 m. */
  const POOL_LONG: readonly (readonly [number, number])[] = [
    [0, 0], [0.24, 0.10], [0.44, 0.20], [0.60, 0.32],
    [0.74, 0.44], [0.84, 0.56], [0.90, 0.68], [0.95, 0.82],
    [0.98, 0.92], [1, 1],
  ];
  const lightPts: number[] = [];
  {
    const poleG = new THREE.CylinderGeometry(0.09, 0.12, 7.6, 6);
    const armG = new THREE.BoxGeometry(1.7, 0.09, 0.09);
    // half a pitch off the lattice origin: the gantry pitch is a multiple of
    // this one, so on phase 0 every gantry would have a light pole inside its leg
    const zs = cor.lattice(PITCH.light, PHASE.light);
    /* The bypass viaduct's lights ride the SAME instanced meshes (poles,
       arms, heads, lenses, cones, pools — one draw call each for deck AND
       viaduct). Its lattice is edge-local: the bypass never crosses the
       seam, so there is no LOOP-phase constraint to honour. The gore wedges
       are skipped (the deck's own lights carry those), as is any station
       whose outer half-width is gore-clipped. */
    const byLamps: { s: number; flip: number }[] = [];
    if (world.routes) {
      const byE = world.routes.bypass;
      let k2 = 0;
      for (const s of byE.sLattice(PITCH.light, 25)) {
        if (s < 40 || s > byE.len - 40) continue;
        const flip = k2++ % 2 ? 1 : -1;
        const hws = byE.halfWidths(s);
        if ((flip > 0 ? hws.hwL : hws.hwR) < BYPASS.half - 0.02) continue;
        byLamps.push({ s, flip });
      }
    }
    const NP = zs.length + byLamps.length;
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
    /* Hem 2.05 → 3.0, and NOT wider. A pass in this session took it to 6.5 m to
       fan the shaft over the lanes; that was the wrong tool for the wrong
       complaint — the airborne shaft is not what makes a lamp read as lighting
       the road, the pool on the tarmac is, and a 6.5 m fan is a large translucent
       object hanging over the carriageway that reads as haze-in-a-cone rather
       than as light. The road pool carries the effect now (see emitPool); this
       stays a restrained hint of scattered air around the head. */
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
         fading out inside ~18 m keeps the shafts a mid-distance effect (this
         went to 9→24 m alongside the 6.5 m hem and comes back with it);
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
    /* One lamp pool, emitted as TWO quads split along the head's lateral line.

       The shared pool gradient (poolGradientTex) is a centred radial fade that
       reaches zero at the quad edge, and UVs interpolate linearly across a
       quad — so a single quad can only ever give a SYMMETRIC pool. Splitting at
       u = 0.5 and giving each half a different width in metres stretches the
       same gradient asymmetrically: the outboard half spends half the texture
       over POOL_OUT metres (a quick rise from the barrier base up to the head)
       and the inboard half spends the other half over `inboard` metres (a long
       fade out across the lanes). Alpha is identical at u = 0.5 on both sides,
       so the seam does not print; only the falloff SLOPE changes there, and it
       changes over the shoulder beside the head rather than out in a lane.

       Doing it in UV space is deliberate: the deck pools ride the town lamps'
       material instance so that engine.ts's day/night opacity pass and
       tintLampsSodium() drive all of it with zero engine changes (see
       townmesh.ts). A purpose-built asymmetric texture would have cost a second
       material and two more things to keep in sync. */
    const emitPool = (
      p: { x: number; z: number; nx: number; nz: number; tx: number; tz: number; grade: number },
      lampLat: number, flip: number, inboard: number, yAt: (lat: number) => number,
    ) => {
      const g = p.grade, tn = 1 / Math.hypot(1, g);
      const tX = p.tx * tn, tY = g * tn, tZ = p.tz * tn; // unit tangent w/ grade
      /* grade-aligned along the road so neither end lifts off a climbing deck,
         and yAt() carries the bypass's cross-fall where the deck has none */
      const vert = (lat: number, m: number, u: number, v: number) => {
        poolPos.push(
          p.x + lat * p.nx + m * tX,
          yAt(lat) + 0.055 + m * tY,
          p.z + lat * p.nz + m * tZ,
        );
        poolUv.push(u, v);
      };
      /* one cell of the lateral x longitudinal grid; the pool material is
         DoubleSide, so winding does not matter here */
      const cell = (
        latA: number, uA: number, latB: number, uB: number,
        mA: number, vA: number, mB: number, vB: number,
      ) => {
        vert(latA, mA, uA, vA); vert(latB, mA, uB, vA); vert(latB, mB, uB, vB);
        vert(latA, mA, uA, vA); vert(latB, mB, uB, vB); vert(latA, mB, uA, vB);
      };
      const lanes: readonly (readonly [number, number, number, number])[] = [
        [lampLat + flip * POOL_OUT, 0, lampLat, 0.5], // barrier side, short
        [lampLat, 0.5, lampLat - flip * inboard, 1],  // carriageway, long
      ];
      for (const [latA, uA, latB, uB] of lanes)
        for (const s of [-1, 1] as const)
          for (let i = 0; i < POOL_LONG.length - 1; i++) {
            const [rA, fA] = POOL_LONG[i], [rB, fB] = POOL_LONG[i + 1];
            cell(
              latA, uA, latB, uB,
              s * fA * POOL_B, 0.5 + s * rA * 0.5,
              s * fB * POOL_B, 0.5 + s * rB * 0.5,
            );
          }
    };
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
      // a pole standing in a bypass parapet gap, on the gap's side, would be
      // a mast planted in the gore's open pavement
      if (newGaps.some((g) => z > g.z0 && z < g.z1 && (g.side > 0) === (flip > 0)))
        continue;
      const p = cor.pose(z);
      // mounted on the parapet, not inside the shoulder where a car scraping
      // the barrier would drive through the pole
      const lat = cor.edgeLat(z, flip) + flip * 0.23;
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
      // pool hangs off the head itself (lampLat), flat deck so yAt is constant
      if (wantPools && keepNth(poolEvery))
        emitPool(p, lampLat, flip, cor.edgeHalf(z, flip) * POOL_IN_F, () => p.y);
      n++;
    }
    /* the viaduct's lights: same fittings, bypass station frame, cross-fall
       (bank) folded into every mount height so the pole bases sit on the
       banked pavement rather than floating over it */
    if (world.routes && byLamps.length) {
      const byE = world.routes.bypass;
      let bi = 0;
      for (const { s, flip } of byLamps) {
        const p = byE.poseAt(s);
        const hws = byE.halfWidths(s);
        const hw = flip > 0 ? hws.hwL : hws.hwR;
        const lat = flip * (hw + 0.23);
        const sy = (l: number) => p.y + l * p.bank;
        E.set(0, p.h, 0);
        Q.setFromEuler(E);
        V.set(p.x + lat * p.nx, sy(lat) + 3.8, p.z + lat * p.nz);
        M.compose(V, Q, S);
        poles.setMatrixAt(n, M);
        const armLat = lat - flip * 0.8;
        V.set(p.x + armLat * p.nx, sy(armLat) + 7.5, p.z + armLat * p.nz);
        M.compose(V, Q, S);
        arms.setMatrixAt(n, M);
        const lampLat = lat - flip * 1.55;
        const lx = p.x + lampLat * p.nx, lz = p.z + lampLat * p.nz;
        const ly = sy(lampLat);
        lightPts.push(lx, ly + 7.45, lz);
        V.set(lx, ly + 7.5, lz);
        M.compose(V, Q, S);
        heads.setMatrixAt(n, M);
        V.set(lx, ly + 7.39, lz);
        M.compose(V, Q, S);
        lens.setMatrixAt(n, M);
        const idx = bi++;
        if (cones && idx % coneEvery === 0) {
          V.set(lx, ly + 7.45 - 3.55, lz);
          M.compose(V, Q, S);
          cones.setMatrixAt(nc++, M);
        }
        // same emitter as the deck — the bypass's own half-width stands in for
        // the deck's, and sy() folds its cross-fall into every vertex height
        if (wantPools && idx % poolEvery === 0)
          emitPool(p, lampLat, flip, hw * POOL_IN_F, sy);
        n++;
      }
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

  /* ---------------- procedural deck detail (deckdetail.ts) ---------------- */
  if (FX_WHEEL_TRACKS && caps.wheelTracks !== false) buildWheelTracks(scene);
  const dressK = caps.deckDressing ?? 1;
  if (FX_DECK_DRESSING && dressK > 0) buildDeckDressing(scene, dressK);

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

/* ============================ tied-arch bridges ========================== */

/** One tied-arch span, built from `spec` (BRIDGE or BRIDGE2 — see corridor.ts).

    The hard part of putting a bridge on this road is that the road is already
    a viaduct: it is ten metres up on piers from one end of the lap to the
    other, so "the road lifts onto piers" is not a change the driver can see.
    What separates a bridge from the viaduct either side of it is (a) a
    structure you drive *through*, (b) a hole underneath where the piers stop,
    and (c) the joint you feel and see at each end. This builds all three.

    Reading it in the dashcam, in order: the arch rises out of the road ahead
    and closes overhead as you reach it; the deck edge drops to a kerb-and-
    railing so the ground is suddenly visible past it; the hangers strobe past
    the door; the expansion joint bands cross the bonnet at each abutment. Off
    the far end the girder shallows again and the piers come back.

    Cost: two swept ribs at 20 segments (~320 triangles), one instanced mesh
    for the hangers, one for the braces, four abutment boxes and two Points
    clouds — call it 900 triangles and 7 draw calls, all of it inside a 128 m
    frustum slice that is only in view for a few seconds a lap. */
function buildBridge(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  cor: ReturnType<typeof getCorridor>,
  spec: typeof BRIDGE
) {
  const { z0, z1, rise, ribOut, ribW, ribD, hangers, girder, braceAt } = spec;
  const span = z1 - z0;
  const ribLat = cor.halfWidth((z0 + z1) / 2) + ribOut;
  /** arch height above the deck line at fraction t — a plain parabola, which
      is what a tied arch's rib actually is */
  const archY = (t: number) => rise * 4 * t * (1 - t);
  /** rib centreline point at fraction t on side `sgn` */
  const ribPt = (t: number, sgn: number) => {
    const z = z0 + t * span;
    const w = cor.worldOf(z, sgn * ribLat);
    return new THREE.Vector3(w.x, w.y + archY(t), w.z);
  };
  /** deck edge under the rib — where a hanger lands */
  const deckPt = (t: number, sgn: number) => {
    const z = z0 + t * span;
    const w = cor.worldOf(z, sgn * ribLat);
    return new THREE.Vector3(w.x, w.y, w.z);
  };

  const steel = new THREE.MeshStandardMaterial({
    color: 0x59616f, roughness: 0.5, metalness: 0.72, side: THREE.DoubleSide,
  });

  /* ---- the two ribs, swept as box sections ---- */
  const N = 20;
  const S = new Soup();
  const nrm = new THREE.Vector3();
  {
    const p = cor.pose((z0 + z1) / 2);
    nrm.set(p.nx, 0, p.nz); // the corridor is dead straight through the span
  }
  for (const sgn of [-1, 1]) {
    /** the four corners of the rib's box section at fraction t */
    const frame = (t: number): Vec3[] => {
      const c = ribPt(t, sgn);
      const d = ribPt(Math.min(1, t + 0.02), sgn).sub(ribPt(Math.max(0, t - 0.02), sgn)).normalize();
      const u = new THREE.Vector3().crossVectors(d, nrm).normalize();
      const out: Vec3[] = [];
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const)
        out.push([
          c.x + nrm.x * a * ribW / 2 + u.x * b * ribD / 2,
          c.y + nrm.y * a * ribW / 2 + u.y * b * ribD / 2,
          c.z + nrm.z * a * ribW / 2 + u.z * b * ribD / 2,
        ]);
      return out;
    };
    let prev = frame(0);
    for (let k = 1; k <= N; k++) {
      const cur = frame(k / N);
      for (let e = 0; e < 4; e++) {
        const f = (e + 1) % 4;
        S.quad(prev[e], prev[f], cur[f], cur[e]);
      }
      prev = cur;
    }
  }
  const ribMesh = new THREE.Mesh(S.geom(false), steel);
  ribMesh.castShadow = true;
  scene.add(ribMesh);

  const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(),
    E = new THREE.Euler(), SC = new THREE.Vector3();

  /* ---- hangers: rib down to the deck edge ---- */
  {
    const hg = new THREE.BoxGeometry(0.09, 1, 0.09);
    const hm = new THREE.InstancedMesh(hg, steel, hangers * 2);
    let n = 0;
    for (const sgn of [-1, 1])
      for (let k = 1; k <= hangers; k++) {
        const t = k / (hangers + 1);
        const top = ribPt(t, sgn), bot = deckPt(t, sgn);
        const len = Math.max(0.2, top.y - bot.y);
        E.set(0, cor.pose(bot.z).h, 0);
        Q.setFromEuler(E);
        V.set(bot.x, bot.y + len / 2, bot.z);
        SC.set(1, len, 1);
        M.compose(V, Q, SC);
        hm.setMatrixAt(n++, M);
      }
    hm.count = n;
    hm.computeBoundingSphere();
    scene.add(hm);
  }

  /* ---- cross-braces between the ribs, all of them 15 m up ---- */
  {
    const bg = new THREE.BoxGeometry(1, 0.46, 0.46);
    const bm = new THREE.InstancedMesh(bg, steel, braceAt.length);
    braceAt.forEach((t, i) => {
      const a = ribPt(t, -1), b = ribPt(t, 1);
      E.set(0, cor.pose(a.z).h, 0);
      Q.setFromEuler(E);
      V.copy(a).add(b).multiplyScalar(0.5);
      SC.set(a.distanceTo(b), 1, 1);
      M.compose(V, Q, SC);
      bm.setMatrixAt(i, M);
    });
    bm.computeBoundingSphere();
    scene.add(bm);
  }

  /* ---- abutments: the springing blocks that replace the two piers ----
     Splayed concrete, wide enough to carry both ribs and the girder, standing
     on the ground the suppressed piers used to. The collider matches the
     block: nothing down there is a ghost. */
  for (const z of [z0, z1]) {
    const p = cor.pose(z);
    const gy = terrain.h(p.x, z);
    const soffit = p.y - girder;
    const h = Math.max(2, soffit - gy);
    const blk = new THREE.Mesh(new THREE.BoxGeometry(ribLat * 2 + 2.2, h, 3.2), mats.concDark);
    blk.position.set(p.x, gy + h / 2, p.z);
    blk.rotation.y = p.h;
    blk.castShadow = true;
    scene.add(blk);
    // shoe under each rib foot, so the arch visibly lands on something
    for (const sgn of [-1, 1]) {
      const w = cor.worldOf(z, sgn * ribLat);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.9), mats.concDark);
      shoe.position.set(w.x, w.y + 0.4, w.z);
      shoe.rotation.y = p.h;
      scene.add(shoe);
    }
    world.colliders.addAabb({
      x0: p.x - ribLat - 1.1, x1: p.x + ribLat + 1.1,
      z0: p.z - 1.6, z1: p.z + 1.6, y0: gy, y1: gy + h,
    });
  }

  /* ---- marker lights ----
     Structures this size carry obstruction lighting, and at night it is the
     only thing that draws the arch before the headlights reach it: a string
     of amber points up each rib and a red pair at the crown. Soft radial
     glowTex points, not geometry, so there is no edge to print — and they go
     into neonMats, because a marker light by night is a dead lens by day. */
  {
    const amber: number[] = [], red: number[] = [];
    /* 17 per rib, not the 9 the first pass hung: at the 300 m approach the
       BEFORE contact sheet shows the arch as an unreadable black hump — the
       string was too sparse to draw the parabola before the headlights
       arrive. Denser points on the same two clouds cost nothing. */
    for (const sgn of [-1, 1])
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const q = ribPt(t, sgn);
        (Math.abs(t - 0.5) < 0.01 ? red : amber).push(q.x, q.y + 0.55, q.z);
      }
    // hanger-foot delineators at deck level, the way a real span marks its
    // kerb line — they also draw the road's own line through the arch
    for (const sgn of [-1, 1])
      for (let k = 1; k <= hangers; k++) {
        const q = deckPt(k / (hangers + 1), sgn);
        amber.push(q.x, q.y + 1.25, q.z);
      }
    for (const sgn of [-1, 1]) {
      const q = ribPt(0.5, sgn);
      red.push(q.x, q.y + 0.62, q.z);
    }
    const cloud = (pts: number[], color: number, size: number, op: number) => {
      if (!pts.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
      const m = new THREE.PointsMaterial({
        size, sizeAttenuation: false, color, map: mats.glowTex,
        transparent: true, opacity: op, fog: false, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const o = new THREE.Points(g, m);
      o.frustumCulled = false;
      scene.add(o);
      world.neonMats.push(m);
    };
    cloud(amber, 0xffb055, 2.4, 0.85);
    cloud(red, 0xff5638, 3.0, 0.9);
  }
}

/* ============================ crossing overpasses ======================= */

/** The city roads passing OVER the expressway (corridor.OVERPASSES), on
    their own piers outboard of the deck — landmarks that cost the
    width-and-taper rules BRIDGE lives under nothing, because they never
    touch the pavement edge: the girder is dressing above the car, not part
    of the deck it drives on. Reading one in the dashcam: a dark deck slides
    overhead well before the piers reach the parapet line, tail-light-red
    obstruction lights along its underside, gone in under a second at speed.
    The grove's three form a rhythm — under the city grid, one-two-three —
    where a single crossing was only a beat.

    Everything here is INSTANCED across the whole list (a girder is a scaled
    unit box like a pier is a scaled unit cylinder), so four crossings cost
    what one used to: one box mesh (girders + lips + cap beams), one pier
    mesh, one lamp-post mesh, one point cloud — 4 draw calls total.

    Each crossing also carries its own street furniture: two or three lamp
    posts on the girder with warm sodium heads. At night that is what sells
    "a street crosses here" rather than "a slab floats here" — the lit posts
    read from 400 m where the concrete reads from 60. */
function buildOverpasses(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  cor: ReturnType<typeof getCorridor>
) {
  const caps = worldTierCaps();
  const concrete = mats.concDark;
  const boxG = new THREE.BoxGeometry(1, 1, 1);
  const pierR = 1.05;
  const pierG = new THREE.CylinderGeometry(pierR, pierR * 1.2, 1, 10);
  const postG = new THREE.CylinderGeometry(0.07, 0.1, 1, 6);

  const boxes: THREE.Matrix4[] = [];
  const piers: THREE.Matrix4[] = [];
  const posts: THREE.Matrix4[] = [];
  /** [x, y, z, r, g, b] — brightness baked into colour, ≤ ~0.6, so the
      additive points can never blow white through the grade */
  const pts: number[] = [];
  /** wide soft companions behind the sodium heads — widening, not
      brightening, per the realistic-light rules (a lone 4 px dot dies in
      the POV black crush; the same light spread wider survives it) */
  const haloPts: number[] = [];
  const C = new THREE.Color();
  const lampPt = (x: number, y: number, z: number, hex: number, k: number, halo = false) => {
    C.set(hex).multiplyScalar(k);
    pts.push(x, y, z, C.r, C.g, C.b);
    if (halo) haloPts.push(x, y, z, C.r * 0.38, C.g * 0.38, C.b * 0.38);
  };
  const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(),
    E = new THREE.Euler(), SC = new THREE.Vector3();
  const put = (
    into: THREE.Matrix4[], x: number, y: number, z: number,
    sx: number, sy: number, sz: number, ry: number
  ) => {
    E.set(0, ry, 0);
    Q.setFromEuler(E);
    V.set(x, y, z);
    SC.set(sx, sy, sz);
    M.compose(V, Q, SC);
    into.push(M.clone());
  };

  for (const spec of OVERPASSES) {
    const { z, clear, girderD, girderW, outSet } = spec;
    const p = cor.pose(z);
    const soffitY = p.y + clear;
    const topY = soffitY + girderD;
    /* Outboard of the REAL edge on each side. Two of the four crossings
       (z −816 and −720) stand over the exit's deceleration lane, and a pier
       sited off halfWidth alone would be planted in it. */
    const pierLatW = cor.edgeHalf(z, -1) + outSet, pierLatE = cor.halfWidth(z) + outSet;
    const halfLen = Math.max(pierLatW, pierLatE) + 6;
    const centre = cor.worldOf(z, 0);

    /* box girder, spanning the lateral (normal) direction — local X after a
       pose.h rotation is the normal, exactly like the bridge's cross-braces */
    put(boxes, centre.x, topY - girderD / 2, centre.z, halfLen * 2, girderD, girderW, p.h);
    // fascia lip along both faces — the thin dark edge a real box girder shows
    for (const s of [-1, 1])
      put(
        boxes,
        centre.x + p.tx * s * girderW * 0.5, topY - girderD - 0.15,
        centre.z + p.tz * s * girderW * 0.5,
        halfLen * 2 + 0.4, 0.3, 0.12, p.h
      );

    /* two piers, outboard of the deck edge — clear of every lane count the
       seed can roll at this z, since pierLat is halfWidth(z) + outSet */
    for (const side of [-1, 1]) {
      const w = cor.worldOf(z, side * (side < 0 ? pierLatW : pierLatE));
      const gy = terrain.h(w.x, w.z);
      const h = Math.max(2, soffitY - gy);
      put(piers, w.x, gy + h / 2, w.z, 1, h, 1, 0);
      // cap beam under the girder, the same idiom as the deck's own piers
      put(boxes, w.x, soffitY - 0.55, w.z, 3.4, 1.1, girderW + 0.6, p.h);
      world.colliders.addAabb({
        x0: w.x - pierR * 1.3, x1: w.x + pierR * 1.3,
        z0: w.z - pierR * 1.3, z1: w.z + pierR * 1.3,
        y0: gy, y1: gy + h,
      });
    }

    /* the crossing street's own lamps: posts on the girder's leading edge,
       alternating sides, sodium heads. The folded lattice isn't needed — a
       crossing exists once (all of OVERPASSES sit inside ±(HZ − DECK_EXT),
       so no splice copy of one is ever built). */
    const postH = 5.2;
    for (const lf of [-0.62, 0.06, 0.68]) {
      const l = lf * halfLen;
      const edge = lf < 0.5 ? -1 : 1;
      const w = cor.worldOf(z, l);
      const px = w.x + p.tx * edge * (girderW / 2 - 0.5);
      const pz = w.z + p.tz * edge * (girderW / 2 - 0.5);
      put(posts, px, topY + postH / 2, pz, 1, postH, 1, p.h);
      lampPt(px, topY + postH + 0.15, pz, 0xffa04d, 0.55, true);
    }

    /* obstruction lights along the soffit edge — what reads at night before
       the geometry itself does. Faded points, never a hard-edged emissive
       strip (see the realistic-light notes). */
    for (let l = -halfLen + 3; l <= halfLen - 3; l += 5) {
      const w = cor.worldOf(z, l);
      lampPt(w.x, soffitY - 0.05, w.z, 0xff5638, 0.5);
    }
  }

  const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[]) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = true;
    im.computeBoundingSphere();
    scene.add(im);
  };
  inst(boxG, concrete, boxes);
  inst(pierG, concrete, piers);
  inst(postG, mats.pole, posts);

  /* One vertex-coloured cloud for the lot — sodium heads and red soffit
     strings together. Fog ON: it is what sinks the far crossings into the
     haze so the rhythm emerges one at a time instead of stacking three
     bright strings on the horizon (fade, never stop). Gated: the concrete
     stays on every tier, only this additive overdraw is capped. */
  if (caps.overpassLights !== false && pts.length) {
    const cloud = (arr: number[], size: number) => {
      if (!arr.length) return;
      const n = arr.length / 6;
      const pp = new Float32Array(n * 3), cc = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pp[i * 3] = arr[i * 6];
        pp[i * 3 + 1] = arr[i * 6 + 1];
        pp[i * 3 + 2] = arr[i * 6 + 2];
        cc[i * 3] = arr[i * 6 + 3];
        cc[i * 3 + 1] = arr[i * 6 + 4];
        cc[i * 3 + 2] = arr[i * 6 + 5];
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pp, 3));
      g.setAttribute("color", new THREE.BufferAttribute(cc, 3));
      const pm = new THREE.PointsMaterial({
        size, sizeAttenuation: false, vertexColors: true, map: mats.glowTex,
        transparent: true, opacity: 0.9, fog: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const o = new THREE.Points(g, pm);
      o.frustumCulled = false;
      scene.add(o);
      world.neonMats.push(pm);
    };
    cloud(pts, 4.4);
    cloud(haloPts, 14);
  }
}

/* ============================ high-mast lighting ======================== */

/** Interchange high-masts: the 28 m poles with a ring of four floodlight
    heads that mark every real expressway junction. Sited around the bypass
    diverge, the flyover crossing and the merge-side straight, on whichever
    side the bypass viaduct is NOT (its pavement swaps sides at the z≈812–844
    crossing, and a 28 m mast under the flyover would spear it — clearance
    over the deck there is 9.17 m). Verticality the corridor otherwise only
    gets from 7.6 m lamp posts, for 2 instanced meshes + a point cloud.

    The heads are cool white against the deck lamps' sodium — the colour
    change alone says "junction" from a kilometre out, the way real
    interchange lighting does. Brightness lives in the vertex colour, well
    under the blowout ceiling; fog fades the cluster in and out. */
function buildHighMasts(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  cor: ReturnType<typeof getCorridor>
) {
  /* side +1 = east (driver's left). z chosen against fixed geometry only:
     clear of WIDE_PIN's gore gap (west 500–580), the arch (320–448), the
     flyover's own crossing window, the toll (1280–1560) and every gantry
     lattice z; the seeded east tube can reach z 845 on some seeds, so the
     two masts near the flyover are checked against it at build time. */
  const SITES: readonly (readonly [number, number])[] = [
    [462, 1], [780, 1], [880, -1], [1700, -1],
  ];
  const MAST_H = 28;
  const poleG = new THREE.CylinderGeometry(0.22, 0.4, 1, 8);
  const armG = new THREE.BoxGeometry(1, 0.16, 0.16);
  const poles: THREE.Matrix4[] = [];
  const arms: THREE.Matrix4[] = [];
  const pts: number[] = [];
  const M = new THREE.Matrix4(), V = new THREE.Vector3(), Q = new THREE.Quaternion(),
    E = new THREE.Euler(), SC = new THREE.Vector3();
  for (const [z, side] of SITES) {
    if (cor.inTunnel(z, 24) || cor.inToll(z)) continue;
    const p = cor.pose(z);
    const lat = side * (cor.halfWidth(z) + 6.0);
    const w = cor.worldOf(z, lat);
    const gy = terrain.h(w.x, w.z);
    const h = p.y + MAST_H - gy;
    E.set(0, p.h, 0);
    Q.setFromEuler(E);
    V.set(w.x, gy + h / 2, w.z);
    SC.set(1, h, 1);
    M.compose(V, Q, SC);
    poles.push(M.clone());
    // two crossed head arms carrying the four-lamp ring
    for (const ry of [p.h, p.h + Math.PI / 2]) {
      E.set(0, ry, 0);
      Q.setFromEuler(E);
      V.set(w.x, gy + h - 0.7, w.z);
      SC.set(3.4, 1, 1);
      M.compose(V, Q, SC);
      arms.push(M.clone());
    }
    const top = gy + h - 0.55;
    for (const [ax, az] of [[1.45, 0], [-1.45, 0], [0, 1.45], [0, -1.45]] as const) {
      const hx = w.x + p.nx * ax + p.tx * az, hz = w.z + p.nz * ax + p.tz * az;
      pts.push(hx, top, hz);
    }
    world.colliders.addAabb({
      x0: w.x - 0.6, x1: w.x + 0.6, z0: w.z - 0.6, z1: w.z + 0.6,
      y0: gy, y1: gy + h,
    });
  }
  if (!poles.length) return;
  const inst = (geo: THREE.BufferGeometry, list: THREE.Matrix4[]) => {
    const im = new THREE.InstancedMesh(geo, mats.pole, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = true;
    im.computeBoundingSphere();
    scene.add(im);
  };
  inst(poleG, poles);
  inst(armG, arms);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
  /* Level lives in the COLOUR, not in opacity: the engine's day/night pass
     writes every neonMats opacity outright (1 at full night), so an
     opacity-tuned level would be stomped on the first frame. */
  const pm = new THREE.PointsMaterial({
    size: 5.4, sizeAttenuation: false, map: mats.glowTex,
    color: new THREE.Color(0xdfeaff).multiplyScalar(0.62),
    transparent: true, fog: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const o = new THREE.Points(g, pm);
  o.frustumCulled = false;
  scene.add(o);
  world.neonMats.push(pm);
  // the wide soft companion — same positions, a third the level, three
  // times the footprint, so the cluster survives the POV crush as a glow
  const pmh = new THREE.PointsMaterial({
    size: 16, sizeAttenuation: false, map: mats.glowTex,
    color: new THREE.Color(0xdfeaff).multiplyScalar(0.22),
    transparent: true, fog: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const oh = new THREE.Points(g, pmh);
  oh.frustumCulled = false;
  scene.add(oh);
  world.neonMats.push(pmh);
}

/* ============================ tunnel ==================================== */

/* Every tunnel on the lap, built in ONE pass.

   The lap used to have exactly one tube at a fixed z, so this function read
   TUNNEL.z0/z1 straight out of corridor.ts and made a mesh per part. There
   are two tubes now — and how long, how wide and where they are all come off
   the road seed — so everything here is driven from `cor.tunnels()`, and
   every part that repeats is pooled across the tubes rather than duplicated
   per tube: one set of soups for the bores, one instanced mesh per portal
   part for all four mouths, one batten/fan/cabinet/exit-board instance buffer
   for the lot.

   That is not tidiness, it is the budget. Built the old way, two tubes cost
   ~72 draw calls; pooled, two tubes cost ~24 — fewer than the single tunnel
   used to, because the portal architecture (21 separate meshes per pair of
   mouths) is the part that dominates and it is now 7. The extra geometry is
   noise by comparison: the bore is ~11 quads per 4 m station per side, so a
   670 m lap of tunnel is ~8k triangles. */
function buildTunnel(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  cor: ReturnType<typeof getCorridor>,
  pt: (i: number, lat: number, dy?: number) => Vec3
) {
  const TUBES = cor.tunnels();
  if (!TUBES.length) return;
  const H = TUBES[0].clearH; // clear height under the ceiling
  /* Tiled walls, shared from mats so the scanned concrete can reach them (see
     the fascia note above). The material's self-illumination stands in for the
     bounce light a real tunnel gets off its own tiling — without it the tube
     goes pitch black a few metres past the last batten, because the sun and
     moon are both outside. */
  const tileMat = mats.tunnelWall;
  const ceilMat = mats.tunnelCeil;

  /* ---- the bore ----------------------------------------------------------
     What made the old tube read as a corridor of flat panels rather than as a
     tunnel was that it was a BOX: two vertical planes and a lid, with the
     walls 0.55 m outside the shoulder, i.e. very nearly against the lane. Two
     things fix that and they are the same change:

     - the wall face moves out to TUBE_OUT, which buys room for the raised
       service walkway every road tunnel has. The kerb sits just outboard of
       the analytic parapet clamp in collide.ts (halfWidth + 0.06), so the
       walkway is somewhere the car cannot reach and nothing about how the
       tunnel drives changes — only what is beside you while you do.
     - the lid becomes a haunch. Above the springing the section chamfers in
       over four short facets to a flat crown, which is what a bored or cut-
       and-cover tube actually looks like, and — because the facets catch the
       ceiling battens at four different angles — it is also what stops the
       roof reading as one grey plane sliding past.

     The profile is stated once, as (inward offset from the wall face, height)
     pairs, and swept; the walkway, dado, duct and crown all come off it. It is
     swept from the corridor's own stations, so a five-lane bore needs nothing
     here: the wall face is a.hw + TUBE_OUT and a.hw already knows. */
  const TUBE_OUT = 1.55; // wall face, outboard of the pavement edge
  /* Kerb face at halfWidth + 0.06 — the same lateral line the parapet's inner
     face uses everywhere else, and the same line the analytic clamp in
     collide.ts stops the car on. Anything further out leaves a slot between
     the pavement edge and the kerb that looks straight through the deck. */
  const KERB_IN = 0.06;
  const WALK_H = 0.26;
  const DADO_Y = 2.3; // top of the dark lower band
  const DUCT_Y = 3.55, DUCT_H = 0.42, DUCT_OUT = 0.24; // cable-tray run
  const SPRING_Y = 4.1; // where the wall stops being vertical
  /** haunch facets, [offset inward from the wall face, height] */
  const HAUNCH: readonly (readonly [number, number])[] = [
    [0, SPRING_Y], [0.25, 4.95], [0.85, 5.65], [1.8, 6.15], [3.0, H],
  ];
  const CROWN_IN = HAUNCH[HAUNCH.length - 1][0];

  const wallS = new Soup(), ceilS = new Soup(), dadoS = new Soup(),
    walkS = new Soup(), ductS = new Soup();
  for (const T of TUBES) {
    const i0 = Math.max(0, Math.floor((T.z0 - cor.ZB0) / 4));
    const i1 = Math.min(cor.stations.length - 2, Math.ceil((T.z1 - cor.ZB0) / 4));
    for (let i = i0; i < i1; i++) {
      const a = cor.stations[i], b = cor.stations[i + 1];
      const wa = a.hw + TUBE_OUT, wb = b.hw + TUBE_OUT;
      for (const sgn of [-1, 1]) {
        /** wall-relative: `o` metres inward from the face, `y` metres up */
        const P = (i2: number, w: number, o: number, y: number) =>
          pt(i2, sgn * (w - o), y);
        // raised service walkway: top face, then its kerb down to the deck
        const ka = a.hw + KERB_IN, kb = b.hw + KERB_IN;
        walkS.quad(
          pt(i, sgn * wa, WALK_H), pt(i + 1, sgn * wb, WALK_H),
          pt(i + 1, sgn * kb, WALK_H), pt(i, sgn * ka, WALK_H)
        );
        // …and its kerb, carried below the deck like the parapet's own skirt so
        // no sliver of the drop shows at the join
        walkS.quad(
          pt(i, sgn * ka, -0.3), pt(i + 1, sgn * kb, -0.3),
          pt(i + 1, sgn * kb, WALK_H), pt(i, sgn * ka, WALK_H)
        );
        // dark lower band — a real tube is filthy at splash height and clean
        // above it, and the line between the two is a longitudinal speed cue
        dadoS.quad(
          P(i, wa, 0, WALK_H), P(i + 1, wb, 0, WALK_H),
          P(i + 1, wb, 0, DADO_Y), P(i, wa, 0, DADO_Y)
        );
        // clean upper wall, up to the springing
        wallS.quad(
          P(i, wa, 0, DADO_Y), P(i + 1, wb, 0, DADO_Y),
          P(i + 1, wb, 0, SPRING_Y), P(i, wa, 0, SPRING_Y)
        );
        // haunch facets
        for (let k = 0; k < HAUNCH.length - 1; k++) {
          const [o0, y0] = HAUNCH[k], [o1, y1] = HAUNCH[k + 1];
          wallS.quad(
            P(i, wa, o0, y0), P(i + 1, wb, o0, y0),
            P(i + 1, wb, o1, y1), P(i, wa, o1, y1)
          );
        }
        // boxed cable-tray run: underside, face, top
        const oD = -DUCT_OUT; // outward of the wall face is a negative "inward"
        ductS.quad(
          P(i, wa, 0, DUCT_Y), P(i + 1, wb, 0, DUCT_Y),
          P(i + 1, wb, oD, DUCT_Y), P(i, wa, oD, DUCT_Y)
        );
        ductS.quad(
          P(i, wa, oD, DUCT_Y), P(i + 1, wb, oD, DUCT_Y),
          P(i + 1, wb, oD, DUCT_Y + DUCT_H), P(i, wa, oD, DUCT_Y + DUCT_H)
        );
        ductS.quad(
          P(i, wa, oD, DUCT_Y + DUCT_H), P(i + 1, wb, oD, DUCT_Y + DUCT_H),
          P(i + 1, wb, 0, DUCT_Y + DUCT_H), P(i, wa, 0, DUCT_Y + DUCT_H)
        );
      }
      // flat crown between the two haunches
      const ca = wa - CROWN_IN, cb = wb - CROWN_IN;
      ceilS.quad(pt(i, -ca, H), pt(i + 1, -cb, H), pt(i + 1, cb, H), pt(i, ca, H));
    }
  }
  /* DoubleSide like every other surface in the tube, and not optional: the
     wall quads above are emitted with one vertex order for both values of
     `sgn`, and mirroring across x reverses the winding, so on one side of the
     tunnel every dado face points outward. Single-sided, that wall's splash
     band is simply not drawn from inside — you look straight through it at
     the city beyond, which is exactly the reported see-through wall. The
     tile, ceiling, duct and walkway materials are all already DoubleSide,
     which is why only this band was affected and only on one side. */
  const dadoMat = new THREE.MeshStandardMaterial({
    color: 0x2b2f38, roughness: 0.92, side: THREE.DoubleSide,
  });
  const ductMat = new THREE.MeshStandardMaterial({
    color: 0x3a4049, roughness: 0.55, metalness: 0.55, side: THREE.DoubleSide,
  });
  const wm = new THREE.Mesh(wallS.geom(false), tileMat);
  const cm = new THREE.Mesh(ceilS.geom(false), ceilMat);
  wm.receiveShadow = true;
  scene.add(wm, cm);
  scene.add(new THREE.Mesh(dadoS.geom(false), dadoMat));
  scene.add(new THREE.Mesh(walkS.geom(false), mats.concDarkDouble));
  scene.add(new THREE.Mesh(ductS.geom(false), ductMat));

  const M = new THREE.Matrix4(), L = new THREE.Matrix4(), G = new THREE.Matrix4(),
    V = new THREE.Vector3(), Q = new THREE.Quaternion(),
    E = new THREE.Euler(), S = new THREE.Vector3(1, 1, 1);

  /* ---- portal architecture ----------------------------------------------
     The bare collar read as a cardboard cut-out; a real urban tunnel mouth is
     a piece of civil engineering — a headwall carrying the hill, splayed wing
     walls, and a rack of signage bolted to the face. All of it shares the
     deck-concrete material so the photoscan reaches it.

     Every part is instanced from a unit box or a unit plane and sized by the
     instance scale, because the four mouths are four different widths (the
     bore follows the lane count) — a per-mouth BoxGeometry would be four
     geometries and four draw calls each. The one exception is the name board,
     which carries a different texture per tunnel and so cannot share. */
  const portalMat = mats.concDouble;
  const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
  const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
  const mouths = TUBES.length * 2;
  const inst = (g: THREE.BufferGeometry, m: THREE.Material, n: number) => {
    const im = new THREE.InstancedMesh(g, m, n);
    im.count = 0;
    return im;
  };
  const tops = inst(UNIT_BOX, portalMat, mouths);
  const legs = inst(UNIT_BOX, portalMat, mouths * 2);
  const heads = inst(UNIT_BOX, portalMat, mouths);
  const wings = inst(UNIT_BOX, portalMat, mouths * 2);
  const chevs = inst(UNIT_PLANE, new THREE.MeshBasicMaterial({ map: mats.chevTex }), mouths);
  /* Signage textures are drawn once and shared by every entry mouth: only the
     name board says anything tunnel-specific. */
  const clrTex = makeTex(224, 96, (ctx, w2, h2) => {
    ctx.fillStyle = "#d8a41c";
    ctx.fillRect(0, 0, w2, h2);
    ctx.fillStyle = "#171204";
    ctx.textAlign = "center";
    ctx.font = "800 40px sans-serif";
    ctx.fillText("制限高", w2 / 2, 40);
    ctx.fillText("4.5m", w2 / 2, 82);
  });
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
  const clrs = inst(UNIT_PLANE, new THREE.MeshBasicMaterial({ map: clrTex }), TUBES.length);
  const spds = inst(UNIT_PLANE,
    new THREE.MeshBasicMaterial({ map: spdTex, transparent: true }), TUBES.length);
  /** place one instanced part in the mouth's local frame */
  const put = (
    im: THREE.InstancedMesh, px: number, py: number, pz: number,
    sx: number, sy: number, sz: number, ry = 0, rz = 0
  ) => {
    E.set(0, ry, rz);
    Q.setFromEuler(E);
    L.compose(V.set(px, py, pz), Q, S.set(sx, sy, sz));
    M.multiplyMatrices(G, L);
    im.setMatrixAt(im.count++, M);
  };

  for (const T of TUBES) {
    for (const z of [T.z0, T.z1]) {
      const entry = z === T.z0;
      // the hill is inside the tube: +z of the entry mouth, -z of the exit one
      const inward = entry ? 1 : -1;
      const p = cor.pose(z);
      const hw = cor.halfWidth(z) + TUBE_OUT;
      E.set(0, p.h, 0);
      G.compose(V.set(p.x, p.y, p.z), Q.setFromEuler(E), S.set(1, 1, 1));
      put(tops, 0, H + 1.1, 0, hw * 2 + 3.4, 2.2, 1.6);
      for (const s of [-1, 1])
        put(legs, s * (hw + 0.85), (H + 2.2) / 2, 0, 1.7, H + 2.2, 1.6);
      // headwall above and behind the collar, and wing walls splaying off it
      put(heads, 0, H + 2.6, inward * 1.5, hw * 2 + 13, 5.4, 1.1);
      for (const s of [-1, 1])
        put(wings, s * (hw + 5.6), (H + 4.4) / 2 - 1.6, inward * 3.4,
          1.1, H + 4.4, 7, s * 0.42, s * 0.05);
      /* Hazard chevrons across the header. This texture has an opaque
         near-black background, so unlike the (bright) sign panels it must
         respect fog — otherwise it stays jet black while the portal around it
         fades out, and reads as a black polygon hanging in the air.
         5 cm off the collar face was close enough to z-fight at distance. */
      put(chevs, 0, H + 1.1, -0.95, hw * 2 + 3, 1.0, 1, Math.PI);
      if (!entry) continue;
      // clearance board on the left leg, speed roundel on the right
      put(clrs, -(hw + 0.85), 4.1, -0.85, 1.7, 0.75, 1, Math.PI);
      put(spds, hw + 0.85, 4.1, -0.85, 0.95, 0.95, 1, Math.PI);
      // tunnel name board on the headwall face, over the mouth. Its own
      // texture — the name and the length are what make one tube not another.
      const nameTex = makeTex(512, 96, (ctx, w2, h2) => {
        ctx.fillStyle = "#12312b";
        ctx.fillRect(0, 0, w2, h2);
        ctx.strokeStyle = "#dfe9e4";
        ctx.lineWidth = 4;
        ctx.strokeRect(4, 4, w2 - 8, h2 - 8);
        ctx.fillStyle = "#eef6f1";
        ctx.textAlign = "center";
        ctx.font = '700 44px "Hiragino Sans","Yu Gothic",sans-serif';
        ctx.fillText(T.nameJa, w2 / 2, 44);
        ctx.font = "700 26px sans-serif";
        ctx.fillText(`${T.nameEn}  ${Math.round(T.z1 - T.z0)}m`, w2 / 2, 80);
      });
      const name = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 1.4),
        new THREE.MeshBasicMaterial({ map: nameTex }));
      name.position.set(0, H + 2.8, inward * 1.5 - inward * 0.6);
      name.rotation.y = Math.PI;
      const g = new THREE.Group();
      g.add(name);
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = p.h;
      scene.add(g);
    }
  }
  for (const im of [tops, legs, heads, wings, chevs, clrs, spds]) {
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    scene.add(im);
  }

  /* Ceiling lighting: twin-tube fluorescent fixtures — a dark housing carrying
     two emissive tubes — plus an additive glow sprite, which is what actually
     reads as light without adding real lights to a scene that is already at
     its shadow-caster budget.

     The spacing is not uniform, and that is the point. Every real road tunnel
     runs a THRESHOLD ZONE at each mouth: the fittings crowd up near the portal
     and thin out to the interior pitch a hundred metres in, because a driver
     coming out of daylight cannot adapt fast enough otherwise. Copying that
     gives the tube a lighting rhythm that changes as you travel through it —
     dense, opening out, dense again — instead of one metronome from end to
     end, and it does it by moving fixtures rather than by changing any
     brightness, so nothing here can print an edge. The threshold is per-tube,
     so a short bore is all threshold and a long one has a sparse middle. */
  const battenMat = new THREE.MeshBasicMaterial({ color: 0xfff0cf, fog: false });
  const housingMat = new THREE.MeshStandardMaterial({
    color: 0x272b33, roughness: 0.6, metalness: 0.5 });
  /** fixture z's: 7 m through the first and last THRESH metres, 14 m between */
  const battenZ: number[] = [];
  for (const T of TUBES) {
    const THRESH = 70, LEN = T.z1 - T.z0;
    for (let d = 3.5; d < LEN; ) {
      battenZ.push(T.z0 + d);
      d += Math.min(d, LEN - d) < THRESH ? 7 : 14;
    }
  }
  const NL = battenZ.length;
  const housing = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.5, 0.16, 4.9), housingMat, NL);
  const bat = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.07, 4.5), battenMat, NL * 2);
  /* Low wall-washer fittings: the emissive lens the existing glow points were
     always pretending to hang from. */
  const washer = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.55, 0.1, 0.9),
    new THREE.MeshBasicMaterial({ color: 0xffe3ae, fog: false }), NL * 2);
  const glowPts: number[] = [];
  let n = 0, nt = 0, nw = 0;
  for (const z of battenZ) {
    const p = cor.pose(z);
    E.set(0, p.h, 0);
    Q.setFromEuler(E);
    S.set(1, 1, 1);
    V.set(p.x, p.y + H - 0.1, p.z);
    M.compose(V, Q, S);
    housing.setMatrixAt(n++, M);
    for (const s of [-1, 1]) {
      V.set(p.x + s * 0.34 * p.nx, p.y + H - 0.2, p.z + s * 0.34 * p.nz);
      M.compose(V, Q, S);
      bat.setMatrixAt(nt++, M);
    }
    glowPts.push(p.x, p.y + H - 0.3, p.z);
    // wall-washer strips low down on both sides, sitting on the wall face
    // just above the dado line rather than floating beside it
    for (const sgn of [-1, 1]) {
      const lat = sgn * (cor.halfWidth(z) + TUBE_OUT - 0.06);
      glowPts.push(p.x + lat * p.nx, p.y + DADO_Y + 0.3, p.z + lat * p.nz);
      const wlat = sgn * (cor.halfWidth(z) + TUBE_OUT - 0.25);
      V.set(p.x + wlat * p.nx, p.y + DADO_Y + 0.42, p.z + wlat * p.nz);
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
    for (const T of TUBES)
      for (let z = T.z0 + 50; z < T.z1 - 30; z += 84) fanZ.push(z);
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
        S.set(1, 1, 1);
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

  /* Emergency-phone cabinets on the right-hand walkway. The walkway is the
     whole reason these can exist — before the bore was widened there was
     nowhere to stand one — and they are the piece of furniture that makes the
     tube read as a serviced structure rather than a lined hole. Yellow box,
     orange 非常電話 plate, one instanced pair for the lot of them; spaced so
     they interleave with the green exit boards on the opposite wall rather
     than passing at the same instant. */
  {
    const sosZ: number[] = [];
    for (const T of TUBES) {
      const NP = Math.floor((T.z1 - T.z0 - 90) / 84);
      for (let k = 0; k < NP; k++) sosZ.push(T.z0 + 72 + k * 84);
    }
    if (sosZ.length) {
      const boxMat = new THREE.MeshStandardMaterial({
        color: 0xb9812a, roughness: 0.6, metalness: 0.35,
      });
      const box = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.36, 1.15, 0.78), boxMat, sosZ.length);
      const sosTex = makeTex(192, 96, (ctx, w2, h2) => {
        ctx.fillStyle = "#d4531c";
        ctx.fillRect(0, 0, w2, h2);
        ctx.fillStyle = "#fff3e2";
        ctx.textAlign = "center";
        ctx.font = '700 32px "Hiragino Sans",sans-serif';
        ctx.fillText("非常電話", w2 / 2, 40);
        ctx.font = "800 34px sans-serif";
        ctx.fillText("SOS", w2 / 2, 80);
      });
      const plate = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.68, 0.34),
        new THREE.MeshBasicMaterial({ map: sosTex, fog: false }), sosZ.length);
      let np = 0;
      S.set(1, 1, 1);
      for (const z of sosZ) {
        const p = cor.pose(z);
        const lat = cor.halfWidth(z) + TUBE_OUT - 0.2;
        E.set(0, p.h, 0);
        Q.setFromEuler(E);
        V.set(p.x + lat * p.nx, p.y + WALK_H + 0.58, p.z + lat * p.nz);
        M.compose(V, Q, S);
        box.setMatrixAt(np, M);
        E.set(0, p.h - Math.PI / 2, 0); // face across the tube, at the driver
        Q.setFromEuler(E);
        const pl = lat - 0.2;
        V.set(p.x + pl * p.nx, p.y + WALK_H + 0.86, p.z + pl * p.nz);
        M.compose(V, Q, S);
        plate.setMatrixAt(np++, M);
      }
      box.count = plate.count = np;
      box.computeBoundingSphere();
      plate.computeBoundingSphere();
      scene.add(box, plate);
    }
  }

  /* Emergency-exit boards down the left wall — the single most recognisable
     piece of tunnel furniture there is, and their green is the only colour in
     the tube that is not sodium. Unlit like the battens: it is night in here
     at every hour. */
  {
    const exitZ: number[] = [];
    for (const T of TUBES) {
      const NE = Math.floor((T.z1 - T.z0 - 60) / 56);
      for (let k = 0; k < NE; k++) exitZ.push(T.z0 + 44 + k * 56);
    }
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
    const exits = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1.2, 0.55), exitMat, Math.max(1, exitZ.length));
    let ne = 0;
    S.set(1, 1, 1);
    for (const z of exitZ) {
      const p = cor.pose(z);
      const lat = -(cor.halfWidth(z) + TUBE_OUT - 0.08);
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
  /* size 5.5 -> 4.8, opacity 0.9 -> 0.68. Deliberately a modest cut, because
     inside the tube these ARE the lighting and dimming them far would make
     the tunnel a dark hole.

     What makes the tunnel read as one blinding point from a kilometre out is
     not any single lamp, it is that the whole run of them is additive with
     `fog: false` and `sizeAttenuation: false`. Every lamp along the bore
     therefore contributes its full screen-size, full-brightness sprite no
     matter how far away it is, and at range they all project into a few
     pixels and sum — so the further away you are, the more of them stack into
     the same spot. Level is the only lever pulled here.

     If it still reads as a beacon on approach, the structural fix is to
     attenuate with distance rather than to dim further: either
     `sizeAttenuation: true` (so distant lamps shrink instead of stacking at
     full size) or a distance fade on the material. Both change the look
     inside the tube as well, which is why this pass did not reach for them. */
  const gm = new THREE.PointsMaterial({
    size: 4.8, sizeAttenuation: false, color: 0xffe0a8, map: mats.glowTex,
    transparent: true, opacity: 0.68, fog: false, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const gp = new THREE.Points(gg, gm);
  gp.frustumCulled = false;
  scene.add(gp);
  // deliberately not registered in world.neonMats: the engine dims those with
  // daylight, and a tunnel's lights are exactly the ones that must stay on
}


/* ============================ toll plaza ================================ */

/** Cool-white light carpet under the toll canopy. The lamp lattice and its
    ground pools both skip cor.inToll(z), so without this the whole 280 m toll
    stretch is the darkest hole on the road — exactly where the player needs
    to read gates at 200 km/h. Built like poolGradientTex (decaltex.ts): a
    per-pixel rounded-rect falloff sampled from a smooth decelerating curve
    with a long low tail, so the POV pass's black crush meets a fade, not a
    printed edge. Flat core under the canopy (where the troffers are), tails
    spilling out ahead of and behind it the way canopy light really does. */
function tollCarpetTex(): THREE.Texture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(256, 256);
  // u = lateral (across the road), v = longitudinal (along it)
  const CORE_U = 0.42, CORE_V = 0.5;
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const u = Math.abs(x / 127.5 - 1), v = Math.abs(y / 127.5 - 1);
      const du = Math.max(0, (u - CORE_U) / (1 - CORE_U));
      const dv = Math.max(0, (v - CORE_V) / (1 - CORE_V));
      const t = Math.min(1, Math.hypot(du, dv));
      /* decelerating, monotone, zero exactly at the quad edge; most of the
         outer third sits near the crush floor instead of diving through it */
      const a = 0.6 * Math.pow(1 - t, 1.55) * (1 - 0.3 * t);
      const i = (y * 256 + x) * 4;
      img.data[i] = 226; img.data[i + 1] = 234; img.data[i + 2] = 247;
      img.data[i + 3] = Math.round(a * 255);
    }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

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
  /* Illuminated fascia band across the WHOLE approach face — the beacon.
     A real plaza's canopy fascia is an internally lit amber band with the
     name board and hazard chevrons painted on it, and it is the single
     thing that reads from hundreds of metres out (the corridor is dead
     straight from z = 880, so this band is framed in the tunnel portal for
     the entire tube). MeshBasic so it stays lit with no dynamic light, but
     fogged — an unfogged band would hang in the haze as a hard rectangle
     (see the cantilever board note). The amber field is deliberately held
     around 0.72 luma: the ACES grade bleaches ≳0.8 to white, and a band
     that stays AMBER at its brightest is what reads as sodium-lit signage
     rather than a blown strip light. */
  const bandTex = makeTex(1024, 144, (ctx, w2, h2) => {
    const g2 = ctx.createLinearGradient(0, 0, 0, h2);
    g2.addColorStop(0, "#c09a3c");
    g2.addColorStop(0.45, "#e0b84e");
    g2.addColorStop(1, "#c7a244");
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w2, h2);
    // yellow/black hazard chevron blocks: both ends + centred over the gates
    const chev = (x0: number, cw: number) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 10, cw, h2 - 20);
      ctx.clip();
      ctx.fillStyle = "#14161d";
      ctx.fillRect(x0, 10, cw, h2 - 20);
      ctx.strokeStyle = "#e8c44c";
      ctx.lineWidth = 16;
      for (let x = x0 - h2; x < x0 + cw + h2; x += 34) {
        ctx.beginPath();
        ctx.moveTo(x, h2 - 6);
        ctx.lineTo(x + h2, 6);
        ctx.stroke();
      }
      ctx.restore();
    };
    chev(24, 120);
    chev(452, 120);
    chev(880, 120);
    ctx.fillStyle = "#101826";
    ctx.textAlign = "center";
    ctx.font = '800 62px "Hiragino Sans","Yu Gothic",sans-serif';
    ctx.fillText("料金所", 298, 74);
    ctx.fillText("料金所", 726, 74);
    ctx.font = "800 32px sans-serif";
    ctx.fillText("TOLL GATE", 298, 122);
    ctx.fillText("TOLL GATE", 726, 122);
    ctx.strokeStyle = "#10151f";
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w2 - 10, h2 - 10);
  });
  const bandGeo = new THREE.PlaneGeometry(CW + 0.3, 1.9);
  const band = new THREE.Mesh(bandGeo, new THREE.MeshBasicMaterial({ map: bandTex }));
  band.position.set(0, 7.15, -CL / 2 - 0.24);
  band.rotation.y = Math.PI;
  plaza.add(band);
  // the rear face carries the same band dimmed, so the mirrors after the
  // gates show a lit plaza receding, not a hole where one used to be
  const bandRear = new THREE.Mesh(bandGeo,
    new THREE.MeshBasicMaterial({ map: bandTex, color: 0x878c98 }));
  bandRear.position.set(0, 7.15, CL / 2 + 0.24);
  plaza.add(bandRear);
  /* Marker-light string along the fascia top: a row of unfogged amber points
     (same recipe as the parapet delineators — fog:false, constant pixel
     size) so the canopy edge survives the haze as a horizontal string of
     lights long before the fogged band carries any colour. A horizontal
     row of lights over the road is the oldest "structure ahead" cue there
     is, and it costs one draw call. */
  if (FX_TOLL_GLOW && worldTierCaps().tollGlow !== false) {
    const NMK = 13;
    const mp: number[] = [];
    // above the band's top edge (8.1) and proud of its plane (−0.24), so the
    // band never depth-occludes its own marker lights on the approach
    for (let i = 0; i < NMK; i++)
      mp.push(-CW / 2 + 0.6 + i * ((CW - 1.2) / (NMK - 1)), 8.28, -CL / 2 - 0.3);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mp), 3));
    /* opacity 0.95 -> 0.62. Same story as the canopy cloud: additive, no fog,
       no size attenuation, so these 13 amber markers were at full strength
       from any distance and contributed a large share of the plaza's glare on
       the approach. The amber is well clear of the bleach threshold and is
       kept — it is the colour that identifies the plaza at range. */
    const mm = new THREE.PointsMaterial({
      size: 2.7, sizeAttenuation: false, color: 0xffb055, map: mats.glowTex,
      transparent: true, opacity: 0.62, fog: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mpts = new THREE.Points(mg, mm);
    mpts.frustumCulled = false;
    plaza.add(mpts);
    world.neonMats.push(mm); // a lit string by night is a dead fitting by day
  }
  /* The soffit fakes its own bounce light: nothing dynamic ever reaches it
     (the troffers are emissive props, not lights), so without the emissive
     term the canopy underside is a black slab over a lit plaza. */
  const soffit = new THREE.Mesh(new THREE.BoxGeometry(CW - 1.2, 0.16, CL - 1.2),
    new THREE.MeshStandardMaterial({
      color: 0xe6e9ef, roughness: 0.6,
      // faked bounce, pulled back with the fittings that are supposed to be
      // causing it — a soffit brighter than the plaza it lights reads as a
      // glowing ceiling rather than as reflected light
      emissive: 0x363b45, emissiveIntensity: 1 }));
  soffit.position.y = 6.92;
  plaza.add(soffit);
  /* Underside lighting: rows of emissive troffers plus a cloud of additive
     glow — a real plaza is a pool of flat white light under a dark roof, and
     that read is the whole reason to slow down for it. Not registered in
     neonMats: the canopy shades its own soffit, so these stay lit by day. */
  if (FX_TOLL_GLOW && worldTierCaps().tollGlow !== false) {
    /* 0xf4f6ff -> 0xc2cadd. MeshBasic is unlit, so this colour IS the output
       value: 0xf4f6ff is ~0.96 and lands above the grade's bleach threshold,
       where ACES plus the vibrance rolloff strip the hue and print pure
       white. Backing off to ~0.78 keeps the fittings clearly the brightest
       thing under the canopy while leaving them a colour rather than a hole
       punched in the frame. */
    const troffMat = new THREE.MeshBasicMaterial({ color: 0xc2cadd, fog: false });
    // three rows — the old two left a dark stripe down the middle gate, the
    // one lane the player is most likely to thread
    const NTR = 3 * 7;
    const troff = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 0.09, 0.55), troffMat, NTR);
    const TM = new THREE.Matrix4(), TV = new THREE.Vector3(),
      TQ = new THREE.Quaternion(), TS = new THREE.Vector3(1, 1, 1);
    const canopyGlow: number[] = [];
    let ntr = 0;
    for (const sx of [-1, 0, 1])
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
    /* Toned down hard (size 6.5 -> 4.6, opacity 0.8 -> 0.4, and off pure
       white): 21 additive near-white points at 0.8 stack into a core well
       past the ~0.8 luma where the ACES pass bleaches everything to white, so
       the plaza read as a single blown highlight rather than as lit.

       `sizeAttenuation: false` is why it was also a beacon from a kilometre
       out — the points hold constant SCREEN size no matter how far away they
       are, and with `fog: false` nothing attenuates them with distance
       either, so the approach looked exactly as bright as standing under it.
       Attenuation is left off deliberately (it is what keeps the plaza
       readable on approach at 200 km/h, which is the whole point of the
       fitting) and the level carries the reduction instead.

       Colour off pure white for the same reason as the lamp cones: a
       saturated source survives the grade as a colour, a near-white one
       bleaches. 0xd8e2f4 keeps the cool cast without sitting on the clip. */
    const cgm = new THREE.PointsMaterial({
      size: 4.6, sizeAttenuation: false, color: 0xd8e2f4, map: mats.glowTex,
      transparent: true, opacity: 0.4, fog: false, depthWrite: false,
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
  /* Per-lane OPEN signal: green down-arrow over a dark red-X slot, the
     universal toll-lane state light. Drawn as a lens texture — glow ring
     first in saturated green, then a lighter core kept off pure white, so
     the fixture fades outward instead of reading as a blown dot (the grade
     bleaches ≳0.8 luma; hue is saturated early and held). fog:false: a
     signal lens is the one thing that must stay legible in the haze. */
  const sigTex = makeTex(160, 256, (ctx, w2, h2) => {
    ctx.fillStyle = "#0a0c11";
    ctx.fillRect(0, 0, w2, h2);
    ctx.strokeStyle = "#272c35";
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, w2 - 8, h2 - 8);
    // the dark red X above the arrow is what sells this as a signal that
    // COULD close, rather than a decorative lamp — unlit: every gate is open
    ctx.strokeStyle = "#471310";
    ctx.lineWidth = 15;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(52, 34); ctx.lineTo(108, 90);
    ctx.moveTo(108, 34); ctx.lineTo(52, 90);
    ctx.stroke();
    const arrow = (wd: number, col: string, blur: number, glow: string) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = wd;
      ctx.shadowColor = glow;
      ctx.shadowBlur = blur;
      ctx.beginPath();
      ctx.moveTo(80, 122); ctx.lineTo(80, 218);
      ctx.moveTo(48, 186); ctx.lineTo(80, 222);
      ctx.moveTo(112, 186); ctx.lineTo(80, 222);
      ctx.stroke();
    };
    arrow(18, "#1fae5e", 26, "#17c96b");
    arrow(9, "#7df0ae", 8, "#3ce487");
    ctx.shadowBlur = 0;
  });
  const sigHousG = new THREE.BoxGeometry(0.78, 1.28, 0.22);
  const sigHousMat = new THREE.MeshStandardMaterial({
    color: 0x1c1f26, roughness: 0.55, metalness: 0.5 });
  const sigLensG = new THREE.PlaneGeometry(0.66, 1.06);
  const sigLensMat = new THREE.MeshBasicMaterial({ map: sigTex, fog: false });
  const sigHaloMat = new THREE.SpriteMaterial({
    map: mats.glowTex, color: 0x4dffa0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8,
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
    /* Lane status signal under each sign: dark housing, the arrow/X lens
       texture, and a wide soft halo. Every gate runs green because every
       gate is open (the plaza deliberately never closes a lane the player
       can thread). The halo is wider than the old one rather than brighter:
       a wider footprint keeps more pixels above the POV black crush, which
       is what makes it carry at distance. */
    const sig = new THREE.Group();
    sig.position.set(cor.laneOffset(k, zc), 4.15, -CL / 2 + 1.05);
    const hous = new THREE.Mesh(sigHousG, sigHousMat);
    sig.add(hous);
    const lens = new THREE.Mesh(sigLensG, sigLensMat);
    lens.position.set(0, 0, -0.13);
    lens.rotation.y = Math.PI;
    sig.add(lens);
    const halo = new THREE.Sprite(sigHaloMat);
    halo.scale.set(2.0, 2.0, 1);
    halo.position.set(0, -0.28, -0.2);
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
        world.compileDirty = true; // landed after the load's compile pass
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
        world.compileDirty = true; // landed after the load's compile pass
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
  /* ---- approach furniture: the near-field targets ----
     Striped attenuator boards standing on every island nose and on the two
     outer barrier-run ends, with an amber marker glow above each. These are
     the last thing the driver fixates before committing to a gate, and the
     stripes are retroreflective paint — MeshBasic, fogged like the
     cantilever boards, so the headlights "find" them naturally. */
  {
    const noseTex = makeTex(128, 128, (ctx, w2, h2) => {
      ctx.fillStyle = "#16171c";
      ctx.fillRect(0, 0, w2, h2);
      ctx.strokeStyle = "#e2bf46";
      ctx.lineWidth = 17;
      for (let x = -h2; x < w2 + h2; x += 44) {
        ctx.beginPath();
        ctx.moveTo(x, h2 + 8);
        ctx.lineTo(x + h2, -8);
        ctx.stroke();
      }
      ctx.strokeStyle = "#0c0d12";
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, w2 - 8, h2 - 8);
    });
    const noseSlots: [number, number][] = [];
    for (let k = 1; k < lanes; k++)
      noseSlots.push([cor.laneEdge(k, zc), -IL / 2 - 6.2]);
    for (const s of [-1, 1]) noseSlots.push([s * (hw - 0.55), -CL / 2 - 0.6]);
    const noseIm = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.95, 1.15),
      new THREE.MeshBasicMaterial({ map: noseTex }),
      noseSlots.length);
    const NM = new THREE.Matrix4(), NV = new THREE.Vector3(),
      NQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)),
      NS = new THREE.Vector3(1, 1, 1);
    noseSlots.forEach(([lat, dz], i) => {
      NV.set(lat, 0.78, dz);
      NM.compose(NV, NQ, NS);
      noseIm.setMatrixAt(i, NM);
    });
    noseIm.computeBoundingSphere();
    plaza.add(noseIm);
    if (FX_TOLL_GLOW && worldTierCaps().tollGlow !== false) {
      // amber marker on each board — the same unfogged glow-point recipe as
      // the gore beacons, so the island noses read before the paint does
      const bpts: number[] = [];
      // just above the board's top edge, so the glow reads as a lamp mounted
      // on the board rather than a dot floating over it
      for (const [lat, dz] of noseSlots) bpts.push(lat, 1.48, dz);
      const bg2 = new THREE.BufferGeometry();
      bg2.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bpts), 3));
      const bm2 = new THREE.PointsMaterial({
        size: 3.2, sizeAttenuation: false, color: 0xffb143, map: mats.glowTex,
        transparent: true, opacity: 0.95, fog: false, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const bp2 = new THREE.Points(bg2, bm2);
      bp2.frustumCulled = false;
      plaza.add(bp2);
      world.neonMats.push(bm2);

      /* The light carpet (see tollCarpetTex). The troffers light the cars
         (traffic.ts's TOLL_WASH) but nothing was lighting the ROAD — the
         lamp lattice skips the whole toll stretch, so the plaza floated in
         a black hole. One additive quad, flat core under the canopy, long
         spill tails up and down the road. Sized from the corridor's own
         half-width so it never hangs off the deck edge, and registered in
         neonMats so daylight dims it with the rest of the night dressing. */
      const carpetG = new THREE.PlaneGeometry(2 * (hw + 0.7), 74);
      carpetG.rotateX(-Math.PI / 2);
      const carpetMat = new THREE.MeshBasicMaterial({
        map: tollCarpetTex(), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const carpet = new THREE.Mesh(carpetG, carpetMat);
      carpet.position.y = 0.06;
      carpet.layers.set(LAYER_NOREF);
      plaza.add(carpet);
      world.neonMats.push(carpetMat);
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
  const cor = terrain.corridor;
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
        if (sgn > 0) {
          /* Inner wall: only once the slot between the ramp's inner edge and
             the deck edge is wide enough to hold it. At sSep the two edges
             still touch, and a wall started there (as this used to) stood
             with its collider face inside the deck's own shoulder — a car
             hugging the outside lane line got kicked by it. The deck parapet
             (clipped to the gap window) takes over on the deck side. */
          const zc = cor.zAt(a.x, a.z);
          const clear = cor.edgeLat(zc, -1) - (cor.latAt(a.x, a.z) + a.hIn);
          if (clear < 0.75) continue;
        }
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
    /* Close the approach gap at the gore nose. The parapet-gap window opens a
       short lead on the far side of the nose from the mouth (see parapetGap),
       and the ramp's outer wall only begins AT the nose, ~0.7 m outboard of
       the parapet line — which left a hole in the barrier right where the two
       runs should hand over. One angled piece from the clipped parapet end to
       the outer wall's first post makes the run continuous; the mouth itself
       (the other side of the nose) stays open. */
    {
      const g = parapetGap(r);
      const zP = r.dir > 0 ? g.z0 : g.z1;
      // deck parapet centreline at its clipped end (0.34/0.06 match buildHighway)
      const latP = -(cor.halfWidth(zP) + 0.34 / 2 + 0.06);
      const wP = cor.worldOf(zP, latP);
      const p0 = pts[0];
      const nOff = WALL_T / 2 + 0.12; // the outer wall's centre offset at hOut = 0
      const nx0 = p0.x - p0.nx * nOff, nz0 = p0.z - p0.nz * nOff;
      const dx = nx0 - wP.x, dz = nz0 - wP.z;
      const dl = Math.hypot(dx, dz) || 1;
      const px = dz / dl, pz = -dx / dl; // horizontal perpendicular
      const face = (s: number) => {
        const a: Vec3 = [wP.x + px * s, wP.y, wP.z + pz * s];
        const b: Vec3 = [nx0 + px * s, p0.y, nz0 + pz * s];
        return [a, b] as const;
      };
      const [aL, bL] = face(-WALL_T / 2), [aR, bR] = face(WALL_T / 2);
      const top = (p: Vec3): Vec3 => [p[0], p[1] + WALL_H, p[2]];
      const bot = (p: Vec3): Vec3 => [p[0], p[1] - 0.25, p[2]];
      wallS.quad(bot(aL), bot(bL), top(bL), top(aL));
      wallS.quad(bot(aR), bot(bR), top(bR), top(aR));
      wallS.quad(top(aL), top(bL), top(bR), top(aR));
      /* Slim lateral pad: the deck end sits exactly on the parapet line, and a
         fatter box would stand proud of the analytic parapet clamp beside it,
         nudging cars that slide legally along the wall into the junction. */
      world.colliders.addObb({
        x: (wP.x + nx0) / 2, z: (wP.z + nz0) / 2,
        hw: WALL_T / 2 + 0.05, hd: dl / 2 + 0.1,
        cos: dz / dl, sin: dx / dl,
        y0: Math.min(wP.y, p0.y) - 1.2, y1: Math.max(wP.y, p0.y) + WALL_H + 1.2,
      });
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

/* ============================ bypass viaduct ============================ */

function buildBypassViaduct(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  kit: {
    add: (b: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }) => void;
    board: (z: number, w: number, h: number, tex: THREE.Texture) => THREE.Group | null;
    decal: (z: number, lat: number, w: number, l: number, mat: THREE.Material) => THREE.Mesh;
    word: (z: number, lat: number, mat: THREE.Material, chars: number) => THREE.Mesh;
    wordMat: (word: string) => THREE.Material;
    arrowMat: THREE.Material;
    goreMat: THREE.Material;
  }
) {
  const routes: RouteGraph = world.routes!;
  const cor = getCorridor();
  const by = routes.bypass;
  const st = by.stations;
  const { add, board, decal, word, wordMat, arrowMat, goreMat } = kit;
  const WALL_H = 1.05, WALL_T = 0.34, WALL_EVERY_B = 2, TILE = 7;
  const FULL = BYPASS.half - 0.02;

  /** station point at lateral `lat`, cross-fall (bank) folded into y */
  const bpt = (i: number, lat: number, dy = 0): Vec3 => {
    const p = st[i];
    return [p.x + p.nx * lat, p.y + lat * p.bank + dy, p.z + p.nz * lat];
  };
  const inCross = (z: number) =>
    routes.crossings.some((cr) => z > cr.z0 - 10 && z < cr.z1 + 10);

  /* ---- deck sweep: pavement, girder fascia, parapets, bridge railing ---- */
  const bSurf = new Soup(), bFas = new Soup(), bWall = new Soup(),
    bMark = new Soup(), bRail = new Soup();
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1];
    if (a.hwL + a.hwR < 0.5 && b.hwL + b.hwR < 0.5) continue;
    const la = bpt(i, -a.hwR), ra = bpt(i, a.hwL);
    const lb = bpt(i + 1, -b.hwR), rb = bpt(i + 1, b.hwL);
    bSurf.quadUv(
      la, lb, rb, ra,
      [0, a.s / TILE], [0, b.s / TILE],
      [(b.hwL + b.hwR) / TILE, b.s / TILE], [(a.hwL + a.hwR) / TILE, a.s / TILE]
    );
    /* the box girder: BYPASS.deckT (1.1 m) is the structural depth every
       clearance number in the graph assumes — nothing may hang below it */
    const lad = bpt(i, -a.hwR - 0.5, -BYPASS.deckT), rad = bpt(i, a.hwL + 0.5, -BYPASS.deckT);
    const lbd = bpt(i + 1, -b.hwR - 0.5, -BYPASS.deckT), rbd = bpt(i + 1, b.hwL + 0.5, -BYPASS.deckT);
    bFas.quad(la, lb, lbd, lad);
    bFas.quad(ra, rad, rbd, rb);
    bFas.quad(lad, lbd, rbd, rad);
    if (i % WALL_EVERY_B === 0 && i + WALL_EVERY_B < st.length) {
      const e = st[i + WALL_EVERY_B];
      for (const sgn of [-1, 1] as const) {
        const hwA = sgn > 0 ? a.hwL : a.hwR;
        const hwE = sgn > 0 ? e.hwL : e.hwR;
        /* Gore wedges: the deck's own edge continues there — no wall. Ask the
           stations, not the width. The old `hwA < FULL` test also swallowed
           the two gore NOSES, where the pavement tapers open from nothing over
           a 10 m drop: narrow, but a free edge, and the deck's parapet is cut
           away beside it. That was the visible hole in the barrier, and
           collide.ts's clamp was switched off over exactly the same stretch.

           Either end shared drops the whole segment, so a wall never pokes
           into a wedge; the clamp reads the midpoint instead and so goes live
           up to a segment earlier. That way round on purpose — a metre of
           invisible wall beats a metre of missing one. */
        if (sgn > 0 ? a.shL || e.shL : a.shR || e.shR) continue;
        if (inCross(a.z)) {
          /* the crossing span carries a steel three-band railing instead of
             the concrete parapet — the visual cue, from the main deck below
             as much as from up here, that this piece is a bridge */
          const a0 = bpt(i, sgn * (hwA + 0.1)), b0 = bpt(i + WALL_EVERY_B, sgn * (hwE + 0.1));
          for (const [y0, t] of [[0, 0.3], [0.6, 0.08], [1.0, 0.1]] as const) {
            bRail.quad(
              [a0[0], a0[1] + y0, a0[2]], [b0[0], b0[1] + y0, b0[2]],
              [b0[0], b0[1] + y0 + t, b0[2]], [a0[0], a0[1] + y0 + t, a0[2]]
            );
          }
          continue;
        }
        const lo = sgn * (hwA + WALL_T / 2 + 0.06), hi = sgn * (hwE + WALL_T / 2 + 0.06);
        const a0 = bpt(i, lo - (sgn * WALL_T) / 2), a1 = bpt(i, lo + (sgn * WALL_T) / 2);
        const b0 = bpt(i + WALL_EVERY_B, hi - (sgn * WALL_T) / 2);
        const b1 = bpt(i + WALL_EVERY_B, hi + (sgn * WALL_T) / 2);
        const up = (p: Vec3): Vec3 => [p[0], p[1] + WALL_H, p[2]];
        const dn = (p: Vec3): Vec3 => [p[0], p[1] - 0.3, p[2]];
        bWall.quad(dn(a0), dn(b0), up(b0), up(a0));
        bWall.quad(dn(a1), dn(b1), up(b1), up(a1));
        bWall.quad(up(a0), up(b0), up(b1), up(a1));
      }
    }
  }

  /* ---- markings: centre dash on the 16 m lattice, edge lines ---- */
  // v tiled by arclength for markMat's wear map, as the main deck's stripe()
  // does; the bypass never wraps, so plain s is safe here
  const bstripe = (s0: number, s1: number, lat0: number, lat1: number, wd: number) => {
    const p0 = by.worldOf(s0, lat0 - wd / 2), p1 = by.worldOf(s0, lat0 + wd / 2);
    const p2 = by.worldOf(s1, lat1 + wd / 2), p3 = by.worldOf(s1, lat1 - wd / 2);
    const Y = 0.022;
    const v0 = s0 / 12.5, v1 = s1 / 12.5;
    bMark.quadUv(
      [p0.x, p0.y + Y, p0.z], [p3.x, p3.y + Y, p3.z],
      [p2.x, p2.y + Y, p2.z], [p1.x, p1.y + Y, p1.z],
      [0, v0], [0, v1], [1, v1], [1, v0]
    );
  };
  for (const s of by.sLattice(16)) {
    if (s + 6 > by.len) continue;
    bstripe(s, s + 6, by.laneEdge(1, s), by.laneEdge(1, s + 6), 0.16);
  }
  for (const s of by.sLattice(8)) {
    if (s + 8 > by.len) continue;
    const h0 = by.halfWidths(s), h1 = by.halfWidths(s + 8);
    for (const sgn of [1, -1] as const) {
      const e0 = sgn > 0 ? h0.hwL : h0.hwR, e1 = sgn > 0 ? h1.hwL : h1.hwR;
      if (e0 < FULL || e1 < FULL) continue;
      bstripe(s, s + 8, sgn * (e0 - 0.45), sgn * (e1 - 0.45), 0.2);
    }
  }

  const railMat = new THREE.MeshStandardMaterial({
    color: 0x4a5262, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide,
  });
  for (const [S2, m, uv, shadow, noRef] of [
    [bSurf, mats.hwy, true, false, true],
    [bFas, mats.concDouble, false, true, false],
    [bWall, mats.barrierDouble, false, true, false],
    [bRail, railMat, false, false, false],
    [bMark, mats.markMat, true, false, true],
  ] as const) {
    if (S2.empty) continue;
    const mesh = new THREE.Mesh(S2.geom(uv), m as THREE.Material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    if (noRef) mesh.layers.set(LAYER_NOREF);
    scene.add(mesh);
  }

  /* ---- piers + caps, instanced, with colliders on the frontage strip ---- */
  {
    const { piers } = routes.piers(terrain.h);
    if (piers.length) {
      const pierM = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1.5, 1, 1.5), mats.concDark, piers.length);
      const capM = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 0.65, 2.0), mats.concDark, piers.length);
      const M = new THREE.Matrix4(), V = new THREE.Vector3(),
        Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3();
      piers.forEach((p, i) => {
        const gy = terrain.h(p.x, p.z);
        const hgt = Math.max(1.5, p.topY - gy);
        E.set(0, by.poseAt(p.s).h, 0);
        Q.setFromEuler(E);
        V.set(p.x, gy + hgt / 2, p.z);
        S.set(1, hgt, 1);
        M.compose(V, Q, S);
        pierM.setMatrixAt(i, M);
        V.set(p.x, p.topY - 0.32, p.z);
        S.set(BYPASS.half * 2 + 1.0, 1, 1);
        M.compose(V, Q, S);
        capM.setMatrixAt(i, M);
        add({
          x0: p.x - 1.0, x1: p.x + 1.0, z0: p.z - 1.0, z1: p.z + 1.0,
          y0: gy, y1: p.topY - 0.6,
        });
      });
      pierM.castShadow = true;
      pierM.computeBoundingSphere();
      capM.computeBoundingSphere();
      scene.add(pierM, capM);
    }
  }

  /* ---- gore treatment: HUD exit, paint, beacons, noses, signs ---- */
  world.exits.push({ z: DIVERGE_Z, no: 3, name: "湾岸 Bypass" });

  // painted chevrons + amber beacons at both noses — the ramps' own kit
  const gore = (z: number, lat: number, flipRot: boolean) => {
    const gp = cor.worldOf(z + (flipRot ? -4 : 4), lat);
    const m = new THREE.Mesh(flatQuad(3.2, 6.4), goreMat);
    m.rotation.y = cor.pose(z).h + (flipRot ? Math.PI : 0);
    m.position.set(gp.x, gp.y + 0.03, gp.z);
    m.layers.set(LAYER_NOREF);
    scene.add(m);
    const bp = cor.worldOf(z, Math.sign(lat) * (cor.halfWidth(z) - 0.5));
    const bea = new THREE.Sprite(world.goreBeaconMat!);
    bea.scale.set(1.9, 1.9, 1);
    bea.position.set(bp.x, bp.y + 1.9, bp.z);
    scene.add(bea);
  };
  const latD = -(cor.halfWidth(DIVERGE_Z) - 1.9);
  gore(DIVERGE_Z, latD, false);
  gore(MERGE_Z, cor.halfWidth(MERGE_Z) - 1.9, true);

  // kerb-lane guidance on the approach: three arrows + 分岐 road text
  for (let k = 0; k < 3; k++) decal(DIVERGE_Z - 34 - k * 26, latD + 0.5, 1.6, 3.4, arrowMat);
  word(DIVERGE_Z - 122, latD + 0.5, wordMat("分岐"), 2);

  /* wedge-tip noses: where the parapets begin, a chevron board over a low
     concrete block (collider included — the nose is never a ghost) */
  const nose = (x: number, y: number, z: number, h: number) => {
    const blk = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 1.3), mats.concDark);
    blk.position.set(x, y + 0.4, z);
    blk.rotation.y = h;
    blk.castShadow = true;
    scene.add(blk);
    const bd = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9),
      new THREE.MeshBasicMaterial({ map: mats.chevTex }));
    bd.position.set(x, y + 1.35, z);
    bd.rotation.y = h + Math.PI; // face the oncoming stream
    scene.add(bd);
    add({ x0: x - 0.6, x1: x + 0.6, z0: z - 0.8, z1: z + 0.8, y0: y - 0.5, y1: y + 1.1 });
  };
  {
    // diverge: first station where the deck-side (+lat) width is fully open
    const iDiv = st.findIndex((p) => p.hwL >= FULL && p.s > 8);
    if (iDiv > 0) {
      const tp = bpt(iDiv, st[iDiv].hwL + 0.55);
      nose(tp[0], tp[1], tp[2], by.poseAt(st[iDiv].s).h);
    }
    // merge: the deck's east parapet ends at the gap — cap it the same way
    const mrgGap = routes.newParapetGaps().find((g) => g.side > 0);
    if (mrgGap) {
      const w = cor.worldOf(mrgGap.z0 - 1, cor.halfWidth(mrgGap.z0 - 1) + 0.23);
      nose(w.x, w.y, w.z, cor.pose(mrgGap.z0 - 1).h);
    }
  }

  /* cantilever boards: exit-count run for the diverge, and a merge warning
     ahead of the gore. The doc suggested MERGE_Z − 150 ≈ 1430, but that mast
     would stand under the toll canopy (and its 1240 fallback is still inside
     the tunnel, z1 = 1260) — 80 m of notice from z = 1500 clears both. */
  for (const d of BYPASS_BOARD_D)
    board(DIVERGE_Z - d, 9.4, 2.8, guideSignTexF(3, "湾岸", "Bypass", distLabel(d)));
  board(DIVERGE_Z - 40, 7.4, 2.8, guideSignTexF(3, "湾岸", "Bypass", "", { only: true }));
  board(MERGE_Z - 80, 6.6, 2.5, mergeSignTexF("80 m"));
}

/* ============================ mountain road ============================= */

/** The mountain exit's cantilever boards, at canonical (wrapped) z — the
    approach to the diverge runs through the seam, so "400 m before the gore"
    lands back at the top of the band. Shared with buildHighway's mastGaps so
    the soundwall lattice steps around the masts. The 10 m nudges keep each
    mast off the SOS-cabinet lattice (pitch 200, phase 30 ⇒ cabinets at 1630
    and 1830, exactly where divergeZ − 400/200 would land). */
function MTN_BOARD_Z(): number[] {
  const L = LOOP_LEN;
  const w = (z: number) => (z < -L / 2 ? z + L : z);
  return [
    w(MTN.divergeZ - 390), // "400 m" board
    w(MTN.divergeZ - 190), // "200 m" board
    w(MTN.divergeZ - 24), // gore board
    w(MTN.divergeZ - 96), // "one way" warning for the exit
    MTN.mergeZ - 90, // merge warning, mid-band already
  ];
}

function buildMountainRoad(
  scene: THREE.Scene,
  mats: Mats,
  world: WorldData,
  terrain: Terrain,
  kit: {
    add: (b: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }) => void;
    board: (z: number, w: number, h: number, tex: THREE.Texture) => THREE.Group | null;
    decal: (z: number, lat: number, w: number, l: number, mat: THREE.Material) => THREE.Mesh;
    word: (z: number, lat: number, mat: THREE.Material, chars: number) => THREE.Mesh;
    wordMat: (word: string) => THREE.Material;
    arrowMat: THREE.Material;
    goreMat: THREE.Material;
  }
) {
  const routes: RouteGraph = world.routes!;
  const cor = getCorridor();
  const mt = routes.mtn;
  const st = mt.stations;
  const { add, board, decal, word, wordMat, arrowMat, goreMat } = kit;
  const caps = worldTierCaps();
  const detail = caps.mtnDetail ?? 1;
  /* Forked rng stream, seeded from the road seed: the rock jitter must not
     consume from the world build's shared stream (which would re-roll every
     later draw for a given seed), and it must be identical for the canonical
     road and its splice copy — so it is rolled ONCE into tables first. */
  const rk = mulberry32((roadSeed() ^ 0x70b6e5) >>> 0);
  const N = st.length;
  /** per-station rock jitter, [latJit, yJit, latJit2, yJit2] */
  const jag = new Float32Array(N * 4);
  for (let i = 0; i < N * 4; i++) jag[i] = rk();

  const WALL_T = 0.3, WALL_H = 0.85, TILE = 7;
  const FULL = MTN.half - 0.02;
  /** rock height envelope: nothing towering at the gores, full mid-route */
  const rockK = (s: number) =>
    sstep((s - 18) / 50) * sstep((mt.len - 22 - s) / 50);
  /** rock-face sampling step, stations (1 m apart on this edge) */
  const step = detail >= 0.95 ? 3 : detail >= 0.65 ? 4 : 6;

  /* the three tightest corners, for chevron boards: local curvature maxima
     at least 60 m apart, tightest first */
  const corners: number[] = [];
  {
    const cand: { s: number; k: number; sgn: number }[] = [];
    for (let i = 6; i < N - 6; i += 3) {
      const a = st[i - 3], b = st[i + 3];
      let dh = Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz);
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      const k = dh / Math.max(0.01, b.s - a.s);
      cand.push({ s: st[i].s, k: Math.abs(k), sgn: Math.sign(k) });
    }
    cand.sort((a, b) => b.k - a.k);
    for (const c of cand) {
      if (corners.length >= 3) break;
      if (c.s < 40 || c.s > mt.len - 45) continue;
      if (corners.some((s) => Math.abs(s - c.s) < 60)) continue;
      corners.push(c.s);
    }
  }

  const lampPts: number[] = []; // [x, y, z, r, g, b]
  const lampCol = new THREE.Color();
  const lamp = (x: number, y: number, z: number, hex: number, bright: number) => {
    lampCol.set(hex).multiplyScalar(bright);
    lampPts.push(x, y, z, lampCol.r, lampCol.g, lampCol.b);
  };

  /* Rock: its own dark, rough material — vertex colour carries the per-facet
     variation so the whole hillside is still one draw call per copy.

     DoubleSide, deliberately. The winding of every face below is now correct
     (see the cut-face note in the sweep), so FrontSide would draw the right
     thing from the road — but this hillside is an open SHELL, not a solid,
     and the cameras that ship do get behind its skin: CHASE swings out over
     the river drop and looks back through the east bank faces, and at the
     crest it can rise past the cut face's top edge. A shell you can see
     through from a shipped camera is the bug this lane was opened for, so
     the cheap structural guarantee is worth one hillside's worth of
     backface culling. three.js flips the normal for backfacing fragments,
     so the shading stays right on both sides. */
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x35322e, roughness: 1.0, vertexColors: true, side: THREE.DoubleSide,
  });
  const mtnRailMat = new THREE.MeshStandardMaterial({
    color: 0x4a5262, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide,
  });

  const delinPosts: { x: number; y: number; z: number; h: number }[] = [];
  const delinPts: number[] = [];

  /* The pass's one-off furniture — chevron posts/boards, the four waypoint
     lamps, the gore quads and nose blocks — used to be added as individual
     meshes per splice copy, and the boards each allocated their own material:
     ~46 draw calls and 16 single-use materials across the two copies for a
     couple dozen small shapes (perf-pass measurement). Collected here and
     materialised after the sweep as one InstancedMesh per shape, the idiom
     the overpasses and delineators already use. */
  type Placed = { x: number; y: number; z: number; h?: number; sx?: number; sy?: number };
  const chevPosts: Placed[] = [], lampPoles: Placed[] = [], lampHeads: Placed[] = [],
    noseBlks: Placed[] = [], goreQuads: Placed[] = [];
  const chevBoards: (Placed & { tint: number })[] = [];

  /* ---- the sweep, once per splice copy. Separate meshes per copy (rather
     than one Soup spanning both) so each copy keeps its own bounding sphere
     and frustum culling works: a single mesh would span 4 km and never cull. */
  for (const dz of [0, cor.LOOP]) {
    const pav = new Soup(), rock = new Soup(), wall = new Soup(), mark = new Soup(),
      rail = new Soup();
    const rockColored: { col: number[] } = { col: [] };

    /** station point at lateral `lat` (bank folded in), plus dy, shifted dz */
    const mpt = (i: number, lat: number, dy = 0): Vec3 => {
      const p = st[i];
      return [p.x + p.nx * lat, p.y + lat * p.bank + dy, p.z + p.nz * lat + dz];
    };
    /** absolute-height variant, for faces that reach the ground */
    const apt = (i: number, lat: number, yAbs: number): Vec3 => {
      const p = st[i];
      return [p.x + p.nx * lat, yAbs, p.z + p.nz * lat + dz];
    };
    /** rock quad with a per-facet gray pushed into the colour attribute */
    const rquad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, shade: number) => {
      rock.quad(a, b, c, d);
      for (let k = 0; k < 6; k++) rockColored.col.push(shade, shade * 0.97, shade * 0.9);
    };

    for (let i = 0; i < N - 1; i++) {
      const a = st[i], b = st[i + 1];
      if (a.hwL + a.hwR < 0.5 && b.hwL + b.hwR < 0.5) continue;
      // pavement
      pav.quadUv(
        mpt(i, -a.hwR), mpt(i + 1, -b.hwR), mpt(i + 1, b.hwL), mpt(i, a.hwL),
        [0, a.s / TILE], [0, b.s / TILE],
        [(b.hwL + b.hwR) / TILE, b.s / TILE], [(a.hwL + a.hwR) / TILE, a.s / TILE]
      );
    }

    /* rock faces, coarser than the pavement */
    for (let i = 0; i + step < N; i += step) {
      const a = st[i], e = st[i + step];
      const sh = mt.sharedSides((a.s + e.s) / 2);
      const K = rockK(a.s), K2 = rockK(e.s);
      const j = (ix: number, k: number) => jag[(ix % N) * 4 + k];
      if (!sh.shR && K > 0.02) {
        /* west: the cut face the road hugs, rising to a crest, then the
           hill's own flank falling to the bank behind it. The face leans
           BACK as it rises (a real cut face batters away from the road).

           WINDING — this is the see-through bug (owner, 2026-09-04: "there's
           no mountain once you drive on the mountain road, but on the highway
           side you actually see the mountain"). All three bands of this face
           used to be emitted station-first (a, b, upper-b, upper-a), which
           winds them so the generated normal points AWAY from the pavement
           and downward: on a FrontSide material every one of them was a
           back-face from the driver's seat, so the massif simply was not
           drawn from the road. The back flank below — the one facet that
           faces the EXPRESSWAY — happened to be written the other way round
           and was therefore the only piece that ever rendered, which is
           exactly why the hill read fine from the deck and vanished on the
           pass. The bands are now emitted lateral-first (a, upper-a,
           upper-b, b), the same sense as the pavement quad, so their normals
           face the road. Checked numerically, not by eye: 0 of 282 bands
           faced the driver before, all of them do now. */
        const f0a = mpt(i, -(a.hwR + 0.22), -0.35);
        const f0b = mpt(i + step, -(e.hwR + 0.22), -0.35);
        const f1a = mpt(i, -(a.hwR + 0.9 + j(i, 0) * 0.9), (1.7 + j(i, 1) * 0.8) * K);
        const f1b = mpt(i + step, -(e.hwR + 0.9 + j(i + step, 0) * 0.9), (1.7 + j(i + step, 1) * 0.8) * K2);
        const f2a = mpt(i, -(a.hwR + 2.4 + j(i, 2) * 1.4), (3.9 + j(i, 3) * 1.2) * K);
        const f2b = mpt(i + step, -(e.hwR + 2.4 + j(i + step, 2) * 1.4), (3.9 + j(i + step, 3) * 1.2) * K2);
        const c3a = mpt(i, -(a.hwR + 4.6 + j(i, 1) * 1.6), (5.0 + j(i, 0) * 1.4) * K);
        const c3b = mpt(i + step, -(e.hwR + 4.6 + j(i + step, 1) * 1.6), (5.0 + j(i + step, 0) * 1.4) * K2);
        const g4a = apt(i, -(a.hwR + 12), 0.02);
        const g4b = apt(i + step, -(e.hwR + 12), 0.02);
        rquad(f0a, f1a, f1b, f0b, 0.95 + j(i, 3) * 0.25);
        rquad(f1a, f2a, f2b, f1b, 0.8 + j(i, 2) * 0.3);
        rquad(f2a, c3a, c3b, f2b, 0.7 + j(i, 1) * 0.3);
        // the back flank, seen from the expressway: crest straight down to
        // the flat bank, one dark facet
        rquad(c3b, c3a, g4a, g4b, 0.5 + j(i, 0) * 0.2);
      }
      if (!sh.shL && a.hwL > 0.55 && e.hwL > 0.55) {
        /* east: the drop to the river bank the road is cut over */
        const c0a = mpt(i, a.hwL + 0.12, -0.08);
        const c0b = mpt(i + step, e.hwL + 0.12, -0.08);
        const midYa = Math.max(0.4, st[i].y * (0.42 + j(i, 2) * 0.2));
        const midYb = Math.max(0.4, st[i + step].y * (0.42 + j(i + step, 2) * 0.2));
        const c1a = apt(i, a.hwL + 1.5 + j(i, 0), midYa);
        const c1b = apt(i + step, e.hwL + 1.5 + j(i + step, 0), midYb);
        const c2a = apt(i, a.hwL + 3.6 + j(i, 1) * 1.5, 0.03);
        const c2b = apt(i + step, e.hwL + 3.6 + j(i + step, 1) * 1.5, 0.03);
        rquad(c0a, c1a, c1b, c0b, 0.75 + j(i, 3) * 0.25);
        rquad(c1a, c2a, c2b, c1b, 0.55 + j(i, 2) * 0.25);
      }
    }

    /* the river-side stone parapet, on free hwL edges outside the noses —
       and the same wall on the ROCK side through both gore throats, where
       the edge clamp is already armed (collide.ts walls every free edge) but
       the cut face has barely begun to rise (rockK ramps in over 50 m): a
       car cutting the exit early met a hard edge with nothing visible on
       it. The parapet gives that edge a body, and hands over to the rock
       once the face is tall enough to read on its own. */
    const up = (p: Vec3): Vec3 => [p[0], p[1] + WALL_H, p[2]];
    const dn = (p: Vec3): Vec3 => [p[0], p[1] - 0.3, p[2]];
    for (let i = 0; i + 2 < N; i += 2) {
      const a = st[i], e = st[i + 2];
      const sh = mt.sharedSides((a.s + e.s) / 2);
      if (!sh.shL && a.hwL >= 0.55 && e.hwL >= 0.55) {
        const lo = a.hwL + WALL_T / 2 + 0.06, hi = e.hwL + WALL_T / 2 + 0.06;
        const a0 = mpt(i, lo - WALL_T / 2), a1 = mpt(i, lo + WALL_T / 2);
        const b0 = mpt(i + 2, hi - WALL_T / 2), b1 = mpt(i + 2, hi + WALL_T / 2);
        wall.quad(dn(a0), dn(b0), up(b0), up(a0));
        wall.quad(dn(a1), dn(b1), up(b1), up(a1));
        wall.quad(up(a0), up(b0), up(b1), up(a1));
      }
      if (!sh.shR && a.hwR >= 0.55 && e.hwR >= 0.55 && rockK((a.s + e.s) / 2) < 0.7) {
        const lo = -(a.hwR + WALL_T / 2 + 0.06), hi = -(e.hwR + WALL_T / 2 + 0.06);
        const a0 = mpt(i, lo + WALL_T / 2), a1 = mpt(i, lo - WALL_T / 2);
        const b0 = mpt(i + 2, hi + WALL_T / 2), b1 = mpt(i + 2, hi - WALL_T / 2);
        wall.quad(dn(a0), dn(b0), up(b0), up(a0));
        wall.quad(dn(a1), dn(b1), up(b1), up(a1));
        wall.quad(up(a0), up(b0), up(b1), up(a1));
      }
    }

    /* The gore runoff aprons (routegraph.mtnAprons): the paved pocket the
       deck's widened east clamp encloses, swept in the DECK's frame, plus a
       three-band steel rail along the outer edge wherever that edge is a
       real barrier — i.e. wherever the mountain road's own pavement is NOT
       directly adjacent (through the mouth the "edge" is just the seam
       between apron and road, and a rail there would fence the exit shut).
       The rail is the visible body of the analytic wall in collide.ts: same
       table, so they cannot drift apart. */
    {
      const RAIL_B: readonly (readonly [number, number])[] = [
        [0.16, 0.1], [0.44, 0.09], [0.72, 0.11],
      ];
      for (const ap of routes.mtnAprons) {
        for (let k = 0; k + 1 < ap.w.length; k++) {
          const w0 = ap.w[k], w1 = ap.w[k + 1];
          if (w0 <= 0.03 && w1 <= 0.03) continue;
          const zA = ap.z0 + k * ap.step, zB = zA + ap.step;
          const hwA = cor.halfWidth(zA), hwB = cor.halfWidth(zB);
          const pA0 = cor.worldOf(zA, hwA - 0.3), pA1 = cor.worldOf(zA, hwA + w0);
          const pB0 = cor.worldOf(zB, hwB - 0.3), pB1 = cor.worldOf(zB, hwB + w1);
          pav.quadUv(
            [pA0.x, pA0.y + 0.012, pA0.z + dz], [pB0.x, pB0.y + 0.012, pB0.z + dz],
            [pB1.x, pB1.y + 0.012, pB1.z + dz], [pA1.x, pA1.y + 0.012, pA1.z + dz],
            [0, zA / TILE], [0, zB / TILE],
            [(w1 + 0.3) / TILE, zB / TILE], [(w0 + 0.3) / TILE, zA / TILE]
          );
          // rail only where the outer edge is not the road seam
          const hitA = mt.project(pA1.x, pA1.z, 8);
          const adjA = hitA && (() => {
            const h = mt.halfWidths(hitA.s);
            return hitA.lat < h.hwL + 1 && hitA.lat > -(h.hwR + 1);
          })();
          if (adjA || w0 <= 0.03 || w1 <= 0.03) continue;
          for (const [y0, t] of RAIL_B) {
            rail.quad(
              [pA1.x, pA1.y + y0, pA1.z + dz], [pB1.x, pB1.y + y0, pB1.z + dz],
              [pB1.x, pB1.y + y0 + t, pB1.z + dz], [pA1.x, pA1.y + y0 + t, pA1.z + dz]
            );
          }
        }
      }
    }

    /* Markings. There is NO centre line: this is one lane running one way,
       and a double yellow down the middle of it would be a lie about the
       road (it was the two-way tell, and it went with the second lane).
       What a one-way single lane needs instead is a direction it cannot be
       mistaken about, so the paint is white edge lines either side — the
       turnout inherits its own outline from them — plus periodic pavement
       ARROWS in the running direction, in the same beam-lit paint the deck's
       lane arrows use. */
    const mstripe = (
      into: Soup, s0: number, s1: number, lat0: number, lat1: number, wd: number
    ) => {
      const p0 = mt.worldOf(s0, lat0 - wd / 2), p1 = mt.worldOf(s0, lat0 + wd / 2);
      const p2 = mt.worldOf(s1, lat1 + wd / 2), p3 = mt.worldOf(s1, lat1 - wd / 2);
      const Y = 0.022;
      const v0 = s0 / 12.5, v1 = s1 / 12.5;
      into.quadUv(
        [p0.x, p0.y + Y, p0.z + dz], [p3.x, p3.y + Y, p3.z + dz],
        [p2.x, p2.y + Y, p2.z + dz], [p1.x, p1.y + Y, p1.z + dz],
        [0, v0], [0, v1], [1, v1], [1, v0]
      );
    };
    const arw = new Soup();
    {
      /* one arrow every ~58 m, clear of both gore throats and of the turnout
         mouth (where the pavement is doing something else) */
      const AL = 4.6, AW = 1.9, Y = 0.024;
      for (const s of mt.sLattice(58, 34)) {
        if (s < 26 || s > mt.len - 34) continue;
        if (s > MTN.turnoutS0 - 8 && s < MTN.turnoutS1 + 8) continue;
        const p0 = mt.worldOf(s - AL / 2, -AW / 2), p1 = mt.worldOf(s + AL / 2, -AW / 2);
        const p2 = mt.worldOf(s + AL / 2, AW / 2), p3 = mt.worldOf(s - AL / 2, AW / 2);
        arw.quadUv(
          [p0.x, p0.y + Y, p0.z + dz], [p1.x, p1.y + Y, p1.z + dz],
          [p2.x, p2.y + Y, p2.z + dz], [p3.x, p3.y + Y, p3.z + dz],
          [0, 0], [0, 1], [1, 1], [1, 0]
        );
      }
    }
    for (const s of mt.sLattice(8)) {
      if (s + 8 > mt.len) continue;
      const h0 = mt.halfWidths(s), h1 = mt.halfWidths(s + 8);
      for (const sgn of [1, -1] as const) {
        const e0 = sgn > 0 ? h0.hwL : h0.hwR, e1 = sgn > 0 ? h1.hwL : h1.hwR;
        if (e0 < FULL || e1 < FULL) continue;
        mstripe(mark, s, s + 8, sgn * (e0 - 0.38), sgn * (e1 - 0.38), 0.15);
      }
    }

    for (const [S2, m, uv, shadow] of [
      [pav, mats.ramp, true, false],
      [wall, mats.barrierDouble, false, true],
      [rail, mtnRailMat, false, false],
      [mark, mats.markMat, true, false],
      [arw, arrowMat, true, false],
    ] as const) {
      if (S2.empty) continue;
      const mesh = new THREE.Mesh(S2.geom(uv), m as THREE.Material);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      if (!shadow) mesh.layers.set(LAYER_NOREF);
      scene.add(mesh);
    }
    if (!rock.empty) {
      const g = rock.geom(false);
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(rockColored.col), 3));
      const mesh = new THREE.Mesh(g, rockMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }

    /* delineators down the river edge — retroreflective, not lit: the posts
       are unlit geometry and the heads are studTex points that only come up
       in the player's beams (addBeam), which is what a real delineator does */
    for (const s of mt.sLattice(Math.round(13 / Math.max(0.4, detail)), 8)) {
      if (s > mt.len - 10) continue;
      const { hwL } = mt.halfWidths(s);
      const sh = mt.sharedSides(s);
      if (sh.shL || hwL < FULL) continue;
      const w = mt.worldOf(s, hwL + 0.55);
      delinPosts.push({ x: w.x, y: w.y, z: w.z + dz, h: mt.poseAt(s).h });
      delinPts.push(w.x, w.y + 1.02, w.z + dz);
    }

    /* chevron boards on the outside of the three tightest corners. ONE board
       each now, facing the single stream — the pair was back-to-back so the
       oncoming lane could read one too, and there is no oncoming lane.
       Dimmed well below the texture's
       full level — an unlit basic material at night is effectively emissive,
       and at full brightness the board read as a floodlit sign filling the
       windshield (realistic-light: a bright thing must still be under the
       blowout ceiling) — and mounted on a real post, not floating. */
    for (const cs of corners) {
      const p = mt.poseAt(cs);
      // outside of the corner: opposite the smoothed turn direction
      const i0 = Math.max(3, Math.min(N - 4, Math.round(cs)));
      const aT = st[i0 - 3], bT = st[i0 + 3];
      let dh = Math.atan2(bT.tx, bT.tz) - Math.atan2(aT.tx, aT.tz);
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      const out = dh > 0 ? -1 : 1; // turning toward +lat ⇒ outside is −lat
      const { hwL, hwR } = mt.halfWidths(cs);
      const latB = out > 0 ? hwL + 1.1 : -(hwR + 0.95);
      const w = mt.worldOf(cs, latB);
      chevPosts.push({ x: w.x, y: w.y + 0.55, z: w.z + dz });
      chevBoards.push({
        x: w.x, y: w.y + 1.5, z: w.z + dz, h: p.h + Math.PI,
        sx: 1.15, sy: 0.72, tint: 0x6f6f6f,
      });
    }

    /* sparse, warm lamps: one at each gore mouth, one over each of the two
       far corners — a pass is DARK, that is its identity; these four glows
       are waypoints, not street lighting. Fog-faded points with brightness
       baked ≤ 0.55 into the colour (realistic-light: fade, never stop). */
    const lampSs = [
      14,
      mt.len - 16,
      /* the turnout: the one place on the pass a car stops, and the place a
         player who turned round comes about — it has to read as a place at
         night, not as a wider patch of black */
      (MTN.turnoutS0 + MTN.turnoutS1) / 2,
      ...corners.slice(0, 2),
    ];
    for (const ls of lampSs) {
      if (ls < 0 || ls > mt.len) continue;
      const { hwR } = mt.halfWidths(ls);
      const w = mt.worldOf(ls, -(hwR + 0.55));
      lamp(w.x, w.y + 5.6, w.z + dz, 0xffab55, 0.55);
      const p = mt.poseAt(ls);
      lampPoles.push({ x: w.x, y: w.y + 2.85, z: w.z + dz });
      lampHeads.push({ x: w.x, y: w.y + 5.62, z: w.z + dz, h: p.h });
    }

    /* gore treatment on the deck: chevron paint + amber beacon at both noses
       (the ramps'/bypass's own kit), in both copies so the pre-seam view
       carries the full exit picture */
    const gore = (z: number, lat: number, flipRot: boolean) => {
      const gp = cor.worldOf(z + (flipRot ? -4 : 4), lat);
      goreQuads.push({
        x: gp.x, y: gp.y + 0.03, z: gp.z + dz,
        h: cor.pose(z).h + (flipRot ? Math.PI : 0),
      });
      const bp = cor.worldOf(z, Math.sign(lat) * (cor.halfWidth(z) - 0.5));
      const bea = new THREE.Sprite(world.goreBeaconMat!);
      bea.scale.set(1.9, 1.9, 1);
      bea.position.set(bp.x, bp.y + 1.9, bp.z + dz);
      scene.add(bea);
    };
    const latD = cor.halfWidth(MTN.divergeZ) - 1.9;
    gore(MTN.divergeZ, latD, false);
    gore(MTN.mergeZ, cor.halfWidth(MTN.mergeZ) - 1.9, true);

    /* wedge-tip noses: chevron board over a low block. Diverge: at the first
       station whose deck side has fully separated. Merge: cap the deck's east
       parapet where its gap opens. Colliders canonical-copy only. */
    const nose = (x: number, y: number, z: number, h: number) => {
      noseBlks.push({ x, y: y + 0.4, z: z + dz, h });
      chevBoards.push({
        x, y: y + 1.35, z: z + dz, h: h + Math.PI, sx: 1.4, sy: 0.9, tint: 0xffffff,
      });
      if (dz === 0)
        add({ x0: x - 0.6, x1: x + 0.6, z0: z - 0.8, z1: z + 0.8, y0: y - 0.5, y1: y + 1.1 });
    };
    {
      const iDiv = st.findIndex((p) => p.hwR >= FULL && p.s > 8);
      if (iDiv > 0) {
        const tp = mpt(iDiv, -(st[iDiv].hwR + 0.55));
        nose(tp[0], tp[1], tp[2] - dz, mt.poseAt(st[iDiv].s).h);
      }
      const mtnGaps = routes.newParapetGaps().slice(2);
      const mrgGap = mtnGaps[1];
      if (mrgGap) {
        const w = cor.worldOf(mrgGap.z0 - 1, cor.halfWidth(mrgGap.z0 - 1) + 0.23);
        nose(w.x, w.y, w.z, cor.pose(mrgGap.z0 - 1).h);
      }
    }
  }

  /* ---- materialise the furniture collectors: one draw call per shape,
     both splice copies together (each list spans ~2 km + LOOP, but every
     shape is a handful of instances, so the lost cull is a rounding error
     next to the ~40 draws saved) ---- */
  {
    const M = new THREE.Matrix4(), V = new THREE.Vector3(),
      Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3();
    const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, list: Placed[]) => {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((p, i) => {
        E.set(0, p.h ?? 0, 0);
        Q.setFromEuler(E);
        V.set(p.x, p.y, p.z);
        S.set(p.sx ?? 1, p.sy ?? 1, 1);
        M.compose(V, Q, S);
        m.setMatrixAt(i, M);
      });
      m.computeBoundingSphere();
      scene.add(m);
      return m;
    };
    if (chevPosts.length)
      instanced(new THREE.CylinderGeometry(0.05, 0.06, 1.1, 5), mats.concDark, chevPosts);
    if (lampPoles.length)
      instanced(new THREE.CylinderGeometry(0.07, 0.1, 5.7, 6), mats.concDark, lampPoles);
    if (lampHeads.length)
      instanced(new THREE.BoxGeometry(0.5, 0.16, 0.28), mats.concDark, lampHeads);
    if (noseBlks.length)
      instanced(new THREE.BoxGeometry(0.7, 0.8, 1.3), mats.concDark, noseBlks).castShadow = true;
    if (goreQuads.length)
      instanced(flatQuad(3.2, 6.4), goreMat, goreQuads).layers.set(LAYER_NOREF);
    if (chevBoards.length) {
      /* unit plane scaled per instance — the corner boards (1.15×0.72, dimmed
         to 0x6f6f6f, see the realistic-light note above) and the nose boards
         (1.4×0.9, full) share the one material via per-instance colour */
      const bd = instanced(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: mats.chevTex, fog: true }),
        chevBoards
      );
      const c = new THREE.Color();
      chevBoards.forEach((b, i) => bd.setColorAt(i, c.set(b.tint)));
    }
  }

  /* instanced delineator posts (both copies in one mesh: ~60 slim cylinders) */
  if (delinPosts.length) {
    const postM = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.045, 0.05, 1.04, 5),
      new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.7 }),
      delinPosts.length
    );
    const M = new THREE.Matrix4(), V = new THREE.Vector3(),
      Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3(1, 1, 1);
    delinPosts.forEach((p, i) => {
      E.set(0, p.h, 0);
      Q.setFromEuler(E);
      V.set(p.x, p.y + 0.52, p.z);
      M.compose(V, Q, S);
      postM.setMatrixAt(i, M);
    });
    postM.computeBoundingSphere();
    scene.add(postM);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(delinPts), 3));
    const rm = new THREE.PointsMaterial({
      size: 2.0, sizeAttenuation: false, color: 0xffb055, map: mats.studTex,
      transparent: true, opacity: 0.85, fog: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mats.addBeam(rm, { near: 40, far: 190, spread: 0.5 });
    const rp = new THREE.Points(rg, rm);
    rp.frustumCulled = false;
    scene.add(rp);
  }

  /* the lamp glows: one fog-faded additive cloud, day/night driven */
  if (lampPts.length) {
    const n = lampPts.length / 6;
    const p = new Float32Array(n * 3), c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      p[i * 3] = lampPts[i * 6];
      p[i * 3 + 1] = lampPts[i * 6 + 1];
      p[i * 3 + 2] = lampPts[i * 6 + 2];
      c[i * 3] = lampPts[i * 6 + 3];
      c[i * 3 + 1] = lampPts[i * 6 + 4];
      c[i * 3 + 2] = lampPts[i * 6 + 5];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    const pm = new THREE.PointsMaterial({
      size: 4.2, sizeAttenuation: false, map: mats.glowTex, vertexColors: true,
      transparent: true, opacity: 1, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    world.neonMats.push(pm);
    scene.add(new THREE.Points(g, pm));
  }

  /* ---- HUD exit + deck-side guidance (canonical band only) ---- */
  world.exits.push({ z: MTN.divergeZ, no: 4, name: "峠 Tōge" });

  // fast-lane guidance on the approach: this is the lap's one LEFT exit, so
  // the arrows and the 分岐 text ride the fast lane, not the kerb lane
  const wz = (z: number) => (z < cor.Z0 ? z + cor.LOOP : z);
  const latA = (z: number) =>
    cor.laneOffset(Math.round(cor.laneCount(z)) - 1, z) - 0.5;
  for (let k = 0; k < 3; k++) {
    const z = wz(MTN.divergeZ - 34 - k * 26);
    decal(z, latA(z), 1.6, 3.4, arrowMat);
  }
  {
    const z = wz(MTN.divergeZ - 122);
    word(z, latA(z), wordMat("分岐"), 2);
  }

  const [b400, b200, bGore, bOneWay, bMerge] = MTN_BOARD_Z();
  board(b400, 7.4, 2.8, exitSignTexF(4, "400 m", "峠"));
  board(b200, 7.4, 2.8, exitSignTexF(4, "200 m", "峠"));
  board(bGore, 7.4, 2.8, exitSignTexF(4, "出口", "峠"));
  // the pass is a single lane in one direction — say so before the gore, not
  // after it, since the gore is the last place a driver can decline it
  board(bOneWay, 6.6, 2.5, warnTexF("一方通行 一車線", "ONE WAY · SINGLE LANE"));
  board(bMerge, 6.6, 2.5, warnTexF("合流注意", "MERGING TRAFFIC"));
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
