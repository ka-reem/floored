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

/** One wheel, spinning about its local x axis.
 *
 *  Every rigid part is baked into a single merged geometry with one group per
 *  material, so a wheel is 3 draws instead of the 12 meshes it used to be —
 *  the budget that buys the sidewall and the spoke faces below.
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
  sidewallM?: THREE.Material
) {
  const seg = hi ? 14 : 8,
    rad = hi ? 30 : 18;
  const tubeR = R * 0.28,
    rimR = R * 0.62;
  const halfW = width / 2;

  const tire: THREE.BufferGeometry[] = [];
  const side: THREE.BufferGeometry[] = [];
  const bright: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];

  const t = new THREE.TorusGeometry(R - tubeR * 0.9, tubeR, seg, rad);
  t.rotateY(Math.PI / 2);
  tire.push(t);
  // squared-off tread band: a tyre's contact face is flat, and the flat is
  // what catches a headlight as a bright horizontal line
  const tread = new THREE.CylinderGeometry(R, R, width * 0.82, rad, 1, true);
  tread.rotateZ(Math.PI / 2);
  tire.push(tread);
  // sidewall shoulder rings — the raised lettering band, in a greyer rubber
  for (const s of [-1, 1]) {
    const sw = new THREE.TorusGeometry(R * 0.84, R * 0.035, 6, rad);
    sw.rotateY(Math.PI / 2);
    sw.translate(s * halfW * 0.72, 0, 0);
    side.push(sw);
  }

  const barrel = new THREE.CylinderGeometry(rimR, rimR, width * 0.8, rad, 1, true);
  barrel.rotateZ(Math.PI / 2);
  dark.push(barrel);
  for (const lx of [-width * 0.4, width * 0.4]) {
    const lip = new THREE.TorusGeometry(rimR, R * 0.05, 8, rad);
    lip.rotateY(Math.PI / 2);
    lip.translate(lx, 0, 0);
    bright.push(lip);
  }
  const cap = new THREE.CylinderGeometry(R * 0.17, R * 0.19, width * 0.92, 12);
  cap.rotateZ(Math.PI / 2);
  bright.push(cap);

  const spokes = hi ? 7 : 5;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    // a tapered blade lying in the wheel plane, angled slightly so the faces
    // catch light at different moments as the wheel turns
    const bar = new THREE.BoxGeometry(width * 0.2, rimR * 0.92, R * 0.13);
    bar.translate(0, rimR * 0.5, 0);
    bar.rotateZ(0.1);
    bar.rotateX(a);
    bar.translate(halfW * 0.2, 0, 0);
    bright.push(bar);
  }

  const groups: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const push = (parts: THREE.BufferGeometry[], m: THREE.Material) => {
    if (!parts.length) return;
    groups.push(mergeGeometries(parts, false)!);
    mats.push(m);
  };
  if (sidewallM) {
    push(tire, tireM);
    push(side, sidewallM);
  } else push([...tire, ...side], tireM);
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
