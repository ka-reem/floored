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
    this.geo.setAttribute("position", new THREE.BufferAttribute(p, 3));
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
    for (let i = 0; i < this.N; i++) {
      p[i * 3 + 1] -= 28 * dt;
      p[i * 3] -= vx * dt * 0.4;
      p[i * 3 + 2] -= vz * dt * 0.4;
      if (p[i * 3] > 60) p[i * 3] -= 120;
      if (p[i * 3] < -60) p[i * 3] += 120;
      if (p[i * 3 + 2] > 60) p[i * 3 + 2] -= 120;
      if (p[i * 3 + 2] < -60) p[i * 3 + 2] += 120;
      if (p[i * 3 + 1] < 0) {
        p[i * 3 + 1] += 50;
        p[i * 3] = rand(-60, 60);
        p[i * 3 + 2] = rand(-60, 60);
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
    const p = this.pool.find((q) => !q.active);
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
