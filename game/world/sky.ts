import * as THREE from "three";
import { rand, TAU } from "../util";
import { skyCanvas, skylineTexF } from "../textures";
import { worldTierCaps } from "../settings";

/* Sky dome, stars, moon, distant skyline ring, mountains, and the two
   landmarks (broadcast tower west, ferris wheel east). Ported from v2.
   Lane A adds the layered point-cloud city (buildCityGlow) and the airport
   control tower landmark. */

/** Master kill-switch for the layered distant-city point clouds (3 draw
    calls, ~9k points). The live per-device depth of the stack comes from
    TierCaps.cityRings (settings.worldTierCaps()): mobile-base keeps the two
    nearest rings, everything else gets all three. */
export const FX_CITY_LAYERS = true;

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
  /* The distant city, as three staggered rings of window-lights between the
     mountains and the skyline ring. The load-bearing trick is CLUSTERING:
     random points read as noise, but points stacked into implied vertical
     columns — floors of a building — read as a city even at two pixels per
     window. Each ring mixes sodium-orange and cool-white per window, the way
     a real skyline mixes streetlight bounce with office fluorescents.
     Downtown density comes from seeding more towers into two narrow arc
     bands, so the horizon has composition instead of uniform speckle. */
  const cityRings = Math.max(0, Math.min(3, worldTierCaps().cityRings ?? 3));
  if (FX_CITY_LAYERS && cityRings > 0) {
    const layers: [number, number, number, number, number][] = [
      // r0, r1, towers, point size, opacity
      [1350, 1650, 60, 2.4, 0.85],
      [1750, 2050, 95, 2.0, 0.7],
      [2130, 2380, 130, 1.7, 0.55],
      /* tiers thin the stack from the BACK: the near ring carries the
         composition (it is the one with readable towers), the far rings only
         add depth haze — so mobile-base keeps [0..cityRings). */
    ].slice(0, cityRings) as [number, number, number, number, number][];
    // two "downtown" arcs shared by every ring so the density lines up in depth
    const downtown = [rand(0, TAU), rand(0, TAU)];
    for (const [r0, r1, nTow, size, op] of layers) {
      const pos: number[] = [], col: number[] = [];
      const C = new THREE.Color();
      for (let t = 0; t < nTow; t++) {
        let a = rand(0, TAU);
        // pull roughly half the towers into the downtown arcs
        if (t % 2 === 0) a = downtown[t % downtown.length] + rand(-0.5, 0.5);
        const r = rand(r0, r1);
        const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
        const near = downtown.some((d) => Math.abs(Math.atan2(Math.sin(a - d), Math.cos(a - d))) < 0.55);
        const hgt = near ? rand(60, 210) : rand(24, 90);
        const floors = Math.max(3, Math.floor(hgt / 7));
        const wide = rand(4, 14);
        for (let f = 0; f < floors; f++) {
          // 1-3 lit windows per floor, jittered inside the tower footprint
          const lit = 1 + (Math.random() < 0.4 ? 1 : 0) + (Math.random() < 0.15 ? 1 : 0);
          for (let w = 0; w < lit; w++) {
            pos.push(cx + rand(-wide, wide), 4 + f * 7 + rand(-1.5, 1.5), cz + rand(-wide, wide));
            const warm = Math.random() < 0.55;
            const b = rand(0.5, 1);
            C.set(warm ? 0xff9a44 : 0xbfd6ff).multiplyScalar(b);
            col.push(C.r, C.g, C.b);
          }
        }
        // a red obstruction beacon on the tall ones
        if (hgt > 150) {
          pos.push(cx, hgt + 6, cz);
          C.set(0xff4048);
          col.push(C.r, C.g, C.b);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
      const m = new THREE.PointsMaterial({
        size, sizeAttenuation: false, vertexColors: true, map: glowTex,
        transparent: true, opacity: op, fog: false, depthWrite: false,
      });
      const pts = new THREE.Points(g, m);
      pts.renderOrder = -8; // over the skyline ring, under everything real
      scene.add(pts);
    }

    /* Airport control tower on the east horizon: flared cab on a slim shaft,
       green-white glazing, red beacon — unmistakable in silhouette. */
    {
      const tg = new THREE.Group();
      tg.position.set(1680, 0, 980);
      const shaftM = new THREE.MeshBasicMaterial({ color: 0x141a26, fog: false });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(7, 11, 118, 8), shaftM);
      shaft.position.y = 59;
      tg.add(shaft);
      const flare = new THREE.Mesh(new THREE.CylinderGeometry(16, 8, 14, 8), shaftM);
      flare.position.y = 125;
      tg.add(flare);
      const cab = new THREE.Mesh(
        new THREE.CylinderGeometry(14, 16, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x9fe8d8, fog: false })
      );
      cab.position.y = 137;
      tg.add(cab);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(2, 15, 7, 8), shaftM);
      cap.position.y = 145;
      tg.add(cap);
      const bea = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xff3038, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      bea.scale.set(18, 18, 1);
      bea.position.y = 152;
      tg.add(bea);
      scene.add(tg);
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
