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

/** Town street: center dashed white + solid edge lines. v repeats along road length. */
export const roadTex = () =>
  makeTex(
    256,
    512,
    (ctx, w, h) => {
      asphalt(ctx, w, h, "#16181f");
      paintLine(ctx, w * 0.5, 0, h, [26, 30], "rgba(228,230,238,.85)", 3.5);
      paintLine(ctx, w * 0.07, 0, h, [], "rgba(225,228,238,.75)", 3);
      paintLine(ctx, w * 0.93, 0, h, [], "rgba(225,228,238,.75)", 3);
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
      paintLine(ctx, w * 0.5 - 2, 0, h, [], "rgba(250,214,90,.9)", 3);
      paintLine(ctx, w * 0.5 + 2, 0, h, [], "rgba(250,214,90,.9)", 3);
      for (const s of [-1, 1])
        for (let k = 1; k < 3; k++)
          paintLine(ctx, w * 0.5 + s * lane * k, 0, h, [30, 34], "rgba(232,234,242,.8)", 3.2);
      for (const s of [-1, 1])
        paintLine(ctx, w * 0.5 + s * lane * 3.1, 0, h, [], "rgba(232,234,242,.85)", 3.6);
    },
    true
  );

export const rampTexF = () =>
  makeTex(
    128,
    256,
    (ctx, w, h) => {
      asphalt(ctx, w, h, "#171920");
      paintLine(ctx, w * 0.5, 0, h, [22, 26], "rgba(228,230,238,.85)", 4);
      paintLine(ctx, w * 0.08, 0, h, [], "rgba(120,235,170,.8)", 5);
      paintLine(ctx, w * 0.92, 0, h, [], "rgba(120,235,170,.8)", 5);
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
  function mix(a: string, b: string, t: number) {
    const pa = parseInt(a.slice(1), 16),
      pb = parseInt(b.slice(1), 16);
    const r = (pa >> 16) + (((pb >> 16) - (pa >> 16)) * t),
      gg = ((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t),
      bl = (pa & 255) + (((pb & 255) - (pa & 255)) * t);
    return `rgb(${r | 0},${gg | 0},${bl | 0})`;
  }
  g.addColorStop(0, mix("#04050e", "#77aef0", dayF));
  g.addColorStop(0.45, mix("#0a0f26", "#a8c8ec", dayF));
  g.addColorStop(0.72, mix("#231a3a", "#e8c9a8", dayF));
  g.addColorStop(1, mix("#3a2033", "#f2d9b4", dayF));
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
