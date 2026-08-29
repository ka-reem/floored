import * as THREE from "three";
import { clamp, lerp, mulberry32, type Rng } from "./util";
import {
  runStages, withBudget, type LoadReport, type LoadStage,
} from "./loading";
import {
  fogMultiplier, speedInUnits, unitLabel, resolveRenderTier, TIER_CAPS,
  defaultLifetimeStats,
  type GameSettings, type LifetimeStats, type Profile, type RenderTier,
  type TierCaps,
} from "./settings";
import { getCar, PAINTS, testDriveSpec, type CarSpec, type PhysicsSpec } from "./carspecs";
import { pollGamepad, type PadEdge } from "./gamepad";
import { buildMats, type Mats } from "./world/mats";
import { primeCarEnv, setCarEnvLift } from "./carenv";
import { makeTerrain, buildGround, type Terrain } from "./world/terrain";
import { buildRoadNet } from "./world/roadnet";
import { buildHighway, nearestExitAhead } from "./world/highway";
import { buildTown } from "./world/townmesh";
import { buildScenery } from "./world/scenery";
import { buildSky, type Sky } from "./world/sky";
import { ColliderIndex, signalPhase, type WorldData } from "./world/data";
import { getCorridor, TUNNEL, PITCH, PHASE, OVERPASSES } from "./world/corridor";
import {
  getRouteGraph, BYPASS_EDGE, MOUNTAIN_EDGE, type PolyRouteEdge,
} from "./world/routegraph";
import { spawnZ } from "./world/ramps";
import { stepPhysics, freshCarState, type CarState, type DriverInput } from "./physics";
import { collidePlayer } from "./collide";
import { buildPlayerCar, type PlayerRig } from "./player";
import type { CockpitModelHandle, MirrorFraming } from "./cockpitmodel";
import { COCKPIT_REF, EYE as COCKPIT_EYE, GLASS_REST, WIPER, type GaugeFlags } from "./cockpit";
import { Traffic, setNpcDaylight } from "./traffic";
import { GameAudio } from "./audio";
import { MusicPlayer } from "./music";
import { hitScreen, type ScreenAction, type ScreenView } from "./carscreen";
import { bindGameTally, gameClick, gameTally } from "./consolegame";
import { RainFX, SmokeFX } from "./fx";
import { PostFX } from "./post";
import { drawMiniMap, type MiniMapOpts } from "./minimap";

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
  /** Enter/leave photo mode. Owned by the UI for the same reason pauseRequest
      is: photo mode IS a pause (setRunning(false), the sim frozen) plus a
      screen change (every piece of HUD chrome is gated on `playing`), and
      both of those live in GameApp. The engine only asks; photoEnter/photoExit
      are what the UI calls back into once the screen has flipped. */
  photoRequest(): void;
}

/** How many NPCs are fed to the audio doppler pool each frame — its pool size.
    The horn and chirp one-shots build their own nodes, so they are not in
    contention with these and there is nothing to hold back for. */
const NPC_VOICES = 8;

/** No Hesi scoring loop (see noHesiUpdate/traffic.ts's scoreEvents). SPEED +
    NEAR MISSES build score; contact resets the multiplier, never the total —
    this is a running arcade score for the drive, not a life. */
const NOHESI = {
  /** minimum speed, m/s, for either scoring or combo decay to apply at all —
      crawling through a jam should not slowly leak the multiplier */
  speedFloor: 12,
  /** points/second at combo x1 and speedFloor+1 m/s, roughly — points ≈
      speed * combo * this * dt */
  pointsScale: 9,
  /** combo growth per near-miss event, scaled by its closeness grade (0..1
      from traffic.ts) — a graze at the grading floor barely moves it, a
      genuinely tight one moves it a lot */
  comboStep: 0.4,
  comboMax: 8,
  /** seconds without a near-miss before the combo starts bleeding off, and
      the rate (combo units/s) once it does */
  decayAfter: 4, decayRate: 0.35,
  /** only grades above this trigger the toast pulse — every near-miss counts
      toward the combo, but not every one is worth a popup */
  pulseGrade: 0.45,
  pulseBase: 250, pulseCd: 1.1,
};

/** Drive statistics (see statsUpdate / the STATS panel in GameApp.tsx). One
    accumulator object folded from values the frame already computes — the
    car state, the No Hesi feed, the crash gates — so the whole feature costs
    a handful of compares per frame, no listeners, no allocation. */
const STATS = {
  /** below this |u| (m/s) the car is standing, not driving — time driven and
      distance both gate on it so idling at a menu-adjacent red light doesn't
      pad the clock */
  moveFloor: 0.5,
  /** seconds between route-graph probes for the mountain-pass run detection.
      surfaceAt() is bbox-rejected and cheap, but it allocates its hit — at
      2 Hz that is noise; per frame it would not be. */
  routeEvery: 0.5,
  /** fraction of the pass's arclength a visit must span to count as a run —
      loose enough that probe quantisation at the gore tapers can't eat a
      genuine full traversal, tight enough that a U-turn halfway can't count */
  mtnSpan: 0.85,
  /** seconds off the pass pavement before a visit closes — one probe landing
      on the runoff apron mid-drift must not split a run into two halves */
  mtnGrace: 1.5,
};

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

/* touchHolds key for the steering-wheel hub horn. Not an element id — the hub
   is a painted disc with pointer-events:none and no listeners of its own; the
   wheel's existing handlers do the hit test — so it needs a name that cannot
   collide with a real puck's getElementById id. */
const WHEEL_HORN_HOLD = "swheelHub";

/* Camera modes. CAM_POV is the hard-mounted dashcam: it shares the cockpit's
   rendering (interior shell visible, mirror and gauges live) but none of its
   head physics — a bracket bolted over the dash does not lean into corners,
   crane to look back, or breathe under braking. CAM_CONSOLE is a second
   bracket, on the tunnel between the seats, and is rendered the same way.

   These are NOT in cycle order any more; see CAM_CYCLE below. */
const CAM_CHASE = 0, CAM_COCKPIT = 1, CAM_HOOD = 2, CAM_POV = 3, CAM_CONSOLE = 4;
const CAM_BACKSEAT = 5;
const CAM_COUNT = 6;
const CAM_NAMES = ["CHASE", "COCKPIT", "HOOD", "DASHCAM", "CONSOLE", "BACKSEAT"];
/* CYCLE ORDER IS NOT NUMERIC ORDER, and the split is deliberate.

   AGENTS.md requires the dashcam to be LAST in the cycle — it is the view the
   game ships in, and C from CHASE should always walk toward it. But camMode is
   PERSISTED: settings.ts defaults it to 3 and every saved profile holds a
   number, so renumbering the dashcam to make room for a new view would boot
   every existing player into whatever took index 3. CAM_CONSOLE therefore takes
   the free index at the end and the cycle walks this table instead of
   incrementing, which keeps both promises at once. CAM_NAMES stays indexed by
   camMode, not by cycle position. CAM_BACKSEAT takes the next free index for
   the same reason, and slots into the cycle just before the dashcam so the
   walk still ends on the view that ships.

   Anything not in the table (a hand-edited profile) falls to CHASE on the next
   press rather than sticking. */
const CAM_CYCLE = [CAM_CHASE, CAM_COCKPIT, CAM_HOOD, CAM_CONSOLE, CAM_BACKSEAT, CAM_POV];
const nextCam = (m: number) => CAM_CYCLE[(CAM_CYCLE.indexOf(m) + 1) % CAM_CYCLE.length];

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
/* Mount height when the IMPORTED interior is in, 14.5 cm below the procedural
   one. The two want different lens heights and neither value works for both:
   the procedural pad is shallow, and dy -0.03 is what clears it (all the
   framing notes above were fitted at that height). A donor dash has real
   depth, so from the same mount the lens looks down onto it from too far above
   and reads as a camera on a pole rather than one stuck to the glass. Tied to
   which interior is actually VISIBLE rather than picked globally, and that
   split has to stay now that the cabin is a property of the selected car:
   these numbers are the Volvo's seating position and POV_MOUNT.dy is kaze's,
   and on mobile-base even the Volvo drives the procedural one. The value
   itself is unchanged — it cost a long argument to settle and none of this
   re-opens it.

   THIS IS THE SEATING POSITION, and it is squeezed from both sides. In
   cockpit-local metres the lens sits at y = EYE.y + this = 1.175, with the
   road at y 0 and the donor's roof at 1.42 — so it is a real driver's eye
   height in a real S90, not a camera on a mast. What bounds it:

   - LOWER hides the road. The dash pad's forward top corner is at (y 1.07,
     z 1.12) and the lens is at z 0.31, so the pad occludes everything below a
     shallow line over it. At 1.20 the road showed in a 12.3% band of frame
     height under the horizon; at 1.175 that band is 10.0%; by 1.10 it is 3%
     and the view is dash and sky.
   - LOWER also hides the cluster behind the wheel. The rim top is at (y 1.053,
     z 0.60), between the lens and the dials. The sightline that grazes it
     lands 60% of the way up the cluster face at 1.20 and 68% at 1.175 — the
     rim is a thin ring and you read the gauges through it, but keep dropping
     and it walks over them. The lit cluster is the point of this view.
   - LOWERING THIS WAS A MISTAKE, twice over. It was walked -0.15 -> -0.175 ->
     -0.24 -> -0.27 on reports of the view being too high, but those reports
     were about CAM_COCKPIT, which at the time had no height offset of its own
     and so could not be lowered separately. The dashcam was dragged down for a
     complaint that was never about it. Reverted to -0.15; CAM_COCKPIT carries
     its own dy now (COCKPIT_EYE_IMPORTED), which is where that correction
     belonged all along. Do not lower this one on a report that does not name
     the DASHCAM specifically.

   THE BOUNDS ABOVE ARE FROM THE RETIRED ASSET AND ARE NOT GOSPEL. They were
   measured against the frustum-CUT dash, whose pad was the only cabin geometry
   that existed; the shipped interior is unclipped and brings a seat, floor,
   headliner and rear bench, so what fills the frame at a given eye height is
   not what filled it then. "By 1.10 the view is dash and sky" is a reading
   taken on a different object. Trust the reported frame over the numbers here
   until someone re-measures them on the current asset.

   Live knob because the numbers above bound it but do not pick it, and picking
   it needs eyes on the frame: `window.__povMount.dy = -0.28` re-frames on the
   next frame with no reload, the same pattern as window.__povTune in post.ts.
   If a value is settled on there, bring it back HERE — and move
   cockpitmodel.ts's MIRROR_NUDGE.y by the same amount, or the mirror leaves
   the top of frame. */
const POV_MOUNT_DY_IMPORTED = -0.15;
/* Where the lens sits for the imported interior, relative to POV_MOUNT.

   dx/dz are DELTAS on POV_MOUNT.dx/dz — zero is "unchanged" — while dy is the
   absolute replacement above, because that is what POV_MOUNT_DY_IMPORTED
   already was and rewriting it would silently move a tuned number.

   dz exists because the shipped interior is NOT frustum-clipped and therefore
   has a real driver's seat (roles `seats`, z -0.286..0.598, headrest y 1.327)
   where the retired cut dash had empty space. The lens at z ~0.31 / y ~1.175
   lands inside that volume. See povMount() for the full account. */
const POV_MOUNT_DELTA = { dx: 0, dy: POV_MOUNT_DY_IMPORTED, dz: 0 };
/* CAM_COCKPIT's offset with the imported interior up — see cockpitEye().

   dz 0.30 lands the eye at z ~0.0: 0.3 m ahead of the seat backs (z -0.29),
   0.5 m short of the wheel rim (z 0.485..0.718) and 0.56 m behind the wheel
   hub, which is a real driver's head rather than a chin on the airbag.

   IT WAS 0.55, and the OEM mirror is what moved it. This view now shows the
   donor's own mirror housing (cockpitmodel.ts, framing "cabin"), which hangs
   on the centreline at (x 0.008, y 1.308, z 0.437) while the driver's eye is
   out at x 0.36 — so the eye's DEPTH is the whole of what decides whether the
   mirror is on screen. At dz 0.55 the eye sat at z 0.25, a 0.19 m gap against
   a 0.35 m lateral offset: 62 degrees off axis, against a 49.6-degree half
   frame at the default 67-degree FOV on 16:9. The mirror was not merely badly
   framed, it was outside the frustum, and no amount of FOV brought it back
   (100 degrees, the slider's maximum, only reaches 64.7). At dz 0.30 the gap
   is 0.44 m, the angle is 38.9 degrees, and the glass sits around 79% of the
   way across the frame — near the edge, which is exactly where a real mirror
   sits in a wide-angle in-car shot, but wholly in shot.

   dy -0.10 because this camera had NO imported-interior height offset at all:
   it sat at the procedural COCKPIT_EYE.y while the dashcam beside it had
   already been dropped twice for being too high. Same complaint, same cabin,
   so it inherits the correction rather than being left as the one interior
   view nobody could lower. */
const COCKPIT_EYE_IMPORTED = { dy: -0.14, dz: 0.30 };
/* CHASE camera "sensation" effects, as one multiplier: head-spring bob, the
   G-lean roll, and the speed FOV kick. Reported as unwanted wobble in third
   person, so it ships at 0. Live: `window.__chaseShake = 1` restores it. */
const CHASE_SHAKE = 0;

/* EXPERIMENTAL centre-console camera (CAM_CONSOLE): a wide lens on the tunnel
   between the seats, looking forward. Hard-mounted like the dashcam — it is a
   bracket on the console, not a head — so it takes no lean, no lookahead and no
   look-back.

   Read straight out of the donor manifest rather than guessed, in the same
   cockpit-local metres everything else here uses (public/models/cockpits/
   volvo-s90-full.json, and note y is stated absolutely, like COCKPIT_EYE.y —
   the P.belt term is added at the mount site so it tracks a taller or lower
   car):

   - x 0. The console (`shell_0`) runs x -0.136..0.131 and the two front seats
     start at x 0.115 and -0.121, so the centreline is the only clear channel
     between them.
   - z -0.05. "Back where the centre console is": the console spans z
     -0.244..0.815 and the seat backs are at z -0.29, so this sits over the
     armrest end of it, level with the driver's shoulder — 0.36 m behind the
     dashcam lens and 0.05 m behind the cockpit eye.
   - y 1.22, and this is the number that decides whether the view is usable.
     The dash pad's ridge is at (y 1.072, z 1.118) and the lens is 1.17 m
     behind it, so the sightline that grazes that ridge is nearly flat and
     everything nearer than where it lands is hidden dash. That distance moves
     brutally fast with height: 46 m at y 1.10, 17 m at 1.15, 9.6 m at 1.22,
     8.2 m at 1.25. Below ~1.15 the near road is simply not in the shot. 1.22
     is a hair over the driver's own eye at 1.21 and leaves the mirror body
     (y 1.270..1.346) above the lens rather than across it; going much past
     1.25 walks into it, and the headliner is at 1.375.
   - fov 78 vertical, which is ~110 degrees horizontal at 16:9 — against ~99
     for the 67-degree default and ~105 for the dashcam, so it is the widest
     lens in the car, which is the point. It is a BASELINE, not a fixed lens:
     consoleFov() reads it as the framing this camera has when the Field of
     view slider is at its default and shifts it BY the slider's degrees from
     there — additive, not scaled, so its constant +11-degree-wider-than-the-
     dashcam feel holds across the whole range instead of running away at the
     top of it. Its own number so an experimental view can sit wider than the
     shipping one; still on the slider, because the slider is the user's
     setting and a camera the setting cannot move is a setting that does not
     work.
   - tilt 0.02 rad of nose-down, nominal. The dashcam needs 0.227 because it has
     to rake the cluster into frame from above it; this one sits behind and
     level with the dash and does not.

   Live knob, same pattern as __povMount / __cockpitEye — `window.__consoleCam.z
   = -0.1` re-frames on the next frame — because this is the view whose whole
   point is being moved around. Settled values come back here. */
const CONSOLE_CAM = { x: 0, y: 1.22, z: -0.05, fov: 78, tilt: 0.02 };

/* Backseat camera (CAM_BACKSEAT): a passenger's phone held up from the rear
   bench, looking forward past the front headrests and out the windscreen —
   the "night drive vlog" frame. Player-facing (AGENTS.md 2026-08-28: every
   camera ships), so it is framed to be looked at, not to debug from.

   The rear bench is real geometry in BOTH interiors: cockpit.ts builds it
   (squab z -1.02, backrest z -1.24, headrests x ±0.36 / y 1.22, parcel shelf
   z -1.5) outside any merge region, so the donor swap keeps it, and the donor
   brings its own rear doors/roof back to z -1.95 on top. Nothing here is
   framing a hollow shell.

   Like the other two in-car brackets this is a rigid mount — body motion
   only, no head springs, no look-back. Every number below was picked off
   real frames (headless night runs, tunnel/bypass/town), not computed:

   - x 0: the MIDDLE seat. Behind either outer seat the seatback in front
     owns most of the frame as an unreadable black mass (measured: at
     x -0.30 the passenger seatback covered two thirds of the shot), and a
     yaw big enough to see past it points the lens at a door card. From the
     centre the two seatbacks become bookends instead of obstructions, and
     the lit console runs a leading line down the middle of the frame.
   - y 1.30: OVER the front seat shoulders, under the headliner (1.375).
     At passenger chest height (1.18) the windscreen is a slot a few
     degrees tall between the seats; at 1.30 the lens clears the seatback
     tops, and road, mirror and both headrests compose in one band across
     the frame. The rear headrests (y ~1.28, z -1.3) stay just behind and
     below the lens.
   - z -1.10: knee line of the bench (squab z -1.02, backrest z -1.24) —
     far enough back that both headrests stay in frame as silhouettes,
     far enough forward that the C-pillars do not crowd the sides.
   - fov 72: a phone main lens, a hair wider than the dashcam's 67 default,
     read the same additive way — see backseatFov().
   - tilt 0.04 of nose-down settles the horizon and keeps the road band
     under the mirror rather than behind it.
   - yaw 0: shipped straight. The field exists because this is the one
     bracket whose whole point is a framed COMPOSITION, and off-axis
     variants (the "phone aimed across the cabin" look) are one knob write
     away for anyone tuning — positive yaw looks toward the passenger side.

   Live knob, same pattern as __consoleCam — `window.__backseatCam.y = 1.2`
   re-frames on the next frame. Settled values come back here. */
const BACKSEAT_CAM = { x: 0, y: 1.30, z: -1.10, fov: 72, tilt: 0.04, yaw: 0 };

/* ---------------------------------------------------------- cabin lighting --

   What is allowed to light the inside of the car, and how much of it.

   The reference the night look is tuned against is a real dashcam capture, and
   measured off it the cabin has exactly two values: near-zero everywhere (dash
   face 6/255, door card 19/255, A-pillar 0/255, wheel rim 4/255) and a warm
   grazing band along the pad crest at 82/255 where the glass lets outside light
   in. Nothing lights it from inside. Shape comes from the silhouette and that
   one highlight; the only other things in the frame are emitters — cluster,
   head unit, accent strips.

   So the two fill sources are switched OFF by default and live on the I key:

     dome   the procedural cabin's warm header lamp (cockpit.ts CABIN_DOME) and
            the donor's equivalent (cockpitmodel.ts DONOR_FILL), which stands in
            for the accent strips the donor's own door cards displace. One
            number drives both — they are two builds of the same fixture, and
            letting them drift would make the J comparison meaningless.
     glass  the standing "city light through the glass" point light
            (cockpit.ts GLASS_REST), which is OUTSIDE light and is NOT on the
            switch — it is the crest highlight, i.e. the one thing the reference
            actually has. lampWash() rakes it front-to-back under every
            streetlight; this is a multiplier on top of that whole envelope.
     glassHex  its resting colour. GLASS_REST is a cool 0xbfd0ff, which reads as
            city light between lamps; the reference's crest is distinctly warm
            (82,70,52) because what is actually coming through the screen there
            is headlight spill off the road. Exposed as a knob rather than
            changed, because lampWash already carries it to sodium under every
            lamp and the between-lamps hue is a taste call for the user's eyes.

   `on` mirrors the I key so the console can force any state, and because
   `DOME_LEVELS[on] * dome` is the effective level it also buys a residual:
   set on = 2 and dome = 0.15 for "not off, just very low" without touching
   the key.

   It is a THREE-WAY CYCLE, not a flip: off -> dim -> full -> off, both from
   the key and from the console click, so the two can never disagree about
   which of the three the cabin is in. Reported as wanting a dimmer option
   between pitch-black and full CABIN_DOME rather than only the two ends.

     window.__cabinLight.on = 2          // full, as two presses from off
     window.__cabinLight.dome = 0.3      // a dimmer ON state
     window.__cabinLight.glass = 1.6     // more crest sheen, cabin still dark
     window.__cabinLight.glassHex = 0xffd0a0   // warm it toward the reference

   `hover` is the discoverability term, and it is the dome light being used as
   its own affordance. Resting the cursor on the overhead console eases the
   lamp this fraction of the way toward the level a CLICK would produce —
   the next stop around the off/dim/full cycle — then eases back when the
   cursor leaves. Reported as "idk where to click", and this is the answer that
   suits the geometry: the console is the donor's own moulded ceiling panel and
   its material is shared with the floor and the mirror holder, so there is
   nothing there to make glow without lighting three unrelated parts, and a
   fresh emissive plate stuck to the roof would read as a UI overlay pasted
   into the cabin rather than as a control.

   Previewing the OUTCOME dodges both. It needs no new geometry and no second
   light (a light joining the scene's list re-hashes every lit material in the
   cabin — the note on setCabinLight in cockpit.ts), it is by construction
   visible in a cabin that ships pitch dark, it cannot blow to white because it
   is a fraction of a level that was already tuned, and it explains itself: the
   thing under the cursor visibly drives the thing the click switches.

   Symmetric on purpose. A lift-only version would answer "where do I turn it
   on" and leave "where do I turn it off" exactly as lost as before.

     window.__cabinLight.hover = 0.35    // a stronger tell while hunting for it
     window.__cabinLight.hover = 0       // off; the I key still works */
const CABIN_LIGHT = { on: 0, dome: 1, glass: 1, glassHex: GLASS_REST.color, hover: 0.22 };
/** Brightness fraction of CABIN_DOME/DONOR_FILL at each stop of the `on`
    cycle — off, dim, full. Indexed by `on` directly, so DOME_LEVELS[k.on] is
    the level a click would leave the lamp at from wherever it rests now. */
const DOME_LEVELS = [0, 0.4, 1];
/* Rate the hover preview eases at, per second, as an exponential time constant
   — about 0.2 s to settle either way. It is a fade rather than a step because
   every other light in this file is: a cabin that snaps between two levels as
   the cursor crosses an invisible edge reads as a glitch, and at this size the
   swell IS most of the signal that something is under the cursor. */
const CABIN_HOVER_EASE = 11;

/* ------------------------------------------------------------------- fog ----

   Night fog used to sit on 0x03040a, which is invisible by construction: fog
   blends a fragment toward the fog colour, and blending near-black geometry
   toward near-black does nothing at any density. Reported as "the game said we
   added fog but i dont see any" — correct, and it was never a density problem.

   Real night fog near a city is lit by the light pollution under it. Measured
   off the reference capture the haze at the road's vanishing point is
   (62,50,32) — a warm grey-brown, 3.6x brighter than the sky above it — and the
   far road silhouettes AGAINST it rather than fading into black.

   The shipped colours are solved backwards through the composite and the POV
   degrade (post.ts) rather than picked by eye, and the answer is a long way
   from where intuition puts it, in two ways:

   - LEVEL. The ACES toe at the night exposure (0.98) costs about 3.7x on its
     own, and the dashcam crush then takes a flat 0.06 off before a >1 gamma.
     A fog colour with the reference haze's own linear luminance renders at
     (11,4,1) — still black. 0x5f5a4b is what actually lands on (52,42,27).
   - SATURATION. The crush and the per-channel gamma (1.18/1.24/1.22) massively
     AMPLIFY saturation down in the shadows, which is the mirror image of the
     rule the lamp colours follow up in the highlights (where the grade
     desaturates and a source has to be pushed further toward yellow than its
     target). Down here the source has to be pushed the other way: 0x5f5a4b is
     almost neutral — (95,90,75) — and arrives warm.

   Rain night is lifted the same way but left greyer: wet air scatters the
   whole spectrum, so the brown goes out of it.

   DECOUPLED FROM THE CLEAR COLOUR, which is new. The two used to be the one
   value, and the note that used to sit here — "the clear colour comes off this
   same value, so the horizon has to go with it" — is exactly why the fog could
   never be lifted. They want opposite things: fog is the veil in FRONT of
   things and has to be brighter than what it veils, while the clear colour is
   the void BEHIND everything and has to be black or it prints as a flat plate
   wherever the sky dome does not cover. So sky* below carry the old fog values
   verbatim, and the clear colour in the frame is byte-for-byte what it was.
   `__fog.sky = __fog.night` re-couples them if that turns out to be wrong.

   Live, read fresh every frame:
     window.__fog.night = 0x4a463a    // dial the haze down
     window.__fog.density = 1.4       // thicker, without touching the setting
     window.__fog.sky = 0x5f5a4b      // re-couple the clear colour to the fog */
const FOG_TUNE = {
  /* 0x5f5a4b was the first cut and it came out YELLOW on nearby buildings.
     The maths: fog is most of what you see over UNLIT geometry, because the
     surface contributes almost nothing of its own. A dark building at 150 m
     sits under ~14% fog, but 14% of a saturated colour over near-black is not
     a tint — it is the whole read, so the building becomes the fog rather than
     being veiled by it. R95 G90 B75 has a 20-point red-to-blue spread, which
     is plenty to show as yellow once it is the only thing there.

     Halved to a 6-point spread: still warm, still city-glow rather than
     moonlight, but no longer able to paint a building. Distant haze barely
     changes — at 400 m the fog is thick enough that saturation reads as
     colour temperature instead of as a hue. */
  night: 0x565550,
  rain: 0x626057,
  sky: 0x03040a,
  skyRain: 0x171b26,
  density: 1,
};

/* The other half of that fog lift — see carenv.ts setCarEnvLift for why the
   player's car went black when the haze behind it came up, and why the fix is
   the env rather than a light.

   `night` is the multiplier on every car material's env reflection at full
   night; it fades to 1 (authored values, untouched) by full day on the same
   shaped curve the ambient and hemi use, so daylight is byte-for-byte what it
   was. The paint is metallic (procedural: metalness 0.88 at envMapIntensity
   1.3; the donor's Car_Paint: metalness 1.00) so almost all of its read is env
   specular, and at 1x that lands roughly ten times below the fog it is seen
   against.

   IT WAS 3, AND FOR MOST OF THAT TIME IT WAS POINTING AT THE WRONG CAR. The
   lift only ever reached materials registered with carenv, and until
   player.ts's lightDonorBody() only the PROCEDURAL body was — which is hidden
   whenever the imported Volvo shell is up, i.e. by default. The car actually on
   screen in CHASE had no envMap at all and, being metalness 1, no diffuse term
   either, so it rendered at very near zero however far this was turned up.
   That is the "impossible to see the car" report, and the full account of it is
   in the block above lightDonorBody().

   5 now that it lands on the car being looked at. Two things let it go past the
   old ceiling, and neither is "turn it up and hope":

   - carenv.ts weights the amount ABOVE 3 by material roughness. What used to
     bite first was the near-mirror trim — the glazing (envMapIntensity 1.7 at
     roughness 0.05), the mirror caps (1.6, 0.03), and now the donor's Chrome
     (0.038) and Black_Glossy (0.032) — reflecting the HDRI's lamps nearly
     sharply and going white past the ACES knee. Those take none of the extra;
     the panels it is meant for take all of it.
   - the donor's mirror clearcoat is floored to the procedural paint's 0.06 and
     wears player.ts's tameSpecular knee, so a hot reflection compresses with
     its hue rather than clipping.

   Live: `window.__carEnv.night = 8` re-lights the bodywork on the next frame,
   `= 3` puts it back where it was. THE CAR IS NOT ON SCREEN IN THE DASHCAM, so
   nothing here can be judged from it — the exterior group is hidden whenever
   the camera is inside the car, in the mirror pass as well as the main one.
   Judge it from CHASE. */
const CAR_ENV = { night: 5 };

/* Chase framing. Both numbers were literals inside updateCamera(); they are up
   here so they can carry their reasoning and take a live knob.

   `dist` is the STANDOFF BEFORE the car-length term, not the whole distance —
   the camera sits at `dist + L * 0.25` metres back, plus up to another 0.9 m
   that the speed term adds, so a longer car is framed the same way a short one
   is. On the Kaze (L 4.42) that is 4.11 m at rest against the 4.86 m it used
   to be: ~15% closer, asked for as "a bit closer". Everything downstream is
   derived from it rather than fixed — the trail cap at dist + 1.2 and the
   minimum swing radius at dist * 0.6 both follow it in — so moving this one
   number does not need three others moved with it.

   `height` is the camera's own height above the car's contact point. It is
   unchanged: the aim point sits 2.8 m PAST the car, so pulling the camera in
   by 0.75 m steepens the look-down by less than a degree, and there is nothing
   here for the height to correct.

   Live: `window.__chase.dist = 2.6`. The menu/intro orbit seeds and the reset
   snaps keep their own hard-coded 4.4 m and are deliberately NOT on this knob:
   they are one-frame starting points that the spring eases into whatever this
   says within about half a second, and pinning them to it would drag the menu
   framing around with a gameplay setting. */
const CHASE_CAM = { dist: 3, height: 2.15 };
/* How fast the chase camera's terrain floor (updateCamera, chasePos.y) eases
   up when the ground rises under it, in 1/s. The floor used to be a hard
   Math.max — an instant teleport onto the rising terrain height the moment it
   overtook the trailing camera, a one-frame pop on every ramp that read as
   "shake" even with CHASE_SHAKE and CHASE_FX both at 0. This is the time
   constant of the lerp that replaced it: ~0.1 s to close the gap, fast enough
   that the camera does not linger visibly under the road surface on a normal
   ramp, but no longer an instant snap. */
const CHASE_FLOOR_EASE = 10;

/* ------------------------------------------------------------ roof tap ----

   Where a FINGER has to land to work the interior light, as fractions of the
   canvas: the top `top` of the frame, within `half` of the centreline.

   It is a screen-space region and not a hit volume, and that is forced rather
   than chosen. The overhead console — the volume the mouse clicks and the
   hover previews — sits at a slope of about 0.78 above the dashcam lens, while
   the top of the dashcam frame is at 0.37 (0.55 on a portrait phone, where
   POV_V_CAP opens the vertical up). It is off the top of the shipping view
   entirely, so on a phone there is no pixel whose ray could reach it, however
   fat the finger or however padded the box. The request was "press on the top
   middle part of the car", and in the frame the player is actually looking at,
   the top middle IS the roof. So that is the target.

   0.20 x ±0.28 is 20% of frame height by 56% of its width. Sized against what
   else is up there: nothing. Every touch control is a fixed DOM element at the
   bottom (the steering puck/wheel, throttle, brake, CAM, LTS, HORN) and takes
   its own pointerdown before the canvas ever sees one; the only thing at the
   top is #gearBtn, in the right corner at right:12 — outside ±0.28 of centre on
   any aspect a phone has, and an element of its own besides.

   Live, because how big a tap target wants to be is a thing you find out with
   a thumb: `window.__roofTap.top = 0.3` widens the band, `.top = 0` turns the
   gesture off without touching the mouse path. */
const ROOF_TAP = { top: 0.2, half: 0.28 };
/* Ring of extra rays a touch tap fires around the contact point, in units of
   TAP_PAD_PX — for the views where the console IS in frame (COCKPIT, CONSOLE)
   and the tap should land on the real switch rather than on the band. */
const TAP_RING: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const TAP_PAD_PX = 22;

/* ---------------------------------------------------------------- hood ----

   The donor's bonnet, shown from inside the car. All of the geometry work and
   the measurements behind it are in player.ts's attachHood(); this is only the
   switch and the nudge.

     on   1 shows it (whenever the donor cabin is up), 0 takes it out of frame
     dy   lift, metres. The hood clears the dash's sightline by 1-3 cm from
          the dashcam mount, so this is the knob that decides whether it reads
          as a bonnet or as a suggestion of one. It also has to move whenever
          POV_MOUNT_DY_IMPORTED does, in the same direction — the eye going
          down hides the hood as surely as the hood going down does.
     dz   forward/back, metres. Wants to be 0: the hood sits in the donor's own
          coordinates and the cowl is where the donor put it. Here because a
          nose that reads too close is a thing you fix by eye, not by argument.

     window.__hood.dy = 0.03   // lift it a visible band into frame
     window.__hood.on = 0      // back to no hood at all

   Settled values come back here. */
const HOOD = { on: 1, dy: 0, dz: 0 };
/* How fast the wipers lay down once the rain stops, as an exponential time
   constant per second — about 0.5 s to arrive. See the park block in frame(). */
const WIPER_PARK_EASE = 6;
/* Wiper drive. The mode cycles OFF → INT → LO → HI, and three ways in step
   it — the U key, the stalk click zone beside the head unit, and the touch
   drawer's WIPERS row (uiKeyTap "u") — all through cycleWipers(), so they
   can never disagree.

   RATE is sweep travel per second for a half-stroke (park→raised or back),
   so a full LO wipe takes 2/1.15 ≈ 1.74 s — deliberately the period of the
   old always-on rain wiper (sin at 3.6 rad/s), which is the pace the whole
   droplet overlay was tuned against. HI is roughly double. INT sweeps at LO
   pace and then sits parked for PAUSE seconds: the classic intermittent
   rhythm, one confident stroke and a wait just long enough to make the next
   one read as an event. Indexed by mode; index 0 is unused (OFF animates in
   the park branch, not here). */
export const WIPER_MODE_NAMES = ["OFF", "INT", "LO", "HI"] as const;
const WIPER_RATE = [0, 1.15, 1.15, 2.2];
const WIPER_INT_PAUSE = 2.6;
/* How fast the rear-view's electrochromic dim arrives, same exponential form
   as the park ease — a real auto-dim cell takes a second or two, and an
   instant step on a surface that bright reads as the render target
   glitching, not as a control answering. */
const MIRROR_DIM_EASE = 2.2;
/* How the loading bar creeps through a wait it cannot measure — see
   Game.creepAwait. CREEP_CAP is deliberately short of 1: the stage's own
   completion is what finishes it, and a bar that reaches the end of a stage
   before the stage does has lied about the only thing it is for. CREEP_MS is
   well under the ~4 ms a 400 px bar needs to move one pixel's worth of a
   stage, and runStages rounds to whole percent before touching the DOM. */
const CREEP_CAP = 0.9;
const CREEP_MS = 120;

/* ----------------------------------------------------------- cabin vibe ----

   How hard the road buzzes the COCKPIT eye. See the road micro-vibration block
   in updateCamera() for what the noise is and why it is keyed off position
   rather than time — none of that changes here; this is only how much of it
   reaches the eye.

     amp   overall scale. 1 is the level as built; 0.65 is where it is now,
           reported as "that interior view has shakiness sometimes when you're
           at high speed, can you just lower it, just a nudge". 0 is off.
     pow   the speed exponent. 2 as built.
     slip  the tyre-slip term's share, which is what buzzes it in a slide
           rather than on a straight.

   AMPLITUDE IS THE LEVER, NOT THE EXPONENT, and the arithmetic is worth
   writing down because it reads the other way round. spN is speed NORMALISED
   to 1 at ~180 km/h, so spN^n is 1 at the top whatever n is: lowering the
   exponent cannot take the top off, it only lifts the middle. At 100 km/h,
   spN^1.5 is 0.352 against spN^2's 0.262 — 34% MORE buzz, with the 180 km/h
   peak untouched. Since the complaint is specifically about high speed, the
   exponent is the wrong knob and 0.65 on the amplitude is the right one: peak
   y jitter goes from ±1.70 mm to ±1.11 mm and the curve keeps its shape, so
   the road still reads as road and the top is a third quieter.

   RAISING pow is the version that shapes rather than scales — spN^3 keeps the
   peak and empties the 100-140 km/h band — and is here for that, if 0.65
   turns out to have taken too much out of the cruise.

     window.__cabinVibe.amp = 0.4    // quieter still
     window.__cabinVibe.amp = 1      // back to as-built
     window.__cabinVibe.pow = 3      // same peak, calmer mid-range

   Settled values come back here. */
const CABIN_VIBE = { amp: 0.65, pow: 2, slip: 1 };

/* ------------------------------------------------------------- chase fx ----

   "For the third-person view, remove the shakiness and camera effects totally.
   Like just remove them. They're so bad."

   All three ship at 0. What each one was, and why it counted as an effect
   rather than as the camera doing its job, is at its own site in the chase
   branch of updateCamera():

     lag        the lateral trailing lean. An UNDERDAMPED spring (ratio 0.61)
                that overshot and rang after every corner. This was the shake.
     aimSwing   the aim point sliding sideways with the steering ANGLE, which
                on a keyboard snaps between stops and jerked the view with it.
     speedPull  the camera easing up to 0.9 m further back with speed. Never
                shook; removed for consistency with the FOV speed kick, which
                CHASE_SHAKE already zeroes in this view.

   WHAT IS DELIBERATELY NOT ON THIS KNOB, because it is the camera FOLLOWING
   the car and a camera welded rigidly to a car looks worse, not better:

   - the position ease onto the ideal chase point (5.5/s) and the aim ease onto
     the look point (9/s). Both are first-order — they approach and stop, they
     cannot overshoot and cannot ring. Take these out and the camera becomes a
     rigid boom: every kerb strike and every steering input is transmitted to
     the frame at full amplitude, which is the opposite of what was asked for.
   - the trail-length clamps, the minimum radius, and the terrain height floor.
     Those stop the camera stretching away at speed, cutting through the car
     mid-swing, and sinking into the deck.
   - revCam, the swing to the front of the car when genuinely reversing. A
     feature with its own trigger and hysteresis, not a motion applied to a
     view that was otherwise still.

   The chase camera also never took the body's pitch or roll — it looks at a
   world point, and `lookAt` levels the horizon — so there was nothing of that
   kind here to remove. The car pitching and rolling IN FRAME is the car doing
   it, not the camera.

     window.__chaseFx.lag = 1        // the old trailing lean back
     window.__chaseFx.speedPull = 1  // the old pull-back with speed

   Settled values come back here. */
const CHASE_FX = { lag: 0, aimSwing: 0, speedPull: 0 };

/* ---------------------------------------------------------- cam smooth ----

   How much the DASHCAM's yaw is allowed to lag the car's heading.

     pov   the lag's time constant, in seconds. 0 restores exact tracking
           bit for bit — povYawUpdate() short-circuits on it and writes
           nothing.
     max   the most the lens may ever sit off the nose, in radians.

   A DELIBERATE DEPARTURE FROM "HARD-MOUNTED", and it is written down here so
   the next person does not read AGENTS.md and correct it back. A real bracket
   yaws exactly with the car, which is why this view was built with
   `rotation.y = car.h + PI` and nothing else. Then 432a53d flattened the
   keyboard steer-rate droop for test mode and a full-lock reversal at speed
   went from ~1.18 s to ~0.5 s. The camera was faithfully reproducing all of
   it: "if there's any aggressive turning ... can you move the camera a bit
   less aggressively? it's a bit overwhelming, just a tad bit. I notice it when
   I'm jerking left to right a lot."

   A FIRST-ORDER LAG IS ALREADY RATE-SCALED, which is why there is no separate
   rate term. The offset a lag produces is the yaw rate times its time
   constant, so it is proportional to how fast the heading is actually moving:
   at 0.06 s a stock corner (r ~ 0.3 rad/s) trails by 1.0 degrees, which is
   nothing, while a test-mode flick (r ~ 1.5-2) trails by 5-7 and gets clamped
   to `max`. It takes the top off a whip and leaves ordinary steering alone,
   with no mode in it and no threshold to tune.

   ALWAYS ON, not test-mode only. The whip is the same phenomenon at stock
   steering, just smaller — and the scaling above means the correction is
   smaller with it, automatically. A camera that changed how it followed the
   car when K was pressed would be a second surprise on top of the first.

   CAM_POV ONLY. CAM_COCKPIT is a head, not a bracket: it has springs and its
   own eased lookahead already, and a lag on top would be two filters arguing.
   CAM_CONSOLE is a rigid mount with the same whip, but AGENTS.md rates it
   debug-only and this is a feel change for the view that ships.

   It settles to EXACT tracking — that is what makes it a lag and not a
   decoupling. Steady state is zero error, so the lens cannot end up pointing
   somewhere the car is not; overdo `pov` and it reads as the view swimming,
   which is worse than the whip, so this errs light.

     window.__camSmooth.pov = 0.1   // softer
     window.__camSmooth.pov = 0     // off, exactly as before

   Settled values come back here. */
const CAM_SMOOTH = { pov: 0.06, max: 0.09 };

declare global {
  interface Window {
    __povMount?: { dx: number; dy: number; dz: number };
    __cockpitEye?: { dy: number; dz: number };
    __chaseShake?: number;
    __consoleCam?: { x: number; y: number; z: number; fov: number; tilt: number };
    __backseatCam?: { x: number; y: number; z: number; fov: number; tilt: number; yaw: number };
    __roofTap?: { top: number; half: number };
    __hood?: { on: number; dy: number; dz: number };
    __cabinVibe?: { amp: number; pow: number; slip: number };
    __chaseFx?: { lag: number; aimSwing: number; speedPull: number };
    __camSmooth?: { pov: number; max: number };
    __cabinLight?: {
      on: number; dome: number; glass: number; glassHex: number; hover: number;
    };
    __fog?: { night: number; rain: number; sky: number; skyRain: number; density: number };
    __carEnv?: { night: number };
    __chase?: { dist: number; height: number };
  }
}
/* 13 degrees of nose-down, on top of whatever the body is doing. This is what
   rakes the dial faces into the bottom of the frame instead of showing their
   top edge side-on, and it settles the horizon at ~34% down. Raising it further
   walks the whole interior up the frame and eats the road. */
const POV_TILT = 0.227;
/* Real dashcam lenses are quoted diagonally at 130-170; the useful figure is
   the horizontal one, and a typical mid-range unit is around 105. The dashcam
   used to hard-code exactly that and ignore the Field of view slider entirely,
   which meant the only view that ships was the one view the slider could not
   touch. It reads the slider now, through the four constants below.

   The slider (58..100, default 67, GameApp.tsx) is taken as a VERTICAL angle at
   16:9 and converted once into the horizontal the lens then holds constant on
   every other aspect. That hybrid is deliberate, because neither pure reading
   works on its own:

   - Read as vertical everywhere, a portrait phone at 80 would get 42 deg of
     horizontal — a telephoto slit through the windscreen — because holding
     vertical constant on a tall frame throws the width away.
   - Read as horizontal everywhere, the number on the slider would stop meaning
     what it means for every other camera, which feed it to three's vertical
     fov directly.

   Taken as vertical-at-16:9, it is literally the vertical fov on a 16:9
   screen — same as the other cameras — while off 16:9 it behaves like the
   fixed-horizontal dashcam lens it replaced, so the dash keeps the same share
   of frame width on every device and the interior framing survives rotation.

   POV_V_CAP and POV_V_FLOOR are the old 62..100 clamp, generalised. The cap
   became RELATIVE because an absolute one is what made the slider dead on a
   phone: holding horizontal constant on a 9:21 frame asks for 130-150 deg of
   vertical at every slider position, so an absolute cap swallowed the whole
   range and every setting rendered identically. At 1.25x the top of the slider
   still lands on exactly the old 100 deg, so portrait never gets WIDER than it
   is today — it just gets narrower when the slider is lowered, which is the
   point. POV_H_CEIL is new: the floor blows the horizontal out on very wide
   screens (129.8 deg at 32:9 today, wider than any interior is built to fill),
   and this bounds it. */
const POV_REF_ASPECT = 16 / 9;
const POV_V_CAP = 1.25;
const POV_V_FLOOR = 62;
const POV_H_CEIL = 118;
/* How wide the lens may go. ONE number for both interiors — the procedural
   cabin and the donor one — and that is a property of the assets rather than a
   preference:

     PROCEDURAL           built geometry — nothing was ever cut off it
     VOLVO FULL INTERIOR  whole donor nodes, decimated, never frustum-clipped

   Neither has a cut edge to walk past, so neither has anything to fear from a
   wide frame. There used to be a second, lower cap here (POV_FOV_MAX_CUT, 88)
   for volvo-s90.glb — a per-vertex frustum CUT of the same car, which printed
   torn door-card shards at both frame borders the moment the slider went past
   what it had been sliced for. That asset is out of the game (see
   COCKPIT_MODEL in player.ts) and the cap went with it.

   A clamp rather than a comment, because the slider's `max` attribute does not
   bind: settings.ts range-checks `time` on load but only TYPE-checks
   `fovBase`, so a value saved while the maximum was briefly higher survives in
   the profile forever and povFov() would honour it. This is the last gate
   before the projection matrix. The durable companion fix is a range clamp in
   settings.ts's NUM_KEYS pass, which would also catch a hand-edited profile —
   that file belongs to another agent right now. */
const POV_FOV_MAX = 100;
/* The Field of view slider's DEFAULT, mirrored from settings.ts's DEFAULTS.
   Not a preference — it is the anchor consoleFov() scales CONSOLE_CAM.fov
   about, so that the tuned 78 still means 78 when the slider is where it
   shipped. If settings.ts's default ever moves, this moves with it or the
   console camera silently re-frames for everyone. */
const FOV_SLIDER_REF = 67;
/* Sanity bound on the console and backseat lenses, well clear of the 116 the
   top of the slider asks for. Same job as POV_FOV_MAX and nothing more: settings.ts
   type-checks fovBase but does not range-check it, so a profile can carry any
   number at all, and a projection matrix is not the place to find that out. */
const CONSOLE_FOV_MAX = 130;

/* Photo mode. A TEMPORARY camera of its own — it never writes to the gameplay
   camera, camMode, settings or the FOV pipeline, so leaving the mode cannot
   fail to restore the view: there is nothing to restore. The sim is paused
   under it through the same setRunning(false) the pause menu uses (GameApp's
   photoRequest), and every piece of HUD chrome hides because the screen state
   leaves "playing" — no per-element hiding to forget.

   The lens is a FIXED 55-degree vertical. Deliberately not the FOV slider and
   not lensFov()/povFov(): those are the driving views' contract (AGENTS.md),
   and a photo wants a longer lens than a windscreen does — 55 at 16:9 is
   ~84 horizontal, about what a 24 mm walk-around on full frame gives, wide
   enough to frame the whole car at 6 m without the barrel-stretch a 100-degree
   gameplay FOV would smear across the paintwork. */
const PHOTO = {
  fov: 55,
  /** orbit radius, metres from the car's origin. distMin keeps the lens out of
      the bodywork (the longest shell is ~2.6 m half-length, diagonal ~2.9);
      dist0 gets `+ shell.L * 0.35` at enter so both cars open at the same
      framing, the way CHASE_CAM.dist does. */
  distMin: 3.4, distMax: 16, dist0: 4.6,
  /** orbit elevation, radians. The floor is a hair below level for the
      low-angle hero shot; going lower has nothing to see — the camera-height
      clamp below already stops the lens short of the deck. The ceiling is
      just shy of top-down, where a polar orbit turns into gimbal soup. */
  pitchMin: -0.08, pitchMax: 1.25, pitch0: 0.2,
  /** the orbit's aim point sits this far above car origin — roughly the beltline,
      so the default frame is car-with-some-road rather than car-in-the-sky */
  aimY: 0.9,
  /** metres of air kept between the lens and whatever surface is under it
      (deck, ramp, town street) — the "don't clip under the deck" clamp */
  clearance: 0.35,
  /** rad/s of gentle self-orbit until the first drag/wheel input — the mode
      opens as a slow dolly around the car rather than a frozen frame */
  autoRate: 0.09,
  /** radians of orbit per px of drag, and the wheel's zoom response */
  dragSens: 0.0062, wheelZoom: 0.0012,
  /** where the orbit opens relative to the car's heading: ~35 degrees off the
      nose — the front-three-quarter, the angle every car is photographed at */
  yaw0: 0.6,
};

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
  /** Wiper mode, an index into WIPER_MODE_NAMES (OFF/INT/LO/HI). Public
      because the touch drawer's WIPERS row shows it, same as `rain` beside
      it; stepped only through cycleWipers(). Session-only on purpose — rain
      itself decides the default (see setRain), so persisting the mode would
      just let a profile come back with dry-weather wipers running. */
  wiperMode = 0;
  grade = false; // set from settings.dashcam in the constructor
  /* THERE IS NO `dashImported` ANY MORE, and its absence is the point.

     It was one boolean meaning "the donor Volvo is on show, interior and
     exterior body together", flipped by J, and read by the lens offsets, the
     interior hood and the cabin hotspot. With two cars in the garage the same
     question has a better answer: WHICH interior you are in is decided by the
     car you picked, so the state already exists in the rig that was built for
     that car, and a second copy of it here could only ever disagree.

     Every former reader now tests `this.rig.cockpitModel` instead — the donor
     cabin handle, non-null exactly when the donor cabin is the cabin on screen
     (player.ts COCKPIT_MODEL: the Volvo has one, kaze does not, and mobile-base
     gets none either way). That test was ALREADY there next to the flag at
     every site, because a donor still in flight is not the cabin on show yet;
     dropping the flag just leaves the half that was doing the work. */
  /** Drive the car on testDriveSpec() instead of its own spec — grip, brakes
      and power up, for getting somewhere in the world quickly. Toggled by K
      in game and by a row in the settings panel.

      A VIEW onto settings.testMode rather than a field of its own, so the two
      cannot drift: the settings panel writes the setting, K writes through
      this setter, and every reader sees one value. (`grade` above solves the
      same problem by mirroring the flag into settings by hand on each K-style
      toggle, which works but has to be remembered at every write site.)
      persist() copies this.settings out, so it survives a reload — it used to
      be deliberately session-only, and that is no longer true. */
  get testMode() { return this.settings.testMode; }
  set testMode(v: boolean) { this.settings.testMode = v; }

  /** Read-only: the running total and the best-ever, for GameApp.tsx's
      persist() to copy into the profile alongside carId/seed/camMode. */
  get noHesiScore() { return this.noHesi.score; }
  get noHesiBest() { return this.noHesi.best; }
  get tttTally() { return gameTally(); }

  /** This session's drive statistics, live — the STATS panel reads fields
      straight off it (the mtn* detector scratch rides along; UI ignores it). */
  get sessionStats(): Readonly<LifetimeStats> { return this.stats; }
  /** Lifetime statistics: the profile's totals plus this session, combined
      the way each field means (sums, except the two records). Allocates a
      fresh object per call — menu/persist cadence only, never per frame.
      Idempotent because statsSeed is a construction-time copy, so persist()
      can write it back as often as it likes without double counting. */
  lifetimeStats(): LifetimeStats {
    const s = this.stats, L = this.statsSeed;
    return {
      dist: L.dist + s.dist,
      topSpeed: Math.max(L.topSpeed, s.topSpeed),
      driveT: L.driveT + s.driveT,
      nearMisses: L.nearMisses + s.nearMisses,
      bestCombo: Math.max(L.bestCombo, s.bestCombo),
      crashes: L.crashes + s.crashes,
      laps: L.laps + s.laps,
      mtnRuns: L.mtnRuns + s.mtnRuns,
    };
  }

  /* Lens OFFSET for the interior currently on screen, all three axes — see
     povMount(), which this describes. Read live rather than cached because the
     donor cabin arrives ASYNCHRONOUSLY: the rig is on screen before the GLB
     lands, and the frame it lands in is the frame the lens has to move in, or
     the eye sits at the procedural height inside a donor dash until something
     else happens to invalidate a cache.

      Z IS HERE FOR A REASON, and it is not symmetry. The retired dash was
      frustum-CLIPPED: build-cockpit.mjs deleted every vertex outside the
      dashcam cone, so the driver's seat did not exist in that asset and the
      lens could sit anywhere fore-and-aft without ever being behind anything.
      The shipped interior is built --no-clip and carries the real seat — 34k
      triangles spanning z -0.286..0.598 with its headrest up at y 1.327,
      while the lens sits at z ~0.31, y ~1.175. That is INSIDE the seat
      volume, which is what "the camera is behind the seat" actually is. No
      value of dy fixes it; height is not the axis that is wrong.

      So all three are live knobs, not just the height:

        window.__povMount.dz = 0.16    // slide the lens FORWARD, past the seat
        window.__povMount.dy = -0.19   // and down
        window.__povMount.dx = 0.02    // and inboard/outboard

      dx and dz are DELTAS on top of POV_MOUNT.dx/dz rather than replacements,
      so zero means "exactly where it was" and a reading taken from the console
      can be pasted straight into POV_MOUNT_DELTA below. dy stays absolute
      because POV_MOUNT_DY_IMPORTED already is. */
  /** Multiplier on the CHASE camera's "sensation" effects — the head-spring
      bob that rides the camera height, the G-lean roll on the shell, and the
      speed FOV kick. 0 disables all three at once; 1 restores the old feel.

      One multiplier rather than three flags because the user could not name
      which of them was the problem ("remove the shake stuff in 3rd person too
      idk waht that is") — they read as one wobble from outside the car, and
      splitting them into separate settings would ask a question nobody can
      answer by looking. If only one turns out to be wanted back, this is the
      place to split it.

      NOT applied to the interior cameras: the cockpit view's road buzz is a
      different system (position-keyed value noise, see roadTexture) and was
      not what was reported. */
  private chaseShake(): number {
    if (window.__chaseShake === undefined) window.__chaseShake = CHASE_SHAKE;
    return window.__chaseShake;
  }

  /** The live cabin-lighting knob — see CABIN_LIGHT. */
  private cabinKnob(): typeof CABIN_LIGHT {
    if (!window.__cabinLight) window.__cabinLight = { ...CABIN_LIGHT };
    return window.__cabinLight;
  }

  /** The live fog knob — see FOG_TUNE. */
  private fogKnob(): typeof FOG_TUNE {
    if (!window.__fog) window.__fog = { ...FOG_TUNE };
    return window.__fog;
  }

  /** The live car-env knob — see CAR_ENV. */
  private carEnvKnob(): typeof CAR_ENV {
    if (!window.__carEnv) window.__carEnv = { ...CAR_ENV };
    return window.__carEnv;
  }

  /** The live chase-framing knob — see CHASE_CAM. */
  private chaseKnob(): typeof CHASE_CAM {
    if (!window.__chase) window.__chase = { ...CHASE_CAM };
    return window.__chase;
  }

  /** Step the dome light around its off/dim/full cycle. One place, because
      there are two ways to ask for it — the I key and clicking the overhead
      console (onPointerDown) — and a state this cheap to duplicate is a state
      that eventually disagrees with itself. Only the knob is written;
      cabinLightUpdate() below is what carries it into both interiors. */
  private toggleCabinLight() {
    const c = this.cabinKnob();
    c.on = ((c.on + 1) % DOME_LEVELS.length) as typeof c.on;
    this.ui.toast("INTERIOR LIGHT " + (c.on === 0 ? "OFF" : c.on === 1 ? "DIM" : "ON"));
  }

  /** Step the wiper mode around OFF → INT → LO → HI. One body for the U key,
      the stalk click zone (onPointerDown) and the drawer's WIPERS row
      (uiKeyTap "u"), same policy as toggleCabinLight above. The stalk click
      sound is the feedback the stalk itself would give; the arms crossing
      the windscreen are the real confirmation. */
  private cycleWipers() {
    this.wiperMode = (this.wiperMode + 1) % WIPER_MODE_NAMES.length;
    if (this.wiperMode === 0) this.wipeDir = 0; // let the park ease take it home
    else if (this.wipeDir === 0) this.wipeWait = 0; // sweep NOW, not after a stale INT pause
    this.audio.stalkClick();
    this.ui.toast("WIPERS " + WIPER_MODE_NAMES[this.wiperMode]);
  }

  /** Toggle the rear-view's electrochromic dim (clicking the glass itself).
      Only the flag flips here — mirrorDimUpdate() eases the glass toward it
      on the frame clock, same shape as the dome light's hover ease. */
  private toggleMirrorDim() {
    this.mirrorDim = !this.mirrorDim;
    this.audio.stalkClick();
    this.ui.toast("MIRROR DIM " + (this.mirrorDim ? "ON" : "OFF"));
  }

  private mirrorDimUpdate(dt: number) {
    const t = this.mirrorDim ? 1 : 0;
    this.mirrorDimE = lerp(this.mirrorDimE, t, 1 - Math.exp(-MIRROR_DIM_EASE * dt));
    // snap the last fraction so the material write settles on exact endpoints
    if (Math.abs(this.mirrorDimE - t) < 0.002) this.mirrorDimE = t;
    this.rig.cockpit.setMirrorDim(this.mirrorDimE);
  }

  /** Push the cabin-light level into both interiors, every frame.

      Per-frame rather than on the key edge, and that is the whole point: the
      donor interior arrives asynchronously and can land minutes into a drive,
      long after the key was pressed. An edge-triggered version would leave a
      donor that loaded late lit while the procedural one next to it was dark —
      the same load race mirrorFramingUpdate() exists to close, and the same one
      player.ts's `bodyRef.want` closes for the exterior body. Two float writes
      is cheaper than remembering to re-apply it in three places.

      It also owns the hover preview (CABIN_LIGHT.hover), for the same reason:
      the ease has to run on the frame clock, and the level it produces has to
      reach the donor's fill light as well as the procedural dome or the J
      comparison would show two different cabins. */
  private cabinLightUpdate(dt: number) {
    const k = this.cabinKnob();
    /* EVERY way out of the hover state converges here rather than being chased
       through the events that cause it. The pointer moving off the target and
       the pointer leaving the canvas are real events and have listeners; pause,
       a camera change out of the cabin, a touch device and a reload mid-hover
       are not events at all, they are conditions — and a preview latched on
       through any of them is worse than never having had one. */
    if (this.isTouch || !this.running || !this.loaded || !this.inCar()) {
      this.cabinHover = 0;
      // the head unit's hover is the same kind of state and goes out the same
      // door, or a button left lit at the pause menu stays lit behind it
      this.screenHover = null;
      this.renderer.domElement.style.cursor = "";
    }
    this.cabinHoverE = lerp(
      this.cabinHoverE, this.cabinHover, 1 - Math.exp(-CABIN_HOVER_EASE * dt)
    );
    // the level a click would leave it at — the next stop around the cycle —
    // the preview travels `hover` of the way there
    const next = DOME_LEVELS[(k.on + 1) % DOME_LEVELS.length];
    const eff = lerp(DOME_LEVELS[k.on], next, this.cabinHoverE * k.hover);
    const level = eff * k.dome;
    this.rig.cockpit.setCabinLight(level);
    this.rig.cockpitModel?.setFillLight(level);
  }

  /** The dashcam's yaw, softened — see CAM_SMOOTH. Returns the heading the
      lens should hold this frame, which with the knob at 0 is `h` exactly. */
  private povYaw = 0;
  private povYawUpdate(h: number, dt: number): number {
    const k = this.camSmoothKnob();
    if (!(k.pov > 0)) {
      this.povYaw = h;
      return h;                       // today's behaviour, bit for bit
    }
    let d = h - this.povYaw;
    /* A heading that jumped rather than turned is not a flick to absorb: a
       respawn, a splice, or the very first frame after a reload. Snap. */
    if (d > 0.5 || d < -0.5) {
      this.povYaw = h;
      return h;
    }
    this.povYaw += d * (1 - Math.exp(-dt / k.pov));
    // and never let the lens sit further off the nose than this, however hard
    // the flick — past a few degrees it stops reading as compliance
    d = h - this.povYaw;
    if (d > k.max) this.povYaw = h - k.max;
    else if (d < -k.max) this.povYaw = h + k.max;
    return this.povYaw;
  }

  /** Live knob for the dashcam yaw softening — see CAM_SMOOTH. */
  private camSmoothKnob(): typeof CAM_SMOOTH {
    if (!window.__camSmooth) window.__camSmooth = { ...CAM_SMOOTH };
    return window.__camSmooth;
  }

  /** Live knob for what the chase camera is still allowed to do — see
      CHASE_FX. All three terms ship at 0. */
  private chaseFx(): typeof CHASE_FX {
    if (!window.__chaseFx) window.__chaseFx = { ...CHASE_FX };
    return window.__chaseFx;
  }
  /** Live knob for the cockpit road buzz — see CABIN_VIBE. */
  private vibeKnob(): typeof CABIN_VIBE {
    if (!window.__cabinVibe) window.__cabinVibe = { ...CABIN_VIBE };
    return window.__cabinVibe;
  }
  /** Live knob for the interior hood — see HOOD. */
  private hoodKnob(): typeof HOOD {
    if (!window.__hood) window.__hood = { ...HOOD };
    return window.__hood;
  }
  /** Carry the hood knob into the rig, every frame.

      Per-frame for the same reason cabinLightUpdate() is: the body donor
      arrives asynchronously and can land minutes into a drive, so there is no
      edge to hang this on that the hood is guaranteed to exist for. Three
      writes on a group that is usually not even drawn.

      Gated on the donor CABIN, not merely on the hood existing. The hood is a
      piece of the donor body seen from inside the donor interior, and the two
      no longer arrive together: BODY_MODEL is not tiered while COCKPIT_MODEL
      is, so on mobile-base the Volvo has its donor body — and therefore this
      hood — in front of a PROCEDURAL dash. A donor bonnet hanging over a
      procedural cabin is exactly the half-and-half car the old J flag existed
      to prevent, and it is the one place that mismatch can still occur. It
      also rides cockpit.group's own visibility, so nothing here has to know
      about the camera rule. */
  private hoodUpdate() {
    const hood = this.rig?.hood;
    if (!hood) return;
    const k = this.hoodKnob();
    hood.visible = k.on > 0 && !!this.rig.cockpitModel;
    hood.position.set(0, k.dy, k.dz);
  }

  private povMount(): { dx: number; dy: number; dz: number } {
    if (!this.rig.cockpitModel) return { dx: 0, dy: POV_MOUNT.dy, dz: 0 };
    if (!window.__povMount) window.__povMount = { ...POV_MOUNT_DELTA };
    return window.__povMount;
  }

  /** Forward nudge for the COCKPIT eye (CAM_COCKPIT), same cause as povMount()
      but a much bigger number, because this camera sits a full POV_MOUNT.dz
      (0.61 m) further back than the dashcam. Seat z -0.286..0.598 against an
      eye at COCKPIT_EYE.z ~ -0.30 puts it behind the backrest outright, not
      merely inside the seat — which is why the imported interior reads as
      "behind the seat" here first.

      Applied ONLY with the imported interior up. The procedural cockpit has no
      seat geometry in front of the eye and is framed against COCKPIT_EYE as
      authored; shifting it would break the binnacle/wheel/mirror framing that
      cockpit.ts pins to that exact point.

      Live: `window.__cockpitEye.dy = -0.14`, `.dz = 0.6`. AGENTS.md rates this
      camera as debug-only, so it gets knobs and defaults rather than a tuning
      pass — bring settled values back into COCKPIT_EYE_IMPORTED. */
  private cockpitEye(): { dy: number; dz: number } {
    if (!this.rig.cockpitModel) return { dy: 0, dz: 0 };
    if (!window.__cockpitEye) window.__cockpitEye = { ...COCKPIT_EYE_IMPORTED };
    return window.__cockpitEye;
  }

  /** Mount, lens and cant for the experimental centre-console camera — see
      CONSOLE_CAM for where every number comes from.

      NOT split by interior, unlike povMount() and cockpitEye(). Those two exist
      to hold a framing that two different dashes disagree about; this camera is
      aimed at the road over the console, and neither dash is in the shot the
      way a binnacle is. It reads the same knob either way, which also keeps the
      J toggle from moving it underneath someone who is tuning it. */
  private consoleCam(): { x: number; y: number; z: number; fov: number; tilt: number } {
    if (!window.__consoleCam) window.__consoleCam = { ...CONSOLE_CAM };
    return window.__consoleCam;
  }

  /** Mount, lens, cant and aim for the backseat camera — see BACKSEAT_CAM for
      where every number comes from. Not split by interior for the same reason
      consoleCam() is not: the view is aimed out the windscreen over geometry
      (the bench, the front seatbacks) that both cabins place, and a knob that
      moved under the J toggle would be useless for tuning. */
  private backseatCam(): { x: number; y: number; z: number; fov: number; tilt: number; yaw: number } {
    if (!window.__backseatCam) window.__backseatCam = { ...BACKSEAT_CAM };
    return window.__backseatCam;
  }

  /** Is the camera inside the cabin? Interior shell on, exterior body off, HUD
      minimap suppressed (every in-car view carries the head unit's own map),
      nav panel clickable, cabin trim audible, rear view rendered.

      One predicate rather than the `camMode === CAM_COCKPIT || camMode ===
      CAM_POV` pair that used to be written out at each of those sites: adding
      CAM_CONSOLE meant editing five copies of the same test, and the failure
      mode for missing one is silent and ugly — an invisible cabin, or the
      car's own bodywork drawn across the lens. Sites that are about ONE camera
      rather than about being indoors (the dashcam degrade, the impact glitch,
      the POV beam-carpet widening, the cockpit head springs) deliberately do
      not use this. */
  private inCar(): boolean {
    /* Photo mode is outdoors whatever camMode is waiting behind it: the orbit
       camera needs the exterior shell visible (updateCarVisual reads this) and
       none of the in-car machinery — mirror RT, cabin hotspots, the interior
       hood. camMode itself is untouched, so the answer snaps back the frame
       the mode ends. */
    if (this.photo.on) return false;
    return (
      this.camMode === CAM_COCKPIT || this.camMode === CAM_POV || this.camMode === CAM_CONSOLE ||
      this.camMode === CAM_BACKSEAT
    );
  }

  /** The dashcam lens, in three's vertical degrees, for a given viewport
      aspect. See the POV_V_CAP block above for why the slider is read as
      vertical-at-16:9 and then held horizontally constant.

      The slider runs 58..100 (GameApp.tsx). Swept over that range crossed with
      every aspect from 9:21 to 32:9, the widest frame either interior has to
      survive is 125.0 deg vertical by 129.5 deg horizontal.

      That pair is a contract with tools/build-cockpit.mjs, but a much looser
      one than it used to be. The shipped interior is not frustum-clipped: the
      build tool decides which whole NODES to keep by testing them against
      exactly these angles, so widening the lens can only ever expose empty
      cabin behind a part that was dropped — never a sliced edge through a part
      that was kept. (When the clipped dash was the shipped asset, the same two
      numbers had to be paid for in geometry: re-clipping it from 88 to 100 was
      measured at 0.87 MB, 8.28 -> 9.15.)

      A saved profile can still hold more than POV_FOV_MAX; the clamp in
      povFov() is the last gate before the projection matrix. */
  private lensFov(base: number, aspect: number): number {
    const halfTan = (deg: number) => Math.tan((deg * Math.PI) / 360);
    const fullAng = (t: number) => (2 * Math.atan(t) * 180) / Math.PI;
    // the base is the vertical fov at 16:9; that fixes the horizontal
    const h = fullAng(halfTan(base) * POV_REF_ASPECT);
    let v = fullAng(halfTan(h) / aspect);
    // a tall frame must not become a fisheye...
    v = Math.min(v, base * POV_V_CAP);
    // ...and a wide one must not become a letterbox slit, up to the point
    // where propping the vertical up would push the horizontal past the clip
    return Math.max(v, Math.min(POV_V_FLOOR, fullAng(halfTan(POV_H_CEIL) / aspect)));
  }
  private povFov(aspect: number): number {
    return this.lensFov(clamp(this.settings.fovBase, 58, POV_FOV_MAX), aspect);
  }

  /** The console camera's lens — CONSOLE_CAM's own wider baseline, MOVED BY
      the Field of view slider.

      It used to be a flat `consoleCam().fov`, which made the slider dead in
      this view: the reasoning for giving it a lens of its own was about the
      CAPS (an experimental camera should not inherit the shipping view's
      ceiling) and got applied to the slider as well, which was never the
      intent. The slider is the user's setting and every camera should answer
      to it.

      So the knob's `fov` is re-read as the baseline AT THE SLIDER'S DEFAULT
      and SHIFTED by the slider's degrees from there: 78 at 67, 71 at 60, 91
      at 80. Whatever window.__consoleCam.fov is set to keeps meaning "what
      this camera looks like with the slider where it shipped", so a tuning
      session is not undone by someone else's setting.

      This used to be multiplicative (`fov * (slider / FOV_SLIDER_REF)`), which
      reads fine at the reference point but runs away either side of it because
      degrees near 180 are tangent-nonlinear: at the slider's max of 100 that
      scaled the 78-degree baseline to 116.4 vertical, ~141.8 horizontal at
      16:9 through lensFov, well past the ~100 vertical / ~129.5 horizontal
      every other camera tops out at — the "stretched at max FOV" report.
      Additive keeps the console a constant amount wider than the dashcam
      across the whole range instead of diverging from it at the top.

      Then through the SAME aspect machinery as the dashcam (lensFov), and
      that part is not optional. Assigning a base straight to camera.fov is
      exactly the naive form POV_V_CAP / POV_H_CEIL exist to prevent: read as
      a plain vertical angle, a 78-degree lens on a 9:19.5 phone is a
      36-degree horizontal slit, and read as plain horizontal it fisheyes the
      other way. Holding the horizontal constant off 16:9, with the relative
      vertical cap, is what keeps the framing recognisable through a rotation.

      What it does NOT pick up is any per-interior cap. There is only one such
      cap left in the file (POV_FOV_MAX, the saved-profile gate) and its
      retired sibling POV_FOV_MAX_CUT existed for a frustum-CUT dash that
      printed torn shards past the angle it was sliced for. This camera looks
      forward over the console at geometry that was never clipped for it, so
      it has nothing to tear. CONSOLE_FOV_MAX is a sanity bound, not a
      contract: it is only there so a hand-edited profile cannot ask for a
      degenerate projection. */
  private consoleFov(aspect: number): number {
    const base = clamp(
      this.consoleCam().fov + (clamp(this.settings.fovBase, 58, POV_FOV_MAX) - FOV_SLIDER_REF),
      40, CONSOLE_FOV_MAX
    );
    return this.lensFov(base, aspect);
  }

  /** The backseat camera's lens: same contract as consoleFov(), same reasons.
      BACKSEAT_CAM.fov is the framing at the slider's default, MOVED BY the
      slider's degrees from there (additive — the multiplicative form is what
      gave the console its stretch report), then through the shared aspect
      machinery so a phone rotation keeps the framing. Own baseline rather
      than povFov()'s because a phone main lens is a touch wider than the
      dashcam, and the two should be free to disagree. */
  private backseatFov(aspect: number): number {
    const base = clamp(
      this.backseatCam().fov + (clamp(this.settings.fovBase, 58, POV_FOV_MAX) - FOV_SLIDER_REF),
      40, CONSOLE_FOV_MAX
    );
    return this.lensFov(base, aspect);
  }
  mirror = true;
  mmap = true;
  /** HUD map framing (Z / map click / drawer row): true = whole-loop overview */
  mmapZoom = false;
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
  /* Photo mode state — see the PHOTO block. `on` is only ever flipped by
     photoEnter/photoExit, which GameApp calls around the same setRunning(false)
     the pause menu uses, so `on` implies the sim is frozen. `shot` is armed by
     the capture key and consumed at the end of loop(), AFTER post.process has
     drawn the frame — canvas.toBlob has to read the drawing buffer in the same
     task as the render or it reads a cleared one. `auto` is the gentle
     self-orbit; the first drag or wheel tick takes the camera over. */
  private photo = {
    on: false, yaw: 0, pitch: PHOTO.pitch0, dist: PHOTO.dist0,
    auto: true, shot: false, pinch0: 0,
  };
  /** Lazily built on first enter, never handed to any gameplay path: the
      whole restore-on-exit guarantee is that the gameplay camera is not
      touched while this one is on duty. */
  private photoCam: THREE.PerspectiveCamera | null = null;
  private photoPtrs = new Map<number, { x: number; y: number }>();
  /** captures completed this session (toBlob landed) — read by the smoke test */
  photoShots = 0;
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private last = 0;
  private acc = 0;
  private frameN = 0;
  private emaMs = 16;
  private slowT = 0;
  private gaugeT = 0;
  private dropT = 0;
  /* Wiper sweep state: travel (0 parked .. 1 raised), stroke direction
     (0 = at rest between INT strokes / parked), and the INT pause timer.
     The park branch of updateCarVisual mirrors the eased arm back into
     wipeT, so a mode turned on mid-park resumes from where the arm really
     is instead of teleporting it. */
  private wipeT = 0;
  private wipeDir: -1 | 0 | 1 = 0;
  private wipeWait = 0;
  /** Rear-view electrochromic dim: the toggle, and its eased level (what the
      glass actually shows — see MIRROR_DIM_EASE). Session-only, like the
      dome light: the clear mirror is the shipped look. */
  private mirrorDim = false;
  private mirrorDimE = 0;
  /** Head-unit night-dim (the map view's ☾ pill) — a shade drawn over the
      panel canvas by carscreen.ts. Session-only, same reasoning. */
  private screenDim = false;
  /** Odometer reading at the last trip reset; the trip pane shows
      car.odo - tripBase. 0 = never reset, i.e. the whole session. */
  private tripBase = 0;
  private hudT = 0;
  private chunkT = 0;
  /** No Hesi scoring state (see noHesiUpdate). `best` is seeded from the
      profile at construction and only ever grows; the caller (GameApp.tsx's
      persist()) reads it back out through the noHesiBest getter alongside
      carId/seed/camMode. */
  private noHesi = { score: 0, best: 0, combo: 1, sinceAction: 0, pulseCd: 0 };
  /** Session drive statistics (see the STATS block / statsUpdate). Engine
      units throughout — metres, m/s, seconds — converted at display time.
      The mtn* fields are the mountain-run detector's scratch: whether the
      last probe found the car on the pass, the s-span the visit has covered,
      and the off-pavement grace clock. */
  private stats = {
    dist: 0, topSpeed: 0, driveT: 0, nearMisses: 0, bestCombo: 1,
    crashes: 0, laps: 0, mtnRuns: 0,
    routeT: 0, mtnOn: false, mtnLo: 0, mtnHi: 0, mtnOffT: 0,
  };
  /** Lifetime stats as loaded from the profile — a COPY, never the profile's
      own object, so lifetimeStats() (seed + session, recomputed per call) is
      idempotent however many times persist() writes it back. */
  private statsSeed: LifetimeStats = defaultLifetimeStats();
  private raf = 0;
  private disposed = false;
  private isTouch: boolean;
  /** HUD nodes live in React's tree, so they are looked up lazily and
     re-looked-up if a node is ever swapped out — but not once per frame,
     which is what the getElementById calls in hud()/frame() amounted to */
  private domCache = new Map<string, HTMLElement | null>();
  private wheelVal = 0;
  private tiltVal = 0;
  private tiltHooked = false;
  /** The pointer currently dragging #swheel, set by GameApp's SteerWheel —
      lets the watchdog below tell a live drag from a wheelVal that got left
      behind by a gesture the DOM never told anyone had ended. */
  private wheelPointerId: number | null = null;
  /** Every pointer id the window has seen go down and not yet seen go back up,
      kept independently of which element claims to have captured it. Bound at
      the window in the capture phase (bindInput) so nothing downstream —
      stopPropagation on gearBtn, a retarget, a hidden element — can keep an
      up/cancel from reaching it; that makes it the one source of truth the
      per-control watchdog below can trust when an element's own release
      listener never fires. */
  private livePointers = new Set<number>();
  /** One entry per held touch puck (bindHold), tracking every pointer id
      currently pressing it. A second finger's stray pointerup landing on a
      puck it never pressed must not release the first finger's hold — see
      bindHold — so release is "the ids we captured minus the one that left,"
      not "any pointerup that reaches this element." */
  private touchHolds = new Map<string, { key: string; ids: Set<number> }>();
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
  /** last relative-longitudinal position per tracked npc, for the pass-by
      whoosh's sign-flip detection — see npcAudioFeed() */
  private passbyPrev = new WeakMap<object, number>();
  /** last state pushed to mats.setPbrDetail; the call recompiles materials, so
      it must only ever fire on a real transition */
  private pbrDetail = true;
  /** last value handed to setReverb, so the common no-op case stays free */
  private lastReverb = -1;
  /** camMode as of the last interior-EQ update — cheaper than calling
      setInterior every frame and keeps the audio side edge-triggered */
  private lastInteriorMode = -1;
  /** The handle and the state the mirror framing was last pushed to — see
      mirrorFramingUpdate(). The handle is half of the key because it arrives
      asynchronously and starts on wire()'s default. */
  private mirrorFramedFor: CockpitModelHandle | null = null;
  private mirrorFramedAs: MirrorFraming | "" = "";
  debug = {
    override: null as Partial<DriverInput> | null,
    errors: [] as string[],
    frames: 0,
  };

  constructor(container: HTMLElement, profile: Profile, ui: UiBridge) {
    this.ui = ui;
    this.settings = profile.settings;
    this.grade = profile.settings.dashcam;
    /* Direct assignment, not setRain()/setters: rainFX does not exist until
       load() runs, and setRain toasts — a restored profile must not fire a
       "RAIN — grip down" popup at startup. */
    this.rain = profile.settings.rain;
    /* A profile restored WITH rain gets its wipers running the same way a
       live rain toggle would bring them on (see setRain) — before modes
       existed, rain always wiped, and a wet load must not regress into a
       blinded windscreen. */
    this.wiperMode = this.rain ? 2 : 0;
    this.time = profile.settings.time;
    this.mmap = profile.settings.mmap;
    this.mmapZoom = profile.settings.mmapZoom;
    this.carId = profile.carId;
    this.paintIx = profile.paintIx;
    this.seed = profile.seed;
    this.camMode = profile.camMode;
    this.noHesi.best = Number.isFinite(profile.noHesiBest) ? profile.noHesiBest : 0;
    // loadProfile scrubbed every field; the copy is what makes lifetimeStats()
    // idempotent (see statsSeed)
    this.statsSeed = { ...defaultLifetimeStats(), ...profile.stats };
    /* Head-unit tic-tac-toe tally, same persistence contract as settings:
       the profile's own object is handed over and mutated in place, and
       GameApp's persist() reads it back out through the getter below. */
    bindGameTally(profile.ttt);
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
    // POV grade profile: the mobile tiers run the dashcam degrade at gentler
    // strengths (post.ts POV_TUNE_TIER) so the road stays readable on a phone
    this.post.setPovProfile(this.renderTier);
    /* Everything above is what the MENUS need: a canvas, a resolved tier, and
       the settings the panels read. The world itself — materials, terrain,
       expressway, town, traffic, the player rig — is NOT built here; it is
       built by load() below, in yielding stages, behind the loading screen.
       See the note on load() for why.

       The inline world build that used to live here is gone deliberately —
       it is what froze the tab on Drive. If a merge ever reintroduces it,
       that is the conflict resolving the wrong way. */

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
      /* Drop the car onto the mountain road at arclength s, in lane (0 =
         forward/rock side, 1 = oncoming/river side), at speed. */
      toMountain: (s = 40, kmh = 70, lane = 0) => {
        const mt = this.world.routes!.mtn;
        const ss = Math.max(4, Math.min(mt.len - 4, s));
        const p = mt.worldOf(ss, mt.laneOffset(lane, ss));
        const h0 = mt.poseAt(ss).h + (lane === 1 ? Math.PI : 0);
        this.car.x = p.x;
        this.car.y = p.y;
        this.car.z = p.z;
        this.car.h = h0;
        this.car.u = kmh / 3.6;
        this.car.v = 0;
        this.car.r = 0;
        this.car.rev = false;
        this.car.wvx = 0;
        this.car.wvz = 0;
        this.chasePos.set(p.x - Math.sin(h0) * 4.4, p.y + 2.15, p.z - Math.cos(h0) * 4.4);
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
        npcsMtn: this.traffic.npcs.filter((n) => n.active && n.route === MOUNTAIN_EDGE).length,
        npcsMtnOncoming: this.traffic.npcs.filter(
          (n) => n.active && n.route === MOUNTAIN_EDGE && n.dir < 0).length,
        onBypass: this.world.routes?.surfaceAt(this.car.x, this.car.z, 2)?.edgeId === BYPASS_EDGE,
        onMountain: this.world.routes?.surfaceAt(this.car.x, this.car.z, 2)?.edgeId === MOUNTAIN_EDGE,
        stats: { ...this.stats },
        lifetime: this.lifetimeStats(),
        wrecks: this.traffic.activeWrecks().length,
        chunksVisible: this.world.chunks.filter((c) => c.group.visible).length,
        chunksTotal: this.world.chunks.length,
        perfMode: this.perfMode,
        renderTier: this.renderTier,
        photo: this.photo.on,
        photoShots: this.photoShots,
        errors: this.debug.errors,
        frames: this.debug.frames,
      }),
      crashTest: () => {
        this.traffic.spawnObstacleAhead(this.car);
        this.car.u = 22;
      },
      /* Advance the car simulation without waiting on renders. Headless
         SwiftShader can take SECONDS per frame in a loaded sandbox, and the
         loop advances car physics at most 6 substeps (0.05 s) per rendered
         frame before dropping the backlog — so any test that needs real
         driving distance (the smoke test's ramp runs) starves on wall-clock
         budgets. This runs the same readInput → stepPhysics → splice →
         collide pipeline the loop runs, at the same 120 Hz substep, with
         rendering and traffic left out. Capped per call so a runaway caller
         cannot hang the tab. */
      simStep: (secs: number) => {
        if (!this.loaded) return;
        const n = Math.min(Math.round(secs * 120), 120 * 30);
        for (let i = 0; i < n; i++) {
          this.readInput(1 / 120);
          stepPhysics(this.car, this.input, this.phys, 1 / 120, {
            mu: this.rain ? 0.84 : 1.26,
            tcEnabled: this.settings.tc,
            heightAt: this.terrain.heightAt,
            arcade: this.testMode,
          });
          this.loopSplice();
          collidePlayer(this.car, this.world, this.traffic.npcs, this.rig.halfW, this.rig.halfL);
          // the stats integrator is part of the car simulation this mirrors
          // (distance/time/top-speed and the mountain-run probe track sim
          // driving too); the traffic-fed stats stay loop-only, like traffic
          this.statsUpdate(1 / 120);
        }
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
      so they are weighted at what a warm cache costs rather than a cold one.

      SECOND PASS, and the reason is in the first paragraph: "estimates of where
      the time goes ON A MID-RANGE PHONE". Reported again as "it loads fast then
      gets stuck towards the end every time", from a desktop — and a desktop
      redistributes this badly. The two mesh builds are pure JS on one core and
      a fast CPU eats them; the tail is not CPU at all. Fetching a 5.7 MB donor
      dash takes what it takes, a driver linking a few hundred programs takes
      what it takes, and neither scales with the thing that makes the front of
      this list fast. So on anything quick the front over-runs and the back
      under-runs, which is the bar racing then parking.

      Weight moved off `highway` (26 -> 17) and `town` (22 -> 14) and onto the
      three tail stages that wait on the network and the GPU: `traffic` 8 -> 10,
      `car` 8 -> 15 (it is the largest single fetch in the game AND a full rig
      build), `shaders` 12 -> 16. `warm` stays at 22 — it was corrected once
      already and it is the one stage whose weight was fitted to a real
      complaint. The front of the bar now spends 42% rather than 57% getting to
      the end of the town, which is the requested direction without becoming
      the opposite complaint.

      THE WEIGHTS WERE ONLY HALF OF IT. Of the eight stages, `warm` was the
      only one reporting intra-stage progress; `traffic`, `car` and `shaders`
      each moved the bar in ONE jump while waiting on a promise with a budget
      of 5, 8 and 15 seconds. Together they covered 64% -> 94%, so "stuck
      towards the end" was three back-to-back single jumps, and no amount of
      reweighting fixes a stall inside one stage — it only changes the number
      it stalls on. They creep now; see creepAwait.

      STILL ESTIMATES. runStages() records real per-stage milliseconds and the
      load hangs them off `__neonx.loadTimings`, so fitting these properly is
      one console read on the machine that complained. */
  private static readonly LOAD_WEIGHTS = {
    mats: 10,
    land: 4,
    highway: 17,
    town: 14,
    traffic: 10,
    car: 15,
    shaders: 16,
    /* 6 -> 22. This stage renders real frames — every shader, every first-use
       texture upload, the post chain and both extra camera passes — and is
       one of the two most expensive things in the load, not the cheapest.
       At 6 of 100 the bar reached 94% and then sat there for the whole
       warm-up, which is exactly the reported stall. The weight now roughly
       matches the cost, and the stage reports from inside it as well (see
       warmFrames), so the bar moves through it rather than across it. */
    warm: 22,
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
          /* last rng consumer in the build order — see the comment above
             buildStages(): scenery must stay after town so earlier stages'
             draws are unchanged for a given seed. */
          buildScenery(this.scene, this.mats, this.world, this.terrain, rng);
          this.tintLampsSodium();
        },
      },
      {
        label: "PUTTING CARS ON THE ROAD",
        weight: W.traffic,
        run: async (onStep) => {
          this.traffic = new Traffic(
            this.scene, this.world, this.mats.envMap, this.mats.glowTex, 120
          );
          this.rainFX = new RainFX(this.scene, this.mats.streakTex);
          // the load's applySettings pass covers mats.setWet but not the
          // particles, so a profile restored with rain on needs this
          this.rainFX.pts.visible = this.rain;
          this.smokeFX = new SmokeFX(this.scene, this.mats.smokeTex);
          // wait for the bodyshells: a style with no model is barred from
          // spawning, so driving off before they land means an empty road that
          // fills itself in over the first few seconds
          await Game.creepAwait(
            this.traffic.fleetLoaded, Game.FLEET_BUDGET_MS, 1200, onStep, 0.25
          );
        },
      },
      {
        label: "WARMING THE ENGINE",
        weight: W.car,
        run: async (onStep) => {
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
          /* The rig build above is real work and is done, so the creep starts
             from a share of the stage rather than from zero — the dash fetch
             is the rest of it. */
          await Game.creepAwait(
            this.rig.cockpitReady, Game.DASH_BUDGET_MS, 2500, onStep, 0.4
          );
        },
      },
      {
        label: "COMPILING SHADERS",
        weight: W.shaders,
        run: async (onStep) => {
          /* three compiles a material's program the first time it is DRAWN, so
             a world this size pays for a few hundred link calls spread over the
             first seconds of driving — the classic hitch right after a loading
             screen says it is done. compileAsync walks the whole scene up front
             (traverse, not traverseVisible: the culled chunks count too) and,
             where KHR_parallel_shader_compile exists, lets the driver link off
             the main thread while we sit here. */
          await Game.creepAwait(
            this.renderer.compileAsync(this.scene, this.camera),
            Game.COMPILE_BUDGET_MS, 3000, onStep
          );
        },
      },
      {
        label: "ROLLING OUT",
        weight: W.warm,
        run: async (onStep) => {
          /* Compiling is not the whole of a first frame: textures upload on
             first use, the post chain and the mirror/reflection passes have
             their own programs, and none of that is reachable from
             compileAsync. So run the real render loop — paused, so nothing
             moves — for a few frames behind the loading screen. Whatever is
             still one-off cost gets paid here instead of in the player's first
             corner, and the canvas already holds a finished frame when the
             overlay comes off, so the handoff has nothing to flash. */
          await this.warmFrames(6, onStep);
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
  /** Await `p` (with its budget) while walking `onStep` from `from` toward 1,
      so a stage that is only waiting still moves the bar.

      For the three stages that wait on something opaque — the traffic
      bodyshells, the donor dash, and the shader link — none of which can
      report a fraction of itself. A promise has no progress, and a bar that
      cannot move is a bar the player reads as hung: those three sat on one
      number each for up to 5, 8 and 15 seconds.

      The curve is `1 - e^(-t/est)`, which is the honest shape for a wait whose
      length is not known. It moves fastest at the start, where the wait
      usually ends, and it is ASYMPTOTIC — it approaches CREEP_CAP and cannot
      reach it however long the wait runs, so it never claims a stage is
      finished before it is, and a wait that runs long slows down rather than
      running out of bar. `est` sets the pace and is a guess by construction;
      being wrong about it changes the feel, never the correctness.

      The interval only ticks while the main thread is idle enough to service
      a timer, which for all three of these is exactly while they are waiting
      on the network or the driver. */
  private static async creepAwait(
    p: Promise<unknown>, budgetMs: number, estMs: number,
    onStep: (f: number) => void, from = 0
  ): Promise<void> {
    const t0 = performance.now();
    const timer = setInterval(() => {
      const t = (performance.now() - t0) / estMs;
      onStep(from + (1 - from) * CREEP_CAP * (1 - Math.exp(-t)));
    }, CREEP_MS);
    try {
      await withBudget(p, budgetMs);
    } finally {
      clearInterval(timer);
    }
    onStep(1);
  }

  private warmFrames(n: number, onStep?: (frac: number) => void): Promise<void> {
    this.beginLoop();
    return new Promise((resolve) => {
      let left = n;
      const tick = () => {
        // loop() re-arms its own rAF first, so by the time this runs the frame
        // it scheduled has been rendered
        if (this.disposed || --left <= 0) return resolve();
        // ...and report it, so the bar crawls through the warm-up instead of
        // parking at whatever percent this stage starts on. These are the most
        // expensive frames the game ever renders (every shader, every texture
        // upload, the post chain and both extra camera passes, all first-use),
        // so without this the bar visibly sticks here.
        onStep?.((n - left) / n);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  private onWindowError = (e: ErrorEvent) => {
    this.debug.errors.push(String(e.message));
  };

  private onWindowBlur = () => {
    this.clearLatchedInput();
    /* Same reasoning as hiHeld, and worse consequences: the keyup for a held B
       never arrives either, and lookBack has no timer to fall back on — the
       camera stays reversed for the rest of the session. */
    this.lookBack = false;
  };

  /** Wipes every input that only a matching release event clears — the
      keyboard/touch bus, the high-beam hold timer, the analog steer axes —
      for any moment a release can go missing: alt-tab (onWindowBlur) and
      pausing (setRunning(false)), which on a phone hides the touch pucks via
      display:none mid-hold and, on at least iOS Safari, can drop the
      pointerup a hidden element would otherwise have received. lookBack is
      deliberately not part of this: it has its own key (B) and blur is the
      one place it needs clearing, not every pause. */
  private clearLatchedInput() {
    // don't let held keys latch across alt-tab or a pause
    for (const k in this.keydown) this.keydown[k] = 0;
    /* The keyup for a held G never arrives if the tab lost focus (or the
       puck vanished) mid-flash. Clearing hiHeld also disarms the hold timer,
       so a G held through the gap cannot come back later having toggled the
       latch. */
    this.hiHeld = false;
    this.hiConsumed = false;
    this.input.th = this.input.br = this.input.st = this.input.hb = this.input.horn = 0;
    /* Analog steer state is not a key and so survives the loop above. A phone
       put down mid-corner, or left tilted through a pause, otherwise resumes
       still steering. */
    this.wheelVal = this.tiltVal = 0;
    this.wheelPointerId = null;
    for (const hold of this.touchHolds.values()) hold.ids.clear();
  }

  /* Window-level, capture phase: fires before any element's own listener can
     stopPropagation() (gearBtn's pointerdown does), so this is the one place
     that always sees a pointer go down or come back up regardless of which
     element the browser decided to target. livePointers is the ground truth
     watchdogTouchInput() checks a held control against — the element-level
     release listeners (pointerup/pointercancel/lostpointercapture on the
     puck itself) are the fast path; this is the one that cannot be skipped. */
  private onLivePointerDown = (e: PointerEvent) => {
    this.livePointers.add(e.pointerId);
  };
  private onLivePointerGone = (e: PointerEvent) => {
    this.livePointers.delete(e.pointerId);
  };

  /* touch-action:manipulation (globals.css canvas.game) only rules out
     double-tap-to-ZOOM; iOS 15+ still runs its double-tap text-selection
     magnifier off the synthetic click/dblclick pair a fast double tap on the
     canvas produces, and preventDefault on touchend is the only thing that
     stops that pair from firing. Canvas only: the menus sit on an opaque,
     full-screen .menuRoot above it, so a tap there never reaches this
     listener, and onPointerDown already handles every real canvas tap on
     pointerdown — nothing here depends on click/dblclick ever firing. */
  private onCanvasTouchEnd = (e: TouchEvent) => {
    e.preventDefault();
  };
  private onCanvasDblClick = (e: MouseEvent) => {
    e.preventDefault();
  };
  /* iOS-only pinch/rotate gesture events, unprevented by touch-action and
     ignored by every other browser — nothing in this fixed, non-zooming
     layout wants them. */
  private onGestureEvent = (e: Event) => {
    e.preventDefault();
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
    /* Canonicalised on the way in, not stored raw. getCar() resolves a locked
       or unknown id to the default car, and buildRig() below already goes
       through it — so storing the raw string gave the caller's car's ENGINE
       AUDIO on the default car's physics and shell. One resolve at the door
       means every reader downstream (the rig, the audio, `this.carId` itself)
       is talking about the same car. */
    this.carId = getCar(carId).id;
    this.paintIx = paintIx;
    // the garage is reachable from the main menu, where there is no rig to
    // rebuild yet — the load stage picks these up and builds the chosen car
    if (this.loaded) this.buildRig();
    this.audio.setCar(this.carId);
  }

  get spec(): CarSpec {
    return this.rig.spec;
  }

  /** The PhysicsSpec the car is actually driven with — its own, or the test
      mode derivation of it. stepPhysics reads this every substep and holds no
      state derived from it, so the K toggle takes effect on the next step
      with nothing to invalidate.

      The derived spec is memoised against the spec object it came FROM, not
      against the testMode flag: the garage is reachable from the pause menu,
      so the active car can change while test mode is on, and a cache keyed on
      the flag would keep driving the previous car's boosted numbers. */
  private testPhys: PhysicsSpec | null = null;
  private testPhysFor: PhysicsSpec | null = null;
  get phys(): PhysicsSpec {
    const own = this.spec.phys;
    if (!this.testMode) return own;
    if (this.testPhysFor !== own) {
      this.testPhysFor = own;
      this.testPhys = testDriveSpec(own);
    }
    return this.testPhys!;
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
    /* Photo mode owns the keyboard while it is up, the same way the pause
       menu does (the `!running` gate below) — but two keys still work, and
       they are photo mode's own: the shutter, and the way out. Everything
       else falls dead here so a stray C or R cannot mutate game state under
       a frozen sim. Esc is already handled above: pauseRequest lands in
       GameApp, which treats it as "leave photo mode" while this screen is up. */
    if (this.photo.on) {
      if (k === " " || k === "enter") this.photo.shot = true;
      else if (k === "o") this.ui.photoRequest();
      return;
    }
    /* O — photo mode. O because P is the music transport and O is the free key
       beside it (the CONTROLS screen documents it); also routed through the
       touch drawer's PHOTO row via uiKeyTap. Before the `!running` gate on
       purpose-adjacent grounds to the photo branch above, but still gated on
       running+loaded itself: from the pause or main menu there is nothing
       sensible to photograph and the screen machinery is mid-transition. */
    if (k === "o") {
      if (this.running && this.loaded) this.ui.photoRequest();
      return;
    }
    if (!this.running) return;
    if (k === "c") {
      this.camMode = nextCam(this.camMode);
      this.ui.toast(CAM_NAMES[this.camMode]);
    }
    if (k === "l") {
      this.car.lightsUser = !this.car.lightsUser;
      this.ui.toast("LIGHTS " + (this.car.lightsUser ? "ON" : "AUTO"));
    }
    /* Stalk click on the toggle edge, both engage and cancel — the click
       volumes that used to give the signals their mechanical clunk are gone
       (keyboard-only now, owner's call), but the stalk itself still moves.
       The blink-rate tick in hud() is separate and untouched. */
    if (k === "q") {
      this.car.sigL = !this.car.sigL;
      this.car.sigR = false;
      this.audio.stalkClick();
    }
    if (k === "e") {
      this.car.sigR = !this.car.sigR;
      this.car.sigL = false;
      this.audio.stalkClick();
    }
    if (k === "r") this.setRain(!this.rain);
    if (k === "t") {
      this.timeSpeed = this.timeSpeed === 0 ? 150 : this.timeSpeed === 150 ? 1500 : 0;
      this.ui.toast("TIME ×" + this.timeSpeed);
    }
    if (k === "v") {
      this.grade = !this.grade;
      /* the settings panel reads game.grade but the profile stores
         settings.dashcam — without this write the two disagree and the
         flip is lost on reload (persist() copies this.settings out) */
      this.settings.dashcam = this.grade;
      this.ui.toast("DASHCAM MODE " + (this.grade ? "ON" : "OFF"));
    }
    if (k === "m") {
      this.mirror = !this.mirror;
      this.rig.cockpit.setMirrorVis(this.mirror);
      this.ui.toast("MIRROR " + (this.mirror ? "ON" : "OFF"));
    }
    /* Wipers. U because it is free (the handler below spends I, and the
       retired J stays retired), and because the drawer's WIPERS row goes
       through uiKeyTap with this same letter — the row IS this key. Works on
       touch for exactly that reason: no isTouch gate, unlike I below. */
    if (k === "u") this.cycleWipers();
    /* J IS RETIRED — deliberately, and it is not coming back as a debug key.

       It A/B'd the donor Volvo (interior and exterior body, off one flag)
       against the procedural car, from a time when there was one car in the
       garage wearing both. There are two cars now, and the A/B is the garage:
       pick the VOLVO S90 for the donor cabin and donor body, pick the KAZE GT
       for the procedural ones. A key that could put the other car's interior
       in the car you selected would be a key that unpicks your choice, and
       nothing downstream (the lens offsets, the interior hood, the cabin
       hotspot) would have any way to know which car it was really drawing.

       No handler, no flag, no entry in the CONTROLS screen. `j` now falls
       through this switch to nothing, the same as every other unbound key. */
    if (k === "n") {
      this.resetCar();
      this.ui.toast("RESET");
    }
    /* Test mode — see Game.testMode. K because it is free, it is under the
       right hand next to the other A/B toggles (J, L), and W is the throttle.
       The toast is the only way to tell the two states apart from inside the
       car, so it is not optional decoration. */
    if (k === "k") {
      this.testMode = !this.testMode;
      this.ui.toast("TEST MODE " + (this.testMode ? "ON" : "OFF"));
    }
    /* Interior light. I for its initial, and it was free: the handler above
       already spends C L Q E R T V M J N K H X P B G and the , . transport
       pair, and W A S D, the arrows, space and F are the driving controls.

       DESKTOP ONLY, by explicit request — "it would only work on like desktop
       not the mobile version, ill mostly just use it for testing and
       comparing". Same gate the music transport uses. Belt and braces rather
       than strictly needed: the touch buttons write keydown[] directly and
       never reach this handler, so there is no path to it from a phone even
       without the test. There is no touch button and none is wanted — this is
       a tool for comparing the dark cabin against the lit one, not a control.

       Session-only, and deliberately NOT mirrored into settings the way V and
       X are. The dark cabin is the shipped look, so it has to be what every
       session opens on; a persisted flag would let a profile come back with
       the interior lit and quietly make the lit version the default again.

       The key is no longer the only way in: onPointerDown puts the same toggle
       on the overhead console, so it can be reached by pointing at the roof
       panel the lamp is actually in. The key stays — asked for explicitly, and
       it is the one that works with the console out of frame. */
    if (k === "i" && !this.isTouch) this.toggleCabinLight();
    if (k === "h") this.ui.helpRequest();
    if (k === "x") {
      this.mmap = !this.mmap;
      this.settings.mmap = this.mmap;
      const cv = this.miniMap();
      if (cv) cv.style.display = this.mmap ? "block" : "none";
      this.ui.toast("MAP " + (this.mmap ? "ON" : "OFF"));
    }
    /* Map zoom — Z for its initial, and it was free (see the key inventory on
       the I handler above; Z joins it). Cycles the HUD map between the
       close-up follow and the whole-loop overview (minimap.ts `zoom`). Three
       ways in, one body: this key, a click on the map itself (GameApp routes
       the canvas's pointerdown through uiKeyTap("z") — desktop only, the
       canvas keeps pointer-events:none on touch so it can't eat a throttle
       tap), and the touch drawer's MAP ZOOM row. Next %4 frame repaints, so
       no forced redraw is needed here. */
    if (k === "z") {
      this.mmapZoom = !this.mmapZoom;
      this.settings.mmapZoom = this.mmapZoom;
      this.ui.toast("MAP " + (this.mmapZoom ? "WHOLE LOOP" : "CLOSE-UP"));
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
      if (k === ".") this.music.next();
      else this.music.prev();
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
  /* Reach out and touch things in the cabin. Two controls so far: the
     transport glyphs on the in-dash screen, and the overhead console, which
     switches the dome light.

     ONE ray serves every target and both handlers — the click and the hover —
     so there is exactly one answer to "what is the cursor over" and the
     highlight can never point at something the click would miss.

     The ORDER of onPointerDown is the load-bearing part. Everything above the
     first target is the question every target asks — is this the left button,
     is the world live, is the camera inside the car, where is the cursor —
     and every gate that belongs to ONE control sits with that control, below.
     `music.enabled` used to be the second line of the handler, which quietly
     made "only while the stereo is on" a precondition of anything added here;
     the interior light is a tool for comparing the dark cabin against the lit
     one and has nothing to do with the music, so it must not inherit that. */
  private clickRay = (() => {
    const r = new THREE.Raycaster();
    /* cockpit.ts puts the whole interior shell on layer 1, and a Raycaster
       only tests objects whose layers intersect its own — a default (layer 0)
       raycaster never hits the head unit at all. It only ever intersects the
       targets it is handed one at a time, so testing every layer costs nothing
       and also covers a donor screen, which arrives from the GLB on layer 0. */
    r.layers.enableAll();
    return r;
  })();
  private clickNdc = new THREE.Vector2();
  /** Point `clickRay` through a client-space point. Off the canvas rect, not
      the window: the two agree today (canvas.game is position:fixed inset:0)
      but neither a click nor a mouse move is where the frame time is. */
  private aimRayAt(cx: number, cy: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.clickNdc.set(
      ((cx - r.left) / r.width) * 2 - 1,
      -((cy - r.top) / r.height) * 2 + 1
    );
    this.clickRay.setFromCamera(this.clickNdc, this.camera);
  }
  private aimRay(e: PointerEvent) {
    this.aimRayAt(e.clientX, e.clientY);
  }

  /** The overhead-console hit volume, or null when the pointer cannot be over
      it at all.

      Which console depends on which cabin is on show — cockpit.ts holds a
      volume for each and they are 28 cm apart — and the test is the one
      povMount() and cockpitEye() already use, because a donor that has not
      finished loading is not the cabin on show yet.

      The `inCar` gate is not politeness: a Raycaster ignores `visible`, so
      without it the console would be hoverable and clickable straight through
      the bodywork from CHASE and HOOD, where updateCamera() has hidden the
      whole cockpit group.

      `hover` is the only thing the touch gate belongs to. A touch device has
      no cursor, so a hover preview there could only ever latch on and stay —
      but the CLICK path is wanted on touch now (see roofTap), and hanging the
      device test on the target itself was what made the switch unreachable
      from a phone in the first place. */
  private cabinTarget(hover: boolean): THREE.Object3D | null {
    if (hover && this.isTouch) return null;
    if (!this.running || !this.loaded || !this.inCar()) return null;
    const ck = this.rig?.cockpit;
    if (!ck) return null;
    return ck.cabinSwitch(!!this.rig.cockpitModel);
  }

  /** The head-unit panel, when a pointer on it can do anything — or null.

      Desktop only, via `music.enabled` (false on touch): the panel's second
      view is the music player, and a phone has neither a player to drive nor
      a cursor to show which button it is on. On touch the panel stays what it
      is on desktop by default, a full-panel map, and nothing on it responds. */
  private screenTarget(): THREE.Mesh | null {
    if (this.isTouch || !this.music.enabled) return null;
    if (!this.running || !this.loaded || !this.inCar()) return null;
    return this.rig?.cockpit?.navPanel() ?? null;
  }

  /** The wiper stalk zone (console side of the head unit), or null. Desktop
      only, for the click as well as the hover: the drawer's WIPERS row is
      the touch way in — a fat finger hunting an invisible box beside the
      screen is not a control, and the roof band already spends the one
      screen-space tap region worth having. Same inCar gate as cabinTarget:
      the raycast ignores `visible`. */
  private wiperStalkTarget(): THREE.Object3D | null {
    if (this.isTouch) return null;
    if (!this.running || !this.loaded || !this.inCar()) return null;
    const ck = this.rig?.cockpit;
    if (!ck) return null;
    return ck.wiperSwitch(!!this.rig.cockpitModel);
  }

  /** The rear-view glass, when clicking it can toggle the dim — or null.
      A real visible mesh, not a proxy volume: the glass hangs in the
      dashcam frame's top rows by design (cockpit.ts MIR), so it is its own
      target in both cabins (a donor keeps the procedural glass — its own
      mirror is paint). Gated on the mirror being on show at all (M hides
      it), or the dim would answer from an empty patch of headliner. */
  private mirrorTarget(): THREE.Object3D | null {
    if (this.isTouch) return null;
    if (!this.running || !this.loaded || !this.inCar()) return null;
    if (!this.mirror) return null;
    return this.rig?.cockpit?.mirrorGlass ?? null;
  }

  /** Which pane the head unit is showing, and what the cursor is over on it.
      Session state, deliberately not persisted: the map is what the panel is
      FOR, so every session opens on it however the last one was left. */
  private screenView: ScreenView = "map";
  private screenHover: ScreenAction | null = null;

  /** 1 while the cursor is on the overhead console, 0 otherwise; cabinHoverE is
      it eased, and is what the light actually rides. See CABIN_LIGHT.hover. */
  private cabinHover = 0;
  private cabinHoverE = 0;
  private hoverX = 0;
  private hoverY = 0;
  /* Hover test for the overhead console. Cheap by construction — one ray
     against one twelve-triangle box, and only after the cursor has actually
     travelled — but it still runs on a firehose, so it does the least it can:
     the sub-3px bail kills the redundant work from a hand resting on a mouse
     without ever being able to swallow a real crossing of the target's edge.

     Nothing re-tests on its own between moves, and nothing needs to: both the
     console and the camera are fixed in the cabin, so the target does not
     travel across the frame while the car drives. The states where that stops
     being true are conditions rather than events, and cabinLightUpdate() clears
     the hover on all of them. */
  private onPointerMove = (e: PointerEvent) => {
    const dx = e.clientX - this.hoverX, dy = e.clientY - this.hoverY;
    if (dx * dx + dy * dy < 9) return;
    this.hoverX = e.clientX;
    this.hoverY = e.clientY;
    const sw = this.cabinTarget(true);
    const panel = this.screenTarget();
    const stalk = this.wiperStalkTarget();
    const mir = this.mirrorTarget();
    if (!sw && !panel && !stalk && !mir) {
      this.cabinHover = 0;
      this.screenHover = null;
      this.renderer.domElement.style.cursor = "";
      return;
    }
    /* ONE aim for every target, the same one onPointerDown uses. Two rays
       would be two answers to "what is the cursor over", and the highlight
       could then point at something the click would miss. */
    this.aimRay(e);
    this.cabinHover = sw && this.clickRay.intersectObject(sw, true).length ? 1 : 0;
    /* The panel is a single quad and the test is one intersect — cheap enough
       to run on a move firehose that has already survived the 3 px bail, and
       it has to run here or the transport buttons have no hover state at all,
       which is the whole reason the player got a view of its own. */
    const hit = panel ? this.clickRay.intersectObject(panel, false)[0] : undefined;
    this.screenHover =
      hit && hit.uv ? hitScreen(hit.uv.x, hit.uv.y, this.screenView) : null;
    /* The stalk zone and the mirror glass have no state to preview — the
       cursor change is their hover channel (round 1's precedent for targets
       with no lamp to ease toward), so a boolean each is all this needs. */
    const overStalk = !!stalk && this.clickRay.intersectObject(stalk, false).length > 0;
    const overMir = !overStalk && !!mir && this.clickRay.intersectObject(mir, false).length > 0;
    /* One cursor for every cabin target, new and old alike — none of them had
       one before this lane; a control that only reveals itself once you have
       already clicked it is not discoverable. */
    this.renderer.domElement.style.cursor =
      this.cabinHover || this.screenHover || overStalk || overMir ? "pointer" : "";
  };
  /* Leaving the canvas is a real event and gets a real listener: the last
     pointermove inside the window can easily be one that was still over the
     console, and without this the preview would stay up while the cursor sat
     in the browser chrome. */
  private onPointerLeave = () => {
    this.cabinHover = 0;
    this.screenHover = null;
    this.renderer.domElement.style.cursor = "";
  };
  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (!this.running || !this.loaded) return;
    if (!this.rig?.cockpit) return;
    /* The raycast ignores `visible`, so without this the controls would still
       be clickable — straight through the bodywork — from CHASE and HOOD,
       where updateCamera() has hidden the whole cockpit group. */
    if (!this.inCar()) return;
    this.aimRay(e);

    /* The overhead console, where a real car keeps its dome light. Same toggle
       as the I key so the two can never disagree, and the same volume the
       hover highlights, so what lit up is what responds. */
    const sw = this.cabinTarget(false);
    if (sw && this.hitCabinSwitch(e, sw)) {
      this.toggleCabinLight();
      return;
    }
    /* Touch's way to the same switch, and the reason it needs one: the roof
       console is ABOVE the dashcam's frame. Measured — the donor volume's
       nearest lit corner sits at a slope of 0.78 above the lens, against a
       top-of-frame slope of 0.37 at the default lens (0.55 on a portrait
       phone, where the vertical cap opens it up) — so in the one view the
       game is played in there is no pixel a finger could put a ray through.
       A padded ray cannot fix that; nothing can, short of a target that is
       not the console. So the tap region is screen-space instead: the top
       middle of the frame, which is where the roof is even when the panel
       itself is out of shot, and which is exactly what was asked for. Same
       toggleCabinLight() either way — this is a second WAY IN, not a second
       switch. In COCKPIT and CONSOLE, where the console IS in frame, the
       raycast above answers first and the tap lands on the real thing. */
    if (this.isTouch && this.inRoofBand(e)) {
      this.toggleCabinLight();
      return;
    }

    /* The wiper stalk zone and the rear-view glass — both desktop-mouse
       (their targets are null on touch; wipers reach a phone through the
       drawer row instead). Tested before the head unit so the ORDER between
       the two 3D targets and the panel is fixed here rather than by
       accident of depth; none of the three volumes overlap in space, so the
       order is only about who reads first. */
    const stalk = this.wiperStalkTarget();
    if (stalk && this.clickRay.intersectObject(stalk, false).length) {
      this.cycleWipers();
      return;
    }
    const mir = this.mirrorTarget();
    if (mir && this.clickRay.intersectObject(mir, false).length) {
      this.toggleMirrorDim();
      return;
    }

    /* The head unit is a CanvasTexture on a plane, so this hands the hit UV to
       carscreen.ts, which owns the layout and therefore the button rects.
       Desktop only, via screenTarget()/music.enabled, which is false on touch:
       phones get the map and no way off it. */
    const panel = this.screenTarget();
    if (!panel) return;
    const hit = this.clickRay.intersectObject(panel, false)[0];
    if (!hit || !hit.uv) return;
    const action = hitScreen(hit.uv.x, hit.uv.y, this.screenView);
    if (!action) return;
    if (action === "music" || action === "map" || action === "trip" || action === "game") {
      this.screenView = action;
      /* The hover is stale the instant the view flips — the cursor has not
         moved, but what is under it has. Re-ask with the ray already aimed. */
      this.screenHover = hitScreen(hit.uv.x, hit.uv.y, this.screenView);
      return;
    }
    if (action === "volDown" || action === "volUp") {
      const msg = this.music.stepVolume(action === "volUp" ? 1 : -1);
      if (msg) this.ui.toast(msg);
      return;
    }
    /* Trip reset: all a reset ever is — remember where the odometer stood.
       The pane subtracts (carscreen.ts drawTrip), so the readout zeroes on
       the very next repaint. */
    if (action === "tripReset") {
      this.tripBase = this.car.odo;
      this.audio.stalkClick();
      this.ui.toast("TRIP RESET");
      return;
    }
    if (action === "dimScr") {
      this.screenDim = !this.screenDim;
      this.audio.stalkClick();
      this.ui.toast("SCREEN DIM " + (this.screenDim ? "ON" : "OFF"));
      return;
    }
    if (action === "prev" || action === "toggle" || action === "next") {
      const msg = this.music.click(action);
      if (msg) this.ui.toast(msg);
      return;
    }
    /* Everything left is the games pane's (consolegame.ts) — the ordering
       above is what narrows the type down to GameAction. The blip rides the
       "it actually did something" edge, through the same master chain as
       every other UI sound, so volume and mute apply unchanged. The hover
       re-ask matches the view-switch above: a landed mark changes what is
       under the still-parked cursor. */
    if (gameClick(action)) {
      this.audio.tick();
      this.screenHover = hitScreen(hit.uv.x, hit.uv.y, this.screenView);
    }
  };

  /** Did this pointer hit the overhead console? A mouse gets the one ray it
      aimed; a FINGER gets four more on a ring around it, because a fingertip
      is a ~9 mm contact patch and the console is a small box read at an angle.
      Only on the click path and only on touch, so it costs nothing anywhere
      else — and it is four more tests against one twelve-triangle box. */
  private hitCabinSwitch(e: PointerEvent, sw: THREE.Object3D): boolean {
    if (this.clickRay.intersectObject(sw, true).length) return true;
    if (!this.isTouch) return false;
    for (const [ox, oy] of TAP_RING) {
      this.aimRayAt(e.clientX + ox * TAP_PAD_PX, e.clientY + oy * TAP_PAD_PX);
      if (this.clickRay.intersectObject(sw, true).length) return true;
    }
    this.aimRay(e); // leave the ray where the caller aimed it
    return false;
  }

  /** The roof tap region — see ROOF_TAP. Fractions of the canvas rect rather
      than of the window, same as aimRayAt, so a canvas that is ever inset
      still measures its own frame. */
  private inRoofBand(e: PointerEvent): boolean {
    const k = this.roofTapKnob();
    if (!(k.top > 0)) return false;
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    return y <= k.top && Math.abs(x - 0.5) <= k.half;
  }
  /** Live knob for the roof tap region — see ROOF_TAP. */
  private roofTapKnob(): typeof ROOF_TAP {
    if (!window.__roofTap) window.__roofTap = { ...ROOF_TAP };
    return window.__roofTap;
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

  /** Binds a hold-style control (a touch puck) with pointer-id tracking
      instead of "any pointerup reaching this element releases it": without
      that, a second finger that never pressed this element — e.g. it came
      down on the canvas, which never captures — can lift directly over the
      puck and its pointerup targets the puck by ordinary hit-testing, killing
      the first finger's still-held press. onDown fires once per press (ids
      empty -> non-empty), onUp once per full release (ids non-empty ->
      empty), so a second finger on the SAME puck keeps it held until both
      lift.

      State is written before setPointerCapture, and capture is wrapped in
      try/catch: a fast tap can have the pointer already gone by the time
      capture runs (throws NotFoundError), and with capture first that used to
      abort the handler before the state write ever ran — a press that looked
      like it landed but did nothing, for a frame or forever. Capture only
      matters for what happens if the finger later drifts off the element; it
      must never be able to veto the press itself. */
  private bindPointerHold(el: HTMLElement, onDown: () => void, onUp: () => void): Set<number> {
    const ids = new Set<number>();
    el.addEventListener("pointerdown", (e) => {
      const first = ids.size === 0;
      ids.add(e.pointerId);
      if (first) onDown();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {}
    });
    const release = (e: PointerEvent) => {
      if (!ids.delete(e.pointerId)) return; // not a pointer this element is holding — ignore
      if (ids.size === 0) onUp();
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    /* The browser's own "this element no longer owns that pointer" signal —
       capture stolen by another element, or (confirmed in Chrome, unverified
       on iOS Safari — see brief risk notes) display:none while captured,
       which is exactly what gearBtn's pause does mid-hold. Fires whether or
       not pointerup/pointercancel ever does, so it is the second of three
       release paths (element release, this, the frame watchdog below). */
    el.addEventListener("lostpointercapture", release);
    return ids;
  }

  /** Runs every frame (readInput). watchdogTouchInput is the third release
      path, for whatever the first two — the puck's own pointerup/cancel, and
      lostpointercapture — both miss: an iOS gesture hijack that eats the
      touch stream outright and never tells the element anything. livePointers
      is tracked at the window in the capture phase, so it is the one signal
      that cannot be blocked the same way; a held control whose pointer isn't
      in there anymore has no finger on it, whatever the element thinks. */
  private watchdogTouchInput() {
    if (!this.isTouch) return;
    for (const hold of this.touchHolds.values()) {
      if (this.keydown[hold.key] !== 1) continue;
      for (const id of hold.ids) if (!this.livePointers.has(id)) hold.ids.delete(id);
      if (hold.ids.size === 0) this.keydown[hold.key] = 0;
    }
    if (this.wheelPointerId !== null && !this.livePointers.has(this.wheelPointerId)) {
      this.wheelVal = 0;
      this.wheelPointerId = null;
    }
  }

  /** Is `key` still held by some OTHER live touch hold? Two controls now
      share "f" — the HORN puck and the steering-wheel hub (setWheelHorn) —
      and either may be released while the other is still pressed. Without
      this, letting go of one zeroes the key under the other and the horn
      cuts out with a finger still on it. Holds whose ids are empty are
      already released (bindPointerHold clears the set before calling onUp,
      and the blur reset clears every set), so size is the live test. */
  private keyStillHeld(key: string) {
    for (const h of this.touchHolds.values()) if (h.key === key && h.ids.size) return true;
    return false;
  }

  /** Horn from the steering-wheel hub — see SteerWheel in GameApp, which owns
      the tap/drag discrimination. Writes the same keydown["f"] the HORN puck
      and the keyboard write, so there is exactly one horn path downstream.

      `pointerId` non-null registers the press in touchHolds under a synthetic
      id, which buys the hub the identical third release path every puck has:
      watchdogTouchInput drops it the frame that pointer leaves livePointers,
      so a gesture hijack that eats the touch stream cannot leave the horn
      blaring. Null is the tap-stab — its finger is already off the glass, so
      it must NOT be watchdogged (that would kill the stab on the next frame);
      the caller's own timer releases it. */
  setWheelHorn(on: boolean, pointerId: number | null) {
    if (on) {
      this.keydown["f"] = 1;
      if (pointerId !== null) this.touchHolds.set(WHEEL_HORN_HOLD, { key: "f", ids: new Set([pointerId]) });
      return;
    }
    this.touchHolds.delete(WHEEL_HORN_HOLD);
    if (!this.keyStillHeld("f")) this.keydown["f"] = 0;
  }

  private bindInput() {
    addEventListener("keydown", this.onKeyDown);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    /* Hover feedback for the overhead console. On the canvas rather than the
       window so the preview cannot be driven by a cursor sitting over the HUD
       or the pause overlay, and paired with pointerleave so it lets go. */
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.onPointerLeave);
    addEventListener("keyup", this.onKeyUp);
    if (this.isTouch) {
      // capture phase: see onLivePointerDown/onLivePointerGone
      addEventListener("pointerdown", this.onLivePointerDown, true);
      addEventListener("pointerup", this.onLivePointerGone, true);
      addEventListener("pointercancel", this.onLivePointerGone, true);
      this.renderer.domElement.addEventListener("touchend", this.onCanvasTouchEnd, { passive: false });
      this.renderer.domElement.addEventListener("dblclick", this.onCanvasDblClick);
      document.addEventListener("gesturestart", this.onGestureEvent, { passive: false });
      document.addEventListener("gesturechange", this.onGestureEvent, { passive: false });
    }
    const bindHold = (id: string, key: string) => {
      const el = document.getElementById(id);
      if (!el) return;
      const ids = this.bindPointerHold(
        el,
        () => (this.keydown[key] = 1),
        () => {
          // "f" is shared with the wheel hub; never zero it out from under
          // a control that is still pressed (see keyStillHeld).
          if (!this.keyStillHeld(key)) this.keydown[key] = 0;
        },
      );
      this.touchHolds.set(id, { key, ids });
    };
    bindHold("tcL", "a");
    bindHold("tcR", "d");
    bindHold("tcG", "w");
    bindHold("tcB", "s");
    /* Horn rides bindHold because input.horn is a per-frame read of keydown["f"]
       (see the input block in frame()), so a held button is all it needs. */
    bindHold("tcH", "f");
    /* Flash cannot: see hiBeamDown/hiBeamUp. Same press/release pair as G, so
       tap = flash and a 2 s hold = latch, identical to the keyboard. Not
       registered in touchHolds — hiBeamHold() already self-clears hiHeld once
       HI_HOLD passes, so a missed release heals within that window on its
       own without the frame watchdog's help. */
    const flashBtn = document.getElementById("tcF");
    if (flashBtn) {
      this.bindPointerHold(
        flashBtn,
        () => this.hiBeamDown(),
        () => this.hiBeamUp(),
      );
    }
    const camBtn = document.getElementById("tcC");
    if (camBtn)
      camBtn.addEventListener("pointerdown", () => {
        this.camMode = nextCam(this.camMode);
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
  /** The touch overflow drawer's one route into the game: press and release a
      key, exactly as the keyboard would. Going through onKeyDown/onKeyUp
      rather than a parallel switch keeps a drawer row and the key it stands
      for from ever drifting apart — same toggle body, same toast, same
      settings write, same started/running guards. The immediate release
      leaves keydown[] at 0, so nothing here can latch; a synthesized event
      has e.repeat false, so the once-per-press logic sees a clean press. */
  uiKeyTap(k: string) {
    this.onKeyDown(new KeyboardEvent("keydown", { key: k }));
    this.onKeyUp(new KeyboardEvent("keyup", { key: k }));
  }
  setWheelVal(v: number) {
    this.wheelVal = v;
  }
  /** Which pointer #swheel considers itself grabbed by, or null when let go —
      set by GameApp's SteerWheel on pointerdown/end so watchdogTouchInput can
      tell a live drag from a wheelVal a lost gesture left behind. */
  setWheelPointer(id: number | null) {
    this.wheelPointerId = id;
  }

  private dom(id: string): HTMLElement | null {
    const c = this.domCache.get(id);
    if (c && c.isConnected) return c;
    const el = document.getElementById(id);
    this.domCache.set(id, el);
    return el;
  }
  private miniMap(): HTMLCanvasElement | null {
    return this.dom("mmap") as HTMLCanvasElement | null;
  }

  /** Whether the HUD overlay minimap should be on screen at all: the setting,
      and no in-car view — all of those have the head unit's own map
      (carscreen.ts), which is the one the player reads there. The console
      camera looks straight down the tunnel at that screen, so it is the last
      one that wants a second map pasted over it. */
  private mmapVisible() {
    // photo mode reads as "not in car", but the map canvas is HUD chrome and
    // photo mode hides ALL chrome — without this it would pop up over the shot
    return this.mmap && !this.inCar() && !this.photo.on;
  }
  /** last mmapVisible(), so the reveal can repaint before it is shown */
  private mmapWasOn = false;
  /** the overview framing's opts, held so the per-frame draw allocates
      nothing; the follow framing is drawMiniMap's default (undefined) */
  private mmapLoopOpts: MiniMapOpts = { zoom: "loop" };

  /* Held on the Game rather than rebuilt per frame: readInput runs at frame
     rate and these two closures never change. Bodies are deliberately the
     same as the `c` and `l` key handlers — the pad is an extra way to press
     the same controls, not a second set of semantics. */
  private padEdge: PadEdge = {
    cam: () => {
      this.camMode = nextCam(this.camMode);
      this.ui.toast(CAM_NAMES[this.camMode]);
    },
    lights: () => {
      this.car.lightsUser = !this.car.lightsUser;
      this.ui.toast("LIGHTS " + (this.car.lightsUser ? "ON" : "AUTO"));
    },
  };

  private readInput(dt: number) {
    this.watchdogTouchInput();
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
    /* A pad that is connected AND being used owns the frame and writes the
       whole input itself; otherwise this returns false and the keyboard/touch
       path below runs exactly as it did before. It is handed the same
       speed-sensitive steer rate the keyboard uses, so full lock stays as
       hard to reach at 40 m/s with a stick as with the A/D keys. */
    const padRate = lerp(3.4, 1.7, clamp(Math.abs(this.car.u) / 40, 0, 1));
    if (pollGamepad(this.input, dt, padRate, this.padEdge)) return;
    const tT = kd["w"] || kd["arrowup"] ? 1 : 0;
    const tB = kd["s"] || kd["arrowdown"] ? 1 : 0;
    const sL = kd["a"] || kd["arrowleft"] ? 1 : 0;
    const sR = kd["d"] || kd["arrowright"] ? 1 : 0;
    this.input.th += clamp(tT - this.input.th, -4.2 * dt, 3.2 * dt);
    this.input.br += clamp(tB - this.input.br, -6 * dt, 5.2 * dt);
    let sTarget = sL - sR;
    const analog = this.isTouch && this.settings.steerMode !== "buttons";
    if (analog) sTarget = this.settings.steerMode === "wheel" ? -this.wheelVal : -this.tiltVal;
    /* The keyboard rate droops hard with speed — 3.4 at rest down to 1.7 past
       144 km/h — and in TEST MODE that droop is the single biggest thing
       standing between the player and the car.

       It bites worst on a REVERSAL, which is the manoeuvre threading traffic
       is made of. Full left to full right is a stick distance of 2, and the
       BOOST below is `1 + 2.2*(1 - |st|)`, i.e. exactly 1x at full lock — so a
       flick from one stop to the other STARTS at the slowest rate the filter
       has. At 1.7/s that is 1.18 s for the input alone, before the steer angle
       or the tyres are involved at all. Reported as "when i turn from left to
       right qucikly its so slow to react", and the report is about this line
       rather than about the physics.

       Test mode flattens the droop to 4.6 -> 4.0 instead. A reversal at speed
       becomes 0.5 s, and because the curve is nearly flat the car answers the
       same way at 200 km/h as it does at 60 — which is the arcade promise.
       Measured through test/steer-response-sim.mjs --keyfix: time to 25% of
       target falls 47% at 180 km/h and 46% at 250, versus 37%/35% from the
       physics-side work alone.

       STOCK IS UNTOUCHED — the original lerp is still the other arm, so a car
       driven with test mode off filters exactly as it always did. */
    const sDroop = clamp(Math.abs(this.car.u) / 40, 0, 1);
    let sRate = analog
      ? 7
      : this.testMode
        ? lerp(4.6, 4.0, sDroop)
        : lerp(3.4, 1.7, sDroop);
    /* Test mode only: a PROGRESSIVE ramp instead of a flat one.

       The flat ramp is the single biggest source of the "it takes a bit to
       actually turn" feel, and it is worse the faster you go — measured, 0 to
       full stick is 0.39 s at 72 km/h and 0.59 s at 144 km/h, against just
       0.15 s for the steer angle itself to follow. The keyboard filter, not
       the physics, is the lag.

       Rather than raise it flat — which makes the whole range twitchy and
       removes the thing stopping an instant full-lock spin — the rate is
       scaled by how far from full stick you still are: quick off centre where
       turn-in bite lives, settling back to roughly the stock rate as it
       approaches the stop. Small corrections feel immediate, full lock still
       takes deliberate effort.

       `1 - |st|` at centre is 1, so the first part of the travel runs at
       BOOST x the stock rate; at 80% stick it is back to ~1.4x. */
    if (this.testMode && !analog) {
      const BOOST = 3.2;
      sRate *= 1 + (BOOST - 1) * (1 - Math.abs(this.input.st));
    }
    this.input.st += clamp(sTarget - this.input.st, -sRate * dt, sRate * dt);
    if (!sL && !sR && !analog) this.input.st *= Math.max(0, 1 - 6.5 * dt);
    this.input.hb = kd[" "] ? 1 : 0;
    /* One horn path for all three inputs: the F key, the HORN puck (bindHold)
       and the steering-wheel hub (setWheelHorn) all write keydown["f"], so the
       mix, the NPC reaction and the release edge behave identically whichever
       one honked. */
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
    /* grade/mmap/rain are live engine state mirrored from settings. The
       in-game keys write both sides, so this only moves them when the panel
       does — including Reset-to-defaults, which Object.assigns the settings
       and would otherwise leave the engine disagreeing with the saved value.
       The rain guard matters: this runs on every slider tick and setRain
       toasts. `time` is deliberately not mirrored — forcing it each tick
       would fight the day/night cycle. */
    this.grade = s.dashcam;
    this.mmap = s.mmap;
    this.mmapZoom = s.mmapZoom;
    if (this.rain !== s.rain) this.setRain(s.rain);
    // re-resolve the tier: the manual override lives in these settings, and a
    // change has to land on the same frame the settings panel applies it
    this.renderTier = resolveRenderTier(s, this.isTouch, this.renderer.getContext());
    this.tierCaps = TIER_CAPS[this.renderTier];
    // a tier flip changes the mirror/reflection RT policy even when the pixel
    // ratio happens not to move — force the target rebuild path below
    if (this.post.setMobile(this.tierCaps.mirrorHalf)) this.lastPR = -1;
    // tier flips retarget the cinematic extras on the same frame too
    this.post.setCinema(!!this.tierCaps.dualBloom, !!this.tierCaps.filmLook);
    // ...and the POV grade profile (console-edited knobs survive the flip)
    this.post.setPovProfile(this.renderTier);
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
    /* THE ONLY WRITER of castShadow — see sunShadow() for why that matters and
       what took over the per-frame job. This is the one path that is allowed to
       recompile the scene's materials, and it is a safe one: the settings panel
       is a menu, and the user is not driving through the hitch.

       Assigning the same boolean on every slider tick is free. `castShadow` is
       a plain property with no setter; the recompile comes from the shadow
       COUNT in the program cache key changing, which an unchanged value cannot
       do. Only a real flip of the shadows setting costs anything.

       The one-shot below is a pre-warm as much as a refresh. This call runs
       twice during the staged load, the second time with the world's materials
       built, so the first depth pass — which is where every mesh's depth
       program gets compiled — lands behind the loading screen rather than on
       the frame at dawn when sunShadow() first unfreezes the map. Best effort:
       whatever has not streamed in by then still compiles when it arrives, the
       same as it does today. */
    this.sun.castShadow = s.shadows;
    this.sun.shadow.needsUpdate = true;
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
    this.settings.rain = on;
    /* The wipers follow the weather so an untouched game behaves exactly as
       it did before modes existed: rain arriving with the wipers OFF brings
       them on at LO, rain leaving parks them whatever mode was running. The
       driver can still cycle to OFF *in* the rain — that is the whole
       droplet-accumulation feature — and rain stays the reset switch either
       way. No toast and no stalk click for these: they are the weather
       moving the stalk, not the driver. */
    if (on && this.wiperMode === 0) this.wiperMode = 2;
    if (!on && this.wiperMode !== 0) {
      this.wiperMode = 0;
      this.wipeDir = 0;
    }
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
    /* Pausing hides the touch pucks (display:none) out from under whatever
       finger is holding one — see clearLatchedInput — so a held throttle or
       a mid-turn wheel drag cannot resume the instant Drive comes back. */
    if (!run) this.clearLatchedInput();
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
    this.photoExit(); // no-op unless mid-photo; drops the mode's canvas listeners
    cancelAnimationFrame(this.raf);
    removeEventListener("keydown", this.onKeyDown);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointerleave", this.onPointerLeave);
    removeEventListener("keyup", this.onKeyUp);
    removeEventListener("resize", this.onResize);
    window.removeEventListener("error", this.onWindowError);
    window.removeEventListener("blur", this.onWindowBlur);
    if (this.isTouch) {
      removeEventListener("pointerdown", this.onLivePointerDown, true);
      removeEventListener("pointerup", this.onLivePointerGone, true);
      removeEventListener("pointercancel", this.onLivePointerGone, true);
      this.renderer.domElement.removeEventListener("touchend", this.onCanvasTouchEnd);
      this.renderer.domElement.removeEventListener("dblclick", this.onCanvasDblClick);
      document.removeEventListener("gesturestart", this.onGestureEvent);
      document.removeEventListener("gesturechange", this.onGestureEvent);
    }
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
    /* Geometry, the rain PointsMaterial and 96 SpriteMaterials. Optional-chained
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
      /* On the bypass or the mountain road: put the car back on its CURRENT
         route edge — snapping to the corridor from either would teleport it
         sideways (and, from the viaduct, 12 m down). Mid-lane... except on
         the mountain road, whose "middle" is the double yellow: there the
         car goes back to the FORWARD lane centre (−lat, keep-right). */
      const e = this.world.routes!.edge(bySurf.edgeId) as PolyRouteEdge;
      const s = Math.max(4, Math.min(e.len - 4, bySurf.s));
      const off = bySurf.edgeId === MOUNTAIN_EDGE
        ? e.laneOffset(0, s)
        : e.laneOffset(Math.floor(e.lanes(s) / 2), s);
      const w = e.worldOf(s, off);
      car.x = w.x;
      car.y = w.y;
      car.z = w.z;
      car.h = e.poseAt(s).h;
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

  /** Fade the sun's shadows in and out with the clock — WITHOUT touching
      `castShadow`, which is the whole point of this method existing.

      `castShadow` is not a look, it is STRUCTURE. It feeds the directional
      shadow COUNT in three's program cache key, so flipping it re-derives the
      defines for every lit material in the scene and recompiles all of them in
      one frame. This used to be assigned here, every frame, as
      `f > 0.22 && !perfMode && settings.shadows` — so every in-game dawn
      rebuilt every shader the moment f crossed 0.22, which is the one-to-two
      second stall the user reported at the night/day transition. It also armed
      a second, unreported one: perfMode latches true from perfCheck() after
      four slow seconds, and hitting that in daylight recompiled everything
      again, at the exact moment the frame budget was already blown.

      So castShadow is set once, from settings.shadows, in applySettings() —
      which is reachable only from the menu, where a recompile costs nothing —
      and the two things that used to ride on it move to channels that carry no
      defines at all:

      - `shadow.intensity` is a plain uniform (r180; the shader does
        `mix(1.0, shadow, shadowIntensity)`), so at 0 the shadow term is
        EXACTLY 1.0 and the depth map is ignored no matter what is in it. That
        is what makes freezing the map below safe — not an argument about the
        night sun being dim, which would only have made a stale shadow faint
        rather than absent.
      - `shadow.autoUpdate` is read by WebGLShadowMap per light before it
        renders anything, so dropping it stops a 2048x2048 depth pass per frame
        without changing a single program.

      WHAT THIS COSTS, stated plainly: keeping the defines constant means the
      PCF-soft shadow lookup stays in the fragment shader at night, where the
      old boolean compiled it out. That is a per-pixel tap on every lit surface
      buying nothing visible — sub-millisecond, but not free. It is the right
      trade against a multi-second hitch the user feels at every dawn, and it is
      not a trap for anyone who cannot afford it: `settings.shadows` off makes
      castShadow false and takes the sampling out of the shader entirely, the
      same as it always did.

      The ramp replaces the old hard threshold rather than reproducing it. 0.22
      sits at the centre of the window, so shadows still arrive at the hour
      they always did — they now take about 16 real seconds at the default
      clock speed to reach full strength instead of appearing between two
      frames, and dusk is the same in reverse. Weak, half-strength shadows
      under a low sun are also what dawn actually looks like. */
  private sunShadow(f: number) {
    const w = clamp((f - 0.1) / 0.24, 0, 1);
    // smoothstep, so the ramp has no kink where it leaves 0 or reaches 1
    const want =
      this.settings.shadows && !this.perfMode ? w * w * (3 - 2 * w) : 0;
    const s = this.sun.shadow;
    s.intensity = want;
    /* Rendering the map is worth paying for only while something samples it.
       The flag is only written on the edge — assigning it every frame would be
       harmless, but the edge is also where the map has to be brought back up
       to date after however long it spent frozen. */
    const live = want > 0.001;
    if (s.autoUpdate !== live) {
      s.autoUpdate = live;
      if (live) s.needsUpdate = true;
    }
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
    /* Laps completed: the high-water of `loops`, so reversing back across the
       seam and re-crossing it forward cannot bank the same lap twice. */
    if (this.loops > this.stats.laps) this.stats.laps = this.loops;
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
    if (this.cor.heightAt(car.x, car.z, 14) === null) {
      /* Off the deck. The mountain pass climbs through a rock cut (uphill
         face west, jittered rock both sides mid-route) — a one-sided canyon,
         so it gets a PARTIAL enclosure, never a tunnel's. The fade envelope
         is the same sstep window highway.ts's rockK() uses for the rock
         HEIGHT, so what you hear closing in is exactly what is drawn closing
         in, and both ends fade over ~50m — no hard cuts, the audio fade rule
         is the light fade rule. 0.32 peak stays under the tunnel thump/
         shimmer gates (0.5+), so the pass can never fire portal effects. */
      const hit = this.world.routes?.surfaceAt(car.x, car.z, 2);
      if (hit && hit.edgeId === MOUNTAIN_EDGE && this.world.routes) {
        const len = this.world.routes.mtn.len;
        const ss = (v: number) => {
          const x = clamp(v, 0, 1);
          return x * x * (3 - 2 * x);
        };
        return 0.32 * ss((hit.s - 18) / 50) * ss((len - 22 - hit.s) / 50);
      }
      return 0; // bypass viaduct and anywhere else off-deck: open air
    }
    const zc = this.cor.zAt(car.x, car.z);
    let v = clamp(this.cor.tunnelBlend(zc), 0, 1);
    /* Crossings overhead get a brief reverb kiss, faded in and out — the
       girder overpasses (corridor.OVERPASSES) and the bypass deck where it
       crosses the main route (routes.crossings). A slab 9m up does add a
       real early reflection for the ~25m you are under it; 0.2-0.22 peak is
       an audible flick of the tail, nowhere near the growl/thump territory
       (those gate at 0.5+), and the 14m shoulder fade at 30m/s is ~half a
       second each side — a swell, not a switch. */
    for (const o of OVERPASSES) {
      const half = o.girderW / 2, fade = 14;
      const d = Math.abs(zc - o.z);
      if (d < half + fade) {
        const x = clamp(1 - (d - half) / fade, 0, 1);
        v = Math.max(v, 0.22 * x * x * (3 - 2 * x));
      }
    }
    const crossings = this.world.routes?.crossings;
    if (crossings)
      for (const cr of crossings) {
        const mid = (cr.z0 + cr.z1) / 2, half = (cr.z1 - cr.z0) / 2, fade = 14;
        const d = Math.abs(zc - mid);
        if (d < half + fade) {
          const x = clamp(1 - (d - half) / fade, 0, 1);
          v = Math.max(v, 0.2 * x * x * (3 - 2 * x));
        }
      }
    return v;
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
    /* Ahead of the early return, because the mirror has a SECOND edge the
       audio does not: the donor interior loads async, so the handle can arrive
       long after the last camera change and would otherwise sit on whatever
       framing wire() defaulted to until the player next pressed C. */
    this.mirrorFramingUpdate();
    if (this.camMode === this.lastInteriorMode) return;
    this.lastInteriorMode = this.camMode;
    /* The console camera is a plain cabin mic: it is inside the shell like the
       cockpit, and unlike the dashcam it is not pressed against the glass. */
    this.audio.setInterior(
      this.camMode === CAM_POV ? "pov" : this.inCar() ? "cabin" : "out"
    );
  }

  /** Point the donor's rear-view mirror at whichever camera is looking at it.

      DASHCAM gets the tuned framing it has always had — housing hidden, glass
      walked into the top of the frame. Every other camera gets the OEM housing
      on show with the glass seated in it, which is what the cockpit and console
      views are close enough to read as a mirror rather than a lump. CHASE and
      HOOD are lumped in with them and neither cares: updateCarVisual hides the
      whole cockpit group in both.

      Edge-triggered on the pair (handle, framing) rather than on camMode, so it
      also fires the first frame after the donor lands. */
  private mirrorFramingUpdate() {
    const m = this.rig?.cockpitModel ?? null;
    const want: MirrorFraming = this.camMode === CAM_POV ? "dashcam" : "cabin";
    if (m === this.mirrorFramedFor && want === this.mirrorFramedAs) return;
    this.mirrorFramedFor = m;
    this.mirrorFramedAs = want;
    m?.setMirrorFraming(want);
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
    /* Pass-by whoosh: fire the one-shot at the exact frame an NPC's
       longitudinal position relative to the player's heading changes sign —
       the moment it crosses the player's ears, in either direction (the
       unpassable rival re-passing the player is the loud case). Keyed on the
       Npc object itself (WeakMap — dead cars just fall out), with a jump
       guard so a spawn, despawn-reuse or seam splice teleporting a car
       across the plane cannot read as a pass. */
    const sh = Math.sin(car.h), ch = Math.cos(car.h);
    for (const s of samples) {
      if (!s.npc) continue;
      const dx = s.x - car.x, dz = s.z - car.z;
      const relLong = dx * sh + dz * ch;
      const prev = this.passbyPrev.get(s.npc);
      this.passbyPrev.set(s.npc, relLong);
      if (prev === undefined) continue;
      if ((prev > 0) === (relLong > 0)) continue;
      if (Math.abs(relLong - prev) > 15) continue; // teleport, not a pass
      const closing = Math.abs((s.vx - car.wvx) * sh + (s.vz - car.wvz) * ch);
      this.audio.npcPassby(closing, dx * ch - dz * sh);
    }
    for (const n of this.traffic.closeCalls()) {
      if (n.ccKind === "chirp") this.audio.npcChirp(n.x, n.z);
      else this.audio.npcHorn(n.x, n.z, n.type === "truck" || n.type === "bus");
    }
  }

  /** Live refs into glowPts' shader, written by tintLampsSodium()'s
      onBeforeCompile patch below — chunksUpdate() updates these every frame
      with the SAME scaled draw distance it uses for the town chunks, so the
      shader's per-fragment lamp fade always tracks the chunk cull. */
  private lampFade?: { uFadeNear: { value: number }; uFadeFar: { value: number } };

  /** Street and deck lamps are built as one pooled sprite cloud plus one
      ground-quad batch. Both come out of the town builder as a generic warm
      white; retint them once, here, to low-pressure sodium — the orange is
      most of what says "road at night" in the reference, and a wider sprite
      with additive blending gives each head the halation a real lamp has in
      damp air instead of a flat dot.

      This is also the fix for the far-city lights blinding the player
      (brief-world-lights.json): PointsMaterial's built-in fog mixes each
      fragment toward the fog COLOUR, which under additive blending means a
      lamp can never fade to black — hundreds of them compress into a few
      hundred pixels at the horizon, sum past 1.0 luma and trip the bloom
      threshold. `fog:false` plus an onBeforeCompile patch that fades alpha
      explicitly by distance (and clamps a distance-attenuated point size in
      place of the old flat 9.8 px) fixes it at the root — a FADE, never a
      hard stop, using the same distance chunksUpdate() already culls the
      town chunks at. */
  private tintLampsSodium() {
    const g = this.world.glowPts?.material as THREE.PointsMaterial | undefined;
    if (g) {
      g.color.setHex(0xffa235);
      g.size = 9.8;
      g.blending = THREE.AdditiveBlending;
      g.fog = false;
      g.onBeforeCompile = (sh) => {
        sh.uniforms.uFadeNear = { value: 300 };
        sh.uniforms.uFadeFar = { value: 700 };
        this.lampFade = { uFadeNear: sh.uniforms.uFadeNear, uFadeFar: sh.uniforms.uFadeFar };
        sh.vertexShader = sh.vertexShader
          .replace(
            "uniform float size;",
            "uniform float size;\nuniform float uFadeNear;\nuniform float uFadeFar;\nvarying float vLampFade;"
          )
          .replace(
            "gl_PointSize = size;",
            /* lampDist is view-space depth — the same quantity the built-in
               sizeAttenuation branch below would have divided by — so size
               and fade move on one curve instead of clipping at different
               points and printing a ring. Clamped to [2, size] px: a lamp
               at 60 m still reads its old flat 9.8 px, one past the fade
               distance is a 2 px dot at ~0 alpha rather than vanishing. */
            "float lampDist = -mvPosition.z;\n" +
              "gl_PointSize = clamp( size * 55.0 / max( lampDist, 1.0 ), 2.0, size );\n" +
              "vLampFade = 1.0 - smoothstep( uFadeNear, uFadeFar, lampDist );"
          );
        sh.fragmentShader = sh.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vLampFade;")
          .replace(
            "#include <map_particle_fragment>",
            "#include <map_particle_fragment>\ndiffuseColor.a *= vLampFade;"
          );
      };
      g.needsUpdate = true;
    }
    const p = this.world.pools?.material as THREE.MeshBasicMaterial | undefined;
    if (p) p.color.setHex(0xff9c33);
  }

  /* Night fog is a lit city-glow haze, not a black one — see FOG_TUNE for the
     measurements and for the grade math that puts the source colours where
     they are. The night ends are knob-driven and reloaded each frame; the day
     ends are untouched. */
  private fogN = new THREE.Color(FOG_TUNE.night);
  private fogD = new THREE.Color(0x9db6d8);
  private fogRN = new THREE.Color(FOG_TUNE.rain);
  private fogRD = new THREE.Color(0x6a7480);
  /* The clear colour's own night ends, decoupled from the fog's. These two are
     the values the fog ends used to hold, so the void behind the sky dome is
     byte-for-byte what it always was; the day ends are shared with the fog
     above, so full daylight is unchanged too. */
  private skyN = new THREE.Color(FOG_TUNE.sky);
  private skyRN = new THREE.Color(FOG_TUNE.skyRain);
  private clearC = new THREE.Color();
  private sunN = new THREE.Color(0x8296d8);
  private sunD = new THREE.Color(0xffe8c8);
  private hemiN = new THREE.Color(0x0d1526);
  private hemiD = new THREE.Color(0x3948a8);
  private beamPos = new THREE.Vector3();
  private beamDir = new THREE.Vector3();
  private sunDirW = new THREE.Vector3();
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
    const fk = this.fogKnob();
    this.fogN.setHex(fk.night);
    this.fogRN.setHex(fk.rain);
    this.skyN.setHex(fk.sky);
    this.skyRN.setHex(fk.skyRain);
    this.fogC.copy(this.rain ? this.fogRN : this.fogN).lerp(this.rain ? this.fogRD : this.fogD, f);
    (this.scene.fog as THREE.FogExp2).color.copy(this.fogC);
    /* Fog colour and clear colour part company here — see FOG_TUNE. The clear
       colour is the void the sky dome does not cover (below the deck edge on
       the elevated sections, and any gap at the dome's hem); a haze value
       painted across it reads as a flat grey plate, so it keeps the black it
       had. Same lerp, same day end, different night end. */
    this.clearC.copy(this.rain ? this.skyRN : this.skyN).lerp(this.rain ? this.fogRD : this.fogD, f);
    this.renderer.setClearColor(this.clearC);
    /* Density is deliberately NOT re-tuned to compensate for the lifted colour.
       They are one lever pulled twice: dropping density to take the edge off a
       brighter fog cancels most of the change and leaves the user seeing no
       difference. Colour moved; density is where it was, with a knob on top. */
    (this.scene.fog as THREE.FogExp2).density =
      (lerp(0.0021, 0.001, f) + (this.rain ? 0.0015 : 0)) *
      fogMultiplier(this.settings.fog) * fk.density;
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
    /* The player's bodywork rides the same curve, through the one channel that
       can reach it without touching the road — see CAR_ENV. It is a fade and
       not a switch for the same reason everything else here is: a step in the
       car's reflections at some hour of the clock would read as the paint
       changing colour mid-drive. Cheap to call per frame — carenv.ts ignores a
       repeat of the value it already holds, which is what this is for all but
       a few seconds either side of dawn and dusk. */
    setCarEnvLift(lerp(this.carEnvKnob().night, 1, lit));
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
    this.sunShadow(f);
    /* Keep the at-infinity backdrop (dome, skyline ring, mountains, city
       rings) centred on the car. World-fixed it sat centred on the ORIGIN,
       whose rings the 4 km lap physically outruns: nearing z = +Z1 the
       skyline ring stood a few hundred metres past the deck — a wall across
       the road — and the loop splice then snapped it 4 km away, which is the
       visible "drive into a wall, then teleport" at the end of the map.
       Glued to the viewer it stays on the horizon at both ends, so the
       splice's pure z-translation leaves the whole frame unchanged. y stays
       0: the deck's own ±5 m grade must not bob the horizon. */
    sky.backdrop.position.set(car.x, 0, car.z);
    // aurora rides the same day/fog curve as the rest of the backdrop glow;
    // the cloud deck over it is there at any hour and only shifts palette —
    // plus, at dusk and dawn, a sun rim derived from the same angle `sa`
    // that aims the directional light, so the two never disagree
    sky.aurora?.update(now, f, fogMultiplier(this.settings.fog));
    sky.clouds?.update(now, f, fogMultiplier(this.settings.fog), sa);
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
    // the abstract-city light masses go with it: daylight kills a glow dome
    // long before it kills a silhouette, and heavy fog swallows both
    for (const m of sky.cityAbstractMats)
      (m as THREE.MeshBasicMaterial).opacity =
        ((m.userData.nightO as number) ?? 0.4) *
        (1 - f * 0.85) *
        clamp(1.9 - fogMultiplier(this.settings.fog), 0.12, 1);
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
       view, but the POV lens is 89-112 deg horizontal at 16:9 depending on
       where the Field of view slider sits — at 20 m ahead that frame spans
       40-60 m of
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
      // r: coarse buckets (the town light layers) cull on nearest-edge
      // distance, so members near the cell's rim don't pop while lit
      c.group.visible = d - (c.r ?? 0) < dd;
    }
    // the town lamp/pool shader fade (tintLampsSodium) tracks the SAME
    // distance the chunks just culled at, so a chunk's lamps finish fading
    // out by the time the chunk itself disappears rather than popping
    if (this.lampFade) {
      this.lampFade.uFadeFar.value = dd;
      this.lampFade.uFadeNear.value = dd * 0.55;
    }
    /* Async content landed since the load's compile pass (world.compileDirty
       in data.ts): link its programs now, in the background where the driver
       allows it, instead of on the frame the content first enters the view.
       Riding this 6.25 Hz tick batches several arrivals into one walk. */
    if (this.world.compileDirty && this.loaded) {
      this.world.compileDirty = false;
      this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
    }
    // the roadside vegetation's screen-door dissolve tracks the same cull
    // distance for the same reason (see WorldData.fadeFar)
    if (this.world.fadeFar) this.world.fadeFar.value = dd;
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
       far bodywork showing through. The console camera is inside it too, and
       further back than either, so it needs both halves of this even more. */
    const inside = this.inCar();
    rig.cockpit.group.visible = inside;
    rig.exteriorG.visible = !inside;
    this.hoodUpdate();
    this.lampWash(inside);
    this.cabinLightUpdate(dt);
    this.mirrorDimUpdate(dt);
    /* Both in-car views now carry their own nav screen (drawScreen above), so
       the external HUD minimap is redundant in either — hide it. POV is the
       view the game is played in, and the head unit reads clearly there, so
       the overlay would just be a second map pasted over the footage.
       Unconditional: gated on this.mmap it only ever ran on the way ON, so a
       profile restored with the map off left the canvas on screen until X
       was pressed. miniMap() is cached, so this is not a per-frame lookup. */
    const mmapCv = this.miniMap();
    const mmapOn = this.mmapVisible();
    if (mmapCv) {
      /* Repaint at the moment it is revealed, not on the next %4 frame: the
         canvas still holds whatever was on it when POV was entered, which by
         now is a map of somewhere else entirely. Drawing before the display
         flip means a stale frame is never on screen for even one frame. */
      if (mmapOn && !this.mmapWasOn)
        drawMiniMap(mmapCv, this.world, this.car, this.traffic.npcs, now,
          this.mmapZoom ? this.mmapLoopOpts : undefined);
      mmapCv.style.display = mmapOn ? "block" : "none";
    }
    this.mmapWasOn = mmapOn;
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
    if (this.wiperMode > 0) {
      /* Mode-driven sweep (was: always-on sin while raining). The state
         machine advances only while the sim runs, so a pause freezes the
         arms mid-stroke instead of playing wiper audio under the menu —
         updateCarVisual itself still runs while paused (the paused branch of
         the frame loop calls it), which is also why the pose write below is
         outside the `running` gate: the arms must HOLD their pose, not
         vanish. */
      if (this.running) {
        const rate = WIPER_RATE[this.wiperMode];
        if (this.wipeDir === 0) {
          this.wipeWait -= dt;
          // LO/HI never wait; INT waits out its pause parked
          if (this.wiperMode !== 1 || this.wipeWait <= 0) {
            this.wipeDir = 1;
            // in-cabin sound only, like the trim creaks: from CHASE/HOOD the
            // arms are hidden with the interior, and a swish with no arm on
            // screen reads as a glitch rather than as weather
            if (inside) this.audio.wiperSwipe(1 / rate, true);
          }
        }
        if (this.wipeDir !== 0) {
          this.wipeT += this.wipeDir * rate * dt;
          if (this.wipeT >= 1) {
            // reverse at the top — a wiper has no dwell up there
            this.wipeT = 1;
            this.wipeDir = -1;
            if (inside) this.audio.wiperSwipe(1 / rate, false);
          } else if (this.wipeT <= 0) {
            this.wipeT = 0;
            this.wipeDir = 0;
            this.wipeWait = WIPER_INT_PAUSE;
          }
        }
      }
      const z = WIPER.park + this.wipeT * WIPER.sweep;
      rig.cockpit.wiperA.rotation.z = rig.cockpit.wiperB.rotation.z = z;
      /* Hidden only while actually parked (INT sitting out its pause) — the
         same buried-in-the-donor-dash reasoning as the dry branch below. */
      const parked = this.wipeDir === 0 && this.wipeT < 0.02;
      rig.cockpit.wiperA.visible = rig.cockpit.wiperB.visible = !parked;
      wiping = this.wipeDir !== 0;
    } else {
      /* PARK, not rest. This used to ease to WIPER.rest, which is the RAISED
         end of the sweep — so switching the rain off left both arms standing
         upright across the windscreen instead of laying down. Off the sweep's
         own constants now (cockpit.ts WIPER), so retuning the travel cannot
         leave the park pointing at the other end of it again.

         Framerate-independent, which the old `lerp(cur, target, 0.1)` was not:
         a fixed fraction PER FRAME parked twice as slowly at 30 fps as at 60.
         WIPER_PARK_EASE 6 reproduces the old 0.1 at 60 fps almost exactly
         (1 - e^-0.1 = 0.095), so the feel is unchanged where it was tuned and
         only the framerate dependence goes. */
      const z = lerp(
        rig.cockpit.wiperA.rotation.z, WIPER.park, 1 - Math.exp(-WIPER_PARK_EASE * dt)
      );
      rig.cockpit.wiperA.rotation.z = rig.cockpit.wiperB.rotation.z = z;
      /* Mirror the eased pose back into the sweep state, so a mode switched
         on mid-park resumes the arm from where it visibly is. */
      this.wipeT = Math.max(0, (z - WIPER.park) / WIPER.sweep);
      this.wipeDir = 0;
      /* HIDDEN once parked, and that is a decision rather than the missing
         half of the `visible = true` above.

         Parked, the arm runs from its pivot (0.32, 0.86, 0.95) out to a tip at
         about (0.88, 0.97, 0.90) — which is inside the donor dash's own volume
         (x ±0.751, y 0.512..1.072, z -0.244..1.118 in volvo-s90-full.json).
         These arms are placed against the PROCEDURAL windscreen and the donor
         cabin brings its own glass, so a parked arm is not tucked at the base
         of that glass, it is buried in that dashboard, and the half of it that
         is not buried can poke through. Depth would hide most of it from the
         dashcam anyway — the whole parked arm sits below the sightline that
         grazes the pad — so hiding it explicitly costs nothing visible and
         removes the one way it could go wrong.

         It hides on ARRIVAL, not on the rain edge: the arms have to be seen
         laying down, or the fix reads as them vanishing mid-sweep. */
      const parked = Math.abs(z - WIPER.park) < 0.02;
      rig.cockpit.wiperA.visible = rig.cockpit.wiperB.visible = !parked;
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
      /* Hand the head unit the LIVE player rather than letting carscreen run
         its mock rotation — the card was showing "Midnight Loop / Neon
         Arcade" while the real player was part-way through Beethoven. Undefined
         on mobile, where music is disabled and the fallback rotation is still
         the right thing to draw. */
      rig.cockpit.drawScreen(
        this.world, car, this.traffic.npcs, this.time, now,
        this.music.enabled
          ? {
              title: this.music.track.title,
              composer: this.music.track.composer,
              art: this.music.track.art,
              playing: this.music.playing,
              progress: this.music.progress,
            }
          : undefined,
        /* `clickable` is what draws the map view's music pill, so it has to be
           the same test the click path uses — !isTouch && music.enabled — or
           the panel advertises a view a phone cannot reach. */
        {
          view: this.screenView,
          hover: this.screenHover,
          clickable: !this.isTouch && this.music.enabled,
          dim: this.screenDim,
          tripBase: this.tripBase,
        }
      );
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
    /* The cabin knob's `glass` arm scales this ENTIRE envelope — rest level and
       sodium peak alike — rather than only the trough, so dialling it never
       changes the shape of the sweep, only how much of it there is. It is the
       one interior source that survives the I key being off (see CABIN_LIGHT):
       this light is the city coming IN through the screen, not the car lighting
       itself, and with the dome off it is the only thing left describing the
       pad. `rest` is the resting hue, knob-overridable off GLASS_REST.color. */
    const kn = this.cabinKnob();
    const gk = kn.glass;
    const rest = kn.glassHex;
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
      gl.intensity = GLASS_REST.intensity * gk;
      gl.color.setHex(rest);
      return;
    }
    /* Low tiers thin the lamps in PAIRS on the folded lattice index (see
       keepNth in highway.ts) — the same test here, so the wash fires under the
       lamps that actually got a cone/pool and stays quiet under the bare
       poles. Cones lead: they are the taller half of the fixture's light. */
    const every = Math.max(1, (cones ? caps.lampConeEvery : caps.lampPoolEvery) ?? 1);
    const li = this.cor.latticeIndex(z, PITCH.light, PHASE.light);
    if (li % (2 * every) >= 2) {
      gl.intensity = GLASS_REST.intensity * gk;
      gl.color.setHex(rest);
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
    gl.intensity = lerp(GLASS_REST.intensity, lerp(0.46, 0.82, w), night) * gk;
    /* Hue is decoupled from level: the colour saturates to full sodium well
       before the intensity peak (w * 2.2) and stays there for the whole time a
       lamp is influencing the cabin. Tying the blend to the brightness
       envelope was the other half of the white read — at half pulse the light
       was still mostly the cool 0xbfd0ff. */
    gl.color.setHex(rest).lerp(LAMP_SODIUM, Math.min(1, w * 2.2));
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

  /* ---------------- photo mode ---------------- */

  /** Read by GameApp (the photo screen's hint) and the smoke test. */
  get photoOn() {
    return this.photo.on;
  }

  /** Called by GameApp's photoRequest right after setRunning(false) — the
      pause is the UI's, this is only the camera and its listeners. Listeners
      are bound here and removed in photoExit rather than living in
      bindInput(), so outside the mode the canvas carries exactly the
      listeners it always did and the drag/wheel handlers cannot leak input
      into driving. */
  photoEnter() {
    if (this.photo.on || !this.loaded) return;
    const ph = this.photo;
    ph.on = true;
    ph.yaw = this.car.h + PHOTO.yaw0;
    ph.pitch = PHOTO.pitch0;
    // + shell length so both cars open at the same framing, not the same radius
    ph.dist = clamp(PHOTO.dist0 + this.spec.shell.L * 0.35, PHOTO.distMin, PHOTO.distMax);
    ph.auto = true;
    ph.shot = false;
    ph.pinch0 = 0;
    if (!this.photoCam) {
      // near/far mirror the gameplay camera so the world culls identically
      this.photoCam = new THREE.PerspectiveCamera(PHOTO.fov, this.camera.aspect, 0.08, 3400);
      this.photoCam.layers.enable(LAYER_NOREF);
    }
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPhotoPointerDown);
    el.addEventListener("pointermove", this.onPhotoPointerMove);
    el.addEventListener("pointerup", this.onPhotoPointerEnd);
    el.addEventListener("pointercancel", this.onPhotoPointerEnd);
    el.addEventListener("lostpointercapture", this.onPhotoPointerEnd);
    el.addEventListener("wheel", this.onPhotoWheel, { passive: false });
    this.photoUpdate(0);
    this.ui.toast("PHOTO MODE");
  }

  photoExit() {
    if (!this.photo.on) return;
    this.photo.on = false;
    this.photoPtrs.clear();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPhotoPointerDown);
    el.removeEventListener("pointermove", this.onPhotoPointerMove);
    el.removeEventListener("pointerup", this.onPhotoPointerEnd);
    el.removeEventListener("pointercancel", this.onPhotoPointerEnd);
    el.removeEventListener("lostpointercapture", this.onPhotoPointerEnd);
    el.removeEventListener("wheel", this.onPhotoWheel);
  }

  private onPhotoPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.photo.auto = false;
    this.photo.pinch0 = 0; // re-measured on the first two-finger move
    this.photoPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // keep the orbit alive when a drag leaves the window edge
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {}
  };
  private onPhotoPointerMove = (e: PointerEvent) => {
    const p = this.photoPtrs.get(e.pointerId);
    if (!p) return;
    const ph = this.photo;
    if (this.photoPtrs.size === 1) {
      // grab-the-world: drag right, the car turns right in frame
      ph.yaw -= (e.clientX - p.x) * PHOTO.dragSens;
      ph.pitch = clamp(
        ph.pitch + (e.clientY - p.y) * PHOTO.dragSens, PHOTO.pitchMin, PHOTO.pitchMax
      );
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.photoPtrs.size === 2) {
      // pinch zoom — the wheel's job, for the fingers the drawer routed here
      const [a, b] = [...this.photoPtrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (ph.pinch0 > 0 && d > 0)
        ph.dist = clamp(ph.dist * (ph.pinch0 / d), PHOTO.distMin, PHOTO.distMax);
      ph.pinch0 = d;
    }
  };
  private onPhotoPointerEnd = (e: PointerEvent) => {
    this.photoPtrs.delete(e.pointerId);
    this.photo.pinch0 = 0;
  };
  private onPhotoWheel = (e: WheelEvent) => {
    e.preventDefault(); // the page has nothing to scroll; keep ctrl+wheel from zooming it
    this.photo.auto = false;
    this.photo.dist = clamp(
      this.photo.dist * Math.exp(e.deltaY * PHOTO.wheelZoom), PHOTO.distMin, PHOTO.distMax
    );
  };

  /** Runs in place of updateCamera() while the mode is up (loop()'s paused
      branch) — the gameplay camera is deliberately not advanced, which is the
      whole restoration story: it is bit-identical on exit because nothing
      wrote to it. */
  private photoUpdate(dt: number) {
    const ph = this.photo, car = this.car, cam = this.photoCam!;
    if (ph.auto) ph.yaw += PHOTO.autoRate * dt;
    // track viewport changes through the gameplay camera's aspect, which
    // onResize already maintains — one resize path, not two
    if (cam.aspect !== this.camera.aspect) {
      cam.aspect = this.camera.aspect;
      cam.updateProjectionMatrix();
    }
    const tx = car.x, ty = car.y + PHOTO.aimY, tz = car.z;
    const cp = Math.cos(ph.pitch);
    cam.position.set(
      tx + Math.sin(ph.yaw) * cp * ph.dist,
      ty + Math.sin(ph.pitch) * ph.dist,
      tz + Math.cos(ph.yaw) * cp * ph.dist
    );
    /* The deck clamp. Same heightAt call the chase camera floors itself with:
       referenced to the car's own y, so on the elevated deck it reads the
       deck, not the town street 12 m under it — a low orbit angle slides the
       lens along just above the surface instead of through it. */
    const floorY =
      this.terrain.heightAt(cam.position.x, cam.position.z, car.y) + PHOTO.clearance;
    if (cam.position.y < floorY) cam.position.y = floorY;
    cam.lookAt(tx, ty, tz);
  }

  /** Arm-and-fire lives in loop(): the flag is consumed right after
      post.process so toBlob reads the just-drawn buffer (no
      preserveDrawingBuffer — the read must happen in the render's own task). */
  private captureShot() {
    let n = 1;
    try {
      n = (parseInt(localStorage.getItem("neonx-shot-n") || "0", 10) || 0) + 1;
      localStorage.setItem("neonx-shot-n", String(n));
    } catch {
      n = this.photoShots + 1; // private mode etc. — session-local numbering
    }
    const name = `neon-expressway-${n}.png`;
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) {
        this.ui.toast("CAPTURE FAILED");
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      // long enough for any browser to have opened the blob; not a leak either
      // way, the next capture makes a new one
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      this.photoShots++;
      this.ui.toast("SAVED " + name);
    }, "image/png");
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
      const kc = this.chaseKnob();
      const cfx = this.chaseFx();
      /* The speed pull-back — the camera easing away from the car as it winds
         up — is an EFFECT, not the camera following, and it is off (fx 0). It
         never shook, but it is the same class of thing as the FOV speed kick,
         which CHASE_SHAKE already zeroes here: framing that moves for reasons
         the car is not giving it. Leaving one of that pair on and calling the
         other removed would be arbitrary. On the knob rather than deleted
         because 0.9 m of pull is a real sensation of speed and this is the
         cheapest of the three to want back. */
      const dist =
        (kc.dist + this.spec.shell.L * 0.25) +
        clamp(Math.abs(car.u) * 0.03, 0, 0.9) * cfx.speedPull;
      // flip: 0 = camera behind the car, 1 = in front of it looking back. The
      // swing is an arc around the car, not a lerp through it.
      const flip = this.lookBack ? 1 - this.revCam : this.revCam;
      const ang = car.h + Math.PI * (1 - flip);
      const ax = Math.sin(ang), az = Math.cos(ang);
      this.tmpV.set(car.x + ax * dist, car.y + kc.height, car.z + az * dist);
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
      // a rising ramp raises this floor smoothly, but Math.max used to snap
      // chasePos.y onto it the instant it overtook the trailing camera — a
      // one-frame pop that read as third-person "shake" even with
      // CHASE_SHAKE/CHASE_FX both 0. Ease up to it instead (CHASE_FLOOR_EASE);
      // still instant on a fresh entry, which already snaps the whole
      // chasePos above rather than easing into a stale one.
      const chaseFloorY = this.terrain.heightAt(this.chasePos.x, this.chasePos.z, car.y) + 1.2;
      if (freshEntry) this.chasePos.y = Math.max(this.chasePos.y, chaseFloorY);
      else if (this.chasePos.y < chaseFloorY)
        this.chasePos.y = lerp(this.chasePos.y, chaseFloorY, 1 - Math.exp(-CHASE_FLOOR_EASE * dt));
      /* THE LATERAL LAG WAS THE SHAKE, and it is off (fx.lag 0).

         "For the third-person view, remove the shakiness and camera effects
         totally." CHASE_SHAKE was already 0, which kills the head-spring bob,
         the G-lean roll and the FOV kick — but it never reached this, and this
         is a SECOND-ORDER SPRING: stiffness 24 against damping 6 is a damping
         ratio of 0.61, i.e. underdamped, so it overshoots the target and rings
         on the way back. Every corner exit handed the camera a sideways
         wobble that had nothing to do with where the car was. That is not the
         camera following, it is the camera having a suspension of its own, and
         it is the one thing in this branch that genuinely oscillates.

         Kept as code on a knob rather than deleted, because a trailing lean IS
         a real chase-camera idea and someone may want a critically-damped
         version of it later — but it starts at zero, and the ring is the
         reason. */
      const rgX = fz, rgZ = -fx; // world-space "right" of the car's heading
      const lagTarget = freshEntry
        ? 0
        : clamp(-car.r * Math.abs(car.u) * 0.028, -0.35, 0.35) * cfx.lag;
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
      /* Aim past the car, away from wherever the camera currently sits.

         The lateral swing on that aim point is an effect too, and off
         (fx.aimSwing 0): `car.delta` is the STEERING ANGLE, and on a keyboard
         that is a value which snaps between stops, so the aim jerked sideways
         on every tap of A or D. The smoothing below was put there to cover
         exactly that, which is the tell — a term that needs a filter to be
         watchable is a term the view is better off without. What is left aims
         at the car, which is what a chase camera is for. */
      const lat = car.delta * 1.6 * (1 - 2 * flip) * cfx.aimSwing;
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
         look-back: it is a bracket over the dash, so the motion it has is the
         body's own — with ONE deliberate exception, a light lag on the yaw
         that takes the top off a fast steering flick and settles to exact
         tracking. See CAM_SMOOTH for why a bracket was given any compliance at
         all, and set `pov` to 0 there to have none. Entering the mode also
         parks the cockpit head state at neutral, so stepping back into the
         cockpit view starts from centre instead of resuming a stale spring and
         dipping. */
      if (this.lastCamMode !== CAM_POV) {
        this.head.x = this.head.y = this.head.z = this.head.roll = 0;
        this.head.vx = this.head.vy = this.head.vz = this.head.vroll = 0;
        this.lookaheadYaw = 0;
        this.lbLean = 0;
        this.povYaw = car.h; // no lag to inherit on entry — see CAM_SMOOTH
      }
      const P = this.spec.shell;
      const mount = this.povMount();
      this.camera.position.copy(
        this.rig.bodyG.localToWorld(
          this.tmpV.set(
            // scaled with the shell like the cockpit eye is, so the lens keeps
            // its position relative to the binnacle on a narrower or wider car
            (POV_MOUNT.dx + mount.dx) * (P.W / COCKPIT_REF.W),
            P.belt - COCKPIT_REF.belt + COCKPIT_EYE.y + mount.dy,
            COCKPIT_EYE.z + POV_MOUNT.dz + mount.dz
          )
        )
      );
      this.camera.rotation.y = this.povYawUpdate(car.h, dt) + Math.PI;
      // same sign flip as the cockpit (body pitch is nose-up-negative, camera
      // pitch is look-up-positive), plus the fixed downward cant of the bracket
      this.camera.rotation.x = -this.rig.bodyG.rotation.x - POV_TILT;
      this.camera.rotation.z = -this.rig.bodyG.rotation.z;
    } else if (this.camMode === CAM_CONSOLE) {
      /* Experimental wide lens on the centre console — see CONSOLE_CAM. Built
         on the dashcam's branch rather than the cockpit's on purpose: it is a
         bracket between the seats, so it gets the body's motion and nothing
         else, and the same head-parking on entry so that stepping from here
         into COCKPIT starts from a centred spring instead of a stale one. */
      if (this.lastCamMode !== CAM_CONSOLE) {
        this.head.x = this.head.y = this.head.z = this.head.roll = 0;
        this.head.vx = this.head.vy = this.head.vz = this.head.vroll = 0;
        this.lookaheadYaw = 0;
        this.lbLean = 0;
      }
      const P = this.spec.shell;
      const k = this.consoleCam();
      this.camera.position.copy(
        this.rig.bodyG.localToWorld(
          this.tmpV.set(
            // x scaled with the shell like both other in-car mounts, so a
            // narrower car keeps the lens in the channel between its seats
            k.x * (P.W / COCKPIT_REF.W),
            P.belt - COCKPIT_REF.belt + k.y,
            k.z
          )
        )
      );
      this.camera.rotation.y = car.h + Math.PI;
      this.camera.rotation.x = -this.rig.bodyG.rotation.x - k.tilt;
      this.camera.rotation.z = -this.rig.bodyG.rotation.z;
    } else if (this.camMode === CAM_BACKSEAT) {
      /* Passenger's phone on the rear bench — see BACKSEAT_CAM. Same rigid
         treatment as the console bracket (body motion only, head parked on
         entry so COCKPIT re-enters centred), plus the one thing a phone has
         that a bracket does not: a fixed off-axis yaw toward the road. */
      if (this.lastCamMode !== CAM_BACKSEAT) {
        this.head.x = this.head.y = this.head.z = this.head.roll = 0;
        this.head.vx = this.head.vy = this.head.vz = this.head.vroll = 0;
        this.lookaheadYaw = 0;
        this.lbLean = 0;
      }
      const P = this.spec.shell;
      const k = this.backseatCam();
      this.camera.position.copy(
        this.rig.bodyG.localToWorld(
          this.tmpV.set(
            // x scaled with the shell so the lens stays behind the passenger
            // seat, not behind a door card, on a narrower car
            k.x * (P.W / COCKPIT_REF.W),
            P.belt - COCKPIT_REF.belt + k.y,
            k.z
          )
        )
      );
      this.camera.rotation.y = car.h + Math.PI + k.yaw;
      this.camera.rotation.x = -this.rig.bodyG.rotation.x - k.tilt;
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
      const cockEye = this.cockpitEye();
      const local =
        this.camMode === 1
          // seating position lives in cockpit.ts: the binnacle, wheel and mirror
          // are all pinned to COCKPIT_EYE, so the eye must come from there too
          ? this.tmpV.set(
            eyeX * (1 - 0.8 * this.lbLean) + this.head.x,
            P.belt - COCKPIT_REF.belt + COCKPIT_EYE.y + 0.06 * this.lbLean + this.head.y
              + cockEye.dy,
            COCKPIT_EYE.z + this.head.z + cockEye.dz
          )
          : this.tmpV.set(0, P.belt + 0.5 + this.head.y * 0.5 * this.chaseShake(), P.L / 2 - 0.6);
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
         G-force lean above rather than replacing it.

         CAM_COCKPIT ONLY, and that is the `camMode === 1` test rather than
         inCar(): the dashcam and the console camera are brackets, not heads,
         and take no head springs at all — they have their own branches above
         and never reach this line. So this is not the shipping view shaking.
         See CABIN_VIBE for the level. */
      if (this.camMode === 1) {
        const k = this.vibeKnob();
        const spN = clamp(Math.abs(car.u) / 50, 0, 1); // 1.0 ≈ 180 km/h
        const vibeAmt =
          (Math.pow(spN, k.pow) * 0.85 + clamp(car.slipAmt, 0, 1) * 0.15 * k.slip) * k.amp;
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
        -this.rig.bodyG.rotation.z +
        (clamp(car.u * car.r * 0.0035, -0.06, 0.06) + this.head.roll) * this.chaseShake();
    }
    /* The speed FOV kick is a raw add onto fovBase with no lensFov and no cap,
       so at a high slider setting it can walk the projection past what every
       clamped mode allows — COCKPIT (kickM 1) transiently hit 119 vertical at
       the slider's max of 100 (100 + the full 19-degree kick), against the
       ~100 every other mode tops out at. Fading the kick out as fovBase nears
       POV_FOV_MAX keeps the total under that ceiling without touching the
       kick's feel at the slider's own default, where it still lands at full
       strength: 1 at FOV_SLIDER_REF (67) and below, sliding to 0 at
       POV_FOV_MAX (100). */
    const kickFade = clamp(
      (POV_FOV_MAX - this.settings.fovBase) / (POV_FOV_MAX - FOV_SLIDER_REF), 0, 1
    );
    const kickM =
      (this.camMode === CAM_CHASE ? 0.18 : this.camMode === CAM_HOOD ? 0.6 : 1) *
      (this.camMode === CAM_CHASE ? this.chaseShake() : 1) *
      kickFade;
    /* The dashcam still runs a FIXED lens in the sense that matters: no speed
       FOV kick, because a bracket-mounted camera has no zoom and the kick is a
       driver-sensation cue rather than an optical one. What it no longer
       ignores is the user's own setting — povFov() turns the slider into the
       lens, once per frame, per aspect.

       The console camera keeps a WIDER BASELINE of its own — an experimental
       view wants to be dialled wide without dragging the shipping view's
       ceiling along — but it reads the slider through it now rather than
       ignoring it, and through the same aspect machinery. See consoleFov().
       No speed kick there either, same reason — it is a bracket, not a
       driver. */
    const fovT =
      this.camMode === CAM_POV
        ? this.povFov(this.camera.aspect)
        : this.camMode === CAM_CONSOLE
          ? this.consoleFov(this.camera.aspect)
          : this.camMode === CAM_BACKSEAT
            ? this.backseatFov(this.camera.aspect)
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

  /** No Hesi scoring loop — see the NOHESI block. Reads traffic.ts's
      scoreEvents() (must run after this.traffic.update() this frame) and the
      contact flag the caller derives from collidePlayer's result, using the
      SAME relSpeed/wallImpact thresholds the crash sound already gates on:
      a "hit" for scoring is a hit the player would hear and feel, not every
      depenetration nudge. Combo dies on contact; the running score does not
      — this is an arcade total for the drive, not a life. */
  private noHesiUpdate(dt: number, hadContact: boolean) {
    const nh = this.noHesi;
    const on = this.settings.noHesiScore;
    if (hadContact) {
      nh.combo = 1;
      nh.sinceAction = 0;
    } else {
      const grades = this.traffic.scoreEvents();
      if (grades.length) {
        // stats ride the same feed — counted regardless of the score display
        // setting, same as the combo itself is
        this.stats.nearMisses += grades.length;
        nh.sinceAction = 0;
        let best = 0;
        for (const g of grades) {
          nh.combo = Math.min(NOHESI.comboMax, nh.combo + NOHESI.comboStep * g);
          if (g > best) best = g;
        }
        if (on && best > NOHESI.pulseGrade && nh.pulseCd <= 0) {
          const pts = Math.round(NOHESI.pulseBase * (0.5 + 0.5 * best) * nh.combo / 10) * 10;
          this.ui.toast(`+${pts} CLOSE`);
          nh.pulseCd = NOHESI.pulseCd;
        }
      } else {
        nh.sinceAction += dt;
        if (nh.sinceAction > NOHESI.decayAfter)
          nh.combo = Math.max(1, nh.combo - NOHESI.decayRate * dt);
      }
    }
    nh.pulseCd = Math.max(0, nh.pulseCd - dt);
    if (on && Math.abs(this.car.u) > NOHESI.speedFloor)
      nh.score += Math.abs(this.car.u) * nh.combo * NOHESI.pointsScale * dt;
    if (nh.score > nh.best) nh.best = nh.score;
  }

  /** Drive statistics — see the STATS block. One in-place accumulator fed
      from values this frame already computed; near misses, crashes and laps
      are banked at their own sources (noHesiUpdate, the crash gates,
      loopSplice), so what's left here is the per-frame integration and the
      2 Hz mountain-run probe. Runs only inside the `running` branch: paused
      time is nobody's drive time. */
  private statsUpdate(dt: number) {
    const st = this.stats;
    const sp = Math.abs(this.car.u);
    if (sp > STATS.moveFloor) {
      st.dist += sp * dt;
      st.driveT += dt;
      if (sp > st.topSpeed) st.topSpeed = sp;
    }
    if (this.noHesi.combo > st.bestCombo) st.bestCombo = this.noHesi.combo;

    /* Mountain-pass runs: watch which route-graph edge is under the car (the
       same surfaceAt() read the debug hook and resetCar already use — the
       traffic and the graph itself are never touched) and bank a run when a
       visit to the pass has spanned nearly its whole arclength. The span is
       a min/max of sampled s, so it counts a traversal in either direction
       and a U-turn halfway counts nothing. */
    st.routeT -= dt;
    if (st.routeT > 0) return;
    st.routeT = STATS.routeEvery;
    const hit = this.world.routes?.surfaceAt(this.car.x, this.car.z, 2);
    if (hit && hit.edgeId === MOUNTAIN_EDGE) {
      if (!st.mtnOn) {
        st.mtnOn = true;
        st.mtnLo = st.mtnHi = hit.s;
      } else {
        if (hit.s < st.mtnLo) st.mtnLo = hit.s;
        if (hit.s > st.mtnHi) st.mtnHi = hit.s;
      }
      st.mtnOffT = 0;
    } else if (st.mtnOn) {
      st.mtnOffT += STATS.routeEvery;
      if (st.mtnOffT > STATS.mtnGrace) {
        st.mtnOn = false;
        const mt = this.world.routes?.mtn;
        if (mt && st.mtnHi - st.mtnLo >= mt.len * STATS.mtnSpan) st.mtnRuns++;
      }
    }
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
      /* No Hesi score + combo — see NOHESI/noHesiUpdate. Semantic ids/classes
         only, no layout here; ui-redesign owns the actual styling pass. */
      const enh = this.dom("noHesi");
      if (enh) {
        if (this.settings.noHesiScore) {
          enh.textContent = `${Math.round(this.noHesi.score)} ×${this.noHesi.combo.toFixed(1)}`;
          enh.classList.toggle("combo-hot", this.noHesi.combo > 3);
        } else enh.textContent = "";
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
    const il = this.dom("indL"), ir = this.dom("indR");
    /* Recomputed every frame but only changes at blink rate, and a className
       write invalidates style whether or not the value moved. Compared
       against the element rather than a cached field so a remounted lamp
       re-syncs itself — same reason the wx icon stores its state in
       dataset.wx above. */
    const clL = "ind" + (car.sigL && bOn ? " on" : "");
    const clR = "ind" + (car.sigR && bOn ? " on" : "");
    if (il && il.className !== clL) il.className = clL;
    if (ir && ir.className !== clR) ir.className = clR;
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
        stepPhysics(this.car, this.input, this.phys, 1 / 120, {
          mu: this.rain ? 0.84 : 1.26,
          tcEnabled: this.settings.tc,
          heightAt: this.terrain.heightAt,
          arcade: this.testMode,
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
      // No Hesi: a hit worth the crash sound is a hit that kills the combo —
      // same relSpeed/wallImpact thresholds as the audio/damage below, so
      // "contact" means the same thing everywhere it's judged this frame.
      let noHesiHit = res.wallImpact > 4;
      for (const hitInfo of res.npcHits) {
        this.traffic.applyImpact(hitInfo);
        if (hitInfo.relSpeed > 2.5 && this.crashCooldown <= 0) {
          this.crashCooldown = 0.4;
          this.audio.crash(hitInfo.relSpeed);
          // stats: "a crash" is a hit worth the crash sound, and the same
          // cooldown that stops a chorus stops one scrape counting as five
          this.stats.crashes++;
          this.car.damage += hitInfo.relSpeed * 0.5;
          // dashcam impact glitch: gated on POV here (not inside dashcamHit)
          // so a hit taken in another camera doesn't arm a burst that fires
          // the moment the player later switches into POV
          if (this.camMode === CAM_POV) this.post.dashcamHit(hitInfo.relSpeed);
        }
        if (hitInfo.relSpeed > 2.5) noHesiHit = true;
      }
      if (res.wallImpact > 4 && this.crashCooldown <= 0) {
        this.crashCooldown = 0.4;
        this.audio.crash(res.wallImpact);
        this.stats.crashes++;
        if (this.camMode === CAM_POV) this.post.dashcamHit(res.wallImpact);
      }
      this.camera.getWorldDirection(this.tmpV);
      this.traffic.update(
        dt, now, this.car, this.tmpV.x, this.tmpV.z,
        this.settings.traffic, this.input.horn > 0, this.dayFactor() < 0.32 || this.rain,
        this.hiFlashPulse
      );
      this.hiFlashPulse = false; // one press, one gesture — consumed here
      // after traffic.update() — scoreEvents() reads this frame's feed
      this.noHesiUpdate(dt, noHesiHit);
      // after noHesiUpdate so the frame's combo is what bestCombo sees
      this.statsUpdate(dt);
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
      /* Wheel spray. Rate is per second and accumulated inside fx.ts, so this
         is a plain per-frame call with no gate of its own. The `rain ? 1 : 0`
         is the intensity slot: when a variable rain source lands, pass it here
         and the spray thins out with the weather for free. */
      this.smokeFX.sprayEmit(
        dt, this.car.x, this.car.y, this.car.z, this.car.h,
        Math.abs(this.car.u), this.rain ? 1 : 0, this.car.slipAmt
      );
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
        // whether the camera is an in-cabin view (cockpit/console/POV).
        this.car.axS, this.car.ayS, this.car.slope,
        this.inCar()
      );
      this.npcAudioFeed();
      this.hud(now, dt);
      this.chunkT += dt;
      if (this.chunkT > 0.16) {
        this.chunkT = 0;
        this.chunksUpdate();
      }
      if (this.mmapVisible() && this.frameN % 4 === 0) {
        const mmapCv = this.miniMap();
        if (mmapCv) drawMiniMap(mmapCv, this.world, this.car, this.traffic.npcs, now,
          this.mmapZoom ? this.mmapLoopOpts : undefined);
      }
    } else {
      this.acc = 0;
      // paused: no collision runs, so nothing would ever clear a scrape that
      // was sounding at the moment the pause landed
      this.scrapeUpdate(dt, false, 0, 0);
      this.updateCarVisual(now, dt);
      /* Photo mode replaces the camera update, not the camera: the gameplay
         camera keeps the exact state the last driving frame left it with
         (photoUpdate never touches it), so exiting restores the view by
         construction. Everything else in this branch runs as any pause. */
      if (this.photo.on) this.photoUpdate(dt);
      else this.updateCamera(dt);
      this.weather(0, now);
      // keep the tunnel look correct while paused; the thump stays gated on
      // `running` so unpausing inside a tunnel can't fire one
      this.interiorUpdate();
      this.tunnelUpdate(0, now);
    }
    this.frameN++;
    // POV sits behind the mirror housing too, and the glass hangs in the top
    // ~15% of its frame, so it needs the rear view rendered as well — and the
    // console camera stares straight up the centreline at it, which is the one
    // place in the car where the mirror is dead ahead rather than off to a side
    if (this.mirror && this.frameN % 2 === 0 && this.inCar()) this.renderMirror();
    /* The wet-road reflection source is no longer a second scene render: it
       is built inside post.process() from the bloom bright pass, which is
       already there (see the WET-ROAD REFLECTION block in world/mats.ts for
       why reflecting only the bright sources is what finally made the effect
       shippable). All that is left here is telling post whether to run that
       one quarter-res pass. reflectionsOn still folds in the tier, and setWet
       has zeroed uRefStr to match, so `false` costs nothing on either side. */
    this.post.setReflect(this.reflectionsOn);
    // photo mode renders through its own camera; the gameplay one is not
    // advanced or drawn while the mode is up (see photoUpdate)
    const cam = this.photo.on && this.photoCam ? this.photoCam : this.camera;
    cam.updateMatrixWorld();
    /* NPC daylight fill (see setNpcDaylight in traffic.ts) needs the sun
       direction in view space, so it is fed here where the drawing camera's
       matrices are fresh — Camera.updateMatrixWorld refreshes
       matrixWorldInverse too, and photo mode's own camera counts: its
       daytime shots light the fleet from its view, not the gameplay one's.
       Zero at night; this is the day pass's one hook into the fleet. */
    this.sunDirW.copy(this.sun.position).sub(this.sun.target.position).normalize();
    setNpcDaylight(this.dayFactor(), this.sunDirW, cam);
    this.renderer.setRenderTarget(this.post.sceneRT);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    const f = this.dayFactor();
    this.post.setSpeed(Math.abs(this.car.u) * 3.6);
    // the extreme degrade is a property of the camera, not a user filter — the
    // V-key `grade` below stays independent and keeps driving the mild look.
    // tierCaps.dashcam is true on EVERY tier (settings.ts: the POV filter is
    // core to the game's look, a user call), so the gate below only ever fires
    // if a future tier turns it off. An earlier comment here claimed both
    // dashcam passes were desktop-only and that mobile got a clean
    // hard-mounted view instead; that has not been true since the cap was
    // opened up, and reasoning about the mobile POV frame from it leads
    // straight to the wrong conclusion.
    // in photo mode the dashcam's degrade must not stamp itself on the shot —
    // the lens on duty is the photo camera, whatever camMode is waiting behind it
    this.post.setDashcamPov(
      !this.photo.on && this.camMode === CAM_POV && this.tierCaps.dashcam
    );
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
      /* The USER's motion-blur choice, unfiltered by the perf cap — and that
         separation is the point. `mblur` above is the chase-camera streak, a
         quality option, so it is rightly gated by tierCaps.mblur (false on
         both mobile tiers). The dashcam's 40 ms exposure is a different
         effect that happens to share the word: it is the look the night pass
         was authored around, it costs one blend of a full-screen quad, and a
         phone can afford it.

         Sharing one flag meant mobile could never have the dashcam exposure
         no matter what the player picked, while desktop could never turn it
         off. Two effects, two gates. */
      mbOn: this.settings.mblur,
      /* Suppresses the peripheral blur: inside the car the frame edge is
         cabin, which is bolted to the camera and must not smear. */
      inCar: this.inCar(),
      time: now,
      // the dashcam POV's frame blend is an exposure TIME, so it needs the
      // frame delta to stay 40 ms at any frame rate (post.ts POV_MB_TAU).
      dt,
    });
    // after post.process: the composite just drew this frame to the canvas,
    // and toBlob must read it in the same task (no preserveDrawingBuffer)
    if (this.photo.on && this.photo.shot) {
      this.photo.shot = false;
      this.captureShot();
    }
    this.perfCheck(performance.now() - t0, dt);
  };
}
