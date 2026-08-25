import * as THREE from "three";
import { clamp, mulberry32, rrand, rrandi, TAU, type Rng } from "../util";
import { worldTierCaps } from "../settings";

/* Procedural aurora curtains, drawn straight onto the sky.
 *
 * Zero assets: the whole thing is one shader over a band of sphere, so it
 * costs nothing to download and nothing to build. Everything that gives a
 * given night its character — where the curtains hang, how wide, how bright,
 * which way the palette runs — is rolled from a seed, out of ranges narrow
 * enough that there is no bad roll.
 *
 * IT IS SUPPOSED TO BE OBVIOUS. The first cut of this was tuned for physical
 * plausibility and the answer that came back was "i dont see no aurora". The
 * levels here are now set for drama: peak radiance lands around 0.36 linear,
 * roughly 0.65 display luma, which is bright and unmissable while still
 * sitting under the ~0.8 where the grade starts eating hue. Soft is a rule,
 * faint never was.
 *
 * WHY IT IS AN "OPAQUE" MATERIAL. `transparent` is left false on purpose. It
 * still blends additively (three only skips blending for NormalBlending), but
 * the false flag keeps the mesh in the OPAQUE render list, where renderOrder
 * -9.6 puts it immediately after the sky dome (-10) and before every piece of
 * real geometry. That is the only ordering that occludes correctly here: the
 * mountains and the town write depth, so they paint over the curtains no
 * matter how far the car has driven from them — whereas a transparent mesh
 * would render after the opaque pass and have to fight a depth test against
 * a ridgeline that is world-fixed while this dome is glued to the car.
 *
 * FALLOFF (see the realistic-light skill). Every envelope here reaches exactly
 * zero with a zero derivative — (1-u²)^2.5 across the curtain, (1-v)^1.25 up
 * it — so nothing prints an edge. Overlapping curtains go through a
 * hue-preserving soft knee that asymptotes near 0.55 linear, so a crossing
 * gets brighter but can never bleach to a white core. The POV chain's black
 * crush (col-.06) lands at well under 1% of peak once the composite's 1/2.2
 * encode has stretched the tail, i.e. far below anything visible — the fade
 * dies of old age, not of a cutoff. And because the curtains are strongly
 * saturated, the POV sky pulldown (which gates on low saturation) leaves them
 * alone while it goes on crushing the grey haze around them.
 *
 * LIVE PREVIEW. window.__aurora exposes { roll, gain, reroll, next, lock } —
 * see the block comment on the returned object.
 */

/** Master kill-switch. */
export const FX_AURORA = true;

/** Curated hue pairs: body colour → crown colour.
 *
 *  `lo` is what the dashcam actually sees (the frame tops out around 23° of
 *  elevation, which is the lower half of a curtain), so the body carries the
 *  whole impression and the crown is the accent above it. Weights lean toward
 *  the magenta/violet/crimson end because that is the drama the references
 *  were made of; the greens are still here, they are just not the default. */
const PALETTES: { name: string; w: number; lo: number[]; hi: number[] }[] = [
  { name: "classic", w: 2, lo: [0.16, 0.95, 0.46], hi: [0.95, 0.20, 0.34] }, // green → crimson
  { name: "ember", w: 2, lo: [0.95, 0.30, 0.72], hi: [0.52, 0.34, 0.98] },   // magenta → violet
  { name: "violet", w: 2, lo: [0.72, 0.44, 0.98], hi: [0.94, 0.30, 0.80] },  // lavender → magenta
  { name: "arctic", w: 1, lo: [0.16, 0.86, 0.82], hi: [0.34, 0.42, 0.98] },  // teal → indigo
  { name: "jade", w: 1, lo: [0.26, 0.95, 0.60], hi: [0.30, 0.76, 0.98] },    // spring → cyan
  { name: "solar", w: 1, lo: [0.50, 0.95, 0.32], hi: [0.98, 0.42, 0.24] },   // lime → coral
];

export interface AuroraRoll {
  seed: number;
  palette: string;
  bands: number;
  /** per band, for eyeballing from the console */
  detail: { azDeg: number; widthDeg: number; baseDeg: number; amp: number }[];
}

export interface Aurora {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** the sky currently on screen */
  roll: AuroraRoll;
  /** this session's palette, body and crown. The cloud deck tints itself from
      these so the two layers read as one sky rather than two effects. */
  palLo: THREE.Vector3;
  palHi: THREE.Vector3;
  /** set by sky.ts: fires whenever a reroll changes the palette */
  onPalette?: (lo: THREE.Vector3, hi: THREE.Vector3) => void;
  /** live brightness multiplier, 1 = as shipped. Read every frame. */
  gain: number;
  /** swap in a different sky immediately; omit the seed for a random one */
  reroll(seed?: number): AuroraRoll;
  /** step to the next seed in sequence — for flicking through rolls */
  next(): AuroraRoll;
  /** print how to pin the sky currently on screen */
  lock(): string;
  /** driven from engine.weather(): monotonic seconds, dayFactor, fog multiplier */
  update(now: number, dayF: number, fogMul: number): void;
}

const v3 = (c: number[]) => new THREE.Vector3(c[0], c[1], c[2]);

/** Small per-band hue jitter that CANNOT wash a colour out: the channels move
 *  a little, then the whole triple is rescaled so its brightest channel is 1
 *  again. Nudging RGB without that rescale walks every colour toward grey,
 *  which is the one direction none of these are allowed to go. */
function jitterHue(rng: Rng, c: THREE.Vector3): THREE.Vector3 {
  const k = c.clone();
  k.x = clamp(k.x + rrand(rng, -0.07, 0.07), 0.02, 1);
  k.y = clamp(k.y + rrand(rng, -0.06, 0.06), 0.02, 1);
  k.z = clamp(k.z + rrand(rng, -0.08, 0.08), 0.02, 1);
  return k.multiplyScalar(1 / Math.max(k.x, k.y, k.z));
}

/** Session seed. A fresh aurora every run is the point, so this does NOT ride
 *  the world seed (which has to reproduce the same town). `?aurora=<n>` pins
 *  it when a particular sky is worth looking at twice. */
function sessionSeed(): number {
  try {
    if (typeof location !== "undefined") {
      const q = new URLSearchParams(location.search).get("aurora");
      if (q !== null && q !== "" && Number.isFinite(+q)) return Math.floor(+q) >>> 0;
    }
  } catch {
    /* malformed URL — fall through to a random night */
  }
  return (Math.random() * 0xffffffff) >>> 0;
}

export function buildAurora(seedIn?: number): Aurora {
  const caps = worldTierCaps();

  /* Band count is FIXED per tier, not rolled. It is what guarantees coverage:
     the widths below are derived from the spacing, so N evenly spaced bands
     always overlap and the whole compass is lit. Leaving the count (and so
     the spacing) to chance is how the first cut ended up with skies whose
     only good curtain was behind the car — and the dashcam only ever looks
     forward, through about 105° of it. A sky that reads only if you happen to
     be pointed at it is a sky that mostly does not read.

     Because the count is fixed, it is also safe to bake into the shader as a
     #define, which is what lets reroll() swap the whole sky by writing
     uniforms — no recompile, no hitch, live from the console. */
  const NB = caps.tier === "mobile-base" ? 2 : caps.tier === "mobile-high" ? 3 : 4;

  const sessionLo = new THREE.Vector3(), sessionHi = new THREE.Vector3();
  const bandA: THREE.Vector4[] = [];
  const bandB: THREE.Vector4[] = [];
  const colLo: THREE.Vector3[] = [];
  const colHi: THREE.Vector3[] = [];
  for (let i = 0; i < NB; i++) {
    bandA.push(new THREE.Vector4());
    bandB.push(new THREE.Vector4());
    colLo.push(new THREE.Vector3());
    colHi.push(new THREE.Vector3());
  }

  /** Fill the uniform arrays from a seed. Mutates in place so the material
   *  never has to be rebuilt. */
  function applyRoll(seed: number): AuroraRoll {
    const rng: Rng = mulberry32(seed);
    // weighted palette draw — magenta/violet/crimson carry the extra weight
    const total = PALETTES.reduce((a, p) => a + p.w, 0);
    let pick = rng() * total;
    let pal = PALETTES[0];
    for (const p of PALETTES) {
      pick -= p.w;
      if (pick <= 0) { pal = p; break; }
    }
    const palLo = v3(pal.lo), palHi = v3(pal.hi);
    sessionLo.copy(palLo);
    sessionHi.copy(palHi);

    /* One or two curtains carry the composition and the rest support them.
       Equal-brightness bands read as wallpaper; a clear hero reads as
       weather. Support bands are still bright enough to see on their own —
       "support" here means half the hero, not invisible. */
    const heroes = rrandi(rng, 1, Math.min(2, NB));
    const heroAt = rrandi(rng, 0, NB - 1);
    const rot = rrand(rng, 0, TAU);
    const detail: AuroraRoll["detail"] = [];

    for (let i = 0; i < NB; i++) {
      const az = rot + (i / NB) * TAU + rrand(rng, -0.28, 0.28);
      /* Half-width is derived from the spacing, never drawn free, so there is
         no direction with no aurora in it. Pulled back from 0.62–0.95 of the
         gap: that much overlap had every band summing with its neighbours
         everywhere, and the sum of several soft envelopes is a smooth wash —
         the structure was being averaged away between the bands, not inside
         them. They still overlap, just at the tails. */
      const halfW = (TAU / NB) * rrand(rng, 0.55, 0.80);
      /* SIZED TO THE DASHCAM'S SKY WINDOW, which is small and low.
         POV_HFOV 105° at 16:9 gives a 72.5° vertical frame; POV_TILT cants it
         13° nose-down, so the top edge sits at 36.24 - 13.0 = 23.2° of
         elevation and everything below the horizon is road. (Caveat worth
         knowing: engine.ts sets camera.rotation.y then .x under three's
         default XYZ Euler order, which applies pitch about the WORLD x axis —
         so the 13° is a true nose-down cant only when the camera's yaw is
         near 0. Half a lap later the same numbers pitch the frame 13° UP and
         the window becomes 0…49°. These ranges are chosen to read across the
         union of the two.)

         A curtain therefore has to be SHORT. The first cut spanned 2°…68°,
         of which only the bottom third was ever on screen — the player got
         the dim monochrome foot of an aurora and none of the structure. The
         whole thing now lives inside roughly 3°…30°: foot, body, colour
         crossover and crown all fit in the window. The top fade reaches zero
         with zero derivative, so a curtain that ends inside the frame still
         dissolves rather than printing a stripe. */
      const baseY = rrand(rng, 0.05, 0.10);
      const hgt = rrand(rng, 0.32, 0.48);
      const isHero = ((i - heroAt) % NB + NB) % NB < heroes;
      const amp = isHero ? rrand(rng, 0.55, 0.78) : rrand(rng, 0.30, 0.46);
      bandA[i].set(az, halfW, baseY, hgt);
      bandB[i].set(amp, rrand(rng, 0.6, 1.4), rrand(rng, 0, 40), rrand(rng, 16, 28));
      /* Every band in a session shares one palette and only jitters around it.
         That is what keeps a sky harmonious: three independently drawn hues
         eventually roll green next to orange next to blue. */
      colLo[i].copy(jitterHue(rng, palLo));
      colHi[i].copy(jitterHue(rng, palHi));
      detail.push({
        azDeg: Math.round((((az % TAU) + TAU) % TAU) * (180 / Math.PI)),
        widthDeg: Math.round(halfW * 2 * (180 / Math.PI)),
        baseDeg: Math.round(Math.asin(baseY) * (180 / Math.PI)),
        amp: +amp.toFixed(3),
      });
    }
    return { seed, palette: pal.name, bands: NB, detail };
  }

  /* Geometry: the slice of sphere the curtains can occupy, so the fragment
     shader never runs on sky that has no aurora in it. dir.y from -0.06 (a
     shade under the horizon, so the bottom fade has somewhere to die) up to a
     closed cap at the zenith, which cannot seam. Radius sits inside the 2800
     sky dome; with depthTest off it is only ever a direction. */
  const yBot = -0.06;
  const geo = new THREE.SphereGeometry(2600, 64, 22, 0, TAU, 0, Math.acos(yBot));

  const mat = new THREE.ShaderMaterial({
    defines: { NB, LOWQ: caps.tier === "mobile-base" ? 1 : 0 },
    uniforms: {
      uTime: { value: 0 },
      uAmt: { value: 1 },
      uBandA: { value: bandA },
      uBandB: { value: bandB },
      uColLo: { value: colLo },
      uColHi: { value: colHi },
    },
    vertexShader: `varying vec3 vDir;
void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `precision highp float;
varying vec3 vDir;
uniform float uTime,uAmt;
uniform vec4 uBandA[NB],uBandB[NB];
uniform vec3 uColLo[NB],uColHi[NB];

// sin-free hash: this runs over a large slab of the frame, and the classic
// fract(sin(...)) version costs a transcendental per corner per octave
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
 return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float s=vn(p)*.52; p*=2.03; s+=vn(p)*.30;
#if LOWQ == 0
 p*=2.07; s+=vn(p)*.16;
#endif
 return s; }

void main(){
 // daylight costs one coherent branch and nothing else
 if(uAmt<=.002){ gl_FragColor=vec4(0.,0.,0.,1.); return; }
 vec3 d=normalize(vDir);
 float ey=d.y, az=atan(d.z,d.x);
 vec3 acc=vec3(0.);
 for(int i=0;i<NB;i++){
  vec4 A=uBandA[i],B=uBandB[i];
  // signed shortest angle to the curtain's centre, wrapped
  float da=az-A.x; da-=6.2831853*floor(da/6.2831853+.5);
  float u=da/A.y;                       // -1 … 1 across the curtain
  // (1-u^2)^2.5 : flat through the middle, zero WITH zero slope at both
  // edges, so the curtain has no side you can point at
  float t=uTime*B.y;
  /* One fbm does two jobs. It snakes the curtain's lower hem, AND it warps
     the curtain sideways as it climbs — the DOMAIN WARP is what folds a flat
     band into something with depth in it. Without this the silhouette is a
     smooth arc and no amount of detail inside it stops the whole thing
     reading as a gradient. */
  float n0=fbm(vec2(u*1.9+B.z+t*.03,t*.019));
  float sway=(n0-.5)*A.w*.36;
  float uw=u+(n0-.5)*.30;
  // (1-u^2)^2.5 : flat through the middle, zero WITH zero slope at both
  // edges, so the curtain has no side you can point at
  float q=max(0.,1.-uw*uw); float env=q*q*sqrt(q);
  /* A NARROW structureless skirt. This used to be wide and heavily weighted,
     and it was the single biggest reason the sky read as a cheap gradient:
     a smooth featureless wash laid over everything, filling the gaps the
     structure was supposed to leave. It is airglow now, not the main event. */
  float qw=max(0.,1.-uw*uw*.55); float skirt=qw*qw;
  float v=(ey-(A.z+sway))/A.w;          // 0 at the border, 1 at the top
  /* A DEFINED lower hem, then a slow decelerating fade that still reaches
     exactly zero at the top. The crisp hem is the most recognisable thing
     about a real curtain and the rise was twice as soft as it should be —
     but it is still a smoothstep, ramping over ~2.3° of elevation (about 17
     px at 540p), so it reads as a hem and never as a line. */
  float vp=smoothstep(0.,.10,v)*pow(max(0.,1.-v),1.25);
  /* RIDGED filaments, not smooth noise. 1-|2n-1| turns a blurry hill into a
     sharp crest with dark lanes either side, which is the whole difference
     between "rays" and "a gradient with some wobble in it". Two octaves,
     sheared with height so they lean, dissolving into the crown glow near
     the top the way real rays diffuse. */
  vec2 rp=vec2(uw*B.w+B.z+t*.55+v*1.6,v*.7+t*.12);
  float f1=vn(rp), f2=vn(rp*2.7+11.);
  float fil=pow(1.-abs(f1*2.-1.),1.7)*.72+(1.-abs(f2*2.-1.))*.28;
  fil=.18+.82*fil;                      // dark lanes to 18%, not to grey
  fil=mix(fil,1.,smoothstep(.45,.95,v));
  /* Patchiness — bright stretches and stretches where it has almost gone.
     A band of even brightness end to end is the loudest possible tell that
     something is a gradient and not weather. Doubles as the slow breathing
     that keeps a parked car from seeing a frozen decal. */
  // (named pat, not patch: patch is a reserved word in GLSL ES)
  float pat=.15+.85*smoothstep(.22,.78,vn(vec2(uw*1.5+B.z*3.+t*.06,t*.04)));
  float w=(env*fil+skirt*.12)*vp*pat*B.x;
  /* Hue by height, and NOT a straight lerp between the two. lo and hi are
     often complementary (the iconic green floor under a crimson crown), and
     an RGB lerp between complements passes through grey — the exact muddy sky
     the palettes exist to prevent. Renormalising the tint to unit max channel
     instead means the crossover changes HUE at constant level: it brightens
     to the pale zone a real green/red overlap actually is, rather than
     dipping into a grey band. The transition is kept TIGHT so that pale zone
     is a thin seam rather than half the sky, and it is placed against the
     COMPRESSED band so it lands mid-windscreen — body colour below about
     12° of elevation, crossover through ~18°, crown above that, all of it
     inside the frame instead of above it. Level stays
     entirely the vertical envelope's business. */
  float hw=smoothstep(.34,.62,v);
  vec3 tint=uColLo[i]*(1.-hw*.85)+uColHi[i]*(hw*1.25);
  tint/=max(max(tint.r,max(tint.g,tint.b)),1e-4);
  acc+=tint*w;
 }
 /* The last degree or two is haze and silhouette, not aurora. Kept as a
    genuine smoothstep so the horizon never prints a line, but tightened:
    on a 23° window the old .010–.075 ramp (0–4.3°) was spending a fifth of
    everything the player can see on a fade. Fully lit by 2.4° now, and the
    skyline ring tops out at 7.8° so it occludes most of that zone anyway. */
 acc*=smoothstep(.008,.042,ey);
 /* Hue-preserving soft knee. Near-linear where a single curtain lives, so
    raising the amplitude actually raises what you see, and firm enough at the
    top that overlapping curtains asymptote around 0.55 linear — bright, and
    still under the level where ACES would bleach the colour out of the core.
    The earlier 1/(1+m*1.45) was the thing quietly flattening every peak. */
 float m=max(acc.r,max(acc.g,acc.b));
 acc*=uAmt/(1.+m*.50+m*m*.42);
 // the sky is the smoothest thing in the frame, so 8-bit banding shows here
 // first — a sub-LSB hash dither costs nothing and removes it
 acc+=(h21(gl_FragCoord.xy+fract(uTime))-.5)*.0035;
 gl_FragColor=vec4(max(acc,vec3(0.)),1.);
}`,
    blending: THREE.AdditiveBlending,
    // deliberately NOT transparent — see the header comment
    transparent: false,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    fog: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -9.6; // straight after the sky dome, before all geometry
  mesh.frustumCulled = false;

  const announce = (r: AuroraRoll) => {
    try {
      console.log(
        `aurora #${r.seed} · ${r.palette} · ${r.bands} bands` +
        `  —  __aurora.next() for another, __aurora.lock() to keep this one`
      );
    } catch {
      /* no console — the sky still renders */
    }
    return r;
  };

  const api: Aurora = {
    mesh,
    mat,
    roll: applyRoll(seedIn ?? sessionSeed()),
    palLo: sessionLo,
    palHi: sessionHi,
    gain: 1,
    reroll(seed?: number) {
      api.roll = applyRoll(seed ?? ((Math.random() * 0xffffffff) >>> 0));
      api.onPalette?.(sessionLo, sessionHi);
      return announce(api.roll);
    },
    next() {
      return api.reroll((api.roll.seed + 1) >>> 0);
    },
    lock() {
      const s = `?aurora=${api.roll.seed}`;
      try {
        console.log(`add ${s} to the URL to start on this sky every time`);
      } catch {
        /* ignore */
      }
      return s;
    },
    update(now: number, dayF: number, fogMul: number) {
      mat.uniforms.uTime.value = now;
      /* Night is the hero: full strength below dayFactor ≈ 0, gone by ≈ 0.74,
         with the 1.35 power holding it up through most of dusk so the default
         21:24 start opens on a full sky. */
      const night = Math.pow(clamp(1 - dayF * 1.35, 0, 1), 1.35);
      /* Fog SOFTENS, it does not gate. This used to run the skyline ring's
         curve, clamp(1.9 - fogMul, .12, 1), which quietly took 35% off the
         aurora at the default "medium" setting for no reason the player could
         see — the skyline is a silhouette 2.3 km downrange and genuinely goes
         away in fog, an aurora is at the top of the atmosphere and does not.
         Heavy fog still costs about a third. */
      mat.uniforms.uAmt.value =
        night * clamp(1 - 0.13 * fogMul, 0.62, 1) * Math.max(0, api.gain);
    },
  };
  announce(api.roll);
  return api;
}
