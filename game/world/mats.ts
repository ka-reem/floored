import * as THREE from "three";
import {
  roadTex, hwyTexF, rampTexF, windowsTexF, storefrontTexF, vendingTexF, glowTexF,
  streakTexF, smokeTexF, envFaceCanvas, chevTexF, goreTexF, xingTexF, studTexF,
  fenceTexF, loadPbrSet, type PbrSet,
} from "../textures";

/* Shared materials + textures. Planar-reflection sampling is injected into the
   road materials here (ported from v2, adapted to the linear HDR pipeline).

   ---------------------------------------------------------------------------
   Photo-scanned PBR
   ---------------------------------------------------------------------------
   Real scans under public/assets/pbr/<set>/{albedo,normal,rough,metal}.jpg are
   loaded asynchronously and layered on top of the procedural canvas art. If
   the files are absent every material stays exactly as it was, so the game is
   fully playable with an empty assets directory — the procedural path is both
   the fallback and the perf-mode path.

   Two different upgrade strategies are used, because the road textures are not
   interchangeable with a photo scan:

   - ROAD SURFACES keep their procedural albedo, because the lane markings are
     painted into it (town streets and ramps) and swapping in a photo would
     erase them. Instead the scan is applied as a *detail* layer multiplied
     over the procedural colour, normalised by the scan's own mean luminance so
     it contributes grain and grit without shifting the tuned brightness. The
     scan's normal and roughness maps are applied for real, on their own UV
     repeat, which is where most of the realism actually comes from.

   - CONCRETE AND METAL get the scan as a straight albedo replacement, since
     none of that art carries markings.

   The roughness map does double duty: it drives the wet-road reflection, so
   the smooth patches of a scan mirror the world back harder than the coarse
   aggregate around them. That is what reads as standing water. */

/** Where a scan is applied and at what density. */
interface PbrOpts {
  /** texture repeats per 1 unit of the mesh's existing UV */
  repeat: [number, number];
  /** normal map strength. Highways are near-flat; keep this low. */
  normalScale?: number;
  /** strength of the detail-albedo multiply, 0..1 (road surfaces only) */
  detail?: number;
  /** dry-road target roughness, renormalised against the scan's own mean */
  roughness?: number;
  /** how strongly the roughness map modulates the wet reflection, 0..1 */
  roughMod?: number;
}

export interface Mats {
  envMap: THREE.CubeTexture;
  glowTex: THREE.Texture;
  streakTex: THREE.Texture;
  smokeTex: THREE.Texture;
  chevTex: THREE.Texture;
  goreTex: THREE.Texture;
  xingTex: THREE.Texture;
  studTex: THREE.Texture;
  road: THREE.MeshStandardMaterial;
  front: THREE.MeshStandardMaterial;
  hwy: THREE.MeshStandardMaterial;
  ramp: THREE.MeshStandardMaterial;
  ground: THREE.MeshStandardMaterial;
  sidewalk: THREE.MeshStandardMaterial;
  conc: THREE.MeshStandardMaterial;
  concDark: THREE.MeshStandardMaterial;
  barrier: THREE.MeshStandardMaterial;
  soundwall: THREE.MeshStandardMaterial;
  pole: THREE.MeshStandardMaterial;
  /** double-sided concrete, for the deck fascia (was a local conc.clone()) */
  concDouble: THREE.MeshStandardMaterial;
  /** double-sided dark concrete, for the ramp skirts (was a concDark.clone()) */
  concDarkDouble: THREE.MeshStandardMaterial;
  /** double-sided barrier concrete, for the parapets (was a barrier.clone()) */
  barrierDouble: THREE.MeshStandardMaterial;
  /** tunnel tube lining */
  tunnelWall: THREE.MeshStandardMaterial;
  tunnelCeil: THREE.MeshStandardMaterial;
  /** perforated-steel sound-barrier panelling — alphaTest cutout, never blend.
      Beam-responsive: headlights catch the mesh the way they catch real
      galvanised panels. Fed by the Fence007A scan when it lands. */
  fence: THREE.MeshStandardMaterial;
  /** corrugated-steel toll canopy roof (CorrugatedSteel009 when it lands) */
  canopyRoof: THREE.MeshStandardMaterial;
  /** brushed-panel canopy fascia (MetalPlates003 when it lands) */
  canopyFascia: THREE.MeshStandardMaterial;
  /** grated-catwalk decking for gantry walkways — alphaTest cutout */
  catwalk: THREE.MeshStandardMaterial;
  /** additive sprite material for retroreflective raised pavement markers */
  studMat: THREE.PointsMaterial;
  /** as studMat, for the tunnel span — never daylight-dimmed, see mats.ts */
  studMatTunnel: THREE.PointsMaterial;
  /** lane paint: stripes, hatching, gore chevrons. Retroreflective. */
  markMat: THREE.MeshBasicMaterial;
  /** opt a material into headlight retroreflection (see setBeam) */
  addBeam(mat: THREE.Material, opts?: { near?: number; far?: number; spread?: number }): void;
  /**
   * Point the headlight beam. Retroreflective paint returns light to its
   * source, so markings are bright only where the beam actually lands —
   * call this per frame with the car's head position and forward axis.
   * `dayF` is the engine's 0..1 daylight factor; at noon the effect washes
   * out to uniform brightness, because sunlight lights the paint anyway.
   * Never calling it leaves every marking at today's flat brightness.
   *
   * `unlitFloor` is how bright paint sits at night *outside* the beam, 0..1.
   * It belongs to whoever owns the night lighting: every material here is
   * unlit, so scene ambient cannot reach them and this is the only knob that
   * dims them. Raise it if the unlit dashes read as dead, lower it for a
   * harder beam edge.
   *
   * `range` scales every material's authored near/far together — pass the
   * ratio of the current headlight throw to the dipped-beam throw, so main
   * beam lights the paint as far down the road as it lights the road itself.
   * Derive it from the same constants that set the spotlight distance rather
   * than hardcoding a number, or the two will drift apart.
   */
  setBeam(
    on: boolean, pos: THREE.Vector3, dir: THREE.Vector3, dayF: number,
    unlitFloor?: number, range?: number
  ): void;
  winMats: THREE.MeshStandardMaterial[];
  sfMat: THREE.MeshStandardMaterial;
  vendMat: THREE.MeshStandardMaterial;
  clutterMat: THREE.MeshStandardMaterial;
  refMats: THREE.MeshStandardMaterial[];
  addReflection(mat: THREE.MeshStandardMaterial, strength: number): void;
  setReflectionTexture(tex: THREE.Texture): void;
  setReflectionScreen(w: number, h: number): void;
  setWet(on: boolean, reflectionsOn: boolean): void;
  /** Drop the scanned normal/detail layers when the frame budget is blown.
      Passing `true` also starts the scan load if `buildMats({ pbr: false })`
      deferred it, so the low preset can skip the download entirely and still
      be raised to high later. */
  setPbrDetail(on: boolean): void;
}

/** Per-material PBR bookkeeping, hung off material.userData. */
interface RoadUD {
  refStr: number;
  curStr: number;
  /** dry-road target roughness before the scan's mean is divided out */
  dryRough: number;
  /** 1 / mean of the roughness map; 1 while procedural */
  roughK: number;
  /** mean linear luminance of the detail albedo */
  detMean: number;
  detK: number;
  detRep: THREE.Vector2;
  detTex: THREE.Texture | null;
  roughMod: number;
  /** wet-state-scaled roughMod actually driving the shader (see setWet) */
  curRoughMod?: number;
  /** longitudinal wheel-path streaking amplitude, 0 = off */
  grooveAmt: number;
  /** streak frequency, in radians per unit of the mesh's u axis */
  grooveFreq: number;
  /** the scan's normal map, parked here so perf mode can pull and restore it */
  normalTex: THREE.Texture | null;
  /* three ships no bundled typings, so the shader-parameters object that
     onBeforeCompile hands back has no type to name here */
  sh?: { uniforms: Record<string, { value: unknown }> };
}

/**
 * @param opts.pbr Pass `false` to defer the photo-scan download rather than
 *   cancel it — nothing is fetched until `setPbrDetail(true)` asks for it. That
 *   is the honest binding for the low preset: a weak device pays neither the
 *   ~5 MB transfer nor the texture memory, but raising the quality setting
 *   later still upgrades the world, so the choice stays reversible.
 */
export function buildMats(opts?: { pbr?: boolean }): Mats {
  const usePbr = opts?.pbr !== false;

  const envMap = new THREE.CubeTexture([
    envFaceCanvas(), envFaceCanvas(), envFaceCanvas(true),
    envFaceCanvas(false), envFaceCanvas(), envFaceCanvas(),
  ]);
  envMap.needsUpdate = true;

  const glowTex = glowTexF();
  const streakTex = streakTexF();
  const smokeTex = smokeTexF();
  const chevTex = chevTexF();
  const goreTex = goreTexF();
  const xingTex = xingTexF();
  const studTex = studTexF();

  const roadT = roadTex();
  roadT.repeat.set(1, 1);
  const frontT = roadTex();
  const hwyT = hwyTexF();
  const rampT = rampTexF();
  rampT.repeat.set(1, 2);

  const refMats: THREE.MeshStandardMaterial[] = [];
  let pendingRefTex: THREE.Texture | null = null;
  const screen = new THREE.Vector2(1, 1);
  let detailOn = true;
  let pbrStarted = false;

  const ud = (m: THREE.MeshStandardMaterial) => m.userData as unknown as RoadUD;

  /* ---------------- road surface shader ---------------- */

  function reflectionUniforms(mat: THREE.MeshStandardMaterial, strength: number) {
    const d = ud(mat);
    d.refStr = strength;
    d.curStr = strength;
    d.dryRough ??= mat.roughness;
    d.roughK ??= 1;
    d.detMean ??= 1;
    d.detK ??= 0;
    d.detRep ??= new THREE.Vector2(1, 1);
    d.detTex ??= null;
    d.normalTex ??= null;
    d.roughMod ??= 0;
    d.grooveAmt ??= 0;
    d.grooveFreq ??= 0;

    mat.onBeforeCompile = (sh) => {
      const hasDet = detailOn && !!d.detTex;
      const hasRough = !!mat.roughnessMap && d.roughMod > 0;
      const hasGroove = detailOn && d.grooveAmt > 0;
      sh.uniforms.tRef = { value: pendingRefTex };
      sh.uniforms.uRefStr = { value: d.curStr };
      sh.uniforms.uScreen = { value: screen };
      sh.uniforms.tDet = { value: hasDet ? d.detTex : null };
      sh.uniforms.uDetRep = { value: d.detRep };
      sh.uniforms.uDetK = { value: hasDet ? d.detK : 0 };
      sh.uniforms.uDetMean = { value: d.detMean };
      // the reference the roughness map is compared against: the dry/wet
      // target itself, so a texel sitting at the map's mean gives a ratio of
      // exactly 1 and the tuned reflection strength is left alone
      sh.uniforms.uRoughRef = { value: mat.roughness * (d.roughK > 0 ? 1 / d.roughK : 1) };
      // curRoughMod tracks the wet state (see setWet); the game boots dry
      sh.uniforms.uRoughMod = { value: hasRough ? (d.curRoughMod ?? d.roughMod * 0.15) : 0 };
      sh.uniforms.uGrooveAmt = { value: d.grooveAmt };
      sh.uniforms.uGrooveF = { value: d.grooveFreq };
      d.sh = sh;

      sh.fragmentShader = sh.fragmentShader.replace(
        "#include <common>",
        "#include <common>\n" +
          "uniform sampler2D tRef; uniform float uRefStr; uniform vec2 uScreen;\n" +
          (hasDet
            ? "uniform sampler2D tDet; uniform vec2 uDetRep; uniform float uDetK; uniform float uDetMean;\n"
            : "") +
          (hasRough ? "uniform float uRoughRef; uniform float uRoughMod;\n" : "") +
          (hasGroove ? "uniform float uGrooveAmt; uniform float uGrooveF;\n" : "")
      );

      if (hasGroove) {
        /* Longitudinal streaking in the headlight pool.
           A real motorway surface is not isotropic: traffic polishes the wheel
           paths into fine lines running with the direction of travel, and a
           tined concrete deck is grooved the same way on purpose. Either way
           the night read is identical — the beam picks out fine bright/dark
           streaks running away from the car. This modulates roughness rather
           than perturbing the normal, so it costs one sin() and also rides the
           wet-reflection term, which is right: water sits in the low lines.

           Faded out past ~26 m, and not only for cost. It is analytic detail
           with no mip chain behind it, so at distance it would alias into
           crawling moire at exactly the speeds this game runs at. Fading it to
           nothing before it gets small is what keeps it stable — and it also
           happens to be where the real effect stops being visible. */
        sh.fragmentShader = sh.fragmentShader.replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\n" +
            "float gFade = 1.0 - smoothstep(10.0, 26.0, length(vViewPosition));\n" +
            "roughnessFactor *= 1.0 + sin(vMapUv.x * uGrooveF) * uGrooveAmt * gFade;\n" +
            "roughnessFactor = clamp(roughnessFactor, 0.02, 1.0);"
        );
      }

      if (hasDet) {
        /* Detail albedo. Dividing by the scan's mean luminance makes this a
           unit-mean multiply: it adds the photograph's grain and blotching to
           the procedural colour without darkening or lifting it, which is what
           lets a scan drop in over art that was hand-tuned under a different
           pipeline and still land at the same exposure. */
        sh.fragmentShader = sh.fragmentShader.replace(
          "#include <map_fragment>",
          "#include <map_fragment>\n" +
            "vec3 detC = texture2D(tDet, vMapUv * uDetRep).rgb;\n" +
            "diffuseColor.rgb *= mix(vec3(1.0), detC / max(uDetMean, 1e-3), uDetK);"
        );
      }

      sh.fragmentShader = sh.fragmentShader.replace(
        "#include <dithering_fragment>",
        "vec2 sUV=gl_FragCoord.xy/uScreen; sUV.x=1.0-sUV.x;" +
          "vec3 refC=texture2D(tRef,sUV).rgb;" +
          "float ndv=clamp(dot(normalize(vNormal),normalize(vViewPosition)),0.,1.);" +
          "float fr=uRefStr*pow(1.0-ndv,2.0);" +
          (hasRough
            ? /* Puddle modulation. roughnessFactor is the scan's roughness at
                 this texel; where it dips below the map's mean the surface is
                 locally smoother — a worn-smooth patch or standing water — and
                 mirrors the world back harder, while coarse aggregate scatters
                 it away. Capped at 3x so a near-black texel cannot turn a patch
                 into a perfect mirror. */
              "fr*=mix(1.0, clamp(uRoughRef/max(roughnessFactor,0.02),0.0,3.0), uRoughMod);"
            : "") +
          "fr=clamp(fr,0.,1.);" +
          /* Real asphalt only visibly mirrors concentrated LIGHT SOURCES —
             lamps, tail-lights, lit signs. Broad dim content (the sky band,
             the skyline glow) reflects too, but at road reflectance it is
             far below what the eye picks up; reflecting it here painted a
             hard-edged bright patch across the road at grazing angles (the
             "white box that vanishes as you approach" bug). Gate the
             reflected colour by its own luminance so point lights keep
             their streaks and area glow contributes almost nothing, and cap
             the sky-dominant blue channel's share so what remains cannot
             read as a pale slab. */
          "float rl=dot(refC,vec3(.299,.587,.114));" +
          "refC*=smoothstep(.20,.60,rl);" +
          "fr*=mix(.25,1.,smoothstep(.14,.45,rl));" +
          // blend toward the reflection instead of stacking it on top —
          // additive stacking let a bright reflected highlight (e.g. the
          // car's own tail-lights) blow the pixel out to solid white,
          // especially at grazing angles on wet roads where fr is near 1
          "gl_FragColor.rgb=mix(gl_FragColor.rgb,refC,fr);\n#include <dithering_fragment>"
      );
    };
    // three keys its program cache partly on this; without it the detail and
    // puddle variants would collide with the plain one after a hot upgrade
    mat.customProgramCacheKey = () =>
      `road|${detailOn && d.detTex ? 1 : 0}|${mat.roughnessMap && d.roughMod > 0 ? 1 : 0}` +
      `|${detailOn && d.grooveAmt > 0 ? 1 : 0}`;
    refMats.push(mat);
  }

  /* ---------------- headlight retroreflection ---------------- */

  /* Shared per-frame uniforms. Every beam material is handed the *same*
     uniform objects, so setBeam() mutates one value and all of them follow —
     no per-material loop on the hot path. Only the static range/spread
     uniforms are per material. */
  const uBeamPos = { value: new THREE.Vector3() };
  const uBeamDir = { value: new THREE.Vector3(0, 0, 1) };
  const uBeamAmb = { value: 1 };
  const uBeamK = { value: 0 };
  /* Scales every material's authored near/far together. Main beam throws
     roughly 1.7x further than dipped, and without this the paint's
     retroreflective response would die at its dipped range in a stretch of
     road the player can plainly see is lit — the beam disagreeing with the
     light pool, the same failure as getting the origin wrong. A uniform and
     not a per-material `far`, deliberately: `far` is in the program cache key,
     so varying it would recompile, and flash-to-pass would hitch on every
     flash. */
  const uBeamRange = { value: 1 };

  /**
   * Modulate a material's brightness by whether the headlight beam lands on
   * it. Retroreflective paint and cat's eyes bounce light straight back to
   * the source rather than scattering it, which is why in a night photograph
   * the lane line is blazing inside the beam and nearly gone just outside it —
   * the single strongest night-road cue there is, and the one thing uniformly
   * bright markings can never produce.
   *
   * Works on MeshBasicMaterial and PointsMaterial alike: both shaders carry
   * <worldpos_vertex> and <color_fragment>, which is all this needs.
   * Inert until setBeam() is called — uBeamK stays 0 and the mix collapses to
   * the material's original colour, so nothing changes if it is never wired.
   *
   * `wash` switches the hook from the retro multiplier to an ADDITIVE emissive
   * term for LIT materials (the concrete parapets). The multiplier form is
   * wrong for those: outside the beam it would darken the material's ambient-
   * lit night look everywhere (a change to the whole night scene), and inside
   * the beam ×1.0 only restores a surface the real SpotLights barely reach —
   * the dipped cone is edge-pinned with penumbra 1.0, so anything off the
   * road-surface axis (a vertical barrier face, a car body) sits in the last
   * degrees before the cone rim where the angular smoothstep is ~0 (see the
   * cone comments in engine.ts weather()). So instead: add
   * `albedo × dippedTint × cone × fall × night × wash` as emissive, the same
   * matching-fake pattern as traffic.ts's washCol. It fades on the cone and
   * range smoothsteps (no hard line), is gated off in daylight and with the
   * lamps by uBeamK, and stretches with high beam via uBeamRange. The gain is
   * chosen against the POV grade: peak ≈ albedo·wash linear, and it must stay
   * well under the 0.72-display-luma blown-highlight clip (post.ts).
   */
  function addBeam(
    mat: THREE.Material,
    opts?: { near?: number; far?: number; spread?: number; wash?: number }
  ) {
    const near = opts?.near ?? 22;
    const far = opts?.far ?? 70;
    /* Cosine of the half-angle at which the beam has fallen off entirely, and
       the cosine at which it is fully lit.

       The soft edge cannot be a fixed +0.16 on the threshold: `align` maxes out
       at exactly 1.0 for a fragment dead ahead, so once the upper edge passes
       1.0 the smoothstep can never reach full brightness and EVERY marking
       dims, worst of all the one straight in front of the car. At the 0.95 this
       now uses, a fixed band would have landed on-axis brightness at 0.232 —
       the retroreflection would have looked switched off, and the lateral gate
       is the last place anyone would have gone looking. Clamped just below 1.0
       instead, which is a no-op for any threshold below 0.84 and so changes
       nothing that shipped before it. */
    const cos0 = Math.min(Math.max(opts?.spread ?? 0.55, -0.99), 0.99);
    const cos1 = Math.min(cos0 + 0.16, 0.999);
    const wash = opts?.wash ?? 0;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uBeamPos = uBeamPos;
      sh.uniforms.uBeamDir = uBeamDir;
      sh.uniforms.uBeamAmb = uBeamAmb;
      sh.uniforms.uBeamK = uBeamK;
      sh.uniforms.uBeamRange = uBeamRange;
      sh.uniforms.uBeamNear = { value: near };
      sh.uniforms.uBeamFar = { value: far };
      sh.uniforms.uBeamCos = { value: cos0 };
      sh.uniforms.uBeamCos1 = { value: cos1 };
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vRetroW;")
        .replace(
          "#include <worldpos_vertex>",
          "#include <worldpos_vertex>\nvRetroW = (modelMatrix * vec4(transformed, 1.0)).xyz;"
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vRetroW;\n" +
            "uniform vec3 uBeamPos; uniform vec3 uBeamDir;\n" +
            "uniform float uBeamAmb; uniform float uBeamK; uniform float uBeamRange;\n" +
            "uniform float uBeamNear; uniform float uBeamFar;\n" +
            "uniform float uBeamCos; uniform float uBeamCos1;"
        );
      const gate = `
  vec3 bd = vRetroW - uBeamPos;
  float bdist = length(bd);
  float align = dot(bd / max(bdist, 1e-4), uBeamDir);
  // inside the cone, and within range — the product is what gives the
  // narrow bright wedge that widens with distance
  float cone = smoothstep(uBeamCos, uBeamCos1, align);
  float fall = 1.0 - smoothstep(uBeamNear * uBeamRange, uBeamFar * uBeamRange, bdist);
  float lit = cone * fall;`;
      sh.fragmentShader = wash > 0
        ? sh.fragmentShader.replace(
            "#include <emissivemap_fragment>",
            /* additive wash for lit materials — see the doc comment above. The
               tint is the dipped-beam 0xffeeda in linear, so the wall answers
               in the beam's own colour and stays a different light from the
               sodium lamps. Albedo-proportional, so the concrete scan's
               texture modulates it for free. */
            `#include <emissivemap_fragment>
{${gate}
  totalEmissiveRadiance +=
    diffuseColor.rgb * vec3(1.0, 0.858, 0.708) * (lit * uBeamK * ${wash.toFixed(3)});
}`
          )
        : sh.fragmentShader.replace(
            "#include <color_fragment>",
            `#include <color_fragment>
{${gate}
  diffuseColor.rgb *= mix(uBeamAmb, 1.0, lit * uBeamK);
}`
          );
    };
    mat.customProgramCacheKey = () => `beam|${near}|${far}|${cos0}|${cos1}|${wash}`;
  }

  /* ---------------- world-projected UVs ---------------- */

  /**
   * Make a material texture itself from world position instead of a uv
   * attribute.
   *
   * The highway fascia, parapets and tunnel lining are emitted as raw triangle
   * soups with no uv attribute at all — every vertex would sample the same
   * texel. Rather than reach into that geometry (it is shared with the collider
   * build), the UV is derived in the vertex shader by projecting world position
   * down the face's dominant axis. Those soups get flat per-face normals from
   * computeVertexNormals() on non-indexed triangles, so the axis choice is
   * constant across each triangle and no face can seam down its middle.
   */
  function projectedUv(mat: THREE.MeshStandardMaterial, scale: number) {
    mat.userData.projScale = scale;
    /* Chain, don't clobber: the parapet materials already carry addBeam's
       headlight-wash hook by the time the async scan lands here. The chained
       key must also stay distinct per prior hook — `conc` (no hook) and
       `barrier` (beam hook) compile different shaders, and a shared "projuv"
       key would make three hand one the other's program. The prior key is
       resolved once, eagerly: addBeam's key is static, and reading it lazily
       after the reassignment below would recurse. */
    const prevHook = mat.onBeforeCompile;
    const prevKey = Object.prototype.hasOwnProperty.call(mat, "customProgramCacheKey")
      ? mat.customProgramCacheKey()
      : "";
    mat.onBeforeCompile = (sh, renderer) => {
      prevHook?.call(mat, sh, renderer);
      sh.uniforms.uProjScale = { value: mat.userData.projScale };
      mat.userData.projSh = sh;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uProjScale;")
        .replace(
          "#include <uv_vertex>",
          `#include <uv_vertex>
{
  vec3 wpP = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 wnP = normalize(mat3(modelMatrix) * normal);
  vec3 anP = abs(wnP);
  vec2 pUV = anP.y > max(anP.x, anP.z) ? wpP.xz
           : (anP.x > anP.z ? wpP.zy : wpP.xy);
  pUV *= uProjScale;
  #ifdef USE_MAP
    vMapUv = pUV;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv = pUV;
  #endif
  #ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv = pUV;
  #endif
  #ifdef USE_METALNESSMAP
    vMetalnessMapUv = pUV;
  #endif
}`
        );
    };
    mat.customProgramCacheKey = () => `projuv|${prevKey}`;
  }

  const road = new THREE.MeshStandardMaterial({
    map: roadT, roughness: 0.4, metalness: 0.1, envMap, envMapIntensity: 0.4,
  });
  const front = new THREE.MeshStandardMaterial({
    map: frontT, roughness: 0.4, metalness: 0.1, envMap, envMapIntensity: 0.4,
  });
  const hwy = new THREE.MeshStandardMaterial({
    map: hwyT, roughness: 0.38, metalness: 0.1, envMap, envMapIntensity: 0.45,
  });
  const ramp = new THREE.MeshStandardMaterial({
    map: rampT, roughness: 0.4, metalness: 0.1, envMap, envMapIntensity: 0.4,
  });
  reflectionUniforms(road, 0.3);
  reflectionUniforms(front, 0.3);
  reflectionUniforms(hwy, 0.34);
  reflectionUniforms(ramp, 0.22);

  /* Wheel-path streaking, expressway deck only — it is a high-speed-surface
     effect and would be wrong on town streets. The deck's u axis is in metres
     over TILE (7 m per uv unit, see highway.ts), so 28 cycles per unit puts a
     streak roughly every 25 cm, which is the scale the headlight pool picks
     out. Amplitude is deliberately low; this is a texture cue, not a pattern
     you should be able to count. Rides with detailOn, so perf mode drops it. */
  ud(hwy).grooveAmt = 0.16;
  ud(hwy).grooveFreq = 28 * Math.PI * 2;

  const conc = new THREE.MeshStandardMaterial({
    color: 0x33363f, roughness: 0.8, metalness: 0.08,
  });
  const concDark = new THREE.MeshStandardMaterial({ color: 0x24262e, roughness: 0.85 });
  const barrier = new THREE.MeshStandardMaterial({
    color: 0x8d939f, roughness: 0.55, metalness: 0.35, envMap, envMapIntensity: 0.3,
  });
  const concDouble = new THREE.MeshStandardMaterial({
    color: 0x33363f, roughness: 0.8, metalness: 0.08, side: THREE.DoubleSide,
  });
  const concDarkDouble = new THREE.MeshStandardMaterial({
    color: 0x24262e, roughness: 0.85, side: THREE.DoubleSide,
  });
  const barrierDouble = new THREE.MeshStandardMaterial({
    color: 0x8d939f, roughness: 0.55, metalness: 0.35, envMap, envMapIntensity: 0.3,
    side: THREE.DoubleSide,
  });
  /* Tunnel lining. The self-illumination stands in for the bounce light a real
     tunnel gets off its own tiling — without it the tube goes pitch black a few
     metres past the last batten, because the sun and moon are both outside. */
  const tunnelWall = new THREE.MeshStandardMaterial({
    color: 0x9aa3b2, roughness: 0.35, metalness: 0.12,
    emissive: 0x171b24, emissiveIntensity: 1,
    envMap, envMapIntensity: 0.25, side: THREE.DoubleSide,
  });
  const tunnelCeil = new THREE.MeshStandardMaterial({
    color: 0x2a2d36, roughness: 0.85, side: THREE.DoubleSide,
  });
  /* Sound-barrier mesh panelling. alphaTest, never alpha-blend: cutout keeps
     the depth buffer honest (no sorting artifacts against the glow sprites)
     and costs nothing when the holes are discarded early. The procedural
     canvas carries its own alpha; the photo scan that replaces it splits the
     same data across albedo + alphaMap, and alphaTest composes both. The
     faint emissive floor is skyglow — a panel the headlights haven't reached
     should read as a dim silhouette against the night, not a hole in it. */
  const fence = new THREE.MeshStandardMaterial({
    map: fenceTexF("perf"), color: 0xaeb4bd, roughness: 0.5, metalness: 0.72,
    envMap, envMapIntensity: 0.5, alphaTest: 0.45, side: THREE.DoubleSide,
    emissive: 0x0d1118, emissiveIntensity: 1,
  });
  /* Toll canopy skins. Procedural placeholders; the corrugated/brushed scans
     replace the art in ensurePbr with the same tints multiplied over them. */
  const canopyRoof = new THREE.MeshStandardMaterial({
    color: 0x494e58, roughness: 0.55, metalness: 0.6, envMap, envMapIntensity: 0.35,
  });
  const canopyFascia = new THREE.MeshStandardMaterial({
    color: 0x666d7a, roughness: 0.35, metalness: 0.8, envMap, envMapIntensity: 0.5,
  });
  const catwalk = new THREE.MeshStandardMaterial({
    map: fenceTexF("grate"), color: 0x878c96, roughness: 0.6, metalness: 0.7,
    alphaTest: 0.45, side: THREE.DoubleSide,
    emissive: 0x0b0e14, emissiveIntensity: 1,
  });

  /* Street furniture metal: lamp masts, signal poles, gantry legs. Real
     galvanised steel is anisotropic — it streaks along the roll direction —
     which MeshStandardMaterial cannot express. The scan's roughness map fakes
     it well enough at the distance a pole is ever seen, so metalness stays
     high and the base roughness low enough for the map to work in both
     directions. The dark tint is kept as a multiplier so the poles do not
     brighten into silver posts. */
  const pole = new THREE.MeshStandardMaterial({
    color: 0x2b2e36, roughness: 0.7, metalness: 0.5, envMap, envMapIntensity: 0.4,
  });

  const winMats = [windowsTexF(true), windowsTexF(false), windowsTexF(true)].map(
    (t) =>
      new THREE.MeshStandardMaterial({
        color: 0x0c0e15, map: t, emissive: 0xffffff, emissiveMap: t,
        emissiveIntensity: 1.05, roughness: 0.8,
      })
  );
  const sfT = storefrontTexF();
  const sfMat = new THREE.MeshStandardMaterial({
    map: sfT, emissive: 0xffffff, emissiveMap: sfT, emissiveIntensity: 1.15, roughness: 0.6,
  });
  const vendT = vendingTexF();

  const studParams = {
    size: 2.4, sizeAttenuation: false, map: studTex, color: 0xfff4dc,
    transparent: true, opacity: 0.95, depthWrite: false, fog: true,
    blending: THREE.AdditiveBlending,
  };
  /* Lane paint. polygonOffset and depthWrite:false are load-bearing — with the
     marking geometry sitting only ~22 mm above the deck, they are what keep it
     off the z-fighting knife-edge at distance. Do not drop them. */
  const markMat = new THREE.MeshBasicMaterial({
    color: 0xe9edf6, fog: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const studMat = new THREE.PointsMaterial(studParams);
  /* The tunnel span gets its own material for one reason: studMat is
     registered in world.neonMats, which the engine fades out with daylight —
     correct for an open road, where a cat's eye is a dull grey lump at noon.
     Inside the tube it is dark at every hour, so daylight-dimming would erase
     the studs exactly where they are doing the most work. This one stays out
     of neonMats and burns at full strength around the clock, for the same
     reason the ceiling battens deliberately are not registered either. */
  const studMatTunnel = new THREE.PointsMaterial(studParams);

  /* Paint fades out of the beam fastest; glass-bead cat's eyes are far more
     efficient reflectors and stay legible much further down the road, which is
     what makes a receding row of them read as a line long after the dashes
     have gone dark. The tunnel studs keep the widest cone — in the tube the
     walls bounce light back onto them from every angle. */
  /* Paint is gated to the width of the light that actually falls on it: 0.95
     is the measured match to the combined two-lamp spot coverage (including
     toe-out and lamp offset), which holds near-constant at ~17 deg from centre
     over 10-60 m, as two cones from the same origin should. Anything wider and
     the shoulder line glows while the tarmac beside it is dark, which is the
     exact artifact the reference photo is about.

     The studs stay deliberately much wider, and the honest reason is not the
     one you would guess. Glass-bead reflectors do return light over a broader
     angle than the beam's nominal cone — true, and it is why they outlive the
     low-beam cut-off at range — but that is not what is doing the work here.
     Match the studs to the spot and the near-field shoulder markers die: at 9 m
     lateral they sit 42 deg off-centre when they are 10 m ahead, so a 0.90 gate
     blanks them inside 20 m, the stretch where they matter most.

     The catch, which matters if anyone revisits this: the headlight spot does
     not reach that stud either (3.4 m half-width at 10 m, 6.3 m at 20 m, and it
     only contains a 9 m offset by 30 m). So the wide gate is lighting studs the
     beam misses — strictly the same artifact the paint was just tightened to
     remove. It stays because it is standing in for light that is genuinely
     absent: a real dipped beam throws a wide near-field wash sideways that a
     single symmetric cone cannot reproduce, and narrowing the spot to a proper
     cut-off threw that wash away.

     So if a night frame ever shows near-field shoulder studs reading too bright
     against dark tarmac, the fix is NOT to tighten this number — it is that the
     foreground light is missing. If a second wide, short foreground cone is
     ever added to the headlight rig, revisit: at that point these studs stop
     compensating and should be re-matched to the light that actually exists. */
  addBeam(markMat, { near: 18, far: 62, spread: 0.95 });
  addBeam(studMat, { near: 40, far: 190, spread: 0.42 });
  addBeam(studMatTunnel, { near: 40, far: 190, spread: 0.3 });
  /* The fence runs beside the road, well off the beam axis, so it gets a wide
     cone and a short throw: panels light up as the car sweeps past them and
     die away behind, which is exactly how a headlight rakes a real barrier.
     This multiplies the *albedo* under the standard lighting model, so inside
     the beam the panel simply shows its true material lit by the real
     headlight SpotLights, and outside it falls to the emissive skyglow floor. */
  addBeam(fence, { near: 24, far: 85, spread: 0.5 });
  /* Concrete parapets. Same rake-as-you-pass read as the fence, but via the
     additive `wash` path — these are lit materials, and the multiplier form
     would darken their ambient night look everywhere outside the beam (see
     addBeam's doc comment). The real headlight SpotLights barely reach a
     vertical face beside the road: the dipped cone is edge-pinned with
     penumbra 1.0, so barrier faces sit in the near-zero rim of its angular
     smoothstep at every distance. Numbers, worked against the POV grade:
     albedo ≈ 0.15 linear (0x8d939f tint × concrete scan), so peak wash is
     0.15 × 0.5 ≈ 0.08 linear → ~0.33 display luma after ACES + the dashcam
     crush — plainly lit concrete, and well under the 0.72 blown-highlight
     clip and the ~0.8 hue bleach. Fade is cone × range smoothsteps: the wall
     beside the doors is outside the cone (dark), brightens in over ~3-8 m
     ahead, and dies off 22 → 78 m with the smoothstep's own flattening tail —
     no terminator line. High beam stretches the reach via setBeam's range
     multiplier, exactly as the paint does. `barrier` (single-sided) is
     registered too so the pair can never drift apart if it gains a user. */
  addBeam(barrier, { near: 22, far: 78, spread: 0.55, wash: 0.5 });
  addBeam(barrierDouble, { near: 22, far: 78, spread: 0.55, wash: 0.5 });

  const mats: Mats = {
    envMap, glowTex, streakTex, smokeTex, chevTex, goreTex, xingTex, studTex,
    road, front, hwy, ramp,
    ground: new THREE.MeshStandardMaterial({ color: 0x0b0c12, roughness: 0.92, metalness: 0.05 }),
    sidewalk: new THREE.MeshStandardMaterial({
      color: 0x191b23, roughness: 0.85, side: THREE.DoubleSide,
    }),
    conc,
    concDark,
    barrier,
    concDouble,
    concDarkDouble,
    barrierDouble,
    tunnelWall,
    tunnelCeil,
    fence,
    canopyRoof,
    canopyFascia,
    catwalk,
    studMat,
    studMatTunnel,
    markMat,
    addBeam,
    setBeam(on, pos, dir, dayF, unlitFloor = 0.18, range = 1) {
      uBeamPos.value.copy(pos);
      uBeamDir.value.copy(dir).normalize();
      uBeamRange.value = range > 0 ? range : 1;
      /* Outside the beam the paint is not black — skyglow, streetlights and
         the car's own spill still catch it. At noon the floor rises to 1 and
         the effect vanishes, which is correct: sunlight lights the markings
         from everywhere, so there is no beam to be outside of.

         Note for anyone retuning this against a change in scene lighting:
         every material this touches is UNLIT (MeshBasicMaterial and
         PointsMaterial), so the ambient and hemi levels do not reach them.
         Crushing the night ambient darkens the road but leaves the markings
         where they were, which *raises* marking-to-road contrast rather than
         lowering it. This floor is the only thing that dims unlit paint at
         night, which is why it is a parameter — see setBeam's doc comment. */
      const night = 1 - Math.min(Math.max(dayF, 0), 1);
      // a brightness, so 0..1 by definition — clamped because `unlitFloor` and
      // `range` are adjacent number parameters and transposing them would
      // typecheck perfectly
      const floor = Math.min(Math.max(unlitFloor, 0), 1);
      uBeamAmb.value = 1 - (1 - floor) * night;
      uBeamK.value = on ? night : 0;
    },
    soundwall: new THREE.MeshStandardMaterial({
      color: 0x2c4438, roughness: 0.75, transparent: true, opacity: 0.85,
    }),
    pole,
    winMats,
    sfMat,
    vendMat: new THREE.MeshStandardMaterial({
      map: vendT, emissive: 0xffffff, emissiveMap: vendT, emissiveIntensity: 0.9, roughness: 0.5,
    }),
    clutterMat: new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.8 }),
    refMats,
    addReflection: reflectionUniforms,
    setReflectionTexture(tex) {
      pendingRefTex = tex;
      for (const m of refMats) if (ud(m).sh) ud(m).sh!.uniforms.tRef.value = tex;
    },
    setReflectionScreen(w, h) {
      screen.set(w, h);
    },
    setWet(on, reflectionsOn) {
      const rough = on ? 0.13 : 0.4;
      setRough(road, rough);
      setRough(front, rough);
      setRough(hwy, rough - 0.02);
      setRough(ramp, rough);
      for (const m of refMats) {
        const d = ud(m);
        /* Road SSR is disabled outright (str 0 regardless of the settings
           toggle): even luminance-gated, the mirrored skyline painted white
           patches across the road that no tuning pass killed — the user
           chose to drop the effect. The shader path and wet/rough plumbing
           stay; restore by reverting to `reflectionsOn ? d.refStr * (on ?
           2.6 : 1) : 0` if a future reflection source is better behaved. */
        void reflectionsOn;
        const str = 0;
        d.curStr = str;
        if (d.sh) d.sh.uniforms.uRefStr.value = str;
        /* Puddle-patch modulation is a rain effect. On a dry road the scan's
           smooth patches were still mirroring up to 3x at grazing angles, so
           bright signage reflected as hard-edged patches far ahead that faded
           out on approach (Fresnel steepening) — the "square of light that
           vanishes as you reach it" artifact. Dry roads keep only a whisper
           of patch variation; rain restores the full standing-water look. */
        d.curRoughMod = (on ? 1 : 0.15) * d.roughMod;
        if (d.sh && d.sh.uniforms.uRoughMod)
          d.sh.uniforms.uRoughMod.value = d.curRoughMod;
      }
    },
    setPbrDetail(on) {
      /* Turning detail on is also what starts a deferred load, so a session
         that booted on the low preset — and so never downloaded the scans —
         picks them up the first time the player raises the quality setting.
         Deliberately before the early-return: the very first call may be
         setPbrDetail(true) with detail already nominally on. */
      if (on) void ensurePbr();
      if (detailOn === on) return;
      detailOn = on;
      /* Perf mode drops the two extra road texture fetches per pixel — the
         detail albedo and the normal map — while keeping the roughness map,
         which is the cheap one and the one carrying the wet-road look. */
      for (const m of refMats) {
        const d = ud(m);
        if (!d.detTex && !d.normalTex) continue;
        m.normalMap = on ? d.normalTex : null;
        m.needsUpdate = true; // recompile: the detail sampler is compiled in or out
      }
    },
  };

  /** Set a road's *effective* roughness, compensating for the scan's own mean. */
  function setRough(mat: THREE.MeshStandardMaterial, target: number) {
    const d = ud(mat);
    d.dryRough = target;
    // roughnessFactor = roughness * texel.g, and texel.g averages 1/roughK, so
    // scaling the base by roughK lands the *average* roughness on `target`
    // whether or not a scan is present
    mat.roughness = target * d.roughK;
    if (d.sh?.uniforms.uRoughRef) d.sh.uniforms.uRoughRef.value = target;
  }

  /* ---------------- async photo-scan upgrade ---------------- */

  /** Layer a scan onto a road surface: detail albedo + real normal/roughness. */
  function upgradeRoad(mat: THREE.MeshStandardMaterial, set: PbrSet, o: PbrOpts) {
    if (!set.albedo) return;
    const d = ud(mat);
    const rep = new THREE.Vector2(o.repeat[0], o.repeat[1]);
    d.detTex = retile(set.albedo, rep);
    d.detMean = set.albedoMean;
    d.detK = o.detail ?? 0.85;
    d.detRep = rep;
    d.roughMod = o.roughMod ?? 0.85;
    if (set.normal) {
      d.normalTex = retile(set.normal, rep);
      if (detailOn) mat.normalMap = d.normalTex;
      const ns = o.normalScale ?? 0.35;
      mat.normalScale = new THREE.Vector2(ns, ns);
    }
    if (set.rough) {
      mat.roughnessMap = retile(set.rough, rep);
      d.roughK = 1 / Math.max(set.roughMean, 0.05);
    }
    setRough(mat, o.roughness ?? d.dryRough);
    mat.needsUpdate = true;
  }

  /** Replace a non-road material's art outright. */
  function upgradeSurface(mat: THREE.MeshStandardMaterial, set: PbrSet, o: PbrOpts) {
    if (!set.albedo) return;
    const rep = new THREE.Vector2(o.repeat[0], o.repeat[1]);
    mat.map = retile(set.albedo, rep);
    // the tuned tint stays as a multiplier over the scan, which is how the
    // tunnel lining keeps reading as pale tile and the barriers as dirty grey
    if (set.normal) {
      mat.normalMap = retile(set.normal, rep);
      mat.normalScale = new THREE.Vector2(o.normalScale ?? 0.7, o.normalScale ?? 0.7);
    }
    if (set.rough) {
      mat.roughnessMap = retile(set.rough, rep);
      mat.roughness = (o.roughness ?? mat.roughness) / Math.max(set.roughMean, 0.05);
    }
    if (set.metal) mat.metalnessMap = retile(set.metal, rep);
    // cutout sets: the scan's opacity map replaces the alpha baked into the
    // procedural canvas; alphaTest carries over unchanged
    if (set.alpha) mat.alphaMap = retile(set.alpha, rep);
    mat.needsUpdate = true;
  }

  /* A Texture clone shares its `source`, so the pixels are uploaded to the GPU
     once no matter how many materials tile the same scan differently. */
  function retile(t: THREE.Texture, rep: THREE.Vector2) {
    if (t.repeat.x === rep.x && t.repeat.y === rep.y) return t;
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.copy(rep);
    c.needsUpdate = true;
    return c;
  }

  if (usePbr) void ensurePbr();

  /** Fetch and apply the photo scans. Idempotent — safe to call repeatedly. */
  async function ensurePbr() {
    if (pbrStarted) return;
    pbrStarted = true;
    /* Every await here is failure-tolerant by construction: loadPbrSet always
       resolves, and an absent set has a null albedo which every upgrade path
       returns early on. A missing assets directory costs four 404s and leaves
       the procedural look untouched. */
    const [
      asphaltSet, wornSet, concreteSet, metalSet,
      fenceSet, tileSet, corrSet, plateSet, walkSet,
    ] = await Promise.all([
      loadPbrSet("asphalt"),
      loadPbrSet("asphalt_worn"),
      loadPbrSet("concrete"),
      // the directory keeps ambientCG's "guardrail" name (see ATTRIBUTIONS.md);
      // this world has no guardrails, so the metal goes on the street furniture
      loadPbrSet("guardrail", undefined, true),
      // Lane A world dressing (all CC0 — ambientCG): perforated fence,
      // tunnel tile, corrugated canopy roof, brushed fascia, grated catwalk
      loadPbrSet("fence", undefined, true, true),
      loadPbrSet("tile"),
      loadPbrSet("corrugated", undefined, true),
      loadPbrSet("plates", undefined, true),
      loadPbrSet("walkway", undefined, false, true),
    ]);

    /* Repeats are expressed in the mesh's own UV space, which differs per
       surface. The highway deck is laid out in 7 m tiles (see TILE in
       highway.ts), so 2 repeats puts one scan tile every ~3.5 m — close to the
       real-world size of the scanned patch. The town streets run u across the
       full carriageway and v every 14 m, hence the larger numbers. */
    // the worn scan is the better read for a motorway deck; fall back to the
    // fresh one if only that half of the drop has landed
    const deck = wornSet.albedo ? wornSet : asphaltSet;
    upgradeRoad(hwy, deck, {
      repeat: [2, 2], normalScale: 0.3, detail: 0.9, roughness: 0.38, roughMod: 0.9,
    });
    upgradeRoad(road, asphaltSet, {
      repeat: [4, 4], normalScale: 0.32, detail: 0.85, roughness: 0.4, roughMod: 0.85,
    });
    upgradeRoad(front, asphaltSet, {
      repeat: [4, 4], normalScale: 0.32, detail: 0.85, roughness: 0.4, roughMod: 0.85,
    });
    upgradeRoad(ramp, deck, {
      repeat: [2, 3], normalScale: 0.3, detail: 0.8, roughness: 0.4, roughMod: 0.8,
    });

    /* Concrete and metal are world-projected, so their density is set by the
       projection scale rather than a uv repeat: 0.45 puts one scan tile every
       ~2.2 m of wall, which keeps the aggregate at life size on a 1 m parapet.
       projectedUv() must be installed before the upgrade, because it replaces
       onBeforeCompile and the upgrade is what flags the recompile. */
    /* `soundwall` is deliberately absent from this list and must stay absent:
       it is a translucent polycarbonate noise barrier, not concrete, and an
       aggregate scan on it would look like a wall made of gravel. Note also
       that highway.ts clones it (swMat, for DoubleSide), so adding it here
       would silently do nothing anyway — if it ever does need a scan it needs
       a shared double-sided variant first, the way the parapets got one. */
    if (concreteSet.albedo)
      for (const m of [
        conc, concDouble, concDark, concDarkDouble,
        barrier, barrierDouble, tunnelCeil,
      ]) {
        projectedUv(m, 0.45);
        upgradeSurface(m, concreteSet, {
          repeat: [1, 1], normalScale: 0.65, roughness: m.roughness,
        });
      }
    /* Tunnel walls get real ceramic tile (the classic urban-tunnel band) in
       preference to bare concrete; concrete remains the fallback so a partial
       asset drop still upgrades the tube. Roughness sits well below the
       concrete's: a glazed tile wall is what lets the headlights and the
       batten glow streak along the tube, which is most of the AC night read.
       0.6 projection scale ≈ a 1.7 m tile course — close to life size. */
    {
      const wallSet = tileSet.albedo ? tileSet : concreteSet;
      if (wallSet.albedo) {
        projectedUv(tunnelWall, tileSet.albedo ? 0.6 : 0.45);
        upgradeSurface(tunnelWall, wallSet, {
          repeat: [1, 1], normalScale: 0.9,
          roughness: tileSet.albedo ? 0.24 : tunnelWall.roughness,
        });
        if (tileSet.albedo) {
          tunnelWall.envMapIntensity = 0.35;
          // let the grout lines carry contrast: the flat self-illumination is
          // only the floor that keeps the tube from going black
          tunnelWall.emissive.setHex(0x111520);
        }
      }
    }
    /* Lane A dressing materials — straight art replacement, tuned tints kept
       as multipliers exactly like the concrete family above. */
    if (fenceSet.albedo)
      upgradeSurface(fence, fenceSet, { repeat: [1, 1], normalScale: 0.8, roughness: 0.5 });
    if (corrSet.albedo) {
      projectedUv(canopyRoof, 0.55);
      upgradeSurface(canopyRoof, corrSet, { repeat: [1, 1], normalScale: 0.85, roughness: 0.55 });
    }
    if (plateSet.albedo)
      upgradeSurface(canopyFascia, plateSet, { repeat: [3, 1], normalScale: 0.5, roughness: 0.35 });
    if (walkSet.albedo)
      upgradeSurface(catwalk, walkSet, { repeat: [1, 1], normalScale: 0.7, roughness: 0.6 });
    /* Poles are cylinders and boxes with real UVs, so no projection here — and
       none is possible anyway, since an InstancedMesh's modelMatrix is the
       batch's transform, not the per-instance one, and every pole would end up
       sampling the identical patch. The repeat is tuned to the mast geometry
       rather than to metres. */
    upgradeSurface(pole, metalSet, {
      repeat: [1, 4], normalScale: 0.45, roughness: 0.7,
    });
  }

  return mats;
}
