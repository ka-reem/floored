import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
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

/* ---------------- wheels ---------------- */

export function makeWheel(
  R: number,
  width: number,
  rimM: THREE.Material,
  rimDark: THREE.Material,
  tireM: THREE.Material,
  hi = true
) {
  const g = new THREE.Group();
  const tubeR = R * 0.28;
  const seg = hi ? 14 : 8,
    rad = hi ? 30 : 18;
  const tire = new THREE.Mesh(new THREE.TorusGeometry(R - tubeR * 0.9, tubeR, seg, rad), tireM);
  tire.rotation.y = Math.PI / 2;
  tire.castShadow = true;
  g.add(tire);
  const rimR = R * 0.62;
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(rimR, rimR, width * 0.8, rad, 1, true),
    rimDark
  );
  barrel.rotation.z = Math.PI / 2;
  g.add(barrel);
  for (const lx of [-width * 0.4, width * 0.4]) {
    const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR, R * 0.05, 8, rad), rimM);
    lip.rotation.y = Math.PI / 2;
    lip.position.x = lx;
    g.add(lip);
  }
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.17, R * 0.17, width * 0.9, 10),
    rimM
  );
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  const spokes = hi ? 7 : 5;
  for (let i = 0; i < spokes; i++) {
    const hold = new THREE.Group();
    hold.rotation.x = (i / spokes) * Math.PI * 2;
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.16, rimR * 0.95, R * 0.1),
      rimM
    );
    bar.position.y = rimR * 0.52;
    hold.add(bar);
    hold.rotation.z = Math.PI / 2;
    g.add(hold);
  }
  return g;
}
