import * as THREE from "three";

/* Post pipeline (v4): the scene is rendered linear-HDR into a half-float MSAA
   target, then bright-extract → separable blur → composite (exposure, fitted
   ACES, film grade, slight CA, vignette, manual sRGB encode) → FXAA + adaptive
   sharpen → optional dashcam degrade → frame-blend motion blur → screen.

   `grade` no longer means "slightly different colours": it swaps the clean
   look for the full dashcam pass (soft cheap lens, chroma bleed, sensor noise,
   crushed highlights, rolling-shutter wobble, burnt-in timestamp). */

const VSH = "varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }";

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
  private perf = false;
  private speedKmh = 0;
  private overCv: HTMLCanvasElement;
  private overTex: THREE.CanvasTexture;
  private overAt = -1;

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
    for (const rt of [
      this.sceneRT, this.brightRT, this.blurA, this.blurB,
      this.reflectRT, this.ldrRT, this.fxaaRT, this.mbRT, this.prevRT,
      this.dashRT, this.softA, this.softB,
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
    this.compMat.uniforms.uRes.value.set(w, h);
    this.dashMat.uniforms.uRes.value.set(w, h);
    // keep the timestamp strip a constant on-screen size
    const strip = Math.max(0.16, Math.min(0.42, 420 / (w / this.renderer.getPixelRatio())));
    this.dashMat.uniforms.uOverSize.value.set(strip, (strip * (64 / 512) * w) / h);
    // top-left: the HUD owns both bottom corners (speed / minimap)
    this.dashMat.uniforms.uOverPos.value.set(0.022, 0.925);
  }

  /** Per-frame speed feed for the speed-perception cues (peripheral radial
   * blur, speed vignette, motion-blur strengthening) below. engine.ts should
   * call this once per frame, before process(), e.g.:
   *   this.post.setSpeed(Math.abs(this.car.u) * 3.6);
   */
  setSpeed(kmh: number) {
    this.speedKmh = kmh;
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
      this.dashRT, this.softA, this.softB,
    ])
      rt?.dispose();
    this.overTex.dispose();
    for (const m of [
      this.brightMat, this.blurMat, this.compMat, this.fxaaMat, this.mbMat,
      this.copyMat, this.dashMat,
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
    const doMbSetting = opts.mblur > 0.001;
    const dash = !!opts.grade;
    // Peripheral (fovea) blur is the same trick the dashcam corners already
    // sell via the soft/chroma-bleed mix, so skip it there to avoid stacking
    // two corner-blur effects; also skip in perf mode (4 extra taps/px).
    const doPeriph = !this.perf && !dash && speedT > 0.02;
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
      this.mbMat.uniforms.tCur.value = cur.texture;
      this.mbMat.uniforms.tPrev.value = this.prevRT.texture;
      this.mbMat.uniforms.uMB.value = doMbSetting ? Math.min(0.6, opts.mblur + mbBoost) : 0;
      this.mbMat.uniforms.uPeriph.value = doPeriph ? speedT : 0;
      this.runPass(this.mbMat, this.mbRT);
      this.copyMat.uniforms.tIn.value = this.mbRT.texture;
      this.runPass(this.copyMat, this.prevRT);
      this.runPass(this.copyMat, null);
    }
    this.renderer.setRenderTarget(null);
  }
}
