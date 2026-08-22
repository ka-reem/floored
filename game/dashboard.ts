import * as THREE from "three";
import { clamp, lerp, TAU } from "./util";
import { speedInUnits, unitLabel, type SpeedUnits } from "./settings";

/* Instrument cluster for the cockpit view: two analog dials (tacho + speedo)
   with real 3D needles, a centre digital display (speed / gear / odo / tells)
   and a shift-light bar. Dial faces are canvas textures painted once (and
   repainted only when the rev limit changes); per-frame work is one small
   canvas redraw plus a couple of needle rotations. */

export interface ClusterFlags {
  lightsOn: boolean; sigL: boolean; sigR: boolean; rain: boolean; tcOn: boolean;
  odo: number; revLimit: number;
  /* Supplied by engine.ts from the live settings and car state. Optional so
     the cluster still draws without them: units then falls back to the profile
     read when the cockpit was built, and the limiter is inferred from rpm. */
  units?: SpeedUnits;
  onLimiter?: boolean;
}

export interface InstrumentCluster {
  group: THREE.Group;
  update(rpm: number, kmh: number, gearTxt: string, now: number, f: ClusterFlags): void;
}

/* One believable layer of binnacle cover glass, as a material tint. The donor
   dash's real pane was hidden (cockpitmodel.ts) because the scan stacked it
   several layers deep and ate ~25x; bare canvas then overshot the other way —
   numerals near white bloom under the dashcam pass. This is the middle: dial
   faces, info panel and needle all keep their hue and drop together. */
const FACE_DIM = 0.62;

const SWEEP_A0 = Math.PI * 0.75; // canvas angle at frac 0
const SWEEP = Math.PI * 1.5; // total sweep
/* Speedo scale per unit. The car tops out near 295 km/h / 183 mph; majors are
   spaced wide enough that three-digit numerals do not run together on the dial. */
const speedoScale = (units: SpeedUnits) =>
  units === "mph" ? { max: 180, step: 30, minorPer: 6 } : { max: 300, step: 50, minorPer: 5 };

/** Needle rotation about +Z for a needle modelled pointing along +Y. */
const needleRot = (frac: number) => -(SWEEP_A0 + SWEEP * clamp(frac, 0, 1)) - Math.PI / 2;

function paintDialFace(
  g: CanvasRenderingContext2D, S: number,
  opts: {
    majors: string[]; minorPer: number; redFrac: number;
    caption: string; sub: string; accent: string;
  }
) {
  const cx = S / 2, cy = S / 2, R = S * 0.46;
  g.clearRect(0, 0, S, S);

  // dished face
  const bg = g.createRadialGradient(cx, cy - R * 0.25, R * 0.1, cx, cy, R);
  bg.addColorStop(0, "#1b2130");
  bg.addColorStop(0.72, "#0d1119");
  bg.addColorStop(1, "#05070c");
  g.fillStyle = bg;
  g.beginPath();
  g.arc(cx, cy, R, 0, TAU);
  g.fill();

  // outer chrome-ish rim + inner shadow ring
  g.lineWidth = S * 0.018;
  g.strokeStyle = "rgba(150,165,190,.5)";
  g.beginPath();
  g.arc(cx, cy, R - S * 0.01, 0, TAU);
  g.stroke();
  g.lineWidth = S * 0.01;
  g.strokeStyle = "rgba(0,0,0,.55)";
  g.beginPath();
  g.arc(cx, cy, R - S * 0.035, 0, TAU);
  g.stroke();

  // scale arc
  const rs = R - S * 0.075;
  g.lineWidth = S * 0.012;
  g.strokeStyle = "rgba(150,178,220,.55)";
  g.beginPath();
  g.arc(cx, cy, rs, SWEEP_A0, SWEEP_A0 + SWEEP);
  g.stroke();

  // redline band
  if (opts.redFrac < 1) {
    g.strokeStyle = "rgba(255,58,68,.92)";
    g.lineWidth = S * 0.026;
    g.beginPath();
    g.arc(cx, cy, rs, SWEEP_A0 + SWEEP * opts.redFrac, SWEEP_A0 + SWEEP);
    g.stroke();
  }

  const n = opts.majors.length - 1;
  const steps = n * opts.minorPer;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const a = SWEEP_A0 + SWEEP * f;
    const major = i % opts.minorPer === 0;
    const len = major ? S * 0.075 : S * 0.038;
    const past = f > opts.redFrac && opts.redFrac < 1;
    g.strokeStyle = past ? "#ff6068" : major ? "#e6eeff" : "rgba(180,198,226,.75)";
    g.lineWidth = major ? S * 0.017 : S * 0.008;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * rs, cy + Math.sin(a) * rs);
    g.lineTo(cx + Math.cos(a) * (rs - len), cy + Math.sin(a) * (rs - len));
    g.stroke();
  }

  // numerals
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${Math.round(S * 0.088)}px sans-serif`;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const a = SWEEP_A0 + SWEEP * f;
    const rr = rs - S * 0.145;
    g.fillStyle = f > opts.redFrac && opts.redFrac < 1 ? "#ff7a80" : "#dfe8fb";
    g.fillText(opts.majors[i], cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }

  // captions
  g.fillStyle = opts.accent;
  g.font = `700 ${Math.round(S * 0.062)}px sans-serif`;
  g.fillText(opts.caption, cx, cy + R * 0.42);
  g.fillStyle = "rgba(150,166,196,.9)";
  g.font = `${Math.round(S * 0.05)}px sans-serif`;
  g.fillText(opts.sub, cx, cy + R * 0.6);
}

/** `cheap` (kei car): flat plastic bezel instead of a chrome ring, no brow.
    `chunky` (rally car): thicker needles, easier to read at a glance. */
export function buildInstrumentCluster(
  accent: number, defaultUnits: SpeedUnits, cheap = false, chunky = false
): InstrumentCluster {
  const group = new THREE.Group();
  group.name = "cluster";
  const accentCss = "#" + new THREE.Color(accent).getHexString();

  const shellMat = new THREE.MeshStandardMaterial({
    color: cheap ? 0x22242c : 0x0a0b10, roughness: cheap ? 0.7 : 0.88,
  });
  const chrome = new THREE.MeshStandardMaterial(
    cheap ? { color: 0x3a3d46, metalness: 0.2, roughness: 0.6 }
      : { color: 0xa8b2c4, metalness: 0.9, roughness: 0.28 }
  );
  const needleMat = new THREE.MeshBasicMaterial({ color: 0xff5058 });
  needleMat.color.multiplyScalar(FACE_DIM);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x14161e, roughness: 0.45, metalness: 0.6 });

  /* housing: a shallow box the dials sit in. No brow/hood on any trim — the
     dials sit in an open recess like the reference car's, because from the
     fixed dashcam POV a brow is a featureless black bar laid across the frame
     right where the road hands over to the cluster. The box hugs the dials
     (0.52 x 0.22): the old 0.56 x 0.25 shell stood ~3 cm proud of the dial
     rims, and from the dashcam that margin alone smeared into a dark wedge
     clipping the dash-top tablet's near corner. */
  const shell = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.22, 0.05), shellMat);
  shell.position.z = -0.03;
  group.add(shell);

  const S = 320;
  type Dial = {
    cv: HTMLCanvasElement; tex: THREE.CanvasTexture; pivot: THREE.Group; shown: number;
  };

  function makeDial(x: number, r: number): Dial {
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    const faceMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    faceMat.color.setScalar(FACE_DIM);
    const face = new THREE.Mesh(new THREE.CircleGeometry(r, 44), faceMat);
    face.position.set(x, 0, 0.002);
    group.add(face);

    const bez = new THREE.Mesh(new THREE.TorusGeometry(r * 0.985, r * 0.045, 6, 30), chrome);
    bez.position.set(x, 0, 0.006);
    group.add(bez);

    const pivot = new THREE.Group();
    pivot.position.set(x, 0, 0.012);
    group.add(pivot);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(r * (chunky ? 0.08 : 0.055), r * 0.78, 0.004), needleMat);
    blade.position.y = r * 0.42;
    pivot.add(blade);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(r * 0.075, r * 0.2, 0.004), needleMat);
    tail.position.y = -r * 0.1;
    pivot.add(tail);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.11, r * 0.13, 0.016, 14), capMat);
    cap.rotation.x = Math.PI / 2;
    cap.position.set(x, 0, 0.018);
    group.add(cap);

    return { cv, tex, pivot, shown: 0 };
  }

  const RD = 0.1;
  // the cluster is yawed to face the seat, so local -x lands on the driver's left
  const tach = makeDial(-0.15, RD);
  const speedo = makeDial(0.15, RD);

  /* centre digital display */
  const infoCv = document.createElement("canvas");
  infoCv.width = 176;
  infoCv.height = 232;
  const infoCtx = infoCv.getContext("2d")!;
  const infoTex = new THREE.CanvasTexture(infoCv);
  const infoMat = new THREE.MeshBasicMaterial({ map: infoTex, transparent: true });
  infoMat.color.setScalar(FACE_DIM);
  const info = new THREE.Mesh(new THREE.PlaneGeometry(0.145, 0.19), infoMat);
  info.position.set(0, 0, 0.004);
  group.add(info);

  /* shift lights across the brow */
  const shiftMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 7; i++) {
    const m = new THREE.MeshBasicMaterial({ color: 0x101218, transparent: true, opacity: 0.5 });
    shiftMats.push(m);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.011, 0.004), m);
    seg.position.set((i - 3) * 0.034, 0.104, 0.026);
    group.add(seg);
  }

  let facesFor = "";
  function paintFaces(revLimit: number, units: SpeedUnits) {
    const maxR = Math.max(1, Math.ceil(revLimit / 1000));
    paintDialFace(tach.cv.getContext("2d")!, S, {
      majors: Array.from({ length: maxR + 1 }, (_, i) => String(i)),
      minorPer: 5,
      redFrac: clamp((revLimit - 400) / (maxR * 1000), 0, 1),
      caption: "x1000 r/min",
      sub: "TACHO",
      accent: accentCss,
    });
    tach.tex.needsUpdate = true;
    paintDialFace(speedo.cv.getContext("2d")!, S, {
      majors: Array.from(
        { length: speedoScale(units).max / speedoScale(units).step + 1 },
        (_, i) => String(i * speedoScale(units).step)
      ),
      minorPer: speedoScale(units).minorPer,
      redFrac: 1,
      caption: unitLabel(units),
      sub: "SPEED",
      accent: accentCss,
    });
    speedo.tex.needsUpdate = true;
    facesFor = revLimit + units;
  }

  function tell(g: CanvasRenderingContext2D, on: boolean, col: string, ch: string, x: number, y: number) {
    g.fillStyle = on ? col : "rgba(70,78,96,.55)";
    g.font = "700 17px sans-serif";
    g.fillText(ch, x, y);
  }

  function drawInfo(shownSpeed: number, units: SpeedUnits, gearTxt: string, now: number, f: ClusterFlags) {
    const g = infoCtx;
    g.clearRect(0, 0, 176, 232);
    g.fillStyle = "rgba(6,9,16,.92)";
    g.beginPath();
    if ((g as any).roundRect) (g as any).roundRect(6, 8, 164, 216, 14);
    else g.rect(6, 8, 164, 216);
    g.fill();
    g.strokeStyle = "rgba(90,108,142,.5)";
    g.lineWidth = 2;
    g.stroke();

    g.textAlign = "center";
    g.textBaseline = "middle";

    const blink = now % 0.9 < 0.45;
    tell(g, f.sigL && blink, "#37ff8a", "◀", 26, 32);
    tell(g, f.sigR && blink, "#37ff8a", "▶", 150, 32);
    tell(g, f.lightsOn, "#3aa6ff", "≡D", 62, 32);
    tell(g, f.rain, "#6fb8ff", "☂", 88, 32);
    tell(g, f.tcOn, "#ffb43a", "TC", 116, 32);

    // digital speed — the headline readout
    g.fillStyle = "rgba(150,166,196,.85)";
    g.font = "600 13px sans-serif";
    g.fillText(unitLabel(units), 88, 56);
    const rev = gearTxt.startsWith("R");
    g.fillStyle = "#eaf2ff";
    g.shadowColor = "#8fc4ff";
    g.shadowBlur = 14;
    g.font = "700 62px sans-serif";
    g.fillText(String(shownSpeed | 0), 88, 100);
    g.shadowBlur = 0;
    g.fillStyle = accentCss;
    g.font = "700 13px sans-serif";
    g.fillText(rev ? "REVERSE" : "AUTO  D", 88, 134);

    // gear
    g.fillStyle = rev ? "#ff8a72" : "#dfe8fb";
    g.font = "700 34px sans-serif";
    g.fillText(rev ? "R" : gearTxt.replace(/[^0-9]/g, "") || "N", 88, 164);
    g.fillStyle = "rgba(150,166,196,.85)";
    g.font = "11px sans-serif";
    g.fillText("GEAR", 88, 184);
    g.fillText("ODO " + (31842 + Math.floor(f.odo)) + " km", 88, 204);

    infoTex.needsUpdate = true;
  }

  function update(rpm: number, kmh: number, gearTxt: string, now: number, f: ClusterFlags) {
    const units = f.units ?? defaultUnits;
    if (f.revLimit + units !== facesFor) paintFaces(f.revLimit, units);
    const maxR = Math.max(1, Math.ceil(f.revLimit / 1000)) * 1000;
    // engine.ts hands us km/h; re-derive m/s so the face can speak either unit
    const shownSpeed = speedInUnits(Math.abs(kmh) / 3.6, units);

    tach.shown = lerp(tach.shown, clamp(rpm / maxR, 0, 1), 0.38);
    speedo.shown = lerp(speedo.shown, clamp(shownSpeed / speedoScale(units).max, 0, 1), 0.3);
    tach.pivot.rotation.z = needleRot(tach.shown);
    speedo.pivot.rotation.z = needleRot(speedo.shown);

    // shift lights: last ~1800rpm before the limiter, all flashing at the limit
    const lit = clamp((rpm - (f.revLimit - 1800)) / 1800, 0, 1) * shiftMats.length;
    const atLimit = f.onLimiter ?? rpm > f.revLimit - 220;
    const limiter = atLimit && now % 0.16 < 0.08;
    for (let i = 0; i < shiftMats.length; i++) {
      const on = limiter || i < lit;
      const col = i < 3 ? 0x2fe07a : i < 5 ? 0xffc23a : 0xff3b46;
      shiftMats[i].color.setHex(on ? (limiter ? 0xff3b46 : col) : 0x101218);
      shiftMats[i].opacity = on ? 1 : 0.45;
    }

    drawInfo(shownSpeed, units, gearTxt, now, f);
  }

  return { group, update };
}
