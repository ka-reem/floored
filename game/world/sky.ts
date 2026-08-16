import * as THREE from "three";
import { rand, TAU } from "../util";
import { skyCanvas, skylineTexF } from "../textures";

/* Sky dome, stars, moon, distant skyline ring, mountains, and the two
   landmarks (broadcast tower west, ferris wheel east). Ported from v2. */

export interface Sky {
  skyMat: THREE.MeshBasicMaterial;
  skyCache: THREE.Texture[];
  starMat: THREE.PointsMaterial;
  moonMat: THREE.SpriteMaterial;
  skylineMat: THREE.MeshBasicMaterial;
  towersMat: THREE.PointsMaterial;
  beaconMat: THREE.SpriteMaterial;
  ferris: THREE.Group;
}

export function buildSky(scene: THREE.Scene, glowTex: THREE.Texture): Sky {
  const skyCache: THREE.Texture[] = [];
  for (let i = 0; i < 8; i++) skyCache.push(new THREE.CanvasTexture(skyCanvas(i / 7)));
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyCache[0], side: THREE.BackSide, fog: false, depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2800, 20, 12), skyMat);
  sky.renderOrder = -10;
  scene.add(sky);

  const starGeo = new THREE.BufferGeometry();
  {
    const p = new Float32Array(1100 * 3);
    for (let i = 0; i < 1100; i++) {
      const a = rand(0, TAU), e = rand(0.06, 1.4), r = 2500;
      p[i * 3] = Math.cos(a) * Math.cos(e) * r;
      p[i * 3 + 1] = Math.sin(e) * r;
      p[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(p, 3));
  }
  const starMat = new THREE.PointsMaterial({
    size: 2.2, sizeAttenuation: false, color: 0xcdd8ff, map: glowTex,
    transparent: true, opacity: 0.8, fog: false, depthWrite: false,
  });
  scene.add(new THREE.Points(starGeo, starMat));

  const moonMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xf2ecda, fog: false, depthWrite: false, transparent: true,
  });
  const moon = new THREE.Sprite(moonMat);
  moon.scale.set(150, 150, 1);
  moon.position.set(-900, 1250, -1700);
  scene.add(moon);

  const skylineTex = skylineTexF();
  skylineTex.repeat.set(9, 1);
  const skylineMat = new THREE.MeshBasicMaterial({
    map: skylineTex, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false,
  });
  const skyline = new THREE.Mesh(new THREE.CylinderGeometry(2340, 2340, 340, 48, 1, true), skylineMat);
  skyline.position.y = 150;
  skyline.renderOrder = -9;
  scene.add(skyline);

  // mountains
  {
    /* Silhouette only. Once the night dome is taken down to black the old
       value read as *lighter* than the sky behind it, which inverted the
       ridgeline — it has to sit under the horizon glow band, not above it. */
    const mMat = new THREE.MeshBasicMaterial({ color: 0x05070f, fog: false });
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU), r = rand(2000, 2500);
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(rand(300, 700), rand(220, 520), 5), mMat);
      m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      m.rotation.y = rand(0, TAU);
      scene.add(m);
    }
  }
  const towersMat = new THREE.PointsMaterial({
    size: 3, map: glowTex, color: 0xff5060, transparent: true,
    sizeAttenuation: false, depthWrite: false,
  });
  {
    const p = new Float32Array([1500, 560, -1700, -2100, 480, 900, 800, 430, 2200]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, towersMat));
  }

  /* broadcast tower */
  const beaconMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xff2830, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  {
    const orangeM = new THREE.MeshBasicMaterial({ color: 0xd85c2a, fog: false });
    const whiteM = new THREE.MeshBasicMaterial({ color: 0xe8e4da, fog: false });
    const towG = new THREE.Group();
    towG.position.set(-1420, 0, -260);
    const tiers: [number, number, number, THREE.Material][] = [
      [62, 36, 92, orangeM], [36, 19, 74, whiteM], [19, 9, 56, orangeM], [9, 4, 42, whiteM],
    ];
    let ty = 0;
    for (const [rb, rt, h, m] of tiers) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 8, 1, true), m);
      t.position.y = ty + h / 2;
      towG.add(t);
      ty += h;
    }
    for (const dy of [96, 178]) {
      const rr = dy < 120 ? 40 : 22;
      const deck = new THREE.Mesh(
        new THREE.CylinderGeometry(rr, rr, 9, 10),
        new THREE.MeshBasicMaterial({ color: 0xffd9a0, fog: false })
      );
      deck.position.y = dy;
      towG.add(deck);
    }
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2.4, 70, 6), whiteM);
    spire.position.y = ty + 35;
    towG.add(spire);
    const bea = new THREE.Sprite(beaconMat);
    bea.scale.set(26, 26, 1);
    bea.position.y = ty + 72;
    towG.add(bea);
    scene.add(towG);
  }

  /* ferris wheel */
  const fwG = new THREE.Group();
  fwG.position.set(880, 58, 540);
  fwG.rotation.y = -Math.PI / 2;
  const ferris = new THREE.Group();
  fwG.add(ferris);
  ferris.add(new THREE.Mesh(new THREE.TorusGeometry(55, 1.5, 8, 44),
    new THREE.MeshBasicMaterial({ color: 0x49d8ff, fog: false })));
  ferris.add(new THREE.Mesh(new THREE.TorusGeometry(30, 0.9, 8, 36),
    new THREE.MeshBasicMaterial({ color: 0xff5fae, fog: false })));
  for (let i = 0; i < 6; i++) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(1.1, 110, 1.1),
      new THREE.MeshBasicMaterial({ color: 0x9fb4cc, fog: false }));
    sp.rotation.z = (i / 6) * Math.PI;
    ferris.add(sp);
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(3, 3.6, 3),
      new THREE.MeshBasicMaterial({ color: i % 2 ? 0x49d8ff : 0xff5fae, fog: false }));
    cab.position.set(Math.cos(a) * 55, Math.sin(a) * 55, 0);
    ferris.add(cab);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 4, 10),
    new THREE.MeshBasicMaterial({ color: 0xdfe6f2, fog: false }));
  hub.rotation.x = Math.PI / 2;
  fwG.add(hub);
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(2.2, 118, 2.2),
      new THREE.MeshBasicMaterial({ color: 0x5a6478, fog: false }));
    leg.position.set(0, -29, s * 16);
    leg.rotation.x = s * 0.28;
    fwG.add(leg);
  }
  scene.add(fwG);

  return { skyMat, skyCache, starMat, moonMat, skylineMat, towersMat, beaconMat, ferris };
}
