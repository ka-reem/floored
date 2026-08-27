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
  /** Peak brake force at full pedal, N, before EBD splits it and ABS and the
   *  friction circle take their cut. Optional because every car in the roster
   *  wants the same pedal — see BRAKE_F. */
  brakeF?: number;
  awd?: boolean;
}

/** Defaults for the optional PhysicsSpec fields. They live next to the
 *  interface rather than inline in physics.ts so that anything DERIVING a
 *  spec from another one (testDriveSpec below) scales the same number the sim
 *  would have used, instead of quietly scaling a hardcoded 1. */
export const BRAKE_F = 16400;
export const STEER_AY = 19.5;

/* ---- Test mode ---------------------------------------------------------
   A dev toggle (K in engine.ts), not a difficulty and not a car: a way to
   cross the map, reach a corner, or stop at a landmark quickly while shaking
   the game out. Derived from whichever car is active rather than written out
   as a fifth spec, so it works for all four and cannot drift out of sync when
   someone retunes one of them.

   Why each multiplier is what it is:

   - gripF/gripR x1.6 — the ask ("super grippy"). This is the Pacejka D
     multiplier, so it scales peak tyre force without moving the slip angle
     that peak arrives at: the car holds far more, and still lets go at the
     same steering angle rather than turning into an ice rink at the limit.
   - brakeF x2 — required, not cosmetic. At stock grip the pedal (16400 N) is
     already about the whole tyre budget, so raising grip alone would leave
     braking exactly where it was and the extra grip would be invisible under
     the pedal. Doubling it puts the pedal above the raised tyre ceiling, so
     stopping goes back to being grip-limited (~2g) — which is what ABS and
     the friction ellipse in physics.ts are there to police.
   - TQ_T x1.8 and FINAL x0.86 — torque up for the shove, final drive taller
     so the extra torque buys top end instead of just arriving at the rev
     limiter sooner in top gear. Net wheel force is still ~1.55x in every
     gear. revLimit and RATIOS are deliberately untouched: revLimit is
     duplicated in the audio engine profile and cached by the tacho face in
     dashboard.ts, and neither should have to follow a dev toggle.
   - drag x0.85 — top speed set by the gearing, not by the air.
   - steerAy/steerHi x1.15, steerMax x1.1 — a deliberately small bump, and
     NOT the 1.6 the grip gets. The steering schedule hands out a steer ANGLE
     (dmax = steerAy*L/u², floored at steerHi), and the slip angle at which an
     axle saturates is a property of the Pacejka B/C curve, which grip does
     not move: raising D lets the tyre hold much more force at the same slip
     angle, but it does not let the rear axle survive a bigger one. Scaling
     the schedule with the grip therefore buys a tighter possible corner at
     the price of spinning on inputs that stock survives — measured, x1.5 put
     the kei car into a spin at half lock at 160 km/h, which stock takes. At
     x1.15 the failure boundary sits exactly where stock's does and every car
     still pulls ~30% more lateral at a given stick. The rest of the extra
     grip shows up as speed KEPT through a corner rather than angle: kaze at
     full lock at 45 m/s settles at 174 km/h against stock's 152. */
export function testDriveSpec(spec: PhysicsSpec): PhysicsSpec {
  return {
    ...spec,
    /* Second pass, deliberately arcade — "like No Hesi, where the cars drive
       like F1 cars". The numbers are no longer road-car plausible and are not
       meant to be; this is the toy mode.

       Grip x2.8 is the headline. Real downforce-era grip is ~3g against a
       road car's ~1.1g, so this is roughly the right ratio, and because it
       multiplies Pacejka's D it raises the ceiling without moving the slip
       angle the peak arrives at — the car takes far more and still lets go at
       the same stick position rather than turning to ice at the limit.

       Torque x3.2 with a 0.72 final drive: torque alone would just spin the
       tyres, and the shorter final is what turns it into speed rather than
       noise. Drag x0.6 lifts the top end, which is where the final drive
       would otherwise cost it.

       Brakes x4 are not optional at this grip. Braking force is capped by
       what the tyre can hold, so a pedal sized for stock grip is invisible
       under 2.8x tyres — the car would corner like an F1 car and stop like a
       saloon, which is the worst of both.

       Steering only x1.25/x1.4 — much less than the grip. The schedule hands
       out a steer ANGLE, and angle is what causes a spin: matching it to the
       grip multiplier would make half lock at speed an instant spin. Keeping
       it well under means the extra grip mostly shows up as speed KEPT
       through a corner rather than as a sharper turn-in. */
    TQ_T: spec.TQ_T.map((t) => t * 3.2),
    FINAL: spec.FINAL * 0.72,
    drag: spec.drag * 0.6,
    gripF: spec.gripF * 2.8,
    gripR: spec.gripR * 2.8,
    brakeF: (spec.brakeF ?? BRAKE_F) * 4,
    /* HCG (centre-of-gravity height) x0.55 is the important one, and it is a
       real physical parameter rather than a fudge: load transfer under
       braking is (M * ax * HCG) / LWB, so halving the CG height halves how
       much weight leaves the rear axle when you hit the pedal. That unloading
       is what drops the rear's lateral capacity mid-corner and spins the car
       — measured, every stock car spun at 50% brake in a 120 km/h corner, and
       raising grip alone did not help because it scales both axles equally
       and leaves the balance untouched. A car that corners like this one
       should sit that low anyway.

       steerAy is NOT boosted, and that is deliberate. The steer schedule is
       ay*L/u², so it opens UP as speed falls; boosting it meant that braking
       into a corner on a held stick fed the front ever more lock as the car
       slowed, and the yaw rate ran away — 0.50 to 1.76 rad/s in the trace.
       steerMax/steerHi still rise, so parking-speed and top-end authority are
       up without the mid-corner schedule getting sharper. */
    HCG: spec.HCG * 0.55,
    steerMax: spec.steerMax * 1.25,
    steerHi: spec.steerHi * 1.4,
  };
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
  /** In the garage, but not driveable yet: the card renders locked with a
   *  COMING SOON badge and nothing can select it. The spec below stays whole
   *  and untouched — the card still draws its own art from `shell` — so
   *  putting a car back on the roster is deleting this one line. getCar()
   *  treats a locked id exactly like an unknown one; see the note there. */
  comingSoon?: true;
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

/* ---- The two playable cars share ONE physics object -------------------
   "they drive the exact same. We're not going to worry about different
   driving or anything. They just both look different."

   So this is not two specs that happen to hold matching numbers — it is one
   spec, referenced twice. Copying the table would leave a retune of either car
   silently desyncing the pair, and the desync would be invisible until someone
   drove both back to back. Object identity also keeps engine.ts's testPhys
   memo (keyed on the spec object, not on the car id) from rebuilding a
   test-mode derivation that would come out identical anyway.

   Nothing mutates a PhysicsSpec — testDriveSpec() spreads into a new one — so
   the sharing is safe as well as cheap. Give one of the cars its own numbers
   the day they are meant to drive differently, and not before. */
const SHARED_PHYS: PhysicsSpec = {
  M: 1390, IZ: 2210, LA: 1.16, LB: 1.48, HCG: 0.5, TRACK: 1.56, WR: 0.325,
  FINAL: 3.7, RATIOS: [3.54, 2.13, 1.48, 1.15, 0.92, 0.76], REV: 3.82,
  TQ_R: [1000, 2000, 3000, 4000, 4600, 5400, 6200, 7200],
  TQ_T: [165, 235, 285, 320, 335, 330, 300, 248],
  gripF: 1.0, gripR: 1.04, steerMax: 0.62, steerHi: 0.026, steerAy: 20.5, revLimit: 6400, drag: 0.4,
};
/* And therefore ONE set of stat bars. The bars are a claim about how the car
   drives, and two cars on one PhysicsSpec drive identically — printing
   different bars on the two cards would be the garage lying about the only
   thing the bars are for. They separate the day the physics does. */
const SHARED_STATS = { speed: 0.92, accel: 0.88, grip: 0.78, handling: 0.85 };

export const CARS: CarSpec[] = [
  /* The default car, and the reason the roster is ordered this way: DEFAULT_CAR
     is derived as PLAYABLE_CARS[0] (see below), so "the Volvo is the default"
     is expressed by putting it first rather than by a second constant that
     could fall out of step with the list.

     This is the one car with imported art at BOTH ends — the donor cabin
     (player.ts COCKPIT_MODEL) and the donor exterior shell (BODY_MODEL) — so
     the shell below is not free invention: it is a real S90's box, 4.96 x 1.88
     x 1.44, which is what bodymodel.ts fits the donor to. Getting it right
     costs nothing and buys a near-identity scale where kaze's old numbers
     forced a 0.861 squash in y. wzF/wzR average to 1.47, half the donor's
     2.94 m wheelbase, which is what puts the game's own wheels in the donor's
     arches (see bodymodel.ts fit(): the axle midpoints are what it lines up).

     The shell still matters on its own account, and in three places rather
     than the two this used to list. It is the collision box and the physics
     box whatever is drawn on top. It is what the garage card renders FIRST —
     carpreview.ts now takes a second shot with the real bodywork once the GLB
     lands, but the procedural one is what goes up immediately and what stands
     if the fetch fails. And it is still the whole car wherever a donor is
     refused: a device that fails the cabin floor in settings.ts, or a player
     who set Imported cabin to Procedural. */
  {
    id: "volvo",
    name: "VOLVO S90",
    jp: "ボルボ",
    blurb: "Swedish executive saloon. Long, quiet, and hard to hurry.",
    shell: {
      L: 4.96, W: 1.88, ride: 0.36, nose: 0.58, tail: 0.62, belt: 0.92, roof: 1.44,
      hood: 1.24, trunk: 1.08, rakeF: 0.82, rakeR: 0.7, archR: 0.45, wzF: 1.5,
      wzR: 1.44, wheelR: 0.34, wheelWidth: 0.25, spoiler: null,
    },
    phys: SHARED_PHYS,
    stats: SHARED_STATS,
    /* Warm tan, and it has to be UNIQUE: cockpit.ts trimFor() falls back to
       inferring the interior trim from this colour when it does not recognise
       the car id. It does recognise "volvo" now, so this is only the belt to
       that braces — but a duplicate accent would still be a trap for the next
       car added. */
    cockpitAccent: 0xb08d57,
  },
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
    phys: SHARED_PHYS,
    stats: SHARED_STATS,
    cockpitAccent: 0x8f1a22,
  },
  {
    id: "shirayuki",
    comingSoon: true,
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
    comingSoon: true,
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
    comingSoon: true,
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

/** The cars the player may actually drive, in roster order. */
export const PLAYABLE_CARS = CARS.filter((c) => !c.comingSoon);

/** Where every bad or locked car id lands, and the car a new profile starts
 *  in. Derived rather than hardcoded to an id so that unlocking or reordering
 *  the roster cannot leave a stale
 *  default pointing at a car that is no longer first — or no longer playable.
 *  `|| CARS[0]` only matters if every car is ever marked comingSoon, which
 *  would be a bug; falling back to a driveable car beats crashing on load. */
const DEFAULT_CAR: CarSpec = PLAYABLE_CARS[0] || CARS[0];
export const DEFAULT_CAR_ID = DEFAULT_CAR.id;

/** Raw lookup that IGNORES the lock — for the garage art and card copy, which
 *  have to draw a COMING SOON car as itself rather than as the fallback.
 *  Never hand the result to the engine; use getCar() for anything driveable. */
export const carById = (id: string): CarSpec | undefined =>
  CARS.find((c) => c.id === id);

/** Is this an id the player is allowed to drive? game/settings.ts uses it to
 *  scrub a persisted carId on load. */
export const isPlayableCar = (id: string): boolean => {
  const c = carById(id);
  return !!c && !c.comingSoon;
};

/** DRIVEABLE lookup. A locked id falls back exactly like an unknown one: a
 *  profile written while the roster was four cars long can still hold
 *  carId:"tanuki", and the engine must never boot into a car the garage
 *  refuses to select. This is the downstream half of that guard — the profile
 *  loader scrubs the stored value too (game/settings.ts, loadProfile), for the
 *  same belt-and-braces reason the fovBase clamp in engine.ts spells out: a
 *  downstream clamp alone leaves the bad value in storage. */
export const getCar = (id: string): CarSpec => {
  const c = carById(id);
  return c && !c.comingSoon ? c : DEFAULT_CAR;
};
