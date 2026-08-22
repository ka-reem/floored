/** Shell profile parameters — consumed by carshape.ts. All units meters. */
export interface ShellParams {
  L: number; // overall length
  W: number; // overall width
  ride: number; // sill height
  nose: number; // front fascia top edge height
  tail: number; // rear fascia top edge height
  belt: number; // beltline height
  roof: number; // roof height
  hood: number; // hood length (from nose to windshield base)
  trunk: number; // trunk length (from tail to rear glass base)
  rakeF: number; // windshield rake length
  rakeR: number; // rear glass rake length
  archR: number; // wheel arch radius
  wzF: number; // front axle z (from center)
  wzR: number; // rear axle z (positive; negated internally)
  wheelR: number; // tire radius
  wheelWidth: number;
  spoiler?: "wing" | "lip" | "roofcap" | null;
  hoodBulge?: boolean;
}

export interface PhysicsSpec {
  M: number; // mass kg
  IZ: number; // yaw inertia
  LA: number; // cg -> front axle
  LB: number; // cg -> rear axle
  HCG: number;
  TRACK: number;
  WR: number; // wheel radius (drivetrain)
  FINAL: number;
  /** Forward gear ratios, 1st..top. Gear numbers are 1-based indices into this. */
  RATIOS: number[];
  /** Reverse gear ratio; defaults to a little taller than 1st when omitted. */
  REV?: number;
  TQ_R: number[];
  TQ_T: number[];
  gripF: number; // Pacejka D multiplier front
  gripR: number;
  steerMax: number; // max steer rad at parking speed
  steerHi: number; // floor on steer travel at very high speed, rad
  /** Lateral accel (m/s²) full lock asks for; sets the speed-sensitive steering
   *  schedule dmax = steerAy*wheelbase/u². Higher = sharper, twitchier car. */
  steerAy?: number;
  revLimit: number;
  drag: number;
  awd?: boolean;
}

export interface CarSpec {
  id: string;
  name: string;
  jp: string;
  blurb: string;
  shell: ShellParams;
  phys: PhysicsSpec;
  stats: { speed: number; accel: number; grip: number; handling: number }; // 0..1 for UI bars
  cockpitAccent: number;
}

/** Paint system, in the automotive sense:
 *  - solid: pigment under clear, no flake. Flat, deep, slightly "cheap".
 *  - metallic: aluminium flake in the base coat. Sparkles, reads lighter at
 *    grazing angles.
 *  - pearl: mica flake with a tinted second coat — a coloured sheen that
 *    shifts against the base. Rendered with sheen, not iridescence (an extra
 *    BSDF layer is not worth it on a car that draws three times a frame). */
export type PaintFinish = "solid" | "metallic" | "pearl";

export interface Paint {
  name: string;
  hex: number;
  finish: PaintFinish;
  /** pearl only: the mica tint that flares at grazing angles. */
  pearlHex?: number;
}

export const PAINTS: Paint[] = [
  { name: "Midnight Indigo", hex: 0x2b4a8f, finish: "metallic" },
  { name: "Panda White", hex: 0xe8ecf2, finish: "pearl", pearlHex: 0x9fb6e6 },
  { name: "Sunset Orange", hex: 0xc65a1e, finish: "metallic" },
  { name: "Gunmetal", hex: 0x3c4048, finish: "metallic" },
  { name: "Cherry Red", hex: 0x8f1a22, finish: "pearl", pearlHex: 0xe0603a },
  { name: "Wasabi", hex: 0x5a7a3c, finish: "solid" },
];

/** Look a paint up by its colour, which is all most call sites carry. */
export const paintByHex = (hex: number): Paint =>
  PAINTS.find((p) => p.hex === hex) || { name: "Custom", hex, finish: "metallic" };

export const CARS: CarSpec[] = [
  {
    id: "kaze",
    name: "KAZE GT",
    jp: "疾風",
    blurb: "Turbo coupe. Loves the expressway, bites when provoked.",
    shell: {
      L: 4.42, W: 1.84, ride: 0.32, nose: 0.5, tail: 0.56, belt: 0.82, roof: 1.24,
      hood: 1.32, trunk: 0.92, rakeF: 0.95, rakeR: 0.78, archR: 0.44, wzF: 1.38,
      wzR: 1.32, wheelR: 0.325, wheelWidth: 0.26, spoiler: "wing", hoodBulge: true,
    },
    phys: {
      M: 1390, IZ: 2210, LA: 1.16, LB: 1.48, HCG: 0.5, TRACK: 1.56, WR: 0.325,
      FINAL: 3.7, RATIOS: [3.54, 2.13, 1.48, 1.15, 0.92, 0.76], REV: 3.82,
      TQ_R: [1000, 2000, 3000, 4000, 4600, 5400, 6200, 7200],
      TQ_T: [165, 235, 285, 320, 335, 330, 300, 248],
      gripF: 1.0, gripR: 1.04, steerMax: 0.62, steerHi: 0.026, steerAy: 20.5, revLimit: 6400, drag: 0.4,
    },
    stats: { speed: 0.92, accel: 0.88, grip: 0.78, handling: 0.85 },
    cockpitAccent: 0x8f1a22,
  },
  {
    id: "shirayuki",
    name: "SHIRAYUKI",
    jp: "白雪",
    blurb: "Executive sedan. Soft, stable, quietly quick.",
    shell: {
      L: 4.78, W: 1.82, ride: 0.36, nose: 0.56, tail: 0.6, belt: 0.9, roof: 1.44,
      hood: 1.1, trunk: 1.12, rakeF: 0.78, rakeR: 0.66, archR: 0.42, wzF: 1.44,
      wzR: 1.42, wheelR: 0.33, wheelWidth: 0.24, spoiler: null,
    },
    phys: {
      M: 1580, IZ: 2660, LA: 1.24, LB: 1.5, HCG: 0.54, TRACK: 1.57, WR: 0.33,
      FINAL: 3.45, RATIOS: [3.3, 1.98, 1.42, 1.08, 0.86, 0.72], REV: 3.55,
      TQ_R: [1000, 1800, 2600, 3400, 4200, 5000, 5800, 6600],
      TQ_T: [190, 260, 300, 315, 310, 295, 268, 225],
      gripF: 0.97, gripR: 1.06, steerMax: 0.56, steerHi: 0.023, steerAy: 17.5, revLimit: 6700, drag: 0.44,
    },
    stats: { speed: 0.78, accel: 0.68, grip: 0.74, handling: 0.62 },
    cockpitAccent: 0x3a5a8f,
  },
  {
    id: "tanuki",
    name: "TANUKI KEI",
    jp: "狸",
    blurb: "660cc of pure alleyway agility. The town is its home turf.",
    shell: {
      L: 3.14, W: 1.48, ride: 0.34, nose: 0.62, tail: 0.66, belt: 0.98, roof: 1.58,
      hood: 0.5, trunk: 0.36, rakeF: 0.52, rakeR: 0.3, archR: 0.36, wzF: 1.02,
      wzR: 0.98, wheelR: 0.27, wheelWidth: 0.18, spoiler: "roofcap",
    },
    phys: {
      M: 850, IZ: 1050, LA: 1.02, LB: 1.1, HCG: 0.52, TRACK: 1.3, WR: 0.27,
      FINAL: 4.4, RATIOS: [3.9, 2.3, 1.6, 1.2, 0.97, 0.82], REV: 4.15,
      TQ_R: [1000, 2200, 3400, 4600, 5400, 6200, 7000, 7800],
      TQ_T: [62, 88, 104, 112, 110, 104, 92, 74],
      gripF: 1.02, gripR: 1.0, steerMax: 0.72, steerHi: 0.032, steerAy: 20, revLimit: 8000, drag: 0.42,
    },
    stats: { speed: 0.42, accel: 0.5, grip: 0.7, handling: 0.95 },
    cockpitAccent: 0xc98f10,
  },
  {
    id: "okami",
    name: "OKAMI TOURER",
    jp: "狼",
    blurb: "AWD estate. Plants all four paws and launches into the rain.",
    shell: {
      L: 4.82, W: 1.86, ride: 0.36, nose: 0.56, tail: 0.72, belt: 0.92, roof: 1.46,
      hood: 1.14, trunk: 0.5, rakeF: 0.8, rakeR: 0.34, archR: 0.43, wzF: 1.42,
      wzR: 1.44, wheelR: 0.33, wheelWidth: 0.25, spoiler: "lip", hoodBulge: true,
    },
    phys: {
      M: 1650, IZ: 2840, LA: 1.28, LB: 1.44, HCG: 0.55, TRACK: 1.58, WR: 0.33,
      FINAL: 3.9, RATIOS: [3.6, 2.2, 1.54, 1.18, 0.94, 0.78], REV: 3.88,
      TQ_R: [1000, 2000, 2800, 3600, 4400, 5200, 6000, 6800],
      TQ_T: [210, 300, 350, 370, 360, 340, 305, 255],
      gripF: 1.04, gripR: 1.1, steerMax: 0.58, steerHi: 0.024, steerAy: 18.5, revLimit: 6900,
      drag: 0.46, awd: true,
    },
    stats: { speed: 0.82, accel: 0.8, grip: 0.92, handling: 0.7 },
    cockpitAccent: 0x2a5c40,
  },
];

export const getCar = (id: string) => CARS.find((c) => c.id === id) || CARS[0];
