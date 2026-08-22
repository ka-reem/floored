import * as THREE from "three";
import { clamp, lerp, rand, pick, TAU, angDiff, mulberry32 } from "./util";
import { loadNpcModels, MAX_WHEELS, type NpcLamps, type NpcModel } from "./npcmodels";
import { HX, LANE_LAT } from "./world/const";
import { getCorridor, PITCH, PHASE, TOLL } from "./world/corridor";
import { worldTierCaps } from "./settings";
import {
  getRouteGraph, BYPASS, BYPASS_EDGE, DIVERGE_Z, type RoutePose,
} from "./world/routegraph";
import { signalPhase, type WorldData } from "./world/data";
import type { REdge, EdgePose } from "./world/roadnet";
import type { CarState } from "./physics";
import type { NpcHit } from "./collide";

/* Traffic v4.
   Expressway NPCs drive the one-way corridor (see world/corridor.ts): IDM
   car-following plus MOBIL-ish lane changes, positioned by corridor z + a
   lateral offset so they follow its bends, grades and lane tapers, and wrapped
   around the loop the same way the player is. Every driver rolls a persistent
   personality at spawn (see ARCH), so speeds, headways, patience and reaction
   times vary the way real traffic does.

   The fleet is a recycled pool that lives *ahead* of the player: the corridor
   is one-way, so cars are seeded in front, out of sight (past the fog wall, or
   anywhere at all on a seeding frame, before that view has been rendered), and
   are recycled once they drop behind. Most of the stream is pegged a little
   below the player's pace so it is continually reeled in and overtaken.

   Town/side-street traffic drives the curved road graph — IDM, signals, turn
   blinkers, curvature-aware speeds — and is parked behind TOWN_TRAFFIC while
   the whole budget goes to the expressway.

   Player impacts convert victims into free-sliding wrecks that blink hazards,
   smoke, block traffic, then dissolve out. */

/* ===================== NPC models =====================
   Everyday city traffic, all of it real modelled bodyshells baked offline
   from the Orchids Simulator Traffic Car Pack (tools/build-orchids-models.mjs
   → public/models/cars/<style>.glb): four ordinary passenger cars (hybrid
   hatch, sedan, compact wagon, crossover) plus taxi, police, delivery van,
   box truck and city bus. Each style is one InstancedMesh, so the whole fleet
   costs a fixed ~10 draw calls however many cars are live.

   There is deliberately NO procedural fallback body and no procedural far
   tier any more — the models are 0.3-2.6k triangles, cheap enough to draw at
   every distance. A style spawns nothing until its GLB has landed (see
   `ready` below): on a normal load that is well inside the first second, and
   the corridor seeding frame is simply held back until the fleet is in — a
   brief absence, never a placeholder polygon car. A file that is missing or
   corrupt keeps only that style off the road and thins the mix; it can not
   put an untextured shape on screen.

   The models keep their authored paint and textures (their `paintable` mask
   is zero), so per-instance colour does not come from that mask: the styles
   whose bodywork can plausibly be any colour are recoloured in the shader
   from the albedo texel instead. See PAINT_TINT. */

const TYPE_DIM: Record<string, { L: number; W: number; wr: number; wz: number; mass: number }> = {
  hybrid: { L: 4.54, W: 1.84, wr: 0.32, wz: 1.4, mass: 1400 },
  sedan: { L: 4.44, W: 1.87, wr: 0.32, wz: 1.37, mass: 1380 },
  compact: { L: 3.94, W: 1.79, wr: 0.30, wz: 1.24, mass: 1080 },
  suv: { L: 4.72, W: 1.98, wr: 0.36, wz: 1.46, mass: 1950 },
  taxi: { L: 4.44, W: 1.87, wr: 0.32, wz: 1.37, mass: 1380 },
  police: { L: 4.44, W: 1.87, wr: 0.32, wz: 1.37, mass: 1450 },
  van: { L: 4.64, W: 1.86, wr: 0.31, wz: 1.5, mass: 1750 },
  truck: { L: 6.3, W: 2.1, wr: 0.42, wz: 2.3, mass: 4200 },
  bus: { L: 9.4, W: 2.36, wr: 0.44, wz: 3.4, mass: 9000 },
};

/* Town/side-street traffic is parked for now at the user's request: the whole
   budget goes to the expressway. The town driving model below is intact — flip
   this back to true to bring it back. */
const TOWN_TRAFFIC = false;

const NPC_COLORS = [
  0xd8dde6, 0x14161c, 0x9298a4, 0x5a1f26, 0x1d2f52, 0x27402c, 0x6b6154,
  0xc4c9d4, 0x2a2c34, 0x83202c, 0xe8eaee, 0x3b4250, 0x6e7684, 0x1a3a34,
];
const TYRE_C = 0x0b0b0f;

/* ---- per-instance paint on the modelled fleet ----------------------------
   The Orchids bakes are photographs: one authored body colour per style, with
   the studio highlights, panel gaps, glass, lamps and plates all living in the
   same 512px atlas. So the whole roster used to drive past in exactly nine
   colours, and the random `paintCol` picked below never showed.

   There is no per-vertex paint mask to key off — the bakes ship `paintable`
   zero throughout — so the paint region is found per fragment from the texel:

   - `hue` < 0 marks a style whose authored paint is neutral (the silver and
     white bodies): paint is whatever is desaturated and above tyre-black,
     which excludes the red lamps and the yellow plate.
   - otherwise the paint is chromatic (the green hybrid, the blue SUV) and is
     picked out by hue proximity instead, which additionally leaves the
     neutral chrome, glass and plates alone.

   `refLum` is the mean linear luminance of that region in the authored bake,
   so `lum / refLum` is the panel's shading with its own paint divided out.
   Multiplying the instance colour by it re-lights the new paint under the
   baked highlights rather than flattening the body to a flat swatch. Well
   above the reference the texel is a specular hit or glass rather than paint,
   so it fades back to neutral: a red car keeps white highlights and its
   windscreen stays a pale reflection instead of turning red.

   Taxi, police and bus are deliberately absent — their liveries are the
   point, and a lilac police cruiser is not traffic. */
const PAINT_TINT: Record<string, { hue: number; refLum: number }> = {
  sedan:   { hue: -1,    refLum: 0.675 },
  compact: { hue: -1,    refLum: 0.636 },
  van:     { hue: -1,    refLum: 0.697 },
  truck:   { hue: -1,    refLum: 0.668 },
  hybrid:  { hue: 0.311, refLum: 0.481 }, // authored green
  suv:     { hue: 0.594, refLum: 0.106 }, // authored blue
};

/* The paint-region recolour, injected at `color_fragment` where `diffuseColor`
   is the decoded albedo texel and nothing has been lit yet. The two numbers
   ride in as a uniform rather than baked literals so the whole fleet still
   shares one compiled program — three keys its program cache on
   `onBeforeCompile.toString()`, so per-style GLSL would mean per-style
   programs (and a per-style compile hitch) for no gain. `uPaintRef.y` of zero
   is a style that keeps its livery. */
const PAINT_TINT_GLSL = `
        if (uPaintRef.y > 0.0) {
          vec3 c = diffuseColor.rgb;
          float mx = max(max(c.r, c.g), c.b);
          float d = mx - min(min(c.r, c.g), c.b);
          float sat = mx > 0.0 ? d / mx : 0.0;
          float m;
          if (uPaintRef.x < 0.0) {
            // neutral paint: desaturated, and brighter than tyres and shadow
            m = (1.0 - smoothstep(0.16, 0.30, sat)) * smoothstep(0.045, 0.10, mx);
          } else {
            // chromatic paint: hue-matched. Branchless RGB->hue, in turns.
            vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
            vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
            vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
            float hu = abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-10));
            float dh = abs(hu - uPaintRef.x);
            dh = min(dh, 1.0 - dh);
            m = (1.0 - smoothstep(0.067, 0.117, dh)) * smoothstep(0.05, 0.14, sat);
          }
          float k = dot(c, vec3(0.2126, 0.7152, 0.0722)) / uPaintRef.y;
          vec3 paint = mix(vPaintCol * k, vec3(mx), smoothstep(1.15, 1.90, k));
          diffuseColor.rgb = mix(c, paint, m);
        }`;

/** `lamp`: 0 none, 1 headlight, 2 rear light — drives the emissive term. */
type Part = { g: THREE.BufferGeometry; c: number; paint: number; lamp?: number };

/** Merge parts into one geometry carrying vertex colour + a paintable mask. */
function mergeParts(parts: Part[]) {
  let vc = 0, ic = 0;
  for (const p of parts) {
    const n = p.g.attributes.position.count;
    vc += n;
    ic += p.g.index ? p.g.index.count : n;
  }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), col = new Float32Array(vc * 3);
  const pnt = new Float32Array(vc), lmp = new Float32Array(vc);
  const idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  const C = new THREE.Color();
  for (const p of parts) {
    const n = p.g.attributes.position.count;
    pos.set(p.g.attributes.position.array as Float32Array, vo * 3);
    nor.set(p.g.attributes.normal.array as Float32Array, vo * 3);
    C.setHex(p.c);
    for (let i = 0; i < n; i++) {
      col[(vo + i) * 3] = C.r;
      col[(vo + i) * 3 + 1] = C.g;
      col[(vo + i) * 3 + 2] = C.b;
      pnt[vo + i] = p.paint;
      lmp[vo + i] = p.lamp || 0;
    }
    if (p.g.index) {
      const I = p.g.index.array;
      for (let i = 0; i < I.length; i++) idx[io++] = (I as any)[i] + vo;
    } else for (let i = 0; i < n; i++) idx[io++] = vo + i;
    vo += n;
    p.g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setAttribute("paintable", new THREE.BufferAttribute(pnt, 1));
  out.setAttribute("lampKind", new THREE.BufferAttribute(lmp, 1));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Road wheel: tyre plus a rim face, vertex-coloured so one instanced mesh
    covers every car. Unit radius in X/Z — the instance matrix scales it. */
function wheelGeo() {
  const parts: Part[] = [];
  const tyre = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
  parts.push({ g: tyre, c: TYRE_C, paint: 0 });
  for (const sy of [-1, 1]) {
    const rim = new THREE.CylinderGeometry(0.66, 0.66, 0.06, 10, 1);
    rim.translate(0, sy * 0.5, 0);
    parts.push({ g: rim, c: 0x8a8f99, paint: 0 });
    const hub = new THREE.CylinderGeometry(0.24, 0.24, 0.1, 6, 1);
    hub.translate(0, sy * 0.52, 0);
    parts.push({ g: hub, c: 0x4a4f59, paint: 0 });
  }
  return mergeParts(parts);
}

/* The NPC shader does three jobs on top of MeshStandard:

   - Per-instance paint. `paintCol` (instanced) replaces the baked vertex colour
     wherever the `paintable` mask is 1, and on a PAINT_TINT style additionally
     recolours the paint region of the albedo texture, so one geometry and one
     bodyshell texture serve every colour on the road.
   - Per-instance dissolve. Wrecks fade out through an ordered-dither discard
     rather than alpha blending, which keeps the material opaque — no transparent
     sorting, and no per-wreck material clones to allocate and dispose.
   - Specular knee. The player's headlights are physical SpotLights (~420-560
     candela, decay 1.4), so up close the irradiance on a car body is enormous
     and the GGX lobe blows out to a white hotspot. A Reinhard knee passes normal
     highlights through nearly unchanged and asymptotes extreme ones to SPEC_MAX.
   - Outgoing-radiance knee, on top of the specular one. The modelled bodyshells
     are built from large flat panels where the old procedural shells were
     curved, and a flat panel has one normal across the whole surface: instead
     of a moving highlight band it lights up all at once, and a pale panel (the
     box truck's cargo body is the worst case) saturates on *diffuse* alone,
     which a specular-only knee cannot touch. This is the same knee the player's
     own paint uses — see tameSpecular in player.ts — applied to the total
     outgoing radiance so both terms are covered. Ordinary lighting never
     reaches the threshold and passes through untouched. */
const SPEC_MAX = 1.0;
const KNEE = 1.3, KNEE_MAX = 4.0;
function npcShader(mat: THREE.MeshStandardMaterial, style = "") {
  const tint = PAINT_TINT[style];
  const paintRef = new THREE.Vector2(tint ? tint.hue : 0, tint ? tint.refLum : 0);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPaintRef = { value: paintRef };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float paintable;
        attribute vec3 paintCol;
        attribute float dissolve;
        attribute float lampKind;
        attribute vec2 lampLvl;
        attribute vec3 washCol;
        varying float vPaintable;
        varying vec3 vPaintCol;
        varying float vDissolve;
        varying float vLampKind;
        varying vec2 vLampLvl;
        varying vec3 vWashCol;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vPaintable = paintable;
        vPaintCol = paintCol;
        vDissolve = dissolve;
        vLampKind = lampKind;
        vLampLvl = lampLvl;
        vWashCol = washCol;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vPaintable;
        varying vec3 vPaintCol;
        varying float vDissolve;
        varying float vLampKind;
        varying vec2 vLampLvl;
        varying vec3 vWashCol;
        uniform vec2 uPaintRef;`
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        if (vDissolve < 0.999) {
          vec2 sp = mod(gl_FragCoord.xy, 4.0);
          float th = (mod(sp.x * 4.0 + sp.y * 5.0 + 1.0, 16.0)) / 16.0;
          if (th > vDissolve) discard;
        }`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vPaintCol, vPaintable);${PAINT_TINT_GLSL}`
      )
      /* Lamps light themselves. The lamp quads are ordinary dark paint
         otherwise, so they only showed when something else lit them, and a
         car's lights lived or died entirely by its glow sprite — which is
         capped in screen size, so the lights faded out exactly as the player
         closed in. An emissive surface scales with the car instead, so a lamp
         reads at any distance and gets brighter as you approach, which is what
         a real one does. Levels are per instance (see renderInstances): x
         drives the headlights, y the tail/brake lamps. */
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        if (vLampKind > 0.5) {
          float lvl = vLampKind > 1.5 ? vLampLvl.y : vLampLvl.x;
          totalEmissiveRadiance += diffuseColor.rgb * lvl;
        }
        /* Streetlight wash (Lane S). The deck's sodium lamps are pure fakes —
           emissive heads + additive cones + ground-pool quads, zero dynamic
           lights — so nothing ever lit an NPC body passing under one. This is
           the matching fake: renderInstances writes a per-instance warm
           radiance (sodium under the lamp lattice, white under the toll
           canopy) and it lands here as albedo-proportional bounce, weighted
           toward up-facing panels so the roof/hood carry the wash the way a
           downlight would. Rides inside outgoingLight, so the anti-blowout
           knee below caps it along with everything else. */
        totalEmissiveRadiance +=
          vWashCol * diffuseColor.rgb * (0.55 + 0.45 * saturate(normal.y));`
      )
      .replace(
        "#include <aomap_fragment>",
        `{
          vec3 ds = reflectedLight.directSpecular;
          reflectedLight.directSpecular = ds / (1.0 + ds / ${SPEC_MAX.toFixed(1)});
        }
        #include <aomap_fragment>`
      )
      .replace(
        "#include <opaque_fragment>",
        `{
          float m = max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b);
          if (m > ${KNEE.toFixed(2)}) {
            float e = m - ${KNEE.toFixed(2)};
            float k = ${KNEE.toFixed(2)} + e / (1.0 + e / ${(KNEE_MAX - KNEE).toFixed(2)});
            outgoingLight *= k / m;
          }
        }
        #include <opaque_fragment>`
      );
  };
  mat.customProgramCacheKey = () => "npcInstanced";
}

/* Glow sprite size cap. PointsMaterial's size attenuation is pure 1/z, so a
   lamp the player is right alongside draws a sprite hundreds of pixels across
   — it stops reading as a lamp and becomes an orb floating over the car. Cap
   it at a fraction of the viewport (three's `scale` uniform is half the
   drawing-buffer height, so this is resolution-independent), which leaves
   everything past a few car lengths pixel-identical. The modelled bodies carry
   real lamp geometry now, so the sprite no longer has to sell the lamp on its
   own up close. */
const SPRITE_MAX = 0.09;
function clampSprite(mat: THREE.PointsMaterial) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace(
      "gl_PointSize *= ( scale / - mvPosition.z );",
      `gl_PointSize *= ( scale / - mvPosition.z );
       gl_PointSize = min( gl_PointSize, scale * ${SPRITE_MAX.toFixed(3)} );`
    );
  };
  mat.customProgramCacheKey = () => "npcSprite";
}

/* Driver personalities. Each NPC rolls one at spawn and keeps it for its whole
   life, so traffic reads as a mix of people instead of one AI: cruise speed,
   headway, patience for lane changes, reaction lag and how much they back off
   for corners and signals all move together per archetype. */
export interface Driver {
  spd: number;    // cruise-speed multiplier
  gap: number;    // following time-gap multiplier
  acc: number;    // acceleration / assertiveness multiplier
  lane: number;   // 0..1 lane-change eagerness (expressway)
  react: number;  // perception refresh interval, seconds
  corner: number; // cornering-speed multiplier
  timid: number;  // 0/1 — lifts and brakes early for signals
  weave: number;  // 0/1 — changes lanes even when nothing blocks them
  jit: number;    // phase of a slow per-driver cruise-speed drift
  /** Persistent lateral offset from the lane's true centre, metres, signed.
      Rolled once at spawn and kept for the driver's whole life — nobody
      actually drives dead-centre. Rides on top of laneOffset() everywhere
      that's read for driving/placement, clamped per-position by maxBias()
      so it never eats into the pavement margin through a taper or the toll
      plaza's spread. */
  bias: number;
  /** Amplitude (m) of an ultra-slow sinusoidal wander on top of `bias`; 0 for
      drivers who don't wander at all. Folded into the render-only `wob` path,
      not into the driving offset itself. */
  driftAmp: number;
  /** Angular rate (rad/s) of that wander — TAU / period, period 20-40s. */
  driftRate: number;
  /** Phase of that wander, so drivers don't wander in lockstep. */
  driftPhase: number;
}

type Arch = {
  spd: [number, number]; gap: [number, number]; acc: [number, number];
  lane: [number, number]; react: [number, number]; corner: [number, number];
  timid: number; weave: number;
};

/* How fast a driver's rendered offset can chase its lane's true centre while
   just holding a lane, as opposed to deliberately changing one. corridor.ts
   sizes every taper's steepness so a car tracking at this rate never falls
   behind the pavement even at the fastest NPCs run (see corridor-finish's
   slope budget: max trackable slope ≈ LANE_FOLLOW_RATE / topSpeed) — if this
   changes, the corridor geometry needs to change with it. It is deliberately
   much quicker than a driver's own laneRate (2-4 s to cross a lane, set on
   commit below), which governs the voluntary, signalled part of a lane
   change; LANE_FOLLOW_RATE only ever applies to the involuntary drift of
   staying put while the lane itself narrows or slides under a taper. */
const LANE_FOLLOW_RATE = 3.4;

/* dawdler · cautious · average · brisk · speeder */
const ARCH: Arch[] = [
  { spd: [0.72, 0.83], gap: [1.35, 1.62], acc: [0.72, 0.85], lane: [0, 0.12], react: [0.42, 0.6], corner: [0.72, 0.83], timid: 1, weave: 0 },
  { spd: [0.85, 0.95], gap: [1.12, 1.34], acc: [0.85, 0.96], lane: [0.15, 0.38], react: [0.32, 0.44], corner: [0.84, 0.94], timid: 1, weave: 0 },
  { spd: [0.95, 1.08], gap: [0.94, 1.12], acc: [0.96, 1.06], lane: [0.4, 0.62], react: [0.22, 0.34], corner: [0.95, 1.05], timid: 0, weave: 0 },
  { spd: [1.08, 1.2], gap: [0.82, 0.95], acc: [1.06, 1.18], lane: [0.64, 0.86], react: [0.18, 0.26], corner: [1.04, 1.13], timid: 0, weave: 0 },
  { spd: [1.2, 1.32], gap: [0.68, 0.82], acc: [1.18, 1.32], lane: [0.88, 1], react: [0.12, 0.2], corner: [1.12, 1.23], timid: 0, weave: 1 },
];

export interface Npc {
  id: number;
  active: boolean;
  type: string;
  /** index into the per-style instanced meshes */
  style: number;
  /** baked paint colour, linear RGB */
  cr: number; cg: number; cb: number;
  L: number; W: number; wr: number; wz: number; mass: number;
  wheelOffs: [number, number][];
  hw: boolean;
  edge: REdge | null;
  eDir: number;
  segHint: { i: number };
  nextEdgeId: number;
  /** always +1 on the corridor; kept so the minimap/debug can read a heading */
  dir: number;
  /** Route-graph edge this expressway car is driving: −1 is the main
      corridor (`n.s` = corridor z, exactly as ever), BYPASS_EDGE puts `n.s`
      in the bypass's own arclength space. Town cars ignore it. */
  route: number;
  /** diverge decision: 0 undecided, 1 taking the bypass, −1 staying on */
  wantBypass: number;
  laneK: number; offCur: number; offT: number;
  /** target lane once the pre-signal delay elapses; -1 when not changing */
  pendK: number;
  /** lateral m/s this driver crosses a lane at, once committed (2-4s/lane) */
  laneRate: number;
  /** corridor z for expressway cars, edge arclength for town cars */
  s: number;
  v: number; v0: number;
  drv: Driver;
  /** perceived leader, refreshed on the driver's reaction interval */
  pT: number; pLead: { ds: number; v: number };
  brake: boolean; blink: number; blinkT: number; turnCd: number; nudgeT: number;
  hVis: number; x: number; y: number; z: number; spin: number; wob: number;
  wreck: { vx: number; vz: number; vr: number; age: number } | null;
  fade: number;
  /** set the frame a close call with the player fires, else null; cooldown in ccCd */
  ccKind: "horn" | "chirp" | null;
  ccCd: number;
}

type Cloud = { arr: Float32Array; geo: THREE.BufferGeometry; pts: THREE.Points };
type Lod = {
  mesh: THREE.InstancedMesh;
  paint: THREE.InstancedBufferAttribute;
  diss: THREE.InstancedBufferAttribute;
  /** per instance: x = headlight level, y = tail/brake level */
  lamp: THREE.InstancedBufferAttribute;
  /** per instance: streetlight wash radiance, linear RGB (see washCol) */
  wash: THREE.InstancedBufferAttribute;
  n: number;
};

/* ---- fake NPC headlight ground pools ----
   Real per-NPC SpotLights are banned (each one multiplies the lit-shader cost
   of every surface it touches; the player's own lamps are the entire dynamic
   budget), so the road-lighting read comes from the standard fake: one
   instanced, additive, depth-write-off quad per car, textured with an
   elongated warm-white gradient and slid along the deck just ahead of the
   bumper. Generated locally on a small canvas — deliberately not imported
   from textures.ts, which other systems own. */
/* Footprint, per user call for "more spread, less focused bright":
   - POOL_W 3.5 → 5.2. At 3.5 m the pool did not even cover the 3.7 m lane the
     car was in, so it read as a stripe under the bumper rather than as lit
     road. 5.2 m spills about 0.75 m into each neighbouring lane, which is what
     a real low beam does. Widening is also what makes a fake pool MORE visible
     in the POV dashcam grade, not less: that pass crushes with
     `max(col - .06, 0)`, so what survives is the count of pixels above the
     floor, and a wide dim footprint has far more of them than a narrow bright
     one.
   - POOL_LEN 8.6 → 15.0, spent almost entirely on the tail (see POOL_ROWS).
     The quad still starts behind the bumper: it is centred at
     L/2 + 0.42·len ahead, so the near edge sits 0.08·len = 1.2 m BEHIND the
     bumper line and its cut-off stays hidden under the nose of the car.
   - POOL_GAIN 0.42 → 0.36. The "less focused bright" half of the request, and
     deliberately small: the footprint grows 2.6x in area, so the net still
     reads clearly wider rather than merely dimmer.
   - POOL_LEN 15.0 → 18.0 ("stronger / longer" NPC beams, at zero perf): the
     span IS the brightness lever here. The POV crush (`max(col - .06, 0)`)
     keeps only pixels above its floor, so a longer footprint reads as a
     stronger beam; the non-uniform POOL_ROWS mapping stretches with it, so
     the tail keeps its 40%-of-length creep and no new edge appears.
     POOL_GAIN deliberately does NOT rise with it: the hot core already
     composites to ≈ 0.71 display luma (0.85 texel × 0.36 through ACES at
     night exposure), i.e. a hair under the 0.72 blown-highlight clip in
     post.ts — brightening the core is the one move with no headroom, and
     the clip would eat the gain and hand back a white patch. Cost of the
     length: ~20% more area on ONE instanced additive draw, no lights, no
     draw calls — real per-NPC lights stay banned (see above). */
const POOL_LEN = 18.0, POOL_W = 5.2, POOL_GAIN = 0.36, POOL_FADE_D = 240;
/* Canvas layout of the pool gradient, shared with the UV remap below so the
   two can never drift apart. The gradient is a radial one centred POOL_HOT_Y
   down the canvas, stretched POOL_EL× along y; texture radius fraction t runs
   from POOL_R0 to POOL_R1 pixels. */
const POOL_TEX_H = 128, POOL_HOT_Y = 40, POOL_EL = 2.1, POOL_R0 = 2, POOL_R1 = 30;
/** canvas v coordinate at texture-radius fraction t, on the far (tail) side */
const poolV = (t: number) =>
  1 - (POOL_HOT_Y + POOL_EL * (POOL_R0 + (POOL_R1 - POOL_R0) * t)) / POOL_TEX_H;
function poolTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, 64, 128);
  /* additive: black is "off", so the falloff lives in RGB, not alpha. The hot
     spot sits ~30% down from the top edge (the bumper end after the quad is
     laid flat) and feathers out well before every border so instances never
     show a seam. */
  g.save();
  g.translate(32, POOL_HOT_Y);
  g.scale(1, POOL_EL);
  const grad = g.createRadialGradient(0, 0, POOL_R0, 0, 0, POOL_R1);
  /* The core (t 0 → 0.35, the 0.85 → 0.5 region) is EXACTLY the old curve —
     that part of the look is what the user likes. Everything past 0.35 is the
     old single 0.5 → 0.16 → 0 ramp resampled as many closely-spaced stops on a
     smooth decelerating curve, ending in a long low creep (0.135 → 0 spread
     over the last 16% of the radius instead of the last 25% as a straight
     line). Three linear segments are fine over an 8.6 m quad and print their
     own knees as bands once stretched over 15 m; and a LINEAR outer ramp
     crosses the POV crush floor at a definite radius, which is the "scoped"
     circular edge rather than a fade.
     Because this is additive over black, the composited texel is alpha × rgb,
     so the RGB ramp is part of the falloff and is what makes the real curve
     steeper than the alpha column suggests. The old tail dropped rgb to
     (96,88,72) by t = 0.75 and then to black, doubling up on the alpha fade;
     the new tail settles toward (110,101,84) and lets alpha carry the last of
     it, so the creep stays a creep. */
  const STOPS: readonly (readonly [number, number])[] = [
    [0.00, 0.850], [0.35, 0.500], [0.45, 0.420], [0.55, 0.340],
    [0.65, 0.265], [0.72, 0.215], [0.78, 0.175], [0.84, 0.135],
    [0.89, 0.100], [0.93, 0.070], [0.96, 0.045], [0.98, 0.026],
    [0.99, 0.014], [1.00, 0.0],
  ];
  for (const [t, a] of STOPS) {
    // warm white in the core, cooling and darkening out through the skirt
    const s = t <= 0.35 ? t / 0.35 : (t - 0.35) / 0.65;
    const r = t <= 0.35 ? 255 - 41 * s : 214 - 104 * s;
    const gg = t <= 0.35 ? 242 - 44 * s : 198 - 97 * s;
    const b = t <= 0.35 ? 214 - 46 * s : 168 - 84 * s;
    grad.addColorStop(t, `rgba(${Math.round(r)},${Math.round(gg)},${Math.round(b)},${a})`);
  }
  g.fillStyle = grad;
  g.fillRect(-32, -20, 64, 64);
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---- streetlight wash over NPC bodies ----
   The deck's sodium lamps are fakes (no dynamic lights), so a car driving
   under one stayed visually unlit while the deck around it glowed. Fix is the
   matching fake: a per-instance warm radiance (washCol, read by npcShader
   above) driven by proximity to the nearest lamp. Lamp positions are never
   searched — both routes place their lights on a regular station lattice
   (highway.ts, PITCH.light/PHASE.light), so nearest-lamp distance is pure
   arithmetic plus one table lookup. The tables are baked once at construction
   from the same rules highway.ts emits pools with (tunnel/toll skips, gore
   parapet gaps, per-tier lampPoolEvery thinning, alternating sides), so a car
   only ever washes under a lamp whose pool actually renders on this tier.
   KEEP IN LOCKSTEP with the streetlight block in world/highway.ts. */
const NO_LAMP = 1e9;
/** falloff along the road: full inside CORE m of the lamp station, zero past
    R m — a ~13 m lit footprint under each lamp, matching the deck pool quad
    (5.6 m half-axis) with a little spill */
const WASH_CORE_Z = 2.0, WASH_R_Z = 6.5;
/** lateral falloff from the pool centre (pools sit toward the lamp's side of
    the road; lamps alternate sides station to station) */
const WASH_CORE_L = 1.8, WASH_R_L = 7.0;
/** peak wash radiance as a multiple of body albedo */
const WASH_GAIN = 1.25;
/** sodium tint, linear (≈ the pools' sRGB 255,205,140 family) */
const WASH_R = 1.0, WASH_G = 0.61, WASH_B = 0.26;
/** the toll canopy's troffer zone: flat white light under the 34 m canopy */
const TOLL_WASH_ZC = (TOLL.plazaZ0 + TOLL.plazaZ1) / 2;
const TOLL_WASH_CORE = 13, TOLL_WASH_R = 21;
const TOLL_WASH_GAIN = 0.7;
const TOLL_WASH_TINT_R = 0.92, TOLL_WASH_TINT_G = 0.95, TOLL_WASH_TINT_B = 1.0;

/* ---- player-headlight wash over NPC bodies ----
   Same "matching fake" as the streetlight wash above, for the player's own
   beams. The real headlight SpotLights DO reach NPC materials — nothing is
   layered out — but they cannot make a car ahead read as lit at following
   distance, by construction: the dipped cone is edge-pinned (upper edge
   0.23° below horizontal) with penumbra 1.0, so a vertical panel at 25-40 m
   sits both above the cut-off (only the sub-0.5 m valance band is inside the
   cone at all) and in the last degree before the cone rim, where the angular
   smoothstep is ~0.01. Worked number: at 30 m the bumper of the car ahead
   receives ≈ 60/30^0.45 × 0.012 ≈ 0.09 — invisible. Fixing that by widening
   or re-aiming the cone would re-tune the beam-on-road look (see the long
   angle/decay comments in engine.ts weather()), so the car-body response is
   faked here instead: a per-instance radiance added into the same washCol
   channel the streetlights use, gated on a forward wedge from the player's
   nose. Zero cost — one dot product per NPC per frame, no lights, no new
   attributes — and the anti-blowout knee caps it with everything else.

   DELIBERATELY SUBTLE ("really subtle" — the user, twice). At full wash a
   mid-grey panel adds ≈ 0.12 × 0.35 albedo × 0.55 vertical-panel weight
   ≈ 0.023 linear — through ACES + the POV crush that lifts a panel from
   ≈ 0.13 to ≈ 0.20 display luma at close range, about half that at 30 m.
   A brightening you notice when it sweeps on or off a car, not a spotlight.
   Raise HLW_GAIN in ~0.03 steps if it must read stronger; past ~0.25 the
   car ahead starts looking self-lit and the effect gives itself away. */
const HLW_GAIN = 0.12;
/** along-beam falloff, metres ahead of the player's nose: full to 18 m, then
    a smoothstep tail to zero at 60 m — the far half is what puts a faint
    read on a car at highway following distance without pinning near cars */
const HLW_CORE_D = 18, HLW_R_D = 60;
/** lateral falloff, metres off the beam axis; widens with distance like the
    two toed-out cones' combined footprint (~9°/17° from centre) */
const HLW_CORE_L0 = 1.8, HLW_R_L0 = 4.2, HLW_CORE_LK = 0.08, HLW_R_LK = 0.16;
/** dipped-beam 0xffeeda in linear — matches the SpotLights and the parapet
    wash in mats.ts, so every surface answers the beam in one colour */
const HLW_R = 1.0, HLW_G = 0.858, HLW_B = 0.708;

/** smoothstep-shaped falloff: 1 inside `core`, 0 past `r` */
function washFall(d: number, core: number, r: number) {
  if (d >= r) return 0;
  if (d <= core) return 1;
  const t = (r - d) / (r - core);
  return t * t * (3 - 2 * t);
}

/** One slot of the doppler feed's reused result buffer — see Traffic.nearestNpcs. */
export interface NpcAudioSample {
  npc: Npc | null;
  x: number; y: number; z: number;
  vx: number; vz: number;
  d2: number;
  type: string;
  /** true for a truck/bus — heavy vehicles get a lower doppler drone pitch */
  heavy: boolean;
}

export class Traffic {
  npcs: Npc[] = [];
  private scene: THREE.Scene;
  private world: WorldData;
  private npcMat: THREE.MeshStandardMaterial;
  private styles: Lod[] = [];
  private styleOf: Record<string, number> = {};
  /** per style, the loaded model's real lamp clusters; null until one lands */
  private lampsOf: (NpcLamps | null)[] = [];
  /** per style: its Orchids bodyshell has landed and the style may spawn.
      Nothing renders, spawns or sprites a style before this flips — there is
      no placeholder body to fall back to, by design. */
  private ready: boolean[] = [];
  /** every style has been tried (loaded or failed) — until then the corridor
      seeding frame is held open so the first fill happens with the fleet in */
  private fleetReady = false;
  private wheelInst: THREE.InstancedMesh;
  private wheelCount = 0;
  /** Fake headlight ground pools (one instanced additive quad per car).
      Public switch so a quality tier can turn the whole draw off; while on it
      costs a single draw call for the entire fleet. */
  headlightPools = true;
  private poolInst: THREE.InstancedMesh;
  private poolColor: THREE.InstancedBufferAttribute;
  private clouds: Record<string, Cloud> = {};
  private pose: EdgePose = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
  private pose2: EdgePose = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
  private cor = getCorridor();
  private routes = getRouteGraph();
  /** mergeWindow() walks every bypass station — resolve once */
  private mergeWin = this.routes.mergeWindow();
  private bpose: RoutePose = {
    x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: 1, nz: 0, h: 0, grade: 0, bank: 0,
  };
  /** player's bypass surface hit this frame, or null (set in update()) */
  private playerBy: { s: number } | null = null;
  private cpose = { x: 0, y: 0, z: 0, tx: 0, tz: 1, nx: 1, nz: 0, h: 0, grade: 0 };
  private _cw = { x: 0, y: 0, z: 0 };
  private rng = mulberry32(0xbeef);
  private _wd = new THREE.Object3D();
  private _lead = { ds: 0, v: 0 };
  private _lead2 = { ds: 0, v: 0 };
  private _stop = { ds: 0, v: 0 };
  private _idleA: Npc[] = [];
  private _idleB: Npc[] = [];
  private _wrecks: Npc[] = [];
  private _closeCalls: Npc[] = [];
  /** Global close-call rate cap, decremented once per update() below —
      on top of each NPC's own ccCd, this caps the whole traffic system to
      one reaction every CC_GLOBAL_GAP seconds regardless of how many NPCs
      independently qualify in the same window, so weaving through a
      crowded scene can't produce a chorus of horns/chirps in short order. */
  private globalCcCd = 0;
  // Tuned against a Monte Carlo sim of a 2-minute aggressive weave to land
  // the total reaction count around 5-10 (the actual target), not just to
  // match "4-6s" as a literal number — at this game's encounter density,
  // 4-6s alone still landed near 11-15 total, so this leans a bit longer.
  private static readonly CC_GLOBAL_GAP = 8;
  /** Kill switch for the close-call reaction sounds (horn/chirp on near-
      misses) — OFF per a user decision superseding the rarity tuning above.
      All the detection/gating/cooldown machinery above is left intact
      (including the sound-quality work in audio.ts's npcHorn/npcChirp) so
      this can come back for a future scoring-feedback feature by flipping
      one flag; closeCalls() below simply never has anything to report while
      this is false, since n.ccKind is only ever set past this gate. The
      doppler engine voice pool (updateNpcs) is a completely separate system
      and is unaffected. */
  private static readonly CLOSE_CALL_AUDIO = false;
  private _nearBuf: NpcAudioSample[] = Array.from({ length: 12 }, () => ({
    npc: null, x: 0, y: 0, z: 0, vx: 0, vz: 0, d2: 0, type: "", heavy: false,
  }));
  /* Streetlight-wash lookup tables (see the WASH_* block above). One slot per
     lamp lattice station; the value is the lamp pool's lateral centre offset
     in that route's own frame, or NO_LAMP where no pool renders (tunnel, toll,
     gore gaps, tier thinning, gore-clipped viaduct stations). */
  private deckLampLat: Float32Array = new Float32Array(0);
  private byLampLat: Float32Array = new Float32Array(0);
  private nDeckLamp = 0;
  private tollWashOn = false;
  /* Cars may only enter from beyond the fog wall, and they close on the player
     slowly, so a cold start would leave the road ahead empty for a minute or
     more. On the first frame — and after any teleport — the corridor ahead is
     seeded in one go instead, before that viewpoint has ever been rendered. */
  private warpSeed = true;
  private lastPx = 0;
  private lastPz = 0;
  /** sight-line tests allowed this frame */
  private occBudget = 0;
  readonly N: number;

  constructor(scene: THREE.Scene, world: WorldData, envMap: THREE.CubeTexture, glowTex: THREE.Texture, N = 120) {
    this.scene = scene;
    this.world = world;
    this.N = N;
    /* Rougher and less metallic than the procedural shells wanted: those were
       curved enough to hide a tight specular lobe, the modelled panels are
       flat and concentrate it. Still well clear of a mirror finish. */
    this.npcMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.64, metalness: 0.24,
      envMap, envMapIntensity: 0.45, side: THREE.DoubleSide,
    });
    npcShader(this.npcMat);

    /* Decide the fleet mix first: each style needs an instance buffer big
       enough for every pool slot that could use it. Deliberately small roster
       (mobile memory): mostly regular cars, with vans/trucks/buses sprinkled
       in, plus the two forced police cruisers below. */
    const roster: string[] = [];
    const mix: [string, number][] = [
      ["sedan", 0.25], ["hybrid", 0.19], ["compact", 0.19], ["suv", 0.17],
      ["taxi", 0.07], ["van", 0.06], ["truck", 0.05], ["bus", 0.02],
    ];
    for (let i = 0; i < N; i++) {
      let r = this.rng(), type = mix[mix.length - 1][0];
      for (const [t, w] of mix) {
        r -= w;
        if (r <= 0) { type = t; break; }
      }
      if (i === 3 || i === Math.floor(N * 0.6)) type = "police";
      roster.push(type);
    }
    const perStyle: Record<string, number> = {};
    for (const t of roster) perStyle[t] = (perStyle[t] || 0) + 1;

    for (const type in perStyle) {
      const cap = perStyle[type];
      this.styleOf[type] = this.styles.length;
      /* The mesh starts on an empty geometry — the style is invisible (and
         barred from spawning) until applyModel installs its Orchids
         bodyshell. There is no placeholder body on purpose. */
      const m = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.npcMat, cap);
      m.castShadow = true;
      m.frustumCulled = false; // instances are culled by hand below
      m.count = 0;
      m.visible = false;
      const paint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      const diss = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      const lamp = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
      const wash = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      diss.array.fill(1);
      paint.setUsage(THREE.DynamicDrawUsage);
      diss.setUsage(THREE.DynamicDrawUsage);
      lamp.setUsage(THREE.DynamicDrawUsage);
      wash.setUsage(THREE.DynamicDrawUsage);
      m.geometry.setAttribute("paintCol", paint);
      m.geometry.setAttribute("dissolve", diss);
      m.geometry.setAttribute("lampLvl", lamp);
      m.geometry.setAttribute("washCol", wash);
      scene.add(m);
      this.lampsOf.push(null);
      this.ready.push(false);
      this.styles.push({ mesh: m, paint, diss, lamp, wash, n: 0 });
    }

    this.buildLampWashTables();

    /* Sized for MAX_WHEELS rather than four: a modelled body may carry a
       second rear axle (the box truck does), and its wheels are only known
       once that model lands. */
    this.wheelInst = new THREE.InstancedMesh(
      wheelGeo(),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.15 }),
      N * MAX_WHEELS
    );
    this.wheelInst.frustumCulled = false;
    this.wheelInst.count = 0;
    scene.add(this.wheelInst);

    /* Headlight ground pools: one quad per possible car, laid flat, additive,
       never writing depth, drawn with the other transparents (after the
       opaque road). Per-instance brightness rides in instanceColor, which is
       the one per-instance channel MeshBasicMaterial already understands —
       with additive blending, dimming the colour IS dimming the light. */
    /* Ten longitudinal segments, with the v coordinate rewritten NON-UNIFORMLY
       along them. The pool's falloff problem is one of ALLOCATION, not shape:
       the gradient's low tail occupies the last few percent of its radius, so
       under the uniform UV mapping of a single quad that tail got a few percent
       of the pool's length — centimetres of road, which reads as the light
       stopping dead rather than fading. Advancing texture radius SLOWER than
       distance toward the outer end hands the dim end of the same curve a
       disproportionate share of the ground: the inner half of the radius now
       covers 4.5 m and the outer half covers 10.5 m.

       Weighted hardest at the very END, because the POV chain crushes with
       `max(col - .06, 0)` — an absolute cliff to zero, which cannot be removed,
       only moved to where the light is already faint and the shadow grain
       dithers across it. Hence the tightly-spaced outer rows: t 0.835 → 1
       (alpha .138 → 0) gets 40% of the pool's length, 6.0 m of road, against
       1.0 m for the old .16 → 0 before.

       Do NOT collapse this back to `PlaneGeometry(1, 1)` — the mesh is
       instanced, so the extra vertices are paid once for the entire fleet, and
       the single-quad version is exactly the defect. Row 0 is the near edge and
       keeps v = 1: the gradient is still climbing there (alpha ~.30, mirrored
       across the hot spot), and that edge sits behind the bumper, hidden under
       the nose of the car. Row 1 is the hot spot, 1.5 m in. */
    const POOL_ROWS: readonly number[] = [
      -1, 0, 0.26, 0.47, 0.615, 0.74, 0.835, 0.895, 0.935, 0.968, 1.0,
    ];
    const poolGeo = new THREE.PlaneGeometry(1, 1, 1, POOL_ROWS.length - 1);
    {
      /* PlaneGeometry rows run +y (v = 1) → -y (v = 0), two vertices each;
         rotateX below sends +y to -z, so row 0 / v = 1 stays the hot end and
         the mapping the driving code assumes is preserved. */
      const uv = poolGeo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < POOL_ROWS.length; i++) {
        const t = POOL_ROWS[i];
        const v = t < 0 ? 1 : poolV(t);
        uv.setY(i * 2, v);
        uv.setY(i * 2 + 1, v);
      }
      uv.needsUpdate = true;
    }
    poolGeo.rotateX(-Math.PI / 2); // face up; canvas "top" (hot end) → local -z
    this.poolInst = new THREE.InstancedMesh(
      poolGeo,
      new THREE.MeshBasicMaterial({
        map: poolTexture(), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false,
      }),
      N
    );
    this.poolColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.poolColor.setUsage(THREE.DynamicDrawUsage);
    this.poolInst.instanceColor = this.poolColor;
    this.poolInst.frustumCulled = false;
    this.poolInst.count = 0;
    this.poolInst.visible = false;
    scene.add(this.poolInst);

    const mkCloud = (color: number | THREE.Color, size: number): Cloud => {
      const arr = new Float32Array(N * 2 * 3);
      arr.fill(-999);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const pmat = new THREE.PointsMaterial({
        size, map: glowTex, color, transparent: true, opacity: 0.95,
        sizeAttenuation: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      clampSprite(pmat);
      const pts = new THREE.Points(geo, pmat);
      pts.frustumCulled = false;
      scene.add(pts);
      return { arr, geo, pts };
    };
    /* Head glow: size 1.05 → 1.35 with the tint scaled 0.82× (0xcfe0ff →
       0xa9b7d1 — a uniform scale, so the hue is untouched). Broader and softer:
       1.65× the sprite area against a 0.82× peak, so the spread is not
       cancelled by the dim, which is the request ("spread more, less focused
       bright") in the one place NPC head glow is authored. Only the near field
       is affected by SPRITE_MAX — the cap now engages inside ~15 m rather than
       ~12 m, and everything beyond that is pure 1/z as before.
       Tail/brake keep the size nudge (0.85 → 0.96, 1.5 → 1.62) from that pass.

       Tail/brake TINTS are HDR triples, not hexes, because a hex cannot express
       what these lamps need. Worked arithmetic, all of it against the post
       chain rather than in isolation:

       - The additive sprite core lands in sceneRT at `color × opacity(0.95) ×
         texel(1)`, and the bloom bright-pass floor is `T - K = 0.40` post-
         exposure (night uExp 0.98). Old tail 0xff3344 → luma 0.416, weight
         0.0003. Old brake 0xff2233 → luma 0.372, weight 0.0000. So neither red
         lamp bloomed AT ALL, which is why "brighter" never landed: a lamp with
         no bloom is a flat coloured polygon, not a light source. Worse, brake
         was the DARKER of the two in luma (0.372 < 0.416) despite being the
         "bright" state — 0xff2233 is more saturated than 0xff3344 and the
         .299/.587/.114 weighting charges saturated red about 3.2× against
         white, so the extra saturation cost more luma than the size gained.
       - sceneRT is HalfFloat (post.ts) and the bright pass only clamps at 14,
         so components above 1.0 survive: the multiplier has to come from the
         colour, since opacity is shared with every other cloud and caps at 1.
       - Levels chosen: tail luma 0.676 (weight 0.0512, ~190× the old), brake
         luma 0.947 — right at T, where the soft knee hands over to the hard
         threshold — for weight 0.1435, 2.8× the tail's. Brake is a clear step
         above tail in BOTH core level (red 3.05 vs 2.05) and bloom.
       - Red carries almost all of it and g/b stay LOW on purpose. Two reasons.
         The .299 weight means luma has to come from red anyway; and the POV
         blown-highlight clip (post.ts, toward flat white above 0.72 luma) is
         gated off by lampProtect for saturated pixels, so keeping saturation is
         what buys the headroom. Pushing all three channels up uniformly would
         have desaturated through ACES, dropped lampProtect and handed the lamp
         to the clip. Checked, not assumed: through ACES + the 1/2.2 encode +
         the vibrance term the tail arrives at luma 0.611 / saturation 0.610 →
         lampProtect 1.00, and brake at 0.676 / 0.530 → 0.804; both are under
         the 0.72 knee, so the clip contributes exactly 0.0 even before the
         protection, and it stays 0.0 when the bloom is fed back in at up to 3×.
       - The rendered hue barely moves even though the source is much redder:
         ACES desaturates the high red on its way out, so post-grade the tail
         reads (1.04, 0.43, 0.45) against the old (0.85, 0.39, 0.45) — the same
         pinkish red, brighter. Picking the source against the grade rather than
         by eye is the whole trick here.
       sig/roof/police tints are deliberately untouched — no complaint about
       them, and the amber already clears the floor (luma 0.638). */
    this.clouds = {
      head: mkCloud(0xa9b7d1, 1.35),
      tail: mkCloud(new THREE.Color(2.05, 0.15, 0.22), 0.96),
      brake: mkCloud(new THREE.Color(3.05, 0.14, 0.20), 1.62),
      sig: mkCloud(0xffa028, 1.05),
      roof: mkCloud(0xffb040, 0.95), polR: mkCloud(0xff3040, 1.5),
      polB: mkCloud(0x3d74ff, 1.5),
    };

    const C = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const type = roster[i];
      const d = TYPE_DIM[type];
      C.setHex(
        type === "taxi" ? 0xe8b830 : type === "police" ? 0xeef0f4 : pick(NPC_COLORS)
      );
      const hw2 = d.W / 2 - 0.14;
      this.npcs.push({
        id: i, active: false, type, style: this.styleOf[type],
        cr: C.r, cg: C.g, cb: C.b,
        L: d.L, W: d.W, wr: d.wr, wz: d.wz, mass: d.mass,
        wheelOffs: [[d.wz, hw2], [d.wz, -hw2], [-d.wz, hw2], [-d.wz, -hw2]],
        hw: true, edge: null, eDir: 1, segHint: { i: 0 }, nextEdgeId: -1,
        dir: 1, route: -1, wantBypass: 0,
        laneK: 1, offCur: 0, offT: 0, pendK: -1, laneRate: this.cor.lanePitch(0) / 3, s: 0,
        v: 0, v0: 10,
        drv: {
          spd: 1, gap: 1, acc: 1, lane: 0.5, react: 0.3, corner: 1, timid: 0, weave: 0, jit: rand(0, TAU),
          bias: 0, driftAmp: 0, driftRate: 0, driftPhase: 0,
        },
        pT: 0, pLead: { ds: Infinity, v: 0 },
        brake: false,
        blink: 0, blinkT: 0, turnCd: rand(2, 8), nudgeT: 0,
        hVis: 0, x: 0, y: -999, z: 0, spin: 0, wob: 0,
        wreck: null, fade: 1, ccKind: null, ccCd: 0,
      });
    }

    /* Load the bodyshells. Each model that lands makes its style live; the
       fleetReady latch (set when every style has been tried) releases the
       corridor seeding frame, so the opening fill happens with real cars.
       A style whose file is missing or corrupt simply never spawns. */
    void loadNpcModels(Object.keys(this.styleOf), (m) => this.applyModel(m)).then(
      () => { this.fleetReady = true; }
    );
  }

  /** Bake the streetlight-wash tables from the same placement rules the
      streetlight block in world/highway.ts emits pools with — KEEP IN
      LOCKSTEP with it. Deck lamps sit on the corridor lattice
      (PITCH.light/PHASE.light, sides alternating with the folded index,
      skipped through the tunnel/toll and the bypass-gore parapet gaps);
      viaduct lamps sit on the bypass's own s-lattice with gore-clipped
      stations dropped. Pool thinning follows worldTierCaps().lampPoolEvery
      exactly (deck thinning works in pole PAIRS, viaduct thinning on the
      emit counter), so a car never washes under a lamp whose pool this tier
      culled. Pool centre = lamp side · (halfWidth − 2.12): parapet mount
      +0.23, arm/head −1.55, pool centre a further −0.8 inboard. */
  private buildLampWashTables() {
    const caps = worldTierCaps();
    // FX_LAMP_POOLS in highway.ts is a const true; the tier cap is the only
    // runtime gate on the pools, so it is the only gate mirrored here
    const washOn = caps.lampPoolEvery !== 0;
    const poolEvery = Math.max(1, caps.lampPoolEvery ?? 1);
    this.tollWashOn = washOn && caps.tollGlow !== false;
    const cor = this.cor;
    const phase = PHASE.light ?? 0;
    const nL = Math.round(cor.LOOP / PITCH.light);
    this.nDeckLamp = nL;
    this.deckLampLat = new Float32Array(nL).fill(NO_LAMP);
    const gaps = this.routes.newParapetGaps();
    if (washOn)
      for (let ki = 0; ki < nL; ki++) {
        const z = cor.wrapZ(phase + ki * PITCH.light);
        if (cor.inTunnel(z) || cor.inToll(z)) continue;
        const flip = ki % 2 ? 1 : -1;
        if (gaps.some((g) => z > g.z0 && z < g.z1 && (g.side > 0) === (flip > 0)))
          continue;
        if (ki % (2 * poolEvery) >= 2) continue; // pools thin in pole pairs
        this.deckLampLat[ki] = flip * (cor.halfWidth(z) - 2.12);
      }
    const by = this.routes.bypass;
    const kbN = Math.max(0, Math.floor((by.len - phase) / PITCH.light) + 1);
    this.byLampLat = new Float32Array(kbN).fill(NO_LAMP);
    if (washOn) {
      let k2 = 0, bi = 0;
      for (let kb = 0; kb < kbN; kb++) {
        const s = phase + kb * PITCH.light;
        if (s < 40 || s > by.len - 40) continue;
        const flip = k2++ % 2 ? 1 : -1;
        const hws = by.halfWidths(s);
        const hw = flip > 0 ? hws.hwL : hws.hwR;
        if (hw < BYPASS.half - 0.02) continue; // gore-clipped station
        const idx = bi++;
        if (idx % poolEvery !== 0) continue;
        this.byLampLat[kb] = flip * (hw - 2.12);
      }
    }
  }

  /** Install a loaded bodyshell as its style's one and only geometry, and let
      the style spawn. Instance state — matrices, paint colours, dissolve — is
      untouched, so this can land on any frame, mid-drive. */
  private applyModel(m: NpcModel) {
    const si = this.styleOf[m.style];
    if (si === undefined) return;
    const lod = this.styles[si];
    const old = lod.mesh.geometry;
    if (old === m.geo) return;

    // the per-instance buffers move across to the new geometry as the same
    // objects, so they must be off the old one before it is disposed — a
    // dispose would otherwise free buffers the mesh is still drawing from
    m.geo.setAttribute("paintCol", lod.paint);
    m.geo.setAttribute("dissolve", lod.diss);
    m.geo.setAttribute("lampLvl", lod.lamp);
    m.geo.setAttribute("washCol", lod.wash);
    lod.mesh.geometry = m.geo;
    if (m.map) {
      /* Each textured body keeps one resized texture. The meshes are already
         separate instanced draw calls by style, so a per-style material
         preserves the authored UV detail without changing the fleet's
         draw-call count. */
      const material = this.npcMat.clone();
      material.map = m.map;
      material.roughnessMap = m.roughnessMap;
      material.metalnessMap = m.metalnessMap;
      if (m.roughnessMap) material.roughness = 1;
      if (m.metalnessMap) material.metalness = 1;
      material.needsUpdate = true;
      npcShader(material, m.style);
      lod.mesh.material = material;
    }
    old.deleteAttribute("paintCol");
    old.deleteAttribute("dissolve");
    old.deleteAttribute("lampLvl");
    old.deleteAttribute("washCol");
    old.dispose();

    this.lampsOf[si] = m.lamps;
    this.ready[si] = true;

    /* Put the shared wheels in this body's own arches. wr/wz are visual only
       (wheel placement and roll rate), so this is safe to change under a car
       that is already driving. */
    if (m.wheels.length >= 2) {
      let r = 0;
      for (const w of m.wheels) r += w.r;
      r /= m.wheels.length;
      const offs = m.wheels.map((w) => [w.z, w.x] as [number, number]);
      for (const n of this.npcs) {
        if (n.type !== m.style) continue;
        n.wr = r;
        n.wz = Math.abs(offs[0][0]);
        n.wheelOffs = offs;
      }
    }
  }

  /* ---------------- spawning ---------------- */

  private deactivate(n: Npc) {
    n.active = false;
    n.y = -999;
    n.wreck = null;
    n.fade = 1;
    n.pendK = -1;
    n.blink = 0;
    n.ccKind = null;
    n.route = -1;
    n.wantBypass = 0;
  }

  /** Roll a persistent personality. Heavies never speed, police are always brisk. */
  private rollDriver(n: Npc) {
    const heavy = n.type === "truck" || n.type === "bus";
    let r = this.rng();
    if (n.type === "police") r = 0.74 + r * 0.18;
    else if (heavy) r = Math.min(r, 0.66);
    const idx = r < 0.1 ? 0 : r < 0.3 ? 1 : r < 0.72 ? 2 : r < 0.92 ? 3 : 4;
    const A = ARCH[idx];
    const d = n.drv;
    const R = (p: [number, number]) => p[0] + this.rng() * (p[1] - p[0]);
    d.spd = R(A.spd);
    d.gap = R(A.gap);
    d.acc = R(A.acc);
    d.lane = R(A.lane);
    d.react = R(A.react);
    d.corner = R(A.corner);
    d.timid = A.timid;
    d.weave = A.weave;
    d.jit = this.rng() * TAU;
    // dawdler/cautious hug the centre closest, brisk/speeder drift furthest —
    // sign is a coin flip, so no side of a lane reads as systematically busier
    const biasLo = idx <= 1 ? 0.05 : idx === 2 ? 0.1 : 0.15;
    const biasHi = idx <= 1 ? 0.15 : idx === 2 ? 0.3 : 0.4;
    d.bias = (this.rng() < 0.5 ? -1 : 1) * R([biasLo, biasHi]);
    // ~40% of drivers hold their line dead steady; the rest wander a hair,
    // slow enough (20-40s/cycle) that it reads as human, not as a glitch
    if (this.rng() < 0.4) {
      d.driftAmp = 0;
      d.driftRate = 0;
    } else {
      d.driftAmp = rand(0.04, 0.08);
      d.driftRate = TAU / rand(20, 40);
    }
    d.driftPhase = this.rng() * TAU;
    n.pT = this.rng() * d.react;
    n.pLead.ds = Infinity;
    n.pLead.v = 0;
  }

  /* ---- visibility: never let a spawn or a recycle happen on screen ---- */

  /** Range past which the current fog + sheer distance hide a car outright.
      FogExp2 is ~92% opaque at 1.6/density; with the fog slider off nothing
      hides a car but its own size, so fall back to a range where one covers a
      few pixels. The ceiling matters: every metre added here is a metre of
      corridor the budget has to fill before traffic reaches the player. */
  private hideDist(): number {
    const fog = this.scene.fog as THREE.FogExp2 | null;
    const d = fog && (fog as any).isFogExp2 ? fog.density : 0;
    return d > 1e-5 ? clamp(1.6 / d, 260, 470) : 500;
  }

  /** Are buildings between the player and this point? Rate-limited per frame. */
  private occluded(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    if (this.occBudget <= 0) return false;
    this.occBudget--;
    const eyeY = ay + 2.4, tgtY = by + 1.1;
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    const steps = Math.min(34, Math.max(3, Math.round(L / 7)));
    const C = this.world.colliders;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = ax + dx * t, z = az + dz * t, ry = eyeY + (tgtY - eyeY) * t;
      for (const bi of C.nearbyAabbs(x, z)) {
        const b = C.aabbs[bi];
        if (b.y1 < ry + 0.8) continue;
        if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
      }
    }
    return false;
  }

  /** True when (x,z) is safely out of sight: outside the view cone with margin,
      past the fog wall, or behind a building. */
  private hidden(
    player: CarState, camFx: number, camFz: number,
    x: number, y: number, z: number, hd: number, useOcc: boolean
  ) {
    const dx = x - player.x, dz = z - player.z;
    const d = Math.hypot(dx, dz);
    if (d < 6) return false;
    const cos = (dx * camFx + dz * camFz) / d;
    // the widest the frustum reaches is ~cos 0.61; demand more margin up close,
    // where a flick of the wheel would swing the camera onto the spawn
    const lim = 0.28 + 0.4 * clamp((d - 60) / Math.max(hd - 60, 1), 0, 1);
    if (cos <= lim) return true;
    if (d > hd) return true;
    // from up on the deck the view runs over the rooftops, so no building down
    // in the town can be trusted to screen a spawn
    if (player.y - y > 4) return false;
    return useOcc && this.occluded(player.x, player.y, player.z, x, y, z);
  }

  private trySpawnTown(
    n: Npc, player: CarState, camFx: number, camFz: number, hd: number
  ): boolean {
    if (!this.ready[n.style]) return false; // no bodyshell yet, nothing to show
    const net = this.world.net;
    this.rollDriver(n);
    for (let attempt = 0; attempt < 14; attempt++) {
      /* Aim at a point in a tight ring around the player, biased ahead of
         travel — the road nearest that point is the spawn candidate. One
         attempt in three reaches past the fog wall instead, which is the only
         way to seed the street the player is actually driving down. */
      const q = this.rng();
      const ahead = q < 0.45;
      const far = q > 0.7;
      const base = Math.atan2(camFx, camFz) + (ahead || far ? 0 : Math.PI);
      const a = base + (this.rng() * 2 - 1) * (far ? 0.7 : ahead ? 1.2 : Math.PI * 0.75);
      const r = far ? hd + rand(20, 160) : lerp(60, 225, Math.sqrt(this.rng()));
      const near = net.nearest(player.x + Math.sin(a) * r, player.z + Math.cos(a) * r);
      if (!near || near.dist > 45) continue;
      const e = near.edge;
      if (e.len < 24) continue;
      const s = clamp(near.s, 6, e.len - 6);
      net.sampleEdge(e, s, this.pose, { i: 0 });
      const dx = this.pose.x - player.x, dz = this.pose.z - player.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 50 || dist > hd + 160) continue;
      if (!this.hidden(player, camFx, camFz, this.pose.x, this.pose.y, this.pose.z, hd, true))
        continue;
      // spacing on the edge
      let blocked = false;
      for (const m of this.npcs) {
        if (!m.active || m.edge !== e) continue;
        const ms = m.eDir > 0 ? m.s : e.len - m.s;
        if (Math.abs(ms - s) < 14) blocked = true;
      }
      if (blocked) continue;
      n.active = true;
      n.hw = false;
      n.edge = e;
      /* cars seeded ahead of the player mostly drive back toward them, so the
         street ahead fills with oncoming traffic instead of tail lights */
      const toward = -(this.pose.tx * dx + this.pose.tz * dz) > 0 ? 1 : -1;
      const inFront = (dx * camFx + dz * camFz) > 0;
      n.eDir = inFront && this.rng() < 0.7 ? toward : this.rng() < 0.5 ? 1 : -1;
      n.s = n.eDir > 0 ? s : e.len - s;
      n.segHint.i = 0;
      n.nextEdgeId = -1;
      n.wreck = null;
      n.fade = 1;
      n.blink = 0;
      n.v0 = rand(8, 11.5) * n.drv.spd;
      n.v = n.v0 * rand(0.6, 0.9);
      n.turnCd = rand(2, 6);
      this.placeTown(n);
      n.hVis = Math.atan2(this.pose.tx, this.pose.tz);
      return true;
    }
    return false;
  }

  private trySpawnHwy(
    n: Npc, player: CarState, playerUp: boolean,
    camFx: number, camFz: number, hd: number
  ): boolean {
    if (!this.ready[n.style]) return false; // no bodyshell yet, nothing to show
    this.rollDriver(n);
    const cor = this.cor;
    const heavy = n.type === "truck" || n.type === "bus";
    const pSpd = Math.abs(player.u);
    for (let attempt = 0; attempt < 10; attempt++) {
      /* The corridor is one-way, so every car enters ahead of the player and
         comes back to them. Normal frames seed past the fog wall; a seeding
         frame (first frame, or straight after a wrap/teleport) fills the whole
         corridor ahead at once, before that view has ever been rendered. */
      const ahead = this.warpSeed
        ? rand(55, hd + 330)
        : rand(hd + 15, hd + 330);
      const z = cor.wrapZ(player.z + ahead);
      const nl = cor.lanes(z);
      // faster drivers gravitate to the outside (fast) lanes, slower ones to
      // lane 0, which is the kerb lane the ramps feed
      let laneK: number;
      if (heavy) laneK = Math.floor(this.rng() * Math.max(1, nl - 1));
      else {
        const q = clamp(n.drv.spd - 0.72 + rand(-0.18, 0.18), 0, 0.99) / 0.62;
        laneK = Math.min(nl - 1, Math.floor(q * nl));
      }
      const off = cor.laneOffset(laneK, z);
      const p = cor.worldOf(z, off, this._cw);
      if (!this.warpSeed && !this.hidden(player, camFx, camFz, p.x, p.y, p.z, hd, false))
        continue;
      let blocked = false;
      for (const m of this.npcs) {
        if (!m.active || !m.hw) continue;
        if (Math.abs(m.offCur - off) > 2.2) continue;
        if (Math.abs(cor.deltaZ(m.s, z)) < 20) blocked = true;
      }
      if (blocked) continue;
      let cruise = (rand(24, 30) + laneK * 1.1) * n.drv.spd;
      if (heavy) cruise = Math.min(cruise, 25);
      /* Nothing may be seeded behind the player, so a car quicker than them
         simply drives away and is never seen. Most of the stream is therefore
         pegged a little below the player's current pace: they get reeled in
         and overtaken, which is what fills the lanes around the car. The rest
         keep their own pace and pull away. */
      if (playerUp && this.rng() < 0.68) {
        // pegged to a sane cruising pace, never to a crawling player, or the
        // whole flow would spiral down every time the player slowed
        const ref = Math.max(pSpd, 26);
        cruise = Math.max(15, Math.min(cruise, ref * rand(0.62, 0.94)));
      }
      n.active = true;
      n.hw = true;
      n.edge = null;
      n.dir = 1;
      n.route = -1;
      n.wantBypass = 0;
      n.laneK = laneK;
      n.offCur = n.offT = off + this.biasAt(n, z);
      n.s = z;
      n.wreck = null;
      n.fade = 1;
      n.v0 = cruise;
      n.v = n.v0 * rand(0.85, 1.0);
      n.turnCd = rand(2, 8);
      n.blink = 0;
      this.placeHwy(n, player.z);
      n.hVis = cor.pose(z, this.cpose).h;
      return true;
    }
    return false;
  }

  /** Seed a car onto the bypass viaduct ahead of a player who is driving it —
      the same hidden-spawn contract as trySpawnHwy, in the bypass's own
      arclength space. Heavies stay off the sporty route. */
  private trySpawnBypass(
    n: Npc, player: CarState, camFx: number, camFz: number, hd: number
  ): boolean {
    if (!this.ready[n.style]) return false;
    if (n.type === "truck" || n.type === "bus") return false;
    const pb = this.playerBy;
    if (!pb) return false;
    const by = this.routes.bypass;
    this.rollDriver(n);
    for (let attempt = 0; attempt < 6; attempt++) {
      const ahead = this.warpSeed ? rand(45, hd + 200) : rand(hd + 15, hd + 200);
      const s = pb.s + ahead;
      if (s > by.len - 60) return false; // past the merge — the deck spawner owns it
      const laneK = this.rng() < 0.5 ? 0 : 1;
      const off = by.laneOffset(laneK, s);
      const p = by.worldOf(s, off, this._cw);
      if (!this.warpSeed && !this.hidden(player, camFx, camFz, p.x, p.y, p.z, hd, false))
        continue;
      let blocked = false;
      for (const m of this.npcs) {
        if (!m.active || !m.hw || m.route !== BYPASS_EDGE) continue;
        if (Math.abs(m.offCur - off) > 2.2) continue;
        if (Math.abs(m.s - s) < 20) blocked = true;
      }
      if (blocked) continue;
      n.active = true;
      n.hw = true;
      n.edge = null;
      n.dir = 1;
      n.route = BYPASS_EDGE;
      n.wantBypass = 0;
      n.laneK = laneK;
      n.offCur = n.offT = off + this.biasAtBypass(n);
      n.s = s;
      n.wreck = null;
      n.fade = 1;
      n.v0 = rand(26, 33) * n.drv.spd;
      n.v = n.v0 * rand(0.85, 1.0);
      n.turnCd = rand(2, 8);
      n.blink = 0;
      this.placeHwy(n, player.z);
      n.hVis = by.poseAt(s, this.bpose).h;
      return true;
    }
    return false;
  }

  /* ---------------- pose helpers ---------------- */

  private sampleTravel(n: Npc, sT: number, out: EdgePose) {
    const e = n.edge!;
    this.world.net.sampleEdge(e, n.eDir > 0 ? sT : e.len - sT, out, n.segHint);
    if (n.eDir < 0) {
      out.tx *= -1;
      out.tz *= -1;
    }
    return out;
  }

  private placeTown(n: Npc) {
    const p = this.sampleTravel(n, n.s, this.pose); // n.s is in travel space
    const rx = p.tz, rz = -p.tx;
    n.x = p.x + rx * LANE_LAT + (n.wob || 0) * rx;
    n.z = p.z + rz * LANE_LAT + (n.wob || 0) * rz;
    n.y = p.y;
  }

  /** `refZ` anchors the render position across the loop seam: corridor.worldOf
      returns a z canonicalised into [Z0, Z1), so a car just ahead of the
      player on the far side of the wrap (player near Z1, car's s near Z0)
      would otherwise render a full LOOP away instead of a few metres ahead.
      Re-adding the right multiple of LOOP puts it back next to `refZ` (always
      the player, so far) without changing x/y, which are already periodic. */
  private placeHwy(n: Npc, refZ: number) {
    if (n.route === BYPASS_EDGE) {
      // the bypass never leaves the canonical band, so no lap re-anchoring —
      // and worldOf folds the banked cross-fall into y (the deck-height snap
      // the corridor's heightAt used to provide comes from the graph here)
      const p = this.routes.bypass.worldOf(n.s, n.offCur + (n.wob || 0), this._cw);
      n.x = p.x;
      n.y = p.y;
      n.z = p.z;
      return;
    }
    const p = this.cor.worldOf(n.s, n.offCur + (n.wob || 0), this._cw);
    n.x = p.x;
    n.y = p.y;
    const LOOP = this.cor.LOOP;
    n.z = p.z + LOOP * Math.round((refZ - p.z) / LOOP);
  }

  /* ---------------- impact from player ---------------- */

  applyImpact(hit: NpcHit) {
    const n: Npc = hit.npc;
    if (!n.active) return;
    if (hit.relSpeed > 2.6 && !n.wreck) {
      // the wreck fades through the shared material's per-instance dissolve —
      // no clone, so nothing to allocate here or dispose later
      // carry the victim's travel velocity + the impact impulse
      n.wreck = {
        vx: Math.sin(n.hVis) * n.v + hit.nx * hit.relSpeed * 0.72,
        vz: Math.cos(n.hVis) * n.v + hit.nz * hit.relSpeed * 0.72,
        vr: (this.rng() < 0.5 ? -1 : 1) * clamp(hit.relSpeed * 0.28, 0.6, 3.4),
        age: 0,
      };
      n.brake = true;
      n.v = 0;
    } else if (n.wreck) {
      n.wreck.vx += hit.nx * hit.relSpeed * 0.6;
      n.wreck.vz += hit.nz * hit.relSpeed * 0.6;
      n.wreck.age = Math.min(n.wreck.age, 6);
    } else {
      // light tap: shove + brake
      n.v = Math.max(0, n.v - hit.relSpeed * 0.8);
      n.brake = true;
    }
  }

  /** Positions of active wrecks (for smoke emitters). Returns a reused array —
      the caller iterates it immediately, and this runs every frame. */
  activeWrecks(): Npc[] {
    const out = this._wrecks;
    out.length = 0;
    for (const n of this.npcs) if (n.active && n.wreck) out.push(n);
    return out;
  }

  /** NPCs that fired a close call this frame (near-miss pass, or forced hard
      brake), personality-gated into horn vs. chirp. Read `n.ccKind` and
      `n.x/y/z` on each; the caller routes these into npcHorn/npcChirp. Reuses
      an array — read it before the next update(). */
  closeCalls(): Npc[] {
    const out = this._closeCalls;
    out.length = 0;
    for (const n of this.npcs) if (n.active && n.ccKind) out.push(n);
    return out;
  }

  /** Cheap per-frame feed for an audio doppler pool: the `count` nearest
      active NPCs to a listener point, nearest first, with world position and
      velocity. Returns the reused backing array (fixed capacity, currently
      12) — every slot from `count` onward, not just the ones this call
      filled, is guaranteed `npc: null`, so a caller that scans the whole
      array rather than stopping at `count` still can't see a stale sample
      left over from an earlier call made with a larger count. Nothing here
      allocates once the pool is warmed up in the constructor. */
  nearestNpcs(px: number, py: number, pz: number, count: number): NpcAudioSample[] {
    const buf = this._nearBuf;
    const cap = Math.min(count, buf.length);
    let used = 0;
    for (const n of this.npcs) {
      if (!n.active) continue;
      const dx = n.x - px, dy = n.y - py, dz = n.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (used < cap) {
        let i = used++;
        while (i > 0 && buf[i - 1].d2 > d2) {
          this.copySample(buf[i], buf[i - 1]);
          i--;
        }
        this.fillSample(buf[i], n, d2);
      } else if (d2 < buf[cap - 1].d2) {
        let i = cap - 1;
        while (i > 0 && buf[i - 1].d2 > d2) {
          this.copySample(buf[i], buf[i - 1]);
          i--;
        }
        this.fillSample(buf[i], n, d2);
      }
    }
    // clear everything this call didn't touch, all the way to the buffer's
    // full capacity — not just up to `cap` — so a stale sample from a call
    // with a larger `count` can never leak through a later, smaller one
    for (let i = used; i < buf.length; i++) buf[i].npc = null;
    return buf;
  }

  private fillSample(s: NpcAudioSample, n: Npc, d2: number) {
    s.npc = n;
    s.x = n.x;
    s.y = n.y;
    s.z = n.z;
    s.vx = Math.sin(n.hVis) * n.v;
    s.vz = Math.cos(n.hVis) * n.v;
    s.d2 = d2;
    s.type = n.type;
    s.heavy = n.type === "truck" || n.type === "bus";
  }
  private copySample(dst: NpcAudioSample, src: NpcAudioSample) {
    dst.npc = src.npc;
    dst.x = src.x;
    dst.y = src.y;
    dst.z = src.z;
    dst.vx = src.vx;
    dst.vz = src.vz;
    dst.d2 = src.d2;
    dst.type = src.type;
    dst.heavy = src.heavy;
  }

  /** Debug/test helper: park an NPC ~24 m ahead of the player, in lane. */
  spawnObstacleAhead(car: CarState): boolean {
    const fx = Math.sin(car.h), fz = Math.cos(car.h);
    const tx = car.x + fx * 24, tz = car.z + fz * 24;
    const n = this.npcs.find((m) => !m.active && this.ready[m.style]);
    if (!n) return false;
    n.active = true;
    n.wreck = null;
    n.fade = 1;
    n.v = 0;
    n.v0 = 0.01;
    n.blink = 0;
    n.turnCd = 99;
    n.pT = 0;
    n.pLead.ds = Infinity;
    const cor = this.cor;
    const bys = this.routes.surfaceAt(car.x, car.z, 2);
    if (bys && Math.abs(car.y - bys.y) < 6) {
      // on the bypass viaduct: park it in the player's own bypass lane
      const by = this.routes.bypass;
      const s = Math.min(by.len - 2, bys.s + 24);
      const k =
        Math.abs(by.laneOffset(0, s) - bys.lat) <
        Math.abs(by.laneOffset(1, s) - bys.lat) ? 0 : 1;
      n.hw = true;
      n.dir = 1;
      n.route = BYPASS_EDGE;
      n.laneK = k;
      n.offCur = n.offT = by.laneOffset(k, s);
      n.s = s;
      this.placeHwy(n, car.z);
      n.hVis = by.poseAt(s, this.bpose).h;
      return true;
    }
    const deckY = cor.heightAt(car.x, car.z, 6);
    if (deckY !== null && Math.abs(car.y - deckY) < 6) {
      // drop it in the player's own lane, a few car lengths up the corridor
      const z = cor.wrapZ(cor.zAt(car.x, car.z) + 24);
      const lat = cor.latAt(car.x, car.z);
      const nl = cor.lanes(z);
      let bestK = 0, bd = 1e9;
      for (let k = 0; k < nl; k++) {
        const d = Math.abs(cor.laneOffset(k, z) - lat);
        if (d < bd) { bd = d; bestK = k; }
      }
      n.hw = true;
      n.dir = 1;
      n.laneK = bestK;
      n.offCur = n.offT = cor.laneOffset(bestK, z);
      n.s = z;
      this.placeHwy(n, car.z);
      n.hVis = cor.pose(z, this.cpose).h;
    } else {
      const near = this.world.net.nearest(tx, tz);
      if (!near) {
        n.active = false;
        return false;
      }
      n.hw = false;
      n.edge = near.edge;
      n.segHint.i = 0;
      n.nextEdgeId = -1;
      this.world.net.sampleEdge(near.edge, near.s, this.pose);
      const hr = Math.atan2(this.pose.tx, this.pose.tz);
      const same = Math.cos(hr - car.h) >= 0;
      n.eDir = same ? 1 : -1;
      n.s = same ? near.s : near.edge.len - near.s;
      this.placeTown(n); // pose now holds the travel-direction tangent
      n.hVis = Math.atan2(this.pose.tx, this.pose.tz);
    }
    return true;
  }

  /* ---------------- per-frame update ---------------- */

  update(
    dt: number, now: number, player: CarState,
    camFx: number, camFz: number, density: number, hornHeld: boolean, night = true
  ) {
    /* "on the expressway" has to come from the corridor now — the deck rises
       and falls by several metres, so a fixed height threshold would misread
       it near the low points. */
    const deckY = this.cor.heightAt(player.x, player.z, 8);
    const bySurf = this.routes.surfaceAt(player.x, player.z, 4);
    this.playerBy = bySurf && Math.abs(player.y - bySurf.y) < 7 ? bySurf : null;
    const playerUp =
      (deckY !== null && Math.abs(player.y - deckY) < 7) || this.playerBy !== null;
    const cap = Math.round(this.N * clamp(density, 0.15, 1));
    this.occBudget = 40;
    // camera forward, flattened
    const cl = Math.hypot(camFx, camFz) || 1;
    camFx /= cl;
    camFz /= cl;
    const hd = this.hideDist();
    /* The engine splices the endless loop by subtracting corridor.LOOP from
       the player's z in a single frame — a ~4 km jump that must NOT read as a
       teleport (it would force a full reseed and a visible traffic churn
       right at the seam every lap). Measure z with the corridor's wrapped
       shortest-way-round distance so an exact-LOOP jump reads as ~0; a real
       teleport (respawn, garage) still isn't LOOP-aligned and still trips it. */
    const dzWrap = this.cor.deltaZ(this.lastPz, player.z);
    if (Math.hypot(player.x - this.lastPx, dzWrap) > 150) this.warpSeed = true;
    this.lastPx = player.x;
    this.lastPz = player.z;
    this.globalCcCd = Math.max(0, this.globalCcCd - dt);

    /* Budget follows the player. On the deck almost everything goes on the
       deck; in town the deck only keeps a skeleton crew — and none at all once
       it is too far west for the structure to read as busy. */
    const deckNear = Math.abs(player.x - HX) < 340;
    const townReach = playerUp && Math.abs(player.z) > 640 ? 0 : 1;
    const hwyTarget = Math.round(cap * (playerUp ? 0.74 : deckNear ? 0.5 : 0.12));
    const townTarget = TOWN_TRAFFIC
      ? Math.round(cap * townReach * (playerUp ? 0.1 : deckNear ? 0.45 : 0.85))
      : 0;

    /* recycle NPCs that fall out of the band, but only where the player can't
       see them vanish (hard limits still cull, in case one gets stuck in view) */
    let hwyCount = 0, townCount = 0;
    const idleHwy = this._idleA, idleTown = this._idleB;
    idleHwy.length = 0;
    idleTown.length = 0;
    for (const n of this.npcs) {
      if (n.active) {
        let soft = false, hard = false;
        if (n.hw && n.route === BYPASS_EDGE) {
          /* bypass cars: `n.s` is edge arclength, not a corridor z, so
             recycling runs on world distance (the town rule) */
          const d = Math.hypot(n.x - player.x, n.z - player.z);
          soft = d > hd + 430;
          hard = d > hd + 560;
          if (n.wreck && !hard) soft = false;
        } else if (n.hw) {
          /* The fleet lives ahead of the player: once a car is properly
             behind it is recycled straight back to the head of the queue.
             Cars still close behind stay — they are the ones just overtaken,
             and the mirrors show them. The far limit has to sit clear of the
             spawn band, or a car is recycled the moment it is seeded. */
          const along = this.cor.deltaZ(player.z, n.s);
          if (playerUp) {
            // the mirrors render what is behind, so the tail needs enough room
            // that a car is a distant speck before it is recycled
            soft = along > hd + 430 || along < -140;
            hard = along > hd + 560 || along < -220;
          } else {
            soft = Math.abs(along) > 520;
            hard = Math.abs(along) > 700;
          }
          if (n.wreck && !hard) soft = false;
        } else {
          const ddx = n.x - player.x, ddz = n.z - player.z;
          const d = Math.hypot(ddx, ddz);
          // keep a longer leash on cars ahead: they are the ones feeding the
          // street the player is driving into
          const front = d > 1 && (ddx * camFx + ddz * camFz) / d > 0.2;
          soft = d > (front ? hd + 170 : 260);
          hard = d > (front ? hd + 290 : 430);
          if (n.wreck && !hard) soft = false;
        }
        if (hard || (soft && this.hidden(player, camFx, camFz, n.x, n.y, n.z, hd, false)))
          this.deactivate(n);
        else if (n.hw) hwyCount++;
        else townCount++;
      }
      if (!n.active) (n.hw ? idleHwy : idleTown).push(n);
    }
    // over-target trims (density slider / zone change): drop the farthest
    if (hwyCount > hwyTarget + 6) {
      let worst: Npc | null = null, wd = -1;
      for (const n of this.npcs)
        if (n.active && n.hw && !n.wreck) {
          const d = n.route === BYPASS_EDGE
            ? Math.hypot(n.x - player.x, n.z - player.z)
            : Math.abs(this.cor.deltaZ(player.z, n.s));
          if (d > wd) { wd = d; worst = n; }
        }
      if (worst && wd > 200) this.deactivate(worst);
    }
    if (townCount > townTarget + 6) {
      let worst: Npc | null = null, wd = -1;
      for (const n of this.npcs)
        if (n.active && !n.hw && !n.wreck) {
          const d = Math.hypot(n.x - player.x, n.z - player.z);
          if (d > wd) { wd = d; worst = n; }
        }
      if (worst && wd > 240) this.deactivate(worst);
    }
    /* spawn toward targets (a few per frame max); pools borrow from each
       other — any vehicle can serve the deck, but no trucks/buses in town */
    // a seeding frame fills the whole corridor at once; normal frames trickle
    let spawnBudget = this.warpSeed ? cap : 5;
    while (spawnBudget > 0 && hwyCount < hwyTarget && (idleHwy.length || idleTown.length)) {
      const n = idleHwy.length ? idleHwy.pop()! : idleTown.pop()!;
      // a style still waiting on its model costs no budget — otherwise a slow
      // file at the head of the idle pool could starve the live styles
      if (!this.ready[n.style]) continue;
      /* while the player drives the bypass, about half the stream is seeded
         onto it ahead of them; the rest keeps the main deck alive below */
      const onBy =
        this.playerBy && this.rng() < 0.55 &&
        this.trySpawnBypass(n, player, camFx, camFz, hd);
      if (onBy || this.trySpawnHwy(n, player, playerUp, camFx, camFz, hd)) hwyCount++;
      spawnBudget--;
    }
    while (spawnBudget > 0 && townCount < townTarget && (idleTown.length || idleHwy.length)) {
      let n = idleTown.length ? idleTown.pop() : undefined;
      if (!n) {
        const ix = idleHwy.findIndex(
          (m) => m.type !== "truck" && m.type !== "bus" && this.ready[m.style]
        );
        if (ix < 0) break;
        n = idleHwy.splice(ix, 1)[0];
      }
      if (!this.ready[n.style]) continue;
      if (this.trySpawnTown(n, player, camFx, camFz, hd)) townCount++;
      spawnBudget--;
    }
    /* Keep the seeding frame open until every style has been tried, so the
       opening fill happens with the whole fleet — not a corridor seeded thin
       and topped up in dribbles as models land. */
    if (this.fleetReady) this.warpSeed = false;

    const phase = signalPhase(now);
    const cfx = Math.sin(player.h), cfz = Math.cos(player.h);
    const playerSpeed = Math.abs(player.u);

    /* main per-NPC update */
    for (const n of this.npcs) {
      if (!n.active) continue;

      /* wreck free-body */
      if (n.wreck) {
        const w = n.wreck;
        w.age += dt;
        n.x += w.vx * dt;
        n.z += w.vz * dt;
        n.hVis += w.vr * dt;
        const damp = Math.exp(-1.5 * dt);
        w.vx *= damp;
        w.vz *= damp;
        w.vr *= Math.exp(-1.9 * dt);
        /* Keep a deck wreck on the deck. The impact impulse is mostly lateral,
           and the only collision this solver runs is against building AABBs —
           the expressway's parapets are not in that set, so nothing here used
           to stop a wreck sliding straight off the side of the road. It did
           not fall, either: heightAt's 2 m pad kept handing back deck height
           for another two metres, which left it hanging in mid-air alongside
           the pavement. Contain it at the barrier instead, the same way the
           building response below does. A ~6 m/s lateral impulse is enough to
           leave a wreck hanging; ~10 m/s carries it off the deck entirely.
           Nothing about this is specific to the toll plaza, where it happened
           to be caught — the overhang is the same mid-corridor. The plaza just
           has the most lanes and the best lighting, so it is where a wreck is
           most likely to end up beside the road and be seen there.

           Corridor queries are periodic in LOOP but its bend sums are not
           evaluated outside the built extent, and a wreck's z is anchored to
           the player's lap rather than wrapped — so fold it in first and put
           the lap back afterwards. */
        /* a bypass wreck is contained by the bypass's own parapets, in its
           own station frame — the corridor clamp below would teleport it
           sideways onto the deck edge 50 m away */
        if (n.hw && n.route === BYPASS_EDGE) {
          const by = this.routes.bypass;
          const bHit = by.project(n.x, n.z, BYPASS.half + 6);
          if (bHit) {
            const p = by.poseAt(bHit.s, this.bpose);
            const { hwL, hwR } = by.halfWidths(bHit.s);
            const blim = Math.max(
              0, (bHit.lat >= 0 ? hwL : hwR) - n.W / 2);
            if (Math.abs(bHit.lat) > blim) {
              const cl = bHit.lat < 0 ? -blim : blim;
              n.x = p.x + cl * p.nx;
              n.z = p.z + cl * p.nz;
              const vn = w.vx * p.nx + w.vz * p.nz;
              if (bHit.lat > 0 === vn > 0) {
                w.vx -= p.nx * vn * 1.5;
                w.vz -= p.nz * vn * 1.5;
                w.vx *= 0.7;
                w.vz *= 0.7;
                w.vr *= 0.8;
              }
            }
            n.y = p.y + Math.max(-blim, Math.min(blim, bHit.lat)) * p.bank;
          }
          n.brake = false;
          const sp2 = w.vx * w.vx + w.vz * w.vz;
          if (w.age > 9 || (w.age > 4 && sp2 < 0.05 &&
            Math.hypot(n.x - player.x, n.z - player.z) > 60)) {
            n.fade -= dt * 1.4;
            if (n.fade <= 0) this.deactivate(n);
          }
          continue;
        }
        const lap = n.z - this.cor.wrapZ(n.z);
        const zw = n.z - lap;
        const zc = this.cor.zAt(n.x, zw);
        const lim = Math.max(0, this.cor.halfWidth(zc) - n.W / 2);
        const lat = this.cor.latAt(n.x, zw);
        if (n.hw && Math.abs(lat) > lim) {
          const po = this.cor.pose(zc, this.cpose);
          const hit = this.cor.worldOf(zc, lat < 0 ? -lim : lim, this._cw);
          n.x = hit.x;
          n.z = hit.z + lap;
          // scrub the component still driving it into the barrier
          const vn = w.vx * po.nx + w.vz * po.nz;
          if (lat > 0 === vn > 0) {
            w.vx -= po.nx * vn * 1.5;
            w.vz -= po.nz * vn * 1.5;
            w.vx *= 0.7;
            w.vz *= 0.7;
            w.vr *= 0.8;
          }
        }
        const dy = this.cor.heightAt(n.x, n.z - lap, 2);
        n.y = dy !== null ? dy : this.world.terrain.heightAt(n.x, n.z, n.y);
        // crude wall response
        for (const bi of this.world.colliders.nearbyAabbs(n.x, n.z)) {
          const b = this.world.colliders.aabbs[bi];
          if (n.y + 1.4 < b.y0 || n.y > b.y1) continue;
          const cx = Math.max(b.x0, Math.min(n.x, b.x1)), cz = Math.max(b.z0, Math.min(n.z, b.z1));
          const ddx = n.x - cx, ddz = n.z - cz, d2 = ddx * ddx + ddz * ddz;
          const rr = n.W / 2 + 0.3;
          if (d2 < rr * rr && d2 > 1e-9) {
            const d = Math.sqrt(d2);
            n.x += (ddx / d) * (rr - d);
            n.z += (ddz / d) * (rr - d);
            const vn = (w.vx * ddx + w.vz * ddz) / d;
            if (vn < 0) {
              w.vx -= (ddx / d) * vn * 1.4;
              w.vz -= (ddz / d) * vn * 1.4;
              w.vx *= 0.6;
              w.vz *= 0.6;
            }
          }
        }
        const speed2 = w.vx * w.vx + w.vz * w.vz;
        if (w.age > 9 || (w.age > 4 && speed2 < 0.05 && Math.hypot(n.x - player.x, n.z - player.z) > 60)) {
          n.fade -= dt * 1.4;
          if (n.fade <= 0) {
            this.deactivate(n);
            continue;
          }
        }
        n.brake = false;
        continue;
      }

      /* every driver's cruise speed drifts a little around their own average */
      let v0 = n.v0 * (1 + 0.04 * Math.sin(now * 0.23 + n.drv.jit));
      /* horn nudge */
      if (hornHeld && Math.abs(player.y - n.y) < 3) {
        const dx = player.x - n.x, dz = player.z - n.z;
        const aC = -dx * cfx - dz * cfz, sC = Math.abs(-dx * cfz + dz * cfx);
        if (aC > 0 && aC < 16 && sC < 2.6) {
          n.nudgeT = 2.5;
          n.turnCd = Math.min(n.turnCd, 0.4);
        }
      }
      if (n.nudgeT > 0) {
        n.nudgeT -= dt;
        v0 *= 1.15;
      }

      /* Leader: nearest same-path vehicle ahead. Drivers only re-read the road
         every reaction interval and dead-reckon the gap in between, so a
         distracted one lifts late; anything already close is re-read at once. */
      const fx = Math.sin(n.hVis), fz = Math.cos(n.hVis);
      n.pT -= dt;
      if (n.pT <= 0) {
        let ds = Infinity, lv = 0;
        for (const m of this.npcs) {
          if (m === n || !m.active) continue;
          if (Math.abs(m.y - n.y) > 3) continue;
          const dx = m.x - n.x, dz = m.z - n.z;
          const ahead = dx * fx + dz * fz;
          if (ahead <= 0 || ahead > 70) continue;
          const side = Math.abs(dx * fz - dz * fx);
          if (side > (m.wreck ? 2.6 : 1.9)) continue;
          if (n.hw && m.hw && !m.wreck && m.dir !== n.dir) continue;
          const d = Math.max(ahead - (m.L + n.L) / 2, 0.1);
          if (d < ds) {
            ds = d;
            lv = m.wreck ? 0 : m.v * clamp(fx * Math.sin(m.hVis) + fz * Math.cos(m.hVis), 0, 1);
          }
        }
        n.pLead.ds = ds;
        n.pLead.v = lv;
        n.pT = n.drv.react * rand(0.8, 1.2);
      } else if (n.pLead.ds < 1e8) {
        n.pLead.ds = Math.max(0.15, n.pLead.ds + (n.pLead.v - n.v) * dt);
      }
      if (n.pLead.ds < 11) n.pT = Math.min(n.pT, 0.06);
      let lead: { ds: number; v: number } | null = null;
      if (n.pLead.ds < 1e8) {
        this._lead.ds = n.pLead.ds;
        this._lead.v = n.pLead.v;
        lead = this._lead;
      }
      /* player as obstacle */
      let panic = false;
      let nearPass = false;
      n.ccCd = Math.max(0, n.ccCd - dt);
      n.ccKind = null;
      if (Math.abs(player.y - n.y) < 3) {
        const dx = player.x - n.x, dz = player.z - n.z;
        const ahead = dx * fx + dz * fz;
        const side = Math.abs(dx * fz - dz * fx);
        if (ahead > 0 && ahead < 60 && side < 2.3) {
          const ds = Math.max(ahead - n.L / 2 - 2.2, 0.1);
          const pv = playerSpeed * clamp(fx * cfx * Math.sign(player.u) + fz * cfz * Math.sign(player.u), 0, 1);
          if (!lead || ds < lead.ds) {
            this._lead2.ds = ds;
            this._lead2.v = pv;
            lead = this._lead2;
          }
        }
        if (ahead > 0 && ahead < 9 && side < 3) panic = true;
        // near-miss FOR THE CLOSE-CALL SOUND ONLY (nearPass has no other use —
        // panic above still drives actual evasive braking and is untouched).
        // A genuinely tight squeeze at real speed, not just "somewhat near":
        // this is a weaving-through-traffic game, so a loose threshold here
        // turns the core loop into a beep chorus. Tightened from a 1.0-2.4m
        // side window / ahead -5..11 / combined speed >9 to a real near-miss;
        // tuned against a Monte Carlo sim of a 2-minute aggressive weave to
        // land around 5-10 total reactions rather than dozens.
        if (side > 0.3 && side < 0.9 && ahead > -1 && ahead < 4 && playerSpeed + n.v > 28) nearPass = true;
      }

      if (n.hw && n.route === BYPASS_EDGE) this.updateBypass(n, dt, v0, lead, panic);
      else if (n.hw) this.updateHwy(n, dt, v0, lead, panic);
      else this.updateTown(n, dt, v0, lead, phase, panic);

      /* Close-call event: a near-miss pass, or the player forcing this driver
         into a hard brake at real speed (not a gentle lift near a crawl).
         Personality-gated so it reads as different people reacting
         differently — aggressive drivers lean on the horn, timid ones just
         brake/chirp. Two-layer cooldown: a long per-NPC one (this same car
         won't react again for a while) plus a global one across ALL NPCs
         (see globalCcCd above) so weaving through a crowd can't produce
         several different cars reacting in the same few seconds. */
      if (Traffic.CLOSE_CALL_AUDIO && n.ccCd <= 0 && this.globalCcCd <= 0 && (nearPass || (panic && n.brake && playerSpeed > 8))) {
        n.ccKind = n.drv.timid ? "chirp" : "horn";
        n.ccCd = 10 + rand(0, 3);
        this.globalCcCd = Traffic.CC_GLOBAL_GAP;
      }

      /* smooth heading + place */
      if (n.hw) this.placeHwy(n, player.z);
      else this.placeTown(n);
      let targetH: number;
      if (n.hw && n.route === BYPASS_EDGE) {
        targetH = this.routes.bypass.poseAt(n.s, this.bpose).h;
      } else if (n.hw) {
        targetH = this.cor.pose(n.s, this.cpose).h;
      } else {
        targetH = Math.atan2(this.pose.tx, this.pose.tz);
      }
      let dh = angDiff(targetH, n.hVis);
      n.hVis += clamp(dh, -6 * dt, 6 * dt);
      n.spin += (n.v / n.wr) * dt;
      // ultra-subtle per-driver wander — amplitude 0 for the ~40% of drivers
      // who don't drift at all
      n.wob = n.drv.driftAmp > 0
        ? Math.sin(now * n.drv.driftRate + n.drv.driftPhase) * n.drv.driftAmp
        : 0;
    }

    /* overlap resolution between NPCs sharing a lane (cheap, one pass) */
    for (let a = 0; a < this.npcs.length; a++) {
      const A = this.npcs[a];
      if (!A.active || A.wreck) continue;
      for (let b = a + 1; b < this.npcs.length; b++) {
        const B = this.npcs[b];
        if (!B.active || B.wreck) continue;
        if (A.hw !== B.hw) continue;
        if (Math.abs(A.y - B.y) > 3) continue;
        const dx = B.x - A.x, dz = B.z - A.z;
        const need = (A.L + B.L) / 2 + 0.6;
        if (Math.abs(dx) > need || Math.abs(dz) > need) continue;
        const fx = Math.sin(A.hVis), fz = Math.cos(A.hVis);
        const along = dx * fx + dz * fz;
        const side = Math.abs(dx * fz - dz * fx);
        if (side > 1.7 || Math.abs(along) > need) continue;
        const rear = along > 0 ? A : B, front = along > 0 ? B : A;
        rear.v = Math.min(rear.v, front.v * 0.9);
        rear.brake = true;
        if (rear.hw && rear.route !== BYPASS_EDGE)
          rear.s = this.cor.wrapZ(rear.s - (need - Math.abs(along)) * 0.5);
        else rear.s = Math.max(0, rear.s - (need - Math.abs(along)) * 0.5);
      }
    }

    this.renderInstances(player, night);
    this.updateLights(now, night, player);
  }

  /* town graph driving */
  private updateTown(
    n: Npc, dt: number, v0: number,
    lead: { ds: number; v: number } | null, phase: number, panic = false
  ) {
    const e = n.edge!;
    const net = this.world.net;
    const remain = e.len - n.s;

    /* choose the next edge ahead of time (for blinkers) */
    if (n.nextEdgeId < 0 && remain < 34) {
      const endNode = n.eDir > 0 ? e.b : e.a;
      const opts = net.nodes[endNode].edges.filter((id) => id !== e.id);
      n.nextEdgeId = opts.length ? opts[Math.floor(this.rng() * opts.length)] : e.id;
      // blinker by turn direction
      this.sampleTravel(n, Math.max(0, e.len - 2), this.pose);
      const h0 = Math.atan2(this.pose.tx, this.pose.tz);
      const ne = net.edges[n.nextEdgeId];
      const fromA = ne.a === endNode;
      // tangent of the new edge sampled 4 m in, in travel direction
      const p2 = this.pose2;
      net.sampleEdge(ne, fromA ? 4 : ne.len - 4, p2, { i: 0 });
      let t2x = p2.tx, t2z = p2.tz;
      if (!fromA) {
        t2x *= -1;
        t2z *= -1;
      }
      const turn = angDiff(Math.atan2(t2x, t2z), h0);
      n.blink = turn > 0.45 ? 1 : turn < -0.45 ? -1 : 0;
    }

    /* speed limits: curvature + approaching intersection + signals */
    this.sampleTravel(n, n.s, this.pose);
    const hHere = Math.atan2(this.pose.tx, this.pose.tz);
    this.sampleTravel(n, Math.min(e.len, n.s + 7), this.pose2);
    const hNext = Math.atan2(this.pose2.tx, this.pose2.tz);
    const drv = n.drv;
    const curv = Math.abs(angDiff(hNext, hHere)) / 7;
    if (curv > 0.004) v0 = Math.min(v0, Math.sqrt(2.9 * drv.corner / curv) * 0.9);
    if (remain < 16 || n.s < 8) v0 = Math.min(v0, 6.5 * drv.corner);

    let stop: { ds: number; v: number } | null = null;
    const endNode = net.nodes[n.eDir > 0 ? e.b : e.a];
    // legacy grace: once past the stop line, clear the intersection instead
    if (endNode.signal && remain < 46 + 18 * drv.timid && remain > 5.5) {
      // arm classification by current heading
      const ew = Math.abs(Math.sin(hHere)) > Math.abs(Math.cos(hHere));
      const red = ew ? phase <= 2 || phase > 4.5 : phase >= 2 && phase <= 4;
      // the timid ones stop well short of the line
      if (red) {
        this._stop.ds = Math.max(remain - 7.5 - 3 * drv.timid, 0.3);
        stop = this._stop;
      }
    }
    if (stop && (!lead || stop.ds < lead.ds)) lead = stop;

    /* IDM */
    const aMax = 1.7 * drv.acc, bCom = 2.4, T = 1.2 * drv.gap, s0 = 2.2 + 1.4 * (drv.gap - 1);
    let acc: number;
    if (lead) {
      const dv = n.v - lead.v;
      const sStar = s0 + n.v * T + (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
      acc = aMax * (1 - Math.pow(n.v / v0, 4) - Math.pow(sStar / Math.max(lead.ds, 0.55), 2));
    } else acc = aMax * (1 - Math.pow(n.v / v0, 4));
    if (panic) acc = Math.min(acc, -6.5);
    acc = clamp(acc, -8.5, 3.2);
    n.brake = acc < -1.2;
    n.v = Math.max(0, n.v + acc * dt);
    n.s += n.v * dt;

    /* edge hop */
    if (n.s >= e.len - 0.2) {
      const endId = n.eDir > 0 ? e.b : e.a;
      const nid = n.nextEdgeId >= 0 ? n.nextEdgeId : e.id;
      const ne = net.edges[nid];
      n.edge = ne;
      n.eDir = ne.a === endId ? 1 : -1;
      n.s = Math.max(0, n.s - e.len);
      n.segHint.i = 0;
      n.nextEdgeId = -1;
      n.blink = 0;
      n.turnCd = rand(3, 8);
    }
  }

  /* corridor driving: one-way, variable lane count, wrapped */
  /** Max magnitude a driver's persistent lane bias (or the taper/toll pitch
      can produce) may take at this corridor position, so a half-width plus a
      0.25 m margin always stays inside the lane — rides on lanePitch the same
      way LANE_FOLLOW_RATE rides on the taper geometry, so it scales itself up
      through the toll plaza's wider pitch and would scale down through any
      future narrowing without needing a special case here. */
  private maxBias(n: Npc, z: number): number {
    return Math.max(0, this.cor.lanePitch(z) / 2 - n.W / 2 - 0.25);
  }

  /** clamp(drv.bias) at this corridor position/car — the one path every
      caller should use to fold a driver's persistent lateral bias onto a
      lane centre. */
  private biasAt(n: Npc, z: number): number {
    const m = this.maxBias(n, z);
    return clamp(n.drv.bias, -m, m);
  }

  /** True when no active NPC is within the danger box of lane offset `off2`
      near position `s` on route `route` — shared by comfort lane changes,
      forced taper merges, and the bypass merge's gap acceptance. `s` and
      `off2` are in the route's own space (corridor z / bypass arclength);
      only cars on the same route are compared, so the two spaces never mix. */
  private laneClearAt(n: Npc, s: number, off2: number, route = n.route): boolean {
    const cor = this.cor;
    for (const m of this.npcs) {
      if (m === n || !m.active || !m.hw || m.wreck) continue;
      if (m.route !== route) continue;
      if (Math.abs(m.offCur - off2) > 2.2) continue;
      const ds = route === BYPASS_EDGE ? m.s - s : cor.deltaZ(s, m.s);
      if (ds > -18 && ds < 28) return false;
    }
    return true;
  }

  /** clamp(drv.bias) for the bypass's constant-pitch lanes */
  private biasAtBypass(n: Npc): number {
    const m = Math.max(0, BYPASS.laneW / 2 - n.W / 2 - 0.25);
    return clamp(n.drv.bias, -m, m);
  }

  private updateHwy(
    n: Npc, dt: number, v0: number,
    lead: { ds: number; v: number } | null, panic = false
  ) {
    const drv = n.drv;
    const cor = this.cor;
    const nl = cor.lanes(n.s);

    /* Route choice at the bypass diverge (west-side gore at DIVERGE_Z): a
       kerb-lane share of the stream peels off onto the viaduct. Decided once
       per approach; the chosen driver signals and works over to lane 0 like
       any other signalled change. Heavies keep the trunk route. */
    const dzDiv = cor.deltaZ(n.s, DIVERGE_Z);
    if (n.wantBypass === 0 && dzDiv > 30 && dzDiv < 350) {
      const heavy = n.type === "truck" || n.type === "bus";
      /* per-lane odds tuned (Monte Carlo over the spawn-time lane/personality
         distribution) so ~28% of the whole stream peels off — the 25-35%
         share the route plan wants. Only the two kerb-side lanes ever exit. */
      const p = n.laneK === 0 ? 0.65 : n.laneK === 1 ? 0.5 : 0;
      n.wantBypass = !heavy && this.rng() < p ? 1 : -1;
    } else if (n.wantBypass !== 0 && (dzDiv < -80 || dzDiv > 400)) {
      n.wantBypass = 0; // past the gore — a fresh roll next lap
    }
    if (n.wantBypass === 1 && dzDiv > 0) {
      if (n.laneK > 0 && n.pendK < 0) {
        const k2 = n.laneK - 1;
        const off2 = cor.laneOffset(k2, n.s);
        if (this.laneClearAt(n, n.s, off2)) {
          n.pendK = k2;
          n.blink = -1;
          n.blinkT = rand(0.6, 1.2);
          n.laneRate = cor.lanePitch(n.s) / lerp(3, 2, drv.lane);
          n.turnCd = Math.max(n.turnCd, 2);
        } else if (dzDiv < 90) n.wantBypass = -1; // boxed in — stay on
      }
      if (n.laneK === 0 && dzDiv < 220) n.blink = -1; // exit signal
    }

    /* Merge out of a lane that is about to end well before it does — a
       lookahead many seconds up the road (a multi-lane fan-in, like the toll
       plaza's merge-back, needs to start several lane changes early enough
       to chain them), signalled and gradual, same as any other lane
       change, so a taper never reads as a sideways teleport. Re-triggers on
       its own once each pendK clears, so a multi-lane drop chains through
       consecutive single-lane merges rather than waiting for the whole taper. */
    if (n.pendK < 0 && n.laneK <= nl - 1) {
      const aheadZ = cor.wrapZ(n.s + clamp(n.v, 15, 32) * 9);
      const nlAhead = cor.lanes(aheadZ);
      if (n.laneK > nlAhead - 1) {
        const k2 = Math.max(0, Math.min(n.laneK - 1, nlAhead - 1));
        const off2 = cor.laneOffset(k2, n.s);
        if (k2 !== n.laneK && this.laneClearAt(n, n.s, off2)) {
          n.pendK = k2;
          n.blink = off2 < n.offCur ? -1 : 1;
          n.blinkT = rand(1, 2);
          // the local lane pitch, not the nominal LANE_W — the toll plaza
          // spreads lanes to ~6m, and a lane change there still needs to
          // take 2-4s rather than crossing the wider gap at the same speed
          n.laneRate = cor.lanePitch(n.s) / lerp(3, 2, drv.lane); // merges run a touch brisker than a comfort change
          n.turnCd = Math.max(n.turnCd, 2);
        }
      }
    }
    /* Hard safety net: the lane is physically gone right under them (blocked
       merge, or a driver that never got a clear gap in time) — snap the lane
       index so later math stays in range, but still signal it and still ease
       the visible offset over via offCur/offT below, just at the brisker
       emergency rate, rather than teleporting. */
    if (n.laneK > nl - 1) {
      const k2 = Math.max(0, nl - 1);
      const off2 = cor.laneOffset(k2, n.s);
      n.blink = off2 < n.offCur ? -1 : 1;
      n.laneRate = Math.max(n.laneRate, cor.lanePitch(n.s) / 1.4);
      n.laneK = k2;
      n.pendK = -1;
    }

    const aMax = 1.6 * drv.acc, bCom = 2.3, T = 1.25 * drv.gap, s0 = 2.2 + 1.4 * (drv.gap - 1);
    let acc: number;
    if (lead) {
      const dv = n.v - lead.v;
      const sStar = s0 + n.v * T + (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
      acc = aMax * (1 - Math.pow(n.v / v0, 4) - Math.pow(sStar / Math.max(lead.ds, 0.55), 2));
    } else acc = aMax * (1 - Math.pow(n.v / v0, 4));
    if (panic) acc = Math.min(acc, -6.5);
    acc = clamp(acc, -8.5, 3.2);
    n.brake = acc < -1.2;
    n.v = Math.max(0, n.v + acc * dt);
    n.s = cor.wrapZ(n.s + n.v * dt);

    /* the diverge itself: once past the gore nose in the kerb lane, the car
       crosses onto the bypass edge — same world position, new station space */
    if (n.wantBypass === 1) {
      const past = cor.deltaZ(DIVERGE_Z, n.s);
      if (past >= 0 && past < 70 && n.laneK === 0 && n.pendK < 0) {
        const by = this.routes.bypass;
        const hit = by.project(n.x, n.z, BYPASS.half + 10);
        n.route = BYPASS_EDGE;
        n.wantBypass = 0;
        n.s = Math.max(0.5, Math.min(by.len - 1, hit ? hit.s : past));
        /* lane 1 (+lat) is the one the deck's kerb lane feeds through the
           wedge; offCur keeps the true bypass-frame offset so the handoff is
           position-continuous, then eases onto the lane centre as the
           pavements separate */
        n.laneK = 1;
        n.pendK = -1;
        n.offT = by.laneOffset(1, n.s) + this.biasAtBypass(n);
        n.offCur = hit ? hit.lat : n.offT;
        n.laneRate = BYPASS.laneW / 1.6;
        n.blink = -1;
        return;
      }
    }

    n.turnCd -= dt;
    /* Lane change when stuck behind slower traffic — how long a driver puts up
       with it is their own business, and speeders weave for no reason at all. */
    const held = !!lead && lead.ds < 18 + 30 * drv.lane && lead.v < n.v0 * (0.8 + 0.12 * drv.lane);
    const restless = drv.weave > 0 && (!lead || lead.ds > 30) && this.rng() < 0.35 * dt;
    if (n.pendK < 0 && n.blink === 0 && n.turnCd <= 0 && (held || restless)) {
      // pushy drivers reach for the outside lane first, patient ones move over
      const first = drv.lane > 0.55 ? 1 : -1;
      for (let pass = 0; pass < 2; pass++) {
        const k2 = n.laneK + (pass === 0 ? first : -first);
        if (k2 < 0 || k2 > nl - 1) continue;
        const off2 = cor.laneOffset(k2, n.s);
        if (this.laneClearAt(n, n.s, off2)) {
          // signal first — the lane index (and offT/offCur) only move once the
          // pre-signal delay below elapses, so the blinker is never simultaneous
          // with the manoeuvre
          n.pendK = k2;
          n.blink = off2 < n.offCur ? -1 : 1;
          n.blinkT = rand(1, 2);
          n.laneRate = cor.lanePitch(n.s) / lerp(4, 2, drv.lane); // 2-4s to cross a lane, eager drivers quicker
          n.turnCd = lerp(12, 3.5, drv.lane);
          break;
        }
      }
    }
    /* Pre-signal delay: the blinker runs for a beat before the car actually
       starts drifting over. */
    if (n.pendK >= 0) {
      n.blinkT -= dt;
      if (n.blinkT <= 0) {
        n.laneK = n.pendK;
        n.pendK = -1;
      }
    }
    /* Track the lane centre continuously: it slides as the corridor tapers, so
       a car that is not changing lane still has to follow its own lane over.
       That passive drift always gets the brisk LANE_FOLLOW_RATE — the corridor
       geometry is sized against it — while an active, signalled lane change
       (blink is on) is deliberately throttled to the slower, driver-specific
       laneRate so the manoeuvre itself reads as gradual. */
    n.offT = cor.laneOffset(n.laneK, n.s) + this.biasAt(n, n.s);
    const dOff = n.offT - n.offCur;
    const rate = n.blink !== 0 ? n.laneRate || cor.lanePitch(n.s) / 3 : LANE_FOLLOW_RATE;
    if (Math.abs(dOff) > 0.02) {
      n.offCur += clamp(dOff, -rate * dt, rate * dt);
      if (n.blink !== 0 && n.pendK < 0 && Math.abs(dOff) < 0.35 && n.wantBypass !== 1)
        n.blink = 0;
    } else {
      n.offCur = n.offT;
      if (n.blink !== 0 && n.pendK < 0 && n.wantBypass !== 1) n.blink = 0;
    }
  }

  /* bypass driving: two lanes, finite arclength (no wrap — the edge ends at
     the merge gore), IDM unchanged, a shade quicker than the deck's slow
     lanes. The run ends in a Shuto-style fast-lane merge: fold to the inner
     lane, signal, and take the first accepted gap inside mergeWindow(). */
  private updateBypass(
    n: Npc, dt: number, v0: number,
    lead: { ds: number; v: number } | null, panic = false
  ) {
    const drv = n.drv;
    const by = this.routes.bypass;
    const mw = this.mergeWin;
    v0 *= 1.1; // the sporty route

    const aMax = 1.6 * drv.acc, bCom = 2.3, T = 1.25 * drv.gap, s0 = 2.2 + 1.4 * (drv.gap - 1);
    let acc: number;
    if (lead) {
      const dv = n.v - lead.v;
      const sStar = s0 + n.v * T + (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
      acc = aMax * (1 - Math.pow(n.v / v0, 4) - Math.pow(sStar / Math.max(lead.ds, 0.55), 2));
    } else acc = aMax * (1 - Math.pow(n.v / v0, 4));

    /* the merge. Inside the window, run the deck's own gap acceptance against
       the fast lane (an east merge — the fast lane is the one alongside);
       yield by easing off until a gap opens, and take the wedge's end as the
       hard deadline (the pavement is closing — the overlap resolver and IDM
       absorb a forced entry the way they absorb any too-tight lane change). */
    if (n.s >= mw.s0 - 90) {
      n.blink = -1; // deck on the −lat side: an east merge signals left
      if (n.laneK !== 0 && n.pendK < 0) {
        n.pendK = 0;
        n.blinkT = rand(0.4, 0.9);
        n.laneRate = BYPASS.laneW / 1.8;
      }
      if (n.s >= mw.s0) {
        const zc = this.cor.wrapZ(this.cor.zAt(n.x, n.z));
        const k = this.cor.lanes(zc) - 1;
        const off2 = this.cor.laneOffset(k, zc);
        if (this.laneClearAt(n, zc, off2, -1) || n.s > mw.s1 - 6) {
          n.route = -1;
          n.wantBypass = 0;
          n.s = zc;
          n.laneK = k;
          n.pendK = -1;
          n.offCur = this.cor.latAt(n.x, n.z);
          n.offT = off2 + this.biasAt(n, zc);
          n.laneRate = this.cor.lanePitch(zc) / 1.6;
          n.blink = -1;
          return;
        }
        acc = Math.min(acc, n.s > mw.s1 - 25 ? -2.6 : -1.2);
      }
    }

    if (panic) acc = Math.min(acc, -6.5);
    acc = clamp(acc, -8.5, 3.2);
    n.brake = acc < -1.2;
    n.v = Math.max(0, n.v + acc * dt);
    n.s = Math.min(by.len - 0.5, n.s + n.v * dt);

    n.turnCd -= dt;
    /* comfort lane change between the two lanes, clear of the merge run */
    const held = !!lead && lead.ds < 18 + 30 * drv.lane && lead.v < n.v0 * (0.8 + 0.12 * drv.lane);
    const restless = drv.weave > 0 && (!lead || lead.ds > 30) && this.rng() < 0.35 * dt;
    if (
      n.pendK < 0 && n.blink === 0 && n.turnCd <= 0 && (held || restless) &&
      n.s < mw.s0 - 150
    ) {
      const k2 = n.laneK === 0 ? 1 : 0;
      const off2 = by.laneOffset(k2, n.s);
      if (this.laneClearAt(n, n.s, off2)) {
        n.pendK = k2;
        n.blink = off2 < n.offCur ? -1 : 1;
        n.blinkT = rand(1, 2);
        n.laneRate = BYPASS.laneW / lerp(4, 2, drv.lane);
        n.turnCd = lerp(12, 3.5, drv.lane);
      }
    }
    if (n.pendK >= 0) {
      n.blinkT -= dt;
      if (n.blinkT <= 0) {
        n.laneK = n.pendK;
        n.pendK = -1;
      }
    }
    n.offT = by.laneOffset(n.laneK, n.s) + this.biasAtBypass(n);
    const dOff = n.offT - n.offCur;
    const rate = n.blink !== 0 ? n.laneRate || BYPASS.laneW / 3 : LANE_FOLLOW_RATE;
    if (Math.abs(dOff) > 0.02) {
      n.offCur += clamp(dOff, -rate * dt, rate * dt);
      if (n.blink !== 0 && n.pendK < 0 && Math.abs(dOff) < 0.35 && n.s < mw.s0 - 90)
        n.blink = 0;
    } else {
      n.offCur = n.offT;
      if (n.blink !== 0 && n.pendK < 0 && n.s < mw.s0 - 90) n.blink = 0;
    }
  }

  /* ---------------- instanced rendering ----------------
     One pass builds every instance buffer: every body goes into its style's
     single instanced mesh (the Orchids models are 0.3-2.6k triangles — cheap
     enough that a separate coarse far tier stopped paying for itself), and
     wheels only go on cars close enough to read as wheels. Nothing is culled
     by view direction here — the scene is also rendered from the rear camera
     for the mirrors and from the reflection camera for the road, and both
     want the traffic behind the player. Nothing in here allocates. */
  private renderInstances(player: CarState, night: boolean) {
    for (const st of this.styles) st.n = 0;
    let wk = 0;
    const WHEEL2 = 150 * 150;
    /* player-beam wash basis (see the HLW_* block): forward axis once per
       frame, and the gate mirrors engine.ts's `lamps` as closely as this
       side can see it — lightsOn covers the running-lights state; the
       flash-to-pass-with-lights-off case is a sub-second daylight event */
    const beamOn = night && player.lightsOn;
    const pfx = Math.sin(player.h), pfz = Math.cos(player.h);
    for (const n of this.npcs) {
      if (!n.active) continue;
      const dx = n.x - player.x, dz = n.z - player.z;
      const d2 = dx * dx + dz * dz;
      const lod = this.styles[n.style];
      const i = lod.n++;
      const e = lod.mesh.instanceMatrix.array as Float32Array;
      const c = Math.cos(n.hVis), sn = Math.sin(n.hVis), o = i * 16;
      e[o] = c; e[o + 1] = 0; e[o + 2] = -sn; e[o + 3] = 0;
      e[o + 4] = 0; e[o + 5] = 1; e[o + 6] = 0; e[o + 7] = 0;
      e[o + 8] = sn; e[o + 9] = 0; e[o + 10] = c; e[o + 11] = 0;
      e[o + 12] = n.x; e[o + 13] = n.y; e[o + 14] = n.z; e[o + 15] = 1;
      const pa = lod.paint.array as Float32Array;
      pa[i * 3] = n.cr;
      pa[i * 3 + 1] = n.cg;
      pa[i * 3 + 2] = n.cb;
      (lod.diss.array as Float32Array)[i] = n.fade;
      /* Streetlight wash: nearest-lamp distance by lattice arithmetic (fold
         the car's station into the lamp period, one table read), then a
         smooth along-road × lateral falloff over the pool's footprint. Night
         gate matches the lamp pools' own boolean; the tier gate is baked into
         the tables. One vec3 write per car per frame, no searches. */
      let wshR = 0, wshG = 0, wshB = 0;
      if (night && n.hw) {
        let w = 0;
        if (n.route === BYPASS_EDGE) {
          const ph = PHASE.light ?? 0;
          const kb = Math.round((n.s - ph) / PITCH.light);
          if (kb >= 0 && kb < this.byLampLat.length) {
            const cLat = this.byLampLat[kb];
            if (cLat < 1e8)
              w = washFall(Math.abs(n.s - (ph + kb * PITCH.light)), WASH_CORE_Z, WASH_R_Z) *
                washFall(Math.abs(n.offCur + n.wob - cLat), WASH_CORE_L, WASH_R_L);
          }
        } else {
          const ph = PHASE.light ?? 0;
          let wz: number, lat: number;
          if (n.wreck) {
            // a sliding wreck's s is stale — read its station from the world
            const zw = this.cor.wrapZ(n.z);
            wz = this.cor.wrapZ(this.cor.zAt(n.x, zw));
            lat = this.cor.latAt(n.x, zw);
          } else {
            wz = this.cor.wrapZ(n.s);
            lat = n.offCur + n.wob;
          }
          const kf = Math.round((wz - ph) / PITCH.light);
          const ki = ((kf % this.nDeckLamp) + this.nDeckLamp) % this.nDeckLamp;
          const cLat = this.deckLampLat[ki];
          if (cLat < 1e8)
            w = washFall(Math.abs(wz - (ph + kf * PITCH.light)), WASH_CORE_Z, WASH_R_Z) *
              washFall(Math.abs(lat - cLat), WASH_CORE_L, WASH_R_L);
          if (this.tollWashOn) {
            // the toll canopy's troffer zone: flat white, no sodium lamps here
            const dTol = Math.abs(wz - TOLL_WASH_ZC);
            if (dTol < TOLL_WASH_R) {
              const tw = washFall(dTol, TOLL_WASH_CORE, TOLL_WASH_R) * TOLL_WASH_GAIN;
              wshR += tw * TOLL_WASH_TINT_R;
              wshG += tw * TOLL_WASH_TINT_G;
              wshB += tw * TOLL_WASH_TINT_B;
            }
          }
        }
        if (w > 0) {
          const g = w * WASH_GAIN;
          wshR += g * WASH_R;
          wshG += g * WASH_G;
          wshB += g * WASH_B;
        }
      }
      /* Player-headlight wash — outside the `n.hw` gate above on purpose: it
         is driven by geometry relative to the player, not by which road the
         NPC is on, and an oncoming car's front catching the beams is as real
         as a led car's tail. `along` is measured from the lamp line (nose is
         ~2 m ahead of the player's centre), matching engine.ts's beam
         origin. */
      if (beamOn) {
        const along = dx * pfx + dz * pfz - 2;
        if (along > 0 && along < HLW_R_D) {
          const lat = Math.abs(dx * pfz - dz * pfx);
          const w =
            HLW_GAIN *
            washFall(along, HLW_CORE_D, HLW_R_D) *
            washFall(lat, HLW_CORE_L0 + along * HLW_CORE_LK, HLW_R_L0 + along * HLW_R_LK);
          if (w > 0) {
            wshR += w * HLW_R;
            wshG += w * HLW_G;
            wshB += w * HLW_B;
          }
        }
      }
      const wa = lod.wash.array as Float32Array;
      wa[i * 3] = wshR;
      wa[i * 3 + 1] = wshG;
      wa[i * 3 + 2] = wshB;
      /* Emissive lamp levels. A wreck's lights are dead; otherwise the tails
         glow at a running level and jump on the brakes. These are radiance
         multipliers on lamp-flagged vertices (lampKind) — a model whose bake
         carries no lamp flags simply leaves its lighting to the glow
         sprites, which is where today's Orchids fleet reads its lights.

         And that is in fact ALL of the fleet: verified by dumping the `_LAMP`
         accessor out of every public/models/cars/*.glb — min..max is 0..0 in
         all nine files, because tools/build-orchids-models.mjs allocates
         `lampKind` and then writes zeros into the GLB without ever tagging a
         vertex. So this whole emissive path is inert today and the rear levels
         below have no visual effect; the red lamps are 100% glow sprite (which
         is why the tail/brake fix lives in the tint of those clouds).

         The rear levels are still set to values that would be RIGHT the moment
         a rebuild tags the lenses, rather than left at ones known to be wrong.
         Emissive is `diffuseColor.rgb * lvl`, i.e. albedo-proportional, and a
         red lens texel is roughly (0.62, 0.055, 0.06), luma ~0.22; the bloom
         bright-pass floor is 0.40 post-exposure (uExp 0.98 at night). So the
         old 1.5 gave luma 0.33 — BELOW the floor, a lamp that could not bloom —
         and 3.4 gave 0.75. Matching the sprite targets (tail 0.68, brake 0.95)
         wants 3.1 and 4.4. The lens albedo is an estimate from the source
         artwork, not a measurement, so treat these as a starting point for
         whoever tags the geometry. */
      const la = lod.lamp.array as Float32Array;
      const lit = night && !n.wreck;
      la[i * 2] = lit ? 2.2 : 0;
      la[i * 2 + 1] = n.wreck ? 0 : n.brake ? 4.4 : lit ? 3.1 : 0;
      if (d2 < WHEEL2) {
        const fx = sn, fz = c, rx = fz, rz = -fx;
        for (const [lo, so] of n.wheelOffs) {
          this._wd.position.set(n.x + fx * lo + rx * so, n.y + n.wr, n.z + fz * lo + rz * so);
          this._wd.rotation.set(0, n.hVis, 0);
          this._wd.rotateZ(Math.PI / 2);
          this._wd.rotateY(n.spin % TAU);
          this._wd.scale.set(n.wr, n.wr * 0.68, n.wr); // unit cylinder → tyre width
          this._wd.updateMatrix();
          this.wheelInst.setMatrixAt(wk++, this._wd.matrix);
        }
      }
    }
    for (const st of this.styles) this.flushLod(st);
    this.wheelInst.count = wk;
    this.wheelCount = wk;
    if (wk) this.wheelInst.instanceMatrix.needsUpdate = true;
  }

  private flushLod(lod: Lod) {
    lod.mesh.visible = lod.n > 0; // an empty LOD must not reach the renderer
    if (lod.n === 0 && lod.mesh.count === 0) return;
    lod.mesh.count = lod.n;
    lod.mesh.instanceMatrix.needsUpdate = true;
    lod.paint.needsUpdate = true;
    lod.diss.needsUpdate = true;
    lod.lamp.needsUpdate = true;
    lod.wash.needsUpdate = true;
  }

  /* light sprites + headlight ground pools */
  private updateLights(now: number, night: boolean, player: CarState) {
    const SP = this.clouds;
    const blinkOn = now % 0.9 < 0.45;
    const pools = this.headlightPools && night;
    let pk = 0;
    const pe = this.poolInst.instanceMatrix.array as Float32Array;
    const pc = this.poolColor.array as Float32Array;
    let li = 0;
    const put = (cloud: Cloud, slot: number, x: number, y: number, z: number, show: boolean) => {
      const o = (li * 2 + slot) * 3, a = cloud.arr;
      if (show) {
        a[o] = x;
        a[o + 1] = y;
        a[o + 2] = z;
      } else a[o + 1] = -999;
    };
    /* Lamp positions are quoted in body-local metres — lateral, height,
       forward — and `emit` puts them in the world. The basis lives outside the
       loop so this stays a closure over plain numbers and allocates nothing,
       which matters at 120 cars a frame. */
    let bfx = 0, bfz = 0, brx = 0, brz = 0, bx = 0, by = 0, bz = 0;
    const emit = (
      cloud: Cloud, slot: number, lx: number, ly: number, lz: number, show: boolean
    ) => put(cloud, slot, bx + bfx * lz + brx * lx, by + ly, bz + bfz * lz + brz * lx, show);
    for (let i = 0; i < this.npcs.length; i++) {
      li = i;
      const n = this.npcs[i];
      if (!n.active) {
        for (const key in SP) {
          SP[key].arr[i * 2 * 3 + 1] = -999;
          SP[key].arr[(i * 2 + 1) * 3 + 1] = -999;
        }
        continue;
      }
      bfx = Math.sin(n.hVis);
      bfz = Math.cos(n.hVis);
      brx = bfz;
      brz = -bfx;
      bx = n.x;
      by = n.y;
      bz = n.z;
      const wrecked = !!n.wreck;
      const running = night && !wrecked;
      /* Headlight ground pool: a flat quad ahead of the bumper, yawed to the
         heading and pitched to the corridor grade so it hugs a climbing deck,
         faded by distance from the player (and by the wreck dissolve). Matrix
         written by hand — column-major R_y(yaw)·R_x(pitch)·S — to keep this
         allocation-free. */
      if (pools && running) {
        const dpx = n.x - player.x, dpz = n.z - player.z;
        const fade = 1 - Math.hypot(dpx, dpz) / POOL_FADE_D;
        if (fade > 0.01) {
          const heavy = n.type === "truck" || n.type === "bus";
          const sl = POOL_LEN * (heavy ? 1.15 : 1), sw = POOL_W * (heavy ? 1.3 : 1);
          const ahead = n.L / 2 + sl * 0.42;
          const grade = !n.hw ? 0
            : n.route === BYPASS_EDGE ? this.routes.bypass.poseAt(n.s, this.bpose).grade
              : this.cor.pose(n.s, this.cpose).grade;
          const q = 1 / Math.sqrt(1 + grade * grade);
          const sp = -grade * q, cp = q; // pitch that lays the quad on the slope
          const o = pk * 16;
          pe[o] = bfz * sw; pe[o + 1] = 0; pe[o + 2] = -bfx * sw; pe[o + 3] = 0;
          pe[o + 4] = bfx * sp; pe[o + 5] = cp; pe[o + 6] = bfz * sp; pe[o + 7] = 0;
          pe[o + 8] = bfx * cp * sl; pe[o + 9] = -sp * sl; pe[o + 10] = bfz * cp * sl; pe[o + 11] = 0;
          pe[o + 12] = n.x + bfx * ahead;
          pe[o + 13] = n.y + grade * ahead + 0.06;
          pe[o + 14] = n.z + bfz * ahead;
          pe[o + 15] = 1;
          const I = POOL_GAIN * fade * (heavy ? 1.15 : 1) * n.fade;
          pc[pk * 3] = I;
          pc[pk * 3 + 1] = I;
          pc[pk * 3 + 2] = I;
          pk++;
        }
      }
      /* Where this style's lamps actually are. A loaded model reports its own
         clusters; until then it is the bumper-relative guess the light code
         falls back on. Slot 0 is always the -lateral side, so the blinker
         still picks its side by the sign the driving code sets. */
      const LM = this.lampsOf[n.style];
      const hl = n.L / 2, hw2 = n.W / 2 - 0.22;
      const hd = LM?.head, tl = LM?.tail;
      const hx0 = hd ? hd[0][0] : -hw2, hy0 = hd ? hd[0][1] : 0.68, hz0 = hd ? hd[0][2] : hl;
      const hx1 = hd ? hd[1][0] : hw2, hy1 = hd ? hd[1][1] : 0.68, hz1 = hd ? hd[1][2] : hl;
      const tx0 = tl ? tl[0][0] : -hw2, ty0 = tl ? tl[0][1] : 0.74, tz0 = tl ? tl[0][2] : -hl;
      const tx1 = tl ? tl[1][0] : hw2, ty1 = tl ? tl[1][1] : 0.74, tz1 = tl ? tl[1][2] : -hl;
      emit(SP.head, 0, hx0, hy0, hz0, running);
      emit(SP.head, 1, hx1, hy1, hz1, running);
      emit(SP.tail, 0, tx0, ty0, tz0, running && !n.brake);
      emit(SP.tail, 1, tx1, ty1, tz1, running && !n.brake);
      emit(SP.brake, 0, tx0, ty0, tz0, !wrecked && n.brake);
      emit(SP.brake, 1, tx1, ty1, tz1, !wrecked && n.brake);
      // signals — wrecks flash hazards on both slots
      if (wrecked) {
        emit(SP.sig, 0, hx0, hy0, hz0, blinkOn);
        emit(SP.sig, 1, tx1, ty1, tz1, blinkOn);
      } else {
        const left = n.blink < 0, show = n.blink !== 0 && blinkOn;
        emit(SP.sig, 0, left ? hx0 : hx1, left ? hy0 : hy1, left ? hz0 : hz1, show);
        emit(SP.sig, 1, left ? tx0 : tx1, left ? ty0 : ty1, left ? tz0 : tz1, show);
      }
      emit(SP.roof, 0, 0, 1.36, 0, n.type === "taxi" && night && !wrecked);
      emit(SP.roof, 1, 0, -999, 0, false);
      const isPol = n.type === "police", flash = (now * 3.2) % 1 < 0.5;
      const fr = LM?.flashR, fb = LM?.flashB;
      emit(SP.polR, 0, fr ? fr[0] : 0.24, fr ? fr[1] : 1.38, fr ? fr[2] : 0, isPol && flash);
      emit(SP.polR, 1, 0, -999, 0, false);
      emit(SP.polB, 0, fb ? fb[0] : -0.24, fb ? fb[1] : 1.38, fb ? fb[2] : 0, isPol && !flash);
      emit(SP.polB, 1, 0, -999, 0, false);
    }
    for (const key in SP) (SP[key].geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.poolInst.count = pk;
    this.poolInst.visible = pk > 0;
    if (pk) {
      this.poolInst.instanceMatrix.needsUpdate = true;
      this.poolColor.needsUpdate = true;
    }
  }
}
