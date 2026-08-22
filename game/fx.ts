import * as THREE from "three";
import { rand } from "./util";

/* Camera-following rain field + pooled smoke sprites for wrecks. */

/** Dashcam eye height above the car origin. Only used to place the near-clip
 *  bubble below, so it wants the POV camera's height, not an exact figure. */
const EYE_Y = 1.3;
/** Squared radius around the eye inside which a drop is a smear across the
 *  dash rather than rain, and gets thrown back out into the field. */
const NEAR_R2 = 2 * 2;

export class RainFX {
  pts: THREE.Points;
  private geo: THREE.BufferGeometry;
  private readonly N = 1700;
  /* Where the volume sat last frame, in world x/z. The drops are stored in the
     volume's local frame, so cancelling this delta is what keeps them pinned to
     the world instead of riding along with it — see update(). */
  private px = 0;
  private pz = 0;

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
    // the volume is thrown down-road ahead of the car so that the drops which
    // exist are the ones being driven into. Kept in locals because the
    // near-clip below needs to know where the eye sits inside the volume.
    const ex = vx * 0.7,
      ez = vz * 0.7;
    const gx = cx + ex,
      gz = cz + ez;
    if (!this.pts.visible) {
      // stay synced while hidden, or the first visible frame would try to
      // cancel however far the car drove with the rain switched off
      this.px = gx;
      this.pz = gz;
      return;
    }
    const p = this.geo.attributes.position.array as Float32Array;
    /* Rain hangs in the world. The drops carry no horizontal motion of their
       own; subtracting exactly how far the volume travelled leaves each one
       world-static, so at speed they rake past at true closing velocity. The
       old fixed 0.4*v drift only cancelled part of the volume's motion, which
       left the whole field sliding down-road at ~0.6*v — a drizzle bubble
       towed along by the car rather than rain being driven through. Taking the
       delta from the previous position rather than from v*dt also absorbs the
       lead term above, so hard acceleration doesn't jolt the field sideways. */
    const dx = gx - this.px,
      dz = gz - this.pz;
    this.px = gx;
    this.pz = gz;
    // the fall step is the same for every drop; computing it per particle was
    // 1700 redundant multiplies a frame at N=1700
    const fall = 28 * dt;
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
      // Near-clip the cabin. The eye rides at the car, i.e. `ex/ez` behind the
      // volume's origin and about eye height up; a drop inside that bubble
      // draws as a full-screen smear over the dash instead of as rain. Throwing
      // it back out to a fresh x/z is enough — the bubble is 0.09% of the
      // volume's footprint, so a single throw effectively always clears it.
      const qx = p[b] + ex,
        qy = p[b + 1] - EYE_Y,
        qz = p[b + 2] + ez;
      if (qx * qx + qy * qy + qz * qz < NEAR_R2) {
        p[b] = rand(-60, 60);
        p[b + 2] = rand(-60, 60);
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.pts.position.set(gx, cy, gz);
  }

  /** Drop the field. `streakTex` is deliberately NOT disposed: it belongs to
   *  the world's material bundle and outlives any one field, the same rule the
   *  player rig's `shared` allowlist follows. Clearing `visible` first makes a
   *  stray `update()` after teardown a no-op rather than a write into a
   *  disposed buffer. */
  dispose(scene: THREE.Scene) {
    this.pts.visible = false;
    scene.remove(this.pts);
    this.geo.dispose();
    (this.pts.material as THREE.PointsMaterial).dispose();
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

  /** Drop the pool. The materials are one-per-puff and ours to release, but
   *  every one of them carries the SAME `smokeTex` handed in at construction —
   *  it belongs to the world's material bundle, so disposing it here would
   *  free a texture we don't own, and free it seventy times over. Emptying the
   *  pool also makes a stray `emit()`/`update()` after teardown a no-op. */
  dispose(scene: THREE.Scene) {
    for (const p of this.pool) {
      p.sprite.visible = false;
      scene.remove(p.sprite);
      (p.sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.pool.length = 0;
    this.cursor = 0;
  }
}
