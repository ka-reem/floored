export const TAU = Math.PI * 2;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sstep = (t: number) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Deterministic seeded RNG (mulberry32). World generation must go through one
 *  of these so a seed always reproduces the same town. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export const rrand = (rng: Rng, a: number, b: number) => a + rng() * (b - a);
export const rrandi = (rng: Rng, a: number, b: number) => Math.floor(rrand(rng, a, b + 1));
export const rpick = <T>(rng: Rng, arr: T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];

/* Non-seeded variants for cosmetic-only randomness (rain, sparks…) */
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const randi = (a: number, b: number) => Math.floor(rand(a, b + 1));
export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export function angDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}
