import * as THREE from "three";
import { clamp, mulberry32, rrand, rrandi, TAU, type Rng } from "../util";
import { loadProfile, worldTierCaps } from "../settings";

/* Procedural aurora curtains, drawn straight onto the sky.
 *
 * Zero assets: the whole thing is one shader over a band of sphere, so it
 * costs nothing to download and nothing to build. Everything that gives a
 * given night its character — where the curtains hang, how wide, how bright,
 * which way the palette runs — is rolled from a seed, out of ranges narrow
 * enough that there is no bad roll.
 *
 * IT IS SUPPOSED TO BE OBVIOUS. The first cut of this was tuned for physical
 * plausibility and the answer that came back was "i dont see no aurora". The
 * levels here are now set for drama: peak radiance lands around 0.36 linear,
 * roughly 0.65 display luma, which is bright and unmissable while still
 * sitting under the ~0.8 where the grade starts eating hue. Soft is a rule,
 * faint never was.
 *
 * WHY IT IS AN "OPAQUE" MATERIAL. `transparent` is left false on purpose. It
 * still blends additively (three only skips blending for NormalBlending), but
 * the false flag keeps the mesh in the OPAQUE render list, where renderOrder
 * -9.6 puts it immediately after the sky dome (-10) and before every piece of
 * real geometry. That is the only ordering that occludes correctly here: the
 * mountains and the town write depth, so they paint over the curtains no
 * matter how far the car has driven from them — whereas a transparent mesh
 * would render after the opaque pass and have to fight a depth test against
 * a ridgeline that is world-fixed while this dome is glued to the car.
 *
 * FALLOFF (see the realistic-light skill). Every envelope here reaches exactly
 * zero with a zero derivative — (1-u²)^2.5 across the curtain, (1-v)^1.25 up
 * it — so nothing prints an edge. Overlapping curtains go through a
 * hue-preserving soft knee that asymptotes near 0.55 linear, so a crossing
 * gets brighter but can never bleach to a white core. The POV chain's black
 * crush (col-.06) lands at well under 1% of peak once the composite's 1/2.2
 * encode has stretched the tail, i.e. far below anything visible — the fade
 * dies of old age, not of a cutoff. And because the curtains are strongly
 * saturated, the POV sky pulldown (which gates on low saturation) leaves them
 * alone while it goes on crushing the grey haze around them.
 *
 * IT IS ALSO RARE. A curtain every single night is the one thing that makes
 * an aurora stop reading as an event, so a night only gets one about 30% of
 * the time (AURORA_CHANCE). The draw is deterministic — world seed × night
 * index, no Math.random() — so a seed always replays the same run of skies
 * and "seed 47 opened beautifully" is a thing that can be handed to someone
 * else. See the NIGHT BOUNDARY block in update() for what counts as a night.
 *
 * AND THE OTHER 70% STILL HAVE A SKY. Airglow and the galaxy are drawn by
 * this same shader on every clear night whether or not there are curtains —
 * they are not weather, they are always up there, and without them a
 * no-aurora night is a black dome with 1100 dots on it. They are faint by
 * design (a few percent of a curtain's peak): __aurora.skyGain is the knob.
 *
 * LIVE PREVIEW. window.__aurora exposes
 * { roll, gain, skyGain, chance, present, nightIndex, reroll, next, auto,
 *   lock } — see the block comment on the returned object.
 */

/** Master kill-switch. */
export const FX_AURORA = true;

/** Odds that any given night gets curtains at all.
 *
 *  Live-tunable at runtime as `__aurora.chance`; this is only the default.
 *  Rarity is the whole point of the setting — see the header. */
export const AURORA_CHANCE = 0.3;

/** dayFactor at or above which we call it "full daylight", which is where the
 *  nightly re-roll happens. Two things have to be true at that mark and both
 *  are: the curtains are already at exactly zero (aurora's own night curve
 *  hits 0 at dayFactor 1/1.35 ≈ 0.74), and the cloud deck has already blended
 *  fully to its daytime grey (nightclouds' uDay saturates at dayFactor 0.8).
 *  So swapping the whole sky here — presence, palette, band layout, the cloud
 *  tint that rides it — changes nothing anybody can see. */
const DAY_MARK = 0.8;

/** Curated hue triples: hem colour → body colour → crown colour.
 *
 *  `lo` is what the dashcam mostly sees (the frame tops out around 23° of
 *  elevation, which is the lower half of a curtain), so the body carries the
 *  impression, the crown is the accent above it, and `hem` — new — is the few
 *  degrees right at the bottom border. `hem` is optional and defaults to the
 *  body, which is the normal case: most curtains do not have a differently
 *  coloured hem, and the ones that do are the violent ones.
 *
 *  AURORA COLOUR IS EMISSION LINES, NOT TASTE. Every entry below is one of
 *  four transitions, in the proportions the sky actually produces them:
 *
 *    557.7 nm  atomic oxygen, 100-250 km.  THE green. Long-lived state, so
 *              it only survives where collisions are rare — which is why it
 *              is the body of nearly everything here, and why the weights
 *              are stacked on green so hard. A sky where an exotic magenta
 *              is as likely as green is a pretty sky and a false one.
 *    630.0 nm  atomic oxygen, >200 km.  Even longer-lived, so it needs even
 *              thinner air: this is a CROWN colour, above the green, never
 *              under it. Diffuse and weak except in big storms.
 *    427.8 nm  ionised molecular nitrogen. Two homes: the sharp LOWER border
 *              of a hard-precipitation curtain, and the sunlit tops of rays
 *              reaching into daylight — which is a twilight phenomenon, i.e.
 *              exactly the hour this game opens on.
 *    ~660 nm   neutral nitrogen first-positive. The pink/magenta HEM under an
 *              active green curtain, and only during strong storms.
 *
 *  Weights: green-bodied entries carry 34 of 37, so ~92% of the auroras that
 *  do happen are green-based. The three that are not are the low-latitude
 *  oddities, at the rate they are odd. */
const PALETTES: { name: string; w: number; hem?: number[]; lo: number[]; hi: number[] }[] = [
  /* The quiet homogeneous arc: 557.7 and nothing else, paling toward yellow-
     green at the top where a trace of 630 starts to mix in. This is what an
     aurora looks like the overwhelming majority of the time, so it is the
     overwhelming majority of the table's weight. */
  { name: "arc", w: 10, lo: [0.16, 0.95, 0.46], hi: [0.55, 0.98, 0.34] },
  /* Active display: 630 nm oxygen red crowning the green. The crossover
     between them passes through amber rather than grey (see the tint
     renormalise in the shader) — which is exactly what the overlap of the
     two oxygen lines does on a real frame. */
  { name: "crown", w: 7, lo: [0.16, 0.95, 0.46], hi: [0.98, 0.17, 0.13] },
  /* The same two lines with the red pushed down into the body, so the whole
     curtain sits in the amber overlap. Strong-substorm look. */
  { name: "solar", w: 3, lo: [0.50, 0.95, 0.32], hi: [0.98, 0.42, 0.24] },
  /* G3+ storm curtain: all three altitudes at once — neutral-nitrogen pink
     hem at 90-100 km, oxygen green body, oxygen red crown. The hem is the
     part the dashcam is best placed to see, since the frame is looking at the
     bottom of the curtain in the first place. */
  { name: "storm", w: 3, hem: [0.98, 0.26, 0.54], lo: [0.18, 0.95, 0.44], hi: [0.96, 0.20, 0.22] },
  /* The original crimson-crowned green, kept: same physics as "crown" with a
     pinker red, which is what 630 looks like once a little 660 nitrogen is
     mixed into it. */
  { name: "classic", w: 3, lo: [0.16, 0.95, 0.46], hi: [0.95, 0.20, 0.34] },
  /* Sunlit rays: the tops of the rays are high enough to still be in sunlight
     while the ground is dark, and resonance-scattered N2+ turns them blue-
     violet above the green. A twilight effect, which is the hour this game
     starts at. */
  { name: "sunlit", w: 2, lo: [0.18, 0.94, 0.50], hi: [0.40, 0.32, 0.98] },
  /* Hard precipitation: the same N2+ band at the sharp LOWER border instead,
     where the beam is finally dense enough to ionise nitrogen. Blue-violet
     hem under a green curtain. */
  { name: "border", w: 2, hem: [0.36, 0.34, 0.98], lo: [0.16, 0.95, 0.46], hi: [0.62, 0.98, 0.42] },
  /* Kept: green with a 427.8-tinted body, i.e. the two mixing through the
     whole curtain rather than separating by altitude. */
  { name: "arctic", w: 2, lo: [0.16, 0.86, 0.82], hi: [0.34, 0.42, 0.98] },
  /* Kept. */
  { name: "jade", w: 2, lo: [0.26, 0.95, 0.60], hi: [0.30, 0.76, 0.98] },
  /* Type-A red aurora / SAR arc: 630 nm alone, no green at all, because the
     precipitation is too soft to reach the altitude green lives at. Seen from
     far south of the oval during great storms, which is where a highway is —
     but rare, so weight 1. */
  { name: "ruby", w: 1, hem: [0.86, 0.14, 0.16], lo: [0.97, 0.22, 0.20], hi: [0.98, 0.44, 0.38] },
  /* Kept: 660 nm nitrogen pink over 427.8 violet, the top end of a severe
     storm with the oxygen green swamped. */
  { name: "ember", w: 1, lo: [0.95, 0.30, 0.72], hi: [0.52, 0.34, 0.98] },
  /* Kept. */
  { name: "violet", w: 1, lo: [0.72, 0.44, 0.98], hi: [0.94, 0.30, 0.80] },
];

/** What the cloud deck is lit by on a night with NO curtains — which is now
 *  most nights, so this matters more than any single aurora palette does.
 *
 *  nightclouds.tint() takes the crown hue for the lit rim and the body hue
 *  for the shadow, so this is "moonlight above, deep blue below": a cool
 *  silver rim on the edges of the deck and a navy in its cores. It is
 *  deliberately not grey — a real moonlit cloud edge is blue-white because
 *  moonlight is sunlight, and a genuinely neutral rim is the one thing the
 *  POV grade's sky pulldown (which gates on low saturation) would crush. */
const MOONLIT_LO = [0.42, 0.56, 0.98];
const MOONLIT_HI = [0.66, 0.76, 0.98];

export interface AuroraRoll {
  seed: number;
  palette: string;
  bands: number;
  /** does this night have curtains at all, or only airglow and the galaxy */
  present: boolean;
  /** which in-game night this is, counting from world build */
  night: number;
  /** the night's draw, 0..1 — an aurora happens when this is under `chance`,
      so it doubles as "how close tonight was to having one" */
  odds: number;
  /** per band, for eyeballing from the console */
  detail: { azDeg: number; widthDeg: number; baseDeg: number; amp: number }[];
}

export interface Aurora {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** the sky currently on screen */
  roll: AuroraRoll;
  /** What is lighting the sky tonight, as a body/crown pair. On an aurora
      night that is the curtains' own palette; on the ~70% with none it is
      moonlight. The cloud deck tints itself from these, so the two layers read
      as one sky rather than two effects — and so a clear night's clouds are
      lit by the moon rather than by an aurora that is not there.
      MUTATED IN PLACE, never reassigned: sky.ts holds these references. */
  palLo: THREE.Vector3;
  palHi: THREE.Vector3;
  /** set by sky.ts: fires whenever the lighting palette changes — a nightly
      re-roll, a reroll(), or presence flipping under a live `chance` edit */
  onPalette?: (lo: THREE.Vector3, hi: THREE.Vector3) => void;
  /** live brightness multiplier on the CURTAINS, 1 = as shipped. Read every
      frame. 0 no longer blanks the mesh — airglow and the galaxy are their
      own layer now; use `skyGain = 0` for those. */
  gain: number;
  /** live multiplier on the always-on airglow + galaxy layer, 1 = as shipped.
      This is what 70% of nights are made of, so it is the knob to reach for
      when a no-aurora night reads as too empty or too milky. */
  skyGain: number;
  /** 0..1 odds that a night has curtains. Re-tested against the night's stored
      draw every frame, so `__aurora.chance = 1` turns tonight on immediately
      (over a ~1.4 s fade, not a cut) and `= 0` turns it off. */
  chance: number;
  /** whether curtains are up tonight */
  present: boolean;
  /** in-game nights since the world was built */
  nightIndex: number;
  /** swap in a different sky immediately AND force it visible; omit the seed
      for a random one. Pins the sky — the nightly cycle stops until auto(). */
  reroll(seed?: number): AuroraRoll;
  /** step to the next seed in sequence — for flicking through rolls. Also
      forces the aurora on, so this walks palettes and never empty skies. */
  next(): AuroraRoll;
  /** drop the pin from reroll()/next()/?aurora= and rejoin the nightly cycle,
      re-rolling the current night from the world seed */
  auto(): AuroraRoll;
  /** print how to pin the sky currently on screen */
  lock(): string;
  /** driven from engine.weather(): monotonic seconds, dayFactor, fog multiplier */
  update(now: number, dayF: number, fogMul: number): void;
}

const v3 = (c: number[]) => new THREE.Vector3(c[0], c[1], c[2]);

/** Small per-band hue jitter that CANNOT wash a colour out: the channels move
 *  a little, then the whole triple is rescaled so its brightest channel is 1
 *  again. Nudging RGB without that rescale walks every colour toward grey,
 *  which is the one direction none of these are allowed to go. */
function jitterHue(rng: Rng, c: THREE.Vector3): THREE.Vector3 {
  const k = c.clone();
  k.x = clamp(k.x + rrand(rng, -0.07, 0.07), 0.02, 1);
  k.y = clamp(k.y + rrand(rng, -0.06, 0.06), 0.02, 1);
  k.z = clamp(k.z + rrand(rng, -0.08, 0.08), 0.02, 1);
  return k.multiplyScalar(1 / Math.max(k.x, k.y, k.z));
}

/** `?aurora=<n>` — pin one exact sky, forced visible, for the whole session.
 *  Returns null when the parameter is absent or junk. This is what lock()
 *  prints, so it has to reproduce the roll AND override the rarity draw: a
 *  pinned link that lands on an empty sky 70% of the time is not a pin. */
function pinnedSeed(): number | null {
  try {
    if (typeof location !== "undefined") {
      const q = new URLSearchParams(location.search).get("aurora");
      if (q !== null && q !== "" && Number.isFinite(+q)) return Math.floor(+q) >>> 0;
    }
  } catch {
    /* malformed URL — fall through to the nightly cycle */
  }
  return null;
}

/** The world seed, which everything else in the world already derives from.
 *
 *  The first cut of this file deliberately did NOT ride the world seed — a
 *  fresh aurora every run was the point, so it used Math.random(). That trade
 *  stops making sense the moment the aurora is rare: with 70% of nights empty,
 *  a sky you liked is a sky you can never get back, and "seed 47 opened
 *  beautifully" has to be a sentence someone can act on. Variety comes from
 *  the night index instead (a new sky every in-game night, ~9.6 real minutes
 *  at the default time rate), which gives MORE different skies per session
 *  than one random draw at startup ever did — just reproducibly. */
function worldSeed(): number {
  try {
    return loadProfile().seed >>> 0;
  } catch {
    /* no localStorage (SSR, locked-down browser) — the default profile's */
    return 1987;
  }
}

/** Stateless integer avalanche: (seed, night, salt) → uint32.
 *
 *  Two independent salts are drawn per night — one for "is there an aurora",
 *  one for "what does it look like". Reusing a single hash for both would
 *  confine every aurora that ever appears to the bottom `chance` slice of the
 *  hash space, and the palette pick is a deterministic function of that seed,
 *  so the table's weights would quietly stop meaning what they say. */
function hash32(seed: number, night: number, salt: number): number {
  let h = (seed ^ Math.imul(night + 1, salt)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}
const SALT_ODDS = 0x9e3779b1;
const SALT_SKY = 0x85ebca6b;

export function buildAurora(seedIn?: number): Aurora {
  const caps = worldTierCaps();

  /* Band count is FIXED per tier, not rolled. It is what guarantees coverage:
     the widths below are derived from the spacing, so N evenly spaced bands
     always overlap and the whole compass is lit. Leaving the count (and so
     the spacing) to chance is how the first cut ended up with skies whose
     only good curtain was behind the car — and the dashcam only ever looks
     forward, through about 105° of it. A sky that reads only if you happen to
     be pointed at it is a sky that mostly does not read.

     Because the count is fixed, it is also safe to bake into the shader as a
     #define, which is what lets reroll() swap the whole sky by writing
     uniforms — no recompile, no hitch, live from the console. */
  const NB = caps.tier === "mobile-base" ? 2 : caps.tier === "mobile-high" ? 3 : 4;

  /* What the CLOUD DECK is handed (sky.ts wires these into clouds.tint()).
     Not necessarily the aurora's own palette any more: on a night with no
     curtains the deck is lit by the moon, not by an aurora, so these carry
     MOONLIT_* instead. Held as one pair of objects for the deck's whole life
     — sky.ts copies out of them, so they must be mutated, never replaced. */
  const cloudLo = new THREE.Vector3(), cloudHi = new THREE.Vector3();
  const bandA: THREE.Vector4[] = [];
  const bandB: THREE.Vector4[] = [];
  const colHem: THREE.Vector3[] = [];
  const colLo: THREE.Vector3[] = [];
  const colHi: THREE.Vector3[] = [];
  for (let i = 0; i < NB; i++) {
    bandA.push(new THREE.Vector4());
    bandB.push(new THREE.Vector4());
    colHem.push(new THREE.Vector3());
    colLo.push(new THREE.Vector3());
    colHi.push(new THREE.Vector3());
  }
  /* The always-on layer's per-night parameters: which way the airglow ripples
     run, how much sodium is in the layer tonight, and where the galactic
     plane is sitting. Rolled with everything else so a seed replays them. */
  const airDir = new THREE.Vector2(1, 0);
  const airCol = new THREE.Vector3(0.3, 0.92, 0.54);
  const galN = new THREE.Vector3(0, 1, 0);
  const galT = new THREE.Vector3(1, 0, 0);
  const galB = new THREE.Vector3(0, 0, 1);
  const UP_Y = new THREE.Vector3(0, 1, 0), UP_X = new THREE.Vector3(1, 0, 0);

  /* The palette the CURTAINS are wearing, kept so the cloud deck can be
     re-tinted without re-rolling when only presence changes. */
  let palBody = PALETTES[0].lo, palCrown = PALETTES[0].hi;

  /** Fill the uniform arrays from a seed. Mutates in place so the material
   *  never has to be rebuilt. */
  function applyRoll(seed: number): AuroraRoll {
    const rng: Rng = mulberry32(seed);
    // weighted palette draw — see the table: green-bodied entries carry 92%
    const total = PALETTES.reduce((a, p) => a + p.w, 0);
    let pick = rng() * total;
    let pal = PALETTES[0];
    for (const p of PALETTES) {
      pick -= p.w;
      if (pick <= 0) { pal = p; break; }
    }
    palBody = pal.lo;
    palCrown = pal.hi;
    const palHem = v3(pal.hem ?? pal.lo), palLo = v3(pal.lo), palHi = v3(pal.hi);

    /* One or two curtains carry the composition and the rest support them.
       Equal-brightness bands read as wallpaper; a clear hero reads as
       weather. Support bands are still bright enough to see on their own —
       "support" here means half the hero, not invisible. */
    const heroes = rrandi(rng, 1, Math.min(2, NB));
    const heroAt = rrandi(rng, 0, NB - 1);
    const rot = rrand(rng, 0, TAU);
    const detail: AuroraRoll["detail"] = [];

    for (let i = 0; i < NB; i++) {
      const az = rot + (i / NB) * TAU + rrand(rng, -0.28, 0.28);
      /* Half-width is derived from the spacing, never drawn free, so there is
         no direction with no aurora in it. Pulled back from 0.62–0.95 of the
         gap: that much overlap had every band summing with its neighbours
         everywhere, and the sum of several soft envelopes is a smooth wash —
         the structure was being averaged away between the bands, not inside
         them. They still overlap, just at the tails. */
      const halfW = (TAU / NB) * rrand(rng, 0.55, 0.80);
      /* SIZED TO THE DASHCAM'S SKY WINDOW, which is small and low.
         POV_HFOV 105° at 16:9 gives a 72.5° vertical frame; POV_TILT cants it
         13° nose-down, so the top edge sits at 36.24 - 13.0 = 23.2° of
         elevation and everything below the horizon is road. (Caveat worth
         knowing: engine.ts sets camera.rotation.y then .x under three's
         default XYZ Euler order, which applies pitch about the WORLD x axis —
         so the 13° is a true nose-down cant only when the camera's yaw is
         near 0. Half a lap later the same numbers pitch the frame 13° UP and
         the window becomes 0…49°. These ranges are chosen to read across the
         union of the two.)

         A curtain therefore has to be SHORT. The first cut spanned 2°…68°,
         of which only the bottom third was ever on screen — the player got
         the dim monochrome foot of an aurora and none of the structure. The
         whole thing now lives inside roughly 3°…30°: foot, body, colour
         crossover and crown all fit in the window. The top fade reaches zero
         with zero derivative, so a curtain that ends inside the frame still
         dissolves rather than printing a stripe. */
      const baseY = rrand(rng, 0.05, 0.10);
      const hgt = rrand(rng, 0.32, 0.48);
      const isHero = ((i - heroAt) % NB + NB) % NB < heroes;
      const amp = isHero ? rrand(rng, 0.55, 0.78) : rrand(rng, 0.30, 0.46);
      bandA[i].set(az, halfW, baseY, hgt);
      bandB[i].set(amp, rrand(rng, 0.6, 1.4), rrand(rng, 0, 40), rrand(rng, 16, 28));
      /* Every band in a night shares one palette and only jitters around it.
         That is what keeps a sky harmonious: three independently drawn hues
         eventually roll green next to orange next to blue. */
      colHem[i].copy(jitterHue(rng, palHem));
      colLo[i].copy(jitterHue(rng, palLo));
      colHi[i].copy(jitterHue(rng, palHi));
      detail.push({
        azDeg: Math.round((((az % TAU) + TAU) % TAU) * (180 / Math.PI)),
        widthDeg: Math.round(halfW * 2 * (180 / Math.PI)),
        baseDeg: Math.round(Math.asin(baseY) * (180 / Math.PI)),
        amp: +amp.toFixed(3),
      });
    }

    /* ---- the always-on layer, rolled with the rest so a seed replays it ----
       These are drawn LAST from the same stream so that adding them did not
       have to disturb the band layout any earlier seed produces. */

    /* Airglow ripple direction. Gravity waves march across the layer in long
       parallel crests; which way they run is arbitrary, so it is rolled. */
    const aa = rrand(rng, 0, TAU);
    airDir.set(Math.cos(aa), Math.sin(aa));
    /* Airglow hue. The 557.7 nm oxygen line dominates, but the sodium-D layer
       sits in the same shell at 90 km and its column varies a lot night to
       night (it is meteor ablation product), so the band's green walks toward
       amber rather than being one fixed colour forever. */
    const na = rng();
    airCol.set(0.30 + na * 0.34, 0.92 - na * 0.05, 0.54 - na * 0.16);

    /* The galactic plane. What is rolled is its POLE; the band is the great
       circle perpendicular to it, so a pole 32-64° up puts the band's highest
       point at 26-58°. That is the range where it crosses the dashcam's
       3…30° window on a diagonal — a pole at the zenith would lay the band
       flat along the horizon (where the skyline eats it) and a pole on the
       horizon would stand it straight up out of frame. */
    const gEl = rrand(rng, 0.56, 1.12), gAz = rrand(rng, 0, TAU);
    galN.set(Math.cos(gEl) * Math.cos(gAz), Math.sin(gEl), Math.cos(gEl) * Math.sin(gAz));
    // any orthonormal pair in the plane; the shader only uses them as a
    // seam-free coordinate to sample noise along the band
    galT.copy(Math.abs(galN.y) < 0.95 ? UP_Y : UP_X).cross(galN).normalize();
    galB.copy(galN).cross(galT);

    return { seed, palette: pal.name, bands: NB, present: true, night: 0, odds: 0, detail };
  }

  /** Hand the cloud deck the light it is actually under: the aurora's own
   *  palette when there are curtains, moonlight when there are not. */
  function cloudPalette(present: boolean) {
    cloudLo.fromArray(present ? palBody : MOONLIT_LO);
    cloudHi.fromArray(present ? palCrown : MOONLIT_HI);
  }

  /* Geometry: the slice of sphere the curtains can occupy, so the fragment
     shader never runs on sky that has no aurora in it. dir.y from -0.06 (a
     shade under the horizon, so the bottom fade has somewhere to die) up to a
     closed cap at the zenith, which cannot seam. Radius sits inside the 2800
     sky dome; with depthTest off it is only ever a direction. */
  const yBot = -0.06;
  const geo = new THREE.SphereGeometry(2600, 64, 22, 0, TAU, 0, Math.acos(yBot));

  const mat = new THREE.ShaderMaterial({
    defines: { NB, LOWQ: caps.tier === "mobile-base" ? 1 : 0 },
    uniforms: {
      uTime: { value: 0 },
      /** night × fog: gates the WHOLE mesh, curtains and always-on layer both */
      uAmt: { value: 1 },
      /** curtains only — presence (0 on a no-aurora night) × gain */
      uCur: { value: 1 },
      /** airglow + galaxy only — skyGain */
      uSky: { value: 1 },
      uBandA: { value: bandA },
      uBandB: { value: bandB },
      uColHem: { value: colHem },
      uColLo: { value: colLo },
      uColHi: { value: colHi },
      uAirDir: { value: airDir },
      uAirCol: { value: airCol },
      uGalN: { value: galN },
      uGalT: { value: galT },
      uGalB: { value: galB },
    },
    vertexShader: `varying vec3 vDir;
void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `precision highp float;
varying vec3 vDir;
uniform float uTime,uAmt,uCur,uSky;
uniform vec4 uBandA[NB],uBandB[NB];
uniform vec3 uColHem[NB],uColLo[NB],uColHi[NB];
uniform vec2 uAirDir;
uniform vec3 uAirCol,uGalN,uGalT,uGalB;

// sin-free hash: this runs over a large slab of the frame, and the classic
// fract(sin(...)) version costs a transcendental per corner per octave
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
 return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float s=vn(p)*.52; p*=2.03; s+=vn(p)*.30;
#if LOWQ == 0
 p*=2.07; s+=vn(p)*.16;
#endif
 return s; }

void main(){
 // daylight costs one coherent branch and nothing else
 if(uAmt<=.002){ gl_FragColor=vec4(0.,0.,0.,1.); return; }
 vec3 d=normalize(vDir);
 float ey=d.y;
 vec3 acc=vec3(0.);
 /* The last degree or two is haze and silhouette, not sky. Shared by the
    curtains and the always-on layer so both dissolve into the same horizon.
    Kept as a genuine smoothstep so nothing ever prints a line, but tight:
    on a 23° window the old .010–.075 ramp (0–4.3°) was spending a fifth of
    everything the player can see on a fade. Fully lit by 2.4° now, and the
    skyline ring tops out at 7.8° so it occludes most of that zone anyway. */
 float lowF=smoothstep(.008,.042,ey);
 /* ================= AURORA CURTAINS =================
    Skipped whole on the ~70% of nights with no aurora, which makes those
    nights CHEAPER than an aurora night rather than merely emptier: one
    coherent branch drops NB×6 noise evaluations per fragment. */
 if(uCur>.002){
 float az=atan(d.z,d.x);
 for(int i=0;i<NB;i++){
  vec4 A=uBandA[i],B=uBandB[i];
  // signed shortest angle to the curtain's centre, wrapped
  float da=az-A.x; da-=6.2831853*floor(da/6.2831853+.5);
  float u=da/A.y;                       // -1 … 1 across the curtain
  // (1-u^2)^2.5 : flat through the middle, zero WITH zero slope at both
  // edges, so the curtain has no side you can point at
  float t=uTime*B.y;
  /* One fbm does two jobs. It snakes the curtain's lower hem, AND it warps
     the curtain sideways as it climbs — the DOMAIN WARP is what folds a flat
     band into something with depth in it. Without this the silhouette is a
     smooth arc and no amount of detail inside it stops the whole thing
     reading as a gradient. */
  float n0=fbm(vec2(u*1.9+B.z+t*.03,t*.019));
  float sway=(n0-.5)*A.w*.36;
  float uw=u+(n0-.5)*.30;
  // (1-u^2)^2.5 : flat through the middle, zero WITH zero slope at both
  // edges, so the curtain has no side you can point at
  float q=max(0.,1.-uw*uw); float env=q*q*sqrt(q);
  /* A NARROW structureless skirt. This used to be wide and heavily weighted,
     and it was the single biggest reason the sky read as a cheap gradient:
     a smooth featureless wash laid over everything, filling the gaps the
     structure was supposed to leave. It is airglow now, not the main event. */
  float qw=max(0.,1.-uw*uw*.55); float skirt=qw*qw;
  float v=(ey-(A.z+sway))/A.w;          // 0 at the border, 1 at the top
  /* A DEFINED lower hem, then a slow decelerating fade that still reaches
     exactly zero at the top. The crisp hem is the most recognisable thing
     about a real curtain and the rise was twice as soft as it should be —
     but it is still a smoothstep, ramping over ~2.3° of elevation (about 17
     px at 540p), so it reads as a hem and never as a line. */
  float vp=smoothstep(0.,.10,v)*pow(max(0.,1.-v),1.25);
  /* RIDGED filaments, not smooth noise. 1-|2n-1| turns a blurry hill into a
     sharp crest with dark lanes either side, which is the whole difference
     between "rays" and "a gradient with some wobble in it". Two octaves,
     sheared with height so they lean, dissolving into the crown glow near
     the top the way real rays diffuse. */
  vec2 rp=vec2(uw*B.w+B.z+t*.55+v*1.6,v*.7+t*.12);
  float f1=vn(rp), f2=vn(rp*2.7+11.);
  float fil=pow(1.-abs(f1*2.-1.),1.7)*.72+(1.-abs(f2*2.-1.))*.28;
  fil=.18+.82*fil;                      // dark lanes to 18%, not to grey
  fil=mix(fil,1.,smoothstep(.45,.95,v));
  /* Patchiness — bright stretches and stretches where it has almost gone.
     A band of even brightness end to end is the loudest possible tell that
     something is a gradient and not weather. Doubles as the slow breathing
     that keeps a parked car from seeing a frozen decal. */
  // (named pat, not patch: patch is a reserved word in GLSL ES)
  float pat=.15+.85*smoothstep(.22,.78,vn(vec2(uw*1.5+B.z*3.+t*.06,t*.04)));
  float w=(env*fil+skirt*.12)*vp*pat*B.x;
  /* THREE COLOURS BY HEIGHT — hem, body, crown — because that is three
     different gases at three different altitudes, not a gradient anyone
     picked. Neutral-nitrogen pink (or ionised-nitrogen violet) at the 90-100
     km lower border, oxygen green through the 100-250 km body, oxygen red
     above 200 km.

     THE HEM matters more here than it would anywhere else, because the
     dashcam window starts at 3° and the hem lands around 4…8°: on most frames
     it is the part of the curtain nearest the middle of the screen. Palettes
     without one set hem = body and this first mix is a no-op, which is the
     common case — a quiet arc is one colour top to bottom. */
  float hemW=1.-smoothstep(.02,.26,v);
  vec3 body=uColLo[i]*(1.-hemW*.80)+uColHem[i]*(hemW*1.20);
  body/=max(max(body.r,max(body.g,body.b)),1e-4);
  /* NEITHER crossover is a straight lerp, and for the same reason both times.
     The stops are often near-complementary (the iconic green floor under a
     crimson crown; pink hem under green), and an RGB lerp between complements
     passes through grey — the exact muddy sky the palettes exist to prevent.
     Renormalising to unit max channel instead means the crossover changes HUE
     at constant level: it brightens through the pale zone a real green/red
     overlap actually is, rather than dipping into a grey band. Both
     transitions are kept TIGHT so those zones are seams and not half the sky,
     and the crown one is placed against the COMPRESSED band so it lands
     mid-windscreen — body colour below about 12° of elevation, crossover
     through ~18°, crown above that, all of it inside the frame instead of
     above it. Level stays entirely the vertical envelope's business. */
  float hw=smoothstep(.34,.62,v);
  vec3 tint=body*(1.-hw*.85)+uColHi[i]*(hw*1.25);
  tint/=max(max(tint.r,max(tint.g,tint.b)),1e-4);
  acc+=tint*w;
 }
 acc*=lowF;
 /* Hue-preserving soft knee. Near-linear where a single curtain lives, so
    raising the amplitude actually raises what you see, and firm enough at the
    top that overlapping curtains asymptote around 0.55 linear — bright, and
    still under the level where ACES would bleach the colour out of the core.
    The earlier 1/(1+m*1.45) was the thing quietly flattening every peak. */
 float m=max(acc.r,max(acc.g,acc.b));
 acc*=uCur/(1.+m*.50+m*m*.42);
 }
 /* ================= THE SKY THAT IS ALWAYS THERE =================
    Neither of these is an aurora and neither is rare: airglow and the galaxy
    are up every clear night of the year, and on the nights with no curtains
    they are the only structure in the upper half of the frame. They are FAINT
    on purpose — a few percent of a curtain's peak — because the job is to
    stop the dome reading as flat black, not to fake an aurora out of it. */
 if(uSky>.002){
  vec3 glow=vec3(0.);
  /* AIRGLOW. Chemiluminescence in a thin shell at 87-97 km: mostly the same
     557.7 nm oxygen line as the aurora's body (plus the sodium-D layer, which
     is what the warmer rolls of uAirCol stand in for), but continuous and
     global rather than driven by precipitation.
     It is a BAND, not a floor. Looking toward the horizon cuts a long chord
     through a thin shell, so brightness climbs as you look down — until the
     atmosphere underneath absorbs it and it dies. Gaussian about 9° with the
     same horizon fade the curtains use. */
  float b=(ey-.16)/.34;
  float agV=exp(-b*b*1.6)*lowF;
  /* The layer is a SHELL, so its own coordinates are a plane at altitude —
     the same perspective divide the cloud deck uses, for the same reason:
     without it the ripples are evenly sized all the way down and read as a
     texture painted on a dome. Clamped away from the singularity at ey=0. */
  vec2 ap=d.xz/max(ey,.07)*.30;
  /* Gravity-wave banding, which is airglow's whole visual signature: long
     parallel crests rolling through the layer. A sine along one rolled
     direction, its phase kicked by noise so the bands bend and break up
     instead of ruling straight lines across the sky. */
  float rip=.60+.40*sin(dot(ap,uAirDir)*2.3+vn(ap*.45+vec2(uTime*.004,0.))*4.);
  float agN=.45+.55*vn(ap*.18+vec2(uTime*.0026,uTime*.0017));
  glow+=uAirCol*(agV*rip*agN*.024);
#if LOWQ == 0
  /* THE GALAXY: a great circle of unresolved starlight with the local arm's
     dust cut through it. Faint enough that the POV grade's sky pulldown eats
     most of it — which is exactly what a cheap sensor does to the Milky Way —
     but it gives the empty half of the sky a direction and an edge instead of
     a uniform black. */
  float gd=dot(d,uGalN);              // 0 exactly on the galactic plane
  float core=exp(-gd*gd*95.);         // the bright lane, ~±6°
  float halo=exp(-gd*gd*13.);         // the diffuse envelope, ~±16°
  /* Sampled on the CIRCLE the plane cuts through the sky. That path is closed
     and continuous, so the mottling wraps with no seam anywhere — sampling
     azimuth directly would leave a visible discontinuity at ±pi. */
  vec2 gc=vec2(dot(d,uGalT),dot(d,uGalB))*3.4;
  float mott=.35+.65*vn(gc+gd*2.2);
  float rift=smoothstep(.30,.68,vn(gc*.62+19.7));   // the dark dust lanes
  glow+=vec3(.74,.80,1.)*((core*(.30+.70*rift)+halo*.34)*mott*lowF*.030);
#endif
  acc+=glow*uSky;
 }
 acc*=uAmt;
 // the sky is the smoothest thing in the frame, so 8-bit banding shows here
 // first — a sub-LSB hash dither costs nothing and removes it. It is also
 // what keeps the airglow band, which peaks at ~2% of a curtain, from
 // arriving as three visible steps.
 acc+=(h21(gl_FragCoord.xy+fract(uTime))-.5)*.0035;
 gl_FragColor=vec4(max(acc,vec3(0.)),1.);
}`,
    blending: THREE.AdditiveBlending,
    // deliberately NOT transparent — see the header comment
    transparent: false,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    fog: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -9.6; // straight after the sky dome, before all geometry
  mesh.frustumCulled = false;

  const announce = (r: AuroraRoll) => {
    try {
      console.log(
        r.present
          ? `night ${r.night}: aurora #${r.seed} · ${r.palette} · ${r.bands} bands` +
            `  —  __aurora.next() for another, __aurora.lock() to keep this one`
          : `night ${r.night}: no aurora (rolled ${r.odds.toFixed(2)} vs chance ` +
            `${api.chance})  —  __aurora.next() to force one, __aurora.chance = 1 ` +
            `for every night`
      );
    } catch {
      /* no console — the sky still renders */
    }
    return r;
  };

  /* PINNED vs NIGHTLY. `pinned` freezes the nightly cycle and forces the
     curtains on: it is what `?aurora=<n>`, reroll() and next() all do, because
     every one of them means "show me THIS sky" — a tuning tool that hands back
     an empty sky 70% of the time is not a tool. auto() clears it. */
  const pin = seedIn ?? pinnedSeed();
  let pinned = pin !== null;
  const wSeed = worldSeed();
  /** in-game nights since the world was built */
  let nightIx = 0;
  /** the night's presence draw, 0..1, re-tested against `chance` every frame */
  let odds = 0;
  /** eased presence, 0…1. Only ever moves off 0 or 1 when the knobs are used
      mid-night; the nightly boundary lands in full daylight where the whole
      mesh is already black, so it snaps there. */
  let presT = 0;
  /** the presence the knobs currently ask for, so a live `chance` edit can be
      spotted and the cloud deck re-lit to match */
  let wantPrev = 0;
  let lastNow = 0;
  /** null until the first update() tells us whether we opened in daylight */
  let wasDay: boolean | null = null;

  /** Roll night `n` from the world seed and hand the result to the cloud deck.
   *  Two independent hashes: one decides whether there is an aurora, the other
   *  what it looks like. */
  function setNight(n: number): AuroraRoll {
    nightIx = n;
    odds = hash32(wSeed, n, SALT_ODDS) / 4294967296;
    const r = applyRoll(hash32(wSeed, n, SALT_SKY));
    r.night = n;
    r.odds = odds;
    r.present = odds < api.chance;
    api.roll = r;
    api.present = r.present;
    api.nightIndex = n;
    presT = wantPrev = r.present ? 1 : 0;
    cloudPalette(r.present);
    api.onPalette?.(cloudLo, cloudHi);
    return r;
  }

  const api: Aurora = {
    mesh,
    mat,
    // placeholder: overwritten immediately below, before anything can read it
    roll: applyRoll(0),
    palLo: cloudLo,
    palHi: cloudHi,
    gain: 1,
    skyGain: 1,
    chance: AURORA_CHANCE,
    present: true,
    nightIndex: 0,
    reroll(seed?: number) {
      pinned = true;
      const r = applyRoll(seed ?? ((Math.random() * 0xffffffff) >>> 0));
      r.night = nightIx;
      r.odds = odds;
      r.present = true;
      api.roll = r;
      api.present = true;
      presT = wantPrev = 1;
      cloudPalette(true);
      api.onPalette?.(cloudLo, cloudHi);
      return announce(r);
    },
    next() {
      return api.reroll((api.roll.seed + 1) >>> 0);
    },
    auto() {
      pinned = false;
      return announce(setNight(nightIx));
    },
    lock() {
      const s = `?aurora=${api.roll.seed}`;
      try {
        console.log(`add ${s} to the URL to start on this sky every time`);
      } catch {
        /* ignore */
      }
      return s;
    },
    update(now: number, dayF: number, fogMul: number) {
      mat.uniforms.uTime.value = now;
      const dt = lastNow > 0 ? clamp(now - lastNow, 0, 0.25) : 0;
      lastNow = now;

      /* ---------------- NIGHT BOUNDARY ----------------
         A "night" is one pass of the day/night clock, and the roll for the
         next one happens the moment the clock reaches full daylight — NOT at
         dusk, and certainly not per frame or per lap.

         Why there: at DAY_MARK the curtains are already at exactly zero (the
         night curve below reaches 0 at dayFactor 0.74) and the cloud deck has
         already blended fully to its daytime grey, so swapping presence,
         palette, band layout and the deck's tint is invisible by construction.
         Rolling at dusk instead would mean the sky changed while it was on
         screen; rolling per frame or per lap would have curtains popping in
         and out of a single drive, which is worse than either extreme.

         At the default 150× time rate that is one new sky per ~9.6 real
         minutes, of which ~4.8 are dark. Time paused (T) or scrubbed from the
         settings simply means fewer boundaries; nothing here needs the clock
         to be monotonic. */
      const isDay = dayF >= DAY_MARK;
      if (wasDay === null) wasDay = isDay;   // opening in daylight is not a boundary
      else if (isDay && !wasDay && !pinned) announce(setNight(nightIx + 1));
      wasDay = isDay;

      /* Presence is re-tested against `chance` every frame rather than latched
         at the boundary, so `__aurora.chance = 1` from the console turns
         tonight's sky on where you are standing instead of in nine minutes. */
      const want = pinned || odds < api.chance ? 1 : 0;
      if (want !== wantPrev) {
        wantPrev = want;
        api.present = want === 1;
        // the deck is lit by whatever is up there — swap it back and forth
        // with the curtains or a forced-on aurora leaves moonlit clouds under it
        cloudPalette(api.present);
        api.onPalette?.(cloudLo, cloudHi);
      }
      if (presT !== want) {
        // ~1.4 s to settle: a live knob change fades, it never cuts
        presT += (want - presT) * (1 - Math.exp(-dt / 0.45));
        if (Math.abs(want - presT) < 0.004) presT = want;
      }

      /* Night is the hero: full strength below dayFactor ≈ 0, gone by ≈ 0.74,
         with the 1.35 power holding it up through most of dusk so the default
         21:24 start opens on a full sky. */
      const night = Math.pow(clamp(1 - dayF * 1.35, 0, 1), 1.35);
      /* Fog SOFTENS, it does not gate. This used to run the skyline ring's
         curve, clamp(1.9 - fogMul, .12, 1), which quietly took 35% off the
         aurora at the default "medium" setting for no reason the player could
         see — the skyline is a silhouette 2.3 km downrange and genuinely goes
         away in fog, an aurora is at the top of the atmosphere and does not.
         Heavy fog still costs about a third.
         With fog now OFF by default, fogMul is 0 and this whole factor is
         exactly 1 — the curve is dead code on the shipping settings and only
         wakes up if the player turns fog back on. It applies to the airglow
         and galaxy layer too, which is the honest direction: unlike an aurora,
         those really are dim enough for haze to swallow. */
      mat.uniforms.uAmt.value = night * clamp(1 - 0.13 * fogMul, 0.62, 1);
      mat.uniforms.uCur.value = presT * Math.max(0, api.gain);
      mat.uniforms.uSky.value = Math.max(0, api.skyGain);
    },
  };
  if (pinned) {
    /* A pin reproduces one exact sky, so it takes the seed verbatim and skips
       the rarity draw entirely. */
    api.roll = applyRoll(pin!);
    api.present = true;
    presT = wantPrev = 1;
    cloudPalette(true);
    announce(api.roll);
  } else {
    announce(setNight(0));
  }
  return api;
}
