import * as THREE from "three";
import { clamp, mulberry32, rrand, sstep, TAU, type Rng } from "../util";
import { worldTierCaps } from "../settings";

/* Night cloudscape — a procedural deck of lit-edged cloud over the aurora.
 *
 * Zero assets, like the aurora: one shader, no textures, nothing downloaded.
 *
 * WHY IT IS A REAL DECK AND NOT A DOME TEXTURE. The density is sampled at
 * `d.xz / d.y`, which is where the view ray crosses a flat plane at altitude.
 * That single divide is what buys the whole look: cloud cells stay large
 * overhead and compress hard toward the horizon, exactly as a real deck does
 * in perspective. Sampling the sphere directly instead gives evenly sized
 * blobs all the way down, which reads as wallpaper on a dome — the thing the
 * aurora was just rescued from.
 *
 * WHY IT DARKENS. Unlike the aurora this blends NORMALLY, not additively,
 * because a cloud has to be able to be darker than the sky behind it. Deep
 * violet shadowed cores over a lit sky is most of what makes a night
 * cloudscape read; additive can only ever add light, so it can only ever make
 * haze. That also means it can occlude — clouds sit at ~10 km and the aurora
 * at ~100 km, so the deck correctly passes in front of both the curtains and
 * the stars.
 *
 * LIT EDGES FROM ONE NOISE FETCH. Two thresholds on the same density field:
 * a wide one for the cloud body and a tighter one for its thick core. Edges
 * are body-minus-core and take the lit colour, cores take the shadow colour.
 * That is a real two-tone with no second noise evaluation and no light-vector
 * raymarch — and because both thresholds are smoothsteps, the cloud has no
 * outline anywhere (realistic-light: it fades, it never stops).
 *
 * COLOUR IS SHARED WITH THE AURORA. The lit rim takes the aurora's crown hue
 * and the shadow takes a deepened version of its body hue, so the deck reads
 * as the same weather rather than as a second effect stacked on top — which
 * is what blending in with the background actually requires.
 */

/** Master kill-switch. */
export const FX_NIGHT_CLOUDS = true;

/** The cool night grey tint() sits the shadow colour on top of — see there.
 *  Hoisted to a module constant because the deck is re-tinted CONTINUOUSLY
 *  now: the aurora crossfades in and out over minutes, so tint() runs a
 *  couple of times a second while an arc is moving instead of once a night,
 *  and a fresh Vector3 per call would be pure garbage on a hot path. */
const SHADOW_FLOOR = new THREE.Vector3(0.042, 0.046, 0.078);

export interface NightCloudsRoll {
  coverage: number;
  scale: number;
  drift: number;
  /** 0 on most nights; up to 1 on the ~30% of seeds that roll a broken-storm
      deck — more sky covered, torn ridged tops, faster drift. */
  storm: number;
}

export interface NightClouds {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  roll: NightCloudsRoll;
  /** live 0..1.5 — how much cloud shows. 0 = clear night, 1 = shipped,
      ~1.4 = the most the deck's own alpha ceiling allows. */
  amount: number;
  /** live 0..3 — how hard the moon lights the deck, 1 = as shipped. This is
      most of what a curtainless stretch has going on, so it is the knob to
      reach for when a clear night reads as flat. */
  moonAmt: number;
  /** live direction of the moon, unit length. Must match the moon sprite that
      sky.ts parks in the backdrop — see the uMoon comment. */
  moon: THREE.Vector3;
  /** live 0..1 — how stormy the deck is right now. Rolled per seed (most
      nights 0), and the knob to push to 1 to audition a broken-storm deck on
      any sky without rerolling it. */
  storm: number;
  /** live 0..2 — the high cirrus veil layer's strength, 1 = as shipped.
      Desktop/mobile-high only; mobile-base never builds the layer. */
  veilAmt: number;
  /** live 0..3 — how hard the low sun rims the deck at dusk and dawn,
      1 = as shipped. 0 restores the old flat crossfade. */
  duskAmt: number;
  /** live direction of the sun, unit length. engine.weather() re-derives it
      every frame from the same clock angle the directional light uses, so
      re-aiming it by hand only sticks for a frame — audition the dusk look
      with __neonx.setTime(17.8) and dial duskAmt instead. */
  sun: THREE.Vector3;
  /** re-tint from whatever is lighting the deck right now — the aurora's
      palette under curtains, moonlight in the gaps between them, and a blend
      of the two while an arc fades. aurora.ts picks the mix and calls this
      through sky.ts's onPalette hook, a couple of times a second while an arc
      is moving and not at all in between. */
  tint(lo: THREE.Vector3, hi: THREE.Vector3): void;
  reroll(seed?: number): NightCloudsRoll;
  /** sunAng is the clock angle engine.weather() aims the directional light
      with — the deck derives the dusk rim's direction and strength from it.
      Optional so headless sims that only tick the night keep compiling. */
  update(now: number, dayF: number, fogMul: number, sunAng?: number): void;
}

export function buildNightClouds(seed: number): NightClouds {
  const caps = worldTierCaps();
  const lowq = caps.tier === "mobile-base";

  const uCov = { value: 0.46 };
  const uScale = { value: 0.55 };
  const uDrift = { value: 1 };
  const uLit = { value: new THREE.Vector3(0.95, 0.36, 0.62) };
  const uDark = { value: new THREE.Vector3(0.030, 0.020, 0.062) };
  /* City underglow, as its OWN colour rather than a fraction of uLit.
     Sodium and LED street lighting throwing up into the base of the deck is
     warm no matter what is happening 90 km above it, and it used to inherit
     the aurora's crown hue — so a violet night gave the town violet lamps.
     Now that the aurora comes and goes and uLit crossfades to cool moonlight
     behind it, leaving it coupled would have had the horizon glow drifting to
     silver every time the curtains left — which is the one thing a lit town
     never does. */
  const uCity = { value: new THREE.Vector3(0.088, 0.052, 0.022) };
  /* Direction of the moon, and how hard it lights the deck.
     WHAT THIS IS COUPLED TO: sky.ts parks the moon sprite at
     (-900, 1250, -1700) in the backdrop group, i.e. direction
     (-0.392, 0.545, -0.741) — 33° up. If that sprite ever moves, this vector
     has to move with it or the bright side of the clouds detaches from the
     moon, so it is a uniform and `__clouds.moon` re-aims it live. */
  const uMoon = { value: new THREE.Vector3(-0.392, 0.545, -0.741) };
  const uMoonAmt = { value: 1 };
  /* Direction of the sun. Unlike uMoon this is not hand-coupled to a sprite:
     engine.weather() re-derives it every frame from the same `sa` clock angle
     it aims the directional light with (via update()'s sunAng), so the rim on
     the deck and the light on the road always agree about where the sun is.
     The default only matters for headless sims that never pass sunAng. */
  const uSun = { value: new THREE.Vector3(-0.83, 0.1, -0.55).normalize() };
  /* Dusk envelope × the duskAmt knob. 0 through the whole night and the whole
     high day — the rim exists only while the sun is within a few degrees of
     the horizon, which is what keeps it a sunset and not a second moon. */
  const uDusk = { value: 0 };
  const uStorm = { value: 0 };
  const uVeil = { value: 1 };

  function applyRoll(s: number): NightCloudsRoll {
    const rng: Rng = mulberry32(s ^ 0x9e3779b9);
    /* Coverage is the one value that can ruin a night in either direction:
       too low and it is an overcast lid that hides the aurora, too high and
       there is no deck at all. NOTE THE SIGN: uCov is a threshold on the
       density field, so LOWER means MORE cloud. This base range runs from
       "broken" (0.56) to "scattered" (0.66), never to "overcast". */
    const cov = rrand(rng, 0.56, 0.66);
    const scale = rrand(rng, 0.42, 0.78);
    const drift = rrand(rng, 0.6, 1.5);
    /* The storm draw. Most nights roll 0 and keep the calm deck exactly as it
       was; the top ~30% of draws ramp smoothly into a broken-storm sky —
       coverage pushed DOWN past the calm range's floor (more sky covered,
       still well short of the overcast lid that would hide the aurora),
       ridged tops folded in by the shader, faster drift. Smooth because a
       ramp keeps near-miss seeds looking like heavy weather rather than
       snapping between two fixed decks. This draw comes AFTER the original
       three so it only consumes new rng — the local mulberry32 stream, not
       the world's rand(), so city layouts are untouched. */
    const sr = rng();
    const storm = sr < 0.7 ? 0 : (sr - 0.7) / 0.3;
    const covS = cov - storm * 0.1;
    const driftS = drift * (1 + storm * 0.4);
    uCov.value = covS;
    uScale.value = scale;
    uDrift.value = driftS;
    uStorm.value = storm;
    return {
      coverage: +covS.toFixed(3), scale: +scale.toFixed(3),
      drift: +driftS.toFixed(3), storm: +storm.toFixed(3),
    };
  }

  /* Only the sky above the horizon. The deck's own bottom fade dies a couple
     of degrees up, where the perspective divide would otherwise stretch cells
     into infinite streaks. */
  const geo = new THREE.SphereGeometry(2500, 64, 24, 0, TAU, 0, Math.acos(0.012));

  const mat = new THREE.ShaderMaterial({
    defines: { LOWQ: lowq ? 1 : 0 },
    uniforms: {
      uTime: { value: 0 },
      uAmt: { value: 1 },
      uDay: { value: 0 },
      uCov, uScale, uDrift, uLit, uDark, uCity, uMoon, uMoonAmt,
      uSun, uDusk, uStorm, uVeil,
    },
    vertexShader: `varying vec3 vDir;
void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `precision highp float;
varying vec3 vDir;
uniform float uTime,uAmt,uDay,uCov,uScale,uDrift,uMoonAmt,uDusk,uStorm,uVeil;
uniform vec3 uLit,uDark,uCity,uMoon,uSun;

float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
 return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
// two octaves for the warp field (it only needs shape), three for the density
float fbm2(vec2 p){ float s=vn(p)*.62; p*=2.07; return s+vn(p)*.38; }
float fbm3(vec2 p){ float s=vn(p)*.52; p*=2.03; s+=vn(p)*.30;
#if LOWQ == 0
 p*=2.07; s+=vn(p)*.18;
 /* 4th octave, RIDGED: folding the noise at its midline creases the smooth
    tops into torn cauliflower edges — the shape difference between "haze"
    and "weather". Centred on its own mean (~.34) so the sum's distribution
    stays where the cov/core threshold maths below expects it, and weighted
    up on storm nights, where the tearing is most of the drama. */
 p*=2.13; float rr=1.-abs(vn(p)*2.-1.); s+=(rr*rr-.34)*(.06+.10*uStorm);
#endif
 return s; }

void main(){
 if(uAmt<=.003){ gl_FragColor=vec4(0.); return; }
 vec3 d=normalize(vDir);
 float ey=d.y;
 if(ey<=.012){ gl_FragColor=vec4(0.); return; }
 // where this ray crosses the deck — the divide is the perspective
 vec2 p=d.xz/ey*uScale;
 float t=uTime*uDrift;
 // domain warp: without it fbm gives round lumps, with it you get the
 // sheared, torn shapes weather actually makes
 vec2 q=vec2(fbm2(p+vec2(t*.010,t*.006)),fbm2(p+vec2(4.7,2.1)+vec2(t*.008,-t*.011)));
 float raw=fbm3(p+q*1.5+vec2(t*.014,t*.004));
 float cov=uCov;
 /* Thresholds sit CLOSE together on purpose. Three octaves of value noise
    sum to something roughly normal about 0.5 with a standard deviation near
    0.13, so raw almost never leaves 0.25…0.75 — spreading the core threshold
    over 0.46 of range (as a first cut did) means it never fires at all and
    every pixel takes the lit colour, which is why the deck came out as pink
    soup with no shadow in it. These spans are sized to the distribution the
    noise actually has. */
 float body=smoothstep(cov,cov+.26,raw);        // the whole cloud
 float core=smoothstep(cov+.10,cov+.34,raw);    // its thick middle
 /* Tear the outline. A threshold on smooth fbm gives ROUND edges, and round
    edges at this size read as blobs no matter what colour they are — one of
    the two things that made the first deck look like holes punched in the
    sky. A high-frequency bite taken only out of the body (never the core)
    turns those edges wispy. */
 body*=.66+.34*vn(p*3.1+q*2.+vec2(t*.02,0.));
 float av=0.;
#if LOWQ == 0
 /* A second deck, ~2.4× higher: same flat-plane divide, tighter cells (a
    higher layer subtends smaller ones), its own faster drift on a different
    heading. The two layers sliding against each other is real parallax on a
    fixed sphere — the depth cue a single deck can never give. It reuses the
    warp field q, so the whole layer costs one fbm2 (two fetches). Behind the
    main deck in the composite below, because it is above it. */
 float raw2=fbm2(p*2.4+q*1.1+vec2(-t*.019,t*.012));
 float veil=smoothstep(.58,.82,raw2);
 // low like everything else: gone by ~53° elevation, and eased in above the
 // haze band — the dashcam window is 3–23°
 av=veil*smoothstep(.035,.16,ey)*(1.-smoothstep(.30,.80,ey)*.55)*uVeil*uAmt*.16;
#endif
 if(body<=.001&&av<=.001){ gl_FragColor=vec4(0.); return; }
 /* Horizon falloff. Two jobs: the perspective divide goes singular down
    there, and the last couple of degrees belong to haze and the skyline
    anyway. A smoothstep, so the deck dissolves into the horizon rather than
    ending at a line — and it deliberately leaves the aurora's hem, which
    lives just above the skyline, showing underneath. */
 float lowFade=smoothstep(.020,.105,ey);
 /* Thin the deck toward the zenith as well. A cloud layer seen from below
    genuinely has more air between you and it near the horizon, and the
    dashcam's window tops out around 23° — keeping the mass low puts it where
    the camera actually looks. */
 float highFade=1.-smoothstep(.34,.92,ey)*.45;
 /* The other half of the blob problem: full opacity in the middles. A cloud
    at night is only really visible where something is lighting it, so the
    shadowed core is thinned rather than thickened — the aurora bleeds
    through it and a hard silhouette becomes a veil. The .70 ceiling means no
    part of the deck is ever a solid lid — storm nights get a slightly
    higher one (~.80 at full storm): heavy weather is allowed to be heavier,
    but the cores stay thinned. */
 float a=body*(1.-core*.55)*lowFade*highFade*uAmt*.70*(1.+uStorm*.14);
 // edges lit, cores in shadow: one noise fetch, two thresholds
 vec3 col=mix(uLit,uDark,core);
 // a touch of extra warmth in the lowest, most distant cloud — the light a
 // city throws up into its own overcast. Its own colour, not the aurora's:
 // street lighting does not change hue with the weather 90 km overhead.
 col+=uCity*(1.-core)*(1.-smoothstep(.03,.26,ey));
 /* MOONLIGHT. In the stretches with no curtains up this is what actually
    lights the deck, and it is the difference between "cloud" and "grey
    shapes": a real moonlit sky has a bright side and a dark side, because
    the moon is a point source 33° up and not an ambient wash.
    Two terms, both smooth to zero — a broad forward-scattering lobe over the
    whole moonward half of the sky (cos^3, which is the direction thin water
    cloud actually throws light), plus a tight halo where the deck is thin
    enough in front of the disc to glow through it. Nothing here has an edge:
    a power of a clamped dot product cannot print one. */
 float md=max(0.,dot(d,uMoon));
 float md3=md*md*md;
 col+=vec3(.62,.68,.86)*uMoonAmt*((1.-core)*md3*.18+md3*md3*md3*.26);
 /* Composite the high veil BEHIND the main deck (it is above it, so from
    below the low deck occludes). Thin cirrus is nearly all lit edge, so it
    takes the lit hue plus its share of moonlight and never a shadow core. */
 vec3 cv=uLit*.58+vec3(.025)+vec3(.62,.68,.86)*uMoonAmt*md3*.15;
 float A=a+av*(1.-a);
 col=(col*a+cv*av*(1.-a))/max(A,1e-4);
 /* Daylight: a dayF-and-sun-angle gradient instead of the old flat grey-blue.
    At dusk the cores deepen toward violet-grey and the sunward side of the
    deck warms; by high day uDusk is 0 and this collapses to exactly the
    plausible grey-blue it replaced. */
 float sd=max(0.,dot(d,uSun));
 float sd3=sd*sd*sd;
 // gradient mixes saturate at 1 so a cranked duskAmt (0..3) only ever means
 // a hotter rim below, never day colours extrapolated past their targets
 float dw=min(uDusk,1.);
 vec3 dayEdge=mix(vec3(.80,.83,.90),vec3(1.0,.55,.30),dw*(.30+.70*sd));
 vec3 dayCore=mix(vec3(.30,.34,.44),vec3(.34,.26,.40),dw);
 col=mix(col,mix(dayEdge,dayCore,core),uDay);
 /* SUNSET RIM — the moon lobe's warm twin, aimed down the live sun angle.
    Same construction: a broad cos^3 forward-scatter over the sunward sky
    plus a tighter triple-cubed streak near the disc, both powers of a
    clamped dot so nothing here can print an edge. Applied after the day
    crossfade so the rim rides the dusk deck instead of being faded out by
    it, and strongly saturated on purpose — the POV grade's sky pulldown
    gates on low saturation, so an orange this deep punches straight through
    while grey haze around it is crushed. */
 col+=vec3(1.0,.42,.16)*uDusk*((1.-core)*sd3*.34+sd3*sd3*sd3*.30);
 // sub-LSB dither — a smooth alpha ramp across the whole sky is exactly where
 // 8-bit banding shows first
 float dz=(h21(gl_FragCoord.xy+fract(uTime))-.5)*.004;
 gl_FragColor=vec4(max(col+dz,vec3(0.)),clamp(A+dz,0.,1.));
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  /* Transparent list, ahead of the skyline ring (-9) and behind nothing but
     the stars, which sky.ts pushes to -9.85 so the deck can cover them. The
     aurora is in the OPAQUE list, so it is already drawn by the time this
     runs and the deck passes in front of it too. */
  mesh.renderOrder = -9.8;
  mesh.frustumCulled = false;

  const api: NightClouds = {
    mesh,
    mat,
    roll: applyRoll(seed),
    amount: 1,
    moonAmt: 1,
    moon: uMoon.value,
    // applyRoll above just wrote the seed's storm draw into the uniform;
    // start the live knob on that value so update() carries it forward
    storm: uStorm.value,
    veilAmt: 1,
    duskAmt: 1,
    sun: uSun.value,
    tint(lo: THREE.Vector3, hi: THREE.Vector3) {
      // lit rim takes the aurora's crown hue, held well under the grade's
      // white-clip so a rim stays coloured instead of bleaching
      uLit.value.copy(hi).multiplyScalar(0.52).addScalar(0.03);
      /* Shadow is a cool night grey with a little of the aurora's hue in it —
         NOT near-black. The first cut drove this to ~0.02 luma while the night
         sky dome sits around 0.03, so every thick patch was darker than the
         sky behind it and read as a black blob punched out of a lit frame.
         Sitting just ABOVE the sky's own level makes the same shape read as
         cloud catching a little light, which is what it is. */
      uDark.value.copy(lo).multiplyScalar(0.055).add(SHADOW_FLOOR);
    },
    reroll(s?: number) {
      api.roll = applyRoll(s ?? ((Math.random() * 0xffffffff) >>> 0));
      // the reroll's storm draw replaces any live override — a new sky is a
      // new night's weather, and update() reads the knob, not the uniform
      api.storm = api.roll.storm;
      return api.roll;
    },
    update(now: number, dayF: number, fogMul: number, sunAng?: number) {
      mat.uniforms.uTime.value = now;
      mat.uniforms.uDay.value = clamp(dayF * 1.25, 0, 1);
      /* Unlike the aurora, cloud does not care what time it is — it is there
         all day. Fog thickens it a little rather than hiding it, which is the
         honest direction for water in the air. */
      /* `amount` runs past 1 on purpose: the alpha ceiling inside the shader
         is 0.70, so 1.4 is the most cloud this deck can physically show and
         anything up to there is a usable setting rather than a clipped one.
         It is the knob to reach for before touching any of the constants. */
      mat.uniforms.uAmt.value =
        clamp(api.amount, 0, 1.5) * clamp(0.88 + 0.10 * fogMul, 0, 1);
      /* The moon is a night light: fade its contribution out with the same
         day factor the palette blend uses, or the daytime deck carries a
         second, wrongly placed sun in it. */
      mat.uniforms.uMoonAmt.value =
        clamp(api.moonAmt, 0, 3) * (1 - clamp(dayF * 1.25, 0, 1));
      mat.uniforms.uStorm.value = clamp(api.storm, 0, 1);
      mat.uniforms.uVeil.value = clamp(api.veilAmt, 0, 2);
      if (sunAng !== undefined) {
        /* Same construction as the directional light's position in
           engine.weather() — (-cos·520, sin·640, -260) around the car —
           minus its 120 m night floor: the rim needs the TRUE sun, which
           keeps setting below the horizon after the light clamps, because
           that last stretch (sun just under, clouds still catching it) IS
           the sunset. */
        const se = Math.sin(sunAng);
        uSun.value.set(-Math.cos(sunAng) * 520, se * 640, -260).normalize();
        /* The dusk window, twice a day and ~0 everywhere else: eases in
           from ~13° under the horizon (full by 2° under — twilight, the
           underlit-cloud stretch) and back out by ~25° up, where the sky is
           simply day. Both edges smooth — the rim fades, it never pops. */
        const dusk =
          sstep((se + 0.22) / 0.18) * (1 - sstep((se - 0.12) / 0.3));
        mat.uniforms.uDusk.value = clamp(api.duskAmt, 0, 3) * dusk;
      }
    },
  };
  return api;
}
