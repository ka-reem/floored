import * as THREE from "three";
import { rand } from "./util";

/* Camera-following rain field + pooled smoke sprites for wrecks. */

export class RainFX {
  pts: THREE.Points;
  private geo: THREE.BufferGeometry;
  private readonly N = 1700;

  constructor(scene: THREE.Scene, streakTex: THREE.Texture) {
    this.geo = new THREE.BufferGeometry();
    const p = new Float32Array(this.N * 3);
    for (let i = 0; i < this.N; i++) {
      p[i * 3] = rand(-60, 60);
      p[i * 3 + 1] = rand(0, 50);
      p[i * 3 + 2] = rand(-60, 60);
    }
    // rewritten in full every frame while rain is on, so tell the driver that
    // up front — a STATIC_DRAW buffer taking a bufferSubData per frame is what
    // makes tile-based mobile GPUs ghost/reallocate it behind our back
    const pa = new THREE.BufferAttribute(p, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", pa);
    this.pts = new THREE.Points(
      this.geo,
      new THREE.PointsMaterial({
        size: 1.3, map: streakTex, transparent: true, opacity: 0.55,
        depthWrite: false, color: 0xbdd0ee,
      })
    );
    this.pts.visible = false;
    this.pts.frustumCulled = false;
    this.pts.layers.set(1);
    scene.add(this.pts);
  }

  update(dt: number, cx: number, cy: number, cz: number, vx: number, vz: number) {
    if (!this.pts.visible) return;
    const p = this.geo.attributes.position.array as Float32Array;
    // the three step sizes are the same for every drop; computing them per
    // particle was 5100 redundant multiplies a frame at N=1700
    const fall = 28 * dt,
      dx = vx * dt * 0.4,
      dz = vz * dt * 0.4;
    for (let i = 0; i < this.N; i++) {
      const b = i * 3;
      p[b + 1] -= fall;
      p[b] -= dx;
      p[b + 2] -= dz;
      if (p[b] > 60) p[b] -= 120;
      if (p[b] < -60) p[b] += 120;
      if (p[b + 2] > 60) p[b + 2] -= 120;
      if (p[b + 2] < -60) p[b + 2] += 120;
      if (p[b + 1] < 0) {
        p[b + 1] += 50;
        p[b] = rand(-60, 60);
        p[b + 2] = rand(-60, 60);
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.pts.position.set(cx + vx * 0.7, cy, cz + vz * 0.7);
  }
}

interface Puff {
  sprite: THREE.Sprite;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  active: boolean;
}

export class SmokeFX {
  private pool: Puff[] = [];
  /* Where the next free-slot scan starts. `emit` runs once per active wreck
     per frame and the wreck pool is 120 deep, so the old `pool.find(q => ...)`
     allocated up to 120 closures a frame and always rescanned the busy head of
     the pool. Every free puff is interchangeable — `emit` reconfigures it from
     scratch — so a rotating cursor picks an equivalent slot for free. */
  private cursor = 0;

  constructor(scene: THREE.Scene, smokeTex: THREE.Texture, n = 70) {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({
        map: smokeTex, transparent: true, opacity: 0, depthWrite: false,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.pool.push({ sprite: s, vx: 0, vy: 0, vz: 0, age: 0, life: 1, active: false });
    }
  }

  emit(x: number, y: number, z: number, big = false) {
    const n = this.pool.length;
    let i = this.cursor,
      p: Puff | null = null;
    for (let k = 0; k < n; k++) {
      const q = this.pool[i];
      i = i + 1 === n ? 0 : i + 1;
      if (!q.active) {
        p = q;
        break;
      }
    }
    this.cursor = i;
    if (!p) return;
    p.active = true;
    p.age = 0;
    p.life = big ? rand(1.2, 2.0) : rand(0.7, 1.2);
    p.vx = rand(-0.6, 0.6);
    p.vy = rand(1.2, 2.4);
    p.vz = rand(-0.6, 0.6);
    p.sprite.position.set(x + rand(-0.4, 0.4), y, z + rand(-0.4, 0.4));
    const sc = big ? rand(1.4, 2.2) : rand(0.7, 1.2);
    p.sprite.scale.set(sc, sc, 1);
    p.sprite.visible = true;
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }
      const t = p.age / p.life;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      p.sprite.scale.multiplyScalar(1 + dt * 1.1);
      (p.sprite.material as THREE.SpriteMaterial).opacity = 0.5 * (1 - t);
    }
  }
}
