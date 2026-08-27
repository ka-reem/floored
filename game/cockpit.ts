import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rand, randi, TAU } from "./util";
import { makeTex, loadPbrSet } from "./textures";
import { buildInstrumentCluster } from "./dashboard";
import { loadProfile, resolveRenderTier, TIER_CAPS, type SpeedUnits } from "./settings";
import { drawCarScreen, type ScreenMusic, type ScreenUI } from "./carscreen";
import type { WorldData } from "./world/data";
import type { CarState } from "./physics";
import type { Npc } from "./traffic";

/* RHD cockpit: dash, doors, console, seats, instrument cluster (dashboard.ts),
   nav screen, mirrors (RT-fed), steering wheel + hands, wipers and the rain
   droplet windshield overlay. Accent colour + dial redline vary per car.

   Geometry notes that are easy to get wrong here:

   - The eye sits at roughly (0.36, 1.29, 0.10) and looks toward +z, so the
     cabin-facing surface of the dash is its LOW-z face. Anything modelled at
     z past the dash pad's rear edge is inside the dash and invisible; the
     facia therefore lives at z ~= 0.55 and the pad rolls over above it rather
     than overhanging back toward the seat.
   - Everything the driver reads has to face the seat: a plane left facing +z
     is back-face culled from the eye, so the cluster and the nav screen are
     yawed by PI.
   - Static trim is merged per material (see put/flush), so the whole interior
     is ~a dozen draw calls no matter how much detail goes in. Only the things
     that move or own a canvas stay as individual meshes. */

export interface Cockpit {
  group: THREE.Group;
  wheelGroup: THREE.Group;
  wiperA: THREE.Group;
  wiperB: THREE.Group;
  mirrorParts: THREE.Mesh[];
  /** The rear-view glass plane specifically (also mirrorParts[0]): post.ts
   * projects its corners through the POV camera to shield the mirror from the
   * dashcam degrade, so it needs the mesh — geometry + live matrixWorld — by
   * name rather than by array position. */
  mirrorGlass: THREE.Mesh;
  /** Bezel + shell around the glass. Outside the "mirror" merge region on
      purpose, so a donor that replaces the region does not leave the glass
      unframed — see where it is built. */
  mirrorFrame: THREE.Group;
  /** The cool "city light through the glass" point light. Exposed because the
   * engine rakes it front-to-back once per streetlight pitch, so a passing
   * lamp reads as a wash sweeping over the trim; see LAMP_WASH in engine.ts. */
  glassLight: THREE.PointLight;
  /** Level of the cabin's own DOME light, as a multiple of CABIN_DOME — the
      warm header lamp that fills the trim from inside. 0 puts the cabin in the
      dark, which is the shipped default; engine.ts drives it off the I key and
      window.__cabinLight. See the light itself for why this is an intensity
      write and not a `visible` flip. */
  setCabinLight(k: number): void;
  /** Click volume for the overhead console — the roof panel the dome light is
      set into — so setCabinLight's switch can be reached with the mouse as
      well as with the I key. `imported` selects the donor cabin's console over
      the procedural one; the two roofs are 28 cm apart and only the one
      belonging to the cabin on show may be live. Returns an Object3D to be
      raycast RECURSIVELY: see where the volumes are built. */
  cabinSwitch(imported: boolean): THREE.Object3D;
  setMirrorVis(v: boolean): void;
  drawGauges(rpm: number, kmh: number, gearTxt: string, now: number, flags: GaugeFlags): void;
  /** Repaint the head unit. Takes the world/car/traffic the HUD minimap
   * takes, because the nav pane now draws that same map (carscreen.ts).
   * `time` is the in-game clock in hours, `now` the engine seconds clock.
   * `ui` is which pane is on show and what the cursor is over — engine.ts owns
   * that, because engine.ts is where the pointer is. */
  drawScreen(world: WorldData, car: CarState, npcs: Npc[], time: number, now: number,
            music?: ScreenMusic, ui?: ScreenUI): void;
  dropletsUpdate(dt: number, wiping: boolean, wiperRotZ: number, raining: boolean, speed: number): void;

  /* --- swap points for an imported dash (cockpitmodel.ts) ------------------
     The procedural dash stays built and stays the fallback; a donor model
     hides these and re-anchors the live parts onto its own geometry. */

  /** Merged trim by swappable region. "dash" is the pad, binnacle, vents,
      stack, console and head-unit body; "cabin" is the door cards, pillars,
      roof and headliner. Seats, glass, light strips and mirrors are in
      neither and always stay procedural. A donor hides only the regions it
      actually supplies. */
  regionGroups: Record<string, THREE.Group>;
  /** The live instrument cluster. Re-anchored onto the donor's binnacle rather
      than rebuilt: the needles are real geometry, not a texture. */
  clusterGroup: THREE.Group;
  /** The five hand-placed window panes (front doors, rear doors, backlight).
      Exposed so a donor cabin can hide them: they sit outside every merge
      region, so the donor's "cabin" takeover does not reach them, and their
      positions describe the PROCEDURAL cabin's openings only. */
  windowGlass: THREE.Mesh[];
  /** The head unit's glass plane. Hidden when a donor supplies its own. */
  screenMesh: THREE.Mesh;
  /** The canvas behind that plane. Bound onto the donor's screen material so
      the nav map keeps drawing wherever the screen physically ends up. */
  screenTexture: THREE.Texture;
  /** The donor's own centre screen, once cockpitmodel.ts has re-bound the nav
      canvas onto it — null while the procedural tablet is the head unit. */
  donorScreen: THREE.Mesh | null;
  /** Whichever screen is actually on show. post.ts projects it for the POV
      screen shield (the same treatment the mirror glass gets), so it has to
      follow the donor swap — and the swap can happen long after the rig was
      built, since the donor loads asynchronously. */
  navPanel(): THREE.Mesh;
}

/** Rest state of `glassLight` — the pose and look it has when nothing is
    driving it. The engine's streetlight wash animates away from these values
    and must be able to put them back exactly, so they live here rather than as
    literals at the construction site. */
export const GLASS_REST = { y: 1.14, z: 1.0, intensity: 0.5, color: 0xbfd0ff };

/** Full-on level of the cabin's warm header lamp — the DOME light, the thing
    the I key switches. Authored here so engine.ts's knob can stay a plain
    multiplier and the tuned number never has to leave this file. Its
    counterpart, GLASS_REST above, is OUTSIDE light coming in and is not on the
    switch: it is what gives the pad its grazing sheen when the cabin is dark. */
export const CABIN_DOME = 0.45;

/* The wiper sweep, as two numbers rather than five copies of two numbers.

   `rest` is the RAISED end of the travel and `park` is the swept-down end,
   laid along the base of the glass. The arms are built pointing +Y (mkWiper
   below), so a rotation.z near zero stands one UPRIGHT across the windscreen
   and -1.35 rad (-77 deg) lays it down.

   Which end is which is the whole reason this is exported. engine.ts eased the
   arms back to a hardcoded -0.12 when the rain stopped — the raised end — and
   left two wipers standing up across the glass in clear weather, reported as
   "the windshield wipers get stuck upwards not down". Nothing about a loose
   -0.12 says which end of a travel it names, and there were three of them.
   Now the sweep's two ends are named once and every site derives from them:
   the build pose, wiperCanvasWipe's mapping back to sweep phase, and
   engine.ts's animation and park.

   Retuning the sweep moves all of them together, which is the point. */
export const WIPER = { rest: -0.12, sweep: 1.23, park: -0.12 - 1.23 };

/* Dimensions the fixed interior geometry was modelled against (first car's shell) */
export const COCKPIT_REF = { belt: 0.82, W: 1.84 };

/* The driver's eye, in cockpit-local space and authoritative: engine.ts reads
   all three components from here (it offsets y by belt - COCKPIT_REF.belt and
   scales x with the shell width, so the eye lands in the same place relative to
   the trim whatever car is loaded). Everything the driver reads is framed
   against it — binnacle height, pad crest, wheel and mirror are all derived
   from EYE rather than from literals.

   z is the component that matters most and the one that was wrong for a long
   time. At z = 0.1 the eye sat 0.4 m AHEAD of the seat squab and only 0.52 m
   off the facia, so the cluster subtended ~70 degrees and the binnacle filled
   the windscreen; no seat height could recover the road, because the pod is
   pinned below the eye and simply rose with it. Sitting the eye over the squab
   at z = -0.30 puts the facia ~0.9 m away, which is where a real driver sits,
   and the cluster drops to a believable ~30 degrees. */
export const EYE = { x: 0.36, y: 0.82 + 0.53, z: -0.3 };

export interface GaugeFlags {
  lightsOn: boolean; sigL: boolean; sigR: boolean; rain: boolean; tcOn: boolean;
  odo: number; revLimit: number;
  /* Both come from engine.ts (live settings + car state) but stay optional so
     the cluster degrades gracefully: `units` falls back to the saved profile
     read once at build, `onLimiter` to comparing rpm against the rev limit. */
  units?: SpeedUnits;
  onLimiter?: boolean;
}

/* ---------------------------------------------------------------- shapes -- */

const CURVE_SEG = 2; // rounded trim is small on screen; 2 reads the same as 4 and halves the vertex count

/** Rounded rectangle centred on the origin, in the shape's XY plane. */
function rrShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = w / 2, y = h / 2;
  r = Math.max(0.0005, Math.min(r, Math.min(x, y) - 1e-4));
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.quadraticCurveTo(x, -y, x, -y + r);
  s.lineTo(x, y - r);
  s.quadraticCurveTo(x, y, x - r, y);
  s.lineTo(-x + r, y);
  s.quadraticCurveTo(-x, y, -x, y - r);
  s.lineTo(-x, -y + r);
  s.quadraticCurveTo(-x, -y, -x + r, -y);
  return s;
}

/** Rounded box centred on the origin — the workhorse for interior trim. */
function rbox(w: number, h: number, d: number, r = 0.012) {
  const b = Math.min(r, d / 2 - 1e-3, w / 2 - 1e-3, h / 2 - 1e-3);
  const g = new THREE.ExtrudeGeometry(
    rrShape(w - 2 * b, h - 2 * b, Math.max(0.0008, r - b)),
    {
      depth: d - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b,
      bevelSegments: 1, curveSegments: CURVE_SEG,
    }
  );
  g.translate(0, 0, -(d / 2 - b));
  return g;
}

/** Flat bezel: rounded-rect outline with a rounded-rect hole of wall width t. */
function bezel(w: number, h: number, d: number, r: number, t: number) {
  const s = rrShape(w, h, r);
  s.holes.push(rrShape(w - 2 * t, h - 2 * t, Math.max(0.001, r - t)));
  const g = new THREE.ExtrudeGeometry(s, {
    depth: d, bevelEnabled: true, bevelThickness: d * 0.3, bevelSize: d * 0.3,
    bevelSegments: 1, curveSegments: CURVE_SEG,
  });
  g.translate(0, 0, -d / 2);
  return g;
}

/** Reverse winding and normals — for open shells viewed from their back side. */
function flipped(g: THREE.BufferGeometry) {
  const n = g.index ? g.toNonIndexed() : g;
  for (const name of ["position", "normal", "uv"]) {
    const a = n.getAttribute(name);
    if (!a) continue;
    for (let i = 0; i < a.count; i += 3)
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.array[i * a.itemSize + k];
        a.array[i * a.itemSize + k] = a.array[(i + 2) * a.itemSize + k];
        a.array[(i + 2) * a.itemSize + k] = t;
      }
  }
  const nr = n.getAttribute("normal");
  if (nr) for (let i = 0; i < nr.count; i++) nr.setXYZ(i, -nr.getX(i), -nr.getY(i), -nr.getZ(i));
  return n;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 12, open = false) =>
  new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

/* ------------------------------------------------------------------------- */

/* ---------------------------------------------------------- per-car trim -- */

type TrimId = "coupe" | "sedan" | "kei" | "rally";

/** carspecs.ts doesn't hand this file a car id yet (only the fixed accent
    colour), so trim is inferred from that accent — each car's cockpitAccent
    is unique and static, so the match is stable. If a caller passes `carId`
    explicitly (see report to team lead: player.ts:254 could pass spec.id as
    a 3rd arg) that takes priority and the inference becomes a pure fallback. */
function trimFor(accent: number, carId?: string): TrimId {
  switch (carId) {
    case "kaze": return "coupe";
    case "shirayuki": return "sedan";
    case "tanuki": return "kei";
    case "okami": return "rally";
  }
  switch (accent) {
    case 0x3a5a8f: return "sedan";
    case 0xc98f10: return "kei";
    case 0x2a5c40: return "rally";
    default: return "coupe"; // includes kaze's 0x8f1a22
  }
}

interface TrimStyle {
  leatherBase: number; leatherFleck: number; leatherRough: number; leatherBump: number;
  cloth: boolean; // fabric weave read instead of pebbled leather grain
  softBase: number; softFleck: number; softRough: number; softBump: number;
  trimKind: "carbon" | "wood" | "plastic" | "alu";
  wheelKind: "leather" | "wood" | "plastic" | "cloth";
  aluMetal: number; aluRough: number; aluTint: number;
  chunky: boolean; // rally: thicker rim, bigger knobs, stubbier switchgear
}

const TRIM_STYLE: Record<TrimId, TrimStyle> = {
  // turbo sports coupe: dark alcantara, carbon-look trim, red stitching (accent)
  coupe: {
    leatherBase: 0x15161b, leatherFleck: 0x1e2026, leatherRough: 0.94, leatherBump: 0.26,
    cloth: false, softBase: 0x1c1d22, softFleck: 0x24262e, softRough: 0.95, softBump: 0.32,
    trimKind: "carbon", wheelKind: "leather", aluMetal: 0.72, aluRough: 0.4, aluTint: 0xaab2bf,
    chunky: false,
  },
  // executive sedan: tan full-grain leather, walnut trim, brighter chrome
  sedan: {
    leatherBase: 0x3c2c1e, leatherFleck: 0x4c3826, leatherRough: 0.46, leatherBump: 0.5,
    cloth: false, softBase: 0x2a2420, softFleck: 0x342c26, softRough: 0.8, softBump: 0.32,
    trimKind: "wood", wheelKind: "wood", aluMetal: 0.86, aluRough: 0.2, aluTint: 0xdbe1ea,
    chunky: false,
  },
  // kei car: cheap cloth + hard grey plastics, minimal brightwork
  kei: {
    leatherBase: 0x2e323b, leatherFleck: 0x383d47, leatherRough: 0.95, leatherBump: 0.12,
    cloth: true, softBase: 0x585d66, softFleck: 0x62676f, softRough: 0.82, softBump: 0.12,
    trimKind: "plastic", wheelKind: "plastic", aluMetal: 0.28, aluRough: 0.62, aluTint: 0x8f97a1,
    chunky: false,
  },
  // AWD rally tourer: cloth + blue accents, chunky rally-spec controls
  rally: {
    leatherBase: 0x1e222a, leatherFleck: 0x272d3c, leatherRough: 0.92, leatherBump: 0.2,
    cloth: true, softBase: 0x23262b, softFleck: 0x2b2f36, softRough: 0.9, softBump: 0.28,
    trimKind: "alu", wheelKind: "cloth", aluMetal: 0.55, aluRough: 0.5, aluTint: 0x8d96a6,
    chunky: true,
  },
};

export function buildCockpit(accent: number, mirrorTexture: THREE.Texture, carId?: string): Cockpit {
  const interiorG = new THREE.Group();
  const TRIM = trimFor(accent, carId);
  const style = TRIM_STYLE[TRIM];
  /* Rally's blue accent is a design choice independent of okami's (green)
     paint-matched cockpitAccent, so it overrides accent for stitching, LEDs
     and the wheel badge; every other trim reads straight off the car's own
     accent colour. */
  const trimAccent = TRIM === "rally" ? 0x2f8fff : accent;
  const accentCss = "#" + new THREE.Color(trimAccent).getHexString();
  const css = (hex: number) => "#" + new THREE.Color(hex).getHexString();

  /* --- textures: one paint each at build, all tileable -------------------- */

  /** Soft-touch dash plastic: fine pebble grain with a faint horizontal draw
      (kei's harder plastic reads flatter — bigger, sparser flecks, no draw
      lines — set by the caller via `flat`). */
  function grainTexOf(base: number, fleck: number, flat: boolean) {
    return makeTex(256, 256, (c, w, h) => {
      c.fillStyle = css(base);
      c.fillRect(0, 0, w, h);
      const [fr, fg, fb] = new THREE.Color(fleck).toArray().map((v) => Math.round(v * 255));
      for (let i = 0; i < (flat ? 2600 : 5200); i++) {
        const v = flat ? randi(-6, 10) : randi(-4, 6);
        c.fillStyle = `rgba(${fr + v},${fg + v},${fb + v},.4)`;
        c.fillRect(rand(0, w), rand(0, h), rand(1, flat ? 3.4 : 2.4), rand(1, flat ? 3.4 : 2.4));
      }
      if (!flat) {
        for (let i = 0; i < 26; i++) {
          c.strokeStyle = `rgba(12,13,18,${rand(0.1, 0.24)})`;
          c.lineWidth = rand(0.6, 1.6);
          c.beginPath();
          const y = rand(0, h);
          c.moveTo(0, y);
          c.bezierCurveTo(w * 0.3, y + rand(-6, 6), w * 0.7, y + rand(-6, 6), w, y + rand(-4, 4));
          c.stroke();
        }
      }
    }, true);
  }
  const grainTex = grainTexOf(style.softBase, style.softFleck, TRIM === "kei");

  /** Leather: pebbled cells plus a few long creases. Cloth trims (kei/rally)
      get a woven twill instead — same footprint, different weave read. */
  function leatherTexOf(base: number, fleck: number, cloth: boolean) {
    return makeTex(256, 256, (c, w, h) => {
      c.fillStyle = css(base);
      c.fillRect(0, 0, w, h);
      const [fr, fg, fb] = new THREE.Color(fleck).toArray().map((v) => Math.round(v * 255));
      if (cloth) {
        const cell = 5;
        for (let y = 0; y < h; y += cell) {
          for (let x = 0; x < w; x += cell) {
            const alt = (((x / cell) | 0) + ((y / cell) | 0)) % 2;
            const v = alt ? 10 : -10;
            c.fillStyle = `rgba(${fr + v},${fg + v},${fb + v},.85)`;
            c.fillRect(x, y, cell - 0.6, cell - 0.6);
          }
        }
        for (let i = 0; i < 900; i++) {
          const v = randi(-14, 14);
          c.fillStyle = `rgba(${fr + v},${fg + v},${fb + v},.25)`;
          c.fillRect(rand(0, w), rand(0, h), 1.4, 1.4);
        }
        return;
      }
      for (let i = 0; i < 1800; i++) {
        const r = rand(2.5, 6), v = randi(-12, 12);
        c.fillStyle = `rgba(${fr + v},${fg + v},${fb + v},.42)`;
        c.beginPath();
        c.ellipse(rand(0, w), rand(0, h), r, r * rand(0.55, 1), rand(0, 3.14), 0, TAU);
        c.fill();
      }
      for (let i = 0; i < 44; i++) {
        c.strokeStyle = `rgba(8,9,13,${rand(0.18, 0.5)})`;
        c.lineWidth = rand(0.5, 1.5);
        c.beginPath();
        const x = rand(0, w), y = rand(0, h);
        c.moveTo(x, y);
        c.bezierCurveTo(x + rand(-30, 30), y + rand(-30, 30), x + rand(-45, 45), y + rand(-45, 45),
          x + rand(-60, 60), y + rand(-60, 60));
        c.stroke();
      }
    }, true);
  }
  const leatherTex = leatherTexOf(style.leatherBase, style.leatherFleck, style.cloth);

  /** Perforated leather for the seat and door centre panels. Cloth trims read
      as a plain flat weave (no punched holes) with a faint houndstooth check. */
  const perfTex = makeTex(128, 128, (c, w, h) => {
    const base = style.leatherBase, fleck = style.leatherFleck;
    c.fillStyle = css(base);
    c.fillRect(0, 0, w, h);
    const [fr, fg, fb] = new THREE.Color(fleck).toArray().map((v) => Math.round(v * 255));
    for (let i = 0; i < 900; i++) {
      const v = randi(-10, 10);
      c.fillStyle = `rgba(${fr + v},${fg + v},${fb + v},.4)`;
      c.fillRect(rand(0, w), rand(0, h), 2, 2);
    }
    if (style.cloth) {
      for (let gy = 0; gy < h; gy += 10) {
        for (let gx = ((gy / 10) % 2) * 5; gx < w; gx += 10) {
          c.fillStyle = "rgba(0,0,0,.15)";
          c.fillRect(gx, gy, 5, 5);
        }
      }
      return;
    }
    for (let gy = 4; gy < h; gy += 12) {
      for (let gx = 4 + ((gy / 12) % 2) * 6; gx < w; gx += 12) {
        c.fillStyle = "rgba(4,5,8,.85)";
        c.beginPath();
        c.arc(gx, gy, 2.1, 0, TAU);
        c.fill();
      }
    }
  }, true);

  /** Diamond-quilted leather for the door inserts and armrest lids on the
      leather trims (cloth cars keep their woven inserts). Puffed cells shaded
      toward the seams, cross stitching in the accent thread — the procedural
      stand-in for the photo-scanned quilt that replaces it when the PBR set
      lands (see the async upgrade below). */
  const quiltTex = style.cloth ? null : makeTex(256, 256, (c, w, h) => {
    const cell = 64; // px between quilt seams (diagonal pitch)
    c.fillStyle = css(style.leatherBase);
    c.fillRect(0, 0, w, h);
    const [fr, fg, fb] = new THREE.Color(style.leatherFleck).toArray().map((v) => Math.round(v * 255));
    for (let i = 0; i < 1400; i++) {
      const r = rand(2, 5), v = randi(-10, 10);
      c.fillStyle = `rgba(${fr + v},${fg + v},${fb + v},.4)`;
      c.beginPath();
      c.ellipse(rand(0, w), rand(0, h), r, r * rand(0.6, 1), rand(0, 3.14), 0, TAU);
      c.fill();
    }
    // puffiness: a soft highlight in the middle of every diamond cell
    for (let gy = 0; gy <= h; gy += cell) {
      for (let gx = ((gy / cell) % 2) * (cell / 2); gx <= w + cell / 2; gx += cell) {
        const cx2 = gx, cy2 = gy;
        const puff = c.createRadialGradient(cx2, cy2 - cell * 0.1, 2, cx2, cy2, cell * 0.52);
        puff.addColorStop(0, `rgba(${fr + 26},${fg + 26},${fb + 28},.5)`);
        puff.addColorStop(0.75, "rgba(0,0,0,0)");
        puff.addColorStop(1, "rgba(0,0,0,.42)");
        c.fillStyle = puff;
        c.fillRect(cx2 - cell / 2, cy2 - cell / 2, cell, cell);
      }
    }
    // seam grooves along both diagonals, then the stitch dashes over them
    const th = new THREE.Color(trimAccent);
    const threadC = "#" + th.clone().lerp(new THREE.Color(1, 1, 1), 0.25).getHexString();
    c.lineCap = "round";
    for (const dir of [1, -1]) {
      for (let k = -h; k <= w + h; k += cell) {
        c.strokeStyle = "rgba(0,0,0,.5)";
        c.lineWidth = 4.5;
        c.beginPath();
        c.moveTo(k, dir > 0 ? 0 : h);
        c.lineTo(k + dir * h, dir > 0 ? h : 0);
        c.stroke();
        c.strokeStyle = threadC;
        c.lineWidth = 1.3;
        const L = Math.SQRT1_2;
        for (let s = 3; s < h * 1.414; s += 7) {
          c.beginPath();
          c.moveTo(k + dir * s * L, dir > 0 ? s * L : h - s * L);
          c.lineTo(k + dir * (s + 3.4) * L, dir > 0 ? (s + 3.4) * L : h - (s + 3.4) * L);
          c.stroke();
        }
      }
    }
  }, true);

  /** Brushed aluminium for the trim inlays and switch bezels — tint/finish
      vary per trim (bright chrome for the sedan, dull for the kei car). */
  const aluTex = makeTex(128, 64, (c, w, h) => {
    c.fillStyle = css(style.aluTint);
    c.fillRect(0, 0, w, h);
    const [ar, ag, ab] = new THREE.Color(style.aluTint).toArray().map((v) => Math.round(v * 255));
    for (let i = 0; i < 1100; i++) {
      const v = randi(-40, 60);
      c.fillStyle = `rgba(${ar + v},${ag + v},${ab + v},.45)`;
      c.fillRect(rand(0, w), rand(0, h), rand(5, 44), 1);
    }
  }, true);

  /** Carbon-fibre twill: coupe's decorative trim inlay. */
  const carbonTex = makeTex(64, 64, (c, w, h) => {
    c.fillStyle = "#101116";
    c.fillRect(0, 0, w, h);
    const cell = 4;
    for (let y = 0; y < h; y += cell) {
      for (let x = 0; x < w; x += cell) {
        const alt = (((x / cell) | 0) + ((y / cell) | 0)) % 2;
        c.fillStyle = alt ? "rgba(46,49,58,.9)" : "rgba(16,17,22,.9)";
        c.fillRect(x, y, cell - 0.5, cell - 0.5);
      }
    }
    c.strokeStyle = "rgba(255,255,255,.05)";
    for (let i = 0; i < 30; i++) {
      c.beginPath();
      c.moveTo(rand(0, w), 0);
      c.lineTo(rand(0, w), h);
      c.stroke();
    }
  }, true);

  /** Walnut veneer: sedan's decorative trim inlay. */
  const woodTex = makeTex(128, 64, (c, w, h) => {
    c.fillStyle = "#5a3820";
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 11; i++) {
      c.strokeStyle = `rgba(${randi(30, 52)},${randi(16, 28)},${randi(6, 16)},${rand(0.3, 0.6)})`;
      c.lineWidth = rand(1.5, 4);
      c.beginPath();
      const y = rand(0, h);
      c.moveTo(0, y);
      c.bezierCurveTo(w * 0.3, y + rand(-8, 8), w * 0.7, y + rand(-8, 8), w, y + rand(-6, 6));
      c.stroke();
    }
    for (let i = 0; i < 320; i++) {
      const v = randi(60, 100);
      c.fillStyle = `rgba(${v},${(v * 0.55) | 0},${(v * 0.28) | 0},.3)`;
      c.fillRect(rand(0, w), rand(0, h), rand(1, 3), 1);
    }
  }, true);

  /** Moulded hard plastic: kei's decorative trim inlay, body-colour-adjacent grey. */
  const plasticTex = makeTex(64, 64, (c, w, h) => {
    c.fillStyle = "#868d97";
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) {
      const v = randi(120, 185);
      c.fillStyle = `rgba(${v},${v + 2},${v + 6},.3)`;
      c.fillRect(rand(0, w), rand(0, h), rand(1, 2), rand(1, 2));
    }
  }, true);

  /** Headliner: light woven fabric, the one bright surface in the cabin. */
  const linerTex = makeTex(128, 128, (c, w, h) => {
    c.fillStyle = "#3a3d46";
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 4200; i++) {
      const v = randi(48, 78);
      c.fillStyle = `rgba(${v},${v + 1},${v + 6},.5)`;
      c.fillRect(rand(0, w), rand(0, h), 1.6, 1.6);
    }
  }, true);

  /** Carpet: coarse, nearly black. */
  const carpetTex = makeTex(128, 128, (c, w, h) => {
    c.fillStyle = "#101218";
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 3400; i++) {
      const v = randi(14, 34);
      c.fillStyle = `rgba(${v},${v},${v + 4},.6)`;
      c.fillRect(rand(0, w), rand(0, h), rand(1, 3), rand(1, 3));
    }
  }, true);

  /** Speaker / vent mesh: dot grid used on flat circles and rectangles. */
  const meshTex = makeTex(64, 64, (c, w, h) => {
    c.fillStyle = "#0b0c11";
    c.fillRect(0, 0, w, h);
    for (let gy = 3; gy < h; gy += 6) {
      for (let gx = 3 + ((gy / 6) % 2) * 3; gx < w; gx += 6) {
        c.fillStyle = "rgba(72,78,92,.75)";
        c.beginPath();
        c.arc(gx, gy, 1.5, 0, TAU);
        c.fill();
      }
    }
  }, true);

  /** Contrast stitching, painted in the car's accent colour. Double-row saddle
      stitch in a pressed seam channel: each stitch is a dark understroke, the
      thread itself, then a catchlight along its top — three strokes that make
      the thread read as round under the cabin light instead of as a decal. */
  const stitchTex = makeTex(128, 16, (c, w, h) => {
    c.fillStyle = "#0c0d12";
    c.fillRect(0, 0, w, h);
    // the channel: leather rolls up to the light at both edges, presses dark
    // in the middle where the seam is sunk
    const gr = c.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "rgba(255,255,255,.07)");
    gr.addColorStop(0.5, "rgba(0,0,0,.55)");
    gr.addColorStop(1, "rgba(255,255,255,.05)");
    c.fillStyle = gr;
    c.fillRect(0, 0, w, h);
    const th = new THREE.Color(trimAccent);
    const hiC = "#" + th.clone().lerp(new THREE.Color(1, 1, 1), 0.4).getHexString();
    const loC = "#" + th.clone().multiplyScalar(0.3).getHexString();
    c.lineCap = "round";
    for (const ry of [h * 0.3, h * 0.7]) {
      for (let i = 0; i < 16; i++) {
        const x0 = i * 8 + 1.4;
        c.strokeStyle = loC; // shadow the thread casts into the groove
        c.lineWidth = 3.2;
        c.beginPath();
        c.moveTo(x0, ry + 1.3);
        c.lineTo(x0 + 4.4, ry + 2.1);
        c.stroke();
        c.strokeStyle = accentCss; // the thread
        c.lineWidth = 2.2;
        c.beginPath();
        c.moveTo(x0, ry - 0.4);
        c.lineTo(x0 + 4.4, ry + 0.5);
        c.stroke();
        c.strokeStyle = hiC; // catchlight
        c.lineWidth = 0.8;
        c.beginPath();
        c.moveTo(x0 + 0.6, ry - 1.0);
        c.lineTo(x0 + 3.4, ry - 0.4);
        c.stroke();
      }
    }
  }, true);
  stitchTex.repeat.set(24, 1);

  /* --- materials: one draw call each once the statics are merged ---------- */

  const soft = new THREE.MeshStandardMaterial({
    map: grainTex, bumpMap: grainTex, bumpScale: style.softBump, roughness: style.softRough, metalness: 0.02,
  });

  const leather = new THREE.MeshStandardMaterial({
    map: leatherTex, bumpMap: leatherTex, bumpScale: style.leatherBump,
    roughness: style.leatherRough, metalness: style.cloth ? 0 : 0.03,
  });
  const perf = new THREE.MeshStandardMaterial({
    map: perfTex, bumpMap: perfTex, bumpScale: style.leatherBump * 0.8, roughness: style.leatherRough - 0.04,
  });
  /* Quilted panels merge into their own bucket (one extra draw call on the
     leather trims); cloth cars alias it to `perf` so nothing else branches. */
  const quilt = quiltTex
    ? new THREE.MeshStandardMaterial({
        map: quiltTex, bumpMap: quiltTex, bumpScale: style.leatherBump * 1.5,
        roughness: style.leatherRough - 0.06, metalness: 0.03,
      })
    : perf;
  const liner = new THREE.MeshStandardMaterial({ map: linerTex, roughness: 0.98 });

  const carpet = new THREE.MeshStandardMaterial({ map: carpetTex, roughness: 1 });
  const alu = new THREE.MeshStandardMaterial({
    map: aluTex, color: style.aluTint, metalness: style.aluMetal, roughness: style.aluRough,
  });
  /* Decorative flourish trim — the carbon/wood/plastic inlay that reads as
     "designed" from the seat (facia strip, gauge ring, stack bezel, console
     flanks, door inlay). Functional switchgear stays on `alu` above. */
  const trimStripMat = new THREE.MeshStandardMaterial(
    style.trimKind === "carbon" ? { map: carbonTex, color: 0x9aa0ac, metalness: 0.15, roughness: 0.32 } :
    style.trimKind === "wood" ? { map: woodTex, metalness: 0.1, roughness: 0.26 } :
    style.trimKind === "plastic" ? { map: plasticTex, metalness: 0.05, roughness: 0.58 } :
    { map: aluTex, color: style.aluTint, metalness: style.aluMetal, roughness: style.aluRough }
  );
  // piano black: tighter clearcoat-style highlight so the console reads as
  // polished lacquer under the cabin light rather than semi-gloss plastic
  const piano = new THREE.MeshStandardMaterial({ color: 0x0a0b0f, roughness: 0.1, metalness: 0.42 });
  piano.name = "piano";
  const shadow = new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 0.96 });
  shadow.name = "shadow";
  soft.name = "soft";
  const grille = new THREE.MeshStandardMaterial({ map: meshTex, roughness: 0.85 });
  const stitch = new THREE.MeshStandardMaterial({
    map: stitchTex, bumpMap: stitchTex, bumpScale: 0.25, roughness: 0.68,
  });
  /* Lathe UVs sweep round the axis, and the leather bump map read across them
     blows the shading out to near-white — the shifter needs a flat material. */
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x0f1116, roughness: 0.92 });
  const accentMat = new THREE.MeshStandardMaterial({ color: trimAccent, roughness: 0.55 });
  const amber = new THREE.MeshStandardMaterial({
    color: 0x06222c, emissive: 0x37c8ff, emissiveIntensity: 1.05,
  });
  const warn = new THREE.MeshStandardMaterial({
    color: 0x2a0806, emissive: 0xff3020, emissiveIntensity: 0.85,
  });

  /* --- photo-scanned leather (async, fail-soft) ----------------------------
     Real full-grain scans from public/assets/pbr (see ATTRIBUTIONS.md) land a
     few hundred ms in and upgrade the leather materials in place: albedo
     tinted back to each trim's authored colour (mean-preserving, so the cabin
     keeps its night brightness), a real normal map instead of the canvas bump,
     and the scan's roughness rescaled so the *average* stays the tuned value.
     Cloth trims (kei/rally soft goods) keep their woven canvases; a missing or
     failed fetch changes nothing. Gated on the tier's pbrDetail cap like the
     road scans, so mobile-base never pays the fetch. */
  {
    let wantPbr = true;
    try {
      const isTouch = typeof matchMedia !== "undefined" &&
        "ontouchstart" in window && matchMedia("(pointer:coarse)").matches;
      wantPbr = TIER_CAPS[resolveRenderTier(loadProfile().settings, isTouch)].pbrDetail;
    } catch {
      /* no DOM (tests) — keep procedural */
    }
    /** Per-channel linear means of a scan's albedo. A scalar-luminance tint
        preserves brightness but lets the scan's hue win — Leather037's warm
        red-brown swamped the coupe's near-black blue-grey. Dividing the trim
        colour by the scan's per-channel mean makes the *rendered mean* land on
        the authored colour exactly, hue included. */
    const chanMeans = (img: CanvasImageSource): [number, number, number] | null => {
      try {
        const N = 8;
        const c = document.createElement("canvas");
        c.width = c.height = N;
        const x = c.getContext("2d", { willReadFrequently: true });
        if (!x) return null;
        x.drawImage(img, 0, 0, N, N);
        const d = x.getImageData(0, 0, N, N).data;
        const s2l = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < N * N; i++) {
          r += s2l(d[i * 4] / 255);
          g += s2l(d[i * 4 + 1] / 255);
          b += s2l(d[i * 4 + 2] / 255);
        }
        const n = N * N;
        return [r / n, g / n, b / n];
      } catch {
        return null; // tainted canvas — fall back to the scalar mean
      }
    };
    /** Tint the scan back to the trim colour without changing mean brightness. */
    const tintTo = (m: THREE.MeshStandardMaterial, base: number, set: { albedo: THREE.Texture | null; albedoMean: number }) => {
      const ch = set.albedo?.image ? chanMeans(set.albedo.image as CanvasImageSource) : null;
      m.color.setHex(base);
      if (ch) {
        m.color.r /= Math.max(ch[0], 0.02);
        m.color.g /= Math.max(ch[1], 0.02);
        m.color.b /= Math.max(ch[2], 0.02);
      } else {
        m.color.multiplyScalar(1 / Math.max(set.albedoMean, 0.04));
      }
      const mx = Math.max(m.color.r, m.color.g, m.color.b);
      if (mx > 1) m.color.multiplyScalar(1 / mx);
    };
    const apply = (
      m: THREE.MeshStandardMaterial, set: Awaited<ReturnType<typeof loadPbrSet>>,
      base: number, targetRough: number, normalScale: number
    ) => {
      if (!set.albedo) return;
      m.map = set.albedo;
      m.bumpMap = null;
      if (set.normal) {
        m.normalMap = set.normal;
        m.normalScale.set(normalScale, normalScale);
      }
      if (set.rough) {
        m.roughnessMap = set.rough;
        m.roughness = targetRough / Math.max(set.roughMean, 0.05);
      }
      tintTo(m, base, set);
      m.needsUpdate = true;
    };
    if (wantPbr) void (async () => {
      // fine grain: dash pad + the main seat/door leather
      const fine = await loadPbrSet("leather", new THREE.Vector2(2.2, 2.2));
      if (!style.cloth) apply(leather, fine, style.leatherBase, style.leatherRough - 0.12, 0.9);
      // the dash pad is soft-touch on every car but the kei's hard plastic;
      // roughness comes down further than the seats' so the glass light can
      // draw a broad sheen across the pad top at night
      if (TRIM !== "kei") apply(soft, fine, style.softBase, style.softRough - 0.32, 1.0);
      // quilted scan (diamond stitched) for the inserts, leather trims only
      if (quiltTex) {
        const q = await loadPbrSet("leather_quilt", new THREE.Vector2(1.5, 1.5));
        apply(quilt, q, style.leatherBase, style.leatherRough - 0.14, 1.0);
      }
    })();
  }

  /* --- static-geometry accumulator ---------------------------------------- */

  type P3 = [number, number, number];
  const buckets = new Map<string, { mat: THREE.Material; region: string | null; gs: THREE.BufferGeometry[] }>();
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  const _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

  /* Merging is per (material, region) rather than per material alone. Region is
     null for most of the cabin, which costs nothing — those still collapse to
     one mesh each. The point is the "dash" region: an imported cockpit model
     (cockpitmodel.ts) replaces the dash and only the dash, so that geometry has
     to end up in meshes of its own that can be hidden as a set. Merged into the
     shared per-material meshes it would be inseparable from the door cards and
     seats, which the import does NOT replace. */
  let curRegion: string | null = null;

  /** Place a geometry into its material's merge bucket. `uv` rescales the UVs
      so the grain keeps a constant world density across differently sized parts. */
  function put(
    g: THREE.BufferGeometry, mat: THREE.Material, p: P3, r: P3 = [0, 0, 0],
    uv?: number | [number, number]
  ) {
    if (uv !== undefined) {
      const [ux, uy] = typeof uv === "number" ? [uv, uv] : uv;
      const a = g.getAttribute("uv");
      if (a) {
        for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * ux, a.getY(i) * uy);
        a.needsUpdate = true;
      }
    }
    _e.set(r[0], r[1], r[2]);
    _q.setFromEuler(_e);
    _p.set(p[0], p[1], p[2]);
    _m.compose(_p, _q, _s);
    g.applyMatrix4(_m);
    const ng = g.index ? g.toNonIndexed() : g;
    ng.clearGroups();
    ng.deleteAttribute("uv1");
    const key = `${mat.uuid}|${curRegion ?? ""}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat, region: curRegion, gs: [] }));
    b.gs.push(ng);
  }

  /* Bracketing rather than a wrapping closure: the dash spans ~280 lines of
     `put` calls and re-indenting all of them to pass a callback would bury the
     one line that actually changed. */
  const beginRegion = (name: string) => { curRegion = name; };
  const endRegion = () => { curRegion = null; };

  /** One group per swappable region, so an imported dash can hide exactly what
      it replaces and nothing more. A donor that brings a dash but no pillars
      hides only `dash`. */
  const regionG: Record<string, THREE.Group> = {};
  for (const r of ["dash", "cabin", "mirror"]) {
    const gp = new THREE.Group();
    gp.name = `procedural:${r}`;
    interiorG.add(gp);
    regionG[r] = gp;
  }

  /** Merge every bucket down to one mesh per material and region. */
  function flush() {
    for (const { mat, region, gs } of buckets.values()) {
      const merged = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mm = new THREE.Mesh(merged, mat);
      // named per material so headless test harnesses can toggle merge buckets
      if (mat.name) mm.name = `merged:${mat.name}${region ? `@${region}` : ""}`;
      ((region && regionG[region]) || interiorG).add(mm);
    }
    buckets.clear();
  }

  /* Cabin reference planes. The doors' inner faces, the facia and the roof are
     all pinned to these so the trim actually meets up. */
  const DOOR_X = 0.805;   // inner surface of the door cards
  const FACIA_Z = 0.62;   // cabin-facing plane of the dash
  const ROOF_Y = 1.70;
  /* Height and slope of the pad's top surface, so the defroster grilles, the
     speaker and the airbag lid lie ON it instead of sinking into it. This is a
     quadratic fit of the profile curve below — a straight-line approximation
     buries them by ~2 cm at the middle of the pad. */
  const padU = (z: number) => z - (FACIA_Z + 0.075);
  const padY = (z: number) => 1.0 + 0.0457 * padU(z) - 1.487 * padU(z) ** 2;
  const padTilt = (z: number) => Math.atan(2.974 * padU(z) - 0.0457);

  /* ------------------------------------------------------------ dash shell */

  /* Everything from here to the door cards is what an imported cockpit model
     stands in for: pad, binnacle, vents, facia, centre stack, centre console.
     Door cards, pillars, roof, seats and glass are NOT in the region — those
     stay procedural whichever dash is in use. */
  beginRegion("dash");

  /* Side profile of the dash in the (z, y) plane: facia rising to a rolled top
     edge, then the pad sweeping forward and down to the base of the screen.
     The roll sits at the same z as the facia — let the pad overhang back
     toward the seat and it hides the whole facia from the driver. */
  const F = FACIA_Z;
  const dashProfile = new THREE.Shape();
  dashProfile.moveTo(F, 0.905);
  dashProfile.quadraticCurveTo(F + 0.008, 0.982, F + 0.075, 1.0);
  dashProfile.quadraticCurveTo(F + 0.16, 1.012, F + 0.3, 0.935);
  dashProfile.lineTo(F + 0.3, 0.872);
  dashProfile.quadraticCurveTo(F + 0.17, 0.79, F + 0.11, 0.648);
  dashProfile.lineTo(F + 0.06, 0.562);
  dashProfile.lineTo(F + 0.018, 0.574);
  dashProfile.quadraticCurveTo(F + 0.008, 0.70, F, 0.8);
  dashProfile.lineTo(F, 0.905);
  {
    const DW = 1.60;
    const g = new THREE.ExtrudeGeometry(dashProfile, {
      depth: DW - 0.026, bevelEnabled: true, bevelThickness: 0.013, bevelSize: 0.013,
      bevelSegments: 2, curveSegments: 6,
    });
    // shape x -> world z, extrusion -> world -x
    g.rotateY(-Math.PI / 2);
    g.translate(DW / 2 - 0.013, 0, 0);
    put(g, soft, [0, 0, 0], [0, 0, 0], [2.2, 1.4]);
  }
  /* Dash-to-door end caps: the pad wraps into the door tops instead of just
     stopping in mid-air. */
  for (const s of [-1, 1]) {
    put(rbox(0.1, 0.2, 0.26, 0.05), soft, [s * 0.795, 0.93, FACIA_Z - 0.08], [0.1, 0, -s * 0.16], 1.6);
  }

  /* Brushed inlay + stitched seam running the width of the dash, just under
     the roll — the line that reads as "designed" from the seat. */
  put(rbox(1.56, 0.022, 0.016, 0.006), trimStripMat, [0, 0.9, FACIA_Z - 0.012], [0, 0, 0], [10, 1]);
  put(box(1.5, 0.011, 0.007), stitch, [0, 0.936, FACIA_Z - 0.006]);

  /* Piped seam along the pad's rolled crest — the reference car's signature
     line. A round bead laid along the crest, flanked by a saddle-stitch row on
     the roll (driver side of the crest) and one on the pad top behind it.
     Placement is on the roll's actual quadratic (see dashProfile): at
     z = F+0.02 the surface sits at y 0.963 with its normal ~55° back toward
     the seat, which is where the front row drapes; the rear row rides the
     padY/padTilt fit like everything else on the pad top. */
  put(cyl(0.0055, 0.0055, 1.5, 8), soft, [0, 1.002, F + 0.072], [0, 0, Math.PI / 2], [8, 1]);
  put(box(1.48, 0.006, 0.011), stitch, [0, 0.9655, F + 0.0175], [-0.955, 0, 0]);
  {
    const sz = F + 0.115;
    put(box(1.48, 0.006, 0.011), stitch, [0, padY(sz) + 0.003, sz], [padTilt(sz), 0, 0]);
  }

  /* Pad top. From the seat this is the single biggest interior surface, so it
     carries the defroster slots, the centre speaker and the airbag shut line
     rather than being left as a bare plateau. */
  {
    /** Lay a part on the pad's top surface, `up` metres proud of it. */
    const onPad = (z: number, up: number): [P3, P3] =>
      [[0, padY(z) + up, z], [padTilt(z), 0, 0]];
    /* The pad is seen at a very shallow angle, so relief alone does nothing —
       a 5 mm proud panel is two pixels. What reads from the seat is a dark LINE
       across a light surface, so every feature here is built as a black slot
       fenced by raised ribs rather than as a subtle bump. */
    function slot(x: number, z: number, w: number, d: number) {
      const [p, r] = onPad(z, 0.004);
      put(rbox(w, 0.016, d, 0.004), shadow, [x, p[1], p[2]], r);
      for (const s of [-1, 1]) {
        const [pr] = onPad(z + s * (d / 2 + 0.009), 0.009);
        put(rbox(w + 0.02, 0.018, 0.016, 0.006), soft,
          [x, pr[1], pr[2]], r, [6, 1]);
      }
    }
    // defroster slots along the base of the screen
    for (const gx of [-0.42, 0.42]) slot(gx, FACIA_Z + 0.21, 0.54, 0.05);
    // centre speaker
    const sz = FACIA_Z + 0.15;
    const [sp, sr] = onPad(sz, 0.006);
    put(new THREE.CircleGeometry(0.052, 20), grille, [0, sp[1] + 0.004, sp[2]],
      [-Math.PI / 2 + padTilt(sz), 0, 0], 3);
    put(new THREE.TorusGeometry(0.056, 0.007, 6, 20), soft, [0, sp[1], sp[2]], sr, [8, 1]);
    /* Passenger cowl: a low ridge mirroring the binnacle. Without it that half
       of the pad is one unbroken sheet from the screen to the facia, which is
       what made the dash read as a plateau however much detail sat on it. */
    const cz = FACIA_Z + 0.13;
    const [cp, cr] = onPad(cz, 0.028);
    put(rbox(0.66, 0.075, 0.32, 0.05), soft, [-0.42, cp[1], cp[2]], cr, [3, 2]);
    put(rbox(0.68, 0.02, 0.34, 0.05), shadow, [-0.42, cp[1] - 0.024, cp[2]], cr);
    /* Airbag lid in the top of the cowl: the shut line is the whole point, so
       it is cut as three black grooves with the lid a couple of mm proud. */
    const [ap, ar] = onPad(cz, 0.068);
    put(rbox(0.46, 0.016, 0.19, 0.02), soft, [-0.42, ap[1], ap[2]], ar, [3, 1]);
    for (const s of [-1, 1])
      put(rbox(0.006, 0.02, 0.19, 0.002), shadow, [-0.42 + s * 0.236, ap[1], ap[2]], ar);
    const [ag] = onPad(cz - 0.102, 0.062);
    put(rbox(0.472, 0.02, 0.006, 0.002), shadow, [-0.42, ag[1], ag[2]], ar);
  }

  /* --------------------------------------------------- instrument binnacle */

  /* Height is pinned to the eye rather than to a literal so the dials keep the
     same depression whatever the seating position is.

     The pod's vertical bulk is the constraint: anything stacked on top of the
     dials — a deep bezel, a cowl, a hood, even an open ring — eats into the
     road ahead, and from the fixed dashcam POV it reads as a dead black bar
     across mid-frame (the ring's outer edge sits ~25 cm from that lens, so its
     few centimetres of collar smear into a giant band), so the pod is fully
     open above its sill (no lip, no brow, no ring — dashboard.ts's hood is
     gone for the same reason). 15.5 degrees of depression is a
     real car's cluster angle; it only fits because the eye now sits 0.9 m back
     from the dash instead of 0.5 m. */
  const POD_Z = 0.6;
  const POD = { x: 0.38, y: EYE.y - (POD_Z - EYE.z) * Math.tan(0.27), z: POD_Z, tilt: 0.46 };
  {
    const { x, y, z, tilt } = POD;
    /* The pod body has to stay below and behind the dial faces. Give it height
       and it leans its top-front corner into the sight line and shears the top
       off the gauges. */
    put(rbox(0.68, 0.18, 0.26, 0.055), soft, [x, y - 0.15, z + 0.14], [-tilt, 0, 0], 1.6);
    /* No bezel ring, no trim ring, no full-height throat. All three were
       centred on the dials, so their outer edges stood ~3 cm proud of the dial
       tops only ~25 cm from the fixed dashcam lens — nearly edge-on, that thin
       collar smeared into a giant unlit band across mid-frame that buried the
       dash-top tablet's map pane (measured by hide/paint bisect against the
       POV camera; see test/pov-bisect.mjs / pov-paint.mjs). The cluster keeps
       its mounted look from dashboard.ts's recessed shell and the per-dial
       chrome rings; here only furniture that stays BELOW the dial centres
       survives: a stitched sill under the cluster rooting it into the pod. */
    put(rbox(0.62, 0.05, 0.05, 0.02), soft, [x, y - 0.135, z - 0.028], [-tilt, 0, 0], [4, 1]);
    put(box(0.56, 0.006, 0.011), stitch, [x, y - 0.108, z - 0.049], [-tilt, 0, 0]);
  }

  /* -------------------------------------------------------- vents & facia */

  /** Rectangular eyeball vent: recessed throat, four blades, a chrome thumbwheel. */
  function vent(x: number, y: number, z: number, w: number, h: number, yaw = 0) {
    put(bezel(w, h, 0.03, h * 0.42, 0.014), piano, [x, y, z], [0, yaw, 0]);
    put(box(w - 0.02, h - 0.02, 0.006), shadow, [x, y, z + 0.042], [0, yaw, 0]);
    const bn = 4;
    for (let i = 0; i < bn; i++) {
      const by = y + (i - (bn - 1) / 2) * ((h - 0.028) / bn);
      put(box(w - 0.028, 0.005, 0.026), piano, [x, by, z + 0.024], [0.34, yaw, 0]);
    }
    put(cyl(0.008, 0.008, 0.012, 8), alu, [x + (w / 2 - 0.016), y, z + 0.006],
      [Math.PI / 2, 0, 0], [2, 1]);
  }

  // outer vents, one at each end of the facia; centre pair on the stack below
  vent(0.735, 0.845, FACIA_Z - 0.004, 0.17, 0.085, -0.22);
  vent(-0.735, 0.845, FACIA_Z - 0.004, 0.17, 0.085, 0.22);

  /* Passenger side: airbag seam, a soft knee pad and a glovebox with a real
     shut line and a recessed pull. */
  {
    const px = -0.44;
    // glovebox lid: inset panel, shut line, chrome pull
    put(rbox(0.5, 0.2, 0.026, 0.03), shadow, [px, 0.735, FACIA_Z + 0.014], [0, 0, 0], 1.4);
    put(rbox(0.475, 0.178, 0.03, 0.026), soft, [px, 0.735, FACIA_Z + 0.002], [0, 0, 0], [2.4, 1]);
    put(rbox(0.115, 0.026, 0.024, 0.01), trimStripMat, [px - 0.13, 0.812, FACIA_Z - 0.004], [0, 0, 0], [4, 1]);
    put(box(0.44, 0.006, 0.006), stitch, [px, 0.658, FACIA_Z - 0.006]);
    // knee bolster below, softer and set back
    put(rbox(0.52, 0.09, 0.03, 0.02), soft, [px, 0.628, FACIA_Z + 0.026], [0.18, 0, 0], 1.6);
  }

  /* Driver side: column shroud, light switch pod, ignition. */
  {
    const dx = POD.x;
    const shroudUp = new THREE.CylinderGeometry(0.062, 0.085, 0.24, 14, 1, false,
      Math.PI * 0.04, Math.PI * 0.92);
    shroudUp.rotateX(Math.PI / 2);
    put(shroudUp, soft, [dx, 0.875, FACIA_Z - 0.115], [-0.34, 0, 0], [2, 1]);
    const shroudLo = new THREE.CylinderGeometry(0.058, 0.082, 0.24, 14, 1, false,
      Math.PI * 1.04, Math.PI * 0.92);
    shroudLo.rotateX(Math.PI / 2);
    put(shroudLo, piano, [dx, 0.87, FACIA_Z - 0.115], [-0.34, 0, 0]);
    // stalks
    for (const s of [-1, 1]) {
      put(rbox(0.019, 0.019, 0.17, 0.008), piano,
        [dx + s * 0.105, 0.885, FACIA_Z - 0.17], [0.06, s * 0.42, s * 0.1]);
      put(cyl(0.012, 0.014, 0.02, 8), piano, [dx + s * 0.175, 0.891, FACIA_Z - 0.245],
        [Math.PI / 2 + 0.06, 0, 0]);
    }
    // light switch pod, outboard of the column
    put(rbox(0.135, 0.075, 0.03, 0.016), piano, [dx + 0.24, 0.76, FACIA_Z + 0.002], [0, -0.12, 0]);
    put(cyl(0.024, 0.026, 0.022, 14), alu, [dx + 0.213, 0.76, FACIA_Z - 0.012],
      [Math.PI / 2, 0, 0.12], [2, 1]);
    put(cyl(0.014, 0.014, 0.018, 10), piano, [dx + 0.268, 0.762, FACIA_Z - 0.01],
      [Math.PI / 2, 0, 0]);
    // start button in a knurled ring
    put(bezel(0.062, 0.062, 0.016, 0.031, 0.009), alu, [dx - 0.235, 0.79, FACIA_Z - 0.006],
      [0, 0.16, 0], [4, 1]);
    put(cyl(0.021, 0.023, 0.016, 14), warn, [dx - 0.235, 0.79, FACIA_Z - 0.004], [Math.PI / 2, 0, 0]);
  }

  /* --------------------------------------------------------- centre stack */

  const STACK = { x: -0.135, z: FACIA_Z - 0.01, tilt: 0.2, yaw: -0.17 };
  {
    const { x, z, tilt, yaw } = STACK;
    // gloss panel canted back and angled toward the driver
    put(rbox(0.36, 0.42, 0.05, 0.035), piano, [x, 0.79, z + 0.03], [-tilt, yaw, 0]);
    put(bezel(0.372, 0.432, 0.03, 0.04, 0.012), trimStripMat, [x, 0.79, z + 0.016], [-tilt, yaw, 0], [8, 1]);
    // vent pair across the top of the stack
    vent(x - 0.083, 0.895, z - 0.012, 0.15, 0.062, yaw);
    vent(x + 0.083, 0.895, z + 0.014, 0.15, 0.062, yaw);
    // climate readout
    put(rbox(0.2, 0.036, 0.008, 0.006), amber, [x, 0.665, z - 0.016], [-tilt, yaw, 0]);
    // rotary climate knobs
    for (const kx of [-0.11, 0.11]) {
      put(cyl(0.026, 0.028, 0.02, 16), alu,
        [x + kx * Math.cos(yaw), 0.612, z - 0.012 - kx * Math.sin(yaw)],
        [Math.PI / 2 - tilt, 0, 0], [3, 1]);
      put(cyl(0.017, 0.017, 0.024, 12), piano,
        [x + kx * Math.cos(yaw), 0.612, z - 0.018 - kx * Math.sin(yaw)],
        [Math.PI / 2 - tilt, 0, 0]);
    }
    // switch row between the knobs
    for (let b = 0; b < 3; b++) {
      const bx = (b - 1) * 0.045;
      put(rbox(0.036, 0.03, 0.012, 0.005), piano,
        [x + bx * Math.cos(yaw), 0.612, z - 0.012 - bx * Math.sin(yaw)], [-tilt, yaw, 0]);
      put(box(0.02, 0.004, 0.004), amber,
        [x + bx * Math.cos(yaw), 0.618, z - 0.02 - bx * Math.sin(yaw)], [-tilt, yaw, 0]);
    }
    // hazard triangle, its own bigger button above the readout
    put(rbox(0.036, 0.03, 0.014, 0.006), warn, [x + 0.145, 0.665, z - 0.03], [-tilt, yaw, 0]);
  }

  /* ------------------------------------------------------- centre console */

  {
    // tunnel: a rounded spine running from the stack back between the seats
    put(rbox(0.34, 0.34, 1.12, 0.075), soft, [0, 0.7, 0.02], [0, 0, 0], [2, 2.4]);
    put(rbox(0.29, 0.06, 1.0, 0.03), piano, [0, 0.862, 0.0], [0, 0, 0]);
    // side trim strips catching the light along the tunnel flanks
    for (const s of [-1, 1]) {
      put(rbox(0.012, 0.02, 0.86, 0.005), trimStripMat, [s * 0.168, 0.79, -0.02], [0, 0, 0], [12, 1]);
      put(box(0.005, 0.008, 0.8), stitch, [s * 0.172, 0.836, -0.02]);
    }
    // shifter surround: boot with pleats + collar + knob — pleat depth, knob
    // size and topper all vary per trim (plain thin stick for the kei car,
    // a bigger topped knob for the rally car's dogleg-style shifter)
    const pleat = TRIM === "kei" ? 0 : 0.004;
    const knobScale = style.chunky ? 1.22 : TRIM === "kei" ? 0.78 : 1;
    put(bezel(0.17, 0.19, 0.014, 0.03, 0.012), alu, [0, 0.868, 0.11], [Math.PI / 2, 0, 0], [4, 1]);
    const bootPts: THREE.Vector2[] = [];
    for (let i = 0; i <= 7; i++) {
      const t = i / 7;
      bootPts.push(new THREE.Vector2(0.072 - t * 0.045 + Math.sin(t * 9) * pleat, t * 0.105));
    }
    put(new THREE.LatheGeometry(bootPts, 14), bootMat, [0, 0.862, 0.11], [0, 0, 0], [3, 1]);
    put(cyl(0.03, 0.028, 0.016, 14), alu, [0, 0.968, 0.11], [0, 0, 0], [3, 1]);
    const knobPts: THREE.Vector2[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      knobPts.push(new THREE.Vector2(Math.sin(t * Math.PI * 0.86 + 0.16) * 0.036 * knobScale, t * 0.085 * knobScale));
    }
    const knobMat = TRIM === "sedan" ? trimStripMat : bootMat;
    put(new THREE.LatheGeometry(knobPts, 14), knobMat, [0, 0.972, 0.11], [0, 0, 0], [2, 1]);
    put(cyl(0.026, 0.03, 0.012, 14), alu, [0, 1.06 + (knobScale - 1) * 0.085, 0.11], [0, 0, 0], [3, 1]);
    // rally topper: a bright accent cap, the one flash of colour on the lever
    if (TRIM === "rally")
      put(new THREE.CircleGeometry(0.026, 16), accentMat,
        [0, 0.972 + 0.085 * knobScale, 0.11], [Math.PI / 2, 0, 0]);

    // cupholders: two recessed wells with alu rims
    for (const cz of [-0.16, -0.29]) {
      put(bezel(0.098, 0.098, 0.01, 0.049, 0.008), alu, [-0.005, 0.892, cz], [Math.PI / 2, 0, 0], [4, 1]);
      put(cyl(0.043, 0.04, 0.075, 14, true), shadow, [-0.005, 0.855, cz]);
      put(cyl(0.04, 0.04, 0.006, 14), shadow, [-0.005, 0.818, cz]);
    }
    // handbrake: leather boot, alu lever, release button
    put(bezel(0.09, 0.16, 0.012, 0.03, 0.01), alu, [0.115, 0.87, -0.05], [Math.PI / 2, 0, 0], [3, 1]);
    put(cyl(0.045, 0.028, 0.055, 12), leather, [0.115, 0.885, -0.06], [-0.7, 0, 0], [2, 1]);
    put(rbox(0.03, 0.03, 0.2, 0.014), alu, [0.115, 0.945, -0.14], [0.72, 0, 0], [4, 1]);
    put(rbox(0.036, 0.042, 0.11, 0.018), leather, [0.115, 1.0, -0.21], [0.72, 0, 0], [2, 1]);
    put(cyl(0.011, 0.011, 0.014, 10), piano, [0.115, 1.028, -0.245], [0.72, 0, 0]);
    // rear armrest lid: quilted on the leather trims, with stitched seams
    put(rbox(0.28, 0.05, 0.34, 0.024), quilt, [0, 0.9, -0.45], [0, 0, 0], [1.2, 1.2]);
    put(box(0.005, 0.006, 0.3), stitch, [0.115, 0.926, -0.45]);
    put(box(0.005, 0.006, 0.3), stitch, [-0.115, 0.926, -0.45]);
  }

  endRegion();

  /* --------------------------------------------------------- door cards */

  /* Door cards, pillars, roof and headliner form the "cabin" region: the second
     thing a donor can stand in for, once frustum clipping made its A-pillars
     and door card affordable (9% and 17% of two whole-car meshes). Separate
     from "dash" rather than merged with it because a donor may bring one and
     not the other — a dashboard-only scan has no pillars, and hiding ours to
     make room for nothing would open the cabin to the sky.

     Deliberately NOT in the region, and staying procedural either way: the
     ambient light strips and the window glass below. Both are lighting
     features tuned against the night pass rather than trim, and a donor's
     are inert. */
  beginRegion("cabin");

  for (const s of [-1, 1]) {
    const X = s * DOOR_X;
    const yawIn: P3 = [0, s > 0 ? -Math.PI / 2 : Math.PI / 2, 0]; // face inboard
    // main card + belt rail
    put(rbox(0.05, 0.56, 1.3, 0.03), soft, [X + s * 0.02, 0.855, -0.08], [0, 0, 0], [1, 3]);
    put(rbox(0.062, 0.045, 1.3, 0.016), soft, [X + s * 0.012, 1.125, -0.08], [0, 0, 0], [1, 6]);
    put(rbox(0.058, 0.014, 1.26, 0.006), trimStripMat, [X + s * 0.008, 1.096, -0.08], [0, 0, 0], [1, 14]);
    // upper leather pad, proud of the card: piped top edge + double stitching,
    // mirroring the dash pad's seam treatment
    put(rbox(0.045, 0.14, 1.16, 0.02), leather, [X - s * 0.006, 1.01, -0.06], [0, 0, 0], [1, 3]);
    put(cyl(0.005, 0.005, 1.14, 8), leather, [X - s * 0.024, 1.072, -0.06], [Math.PI / 2, 0, 0], [6, 1]);
    put(box(0.004, 0.005, 1.1), stitch, [X - s * 0.0295, 1.058, -0.06], [0, Math.PI / 2, 0]);
    put(box(0.004, 0.005, 1.1), stitch, [X - s * 0.0295, 0.955, -0.06], [0, Math.PI / 2, 0]);
    // quilted centre insert on the leather trims (cloth cars keep the weave),
    // with an accent sweep above it
    put(rbox(0.03, 0.2, 0.72, 0.03), quilt, [X - s * 0.012, 0.87, -0.1], [0, 0, 0], [1, 3]);
    put(rbox(0.024, 0.016, 0.78, 0.007), trimStripMat, [X - s * 0.02, 0.982, -0.1], [s * 0.06, 0, 0], [1, 12]);
    // armrest with a moulded pull cup
    put(rbox(0.11, 0.1, 0.66, 0.038), leather, [X - s * 0.05, 0.905, -0.05], [0, 0, 0], [2, 3]);
    put(box(0.004, 0.005, 0.6), stitch, [X - s * 0.1, 0.94, -0.05], [0, Math.PI / 2, 0]);
    put(rbox(0.07, 0.07, 0.24, 0.028), shadow, [X - s * 0.028, 0.9, -0.15]);
    put(rbox(0.028, 0.032, 0.19, 0.012), alu, [X - s * 0.088, 0.93, -0.15], [0, 0, 0], [4, 1]);
    // window switch pack on the armrest top
    put(rbox(0.085, 0.014, 0.2, 0.008), piano, [X - s * 0.055, 0.958, -0.02], [0, 0, s * 0.1]);
    for (let b = 0; b < (s > 0 ? 4 : 2); b++) {
      put(rbox(0.026, 0.012, 0.03, 0.005), alu,
        [X - s * 0.055, 0.966, 0.045 - b * 0.042], [0, 0, s * 0.1], [2, 1]);
    }
    // inner door release
    put(rbox(0.024, 0.038, 0.11, 0.012), alu, [X - s * 0.03, 1.03, 0.24], [0, 0, 0], [3, 1]);
    put(rbox(0.02, 0.055, 0.14, 0.02), shadow, [X - s * 0.012, 1.025, 0.24]);
    // speaker grille sunk into the lower card
    put(new THREE.CircleGeometry(0.072, 22), grille, [X - s * 0.028, 0.71, 0.26], yawIn, 3);
    put(new THREE.TorusGeometry(0.076, 0.008, 6, 22), piano, [X - s * 0.028, 0.71, 0.26], yawIn);
    // map pocket
    put(rbox(0.07, 0.02, 0.44, 0.01), soft, [X - s * 0.03, 0.665, -0.14], [0, 0, 0], 1.6);
    put(rbox(0.02, 0.11, 0.44, 0.015), soft, [X - s * 0.062, 0.71, -0.14], [s * 0.14, 0, 0], 1.6);
    // sill / kick panel
    put(rbox(0.06, 0.12, 1.32, 0.02), shadow, [X + s * 0.01, 0.585, -0.08]);
  }

  /* ------------------------------------------- pillars, roof, headliner */

  /* A-pillars: tapered rounded prisms rather than raw slabs. */
  for (const s of [-1, 1]) {
    const p = new THREE.CylinderGeometry(0.038, 0.058, 0.72, 7);
    put(p, soft, [s * 0.745, 1.37, 0.79], [0.06, 0, -s * 0.42], [2, 2]);
    put(cyl(0.03, 0.042, 0.16, 7), soft, [s * 0.79, 1.06, 0.72], [0.05, 0, -s * 0.42], 2);
  }
  /* B-pillars behind the seats. */
  for (const s of [-1, 1]) {
    put(rbox(0.05, 0.52, 0.09, 0.02), soft, [s * 0.83, 1.36, -0.34], [0, 0, 0], [1, 3]);
  }
  /* Headliner: a shallow crowned arc, the lightest surface in the cabin. */
  {
    /* radius 6 over a 1.72 m span gives a ~6 cm crown; the arc is the outside
       of the cylinder so it has to be flipped to face down into the cabin */
    const R = 6, half = Math.asin(0.86 / R);
    const arc = new THREE.CylinderGeometry(R, R, 2.0, 12, 1, true, Math.PI - half, half * 2);
    arc.rotateX(Math.PI / 2);
    put(flipped(arc), liner, [0, ROOF_Y + 0.06 - R, -0.25], [0, 0, 0], [1, 6]);
    // windscreen header and the roof rails that frame it
    put(rbox(1.66, 0.07, 0.14, 0.03), liner, [0, 1.652, 0.5], [0.3, 0, 0], [4, 1]);
    for (const s of [-1, 1]) put(rbox(0.08, 0.07, 2.0, 0.028), liner, [s * 0.8, 1.655, -0.25], [0, 0, 0], [1, 6]);
    // dome light
    put(rbox(0.16, 0.02, 0.1, 0.012), piano, [0, 1.695, 0.3]);
    put(rbox(0.11, 0.014, 0.06, 0.008), amber, [0, 1.687, 0.3]);
  }
  /* Sun visors and grab handles. */
  for (const s of [-1, 1]) {
    put(rbox(0.6, 0.022, 0.21, 0.014), liner, [s * 0.42, 1.648, 0.5], [0.32, 0, 0], [3, 1]);
    put(cyl(0.011, 0.011, 0.07, 8), alu, [s * 0.12, 1.66, 0.52], [0, 0, Math.PI / 2], [2, 1]);
    // grab handle over the door
    put(rbox(0.04, 0.04, 0.22, 0.018), liner, [s * 0.78, 1.6, -0.1], [0, 0, 0], [2, 1]);
    for (const gz of [-0.19, -0.01])
      put(rbox(0.04, 0.08, 0.05, 0.018), liner, [s * 0.78, 1.635, gz], [0, 0, 0], [2, 1]);
  }

  endRegion();

  /* ------------------------------------------------------------ seats */

  function seat(sx: number) {
    const back: P3 = [0.15, 0, 0];
    // squab
    put(rbox(0.46, 0.13, 0.52, 0.055), leather, [sx, 0.565, -0.26], [0, 0, 0], [2, 2]);
    put(rbox(0.3, 0.1, 0.48, 0.04), perf, [sx, 0.6, -0.26], [0, 0, 0], [2, 3]);
    for (const b of [-1, 1]) {
      put(rbox(0.11, 0.15, 0.5, 0.05), leather, [sx + b * 0.2, 0.6, -0.26], [0, 0, b * 0.16], [1, 3]);
      put(box(0.004, 0.005, 0.44), stitch, [sx + b * 0.135, 0.645, -0.26], [0, Math.PI / 2, 0]);
    }
    // backrest
    put(rbox(0.46, 0.66, 0.14, 0.05), leather, [sx, 0.92, -0.55], back, [2, 2]);
    put(rbox(0.29, 0.58, 0.11, 0.035), perf, [sx, 0.92, -0.525], back, [2, 3]);
    for (const b of [-1, 1]) {
      put(rbox(0.1, 0.6, 0.16, 0.05), leather, [sx + b * 0.2, 0.93, -0.535], [0.15, 0, b * 0.05], [1, 3]);
      put(box(0.004, 0.55, 0.005), stitch, [sx + b * 0.135, 0.93, -0.475], [0.15, 0, 0]);
    }
    // shoulder cut-out + headrest on twin posts
    put(rbox(0.4, 0.09, 0.13, 0.04), leather, [sx, 1.235, -0.6], back, [2, 1]);
    for (const b of [-1, 1]) put(cyl(0.014, 0.014, 0.09, 8), alu, [sx + b * 0.075, 1.29, -0.612], back, [2, 1]);
    put(rbox(0.28, 0.17, 0.13, 0.05), leather, [sx, 1.355, -0.63], [0.2, 0, 0], [2, 1]);
    put(box(0.004, 0.005, 0.1), stitch, [sx, 1.43, -0.628], [0.2, Math.PI / 2, 0]);
    // seat base frame + rails
    put(rbox(0.42, 0.06, 0.44, 0.02), piano, [sx, 0.485, -0.26]);
    for (const b of [-1, 1]) put(rbox(0.04, 0.05, 0.56, 0.014), alu, [sx + b * 0.17, 0.44, -0.26], [0, 0, 0], [1, 6]);
    // belt: buckle receiver in the tunnel, webbing over the shoulder bolster
    const inb = -Math.sign(sx); // sign pointing toward the tunnel
    put(rbox(0.05, 0.1, 0.03, 0.014), piano, [sx + inb * 0.24, 0.63, -0.34], [0, 0, -inb * 0.3]);
    put(cyl(0.016, 0.018, 0.024, 10), alu, [sx + inb * 0.24, 0.685, -0.335], [Math.PI / 2, 0, 0]);
    put(box(0.048, 0.5, 0.006), shadow, [sx - inb * 0.21, 0.99, -0.47], [0.15, 0, -inb * 0.08]);
  }
  seat(0.38);
  seat(-0.38);

  /* Rear bench, mostly glimpsed in the mirror and over the shoulder. */
  {
    put(rbox(1.42, 0.16, 0.5, 0.06), leather, [0, 0.63, -1.02], [0, 0, 0], [4, 2]);
    put(rbox(1.42, 0.5, 0.16, 0.06), leather, [0, 0.93, -1.24], [0.14, 0, 0], [4, 2]);
    put(rbox(1.3, 0.42, 0.12, 0.04), perf, [0, 0.93, -1.21], [0.14, 0, 0], [5, 2]);
    for (const hx of [-0.36, 0.36])
      put(rbox(0.26, 0.13, 0.12, 0.045), leather, [hx, 1.22, -1.3], [0.14, 0, 0], [2, 1]);
    // parcel shelf under the rear glass
    put(rbox(1.42, 0.04, 0.42, 0.02), liner, [0, 1.12, -1.5], [0, 0, 0], [4, 2]);
  }

  /* ------------------------------------------------- floor, pedals, mats */

  put(rbox(1.6, 0.03, 2.1, 0.02), carpet, [0, 0.245, -0.25], [0, 0, 0], [6, 8]);
  for (const sx of [0.42, -0.42]) {
    put(rbox(0.44, 0.014, 0.5, 0.02), carpet, [sx, 0.264, 0.24], [0, 0, 0], [3, 3]);
    put(box(0.4, 0.006, 0.008), stitch, [sx, 0.272, 0.46]);
  }
  // pedals: alloy faces with rubber pads, plus the dead pedal
  for (const [px, pw] of [[0.255, 0.075], [0.4, 0.095], [0.53, 0.065]] as const) {
    put(rbox(pw, 0.12, 0.016, 0.008), alu, [px, 0.345, 0.585], [-0.5, 0, 0], [2, 2]);
    put(rbox(pw - 0.022, 0.09, 0.008, 0.004), shadow, [px, 0.35, 0.575], [-0.5, 0, 0]);
    put(rbox(0.026, 0.16, 0.026, 0.01), piano, [px, 0.26, 0.605], [-0.2, 0, 0]);
  }
  put(rbox(0.085, 0.19, 0.02, 0.012), alu, [0.635, 0.4, 0.555], [-0.5, 0, 0.12], [2, 3]);

  /* ------------------------------------------------- ambient light strips */

  /* Everything under the pad sits in the pad's own shadow, and with no interior
     light source the vents, glovebox and console reduce to a black mass however
     well they are modelled. These strips are what makes that half of the cabin
     legible — and they suit the night-drive setting.

     Tagged "cabin" despite being lighting rather than trim: the strips are
     pinned to DOOR_X, the inner face of the procedural door card. Replace that
     door with a donor's and they are lighting nothing — they hang in the space
     where it used to be and read as a bare accent-coloured line across the
     frame. They belong to the door, so they leave with it.

     Cost of that, stated plainly: the imported view loses this fill and its
     lower half goes darker. The fix is to re-anchor them to the donor's door
     card rather than to drop them, which is worth doing once the geometry has
     settled. */
  beginRegion("cabin");
  {
    const led = new THREE.MeshStandardMaterial({
      color: 0x05070c, emissive: trimAccent, emissiveIntensity: 0.55, roughness: 0.6,
    });
    const ledDim = new THREE.MeshStandardMaterial({
      color: 0x05070c, emissive: trimAccent, emissiveIntensity: 0.3, roughness: 0.6,
    });
    // under the pad's leading edge, washing down the facia
    put(box(1.5, 0.008, 0.008), led, [0, 0.878, FACIA_Z - 0.016]);
    // along the top of each door card
    for (const s of [-1, 1])
      put(box(0.008, 0.006, 1.12), ledDim, [s * (DOOR_X - 0.036), 1.075, -0.06]);
    // console flanks
    for (const s of [-1, 1])
      put(box(0.006, 0.006, 0.8), ledDim, [s * 0.176, 0.82, -0.02]);
    // footwell wash
    put(box(0.5, 0.005, 0.005), ledDim, [0.38, 0.5, 0.5]);
    put(box(0.5, 0.005, 0.005), ledDim, [-0.38, 0.5, 0.5]);
  }

  /* One real light to go with the emissive strips: a dim warm point light up
     by the windscreen header, raking BACK across the pad top and down the door
     caps. Emissive-only cabins go flat because ambient light has no direction
     — the leather grain, the stitch relief and the quilt normal map only exist
     where light arrives at an angle, and this is the light that provides the
     angle. Physical units (the renderer runs physical lights — headlights are
     hundreds of candela): ~0.5 cd at 0.5-1 m gives the pad a soft 1-2 lux
     wash, well under the exterior street lighting. distance clamps it inside
     the cabin; it lives in interiorG so chase view never pays for it. */
  const cabinLight = new THREE.PointLight(0xffd2a4, CABIN_DOME, 3.0, 2);
  cabinLight.position.set(0, 1.42, 0.28);
  /* Shipped OFF. At night a real cabin is a silhouette — the reference capture
     the look is tuned against has a dash, door card, A-pillar and wheel rim
     that are all pure black, and everything you can read is either an emitter
     (cluster, screen, accent strips) or a grazing highlight off OUTSIDE light.
     A fill light from inside the car is the one thing that cannot happen at
     night, and it was the loudest tell in the frame. `glassLight` below is the
     source that stays. */
  cabinLight.intensity = 0;
  interiorG.add(cabinLight);
  endRegion();

  /* ------------------------------------------- overhead console hit target */

  /* Somewhere for a click to land on the roof panel the dome light lives in,
     so the lamp above can be switched by reaching up for it and not only by
     the I key. Pure hit geometry, nothing drawn: BOTH cabins already model an
     overhead console at these coordinates — the procedural one is the piano
     housing and amber lens in the headliner block above, the donor's is its
     `headliner` role (CeilingConsole, bbox [-0.089, 1.319, 0.230] ..
     [0.089, 1.375, 0.436] in volvo-s90-full.json) — so the ray is being tested
     against a panel the eye can see, and there is nothing to add to the frame.

     Two volumes rather than one moved between the cabins, because the two
     roofs are nowhere near each other: the procedural headliner crowns at
     ROOF_Y 1.70, the donor's roof is at 1.42. One box spanning both would be a
     40 cm slab hanging through the middle of whichever cabin is up, and worse,
     from the PROCEDURAL cockpit eye the donor's anchor sits dead ahead at eye
     level — a click aimed at the road would toggle the interior light.
     engine.ts asks for the one matching the cabin actually on show.

     `visible = false` rather than a transparent material: a Raycaster ignores
     the flag (which is exactly why engine.ts still has to check the camera is
     inside the car) while the renderer honours it, so neither box ever reaches
     a draw list or a shadow pass. `side` is then the one property on the
     material that still does anything: Mesh.raycast reads it to decide whether
     to keep a back-facing triangle, and an eye that ended up inside one of
     these volumes would find nothing at all under the default FrontSide. */
  const hitMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const domeHit = (w: number, h: number, d: number, at: P3) => {
    const m = new THREE.Mesh(box(w, h, d), hitMat);
    m.position.set(at[0], at[1], at[2]);
    m.visible = false;
    return m;
  };
  /* Procedural: the housing is 0.16 x 0.02 x 0.10 at y 1.695 and the volume is
     grown well past it and hung below into open cabin air, where the nearest
     other thing is the sun visor's inner tip (x 0.12, z 0.395) — clear of this
     in z. A switch you have to hit to the millimetre is not a switch. */
  const domeHitProc = domeHit(0.26, 0.08, 0.18, [0, 1.67, 0.3]);
  interiorG.add(domeHitProc);
  /* Donor: its own bbox, 20 mm proud each side across and 20 mm below, and
     deliberately NOT extended forward — the mirror hangs at z 0.441 and this
     must not reach into it.

     Wrapped in a group carrying the donor's counter-scale. cockpitmodel.ts
     hangs the whole donor scene at (1, sx, sx) under this group's (sx, 1, 1)
     so a donor dash scales uniformly instead of being flattened; a box
     parented straight to interiorG would get only the (sx, 1, 1) half of that
     and would drift off the console by however much sx differs from 1. It is 1
     on the car this ships on, so the group is a no-op today — it is here so
     the target still lands on a narrower shell. */
  const donorSpace = new THREE.Group();
  donorSpace.add(domeHit(0.23, 0.076, 0.23, [0, 1.337, 0.321]));
  interiorG.add(donorSpace);

  /* And its counterpart: a faint cool wash from the base of the windscreen
     raking BACK across the pad toward the seat — the "city light through the
     glass" that gives the pad top its grazing sheen in the reference photo.
     Without it the pad's upward face sees only ambient and reads as a flat
     navy sheet however good its leather maps are. */
  const glassLight = new THREE.PointLight(GLASS_REST.color, GLASS_REST.intensity, 2.4, 2);
  glassLight.position.set(0, GLASS_REST.y, GLASS_REST.z);
  interiorG.add(glassLight);

  /* ---------------------------------------------------- window openings */

  const winGlassM = new THREE.MeshBasicMaterial({
    color: 0x9fc4ee, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide,
  });
  /* Collected rather than fire-and-forgotten, because a donor cabin has to be
     able to turn them OFF. These five panes are hand-placed against the
     PROCEDURAL cabin's window openings, and they are added straight to
     interiorG rather than through put(), so they are in no merge region —
     which means the donor taking over "cabin" does not hide them the way it
     hides the procedural door cards. Left visible under the Volvo they hang in
     its cabin at coordinates that no longer describe any opening, and the rear
     pair in particular read as a flat pale square floating over the quarter
     window. Reported exactly that way: "theres like a window pane its like
     opaque square kinda random".

     The donor brings its own glazing, so there is nothing to replace. */
  const windowGlass: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const wgF = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.5), winGlassM);
    wgF.position.set(s * 0.86, 1.38, 0.32);
    wgF.rotation.y = (s * Math.PI) / 2;
    interiorG.add(wgF);
    windowGlass.push(wgF);
    const wgR = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.44), winGlassM);
    wgR.position.set(s * 0.86, 1.36, -0.86);
    wgR.rotation.y = (s * Math.PI) / 2;
    interiorG.add(wgR);
    windowGlass.push(wgR);
  }
  const wgB = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.42), winGlassM);
  wgB.position.set(0, 1.34, -1.28);
  wgB.rotation.x = 0.42;
  interiorG.add(wgB);
  windowGlass.push(wgB);

  /* ------------------------------------------- cluster (see dashboard.ts) */

  const cluster = buildInstrumentCluster(trimAccent, loadProfile().settings.units, TRIM === "kei", style.chunky);
  cluster.group.position.set(POD.x, POD.y, POD.z);
  cluster.group.rotation.set(POD.tilt, Math.PI, 0); // faces back toward the driver
  interiorG.add(cluster.group);

  function drawGauges(rpm: number, kmh: number, gearTxt: string, now: number, f: GaugeFlags) {
    cluster.update(rpm, kmh, gearTxt, now, f);
  }

  /* --------------------------------------------------------- nav screen */

  const scrCv = document.createElement("canvas");
  // 2x the head unit's 256x160 logical space — carscreen.ts maps its
  // coordinates onto whatever store it gets, and the dash-top tablet is
  // big enough on screen now that 1x visibly pixelates.
  scrCv.width = 512;
  scrCv.height = 320;
  const scrTex = new THREE.CanvasTexture(scrCv);
  /* Dash-top tablet, per the user's reference: the head unit stands proud
     of the pad at the centre of the dash — clearly visible from the seat
     AND from the fixed dashcam mount — instead of sunk low into the stack.
     Placement is solved against the POV camera at cockpit-local
     (0.28, 1.32, 0.31) pitched down 0.227 (engine.ts POV_MOUNT/POV_TILT,
     which do not move): at x -0.03, y 1.13 the glass lands mid-frame in the
     band the bonnet otherwise leaves black (~62-80% across, ~46-63% down,
     measured), clear of the open binnacle to its screen-left, below the road
     scene and above the cluster. From the seat its top edge stays just under
     the horizon line. It sits just behind the pad crest (crest
     ~y1.0 at z0.695), leans back a touch and yaws toward the driver's eye at
     x0.36. Yaw sign, verified against THREE's XYZ euler (glass normal x =
     sin(PI - yaw)): POSITIVE yaw turns the face toward the driver. At -0.08
     it actually faced the passenger, so both interior cameras saw the LCD
     ~44 degrees off-normal — foreshortened to a sliver whose dark map read
     as a black slab. +0.25 puts the dashcam ~26 degrees off-normal and the
     driver's eye ~8, and the glass finally reads. */
  /* x -0.065: measured port from the candidate-B pass — at -0.03 the glass's
     left ~8 cm still tucked behind the binnacle corner from the POV lens;
     -0.11 overshot the right frame edge. This clears both. */
  const SCR = { x: -0.065, y: 1.13, z: 0.72, tilt: 0.10, yaw: 0.25 };
  const scrMat = new THREE.MeshBasicMaterial({ map: scrTex, transparent: true });
  /* An LCD is a light source: left tone-mapped it crushes into the night and
     the whole unit reads as a black slab (exactly the dead-space complaint the
     dashcam view had). Same treatment as the mirror glass — exempt it, with
     a modest lift: the dashcam post pass (bloom + CA) blooms anything hot,
     and brighter multipliers wash the hot pixels (road ribbon, cards) out to
     white in POV while the map bg stays black either way. */
  scrMat.toneMapped = false;
  scrMat.color.setScalar(1.3);
  const scrMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.225), scrMat);
  scrMesh.position.set(SCR.x, SCR.y, SCR.z);
  scrMesh.rotation.set(SCR.tilt, Math.PI - SCR.yaw, 0);
  interiorG.add(scrMesh);
  /* The tablet is dash furniture, so it belongs to the "dash" region even
     though it is built down here with the rest of the screen plumbing: a donor
     model brings its own head unit and this one has to go with the pad. The
     glass plane above stays out of the region and is hidden separately — the
     canvas it carries is re-bound onto the donor's screen mesh, not thrown
     away with the bezel. */
  beginRegion("dash");
  /* Tablet body: slim piano-black slab + bezel lip around the glass. The
     body pieces face +z (away from the seat) while the glass faces -z, so
     the rotation that keeps a body piece coplanar with the glass at
     (tilt, PI - yaw) is (tilt, -yaw) — the old (-tilt, +yaw) form is only an
     approximation that falls apart once yaw is more than a few degrees. */
  put(bezel(0.395, 0.26, 0.017, 0.017, 0.016), piano,
    [SCR.x, SCR.y, SCR.z + 0.005], [SCR.tilt, -SCR.yaw, 0]);
  put(rbox(0.395, 0.26, 0.024, 0.012), shadow,
    [SCR.x, SCR.y, SCR.z + 0.018], [SCR.tilt, -SCR.yaw, 0]);
  // a faint backlight ring behind the bezel, so the head unit reads as lit
  // rather than a screen bolted to a dead panel
  const navGlow = new THREE.MeshStandardMaterial({
    color: 0x05070c, emissive: trimAccent, emissiveIntensity: 0.5, roughness: 0.6,
  });
  put(bezel(0.404, 0.269, 0.006, 0.02, 0.004), navGlow,
    [SCR.x, SCR.y, SCR.z + 0.010], [SCR.tilt, -SCR.yaw, 0]);
  /* Mount foot rooting the tablet into the pad top so it doesn't float — it
     runs from inside the pad (~y1.0 surface here) up behind the bezel's lower
     edge, so the unit reads as clamped to the dash top. */
  put(rbox(0.10, 0.20, 0.04, 0.012), piano,
    [SCR.x, SCR.y - 0.15, SCR.z + 0.03], [SCR.tilt * 1.6, -SCR.yaw, 0]);
  endRegion();

  function drawScreen(world: WorldData, car: CarState, npcs: Npc[], time: number, now: number,
                      music?: ScreenMusic, ui?: ScreenUI) {
    /* CarPlay-style head unit — the live nav map filling the panel, with the
       music player as a second view a click away (desktop only). All rendering
       lives in carscreen.ts; this canvas/texture and the call cadence
       (engine.ts, every ~45 ms in cockpit/POV) are unchanged. The map throttles
       itself below that cadence — see NAV_MS there. */
    drawCarScreen(scrCv, world, car, npcs, time, now, music, ui);
    scrTex.needsUpdate = true;
  }

  /* ------------------------------------------------- steering wheel + hands */

  const wheelGroup = new THREE.Group();
  wheelGroup.position.set(POD.x, 0.895, FACIA_Z - 0.18);
  wheelGroup.rotation.x = -0.34;
  interiorG.add(wheelGroup);
  /* Rim wrap varies by trim: coupe's dark leather, sedan's polished walnut,
     kei's plain hard plastic, rally's thicker cloth-wrapped grip. */
  const rimMat = new THREE.MeshStandardMaterial(
    style.wheelKind === "wood" ? { map: woodTex, roughness: 0.22, metalness: 0.1 } :
    style.wheelKind === "plastic" ? { color: 0x121317, roughness: 0.6, metalness: 0.05 } :
    style.wheelKind === "cloth" ? { map: leatherTex, color: 0x3a4048, roughness: 0.96 } :
    { map: leatherTex, bumpMap: leatherTex, bumpScale: 0.5, roughness: 0.72 }
  );
  const rimTube = style.chunky ? 0.031 : 0.024;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.175, rimTube, 12, 34), rimMat);
  wheelGroup.add(rim);
  // thicker moulded grips at 9 and 3
  for (const s of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.TorusGeometry(0.175, rimTube + 0.007, 10, 14, 1.2), rimMat);
    grip.rotation.z = s > 0 ? -0.6 : Math.PI - 0.6;
    wheelGroup.add(grip);
  }
  /* Three spokes: a leather-wrapped root that meets the hub and a slimmer alloy
     blade running out to the rim, so the centre does not read as one black box. */
  const spokeMat = new THREE.MeshStandardMaterial({
    map: aluTex, color: style.aluTint, metalness: style.aluMetal * 0.9, roughness: style.aluRough,
  });
  for (const a of [Math.PI, 1.02, -1.02]) {
    const sx = Math.sin(a), sy = -Math.cos(a);
    const blade = new THREE.Mesh(rbox(0.042, 0.115, 0.016, 0.008), spokeMat);
    blade.position.set(sx * 0.115, sy * 0.115, -0.004);
    blade.rotation.z = -a;
    wheelGroup.add(blade);
    const root = new THREE.Mesh(rbox(0.072, 0.08, 0.03, 0.014), rimMat);
    root.position.set(sx * 0.055, sy * 0.055, 0);
    root.rotation.z = -a;
    wheelGroup.add(root);
  }
  // airbag boss: a domed pad with a chrome surround, not a flat black block
  const hubMat = new THREE.MeshStandardMaterial(
    style.wheelKind === "plastic" ? { color: 0x121317, roughness: 0.55 } :
    { map: leatherTex, bumpMap: leatherTex, bumpScale: 0.4, roughness: 0.62 }
  );
  const hub = new THREE.Mesh(rbox(0.145, 0.105, 0.055, 0.032), hubMat);
  hub.position.z = 0.012;
  wheelGroup.add(hub);
  const hubRing = new THREE.Mesh(bezel(0.152, 0.112, 0.014, 0.036, 0.007), spokeMat);
  hubRing.position.z = 0.032;
  wheelGroup.add(hubRing);
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.019, 16), accentMat);
  badge.position.z = 0.041;
  wheelGroup.add(badge);
  // 12 o'clock centre marker + thumb buttons on the spoke roots
  const mark = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.018, 0.05), accentMat);
  mark.position.set(0, 0.176, 0.006);
  wheelGroup.add(mark);
  for (const s of [-1, 1]) {
    for (let b = 0; b < 2; b++) {
      const btn = new THREE.Mesh(rbox(0.026, 0.016, 0.008, 0.004), piano);
      btn.position.set(s * (0.058 + b * 0.032), -0.052 - b * 0.012, 0.02);
      btn.rotation.z = -s * 1.02;
      wheelGroup.add(btn);
    }
  }
  // shift paddles behind the rim
  for (const s of [-1, 1]) {
    const pad = new THREE.Mesh(rbox(0.024, 0.085, 0.012, 0.006),
      new THREE.MeshStandardMaterial({ map: aluTex, color: 0xc8cfda, metalness: 0.85, roughness: 0.32 }));
    pad.position.set(s * 0.14, 0.03, -0.05);
    pad.rotation.z = s * 0.16;
    wheelGroup.add(pad);
  }

  const skinMat = new THREE.MeshStandardMaterial({ color: 0x8a6248, roughness: 0.75 });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x22242c, roughness: 0.85 });
  function hand(side: number) {
    const g = new THREE.Group();
    const palm = new THREE.Mesh(rbox(0.058, 0.078, 0.05, 0.02), skinMat);
    g.add(palm);
    for (let f = 0; f < 4; f++) {
      const fg = new THREE.Mesh(rbox(0.013, 0.042, 0.016, 0.006), skinMat);
      fg.position.set(-0.019 + f * 0.0125, 0.05, -0.014);
      fg.rotation.x = -0.7;
      g.add(fg);
    }
    const th = new THREE.Mesh(rbox(0.015, 0.034, 0.016, 0.007), skinMat);
    th.position.set(side * 0.03, 0.012, 0.022);
    th.rotation.z = side * 0.7;
    g.add(th);
    const sl = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.038, 0.16, 10), sleeveMat);
    sl.position.set(side * 0.02, -0.13, 0.05);
    sl.rotation.x = 0.5;
    sl.rotation.z = side * 0.22;
    g.add(sl);
    return g;
  }
  const handL = hand(-1), handR = hand(1);
  handL.position.set(-0.16, 0.055, 0.016);
  handL.rotation.z = 0.85;
  handR.position.set(0.16, 0.055, 0.016);
  handR.rotation.z = -0.85;
  wheelGroup.add(handL, handR);

  /* ------------------------------------------------------------- mirrors */

  const mirrorMat = new THREE.MeshBasicMaterial({ map: mirrorTexture, side: THREE.DoubleSide });
  mirrorMat.toneMapped = false;
  mirrorMat.color.setScalar(1.55);
  /* All three mirrors sample the same wide (~99°, aspect 2.5) rearCam render
     target — one shared RT, but each glass reads a different horizontal slice
     of it rather than the whole frame stretched to fit. `cropUV` rewrites a
     plane's own uv attribute (cheap: 4 verts), so the material and its
     texture stay shared across all three meshes.

     The rearCam looks *backward* (down -forward), so its local right (u=1
     edge of the render) is the world side that is the DRIVER'S LEFT, which is
     cockpit-local +x (see the wing-mirror block below for why +x is left).
     Each glass then takes the slice for its own flank: the LEFT door glass
     wants the part of the frame biased toward the world-left flank (u toward
     1) and the RIGHT door glass the world-right flank (u toward 0), so each
     reads like it is looking down its own side of the car rather than being a
     smaller copy of the rear-view mirror.

     WHICH WAY ROUND u RUNS ACROSS A GLASS is the part that is easy to get
     backwards, and the rear-view mesh below still has it backwards — see the
     note on its `scale.x`. A rearward camera frame shown on a SCREEN does
     read mirrored against a real mirror and needs flipping, which is the
     intuition that put the flip there. But these planes are not screens: the
     eye sits BEHIND them (their +z normals point forward, away from the
     driver), and viewing a textured quad from behind already reverses it
     once. That reversal IS the screen flip, so a second one un-mirrors the
     reflection. The wing mirrors below therefore carry no `scale.x = -1`. */
  function cropUV(g: THREE.PlaneGeometry, u0: number, u1: number) {
    const uv = g.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
    uv.needsUpdate = true;
  }
  /* Sized and placed for the eye at ~0.65 m: a 0.5 m glass this close filled a
     quarter of the screen. Height is a two-camera compromise: at EYE.y+0.12
     the glass cleared the cockpit sightline generously but sat entirely above
     the dashcam frame (engine.ts POV mount, pitched down 0.227 — only an
     unlit sliver of housing crossed the top edge, i.e. invisible at night).
     EYE.y+0.085 hangs the lit glass into the POV frame's top-right (~rows
     0-20%) while its underside still clears the cockpit eye line by ~2
     degrees, above the horizon. */
  /* z 0.63 (candidate-B port): 3 cm forward cuts the housing's apparent
     width ~10% from the 105-degree POV lens and shows glass rather than
     housing underside at the frame top. */
  /* x +0.06: nudged toward the driver's side, which is screen-LEFT in the
     dashcam POV (car-local +x maps to screen-left through that lens — the same
     convention the head unit's SCR.x note records). Small on purpose: it moves
     the glass about a twentieth of the POV frame's width, clear of the frame's
     right edge without walking into the road ahead. */
  const MIR = { x: 0.06, y: Math.min(EYE.y + 0.085, 1.545), z: 0.63 };
  /* Back to a letterbox rectangle, which is what a rear-view mirror is. It
     was briefly square, and squaring it cost the thing the mirror is FOR: the
     rearCam RT is 2.5:1, so a square of glass can only show the middle 40% of
     that render without squashing it, and the far flanks — where a car about
     to overtake actually appears — fell out of frame. A 0.3 x 0.096 plane is
     close to the render's own 2.5:1, so it shows the whole width at very
     nearly true proportions and needs no crop at all. */
  const mirrorGeo = new THREE.PlaneGeometry(0.3, 0.096);
  const mirrorMesh = new THREE.Mesh(mirrorGeo, mirrorMat);
  /* z = MIR.z + 0.002 puts the glass in the PLANE OF THE LIP rather than in
     front of the whole assembly. It used to sit at MIR.z - 0.012, i.e. 9 mm
     proud of the rim's front face, so the rim was a ring floating behind a
     pane instead of a surround the pane sits in. */
  mirrorMesh.position.set(MIR.x, MIR.y, MIR.z + 0.002);
  mirrorMesh.rotation.x = -0.07;
  /* LEFT AND RIGHT ARE SWAPPED IN HERE, and this line is why — left as it is
     on purpose rather than flipped blind. Reflect the eye through this plane
     and follow the sightline: with the flip, the u=1 edge of the glass looks
     out to x ~ -7 m at 20 m behind, i.e. the car's RIGHT, while u=1 of the
     render holds the car's LEFT. Without it the two agree. The flip is the
     screen correction described above, applied to a plane that is already
     seen from behind and so has had it applied once by geometry.
     Straight-behind traffic lands dead centre either way, which is most of
     why this survived; what it costs is being able to tell WHICH side a car
     is passing on. Fixing it is a one-character change here plus the matching
     sign in cockpitmodel.ts's setActive (which restores this scale), and it
     wants eyes on the frame before it goes in — the whole mirror is tuned
     around what this currently shows. */
  mirrorMesh.scale.x = -1;
  interiorG.add(mirrorMesh);
  /* housing: rounded shell + a stalk up to the header, not a floating slab.
     Its own region, separate from the glass above: a donor brings a mirror
     BODY worth having (it matches its own dash and header) but never a working
     mirror, because a reflection needs a render target and a donor's is paint.
     So the shell can be swapped while the glass — ours, RT-fed, UV-cropped and
     shielded from the dashcam degrade by post.ts — stays put and moves into
     the donor's housing. */
  /* The frame — bezel lip plus the shell behind it — is its own group rather
     than part of the "mirror" merge region, and that is load-bearing.

     A donor that supplies a mirror BODY (the Volvo does) takes over the
     region, so everything in it is hidden when the donor dash is active. The
     donor's own moulded shell is hidden too — it was authored to be seen from
     outside the car and reads as an unlit plastic lump from 12 cm in front of
     a 105-degree lens, and it is sized around ITS glass rather than ours. Net
     effect, before this: on the Volvo the glass floated in mid-air with
     nothing around it at all.

     Out here the frame survives the region hide, and cockpitmodel.ts moves it
     with the glass, so the mirror is framed in both dashes. Costs two extra
     draw calls (the two meshes below are not merged into a region); worth it
     for a thing that sits in the top of the shipping camera's frame.

     Sized to sit proud of the 0.30 x 0.096 glass on every edge, so it reads
     as a rim the glass is set INTO rather than a slab behind it. */
  const mirrorFrame = new THREE.Group();
  mirrorFrame.position.set(MIR.x, MIR.y, MIR.z);
  mirrorFrame.rotation.x = -0.07;
  {
    /* Thin. Both senses of it, because the first pass was heavy in both:
       the rim overhung the 0.30 x 0.096 glass by 18 mm a side and the shell
       behind it was 56 mm deep, which from a lens 30 cm away is a slab with a
       mirror in it. Now a 7 mm rim and 24 mm of total depth — a real interior
       mirror is a sliver of glass in a thin surround, and at this distance
       the depth is most of what reads as bulk. */
    /* Wall 0.008, not 0.007: the aperture is outer minus twice the wall, so
       a wall equal to half the outer-minus-glass difference gives exactly the
       glass size, and edge-to-edge with zero overlap is where a hairline of
       background shows through between rim and glass at some angles. The wall
       is kept 1 mm inside the glass edge instead, which is also how a real
       mirror is retained in its housing.

       Thinner across three passes: the visible rim — outer edge to glass edge
       — has gone 7 mm -> 3 mm -> 1.25 mm of face, and total depth 25 -> 16 ->
       11 mm. Depth came down hardest each time because at 30 cm from the lens
       it is most of what reads as bulk.

       The 1 mm lap over the glass is held constant through all of it rather
       than scaled down with the rest. That overlap is the part doing the
       retaining and is what stops a hairline of background showing between
       rim and glass at an angle; eating further into a 96 mm-tall mirror to
       save trim would be the wrong trade. So the rim thins from the OUTSIDE,
       which is the side you see.

       This is close to the floor. Below about 1 mm of face the rim is just
       the lap, and the shell behind it starts to poke out past the lip. */
    const lip = new THREE.Mesh(bezel(0.3025, 0.0985, 0.005, 0.012, 0.00225), piano);
    lip.position.z = 0.002;
    const shell = new THREE.Mesh(rbox(0.2975, 0.0935, 0.007, 0.012), piano);
    shell.position.z = 0.007;
    mirrorFrame.add(lip, shell);
  }
  interiorG.add(mirrorFrame);

  beginRegion("mirror");
  /* The screen leans back as it rises, so the stalk has to run up and
     rearward — longer than it was, because the housing now hangs ~3.5 cm
     lower while the header it grows from did not move. */
  put(cyl(0.014, 0.018, 0.22, 10), piano, [MIR.x, MIR.y + 0.105, MIR.z - 0.05], [-0.5, 0, 0]);
  put(rbox(0.06, 0.03, 0.05, 0.012), piano, [MIR.x, MIR.y + 0.185, MIR.z - 0.095], [-0.3, 0, 0]);
  endRegion();

  /* -------------------------------------------------------- wing mirrors */

  /* WHICH SIDE IS WHICH, because the block that used to be here had it
     backwards and every symptom followed from that one fact.

     Cockpit-local +x is the car's LEFT — the driver's side. EYE.x is +0.36,
     the donor's steering hub is at +0.3855, and with forward at +z and up at
     +y a right-handed basis puts left at +x. Through the POV lens (which
     yaws to car heading + PI) that same axis lands on SCREEN-left, which is
     the sense two comments elsewhere are reaching for when they call this
     cockpit "RHD" — it is not; it is left-hand drive seen from behind.

     The old glasses were placed, angled and UV-cropped as if +x were the
     RIGHT. Each door's mirror therefore sat on the far side of the car from
     the flank it was showing, at a yaw that is very nearly the mirror image
     of the correct one (+0.72 rad where the donor's own bezel is at +0.216),
     which is the "angled very weirdly" of the report. Everything below is
     indexed by `s` — +1 car LEFT / driver, -1 car RIGHT — so the two cannot
     drift apart again.

     PLACEMENT IS MEASURED, NOT GUESSED. The Volvo's chrome mirror bezel is a
     flat ring, 171 x 109 mm and 1.6 mm thick, and those nodes now ship as the
     `sideMirror` role (tools/build-cockpit.mjs), so the housing this glass
     sits in is the car's own instead of a floating slab. Read off the shipped
     GLB: bezel centre (±0.9000, 1.0815, 0.5697), driver-facing normal
     (∓0.2145, 0, -0.9767). The old glass was at (±0.88, 1.12, 0.52) — 4 cm
     high and 5 cm behind the housing it was meant to be set into, which is
     the "they float" half of the report; the old procedural shells at ±0.955
     were fitted to the retired procedural cabin and missed it too.

     THAT NORMAL IS A REAL AIM, worth keeping. Reflect COCKPIT EYE through the
     bezel plane and the sightline runs 1.8 m outboard at the glass's inboard
     edge and 5.2 m at its outboard edge, 20 m back: a blind-spot-aimed door
     mirror that looks down the adjacent lane rather than at the car's own
     flank. Do not "straighten" it toward the eye. */
  const SIDE_MIR = {
    /* Bezel centre, with the glass stood 3 mm proud of it toward the driver
       so it never z-fights the ring it sits in. */
    x: 0.8994, y: 1.0815, z: 0.5668,
    /* rotation.y for the +x glass. The plane's normal (sin, 0, cos) is the
       bezel normal negated — the same plane, and the sign that puts u=1 on
       the edge where the far lane appears. */
    yaw: 0.2161,
  };
  const sideMirrors: THREE.Mesh[] = [];
  for (const s of [1, -1]) {
    /* u runs OUTBOARD-to-INBOARD on the left glass and inboard-to-outboard on
       the right, which is what this yaw and the absence of a `scale.x` flip
       between them produce: local +x lands on (cos yaw, 0, -sin yaw), so on
       the left mirror u=1 is the outboard edge (where the far lane is) and on
       the right mirror u=1 is the inboard edge (where the near lane is).
       Both agree with the render, whose u climbs toward the car's left. */
    /* 146 x 86 inside a 171 x 109 bezel, i.e. ~15% inset per axis rather than
       the ~7% a straight "fit the aperture" sum gives. The extra is for the
       CORNERS: the bezel is a rounded rectangle and the glass is a square-cut
       plane, so at 158 x 96 the plane's corners reached past the curve and a
       sliver of pane showed outside the ring (reported: "you can kinda see it
       peeking out"). Inscribing a rectangle in a rounded aperture costs more
       than the radius, so this is deliberately generous.

       Costs a little glass area, not field of view — cropUV below picks the
       slice of the render, and that is unchanged, so the mirror still shows
       the same stretch of road, just in a slightly smaller pane. */
    const g = new THREE.PlaneGeometry(0.146, 0.086);
    cropUV(g, s > 0 ? 0.58 : 0, s > 0 ? 1 : 0.42);
    const m = new THREE.Mesh(g, mirrorMat);
    m.position.set(s * SIDE_MIR.x, SIDE_MIR.y, SIDE_MIR.z);
    m.rotation.y = s * SIDE_MIR.yaw;
    interiorG.add(m);
    sideMirrors.push(m);
  }
  /* The procedural shells go in the "cabin" region, unlike the rear-view
     frame, and the difference is which donor part replaces them. The rear-view
     frame stays out of its region because the donor's rear-view housing is
     HIDDEN on arrival (it is a measuring stick, not a shell) and the glass
     would be left bare. These have the opposite problem: the donor now brings
     real wing mirrors and renders them, so a procedural shell left visible
     would sit inside the car's own. "cabin" is the region the donor's body
     panels take over, and a door mirror is body. */
  beginRegion("cabin");
  for (const s of [-1, 1]) {
    // sized and squared to the donor's own cap (x 0.80-1.01, y 0.97-1.15,
    // z 0.53-0.69) so the A/B toggle does not move the glass under itself
    put(rbox(0.196, 0.17, 0.11, 0.035), piano, [s * 0.9112, 1.07, 0.6205], [0, s * SIDE_MIR.yaw, 0]);
    // stub arm back to the door card, so it is mounted rather than hovering
    put(rbox(0.06, 0.06, 0.055, 0.02), piano, [s * 0.845, 1.045, 0.615], [0, s * SIDE_MIR.yaw, 0]);
  }
  endRegion();
  const mirrorParts = [mirrorMesh, ...sideMirrors];

  /* ------------------------------------------------------------- wipers */

  // travel from WIPER.rest (raised) to WIPER.park (laid down); see WIPER
  const wiperMat = new THREE.MeshStandardMaterial({ color: 0x0c0d11, roughness: 0.7 });
  const wiperA = new THREE.Group(), wiperB = new THREE.Group();
  function mkWiper() {
    const g = new THREE.Group();
    const arm = new THREE.Mesh(rbox(0.022, 0.42, 0.014, 0.006), wiperMat);
    arm.position.y = 0.21;
    g.add(arm);
    const bl = new THREE.Mesh(rbox(0.015, 0.34, 0.022, 0.006), wiperMat);
    bl.position.y = 0.4;
    g.add(bl);
    return g;
  }
  wiperA.add(mkWiper());
  wiperB.add(mkWiper());
  wiperA.position.set(0.32, 0.86, 0.95);
  wiperB.position.set(-0.28, 0.86, 0.95);
  wiperA.rotation.x = wiperB.rotation.x = -0.42;
  /* Built PARKED, not at rest. The car starts dry, so the first pose anyone
     could see is the parked one — and engine.ts's park test is "are you at
     WIPER.park", so building them anywhere else would have them travelling
     (and briefly visible) on the first frame of a drive that has had no rain
     in it. */
  wiperA.rotation.z = wiperB.rotation.z = WIPER.park;
  interiorG.add(wiperA, wiperB);
  wiperA.visible = wiperB.visible = false;

  /* -------------------------------------------- windshield droplet overlay */

  const dropCv = document.createElement("canvas");
  dropCv.width = 512;
  dropCv.height = 220;
  const dropCtx = dropCv.getContext("2d")!;
  const dropTex = new THREE.CanvasTexture(dropCv);
  const wsGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.56),
    new THREE.MeshBasicMaterial({
      map: dropTex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    })
  );
  wsGlass.position.set(0, 1.18, 0.8);
  wsGlass.rotation.x = -0.42;
  interiorG.add(wsGlass);
  let dropAcc = 0;
  function wiperCanvasWipe(zRot: number) {
    for (const px of [352, 160]) {
      // rotation.z back to sweep phase 0..1; the inverse of engine.ts's
      // `WIPER.rest - ph * WIPER.sweep`, off the same two numbers
      const a = (WIPER.rest - zRot) / WIPER.sweep;
      dropCtx.save();
      dropCtx.translate(px, 235);
      dropCtx.rotate(-0.5 + a * 1.35);
      dropCtx.clearRect(-9, -235, 20, 225);
      dropCtx.restore();
    }
  }
  function dropletsUpdate(dt: number, wiping: boolean, wiperRotZ: number, raining: boolean, speed: number) {
    if (!raining) {
      if (dropAcc > 0) {
        dropCtx.clearRect(0, 0, 512, 220);
        dropTex.needsUpdate = true;
        dropAcc = 0;
      }
      return;
    }
    dropAcc += dt;
    const n = Math.floor(rand(2, 6) + speed * 0.15);
    for (let i = 0; i < n; i++) {
      const x = rand(0, 512), y = rand(0, 220), r = rand(1, 2.6);
      const g = dropCtx.createRadialGradient(x, y, 0, x, y, r * 2.2);
      g.addColorStop(0, "rgba(200,220,255,.5)");
      g.addColorStop(0.6, "rgba(160,190,240,.22)");
      g.addColorStop(1, "rgba(160,190,240,0)");
      dropCtx.fillStyle = g;
      dropCtx.beginPath();
      dropCtx.arc(x, y, r * 2.2, 0, TAU);
      dropCtx.fill();
      if (speed > 8 && Math.random() < 0.5) {
        dropCtx.strokeStyle = "rgba(180,205,250,.18)";
        dropCtx.lineWidth = r * 0.8;
        dropCtx.beginPath();
        dropCtx.moveTo(x, y);
        dropCtx.lineTo(x + rand(-2, 2), y + rand(4, 10) + speed * 0.1);
        dropCtx.stroke();
      }
    }
    if (wiping) wiperCanvasWipe(wiperRotZ);
    if (Math.random() < 0.06) {
      dropCtx.globalCompositeOperation = "destination-out";
      dropCtx.fillStyle = "rgba(0,0,0,.06)";
      dropCtx.fillRect(0, 0, 512, 220);
      dropCtx.globalCompositeOperation = "source-over";
    }
    dropTex.needsUpdate = true;
  }

  flush();
  interiorG.traverse((o) => o.layers.set(1));
  /* The traverse above put the light on layer 1 only, which would make its
     collection differ between the main camera (layers 0+1) and the mirror /
     reflection cameras — and diverging light counts between passes means
     program-hash churn every frame. All-layers keeps the light state identical
     for every camera; its reach is bounded by `distance`, not by layers. */
  cabinLight.layers.enableAll();
  glassLight.layers.enableAll();

  return {
    group: interiorG,
    wheelGroup,
    wiperA,
    wiperB,
    mirrorParts,
    windowGlass,
    mirrorGlass: mirrorMesh,
    mirrorFrame,
    glassLight,
    /* Intensity, not `visible`: a light that leaves the scene's light list
       changes the material program hash, so flipping it would recompile every
       lit material in the cabin on each press. Zero intensity is free and the
       toggle is instant. */
    setCabinLight: (k) => { cabinLight.intensity = CABIN_DOME * k; },
    /* The counter-scale is applied here rather than at build time because
       player.ts sets group.scale.x AFTER this function returns, so there is no
       correct value to bake in. Cheap in the right place: this is read once per
       click, not once per frame. */
    cabinSwitch(imported) {
      donorSpace.scale.set(1, interiorG.scale.x, interiorG.scale.x);
      return imported ? donorSpace : domeHitProc;
    },
    setMirrorVis: (v) => {
      mirrorParts.forEach((m) => (m.visible = v));
      // the frame is not in mirrorParts (it is a Group, not a glass plane), so
      // it has to be told separately or M leaves an empty rim hanging there
      mirrorFrame.visible = v;
    },
    drawGauges,
    drawScreen,
    dropletsUpdate,
    regionGroups: regionG,
    clusterGroup: cluster.group,
    screenMesh: scrMesh,
    screenTexture: scrTex,
    donorScreen: null,
    /* The procedural tablet's own visible flag IS the swap: cockpitmodel.ts
       clears it exactly when it puts a donor screen on show, so it is the
       cheapest correct test for which panel post.ts should be shielding. */
    navPanel() { return scrMesh.visible || !this.donorScreen ? scrMesh : this.donorScreen; },
  };
}
