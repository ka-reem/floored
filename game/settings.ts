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
    lampPoolEvery: 2,
  },
  "mobile-high": {
    tier: "mobile-high", dprCap: 1.35, pbrDetail: true, spreadCones: true,
    fenceOverdraw: true, drawDistScale: 0.85, mirrorHalf: true,
    reflections: false, mblur: false, dashcam: true,
    dualBloom: false, filmLook: false,
    lampCones: true, lampConeEvery: 2, jetFans: true, catwalks: true,
    propModels: true, tollGlow: true, cityRings: 3, roadDecals: true,
    lampPoolEvery: 1,
  },
  desktop: {
    tier: "desktop", dprCap: 1.75, pbrDetail: true, spreadCones: true,
    fenceOverdraw: true, drawDistScale: 1, mirrorHalf: false,
    reflections: true, mblur: true, dashcam: true,
    dualBloom: true, filmLook: true,
    lampCones: true, lampConeEvery: 1, jetFans: true, catwalks: true,
    propModels: true, tollGlow: true, cityRings: 3, roadDecals: true,
    lampPoolEvery: 1,
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
}

export interface Profile {
  settings: GameSettings;
  carId: string;
  paintIx: number;
  seed: number;
  camMode: number;
}

export const defaultSettings = (): GameSettings => ({
  preset: "high",
  reflections: true,
  bloom: true,
  shadows: true,
  fxaa: true,
  tc: true,
  mblur: true,
  fog: "medium",
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
  /* A mode, not a difficulty: off until it is switched on, from either the
     start menu or the settings panel. Off costs one boolean test per frame —
     no pool slot is reserved and no controller runs (game/traffic.ts). */
  rival: false,
  rivalSignals: false,
  testMode: false,
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
    if (!raw) return base;
    const p = JSON.parse(raw);
    /* JSON.parse happily yields a string/number/array/null for a mangled entry;
       spreading one of those below would build a Profile out of its characters
       or indices instead of falling back. */
    if (!p || typeof p !== "object" || Array.isArray(p)) return base;
    const settings = { ...base.settings, ...(p.settings || {}) };
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
    if (typeof prof.seed !== "number" || !Number.isFinite(prof.seed)) prof.seed = base.seed;
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
