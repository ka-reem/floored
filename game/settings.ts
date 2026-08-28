import { DEFAULT_CAR_ID, isPlayableCar } from "./carspecs";

export type SpeedUnits = "mph" | "kmh";
export type FogLevel = "off" | "light" | "medium" | "heavy";

/* ---------------- render tier ----------------
 *
 * A device tier derived once from what the hardware *is*, as opposed to
 * perfMode, which reacts to what the frame times *do*. The two stack: the tier
 * sets the starting quality ceiling, and the auto perf drop still fires on top
 * of it if the device underdelivers anyway.
 */
export type RenderTier = "mobile-base" | "mobile-high" | "desktop";
/** Persisted manual override; "auto" defers to detection. */
export type TierOverride = RenderTier | "auto";

const isRenderTier = (v: unknown): v is RenderTier =>
  v === "mobile-base" || v === "mobile-high" || v === "desktop";

/** Per-tier caps on EXISTING quality levers — the tier never invents a new
 *  rendering feature, it only decides which of the levers the engine already
 *  has are worth paying for on this class of device. User settings can still
 *  turn any of these off; the caps only ever gate them further down. */
export interface TierCaps {
  tier: RenderTier;
  /** hard ceiling on renderer pixel ratio (presets may lower it further) */
  dprCap: number;
  /** scanned-road PBR detail layers (mats.setPbrDetail / deferred fetch) */
  pbrDetail: boolean;
  /** headlight lateral fill cones (engine weather()) */
  spreadCones: boolean;
  /** fence overdraw passes — no consumer yet; the fence lane gates on this */
  fenceOverdraw: boolean;
  /** multiplier on settings.drawDist for town chunk culling */
  drawDistScale: number;
  /** cockpit/POV mirror RT at half resolution (160x64 instead of 320x128) */
  mirrorHalf: boolean;
  /** planar road-reflection RT may be rendered into at all */
  reflections: boolean;
  /** frame-blend motion blur allowed */
  mblur: boolean;
  /** dashcam degrade passes (V-key grade + POV evidence-footage chain) */
  dashcam: boolean;
  /** two-scale bloom: tight quarter-res core + wide eighth-res halo
      (post.ts). Off ⇒ the original single-chain bloom, untouched. */
  dualBloom?: boolean;
  /** desktop film-look finishers — fine grain / extra vignette / edge CA /
      black toe — each individually killable via post.ts's FILM_* flags. */
  filmLook?: boolean;
  /* bloom is deliberately absent: it stays on for every tier. */

  /* -- world-dressing caps (Lane H). Consumed at world-BUILD time by
        game/world/{highway,sky,townmesh,decals}.ts via worldTierCaps(); the
        FX_* constants in those files remain the master kill-switches, these
        only gate further down. All optional so older saved caps objects and
        the other lanes' TIER_CAPS edits merge cleanly. -- */
  /** fake volumetric cones under the streetlight heads (pure overdraw) */
  lampCones?: boolean;
  /** emit a cone under every Nth lamp only (1 = all of them) */
  lampConeEvery?: number;
  /** procedural jet fans under the tunnel crown (3 instanced draws) */
  jetFans?: boolean;
  /** gantry catwalk decking + floodlight fittings */
  catwalks?: boolean;
  /** photoscan GLB props (toll barriers/floodlights, ~2 MB async download);
      false swaps in cheap procedural stand-ins — colliders are identical */
  propModels?: boolean;
  /** toll canopy underside troffers + glow points */
  tollGlow?: boolean;
  /** distant-city point-cloud rings in sky.ts, 0..3 (3 = full depth stack) */
  cityRings?: number;
  /** road-realism decal overlays: cracks, oil, covers, wall streaks */
  roadDecals?: boolean;
  /** sodium ground pool under every Nth deck streetlight (1 = all) */
  lampPoolEvery?: number;
  /** emit every Nth TOWN streetlamp into the glow-point cloud (1 = all).
      Deck lamps are never thinned by this — see townmesh.ts. Halves the
      point count feeding the horizon stack on the tier that lags most;
      safe to thin because the streetlight placement loop consumes no rng
      calls per lamp, so skipping some doesn't reseed the town layout. */
  lampGlowEvery?: number;
  /** window InstancedMeshes cast shadows (townmesh.ts). Town shadows fall
      from a ~170 m shadow box the deck never sees from the dashcam, so the
      two mobile tiers buy back the shader recompile + shadow-pass cost. */
  townCastShadow?: boolean;
  /** obstruction-light glow points on the crossing overpass (highway.ts
      buildOverpass) — the box-girder/pier geometry itself stays on every
      tier (three draw calls total, not worth gating), only the additive
      points are capped, same as lampCones */
  overpassLights?: boolean;
  /** lane-following tyre-polish ribbons on the deck (deckdetail.ts). One
      draw call, but roughly a third of the deck's pixels gain one blended
      overlay layer — a fill cost, priced like the decal overlays above. */
  wheelTracks?: boolean;
  /** density scalar for the procedural deck-dressing scatter (patch slabs,
      skid arcs, gutter grates — deckdetail.ts); 0 disables the families.
      A LEVEL rather than a boolean: unlike the JPG decals these cost no
      fetch, so mobile-base keeps a thin scatter instead of a bare deck. */
  deckDressing?: number;

  /** Density level (0..1) for the second-pass roadside districts (scenery.ts
      FX_DISTRICTS: near wharf, eastside skyline, foreground industry, neon
      canyon). A LEVEL like deckDressing: the geometry is merged/instanced so
      the cost is mostly overdraw from the extra lit windows and glow points,
      and mobile-base keeps a thinned version of the same lap rather than the
      bare parapet the BEFORE contact sheet diagnosed. 0 disables. */
  districts?: number;

  /** Procedural concrete decimetre detail on parapets, deck fascia and the
      tunnel crown — the grit atlas fetch plus the surface-gradient normal
      perturbation it and the contraction joints drive (mats.weatherSurface).
      Unlike every other cap here this is a LEVEL, not a boolean, because the
      two halves have very different prices:

        1    grit fetch + relief. What desktop ships.
        0.5  grit fetch, no relief. Drops the whole Mikkelsen gradient block
             — 4 derivative ops, two cross products and a normalize on every
             concrete fragment — while keeping the albedo variation, which is
             what actually stops the wall reading as a flat card.
        0    neither. One uniform branch skips the texture fetch too.

      Read once at world-build time by mats.ts, which seeds uGritK/uReliefK
      from it; `window.__wall.detail` overrides both live, no reload. */
  wallDetail?: number;

  /** Edge length of the procedural expressway-deck asphalt canvas
      (highway.ts). Its own cap rather than a rider on wallDetail, because it
      buys back a different resource: wallDetail is ALU on the parapets, this
      is texture BANDWIDTH on the road. textures.makeTex sets anisotropy 16 on
      everything, and a road seen from a dashcam is the most grazing surface in
      the frame — the geometry that makes the sampler take all sixteen taps. At
      1024 the map plus mips is ~5.5 MB and those taps miss cache; at 256 they
      do not. Desktop 1024, mobile-high 512, mobile-base 256. Read at
      world-build time, so it needs a reload to change. */
  deckTexPx?: number;

  /** Keep the donor cabin's NORMAL and METALLIC-ROUGHNESS maps. Its base
      colour and emissive are never touched by this — the cabin is always the
      real cabin, this only decides how much of its surface detail is paid for.
      The sibling of pbrDetail above, for the interior instead of the road, and
      it buys back the same resource for the same reason.

      MEASURED, on the shipped volvo-s90-full.glb (21 images, per-role budget:
      three 2048 sets at arm's reach, two 1536, one 1024, one 512):

        all maps            280 MB decoded RGBA8 + mips
        base colour only     96 MB

      So the two PBR map families are 184 MB of the 280 — two thirds of the
      cabin's texture memory for detail that mobile-base already declines
      everywhere else it appears (pbrDetail false, wallDetail 0, deckTexPx
      256), on the one tier whose devices are most likely to answer a texture
      upload with a lost context rather than a slow frame. The night grade and
      the dashcam softening pass take most of what is being given up before it
      reaches the player anyway.

      Read once, when the donor lands (player.ts). Nothing re-reads it, so a
      tier bumped mid-session applies on the next rig build. */
  cabinPbrMaps?: boolean;
}

export const TIER_CAPS: Record<RenderTier, TierCaps> = {
  "mobile-base": {
    tier: "mobile-base", dprCap: 1.1, pbrDetail: false, spreadCones: false,
    fenceOverdraw: false, drawDistScale: 0.65, mirrorHalf: true,
    // dashcam stays ON for every tier — the POV filter is core to the game's
    // look (user call); mblur (chase-cam motion blur) remains the perf cut.
    reflections: false, mblur: false, dashcam: true,
    dualBloom: false, filmLook: false,
    lampCones: false, lampConeEvery: 2, jetFans: false, catwalks: false,
    propModels: false, tollGlow: true, cityRings: 2, roadDecals: false,
    lampPoolEvery: 2, wallDetail: 0, deckTexPx: 256, cabinPbrMaps: false,
    lampGlowEvery: 2, townCastShadow: false, overpassLights: false,
    wheelTracks: false, deckDressing: 0.35, districts: 0.55,
  },
  "mobile-high": {
    tier: "mobile-high", dprCap: 1.35, pbrDetail: true, spreadCones: true,
    fenceOverdraw: true, drawDistScale: 0.85, mirrorHalf: true,
    reflections: false, mblur: false, dashcam: true,
    dualBloom: false, filmLook: false,
    lampCones: true, lampConeEvery: 2, jetFans: true, catwalks: true,
    propModels: true, tollGlow: true, cityRings: 3, roadDecals: true,
    lampPoolEvery: 1, wallDetail: 0.5, deckTexPx: 512, cabinPbrMaps: true,
    lampGlowEvery: 1, townCastShadow: false, overpassLights: true,
    wheelTracks: true, deckDressing: 0.7, districts: 0.8,
  },
  desktop: {
    tier: "desktop", dprCap: 1.75, pbrDetail: true, spreadCones: true,
    fenceOverdraw: true, drawDistScale: 1, mirrorHalf: false,
    reflections: true, mblur: true, dashcam: true,
    dualBloom: true, filmLook: true,
    lampCones: true, lampConeEvery: 1, jetFans: true, catwalks: true,
    propModels: true, tollGlow: true, cityRings: 3, roadDecals: true,
    lampPoolEvery: 1, wallDetail: 1, deckTexPx: 1024, cabinPbrMaps: true,
    lampGlowEvery: 1, townCastShadow: true, overpassLights: true,
    wheelTracks: true, deckDressing: 1, districts: 1,
  },
};

/** Conservative device sniff: touch + devicePixelRatio + the
 *  WEBGL_debug_renderer_info renderer string. "Conservative" means every
 *  unknown lands on mobile-base — a flagship misread as base is a visual
 *  downgrade, a budget phone misread as high is an unplayable frame rate.
 *
 *  Buckets (renderer strings as observed in the wild):
 *  - non-touch → desktop (a touchscreen laptop's primary pointer is still
 *    fine, so matchMedia("(pointer:coarse)") keeps it here).
 *  - touch with dpr < 2 → mobile-base outright: every recent flagship ships
 *    at 2.6+, so a low ratio means old or budget hardware.
 *  - Adreno ("Adreno (TM) 740"): 730+ (Snapdragon 8 Gen 1 era) → high.
 *  - ARM Mali ("Mali-G715"): G710+ → high; "Immortalis" is the flagship
 *    branding above those → high.
 *  - Samsung Xclipse (RDNA2, S22+) → high.
 *  - Apple: explicit "Apple A15"+ or any M-series → high. iOS Safari masks
 *    the string to plain "Apple GPU", so that case falls back to dpr: the
 *    3x-screen phones (Pro/Plus bodies) → high, 2x (SE, older, iPads that
 *    slipped past the M check) → base.
 *  - anything else (PowerVR, unknown, sniff blocked) → base.
 */
export function detectRenderTier(
  isTouch: boolean,
  gl?: WebGLRenderingContext | WebGL2RenderingContext | null
): RenderTier {
  if (!isTouch) return "desktop";
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  if (dpr < 2) return "mobile-base";
  let r = "";
  try {
    let ctx = gl ?? undefined;
    if (!ctx) {
      const cv = document.createElement("canvas");
      ctx = (cv.getContext("webgl2") || cv.getContext("webgl")) as
        | WebGLRenderingContext
        | WebGL2RenderingContext
        | undefined;
    }
    if (ctx) {
      const ext = ctx.getExtension("WEBGL_debug_renderer_info");
      r = String(ctx.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : ctx.RENDERER) ?? "");
    }
  } catch {
    /* sniff blocked ⇒ unknown GPU ⇒ base */
  }
  const s = r.toLowerCase();
  const adreno = s.match(/adreno[^0-9]*(\d{3,4})/);
  if (adreno) return +adreno[1] >= 730 ? "mobile-high" : "mobile-base";
  if (/immortalis/.test(s)) return "mobile-high";
  const mali = s.match(/mali-g(\d+)/);
  if (mali) return +mali[1] >= 710 ? "mobile-high" : "mobile-base";
  if (/xclipse/.test(s)) return "mobile-high";
  const appleA = s.match(/apple a(\d+)/);
  if (appleA) return +appleA[1] >= 15 ? "mobile-high" : "mobile-base";
  if (/apple m\d/.test(s)) return "mobile-high";
  if (/apple/.test(s)) return dpr >= 3 ? "mobile-high" : "mobile-base";
  return "mobile-base";
}

/* ---------------- the imported cabin ----------------
 *
 * WHICH cabin a car has is the car's business (player.ts COCKPIT_MODEL);
 * WHETHER this device can carry it is the device's, and that half lives here.
 *
 * It used to be answered by the render tier alone — mobile-base got no donor
 * dash, full stop. That was right while the donor cabin was something a player
 * was GIVEN: nobody had asked for it, so quietly not paying for it cost them
 * nothing they knew about. It stopped being right when the Volvo became a
 * garage CHOICE. Picking the car off the shelf and being handed a procedural
 * interior is being given a different car than the one on the card, and the
 * tier that produces it is the one every UNKNOWN device falls back to — an
 * iPhone whose GPU string Safari masks lands there on nothing worse than a
 * 2x screen (see detectRenderTier's Apple note).
 *
 * So the default flips: a chosen donor cabin loads on every tier EXCEPT a
 * device that fails the floor below, and the player can override either way.
 */
export type CabinMode = "auto" | "donor" | "procedural";

const isCabinMode = (v: unknown): v is CabinMode =>
  v === "auto" || v === "donor" || v === "procedural";

/** Hardware floor for carrying a donor cabin on the fallback tier.
 *
 *  WHAT THIS IS GUARDING, measured rather than assumed. The triangle count is
 *  the wrong number to be afraid of and this used to lean on it: 366,069
 *  static triangles in 39 draws is unremarkable for any phone of the last few
 *  years, and it is already an 89% decimation of the 3.27M donor. Triangles do
 *  not kill mobile — memory, overdraw and draw calls do.
 *
 *  The number that matters is TEXTURE MEMORY. The cabin's 21 images decode to
 *  210 MB of RGBA8, 280 MB once three generates mipmaps, on top of the world's
 *  own atlases. cabinPbrMaps above takes 184 MB of that back on this very
 *  tier, which leaves 96 MB steady-state — defensible, and the reason the
 *  cabin is no longer withheld outright.
 *
 *  What this floor still guards is the part the trim cannot reach: every one
 *  of those 21 images is DECODED at full size while the GLB is parsed, before
 *  any material has been touched, so the load spikes through ~210 MB of
 *  decoded image whatever the tier does with it afterwards. On a device with
 *  little memory to spare that spike is answered with a lost GL context or a
 *  killed tab — a black screen, which is a worse failure than a slow one.
 *
 *  Deliberately NOT another GPU-string sniff. The string is the thing that is
 *  already lying (iOS Safari masks it), and dpr is the poor proxy that lie
 *  forced us onto. These signals are about the DEVICE's memory rather than its
 *  renderer, which is the resource in question, and they fail in the safe
 *  direction:
 *
 *  - `deviceMemory` is the sharpest one, and it is almost perfectly targeted:
 *    Chrome on Android reports it, Safari does not. So the budget Android with
 *    an unrecognised GPU — the case the conservative tier actually exists to
 *    protect — is excluded on its RAM, and the masked iPhone, which reports
 *    nothing, falls through and gets its cabin. The value is rounded down to a
 *    power of two by spec, so `< 4` means "3 GB or less" — a device that would
 *    be spending a fifteenth of its total RAM on one transient image decode.
 *  - `hardwareConcurrency < 4` is a backstop for the same class of device on
 *    a browser that withholds the memory hint.
 *  - `devicePixelRatio < 2` is the bucket detectRenderTier already calls "old
 *    or budget hardware" outright, kept in agreement with it.
 *  - Data Saver is honoured because 5.7 MB on a metered connection is the
 *    user's money, not a frame-rate question.
 *
 *  Anything else passes. That is the deliberate inversion of the tier's own
 *  "every unknown lands on base" — for ONE opt-in asset on a car the player
 *  went and picked, with a setting to turn it off, an unknown device is given
 *  the benefit of the doubt. */
let cabinFloor: boolean | null = null;
export function donorCabinAffordable(): boolean {
  if (cabinFloor !== null) return cabinFloor;
  let ok = true;
  try {
    const nav = navigator as Navigator & {
      deviceMemory?: number;
      connection?: { saveData?: boolean };
    };
    if (typeof nav.deviceMemory === "number" && nav.deviceMemory < 4) ok = false;
    if (typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency < 4) ok = false;
    if (typeof devicePixelRatio === "number" && devicePixelRatio < 2) ok = false;
    if (nav.connection?.saveData === true) ok = false;
  } catch {
    /* no navigator (SSR) — nothing renders there anyway */
  }
  cabinFloor = ok;
  return ok;
}

/* The live cabin preference, same shape and for the same reason as the rival
   flags at the bottom of this file: player.ts resolves the donor cabin inside
   buildPlayerCar, which the engine calls with a tier and no settings object,
   and threading one through would mean editing a call site in engine.ts for a
   value that changes about once a session. Seeded from the default so a rig
   built before the UI has synced still gets "auto". */
const cabinLive: { mode: CabinMode } = { mode: "auto" };

/** Push a settings object into the live cabin preference. Called wherever
 *  syncRivalMode is — engine creation, and every settings write. */
export function syncCabinMode(s: GameSettings) {
  cabinLive.mode = isCabinMode(s.cabin) ? s.cabin : "auto";
}

/** May a car that configures a donor cabin actually load it here?
 *
 *  "donor"/"procedural" are the player's word and are final — including
 *  "donor" on a device that fails the floor, which is the informed override:
 *  they asked for the heavy cabin and the setting sits one row under the
 *  device tier that explains what that means. */
export function donorCabinAllowed(tier: RenderTier): boolean {
  if (cabinLive.mode === "procedural") return false;
  if (cabinLive.mode === "donor") return true;
  return tier !== "mobile-base" || donorCabinAffordable();
}

/** What "auto" resolves to right now, for the settings row to show. */
export const cabinAutoLabel = (tier: RenderTier) =>
  tier !== "mobile-base" || donorCabinAffordable() ? "real" : "procedural";

/** Effective tier: `?tier=` URL param (testing) > persisted manual override >
 *  detection. The URL param is read-only and never persisted, so a test link
 *  can't quietly rewrite someone's saved profile. */
export function resolveRenderTier(
  s: GameSettings,
  isTouch: boolean,
  gl?: WebGLRenderingContext | WebGL2RenderingContext | null
): RenderTier {
  try {
    if (typeof location !== "undefined") {
      const q = new URLSearchParams(location.search).get("tier");
      if (isRenderTier(q)) return q;
    }
  } catch {
    /* ignore malformed URLs */
  }
  if (isRenderTier(s.tierOverride)) return s.tierOverride;
  return detectRenderTier(isTouch, gl);
}

/** Density multiplier applied to the engine's base time-of-day fog curve. */
const FOG_MULT: Record<FogLevel, number> = {
  off: 0,
  light: 0.6,
  medium: 1.25,
  heavy: 2.4,
};

export const fogMultiplier = (l: FogLevel) => FOG_MULT[l] ?? FOG_MULT.medium;

/** Convert forward speed (m/s) to the configured display unit. */
export const speedInUnits = (u: number, units: SpeedUnits) =>
  Math.abs(u) * (units === "mph" ? 2.236936 : 3.6);

export const unitLabel = (units: SpeedUnits) => (units === "mph" ? "mph" : "km/h");

export interface GameSettings {
  preset: "low" | "medium" | "high";
  reflections: boolean;
  bloom: boolean;
  shadows: boolean;
  fxaa: boolean;
  tc: boolean;
  mblur: boolean;
  fog: FogLevel;
  dashcam: boolean; // heavy degraded "DVR footage" filter (V in game)
  drawDist: number; // town chunk draw distance, meters
  units: SpeedUnits;
  steerMode: "buttons" | "wheel" | "tilt";
  traffic: number; // 0.2..1
  fovBase: number;
  vol: number;
  autoTime: boolean;
  /** hour of day, 0..24, the world starts at (R in game / the panel slider).
      autoTime persisted without this, so the day/night *cycle* survived a
      reload while the time it ran from did not. */
  time: number;
  /** wet road + rain particles (R in game) */
  rain: boolean;
  /** HUD minimap visible (X in game) */
  mmap: boolean;
  /** manual render-tier override; "auto" defers to device detection */
  tierOverride: TierOverride;
  /** the imported (donor) interior for cars that have one — "auto" defers to
      the hardware floor in donorCabinAffordable(). See the cabin block above. */
  cabin: CabinMode;
  /** Test mode: drive on testDriveSpec() — extra grip, brakes and power (the
      K key in game, and a row in the settings panel). A testing aid rather
      than a difficulty setting, but persisted like any other toggle so it
      survives a reload; game/engine.ts reads it straight off here. */
  testMode: boolean;
  /** the rival pace car is running (see the RIVAL block in game/traffic.ts) */
  rival: boolean;
  /** ...and whether it indicates its lane changes. Off by default: a car that
      cuts through traffic and still signals is a contradiction, and the
      ABSENCE of a blinker is characterisation the player reads immediately. */
  rivalSignals: boolean;
  /** the No Hesi scoring loop — speed + near misses build a combo, contact
      resets it (see NOHESI in game/engine.ts). On by default, same pattern
      as `rival`: it costs nothing while driving clean and reads immediately
      as this game's version of the reference title's vibe bar. */
  noHesiScore: boolean;
}

export interface Profile {
  settings: GameSettings;
  carId: string;
  paintIx: number;
  seed: number;
  camMode: number;
  /** best-ever No Hesi score, across every drive on this profile — see
      game/engine.ts's noHesiUpdate. Only ever grows. */
  noHesiBest: number;
}

export const defaultSettings = (): GameSettings => ({
  preset: "high",
  reflections: true,
  bloom: true,
  shadows: true,
  fxaa: true,
  tc: true,
  /* OFF by default: this is the chase-cam motion blur, and it was reported
     as unwanted smear at speed rather than read as a camera effect. Still a
     setting, so it can be turned back on; only the default moved. */
  mblur: false,
  /* OFF by default. FogExp2 grows with distance squared, so at the densities
     that keep the road visible it does nothing to anything NEARBY — which is
     what people mean by "foggy". It only ever veiled the far skyline, and to
     do that it had to be a lifted colour, which then painted every unlit
     surface it touched (dark buildings became the fog rather than being
     veiled by it). Judged not worth the trade: "it just makes everything
     yellow and doesnt even work like i thought fog would".

     Everything behind it is intact — the colour fields, the density curve,
     __fog, and the four levels. Settings -> Fog -> light/medium/heavy brings
     it straight back. */
  fog: "off",
  dashcam: false,
  drawDist: 700,
  units: "mph",
  steerMode: "buttons",
  traffic: 1,
  fovBase: 67,
  vol: 1,
  autoTime: true,
  /* the engine's long-standing hardcoded start hour — dusk, which is the light
     the dashcam look was tuned in */
  time: 21.4,
  rain: false,
  mmap: true,
  tierOverride: "auto",
  /* Auto, which now means "load it unless this device visibly cannot" rather
     than the old "only on hardware we recognised". */
  cabin: "auto",
  /* A mode, not a difficulty: off until it is switched on, from either the
     start menu or the settings panel. Off costs one boolean test per frame —
     no pool slot is reserved and no controller runs (game/traffic.ts). */
  rival: false,
  rivalSignals: false,
  testMode: false,
  noHesiScore: true,
});

export const defaultProfile = (): Profile => ({
  settings: defaultSettings(),
  carId: DEFAULT_CAR_ID,
  paintIx: 0,
  seed: 1987,
  /* DASHCAM. The POV camera is the view this game is played in — AGENTS.md is
     explicit that the other three exist for debugging — so a first-run profile
     has to start there. It defaulted to chase, which meant every new visitor
     landed in third person and never saw the interior at all unless they went
     looking for the camera control. Only affects first run: an existing
     profile keeps whatever camera it was last left on. */
  camMode: 3,
  noHesiBest: 0,
});

/** Preset side-effects (ported from legacy applyPreset). */
export function applyPresetDefaults(s: GameSettings, preset: GameSettings["preset"]) {
  s.preset = preset;
  if (preset === "low") {
    s.shadows = false;
    s.reflections = false;
    s.mblur = false;
    s.bloom = true;
    s.fxaa = true;
  } else if (preset === "medium") {
    s.shadows = true;
    s.reflections = true;
    s.mblur = false;
    s.bloom = true;
    s.fxaa = true;
  } else {
    s.shadows = true;
    s.reflections = true;
    s.mblur = true;
    s.bloom = true;
    s.fxaa = true;
  }
}

const KEY = "neonx.profile.v3";

/** Settings that must survive as finite numbers — a NaN here reaches the
 *  renderer (fovBase → projection matrix), the audio graph (vol → gain) or the
 *  chunk culler (drawDist) and poisons it silently. */
const NUM_KEYS = ["drawDist", "traffic", "fovBase", "vol", "time"] as const;

/** Booleans that a hand-edited, half-migrated or otherwise mangled entry could
 *  hold as a string, a number or null. Anything that is not a real boolean
 *  falls back to the DEFAULT rather than to `false`: mmap and most of the
 *  render toggles default on, so coercing junk with `=== true` would quietly
 *  turn them off instead of ignoring the bad value. */
const BOOL_KEYS = [
  "reflections", "bloom", "shadows", "fxaa", "tc", "mblur", "dashcam",
  "autoTime", "rain", "mmap", "rival", "rivalSignals", "testMode",
  "noHesiScore",
] as const;

/** Non-negative integer, or the fallback. For the persisted array indices whose
 *  consumers wrap with `%`: JS `%` keeps the sign and never rounds, so neither a
 *  negative nor a fractional index can be walked back into range downstream. */
const normIx = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;

export function loadProfile(): Profile {
  const base = defaultProfile();
  try {
    const raw = localStorage.getItem(KEY);
    /* ONE-TIME: move a profile that predates the two-car garage off "kaze".

       Same shape as the mblur/fog scrubs below and for a stronger reason. For
       the whole life of the one-car roster every profile stored carId:"kaze",
       and kaze wore the imported Volvo body — that mapping has moved to the
       new VOLVO S90, and kaze now renders from its own generated shell. So a
       returning player who reloads into "the car I had" would find the same
       name on a car that no longer looks remotely like it, having chosen
       nothing. The default moved; move them with it, once.

       STAMPED BEFORE THE EARLY RETURN, which the two scrubs below cannot be
       and do not need to be. Their fix is a settings value whose new default
       is right for a fresh player anyway, so a first-ever load that skips the
       flag costs nothing. This one rewrites a CHOICE: leave the flag unset on
       a first load and a new player who goes to the garage, picks the KAZE GT
       and reloads would be silently put back in the Volvo — the migration
       eating a genuine selection, which is the one thing it must never do.
       Stamping here means it can only ever fire against a profile that was
       already on disk when this shipped. */
    const CAR_MIGRATED = KEY + ".volvodefault";
    const migrateCar = !localStorage.getItem(CAR_MIGRATED);
    if (migrateCar) localStorage.setItem(CAR_MIGRATED, "1");
    if (!raw) return base;
    const p = JSON.parse(raw);
    /* JSON.parse happily yields a string/number/array/null for a mangled entry;
       spreading one of those below would build a Profile out of its characters
       or indices instead of falling back. */
    if (!p || typeof p !== "object" || Array.isArray(p)) return base;
    const settings = { ...base.settings, ...(p.settings || {}) };
    /* ONE-TIME: clear a stored mblur:true.

       Motion blur defaulted ON for the whole life of the v3 profile, and the
       dashcam forced its frame blend on regardless of the setting anyway
       ("|| pov" in post.ts) — so unticking the box changed the chase camera
       and nothing else, and the smear stayed in the only view the game is
       actually played in. That force is gone now, but a profile written before
       it still carries mblur:true and would keep smearing with no indication
       why, including over the cabin itself at speed.

       Runs exactly once, under its own key, and then never touches the value
       again: after this the setting belongs to the user, and someone who turns
       motion blur back on must have it stay on. A plain `settings.mblur =
       false` here would be a setting that cannot be changed. */
    const MB_CLEARED = KEY + ".mbcleared";
    if (!localStorage.getItem(MB_CLEARED)) {
      settings.mblur = false;
      localStorage.setItem(MB_CLEARED, "1");
    }
    /* ONE-TIME, same shape and the same reason: fog defaulted to "medium" for
       the life of the v3 profile, so flipping the default alone would leave
       every existing player fogged with no way to know why the setting note
       says otherwise. Runs once under its own key and then never touches the
       value again — after this the setting is the user's, and someone who
       turns fog back on must have it stay on. */
    const FOG_CLEARED = KEY + ".fogcleared";
    if (!localStorage.getItem(FOG_CLEARED)) {
      settings.fog = "off";
      localStorage.setItem(FOG_CLEARED, "1");
    }
    // v3 profiles stored fog as a 0.3..2.6 multiplier; snap those to the
    // nearest named level
    if (typeof (settings.fog as unknown) === "number") {
      const n = settings.fog as unknown as number;
      settings.fog = n <= 0.05 ? "off" : n < 0.95 ? "light" : n < 1.8 ? "medium" : "heavy";
    }
    if (settings.units !== "mph" && settings.units !== "kmh") settings.units = "mph";
    for (const k of BOOL_KEYS)
      if (typeof settings[k] !== "boolean") settings[k] = base.settings[k];
    if (settings.tierOverride !== "auto" && !isRenderTier(settings.tierOverride))
      settings.tierOverride = "auto";
    if (!isCabinMode(settings.cabin)) settings.cabin = "auto";
    for (const k of NUM_KEYS)
      if (typeof settings[k] !== "number" || !Number.isFinite(settings[k]))
        settings[k] = base.settings[k];
    /* Time of day is a 0..24 hour clock feeding the sun angle, the fog blend
       and the HUD clock. The engine re-wraps it with `% 24` every frame, which
       recovers an overshoot but keeps the sign of a negative — so a stored
       -3 would sit below the curve forever. Pin the range here instead. */
    settings.time = Math.min(24, Math.max(0, settings.time));
    const prof: Profile = { ...base, ...p, settings };
    /* paintIx and camMode index fixed tables. Their consumers wrap with `%`,
       which recovers an integer overshoot but not a negative or fractional
       value: PAINTS[-1] is undefined and throws on `.hex`/`.name` while the car
       is built and while the menu renders, and a fractional camMode cycles
       1.5 → 2.5 → 3.5 → 0.5 forever without ever matching a camera. Only the
       lower bound and integrality are enforced here — the table lengths live
       with the consumers, so an overshoot is still theirs to wrap. */
    prof.paintIx = normIx(prof.paintIx, base.paintIx);
    prof.camMode = normIx(prof.camMode, base.camMode);
    /* The roster can SHRINK under a saved profile: a car that was driveable
       when this entry was written may since have been marked comingSoon, and
       the stored id would boot the engine straight into a locked car. This is
       the same class of hole as the stale fovBase that outlived a lowered
       slider maximum, and it gets the same two-sided fix — getCar() falls back
       downstream, and the stored value is scrubbed here so the next save does
       not carry it forward. */
    if (typeof prof.carId !== "string" || !isPlayableCar(prof.carId))
      prof.carId = DEFAULT_CAR_ID;
    /* The one-time default move, applied after the scrub above so it can only
       ever see a valid id. Deliberately narrow: only the id that WAS the sole
       default is rewritten, so a profile that somehow already names another
       car is left alone, and once the flag is stamped the car belongs to the
       player again — someone who picks the KAZE GT after this keeps it. */
    if (migrateCar && prof.carId === "kaze") prof.carId = DEFAULT_CAR_ID;
    if (typeof prof.seed !== "number" || !Number.isFinite(prof.seed)) prof.seed = base.seed;
    if (typeof prof.noHesiBest !== "number" || !Number.isFinite(prof.noHesiBest) || prof.noHesiBest < 0)
      prof.noHesiBest = base.noHesiBest;
    return prof;
  } catch {
    return base;
  }
}

/** Caps resolved for world-CONSTRUCTION time (additive; Lane H).
 *
 *  The engine resolves its tier once at startup, but the world builders in
 *  game/world/* run inside that same startup call and cannot reach the engine
 *  instance mid-build — so they resolve the identical answer independently
 *  here: same precedence (?tier= URL param > saved override > device sniff),
 *  same inputs. Touch detection mirrors engine.ts. Cached: the world is built
 *  once, and detectRenderTier may probe a WebGL context.
 *
 *  SSR-safe: with no window it lands on desktop caps, which only matters for
 *  code paths that never render anyway. */
let worldCaps: TierCaps | null = null;
export function worldTierCaps(): TierCaps {
  if (worldCaps) return worldCaps;
  try {
    const isTouch =
      typeof window !== "undefined" &&
      "ontouchstart" in window &&
      matchMedia("(pointer:coarse)").matches;
    worldCaps = TIER_CAPS[resolveRenderTier(loadProfile().settings, isTouch, null)];
  } catch {
    worldCaps = TIER_CAPS.desktop;
  }
  return worldCaps;
}

/* ---------------- rival mode, live ----------------
 *
 * game/traffic.ts owns the rival car, but Traffic is constructed by the engine
 * and handed only a density number per frame — it has no route to GameSettings
 * at all. That is the same problem worldTierCaps() above solves for the world
 * builders ("cannot reach the engine instance"), so it gets the same solution:
 * a module-level live value the UI syncs on every settings change and the
 * traffic update reads once a frame.
 *
 * Deliberately NOT wired through Game.applySettings: engine.ts needs no edit
 * for this feature, and keeping it that way means the rival can never be the
 * reason a camera, a light or a post pass moves.
 */
const rivalLive = { on: false, signals: false };

/** Live rival-mode flags. Read-only for callers — mutate via syncRivalMode. */
export const rivalMode = () => rivalLive;

/** Push a settings object into the live flags. Safe to call every frame; the
 *  UI calls it on every settings change and once at startup. */
export function syncRivalMode(s: GameSettings) {
  rivalLive.on = s.rival === true;
  rivalLive.signals = s.rivalSignals === true;
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode etc — non-fatal */
  }
}
