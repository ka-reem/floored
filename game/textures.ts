import * as THREE from "three";
import { rand, randi, pick } from "./util";

type PaintFn = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

/* NOTE: textures are deliberately left in linear space (no sRGB tag) and the
   engine disables THREE.ColorManagement — the v2 art was authored/tuned under
   r128's non-managed pipeline, and this reproduces that exact look under the
   new manual ACES composite. */
export function makeTex(
  w: number,
  h: number,
  fn: PaintFn,
  wrap?: boolean
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  fn(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // three clamps this to the driver maximum; 16 keeps road markings from
  // dissolving into mush a few metres ahead of the car
  t.anisotropy = 16;
  return t;
}

/* ------------------------------------------------------------------ *
 * Photo-scanned PBR sets
 *
 * Real albedo/normal/roughness scans live under public/assets/pbr/<set>/
 * as albedo.jpg / normal.jpg / rough.jpg / ao.jpg / metal.jpg. Only albedo
 * is required; a set with no albedo is treated as absent and every caller
 * silently keeps its procedural canvas texture. Nothing here throws and
 * nothing blocks startup — the maps arrive asynchronously and materials
 * upgrade themselves in place when they land.
 *
 * NOTE on colour space: the engine runs with THREE.ColorManagement disabled,
 * which leaves the hand-authored canvas art in its original linear-ish space.
 * That switch does NOT disable the hardware sRGB decode — three picks the
 * SRGB8_ALPHA8 internal format straight off texture.colorSpace — so photo
 * albedo still has to be tagged sRGB to linearise correctly, while the
 * data maps (normal/rough/ao/metal) must stay untagged.
 * ------------------------------------------------------------------ */

const PBR_BASE = "/assets/pbr";

export interface PbrSet {
  albedo: THREE.Texture | null;
  normal: THREE.Texture | null;
  rough: THREE.Texture | null;
  metal: THREE.Texture | null;
  /** cutout opacity map (alpha.jpg) — perforated fences, grated catwalks */
  alpha: THREE.Texture | null;
  /** mean *linear* luminance of the albedo; 1 until measured */
  albedoMean: number;
  /** mean of the roughness map's green channel; 1 until measured */
  roughMean: number;
}

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/** Average an image down to a few texels and read the mean back.
    Used to keep the detail layers mean-preserving, so dropping a photo set
    on top of the procedural art changes its texture but not its brightness. */
function measureMean(img: CanvasImageSource, srgb: boolean): number {
  const N = 8;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const x = c.getContext("2d", { willReadFrequently: true });
    if (!x) return 1;
    x.drawImage(img, 0, 0, N, N);
    const d = x.getImageData(0, 0, N, N).data;
    let sum = 0;
    for (let i = 0; i < N * N; i++) {
      // luminance for albedo, plain green channel for the data maps (three
      // samples roughness/metalness from .g)
      const v = srgb
        ? (srgbToLinear(d[i * 4] / 255) * 0.2126 +
           srgbToLinear(d[i * 4 + 1] / 255) * 0.7152 +
           srgbToLinear(d[i * 4 + 2] / 255) * 0.0722)
        : d[i * 4 + 1] / 255;
      sum += v;
    }
    const mean = sum / (N * N);
    // a black or unreadable image would make every consumer divide by ~0
    return mean > 0.004 ? mean : 1;
  } catch {
    // tainted canvas (asset served cross-origin) — neutral is always safe
    return 1;
  }
}

/** Load one map of a set. Missing files resolve to null rather than rejecting. */
function loadMap(
  loader: THREE.TextureLoader,
  url: string,
  srgb: boolean,
  repeat: THREE.Vector2,
  onMean?: (m: number) => void
): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    loader.load(
      url,
      (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.copy(repeat);
        t.anisotropy = 16;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        if (onMean && t.image) onMean(measureMean(t.image as CanvasImageSource, srgb));
        resolve(t);
      },
      undefined,
      () => resolve(null)
    );
  });
}

/**
 * Fetch a PBR set by directory name. Always resolves; an absent or partial
 * set comes back with nulls in the slots that failed, and `albedo === null`
 * is the caller's signal to stay on the procedural fallback.
 */
export async function loadPbrSet(
  name: string,
  repeat = new THREE.Vector2(1, 1),
  wantMetal = false,
  wantAlpha = false
): Promise<PbrSet> {
  const set: PbrSet = {
    albedo: null, normal: null, rough: null, metal: null, alpha: null,
    albedoMean: 1, roughMean: 1,
  };
  if (typeof document === "undefined") return set;
  const loader = new THREE.TextureLoader();
  const dir = `${PBR_BASE}/${name}`;
  const [albedo, normal, rough, metal, alpha] = await Promise.all([
    loadMap(loader, `${dir}/albedo.jpg`, true, repeat, (m) => (set.albedoMean = m)),
    loadMap(loader, `${dir}/normal.jpg`, false, repeat),
    loadMap(loader, `${dir}/rough.jpg`, false, repeat, (m) => (set.roughMean = m)),
    wantMetal ? loadMap(loader, `${dir}/metal.jpg`, false, repeat) : Promise.resolve(null),
    wantAlpha ? loadMap(loader, `${dir}/alpha.jpg`, false, repeat) : Promise.resolve(null),
  ]);
  // an orphaned normal/rough with no albedo is not a usable set; drop the lot
  // so a half-finished asset drop can never half-apply
  if (!albedo) {
    for (const t of [normal, rough, metal, alpha]) t?.dispose();
    return set;
  }
  set.albedo = albedo;
  set.normal = normal;
  set.rough = rough;
  set.metal = metal;
  set.alpha = alpha;
  return set;
}

export function asphalt(ctx: CanvasRenderingContext2D, w: number, h: number, base: string) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < (w * h) / 34; i++) {
    const v = randi(14, 44);
    ctx.fillStyle = `rgba(${v},${v},${v + 6},${rand(0.25, 0.7)})`;
    ctx.fillRect(rand(0, w), rand(0, h), rand(1, 2.6), rand(1, 2.6));
  }
  for (let i = 0; i < 7; i++) {
    ctx.strokeStyle = `rgba(8,9,12,${rand(0.2, 0.5)})`;
    ctx.lineWidth = rand(1, 3);
    ctx.beginPath();
    const y = rand(0, h);
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.3, y + rand(-14, 14), w * 0.6, y + rand(-14, 14), w, y + rand(-10, 10));
    ctx.stroke();
  }
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = `rgba(30,32,40,${rand(0.15, 0.35)})`;
    ctx.fillRect(rand(0, w), rand(0, h), rand(14, 40), rand(10, 26));
  }
  // soft patch repairs: large low-contrast blobs that break up the tile grid
  // when the same texture repeats down a long straight
  for (let i = 0; i < 5; i++) {
    const r = rand(w * 0.2, w * 0.55);
    const gx = rand(0, w), gy = rand(0, h);
    const inner = Math.random() < 0.5 ? "rgba(6,7,10,.22)" : "rgba(58,60,70,.14)";
    // repeat across the tile edges so the blob stays seamless when wrapped
    for (const ox of [-w, 0, w])
      for (const oy of [-h, 0, h]) {
        const x = gx + ox, y = gy + oy;
        if (x + r < 0 || x - r > w || y + r < 0 || y - r > h) continue;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, inner);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
  }
}

function paintLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y0: number,
  y1: number,
  dash: number[],
  col: string,
  lw: number
) {
  ctx.strokeStyle = col;
  ctx.lineWidth = lw;
  ctx.setLineDash(dash || []);
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Draw road paint on its own layer, chew the edges, then composite it down.
 *
 * Wear has to happen on an isolated layer: erasing straight into the road
 * canvas with destination-out would punch holes through the asphalt as well,
 * since both live in the same bitmap. Painting into a scratch canvas and
 * erasing there means the damage lands only on the markings, and the asphalt
 * shows through underneath exactly as a worn stripe does in life.
 *
 * All erase blobs are drawn at every tile offset so the wear pattern wraps
 * with the texture, the same trick the asphalt patch blobs use.
 */
function wornPaint(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  draw: (c: CanvasRenderingContext2D) => void,
  amount = 1
) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  if (!x) {
    draw(ctx); // no 2d context for the scratch layer — paint it clean
    return;
  }
  draw(x);
  x.globalCompositeOperation = "destination-out";
  const tile = (fn: (ox: number, oy: number) => void) => {
    for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) fn(ox, oy);
  };
  // broad polished patches: where tyres cross the line the paint thins out
  for (let i = 0; i < Math.round(9 * amount); i++) {
    const gx = rand(0, w), gy = rand(0, h), r = rand(h * 0.03, h * 0.11);
    const a = rand(0.25, 0.75);
    tile((ox, oy) => {
      const px = gx + ox, py = gy + oy;
      if (px + r < 0 || px - r > w || py + r < 0 || py - r > h) return;
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = g;
      x.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  // fine chipping: speckle that frays the stripe edges and keeps them from
  // reading as vector-crisp when the camera is right down on the surface
  for (let i = 0; i < Math.round((w * h) / 260 * amount); i++) {
    const gx = rand(0, w), gy = rand(0, h);
    const sw = rand(0.8, 2.4), sh = rand(0.8, 3.2);
    x.fillStyle = `rgba(0,0,0,${rand(0.3, 0.9)})`;
    tile((ox, oy) => x.fillRect(gx + ox, gy + oy, sw, sh));
  }
  x.globalCompositeOperation = "source-over";
  ctx.drawImage(c, 0, 0);
}

/** Town street: center dashed white + solid edge lines. v repeats along road length. */
export const roadTex = () =>
  makeTex(
    256,
    512,
    (ctx, w, h) => {
      asphalt(ctx, w, h, "#16181f");
      wornPaint(ctx, w, h, (p) => {
        paintLine(p, w * 0.5, 0, h, [26, 30], "rgba(228,230,238,.85)", 3.5);
        paintLine(p, w * 0.07, 0, h, [], "rgba(225,228,238,.75)", 3);
        paintLine(p, w * 0.93, 0, h, [], "rgba(225,228,238,.75)", 3);
      });
    },
    true
  );

/** 6-lane expressway with yellow median. */
export const hwyTexF = () =>
  makeTex(
    512,
    512,
    (ctx, w, h) => {
      asphalt(ctx, w, h, "#14161c");
      const lane = w / 8;
      wornPaint(ctx, w, h, (p) => {
        paintLine(p, w * 0.5 - 2, 0, h, [], "rgba(250,214,90,.9)", 3);
        paintLine(p, w * 0.5 + 2, 0, h, [], "rgba(250,214,90,.9)", 3);
        for (const s of [-1, 1])
          for (let k = 1; k < 3; k++)
            paintLine(p, w * 0.5 + s * lane * k, 0, h, [30, 34], "rgba(232,234,242,.8)", 3.2);
        for (const s of [-1, 1])
          paintLine(p, w * 0.5 + s * lane * 3.1, 0, h, [], "rgba(232,234,242,.85)", 3.6);
      });
    },
    true
  );

export const rampTexF = () =>
  makeTex(
    128,
    256,
    (ctx, w, h) => {
      asphalt(ctx, w, h, "#171920");
      wornPaint(ctx, w, h, (p) => {
        paintLine(p, w * 0.5, 0, h, [22, 26], "rgba(228,230,238,.85)", 4);
        paintLine(p, w * 0.08, 0, h, [], "rgba(120,235,170,.8)", 5);
        paintLine(p, w * 0.92, 0, h, [], "rgba(120,235,170,.8)", 5);
      }, 0.7);
    },
    true
  );

/**
 * Wear map for the expressway's GEOMETRY lane markings (highway.ts stripe()).
 *
 * The town streets get their wear from wornPaint() because their paint lives
 * inside the road texture; the expressway lays its markings down as quads over
 * bare asphalt, so at HEAD they were the one paint in the game still reading
 * as crisp vector lines. This map multiplies markMat's colour instead:
 * opaque by design — a chip "through" 22 mm of air is indistinguishable from
 * a chip painted in asphalt tone at any distance past arm's length, and
 * opacity would buy that nothing for a transparent-pass sort headache.
 *
 * Axes: u is ACROSS the stripe (0..1 over ~0.2 m — the frayed columns live at
 * the u edges), v runs down the road and tiles every PAINT_TILE_V metres
 * (see highway.ts). Wear features are therefore drawn elongated in v, the way
 * tyres actually scrub a line at highway crossing angles. Everything is
 * emitted at ±h offsets so the pattern wraps seamlessly in v.
 *
 * The mean stays near white on purpose: the stripe's retroreflective response
 * (addBeam) multiplies AFTER this map, so a dark mean would dim every marking
 * everywhere — the aim is holes in the paint, not dimmer paint.
 */
export const paintWearTexF = () =>
  makeTex(
    128,
    1024,
    (ctx, w, h) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      const wrapV = (fn: (oy: number) => void) => {
        for (const oy of [-h, 0, h]) fn(oy);
      };
      // broad thinned patches: tyre-polished stretches where the paint has
      // gone grey — soft, elongated, never a hard rim
      for (let i = 0; i < 16; i++) {
        const gx = rand(0, w), gy = rand(0, h);
        const rx = rand(w * 0.18, w * 0.5), ry = rand(60, 220);
        const v = randi(150, 205);
        wrapV((oy) => {
          const y = gy + oy;
          if (y + ry < 0 || y - ry > h) return;
          const g = ctx.createRadialGradient(gx, y, 0, gx, y, 1);
          g.addColorStop(0, `rgba(${v},${v},${v + 3},${rand(0.25, 0.5)})`);
          g.addColorStop(1, `rgba(${v},${v},${v + 3},0)`);
          ctx.fillStyle = g;
          ctx.save();
          ctx.translate(gx, y);
          ctx.scale(rx, ry);
          ctx.translate(-gx, -y);
          ctx.beginPath();
          ctx.arc(gx, y, 1, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        });
      }
      // fine chipping: flakes lost to the asphalt, elongated down the road
      for (let i = 0; i < 340; i++) {
        const gx = rand(2, w - 2), gy = rand(0, h);
        const cw = rand(1.5, 5), ch = rand(2, 12);
        const v = randi(55, 130);
        ctx.fillStyle = `rgba(${v},${v},${v + 4},${rand(0.35, 0.85)})`;
        wrapV((oy) => ctx.fillRect(gx, gy + oy, cw, ch));
      }
      // frayed edges: the stripe's border loses paint first. Ragged runs in
      // from both u edges, dense at the edge and dying out by ~10 px — the
      // taper is what keeps the line from reading as a narrower crisp line.
      for (let y = 0; y < h; y += 3) {
        for (const left of [true, false]) {
          const run = Math.max(0, rand(-3, 9));
          if (run < 0.5) continue;
          const v = randi(60, 120);
          ctx.fillStyle = `rgba(${v},${v},${v + 4},${rand(0.3, 0.7)})`;
          ctx.fillRect(left ? 0 : w - run, y, run, rand(2, 4));
        }
      }
    },
    true
  );

export const xingTexF = () =>
  makeTex(128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(226,229,238,.8)";
    const st = 9;
    for (let x = 8; x < w - 8; x += st * 2) ctx.fillRect(x, 12, st, h - 24);
  });

export function windowsTexF(warm: boolean) {
  return makeTex(
    128,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = "#07080d";
      ctx.fillRect(0, 0, w, h);
      for (let y = 6; y < h - 6; y += 13) {
        ctx.fillStyle = "rgba(0,0,0,.55)";
        ctx.fillRect(0, y + 9, w, 2);
        for (let x = 5; x < w - 5; x += 11) {
          ctx.fillStyle = "#0b0c12";
          ctx.fillRect(x, y, 8, 9);
          if (Math.random() < 0.42) {
            const g = Math.random();
            const col = warm
              ? `${randi(200, 255)},${randi(150, 205)},${randi(80, 130)}`
              : `${randi(120, 190)},${randi(170, 225)},${randi(215, 255)}`;
            const gr = ctx.createLinearGradient(0, y, 0, y + 9);
            gr.addColorStop(0, `rgba(${col},${0.5 + g * 0.5})`);
            gr.addColorStop(1, `rgba(${col},${0.12 + g * 0.3})`);
            ctx.fillStyle = gr;
            ctx.fillRect(x + 1, y + 1, 6, 7);
            if (Math.random() < 0.3) {
              ctx.fillStyle = "rgba(0,0,0,.5)";
              ctx.fillRect(x + 1, y + 1, 3, 7);
            }
          }
        }
      }
      const base = ctx.createLinearGradient(0, h - 30, 0, h);
      base.addColorStop(0, "rgba(0,0,0,0)");
      base.addColorStop(1, "rgba(0,0,0,.65)");
      ctx.fillStyle = base;
      ctx.fillRect(0, h - 30, w, 30);
    },
    true
  );
}

export const storefrontTexF = () =>
  makeTex(
    512,
    64,
    (ctx, w, h) => {
      ctx.fillStyle = "#0a0b12";
      ctx.fillRect(0, 0, w, h);
      let x = 0;
      const hues = [350, 28, 190, 140, 265, 50, 210];
      while (x < w) {
        const sw = randi(40, 86),
          hue = pick(hues),
          lit = Math.random() < 0.82;
        if (lit) {
          const g = ctx.createLinearGradient(0, 6, 0, h);
          g.addColorStop(0, `hsla(${hue},90%,68%,.95)`);
          g.addColorStop(0.35, `hsla(${hue},75%,55%,.5)`);
          g.addColorStop(1, `hsla(${hue},60%,30%,.12)`);
          ctx.fillStyle = g;
          ctx.fillRect(x + 3, 4, sw - 6, h - 8);
          ctx.fillStyle = "rgba(255,255,255,.9)";
          ctx.fillRect(x + 7, 8, sw - 14, 5);
          ctx.fillStyle = "rgba(10,10,16,.85)";
          for (let i = 0; i < 3; i++) ctx.fillRect(x + 8 + (i * (sw - 16)) / 3, 16, 2, h - 22);
        } else {
          ctx.fillStyle = "#111219";
          ctx.fillRect(x + 3, 4, sw - 6, h - 8);
        }
        x += sw;
      }
    },
    true
  );

export const vendingTexF = () =>
  makeTex(64, 96, (ctx, w, h) => {
    ctx.fillStyle = "#0d0f16";
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    const hue = pick([355, 205, 150, 35]);
    g.addColorStop(0, `hsla(${hue},85%,66%,1)`);
    g.addColorStop(1, `hsla(${hue},80%,42%,1)`);
    ctx.fillStyle = g;
    ctx.fillRect(4, 4, w - 8, h * 0.55);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 4; c++) ctx.fillRect(8 + c * 14, 10 + r * 18, 10, 12);
    ctx.fillStyle = "rgba(240,244,255,.25)";
    ctx.fillRect(4, h * 0.62, w - 8, h * 0.3);
  });

export const glowTexF = () =>
  makeTex(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });

/**
 * Retroreflective raised pavement marker ("cat's eye") seen head-on.
 *
 * Deliberately not the same as glowTex: a stud is not a lamp. It has a hard
 * little lens core that stays a distinct point right up until it passes under
 * the bumper, wrapped in only a slight bloom — the tight core is what makes a
 * line of them read as a receding row of markers rather than a smear of
 * headlight haze. The faint horizontal bar is the lens cluster catching the
 * beam, which is what your eye actually picks up at speed.
 */
export const studTexF = () =>
  makeTex(64, 64, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const halo = ctx.createRadialGradient(cx, cy, 1, cx, cy, 30);
    halo.addColorStop(0, "rgba(255,255,255,.95)");
    halo.addColorStop(0.18, "rgba(255,252,240,.55)");
    halo.addColorStop(0.55, "rgba(255,244,215,.14)");
    halo.addColorStop(1, "rgba(255,240,205,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);
    // lens cluster: a short bright bar, brighter than the halo it sits in
    const bar = ctx.createLinearGradient(cx - 11, 0, cx + 11, 0);
    bar.addColorStop(0, "rgba(255,255,255,0)");
    bar.addColorStop(0.5, "rgba(255,255,255,.9)");
    bar.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = bar;
    ctx.fillRect(cx - 11, cy - 2, 22, 4);
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.beginPath();
    ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
    ctx.fill();
  });

export const streakTexF = () =>
  makeTex(8, 64, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,.85)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(2, 0, 4, h);
  });

export const smokeTexF = () =>
  makeTex(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    g.addColorStop(0, "rgba(200,200,210,.85)");
    g.addColorStop(0.5, "rgba(160,160,175,.35)");
    g.addColorStop(1, "rgba(140,140,155,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });

export function neonTexF(word: string, hue: number) {
  return makeTex(512, 168, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = '700 104px "Hiragino Sans","Yu Gothic",sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = `hsla(${hue},100%,62%,1)`;
    ctx.shadowBlur = 34;
    ctx.fillStyle = `hsla(${hue},100%,78%,1)`;
    ctx.fillText(word, w / 2, h / 2 + 6);
    ctx.shadowBlur = 10;
    ctx.fillStyle = "rgba(255,255,255,.95)";
    ctx.fillText(word, w / 2, h / 2 + 6);
  });
}

/** Green expressway guide sign, two lines. */
export function signTexF(l1: string, l2: string) {
  return makeTex(
    256,
    96,
    (ctx, w, h) => {
      ctx.fillStyle = "#0b5c2e";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#e9f4ee";
      ctx.lineWidth = 4;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.fillStyle = "#f4faf6";
      ctx.textAlign = "center";
      ctx.font = "700 28px sans-serif";
      ctx.fillText(l1, w / 2, 40);
      ctx.font = "700 24px sans-serif";
      ctx.fillText(l2, w / 2, 76);
    },
    true
  );
}

/** Large exit sign with lane-drop arrow — extra legible from distance. */
export function exitSignTexF(exitNo: number, dist: string, jp: string) {
  return makeTex(512, 192, (ctx, w, h) => {
    ctx.fillStyle = "#0b5c2e";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#e9f4ee";
    ctx.lineWidth = 7;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    // exit number tab
    ctx.fillStyle = "#f2cf3a";
    ctx.fillRect(18, 18, 118, 52);
    ctx.fillStyle = "#131303";
    ctx.font = "800 36px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("EXIT " + exitNo, 77, 56);
    ctx.fillStyle = "#f4faf6";
    ctx.font = '700 44px "Hiragino Sans",sans-serif';
    ctx.fillText(jp + " 出口", w / 2 + 60, 60);
    ctx.font = "800 54px sans-serif";
    ctx.fillText(dist, w / 2 - 60, 140);
    // arrow
    ctx.strokeStyle = "#f4faf6";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(w / 2 + 90, 100);
    ctx.lineTo(w / 2 + 90, 150);
    ctx.lineTo(w / 2 + 130, 165);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w / 2 + 138, 168);
    ctx.lineTo(w / 2 + 100, 168);
    ctx.moveTo(w / 2 + 138, 168);
    ctx.lineTo(w / 2 + 124, 138);
    ctx.stroke();
  });
}

/** Procedural perforated-steel panel: opaque sheet with a punched hole grid.
    Fallback for the Fence007A photo scan — the canvas carries its own alpha,
    so an alphaTest material works identically whether or not the scan lands
    (the scan splits the same information across albedo.jpg + alpha.jpg). */
export function fenceTexF(kind: "perf" | "grate" = "perf") {
  const t = makeTex(128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#4b5058";
    ctx.fillRect(0, 0, w, h);
    // subtle rolled-sheet shading so the fallback doesn't read dead flat
    for (let i = 0; i < 40; i++) {
      const v = randi(60, 96);
      ctx.fillStyle = `rgba(${v},${v + 4},${v + 10},${rand(0.08, 0.2)})`;
      ctx.fillRect(rand(0, w), rand(0, h), rand(2, 9), rand(2, 9));
    }
    ctx.globalCompositeOperation = "destination-out";
    if (kind === "perf") {
      const P = 16, R = 5.2;
      for (let y = P / 2; y < h; y += P)
        for (let x = P / 2; x < w; x += P) {
          ctx.beginPath();
          ctx.arc(x, y, R, 0, Math.PI * 2);
          ctx.fill();
        }
    } else {
      // grate: long open slots between bearing bars
      for (let y = 4; y < h; y += 16) ctx.fillRect(0, y, w, 9);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#3a3e46";
      for (let x = 0; x < w; x += 32) ctx.fillRect(x, 0, 4, h);
    }
    ctx.globalCompositeOperation = "source-over";
  }, true);
  return t;
}

/* ------------------------------------------------------------------ *
 * Weathering masks
 * ------------------------------------------------------------------ */

/** 32-bit integer hash. Math.imul, not `*`: the products overflow 2^53 and
    plain multiplication would quietly lose the low bits the hash lives in. */
function ihash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise on a WRAPPED lattice — `cells` cells across the unit square,
    with the lattice indices taken modulo `cells`, which is what makes every
    octave (and so the finished texture) tile seamlessly under RepeatWrapping.
    A non-wrapped noise would print a hard seam every repeat, which is the
    exact artifact these masks exist to hide. */
function vnoise(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells, y = v * cells;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const m = (n: number) => ((n % cells) + cells) % cells;
  const xa = m(x0), xb = m(x0 + 1), ya = m(y0), yb = m(y0 + 1);
  const a = ihash(xa, ya, seed), b = ihash(xb, ya, seed);
  const c = ihash(xa, yb, seed), d = ihash(xb, yb, seed);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}

/** Summed octaves, normalised back to a 0..1 range with a ~0.5 mean. */
function fbm(u: number, v: number, cells: number, oct: number, seed: number): number {
  let sum = 0, amp = 1, norm = 0, c = cells;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(u, v, c, seed + i * 977);
    norm += amp;
    amp *= 0.5;
    c *= 2;
  }
  return sum / norm;
}

/**
 * Weathering mask atlas for concrete and roadside steel — three independent
 * seamless noise fields packed into one RGB texture. Sampled by
 * `weatherSurface()` in world/mats.ts at two very different world scales:
 *
 *   R — large-scale tonal drift, the patchy unevenness of a cast surface.
 *       This is what stops two 20 m stretches of parapet being identical.
 *   G — mid-scale field, sampled with its v axis stretched ~8x so the round
 *       blobs become the vertical rain-wash runs every real parapet carries
 *       below its coping. Biased bright (`pow < 1`) so the wall is mostly
 *       clean with narrow dirty runs, not uniformly grubby.
 *   B — fine grain, one frequency above anything the photo scan tiles at, so
 *       it dithers the scan's own repeat rather than reinforcing it.
 *
 * These are DATA maps, not colour: left untagged (linear) like the rest of
 * the canvas art, and read as raw masks by the shader.
 *
 * Size: 256x256 RGBA8 = 256 KB, ~340 KB with the mip chain, uploaded ONCE and
 * shared by every concrete and steel material in the world. Bigger buys
 * nothing measurable — the coarsest channel is stretched over ~11 m of wall
 * (4.4 cm/texel) and the finest over ~2.9 m (1.1 cm/texel), both already
 * finer than the dashcam's own blur resolves at the distance a barrier is
 * seen from.
 */
export const grimeTexF = () =>
  makeTex(256, 256, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const i = (y * w + x) * 4;
        // 3 cells over the tile: at the 11.3 m macro scale that is a blotch
        // every ~3.8 m, the size real form-work and cure variation comes in
        const mac = fbm(u, v, 3, 5, 11);
        // 6 cells at the 2.9 m streak scale ≈ 0.5 m between runs before the
        // shader's 8:1 v stretch turns them into full-height streaks
        const str = Math.pow(fbm(u, v, 6, 4, 3701), 0.62);
        const fine = fbm(u, v, 24, 3, 88011);
        d[i] = Math.round(255 * Math.min(1, Math.max(0, (mac - 0.5) * 1.45 + 0.5)));
        d[i + 1] = Math.round(255 * str);
        d[i + 2] = Math.round(255 * fine);
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, true);

/** Elongated road-surface word. Characters are stacked along the direction of
    travel and stretched ~2.6:1, the way real Japanese expressway paint is laid
    out so it reads correctly at a flat viewing angle. char[0] sits nearest the
    driver (canvas bottom): the quad from flatQuad() maps canvas-up to
    down-the-road, so the driver meets the characters in reading order. */
export function roadWordTexF(word: string, color = "rgba(235,240,248,.92)") {
  const chars = [...word];
  const CW = 112, CH = 232;
  return makeTex(128, CH * chars.length, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    chars.forEach((c, i) => {
      const cy = h - (i + 0.5) * CH; // first char at the bottom
      ctx.save();
      ctx.translate(w / 2, cy);
      // stretch the glyph vertically; latin glyphs get a slightly narrower face
      const latin = /[\x20-\x7e]/.test(c);
      ctx.scale(latin ? 1.0 : 0.92, 2.35);
      ctx.font = `700 ${latin ? 92 : 84}px "Hiragino Sans","Yu Gothic",sans-serif`;
      ctx.fillText(c, 0, 0);
      ctx.restore();
    });
  });
}

export const chevTexF = () =>
  makeTex(
    256,
    96,
    (ctx, w, h) => {
      ctx.fillStyle = "#141403";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#0a0a06";
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, w - 6, h - 6);
      ctx.strokeStyle = "#ffce1e";
      ctx.lineWidth = 14;
      ctx.lineCap = "round";
      for (let i = 0; i < 3; i++) {
        const x = 52 + i * 72;
        ctx.beginPath();
        ctx.moveTo(x + 26, 16);
        ctx.lineTo(x - 14, 48);
        ctx.lineTo(x + 26, 80);
        ctx.stroke();
      }
    },
    true
  );

export const warnTexF = (l1: string, l2: string) =>
  makeTex(
    256,
    96,
    (ctx, w, h) => {
      ctx.fillStyle = "#c98f10";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#241a04";
      ctx.lineWidth = 5;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.fillStyle = "#1b1404";
      ctx.textAlign = "center";
      ctx.font = "700 26px sans-serif";
      ctx.fillText(l1, w / 2, 38);
      ctx.font = "700 24px sans-serif";
      ctx.fillText(l2, w / 2, 74);
    },
    true
  );

export const goreTexF = () =>
  makeTex(
    128,
    128,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(240,244,250,.95)";
      ctx.lineWidth = 11;
      for (let i = 0; i < 4; i++) {
        const y = 16 + i * 28;
        ctx.beginPath();
        ctx.moveTo(12, y);
        ctx.lineTo(w / 2, y + 18);
        ctx.lineTo(w - 12, y);
        ctx.stroke();
      }
    },
    true
  );

export const skylineTexF = () =>
  makeTex(
    1024,
    128,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      let x = 0;
      while (x < w) {
        const bw = randi(14, 46),
          bh = randi(28, 110);
        ctx.fillStyle = "rgba(8,10,18,.97)";
        ctx.fillRect(x, h - bh, bw, bh);
        for (let wy = h - bh + 3; wy < h - 4; wy += 5)
          for (let wx = x + 2; wx < x + bw - 2; wx += 4)
            if (Math.random() < 0.35) {
              ctx.fillStyle =
                Math.random() < 0.7 ? "rgba(255,190,110,.85)" : "rgba(150,200,255,.85)";
              ctx.fillRect(wx, wy, 2, 2);
            }
        if (bh > 90 && Math.random() < 0.3) {
          ctx.fillStyle = "rgba(255,60,60,.95)";
          ctx.fillRect(x + bw / 2, h - bh - 3, 2, 3);
        }
        x += bw + randi(0, 3);
      }
    },
    true
  );

export function envFaceCanvas(top?: boolean) {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, 16);
  if (top) {
    g.addColorStop(0, "#2a3560");
    g.addColorStop(1, "#0c1020");
  } else {
    g.addColorStop(0, "#151a30");
    g.addColorStop(1, "#05060c");
  }
  x.fillStyle = g;
  x.fillRect(0, 0, 16, 16);
  return c;
}

export function skyCanvas(dayF: number) {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 256;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, 256);
  const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  /* Dusk pull. A straight night→day lerp passes through its muddiest greys
     exactly at sunset, which is the one frame of the eight-step cache people
     actually stare at — so the mid frames detour through a third, saturated
     colour instead. sin(π·dayF) is zero at both ends: full night and high
     noon stay bit-identical to the old gradient, only the crossfade warms. */
  const dusk = Math.sin(Math.PI * dayF);
  function stop(a: string, b: string, d: string, k: number) {
    const A = ch(a), B = ch(b), D = ch(d);
    const v = A.map((va, i) => {
      const m = va + (B[i] - va) * dayF;
      return (m + (D[i] - m) * dusk * k) | 0;
    });
    return `rgb(${v[0]},${v[1]},${v[2]})`;
  }
  // dusk targets run violet at the zenith down to hot orange at the horizon —
  // the same low-drama-high-colour shape the cloud deck's sun rim has, so the
  // dome and the deck read as one sunset rather than two effects
  g.addColorStop(0, stop("#04050e", "#77aef0", "#241636", 0.3));
  g.addColorStop(0.45, stop("#0a0f26", "#a8c8ec", "#58306a", 0.3));
  g.addColorStop(0.72, stop("#231a3a", "#e8c9a8", "#e86a3c", 0.45));
  g.addColorStop(1, stop("#3a2033", "#f2d9b4", "#ff8f4a", 0.5));
  x.fillStyle = g;
  x.fillRect(0, 0, 8, 256);
  return c;
}

/** Metallic paint fleck texture for car bodies. */
export const paintTexF = () =>
  makeTex(
    128,
    128,
    (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#c9d3e6");
      g.addColorStop(0.45, "#f4f7fd");
      g.addColorStop(1, "#a8b4cd");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.09})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
      }
    },
    true
  );

export const carbonTexF = () => {
  const t = makeTex(
    64,
    64,
    (ctx) => {
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          ctx.fillStyle = (x + y) % 2 ? "#101318" : "#1b1f27";
          ctx.fillRect(x * 8, y * 8, 8, 8);
          ctx.fillStyle = "rgba(255,255,255,.07)";
          ctx.fillRect(x * 8, y * 8, 8, 3);
        }
    },
    true
  );
  t.repeat.set(5, 5);
  return t;
};
