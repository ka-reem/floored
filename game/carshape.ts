import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clamp } from "./util";
import type { ShellParams } from "./carspecs";

/* =====================================================================
   Parametric car bodywork.
   v3: curved profiles (quadratic beziers instead of hard corners), high
   segment counts + merged/smoothed vertex normals for the player car, so
   the shell reads as pressed sheet-metal instead of extruded plywood.
   ===================================================================== */

export function roundedBoxGeo(w: number, h: number, d: number, r: number, seg = 2) {
  r = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  const g = new THREE.BoxGeometry(w, h, d, seg * 2, seg * 2, seg * 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const hw = w / 2 - r,
    hh = h / 2 - r,
    hd = d / 2 - r;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const cx = clamp(x, -hw, hw),
      cy = clamp(y, -hh, hh),
      cz = clamp(z, -hd, hd);
    let dx = x - cx,
      dy = y - cy,
      dz = z - cz;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l > 1e-6) {
      dx /= l;
      dy /= l;
      dz /= l;
      p.setXYZ(i, cx + dx * r, cy + dy * r, cz + dz * r);
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Side profile of the body-in-white, with curved fascias, hood and decklid. */
export function hullShape(P: ShellParams) {
  const L2 = P.L / 2,
    r = P.archR,
    y0 = P.ride,
    s = new THREE.Shape();
  const wzR = -P.wzR,
    wzF = P.wzF;
  s.moveTo(-L2, y0 + 0.09);
  // rear wheel arch (P.wzR < 0 is the "no rear arch" sentinel used by truck cabs)
  if (P.wzR > -L2 + r) {
    s.lineTo(wzR - r, y0);
    s.absarc(wzR, y0, r, Math.PI, 0, true);
  } else s.lineTo(-L2 + 0.05, y0);
  // front wheel arch
  if (wzF < L2 - r) {
    s.lineTo(wzF - r, y0);
    s.absarc(wzF, y0, r, Math.PI, 0, true);
  } else s.lineTo(L2 - 0.05, y0);
  s.lineTo(L2 - 0.14, y0);
  // front bumper roll-up
  s.quadraticCurveTo(L2 - 0.01, y0 + 0.01, L2, (y0 + P.nose) * 0.55);
  // nose crown
  s.quadraticCurveTo(L2 + 0.015, P.nose - 0.02, L2 - 0.09, P.nose);
  // hood — gentle rise with a soft cowl transition into the beltline
  s.quadraticCurveTo(
    L2 - P.hood * 0.42,
    P.nose + (P.belt - P.nose) * 0.6,
    L2 - P.hood,
    P.belt
  );
  // beltline with a hint of tension
  s.quadraticCurveTo(0, P.belt + 0.025, -L2 + P.trunk, P.belt);
  // decklid → tail
  s.quadraticCurveTo(-L2 + P.trunk * 0.35, P.belt + 0.005, -L2 + 0.05, P.tail);
  // rear fascia roll-down
  s.quadraticCurveTo(-L2 - 0.015, P.tail - 0.03, -L2, (P.tail + y0) * 0.55);
  s.closePath();
  return s;
}

/** Greenhouse (glass) profile with an arched roofline. */
export function glassShape(P: ShellParams) {
  const L2 = P.L / 2,
    s = new THREE.Shape();
  const rB = -L2 + P.trunk + 0.06, // rear glass base
    rT = -L2 + P.trunk + P.rakeR, // rear roof edge
    fT = L2 - P.hood - P.rakeF, // front roof edge
    fB = L2 - P.hood + 0.08; // windshield base
  s.moveTo(rB, P.belt - 0.02);
  s.quadraticCurveTo(rB + P.rakeR * 0.35, P.roof - (P.roof - P.belt) * 0.22, rT, P.roof);
  s.quadraticCurveTo((rT + fT) / 2, P.roof + 0.05, fT, P.roof);
  s.quadraticCurveTo(fT + P.rakeF * 0.55, P.belt + (P.roof - P.belt) * 0.32, fB, P.belt - 0.02);
  s.closePath();
  return s;
}

/** Painted roof cap that rides on top of the glass shell. */
export function roofShape(P: ShellParams) {
  const L2 = P.L / 2,
    s = new THREE.Shape();
  const rT = -L2 + P.trunk + P.rakeR - 0.05,
    fT = L2 - P.hood - P.rakeF + 0.05;
  s.moveTo(rT - 0.06, P.roof - 0.035);
  s.quadraticCurveTo(rT + 0.01, P.roof + 0.035, rT + 0.12, P.roof + 0.045);
  s.lineTo(fT - 0.12, P.roof + 0.045);
  s.quadraticCurveTo(fT - 0.01, P.roof + 0.035, fT + 0.06, P.roof - 0.035);
  s.closePath();
  return s;
}

export function shellExtrude(
  shape: THREE.Shape,
  W: number,
  bt: number,
  bs: number,
  seg = 3,
  curveSegments = 16
) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: W - 2 * bt,
    bevelEnabled: true,
    bevelThickness: bt,
    bevelSize: bs,
    bevelSegments: seg,
    curveSegments,
  });
  g.rotateY(-Math.PI / 2);
  g.translate((W - 2 * bt) / 2, 0, 0);
  return g;
}

function smoothed(g: THREE.BufferGeometry) {
  const m = mergeVertices(g, 1e-4);
  m.computeVertexNormals();
  g.dispose();
  return m;
}

export function carShellGeos(P: ShellParams, hi = true) {
  const cs = hi ? 18 : 8,
    bseg = hi ? 4 : 2;
  const hull = shellExtrude(hullShape(P), P.W, 0.085, 0.065, bseg, cs);
  const glass = shellExtrude(glassShape(P), P.W - 0.18, 0.055, 0.045, bseg, cs);
  const roof = shellExtrude(roofShape(P), P.W - 0.34, 0.05, 0.035, 2, cs);
  return {
    hull: hi ? smoothed(hull) : hull,
    glass: hi ? smoothed(glass) : glass,
    roof: hi ? smoothed(roof) : roof,
  };
}

/* ---------------- surface detail ----------------
   Everything below rides on the shell built above rather than replacing any of
   it, and each builder returns one merged geometry so a whole class of detail
   costs a single draw call per car (and the car draws three times a frame:
   main view, mirror, road reflection). */

/** How far the extruded skin stands outside the profile in `hullShape`.
 *  ExtrudeGeometry offsets the full-depth contour outward by `bevelSize`, so
 *  the hood at the cowl sits at `belt + HULL_SKIN`, not at `belt`, and detail
 *  placed on the raw profile height would sink into the bodywork. Measured
 *  against the built geometry, not assumed. The flanks are the exception:
 *  they land on |x| = W/2 exactly. */
export const HULL_SKIN = 0.065;

/** Height of the underside of the bodywork at longitudinal position z —
 *  the sill, except where a wheel arch is cut into it. Detail placed on the
 *  flanks has to start above this or it floats in the open arch. */
export function sillY(P: ShellParams, z: number) {
  const r = P.archR;
  for (const wc of [P.wzF, -P.wzR]) {
    if (wc < -P.L / 2 + r && wc < 0) continue; // truck-cab sentinel: no rear arch
    const d = z - wc;
    if (Math.abs(d) < r) return P.ride + Math.sqrt(r * r - d * d);
  }
  return P.ride;
}

const strip = (w: number, h: number, d: number, x: number, y: number, z: number) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
};

/* A door shut line runs down the body between the wheel arches, never across
   one — so each is pushed clear of its arch when the cabin is long enough to
   reach it (the sedan's windscreen base sits right over the front wheel). */

/** Longitudinal z of the shut line between the front wing and the door. */
const doorFrontZ = (P: ShellParams) =>
  Math.min(P.L / 2 - P.hood + 0.05, P.wzF - P.archR - 0.06);
/** Longitudinal z of the shut line behind the door. */
const doorRearZ = (P: ShellParams) =>
  Math.max(-P.L / 2 + P.trunk - 0.04, -P.wzR + P.archR + 0.06);

/** Panel gaps: door shut lines on both flanks plus the cowl and decklid
 *  seams. Thin dark inset strips — at any real viewing distance a shut line
 *  is a shadow, not a groove, and a strip reads the same for far less. */
export function panelLineGeo(P: ShellParams): THREE.BufferGeometry {
  const L2 = P.L / 2, sx = P.W / 2 - 0.001, parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    for (const z of [doorFrontZ(P), doorRearZ(P)]) {
      const yLo = sillY(P, z) + 0.03, yHi = P.belt + HULL_SKIN - 0.02;
      if (yHi - yLo < 0.06) continue;
      parts.push(strip(0.006, yHi - yLo, 0.014, s * sx, (yLo + yHi) / 2, z));
    }
    // crease running the length of the door, just above the rocker
    const zc = (doorFrontZ(P) + doorRearZ(P)) / 2;
    const len = doorFrontZ(P) - doorRearZ(P) - 0.08;
    if (len > 0.2) parts.push(strip(0.006, 0.014, len, s * sx, P.ride + 0.08, zc));
  }
  // cowl and decklid seams: the beltline passes exactly through these two
  // profile points, so a flat strip sits on the skin without floating
  const tw = Math.max(P.W - 0.24, 0.4);
  const ty = P.belt + HULL_SKIN + 0.001;
  parts.push(strip(tw, 0.006, 0.014, 0, ty, L2 - P.hood));
  parts.push(strip(tw, 0.006, 0.014, 0, ty, -L2 + P.trunk));
  return mergeGeometries(parts, false)!;
}

/** Door pulls and the fuel filler — small, but their absence is what makes a
 *  render read as a toy. Returned in two pieces so the recess can go matte
 *  dark under a chromed handle. */
export function doorFurnitureGeos(P: ShellParams) {
  const sx = P.W / 2, hy = P.belt + HULL_SKIN - 0.11;
  const hz = doorFrontZ(P) - 0.3;
  const handles: THREE.BufferGeometry[] = [];
  const recess: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const h = roundedBoxGeo(0.026, 0.036, 0.145, 0.012, 1);
    h.translate(s * (sx + 0.011), hy, hz);
    handles.push(h);
    recess.push(strip(0.008, 0.05, 0.17, s * (sx + 0.001), hy - 0.004, hz));
    // filler flap on the rear quarter, on the driver's side only, lifted to
    // whatever height clears the rear arch under it
    if (s < 0) {
      const fz = doorRearZ(P) - 0.17;
      const f = new THREE.CylinderGeometry(0.075, 0.075, 0.008, 14);
      f.rotateZ(Math.PI / 2);
      f.translate(s * (sx + 0.001), Math.max(hy - 0.06, sillY(P, fz) + 0.1), fz);
      recess.push(f);
    }
  }
  return {
    handles: mergeGeometries(handles, false)!,
    recess: mergeGeometries(recess, false)!,
  };
}

/** Grille, sitting on the front bumper trim — which stands proud of the hull
 *  skin, out at L2 + 0.19 — rather than on the hull itself. Two pieces: a dark
 *  recessed backing and the bright slat edges that catch oncoming headlights.
 *
 *  The bumper is a rounded box with a 0.1 corner radius, so its face is only
 *  flat for a narrow band either side of its centre; the grille is centred on
 *  that band and kept short, or its top edge would stand off in mid air. Width
 *  clears the headlight boxes on every shell in carspecs. */
export function grilleGeos(P: ShellParams) {
  const L2 = P.L / 2, gy = P.nose * 0.72, gw = P.W * 0.34, gh = 0.09;
  const back: THREE.BufferGeometry[] = [strip(gw, gh, 0.03, 0, gy, L2 + 0.175)];
  const slats: THREE.BufferGeometry[] = [];
  for (let i = -1; i <= 1; i++)
    slats.push(strip(gw, 0.011, 0.022, 0, gy + i * gh * 0.34, L2 + 0.198));
  // vertical fins break the opening up the way a real egg-crate does
  for (let i = -3; i <= 3; i++)
    slats.push(strip(0.01, gh * 0.86, 0.018, (i / 3) * gw * 0.42, gy, L2 + 0.194));
  return {
    back: mergeGeometries(back, false)!,
    slats: mergeGeometries(slats, false)!,
  };
}

/** Vented, drilled brake disc with its hub hat — visible through open spokes,
 *  which is where a wheel stops looking like a black donut. */
export function brakeDiscGeo(wheelR: number): THREE.BufferGeometry {
  const R = wheelR * 0.5, parts: THREE.BufferGeometry[] = [];
  const face = new THREE.CylinderGeometry(R, R, 0.032, 22);
  face.rotateZ(Math.PI / 2);
  parts.push(face);
  const hat = new THREE.CylinderGeometry(R * 0.42, R * 0.42, 0.08, 16);
  hat.rotateZ(Math.PI / 2);
  parts.push(hat);
  // drilled holes read as raised pips at this size, but the broken specular
  // ring is the cue that matters and it survives the approximation
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const h = new THREE.CylinderGeometry(R * 0.055, R * 0.055, 0.036, 6);
    h.rotateZ(Math.PI / 2);
    h.translate(0, Math.cos(a) * R * 0.74, Math.sin(a) * R * 0.74);
    parts.push(h);
  }
  return mergeGeometries(parts, false)!;
}

/* ---------------- wheels ---------------- */

/* Tyre surface maps, built once and shared by every wheel in the process.

   The tyre is one lathed surface (see makeWheel), so its UV is (u = around the
   circumference, v = along the profile from bead to bead) and one canvas can
   carry the whole carcass: tread blocks in the middle v band, sidewall ribs
   and a raised lettering band either side of it, flat rubber at the beads.
   Authored as a HEIGHT field and differenced into a normal map, because the
   thing that reads at chase distance is the shading break at a groove edge,
   not its colour — a black albedo map on black rubber is invisible.

   u tiles TYRE_REPEAT times around, so the four lateral notches per tile
   become 64 tread blocks per rib, which is roughly what a 245-section touring
   tyre carries. Canvas-generated: it costs nothing in the size budget. */
const TYRE_REPEAT = 16;
let tyreMapCache: { normal: THREE.Texture; rough: THREE.Texture } | null = null;

/** v bands of the lathe profile below. Keep in step with TYRE_PROFILE. */
const TREAD_V0 = 6 / 15, TREAD_V1 = 9 / 15;

function tyreMaps() {
  if (tyreMapCache) return tyreMapCache;
  const W = 256, H = 128;
  const h = new Float32Array(W * H);
  const at = (x: number, y: number) => h[(((y % H) + H) % H) * W + (((x % W) + W) % W)];
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      let e: number;
      if (v > TREAD_V0 && v < TREAD_V1) {
        /* tread: three circumferential ribs separated by two deep grooves,
           each rib broken by lateral notches that are staggered rib to rib so
           the pattern never lines up into one continuous slot */
        const t = (v - TREAD_V0) / (TREAD_V1 - TREAD_V0); // 0..1 across the tread
        const groove = Math.abs(t - 0.30) < 0.055 || Math.abs(t - 0.70) < 0.055;
        const rib = t < 0.30 ? 0 : t < 0.70 ? 1 : 2;
        const phase = (u + rib * 0.14) * 4; // 4 notches per tile per rib
        const notch = phase - Math.floor(phase) < 0.17;
        e = groove ? 0.12 : notch ? 0.42 : 1.0;
        // a shallow sipe across each block, so the crown is not a flat plate
        if (!groove && !notch && (phase * 2 - Math.floor(phase * 2)) < 0.09) e -= 0.22;
      } else {
        const d = v < 0.5 ? v : 1 - v; // distance from the nearer bead
        if (d < 0.12) e = 0.10; // bead seat — flat where it meets the flange
        else {
          /* sidewall: fine radial ribs, plus one raised band where the moulded
             lettering sits. Both are shallow — a sidewall is nearly smooth and
             only catches light at a grazing angle, which is exactly the angle a
             chase camera sees the front wheels at. */
          const ribs = 0.06 * Math.sin(u * Math.PI * 2 * 26);
          const band = Math.abs(d - 0.245) < 0.045 ? 0.16 : 0;
          e = 0.34 + ribs + band;
        }
      }
      h[y * W + x] = e;
    }
  }
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const nrm = ctx.createImageData(W, H);
  const S = 2.6; // normal strength
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * S;
      const dy = (at(x, y + 1) - at(x, y - 1)) * S;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * W + x) * 4;
      nrm.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      nrm.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      nrm.data[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      nrm.data[i + 3] = 255;
    }
  ctx.putImageData(nrm, 0, 0);
  const normal = new THREE.CanvasTexture(c);

  const c2 = document.createElement("canvas");
  c2.width = W;
  c2.height = H;
  const ctx2 = c2.getContext("2d")!;
  const rg = ctx2.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      /* Groove floors hold road film and read matte; the tread crown is
         scrubbed by the road and the sidewall is moulded rubber, both a shade
         glossier. Narrow range on purpose — a tyre is matte everywhere. */
      const v = (h[y * W + x] - 0.1) / 0.9;
      const g = (250 - v * 46) | 0;
      const i = (y * W + x) * 4;
      rg.data[i] = rg.data[i + 1] = rg.data[i + 2] = g;
      rg.data[i + 3] = 255;
    }
  ctx2.putImageData(rg, 0, 0);
  const rough = new THREE.CanvasTexture(c2);

  for (const t of [normal, rough]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(TYRE_REPEAT, 1);
    t.anisotropy = 16;
  }
  tyreMapCache = { normal, rough };
  return tyreMapCache;
}

/** Textures makeWheel() hands the tyre material. Exported so the rig that owns
 *  the material can add them to its shared-texture set and not dispose them —
 *  they are process-wide, like the paint and smudge maps. */
export function tyreTextures() {
  return tyreMaps();
}

/* The tyre section, bead to bead, as (radius, axial) pairs in units of the
   tyre radius R and the section half-width HW. Sixteen points, so v runs in
   fifteenths and the tread band is v 0.40..0.60 (TREAD_V0/V1 above).

   The shape is a modern low-profile touring tyre and not the old torus: the
   crown is FLAT for 80% of the section width — that flat is the contact patch
   and the thing a headlight catches as a horizontal bar — the widest point of
   the carcass sits low on the sidewall at 0.86 R, and the sidewall runs almost
   straight from there to the bead. The torus this replaced put its widest
   point at mid-height and bulged 3% PAST the tread cylinder that was supposed
   to be the contact face, so the flat was buried inside the carcass and the
   tyre read as a rubber ring. */
const TYRE_PROFILE: [number, number][] = [
  [0.700, -0.860], // bead, on the rim flange
  [0.722, -0.860],
  [0.740, -0.960],
  [0.860, -1.000], // widest point of the section, low on the sidewall
  [0.945, -0.900],
  [0.990, -0.832],
  [1.000, -0.800], // tread edge
  [1.000, -0.272],
  [1.000, 0.272],
  [1.000, 0.800], // tread edge
  [0.990, 0.832],
  [0.945, 0.900],
  [0.860, 1.000],
  [0.740, 0.960],
  [0.722, 0.860],
  [0.700, 0.860],
];

/** One wheel, spinning about its local x axis.
 *
 *  Every rigid part is baked into a single merged geometry with one group per
 *  material, so a wheel is 3 draws instead of the 12 meshes it used to be —
 *  the budget that buys the sidewall and the spoke faces below.
 *
 *  `side` is +1 for a wheel on the car's +x flank and -1 for the other, and it
 *  mirrors every x offset. The dish of an alloy faces OUT; before this
 *  parameter existed the same mesh was used on both flanks, so the left-hand
 *  wheels showed the game their inboard face.
 *
 *  (The old spoke placement rotated a group about x and then about z; with the
 *  default XYZ Euler order the z turn is applied first, so all the spokes
 *  collapsed onto the axle instead of fanning around the rim.) */
export function makeWheel(
  R: number,
  width: number,
  rimM: THREE.Material,
  rimDark: THREE.Material,
  tireM: THREE.Material,
  hi = true,
  sidewallM?: THREE.Material,
  side: 1 | -1 = 1
) {
  const rad = hi ? 30 : 18;
  const halfW = width / 2;
  /* Rim flange radius. 0.70 R puts a 0.34 m tyre on an 18.7 inch rim with a
     ~41% aspect sidewall, which is what an S90 wears; the 0.62 this replaces
     was a 16.6 inch rim inside the same tyre, i.e. a 52% balloon sidewall and
     a rim face that stopped well short of where the eye expects the metal to
     start. Everything on the rim is derived from it. */
  const flangeR = R * 0.70;
  const rimHalf = halfW * 0.86;

  const tire: THREE.BufferGeometry[] = [];
  const bright: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];

  /* ---- carcass: one lathed surface, bead to bead ---- */
  {
    const pts = TYRE_PROFILE.map(([r, a]) => new THREE.Vector2(r * R, a * halfW));
    const g = new THREE.LatheGeometry(pts, rad);
    // lathe spins about +y; -90 deg about z sends +y to +x, so the profile's
    // axial direction becomes the axle and its +side stays on +x
    g.rotateZ(-Math.PI / 2);
    tire.push(g);
  }

  /* ---- rim ---- */
  // barrel: the dark well between the flanges, so nothing sees daylight
  // through the spoke gaps even before the brake disc is behind them
  const barrel = new THREE.CylinderGeometry(flangeR * 0.93, flangeR * 0.93, rimHalf * 1.86, rad, 1, true);
  barrel.rotateZ(Math.PI / 2);
  dark.push(barrel);
  // a solid back wall, well inboard of the brake disc, so a low chase angle
  // through the spokes finds metal rather than the tarmac
  const backing = new THREE.CircleGeometry(flangeR * 0.94, rad);
  backing.rotateY(-Math.PI / 2);
  backing.translate(-side * rimHalf * 0.92, 0, 0);
  dark.push(backing);
  // the two flanges — the polished lip the tyre bead sits against
  for (const s of [-1, 1]) {
    const lip = new THREE.TorusGeometry(flangeR, R * 0.026, 6, rad);
    lip.rotateY(Math.PI / 2);
    lip.translate(s * rimHalf, 0, 0);
    bright.push(lip);
  }
  /* The outboard rim FACE: a wide flat annulus between the flange and the
     spoke roots. This is the band that reads as "the wheel" from three
     quarters on, and the old wheel had nothing here at all — the spokes
     stopped at 0.62 R and open air ran from there to the tyre. */
  {
    const face = new THREE.RingGeometry(flangeR * 0.80, flangeR * 0.985, rad, 1);
    face.rotateY(-Math.PI / 2);
    face.translate(side * rimHalf * 0.66, 0, 0);
    bright.push(face);
    // and its inner wall, so the face has thickness rather than being a decal
    const wall = new THREE.CylinderGeometry(flangeR * 0.80, flangeR * 0.80, rimHalf * 0.68, rad, 1, true);
    wall.rotateZ(Math.PI / 2);
    wall.translate(side * rimHalf * 0.32, 0, 0);
    dark.push(wall);
  }

  /* ---- spokes ----
     Ten, not seven. They are also DEEP: each blade is a prism that runs from
     the dish plane out to the rim face, so a spoke throws a shadow edge and
     the gap between two of them is a hole with sides. The old blades were
     flat bars lying in the wheel plane at half radius, which is why the rim
     read as a smooth dished disc with no face detail at chase distance. */
  const spokes = hi ? 10 : 6;
  const hubR = R * 0.17;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const len = flangeR * 0.86 - hubR;
    const blade = new THREE.BoxGeometry(rimHalf * 0.62, len, R * 0.115, 1, 3, 1);
    // taper: wide at the hub, narrow at the rim, and thinner in x as it goes
    // out, which is the section every cast alloy spoke has
    const pa = blade.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < pa.count; k++) {
      const t = (pa.getY(k) + len / 2) / len; // 0 at hub, 1 at rim
      pa.setZ(k, pa.getZ(k) * (1 - 0.42 * t));
      pa.setX(k, pa.getX(k) * (1 - 0.30 * t));
    }
    pa.needsUpdate = true;
    blade.computeVertexNormals();
    blade.translate(0, hubR + len / 2, 0);
    blade.rotateX(a);
    blade.translate(side * rimHalf * 0.40, 0, 0);
    bright.push(blade);
  }

  /* ---- hub ---- */
  const cap = new THREE.CylinderGeometry(hubR * 0.98, hubR * 1.1, rimHalf * 1.5, 16);
  cap.rotateZ(Math.PI / 2);
  cap.translate(side * rimHalf * 0.24, 0, 0);
  bright.push(cap);
  const capFace = new THREE.CircleGeometry(hubR * 0.74, 16);
  capFace.rotateY(-Math.PI / 2);
  capFace.translate(side * (rimHalf * 0.99 + 0.002), 0, 0);
  dark.push(capFace);
  // five lug bolts on the dish, between the spoke roots
  for (let i = 0; i < 5; i++) {
    const a = ((i + 0.5) / 5) * Math.PI * 2;
    const b = new THREE.CylinderGeometry(R * 0.022, R * 0.022, rimHalf * 0.2, 6);
    b.rotateZ(Math.PI / 2);
    b.translate(side * rimHalf * 0.72, Math.cos(a) * hubR * 1.5, Math.sin(a) * hubR * 1.5);
    dark.push(b);
  }

  const groups: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const push = (parts: THREE.BufferGeometry[], m: THREE.Material) => {
    if (!parts.length) return;
    groups.push(mergeGeometries(parts, false)!);
    mats.push(m);
  };
  /* sidewallM used to carry two shoulder rings of greyer rubber. The carcass
     is one surface now and its shoulder is moulded into the profile, so the
     second material would be a second draw for nothing; the caller still
     passes it and it is deliberately ignored. */
  void sidewallM;
  push(tire, tireM);
  push(bright, rimM);
  push(dark, rimDark);

  const merged = mergeGeometries(groups, true)!;
  for (const g of groups) g.dispose();
  const mesh = new THREE.Mesh(merged, mats);
  mesh.castShadow = true;
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}
