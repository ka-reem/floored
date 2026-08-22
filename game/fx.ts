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
  /* Per-puff look, because one pool now serves two very different plumes.
     `peak` is the opacity at birth, `grow` the per-second expansion rate and
     `drag` the velocity decay; `spray` only marks which budget the slot came
     out of. Every one of these is rewritten on every emit, so a slot carries
     nothing over from its previous life. */
  peak: number; grow: number; drag: number;
  spray: boolean;
}

/* Wheel spray gets a hard slot reserve rather than a fair share of the scan.
   A wreck emits in bursts and stops; a car in the rain emits every single
   frame it is moving, so without a cap the spray would own the pool outright
   and a pileup twenty metres ahead would smoke not at all. The pool grew by
   exactly this reserve (70 -> 96), so the wrecks still have the 70 slots they
   have always had and the spray is additive. Invisible sprites cost a
   traversal and no draw call, so the idle price of the extra 26 is nil.

   The reserve is symmetric: wrecks are capped at `wreckMax` too. Spray is the
   CONTINUOUS effect — it's on screen every wet lap — while wreck smoke is
   episodic, so letting a big enough pileup swallow the last slot and delete
   the spray outright would be the wrong way round. Neither plume can take the
   other's floor. */
const SPRAY_MAX = 26;
/** Rear axle offset and half track, metres. Real specs vary by car (LB 1.44 to
 *  1.5, TRACK 1.3 to 1.58) by centimetres, which is far inside the spread of
 *  the puffs themselves, so the pool doesn't need to know which car it is. */
const REAR_OFF = 1.45;
const HALF_TRACK = 0.78;
/** Below this, the wheels aren't throwing anything — standing in the rain has
 *  to produce nothing at all, not a slow trickle. */
const SPRAY_MIN_SPEED = 4;

export class SmokeFX {
  private pool: Puff[] = [];
  /** Live spray puffs, against SPRAY_MAX. Kept as a counter because the
      alternative is scanning 96 slots per emit to find out. */
  private sprayLive = 0;
  /** Live wreck puffs, against `wreckMax` — the other half of the reserve. */
  private wreckLive = 0;
  private wreckMax: number;
  /** Fractional puffs carried between frames — see sprayEmit(). */
  private sprayAcc = 0;
  /* Which rear wheel the next puff comes off. This has to persist ACROSS
     frames: the emit count is 0 or 1 on almost every frame at any realistic
     rate, so deriving the side from the inner loop index picked the same wheel
     essentially every time and the car sprayed out of one corner like a
     puncture. A standing counter alternates properly however the puffs fall
     across frames. Unbounded growth is fine — `& 1` holds to 2^53. */
  private sprayFlip = 0;
  /* Where the next free-slot scan starts. `emit` runs once per active wreck
     per frame and the wreck pool is 120 deep, so the old `pool.find(q => ...)`
     allocated up to 120 closures a frame and always rescanned the busy head of
     the pool. Every free puff is interchangeable — `emit` reconfigures it from
     scratch — so a rotating cursor picks an equivalent slot for free. */
  private cursor = 0;

  constructor(scene: THREE.Scene, smokeTex: THREE.Texture, n = 70 + SPRAY_MAX) {
    // The other half of the reserve. Wrecks keep exactly the 70 they had
    // before the pool grew, so this caps nothing they could reach anyway —
    // what it buys is that a big enough pileup can no longer take the last
    // slot out from under the spray. Guarded so a small custom `n` still
    // leaves the wrecks something.
    this.wreckMax = Math.max(1, n - SPRAY_MAX);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({
        map: smokeTex, transparent: true, opacity: 0, depthWrite: false,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.pool.push({
        sprite: s, vx: 0, vy: 0, vz: 0, age: 0, life: 1, active: false,
        peak: 0.5, grow: 1.1, drag: 0, spray: false,
      });
    }
  }

  /** Next free slot, or null. Shared by both emitters; every free puff is
   *  interchangeable because each emitter rewrites the whole record. */
  private take(): Puff | null {
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
    return p;
  }

  emit(x: number, y: number, z: number, big = false) {
    if (this.wreckLive >= this.wreckMax) return;
    const p = this.take();
    if (!p) return;
    this.wreckLive++;
    p.active = true;
    p.spray = false;
    p.age = 0;
    p.life = big ? rand(1.2, 2.0) : rand(0.7, 1.2);
    p.vx = rand(-0.6, 0.6);
    p.vy = rand(1.2, 2.4);
    p.vz = rand(-0.6, 0.6);
    p.peak = 0.5;
    p.grow = 1.1;
    p.drag = 0;
    p.sprite.position.set(x + rand(-0.4, 0.4), y, z + rand(-0.4, 0.4));
    const sc = big ? rand(1.4, 2.2) : rand(0.7, 1.2);
    p.sprite.scale.set(sc, sc, 1);
    // a slot may have just been spray, which tints itself — smoke is the
    // texture's own grey, so hand the material back its neutral white
    (p.sprite.material as THREE.SpriteMaterial).color.setHex(0xffffff);
    p.sprite.visible = true;
  }

  /** Wheel spray. Emits from behind the two rear contact patches while the car
   *  is rolling in the rain — the cue that actually sells a wet road at speed,
   *  and one the dashcam sees twice: thrown up in front of the windshield and
   *  again in the mirror behind. `speed` is m/s, `rain` 0..1 (0 = dry, and the
   *  slot is there so a future variable-intensity source drops straight in),
   *  `slip` the wheel slip amount, which makes a car that is lighting up the
   *  rears throw far more water than one just rolling.
   *
   *  Rate is per SECOND and accumulated across frames, so 120fps and 30fps put
   *  the same amount of water in the air — the density is a property of the
   *  drive, not of the display. */
  sprayEmit(
    dt: number, x: number, y: number, z: number, h: number,
    speed: number, rain: number, slip = 0
  ) {
    if (rain <= 0 || speed < SPRAY_MIN_SPEED) {
      // sitting at the lights in a downpour throws nothing, and shouldn't bank
      // a burst to fire off the moment the car pulls away
      this.sprayAcc = 0;
      return;
    }
    const over = Math.min(speed, 55) - SPRAY_MIN_SPEED;
    const rate = rain * over * 1.7 * (1 + Math.min(slip, 1) * 1.5);
    this.sprayAcc += rate * dt;
    let n = Math.floor(this.sprayAcc);
    this.sprayAcc -= n;
    // a long dt after a stall shouldn't dump a hundred puffs in one frame
    if (n > 6) n = 6;
    if (n <= 0) return;

    const fx = Math.sin(h), fz = Math.cos(h);
    const rx = fz, rz = -fx;
    for (let k = 0; k < n; k++) {
      if (this.sprayLive >= SPRAY_MAX) return;
      const p = this.take();
      if (!p) return;
      this.sprayLive++;
      p.active = true;
      p.spray = true;
      p.age = 0;
      // short: a spray plume is torn apart by the airflow almost as fast as it
      // leaves the tyre. This is what keeps it reading as spray and not smoke.
      p.life = rand(0.22, 0.42);
      // one wheel or the other, a little behind the contact patch
      const side = this.sprayFlip++ & 1 ? 1 : -1;
      const back = REAR_OFF + rand(0, 0.5);
      const lat = side * (HALF_TRACK + rand(-0.12, 0.22));
      p.sprite.position.set(
        x - fx * back + rx * lat,
        y + rand(0.04, 0.22),
        z - fz * back + rz * lat
      );
      // flung back and outward off the tread, barely lifted — spray hangs low
      const kick = 2.2 + over * 0.08;
      p.vx = -fx * kick + rx * side * rand(0.4, 1.5) + rand(-0.3, 0.3);
      p.vz = -fz * kick + rz * side * rand(0.4, 1.5) + rand(-0.3, 0.3);
      // barely any lift. Smoke's rand(1.2, 2.4) rise would read as the tyres
      // being on fire; with the drag below this tops out ~0.15m of climb over
      // the whole life, so the plume hugs the road the way spray does.
      p.vy = rand(0.2, 0.8);
      p.drag = 3.4;
      p.grow = 2.4;
      // much fainter than smoke, and thinner still in light rain
      p.peak = rand(0.14, 0.26) * rain;
      // wide and flat, not a ball
      p.sprite.scale.set(rand(0.85, 1.5), rand(0.3, 0.55), 1);
      // cool near-white mist rather than the texture's dirty grey
      (p.sprite.material as THREE.SpriteMaterial).color.setHex(0xdce6f2);
      p.sprite.visible = true;
    }
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        if (p.spray) this.sprayLive--;
        else this.wreckLive--;
        p.sprite.visible = false;
        continue;
      }
      const t = p.age / p.life;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      if (p.drag > 0) {
        // exponential decay, framerate-independent; spray is flung hard and
        // then stopped dead by the air it is flung into
        const d = Math.exp(-p.drag * dt);
        p.vx *= d;
        p.vy *= d;
        p.vz *= d;
      }
      p.sprite.scale.multiplyScalar(1 + dt * p.grow);
      (p.sprite.material as THREE.SpriteMaterial).opacity = p.peak * (1 - t);
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
    this.sprayLive = 0;
    this.wreckLive = 0;
    this.sprayAcc = 0;
    this.sprayFlip = 0;
  }
}
