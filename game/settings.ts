export interface GameSettings {
  preset: "low" | "medium" | "high";
  reflections: boolean;
  bloom: boolean;
  shadows: boolean;
  fxaa: boolean;
  tc: boolean;
  mblur: boolean;
  fog: number; // multiplier, 0.3..2.6
  drawDist: number; // town chunk draw distance, meters
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
  fog: 1.25,
  drawDist: 700,
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
    return {
      ...base,
      ...p,
      settings: { ...base.settings, ...(p.settings || {}) },
    };
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
