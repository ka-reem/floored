import * as THREE from "three";

/* Post pipeline (v4): the scene is rendered linear-HDR into a half-float MSAA
   target, then bright-extract → separable blur (plus, on the desktop tier, an
   eighth-res wide-halo chain — see DUAL_BLOOM below) → composite (exposure,
   fitted ACES, film grade, slight CA, vignette, desktop film finishers,
   manual sRGB encode) → FXAA + adaptive sharpen → optional dashcam degrade →
   frame-blend motion blur → screen.

   `grade` no longer means "slightly different colours": it swaps the clean
   look for the full dashcam pass (soft cheap lens, chroma bleed, sensor noise,
   crushed highlights, rolling-shutter wobble, burnt-in timestamp).

   `setDashcamPov(true)` is a separate, much harsher stage that the DASHCAM POV
   camera forces on regardless of `grade`: it runs *after* the frame blend (the
   smear is optical, the sensor noise and the codec artefacts come after it) and
   re-encodes the frame as cheap night-time evidence footage — half-res source,
   crushed/red-bled blacks, blown horizontal highlight streaks, coarse boiling
   grain, bit-crush banding and torn interlace rows. */

const VSH = "varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }";
/** How many flat instruments the POV shield covers: the rear-view glass and
 *  the head unit's screen (PANEL_MIRROR / PANEL_SCREEN below). */
const PANELS = 2;
const PANEL_MIRROR = 0, PANEL_SCREEN = 1;
/* Shared GLSL for the POV shield mask, spliced into both shaders that honour
   it (povMat and mbMat) so the two can never feather differently. Each panel
   is a soft-edged box over its projected screen-UV rect, with a feather that
   scales with the rect so it stays a constant fraction of the panel at any
   resolution; the strongest panel covering a pixel wins. uPanStr is 0 for a
   panel that is hidden, offscreen or simply not in the dashcam POV, and with
   every entry 0 the mask is exactly 0 — which is what makes every non-POV
   frame bit-identical to the unshielded arithmetic. */
const SHIELD_FN = `uniform vec2 uPanMin[${PANELS}],uPanMax[${PANELS}];
uniform float uPanStr[${PANELS}];
float shieldMask(vec2 uv){
 float m=0.;
 for(int i=0;i<${PANELS};i++){
   vec2 lo=uPanMin[i],hi=uPanMax[i];
   vec2 fth=max((hi-lo)*.08,vec2(1e-4));
   vec2 a=smoothstep(lo-fth,lo+fth,uv);
   vec2 b=vec2(1.)-smoothstep(hi-fth,hi+fth,uv);
   m=max(m,a.x*a.y*b.x*b.y*uPanStr[i]);
 }
 return m; }
`;
/** an unregistered shield panel: shieldRect bails on the null and its
 *  strength stays 0 */
const NO_PANEL = () => null;
/** Fresh uniform values for one shader's shield slots: rects parked offscreen
 *  and every strength at 0, i.e. the shield fully disabled. */
const shieldUniforms = () => ({
  uPanMin: { value: Array.from({ length: PANELS }, () => new THREE.Vector2(2, 2)) },
  uPanMax: { value: Array.from({ length: PANELS }, () => new THREE.Vector2(-1, -1)) },
  uPanStr: { value: new Array(PANELS).fill(0) as number[] },
});
// mirrors the GLSL h21() hash's fractional part, used JS-side to decide
// which frame buckets the dashcam impact glitch holds (see process()'s
// holdFrame) so the "dropped frame" moments track the shader's own bucketing
const frac = (x: number) => x - Math.floor(x);

/** Live console knobs for the POV visibility tweaks — read fresh every frame
 * in process(), so console edits (`window.__povTune.gainFloor = 0`) take
 * effect immediately, no redeploy or reload.
 * gainFloor / shadowGrain / lampProtect / skyCrush: each 0..1, scaling that
 * one post-degrade effect's strength independently (defaults below are the
 * shipped balance, not "off" — only sensorGain=1 and skyCrush/gainFloor=0
 * are truly off).
 * sensorGain: 1..3, default 1.25 — multiplies the image feeding the whole
 * POV degrade chain (see povSrcMat below), i.e. it brightens the *source*
 * before crush/grain/everything rather than lifting the result afterward.
 * Turned down from an earlier 1.8: that overshot into a visibly lit sky, so
 * this is now a small assist and skyCrush (below) cleans up what it still
 * lifts. gainFloor's target also came down alongside it (1 → 0.4) so bodies
 * go back to barely-there — car visibility is being carried by taillights
 * (traffic.ts) plus lampProtect, not by brightening the whole frame.
 * skyCrush: darkens the upper frame's dim, desaturated sky glow — the thing
 * sensorGain lifts along with everything else — back toward black, without
 * touching saturated or genuinely bright pixels (tail lamps, headlights,
 * signs). See the povMat shader for the screen-y / saturation / luma mask. */
declare global {
  interface Window {
    __povTune?: {
      gainFloor: number; shadowGrain: number; lampProtect: number; sensorGain: number;
      skyCrush: number; mirrorShield: number; screenShield: number;
    };
  }
}
/** POV mirror shield clarity, 0..1. Inside the rear-view glass's projected
 * screen quad the dashcam degrade is swapped back toward the clean pre-degrade
 * frame by this factor (and the POV frame-blend/edge-darkening are attenuated
 * in step) so the live mirror stays legible; 0.85 leaves a 15% whisper of the
 * grade so the glass still reads as part of the footage. 0 disables the
 * shield entirely (exact pre-shield frame — also the live A/B via
 * `window.__povTune.mirrorShield = 0`). */
const MIRROR_SHIELD = 0.85;
/** The same shield over the head unit's screen (see PANEL_SCREEN). Held a
 * little higher than the mirror's: the mirror is a reflection of the same
 * night the camera is filming, so it can afford to carry some of the grade,
 * but the screen is an emissive panel of thin 6-8 px map lines and type —
 * the half-res snap and the 19/23/17-level quantise are exactly what turn it
 * into mush. 0.92 keeps the map crisp with a whisper of grain left so it
 * still sits in the footage. `window.__povTune.screenShield = 0` A/Bs it. */
const SCREEN_SHIELD = 0.92;
const POV_TUNE_DEFAULT = {
  gainFloor: 0.4, shadowGrain: 1, lampProtect: 1, sensorGain: 1.25, skyCrush: 0.6,
  mirrorShield: MIRROR_SHIELD, screenShield: SCREEN_SHIELD,
};

/* ---- Cinematic night look (engine wires tierCaps.dualBloom/.filmLook
   through setCinema; mobile tiers pass false, which zeroes uFilmVig/uFilmCA/
   uFilmDirt and skips the halo passes, leaving the composite bit-identical to
   the single-bloom pipeline).

   NOT everything below is tier-gated any more: FILM_GRAIN and FILM_TONE cost
   nothing but ALU and were making the mobile frame worse rather than cheaper,
   so they now run on every tier. See the uFilm* block in process().

   TWO-SCALE BLOOM: the single quarter-res chain had to be wide enough to give
   lamps an atmosphere, which also meant every taillight core was already a
   blurred disc. Split it: the quarter-res chain drops from 3 blur iterations
   to 2 (a tight, crisp core), and its output is downsampled to eighth res and
   blurred twice more into a *separate* wide halo that the composite adds at
   its own strength. Same bright-pass, same soft knee, so the anti-blowout
   behaviour upstream (traffic.ts KNEE/KNEE_MAX, untouched) still governs what
   can enter the bloom at all. Strength multipliers are applied to the
   existing 0.85 (clean) / 1.15 (grade) base so total energy stays in the
   same family: core 0.85→0.66, plus halo at 0.45 — richer glow around the
   lamp, less white in its middle.

   FILM FINISHERS: each behind its own flag so any one of them can be zeroed
   at merge without shader surgery. Amplitudes are deliberately "shot on a
   camera at night", not Instagram — see the composite shader for the exact
   terms. */
const DUAL_BLOOM = true;    // two-scale bloom master flag (desktop)
const DUAL_CORE_MUL = 0.78; // core strength = base(0.85/1.15) * this
const DUAL_HALO_MUL = 0.53; // halo strength = base(0.85/1.15) * this
const FILM_GRAIN = true;    // finer per-pixel animated grain, ~45% lower amplitude
const FILM_VIGNETTE = true; // extra quartic (corners-only) falloff
const FILM_CA = true;       // small radial CA boost at frame edges
const FILM_TONE = true;     // deeper black toe + tiny black-point pull
/** Lens-dirt overlay (CC0, Kenney particle pack dirt_02 — copied to
 *  public/assets/lens/): a faint additive smudge layer that mostly rides the
 *  wide bloom halo, so it glints when a bright lamp crosses the frame and all
 *  but disappears against dark road. Fetched lazily the first time filmLook
 *  turns on, so mobile tiers never download it. */
const FILM_DIRT = true;
const DIRT_URL = "/assets/lens/dirt_02.png";
/** Exposure time constant of the dashcam POV's frame blend, in SECONDS.
 *
 * This used to be a bare retention fraction (`mb = pov ? 0.66`), which is only
 * a duration if the frame rate never moves. `mix(cur, prev, 0.66)` decays with
 * a time constant of dt/ln(1/0.66) — 40 ms at 60 fps, which is the long night
 * exposure the look was authored around, but 80 ms at the 30 fps a phone
 * actually runs, i.e. exactly double the intended smear on the smallest screen
 * and the one place the doubling of every lane line and car edge is least
 * affordable. Expressed as a time constant it is the same 40 ms everywhere:
 * retention = exp(-dt / this), which evaluates to 0.6600 at 60 fps, so the
 * desktop frame is unchanged to four decimal places.
 *
 * Lower this to shorten the smear; it is a real exposure time, so 0.030 reads
 * as a faster sensor rather than as "motion blur turned down". */
const POV_MB_TAU = 0.0401;
/** dt clamp for the blend above. The floor keeps a hitched or zero-length
 *  frame from resolving to a retention of ~1 (a frozen image); the ceiling
 *  matches engine.ts's own dt clamp, so a long stall cuts rather than drags. */
const POV_MB_DT_MIN = 1 / 240, POV_MB_DT_MAX = 0.1;

function readPovTune() {
  if (typeof window === "undefined") return POV_TUNE_DEFAULT;
  if (!window.__povTune) window.__povTune = { ...POV_TUNE_DEFAULT };
  const t = window.__povTune;
  const c01 = (v: number, d: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
  const cGain = (v: number) => (Number.isFinite(v) ? Math.max(1, Math.min(3, v)) : POV_TUNE_DEFAULT.sensorGain);
  return {
    gainFloor: c01(t.gainFloor, POV_TUNE_DEFAULT.gainFloor),
    shadowGrain: c01(t.shadowGrain, POV_TUNE_DEFAULT.shadowGrain),
    lampProtect: c01(t.lampProtect, POV_TUNE_DEFAULT.lampProtect),
    skyCrush: c01(t.skyCrush, POV_TUNE_DEFAULT.skyCrush),
    sensorGain: cGain(t.sensorGain),
    mirrorShield: c01(t.mirrorShield, POV_TUNE_DEFAULT.mirrorShield),
    screenShield: c01(t.screenShield, POV_TUNE_DEFAULT.screenShield),
  };
}

export class PostFX {
  sceneRT!: THREE.WebGLRenderTarget;
  reflectRT!: THREE.WebGLRenderTarget;
  mirrorRT: THREE.WebGLRenderTarget;
  private brightRT!: THREE.WebGLRenderTarget;
  private blurA!: THREE.WebGLRenderTarget;
  private blurB!: THREE.WebGLRenderTarget;
  private haloA!: THREE.WebGLRenderTarget;
  private haloB!: THREE.WebGLRenderTarget;
  private ldrRT!: THREE.WebGLRenderTarget;
  private fxaaRT!: THREE.WebGLRenderTarget;
  private mbRT!: THREE.WebGLRenderTarget;
  private prevRT!: THREE.WebGLRenderTarget;
  private dashRT!: THREE.WebGLRenderTarget;
  private softA!: THREE.WebGLRenderTarget;
  private softB!: THREE.WebGLRenderTarget;
  private povA!: THREE.WebGLRenderTarget;
  private povB!: THREE.WebGLRenderTarget;
  private perf = false;
  /** mobile-tier RT policy (see setMobile): half-size mirror, quarter-res
      reflection allocation. Distinct from `perf`, which is the reactive
      frame-time fallback and can fire on top of this on any tier. */
  private mobile = false;
  /** desktop-tier cinematic extras (setCinema): two-scale bloom + film look */
  private cineDual = false;
  private cineFilm = false;
  private dirtTex: THREE.Texture | null = null;
  private dirtLoadStarted = false;
  private speedKmh = 0;
  private pov = false;
  /** false for one frame after a hard view change: the temporal blend is
      skipped so a camera teleport cuts instead of dragging a ghost. */
  private histValid = false;
  private overCv: HTMLCanvasElement;
  private overTex: THREE.CanvasTexture;
  private overAt = -1;
  /* POV shield state (setPovMirror / setPovScreen / shieldRect): the flat
     instruments that stay legible inside the dashcam degrade — the cockpit's
     rear-view glass and its head-unit screen — plus the main camera. Handed
     over by engine.buildRig on every rig build so a car swap can never leave
     a disposed mesh here. Each panel resolves its mesh through a thunk rather
     than holding one: the head unit's panel can change after the rig is built
     (a donor dash hides the procedural tablet and re-binds the nav canvas onto
     its own screen, asynchronously), and `corners` re-caches when it does. */
  private panels: {
    get: () => THREE.Mesh | null;
    /** the mesh `corners` was taken from, so a swap invalidates the cache */
    mesh: THREE.Mesh | null;
    /** the panel's bounding-box corners in its own local space */
    corners: THREE.Vector3[] | null;
  }[] = Array.from({ length: PANELS }, () => ({ get: NO_PANEL, mesh: null, corners: null }));
  private mirCam: THREE.Camera | null = null;
  private mirV = new THREE.Vector3();
  // dashcam impact-glitch event (see dashcamHit()): hitAt/-Dur/-Seed/-Intensity
  // describe at most one in-flight burst. hitAt sits far in the past so the
  // envelope in process() reads 0 before the first real hit ever lands.
  private hitAt = -1e6;
  private hitDur = 0;
  private hitSeed = 0;
  private hitIntensity = 0;

  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fsQuad: THREE.Mesh;

  private dashMat: THREE.ShaderMaterial;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private fxaaMat: THREE.ShaderMaterial;
  private mbMat: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;
  private smearMat: THREE.ShaderMaterial;
  private povMat: THREE.ShaderMaterial;
  private povSrcMat: THREE.ShaderMaterial;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.fsScene.add(this.fsQuad);
    // MSAA here: at 320x128 the cost is negligible, but without it tiny bright
    // points (stars, distant tail-lights) alias to single texels and flicker
    // wildly frame to frame once blown up onto the mirror glass.
    this.mirrorRT = new THREE.WebGLRenderTarget(320, 128, { type: THREE.HalfFloatType, samples: 4 });

    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null }, uExp: { value: 1 } },
      vertexShader: VSH,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tIn; uniform float uExp;
void main(){ vec3 c=min(texture2D(tIn,vUv).rgb*uExp,vec3(14.));
 float l=dot(c,vec3(.299,.587,.114));
 // soft-knee threshold: keeps highlight rolloff smooth instead of popping
 const float T=.95, K=.55;
 float sk=clamp(l-T+K,0.,2.*K); sk=sk*sk/(4.*K);
 float w=max(sk,l-T)/max(l,1e-4);
 gl_FragColor=vec4(c*w,1.); }`,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tIn: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uRes: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: VSH,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tIn; uniform vec2 uDir; uniform vec2 uRes;
void main(){ vec2 px=uDir/uRes; vec3 s=texture2D(tIn,vUv).rgb*.227;
 s+=(texture2D(tIn,vUv+px*1.384).rgb+texture2D(tIn,vUv-px*1.384).rgb)*.316;
 s+=(texture2D(tIn,vUv+px*3.230).rgb+texture2D(tIn,vUv-px*3.230).rgb)*.0702;
 gl_FragColor=vec4(s,1.); }`,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tBloom: { value: null }, tBloomW: { value: null },
        uTime: { value: 0 },
        uGrade: { value: 1 }, uExp: { value: 1.12 },
        uRes: { value: new THREE.Vector2(1, 1) }, uBloomStr: { value: 1.0 },
        uHaloStr: { value: 0 }, uSpeedT: { value: 0 },
        // film-look finisher gates, 0 (mobile / flag off — bit-identical to
        // the pre-cinema composite) or 1 (desktop): see FILM_* above
        uFilmGrain: { value: 0 }, uFilmVig: { value: 0 },
        uFilmCA: { value: 0 }, uFilmTone: { value: 0 },
        tDirt: { value: null }, uFilmDirt: { value: 0 },
      },
      vertexShader: VSH,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tScene,tBloom,tBloomW,tDirt;
uniform float uTime,uGrade,uBloomStr,uHaloStr,uExp,uSpeedT;
uniform float uFilmGrain,uFilmVig,uFilmCA,uFilmTone,uFilmDirt;
uniform vec2 uRes;
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453+uTime); }
/* Fitted ACES (Narkowicz's curve was hue-shifting saturated neon badly; the
   Hill fit keeps reds/magentas from turning orange in bloom cores). */
const mat3 ACIN=mat3(.59719,.07600,.02840,.35458,.90834,.13383,.04823,.01566,.83777);
const mat3 ACOUT=mat3(1.60475,-.10208,-.00327,-.53108,1.10813,-.07276,-.07367,-.00605,1.07602);
vec3 aces(vec3 c){ c=ACIN*c;
 vec3 a=c*(c+.0245786)-.000090537, b=c*(.983729*c+.4329510)+.238081;
 return clamp(ACOUT*(a/b),0.,1.); }
void main(){
 vec2 uv=vUv; vec2 d=uv-.5; float r2=dot(d,d);
 // FILM_CA: the base CA stays; the flag adds a touch more radial split at
 // the very edges only (r2-scaled, so the centre term is untouched)
 float ca=.0008+(.0026+uFilmCA*.0014)*r2;
 vec3 col; col.r=texture2D(tScene,uv+d*ca).r; col.g=texture2D(tScene,uv).g; col.b=texture2D(tScene,uv-d*ca).b;
 // two-scale bloom: tight core + wide halo. uHaloStr is 0 on mobile tiers
 // (tBloomW is then bound to the same core texture purely to keep the
 // sampler valid), so this line degenerates to the original single add.
 vec3 bl=texture2D(tBloom,uv).rgb;
 vec3 blw=texture2D(tBloomW,uv).rgb;
 col=col*uExp+bl*uBloomStr+blw*uHaloStr;
 col=aces(col);
 col=pow(col,vec3(1./2.2));
 // film grade: gentle S-curve, split-tone (cool shadows / warm highlights),
 // slight vibrance. Applied in both modes; the dashcam pass degrades on top.
 float l=dot(col,vec3(.2126,.7152,.0722));
 // FILM_TONE (a): steeper S — deepens the toe smoothly, so shadows go down
 // without clipping and keep their internal detail (AC-night black, not mud)
 col=mix(col,col*col*(3.-2.*col),.22+uFilmTone*.08);
 col+=vec3(-.010,-.002,.016)*(1.-smoothstep(0.,.45,l));
 col+=vec3(.014,.006,-.010)*smoothstep(.55,1.,l);
 float sat=mix(1.16,1.0,smoothstep(.25,.9,l));
 // speed vignette: rising edge saturation reads as tunnel-vision colour
 // punch without a hard mask, cheap since r2 is already computed above
 sat+=uSpeedT*r2*.55;
 col=mix(vec3(dot(col,vec3(.2126,.7152,.0722))),col,sat);
 // FILM_TONE (b): black-point pull — the last ~1.5/255 of grey wash (fog
 // floor, bounce fill) goes to true black; the tiny rescale keeps white at 1
 col=max(col-vec3(.006*uFilmTone),vec3(0.))*(1.+.008*uFilmTone);
 // FILM_DIRT: additive smudge layer — near-invisible at rest (~2/255) and
 // only really waking where the wide halo says a bright source sits behind
 // it (clamped so a blown lamp can't torch the whole overlay). First cut ran
 // .035 base / .14 glint and read as a dirty windshield against the tunnel
 // walls; dirt on a lens only shows against light. uFilmDirt stays 0 until
 // the lazily fetched texture is actually resident, so no pop-in of garbage.
 vec4 dirt=texture2D(tDirt,uv);
 col+=dirt.rgb*dirt.a*uFilmDirt
   *(.008+.06*min(dot(blw,vec3(.299,.587,.114))*uHaloStr,1.));
 // FILM_GRAIN: with the flag the grain goes per-pixel (finer) and ~45%
 // quieter — a night-footage sensor texture rather than visible noise
 col+=(hash(uv*uRes*mix(.5,1.,uFilmGrain))-.5)
   *(uGrade>.5?.012:.018)*(1.-uFilmGrain*.45)*(1.-l*.7);
 // FILM_VIGNETTE: quartic term only reaches the corners (r2^2), leaving the
 // existing r2 falloff — and the frame centre — exactly where it was
 col*=1.-r2*(uGrade>.5?.30:.42)-r2*r2*uFilmVig*.18-r2*uSpeedT*.16;
 gl_FragColor=vec4(clamp(col,0.,1.),1.); }`,
    });
    this.fxaaMat = new THREE.ShaderMaterial({
      uniforms: {
        tIn: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
        uSharp: { value: 0.34 },
      },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv;
uniform sampler2D tIn; uniform vec2 uRes; uniform float uSharp;
void main(){ vec2 px=1.0/uRes;
 vec3 rgbNW=texture2D(tIn,vUv+vec2(-1.,-1.)*px).rgb;
 vec3 rgbNE=texture2D(tIn,vUv+vec2(1.,-1.)*px).rgb;
 vec3 rgbSW=texture2D(tIn,vUv+vec2(-1.,1.)*px).rgb;
 vec3 rgbSE=texture2D(tIn,vUv+vec2(1.,1.)*px).rgb;
 vec3 rgbM=texture2D(tIn,vUv).rgb;
 vec3 luma=vec3(.299,.587,.114);
 float lNW=dot(rgbNW,luma),lNE=dot(rgbNE,luma),lSW=dot(rgbSW,luma),lSE=dot(rgbSE,luma),lM=dot(rgbM,luma);
 float lMin=min(lM,min(min(lNW,lNE),min(lSW,lSE)));
 float lMax=max(lM,max(max(lNW,lNE),max(lSW,lSE)));
 vec2 dir=vec2(-((lNW+lNE)-(lSW+lSE)),((lNW+lSW)-(lNE+lSE)));
 float dirReduce=max((lNW+lNE+lSW+lSE)*.03125,.0078125);
 float rcp=1.0/(min(abs(dir.x),abs(dir.y))+dirReduce);
 dir=clamp(dir*rcp,vec2(-8.),vec2(8.))*px;
 vec3 a=.5*(texture2D(tIn,vUv+dir*(1./3.-.5)).rgb+texture2D(tIn,vUv+dir*(2./3.-.5)).rgb);
 vec3 b=a*.5+.25*(texture2D(tIn,vUv+dir*-.5).rgb+texture2D(tIn,vUv+dir*.5).rgb);
 float lB=dot(b,luma);
 vec3 aa=(lB<lMin||lB>lMax)?a:b;
 /* Free unsharp mask off the taps FXAA already fetched. The darkening side is
    pushed harder than the brightening side, which reads as cheap contact AO in
    creases (wheel arches, kerbs, window reveals) without a depth buffer. */
 vec3 avg=(rgbNW+rgbNE+rgbSW+rgbSE)*.25;
 vec3 hi=aa-avg;
 vec3 sharp=aa+hi*uSharp*(1.0+step(0.,-dot(hi,luma))*.75);
 float edge=clamp((lMax-lMin)*3.5,0.,1.);
 gl_FragColor=vec4(clamp(mix(aa,sharp,edge),0.,1.),1.0);}`,
    });
    this.mbMat = new THREE.ShaderMaterial({
      uniforms: {
        tCur: { value: null }, tPrev: { value: null }, uMB: { value: 0 },
        uPeriph: { value: 0 },
        // POV shield (see SHIELD_FN / shieldRect below): the strengths are
        // nonzero only while the dashcam POV runs, so every other mode's
        // blend is bit-identical to before
        ...shieldUniforms(),
      },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv;
uniform sampler2D tCur,tPrev; uniform float uMB,uPeriph;
${SHIELD_FN}// approx vanishing point: the horizon sits a little above true screen
// centre in both chase and cockpit cams (hood/dash eats the lower half),
// so streaks converging here read as "receding into the road" rather than
// a generic centre blur.
const vec2 VP=vec2(.5,.54);
void main(){
 vec2 d=vUv-VP; float r=length(d);
 // peripheral radial STREAK (fovea effect): a short directional pull along
 // the edge-to-vanishing-point line, not an isotropic blur — each pixel
 // samples along one ray toward VP, which is what reads as speed lines
 // rather than defocus. Masked so the fovea (~15% radius) stays tack sharp
 // and the streak ramps to full length by mid-frame; corners are fully
 // streaked well before the edge. uPeriph carries the 0..1 speed factor in,
 // so at uPeriph=0 every tap collapses onto vUv (a no-op read of tCur).
 float mask=smoothstep(.15,.6,r)*uPeriph;
 vec2 dir=r>1e-5?d/r:vec2(0.);
 vec3 c=vec3(0.); float wsum=0.;
 const int N=6;
 for(int i=0;i<N;i++){
   // a comet, not a smear: the near end (i=0, full weight) anchors the
   // sharp source pixel, the tail stretches toward VP and fades out
   float ti=float(i)/float(N-1);
   float t=ti*mask*.11;
   float w=1.0-ti*.6;
   c+=texture2D(tCur,vUv-dir*t).rgb*w; wsum+=w;
 }
 c/=wsum;
 vec3 p=texture2D(tPrev,vUv).rgb;
 // POV shield: the dashcam POV pins uMB at .66 (a long night exposure),
 // which turns the live mirror feed into an unreadable smear and drags a
 // panning map across its own screen. Inside a shielded panel the blend
 // drops to a quarter and the edge darkening below lifts, so mirror and
 // head unit stay readable instruments while the world around them keeps
 // dragging. An all-zero mask (every non-POV frame) collapses both lines
 // back to the originals.
 float shield=shieldMask(vUv);
 vec3 col=mix(c,p,uMB*(1.-shield*.75));
 col*=1.0-uMB*.55*smoothstep(.42,.95,r)*(1.-shield);
 gl_FragColor=vec4(col,1.0);}`,
    });
    this.overCv = document.createElement("canvas");
    this.overCv.width = 512;
    this.overCv.height = 64;
    this.overTex = new THREE.CanvasTexture(this.overCv);
    this.overTex.minFilter = this.overTex.magFilter = THREE.LinearFilter;
    this.overTex.generateMipmaps = false;
    this.dashMat = new THREE.ShaderMaterial({
      uniforms: {
        tSharp: { value: null }, tSoft: { value: null }, tOver: { value: this.overTex },
        uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
        uOverPos: { value: new THREE.Vector2(0.02, 0.03) },
        uOverSize: { value: new THREE.Vector2(0.3, 0.03) },
      },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv;
uniform sampler2D tSharp,tSoft,tOver; uniform vec2 uRes,uOverPos,uOverSize; uniform float uTime;
float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
void main(){
 vec2 d=vUv-.5; float r2=dot(d,d);
 // cheap wide-angle barrel + rolling-shutter wobble
 vec2 uv=vUv+d*r2*.075;
 uv.x+=sin(uv.y*36.+uTime*6.5)*.00042+sin(uv.y*173.+uTime*21.)*.00014;
 uv=clamp(uv,vec2(.0015),vec2(.9985));
 // soft plastic lens: centre nearly in focus, corners mush; chroma bleeds
 // radially because the cheap element does not correct colour
 vec3 sh=texture2D(tSharp,uv).rgb;
 vec2 ca=d*(.004+.016*r2);
 vec3 sf; sf.r=texture2D(tSoft,uv+ca).r; sf.g=texture2D(tSoft,uv).g; sf.b=texture2D(tSoft,uv-ca).b;
 vec3 col=mix(sh,sf,clamp(.45+r2*2.4,0.,.96));
 // low-bitrate macroblocking
 vec2 bs=10./uRes;
 col=mix(col,texture2D(tSoft,(floor(uv/bs)+.5)*bs).rgb,.17);
 // cheap sensor response: milky lifted blacks, clipped bleached highlights,
 // washed saturation with the usual green-ish CMOS cast
 col=col*.88+.055;
 col*=1.22;
 float l=dot(col,vec3(.299,.587,.114));
 col=mix(col,vec3(1.),smoothstep(.86,1.25,l)*.55);
 col=mix(vec3(l),col,.8)*vec3(.985,1.02,.985);
 // burnt-in timestamp strip (before the noise, like a real DVR overlay)
 vec2 op=(vUv-uOverPos)/uOverSize;
 vec4 ov=texture2D(tOver,clamp(op,0.,1.));
 float inside=step(0.,op.x)*step(op.x,1.)*step(0.,op.y)*step(op.y,1.);
 col=mix(col,ov.rgb,ov.a*inside*.92);
 // sensor noise held at ~24fps: heavy luma grain in the darks plus coarse
 // chroma blotches, which is what actually sells "dashcam" at night
 float t=floor(uTime*24.);
 vec2 np=uv*uRes;
 float n1=h21(np+t*17.3), n2=h21(np*.4+t*3.7+11.3), n3=h21(np*.28+t*5.1+31.7);
 float dark=mix(1.,.22,smoothstep(.04,.62,dot(col,vec3(.299,.587,.114))));
 col+=(n1-.5)*.095*dark;
 col+=vec3(n2-.5,n3-.5,(n2+n3)*.5-.5)*.08*dark;
 col*=1.+.018*sin((vUv.y+uTime*.06)*84.);
 col*=1.-r2*.48;
 gl_FragColor=vec4(clamp(col,0.,1.),1.); }`,
    });
    /* Bright-pass + long horizontal smear, run on the half-res POV source.
       Cheap sensors do not have a global shutter or a decent IR filter, so a
       headlight does not bloom radially — it bleeds along the row it is read
       out on. 17 taps three texels apart ≈ ±48 full-res pixels of streak. */
    this.smearMat = new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv;
uniform sampler2D tIn; uniform vec2 uRes;
void main(){ vec3 s=vec3(0.); float wsum=0.;
 for(int i=-8;i<=8;i++){
   float fi=float(i);
   vec3 c=texture2D(tIn,vUv+vec2(fi*3./uRes.x,0.)).rgb;
   float l=dot(c,vec3(.299,.587,.114));
   float w=1.-abs(fi)/9.;
   s+=c*smoothstep(.62,.92,l)*w; wsum+=w; }
 gl_FragColor=vec4(s/wsum,1.); }`,
    });
    /* The POV degrade. Ordered like a real cheap camera's signal chain:
       lens/readout geometry → sensor response → noise → codec, so the banding
       and the block-ish grain land on top of everything else the way an
       over-compressed 480p night clip does. uLow is the half-res grid the
       source was box-downsampled onto; snapping to it is a nearest upscale. */
    this.povMat = new THREE.ShaderMaterial({
      uniforms: {
        tLow: { value: null }, tSmear: { value: null }, tOver: { value: this.overTex },
        // POV shield: tFull is the pre-degrade full-res frame (the same mbRT
        // the half-res chain resamples), uPanMin/uPanMax the projected quads
        // of the rear-view glass and the head-unit screen in screen UV (see
        // shieldRect()), uPanStr each panel's clarity factor (MIRROR_SHIELD /
        // SCREEN_SHIELD while its rect is live, 0 otherwise — all-zero makes
        // the whole pass bit-identical to the unshielded shader).
        tFull: { value: null },
        ...shieldUniforms(),
        uLow: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
        uOverPos: { value: new THREE.Vector2(0.022, 0.925) },
        uOverSize: { value: new THREE.Vector2(0.3, 0.03) },
        uOverAmt: { value: 1 },
        // dashcam impact glitch: uHitEnv is the decaying 0..1 burst envelope
        // (exactly 0 outside an event — every hit-driven term below is a
        // multiply against it, so idle cost is a handful of ALU ops and zero
        // extra texture fetches), uHitSeed reseeds the randomness per event,
        // uHitT is seconds since the hit landed (drives the flash decay and
        // the wobble phase).
        uHitEnv: { value: 0 }, uHitSeed: { value: 0 }, uHitT: { value: 0 },
        // POV visibility knobs (independently tunable live via
        // window.__povTune — see readPovTune() below, whose POV_TUNE_DEFAULT
        // is the source of truth for these; the values here are just the
        // material's pre-first-frame defaults).
        uGainFloor: { value: 0.4 }, uShadowGrain: { value: 1 }, uLampProtect: { value: 1 },
        uSkyCrush: { value: 0.6 },
      },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv;
uniform sampler2D tLow,tSmear,tOver,tFull; uniform vec2 uLow,uOverPos,uOverSize;
uniform float uTime,uOverAmt,uHitEnv,uHitSeed,uHitT;
uniform float uGainFloor,uShadowGrain,uLampProtect,uSkyCrush;
${SHIELD_FN}float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
void main(){
 vec2 d=vUv-.5; float r2=dot(d,d);
 // shield mask: soft-feathered boxes over the projected rear-view glass and
 // head-unit screen (see SHIELD_FN). Scaled down by the impact envelope on
 // purpose — a struck camera should rattle its instruments along with the
 // rest of the frame, or they read as stickers on the lens.
 float shield=shieldMask(vUv)*(1.-uHitEnv*.85);
 // noise clock: 15 Hz, so grain boils well below frame rate like real footage.
 // Wrapped short because it is multiplied into the hash's sin argument, and a
 // free-running one drives that into the range where mobile GPUs stop
 // range-reducing accurately and the grain collapses into a fixed pattern.
 float tq=mod(floor(uTime*15.),61.);
 // event-local ~24fps frame bucket for the impact glitch, offset by the
 // per-event seed so consecutive hits don't snap on the same buckets
 float hq=floor(uHitT*24.+uHitSeed);
 // (i) mild rolling wobble + (f) interlace tear: a few rows per frame get
 // yanked sideways, the rest only wobble
 vec2 uv=vUv;
 uv.x+=sin(uv.y*19.+uTime*3.3)*.0011+sin(uv.y*103.+uTime*11.)*.00035;
 float row=floor(uv.y*uLow.y);
 uv.x+=step(.972,h21(vec2(row,tq)*.017))*(h21(vec2(row*1.7,tq*.31+7.))-.5)*.05;
 // impact tear: far more rows torn, far harder, only while the burst runs
 float tearGate=step(.45,h21(vec2(row*2.3,hq+3.)))*uHitEnv;
 uv.x+=tearGate*(h21(vec2(row*1.3,hq+19.))-.5)*.14;
 // whole-frame displacement jump: snaps for 1-2 buckets at a time rather than
 // every bucket (the step-gate), so it reads as a struck-camera jolt and not
 // a continuous shake
 vec2 hitOff=(vec2(h21(vec2(hq,uHitSeed)),h21(vec2(hq+31.,uHitSeed*1.7)))-.5)
   *step(.55,h21(vec2(floor(hq*.5),uHitSeed+5.)))*.05*uHitEnv;
 // quick refocus wobble as the burst settles: a damped sine that (like the
 // rest) is gated to zero at both env=0 and env=1, so it reads as a
 // mid-to-late-burst settle rather than part of the initial jolt
 float wob=uHitEnv*(1.-uHitEnv)*4.;
 vec2 hitWobble=vec2(sin(uHitT*(17.+uHitSeed*2.3)),cos(uHitT*(21.+uHitSeed*1.7)))*.004*wob;
 uv+=hitOff+hitWobble;
 uv=clamp(uv,vec2(.001),vec2(.999));
 // (g) low internal resolution: snap onto the half-res grid, then let a
 // little of the unsnapped bilinear tap back in so it is soft, not crunchy
 vec2 uvs=(floor(uv*uLow)+.5)/uLow;
 // (d) chromatic fringing, strongly radial so the frame edges separate;
 // impact spike pushes the split hard for the length of the burst
 vec2 ca=(d*(.0045+.032*r2)+vec2(.0016,0.))*(1.+uHitEnv*2.4);
 vec3 col;
 col.r=mix(texture2D(tLow,uvs+ca).r,texture2D(tLow,uv+ca).r,.22);
 col.g=mix(texture2D(tLow,uvs).g,   texture2D(tLow,uv).g,   .22);
 col.b=mix(texture2D(tLow,uvs-ca).b,texture2D(tLow,uv-ca).b,.22);
 // (c) blown highlights: the smear layer goes in hot and then clips to flat
 // white, so lamps read as hard streaks rather than pretty glow
 col+=texture2D(tSmear,uv).rgb*1.15;
 // taillight protection: this clip is what crushes a bright saturated lamp
 // to flat white, so gate its strength down wherever the pixel is clearly
 // coloured (a red tail lamp, an amber indicator) rather than white glare —
 // a cheap max-min saturation proxy is enough to tell the two apart. Grey
 // reflections and headlight blowout (already near-white, low sat) are
 // untouched; uLampProtect at 0 restores the original hard clip.
 float lampSat=max(col.r,max(col.g,col.b))-min(col.r,min(col.g,col.b));
 float lampProtect=uLampProtect*smoothstep(.35,.6,lampSat);
 col=mix(col,vec3(1.),smoothstep(.72,1.02,dot(col,vec3(.299,.587,.114)))*.75*(1.-lampProtect));
 // momentary exposure spike: a fast white flash on the first ~60ms after
 // impact registers, decaying linearly to 0 well inside the burst envelope
 col+=vec3(clamp(1.-uHitT/.06,0.,1.))*uHitEnv;
 // (b) crushed blacks, then sensor bleed: the edges of the frame clip into
 // dark red/magenta (negative green) and the vignette carries a red cast
 col=max(col-.06,vec3(0.))*1.22;
 col=pow(max(col,vec3(0.)),vec3(1.18,1.24,1.22));
 float le=dot(col,vec3(.299,.587,.114));
 col+=vec3(.085,-.012,.045)*smoothstep(.06,.5,r2)*(1.-smoothstep(0.,.5,le));
 col*=1.-r2*.55;
 col.r*=1.+r2*.16;
 // sky pulldown: sensor gain (povSrcMat) brightens the whole source frame,
 // sky included, so the upper half can read as lit night haze instead of
 // black. Pull it back down — but only dim, washed-out, upper-frame content:
 // screen-y above the horizon band (ramps in from .55 to the top edge),
 // low saturation (a real sky glow, not a coloured sign or lamp), and only
 // moderate luma (fades out well before it would touch a genuinely bright
 // pixel) — so tail lamps, headlights and signs punch straight through.
 // Runs ahead of the grain/DVR/quantise below, so the grime still sits on
 // top of the crushed sky rather than being crushed along with it.
 float skySat=max(col.r,max(col.g,col.b))-min(col.r,min(col.g,col.b));
 float skyBand=smoothstep(.55,1.0,vUv.y);
 float skyLowSat=1.-smoothstep(.06,.22,skySat);
 float skyDim=1.-smoothstep(.35,.75,le);
 col*=1.-skyBand*skyLowSat*skyDim*uSkyCrush*.9;
 // burnt-in DVR strip, ahead of the noise and the codec so it degrades with
 // the rest of the frame. Suppressed when the V-key pass already drew one.
 vec2 op=(vUv-uOverPos)/uOverSize;
 vec4 ov=texture2D(tOver,clamp(op,0.,1.));
 col=mix(col,ov.rgb*.9,ov.a*uOverAmt*.92*
   step(0.,op.x)*step(op.x,1.)*step(0.,op.y)*step(op.y,1.));
 // (a) heavy coarse grain, worst in the shadows: ~31/255 peak-to-peak in the
 // blacks, a third of that in the highlights. Because the whole stage runs
 // after the frame blend, none of it is smeared — it boils at 15 Hz over an
 // image that is dragging, which is exactly the cheap-sensor tell.
 vec2 np=floor(uv*uLow*.8);
 float l=dot(col,vec3(.299,.587,.114));
 float shadowT=smoothstep(.03,.55,l); // 0 deep shadow .. 1 at/above midtone
 float dark=mix(1.,.28,shadowT);
 // shadow grain reduction: the grain multiplier above already tapers toward
 // highlights (dark→.28), but silhouettes sit in the shadow end where it's
 // still full strength and the noise eats them. Cut the shadow end toward
 // ~50% too, fading the cut back to a no-op by the same midtone point the
 // taper above already uses, so nothing changes outside the shadows.
 dark=mix(dark,dark*mix(.5,1.,shadowT),uShadowGrain);
 float n1=h21(np+tq*13.7), n2=h21(np*.33+tq*7.1+41.3), n3=h21(np*.29+tq*3.9+91.7);
 col+=(n1-.5)*.22*dark;
 col+=vec3(n2-.5,(n2+n3)*.5-.5,n3-.5)*.10*dark;
 // auto-gain floor: adaptive dark-end lift, like a real camera's night gain
 // riding up the noise floor so silhouettes stay barely readable instead of
 // crushing to pure black. A floor, not a brightening — it only ever lifts
 // pixels *below* the target (the max(...,0.) is 0 for anything already
 // brighter), so midtones/highlights and the overall dark read are
 // untouched; scaled by uGainFloor so 0 restores true crush-to-black.
 float gainTarget=.055*uGainFloor;
 float lift=max(0.,gainTarget-dot(col,vec3(.299,.587,.114)));
 col+=lift*vec3(1.02,1.05,.98)*(.72+.56*n1);
 // shield: swap the accumulated degrade (gain, wobble/tear, half-res snap,
 // CA, smear, crush, red bleed, grain — everything above in one go) back
 // toward the untouched full-res frame inside a shielded panel. tFull is
 // sampled at the *undistorted* vUv, so the panels also stop wobbling.
 // The strengths stop short of 1 so the glass and the screen still sit in
 // the footage rather than looking pasted on.
 col=mix(col,texture2D(tFull,vUv).rgb,shield);
 // interlace comb, then (e) the bit-crush. Quantising last is what makes the
 // banding survive; the uneven per-channel level counts tint the bands.
 // Both are shield-attenuated the same way — 19/23/17-level banding across
 // a 0.1-UV-tall mirror, or across a map drawn in 1 px lines, would undo
 // everything the clean mix just recovered.
 col*=1.-.085*step(.5,fract(vUv.y*uLow.y*.5))*(1.-shield);
 vec3 lv=vec3(19.,23.,17.);
 col=clamp(col,0.,1.);
 gl_FragColor=vec4(mix(floor(col*lv+.5)/lv,col,shield),1.); }`,
    });
    /* Sensor auto-gain: the dashcam POV source is dark twice over — the
       night exposure upstream, then this degrade's own crush — and the
       visibility floor/grain/lamp tweaks above operate on the *result*, so
       they can only dress up detail that's already gone. Real dashcams
       compensate with sensor gain: this brightens the frame the whole POV
       chain (smear, crush, grain) is built from, so the murk downstream
       comes from cheap-camera processing rather than the image having
       nothing left in it. Highlights clipping harder off the back of this
       is correct — the smear pass below is what a real over-gained sensor's
       blown-out lamps look like. */
    this.povSrcMat = new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null }, uGain: { value: 1.25 } },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tIn; uniform float uGain;
void main(){ gl_FragColor=vec4(texture2D(tIn,vUv).rgb*uGain,1.0); }`,
    });
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null } },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tIn;
void main(){ gl_FragColor=vec4(texture2D(tIn,vUv).rgb,1.0); }`,
    });
    this.makeTargets(false);
  }

  makeTargets(perfMode: boolean) {
    const r = this.renderer;
    const w = Math.floor(innerWidth * r.getPixelRatio());
    const h = Math.floor(innerHeight * r.getPixelRatio());
    this.perf = perfMode;
    // prevRT is about to be reallocated, so whatever the blend would read on
    // the next frame is undefined — skip it once rather than blend garbage
    this.histValid = false;
    for (const rt of [
      this.sceneRT, this.brightRT, this.blurA, this.blurB,
      this.haloA, this.haloB,
      this.reflectRT, this.ldrRT, this.fxaaRT, this.mbRT, this.prevRT,
      this.dashRT, this.softA, this.softB, this.povA, this.povB,
    ])
      rt?.dispose();
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: 4,
    });
    const bw = Math.max(160, w >> 2), bh = Math.max(90, h >> 2);
    this.brightRT = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType });
    this.blurA = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType });
    this.blurB = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType });
    // the wide-halo pair for two-scale bloom lives at eighth res: at 1/64 of
    // the pixels its two extra blur iterations cost almost nothing, and the
    // resolution itself is most of the softness
    const hw = Math.max(80, w >> 3), hh = Math.max(45, h >> 3);
    this.haloA = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType });
    this.haloB = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType });
    // mobile tiers never render into the reflection RT (the engine's tier
    // gate skips the pass entirely), so its allocation drops to the perf-mode
    // quarter size there — it only exists to keep the material binding valid
    const rShift = perfMode || this.mobile ? 2 : 1;
    this.reflectRT = new THREE.WebGLRenderTarget(
      Math.max(220, w >> rShift),
      Math.max(124, h >> rShift),
      { type: THREE.HalfFloatType }
    );
    this.ldrRT = new THREE.WebGLRenderTarget(w, h);
    this.fxaaRT = new THREE.WebGLRenderTarget(w, h);
    this.mbRT = new THREE.WebGLRenderTarget(w, h);
    this.prevRT = new THREE.WebGLRenderTarget(w, h);
    this.dashRT = new THREE.WebGLRenderTarget(w, h);
    // the dashcam soft layer lives at half res (quarter on perf) — cheaper and
    // the resample itself is part of the compressed-video look
    const sw = Math.max(64, w >> (perfMode ? 2 : 1));
    const sh = Math.max(36, h >> (perfMode ? 2 : 1));
    this.softA = new THREE.WebGLRenderTarget(sw, sh);
    this.softB = new THREE.WebGLRenderTarget(sw, sh);
    /* The POV pass owns its own half-res pair rather than borrowing softA/B:
       the V-key grade can be on at the same time, and it is still holding its
       soft layer when the POV stage runs. Always half res (never quarter) —
       the "upscaled 480p" read depends on the ratio being exactly 2. */
    const pw = Math.max(64, w >> 1), ph = Math.max(36, h >> 1);
    this.povA = new THREE.WebGLRenderTarget(pw, ph);
    this.povB = new THREE.WebGLRenderTarget(pw, ph);
    this.povMat.uniforms.uLow.value.set(pw, ph);
    this.smearMat.uniforms.uRes.value.set(pw, ph);
    this.compMat.uniforms.uRes.value.set(w, h);
    this.dashMat.uniforms.uRes.value.set(w, h);
    // keep the timestamp strip a constant on-screen size
    const strip = Math.max(0.16, Math.min(0.42, 420 / (w / this.renderer.getPixelRatio())));
    this.dashMat.uniforms.uOverSize.value.set(strip, (strip * (64 / 512) * w) / h);
    // top-left: the HUD owns both bottom corners (speed / minimap)
    this.dashMat.uniforms.uOverPos.value.set(0.022, 0.925);
    // the POV strip shares the mild pass's placement and on-screen size, so
    // toggling V mid-drive never moves the timestamp
    this.povMat.uniforms.uOverPos.value.copy(this.dashMat.uniforms.uOverPos.value);
    this.povMat.uniforms.uOverSize.value.copy(this.dashMat.uniforms.uOverSize.value);
  }

  /** Mobile-tier render-target policy. The cockpit mirror drops to half
   * resolution (160x64 — resized in place via setSize so the texture object
   * the cockpit glass material holds stays valid), and makeTargets() reads
   * the flag to shrink the reflection RT allocation. Returns true when the
   * flag actually changed so the caller knows the screen-sized targets need
   * a makeTargets() rebuild (the engine forces one through its lastPR path,
   * which also re-binds the reflection texture on the road materials). */
  setMobile(on: boolean): boolean {
    if (on === this.mobile) return false;
    this.mobile = on;
    this.mirrorRT.setSize(on ? 160 : 320, on ? 64 : 128);
    return true;
  }

  /** Tier wiring for the desktop-only cinematic extras (two-scale bloom and
   * the film-look finishers). The engine feeds tierCaps.dualBloom /
   * tierCaps.filmLook here at construction and on every settings apply, so a
   * manual tier flip lands the same frame. With both false the pipeline is
   * bit-identical to the pre-cinema composite: the halo passes never run and
   * every uFilm* uniform reads 0. */
  setCinema(dualBloom: boolean, filmLook: boolean) {
    this.cineDual = dualBloom && DUAL_BLOOM;
    this.cineFilm = filmLook;
    if (filmLook && FILM_DIRT && !this.dirtLoadStarted) {
      this.dirtLoadStarted = true;
      new THREE.TextureLoader().load(
        DIRT_URL,
        (tex) => {
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          this.dirtTex = tex;
          this.compMat.uniforms.tDirt.value = tex;
        },
        undefined,
        () => {
          /* fetch failed (offline dev, asset missing) — the uniform gate in
             process() keeps uFilmDirt at 0 and the overlay simply never runs */
        }
      );
    }
  }

  /** Per-frame speed feed for the speed-perception cues (peripheral radial
   * blur, speed vignette, motion-blur strengthening) below. engine.ts should
   * call this once per frame, before process(), e.g.:
   *   this.post.setSpeed(Math.abs(this.car.u) * 3.6);
   */
  setSpeed(kmh: number) {
    this.speedKmh = kmh;
  }

  /** Force (or release) the extreme evidence-footage degrade. engine.ts calls
   * this every frame off camMode; it is independent of the `grade` flag, which
   * keeps driving the milder V-key look for the other views. Toggling also
   * invalidates the frame-blend history, so the camera jump in or out of the
   * POV mount cuts cleanly instead of smearing across ~15 frames at the very
   * high blend factor this mode runs. */
  setDashcamPov(on: boolean) {
    if (on === this.pov) return;
    this.pov = on;
    this.histValid = false;
  }

  /** Hand over the cockpit's rear-view glass mesh and the main camera for the
   * POV shield. engine.buildRig calls this on construction and again on every
   * car swap; the glass's projected quad is then derived fresh each POV frame
   * in shieldRect(), so nothing here hardcodes screen pixels. */
  setPovMirror(mesh: THREE.Mesh | null, cam: THREE.Camera | null) {
    this.panels[PANEL_MIRROR].get = mesh ? () => mesh : NO_PANEL;
    this.mirCam = cam;
  }

  /** Hand over the head unit's screen for the POV shield — the same treatment
   * the mirror gets, and for the same reason: it is an instrument the player
   * reads, not scenery, and the degrade's half-res snap plus bit-crush is what
   * turns a map into mush. Takes a resolver rather than a mesh because which
   * mesh IS the screen can change after the rig is built: a donor dash
   * (cockpitmodel.ts) loads asynchronously, hides the procedural tablet and
   * re-binds the nav canvas onto its own panel. Called once per rig build,
   * evaluated once per POV frame. */
  setPovScreen(get: (() => THREE.Mesh | null) | null) {
    this.panels[PANEL_SCREEN].get = get ?? NO_PANEL;
  }

  /** Project shield panel `i`'s corners through the active camera and write the
   * resulting screen-UV rect into the povMat + mbMat shield uniforms. Returns
   * false (that panel's shield off) when it is hidden (mirror setting off, or
   * the dash it lives on swapped out), unset, or off/behind the frustum.
   * Called once per POV frame per panel, after the scene render, so
   * mesh.matrixWorld and camera.matrixWorldInverse are both current: the POV
   * bracket, the glass and the head unit are rigid on the same body shell,
   * making the rects static frame-to-frame, but deriving them live means
   * resizes, DPR/FOV changes, car swaps, the donor-dash swap and any future
   * repositioning are all tracked for free (cost: eight Vector3 projects). */
  private shieldRect(i: number): boolean {
    const p = this.panels[i], cam = this.mirCam;
    const mesh = p.get();
    if (!mesh || !cam) return false;
    for (let o: THREE.Object3D | null = mesh; o; o = o.parent)
      if (!o.visible) return false;
    if (p.mesh !== mesh || !p.corners) {
      const g = mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox!;
      /* All eight bounding-box corners. Both panels are flat, so two faces of
         that box coincide and four of the eight are duplicates — but a donor's
         screen mesh is whatever the artist modelled (a curved or slightly
         boxed panel is normal), and the extra four projects are what keep the
         rect honest around it. */
      p.corners = [];
      for (let k = 0; k < 8; k++)
        p.corners.push(new THREE.Vector3(
          k & 1 ? b.max.x : b.min.x,
          k & 2 ? b.max.y : b.min.y,
          k & 4 ? b.max.z : b.min.z,
        ));
      p.mesh = mesh;
    }
    let x0 = 2, y0 = 2, x1 = -1, y1 = -1;
    for (const c of p.corners) {
      const v = this.mirV.copy(c).applyMatrix4(mesh.matrixWorld).project(cam);
      // outside the depth range ⇒ behind/at the near plane (projection has
      // flipped) — never true from the POV mount, but don't shield garbage
      if (!(v.z > -1 && v.z < 1)) return false;
      const ux = v.x * 0.5 + 0.5, uy = v.y * 0.5 + 0.5;
      x0 = Math.min(x0, ux); x1 = Math.max(x1, ux);
      y0 = Math.min(y0, uy); y1 = Math.max(y1, uy);
    }
    // offscreen test intersects with [0,1], but the uniforms keep the rect
    // overhanging the screen (softly bounded): on wide shells the glass clips
    // the right edge, and a rect clamped to 1 would put the feather ON the
    // visible glass, leaving a degraded sliver at the edge — overhang parks
    // the feather offscreen instead
    if (
      Math.min(x1, 1) - Math.max(x0, 0) < 1e-3 ||
      Math.min(y1, 1) - Math.max(y0, 0) < 1e-3
    )
      return false;
    x0 = Math.max(-0.25, x0); y0 = Math.max(-0.25, y0);
    x1 = Math.min(1.25, x1); y1 = Math.min(1.25, y1);
    for (const m of [this.povMat, this.mbMat]) {
      m.uniforms.uPanMin.value[i].set(x0, y0);
      m.uniforms.uPanMax.value[i].set(x1, y1);
    }
    return true;
  }

  /** Register a physical impact for the dashcam-glitch burst: a short,
   * randomized "physically struck camera" flourish layered on top of the POV
   * degrade (frame-jump snaps, tear lines, a dropped frame, an exposure
   * flash, a chroma-separation spike and a settling refocus wobble), all
   * driven off one decaying envelope so it collapses back to the plain POV
   * look on its own.
   *
   * severity is the impact speed in m/s (same magnitude engine.ts already
   * feeds audio.crash with — hitInfo.relSpeed / res.wallImpact). Hard gate:
   * anything under 3 m/s is a rub/scrape, not a discrete hit, and is dropped
   * here rather than by the caller, so this is safe to call unconditionally
   * from every crash site. 3-15 m/s maps to 0.3-1.0 intensity (clamped
   * above 15). Call this only while camMode is the dashcam POV — off-POV
   * calls are cheap no-ops (the shader path that reads the envelope only
   * runs under `if (pov)` below), but the engine should still gate the call
   * itself to avoid arming a burst that fires the instant the player swaps
   * into POV later.
   */
  dashcamHit(severity: number) {
    if (severity < 3) return;
    const intensity = Math.max(0.3, Math.min(1, 0.3 + (0.7 * (severity - 3)) / 12));
    // a second impact mid-burst restarts the envelope at the new severity
    // instead of layering two — exactly one glitch is ever in flight
    this.hitAt = performance.now() / 1000;
    this.hitDur = 0.3 + 0.5 * intensity; // 0.3s (soft) .. 0.8s (heavy) burst
    this.hitIntensity = intensity;
    this.hitSeed = Math.random() * 1000;
  }

  /** Repaint the burnt-in DVR strip (blinking REC dot + wall-clock stamp). */
  private updateOverlay(time: number) {
    const slot = Math.floor(time * 2);
    if (slot === this.overAt) return;
    this.overAt = slot;
    const c = this.overCv, x = c.getContext("2d")!;
    const d = new Date();
    const p2 = (n: number) => (n < 10 ? "0" : "") + n;
    const stamp =
      `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ` +
      `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    x.clearRect(0, 0, c.width, c.height);
    x.font = "bold 34px ui-monospace, Menlo, monospace";
    x.textBaseline = "middle";
    x.shadowColor = "rgba(0,0,0,.85)";
    x.shadowBlur = 4;
    if (slot % 2 === 0) {
      x.fillStyle = "#e03b32";
      x.beginPath();
      x.arc(18, 33, 11, 0, Math.PI * 2);
      x.fill();
    }
    x.fillStyle = "#e8e6da";
    x.fillText("REC", 36, 34);
    x.fillText(stamp, 112, 34);
    this.overTex.needsUpdate = true;
  }

  dispose() {
    for (const rt of [
      this.sceneRT, this.brightRT, this.blurA, this.blurB, this.reflectRT,
      this.haloA, this.haloB,
      this.ldrRT, this.fxaaRT, this.mbRT, this.prevRT, this.mirrorRT,
      this.dashRT, this.softA, this.softB, this.povA, this.povB,
    ])
      rt?.dispose();
    this.overTex.dispose();
    this.dirtTex?.dispose();
    for (const m of [
      this.brightMat, this.blurMat, this.compMat, this.fxaaMat, this.mbMat,
      this.copyMat, this.dashMat, this.smearMat, this.povMat, this.povSrcMat,
    ])
      m.dispose();
  }

  private runPass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.fsQuad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  /** sceneRT must already contain the rendered frame. */
  process(opts: {
    exposure: number; grade: boolean; bloom: boolean; fxaa: boolean;
    mblur: number; mbOn?: boolean; time: number;
    /** wall-clock seconds since the previous frame. Only the dashcam POV's
        frame blend reads it (see POV_MB_TAU) — the settings-driven motion
        blur keeps its own curve, which engine.ts already shapes by speed. */
    dt: number;
  }) {
    const u = this.compMat.uniforms;
    // two-scale bloom runs on the desktop tier only, and steps aside with the
    // reactive perf fallback the same way the third blur iteration does
    const dual = this.cineDual && !this.perf;
    if (opts.bloom) {
      this.brightMat.uniforms.tIn.value = this.sceneRT.texture;
      this.brightMat.uniforms.uExp.value = opts.exposure;
      this.runPass(this.brightMat, this.brightRT);
      this.blurMat.uniforms.uRes.value.set(this.brightRT.width, this.brightRT.height);
      // single-scale: a third ping-pong widens the glow and kills the boxy
      // quarter-res edges. Two-scale: stop at 2 — the core is *meant* to stay
      // tight (crisp taillight centres); the width moves to the halo chain.
      const iters = this.perf ? 2 : dual ? 2 : 3;
      for (let b = 0; b < iters; b++) {
        this.blurMat.uniforms.tIn.value = (b === 0 ? this.brightRT : this.blurB).texture;
        this.blurMat.uniforms.uDir.value.set(1, 0);
        this.runPass(this.blurMat, this.blurA);
        this.blurMat.uniforms.tIn.value = this.blurA.texture;
        this.blurMat.uniforms.uDir.value.set(0, 1);
        this.runPass(this.blurMat, this.blurB);
      }
      if (dual) {
        // wide halo: downsample the core to eighth res, then two more blur
        // iterations — the atmospheric glow that makes lamps read as filmed
        // through night air rather than pasted discs
        this.copyMat.uniforms.tIn.value = this.blurB.texture;
        this.runPass(this.copyMat, this.haloA);
        this.blurMat.uniforms.uRes.value.set(this.haloA.width, this.haloA.height);
        for (let b = 0; b < 2; b++) {
          this.blurMat.uniforms.tIn.value = this.haloA.texture;
          this.blurMat.uniforms.uDir.value.set(1, 0);
          this.runPass(this.blurMat, this.haloB);
          this.blurMat.uniforms.tIn.value = this.haloB.texture;
          this.blurMat.uniforms.uDir.value.set(0, 1);
          this.runPass(this.blurMat, this.haloA);
        }
      }
    }
    // 0 below 80 km/h, ramps to 1 by 200 km/h — shared by the speed vignette
    // (compMat) and the peripheral radial blur / motion-blur boost (mbMat).
    const speedT = Math.max(0, Math.min(1, (this.speedKmh - 80) / 120));
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = this.blurB.texture;
    // when the halo isn't rendered, tBloomW still needs a valid binding —
    // uHaloStr is 0 so what it samples never reaches the frame
    u.tBloomW.value = (dual ? this.haloA : this.blurB).texture;
    u.uTime.value = opts.time % 10;
    u.uGrade.value = opts.grade ? 1 : 0;
    u.uExp.value = opts.exposure;
    const bloomBase = opts.grade ? 1.15 : 0.85;
    u.uBloomStr.value = opts.bloom ? (dual ? bloomBase * DUAL_CORE_MUL : bloomBase) : 0;
    u.uHaloStr.value = opts.bloom && dual ? bloomBase * DUAL_HALO_MUL : 0;
    const film = this.cineFilm ? 1 : 0;
    /* FILM_GRAIN and FILM_TONE are NOT tier-gated, unlike the three below.
       Both are pure ALU inside a pass that runs on every tier anyway — no
       extra pass, no extra fetch, no download — so gating them bought no
       frame time, and switching them OFF did not give the mobile tiers a
       cheaper version of the look, it gave them a worse one:

       - grain: the composite's amplitude is `.018 * (1 - uFilmGrain*.45)`
         over cells of `uv*uRes*mix(.5,1.,uFilmGrain)`. At 0 that is 0.018
         over 2x2-px cells; at 1 it is 0.0099 over 1x1-px cells. The mobile
         tiers were therefore getting 1.8x the amplitude spread over 4x the
         cell area — coarser, louder noise than the desktop frame, on the
         smaller screen.
       - tone: with uFilmTone at 0 the black-point pull never runs, so the
         last ~1.5/255 of grey wash (fog floor, bounce fill) stayed in the
         frame and mobile shadows sat milky instead of closing to black.

       Together those are most of what read as a murky, hard-to-parse dashcam
       POV on a phone. Turning them on moves mobile TOWARD the authored look
       rather than away from it, which is why this is not a film-look
       concession — the POV degrade's own heavy 15 Hz grain (povMat) and its
       crushed blacks are untouched.

       uFilmVig / uFilmCA stay desktop-only because they cost legibility
       rather than frame time, and uFilmDirt because it is a real texture
       fetch plus a lazily fetched asset mobile should not download. */
    u.uFilmGrain.value = FILM_GRAIN ? 1 : 0;
    u.uFilmTone.value = FILM_TONE ? 1 : 0;
    u.uFilmVig.value = FILM_VIGNETTE ? film : 0;
    u.uFilmCA.value = FILM_CA ? film : 0;
    u.uFilmDirt.value = FILM_DIRT && this.dirtTex ? film : 0;
    u.uSpeedT.value = speedT;
    const pov = this.pov;
    /* POV shield: project the rear-view glass and the head-unit screen into
       screen UV for this frame (the scene render has already run, so
       matrixWorld/matrixWorldInverse are current). Off-POV frames force every
       strength to 0, which collapses both shielded shaders to their original,
       bit-identical arithmetic. Clarity is live-tunable per panel
       (window.__povTune.mirrorShield / .screenShield, defaults MIRROR_SHIELD /
       SCREEN_SHIELD) — at 0 a panel is exactly as it was before the shield
       existed, which is also the console A/B for judging it. */
    const povTune = readPovTune();
    const strengths = [povTune.mirrorShield, povTune.screenShield];
    for (let i = 0; i < PANELS; i++) {
      const str = pov && this.shieldRect(i) ? strengths[i] : 0;
      this.mbMat.uniforms.uPanStr.value[i] = str;
      this.povMat.uniforms.uPanStr.value[i] = str;
    }
    /* `|| pov` is STRUCTURAL, not a strength — do not remove it to disable the
       dashcam smear. The block it gates ends with `cur = this.mbRT`, and the
       POV degrade below consumes `cur` as its input ("the blended frame is the
       INPUT to the degrade, not the output"). Skipping the block leaves the
       degrade sampling a stale target and histValid unset, and the dashcam
       tears itself apart. That is exactly what happened when this was first
       switched to a bare `opts.mblur > 0.001`.

       To turn the dashcam smear OFF, zero the blend AMOUNT instead — see `mb`
       below. The pass still runs, the chain stays intact, and mixing by 0 is
       a copy. */
    const doMbSetting = opts.mblur > 0.001 || pov;
    const dash = !!opts.grade;
    // Peripheral (fovea) blur is the same trick the dashcam corners already
    // sell via the soft/chroma-bleed mix, so skip it there to avoid stacking
    // two corner-blur effects; also skip in perf mode (4 extra taps/px), and
    // in POV, where the degrade owns the entire edge treatment.
    const doPeriph = !this.perf && !dash && !pov && speedT > 0.02;
    const doFinal = doMbSetting || doPeriph;
    /* Each stage renders to screen only when nothing follows it. */
    const after = (stage: 0 | 1 | 2) =>
      (stage < 1 && opts.fxaa) || (stage < 2 && dash) || doFinal;
    this.runPass(this.compMat, after(0) ? this.ldrRT : null);
    let cur = this.ldrRT;
    if (opts.fxaa) {
      this.fxaaMat.uniforms.tIn.value = cur.texture;
      this.fxaaMat.uniforms.uRes.value.set(this.fxaaRT.width, this.fxaaRT.height);
      this.runPass(this.fxaaMat, after(1) ? this.fxaaRT : null);
      cur = this.fxaaRT;
    }
    if (dash) {
      // downsample + separable blur → the soft layer the dashcam pass leans on
      this.copyMat.uniforms.tIn.value = cur.texture;
      this.runPass(this.copyMat, this.softA);
      this.blurMat.uniforms.uRes.value.set(this.softA.width, this.softA.height);
      this.blurMat.uniforms.tIn.value = this.softA.texture;
      this.blurMat.uniforms.uDir.value.set(1, 0);
      this.runPass(this.blurMat, this.softB);
      this.blurMat.uniforms.tIn.value = this.softB.texture;
      this.blurMat.uniforms.uDir.value.set(0, 1);
      this.runPass(this.blurMat, this.softA);
      this.updateOverlay(opts.time);
      this.dashMat.uniforms.tSharp.value = cur.texture;
      this.dashMat.uniforms.tSoft.value = this.softA.texture;
      this.dashMat.uniforms.uTime.value = opts.time;
      this.runPass(this.dashMat, doFinal ? this.dashRT : null);
      cur = this.dashRT;
    }
    if (doFinal) {
      // strengthen the temporal streak a bit further at very high speed
      // (200+ km/h) — the base curve from engine.ts caps out at 0.42, which
      // reads a touch weak once you're well past that.
      const mbBoost = doMbSetting
        ? Math.max(0, Math.min(0.18, (this.speedKmh - 180) / 200))
        : 0;
      // POV pins the blend hard and ignores the settings curve: a cheap sensor
      // at night runs a long exposure, so everything drags. The one-frame
      // history invalidation after a view change wins over it.
      //
      // As a TIME CONSTANT, not a per-frame fraction — see POV_MB_TAU. At
      // 60 fps this is 0.6600, i.e. the value that was hardcoded here; below
      // 60 it stops over-smearing instead of dragging twice as long, which is
      // the whole point. Gated on opts.mbOn — the player's setting — and NOT
      // on opts.mblur, which the mobile tiers pin to 0 via tierCaps: that cap
      // is for the chase-camera streak, and a phone can afford one full-screen
      // blend for the exposure the night look was built around.
      const povDt = Math.min(POV_MB_DT_MAX, Math.max(POV_MB_DT_MIN, opts.dt));
      /* POV honours the setting by AMOUNT, not by skipping the pass. With
         motion blur off the retention is 0, which makes the blend a straight
         copy of the current frame — no smear, and the degrade downstream still
         gets the target it expects. This is the supported way to have a
         dashcam with no exposure drag; see the doMbSetting note above for what
         happens if you try to do it by skipping. */
      const mb = pov
        ? (opts.mbOn ? Math.exp(-povDt / POV_MB_TAU) : 0)
        : doMbSetting ? Math.min(0.6, opts.mblur + mbBoost) : 0;
      this.mbMat.uniforms.tCur.value = cur.texture;
      this.mbMat.uniforms.tPrev.value = this.prevRT.texture;
      this.mbMat.uniforms.uMB.value = this.histValid ? mb : 0;
      this.mbMat.uniforms.uPeriph.value = doPeriph ? speedT : 0;
      this.runPass(this.mbMat, this.mbRT);
      this.copyMat.uniforms.tIn.value = this.mbRT.texture;
      this.runPass(this.copyMat, this.prevRT);
      this.histValid = true;
      cur = this.mbRT;
      // in POV the blended frame is the *input* to the degrade, not the output:
      // the smear is optical and happens at the lens, the noise and the codec
      // artefacts come after it. Keeping grain out of the history also stops
      // the blend from dragging comet trails of it across the frame.
      if (!pov) this.runPass(this.copyMat, null);
    }
    if (pov) {
      // impact-glitch envelope: quadratic ease-out reaches exactly 0 at
      // hitDur (not just asymptotically small), so every hit-driven shader
      // term is bit-exact zero — and the pass is bit-identical steady-state
      // POV — the instant the burst ends, not "eventually negligible".
      const hitElapsed = performance.now() / 1000 - this.hitAt;
      const hitActive = hitElapsed >= 0 && hitElapsed < this.hitDur;
      const hitEnvT = hitActive ? hitElapsed / this.hitDur : 1;
      const hitEnv = hitActive ? (1 - hitEnvT) * (1 - hitEnvT) : 0;
      // dropped/repeated frame: during a couple of hashed windows near the
      // front of the burst, skip resampling the source into povA/povB
      // entirely and let the degrade run again on the stale texture — a
      // real held frame, not a simulated one. Same event-local ~24fps
      // bucket + seed the shader uses for its own jump gating, so the
      // "camera skipped a beat" moments line up with the frame-jump snaps.
      const hitBucket = Math.floor(hitElapsed * 24 + this.hitSeed);
      const holdFrame =
        hitActive && hitEnv > 0.2 &&
        frac(Math.sin(hitBucket * 12.9898 + this.hitSeed * 78.233) * 43758.5453) > 0.8;
      // live-tunable, read fresh every frame so console edits land immediately
      const tune = readPovTune();
      // box-downsample to half res (exact 2:1, so the bilinear tap averages a
      // clean 2x2) *with sensor gain applied here* — povSrcMat multiplies by
      // uGain instead of a plain copy, so the brightened image is what the
      // smear, crush and grain below all actually see. Highlights blow out
      // harder off the back of it; that's the smear pass doing its job on a
      // brighter source, which is the point (an over-gained sensor's lamps
      // really do smear like that).
      if (!holdFrame) {
        this.povSrcMat.uniforms.tIn.value = cur.texture;
        this.povSrcMat.uniforms.uGain.value = tune.sensorGain;
        this.runPass(this.povSrcMat, this.povA);
        this.smearMat.uniforms.tIn.value = this.povA.texture;
        this.runPass(this.smearMat, this.povB);
      }
      if (!dash) this.updateOverlay(opts.time);
      this.povMat.uniforms.uOverAmt.value = dash ? 0 : 1;
      this.povMat.uniforms.tLow.value = this.povA.texture;
      this.povMat.uniforms.tSmear.value = this.povB.texture;
      // the mirror shield's clean layer: the full-res pre-degrade frame (cur
      // is always mbRT here — POV forces doFinal on). Live even on holdFrame
      // frames, which is right: the DVR "drops a frame" but the shielded
      // glass is presented as unmangled optics, not part of the encode.
      this.povMat.uniforms.tFull.value = cur.texture;
      // wrapped: the noise clock is floor(t*15) and float precision in the
      // hash falls apart once the session has been up for a few hours
      this.povMat.uniforms.uTime.value = opts.time % 60;
      this.povMat.uniforms.uHitEnv.value = hitEnv;
      this.povMat.uniforms.uHitSeed.value = this.hitSeed;
      this.povMat.uniforms.uHitT.value = hitActive ? hitElapsed : 0;
      this.povMat.uniforms.uGainFloor.value = tune.gainFloor;
      this.povMat.uniforms.uShadowGrain.value = tune.shadowGrain;
      this.povMat.uniforms.uLampProtect.value = tune.lampProtect;
      this.povMat.uniforms.uSkyCrush.value = tune.skyCrush;
      this.runPass(this.povMat, null);
    }
    this.renderer.setRenderTarget(null);
  }
}
