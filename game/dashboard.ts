import * as THREE from "three";
import { clamp, lerp, TAU } from "./util";
import { speedInUnits, unitLabel, type SpeedUnits } from "./settings";
import { DEBUG_HOOKS } from "./debug";

/* Instrument cluster for the cockpit view: two analog dials (tacho + speedo)
   with real 3D needles, a centre digital display (speed / gear / odo / tells)
   and a shift-light bar. Dial faces are canvas textures painted once (and
   repainted only when the rev limit, the units or the STYLE change); per-frame
   work is one small canvas redraw plus a couple of needle rotations.

   RESOLUTION. The dial canvases are DIAL_S square and the info panel is
   IW x IH logical units drawn at IS x. From the dashcam a dial subtends
   roughly a sixth of frame height, i.e. ~250-350 device px on a retina
   render — the old 320 px face was sampled at about 1:1, the worst case for
   a mip chain, and read soft. Supersampling it and letting trilinear +
   anisotropy do the downsample is what makes the numerals crisp. The faces
   cost one paint at startup, so the only real price is GPU memory.

   STYLE. Everything about how the dials LOOK lives in a ClusterStyle record;
   CLUSTER_STYLES holds the presets and `window.__cluster` switches between
   them live (same pattern as __aurora / __wall / __povMount) because this is
   a judged-by-eye-while-driving decision, not a rebuild-and-squint one:

     __cluster.style = "mono"     high-contrast reference look
     __cluster.style = "sport"    accent-forward, condensed numerals
     __cluster.style = "oem"      what shipped before this
     __cluster.next()             cycle
     __cluster.dim = 0.55         overall cluster brightness
     __cluster.s.majW = 0.006     poke any single field, then
     __cluster.repaint()          re-paint the faces with it

   CONTRAST. `dim` is the one believable layer of binnacle cover glass, as a
   material tint. The donor dash's real pane was hidden (cockpitmodel.ts)
   because the scan stacked it several layers deep and ate ~25x; bare canvas
   then overshot the other way — numerals near white bloom under the dashcam
   pass. Dial faces, info panel and needle all keep their hue and drop
   together. It pairs with `srgb`: the face canvas used to be handed to three
   with no colour space, i.e. decoded as linear, which lifts every dark grey
   on the dial and is a large part of why the faces read washed. Decoding it
   as sRGB drops the face to near-black while leaving the white numerals
   where they are, so `srgb: true` styles carry a HIGHER dim to land the
   numerals at the same brightness against a much darker face. */

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

/** Every look decision in one flat, console-pokeable record. Lengths and line
    widths are fractions of the dial canvas (S) or of the dial radius (r), so
    the whole style is resolution independent. */
export interface ClusterStyle {
  /** cover-glass tint: face, info panel and needle drop together */
  dim: number;
  /** decode the face canvases as sRGB (true) or as the legacy linear (false) */
  srgb: boolean;
  /* dial face dish */
  face0: string; face1: string; face2: string; faceStop: number;
  /** peak alpha of the accent LED rim wash; 0 turns it off */
  glow: number;
  /* rings, xS */
  rimW: number; rimCol: string;
  shadeW: number; shadeCol: string;
  arcW: number; arcCol: string;
  redW: number; redCol: string; redTick: string; redNum: string;
  /* ticks, xS */
  majW: number; majLen: number; majCol: string;
  minW: number; minLen: number; minCol: string;
  /* numerals + captions */
  font: string; numW: string; numSize: number; numCol: string; numInset: number;
  capSize: number; subSize: number; subCol: string;
  /* needle + hub, xr */
  needleCol: number; needleBase: number; needleTip: number;
  needleLen: number; needleTail: number;
  hubCol: number; hubR: number; hubMetal: number; hubRough: number;
  /* bezel torus */
  bezelCol: number; bezelMetal: number; bezelRough: number; bezelR: number;
  /* centre display */
  panelBg: string; panelEdge: string;
  digitCol: string; digitGlow: string; digitBlur: number;
}

/* `oem` is exactly what the cluster looked like before the sharpening pass —
   kept so the new looks can be A/B'd against it from the seat rather than
   from memory. `mono` chases the night-drive reference: near-black faces,
   thin white ticks, light-weight white numerals, a thin bright-red needle
   with a visible hub, and no chrome. `sport` keeps the black face but leans
   on the car's trim accent, with condensed numerals and a fatter red zone.

   The two sRGB styles run dim 0.42 rather than oem's 0.40 on purpose. Doing
   the arithmetic: oem's #dfe8fb numerals go out at ~0.63 display, and its
   #1b2130 face centre at ~0.23 — a visible grey, which is what flattens it.
   Under an sRGB decode a white numeral at 0.42 lands ~0.69 and the face
   centre ~0.05. So the numerals gain about a tenth while the face drops to
   black: the contrast comes from the FACE, not from turning the lights up,
   which is the point — the user has already had this cluster read hot once
   and asked for 35% off it. If it still reads hot, __cluster.dim is the
   lever, not the face colours. */
export const CLUSTER_STYLES: Record<string, ClusterStyle> = {
  oem: {
    dim: 0.4, srgb: false,
    face0: "#1b2130", face1: "#0d1119", face2: "#05070c", faceStop: 0.72,
    glow: 0.22,
    rimW: 0.018, rimCol: "rgba(150,165,190,.5)",
    shadeW: 0.01, shadeCol: "rgba(0,0,0,.55)",
    arcW: 0.012, arcCol: "rgba(150,178,220,.55)",
    redW: 0.026, redCol: "rgba(255,58,68,.92)", redTick: "#ff6068", redNum: "#ff7a80",
    majW: 0.017, majLen: 0.075, majCol: "#e6eeff",
    minW: 0.008, minLen: 0.038, minCol: "rgba(180,198,226,.75)",
    font: "sans-serif", numW: "700", numSize: 0.088, numCol: "#dfe8fb", numInset: 0.145,
    capSize: 0.062, subSize: 0.05, subCol: "rgba(150,166,196,.9)",
    needleCol: 0xff5058, needleBase: 0.055, needleTip: 0.055,
    needleLen: 0.81, needleTail: 0.2,
    hubCol: 0x14161e, hubR: 0.11, hubMetal: 0.6, hubRough: 0.45,
    bezelCol: 0xa8b2c4, bezelMetal: 0.9, bezelRough: 0.28, bezelR: 0.045,
    panelBg: "rgba(6,9,16,.92)", panelEdge: "rgba(90,108,142,.5)",
    digitCol: "#eaf2ff", digitGlow: "#8fc4ff", digitBlur: 14,
  },
  mono: {
    dim: 0.42, srgb: true,
    face0: "#0b0d12", face1: "#05070b", face2: "#010204", faceStop: 0.6,
    glow: 0.05,
    rimW: 0.009, rimCol: "rgba(126,138,158,.38)",
    shadeW: 0.008, shadeCol: "rgba(0,0,0,.75)",
    arcW: 0, arcCol: "rgba(0,0,0,0)",
    redW: 0.014, redCol: "rgba(255,42,48,.95)", redTick: "#ff3a42", redNum: "#ff6a70",
    majW: 0.0085, majLen: 0.086, majCol: "#ffffff",
    minW: 0.0042, minLen: 0.04, minCol: "rgba(228,234,244,.82)",
    font: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    numW: "400", numSize: 0.094, numCol: "#ffffff", numInset: 0.155,
    capSize: 0.05, subSize: 0.042, subCol: "rgba(158,168,186,.75)",
    needleCol: 0xff2a30, needleBase: 0.05, needleTip: 0.012,
    needleLen: 0.83, needleTail: 0.17,
    hubCol: 0x0a0b0f, hubR: 0.085, hubMetal: 0.35, hubRough: 0.55,
    bezelCol: 0x24272d, bezelMetal: 0.45, bezelRough: 0.55, bezelR: 0.03,
    panelBg: "rgba(2,3,6,.94)", panelEdge: "rgba(120,132,152,.35)",
    digitCol: "#ffffff", digitGlow: "#ffffff", digitBlur: 6,
  },
  sport: {
    dim: 0.42, srgb: true,
    face0: "#120a0c", face1: "#090506", face2: "#020101", faceStop: 0.66,
    glow: 0.2,
    rimW: 0.013, rimCol: "rgba(176,150,154,.34)",
    shadeW: 0.009, shadeCol: "rgba(0,0,0,.7)",
    arcW: 0.007, arcCol: "rgba(198,204,216,.34)",
    redW: 0.03, redCol: "rgba(255,47,58,.95)", redTick: "#ff4a52", redNum: "#ff8288",
    majW: 0.012, majLen: 0.082, majCol: "#ffffff",
    minW: 0.0055, minLen: 0.036, minCol: "rgba(208,213,224,.7)",
    font: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif',
    numW: "700", numSize: 0.102, numCol: "#f4f6ff", numInset: 0.15,
    capSize: 0.056, subSize: 0.046, subCol: "rgba(168,158,164,.8)",
    needleCol: 0xff3a2a, needleBase: 0.062, needleTip: 0.018,
    needleLen: 0.82, needleTail: 0.18,
    hubCol: 0x171012, hubR: 0.1, hubMetal: 0.8, hubRough: 0.35,
    bezelCol: 0x1d1f24, bezelMetal: 0.8, bezelRough: 0.34, bezelR: 0.038,
    panelBg: "rgba(5,2,3,.94)", panelEdge: "rgba(150,110,116,.45)",
    digitCol: "#fff2f2", digitGlow: "#ff5a5a", digitBlur: 10,
  },
};

const DEFAULT_STYLE = "mono";

/* Dial face canvases. Painted on startup and on a style/limit/units change
   only, so the resolution is a GPU-memory decision, not a per-frame one:
   1024^2 RGBA is 4 MiB a dial, ~10.7 MiB for the pair once mips are counted,
   against ~1.1 MiB at the old 320. */
const DIAL_S = 1024;
/* The info panel repaints whenever a value on it changes — up to the 22 Hz
   gauge tick — so it is supersampled more modestly. Every coordinate below
   is in IW x IH logical units and IS scales the whole draw, which is why
   none of drawInfo's hardcoded pixel positions had to move. */
const IW = 176, IH = 232, IS = 2;

const SWEEP_A0 = Math.PI * 0.75; // canvas angle at frac 0
const SWEEP = Math.PI * 1.5; // total sweep
/* Speedo scale per unit. The car tops out near 295 km/h / 183 mph; majors are
   spaced wide enough that three-digit numerals do not run together on the dial.
   The two scales are constants rather than fresh literals because update() asks
   for one every frame. */
const SPEEDO_MPH = { max: 180, step: 30, minorPer: 6 };
const SPEEDO_KMH = { max: 300, step: 50, minorPer: 5 };
const speedoScale = (units: SpeedUnits) => (units === "mph" ? SPEEDO_MPH : SPEEDO_KMH);

/** Needle rotation about +Z for a needle modelled pointing along +Y. */
const needleRot = (frac: number) => -(SWEEP_A0 + SWEEP * clamp(frac, 0, 1)) - Math.PI / 2;

/** Flat trapezoid in XY facing +Z: the needle blade, tapered base-to-tip.
    Unlit (MeshBasicMaterial), so it needs no normals and no thickness. */
function bladeGeom(y0: number, y1: number, w0: number, w1: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-w0 / 2, y0, 0, w0 / 2, y0, 0, w1 / 2, y1, 0, -w1 / 2, y1, 0],
      3
    )
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Changing a texture's colour space changes its internal format, so the
    upload has to be thrown away rather than patched. */
function setColorSpace(t: THREE.Texture, srgb: boolean) {
  const want = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (t.colorSpace === want) return;
  t.dispose();
  t.colorSpace = want;
  t.needsUpdate = true;
}

function paintDialFace(
  g: CanvasRenderingContext2D, S: number, st: ClusterStyle,
  opts: {
    majors: string[]; minorPer: number; redFrac: number;
    caption: string; sub: string; accent: string;
  }
) {
  const cx = S / 2, cy = S / 2, R = S * 0.46;
  g.clearRect(0, 0, S, S);

  // dished face
  const bg = g.createRadialGradient(cx, cy - R * 0.25, R * 0.1, cx, cy, R);
  bg.addColorStop(0, st.face0);
  bg.addColorStop(st.faceStop, st.face1);
  bg.addColorStop(1, st.face2);
  g.fillStyle = bg;
  g.beginPath();
  g.arc(cx, cy, R, 0, TAU);
  g.fill();

  // backlit rim: the accent LED ring real clusters have. Painted into the
  // face texture so `dim` and the grade dim it with everything else, and
  // given a long inward tail (half of R) so it fades rather than printing a
  // hard ring — brightest right at the bezel, gone by mid-face.
  if (st.glow > 0) {
    const ac = new THREE.Color(opts.accent);
    const rgba = (a: number) =>
      `rgba(${Math.round(ac.r * 255)},${Math.round(ac.g * 255)},${Math.round(ac.b * 255)},${a})`;
    const glow = g.createRadialGradient(cx, cy, R * 0.5, cx, cy, R);
    glow.addColorStop(0, rgba(0));
    glow.addColorStop(0.5, rgba(st.glow * 0.23));
    glow.addColorStop(0.8, rgba(st.glow * 0.59));
    glow.addColorStop(1, rgba(st.glow));
    g.fillStyle = glow;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.fill();
  }

  // outer rim + inner shadow ring
  if (st.rimW > 0) {
    g.lineWidth = S * st.rimW;
    g.strokeStyle = st.rimCol;
    g.beginPath();
    g.arc(cx, cy, R - S * 0.01, 0, TAU);
    g.stroke();
  }
  if (st.shadeW > 0) {
    g.lineWidth = S * st.shadeW;
    g.strokeStyle = st.shadeCol;
    g.beginPath();
    g.arc(cx, cy, R - S * 0.035, 0, TAU);
    g.stroke();
  }

  // scale arc
  const rs = R - S * 0.075;
  if (st.arcW > 0) {
    g.lineWidth = S * st.arcW;
    g.strokeStyle = st.arcCol;
    g.beginPath();
    g.arc(cx, cy, rs, SWEEP_A0, SWEEP_A0 + SWEEP);
    g.stroke();
  }

  // redline band
  if (opts.redFrac < 1 && st.redW > 0) {
    g.strokeStyle = st.redCol;
    g.lineWidth = S * st.redW;
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
    const len = S * (major ? st.majLen : st.minLen);
    const past = f > opts.redFrac && opts.redFrac < 1;
    g.strokeStyle = past ? st.redTick : major ? st.majCol : st.minCol;
    g.lineWidth = S * (major ? st.majW : st.minW);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * rs, cy + Math.sin(a) * rs);
    g.lineTo(cx + Math.cos(a) * (rs - len), cy + Math.sin(a) * (rs - len));
    g.stroke();
  }

  // numerals
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `${st.numW} ${Math.round(S * st.numSize)}px ${st.font}`;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const a = SWEEP_A0 + SWEEP * f;
    const rr = rs - S * st.numInset;
    g.fillStyle = f > opts.redFrac && opts.redFrac < 1 ? st.redNum : st.numCol;
    g.fillText(opts.majors[i], cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }

  // captions
  g.fillStyle = opts.accent;
  g.font = `700 ${Math.round(S * st.capSize)}px ${st.font}`;
  g.fillText(opts.caption, cx, cy + R * 0.42);
  g.fillStyle = st.subCol;
  g.font = `${Math.round(S * st.subSize)}px ${st.font}`;
  g.fillText(opts.sub, cx, cy + R * 0.6);
}

let knobLogged = false;

/** `cheap` (kei car): flat plastic bezel instead of a chrome ring, no brow.
    `chunky` (rally car): thicker needles, easier to read at a glance. */
export function buildInstrumentCluster(
  accent: number, defaultUnits: SpeedUnits, cheap = false, chunky = false
): InstrumentCluster {
  const group = new THREE.Group();
  group.name = "cluster";
  const accentCss = "#" + new THREE.Color(accent).getHexString();

  /* The live style is a COPY of the preset, so poking __cluster.s tunes this
     cluster without permanently editing the preset behind it. */
  let styleName = DEFAULT_STYLE;
  let st: ClusterStyle = { ...CLUSTER_STYLES[DEFAULT_STYLE] };

  const shellMat = new THREE.MeshStandardMaterial({
    color: cheap ? 0x22242c : 0x0a0b10, roughness: cheap ? 0.7 : 0.88,
  });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xa8b2c4, metalness: 0.9, roughness: 0.28 });
  const needleMat = new THREE.MeshBasicMaterial({ color: 0xff5058 });
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

  type Dial = {
    cv: HTMLCanvasElement; tex: THREE.CanvasTexture; faceMat: THREE.MeshBasicMaterial;
    pivot: THREE.Group; blade: THREE.Mesh; tail: THREE.Mesh; hub: THREE.Mesh; bez: THREE.Mesh;
    r: number; shown: number;
  };

  function makeDial(x: number, r: number): Dial {
    const cv = document.createElement("canvas");
    cv.width = cv.height = DIAL_S;
    const tex = new THREE.CanvasTexture(cv);
    // three clamps this to the driver maximum; the dial is seen at a steep
    // rake from the dashcam, which is exactly what anisotropy is for
    tex.anisotropy = 16;
    const faceMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    const face = new THREE.Mesh(new THREE.CircleGeometry(r, 64), faceMat);
    face.position.set(x, 0, 0.002);
    group.add(face);

    const bez = new THREE.Mesh(new THREE.TorusGeometry(r * 0.985, r * 0.045, 8, 48), chrome);
    bez.position.set(x, 0, 0.006);
    group.add(bez);

    const pivot = new THREE.Group();
    pivot.position.set(x, 0, 0.012);
    group.add(pivot);
    const blade = new THREE.Mesh(bladeGeom(0, r * 0.8, r * 0.05, r * 0.05), needleMat);
    pivot.add(blade);
    const tail = new THREE.Mesh(bladeGeom(-r * 0.2, 0, r * 0.045, r * 0.05), needleMat);
    pivot.add(tail);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.11, r * 0.13, 0.016, 20), capMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(x, 0, 0.018);
    group.add(hub);

    return { cv, tex, faceMat, pivot, blade, tail, hub, bez, r, shown: 0 };
  }

  const RD = 0.1;
  // the cluster is yawed to face the seat, so local -x lands on the driver's left
  const tach = makeDial(-0.15, RD);
  const speedo = makeDial(0.15, RD);
  const dials = [tach, speedo];

  /* centre digital display */
  const infoCv = document.createElement("canvas");
  infoCv.width = IW * IS;
  infoCv.height = IH * IS;
  const infoCtx = infoCv.getContext("2d")!;
  const infoTex = new THREE.CanvasTexture(infoCv);
  infoTex.anisotropy = 16;
  const infoMat = new THREE.MeshBasicMaterial({ map: infoTex, transparent: true });
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

  /** Everything a style change touches that is NOT painted into the face
      canvas: material tints, needle taper, hub and bezel proportions. */
  function applyStyle() {
    const w = chunky ? 1.5 : 1;
    chrome.color.setHex(cheap ? 0x3a3d46 : st.bezelCol);
    chrome.metalness = cheap ? 0.2 : st.bezelMetal;
    chrome.roughness = cheap ? 0.6 : st.bezelRough;
    needleMat.color.setHex(st.needleCol).multiplyScalar(st.dim);
    capMat.color.setHex(st.hubCol);
    capMat.metalness = st.hubMetal;
    capMat.roughness = st.hubRough;
    infoMat.color.setScalar(st.dim);
    setColorSpace(infoTex, st.srgb);
    for (const d of dials) {
      const r = d.r;
      d.faceMat.color.setScalar(st.dim);
      setColorSpace(d.tex, st.srgb);
      d.blade.geometry.dispose();
      d.blade.geometry = bladeGeom(
        0, r * st.needleLen, r * st.needleBase * w, r * st.needleTip * w
      );
      d.tail.geometry.dispose();
      d.tail.geometry = bladeGeom(
        -r * st.needleTail, 0, r * st.needleBase * 0.85 * w, r * st.needleBase * w
      );
      d.bez.geometry.dispose();
      d.bez.geometry = new THREE.TorusGeometry(r * 0.985, r * st.bezelR, 8, 48);
      d.hub.geometry.dispose();
      d.hub.geometry = new THREE.CylinderGeometry(r * st.hubR, r * st.hubR * 1.18, 0.016, 20);
    }
  }

  let facesRev = -1;
  let facesUnits: SpeedUnits | "" = "";
  function paintFaces(revLimit: number, units: SpeedUnits) {
    const maxR = Math.max(1, Math.ceil(revLimit / 1000));
    paintDialFace(tach.cv.getContext("2d")!, DIAL_S, st, {
      majors: Array.from({ length: maxR + 1 }, (_, i) => String(i)),
      minorPer: 5,
      redFrac: clamp((revLimit - 400) / (maxR * 1000), 0, 1),
      caption: "x1000 r/min",
      sub: "TACHO",
      accent: accentCss,
    });
    tach.tex.needsUpdate = true;
    paintDialFace(speedo.cv.getContext("2d")!, DIAL_S, st, {
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
    facesRev = revLimit;
    facesUnits = units;
  }

  function tell(g: CanvasRenderingContext2D, on: boolean, col: string, ch: string, x: number, y: number) {
    g.fillStyle = on ? col : "rgba(70,78,96,.55)";
    g.font = `700 17px ${st.font}`;
    g.fillText(ch, x, y);
  }

  /* The info panel is a full repaint plus a texture upload, and it is asked to
     draw on every gauge tick even when nothing on it has changed (parked, or
     cruising at a steady indicated speed). These hold the last drawn state —
     every value the panel actually renders — so an unchanged tick costs a
     handful of compares instead. Anything new added to drawInfo must be added
     here too, or it will not repaint. */
  let lastSpd = -1, lastOdo = -1, lastTells = -1;
  let lastGear = "", lastUnits: SpeedUnits | "" = "";
  /** force the next drawInfo through the cache (style changed under it) */
  function dirtyInfo() { lastSpd = -1; }

  function drawInfo(shownSpeed: number, units: SpeedUnits, gearTxt: string, now: number, f: ClusterFlags) {
    const g = infoCtx;
    const blink = now % 0.9 < 0.45;
    const spd = shownSpeed | 0;
    const odoKm = 31842 + Math.floor(f.odo);
    const tells =
      (f.sigL && blink ? 1 : 0) | (f.sigR && blink ? 2 : 0) | (f.lightsOn ? 4 : 0) |
      (f.rain ? 8 : 0) | (f.tcOn ? 16 : 0);
    if (
      spd === lastSpd && odoKm === lastOdo && tells === lastTells &&
      gearTxt === lastGear && units === lastUnits
    )
      return;
    lastSpd = spd;
    lastOdo = odoKm;
    lastTells = tells;
    lastGear = gearTxt;
    lastUnits = units;

    /* Draw in IW x IH logical units; IS supersamples the whole panel. Canvas
       shadows are the one thing the CTM does NOT scale, so blur is scaled by
       hand below. */
    g.setTransform(IS, 0, 0, IS, 0, 0);
    g.clearRect(0, 0, IW, IH);
    g.fillStyle = st.panelBg;
    g.beginPath();
    if ((g as any).roundRect) (g as any).roundRect(6, 8, 164, 216, 14);
    else g.rect(6, 8, 164, 216);
    g.fill();
    g.strokeStyle = st.panelEdge;
    g.lineWidth = 1.5;
    g.stroke();

    g.textAlign = "center";
    g.textBaseline = "middle";

    tell(g, f.sigL && blink, "#37ff8a", "◀", 26, 32);
    tell(g, f.sigR && blink, "#37ff8a", "▶", 150, 32);
    tell(g, f.lightsOn, "#3aa6ff", "≡D", 62, 32);
    tell(g, f.rain, "#6fb8ff", "☂", 88, 32);
    tell(g, f.tcOn, "#ffb43a", "TC", 116, 32);

    // digital speed — the headline readout
    g.fillStyle = st.subCol;
    g.font = `600 13px ${st.font}`;
    g.fillText(unitLabel(units), 88, 56);
    const rev = gearTxt.startsWith("R");
    g.fillStyle = st.digitCol;
    g.shadowColor = st.digitGlow;
    g.shadowBlur = st.digitBlur * IS;
    g.font = `700 62px ${st.font}`;
    g.fillText(String(spd), 88, 100);
    g.shadowBlur = 0;
    g.fillStyle = accentCss;
    g.font = `700 13px ${st.font}`;
    g.fillText(rev ? "REVERSE" : "AUTO  D", 88, 134);

    // gear
    g.fillStyle = rev ? "#ff8a72" : st.numCol;
    g.font = `700 34px ${st.font}`;
    g.fillText(rev ? "R" : gearTxt.replace(/[^0-9]/g, "") || "N", 88, 164);
    g.fillStyle = st.subCol;
    g.font = `11px ${st.font}`;
    g.fillText("GEAR", 88, 184);
    g.fillText("ODO " + odoKm + " km", 88, 204);

    infoTex.needsUpdate = true;
  }

  function repaint() {
    applyStyle();
    if (facesUnits) paintFaces(facesRev, facesUnits);
    dirtyInfo();
  }

  function setStyle(name: string) {
    const preset = CLUSTER_STYLES[name];
    if (!preset) {
      console.warn(`__cluster: no style "${name}" — try ${Object.keys(CLUSTER_STYLES).join(" / ")}`);
      return;
    }
    styleName = name;
    st = { ...preset };
    repaint();
  }

  applyStyle();

  /* LIVE PREVIEW, same idea as window.__aurora / __wall. The look of a night
     cluster cannot be judged from a still, so the presets and every field in
     them are switchable from the console while driving. Dev builds and
     `?debug` URLs only — see game/debug.ts. */
  if (DEBUG_HOOKS) {
    const names = Object.keys(CLUSTER_STYLES);
    const knob = {
      get style() { return styleName; },
      set style(n: string) { setStyle(n); },
      styles: names,
      get s() { return st; },
      get dim() { return st.dim; },
      set dim(v: number) { st.dim = v; repaint(); },
      get srgb() { return st.srgb; },
      set srgb(v: boolean) { st.srgb = v; repaint(); },
      next() { setStyle(names[(names.indexOf(styleName) + 1) % names.length]); return styleName; },
      repaint,
    };
    (window as unknown as { __cluster?: unknown }).__cluster = knob;
    if (!knobLogged) {
      knobLogged = true;
      console.log(
        `%c[cluster] style "${styleName}"  —  __cluster.next() to cycle ` +
          `(${names.join(" / ")}), __cluster.dim to fade it, ` +
          `__cluster.s.<field> + __cluster.repaint() to tune one thing`,
        "color:#8fb4ff"
      );
    }
  }

  function update(rpm: number, kmh: number, gearTxt: string, now: number, f: ClusterFlags) {
    const units = f.units ?? defaultUnits;
    if (f.revLimit !== facesRev || units !== facesUnits) paintFaces(f.revLimit, units);
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
