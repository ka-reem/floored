import * as THREE from "three";
import {
  brakeDiscGeo, carShellGeos, doorFurnitureGeos, grilleGeos, makeWheel,
  panelLineGeo, roundedBoxGeo,
} from "./carshape";
import { paintTexF, carbonTexF } from "./textures";
import { buildCockpit, COCKPIT_REF, type Cockpit } from "./cockpit";
import { attachCockpitModel, type CockpitModelHandle } from "./cockpitmodel";
import { attachBodyModel, type BodyModelHandle } from "./bodymodel";
import type { RenderTier } from "./settings";

import { carEnvMap, isSharedEnv, trackEnvMaterial, untrackEnvMaterial } from "./carenv";
import { paintByHex, type CarSpec, type Paint } from "./carspecs";

/* Which donor INTERIOR each render tier loads, or "" for none — a build stem
   under public/models/cockpits/, see tools/build-cockpit.mjs.

   One donor, not a choice of two. This used to name `volvo-s90`, a per-vertex
   frustum CUT of the same car: sharper over the third of the cabin it kept,
   but sliced geometry, so it printed torn shards at the frame borders as soon
   as the Field-of-view slider went past what it was cut for, and engine.ts had
   to hold the lens down to 88 whenever it was on screen. `volvo-s90-full` is
   whole nodes only — decimated rather than sliced — so it survives the slider
   at 100 and the cap is gone with it. The cut asset is out of the game and out
   of public/; the build command that would bring it back is in .gitignore.

   Desktop and mobile-high run the same file. The dash covers about 800x430 px
   of a 1080p frame (~344k pixels), then the dashcam pass softens and grains it
   (post.ts: "centre nearly in focus, corners mush") and the night grade
   crushes most of it toward black — so the resolution that survives to the
   player is nowhere near what a second, larger variant would carry. Build a
   -4k variant and point desktop at it if a brighter interior ever makes the
   difference visible.

   mobile-base gets nothing. It is the tier unknown hardware falls back to (see
   resolveRenderTier), so it has to assume the weakest plausible device, and a
   third of a million triangles of cabin on top of traffic and world geometry
   is not a bet worth taking there. The procedural dash is not a placeholder
   for those players — it is the shipped one. */
const COCKPIT_MODEL: Record<RenderTier, string> = {
  desktop: "volvo-s90-full",
  "mobile-high": "volvo-s90-full",
  "mobile-base": "",
};
/* Which cars have an imported EXTERIOR body, by spec id. Only kaze: the donor
   is a real S90 and kaze is the one shell close enough to it to be fitted by
   scaling alone — the 3.14 m kei car is not, and never will be. Keyed by car
   rather than by tier because it is a 0.5 MB static shell that only shows in
   the chase cameras; there is nothing here for a weaker device to opt out of
   that hiding the exterior does not already handle. */
const BODY_MODEL: Record<string, string> = { kaze: "volvo-s90-body-lite" };
/* The headlight carpet's alpha field: a WEDGE spreading forward from the
   bumper, not a radial pool.

   The first cut of this borrowed poolGradientTex() from world/decaltex.ts,
   which is a centred radial fade — correct for a cobra head, which hangs above
   its own pool, and wrong for a car, which is behind its light. Stretched over
   a quad whose near end sat several metres behind the lamp line, it rendered as
   a HALO AROUND THE CAR: light on the tarmac beside the doors and behind the
   rear wheels, brightest somewhere out in the middle of it. Headlights only
   throw forward, so the shape has to be built rather than borrowed.

   Three properties, all of them load-bearing:

   - Zero at the near edge, rising over the first ~20%. There is no light
     behind the bumper and no hard line at the quad's leading edge either; the
     wash starts from nothing and comes up.
   - Deliberately FLAT rather than peaked. The first shaping of this ramped up
     over 22% and fell as (1-s)^1.5 with a 1.6-power lateral, which put a lot
     of its alpha into a small bright core — and since the POV chain crushes
     everything under 0.06 to pure black, the visible wash was a sliver about
     1 m either side of centre while the rest of the wedge sat below the floor.
     Flattening it (ramp 0.12, tail exponent 0.55, lateral 0.8, amplitude 0.52)
     covers 40 m2 of road above that floor instead of 16 at the SAME peak
     level. Spread comes from where the alpha is spent, not from more of it:
     the peak is a hue and clipping budget, the tail is what you actually see.
   - The lateral half-width GROWS with distance, 0.18 -> 1.0 of the quad's, so
     it is a wedge. Beside the front wheels it is barely a metre wide; by the
     far end it spans the carriageway. That divergence is what makes it read as
     light leaving two lamps rather than a shape laid on the road.

   Lateral profile is (1 - (x/hw)^2)^1.6 — smooth, and exactly zero at the
   wedge edge, so no side of this quad can print an edge.

   Colour is halogen, near-white with a faint warmth cooling very slightly
   toward the skirt. Explicitly NOT the sodium of the lamp pools: sharing that
   texture made the car throw an orange pool and read as if the streetlights
   themselves had been changed. The falloff is a fact about how light fades and
   is worth sharing; the colour is a fact about the lamp and is not. */
function carpetBeamTex(): THREE.Texture {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const ss = (a: number, b: number, x: number) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < S; y++) {
    /* CanvasTexture flips Y and PlaneGeometry's +y maps to -z once the mesh is
       laid flat, so canvas row 0 is the end nearest the car. `s` is therefore
       distance along the beam, 0 at the bumper to 1 at the far edge. */
    const s = y / (S - 1);
    const lon = ss(0, 0.12, s) * Math.pow(Math.max(0, 1 - s), 0.55);
    const hw = 0.18 + 0.82 * s;
    for (let x = 0; x < S; x++) {
      const u = (x / (S - 1)) * 2 - 1;
      const q = Math.abs(u) / hw;
      const lat = q >= 1 ? 0 : Math.pow(1 - q * q, 0.8);
      const a = 0.52 * lon * lat;
      const i = (y * S + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = Math.round(246 + 6 * s);
      img.data[i + 2] = Math.round(230 + 14 * s);
      img.data[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/* Player car assembly: smoothed shell + parametric detailing (bumpers, trim,
   panel gaps, door furniture, grille, lamps, mirrors, spoiler, exhausts),
   physical clearcoat paint, wheels with steering pivots, headlight spots, and
   the RHD cockpit. */

/* ---------------- paint ----------------

   Real automotive paint is a coloured, flaked base coat under a separate
   glossy clear layer, and rendering it as one glossy surface is most of why
   game cars read as plastic. Every finish below is clearcoat 1.0 over a base
   whose metalness/roughness carries the pigment; only the base changes.

   The clear coat gets a faint "orange peel" normal so its reflections ripple
   the way a sprayed panel does — the single cheapest cue that a body is
   painted rather than shaded. No transmission and no iridescence anywhere:
   the car is drawn three times a frame (main view, mirror, road reflection)
   and neither is worth that. */

const ORANGE_PEEL = 0.055;

let peelTex: THREE.Texture | null = null;
let smudgeTex: THREE.Texture | null = null;
/** textures that outlive any one rig and must survive its dispose() */
const SHARED_TEX = new Set<THREE.Texture>();

function noiseCanvas(size: number, draw: (h: Float32Array) => void) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const h = new Float32Array(size * size);
  draw(h);
  return { c, h };
}

/** Value-noise height field, tileable, summed over two octaves. */
function peelHeight(size: number, h: Float32Array) {
  const lat = (n: number) => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) g[i] = Math.random();
    return g;
  };
  for (const [n, amp] of [[8, 0.7], [16, 0.3]] as const) {
    const g = lat(n);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * n, fy = (y / size) * n;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const at = (ix: number, iy: number) => g[(iy % n) * n + (ix % n)];
        const a = at(x0, y0), b = at(x0 + 1, y0), c2 = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
        h[y * size + x] += amp * (a + (b - a) * sx + (c2 - a) * sy + (a - b - c2 + d) * sx * sy);
      }
  }
}

/** Tangent-space normal map for the clear coat's orange peel. */
function orangePeelTex(): THREE.Texture {
  if (peelTex) return peelTex;
  const S = 128;
  const { c, h } = noiseCanvas(S, (buf) => peelHeight(S, buf));
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      // normalize (-dx, -dy, 1) into the 0..255 normal-map encoding
      const l = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      img.data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l) * 0.5 * 255 + 127;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  peelTex = t;
  SHARED_TEX.add(t);
  return t;
}

/** Greyscale blotches used as a roughness map — brake dust and fingerprints
 *  on the rims, which is what stops a wheel looking chrome-plated. */
function smudgeRoughTex(): THREE.Texture {
  if (smudgeTex) return smudgeTex;
  const S = 64;
  const { c, h } = noiseCanvas(S, (buf) => peelHeight(S, buf));
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = Math.min(255, Math.max(0, 150 + h[i] * 150)) | 0;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  smudgeTex = t;
  SHARED_TEX.add(t);
  return t;
}

/* A clearcoat this sharp turns a close SpotLight into a mirror of the filament,
   and the bloom pass then smears that across half the screen — the same
   blow-out that made the physical headlights unusable on the traffic cars. The
   knee compresses the outgoing radiance above a threshold so a highlight can
   still be the brightest thing on screen without going white and blooming into
   a wall. Diffuse-lit paint never reaches the threshold and is untouched. */
const KNEE = 1.8, KNEE_MAX = 9.0;
const KNEE_GLSL = `{
  float m = max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b);
  if (m > ${KNEE.toFixed(2)}) {
    float e = m - ${KNEE.toFixed(2)};
    float k = ${KNEE.toFixed(2)} + e / (1.0 + e / ${(KNEE_MAX - KNEE).toFixed(2)});
    outgoingLight *= k / m;
  }
}
#include <opaque_fragment>`;

/** Soft-knee the specular highlight so close headlights cannot blow the panel
 *  out to solid white. Safe on any lit material. */
function tameSpecular<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <opaque_fragment>", KNEE_GLSL);
  };
  // without a distinct cache key three hands this material the program it
  // compiled for an identical-looking material that has no knee
  mat.customProgramCacheKey = () => "carKnee";
  return mat;
}

/** Base coat recipe per finish; the clear coat on top is identical for all. */
function paintMaterial(paint: Paint, env: THREE.Texture): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: paint.hex,
    envMap: env,
    side: THREE.DoubleSide,
    clearcoat: 1,
    clearcoatNormalMap: orangePeelTex(),
    clearcoatNormalScale: new THREE.Vector2(ORANGE_PEEL, ORANGE_PEEL),
  });
  if (paint.finish === "solid") {
    // no flake: pigment straight under the clear. Flatter, and darker at
    // grazing angles than a metallic of the same colour.
    m.metalness = 0.06;
    m.roughness = 0.46;
    m.clearcoatRoughness = 0.075;
    m.envMapIntensity = 1.0;
  } else if (paint.finish === "pearl") {
    // mica: a half-metal base plus a tinted sheen lobe that only shows up
    // where the body turns away from the viewer
    m.map = paintTexF();
    m.metalness = 0.5;
    m.roughness = 0.4;
    m.clearcoatRoughness = 0.055;
    m.envMapIntensity = 1.2;
    m.sheen = 0.7;
    m.sheenColor = new THREE.Color(paint.pearlHex ?? 0xffffff);
    m.sheenRoughness = 0.55;
  } else {
    m.map = paintTexF();
    m.metalness = 0.88;
    m.roughness = 0.36;
    m.clearcoatRoughness = 0.06;
    m.envMapIntensity = 1.3;
  }
  return tameSpecular(m);
}

export interface PlayerRig {
  spec: CarSpec;
  carGroup: THREE.Group;
  bodyG: THREE.Group;
  exteriorG: THREE.Group;
  cockpit: Cockpit;
  /** The imported dash once it has loaded, else null. Null is the normal
      steady state when no donor is configured or the fetch failed. */
  readonly cockpitModel: CockpitModelHandle | null;
  /** Settles once the donor dash has landed or been given up on; already
      settled on a tier that configures no donor. Never rejects. */
  readonly cockpitReady: Promise<void>;
  /** The imported exterior body once it has loaded, else null — null is the
      normal steady state for every car but kaze, and for a failed fetch. */
  readonly bodyModel: BodyModelHandle | null;
  /** Show the imported body, or the procedural one. Safe to call before the
      donor has loaded (and before it is known whether it ever will): the state
      is remembered and applied when it arrives. */
  setBodyImported(on: boolean): void;
  pivFL: THREE.Group;
  pivFR: THREE.Group;
  wheels: THREE.Group[];
  spotL: THREE.SpotLight;
  spotR: THREE.SpotLight;
  /** Wide, short-throw, heavily-feathered fill cone per lamp — the "spill"
      a real projector/reflector headlamp throws to the sides that the narrow
      edge-aimed main beam (spotL/spotR) deliberately doesn't cover. Lights
      the adjacent lane, not the road ahead; see the per-frame drive in
      engine.ts for the geometry. */
  spreadL: THREE.SpotLight;
  spreadR: THREE.SpotLight;
  /** The wide soft carpet of light on the tarmac ahead — a gradient decal, not
      a light. See the build below for why the spotlights cannot do this job.
      Driven per-frame in engine.ts: `beamCarpetMat.opacity` for level,
      `beamCarpet.scale`/`position.z` for the mode's footprint, and
      `beamCarpetG.rotation.x` for the deck grade. */
  beamCarpet: THREE.Mesh;
  beamCarpetMat: THREE.MeshBasicMaterial;
  /** Yaw-only parent of `beamCarpet`; pitch this to the deck grade, never to
      the car body (see the build comment). */
  beamCarpetG: THREE.Group;
  headMat: THREE.MeshStandardMaterial;
  tailMat: THREE.MeshStandardMaterial;
  sigMatL: THREE.MeshStandardMaterial;
  sigMatR: THREE.MeshStandardMaterial;
  hlGlowMat: THREE.SpriteMaterial;
  plateGlowMat: THREE.SpriteMaterial;
  halfW: number;
  halfL: number;
  dispose(scene: THREE.Scene): void;
}

export function buildPlayerCar(
  scene: THREE.Scene,
  spec: CarSpec,
  paintHex: number,
  envMap: THREE.CubeTexture,
  glowTex: THREE.Texture,
  mirrorTexture: THREE.Texture,
  /* Passed in rather than resolved here: resolveRenderTier needs the live GL
     context to read the renderer string, and the engine already holds both. */
  tier: RenderTier = "desktop"
): PlayerRig {
  const P = spec.shell;
  const L2 = P.L / 2;
  const carGroup = new THREE.Group();
  scene.add(carGroup);
  const bodyG = new THREE.Group();
  carGroup.add(bodyG);
  const exteriorG = new THREE.Group(), lampsG = new THREE.Group();
  bodyG.add(exteriorG);
  /* Lamps ride the BODY, not the yaw-only carGroup: bodyG is what engine.ts
     pitches to the road slope (and rolls/dives), and headlights are bolted to
     that body. Parented to carGroup they stayed world-horizontal, so on a 6%
     ramp climb the dipped cut-off (aimed 0.4% below horizontal) met the rising
     deck at ~10 m and everything beyond — road, paint, barriers — sat outside
     the cone entirely; over a crest the pool overshot instead. On flat road
     bodyG's rotation is just the tiny damped squat/dive transient, so nothing
     changes there. Aim math in engine.ts works in lampsG-local space and is
     untouched by this. */
  bodyG.add(lampsG);

  /* The world's painted cube env is the floor, not the ceiling: when a real
     equirect HDRI is on disk, carenv swaps it under these materials a moment
     after boot and the bodywork starts reflecting a city instead of a
     gradient. Materials registered here follow that swap for their lifetime. */
  const env = carEnvMap(envMap);
  const envMats: THREE.Material[] = [];
  const withEnv = <T extends THREE.Material>(m: T): T => {
    envMats.push(m);
    trackEnvMaterial(m);
    return m;
  };

  const paint = withEnv(paintMaterial(paintByHex(paintHex), env));
  /* Glass is a dielectric, not a dark metal: metalness 0 with a low roughness
     and a strong env term gives the hard, angle-dependent sheet reflection
     that reads as automotive glazing. Slightly transparent so the cabin shows
     through as a suggestion — no transmission, which would cost a whole
     backbuffer sample per pixel for a surface this dark. */
  const darkGlass = withEnv(tameSpecular(new THREE.MeshPhysicalMaterial({
    color: 0x0a0f18, metalness: 0, roughness: 0.05, envMap: env, envMapIntensity: 1.7,
    clearcoat: 1, clearcoatRoughness: 0.03, transparent: true, opacity: 0.88,
  })));
  /* Mirror caps get a real mirror: fully metallic and near-perfectly smooth,
     so they pick out point lights the paint only smears. */
  const mirrorFaceM = withEnv(tameSpecular(new THREE.MeshStandardMaterial({
    color: 0xdfe6f2, metalness: 1, roughness: 0.03, envMap: env, envMapIntensity: 1.6,
  })));
  const carbonM = withEnv(new THREE.MeshStandardMaterial({
    map: carbonTexF(), roughness: 0.45, metalness: 0.5, envMap: env, envMapIntensity: 0.7,
  }));
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x121319, roughness: 0.5, metalness: 0.4 });
  /* Panel gaps and the grille recess: matte and nearly black. A shut line is
     a shadow, so it must not pick up any env reflection of its own. */
  const shutMat = new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 0.95, metalness: 0 });
  const chromeMat = withEnv(tameSpecular(new THREE.MeshStandardMaterial({
    color: 0xb9c2d4, metalness: 1, roughness: 0.18, envMap: env, envMapIntensity: 1.4,
  })));
  /* Grille slats and exhaust interiors: dark anodised metal, not chrome. */
  const slatMat = withEnv(new THREE.MeshStandardMaterial({
    color: 0x33373f, metalness: 0.85, roughness: 0.42, envMap: env, envMapIntensity: 0.8,
  }));
  const sealMat = new THREE.MeshStandardMaterial({ color: 0x0a0b0e, roughness: 1, metalness: 0 });

  const box = (
    w: number, h: number, d: number, mat: THREE.Material,
    x: number, y: number, z: number, cast = true
  ) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (cast) m.castShadow = true;
    exteriorG.add(m);
    return m;
  };
  const rmesh = (g: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    exteriorG.add(m);
    return m;
  };

  /* shells */
  const shells = carShellGeos(P, true);
  rmesh(shells.hull, paint);
  rmesh(shells.glass, darkGlass);
  rmesh(shells.roof, paint);

  /* wheel-arch liners */
  const linerG = new THREE.CylinderGeometry(P.archR - 0.02, P.archR - 0.02, 0.3, 14, 1, true, 0, Math.PI);
  const linerM = new THREE.MeshStandardMaterial({
    color: 0x08090c, roughness: 1, side: THREE.DoubleSide,
  });
  const axX = P.W / 2 - P.wheelWidth / 2 - 0.07;
  for (const [x, z] of [
    [-axX, P.wzF], [axX, P.wzF], [-axX, -P.wzR], [axX, -P.wzR],
  ]) {
    const li = new THREE.Mesh(linerG, linerM);
    li.position.set(x, P.ride, z);
    // rotation.z alone puts the half-cylinder axis on the axle with the dome
    // upward; adding rotation.y here flips the radius sideways so the shell
    // bulges out through the fenders
    li.rotation.z = Math.PI / 2;
    exteriorG.add(li);
  }

  /* underbody + bumpers + trim */
  rmesh(roundedBoxGeo(P.W + 0.03, 0.16, P.L + 0.05, 0.07), trimMat, 0, P.ride * 0.75, 0);
  rmesh(roundedBoxGeo(P.W - 0.05, 0.24, 0.5, 0.1), trimMat, 0, P.nose * 0.72, L2 - 0.06);
  rmesh(roundedBoxGeo(P.W - 0.06, 0.26, 0.44, 0.1), trimMat, 0, P.tail * 0.72, -L2 + 0.04);
  box(P.W * 0.68, 0.1, 0.02, chromeMat, 0, P.nose + 0.08, L2 + 0.06);
  // plate F — bolted over the grille, so it has to sit in front of the slats
  box(0.44, 0.14, 0.02, new THREE.MeshBasicMaterial({ color: 0xf2f4f8 }), 0, P.nose * 0.68, L2 + 0.225);
  box(0.44, 0.14, 0.02, new THREE.MeshBasicMaterial({ color: 0xf2f4f8 }), 0, P.tail * 0.8, -L2 - 0.2); // plate R
  box(P.W * 0.85, 0.05, 0.4, carbonM, 0, P.ride * 0.72, L2 - 0.24);
  box(P.W * 0.82, 0.09, 0.34, carbonM, 0, P.ride * 0.78, -L2 + 0.22);
  for (const s of [-1, 1]) box(0.022, 0.1, P.L * 0.78, carbonM, s * (P.W / 2 - 0.005), P.ride * 0.88, 0);
  /* grille + bumper ducts: recessed dark backing with slat edges in front,
     each merged to a single draw */
  const grille = grilleGeos(P);
  rmesh(grille.back, shutMat);
  rmesh(grille.slats, slatMat);

  /* panel gaps and door furniture — the shut lines, handles and filler flap
     that separate a car body from a moulded shell */
  const panels = new THREE.Mesh(panelLineGeo(P), shutMat);
  exteriorG.add(panels);
  const furniture = doorFurnitureGeos(P);
  rmesh(furniture.handles, chromeMat);
  rmesh(furniture.recess, shutMat);

  /* exhausts: a chromed tip with a dark bore, which is what stops the tip
     reading as a solid metal peg */
  const exXs = spec.id === "tanuki" ? [0.3] : [-(P.W / 2 - 0.32), P.W / 2 - 0.32];
  for (const exX of exXs) {
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.16, 12), chromeMat);
    ex.rotation.x = Math.PI / 2;
    ex.position.set(exX, P.ride * 0.62, -L2 - 0.03);
    exteriorG.add(ex);
    const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.14, 12), sealMat);
    bore.rotation.x = Math.PI / 2;
    bore.position.set(exX, P.ride * 0.62, -L2 - 0.045);
    exteriorG.add(bore);
  }
  // mirrors: body-coloured shell, mirror-finish cap, rubber-sealed stalk
  for (const s of [-1, 1]) {
    const mir = rmesh(
      roundedBoxGeo(0.3, 0.13, 0.1, 0.045), paint,
      s * (P.W / 2 + 0.09), P.belt + 0.28, L2 - P.hood - 0.3
    );
    mir.rotation.y = s * 0.25;
    // the cap is yawed outboard, so its face and seal have to yaw with it or
    // one corner of the glass pushes through the shell
    const face = box(0.24, 0.1, 0.012, mirrorFaceM,
      s * (P.W / 2 + 0.09), P.belt + 0.28, L2 - P.hood - 0.349, false);
    const seal = box(0.26, 0.115, 0.014, sealMat,
      s * (P.W / 2 + 0.09), P.belt + 0.28, L2 - P.hood - 0.344, false);
    face.rotation.y = seal.rotation.y = s * 0.25;
    box(0.05, 0.05, 0.15, trimMat, s * (P.W / 2 - 0.06), P.belt + 0.22, L2 - P.hood - 0.3);
  }
  // hood bulge
  if (P.hoodBulge) {
    const hb = rmesh(roundedBoxGeo(P.W * 0.36, 0.07, P.hood * 0.62, 0.035), paint,
      0, P.belt - (P.belt - P.nose) * 0.32 + 0.015, L2 - P.hood * 0.52);
    hb.rotation.x = -Math.atan2(P.belt - P.nose, P.hood) * 0.85;
  }
  // spoiler
  if (P.spoiler === "wing") {
    for (const s of [-1, 1]) box(0.06, 0.16, 0.2, trimMat, s * (P.W / 2 - 0.3), P.belt + 0.1, -L2 + 0.3);
    const wing = rmesh(roundedBoxGeo(P.W - 0.42, 0.05, 0.34, 0.02), paint, 0, P.belt + 0.22, -L2 + 0.28);
    wing.rotation.x = 0.12;
    for (const s of [-1, 1]) box(0.03, 0.1, 0.3, paint, s * (P.W / 2 - 0.22), P.belt + 0.18, -L2 + 0.28);
  } else if (P.spoiler === "lip") {
    rmesh(roundedBoxGeo(P.W - 0.5, 0.045, 0.18, 0.02), paint, 0, P.belt + 0.04, -L2 + P.trunk * 0.3);
  } else if (P.spoiler === "roofcap") {
    const rc = rmesh(roundedBoxGeo(P.W - 0.5, 0.05, 0.26, 0.02), paint,
      0, P.roof + 0.05, -L2 + P.trunk + P.rakeR * 0.4);
    rc.rotation.x = -0.18;
  }
  // shark fin
  const fin = rmesh(roundedBoxGeo(0.05, 0.1, 0.27, 0.02, 1), paint,
    0, P.roof + 0.08, -L2 + P.trunk + P.rakeR + 0.25);
  fin.rotation.x = 0.06;

  /* brakes — drilled disc and hub hat, on the wheel centre line rather than
     the sill so they stay concentric behind the spokes */
  const discGeo = brakeDiscGeo(P.wheelR);
  const discM = withEnv(new THREE.MeshStandardMaterial({
    color: 0x44474f, metalness: 0.9, roughness: 0.8, roughnessMap: smudgeRoughTex(),
    envMap: env, envMapIntensity: 0.5,
  }));
  const calM = new THREE.MeshStandardMaterial({ color: 0xc2242e, roughness: 0.4, metalness: 0.4 });
  for (const [x, z] of [
    [-axX, P.wzF], [axX, P.wzF], [-axX, -P.wzR], [axX, -P.wzR],
  ]) {
    const d = new THREE.Mesh(discGeo, discM);
    d.position.set(x * 0.985, P.wheelR, z);
    exteriorG.add(d);
    box(0.05, 0.085, 0.11, calM, x * 0.985, P.wheelR + 0.02, z + 0.12, false);
  }

  /* wheels — matte carcass, greyer sidewall shoulder, and rims whose polish
     is broken up by a brake-dust roughness map so they read as used metal */
  const tireM = new THREE.MeshStandardMaterial({ color: 0x0b0b0f, roughness: 0.93, metalness: 0 });
  const sidewallM = new THREE.MeshStandardMaterial({ color: 0x18191e, roughness: 0.86, metalness: 0 });
  const rimM = withEnv(tameSpecular(new THREE.MeshStandardMaterial({
    color: 0x9aa2b4, metalness: 0.95, roughness: 0.42, roughnessMap: smudgeRoughTex(),
    envMap: env, envMapIntensity: 1.1,
  })));
  const rimDark = withEnv(new THREE.MeshStandardMaterial({
    color: 0x23262e, metalness: 0.9, roughness: 0.7, roughnessMap: smudgeRoughTex(),
    envMap: env, envMapIntensity: 0.7,
  }));
  const mk = () => makeWheel(P.wheelR, P.wheelWidth, rimM, rimDark, tireM, true, sidewallM);
  const wFL = mk(), wFR = mk(), wRL = mk(), wRR = mk();
  const pivFL = new THREE.Group(), pivFR = new THREE.Group();
  pivFL.position.set(-axX, P.wheelR, P.wzF);
  pivFR.position.set(axX, P.wheelR, P.wzF);
  pivFL.add(wFL);
  pivFR.add(wFR);
  wRL.position.set(-axX, P.wheelR, -P.wzR);
  wRR.position.set(axX, P.wheelR, -P.wzR);
  exteriorG.add(pivFL, pivFR, wRL, wRR);

  /* lamps */
  const headMat = new THREE.MeshStandardMaterial({ color: 0x555555, emissive: 0xf6f9ff, emissiveIntensity: 2.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x2a0508, emissive: 0xff2233, emissiveIntensity: 1.7 });
  const sigMatL = new THREE.MeshStandardMaterial({ color: 0x2a1a06, emissive: 0xffa028, emissiveIntensity: 0 });
  const sigMatR = new THREE.MeshStandardMaterial({ color: 0x2a1a06, emissive: 0xffa028, emissiveIntensity: 0 });
  // lamps must sit proud of the bumper trim, which reaches L2+0.19 front / -L2-0.18 rear
  const hlY = P.nose * 0.9, hlX = P.W * 0.31;
  box(P.W * 0.25, 0.09, 0.06, headMat, -hlX, hlY, L2 + 0.17, false);
  box(P.W * 0.25, 0.09, 0.06, headMat, hlX, hlY, L2 + 0.17, false);
  box(P.W * 0.22, 0.02, 0.05, headMat, -hlX, hlY - 0.065, L2 + 0.175, false);
  box(P.W * 0.22, 0.02, 0.05, headMat, hlX, hlY - 0.065, L2 + 0.175, false);
  const tlY = P.tail * 0.88;
  box(P.W * 0.23, 0.1, 0.06, tailMat, -hlX, tlY, -L2 - 0.16, false);
  box(P.W * 0.23, 0.1, 0.06, tailMat, hlX, tlY, -L2 - 0.16, false);
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x220305, emissive: 0xff2030, emissiveIntensity: 1.4 });
  box(P.W * 0.78, 0.045, 0.03, ledMat, 0, tlY + 0.06, -L2 - 0.185, false);
  // car-left is +x in this frame (facing +z, right side at -x)
  box(0.12, 0.08, 0.06, sigMatL, P.W / 2 - 0.08, hlY - 0.01, L2 + 0.16, false);
  box(0.12, 0.08, 0.06, sigMatL, P.W / 2 - 0.06, tlY - 0.02, -L2 - 0.15, false);
  box(0.12, 0.08, 0.06, sigMatR, -(P.W / 2 - 0.08), hlY - 0.01, L2 + 0.16, false);
  box(0.12, 0.08, 0.06, sigMatR, -(P.W / 2 - 0.06), tlY - 0.02, -L2 - 0.15, false);
  const mkrM = new THREE.MeshStandardMaterial({ color: 0x241204, emissive: 0xffa028, emissiveIntensity: 1.1 });
  const mkrR = new THREE.MeshStandardMaterial({ color: 0x240406, emissive: 0xff2233, emissiveIntensity: 1.0 });
  for (const s of [-1, 1]) {
    box(0.05, 0.03, 0.02, mkrM, s * (P.W / 2 - 0.01), P.nose, P.wzF + 0.5, false);
    box(0.05, 0.03, 0.02, mkrR, s * (P.W / 2 - 0.01), P.tail, -P.wzR - 0.55, false);
  }
  const hlGlowMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xcfe0ff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
  });
  /* Kept aside for the imported body below: the donor's lamps are inert
     geometry, so these sprites are what still reads as headlights at night
     once the procedural emissive boxes are hidden under it. */
  const glowSprites: THREE.Sprite[] = [];
  for (const s of [-1, 1]) {
    const sp = new THREE.Sprite(hlGlowMat);
    sp.scale.set(0.85, 0.85, 1);
    sp.position.set(s * hlX, hlY, L2 + 0.24);
    exteriorG.add(sp);
    glowSprites.push(sp);
  }
  const plateGlowMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xffe9c0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
  });
  {
    const pg = new THREE.Sprite(plateGlowMat);
    pg.scale.set(0.5, 0.28, 1);
    pg.position.set(0, P.tail * 0.8, -L2 - 0.24);
    exteriorG.add(pg);
    glowSprites.push(pg);
  }
  // decay (last arg) is overwritten every frame in engine.ts's per-mode
  // block — low beam and high beam no longer share one value — so this is
  // just a sane pre-first-frame default, not the value either mode runs at
  const spotL = new THREE.SpotLight(0xdfe9ff, 0, 115, 0.46, 0.6, 1.0);
  const spotR = new THREE.SpotLight(0xdfe9ff, 0, 115, 0.46, 0.6, 1.0);
  spotL.position.set(-hlX, P.nose, L2 - 0.05);
  spotR.position.set(hlX, P.nose, L2 - 0.05);
  const tgtL = new THREE.Object3D(), tgtR = new THREE.Object3D();
  tgtL.position.set(-1.4, -0.4, 26);
  tgtR.position.set(1.4, -0.4, 26);
  lampsG.add(spotL, tgtL, spotR, tgtR);
  spotL.target = tgtL;
  spotR.target = tgtR;

  /* Lateral fill cones — same physical lamp, the wide-angle low-intensity
     portion of the reflector real headlamps also throw. Angle/penumbra/decay/
     distance/target are all driven per-frame in engine.ts alongside the main
     beam's, switching low/high mode together; the values here are just a
     sane pre-first-frame default. No shadows: two more shadow-casting lights
     per car would be a real cost, and a wide, soft, near-field fill has
     nothing a missing shadow would read as wrong.

     Mounted lower than the main lamp (bumper-ish, not headlamp height): a
     wide symmetric cone whose upper edge must stay near horizontal can only
     reach as far as lampHeight/tan(topEdgeAngle) before it's fully
     attenuated anyway, so a lower lamp buys a bit more throw for the same
     safety margin, and it also keeps this cone's hot core aimed at the road
     rather than at another car's bumper height. */
  const spreadL = new THREE.SpotLight(0xdfe9ff, 0, 30, 0.5, 0.5, 1.2);
  const spreadR = new THREE.SpotLight(0xdfe9ff, 0, 30, 0.5, 0.5, 1.2);
  spreadL.castShadow = false;
  spreadR.castShadow = false;
  spreadL.position.set(-hlX, P.nose - 0.16, L2 - 0.05);
  spreadR.position.set(hlX, P.nose - 0.16, L2 - 0.05);
  const spreadTgtL = new THREE.Object3D(), spreadTgtR = new THREE.Object3D();
  spreadTgtL.position.set(-3.0, -1.1, 14);
  spreadTgtR.position.set(3.0, -1.1, 14);
  lampsG.add(spreadL, spreadTgtL, spreadR, spreadTgtR);
  spreadL.target = spreadTgtL;
  spreadR.target = spreadTgtR;

  /* ---- the carpet: the wide soft light on the road ahead ----

     This is a gradient DECAL, not a light, and that is the whole point. A
     spotlight cannot produce what a real dipped beam looks like from inside
     the car, and the reason is geometric rather than a matter of tuning: the
     cut-off has to sit just below horizontal or the beam blinds oncoming
     traffic, and pinning the upper edge there forces a symmetric cone to aim
     its bright axis down into the tarmac a metre or two past the bumper. Open
     the cone up for width and that axis lands closer and hotter — the blown
     white slab. Close it down to move the hot spot away and it reads as a
     narrow shaft. Both failure modes were shipped and rejected in turn, and
     no intensity, decay or penumbra value escapes the trade, because it comes
     from where a 0.6 m-high lamp with a horizontal cut-off can point.

     The highway's sodium lamps have looked right for exactly this reason: the
     pools under them are quads carrying poolGradientTex — a 15-stop monotone
     fade with a long low tail (see world/decaltex.ts) — and not lights at
     all. Same instrument here. A decal has no cone, so width is free, the
     falloff is whatever the texture says, and there is no boundary anywhere
     in it for the POV grade's blown-highlight clip to print as a hard line.

     One quad for both lamps, deliberately. Real headlights an axle-width
     apart throw overlapping beams that merge into a single field within a few
     metres, and the two-pools-of-light look is a rendering artefact rather
     than something drivers see. Since the gradient is radial and the quad is
     stretched long, it reads as one elongated wash centred well down the road
     — the brightest part is out where you are looking, not against the hood.

     Parented to carGroup, which yaws but does not pitch or roll: the carpet
     belongs to the ROAD, and if it rode bodyG it would tilt into the tarmac
     under braking and lift off it under acceleration. engine.ts pitches it by
     the deck grade alone, per frame, for the same reason. */
  const carpetG = new THREE.Group();
  const beamCarpetMat = new THREE.MeshBasicMaterial({
    map: carpetBeamTex(),
    color: 0xfff2e0,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const beamCarpet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), beamCarpetMat);
  beamCarpet.rotation.x = -Math.PI / 2;
  /* Above the road but below the painted markings' own decals, and no depth
     write, so it never z-fights the deck and never occludes the retro paint
     it is supposed to be lighting. Frustum culling off: the quad's centre can
     sit 10 m ahead of the car while its near skirt is still behind the
     camera, which is exactly the case three's bounding-sphere test gets wrong
     often enough to make the light flicker at the edge of the screen. */
  beamCarpet.position.set(0, 0.06, 12);
  beamCarpet.renderOrder = 3;
  beamCarpet.frustumCulled = false;
  carpetG.add(beamCarpet);
  carGroup.add(carpetG);

  /* cockpit */
  const cockpit = buildCockpit(spec.cockpitAccent, mirrorTexture, spec.id);
  cockpit.group.position.y = P.belt - COCKPIT_REF.belt;
  cockpit.group.scale.x = P.W / COCKPIT_REF.W;
  bodyG.add(cockpit.group);

  /* Imported dash, if one is configured. Fire-and-forget: the procedural dash
     above is already on screen and stays there until (and unless) this lands.
     NOTE the x-scale on the group above also stretches the donor. That is
     consistent with how the procedural trim is fitted to each car's width, but
     a real dash is not a stretchable object — narrow it to the procedural
     region once a donor is more than a prototype. */
  const rigRef = { model: null as CockpitModelHandle | null };
  const donor = COCKPIT_MODEL[tier];
  /* Settled when the donor question is answered — landed, failed, or never
     asked. The staged load in engine.ts waits on this (with a budget) so the
     dash is already fitted on the first frame the player sees: the dashcam POV
     is the view the game is played in, and a dash that swaps under them a
     second into the drive is the one asset pop worth paying for up front.
     Resolves rather than rejects on failure — attachCockpitModel's callback
     runs either way, and a missing donor is a normal steady state. */
  let dashDone!: () => void;
  const cockpitReady = new Promise<void>((res) => { dashDone = res; });
  if (donor) attachCockpitModel(cockpit, donor, (h) => { rigRef.model = h; dashDone(); });
  else dashDone();

  /* Imported exterior body, if this car has one. Same fire-and-forget shape as
     the dash above, the same fallback rule, and the same default: the donor
     dash and the donor body are two cuts of one car and are shown together,
     off engine.ts's single J flag. Nothing waits on this one — it is invisible
     in the POV the game is played in, so there is no pop worth paying for.

     `want` is what closes the load race. The body can land AFTER the player
     has already toggled back to the procedural car, and a handle that switched
     itself on at that point would put a Volvo body under a procedural dash —
     exactly the mismatch the single flag exists to prevent. So the desired
     state is recorded whether or not the handle exists yet, and applied on
     arrival. */
  const bodyRef = { model: null as BodyModelHandle | null, want: true };
  const bodyDonor = BODY_MODEL[spec.id];
  if (bodyDonor)
    attachBodyModel(exteriorG, P, bodyDonor, [pivFL, pivFR, wRL, wRR, ...glowSprites],
      (h) => { bodyRef.model = h; h?.setActive(bodyRef.want); });

  return {
    spec, carGroup, bodyG, exteriorG, cockpit, pivFL, pivFR,
    get cockpitModel() { return rigRef.model; },
    cockpitReady,
    get bodyModel() { return bodyRef.model; },
    setBodyImported(on: boolean) { bodyRef.want = on; bodyRef.model?.setActive(on); },
    wheels: [wFL, wFR, wRL, wRR],
    spotL, spotR, spreadL, spreadR, headMat, tailMat, sigMatL, sigMatR, hlGlowMat, plateGlowMat,
    beamCarpet, beamCarpetMat, beamCarpetG: carpetG,
    /* 1 cm under the visible bodyshell, matching the rule TYPE_DIM in
       traffic.ts now follows on the NPC side: the two half-widths meet in
       collidePlayer()'s OBB test, so padding either one makes a crash fire
       before the bodies touch on screen. The flanks land on |x| = W/2 exactly
       (see HULL_SKIN in carshape.ts), so W/2 - 0.005 is the visible edge less
       a hair of leeway. The door mirrors sit further out still, at W/2 + 0.09,
       and are deliberately outside the box — a mirror that passes through is
       the forgiving direction and is what folding mirrors do anyway.
       halfL keeps its pad: nose-to-tail contact has no phantom-sideswipe
       problem, and shortening it would let the nose enter a wall. */
    halfW: P.W / 2 - 0.005,
    halfL: L2 + 0.02,
    dispose(sceneRef: THREE.Scene) {
      sceneRef.remove(carGroup);
      for (const m of envMats) untrackEnvMaterial(m);
      // shared resources that must outlive this rig: the caller's textures,
      // the process-wide paint/smudge maps, and whichever env is live
      const shared = new Set<THREE.Texture>([
        envMap as any, env, glowTex, mirrorTexture, ...SHARED_TEX,
      ]);
      const texSlots = [
        "map", "emissiveMap", "roughnessMap", "metalnessMap", "normalMap",
        "alphaMap", "clearcoatNormalMap",
      ];
      carGroup.traverse((o: any) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            for (const slot of texSlots) {
              const t = m[slot];
              if (t && t.isTexture && !shared.has(t)) t.dispose();
            }
            if (m.envMap && !shared.has(m.envMap) && !isSharedEnv(m.envMap)) m.envMap = null;
            m.dispose();
          }
        }
      });
    },
  };
}
