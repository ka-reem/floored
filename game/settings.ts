export type SpeedUnits = "mph" | "kmh";
export type FogLevel = "off" | "light" | "medium" | "heavy";

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
});

export const defaultProfile = (): Profile => ({
  settings: defaultSettings(),
  carId: "kaze",
  paintIx: 0,
  seed: 1987,
  camMode: 0, // chase
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

export function loadProfile(): Profile {
  const base = defaultProfile();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const p = JSON.parse(raw);
    const settings = { ...base.settings, ...(p.settings || {}) };
    // v3 profiles stored fog as a 0.3..2.6 multiplier; snap those to the
    // nearest named level
    if (typeof (settings.fog as unknown) === "number") {
      const n = settings.fog as unknown as number;
      settings.fog = n <= 0.05 ? "off" : n < 0.95 ? "light" : n < 1.8 ? "medium" : "heavy";
    }
    if (settings.units !== "mph" && settings.units !== "kmh") settings.units = "mph";
    settings.dashcam = settings.dashcam === true;
    return { ...base, ...p, settings };
  } catch {
    return base;
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode etc — non-fatal */
  }
}
