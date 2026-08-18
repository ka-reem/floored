/* Synthesised audio. The engine is a layered model rather than a couple of
   oscillators: three detuned band-limited pulse trains at the crank half-order
   (so the wave's 2nd partial lands on the firing frequency and the odd partials
   give the lumpy half-order rumble), pushed through a load-dependent waveshaper
   for growl, blended with intake and exhaust noise beds, then shaped by a
   throttle-opening lowpass and two fixed body resonances. On top of that:
   idle wobble, overrun crackle, a rev-limiter stutter LFO, shift chuffs and a
   gearbox whine.

   Tires are a second layered model, driven by an exponentially-smoothed
   slip envelope (see slipEnv in update()) rather than raw per-frame slip, so
   ABS/ESC pulsing at the tyre reads as sustained sliding rather than a
   chattering on/off screech. Three noise layers crossfade continuously with
   that envelope: a subtle speed-only rolling/contact-patch hum, a narrowband
   "singing" squeal that rises in pitch with slip, and a broadband,
   amplitude-modulated full screech for hard sustained sliding. A separate
   one-shot bark (reusing the crackle burst()) fires on sudden slip spikes —
   launch wheelspin, a harsh downshift, clipping the edge of the friction
   circle — independent of the sustained layers. Rain quiets the screech and
   shifts it broader/brighter (hissier) without changing pitch behaviour.
   Wind, road rumble, transmission whine and overrun burble are a fourth
   layer group, all tied to speed/load rather than rpm alone:
   wind is lowpassed noise whose cutoff and level open with speed (plus a
   slow two-LFO "flutter" depth so it doesn't sit dead-static), becoming the
   dominant sound at high speed the way a real cockpit does above ~140 km/h;
   road rumble is a separate, lower (~55-125Hz) noise bed tied to speed that
   reads as tyres-on-concrete rather than wind, and ducks slightly under the
   tyre screech layer so the two don't stack into mud; gearbox whine now
   tracks vehicle speed (i.e. output-shaft speed, which — for a fixed final
   drive — is the same at a given road speed no matter which gear is
   selected) rather than rpm, and is boosted on overrun/lift-off and damped
   under load, the classic sim-modder cue; overrun burble/backfire fires a
   short rate-limited volley of filtered bursts (reusing burst()) on a sudden
   throttle lift at high rpm, sharper single pops on sportier profiles
   (kaze/okami) and only a rare soft thump on the sedan/kei. Horn/crash duck
   and rain hiss are unchanged from before.

   The whole graph is built once in init(); update() only moves AudioParams.

   On top of the synth model sits a recorded-sample layer (see EngineMode
   below): a 4-loop rpm-ladder engine with idle bed, a recorded skid loop, a
   real underpass impulse response for the tunnel reverb, and recorded
   crash/impact/horn one-shots. Samples lazy-load on the same user
   gesture that unlocks the AudioContext; until they decode — or with
   engineMode="synth" — the synthesized model carries everything, unchanged. */

/** Per-car engine character. Chosen by setCar(); "generic" is the fallback. */
export interface EngineProfile {
  /** Cylinder count — sets firing frequency = rpm/60 * cyl/2. */
  cyl: number;
  /** 0..1 amount of half-order (odd partial) content: uneven, lumpy firing. */
  odd: number;
  /** Harmonic rolloff exponent; lower = brighter, harsher. */
  bright: number;
  /** Turbo spool whistle level. */
  turbo: number;
  /** Overall engine loudness trim. */
  level: number;
  revLimit: number;
  /** 0..1 overrun burble/backfire character: how often and how sharply it
      pops on a sudden high-rpm throttle lift. Low = rare soft thump. */
  burble: number;
}

const PROFILES: Record<string, EngineProfile> = {
  // Turbo straight-six coupe: smooth firing, strong spool.
  kaze: { cyl: 6, odd: 0.16, bright: 0.95, turbo: 1.0, level: 1.0, revLimit: 7400, burble: 0.85 },
  // Executive sedan: even, refined, muted.
  shirayuki: { cyl: 6, odd: 0.1, bright: 1.25, turbo: 0.15, level: 0.82, revLimit: 6700, burble: 0.08 },
  // 660cc kei triple: buzzy, uneven, screams at the top.
  tanuki: { cyl: 3, odd: 0.55, bright: 0.75, turbo: 0.35, level: 0.95, revLimit: 8000, burble: 0.2 },
  // AWD boxer four: the classic unequal-length-header warble.
  okami: { cyl: 4, odd: 0.62, bright: 0.9, turbo: 0.5, level: 1.0, revLimit: 6900, burble: 0.9 },
  generic: { cyl: 4, odd: 0.3, bright: 1.0, turbo: 0.4, level: 0.95, revLimit: 7200, burble: 0.4 },
};

/** Which voice carries the engine: the synthesized model above, or the
    recorded-sample engine (domasx2 CC0 rpm-ladder loops + Elantra idle bed).
    "sampled" is the default so the recordings are heard immediately; the
    synth stays fully intact for A/B — flip at runtime from the console via
    `__audioDebug.setEngineMode("synth")`. The toggle also swaps the tire
    screech body between the recorded skid loop and the synth screech, since
    A/B-ing "recorded car sounds" as one experience is the point; one-shots
    (crash, horns) are sample-first with synth fallback regardless of
    mode, because they replace obviously-synthetic beeps rather than a tuned
    model. Until the samples finish decoding, "sampled" behaves exactly like
    "synth" — nothing goes silent while the fetch is in flight. */
export type EngineMode = "synth" | "sampled";

/** Committed recorded-sample set under public/assets/audio. All mono WAV:
    decodeAudioData treats WAV bit-identically in every browser (Safari can't
    decode OGG at all, and MP3/AAC pad ~40ms of encoder delay onto one-shot
    heads and break loop seams). One-shots/beds are 22.05k — their content
    sits below ~10kHz — so the whole set stays ~1.4MB; the four rpm-ladder
    loops keep their original 44.1k samples byte-for-byte (seamless loops).
    Licenses/provenance: see ATTRIBUTIONS.md ("Recorded audio"). */
const SAMPLE_BASE = "/assets/audio";
const SAMPLE_FILES: Record<string, string> = {
  eng0: "engine/loop_0.wav",
  eng1: "engine/loop_1.wav",
  eng2: "engine/loop_2.wav",
  eng3: "engine/loop_3.wav",
  idle: "engine/idle.wav",
  skid: "tires/skid.wav",
  ir: "reverb/tunnel_ir.wav",
  crashDebris: "crash/debris.wav",
  crashMed: "crash/med.wav",
  crashHeavy: "crash/heavy.wav",
  metalL0: "crash/metal_l0.wav",
  metalL1: "crash/metal_l1.wav",
  metalL2: "crash/metal_l2.wav",
  metalL3: "crash/metal_l3.wav",
  metalM0: "crash/metal_m0.wav",
  metalM1: "crash/metal_m1.wav",
  metalM2: "crash/metal_m2.wav",
  metalM3: "crash/metal_m3.wav",
  metalH0: "crash/metal_h0.wav",
  metalH1: "crash/metal_h1.wav",
  metalH2: "crash/metal_h2.wav",
  metalH3: "crash/metal_h3.wav",
  glass0: "crash/glass_0.wav",
  glass1: "crash/glass_1.wav",
  glass2: "crash/glass_2.wav",
  thud0: "crash/thud_0.wav",
  thud1: "crash/thud_1.wav",
  thud2: "crash/thud_2.wav",
  hornPlayer: "horns/player.wav",
  hornA: "horns/npc_a.wav",
  hornB: "horns/npc_b.wav",
  hornC: "horns/npc_c.wav",
  hornTruck: "horns/truck.wav",
};

/** Nominal rpm each ladder loop represents. Tuning anchors, not measured
    engine speeds: within a band the two neighbouring loops crossfade
    equal-power while each plays at playbackRate = rpm/anchor, so pitch keeps
    moving continuously inside the band and the crossfade only morphs
    timbre. Spacing rises like a real ladder so playbackRate stays near 1 at
    each band centre. */
const RPM_ANCHORS = [1050, 2400, 4200, 6400];

/** One crash() invocation, as recorded into the debug log (see
    getCrashLog()) — lets the headless test assert which layers/variants a
    given severity actually produced without decoding any audio output. */
export interface CrashDebugEntry {
  t: number;
  sev: number;
  tier: "soft" | "med" | "heavy";
  kind: "full" | "rattle" | "skip" | "synth";
  /** sample keys actually started this call (empty for skip/synth) */
  layers: string[];
  gain: number;
  /** shared lowpass cutoff in Hz applied to every layer */
  lpHz: number;
  rate: number;
}

/** Severity (m/s of delta-v / normal closing speed — what engine.ts passes:
    NpcHit.relSpeed gated >2.5, wallImpact gated >4; a wall hit's delta-v is
    ~1.07x the closing normal speed, so an 80 km/h head-on arrives as ~25)
    below which a contact is a body thud — no crash body, no glass, no
    debris. Measured in-game: parapet-brush wall impacts arrive at 4-6,
    +15 km/h traffic nudges at ~4, +30 km/h hits at ~8, hard wall hits 20+. */
const CRASH_SOFT_MAX = 6;
/** Severity at and above which the full heavy layer stack (glass + debris
    tail + second metal hit) is in play — ~50 km/h of closing speed. */
const CRASH_HEAVY_MIN = 14;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampRange = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** One voice in the NPC doppler pool: a cheap oscillator (not the full
    player engine graph) routed through a StereoPanner. Assigned to nearby
    traffic cars by updateNpcs() with simple position-tracked voice
    stealing. A filtered-noise branch used to sit alongside the osc; it read
    as white hiss whenever a car pulled close and was removed outright. */
interface NpcVoice {
  osc: OscillatorNode;
  oscG: GainNode;
  mixG: GainNode;
  panner: StereoPannerNode;
  active: boolean;
  lastX: number;
  lastZ: number;
}

export class GameAudio {
  ok = false;
  private ctx!: AudioContext;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;

  /* engine */
  private prof: EngineProfile = PROFILES.generic;
  private oscs: OscillatorNode[] = [];
  private oscGains: GainNode[] = [];
  private wobbleDepth!: GainNode;
  private drivePre!: GainNode;
  private driveTrim!: GainNode;
  private engLP!: BiquadFilterNode;
  private engG!: GainNode;
  private limDepth!: GainNode;
  private inF!: BiquadFilterNode; private inG!: GainNode;
  private exF!: BiquadFilterNode; private exG!: GainNode;
  private turboOsc!: OscillatorNode; private turboG!: GainNode;
  private whineOsc!: OscillatorNode; private whineG!: GainNode;
  private engBus!: GainNode;
  private crackleBus!: GainNode;
  private prevCut = false;
  private prevGear = 1;
  private lastCrackle = 0;
  private peakRpm = 6800;
  private prevThr = 0;
  private lastBurbleTrigger = -10;
  private burbleCount = 0;
  private burbleNext = 0;

  /* tires */
  private tireRoadF!: BiquadFilterNode; private tireRoadG!: GainNode;
  private singF!: BiquadFilterNode; private singG!: GainNode; private singLfoDepth!: GainNode;
  private screechF!: BiquadFilterNode; private screechG!: GainNode; private screechAmDepth!: GainNode;
  private slipEnv = 0;
  /** Separate smoothed envelope driving ONLY the sing/screech voice's mix
      and pitch/character — see update()'s slipDemand handling. Everywhere
      else (skid chirp, ABS tick, layer-1 rolling hum damping) keeps reading
      slipEnv, untouched. Numerically identical to slipEnv whenever
      slipDemand is 0 or omitted (every scenario audited before this field
      existed), since it's derived from max(slip, demand*scale) smoothed
      the same way — so this only changes behavior in the new case. */
  private demandEnv = 0;
  private lastTireT = 0;
  private prevSlipRaw = 0;
  private lastChirp = -1;
  /** Dedicated low-speed brake-squeal voice — the classic rising "eeeee"
      right before a hard stop finishes. Distinct from singF/screechF: those
      are driven by the smoothed slip envelope, which under ABS/ESC-era
      physics.ts sits at a flat ~0.15 for the whole straight-line-ABS stop
      (well under the screech threshold, correctly — real ABS doesn't
      produce sustained screech) and then drops to exactly 0 the instant ABS
      releases, with no transition. This layer fills exactly that gap: it
      triggers on genuine hard/panic braking specifically in the last ~40
      km/h before a stop and rises in pitch as speed approaches zero. */
  private brakeSqF!: BiquadFilterNode; private brakeSqG!: GainNode;
  private prevBrakeSpeed = 0;

  /* environment */
  private wF!: BiquadFilterNode; private wG!: GainNode;
  private windFlutterDepth!: GainNode;
  private roadRumbleF!: BiquadFilterNode; private roadRumbleG!: GainNode;
  private rF!: BiquadFilterNode; private rG!: GainNode;
  private rainGustDepth!: GainNode;
  private nextDroplet = 0;
  private hornOsc: { o1: OscillatorNode; o2: OscillatorNode; g: GainNode } | null = null;
  /* crash one-shots: shuffle bags per variant family (no two consecutive
     picks identical, even across bag refills), a time-based rapid-rehit
     gate (replaces the old play-to-completion latch that swallowed every
     hit for the full length of the longest sample), and a debug log so a
     headless test can assert on what a given severity actually selected. */
  private crashBags = new Map<string, string[]>();
  private crashLastPick = new Map<string, string>();
  private lastCrashT = -10;
  private lastCrashSev = 0;
  private crashLog: CrashDebugEntry[] = [];
  private lastAbsTick = -10;

  /* cabin EQ (interior/exterior switch) */
  private cabinLP!: BiquadFilterNode;
  private cabinPeak!: BiquadFilterNode;

  /* reverb bus: feedback-delay network, no IR assets. Fed by fixed-ratio
     sends from the engine and tire buses; overall wet level + darkening
     driven by setReverb(t). */
  private reverbIn!: GainNode;
  private reverbLP!: BiquadFilterNode;
  private reverbFeedback!: GainNode;
  private reverbWet!: GainNode;
  /** Shared reverb send for all tire layers (synth + recorded skid). Built
      in init(); a field so the lazily-wired skid loop can join it. */
  private tireSend!: GainNode;

  /* recorded-sample layers (lazy-loaded in init(), wired when decoded) */
  private engineMode: EngineMode = "sampled";
  private samples = new Map<string, AudioBuffer>();
  private samplesRequested = false;
  /** true once all four rpm-ladder loops are decoded, wired and running. */
  private engReady = false;
  private sampBus!: GainNode; // sampled-engine sum -> master (+ reverb send)
  private sampLP!: BiquadFilterNode; // load/throttle "airbox" tone for the loops
  private sampLimDepth!: GainNode; // rev-limiter stutter into sampBus.gain
  private loopSrcs: AudioBufferSourceNode[] = [];
  private loopGains: GainNode[] = [];
  private idleG: GainNode | null = null;
  private skidSrc: AudioBufferSourceNode | null = null;
  private skidG: GainNode | null = null;
  private conv: ConvolverNode | null = null;
  private convWet: GainNode | null = null;
  private lastReverbT = 0;
  private hornSample: { src: AudioBufferSourceNode; g: GainNode } | null = null;
  private npcHornRR = 0; // round-robin over the recorded npc horn variants

  /* NPC doppler pool */
  private static readonly NPC_POOL = 8;
  /** User decision (2026-08-17): NPC traffic makes NO engine/proximity
      sound at all — the doppler drone pool is disabled outright.
      updateNpcs() still runs so its bookkeeping (player pose for the
      horn/chirp spatializer) stays fresh, but every voice is released and
      no per-car sound is emitted. Event one-shots (npcHorn/npcChirp) are
      unaffected. */
  private static readonly NPC_VOICES_ENABLED = false;
  /** Upper bound on how many npcs updateNpcs() will scan in one call — a
      cap, not an expectation; callers should already trim to ~6-8. Sizes
      the preallocated scratch arrays below so the per-frame call is
      allocation-free regardless of how many npcs are actually passed. */
  private static readonly NPC_SCAN_MAX = 16;
  private npcVoices: NpcVoice[] = [];
  private lastPx = 0;
  private lastPz = 0;
  private lastPh = 0;
  // Scratch buffers for updateNpcs(), reused every frame instead of
  // allocating: claims[voice] = npc index or null; taken[npc] = already
  // claimed; dist[npc] = squared distance to player (Infinity = invalid,
  // e.g. a stale/dead slot from a reused caller-side buffer); unclaimed =
  // npc indices not yet claimed, filled and insertion-sorted by dist in
  // place each call.
  private npcClaims: (number | null)[] = new Array(GameAudio.NPC_POOL).fill(null);
  private npcTaken: boolean[] = new Array(GameAudio.NPC_SCAN_MAX).fill(false);
  private npcDist: number[] = new Array(GameAudio.NPC_SCAN_MAX).fill(0);
  private npcUnclaimed: number[] = new Array(GameAudio.NPC_SCAN_MAX).fill(0);
  // continuing[voice] = this frame's claim is the SAME car it was already
  // tracking (matched by position in the tracking pass below), as opposed
  // to a fresh activation or a steal from a different car — used to give
  // steals a brief mixG dip instead of gliding oscG straight to the
  // new car's values while staying at full volume throughout.
  private npcContinuing: boolean[] = new Array(GameAudio.NPC_POOL).fill(false);

  /* scrape/grind */
  private scrapeG!: GainNode;
  private scrapeFilters: { f: BiquadFilterNode; baseFreq: number }[] = [];
  private lastScrapeTarget = 0;
  private scrapeWasActive = false;
  private scrapeActiveSince = 0;
  private lastSqueal = -10;

  vol = 1;
  duck = 1;

  private noiseNode() {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    n.start();
    return n;
  }

  /** Band-limited pulse train at the crank half-order. Partial k sits at
      k * rpm*cyl/240 Hz, so k=2 is the firing frequency and the odd partials
      are the half-orders that make an engine sound lumpy rather than buzzy. */
  private engineWave(p: EngineProfile) {
    const N = 28;
    const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let k = 1; k <= N; k++) {
      const order = k / 2;
      const even = k % 2 === 0;
      const a = (even ? 1 : p.odd) / Math.pow(order, p.bright);
      // alternate the phase a little so the partials don't all peak together
      im[k] = a * Math.cos(k * 1.7);
      re[k] = a * Math.sin(k * 1.7) * 0.5;
    }
    return this.ctx.createPeriodicWave(re, im, { disableNormalization: false });
  }

  /** Soft tanh saturation — the growl when the throttle is open. */
  private shaperCurve() {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(2.6 * x) / Math.tanh(2.6);
    }
    return c;
  }

  /** Gentle unity-gain-at-origin soft clip — a safety net for the reverb
      feedback loop, not a growl/drive shaper like shaperCurve() (which has
      ~2.6x gain baked in by design and would defeat the loop's gain
      staging). tanh(x) has slope 1 at the origin, so normal-level signal
      passes through essentially unchanged; only amplitude approaching ±1
      gets compressed, which is exactly the "can't ever scream" ceiling a
      feedback loop should have regardless of how carefully its gain
      staging was reasoned about elsewhere. */
  private limiterCurve() {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x);
    }
    return c;
  }

  /** Pick the per-car engine character. Safe to call before or after init(). */
  setCar(id: string) {
    const p = PROFILES[id] || PROFILES.generic;
    if (p === this.prof) return;
    this.prof = p;
    this.peakRpm = p.revLimit;
    if (!this.ok) return;
    const w = this.engineWave(p);
    for (const o of this.oscs) o.setPeriodicWave(w);
  }

  init() {
    if (this.ok) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      // Cabin EQ: everything (dry layers + reverb wet) sums into master, then
      // through this pair before the speakers. Both are unity at their
      // default values (LP at ~Nyquist, 0dB peak), so leaving setInterior()
      // uncalled reproduces the old direct-to-destination signal exactly.
      this.cabinLP = ctx.createBiquadFilter();
      this.cabinLP.type = "lowpass";
      this.cabinLP.frequency.value = 20000;
      this.cabinPeak = ctx.createBiquadFilter();
      this.cabinPeak.type = "peaking";
      this.cabinPeak.frequency.value = 210;
      this.cabinPeak.Q.value = 1.1;
      this.cabinPeak.gain.value = 0;
      this.master.connect(this.cabinLP).connect(this.cabinPeak).connect(ctx.destination);
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      /* ---- engine ---- */
      this.engBus = ctx.createGain();
      const wave = this.engineWave(this.prof);
      // Detunes are cents; the beating between them reads as cylinder-to-
      // cylinder variation rather than as a chorus effect.
      const spread = [0, -8, 11];
      const lvl = [0.5, 0.3, 0.26];
      this.wobbleDepth = ctx.createGain();
      this.wobbleDepth.gain.value = 0;
      const lfoA = ctx.createOscillator(); lfoA.type = "sine"; lfoA.frequency.value = 5.7;
      const lfoB = ctx.createOscillator(); lfoB.type = "sine"; lfoB.frequency.value = 1.31;
      const lfoMix = ctx.createGain();
      const lfoBTrim = ctx.createGain(); lfoBTrim.gain.value = 0.6;
      lfoA.connect(lfoMix);
      lfoB.connect(lfoBTrim).connect(lfoMix);
      lfoMix.connect(this.wobbleDepth);
      lfoA.start(); lfoB.start();
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(wave);
        o.detune.value = spread[i];
        const g = ctx.createGain();
        g.gain.value = lvl[i];
        o.connect(g).connect(this.engBus);
        this.wobbleDepth.connect(o.detune);
        o.start();
        this.oscs.push(o);
        this.oscGains.push(g);
      }
      this.drivePre = ctx.createGain();
      this.drivePre.gain.value = 1;
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.shaperCurve();
      shaper.oversample = "2x";
      this.driveTrim = ctx.createGain();
      this.driveTrim.gain.value = 1;
      this.engBus.connect(this.drivePre).connect(shaper).connect(this.driveTrim);

      // intake roar (bandpassed, rises with throttle) and exhaust body
      this.inF = ctx.createBiquadFilter();
      this.inF.type = "bandpass";
      this.inF.frequency.value = 1400;
      this.inF.Q.value = 0.7;
      this.inG = ctx.createGain();
      this.inG.gain.value = 0;
      this.noiseNode().connect(this.inF).connect(this.inG);
      this.exF = ctx.createBiquadFilter();
      this.exF.type = "lowpass";
      this.exF.frequency.value = 400;
      this.exF.Q.value = 1.1;
      this.exG = ctx.createGain();
      this.exG.gain.value = 0;
      this.noiseNode().connect(this.exF).connect(this.exG);

      // shared tone shaping: airbox lowpass + two fixed body resonances
      this.engLP = ctx.createBiquadFilter();
      this.engLP.type = "lowpass";
      this.engLP.frequency.value = 900;
      this.engLP.Q.value = 0.9;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 48;
      const body1 = ctx.createBiquadFilter();
      body1.type = "peaking";
      body1.frequency.value = 165;
      body1.Q.value = 1.1;
      body1.gain.value = 6;
      const body2 = ctx.createBiquadFilter();
      body2.type = "peaking";
      body2.frequency.value = 720;
      body2.Q.value = 1.4;
      body2.gain.value = 4;
      this.engG = ctx.createGain();
      this.engG.gain.value = 0;
      this.driveTrim.connect(this.engLP);
      this.inG.connect(this.engLP);
      this.exG.connect(this.engLP);
      this.engLP.connect(hp).connect(body1).connect(body2).connect(this.engG);
      this.engG.connect(this.master);

      // rev-limiter stutter: a square LFO added into the engine gain param
      const limLfo = ctx.createOscillator();
      limLfo.type = "square";
      limLfo.frequency.value = 23;
      this.limDepth = ctx.createGain();
      this.limDepth.gain.value = 0;
      limLfo.connect(this.limDepth).connect(this.engG.gain);
      limLfo.start();

      // one-shot bus for crackles / shift chuffs / limiter bangs
      this.crackleBus = ctx.createGain();
      this.crackleBus.gain.value = 1;
      this.crackleBus.connect(this.master);

      // turbo spool
      this.turboOsc = ctx.createOscillator();
      this.turboOsc.type = "sine";
      this.turboOsc.frequency.value = 3000;
      this.turboG = ctx.createGain();
      this.turboG.gain.value = 0;
      this.turboOsc.connect(this.turboG).connect(this.master);
      this.turboOsc.start();

      // gearbox whine (reverse and 1st)
      this.whineOsc = ctx.createOscillator();
      this.whineOsc.type = "sawtooth";
      this.whineOsc.frequency.value = 600;
      const whineF = ctx.createBiquadFilter();
      whineF.type = "bandpass";
      whineF.frequency.value = 1800;
      whineF.Q.value = 3;
      this.whineG = ctx.createGain();
      this.whineG.gain.value = 0;
      this.whineOsc.connect(this.whineG).connect(whineF).connect(this.master);
      this.whineOsc.start();

      /* ---- tires ---- */
      // Layer 1: rolling contact-patch hum. Subtle, purely speed-driven, no
      // slip dependence — this is what tires sound like even when gripping.
      this.tireRoadF = ctx.createBiquadFilter();
      this.tireRoadF.type = "bandpass";
      this.tireRoadF.frequency.value = 220;
      this.tireRoadF.Q.value = 0.6;
      this.tireRoadG = ctx.createGain();
      this.tireRoadG.gain.value = 0;
      this.noiseNode().connect(this.tireRoadF).connect(this.tireRoadG).connect(this.master);

      // Layer 2: grip "singing" — narrowband squeal, pitch rises with slip.
      // A little chaotic vibrato keeps it from sounding like a pure test tone.
      this.singF = ctx.createBiquadFilter();
      this.singF.type = "bandpass";
      this.singF.frequency.value = 1400;
      this.singF.Q.value = 10;
      this.singG = ctx.createGain();
      this.singG.gain.value = 0;
      this.noiseNode().connect(this.singF).connect(this.singG).connect(this.master);
      const singLfo = ctx.createOscillator();
      singLfo.type = "sine";
      singLfo.frequency.value = 5.3;
      this.singLfoDepth = ctx.createGain();
      this.singLfoDepth.gain.value = 0;
      singLfo.connect(this.singLfoDepth).connect(this.singF.frequency);
      singLfo.start();

      // Layer 3: full screech — broadband noise, amplitude-modulated by two
      // detuned LFOs (same beating trick as the engine wobble) for a chaotic,
      // never-quite-periodic edge instead of a clean tremolo.
      this.screechF = ctx.createBiquadFilter();
      this.screechF.type = "bandpass";
      this.screechF.frequency.value = 1100;
      this.screechF.Q.value = 1.8;
      this.screechG = ctx.createGain();
      this.screechG.gain.value = 0;
      this.noiseNode().connect(this.screechF).connect(this.screechG).connect(this.master);
      const amA = ctx.createOscillator(); amA.type = "sine"; amA.frequency.value = 6.5;
      const amB = ctx.createOscillator(); amB.type = "sine"; amB.frequency.value = 11.3;
      const amMix = ctx.createGain();
      const amBTrim = ctx.createGain(); amBTrim.gain.value = 0.6;
      amA.connect(amMix);
      amB.connect(amBTrim).connect(amMix);
      this.screechAmDepth = ctx.createGain();
      this.screechAmDepth.gain.value = 0;
      amMix.connect(this.screechAmDepth).connect(this.screechG.gain);
      amA.start(); amB.start();

      // Layer 4: low-speed brake squeal. Narrowband and high-Q — a tonal
      // "eeeee", not the broadband screech above — so it reads distinctly
      // even though it can be active at the same time as the screech/sing
      // layers (a hard stop that's also sliding wants both).
      this.brakeSqF = ctx.createBiquadFilter();
      this.brakeSqF.type = "bandpass";
      this.brakeSqF.frequency.value = 1400;
      this.brakeSqF.Q.value = 7;
      this.brakeSqG = ctx.createGain();
      this.brakeSqG.gain.value = 0;
      this.noiseNode().connect(this.brakeSqF).connect(this.brakeSqG).connect(this.master);

      /* ---- environment ---- */
      // Wind roar: lowpassed noise whose cutoff and level open with speed,
      // becoming the dominant sound at high speed. A slow two-LFO "flutter"
      // is summed additively into the gain param (same trick as limDepth on
      // engG.gain) so the roar breathes with a bit of turbulence instead of
      // sitting dead-static.
      this.wF = ctx.createBiquadFilter();
      this.wF.type = "lowpass";
      this.wF.frequency.value = 350;
      this.wG = ctx.createGain();
      this.wG.gain.value = 0;
      this.noiseNode().connect(this.wF).connect(this.wG).connect(this.master);
      const windFlutA = ctx.createOscillator(); windFlutA.type = "sine"; windFlutA.frequency.value = 0.6;
      const windFlutB = ctx.createOscillator(); windFlutB.type = "sine"; windFlutB.frequency.value = 1.7;
      const windFlutMix = ctx.createGain();
      const windFlutBTrim = ctx.createGain(); windFlutBTrim.gain.value = 0.55;
      windFlutA.connect(windFlutMix);
      windFlutB.connect(windFlutBTrim).connect(windFlutMix);
      this.windFlutterDepth = ctx.createGain();
      this.windFlutterDepth.gain.value = 0;
      windFlutMix.connect(this.windFlutterDepth).connect(this.wG.gain);
      windFlutA.start(); windFlutB.start();

      // Road texture bed: low (~55-125Hz) rumble tied to speed, distinct
      // from the (higher, broadband) wind and from the tyre contact-patch
      // hum — this is the tyres-on-concrete layer. Ducked slightly under the
      // tyre screech so the two don't stack into mud (see update()).
      this.roadRumbleF = ctx.createBiquadFilter();
      this.roadRumbleF.type = "lowpass";
      this.roadRumbleF.frequency.value = 90;
      this.roadRumbleF.Q.value = 0.7;
      this.roadRumbleG = ctx.createGain();
      this.roadRumbleG.gain.value = 0;
      this.noiseNode().connect(this.roadRumbleF).connect(this.roadRumbleG).connect(this.master);

      // Rain: was a flat 2600Hz+ highpass on raw noise, i.e. the single
      // brightest, most literally "white noise" layer in the file — that's
      // exactly what two separate bug reports keyed on ("constant white
      // noise"). A car cabin doesn't hear rain as hiss: it's a muffled
      // mid/low body (lowpassed hard, not highpassed at all) plus gusting
      // and — the part that actually reads as "rain" to a listener rather
      // than generic noise — a sparse random pattern of droplet impacts.
      this.rF = ctx.createBiquadFilter();
      this.rF.type = "lowpass";
      this.rF.frequency.value = 950; // ceiling; update() only narrows this further with speed
      this.rF.Q.value = 0.8;
      this.rG = ctx.createGain();
      this.rG.gain.value = 0;
      this.noiseNode().connect(this.rF).connect(this.rG).connect(this.master);
      // Slow gusting, same additive-LFO-into-gain trick as windFlutterDepth
      // but slower (gusts are longer-period than wind buffeting) — depth is
      // itself scaled by the current rain body level in update(), so it's
      // silent whenever rG's target is silent.
      const rainGustA = ctx.createOscillator(); rainGustA.type = "sine"; rainGustA.frequency.value = 0.15;
      const rainGustB = ctx.createOscillator(); rainGustB.type = "sine"; rainGustB.frequency.value = 0.37;
      const rainGustMix = ctx.createGain();
      const rainGustBTrim = ctx.createGain(); rainGustBTrim.gain.value = 0.5;
      rainGustA.connect(rainGustMix);
      rainGustB.connect(rainGustBTrim).connect(rainGustMix);
      this.rainGustDepth = ctx.createGain();
      this.rainGustDepth.gain.value = 0;
      rainGustMix.connect(this.rainGustDepth).connect(this.rG.gain);
      rainGustA.start(); rainGustB.start();

      /* ---- reverb bus ----
         A small feedback-delay network standing in for an impulse response:
         four short, non-harmonically-related delay taps feed a shared sum,
         then a feedback gain back into the input; the wet output taps off
         that same sum in parallel with the dry master path. Fixed-ratio
         sends from the engine and tire buses feed the network at all times;
         setReverb(t) only moves wet level, feedback (tail length) and
         lowpass cutoff, so t=0 (wet gain 0) is silent and the dry path is
         untouched — bit-identical to before this feature.

         Two things here fix a real crash (four unity-gain delay branches
         summed into one plain GainNode, multiplying the round-trip loop
         gain by the tap count — at t=1's old feedback of 0.5 that's a
         worst-case loop gain of 4*0.5=2.0, unconditionally unstable, which
         blew the lowpass's internal state into NaN and got the node
         disabled by the browser, i.e. exactly the reported screech-then-
         silence):
           1. reverbTap's own gain is set to 1/N (N=4 taps), so a fully
              constructive sum of all four branches is bounded to unity by
              the triangle inequality — the mixing stage itself can never
              amplify, only average. Round-trip loop gain is then bounded by
              reverbFeedback.gain alone, and that's capped well under 1 (see
              setReverb()), so the loop is provably convergent regardless of
              frequency content or delay-time alignment.
           2. The darkening lowpass no longer sits inside the feedback path
              at all — recomputing a resonant biquad's coefficients while it
              carries loop energy is itself a destabilizing move, so it's
              moved to a single-pass position on the (non-looping) wet
              output only. A per-bounce darkening quality is lost, but loop
              stability no longer depends on the filter's parameters at all.
         A gentle unity-gain-at-origin soft clip (limiterCurve(), NOT
         shaperCurve() — that one adds ~2.6x drive gain by design and would
         undo the tap normalization above) sits in the loop too, as a
         backstop against any transient this reasoning missed. */
      this.reverbIn = ctx.createGain();
      this.reverbIn.gain.value = 1;
      const reverbTap = ctx.createGain();
      reverbTap.gain.value = 0.25;
      for (const dt of [0.017, 0.023, 0.029, 0.037]) {
        const d = ctx.createDelay(0.5);
        d.delayTime.value = dt;
        this.reverbIn.connect(d);
        d.connect(reverbTap);
      }
      this.reverbFeedback = ctx.createGain();
      this.reverbFeedback.gain.value = 0.15;
      const reverbLoopLimiter = ctx.createWaveShaper();
      reverbLoopLimiter.curve = this.limiterCurve();
      reverbLoopLimiter.oversample = "none";
      reverbTap.connect(this.reverbFeedback).connect(reverbLoopLimiter).connect(this.reverbIn);

      this.reverbLP = ctx.createBiquadFilter();
      this.reverbLP.type = "lowpass";
      this.reverbLP.frequency.value = 6000;
      this.reverbWet = ctx.createGain();
      this.reverbWet.gain.value = 0;
      reverbTap.connect(this.reverbLP).connect(this.reverbWet).connect(this.master);

      const engSend = ctx.createGain();
      engSend.gain.value = 0.18;
      this.engG.connect(engSend).connect(this.reverbIn);
      this.tireSend = ctx.createGain();
      this.tireSend.gain.value = 0.22;
      this.tireRoadG.connect(this.tireSend);
      this.singG.connect(this.tireSend);
      this.screechG.connect(this.tireSend);
      this.tireSend.connect(this.reverbIn);

      /* ---- sampled engine bus ----
         Prebuilt empty (cheap: three nodes, no sources) so the lazily
         decoded rpm-ladder loops have somewhere to land without re-plumbing
         anything: loop sources -> per-loop crossfade gains -> sampLP (the
         load/throttle "airbox" lowpass, the sampled path's counterpart of
         engLP) -> sampBus -> master, with the same fixed-ratio reverb send
         the synth engine has, so tunnels treat both voices alike. The
         limiter stutter LFO is shared with the synth path via a second
         depth gain into sampBus.gain. Everything downstream of master
         (volume, duck, cabin EQ, mute) applies unchanged. */
      this.sampBus = ctx.createGain();
      this.sampBus.gain.value = 0;
      this.sampLP = ctx.createBiquadFilter();
      this.sampLP.type = "lowpass";
      this.sampLP.frequency.value = 900;
      this.sampLP.Q.value = 0.8;
      this.sampLP.connect(this.sampBus);
      this.sampBus.connect(this.master);
      const sampSend = ctx.createGain();
      sampSend.gain.value = 0.18;
      this.sampBus.connect(sampSend).connect(this.reverbIn);
      this.sampLimDepth = ctx.createGain();
      this.sampLimDepth.gain.value = 0;
      limLfo.connect(this.sampLimDepth).connect(this.sampBus.gain);

      /* ---- NPC doppler pool ----
         Fixed pool of cheap voices (one osc + filtered noise each, not the
         full engine graph) assigned to the nearest active traffic cars each
         frame by updateNpcs(). All nodes are built once here; per-frame work
         is param moves only (frequency/gain/pan). */
      for (let i = 0; i < GameAudio.NPC_POOL; i++) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = 110;
        const oscG = ctx.createGain();
        oscG.gain.value = 0;
        osc.connect(oscG);
        osc.start();
        const mixG = ctx.createGain();
        mixG.gain.value = 0;
        oscG.connect(mixG);
        const panner = ctx.createStereoPanner();
        mixG.connect(panner).connect(this.master);
        this.npcVoices.push({ osc, oscG, mixG, panner, active: false, lastX: 0, lastZ: 0 });
      }

      /* ---- scrape/grind voice ----
         Sustained contact voice: one noise source through three resonant
         bandpass peaks (metal-on-concrete character, not a flat hiss), all
         prebuilt here and summed into scrapeG, which setScrape() drives
         per-frame. Squeal transients reuse the existing burst() one-shot
         machinery rather than a dedicated node. */
      this.scrapeG = ctx.createGain();
      this.scrapeG.gain.value = 0;
      const scrapeSrc = this.noiseNode();
      for (const b of [
        { f: 750, q: 3.5, mix: 0.4 },
        { f: 2100, q: 4, mix: 0.35 },
        { f: 4200, q: 3, mix: 0.25 },
      ]) {
        const f = ctx.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.value = b.f;
        f.Q.value = b.q;
        const g = ctx.createGain();
        g.gain.value = b.mix;
        scrapeSrc.connect(f).connect(g).connect(this.scrapeG);
        this.scrapeFilters.push({ f, baseFreq: b.f });
      }
      this.scrapeG.connect(this.master);

      this.ok = true;
      // Recorded samples: kick the fetch+decode off now — init() runs on the
      // same user gesture that unlocks the AudioContext, so this is the
      // "lazy-load on first gesture" point. Fire-and-forget: until buffers
      // land, the synth carries everything.
      void this.loadSamples();
      // Debug-only: makes getLevels() reachable from the browser console as
      // __audioDebug.getLevels() without engine.ts needing to wire anything
      // up — for identifying which layer a "mystery noise" report is coming
      // from in one call instead of guessing (see getLevels() below).
      try { (window as unknown as { __audioDebug?: GameAudio }).__audioDebug = this; } catch {}
    } catch {
      this.ok = false;
    }
  }

  /** Runtime A/B toggle between the synthesized engine and the recorded
      sample engine. Callable any time (console: `__audioDebug.setEngineMode`);
      update() crossfades the voices on its normal smoothing constants, so
      switching mid-drive is a quick fade, not a click. */
  setEngineMode(m: EngineMode) {
    this.engineMode = m === "synth" ? "synth" : "sampled";
  }

  getEngineMode(): EngineMode {
    return this.engineMode;
  }

  /** True when the sampled engine is actually carrying the car this frame. */
  private sampledActive() {
    return this.engineMode === "sampled" && this.engReady;
  }

  /** Fetch + decode the recorded sample set, then wire the continuous
      voices (rpm-ladder loops, idle bed, skid loop, tunnel IR). Individual
      failures are non-fatal: whatever decodes is used, whatever doesn't
      keeps its synth fallback. Never throws. */
  private async loadSamples() {
    if (this.samplesRequested) return;
    this.samplesRequested = true;
    await Promise.all(
      Object.entries(SAMPLE_FILES).map(async ([key, path]) => {
        try {
          const res = await fetch(`${SAMPLE_BASE}/${path}`);
          if (!res.ok) return;
          const raw = await res.arrayBuffer();
          const buf = await this.ctx.decodeAudioData(raw);
          this.samples.set(key, buf);
        } catch {
          /* missing/undecodable file, or ctx closed mid-flight: skip */
        }
      })
    );
    if (!this.ok) return; // disposed while the fetch was in flight
    try {
      this.wireSampledEngine();
      this.wireSkid();
      this.wireConvolver();
    } catch {
      /* leave whatever failed on its synth fallback */
    }
  }

  /** Start the four ladder loops + idle bed against the prebuilt sampled
      bus. Sources run forever at gain 0 until update() mixes them in —
      same always-running pattern as every synth layer in init(). */
  private wireSampledEngine() {
    const c = this.ctx;
    const loops = [
      this.samples.get("eng0"), this.samples.get("eng1"),
      this.samples.get("eng2"), this.samples.get("eng3"),
    ];
    if (loops.some((b) => !b)) return; // ladder incomplete -> stay on synth
    for (const buf of loops) {
      const src = c.createBufferSource();
      src.buffer = buf!;
      src.loop = true;
      const g = c.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.sampLP);
      src.start();
      this.loopSrcs.push(src);
      this.loopGains.push(g);
    }
    const idle = this.samples.get("idle");
    if (idle) {
      const src = c.createBufferSource();
      src.buffer = idle;
      src.loop = true;
      this.idleG = c.createGain();
      this.idleG.gain.value = 0;
      // Straight into sampBus, skipping sampLP: the idle bed is a real
      // in-car recording that is already dark; the airbox lowpass sits low
      // at idle rpm and would double-muffle it.
      src.connect(this.idleG).connect(this.sampBus);
      src.start();
    }
    this.engReady = true;
  }

  /** Recorded skid loop (qubodup, CC-BY 3.0), gain-driven by the same slip
      envelope as the synth screech and sharing its reverb send. */
  private wireSkid() {
    const buf = this.samples.get("skid");
    if (!buf) return;
    const c = this.ctx;
    this.skidSrc = c.createBufferSource();
    this.skidSrc.buffer = buf;
    this.skidSrc.loop = true;
    this.skidG = c.createGain();
    this.skidG.gain.value = 0;
    this.skidSrc.connect(this.skidG);
    this.skidG.connect(this.master);
    this.skidG.connect(this.tireSend);
    this.skidSrc.start();
  }

  /** Real underpass impulse response on a ConvolverNode wet bus, fed by the
      same engine/tire sends as the synthetic feedback-delay reverb. Once
      wired, setReverb() drives this instead of the FDN (never both — two
      reverbs would smear); with no IR decoded, setReverb() behaves exactly
      as before. UI sounds never touch reverbIn, so they stay dry. */
  private wireConvolver() {
    const buf = this.samples.get("ir");
    if (!buf) return;
    const c = this.ctx;
    this.conv = c.createConvolver();
    this.conv.normalize = true;
    this.conv.buffer = buf;
    this.convWet = c.createGain();
    this.convWet.gain.value = 0;
    this.reverbIn.connect(this.conv);
    this.conv.connect(this.convWet).connect(this.master);
    // Hand the tail over: kill the FDN's wet/feedback so the convolver is
    // the only reverb voice from here on, and replay the current tunnel
    // amount onto the new wet bus so wiring mid-tunnel doesn't go dry.
    this.reverbWet.gain.cancelScheduledValues(c.currentTime);
    this.reverbWet.gain.value = 0;
    this.reverbFeedback.gain.cancelScheduledValues(c.currentTime);
    this.reverbFeedback.gain.value = 0;
    this.setReverb(this.lastReverbT);
  }

  /** Nearest zero crossing (rising or falling) to `t` seconds in channel 0,
      searched forward — used to snap sample loop points so a mid-waveform
      loop seam doesn't click. */
  private zeroCrossAt(buf: AudioBuffer, t: number) {
    const d = buf.getChannelData(0);
    const start = Math.min(d.length - 2, Math.max(1, Math.round(t * buf.sampleRate)));
    for (let i = start; i < d.length - 1; i++) {
      if ((d[i] <= 0 && d[i + 1] > 0) || (d[i] >= 0 && d[i + 1] < 0)) return i / buf.sampleRate;
    }
    return t;
  }

  /** Debug snapshot of every noise/tone layer's current live gain, for
      diagnosing "mystery background sound" reports from the console:
      `__audioDebug.getLevels()` (this instance is auto-exposed there by
      init()). Returns null if audio isn't initialized. Read-only — reading
      .value off existing nodes, no extra state, negligible cost, safe to
      call from devtools at any time including mid-gameplay. */
  getLevels() {
    if (!this.ok) return null;
    // NPC pool detail: npcVoicesActive alone can't tell a diagnosis apart
    // from "the pool is fine, something else is the source" — these let a
    // pasted snapshot show the pool's actual output and the closest voice's
    // character (distance/gain/cutoff) directly, rather than needing a
    // follow-up round-trip to ask for them.
    let npcOscSum = 0;
    let nearest: { dist: number; oscG: number } | null = null;
    let nearestD2 = Infinity;
    for (const v of this.npcVoices) {
      if (!v.active) continue;
      npcOscSum += v.oscG.gain.value;
      const dx = v.lastX - this.lastPx, dz = v.lastZ - this.lastPz;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        nearest = { dist: Math.sqrt(d2), oscG: v.oscG.gain.value };
      }
    }
    return {
      engineMode: this.engineMode,
      sampledEngineReady: this.engReady,
      samplesDecoded: this.samples.size,
      sampledEngine: this.sampBus.gain.value,
      sampledIdle: this.idleG ? this.idleG.gain.value : null,
      sampledSkid: this.skidG ? this.skidG.gain.value : null,
      convolverWet: this.convWet ? this.convWet.gain.value : null,
      engine: this.engG.gain.value,
      intake: this.inG.gain.value,
      exhaust: this.exG.gain.value,
      turbo: this.turboG.gain.value,
      gearWhine: this.whineG.gain.value,
      tireRoll: this.tireRoadG.gain.value,
      tireSing: this.singG.gain.value,
      tireScreech: this.screechG.gain.value,
      brakeSqueal: this.brakeSqG.gain.value,
      roadRumble: this.roadRumbleG.gain.value,
      wind: this.wG.gain.value,
      rain: this.rG.gain.value,
      scrape: this.scrapeG.gain.value,
      reverbWet: this.reverbWet.gain.value,
      npcVoicesActive: this.npcVoices.filter((v) => v.active).length,
      npcOscSum,
      npcNearest: nearest,
      master: this.master.gain.value,
    };
  }

  /** Smoothed param write — per-frame .value writes zipper badly on filters. */
  private sp(p: AudioParam, v: number, tau = 0.03) {
    p.setTargetAtTime(v, this.ctx.currentTime, tau);
  }

  /** Short filtered noise burst: exhaust crackle, shift chuff, limiter bang. */
  private burst(level: number, freq: number, decay: number, q = 1.2) {
    const c = this.ctx, t = c.currentTime;
    const n = Math.max(64, Math.floor(c.sampleRate * decay * 3));
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++)
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * decay));
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.value = level;
    src.connect(f).connect(g).connect(this.crackleBus);
    src.start(t);
    src.stop(t + decay * 3 + 0.02);
  }

  tick() {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = "square";
    o.frequency.value = 1650;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.035);
  }

  /* ---- stalk click (lane O) — self-contained one-shot, no samples ---- */
  /** Rate limit + counter for stalkClick(). The 70ms floor is under any
      humanly-repeatable G press (autorepeat is filtered at the key handler),
      so a rapid flash-to-pass volley clicks once per press without ever
      stacking two transients into a crackle. Counter is read by the headless
      audio check via `__audioDebug.getStalkClickCount()`. */
  private lastStalkClick = -1;
  private stalkClickCount = 0;
  getStalkClickCount() {
    return this.stalkClickCount;
  }

  /** Mechanical column-stalk click for the high-beam OFF→ON edge. Fully
      synthesized (zero bytes, no fetch): a 3ms bandpassed contact snap, a
      damped plastic resonance falling 1.3k→0.9k, and a low ~330Hz "thock"
      that gives it switchgear weight instead of UI-beep glassiness. Total
      ring-out ~30ms, peak well under horn/crash levels. Routed into
      `master`, so volume/duck/mute and the cabin EQ all apply unchanged. */
  stalkClick() {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime;
    if (t - this.lastStalkClick < 0.07) return;
    this.lastStalkClick = t;
    this.stalkClickCount++;
    // 1) contact snap: ~3ms noise transient through a bright bandpass
    const n = Math.max(64, Math.floor(c.sampleRate * 0.004));
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++)
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.0012));
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    bp.Q.value = 1.8;
    const ng = c.createGain();
    ng.gain.value = 0.09;
    src.connect(bp).connect(ng).connect(this.master);
    src.start(t);
    src.stop(t + 0.012);
    // 2) plastic resonance: fast-damped sine with a small downward pitch dip
    const o1 = c.createOscillator();
    o1.type = "sine";
    o1.frequency.setValueAtTime(1300, t);
    o1.frequency.exponentialRampToValueAtTime(900, t + 0.014);
    const g1 = c.createGain();
    g1.gain.setValueAtTime(0.042, t);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
    o1.connect(g1).connect(this.master);
    o1.start(t);
    o1.stop(t + 0.022);
    // 3) low mechanical thock: the lever seating against its detent
    const o2 = c.createOscillator();
    o2.type = "sine";
    o2.frequency.setValueAtTime(330, t);
    o2.frequency.exponentialRampToValueAtTime(240, t + 0.02);
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0.05, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
    o2.connect(g2).connect(this.master);
    o2.start(t);
    o2.stop(t + 0.032);
  }
  /* ---- end stalk click (lane O) ---- */

  /* ---- interior trim creaks (lane U) ----
     Research notes (automotive: when does cabin trim actually creak?):
     Interior plastic creaks are stick-slip friction at trim interfaces —
     dashboard-to-A-pillar joints, door cards, the center console, parcel
     shelf — micro-shifting as the body-in-white flexes under changing load.
     The realities this model encodes:
       - Creaks fire on LOAD TRANSIENTS, not sustained states: the onset of
         hard braking (nose dive), hard acceleration (squat), roll build-up
         at turn-in, and sharp grade breaks (ramp gores / crest transitions)
         that twist the shell. A car settled into a steady corner or a held
         constant brake mostly goes quiet — the panels have already slipped
         to their new equilibrium and re-stuck.
       - Occurrence is stochastic (stick-slip): the same input does not
         always creak — whether a joint slips depends on temperature and
         where it last re-stuck — so triggers are probabilistic (~30-60% per
         qualifying transient) with a randomized refractory (0.8-2.5s) so it
         never machine-guns.
       - Different components have distinct characters: a dash joint "ticks"
         (short, bright, 2.2-3.5kHz), a door card "creaks" (grainy midrange
         crick, 1.2-2.2kHz with a sweeping resonance), and the structure
         "groans" (lower 400-800Hz, longer). Three synthesized voices below,
         each randomized per event so no two creaks stamp out the same sound.
       - Cabin creaks are QUIET — just above the noise floor, more felt than
         heard — and wind/road noise masks them at highway pace: you hear
         trim at parking-lot speeds, not at 140 km/h. Level scales down with
         speed and is a whisper even at its loudest.
     Inputs arrive additively through update() (axS/ayS smoothed body accel
     + slope from CarState); per-frame derivatives are maintained here.
     pitchDyn/rollDyn are deliberately NOT separate inputs — physics.ts
     derives both from axS/ayS by first-order lag, so their derivatives
     carry no information the axS/ayS jerks don't already have.
     Camera: the only existing camera-aware audio is setInterior()'s
     cockpit-only cabin EQ — there is no per-layer exterior ducking to
     mirror — so a cabinCam flag (cockpit OR POV; both are in-cabin views)
     is passed additively from the existing update() call site; exterior
     cameras duck creaks to 25% rather than mute (trim is still faintly
     audible from outside a car, and a hard mute would make camera cycling
     mid-creak read as a dropout). */
  /** Hard ceiling on any single creak event's gain — well under the
      engine's ~0.16-0.18 full-song level and under wind at speed. The
      headless check asserts every logged fire stays at or below this. */
  private static readonly CREAK_GAIN_CAP = 0.06;
  private creakPrevAx = 0;
  private creakPrevAy = 0;
  private creakPrevSlope = 0;
  /** Internally-smoothed slope (first-order, ~8/s — matching the smoothing
      physics.ts applies to axS/ayS/pitchDyn). CarState.slope itself is
      recomputed each frame from raw terrain heights with NO smoothing, so a
      single-frame step at a geometry seam would read as an enormous fake
      derivative; differentiating the smoothed copy turns a step of D into a
      jerk of ~8*D — a real ramp-gore grade break (D~0.08+) still qualifies
      strongly, per-frame height-sampling noise stays silent. */
  private creakSlopeS = 0;
  private creakHavePrev = false;
  /** No trigger rolls before this time: 0.5s after a failed roll (the joint
      "stuck" for this transient), 0.8-2.5s randomized after a fire. */
  private creakGateT = 0;
  private creakCount = 0;
  private creakLog: {
    t: number;
    kind: "roll" | "fire";
    axis: "long" | "lat" | "vert";
    strength: number;
    p: number;
    voice?: string;
    gain?: number;
    cabin?: boolean;
  }[] = [];
  getCreakCount() {
    return this.creakCount;
  }
  /** Last ~64 trigger rolls/fires — consumed by test/audio-creak-check.mjs
      via __audioDebug to assert the probabilistic model headlessly. */
  getCreakLog() {
    return this.creakLog;
  }

  /** Stick-slip grain buffer: a few randomly-spaced, randomly-damped noise
      micro-grains rather than one smooth burst — the "crick" texture of a
      plastic joint slipping in discrete jumps. First grain at t=0 so the
      event lands on the transient that caused it. */
  private creakGrainBuf(dur: number, grains: number, grainDecay: number) {
    const c = this.ctx;
    const n = Math.max(128, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let gi = 0; gi < grains; gi++) {
      const start = gi === 0 ? 0 : Math.floor(Math.random() * n * 0.7);
      const amp = 0.5 + Math.random() * 0.5;
      const tau = c.sampleRate * grainDecay * (0.7 + Math.random() * 0.6);
      for (let i = start; i < n; i++) {
        const e = Math.exp(-(i - start) / tau);
        if (e < 0.001) break;
        d[i] += (Math.random() * 2 - 1) * amp * e;
      }
    }
    return buf;
  }

  /** Synthesize one creak event: grain buffer through a resonant bandpass
      whose peak SWEEPS slightly over the event (stick-slip resonance shifts
      as the joint moves), with an exponential release. Everything routed
      into `master`, so volume/duck/mute and the cabin EQ apply unchanged.
      `mask` is the combined speed-masking x camera factor (0..1). */
  private creakFire(now: number, axis: "long" | "lat" | "vert", mask: number, strength: number, p: number, cabin: boolean) {
    const c = this.ctx, t = c.currentTime;
    // Weighted voice pick, biased by what moved: longitudinal dive/squat
    // rattles the dash, roll works the door cards, chassis twist groans.
    const r = Math.random();
    const voice =
      axis === "long"
        ? r < 0.4 ? "tick" : r < 0.85 ? "creak" : "groan"
        : axis === "lat"
          ? r < 0.2 ? "tick" : r < 0.65 ? "creak" : "groan"
          : r < 0.15 ? "tick" : r < 0.5 ? "creak" : "groan";
    let dur: number, f0: number, sweep: number, q: number, grains: number, gDecay: number, lvl: number;
    if (voice === "tick") {
      // dash joint: one or two short bright ticks
      dur = 0.03 + Math.random() * 0.025;
      f0 = 2200 + Math.random() * 1300; // 2.2-3.5kHz plastic range
      sweep = 0.86 + Math.random() * 0.1; // slight downward settle
      q = 8;
      grains = Math.random() < 0.4 ? 2 : 1;
      gDecay = 0.008;
      lvl = 0.55;
    } else if (voice === "creak") {
      // door card / console: grainy midrange crick with a wandering peak
      dur = 0.06 + Math.random() * 0.06;
      f0 = 1200 + Math.random() * 1000; // 1.2-2.2kHz
      sweep = Math.random() < 0.5 ? 0.82 + Math.random() * 0.1 : 1.08 + Math.random() * 0.12;
      q = 6 + Math.random() * 4;
      grains = 3 + Math.floor(Math.random() * 3);
      gDecay = 0.014;
      lvl = 1.0;
    } else {
      // structural groan: lower, longer, rarer
      dur = 0.09 + Math.random() * 0.06;
      f0 = 420 + Math.random() * 380; // 400-800Hz
      sweep = 0.78 + Math.random() * 0.1;
      q = 4;
      grains = 2 + Math.floor(Math.random() * 2);
      gDecay = 0.026;
      lvl = 1.15;
    }
    const gain = Math.min(
      GameAudio.CREAK_GAIN_CAP,
      0.04 * lvl * mask * (0.8 + Math.random() * 0.4)
    );
    const src = c.createBufferSource();
    src.buffer = this.creakGrainBuf(dur, grains, gDecay);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f0 * sweep, t + dur);
    bp.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.03);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
    this.creakCount++;
    this.creakLog.push({ t: now, kind: "fire", axis, strength, p, voice, gain, cabin });
    if (this.creakLog.length > 64) this.creakLog.shift();
  }

  /** Per-frame trigger model, driven from update(). Maintains jerk
      (d/dt of the smoothed accelerations + slope) and rolls a probabilistic
      trigger when a transient qualifies. Thresholds are set against
      physics.ts's axS/ayS smoothing (first-order at 9/s): a max-effort
      brake from speed peaks around |jerk| ~ 80 m/s^3, a moderate one ~45,
      a gentle one ~18 — so gentle driving never rolls at all. */
  private trimCreaks(
    now: number, dt: number, speed: number,
    axS: number, ayS: number, slope: number, cabinCam: boolean
  ) {
    const h = Math.max(dt, 1 / 240);
    this.creakSlopeS += (slope - this.creakSlopeS) * Math.min(1, 8 * h);
    const jx = (axS - this.creakPrevAx) / h;
    const jy = (ayS - this.creakPrevAy) / h;
    const js = (this.creakSlopeS - this.creakPrevSlope) / h;
    const had = this.creakHavePrev;
    this.creakPrevAx = axS;
    this.creakPrevAy = ayS;
    this.creakPrevSlope = this.creakSlopeS;
    this.creakHavePrev = true;
    if (!had) return; // no derivative on the first sample
    if (now < this.creakGateT) return; // stuck/refractory
    // Lateral threshold is a touch lower (roll build-up works the door
    // cards more readily than pitch works the dash); slope transients are
    // grade-break jolts — only sharp gore/crest crossings qualify.
    const sLong = smoothstep(28, 70, Math.abs(jx));
    const sLat = smoothstep(22, 60, Math.abs(jy));
    const sVert = smoothstep(0.15, 0.5, Math.abs(js));
    const strength = Math.max(sLong, sLat, sVert);
    if (strength <= 0) return;
    const axis: "long" | "lat" | "vert" =
      strength === sLong ? "long" : strength === sLat ? "lat" : "vert";
    const p = 0.3 + strength * 0.3; // stick-slip: 30-60% per qualifying transient
    const fired = Math.random() < p;
    this.creakLog.push({ t: now, kind: "roll", axis, strength, p });
    if (this.creakLog.length > 64) this.creakLog.shift();
    if (!fired) {
      // The joint stuck this time. Short gate so the SAME continuing
      // transient doesn't get re-rolled every frame (it was one event).
      this.creakGateT = now + 0.5;
      return;
    }
    this.creakGateT = now + 0.8 + Math.random() * 1.7; // randomized refractory
    // Masking-aware level: full at parking-lot speeds, tucked well under
    // wind/road by highway pace; exterior cameras duck to 25%.
    const mask = (1 - 0.55 * smoothstep(8, 30, speed)) * (cabinCam ? 1 : 0.25);
    this.creakFire(now, axis, mask, strength, p, cabinCam);
  }
  /* ---- end interior trim creaks (lane U) ---- */

  /** One-shot: play a decoded sample through gain (+ optional slight
      repitch for variety) into `dest`. Returns the source's duration/rate. */
  private playSample(
    buf: AudioBuffer, gain: number, dest: AudioNode, rate = 1, delay = 0
  ) {
    const c = this.ctx, t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start(t);
    return buf.duration / rate + delay;
  }

  /** Draw a variant key from a per-family shuffle bag: every variant in the
      family plays once before any repeats, and the first draw of a fresh
      bag is swapped away from the previous draw so two consecutive picks
      are never identical (unless only one variant of the family decoded).
      Only keys whose buffers actually decoded enter the bag. */
  private drawVariant(family: string, keys: string[]): AudioBuffer | null {
    const avail = keys.filter((k) => this.samples.has(k));
    if (!avail.length) return null;
    let bag = this.crashBags.get(family);
    if (!bag || !bag.length) {
      bag = avail.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      if (bag.length > 1 && bag[bag.length - 1] === this.crashLastPick.get(family)) {
        const j = Math.floor(Math.random() * (bag.length - 1));
        [bag[bag.length - 1], bag[j]] = [bag[j], bag[bag.length - 1]];
      }
      this.crashBags.set(family, bag);
    }
    const key = bag.pop()!;
    this.crashLastPick.set(family, key);
    return this.samples.get(key) ?? null;
  }

  /** Last ~48 crash() invocations with what each actually selected —
      consumed by test/audio-crash-check.mjs via __audioDebug. */
  getCrashLog(): CrashDebugEntry[] {
    return this.crashLog;
  }

  /* Severity-mapped crash. `intensity` is m/s of delta-v (wall hits) or
     normal closing speed (NPC hits) — see CRASH_SOFT_MAX above for the
     measured in-game distribution. Three audible regimes, continuously
     scaled inside each:
       soft  (<6):   dull low-passed body thud — one generic-impact variant,
                     sometimes a quiet light-metal tap. No crash body, no
                     glass, no debris: a parapet brush must not sound like
                     an accident (the sustained part of that contact is the
                     scrape bed's job, which keeps running independently).
       med  (6-14):  recorded crash body + medium metal variant; a debris
                     tail fades in probabilistically toward the top.
       heavy (>=14): heavy crash body + heavy metal + second offset metal
                     hit + glass + debris tail.
     Gain and a shared lowpass open continuously with severity (a 6.5 hit is
     quieter AND duller than a 13 hit even though both are "med"), and every
     layer gets randomized variant selection (shuffle bags), playbackRate
     (+/-12-15%), gain (+/-3dB) and start offsets, so no two hits stamp out
     the same render.
     Rapid re-hits: a second call within 120ms is the same contact burst
     (dropped); within 700ms a not-clearly-bigger hit plays a single quiet
     metal rattle instead of a full crash — multi-contact pileups stay alive
     without machine-gunning the full stack (the old latch instead went
     dead for the entire length of the longest sample: 2.2s after a heavy). */
  crash(intensity: number) {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime;
    const tier: CrashDebugEntry["tier"] =
      intensity >= CRASH_HEAVY_MIN ? "heavy" : intensity >= CRASH_SOFT_MAX ? "med" : "soft";
    const log = (e: Omit<CrashDebugEntry, "t" | "sev" | "tier">) => {
      this.crashLog.push({ t, sev: intensity, tier, ...e });
      if (this.crashLog.length > 48) this.crashLog.shift();
    };
    const since = t - this.lastCrashT;
    if (since < 0.12) {
      log({ kind: "skip", layers: [], gain: 0, lpHz: 0, rate: 1 });
      return;
    }
    // 0..1 across the audible range: 0 at the call-site gate, 1 at ~27 m/s
    // (an ~90 km/h head-on). Drives gain and filter continuously.
    const u = clamp01((intensity - 2.5) / 24.5);
    // shared tone: soft bumps are dull (600-900Hz), full crashes open up
    const lpHz = 600 * Math.pow(2, u * 4.2) * (0.85 + Math.random() * 0.3);
    const gain =
      (0.16 + 0.48 * Math.pow(u, 0.8)) * Math.pow(10, ((Math.random() * 6 - 3) / 20));
    const rate = 0.88 + Math.random() * 0.26; // +/-12-14% repitch, per-hit
    const metalKeys =
      tier === "heavy" ? ["metalH0", "metalH1", "metalH2", "metalH3"]
      : tier === "med" ? ["metalM0", "metalM1", "metalM2", "metalM3"]
      : ["metalL0", "metalL1", "metalL2", "metalL3"];
    // bag per tier — a shared "metal" bag would carry another tier's
    // leftover variants into this hit
    const metalFam = "metal-" + tier;

    const rattle = since < 0.7 && intensity < this.lastCrashSev * 1.4;
    this.lastCrashT = t;
    if (!rattle) this.lastCrashSev = intensity;

    if (this.samples.has("crashMed") || this.samples.has("thud0")) {
      const g = c.createGain();
      g.gain.value = rattle ? gain * 0.4 : gain;
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = rattle ? Math.min(lpHz, 1800) : lpHz;
      lp.Q.value = 0.7;
      lp.connect(g).connect(this.master);
      const layers: string[] = [];
      const play = (key: string, lg: number, r: number, delay = 0) => {
        const buf = this.samples.get(key);
        if (!buf) return;
        this.playSample(buf, lg, lp, r, delay);
        layers.push(key);
      };
      const draw = (family: string, keys: string[]) => {
        const buf = this.drawVariant(family, keys);
        if (!buf) return null;
        return this.crashLastPick.get(family)!;
      };
      if (rattle) {
        // one quiet metal tap from the tier's bag — keeps a pileup's
        // follow-up contacts audible without restacking the full crash
        const k = draw(metalFam, metalKeys);
        if (k) play(k, 0.7, rate);
        log({ kind: "rattle", layers, gain: g.gain.value, lpHz: lp.frequency.value, rate });
        return;
      }
      if (tier === "soft") {
        const k = draw("thud", ["thud0", "thud1", "thud2"]);
        if (k) play(k, 1, 0.85 + Math.random() * 0.3);
        // metal tap: occasional colour on top of the thud, or the whole
        // sound if the thud set didn't decode
        const m = !k || Math.random() < 0.35 ? draw(metalFam, metalKeys) : null;
        if (m) play(m, 0.45, rate, 0.01 + Math.random() * 0.02);
      } else {
        play(tier === "heavy" ? "crashHeavy" : "crashMed", 1, rate);
        const m = draw(metalFam, metalKeys);
        if (m) play(m, 0.8, 0.92 + Math.random() * 0.16, 0.005 + Math.random() * 0.02);
        // debris tail: fades in across upper-med, always on for heavy
        const debrisP = tier === "heavy" ? 1 : smoothstep(9, CRASH_HEAVY_MIN, intensity) * 0.8;
        if (Math.random() < debrisP)
          play("crashDebris", 0.4 + u * 0.25, 0.9 + Math.random() * 0.2, 0.06 + Math.random() * 0.1);
        if (tier === "heavy") {
          const gk = draw("glass", ["glass0", "glass1", "glass2"]);
          if (gk && Math.random() < 0.85) play(gk, 0.5, 0.95 + Math.random() * 0.1, 0.03 + Math.random() * 0.04);
          // second, later metal hit — big wrecks clatter more than once
          const m2 = draw(metalFam, metalKeys);
          if (m2) play(m2, 0.5, 0.85 + Math.random() * 0.2, 0.05 + Math.random() * 0.06);
        }
      }
      log({ kind: "full", layers, gain: g.gain.value, lpHz: lp.frequency.value, rate });
      return;
    }
    /* Synth fallback (samples not yet decoded): filtered noise burst, with
       the same continuous severity->gain/cutoff mapping so even the
       fallback isn't one fixed sound. */
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * (0.2 + u * 0.3)), c.sampleRate);
    const d = buf.getChannelData(0);
    const decay = 0.04 + u * 0.06;
    for (let i = 0; i < d.length; i++)
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * decay));
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = lpHz;
    const g = c.createGain();
    g.gain.value = (rattle ? 0.4 : 1) * Math.min(0.5, 0.08 + u * 0.45);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + buf.duration + 0.02);
    log({ kind: "synth", layers: [], gain: g.gain.value, lpHz, rate });
  }

  hornSet(on: boolean) {
    if (!this.ok) return;
    const c = this.ctx;
    /* Recorded path: the Alfa horn one-shot with its real attack, looping a
       zero-crossing-snapped window of the sustain while the key is held
       (press-and-hold works even though the recording is finite), then a
       quick release fade on the natural tail. Falls back to the synth
       two-tone below until the sample is decoded. */
    const hornBuf = this.samples.get("hornPlayer");
    if (on && hornBuf && !this.hornSample && !this.hornOsc) {
      const t = c.currentTime;
      const src = c.createBufferSource();
      src.buffer = hornBuf;
      src.loop = true;
      src.loopStart = this.zeroCrossAt(hornBuf, 0.16);
      src.loopEnd = this.zeroCrossAt(hornBuf, 0.42);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.015);
      src.connect(g).connect(this.master);
      src.start(t);
      this.hornSample = { src, g };
      return;
    }
    if (!on && this.hornSample) {
      const t = c.currentTime;
      const { src, g } = this.hornSample;
      this.hornSample = null;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      try { src.stop(t + 0.09); } catch {}
      return;
    }
    if (on && this.hornSample) return;
    if (on && !this.hornOsc) {
      const o1 = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain();
      o1.type = "square";
      o2.type = "square";
      o1.frequency.value = 420;
      o2.frequency.value = 530;
      g.gain.value = 0.06;
      o1.connect(g);
      o2.connect(g);
      g.connect(this.master);
      o1.start();
      o2.start();
      this.hornOsc = { o1, o2, g };
    } else if (!on && this.hornOsc) {
      this.hornOsc.o1.stop();
      this.hornOsc.o2.stop();
      this.hornOsc = null;
    }
  }

  setLevels(vol: number, duck: number) {
    this.vol = vol;
    this.duck = duck;
    if (this.ok) this.master.gain.value = 0.9 * vol * duck;
  }

  /** Silence latched sources (horn, screech, engine) — used when pausing.
      Writes gain.value directly rather than going through setReverb()/the
      other setters, so it bypasses any caller-side "last value sent" cache
      those setters' callers might keep to skip redundant param writes (e.g.
      gating setReverb(t) on a change-threshold). If you keep such a cache
      for anything this touches, invalidate it when unpausing — otherwise a
      resume can come back silent/dry and stay that way until the driving
      value happens to change on its own. */
  quiesce() {
    if (!this.ok) return;
    this.hornSet(false);
    this.tireRoadG.gain.value = 0;
    this.singG.gain.value = 0;
    this.screechG.gain.value = 0;
    this.screechAmDepth.gain.value = 0;
    this.brakeSqG.gain.value = 0;
    this.wG.gain.value = 0;
    this.windFlutterDepth.gain.value = 0;
    this.roadRumbleG.gain.value = 0;
    this.rG.gain.value = 0;
    this.rainGustDepth.gain.value = 0;
    this.inG.gain.value = 0;
    this.exG.gain.value = 0;
    this.turboG.gain.value = 0;
    this.whineG.gain.value = 0;
    this.limDepth.gain.value = 0;
    this.engG.gain.cancelScheduledValues(this.ctx.currentTime);
    this.engG.gain.value = 0;
    this.sampBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.sampBus.gain.value = 0;
    this.sampLimDepth.gain.value = 0;
    if (this.idleG) this.idleG.gain.value = 0;
    if (this.skidG) this.skidG.gain.value = 0;
    if (this.convWet) {
      this.convWet.gain.cancelScheduledValues(this.ctx.currentTime);
      this.convWet.gain.value = 0;
    }
    this.reverbWet.gain.value = 0;
    this.scrapeG.gain.value = 0;
    this.lastScrapeTarget = 0;
    this.scrapeWasActive = false;
    for (const v of this.npcVoices) {
      v.mixG.gain.value = 0;
      v.active = false;
    }
  }

  dispose() {
    if (!this.ok) return;
    this.hornSet(false);
    try {
      this.ctx.close();
    } catch {}
    this.ok = false;
  }

  /**
   * @param cut    true while the ECU is cutting fuel (shift or traction cut)
   * @param gear   optional: 1..top, -1 reverse. Drives the gearbox whine.
   * @param onLimiter optional: physics rev-limiter flag; without it the
   *                  limiter is inferred from rpm against the observed peak.
   * @param rainIntensity optional 0..1; `raining` is boolean-only today, so
   *                  this defaults to 1 whenever raining is true (i.e. rain
   *                  is currently all-or-nothing) — it's accepted now so a
   *                  future weather system can pass a real intensity
   *                  without an API change. Has no effect when raining is
   *                  false.
   * @param slipDemand optional, from CarState.slipDemand — the pre-ESC-
   *                  intervention yaw/sideslip control error, 0 when ESC
   *                  isn't correcting. `slip` (slipAmt) is derived from tire
   *                  slip angles, which ESC's ongoing correction keeps small
   *                  across frames even during a confident swerve it fully
   *                  cancels — slipDemand is large in exactly that moment
   *                  instead. Drives ONLY the sing/screech voice (mix,
   *                  pitch, character), via max(slip, slipDemand*1.7)
   *                  smoothed separately from the envelope everything else
   *                  (skid chirp, ABS tick, road hum damping) still uses —
   *                  omitting it reproduces today's behavior exactly, since
   *                  max(slip, 0) === slip.
   * @param axS/ayS  optional (lane U), CarState.axS/ayS — smoothed body-frame
   *                  longitudinal/lateral acceleration, m/s^2. Drives ONLY
   *                  the interior trim creak one-shots (see the fenced lane-U
   *                  block); omitted -> derivatives stay 0 -> creaks silent.
   * @param slope    optional (lane U), CarState.slope — road grade; its
   *                  derivative is the creak model's ramp-gore/grade-break
   *                  jolt input. Same omitted->silent behavior.
   * @param cabinCam optional (lane U): true for in-cabin cameras (cockpit or
   *                  POV). Exterior cameras duck the creaks to 25%.
   */
  update(
    rpm: number, thr: number, slip: number, speed: number, now: number,
    cut: boolean, raining: boolean, horn: boolean,
    gear?: number, onLimiter?: boolean, rainIntensity?: number, slipDemand?: number,
    axS?: number, ayS?: number, slope?: number, cabinCam?: boolean
  ) {
    if (!this.ok) return;
    const p = this.prof;
    // Track the highest rpm seen so redline-relative shaping still works when
    // setCar() was never called for this car.
    if (rpm > this.peakRpm) this.peakRpm = rpm;
    const redline = Math.max(p.revLimit, this.peakRpm);
    const rn = clamp01((rpm - 800) / (redline - 800));
    const lim = onLimiter ?? rpm > redline * 0.985;

    /* Firing frequency = rpm/60 * cyl/2. The oscillators run at half that,
       because partial 2 of the wave is the firing order. */
    const base = (rpm * p.cyl) / 240;
    for (const o of this.oscs) this.sp(o.frequency, base, 0.018);

    // Idle wobble: the uneven, hunting quality of an engine at rest.
    const idleness = clamp01(1 - (rpm - 850) / 1100) * (1 - thr * 0.8);
    this.sp(this.wobbleDepth.gain, 6 + idleness * 26, 0.08);

    /* Load model. Overrun (closed throttle, still spinning) is quieter and
       darker; on throttle the waveshaper drive comes up for growl. */
    const overrun = thr < 0.06 && rn > 0.25 ? clamp01((rn - 0.25) * 2.5) : 0;
    const load = 0.18 + thr * 0.82;
    const cutMul = cut ? 0.3 : 1;

    /* Sampled vs synth: in sampled mode the recorded rpm-ladder REPLACES the
       tonal oscillator body (driveTrim -> 0 mutes the osc/waveshaper path
       specifically), while the intake/exhaust noise beds stay LAYERED under
       the samples at half gain — spectral call: the ladder loops carry pitch
       and firing texture but, being fixed recordings, lose the throttle-
       open/closed contrast; the beds are exactly that load character and at
       -6dB they tuck under the recording instead of reading as hiss. engG
       still gates the beds, so bodyLevel keeps shaping them. */
    const sampled = this.sampledActive();
    const bedMix = sampled ? 0.5 : 1;
    this.sp(this.drivePre.gain, 0.9 + load * 2.6 + (lim ? 1.4 : 0), 0.04);
    this.sp(this.driveTrim.gain, (sampled ? 0 : 1) / (0.9 + load * 1.2), 0.04);

    const bodyLevel =
      (0.055 + thr * 0.075 + rn * 0.05) *
      (1 - overrun * 0.45) * cutMul * p.level * (lim ? 0.62 : 1);
    this.sp(this.engG.gain, bodyLevel * bedMix, 0.02);
    this.sp(this.limDepth.gain, lim ? -bodyLevel * bedMix * 0.85 : 0, 0.005);

    /* ---- sampled engine ----
       Equal-power crossfade over the rpm ladder: inside band [A_i, A_i+1]
       with x = (rpm-A_i)/(A_i+1 - A_i), loop i gets cos(x*pi/2) and loop
       i+1 gets sin(x*pi/2) (gains sum to 1 in power, so the fade centre
       doesn't dip); every loop's playbackRate = rpm/anchor (clamped) so
       pitch moves continuously within the band and the crossfade only
       morphs timbre. The idle bed fades in below ~2000rpm at closed
       throttle and sits on top of loop_0. Level shaping mirrors the synth
       bodyLevel model (throttle/revs up, overrun/cut/limiter down) and the
       sampLP "airbox" lowpass opens with throttle exactly like engLP, so
       the recording still breathes with load. */
    if (this.engReady) {
      const A = RPM_ANCHORS;
      let g0 = 0, g1 = 0, band = 0;
      if (rpm <= A[0]) { band = 0; g0 = 1; }
      else if (rpm >= A[3]) { band = 2; g1 = 1; }
      else {
        band = rpm < A[1] ? 0 : rpm < A[2] ? 1 : 2;
        const x = clamp01((rpm - A[band]) / (A[band + 1] - A[band]));
        g0 = Math.cos((x * Math.PI) / 2);
        g1 = Math.sin((x * Math.PI) / 2);
      }
      for (let i = 0; i < 4; i++) {
        const g = !sampled ? 0 : i === band ? g0 : i === band + 1 ? g1 : 0;
        this.sp(this.loopGains[i].gain, g, 0.045);
        this.sp(this.loopSrcs[i].playbackRate, clampRange(rpm / A[i], 0.45, 2.2), 0.02);
      }
      const sampLevel = !sampled
        ? 0
        : (0.07 + thr * 0.11 + rn * 0.05) *
          (1 - overrun * 0.35) * cutMul * p.level * (lim ? 0.65 : 1);
      this.sp(this.sampBus.gain, sampLevel, 0.02);
      this.sp(this.sampLimDepth.gain, lim && sampled ? -sampLevel * 0.8 : 0, 0.005);
      this.sp(
        this.sampLP.frequency,
        Math.min(10000, 500 + rpm * 0.5 + thr * 3000 - overrun * 700),
        0.03
      );
      if (this.idleG) {
        const idleMix = (1 - smoothstep(950, 2000, rpm)) * (1 - thr * 0.6);
        this.sp(this.idleG.gain, sampled ? idleMix * 0.55 : 0, 0.06);
      }
    }

    // Airbox / cabin lowpass: opens with throttle and revs, closes on overrun.
    this.sp(
      this.engLP.frequency,
      Math.min(9000, 380 + rpm * 0.42 + thr * 2600 - overrun * 900),
      0.03
    );

    // Intake sits above the tone; exhaust noise fattens the bottom. Both
    // scaled by p.level, same as the tonal engine body (bodyLevel above) —
    // without this, these noise beds sit at an identical ABSOLUTE level on
    // every car regardless of profile, while the tonal engine they're
    // supposed to sit *under* varies with p.level (0.82-1.0 across the
    // roster). A quieter-toned car (shirayuki, p.level=0.82 — the lowest)
    // then has the same noise floor as the loudest-toned car (kaze,
    // p.level=1.0) fighting a quieter signal, so the noise reads as
    // relatively more exposed/prominent — a real per-car imbalance, not a
    // leak, but one that plausibly explains "this car has more hiss than
    // that one" reports: it's a masking-ratio problem, not an on/off bug.
    this.sp(this.inF.frequency, 900 + rn * 2700, 0.04);
    this.sp(this.inG.gain, thr * (0.012 + rn * 0.05) * p.level, 0.04);
    this.sp(this.exF.frequency, 220 + rn * 900, 0.04);
    this.sp(this.exG.gain, (0.008 + load * 0.03) * (0.3 + rn) * p.level, 0.04);

    // Turbo spool follows boost, i.e. throttle held at revs.
    this.sp(this.turboOsc.frequency, 2200 + rn * 4400, 0.08);
    this.sp(this.turboG.gain, p.turbo * thr * rn * rn * 0.01, 0.12);

    // Gearbox whine: constant-mesh gears spin at output-shaft speed, which
    // for a fixed final drive is set by road speed alone — the same at a
    // given speed no matter which gear is selected — so pitch tracks speed,
    // not rpm/gear. Level is quiet under load (loaded gear teeth are damped
    // by torque) and boosted on overrun/lift-off, the classic immersion cue;
    // reverse/1st still carry a bit more base whine (shorter, whinier gearsets).
    const g = gear ?? 2;
    const whineBase = g < 0 ? 0.026 : g === 1 ? 0.013 : 0.009;
    const whineLoad = 1 - thr * 0.65;
    const whineOverrun = 1 + overrun * 2.4;
    const whineSpeedGate = clamp01(speed / 3);
    this.sp(this.whineOsc.frequency, 260 + Math.min(1, speed / 55) * 1900, 0.04);
    this.sp(this.whineG.gain, whineBase * whineLoad * whineOverrun * whineSpeedGate, 0.06);

    /* Transients. A shift is the rising edge of the fuel cut: a gain dip (via
       cutMul above) plus a chuff out of the pipe. Reverse/1st engagement gets
       a softer clunk. */
    if (cut && !this.prevCut) this.burst(0.05 + thr * 0.06, 520 + rn * 700, 0.035, 0.8);
    this.prevCut = cut;
    if (gear !== undefined && gear !== this.prevGear) {
      if (gear < 0 || this.prevGear < 0) this.burst(0.03, 260, 0.03, 1.5);
      this.prevGear = gear;
    }

    // Overrun crackle and limiter bangs — rate-limited one-shots.
    const minGap = lim ? 0.045 : 0.09;
    if (now - this.lastCrackle > minGap) {
      if (lim && Math.random() < 0.7) {
        this.lastCrackle = now;
        this.burst(0.05, 900 + Math.random() * 1400, 0.02, 0.7);
      } else if (overrun > 0.3 && Math.random() < 0.25 * overrun) {
        this.lastCrackle = now;
        this.burst(0.02 + Math.random() * 0.03, 1200 + Math.random() * 2200, 0.012, 1.6);
      }
    }

    /* Overrun burble/backfire: a sudden throttle lift at high rpm queues a
       short volley of 1-4 rate-limited bursts (spread across the next few
       frames, not all in one tick) — soft low thumps for a burble, or a
       sharp high-Q crack for a backfire pop. p.burble sets both how often a
       lift queues a volley at all and how many/how sharp the pops are, so
       kaze/okami crackle readily while shirayuki/tanuki stay mostly quiet. */
    const dThr = thr - this.prevThr;
    if (
      dThr < -0.35 && rn > 0.35 && now - this.lastBurbleTrigger > 0.5 &&
      Math.random() < 0.25 + p.burble * 0.75
    ) {
      this.lastBurbleTrigger = now;
      this.burbleCount = 1 + Math.round(Math.random() * (1 + p.burble * 3));
      this.burbleNext = now;
    }
    this.prevThr = thr;
    if (this.burbleCount > 0 && now >= this.burbleNext) {
      this.burbleCount--;
      this.burbleNext = now + 0.05 + Math.random() * 0.09;
      if (Math.random() < p.burble * 0.55) {
        this.burst(0.045 + p.burble * 0.05, 1300 + Math.random() * 1900, 0.013, 2.4); // sharp pop
      } else {
        this.burst(0.035 + p.burble * 0.03, 200 + Math.random() * 180, 0.05, 0.9); // soft burble
      }
    }

    /* ---- tires ----
       Smooth raw slip into an envelope with a ~140ms time constant. ABS/ESC
       modulate wheel lockup at well above that rate, so a pulsing lockup
       averages down into a moderate sustained value instead of re-triggering
       full screech every pulse; a genuinely sustained slide (mid-corner
       drift, a long ABS stop) still rides the envelope up to its true level. */
    const dt = this.lastTireT ? Math.min(0.1, Math.max(0, now - this.lastTireT)) : 0.016;
    this.lastTireT = now;
    const envK = 1 - Math.exp(-dt / 0.14);
    this.slipEnv += (clamp01(slip) - this.slipEnv) * envK;
    // See update()'s slipDemand doc comment: same smoothing, but the
    // sing/screech voice alone reads this instead of slipEnv below.
    this.demandEnv += (clamp01(Math.max(slip, (slipDemand ?? 0) * 1.7)) - this.demandEnv) * envK;

    // Wheelspin off the line happens at near-zero car speed, so the sustained
    // layers only fade partway with speed rather than muting entirely.
    const speedGate = 0.3 + 0.7 * Math.min(1, speed / 6);
    const wetLevel = raining ? 0.55 : 1;
    const wetQ = raining ? 0.6 : 1; // lower Q = broader/hissier, not just quieter

    // Layer 1: rolling hum, speed only, gently damped while sliding hard.
    this.sp(this.tireRoadF.frequency, 150 + Math.min(1, speed / 50) * 220, 0.06);
    this.sp(
      this.tireRoadG.gain,
      Math.min(1, speed / 45) * 0.045 * (1 - this.slipEnv * 0.3) + (raining ? 0.015 : 0),
      0.06
    );

    // Layer 2: grip singing crossfades in first, and partially back out as
    // the screech takes over so the two never just sum linearly. Driven by
    // demandEnv (see update()'s slipDemand doc), not slipEnv — identical to
    // before whenever slipDemand is 0/omitted.
    const singMix =
      smoothstep(0.12, 0.45, this.demandEnv) * (1 - smoothstep(0.55, 0.92, this.demandEnv) * 0.7);
    this.sp(this.singF.frequency, 1200 + this.demandEnv * 1500, 0.05);
    this.sp(this.singF.Q, (9 + this.demandEnv * 4) * wetQ, 0.08);
    this.sp(this.singLfoDepth.gain, 15 + this.demandEnv * 40, 0.1);
    this.sp(this.singG.gain, singMix * 0.09 * speedGate * wetLevel, 0.05);

    // Layer 3: full screech, broadband and amplitude-modulated, only once
    // slip is sustained and severe. Also demandEnv-driven, same reasoning.
    // In sampled mode the recorded qubodup skid loop carries this role and
    // the synth screech drops to a 25% under-layer (its AM chaos keeps the
    // 1s recording from reading as a static loop); the sing layer above
    // stays as-is in both modes — it is the tonal pitch-rise the recording
    // doesn't have. Gains are slip-gated from silence, so nothing sounds at
    // rest, and the same speed/wet scaling applies.
    const skidSampled = sampled && this.skidG !== null;
    const screechMix = smoothstep(0.4, 0.85, this.demandEnv);
    const screechBase = screechMix * (skidSampled ? 0.04 : 0.15) * speedGate * wetLevel;
    if (this.skidG && this.skidSrc) {
      const skidMix = skidSampled ? smoothstep(0.35, 0.8, this.demandEnv) : 0;
      this.sp(this.skidG.gain, skidMix * 0.3 * speedGate * wetLevel, 0.05);
      // slight pitch rise with slip + a wet-road brightening nudge, so the
      // loop tracks the slide instead of droning at one pitch
      this.sp(
        this.skidSrc.playbackRate,
        0.85 + this.demandEnv * 0.3 + (raining ? 0.06 : 0),
        0.06
      );
    }
    this.sp(this.screechF.frequency, 900 + this.demandEnv * 500, 0.06);
    this.sp(this.screechF.Q, 2.2 * (raining ? 0.5 : 1), 0.08);
    this.sp(this.screechG.gain, screechBase, 0.04);
    this.sp(this.screechAmDepth.gain, screechBase * 0.5, 0.06);

    // Skid chirp: a short bark on a sudden slip spike out of low sustained
    // slip — launch wheelspin, a harsh downshift, clipping the grip limit —
    // rather than the sustained slide itself.
    const dSlip = slip - this.prevSlipRaw;
    if (dSlip > 0.32 && this.slipEnv < 0.35 && now - this.lastChirp > 0.15) {
      this.lastChirp = now;
      const freq = raining ? 2600 + Math.random() * 800 : 1700 + Math.random() * 900;
      const lvl = (raining ? 0.05 : 0.09) * speedGate;
      this.burst(lvl, freq, 0.045, raining ? 2.2 : 1.4);
    }
    this.prevSlipRaw = slip;

    /* ABS tick: a soft mechanical tick while the raw slip signal is pulsing
       against its own smoothed envelope — the same divergence the skid-chirp
       bark above watches, but gated to moderate *sustained* slip (a held
       brake, not a single spike) and rate-limited to a plausible modulation
       rate rather than a screech. This infers ABS activity from slip alone;
       an explicit absActive flag from the physics side would be a cleaner,
       less guessy hook than this if one becomes available. */
    const absDivergence = Math.abs(slip - this.slipEnv);
    if (
      this.slipEnv > 0.18 && this.slipEnv < 0.75 &&
      absDivergence > 0.22 &&
      now - this.lastAbsTick > 0.055
    ) {
      this.lastAbsTick = now;
      this.burst(0.018 + speedGate * 0.014, 340 + Math.random() * 120, 0.011, 3.5);
    }

    /* Low-speed brake squeal: the classic rising "eeeee" in the last ~40
       km/h of a hard stop. Gated on genuine hard/panic braking, not routine
       firm braking — verified against a headless physics.ts audit that
       ordinary firm braking (br=0.6, a normal stop) never engages ABS at
       all (raw slip stays exactly 0 throughout), while only a real
       max-effort stop does, so slip > a small floor here is already a
       reliable "this is a hard stop" signal on its own, no separate brake-
       pedal input needed. Also requires an actual decelerating trend (not
       just low speed) so idling/crawling doesn't trigger it. Pitch rises
       and level swells as speed approaches zero, then cuts out at
       standstill or the moment the car stops actually slowing (releases
       the pedal, speeds back up, or the slip signal drops out). */
    const decel = (this.prevBrakeSpeed - speed) / Math.max(dt, 1 / 240);
    this.prevBrakeSpeed = speed;
    const brakeSqActive = speed > 0.3 && speed < 11 && decel > 2.5 && slip > 0.08;
    const stopCloseness = clampRange(1 - speed / 11, 0, 1);
    const brakeSqTarget = brakeSqActive ? (0.02 + stopCloseness * 0.045) * speedGate : 0;
    this.sp(this.brakeSqF.frequency, 1400 + stopCloseness * 1400, 0.08);
    this.sp(this.brakeSqG.gain, brakeSqTarget, brakeSqActive ? 0.08 : 0.15);

    // Road texture bed: low rumble tied to speed, distinct from wind/tyre-hum.
    // Ducked while the tyre screech layer is active so the two low-mid
    // layers don't stack into mud.
    const roadRise = Math.min(1, speed / 40);
    this.sp(this.roadRumbleF.frequency, 55 + roadRise * 70, 0.1);
    this.sp(this.roadRumbleG.gain, roadRise * 0.05 * (1 - screechMix * 0.45), 0.1);

    /* ---- environment ----
       Wind roar opens (cutoff + level) with speed and is deliberately mixed
       under the engine at low speed but past it by ~140 km/h (~39 m/s),
       matching a real cockpit where wind becomes the dominant sound well
       before the engine is at high load. The flutter depth scales with the
       wind level itself so a stationary car has a dead-still cabin. Cutoff
       is capped at 1400Hz — uncapped it kept climbing with speed (2380Hz+
       by 288km/h) into hissy-bright territory; real in-cabin wind noise at
       any speed is a low rumble/mid whoosh, not a bright hiss, so the
       lowpass ceiling keeps that true regardless of how fast the car goes. */
    const windRise = smoothstep(15, 60, speed);
    // 0.32 -> 0.27 (user call): at top speed the wind was drowning the whole
    // mix; the low-speed onset is untouched, only the ceiling comes down.
    const windLevel = windRise * 0.27 + (raining ? 0.02 : 0);
    this.sp(this.wF.frequency, Math.min(1400, 300 + speed * 26), 0.15);
    this.sp(this.wG.gain, windLevel, 0.12);
    this.sp(this.windFlutterDepth.gain, windRise * 0.04, 0.15);

    /* Rain: reworked for character, not just level, after smoothing the old
       flat highpass hiss alone wasn't enough — it still fundamentally read
       as white noise (the smoothed-gain fix only addressed the earlier
       "constant" complaint, not the "sounds horrible" one). Three parts:
         - Body: hard-lowpassed (rF ceiling 950Hz, see init()) muffled cabin
           rumble rather than bright hiss, ducked harder at low speed than
           before (0.012 floor vs the old 0.032) so a parked, idling car in
           the rain reads as quiet rather than a wall of noise.
         - Gust: a slow (0.15/0.37Hz) LFO pair summed into rG.gain, same
           additive trick as windFlutterDepth, so the body breathes instead
           of sitting dead-static.
         - Droplets: sparse, randomly-timed filtered ticks via the existing
           burst() one-shot machinery — bright, short, discrete transients.
           This is the part that actually reads as "rain" rather than
           generic hiss; a listener's ear differentiates a patter of
           discrete clicks from continuous broadband noise far more readily
           than it responds to lowpass filtering alone.
       `rI` (0..1) is a placeholder for a future rainIntensity signal — see
       the update() doc comment; today it's just raining ? 1 : 0. */
    const rI = raining ? clamp01(rainIntensity ?? 1) : 0;
    const rainBody = rI * (0.012 + Math.min(1, speed / 20) * 0.033);
    this.sp(this.rF.frequency, 700 + Math.min(1, speed / 30) * 250, 0.2);
    this.sp(this.rG.gain, rainBody, 0.25);
    this.sp(this.rainGustDepth.gain, rainBody * 0.5, 0.25);
    if (rI > 0) {
      if (now >= this.nextDroplet) {
        this.nextDroplet = now + (0.05 + Math.random() * 0.25) / Math.max(0.3, rI);
        this.burst(0.014 + Math.random() * 0.02, 1500 + Math.random() * 2600, 0.008, 2.5 + Math.random() * 2);
      }
    } else {
      this.nextDroplet = now; // fire promptly next time it starts raining, not after a stale delay
    }

    // interior trim creaks (lane U): per-frame drive call into the fenced
    // block near tick() — one-shot triggers only, no sustained voice.
    this.trimCreaks(now, dt, speed, axS ?? 0, ayS ?? 0, slope ?? 0, cabinCam ?? false);

    this.hornSet(horn);
  }

  /** Reverb bus wet amount, 0..1. t=0 leaves the wet gain at literal 0, so
      the master output is bit-identical to the dry-only path from before
      this feature. t also darkens the (now non-looping, output-only)
      lowpass and lengthens the tail (raises feedback) as it rises; feedback
      is capped at 0.4 — with reverbTap's 1/N normalization (see init()),
      round-trip loop gain is bounded by this value alone, so 0.4 leaves
      ample margin under the instability threshold of 1.0.

      t at/near 0 is a hard kill rather than an asymptotic setTargetAtTime
      approach to 0: it cancels any in-flight ramp and snaps both wet gain
      and feedback gain to their floor immediately, so returning to t=0
      always fully stops new energy from re-entering the loop rather than
      just trending toward it — belt-and-suspenders alongside the gain-
      staging fix, not a substitute for it. */
  setReverb(t: number) {
    if (!this.ok) return;
    const tt = clamp01(t);
    this.lastReverbT = tt;
    /* Recorded-IR path: once the underpass impulse response is wired, it IS
       the tunnel reverb — the FDN stays parked at zero (wireConvolver()
       killed it) and only the convolver wet level moves. Kept deliberately
       subtle: 0.3 max wet, engine+tire sends only. Same hard-kill-at-zero
       contract as the FDN path so pausing/exiting can't leave a tail
       feeding itself. */
    if (this.convWet) {
      if (tt < 1e-4) {
        this.convWet.gain.cancelScheduledValues(this.ctx.currentTime);
        this.convWet.gain.value = 0;
        return;
      }
      this.sp(this.convWet.gain, tt * 0.3, 0.15);
      return;
    }
    if (tt < 1e-4) {
      const now = this.ctx.currentTime;
      this.reverbWet.gain.cancelScheduledValues(now);
      this.reverbWet.gain.value = 0;
      this.reverbFeedback.gain.cancelScheduledValues(now);
      this.reverbFeedback.gain.value = 0;
      this.sp(this.reverbLP.frequency, 6000, 0.15);
      return;
    }
    this.sp(this.reverbWet.gain, tt * 0.35, 0.15);
    this.sp(this.reverbLP.frequency, 6000 - tt * 4300, 0.15);
    this.sp(this.reverbFeedback.gain, 0.15 + tt * 0.25, 0.15);
  }

  /** Interior/exterior EQ switch. Cockpit (b=true) is slightly lowpassed
      with a cabin resonance bump; exterior (b=false, the default) is the
      open, brighter response used before this feature existed. Two
      pre-built biquads in the master chain — cheap to toggle. */
  setInterior(b: boolean) {
    if (!this.ok) return;
    this.sp(this.cabinLP.frequency, b ? 5200 : 20000, 0.25);
    this.sp(this.cabinPeak.gain, b ? 4.5 : 0, 0.25);
  }

  /** Low-frequency pressure whump for tunnel entry/exit — a sub-100Hz-
      emphasised one-shot built from the existing burst() machinery, layered
      (a sharper short thump over a longer soft one) for a felt "pressure"
      character rather than a simple bass note. `intensity` (default 1)
      scales level only, e.g. by speed at the threshold — entry vs exit use
      the same character, just call it twice. */
  tunnelThump(intensity = 1) {
    if (!this.ok) return;
    const k = clampRange(intensity, 0, 2);
    this.burst(0.16 * k, 62, 0.09, 0.85);
    this.burst(0.07 * k, 38, 0.17, 0.55);
  }

  /** Rotate a world-space offset into the player's camera-relative right
      axis. Heading follows the game's convention (radians, forward =
      (sin h, cos h), h=0 facing +z) — the same field as CarState.h — so
      this tracks the chase/cockpit camera through turns instead of using
      raw world x, which would pan backwards mid-corner. */
  private lateralOf(dx: number, dz: number, heading: number) {
    return dx * Math.cos(heading) - dz * Math.sin(heading);
  }

  /** Cheap positional helper shared by the NPC one-shots: pans/attenuates
      relative to the player position/heading last reported to
      updateNpcs(). */
  private npcSpatial(x: number, z: number, baseLevel: number) {
    const dx = x - this.lastPx, dz = z - this.lastPz;
    const dist = Math.max(0.5, Math.hypot(dx, dz));
    const pan = clampRange(this.lateralOf(dx, dz, this.lastPh) / 12, -1, 1);
    const gain = baseLevel * clampRange(1 - dist / 50, 0, 1);
    return { pan, gain };
  }

  /**
   * Per-frame update for the NPC doppler pool. `list` should already be
   * trimmed by the caller to the ~6-8 nearest active traffic cars — this
   * only assigns pool voices to them and moves params, it does no distance
   * culling of its own beyond the pool size.
   *
   * Voices are matched to npcs by nearest-to-last-known-position (cheap
   * tracking) so a car keeps its voice frame to frame instead of the pool
   * reindexing on ranking churn; unmatched npcs fill free voices, and if
   * none are free the currently-farthest claimed voice is stolen when the
   * new npc is closer to the player.
   *
   * Doppler pitch is manual: factor = 343/(343 - approachSpeed), clamped to
   * 0.7..1.5, where approachSpeed is the closing-speed component of the
   * npc's velocity relative to the player along the line between them
   * (positive = approaching).
   *
   * `ph` is the player's heading in radians (CarState.h's convention:
   * forward = (sin h, cos h), h=0 facing +z) — pan is computed relative to
   * it so left/right tracks the heading-following chase/cockpit camera
   * through turns rather than raw world x.
   *
   * Allocation-free: `list` is only ever read, and all bookkeeping runs
   * through preallocated scratch arrays (npcClaims/npcTaken/npcDist/
   * npcUnclaimed) sized to NPC_SCAN_MAX, not `new Array`/`.map`/`.sort` per
   * call — this runs every frame, so it stays off the GC. Entries with a
   * non-finite x/z (e.g. a stale/dead slot from a reused caller-side
   * buffer) are treated as invalid and never claimed; callers should still
   * only pass live npcs, this is a defensive backstop, not a replacement
   * for that.
   */
  updateNpcs(
    list: { x: number; z: number; vx: number; vz: number; heavy?: boolean }[],
    px: number, pz: number, pvx: number, pvz: number, ph: number
  ) {
    if (!this.ok) return;
    if (!GameAudio.NPC_VOICES_ENABLED) {
      // Listener pose must still track the player or npcHorn/npcChirp
      // (kept enabled) spatialize against a stale origin and fall silent.
      this.lastPx = px;
      this.lastPz = pz;
      this.lastPh = ph;
      for (const v of this.npcVoices) {
        if (v.active) { v.active = false; this.sp(v.mixG.gain, 0, 0.12); }
      }
      return;
    }
    this.lastPx = px;
    this.lastPz = pz;
    this.lastPh = ph;
    const voices = this.npcVoices;
    const n = voices.length;
    const m = Math.min(list.length, GameAudio.NPC_SCAN_MAX);
    const claims = this.npcClaims;
    const taken = this.npcTaken;
    const dist = this.npcDist;
    const continuing = this.npcContinuing;
    for (let i = 0; i < n; i++) { claims[i] = null; continuing[i] = false; }
    for (let i = 0; i < m; i++) taken[i] = false;

    // Precompute squared distance-to-player once per npc; Infinity marks an
    // invalid (non-finite coordinate) entry so it's never matched below.
    for (let ni = 0; ni < m; ni++) {
      const npc = list[ni];
      if (!Number.isFinite(npc.x) || !Number.isFinite(npc.z)) { dist[ni] = Infinity; continue; }
      const dx = npc.x - px, dz = npc.z - pz;
      dist[ni] = dx * dx + dz * dz;
    }

    // Track: keep each active voice on the npc nearest its last position.
    for (let vi = 0; vi < n; vi++) {
      const v = voices[vi];
      if (!v.active) continue;
      let best = -1, bestD = Infinity;
      for (let ni = 0; ni < m; ni++) {
        if (taken[ni] || dist[ni] === Infinity) continue;
        const npc = list[ni];
        const dx = npc.x - v.lastX, dz = npc.z - v.lastZ;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = ni; }
      }
      if (best >= 0 && bestD < 400) { // within 20m of last position -> same car
        claims[vi] = best;
        taken[best] = true;
        continuing[vi] = true;
      }
    }

    // Fill free voices with the nearest unclaimed npcs (insertion sort into
    // the scratch buffer — m is small, at most NPC_SCAN_MAX); steal from
    // the farthest-claimed voice if the pool is full and this npc is closer.
    const unclaimed = this.npcUnclaimed;
    let uCount = 0;
    for (let ni = 0; ni < m; ni++) {
      if (taken[ni] || dist[ni] === Infinity) continue;
      let j = uCount - 1;
      while (j >= 0 && dist[unclaimed[j]] > dist[ni]) { unclaimed[j + 1] = unclaimed[j]; j--; }
      unclaimed[j + 1] = ni;
      uCount++;
    }
    for (let k = 0; k < uCount; k++) {
      const ni = unclaimed[k];
      let vi = -1;
      for (let i = 0; i < n; i++) if (claims[i] === null && !voices[i].active) { vi = i; break; }
      if (vi < 0) {
        let worstVi = -1, worstD = -1;
        for (let i = 0; i < n; i++) {
          if (claims[i] === null) continue;
          const d = dist[claims[i]!];
          if (d > worstD) { worstD = d; worstVi = i; }
        }
        if (worstVi >= 0 && dist[ni] < worstD) {
          taken[claims[worstVi]!] = false;
          // This voice matched its OLD npc in the tracking pass above
          // (that's the only way it could already be claims[worstVi] !==
          // null with v.active — see the loop above), so continuing[] is
          // stale true here; clear it or the apply loop below will think
          // this is a same-car continuation instead of the steal it is,
          // and skip the mixG dip meant to smooth the handoff.
          continuing[worstVi] = false;
          vi = worstVi;
        }
      }
      if (vi >= 0) { claims[vi] = ni; taken[ni] = true; }
    }

    for (let vi = 0; vi < n; vi++) {
      const v = voices[vi];
      const ni = claims[vi];
      if (ni === null) {
        if (v.active) {
          v.active = false;
          this.sp(v.mixG.gain, 0, 0.12);
        }
        continue;
      }
      const npc = list[ni];
      // A steal — an already-active voice reassigned to a DIFFERENT car
      // than the one it was tracking, as opposed to continuing the same
      // car (continuing[vi]) or waking up from silence (v.active was
      // false) — gets a brief mixG dip instead of gliding oscG/
      // frequency straight to the new car's values while staying pinned at
      // full volume throughout; the dip makes the handoff read as a quick
      // fade rather than a pitch/timbre glitch.
      const stolen = v.active && !continuing[vi];
      v.active = true;
      v.lastX = npc.x;
      v.lastZ = npc.z;

      const dx = npc.x - px, dz = npc.z - pz;
      const dist = Math.max(1, Math.hypot(dx, dz));
      const ux = dx / dist, uz = dz / dist;
      const relVx = npc.vx - pvx, relVz = npc.vz - pvz;
      const approachSpeed = -(relVx * ux + relVz * uz);
      const dopplerFactor = clampRange(343 / (343 - approachSpeed), 0.7, 1.5);
      const baseFreq = npc.heavy ? 62 : 132;

      const level = clampRange(1 - dist / 70, 0, 1);
      const g = Math.pow(level, 1.5) * (npc.heavy ? 0.09 : 0.06);
      const pan = clampRange(this.lateralOf(dx, dz, ph) / 10, -1, 1);

      // The osc carries the whole voice now that the noise branch is gone
      // (its darken-with-distance tune never stopped it reading as hiss up
      // close); 0.55 -> 0.75 gives back some of the removed body without
      // reaching the old two-branch combined level.
      this.sp(v.osc.frequency, baseFreq * dopplerFactor, 0.05);
      this.sp(v.oscG.gain, g * 0.75, 0.08);
      this.sp(v.mixG.gain, stolen ? 0.15 : 1, stolen ? 0.05 : 0.08);
      this.sp(v.panner.pan, pan, 0.08);
    }
  }

  /** One-shot horn honk positioned like a doppler-pool voice, for the
      traffic agent's close-call events. Two detuned square tones (~400 +
      500Hz) as before, but with a real attack/hold/release envelope and a
      peaking "body" filter around the honk formant a bare two-tone square
      chord doesn't have — the old version snapped on at full gain and
      immediately exponential-decayed, which read as a synthetic beep
      rather than a horn. */
  npcHorn(x: number, z: number, heavy = false) {
    if (!this.ok) return;
    const { pan, gain } = this.npcSpatial(x, z, heavy ? 0.13 : 0.1);
    if (gain <= 0) return;
    const c = this.ctx, t = c.currentTime;
    /* Recorded path: real horns, round-robined across three car variants
       (Alfa double-honk, polite double-beep, Alfa short) with a slight
       random repitch; trucks/buses get the recorded truck horn. Positioned
       with the same pan/attenuation as the synth version. */
    const key = heavy
      ? "hornTruck"
      : ["hornA", "hornB", "hornC"][this.npcHornRR++ % 3];
    const hb = this.samples.get(key);
    if (hb) {
      const pn = c.createStereoPanner();
      pn.pan.value = pan;
      pn.connect(this.master);
      this.playSample(hb, gain * (heavy ? 1.1 : 1), pn, 0.96 + Math.random() * 0.08);
      return;
    }
    const o1 = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain(), pn = c.createStereoPanner();
    o1.type = "square";
    o2.type = "square";
    o1.frequency.value = 400;
    o2.frequency.value = 500;
    // Body: real horn diaphragms resonate well above the fundamental —
    // this is the buzzy "honk" formant a plain two-tone chord lacks on its
    // own.
    const body = c.createBiquadFilter();
    body.type = "peaking";
    body.frequency.value = 950;
    body.Q.value = 1.8;
    body.gain.value = 7;
    pn.pan.value = pan;
    // Attack/hold/release: punches in over ~20ms, holds near full level,
    // then releases — a honk, not a click that immediately decays.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.setValueAtTime(gain, t + 0.28);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o1.connect(g);
    o2.connect(g);
    g.connect(body).connect(pn).connect(this.master);
    o1.start(t);
    o2.start(t);
    o1.stop(t + 0.52);
    o2.stop(t + 0.52);
  }

  /** One-shot brake/tire squeak positioned like a doppler-pool voice, for
      the traffic agent's timid-driver close-call events — noise-based (like
      the tire skid-chirp bark), not a tonal blip, so it reads as a scrub
      rather than a beep. Slightly lower and broader than the skid chirp's
      own range for a squeal rather than a bark. */
  npcChirp(x: number, z: number) {
    if (!this.ok) return;
    const { pan, gain } = this.npcSpatial(x, z, 0.1);
    if (gain <= 0) return;
    const c = this.ctx, t = c.currentTime;
    const decay = 0.065;
    const nSamp = Math.max(64, Math.floor(c.sampleRate * decay * 3));
    const buf = c.createBuffer(1, nSamp, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < nSamp; i++)
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * decay));
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1200 + Math.random() * 1200;
    f.Q.value = 1.1;
    const g = c.createGain();
    g.gain.value = gain;
    const pn = c.createStereoPanner();
    pn.pan.value = pan;
    src.connect(f).connect(g).connect(pn).connect(this.master);
    src.start(t);
    src.stop(t + decay * 3 + 0.02);
  }

  /**
   * Sustained metallic scrape/grind — call every frame while the player is
   * in contact with a wall/guardrail/NPC flank; `intensity` 0 means no
   * contact and fully silences the voice.
   *
   * @param intensity 0..1, how hard the car is pressing into the surface.
   * @param speed     m/s, the TANGENTIAL (along-surface) component of
   *                  velocity at the contact — this, not intensity, is what
   *                  the voice is gated on. A car pressed hard into a wall
   *                  with near-zero tangential speed (stuck, not sliding)
   *                  reads as intensity>0 but speed~0, and must come out
   *                  nearly silent — real metal-on-concrete only sings when
   *                  something is actually moving across it.
   *
   * Level is capped well under the engine's full-song level, has an
   * asymmetric ~80ms attack / ~150ms release (so a brief tap reads as a
   * short scuff, not a blast that also lingers), and a slow fatigue duck if
   * contact stays continuously active beyond ~3.5s (a long grind should
   * recede, not sit at full volume indefinitely). Brightness rises with
   * speed; occasional squeal transients (via the existing burst()
   * machinery) fire only at high intensity AND real speed, never on a bare
   * stuck-against-the-wall touch.
   */
  setScrape(intensity: number, speed: number) {
    if (!this.ok) return;
    const now = this.ctx.currentTime;
    const it = clamp01(intensity);
    const spd = Math.max(0, speed);

    // The critical "not obnoxious" gate: near-zero below ~0.3 m/s, full by
    // ~6 m/s, regardless of how hard intensity is pressing — this is what
    // keeps a car stuck against a wall (contact, ~no tangential motion)
    // nearly silent rather than a sustained drone.
    const speedGate = smoothstep(0.3, 6, spd);
    let target = it * speedGate * 0.07; // ceiling well under engine's ~0.16-0.18 at full song

    // Fatigue: contact continuously active beyond ~3.5s slowly ducks toward
    // a lower bed over the next ~3.5s, flooring at 55% of what it would
    // otherwise be. Resets the moment contact actually breaks (target back
    // near 0), not merely dips.
    const active = target > 0.004;
    if (active) {
      if (!this.scrapeWasActive) this.scrapeActiveSince = now;
      const dur = now - this.scrapeActiveSince;
      target *= 1 - smoothstep(3.5, 7, dur) * 0.45;
    }
    this.scrapeWasActive = active;

    // Asymmetric attack/release: setTargetAtTime reaches ~95% by ~3*tau, so
    // tau=~0.027 gives an ~80ms attack and tau=~0.05 an ~150ms release.
    const rising = target > this.lastScrapeTarget;
    this.lastScrapeTarget = target;
    this.sp(this.scrapeG.gain, target, rising ? 0.027 : 0.05);

    // Brightness rises with tangential speed — a slow scuff is duller than
    // a fast grind.
    const brightness = 1 + Math.min(1, spd / 25) * 0.4;
    for (const b of this.scrapeFilters) this.sp(b.f.frequency, b.baseFreq * brightness, 0.1);

    // Squeal transients: only when it's both hard AND actually sliding —
    // never on a bare stuck touch, same gating principle as the sustained
    // bed above.
    if (it > 0.6 && speedGate > 0.5 && now - this.lastSqueal > 0.4 + Math.random() * 0.6) {
      this.lastSqueal = now;
      this.burst(0.02 + it * 0.025, 3200 + Math.random() * 2600, 0.02, 4 + Math.random() * 3);
    }
  }
}
