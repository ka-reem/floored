import * as THREE from "three";
import {
  roadTex, hwyTexF, rampTexF, windowsTexF, storefrontTexF, vendingTexF, glowTexF,
  streakTexF, smokeTexF, envFaceCanvas, chevTexF, goreTexF, xingTexF,
} from "../textures";

/* Shared materials + textures. Planar-reflection sampling is injected into the
   road materials here (ported from v2, adapted to the linear HDR pipeline). */

export interface Mats {
  envMap: THREE.CubeTexture;
  glowTex: THREE.Texture;
  streakTex: THREE.Texture;
  smokeTex: THREE.Texture;
  chevTex: THREE.Texture;
  goreTex: THREE.Texture;
  xingTex: THREE.Texture;
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
  winMats: THREE.MeshStandardMaterial[];
  sfMat: THREE.MeshStandardMaterial;
  vendMat: THREE.MeshStandardMaterial;
  clutterMat: THREE.MeshStandardMaterial;
  refMats: THREE.MeshStandardMaterial[];
  addReflection(mat: THREE.MeshStandardMaterial, strength: number): void;
  setReflectionTexture(tex: THREE.Texture): void;
  setReflectionScreen(w: number, h: number): void;
  setWet(on: boolean, reflectionsOn: boolean): void;
}

export function buildMats(): Mats {
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

  const roadT = roadTex();
  roadT.repeat.set(1, 1);
  const frontT = roadTex();
  const hwyT = hwyTexF();
  const rampT = rampTexF();
  rampT.repeat.set(1, 2);

  const refMats: THREE.MeshStandardMaterial[] = [];
  let pendingRefTex: THREE.Texture | null = null;
  const screen = new THREE.Vector2(1, 1);

  function reflectionUniforms(mat: THREE.MeshStandardMaterial, strength: number) {
    mat.userData.refStr = strength;
    mat.userData.curStr = strength;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.tRef = { value: pendingRefTex };
      sh.uniforms.uRefStr = { value: mat.userData.curStr };
      sh.uniforms.uScreen = { value: screen };
      mat.userData.sh = sh;
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform sampler2D tRef; uniform float uRefStr; uniform vec2 uScreen;"
        )
        .replace(
          "#include <dithering_fragment>",
          "vec2 sUV=gl_FragCoord.xy/uScreen; sUV.x=1.0-sUV.x;" +
            "vec3 refC=texture2D(tRef,sUV).rgb;" +
            "float ndv=clamp(dot(normalize(vNormal),normalize(vViewPosition)),0.,1.);" +
            "float fr=uRefStr*pow(1.0-ndv,2.0);" +
            "gl_FragColor.rgb+=refC*fr;\n#include <dithering_fragment>"
        );
    };
    refMats.push(mat);
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

  const mats: Mats = {
    envMap, glowTex, streakTex, smokeTex, chevTex, goreTex, xingTex,
    road, front, hwy, ramp,
    ground: new THREE.MeshStandardMaterial({ color: 0x0b0c12, roughness: 0.92, metalness: 0.05 }),
    sidewalk: new THREE.MeshStandardMaterial({
      color: 0x191b23, roughness: 0.85, side: THREE.DoubleSide,
    }),
    conc: new THREE.MeshStandardMaterial({ color: 0x33363f, roughness: 0.8, metalness: 0.08 }),
    concDark: new THREE.MeshStandardMaterial({ color: 0x24262e, roughness: 0.85 }),
    barrier: new THREE.MeshStandardMaterial({
      color: 0x8d939f, roughness: 0.55, metalness: 0.35, envMap, envMapIntensity: 0.3,
    }),
    soundwall: new THREE.MeshStandardMaterial({
      color: 0x2c4438, roughness: 0.75, transparent: true, opacity: 0.85,
    }),
    pole: new THREE.MeshStandardMaterial({ color: 0x2b2e36, roughness: 0.7, metalness: 0.5 }),
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
      for (const m of refMats) if (m.userData.sh) m.userData.sh.uniforms.tRef.value = tex;
    },
    setReflectionScreen(w, h) {
      screen.set(w, h);
    },
    setWet(on, reflectionsOn) {
      const rough = on ? 0.13 : 0.4;
      road.roughness = rough;
      front.roughness = rough;
      hwy.roughness = rough - 0.02;
      ramp.roughness = rough;
      for (const m of refMats) {
        const str = reflectionsOn ? m.userData.refStr * (on ? 2.6 : 1) : 0;
        m.userData.curStr = str;
        if (m.userData.sh) m.userData.sh.uniforms.uRefStr.value = str;
      }
    },
  };
  return mats;
}
