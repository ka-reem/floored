import * as THREE from "three";
import { clamp, lerp, rand, randi, TAU } from "./util";
import { makeTex } from "./textures";

/* RHD cockpit: dash, seats, gauges (canvas), nav screen, mirrors (RT-fed),
   steering wheel + hands, wipers and the rain-droplet windshield overlay.
   Ported from v2; accent colour + dial redline vary per car. */

export interface Cockpit {
  group: THREE.Group;
  wheelGroup: THREE.Group;
  wiperA: THREE.Group;
  wiperB: THREE.Group;
  mirrorParts: THREE.Mesh[];
  setMirrorVis(v: boolean): void;
  drawGauges(rpm: number, kmh: number, gearTxt: string, now: number, flags: GaugeFlags): void;
  drawScreen(x: number, z: number, h: number, time: number): void;
  dropletsUpdate(dt: number, wiping: boolean, wiperRotZ: number, raining: boolean, speed: number): void;
}

export interface GaugeFlags {
  lightsOn: boolean; sigL: boolean; sigR: boolean; rain: boolean; tcOn: boolean;
  odo: number; revLimit: number;
}

export function buildCockpit(accent: number, mirrorTexture: THREE.Texture): Cockpit {
  const interiorG = new THREE.Group();
  const dashTex = makeTex(
    256, 128,
    (ctx, w, h) => {
      ctx.fillStyle = "#191a20";
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        const v = randi(16, 34);
        ctx.fillStyle = `rgba(${v},${v},${v + 4},.5)`;
        ctx.fillRect(rand(0, w), rand(0, h), 1.3, 1.3);
      }
      ctx.strokeStyle = "rgba(60,62,74,.6)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, h * 0.3);
      ctx.lineTo(w, h * 0.3);
      ctx.stroke();
      ctx.setLineDash([]);
    },
    true
  );
  const dashMat = new THREE.MeshStandardMaterial({ map: dashTex, roughness: 0.82 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0e0f14, roughness: 0.9 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x1a1c24, roughness: 0.85 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x121319, roughness: 0.5, metalness: 0.4 });
  const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.6 });
  const alu = new THREE.MeshStandardMaterial({ color: 0x9aa3b2, metalness: 0.85, roughness: 0.35 });

  function ibox(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    interiorG.add(m);
    return m;
  }

  const dashTop = ibox(1.62, 0.09, 0.62, dashMat, 0, 0.99, 0.72);
  dashTop.rotation.x = -0.1;
  ibox(1.62, 0.3, 0.34, dashMat, 0, 0.86, 0.8);
  ibox(1.62, 0.22, 0.2, darkMat, 0, 0.68, 0.86);
  const cowl = ibox(0.62, 0.05, 0.3, darkMat, 0.38, 1.065, 0.6);
  cowl.rotation.x = -0.16;
  {
    const ap = ibox(0.05, 0.66, 0.07, darkMat, -0.74, 1.38, 0.8);
    ap.rotation.z = 0.42;
    ap.rotation.y = -0.1;
    const ap2 = ibox(0.05, 0.66, 0.07, darkMat, 0.74, 1.38, 0.8);
    ap2.rotation.z = -0.42;
    ap2.rotation.y = 0.1;
  }
  ibox(1.7, 0.05, 1.9, darkMat, 0, 1.7, -0.25);
  ibox(0.07, 0.34, 2.1, darkMat, -0.85, 0.94, -0.2);
  ibox(0.07, 0.34, 2.1, darkMat, 0.85, 0.94, -0.2);
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
    ibox(0.05, 0.5, 0.06, darkMat, s * 0.85, 1.36, -0.34);
  }
  const wgB = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.42), winGlassM);
  wgB.position.set(0, 1.34, -1.28);
  wgB.rotation.x = 0.42;
  interiorG.add(wgB);
  ibox(1.5, 0.1, 0.5, seatMat, 0, 1.06, -1.18);
  ibox(0.3, 0.06, 0.5, dashMat, -0.7, 0.92, -0.2);
  ibox(0.3, 0.06, 0.5, dashMat, 0.7, 0.92, -0.2);
  ibox(0.4, 0.3, 0.7, darkMat, 0, 0.7, 0.1);
  for (const sx of [0.38, -0.38]) {
    ibox(0.5, 0.14, 0.55, seatMat, sx, 0.56, -0.28);
    const bk = ibox(0.5, 0.62, 0.13, seatMat, sx, 0.92, -0.56);
    bk.rotation.x = 0.14;
    ibox(0.4, 0.16, 0.1, seatMat, sx, 1.28, -0.62);
    for (const bs of [-1, 1]) {
      ibox(0.09, 0.12, 0.5, seatMat, sx + bs * 0.24, 0.6, -0.28);
      const bb = ibox(0.09, 0.56, 0.12, seatMat, sx + bs * 0.24, 0.92, -0.54);
      bb.rotation.x = 0.14;
    }
    const stc = ibox(0.02, 0.5, 0.005, accentMat, sx, 0.92, -0.492);
    stc.rotation.x = 0.14;
  }
  ibox(0.05, 0.28, 0.02, darkMat, 0.12, 0.9, -0.4).rotation.z = 0.5;
  {
    const v1 = ibox(0.42, 0.015, 0.17, darkMat, 0.38, 1.685, 0.36);
    v1.rotation.x = 1.15;
    const v2 = ibox(0.42, 0.015, 0.17, darkMat, -0.38, 1.685, 0.36);
    v2.rotation.x = 1.15;
  }

  /* gauges */
  const gaugeCv = document.createElement("canvas");
  gaugeCv.width = 560;
  gaugeCv.height = 240;
  const gaugeTex = new THREE.CanvasTexture(gaugeCv);
  const gaugeMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.56, 0.24),
    new THREE.MeshBasicMaterial({ map: gaugeTex, transparent: true })
  );
  gaugeMesh.position.set(0.38, 1.005, 0.59);
  gaugeMesh.rotation.x = -0.14;
  interiorG.add(gaugeMesh);

  function dial(
    g: CanvasRenderingContext2D, cx: number, cy: number, r: number, frac: number,
    red: number, label: string[], val: string | number
  ) {
    g.strokeStyle = "rgba(90,110,150,.7)";
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25);
    g.stroke();
    g.strokeStyle = "rgba(255,70,80,.8)";
    g.beginPath();
    g.arc(cx, cy, r, Math.PI * (0.75 + 1.5 * red), Math.PI * 2.25);
    g.stroke();
    g.fillStyle = "#aec4e8";
    g.font = "11px sans-serif";
    g.textAlign = "center";
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * (0.75 + (1.5 * i) / 8);
      g.fillText(label[i] || "", cx + Math.cos(a) * (r - 16), cy + Math.sin(a) * (r - 16) + 4);
    }
    const a = Math.PI * (0.75 + 1.5 * clamp(frac, 0, 1));
    g.strokeStyle = "#ff5f66";
    g.lineWidth = 3.4;
    g.shadowColor = "#ff5f66";
    g.shadowBlur = 9;
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * 10, cy - Math.sin(a) * 10);
    g.lineTo(cx + Math.cos(a) * (r - 20), cy + Math.sin(a) * (r - 20));
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = "#0c101e";
    g.beginPath();
    g.arc(cx, cy, 8, 0, TAU);
    g.fill();
    g.fillStyle = "#e8f0ff";
    g.font = "700 17px sans-serif";
    g.fillText(String(val), cx, cy + r * 0.62);
  }

  function drawGauges(rpm: number, kmh: number, gearTxt: string, now: number, f: GaugeFlags) {
    const g = gaugeCv.getContext("2d")!;
    g.clearRect(0, 0, 560, 240);
    g.fillStyle = "rgba(8,11,22,.94)";
    g.beginPath();
    if ((g as any).roundRect) (g as any).roundRect(4, 4, 552, 232, 22);
    else g.rect(4, 4, 552, 232);
    g.fill();
    const maxR = Math.ceil(f.revLimit / 1000);
    dial(g, 140, 124, 96, rpm / (maxR * 1000), (f.revLimit - 600) / (maxR * 1000),
      Array.from({ length: 9 }, (_, i) => String(Math.round((i * maxR) / 8))), rpm | 0);
    dial(g, 420, 124, 96, kmh / 260, 999, ["0", "", "60", "", "130", "", "200", "", "260"],
      (kmh | 0) + " km/h");
    g.fillStyle = "#dfe7ff";
    g.font = "700 26px sans-serif";
    g.textAlign = "center";
    g.fillText(gearTxt, 280, 150);
    g.fillStyle = "#7f8db0";
    g.font = "11px sans-serif";
    g.fillText("ODO " + (31842 + Math.floor(f.odo)) + " km", 280, 176);
    if (f.lightsOn) {
      g.fillStyle = "#3aa6ff";
      g.font = "13px sans-serif";
      g.fillText("⚡", 280, 110);
    }
    const bOn = now % 0.9 < 0.45;
    if (f.sigL && bOn) {
      g.fillStyle = "#37ff8a";
      g.font = "700 22px sans-serif";
      g.fillText("◀", 236, 116);
    }
    if (f.sigR && bOn) {
      g.fillStyle = "#37ff8a";
      g.font = "700 22px sans-serif";
      g.fillText("▶", 324, 116);
    }
    if (f.rain) {
      g.fillStyle = "#6fb8ff";
      g.font = "12px sans-serif";
      g.fillText("☔", 280, 96);
    }
    if (f.tcOn) {
      g.fillStyle = "#ffb43a";
      g.font = "700 12px sans-serif";
      g.fillText("TC", 316, 96);
    }
    gaugeTex.needsUpdate = true;
  }

  /* nav screen */
  const scrCv = document.createElement("canvas");
  scrCv.width = 256;
  scrCv.height = 160;
  const scrTex = new THREE.CanvasTexture(scrCv);
  const scrMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.19),
    new THREE.MeshBasicMaterial({ map: scrTex, transparent: true })
  );
  scrMesh.position.set(-0.015, 0.97, 0.62);
  scrMesh.rotation.x = -0.12;
  scrMesh.rotation.y = -0.22;
  interiorG.add(scrMesh);
  function drawScreen(x: number, z: number, h: number, time: number) {
    const g = scrCv.getContext("2d")!;
    g.fillStyle = "#060a14";
    g.fillRect(0, 0, 256, 160);
    g.strokeStyle = "rgba(40,120,220,.5)";
    g.lineWidth = 1;
    const ox = (x * 0.5) % 32, oz = (z * 0.5) % 32;
    for (let gx = -ox; gx < 256; gx += 32) {
      g.beginPath();
      g.moveTo(gx, 0);
      g.lineTo(gx, 160);
      g.stroke();
    }
    for (let gy = -oz; gy < 160; gy += 32) {
      g.beginPath();
      g.moveTo(0, gy);
      g.lineTo(256, gy);
      g.stroke();
    }
    g.save();
    g.translate(128, 88);
    g.rotate(-h);
    g.fillStyle = "#4fd2ff";
    g.shadowColor = "#4fd2ff";
    g.shadowBlur = 8;
    g.beginPath();
    g.moveTo(0, -9);
    g.lineTo(6, 7);
    g.lineTo(-6, 7);
    g.closePath();
    g.fill();
    g.restore();
    g.shadowBlur = 0;
    g.fillStyle = "#9fb6de";
    g.font = "11px sans-serif";
    g.textAlign = "left";
    g.fillText("NAVI  首都高 C1", 10, 16);
    const mm = ((time % 1) * 60) | 0, hh = time | 0;
    g.fillText((hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm, 210, 16);
    scrTex.needsUpdate = true;
  }
  {
    const bez = ibox(0.34, 0.23, 0.015, darkMat, -0.01, 0.97, 0.605);
    bez.rotation.y = -0.22;
    bez.rotation.x = -0.12;
  }

  /* steering wheel + hands */
  const wheelGroup = new THREE.Group();
  wheelGroup.position.set(0.38, 1.0, 0.42);
  interiorG.add(wheelGroup);
  const rimTor = new THREE.Mesh(
    new THREE.TorusGeometry(0.17, 0.023, 10, 26),
    new THREE.MeshStandardMaterial({ color: 0x15161c, roughness: 0.6 })
  );
  wheelGroup.add(rimTor);
  for (const a of [0, 2.2, -2.2]) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.16, 0.02), trimMat);
    sp.position.set(Math.sin(a) * 0.085, -Math.cos(a) * 0.085, 0);
    sp.rotation.z = -a;
    wheelGroup.add(sp);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), trimMat);
  hub.rotation.x = Math.PI / 2;
  wheelGroup.add(hub);
  const skinMat = new THREE.MeshStandardMaterial({ color: 0x8a6248, roughness: 0.75 });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x22242c, roughness: 0.85 });
  function hand(side: number) {
    const g = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.075, 0.045), skinMat);
    g.add(palm);
    for (let f = 0; f < 4; f++) {
      const fg = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.04, 0.014), skinMat);
      fg.position.set(-0.019 + f * 0.0125, 0.05, -0.012);
      fg.rotation.x = -0.7;
      g.add(fg);
    }
    const th = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.032, 0.014), skinMat);
    th.position.set(side * 0.03, 0.01, 0.02);
    th.rotation.z = side * 0.7;
    g.add(th);
    const sl = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.037, 0.16, 8), sleeveMat);
    sl.position.set(side * 0.02, -0.13, 0.05);
    sl.rotation.x = 0.5;
    sl.rotation.z = side * 0.22;
    g.add(sl);
    return g;
  }
  const handL = hand(-1), handR = hand(1);
  handL.position.set(-0.155, 0.055, 0.012);
  handL.rotation.z = 0.85;
  handR.position.set(0.155, 0.055, 0.012);
  handR.rotation.z = -0.85;
  wheelGroup.add(handL, handR);

  /* mirrors fed by the rear-view RT */
  const mirrorMat = new THREE.MeshBasicMaterial({ map: mirrorTexture, side: THREE.DoubleSide });
  mirrorMat.toneMapped = false;
  mirrorMat.color.setScalar(1.55);
  const mirrorMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.15), mirrorMat);
  mirrorMesh.position.set(0, 1.42, 0.5);
  mirrorMesh.rotation.x = -0.07;
  mirrorMesh.scale.x = -1;
  interiorG.add(mirrorMesh);
  ibox(0.56, 0.18, 0.03, darkMat, 0, 1.42, 0.53);
  const sideMirL = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.115), mirrorMat);
  sideMirL.position.set(-0.88, 1.12, 0.52);
  sideMirL.rotation.y = 0.72;
  sideMirL.scale.x = -1;
  interiorG.add(sideMirL);
  ibox(0.035, 0.15, 0.16, darkMat, -0.965, 1.12, 0.555);
  const sideMirR = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.115), mirrorMat);
  sideMirR.position.set(0.88, 1.12, 0.52);
  sideMirR.rotation.y = -0.72;
  sideMirR.scale.x = -1;
  interiorG.add(sideMirR);
  ibox(0.035, 0.15, 0.16, darkMat, 0.965, 1.12, 0.555);
  const mirrorParts = [mirrorMesh, sideMirL, sideMirR];

  /* vents, accents, pedals, handbrake, door cards */
  const ventM = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.7 });
  for (const vx of [-0.62, -0.24, 0.24, 0.62]) {
    ibox(0.17, 0.06, 0.02, ventM, vx, 0.955, 0.868);
    ibox(0.15, 0.008, 0.024, darkMat, vx, 0.955, 0.872);
    ibox(0.15, 0.008, 0.024, darkMat, vx, 0.972, 0.872);
  }
  const stripM = new THREE.MeshStandardMaterial({
    color: 0x06222c, emissive: 0x37c8ff, emissiveIntensity: 1.1,
  });
  ibox(1.5, 0.014, 0.014, stripM, 0, 0.845, 0.87);
  {
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.037, 10, 8), darkMat);
    knob.position.set(0, 0.83, -0.02);
    interiorG.add(knob);
    ibox(0.018, 0.09, 0.018, darkMat, 0, 0.78, -0.02);
  }
  for (const dx of [-0.085, 0, 0.085]) {
    const d = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.022, 16),
      new THREE.MeshStandardMaterial({ color: 0x1a1c24, roughness: 0.5, metalness: 0.5 })
    );
    d.position.set(dx - 0.02, 0.885, 0.842);
    d.rotation.x = Math.PI / 2;
    interiorG.add(d);
  }
  ibox(0.07, 0.028, 0.16, darkMat, 0.14, 0.72, -0.2);
  {
    const lev = ibox(0.03, 0.2, 0.03, darkMat, 0.14, 0.8, -0.16);
    lev.rotation.x = -0.85;
    const grip = ibox(0.036, 0.07, 0.036, seatMat, 0.14, 0.87, -0.1);
    grip.rotation.x = -0.85;
  }
  for (const [px, pw] of [[0.26, 0.07], [0.4, 0.09], [0.52, 0.06]] as const) {
    const pd = ibox(pw, 0.11, 0.02, darkMat, px, 0.34, 0.6);
    pd.rotation.x = -0.5;
  }
  for (const s of [-1, 1]) {
    ibox(0.02, 0.1, 0.5, seatMat, s * 0.83, 0.86, -0.05);
    ibox(0.14, 0.022, 0.09, darkMat, s * 0.76, 0.925, -0.1);
    for (let b = 0; b < 3; b++) ibox(0.02, 0.008, 0.02, alu, s * 0.76 - 0.03 + b * 0.03, 0.938, -0.1);
    const spk = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.008, 6, 16), darkMat);
    spk.position.set(s * 0.845, 0.72, 0.35);
    spk.rotation.y = (s * Math.PI) / 2;
    interiorG.add(spk);
  }
  ibox(1.58, 0.006, 0.006, accentMat, 0, 1.036, 0.71);
  ibox(0.5, 0.006, 0.006, accentMat, 0.38, 1.075, 0.585);
  ibox(0.5, 0.005, 0.4,
    new THREE.MeshStandardMaterial({ color: 0x0a0c14, emissive: 0x2a5cff, emissiveIntensity: 0.35 }),
    0.4, 0.27, 0.4);
  ibox(0.5, 0.15, 0.02, darkMat, 0, 1.42, 0.515);

  /* wipers */
  const wiperA = new THREE.Group(), wiperB = new THREE.Group();
  function mkWiper() {
    const g = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.42, 0.012), darkMat);
    arm.position.y = 0.21;
    g.add(arm);
    const bl = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.34, 0.02), darkMat);
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

  /* windshield droplet overlay */
  const dropCv = document.createElement("canvas");
  dropCv.width = 512;
  dropCv.height = 220;
  const dropCtx = dropCv.getContext("2d")!;
  const dropTex = new THREE.CanvasTexture(dropCv);
  const wsGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.56),
    new THREE.MeshBasicMaterial({ map: dropTex, transparent: true, depthWrite: false })
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
