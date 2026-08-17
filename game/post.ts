import * as THREE from "three";

/* Post pipeline (v4): the scene is rendered linear-HDR into a half-float MSAA
   target, then bright-extract → separable blur → composite (exposure, fitted
   ACES, film grade, slight CA, vignette, manual sRGB encode) → FXAA + adaptive
   sharpen → optional dashcam degrade → frame-blend motion blur → screen.

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
// mirrors the GLSL h21() hash's fractional part, used JS-side to decide
// which frame buckets the dashcam impact glitch holds (see process()'s
// holdFrame) so the "dropped frame" moments track the shader's own bucketing
const frac = (x: number) => x - Math.floor(x);

/** Live console knobs for the three POV visibility tweaks (auto-gain floor,
 * shadow grain reduction, taillight protection) — each 0..1, scaling that
 * one effect's strength independently so it can be zeroed or dialed back
 * without touching the other two or redeploying. Read fresh every frame in
 * process(), so edits from the console (`window.__povTune.gainFloor = 0`)
 * take effect immediately. 1 is the shipped default for all three. */
declare global {
  interface Window {
    __povTune?: { gainFloor: number; shadowGrain: number; lampProtect: number };
  }
}
function readPovTune() {
  if (typeof window === "undefined") return { gainFloor: 1, shadowGrain: 1, lampProtect: 1 };
  if (!window.__povTune) window.__povTune = { gainFloor: 1, shadowGrain: 1, lampProtect: 1 };
  const t = window.__povTune;
  const c = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);
  return { gainFloor: c(t.gainFloor), shadowGrain: c(t.shadowGrain), lampProtect: c(t.lampProtect) };
}

export class PostFX {
  sceneRT!: THREE.WebGLRenderTarget;
  reflectRT!: THREE.WebGLRenderTarget;
  mirrorRT: THREE.WebGLRenderTarget;
  private brightRT!: THREE.WebGLRenderTarget;
  private blurA!: THREE.WebGLRenderTarget;
  private blurB!: THREE.WebGLRenderTarget;
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
  private speedKmh = 0;
  private pov = false;
  /** false for one frame after a hard view change: the temporal blend is
      skipped so a camera teleport cuts instead of dragging a ghost. */
  private histValid = false;
  private overCv: HTMLCanvasElement;
  private overTex: THREE.CanvasTexture;
  private overAt = -1;
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
        tScene: { value: null }, tBloom: { value: null }, uTime: { value: 0 },
        uGrade: { value: 1 }, uExp: { value: 1.12 },
        uRes: { value: new THREE.Vector2(1, 1) }, uBloomStr: { value: 1.0 },
        uSpeedT: { value: 0 },
      },
      vertexShader: VSH,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tScene,tBloom;
uniform float uTime,uGrade,uBloomStr,uExp,uSpeedT; uniform vec2 uRes;
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
 float ca=.0008+.0026*r2;
 vec3 col; col.r=texture2D(tScene,uv+d*ca).r; col.g=texture2D(tScene,uv).g; col.b=texture2D(tScene,uv-d*ca).b;
 vec3 bl=texture2D(tBloom,uv).rgb; col=col*uExp+bl*uBloomStr;
 col=aces(col);
 col=pow(col,vec3(1./2.2));
 // film grade: gentle S-curve, split-tone (cool shadows / warm highlights),
 // slight vibrance. Applied in both modes; the dashcam pass degrades on top.
 float l=dot(col,vec3(.2126,.7152,.0722));
 col=mix(col,col*col*(3.-2.*col),.22);
 col+=vec3(-.010,-.002,.016)*(1.-smoothstep(0.,.45,l));
 col+=vec3(.014,.006,-.010)*smoothstep(.55,1.,l);
 float sat=mix(1.16,1.0,smoothstep(.25,.9,l));
 // speed vignette: rising edge saturation reads as tunnel-vision colour
 // punch without a hard mask, cheap since r2 is already computed above
 sat+=uSpeedT*r2*.55;
 col=mix(vec3(dot(col,vec3(.2126,.7152,.0722))),col,sat);
 col+=(hash(uv*uRes*.5)-.5)*(uGrade>.5?.012:.018)*(1.-l*.7);
 col*=1.-r2*(uGrade>.5?.30:.42)-r2*uSpeedT*.16;
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
      },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv;
uniform sampler2D tCur,tPrev; uniform float uMB,uPeriph;
// approx vanishing point: the horizon sits a little above true screen
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
 vec3 col=mix(c,p,uMB);
 col*=1.0-uMB*.55*smoothstep(.42,.95,r);
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
        // POV visibility trio (each 0..1, independently tunable live via
        // window.__povTune — see readPovTune() below). 1 = the shipped
        // effect at full strength, 0 = off, so any one item can be zeroed
        // without touching the other two.
        uGainFloor: { value: 1 }, uShadowGrain: { value: 1 }, uLampProtect: { value: 1 },
      },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv;
uniform sampler2D tLow,tSmear,tOver; uniform vec2 uLow,uOverPos,uOverSize;
uniform float uTime,uOverAmt,uHitEnv,uHitSeed,uHitT;
uniform float uGainFloor,uShadowGrain,uLampProtect;
float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
void main(){
 vec2 d=vUv-.5; float r2=dot(d,d);
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
 // interlace comb, then (e) the bit-crush. Quantising last is what makes the
 // banding survive; the uneven per-channel level counts tint the bands.
 col*=1.-.085*step(.5,fract(vUv.y*uLow.y*.5));
 vec3 lv=vec3(19.,23.,17.);
 gl_FragColor=vec4(floor(clamp(col,0.,1.)*lv+.5)/lv,1.); }`,
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
    this.reflectRT = new THREE.WebGLRenderTarget(
      Math.max(220, w >> (perfMode ? 2 : 1)),
      Math.max(124, h >> (perfMode ? 2 : 1)),
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
      this.ldrRT, this.fxaaRT, this.mbRT, this.prevRT, this.mirrorRT,
      this.dashRT, this.softA, this.softB, this.povA, this.povB,
    ])
      rt?.dispose();
    this.overTex.dispose();
    for (const m of [
      this.brightMat, this.blurMat, this.compMat, this.fxaaMat, this.mbMat,
      this.copyMat, this.dashMat, this.smearMat, this.povMat,
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
    mblur: number; time: number;
  }) {
    const u = this.compMat.uniforms;
    if (opts.bloom) {
      this.brightMat.uniforms.tIn.value = this.sceneRT.texture;
      this.brightMat.uniforms.uExp.value = opts.exposure;
      this.runPass(this.brightMat, this.brightRT);
      this.blurMat.uniforms.uRes.value.set(this.brightRT.width, this.brightRT.height);
      // a third ping-pong widens the glow and kills the boxy quarter-res edges
      const iters = this.perf ? 2 : 3;
      for (let b = 0; b < iters; b++) {
        this.blurMat.uniforms.tIn.value = (b === 0 ? this.brightRT : this.blurB).texture;
        this.blurMat.uniforms.uDir.value.set(1, 0);
        this.runPass(this.blurMat, this.blurA);
        this.blurMat.uniforms.tIn.value = this.blurA.texture;
        this.blurMat.uniforms.uDir.value.set(0, 1);
        this.runPass(this.blurMat, this.blurB);
      }
    }
    // 0 below 80 km/h, ramps to 1 by 200 km/h — shared by the speed vignette
    // (compMat) and the peripheral radial blur / motion-blur boost (mbMat).
    const speedT = Math.max(0, Math.min(1, (this.speedKmh - 80) / 120));
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = this.blurB.texture;
    u.uTime.value = opts.time % 10;
    u.uGrade.value = opts.grade ? 1 : 0;
    u.uExp.value = opts.exposure;
    u.uBloomStr.value = opts.bloom ? (opts.grade ? 1.15 : 0.85) : 0;
    u.uSpeedT.value = speedT;
    const pov = this.pov;
    // POV forces the frame blend on even with motion blur switched off in
    // settings — the smear is part of the camera, not a quality option
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
      const mb = pov ? 0.66 : doMbSetting ? Math.min(0.6, opts.mblur + mbBoost) : 0;
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
      // box-downsample to half res (exact 2:1, so the bilinear tap averages a
      // clean 2x2), build the highlight streak layer off it, then degrade
      if (!holdFrame) {
        this.copyMat.uniforms.tIn.value = cur.texture;
        this.runPass(this.copyMat, this.povA);
        this.smearMat.uniforms.tIn.value = this.povA.texture;
        this.runPass(this.smearMat, this.povB);
      }
      if (!dash) this.updateOverlay(opts.time);
      this.povMat.uniforms.uOverAmt.value = dash ? 0 : 1;
      this.povMat.uniforms.tLow.value = this.povA.texture;
      this.povMat.uniforms.tSmear.value = this.povB.texture;
      // wrapped: the noise clock is floor(t*15) and float precision in the
      // hash falls apart once the session has been up for a few hours
      this.povMat.uniforms.uTime.value = opts.time % 60;
      this.povMat.uniforms.uHitEnv.value = hitEnv;
      this.povMat.uniforms.uHitSeed.value = this.hitSeed;
      this.povMat.uniforms.uHitT.value = hitActive ? hitElapsed : 0;
      // live-tunable, read fresh every frame so console edits land immediately
      const tune = readPovTune();
      this.povMat.uniforms.uGainFloor.value = tune.gainFloor;
      this.povMat.uniforms.uShadowGrain.value = tune.shadowGrain;
      this.povMat.uniforms.uLampProtect.value = tune.lampProtect;
      this.runPass(this.povMat, null);
    }
    this.renderer.setRenderTarget(null);
  }
}
