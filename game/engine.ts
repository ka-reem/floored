import * as THREE from "three";
import { clamp, lerp, mulberry32 } from "./util";
import {
  fogMultiplier, speedInUnits, unitLabel,
  type GameSettings, type Profile,
} from "./settings";
import { getCar, PAINTS, type CarSpec } from "./carspecs";
import { buildMats, type Mats } from "./world/mats";
import { primeCarEnv } from "./carenv";
import { makeTerrain, buildGround, type Terrain } from "./world/terrain";
import { buildRoadNet } from "./world/roadnet";
import { buildHighway, nearestExitAhead } from "./world/highway";
import { buildTown } from "./world/townmesh";
import { buildSky, type Sky } from "./world/sky";
import { ColliderIndex, signalPhase, type WorldData } from "./world/data";
import { DECKY } from "./world/const";
import { getCorridor, TUNNEL } from "./world/corridor";
import { spawnZ } from "./world/ramps";
import { stepPhysics, freshCarState, type CarState, type DriverInput } from "./physics";
import { collidePlayer } from "./collide";
import { buildPlayerCar, type PlayerRig } from "./player";
import { COCKPIT_REF, EYE as COCKPIT_EYE, type GaugeFlags } from "./cockpit";
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

/** How many NPCs are fed to the audio doppler pool each frame — its pool size.
    The horn and chirp one-shots build their own nodes, so they are not in
    contention with these and there is nothing to hold back for. */
const NPC_VOICES = 8;

/* The v2 art (procedural canvas textures + hex palettes) was tuned under
   r128's non-color-managed pipeline; keep that exact response and do the
   ACES + sRGB encode ourselves in the composite pass. */
THREE.ColorManagement.enabled = false;

const LAYER_NOREF = 1;

/** Headlight throw, metres: dipped and main. These set the spotlight distance
    and, as a ratio, how far down the road the retroreflective paint answers —
    one pair of numbers so the light pool and the paint cannot disagree. */
const HL_THROW = 115, HL_THROW_HI = 200;

/** Lateral fill-cone throw, metres — shorter than the main beam's on
    purpose: this cone's job is lighting the adjacent lane close in, not
    reaching down the road, and a longer cutoff would just mean more of it
    sits inside the anti-blowout knee's compressed zone for no visual gain. */
const HL_SPREAD_THROW = 30, HL_SPREAD_THROW_HI = 42;

/** Lateral fill-cone pitch, radians below horizontal, edge-pinned the same
    way as the main beam (see the loop below): this is the AXIS angle, not
    the cutoff, and for a cone this wide the axis has to point down by
    nearly its own half-angle before the upper edge clears horizontal. Tuned
    against the vertical-panel knee check, not against reach — a shallower
    pitch reaches further but re-opens the whiteout this replaced. */
const HL_SPREAD_PITCH = (26 * Math.PI) / 180, HL_SPREAD_PITCH_HI = (28 * Math.PI) / 180;

/** Headlight aim, as the slope of the beam's upper edge — the cut-off — not
    of its axis. Positive is downward.

    Dipped beam is aimed 0.4% below horizontal — shallower than the ECE
    1.0–1.5% floor for a lamp at this height, traded deliberately for reach:
    the cut-off meets the road at lampHeight/0.004, i.e. 125 m on the
    lowest-nosed shell and 155 m on the highest, well past HL_THROW's own
    cutoff, so the pool's tail is intensity-limited rather than geometry-
    limited before the cut-off would otherwise clip it.

    Main beam is aimed 2.6% ABOVE horizontal instead. Level would be more
    literal, but at 40 m a level cut-off tops out around 0.85 m and leaves the
    greenhouse of the car in front dark, which loses the one contrast that
    makes flashing worth anything. 2.6% clears a roof at 40 m and keeps
    clearing it further out. */
const LOW_DIP = 0.004, HI_RISE = 0.026;

/** How bright lane paint sits at night *outside* the headlight beam, 0..1.
    Lower than mats.ts's 0.18 default because the night deck underneath it is
    now about six times darker while the paint, being unlit, did not change at
    all: at the old floor the markings hold their full daytime punch against a
    near-black road and the beam stops being the thing that reveals them. Not
    taken further down because this single number also stands in for every
    other light in the world — under a sodium pool real paint is plainly
    visible, and the shader knows nothing about the streetlights. */
const BEAM_FLOOR = 0.13;

/** Seconds G must be held before it toggles the high-beam latch instead of
    flashing. Long enough that no flash-to-pass reaches it — a pass flash is a
    few hundred ms — and short enough to be a deliberate press, not a wait. */
const HI_HOLD = 2;

/* Camera modes, in cycle order. CAM_POV is the hard-mounted dashcam: it shares
   the cockpit's rendering (interior shell visible, mirror and gauges live) but
   none of its head physics — a bracket bolted over the dash does not lean into
   corners, crane to look back, or breathe under braking. */
const CAM_CHASE = 0, CAM_COCKPIT = 1, CAM_HOOD = 2, CAM_POV = 3;
const CAM_COUNT = 4;
const CAM_NAMES = ["CHASE", "COCKPIT", "HOOD", "DASHCAM"];

/* Dashcam mount, as an offset from the driver's eye (see cockpit.ts EYE): high
   over the dash, a little inboard of the driver, aimed down across the cluster.
   In cockpit-local terms x 0.28, y 1.32, z 0.31 — 0.61 m forward of the eye and
   3 cm below it. dx is scaled with the shell width for the same reason the eye
   is, so it keeps its position relative to the binnacle on every car.

   The framing is a three-way squeeze and the numbers are not free:

   - The binnacle sets the height. Its hood lip is pinned ~7 degrees under the
     eye line (cockpit.ts), so the lens has to sit above and behind it and tilt
     down to catch the dial faces, which are raked back 26 degrees.
   - The mirror housing sets the ceiling. It hangs at z 0.6 and, from anywhere
     far enough back to frame the cluster, it is inside the field of view. It
     costs the top ~15% of the frame; buying it back would mean dropping the
     cluster to ~48% down, i.e. half the frame full of interior.
   - The lateral offset is what makes the gauges readable. The cluster is
     0.68 m wide at x 0.38 (RHD) and the lens is ~0.3 m from it, so a
     centreline mount runs it off the right edge of the frame. x 0.28 keeps all
     but the outer sliver of it in shot without reading as the driver's eye.

   The steering wheel rim cannot be had as well: including it forces the cluster
   up to ~40% down, which puts the interior over more than half the frame. */
const POV_MOUNT = { dx: 0.28, dy: -0.03, dz: 0.61 };
/* 13 degrees of nose-down, on top of whatever the body is doing. This is what
   rakes the dial faces into the bottom of the frame instead of showing their
   top edge side-on, and it settles the horizon at ~34% down. Raising it further
   walks the whole interior up the frame and eats the road. */
const POV_TILT = 0.227;
/* Real dashcam lenses are quoted diagonally at 130-170; the useful figure is
   the horizontal one, and 105 is a typical mid-range unit. three's fov is
   vertical, so it is derived from the aspect each frame and clamped so a
   portrait phone does not end up with a fisheye. */
const POV_HFOV = 105;

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
  /* High beams. G is momentary (flash-to-pass) on a short press and toggles the
     latch when held past HI_HOLD, which is as close to a column stalk as one
     key gets — a real stalk separates the two the same way, by how far you push
     it rather than by how fast you tap. Held here rather than on CarState
     because physics.ts owns that type and none of this is physics — nothing
     downstream of the lamps reads it. */
  private hiHeld = false;
  private hiLatch = false;
  private hiDownAt = -1;
  /** the current press already spent itself toggling the latch, so its release
      must not also be read as the end of a flash */
  private hiConsumed = false;

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
  private cor = getCorridor();
  /** how many times the endless-highway splice has fired; odometer and lap
      logic read this, the car's own z stays inside the canonical band */
  private loops = 0;
  /** smoothed tunnel blend (0 outside, 1 well inside), and the edge-triggered
      "am I in the tunnel" flag that drives the entry/exit thumps */
  private tunT = 0;
  private tunIn = false;
  /** refractory timer, so a car hovering at a mouth can't machine-gun thumps */
  private tunThumpCd = 0;
  /** pooled entries + the truncated view handed to the audio NPC pool each
      frame, so the feed costs no allocation once it is warm */
  private npcPool = Array.from({ length: NPC_VOICES }, () => ({
    x: 0, z: 0, vx: 0, vz: 0, heavy: false,
  }));
  private npcFeed: { x: number; z: number; vx: number; vz: number; heavy: boolean }[] = [];
  /** last state pushed to mats.setPbrDetail; the call recompiles materials, so
      it must only ever fire on a real transition */
  private pbrDetail = true;
  /** last value handed to setReverb, so the common no-op case stays free */
  private lastReverb = -1;
  /** camMode as of the last interior-EQ update — cheaper than calling
      setInterior every frame and keeps the audio side edge-triggered */
  private lastInteriorMode = -1;
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
    /* On the low preset the photo scans are not fetched at all — some 60 MB of
       texture memory and a 5 MB download, on exactly the device that asked for
       less. The load is deferred rather than cancelled, so updatePbrDetail()
       turning detail back on when the preset is raised is also what starts it,
       and the world upgrades in place. */
    this.mats = buildMats({ pbr: profile.settings.preset !== "low" });
    // async: swaps a real night-city HDRI under the car bodywork when one is
    // on disk, otherwise the painted cube env above stays
    primeCarEnv(this.renderer, this.mats.envMap);
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
    this.tintLampsSodium();

    this.traffic = new Traffic(this.scene, this.world, this.mats.envMap, this.mats.glowTex, 120);
    this.rainFX = new RainFX(this.scene, this.mats.streakTex);
    this.smokeFX = new SmokeFX(this.scene, this.mats.smokeTex);

    /* Spawn on the corridor rather than at a fixed offset: the centreline
       wanders by up to 62 m and the deck rises and falls by 5, so a hardcoded
       (HX, DECKY) start would drop the car beside or under the road.

       spawnZ() is the centre of the town-side window: the stretch beside the
       town that is straight, level, clear of both ramps' parapet gaps (the z
       range where the deck's barrier is cut away for a ramp to peel off), out
       of the tunnel and off the toll plaza. It is derived from the ramp layout
       rather than written down here on purpose — this used to be a literal, and
       when the gores moved it silently ended up inside a gap, spawning the
       player next to a hole in the wall. */
    const spawn = this.cor.respawn(spawnZ(), 1);
    this.car = freshCarState(spawn.x, spawn.y, spawn.z, spawn.h, 23);
    this.buildRig();
    this.chasePos.set(this.car.x, this.car.y + 2.15, this.car.z - 7);
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
        else {
          // the deck is the surface that matters for most test placements, and
          // it sits well above the terrain it flies over
          const deck = this.cor.heightAt(x, z, 2);
          this.car.y = deck ?? this.terrain.heightAt(x, z, this.car.y);
        }
        if (h !== undefined) this.car.h = h;
        if (u !== undefined) this.car.u = u;
        this.car.v = 0;
        this.car.r = 0;
        this.car.wvx = 0;
        this.car.wvz = 0;
        this.chasePos.set(this.car.x - Math.sin(this.car.h) * 4.4, this.car.y + 2.15, this.car.z - Math.cos(this.car.h) * 4.4);
        this.lookPos.set(this.car.x, this.car.y + 0.95, this.car.z);
      },
      setCam: (i: number) => (this.camMode = i % CAM_COUNT),
      setInput: (o: Partial<DriverInput> | null) => (this.debug.override = o),
      /* Drop the car onto the corridor at a given z, in lane, at speed. The
         two named spots are the ones worth eyeballing: the tunnel approach and
         the run-up to the loop splice. */
      toCorridor: (z: number, kmh = 110, lane?: number) => {
        const p = this.cor.respawn(z, lane);
        this.car.x = p.x;
        this.car.y = p.y;
        this.car.z = p.z;
        this.car.h = p.h;
        this.car.u = kmh / 3.6;
        this.car.v = 0;
        this.car.r = 0;
        this.car.rev = false;
        this.car.wvx = 0;
        this.car.wvz = 0;
        this.chasePos.set(p.x - Math.sin(p.h) * 4.4, p.y + 2.15, p.z - Math.cos(p.h) * 4.4);
        this.lookPos.set(p.x, p.y + 0.95, p.z);
      },
      // derived from the tunnel itself, so it still lands on the approach if
      // the mouth ever moves — 80 m out is clear of the fade but close enough
      // to reach the thump within a second or two
      toTunnel: (kmh = 110) => (window as any).__neonx.toCorridor(TUNNEL.z0 - 80, kmh),
      toSeam: (kmh = 110) => (window as any).__neonx.toCorridor(this.cor.Z1 - 120, kmh),
      state: () => ({
        x: this.car.x, y: this.car.y, z: this.car.z, h: this.car.h,
        u: this.car.u, kmh: Math.abs(this.car.u) * 3.6,
        mph: Math.abs(this.car.u) * 2.236936,
        gear: this.car.gear, rpm: this.car.rpm,
        rev: this.car.rev, slope: this.car.slope, pitchDyn: this.car.pitchDyn,
        odo: this.car.odo, loops: this.loops,
        tunnel: this.tunT, inTunnel: this.tunIn,
        corZ: this.cor.zAt(this.car.x, this.car.z),
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
    /* The keyup for a held G never arrives if the tab lost focus mid-flash.
       Clearing hiHeld also disarms the hold timer, so a G held through an
       alt-tab cannot come back two seconds later having toggled the latch. */
    this.hiHeld = false;
    this.hiConsumed = false;
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
      this.camMode = (this.camMode + 1) % CAM_COUNT;
      this.ui.toast(CAM_NAMES[this.camMode]);
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
    if (k === "g") {
      /* Momentary while held; a long hold toggles the latch instead. Nothing
         is decided here beyond starting the clock — which of the two gestures
         this turns out to be is only known at 2 s (hiBeamHold) or at release,
         whichever comes first. `e.repeat` is already filtered above, so
         autorepeat can't re-arm the timer under a held key. */
      this.hiHeld = true;
      this.hiConsumed = false;
      this.hiDownAt = performance.now() / 1000;
    }
  };
  private onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    this.keydown[k] = 0;
    if (k === "b") this.lookBack = false;
    if (k === "g") {
      // A release that ends a latch toggle is not also a flash: the gesture was
      // already spent at the 2 s mark, and without this the beams would blink
      // back on for the instant between the toggle and letting go.
      this.hiHeld = false;
      this.hiConsumed = false;
    }
  };

  /** Resolve a held G once it passes the hold threshold. Runs off the frame
      clock rather than a timer, so it cannot fire after the key is released or
      after focus is lost — both of those clear hiHeld first.

      Dropping hiHeld here as well as setting hiConsumed is what makes the
      toggle its own feedback: latching off has to darken the road *now*, while
      the key is still down, or the only confirmation until release is the
      toast. */
  private hiBeamHold(now: number) {
    if (!this.hiHeld || this.hiConsumed || now - this.hiDownAt < HI_HOLD) return;
    this.hiConsumed = true;
    this.hiHeld = false;
    this.hiLatch = !this.hiLatch;
    this.ui.toast("HIGH BEAMS " + (this.hiLatch ? "ON" : "OFF"));
  }

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
        this.camMode = (this.camMode + 1) % CAM_COUNT;
        this.ui.toast(CAM_NAMES[this.camMode]);
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
    this.updatePbrDetail();
    this.timeSpeed = s.autoTime ? (this.timeSpeed === 0 ? 150 : this.timeSpeed) : 0;
    this.audio.setLevels(s.vol, this.running ? 1 : 0.12);
  }

  /** The scanned road detail layers — the extra albedo and normal fetches, but
      not the roughness map that carries the wet look — are the first thing to
      go when we are short of frame time. Driven off both the automatic perf
      drop and the "low" preset, so the two can't disagree.

      setPbrDetail recompiles the affected materials, so this is gated on an
      actual transition: applySettings() is hit on every slider tick. Toggling
      the detail rather than building without the scans keeps them resident and
      lets the setting come back if the preset is raised again. */
  private updatePbrDetail() {
    const want = !this.perfMode && this.settings.preset !== "low";
    if (want === this.pbrDetail) return;
    this.pbrDetail = want;
    this.mats.setPbrDetail(want);
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
    /* quiesce() zeroes the reverb send directly, so the cached value no longer
       describes the graph — drop it, or unpausing inside the tunnel would come
       back bone dry and stay that way until the blend happened to move. */
    this.lastReverb = -1;
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
      /* Back onto the corridor. It is one-way now, so there is no travel
         direction to preserve — the alignment supplies the lane centre, the
         deck height and the heading, all at the z we are already at. */
      const p = this.cor.respawn(car.z);
      car.x = p.x;
      car.y = p.y;
      car.z = p.z;
      car.h = p.h;
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

  /** Are the mains lit this frame? A held flash always wins; the latch only
   *  bites once the lights are actually on, the way a real stalk does — latch
   *  them in daylight and they simply arrive when dusk switches the lights in. */
  private get highBeam() {
    return this.hiHeld || (this.hiLatch && this.car.lightsOn);
  }

  /* ---------------- endless highway ---------------- */
  /** Splice the corridor back onto itself. The alignment is periodic in z —
      the deck at z = −HZ is identical to the deck at z = +HZ — so a lap is a
      pure translation: nothing rotates, nothing moves in x or y, and the car
      keeps its heading and its momentum. What matters is that every cached
      world-space z gets the same shift in the *same* frame; miss one of the
      camera's smoothing states and the view visibly lurches at the seam.

      The odometer is integrated from speed, not from position, so it carries
      straight across; `loops` is here for anything that wants true distance. */
  private loopSplice() {
    const car = this.car;
    // the corridor owns the condition, including the reverse case that
    // shouldWrap() doesn't cover — don't re-derive the thresholds here
    const dz = this.cor.spliceDelta(car.z);
    if (!dz) return;
    car.z += dz;
    this.loops += dz < 0 ? 1 : -1;
    this.chasePos.z += dz;
    this.lookPos.z += dz;
    this.camera.position.z += dz;
    this.rearCam.position.z += dz;
    /* Traffic needs no fix-up: its corridor cars track `s` in the canonical
       band and derive their world position from it, so the relative geometry
       across the seam is preserved for free.

       The rig is re-posed from car.* before it is drawn again, the sun is
       re-aimed at the car in weather(), and the rain field is player-relative,
       so none of those need touching. Smoke puffs are left behind by design —
       they are always astern and fade in under a second. */
  }

  /* ---------------- tunnel ---------------- */
  /** 0..1 "how enclosed are we". Read off the corridor's own tunnel fade, but
      only while we are actually on the deck: the alignment happily reports a
      station for a point in town at the tunnel's z, and reverberating the
      whole town would be badly wrong. */
  private tunnelAmount() {
    const car = this.car;
    if (this.cor.heightAt(car.x, car.z, 14) === null) return 0;
    return clamp(this.cor.tunnelBlend(this.cor.zAt(car.x, car.z)), 0, 1);
  }

  private tunnelUpdate(dt: number, now: number) {
    const t = this.tunnelAmount();
    // light smoothing so a bounce across the mouth can't strobe the exposure
    this.tunT = dt > 0 ? lerp(this.tunT, t, 1 - Math.exp(-9 * dt)) : t;
    /* setReverb schedules a pair of audio-param ramps, so it is only worth
       calling when the value has actually moved — out on the open road that is
       never, and this is the common case by a wide margin. */
    if (Math.abs(this.tunT - this.lastReverb) > 0.004) {
      this.lastReverb = this.tunT;
      this.audio.setReverb(this.tunT);
    }
    /* Entry / exit thump, off the *raw* blend rather than the smoothed one:
       the smoothing lags, and lags further the faster you are going, which
       would put the thump tens of metres inside the tunnel at speed. Raw, the
       mouth is always the mouth, at any speed.

       The dead band alone is not enough to keep that honest, though. The fade
       is 26 m and steep in the middle, so 0.25 and 0.55 are only about five
       metres apart on the road — a car sitting at the mouth being nudged
       around can cross both many times a second. Hence the refractory: a
       genuine transit puts the two mouths 300 m apart, and even backing out of
       one takes about a second, so nothing real is ever suppressed. */
    const wasIn = this.tunIn;
    if (!wasIn && t > 0.55) this.tunIn = true;
    else if (wasIn && t < 0.25) this.tunIn = false;
    this.tunThumpCd = Math.max(0, this.tunThumpCd - dt);
    if (this.tunIn !== wasIn && this.running && this.tunThumpCd <= 0) {
      this.tunThumpCd = 1.2;
      // entry and exit share a character; speed sets how hard it lands
      this.audio.tunnelThump(clamp(0.5 + Math.abs(this.car.u) / 62, 0.5, 1.6));
    }
    /* Headlight shimmer against the tunnel wall: two detuned sines beating
       against each other, a few percent deep. Enough to make the light feel
       like it is landing on something close, never enough to read as a fault.
       Runs after weather() has set this frame's base intensity. */
    if (this.tunT > 0.5 && this.car.lightsOn) {
      const amt = clamp((this.tunT - 0.5) / 0.25, 0, 1);
      const f =
        1 + amt * (0.055 * Math.sin(now * 23.3) * Math.sin(now * 7.1) + 0.02 * Math.sin(now * 41.7));
      this.rig.spotL.intensity *= f;
      this.rig.spotR.intensity *= f;
      this.rig.headMat.emissiveIntensity *= f;
    }
  }

  /** Cabin EQ follows the camera, not the car: only the cockpit view is
      actually inside the shell. The dashcam POV mount is geometrically inside
      it but deliberately stays dry — a dashcam's mic is pressed against the
      glass, so it hears the road and the wind, not a muffled cabin.
      Edge-triggered, since the call ramps filter
      parameters over a quarter second — re-issuing that every frame would
      keep restarting the ramp and it would never arrive. */
  private interiorUpdate() {
    if (this.camMode === this.lastInteriorMode) return;
    this.lastInteriorMode = this.camMode;
    this.audio.setInterior(this.camMode === CAM_COCKPIT);
  }

  /** Hand the audio side the traffic it should be able to hear, and turn
      traffic's close calls into horns and chirps. */
  private npcAudioFeed() {
    const car = this.car;
    /* The listener is the car, not the camera: doppler and pan want the thing
       that is actually moving through the traffic, and in chase view the
       camera trails it by a couple of metres with its own smoothing lag.
       car.wvx/wvz is the same world velocity physics integrates position with,
       so the doppler can never disagree with where the car actually went. */
    /* traffic hands back a fixed-length reused buffer whose tail entries are
       dead but still hold whatever coordinates they last held. Copy the live
       prefix into our own pooled view rather than passing it straight on: the
       audio pool treats every entry as a car, so a dead slot would sing away
       at a position nothing is standing in. */
    const samples = this.traffic.nearestNpcs(car.x, car.y, car.z, NPC_VOICES);
    const feed = this.npcFeed;
    feed.length = 0;
    for (const s of samples) {
      if (!s.npc || feed.length >= this.npcPool.length) continue;
      const e = this.npcPool[feed.length];
      e.x = s.x;
      e.z = s.z;
      e.vx = s.vx;
      e.vz = s.vz;
      e.heavy = s.heavy;
      feed.push(e);
    }
    this.audio.updateNpcs(feed, car.x, car.z, car.wvx, car.wvz, car.h);
    for (const n of this.traffic.closeCalls()) {
      if (n.ccKind === "chirp") this.audio.npcChirp(n.x, n.z);
      else this.audio.npcHorn(n.x, n.z);
    }
  }

  /** Street and deck lamps are built as one pooled sprite cloud plus one
      ground-quad batch. Both come out of the town builder as a generic warm
      white; retint them once, here, to low-pressure sodium — the orange is
      most of what says "road at night" in the reference, and a wider sprite
      with additive blending gives each head the halation a real lamp has in
      damp air instead of a flat dot. */
  private tintLampsSodium() {
    const g = this.world.glowPts?.material as THREE.PointsMaterial | undefined;
    if (g) {
      g.color.setHex(0xffa235);
      g.size = 9;
      g.blending = THREE.AdditiveBlending;
      g.needsUpdate = true;
    }
    const p = this.world.pools?.material as THREE.MeshBasicMaterial | undefined;
    if (p) p.color.setHex(0xff9c33);
  }

  /* Night fog sits almost on black. Anything lighter reads as a grey haze
     hanging in front of a black sky, which is the single loudest tell that a
     night scene is faked — the clear colour comes off this same value, so the
     horizon has to go with it. */
  private fogN = new THREE.Color(0x03040a);
  private fogD = new THREE.Color(0x9db6d8);
  private fogRN = new THREE.Color(0x171b26);
  private fogRD = new THREE.Color(0x6a7480);
  private sunN = new THREE.Color(0x8296d8);
  private sunD = new THREE.Color(0xffe8c8);
  private hemiN = new THREE.Color(0x0d1526);
  private hemiD = new THREE.Color(0x3948a8);
  private beamPos = new THREE.Vector3();
  private beamDir = new THREE.Vector3();
  private ambBase = new THREE.Color(0x222233);
  private ambTun = new THREE.Color(0x3a3128);
  private hemiGN = new THREE.Color(0x04040a);
  private hemiGD = new THREE.Color(0x0b0b14);

  private weather(dt: number, now: number) {
    const car = this.car, world = this.world, sky = this.sky;
    this.time = (this.time + (this.timeSpeed * dt) / 3600) % 24;
    const f = this.dayFactor();
    sky.skyMat.map = sky.skyCache[Math.round(f * 7)] as THREE.Texture;
    /* The night dome already grades from near-black overhead to a warm city
       glow at the horizon; deep night just needs it taken down so the zenith
       is genuinely black and the glow is a faint band rather than a lit
       backdrop. Recovers by early dusk, so nothing above f≈0.45 is touched. */
    sky.skyMat.color.setScalar(lerp(0.45, 1, Math.min(1, f * 2.2)));
    this.fogC.copy(this.rain ? this.fogRN : this.fogN).lerp(this.rain ? this.fogRD : this.fogD, f);
    (this.scene.fog as THREE.FogExp2).color.copy(this.fogC);
    this.renderer.setClearColor(this.fogC);
    (this.scene.fog as THREE.FogExp2).density =
      (lerp(0.0021, 0.001, f) + (this.rain ? 0.0015 : 0)) * fogMultiplier(this.settings.fog);
    /* Ambient is shaped, not lerped. A straight lerp on f leaves a floor of
       fill light at midnight that lights every surface the lamps never reach,
       and that even wash is what makes a night scene read as "day with a blue
       filter". The floors here are ~6x lower, so an unlit wall goes to a
       silhouette and its lit windows do all the work; the 0.7 power pulls the
       curve back up through dusk so twilight keeps roughly its old shape and
       full day lands on exactly the values it had before. */
    const lit = Math.pow(f, 0.7);
    this.hemi.intensity = 0.05 + lit * 0.87;
    this.amb.intensity = 0.07 + lit * 0.55;
    this.sun.intensity = 0.03 + lit * 1.26;
    this.hemi.color.copy(this.hemiN).lerp(this.hemiD, lit);
    this.hemi.groundColor.copy(this.hemiGN).lerp(this.hemiGD, lit);
    /* A tiled tunnel bounces its own battens around the tube, so the deck in
       there is *not* the black the open road now is. Put the fill back in
       proportion to the blend, warm, so crushing the night sky doesn't drag
       the tunnel floor down with it — this is the lighting half of the same
       adaptation the exposure lift in render() does. */
    if (this.tunT > 0.001) {
      this.amb.intensity += this.tunT * 0.3;
      this.hemi.intensity += this.tunT * 0.2;
      this.amb.color.copy(this.ambBase).lerp(this.ambTun, this.tunT);
    } else this.amb.color.copy(this.ambBase);
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
    /* The pools carry more of the road now that there is no ambient fill left
       to light it — they are the only thing between the lamp heads and a black
       deck. Wet tarmac spreads them further still. */
    if (world.pools)
      (world.pools.material as THREE.MeshBasicMaterial).opacity =
        0.5 * (1 - f) + (this.rain ? 0.16 : 0);
    for (const m of world.neonMats) (m as THREE.MeshBasicMaterial).opacity = 1 - f * 0.72;
    if (world.beaconPts)
      (world.beaconPts.material as THREE.PointsMaterial).opacity =
        0.35 + 0.6 * (Math.sin(now * 2.4) * 0.5 + 0.5);
    sky.towersMat.opacity = (now % 1.6 < 0.8 ? 1 : 0.25) * (1 - f * 0.7);
    if (world.rampPostMat) world.rampPostMat.opacity = 0.6 + 0.35 * (Math.sin(now * 4) * 0.5 + 0.5);
    car.lightsOn = car.lightsUser || f < 0.35 || this.rain;
    /* Flash-to-pass lights the lamps even with the headlights off — that is the
       entire point of it in daylight — but it deliberately leaves car.lightsOn
       alone, so the tail lights, the side-light tell-tale and anything else
       reading that flag stay honest about what is actually switched on. */
    const hi = this.highBeam;
    const lamps = car.lightsOn || hi;
    /* Modern three uses physical (candela) spot intensities. Low beam runs a
       shallow decay (~1.0, set below with angle/penumbra) so it spreads into
       an even carpet rather than a hot 2 m disc — that part of the spread
       retune was right. High beam CANNOT share that shallow decay, though:
       the NPC anti-blowout knee (traffic.ts) compresses anything above ~1.3
       units of pre-knee radiance towards the same ~4.0 ceiling regardless of
       how far past threshold it is, and ACES then maps that ceiling to near-
       white — so a decay shallow enough to keep the ground pool flat also
       keeps every car from here to the horizon pinned at the same saturated
       white, killing the near/far gradient that makes a flash read as a
       flash. High beam instead runs a steeper decay (1.5, near its old 1.4)
       so cars stop saturating past ~25-30 m even though its candela is much
       higher than low beam's — see the per-distance table in the retune
       commit message for the numbers this was solved against. */
    const si = lamps
      ? hi ? (this.rain ? 7000 : 5400) : (this.rain ? 908 : 700)
      : 0;
    this.rig.spotL.intensity = si;
    this.rig.spotR.intensity = si;
    /* Lateral fill cones. First cut of these pinned their upper edge ~29°
       ABOVE horizontal (a wide angle aimed only ~4° down), which reached
       cars broadside at every distance the cone's cutoff allowed — exactly
       the whiteout the main beam's edge-aimed cutoff was built to avoid, and
       nothing here inherited that protection. Fixed two ways at once: the
       aim is pitched hard enough now (see the loop below) that the cone's
       upper edge sits only a few degrees above horizontal instead of ~29°,
       and intensity is solved so a vertical mid-grey panel — a car's body,
       not the ground — never crosses the traffic-knee threshold (1.3) at
       3/5/10/20 m; see the verification table in the tame-the-spread-cones
       commit message. Ground coverage is real but deliberately more modest
       than the first cut — that's the trade for cars in the next lane no
       longer blowing out regardless of range. */
    const si2 = lamps
      ? hi ? (this.rain ? 3070 : 2370) : (this.rain ? 1840 : 1420)
      : 0;
    this.rig.spreadL.intensity = si2;
    this.rig.spreadR.intensity = si2;
    /* Halogen dipped beam is warm — around 3200 K — and reading it as warm is
       most of why the pool on the tarmac looks like light rather than like a
       grey texture that got brighter. Main beam runs whiter, the way a boosted
       filament (or the HID/LED it is imitating) actually does. */
    const beamC = hi ? 0xfff4e6 : 0xffeeda;
    this.rig.spotL.color.setHex(beamC);
    this.rig.spotR.color.setHex(beamC);
    this.rig.spreadL.color.setHex(beamC);
    this.rig.spreadR.color.setHex(beamC);
    /* Point the retroreflection beam (mats.setBeam) at the same place the
       lamps are pointing. Without this call every marking on the road stays
       at one flat brightness, which is precisely the look the crushed ambient
       is meant to kill: the paint has to be blazing inside the beam and gone
       just outside it. Origin is the lamp line, not the car centre, so the
       wedge starts at the nose; the dipped beam aims slightly down.

       `range` comes off the same two throw constants the spotlights use a few
       lines below, so main beam reaches the paint exactly as far as it reaches
       the road — hardcoding the ratio here is how the light pool and the
       retroreflection quietly drift out of agreement.

       BEAM_FLOOR is how bright paint sits at night outside the beam. Every
       material it reaches is unlit, so the ambient crush above never touches
       them: this is the only lever that dims night paint, and it is set here
       rather than in mats.ts because it is a night-look decision. */
    this.beamPos.set(
      car.x + Math.sin(car.h) * 2.05, car.y + 0.62, car.z + Math.cos(car.h) * 2.05);
    this.beamDir.set(Math.sin(car.h), hi ? -0.012 : -0.05, Math.cos(car.h));
    this.mats.setBeam(
      lamps, this.beamPos, this.beamDir, f, BEAM_FLOOR,
      hi ? HL_THROW_HI / HL_THROW : 1);
    /* Main beam is not simply brighter. The cone tightens and hardens, throws
       roughly 70% further, and — the part that actually reads as "high beam"
       down a dark road, and why oncoming traffic hates it — the cut-off comes
       up from below horizontal to above it. x on the targets is left alone:
       the two lamps toe out from each other and that spread is per-side.

       What matters for a dipped beam is not where the cone points but where
       its UPPER EDGE sits, because that edge is the cut-off: everything above
       it is dark. A real low beam is aimed about 1% below horizontal, so the
       tallest thing it can light at distance d is (lamp height − d/100) and
       the lit band on a car ahead SHRINKS as you close on it, topping out
       around plate height. Aim the cone by its edge and that falls out for
       free; aim it by its axis, as this did, and the edge ends up pointing
       skyward and washes whole vehicles.

       Pitch is therefore derived from the cone's own half-angle and the lamp's
       own mount height, per car, rather than from a fixed target height — the
       four shells mount their lamps between 0.50 m and 0.62 m and a hardcoded
       y would mean a different cut-off in each of them. */
    for (const sp of [this.rig.spotL, this.rig.spotR]) {
      sp.distance = hi ? HL_THROW_HI : HL_THROW;
      /* The cut-off constraint pins the axis pitch to the half-angle, so a
         wide cone is forced to point steeply down and its hot spot lands on
         the bumper. These angles put the hot spot ~1.6 m ahead on dipped and
         ~2.7 m on main, closer than earlier tunes — deliberately: with decay
         (see the SpotLight ctor in player.ts) dropped well below the inverse-
         square norm, the pool no longer depends on a bright near hotspot to
         read as "on", so the axis is allowed to sit closer while penumbra
         (below) feathers the disc into a spread instead of a hard-edged
         pool. */
      sp.angle = hi ? 0.23 : 0.33;
      sp.penumbra = hi ? 0.4 : 0.6;
      // decay is per-mode, not a fixed ctor value (see player.ts) — low
      // stays shallow for the carpet, high goes steeper so distant cars
      // fall back out of the knee's ceiling instead of staying pinned white
      sp.decay = hi ? 1.5 : 1.0;
      sp.target.position.z = hi ? 46 : 26;
      const pitch = hi
        ? sp.angle - Math.atan(HI_RISE)
        : sp.angle + Math.atan(LOW_DIP);
      sp.target.position.y =
        sp.position.y - (sp.target.position.z - sp.position.z) * Math.tan(pitch);
    }
    /* Spread cones aim outward from each lamp toward its own side, wide and
       short. Unlike the main beam this IS edge-pinned now too, for the same
       reason: pitch is set from the cone's own half-angle so the upper edge
       lands a controlled few degrees above horizontal (0.5-0.53 rad cones
       can't get fully below horizontal from a bumper-height mount without
       losing all reach — see the commit message's trig) instead of the ~29°
       the unpinned first cut left it at. horizDist is the 3-D distance to
       the aim point, not just forward distance, because the lateral kick is
       large enough here (unlike the main beam's) to matter for the pitch a
       symmetric cone needs to keep its topmost ray fixed. */
    for (const [sp, side] of [[this.rig.spreadL, -1], [this.rig.spreadR, 1]] as const) {
      sp.distance = hi ? HL_SPREAD_THROW_HI : HL_SPREAD_THROW;
      sp.angle = hi ? 0.53 : 0.5;
      sp.penumbra = 0.5;
      sp.decay = hi ? 1.3 : 1.2;
      const kick = hi ? 4.0 : 3.0, tz = hi ? 22 : 14;
      const spitch = hi ? HL_SPREAD_PITCH_HI : HL_SPREAD_PITCH;
      const horizDist = Math.hypot(kick, tz);
      sp.target.position.set(
        side * kick, sp.position.y - horizDist * Math.tan(spitch), tz);
    }
    this.rig.headMat.emissiveIntensity = hi ? 4.2 : car.lightsOn ? 2.4 : 0.12;
    // the glow sprite keeps most of its punch in daylight when flashing, or a
    // daytime flash-to-pass would be invisible against a bright sky
    this.rig.hlGlowMat.opacity = hi
      ? Math.max(0.6, 1 - f * 0.45)
      : car.lightsOn ? 0.8 * (1 - f * 0.85) : 0;
    this.rig.plateGlowMat.opacity = car.lightsOn ? 0.3 * (1 - f * 0.85) : 0;
    this.rainFX.update(dt, car.x, car.y, car.z, car.wvx, car.wvz);
  }

  /** Sustained body-on-barrier contact, fed to the audio scrape bed every
      frame. Distinct from `crash()`, which stays exactly as it was and keeps
      firing on the delta-v spikes above its threshold: a scrape is what
      happens for as long as you stay leaned on the wall after that bang.

      `push` is the frame's depenetration vector — see the call site — so its
      direction is the contact normal and its length is how far into the
      barrier the car had got. Both parapets and NPC flanks produce one, which
      is why this needs no separate NPC path; npcHits would miss a steady rub
      alongside a car anyway, since it only records closing contacts.

      Feeding the tangential speed honestly is the whole point of the split:
      parked hard against a barrier at full lock is *contact*, sometimes deep
      contact, but nothing is sliding over anything, and it has to stay silent.
      Only the component of travel along the surface can make a noise. */
  private scrapeAmt = 0;
  private scrapeUpdate(dt: number, hit: boolean, pushX: number, pushZ: number) {
    const car = this.car;
    let target = 0, tanSpeed = 0;
    if (hit) {
      const pm = Math.hypot(pushX, pushZ);
      if (pm > 1e-6) {
        const nx = pushX / pm, nz = pushZ / pm;
        // strip the into-the-wall component; what is left runs along the face
        const vn = car.wvx * nx + car.wvz * nz;
        tanSpeed = Math.hypot(car.wvx - nx * vn, car.wvz - nz * vn);
      } else {
        /* Touching with no measurable penetration — a graze that arrived
           exactly parallel. There is no normal to project against, and the
           velocity is by definition almost all tangential, so use it whole
           rather than dropping a real scrape on the floor. */
        tanSpeed = Math.hypot(car.wvx, car.wvz);
      }
      /* How hard the car is leaning in, as the speed at which it is burying
         itself. In steady state that decays towards zero even while pressed —
         the wall wins — hence the floor: any contact at all is worth a sound,
         and it is the tangential speed, not this, that decides silence. */
      const press = clamp(pm / Math.max(dt, 1e-3) / 2, 0, 1);
      target = 0.35 + 0.65 * press;
    }
    /* Asymmetric smoothing: a scrape starts the instant metal touches, but
       must not chatter off and on across frames where the depenetration
       happens to land on zero. Leaving the barrier is quick but not
       instant — that tail is the sound dying, not the contact persisting. */
    const k = target > this.scrapeAmt ? 40 : 14;
    this.scrapeAmt = lerp(this.scrapeAmt, target, 1 - Math.exp(-k * Math.max(dt, 1e-4)));
    if (this.scrapeAmt < 0.01) this.scrapeAmt = 0;
    // speed is what the audio side gates on, so a contact that has stopped
    // sliding must report zero rather than a small residue
    this.audio.setScrape(this.scrapeAmt, this.scrapeAmt > 0 ? tanSpeed : 0);
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
    /* The POV mount sits inside the cabin, so it needs the interior shell — the
       cluster, dash pad, mirror and A-pillars are all in its frame. It must NOT
       have the exterior body either, whose front faces all point away from a
       camera sitting inside it, leaving the roof and flanks invisible and the
       far bodywork showing through. */
    const inside = this.camMode === CAM_COCKPIT || this.camMode === CAM_POV;
    rig.cockpit.group.visible = inside;
    rig.exteriorG.visible = !inside;
    // the cockpit now has its own nav screen (drawScreen above), so the
    // external HUD minimap is redundant in that view — hide it. POV keeps the
    // HUD: the head unit is a long way down-frame there, and the map is the
    // one thing the player still needs to navigate with.
    if (this.mmap) {
      const mmapCv = document.getElementById("mmap");
      if (mmapCv) mmapCv.style.display = this.camMode === CAM_COCKPIT ? "none" : "block";
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
    // POV needs these as much as the cockpit does: the dial faces sit across
    // the bottom third of its frame, where a frozen cluster is unmissable
    if (this.gaugeT > 0.045 && inside) {
      this.gaugeT = 0;
      /* `highBeam` is fed forward for the blue main-beam tell-tale. GaugeFlags
         does not declare it yet, so it is widened here rather than in
         cockpit.ts — the value is live from today, and the cluster lights up
         the moment its owner adds the field and draws the lamp. */
      const flags: GaugeFlags & { highBeam?: boolean } = {
        lightsOn: car.lightsOn, sigL: car.sigL, sigR: car.sigR, rain: this.rain,
        tcOn: car.tcOn, odo: car.odo, revLimit: this.spec.phys.revLimit,
        units: this.settings.units, onLimiter: car.onLimiter,
        highBeam: this.highBeam,
      };
      rig.cockpit.drawGauges(
        car.rpm, Math.abs(car.u) * 3.6, car.rev ? "R" : "D" + car.gear, now, flags
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
    } else if (this.camMode === CAM_POV) {
      /* Hard-mounted dashcam. No head springs, no lookahead, no lean, no
         look-back: it is a bracket over the dash, so the only motion it has is
         the body's own. Entering the mode also parks the cockpit head state at
         neutral, so stepping back into the cockpit view starts from centre
         instead of resuming a stale spring and dipping. */
      if (this.lastCamMode !== CAM_POV) {
        this.head.x = this.head.y = this.head.z = this.head.roll = 0;
        this.head.vx = this.head.vy = this.head.vz = this.head.vroll = 0;
        this.lookaheadYaw = 0;
        this.lbLean = 0;
      }
      const P = this.spec.shell;
      this.camera.position.copy(
        this.rig.bodyG.localToWorld(
          this.tmpV.set(
            // scaled with the shell like the cockpit eye is, so the lens keeps
            // its position relative to the binnacle on a narrower or wider car
            POV_MOUNT.dx * (P.W / COCKPIT_REF.W),
            P.belt - COCKPIT_REF.belt + COCKPIT_EYE.y + POV_MOUNT.dy,
            COCKPIT_EYE.z + POV_MOUNT.dz
          )
        )
      );
      this.camera.rotation.y = car.h + Math.PI;
      // same sign flip as the cockpit (body pitch is nose-up-negative, camera
      // pitch is look-up-positive), plus the fixed downward cant of the bracket
      this.camera.rotation.x = -this.rig.bodyG.rotation.x - POV_TILT;
      this.camera.rotation.z = -this.rig.bodyG.rotation.z;
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
    const kickM = this.camMode === CAM_CHASE ? 0.18 : this.camMode === CAM_HOOD ? 0.6 : 1;
    /* The dashcam runs a fixed lens: no speed FOV kick (a bracket-mounted
       camera has no zoom, and the kick is a driver-sensation cue, not an
       optical one) and no user FOV preference either. 105 deg horizontal at
       16:9 works out at ~72.5 vertical / ~112 diagonal. */
    const fovT =
      this.camMode === CAM_POV
        ? clamp(
          (2 * Math.atan(Math.tan((POV_HFOV * Math.PI) / 360) / this.camera.aspect) * 180) /
          Math.PI,
          62, 100
        )
        : this.settings.fovBase + clamp(Math.abs(car.u) * 0.21, 0, 19) * kickM;
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
    // mirror plane at the current road height — the deck itself rises and
    // falls by several metres, so the clamp has to allow for the high points
    const h = clamp(this.car.y, 0, DECKY + 6);
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
        this.updatePbrDetail();
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
    // before weather(), which is where the lamps are actually set from the
    // resulting beam state; runs while paused too, so a hold can't stall there
    this.hiBeamHold(now);
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
      /* Splice before anything else reads the car this frame — collision,
         traffic and the camera must all agree on which side of the seam we
         are on, or one of them spends a frame 4 km away. */
      this.loopSplice();
      /* Snapshot the position across the collision call only. Whatever moves
         between these two reads is depenetration — collidePlayer's only
         positional write — and it is pushed straight along the contact normal,
         which is the one thing the return value does not carry. The velocity
         delta cannot stand in for it: collide also scales the whole velocity
         by 0.965 on any hit, so at speed that term swamps the normal impulse
         and points backwards along travel instead of out of the wall. */
      const preCX = this.car.x, preCZ = this.car.z;
      const res = collidePlayer(this.car, this.world, this.traffic.npcs, this.rig.halfW, this.rig.halfL);
      this.scrapeUpdate(dt, res.hit, this.car.x - preCX, this.car.z - preCZ);
      for (const hitInfo of res.npcHits) {
        this.traffic.applyImpact(hitInfo);
        if (hitInfo.relSpeed > 2.5 && this.crashCooldown <= 0) {
          this.crashCooldown = 0.4;
          this.audio.crash(hitInfo.relSpeed);
          this.car.damage += hitInfo.relSpeed * 0.5;
          // dashcam impact glitch: gated on POV here (not inside dashcamHit)
          // so a hit taken in another camera doesn't arm a burst that fires
          // the moment the player later switches into POV
          if (this.camMode === CAM_POV) this.post.dashcamHit(hitInfo.relSpeed);
        }
      }
      if (res.wallImpact > 4 && this.crashCooldown <= 0) {
        this.crashCooldown = 0.4;
        this.audio.crash(res.wallImpact);
        if (this.camMode === CAM_POV) this.post.dashcamHit(res.wallImpact);
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
      this.interiorUpdate();
      this.tunnelUpdate(dt, now);
      this.audio.update(
        this.car.rpm, this.car.thrEff, this.car.slipAmt, Math.abs(this.car.u), now,
        this.car.cut > 0 || this.car.shiftT > 0.1, this.rain, this.input.horn > 0,
        this.car.gear, this.car.onLimiter, this.car.slipDemand
      );
      this.npcAudioFeed();
      this.hud(now, dt);
      this.chunkT += dt;
      if (this.chunkT > 0.16) {
        this.chunkT = 0;
        this.chunksUpdate();
      }
      const mmapCv = document.getElementById("mmap") as HTMLCanvasElement | null;
      if (this.mmap && mmapCv && this.camMode !== CAM_COCKPIT && this.frameN % 4 === 0)
        drawMiniMap(mmapCv, this.world, this.car, this.traffic.npcs, now);
    } else {
      this.acc = 0;
      // paused: no collision runs, so nothing would ever clear a scrape that
      // was sounding at the moment the pause landed
      this.scrapeUpdate(dt, false, 0, 0);
      this.updateCarVisual(now, dt);
      this.updateCamera(dt);
      this.weather(0, now);
      // keep the tunnel look correct while paused; the thump stays gated on
      // `running` so unpausing inside a tunnel can't fire one
      this.interiorUpdate();
      this.tunnelUpdate(0, now);
    }
    this.frameN++;
    // POV sits behind the mirror housing too, and the glass hangs in the top
    // ~15% of its frame, so it needs the rear view rendered as well
    if (
      this.mirror && this.frameN % 2 === 0 &&
      (this.camMode === CAM_COCKPIT || this.camMode === CAM_POV)
    )
      this.renderMirror();
    if (this.settings.reflections && (!this.perfMode || this.frameN % 2 === 0))
      this.renderReflection();
    this.camera.updateMatrixWorld();
    this.renderer.setRenderTarget(this.post.sceneRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const f = this.dayFactor();
    this.post.setSpeed(Math.abs(this.car.u) * 3.6);
    // the extreme degrade is a property of the camera, not a user filter — the
    // V-key `grade` below stays independent and keeps driving the mild look
    this.post.setDashcamPov(this.camMode === CAM_POV);
    this.post.process({
      // inside the tunnel the eye adapts to a much darker box: lift exposure
      // so the sodium strip and the walls read, instead of crushing to black
      // the night end is biased down so the crushed ambient survives the tone
      // map: lifting it back here would simply undo the darkness. Only the
      // lamps and lit windows are above the bloom knee once it is this low.
      exposure: lerp(lerp(0.98, 0.9, f), 1.34, this.tunT),
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
