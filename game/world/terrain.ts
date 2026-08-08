import * as THREE from "three";
import { sstep, type Rng, rrand } from "../util";
import { HX, RW, DECKY, HZ, RAMP_X0, RAMP_X1, RAMP_W, CONNECT_Z, FRONT_X, EFRONT_X } from "./const";

/* Rolling terrain the whole town conforms to. Flattened along the expressway
   corridor (so the deck, ramps and frontage roads sit on level ground) and
   faded out toward the world edge. */

export interface Terrain {
  h(x: number, z: number): number;
  heightAt(x: number, z: number, refY: number): number;
  onRampWest(x: number, z: number): boolean;
  onRampEast(x: number, z: number): boolean;
  rampHeight(x: number): number;
}

export function makeTerrain(rng: Rng): Terrain {
  // seeded hill field: 3 octaves of drifting sines
  const p1 = rrand(rng, 0, 6.28), p2 = rrand(rng, 0, 6.28), p3 = rrand(rng, 0, 6.28);
  const p4 = rrand(rng, 0, 6.28), p5 = rrand(rng, 0, 6.28);
  const A1 = rrand(rng, 2.6, 3.6), A2 = rrand(rng, 1.2, 1.9), A3 = rrand(rng, 3.4, 4.6);

  function hills(x: number, z: number) {
    return (
      A1 * Math.sin(x * 0.0102 + p1) * Math.cos(z * 0.0088 + p2) +
      A2 * Math.sin(x * 0.019 - z * 0.016 + p3) +
      A3 * Math.cos(x * 0.0047 + p4) * Math.sin(z * 0.0053 + p5)
    );
  }

  function h(x: number, z: number) {
    // flatten from ~x=336 eastward so the expressway corridor sits on level ground
    const corridor = sstep((402 - x) / 66);
    const zFade = sstep((900 - Math.abs(z)) / 260);
    const xFade = sstep((x + 940) / 300);
    const k = corridor * zFade * xFade;
    if (k <= 0.0001) return 0;
    return hills(x, z) * k;
  }

  const rampHeight = (x: number) =>
    DECKY * sstep((x - RAMP_X0 - 3) / (RAMP_X1 - RAMP_X0 - 6));

  const onRampWest = (x: number, z: number) => {
    if (x < RAMP_X0 - 1 || x > HX - RW / 2 + 2) return false;
    for (const zr of CONNECT_Z) if (Math.abs(z - zr) <= RAMP_W / 2 + 1.2) return true;
    return false;
  };
  const onRampEast = (x: number, z: number) => onRampWest(2 * HX - x, z);

  function heightAt(x: number, z: number, refY: number) {
    let best = h(x, z);
    const up = refY > DECKY - 3.4;
    // deck
    if (up && Math.abs(x - HX) <= RW / 2 + 1 && Math.abs(z) <= HZ + 2) best = DECKY;
    // U-turn loops at the ends
    for (const e of [1, -1]) {
      const dz = z - e * HZ;
      if (e * dz > -0.5 && up) {
        const d = Math.hypot(x - HX, dz);
        if (d >= 0.95 && d <= RW / 2 + 1) best = Math.max(best, DECKY);
      }
    }
    // ramps (west + mirrored east)
    if (onRampWest(x, z)) {
      const rh = rampHeight(Math.min(x, RAMP_X1));
      if (Math.abs(rh - refY) < 3.4) best = Math.max(best, rh);
    }
    const xm = 2 * HX - x;
    if (onRampWest(xm, z)) {
      const rh = rampHeight(Math.min(xm, RAMP_X1));
      if (Math.abs(rh - refY) < 3.4) best = Math.max(best, rh);
    }
    return best;
  }

  return { h, heightAt, onRampWest, onRampEast, rampHeight };
}

/** Ground heightfield mesh matching terrain.h. */
export function buildGround(terrain: Terrain, mat: THREE.Material) {
  const SZ = 2600, SEG = 110;
  const g = new THREE.PlaneGeometry(SZ, SZ, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, terrain.h(x, z) - 0.09);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}
