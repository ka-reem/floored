/* "WHAT THE AI SEES" — the game's invisible machinery drawn on top of the frame.

   Debug-only, and gated hard: this module is reached through ONE dynamic
   import inside engine.ts's `if (DEBUG_HOOKS)` block (the __neonx.vision
   handle), so in a production tab without `?debug` it is never fetched, never
   constructed and never updated. Nothing here is on a player path.

   What it draws, one layer per flag, each independently switchable:

     hitboxes  every NPC's COLLISION box — n.cw x n.L/2, the box collide.ts
               actually tests (cyan) — and, dimmer in magenta, the pre-fix
               W/2 box that included the door mirrors ("I'm scraping the bus
               but there's a gap"). The player's own box, and the barrier
               colliders (Aabb/Obb) within reach, in sodium.
     probes    the two slope probes physics.ts casts 2.2 m ahead/behind the
               car, as rays from the body to the ground they read. A probe
               that SLOPE_PROBE rejects (>maxRise off the ground under the
               car) is red — that ray hanging over a parapet is the "19.3
               degrees on flat concrete" bug, drawn.
     lanes     lane centrelines, lane edges and pavement edges of the
               corridor ahead, the route graph's bypass/mountain edges and
               its nodes (EXIT 4, the bypass diverge...) — the road as the
               traffic and the physics know it, not as the mesh draws it.
     brain     each NPC's intended path (its target lateral offset ahead),
               the gap it perceives to its leader, its panic window and the
               near-miss window, with a state label.
     lights    the player's two headlight cones cut against the road — the
               footprint outline and the axis — and every NPC's beam pool.
     signs     each cantilever board's panel, mast and FACE NORMAL as an
               arrow, coloured by the sign-audit rule (dot(normal, travel)
               must point back at the driver).
     terrain   a heightAt() sample grid around the car, coloured by height
               relative to the car — the deck floating over the town ground.

   Rendering: fat lines (three's LineSegments2) with vertex colours pushed
   above 1.0 into the half-float scene target, so post's bloom pass turns
   them into glowing neon; depthTest off so they read through bodywork like
   a scanner. Every layer is rebuilt every `every` frames (default 2), by
   throwing the geometry away and building a new one — fine for a debug
   overlay, deliberately not a per-frame attribute update. */
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { SLOPE_PROBE, type CarState } from "./physics";
import type { Npc } from "./traffic";
import type { Corridor } from "./world/corridor";
import { SIGN } from "./world/corridor";
import type { Terrain } from "./world/terrain";
import type { WorldData } from "./world/data";
import { boardPlan, mastLat, type BoardSpec } from "./world/signplan";
import { BYPASS_EDGE, MOUNTAIN_EDGE, type RouteEdge } from "./world/routegraph";

export interface VisionFlags {
  hitboxes: boolean;
  probes: boolean;
  lanes: boolean;
  brain: boolean;
  lights: boolean;
  signs: boolean;
  terrain: boolean;
  /** hitboxes: also draw the pre-fix mirror-inflated W/2 box (dimmer) */
  oldW: boolean;
  /** text labels on the layers that carry them */
  labels: boolean;
  /** rebuild cadence, frames */
  every: number;
  /** line width, pixels */
  px: number;
  /** free text pinned above the car — for a harness to stamp the frame
      ("LEGACY WIDTHS", "GUARD OFF") without cropping it in afterwards */
  note: string;
}

export const VISION_DEFAULTS: VisionFlags = {
  hitboxes: false, probes: false, lanes: false, brain: false,
  lights: false, signs: false, terrain: false,
  oldW: true, labels: true, every: 2, px: 4, note: "",
};

/** Everything the overlay reads, handed in by the engine so this file never
    reaches into its privates. Getters where the thing is built by load(). */
export interface VisionCtx {
  scene: THREE.Scene;
  car: CarState;
  cor: Corridor;
  npcs: () => Npc[];
  terrain: () => Terrain;
  world: () => WorldData;
  rig: () => { halfW: number; halfL: number; spotL: THREE.SpotLight; spotR: THREE.SpotLight } | null;
  /** scene render target size + camera aspect, for LineMaterial.resolution */
  size: () => { w: number; h: number; aspect: number };
}

/* palette — linear-ish, pushed past 1.0 so the bloom pass catches them */
const CYAN: RGB = [0.21, 0.94, 1.0];
const MAGENTA: RGB = [1.0, 0.25, 0.71];
const SODIUM: RGB = [1.0, 0.70, 0.28];
const RED: RGB = [1.0, 0.16, 0.22];
const GREEN: RGB = [0.35, 1.0, 0.45];
const WHITE: RGB = [0.9, 0.95, 1.0];
type RGB = [number, number, number];
const GLOW = 2.6;
const dim = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** Accumulates segments for one layer, then flushes to a LineSegments2. */
class LineLayer {
  private pos: number[] = [];
  private col: number[] = [];
  readonly obj: LineSegments2;
  readonly mat: LineMaterial;
  constructor(scene: THREE.Scene, px: number) {
    this.mat = new LineMaterial({
      linewidth: px, vertexColors: true, transparent: true, depthTest: false,
      depthWrite: false, worldUnits: false,
    });
    this.mat.toneMapped = false;
    this.obj = new LineSegments2(new LineSegmentsGeometry(), this.mat);
    this.obj.renderOrder = 9000;
    this.obj.frustumCulled = false;
    this.obj.visible = false;
    scene.add(this.obj);
  }
  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, c: RGB, k = 1) {
    this.pos.push(x1, y1, z1, x2, y2, z2);
    const r = c[0] * GLOW * k, g = c[1] * GLOW * k, b = c[2] * GLOW * k;
    this.col.push(r, g, b, r, g, b);
  }
  /** yaw-aligned box: centre, half-width (lateral), half-length (forward), height up from cy */
  box(cx: number, cy: number, cz: number, hw: number, hl: number, h: number, yaw: number, c: RGB, k = 1) {
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = fz, rz = -fx;
    const P: number[][] = [];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      P.push([cx + rx * hw * a + fx * hl * b, cz + rz * hw * a + fz * hl * b]);
    }
    for (let i = 0; i < 4; i++) {
      const p = P[i], q = P[(i + 1) % 4];
      this.seg(p[0], cy, p[1], q[0], cy, q[1], c, k);
      this.seg(p[0], cy + h, p[1], q[0], cy + h, q[1], c, k);
      this.seg(p[0], cy, p[1], p[0], cy + h, p[1], c, k);
    }
  }
  arrow(ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: RGB, k = 1, head = 0.9) {
    this.seg(ax, ay, az, bx, by, bz, c, k);
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    const ux = dx / L, uz = dz / L, rx = uz, rz = -ux;
    this.seg(bx, by, bz, bx - ux * head + rx * head * 0.55, by, bz - uz * head + rz * head * 0.55, c, k);
    this.seg(bx, by, bz, bx - ux * head - rx * head * 0.55, by, bz - uz * head - rz * head * 0.55, c, k);
  }
  ring(cx: number, cy: number, cz: number, r: number, c: RGB, k = 1, n = 24) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
      this.seg(cx + Math.sin(a) * r, cy, cz + Math.cos(a) * r, cx + Math.sin(b) * r, cy, cz + Math.cos(b) * r, c, k);
    }
  }
  cross(x: number, y: number, z: number, r: number, c: RGB, k = 1) {
    this.seg(x - r, y, z, x + r, y, z, c, k);
    this.seg(x, y, z - r, x, y, z + r, c, k);
    this.seg(x, y - r, z, x, y + r, z, c, k);
  }
  flush(size: { w: number; h: number }, px: number) {
    const old = this.obj.geometry as LineSegmentsGeometry;
    if (this.pos.length === 0) {
      this.obj.visible = false;
      this.pos.length = 0; this.col.length = 0;
      return;
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(this.pos);
    g.setColors(this.col);
    this.obj.geometry = g;
    old.dispose();
    this.mat.resolution.set(size.w, size.h);
    this.mat.linewidth = px;
    this.obj.visible = true;
    this.pos.length = 0; this.col.length = 0;
  }
  hide() {
    this.obj.visible = false;
    this.pos.length = 0; this.col.length = 0;
  }
  dispose(scene: THREE.Scene) {
    scene.remove(this.obj);
    this.obj.geometry.dispose();
    this.mat.dispose();
  }
}

/** Translucent boxes (windows, zones) — a pooled set of unit cubes. */
class ZonePool {
  private pool: THREE.Mesh[] = [];
  private used = 0;
  private geo = new THREE.BoxGeometry(1, 1, 1);
  constructor(private scene: THREE.Scene) {}
  begin() { this.used = 0; }
  box(cx: number, cy: number, cz: number, hw: number, hl: number, h: number, yaw: number, c: RGB, opacity: number) {
    let m = this.pool[this.used];
    if (!m) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0.12, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      });
      mat.toneMapped = false;
      m = new THREE.Mesh(this.geo, mat);
      m.renderOrder = 8990;
      m.frustumCulled = false;
      this.scene.add(m);
      this.pool.push(m);
    }
    this.used++;
    m.visible = true;
    m.position.set(cx, cy + h / 2, cz);
    m.rotation.set(0, yaw, 0);
    m.scale.set(hw * 2, h, hl * 2);
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.color.setRGB(c[0], c[1], c[2]);
    mat.opacity = opacity;
  }
  end() {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }
  dispose() {
    for (const m of this.pool) { this.scene.remove(m); (m.material as THREE.Material).dispose(); }
    this.geo.dispose();
    this.pool = [];
  }
}

/** Screen-constant text labels: canvas textures cached by string, sprites pooled. */
class LabelPool {
  private tex = new Map<string, { t: THREE.CanvasTexture; aspect: number; age: number }>();
  private pool: THREE.Sprite[] = [];
  private used = 0;
  private tick = 0;
  constructor(private scene: THREE.Scene) {}
  begin() { this.used = 0; this.tick++; }
  private texture(text: string, c: RGB) {
    const key = text + "|" + c.join(",");
    let e = this.tex.get(key);
    if (e) { e.age = this.tick; return e; }
    const cv = document.createElement("canvas");
    const H = 44, font = "600 26px ui-monospace, Menlo, Consolas, monospace";
    const g = cv.getContext("2d")!;
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 26;
    cv.width = w; cv.height = H;
    g.font = font;
    g.fillStyle = "rgba(4,8,14,0.72)";
    g.fillRect(0, 0, w, H);
    const css = `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
    g.strokeStyle = css;
    g.lineWidth = 2;
    g.strokeRect(1, 1, w - 2, H - 2);
    g.fillStyle = css;
    g.textBaseline = "middle";
    g.fillText(text, 13, H / 2 + 1);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearFilter;
    e = { t, aspect: w / H, age: this.tick };
    this.tex.set(key, e);
    /* bound the cache: drop the stalest entries past 96 */
    if (this.tex.size > 96) {
      const stale = [...this.tex.entries()].sort((a, b) => a[1].age - b[1].age).slice(0, 32);
      for (const [k, v] of stale) { v.t.dispose(); this.tex.delete(k); }
    }
    return e;
  }
  label(text: string, x: number, y: number, z: number, c: RGB, camAspect: number, hFrac = 0.05) {
    let s = this.pool[this.used];
    if (!s) {
      const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });
      mat.toneMapped = false;
      s = new THREE.Sprite(mat);
      s.renderOrder = 9100;
      s.frustumCulled = false;
      s.center.set(0, 0.5);
      this.scene.add(s);
      this.pool.push(s);
    }
    this.used++;
    const e = this.texture(text, c);
    (s.material as THREE.SpriteMaterial).map = e.t;
    (s.material as THREE.SpriteMaterial).needsUpdate = true;
    s.visible = true;
    s.position.set(x, y, z);
    s.scale.set(hFrac * e.aspect / camAspect, hFrac, 1);
  }
  end() {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }
  dispose() {
    for (const s of this.pool) { this.scene.remove(s); s.material.dispose(); }
    for (const e of this.tex.values()) e.t.dispose();
    this.pool = []; this.tex.clear();
  }
}

/** Roof heights per NPC type — TYPE_DIM has no height, this is for the box only. */
const ROOF: Record<string, number> = { bus: 3.2, truck: 3.0, van: 2.05, suv: 1.78, osuv: 1.78, police: 1.5 };
const roofOf = (t: string) => ROOF[t] ?? 1.45;

export class Vision {
  flags: VisionFlags = { ...VISION_DEFAULTS };
  private L: Record<keyof Pick<VisionFlags, "hitboxes" | "probes" | "lanes" | "brain" | "lights" | "signs" | "terrain">, LineLayer>;
  private zones: ZonePool;
  private labels: LabelPool;
  private boards: BoardSpec[] | null = null;
  private frame = 0;
  /** last probe read, for the harness to assert against */
  probe = { hHere: 0, hF: 0, hB: 0, rejF: false, rejB: false, slopeDeg: 0 };
  private _v = new THREE.Vector3();
  private _w = new THREE.Vector3();

  constructor(private ctx: VisionCtx) {
    const mk = () => new LineLayer(ctx.scene, this.flags.px);
    this.L = { hitboxes: mk(), probes: mk(), lanes: mk(), brain: mk(), lights: mk(), signs: mk(), terrain: mk() };
    this.zones = new ZonePool(ctx.scene);
    this.labels = new LabelPool(ctx.scene);
  }

  set(f: Partial<VisionFlags>) {
    Object.assign(this.flags, f);
    for (const k of Object.keys(this.L) as (keyof typeof this.L)[]) if (!this.flags[k]) this.L[k].hide();
    this.frame = 0; // rebuild on the next update
    return this.flags;
  }
  all(on = true) {
    return this.set({ hitboxes: on, probes: on, lanes: on, brain: on, lights: on, signs: on, terrain: on });
  }
  get any() {
    const f = this.flags;
    return f.hitboxes || f.probes || f.lanes || f.brain || f.lights || f.signs || f.terrain || !!f.note;
  }

  /** Called by the engine once per rendered frame, before the scene render. */
  update() {
    if (!this.any) return;
    if (this.frame++ % Math.max(1, this.flags.every | 0) !== 0) return;
    const size = this.ctx.size();
    const f = this.flags;
    this.zones.begin();
    this.labels.begin();
    if (f.hitboxes) this.drawHitboxes(size.aspect);
    if (f.probes) this.drawProbes(size.aspect);
    if (f.lanes) this.drawLanes(size.aspect);
    if (f.brain) this.drawBrain(size.aspect);
    if (f.lights) this.drawLights(size.aspect);
    if (f.signs) this.drawSigns(size.aspect);
    if (f.terrain) this.drawTerrain();
    if (f.note) {
      const { car } = this.ctx;
      this.labels.label(f.note, car.x, car.y + 2.9, car.z, SODIUM, size.aspect, 0.071);
    }
    this.zones.end();
    this.labels.end();
    for (const k of Object.keys(this.L) as (keyof typeof this.L)[]) {
      if (f[k]) this.L[k].flush(size, f.px);
    }
  }

  dispose() {
    for (const l of Object.values(this.L)) l.dispose(this.ctx.scene);
    this.zones.dispose();
    this.labels.dispose();
  }

  /* ------------------------------------------------------------------ */
  private drawHitboxes(aspect: number) {
    const { car } = this.ctx;
    const L = this.L.hitboxes, f = this.flags;
    const rig = this.ctx.rig();
    if (rig) {
      L.box(car.x, car.y + 0.05, car.z, rig.halfW, rig.halfL, 1.35, car.h, MAGENTA);
      if (f.labels)
        this.labels.label(`PLAYER  ${(rig.halfW * 2).toFixed(2)} x ${(rig.halfL * 2).toFixed(2)} m`,
          car.x, car.y + 1.7, car.z, MAGENTA, aspect);
    }
    for (const n of this.ctx.npcs()) {
      if (!n.active) continue;
      const d = Math.hypot(n.x - car.x, n.z - car.z);
      if (d > 170) continue;
      const h = roofOf(n.type);
      const c = n.wreck ? RED : CYAN;
      L.box(n.x, n.y + 0.05, n.z, n.cw, n.L / 2, h, n.hVis, c);
      if (f.oldW && d < 90) {
        // the pre-fix box: W/2 includes the door mirrors, which is what was
        // "scraping" through clear air
        L.box(n.x, n.y + 0.05, n.z, n.W / 2, n.L / 2, h, n.hVis, MAGENTA, 0.4);
      }
      if (f.labels && d < 70) {
        const mirror = ((n.W / 2 - n.cw) * 100).toFixed(0);
        this.labels.label(`${n.type.toUpperCase()} #${n.id}  cw ${n.cw.toFixed(2)}m  (mirror +${mirror}cm)`,
          n.x, n.y + h + 0.5, n.z, c, aspect, 0.044);
      }
    }
    /* barrier / building colliders within reach: the walls the car scrapes */
    const col = this.ctx.world().colliders;
    const seen = new Set<number>();
    const seenO = new Set<number>();
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const x = car.x + dx * 26, z = car.z + dz * 26;
        for (const i of col.nearbyAabbs(x, z)) {
          if (seen.has(i)) continue;
          seen.add(i);
          const b = col.aabbs[i];
          if (Math.abs((b.y0 + b.y1) / 2 - car.y) > 12) continue;
          const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
          if (Math.hypot(cx - car.x, cz - car.z) > 70) continue;
          L.box(cx, b.y0, cz, (b.x1 - b.x0) / 2, (b.z1 - b.z0) / 2, b.y1 - b.y0, 0, SODIUM, 0.3);
        }
        for (const i of col.nearbyObbs(x, z)) {
          if (seenO.has(i)) continue;
          seenO.add(i);
          const o = col.obbs[i];
          if (Math.abs((o.y0 + o.y1) / 2 - car.y) > 12) continue;
          if (Math.hypot(o.x - car.x, o.z - car.z) > 70) continue;
          const yaw = Math.atan2(o.sin, o.cos);
          L.box(o.x, o.y0, o.z, o.hw, o.hd, o.y1 - o.y0, yaw, SODIUM, 0.3);
        }
      }
  }

  /* ------------------------------------------------------------------ */
  private drawProbes(aspect: number) {
    const { car } = this.ctx;
    const L = this.L.probes;
    const terrain = this.ctx.terrain();
    // exactly physics.ts stepPhysics' three reads
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    const hHere = terrain.heightAt(car.x, car.z, car.y);
    const nx = car.x + fx * 2.2, nz = car.z + fz * 2.2;
    const bx = car.x - fx * 2.2, bz = car.z - fz * 2.2;
    const hF = terrain.heightAt(nx, nz, car.y);
    const hB = terrain.heightAt(bx, bz, car.y);
    const guard = SLOPE_PROBE.guard;
    const offF = Math.abs(hF - hHere) > SLOPE_PROBE.maxRise;
    const offB = Math.abs(hB - hHere) > SLOPE_PROBE.maxRise;
    const rejF = guard && offF, rejB = guard && offB;
    const useF = rejF ? hHere : hF, useB = rejB ? hHere : hB;
    const slopeDeg = Math.atan(car.slope) * 180 / Math.PI;
    this.probe = { hHere, hF, hB, rejF, rejB, slopeDeg };

    const y0 = car.y + 0.55; // the body the probe hangs from
    const ray = (px: number, pz: number, h: number, off: boolean, rej: boolean, tag: string) => {
      const c: RGB = rej ? RED : off ? SODIUM : GREEN; // sodium = off the deck but ACCEPTED (guard off)
      L.seg(px, y0, pz, px, h, pz, c);
      L.cross(px, h, pz, 0.35, c);
      L.ring(px, h + 0.02, pz, 0.5, c, 0.8, 16);
      // drop from where the car is to where the probe read
      if (Math.abs(h - hHere) > 0.02) L.seg(px, hHere, pz, px, h, pz, dim(c, 0.35));
      if (this.flags.labels) {
        const dh = h - hHere;
        const txt = rej
          ? `${tag} PROBE  ${dh > 0 ? "+" : ""}${dh.toFixed(1)} m  REJECTED (>${SLOPE_PROBE.maxRise} m)`
          : off
            ? `${tag} PROBE  ${dh.toFixed(1)} m  ACCEPTED — guard off (bug)`
            : `${tag} PROBE  ${dh > 0 ? "+" : ""}${dh.toFixed(2)} m  ok`;
        this.labels.label(txt, px, y0 + 0.9, pz, c, aspect, 0.048);
      }
    };
    ray(nx, nz, hF, offF, rejF, "FRONT");
    ray(bx, bz, hB, offB, rejB, "REAR");
    // the probe under the car itself
    L.seg(car.x, y0, car.z, car.x, hHere, car.z, dim(WHITE, 0.6));
    L.cross(car.x, hHere, car.z, 0.3, WHITE, 0.6);
    // the pitch the physics REPORTS from those two reads
    L.seg(bx, useB + 0.3, bz, nx, useF + 0.3, nz, MAGENTA);
    L.ring(car.x, hHere + 0.02, car.z, 2.2, dim(WHITE, 0.4), 1, 32);
    if (this.flags.labels)
      this.labels.label(`PITCH ${slopeDeg.toFixed(1)}°  ${Math.abs(slopeDeg) > 8 ? "ON FLAT CONCRETE" : "reported"}`,
        car.x - fx * 0.5, car.y + 2.3, car.z - fz * 0.5, Math.abs(slopeDeg) > 8 ? RED : MAGENTA, aspect, 0.061);
  }

  /* ------------------------------------------------------------------ */
  private drawLanes(aspect: number) {
    const { car, cor } = this.ctx;
    const L = this.L.lanes;
    const zc = cor.zAt(car.x, car.z);
    const STEP = 5, Z0 = zc - 30, Z1 = zc + 170;
    const lift = 0.08;
    const pt = (z: number, lat: number) => cor.worldOf(z, lat);
    let prevN = -1;
    for (let z = Z0; z < Z1; z += STEP) {
      const z2 = z + STEP;
      const n = cor.lanes(z), n2 = cor.lanes(z2);
      for (let k = 0; k < Math.min(n, n2); k++) {
        const a = pt(z, cor.laneOffset(k, z)), b = pt(z2, cor.laneOffset(k, z2));
        L.seg(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z, CYAN, 0.9);
      }
      for (let k = 1; k < Math.min(n, n2); k++) {
        const a = pt(z, cor.laneEdge(k, z)), b = pt(z2, cor.laneEdge(k, z2));
        L.seg(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z, WHITE, 0.35);
      }
      for (const side of [-1, 1]) {
        const a = pt(z, cor.edgeLat(z, side)), b = pt(z2, cor.edgeLat(z2, side));
        L.seg(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z, SODIUM, 1);
      }
      if (Math.round(z / 20) * 20 === Math.round(z) || n !== prevN) {
        const a = pt(z, cor.edgeLat(z, -1)), b = pt(z, cor.edgeLat(z, 1));
        L.seg(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z, SODIUM, 0.45);
      }
      prevN = n;
    }
    if (this.flags.labels) {
      const zl = zc + 28, n = cor.lanes(zl);
      for (let k = 0; k < n; k++) {
        const p = pt(zl, cor.laneOffset(k, zl));
        this.labels.label(`LANE ${k}${k === n - 1 ? " (fast)" : k === 0 ? " (kerb)" : ""}`, p.x, p.y + 0.6, p.z, CYAN, aspect, 0.041);
      }
      const hw = cor.halfWidth(zl);
      const e = pt(zl + 10, cor.edgeLat(zl + 10, 1));
      this.labels.label(`halfWidth ${hw.toFixed(2)} m · ${n} lanes · pitch ${cor.lanePitch(zl).toFixed(2)}`, e.x, e.y + 1.2, e.z, SODIUM, aspect, 0.041);
    }
    /* the route graph: bypass + mountain edges and every node in reach */
    const routes = this.ctx.world().routes;
    if (routes) {
      const edge = (e: RouteEdge, c: RGB) => {
        const S = 6, n = Math.ceil(e.len / S);
        let prev: { x: number; y: number; z: number } | null = null;
        let prevLanes: { x: number; y: number; z: number }[] = [];
        for (let i = 0; i <= n; i++) {
          const s = Math.min(e.len, i * S);
          const p = e.worldOf(s, 0);
          const near = Math.hypot(p.x - car.x, p.z - car.z) < 260;
          const lanes: { x: number; y: number; z: number }[] = [];
          const nl = e.lanes(s);
          if (near) for (let k = 0; k < nl; k++) lanes.push(e.worldOf(s, e.laneOffset(k, s)));
          if (near && prev) {
            L.seg(prev.x, prev.y + lift, prev.z, p.x, p.y + lift, p.z, c, 1.1);
            for (let k = 0; k < Math.min(lanes.length, prevLanes.length); k++)
              L.seg(prevLanes[k].x, prevLanes[k].y + lift, prevLanes[k].z, lanes[k].x, lanes[k].y + lift, lanes[k].z, c, 0.45);
          }
          prev = p; prevLanes = lanes;
        }
      };
      edge(routes.bypass, MAGENTA);
      edge(routes.mtn, MAGENTA);
      for (const nd of routes.nodes) {
        const d = Math.hypot(nd.x - car.x, nd.z - car.z);
        if (d > 300) continue;
        const c = nd.kind === "diverge" ? MAGENTA : nd.kind === "merge" ? SODIUM : WHITE;
        L.ring(nd.x, nd.y + lift, nd.z, 2.4, c, 1.2, 28);
        L.ring(nd.x, nd.y + lift, nd.z, 1.2, c, 0.8, 16);
        L.seg(nd.x, nd.y, nd.z, nd.x, nd.y + 6, nd.z, c, 0.8);
        if (this.flags.labels)
          this.labels.label(`NODE ${nd.id} ${nd.name.toUpperCase()}  [${nd.kind}]${nd.mainZ !== null ? "  z " + nd.mainZ : ""}`,
            nd.x, nd.y + 6.4, nd.z, c, aspect, 0.03);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  private drawBrain(aspect: number) {
    const { car, cor } = this.ctx;
    const L = this.L.brain;
    const routes = this.ctx.world().routes;
    const lift = 0.12;
    for (const n of this.ctx.npcs()) {
      if (!n.active || n.wreck) continue;
      const d = Math.hypot(n.x - car.x, n.z - car.z);
      if (d > 140) continue;
      const fx = Math.sin(n.hVis), fz = Math.cos(n.hVis);
      const state = n.brake ? "BRAKE" : n.blink !== 0 ? "BLINK " + (n.blink < 0 ? "R" : "L") : n.mergeLean !== 0 ? "LEAN" : n.pendK >= 0 ? "CHANGING" : "CRUISE";
      const c: RGB = n.brake ? RED : n.pendK >= 0 || n.blink !== 0 ? SODIUM : Math.abs(n.offT - n.offCur) > 0.2 ? MAGENTA : CYAN;
      /* intended path: where its target lateral offset takes it over the
         next couple of seconds, in its own route's frame */
      const D = Math.max(10, n.v * 2.0);
      const at = (ds: number, lat: number) => {
        if (!n.hw) return { x: n.x + fx * ds, y: n.y, z: n.z + fz * ds };
        if (n.route === BYPASS_EDGE && routes) return routes.bypass.worldOf(n.s + ds, lat);
        if (n.route === MOUNTAIN_EDGE && routes) return routes.mtn.worldOf(n.s + ds * n.dir, lat);
        return cor.worldOf(n.s + ds, lat);
      };
      const N = 6;
      let prev = at(0, n.offCur);
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const lat = n.offCur + (n.offT - n.offCur) * Math.min(1, t * 1.6);
        const p = at(t * D, lat);
        if (i === N) L.arrow(prev.x, prev.y + lift, prev.z, p.x, p.y + lift, p.z, c, 1, 1.1);
        else L.seg(prev.x, prev.y + lift, prev.z, p.x, p.y + lift, p.z, c);
        prev = p;
      }
      /* the target lane, if a change is pending */
      if (n.hw && n.pendK >= 0 && n.route === -1) {
        const q = cor.worldOf(n.s + D * 0.6, cor.laneOffset(n.pendK, n.s + D * 0.6));
        L.ring(q.x, q.y + lift, q.z, 1.0, SODIUM, 1, 16);
      }
      /* perceived gap to the leader */
      if (n.pLead && n.pLead.ds < 150 && d < 100) {
        const g = n.pLead.ds;
        const ax = n.x + fx * (n.L / 2), az = n.z + fz * (n.L / 2);
        const bx = ax + fx * g, bz = az + fz * g;
        L.seg(ax, n.y + 0.9, az, bx, n.y + 0.9, bz, WHITE, 0.5);
        const rx = fz, rz = -fx;
        L.seg(bx - rx * 0.8, n.y + 0.9, bz - rz * 0.8, bx + rx * 0.8, n.y + 0.9, bz + rz * 0.8, WHITE, 0.8);
        if (this.flags.labels && d < 70)
          this.labels.label(`gap ${g.toFixed(0)} m · lead ${(n.pLead.v * 3.6).toFixed(0)} km/h`, (ax + bx) / 2, n.y + 1.2, (az + bz) / 2, WHITE, aspect, 0.037);
      }
      /* the windows traffic.ts judges the PLAYER in, in this car's frame */
      if (d < 70) {
        // panic: ahead 0..9, |side| < 3 → this driver brakes
        this.zones.box(n.x + fx * 4.5, n.y + 0.02, n.z + fz * 4.5, 3, 4.5, 0.9, n.hVis, SODIUM, 0.10);
        L.box(n.x + fx * 4.5, n.y + 0.02, n.z + fz * 4.5, 3, 4.5, 0.9, n.hVis, SODIUM, 0.45);
        // near-miss: ahead −1..4, |side| 0.3..0.9 → the close-call window
        this.zones.box(n.x + fx * 1.5, n.y + 0.02, n.z + fz * 1.5, 0.9, 2.5, 1.2, n.hVis, MAGENTA, 0.16);
      }
      if (this.flags.labels && d < 80) {
        const lane = n.hw ? `L${n.laneK}${n.pendK >= 0 ? "→L" + n.pendK : ""}` : "town";
        this.labels.label(`${n.type.toUpperCase()} #${n.id} ${lane}  ${(n.v * 3.6).toFixed(0)} km/h  ${state}`,
          n.x, n.y + roofOf(n.type) + 0.9, n.z, c, aspect, 0.044);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  private drawLights(aspect: number) {
    const { car } = this.ctx;
    const L = this.L.lights;
    const rig = this.ctx.rig();
    const terrain = this.ctx.terrain();
    if (rig) {
      let k = 0;
      for (const sp of [rig.spotL, rig.spotR]) {
        sp.getWorldPosition(this._v);
        sp.target.getWorldPosition(this._w);
        const p = this._v.clone();
        const dir = this._w.sub(this._v).normalize();
        const a = sp.angle;
        const throwM = sp.distance * 0.68; // HL_THROW / HL_CLIP ≈ 130/190
        // a basis around the axis
        const up = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const u = new THREE.Vector3().crossVectors(dir, up).normalize();
        const v = new THREE.Vector3().crossVectors(u, dir).normalize();
        const N = 36;
        let first: THREE.Vector3 | null = null, prev: THREE.Vector3 | null = null;
        const hit = (dx: number, dy: number, dz: number) => {
          let t = throwM;
          if (dy < -1e-4) {
            const gy = terrain.heightAt(p.x + dx * 20, p.z + dz * 20, car.y);
            t = Math.min(throwM, (gy - p.y) / dy);
          }
          const h = new THREE.Vector3(p.x + dx * t, p.y + dy * t, p.z + dz * t);
          const gy2 = terrain.heightAt(h.x, h.z, car.y);
          if (h.y < gy2) h.y = gy2;
          h.y += 0.06;
          return h;
        };
        for (let i = 0; i < N; i++) {
          const th = (i / N) * Math.PI * 2;
          const dx = dir.x * Math.cos(a) + Math.sin(a) * (u.x * Math.cos(th) + v.x * Math.sin(th));
          const dy = dir.y * Math.cos(a) + Math.sin(a) * (u.y * Math.cos(th) + v.y * Math.sin(th));
          const dz = dir.z * Math.cos(a) + Math.sin(a) * (u.z * Math.cos(th) + v.z * Math.sin(th));
          const h = hit(dx, dy, dz);
          if (prev) L.seg(prev.x, prev.y, prev.z, h.x, h.y, h.z, SODIUM);
          if (i % 6 === 0) L.seg(p.x, p.y, p.z, h.x, h.y, h.z, SODIUM, 0.3);
          if (!first) first = h;
          prev = h;
        }
        if (first && prev) L.seg(prev.x, prev.y, prev.z, first.x, first.y, first.z, SODIUM);
        const ax = hit(dir.x, dir.y, dir.z);
        L.seg(p.x, p.y, p.z, ax.x, ax.y, ax.z, CYAN);
        L.cross(ax.x, ax.y, ax.z, 0.6, CYAN);
        if (this.flags.labels && k === 1) {
          const hi = a > 0.4 || sp.distance > 200;
          this.labels.label(`${hi ? "HIGH" : "LOW"} BEAM  cone ${(a * 2 * 180 / Math.PI).toFixed(0)}°  throw ${throwM.toFixed(0)} m  clip ${sp.distance} m  I ${sp.intensity.toFixed(0)}`,
            ax.x, ax.y + 1.2, ax.z, SODIUM, aspect, 0.048);
        }
        k++;
      }
    }
    /* NPC beam pools — the quad traffic.ts lays under each car's nose */
    for (const n of this.ctx.npcs()) {
      if (!n.active) continue;
      const d = Math.hypot(n.x - car.x, n.z - car.z);
      if (d > 150) continue;
      const heavy = n.type === "truck" || n.type === "bus";
      const sl = 18.0 * (heavy ? 1.15 : 1), sw = 5.2 * (heavy ? 1.3 : 1);
      const ahead = n.L / 2 + sl * 0.42;
      const fx = Math.sin(n.hVis), fz = Math.cos(n.hVis), rx = fz, rz = -fx;
      const cx = n.x + fx * ahead, cz = n.z + fz * ahead;
      const M = 20;
      for (let i = 0; i < M; i++) {
        const a0 = (i / M) * Math.PI * 2, a1 = ((i + 1) / M) * Math.PI * 2;
        const p0x = cx + rx * Math.cos(a0) * sw / 2 + fx * Math.sin(a0) * sl / 2;
        const p0z = cz + rz * Math.cos(a0) * sw / 2 + fz * Math.sin(a0) * sl / 2;
        const p1x = cx + rx * Math.cos(a1) * sw / 2 + fx * Math.sin(a1) * sl / 2;
        const p1z = cz + rz * Math.cos(a1) * sw / 2 + fz * Math.sin(a1) * sl / 2;
        L.seg(p0x, n.y + 0.08, p0z, p1x, n.y + 0.08, p1z, CYAN, 0.5);
      }
      L.seg(n.x + fx * n.L / 2, n.y + 0.6, n.z + fz * n.L / 2, cx + fx * sl / 2, n.y + 0.08, cz + fz * sl / 2, CYAN, 0.25);
    }
  }

  /* ------------------------------------------------------------------ */
  private drawSigns(aspect: number) {
    const { car, cor } = this.ctx;
    const L = this.L.signs;
    if (!this.boards) this.boards = boardPlan();
    for (const b of this.boards) {
      const mast = cor.worldOf(b.z, mastLat(b.z, b.side));
      const d = Math.hypot(mast.x - car.x, mast.z - car.z);
      if (d > 280) continue;
      const pose = cor.pose(b.z);
      const yaw = pose.h + Math.PI; // highway.ts: the panel faces back down the road
      const nx = Math.sin(yaw), nz = Math.cos(yaw);
      const dot = nx * pose.tx + nz * pose.tz; // sign-audit's FACING score
      const ok = dot < -0.9;
      const c = ok ? GREEN : RED;
      const y0 = mast.y + SIGN.CLEAR, y1 = y0 + b.h;
      const latM = mastLat(b.z, b.side);
      const latIn = latM - b.side * SIGN.ARM_X; // inboard edge of the panel
      const latOut = latIn - b.side * b.w; // far edge over the lanes
      const A = cor.worldOf(b.z, latIn), B = cor.worldOf(b.z, latOut);
      // mast + arm
      L.seg(mast.x, mast.y, mast.z, mast.x, y1, mast.z, SODIUM, 0.8);
      L.seg(mast.x, y1, mast.z, B.x, y1, B.z, SODIUM, 0.8);
      // panel outline
      L.seg(A.x, y0, A.z, B.x, y0, B.z, SODIUM);
      L.seg(A.x, y1, A.z, B.x, y1, B.z, SODIUM);
      L.seg(A.x, y0, A.z, A.x, y1, A.z, SODIUM);
      L.seg(B.x, y0, B.z, B.x, y1, B.z, SODIUM);
      L.seg(A.x, y0, A.z, B.x, y1, B.z, SODIUM, 0.3);
      // face normal, from the panel centre
      const cx = (A.x + B.x) / 2, cz = (A.z + B.z) / 2, cy = (y0 + y1) / 2;
      L.arrow(cx, cy, cz, cx + nx * 6, cy, cz + nz * 6, c, 1.2, 1.2);
      L.ring(cx + nx * 6, cy, cz + nz * 6, 0.5, c, 1, 12);
      // travel direction on the deck under it, for the eye to compare
      L.arrow(cx, mast.y + 0.3, cz, cx + pose.tx * 6, mast.y + 0.3, cz + pose.tz * 6, CYAN, 0.7, 0.9);
      if (this.flags.labels && d < 200) {
        const face = b.face.t === "guide" ? `EXIT ${b.face.exitNo} ${b.face.en} ${b.face.dist ? b.face.dist + " m" : "gore"}` : b.face.t === "merge" ? `MERGE ${b.face.dist} m` : `WARN ${b.face.l2}`;
        this.labels.label(`${face}  ·  face·travel ${dot.toFixed(2)} ${ok ? "✓ faces driver" : "✗ WRONG WAY"}  ·  ${b.side < 0 ? "west" : "east"} post`,
          cx, y1 + 0.9, cz, c, aspect, 0.044);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  private drawTerrain() {
    const { car } = this.ctx;
    const L = this.L.terrain;
    const terrain = this.ctx.terrain();
    const N = 13, S = 2.0; // 27 x 27 points, ±26 m
    const fx = Math.sin(car.h), fz = Math.cos(car.h), rx = fz, rz = -fx;
    const W = 2 * N + 1;
    const ys = new Float32Array(W * W), xs = new Float32Array(W * W), zs = new Float32Array(W * W);
    for (let j = -N; j <= N; j++)
      for (let i = -N; i <= N; i++) {
        const x = car.x + rx * i * S + fx * j * S, z = car.z + rz * i * S + fz * j * S;
        const k = (j + N) * W + (i + N);
        xs[k] = x; zs[k] = z;
        ys[k] = terrain.heightAt(x, z, car.y) + 0.06;
      }
    const colAt = (y: number): RGB => {
      const dy = y - 0.06 - car.y;
      if (dy < -1.0) return dim([0.25, 0.45, 1.0], 0.55);
      if (dy > 0.6) return MAGENTA;
      return CYAN;
    };
    for (let j = 0; j < W; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (i + 1 < W) {
          const k2 = k + 1;
          L.seg(xs[k], ys[k], zs[k], xs[k2], ys[k2], zs[k2], colAt(Math.min(ys[k], ys[k2])), 0.5);
        }
        if (j + 1 < W) {
          const k2 = k + W;
          L.seg(xs[k], ys[k], zs[k], xs[k2], ys[k2], zs[k2], colAt(Math.min(ys[k], ys[k2])), 0.5);
        }
      }
  }
}
