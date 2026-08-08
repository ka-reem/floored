import * as THREE from "three";

/* Post pipeline (v3): the scene is rendered linear-HDR into a half-float MSAA
   target, then bright-extract → separable blur → composite (exposure, ACES,
   chromatic aberration, dashcam grade, vignette, grain, manual sRGB encode)
   → FXAA → frame-blend motion blur → screen. */

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

  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fsQuad: THREE.Mesh;

  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private fxaaMat: THREE.ShaderMaterial;
  private mbMat: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.fsScene.add(this.fsQuad);
    this.mirrorRT = new THREE.WebGLRenderTarget(320, 128, { type: THREE.HalfFloatType });

    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null }, uExp: { value: 1 } },
      vertexShader: VSH,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tIn; uniform float uExp;
void main(){ vec3 c=texture2D(tIn,vUv).rgb*uExp;
 float l=dot(c,vec3(.299,.587,.114));
 vec3 b=c*smoothstep(.85,2.4,l);
 gl_FragColor=vec4(b,1.); }`,
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
      },
      vertexShader: VSH,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tScene,tBloom;
uniform float uTime,uGrade,uBloomStr,uExp; uniform vec2 uRes;
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453+uTime); }
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
void main(){
 vec2 uv=vUv; vec2 d=uv-.5; float r2=dot(d,d);
 float ca=uGrade*(.0016+.006*r2);
 vec3 col; col.r=texture2D(tScene,uv+d*ca).r; col.g=texture2D(tScene,uv).g; col.b=texture2D(tScene,uv-d*ca).b;
 vec3 bl=texture2D(tBloom,uv).rgb; col=col*uExp+bl*uBloomStr;
 col=aces(col);
 col=pow(col,vec3(1./2.2));
 if(uGrade>.5){
   col=pow(col,vec3(1.06));
   float l=dot(col,vec3(.299,.587,.114));
   col=mix(vec3(l),col,1.18);
   col+=vec3(-.012,.004,.03)*(1.-l);
   col*=vec3(1.03,1.0,.97);
   col+=(hash(uv*uRes*.5)-.5)*.05;
 }
 col*=1.-r2*(uGrade>.5?.85:.45);
 gl_FragColor=vec4(col,1.); }`,
    });
    this.fxaaMat = new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv;
uniform sampler2D tIn; uniform vec2 uRes;
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
 gl_FragColor=vec4((lB<lMin||lB>lMax)?a:b,1.0);}`,
    });
    this.mbMat = new THREE.ShaderMaterial({
      uniforms: { tCur: { value: null }, tPrev: { value: null }, uMB: { value: 0 } },
      vertexShader: VSH,
      fragmentShader: `precision highp float; varying vec2 vUv;
uniform sampler2D tCur,tPrev; uniform float uMB;
void main(){ vec3 c=texture2D(tCur,vUv).rgb, p=texture2D(tPrev,vUv).rgb;
 vec3 col=mix(c,p,uMB);
 float d=distance(vUv,vec2(.5));
 col*=1.0-uMB*.55*smoothstep(.42,.95,d);
 gl_FragColor=vec4(col,1.0);}`,
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
    for (const rt of [
      this.sceneRT, this.brightRT, this.blurA, this.blurB,
      this.reflectRT, this.ldrRT, this.fxaaRT, this.mbRT, this.prevRT,
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
    this.compMat.uniforms.uRes.value.set(w, h);
  }

  dispose() {
    for (const rt of [
      this.sceneRT, this.brightRT, this.blurA, this.blurB, this.reflectRT,
      this.ldrRT, this.fxaaRT, this.mbRT, this.prevRT, this.mirrorRT,
    ])
      rt?.dispose();
    for (const m of [this.brightMat, this.blurMat, this.compMat, this.fxaaMat, this.mbMat, this.copyMat])
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
      for (let b = 0; b < 2; b++) {
        this.blurMat.uniforms.tIn.value = (b === 0 ? this.brightRT : this.blurB).texture;
        this.blurMat.uniforms.uDir.value.set(1, 0);
        this.runPass(this.blurMat, this.blurA);
        this.blurMat.uniforms.tIn.value = this.blurA.texture;
        this.blurMat.uniforms.uDir.value.set(0, 1);
        this.runPass(this.blurMat, this.blurB);
      }
    }
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = this.blurB.texture;
    u.uTime.value = opts.time % 10;
    u.uGrade.value = opts.grade ? 1 : 0;
    u.uExp.value = opts.exposure;
    u.uBloomStr.value = opts.bloom ? (opts.grade ? 1.0 : 0.75) : 0;
    const doMb = opts.mblur > 0.001;
    this.runPass(this.compMat, opts.fxaa || doMb ? this.ldrRT : null);
    let cur = this.ldrRT;
    if (opts.fxaa) {
      this.fxaaMat.uniforms.tIn.value = cur.texture;
      this.fxaaMat.uniforms.uRes.value.set(this.fxaaRT.width, this.fxaaRT.height);
      this.runPass(this.fxaaMat, doMb ? this.fxaaRT : null);
      cur = this.fxaaRT;
    }
    if (doMb) {
      this.mbMat.uniforms.tCur.value = cur.texture;
      this.mbMat.uniforms.tPrev.value = this.prevRT.texture;
      this.mbMat.uniforms.uMB.value = opts.mblur;
      this.runPass(this.mbMat, this.mbRT);
      this.copyMat.uniforms.tIn.value = this.mbRT.texture;
      this.runPass(this.copyMat, this.prevRT);
      this.runPass(this.copyMat, null);
    }
    this.renderer.setRenderTarget(null);
  }
}
