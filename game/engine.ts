import * as THREE from "three";
import { clamp, lerp, mulberry32 } from "./util";
import {
  fogMultiplier, speedInUnits, unitLabel,
  type GameSettings, type Profile,
} from "./settings";
import { getCar, PAINTS, type CarSpec } from "./carspecs";
import { buildMats, type Mats } from "./world/mats";
import { makeTerrain, buildGround, type Terrain } from "./world/terrain";
import { buildRoadNet } from "./world/roadnet";
import { buildHighway, nearestExitAhead } from "./world/highway";
import { buildTown } from "./world/townmesh";
import { buildSky, type Sky } from "./world/sky";
import { ColliderIndex, signalPhase, type WorldData } from "./world/data";
import { HX, DECKY, LANE_OFF } from "./world/const";
import { stepPhysics, freshCarState, type CarState, type DriverInput } from "./physics";
import { collidePlayer } from "./collide";
import { buildPlayerCar, type PlayerRig } from "./player";
import { COCKPIT_REF, EYE as COCKPIT_EYE } from "./cockpit";
import { Traffic } from "./traffic";
import { GameAudio } from "./audio";
import { RainFX, SmokeFX } from "./fx";
import { PostFX } from "./post";
import { drawMiniMap } from "./minimap";

const WX_SVG = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">${body}</svg>`;
const WX_ICONS: Record<string, string> = {
  moon: WX_SVG(`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>`),
  sun: WX_SVG(
    `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`
  ),
  rain: WX_SVG(
    `<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M8 19v2M12 18v3M16 19v2"/>`
  ),
};

export interface UiBridge {
  toast(msg: string): void;
  exitHint(text: string | null): void;
  pauseRequest(): void;
  helpRequest(): void;
}

/* The v2 art (procedural canvas textures + hex palettes) was tuned under
   r128's non-color-managed pipeline; keep that exact response and do the
   ACES + sRGB encode ourselves in the composite pass. */
THREE.ColorManagement.enabled = false;

const LAYER_NOREF = 1;

export class Game {
  // public state the UI reads
  settings: GameSettings;
  carId: string;
  paintIx: number;
  seed: number;
  camMode: number;
  started = false;
  running = false; // simulation advancing (menus closed)
  rain = false;
  grade = false; // set from settings.dashcam in the constructor
  mirror = true;
  mmap = true;
  time = 21.4;
  timeSpeed = 150;
  perfMode = false;
  lookBack = false;

  private ui: UiBridge;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rearCam: THREE.PerspectiveCamera;
  private refCam = new THREE.PerspectiveCamera();
  private mats: Mats;
  private sky: Sky;
  private world: WorldData;
  private terrain: Terrain;
  private post: PostFX;
  private traffic: Traffic;
  private audio = new GameAudio();
  private rainFX: RainFX;
  private smokeFX: SmokeFX;
  private rig!: PlayerRig;
  car: CarState;
  private input: DriverInput = { th: 0, br: 0, st: 0, hb: 0, horn: 0 };
  private keydown: Record<string, number> = {};
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private amb: THREE.AmbientLight;
  private chasePos = new THREE.Vector3();
  private lookPos = new THREE.Vector3();
  // camMode as of the last updateCamera() call — lets the chase branch detect
  // a fresh switch into chase mode and snap instead of easing from whatever
  // stale position chasePos/lookPos were left at while another mode was active
  private lastCamMode = -1;
  /* 0 = chase cam sits behind the car, 1 = swung round in front looking back.
     Eased so the swing only happens when the car is really reversing. */
  private revCam = 0;
  /* visual accel pitch, damped and speed-scaled off car.pitchDyn */
  private pitchVis = 0;
  /* 0..1 lean toward the car's centreline while looking back in the cockpit */
  private lbLean = 0;
  private head = { x: 0, y: 0, vx: 0, vy: 0, z: 0, vz: 0, roll: 0, vroll: 0 };
  /* cockpit corner lookahead: eased yaw offset toward the steering direction */
  private lookaheadYaw = 0;
  /* chase cam lateral lag: trails the yaw-driven offset then eases to it,
     giving the classic GT "camera catches up out of the corner" feel */
  private chaseLag = { x: 0, vx: 0 };
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private mirM = new THREE.Matrix4();
  private last = 0;
  private acc = 0;
  private frameN = 0;
  private emaMs = 16;
  private slowT = 0;
  private gaugeT = 0;
  private dropT = 0;
  private hudT = 0;
  private chunkT = 0;
  private raf = 0;
  private disposed = false;
  private isTouch: boolean;
  private wheelVal = 0;
  private tiltVal = 0;
  private tiltHooked = false;
  private fogC = new THREE.Color();
  private prevBlinkOn = false;
  private crashCooldown = 0;
  debug = {
    override: null as Partial<DriverInput> | null,
    errors: [] as string[],
    frames: 0,
  };

  constructor(container: HTMLElement, profile: Profile, ui: UiBridge) {
    this.ui = ui;
    this.settings = profile.settings;
    this.grade = profile.settings.dashcam;
    this.carId = profile.carId;
    this.paintIx = profile.paintIx;
    this.seed = profile.seed;
    this.camMode = profile.camMode;
    this.isTouch = "ontouchstart" in window && matchMedia("(pointer:coarse)").matches;
    if (this.isTouch) document.body.classList.add("touch");

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.isTouch ? 1.35 : 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.NoToneMapping; // manual ACES in the composite pass
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = "game";
    container.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.FogExp2(0x0a0d1a, 0.002);
    this.camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.08, 3400);
    this.camera.layers.enable(LAYER_NOREF);
    this.camera.rotation.order = "YXZ";
    this.rearCam = new THREE.PerspectiveCamera(50, 2.5, 0.6, 460);
    this.rearCam.layers.enable(LAYER_NOREF);
    this.refCam.matrixAutoUpdate = false;

    this.hemi = new THREE.HemisphereLight(0x3948a8, 0x0b0b14, 0.32);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0x9db4ff, 0.16);
    this.scene.add(this.sun);
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -170;
    this.sun.shadow.camera.right = 170;
    this.sun.shadow.camera.top = 170;
    this.sun.shadow.camera.bottom = -170;
    this.sun.shadow.camera.near = 40;
    this.sun.shadow.camera.far = 1100;
    this.sun.shadow.bias = -0.0015;
    this.scene.add(this.sun.target);
    this.amb = new THREE.AmbientLight(0x222233, 0.35);
    this.scene.add(this.amb);

    this.post = new PostFX(this.renderer);
    this.mats = buildMats();
    this.mats.setReflectionTexture(this.post.reflectRT.texture);
    this.mats.setReflectionScreen(
      innerWidth * this.renderer.getPixelRatio(),
      innerHeight * this.renderer.getPixelRatio()
    );
    this.sky = buildSky(this.scene, this.mats.glowTex);

    /* ---- world build (seeded) ---- */
    const rng = mulberry32(this.seed);
    this.terrain = makeTerrain(rng);
    const net = buildRoadNet(rng, this.terrain);
    this.world = {
      colliders: new ColliderIndex(),
      net,
      terrain: this.terrain,
      exits: [],
      chunks: [],
      neonMats: [],
    };
    const ground = buildGround(this.terrain, this.mats.ground);
    ground.layers.set(LAYER_NOREF);
    this.scene.add(ground);
    const hwyOut = buildHighway(this.scene, this.mats, this.world, this.terrain, rng);
    buildTown(this.scene, this.mats, this.world, this.terrain, rng, hwyOut.deckLightPts);

    this.traffic = new Traffic(this.scene, this.world, this.mats.envMap, this.mats.glowTex, 120);
    this.rainFX = new RainFX(this.scene, this.mats.streakTex);
    this.smokeFX = new SmokeFX(this.scene, this.mats.smokeTex);

    this.car = freshCarState(HX + LANE_OFF[1], DECKY, -430, 0, 23);
    this.buildRig();
    this.chasePos.set(this.car.x, DECKY + 2.15, this.car.z - 7);
    this.lookPos.set(this.car.x, this.car.y + 0.95, this.car.z);

    this.timeSpeed = this.settings.autoTime ? 150 : 0;
    this.bindInput();
    this.applySettings(this.settings);
    addEventListener("resize", this.onResize);

    // expose debug hooks for the test harness
    (window as any).__neonx = {
      game: this,
      teleport: (x: number, z: number, y?: number, h?: number, u?: number) => {
        this.car.x = x;
        this.car.z = z;
        if (y !== undefined) this.car.y = y;
        else this.car.y = this.terrain.heightAt(x, z, this.car.y);
        if (h !== undefined) this.car.h = h;
        if (u !== undefined) this.car.u = u;
        this.car.v = 0;
        this.car.r = 0;
        this.car.wvx = 0;
        this.car.wvz = 0;
        this.chasePos.set(this.car.x - Math.sin(this.car.h) * 4.4, this.car.y + 2.15, this.car.z - Math.cos(this.car.h) * 4.4);
        this.lookPos.set(this.car.x, this.car.y + 0.95, this.car.z);
      },
      setCam: (i: number) => (this.camMode = i % 3),
      setInput: (o: Partial<DriverInput> | null) => (this.debug.override = o),
      state: () => ({
        x: this.car.x, y: this.car.y, z: this.car.z, h: this.car.h,
        u: this.car.u, kmh: Math.abs(this.car.u) * 3.6,
        mph: Math.abs(this.car.u) * 2.236936,
        gear: this.car.gear, rpm: this.car.rpm,
        rev: this.car.rev, slope: this.car.slope, pitchDyn: this.car.pitchDyn,
        camMode: this.camMode, camPitch: this.camera.rotation.x,
        camYaw: this.camera.rotation.y, revCam: this.revCam,
        npcs: this.traffic.npcs.filter((n) => n.active).length,
        wrecks: this.traffic.activeWrecks().length,
        chunksVisible: this.world.chunks.filter((c) => c.group.visible).length,
        chunksTotal: this.world.chunks.length,
        perfMode: this.perfMode,
        errors: this.debug.errors,
        frames: this.debug.frames,
      }),
      crashTest: () => {
        this.traffic.spawnObstacleAhead(this.car);
        this.car.u = 22;
      },
      setRain: (on: boolean) => this.setRain(on),
      setTime: (t: number) => (this.time = t),
      collidersNear: (x: number, z: number) => {
        const c = this.world.colliders;
        return {
          aabbs: c.nearbyAabbs(x, z).map((i) => c.aabbs[i]),
          obbs: c.nearbyObbs(x, z).map((i) => c.obbs[i]),
        };
      },
    };
    window.addEventListener("error", this.onWindowError);
    window.addEventListener("blur", this.onWindowBlur);
  }

  private onWindowError = (e: ErrorEvent) => {
    this.debug.errors.push(String(e.message));
  };

  private onWindowBlur = () => {
    // don't let held keys latch across alt-tab
    for (const k in this.keydown) this.keydown[k] = 0;
    this.input.th = this.input.br = this.input.st = this.input.hb = this.input.horn = 0;
  };

  /* ---------------- rig ---------------- */
  private buildRig() {
    if (this.rig) this.rig.dispose(this.scene);
    const spec = getCar(this.carId);
    this.rig = buildPlayerCar(
      this.scene, spec, PAINTS[this.paintIx % PAINTS.length].hex,
      this.mats.envMap, this.mats.glowTex, this.post.mirrorRT.texture
    );
    this.rig.cockpit.setMirrorVis(this.mirror);
  }

  setCar(carId: string, paintIx: number) {
    this.carId = carId;
    this.paintIx = paintIx;
    this.buildRig();
    this.audio.setCar(carId);
  }

  get spec(): CarSpec {
    return this.rig.spec;
  }

  /* ---------------- input ---------------- */
  private onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    this.keydown[k] = 1;
    if (e.repeat) return;
    if (!this.started) return;
    if (k === "escape") {
      this.ui.pauseRequest();
      return;
    }
    if (!this.running) return;
    if (k === "c") {
      this.camMode = (this.camMode + 1) % 3;
      this.ui.toast(["CHASE", "COCKPIT", "HOOD"][this.camMode]);
    }
    if (k === "l") {
      this.car.lightsUser = !this.car.lightsUser;
      this.ui.toast("LIGHTS " + (this.car.lightsUser ? "ON" : "AUTO"));
    }
    if (k === "q") {
      this.car.sigL = !this.car.sigL;
      this.car.sigR = false;
    }
    if (k === "e") {
      this.car.sigR = !this.car.sigR;
      this.car.sigL = false;
    }
    if (k === "r") this.setRain(!this.rain);
    if (k === "t") {
      this.timeSpeed = this.timeSpeed === 0 ? 150 : this.timeSpeed === 150 ? 1500 : 0;
      this.ui.toast("TIME ×" + this.timeSpeed);
    }
    if (k === "v") {
      this.grade = !this.grade;
      this.ui.toast("DASHCAM MODE " + (this.grade ? "ON" : "OFF"));
    }
    if (k === "m") {
      this.mirror = !this.mirror;
      this.rig.cockpit.setMirrorVis(this.mirror);
      this.ui.toast("MIRROR " + (this.mirror ? "ON" : "OFF"));
    }
    if (k === "n") {
      this.resetCar();
      this.ui.toast("RESET");
    }
    if (k === "h") this.ui.helpRequest();
    if (k === "x") {
      this.mmap = !this.mmap;
      const cv = document.getElementById("mmap");
      if (cv) cv.style.display = this.mmap ? "block" : "none";
      this.ui.toast("MAP " + (this.mmap ? "ON" : "OFF"));
    }
    if (k === "b") this.lookBack = true;
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keydown[e.key.toLowerCase()] = 0;
    if (e.key.toLowerCase() === "b") this.lookBack = false;
  };

  private bindInput() {
    addEventListener("keydown", this.onKeyDown);
    addEventListener("keyup", this.onKeyUp);
    const bindHold = (id: string, key: string) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("pointerdown", (e) => {
        el.setPointerCapture((e as PointerEvent).pointerId);
        this.keydown[key] = 1;
      });
      const off = () => (this.keydown[key] = 0);
      el.addEventListener("pointerup", off);
      el.addEventListener("pointercancel", off);
    };
    bindHold("tcL", "a");
    bindHold("tcR", "d");
    bindHold("tcG", "w");
    bindHold("tcB", "s");
    const camBtn = document.getElementById("tcC");
    if (camBtn)
      camBtn.addEventListener("pointerdown", () => {
        this.camMode = (this.camMode + 1) % 3;
      });
  }

  hookTilt() {
    if (this.tiltHooked) return;
    this.tiltHooked = true;
    try {
      const D = (window as any).DeviceOrientationEvent;
      if (D && D.requestPermission) D.requestPermission().catch(() => {});
      window.addEventListener("deviceorientation", (e: DeviceOrientationEvent) => {
        const o = typeof window.orientation === "number" ? (window.orientation as number) : 90;
        const raw = o === 90 ? -(e.beta || 0) : o === -90 ? e.beta || 0 : e.gamma || 0;
        this.tiltVal = clamp(raw / 26, -1, 1);
      });
    } catch {}
  }
  setWheelVal(v: number) {
    this.wheelVal = v;
  }

  private readInput(dt: number) {
    const kd = this.keydown;
    if (this.debug.override) {
      const o = this.debug.override;
      this.input.th = o.th ?? 0;
      this.input.br = o.br ?? 0;
      this.input.st = o.st ?? 0;
      this.input.hb = o.hb ?? 0;
      this.input.horn = o.horn ?? 0;
      return;
    }
    const tT = kd["w"] || kd["arrowup"] ? 1 : 0;
    const tB = kd["s"] || kd["arrowdown"] ? 1 : 0;
    const sL = kd["a"] || kd["arrowleft"] ? 1 : 0;
    const sR = kd["d"] || kd["arrowright"] ? 1 : 0;
    this.input.th += clamp(tT - this.input.th, -4.2 * dt, 3.2 * dt);
    this.input.br += clamp(tB - this.input.br, -6 * dt, 5.2 * dt);
    let sTarget = sL - sR;
    const analog = this.isTouch && this.settings.steerMode !== "buttons";
    if (analog) sTarget = this.settings.steerMode === "wheel" ? -this.wheelVal : -this.tiltVal;
    const sRate = analog ? 7 : lerp(3.4, 1.7, clamp(Math.abs(this.car.u) / 40, 0, 1));
    this.input.st += clamp(sTarget - this.input.st, -sRate * dt, sRate * dt);
    if (!sL && !sR && !analog) this.input.st *= Math.max(0, 1 - 6.5 * dt);
    this.input.hb = kd[" "] ? 1 : 0;
    this.input.horn = kd["f"] ? 1 : 0;
  }

  /* ---------------- settings ---------------- */
  private lastPR = -1;
  applySettings(s: GameSettings) {
    this.settings = s;
    const pr = this.perfMode
      ? 1
      : s.preset === "low"
        ? 1
        : s.preset === "medium"
          ? Math.min(devicePixelRatio, 1.5)
          : Math.min(devicePixelRatio, this.isTouch ? 1.35 : 1.75);
    if (pr !== this.lastPR) {
      // render targets are only rebuilt when the resolution actually changes —
      // slider drags hit this path every input tick
      this.lastPR = pr;
      this.renderer.setPixelRatio(pr);
      this.post.makeTargets(this.perfMode);
      this.mats.setReflectionTexture(this.post.reflectRT.texture);
      this.mats.setReflectionScreen(
        innerWidth * this.renderer.getPixelRatio(),
        innerHeight * this.renderer.getPixelRatio()
      );
    }
    this.mats.setWet(this.rain, s.reflections);
    this.timeSpeed = s.autoTime ? (this.timeSpeed === 0 ? 150 : this.timeSpeed) : 0;
    this.audio.setLevels(s.vol, this.running ? 1 : 0.12);
  }

  setRain(on: boolean) {
    this.rain = on;
    this.rainFX.pts.visible = on;
    this.mats.setWet(on, this.settings.reflections);
    this.ui.toast(on ? "RAIN — grip down" : "RAIN OFF");
  }

  /* ---------------- lifecycle ---------------- */
  start() {
    if (this.started) return;
    this.started = true;
    this.audio.init();
    this.audio.setCar(this.carId);
    this.last = performance.now() / 1000;
    this.loop();
  }

  setRunning(run: boolean) {
    this.running = run;
    this.audio.setLevels(this.settings.vol, run ? 1 : 0.12);
    if (!run) this.audio.quiesce();
    if (run) this.acc = 0;
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    removeEventListener("keydown", this.onKeyDown);
    removeEventListener("keyup", this.onKeyUp);
    removeEventListener("resize", this.onResize);
    window.removeEventListener("error", this.onWindowError);
    window.removeEventListener("blur", this.onWindowBlur);
    document.body.classList.remove("touch");
    this.audio.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    delete (window as any).__neonx;
  }

  private onResize = () => {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.post.makeTargets(this.perfMode);
    this.mats.setReflectionTexture(this.post.reflectRT.texture);
    this.mats.setReflectionScreen(
      innerWidth * this.renderer.getPixelRatio(),
      innerHeight * this.renderer.getPixelRatio()
    );
  };

  resetCar() {
    const car = this.car;
    if (car.y > 4) {
      // snap to nearest deck lane, keep travel direction
      const dir = Math.cos(car.h) >= 0 ? 1 : -1;
      car.x = HX + dir * LANE_OFF[1];
      car.z = clamp(car.z, -1080, 1080);
      car.h = dir > 0 ? 0 : Math.PI;
      car.y = DECKY;
    } else {
      let near = this.world.net.nearest(car.x, car.z);
      if (!near) {
        // stranded far from any road — fall back to the town centre road
        const e = this.world.net.nearest(0, 0);
        if (e) near = e;
      }
      if (near) {
        const pose = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
        this.world.net.sampleEdge(near.edge, near.s, pose);
        let hRoad = Math.atan2(pose.tx, pose.tz);
        // choose the direction closest to the car's current heading
        const d1 = Math.abs(Math.atan2(Math.sin(car.h - hRoad), Math.cos(car.h - hRoad)));
        if (d1 > Math.PI / 2) hRoad += Math.PI;
        const rx = Math.sin(hRoad + Math.PI / 2), rz = Math.cos(hRoad + Math.PI / 2);
        car.x = pose.x + rx * 1.95;
        car.z = pose.z + rz * 1.95;
        car.y = pose.y;
        car.h = hRoad;
      }
    }
    car.u = 0;
    car.v = 0;
    car.r = 0;
    car.delta = 0;
    car.rev = false;
    car.axS = 0;
    car.ayS = 0;
    car.wvx = 0;
    car.wvz = 0;
    car.slope = 0;
    car.pitchDyn = 0;
    this.pitchVis = 0;
    this.chasePos.set(car.x - Math.sin(car.h) * 4.4, car.y + 2.15, car.z - Math.cos(car.h) * 4.4);
    this.lookPos.set(car.x, car.y + 0.95, car.z);
  }

  /* ---------------- per-frame systems ---------------- */

  private dayFactor() {
    return clamp(Math.sin(((this.time - 6) / 12) * Math.PI) * 1.4, 0, 1);
  }

  private fogN = new THREE.Color(0x0a0d1a);
  private fogD = new THREE.Color(0x9db6d8);
  private fogRN = new THREE.Color(0x2c3340);
  private fogRD = new THREE.Color(0x6a7480);
  private sunN = new THREE.Color(0x9db4ff);
  private sunD = new THREE.Color(0xffe8c8);

  private weather(dt: number, now: number) {
    const car = this.car, world = this.world, sky = this.sky;
    this.time = (this.time + (this.timeSpeed * dt) / 3600) % 24;
    const f = this.dayFactor();
    sky.skyMat.map = sky.skyCache[Math.round(f * 7)] as THREE.Texture;
    this.fogC.copy(this.rain ? this.fogRN : this.fogN).lerp(this.rain ? this.fogRD : this.fogD, f);
    (this.scene.fog as THREE.FogExp2).color.copy(this.fogC);
    this.renderer.setClearColor(this.fogC);
    (this.scene.fog as THREE.FogExp2).density =
      (lerp(0.0021, 0.001, f) + (this.rain ? 0.0015 : 0)) * fogMultiplier(this.settings.fog);
    this.hemi.intensity = 0.32 + f * 0.6;
    this.amb.intensity = 0.34 + f * 0.28;
    this.sun.intensity = 0.14 + f * 1.15;
    this.sun.color.copy(this.sunN).lerp(this.sunD, f);
    const sa = ((this.time - 6) / 12) * Math.PI;
    this.sun.position.set(car.x - Math.cos(sa) * 520, Math.max(120, Math.sin(sa) * 640), car.z - 260);
    this.sun.target.position.set(car.x, 0, car.z);
    this.sun.castShadow = f > 0.22 && !this.perfMode && this.settings.shadows;
    sky.starMat.opacity = 0.8 * (1 - f);
    sky.moonMat.opacity = 0.95 * (1 - f);
    for (const m of this.mats.winMats) {
      m.emissiveIntensity = lerp(0.92, 0.12, f);
      m.color.setScalar(lerp(1, 3.6, f));
    }
    if (world.reflMat) world.reflMat.opacity = 0.85 * (1 - f);
    // heavier fog must also swallow the distant skyline ring, which renders
    // unfogged behind everything
    sky.skylineMat.opacity =
      (1 - f * 0.8) * clamp(1.9 - fogMultiplier(this.settings.fog), 0.12, 1);
    this.mats.sfMat.emissiveIntensity = lerp(0.78, 0.12, f);
    if (world.glowPts) (world.glowPts.material as THREE.PointsMaterial).opacity = 1 - f * 0.92;
    if (world.pools)
      (world.pools.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - f) + (this.rain ? 0.12 : 0);
    for (const m of world.neonMats) (m as THREE.MeshBasicMaterial).opacity = 1 - f * 0.72;
    if (world.beaconPts)
      (world.beaconPts.material as THREE.PointsMaterial).opacity =
        0.35 + 0.6 * (Math.sin(now * 2.4) * 0.5 + 0.5);
    sky.towersMat.opacity = (now % 1.6 < 0.8 ? 1 : 0.25) * (1 - f * 0.7);
    if (world.rampPostMat) world.rampPostMat.opacity = 0.6 + 0.35 * (Math.sin(now * 4) * 0.5 + 0.5);
    car.lightsOn = car.lightsUser || f < 0.35 || this.rain;
    // modern three uses physical (candela) spot intensities
    const si = car.lightsOn ? (this.rain ? 560 : 420) : 0;
    this.rig.spotL.intensity = si;
    this.rig.spotR.intensity = si;
    this.rig.headMat.emissiveIntensity = car.lightsOn ? 2.4 : 0.12;
    this.rig.hlGlowMat.opacity = car.lightsOn ? 0.8 * (1 - f * 0.85) : 0;
    this.rig.plateGlowMat.opacity = car.lightsOn ? 0.3 * (1 - f * 0.85) : 0;
    this.rainFX.update(dt, car.x, car.y, car.z, car.wvx, car.wvz);
  }

  private signalsUpdate(now: number) {
    const sh = this.world.signalHeads;
    if (!sh) return;
    const p = signalPhase(now);
    sh.nsG.visible = p === 0;
    sh.nsY.visible = p === 1;
    sh.nsR.visible = p >= 2;
    sh.ewG.visible = p === 3;
    sh.ewY.visible = p === 4;
    sh.ewR.visible = p <= 2 || p > 4.9;
  }

  private chunksUpdate() {
    const dd = this.perfMode ? Math.min(this.settings.drawDist, 520) : this.settings.drawDist;
    for (const c of this.world.chunks) {
      const d = Math.hypot(c.cx - this.camera.position.x, c.cz - this.camera.position.z);
      c.group.visible = d < dd;
    }
  }

  private blinkOnNow(now: number) {
    return now % 0.9 < 0.45;
  }

  private updateCarVisual(now: number, dt: number) {
    const car = this.car, rig = this.rig;
    rig.carGroup.position.set(car.x, car.y, car.z);
    rig.carGroup.rotation.y = car.h;
    /* Accel squat / brake dive. A road car lifts its nose noticeably only off
       the line; past ~50 km/h the pitch change is barely visible, and in the
       cockpit any lift pushes the dash up over the road. So fade the lift out
       with speed and cap it hard, while leaving brake dive (positive pitchDyn)
       mostly intact — dive shows more road, not less. */
    const spAbs = Math.abs(car.u);
    const liftScale = car.pitchDyn < 0 ? clamp(1.15 - spAbs / 14, 0.18, 1) : 1;
    const pitchT = clamp(car.pitchDyn * liftScale, -0.022, 0.05);
    this.pitchVis = lerp(this.pitchVis, pitchT, 1 - Math.exp(-7 * dt));
    rig.bodyG.rotation.x = -Math.atan(car.slope) + this.pitchVis;
    rig.bodyG.rotation.z = car.rollDyn;
    rig.carGroup.updateMatrixWorld();
    rig.cockpit.group.visible = this.camMode === 1;
    rig.exteriorG.visible = this.camMode !== 1;
    // the cockpit now has its own nav screen (drawScreen above), so the
    // external HUD minimap is redundant in that view — hide it
    if (this.mmap) {
      const mmapCv = document.getElementById("mmap");
      if (mmapCv) mmapCv.style.display = this.camMode === 1 ? "none" : "block";
    }
    rig.pivFL.rotation.y = car.delta;
    rig.pivFR.rotation.y = car.delta;
    const spin = (-car.u / this.spec.phys.WR) * dt;
    for (const w of rig.wheels) w.rotation.x += spin;
    rig.cockpit.wheelGroup.rotation.z = -car.delta * 4.6;
    this.sky.ferris.rotation.z += dt * 0.06;
    this.sky.beaconMat.opacity = now % 1.2 < 0.6 ? 0.95 : 0.12;
    if (this.world.goreBeaconMat)
      this.world.goreBeaconMat.opacity = (now * 1.4) % 1 < 0.55 ? 0.95 : 0.15;
    const braking = (car.brkEff > 0.12 && !car.rev) || this.input.hb > 0;
    rig.tailMat.emissiveIntensity = braking ? 3.6 : car.lightsOn ? 0.95 : 0.12;
    const bOn = this.blinkOnNow(now);
    rig.sigMatL.emissiveIntensity = car.sigL && bOn ? 3 : 0;
    rig.sigMatR.emissiveIntensity = car.sigR && bOn ? 3 : 0;
    let wiping = false;
    if (this.rain) {
      const ph = Math.sin(now * 3.6) * 0.5 + 0.5;
      rig.cockpit.wiperA.rotation.z = -0.12 - ph * 1.23;
      rig.cockpit.wiperB.rotation.z = -0.12 - ph * 1.23;
      rig.cockpit.wiperA.visible = rig.cockpit.wiperB.visible = true;
      wiping = true;
    } else {
      rig.cockpit.wiperA.rotation.z = lerp(rig.cockpit.wiperA.rotation.z, -0.12, 0.1);
      rig.cockpit.wiperB.rotation.z = lerp(rig.cockpit.wiperB.rotation.z, -0.12, 0.1);
    }
    this.gaugeT += dt;
    this.dropT += dt;
    if (this.gaugeT > 0.045 && this.camMode === 1) {
      this.gaugeT = 0;
      rig.cockpit.drawGauges(
        car.rpm, Math.abs(car.u) * 3.6, car.rev ? "R" : "D" + car.gear, now,
        {
          lightsOn: car.lightsOn, sigL: car.sigL, sigR: car.sigR, rain: this.rain,
          tcOn: car.tcOn, odo: car.odo, revLimit: this.spec.phys.revLimit,
          units: this.settings.units, onLimiter: car.onLimiter,
        }
      );
      rig.cockpit.drawScreen(car.x, car.z, car.h, this.time, this.world);
    }
    if (this.dropT > 0.033) {
      rig.cockpit.dropletsUpdate(this.dropT, wiping, rig.cockpit.wiperA.rotation.z, this.rain, Math.abs(car.u));
      this.dropT = 0;
    }
  }

  /** deterministic 1D hash in [0,1) — same input always gives the same
      output, so road texture is a fixed property of a position, not a
      per-frame random draw. */
  private static hash1(n: number): number {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  /** smooth 1D value noise, one octave, range [-1, 1]. */
  private static vnoise(x: number): number {
    const i = Math.floor(x), f = x - i;
    const a = Game.hash1(i), b = Game.hash1(i + 1);
    const t = f * f * (3 - 2 * f); // smoothstep
    return lerp(a, b, t) * 2 - 1;
  }
  /** three-octave road texture at position z, offset by seed so the x and y
      jitter channels use independent (but still position-locked) noise. */
  private static roadTexture(z: number, seed: number): number {
    return (
      Game.vnoise(z * 2.1 + seed) * 0.55 +
      Game.vnoise(z * 5.3 + seed * 1.7 + 91.7) * 0.3 +
      Game.vnoise(z * 11.7 + seed * 2.3 + 401.3) * 0.15
    );
  }

  private updateCamera(dt: number) {
    const car = this.car;
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    /* Reverse chase cam: only once the car is genuinely rolling backwards, not
       the instant the reverse key is tapped. Hysteresis on speed keeps it from
       flickering around the threshold, and the ease takes ~0.7 s each way. */
    const revWant = car.rev && car.u < (this.revCam > 0.5 ? -1.0 : -1.8) ? 1 : 0;
    this.revCam = lerp(this.revCam, revWant, 1 - Math.exp(-3.2 * dt));
    if (this.revCam < 0.002) this.revCam = 0;
    if (this.camMode === 0) {
      // chase
      // chasePos/lookPos only get updated in this branch, so after a stretch
      // in cockpit/hood view they're stale (wrong height after an elevation
      // change, wrong lateral offset after turns) — easing from that on
      // re-entry reads as the camera diving before it settles. Snap instead.
      const freshEntry = this.lastCamMode !== 0;
      const dist = (3.75 + this.spec.shell.L * 0.25) + clamp(Math.abs(car.u) * 0.03, 0, 0.9);
      // flip: 0 = camera behind the car, 1 = in front of it looking back. The
      // swing is an arc around the car, not a lerp through it.
      const flip = this.lookBack ? 1 - this.revCam : this.revCam;
      const ang = car.h + Math.PI * (1 - flip);
      const ax = Math.sin(ang), az = Math.cos(ang);
      this.tmpV.set(car.x + ax * dist, car.y + 2.15, car.z + az * dist);
      if (freshEntry) this.chasePos.copy(this.tmpV);
      else this.chasePos.lerp(this.tmpV, 1 - Math.exp(-5.5 * dt));
      // smoothing lags a moving target by ~speed/5.5 m; cap the trail so the
      // camera can't drift arbitrarily far behind at high speed, and keep a
      // minimum radius so the mid-swing shortcut never clips through the car
      const dxC = this.chasePos.x - car.x, dzC = this.chasePos.z - car.z;
      const hd = Math.hypot(dxC, dzC), maxD = dist + 1.2, minD = dist * 0.6;
      if (hd > maxD) {
        this.chasePos.x = car.x + (dxC / hd) * maxD;
        this.chasePos.z = car.z + (dzC / hd) * maxD;
      } else if (hd > 1e-4 && hd < minD) {
        this.chasePos.x = car.x + (dxC / hd) * minD;
        this.chasePos.z = car.z + (dzC / hd) * minD;
      }
      this.chasePos.y = Math.max(
        this.chasePos.y,
        this.terrain.heightAt(this.chasePos.x, this.chasePos.z, car.y) + 1.2
      );
      /* mild lateral lag: the camera drifts a beat behind the car's yaw rate,
         then eases back to centre — a trailing lean rather than an instant
         follow. Purely a position offset so it can't disturb the trail-length
         clamps above or the raise/snap-on-switch logic. */
      const rgX = fz, rgZ = -fx; // world-space "right" of the car's heading
      const lagTarget = freshEntry
        ? 0
        : clamp(-car.r * Math.abs(car.u) * 0.028, -0.35, 0.35);
      if (freshEntry) {
        this.chaseLag.x = 0;
        this.chaseLag.vx = 0;
      } else {
        this.chaseLag.vx += (lagTarget - this.chaseLag.x) * 24 * dt;
        this.chaseLag.vx *= Math.exp(-6 * dt);
        this.chaseLag.x += this.chaseLag.vx * dt;
      }
      this.camera.position.copy(this.chasePos);
      this.camera.position.x += rgX * this.chaseLag.x;
      this.camera.position.z += rgZ * this.chaseLag.x;
      // aim past the car, away from wherever the camera currently sits
      const lat = car.delta * 1.6 * (1 - 2 * flip);
      this.tmpV2.set(
        car.x - ax * 2.8 + fz * lat,
        car.y + 0.95,
        car.z - az * 2.8 - fx * lat
      );
      // aim is smoothed too — the delta term above snaps with keyboard taps
      if (freshEntry) this.lookPos.copy(this.tmpV2);
      else this.lookPos.lerp(this.tmpV2, 1 - Math.exp(-9 * dt));
      this.camera.lookAt(this.lookPos);
    } else {
      const back = this.lookBack ? Math.PI : 0;
      this.head.vx += (-car.ayS * 0.006 - this.head.x * 46) * dt;
      this.head.vx *= Math.exp(-8 * dt);
      this.head.x += this.head.vx * dt;
      this.head.vy += (car.axS * 0.004 - this.head.y * 46) * dt;
      this.head.vy *= Math.exp(-8 * dt);
      this.head.y += this.head.vy * dt;
      this.head.x = clamp(this.head.x, -0.05, 0.05);
      this.head.y = clamp(this.head.y, -0.04, 0.04);
      /* G-force lean: a couple of degrees of roll into the corner (paired with
         the head.x lateral shift above) and a couple cm of fore/aft dip under
         braking vs acceleration (paired with head.y). Same spring shape, kept
         well inside motion-sickness-safe territory. */
      this.head.vroll += (-car.ayS * 0.09 - this.head.roll * 40) * dt;
      this.head.vroll *= Math.exp(-8 * dt);
      this.head.roll += this.head.vroll * dt;
      this.head.roll = clamp(this.head.roll, -0.035, 0.035); // ~±2°
      /* brake dive is deliberately non-linear: light trail-braking dips barely
         more than a gentle lift-off, but hard braking dives disproportionately
         harder (matches how sim-racing head-physics mods read trail braking as
         dramatic). Acceleration press-back stays linear — only the braking
         side is curved. The curve and the linear accel term agree at |axS|=1
         so there's no seam at zero-crossing. */
      const axDrive = car.axS >= 0 ? car.axS * 0.003 : -Math.pow(-car.axS, 1.8) * 0.003;
      this.head.vz += (axDrive - this.head.z * 46) * dt;
      this.head.vz *= Math.exp(-8 * dt);
      this.head.z += this.head.vz * dt;
      this.head.z = clamp(this.head.z, -0.025, 0.025);
      /* corner lookahead: cockpit-only, eases the view a few degrees toward
         the steering direction, scaled by speed so it's zero at a standstill
         and fades out when looking back. */
      const lookSp = clamp(Math.abs(car.u) / 20, 0, 1);
      const lookTarget =
        this.camMode === 1 && !this.lookBack
          ? clamp((car.delta * 2.2 + car.r * 0.35) * lookSp, -0.13, 0.13) // ~±7.5°
          : 0;
      this.lookaheadYaw = lerp(this.lookaheadYaw, lookTarget, 1 - Math.exp(-4 * dt));
      const P = this.spec.shell;
      /* Looking back, a driver leans in toward the centre of the car and cranes
         up — pivoting the eye in place instead just stares into their own
         headrest. Eased so tapping B doesn't snap the head sideways. */
      this.lbLean = lerp(
        this.lbLean, this.lookBack && this.camMode === 1 ? 1 : 0,
        1 - Math.exp(-9 * dt)
      );
      const eyeX = COCKPIT_EYE.x * (P.W / COCKPIT_REF.W);
      const local =
        this.camMode === 1
          // seating position lives in cockpit.ts: the binnacle, wheel and mirror
          // are all pinned to COCKPIT_EYE, so the eye must come from there too
          ? this.tmpV.set(
            eyeX * (1 - 0.8 * this.lbLean) + this.head.x,
            P.belt - COCKPIT_REF.belt + COCKPIT_EYE.y + 0.06 * this.lbLean + this.head.y,
            COCKPIT_EYE.z + this.head.z
          )
          : this.tmpV.set(0, P.belt + 0.5 + this.head.y * 0.5, P.L / 2 - 0.6);
      /* road micro-vibration (cockpit only): multi-octave value noise keyed
         off car.z, not time. Same stretch of road always buzzes the same
         way — no randomness and nothing that drifts, so it can't build into
         motion sickness the way an unbounded random walk could. Driving the
         noise off position rather than a clock also means covering the same
         bump faster at speed raises the buzz's frequency for free, which is
         exactly how road texture reads through a real chassis. Amplitude
         scales with speed^2 (capped ~180 km/h) so it's essentially silent
         under 100 km/h and builds fast above it, plus a smaller boost from
         tire slip on rough moments. Millimetre-scale, layered on top of the
         G-force lean above rather than replacing it. */
      if (this.camMode === 1) {
        const spN = clamp(Math.abs(car.u) / 50, 0, 1); // 1.0 ≈ 180 km/h
        const vibeAmt = spN * spN * 0.85 + clamp(car.slipAmt, 0, 1) * 0.15;
        if (vibeAmt > 0.001) {
          local.x += Game.roadTexture(car.z, 0) * vibeAmt * 0.003;
          local.y += Game.roadTexture(car.z, 57.9) * vibeAmt * 0.002;
        }
      }
      /* The eye rides the body shell, so the dash and mirrors hold still in
         frame the way they do in a real car; the world pitches instead. Body
         pitch is nose-up-negative, camera pitch is look-up-positive, hence the
         sign flip — getting that backwards made the view stare at the tarmac
         uphill and at the sky downhill. */
      this.camera.position.copy(this.rig.bodyG.localToWorld(this.tmpV2.copy(local)));
      this.camera.rotation.y = car.h + Math.PI + back + this.lookaheadYaw;
      this.camera.rotation.x = -this.rig.bodyG.rotation.x * (this.lookBack ? -1 : 1);
      // roll matches the shell for the same reason the pitch does, plus the
      // G-lean roll from above
      this.camera.rotation.z =
        -this.rig.bodyG.rotation.z + clamp(car.u * car.r * 0.0035, -0.06, 0.06) + this.head.roll;
    }
    const kickM = this.camMode === 0 ? 0.18 : this.camMode === 2 ? 0.6 : 1;
    const fovT = this.settings.fovBase + clamp(Math.abs(car.u) * 0.21, 0, 19) * kickM;
    if (Math.abs(this.camera.fov - fovT) > 0.25) {
      this.camera.fov = fovT;
      this.camera.updateProjectionMatrix();
    }
    this.lastCamMode = this.camMode;
  }

  private renderMirror() {
    const rig = this.rig;
    const iv = rig.cockpit.group.visible, ev = rig.exteriorG.visible;
    rig.cockpit.group.visible = false;
    rig.exteriorG.visible = false;
    // planar road reflections sample screen-space UVs — wrong for the rear cam
    for (const m of this.mats.refMats)
      if (m.userData.sh) m.userData.sh.uniforms.uRefStr.value = 0;
    const car = this.car;
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    this.rearCam.position.copy(rig.carGroup.localToWorld(this.tmpV.set(0, 1.34, -0.4)));
    this.tmpV2.set(car.x - fx * 50, car.y + 1.1, car.z - fz * 50);
    this.rearCam.lookAt(this.tmpV2);
    this.renderer.setRenderTarget(this.post.mirrorRT);
    this.renderer.render(this.scene, this.rearCam);
    this.renderer.setRenderTarget(null);
    for (const m of this.mats.refMats)
      if (m.userData.sh) m.userData.sh.uniforms.uRefStr.value = m.userData.curStr;
    rig.cockpit.group.visible = iv;
    rig.exteriorG.visible = ev;
  }

  private renderReflection() {
    this.camera.updateMatrixWorld();
    const h = clamp(this.car.y, 0, DECKY); // mirror plane at current road height
    this.mirM.makeScale(1, -1, 1);
    this.mirM.setPosition(0, 2 * h, 0);
    this.refCam.matrix.copy(this.camera.matrixWorld).premultiply(this.mirM);
    this.refCam.updateMatrixWorld(true);
    this.refCam.projectionMatrix.copy(this.camera.projectionMatrix);
    this.refCam.projectionMatrix.elements[0] *= -1;
    this.renderer.setRenderTarget(this.post.reflectRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.refCam);
    this.renderer.setRenderTarget(null);
  }

  private hud(now: number, dt: number) {
    this.hudT += dt;
    const car = this.car;
    if (this.hudT > 0.08) {
      this.hudT = 0;
      const el = document.getElementById("spd");
      if (el)
        el.innerHTML =
          Math.round(speedInUnits(car.u, this.settings.units)) +
          "<small>" + unitLabel(this.settings.units) + "</small>";
      const eg = document.getElementById("gearTxt");
      if (eg)
        eg.textContent =
          (car.rev ? "R" : "D" + car.gear) +
          (this.input.hb ? " ✋" : "") +
          (car.absOn ? " ABS" : "") +
          (car.y > 3 ? " 首都高" : "");
      const ec = document.getElementById("clock");
      if (ec) {
        const hh = Math.floor(this.time), mm = Math.floor((this.time - hh) * 60);
        ec.textContent = (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
      }
      const ew = document.getElementById("wx");
      if (ew) {
        const wx = this.rain ? "rain" : this.dayFactor() < 0.35 ? "moon" : "sun";
        if (ew.dataset.wx !== wx) {
          ew.dataset.wx = wx;
          ew.innerHTML = WX_ICONS[wx];
        }
      }
      /* exit navigation hint */
      if (car.y > 4 && Math.abs(car.u) > 1) {
        const ex = nearestExitAhead(this.world, car.z, Math.cos(car.h));
        if (ex && ex.dist < 400 && ex.dist > -5) {
          this.ui.exitHint(
            `EXIT ${ex.no} ${ex.name} ▸ ${Math.max(0, Math.round(ex.dist / 10) * 10)} m`
          );
        } else this.ui.exitHint(null);
      } else this.ui.exitHint(null);
    }
    const bOn = this.blinkOnNow(now);
    const il = document.getElementById("indL"), ir = document.getElementById("indR");
    if (il) il.className = "ind" + (car.sigL && bOn ? " on" : "");
    if (ir) ir.className = "ind" + (car.sigR && bOn ? " on" : "");
    if ((car.sigL || car.sigR) && bOn !== this.prevBlinkOn) this.audio.tick();
    this.prevBlinkOn = bOn;
  }

  private perfCheck(ms: number, dt: number) {
    this.emaMs = lerp(this.emaMs, ms, 0.06);
    if (!this.perfMode && this.emaMs > 37) {
      this.slowT += dt;
      if (this.slowT > 4) {
        this.perfMode = true;
        this.renderer.setPixelRatio(1);
        this.post.makeTargets(true);
        this.mats.setReflectionTexture(this.post.reflectRT.texture);
        this.mats.setReflectionScreen(
          innerWidth * this.renderer.getPixelRatio(),
          innerHeight * this.renderer.getPixelRatio()
        );
        this.ui.toast("PERFORMANCE MODE");
      }
    } else this.slowT = Math.max(0, this.slowT - dt);
  }

  /* ---------------- main loop ---------------- */
  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const t0 = performance.now(), now = t0 / 1000;
    let dt = Math.min(now - this.last, 0.1);
    this.last = now;
    this.debug.frames++;
    this.readInput(dt);
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);
    if (this.running) {
      this.acc += dt;
      let it = 0;
      while (this.acc >= 1 / 120 && it++ < 6) {
        stepPhysics(this.car, this.input, this.spec.phys, 1 / 120, {
          mu: this.rain ? 0.84 : 1.26,
          tcEnabled: this.settings.tc,
          heightAt: this.terrain.heightAt,
        });
        this.acc -= 1 / 120;
      }
      // drop backlog on slow frames — no fast-forward burst when fps recovers
      if (this.acc > 1 / 120) this.acc = 0;
      const res = collidePlayer(this.car, this.world, this.traffic.npcs, this.rig.halfW, this.rig.halfL);
      for (const hitInfo of res.npcHits) {
        this.traffic.applyImpact(hitInfo);
        if (hitInfo.relSpeed > 2.5 && this.crashCooldown <= 0) {
          this.crashCooldown = 0.4;
          this.audio.crash(hitInfo.relSpeed);
          this.car.damage += hitInfo.relSpeed * 0.5;
        }
      }
      if (res.wallImpact > 4 && this.crashCooldown <= 0) {
        this.crashCooldown = 0.4;
        this.audio.crash(res.wallImpact);
      }
      this.camera.getWorldDirection(this.tmpV);
      this.traffic.update(
        dt, now, this.car, this.tmpV.x, this.tmpV.z,
        this.settings.traffic, this.input.horn > 0, this.dayFactor() < 0.32 || this.rain
      );
      for (const w of this.traffic.activeWrecks())
        if (Math.random() < 0.35) this.smokeFX.emit(w.x, w.y + 0.9, w.z, Math.random() < 0.15);
      this.smokeFX.update(dt);
      this.signalsUpdate(now);
      this.weather(dt, now);
      this.updateCarVisual(now, dt);
      this.updateCamera(dt);
      this.audio.update(
        this.car.rpm, this.car.thrEff, this.car.slipAmt, Math.abs(this.car.u), now,
        this.car.cut > 0 || this.car.shiftT > 0.1, this.rain, this.input.horn > 0,
        this.car.gear, this.car.onLimiter
      );
      this.hud(now, dt);
      this.chunkT += dt;
      if (this.chunkT > 0.16) {
        this.chunkT = 0;
        this.chunksUpdate();
      }
      const mmapCv = document.getElementById("mmap") as HTMLCanvasElement | null;
      if (this.mmap && mmapCv && this.camMode !== 1 && this.frameN % 4 === 0)
        drawMiniMap(mmapCv, this.world, this.car, this.traffic.npcs, now);
    } else {
      this.acc = 0;
      this.updateCarVisual(now, dt);
      this.updateCamera(dt);
      this.weather(0, now);
    }
    this.frameN++;
    if (this.mirror && this.camMode === 1 && this.frameN % 2 === 0) this.renderMirror();
    if (this.settings.reflections && (!this.perfMode || this.frameN % 2 === 0))
      this.renderReflection();
    this.camera.updateMatrixWorld();
    this.renderer.setRenderTarget(this.post.sceneRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const f = this.dayFactor();
    this.post.setSpeed(Math.abs(this.car.u) * 3.6);
    this.post.process({
      exposure: lerp(1.12, 0.9, f),
      grade: this.grade,
      bloom: this.settings.bloom,
      fxaa: this.settings.fxaa,
      mblur:
        this.settings.mblur && this.running
          ? clamp((Math.abs(this.car.u) * 3.6 - 70) / 170, 0, 0.42)
          : 0,
      time: now,
    });
    this.perfCheck(performance.now() - t0, dt);
  };
}
