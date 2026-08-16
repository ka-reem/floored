import * as THREE from "three";
import { carShellGeos, makeWheel, roundedBoxGeo } from "./carshape";
import { paintTexF, carbonTexF } from "./textures";
import { buildCockpit, COCKPIT_REF, type Cockpit } from "./cockpit";
import type { CarSpec } from "./carspecs";

/* Player car assembly: smoothed shell + parametric detailing (bumpers, trim,
   lamps, mirrors, spoiler, exhausts), physical clearcoat paint, wheels with
   steering pivots, headlight spots, and the RHD cockpit. */

export interface PlayerRig {
  spec: CarSpec;
  carGroup: THREE.Group;
  bodyG: THREE.Group;
  exteriorG: THREE.Group;
  cockpit: Cockpit;
  pivFL: THREE.Group;
  pivFR: THREE.Group;
  wheels: THREE.Group[];
  spotL: THREE.SpotLight;
  spotR: THREE.SpotLight;
  headMat: THREE.MeshStandardMaterial;
  tailMat: THREE.MeshStandardMaterial;
  sigMatL: THREE.MeshStandardMaterial;
  sigMatR: THREE.MeshStandardMaterial;
  hlGlowMat: THREE.SpriteMaterial;
  plateGlowMat: THREE.SpriteMaterial;
  halfW: number;
  halfL: number;
  dispose(scene: THREE.Scene): void;
}

export function buildPlayerCar(
  scene: THREE.Scene,
  spec: CarSpec,
  paintHex: number,
  envMap: THREE.CubeTexture,
  glowTex: THREE.Texture,
  mirrorTexture: THREE.Texture
): PlayerRig {
  const P = spec.shell;
  const L2 = P.L / 2;
  const carGroup = new THREE.Group();
  scene.add(carGroup);
  const bodyG = new THREE.Group();
  carGroup.add(bodyG);
  const exteriorG = new THREE.Group(), lampsG = new THREE.Group();
  bodyG.add(exteriorG);
  carGroup.add(lampsG);

  const paint = new THREE.MeshPhysicalMaterial({
    color: paintHex, map: paintTexF(), metalness: 0.86, roughness: 0.34,
    clearcoat: 1, clearcoatRoughness: 0.08, envMap, envMapIntensity: 1.45,
    side: THREE.DoubleSide,
  });
  const darkGlass = new THREE.MeshPhysicalMaterial({
    color: 0x0a0f1a, metalness: 0.9, roughness: 0.06, envMap, envMapIntensity: 1.5,
  });
  const carbonM = new THREE.MeshStandardMaterial({
    map: carbonTexF(), roughness: 0.45, metalness: 0.5, envMap, envMapIntensity: 0.7,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x121319, roughness: 0.5, metalness: 0.4 });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xb9c2d4, metalness: 1, roughness: 0.18, envMap, envMapIntensity: 1.4,
  });

  const box = (
    w: number, h: number, d: number, mat: THREE.Material,
    x: number, y: number, z: number, cast = true
  ) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (cast) m.castShadow = true;
    exteriorG.add(m);
    return m;
  };
  const rmesh = (g: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    exteriorG.add(m);
    return m;
  };

  /* shells */
  const shells = carShellGeos(P, true);
  rmesh(shells.hull, paint);
  rmesh(shells.glass, darkGlass);
  rmesh(shells.roof, paint);

  /* wheel-arch liners */
  const linerG = new THREE.CylinderGeometry(P.archR - 0.02, P.archR - 0.02, 0.3, 14, 1, true, 0, Math.PI);
  const linerM = new THREE.MeshStandardMaterial({
    color: 0x08090c, roughness: 1, side: THREE.DoubleSide,
  });
  const axX = P.W / 2 - P.wheelWidth / 2 - 0.07;
  for (const [x, z] of [
    [-axX, P.wzF], [axX, P.wzF], [-axX, -P.wzR], [axX, -P.wzR],
  ]) {
    const li = new THREE.Mesh(linerG, linerM);
    li.position.set(x, P.ride, z);
    // rotation.z alone puts the half-cylinder axis on the axle with the dome
    // upward; adding rotation.y here flips the radius sideways so the shell
    // bulges out through the fenders
    li.rotation.z = Math.PI / 2;
    exteriorG.add(li);
  }

  /* underbody + bumpers + trim */
  rmesh(roundedBoxGeo(P.W + 0.03, 0.16, P.L + 0.05, 0.07), trimMat, 0, P.ride * 0.75, 0);
  rmesh(roundedBoxGeo(P.W - 0.05, 0.24, 0.5, 0.1), trimMat, 0, P.nose * 0.72, L2 - 0.06);
  rmesh(roundedBoxGeo(P.W - 0.06, 0.26, 0.44, 0.1), trimMat, 0, P.tail * 0.72, -L2 + 0.04);
  box(P.W * 0.68, 0.1, 0.02, chromeMat, 0, P.nose + 0.08, L2 + 0.06);
  box(0.44, 0.14, 0.02, new THREE.MeshBasicMaterial({ color: 0xf2f4f8 }), 0, P.nose * 0.68, L2 + 0.2); // plate F
  box(0.44, 0.14, 0.02, new THREE.MeshBasicMaterial({ color: 0xf2f4f8 }), 0, P.tail * 0.8, -L2 - 0.2); // plate R
  box(P.W * 0.85, 0.05, 0.4, carbonM, 0, P.ride * 0.72, L2 - 0.24);
  box(P.W * 0.82, 0.09, 0.34, carbonM, 0, P.ride * 0.78, -L2 + 0.22);
  for (const s of [-1, 1]) box(0.022, 0.1, P.L * 0.78, carbonM, s * (P.W / 2 - 0.005), P.ride * 0.88, 0);
  // grille
  box(P.W * 0.4, 0.09, 0.02, trimMat, 0, P.nose * 0.82, L2 + 0.055);
  // exhausts
  const exXs = spec.id === "tanuki" ? [0.3] : [-(P.W / 2 - 0.32), P.W / 2 - 0.32];
  for (const exX of exXs) {
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.16, 12), chromeMat);
    ex.rotation.x = Math.PI / 2;
    ex.position.set(exX, P.ride * 0.62, -L2 - 0.03);
    exteriorG.add(ex);
  }
  // mirrors
  for (const s of [-1, 1]) {
    const mir = rmesh(
      roundedBoxGeo(0.3, 0.13, 0.1, 0.045), paint,
      s * (P.W / 2 + 0.09), P.belt + 0.28, L2 - P.hood - 0.3
    );
    mir.rotation.y = s * 0.25;
    box(0.24, 0.1, 0.02, darkGlass, s * (P.W / 2 + 0.09), P.belt + 0.28, L2 - P.hood - 0.345, false);
    box(0.05, 0.05, 0.15, trimMat, s * (P.W / 2 - 0.06), P.belt + 0.22, L2 - P.hood - 0.3);
  }
  // hood bulge
  if (P.hoodBulge) {
    const hb = rmesh(roundedBoxGeo(P.W * 0.36, 0.07, P.hood * 0.62, 0.035), paint,
      0, P.belt - (P.belt - P.nose) * 0.32 + 0.015, L2 - P.hood * 0.52);
    hb.rotation.x = -Math.atan2(P.belt - P.nose, P.hood) * 0.85;
  }
  // spoiler
  if (P.spoiler === "wing") {
    for (const s of [-1, 1]) box(0.06, 0.16, 0.2, trimMat, s * (P.W / 2 - 0.3), P.belt + 0.1, -L2 + 0.3);
    const wing = rmesh(roundedBoxGeo(P.W - 0.42, 0.05, 0.34, 0.02), paint, 0, P.belt + 0.22, -L2 + 0.28);
    wing.rotation.x = 0.12;
    for (const s of [-1, 1]) box(0.03, 0.1, 0.3, paint, s * (P.W / 2 - 0.22), P.belt + 0.18, -L2 + 0.28);
  } else if (P.spoiler === "lip") {
    rmesh(roundedBoxGeo(P.W - 0.5, 0.045, 0.18, 0.02), paint, 0, P.belt + 0.04, -L2 + P.trunk * 0.3);
  } else if (P.spoiler === "roofcap") {
    const rc = rmesh(roundedBoxGeo(P.W - 0.5, 0.05, 0.26, 0.02), paint,
      0, P.roof + 0.05, -L2 + P.trunk + P.rakeR * 0.4);
    rc.rotation.x = -0.18;
  }
  // shark fin
  const fin = rmesh(roundedBoxGeo(0.05, 0.1, 0.27, 0.02, 1), paint,
    0, P.roof + 0.08, -L2 + P.trunk + P.rakeR + 0.25);
  fin.rotation.x = 0.06;

  /* brakes */
  const discM = new THREE.MeshStandardMaterial({ color: 0x3a3d45, metalness: 0.8, roughness: 0.5 });
  const calM = new THREE.MeshStandardMaterial({ color: 0xc2242e, roughness: 0.4, metalness: 0.4 });
  for (const [x, z] of [
    [-axX, P.wzF], [axX, P.wzF], [-axX, -P.wzR], [axX, -P.wzR],
  ]) {
    const d = new THREE.Mesh(
      new THREE.CylinderGeometry(P.wheelR * 0.48, P.wheelR * 0.48, 0.045, 14), discM);
    d.position.set(x * 0.985, P.ride, z);
    d.rotation.z = Math.PI / 2;
    exteriorG.add(d);
    box(0.05, 0.085, 0.11, calM, x * 0.985, P.ride + 0.02, z + 0.12, false);
  }

  /* wheels */
  const tireM = new THREE.MeshStandardMaterial({ color: 0x0b0b0f, roughness: 0.9 });
  const rimM = new THREE.MeshStandardMaterial({
    color: 0x9aa2b4, metalness: 0.95, roughness: 0.25, envMap,
  });
  const rimDark = new THREE.MeshStandardMaterial({
    color: 0x23262e, metalness: 0.9, roughness: 0.35, envMap,
  });
  const mk = () => makeWheel(P.wheelR, P.wheelWidth, rimM, rimDark, tireM, true);
  const wFL = mk(), wFR = mk(), wRL = mk(), wRR = mk();
  const pivFL = new THREE.Group(), pivFR = new THREE.Group();
  pivFL.position.set(-axX, P.wheelR, P.wzF);
  pivFR.position.set(axX, P.wheelR, P.wzF);
  pivFL.add(wFL);
  pivFR.add(wFR);
  wRL.position.set(-axX, P.wheelR, -P.wzR);
  wRR.position.set(axX, P.wheelR, -P.wzR);
  exteriorG.add(pivFL, pivFR, wRL, wRR);

  /* lamps */
  const headMat = new THREE.MeshStandardMaterial({ color: 0x555555, emissive: 0xf6f9ff, emissiveIntensity: 2.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x2a0508, emissive: 0xff2233, emissiveIntensity: 1.7 });
  const sigMatL = new THREE.MeshStandardMaterial({ color: 0x2a1a06, emissive: 0xffa028, emissiveIntensity: 0 });
  const sigMatR = new THREE.MeshStandardMaterial({ color: 0x2a1a06, emissive: 0xffa028, emissiveIntensity: 0 });
  // lamps must sit proud of the bumper trim, which reaches L2+0.19 front / -L2-0.18 rear
  const hlY = P.nose * 0.9, hlX = P.W * 0.31;
  box(P.W * 0.25, 0.09, 0.06, headMat, -hlX, hlY, L2 + 0.17, false);
  box(P.W * 0.25, 0.09, 0.06, headMat, hlX, hlY, L2 + 0.17, false);
  box(P.W * 0.22, 0.02, 0.05, headMat, -hlX, hlY - 0.065, L2 + 0.175, false);
  box(P.W * 0.22, 0.02, 0.05, headMat, hlX, hlY - 0.065, L2 + 0.175, false);
  const tlY = P.tail * 0.88;
  box(P.W * 0.23, 0.1, 0.06, tailMat, -hlX, tlY, -L2 - 0.16, false);
  box(P.W * 0.23, 0.1, 0.06, tailMat, hlX, tlY, -L2 - 0.16, false);
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x220305, emissive: 0xff2030, emissiveIntensity: 1.4 });
  box(P.W * 0.78, 0.045, 0.03, ledMat, 0, tlY + 0.06, -L2 - 0.185, false);
  // car-left is +x in this frame (facing +z, right side at -x)
  box(0.12, 0.08, 0.06, sigMatL, P.W / 2 - 0.08, hlY - 0.01, L2 + 0.16, false);
  box(0.12, 0.08, 0.06, sigMatL, P.W / 2 - 0.06, tlY - 0.02, -L2 - 0.15, false);
  box(0.12, 0.08, 0.06, sigMatR, -(P.W / 2 - 0.08), hlY - 0.01, L2 + 0.16, false);
  box(0.12, 0.08, 0.06, sigMatR, -(P.W / 2 - 0.06), tlY - 0.02, -L2 - 0.15, false);
  const mkrM = new THREE.MeshStandardMaterial({ color: 0x241204, emissive: 0xffa028, emissiveIntensity: 1.1 });
  const mkrR = new THREE.MeshStandardMaterial({ color: 0x240406, emissive: 0xff2233, emissiveIntensity: 1.0 });
  for (const s of [-1, 1]) {
    box(0.05, 0.03, 0.02, mkrM, s * (P.W / 2 - 0.01), P.nose, P.wzF + 0.5, false);
    box(0.05, 0.03, 0.02, mkrR, s * (P.W / 2 - 0.01), P.tail, -P.wzR - 0.55, false);
  }
  const hlGlowMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xcfe0ff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
  });
  for (const s of [-1, 1]) {
    const sp = new THREE.Sprite(hlGlowMat);
    sp.scale.set(0.85, 0.85, 1);
    sp.position.set(s * hlX, hlY, L2 + 0.24);
    exteriorG.add(sp);
  }
  const plateGlowMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xffe9c0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
  });
  {
    const pg = new THREE.Sprite(plateGlowMat);
    pg.scale.set(0.5, 0.28, 1);
    pg.position.set(0, P.tail * 0.8, -L2 - 0.24);
    exteriorG.add(pg);
  }
  const spotL = new THREE.SpotLight(0xdfe9ff, 0, 90, 0.46, 0.42, 1.4);
  const spotR = new THREE.SpotLight(0xdfe9ff, 0, 90, 0.46, 0.42, 1.4);
  spotL.position.set(-hlX, P.nose, L2 - 0.05);
  spotR.position.set(hlX, P.nose, L2 - 0.05);
  const tgtL = new THREE.Object3D(), tgtR = new THREE.Object3D();
  tgtL.position.set(-1.4, -0.4, 26);
  tgtR.position.set(1.4, -0.4, 26);
  lampsG.add(spotL, tgtL, spotR, tgtR);
  spotL.target = tgtL;
  spotR.target = tgtR;

  /* cockpit */
  const cockpit = buildCockpit(spec.cockpitAccent, mirrorTexture, spec.id);
  cockpit.group.position.y = P.belt - COCKPIT_REF.belt;
  cockpit.group.scale.x = P.W / COCKPIT_REF.W;
  bodyG.add(cockpit.group);

  return {
    spec, carGroup, bodyG, exteriorG, cockpit, pivFL, pivFR,
    wheels: [wFL, wFR, wRL, wRR],
    spotL, spotR, headMat, tailMat, sigMatL, sigMatR, hlGlowMat, plateGlowMat,
    halfW: P.W / 2 + 0.02,
    halfL: L2 + 0.02,
    dispose(sceneRef: THREE.Scene) {
      sceneRef.remove(carGroup);
      // shared resources that must outlive this rig
      const shared = new Set<THREE.Texture>([envMap as any, glowTex, mirrorTexture]);
      const texSlots = ["map", "emissiveMap", "roughnessMap", "metalnessMap", "normalMap", "alphaMap"];
      carGroup.traverse((o: any) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            for (const slot of texSlots) {
              const t = m[slot];
              if (t && t.isTexture && !shared.has(t)) t.dispose();
            }
            if (m.envMap && !shared.has(m.envMap)) m.envMap = null;
            m.dispose();
          }
        }
      });
    },
  };
}
