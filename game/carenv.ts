import * as THREE from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";

/* Real-world environment lighting for the car bodywork.

   The world ships a hand-painted cube env (mats.ts `envMap`) that works but
   reads as a gradient rather than a city. When an equirect HDRI is present on
   disk we prefilter it (PMREM) and hot-swap it into every registered car
   material; when it is absent — or fails to load — the painted cube stays and
   nothing else changes. Nothing here blocks the first frame: the swap lands a
   few hundred ms in, mid-menu.

   Only materials whose `envMap` is still the exact fallback texture that was
   handed to `primeCarEnv` get swapped. That keeps the PMREM render target,
   which belongs to the game renderer's GL context, away from the garage
   preview renderer, which builds its own cube env in its own context. */

/** Tried in order; the first that exists wins. To override with a purpose-shot
 *  city panorama, add its path at the head of this list; the CC0 street HDRIs
 *  below live in the tree today (see ATTRIBUTIONS.md).
 *
 *  cobblestone_street_night leads because it is the far punchier of the two:
 *  75% of its light arrives from the brightest 0.1% of its pixels (the street
 *  lamps) against 6% for modern_evening_street, whose light is a broad evening
 *  sky. Concentrated sources are the whole point here — they are what draws a
 *  moving streak across a clearcoated wing; a diffuse sky would land as
 *  another smooth gradient, which is what the painted cube already gives us. */
const HDRI_URLS = [
  "/hdri/cobblestone_street_night_2k.hdr",
  "/hdri/modern_evening_street_2k.hdr",
];

/* Mean linear luminance of the painted cube env in mats.ts — its faces are
   flat gradients between #2a3560/#0c1020 (top) and #151a30/#05060c (sides),
   sampled without an sRGB decode, which averages out to this. Every
   envMapIntensity on the car was tuned against it.

   A real HDRI carries several times that energy, so swapping one in raw would
   light the bodywork far brighter than the world around it — which still uses
   the cube. The HDRI is therefore rescaled to the same mean, and the win shows
   up as structure rather than brightness: even at matched energy its lamps are
   thousands of times peakier than anything the cube can produce, which is
   exactly what makes a highlight travel across a panel. That peak is also why
   the specular knee in player.ts matters more once this lands. */
const CUBE_MEAN_LUM = 0.076;

let hdrEnv: THREE.Texture | null = null;
/** the fallback the game renderer registered; only these get replaced */
let baseEnv: THREE.Texture | null = null;
/** multiplier that brings the HDRI back to the cube env's energy */
let envScale = 1;
/** Night lift, driven from engine.ts — see setCarEnvLift. Separate from
 *  envScale on purpose: envScale is a NORMALISATION (it makes the HDRI swap a
 *  structure change and not a brightness change, which is the contract the
 *  CUBE_MEAN_LUM note above describes) and must keep meaning that whatever the
 *  clock says. This is the deliberate departure from it. */
let lift = 1;
let started = false;

type EnvMat = THREE.Material & { envMap: THREE.Texture | null; envMapIntensity: number };
const tracked = new Set<EnvMat>();

/** True for a material pointing at the GAME's env. The garage preview builds
 *  its own cube in its own GL context and registers here too — it must not be
 *  swapped (that is the PMREM-across-contexts hazard in the header) and it must
 *  not be lifted either: the preview is a lit studio turntable with no clock,
 *  so a night term would just dim it for no reason. */
const isGameEnv = (m: EnvMat) => m.envMap === hdrEnv || m.envMap === baseEnv;

/** The authored intensity is stashed on first sight, so neither the HDRI swap
 *  nor a change of lift ever compounds on the previous one. */
function writeIntensity(m: EnvMat) {
  if (m.userData.baseEnvIntensity === undefined)
    m.userData.baseEnvIntensity = m.envMapIntensity ?? 1;
  const base = m.userData.baseEnvIntensity as number;
  m.envMapIntensity = base * (m.envMap === hdrEnv ? envScale : 1) * lift;
}

/** Point one material at whichever env is live, at the matching intensity. */
function applyTo(m: EnvMat) {
  if (hdrEnv && m.envMap !== hdrEnv) {
    m.envMap = hdrEnv;
    m.needsUpdate = true; // cube -> CubeUV mapping is a shader recompile
  }
  writeIntensity(m);
}

/** Scale what the car's bodywork reflects, on top of the HDRI normalisation.
 *
 *  This exists because nothing in the world actually lights the player's car at
 *  night. The street lamps are painted (emissive strips and ground decals, not
 *  lights), the headlights point away from it, and the night ambient and hemi
 *  are floored at 0.07 / 0.05 against near-black colours precisely so an unlit
 *  wall stays a silhouette. That leaves the env as the ONLY channel with any
 *  energy in it, and the env is normalised to a hand-painted cube whose mean
 *  luminance is 0.076 — which was a fine match for a scene whose night fog was
 *  0x03040a, and is roughly a tenth of what the same scene reads at now that
 *  the fog is 0x565550. The bodywork did not get darker; everything behind it
 *  got brighter, so it turned into a cutout.
 *
 *  A lift rather than a new light because a three light cannot be scoped to one
 *  object — it applies to every mesh the camera draws — and the road, the
 *  parapets and the buildings are all deliberately near-black at night. This
 *  touches the player's exterior and nothing else in the world.
 *
 *  Structure, not just level: the shipped HDRI puts 75% of its energy in the
 *  brightest 0.1% of its pixels (the lamps), so lifting it walks highlights
 *  along the shoulder line as the car passes them rather than raising a flat
 *  wash. That is the part the fog lift cannot do for it.
 *
 *  engine.ts fades this in and out on the clock — it is never switched. */
export function setCarEnvLift(k: number) {
  if (Math.abs(k - lift) < 0.002) return;
  lift = k;
  for (const m of tracked) if (isGameEnv(m)) writeIntensity(m);
}

/** Mean linear luminance of an RGBA float image. */
function meanLuminance(data: ArrayLike<number>, n: number) {
  let sum = 0;
  for (let i = 0; i < n; i++)
    sum += 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  return sum / n;
}

async function firstAvailable(): Promise<string | null> {
  for (const url of HDRI_URLS) {
    try {
      const r = await fetch(url, { method: "HEAD" });
      // a dev-server 404 page answers 200 with HTML, so check the type too
      if (!r.ok) continue;
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("text/html")) continue;
      return url;
    } catch {
      /* offline / blocked — try the next candidate */
    }
  }
  return null;
}

function applyEnv(tex: THREE.Texture, scale: number) {
  hdrEnv = tex;
  envScale = scale;
  for (const m of tracked) if (m.envMap === baseEnv) applyTo(m);
}

/** Kick off the HDRI load for `renderer`, replacing `fallback` when it lands. */
export function primeCarEnv(renderer: THREE.WebGLRenderer, fallback: THREE.Texture) {
  if (started) return;
  started = true;
  baseEnv = fallback;
  void (async () => {
    const url = await firstAvailable();
    if (!url) return;
    let raw: THREE.DataTexture;
    try {
      // full float rather than the loader's default half: the pixels are read
      // back below to measure the panorama's energy
      raw = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(url);
    } catch {
      return;
    }
    raw.mapping = THREE.EquirectangularReflectionMapping;
    const img = raw.image as { data: Float32Array; width: number; height: number };
    const mean = meanLuminance(img.data, img.width * img.height);
    const scale = mean > 1e-5 ? CUBE_MEAN_LUM / mean : 1;
    const pmrem = new THREE.PMREMGenerator(renderer);
    try {
      const rt = pmrem.fromEquirectangular(raw);
      applyEnv(rt.texture, scale);
    } catch {
      /* context lost mid-load; keep the painted cube */
    } finally {
      pmrem.dispose();
      raw.dispose();
    }
  })();
}

/** Follow `mat`'s env slot; call `untrackEnvMaterial` when the mesh dies. */
export function trackEnvMaterial(mat: THREE.Material) {
  const m = mat as EnvMat;
  tracked.add(m);
  /* Not gated on hdrEnv any more: with no HDRI on disk applyTo only writes the
     intensity, and a rig built after the clock had already run needs the lift
     applying whether or not the swap ever happened. */
  if (isGameEnv(m)) applyTo(m);
}

export function untrackEnvMaterial(mat: THREE.Material) {
  tracked.delete(mat as EnvMat);
}

/** The env a car material should be built with, given the world's fallback. */
export function carEnvMap(fallback: THREE.Texture): THREE.Texture {
  return hdrEnv && baseEnv === fallback ? hdrEnv : fallback;
}

/** True for env textures that outlive any single car rig. */
export function isSharedEnv(tex: THREE.Texture): boolean {
  return tex === hdrEnv || tex === baseEnv;
}
