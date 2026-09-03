import * as THREE from "three";
import {
  roadTex, hwyTexF, rampTexF, windowsTexF, storefrontTexF, vendingTexF, glowTexF,
  streakTexF, smokeTexF, envFaceCanvas, chevTexF, goreTexF, xingTexF, studTexF,
  paintWearTexF,
  fenceTexF, grimeTexF, loadPbrSet, makeTex, type PbrSet,
} from "../textures";
import { worldTierCaps } from "../settings";
import { DEBUG_HOOKS } from "../debug";

/* Shared materials + textures. Planar-reflection sampling is injected into the
   road materials here (ported from v2, adapted to the linear HDR pipeline).

   ---------------------------------------------------------------------------
   Photo-scanned PBR
   ---------------------------------------------------------------------------
   Real scans under public/assets/pbr/<set>/{albedo,normal,rough,metal}.jpg are
   loaded asynchronously and layered on top of the procedural canvas art. If
   the files are absent every material stays exactly as it was, so the game is
   fully playable with an empty assets directory — the procedural path is both
   the fallback and the perf-mode path.

   Two different upgrade strategies are used, because the road textures are not
   interchangeable with a photo scan:

   - ROAD SURFACES keep their procedural albedo, because the lane markings are
     painted into it (town streets and ramps) and swapping in a photo would
     erase them. Instead the scan is applied as a *detail* layer multiplied
     over the procedural colour, normalised by the scan's own mean luminance so
     it contributes grain and grit without shifting the tuned brightness. The
     scan's normal and roughness maps are applied for real, on their own UV
     repeat, which is where most of the realism actually comes from.

   - CONCRETE AND METAL get the scan as a straight albedo replacement, since
     none of that art carries markings.

   The roughness map does double duty: it drives the wet-road reflection, so
   the smooth patches of a scan mirror the world back harder than the coarse
   aggregate around them. That is what reads as standing water. */

/* ======================================================================
   WET-ROAD REFLECTION — reflect the lights, not the sky
   ======================================================================

   The first attempt at this was a true planar mirror: engine.ts rendered the
   whole scene a second time from a camera mirrored through the road plane and
   the road sampled it by screen UV. It was correct and it looked wrong — the
   sky band and the skyline glow are big, dim, diffuse things, and at grazing
   angles a mirror hands them back as pale slabs lying across the deck. No
   output-side luminance gate killed it, so the strength was pinned to 0 and
   the second scene render went on being paid for every frame.

   The replacement starts from what a wet road at night actually does: it
   mirrors POINT sources — lamp heads, sign faces, tail lights — drawn out into
   vertical streaks by the surface roughness, separated by darkness. So the
   source is post.ts's bloom bright-pass, smeared vertically (post.ts
   REF_SPREAD). Its soft-knee threshold IS the gate: the night sky and its glow
   sit far below it and contribute nothing, while a lamp head survives. That is
   the whole fix — the exclusion happens at the source, where it is free, not
   at the output, where it never worked.

   The lookup is a reprojection rather than a screen-space flip. Reflect the
   camera->fragment ray about the deck, walk it to an assumed source height H,
   and project that point back to screen: exact for anything actually at H, and
   correct under any pitch, crest or bank, because the fragment's own world
   position supplies the plane. Two heights are sampled, because the two things
   worth reflecting live at very different ones. */
/** Low tap: tail lights and NPC head glow, ~0.9 m off the deck. Its reflection
    lands on the road at roughly 0.55x the source's distance, i.e. right under
    the car ahead — the red smear that sells a wet road more than anything. */
const REF_H_LO = 0.9;
/** High tap: lamp heads, gantry sign faces, lit windows. At c≈1.3 m eye height
    a 7 m source reflects at ~0.7x of the full mirror position, so this is also
    what keeps the streaks well clear of the horizon line. */
const REF_H_HI = 7.0;
/** Share of the low tap in the blend. Under half: lamps outnumber and outshine
    tail lights, and the low tap is the one that can graze the road's own
    headlight pool and feed back on itself. */
const REF_LO_W = 0.45;
/** Soft ceiling on the reflected colour, in pre-exposure linear. Applied as
    refC *= uRefMax/(uRefMax+luma) — an asymptote, not a clamp, so a brighter
    source keeps getting brighter by less and nothing ever reaches a hard stop.
    0.42 was picked against the grade, not by eye: at exposure 1.12 the worst
    case is ACES(0.47) ≈ 0.48 display, comfortably under the 0.72 blown-white
    clip and the ~0.8 where the composite's vibrance rolloff bleaches hue out.
    A sodium streak therefore stays orange at its hottest, which is the entire
    difference between this and the white patches that got the effect cut. */
const REF_MAX = 0.42;
/** Master gain, and the one edit that makes this effect a visual no-op.
    Set to 0 and the road is pixel-identical to the disabled version — uRefStr
    goes to 0, so the shader's uniform-valued branch is skipped and road
    fragments cost exactly what they did before this existed. The engine-side
    saving (the second scene render, deleted) is kept either way; all that is
    left running is post.ts's one quarter-res smear, which at ~0.05 ms is not
    worth a second switch to suppress. Also live at `__wetTune.gain`. */
const REF_GAIN = 1;

/* ======================================================================
   CONCRETE GRIT — the missing decimetre
   ======================================================================

   Every source of variation a parapet had was periodic in METRES. Measured,
   from the code that produces them:

     photo scan tile ...... 2.22 m, features 0.2-1.0 m, albedo sigma 2.7 %
     macro mottle ......... 11.3 m, second draw at 2.9 m
     rain-wash streaks .... 2.9 m along, and 23 m up (the 8:1 v stretch,
                            applied to a wall that is 1.05 m tall — so on a
                            parapet the "vertical streaks" are not streaks at
                            all, they are a slow longitudinal tone drift)
     contraction joints ... 4.6 m
     per-casting tone ..... 4.6 m

   There is nothing between about 1 cm and 20 cm. That band is exactly what
   the eye is looking at: from the dashcam the parapet is roughly 2 m away and
   about 1 m tall, so a 5 cm feature is ~23 screen pixels and a 2 cm feature is
   ~9. The wall was not short of texels — at 460 per metre it has more than the
   screen can resolve — it was short of anything to put in them. That is why it
   reads as "no detail", and why it is also why every stretch looks the same:
   the only things that differ between two stretches change over 3-11 m, so at
   speed they read as one slow brightness drift rather than as different wall.

   So this fills that band, procedurally, for 0 MB of assets. Everything in it
   is sized against the 3.32 mm texel this tiles at (512 px over 1.7 m of
   wall = 301 texels/m, which is inside the 1:1-to-2:1 window against the
   dashcam over the 2-6 m where the wall is actually legible):

     - cure and patch mottle at 15-35 cm, the single biggest contributor;
     - slipform chatter courses every ~15 cm, with a darker seam at each;
     - blowhole CLUSTERS. The individual holes are 3-8 mm and mip away by 4 m,
       which is the point: they are drawn in 4-10 cm clusters so what survives
       is the cluster, the way a real cast face is pocked in patches;
     - pits and small spalls, 1.5-5 cm, half darker (dirt-filled) and half
       lighter (fresh fracture exposing aggregate);
     - hairline cracks, 30-90 cm;
     - fine tooth at 0.8-2 cm, which does mip away, and should — it is there so
       the near field is not visibly smoother than the mid field.

   Three channels, one fetch:
     R  albedo modulation about 0.5
     G  relief height about 0.5, full swing = +/- GRIT_H metres
     B  a slower stain field at 0.5-1.2 m, filling the gap between this tile's
        35 cm ceiling and the macro field's 2.9 m floor

   Sampled by weatherSurface() off the same world-space wUV the rest of the
   weathering uses, so it costs no new varying and lands on the same axes. */

/** grit tile resolution, and the metres of wall one repeat covers */
const GRIT_N = 512, GRIT_M = 1.7;
/** full-swing relief encoded in the G channel, metres */
const GRIT_H = 0.008;

function gHash(x: number, y: number, seed: number) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
/** value noise on a WRAPPED lattice, so every octave tiles (see textures.ts) */
function gNoise(u: number, v: number, cells: number, seed: number) {
  const x = u * cells, y = v * cells;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const m = (n: number) => ((n % cells) + cells) % cells;
  const xa = m(x0), xb = m(x0 + 1), ya = m(y0), yb = m(y0 + 1);
  const a = gHash(xa, ya, seed), b = gHash(xb, ya, seed);
  const c = gHash(xa, yb, seed), d = gHash(xb, yb, seed);
  const t = a + (b - a) * sx;
  return t + (c + (d - c) * sx - t) * sy;
}
function gFbm(u: number, v: number, cells: number, oct: number, seed: number) {
  let sum = 0, amp = 1, norm = 0, c = cells;
  for (let i = 0; i < oct; i++) {
    sum += amp * gNoise(u, v, c, seed + i * 977);
    norm += amp;
    amp *= 0.5;
    c *= 2;
  }
  return sum / norm;
}

/** Build the grit atlas. Deterministic — same wall every session. */
function concreteGritTexF() {
  return makeTex(GRIT_N, GRIT_N, (ctx, w, h) => {
    const alb = new Float32Array(w * h);
    const hgt = new Float32Array(w * h); // metres
    const stain = new Float32Array(w * h);
    /** wrapped index, so every discrete feature below tiles for free */
    const at = (x: number, y: number) =>
      (((y % h) + h) % h) * w + (((x % w) + w) % w);

    // ---- fields: mottle, chatter courses, fine tooth, stain ----
    /* 1.7 m / 5 cells = 34 cm, and the second octave pair lands at 17 and
       8.5 cm — the whole point of this texture, so it carries the largest
       amplitude of anything here. */
    const COURSES = 11; // 1.7 m / 11 = 15.5 cm, an ordinary slipform course
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w, i = y * w + x;
        /* Three octave groups at 57, 19 and 4 cm. The middle one is the one
           that matters most and is deliberately the widest band: it is the
           scale a parapet is patchy at and the scale that was missing. */
        alb[i] = (gFbm(u, v, 3, 3, 17) - 0.5) * 0.30
          + (gFbm(u, v, 9, 2, 913) - 0.5) * 0.16
          + (gNoise(u, v, 48, 2211) - 0.5) * 0.07;
        stain[i] = gFbm(u, v, 2, 2, 5501);
        /* Dirt in PATCHES, not as a gradient. A real wall is not uniformly
           grubby and it is not smoothly shaded either — it is clean, then
           abruptly filthy for half a metre, then clean. The threshold is what
           buys that edge; a raw fbm would just tint everything slightly. */
        const g = gFbm(u, v, 4, 2, 771);
        const dirt = Math.max(0, (g - 0.52) / 0.34);
        alb[i] -= Math.min(1, dirt) * 0.22;
        /* Chatter. A slipform leaves a faint horizontal course line every
           board depth, and consecutive courses cure to slightly different
           tones. `wob` is large on purpose: a dead-straight ruled line across
           the whole wall is the one thing that would give the procedure away,
           and it was the first thing visible when this was tuned lower. */
        const wob = (gNoise(u, v, 3, 4409) - 0.5) * 0.9;
        const cph = v * COURSES + wob;
        const cf = cph - Math.floor(cph);
        const sharp = Math.pow(Math.abs(cf - 0.5) * 2, 14); // 1 at the seam
        alb[i] -= sharp * 0.055;
        hgt[i] -= sharp * 0.0016;
        /* mod COURSES, and it is not cosmetic: cph runs 0..COURSES across the
           tile, so without it the top course draws hash(11) against the bottom
           course's hash(0) and every vertical repeat prints a horizontal seam
           — the one place in this generator where the wrapped-lattice noise
           does not save you, because this term is indexed rather than sampled. */
        alb[i] += (gHash(((Math.floor(cph) % COURSES) + COURSES) % COURSES, 3, 71) - 0.5) * 0.10;
      }
    }

    // ---- blowhole clusters ----
    /* The holes themselves are 3-8 mm and gone by 4 m. They are drawn in
       clusters precisely so what mips down is a 4-10 cm patch of pocking
       rather than nothing at all. */
    for (let c = 0; c < 110; c++) {
      const cx = gHash(c, 1, 31) * w, cy = gHash(c, 2, 31) * h;
      const spread = 12 + gHash(c, 3, 31) * 18; // 4-10 cm
      const n = 8 + Math.floor(gHash(c, 4, 31) * 18);
      for (let k = 0; k < n; k++) {
        const a = gHash(c * 97 + k, 5, 31) * Math.PI * 2;
        const r = Math.sqrt(gHash(c * 97 + k, 6, 31)) * spread;
        const bx = Math.round(cx + Math.cos(a) * r), by = Math.round(cy + Math.sin(a) * r);
        const br = 1.0 + gHash(c * 97 + k, 7, 31) * 2.0;
        const R2 = Math.ceil(br);
        for (let dy = -R2; dy <= R2; dy++)
          for (let dx = -R2; dx <= R2; dx++) {
            const d = Math.hypot(dx, dy);
            if (d > br) continue;
            const f = 1 - d / br;
            const i = at(bx + dx, by + dy);
            alb[i] -= f * 0.22;
            hgt[i] -= f * 0.0020;
          }
      }
    }

    // ---- pits and small spalls ----
    for (let p = 0; p < 220; p++) {
      const px = gHash(p, 11, 77) * w, py = gHash(p, 12, 77) * h;
      const rad = 5 + gHash(p, 13, 77) * 15; // 1.7-6.6 cm
      // half dirt-filled (darker), half fresh fracture (lighter aggregate)
      const fresh = gHash(p, 14, 77) > 0.5;
      const R2 = Math.ceil(rad) + 1;
      for (let dy = -R2; dy <= R2; dy++)
        for (let dx = -R2; dx <= R2; dx++) {
          const ang = Math.atan2(dy, dx);
          // ragged edge: a real spall is not a disc
          const wob = 1 + (gHash(p * 31 + Math.round(ang * 6), 15, 77) - 0.5) * 0.55;
          const d = Math.hypot(dx, dy) / (rad * wob);
          if (d > 1) continue;
          const f = 1 - d * d;
          const i = at(px + dx, py + dy);
          alb[i] += fresh ? f * 0.22 : -f * 0.26;
          hgt[i] -= f * 0.0030;
        }
    }

    /* ---- hairline cracks ----
       Three, thin, and faint. The first pass at this had nine of them at four
       times the contrast and one pixel of core plus two of shoulder, which at
       3.32 mm a texel is a one-centimetre black line — a structural crack, not
       a hairline — and nine of those repeating every 1.7 m was by far the most
       obvious thing on the wall and the single clearest tell that the surface
       was tiled. They are worth keeping only at the level where you notice
       them on the wall beside you and never on the wall ahead. */
    for (let k = 0; k < 3; k++) {
      let x = gHash(k, 21, 5) * w, y = gHash(k, 22, 5) * h;
      let a = gHash(k, 23, 5) * Math.PI * 2;
      const len = 100 + gHash(k, 24, 5) * 180; // 33-93 cm
      for (let s = 0; s < len; s++) {
        a += (gHash(k * 601 + s, 25, 5) - 0.5) * 0.28;
        x += Math.cos(a);
        y += Math.sin(a);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const f = dx === 0 && dy === 0 ? 1 : 0.12;
            const i = at(Math.round(x) + dx, Math.round(y) + dy);
            alb[i] -= f * 0.15;
            hgt[i] -= f * 0.0008;
          }
      }
    }

    /* Re-centre the albedo channel on exactly 0.5 before encoding. Everything
       above is subtractive on balance (dirt, pits, holes, seams all darken),
       so the raw mean lands a few percent low — and this file budgets wall
       albedo to three decimal places against the POV grade, so a grit layer
       that quietly dimmed every concrete surface by 3 % would be a real
       regression hiding inside a detail pass. Now it is a pure modulation. */
    let mean = 0;
    for (let i = 0; i < w * h; i++) mean += alb[i];
    mean /= w * h;

    const img = ctx.createImageData(w, h);
    const d = img.data;
    const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let i = 0; i < w * h; i++) {
      d[i * 4] = q(0.5 + alb[i] - mean);
      d[i * 4 + 1] = q(0.5 + hgt[i] / (2 * GRIT_H));
      d[i * 4 + 2] = q(stain[i]);
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, true);
}

/** Where a scan is applied and at what density. */
interface PbrOpts {
  /** texture repeats per 1 unit of the mesh's existing UV */
  repeat: [number, number];
  /** normal map strength. Highways are near-flat; keep this low. */
  normalScale?: number;
  /** strength of the detail-albedo multiply, 0..1 (road surfaces only) */
  detail?: number;
  /** dry-road target roughness, renormalised against the scan's own mean */
  roughness?: number;
  /** how strongly the roughness map modulates the wet reflection, 0..1 */
  roughMod?: number;
}

export interface Mats {
  envMap: THREE.CubeTexture;
  glowTex: THREE.Texture;
  streakTex: THREE.Texture;
  smokeTex: THREE.Texture;
  chevTex: THREE.Texture;
  goreTex: THREE.Texture;
  xingTex: THREE.Texture;
  studTex: THREE.Texture;
  road: THREE.MeshStandardMaterial;
  front: THREE.MeshStandardMaterial;
  hwy: THREE.MeshStandardMaterial;
  ramp: THREE.MeshStandardMaterial;
  ground: THREE.MeshStandardMaterial;
  sidewalk: THREE.MeshStandardMaterial;
  conc: THREE.MeshStandardMaterial;
  concDark: THREE.MeshStandardMaterial;
  barrier: THREE.MeshStandardMaterial;
  soundwall: THREE.MeshStandardMaterial;
  pole: THREE.MeshStandardMaterial;
  /** double-sided concrete, for the deck fascia (was a local conc.clone()) */
  concDouble: THREE.MeshStandardMaterial;
  /** double-sided dark concrete, for the ramp skirts (was a concDark.clone()) */
  concDarkDouble: THREE.MeshStandardMaterial;
  /** double-sided barrier concrete, for the parapets (was a barrier.clone()) */
  barrierDouble: THREE.MeshStandardMaterial;
  /** tunnel tube lining */
  tunnelWall: THREE.MeshStandardMaterial;
  tunnelCeil: THREE.MeshStandardMaterial;
  /** perforated-steel sound-barrier panelling — alphaTest cutout, never blend.
      Beam-responsive: headlights catch the mesh the way they catch real
      galvanised panels. Fed by the Fence007A scan when it lands. */
  fence: THREE.MeshStandardMaterial;
  /** corrugated-steel toll canopy roof (CorrugatedSteel009 when it lands) */
  canopyRoof: THREE.MeshStandardMaterial;
  /** brushed-panel canopy fascia (MetalPlates003 when it lands) */
  canopyFascia: THREE.MeshStandardMaterial;
  /** grated-catwalk decking for gantry walkways — alphaTest cutout */
  catwalk: THREE.MeshStandardMaterial;
  /** additive sprite material for retroreflective raised pavement markers */
  studMat: THREE.PointsMaterial;
  /** as studMat, for the tunnel span — never daylight-dimmed, see mats.ts */
  studMatTunnel: THREE.PointsMaterial;
  /** lane paint: stripes, hatching, gore chevrons. Retroreflective. */
  markMat: THREE.MeshBasicMaterial;
  /** opt a material into headlight retroreflection (see setBeam) */
  addBeam(mat: THREE.Material, opts?: { near?: number; far?: number; spread?: number }): void;
  /**
   * Point the headlight beam. Retroreflective paint returns light to its
   * source, so markings are bright only where the beam actually lands —
   * call this per frame with the car's head position and forward axis.
   * `dayF` is the engine's 0..1 daylight factor; at noon the effect washes
   * out to uniform brightness, because sunlight lights the paint anyway.
   * Never calling it leaves every marking at today's flat brightness.
   *
   * `unlitFloor` is how bright paint sits at night *outside* the beam, 0..1.
   * It belongs to whoever owns the night lighting: every material here is
   * unlit, so scene ambient cannot reach them and this is the only knob that
   * dims them. Raise it if the unlit dashes read as dead, lower it for a
   * harder beam edge.
   *
   * `range` scales every material's authored near/far together — pass the
   * ratio of the current headlight throw to the dipped-beam throw, so main
   * beam lights the paint as far down the road as it lights the road itself.
   * Derive it from the same constants that set the spotlight distance rather
   * than hardcoding a number, or the two will drift apart.
   */
  setBeam(
    on: boolean, pos: THREE.Vector3, dir: THREE.Vector3, dayF: number,
    unlitFloor?: number, range?: number
  ): void;
  winMats: THREE.MeshStandardMaterial[];
  sfMat: THREE.MeshStandardMaterial;
  vendMat: THREE.MeshStandardMaterial;
  clutterMat: THREE.MeshStandardMaterial;
  refMats: THREE.MeshStandardMaterial[];
  addReflection(mat: THREE.MeshStandardMaterial, strength: number): void;
  setReflectionTexture(tex: THREE.Texture): void;
  /** Vestigial. The reflection lookup used to be `gl_FragCoord / screen`;
      it is now a reprojection, which is resolution-independent, so nothing
      reads this. Kept because the engine calls it from three places on every
      resize and tier flip, and a no-op there is cheaper than a patch. */
  setReflectionScreen(w: number, h: number): void;
  setWet(on: boolean, reflectionsOn: boolean): void;
  /** Drop the scanned normal/detail layers when the frame budget is blown.
      Passing `true` also starts the scan load if `buildMats({ pbr: false })`
      deferred it, so the low preset can skip the download entirely and still
      be raised to high later. */
  setPbrDetail(on: boolean): void;
}

/** Per-material PBR bookkeeping, hung off material.userData. */
interface RoadUD {
  refStr: number;
  curStr: number;
  /** dry-road target roughness before the scan's mean is divided out */
  dryRough: number;
  /** 1 / mean of the roughness map; 1 while procedural */
  roughK: number;
  /** mean linear luminance of the detail albedo */
  detMean: number;
  detK: number;
  detRep: THREE.Vector2;
  detTex: THREE.Texture | null;
  roughMod: number;
  /** wet-state-scaled roughMod actually driving the shader (see setWet) */
  curRoughMod?: number;
  /** longitudinal wheel-path streaking amplitude, 0 = off */
  grooveAmt: number;
  /** streak frequency, in radians per unit of the mesh's u axis */
  grooveFreq: number;
  /** the scan's normal map, parked here so perf mode can pull and restore it */
  normalTex: THREE.Texture | null;
  /* three ships no bundled typings, so the shader-parameters object that
     onBeforeCompile hands back has no type to name here */
  sh?: { uniforms: Record<string, { value: unknown }> };
}

/**
 * @param opts.pbr Pass `false` to defer the photo-scan download rather than
 *   cancel it — nothing is fetched until `setPbrDetail(true)` asks for it. That
 *   is the honest binding for the low preset: a weak device pays neither the
 *   ~5 MB transfer nor the texture memory, but raising the quality setting
 *   later still upgrades the world, so the choice stays reversible.
 */
export function buildMats(opts?: { pbr?: boolean }): Mats {
  const usePbr = opts?.pbr !== false;

  const envMap = new THREE.CubeTexture([
    envFaceCanvas(), envFaceCanvas(), envFaceCanvas(true),
    envFaceCanvas(false), envFaceCanvas(), envFaceCanvas(),
  ]);
  envMap.needsUpdate = true;

  const glowTex = glowTexF();
  const streakTex = streakTexF();
  const smokeTex = smokeTexF();
  const chevTex = chevTexF();
  const goreTex = goreTexF();
  const xingTex = xingTexF();
  const studTex = studTexF();

  const roadT = roadTex();
  roadT.repeat.set(1, 1);
  const frontT = roadTex();
  const hwyT = hwyTexF();
  const rampT = rampTexF();
  rampT.repeat.set(1, 2);

  const refMats: THREE.MeshStandardMaterial[] = [];
  let pendingRefTex: THREE.Texture | null = null;
  const screen = new THREE.Vector2(1, 1);
  /* Wet-road reflection knobs, shared by every road material — one write moves
     all of them, no per-material loop and no recompile. Exposed on
     window.__wetTune (see below) so the balance can be found live. */
  const uRefLo = { value: REF_H_LO };
  const uRefHi = { value: REF_H_HI };
  const uRefLoW = { value: REF_LO_W };
  const uRefMax = { value: REF_MAX };
  /** overall multiplier on the reflection strength, live-tunable; the wet/dry
      and per-surface shares stay where they are underneath it */
  let refGain = REF_GAIN;
  /** last setWet() arguments, so a live knob can re-apply without the engine */
  let wetState = false, wetRefOn = false;
  let detailOn = true;
  let pbrStarted = false;

  /* Procedural weathering (see weatherSurface). ONE 256x256 mask texture
     shared by every concrete and steel surface in the world — never one per
     instance, or the VRAM saved by going procedural would be handed straight
     back. `uWeatherK` is the shared on/off uniform every weathered material
     holds, so perf mode flips one value instead of recompiling a dozen
     programs mid-drive. */
  const grimeTex = grimeTexF();
  /* The grit atlas — see the CONCRETE GRIT block at the top of this file. One
     512x512 shared by every concrete surface in the world, generated once at
     build time (~200 ms, inside the staged loader, never mid-drive) and worth
     0 MB of download. Its own repeat stays (1,1): the tiling is done by the
     world-space scale in the shader, not by a uv transform. */
  const gritTex = concreteGritTexF();
  const uWeatherK = { value: 1 };
  /* 1 / the concrete scan's mean linear luminance, so multiplying by it turns
     the scan into a UNIT-MEAN detail layer and the material tint becomes the
     surface's actual albedo. Exactly the trick upgradeRoad uses for the road
     detail albedo (uDetMean), and for the same reason: a mid-grey tint over a
     mid-grey photo is a near-black wall. 1 until the scan lands and measures
     itself, which is also the right value for the procedural fallback. */
  const uConcAlb = { value: 1 };

  /* ---- wall-relief master gains, live-tunable from the console ----
     Both are pure multipliers on effects that are shaped entirely in the
     shader, so `window.__wall.rake = 0` (or `.relief = 0`) restores the
     previous look exactly and any value in between is a straight blend — no
     recompile, no reload, tune it while driving. See the RAKE note in addBeam
     and the RELIEF note in weatherSurface for what each one does and why the
     defaults are where they are. Shared objects, one per world: every wall
     material holds the same reference, so one assignment moves all of them. */
  const uBeamRake = { value: 1 };
  /* ---- and the two that are also the PERF gate for this whole band ----
     Both are read inside `if (…)` tests on a UNIFORM, so at 0 the GPU skips
     the guarded body outright for every fragment rather than multiplying a
     result by zero — the same trick uWeatherK already uses, and the reason
     this is a gate and not just a dimmer. What each one skips:

       uGritK   = 0  the tGrit fetch. One texture read per concrete fragment,
                     and with wGrit left at its neutral 0.5 every downstream
                     grit term (two on albedo, one on roughness, one on the
                     height field) collapses to zero for free.
       uReliefK = 0  the Mikkelsen surface-gradient block at
                     <normal_fragment_maps>: 4 derivative instructions, two
                     cross products, a dot and a normalize, ~45 ALU, on every
                     fragment of every parapet and fascia in frame. This is
                     the expensive half by a wide margin — the fetch is one
                     cache-friendly read off a 512² atlas, the gradient is
                     unconditional maths.

     Seeded from TierCaps.wallDetail (settings.ts): 1 on desktop, 0.5 on
     mobile-high (grit, no relief), 0 on mobile-base. worldTierCaps() is the
     same escape hatch highway/sky/scenery already use — mats is built by the
     engine but is handed only `{pbr}`, so it cannot reach tierCaps directly. */
  const wallDetail = worldTierCaps().wallDetail ?? 1;
  const uReliefK = { value: wallDetail >= 1 ? 1 : 0 };
  const uGritK = { value: wallDetail > 0 ? 1 : 0 };
  const uCopingK = { value: 1 };
  /** 1 at midnight, 0 at noon; set by setBeam, read by the coping catch */
  const uNight = { value: 1 };

  const ud = (m: THREE.MeshStandardMaterial) => m.userData as unknown as RoadUD;

  /* ---------------- road surface shader ---------------- */

  function reflectionUniforms(mat: THREE.MeshStandardMaterial, strength: number) {
    const d = ud(mat);
    d.refStr = strength;
    d.curStr = strength;
    d.dryRough ??= mat.roughness;
    d.roughK ??= 1;
    d.detMean ??= 1;
    d.detK ??= 0;
    d.detRep ??= new THREE.Vector2(1, 1);
    d.detTex ??= null;
    d.normalTex ??= null;
    d.roughMod ??= 0;
    d.grooveAmt ??= 0;
    d.grooveFreq ??= 0;

    mat.onBeforeCompile = (sh) => {
      const hasDet = detailOn && !!d.detTex;
      const hasRough = !!mat.roughnessMap && d.roughMod > 0;
      const hasGroove = detailOn && d.grooveAmt > 0;
      sh.uniforms.tRef = { value: pendingRefTex };
      sh.uniforms.uRefStr = { value: d.curStr };
      sh.uniforms.uRefLo = uRefLo;
      sh.uniforms.uRefHi = uRefHi;
      sh.uniforms.uRefLoW = uRefLoW;
      sh.uniforms.uRefMax = uRefMax;
      sh.uniforms.uNight = uNight;
      sh.uniforms.tDet = { value: hasDet ? d.detTex : null };
      sh.uniforms.uDetRep = { value: d.detRep };
      sh.uniforms.uDetK = { value: hasDet ? d.detK : 0 };
      sh.uniforms.uDetMean = { value: d.detMean };
      // the reference the roughness map is compared against: the dry/wet
      // target itself, so a texel sitting at the map's mean gives a ratio of
      // exactly 1 and the tuned reflection strength is left alone
      sh.uniforms.uRoughRef = { value: mat.roughness * (d.roughK > 0 ? 1 / d.roughK : 1) };
      // curRoughMod tracks the wet state (see setWet); the game boots dry
      sh.uniforms.uRoughMod = { value: hasRough ? (d.curRoughMod ?? d.roughMod * 0.15) : 0 };
      sh.uniforms.uGrooveAmt = { value: d.grooveAmt };
      sh.uniforms.uGrooveF = { value: d.grooveFreq };
      d.sh = sh;

      /* World position of the fragment, for the reflection reprojection below.
         Its own y IS the mirror plane, so hills, crests and banked curves need
         no uniform and cannot drift out of agreement with the geometry. */
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
        .replace(
          "#include <project_vertex>",
          "#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;"
        );

      sh.fragmentShader = sh.fragmentShader.replace(
        "#include <common>",
        "#include <common>\n" +
          "uniform sampler2D tRef; uniform float uRefStr;\n" +
          "uniform float uRefLo, uRefHi, uRefLoW, uRefMax, uNight;\n" +
          /* three declares viewMatrix and cameraPosition in the fragment
             prefix but not projectionMatrix; redeclaring it links to the same
             uniform the vertex stage already has, and the renderer sets it by
             name, so this needs no plumbing on the engine side. */
          "uniform mat4 projectionMatrix;\n" +
          "varying vec3 vWPos;\n" +
          /* One reflected sample at assumed source height h. The edge feather
             is what keeps a source leaving the frame from smearing along the
             border: it fades the tap out over the outer 7% instead of letting
             the clamped edge texel repeat. */
          "vec3 refTap(vec3 p, vec3 r, float h){\n" +
          " vec4 cp = projectionMatrix * viewMatrix * vec4(p + r * (h / r.y), 1.0);\n" +
          " vec2 uv = cp.xy / max(cp.w, 1e-4) * .5 + .5;\n" +
          " vec2 e = smoothstep(vec2(0.), vec2(.07), uv)\n" +
          "        * (1. - smoothstep(vec2(.93), vec2(1.), uv));\n" +
          " return texture2D(tRef, uv).rgb * e.x * e.y * step(1e-4, cp.w);\n" +
          "}\n" +
          (hasDet
            ? "uniform sampler2D tDet; uniform vec2 uDetRep; uniform float uDetK; uniform float uDetMean;\n"
            : "") +
          (hasRough ? "uniform float uRoughRef; uniform float uRoughMod;\n" : "") +
          (hasGroove ? "uniform float uGrooveAmt; uniform float uGrooveF;\n" : "")
      );

      if (hasGroove) {
        /* Longitudinal streaking in the headlight pool.
           A real motorway surface is not isotropic: traffic polishes the wheel
           paths into fine lines running with the direction of travel, and a
           tined concrete deck is grooved the same way on purpose. Either way
           the night read is identical — the beam picks out fine bright/dark
           streaks running away from the car. This modulates roughness rather
           than perturbing the normal, so it costs one sin() and also rides the
           wet-reflection term, which is right: water sits in the low lines.

           Faded out past ~26 m, and not only for cost. It is analytic detail
           with no mip chain behind it, so at distance it would alias into
           crawling moire at exactly the speeds this game runs at. Fading it to
           nothing before it gets small is what keeps it stable — and it also
           happens to be where the real effect stops being visible. */
        sh.fragmentShader = sh.fragmentShader.replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\n" +
            "float gFade = 1.0 - smoothstep(10.0, 26.0, length(vViewPosition));\n" +
            "roughnessFactor *= 1.0 + sin(vMapUv.x * uGrooveF) * uGrooveAmt * gFade;\n" +
            "roughnessFactor = clamp(roughnessFactor, 0.02, 1.0);"
        );
      }

      if (hasDet) {
        /* Detail albedo. Dividing by the scan's mean luminance makes this a
           unit-mean multiply: it adds the photograph's grain and blotching to
           the procedural colour without darkening or lifting it, which is what
           lets a scan drop in over art that was hand-tuned under a different
           pipeline and still land at the same exposure. */
        sh.fragmentShader = sh.fragmentShader.replace(
          "#include <map_fragment>",
          "#include <map_fragment>\n" +
            "vec3 detC = texture2D(tDet, vMapUv * uDetRep).rgb;\n" +
            "diffuseColor.rgb *= mix(vec3(1.0), detC / max(uDetMean, 1e-3), uDetK);"
        );
      }

      sh.fragmentShader = sh.fragmentShader.replace(
        "#include <dithering_fragment>",
        /* Uniform-valued branch: with reflections off (setting or tier) every
           fragment in the draw takes the same side, so the GPU skips the body
           outright and the road costs exactly what it did before the effect
           existed. Nothing else is needed to "turn it off". */
        "if (uRefStr > 0.0) {" +
          "float ndv=clamp(dot(normalize(vNormal),normalize(vViewPosition)),0.,1.);" +
          "float fr=uRefStr*pow(1.0-ndv,2.0);" +
          /* Daylight damp. The whole point of this effect is that the bright
             pass excludes the sky — but by day the sky IS above the bright
             threshold, so the taps come back full of it and a distant wet road
             would go back to wearing a pale slab. A real wet road does mirror
             a daytime sky, so this is a damp and not a gate: it rides the day
             cycle smoothly and leaves enough for a sheen. */
          "fr*=mix(.35,1.0,uNight);" +
          (hasRough
            ? /* Puddle modulation. roughnessFactor is the scan's roughness at
                 this texel; where it dips below the map's mean the surface is
                 locally smoother — a worn-smooth patch or standing water — and
                 mirrors the world back harder, while coarse aggregate scatters
                 it away. Capped at 3x so a near-black texel cannot turn a patch
                 into a perfect mirror. */
              "fr*=mix(1.0, clamp(uRoughRef/max(roughnessFactor,0.02),0.0,3.0), uRoughMod);"
            : "") +
          "fr=clamp(fr,0.,1.);" +
          /* Mirror the view ray about the deck. dir.y is negative looking down
             the road; the floor on the flip covers a crest rising above the
             camera, where the ray would otherwise never reach the source
             height — it just walks the tap out toward the horizon instead. */
          "vec3 dir=normalize(vWPos-cameraPosition);" +
          "vec3 rr=vec3(dir.x, max(-dir.y, .02), dir.z);" +
          "vec3 refC=mix(refTap(vWPos,rr,uRefHi), refTap(vWPos,rr,uRefLo), uRefLoW);" +
          /* Soft ceiling (REF_MAX): an asymptote on luminance, so hue survives
             — a per-channel clamp would walk a sodium streak to white exactly
             where it is brightest, which is the failure this effect was cut
             for the first time round. */
          "float rl=dot(refC,vec3(.299,.587,.114));" +
          "refC*=uRefMax/(uRefMax+rl);" +
          // blend toward the reflection instead of stacking it on top —
          // additive stacking let a bright reflected highlight (e.g. the
          // car's own tail-lights) blow the pixel out to solid white,
          // especially at grazing angles on wet roads where fr is near 1
          "gl_FragColor.rgb=mix(gl_FragColor.rgb,refC,fr);" +
          "}\n#include <dithering_fragment>"
      );
    };
    // three keys its program cache partly on this; without it the detail and
    // puddle variants would collide with the plain one after a hot upgrade
    mat.customProgramCacheKey = () =>
      `road|${detailOn && d.detTex ? 1 : 0}|${mat.roughnessMap && d.roughMod > 0 ? 1 : 0}` +
      `|${detailOn && d.grooveAmt > 0 ? 1 : 0}`;
    refMats.push(mat);
  }

  /* ---------------- headlight retroreflection ---------------- */

  /* Shared per-frame uniforms. Every beam material is handed the *same*
     uniform objects, so setBeam() mutates one value and all of them follow —
     no per-material loop on the hot path. Only the static range/spread
     uniforms are per material. */
  const uBeamPos = { value: new THREE.Vector3() };
  const uBeamDir = { value: new THREE.Vector3(0, 0, 1) };
  const uBeamAmb = { value: 1 };
  const uBeamK = { value: 0 };
  /* Scales every material's authored near/far together. Main beam throws
     roughly 1.7x further than dipped, and without this the paint's
     retroreflective response would die at its dipped range in a stretch of
     road the player can plainly see is lit — the beam disagreeing with the
     light pool, the same failure as getting the origin wrong. A uniform and
     not a per-material `far`, deliberately: `far` is in the program cache key,
     so varying it would recompile, and flash-to-pass would hitch on every
     flash. */
  const uBeamRange = { value: 1 };

  /**
   * Modulate a material's brightness by whether the headlight beam lands on
   * it. Retroreflective paint and cat's eyes bounce light straight back to
   * the source rather than scattering it, which is why in a night photograph
   * the lane line is blazing inside the beam and nearly gone just outside it —
   * the single strongest night-road cue there is, and the one thing uniformly
   * bright markings can never produce.
   *
   * Works on MeshBasicMaterial and PointsMaterial alike: both shaders carry
   * <worldpos_vertex> and <color_fragment>, which is all this needs.
   * Inert until setBeam() is called — uBeamK stays 0 and the mix collapses to
   * the material's original colour, so nothing changes if it is never wired.
   *
   * `wash` switches the hook from the retro multiplier to an ADDITIVE emissive
   * term for LIT materials (the concrete parapets). The multiplier form is
   * wrong for those: outside the beam it would darken the material's ambient-
   * lit night look everywhere (a change to the whole night scene), and inside
   * the beam ×1.0 only restores a surface the real SpotLights barely reach —
   * the dipped cone is edge-pinned with penumbra 1.0, so anything off the
   * road-surface axis (a vertical barrier face, a car body) sits in the last
   * degrees before the cone rim where the angular smoothstep is ~0 (see the
   * cone comments in engine.ts weather()). So instead: add
   * `albedo × dippedTint × cone × fall × night × wash` as emissive, the same
   * matching-fake pattern as traffic.ts's washCol. It fades on the cone and
   * range smoothsteps (no hard line), is gated off in daylight and with the
   * lamps by uBeamK, and stretches with high beam via uBeamRange. The gain is
   * chosen against the POV grade: peak ≈ albedo·wash linear, and it must stay
   * well under the 0.72-display-luma blown-highlight clip (post.ts).
   */
  function addBeam(
    mat: THREE.Material,
    opts?: {
      near?: number; far?: number; spread?: number; wash?: number;
      /** incidence shaping on the wash; 0 keeps the old flat-lit card */
      rake?: number;
      /** the cos(incidence) a FLAT face of this surface actually sees, i.e.
          the value `rake` pivots around. Set it per surface: a parapet 3 m
          from the beam and a tunnel wall 5 m from it are not the same
          geometry, and using one number for both would rescale the second
          surface's brightness as a side effect of shaping it. */
      rakeRef?: number;
    }
  ) {
    const near = opts?.near ?? 22;
    const far = opts?.far ?? 70;
    /* Cosine of the half-angle at which the beam has fallen off entirely, and
       the cosine at which it is fully lit.

       The soft edge cannot be a fixed +0.16 on the threshold: `align` maxes out
       at exactly 1.0 for a fragment dead ahead, so once the upper edge passes
       1.0 the smoothstep can never reach full brightness and EVERY marking
       dims, worst of all the one straight in front of the car. At the 0.95 this
       now uses, a fixed band would have landed on-axis brightness at 0.232 —
       the retroreflection would have looked switched off, and the lateral gate
       is the last place anyone would have gone looking. Clamped just below 1.0
       instead, which is a no-op for any threshold below 0.84 and so changes
       nothing that shipped before it. */
    const cos0 = Math.min(Math.max(opts?.spread ?? 0.55, -0.99), 0.99);
    const cos1 = Math.min(cos0 + 0.16, 0.999);
    const wash = opts?.wash ?? 0;
    const rake = opts?.rake ?? 0;
    const rakeRef = Math.max(opts?.rakeRef ?? 0.11, 0.02);
    mat.onBeforeCompile = (sh) => {
      if (rake > 0) sh.uniforms.uBeamRake = uBeamRake;
      sh.uniforms.uBeamPos = uBeamPos;
      sh.uniforms.uBeamDir = uBeamDir;
      sh.uniforms.uBeamAmb = uBeamAmb;
      sh.uniforms.uBeamK = uBeamK;
      sh.uniforms.uBeamRange = uBeamRange;
      sh.uniforms.uBeamNear = { value: near };
      sh.uniforms.uBeamFar = { value: far };
      sh.uniforms.uBeamCos = { value: cos0 };
      sh.uniforms.uBeamCos1 = { value: cos1 };
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vRetroW;")
        .replace(
          "#include <worldpos_vertex>",
          "#include <worldpos_vertex>\nvRetroW = (modelMatrix * vec4(transformed, 1.0)).xyz;"
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vRetroW;\n" +
            "uniform vec3 uBeamPos; uniform vec3 uBeamDir;\n" +
            "uniform float uBeamAmb; uniform float uBeamK; uniform float uBeamRange;\n" +
            "uniform float uBeamNear; uniform float uBeamFar;\n" +
            "uniform float uBeamCos; uniform float uBeamCos1;" +
            (rake > 0 ? "\nuniform float uBeamRake;" : "")
        );
      const gate = `
  vec3 bd = vRetroW - uBeamPos;
  float bdist = length(bd);
  float align = dot(bd / max(bdist, 1e-4), uBeamDir);
  // inside the cone, and within range — the product is what gives the
  // narrow bright wedge that widens with distance
  float cone = smoothstep(uBeamCos, uBeamCos1, align);
  float fall = 1.0 - smoothstep(uBeamNear * uBeamRange, uBeamFar * uBeamRange, bdist);
  float lit = cone * fall;`;
      /* ------------------------------------------------------------------
         RAKE — why the walls read as flat, and the one line that fixes it
         ------------------------------------------------------------------

         Everything that lights a parapet at night is normal-independent.
         Count them: the real headlight SpotLights are edge-pinned and miss a
         vertical face entirely (that is the whole reason this wash exists);
         the streetlights are not lights at all, they are unlit decal pools
         painted on the deck; AmbientLight is normal-free by definition and
         sits at 0.07 after dark; HemisphereLight is 0.05 and, on a vertical
         face, lands on the exact midpoint of its sky/ground blend and stays
         there. Which leaves this wash — an ADDITIVE emissive term that, as
         originally written, had no N in it at all.

         So the parapet was a flat-lit card, and every bit of relief work
         upstream was landing on a surface that could not answer it. The scan's
         normal map, its normalScale, the weathering's roughness swing, the
         geometry's own facets: all of it modulates nothing, because nothing
         that reaches the wall cares which way it points. That is the actual
         defect behind "the walls look flat", and no texture spend fixes it.

         The fix is to give the wash an incidence term, referenced so the tuned
         gain above still means what its budget note says:

             shape = 1 + (dot(N, L) - REF) * (rake / REF)

         N is the SHADING normal, so the scan's normals, the procedural relief
         from weatherSurface and the coping facets in highway.ts all feed it
         together. REF is the grazing incidence a flat parapet face actually
         sees over the stretch of wall the wash covers: the near barrier sits
         2-4 m to the side and the read is dominated by 12-40 m ahead, i.e.
         cos ≈ 0.05-0.17, so 0.11 is the middle of it. A flat face at REF comes
         out at exactly 1.0 — the shipped brightness, unchanged — and relief
         swings either side of it.

         Why that swing is so large from such a weak normal map, which is the
         non-obvious part: at grazing incidence dot(N,L) IS the tilt angle, so
         a few degrees of relief is a few hundredths on a value whose baseline
         is only 0.11. The concrete scan's normals measure sigma 6.8/255 on xy,
         about 4 degrees — worthless on a face lit head-on, ±40 % here. Raking
         light is exactly the geometry that makes shallow texture read, which
         is why this is the lever and not the maps.

         Budget, worked the same way as the gain note above: peak is albedo
         0.146 x weathering ceiling 1.18 x gain 0.5 x HI 1.45 = 0.125 linear,
         about 0.30 display luma after ACES and the dashcam crush. The previous
         worst case was 0.086 linear / ~0.25 display, the target in the gain
         note is 0.33, and the blown-highlight clip is 0.72. Both clamps are
         there so no future amplitude change can walk out of that budget: LO
         also stops the top coping — which your headlights genuinely cannot
         reach, being 35 cm below it — from going to literal zero and cutting a
         black line out of the skyline.

         uBeamRake is a live master gain, so this whole effect dials 0 → 1 from
         the console against the shipped look. */
      const rakeSrc = rake > 0
        ? `
  vec3 bl = -bd / max(bdist, 1e-4);
  /* The shading normal is view-space; the beam is world-space. Rather than
     lift the normal into world space (a mat3 multiply AND a normalize) and dot
     it there, push the light vector down into view space and dot it here:
     mat3(viewMatrix) is orthonormal, so dot(Mᵀn, l) == dot(n, Ml) exactly, and
     the normalize inverseTransformDirection would have run is provably a no-op
     on an already-unit vector under an orthonormal transform. Same number,
     one fewer normalize per fragment. */
  float ndl = dot(normal, (viewMatrix * vec4(bl, 0.0)).xyz);
  lit *= clamp(
    1.0 + (ndl - ${rakeRef.toFixed(3)}) * ${(rake / rakeRef).toFixed(3)} * uBeamRake,
    0.32, 1.45);`
        : "";
      sh.fragmentShader = wash > 0
        ? sh.fragmentShader.replace(
            "#include <emissivemap_fragment>",
            /* additive wash for lit materials — see the doc comment above. The
               tint is the dipped-beam 0xffeeda in linear, so the wall answers
               in the beam's own colour and stays a different light from the
               sodium lamps. Albedo-proportional, so the concrete scan's
               texture modulates it for free.

               Placed at <emissivemap_fragment> for a second reason now: three
               runs it after <normal_fragment_maps>, so `normal` here is the
               fully perturbed shading normal and the rake above gets the map,
               the procedural relief and the geometry in one vector. */
            `#include <emissivemap_fragment>
{${gate}${rakeSrc}
  totalEmissiveRadiance +=
    diffuseColor.rgb * vec3(1.0, 0.858, 0.708) * (lit * uBeamK * ${wash.toFixed(3)});
}`
          )
        : sh.fragmentShader.replace(
            "#include <color_fragment>",
            `#include <color_fragment>
{${gate}
  diffuseColor.rgb *= mix(uBeamAmb, 1.0, lit * uBeamK);
}`
          );
    };
    mat.customProgramCacheKey = () =>
      `beam|${near}|${far}|${cos0}|${cos1}|${wash}|${rake}|${rakeRef}`;
  }

  /**
   * Light an up-facing concrete surface from the CITY rather than from the car.
   *
   * WHY. Look at what a real night-driving frame is actually built out of: the
   * barrier beside the lane carries almost no surface detail, and it is still
   * unmistakably a concrete barrier, because its TOP EDGE is a continuous
   * bright line running away to the horizon while its vertical face sits in
   * near-black. That one tonal step is what draws the edge of the road. It is
   * the most legible thing about a parapet at night and this engine had no
   * mechanism that could produce it:
   *
   *   - the headlight wash cannot. Your lamps are ~0.7 m up and the coping is
   *     1.05 m up, so they are BELOW it and physically cannot light its top
   *     face — which is exactly what addBeam's rake now says, correctly, by
   *     driving the coping down to its floor;
   *   - HemisphereLight is the right shape (it is a sky term, it keys on
   *     normal.y) but it is at 0.05 intensity after dark, which is three
   *     orders of magnitude short of a read;
   *   - AmbientLight has no normal in it, so it lifts the face and the coping
   *     by the same amount and flattens the very step we want;
   *   - `topClean` in the weathering is an ALBEDO trick — the coping is
   *     rain-washed so it is a paler grey — which is true but is not light,
   *     and multiplying a paler albedo by near-zero illumination is still
   *     near-zero.
   *
   * So: an additive term proportional to how much sky and lamp a surface can
   * see. `pow(max(N.y,0), k)` is a cheap sky-visibility approximation and, more
   * to the point, it is smooth from the coping right round to the vertical face
   * — there is no angle at which it switches off, which is the rule this
   * codebase keeps having to relearn about light that stops instead of fading.
   *
   * Level, against the grade rather than by eye. Parapet albedo is 0.146
   * linear; the reference frame's coping sits somewhere around 0.30 display
   * luma, i.e. roughly 0.075 linear after ACES and the dashcam crush. The face
   * beside it must stay ABOVE the crush — post.ts does `max(col - .06, 0)`, an
   * absolute cliff — or the "step" becomes a clipped edge rather than a
   * gradient, and a clipped edge is the artifact, not the effect. So the gain
   * is set to put a fully up-facing texel near 0.075 linear and the term
   * decays from there; nothing here approaches the ~0.8 luma where the grade
   * bleaches hue out, so the coping stays sodium-warm instead of going white.
   *
   * Warm, and deliberately further toward yellow than the target: the same
   * correction the lamp cone needed at highway.ts:984 — red survives ACES
   * better than green, so a source picked at the colour you want comes through
   * salmon. Albedo-proportional like every other fake in this file, so the
   * weathering and the grit modulate it for free and a filthy stretch of
   * coping catches less light than a clean one.
   */
  function addCopingCatch(mat: THREE.MeshStandardMaterial, gain: number, sharp = 1.6) {
    const prevHook = mat.onBeforeCompile;
    const prevKey = Object.prototype.hasOwnProperty.call(mat, "customProgramCacheKey")
      ? mat.customProgramCacheKey()
      : "";
    mat.onBeforeCompile = (sh, renderer) => {
      prevHook?.call(mat, sh, renderer);
      sh.uniforms.uNight = uNight;
      sh.uniforms.uCopingK = uCopingK;
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float uNight; uniform float uCopingK;"
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
{
  /* The SHADING normal, so the coping's own relief breaks the line up rather
     than it running as a drawn stroke — and so a chamfer or a fallen kerb
     angle reads differently from a flat top, which is the whole point.

     This wants ONE COMPONENT of the world normal, and asking
     inverseTransformDirection() for it buys the other two and a normalize as
     well. It expands to normalize((vec4(n,0) * viewMatrix).xyz), i.e.
     transpose(mat3(viewMatrix)) * n — and viewMatrix is the inverse of a
     camera world matrix, which carries no scale, so that mat3 is orthonormal:
     the normalize is provably a no-op on an already-unit normal, and the .y
     component of a transpose-multiply is just dot(n, viewMatrix[1].xyz).
     Bit-for-bit the same value for 5 ALU instead of ~25, on every barrier
     fragment in frame. */
  float ny = max(dot(normal, viewMatrix[1].xyz), 0.0);
  totalEmissiveRadiance +=
    diffuseColor.rgb * vec3(1.0, 0.795, 0.545)
    * (pow(ny, ${sharp.toFixed(2)}) * uNight * uCopingK * ${gain.toFixed(3)});
}`
        );
    };
    mat.customProgramCacheKey = () => `coping|${gain}|${sharp}|${prevKey}`;
  }

  /* ---------------- world-projected UVs ---------------- */

  /**
   * Make a material texture itself from world position instead of a uv
   * attribute.
   *
   * The highway fascia, parapets and tunnel lining are emitted as raw triangle
   * soups with no uv attribute at all — every vertex would sample the same
   * texel. Rather than reach into that geometry (it is shared with the collider
   * build), the UV is derived in the vertex shader by projecting world position
   * down the face's dominant axis. Those soups get flat per-face normals from
   * computeVertexNormals() on non-indexed triangles, so the axis choice is
   * constant across each triangle and no face can seam down its middle.
   */
  function projectedUv(mat: THREE.MeshStandardMaterial, scale: number) {
    mat.userData.projScale = scale;
    /* Chain, don't clobber: the parapet materials already carry addBeam's
       headlight-wash hook by the time the async scan lands here. The chained
       key must also stay distinct per prior hook — `conc` (no hook) and
       `barrier` (beam hook) compile different shaders, and a shared "projuv"
       key would make three hand one the other's program. The prior key is
       resolved once, eagerly: addBeam's key is static, and reading it lazily
       after the reassignment below would recurse. */
    const prevHook = mat.onBeforeCompile;
    const prevKey = Object.prototype.hasOwnProperty.call(mat, "customProgramCacheKey")
      ? mat.customProgramCacheKey()
      : "";
    mat.onBeforeCompile = (sh, renderer) => {
      prevHook?.call(mat, sh, renderer);
      sh.uniforms.uProjScale = { value: mat.userData.projScale };
      mat.userData.projSh = sh;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uProjScale;")
        .replace(
          "#include <uv_vertex>",
          `#include <uv_vertex>
{
  vec3 wpP = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 wnP = normalize(mat3(modelMatrix) * normal);
  vec3 anP = abs(wnP);
  vec2 pUV = anP.y > max(anP.x, anP.z) ? wpP.xz
           : (anP.x > anP.z ? wpP.zy : wpP.xy);
  pUV *= uProjScale;
  #ifdef USE_MAP
    vMapUv = pUV;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv = pUV;
  #endif
  #ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv = pUV;
  #endif
  #ifdef USE_METALNESSMAP
    vMetalnessMapUv = pUV;
  #endif
}`
        );
    };
    mat.customProgramCacheKey = () => `projuv|${prevKey}`;
  }

  /* ---------------- procedural weathering ---------------- */

  /**
   * Options for `weatherSurface`. Every amplitude is a fraction of the
   * material's own albedo, so a dark skirt and a pale parapet weather by the
   * same proportion rather than the same absolute amount.
   */
  interface WeatherOpts {
    /** large-scale tonal drift, ± this fraction of albedo */
    macro?: number;
    /** rain-wash streak darkening at a full streak, 0..1 */
    streak?: number;
    /** contraction-joint groove darkness; 0 disables the grooves entirely */
    joint?: number;
    /** metres between contraction joints */
    jointPitch?: number;
    /** tonal spread between one casting and the next, ± fraction */
    section?: number;
    /** how much lighter the rain-washed up-facing coping reads */
    topClean?: number;
    /** roughness swing the same masks drive */
    rough?: number;
    /** warm oxide tint carried by the heaviest streaks (galvanised steel) */
    rust?: number;
    /** divide the photo scan by its own mean so the material tint IS the
        albedo (see uConcAlb). Concrete only — every other set's level was
        tuned against the un-normalised scan and must stay there. */
    normalise?: boolean;
    /** world metres per repeat of the macro field */
    macroScale?: number;
    /** world metres per repeat of the streak field, before the v stretch */
    streakScale?: number;
    /** depth of the contraction-joint groove, in metres of real relief; 0
        leaves the normal alone. See the RELIEF note in weatherSurface. */
    relief?: number;
    /** concrete grit: albedo modulation depth, 0 disables the layer entirely
        (one texture fetch and a handful of ALU). 1 uses the atlas at the
        contrast it was authored at. See the CONCRETE GRIT block above. */
    grit?: number;
    /** metres of wall per repeat of the grit tile; the atlas is authored for
        GRIT_M and this scales it. Keep it incommensurate with the 2.22 m photo
        scan and with the joint pitch. */
    gritScale?: number;
    /** how much of the grit's encoded relief to apply, 0..1 of GRIT_H */
    gritRelief?: number;
    /** irregular heavy-soiling bands, as a fraction of albedo at their worst.
        This is the "no two stretches alike" term — see the BANDS note. */
    band?: number;
    /** contrast expansion applied to the unit-mean photo scan; only meaningful
        with `normalise`. 1 leaves the scan alone. */
    scanBoost?: number;
  }

  /**
   * Weather a concrete or steel surface procedurally, in world space.
   *
   * WHY this exists. The parapets are a 0.34 m box with three quads per 8 m
   * segment and no uv attribute at all (highway.ts emits them as a triangle
   * soup), so everything they show comes from one photo scan projected down
   * the face's dominant axis at 0.45 units/m — i.e. the SAME 2.22 m patch of
   * concrete repeated end to end for kilometres. At 40 m/s that patch flicks
   * past 18 times a second, and a periodic signal at 18 Hz is exactly what
   * the eye is best at locking onto: the wall reads as printed wallpaper
   * rather than as concrete. Nothing about the scan's own quality fixes that;
   * the period is the tell.
   *
   * So this layers three fields on top, at frequencies deliberately
   * incommensurate with the scan's 2.22 m and with each other:
   *
   *   - macro mottling at ~11.3 m and a second draw of the same field at
   *     ~2.9 m. Their beat runs to hundreds of metres, which is longer than
   *     any stretch of wall the player sees at once;
   *   - vertical rain-wash streaks below the coping (upright faces only —
   *     rain does not streak a horizontal surface), which is the single
   *     most recognisable thing about weathered concrete and, because it
   *     also drives roughness, is what makes light BREAK across the face
   *     instead of sliding over it;
   *   - contraction joints at a real casting pitch, plus a per-casting tonal
   *     offset, so consecutive sections are visibly different pours.
   *
   * All of it multiplies `diffuseColor` right after `<map_fragment>`, which
   * means it lands *before* addBeam's wash reads that albedo — the headlight
   * wash inherits the weathering for free, and a dirty streak takes less
   * light than the clean concrete beside it, which is the whole point at
   * night.
   *
   * Chains onto whatever hook the material already carries (addBeam) and is
   * itself chained onto later by projectedUv when the scan lands; see the
   * cache-key note in projectedUv — three keys programs on that string, and
   * a shared key across different hook sets makes it hand one material
   * another's program.
   */
  function weatherSurface(mat: THREE.MeshStandardMaterial, o: WeatherOpts = {}) {
    const macro = o.macro ?? 0.13;
    const streak = o.streak ?? 0.16;
    const joint = o.joint ?? 0;
    const pitch = o.jointPitch ?? 4.6;
    const section = o.section ?? 0.07;
    const topClean = o.topClean ?? 0.1;
    const rough = o.rough ?? 0.2;
    const rust = o.rust ?? 0;
    const norm = o.normalise === true;
    const relief = joint > 0 ? o.relief ?? 0 : 0;
    const grit = o.grit ?? 0;
    const gritK = 1 / (o.gritScale ?? GRIT_M);
    const gritRel = grit > 0 ? o.gritRelief ?? 0 : 0;
    const band = o.band ?? 0;
    const boost = norm ? o.scanBoost ?? 1 : 1;
    const macK = 1 / (o.macroScale ?? 11.3);
    const strK = 1 / (o.streakScale ?? 2.9);
    const f = (n: number) => n.toFixed(4);
    /* The normal is perturbed if EITHER source asks for it. Kept as one flag
       so the block below is emitted once and both height terms sum into the
       same gradient — two separate perturbations would each renormalise and
       the second would partly undo the first. */
    const anyRelief = relief > 0 || gritRel > 0;

    /* Same eager chain-and-compose as projectedUv, for the same reason: the
       beam hook is already installed by the time this runs, and reading the
       prior key lazily after the reassignment below would recurse. */
    const prevHook = mat.onBeforeCompile;
    const prevKey = Object.prototype.hasOwnProperty.call(mat, "customProgramCacheKey")
      ? mat.customProgramCacheKey()
      : "";
    mat.onBeforeCompile = (sh, renderer) => {
      prevHook?.call(mat, sh, renderer);
      sh.uniforms.tGrime = { value: grimeTex };
      sh.uniforms.uWeatherK = uWeatherK;
      if (norm) sh.uniforms.uConcAlb = uConcAlb;
      if (anyRelief) sh.uniforms.uReliefK = uReliefK;
      if (grit > 0) {
        sh.uniforms.tGrit = { value: gritTex };
        sh.uniforms.uGritK = uGritK;
      }

      sh.vertexShader = sh.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vWeaW; varying vec3 vWeaN;"
        )
        .replace(
          "#include <worldpos_vertex>",
          `#include <worldpos_vertex>
{
  /* The instanceMatrix branch matters: an InstancedMesh's modelMatrix is the
     BATCH transform, so without it every instance would sample the identical
     patch of world and weather identically — the failure projectedUv calls
     out for the poles. */
  mat4 wMat = modelMatrix;
  #ifdef USE_INSTANCING
    wMat = modelMatrix * instanceMatrix;
  #endif
  vWeaW = (wMat * vec4(transformed, 1.0)).xyz;
  vWeaN = normalize(mat3(wMat) * normal);
}`
        );

      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vWeaW; varying vec3 vWeaN;\n" +
            "uniform sampler2D tGrime; uniform float uWeatherK;" +
            (norm ? "\nuniform float uConcAlb;" : "") +
            (anyRelief ? "\nuniform float uReliefK;" : "") +
            (grit > 0 ? "\nuniform sampler2D tGrit; uniform float uGritK;" : "")
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>${
            norm
              ? `
/* Scan → unit mean, so the tint above is the real albedo. OUTSIDE the perf
   branch on purpose: this is not detail, it is the surface's brightness, and
   dropping to the low preset must not repaint the world four shades darker. */
diffuseColor.rgb *= uConcAlb;${
                boost !== 1
                  ? `
/* Contrast expansion about the scan's own mean, which uConcAlb has just put at
   1.0. Measured, and the measurement is the reason this exists: Concrete033's
   albedo has a standard deviation of 6.9/255 — 2.7 % of range. Multiplied by
   the 0.146 linear tint and pushed through the night grade that is about
   +/- 0.006 display luma, i.e. below anything a screen can show and well below
   the crush in post.ts. The scan's FEATURES are at a useful scale (0.2-1.0 m
   blotches); it is only their amplitude that is hopeless, and amplitude is the
   one thing a shader can fix for free.

   Expanded about "diffuse" — three's uniform for material.color, i.e. the tint
   itself — and not about 1.0 or about the texel: after uConcAlb the scan has
   unit mean, so diffuseColor averages exactly that tint and pivoting there is
   what leaves the albedo budget in the CONC_TINT note untouched. With no map
   yet loaded diffuseColor IS diffuse and this collapses to a no-op, which is
   the right behaviour for the procedural fallback.

   LUMINANCE ONLY, and this is not a detail. Concrete033's channel means are
   R 80 / G 76 / B 66, i.e. the scan carries a distinct brown cast — capture
   light and dirt, not the material. Expanding per channel about the tint
   amplifies that cast by the boost factor too, and 2.4x of it turns the wall
   frankly gold. It also quietly undoes the deliberate choice in the CONC_TINT
   note above, which went to some trouble to stop the wall carrying a colour
   that belongs to the lighting. So the scan contributes its LUMINANCE
   variation and the tint keeps the hue, which is what a neutral dielectric
   should look like anyway. */
{
  vec3 sTint = max(diffuse, vec3(1e-4));
  float sLum = dot(diffuseColor.rgb / sTint, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = sTint * max(0.0, 1.0 + (sLum - 1.0) * ${f(boost)});
}`
                  : ""
              }`
              : ""
          }
/* declared at main scope, not inside the branch: <roughnessmap_fragment>
   further down reads them, and a zeroed set there costs one madd */
float wMac = 0.0, wDirt = 0.0, wJnt = 0.0, wTop = 0.0;${
            grit > 0 ? "\nvec3 wGrit = vec3(0.5, 0.5, 0.5);" : ""
          }${band > 0 ? "\nfloat wBand = 0.0;" : ""}
/* Branching on a UNIFORM, not on anything per-fragment: every fragment in a
   quad takes the same path, so the GPU skips the body outright when perf mode
   zeroes it AND the fwidth() below stays well defined — derivatives taken in
   divergent control flow are not. */
if (uWeatherK > 0.001) {
  vec3 wAn = abs(vWeaN);
  bool wUp = wAn.y > max(wAn.x, wAn.z);
  // project down the dominant axis, exactly as projectedUv does, so the masks
  // sit on the same axes as the photo scan they are breaking up
  vec2 wUV = wUp ? vWeaW.xz : (wAn.x > wAn.z ? vWeaW.zy : vWeaW.xy);
  wTop = smoothstep(0.55, 0.86, wAn.y);
  float wSide = 1.0 - wTop;

  vec3 g1 = texture2D(tGrime, wUV * ${f(macK)}).rgb;
  // 0.125 on v is the 8:1 stretch that turns blobs into vertical runs; the
  // 0.37 offset decorrelates this draw from the macro one above it
  vec3 g2 = texture2D(tGrime, vec2(wUV.x * ${f(strK)} + 0.37, wUV.y * ${f(strK * 0.125)})).rgb;

  // two incommensurate frequencies of the same field: their beat is hundreds
  // of metres long, so there is no period left for the eye to lock onto
  wMac = (g1.r - 0.5) + (g2.r - 0.5) * 0.6 + (g1.b - 0.5) * 0.35;
  // rain wash runs down upright faces only
  wDirt = (1.0 - g2.g) * wSide;
${
    grit > 0
      ? `  /* CONCRETE GRIT — see the block at the top of this file. One fetch, at a
     scale deliberately between the joint pitch and the fine grain: this is the
     0.02-0.35 m band, which nothing else in this shader occupies and which is
     the band the eye is actually in from the dashcam.

     Behind a UNIFORM branch, for the same reason the outer uWeatherK test is:
     every fragment in a quad takes the same path, so at uGritK = 0 the fetch
     genuinely does not happen — and because it is uniform control flow the
     implicit-derivative mip selection inside texture2D stays well defined,
     which a per-fragment distance branch here would NOT (see the DISTANCE
     note below). wGrit keeps its neutral 0.5, so every term that reads it
     falls to zero on its own and no downstream line needs a second gate. */
  if (uGritK > 0.001) wGrit = texture2D(tGrit, wUV * ${f(gritK)}).rgb;
`
      : ""
  }${
    band > 0
      ? `  /* BANDS — the "no two stretches alike" term.
     The macro field is a smooth +/-13 % drift, and a smooth drift at 11 m is
     not something you can see from a moving car; it reads as one flat wall.
     Real parapets are not shaded, they are SOILED: clean, then abruptly filthy
     for ten or twenty metres under a drain or behind a sign, then clean again.
     The threshold is what buys that edge — below it nothing happens at all, so
     most of the wall is untouched and the stretches that are dirty are
     properly dirty rather than everything being slightly grey.

     Keyed on the macro field's own G channel, which nothing else reads, so the
     bands are uncorrelated with the mottling already riding on R and B and the
     two cannot line up into a single stronger period. Upright faces only — a
     coping is rained on, not splashed. */
  wBand = smoothstep(0.54, 0.80, g1.g) * wSide;
`
      : ""
  }
  ${
    section > 0
      ? `/* Per-casting tone. "along" is the run direction: the projection above
     puts world Z on wUV.x for a wall whose normal is X-dominant, and world X
     for one whose normal is Z-dominant, so it tracks the road through bends.
     mod before the sin: sIdx runs to the high hundreds over the track, and
     sin() of a large argument is where a fract-hash loses its low bits on a
     mediump fragment unit. A 512-casting period is ~2.4 km — never seen
     twice in one frame. */
  float along = wUV.x;
  float sIdx = floor(along / ${f(pitch)});
  float sTone = fract(sin(mod(sIdx, 512.0) * 12.9898 + 4.13) * 43758.5453);`
      : "float along = wUV.x; float sTone = 0.5;"
  }
  ${
    joint > 0
      ? `// contraction joints. The groove is widened with the fragment's own
  // footprint (fwidth) so it never falls between samples and shimmers, and its
  // contrast is faded out past ~55 m where a 2 cm groove is sub-pixel anyway.
  float jd = abs(fract(along / ${f(pitch)} + 0.5) - 0.5) * ${f(pitch)};
  float jw = 0.011 + fwidth(along) * 0.7;
  wJnt = (1.0 - smoothstep(jw, jw * 3.0, jd)) * wSide
       * (1.0 - smoothstep(55.0, 115.0, length(vViewPosition)));`
      : ""
  }

  float tone = 1.0
    + wMac * ${f(macro)}
    + (sTone - 0.5) * ${f(section)} * wSide
    - wDirt * ${f(streak)}
    - wJnt * ${f(joint)}
    + wTop * ${f(topClean)}${
      grit > 0 ? `\n    + (wGrit.r - 0.5) * 2.0 * ${f(grit)} * uGritK` : ""
    }${
      grit > 0 ? `\n    + (wGrit.b - 0.5) * ${f(grit * 0.55)} * uGritK` : ""
    }${band > 0 ? `\n    - wBand * ${f(band)}` : ""};
  /* Clamped, not because the sum can run away, but so a future amplitude bump
     can never push albedo past what addBeam's wash gain was budgeted against.
     The floor drops 0.62 → 0.40 with the soiling bands: the ceiling is the
     half that guards the wash budget and it has not moved, and a band that
     cannot take the wall below 62 % is not a soiled stretch of concrete, it is
     a slightly grey one — which was the problem. */
  diffuseColor.rgb *= mix(1.0, clamp(tone, ${band > 0 ? "0.40" : "0.62"}, 1.18), uWeatherK);${
    rust > 0
      ? `
  /* Oxide bleed. Only the heaviest streaks carry it — on galvanised sheet the
     zinc holds everywhere except where a fixing has broken it, and the rust
     then washes down from that one point. */
  float ox = smoothstep(0.62, 1.0, wDirt) * ${f(rust)} * uWeatherK;
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.28, 0.72, 0.40), ox);`
      : ""
  }
}`
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
/* Roughness is where most of the realism actually lands: dirt scatters, so a
   streak has to answer the headlight differently from the clean concrete
   beside it. Without this the wall takes light uniformly and reads as plastic
   however good its albedo is. The clamp also caps the scan path, where
   roughness = target/roughMean can put a bright texel over 1.0. */
roughnessFactor *= 1.0 + (wDirt * 1.6 - wMac + wJnt * 1.2 - wTop * 0.3${
            grit > 0 ? ` - (wGrit.r - 0.5) * 1.4 * uGritK` : ""
          }${band > 0 ? ` + wBand * 1.5` : ""})
                       * ${f(rough)} * uWeatherK;
roughnessFactor = clamp(roughnessFactor, 0.05, 1.0);`
        );

      /* ---- RELIEF: the joints and the grit, and nothing else ----
         The macro and streak fields are deliberately left out and it is worth
         writing down why, because "add relief to the weathering" reads like it
         should apply to everything: a normal perturbation is a SLOPE, and
         slope is amplitude over feature size. Those two fields have features
         metres across, so a physically honest few millimetres of undulation
         across them comes out at a slope of ~0.002 — nothing, invisible, and
         the only way to make it show would be to give a concrete wall nine
         centimetres of relief per metre, which is a rock face. Their job is
         tone, and tone is what they do.

         The joint is the opposite shape: a 2 cm groove with near-vertical
         walls, i.e. a slope of order 1 packed into 11 mm, which is precisely
         the thing a normal can express and a tint cannot. The grit atlas sits
         between the two — 2-3 mm of pitting in a 2-7 cm dish, slopes around
         0.1 — shallow enough that it would be invisible under head-on light
         and only reads because the rake is looking at it edge-on.

         Which matters here more than it would elsewhere, because addBeam's
         rake now reads this normal, and a groove is where relief and grazing
         light do their most recognisable work together: as you come level with
         a joint its near wall flares and its far wall drops out, and that
         flick — 4.6 m apart, so ~9 Hz at speed — is a large part of what says
         "poured concrete, cast in sections" rather than "printed wallpaper".

         Surface-gradient form (Mikkelsen), NOT three's perturbNormalArb: that
         chunk normalises the screen-space tangents, which makes the bump
         strength a function of how many pixels the wall happens to occupy, so
         a groove would quietly get stronger as it receded. Leaving them
         unnormalised makes `grad` a true dH/dmetre and the groove keeps the
         same depth at every distance. It fades on its own anyway — jw below is
         widened by fwidth, so past ~50 m the groove is a sub-pixel feature
         spread over a pixel and its slope falls off with it, which is the
         correct anti-aliasing behaviour and needs no distance term.

         ---- DISTANCE: why there is no near-field cutoff here ----
         This block is the expensive half of the concrete work — 4 derivative
         instructions, two cross products, a dot and a normalize, ~45 ALU on
         every parapet and fascia fragment — and the band it serves is only
         legible over about 2-6 m, so "compute it near the camera and fade it
         out beyond that" is the obvious saving. It was worked out and
         rejected, on two independent grounds, and both are worth keeping:

         1. THE NEAR FIELD IS THE PIXELS. A wall running beside the road
            subtends screen height proportional to 1/d and screen width
            proportional to 1/d, so the fragments it contributes between d and
            d+dd go as d^-3. Integrating over the range the dashcam can
            actually see a parapet — it clears the windscreen aperture around
            6 m and the beam wash dies at 78 — the integral of d^-3 from 6 to
            15 is 0.0117 against 0.0021 from 15 to 78. Eighty-five per cent of
            the wall's fragments are inside 15 m. A cutoff at 15-25 m saves
            ~15 % of the cost, and removes none of it from the place the cost
            actually is, which is also the one place the detail has to stay.

         2. A DISTANCE BRANCH IS DIVERGENT, and this block takes derivatives.
            dFdx/dFdy in non-uniform control flow are undefined — the same
            constraint the uWeatherK note above is written around. Skipping the
            body per fragment makes the gradient garbage on every quad
            straddling the cutoff, and hoisting the derivatives out to keep
            them defined leaves the cost outside the branch anyway. A smooth
            fade is well defined but saves nothing: the gradient still runs and
            merely multiplies out to zero.

         So the lever here is the uniform gate on the line below, not distance.
         uReliefK is 0 on mobile-high and mobile-base (TierCaps.wallDetail) and
         is half of what `__wall.detail` moves, so the block is skipped for
         every fragment or for none — coherent, and derivative-safe by
         construction. */
      if (anyRelief)
        sh.fragmentShader = sh.fragmentShader.replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
if (uWeatherK > 0.001 && uReliefK > 0.0) {
  /* One height field, summed before a single gradient is taken. Two separate
     perturbations would each renormalise and the second would partly undo the
     first; summing keeps the joint's 36-degree groove wall and the grit's
     millimetre pocking additive, which is what they are on a real wall. */
  float wHt = (${[
    relief > 0 ? `-wJnt * ${f(relief)}` : "",
    /* GRIT_H is the full-swing encoding of the G channel; gritRel scales it,
       and 1.0 means "use the depths the atlas was authored at". The pits are
       2-3 mm in a 1.7-6.6 cm dish, i.e. slopes around 0.1 — shallow, which is
       correct, and which only reads at all because addBeam's rake is looking
       at this normal from a grazing angle. */
    gritRel > 0
      ? `(wGrit.g - 0.5) * ${f(2 * GRIT_H * gritRel)} * uGritK`
      : "",
  ]
    .filter(Boolean)
    .join(" + ")}) * uWeatherK * uReliefK;
  vec3 wSp = -vViewPosition;
  vec3 wSx = dFdx(wSp), wSy = dFdy(wSp);
  vec3 wR1 = cross(wSy, normal), wR2 = cross(normal, wSx);
  float wDet = dot(wSx, wR1);
  vec3 wGrad = sign(wDet) * (dFdx(wHt) * wR1 + dFdy(wHt) * wR2);
  // the epsilon is not decoration: a triangle seen exactly edge-on has a zero
  // determinant AND a zero gradient, and normalize(vec3(0)) is a NaN that
  // propagates into the lighting for the whole quad
  normal = normalize(max(abs(wDet), 1e-8) * normal - wGrad);
}`
        );
    };
    mat.customProgramCacheKey = () =>
      `weather|${f(macro)}|${f(streak)}|${f(joint)}|${f(rust)}` +
      `|${norm ? 1 : 0}|${f(relief)}|${f(boost)}` +
      `|${f(grit)}|${f(gritK)}|${f(gritRel)}|${f(band)}|${prevKey}`;
  }

  const road = new THREE.MeshStandardMaterial({
    map: roadT, roughness: 0.4, metalness: 0.1, envMap, envMapIntensity: 0.4,
  });
  const front = new THREE.MeshStandardMaterial({
    map: frontT, roughness: 0.4, metalness: 0.1, envMap, envMapIntensity: 0.4,
  });
  const hwy = new THREE.MeshStandardMaterial({
    map: hwyT, roughness: 0.38, metalness: 0.1, envMap, envMapIntensity: 0.45,
  });
  const ramp = new THREE.MeshStandardMaterial({
    map: rampT, roughness: 0.4, metalness: 0.1, envMap, envMapIntensity: 0.4,
  });
  reflectionUniforms(road, 0.3);
  reflectionUniforms(front, 0.3);
  reflectionUniforms(hwy, 0.34);
  reflectionUniforms(ramp, 0.22);

  /* Wheel-path streaking, expressway deck only — it is a high-speed-surface
     effect and would be wrong on town streets. The deck's u axis is in metres
     over TILE (7 m per uv unit, see highway.ts), so 28 cycles per unit puts a
     streak roughly every 25 cm, which is the scale the headlight pool picks
     out. Amplitude is deliberately low; this is a texture cue, not a pattern
     you should be able to count. Rides with detailOn, so perf mode drops it. */
  ud(hwy).grooveAmt = 0.16;
  ud(hwy).grooveFreq = 28 * Math.PI * 2;

  /* ------------------------------------------------------------------
     The parapets: two measured defects, and why 0x272523 is not a typo
     ------------------------------------------------------------------

     (1) CONCRETE IS A DIELECTRIC. `barrier` shipped at metalness 0.35 with no
     metalness map behind it. Under three's PBR model that does two wrong
     things at once: it deletes 35 % of the diffuse response, and it hands
     that energy to a broad albedo-tinted specular lobe off the fake env cube.
     Dark, evenly sheened, hue-tinted — that is the definition of grey
     plastic, and no amount of texture work fixes it while metalness is set.
     Roughness goes up with it (0.55 → 0.84): with the scan's measured mean of
     0.686 the old base put every texel in the 0.30-0.72 semi-gloss band, i.e.
     painted metal. 0.84 spreads the same map over 0.46-1.0, which is
     weathered concrete and is what lets the headlight break across it.

     (2) THE TINT WAS DOUBLE-DARKENING THE SCAN, by about 14x. This engine
     runs with THREE.ColorManagement DISABLED, so a material `color` hex is
     used RAW — 0x14161c on the deck asphalt is 0.086 *linear*, a physically
     right asphalt albedo, and that is the convention every number here has to
     be read in. But `barrier`'s 0x8d939f is 0.575 linear: fresh white
     plaster, ~6.6x the road, which was tolerable only because it is the
     no-scan fallback almost nobody sees. When the concrete scan lands it is
     kept as a MULTIPLIER over it, and the scan's own mean linear luminance is
     0.0734 — so the shipped parapet albedo was 0.575 × 0.0734 = 0.042, and
     0.027 after the metalness cut. The road beside it is 0.078. The barrier
     was reflecting ONE THIRD of the light of the tarmac it stands on: a
     concrete wall darker than asphalt, in every frame, at every hour. That is
     the single biggest reason it read as fake, and it is not something the
     eye forgives however good the texture is.

     The fix is the same one upgradeRoad already uses for the detail layer:
     normalise the scan to unit mean (uConcAlb below) so the TINT alone sets
     the albedo, in both the scanned and the procedural path. The tint is then
     an honest linear albedo, which is why it looks so dark as a hex —
     0x272523 is 0.146 linear, about 1.9x the road. Real weathered concrete
     runs 0.12-0.30 against asphalt's 0.06-0.12, so this sits at the grimy end
     of correct, which suits a sooty urban expressway. Neutral with a whisper
     of warmth, and deliberately no longer blue: 0x8d939f carried B 18 points
     over R, and baking the night sky's colour into the albedo as well as the
     lighting is a large part of what made the wall look painted.

     Knock-on, worked through rather than guessed:
       - daylight: albedo 0.027 → 0.146 lit. Against a vertical face's ~0.6x
         sky irradiance that lands the wall at ~0.34 POV display luma next to
         the road's ~0.35 — plainly concrete, no clipping (clip is 0.72).
       - night: the beam wash is albedo-proportional by construction, so it
         rises with it. See the note on WALL_WASH below; it was aimed at a
         read it could never reach on a 0.042 albedo. */
  const CONC_TINT = 0x272523;
  const conc = new THREE.MeshStandardMaterial({
    color: 0x33363f, roughness: 0.82, metalness: 0.0,
  });
  const concDark = new THREE.MeshStandardMaterial({ color: 0x24262e, roughness: 0.87 });
  const barrier = new THREE.MeshStandardMaterial({
    color: CONC_TINT, roughness: 0.84, metalness: 0.0, envMap, envMapIntensity: 0.12,
  });
  const concDouble = new THREE.MeshStandardMaterial({
    color: 0x33363f, roughness: 0.82, metalness: 0.0, side: THREE.DoubleSide,
  });
  const concDarkDouble = new THREE.MeshStandardMaterial({
    color: 0x24262e, roughness: 0.87, side: THREE.DoubleSide,
  });
  const barrierDouble = new THREE.MeshStandardMaterial({
    color: CONC_TINT, roughness: 0.84, metalness: 0.0, envMap, envMapIntensity: 0.12,
    side: THREE.DoubleSide,
  });
  /* Tunnel lining. The self-illumination stands in for the bounce light a real
     tunnel gets off its own tiling — without it the tube goes pitch black a few
     metres past the last batten, because the sun and moon are both outside. */
  const tunnelWall = new THREE.MeshStandardMaterial({
    color: 0x9aa3b2, roughness: 0.35, metalness: 0.12,
    emissive: 0x171b24, emissiveIntensity: 1,
    envMap, envMapIntensity: 0.25, side: THREE.DoubleSide,
  });
  const tunnelCeil = new THREE.MeshStandardMaterial({
    color: 0x2a2d36, roughness: 0.85, side: THREE.DoubleSide,
  });
  /* Sound-barrier mesh panelling. alphaTest, never alpha-blend: cutout keeps
     the depth buffer honest (no sorting artifacts against the glow sprites)
     and costs nothing when the holes are discarded early. The procedural
     canvas carries its own alpha; the photo scan that replaces it splits the
     same data across albedo + alphaMap, and alphaTest composes both. The
     faint emissive floor is skyglow — a panel the headlights haven't reached
     should read as a dim silhouette against the night, not a hole in it. */
  const fence = new THREE.MeshStandardMaterial({
    map: fenceTexF("perf"), color: 0xaeb4bd, roughness: 0.5, metalness: 0.72,
    envMap, envMapIntensity: 0.5, alphaTest: 0.45, side: THREE.DoubleSide,
    emissive: 0x0d1118, emissiveIntensity: 1,
  });
  /* Toll canopy skins. Procedural placeholders; the corrugated/brushed scans
     replace the art in ensurePbr with the same tints multiplied over them. */
  const canopyRoof = new THREE.MeshStandardMaterial({
    color: 0x494e58, roughness: 0.55, metalness: 0.6, envMap, envMapIntensity: 0.35,
  });
  const canopyFascia = new THREE.MeshStandardMaterial({
    color: 0x666d7a, roughness: 0.35, metalness: 0.8, envMap, envMapIntensity: 0.5,
  });
  const catwalk = new THREE.MeshStandardMaterial({
    map: fenceTexF("grate"), color: 0x878c96, roughness: 0.6, metalness: 0.7,
    alphaTest: 0.45, side: THREE.DoubleSide,
    emissive: 0x0b0e14, emissiveIntensity: 1,
  });

  /* Street furniture metal: lamp masts, signal poles, gantry legs. Real
     galvanised steel is anisotropic — it streaks along the roll direction —
     which MeshStandardMaterial cannot express. The scan's roughness map fakes
     it well enough at the distance a pole is ever seen, so metalness stays
     high and the base roughness low enough for the map to work in both
     directions. The dark tint is kept as a multiplier so the poles do not
     brighten into silver posts. */
  const pole = new THREE.MeshStandardMaterial({
    color: 0x2b2e36, roughness: 0.7, metalness: 0.5, envMap, envMapIntensity: 0.4,
  });

  const winMats = [windowsTexF(true), windowsTexF(false), windowsTexF(true)].map(
    (t) =>
      new THREE.MeshStandardMaterial({
        color: 0x0c0e15, map: t, emissive: 0xffffff, emissiveMap: t,
        emissiveIntensity: 1.05, roughness: 0.8,
      })
  );
  const sfT = storefrontTexF();
  const sfMat = new THREE.MeshStandardMaterial({
    map: sfT, emissive: 0xffffff, emissiveMap: sfT, emissiveIntensity: 1.15, roughness: 0.6,
  });
  const vendT = vendingTexF();

  const studParams = {
    size: 2.4, sizeAttenuation: false, map: studTex, color: 0xfff4dc,
    transparent: true, opacity: 0.95, depthWrite: false, fog: true,
    blending: THREE.AdditiveBlending,
  };
  /* Lane paint. polygonOffset and depthWrite:false are load-bearing — with the
     marking geometry sitting only ~22 mm above the deck, they are what keep it
     off the z-fighting knife-edge at distance. Do not drop them.
     The wear map is OPAQUE (dark chips, not holes) so the paint stays out of
     the transparent pass; stripe() in highway.ts tiles its v by arclength so
     no two dashes wear alike. Mean stays near white — the beam retro-multiply
     runs after it, and the goal is holes in the paint, not dimmer paint. */
  const markMat = new THREE.MeshBasicMaterial({
    color: 0xe9edf6, map: paintWearTexF(), fog: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const studMat = new THREE.PointsMaterial(studParams);
  /* The tunnel span gets its own material for one reason: studMat is
     registered in world.neonMats, which the engine fades out with daylight —
     correct for an open road, where a cat's eye is a dull grey lump at noon.
     Inside the tube it is dark at every hour, so daylight-dimming would erase
     the studs exactly where they are doing the most work. This one stays out
     of neonMats and burns at full strength around the clock, for the same
     reason the ceiling battens deliberately are not registered either. */
  const studMatTunnel = new THREE.PointsMaterial(studParams);

  /* Paint fades out of the beam fastest; glass-bead cat's eyes are far more
     efficient reflectors and stay legible much further down the road, which is
     what makes a receding row of them read as a line long after the dashes
     have gone dark. The tunnel studs keep the widest cone — in the tube the
     walls bounce light back onto them from every angle. */
  /* Paint is gated to the width of the light that actually falls on it: 0.95
     is the measured match to the combined two-lamp spot coverage (including
     toe-out and lamp offset), which holds near-constant at ~17 deg from centre
     over 10-60 m, as two cones from the same origin should. Anything wider and
     the shoulder line glows while the tarmac beside it is dark, which is the
     exact artifact the reference photo is about.

     The studs stay deliberately much wider, and the honest reason is not the
     one you would guess. Glass-bead reflectors do return light over a broader
     angle than the beam's nominal cone — true, and it is why they outlive the
     low-beam cut-off at range — but that is not what is doing the work here.
     Match the studs to the spot and the near-field shoulder markers die: at 9 m
     lateral they sit 42 deg off-centre when they are 10 m ahead, so a 0.90 gate
     blanks them inside 20 m, the stretch where they matter most.

     The catch, which matters if anyone revisits this: the headlight spot does
     not reach that stud either (3.4 m half-width at 10 m, 6.3 m at 20 m, and it
     only contains a 9 m offset by 30 m). So the wide gate is lighting studs the
     beam misses — strictly the same artifact the paint was just tightened to
     remove. It stays because it is standing in for light that is genuinely
     absent: a real dipped beam throws a wide near-field wash sideways that a
     single symmetric cone cannot reproduce, and narrowing the spot to a proper
     cut-off threw that wash away.

     So if a night frame ever shows near-field shoulder studs reading too bright
     against dark tarmac, the fix is NOT to tighten this number — it is that the
     foreground light is missing. If a second wide, short foreground cone is
     ever added to the headlight rig, revisit: at that point these studs stop
     compensating and should be re-matched to the light that actually exists. */
  addBeam(markMat, { near: 18, far: 62, spread: 0.95 });
  addBeam(studMat, { near: 40, far: 190, spread: 0.42 });
  addBeam(studMatTunnel, { near: 40, far: 190, spread: 0.3 });
  /* The fence runs beside the road, well off the beam axis, so it gets a wide
     cone and a short throw: panels light up as the car sweeps past them and
     die away behind, which is exactly how a headlight rakes a real barrier.
     This multiplies the *albedo* under the standard lighting model, so inside
     the beam the panel simply shows its true material lit by the real
     headlight SpotLights, and outside it falls to the emissive skyglow floor. */
  addBeam(fence, { near: 24, far: 85, spread: 0.5 });
  /* Concrete parapets. Same rake-as-you-pass read as the fence, but via the
     additive `wash` path — these are lit materials, and the multiplier form
     would darken their ambient night look everywhere outside the beam (see
     addBeam's doc comment). The real headlight SpotLights barely reach a
     vertical face beside the road: the dipped cone is edge-pinned with
     penumbra 1.0, so barrier faces sit in the near-zero rim of its angular
     smoothstep at every distance. Numbers, worked against the POV grade:
     albedo 0.146 linear (the tint above, with the scan normalised to unit
     mean), so peak wash is 0.146 × 0.5 ≈ 0.073 linear → ~0.23 display luma
     after ACES + the dashcam crush — plainly lit concrete, and well under the
     0.72 blown-highlight clip and the ~0.8 hue bleach. Fade is cone × range
     smoothsteps: the wall beside the doors is outside the cone (dark),
     brightens in over ~3-8 m ahead, and dies off 22 → 78 m with the
     smoothstep's own flattening tail —
     no terminator line. High beam stretches the reach via setBeam's range
     multiplier, exactly as the paint does. `barrier` (single-sided) is
     registered too so the pair can never drift apart if it gains a user. */
  /* The gain STAYS at 0.5, and that is the interesting part of this pass.
     The paragraph above used to claim albedo ≈ 0.15 and a ~0.33 display peak;
     the albedo was really 0.042 (see the tint note), so the wash it was
     actually producing peaked near 0.021 linear ≈ 0.04 display — a smudge,
     an order of magnitude short of the read it was written for. The wash is
     albedo-proportional by construction, so correcting the albedo is what
     finally delivers the number that was always intended, and touching the
     gain on top would be tuning against a defect that no longer exists.
     0.146 × 0.5 = 0.073 linear ≈ 0.23 display, still under the 0.33 target
     and nowhere near the 0.72 clip; the weathering's +18 % ceiling puts the
     absolute worst case at 0.086 linear ≈ 0.25. Reach, spread and both
     smoothstep fades are untouched, so nothing about the SHAPE of the fade
     moves — only how much light the wall was ever able to return. */
  /* `rake` is new; everything above it is untouched. Ref 0.11 is the cosine a
     flat parapet face presents over the stretch this wash covers — the near
     barrier sits 2-4 m to the side and the read is dominated by 12-40 m ahead
     — so a flat face still returns exactly the numbers budgeted above and only
     relief moves it. See the RAKE note in addBeam for the whole argument. */
  addBeam(barrier, { near: 22, far: 78, spread: 0.55, wash: 0.5, rake: 0.42, rakeRef: 0.11 });
  addBeam(barrierDouble, {
    near: 22, far: 78, spread: 0.55, wash: 0.5, rake: 0.42, rakeRef: 0.11,
  });
  /* The tunnel lining has the identical defect and needs the identical fix:
     its battens are MeshBasicMaterial (unlit by construction — it is night in
     here, they are meant to read as light sources, not act as them), so the
     only thing lighting the tube is the flat emissive floor plus the ambient
     bump engine.ts adds on entry. Every one of those is normal-free, which is
     why a tiled wall with a good scan on it still reads as a painted cylinder.

     Gain is 0.14, not the parapets' 0.5, and that is not a taste call: the
     tile albedo is roughly 3.5x the parapet's (0x9aa3b2 over a scan whose mean
     is 0.815, ≈ 0.52 linear, against concrete's 0.146), so matching the
     parapet's peak in LINEAR terms is what keeps one wall from blowing out
     while the other is correct. 0.52 x 0.14 x 1.45 = 0.106 linear, just under
     the parapets' 0.125. Ref 0.24: the bore wall stands 1.55 m outboard of the
     pavement edge, so it is a good deal less grazing than a parapet and using
     the parapet's 0.11 would have brightened the whole tube by a third as a
     side effect. Reach is shorter too — a tunnel is not a 78 m view. */
  addBeam(tunnelWall, { near: 14, far: 52, spread: 0.44, wash: 0.14, rake: 0.34, rakeRef: 0.24 });
  /* The bright top edge. Gain 0.40 against the 0.146 parapet albedo adds 0.058
     linear at a fully up-facing texel, which puts the coping near 0.095 linear
     against the face's ~0.073 under the beam wash — a step you read as an edge
     rather than as two different materials, and both ends of it comfortably
     clear of post.ts's 0.06 black cliff so the fade stays a fade. Exponent 1.6
     keeps the term alive on the coping's arris and on a leaning screen wall's
     capping instead of collapsing the instant a face is off-horizontal.
     Applied AFTER addBeam and BEFORE weatherSurface so the hooks compose in
     the one direction the cache keys assume. No tunnel: there is no sky in
     there, and the battens are below the crown anyway. */
  addCopingCatch(barrier, 0.4);
  addCopingCatch(barrierDouble, 0.4);

  /* Weathering, installed AFTER addBeam so its albedo edit lands upstream of
     the wash that reads that albedo, and BEFORE the async projectedUv so the
     cache keys compose in one direction only (projuv|weather|beam|…).

     Parapets carry the full kit. The joint pitch is 4.6 m — a real slipformed
     contraction-joint spacing, and deliberately not a multiple of either the
     scan's 2.22 m projected tile or highway.ts's 8 m wall segment, so the two
     periods never line up into a single stronger beat.

     The deck fascia gets the same treatment at a longer 11.5 m pitch (box-
     girder segment joints) and heavier streaking: a bridge soffit and its
     girder faces streak harder than a parapet does, because everything that
     lands on the deck drains over that edge. `concDark` (piers, ramp skirts)
     is left out on purpose — it is already near-black, so proportional
     weathering does nothing you can see, and it is drawn as an InstancedMesh
     whose scan UVs projectedUv cannot vary per instance anyway. */
  /* `relief` is metres of real groove depth, and the number is arrived at
     rather than dialled: the groove's wall spans jw → 3·jw in the shader, i.e.
     about 22 mm of face at close range, so 16 mm of depth is a slope of ~0.73
     across it, ~36 degrees. A real slipformed contraction joint is 15-25 mm
     deep with near-vertical sides, so this sits just inside honest. */
  /* grit 0.30 with the atlas's sigma of 20/255 gives the parapet an albedo
     spread of about +/- 4.7 % at the 2-35 cm scale, against the photo scan's
     2.7 % at 0.2-1.0 m and nothing at all in between before this. gritScale
     1.7 m is the atlas's authoring scale, and is deliberately incommensurate
     with both the scan's 2.22 m projection and the 4.6 m joint pitch.

     0.30 and not the 0.55 this was first tuned to, and scanBoost 1.6 and not
     2.4, because the reference the user is aiming at settles the question: the
     barrier in it carries almost NO surface detail. A real concrete parapet at
     night is a plain grey object. What makes it read is the light on it — the
     bright coping, the face falling into black, the beam raking past — not
     what is printed on it, and a wall covered in visible mottling would be a
     different and equally wrong kind of fake. The grit's job here is only to
     stop the surface being a mathematically flat card, which takes far less
     than it looks like it should on a texture viewer. `__wall.grit` brackets
     the whole question live: 0 removes it, 1 is roughly the old 0.55. */
  const PARAPET_WEATHER: WeatherOpts = {
    macro: 0.13, streak: 0.17, joint: 0.34, jointPitch: 4.6,
    section: 0.075, topClean: 0.1, rough: 0.22, normalise: true, relief: 0.016,
    grit: 0.3, gritScale: 1.7, gritRelief: 1, band: 0.22, scanBoost: 1.6,
  };
  /* NO relief on the fascia, and that is a cost cut made on the strength of
     the note that used to argue for a shallow one. It said a box-girder
     segment joint is a sealed construction joint rather than a slipformed
     groove, that the fascia carries no beam wash (it faces away from the
     road), and that its relief therefore "only ever answers ambient and the
     env cube". Both halves of that are worse than it allowed: `conc` and
     `concDouble` are declared with no envMap at all, and AmbientLight is
     normal-free by definition — so after dark the only thing left reading a
     perturbed normal down there is HemisphereLight at 0.05 intensity. Nine
     millimetres of groove tilts the normal a couple of degrees; times 0.05
     that is not a visible quantity.

     What it costs is not small, because `relief` is what sets `anyRelief` and
     `anyRelief` is what compiles the Mikkelsen surface-gradient block into the
     shader: 4 derivative instructions, two cross products, a dot and a
     normalize on EVERY fascia and soffit fragment, on every tier, to move a
     height field that is identically zero except within about 2 cm of a joint
     line at an 11.5 m pitch. That is worse than a fade that multiplies out to
     zero — it is a full gradient taken of a field that is flat almost
     everywhere.

     The joint does not disappear with it: `joint: 0.28` still darkens the
     groove, and an albedo groove is what you actually read on a girder face
     lit by ambient. Put `relief: 0.009` back if a DAYLIGHT pass shows the
     soffit going flat — the sun is the one light that would notice. */
  const FASCIA_WEATHER: WeatherOpts = {
    macro: 0.15, streak: 0.24, joint: 0.28, jointPitch: 11.5,
    section: 0.06, topClean: 0.04, rough: 0.2,
    // a girder face is seen from further away and mostly in the mirrors, so
    // the grit tiles coarser (its fine end would be below a pixel anyway) and
    // carries no relief — nothing rakes it
    grit: 0.3, gritScale: 2.6, band: 0.26,
  };
  // one shared opts object per family, so the single- and double-sided halves
  // can never drift apart the way a pair of literals eventually would
  weatherSurface(barrier, PARAPET_WEATHER);
  weatherSurface(barrierDouble, PARAPET_WEATHER);
  weatherSurface(conc, FASCIA_WEATHER);
  weatherSurface(concDouble, FASCIA_WEATHER);
  /* The tube had no weathering at all, which is most of why it read as a
     painted cylinder: a road tunnel's tiling is the filthiest surface on the
     whole alignment — diesel soot above the dado, a black band at splash
     height, and a drip run under every joint in the lining. No joints (the
     course lines are in the tile scan) and NO GRIT: that atlas is cast
     concrete, and aggregate pocking on glazed ceramic would be plainly wrong.
     Bands do the heavy lifting instead, and they suit a tunnel even better
     than a parapet — real tubes are filthy in long stretches and freshly
     washed in others. */
  weatherSurface(tunnelWall, {
    macro: 0.16, streak: 0.26, joint: 0, section: 0, topClean: 0.05,
    rough: 0.3, band: 0.3, macroScale: 14.0, streakScale: 2.2,
  });
  /* The ceiling is concrete, up-facing, and already near-black; streaks and
     bands are for walls, so this is mottle and grit only — enough to stop the
     crown reading as one grey plane sliding past the battens. */
  weatherSurface(tunnelCeil, {
    macro: 0.15, streak: 0.05, joint: 0, section: 0, topClean: 0,
    rough: 0.18, grit: 0.45, gritScale: 2.2, macroScale: 9.0,
  });
  /* Galvanised sheet, not concrete: no joints (the panel seams are drawn into
     the cutout art), a longer macro field because a rolled sheet's patina
     drifts over metres not decimetres, and the oxide bleed switched on so the
     runs below a broken fixing go rust-brown instead of just dark. Amplitudes
     are half the concrete's — zinc weathers, but it does not get dirty the way
     a poured wall does. */
  weatherSurface(fence, {
    macro: 0.09, streak: 0.1, joint: 0, section: 0, topClean: 0,
    rough: 0.16, rust: 0.35, macroScale: 17.0, streakScale: 3.6,
  });

  const mats: Mats = {
    envMap, glowTex, streakTex, smokeTex, chevTex, goreTex, xingTex, studTex,
    road, front, hwy, ramp,
    ground: new THREE.MeshStandardMaterial({ color: 0x0b0c12, roughness: 0.92, metalness: 0.05 }),
    sidewalk: new THREE.MeshStandardMaterial({
      color: 0x191b23, roughness: 0.85, side: THREE.DoubleSide,
    }),
    conc,
    concDark,
    barrier,
    concDouble,
    concDarkDouble,
    barrierDouble,
    tunnelWall,
    tunnelCeil,
    fence,
    canopyRoof,
    canopyFascia,
    catwalk,
    studMat,
    studMatTunnel,
    markMat,
    addBeam,
    setBeam(on, pos, dir, dayF, unlitFloor = 0.18, range = 1) {
      uBeamPos.value.copy(pos);
      uBeamDir.value.copy(dir).normalize();
      uBeamRange.value = range > 0 ? range : 1;
      /* Outside the beam the paint is not black — skyglow, streetlights and
         the car's own spill still catch it. At noon the floor rises to 1 and
         the effect vanishes, which is correct: sunlight lights the markings
         from everywhere, so there is no beam to be outside of.

         Note for anyone retuning this against a change in scene lighting:
         every material this touches is UNLIT (MeshBasicMaterial and
         PointsMaterial), so the ambient and hemi levels do not reach them.
         Crushing the night ambient darkens the road but leaves the markings
         where they were, which *raises* marking-to-road contrast rather than
         lowering it. This floor is the only thing that dims unlit paint at
         night, which is why it is a parameter — see setBeam's doc comment. */
      const night = 1 - Math.min(Math.max(dayF, 0), 1);
      // a brightness, so 0..1 by definition — clamped because `unlitFloor` and
      // `range` are adjacent number parameters and transposing them would
      // typecheck perfectly
      const floor = Math.min(Math.max(unlitFloor, 0), 1);
      uBeamAmb.value = 1 - (1 - floor) * night;
      uBeamK.value = on ? night : 0;
      /* Night, on its own, for anything that is lit by the CITY rather than by
         the car. uBeamK is no use for that — it is zero with the headlights
         switched off, and a streetlight does not care. Set here only because
         setBeam is already the one call the engine makes every frame with the
         daylight factor in hand; nothing about the beam reads it. */
      uNight.value = night;
    },
    soundwall: new THREE.MeshStandardMaterial({
      color: 0x2c4438, roughness: 0.75, transparent: true, opacity: 0.85,
    }),
    pole,
    winMats,
    sfMat,
    vendMat: new THREE.MeshStandardMaterial({
      map: vendT, emissive: 0xffffff, emissiveMap: vendT, emissiveIntensity: 0.9, roughness: 0.5,
    }),
    clutterMat: new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.8 }),
    refMats,
    addReflection: reflectionUniforms,
    setReflectionTexture(tex) {
      pendingRefTex = tex;
      for (const m of refMats) if (ud(m).sh) ud(m).sh!.uniforms.tRef.value = tex;
    },
    setReflectionScreen(w, h) {
      screen.set(w, h);
    },
    setWet(on, reflectionsOn) {
      wetState = on;
      wetRefOn = reflectionsOn;
      const rough = on ? 0.13 : 0.4;
      setRough(road, rough);
      setRough(front, rough);
      setRough(hwy, rough - 0.02);
      setRough(ramp, rough);
      for (const m of refMats) {
        const d = ud(m);
        /* Wet vs dry is a big multiplier, not a small one, because it is the
           real difference: dry asphalt scatters nearly everything and returns
           a barely-there sheen at grazing angles, standing water returns a
           near-mirror. The dry share is deliberately not zero — a dry road at
           night still picks up a faint smear under a lamp — but at 0.4 the
           Fresnel term has to be almost fully grazing before anything shows.

           This is what the old disabled-outright `const str = 0` replaced.
           The white patches it was cut for came from the SOURCE (a full scene
           re-render, sky included), not from this number; the source is now
           the bright pass, so the strength is live again. */
        const str = reflectionsOn ? d.refStr * (on ? 2.0 : 0.4) * refGain : 0;
        d.curStr = str;
        if (d.sh) d.sh.uniforms.uRefStr.value = str;
        /* Puddle-patch modulation is a rain effect. On a dry road the scan's
           smooth patches were still mirroring up to 3x at grazing angles, so
           bright signage reflected as hard-edged patches far ahead that faded
           out on approach (Fresnel steepening) — the "square of light that
           vanishes as you reach it" artifact. Dry roads keep only a whisper
           of patch variation; rain restores the full standing-water look. */
        d.curRoughMod = (on ? 1 : 0.15) * d.roughMod;
        if (d.sh && d.sh.uniforms.uRoughMod)
          d.sh.uniforms.uRoughMod.value = d.curRoughMod;
      }
    },
    setPbrDetail(on) {
      /* Turning detail on is also what starts a deferred load, so a session
         that booted on the low preset — and so never downloaded the scans —
         picks them up the first time the player raises the quality setting.
         Deliberately before the early-return: the very first call may be
         setPbrDetail(true) with detail already nominally on. */
      if (on) void ensurePbr();
      if (detailOn === on) return;
      detailOn = on;
      /* Weathering rides the same switch: three extra texture fetches (two
         grime, one grit) and a couple of hundred ALU on every concrete and
         fence fragment. Flipping the shared uniform rather than recompiling is
         deliberate — the branch it guards is uniform-valued, so it is fully
         coherent and the GPU skips the body outright, and nobody eats a
         shader-compile hitch mid-drive for a quality toggle.

         Note this is the OUTERMOST of three nested uniform gates and it
         subsumes both inner ones: uWeatherK = 0 already skips the grit fetch
         and the surface-gradient block, so perfCheck()'s automatic drop needs
         no knowledge of TierCaps.wallDetail and there is no second mechanism
         to keep in step with this one. wallDetail gates the same work a level
         further in, for devices that are not in trouble yet. */
      uWeatherK.value = on ? 1 : 0;
      /* Perf mode drops the two extra road texture fetches per pixel — the
         detail albedo and the normal map — while keeping the roughness map,
         which is the cheap one and the one carrying the wet-road look. */
      for (const m of refMats) {
        const d = ud(m);
        if (!d.detTex && !d.normalTex) continue;
        m.normalMap = on ? d.normalTex : null;
        m.needsUpdate = true; // recompile: the detail sampler is compiled in or out
      }
    },
  };

  /** Set a road's *effective* roughness, compensating for the scan's own mean. */
  function setRough(mat: THREE.MeshStandardMaterial, target: number) {
    const d = ud(mat);
    d.dryRough = target;
    // roughnessFactor = roughness * texel.g, and texel.g averages 1/roughK, so
    // scaling the base by roughK lands the *average* roughness on `target`
    // whether or not a scan is present
    mat.roughness = target * d.roughK;
    if (d.sh?.uniforms.uRoughRef) d.sh.uniforms.uRoughRef.value = target;
  }

  /* ---------------- async photo-scan upgrade ---------------- */

  /** Layer a scan onto a road surface: detail albedo + real normal/roughness. */
  function upgradeRoad(mat: THREE.MeshStandardMaterial, set: PbrSet, o: PbrOpts) {
    if (!set.albedo) return;
    const d = ud(mat);
    const rep = new THREE.Vector2(o.repeat[0], o.repeat[1]);
    d.detTex = retile(set.albedo, rep);
    d.detMean = set.albedoMean;
    d.detK = o.detail ?? 0.85;
    d.detRep = rep;
    d.roughMod = o.roughMod ?? 0.85;
    if (set.normal) {
      d.normalTex = retile(set.normal, rep);
      if (detailOn) mat.normalMap = d.normalTex;
      const ns = o.normalScale ?? 0.35;
      mat.normalScale = new THREE.Vector2(ns, ns);
    }
    if (set.rough) {
      mat.roughnessMap = retile(set.rough, rep);
      d.roughK = 1 / Math.max(set.roughMean, 0.05);
    }
    setRough(mat, o.roughness ?? d.dryRough);
    mat.needsUpdate = true;
  }

  /** Replace a non-road material's art outright. */
  function upgradeSurface(mat: THREE.MeshStandardMaterial, set: PbrSet, o: PbrOpts) {
    if (!set.albedo) return;
    const rep = new THREE.Vector2(o.repeat[0], o.repeat[1]);
    mat.map = retile(set.albedo, rep);
    // the tuned tint stays as a multiplier over the scan, which is how the
    // tunnel lining keeps reading as pale tile and the barriers as dirty grey
    if (set.normal) {
      mat.normalMap = retile(set.normal, rep);
      mat.normalScale = new THREE.Vector2(o.normalScale ?? 0.7, o.normalScale ?? 0.7);
    }
    if (set.rough) {
      mat.roughnessMap = retile(set.rough, rep);
      mat.roughness = (o.roughness ?? mat.roughness) / Math.max(set.roughMean, 0.05);
    }
    if (set.metal) mat.metalnessMap = retile(set.metal, rep);
    // cutout sets: the scan's opacity map replaces the alpha baked into the
    // procedural canvas; alphaTest carries over unchanged
    if (set.alpha) mat.alphaMap = retile(set.alpha, rep);
    mat.needsUpdate = true;
  }

  /* A Texture clone shares its `source`, so the pixels are uploaded to the GPU
     once no matter how many materials tile the same scan differently. */
  function retile(t: THREE.Texture, rep: THREE.Vector2) {
    if (t.repeat.x === rep.x && t.repeat.y === rep.y) return t;
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.copy(rep);
    c.needsUpdate = true;
    return c;
  }

  /* LIVE PREVIEW, same idea as window.__aurora. A grazing-light effect only
     exists while you are moving past it, so it cannot be judged from a still
     and it certainly cannot be judged across a rebuild. All three of these are
     uniforms (normalScale included — three sends it per frame, it does not
     recompile), so an assignment lands on the next frame:

       __wall.coping = 0        the barrier's bright top edge, off
       __wall.rake = 0          the walls go back to flat-lit exactly
       __wall.grit = 0          drops the procedural detail layer
       __wall.relief = 0        drops the joint grooves' and grit's relief
       __wall.normalScale = 0.85   the previous scan normal strength

     and one more that is a PERF control rather than a look control:

       __wall.detail = 1        what desktop ships
       __wall.detail = 0.5      grit, no relief — the mobile-high setting
       __wall.detail = 0        neither: the tGrit fetch and the whole
                                surface-gradient block are skipped outright

     `detail` is the one to reach for when the question is "is the concrete
     what is costing me frames?" rather than "does the concrete look right".
     It drives uGritK and uReliefK together, and both are tested against a
     UNIFORM inside the shader, so 0 makes the GPU jump over the body instead
     of multiplying a computed result by zero — the frame time moves or it does
     not, and either answer is the diagnosis. It seeds from TierCaps.wallDetail
     (1 / 0.5 / 0 down the tiers) and setting it by hand overrides that for the
     session without touching the saved profile.

     Setting all five look knobs restores the pre-change look bit for bit,
     which is the point: A/B it at speed rather than from memory. Reach for
     `coping` first —
     it is the one that decides whether the barrier reads as an edge of the
     road at all, and it is the term the reference frame is really built on.
     `grit` second, and note it is deliberately low: 0 / 0.5 / 1 / 2 brackets
     it, and 1 is roughly where an earlier pass had it before the reference
     made the case for a plainer wall. */
  if (DEBUG_HOOKS && typeof window !== "undefined") {
    const concFamily = [
      conc, concDouble, concDark, concDarkDouble, barrier, barrierDouble, tunnelCeil,
    ];
    (window as unknown as { __wall?: unknown }).__wall = {
      get rake() { return uBeamRake.value; },
      set rake(v: number) { uBeamRake.value = v; },
      get relief() { return uReliefK.value; },
      set relief(v: number) { uReliefK.value = v; },
      get grit() { return uGritK.value; },
      set grit(v: number) { uGritK.value = v; },
      get coping() { return uCopingK.value; },
      set coping(v: number) { uCopingK.value = v; },
      /* The perf lever: 1 / 0.5 / 0 in one assignment. Reading it back reports
         the LEVEL rather than either uniform, so `__wall.detail` round-trips
         even after someone has poked `grit` or `relief` on their own. */
      get detail() { return uGritK.value > 0 ? (uReliefK.value > 0 ? 1 : 0.5) : 0; },
      set detail(v: number) {
        uGritK.value = v > 0 ? 1 : 0;
        uReliefK.value = v >= 1 ? 1 : 0;
      },
      get normalScale() { return barrier.normalScale.x; },
      set normalScale(v: number) { for (const m of concFamily) m.normalScale.set(v, v); },
    };
  }

  if (usePbr) void ensurePbr();

  /** Fetch and apply the photo scans. Idempotent — safe to call repeatedly. */
  async function ensurePbr() {
    if (pbrStarted) return;
    pbrStarted = true;
    /* Every await here is failure-tolerant by construction: loadPbrSet always
       resolves, and an absent set has a null albedo which every upgrade path
       returns early on. A missing assets directory costs four 404s and leaves
       the procedural look untouched. */
    const [
      asphaltSet, wornSet, concreteSet, metalSet,
      fenceSet, tileSet, corrSet, plateSet, walkSet,
    ] = await Promise.all([
      loadPbrSet("asphalt"),
      loadPbrSet("asphalt_worn"),
      loadPbrSet("concrete"),
      // the directory keeps ambientCG's "guardrail" name (see ATTRIBUTIONS.md);
      // this world has no guardrails, so the metal goes on the street furniture
      loadPbrSet("guardrail", undefined, true),
      // Lane A world dressing (all CC0 — ambientCG): perforated fence,
      // tunnel tile, corrugated canopy roof, brushed fascia, grated catwalk
      loadPbrSet("fence", undefined, true, true),
      loadPbrSet("tile"),
      loadPbrSet("corrugated", undefined, true),
      loadPbrSet("plates", undefined, true),
      loadPbrSet("walkway", undefined, false, true),
    ]);

    /* Repeats are expressed in the mesh's own UV space, which differs per
       surface. The highway deck is laid out in 7 m tiles (see TILE in
       highway.ts), so 2 repeats puts one scan tile every ~3.5 m — close to the
       real-world size of the scanned patch. The town streets run u across the
       full carriageway and v every 14 m, hence the larger numbers. */
    // the worn scan is the better read for a motorway deck; fall back to the
    // fresh one if only that half of the drop has landed
    const deck = wornSet.albedo ? wornSet : asphaltSet;
    upgradeRoad(hwy, deck, {
      repeat: [2, 2], normalScale: 0.3, detail: 0.9, roughness: 0.38, roughMod: 0.9,
    });
    upgradeRoad(road, asphaltSet, {
      repeat: [4, 4], normalScale: 0.32, detail: 0.85, roughness: 0.4, roughMod: 0.85,
    });
    upgradeRoad(front, asphaltSet, {
      repeat: [4, 4], normalScale: 0.32, detail: 0.85, roughness: 0.4, roughMod: 0.85,
    });
    upgradeRoad(ramp, deck, {
      repeat: [2, 3], normalScale: 0.3, detail: 0.8, roughness: 0.4, roughMod: 0.8,
    });

    /* Concrete and metal are world-projected, so their density is set by the
       projection scale rather than a uv repeat: 0.45 puts one scan tile every
       ~2.2 m of wall, which keeps the aggregate at life size on a 1 m parapet.
       projectedUv() must be installed before the upgrade, because it replaces
       onBeforeCompile and the upgrade is what flags the recompile. */
    /* `soundwall` is deliberately absent from this list and must stay absent:
       it is a translucent polycarbonate noise barrier, not concrete, and an
       aggregate scan on it would look like a wall made of gravel. Note also
       that highway.ts clones it (swMat, for DoubleSide), so adding it here
       would silently do nothing anyway — if it ever does need a scan it needs
       a shared double-sided variant first, the way the parapets got one. */
    /* Hand the parapets the scan's own mean so their tint becomes their real
       albedo (see the CONC_TINT note). Measured, not hardcoded: re-drop the
       concrete set and the walls stay at the same brightness. Clamped because
       a black or unreadable albedo would otherwise divide the world by ~0 —
       measureMean already guards that, and this is the second belt. */
    if (concreteSet.albedo) {
      uConcAlb.value = 1 / Math.min(Math.max(concreteSet.albedoMean, 0.02), 1);
      for (const m of [
        conc, concDouble, concDark, concDarkDouble,
        barrier, barrierDouble, tunnelCeil,
      ]) {
        projectedUv(m, 0.45);
        /* normalScale 0.65 → 0.85 → 1.4. Relief is the other half of the
           "takes light uniformly" problem the weathering pass is fixing: the
           scan's normals are the only thing that makes the headlight rake
           across the face's form-work texture at a grazing angle instead of
           gliding over it. 0.65 was set when the material also carried a
           metalness sheen to lean on; with metalness at 0 the normals have to
           do that work alone.

           The earlier ceilings ("left below 1.0 so the aggregate does not
           start reading as gravel") were set against an assumed map, not a
           measured one. Measured: Concrete033's normal is nearly flat — xy
           sigma is 6.8/255, about 4 degrees of tilt at the old 0.85, and the
           map is not even unit length (mean vector length 0.676, so three's
           normalize() is already scaling it up by ~1.5x before we get a say).
           For scale, the tile set on the tunnel walls carries 2.5x the xy
           spread. There is no gravel anywhere near this map; the risk it was
           being protected from does not exist. 1.4 puts the typical tilt at
           ~6.8 degrees, which is ordinary board-marked concrete, and the rake
           term in addBeam is what turns that into something you can see. */
        upgradeSurface(m, concreteSet, {
          repeat: [1, 1], normalScale: 1.4, roughness: m.roughness,
        });
      }
    }
    /* Tunnel walls get real ceramic tile (the classic urban-tunnel band) in
       preference to bare concrete; concrete remains the fallback so a partial
       asset drop still upgrades the tube. Roughness sits well below the
       concrete's: a glazed tile wall is what lets the headlights and the
       batten glow streak along the tube, which is most of the AC night read.
       0.6 projection scale ≈ a 1.7 m tile course — close to life size. */
    {
      const wallSet = tileSet.albedo ? tileSet : concreteSet;
      if (wallSet.albedo) {
        projectedUv(tunnelWall, tileSet.albedo ? 0.6 : 0.45);
        upgradeSurface(tunnelWall, wallSet, {
          repeat: [1, 1], normalScale: 0.9,
          roughness: tileSet.albedo ? 0.24 : tunnelWall.roughness,
        });
        if (tileSet.albedo) {
          tunnelWall.envMapIntensity = 0.35;
          // let the grout lines carry contrast: the flat self-illumination is
          // only the floor that keeps the tube from going black
          tunnelWall.emissive.setHex(0x111520);
        }
      }
    }
    /* Lane A dressing materials — straight art replacement, tuned tints kept
       as multipliers exactly like the concrete family above. */
    if (fenceSet.albedo)
      upgradeSurface(fence, fenceSet, { repeat: [1, 1], normalScale: 0.8, roughness: 0.5 });
    if (corrSet.albedo) {
      projectedUv(canopyRoof, 0.55);
      upgradeSurface(canopyRoof, corrSet, { repeat: [1, 1], normalScale: 0.85, roughness: 0.55 });
    }
    if (plateSet.albedo)
      upgradeSurface(canopyFascia, plateSet, { repeat: [3, 1], normalScale: 0.5, roughness: 0.35 });
    if (walkSet.albedo)
      upgradeSurface(catwalk, walkSet, { repeat: [1, 1], normalScale: 0.7, roughness: 0.6 });
    /* Poles are cylinders and boxes with real UVs, so no projection here — and
       none is possible anyway, since an InstancedMesh's modelMatrix is the
       batch's transform, not the per-instance one, and every pole would end up
       sampling the identical patch. The repeat is tuned to the mast geometry
       rather than to metres. */
    upgradeSurface(pole, metalSet, {
      repeat: [1, 4], normalScale: 0.45, roughness: 0.7,
    });
  }

  /* Live console knobs for the wet-road reflection. World materials are built
     once, so a hot reload will NOT show a change to any of the constants
     above — this is how the balance gets found without a rebuild:

       __wetTune.gain = 2        // whole effect stronger (or 0 to A/B it off)
       __wetTune.max = 0.7       // raise the soft ceiling; watch for bleaching
       __wetTune.hi = 9          // reflect taller sources (lamp heads)
       __wetTune.lo = 0.8        // reflect lower ones (tail lights)
       __wetTune.loW = 0.7       // bias the blend toward the low tap
       __wetTune.wet = true      // force the wet road without waiting for rain

     The four uniform objects are shared by every road material, so each write
     lands on all of them; `gain` and `wet` go back through setWet because the
     strength is computed per material. */
  if (typeof window !== "undefined") {
    const apply = () => mats.setWet(wetState, wetRefOn);
    const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
    (window as unknown as { __wetTune: unknown }).__wetTune = {
      get gain() { return refGain; },
      set gain(v: number) { refGain = Math.max(0, num(v, REF_GAIN)); apply(); },
      get wet() { return wetState; },
      set wet(v: boolean) { mats.setWet(!!v, wetRefOn); },
      get max() { return uRefMax.value; },
      set max(v: number) { uRefMax.value = Math.max(0.02, num(v, REF_MAX)); },
      get hi() { return uRefHi.value; },
      set hi(v: number) { uRefHi.value = Math.max(0.05, num(v, REF_H_HI)); },
      get lo() { return uRefLo.value; },
      set lo(v: number) { uRefLo.value = Math.max(0.05, num(v, REF_H_LO)); },
      get loW() { return uRefLoW.value; },
      set loW(v: number) { uRefLoW.value = Math.min(1, Math.max(0, num(v, REF_LO_W))); },
    };
  }

  return mats;
}
