import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rand, randi, TAU } from "./util";
import { makeTex } from "./textures";
import { buildInstrumentCluster } from "./dashboard";
import { loadProfile, type SpeedUnits } from "./settings";
import { HX, RW } from "./world/const";

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
  setMirrorVis(v: boolean): void;
  drawGauges(rpm: number, kmh: number, gearTxt: string, now: number, flags: GaugeFlags): void;
  drawScreen(x: number, z: number, h: number, time: number, world?: NavWorld): void;
  dropletsUpdate(dt: number, wiping: boolean, wiperRotZ: number, raining: boolean, speed: number): void;
}

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

/* Head-unit road map types for drawScreen's optional `world` argument.
   Structural (not imported from world/data.ts or traffic.ts) so this file
   stays decoupled — engine.ts's WorldData already satisfies this shape;
   see the report to the team lead for the one-line call-site change needed
   to actually feed it through. */
export interface NavEdge { pts: ArrayLike<number>; ss: ArrayLike<number>; len: number }
export interface NavRamp { x0: number; x1: number; z0: number; z1: number; pts: { x: number; z: number }[] }
export interface NavExit { z: number; no: number; name: string }
export interface NavWorld {
  net: { edges: NavEdge[] };
  terrain?: { ramps: NavRamp[] };
  exits?: NavExit[];
}

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

  /** Contrast stitching, painted in the car's accent colour. */
  const stitchTex = makeTex(64, 8, (c, w, h) => {
    c.fillStyle = "#0f1015";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = accentCss;
    c.lineWidth = 2.2;
    c.lineCap = "round";
    for (let i = 0; i < 8; i++) {
      c.beginPath();
      c.moveTo(i * 8 + 1.6, h * 0.5 - 1.5);
      c.lineTo(i * 8 + 5.4, h * 0.5 + 1.5);
      c.stroke();
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
  const piano = new THREE.MeshStandardMaterial({ color: 0x0a0b0f, roughness: 0.14, metalness: 0.4 });
  const shadow = new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 0.96 });
  const grille = new THREE.MeshStandardMaterial({ map: meshTex, roughness: 0.85 });
  const stitch = new THREE.MeshStandardMaterial({ map: stitchTex, roughness: 0.7 });
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

  /* --- static-geometry accumulator ---------------------------------------- */

  type P3 = [number, number, number];
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  const _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

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
    let arr = buckets.get(mat);
    if (!arr) buckets.set(mat, (arr = []));
    arr.push(ng);
  }

  /** Merge every bucket down to one mesh per material. */
  function flush() {
    for (const [mat, gs] of buckets) {
      const merged = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      interiorG.add(new THREE.Mesh(merged, mat));
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
     dials — a deep bezel, a cowl, a hood — eats into the road ahead, so this
     uses a shallow ring and a lip rather than a proper cowl and keeps the pod's
     top edge ~7 degrees below the eye line. 15.5 degrees of depression is a
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
    // bezel ring around the dials
    put(bezel(0.68, 0.262, 0.05, 0.06, 0.023), soft, [x, y, z - 0.012], [-tilt, 0, 0], 2.2);
    // thin bright ring inside the bezel
    put(bezel(0.63, 0.232, 0.009, 0.05, 0.006), trimStripMat, [x, y, z - 0.032], [-tilt, 0, 0], [6, 1]);
    // lip along the top of the ring — a hood's worth of shading, no extra height
    put(rbox(0.69, 0.016, 0.07, 0.007), soft, [x, y + 0.125, z - 0.038], [-tilt - 0.3, 0, 0], [4, 1]);
    // matte throat behind the cluster so nothing shows through the gaps
    put(box(0.62, 0.28, 0.01), shadow, [x, y, z + 0.035], [-tilt, 0, 0]);
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
    // rear armrest lid with a stitched seam
    put(rbox(0.28, 0.05, 0.34, 0.024), leather, [0, 0.9, -0.45], [0, 0, 0], [2, 2]);
    put(box(0.005, 0.006, 0.3), stitch, [0.115, 0.926, -0.45]);
    put(box(0.005, 0.006, 0.3), stitch, [-0.115, 0.926, -0.45]);
  }

  /* --------------------------------------------------------- door cards */

  for (const s of [-1, 1]) {
    const X = s * DOOR_X;
    const yawIn: P3 = [0, s > 0 ? -Math.PI / 2 : Math.PI / 2, 0]; // face inboard
    // main card + belt rail
    put(rbox(0.05, 0.56, 1.3, 0.03), soft, [X + s * 0.02, 0.855, -0.08], [0, 0, 0], [1, 3]);
    put(rbox(0.062, 0.045, 1.3, 0.016), soft, [X + s * 0.012, 1.125, -0.08], [0, 0, 0], [1, 6]);
    put(rbox(0.058, 0.014, 1.26, 0.006), trimStripMat, [X + s * 0.008, 1.096, -0.08], [0, 0, 0], [1, 14]);
    // upper leather pad, proud of the card
    put(rbox(0.045, 0.14, 1.16, 0.02), leather, [X - s * 0.006, 1.01, -0.06], [0, 0, 0], [1, 3]);
    put(box(0.004, 0.005, 1.1), stitch, [X - s * 0.03, 1.075, -0.06], [0, Math.PI / 2, 0]);
    // perforated centre insert with an accent sweep above it
    put(rbox(0.03, 0.2, 0.72, 0.03), perf, [X - s * 0.012, 0.87, -0.1], [0, 0, 0], [1, 3]);
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
     legible — and they suit the night-drive setting. */
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

  /* ---------------------------------------------------- window openings */

  const winGlassM = new THREE.MeshBasicMaterial({
    color: 0x9fc4ee, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide,
  });
  for (const s of [-1, 1]) {
    const wgF = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.5), winGlassM);
    wgF.position.set(s * 0.86, 1.38, 0.32);
    wgF.rotation.y = (s * Math.PI) / 2;
    interiorG.add(wgF);
    const wgR = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.44), winGlassM);
    wgR.position.set(s * 0.86, 1.36, -0.86);
    wgR.rotation.y = (s * Math.PI) / 2;
    interiorG.add(wgR);
  }
  const wgB = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.42), winGlassM);
  wgB.position.set(0, 1.34, -1.28);
  wgB.rotation.x = 0.42;
  interiorG.add(wgB);

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
  scrCv.width = 256;
  scrCv.height = 160;
  const scrTex = new THREE.CanvasTexture(scrCv);
  const SCR = { x: STACK.x, y: 0.79, z: STACK.z - 0.028 };
  const scrMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.175),
    new THREE.MeshBasicMaterial({ map: scrTex, transparent: true })
  );
  scrMesh.position.set(SCR.x, SCR.y, SCR.z);
  scrMesh.rotation.set(STACK.tilt, Math.PI - STACK.yaw, 0); // angled toward the driver
  interiorG.add(scrMesh);
  // the screen is sunk into the stack behind a thin bezel — not floating
  put(bezel(0.315, 0.21, 0.018, 0.018, 0.014), piano,
    [SCR.x, SCR.y, SCR.z + 0.004], [-STACK.tilt, STACK.yaw, 0]);
  put(box(0.29, 0.185, 0.006), shadow,
    [SCR.x, SCR.y, SCR.z + 0.012], [-STACK.tilt, STACK.yaw, 0]);
  // a faint backlight ring behind the bezel, so the head unit reads as lit
  // rather than a screen bolted to a dead panel
  const navGlow = new THREE.MeshStandardMaterial({
    color: 0x05070c, emissive: trimAccent, emissiveIntensity: 0.4, roughness: 0.6,
  });
  put(bezel(0.324, 0.219, 0.006, 0.02, 0.004), navGlow,
    [SCR.x, SCR.y, SCR.z + 0.007], [-STACK.tilt, STACK.yaw, 0]);

  const NAV_R = 95; // metres of road drawn around the car
  const CX = 128, CY = 116; // car sits low on the screen so more road ahead is visible
  const NAV_SC = 1.55; // px per metre

  function drawScreen(x: number, z: number, h: number, time: number, world?: NavWorld) {
    const g = scrCv.getContext("2d")!;
    g.clearRect(0, 0, 256, 160);
    const bg = g.createRadialGradient(128, 80, 10, 128, 80, 140);
    bg.addColorStop(0, "#0a1220");
    bg.addColorStop(1, "#050810");
    g.fillStyle = bg;
    g.fillRect(0, 0, 256, 160);

    // heading-up transform: car-local +z(forward) -> screen up, +x(right) -> screen right
    const sinH = Math.sin(h), cosH = Math.cos(h);
    const toScreen = (wx: number, wz: number): [number, number] => {
      const dx = wx - x, dz = wz - z;
      const right = dx * cosH - dz * sinH;
      const fwd = dx * sinH + dz * cosH;
      return [CX + right * NAV_SC, CY - fwd * NAV_SC];
    };

    if (world) {
      // find the road nearest the car so it can be highlighted as "current"
      let bestEdge: NavEdge | null = null, bestRamp: NavRamp | null = null, bestD = 26;
      for (const e of world.net.edges) {
        const n = e.ss.length - 1;
        for (let i = 0; i <= n; i += 3) {
          const dx = e.pts[i * 3] - x, dz = e.pts[i * 3 + 2] - z;
          const d = Math.hypot(dx, dz);
          if (d < bestD) { bestD = d; bestEdge = e; bestRamp = null; }
        }
      }
      for (const r of world.terrain?.ramps ?? []) {
        for (const p of r.pts) {
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < bestD) { bestD = d; bestRamp = r; bestEdge = null; }
        }
      }

      // town roads
      for (const e of world.net.edges) {
        const n = e.ss.length - 1;
        const mx = e.pts[Math.floor(n / 2) * 3], mz = e.pts[Math.floor(n / 2) * 3 + 2];
        if (Math.hypot(mx - x, mz - z) > NAV_R + e.len / 2) continue;
        const cur = e === bestEdge;
        g.strokeStyle = cur ? "#eaf6ff" : "rgba(110,150,200,.55)";
        g.lineWidth = cur ? 4.5 : 2.4;
        if (cur) { g.shadowColor = "#7fd4ff"; g.shadowBlur = 7; }
        g.beginPath();
        let started = false;
        for (let i = 0; i <= n; i += 2) {
          const [X, Y] = toScreen(e.pts[i * 3], e.pts[i * 3 + 2]);
          if (X < -20 || X > 276 || Y < -20 || Y > 180) { started = false; continue; }
          if (!started) { g.moveTo(X, Y); started = true; } else g.lineTo(X, Y);
        }
        g.stroke();
        g.shadowBlur = 0;
      }
      // expressway deck, drawn as a straight highlighted trunk road
      {
        const cur = !bestEdge && !bestRamp && Math.abs(x - HX) < 20;
        g.strokeStyle = cur ? "#eaf6ff" : "rgba(120,200,255,.85)";
        g.lineWidth = cur ? 7 : 5.5;
        if (cur) { g.shadowColor = "#7fd4ff"; g.shadowBlur = 8; }
        const [X0, Y0] = toScreen(HX, z - NAV_R * 1.6);
        const [X1, Y1] = toScreen(HX, z + NAV_R * 1.6);
        g.beginPath();
        g.moveTo(X0, Y0);
        g.lineTo(X1, Y1);
        g.stroke();
        g.shadowBlur = 0;
      }
      // ramps
      for (const r of world.terrain?.ramps ?? []) {
        const mx = (r.x0 + r.x1) / 2, mz = (r.z0 + r.z1) / 2;
        if (Math.hypot(mx - x, mz - z) > NAV_R + 60) continue;
        const cur = r === bestRamp;
        g.strokeStyle = cur ? "#eaf6ff" : "rgba(120,255,190,.8)";
        g.lineWidth = cur ? 4.5 : 3;
        if (cur) { g.shadowColor = "#7fd4ff"; g.shadowBlur = 7; }
        g.beginPath();
        let started = false;
        for (const p of r.pts) {
          const [X, Y] = toScreen(p.x, p.z);
          if (X < -20 || X > 276 || Y < -20 || Y > 180) { started = false; continue; }
          if (!started) { g.moveTo(X, Y); started = true; } else g.lineTo(X, Y);
        }
        g.stroke();
        g.shadowBlur = 0;
      }
      // exits, labelled with their real name where the deck passes closest
      g.font = "700 9px sans-serif";
      g.textAlign = "left";
      for (const ex of world.exits ?? []) {
        if (Math.abs(ex.z - z) > NAV_R) continue;
        const [X, Y] = toScreen(HX - RW / 2 - 14, ex.z);
        if (X < -10 || X > 266 || Y < 6 || Y > 154) continue;
        g.fillStyle = "rgba(120,255,190,.95)";
        g.beginPath();
        g.arc(X, Y, 2, 0, TAU);
        g.fill();
        g.fillText(`${ex.no} ${ex.name}`, X + 5, Y + 3);
      }
    } else {
      // no world data wired up yet: plain scrolling grid so the screen still
      // reads as "on" — see report to team lead for the drawScreen hook
      g.strokeStyle = "rgba(40,120,220,.4)";
      g.lineWidth = 1;
      const ox = (x * NAV_SC) % 32, oz = (z * NAV_SC) % 32;
      for (let gx = -ox; gx < 256; gx += 32) { g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, 160); g.stroke(); }
      for (let gy = -oz; gy < 160; gy += 32) { g.beginPath(); g.moveTo(0, gy); g.lineTo(256, gy); g.stroke(); }
    }

    // player marker: fixed heading-up, always pointing straight ahead
    g.fillStyle = "#4fd2ff";
    g.shadowColor = "#4fd2ff";
    g.shadowBlur = 8;
    g.beginPath();
    g.moveTo(CX, CY - 8);
    g.lineTo(CX + 5.5, CY + 6);
    g.lineTo(CX, CY + 2.5);
    g.lineTo(CX - 5.5, CY + 6);
    g.closePath();
    g.fill();
    g.shadowBlur = 0;

    // head-unit chrome: title bar, clock, subtle CRT scanlines + vignette
    g.fillStyle = "rgba(6,10,18,.72)";
    g.fillRect(0, 0, 256, 18);
    g.fillStyle = "#9fb6de";
    g.font = "11px sans-serif";
    g.textAlign = "left";
    g.fillText("NAVI  首都高 C1", 8, 13);
    const mm = ((time % 1) * 60) | 0, hh = time | 0;
    g.textAlign = "right";
    g.fillText((hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm, 248, 13);
    g.strokeStyle = "rgba(70,110,160,.3)";
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 18.5); g.lineTo(256, 18.5); g.stroke();

    g.globalAlpha = 0.05;
    g.fillStyle = "#000";
    for (let sy = 0; sy < 160; sy += 2) g.fillRect(0, sy, 256, 1);
    g.globalAlpha = 1;
    const vg = g.createRadialGradient(128, 80, 60, 128, 80, 150);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.5)");
    g.fillStyle = vg;
    g.fillRect(0, 0, 256, 160);

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
  /* Sized and placed for the eye at ~0.65 m: a 0.5 m glass this close filled a
     quarter of the screen. */
  const MIR = { y: Math.min(EYE.y + 0.12, 1.58), z: 0.6 };
  const mirrorMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.096), mirrorMat);
  mirrorMesh.position.set(0, MIR.y, MIR.z - 0.012);
  mirrorMesh.rotation.x = -0.07;
  mirrorMesh.scale.x = -1;
  interiorG.add(mirrorMesh);
  // housing: rounded shell + a stalk up to the header, not a floating slab
  put(bezel(0.335, 0.13, 0.036, 0.045, 0.02), piano, [0, MIR.y, MIR.z], [-0.07, 0, 0]);
  put(rbox(0.32, 0.115, 0.05, 0.04), piano, [0, MIR.y, MIR.z + 0.024], [-0.07, 0, 0]);
  // the screen leans back as it rises, so the stalk has to run up and rearward
  put(cyl(0.014, 0.018, 0.16, 10), piano, [0, MIR.y + 0.08, MIR.z - 0.035], [-0.5, 0, 0]);
  put(rbox(0.06, 0.03, 0.05, 0.012), piano, [0, MIR.y + 0.152, MIR.z - 0.078], [-0.3, 0, 0]);

  const sideMirL = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.115), mirrorMat);
  sideMirL.position.set(-0.88, 1.12, 0.52);
  sideMirL.rotation.y = 0.72;
  sideMirL.scale.x = -1;
  interiorG.add(sideMirL);
  const sideMirR = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.115), mirrorMat);
  sideMirR.position.set(0.88, 1.12, 0.52);
  sideMirR.rotation.y = -0.72;
  sideMirR.scale.x = -1;
  interiorG.add(sideMirR);
  for (const s of [-1, 1])
    put(rbox(0.05, 0.16, 0.17, 0.03), piano, [s * 0.955, 1.12, 0.55], [0, -s * 0.72, 0]);
  const mirrorParts = [mirrorMesh, sideMirL, sideMirR];

  /* ------------------------------------------------------------- wipers */

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
  wiperA.rotation.z = wiperB.rotation.z = -0.12;
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
      const a = (-zRot - 0.12) / 1.23;
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

  return {
    group: interiorG,
    wheelGroup,
    wiperA,
    wiperB,
    mirrorParts,
    setMirrorVis: (v) => mirrorParts.forEach((m) => (m.visible = v)),
    drawGauges,
    drawScreen,
    dropletsUpdate,
  };
}
