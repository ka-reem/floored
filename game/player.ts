import * as THREE from "three";
import {
  brakeDiscGeo, carShellGeos, doorFurnitureGeos, grilleGeos, makeWheel,
  panelLineGeo, roundedBoxGeo,
} from "./carshape";
import { paintTexF, carbonTexF } from "./textures";
import { buildCockpit, COCKPIT_REF, type Cockpit } from "./cockpit";
import { carEnvMap, isSharedEnv, trackEnvMaterial, untrackEnvMaterial } from "./carenv";
import { paintByHex, type CarSpec, type Paint } from "./carspecs";

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
  pivFL: THREE.Group;
  pivFR: THREE.Group;
  wheels: THREE.Group[];
  spotL: THREE.SpotLight;
  spotR: THREE.SpotLight;
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
  mirrorTexture: THREE.Texture
): PlayerRig {
  const P = spec.shell;
  const L2 = P.L / 2;
  const carGroup = new THREE.Group();
  scene.add(carGroup);
  const bodyG = new THREE.Group();
  carGroup.add(bodyG);
  const exteriorG = new THREE.Group(), lampsG = new THREE.Group();
  bodyG.add(exteriorG);
  carGroup.add(lampsG);

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
  for (const s of [-1, 1]) {
    const sp = new THREE.Sprite(hlGlowMat);
    sp.scale.set(0.85, 0.85, 1);
    sp.position.set(s * hlX, hlY, L2 + 0.24);
    exteriorG.add(sp);
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
  }
  const spotL = new THREE.SpotLight(0xdfe9ff, 0, 115, 0.46, 0.42, 1.2);
  const spotR = new THREE.SpotLight(0xdfe9ff, 0, 115, 0.46, 0.42, 1.2);
  spotL.position.set(-hlX, P.nose, L2 - 0.05);
  spotR.position.set(hlX, P.nose, L2 - 0.05);
  const tgtL = new THREE.Object3D(), tgtR = new THREE.Object3D();
  tgtL.position.set(-1.4, -0.4, 26);
  tgtR.position.set(1.4, -0.4, 26);
  lampsG.add(spotL, tgtL, spotR, tgtR);
  spotL.target = tgtL;
  spotR.target = tgtR;

  /* cockpit */
  const cockpit = buildCockpit(spec.cockpitAccent, mirrorTexture, spec.id);
  cockpit.group.position.y = P.belt - COCKPIT_REF.belt;
  cockpit.group.scale.x = P.W / COCKPIT_REF.W;
  bodyG.add(cockpit.group);

  return {
    spec, carGroup, bodyG, exteriorG, cockpit, pivFL, pivFR,
    wheels: [wFL, wFR, wRL, wRR],
    spotL, spotR, headMat, tailMat, sigMatL, sigMatR, hlGlowMat, plateGlowMat,
    halfW: P.W / 2 + 0.02,
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
