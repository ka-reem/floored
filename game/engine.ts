import * as THREE from "three";
import { clamp, lerp, mulberry32, type Rng } from "./util";
import {
  runStages, withBudget, type LoadReport, type LoadStage,
} from "./loading";
import {
  fogMultiplier, speedInUnits, unitLabel, resolveRenderTier, TIER_CAPS,
  type GameSettings, type Profile, type RenderTier, type TierCaps,
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
import { getCorridor, TUNNEL, PITCH, PHASE } from "./world/corridor";
import { getRouteGraph, BYPASS_EDGE } from "./world/routegraph";
import { spawnZ } from "./world/ramps";
import { stepPhysics, freshCarState, type CarState, type DriverInput } from "./physics";
import { collidePlayer } from "./collide";
import { buildPlayerCar, type PlayerRig } from "./player";
import { COCKPIT_REF, EYE as COCKPIT_EYE, GLASS_REST, type GaugeFlags } from "./cockpit";
import { Traffic } from "./traffic";
import { GameAudio } from "./audio";
import { MusicPlayer } from "./music";
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

/** Sodium for the cabin wash — the colour the interior trim goes as a lamp
    head passes overhead. Deliberately NOT the lamps' own 0xffa235: that hex
    was picked for additive glow points over near-black, and as a diffuse light
    on PBR trim it comes through the composite's ACES curve at hue ~40 with the
    saturation already falling off, i.e. pale yellow-white. Same lesson as the
    lamp cones in highway.ts — the grade walks a warm source up the hue wheel
    and desaturates it as it brightens, so the source has to start deeper and
    more saturated than the colour you want to end up with. This one lands
    around hue 15-25 at cabin levels and holds sat > 0.9 even through the
    dashcam POV's own desaturation. */
const LAMP_SODIUM = new THREE.Color(0xff7a10);

/** The cabin lamp wash falls off on two independent axes, each expressed as a
    hand-tunable table of "pressure points" — [distance in METRES, strength] —
    rather than a formula, so the stops can be read off and nudged one at a
    time. Distances are absolute metres from the lamp head, and both tables
    must end at strength 0 so the wash has somewhere to land.

    Why tables and not a curve: the physical law here is illuminance from a
    point source onto a roughly horizontal surface, E is proportional to
    h/r^3 with the head 7.45 m up and the cabin trim ~1.1 m, i.e. an effective
    h of about 6.4 m. That gives 1.00 / 0.74 / 0.41 / 0.20 at 0 / 3 / 5.8 /
    9 m of lateral offset. The near stops track that; the outer ones bend
    BELOW it, because inverse-cube alone never reaches zero (it is still at
    ~0.10 twelve metres out) and the cabin's own roof shadows the trim once
    the light is arriving that obliquely. The last third is a long shallow
    creep rather than a straight line to zero, so the POV black crush gets a
    fade to eat instead of a hard radius. */
const WASH_LAT: [number, number][] = [
  [0, 1],      // directly beneath the head
  [1.5, 0.92], // still inside the lamp's own lane (its centre is 2.1 m out)
  [3, 0.72],   // straddling the line out of the lamp's lane (edge at 3.9 m)
  [6, 0.38],   // centre lane, 5.8 m from a parapet head: clearly weaker
  [9, 0.14],   // the far lane, 9.5 m out: barely a tint
  [12, 0],     // far shoulder, lamp on the opposite parapet: nothing
];
/** Longitudinal falloff, same units. Deliberately about twice as long-tailed
    as the lateral table: a cobra head is a directional fixture that throws
    down the road, not across it, and the windscreen is an aperture facing
    that way, so light arrives well before the car is under the head and
    lingers after. The old cut had no lateral term at all and a flat top out
    to +/-4 m, which is why a lamp read the same from the far lane as from
    directly under it. Ends at 25 m = half of PITCH.light, so the wash is
    exactly zero at the midpoint between two lamps and never steps. */
const WASH_LONG: [number, number][] = [
  [0, 1],
  [3, 0.9],
  [7, 0.58],
  [12, 0.24],
  [18, 0.06],
  [25, 0],
];
/** Sample a pressure-point table, linearly between stops, clamped at both
    ends. Linear is intentional: the stops carry the shape, so interpolation
    should not invent any of its own. */
function washStops(table: [number, number][], d: number): number {
  if (d <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [d1, v1] = table[i];
    if (d <= d1) {
      const [d0, v0] = table[i - 1];
      return lerp(v0, v1, (d - d0) / (d1 - d0));
    }
  }
  return table[table.length - 1][1];
}

/** Headlight throw, metres: dipped and main. This is the beam's INTENDED
    reach — how far down the road the retroreflective paint answers, as a ratio
    against HL_PAINT_BASE below. It is deliberately no longer the spotlight's
    `distance`; see HL_CLIP. */
const HL_THROW = 130, HL_THROW_HI = 200;

/** Where the spotlight's own falloff window is allowed to close, metres.
    `SpotLight.distance` is NOT a reach setting: three multiplies the 1/r^decay
    term by pow2(saturate(1 - (d/distance)^4)), which is ~1 until about 0.6 of
    the way out and then dives to exactly zero at `distance`. Setting it equal
    to the intended throw therefore prints the last third of the throw as a
    darkening band ending in a terminator line across the road — and the dipped
    beam is the worst case, because its decay is only 1.0 (see below), so it is
    still strong when the window starts closing.

    So the window is pushed out past anything the eye can find. The dipped
    cone's upper edge sits ~1% below horizontal off a ~0.6 m lamp, so it stops
    touching tarmac around 60 m; at 190 the window is still 0.98 there and the
    ground pool is pure 1/r all the way out. Main beam is aimed a hair up and
    runs decay 1.5, so at 290 it has 5400/250^1.5 ~= 1.4 units left at 250 m
    against a ~4.0 knee ceiling — dim, small on screen, and fading on its own
    curve rather than on the clip's. Do not pull these back to HL_THROW to
    "shorten the beam": shorten the beam with intensity or angle, because this
    knob can only make it stop. */
const HL_CLIP = 190, HL_CLIP_HI = 290;

/** The throw the per-material retro near/far bands (mats addBeam 18/62 etc.)
    were originally tuned against. setBeam's range multiplier is derived
    against this base, so extending a throw above stretches the paint response
    by the same proportion instead of leaving it behind. */
const HL_PAINT_BASE = 115;

/** Lateral fill-cone throw, metres — shorter than the main beam's on
    purpose: this cone's job is lighting the adjacent lane close in, not
    reaching down the road, and a longer cutoff would just mean more of it
    sits inside the anti-blowout knee's compressed zone for no visual gain. */
const HL_SPREAD_THROW = 36, HL_SPREAD_THROW_HI = 48;

/** Lateral fill-cone pitch, radians below horizontal, edge-pinned the same
    way as the main beam (see the loop below): this is the AXIS angle, not
    the cutoff, and a wide cone has to point down by nearly its own half-angle
    before the upper edge clears horizontal.

    Dipped drops 27.1 deg -> 7.61 deg, which is NOT a relaxation of the edge
    pin — it is the same pin applied to a much narrower cone. The upper edge
    is what the pin protects and it stays exactly where it was, 2.70 deg above
    horizontal (7.61 - deg(0.18) = 27.1 - deg(0.52)), so the glare envelope
    against oncoming traffic is unchanged to two decimals. What changes is
    where the axis lands: pitching 27 deg down off a 0.44 m mount crossed the
    road 0.86 m from the lamp, which is why these cones — not the main beam —
    were the brightest thing in the whole night scene. Shallow-and-narrow puts
    the crossing ~2.3 m out instead, and the lateral coverage comes from
    yawing the cone outward (`kick`) rather than from opening its angle. High
    beam keeps 29.1 deg with its own wide cone, untouched. */
const HL_SPREAD_PITCH = (11.05 * Math.PI) / 180, HL_SPREAD_PITCH_HI = (29.1 * Math.PI) / 180;

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
   In cockpit-local terms x 0.28, y 1.20, z 0.31 — 0.61 m forward of the eye and
   15 cm below it. dx is scaled with the shell width for the same reason the eye
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
/* Mount height when an IMPORTED dash is in, 12 cm below the procedural one.
   The two dashes want different lens heights and neither value works for both:
   the procedural pad is shallow, and dy -0.03 is what clears it (all the
   framing notes above were fitted at that height). A donor dash has real
   depth, so from the same mount the lens looks down onto it from too far above
   and reads as a camera on a pole rather than one stuck to the glass. -0.15
   puts it ~13 cm over the Volvo pad top (y 1.07), about where a real
   windscreen unit sits. Tied to which dash is actually visible rather than
   picked globally, so the J toggle stays an honest A/B. */
const POV_MOUNT_DY_IMPORTED = -0.15;
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
  dashImported = true; // J toggles; only meaningful once a donor dash has loaded

  /** Lens height for the dash currently on screen. Reads live rather than
      being cached, so the J toggle moves the camera in the same frame it
      swaps the dash — otherwise the A/B compares two dashes at one height and
      whichever one it does not suit loses unfairly. */
  private povMountDy(): number {
    return this.rig.cockpitModel && this.dashImported ? POV_MOUNT_DY_IMPORTED : POV_MOUNT.dy;
  }
  mirror = true;
  mmap = true;
  time = 21.4;
  timeSpeed = 150;
  perfMode = false;
  /** Device tier (settings.ts): what the hardware *is*, resolved from touch +
      DPR + GPU sniff, a persisted override, or a `?tier=` test param. Sets the
      quality ceiling the levers below start from. perfMode stays the reactive
      safety net ON TOP of this — it watches what frame times *do* and can
      still degrade any tier further; nothing here disables it. */
  renderTier: RenderTier = "desktop";
  /** the tier's caps on existing levers — public so the UI can show the
      resolved tier and so other lanes (fence overdraw) can gate on it */
  tierCaps: TierCaps = TIER_CAPS.desktop;
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
  /** A flash gesture happened this frame — a one-frame pulse handed to
      traffic.update(), which reacts to the *gesture* (one press, one flash)
      rather than to whether the beams are currently lit. Set on the press
      edge so the reaction is immediate; a press that turns out to be a latch
      hold has still, correctly, put the mains in the car ahead's mirrors once. */
  private hiFlashPulse = false;

  private ui: UiBridge;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rearCam: THREE.PerspectiveCamera;
  private refCam = new THREE.PerspectiveCamera();
  /* The world half of the engine. All of it is built by load(), not by the
     constructor, so every one of these is undefined until `loaded` is true —
     which is why the handful of methods the menus can reach before Drive
     (applySettings, setCar, setRain) have to guard. */
  private mats!: Mats;
  private sky!: Sky;
  private world!: WorldData;
  private terrain!: Terrain;
  private post: PostFX;
  private traffic!: Traffic;
  private audio = new GameAudio();
  /** In-dash classical player (game/music.ts). Public because the dash screen
      reads its state to draw the panel. Desktop only — `music.enabled` is
      false on touch and every call is then a no-op. */
  music = new MusicPlayer();
  private rainFX!: RainFX;
  private smokeFX!: SmokeFX;
  private rig!: PlayerRig;
  car!: CarState;
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
    // resolved against the renderer's own GL context so the GPU sniff never
    // has to spin up a throwaway canvas context of its own
    this.renderTier = resolveRenderTier(this.settings, this.isTouch, this.renderer.getContext());
    this.tierCaps = TIER_CAPS[this.renderTier];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.tierCaps.dprCap));
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
    // mobile tiers run the cockpit mirror at half resolution; the reflection
    // RT allocation follows in applySettings' makeTargets pass below
    this.post.setMobile(this.tierCaps.mirrorHalf);
    // desktop-only cinematic extras: two-scale bloom + film-look finishers
    this.post.setCinema(!!this.tierCaps.dualBloom, !!this.tierCaps.filmLook);
    /* Everything above is what the MENUS need: a canvas, a resolved tier, and
       the settings the panels read. The world itself — materials, terrain,
       expressway, town, traffic, the player rig — is NOT built here; it is
       built by load() below, in yielding stages, behind the loading screen.
       See the note on load() for why. */

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
      /* Drop the car onto the bypass viaduct at arclength s, in lane, at
         speed. s=60 is just past the diverge wedge; ~560 is the elevated run
         with the city view. */
      toBypass: (s = 60, kmh = 110, lane = 0) => {
        const by = this.world.routes!.bypass;
        const ss = Math.max(4, Math.min(by.len - 4, s));
        const p = by.worldOf(ss, by.laneOffset(lane, ss));
        const h = by.poseAt(ss).h;
        this.car.x = p.x;
        this.car.y = p.y;
        this.car.z = p.z;
        this.car.h = h;
        this.car.u = kmh / 3.6;
        this.car.v = 0;
        this.car.r = 0;
        this.car.rev = false;
        this.car.wvx = 0;
        this.car.wvz = 0;
        this.chasePos.set(p.x - Math.sin(h) * 4.4, p.y + 2.15, p.z - Math.cos(h) * 4.4);
        this.lookPos.set(p.x, p.y + 0.95, p.z);
      },
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
        npcsBypass: this.traffic.npcs.filter((n) => n.active && n.route === BYPASS_EDGE).length,
        onBypass: !!this.world.routes?.surfaceAt(this.car.x, this.car.z, 2),
        wrecks: this.traffic.activeWrecks().length,
        chunksVisible: this.world.chunks.filter((c) => c.group.visible).length,
        chunksTotal: this.world.chunks.length,
        perfMode: this.perfMode,
        renderTier: this.renderTier,
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

  /* ---------------- staged load ---------------- */

  /** Relative cost of each load stage, used to weight the progress bar.

      These are estimates of where the time goes on a mid-range phone, not
      measurements, and they only have to be right relative to each other — the
      bar's job is to not stall at 80%. runStages() records real per-stage
      milliseconds and the load hangs them off `__neonx.loadTimings`, so
      retuning these against an actual device is a console read, not a
      guessing game.

      The shape they encode: the two big procedural mesh builds (4.7 km of
      expressway at a station every 4 m, then the town) dominate everything
      else put together; the canvas textures are a distant third; the fetches
      (bodyshells, donor dash) are network-bound and therefore wildly variable,
      so they are weighted at what a warm cache costs rather than a cold one. */
  private static readonly LOAD_WEIGHTS = {
    mats: 12,
    land: 6,
    highway: 26,
    town: 22,
    traffic: 8,
    car: 8,
    shaders: 12,
    warm: 6,
  };

  /** How long the load waits on the traffic bodyshells and on the donor dash
      before walking on without them (see withBudget). The dash gets the longer
      budget because it is a single 17 MB file and because the dashcam POV is
      the view the game is played in — having it swap in under the player a
      second into the drive is the one pop worth paying for up front. */
  private static readonly FLEET_BUDGET_MS = 5000;
  private static readonly DASH_BUDGET_MS = 8000;
  /** Budget on the shader pre-warm. Not a performance knob — compileAsync
      polls program.isReady() on a 10 ms timer, and a GL context lost mid-load
      is a poll that can never come back true. Without this the player sits on
      "COMPILING SHADERS" forever; with it the load finishes and they at least
      get the game's own context-loss behaviour. */
  private static readonly COMPILE_BUDGET_MS = 15000;

  /** True once load() has finished; until then the world does not exist and
      the menus are the only thing that works. */
  loaded = false;

  /** The world build, as a list of stages the loader can yield between.

      The order here is the order the old constructor ran in and must stay
      that way: `rng` is a seeded stream threaded through terrain → road net →
      highway → town, so moving any consumer changes what every later one
      draws for a given seed. */
  private buildStages(): LoadStage[] {
    const W = Game.LOAD_WEIGHTS;
    let rng: Rng;
    let net: ReturnType<typeof buildRoadNet>;
    let deckLightPts: ReturnType<typeof buildHighway>["deckLightPts"];
    return [
      {
        label: "MIXING PAINT",
        weight: W.mats,
        run: () => {
          /* On the low preset the photo scans are not fetched at all — some
             60 MB of texture memory and a 5 MB download, on exactly the device
             that asked for less. The load is deferred rather than cancelled,
             so updatePbrDetail() turning detail back on when the preset is
             raised is also what starts it, and the world upgrades in place.
             The mobile-base tier defers the fetch the same way — a manual tier
             bump later still upgrades in place. */
          this.mats = buildMats({
            pbr: this.settings.preset !== "low" && this.tierCaps.pbrDetail,
          });
          // async: swaps a real night-city HDRI under the car bodywork when one
          // is on disk, otherwise the painted cube env above stays
          primeCarEnv(this.renderer, this.mats.envMap);
          this.mats.setReflectionTexture(this.post.reflectRT.texture);
          this.mats.setReflectionScreen(
            innerWidth * this.renderer.getPixelRatio(),
            innerHeight * this.renderer.getPixelRatio()
          );
          this.sky = buildSky(this.scene, this.mats.glowTex);
        },
      },
      {
        label: "SHAPING THE LAND",
        weight: W.land,
        run: () => {
          rng = mulberry32(this.seed);
          this.terrain = makeTerrain(rng);
          net = buildRoadNet(rng, this.terrain);
          /* the route graph: the corridor grown into a small closed graph
             (bypass viaduct + town loop). Deterministic like the corridor;
             assertClosed() sits here next to the world build the same way
             assertPitches() guards the furniture lattices. */
          const routes = getRouteGraph();
          routes.assertClosed();
          this.world = {
            colliders: new ColliderIndex(),
            net,
            terrain: this.terrain,
            routes,
            exits: [],
            chunks: [],
            neonMats: [],
          };
          const ground = buildGround(this.terrain, this.mats.ground);
          ground.layers.set(LAYER_NOREF);
          this.scene.add(ground);
        },
      },
      {
        label: "RAISING THE EXPRESSWAY",
        weight: W.highway,
        run: () => {
          deckLightPts = buildHighway(
            this.scene, this.mats, this.world, this.terrain, rng
          ).deckLightPts;
        },
      },
      {
        label: "BUILDING THE TOWN",
        weight: W.town,
        run: () => {
          buildTown(this.scene, this.mats, this.world, this.terrain, rng, deckLightPts);
          this.tintLampsSodium();
        },
      },
      {
        label: "PUTTING CARS ON THE ROAD",
        weight: W.traffic,
        run: async () => {
          this.traffic = new Traffic(
            this.scene, this.world, this.mats.envMap, this.mats.glowTex, 120
          );
          this.rainFX = new RainFX(this.scene, this.mats.streakTex);
          this.smokeFX = new SmokeFX(this.scene, this.mats.smokeTex);
          // wait for the bodyshells: a style with no model is barred from
          // spawning, so driving off before they land means an empty road that
          // fills itself in over the first few seconds
          await withBudget(this.traffic.fleetLoaded, Game.FLEET_BUDGET_MS);
        },
      },
      {
        label: "WARMING THE ENGINE",
        weight: W.car,
        run: async () => {
          /* Spawn on the corridor rather than at a fixed offset: the centreline
             wanders by up to 62 m and the deck rises and falls by 5, so a
             hardcoded (HX, DECKY) start would drop the car beside or under the
             road.

             spawnZ() is the centre of the town-side window: the stretch beside
             the town that is straight, level, clear of both ramps' parapet gaps
             (the z range where the deck's barrier is cut away for a ramp to peel
             off), out of the tunnel and off the toll plaza. It is derived from
             the ramp layout rather than written down here on purpose — this used
             to be a literal, and when the gores moved it silently ended up
             inside a gap, spawning the player next to a hole in the wall. */
          const spawn = this.cor.respawn(spawnZ(), 1);
          this.car = freshCarState(spawn.x, spawn.y, spawn.z, spawn.h, 23);
          this.buildRig();
          this.chasePos.set(this.car.x, this.car.y + 2.15, this.car.z - 7);
          this.lookPos.set(this.car.x, this.car.y + 0.95, this.car.z);
          // re-run now that mats exists: the constructor's call could only
          // reach the renderer/post half of it (see applySettings)
          this.applySettings(this.settings);
          await withBudget(this.rig.cockpitReady, Game.DASH_BUDGET_MS);
        },
      },
      {
        label: "COMPILING SHADERS",
        weight: W.shaders,
        run: async () => {
          /* three compiles a material's program the first time it is DRAWN, so
             a world this size pays for a few hundred link calls spread over the
             first seconds of driving — the classic hitch right after a loading
             screen says it is done. compileAsync walks the whole scene up front
             (traverse, not traverseVisible: the culled chunks count too) and,
             where KHR_parallel_shader_compile exists, lets the driver link off
             the main thread while we sit here. */
          await withBudget(
            this.renderer.compileAsync(this.scene, this.camera),
            Game.COMPILE_BUDGET_MS
          );
        },
      },
      {
        label: "ROLLING OUT",
        weight: W.warm,
        run: async () => {
          /* Compiling is not the whole of a first frame: textures upload on
             first use, the post chain and the mirror/reflection passes have
             their own programs, and none of that is reachable from
             compileAsync. So run the real render loop — paused, so nothing
             moves — for a few frames behind the loading screen. Whatever is
             still one-off cost gets paid here instead of in the player's first
             corner, and the canvas already holds a finished frame when the
             overlay comes off, so the handoff has nothing to flash. */
          await this.warmFrames(3);
        },
      },
    ];
  }

  /** Latched when a stage throws. A failed load leaves a half-built scene —
      ground and half an expressway already in it — and re-running the stages
      over that would stack a second world on top of the first rather than
      recover. There is no resume; the only way out is a page reload, which is
      what the loading screen offers. */
  private loadFailed = false;

  /** The load in flight, so a second call adopts it instead of starting a
      second build. A double-tap on DRIVE is one tap as far as the player is
      concerned; without this it would be two towns in one scene. */
  private loading: Promise<void> | null = null;

  /** Build the world, reporting progress, with the browser free to paint
      between stages. Rejects if a stage throws — the caller owns the error
      state. Safe to call again at any point: already loaded is a no-op, still
      loading joins the load in flight. */
  load(onProgress: (r: LoadReport) => void): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadFailed)
      return Promise.reject(new Error("the world build already failed — reload the page"));
    if (!this.loading) this.loading = this.runLoad(onProgress);
    return this.loading;
  }

  private async runLoad(onProgress: (r: LoadReport) => void): Promise<void> {
    let timings: Record<string, number>;
    try {
      timings = await runStages(this.buildStages(), onProgress, () => this.disposed);
    } catch (e) {
      this.loadFailed = true;
      throw e;
    }
    if (this.disposed) return;
    this.loaded = true;
    // real per-stage milliseconds, for retuning LOAD_WEIGHTS against a device
    const dbg = (window as any).__neonx;
    if (dbg) dbg.loadTimings = timings;
  }

  /** Run the render loop, paused, until `n` frames have been drawn. */
  private warmFrames(n: number): Promise<void> {
    this.beginLoop();
    return new Promise((resolve) => {
      let left = n;
      const tick = () => {
        // loop() re-arms its own rAF first, so by the time this runs the frame
        // it scheduled has been rendered
        if (this.disposed || --left <= 0) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
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
    /* Same reasoning as hiHeld, and worse consequences: the keyup for a held B
       never arrives either, and lookBack has no timer to fall back on — the
       camera stays reversed for the rest of the session. */
    this.lookBack = false;
    /* Analog steer state is not a key and so survives the loop above. A phone
       put down mid-corner, or left tilted through a pause, otherwise resumes
       still steering. */
    this.wheelVal = this.tiltVal = 0;
  };

  /* ---------------- rig ---------------- */
  private buildRig() {
    if (this.rig) this.rig.dispose(this.scene);
    const spec = getCar(this.carId);
    this.rig = buildPlayerCar(
      this.scene, spec, PAINTS[this.paintIx % PAINTS.length].hex,
      this.mats.envMap, this.mats.glowTex, this.post.mirrorRT.texture,
      this.renderTier
    );
    this.rig.cockpit.setMirrorVis(this.mirror);
    // POV shield: re-handed on every rig build so a car swap never leaves
    // post.ts projecting a disposed mesh. The head unit goes through a thunk
    // because a donor dash can move the nav canvas onto its own screen mesh
    // long after this runs (see Cockpit.navPanel).
    this.post.setPovMirror(this.rig.cockpit.mirrorGlass, this.camera);
    this.post.setPovScreen(() => this.rig.cockpit.navPanel());
  }

  setCar(carId: string, paintIx: number) {
    this.carId = carId;
    this.paintIx = paintIx;
    // the garage is reachable from the main menu, where there is no rig to
    // rebuild yet — the load stage picks these up and builds the chosen car
    if (this.loaded) this.buildRig();
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
    /* A/B the imported dash against the procedural one. Both are built and
       resident, so this is a visibility flip — the point is to be able to
       judge the import against what it replaces in the same frame and the
       same light, which is the only comparison that means anything. */
    if (k === "j") {
      const m = this.rig.cockpitModel;
      if (!m) this.ui.toast("NO IMPORTED DASH");
      else {
        this.dashImported = !this.dashImported;
        m.setActive(this.dashImported);
        this.ui.toast("DASH " + (this.dashImported ? "IMPORTED" : "PROCEDURAL"));
      }
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
    /* In-dash music transport. P / , / . are the only free keys left that map
       to the convention people already have in their fingers (P for play-
       pause, and the , . pair which carry < > as their shifted glyphs, i.e.
       the transport arrows). Desktop only: music.enabled is false on touch,
       where these keys cannot be pressed anyway. */
    if (k === "p") {
      this.music.toggle();
      if (this.music.enabled)
        this.ui.toast(this.music.playing ? "♪ " + this.music.track.title : "MUSIC PAUSED");
    }
    if (k === "," || k === ".") {
      k === "." ? this.music.next() : this.music.prev();
      if (this.music.enabled) this.ui.toast("♪ " + this.music.track.title);
    }
    if (k === "b") this.lookBack = true;
    if (k === "g") this.hiBeamDown();
  };

  /* The G gesture, factored out of the key handlers so the touch button can
     drive the identical path. It cannot go through bindHold(): that only sets
     keydown[], and everything about this gesture — the stalk click on the
     OFF→ON edge, the flash-vs-latch decision — lives here, not in a per-frame
     read of the key state. */
  private hiBeamDown() {
    /* Momentary while held; a long hold toggles the latch instead. Nothing
       is decided here beyond starting the clock — which of the two gestures
       this turns out to be is only known at 2 s (hiBeamHold) or at release,
       whichever comes first. `e.repeat` is already filtered above, so
       autorepeat can't re-arm the timer under a held key. */
    if (!this.highBeam) this.audio.stalkClick(); // stalk click on the OFF→ON edge only (lane O)
    // traffic reads this as one flash-at-the-car-ahead gesture. Only while
    // running: nothing consumes the pulse when the world is paused, and a
    // flash banked in a menu must not fire the moment play resumes.
    if (this.running) this.hiFlashPulse = true;
    this.hiHeld = true;
    this.hiConsumed = false;
    this.hiDownAt = performance.now() / 1000;
  }
  private onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    this.keydown[k] = 0;
    if (k === "b") this.lookBack = false;
    if (k === "g") this.hiBeamUp();
  };

  private hiBeamUp() {
    // A release that ends a latch toggle is not also a flash: the gesture was
    // already spent at the 2 s mark, and without this the beams would blink
    // back on for the instant between the toggle and letting go.
    this.hiHeld = false;
    this.hiConsumed = false;
  }

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
    /* Horn rides bindHold because input.horn is a per-frame read of keydown["f"]
       (see the input block in frame()), so a held button is all it needs. */
    bindHold("tcH", "f");
    /* Flash cannot: see hiBeamDown/hiBeamUp. Same press/release pair as G, so
       tap = flash and a 2 s hold = latch, identical to the keyboard. */
    const flashBtn = document.getElementById("tcF");
    if (flashBtn) {
      flashBtn.addEventListener("pointerdown", (e) => {
        flashBtn.setPointerCapture((e as PointerEvent).pointerId);
        this.hiBeamDown();
      });
      const up = () => this.hiBeamUp();
      flashBtn.addEventListener("pointerup", up);
      flashBtn.addEventListener("pointercancel", up);
    }
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
    /* Paused, the menu owns the keyboard: W held in the pause menu, or the
       Space that activates a focused menu button, would otherwise keep ramping
       th/hb and resume with throttle or the handbrake already applied. Zeroed
       rather than skipped so the ramp restarts from rest, matching the blur
       path. Placed here, not at the top of readInput — everything above still
       has to run while paused so a held beam key can't stall the lamps. */
    if (!this.running) {
      this.input.th = this.input.br = this.input.st = this.input.hb = this.input.horn = 0;
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
  /** Planar road reflections, as actually rendered: user setting AND tier.
      Mobile tiers never pay for the reflection RT; the material's uRefStr is
      zeroed via setWet at the same call sites, so nothing samples stale data. */
  private get reflectionsOn() {
    return this.settings.reflections && this.tierCaps.reflections;
  }
  applySettings(s: GameSettings) {
    this.settings = s;
    // re-resolve the tier: the manual override lives in these settings, and a
    // change has to land on the same frame the settings panel applies it
    this.renderTier = resolveRenderTier(s, this.isTouch, this.renderer.getContext());
    this.tierCaps = TIER_CAPS[this.renderTier];
    // a tier flip changes the mirror/reflection RT policy even when the pixel
    // ratio happens not to move — force the target rebuild path below
    if (this.post.setMobile(this.tierCaps.mirrorHalf)) this.lastPR = -1;
    // tier flips retarget the cinematic extras on the same frame too
    this.post.setCinema(!!this.tierCaps.dualBloom, !!this.tierCaps.filmLook);
    /* DPR: perf mode floors everything at 1; otherwise the preset's own cap
       (low 1, medium 1.5) combines with the tier ceiling — 1.1 mobile-base,
       1.35 mobile-high, 1.75 desktop — and the lower one wins. */
    const presetCap = s.preset === "low" ? 1 : s.preset === "medium" ? 1.5 : Infinity;
    const pr = this.perfMode
      ? 1
      : Math.min(devicePixelRatio, presetCap, this.tierCaps.dprCap);
    if (pr !== this.lastPR) {
      // render targets are only rebuilt when the resolution actually changes —
      // slider drags hit this path every input tick
      this.lastPR = pr;
      this.renderer.setPixelRatio(pr);
      this.post.makeTargets(this.perfMode);
      this.mats?.setReflectionTexture(this.post.reflectRT.texture);
      this.mats?.setReflectionScreen(
        innerWidth * this.renderer.getPixelRatio(),
        innerHeight * this.renderer.getPixelRatio()
      );
    }
    /* The settings panel is reachable from the main menu, i.e. before the
       staged load has built any materials. The renderer/post half above still
       applies, and the load re-runs this whole call once mats exists, so an
       early preset change is not lost — it just lands a stage later. */
    if (this.mats) {
      this.mats.setWet(this.rain, this.reflectionsOn);
      this.updatePbrDetail();
    }
    this.timeSpeed = s.autoTime ? (this.timeSpeed === 0 ? 150 : this.timeSpeed) : 0;
    this.audio.setLevels(s.vol, this.running ? 1 : 0.12);
    this.music.setLevels(s.vol);
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
    const want =
      !this.perfMode && this.settings.preset !== "low" && this.tierCaps.pbrDetail;
    if (want === this.pbrDetail) return;
    this.pbrDetail = want;
    this.mats.setPbrDetail(want);
  }

  setRain(on: boolean) {
    this.rain = on;
    // settable from the pre-Drive settings panel: `rain` is read back by the
    // load's applySettings pass, so the world comes up wet either way
    if (this.loaded) {
      this.rainFX.pts.visible = on;
      this.mats.setWet(on, this.reflectionsOn);
    }
    this.ui.toast(on ? "RAIN — grip down" : "RAIN OFF");
  }

  /* ---------------- lifecycle ---------------- */

  /** Create and unlock the AudioContext.

      Split out of start() because it has to happen inside the Drive tap
      itself: iOS only lets an AudioContext leave the "suspended" state when it
      is created in a user gesture, and the staged load now sits between the
      tap and start() — several tasks later, by which time the gesture no
      longer counts. Idempotent, so start() calling it again costs nothing. */
  primeAudio() {
    this.audio.init();
    this.audio.setCar(this.carId);
    // The music player keeps its own AudioContext and needs the same gesture.
    this.music.prime();
  }

  /** Begin the render loop. The warm-up stage of the load calls this too, so
      the loading screen's last stage is drawing real frames. */
  private beginLoop() {
    if (this.started) return;
    this.started = true;
    this.last = performance.now() / 1000;
    this.loop();
  }

  start() {
    this.primeAudio();
    this.beginLoop();
  }

  setRunning(run: boolean) {
    this.running = run;
    this.audio.setLevels(this.settings.vol, run ? 1 : 0.12);
    if (!run) this.audio.quiesce();
    /* quiesce() zeroes the reverb send directly, so the cached value no longer
       describes the graph — drop it, or unpausing inside the tunnel would come
       back bone dry and stay that way until the blend happened to move. */
    this.lastReverb = -1;
    this.music.setRunning(run);
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
    this.music.dispose();
    this.post.dispose();
    /* The rig owns ~10 env-mapped materials registered in carenv's module-level
       `tracked` Set. Without this they stay pinned to a dead GL context, and
       since primeCarEnv's `started` flag never clears, the next renderer after
       a remount or HMR silently never receives the HDRI and falls back to the
       painted cube for good. rig.dispose() untracks them (player.ts:745). */
    this.rig?.dispose(this.scene);
    /* Geometry, the rain PointsMaterial and 70 SpriteMaterials. Optional-chained
       for the same reason as the rig: both are `!`-declared and only exist once
       the world has built. Their textures (streakTex/smokeTex) are deliberately
       NOT freed here — they belong to the material bundle and outlive the FX,
       and smokeTex is the same object on all 70 sprites. */
    this.rainFX?.dispose(this.scene);
    this.smokeFX?.dispose(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    delete (window as any).__neonx;
  }

  private onResize = () => {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.post.makeTargets(this.perfMode);
    // an orientation change on the menu screen arrives before there are any
    // materials to re-point at the new targets
    this.mats?.setReflectionTexture(this.post.reflectRT.texture);
    this.mats?.setReflectionScreen(
      innerWidth * this.renderer.getPixelRatio(),
      innerHeight * this.renderer.getPixelRatio()
    );
  };

  resetCar() {
    const car = this.car;
    const bySurf = this.world.routes?.surfaceAt(car.x, car.z, 2);
    if (bySurf && Math.abs(bySurf.y - car.y) < 3.4) {
      /* On the bypass: put the car back on its CURRENT route edge — snapping
         to the corridor from the viaduct would teleport it sideways and 12 m
         down. Mid-lane at the same arclength, facing down the edge. */
      const by = this.world.routes!.bypass;
      const s = Math.max(4, Math.min(by.len - 4, bySurf.s));
      const off = by.laneOffset(Math.floor(by.lanes(s) / 2), s);
      const w = by.worldOf(s, off);
      car.x = w.x;
      car.y = w.y;
      car.z = w.z;
      car.h = by.poseAt(s).h;
    } else if (car.y > 4) {
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
      else this.audio.npcHorn(n.x, n.z, n.type === "truck" || n.type === "bus");
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
      g.size = 9.8;
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
    /* Dipped candela is deliberately tiny next to main beam's: 150 (wet 195,
       the same ~1.3x wet boost), down from 780 in two steps. It reads as far
       too low a number on its own and it is not — see the angle/decay block
       below for the whole argument, but the short version is that ground
       illuminance goes as I*h/r^(decay+1) and the near strip of tarmac is
       only ~0.7 m from the lamp, so the pool's own dynamic range is what was
       blowing it out, not its level. Cutting I is what buys the room to
       flatten decay and widen the cone back out, which is what the user
       actually asked for ("less bright but cover more space and have more
       gradient"). At 30 m this costs only ~9% against the previous cut.
       High beam is untouched — its 5400/7000 pair is solved against the
       traffic knee described above.

       Now 60 (wet 80), down from 130, because the cones are no longer the
       light — the carpet decal is (see the drive further down, and the build
       comment in player.ts). Their job shrank to what only a real light can
       do: shade car bodies, barriers and signs with a direction, and put a
       soft gradient across the road that a flat decal cannot. At this level
       no individual cone is separable from the wash it sits in, which is the
       point — you should not be able to see where one lamp ends. */
    const si = lamps
      ? hi ? (this.rain ? 7000 : 5400) : (this.rain ? 80 : 60)
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
    // tier gate: mobile-base drops the two fill cones entirely — two fewer
    // live spotlights in every forward shader — and the main beams carry the
    // scene alone, which they did for the game's whole life before the cones
    /* THE DIPPED FILL CONES WERE THE WHITE SLAB, not the main beam. Every
       earlier pass here reasoned about ground illuminance as I*h/r^(decay+1)
       and left out the cone's own angular term, which flattered the main beam
       and hid these: modelling three's actual `spotAttenuation` smoothstep
       put the flank cones' peak at ~291 units against the main beam's ~62.
       They were five times brighter than the beam they were filling for,
       because a 27 deg pitch off a 0.44 m mount lands the axis 0.86 m from
       the lamp — all of their output was going into the strip of tarmac
       beside the front wheels, which is exactly the blown patch in the POV
       shot, and almost none of it was reaching the adjacent lane it exists
       to light (0.36 units at 4 m out, 10 m ahead).

       So they are re-solved rather than trimmed: 320 -> 110 cd, decay
       0.8 -> 0.45, angle 0.52 -> 0.24 rad, penumbra -> 1.0, pitch re-pinned
       (see HL_SPREAD_PITCH) and yawed further out via `kick`. Narrow, shallow,
       soft and aimed outward beats wide, steep and bright for the one thing
       these exist to do: at 14 m ahead the cone axis passes through x = 3.8 m
       with a half-angle spanning roughly 0.4-7.2 m, so the neighbouring lane
       centre at 3.7 m sits in the middle of the footprint instead of off its
       edge. Judging the angle on its own understates the coverage — these are
       YAWED cones, so narrowing them moved the pattern outward rather than
       shrinking it inward. High beam's cones are untouched, as its main beam
       is. */
    const si2 = lamps && this.tierCaps.spreadCones
      ? hi ? (this.rain ? 3070 : 2370) : (this.rain ? 145 : 110)
      : 0;
    this.rig.spreadL.intensity = si2;
    this.rig.spreadR.intensity = si2;
    /* Halogen dipped beam is warm — around 3200 K — and reading it as warm is
       most of why the pool on the tarmac looks like light rather than like a
       grey texture that got brighter. Main beam runs whiter, the way a boosted
       filament (or the HID/LED it is imitating) actually does. */
    /* Dipped stays at its long-standing 0xffeeda. A previous pass warmed this
       to 0xffe0b0 on the theory that the tint would survive the grade once
       the level came down — it did survive, and that was the problem: warm
       source plus the sodium-tinted texture the carpet first borrowed made
       the whole road read orange, as if the streetlights had been changed.
       Halogen is warm-WHITE. The sodium hue belongs to LAMP_SODIUM and the
       lamps overhead, and the car has to stay a different colour from them
       or the two light sources stop being distinguishable. High beam keeps
       its whiter 0xfff4e6. */
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
    /* The wedge must pitch with the car the same way the spotlights now do
       (lampsG rides bodyG — see player.ts): its y is a gradient per metre of
       forward run, exactly the units car.slope is measured in, so following
       the deck is literally adding the deck's own gradient. pitchVis (nose
       dive/squat, positive = nose down) is subtracted to match bodyG's
       rotation; it is a small damped angle, so the small-angle tan is fine.
       Without these terms the wedge stayed world-horizontal and diverged from
       a 6-10% ramp deck by its full grade — 3.4-5.7 degrees — which is most
       of the paint's fully-lit tolerance. The lamp-line origin also rides the
       nose, which sits slope*2.05 above/below car.y on a grade. The dipped
       -0.05 / high -0.012 aim offsets are unchanged (a89aac9 character). */
    const bpitch = car.slope - Math.tan(this.pitchVis);
    this.beamPos.set(
      car.x + Math.sin(car.h) * 2.05,
      car.y + 0.62 + car.slope * 2.05,
      car.z + Math.cos(car.h) * 2.05);
    this.beamDir.set(
      Math.sin(car.h), bpitch + (hi ? -0.012 : -0.05), Math.cos(car.h));
    this.mats.setBeam(
      lamps, this.beamPos, this.beamDir, f, BEAM_FLOOR,
      (hi ? HL_THROW_HI : HL_THROW) / HL_PAINT_BASE);
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
      // HL_CLIP, not HL_THROW: this is where three's falloff window shuts off
      // the light entirely, and it has to land past the lit road, not on it
      sp.distance = hi ? HL_CLIP_HI : HL_CLIP;
      /* The cut-off constraint pins the axis pitch to the half-angle, so a
         wide cone is forced to point steeply down and its hot spot lands on
         the bumper. That is what made the dipped pool read as a flat white
         slab against the hood in POV, and the hard edge around that slab was
         NEVER the beam's falloff — it is the composite's blown-highlight clip
         (post.ts, `smoothstep(.72,1.02,luma)` toward flat white; lampProtect
         only shields *saturated* lamps, and a headlight pool is near-white by
         construction). Everything above ~0.72 luma is pushed to the same
         constant, so the gradient inside the blob is erased and the 0.72
         iso-luma contour prints as a boundary. The fix is therefore to get
         the pool's area under that threshold, not to soften a falloff that
         was already fine. Do not "restore" this by brightening.

         Ground illuminance is E = I*h / r^(decay+1): the Lambert cosine on a
         flat road is h/r, so the plane contributes one power of r on top of
         `decay` no matter how shallow decay is. The nearest lit strip sits
         ~0.7 m from a 0.60 m lamp and 30 m of road sits at r=30, so at the
         old decay 1.0 (an effective inverse square) the pool spanned about
         1100:1 from its near edge to 30 m out. No exposure holds that: the
         near end is forced past the clip and the far end sits near black,
         which is exactly why there was no visible gradient between them. The
         pool's own dynamic range was the defect.

         Two levers, and the ORDER matters. First `decay` 1.0 -> 0.6, which
         attacks the ratio directly (1100:1 -> 271:1, i.e. 4x flatter) — this
         is the "more gradient" half and nothing else in the block can do it.
         Then intensity down far enough (see `si` above) that the whole
         compressed range fits under the 0.72 clip. Only once the near strip
         is no longer blowing out does width become free: an earlier pass had
         to narrow to 0.26 rad to keep the hottest tarmac outside the cone at
         all, and with the near edge now at ~105 units instead of ~570 that
         constraint is gone, so 0.36 comes back. Widening never dims a point
         that stays inside the cone (E depends on I, h and r, not on angle) —
         it only moves the cone's lower edge and adds flanks.

         WIDENING THE CONE MAKES ALL OF THIS WORSE, which is the opposite of
         what it looks like and cost several passes to find. The reason is the
         cone's own angular term: three multiplies by smoothstep(cos(angle),
         cos(angle*(1-penumbra)), cosAngleToAxis), and once the upper edge is
         pinned just below horizontal the axis necessarily points down by a
         full half-angle — so a WIDE cone aims its bright axis at the tarmac
         right in front of the car and leaves the road at 10-30 m sitting in
         the last few degrees before its rim, where that smoothstep is nearly
         zero. Model the angular term and the numbers invert (penumbra 1.0,
         decay 0.45, I 150, on-road centreline):

           angle   axis lands   peak    E@10m   peak:E@10
           0.46 rad   1.20 m    84.5     0.41     205:1
           0.36 rad   1.57 m    62.0     0.63      99:1
           0.30 rad   1.91 m    48.7     0.84      58:1
           0.24 rad   2.41 m    36.0     1.17      31:1
           0.18 rad   3.22 m    24.2     1.71      14:1

         Narrowing is 3.5x cooler at the peak AND 4x brighter at 10 m and 15x
         flatter overall. There was never a width-vs-gradient trade on the
         main cone; the earlier passes only believed in one because their
         model had no angular term. 0.22 rad is the settled value: axis ~2.7 m
         out, and it is the lateral cones (yawed outward, see `kick`) that
         spread light left and right — a bumper-height cone pinned near
         horizontal cannot do that itself at any half-angle, because azimuthal
         offset adds to the total off-axis angle, so even 0.46 rad contributes
         nothing 4 m to the side.

         The cut-off itself is untouched and is INDEPENDENT of angle — the
         upper edge stays at atan(LOW_DIP), 0.229 deg below horizontal, so
         the reach is still ~150 m and the glare limit is unchanged. Do not
         "restore" any of this by brightening. Main beam unchanged. */
      sp.angle = hi ? 0.23 : 0.26;
      /* Dipped penumbra is 1.0 — the maximum — and that is a deliberate end
         state, not a value to keep nudging. At 1.0 the inner cutoff collapses
         onto the axis, so the angular term becomes one continuous smoothstep
         from full on the axis to zero at the rim: there is no plateau, hence
         no rim to print. Every intermediate value (0.68, then 0.85) still had
         a hard-edged core disc feathered at its border, which is precisely
         the "hard line" being chased through all of these passes.

         It also removes the near-field spike for free, because the hottest
         geometry — tarmac a metre from the lamp, at the cone's lower rim — is
         exactly where the smoothstep evaluates to zero. Softness and a cool
         near field are the same lever here, not a trade.

         Main beam keeps its harder 0.4: a tight, defined edge is what reads
         as main beam, and none of this applies to it. */
      sp.penumbra = hi ? 0.4 : 1.0;
      /* decay is per-mode, not a fixed ctor value (see player.ts). Dipped
         runs 0.45 — well below inverse-square — purely to compress the
         pool's near/far ratio; the road plane already contributes one power
         of r through the Lambert cosine, so 0.45 still falls off faster than
         inverse-square in practice. High beam stays steep at 1.5 so distant
         cars fall back out of the traffic knee's ceiling instead of staying
         pinned white, and that split is now 0.45/1.5.

         The knee risk of a shallower dipped decay is real but bounded, and
         it is bounded by the cut-off rather than by the level: a flatter
         curve does hand distant surfaces relatively more light (a vertical
         panel crosses over the old 640/1.0 config at ~38 m), but the dipped
         cone's upper edge is only (0.60 - 0.004*d) m above the road, so past
         that crossover it is lighting a sub-0.45 m band of valance and tyre,
         and in absolute terms 150/d^0.6 out there (9-17) is far below what
         640/d^1.0 already put on close cars (64-213) without complaint. */
      sp.decay = hi ? 1.5 : 0.45;
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
      /* Dipped 0.52 -> 0.18 rad with penumbra 1.0, for the reason the main
         cone above is narrow and soft: with the upper edge pinned, a wide
         cone must aim its axis into the near tarmac, and its angular
         smoothstep then starves everything further out. Narrow + shallow +
         yawed outward reaches the next lane; wide + steep only lit the
         wheel arch. Angle and HL_SPREAD_PITCH move together — the pin is
         (pitch - angle), so neither can be edited alone. */
      sp.angle = hi ? 0.55 : 0.24;
      sp.penumbra = hi ? 0.5 : 1.0;
      /* Dipped 1.2 -> 0.45, matching the main cone so the pool and its
         flanks fall off on the same curve instead of the flanks dying while
         the pool carries on. Safe against the traffic knee by construction:
         a flatter curve only ever overtakes the old one at long range, and
         HL_SPREAD_THROW clips these cones at 36 m, so the crossover sits
         outside the cone and no car can see more light than it did before. */
      sp.decay = hi ? 1.3 : 0.45;
      // dipped kick 3.0 -> 3.5: with the cone narrow, lateral coverage is
      // bought with yaw rather than half-angle. 3.5 at tz 14 aims it 14 deg
      // out — enough to reach the next lane, little enough that its skirt
      // still overlaps the main cone's and leaves no dark seam between them
      const kick = hi ? 4.0 : 3.2, tz = hi ? 22 : 14;
      const spitch = hi ? HL_SPREAD_PITCH_HI : HL_SPREAD_PITCH;
      const horizDist = Math.hypot(kick, tz);
      sp.target.position.set(
        side * kick, sp.position.y - horizDist * Math.tan(spitch), tz);
    }
    /* The carpet — the wide soft wash on the road, and after this pass the
       thing the player actually reads as "the headlights are on". See the
       build comment in player.ts for why this is a decal and not a light; the
       short version is that a cone with a horizontal cut-off must aim its hot
       axis at the near tarmac, so it can be wide or it can be soft, never
       both, whereas a gradient quad has no cone to constrain it.

       Footprint is DERIVED FROM THE ROAD, not set in metres. A fixed 20 m
       width was the first cut and it was badly wrong: the deck is three lanes
       for most of its length, so `cor.halfWidth` is about 5.3 m and a 20 m
       quad hung ~4.5 m past the parapet on each side, lighting the barriers
       and the open air beyond them. It read as the whole street being lit
       rather than the road ahead of one car.

       So the width comes from the corridor at the point the wash is centred:
       both edges land 0.4 m inside the barrier faces, which also makes the
       toll plaza (six lanes) widen the wash for free and the elevated
       sections keep it off the parapet by construction. The gradient is zero
       at the quad's edge, so stopping inside the barrier costs no visible
       edge — there is nothing there to cut off.

       Length and origin are per-mode, and the quad STARTS AT THE BUMPER. An
       earlier cut centred it 9 m ahead with a 30 m length, which put its near
       end 6 m BEHIND the lamp line on the theory that a wash beginning several
       metres out would read as a floating slab. With a radial texture that was
       simply wrong: it drew light beside the doors and behind the rear wheels
       and read as a halo around the car. Headlights throw forward only, so the
       near edge now sits at the nose and the texture's own ramp (see
       carpetBeamTex) takes the level up from zero over the first few metres —
       the soft start comes from the gradient, not from hanging geometry behind
       the car. Dipped runs 26 m from the nose, main beam 46 m.

       Opacity is additive on top of a near-black night road, so it does not
       need to be large — and it has been walked down three times, because
       "too bright" was the complaint every single time it was looked at.
       Dipped 0.45 -> 0.25 -> 0.125, main 0.55 -> 0.31 -> 0.155, then rescaled
       to 0.22/0.27 for the wedge, whose peak alpha is 0.52 rather than the
       radial texture's 0.78 — the old number over the new shape would have
       been a visible cut. Peak output is ~0.107 against the 0.72 luma where
       the POV composite starts clipping to flat white: nowhere near it.

       The level also controls the wash's apparent SIZE, which is not obvious
       and is most of why halving it reads as such a large change. The POV
       chain crushes blacks with `col - .06` (post.ts), so every pixel of the
       skirt below 0.06 is pure black and simply is not there — the visible
       wash is the region above that floor, not the quad. Dimming this shrinks
       it; brightening it grows it, so retune this before the footprint or the
       two levers fight each other. Rain lifts it slightly because wet tarmac
       genuinely spreads a beam further, and daylight takes it out entirely. */
    const carpet = this.rig.beamCarpetMat;
    carpet.opacity = lamps
      ? (hi ? 0.27 : 0.22) * (1 - f) * (this.rain ? 1.15 : 1)
      : 0;
    /* Near edge at the nose, so the wedge leaves the car where the lamps do.
       `carpetLen` is measured from there; the mesh's own centre is therefore
       half a length further on. */
    const carpetLen = hi ? 46 : 26;
    const carpetZ = 2.05 + carpetLen / 2;
    // 0.4 m short of the barrier face on each side; floored so a freak
    // narrow section cannot invert the quad
    const carpetHW = Math.max(2.4, this.cor.halfWidth(car.z + carpetZ) - 0.4);
    /* POV-only lateral widening. The wash is the same metres of road in every
       view, but POV_HFOV is 105 deg — at 20 m ahead that frame spans ~52 m of
       road width, where a ~60 deg chase view spans ~23 m. So the identical
       13 m wedge fills about a quarter of the POV frame against over half of a
       chase frame, and reads as too narrow purely because a wide-angle lens
       gives it less screen. Widening only in POV corrects the apparent width
       where the problem is, instead of distorting the other cameras to fix a
       lens artefact. It is applied to the quad, so the wedge texture (whose
       lateral profile is normalised to the quad) stretches with it and keeps
       its shape — nose stays narrow, far end still spans the carriageway. */
    const povWide = this.camMode === CAM_POV ? 1.5 : 1;
    this.rig.beamCarpet.scale.set(carpetHW * 2 * (hi ? 1.1 : 1) * povWide, carpetLen, 1);
    this.rig.beamCarpet.position.z = carpetZ;
    this.rig.beamCarpetG.rotation.x = -Math.atan(car.slope);
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
    // tier scales the user's draw distance down before the reactive perf cap
    // bites — 0.65 mobile-base / 0.85 mobile-high / 1 desktop — so the two
    // compose instead of fighting: the perf cap still wins when it is lower
    const scaled = this.settings.drawDist * this.tierCaps.drawDistScale;
    const dd = this.perfMode ? Math.min(scaled, 520) : scaled;
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
    this.lampWash(inside);
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
      rig.cockpit.drawScreen(this.world, car, this.traffic.npcs, this.time, now);
    }
    if (this.dropT > 0.033) {
      rig.cockpit.dropletsUpdate(this.dropT, wiping, rig.cockpit.wiperA.rotation.z, this.rain, Math.abs(car.u));
      this.dropT = 0;
    }
  }

  /** deterministic 1D hash in [0,1) — same input always gives the same
      output, so road texture is a fixed property of a position, not a
      per-frame random draw. */
  /* Sodium amber sweeping through the cabin, once per lamp pitch.

     The deck streetlights are fake — instanced heads plus additive cones and
     ground pools, no real lights anywhere — so nothing they do reaches the
     cockpit's PBR trim. What sells "driving under streetlights" from inside is
     not the lamp you can see through the glass, it is the highlight racing
     back over the pad and the door caps as you pass under one. The cabin
     already owns a real point light for exactly that read (the cool "city
     light through the glass"); it was just static. Drive it off the lamp
     lattice and one light does the whole effect for free — no new light, no
     shadow map, nothing added to the chase view.

     A uniform brighten-and-dim would read as a flicker, not as a lamp, so the
     light TRAVELS: it starts ahead of the windscreen, arrives at its rest pose
     as the car passes under the head, and carries on back over the seat. */
  private lampWash(inside: boolean) {
    const gl = this.rig.cockpit.glassLight;
    /* Every gate that stops the lamps being drawn has to stop the wash too:
       the interior not being on screen, daylight (the pools and glow fade out
       on the same factor — amber strobing at noon is the tell), a tier that
       sheds the cones and pools, and tunnel/toll stretches, whose lamps the
       generator skips outright. */
    const caps = this.tierCaps;
    const cones = caps.lampCones !== false;
    const pools = (caps.lampPoolEvery ?? 1) !== 0;
    const night = inside && (cones || pools) ? 1 - this.dayFactor() : 0;
    const z = this.cor.zAt(this.car.x, this.car.z);
    if (night <= 0.01 || this.cor.inTunnel(z) || this.cor.inToll(z)) {
      gl.position.set(0, GLASS_REST.y, GLASS_REST.z);
      gl.intensity = GLASS_REST.intensity;
      gl.color.setHex(GLASS_REST.color);
      return;
    }
    /* Low tiers thin the lamps in PAIRS on the folded lattice index (see
       keepNth in highway.ts) — the same test here, so the wash fires under the
       lamps that actually got a cone/pool and stays quiet under the bare
       poles. Cones lead: they are the taller half of the fixture's light. */
    const every = Math.max(1, (cones ? caps.lampConeEvery : caps.lampPoolEvery) ?? 1);
    const li = this.cor.latticeIndex(z, PITCH.light, PHASE.light);
    if (li % (2 * every) >= 2) {
      gl.intensity = GLASS_REST.intensity;
      gl.color.setHex(GLASS_REST.color);
      return;
    }
    /* Signed position within the pitch: 0 directly under the head, -0.5 half a
       pitch before it, +0.5 half a pitch after. */
    const u = ((((z - PHASE.light) % PITCH.light) + PITCH.light) % PITCH.light) / PITCH.light;
    const s = u < 0.5 ? u : u - 1;
    /* The pulse, as the product of two pressure-point tables (WASH_LAT and
       WASH_LONG above) — one per axis, both in metres from the lamp head.

       The lateral term is the whole point of this pass. Lamps do not stand on
       the centreline: they alternate sides on the folded lattice, and the head
       hangs 1.55 m in from a parapet that is itself 0.23 m outside the deck
       edge, so its lateral offset is flip * (halfWidth - 1.32) — about 5.8 m
       on a 3-lane stretch. `flip` comes from the parity of the SAME lattice
       index the tier-thinning test above already computed (highway.ts:1135
       picks the side the identical way), so the side costs nothing to know.
       Without this term a car hugging the far shoulder sat 12 m away from the
       lamp and still got the full wash; that was the defect.

       A product rather than one elliptical distance metric: the two axes have
       genuinely different physics (inverse-cube sideways, a directional throw
       plus the windscreen aperture down-road) and a product lets each table be
       retuned without disturbing the other. It also yields the oval footprint
       the ellipse would have given — longer along the road than across it —
       because the long table simply has stops further out. */
    const dLong = Math.abs(s) * PITCH.light;
    const lampLat = (li % 2 ? 1 : -1) * (this.cor.halfWidth(z) - 1.32);
    const dLat = Math.abs(this.cor.latAt(this.car.x, this.car.z) - lampLat);
    const w = washStops(WASH_LONG, dLong) * washStops(WASH_LAT, dLat) * night;
    /* The sweep travels front-to-back so a lamp reads as light passing THROUGH
       the cabin rather than as a bulb nodding inside it.

       Both offsets are scaled by the wash, and that is load-bearing rather than
       tidiness: this light is ALSO the cabin's standing "city light through the
       glass" (GLASS_REST, cool 0xbfd0ff at 0.5 cd), which is what lights the pad
       when no lamp is near. An earlier cut displaced it by -s * 1.6 outright, so
       at the midpoint between two lamps — where the sodium term is correctly
       zero — the cool light still sat up to 0.8 m off its designed spot, raking
       trim it was never aimed at and reading as a white wash through the cabin.
       Scaling by `sweep` returns it exactly to its rest pose as the wash fades,
       so the standing light stays the fixed thing it is supposed to be and only
       the lamp contribution moves.

       `sweep` saturates at w >= 0.5 so a close pass gets the full travel, while
       a distant one (far lane, w ~ 0.12) barely moves the light at all — which
       is the correct read: that lamp is not doing anything to this cabin. */
    const sweep = Math.min(1, w * 2);
    gl.position.set(0, GLASS_REST.y + 0.22 * w, GLASS_REST.z - s * 1.6 * sweep);
    /* Peak level is a HUE budget, not a brightness one. The composite runs a
       fitted ACES curve and then drops its vibrance boost to 1.0 in the
       highlights, so lit trim above roughly 0.8 output luma loses its colour
       and the brightest, most-noticeable moment of the sweep goes white — the
       first cut peaked at 1.15 and read as a white flash for exactly that
       reason. 0.82 keeps the pad inside the range where the amber survives,
       and a saturated orange at a moderate level reads far more "streetlight"
       than a blown hotspot does. The trough stays where it was, just under the
       resting 0.5 cd, so the cabin is never darker than with a static light. */
    gl.intensity = lerp(GLASS_REST.intensity, lerp(0.46, 0.82, w), night);
    /* Hue is decoupled from level: the colour saturates to full sodium well
       before the intensity peak (w * 2.2) and stays there for the whole time a
       lamp is influencing the cabin. Tying the blend to the brightness
       envelope was the other half of the white read — at half pulse the light
       was still mostly the cool 0xbfd0ff. */
    gl.color.setHex(GLASS_REST.color).lerp(LAMP_SODIUM, Math.min(1, w * 2.2));
  }

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
            P.belt - COCKPIT_REF.belt + COCKPIT_EYE.y + this.povMountDy(),
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
        this.settings.traffic, this.input.horn > 0, this.dayFactor() < 0.32 || this.rain,
        this.hiFlashPulse
      );
      this.hiFlashPulse = false; // one press, one gesture — consumed here
      /* Per SECOND, not per rendered frame. This gate was a flat 0.35 chance
         every frame, so a 120 Hz display made four times the smoke a 30 Hz one
         did — everything inside fx.ts is dt-scaled and this was the last term
         that wasn't. 25.85/s is the Poisson rate whose per-frame probability
         is exactly 0.35 at 60fps, so the density there is what it always was;
         only the other refresh rates move, and they move onto it. A long dt
         after a stall saturates at p→1, i.e. one puff per wreck, not a burst. */
      const pSmoke = 1 - Math.exp(-25.85 * dt);
      for (const w of this.traffic.activeWrecks())
        if (Math.random() < pSmoke) this.smokeFX.emit(w.x, w.y + 0.9, w.z, Math.random() < 0.15);
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
        // NOTE: slipDemand used to be passed 11th, landing in the optional
        // rainIntensity slot — realigned (rainIntensity has no source yet).
        this.car.gear, this.car.onLimiter, undefined, this.car.slipDemand,
        // lane U (interior trim creaks): smoothed body accels + grade, and
        // whether the camera is an in-cabin view (cockpit/POV).
        this.car.axS, this.car.ayS, this.car.slope,
        this.camMode === CAM_COCKPIT || this.camMode === CAM_POV
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
    // reflectionsOn folds in the tier: on mobile tiers this is the ONLY call
    // site that writes reflectRT, so gating it here means the RT genuinely
    // never sees a per-frame render (setWet zeroes uRefStr at the same time,
    // so no material samples it either)
    if (this.reflectionsOn && (!this.perfMode || this.frameN % 2 === 0))
      this.renderReflection();
    this.camera.updateMatrixWorld();
    this.renderer.setRenderTarget(this.post.sceneRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const f = this.dayFactor();
    this.post.setSpeed(Math.abs(this.car.u) * 3.6);
    // the extreme degrade is a property of the camera, not a user filter — the
    // V-key `grade` below stays independent and keeps driving the mild look.
    // Both dashcam passes are desktop-tier only: on mobile the POV camera
    // still works as a clean hard-mounted view, it just skips the half-res
    // degrade chain (and the forced frame blend that rides along with it).
    this.post.setDashcamPov(this.camMode === CAM_POV && this.tierCaps.dashcam);
    this.post.process({
      // inside the tunnel the eye adapts to a much darker box: lift exposure
      // so the sodium strip and the walls read, instead of crushing to black
      // the night end is biased down so the crushed ambient survives the tone
      // map: lifting it back here would simply undo the darkness. Only the
      // lamps and lit windows are above the bloom knee once it is this low.
      exposure: lerp(lerp(0.98, 0.9, f), 1.34, this.tunT),
      grade: this.grade && this.tierCaps.dashcam,
      // bloom is untouched by the tier on purpose: it stays for every device
      bloom: this.settings.bloom,
      fxaa: this.settings.fxaa,
      mblur:
        this.settings.mblur && this.tierCaps.mblur && this.running
          ? clamp((Math.abs(this.car.u) * 3.6 - 70) / 170, 0, 0.42)
          : 0,
      time: now,
    });
    this.perfCheck(performance.now() - t0, dt);
  };
}
