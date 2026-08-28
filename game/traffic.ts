import * as THREE from "three";
import { clamp, lerp, rand, pick, TAU, angDiff, mulberry32 } from "./util";
import { loadNpcModels, MAX_WHEELS, type NpcLamps, type NpcModel } from "./npcmodels";
import { HX, LANE_LAT } from "./world/const";
import { getCorridor, PITCH, PHASE, TOLL } from "./world/corridor";
import { worldTierCaps, rivalMode } from "./settings";
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

/* W is deliberately 1 cm UNDER the visible bodyshell, and must be kept in sync
   with the per-style W in tools/build-orchids-models.mjs — that table is the
   source of truth, because each GLB is non-uniformly fitted so its whole
   bounding box (mirrors included) lands on exactly those numbers. Do not
   "correct" these back up.

   They used to run 8 cm OVER the visible width, which is what made traffic
   feel like it sideswiped through thin air: player and NPC half-widths meet
   in collidePlayer()'s OBB test, so a crash fired ~6 cm before the two bodies
   touched on screen. Under-sizing by 1 cm is the other half of the same idea
   as the player's own half-width in player.ts — a gap that looks clear IS
   clear, with a hair of leeway rather than a phantom margin.

   L, wr, wz and mass are unrelated to this and are left alone. */
const TYPE_DIM: Record<string, { L: number; W: number; wr: number; wz: number; mass: number }> = {
  hybrid: { L: 4.54, W: 1.75, wr: 0.32, wz: 1.4, mass: 1400 },
  sedan: { L: 4.44, W: 1.78, wr: 0.32, wz: 1.37, mass: 1380 },
  compact: { L: 3.94, W: 1.70, wr: 0.30, wz: 1.24, mass: 1080 },
  suv: { L: 4.72, W: 1.89, wr: 0.36, wz: 1.46, mass: 1950 },
  taxi: { L: 4.44, W: 1.78, wr: 0.32, wz: 1.37, mass: 1380 },
  police: { L: 4.44, W: 1.78, wr: 0.32, wz: 1.37, mass: 1450 },
  van: { L: 4.64, W: 1.77, wr: 0.31, wz: 1.5, mass: 1750 },
  truck: { L: 6.3, W: 2.09, wr: 0.42, wz: 2.3, mass: 4200 },
  bus: { L: 9.4, W: 2.25, wr: 0.44, wz: 3.4, mass: 9000 },
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
           knee below caps it along with everything else.

           The bias was 0.55 + 0.45, and it is shared with the player-beam
           wash (HLW_*) which is NOT a downlight — headlights arrive from
           behind, horizontally, and land on the car's vertical rear panel.
           That panel has normal.y ~ 0, so it was taking the floor of this
           term, 0.55: the one surface the player is actually looking at got
           the weakest share of the wash, which is most of why the effect read
           as absent while the arithmetic said it was there.

           Flattened to 0.72 + 0.28. Vertical panels gain ~31% and up-facing
           ones lose ~5%, so the streetlight read is very nearly unchanged
           while the headlight read — the one that lands on rear ends — comes
           up to where it was always supposed to be. Properly separating the
           two would need a second per-instance attribute and a facing term
           off vViewPosition; that is the right fix if this ever needs to be
           exact, and is deliberately not done here because it cannot be
           verified without running the game. */
        totalEmissiveRadiance +=
          vWashCol * diffuseColor.rgb * (0.72 + 0.28 * saturate(normal.y));`
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
  /** This driver's personal ceiling on ever yielding to a horn or a headlight
      flash — the total probability they EVER comply, not a per-flash chance.
      Rolled at spawn and fixed for their whole life; see the HAIL block. */
  yieldMax: number;
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

/* ================= honking and flashing at the car in front =================

   Lean on the horn, or flash the high beams, at the car ahead and it may move
   over or pick its pace up — sometimes. The whole design problem is that a
   player will flash a *lot*, and the naive implementation (roll a fixed p per
   flash) converges on certainty: twenty independent rolls at 15% clear the
   lane 96% of the time, which turns every obstruction into a formality and
   every driver into the same driver. So instead:

   · Every driver rolls a personal CEILING at spawn (`drv.yieldMax`) — the
     total probability that this specific car EVER complies, however long you
     lean on it. A stubborn one's ceiling is a couple of percent. Nothing in
     the fleet is allowed above HAIL.ceilCap, so no car is ever a certain
     yield, and ~14% of the fleet sits below 10% — those drivers are a wall.

   · Repeated gestures walk a SATURATING curve up to that ceiling instead of
     compounding. The cumulative chance of having complied by gesture k is,
     by construction,

         C(k) = ceiling · (1 − e^(−k / HAIL.K))

     and the dice actually thrown on gesture k is the conditional probability
     that reproduces it:

         q(k) = (C(k) − C(k−1)) / (1 − C(k−1))

     Rolling q(k) once per gesture yields exactly C(k), so the asymptote is a
     tuning constant rather than something emergent: C(∞) = ceiling, full
     stop. q(k) decays geometrically — for a median car 9.6%, 9.1%, 7.8%,
     5.7%, 4.1%, 2.9%, … — so the twentieth flash is worth almost nothing and
     the hundredth is worth nothing whatsoever. Flash a stubborn car a hundred
     times and it has moved over 7.6% of the time, not 100%.

   · One press is one gesture, and a given car will not roll again for
     HAIL.cd seconds however fast the key is mashed. A held horn re-arms every
     HAIL.holdRearm seconds — leaning on it is a sustained gesture, not a
     per-frame one.

   · `hailP` is a decaying pressure that only weights how INSISTENT a gesture
     reads: a tight burst carries full weight, an isolated flash HAIL.wMin of
     it. It can only ever scale q(k) down, never up, so it cannot lift a car
     past its ceiling — and pressure banked a minute ago has decayed to
     nothing and buys nothing.

   Chance of having complied after 1 / 5 / 20 / 100 gestures, at the fastest
   cadence the cooldown permits:

       stubborn  (ceiling 0.085)   2.0% /  6.4% /  7.6% /  7.6%
       median    (ceiling 0.41 )   9.6% / 31.5% / 37.8% / 37.8%
       courteous (ceiling 0.68 )  15.8% / 53.7% / 64.6% / 64.7%

   Measured over the actual roster (Monte Carlo through rollDriver, 200k
   draws, police and heavies included), a random car ahead yields to a single
   flash 8% of the time, to a three-flash burst 21%, and 33% however long you
   keep at it — so two cars in three will never move for you at all. That is
   the point: yielding is a thing that happens to you, not a button.

   YOU HAVE TO BE CLOSE, and "close" is a headway rather than a number of
   metres — see `reachT`. A car three seconds up the road cannot hear you at
   any volume; the same car at the same distance while you are doing 70 m/s is
   0.8 s away and can. The gesture reaches nothing outside that window at all:
   no target, no roll, no pressure banked.

   AND WHAT THEY DO ABOUT IT is a second coin. Moving over is the preferred
   answer and it takes the URGENT gap envelope (yieldLane) so it is actually
   available in traffic rather than only in theory — but a driver who could
   move over still just picks their pace up 1 − moveP of the time, and one
   with nowhere to go always does. So the same car, in the same gap, does not
   always answer the same way.

   test/hail-sim.mjs measures all of the above against the real corridor. */
const HAIL = {
  /* --- who can hear you --- */
  /** nearest a car may be and still be worth flashing at (m) — closer than
      this it is already half alongside and the gesture reads as aimed past it */
  near: 5,
  /** Absolute ceiling on the reach (m). Past ~55 m through the dashcam
      windshield you cannot tell which car you picked, so neither should the
      game — nothing beyond this is ever hailable at any speed. */
  far: 55,
  /** …but inside that ceiling the reach is a HEADWAY, not a distance:
      `reachT` seconds of the player's own travel. "Close" is not a number of
      metres — 55 m at 82 m/s is 0.67 s and you are on top of them; 55 m at
      18 m/s in traffic is three seconds back and honking from a distance,
      which is exactly the thing that must not work. A fixed metre gate
      cannot tell those apart, and this is the term that does.

      Deliberately headway (gap / own speed) rather than time-to-collision
      (gap / closing speed): TTC is infinite whenever you are matched to the
      car in front, so a TTC gate would refuse the single most common way a
      player asks for the lane — sitting a second off a bumper at the same
      speed, wanting to go faster. Headway is also what a driver actually
      perceives as close. Closing speed still shows up, since a player who is
      catching a car fast is by definition carrying the speed that opens the
      window. */
  reachT: 0.9,
  /** …and a floor under it (m), or the window collapses to nothing in a
      crawl: at 6 m/s the headway term is 5 m, and the car stopped directly
      on your bumper in a jam is the most legitimate hail there is. */
  nearAlways: 18,
  /** lateral half-window (m). Your own lane, plus enough slack for a car
      leaning on its line or for the player straddling one mid-overtake — but
      NOT a car sitting centred in the next lane, which is 3.7 m out. The ask
      is "the one car in front of me, and that's it"; a neighbour absorbing
      the gesture reads as the wrong car reacting. */
  side: 3.0,

  /* --- rate-limiting the dice --- */
  /** minimum seconds between two rolls on the SAME car, whatever the player
      does with the key. The anti-mash limiter. */
  cd: 0.9,
  /** a horn held down re-arms this often — one long blast is a handful of
      gestures, not one per frame */
  holdRearm: 1.0,

  /* --- the curve --- */
  /** saturation constant, in gestures: ~77% of a car's ceiling is reached by
      the fifth gesture, ~92% by the tenth. Larger = a lower first-flash
      chance and a longer climb; smaller = the ceiling arrives almost at once
      and later flashes are pure decoration. */
  K: 2.6,
  /** pressure decay time constant (s) */
  tau: 6.0,
  /** pressure at which the burst weight tops out (≈3 gestures in a row) */
  pFull: 2.5,
  /** weight of one isolated gesture relative to a burst */
  wMin: 0.55,

  /* --- ceilings: how compliant each kind of driver can ever be ---
     Indexed by ARCH, so courtesy rides along with the personality that is
     already there: the dawdler holding everyone up is usually oblivious
     rather than hostile and will move when prompted, while the speeder is
     racing you and will not. That is both true to life and the right way
     round for the game — the cars actually in your way are the ones worth
     asking. */
  ceil: [
    [0.55, 0.80], // dawdler
    [0.45, 0.70], // cautious
    [0.28, 0.55], // average
    [0.12, 0.34], // brisk
    [0.02, 0.15], // speeder
  ] as [number, number][],
  /** flat share of drivers who are a stone wall whatever they drive like —
      so a courteous-looking dawdler can still turn out to be someone who
      simply never reacts, and the archetype is a tendency, not a tell */
  stoneWall: 0.08,
  /** …and what that driver's ceiling is instead */
  stoneCeil: [0.0, 0.03] as [number, number],
  /** a truck or a bus is not moving over for you */
  heavyCeil: 0.45,
  /** and a police car certainly is not */
  policeCeil: 0.02,
  /** nothing may ever exceed this: no car in the fleet is a guaranteed yield */
  ceilCap: 0.88,

  /* --- the two reactions --- */
  /** Chance a car that CAN move over actually does, rather than just picking
      its pace up and staying where it is. Moving over is the preferred
      answer, but it must not be the automatic one: "sometimes it just speeds
      up and doesn't move, it'll be random". A driver who acknowledges you and
      simply gets on with it is a real and common answer on a real road, and
      making the response a coin the player cannot read is most of what keeps
      the mechanic from feeling mechanical. A car with nowhere to go still
      speeds up unconditionally — this only splits the case where both are
      genuinely open. */
  moveP: 0.68,
  /** speed-up: cruise-speed multiplier and how long it lasts (s) */
  boost: 1.22,
  boostT: 4.5,
  /** hazard-light acknowledgement blip (s) — the blinker cycle is 0.9 s, so
      this is two clear flashes of both sides: "yeah, going" */
  ackT: 1.9,
  /** a car that has moved over for you stays put for at least this long, so
      the courtesy does not immediately undo itself (s) */
  yieldHold: 6,

  /* --- annoyance --- */
  /** gestures a driver must have already refused before over-flashing starts
      to grate. Deliberately past the point where the curve has flattened —
      by here the player is getting nothing anyway and is just being rude. */
  annoyAfter: 6,
  /** only drivers who were never going to yield take offence; a genuinely
      courteous one just keeps declining politely */
  annoyCeil: 0.30,
  /** per-gesture chance of snapping, once both gates above are met. Cumulative
      for a stubborn driver you refuse to leave alone: 17% by the sixth
      gesture, 51% by the ninth, 88% by the twentieth. Persistence does buy
      you a reaction — just not the one you were after, which is the right
      asymmetry: it is compliance that must never be spammable, not
      consequences. */
  annoyP: 0.18,
  /** the reaction: a brief lift with the brake lights on, at this fraction of
      their cruise speed. A readable "quit it" ahead of you — NOT a swerve
      into your lane, which would be a crash the player could not have seen
      coming and is not a fair answer to pressing a button. */
  annoyDrop: 0.82,
  annoyT: 1.3,
  /** …and a horn back. This is deliberately NOT the ambient near-miss
      chorus turned back on (see CLOSE_CALL_AUDIO): it is rare, it is
      directly caused by something the player chose to do six times, and it
      still passes through the same per-car and global cooldowns. Flip to
      false to silence it without touching anything else. */
  annoyHorn: true,
};

/* ================= the courtesy nudge (tailgate / thread) =================

   Sit on a driver's bumper, or aim for the gap between two of them, and one
   may edge over a little INSIDE ITS OWN LANE to let you through. It is not a
   lane change and it must never become one: the car keeps its lane index, its
   blinker stays off, and the whole movement is a few tens of centimetres.

   This is the same shape of problem as HAIL above and gets the same answer.
   A player will tailgate for minutes at a time, so anything rolled repeatedly
   at a fixed chance converges on certainty and the road parts for you. So:

   · Compliance rides on the SAME per-driver trait as the horn/flash yield —
     `drv.yieldMax` — scaled down hard by `ceilScale`. A driver who will not
     move for your horn will not move for your bumper either, which is the
     point: the cars stay recognisable as people across both features.
   · Repeated crowding walks the SAME saturating curve, C(k) = ceiling ·
     (1 − e^(−k/K)), rolled through the identical conditional q(k). The
     asymptote is the ceiling, full stop, and it is a LOW ceiling.
   · One roll per `cd` seconds of continuous crowding, and only after `dwell`
     seconds of it — brushing past close for half a second while overtaking
     is an overtake, not tailgating.

   Chance of having been given a nudge after 5 / 20 / 60 s of unbroken
   tailgating, and the asymptote. k = floor((t − dwell)/cd) + 1, so t = 5 s is
   the 2nd roll, 20 s the 8th, 60 s the 24th:

       stubborn  (yieldMax 0.085 → ceiling 0.030)   1.8% /  2.9% /  3.0% /  3.0%
       median    (yieldMax 0.41  → ceiling 0.144)   8.6% / 14.0% / 14.3% / 14.3%
       courteous (yieldMax 0.68  → ceiling 0.238)  14.2% / 23.2% / 23.7% / 23.8%

   So most of the time nothing happens, which is the request ("small chance
   though", twice). Averaged over the real roster it is ~7% for a long tailgate.

   Deliberately NOT stacked with HAIL: `hailDone` gates the nudge, so a car
   that has already moved over for a horn does not also shuffle sideways. */
const NUDGE = {
  /** nudge ceiling as a fraction of the driver's horn/flash ceiling */
  ceilScale: 0.35,
  /** saturation constant, in rolls */
  K: 2.2,
  /** seconds of unbroken crowding before the first roll */
  dwell: 1.2,
  /** …and between rolls after that */
  cd: 2.5,
  /** crowding breaks if the player is off the trigger for this long, so a
      momentary wobble in the player's line doesn't reset the dwell clock */
  grace: 0.6,

  /* --- what counts as crowding (all measured in the NPC's own frame) --- */
  /** tailgate: player centre this close behind the NPC's tail, and this
      nearly in line with it */
  tailGap: 11,
  tailSide: 1.5,
  /** thread: the player is straddling this car's lane edge — far enough out
      to be aiming at the gap, near enough that it is this car's gap */
  threadSideLo: 1.5,
  threadSideHi: 3.0,
  /** …and within this much of the NPC longitudinally (either side, since a
      squeeze happens alongside as much as behind) */
  threadLong: 9,
  /** nobody is crowding anybody below this closing pace */
  minSpeed: 9,

  /* --- the movement --- */
  /** lateral shift, metres. Large enough to read as deliberate through the
      dashcam, small enough that the body stays well inside the lane line —
      it is additionally clamped to maxBias() so it can never poke out. */
  off: 0.3,
  /** how fast the nudge itself eases in and back out (m/s). Slow on purpose:
      ~0.9 s for the full move, so it reads as a driver easing over rather
      than the car snapping sideways. */
  rate: 0.34,
  /** hold the offset this long after the player stops crowding */
  hold: 2.5,
  /** clearance probe: how far into the neighbouring lane to look before
      committing. Reuses laneClearAt's own lane-danger half-width. */
  probe: 2.2,
};

/* ===================== white-lining (see USER-REQUESTS #4) =====================

   Two NPCs riding side-by-side in adjacent lanes normally sit close enough
   that the gap on the line between them is not really rideable. This is the
   owner's own spec: side-by-side pairs drift apart on the white line ~70% of
   the time, by a randomised width, so a driver who is actually good can
   thread it. It rides the SAME offset pathway as the courtesy nudge above —
   `offT`, folded in and clamped by maxBias exactly where nudgeCur is — not a
   second lateral controller.

   THE PAIR ROLLS ONCE, TOGETHER, WITH NO SHARED STATE. Each car derives its
   half of the decision from a hash of both cars' pool ids (order-independent)
   plus a coarse bucket of where on the road the pair formed, so both sides of
   an encounter land on the same open/closed call and the same width without
   either one having to read the other's fields — the same reason the rival's
   yield mechanic never needed a lock. Re-forming the pair somewhere else on
   the road, or with a different car entirely, rolls again. */
const WLINE = {
  /** how close in |Δs| counts as "riding side by side", as a fraction of the
      pair's combined length */
  sFrac: 0.6,
  /** ...and how long that has to hold before the pair is considered FORMED
      and rolls (s); a brief overtake alongside is not a pairing */
  dwell: 1.5,
  /** how similar the speeds must be, m/s — this is drifting apart, not one
      car peeling off */
  dv: 4,
  /** nobody drifts apart below this speed — not worth it in a crawl */
  minSpeed: 9,
  /** chance a formed pair opens a gap at all */
  openChance: 0.7,
  /** each car's own outward ease, metres — rolled per pair (so both sides
      use the same number), weighted toward the middle by averaging two
      rolls rather than taking one flat uniform draw */
  gapLo: 0.25, gapHi: 0.55,
  /** how fast the ease itself moves, m/s — same order as NUDGE.rate, reads
      as drift rather than a lane change */
  rate: 0.18,
  /** clearance probe before committing — reuses laneClearAt exactly as the
      courtesy nudge does, so this can no more ease into a car, wall or
      parapet than a voluntary lane lean can */
  probe: 2.2,
  /** rescan cadence for a car with no current partner, seconds (jittered) */
  scanEvery: 0.3, scanJitter: 0.2,
};

/* No Hesi scoring cadence (see scoreEvents/the close-call block). Deliberately
   short next to the close-call audio's ~10s per-driver cooldown: audio is
   avoiding a chorus of rare, discrete events, this is trying to keep up with
   a player stringing several genuine near-misses together in a few seconds. */
const NEARMISS = {
  /** this car won't count again this soon (s) */
  npcCd: 1.4,
  /** …and nothing else in the fleet counts this soon either (s) — keeps one
      near-miss encounter, however many cars are close, from paying out more
      than once, without silencing genuinely separate weaves seconds apart */
  globalCd: 0.35,
};

/* ===================== the rival ("rabbit") =====================

   An optional, persistent pace car (settings.rival, toggled from the start
   menu or the settings panel). It claims one pool slot that never recycles,
   drives its own controller instead of updateHwy, is exempt from every
   NPC-vs-NPC interaction in this file — and is fully SOLID to the player
   (collide.ts needs no special case: it walks `npcs` and the rival is in it).

   IT IS SIMPLY FASTER THAN YOU, AND YOU CHASE IT. That is the whole design
   now, and it is deliberately smaller than what came before. It leads, it
   drives quickly, and the player's job is to keep up.

   WHAT IT DOES NOT DO, and this is the important half: it never blocks,
   covers, defends or gets in the player's way. It has no idea where they are
   laterally and picks its lane on traffic alone. Earlier versions defended the
   pass and drifted back for close moments, and those two pulled against each
   other constantly — one asked it to ease off, the other to prevent the very
   thing easing off allows. Both are gone, along with the tuning tension.

   THE ONE REAL TENSION LEFT is that "always faster" and "stays in sight" end
   with a car that eventually disappears. Three soft, legible mechanisms hold
   it near, in the order they should be reached for:
     · IT EASES OFF WHEN IT IS A LONG WAY CLEAR (the lift in updateRival). One
       direction only, slow-acting, and the only place its speed refers to the
       player at all. Nothing ever pulls it FORWARD toward them, and nothing
       responds to what they are doing this second — that is the thing that
       reads as a leash, and it is not in this file.
     · IT GETS GENUINELY HELD UP, occasionally, behind traffic it cannot get
       past this second. Legible, honest, and not the norm.
     · AND IT IS QUIETLY PUT BACK IN FRONT if it ever ends up hopelessly
       behind and out of sight (see reseedBehind) — a backstop, not a crutch.

   The other half of the character is HOW IT GETS THROUGH TRAFFIC. It does NOT
   phase through it — an earlier build did, and a car sliding visibly through
   other bodies reads as broken, whatever it buys. It threads instead, with
   abilities no human has: it perceives every car around it, reacts in 0.12 s,
   drives a free lateral path rather than being locked to lane centres, and
   re-picks the best lane several times a second with no gap-acceptance
   timidity whatsoever. What it is exempt from is the SOCIAL half of traffic —
   nobody yields to it, nobody gap-checks for it, nobody adopts it as a leader
   and brakes (a fleet parting for it would look as unnatural as clipping).
   One-way perception: it avoids them, they ignore it.

   THREE LAYERS KEEP IT OUT OF OTHER BODIES, because "it should not overlap"
   has to be a guarantee and not an aspiration:
     1. it follows the car in its own path (IDM, always — see `lead` below),
     2. it will not slide sideways into an occupied space (rivalLatClear),
     3. and rivalSeparate() is a hard backstop that resolves any overlap that
        still happens, moving ONLY the rival.

   The cost of respecting traffic is that it sometimes CANNOT hold the station
   the speed model wants. That is resolved in traffic's favour every time: the
   following limit always wins over the station-keeping target (`acc` is a min
   of the two). When it is boxed in, it is boxed in — the gap does what it
   does, and the player may well get past. That is the honest version, and it
   is the source of the best moments in the mode. */
const RIVAL = {
  /** Absolute ceiling, m/s — over the player's ~82 on purpose. It is meant to
      be faster than them, not plausibly matched to them. */
  top: 95,
  /** Time constant on the lagged read of the player's pace, seconds. Only the
      out-of-sight ease uses it now. */
  paceTau: 1.5,
  /** Its ambition drifts in this range, on its own slow clock, so its pace is
      never an exact constant. */
  moodLo: 0.93, moodHi: 1.10,
  moodEvery: [6, 14] as [number, number], moodRate: 0.02,

  /** Distance beyond which it starts easing off (m), and the span over which
      that ease reaches full strength.

      THIS IS THE ANSWER TO "IT'S SO SLOW", and it is a change of shape rather
      than of numbers. Every earlier version eased whenever it was past a
      target gap of a few tens of metres, so the player spent most of their
      time watching it dawdle in front of them. Its sprint was already 2.3x the
      flow speed — the WAITING was what read as slow.

      So it does not ease AT ALL inside easeBeyond. Everything the player can
      see is the car driving flat out. The ease exists only past the fog wall
      (hideDist bottoms out at 260 m), which is exactly where a correction
      cannot be perceived — the same principle that governs where this file
      spawns and recycles all its other traffic.

      The cost is accepted rather than hidden: it WILL sometimes be a speck, or
      briefly gone. That is the trade this design now takes. */
  easeBeyond: 240, easeSpan: 200,
  /** How far under the player's pace that ease may reach, m/s. It has to go
      UNDER rather than merely match, or the gap stops growing without ever
      actually coming back. */
  gapDown: 5,

  /* ---- getting visibly held up ---- */
  /** a hold-up runs this long, plus a stretch that grows with the gap */
  holdMin: 1.2, holdMax: 2.6, holdFar: 2.5,
  /** seconds between hold-ups, at a near gap → at a far one */
  cdNear: 14, cdFar: 5,
  /** nearest the player may be for a deliberate patience spell to start (m) */
  holdNotWithin: 40,
  /** gap past which a hold-up may brake in earnest, and the span to full (m) */
  holdFrom: 40, holdSpan: 120,
  /** Hardest it may decelerate with the player right behind, and the
      time-to-contact over which it ramps back to the normal floor. */
  brakeNear: -1.5, brakeTtc: 2.0,

  /* ---- put back in front when it is hopelessly behind ---- */
  /** how far behind, how long it must have stayed there, and where it
      reappears (m, s, m) — only ever fires out of sight */
  reseedBehind: 150, reseedAfter: 6, reseedAhead: 110,

  /* ---- staying out of other bodies (the three layers) ---- */
  /** Clearance a lateral move demands beyond the two half-lengths / half-widths
      (m). Cut to near the geometric floor when the car was made overpowered:
      it takes ~10 m holes a person would not touch. The half-lengths are 4.6 m
      of that and cannot go. */
  /* MUST NOT BE TIGHTER THAN sepLon/sepLat below, and that is a hard
     invariant rather than a preference. Layer 2 decides what space is
     acceptable to move into; layer 3 decides what counts as an overlap needing
     resolution. With clearLon at 0.35 against sepLon 0.9, layer 2 kept
     approving gaps layer 3 immediately called overlaps, so the backstop shoved
     the rival around every frame and never converged — 126 overlapping frames
     a run in dense traffic that no amount of extra passes could fix. They have
     to agree on what "clear" means. */
  clearLon: 1.0, clearLat: 0.3,
  /** the backstop's own margins, and how many passes it may resolve in (m, m) */
  sepLon: 0.9, sepLat: 0.25, sepPasses: 4,
  /** the guaranteed escape: step back this far, this many times, until
      nothing overlaps (see the end of rivalSeparate) */
  backOffStep: 0.6, backOffSteps: 40,

  /* ---- how it reads the road ---- */
  /** how far ahead it PLANS (m) — long, to choose lanes early */
  seeAhead: 240,
  /** ...and how far ahead it FOLLOWS (m) — short, so it is not timid. Letting
      the follow use the planning horizon made it lift for cars 100 m away. */
  followSee: 95,
  /** cap on laneFree, seconds — past this a lane is "clear enough" */
  laneFreeMax: 30,
  /** How much better another lane must be before it moves, as a RATIO.

      Back up from 1.06, which was too fine a distinction to act on ten times a
      second — combined with the timer it produced a car that reversed itself
      mid-move and never finished anything. With the commitment latch below the
      rival only asks this question when it is free to act on the answer, so
      the margin can be a real one. */
  laneGain: 1.3,
  /** ...and during a patience spell, where it wants a dramatic gain */
  laneGainHold: 3.0,
  /** ---- rubber-band "hustle": how eagerly it hunts for a lane, never its
      top speed or following distance (see the RIVAL block comment on the
      removed "defend" — that reacted to a single moment and fought the
      easing; this integrates over seconds of genuinely losing ground and
      changes nothing that could put it into anybody). Meaningfully behind
      for hustleAfter seconds and it starts lowering the gain a lane change
      needs; hustleSpan later it is at gainMin. Decays twice as fast as it
      builds, so a moment back in front does not leave it keyed up. */
  hustleBehind: 25, hustleAfter: 4, hustleSpan: 8, hustleGainMin: 0.85,
  /** folAMax/folBCom lerp toward this at full hustle — still comfortably
      under what the layer-3 backstop and its own brakeHard can absorb. */
  hustleFolMax: 8.0,
  /** lateral m/s the target eases at */
  laneRate: 9.0,
  /** How close counts as having ARRIVED at the chosen line (m), and the
      longest it will persist with one before admitting it is stuck (s). */
  laneArrive: 0.35, laneMaxHold: 2.5,
  /** ...and the shortest time it will hold a decision before taking another,
      so arriving somewhere does not immediately start it shopping again. */
  laneMinHold: 0.6,

  /* ---- car-following, deliberately inhuman ---- */
  /** Time headway and standstill gap. At 30 m/s this sits 4 m off a bumper
      where a person wants 25. It has perfect information and no reaction
      time; this is it using them. */
  folS0: 1.2, folTUrgent: 0.06,
  folAMax: 5.0, folBCom: 5.0,
  /** speed error → acceleration while running free, and the limits */
  spdP: 2.5, accMax: 7.5, brakeSoft: -7, brakeHard: -10,

  /* ---- contact ---- */
  shuntMin: 1.0, shuntMax: 2.0,
  shuntLat: 0.45, shuntLon: 0.5,
  shuntLonMax: 6, shuntDamp: 2.2,

  /* ---- how much the body turns while it moves sideways ----
     Heading is the road plus a capped lean into where it is actually going.
     Uncapped this twisted the car far more than a real one does — and worse,
     a raw one-frame rate picked up depenetrations that were not motion at all
     and spiked to 85°. yawTau smooths, yawMax caps. Raised to 9° when the
     lateral rate went to 9 m/s: the true geometric angle there is 24°, so the
     car now crabs slightly rather than drifting visibly. Neither touches how
     fast it actually moves sideways — position comes from offCur. */
  yawMax: 9 * Math.PI / 180, yawTau: 0.10,

  /* ---- brake lamps ---- */
  /** Much higher than updateHwy's -0.35/-0.12: those are tuned to IDM's
      output. This car brakes at up to -10, so a fixed small threshold lit the
      lamps ~47% of the time and they stopped meaning anything. The lamp should
      mean "braking hard FOR THIS CAR". */
  lampOn: -2.2, lampOff: -1.0,

  /* ---- traffic yielding to it ----

     The fleet gets out of its way. This is the one thing that lifts it past
     the "never overlap" ceiling: at 29 cars per lane-km it was leader-limited
     on ~85% of frames and could only manage 1.25x the flow speed, because you
     cannot go faster than the gaps that exist. Making gaps exist is the
     remaining lever, and it is the one the user chose.

     It reuses the shape of the courtesy nudge that already makes NPCs ease
     aside for the PLAYER, so this is a behaviour the game already exhibits and
     players already see — not a new kind of magic. The differences are that it
     is a full lane change rather than a within-lane lean (a lean cannot help:
     a lane is 3.7 m and two bodies are 3.64 m, so leaning aside inside your own
     lane does not create a passable gap), and that it triggers on a car coming
     up fast behind rather than on dwell time.

     Deliberately NARROW so it reads as one driver noticing a mirror rather
     than as the sea parting:
     · only the car actually in the rival's path (yieldLat), not a lane's worth
       either side;
     · only while the rival is within yieldSee and genuinely faster (yieldDv);
     · one car at a time, since only one can be directly in front;
     · it signals, and it uses the ordinary gap acceptance, so it will not move
       into the player or into another car — laneClearAt already treats the
       player as a hard no-go;
     · and if there is nowhere to go it simply stays, and the rival has to
       queue like anybody else. */
  /** how far back the rival can be and still be worth moving for (m) */
  yieldSee: 55,
  /** ...and inside this it is simply on the bumper, speed irrelevant (m) */
  yieldClose: 14,
  /** how much of a closing-speed advantage it needs before anyone bothers */
  yieldDv: 4,
  /** lateral window that counts as "in its path" (m) */
  yieldLat: 2.4,

  /* ---- misc ---- */
  /** seed distance ahead of the player, m */
  seedAhead: 90,
  /** lookahead used to measure the lane centre's slide, seconds of travel */
  slideDt: 0.1,
  /** a colour nothing in NPC_COLORS uses */
  paint: 0xf24a1e,
};

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
  /** Nonzero while a FORCED taper merge is wanted but blocked: the driver
      leans this far off their lane centre toward the target lane (body still
      inside their own lane), blinker running, waiting for a slot. Followers
      in the target lane perceive a signalling car at a wider lateral window,
      so the lean is what makes them hold back and open the zipper gap.
      Transient — rewritten every updateHwy, cleared the moment the merge is
      accepted or stops being needed. */
  mergeLean: number;
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
  /** This is the rival, not traffic — see the RIVAL block. Exempts the slot
      from recycling and from every NPC-vs-NPC interaction, and routes it to
      updateRival instead of updateHwy. */
  rival: boolean;
  /** set the frame a close call with the player fires, else null; cooldown in ccCd */
  ccKind: "horn" | "chirp" | null;
  ccCd: number;
  /** cooldown on THIS car counting again toward the No Hesi score — see
      globalScoreCd */
  scoreCd: number;
  /* ---- horn/flash reactions (see the HAIL block) ---- */
  /** how many gestures this car has been on the receiving end of this life —
      the k of the saturating curve. Never decays; that is what bounds it. */
  hailGest: number;
  /** decaying insistence, in gestures. Decayed lazily against `hailAt` rather
      than per frame — it is read a few times a minute at most. */
  hailP: number;
  /** clock of the last gesture aimed at this car; drives both the decay above
      and the per-car cooldown */
  hailAt: number;
  /** this car has had its say — it complied, or it snapped — and is out of
      the game until it is recycled */
  hailDone: boolean;
  /** hazard-blip acknowledgement countdown (s) */
  hailAck: number;
  /** annoyed brake-check countdown (s) */
  hailMad: number;
  /* ---- courtesy nudge (see the NUDGE block) ---- */
  /** unbroken seconds the player has been tailgating / threading this car */
  nudgeDwell: number;
  /** which trigger the dwell is accumulating for: 0 none, 1 tailgate, 2 thread */
  nudgeKind: number;
  /** committed lateral nudge target, metres in this route's offset space,
      signed; 0 when not nudging. `nudgeCur` eases toward it. */
  nudgeLat: number;
  /** the eased, currently-applied nudge — this is what folds into offT */
  nudgeCur: number;
  /** seconds left holding the nudge after the player stops crowding */
  nudgeHold: number;
  /** gesture count k for the saturating curve, and the clock of the last roll */
  nudgeGest: number;
  nudgeRollAt: number;
  /* ---- white-lining (see the WLINE block) ---- */
  /** the adjacent-lane NPC this car currently reads as riding alongside it,
      or null. Re-validated every frame at O(1); re-searched for on wlT. */
  wlPartner: Npc | null;
  /** unbroken seconds paired with wlPartner */
  wlDwell: number;
  /** has this pair's one-time roll happened yet */
  wlRolled: boolean;
  /** …and what it decided: open a gap, and by how much (this car's own
      outward ease, metres — see WLINE.gapLo/gapHi) */
  wlOpen: boolean;
  wlGap: number;
  /** committed lateral ease target, metres in corridor-offset space, signed
      away from the partner; 0 when not easing. wlCur eases toward it. */
  wlLat: number;
  /** the eased, currently-applied ease — folds into offT alongside nudgeCur */
  wlCur: number;
  /** seconds until the next partner rescan (only spent while unpaired) */
  wlT: number;
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
   car ahead starts looking self-lit and the effect gives itself away.

   0.12 -> 0.085 -> 0.17, and the round trip is worth recording so nobody
   repeats it. 0.085 was a mistake: it was cut on a "too bright" report at the
   same time HLW_CORE_D came down from 18 m to 5 m, and the two compounded.
   Shortening the core is a large reduction on its own at following distance
   (factor 0.80 -> 0.57 at 30 m), so cutting the gain as well took the wash to
   about half of what this file already called "subtle by construction" — and
   the next report was that the effect had disappeared.

   The gain is now set so the shape change is level-neutral where it matters:
   0.17 x 0.57 = 0.097 at 30 m, which is the documented 0.096. What changed is
   only the distribution — up close it is stronger than the old flat core
   (0.17 at 3 m, where your beam really is on their bumper) and past 40 m it
   falls away faster. Peak stays well under the ~0.25 where a car starts
   reading as self-lit.

   0.22 -> 0.5, and this one is backed by a runtime measurement rather than
   arithmetic. Probing the live game (85 active NPCs, night, dashcam) showed
   `washCol` on lit instances sitting at **1.25** — that is the STREETLIGHT
   wash, which shares this channel, and it is already at the anti-blowout knee
   (KNEE = 1.3). A headlight contribution of 0.16 on top of 1.25 is a ~13%
   lift on an already-bright surface, which is why every previous increase
   here was invisible: the arithmetic was right and the effect was real, it
   was simply swamped.

   The "past ~0.25 it reads self-lit" note above predates that measurement and
   assumed the wash arrived on an otherwise dark car. That holds on an unlit
   stretch and does NOT hold under lamps. 0.5 gives ~26% lift up close and
   ~15% at following distance against a 1.25 base — visible without dominating
   — and on a dark stretch the knee is what stops it blowing out.

   If it needs to move again, move it ALONE and leave HLW_CORE_D at 5. */
const HLW_GAIN = 0.5;
/** Along-beam falloff, metres ahead of the player's nose: full only to 5 m,
    then a long smoothstep tail to zero at 60 m.

    The core was 18 m, and that was the real defect — not the gain. 18 m is
    longer than the whole range you actually follow a car at, so the wash sat
    pinned at maximum from the bumper out to ~20 m and only began to move
    beyond that. The car ahead therefore lit up by exactly the same amount
    whether you were two metres off its bumper or twenty, which reads as a
    glow stuck to the car rather than as your headlights falling on it — and
    it is what "it should illuminate depending on how close or far away I am"
    is describing.

    Pulling the core in to 5 m (about a car length, where a real dipped beam
    genuinely is saturated) puts the entire following range on the tail
    instead: the factor now runs 1.00 at 3 m, 0.91 at 15 m, 0.57 at 30 m and
    0.09 at 50 m. It moves continuously the whole time you are closing on
    someone. The 55 m gap to HLW_R_D keeps the tail long, which is what makes
    it a fade rather than an edge (see the realistic-light skill). */
const HLW_CORE_D = 5, HLW_R_D = 60;
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
  /** The same latch as a promise, for the staged load in engine.ts to wait on
      so the player drives off into a populated road rather than one that fills
      itself in over the first few seconds. Never rejects (loadNpcModels
      swallows per-style failures by contract). */
  readonly fleetLoaded: Promise<void>;
  private wheelInst: THREE.InstancedMesh;
  private wheelCount = 0;
  /** Fake headlight ground pools (one instanced additive quad per car).
      Public switch so a quality tier can turn the whole draw off; while on it
      costs a single draw call for the entire fleet. */
  headlightPools = true;
  private poolInst: THREE.InstancedMesh;
  private poolColor: THREE.InstancedBufferAttribute;
  private clouds: Record<string, Cloud> = {};
  /** The same clouds as a dense array. `clouds` is built once in the
      constructor and never re-keyed, so this is just the per-frame iteration
      order: updateLights walks every cloud twice for each of the N pool slots,
      and a `for…in` over the record does that with a key lookup per step. */
  private cloudList: Cloud[] = [];
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
  /** Player's route-space slot this frame (set in update()): corridor z/lat
      when on the deck, bypass s/lat when on the viaduct, plus speed — so
      lane-change gap acceptance (laneClearAt) can treat the player as a hard
      no-go and an NPC never begins a merge into a side-by-side player. */
  private playerSlot = { cor: false, by: false, s: 0, off: 0, byS: 0, byLat: 0, v: 0 };
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
  /* No Hesi scoring feed (see scoreEvents) — its own cooldown, deliberately
     shorter than the close-call audio's: that one is tuned to avoid a horn
     "chorus" (rare, discrete, per-driver-personality events), this one has
     to keep up with a player stringing several genuine near-misses together
     in a few seconds, which is the entire combo fantasy. Same detection and
     grading, different cadence. */
  private globalScoreCd = 0;
  private _scoreGrades: number[] = [];
  /** horn state last frame, and how long it has been held — update() turns the
      continuous `hornHeld` it is handed into discrete gestures from these, so
      the flash gesture is the only one the engine has to edge-detect itself */
  private hornPrev = false;
  private hornT = 0;
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
  /* ---- the rival (see the RIVAL block) ---- */
  /** the rival's slot, or null while the mode is off */
  private rival: Npc | null = null;
  /** the slot's own paint, restored when the mode is switched back off */
  private rivalPaint = { r: 0, g: 0, b: 0 };
  private _rivalCol = new THREE.Color();
  /** All of the rival's transient state. Deliberately here rather than on the
      Npc: there is exactly one of them, and the pool would otherwise carry
      nine more fields on 120 slots that never use any of them. */
  private riv = {
    /** seconds left of a visible hold-up behind real traffic */
    holdT: 0,
    /** seconds until the next hold-up is allowed */
    holdCd: 0,
    /** how hard the RUNNING hold-up is allowed to brake, 0..1 — see below */
    holdStr: 0,
    /** Lagged read of the player's pace. Tracking this rather than the live
        speed is what makes the station-keeping read as a driver watching
        their mirrors instead of as a mirror. */
    pace: 0,



    /** seconds it has been continuously behind the player — see reseedAfter */
    behindT: 0,
    /** seconds it has been MEANINGFULLY behind — see RIVAL.hustleBehind */
    hustleT: 0,
    /** slow drift on its pace, so it is never an exact multiple of yours */
    mood: 1,
    moodTo: 1,
    moodT: 0,
    /** seconds left of post-impact controller suppression */
    shunt: 0,
    /** impact slide, m/s in corridor-offset space */
    latV: 0,
    /** the lateral it is easing toward, corridor-offset space */
    offT: 0,
    /** the FINAL offCur last frame — recorded after layer 3, see updateRival */
    offPrev: 0,
    /** smoothed lateral rate, m/s, for the heading only */
    latRate: 0,
    /** render heading, from actual world velocity rather than the tangent */
    hTarget: 0,
    /** countdown to the next free-running lane choice */
    laneT: 0,
    /** The lateral OFFSET the current choice landed on — an offset rather than
        a lane index, because the shoulder is a legitimate destination and has
        no index. Held between decisions: the target has to keep easing toward
        it every frame, not only on the frame the timer fires, or the whole
        move is one `ease · dt` step per decision. */
    laneWant: 0,
  };
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
    this.cloudList = Object.values(this.clouds);

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
        laneK: 1, offCur: 0, offT: 0, pendK: -1, laneRate: this.cor.lanePitch(0) / 3,
        mergeLean: 0, s: 0,
        v: 0, v0: 10,
        drv: {
          spd: 1, gap: 1, acc: 1, lane: 0.5, react: 0.3, corner: 1, timid: 0, weave: 0, jit: rand(0, TAU),
          bias: 0, driftAmp: 0, driftRate: 0, driftPhase: 0, yieldMax: 0,
        },
        pT: 0, pLead: { ds: Infinity, v: 0 },
        brake: false,
        blink: 0, blinkT: 0, turnCd: rand(2, 8), nudgeT: 0,
        hVis: 0, x: 0, y: -999, z: 0, spin: 0, wob: 0,
        wreck: null, fade: 1, rival: false, ccKind: null, ccCd: 0, scoreCd: 0,
        hailGest: 0, hailP: 0, hailAt: -1e9, hailDone: false, hailAck: 0, hailMad: 0,
        nudgeDwell: 0, nudgeKind: 0, nudgeLat: 0, nudgeCur: 0, nudgeHold: 0,
        nudgeGest: 0, nudgeRollAt: -1e9,
        wlPartner: null, wlDwell: 0, wlRolled: false, wlOpen: false, wlGap: 0,
        wlLat: 0, wlCur: 0, wlT: 0,
      });
    }

    /* Load the bodyshells. Each model that lands makes its style live; the
       fleetReady latch (set when every style has been tried) releases the
       corridor seeding frame, so the opening fill happens with real cars.
       A style whose file is missing or corrupt simply never spawns. */
    this.fleetLoaded = loadNpcModels(Object.keys(this.styleOf), (m) => this.applyModel(m)).then(
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
    n.mergeLean = 0;
    n.blink = 0;
    n.ccKind = null;
    n.route = -1;
    n.wantBypass = 0;
    // the hail state is a property of the driver, and this slot is about to be
    // recycled into a new one; rollDriver() re-arms it, this just stops a
    // deactivated car from carrying a live timer while it sits in the pool
    n.hailAck = 0;
    n.hailMad = 0;
    n.nudgeT = 0;
    // ...and the same for the close-call cooldown, which is otherwise the one
    // timer in that family nothing re-arms: a slot recycled mid-cooldown used
    // to hand its remaining ~10 s to the next driver, silently barring a brand
    // new car from the annoyed horn-back at hailRoll()'s `n.ccCd <= 0` gate
    n.ccCd = 0;
    /* Manoeuvre state, not personality — it belongs with pendK/blink above.
       Zero selects the `n.laneRate || <route pitch>/3` fallback both offset
       trackers already carry, so a fresh car signalling before anything sets
       a rate (the bypass exit signal in updateHwy, the merge signal in
       updateBypass) crosses at this route's own default instead of at
       whatever rate the slot's previous occupant happened to leave behind. */
    n.laneRate = 0;
    /* courtesy-nudge state (see the NUDGE block) — manoeuvre state, not
       personality, so it clears with pendK/blink here; rollDriver() re-arms
       the saturating curve itself for the incoming driver */
    n.nudgeDwell = 0;
    n.nudgeKind = 0;
    n.nudgeLat = 0;
    n.nudgeCur = 0;
    n.nudgeHold = 0;
    // white-lining state (see the WLINE block) — manoeuvre state too
    n.wlPartner = null;
    n.wlDwell = 0;
    n.wlRolled = false;
    n.wlOpen = false;
    n.wlLat = 0;
    n.wlCur = 0;
    n.wlT = 0;
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

    /* How far this driver can ever be pushed by a horn or a headlight flash.
       Archetype sets the band (see HAIL.ceil), then a flat stoneWall share
       overrides it outright so the personality is a tendency and not a tell,
       and heavies/police are near-immovable whatever they rolled. Uniform
       inside the band, so two "average" cars an hour apart in ceiling still
       feel like different people. */
    if (this.rng() < HAIL.stoneWall) d.yieldMax = R(HAIL.stoneCeil);
    else {
      let y = R(HAIL.ceil[idx]);
      if (heavy) y *= HAIL.heavyCeil;
      else if (n.type === "police") y = Math.min(y, HAIL.policeCeil);
      d.yieldMax = Math.min(y, HAIL.ceilCap);
    }
    n.hailGest = 0;
    n.hailP = 0;
    n.hailAt = -1e9;
    n.hailDone = false;
    n.hailAck = 0;
    n.hailMad = 0;
    n.nudgeT = 0;
    // the courtesy-nudge curve is per-driver, exactly like the hail curve above
    n.nudgeGest = 0;
    n.nudgeRollAt = -1e9;

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
      /* Seed for the DOWNSTREAM lane count: a car dropped into a lane that
         ends within the next ~10 s of travel only feeds the pileup at the
         taper, so upstream of a shrink the spawner fills just the lanes that
         survive it — which also thins density to what the narrower section
         can actually carry (the per-lane 20 m spacing check below does the
         throttling once the doomed lanes are off the menu). */
      const nl = Math.min(cor.lanes(z), cor.lanes(cor.wrapZ(z + 300)));
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
        /* corridor cars only: a bypass car's `s` is viaduct arclength and its
           `offCur` a bypass-frame lateral, so feeding either into these
           corridor-space comparisons is meaningless — it just vetoes deck
           spawns at unrelated places while the viaduct is populated.
           laneClearAt() and trySpawnBypass() both filter by route already. */
        if (m.route !== -1) continue;
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
      /* The bypass never leaves the canonical band, so no lap re-anchoring —
         and the banked cross-fall folds into y (the deck-height snap the
         corridor's heightAt used to provide comes from the graph here).

         Open-coded rather than routes.bypass.worldOf(): RouteEdge.worldOf
         calls poseAt() WITHOUT an out-param (routegraph.ts), so it allocates
         a fresh RoutePose on every call however the `out` is passed — once
         per bypass car per frame, which is exactly the churn the reused
         `bpose` exists to avoid. This is that method's body verbatim against
         a pose sampled into bpose instead. */
      const lat = n.offCur + (n.wob || 0);
      const p = this.routes.bypass.poseAt(n.s, this.bpose);
      n.x = p.x + lat * p.nx;
      n.y = p.y + lat * p.bank;
      n.z = p.z + lat * p.nz;
      return;
    }
    const p = this.cor.worldOf(n.s, n.offCur + (n.wob || 0), this._cw);
    n.x = p.x;
    n.y = p.y;
    const LOOP = this.cor.LOOP;
    n.z = p.z + LOOP * Math.round((refZ - p.z) / LOOP);
  }

  /* ---------------- the rival (see the RIVAL block) ---------------- */

  /** Bodyshells that read as a quick road car from behind. A rival that
      rolled the box truck would be funny exactly once. */
  private static readonly RIVAL_TYPES = ["sedan", "suv", "compact", "hybrid"];

  /** Claim a pool slot for the rival. Deliberately CLAIMS rather than
      reserves: a slot reserved at construction would cost one even with the
      mode off, and the mode is a runtime toggle. Any idle slot is already a
      legal instance of its own style, so this can never overflow an instance
      buffer the way adding a 121st Npc would (each style's InstancedMesh is
      sized to exactly that type's roster count — see the constructor). */
  private claimRival(player: CarState): boolean {
    let slot: Npc | null = null;
    for (const t of Traffic.RIVAL_TYPES) {
      const sIx = this.styleOf[t];
      if (sIx === undefined || !this.ready[sIx]) continue;
      for (const n of this.npcs)
        if (!n.active && n.style === sIx) { slot = n; break; }
      if (slot) break;
    }
    if (!slot) return false; // no model yet, or none idle — retry next frame
    const n = slot;
    this.rivalPaint.r = n.cr;
    this.rivalPaint.g = n.cg;
    this.rivalPaint.b = n.cb;
    const C = this._rivalCol.setHex(RIVAL.paint);
    n.cr = C.r;
    n.cg = C.g;
    n.cb = C.b;
    n.rival = true;
    this.rollDriver(n);
    // a rival reads the road instantly and never moves over for anybody
    n.drv.react = 0.12;
    n.drv.yieldMax = 0;
    n.drv.bias = 0;
    n.drv.driftAmp = 0;
    this.rival = n;
    this.seedRival(player);
    return true;
  }

  /** Hand the slot back to the pool exactly as it was found. */
  private releaseRival() {
    const n = this.rival;
    if (!n) return;
    n.cr = this.rivalPaint.r;
    n.cg = this.rivalPaint.g;
    n.cb = this.rivalPaint.b;
    n.rival = false;
    this.rival = null;
    this.riv.latV = 0;
    this.riv.shunt = 0;
    this.riv.holdT = 0;
    this.deactivate(n);
  }

  /** Put the rival back on the road ahead of the player — on claim, and again
      after any real teleport (the warpSeed path; the loop splice is NOT one,
      see below). */
  private seedRival(player: CarState) {
    const n = this.rival;
    if (!n) return;
    const cor = this.cor;
    /* Enter at a speed that belongs to the situation rather than at RIVAL.top.
       Two reasons, one cosmetic and one that showed up in the sim: a car
       materialising 90 m ahead already doing 266 km/h while the player idles
       reads as a spawn, and — worse — the whole first ~12 s then goes on the
       far-cap shedding 47 m/s at brakeSoft, which opens a ~240 m gap before
       anything converges. Starting from the player's own pace makes the
       transient disappear; it winds up to RIVAL.top under its own power. */
    const enter = clamp(Math.abs(player.u) + 8, 22, RIVAL.top);
    const z = cor.wrapZ(cor.zAt(player.x, player.z) + RIVAL.seedAhead);
    n.active = true;
    n.hw = true;
    n.edge = null;
    n.dir = 1;
    /* Corridor route, permanently. `n.s` is therefore a wrapped corridor z and
       placeHwy re-anchors the world z to the player's lap every frame, which
       is the whole reason the rival survives the loop splice for free —
       engine.ts's loopSplice explicitly fixes nothing up in traffic. */
    n.route = -1;
    n.wantBypass = -1; // never peels onto the viaduct — see updateRival
    n.wreck = null;
    n.fade = 1;
    n.blink = 0;
    n.pendK = -1;
    n.mergeLean = 0;
    n.nudgeCur = 0;
    n.nudgeLat = 0;
    n.wlPartner = null;
    n.wlLat = 0;
    n.wlCur = 0;
    n.laneK = Math.max(0, Math.min(cor.lanes(z) - 1, cor.lanes(z) >> 1));
    n.s = z;
    n.offCur = n.offT = cor.laneOffset(n.laneK, z);
    n.v = enter;
    n.v0 = RIVAL.top;
    n.pT = 0;
    n.pLead.ds = Infinity;
    n.brake = false;
    const riv = this.riv;
    riv.holdT = 0;
    riv.holdCd = rand(3, 7);
    riv.shunt = 0;
    riv.latV = 0;
    riv.laneT = 0;
    riv.laneWant = n.offCur;
    riv.pace = Math.abs(player.u);
    riv.mood = riv.moodTo = 1;
    riv.moodT = rand(RIVAL.moodEvery[0], RIVAL.moodEvery[1]);
    riv.offT = n.offCur;
    riv.offPrev = n.offCur;
    riv.latRate = 0;
    riv.hTarget = cor.pose(z, this.cpose).h;
    this.placeHwy(n, player.z);
    n.hVis = riv.hTarget;
  }

  /** Index of the lane centre nearest `off` at this corridor position. */
  private nearestLane(z: number, off: number): number {
    const nl = this.cor.lanes(z);
    let bestK = 0, bd = 1e9;
    for (let k = 0; k < nl; k++) {
      const d = Math.abs(this.cor.laneOffset(k, z) - off);
      if (d < bd) { bd = d; bestK = k; }
    }
    return bestK;
  }

  /** The rival's own view of the car in front — its own scan rather than the
      fleet's shared one, because that stops at 70 m (see RIVAL.seeAhead) and a
      driver who cannot see further than 1.3 seconds cannot plan anything.
      Geometry is on real half-widths rather than the shared 1.9 m window. */
  private rivalLead(n: Npc): { ds: number; v: number } | null {
    const cor = this.cor;
    let ds = Infinity, lv = 0;
    for (const m of this.npcs) {
      if (m === n || !m.active || !m.hw || m.rival) continue;
      if (m.route !== -1) continue;
      if (Math.abs(m.offCur - n.offCur) > (n.W + m.W) / 2 + 0.25) continue;
      const ahead = cor.deltaZ(n.s, m.s);
      if (ahead <= 0 || ahead > RIVAL.followSee) continue;
      const d = Math.max(ahead - (m.L + n.L) / 2, 0.1);
      if (d < ds) { ds = d; lv = m.wreck ? 0 : m.v; }
    }
    if (ds > 1e8) return null;
    this._lead.ds = ds;
    this._lead.v = lv;
    return this._lead;
  }

  /** SECONDS OF FREE RUNNING lane `off` offers before the rival would have to
      lift — how long it can hold `vFree` before it closes to a following
      distance on whatever is up there. Higher is better.

      This replaced a "time to cover the 240 m horizon" score, and the reason
      is the whole fix for "slow as a turtle, doesn't swim through traffic".
      Measured in the real corridor: flow 16.4 m/s, 25.6 cars per lane-km, so
      EVERY lane has a car within about 40 m. Over a long horizon that means
      every lane delivers about the same average speed — which is true, and
      useless. Run the numbers at those conditions and a lane with a car 15 m
      ahead scored 14.85 s against 14.41 s for one with one at 60 m: a 0.44 s
      spread, against a 0.35 s stay-put bonus. The lanes were indistinguishable,
      stickiness won every time, and the rival changed lane ZERO times in the
      instrumented run while sitting behind a car on 100% of frames.

      The long-horizon average is the wrong question in a queue. A car
      threading traffic is not planning 240 m ahead; it is taking the room
      available NOW, gaining on it, and then taking the next lot. So this asks
      how much road it can actually use before the next decision. At the same
      measured conditions that separates 15 m from 60 m by 9.4x rather than by
      3%, which is a difference a lane choice can actually be made on.

      It stays honest on open road, which is what the plan-at-240 /
      follow-at-95 split bought and must not be given back: a lane whose leader
      is far away, or not slower, returns the cap, so a clear lane and a
      nearly-clear lane read as equally good and it has no reason to weave for
      nothing. */
  private laneFree(n: Npc, off: number, vFree: number): number {
    const cor = this.cor;
    let d = Infinity, mv = 0;
    for (const m of this.npcs) {
      if (m === n || !m.active || !m.hw || m.rival) continue;
      if (m.route !== -1) continue;
      if (Math.abs(m.offCur - off) > 2.2) continue;
      const ds = cor.deltaZ(n.s, m.s);
      if (ds > 0 && ds < RIVAL.seeAhead && ds < d) {
        d = ds;
        mv = m.wreck ? 0 : m.v;
      }
    }
    if (d > 1e8) return RIVAL.laneFreeMax;
    const closing = vFree - mv;
    if (closing <= 0.5) return RIVAL.laneFreeMax; // never catches it
    /* Time to REACH it, not time until it must lift. Subtracting a following
       distance first looks more correct and is degenerate exactly where it
       matters most: at the real corridor's 29 cars per lane-km every lane has
       a car inside the headway, so every lane scored a flat zero, the ratio
       test below could never fire, and lane changes went DOWN. Plain d/closing
       is monotonic in the gap all the way to the bumper, so it still separates
       a 5 m lane from a 15 m one when everything is packed. */
    return Math.min(RIVAL.laneFreeMax, d / closing);
  }

  /** The lane offering the most free running — see laneFree. Lanes it could
      not move into without driving through somebody are not candidates at all.

      The stay-put advantage is a RATIO rather than a fixed number of seconds,
      and that matters: laneFree spans two orders of magnitude between a packed
      lane and a clear one, so any absolute bonus is either irrelevant when the
      lanes are far apart or decisive when they are close. A factor keeps the
      same meaning at every density — "only move for a clearly better lane" —
      which is what preserves the decisiveness that measured as load-bearing
      (dropping stickiness entirely cost 11 points of time-in-front and doubled
      the passes against it). */
  private bestLane(n: Npc, vFree: number, gain: number): number {
    const cor = this.cor;
    const nl = cor.lanes(n.s);
    const cur = this.nearestLane(n.s, n.offCur);
    let bestOff = cor.laneOffset(cur, n.s);
    let bestV = this.laneFree(n, bestOff, vFree) * gain;
    for (let k = 0; k < nl; k++) {
      if (k === cur) continue;
      const off = cor.laneOffset(k, n.s);
      if (!this.rivalLatClear(n, off)) continue;
      const v = this.laneFree(n, off, vFree);
      if (v > bestV) { bestV = v; bestOff = off; }
    }
    /* THREADING: the line BETWEEN two adjacent lanes, not just their centres.
       A human no-hesi driver splits the gap when the cars flanking it are
       staggered rather than waiting for a whole lane to clear — the same
       fantasy Part 2's white-lining opens up for the player. This reuses
       laneFree/rivalLatClear exactly as the lane-centre scan above does, so
       it is still the one offset pathway: a midpoint is only worth taking
       when both flanks are far enough along their own lane that laneFree
       scores it above sitting in the current lane, and rivalLatClear still
       refuses it outright if either flank is anywhere near abeam. */
    for (let k = 0; k < nl - 1; k++) {
      const off = (cor.laneOffset(k, n.s) + cor.laneOffset(k + 1, n.s)) / 2;
      if (!this.rivalLatClear(n, off)) continue;
      const v = this.laneFree(n, off, vFree);
      if (v > bestV) { bestV = v; bestOff = off; }
    }
    /* THE SHOULDER. The corridor carries SHOULDER metres of sealed road
       outboard of the outermost lane centres — about 3.6 m of usable offset
       once the body and a margin are taken off, which is very nearly a lane's
       worth on each side that nothing else in this file ever uses. Traffic
       stays in its lanes, so when the kerb lane is queueing the road beside it
       is empty. A human would not use it; this car is not one. */
    const lim = Math.max(0, cor.halfWidth(n.s) - n.W / 2 - 0.3);
    for (const off of [-lim, lim]) {
      if (Math.abs(off - n.offCur) < 1.0) continue;
      if (!this.rivalLatClear(n, off)) continue;
      const v = this.laneFree(n, off, vFree);
      if (v > bestV) { bestV = v; bestOff = off; }
    }
    return bestOff;
  }

  /** Traffic getting out of the rival's way — see the yield block in RIVAL.

      Returns true if `n` committed to a lane change for it. Only ever called
      for ordinary corridor cars, and it does nothing at all unless the rival
      is active, close, in this car's lane and genuinely quicker — so with the
      mode off, or the rival elsewhere on the corridor, not one line of this
      changes how the fleet drives. */
  private yieldToRival(n: Npc): boolean {
    const r = this.rival;
    if (!r || !r.active || r.wreck) return false;
    if (n.route !== -1 || !n.hw || n.wreck) return false;
    // already committed to something, or mid-manoeuvre — leave it alone
    if (n.pendK >= 0 || n.blink !== 0 || n.mergeLean !== 0) return false;
    const cor = this.cor;
    // is it coming up behind this car, in this car's path, and faster?
    const behind = cor.deltaZ(r.s, n.s);
    if (behind <= 0 || behind > RIVAL.yieldSee) return false;
    if (Math.abs(r.offCur - n.offCur) > RIVAL.yieldLat) return false;
    /* Either it is visibly quicker, OR it is already sitting on this car's
       bumper. The second half matters more than it looks: once the rival is
       blocked it slows to ITS blocker's speed, so a pure "is it faster" test
       goes false at exactly the moment the yield is needed, and the whole
       mechanic only fired 3.5 times a minute. A car filling your mirror at
       four metres wants past whether or not it is going faster right now. */
    if (behind > RIVAL.yieldClose && r.v < n.v + RIVAL.yieldDv) return false;

    /* Move AWAY from the side the rival is closing on where there is a choice,
       otherwise take whichever lane is free. Ordinary gap acceptance decides,
       so this can no more move into the player or another car than a voluntary
       lane change can. */
    const nl = cor.lanes(n.s);
    /* AWAY FROM IT, and only away. The first version fell back to the other
       side when that lane was blocked, which is the ordinary lane-change
       pattern and exactly wrong here: the fallback moved the yielding car
       TOWARD the thing it was getting out of the way of. In dense traffic that
       produced hundreds of overlapping frames a run, because a car would
       commit to the near side while clear and then slide across as the rival
       arrived. If the away side is not available it simply does not yield, and
       the rival queues behind it like anybody else. */
    const away = r.offCur <= n.offCur ? 1 : -1;
    {
      const k2 = n.laneK + away;
      if (k2 < 0 || k2 > nl - 1) return false;
      const off2 = cor.laneOffset(k2, n.s);
      /* The URGENT gap envelope, not the comfortable one — the same tighter
         pair a forced taper merge already uses in this file when the pavement
         is running out. A yield is that kind of move: the driver has decided
         to go and takes a gap they would not take casually. It matters more
         than it sounds. With the roomy envelope the car in front WANTED to
         yield on 8186 frames of a four-minute run and was boxed in on
         essentially all of them — 19 yields actually happened. The mechanic
         was not under-triggering, it had nowhere to go.

         The player is still a hard no-go: laneClearAt keeps its full
         closing-speed terms for them whatever envelope is passed, so a
         yielding car can never be shoved into the player. */
      // brisk: this is a driver reacting to a mirror, not a planned move, and
      // the projection below needs the rate before it is committed to
      n.laneRate = cor.lanePitch(n.s) / 1.1;
      const urgent = 1.2 + 0.25 * n.v;
      if (!this.laneClearAt(n, n.s, off2, n.route, urgent, 2.5 + 0.35 * n.v))
        return false;
      /* ...and explicitly not into the RIVAL. laneClearAt deliberately ignores
         it (exemption #2 — traffic is unaware of this car), which is right
         everywhere else and exactly wrong here: this car is moving over FOR
         the rival, so moving into it is the one outcome the manoeuvre must not
         produce. Without this the yield drove cars into it and layer 3 was
         left mopping up 256 overlapping frames a run. */
      {
        /* PROJECTED FORWARD, not just checked where it is now. The move takes
           about a second to complete and the rival is closing the whole time,
           so a gap that is clear at the moment of committing is not clear when
           the car is halfway across — which is where the remaining overlapping
           frames were coming from. Require the space to still be there when
           the manoeuvre finishes. */
        const moveT = cor.lanePitch(n.s) / n.laneRate;
        const closing = Math.max(0, r.v - n.v);
        const dLat = Math.abs(off2 - r.offCur);
        const dLon = Math.abs(cor.deltaZ(r.s, n.s)) - closing * moveT;
        if (dLat < (n.W + r.W) / 2 + RIVAL.clearLat &&
            dLon < (n.L + r.L) / 2 + RIVAL.clearLon + urgent) return false;
      }
      n.pendK = k2;
      n.blink = off2 < n.offCur ? -1 : 1;
      // brisk: this is a driver reacting to a mirror, not a planned move
      n.blinkT = rand(0.15, 0.35);
      n.turnCd = Math.max(n.turnCd, 2);
      return true;
    }
  }

  /** LAYER 2: is the lateral position `off2` free of other traffic at the
      rival's station? Bodies, not lanes — this is what stops it sliding
      sideways through a car that happens to be alongside it. */
  private rivalLatClear(n: Npc, off2: number): boolean {
    const cor = this.cor;
    for (const m of this.npcs) {
      if (m === n || !m.active || !m.hw || m.rival || m.wreck) continue;
      if (m.route !== -1) continue;
      if (Math.abs(m.offCur - off2) >= (n.W + m.W) / 2 + RIVAL.clearLat)
        continue;
      const ds = cor.deltaZ(n.s, m.s);
      const need = (n.L + m.L) / 2 + RIVAL.clearLon;
      if (ds > -need && ds < need) return false;
    }
    return true;
  }

  /** LAYER 3: the hard backstop. After everything else has had its say the
      rival must not be sharing a body with a traffic car — "it never overlaps"
      has to be a guarantee rather than an aspiration, and layers 1 and 2 are
      both heuristics carrying a frame of latency. The case neither of them can
      cover at all is a traffic car changing lanes INTO the rival: traffic is
      blind to it by design, so that will happen, and this is what answers it.

      Resolution is the minimum translation out of the overlap — whichever of
      the four ways out is shortest — and it ITERATES, because the situation
      that actually turns up is being sandwiched: pushing clear of one car in a
      packed lane puts the rival inside the next one, and a single pass just
      moves the overlap around (measured: 503 overlapping frames with one pass,
      zero with this). Bounded passes, worst overlap first, so it always spends
      its effort on the one that matters.

      Only the RIVAL is ever moved. The overlap resolver this mirrors (see
      "overlap resolution between NPCs" in update()) shoves whichever car is
      behind, which would be exactly wrong here: traffic is supposed to be
      unaware of this car, and a traffic car visibly braking or being shunted
      out of its way is the same unnatural read that the clipping was. */
  /** Total body penetration the rival would be left sitting in at a
      hypothetical station/offset — the measure rivalSeparate picks its escape
      route by. Zero means genuinely clear of everything. */
  private rivalPen(n: Npc, s: number, off: number): number {
    const cor = this.cor;
    let total = 0;
    for (const m of this.npcs) {
      if (m === n || !m.active || !m.hw || m.rival || m.wreck) continue;
      if (m.route !== -1) continue;
      const dLat = (n.W + m.W) / 2 + RIVAL.sepLat - Math.abs(off - m.offCur);
      if (dLat <= 0) continue;
      const dLon =
        (n.L + m.L) / 2 + RIVAL.sepLon - Math.abs(cor.deltaZ(m.s, s));
      if (dLon <= 0) continue;
      total += Math.min(dLat, dLon);
    }
    return total;
  }

  private rivalSeparate(n: Npc) {
    const cor = this.cor;
    const lim = Math.max(0, cor.halfWidth(n.s) - n.W / 2 - 0.3);
    let lastWorst = 0;
    for (let pass = 0; pass < RIVAL.sepPasses; pass++) {
      let worst: Npc | null = null, worstPen = 0, wLat = 0, wLon = 0;
      for (const m of this.npcs) {
        if (m === n || !m.active || !m.hw || m.rival || m.wreck) continue;
        if (m.route !== -1) continue;
        const dLat = n.offCur - m.offCur;
        const latPen = (n.W + m.W) / 2 + RIVAL.sepLat - Math.abs(dLat);
        if (latPen <= 0) continue;
        const dLon = cor.deltaZ(m.s, n.s);
        const lonPen = (n.L + m.L) / 2 + RIVAL.sepLon - Math.abs(dLon);
        if (lonPen <= 0) continue;
        const pen = Math.min(latPen, lonPen);
        if (pen > worstPen) {
          worstPen = pen; worst = m; wLat = dLat; wLon = dLon;
        }
      }
      if (!worst) return;
      lastWorst = worstPen;
      const latPen = (n.W + worst.W) / 2 + RIVAL.sepLat - Math.abs(wLat);
      const lonPen = (n.L + worst.L) / 2 + RIVAL.sepLon - Math.abs(wLon);
      /* Pick the way out that actually LEAVES IT CLEAR, not the shortest one.

         Shortest-translation is the textbook answer and it cycles here: in
         packed traffic the small move out of one car is very often straight
         into the next, the following pass undoes it, and no number of passes
         converges — measured at the real corridor's density, 100 overlapping
         frames that were completely insensitive to raising sepPasses from 4 to
         32. Dropping the lateral escape instead is much worse (742 frames): it
         is the escape that does most of the work, because a lateral gap is
         usually what actually exists. So evaluate both, and take the one that
         leaves the least penetration behind. A lateral move must also stay on
         the pavement — going through a parapet to avoid a car is not an
         improvement. */
      const latOut = n.offCur + (wLat >= 0 ? latPen : -latPen);
      const lonOut = wLon >= 0
        ? cor.wrapZ(n.s + lonPen) : cor.wrapZ(n.s - lonPen);
      const pLat = Math.abs(latOut) <= lim
        ? this.rivalPen(n, n.s, latOut) : Infinity;
      const pLon = this.rivalPen(n, lonOut, n.offCur);
      if (pLat <= pLon) {
        n.offCur = latOut;
      } else {
        n.s = lonOut;
        if (wLon < 0) {
          // it ended up behind: take that car's pace rather than keep closing
          n.v = Math.min(n.v, worst.v);
          n.brake = true;
        }
      }
    }

    /* GUARANTEED ESCAPE. The passes above pick the least-bad way out of the
       worst overlap, which is right when a way out exists — but at the real
       corridor's density the rival can end up genuinely WEDGED, with every
       direction leaving it inside somebody. Measured: 126 overlapping frames a
       run that the passes could see perfectly well and simply could not fix,
       insensitive to how many passes they were given.

       So there is a fallback that cannot fail: give the road back. Step
       backwards along the corridor until nothing is overlapping. There is
       always clear road behind, because the rival just came from there, and
       backing off is the one correction that always terminates. It costs the
       rival position, which is exactly the right price — it is the car that
       was threading too optimistically. */
    if (this.rivalPen(n, n.s, n.offCur) > 0) {
      for (let i = 0; i < RIVAL.backOffSteps; i++) {
        n.s = cor.wrapZ(n.s - RIVAL.backOffStep);
        if (this.rivalPen(n, n.s, n.offCur) <= 0) break;
      }
      n.brake = true;
    }
  }


  /** The rival's driving. Owns only n.s, n.offCur, n.v, n.brake and n.blink —
      everything downstream (placeHwy, the render pass, lamps, the audio feed)
      is already generic, so none of it needs to know this car is special. */
  private updateRival(
    n: Npc, dt: number, player: CarState, playerSpeed: number, panic: boolean
  ) {
    const cor = this.cor;
    const riv = this.riv;
    const ps = this.playerSlot;
    /* The player's corridor station, valid from the VIADUCT too: zAt projects
       any nearby world point onto the alignment, whereas playerSlot.s is
       deck-only and goes stale the moment they take the bypass. The rival
       itself never leaves the trunk deck. */
    const pz = cor.zAt(player.x, player.z);
    let ahead = cor.deltaZ(pz, n.s);

    /* Beaten, and it has stayed beaten long enough and far enough astern that
       nobody can watch the fix — put it back in front. See RIVAL.reseedAfter
       for why the dwell matters more than the distance does. */
    riv.behindT = ahead < 0 ? riv.behindT + dt : 0;
    riv.hustleT = ahead < -RIVAL.hustleBehind
      ? riv.hustleT + dt : Math.max(0, riv.hustleT - 2 * dt);
    const hustle = clamp(
      (riv.hustleT - RIVAL.hustleAfter) / RIVAL.hustleSpan, 0, 1);
    if (ahead < -RIVAL.reseedBehind && riv.behindT > RIVAL.reseedAfter) {
      riv.behindT = 0;
      n.s = cor.wrapZ(pz + RIVAL.reseedAhead);
      n.v = Math.max(n.v, riv.pace);
      /* Adopt the distance it just reappeared at as the gap it WANTS, and
         restart the clock on the next roll. Without this it lands 110 m out,
         reads that as far past a target of maybe 15 m, and immediately dawdles
         at pace − gapDown to come back — which lets the player straight past
         and puts it in line for another recycle. That loop had the fallback
         firing five times in four minutes and doing the work the driving is
         supposed to do. */
      riv.offT = n.offCur;
      riv.offPrev = n.offCur;
      // and the smoothed rate, or the jump reads as lateral speed next frame
      // and the car reappears pointing sideways — the same class of bug the
      // offPrev ordering below fixes
      riv.latRate = 0;
      riv.latV = 0;
      riv.shunt = 0;
      riv.holdT = 0;
      this.placeHwy(n, player.z);
      ahead = RIVAL.reseedAhead;
    }

    /* ---------------- longitudinal ---------------- */
    let brakeFloor = RIVAL.brakeSoft;

    /* Lagged pace. This, not playerSpeed, is what the station-keeping runs
       off — see the RIVAL block: an instant match is the thing players
       actually notice. */
    riv.pace += (playerSpeed - riv.pace) * (1 - Math.exp(-dt / RIVAL.paceTau));

    /* Mood: a slow drift so its pace is never an exact multiple of yours. */
    riv.moodT -= dt;
    if (riv.moodT <= 0) {
      riv.moodT = rand(RIVAL.moodEvery[0], RIVAL.moodEvery[1]);
      riv.moodTo = rand(RIVAL.moodLo, RIVAL.moodHi);
    }
    riv.mood += clamp(
      riv.moodTo - riv.mood, -RIVAL.moodRate * dt, RIVAL.moodRate * dt);

    /* Target gap, re-rolled on its own clock — and every so often it makes a
       real BREAK for it instead, which is what stops the station-keeping
       reading as a tow rope. A break ends by simply rolling back into the
       band; it does not get yanked back. */


    /* Hold-ups. Now that the rival genuinely respects traffic, most of these
       arise BY THEMSELVES — it gets boxed in behind a truck with no lane worth
       moving to, and there is nothing to script. What survives here is the
       small deliberate half: a spell during which it does not go hunting for a
       better lane (see riv.holdT in the lane pick below), so it lingers behind
       what it is stuck behind instead of solving it in half a second with
       superhuman reactions. The natural version is the one doing the work; this
       just makes it last long enough to be a moment.

       It is the generator for the bumper-to-bumper phase either way, so it runs
       on its own clock rather than only when the rival is a long way ahead — a
       spell that starts with the player already close is the GOOD case. Not
       while it is out on a break: the break is why it is up the road. */
    /* Hold-ups must never cost it the lead: a patience spell that starts with
       the player right behind hands them the place, which is the one outcome
       the mode is not allowed to produce. Close in it drives, and gets its
       stuck-behind-a-truck moments from real traffic instead (which is where
       the good ones came from anyway). */
    if (riv.shunt <= 0 && ahead > RIVAL.holdNotWithin) {
      if (riv.holdT > 0) riv.holdT -= dt;
      else {
        riv.holdCd -= dt;
        if (riv.holdCd <= 0) {
          const far = clamp(
            (ahead - RIVAL.holdFrom) / RIVAL.holdSpan, 0, 1);
          riv.holdT = rand(RIVAL.holdMin, RIVAL.holdMax) + far * RIVAL.holdFar;
          riv.holdCd = lerp(RIVAL.cdNear, RIVAL.cdFar, far) + rand(0, 4);
          /* How hard THIS hold-up may brake, fixed at trigger time and scaled
             by how far past its target gap it fired. Without the scaling every
             hold-up is one size, and braking at brakeHard for even 3 s sheds
             ~20 m/s — well over 100 m of road. That is worth having when it
             fires a long way out; fired just past the target it would drop the
             rival straight into the player's lap. Near the target it is a lift
             they see the lamps for, far out it is a real stop. */
          riv.holdStr = far;
        }
      }
    } else riv.holdT = 0;

    /* LAYER 1 of not-driving-through-people: it follows the car in its own
       path, ALWAYS. This used to be gated on a hold-up being in progress, and
       that gate was the bug — the rest of the time it simply drove through
       whatever was in front of it. There is no gate now; the perception pass
       runs for the rival exactly as it does for every other car, and its
       result is always honoured. */
    let lead = this.rivalLead(n);
    if (lead && riv.holdT > 0) {
      // while it is being patient it will also brake properly for what it is
      // stuck behind, at that spell's own strength
      brakeFloor = lerp(RIVAL.brakeSoft, RIVAL.brakeHard, riv.holdStr);
    }
    /* The PLAYER is an obstacle like nothing else is. The rival phases through
       traffic; it never phases through the car it is racing, and once the
       player is ahead of it the only collision it can cause is a rear-end
       from behind — the least defensible hit in the game. So it follows them
       properly rather than relying on the panic net at 9 m. A player who gets
       past and then backs off genuinely holds it up, which is a fair thing to
       have discovered. (_lead2 is the main loop's player-obstacle scratch; the
       rival is dispatched instead of, not as well as, the paths that read it.) */
    if (!lead && ahead < 0 && ps.cor && Math.abs(ps.off - n.offCur) < 2.4) {
      const ds = Math.max(-ahead - (n.L + 4.5) / 2, 0.1);
      if (ds < 90) {
        this._lead2.ds = ds;
        this._lead2.v = ps.v;
        lead = this._lead2;
        brakeFloor = RIVAL.brakeHard;
      }
    }
    /* ---- how fast it wants to go ----

       IT DRIVES AT ITS OWN AMBITION AND ONLY EASES OFF WHEN IT IS TOO FAR
       AHEAD. This is the third shape this has taken, and the reason is worth
       recording because the previous one had a structural flaw no amount of
       tuning was going to reach.

       That version set the target to the PLAYER'S pace plus a correction. But
       the player's own target is their car's top speed — so on any clear
       stretch the player accelerated toward 78 m/s while the rival aimed for
       pace plus a few, and was simply driven away from. It could not
       out-accelerate the player anywhere, which is precisely the "literally so
       slow" that was reported, and it is why the rival kept accumulating a
       deficit it had no way to repay. The deficit was structural, not a tuning
       artifact, which is why raising its authority twice barely moved it.

       So the polarity is inverted. Its baseline is its OWN top speed, and the
       station-keeping only ever LIFTS: the further past its target gap it
       gets, the more it eases, down to a little under the player's pace so the
       gap genuinely closes. That satisfies all three wants at once — it is
       fast, it comes back so the player gets their bumper-to-bumper, and a
       slow player still sees it wait rather than vanish, because a large gap
       lifts it to pace − gapDown whatever that pace happens to be.

       Mood now modulates its own ambition rather than the player's pace, which
       also retires the old ratchet: the slow half of a mood used to be always
       available while the fast half needed clear road, so the unrecoverable
       slow half accumulated into a few hundred metres of drift. Scaling a
       fixed ambition has no such asymmetry. */
    let v0 = Math.min(RIVAL.top * riv.mood, RIVAL.top);
    if (ahead > RIVAL.easeBeyond) {
      /* Out of sight, so this cannot be perceived — see easeBeyond. Ramps to
         a pace under the player's so the gap genuinely comes back rather than
         merely stopping growing. */
      const t = clamp((ahead - RIVAL.easeBeyond) / RIVAL.easeSpan, 0, 1);
      v0 = lerp(v0, Math.max(riv.pace - RIVAL.gapDown, 0), t);
    }
    v0 = clamp(v0, 0, RIVAL.top);

    /* IDM only where it belongs — following a real car during a hold-up, where
       a fixed v0 and a real leader are exactly what it models. Free running
       uses the proportional law instead (see RIVAL.spdP). */
    let acc: number;
    if (lead) {
      /* Hustle also lets it press closer to a leader before the follow
         limit bites — still gated by the layer-3 backstop below, which
         does not care whether the frame it is cleaning up came from a
         lateral move or from following too close, so this cannot be the
         thing that puts it into the leader's boot. */
      const aMax = lerp(RIVAL.folAMax, RIVAL.hustleFolMax, hustle);
      const bCom = lerp(RIVAL.folBCom, RIVAL.hustleFolMax, hustle);
      const dv = n.v - lead.v;
      /* It is always in a hurry now — there is no "behind where it wants to
         be" any more, because it has no target gap to be behind. See
         RIVAL.folTUrgent; this is a driver in a hurry, not permission to pass
         through anybody, and all three layers still bind. */
      const T = RIVAL.folTUrgent;
      const sStar = RIVAL.folS0 + n.v * T +
        (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
      /* The following limit ALWAYS wins over the station-keeping target — see
         the RIVAL block. When traffic says it cannot have the gap the speed
         model wants, traffic is right and the gap does what it does. */
      acc = Math.min(
        (v0 - n.v) * RIVAL.spdP,
        aMax * (1 - Math.pow(sStar / Math.max(lead.ds, 0.55), 2)));
    } else acc = (v0 - n.v) * RIVAL.spdP;
    // the player is a hard obstacle like any other: a rival that drove THROUGH
    // the car it is supposed to be racing would give the whole game away
    if (panic) acc = Math.min(acc, RIVAL.brakeHard);
    /* Never brake harder than the player behind could react to. Close range is
       a design goal now, so this is load-bearing rather than polish: inside
       brakeTtc seconds of contact the floor ramps to a gentle lift, which
       still trips the brake lamps (brakeNear is past lampOn) but cannot
       produce a hit the player had no way to avoid. Deliberately keyed on
       time-to-contact rather than distance — 20 m is a comfortable cushion at
       a closing speed of 3 m/s and no warning at all at 40. */
    if (ahead > 0) {
      const closing = playerSpeed - n.v;
      if (closing > 0.1) {
        const t = clamp(ahead / closing / RIVAL.brakeTtc, 0, 1);
        brakeFloor = lerp(RIVAL.brakeNear, brakeFloor, t);
      }
    }
    acc = clamp(acc, brakeFloor, RIVAL.accMax);
    /* Every real deceleration telegraphs — see RIVAL.lampOn for why the
       thresholds are not updateHwy's. Hysteresis rather than one edge, or the
       lamps strobe on a steady cruise. With no win state, the brake lights are
       the player's main warning that contact is about to become possible. */
    n.brake = acc < (n.brake ? RIVAL.lampOff : RIVAL.lampOn);
    n.v = Math.max(0, n.v + acc * dt);
    n.s = cor.wrapZ(n.s + n.v * dt);

    /* ---------------- lateral ---------------- */
    /* THE RATE HAS TO BEAT THE PAVEMENT. LANE_FOLLOW_RATE is 3.4 m/s because
       every taper in corridor.ts is cut to a slope budget of rate / topSpeed
       against a fleet that tops out near 40 m/s (corridor.ts, docs/GAME.md
       §9). The rival runs at nearly twice that, so the shared constant cannot
       hold a lane centre through a shrink and the body falls off its lane.

       Rather than re-deriving that budget from a reference top speed, measure
       what the pavement is actually asking for: how far this lane's centre
       moves over the next tenth of a second of travel. That is exact, costs
       two laneOffset() calls, and scales itself with BOTH the car's speed and
       the local taper — through the toll plaza's spread as readily as through
       a shrink. Every lateral rate below carries this term, because a target
       that eases slower than the pavement moves has the same bug one layer up
       (which is exactly what test/rival-sim.mjs caught). */
    const cNow = cor.laneOffset(n.laneK, n.s);
    const slide = Math.abs(
      cor.laneOffset(n.laneK, cor.wrapZ(n.s + n.v * RIVAL.slideDt)) - cNow
    ) / RIVAL.slideDt;
    const track = Math.max(LANE_FOLLOW_RATE, slide + RIVAL.laneRate);

    let ease = RIVAL.laneRate + slide;
    let want = riv.offT;
    if (riv.shunt > 0) {
      // knocked about: no correction at all for this window, `want` unmoved
      riv.shunt -= dt;
    } else if (cor.inToll(n.s)) {
      /* The plaza is the one place a free lateral path is not free. Its toll
         islands are real colliders and a DRIVING npc has no static collision
         whatsoever — updateHwy's cars clear them purely by being pinned to
         lane centres, whose pitch is spread here precisely to make the gates
         threadable. So the rival threads a gate like everybody else rather
         than driving through an island in full view of the dashcam. */
      want = cor.laneOffset(this.nearestLane(n.s, riv.offT), n.s);
      ease = track;
    } else {
      /* Free running: take the lane it can actually carry speed in, on
         traffic alone. It has no idea where the player is — the lateral cover
         that used to live here is gone, along with the rest of the blocking.
         The choice is re-thought on a timer (the fleet scan is the only
         O(lanes × N) work in here) and the target eases toward it every frame;
         during a patience spell it wants a much bigger gain before it moves,
         which is what makes it sit behind things. */
      /* IT COMMITS. Once it has picked a line it goes there and finishes,
         and it does not re-derive the best lane while it is on its way.

         This is a latch rather than a timer because a timer was the bug. With
         a 6% margin and ten decisions a second it picked lane A, started
         moving, and the geometry changed BECAUSE it was now partway across —
         so lane B scored better, it reversed, and the reversal changed the
         geometry again. That is the wiggle the user saw, and it is also why it
         got stuck: a car that keeps reversing never completes a move, so it
         never gets past anybody. Cheap moves do not make flip-flopping
         harmless — that was my error in the overpowered pass.

         It re-decides on exactly three things: it has ARRIVED, the line it was
         taking has been BLOCKED by somebody moving into it, or it has been
         trying long enough to be plainly stuck (laneMaxHold). Nothing else
         interrupts it, including its own scorer changing its mind. */
      riv.laneT += dt;
      const arrived = Math.abs(n.offCur - riv.laneWant) < RIVAL.laneArrive;
      const blocked = !arrived && !this.rivalLatClear(n, riv.laneWant);
      if (blocked) {
        /* The line it was taking has closed. ABORT CLEANLY — settle into the
           lane it is actually in and serve the dwell before looking again.
           Going straight back to the scorer here is what kept the wiggle
           alive after the latch went in: in dense traffic a target is blocked
           constantly, so "blocked → pick a new one" is just the old timer
           wearing a different hat, and 40-48% of moves were still being
           abandoned. Settling is a decision too, and it finishes. */
        riv.laneWant = cor.laneOffset(this.nearestLane(n.s, n.offCur), n.s);
        riv.laneT = 0;
      } else if ((arrived && riv.laneT > RIVAL.laneMinHold) ||
        riv.laneT > RIVAL.laneMaxHold) {
        riv.laneT = 0;
        const gain = riv.holdT > 0 ? RIVAL.laneGainHold
          : lerp(RIVAL.laneGain, RIVAL.hustleGainMin, hustle);
        riv.laneWant = this.bestLane(n, v0, gain);
      }
      want = riv.laneWant;
    }
    /* Parapets: nothing else will catch it. updateHwy's cars are inside the
       pavement by construction (lane centre + a maxBias-clamped bias); a free
       path and an impact slide are neither of those. */
    const lim = Math.max(0, cor.halfWidth(n.s) - n.W / 2 - 0.3);
    const step = ease * dt;
    riv.offT += clamp(want - riv.offT, -step, step);
    riv.offT = clamp(riv.offT, -lim, lim);

    // impact slide, integrated straight onto the offset and damped out
    if (riv.latV !== 0) {
      n.offCur += riv.latV * dt;
      riv.latV *= Math.exp(-RIVAL.shuntDamp * dt);
      if (Math.abs(riv.latV) < 0.02) riv.latV = 0;
    }
    if (riv.shunt > 0) {
      riv.offT = n.offCur; // resume from wherever it ended up
    } else {
      /* LAYER 2: never slide sideways into a space somebody is in. The step is
         tested before it is taken, and simply not taken otherwise — the rival
         waits alongside with its target still set, which is what a driver
         looking for a gap actually does. Note this cannot deadlock it: the
         longitudinal follow above is what resolves the situation, by putting it
         behind the car rather than beside it. */
      const stepLat = clamp(riv.offT - n.offCur, -track * dt, track * dt);
      const cand = clamp(n.offCur + stepLat, -lim, lim);
      if (stepLat === 0 || this.rivalLatClear(n, cand)) n.offCur = cand;
    }
    n.offCur = clamp(n.offCur, -lim, lim);
    // keep the lane index sane for anything downstream that reads it
    n.laneK = this.nearestLane(n.s, n.offCur);

    /* Signals are a user setting and default OFF — see GameSettings.
       Sign convention matches updateHwy exactly (a move to a lower offset is
       −1), whatever that maps to on screen. */
    if (rivalMode().signals) {
      const d = riv.offT - n.offCur;
      n.blink = Math.abs(d) > 0.35 ? (d < 0 ? -1 : 1) : 0;
    } else n.blink = 0;

    /* Heading from the car's ACTUAL world velocity rather than the corridor
       tangent: a cover drift and an impact slide both move it sideways, and a
       car that slides without pointing where it is going reads as a sprite.
       Convention-free — it composes the tangent and normal components
       directly, so it cannot get the corridor's handedness backwards. */
    /* Lateral rate for the HEADING only — measured before layer 3 runs, and
       against the position layer 3 left the car at last frame.

       That ordering is the whole point and it was a real bug. `offPrev` used
       to be recorded here, BEFORE rivalSeparate, which then resolved overlaps
       by shoving the car up to (W₁+W₂)/2 sideways in a single frame. The next
       frame read that depenetration as though it were velocity: 2.2 m over one
       16 ms frame is 132 m/s of apparent lateral motion, which through the
       atan below is EIGHTY DEGREES of yaw — the car pointing very nearly
       sideways for a frame, and firing exactly when it was threading close to
       other traffic, which is when the player is looking at it. Recording
       `offPrev` after the separation instead means a correction is never
       mistaken for movement. */
    const rawRate = (n.offCur - riv.offPrev) / Math.max(dt, 1e-4);
    // ...and smooth it: a one-frame difference carries every bit of per-frame
    // noise straight into the visible heading
    riv.latRate += (rawRate - riv.latRate) * (1 - Math.exp(-dt / RIVAL.yawTau));

    /* LAYER 3 does NOT run here — see the rival separation pass at the end of
       update(). It used to, and that was wrong for a reason only the real
       corridor showed: the per-NPC loop updates cars in array order, so every
       car after the rival moves AFTER it has finished separating, and any of
       them can move into the space it just cleared. At the sparse density my
       sim used to run that never showed up; calibrated to the real corridor's
       29 cars per lane-km it produces overlaps in the tens of frames, and the
       instrumented game showed real ones too. Separation has to be the last
       thing that happens in the frame, not the last thing in this function. */

    /* Heading = the road, plus a capped lean into wherever it is actually
       going. Composed through the tangent/normal pair rather than by adding an
       angle, so it cannot get the corridor's handedness backwards, then the
       OFFSET from the road is what gets clamped — see RIVAL.yawMax. */
    const p = cor.pose(n.s, this.cpose);
    const sv = Math.max(n.v, 1);
    const composed = Math.atan2(
      p.tx * sv + p.nx * riv.latRate, p.tz * sv + p.nz * riv.latRate);
    riv.hTarget = p.h + clamp(angDiff(composed, p.h), -RIVAL.yawMax, RIVAL.yawMax);
  }

  /* ---------------- impact from player ---------------- */

  applyImpact(hit: NpcHit) {
    const n: Npc = hit.npc;
    if (!n.active) return;
    /* THE RIVAL NEVER WRECKS. There is no win state to reach for, and a chase
       that ends the first time you touch the thing you are chasing is not a
       chase — note how low the ordinary bar is: 2.6 m/s of CLOSING speed is
       9.4 km/h, a parking-lot nudge, so every real contact would end it.

       But "unbeatable" must not become "immovable", which is the other way
       this feels bad. So contact is a genuine disturbance instead: a forward
       shove, a lateral slide, and a window in which the controller does not
       correct at all, so it visibly gathers itself up before resuming. That
       suppression window is also what stops the light-tap case (a scrub, then
       an immediate correction) turning into a surge-and-lift oscillation.

       None of this costs the player any impact feedback: the crash sound, the
       damage and the dashcam glitch all fire off `relSpeed` in engine.ts,
       entirely independently of anything decided here. */
    if (n.rival) {
      const riv = this.riv;
      const p = this.cor.pose(n.s, this.cpose);
      const lon = (hit.nx * p.tx + hit.nz * p.tz) * hit.relSpeed;
      const lat = (hit.nx * p.nx + hit.nz * p.nz) * hit.relSpeed;
      n.v = Math.max(0, n.v + clamp(
        lon * RIVAL.shuntLon, -RIVAL.shuntLonMax, RIVAL.shuntLonMax));
      riv.latV += lat * RIVAL.shuntLat;
      riv.shunt = Math.max(riv.shunt, clamp(
        RIVAL.shuntMin + hit.relSpeed * 0.06, RIVAL.shuntMin, RIVAL.shuntMax));
      riv.holdT = 0;
      n.brake = true;
      return;
    }
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

  /** No Hesi scoring feed: the closeness grade (0..1, tighter is higher) of
      every near-miss that fired THIS frame — same detection as closeCalls'
      near-miss half, independent cooldown (see the NEARMISS block), and NOT
      gated on CLOSE_CALL_AUDIO, so scoring works with the close-call sound
      left off. Usually empty; can hold more than one value on a frame where
      several cars register at once. Reuses an array — read before the next
      update(). */
  scoreEvents(): number[] {
    return this._scoreGrades;
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
    camFx: number, camFz: number, density: number, hornHeld: boolean, night = true,
    /** the player flashed the high beams THIS frame — a one-frame pulse, not a
        held state, since the reaction is to the gesture and not to the beams */
    flashed = false
  ) {
    /* "on the expressway" has to come from the corridor now — the deck rises
       and falls by several metres, so a fixed height threshold would misread
       it near the low points. */
    const deckY = this.cor.heightAt(player.x, player.z, 8);
    const bySurf = this.routes.surfaceAt(player.x, player.z, 4);
    this.playerBy = bySurf && Math.abs(player.y - bySurf.y) < 7 ? bySurf : null;
    {
      /* route-space player slot for lane-change gap acceptance */
      const ps = this.playerSlot;
      ps.v = Math.abs(player.u);
      ps.cor = deckY !== null && Math.abs(player.y - deckY) < 7;
      if (ps.cor) {
        ps.s = this.cor.zAt(player.x, player.z);
        ps.off = this.cor.latAt(player.x, player.z);
      }
      ps.by = this.playerBy !== null;
      if (bySurf && ps.by) {
        ps.byS = bySurf.s;
        ps.byLat = bySurf.lat;
      }
    }
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

    /* Rival mode is a runtime toggle (start menu + settings panel), so the
       slot is claimed and released here rather than reserved at construction:
       with the mode off the whole feature costs this one flag read. It only
       runs while the player is up on the structure — down in the town there
       is no corridor to be paced along. The splice needs no handling at all
       (see seedRival); a real teleport does, and warpSeed is exactly that. */
    const wantRival = rivalMode().on && playerUp;
    if (wantRival && !this.rival) this.claimRival(player);
    else if (!wantRival && this.rival) this.releaseRival();
    if (this.rival && this.warpSeed) this.seedRival(player);
    this.globalCcCd = Math.max(0, this.globalCcCd - dt);
    this.globalScoreCd = Math.max(0, this.globalScoreCd - dt);
    this._scoreGrades.length = 0;

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
      /* The rival is exempt from the whole lifecycle: it is never culled for
         being out of the band and never handed back to the idle pool. Counted
         as deck traffic so it displaces one ordinary car rather than adding
         to the budget. */
      if (n.rival) {
        if (n.active) hwyCount++;
        continue;
      }
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
        if (n.active && n.hw && !n.wreck && !n.rival) {
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
      /* Reactions to being honked/flashed at. `nudgeT` used to be set by an
         unconditional "anything within 16 m of a held horn speeds up 15%"
         rule; the HAIL model below supersedes that outright — a car only
         picks its pace up now if it actually decided to, which is the whole
         point of the feature. The timers are counted down here (rather than
         where they are set) because hailGesture() runs after this pass. */
      if (n.nudgeT > 0) {
        n.nudgeT -= dt;
        v0 *= HAIL.boost;
      }
      if (n.hailAck > 0) n.hailAck -= dt;
      if (n.hailMad > 0) {
        n.hailMad -= dt;
        // a short lift, not a stop — IDM turns the lowered cruise speed into a
        // gentle decel, which trips n.brake below and lights the brake lamps
        v0 *= HAIL.annoyDrop;
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
          /* NPC-vs-NPC exemption #1 of 3 (see the RIVAL block). Traffic does
             not perceive the rival at all — if it did, the whole fleet would
             brake for a car closing on them at 50 m/s and the stream would
             collapse into a rolling roadblock everywhere it had been. The
             rival's OWN perception is unaffected: `m` is the other car, so
             this line exempts it in one direction only, which is what lets a
             hold-up still find a real leader to sit behind. */
          if (m.rival) continue;
          if (Math.abs(m.y - n.y) > 3) continue;
          const dx = m.x - n.x, dz = m.z - n.z;
          const ahead = dx * fx + dz * fz;
          if (ahead <= 0 || ahead > 70) continue;
          const side = Math.abs(dx * fz - dz * fx);
          /* a signalling car reads wider: the follower sees the blinker and
             the nose easing over (mergeLean carries a blocked merger to its
             lane edge, ~2.8 m off the neighbour's centre) and yields BEFORE
             the body is in-lane — that early give is what makes a zipper
             merge close cleanly instead of two cars discovering each other
             mid-crossing */
          if (side > (m.wreck ? 2.6 : m.hw && m.blink !== 0 ? 2.9 : 1.9)) continue;
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
      let nearPassGrade = 0;
      n.ccCd = Math.max(0, n.ccCd - dt);
      n.scoreCd = Math.max(0, n.scoreCd - dt);
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
        /* courtesy nudge — see the NUDGE block. Signed lateral too: `side` is
           the magnitude the rest of this pass wants, the nudge needs to know
           which flank the player is on. */
        // the courtesy nudge is a traffic behaviour; a rival crowds back
        if (n.hw && !n.rival)
          this.nudgeUpdate(n, dt, now, ahead, side, dx * fz - dz * fx, playerSpeed);
        // near-miss FOR THE CLOSE-CALL SOUND ONLY (nearPass has no other use —
        // panic above still drives actual evasive braking and is untouched).
        // A genuinely tight squeeze at real speed, not just "somewhat near":
        // this is a weaving-through-traffic game, so a loose threshold here
        // turns the core loop into a beep chorus. Tightened from a 1.0-2.4m
        // side window / ahead -5..11 / combined speed >9 to a real near-miss;
        // tuned against a Monte Carlo sim of a 2-minute aggressive weave to
        // land around 5-10 total reactions rather than dozens.
        if (side > 0.3 && side < 0.9 && ahead > -1 && ahead < 4 && playerSpeed + n.v > 28) {
          nearPass = true;
          /* Closeness grade for the No Hesi scoring feed (see scoreEvents) —
             the SAME window as the detection above, just turned into a 0..1
             continuous read instead of a boolean: 0.3 m (the tightest this
             ever fires) grades 1, 0.9 m (the threshold) grades 0. Keep these
             two literals in lockstep with the ones in the condition above. */
          nearPassGrade = clamp(1 - (side - 0.3) / (0.9 - 0.3), 0, 1);
        }
      } else if (n.hw && !n.rival && (n.nudgeCur !== 0 || n.nudgeDwell !== 0)) {
        /* player is on another deck: nothing can be crowding this car, but a
           nudge already committed still has to release and ease back rather
           than stick. `ahead` far outside every trigger window does exactly
           that through the same path. */
        this.nudgeUpdate(n, dt, now, 1e9, 1e9, 0, 0);
      }
      // white-lining (see the WLINE block) — unrelated to the player, so it
      // runs regardless of which branch above fired. Mainline traffic only.
      if (n.hw && !n.rival && n.route === -1) this.wlineUpdate(n, dt);

      if (n.rival) this.updateRival(n, dt, player, playerSpeed, panic);
      else if (n.hw && n.route === BYPASS_EDGE) this.updateBypass(n, dt, v0, lead, panic);
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
      /* No Hesi scoring feed — same near-miss read as the close-call audio
         above, independent cooldown (see globalScoreCd). Not gated on
         CLOSE_CALL_AUDIO: the feature this machinery was kept for. */
      if (nearPass && n.scoreCd <= 0 && this.globalScoreCd <= 0) {
        n.scoreCd = NEARMISS.npcCd;
        this.globalScoreCd = NEARMISS.globalCd;
        this._scoreGrades.push(nearPassGrade);
      }

      /* smooth heading + place */
      if (n.hw) this.placeHwy(n, player.z);
      else this.placeTown(n);
      let targetH: number;
      if (n.hw && n.route === BYPASS_EDGE) {
        targetH = this.routes.bypass.poseAt(n.s, this.bpose).h;
      } else if (n.hw) {
        // the rival points where it is actually going, slide included
        targetH = n.rival ? this.riv.hTarget : this.cor.pose(n.s, this.cpose).h;
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

    /* Horn/flash gestures — see the HAIL block. Turned into discrete gestures
       here: the rising edge of the horn, plus a re-arm every holdRearm seconds
       while it stays down (leaning on it is insistent, but it is still not one
       gesture per frame), and the one-frame flash pulse the engine hands over.

       Deliberately AFTER the driving pass rather than before it: the gap this
       reads to decide whether a car could even speed up (`pLead.ds`) is then
       this frame's rather than last frame's, and an annoyed horn-back set here
       survives the per-frame `n.ccKind = null` reset that pass does. The
       reaction itself lands on the next frame's driving, 16 ms later. */
    this.hornT = hornHeld ? this.hornT + dt : 0;
    const honked = hornHeld && (!this.hornPrev || this.hornT >= HAIL.holdRearm);
    if (honked) this.hornT = 0;
    this.hornPrev = hornHeld;
    if (honked || flashed) this.hailGesture(player, now, cfx, cfz);

    /* overlap resolution between NPCs sharing a lane (cheap, one pass) */
    for (let a = 0; a < this.npcs.length; a++) {
      const A = this.npcs[a];
      // exemption #3 of 3: the resolver is the last thing that would stop the
      // rival sharing road with traffic, and sharing road IS the mechanic
      if (!A.active || A.wreck || A.rival) continue;
      for (let b = a + 1; b < this.npcs.length; b++) {
        const B = this.npcs[b];
        if (!B.active || B.wreck || B.rival) continue;
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

    /* LAYER 3, for real this time: after every car in the fleet has moved, so
       the positions it resolves against are final. Only the rival is moved
       (see rivalSeparate), and its position is rebuilt afterwards because the
       resolution can change both s and offCur. `offPrev` is recorded here so
       the heading never reads a depenetration as lateral velocity. */
    if (this.rival && this.rival.active && !this.rival.wreck) {
      const rv = this.rival;
      this.rivalSeparate(rv);
      this.riv.offPrev = rv.offCur;
      this.placeHwy(rv, player.z);
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
    /* Brake-lamp switch. -1.2 m/s^2 meant the lamps stayed dark through most
       of what the car-following model actually does: a real brake switch
       trips on a pedal touch, well under 0.3. The IDM underneath already
       produces a deceleration ripple back through a platoon — this is what
       lets the player SEE it, and red blooming down the line of cars ahead
       is the most legible thing in the dashcam frame.

       Hysteresis (trip at -0.35, release at -0.12) rather than one
       threshold, because a single edge sits inside the noise of the
       following model and the lamps would strobe on a steady cruise.
       `n.brake` is persistent per-NPC state, so it doubles as the latch. */
    n.brake = acc < (n.brake ? -0.12 : -0.35);
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
      only cars on the same route are compared, so the two spaces never mix.
      `back`/`fwd` are required CLEAR-ROAD gaps (bumper to bumper — the two
      half-lengths are added per pair, so a bus needs more room than a
      compact): comfort changes keep the roomy default, a zipper merge into a
      closing taper passes a tighter, speed-scaled pair (see updateHwy).
      Both ends also stretch with CLOSING SPEED: a static box calls a gap
      fine even when the car behind it is arriving 8 m/s faster and will be
      on the merger's bumper before the crossing finishes — which was one of
      the ways the old taper merges ended in overlapping bodies (the sim in
      test/traffic-merge-sim.mjs steps all of this headlessly). */
  private laneClearAt(
    n: Npc, s: number, off2: number, route = n.route, back = 13.5, fwd = 23.5,
    backC = 3.0, fwdC = 2.0
  ): boolean {
    const cor = this.cor;
    for (const m of this.npcs) {
      if (m === n || !m.active || !m.hw || m.wreck) continue;
      // exemption #2 of 3: nobody gap-checks against the rival either, or a
      // lane it is about to be nowhere near stays vetoed for seconds
      if (m.rival) continue;
      if (m.route !== route) continue;
      if (Math.abs(m.offCur - off2) > 2.2) continue;
      const ds = route === BYPASS_EDGE ? m.s - s : cor.deltaZ(s, m.s);
      const halfL = (m.L + n.L) / 2;
      // backC s of rear closing (3.0 by default): a lane change exposes the
      // merger for several seconds (signal + crossing), and a rear car keeps
      // its speed for most of that before it can see, react and brake. An
      // URGENT zipper merge passes smaller backC/fwdC: the crossing is brisk
      // (~1 s) and target-lane followers already yield to the blinker/lean,
      // so the full 3 s term only deadlocks a slowed merger behind gaps it
      // could safely take — which is what jammed the shrink solid.
      const backNeed = halfL + back + backC * Math.max(0, m.v - n.v);
      const fwdNeed = halfL + fwd + fwdC * Math.max(0, n.v - m.v);
      if (ds > -backNeed && ds < fwdNeed) return false;
    }
    /* The PLAYER is a hard no-go for every lane change: never begin a merge
       into road they occupy or are about to. The envelope is NOT tightened
       by zipper urgency and keeps the full closing-speed terms — an NPC
       blocked by a side-by-side player takes the existing yield path
       (mergeCap / lean / stopDs) and slots in behind once clear, so this
       cannot deadlock the taper. */
    const ps = this.playerSlot;
    const pByp = route === BYPASS_EDGE;
    if (pByp ? ps.by : ps.cor) {
      const pOff = pByp ? ps.byLat : ps.off;
      if (Math.abs(pOff - off2) < 2.2) {
        const ds = pByp ? ps.byS - s : cor.deltaZ(s, ps.s);
        const halfL = (4.5 + n.L) / 2; // player body ~4.5 m long
        const backNeed = halfL + 6 + 3.0 * Math.max(0, ps.v - n.v);
        const fwdNeed = halfL + 9 + 2.0 * Math.max(0, n.v - ps.v);
        if (ds > -backNeed && ds < fwdNeed) return false;
      }
    }
    return true;
  }

  /** clamp(drv.bias) for the bypass's constant-pitch lanes */
  private biasAtBypass(n: Npc): number {
    const m = Math.max(0, BYPASS.laneW / 2 - n.W / 2 - 0.25);
    return clamp(n.drv.bias, -m, m);
  }

  /* ---------------- horn / headlight-flash reactions ---------------- */

  /** Lane offset of lane `k` in whichever route `n` is driving. */
  private laneOffOf(n: Npc, k: number) {
    return n.route === BYPASS_EDGE
      ? this.routes.bypass.laneOffset(k, n.s)
      : this.cor.laneOffset(k, n.s);
  }

  /** One gesture from the player — one honk or one flash. Picks the single car
      it was plausibly aimed at and rolls that car's dice; the model itself is
      documented at HAIL.

      Exactly ONE car reacts per gesture, and it is the nearest one roughly in
      front, with lateral distance weighted heavily so the car in your own lane
      beats a slightly nearer one a lane over. A flash must not part the whole
      sea: the player has to be able to say "*that* car moved because I flashed
      at it", and they cannot if three of them stir at once. Honking at nothing
      finds no target and does nothing at all. */
  private hailGesture(player: CarState, now: number, pfx: number, pfz: number) {
    let best: Npc | null = null;
    let bestScore = Infinity;
    /* How far the gesture carries THIS frame — see HAIL.reachT. It is the
       player's own speed that decides what counts as close, so honking from
       a long way back is inert at every speed the player can honk from. */
    const reach = clamp(Math.abs(player.u) * HAIL.reachT, HAIL.nearAlways, HAIL.far);
    for (const n of this.npcs) {
      /* hailDone is deliberately NOT filtered here — a driver who has already
         had their say still absorbs the gesture aimed at them. Skipping them
         would hand the flash to whatever car happened to be next in the
         window, which from the dashcam reads as the wrong car reacting. */
      if (!n.active || n.wreck || !n.hw) continue;
      /* The rival is not a candidate at all. Its yieldMax is 0 so it could
         never comply anyway, but a car in the 35-70 m band sits right inside
         HAIL's window and would absorb every gesture aimed past it — and from
         the dashcam that reads as the flash doing nothing rather than as the
         rival ignoring you. */
      if (n.rival) continue;
      // same road level: the deck runs over town streets, and you cannot flash
      // at something on a different deck through the windshield
      if (Math.abs(player.y - n.y) > 3) continue;
      const dx = n.x - player.x, dz = n.z - player.z;
      /* Measured against the car's own nose, NOT the camera: the camera can be
         looking backwards (lookBack) or off to a chase pod, and neither
         changes which car your headlights are actually pointed at. */
      const ahead = dx * pfx + dz * pfz;
      if (ahead < HAIL.near || ahead > reach) continue;
      const side = Math.abs(dx * pfz - dz * pfx);
      if (side > HAIL.side) continue;
      const score = ahead + side * 8;
      if (score < bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best) this.hailRoll(best, player, now);
  }

  /** The lane a hailed car would move over into, or −1 if there isn't one.

      Courtesy is moving toward the kerb (lane 0), never out into the faster
      lane: a car that pulls out to "let you past" has merely swapped places
      with you. So there is exactly one candidate, and a car already in the
      kerb lane has nowhere courteous to go and picks its pace up instead —
      which is also what happens on a real road. */
  private yieldLane(n: Npc, pOff: number): number {
    if (n.pendK >= 0 || n.blink !== 0 || n.laneK <= 0) return -1;
    const k2 = n.laneK - 1;
    const off2 = this.laneOffOf(n, k2);
    /* The URGENT gap envelope, exactly as yieldToRival takes it and for
       exactly the same reason: a driver who has decided to get out of your
       way takes a gap they would not take casually. With the comfortable
       envelope this is not a preference for moving over, it is a preference
       that almost never survives contact with traffic — measured over 212
       hailed cars, 55 of 56 speed-ups were "boxed in" rather than chosen, and
       only 6 cars in the whole run actually moved. That reads as the car
       ignoring the lane it plainly has.

       The player stays a hard no-go regardless: laneClearAt keeps its full
       closing-speed terms for them whatever envelope it is passed, so nothing
       here can shove a yielding car into the person doing the honking. */
    if (!this.laneClearAt(n, n.s, off2, n.route, 1.2 + 0.25 * n.v, 2.5 + 0.35 * n.v))
      return -1;
    /* …and never merge onto the player. laneClearAt() only knows about other
       NPCs, and the one vehicle guaranteed to be near this car is the one
       doing the flashing — 2.2 m is the same lane-danger half-width it uses. */
    if (Math.abs(pOff - off2) < 2.2) return -1;
    return k2;
  }

  /** Roll one car's dice for one gesture and apply whatever it decides. */
  private hailRoll(n: Npc, player: CarState, now: number) {
    if (n.hailDone) return; // complied, or snapped — this driver is finished
    if (now - n.hailAt < HAIL.cd) return; // mashing the key can't mash the dice

    /* What could this car even do about it? Settled BEFORE anything is spent,
       so a driver who is boxed in with nowhere to go and no room to accelerate
       simply never hears you: no roll, no gesture counted, no pressure banked.
       A car that "complied" by merging into a wall would read as the feature
       being broken, and quietly spending its one-time goodwill on a manoeuvre
       it cannot perform would be worse than doing nothing. */
    const nfx = Math.sin(n.hVis), nfz = Math.cos(n.hVis);
    /* The player's lateral position in this car's own lane-offset space. The
       corridor normal and the car's right vector agree to well inside a lane
       width at these bend radii, so the offset transfers directly and no
       route projection is needed — and this works unchanged on the bypass. */
    const pOff = n.offCur + ((player.x - n.x) * nfz - (player.z - n.z) * nfx);
    const over = this.yieldLane(n, pOff);
    const canSpeed = n.pLead.ds > 22 && n.v < n.v0 * 1.15;
    if (over < 0 && !canSpeed) return;

    /* Insistence decays against the clock, lazily — this runs a few times a
       minute at most, so there is no reason to touch it every frame. */
    n.hailP = n.hailP * Math.exp(-(now - n.hailAt) / HAIL.tau) + 1;
    n.hailAt = now;
    const k = ++n.hailGest;

    /* q(k): the conditional roll that walks the cumulative curve
       C(k) = ceiling · (1 − e^(−k/K)) exactly, so the asymptote is the
       ceiling and nothing else. See the HAIL block for the derivation. */
    const A = n.drv.yieldMax;
    const cPrev = A * (1 - Math.exp(-(k - 1) / HAIL.K));
    const q = (A * (1 - Math.exp(-k / HAIL.K)) - cPrev) / (1 - cPrev);
    /* Insistence scales q DOWN only (wMin ≤ w ≤ 1), so it can make a lone
       flash weaker but can never lift a driver past their ceiling. */
    const w = HAIL.wMin + ((1 - HAIL.wMin) * Math.min(n.hailP, HAIL.pFull)) / HAIL.pFull;

    if (this.rng() < q * w) {
      n.hailDone = true; // they gave you what they had; that's the end of it
      /* Which of the two they do. A car with nowhere to go has no choice, and
         neither has one that cannot pick its pace up; only when BOTH are open
         is there a coin to flip, and then it lands on moving over moveP of the
         time — so the same car in the same gap does not always answer the
         same way. */
      if (over >= 0 && (!canSpeed || this.rng() < HAIL.moveP)) {
        /* Move over — through the ordinary signalled lane-change path, so the
           blinker runs for a beat first and the car eases across at its own
           rate. A courtesy move that snapped sideways would read as a glitch,
           and the blinker is the cue that sells the whole thing from the
           dashcam: amber, then the car drifts out of your way. */
        const off2 = this.laneOffOf(n, over);
        const pitch = n.route === BYPASS_EDGE ? BYPASS.laneW : this.cor.lanePitch(n.s);
        n.pendK = over;
        n.blink = off2 < n.offCur ? -1 : 1;
        n.blinkT = rand(0.5, 0.9); // brisker than a comfort change — they mean it
        n.laneRate = pitch / lerp(3.2, 2, n.drv.lane);
        n.turnCd = Math.max(n.turnCd, HAIL.yieldHold);
      } else {
        /* Speed up. The gap opening is the honest cue but takes a second to
           read, so blip the hazards first: two flashes of both sides is the
           real-world "yeah, yeah, going" and is unmistakable through the
           windshield, day or night. */
        n.nudgeT = HAIL.boostT;
        n.hailAck = HAIL.ackT;
      }
      return;
    }

    /* Refused — and if you keep leaning on a driver who was never going to
       move, they may eventually snap. The curve is flat by annoyAfter, so
       these gestures were buying the player nothing anyway; all that is left
       is rudeness, and a road where that is free is a duller road than one
       where it occasionally costs you. Kept fair on purpose: only drivers who
       had already all but refused take offence, and the answer is a readable
       brake-tap in front of you, never a swerve into your lane — that would be
       a crash the player could not have seen coming, which is not a fair
       answer to pressing a button. */
    if (k >= HAIL.annoyAfter && A < HAIL.annoyCeil && this.rng() < HAIL.annoyP) {
      n.hailMad = HAIL.annoyT;
      n.hailDone = true; // whatever goodwill was left is now gone for good
      if (HAIL.annoyHorn && n.ccCd <= 0 && this.globalCcCd <= 0) {
        n.ccKind = "horn";
        n.ccCd = 10 + rand(0, 3);
        this.globalCcCd = Traffic.CC_GLOBAL_GAP;
      }
    }
  }

  /* ---------------- courtesy nudge (see the NUDGE block) ----------------
     One call per active NPC per frame, from update()'s player-obstacle pass.
     `ahead`/`side` are the player's position in this car's own frame, already
     computed there. Everything here is arithmetic on state this car already
     carries — no searches, and the one clearance query only runs on the frame
     a roll actually succeeds. */
  private nudgeUpdate(n: Npc, dt: number, now: number, ahead: number, side: number,
    pSide: number, playerSpeed: number) {
    /* 1. is the player crowding this car, and how? Tailgating is measured
          from the tail, threading from the flank. */
    let kind = 0;
    if (playerSpeed > NUDGE.minSpeed && !n.wreck) {
      const back = -ahead - n.L / 2; // metres from the NPC's tail, +ve behind
      if (back > 0 && back < NUDGE.tailGap && side < NUDGE.tailSide) kind = 1;
      else if (
        Math.abs(ahead) < NUDGE.threadLong &&
        side > NUDGE.threadSideLo && side < NUDGE.threadSideHi
      ) kind = 2;
    }

    /* 2. dwell. `grace` lets the clock survive a momentary wobble in the
          player's line rather than restarting the whole approach. */
    if (kind !== 0) {
      if (kind !== n.nudgeKind) n.nudgeDwell = 0;
      n.nudgeKind = kind;
      n.nudgeDwell += dt;
      n.nudgeHold = NUDGE.hold;
    } else {
      n.nudgeDwell -= dt / NUDGE.grace;
      if (n.nudgeDwell <= 0) {
        n.nudgeDwell = 0;
        n.nudgeKind = 0;
      }
      n.nudgeHold = Math.max(0, n.nudgeHold - dt);
    }

    /* 3. roll, at most once per cd of unbroken crowding. Gated on hailDone so
          this never stacks with a horn/flash yield, and on the car actually
          holding its lane — a car mid-manoeuvre has enough going on. */
    if (
      kind !== 0 && n.nudgeLat === 0 && !n.hailDone && n.pendK < 0 &&
      n.blink === 0 && n.mergeLean === 0 &&
      n.nudgeDwell >= NUDGE.dwell && now - n.nudgeRollAt >= NUDGE.cd
    ) {
      n.nudgeRollAt = now;
      const k = ++n.nudgeGest;
      /* identical conditional to hailRoll's, against a ceiling scaled down
         from this driver's horn/flash ceiling — see the NUDGE block */
      const A = n.drv.yieldMax * NUDGE.ceilScale;
      const cPrev = A * (1 - Math.exp(-(k - 1) / NUDGE.K));
      const q = (A * (1 - Math.exp(-k / NUDGE.K)) - cPrev) / (1 - cPrev);
      if (this.rng() < q) {
        /* Move AWAY from the player's side of the car. On a tailgate the
           player is in line, so pSide's sign is weak — fall back to the kerb
           side (−lat), which is where a real driver drifts to wave you past. */
        const away = kind === 2 ? (pSide > 0 ? -1 : 1) : (pSide > 0.35 ? -1 : pSide < -0.35 ? 1 : -1);
        /* Never edge into somebody. Same lane-danger half-width laneClearAt
           uses, probed on the side we are about to lean toward; if that side
           is occupied the car simply doesn't move, which is the right answer.
           maxBias/biasAtBypass then keep the body inside its own lane line. */
        const lim = n.route === BYPASS_EDGE
          ? Math.max(0, BYPASS.laneW / 2 - n.W / 2 - 0.25)
          : this.maxBias(n, n.s);
        const want = away * Math.min(NUDGE.off, lim);
        if (want !== 0 &&
          this.laneClearAt(n, n.s, n.offCur + away * NUDGE.probe))
          n.nudgeLat = want;
      }
    }

    /* 4. release once the hold expires, then ease. The eased `nudgeCur` is
          what folds into offT in updateHwy/updateBypass — this never touches
          offCur directly, so the lane-keeping controller stays in charge. */
    if (n.nudgeLat !== 0 && n.nudgeHold <= 0) n.nudgeLat = 0;
    const dn = n.nudgeLat - n.nudgeCur;
    if (Math.abs(dn) > 0.005) n.nudgeCur += clamp(dn, -NUDGE.rate * dt, NUDGE.rate * dt);
    else n.nudgeCur = n.nudgeLat;
  }

  /** A deterministic per-pair roll — see the WLINE block for why this needs
      no shared state: both cars in a pair compute the identical result from
      their own two pool ids plus a coarse bucket of where the pair formed. */
  private wlinePairRoll(n: Npc, p: Npc): { open: boolean; gap: number } {
    const lo = Math.min(n.id, p.id), hi = Math.max(n.id, p.id);
    const bucket = Math.round(n.s / 25);
    const seed = (lo * 2654435761 + hi * 40503 + bucket * 97) >>> 0;
    const rnd = mulberry32(seed);
    const open = rnd() < WLINE.openChance;
    // average two draws so the width leans toward the middle of the band
    // rather than sitting flat across it — "sometimes wide, sometimes
    // narrow" per the owner's spec, not uniformly either
    const gap = lerp(WLINE.gapLo, WLINE.gapHi, (rnd() + rnd()) / 2);
    return { open, gap };
  }

  /** Does `n` still ride alongside `p` right now — same lane gap, similar
      speed, still both real traffic? O(1); the O(N) search only runs when
      a car has no partner at all (see wlineUpdate). */
  private wlinePaired(n: Npc, p: Npc | null): boolean {
    if (!p || !p.active || !p.hw || p.rival || p.wreck || p.route !== -1) return false;
    // mid lane-change/merge on either side — not a stable pair to drift as
    if (p.blink !== 0 || p.pendK >= 0 || p.mergeLean !== 0) return false;
    if (n.blink !== 0 || n.pendK >= 0 || n.mergeLean !== 0) return false;
    if (n.v < WLINE.minSpeed || p.v < WLINE.minSpeed) return false;
    if (Math.abs(p.v - n.v) > WLINE.dv) return false;
    if (Math.abs(this.cor.deltaZ(n.s, p.s)) > WLINE.sFrac * (n.L + p.L) / 2)
      return false;
    // adjacent lanes only — same lane is a leader/follower, not a pair
    const dLane = Math.abs(this.nearestLane(p.s, p.offCur) - this.nearestLane(n.s, n.offCur));
    return dLane === 1;
  }

  /** White-lining (see the WLINE block). One call per active mainline NPC
      per frame, from update()'s player-obstacle pass — unconditionally,
      since this has nothing to do with where the player is. */
  private wlineUpdate(n: Npc, dt: number) {
    const cor = this.cor;
    /* Suspended inside the rival's yield corridor — the same window
       yieldToRival itself reads, plus a margin, so a car does not open a
       gap for the player and then have the rival want that exact space a
       moment later. Reset outright rather than merely held: re-pairing
       fresh once clear reads better than resuming a stale drift. */
    const r = this.rival;
    if (r && r.active && !r.wreck) {
      const behind = cor.deltaZ(r.s, n.s);
      if (behind > -20 && behind < RIVAL.yieldSee &&
        Math.abs(r.offCur - n.offCur) < RIVAL.yieldLat + 3) {
        n.wlPartner = null;
        n.wlDwell = 0;
        n.wlRolled = false;
        n.wlLat = 0;
        const dw = n.wlLat - n.wlCur;
        if (Math.abs(dw) > 0.004) n.wlCur += clamp(dw, -WLINE.rate * dt, WLINE.rate * dt);
        else n.wlCur = n.wlLat;
        return;
      }
    }
    let p = this.wlinePaired(n, n.wlPartner) ? n.wlPartner : null;
    if (!p) {
      n.wlT -= dt;
      if (n.wlT <= 0) {
        n.wlT = WLINE.scanEvery + this.rng() * WLINE.scanJitter;
        let bestDs = Infinity;
        for (const m of this.npcs) {
          if (m === n || !m.active || !m.hw) continue;
          if (!this.wlinePaired(n, m)) continue;
          const ds = Math.abs(cor.deltaZ(n.s, m.s));
          if (ds < bestDs) { bestDs = ds; p = m; }
        }
      }
    }
    if (p !== n.wlPartner) {
      n.wlPartner = p;
      n.wlDwell = 0;
      n.wlRolled = false;
    }
    if (!p) {
      n.wlDwell = 0;
      n.wlLat = 0;
    } else {
      n.wlDwell += dt;
      if (!n.wlRolled && n.wlDwell >= WLINE.dwell) {
        n.wlRolled = true;
        const roll = this.wlinePairRoll(n, p);
        n.wlOpen = roll.open;
        n.wlGap = roll.gap;
      }
      if (n.wlOpen && n.wlDwell >= WLINE.dwell) {
        const away = Math.sign(n.offCur - p.offCur) || 1;
        /* 3+ abreast: if this car ALSO has a qualifying neighbour on the far
           side (the side it would be easing TOWARD), it is the middle car of
           the group and stays put — easing would drive it into that third
           car rather than open anything. */
        let middled = false;
        for (const m of this.npcs) {
          if (m === n || m === p || !m.active || !m.hw) continue;
          if (Math.sign(m.offCur - n.offCur) !== away) continue;
          if (this.wlinePaired(n, m)) { middled = true; break; }
        }
        const want = middled ? 0
          : clamp(away * n.wlGap, -this.maxBias(n, n.s), this.maxBias(n, n.s));
        n.wlLat = want !== 0 && this.laneClearAt(n, n.s, n.offCur + away * WLINE.probe)
          ? want : 0;
      } else {
        n.wlLat = 0;
      }
    }
    const dw = n.wlLat - n.wlCur;
    if (Math.abs(dw) > 0.004) n.wlCur += clamp(dw, -WLINE.rate * dt, WLINE.rate * dt);
    else n.wlCur = n.wlLat;
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
       lookahead many seconds up the road (a multi-lane fan-in needs to start
       several lane changes early enough to chain them), signalled and
       gradual, same as any other lane change, so a taper never reads as a
       sideways teleport. Re-triggers on its own once each pendK clears, so a
       multi-lane drop chains through consecutive single-lane merges rather
       than waiting for the whole taper.

       When the target lane has no gap the driver YIELDS instead of holding
       speed until the pavement runs out: a gentle lift far from the taper,
       a real brake once the lane is due to vanish within a few seconds —
       braking is what opens a slot behind the through-lane car alongside,
       which is the zipper. Close to the end the gap acceptance also tightens
       (still clear of both bumpers) the way real forced merges do. `mergeCap`
       carries the yield deceleration into the IDM result below.

       Gated on blink === 0 as well as pendK: a chained multi-lane drop must
       finish (settle) one crossing before accepting the next, or the second
       hop re-targets offT mid-drift and the car cuts a continuous diagonal
       across an intermediate lane nobody gap-checked. A car whose blinker is
       on because it is lean-waiting (mergeLean) is re-admitted — that IS the
       pending forced merge, not a crossing in progress. */
    let mergeCap = Infinity;
    let stopDs = -1; // ≥0: virtual stopped leader this far ahead (lane end)
    const wasLean = n.mergeLean !== 0;
    n.mergeLean = 0;
    if (n.pendK < 0 && (n.blink === 0 || wasLean) && n.laneK <= nl - 1 && n.laneK > 0) {
      const aheadZ = cor.wrapZ(n.s + clamp(n.v, 15, 32) * 9);
      const nlAhead = cor.lanes(aheadZ);
      if (n.laneK > nlAhead - 1) {
        /* ONE lane per hop, always — never min(laneK−1, nlAhead−1): across a
           multi-step drop that shortcut targets a lane two over and the car
           cuts a continuous diagonal through the lane between, which was
           never gap-checked. The chain re-triggers after this hop settles. */
        const k2 = n.laneK - 1;
        const off2 = cor.laneOffset(k2, n.s);
        {
          // lane gone within ~3 s of travel → zipper urgency
          const urgent =
            cor.lanes(cor.wrapZ(n.s + Math.max(n.v, 8) * 3)) - 1 < n.laneK;
          /* the urgent gap requirement scales with speed: at 25 m/s it wants
             ~8 m of clear road behind and ~11 ahead, at a jam crawl a real
             zipper takes a slot with a couple of metres to spare */
          const clear = urgent
            ? this.laneClearAt(
                n, n.s, off2, n.route, 1.2 + 0.25 * n.v, 2.5 + 0.35 * n.v)
            : /* forced-but-not-yet-urgent: commit EARLIER than a comfort
                 change would — a normal IDM headway gap upstream, taken at
                 speed, beats waiting to zipper at the taper end (closing
                 terms stay at full strength, so nobody gets braked on) */
              this.laneClearAt(n, n.s, off2, n.route, 9, 16);
          if (clear) {
            /* brisk when urgent AND when merging from a crawl: a stopped car
               pulling into a gap takes it in one motion — a leisurely 4 s
               signal-and-drift from standstill leaves the accepted gap a
               whole highway-speed approach window in which to rot */
            const brisk = urgent || n.v < 15;
            n.pendK = k2;
            n.blink = off2 < n.offCur ? -1 : 1;
            n.blinkT = brisk ? rand(0.2, 0.5) : rand(1, 2);
            // the local lane pitch, not the nominal LANE_W — the toll plaza
            // spreads lanes to ~6m, and a lane change there still needs to
            // take 2-4s rather than crossing the wider gap at the same speed.
            // An urgent zipper slot is taken briskly (the emergency rate):
            // a leisurely 2-4 s drift leaves the accepted gap time to close
            // under the car mid-crossing.
            n.laneRate = brisk
              ? cor.lanePitch(n.s) / 1.4
              : cor.lanePitch(n.s) / lerp(3, 2, drv.lane); // merges run a touch brisker than a comfort change
            n.turnCd = Math.max(n.turnCd, 2);
          } else {
            /* blocked: yield. The non-urgent lift is deliberately light
               (-0.35, was -0.9) — a firm pre-brake this far out drops the
               whole doomed lane below stream speed, the closing-speed term
               then rejects every gap the slowed cars are offered, and the
               feedback jams the shrink solid (seeds 99/2026 in the sim). */
            mergeCap = urgent ? -2.6 : -0.35;
            if (urgent) {
              /* No slot: lean to the lane edge, blinker on, and wait. The
                 body stays inside its own lane (maxBias + 0.2 puts the flank
                 ~5 cm short of the line), but the lean carries the car into
                 the widened perception window below, so target-lane
                 followers adopt it as a leader and hold back — which is what
                 actually opens the zipper gap in packed traffic. */
              n.mergeLean =
                (off2 < n.offCur ? -1 : 1) * (this.maxBias(n, n.s) + 0.2);
              n.blink = off2 < n.offCur ? -1 : 1;
              n.laneRate = Math.max(n.laneRate, LANE_FOLLOW_RATE);
              /* Still no slot and the pavement is running out: place a
                 VIRTUAL STOPPED LEADER a few metres short of where lanes()
                 says this lane ends (bisection — a handful of arithmetic
                 lanes() calls, only for a blocked urgent merger) and let IDM
                 brake to it, exactly the way town cars stop for a red. A
                 fixed decel cap can't do this: capping at some −v·k decays
                 with v and delivers the car to the taper end still moving,
                 and the snap net then slides its body across into an
                 occupied lane — which is exactly the pileup glitch. A car
                 that WAITS at the end of a closing lane zippers in cleanly
                 as soon as the yielding follower alongside leaves it room. */
              let lo = 0, hi = Math.max(n.v, 4) * 3;
              if (cor.lanes(cor.wrapZ(n.s + hi)) - 1 < n.laneK) {
                for (let i = 0; i < 5; i++) {
                  const mid = (lo + hi) / 2;
                  if (cor.lanes(cor.wrapZ(n.s + mid)) - 1 < n.laneK) hi = mid;
                  else lo = mid;
                }
                stopDs = Math.max(0.3, lo - 6);
              }
            }
          }
        }
      }
    }
    /* Hard safety net: the lane is physically gone right under them (blocked
       merge, or a driver that never got a clear gap in time) — snap the lane
       index so later math stays in range, but still signal it and still ease
       the visible offset over via offCur/offT below, just at the brisker
       emergency rate, rather than teleporting. Brake hard while forcing the
       entry so the overlap resolver has a slow car to absorb, not a fast one. */
    if (n.laneK > nl - 1) {
      const k2 = Math.max(0, nl - 1);
      const off2 = cor.laneOffset(k2, n.s);
      n.blink = off2 < n.offCur ? -1 : 1;
      n.laneRate = Math.max(n.laneRate, cor.lanePitch(n.s) / 1.4);
      n.laneK = k2;
      n.pendK = -1;
      mergeCap = Math.min(mergeCap, -2.6);
    }

    // the blocked merger's stop-at-the-taper-end target, as an IDM leader
    if (stopDs >= 0 && (!lead || stopDs < lead.ds)) {
      this._stop.ds = stopDs;
      this._stop.v = 0;
      lead = this._stop;
    }

    const aMax = 1.6 * drv.acc, bCom = 2.3, T = 1.25 * drv.gap, s0 = 2.2 + 1.4 * (drv.gap - 1);
    let acc: number;
    if (lead) {
      const dv = n.v - lead.v;
      const sStar = s0 + n.v * T + (n.v * dv) / (2 * Math.sqrt(aMax * bCom));
      acc = aMax * (1 - Math.pow(n.v / v0, 4) - Math.pow(sStar / Math.max(lead.ds, 0.55), 2));
    } else acc = aMax * (1 - Math.pow(n.v / v0, 4));
    if (mergeCap < Infinity) acc = Math.min(acc, mergeCap); // blocked taper: yield
    if (panic) acc = Math.min(acc, -6.5);
    acc = clamp(acc, -8.5, 3.2);
    /* Brake-lamp switch. -1.2 m/s^2 meant the lamps stayed dark through most
       of what the car-following model actually does: a real brake switch
       trips on a pedal touch, well under 0.3. The IDM underneath already
       produces a deceleration ripple back through a platoon — this is what
       lets the player SEE it, and red blooming down the line of cars ahead
       is the most legible thing in the dashcam frame.

       Hysteresis (trip at -0.35, release at -0.12) rather than one
       threshold, because a single edge sits inside the noise of the
       following model and the lamps would strobe on a steady cruise.
       `n.brake` is persistent per-NPC state, so it doubles as the latch. */
    n.brake = acc < (n.brake ? -0.12 : -0.35);
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

    /* Something quick is filling this driver's mirror — see the yield block.
       Checked before the ordinary voluntary change so it takes precedence: it
       commits pendK, and the `n.pendK < 0` guard below then keeps the
       voluntary logic out of the way. Deliberately NOT an early return — the
       pre-signal delay and the offset tracking further down are what actually
       perform the move, so returning here would leave the car signalling a
       lane change it never made. It exits immediately when the rival is not a
       factor, which is every frame of every game with the mode off. */
    if (this.rival) this.yieldToRival(n);

    n.turnCd -= dt;
    /* Lane change when stuck behind slower traffic — how long a driver puts up
       with it is their own business, and speeders weave for no reason at all.
       Restless odds 0.35 → 0.28/s and the cooldown band 12-3.5 → 15-4.5 s
       (here and in updateBypass): a ~20-25% trim of voluntary lane changes,
       per user call — a tuning nudge, not a behaviour change. */
    const held = !!lead && lead.ds < 18 + 30 * drv.lane && lead.v < n.v0 * (0.8 + 0.12 * drv.lane);
    const restless = drv.weave > 0 && (!lead || lead.ds > 30) && this.rng() < 0.28 * dt;
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
          n.turnCd = lerp(15, 4.5, drv.lane);
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
    // a lean-waiting car aims at its lane edge instead of centre + bias; the
    // blinker must not clear while the lean holds, or followers lose the
    // widened perception that makes them yield
    // the courtesy nudge and the white-lining ease both ride on top of the
    // driver's own bias, clamped together so none of the three can push the
    // body past its lane line; a lean-waiting car is already at its edge
    // and is left alone
    n.offT = cor.laneOffset(n.laneK, n.s) +
      (n.mergeLean !== 0 ? n.mergeLean
        : clamp(this.biasAt(n, n.s) + n.nudgeCur + n.wlCur,
          -this.maxBias(n, n.s), this.maxBias(n, n.s)));
    const dOff = n.offT - n.offCur;
    const rate = n.blink !== 0 ? n.laneRate || cor.lanePitch(n.s) / 3 : LANE_FOLLOW_RATE;
    if (Math.abs(dOff) > 0.02) {
      n.offCur += clamp(dOff, -rate * dt, rate * dt);
      if (n.blink !== 0 && n.pendK < 0 && n.mergeLean === 0 &&
        Math.abs(dOff) < 0.35 && n.wantBypass !== 1)
        n.blink = 0;
    } else {
      n.offCur = n.offT;
      if (n.blink !== 0 && n.pendK < 0 && n.mergeLean === 0 && n.wantBypass !== 1)
        n.blink = 0;
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
    /* Brake-lamp switch. -1.2 m/s^2 meant the lamps stayed dark through most
       of what the car-following model actually does: a real brake switch
       trips on a pedal touch, well under 0.3. The IDM underneath already
       produces a deceleration ripple back through a platoon — this is what
       lets the player SEE it, and red blooming down the line of cars ahead
       is the most legible thing in the dashcam frame.

       Hysteresis (trip at -0.35, release at -0.12) rather than one
       threshold, because a single edge sits inside the noise of the
       following model and the lamps would strobe on a steady cruise.
       `n.brake` is persistent per-NPC state, so it doubles as the latch. */
    n.brake = acc < (n.brake ? -0.12 : -0.35);
    n.v = Math.max(0, n.v + acc * dt);
    n.s = Math.min(by.len - 0.5, n.s + n.v * dt);

    n.turnCd -= dt;
    /* comfort lane change between the two lanes, clear of the merge run */
    const held = !!lead && lead.ds < 18 + 30 * drv.lane && lead.v < n.v0 * (0.8 + 0.12 * drv.lane);
    const restless = drv.weave > 0 && (!lead || lead.ds > 30) && this.rng() < 0.28 * dt;
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
        n.turnCd = lerp(15, 4.5, drv.lane);
      }
    }
    if (n.pendK >= 0) {
      n.blinkT -= dt;
      if (n.blinkT <= 0) {
        n.laneK = n.pendK;
        n.pendK = -1;
      }
    }
    // courtesy nudge on top of the driver's bias, clamped to the bypass's
    // constant-pitch lane the same way biasAtBypass is
    const byLim = Math.max(0, BYPASS.laneW / 2 - n.W / 2 - 0.25);
    n.offT = by.laneOffset(n.laneK, n.s) +
      clamp(this.biasAtBypass(n) + n.nudgeCur, -byLim, byLim);
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
    const CL = this.cloudList;
    /* Indicator blink phase. This used to be one global `now % 0.9`, which
       put every signalling car and every wreck's hazards in perfect lockstep
       — two cars indicating in exact sync is unmistakably synthetic, and it
       is the kind of thing the eye catches without knowing why. Offsetting by
       the driver's existing per-NPC jitter phase decorrelates them for free.
       The 1.11Hz rate itself is right and is unchanged; only the phase moves.
       Computed per car below rather than once here. */
    const blinkPhase = (jit: number) => (now + jit * 0.14) % 0.9 < 0.45;
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
        for (const cl of CL) {
          cl.arr[i * 2 * 3 + 1] = -999;
          cl.arr[(i * 2 + 1) * 3 + 1] = -999;
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
      /* Signals — both slots at once is a hazard flash: a wreck, or the
         two-blink acknowledgement a car gives when it takes a hint and speeds
         up rather than moving over (see HAIL.ackT). */
      const blinkOn = blinkPhase(n.drv.jit);
      if (wrecked || n.hailAck > 0) {
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
    for (const cl of CL) (cl.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.poolInst.count = pk;
    this.poolInst.visible = pk > 0;
    if (pk) {
      this.poolInst.instanceMatrix.needsUpdate = true;
      this.poolColor.needsUpdate = true;
    }
  }
}
