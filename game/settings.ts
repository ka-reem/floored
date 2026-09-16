import { DEFAULT_CAR_ID, isPlayableCar } from "./carspecs";
import { SHOW_DEV_SETTINGS } from "@/lib/build";
import { safeMode } from "./safemode";

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

  /** Density level (0..1) for the full-lap roadside pass (roadside.ts
      FX_ROADSIDE: clumped tree lines, imposter ranks, undergrowth, gutter
      weeds). A LEVEL like districts: everything is merged or instanced, so
      thinning trades silhouette continuity, not draw calls — mobile keeps
      the same lap with sparser clumps. 0 disables the whole layer. */
  vegetation?: number;

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

  /** Density scalar for the mountain road's dressing (highway.ts
      buildMountainRoad): rock-face tessellation step, delineator pitch. The
      road itself, its physics and its traffic are never gated — this only
      thins the trim the pass is dressed with, the same trade deckDressing
      makes for the deck scatter. */
  mtnDetail?: number;

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

  /** Stream the 1024px-atlas HD NPC bodyshells (public/models/cars-hd/)
      after the first drivable frame and hot-swap them into the fleet.
      Desktop-only: the BASE fleet everyone loads is already the same
      donors at 512px, and phones keep their memory and radio for the
      drive itself. Read by traffic.ts once the base fleet has landed. */
  hdFleet?: boolean;

  /** Size of the NPC pool, and therefore the ceiling the traffic-density
      slider reaches at 100%.

      120 was the single hardcoded number for every device, and it is why the
      owner's "100% should be bumper to bumper" was not: 120 cars, of which
      0.74 go on the deck, spread over the ~900 m of corridor the fog keeps
      alive, is a car every ~35 m per lane. That is moderate traffic, not a
      jam. See FLEET_BASE in traffic.ts for how the slider reaches the new
      ceiling WITHOUT moving anything below 75% — every phone and every
      mid-slider setting keeps exactly the count it has today.

      The phone numbers stay at or near 120 on purpose. The GPU-memory ceiling
      that kills iOS Safari on the loading screen is not something to spend on
      a fuller road. */
  fleetMax: number;
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
    wheelTracks: false, deckDressing: 0.35, districts: 0.55, mtnDetail: 0.5, hdFleet: false,
    vegetation: 0.55,
    fleetMax: 120,
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
    wheelTracks: true, deckDressing: 0.7, districts: 0.8, mtnDetail: 0.75, hdFleet: false,
    vegetation: 0.8,
    fleetMax: 150,
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
    wheelTracks: true, deckDressing: 1, districts: 1, mtnDetail: 1, hdFleet: true,
    vegetation: 1,
    fleetMax: 240,
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
  /* The probe context is RELEASED again when we made it ourselves.

     A WebGL context is a scarce, expensive object: the browser caps how many
     may be live at once and drops the OLDEST to stay under the cap — which,
     in a page whose main context is the game, means dropping the game. Every
     leaked context also holds its own driver-side allocation for the life of
     the page.

     This function is called BOTH ways: engine.ts hands it the renderer's live
     context (nothing to release, and releasing it would kill the game), while
     cockpit.ts calls it with none and so made a throwaway one here that was
     never freed. Note the desktop early-return above, which means the leak
     only ever happened on TOUCH devices — phones, where contexts are
     scarcest and the owner's "Graphics context lost" panel actually fires.

     gfxfail.ts's webglAvailable() probe already does exactly this; this one
     was missed. WEBGL_lose_context is the only way to hand a context back
     without waiting for GC, and it is deliberately in a finally so a throw
     inside the sniff cannot leak it either. */
  let owned: WebGLRenderingContext | WebGL2RenderingContext | undefined;
  try {
    let ctx = gl ?? undefined;
    if (!ctx) {
      const cv = document.createElement("canvas");
      ctx = owned = (cv.getContext("webgl2") || cv.getContext("webgl")) as
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
  } finally {
    try { owned?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* nothing to do */ }
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
  /* A public build has no row for this, so the stored value is IGNORED rather
     than honoured: nobody is left on a forced cabin with no control to undo
     it. The profile keeps whatever it says — nothing is written back — so
     ?debug=1 shows the developer's choice exactly as they left it. */
  cabinLive.mode = SHOW_DEV_SETTINGS && isCabinMode(s.cabin) ? s.cabin : "auto";
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
  /* A device that has already died twice on the loading screen does not get
     asked a third time. Checked AFTER the two explicit modes above, so a
     player who went and chose "donor" still gets it — safe mode is a ceiling
     on what we hand out unasked, not a veto over what was asked for.

     This is the branch that actually catches the masked iPhone: it lands on
     mobile-high, where the affordability floor below is never consulted, so
     the floor cannot help it and only the crash record can. */
  if (safeMode()) return false;
  return tier !== "mobile-base" || donorCabinAffordable();
}

/** What "auto" resolves to right now, for the settings row to show. */
export const cabinAutoLabel = (tier: RenderTier) =>
  !safeMode() && (tier !== "mobile-base" || donorCabinAffordable()) ? "real" : "procedural";

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
  /* THE OVERRIDE IS A PLAYER SETTING NOW, so it applies in a public build.

     It used to be gated on SHOW_DEV_SETTINGS at BOTH ends — the row was
     developer-only AND this line ignored a stored value in production. That
     pairing was coherent while it was a debug affordance, but it meant a
     profile could carry an override that silently did nothing, which is the
     one state a setting must never be in.

     The owner's call: "ppl can adjust the setting for like laptop base mobile
     base like before". Auto stays the default and stays right for almost
     everyone — detectRenderTier already caps a phone hard. The override is for
     the cases detection cannot see: a laptop throttling on battery, an old
     tablet that reports like a desktop, or someone who simply wants more
     frames than picture. */
  if (isRenderTier(s.tierOverride)) return s.tierOverride;
  /* Same ceiling, same ordering rule as donorCabinAllowed: below the player's
     own override, above detection. Detection is exactly what is suspect on a
     device that keeps dying — the masked-GPU phone is called mobile-high on
     nothing better than a 3x screen — so a boot record that contradicts it
     wins. mobile-base is the tier every unknown device was always meant to
     land on, so this is a return to the conservative answer rather than a new
     one: deckTexPx 256, no road decals, no prop models, cabinPbrMaps off. */
  if (safeMode()) return "mobile-base";
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

/** Convert a distance (metres, the engine's own unit) to the DISTANCE that
    goes with the configured speed unit — miles on mph, kilometres on km/h.
    There is deliberately no second unit control: the owner's ask was "by
    miles or smth", and a player already told us which system they think in
    when they picked the speedo. */
export const distInUnits = (m: number, units: SpeedUnits) =>
  m / (units === "mph" ? 1609.344 : 1000);

export const distLabel = (units: SpeedUnits) => (units === "mph" ? "mi" : "km");

/** One decimal, in the player's own unit — the clean-run readout's format,
    shared by the HUD (game/engine.ts) and the STATS board (GameApp.tsx) so
    the two can never disagree about a number the player compares. */
export const fmtRunDist = (m: number, units: SpeedUnits) =>
  distInUnits(m, units).toFixed(1) + " " + distLabel(units);

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
  steerMode: "buttons" | "wheel" | "tilt" | "slider";
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
  /** HUD minimap framing (Z in game, or clicking the map on desktop, or the
      touch drawer's MAP ZOOM row): false = close-up follow, true = the whole
      loop in one fixed frame (minimap.ts `zoom`). The head unit's nav pane is
      not covered — it keeps its own follow framing. */
  mmapZoom: boolean;
  /** manual render-tier override; "auto" defers to device detection */
  tierOverride: TierOverride;
  /** the imported (donor) interior for cars that have one — "auto" defers to
      the hardware floor in donorCabinAffordable(). See the cabin block above. */
  cabin: CabinMode;
  /** the rival pace car is running (see the RIVAL block in game/traffic.ts) */
  rival: boolean;
  /** ...and whether it indicates its lane changes. Off by default: a car that
      cuts through traffic and still signals is a contradiction, and the
      ABSENCE of a blinker is characterisation the player reads immediately. */
  rivalSignals: boolean;
  /** the clean-run readout: distance since the last real impact, in the
      player's own distance unit (see runUpdate in game/engine.ts). This is
      the successor to `noHesiScore` — the toggle survived the scoring
      change, its meaning is now "show the clean-run readout", and
      loadProfile carries a stored noHesiScore across to it once. On by
      default: it costs nothing while driving clean and it is now a quiet
      corner figure rather than a running arcade total. */
  cleanRunScore: boolean;
  /** ENDLESS MODE — the drive-until-you-crash scoring mode (see the ENDLESS
      block in game/engine.ts). Opt-in, off for a fresh profile: it changes
      nothing about how the car drives, it only puts the run/best/money panel
      on screen and makes the reset an event you can see. The distance and the
      crash rule underneath it are the clean run's, already running for every
      player whether this is on or not. */
  endless: boolean;
  /** first-run discovery hints (game/hints.ts): one-shot in-context tips.
      This toggle gates the whole system; WHICH tips have already fired is
      not a setting and lives separately (hintSeen below), so "Reset all
      settings" turning this back on does not also replay seen tips. */
  hints: boolean;
}

/** Lifetime drive statistics, accumulated across every session on this
 *  profile — see the DRIVE STATS block in game/engine.ts. Sums except where
 *  noted; every field is a plain non-negative number so the scrub in
 *  loadProfile can treat them uniformly (STAT_KEYS below, the same key-list
 *  pattern NUM_KEYS/BOOL_KEYS use). Units are the engine's own — metres,
 *  m/s, seconds — and converted at display time, so a units-setting change
 *  never rewrites history. */
export interface LifetimeStats {
  /** metres driven */
  dist: number;
  /** fastest speed ever held, m/s (a max, not a sum) */
  topSpeed: number;
  /** seconds actually moving (|u| above walking pace), not seconds unpaused */
  driveT: number;
  /** near misses as the No Hesi scoring feed counts them (traffic.ts
      scoreEvents — counted whether or not the score display is on) */
  nearMisses: number;
  /** highest No Hesi combo ever reached (a max, not a sum) */
  bestCombo: number;
  /** crashes hard enough for the crash sound — same thresholds */
  crashes: number;
  /** full circuits of the endless expressway (loop splices, forward) */
  laps: number;
  /** complete traversals of the mountain pass (route-graph edge runs) */
  mtnRuns: number;
}

export const defaultLifetimeStats = (): LifetimeStats => ({
  dist: 0, topSpeed: 0, driveT: 0, nearMisses: 0,
  bestCombo: 1, crashes: 0, laps: 0, mtnRuns: 0,
});

export interface Profile {
  settings: GameSettings;
  carId: string;
  paintIx: number;
  seed: number;
  camMode: number;
  /** best-ever CLEAN RUN on this profile: the furthest the car has been
      driven between two real impacts, in metres (converted at display time
      like every other stored distance). Only ever grows. Replaces the old
      `noHesiBest`, which held arcade POINTS — there is no honest conversion
      from points to metres, so that key is dropped rather than migrated
      (see loadProfile). */
  cleanRunBest: number;
  /** lifetime drive statistics — see the DRIVE STATS block in engine.ts.
      Written by GameApp.tsx's persist() the same way cleanRunBest is. */
  stats: LifetimeStats;
  /** ENDLESS MODE persistence — device-only, the owner's explicit call: no
      server, no sync, no account. Both are plain non-negative metres/currency
      so the scrub in loadProfile can treat them like cleanRunBest.

      `money` is the bank: it accrues from distance driven (ENDLESS.perMetre in
      engine.ts) and a crash NEVER takes any of it away — only the run score
      resets. `bestDistance` is the furthest single run, in metres.

      bestDistance measures exactly what cleanRunBest measures (metres between
      two real impacts, the same CLEAN_RUN.impact rule), so a profile that
      predates this mode is SEEDED from cleanRunBest rather than starting the
      player's record over — see loadProfile. They are kept as two keys because
      cleanRunBest belongs to the clean-run readout, which ships whether or not
      the mode is on, and a future endless rule change must not silently
      rewrite the readout's record. */
  money: number;
  bestDistance: number;
  /** head-unit tic-tac-toe record, the player's side (game/consolegame.ts).
      Bound into the pane at engine construction and mutated in place there,
      so persist() saving the profile carries it with no extra plumbing. */
  ttt: { w: number; l: number; d: number };
}

export const defaultSettings = (): GameSettings => ({
  /* LOW is the default for every device, on the owner's call ("i think by
     default we just need to run low graphics for everyone").

     It is not the same lever as TIER_CAPS. The caps are a CEILING the device
     cannot exceed — a phone was never getting reflections whatever this said.
     This is the FLOOR everyone starts on, desktops included, and the reason is
     the loading screen: the preset is consumed by the first build stage, so a
     first-time player on an unknown machine pays the high-preset build before
     anyone knows whether their machine can carry it, and the ones who cannot
     leave during the load rather than after it. Starting low means the first
     drive comes up fast on every machine, and SETTINGS > PICTURE raises it in
     one tap for anyone who wants more.

     applyPresetDefaults(s, "low") below is the authority on what low means
     (shadows and reflections off, bloom and FXAA on); the fields under this
     one are the shipped values for a fresh profile and must agree with it. */
  preset: "low",
  /* These four ARE applyPresetDefaults(s, "low"), written out. They used to
     read reflections:true / shadows:true because the default preset was high;
     leaving them that way would ship a profile whose preset says LOW while two
     of the things LOW turns off are on, so the PICTURE panel would show LOW
     selected over a picture nobody picked, and clicking LOW — the preset
     already highlighted — would visibly change the render. Keep these in step
     with applyPresetDefaults if either side moves. */
  reflections: false,
  bloom: true,
  shadows: false,
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
  // close-up follow: the framing the map has always had, and the one that
  // reads at a glance while driving — the overview is the opt-in
  mmapZoom: false,
  tierOverride: "auto",
  /* Auto, which now means "load it unless this device visibly cannot" rather
     than the old "only on hardware we recognised". */
  cabin: "auto",
  /* A mode, not a difficulty: off until it is switched on, from either the
     start menu or the settings panel. Off costs one boolean test per frame —
     no pool slot is reserved and no controller runs (game/traffic.ts). */
  rival: false,
  rivalSignals: false,
  cleanRunScore: true,
  /* OFF for a fresh profile. The owner drives free-roam as much as he plays a
     mode, and a score panel plus a visible reset on a drive nobody asked to be
     scored is the mode imposing itself — so it is one tap on the home board
     (ENDLESS) or one row in SETTINGS > GAMEPLAY, and free-roam is unchanged
     until then. Money still accrues either way; see ENDLESS in engine.ts. */
  endless: false,
  hints: true,
});

export const defaultProfile = (): Profile => ({
  settings: defaultSettings(),
  carId: DEFAULT_CAR_ID,
  paintIx: 0,
  seed: 1987,
  /* COCKPIT (CAM_COCKPIT = 1 in engine.ts). The owner's call, asked and then
     confirmed: "the camera view by default should always be the interior car
     view inside the cockpit the reg one ... default view" / "cockpit main
     view".

     This was 3 (CAM_POV, the hard-mounted dashcam), and before that 0 (chase).
     Both POV and COCKPIT are interior views, which is why this needed asking
     rather than guessing: POV is a rigid bracket at the windscreen, COCKPIT is
     a head — it has springs, it cranes to look back and it breathes under
     braking (see the camera-mode block in engine.ts). The owner wants the head.

     Only affects a FIRST RUN. An existing profile keeps whatever camera it was
     last left on, so nobody who has already picked a view gets moved off it —
     including the owner, whose own profile still holds his last choice.

     Note AGENTS.md's older "the dashcam POV is the game" rule was already
     retired by the owner in the 2026-08-28 update ("every camera ships now"),
     and POV remains the FIRST FRAME TO JUDGE VISUAL CHANGES IN — that is a
     separate rule from which camera a new player starts on, and this does not
     change it. */
  camMode: 1,
  cleanRunBest: 0,
  money: 0,
  bestDistance: 0,
  stats: defaultLifetimeStats(),
  ttt: { w: 0, l: 0, d: 0 },
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
    /* HIGH does NOT switch motion blur on, even though it is the expensive
       preset and blur is the expensive effect. A fresh profile ships
       mblur:false and the one-time scrub in the loader clears a stored true,
       both because the smear was unwanted rather than because it was slow --
       so a HIGH that turned it back on made clicking the preset you were
       already on silently change the picture. All three presets leave it
       off; motion blur is a manual opt-in and stays wherever the player
       put it. */
    s.mblur = false;
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
  "autoTime", "rain", "mmap", "mmapZoom", "rival", "rivalSignals",
  "cleanRunScore", "endless", "hints",
] as const;

/** Lifetime-stats fields, all "non-negative finite number or the default" —
 *  the same scrub cleanRunBest gets, driven off a key list like NUM_KEYS so a
 *  new statistic is one entry here rather than a hand-written guard. */
const STAT_KEYS = [
  "dist", "topSpeed", "driveT", "nearMisses", "bestCombo", "crashes",
  "laps", "mtnRuns",
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
    /* RENAME CARRY: noHesiScore -> cleanRunScore.

       The scoring changed underneath this toggle but the toggle did not: it
       still answers "do I want the score readout on the HUD?", and a player
       who turned it off does not want the clean-run figure either. Carried
       across once, only when the new key is absent (so a real choice made
       against the new name always wins), then the old key is dropped so the
       next save stops writing it. No flag needed — the carry is idempotent
       because it deletes its own source. */
    const legacyScore = (settings as unknown as Record<string, unknown>).noHesiScore;
    if (typeof legacyScore === "boolean" && typeof (p.settings || {}).cleanRunScore !== "boolean")
      settings.cleanRunScore = legacyScore;
    delete (settings as unknown as Record<string, unknown>).noHesiScore;
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
    /* An unrecognised steer mode would still count as analog in readInput
       (steerMode !== "buttons") and then feed off a value nothing writes —
       a phone with no steering at all. Fall back to the mode that always
       has controls on screen. */
    if (
      settings.steerMode !== "buttons" && settings.steerMode !== "wheel" &&
      settings.steerMode !== "tilt" && settings.steerMode !== "slider"
    )
      settings.steerMode = "buttons";
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
    /* TILT STEERING IS LOCKED for the beta, so a profile that stored it has
       to be moved off it. Not cosmetic: the on-screen steer buttons are
       HIDDEN in tilt mode (see GameApp's steer cluster), so a player left in
       a mode the picker no longer offers would have no steering at all and no
       way to change it.

       Why it is locked rather than shipped: hookTilt() in engine.ts has three
       faults that cannot be checked without a real phone, and this box has no
       accelerometer at all. (1) iOS 13+ only delivers orientation events
       after requestPermission() RESOLVES "granted", and the result is
       discarded — a refusal is silent, and the tiltHooked latch means it
       never asks again. (2) There is no neutral capture, so the zero point is
       "phone exactly upright" and the car pulls to one side depending on how
       it is actually held. (3) window.orientation is deprecated and undefined
       on many Android browsers, where it falls back to 90 and reads `beta`
       when it should read `gamma` — wrong axis.

       Any of those leaves a tester unable to steer, and a tester who cannot
       steer quits without telling anyone why. The engine path is untouched,
       so unlocking is putting the option back in the two pickers. */
    if (prof.settings?.steerMode === "tilt") prof.settings.steerMode = base.settings.steerMode;
    /* RAIN IS LOCKED for the beta too, so a profile that stored it on has to
       be moved off it. Not cosmetic: the settings row now reads a static NOT
       ACTIVE, and a stored `true` would have the world raining while the panel
       says it is not — the one state the lock must not produce.

       Why it is locked rather than shipped: the owner pulled the mode. The
       engine path is entirely untouched — setRain, the rain FX, the wet-road
       materials and all four wiper modes still run, and R and U still reach
       them — so unlocking is putting the SignToggle and the two QuickDrawer
       rows back in GameApp and dropping this line. */
    if (prof.settings?.rain) prof.settings.rain = base.settings.rain;
    /* THE RIVAL PACE CAR IS OFF for the beta — the owner: "turn the rival car
       off for now". Same shape as rain: the ways in are gone (the home-board
       shortcut, the settings row and the loading board's row), the car itself
       is untouched in traffic.ts.

       This scrub is what makes the lock true rather than cosmetic. `rival` has
       been a saved setting for weeks, so anyone who switched it on — the owner
       and every tester on this build — carries `true` in their profile, and
       without this line they would keep getting a rival with no control left
       to turn it off. rivalSignals goes with it: it is only read while a rival
       is running, and leaving it set would resurface in ADVANCED describing a
       car that is not there.

       Unlocking is putting the three controls back and dropping these two
       lines. syncRivalMode still runs on every load, so the module flag
       follows the scrubbed profile and traffic.ts never claims the slot. */
    if (prof.settings?.rival) prof.settings.rival = base.settings.rival;
    if (prof.settings?.rivalSignals) prof.settings.rivalSignals = base.settings.rivalSignals;
    /* THE DASHCAM FILTER IS OFF for the beta — the owner: "turn off dash cam
       filter put not available or something". Same shape as rain and the
       rival above, and it needs the scrub for the same reason they do: the
       default has been `dashcam: false` all along, but the filter has been
       reachable from the settings row and the V key for weeks, so anyone who
       switched it on carries `true` in their profile. Without this line they
       would keep the heavy degrade with no control left to turn it off — the
       one state a lock must never produce.

       Note this is the SETTING, not the POV look. TIER_CAPS.dashcam stays
       true on every tier and the evidence-footage chain the dashcam camera
       composites is untouched; what goes is the separate full-screen degrade
       the row and the V key toggle.

       The engine path is entirely untouched — game.grade, post's grade pass
       and the V key all still work, exactly as R still reaches rain — so
       unlocking is putting the SignToggle back in GameApp and dropping this
       line. */
    if (prof.settings?.dashcam) prof.settings.dashcam = base.settings.dashcam;
    if (typeof prof.seed !== "number" || !Number.isFinite(prof.seed)) prof.seed = base.seed;
    if (
      typeof prof.cleanRunBest !== "number" || !Number.isFinite(prof.cleanRunBest) ||
      prof.cleanRunBest < 0
    )
      prof.cleanRunBest = base.cleanRunBest;
    /* ENDLESS MODE bank + record. Same guard as cleanRunBest above, and the
       one migration this mode needs: a profile stored before the mode existed
       has no `bestDistance`, so it inherits the clean-run record it already
       holds — the two count the same metres under the same crash rule, so
       carrying it across is a rename, not an invention. `money` has no
       ancestor and honestly starts at 0. */
    const nonNegNum = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (!nonNegNum(prof.money)) prof.money = base.money;
    if (!nonNegNum(prof.bestDistance))
      prof.bestDistance = Math.max(base.bestDistance, prof.cleanRunBest);
    /* The retired No Hesi points best. NOT migrated: it counted
       speed x combo x seconds, and the record that replaced it counts
       metres — any mapping between the two would be invented, and inventing
       a personal best is worse than starting one. Deleted here so the next
       save stops carrying a dead key forward (the `...p` spread above would
       otherwise preserve it for the life of the profile). */
    delete (prof as unknown as Record<string, unknown>).noHesiBest;
    /* Lifetime stats: rebuilt field-by-field off the defaults, the same
       shape as the settings spread above — a stored non-object would spread
       its characters/indices into the profile otherwise, and any single
       mangled number falls back alone instead of voiding the rest. */
    const rawStats =
      prof.stats && typeof prof.stats === "object" && !Array.isArray(prof.stats)
        ? (prof.stats as unknown as Record<string, unknown>)
        : {};
    const stats = { ...base.stats };
    for (const k of STAT_KEYS) {
      const v = rawStats[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) stats[k] = v;
    }
    prof.stats = stats;
    /* The tic-tac-toe tally is mutated in place by game/consolegame.ts (see
       bindGameTally), so what leaves here must be a well-formed object even
       when the stored profile predates it or someone hand-edited a count into
       a string — normIx floors each field back to a non-negative integer. */
    const t = (prof.ttt ?? {}) as Record<string, unknown>;
    prof.ttt = { w: normIx(t.w, 0), l: normIx(t.l, 0), d: normIx(t.d, 0) };
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

/* ---------------- first-run hint memory ----------------
 *
 * Which one-shot discovery hints (game/hints.ts) have already fired, ever, in
 * this browser. Deliberately NOT a field of the Profile: persist() copies the
 * whole settings object out on every menu exit and the panel's DEFAULTS
 * button rewrites it wholesale, and neither of those should be able to replay
 * or eat "you have already seen this". Same storage prefix and the same
 * failure posture as the profile itself — a browser that refuses the write
 * repeats a tip next session, which is the harmless direction to fail in.
 */
const HINT_SEEN_KEY = KEY + ".hintsSeen";
let hintSeenCache: Record<string, 1> | null = null;
function hintSeenMap(): Record<string, 1> {
  if (hintSeenCache) return hintSeenCache;
  try {
    const raw = JSON.parse(localStorage.getItem(HINT_SEEN_KEY) || "{}");
    hintSeenCache =
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    hintSeenCache = {};
  }
  return hintSeenCache!;
}

export const hintSeen = (id: string): boolean => hintSeenMap()[id] === 1;

export function markHintSeen(id: string) {
  const m = hintSeenMap();
  if (m[id] === 1) return;
  m[id] = 1;
  try {
    localStorage.setItem(HINT_SEEN_KEY, JSON.stringify(m));
  } catch {
    /* see above — repeating a tip beats crashing over one */
  }
}
