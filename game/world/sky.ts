import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rand, TAU } from "../util";
import { skyCanvas, skylineTexF } from "../textures";
import { worldTierCaps } from "../settings";
import { buildAurora, FX_AURORA, type Aurora } from "./aurora";
import { buildNightClouds, FX_NIGHT_CLOUDS, type NightClouds } from "./nightclouds";

declare global {
  interface Window { __sky?: { mtnScale: number; mtnColor: number } }
}


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
  /** Everything painted "at infinity" — dome, stars, moon, skyline ring,
      mountains, city rings. The engine re-centres this on the car every frame
      (weather()): the lap is 4 km long but these rings sit only ~2.1–2.5 km
      from the origin, so left world-fixed the far end of the corridor ran
      *into* them — a wall of skyline across the road just before the loop
      splice, which then snapped it 4 km away. A backdrop at infinity is
      direction-only; gluing it to the viewer keeps it on the horizon at both
      ends of the lap and makes the splice's pure translation invisible.
      In-map landmarks (ferris wheel, broadcast tower, airport tower) stay
      world-fixed — they are scenery you drive past, not backdrop. */
  backdrop: THREE.Group;
  /** the abstract-city layer (glow domes + light-column slabs): the engine
      dims each material to userData.nightO × its day/fog factor */
  cityAbstractMats: THREE.Material[];
  /** procedural aurora curtains on the dome — engine.weather() ticks it */
  aurora?: Aurora;
  /** procedural lit-edge cloud deck over the aurora — ticked alongside it */
  clouds?: NightClouds;
}

export function buildSky(scene: THREE.Scene, glowTex: THREE.Texture): Sky {
  const backdrop = new THREE.Group();
  scene.add(backdrop);
  const cityAbstractMats: THREE.Material[] = [];
  const skyCache: THREE.Texture[] = [];
  for (let i = 0; i < 8; i++) skyCache.push(new THREE.CanvasTexture(skyCanvas(i / 7)));
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyCache[0], side: THREE.BackSide, fog: false, depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2800, 20, 12), skyMat);
  sky.renderOrder = -10;
  backdrop.add(sky);

  /* Aurora, painted onto the dome one renderOrder step above it. It joins the
     backdrop group for the same reason everything else here does — it is a
     direction, not a place, and must not be outrun by the lap. */
  let aurora: Aurora | undefined;
  let clouds: NightClouds | undefined;
  if (FX_AURORA) {
    aurora = buildAurora();
    backdrop.add(aurora.mesh);
    if (FX_NIGHT_CLOUDS) {
      clouds = buildNightClouds(aurora.roll.seed);
      clouds.tint(aurora.palLo, aurora.palHi);
      // keep the deck on the aurora's palette across rerolls
      aurora.onPalette = (lo, hi) => clouds!.tint(lo, hi);
      backdrop.add(clouds.mesh);
    }
    /* Live preview handle. The sky is the one thing here a player can't
       audition without a rebuild, so the whole control surface goes on the
       console: __aurora.next() to flick through rolls, .gain to dial
       brightness, .lock() to keep the one you like. */
    try {
      const w = window as unknown as { __aurora?: unknown; __clouds?: unknown };
      w.__aurora = aurora;
      w.__clouds = clouds;
    } catch {
      /* non-browser / locked-down global — the sky still renders */
    }
  }

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
  {
    const stars = new THREE.Points(starGeo, starMat);
    /* Behind the cloud deck (-9.8). Stars are transparent, so without an
       explicit order they would sort to 0 and draw on top of the clouds —
       a starfield shining straight through an overcast. */
    stars.renderOrder = -9.85;
    backdrop.add(stars);
  }

  const moonMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xf2ecda, fog: false, depthWrite: false, transparent: true,
  });
  const moon = new THREE.Sprite(moonMat);
  moon.scale.set(150, 150, 1);
  moon.position.set(-900, 1250, -1700);
  backdrop.add(moon);

  const skylineTex = skylineTexF();
  skylineTex.repeat.set(9, 1);
  const skylineMat = new THREE.MeshBasicMaterial({
    map: skylineTex, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false,
  });
  const skyline = new THREE.Mesh(new THREE.CylinderGeometry(2340, 2340, 340, 48, 1, true), skylineMat);
  skyline.position.y = 150;
  skyline.renderOrder = -9;
  backdrop.add(skyline);

  // mountains
  {
    /* Live, because a ridgeline can only be judged against the sky it sits in
       and that sky is now tunable too (window.__fog):
         window.__sky.mtnScale = 1     // the original, full-height peaks
         window.__sky.mtnColor = 0x05070f  // the original near-black
       Read once at build time — reload or re-enter to apply. */
    const sk = (typeof window !== "undefined"
      ? (window.__sky ??= { mtnScale: 0.5, mtnColor: 0x0b0d16 })
      : { mtnScale: 0.5, mtnColor: 0x0b0d16 });
    const mtnScale = sk.mtnScale, MTN_COLOR = sk.mtnColor;
    /* Silhouette only. Once the night dome is taken down to black the old
       value read as *lighter* than the sky behind it, which inverted the
       ridgeline — it has to sit under the horizon glow band, not above it. */
    /* HEIGHT. The cones used to run 220-520 m at 2.0-2.5 km, which puts the
       tallest ones well ABOVE the horizon glow they are supposed to sit under
       — from the dashcam a 520 m peak at 2 km subtends ~15 degrees and stands
       as a hard black pyramid in the middle of the sky. Reported as "the
       pyramid... it blocks the view". Halved, so the ridgeline reads as
       distant relief rather than as an object. `__sky.mtnScale` restores it.

       COLOUR. `fog: false` is deliberate — see below — but it means these did
       not follow when the night fog was lifted and warmed. They stayed at
       0x05070f while the haze behind them came up, so instead of a silhouette
       just under the glow they became a black hole punched in it. Lifted to
       sit under the new band rather than under the old one; still darker than
       the sky behind, which is the property that matters and the reason the
       original note says it must not invert. */
    const mMat = new THREE.MeshBasicMaterial({ color: MTN_COLOR, fog: false });
    // one ridgeline, one draw call: the cones never move relative to each
    // other, so the transforms are baked instead of costing 14 draws a frame
    const cones: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU), r = rand(2000, 2500);
      const g = new THREE.ConeGeometry(rand(300, 700), rand(220, 520) * mtnScale, 5);
      g.rotateY(rand(0, TAU));
      g.translate(Math.cos(a) * r, 0, Math.sin(a) * r);
      cones.push(g);
    }
    scene.add(new THREE.Mesh(mergeGeometries(cones, false)!, mMat));
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
        /* Pull roughly half the towers into the downtown arcs, alternating
           between them. Indexing by `t` picked arc 0 every single time — the
           branch only runs on even t, so `t % 2` was always 0 and the second
           downtown never got seeded. */
        if (t % 2 === 0) a = downtown[(t >> 1) % downtown.length] + rand(-0.5, 0.5);
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
      backdrop.add(pts);
    }

    /* The abstract city: where the point rings are the city's *detail*, this
       is its *mass* — two kinds of light hung on the same downtown arcs so
       they register as one place. A sodium glow dome over each downtown (the
       light a city throws at its own haze), and a picket of light-columns:
       tall soft gradient slabs that suggest glowing towers without drawing a
       single literal window. Everything additive with 15-stop pow-curve
       tails (no gradient knee ever prints — realistic-light rules) and peaks
       far under the grade's white-clip so the masses stay amber/blue instead
       of bleaching. Lives in the backdrop group: it is at-infinity dressing
       and must follow the car like the rest of the horizon. */
    {
      const domeTex = new THREE.CanvasTexture((() => {
        const c = document.createElement("canvas");
        c.width = 256;
        c.height = 128;
        const x = c.getContext("2d")!;
        const g = x.createRadialGradient(128, 128, 6, 128, 128, 126);
        for (let i = 0; i <= 15; i++) {
          const t = i / 15;
          g.addColorStop(t, `rgba(255,255,255,${(0.5 * Math.pow(1 - t, 2.5)).toFixed(3)})`);
        }
        x.fillStyle = g;
        x.save();
        x.translate(128, 128);
        x.scale(1, 0.55); // squash to a horizon-hugging half-dome
        x.translate(-128, -128);
        x.fillRect(0, -128, 256, 256);
        x.restore();
        return c;
      })());
      // deep orange source: red survives the ACES desaturation better than
      // the target amber does (see the lamp-cone precedent in highway.ts)
      const domeMat = new THREE.SpriteMaterial({
        map: domeTex, color: 0xff7a24, transparent: true, opacity: 0.34,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      domeMat.userData.nightO = 0.34;
      cityAbstractMats.push(domeMat);
      for (const a of downtown) {
        const s = new THREE.Sprite(domeMat);
        s.scale.set(1500, 430, 1);
        s.center.set(0.5, 0); // anchor at the glow's base…
        s.position.set(Math.cos(a) * 2260, -30, Math.sin(a) * 2260); // …below horizon
        s.renderOrder = -9;
        backdrop.add(s);
      }

      const colTex = new THREE.CanvasTexture((() => {
        const c = document.createElement("canvas");
        c.width = 128;
        c.height = 256;
        const x = c.getContext("2d")!;
        for (let col = 0; col < 7; col++) {
          const cx = 10 + col * 17, wpx = 7 + (col % 4) * 2;
          const hpx = 130 + ((col * 47) % 110);
          // base wash climbing the column, long tail upward
          for (let i = 0; i < 15; i++) {
            const t = i / 15;
            x.fillStyle = `rgba(255,255,255,${(0.4 * Math.pow(1 - t, 2.2)).toFixed(3)})`;
            x.fillRect(cx, 256 - (t + 1 / 15) * hpx, wpx, hpx / 15 + 1);
          }
          // sparse brighter flecks — implied floors, not windows
          for (let yy = 250; yy > 256 - hpx; yy -= 7)
            if (Math.random() < 0.45) {
              const fade = 1 - (256 - yy) / hpx;
              x.fillStyle = `rgba(255,255,255,${(0.5 * fade).toFixed(3)})`;
              x.fillRect(cx + Math.floor(Math.random() * (wpx - 2)), yy, 2, 3);
            }
        }
        // fade the bottom edge out so the slab base never prints a line
        const fg = x.createLinearGradient(0, 256, 0, 238);
        fg.addColorStop(0, "rgba(0,0,0,1)");
        fg.addColorStop(1, "rgba(0,0,0,0)");
        x.globalCompositeOperation = "destination-out";
        x.fillStyle = fg;
        x.fillRect(0, 238, 128, 18);
        return c;
      })());
      const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
      const C = new THREE.Color();
      for (let i = 0; i < 40; i++) {
        let a = rand(0, TAU);
        if (i % 4 !== 3) a = downtown[i % 2] + rand(-0.55, 0.55);
        const r = rand(1420, 1620);
        const w = rand(55, 130), h = rand(80, 190), y0 = -8;
        const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
        const tx = -Math.sin(a), tz = Math.cos(a);
        const b0 = pos.length / 3;
        pos.push(
          cx - (tx * w) / 2, y0, cz - (tz * w) / 2,
          cx + (tx * w) / 2, y0, cz + (tz * w) / 2,
          cx + (tx * w) / 2, y0 + h, cz + (tz * w) / 2,
          cx - (tx * w) / 2, y0 + h, cz - (tz * w) / 2
        );
        uv.push(0, 0, 1, 0, 1, 1, 0, 1);
        C.set(Math.random() < 0.7 ? 0xff9a44 : 0x9db8e6).multiplyScalar(rand(0.35, 0.8));
        for (let k = 0; k < 4; k++) col.push(C.r, C.g, C.b);
        idx.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      cg.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
      cg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
      cg.setIndex(idx);
      const colMat = new THREE.MeshBasicMaterial({
        map: colTex, vertexColors: true, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        side: THREE.DoubleSide,
      });
      colMat.userData.nightO = 0.5;
      cityAbstractMats.push(colMat);
      const slabs = new THREE.Mesh(cg, colMat);
      slabs.renderOrder = -8;
      backdrop.add(slabs);
    }

    /* Airport control tower on the east horizon: flared cab on a slim shaft,
       green-white glazing, red beacon — unmistakable in silhouette. */
    {
      const tg = new THREE.Group();
      tg.position.set(1680, 0, 980);
      const shaftM = new THREE.MeshBasicMaterial({ color: 0x141a26, fog: false });
      // shaft + flare + cap all share shaftM and never move: one draw
      const shaft = new THREE.CylinderGeometry(7, 11, 118, 8);
      shaft.translate(0, 59, 0);
      const flare = new THREE.CylinderGeometry(16, 8, 14, 8);
      flare.translate(0, 125, 0);
      const cap = new THREE.CylinderGeometry(2, 15, 7, 8);
      cap.translate(0, 145, 0);
      tg.add(new THREE.Mesh(mergeGeometries([shaft, flare, cap], false)!, shaftM));
      const cab = new THREE.Mesh(
        new THREE.CylinderGeometry(14, 16, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x9fe8d8, fog: false })
      );
      cab.position.y = 137;
      tg.add(cab);
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

  /* Obstruction beacons on three unseen masts. `fog: false` like every other
     backdrop material here: they sit 2.3 km out, and at the fog densities
     weather() runs (1e-3 by day, 2.1e-3 at night) exp2 fog takes them to
     ~0.5% and ~1e-8 of their colour respectively — i.e. the engine was
     blinking three points that could never be seen. */
  const towersMat = new THREE.PointsMaterial({
    size: 3, map: glowTex, color: 0xff5060, transparent: true,
    sizeAttenuation: false, depthWrite: false, fog: false,
  });
  {
    /* red obstruction beacons on far towers — horizon dressing, and the one at
       z = 2200 stood right past the corridor's far end, so these follow too */
    const p = new Float32Array([1500, 560, -1700, -2100, 480, 900, 800, 430, 2200]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    backdrop.add(new THREE.Points(g, towersMat));
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
    const decks: THREE.BufferGeometry[] = [];
    for (const dy of [96, 178]) {
      const rr = dy < 120 ? 40 : 22;
      const g = new THREE.CylinderGeometry(rr, rr, 9, 10);
      g.translate(0, dy, 0);
      decks.push(g);
    }
    towG.add(new THREE.Mesh(mergeGeometries(decks, false)!,
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, fog: false })));
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
  /* Spokes and cabins are rigid within `ferris` (the whole group is what
     spins), so their transforms are baked and each colour becomes one draw
     instead of one per part — 22 draw calls and 22 materials down to 3. */
  {
    const spokes: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const g = new THREE.BoxGeometry(1.1, 110, 1.1);
      g.rotateZ((i / 6) * Math.PI);
      spokes.push(g);
    }
    ferris.add(new THREE.Mesh(mergeGeometries(spokes, false)!,
      new THREE.MeshBasicMaterial({ color: 0x9fb4cc, fog: false })));
    const cabs: THREE.BufferGeometry[][] = [[], []];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      const g = new THREE.BoxGeometry(3, 3.6, 3);
      g.translate(Math.cos(a) * 55, Math.sin(a) * 55, 0);
      cabs[i % 2].push(g);
    }
    for (const [i, hex] of [0xff5fae, 0x49d8ff].entries())
      ferris.add(new THREE.Mesh(mergeGeometries(cabs[i], false)!,
        new THREE.MeshBasicMaterial({ color: hex, fog: false })));
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 4, 10),
    new THREE.MeshBasicMaterial({ color: 0xdfe6f2, fog: false }));
  hub.rotation.x = Math.PI / 2;
  fwG.add(hub);
  {
    const legs: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(2.2, 118, 2.2);
      g.rotateX(s * 0.28);
      g.translate(0, -29, s * 16);
      legs.push(g);
    }
    fwG.add(new THREE.Mesh(mergeGeometries(legs, false)!,
      new THREE.MeshBasicMaterial({ color: 0x5a6478, fog: false })));
  }
  scene.add(fwG);

  return {
    skyMat, skyCache, starMat, moonMat, skylineMat, towersMat, beaconMat, ferris,
    backdrop, cityAbstractMats, aurora, clouds,
  };
}
