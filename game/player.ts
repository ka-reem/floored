import * as THREE from "three";
import {
  brakeDiscGeo, carShellGeos, doorFurnitureGeos, grilleGeos, makeWheel,
  panelLineGeo, roundedBoxGeo,
} from "./carshape";
import { paintTexF, carbonTexF } from "./textures";
import { buildCockpit, COCKPIT_REF, type Cockpit } from "./cockpit";
import { attachCockpitModel, type CockpitModelHandle } from "./cockpitmodel";
import { attachBodyModel, type BodyModelHandle } from "./bodymodel";
import { donorCabinAllowed, TIER_CAPS, type RenderTier } from "./settings";

import { carEnvMap, isSharedEnv, trackEnvMaterial, untrackEnvMaterial } from "./carenv";
import { paintByHex, type CarSpec, type Paint } from "./carspecs";

/* Which donor INTERIOR to load, by CAR and then by render tier — a build stem
   under public/models/cockpits/, see tools/build-cockpit.mjs. An id that is
   not in this table, or a tier whose entry is "", drives the procedural cabin.

   TWO KEYS, because the question has two independent halves and folding them
   into one is what made the old J toggle necessary. WHICH cabin you sit in is
   a property of the car picked in the garage: the Volvo has a donor, kaze is
   procedural inside and out, and from the dashcam that is the whole difference
   between them. WHETHER the donor is affordable is a property of the device —
   and that half is no longer decided here at all, see cockpitDonor() below.

   One donor asset, not a choice of two. This used to name `volvo-s90`, a per-vertex
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

   ALL THREE TIERS NAME THE ASSET NOW, mobile-base included. It used to hold
   "", on the grounds that the tier unknown hardware falls back to could not be
   trusted with "a third of a million triangles of cabin". Two things were
   wrong with that. It was defensible only while the donor cabin was something
   a player was GIVEN — once the Volvo became a garage CHOICE, the card shows
   that interior and handing back a different one silently is handing back a
   different car. And the number it was afraid of was the wrong number:
   366,069 static triangles in 39 draws is unremarkable on a modern phone, and
   what actually costs is the 280 MB the cabin's 21 images decode to. See
   settings.ts donorCabinAffordable() for the measurement, and TierCaps
   .cabinPbrMaps / trimCabinMaps below for what mobile-base does about it —
   which is pay for less of the cabin, not refuse the cabin.

   The rows stay per-tier even though all three now agree, because that is the
   hook for the -4k desktop variant described above.

   The failure mode is unchanged and PARTIAL by design: a cabin that is refused
   or that 404s leaves the Volvo selectable, driveable and wearing its own
   exterior (BODY_MODEL is not tiered) with a procedural dash. Nothing hides
   the car and nothing forces the cabin. */
const COCKPIT_MODEL: Record<string, Record<RenderTier, string>> = {
  volvo: {
    desktop: "volvo-s90-full",
    "mobile-high": "volvo-s90-full",
    "mobile-base": "volvo-s90-full",
  },
};
/* Which cars have an imported EXTERIOR body, by spec id. Only the Volvo: the
   donor IS an S90 and that car's shell is now that car's real box, so the fit
   is very nearly an identity scale — the 3.14 m kei car is not a candidate and
   never will be. Not tiered, unlike the cabin above: it is a 0.5 MB static
   shell that only shows in the chase cameras, so there is nothing here for a
   weaker device to opt out of that hiding the exterior does not already
   handle.

   IT USED TO BE KEYED TO kaze, which is why kaze looked photoreal in chase up
   to now. Two cars cannot share one exterior and still be two cars, so the
   donor body followed the donor cabin to the car it actually belongs to, and
   kaze reverted to its generated shell — 4.42 m, wing, hood bulge, straight
   off its own ShellParams. Less photoreal, deliberately. */
const BODY_MODEL: Record<string, string> = { volvo: "volvo-s90-body-lite" };
/** True for a car whose exterior is an imported model rather than its own
 *  generated shell. The garage card asks, so it knows whether a second,
 *  real-bodywork shot of this car is worth waiting for — one reader of the
 *  table above rather than a second copy of the list in carpreview.ts. */
export const hasDonorBody = (carId: string): boolean => !!BODY_MODEL[carId];
/** The donor cabin this car wants on this device, or "" for the procedural
    one. The only place the car/tier matrix above is read: everything else asks
    the RIG whether a donor cabin is up (`rig.cockpitModel`), so there is no
    second copy of the rule to keep in step — and no way for the camera offsets
    to believe in a cabin that was never fetched.

    Two gates, in the order they are asked. The matrix is the CAR's answer and
    is static data; donorCabinAllowed() is the DEVICE's, and it is the player's
    setting first (Settings -> Imported cabin) and a hardware floor second — so
    the Volvo cabin is refused only where the device visibly cannot carry it,
    and even then the player can insist. Asked second, so a car with no donor
    never pays for the device question at all. */
const cockpitDonor = (carId: string, tier: RenderTier): string => {
  const want = COCKPIT_MODEL[carId]?.[tier] || "";
  return want && donorCabinAllowed(tier) ? want : "";
};
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

/* ------------------------------------------------- lighting the donor body ----

   "The car is still like black and really dark and hard to see. Can you make it
   brighter? And can you explain why it's like that?"

   It was black because NOTHING WAS LIGHTING IT. Not "not enough" — nothing.

   The car on screen in CHASE is the imported Volvo shell, not the procedural
   one: BODY_MODEL configures it for the Volvo and it lands switched ON. Its
   materials come straight out of the GLB, and bodymodel.ts sets exactly one
   thing on them (castShadow). In particular it never gave them an envMap, and
   there is no scene.environment in this project — the env is wired per
   material, right here, and only the PROCEDURAL body was ever wired.

   Then look at what the donor's bodywork actually is: `Car_Paint`, metalness
   1.00, roughness 0.427, clearcoat 1.00 at roughness 0.014. A material at
   metalness 1 HAS NO DIFFUSE TERM AT ALL. Ambient and hemi cannot touch it, at
   any level — raising them would light the road and the walls and leave the car
   exactly as black as it was. A metal shows one thing: what it reflects. With
   envMap null it reflects nothing, so its entire appearance came from analytic
   lights, and at night there is one of those — the sun, whose colour is lerped
   to near-black (engine.ts sunN) — plus the headlights, which point forward,
   away from a chase camera. Multiply it out and the bodywork renders at very
   near zero. Not dark. Black, by construction.

   Which is also why the night env lift did not help. CAR_ENV/setCarEnvLift is a
   multiplier on `envMapIntensity`, and it was reaching only the materials
   built in this file — the procedural body, which is HIDDEN whenever the donor
   is up. It was turned up to 3 against a car nobody was looking at.

   So: register the donor's materials the same way the procedural ones are
   registered. They pick up the world's painted cube env, the HDRI hot-swap when
   it lands, and the night lift, for free — and the lift becomes a lever that
   reaches the car instead of one that misses it. No new lights, which matters
   twice over: three cannot scope a light to one object, so a fill bright enough
   to read on the car would also raise the road, the parapets and the buildings
   that are deliberately near-black; and shader cost is being cut elsewhere in
   the tree right now, so a scene-wide light is the wrong direction. This costs
   the IBL path on one car's materials, which the procedural body already pays.

   Two guards go on with it — see the calls below. */

/** Give an imported body the env the procedural one has, plus the two guards
    that stop a metal with a mirror clearcoat blowing to white once it has
    something to reflect. `reg` is buildPlayerCar's `withEnv`: it registers for
    the HDRI swap and the night lift, and books the material for disposal. */
function lightDonorBody(
  scene: THREE.Object3D, env: THREE.Texture, reg: <T extends THREE.Material>(m: T) => T,
) {
  const seen = new Set<THREE.Material>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = mat as THREE.MeshPhysicalMaterial;
      if (!m || seen.has(m) || m.envMapIntensity === undefined) continue;
      seen.add(m);
      if (m.envMap !== env) {
        m.envMap = env;
        m.needsUpdate = true; // no-envMap -> envMap is a define change, so a recompile
      }
      /* The donor's clear coat is authored at roughness 0.014, which is a
         mirror. With nothing to reflect that was invisible; with the HDRI
         behind it, whose energy is almost all in its lamps, it would return
         them as near-pinpoints and those are what go white first. The floor is
         the procedural paint's own 0.06 — and that number is itself paired
         with an orange-peel normal map this donor does not have, so 0.06 is
         the gentlest correction that puts the donor inside the range of paint
         this game already ships. Widening the lobe spends the same energy over
         more of the panel, which is the read we actually want. */
      if (m.clearcoat > 0 && m.clearcoatRoughness < 0.06) m.clearcoatRoughness = 0.06;
      // and the soft knee, so whatever still lands hot compresses with its hue
      // intact instead of clipping to white — see tameSpecular
      tameSpecular(m);
      reg(m);
    }
  });
}

/* --------------------------------------------- the cabin's texture budget --
 *
 * Drop the donor cabin's normal and metallic-roughness maps, keeping its base
 * colour and emissive. The consumer of TierCaps.cabinPbrMaps; see that field
 * for the measurement it is spending (280 MB of decoded cabin texture down to
 * 96, on the one tier where a texture upload is as likely to be answered with
 * a lost context as with a slow frame).
 *
 * WHY THIS RATHER THAN A SECOND, SMALLER GLB. That was the obvious answer and
 * it does not fit: the cabin's geometry alone is 2.70 MB packed, against 2.71
 * MB left in the 15 MB critical-path budget, so a second cabin build is over
 * budget before a single texel is added to it. A halved-resolution variant
 * measures 3.54 MB. This buys most of the same memory back for nothing, today
 * — and tools/build-cockpit.mjs's per-role TEX_ROLE table stays the place to
 * go if the budget is ever raised, because it is tuned around what the dashcam
 * actually sees and a flat resize is not.
 *
 * BEFORE THE FIRST FRAME, which is what makes it worth doing at all. This runs
 * inside attachCockpitModel's callback, and the engine's staged load is still
 * awaiting cockpitReady at that point — three uploads a texture when it is
 * first DRAWN, so a map nulled here never reaches the GPU rather than being
 * uploaded and then freed.
 *
 * Two-pass, and the first pass is not paranoia: glTF hands the SAME texture
 * object to roughnessMap and metalnessMap, and nothing in the format stops an
 * image being shared across slots. So collect what the kept slots still need
 * before disposing anything, or a base colour can be freed out from under the
 * material still pointing at it.
 *
 * ImageBitmap.close() is the part that reaches the decode spike: the bitmap
 * holds memory outside the JS heap, and closing it hands that back now instead
 * of at whatever point the collector gets to the texture. */
const CABIN_DROP = ["normalMap", "roughnessMap", "metalnessMap"] as const;
const CABIN_KEEP = ["map", "emissiveMap", "alphaMap", "aoMap"] as const;

function trimCabinMaps(root: THREE.Object3D) {
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(m);
  });

  const keep = new Set<THREE.Texture>();
  for (const m of mats)
    for (const slot of CABIN_KEEP) {
      const t = (m as unknown as Record<string, THREE.Texture | null>)[slot];
      if (t) keep.add(t);
    }

  const dropped = new Set<THREE.Texture>();
  for (const m of mats) {
    let touched = false;
    for (const slot of CABIN_DROP) {
      const rec = m as unknown as Record<string, THREE.Texture | null>;
      const t = rec[slot];
      if (!t) continue;
      rec[slot] = null;
      touched = true;
      if (!keep.has(t)) dropped.add(t);
    }
    // nulling a map slot changes the program's defines, so the material has to
    // be recompiled — it has not been drawn yet, but say it anyway
    if (touched) m.needsUpdate = true;
  }

  for (const t of dropped) {
    const img = t.image as { close?: () => void } | null;
    t.dispose();
    t.image = null;
    try {
      if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
    } catch {
      /* already closed, or a browser that hands back an HTMLImageElement */
    }
  }
}

/* ------------------------------------------------------------- the hood ----

   "You render all the inside stuff of the car. But I don't see a hood."

   And there is one. The exterior donor (volvo-s90-body-lite.glb, already
   loaded, already resident) carries the bonnet — it is just hidden wholesale,
   because every interior camera does `exteriorG.visible = !inside`. So this
   does not build geometry: it takes a SUBSET of a buffer that is already on
   the GPU and draws it from the inside.

   WHAT WAS MEASURED, before any of it was written:

   - The donor's painted shell is ONE mesh, "Body Frame_Car Paint_0", 25,770
     triangles — gltf-transform's `join` merged the body panels by material at
     build time, so there is no node called Hood to switch on. But the hood is
     still separable, and exactly: it is a CONNECTED COMPONENT of that mesh,
     1,546 triangles, disjoint from the rest by index alone (welding
     coincident positions first changes nothing, so the split needs no
     position hashing at runtime — just union-find over the index buffer).
   - Its bounds in donor metres are HOOD_BOX below: 1.62 m across, 1.39 m long,
     top surface from 1.056 m at the cowl down to about 0.89 m at the front
     lip. That is a bonnet and nothing else — the front fenders, the fascia and
     the bumper are their own components and stay hidden.

   WHERE IT GOES, and why not simply un-hiding it in place: bodymodel.ts fits
   the donor body to the car's spec box on each axis independently, and for
   kaze that is a 0.861 SQUASH in y (donor roof 1.44 into shell roof 1.24) plus
   0.891 in z. The donor CABIN gets no such squash — cockpitmodel.ts hangs it
   at (1, sx, sx) with sx = 1 here — so the fitted hood sits ~14 cm low and
   ~20 cm back relative to the dash it belongs to, which puts it under the pad
   and out of sight, and puts its cowl somewhere inside the firewall.

   So the hood is re-hung the way the cabin is: donor coordinates, parented
   under cockpit.group with the same counter-scale. Then it cannot clip the
   dash, because in the donor's own space a car's bonnet does not intersect its
   own dashboard — the two halves are cuts of ONE model and this puts them back
   in one frame. Confirmed against the manifests rather than assumed: the
   body-lite's door-mirror component lands at x 0.801..1.005, y 1.017..1.148,
   z 0.534..0.692, which is volvo-s90-full.json's `sideMirror` bbox to three
   decimal places. Same space, same origin.

   Parenting into cockpit.group also inherits the camera rule for free, the
   way bodymodel.ts's group inherits the opposite one: engine.ts already shows
   that group only from inside and hides it for the mirror pass, so the hood
   appears in exactly the views that were missing it and nowhere else.

   COST: one draw call and 1,546 triangles while inside. No new vertex data —
   the hood geometry SHARES the source mesh's attribute buffers and owns only
   a 4,638-entry index array — and no new material, so no new shader program.
   The GLB is untouched, so the asset budget is untouched.

   WHAT IT LOOKS LIKE is the part that needs eyes. From the dashcam mount the
   hood is a SLIVER: swept against the sightline that grazes the donor pad's
   forward-top corner (y 1.072, z 1.118 in volvo-s90-full.json's `shell`), its
   crown clears that line by 2.6 cm at z 2.1 and by about 1-2 cm from z 1.7 to
   z 2.35, and falls back under it at both ends. That is roughly a 10-15 px
   band along the bottom of a 1080p frame — which is what a real dashcam
   mounted at the glass actually sees of a bonnet, but it is a fine margin and
   it moves with POV_MOUNT. Hence window.__hood: `.dy = 0.03` lifts it into
   frame, `.on = 0` takes it back out. */

/** The hood component's bounds in DONOR metres, measured off
    volvo-s90-body-lite.glb, and the target the component search matches
    against. Bounds rather than a triangle count so the search stays a
    statement about the car and not about a build's decimation. */
const HOOD_BOX = { x: 0.8094, y0: 0.7858, y1: 1.0555, z0: 0.9934, z1: 2.3869 };
/** How far off HOOD_BOX a component may be and still be the hood, in metres.
    Loose enough to survive a re-decimation moving a vertex, tight enough that
    nothing else in the shell can be mistaken for it: the closest non-hood
    component is the front fascia, and its nearest bound misses by 0.20 m —
    more than three times this. Checked over all 30 components; exactly one
    matches. */
const HOOD_TOL = 0.06;

/** Lift the donor's bonnet out of the exterior body and hang it in the cabin.
    Returns the group to parent it, or null if this donor has no hood the
    search recognises — in which case nothing is added and the interior views
    are exactly as they were. */
function attachHood(cockpit: Cockpit, donor: THREE.Object3D): THREE.Group | null {
  const box = new THREE.Box3(), v = new THREE.Vector3();
  /* Only meshes whose own donor-space bounds could CONTAIN the hood are walked
     at all, biggest first — on this asset six pass that test (the shell, the
     doors, the mirror glass, even the brake discs, all of which straddle the
     hood's band) and the shell is both the first tried and the only one that
     matches, so exactly one union-find pass actually runs.

     `m.matrix` IS the donor-space matrix: bodymodel.ts applies its fit to the
     scene ROOT and leaves the nodes alone, so a node's local transform is
     still the one the donor shipped. updateMatrix() first for the same reason
     cockpitmodel.ts calls it — a node straight off the loader has its TRS but
     has not necessarily been through a frame. */
  const cands: THREE.Mesh[] = [];
  donor.traverse((o) => {
    const m = o as THREE.Mesh;
    const geo = m.geometry as THREE.BufferGeometry;
    if (!m.isMesh || !geo?.index) return;
    m.updateMatrix();
    geo.computeBoundingBox();
    box.copy(geo.boundingBox!).applyMatrix4(m.matrix);
    if (
      box.min.x > -HOOD_BOX.x + HOOD_TOL || box.max.x < HOOD_BOX.x - HOOD_TOL ||
      box.min.y > HOOD_BOX.y0 + HOOD_TOL || box.max.y < HOOD_BOX.y1 - HOOD_TOL ||
      box.min.z > HOOD_BOX.z0 + HOOD_TOL || box.max.z < HOOD_BOX.z1 - HOOD_TOL
    ) return;
    cands.push(m);
  });
  cands.sort((a, b) => b.geometry.index!.count - a.geometry.index!.count);

  let src: THREE.Mesh | null = null;
  let hoodIdx: number[] | null = null;
  for (const m of cands) {
    hoodIdx = hoodIndices(m.geometry as THREE.BufferGeometry, m.matrix);
    if (hoodIdx) { src = m; break; }
  }
  if (!src || !hoodIdx) {
    console.warn("[player] body donor has no hood component — interior hood skipped");
    return null;
  }

  const srcGeo = src.geometry as THREE.BufferGeometry;
  /* Shares every attribute with the source mesh — same buffers, same GPU
     upload — and owns only its own index. This is what makes the hood cost a
     draw call rather than a copy of the bodyshell.

     Sharing survives dispose() below because dispose() is a whole-rig
     teardown: it traverses carGroup and disposes every geometry it finds,
     which includes both the hood's and the shell it borrows from, and three
     treats a second removal of the same attribute buffer as a no-op. Nothing
     disposes one of the pair on its own. */
  const geo = new THREE.BufferGeometry();
  for (const name of Object.keys(srcGeo.attributes))
    geo.setAttribute(name, srcGeo.attributes[name]);
  geo.setIndex(hoodIdx);
  /* Bounds computed from the hood's own vertices rather than left to
     computeBoundingSphere(), which walks the whole POSITION attribute and
     would hand the frustum test the entire bodyshell's sphere. */
  const pos = srcGeo.attributes.position;
  box.makeEmpty();
  for (const i of hoodIdx) box.expandByPoint(v.fromBufferAttribute(pos, i));
  geo.boundingBox = box.clone();
  geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());

  const mesh = new THREE.Mesh(geo, src.material);
  mesh.position.copy(src.position);
  mesh.quaternion.copy(src.quaternion);
  mesh.scale.copy(src.scale);
  /* Layer 1, like the rest of the cabin (cockpit.ts's closing traverse): it is
     what keeps the interior out of the planar road-reflection camera, which
     runs on layer 0 only. A hood left on layer 0 would print a bonnet floating
     in the tarmac with no car attached to it. */
  mesh.layers.set(1);
  /* Left OFF deliberately. The exterior body is the car's shadow caster and it
     is hidden from these cameras; a hood casting on its own would put a
     bonnet-shaped shadow on the road under a car with no other shadow. */
  mesh.castShadow = false;

  /* The donor-space frame, inside the cabin's. cockpit.group carries a
     non-uniform (sx, 1, 1) so procedural trim fits each car's width; the
     counter-scale turns that into a uniform sx, exactly as cockpitmodel.ts
     does for the donor dash — read once here rather than per frame because
     player.ts has already set the parent's scale by the time a donor lands. */
  const space = new THREE.Group();
  space.scale.set(1, cockpit.group.scale.x, cockpit.group.scale.x);
  space.add(mesh);
  space.visible = false; // engine.ts owns it — hoodUpdate(), once a donor cabin is up
  cockpit.group.add(space);
  return space;
}

/** Union-find over `geo`'s index buffer, returning the indices of the one
    connected component that matches HOOD_BOX — or null if none does. No
    position welding: the hood is already disjoint by index on this asset
    (verified against a welded pass, which finds the identical 1,546-triangle
    component), so this is one linear walk of 26k triangles at load and no
    hashing of 13k positions. */
function hoodIndices(geo: THREE.BufferGeometry, mat: THREE.Matrix4): number[] | null {
  const idx = geo.index!;
  const n = geo.attributes.position.count;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const uni = (a: number, b: number) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  const nTri = idx.count / 3;
  for (let t = 0; t < nTri; t++) {
    const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2);
    uni(a, b); uni(b, c);
  }
  // one bbox per component, in donor space
  const pos = geo.attributes.position;
  const boxes = new Map<number, THREE.Box3>();
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let b = boxes.get(r);
    if (!b) boxes.set(r, (b = new THREE.Box3().makeEmpty()));
    b.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(mat));
  }
  let hit = -1;
  for (const [r, b] of boxes) {
    if (
      Math.abs(b.min.x + HOOD_BOX.x) > HOOD_TOL || Math.abs(b.max.x - HOOD_BOX.x) > HOOD_TOL ||
      Math.abs(b.min.y - HOOD_BOX.y0) > HOOD_TOL || Math.abs(b.max.y - HOOD_BOX.y1) > HOOD_TOL ||
      Math.abs(b.min.z - HOOD_BOX.z0) > HOOD_TOL || Math.abs(b.max.z - HOOD_BOX.z1) > HOOD_TOL
    ) continue;
    hit = r;
    break;
  }
  if (hit < 0) return null;
  const out: number[] = [];
  for (let t = 0; t < nTri; t++) {
    const a = idx.getX(t * 3);
    if (find(a) !== hit) continue;
    out.push(a, idx.getX(t * 3 + 1), idx.getX(t * 3 + 2));
  }
  return out.length ? out : null;
}

export interface PlayerRig {
  spec: CarSpec;
  carGroup: THREE.Group;
  bodyG: THREE.Group;
  exteriorG: THREE.Group;
  cockpit: Cockpit;
  /** The imported dash once it has loaded, else null. Null is the normal
      steady state when this car configures no donor, when this tier configures
      none for it, or when the fetch failed — and it is also engine.ts's ONE
      test for "is the donor cabin the cabin on screen", which is why the
      car/tier matrix does not have to be re-read anywhere else. */
  readonly cockpitModel: CockpitModelHandle | null;
  /** Settles once the donor dash has landed or been given up on; already
      settled on a tier that configures no donor. Never rejects. */
  readonly cockpitReady: Promise<void>;
  /** The imported exterior body once it has loaded, else null — null is the
      normal steady state for every car but the Volvo, and for a failed fetch.
      It shows itself when it lands and is never switched off again; the car it
      belongs to cannot change without this whole rig being rebuilt. */
  readonly bodyModel: BodyModelHandle | null;
  /** Settles once the donor body has landed or been given up on; already
      settled on a car that has none. Never rejects. The game waits on nothing
      here — see the build — but the garage card does. */
  readonly bodyReady: Promise<void>;
  /** The donor's HOOD, lifted out of the exterior body and re-hung inside the
      cabin so the interior cameras can see it — null until the body donor has
      landed, and on any car that has no body donor. A group in donor space;
      engine.ts owns its `visible` and the window.__hood nudge. See
      attachHood(). */
  readonly hood: THREE.Group | null;
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

/** Per-BUILD opt-outs from the two donor fetches, for callers that are not the
 *  game. Both default to whatever the car and the device say, so the engine
 *  passes nothing and behaves exactly as before.
 *
 *  This exists because the garage preview used to opt out of the donor cabin
 *  by asking for tier "mobile-base" and relying on that row being empty — an
 *  aside in one table, three files away, that quietly stopped being true the
 *  moment mobile-base was given the cabin. A card that wants a procedural
 *  interior should say so. */
export interface BuildOpts {
  /** false: never fetch the donor INTERIOR, whatever the car/tier/setting say */
  cabin?: boolean;
  /** false: never fetch the donor EXTERIOR body */
  body?: boolean;
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
  tier: RenderTier = "desktop",
  opts: BuildOpts = {}
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
  const donor = opts.cabin === false ? "" : cockpitDonor(spec.id, tier);
  /* Settled when the donor question is answered — landed, failed, or never
     asked. The staged load in engine.ts waits on this (with a budget) so the
     dash is already fitted on the first frame the player sees: the dashcam POV
     is the view the game is played in, and a dash that swaps under them a
     second into the drive is the one asset pop worth paying for up front.
     Resolves rather than rejects on failure — attachCockpitModel's callback
     runs either way, and a missing donor is a normal steady state. */
  let dashDone!: () => void;
  const cockpitReady = new Promise<void>((res) => { dashDone = res; });
  if (donor)
    attachCockpitModel(cockpit, donor, (h) => {
      rigRef.model = h;
      /* Before dashDone(), so the load is still holding the first frame back
         when the maps go — see trimCabinMaps for why that timing is the whole
         point. Its own try/catch: a cabin with one unexpected material is
         still a cabin, and losing it over a texture slot would be absurd. */
      if (h && TIER_CAPS[tier].cabinPbrMaps === false)
        try {
          trimCabinMaps(h.group);
        } catch (e) {
          console.warn("[player] cabin texture trim skipped", e);
        }
      dashDone();
    });
  else dashDone();

  /* Imported exterior body, if this car has one. Same fire-and-forget shape as
     the dash above, and the same fallback rule. Nothing waits on this one — it
     is invisible in the POV the game is played in, so there is no pop worth
     paying for.

     No desired-state latch any more. There used to be a `want` flag here to
     close a race against the J key: the body could land AFTER the player had
     toggled back to the procedural car, and a handle that switched itself on
     at that point would put a Volvo body under a procedural dash. J is retired
     and the exterior now follows the car that was picked — a choice made
     before this rig exists and unchangeable without rebuilding it (engine.ts
     setCar) — so there is no window left to land in the wrong state, and
     bodymodel.ts's own setActive(true) is the whole of the answer. */
  const bodyRef = {
    model: null as BodyModelHandle | null,
    hood: null as THREE.Group | null,
  };
  /* Settled when the body question is answered — landed, failed, or never
     asked. The GAME still waits on nothing (see above); this is for the garage
     card, which has to know when the shot it is about to read back is the one
     worth keeping. Never rejects, same contract as cockpitReady. */
  let bodyDone!: () => void;
  const bodyReady = new Promise<void>((res) => { bodyDone = res; });
  const bodyDonor = opts.body === false ? undefined : BODY_MODEL[spec.id];
  if (!bodyDonor) bodyDone();
  else
    attachBodyModel(exteriorG, P, bodyDonor, [pivFL, pivFR, wRL, wRR, ...glowSprites],
      (h) => {
        bodyRef.model = h;
        if (h) lightDonorBody(h.group, env, withEnv);
        /* Its own try/catch, and not for tidiness: bodymodel.ts runs this
           callback inside one of its own, and a throw from here would be
           caught THERE and answered by calling this callback a second time
           with null — a hood that failed to split would silently disown the
           body that had just loaded fine. The car matters, the hood does
           not. */
        if (h)
          try {
            bodyRef.hood = attachHood(cockpit, h.group);
          } catch (e) {
            console.warn("[player] interior hood skipped", e);
          }
        /* Last, so a card that renders on this signal renders a rig whose
           donor is already lit and fitted rather than one mid-wiring. */
        bodyDone();
      });

  return {
    spec, carGroup, bodyG, exteriorG, cockpit, pivFL, pivFR,
    get hood() { return bodyRef.hood; },
    get cockpitModel() { return rigRef.model; },
    cockpitReady,
    get bodyModel() { return bodyRef.model; },
    bodyReady,
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
